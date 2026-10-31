// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 壁纸只读 feed：播放时钟 + 最新 64 段频谱。
//!
//! 只认当前 profile 的 `vmusicd.json`、`wallpaper-key` 与壁纸只读桥；
//! 不接触主 token、歌词钥匙或播放控制。首选 `GET /v1/wallpaper/events`
//! 事件流，旧服务没有该入口时回退到 500 ms 快照轮询。快照不含曲名、路径、
//! 账号和封面。断连由调用方清空；暂停不插值；频谱按 500 ms 开始衰减、1 s 归零。

use std::io;
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tungstenite::client::IntoClientRequest;
use tungstenite::http::header::AUTHORIZATION;

use crate::bridge;
use crate::config::Profile;

pub(crate) const PROTOCOL: u32 = 1;
pub(crate) const BANDS: usize = 64;

pub(crate) const ERR_DISCOVERY_MISSING: &str = "discovery_missing";
pub(crate) const ERR_DISCOVERY_INVALID: &str = "discovery_invalid";
pub(crate) const ERR_EDITION_MISMATCH: &str = "edition_mismatch";
pub(crate) const ERR_PROTOCOL_MISSING: &str = "wallpaper_protocol_missing";
pub(crate) const ERR_PROTOCOL_MISMATCH: &str = "wallpaper_protocol_mismatch";
pub(crate) const ERR_KEY_MISSING: &str = "wallpaper_key_missing";
pub(crate) const ERR_KEY_INVALID: &str = "wallpaper_key_invalid";
pub(crate) const ERR_HTTP: &str = "wallpaper_http_error";
pub(crate) const ERR_EVENTS: &str = "wallpaper_events_error";
pub(crate) const ERR_EVENTS_UNAVAILABLE: &str = "wallpaper_events_unavailable";
pub(crate) const ERR_SESSION_CHANGED: &str = "wallpaper_session_changed";
pub(crate) const ERR_STALE: &str = "wallpaper_stale_snapshot";
pub(crate) const ERR_INVALID: &str = "wallpaper_invalid_snapshot";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
/// 服务端最多 1 s 心跳一次；读超时说明连接已死，交给重连退避。
const READ_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug)]
pub(crate) struct FeedError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl FeedError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for FeedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    #[serde(skip)]
    pub(crate) received_at: Option<std::time::Instant>,
    pub(crate) protocol: u32,
    pub(crate) seq: u64,
    pub(crate) server: ServerInfo,
    pub(crate) valid: bool,
    pub(crate) playing: bool,
    pub(crate) position_ms: u64,
    pub(crate) duration_ms: Option<u64>,
    pub(crate) generation: String,
    pub(crate) spectrum: Spectrum,
    #[serde(default)]
    pub(crate) space: Option<SpacePresentation>,
    pub(crate) timing: String,
}

