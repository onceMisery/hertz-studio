// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 壁纸只读 feed：播放时钟 + 最新 64 段频谱。
//!
//! 只认当前 profile 的 `vmusicd.json`、`wallpaper-key` 与
//! `GET /v1/wallpaper/snapshot`；不接触主 token、歌词钥匙或播放控制。
//! 快照不含曲名、路径、账号和封面。断连由调用方清空；暂停不插值；
//! 频谱按 500 ms 开始衰减、1 s 归零。

use serde::{Deserialize, Serialize};

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
pub(crate) const ERR_SESSION_CHANGED: &str = "wallpaper_session_changed";
pub(crate) const ERR_STALE: &str = "wallpaper_stale_snapshot";
pub(crate) const ERR_INVALID: &str = "wallpaper_invalid_snapshot";

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
    pub(crate) protocol: u32,
    pub(crate) seq: u64,
    pub(crate) server: ServerInfo,
    pub(crate) valid: bool,
    pub(crate) playing: bool,
    pub(crate) position_ms: u64,
    pub(crate) duration_ms: Option<u64>,
    pub(crate) generation: String,
    pub(crate) spectrum: Spectrum,
    pub(crate) timing: String,
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
        Ok(Self {
            client: bridge::client()?,
            profile,
            session: None,
            last_seq: None,
        })
    }

    pub(crate) fn poll(&mut self) -> Result<Snapshot, FeedError> {
        let discovery_path = self.profile.data_dir.join("vmusicd.json");
        if !discovery_path.is_file() {
            return Err(FeedError::new(
                ERR_DISCOVERY_MISSING,
                format!(
                    "未找到 {}：请先启动 Hertz {} 服务",
                    discovery_path.display(),
                    self.profile.edition
                ),
            ));
        }
        let discovery = bridge::read_discovery(&self.profile)
            .map_err(|error| FeedError::new(ERR_DISCOVERY_INVALID, error.to_string()))?;
        if let Some(edition) = discovery.edition.as_deref() {
            if self.profile.edition != "custom" && edition != self.profile.edition {
                return Err(FeedError::new(
                    ERR_EDITION_MISMATCH,
                    format!(
                        "数据目录属于 {edition} 发行版，当前 profile 是 {}",
                        self.profile.edition
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
        let key_path = self.profile.data_dir.join("wallpaper-key");
        if !key_path.is_file() {
            return Err(FeedError::new(
                ERR_KEY_MISSING,
                format!(
                    "未找到 {}：请重启 Hertz 服务以生成壁纸钥匙",
                    key_path.display()
                ),
            ));
        }
        let key = bridge::read_key(&self.profile.data_dir, "wallpaper-key", "壁纸")
            .map_err(|error| FeedError::new(ERR_KEY_INVALID, error.to_string()))?;
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

        if discovery
            .server_instance_id
            .as_deref()
            .is_some_and(|session| session != snapshot.server.session)
        {
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
        Ok(snapshot)
    }
}

fn validate(snapshot: &Snapshot) -> Result<(), FeedError> {
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
        Profile {
            data_dir: dir.0.clone(),
            edition: "full".into(),
        }
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
