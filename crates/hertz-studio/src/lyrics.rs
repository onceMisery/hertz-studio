// SPDX-License-Identifier: MIT
//! Official lyric reads and explicit, target-bound import candidates.
use crate::{
    error::{bad_request, internal, not_found, ApiError, ApiResult},
    state::AppState,
};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock},
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
use vmusic_core::{LyricDocument, LyricSource, Track};

const TTL: Duration = Duration::from_secs(600);
const CAP: usize = 32;
static PARSERS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(2)));
pub(crate) mod candidates;

#[derive(Clone)]
enum Payload {
    Ready {
        content: Arc<str>,
        doc: Arc<LyricDocument>,
    },
    Online(candidates::Choice),
}
#[derive(Clone)]
pub(crate) struct Candidate {
    id: String,
    metadata: String,
    revision: i64,
    expires: Instant,
    automatic_apply_allowed: bool,
    payload: Payload,
}
pub(crate) type Candidates = HashMap<String, Candidate>;
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Prepare {
    expected_metadata_revision: String,
    expected_lyrics_revision: String,
    content: String,
    #[serde(default = "auto")]
    format: String,
}
fn auto() -> String {
    "auto".into()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Apply {
    candidate_id: String,
    expected_lyrics_revision: String,
    #[serde(default)]
    automatic_apply: bool,
}
fn conflict() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "lyrics_conflict",
        "曲目信息或歌词已改变，请重新检查后应用",
    )
}
fn expired() -> ApiError {
    ApiError::new(
        StatusCode::GONE,
        "lyrics_candidate_expired",
        "歌词候选已失效，请重新检查",
    )
}
fn busy() -> ApiError {
    ApiError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "lyrics_busy",
        "歌词检查或候选容量已满，请稍后再试",
    )
}
fn parse_error(error: vmusic_lyrics::ImportError) -> ApiError {
    let code = match error {
        vmusic_lyrics::ImportError::Limit => "lyrics_limit",
        vmusic_lyrics::ImportError::Unsupported => "lyrics_unsupported",
        vmusic_lyrics::ImportError::Invalid => "lyrics_invalid",
        vmusic_lyrics::ImportError::Empty => "lyrics_empty",
    };
    ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, code, error.to_string())
}
fn metadata(track: &Track) -> ApiResult<String> {
    let bytes = serde_json::to_vec(&(
        "lyric-metadata-v1",
        &track.id,
        &track.title,
        &track.artist,
        &track.album,
        track.duration_ms,
    ))
    .map_err(|_| internal("歌词元数据指纹失败"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
fn revision(text: &str) -> ApiResult<i64> {
    let value = text
        .parse::<i64>()
        .map_err(|_| bad_request("无效歌词修订"))?;
    if value < 0 || value.to_string() != text {
        return Err(bad_request("无效歌词修订"));
    }
    Ok(value)
}
pub(crate) async fn snapshot(
    state: &AppState,
    id: &str,
) -> ApiResult<(Track, vmusic_store::lyrics::Snapshot)> {
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| internal(e.to_string()))?;
    let track = vmusic_store::get_track_on(&mut tx, id)
        .await
        .map_err(vmusic_core::CoreError::from)?
        .ok_or_else(|| not_found("未找到曲库曲目"))?;
    let saved = vmusic_store::lyrics::snapshot_on(&mut tx, id)
        .await
        .map_err(vmusic_core::CoreError::from)?;
    tx.commit().await.map_err(|e| internal(e.to_string()))?;
    Ok((track, saved))
}
async fn parse(content: Arc<str>, format: String) -> ApiResult<LyricDocument> {
    if content.len() > vmusic_lyrics::MAX_BYTES {
        return Err(parse_error(vmusic_lyrics::ImportError::Limit));
    }
    let permit = PARSERS.clone().try_acquire_owned().map_err(|_| busy())?;
    let work = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        vmusic_lyrics::parse_import(&content, &format)
    });
    tokio::time::timeout(Duration::from_secs(3), work)
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::REQUEST_TIMEOUT,
                "lyrics_timeout",
                "歌词检查超时，请稍后再试",
            )
        })?
        .map_err(|_| internal("歌词解析工作失败"))?
        .map_err(parse_error)
}
/// Legacy stored LRC remains tolerant; XML is checked with no fallback to LRC.
pub(crate) fn parse_saved(content: &str) -> LyricDocument {
    if content.trim_start().starts_with('{') {
        return candidates::decode_saved(content).unwrap_or_else(|_| LyricDocument::empty());
    }
    if content
        .trim_start_matches('\u{feff}')
        .trim_start()
        .starts_with('<')
    {
        vmusic_lyrics::parse_import(content, "ttml").unwrap_or_else(|_| LyricDocument::empty())
    } else {
        vmusic_lyrics::parse_lrc(content)
    }
}
pub(crate) async fn raw_local(track: &Track, content: Option<&str>) -> LyricDocument {
    if let Some(content) = content.filter(|s| !s.trim().is_empty()) {
        let mut doc = parse_saved(content);
        doc.source = LyricSource::Imported;
        doc
    } else {
        crate::routes::read_embedded_or_sidecar_lyrics(std::path::Path::new(&track.path)).await
    }
}
pub(crate) async fn read(state: &Arc<AppState>, id: &str) -> ApiResult<Value> {
    let (track, saved) = snapshot(state, id).await?;
    let metadata = metadata(&track)?;
    let mut doc = raw_local(&track, saved.content.as_deref()).await;
    doc.offset_ms = doc.offset_ms.saturating_add(saved.offset_ms);
    vmusic_lyrics::apply_offset(&mut doc);
    let mut out = serde_json::to_value(doc).map_err(|_| internal("歌词序列化失败"))?;
    out["user_offset_ms"] = json!(saved.offset_ms);
    out["lyricsRevision"] = json!(saved.revision.to_string());
    out["metadataRevision"] = json!(metadata);
    Ok(out)
}
pub(crate) async fn prepare(state: &Arc<AppState>, id: &str, body: Prepare) -> ApiResult<Value> {
    let expected = revision(&body.expected_lyrics_revision)?;
    let (track, saved) = snapshot(state, id).await?;
    let fingerprint = metadata(&track)?;
    if fingerprint != body.expected_metadata_revision || saved.revision != expected {
        return Err(conflict());
    }
    let content: Arc<str> = body.content.into();
    let doc = Arc::new(parse(content.clone(), body.format).await?);
    let mut candidates = state.lyric_candidates.lock().await;
    let now = Instant::now();
    candidates.retain(|_, c| c.expires > now);
    if candidates.len() >= CAP {
        return Err(busy());
    }
    let candidate_id = uuid::Uuid::new_v4().to_string();
    let out = preview(&candidate_id, &doc, &fingerprint, expected, TTL);
    candidates.insert(
        candidate_id,
        Candidate {
            id: id.into(),
            metadata: fingerprint,
            revision: expected,
            expires: now + TTL,
            automatic_apply_allowed: false,
            payload: Payload::Ready { content, doc },
        },
    );
    Ok(out)
}
fn preview(
    id: &str,
    doc: &LyricDocument,
    metadata: &str,
    revision: i64,
    remaining: Duration,
) -> Value {
    json!({"candidateId":id,"source":if doc.origin.is_some(){"online-provider"}else{"local-import"},
        "origin":doc.origin,"format":doc.format,"timingPrecision":doc.timing_precision,
        "lineCount":doc.lines.len(),"wordCount":doc.lines.iter().map(|l|l.words.len()).sum::<usize>(),
        "preview":doc.lines.iter().take(3).map(|l|json!({"startMs":l.start_ms,"text":l.text.chars().take(160).collect::<String>()})).collect::<Vec<_>>(),
        "metadataRevision":metadata,"lyricsRevision":revision.to_string(),"expiresInMs":remaining.as_millis()})
}
pub(crate) async fn apply(state: &Arc<AppState>, id: &str, body: Apply) -> ApiResult<Value> {
    let expected = revision(&body.expected_lyrics_revision)?;
    let candidate = state
        .lyric_candidates
        .lock()
        .await
        .get(&body.candidate_id)
        .cloned()
        .ok_or_else(expired)?;
    if candidate.expires <= Instant::now() {
        state
            .lyric_candidates
            .lock()
            .await
            .remove(&body.candidate_id);
        return Err(expired());
    }
    if candidate.id != id || candidate.revision != expected {
        return Err(conflict());
    }
    if body.automatic_apply && !candidate.automatic_apply_allowed {
        return Err(conflict());
    }
    let Payload::Ready { content, doc } = &candidate.payload else {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "lyrics_not_prepared",
            "请先检查并预览所选歌词",
        ));
    };
    if body.automatic_apply {
        let (track, saved) = snapshot(state, id).await?;
        if saved.revision != expected || metadata(&track)? != candidate.metadata {
            return Err(conflict());
        }
        if !candidates::visible_lyrics_are_empty(&track, saved.content.is_none()).await {
            return Err(conflict());
        }
    }
    let mut tx = vmusic_store::begin_immediate(&state.db)
        .await
        .map_err(vmusic_core::CoreError::from)?;
    let track = vmusic_store::get_track_on(&mut tx, id)
        .await
        .map_err(vmusic_core::CoreError::from)?
        .ok_or_else(conflict)?;
    let current = vmusic_store::lyrics::snapshot_on(&mut tx, id)
        .await
        .map_err(vmusic_core::CoreError::from)?;
    if current.revision != expected
        || metadata(&track)? != candidate.metadata
        || (body.automatic_apply && current.content.is_some())
    {
        return Err(conflict());
    }
    if candidate.expires <= Instant::now() {
        return Err(expired());
    }
    vmusic_store::lyrics::import_on(&mut tx, id, content)
        .await
        .map_err(vmusic_core::CoreError::from)?;
    let updated = vmusic_store::lyrics::snapshot_on(&mut tx, id)
        .await
        .map_err(vmusic_core::CoreError::from)?;
    tx.commit().await.map_err(|e| internal(e.to_string()))?;
    state
        .lyric_candidates
        .lock()
        .await
        .remove(&body.candidate_id);
    *state.overlay_lyric.lock().await = None;
    Ok(
        json!({"ok":true,"source":"imported","format":doc.format,"lyricsRevision":updated.revision.to_string()}),
    )
}
pub(crate) async fn import(state: &Arc<AppState>, id: &str, content: String) -> ApiResult<Value> {
    snapshot(state, id).await?;
    let content: Arc<str> = content.into();
    parse(content.clone(), "auto".into()).await?;
    vmusic_store::lyrics::import(&state.db, id, &content)
        .await
        .map_err(vmusic_core::CoreError::from)?;
    *state.overlay_lyric.lock().await = None;
    Ok(json!({"ok":true,"source":"imported"}))
}
/// Completion may wait on a provider; never overwrite edits made during that wait.
pub(crate) async fn import_if_unchanged(
    state: &Arc<AppState>,
    track: &Track,
    saved: &vmusic_store::lyrics::Snapshot,
    content: String,
) -> ApiResult<bool> {
    let prepared = prepare(
        state,
        &track.id,
        Prepare {
            expected_metadata_revision: metadata(track)?,
            expected_lyrics_revision: saved.revision.to_string(),
            content,
            format: "lrc".into(),
        },
    )
    .await;
    let result = match prepared {
        Ok(candidate) => {
            apply(
                state,
                &track.id,
                Apply {
                    candidate_id: candidate["candidateId"]
                        .as_str()
                        .ok_or_else(|| internal("缺少歌词候选"))?
                        .into(),
                    expected_lyrics_revision: saved.revision.to_string(),
                    automatic_apply: false,
                },
            )
            .await
        }
        Err(error) => Err(error),
    };
    match result {
        Ok(_) => Ok(true),
        Err(e) if e.code == "lyrics_conflict" || e.code == "lyrics_candidate_expired" => Ok(false),
        Err(e) => Err(e),
    }
}
pub(crate) async fn clear(state: &Arc<AppState>, id: &str) -> ApiResult<Value> {
    vmusic_store::lyrics::remove(&state.db, id)
        .await
        .map_err(vmusic_core::CoreError::from)?;
    *state.overlay_lyric.lock().await = None;
    Ok(json!({"ok":true}))
}
pub(crate) async fn set_offset(state: &Arc<AppState>, id: &str, offset: i64) -> ApiResult<Value> {
    if offset.unsigned_abs() > 60_000 {
        return Err(bad_request("歌词偏移须在正负 60 秒内"));
    }
    vmusic_store::lyrics::set_offset(&state.db, id, offset)
        .await
        .map_err(vmusic_core::CoreError::from)?;
    Ok(json!({"ok":true,"offset_ms":offset}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::{anyhow, ensure, Result};

    fn checked<T>(result: ApiResult<T>) -> Result<T> {
        result.map_err(|e| anyhow!("{}: {}", e.code, e.message))
    }
    fn prepare_body(doc: &Value, content: &str) -> Prepare {
        Prepare {
            content: content.into(),
            format: "auto".into(),
            expected_metadata_revision: doc["metadataRevision"].as_str().unwrap().into(),
            expected_lyrics_revision: doc["lyricsRevision"].as_str().unwrap().into(),
        }
    }
    fn apply_body(candidate: &Value) -> Apply {
        Apply {
            candidate_id: candidate["candidateId"].as_str().unwrap().into(),
            expected_lyrics_revision: candidate["lyricsRevision"].as_str().unwrap().into(),
            automatic_apply: false,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn candidate_transactions_facades_and_stale_writers() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("hertz-lyrics-{}", uuid::Uuid::new_v4()));
        let db = vmusic_store::open(&dir).await?;
        let (mut state, audio) = crate::state::tests::playback_state_with_db(db).await;
        state.data_dir = dir.clone();
        state.token = "lyric-test-token".into();
        let state = Arc::new(state);
        let app = crate::routes::router(state.clone()).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        let server = tokio::spawn(async move { axum::serve(listener, app).await });
        let result = exercise(&state, &dir, &base).await;
        server.abort();
        let _ = server.await;
        state.audio.shutdown();
        audio.join().unwrap();
        state.db.close().await;
        drop(state);
        std::fs::remove_dir_all(&dir)?;
        result
    }

    async fn exercise(state: &Arc<AppState>, dir: &std::path::Path, base: &str) -> Result<()> {
        let track: Track = serde_json::from_value(
            json!({"id":"local","path":dir.join("absent.wav"),"source":"local","title":"Fixture","artist":null,"album":null,"duration_ms":30000,"bitrate":null,"sample_rate":44100,"channels":1,"has_cover":false,"file_mtime":null,"file_size":null,"added_at":0}),
        )?;
        vmusic_store::upsert_track(&state.db, &track).await?;
        let mut other = track.clone();
        other.id = "other".into();
        other.path = dir.join("other.wav").to_string_lossy().into();
        vmusic_store::upsert_track(&state.db, &other).await?;
        checked(set_offset(state, "local", -500).await)?;
        let start = checked(read(state, "local").await)?;
        let c = checked(
            prepare(
                state,
                "local",
                prepare_body(&start, "[offset:100]\n[00:01.00]new[00:01.50]word"),
            )
            .await,
        )?;
        ensure!(
            vmusic_store::lyrics::snapshot(&state.db, "local")
                .await?
                .content
                .as_deref()
                == Some(""),
            "prepare wrote content"
        );
        ensure!(
            apply(state, "other", apply_body(&c))
                .await
                .unwrap_err()
                .code
                == "lyrics_conflict",
            "wrong track accepted"
        );
        let (a, b) = tokio::join!(
            apply(state, "local", apply_body(&c)),
            apply(state, "local", apply_body(&c))
        );
        ensure!(
            usize::from(a.is_ok()) + usize::from(b.is_ok()) == 1,
            "concurrent apply was not exclusive"
        );
        let current = checked(read(state, "local").await)?;
        ensure!(
            current["lines"][0]["start_ms"] == 600 && current["user_offset_ms"] == -500,
            "file/user offset was lost or repeated"
        );
        ensure!(
            current["lines"][0]["words"][1]["start_ms"] == 1100,
            "word shift"
        );
        let old: LyricDocument = serde_json::from_value(
            json!({"source":"none","offset_ms":0,"lines":[],"translation":null}),
        )?;
        ensure!(
            old.format.is_none() && old.romanization.is_none() && old.timing_precision.is_none(),
            "legacy shape rejected"
        );

        for change in 0..4 {
            let baseline = checked(read(state, "local").await)?;
            let c =
                checked(prepare(state, "local", prepare_body(&baseline, "[00:01.00]stale")).await)?;
            match change {
                0 => {
                    vmusic_store::lyrics::import(&state.db, "local", "[00:01.00]manual").await?;
                }
                1 => {
                    checked(set_offset(state, "local", 100).await)?;
                }
                2 => {
                    checked(clear(state, "local").await)?;
                }
                _ => {
                    vmusic_store::track_edits::apply(
                        &state.db,
                        "local",
                        &vmusic_store::track_edits::EditInput {
                            title: Some("Edited".into()),
                            ..Default::default()
                        },
                    )
                    .await?;
                }
            }
            ensure!(
                apply(state, "local", apply_body(&c))
                    .await
                    .unwrap_err()
                    .code
                    == "lyrics_conflict",
                "stale change {change}"
            );
        }
        // Clear an absent row also invalidates outstanding work.
        let baseline = checked(read(state, "local").await)?;
        let c = checked(prepare(state, "local", prepare_body(&baseline, "[00:01.00]stale")).await)?;
        checked(clear(state, "local").await)?;
        ensure!(
            apply(state, "local", apply_body(&c))
                .await
                .unwrap_err()
                .code
                == "lyrics_conflict",
            "empty clear did not invalidate"
        );

        let (before, saved) = checked(snapshot(state, "local").await)?;
        vmusic_store::lyrics::import(&state.db, "local", "[00:01.00]manual").await?;
        ensure!(
            !checked(
                import_if_unchanged(state, &before, &saved, "[00:01.00]late provider".into()).await
            )?,
            "late completion overwrote manual import"
        );
        ensure!(
            vmusic_store::lyrics::get(&state.db, "local")
                .await?
                .unwrap()
                .content
                .contains("manual"),
            "manual lost"
        );
        let (before, saved) = checked(snapshot(state, "local").await)?;
        ensure!(
            checked(
                import_if_unchanged(
                    state,
                    &before,
                    &saved,
                    "[offset:250]\n[00:01.00]current provider".into()
                )
                .await
            )?,
            "unchanged completion rejected"
        );

        let http = reqwest::Client::builder().no_proxy().build()?;
        let path = "/v1/tracks/local/lyrics";
        ensure!(
            http.get(format!("{base}{path}")).send().await?.status() == 401,
            "auth bypass"
        );
        let via_http: Value = http
            .get(format!("{base}{path}"))
            .bearer_auth(&state.token)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let rpc = crate::rpc::Rpc::new(state.clone());
        let via_rpc = checked(
            rpc.call(crate::rpc::Call {
                op: crate::rpc::Op::Get,
                path: path.trim_start_matches('/'),
                query: json!({}),
                body: Value::Null,
                raw: None,
                client_operation_id: None,
            })
            .await,
        )?;
        ensure!(via_http == via_rpc.body, "HTTP/RPC reads differ");
        let body = json!({"content":"[00:02.00]facade","format":"auto","expectedMetadataRevision":via_http["metadataRevision"],"expectedLyricsRevision":via_http["lyricsRevision"]});
        let prepared: Value = http
            .post(format!("{base}{path}/candidates"))
            .bearer_auth(&state.token)
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let applied=checked(rpc.call(crate::rpc::Call{op:crate::rpc::Op::Post,path:"v1/tracks/local/lyrics/candidates/apply",query:json!({}),body:json!({"candidateId":prepared["candidateId"],"expectedLyricsRevision":prepared["lyricsRevision"]}),raw:None,client_operation_id:None}).await)?;
        ensure!(applied.body["ok"] == true, "HTTP prepare/RPC apply");
        let invalid = http
            .put(format!("{base}{path}"))
            .bearer_auth(&state.token)
            .json(&json!({"content":"<bad>not LRC</bad>"}))
            .send()
            .await?;
        ensure!(invalid.status() == 422, "malformed XML imported");
        let error: Value = invalid.json().await?;
        ensure!(
            error["error"]["request_id"]
                .as_str()
                .is_some_and(|s| !s.is_empty()),
            "missing request id"
        );
        let no_auth = http
            .post(format!("{base}{path}/candidates"))
            .json(&body)
            .send()
            .await?;
        ensure!(no_auth.status() == 401, "candidate auth bypass");

        state.lyric_candidates.lock().await.clear();
        let baseline = checked(read(state, "local").await)?;
        let c =
            checked(prepare(state, "local", prepare_body(&baseline, "[00:01.00]expired")).await)?;
        state
            .lyric_candidates
            .lock()
            .await
            .get_mut(c["candidateId"].as_str().unwrap())
            .unwrap()
            .expires = Instant::now() - Duration::from_secs(1);
        ensure!(
            apply(state, "local", apply_body(&c))
                .await
                .unwrap_err()
                .status
                == StatusCode::GONE,
            "expiry"
        );
        for _ in 0..CAP {
            checked(prepare(state, "local", prepare_body(&baseline, "[00:01.00]bounded")).await)?;
        }
        ensure!(
            prepare(
                state,
                "local",
                prepare_body(&baseline, "[00:01.00]overflow")
            )
            .await
            .unwrap_err()
            .code
                == "lyrics_busy",
            "capacity bypass"
        );
        ensure!(
            state.audio.snapshot().track_id.is_none(),
            "lyric import changed playback"
        );
        Ok(())
    }
}
