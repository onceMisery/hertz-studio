// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 桌面歌词只读桥。
//!
//! 与 OBS 浮层共用「服务端解析 + 偏移只应用一次」的语义，但窗口不同：
//! OBS 500 ms 轮询一个会重传整份歌词的端点；桌面歌词把轻量快照与完整文档
//! 分开，快照永远不等取词（文件/网络 I/O 在后台任务里完成），文档按内容
//! 标识 `documentKey` 只取一次。
//!
//! 这里不新增播放 owner、不连主 `/ws`、不增加页面观众计数：位置、代际与
//! buffering 都直接投影原 `AudioHandle` / `AppState` 的当前真值。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::error::ApiError;
use crate::state::AppState;

/// 桌面歌词数据协议。与服务的 `PROTOCOL_VERSION` 独立演进。
pub(crate) const PROTOCOL: u32 = 1;
/// 单份已校准文档的上限。超限不截断时间轴，直接报告 `too_large`。
pub(crate) const DOCUMENT_MAX_BYTES: usize = 2 * 1024 * 1024;
/// 取词失败后的退避上限。
const ERROR_BACKOFF_MAX: Duration = Duration::from_secs(30);

/// 每次服务启动的桌面歌词会话状态。缓存只有一槽：当前曲目/修订/偏移组合。
#[derive(Default)]
pub(crate) struct DesktopLyrics {
    seq: AtomicU64,
    cache: tokio::sync::Mutex<Cache>,
}

#[derive(Default)]
struct Cache {
    /// 最近一次成功构建的文档（含空文档/超限结论）。
    document: Option<CachedDocument>,
    /// 正在取词的身份；同一身份不重复起任务。
    loading: Option<String>,
    /// 失败退避；身份变化立即作废。
    retry: Option<Retry>,
    /// 当前身份连续失败次数，仅由退避使用。
    failures: u32,
}

struct CachedDocument {
    identity: String,
    state: DocumentState,
    key: Option<String>,
    body: Option<Value>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DocumentState {
    Ready,
    Empty,
    TooLarge,
}

impl DocumentState {
    fn status(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Empty => "empty",
            Self::TooLarge => "too_large",
        }
    }
}

struct Retry {
    identity: String,
    at: Instant,
}

impl DesktopLyrics {
    fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::Relaxed) + 1
    }
}

/// 桌面歌词快照：轻量、可 500 ms 轮询，绝不等待取词。
pub(crate) async fn snapshot(state: &Arc<AppState>) -> Value {
    let seq = state.desktop_lyrics.next_seq();
    let player = state.audio.snapshot();
    let (buffering, buffering_percent) = *state.buffering.lock().await;
    let global_offset = global_lyric_offset(state).await;

    let Some(track_id) = player.track_id.clone() else {
        return snapshot_json(
            state,
            SnapshotView {
                seq,
                player: &player,
                buffering,
                buffering_percent,
                track: None,
                lyric_status: "idle",
                document_key: None,
            },
        );
    };

    let (track, revision, user_offset, load) = match crate::online::split_virtual_id(&track_id) {
        Some((source, ref_id)) => {
            let meta = state.online_meta.lock().await.get(&track_id).cloned();
            let user_offset = crate::routes::lyrics_user_offset(state, &track_id).await;
            let track = json!({
                "id": track_id,
                "title": meta.as_ref().map(|m| m.title.clone()).unwrap_or_else(|| ref_id.clone()),
                "artist": meta.as_ref().and_then(|m| m.artist.clone()),
                "album": meta.as_ref().and_then(|m| m.album.clone()),
                "durationMs": player.duration_ms.or_else(|| meta.as_ref().and_then(|m| m.duration_ms)),
                "online": true,
            });
            (
                track,
                "online".to_string(),
                user_offset,
                LoadSpec::Online { source, ref_id },
            )
        }
        None => {
            let Ok(Some(track)) = vmusic_store::get_track(&state.db, &track_id).await else {
                return snapshot_json(
                    state,
                    SnapshotView {
                        seq,
                        player: &player,
                        buffering,
                        buffering_percent,
                        track: None,
                        lyric_status: "idle",
                        document_key: None,
                    },
                );
            };
            let saved = vmusic_store::lyrics::snapshot(&state.db, &track.id)
                .await
                .unwrap_or(vmusic_store::lyrics::Snapshot {
                    content: None,
                    offset_ms: 0,
                    revision: 0,
                });
            let revision = local_revision(&track, saved.content.as_deref(), saved.revision);
            let user_offset = saved.offset_ms;
            let track_json = json!({
                "id": track.id,
                "title": track.title,
                "artist": track.artist,
                "album": track.album,
                "durationMs": player.duration_ms.or(track.duration_ms),
                "online": false,
            });
            (
                track_json,
                revision,
                user_offset,
                LoadSpec::Local {
                    track,
                    content: saved.content,
                },
            )
        }
    };

    let identity = identity_token(&track_id, &revision, user_offset, global_offset);
    let (status, key) =
        resolve_document(state, identity.clone(), load, user_offset, global_offset).await;
    snapshot_json(
        state,
        SnapshotView {
            seq,
            player: &player,
            buffering,
            buffering_percent,
            track: Some(track),
            lyric_status: status,
            document_key: key,
        },
    )
}