/// 三维空间当前场景的窄投影；旧服务没有这个字段时保持 None，壁纸按固定场景工作。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpacePresentation {
    pub(crate) scene: String,
    #[serde(default)]
    pub(crate) params: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerInfo {
    pub(crate) session: String,
    pub(crate) edition: String,
    pub(crate) version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Spectrum {
    pub(crate) bands: Vec<f32>,
    pub(crate) energy: f32,
    pub(crate) age_ms: Option<u64>,
}

impl Snapshot {
    /// 500 ms 内原样；500–1000 ms 线性衰减；之后归零。没有频谱帧也归零。
    pub(crate) fn effective_bands(&self, elapsed_ms: u64) -> Vec<f32> {
        let Some(age) = self.spectrum.age_ms else {
            return vec![0.0; BANDS];
        };
        let age = age.saturating_add(elapsed_ms);
        if age <= 500 {
            return self.spectrum.bands.clone();
        }
        if age >= 1000 {
            return vec![0.0; BANDS];
        }
        let gain = (1000 - age) as f32 / 500.0;
        self.spectrum.bands.iter().map(|band| band * gain).collect()
    }

    /// 只有有效且正在播放时才允许位置插值；暂停或断连返回 None。
    pub(crate) fn interpolated_position_ms(&self, elapsed_ms: u64) -> Option<u64> {
        if !self.valid || !self.playing {
            return None;
        }
        let position = self.position_ms.saturating_add(elapsed_ms);
        Some(
            self.duration_ms
                .map_or(position, |duration| position.min(duration)),
        )
    }
}

pub(crate) struct Feed {
    client: reqwest::blocking::Client,
    profile: Profile,
    session: Option<String>,
    last_seq: Option<u64>,
}

impl Feed {
    pub(crate) fn new(profile: Profile) -> anyhow::Result<Self> {
        if crate::config::is_dbx(&profile) {
            anyhow::bail!("DBX 来源必须使用私有管道读取");
        }
        Ok(Self {
            client: bridge::client()?,
            profile,
            session: None,
            last_seq: None,
        })
    }

    fn prepare(&self) -> Result<(bridge::Discovery, String), FeedError> {
        let discovery_path = std::path::Path::new(self.profile.data_dir()).join("vmusicd.json");
        if !discovery_path.is_file() {
            return Err(FeedError::new(
                ERR_DISCOVERY_MISSING,
                format!(
                    "未找到 {}：请先启动 Hertz {} 服务",
                    discovery_path.display(),
                    self.profile.edition()
                ),
            ));
        }
        let discovery = bridge::read_discovery(&self.profile)
            .map_err(|error| FeedError::new(ERR_DISCOVERY_INVALID, error.to_string()))?;
        if let Some(edition) = discovery.edition.as_deref() {
            if self.profile.edition() != "custom" && edition != self.profile.edition() {
                return Err(FeedError::new(
                    ERR_EDITION_MISMATCH,
                    format!(
                        "数据目录属于 {edition} 发行版，当前 profile 是 {}",
                        self.profile.edition()
                    ),
                ));
            }
        }
        match discovery.wallpaper_protocol {
            None => {
                return Err(FeedError::new(
                    ERR_PROTOCOL_MISSING,
                    "Hertz 服务未生成壁纸只读协议；请升级并重启服务",
                ))
            }
            Some(protocol) if protocol != PROTOCOL => {
                return Err(FeedError::new(
                    ERR_PROTOCOL_MISMATCH,
                    format!("壁纸协议 {protocol} 与组件协议 {PROTOCOL} 不一致"),
                ))
            }
            Some(_) => {}
        }
        let key_path = std::path::Path::new(self.profile.data_dir()).join("wallpaper-key");
        if !key_path.is_file() {
            return Err(FeedError::new(
                ERR_KEY_MISSING,
                format!(
                    "未找到 {}：请重启 Hertz 服务以生成壁纸钥匙",
                    key_path.display()
                ),
            ));
        }
        let key = bridge::read_key(
            std::path::Path::new(self.profile.data_dir()),
            "wallpaper-key",
            "壁纸",
        )
        .map_err(|error| FeedError::new(ERR_KEY_INVALID, error.to_string()))?;
        Ok((discovery, key))
    }

    fn accept_snapshot(
        &mut self,
        snapshot: &Snapshot,
        discovery_session: Option<&str>,
    ) -> Result<(), FeedError> {
        if discovery_session.is_some_and(|session| session != snapshot.server.session.as_str()) {
            self.session = None;
            self.last_seq = None;
            return Err(FeedError::new(
                ERR_SESSION_CHANGED,
                "服务会话已变化，等待新快照",
            ));
        }
        if self.session.as_deref() == Some(snapshot.server.session.as_str())
            && self.last_seq.is_some_and(|seq| snapshot.seq <= seq)
        {
            return Err(FeedError::new(
                ERR_STALE,
                "快照序号未推进，忽略迟到/重复响应",
            ));
        }
        self.session = Some(snapshot.server.session.clone());
        self.last_seq = Some(snapshot.seq);
        Ok(())
    }

    pub(crate) fn poll(&mut self) -> Result<Snapshot, FeedError> {
        let (discovery, key) = self.prepare()?;
        let base = format!("http://127.0.0.1:{}", discovery.port);
        let snapshot: Snapshot = bridge::get_json(
            &self.client,
            &base,
            "/v1/wallpaper/snapshot",
            "Wallpaper",
            &key,
        )
        .map_err(|error| FeedError::new(ERR_HTTP, error.to_string()))?;
        validate(&snapshot)?;
        self.accept_snapshot(&snapshot, discovery.server_instance_id.as_deref())?;
        Ok(snapshot)
    }

    /// 订阅事件流直到断连；每收到一帧完整快照回调一次。
    /// 返回 `Ok(())` 只表示回调要求停止，断连/协议错误都以 `FeedError` 返回。
    pub(crate) fn subscribe(
        &mut self,
        mut on_snapshot: impl FnMut(Snapshot) -> bool,
    ) -> Result<(), FeedError> {
        let (discovery, key) = self.prepare()?;
        let address = SocketAddr::from(([127, 0, 0, 1], discovery.port));
        let stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT)
            .map_err(|error| FeedError::new(ERR_EVENTS, format!("连接壁纸事件失败：{error}")))?;
        stream
            .set_read_timeout(Some(READ_TIMEOUT))
            .map_err(|error| {
                FeedError::new(ERR_EVENTS, format!("设置壁纸事件超时失败：{error}"))
            })?;
        stream
            .set_write_timeout(Some(READ_TIMEOUT))
            .map_err(|error| {
                FeedError::new(ERR_EVENTS, format!("设置壁纸事件超时失败：{error}"))
            })?;
        let request = events_request(discovery.port, &key)?;
        let (mut socket, _) = tungstenite::client(request, stream).map_err(map_handshake)?;
        loop {
            let message = socket.read().map_err(map_socket_error)?;
            match message {
                tungstenite::Message::Text(text) => {
                    let snapshot: Snapshot =
                        serde_json::from_str(text.as_str()).map_err(|error| {
                            FeedError::new(ERR_INVALID, format!("壁纸事件快照无法解析：{error}"))
                        })?;
                    validate(&snapshot)?;
                    self.accept_snapshot(&snapshot, discovery.server_instance_id.as_deref())?;
                    if !on_snapshot(snapshot) {
                        return Ok(());
                    }
                }
                tungstenite::Message::Ping(payload) => {
                    let _ = socket.send(tungstenite::Message::Pong(payload));
                }
                tungstenite::Message::Close(_) => {
                    return Err(FeedError::new(ERR_EVENTS, "壁纸事件连接已关闭"));
                }
                _ => {}
            }
        }
    }
}

