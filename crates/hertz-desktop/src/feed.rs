// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 来源发现、窄凭据、只读快照/文档与显式歌词播控。
//!
//! 只认当前 profile 数据目录里的 `vmusicd.json` 与 `desktop-lyrics-key`；
//! 不扫描端口、不跟随重定向、不接触主 token 或 OBS 钥匙。

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, io::Read};

use crate::bridge;
use crate::config::Profile;

pub(crate) const PROTOCOL: u32 = 1;
pub(crate) const VOCAL_SCHEMA_VERSION: u32 = 1;
const DOCUMENT_MAX_BYTES: usize = 2 * 1024 * 1024;
const PRESENTATION_MAX_MS: u64 = 86_522_000;
// Positive source intervals can collapse only at zero before the <=2s global shift.
const CLAMPED_ZERO_MAX_MS: u64 = 2_000;

fn non_null<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// Explicit toolbar actions use the narrow desktop endpoint; credentials stay native.
pub(crate) fn control(profile: &Profile, payload: &serde_json::Value) -> Result<()> {
    if crate::config::is_dbx(profile) {
        bail!("DBX 来源仅支持歌词读取，请在 DBX 中控制播放");
    }
    let Some(session) = payload["session"]
        .as_str()
        .filter(|value| !value.is_empty())
    else {
        bail!("播放来源已变化，请等待重新同步");
    };
    let discovery = bridge::read_discovery(profile)?;
    if discovery.desktop_lyrics_protocol != Some(PROTOCOL)
        // --data-dir binds a custom profile to this exact discovery directory.
        // Match the polling path: its service may be either full or standard.
        || (profile.edition() != "custom"
            && discovery.edition.as_deref() != Some(profile.edition()))
        || discovery.server_instance_id.as_deref() != Some(session)
    {
        bail!("播放来源已变化，请等待重新同步");
    }
    let key = bridge::read_key(
        std::path::Path::new(profile.data_dir()),
        "desktop-lyrics-key",
        "桌面歌词",
    )?;
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) vocal_schema_versions: Vec<u32>,
    #[serde(default)]
    pub(crate) lyrics_calibration: Option<serde_json::Value>,
}

impl Snapshot {
    pub(crate) fn vocal_capability(&self) -> Option<u32> {
        self.vocal_schema_versions
            .contains(&VOCAL_SCHEMA_VERSION)
            .then_some(VOCAL_SCHEMA_VERSION)
    }
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Document {
    pub(crate) protocol: u32,
    pub(crate) timing: String,
    #[serde(default)]
    pub(crate) offset_ms: i64,
    #[serde(default)]
    pub(crate) format: Option<String>,
    #[serde(default)]
    pub(crate) source: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) timing_precision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) origin: Option<serde_json::Value>,
    #[serde(default)]
    pub(crate) lines: Vec<DocLine>,
    #[serde(default)]
    pub(crate) document_key: Option<String>,
    #[serde(
        default,
        deserialize_with = "non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) vocal_schema_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) agents: Vec<DocAgent>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DocAgent {
    pub(crate) id: String,
    pub(crate) kind: AgentKind,
    #[serde(
        default,
        deserialize_with = "non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) name: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AgentKind {
    Person,
    Character,
    Group,
    Organization,
    Other,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DocVocal {
    pub(crate) agent_ids: Vec<String>,
    pub(crate) role: VocalRole,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum VocalRole {
    Lead,
    Backing,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
    #[serde(
        default,
        deserialize_with = "non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) vocal: Option<DocVocal>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DocWord {
    pub(crate) start_ms: u64,
    pub(crate) end_ms: Option<u64>,
    pub(crate) text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DocumentError {
    Unsupported,
    Invalid,
    Stale,
}

impl DocumentError {
    pub(crate) fn message(self) -> &'static str {
        match self {
            Self::Unsupported => "当前桌面歌词组件不支持此歌词，请更新组件",
            Self::Invalid => "歌词内容无效，请在播放器中重新导入",
            Self::Stale => "歌词文档已变化，等待重新同步",
        }
    }
    pub(crate) fn status(self) -> &'static str {
        match self {
            Self::Unsupported => "unsupported",
            Self::Invalid => "invalid",
            Self::Stale => "loading",
        }
    }
}