/// 按内容标识取一份完整文档；key 不属于当前文档时返回 409，不返回另一首歌词。
pub(crate) async fn document(state: &AppState, key: &str) -> Result<Value, ApiError> {
    if key.is_empty() || key.len() > 128 {
        return Err(stale_document());
    }
    let cache = state.desktop_lyrics.cache.lock().await;
    match cache.document.as_ref() {
        Some(document)
            if document.state == DocumentState::Ready && document.key.as_deref() == Some(key) =>
        {
            document.body.clone().ok_or_else(stale_document)
        }
        _ => Err(stale_document()),
    }
}

fn stale_document() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "stale_document",
        "documentKey 已失效，请重新读取快照",
    )
}

async fn global_lyric_offset(state: &AppState) -> i64 {
    vmusic_store::settings::get(&state.db, "global_lyric_offset_ms")
        .await
        .ok()
        .flatten()
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
        .clamp(-2000, 2000)
}

/// 本地曲的「源内容版本」：手动导入看修订，内嵌/sidecar 看文件时间戳。
fn local_revision(track: &vmusic_core::Track, content: Option<&str>, revision: i64) -> String {
    if content.is_some_and(|text| !text.trim().is_empty()) {
        return format!("imported:{revision}");
    }
    let embedded = track.file_mtime.unwrap_or(0);
    let sidecar = vmusic_library::find_sidecar_lyrics(std::path::Path::new(&track.path))
        .and_then(|path| std::fs::metadata(path).ok())
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|age| age.as_millis() as i64)
        .unwrap_or(0);
    format!("file:{embedded}:{sidecar}")
}

fn identity_token(track_id: &str, revision: &str, user_offset: i64, global_offset: i64) -> String {
    format!("{track_id}\u{1f}{revision}\u{1f}{user_offset}\u{1f}{global_offset}")
}

#[derive(Clone)]
enum LoadSpec {
    Local {
        track: vmusic_core::Track,
        content: Option<String>,
    },
    Online {
        source: String,
        ref_id: String,
    },
}

async fn resolve_document(
    state: &Arc<AppState>,
    identity: String,
    load: LoadSpec,
    user_offset: i64,
    global_offset: i64,
) -> (&'static str, Option<String>) {
    let mut cache = state.desktop_lyrics.cache.lock().await;
    if let Some(document) = cache.document.as_ref() {
        if document.identity == identity {
            return (document.state.status(), document.key.clone());
        }
    }
    let now = Instant::now();
    if cache
        .retry
        .as_ref()
        .is_some_and(|retry| retry.identity != identity)
    {
        cache.failures = 0;
        cache.retry = None;
    }
    if let Some(retry) = cache.retry.as_ref() {
        if retry.identity == identity && retry.at > now {
            return ("error", None);
        }
    }
    if cache.loading.as_deref() == Some(identity.as_str()) {
        return ("loading", None);
    }
    cache.loading = Some(identity.clone());
    drop(cache);
    let state = Arc::clone(state);
    tokio::spawn(async move {
        finish_load(state, identity, load, user_offset, global_offset).await;
    });
    ("loading", None)
}