fn events_request(port: u16, key: &str) -> Result<tungstenite::http::Request<()>, FeedError> {
    let uri: tungstenite::http::Uri = format!("ws://127.0.0.1:{port}/v1/wallpaper/events")
        .parse()
        .map_err(|error| FeedError::new(ERR_EVENTS, format!("壁纸事件地址无效：{error}")))?;
    let mut request = uri
        .into_client_request()
        .map_err(|error| FeedError::new(ERR_EVENTS, format!("构造壁纸事件请求失败：{error}")))?;
    let value = tungstenite::http::HeaderValue::from_str(&format!("Wallpaper {key}"))
        .map_err(|error| FeedError::new(ERR_EVENTS, format!("壁纸事件凭据无效：{error}")))?;
    request.headers_mut().insert(AUTHORIZATION, value);
    Ok(request)
}

fn map_handshake(
    error: tungstenite::handshake::HandshakeError<
        tungstenite::handshake::client::ClientHandshake<TcpStream>,
    >,
) -> FeedError {
    use tungstenite::handshake::HandshakeError;
    match error {
        HandshakeError::Failure(tungstenite::Error::Http(response))
            if response.status().as_u16() == 401 =>
        {
            FeedError::new(ERR_KEY_INVALID, "壁纸事件鉴权失败")
        }
        HandshakeError::Failure(tungstenite::Error::Http(response))
            if matches!(response.status().as_u16(), 404 | 405) =>
        {
            FeedError::new(
                ERR_EVENTS_UNAVAILABLE,
                "Hertz 服务不支持壁纸事件流；使用快照轮询",
            )
        }
        HandshakeError::Failure(error) => {
            FeedError::new(ERR_EVENTS, format!("壁纸事件握手失败：{error}"))
        }
        HandshakeError::Interrupted(_) => FeedError::new(ERR_EVENTS, "壁纸事件握手被中断"),
    }
}