/// The only admission gate for full lyric documents, used by HTTP and DBX.
pub(crate) fn parse_document(
    value: serde_json::Value,
    expected_key: &str,
    capability: Option<u32>,
) -> std::result::Result<Document, DocumentError> {
    use DocumentError::{Invalid, Stale, Unsupported};
    if value
        .get("documentKey")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|key| key != expected_key)
    {
        return Err(Stale);
    }
    if serde_json::to_vec(&value).map_err(|_| Invalid)?.len() > DOCUMENT_MAX_BYTES {
        return Err(Invalid);
    }
    let version = match value.get("vocalSchemaVersion") {
        None => None,
        Some(version) => Some(version.as_u64().ok_or(Invalid)?),
    };
    if version.is_some_and(|version| version != u64::from(VOCAL_SCHEMA_VERSION)) {
        return Err(Unsupported);
    }
    let vocal_fields = value.get("agents").is_some()
        || value
            .get("lines")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|lines| lines.iter().any(|line| line.get("vocal").is_some()));
    if version.is_none() && vocal_fields {
        return Err(Invalid);
    }
    if version.is_some() && capability != Some(VOCAL_SCHEMA_VERSION) {
        return Err(Unsupported);
    }
    let doc: Document = serde_json::from_value(value).map_err(|_| Invalid)?;
    if doc.protocol != PROTOCOL
        || doc.timing != "presentation_applied"
        || doc.document_key.as_deref() != Some(expected_key)
        || doc.offset_ms.unsigned_abs() > 122_000
        || doc.lines.len() > 2048
        || doc.agents.len() > 32
    {
        return Err(Invalid);
    }
    let vocal_document = doc.vocal_schema_version.is_some();
    if vocal_document
        && (doc.agents.is_empty() || !doc.lines.iter().any(|line| line.vocal.is_some()))
    {
        return Err(Invalid);
    }
    let mut agents = HashMap::new();
    for (index, agent) in doc.agents.iter().enumerate() {
        if agent.id.is_empty()
            || agent.id.len() > 128
            || agent
                .id
                .chars()
                .any(|c| c.is_whitespace() || c.is_control())
            || agents.insert(agent.id.as_str(), index).is_some()
            || agent
                .name
                .as_ref()
                .is_some_and(|name| name.len() > 128 || name.trim().is_empty())
        {
            return Err(Invalid);
        }
    }
    let mut previous_start = 0;
    let mut previous_active_end = 0;
    let mut previous_unannotated_end = 0;
    let mut words = 0usize;
    let mut text_bytes = 0usize;
    let mut translation_bytes = 0usize;
    let mut romanization_bytes = 0usize;
    for line in &doc.lines {
        if line.start_ms < previous_start
            || line.start_ms > PRESENTATION_MAX_MS
            || line
                .end_ms
                .is_some_and(|end| end < line.start_ms || end > PRESENTATION_MAX_MS)
            || (vocal_document && (line.end_ms.is_none() || line.text.trim().is_empty()))
            || (vocal_document
                && line.end_ms == Some(line.start_ms)
                && line.start_ms > CLAMPED_ZERO_MAX_MS)
        {
            return Err(Invalid);
        }
        previous_start = line.start_ms;
        if let Some(vocal) = &line.vocal {
            if line.text.trim().is_empty()
                || vocal.agent_ids.is_empty()
                || vocal.agent_ids.len() > 8
            {
                return Err(Invalid);
            }
            let mut previous_agent = None;
            for id in &vocal.agent_ids {
                let index = *agents.get(id.as_str()).ok_or(Invalid)?;
                if previous_agent.is_some_and(|previous| previous >= index) {
                    return Err(Invalid);
                }
                previous_agent = Some(index);
            }
        }
        if vocal_document && !line.text.trim().is_empty() {
            let end = line.end_ms.ok_or(Invalid)?;
            if end > line.start_ms {
                if line.start_ms < previous_unannotated_end
                    || (line.vocal.is_none() && line.start_ms < previous_active_end)
                {
                    return Err(Invalid);
                }
                previous_active_end = previous_active_end.max(end);
                if line.vocal.is_none() {
                    previous_unannotated_end = previous_unannotated_end.max(end);
                }
            }
        }
        let mut previous_word = line.start_ms;
        for word in &line.words {
            if word.start_ms < previous_word
                || word.start_ms > PRESENTATION_MAX_MS
                || word
                    .end_ms
                    .is_some_and(|end| end < word.start_ms || end > PRESENTATION_MAX_MS)
                || (vocal_document && word.end_ms.is_none())
                || (vocal_document
                    && word.end_ms == Some(word.start_ms)
                    && word.start_ms > CLAMPED_ZERO_MAX_MS)
                || line.end_ms.is_some_and(|end| {
                    word.start_ms > end || word.end_ms.is_some_and(|word_end| word_end > end)
                })
            {
                return Err(Invalid);
            }
            previous_word = word.end_ms.unwrap_or(word.start_ms);
            words += 1;
            text_bytes += word.text.len();
        }
        if vocal_document
            && !line.words.is_empty()
            && line
                .words
                .iter()
                .map(|word| word.text.as_str())
                .collect::<String>()
                != line.text
        {
            return Err(Invalid);
        }
        text_bytes += line.text.len();
        translation_bytes += line.translation.as_ref().map_or(0, String::len);
        romanization_bytes += line.romanization.as_ref().map_or(0, String::len);
        if words > 16384
            || text_bytes > 512 * 1024
            || translation_bytes > 256 * 1024
            || romanization_bytes > 256 * 1024
        {
            return Err(Invalid);
        }
    }
    Ok(doc)
}

