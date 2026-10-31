// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 桌面歌词数据桥；显式窄播控路由复用 AppState 的播放控制入口。
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
const REVISION_INTERVAL: Duration = Duration::from_secs(2);

/// 每次服务启动的桌面歌词会话状态。缓存只有一槽：当前曲目/修订/偏移组合。
#[derive(Default)]
pub(crate) struct DesktopLyrics {
    seq: AtomicU64,
    cache: tokio::sync::Mutex<Cache>,
    file_revision: Arc<tokio::sync::Mutex<Option<FileRevision>>>,
}

struct FileRevision {
    path: String,
    generation: Arc<()>,
    stamp: i64,
    checked: Instant,
    checking: bool,
}

#[derive(Default)]
struct Cache {
    identity: Option<String>,
    snapshot_seq: u64,
    load_serial: u64,
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
            let revision = local_revision(
                &state.desktop_lyrics,
                &track,
                saved.content.as_deref(),
                saved.revision,
            )
            .await;
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
    let (status, key) = resolve_document(
        state,
        seq,
        identity.clone(),
        load,
        user_offset,
        global_offset,
    )
    .await;
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
    let identity = current_identity(state).await.ok_or_else(stale_document)?;
    let cache = state.desktop_lyrics.cache.lock().await;
    match cache.document.as_ref() {
        Some(document)
            if document.identity == identity
                && document.state == DocumentState::Ready
                && document.key.as_deref() == Some(key) =>
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
async fn local_revision(
    lyrics: &DesktopLyrics,
    track: &vmusic_core::Track,
    content: Option<&str>,
    revision: i64,
) -> String {
    if content.is_some_and(|text| !text.trim().is_empty()) {
        return format!("imported:{revision}");
    }
    let embedded = track.file_mtime.unwrap_or(0);
    let mut slot = lyrics.file_revision.lock().await;
    let entry = slot.get_or_insert_with(|| FileRevision {
        path: track.path.clone(),
        generation: Arc::new(()),
        stamp: 0,
        checked: Instant::now() - REVISION_INTERVAL,
        checking: false,
    });
    if entry.path != track.path {
        *entry = FileRevision {
            path: track.path.clone(),
            generation: Arc::new(()),
            stamp: 0,
            checked: Instant::now() - REVISION_INTERVAL,
            checking: false,
        };
    }
    if !entry.checking && entry.checked.elapsed() >= REVISION_INTERVAL {
        entry.checking = true;
        let path = entry.path.clone();
        let generation = entry.generation.clone();
        let cache = lyrics.file_revision.clone();
        tokio::spawn(async move {
            let work_path = path.clone();
            let stamp = tokio::task::spawn_blocking(move || sidecar_stamp(&work_path))
                .await
                .unwrap_or(0);
            let mut slot = cache.lock().await;
            if let Some(entry) = slot
                .as_mut()
                .filter(|entry| Arc::ptr_eq(&entry.generation, &generation))
            {
                entry.stamp = stamp;
                entry.checked = Instant::now();
                entry.checking = false;
            }
        });
    }
    format!("file:{embedded}:{}", entry.stamp)
}

fn sidecar_stamp(path: &str) -> i64 {
    vmusic_library::find_sidecar_lyrics(std::path::Path::new(path))
        .and_then(|path| std::fs::metadata(path).ok())
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|age| age.as_millis() as i64)
        .unwrap_or(0)
}

async fn current_identity(state: &AppState) -> Option<String> {
    let track_id = state.audio.snapshot().track_id?;
    let global_offset = global_lyric_offset(state).await;
    let (revision, offset) = if crate::online::split_virtual_id(&track_id).is_some() {
        (
            "online".to_string(),
            crate::routes::lyrics_user_offset(state, &track_id).await,
        )
    } else {
        let track = vmusic_store::get_track(&state.db, &track_id).await.ok()??;
        let saved = vmusic_store::lyrics::snapshot(&state.db, &track_id)
            .await
            .ok()?;
        (
            local_revision(
                &state.desktop_lyrics,
                &track,
                saved.content.as_deref(),
                saved.revision,
            )
            .await,
            saved.offset_ms,
        )
    };
    if state.audio.snapshot().track_id.as_deref() != Some(track_id.as_str()) {
        return None;
    }
    Some(identity_token(&track_id, &revision, offset, global_offset))
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
    seq: u64,
    identity: String,
    load: LoadSpec,
    user_offset: i64,
    global_offset: i64,
) -> (&'static str, Option<String>) {
    let mut cache = state.desktop_lyrics.cache.lock().await;
    if seq < cache.snapshot_seq {
        return ("loading", None);
    }
    cache.snapshot_seq = seq;
    if cache.identity.as_deref() != Some(&identity) {
        cache.identity = Some(identity.clone());
        cache.document = None;
        cache.loading = None;
        cache.retry = None;
        cache.failures = 0;
    }
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
    cache.load_serial += 1;
    let serial = cache.load_serial;
    drop(cache);
    let state = Arc::clone(state);
    tokio::spawn(async move {
        finish_load(state, serial, identity, load, user_offset, global_offset).await;
    });
    ("loading", None)
}

async fn finish_load(
    state: Arc<AppState>,
    serial: u64,
    identity: String,
    load: LoadSpec,
    user_offset: i64,
    global_offset: i64,
) {
    let result = build_document(&state, load, user_offset, global_offset).await;
    let mut cache = state.desktop_lyrics.cache.lock().await;
    cache.finish(serial, identity, result);
}

impl Cache {
    fn finish(&mut self, serial: u64, identity: String, result: Result<BuiltDocument, String>) {
        let cache = self;
        if cache.load_serial != serial || cache.identity.as_deref() != Some(&identity) {
            return;
        }
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
                let backoff =
                    Duration::from_secs(1 << cache.failures.min(5)).min(ERROR_BACKOFF_MAX);
                cache.retry = Some(Retry {
                    identity,
                    at: Instant::now() + backoff,
                });
            }
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
            let result = if let Some(content) = content.as_deref().filter(|s| !s.trim().is_empty())
            {
                match crate::lyrics::parse_saved_checked(content) {
                    // Keep legacy LRC tolerance and empty/malformed handling; only
                    // resource limit errors need a different desktop status.
                    Err(error) if error.code != "lyrics_limit" => {
                        Ok(crate::lyrics::parse_saved(content))
                    }
                    result => result,
                }
            } else {
                crate::routes::read_embedded_or_sidecar_lyrics_checked(std::path::Path::new(
                    &track.path,
                ))
                .await
                .map_err(|error| {
                    ApiError::new(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        if matches!(error, vmusic_lyrics::ImportError::Limit) {
                            "lyrics_limit"
                        } else {
                            "lyrics_invalid"
                        },
                        error.to_string(),
                    )
                })
            };
            match result {
                Ok(mut doc) => {
                    if content.is_some() {
                        doc.source = vmusic_core::LyricSource::Imported;
                    }
                    doc
                }
                Err(error) if error.code == "lyrics_limit" => {
                    return Ok(BuiltDocument {
                        state: DocumentState::TooLarge,
                        key: None,
                        body: None,
                    })
                }
                Err(error) => return Err(error.message),
            }
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

