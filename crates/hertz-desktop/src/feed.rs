// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 来源发现、窄凭据、只读快照/文档与显式歌词播控。
//!
//! 只认当前 profile 数据目录里的 `vmusicd.json` 与 `desktop-lyrics-key`；
//! 不扫描端口、不跟随重定向、不接触主 token 或 OBS 钥匙。

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use crate::bridge;
use crate::config::Profile;

pub(crate) const PROTOCOL: u32 = 1;

/// Explicit toolbar actions use the narrow desktop endpoint; credentials stay native.
pub(crate) fn control(profile: &Profile, payload: &serde_json::Value) -> Result<()> {
    let discovery = bridge::read_discovery(profile)?;
    if discovery.desktop_lyrics_protocol != Some(PROTOCOL)
        || discovery.edition.as_deref() != Some(profile.edition.as_str())
        || discovery.server_instance_id.as_deref() != payload["session"].as_str()
    {
        bail!("播放来源已变化，请等待重新同步");
    }
    let key = bridge::read_key(&profile.data_dir, "desktop-lyrics-key", "桌面歌词")?;
    let response = bridge::client()?
        .post(format!(
            "http://127.0.0.1:{}/v1/desktop-lyrics/control",
            discovery.port
        ))
        .header("Authorization", format!("Desktop {key}"))
        .json(payload)
        .send()?;
    if !response.status().is_success() {
        bail!("桌面播控返回 {}", response.status());
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub(crate) protocol: u32,
    pub(crate) seq: u64,
    pub(crate) server: ServerInfo,
    pub(crate) generation: String,
    pub(crate) position_ms: u64,
    pub(crate) duration_ms: Option<u64>,
    pub(crate) playing: bool,
    pub(crate) buffering: bool,
    #[serde(default)]
    pub(crate) buffering_percent: Option<u8>,
    pub(crate) track: Option<TrackInfo>,
    pub(crate) lyrics: LyricStatus,
    #[serde(default)]
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
pub(crate) struct TrackInfo {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) artist: Option<String>,
    pub(crate) album: Option<String>,
    pub(crate) duration_ms: Option<u64>,
    #[serde(default)]
    pub(crate) online: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LyricStatus {
    pub(crate) status: String,
    pub(crate) document_key: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Document {
    pub(crate) protocol: u32,
    pub(crate) timing: String,
    #[serde(default)]
    pub(crate) offset_ms: i64,
    #[serde(default)]
    pub(crate) format: Option<String>,
    #[serde(default)]
    pub(crate) source: Option<serde_json::Value>,
    #[serde(default)]
    pub(crate) lines: Vec<DocLine>,
    #[serde(default)]
    pub(crate) document_key: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocLine {
    pub(crate) start_ms: u64,
    pub(crate) end_ms: Option<u64>,
    pub(crate) text: String,
    #[serde(default)]
    pub(crate) words: Vec<DocWord>,
    #[serde(default)]
    pub(crate) translation: Option<String>,
    #[serde(default)]
    pub(crate) romanization: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocWord {
    pub(crate) start_ms: u64,
    pub(crate) end_ms: Option<u64>,
    pub(crate) text: String,
}

pub(crate) struct FeedUpdate {
    pub(crate) snapshot: Snapshot,
    pub(crate) document: Option<Document>,
    pub(crate) warning: Option<String>,
}

pub(crate) struct Feed {
    client: reqwest::blocking::Client,
    profile: Profile,
    last_document_key: Option<String>,
    session: Option<String>,
}

impl Feed {
    pub(crate) fn new(profile: Profile) -> Result<Self> {
        Ok(Self {
            client: bridge::client()?,
            profile,
            last_document_key: None,
            session: None,
        })
    }

    pub(crate) fn poll(&mut self) -> Result<FeedUpdate> {
        let discovery = bridge::read_discovery(&self.profile)?;
        if let Some(edition) = discovery.edition.as_deref() {
            if self.profile.edition != "custom" && edition != self.profile.edition {
                bail!(
                    "数据目录属于 {} 发行版，当前 profile 是 {}",
                    edition,
                    self.profile.edition
                );
            }
        }
        if discovery.desktop_lyrics_protocol != Some(PROTOCOL) {
            bail!("Hertz 服务版本不支持桌面歌词协议 {PROTOCOL}，请升级服务后重启");
        }
        if self
            .session
            .as_deref()
            .is_some_and(|session| Some(session) != discovery.server_instance_id.as_deref())
        {
            self.last_document_key = None;
        }
        self.session = discovery.server_instance_id.clone();
        // 每拍重读钥匙：删文件重启即可轮换，不需要组件重启。
        let read_key = bridge::read_key(&self.profile.data_dir, "desktop-lyrics-key", "桌面歌词")?;
        let base = format!("http://127.0.0.1:{}", discovery.port);

        let snapshot: Snapshot = bridge::get_json(
            &self.client,
            &base,
            "/v1/desktop-lyrics/snapshot",
            "Desktop",
            &read_key,
        )?;
        if snapshot.protocol != PROTOCOL {
            bail!(
                "服务快照协议 {} 与组件协议 {PROTOCOL} 不一致",
                snapshot.protocol
            );
        }
        if discovery
            .server_instance_id
            .as_deref()
            .is_some_and(|session| session != snapshot.server.session)
        {
            self.last_document_key = None;
            bail!("服务会话已变化，等待新快照");
        }
        self.validate_timing(&snapshot)?;

        let mut document = None;
        let mut warning = None;
        if snapshot.lyrics.status == "ready" {
            if let Some(key) = snapshot.lyrics.document_key.as_deref() {
                if key.len() > 128
                    || !key.chars().all(|character| {
                        character.is_ascii_alphanumeric() || character == '-' || character == '_'
                    })
                {
                    self.last_document_key = None;
                    warning = Some("服务返回的 documentKey 不是有效内容标识，已忽略".into());
                } else if self.last_document_key.as_deref() != Some(key) {
                    match bridge::get_json::<Document>(
                        &self.client,
                        &base,
                        &format!("/v1/desktop-lyrics/document?key={key}"),
                        "Desktop",
                        &read_key,
                    ) {
                        Ok(value) => {
                            if value.protocol != PROTOCOL {
                                warning =
                                    Some(format!("文档协议 {} 不一致，已忽略", value.protocol));
                                self.last_document_key = None;
                            } else if value
                                .document_key
                                .as_deref()
                                .is_some_and(|actual| actual != key)
                            {
                                warning = Some("文档 key 与快照不一致，已忽略".into());
                                self.last_document_key = None;
                            } else {
                                self.validate_timing(&value)?;
                                self.last_document_key = Some(key.to_string());
                                document = Some(value);
                            }
                        }
                        Err(error) => {
                            self.last_document_key = None;
                            warning = Some(format!("读取歌词文档失败：{error}"));
                        }
                    }
                }
            } else {
                self.last_document_key = None;
            }
        } else {
            self.last_document_key = None;
        }
        Ok(FeedUpdate {
            snapshot,
            document,
            warning,
        })
    }

    fn validate_timing(&self, value: &impl Timing) -> Result<()> {
        if value.timing() != "presentation_applied" {
            bail!("服务返回的时间语义不是 presentation_applied");
        }
        Ok(())
    }
}

trait Timing {
    fn timing(&self) -> &str;
}

impl Timing for Snapshot {
    fn timing(&self) -> &str {
        &self.timing
    }
}

impl Timing for Document {
    fn timing(&self) -> &str {
        &self.timing
    }
}