async fn finish_load(
    state: Arc<AppState>,
    identity: String,
    load: LoadSpec,
    user_offset: i64,
    global_offset: i64,
) {
    let result = build_document(&state, load, user_offset, global_offset).await;
    let mut cache = state.desktop_lyrics.cache.lock().await;
    if cache.loading.as_deref() == Some(identity.as_str()) {
        cache.loading = None;
    }
    match result {
        Ok(document) => {
            cache.failures = 0;
            cache.retry = None;
            cache.document = Some(CachedDocument {
                identity,
                state: document.state,
                key: document.key,
                body: document.body,
            });
        }
        Err(error) => {
            tracing::debug!(error = %error, "desktop lyrics document load failed");
            cache.failures = cache.failures.saturating_add(1);
            let backoff = Duration::from_secs(1 << cache.failures.min(5)).min(ERROR_BACKOFF_MAX);
            cache.retry = Some(Retry {
                identity,
                at: Instant::now() + backoff,
            });
        }
    }
}

struct BuiltDocument {
    state: DocumentState,
    key: Option<String>,
    body: Option<Value>,
}

async fn build_document(
    state: &AppState,
    load: LoadSpec,
    user_offset: i64,
    global_offset: i64,
) -> Result<BuiltDocument, String> {
    let mut doc = match load {
        LoadSpec::Local { track, content } => {
            crate::lyrics::raw_local(&track, content.as_deref()).await
        }
        LoadSpec::Online { source, ref_id } => {
            crate::online::lyric(&crate::routes::online_ctx(state), &source, &ref_id)
                .await
                .map_err(|error| error.message)?
        }
    };
    // 与 Stage/OBS 同一顺序：文件 + 每曲偏移先合成，再应用全局呈现偏移。
    doc.offset_ms = doc.offset_ms.saturating_add(user_offset);
    vmusic_lyrics::apply_presentation_offset(&mut doc, global_offset);

    if doc.lines.iter().all(|line| line.text.trim().is_empty()) {
        return Ok(BuiltDocument {
            state: DocumentState::Empty,
            key: None,
            body: None,
        });
    }

    let mut body = document_body(&doc);
    let bytes = serde_json::to_vec(&body)
        .map_err(|error| error.to_string())?
        .len();
    if bytes > DOCUMENT_MAX_BYTES {
        return Ok(BuiltDocument {
            state: DocumentState::TooLarge,
            key: None,
            body: None,
        });
    }
    let key = document_key(&body);
    body["documentKey"] = Value::String(key.clone());
    Ok(BuiltDocument {
        state: DocumentState::Ready,
        key: Some(key),
        body: Some(body),
    })
}

fn document_body(doc: &vmusic_core::LyricDocument) -> Value {
    let translation = doc.translation.as_deref();
    let romanization = doc.romanization.as_deref();
    let lines: Vec<Value> = doc
        .lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            let mut out = Map::new();
            out.insert("startMs".into(), Value::from(line.start_ms));
            out.insert(
                "endMs".into(),
                line.end_ms.map(Value::from).unwrap_or(Value::Null),
            );
            out.insert("text".into(), Value::String(line.text.clone()));
            out.insert(
                "words".into(),
                Value::Array(
                    line.words
                        .iter()
                        .map(|word| {
                            json!({
                                "startMs": word.start_ms,
                                "endMs": word.end_ms,
                                "text": word.text,
                            })
                        })
                        .collect(),
                ),
            );
            if let Some(text) = translation
                .and_then(|values| values.get(index))
                .filter(|text| !text.trim().is_empty())
            {
                out.insert("translation".into(), Value::String(text.clone()));
            }
            if let Some(text) = romanization
                .and_then(|values| values.get(index))
                .filter(|text| !text.trim().is_empty())
            {
                out.insert("romanization".into(), Value::String(text.clone()));
            }
            Value::Object(out)
        })
        .collect();

    let mut body = json!({
        "protocol": PROTOCOL,
        "timing": "presentation_applied",
        "offsetMs": doc.offset_ms,
        "format": doc.format,
        "timingPrecision": doc.timing_precision,
        "source": doc.source,
        "lines": lines,
    });
    if let Some(origin) = &doc.origin {
        body["origin"] = serde_json::to_value(origin).unwrap_or(Value::Null);
    }
    body
}

fn document_key(body: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"hertz-desktop-lyrics-v1\0");
    hasher.update(serde_json::to_vec(body).unwrap_or_default());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

struct SnapshotView<'a> {
    seq: u64,
    player: &'a vmusic_core::PlayerSnapshot,
    buffering: bool,
    buffering_percent: Option<u8>,
    track: Option<Value>,
    lyric_status: &'static str,
    document_key: Option<String>,
}