    async fn schema_state() -> (AppState, std::thread::JoinHandle<()>, std::path::PathBuf) {
        let directory =
            std::env::temp_dir().join(format!("hertz-desktop-lyrics-{}", uuid::Uuid::new_v4()));
        let db = vmusic_store::open(&directory).await.unwrap();
        let (state, audio) = crate::state::tests::playback_state_with_db(db).await;
        (state, audio, directory)
    }

    async fn close_schema_state(
        state: impl std::borrow::Borrow<AppState>,
        directory: std::path::PathBuf,
    ) {
        let db = state.borrow().db.clone();
        db.close().await;
        // SQLx can report the pool closed while a return task still closes its SQLite
        // worker. Wait for actual pool accounting before deleting Windows DB files.
        tokio::time::timeout(Duration::from_secs(2), async {
            while db.size() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("SQLite connections must be released before fixture removal");
        drop(state);
        std::fs::remove_dir_all(directory).unwrap();
    }

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

    #[tokio::test]
    async fn desktop_seek_only_accepts_current_nonempty_phrase_starts() {
        let (mut state, handle, directory) = schema_state().await;
        state.desktop_lyrics_key = "b".repeat(64);
        state
            .audio
            .load("first.wav", Some("first".into()))
            .await
            .unwrap();
        sqlx::query("INSERT INTO tracks(id,path,title,added_at,updated_at) VALUES('first','first.wav','First',0,0)")
            .execute(&state.db).await.unwrap();
        let identity = current_identity(&state).await.unwrap();
        state.desktop_lyrics.cache.lock().await.document = Some(CachedDocument {
            identity,
            state: DocumentState::Ready,
            key: Some("test".into()),
            body: Some(document_body(&document(
                0,
                vec![line(1000, Some(2000), "phrase"), line(2000, None, "")],
            ))),
        });
        let state = Arc::new(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/v1/desktop-lyrics/control",
            listener.local_addr().unwrap()
        );
        let app = crate::routes::router(state.clone()).with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        for (position, status) in [(1000, 200), (1250, 400), (2000, 400)] {
            let result = client.post(&url).header("Authorization", format!("Desktop {}", state.desktop_lyrics_key))
                .json(&json!({"action":"seek", "session":state.server_instance_id(), "trackId":"first",
                    "generation":state.audio.snapshot().generation.to_string(), "documentKey":"test", "positionMs":position}))
                .send().await.unwrap();
            assert_eq!(result.status(), status, "position {position}");
        }
        assert_eq!(state.audio.snapshot().position_ms, 1000);
        server.abort();
        let _ = server.await;
        state.audio.shutdown();
        handle.join().unwrap();
        close_schema_state(state, directory).await;
    }

    #[tokio::test]
    async fn imported_revision_wins_over_file_stamps() {
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
        let lyrics = DesktopLyrics::default();
        assert_eq!(
            local_revision(&lyrics, &track, Some("text"), 3).await,
            "imported:3"
        );
        assert!(local_revision(&lyrics, &track, None, 3)
            .await
            .starts_with("file:7:"));
    }

    #[test]
    fn superseded_load_cannot_overwrite_document_or_retry() {
        let mut cache = Cache {
            identity: Some("new".into()),
            load_serial: 3,
            loading: Some("new".into()),
            ..Cache::default()
        };
        cache.finish(
            3,
            "new".into(),
            Ok(BuiltDocument {
                state: DocumentState::Ready,
                key: Some("new-key".into()),
                body: Some(json!({"new":true})),
            }),
        );
        // A -> B -> A also needs a serial check, even when the identity matches again.
        cache.finish(
            1,
            "new".into(),
            Ok(BuiltDocument {
                state: DocumentState::Empty,
                key: None,
                body: None,
            }),
        );
        cache.finish(2, "old".into(), Err("late error".into()));
        assert_eq!(
            cache.document.as_ref().unwrap().key.as_deref(),
            Some("new-key")
        );
        assert!(cache.retry.is_none());
    }

    #[tokio::test]
    async fn document_rejects_track_and_revision_changes_before_next_snapshot() {
        let (state, audio, directory) = schema_state().await;
        sqlx::query("INSERT INTO tracks(id,path,title,added_at,updated_at) VALUES('first','first.wav','First',0,0)")
            .execute(&state.db).await.unwrap();
        state
            .audio
            .load("first.wav", Some("first".into()))
            .await
            .unwrap();
        let identity = current_identity(&state).await.unwrap();
        state.desktop_lyrics.cache.lock().await.document = Some(CachedDocument {
            identity,
            state: DocumentState::Ready,
            key: Some("old-key".into()),
            body: Some(json!({"lines":[]})),
        });
        assert!(super::document(&state, "old-key").await.is_ok());
        vmusic_store::settings::set(&state.db, "global_lyric_offset_ms", &json!(250))
            .await
            .unwrap();
        assert_eq!(
            super::document(&state, "old-key").await.unwrap_err().status,
            StatusCode::CONFLICT
        );
        vmusic_store::settings::set(&state.db, "global_lyric_offset_ms", &json!(0))
            .await
            .unwrap();
        state
            .audio
            .load("second.wav", Some("second".into()))
            .await
            .unwrap();
        assert_eq!(
            super::document(&state, "old-key").await.unwrap_err().status,
            StatusCode::CONFLICT
        );
        state.audio.shutdown();
        audio.join().unwrap();
        close_schema_state(state, directory).await;
    }

    #[tokio::test]
    async fn oversized_sidecar_reports_too_large_without_unbounded_read() {
        let (state, audio, directory) = schema_state().await;
        let path = directory.join("song.wav");
        std::fs::write(
            path.with_extension("lrc"),
            "x".repeat(vmusic_lyrics::MAX_BYTES + 1),
        )
        .unwrap();
        sqlx::query(
            "INSERT INTO tracks(id,path,title,added_at,updated_at) VALUES('large',?,'Large',0,0)",
        )
        .bind(path.to_string_lossy().as_ref())
        .execute(&state.db)
        .await
        .unwrap();
        let track = vmusic_store::get_track(&state.db, &"large".into())
            .await
            .unwrap()
            .unwrap();
        let result = build_document(
            &state,
            LoadSpec::Local {
                track,
                content: None,
            },
            0,
            0,
        )
        .await
        .unwrap();
        assert!(result.state == DocumentState::TooLarge);
        state.audio.shutdown();
        audio.join().unwrap();
        close_schema_state(state, directory).await;
    }
}