enum DocumentReadError {
    Permanent(DocumentError),
    Transient(String),
}

fn read_document_http(
    client: &reqwest::blocking::Client,
    base: &str,
    key: &str,
    credential: &str,
    capability: Option<u32>,
) -> std::result::Result<Document, DocumentReadError> {
    use DocumentReadError::{Permanent, Transient};
    let extension = capability.map_or_else(String::new, |version| {
        format!("&vocalSchemaVersion={version}")
    });
    let response = client
        .get(format!(
            "{base}/v1/desktop-lyrics/document?key={key}{extension}"
        ))
        .header("Authorization", format!("Desktop {credential}"))
        .send()
        .map_err(|_| Transient("连接本机歌词服务失败".into()))?;
    let status = response.status();
    if !status.is_success() {
        if status.as_u16() == 422 {
            let mut bytes = Vec::new();
            if response.take(4097).read_to_end(&mut bytes).is_ok()
                && bytes.len() <= 4096
                && serde_json::from_slice::<serde_json::Value>(&bytes)
                    .ok()
                    .is_some_and(|body| body["error"]["code"] == "desktop_vocals_unsupported")
            {
                return Err(Permanent(DocumentError::Unsupported));
            }
        }
        return Err(Transient(format!("歌词服务返回 {status}")));
    }
    if response
        .content_length()
        .is_some_and(|length| length > DOCUMENT_MAX_BYTES as u64)
    {
        return Err(Permanent(DocumentError::Invalid));
    }
    let mut bytes = Vec::new();
    response
        .take(DOCUMENT_MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Transient("读取歌词文档失败".into()))?;
    if bytes.len() > DOCUMENT_MAX_BYTES {
        return Err(Permanent(DocumentError::Invalid));
    }
    let value = serde_json::from_slice(&bytes).map_err(|_| Permanent(DocumentError::Invalid))?;
    parse_document(value, key, capability).map_err(|error| {
        if error == DocumentError::Stale {
            Transient(error.message().into())
        } else {
            Permanent(error)
        }
    })
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
    cached_document: Option<Document>,
    session: Option<String>,
    document_capability: Option<u32>,
    rejected_document: Option<(String, String, Option<u32>, DocumentError)>,
}

impl Feed {
    pub(crate) fn new(profile: Profile) -> Result<Self> {
        if crate::config::is_dbx(&profile) {
            bail!("DBX 来源必须使用私有管道读取");
        }
        Ok(Self {
            client: bridge::client()?,
            profile,
            last_document_key: None,
            cached_document: None,
            session: None,
            document_capability: None,
            rejected_document: None,
        })
    }