fn snapshot_json(state: &AppState, view: SnapshotView<'_>) -> Value {
    json!({
        "protocol": PROTOCOL,
        "seq": view.seq,
        "server": {
            "session": state.server_instance_id(),
            "edition": crate::edition::NAME,
            "version": env!("CARGO_PKG_VERSION"),
        },
        "generation": view.player.generation.to_string(),
        "positionMs": view.player.position_ms,
        "durationMs": view.player.duration_ms,
        "playing": view.player.playing,
        "buffering": view.buffering,
        "bufferingPercent": view.buffering_percent,
        "track": view.track,
        "lyrics": {
            "status": view.lyric_status,
            "documentKey": view.document_key,
        },
        "timing": "presentation_applied",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(start: u64, end: Option<u64>, text: &str) -> vmusic_core::LyricLine {
        vmusic_core::LyricLine {
            start_ms: start,
            end_ms: end,
            text: text.into(),
            words: Vec::new(),
        }
    }

    fn document(offset: i64, lines: Vec<vmusic_core::LyricLine>) -> vmusic_core::LyricDocument {
        vmusic_core::LyricDocument {
            source: vmusic_core::LyricSource::Imported,
            offset_ms: offset,
            lines,
            translation: None,
            format: Some("lrc".into()),
            timing_precision: Some("line".into()),
            romanization: None,
            origin: None,
        }
    }

    #[test]
    fn document_uses_presentation_applied_milliseconds_once() {
        let mut doc = document(0, vec![line(1_000, Some(2_000), "a")]);
        doc.offset_ms = 500;
        vmusic_lyrics::apply_presentation_offset(&mut doc, -200);
        let body = document_body(&doc);
        assert_eq!(body["timing"], "presentation_applied");
        assert_eq!(body["offsetMs"], 300);
        assert_eq!(body["lines"][0]["startMs"], 1_300);
        assert_eq!(body["lines"][0]["endMs"], 2_300);
        assert!(body["lines"][0].get("startTime").is_none());
    }

    #[test]
    fn document_key_changes_with_time_shift() {
        let first = document_body(&document(0, vec![line(1_000, Some(2_000), "a")]));
        let second = document_body(&document(250, vec![line(1_250, Some(2_250), "a")]));
        assert_ne!(document_key(&first), document_key(&second));
    }

    #[test]
    fn identity_separates_revision_and_offsets() {
        let base = identity_token("track", "imported:1", 0, 0);
        assert_ne!(base, identity_token("track", "imported:2", 0, 0));
        assert_ne!(base, identity_token("track", "imported:1", 250, 0));
        assert_ne!(base, identity_token("track", "imported:1", 0, 250));
    }

    #[tokio::test]
    async fn idle_snapshot_keeps_protocol_and_never_waits_for_lyrics() {
        let (state, handle) = crate::state::tests::playback_state().await;
        let state = Arc::new(state);
        let value = snapshot(&state).await;
        assert_eq!(value["protocol"], PROTOCOL);
        assert_eq!(value["timing"], "presentation_applied");
        assert_eq!(value["track"], Value::Null);
        assert_eq!(value["lyrics"]["status"], "idle");
        assert_eq!(value["lyrics"]["documentKey"], Value::Null);
        assert_eq!(value["playing"], false);
        assert!(value["seq"].as_u64().unwrap() >= 1);
        assert_eq!(value["server"]["session"], state.server_instance_id());
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn unknown_document_key_is_a_conflict_not_another_track() {
        let (state, handle) = crate::state::tests::playback_state().await;
        let error = super::document(&state, "0123456789abcdef")
            .await
            .unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(error.code, "stale_document");
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[test]
    fn imported_revision_wins_over_file_stamps() {
        let track = vmusic_core::Track {
            id: "t".into(),
            path: "missing.mp3".into(),
            source: vmusic_core::TrackSource::Local,
            title: "t".into(),
            artist: None,
            album: None,
            duration_ms: None,
            bitrate: None,
            sample_rate: None,
            channels: None,
            has_cover: false,
            file_mtime: Some(7),
            file_size: None,
            added_at: 0,
        };
        assert_eq!(local_revision(&track, Some("text"), 3), "imported:3");
        assert!(local_revision(&track, None, 3).starts_with("file:7:"));
    }
}