fn map_socket_error(error: tungstenite::Error) -> FeedError {
    let message = match error {
        tungstenite::Error::Io(error)
            if matches!(
                error.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
            ) =>
        {
            "等待壁纸事件超时".to_string()
        }
        other => format!("壁纸事件连接中断：{other}"),
    };
    FeedError::new(ERR_EVENTS, message)
}

pub(crate) fn validate(snapshot: &Snapshot) -> Result<(), FeedError> {
    let invalid = |message: &str| FeedError::new(ERR_INVALID, message);
    if snapshot.protocol != PROTOCOL {
        return Err(invalid("快照协议不一致"));
    }
    if !snapshot.valid {
        return Err(invalid("快照被服务标记为无效"));
    }
    if snapshot.timing != "presentation_applied" {
        return Err(invalid("快照时间语义不是 presentation_applied"));
    }
    if snapshot.server.session.is_empty()
        || snapshot.server.edition.is_empty()
        || snapshot.server.version.is_empty()
        || snapshot.generation.is_empty()
    {
        return Err(invalid("快照缺少服务身份或播放代际"));
    }
    if snapshot.spectrum.bands.len() != BANDS {
        return Err(invalid("频谱段数不是 64"));
    }
    if snapshot
        .spectrum
        .bands
        .iter()
        .any(|band| !band.is_finite() || !(0.0..=1.0).contains(band))
    {
        return Err(invalid("频谱包含非有限或越界值"));
    }
    if !snapshot.spectrum.energy.is_finite() || !(0.0..=1.0).contains(&snapshot.spectrum.energy) {
        return Err(invalid("频谱能量非有限或越界"));
    }
    if let Some(space) = snapshot.space.as_ref() {
        if space.scene.trim().is_empty() {
            return Err(invalid("三维空间场景为空"));
        }
        if !space.params.is_object() {
            return Err(invalid("三维空间参数不是对象"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::time::Duration;

    use super::*;

    fn snapshot(seq: u64) -> Snapshot {
        Snapshot {
            received_at: None,
            protocol: PROTOCOL,
            seq,
            server: ServerInfo {
                session: "s1".into(),
                edition: "full".into(),
                version: "0.2.1".into(),
            },
            valid: true,
            playing: true,
            position_ms: 1000,
            duration_ms: Some(60_000),
            generation: "3".into(),
            spectrum: Spectrum {
                bands: vec![0.5; BANDS],
                energy: 0.5,
                age_ms: Some(0),
            },
            space: None,
            timing: "presentation_applied".into(),
        }
    }

    fn json(snapshot: &Snapshot) -> String {
        serde_json::to_string(snapshot).unwrap()
    }

    #[test]
    fn spectrum_decays_after_500ms_and_zeroes_by_1s() {
        let mut value = snapshot(1);
        value.spectrum.age_ms = Some(0);
        assert_eq!(value.effective_bands(0), vec![0.5; BANDS]);
        assert_eq!(value.effective_bands(500), vec![0.5; BANDS]);
        let faded = value.effective_bands(750);
        assert!((faded[0] - 0.25).abs() < 0.001);
        assert_eq!(value.effective_bands(1000), vec![0.0; BANDS]);
        value.spectrum.age_ms = None;
        assert_eq!(value.effective_bands(0), vec![0.0; BANDS]);
    }

    #[test]
    fn server_shaped_snapshot_is_accepted() {
        let bands = vec!["0.0"; BANDS].join(",");
        let raw = format!(
            r#"{{"protocol":1,"seq":3,"server":{{"session":"s1","edition":"full","version":"0.2.1"}},"valid":true,"playing":false,"positionMs":0,"durationMs":null,"generation":"0","spectrum":{{"bands":[{bands}],"energy":0.0,"ageMs":null}},"timing":"presentation_applied"}}"#
        );
        let value: Snapshot = serde_json::from_str(&raw).unwrap();
        validate(&value).unwrap();
        assert_eq!(value.interpolated_position_ms(500), None);
        assert_eq!(value.effective_bands(0), vec![0.0; BANDS]);
    }

    #[test]
    fn paused_or_disconnected_snapshot_does_not_interpolate() {
        let mut value = snapshot(1);
        assert_eq!(value.interpolated_position_ms(500), Some(1500));
        value.playing = false;
        assert_eq!(value.interpolated_position_ms(500), None);
        value.playing = true;
        value.valid = false;
        assert_eq!(value.interpolated_position_ms(500), None);
        value.valid = true;
        value.position_ms = 59_800;
        assert_eq!(value.interpolated_position_ms(500), Some(60_000));
    }

    #[test]
    fn space_presentation_is_optional_and_validated() {
        let mut value = snapshot(1);
        value.space = Some(SpacePresentation {
            scene: "butterfly-vortex".into(),
            params: serde_json::json!({ "speed": 1.0 }),
        });
        validate(&value).unwrap();
        let decoded: Snapshot = serde_json::from_str(&json(&value)).unwrap();
        assert_eq!(decoded.space.unwrap().scene, "butterfly-vortex");

        let mut legacy: serde_json::Value = serde_json::from_str(&json(&snapshot(2))).unwrap();
        legacy.as_object_mut().unwrap().remove("space");
        let decoded: Snapshot = serde_json::from_value(legacy).unwrap();
        assert!(decoded.space.is_none());
        validate(&decoded).unwrap();

        value.space = Some(SpacePresentation {
            scene: " ".into(),
            params: serde_json::json!({}),
        });
        assert_eq!(validate(&value).unwrap_err().code, ERR_INVALID);
        value.space = Some(SpacePresentation {
            scene: "coast".into(),
            params: serde_json::json!([]),
        });
        assert_eq!(validate(&value).unwrap_err().code, ERR_INVALID);
    }

    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_dir() -> TempDir {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        TempDir(std::env::temp_dir().join(format!(
            "hertz-wallpaper-feed-{}-{nanos}",
            std::process::id()
        )))
    }

    fn make_profile(dir: &TempDir, protocol: Option<u32>, key: bool, port: u16) -> Profile {
        let discovery = serde_json::json!({
            "pid": 1,
            "port": port,
            "version": "0.2.1",
            "protocol_version": 1,
            "edition": "full",
            "server_instance_id": "s1",
            "wallpaper_protocol": protocol,
        });
        std::fs::write(
            dir.0.join("vmusicd.json"),
            serde_json::to_vec(&discovery).unwrap(),
        )
        .unwrap();
        if key {
            std::fs::write(dir.0.join("wallpaper-key"), "a".repeat(64)).unwrap();
        }
        crate::config::standalone(dir.0.clone(), "full")
    }

    fn serve(body: String) -> (u16, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0u8; 4096];
            let read = socket.read(&mut request).unwrap_or(0);
            let request = String::from_utf8_lossy(&request[..read]).to_ascii_lowercase();
            let response = if request.contains("authorization: wallpaper ") {
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
            } else {
                "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()
            };
            let _ = socket.write_all(response.as_bytes());
        });
        (port, handle)
    }

    fn serve_ws(bodies: Vec<String>) -> (u16, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut socket = tungstenite::accept(stream).unwrap();
            for body in bodies {
                if socket
                    .send(tungstenite::Message::Text(body.into()))
                    .is_err()
                {
                    return;
                }
            }
            let _ = socket.close(None);
            let _ = socket.flush();
        });
        (port, handle)
    }

    fn serve_status(status: &'static str) -> (u16, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0u8; 4096];
            let _ = socket.read(&mut request);
            let response =
                format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            let _ = socket.write_all(response.as_bytes());
        });
        (port, handle)
    }

    #[test]
    fn events_request_uses_wallpaper_authorization() {
        let request = events_request(1234, "abc").unwrap();
        assert_eq!(request.uri().path(), "/v1/wallpaper/events");
        assert_eq!(request.uri().port_u16(), Some(1234));
        assert_eq!(
            request
                .headers()
                .get("authorization")
                .unwrap()
                .to_str()
                .unwrap(),
            "Wallpaper abc"
        );
        assert!(request.headers().contains_key("sec-websocket-key"));
    }

    #[test]
    fn events_stream_reads_monotonic_snapshots() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir.0).unwrap();
        let (port, server) = serve_ws(vec![json(&snapshot(3)), json(&snapshot(4))]);
        let profile = make_profile(&dir, Some(PROTOCOL), true, port);
        let mut feed = Feed::new(profile).unwrap();
        let mut seqs = Vec::new();
        let error = feed
            .subscribe(|value| {
                seqs.push(value.seq);
                true
            })
            .unwrap_err();
        assert_eq!(seqs, vec![3, 4]);
        assert_eq!(error.code, ERR_EVENTS);
        server.join().unwrap();
    }

    #[test]
    fn events_stream_rejects_replayed_sequence() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir.0).unwrap();
        let (port, server) = serve_ws(vec![json(&snapshot(2)), json(&snapshot(1))]);
        let profile = make_profile(&dir, Some(PROTOCOL), true, port);
        let mut feed = Feed::new(profile).unwrap();
        let mut seqs = Vec::new();
        let error = feed
            .subscribe(|value| {
                seqs.push(value.seq);
                true
            })
            .unwrap_err();
        assert_eq!(seqs, vec![2]);
        assert_eq!(error.code, ERR_STALE);
        server.join().unwrap();
    }

    #[test]
    fn events_stream_rejects_other_session() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir.0).unwrap();
        let mut value = snapshot(1);
        value.server.session = "other".into();
        let (port, server) = serve_ws(vec![json(&value)]);
        let profile = make_profile(&dir, Some(PROTOCOL), true, port);
        let mut feed = Feed::new(profile).unwrap();
        let error = feed.subscribe(|_| true).unwrap_err();
        assert_eq!(error.code, ERR_SESSION_CHANGED);
        server.join().unwrap();
    }

    #[test]
    fn events_endpoint_missing_falls_back_to_polling() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir.0).unwrap();
        let (port, server) = serve_status("404 Not Found");
        let profile = make_profile(&dir, Some(PROTOCOL), true, port);
        let mut feed = Feed::new(profile).unwrap();
        let error = feed.subscribe(|_| true).unwrap_err();
        assert_eq!(error.code, ERR_EVENTS_UNAVAILABLE);
        server.join().unwrap();
    }

    #[test]
    fn poll_reads_the_wallpaper_key_and_snapshot() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir.0).unwrap();
        let body = json(&snapshot(7));
        let (port, server) = serve(body);
        let profile = make_profile(&dir, Some(PROTOCOL), true, port);
        let mut feed = Feed::new(profile).unwrap();
        let value = feed.poll().unwrap();
        assert_eq!(value.seq, 7);
        assert_eq!(value.server.session, "s1");
        assert_eq!(value.spectrum.bands.len(), BANDS);
        server.join().unwrap();
    }

    #[test]
    fn missing_protocol_or_key_is_a_stable_error_code() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir.0).unwrap();
        let profile = make_profile(&dir, None, false, 1);
        let mut feed = Feed::new(profile).unwrap();
        assert_eq!(feed.poll().unwrap_err().code, ERR_PROTOCOL_MISSING);

        let profile = make_profile(&dir, Some(PROTOCOL), false, 1);
        let mut feed = Feed::new(profile).unwrap();
        assert_eq!(feed.poll().unwrap_err().code, ERR_KEY_MISSING);
    }

    #[test]
    fn invalid_snapshot_is_rejected() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir.0).unwrap();
        let mut value = snapshot(1);
        value.spectrum.bands.pop();
        let (port, server) = serve(json(&value));
        let profile = make_profile(&dir, Some(PROTOCOL), true, port);
        let mut feed = Feed::new(profile).unwrap();
        assert_eq!(feed.poll().unwrap_err().code, ERR_INVALID);
        server.join().unwrap();
    }

    #[test]
    fn stale_sequence_is_rejected() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir.0).unwrap();
        let (port, first) = serve(json(&snapshot(2)));
        let profile = make_profile(&dir, Some(PROTOCOL), true, port);
        let mut feed = Feed::new(profile).unwrap();
        assert_eq!(feed.poll().unwrap().seq, 2);
        first.join().unwrap();

        let (port, second) = serve(json(&snapshot(1)));
        let profile = make_profile(&dir, Some(PROTOCOL), true, port);
        let mut stale = Feed {
            client: bridge::client().unwrap(),
            profile,
            session: feed.session.clone(),
            last_seq: feed.last_seq,
        };
        assert_eq!(stale.poll().unwrap_err().code, ERR_STALE);
        second.join().unwrap();
    }
}