    pub(crate) fn poll(&mut self) -> Result<FeedUpdate> {
        let discovery = bridge::read_discovery(&self.profile)?;
        if let Some(edition) = discovery.edition.as_deref() {
            if self.profile.edition() != "custom" && edition != self.profile.edition() {
                bail!(
                    "数据目录属于 {} 发行版，当前 profile 是 {}",
                    edition,
                    self.profile.edition()
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
            self.cached_document = None;
            self.rejected_document = None;
        }
        if discovery.server_instance_id.is_some() {
            self.session = discovery.server_instance_id.clone();
        }
        // 每拍重读钥匙：删文件重启即可轮换，不需要组件重启。
        let read_key = bridge::read_key(
            std::path::Path::new(self.profile.data_dir()),
            "desktop-lyrics-key",
            "桌面歌词",
        )?;
        let base = format!("http://127.0.0.1:{}", discovery.port);

        let mut snapshot: Snapshot = bridge::get_json(
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
        if self
            .session
            .as_deref()
            .is_some_and(|session| session != snapshot.server.session)
        {
            self.last_document_key = None;
            self.cached_document = None;
            self.rejected_document = None;
        }
        self.session = Some(snapshot.server.session.clone());
        let capability = snapshot.vocal_capability();
        if capability != self.document_capability {
            self.last_document_key = None;
            self.cached_document = None;
            self.rejected_document = None;
            self.document_capability = capability;
        }

        let mut document = None;
        let mut warning = None;
        if snapshot.lyrics.status == "ready" {
            if let Some(key) = snapshot.lyrics.document_key.as_deref() {
                if key.is_empty()
                    || key.len() > 128
                    || !key.chars().all(|character| {
                        character.is_ascii_alphanumeric() || character == '-' || character == '_'
                    })
                {
                    self.last_document_key = None;
                    self.cached_document = None;
                    warning = Some("服务返回的 documentKey 不是有效内容标识，已忽略".into());
                } else if let Some((_, _, _, error)) = self.rejected_document.as_ref().filter(
                    |(session, rejected_key, rejected_capability, _)| {
                        session == &snapshot.server.session
                            && rejected_key == key
                            && rejected_capability == &capability
                    },
                ) {
                    warning = Some(error.message().into());
                    snapshot.lyrics.status = error.status().into();
                } else if self.last_document_key.as_deref() != Some(key) {
                    self.cached_document = None;
                    self.rejected_document = None;
                    match read_document_http(&self.client, &base, key, &read_key, capability) {
                        Ok(value) => {
                            self.last_document_key = Some(key.to_string());
                            self.cached_document = Some(value.clone());
                            document = Some(value);
                        }
                        Err(DocumentReadError::Permanent(error)) => {
                            self.rejected_document = Some((
                                snapshot.server.session.clone(),
                                key.to_string(),
                                capability,
                                error,
                            ));
                            self.last_document_key = None;
                            warning = Some(error.message().into());
                            snapshot.lyrics.status = error.status().into();
                        }
                        Err(DocumentReadError::Transient(error)) => {
                            self.last_document_key = None;
                            warning = Some(format!("读取歌词文档失败：{error}"));
                        }
                    }
                } else {
                    document = self.cached_document.clone();
                }
            } else {
                self.last_document_key = None;
            }
        } else {
            self.last_document_key = None;
            self.cached_document = None;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };

    fn vocal_wire(key: &str) -> serde_json::Value {
        serde_json::json!({
            "protocol":1,"timing":"presentation_applied","documentKey":key,"vocalSchemaVersion":1,
            "agents":[{"id":"a","kind":"person","name":"甲"},{"id":"b","kind":"group"}],
            "lines":[
                {"startMs":0,"endMs":10000,"text":"长句","words":[],"translation":"","vocal":{"agentIds":["a"],"role":"lead"}},
                {"startMs":2000,"endMs":4000,"text":"短句","vocal":{"agentIds":["b"],"role":"backing"}}
            ]
        })
    }

    #[test]
    fn shared_admission_preserves_overlaps_and_rejects_inconsistent_vocal_fields() {
        let valid = vocal_wire("key");
        let doc = parse_document(valid.clone(), "key", Some(1)).unwrap();
        assert_eq!(doc.lines[0].end_ms, Some(10000));
        assert_eq!(
            doc.lines[1].vocal.as_ref().unwrap().role,
            VocalRole::Backing
        );
        assert_eq!(
            parse_document(valid.clone(), "other", Some(1)).unwrap_err(),
            DocumentError::Stale
        );
        assert_eq!(
            parse_document(valid.clone(), "key", None).unwrap_err(),
            DocumentError::Unsupported
        );
        let mut unknown = valid.clone();
        unknown["vocalSchemaVersion"] = serde_json::json!(2);
        assert_eq!(
            parse_document(unknown, "key", Some(1)).unwrap_err(),
            DocumentError::Unsupported
        );
        let mut cases = Vec::new();
        for (pointer, replacement) in [
            ("/vocalSchemaVersion", serde_json::json!(null)),
            ("/agents", serde_json::json!(null)),
            ("/agents/0/name", serde_json::json!(null)),
            ("/agents/0/kind", serde_json::json!("singer")),
            ("/agents/0/name", serde_json::json!(" ")),
            ("/agents/0/name", serde_json::json!("x".repeat(129))),
            ("/agents/0/id", serde_json::json!("a b")),
            ("/agents/0/id", serde_json::json!("a\u{0000}")),
            ("/agents/1/id", serde_json::json!("a")),
            ("/lines/0/vocal", serde_json::json!(null)),
            ("/lines/0/vocal/role", serde_json::json!("solo")),
            ("/lines/0/vocal/agentIds", serde_json::json!([])),
            ("/lines/0/vocal/agentIds", serde_json::json!(["missing"])),
            ("/lines/0/vocal/agentIds", serde_json::json!(["a", "a"])),
            ("/lines/0/vocal/agentIds", serde_json::json!(["b", "a"])),
            ("/lines/0/endMs", serde_json::json!(null)),
            ("/lines/0/endMs", serde_json::json!(86_522_001)),
            ("/lines/1/startMs", serde_json::json!(5000)),
            (
                "/lines/0/words",
                serde_json::json!([{"startMs":0,"endMs":null,"text":"长句"}]),
            ),
            (
                "/lines/0/words",
                serde_json::json!([{"startMs":0,"endMs":10001,"text":"长句"}]),
            ),
            (
                "/lines/0/words",
                serde_json::json!([{"startMs":1,"endMs":2,"text":"长"},{"startMs":0,"endMs":3,"text":"句"}]),
            ),
            (
                "/lines/0/translation",
                serde_json::json!("x".repeat(256 * 1024 + 1)),
            ),
        ] {
            let mut case = valid.clone();
            *case
                .pointer_mut(pointer)
                .unwrap_or_else(|| panic!("missing {pointer}")) = replacement;
            cases.push(case);
        }
        let mut missing_version = valid.clone();
        missing_version
            .as_object_mut()
            .unwrap()
            .remove("vocalSchemaVersion");
        cases.push(missing_version);
        let mut partial = valid.clone();
        partial["lines"][1].as_object_mut().unwrap().remove("vocal");
        cases.push(partial);
        let mut unsorted = valid.clone();
        unsorted["lines"].as_array_mut().unwrap().swap(0, 1);
        cases.push(unsorted);
        let mut wrong_case = valid.clone();
        wrong_case["lines"][0]["vocal"] = serde_json::json!({"agent_ids":["a"],"role":"lead"});
        cases.push(wrong_case);
        let mut unreferenced = valid.clone();
        for line in unreferenced["lines"].as_array_mut().unwrap() {
            line.as_object_mut().unwrap().remove("vocal");
        }
        cases.push(unreferenced);
        for (index, case) in cases.into_iter().enumerate() {
            assert_eq!(
                parse_document(case, "key", Some(1)).unwrap_err(),
                DocumentError::Invalid,
                "case {index}"
            );
        }
        let mut ordinary = serde_json::json!({"protocol":1,"timing":"presentation_applied","documentKey":"key","lines":[{"startMs":0,"endMs":null,"text":"普通"}]});
        assert!(parse_document(ordinary.clone(), "key", None).is_ok());
        ordinary["agents"] = serde_json::json!([]);
        assert_eq!(
            parse_document(ordinary, "key", None).unwrap_err(),
            DocumentError::Invalid
        );
    }

    #[test]
    fn admission_checks_metadata_budgets_and_presentation_zero_clamping() {
        let mut value = vocal_wire("key");
        let id = "x".repeat(128);
        value["agents"][0]["id"] = serde_json::json!(id);
        value["agents"][0]["name"] = serde_json::json!("x".repeat(128));
        value["lines"][0]["vocal"]["agentIds"] = serde_json::json!([id]);
        value["lines"][0]["endMs"] = serde_json::json!(0);
        value["lines"][0]["words"] = serde_json::json!([{"startMs":0,"endMs":0,"text":"长句"}]);
        value["lines"][1]["startMs"] = serde_json::json!(86_521_999);
        value["lines"][1]["endMs"] = serde_json::json!(86_522_000);
        value["lines"][1]["words"] =
            serde_json::json!([{"startMs":86_521_999,"endMs":86_522_000,"text":"短句"}]);
        value["offsetMs"] = serde_json::json!(122_000);
        assert!(parse_document(value.clone(), "key", Some(1)).is_ok());
        value["agents"][0]["id"] = serde_json::json!("x".repeat(129));
        assert_eq!(
            parse_document(value, "key", Some(1)).unwrap_err(),
            DocumentError::Invalid
        );
        let mut value = vocal_wire("key");
        value["agents"] = serde_json::Value::Array(
            (0..32)
                .map(|i| serde_json::json!({"id":format!("a{i}"),"kind":"other"}))
                .collect(),
        );
        value["lines"][0]["vocal"]["agentIds"] =
            serde_json::json!((0..8).map(|i| format!("a{i}")).collect::<Vec<_>>());
        value["lines"][1]["vocal"]["agentIds"] = serde_json::json!(["a31"]);
        assert!(parse_document(value.clone(), "key", Some(1)).is_ok());
        let mut nine = value.clone();
        nine["lines"][0]["vocal"]["agentIds"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!("a8"));
        assert_eq!(
            parse_document(nine, "key", Some(1)).unwrap_err(),
            DocumentError::Invalid
        );
        value["agents"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"id":"a32","kind":"other"}));
        assert_eq!(
            parse_document(value, "key", Some(1)).unwrap_err(),
            DocumentError::Invalid
        );
    }

    #[test]
    fn vocal_zero_intervals_are_bounded_to_the_global_shift_for_all_rows_and_words() {
        for annotated in [true, false] {
            for time in [0, 2_000, 2_001] {
                let mut line_case = vocal_wire("key");
                line_case["lines"][0]["endMs"] = serde_json::json!(0);
                line_case["lines"][1]["startMs"] = serde_json::json!(time);
                line_case["lines"][1]["endMs"] = serde_json::json!(time);
                if !annotated {
                    line_case["lines"][1]
                        .as_object_mut()
                        .unwrap()
                        .remove("vocal");
                }
                assert_eq!(
                    parse_document(line_case, "key", Some(1)).is_ok(),
                    time <= 2_000,
                    "zero row at {time}, annotated={annotated}",
                );
                let mut word_case = vocal_wire("key");
                word_case["lines"][0]["endMs"] = serde_json::json!(0);
                word_case["lines"][1]["startMs"] = serde_json::json!(time);
                word_case["lines"][1]["endMs"] = serde_json::json!(time + 1);
                word_case["lines"][1]["words"] =
                    serde_json::json!([{"startMs":time,"endMs":time,"text":"短句"}]);
                if !annotated {
                    word_case["lines"][1]
                        .as_object_mut()
                        .unwrap()
                        .remove("vocal");
                }
                assert_eq!(
                    parse_document(word_case, "key", Some(1)).is_ok(),
                    time <= 2_000,
                    "zero word at {time} in positive row, annotated={annotated}",
                );
            }
        }
        // Ordinary LRC retains its existing zero-length line/word behavior throughout the bound.
        let ordinary = serde_json::json!({"protocol":1,"timing":"presentation_applied","documentKey":"key",
            "lines":[{"startMs":86_522_000,"endMs":86_522_000,"text":"旧 LRC",
                "words":[{"startMs":86_522_000,"endMs":86_522_000,"text":"旧 LRC"}]}]});
        assert!(parse_document(ordinary, "key", None).is_ok());
    }

    #[test]
    fn invalid_document_is_not_repeatedly_downloaded_and_capability_changes_retry() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let directory =
            std::env::temp_dir().join(format!("hertz-vocal-feed-{}-{port}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("vmusicd.json"),
            serde_json::to_vec(&serde_json::json!({
                "pid":1,"port":port,"version":"test","protocol_version":1,"edition":"full",
                "server_instance_id":"session","desktop_lyrics_protocol":1
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(directory.join("desktop-lyrics-key"), "a".repeat(64)).unwrap();
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            let mut snapshots = 0;
            let mut documents = 0;
            let mut requests = Vec::new();
            while snapshots < 8 || documents < 5 {
                let (mut socket, _) = loop {
                    match listener.accept() {
                        Ok(socket) => break socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                std::time::Instant::now() < deadline,
                                "HTTP vocal fixture timed out"
                            );
                            std::thread::sleep(std::time::Duration::from_millis(5));
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                // Windows inherits the listener's nonblocking mode on accept.
                // The fixture uses bounded blocking reads after accepting.
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = [0; 4096];
                let n = socket.read(&mut bytes).unwrap();
                let request = String::from_utf8_lossy(&bytes[..n]);
                let key = if snapshots < 4 { "same-key" } else { "new-key" };
                let body = if request.starts_with("GET /v1/desktop-lyrics/document") {
                    documents += 1;
                    requests.push(request.lines().next().unwrap().to_owned());
                    match documents {
                        1 => {
                            let mut body = vocal_wire(key);
                            body["vocalSchemaVersion"] = serde_json::json!(99);
                            body
                        }
                        3 => {
                            serde_json::json!({"protocol":1,"timing":"presentation_applied","documentKey":key,"lines":[]})
                        }
                        4 => {
                            let mut body = vocal_wire(key);
                            body["lines"][0]["vocal"] = serde_json::json!(null);
                            body
                        }
                        _ => vocal_wire(key),
                    }
                } else {
                    snapshots += 1;
                    let mut body = serde_json::json!({"protocol":1,"seq":snapshots,"server":{"session":"session","edition":"full","version":"test"},
                        "generation":"1","positionMs":0,"playing":false,"buffering":false,"timing":"presentation_applied",
                        "track":{"id":"track","title":"test"},"lyrics":{"status":"ready","documentKey":if snapshots < 4 {"same-key"} else {"new-key"}}});
                    if snapshots != 5 {
                        body["vocalSchemaVersions"] = serde_json::json!([1]);
                    }
                    body
                };
                let body = body.to_string();
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
            requests
        });
        let profile = crate::config::standalone(directory.clone(), "full");
        let mut feed = Feed::new(profile.clone()).unwrap();
        for _ in 0..3 {
            let update = feed.poll().unwrap();
            assert!(update.document.is_none());
            assert_eq!(update.snapshot.lyrics.status, "unsupported");
        }
        assert!(feed.poll().unwrap().document.is_some()); // A new key retries.
        assert_eq!(
            feed.poll().unwrap().document.unwrap().vocal_schema_version,
            None
        ); // Old source request.
        for _ in 0..2 {
            let update = feed.poll().unwrap();
            assert!(update.document.is_none());
            assert_eq!(update.snapshot.lyrics.status, "invalid");
        }
        let mut reconnected = Feed::new(profile).unwrap();
        assert!(reconnected.poll().unwrap().document.is_some());
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 5);
        for (index, request) in requests.iter().enumerate() {
            assert_eq!(request.contains("vocalSchemaVersion=1"), index != 2);
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn custom_profile_controls_reach_bound_service_without_weakening_session_checks() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let directory =
            std::env::temp_dir().join(format!("hertz-control-{}-{port}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("vmusicd.json"),
            serde_json::to_vec(&serde_json::json!({
                "pid":1,"port":port,"version":"test","protocol_version":1,
                "edition":"full","server_instance_id":"session","desktop_lyrics_protocol":1
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(directory.join("desktop-lyrics-key"), "a".repeat(64)).unwrap();
        let custom = crate::config::standalone(directory.clone(), "custom");
        let payload = serde_json::json!({"session":"session","trackId":"track","generation":"1","action":"play"});
        assert!(control(&custom, &serde_json::json!({"session":"stale"})).is_err());
        assert!(control(
            &crate::config::standalone(directory.clone(), "standard"),
            &payload
        )
        .is_err());
        let discovery_path = directory.join("vmusicd.json");
        let discovery_bytes = std::fs::read(&discovery_path).unwrap();
        let mut missing_session: serde_json::Value =
            serde_json::from_slice(&discovery_bytes).unwrap();
        missing_session
            .as_object_mut()
            .unwrap()
            .remove("server_instance_id");
        std::fs::write(
            &discovery_path,
            serde_json::to_vec(&missing_session).unwrap(),
        )
        .unwrap();
        assert!(control(&custom, &serde_json::json!({"action":"play"})).is_err());
        missing_session["server_instance_id"] = serde_json::json!("");
        std::fs::write(
            &discovery_path,
            serde_json::to_vec(&missing_session).unwrap(),
        )
        .unwrap();
        assert!(control(&custom, &serde_json::json!({"session":"","action":"play"})).is_err());
        std::fs::write(&discovery_path, discovery_bytes).unwrap();
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            loop {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        socket.set_nonblocking(false).unwrap();
                        socket
                            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                            .unwrap();
                        let mut bytes = [0; 4096];
                        let count = socket.read(&mut bytes).unwrap();
                        let request = String::from_utf8_lossy(&bytes[..count]).to_string();
                        write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{{\"ok\":true}}").unwrap();
                        return request;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "no control request reached the bound service"
                        );
                        std::thread::sleep(std::time::Duration::from_millis(20));
                    }
                    Err(error) => panic!("{error}"),
                }
            }
        });
        let result = control(&custom, &payload);
        let request = server.join().unwrap();
        result.unwrap();
        assert!(request.starts_with("POST /v1/desktop-lyrics/control HTTP/1.1"));
        assert!(request
            .to_lowercase()
            .contains(&format!("authorization: desktop {}", "a".repeat(64))));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn same_key_document_is_replayed_after_failure_and_duplicate_track_change() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let directory =
            std::env::temp_dir().join(format!("hertz-feed-{}-{}", std::process::id(), port));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("vmusicd.json"),
            serde_json::to_vec(&serde_json::json!({
                "pid":1,"port":port,"version":"test","protocol_version":1,
                "edition":"full","server_instance_id":"session","desktop_lyrics_protocol":1
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(directory.join("desktop-lyrics-key"), "a".repeat(64)).unwrap();
        let server = std::thread::spawn(move || {
            let mut snapshots = 0;
            let mut documents = 0;
            for _ in 0..5 {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                    .unwrap();
                let mut request = [0; 4096];
                let count = socket.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..count]);
                let (status, body) = if request.starts_with("GET /v1/desktop-lyrics/document") {
                    documents += 1;
                    (
                        "200 OK",
                        serde_json::json!({"protocol":1,"timing":"presentation_applied","documentKey":"same-key","lines":[]}),
                    )
                } else {
                    snapshots += 1;
                    if snapshots == 2 {
                        ("503 Service Unavailable", serde_json::json!({}))
                    } else {
                        (
                            "200 OK",
                            serde_json::json!({"protocol":1,"seq":snapshots,"server":{"session":"session","edition":"full","version":"test"},
                        "generation":"1","positionMs":0,"playing":false,"buffering":false,"timing":"presentation_applied",
                        "track":{"id":if snapshots == 4 {"duplicate"} else {"first"},"title":"test"},
                        "lyrics":{"status":"ready","documentKey":"same-key"}}),
                        )
                    }
                };
                let body = body.to_string();
                write!(
                    socket,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
            documents
        });
        let mut feed = Feed::new(Profile::Standalone {
            edition: "full".into(),
            data_dir: directory.to_string_lossy().into_owned(),
        })
        .unwrap();
        assert!(feed.poll().unwrap().document.is_some());
        assert!(feed.poll().is_err());
        assert!(feed.poll().unwrap().document.is_some());
        let duplicate = feed.poll().unwrap();
        assert_eq!(duplicate.snapshot.track.unwrap().id, "duplicate");
        assert!(duplicate.document.is_some());
        assert_eq!(
            server.join().unwrap(),
            1,
            "cached documents should not require repeated GETs"
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
