// SPDX-License-Identifier: MIT
//! Explicit local pitch analysis; HTTP and RPC use this same bounded owner.
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock,
    },
    time::{Duration, Instant},
};

use axum::http::StatusCode;
use serde::Serialize;
use tokio::sync::Semaphore;
use vmusic_beats::pitch::{self, Control, PitchError, PitchMap};
use vmusic_core::TrackSource;

use crate::{
    error::{bad_request, not_found, ApiError, ApiResult},
    stage_project::{MediaIdentity, MediaRequest},
    state::AppState,
};

// At most one pitch reader across DataDirs, inside the existing two-slot FFT
// budget. No queue, duplicate analysis, unbounded in-flight table or new runner.
static READER: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(1)));
const DEADLINE: Duration = Duration::from_secs(30);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reply {
    media: MediaIdentity,
    cached: bool,
    map: Arc<PitchMap>,
}

struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

fn busy() -> ApiError {
    ApiError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "pitch_busy",
        "后台音频分析正忙，请稍后再试",
    )
}
fn timeout_error() -> ApiError {
    ApiError::new(
        StatusCode::REQUEST_TIMEOUT,
        "pitch_timeout",
        "基频分析超过 30 秒期限，请稍后再试",
    )
}
fn analyze_error(error: PitchError) -> ApiError {
    match error {
        PitchError::Deadline => timeout_error(),
        PitchError::Cancelled => ApiError::new(
            StatusCode::REQUEST_TIMEOUT,
            "pitch_cancelled",
            "基频分析已取消",
        ),
        PitchError::Unsupported => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "pitch_unsupported",
            "基频分析暂不支持此音频的编码、采样率或声道配置",
        ),
        PitchError::Decode => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "pitch_decode_failed",
            "无法稳定解码此本地音频，未生成轨迹",
        ),
    }
}
fn media_error(error: ApiError) -> ApiError {
    if error.code.starts_with("pitch_") {
        return error;
    }
    let code = match error.code {
        "project_media_timeout" => return timeout_error(),
        "project_media_changed" => "pitch_media_changed",
        "project_media_size" => "pitch_media_size",
        _ => "pitch_media_unavailable",
    };
    ApiError::new(error.status, code, error.message)
}

pub(crate) async fn request(state: &Arc<AppState>, request: MediaRequest) -> ApiResult<Reply> {
    if request.track_id.is_empty() || request.track_id.len() > 256 {
        return Err(bad_request("无效曲库 ID"));
    }
    let permit = state
        .beat_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| busy())?;
    let reader = READER.clone().try_acquire_owned().map_err(|_| busy())?;
    let control = Control {
        until: Instant::now() + DEADLINE,
        cancelled: Arc::new(AtomicBool::new(false)),
    };
    let _cancel = CancelOnDrop(control.cancelled.clone());
    let state = state.clone();
    let until = control.until;
    let work = async move {
        let track = vmusic_store::get_track(&state.db, &request.track_id)
            .await
            .map_err(vmusic_core::CoreError::from)?
            .ok_or_else(|| not_found("未找到本地曲目"))?;
        if !matches!(track.source, TrackSource::Local) {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "pitch_local_only",
                "基频分析目前只读取本地曲库文件，不下载在线或远程音频",
            ));
        }
        tokio::task::spawn_blocking(move || {
            // Permits cover hash, decoder, estimator, cache publication and cleanup,
            // even after the request future times out or its observer disconnects.
            let (_permit, _reader) = (permit, reader);
            control.check().map_err(analyze_error)?;
            let path = Path::new(&track.path);
            let (file, media) =
                crate::stage_project::fingerprinted_file(path, control.until, || {
                    control.check().map_err(analyze_error)
                })
                .map_err(media_error)?;
            control.check().map_err(analyze_error)?;
            let before = file
                .metadata()
                .map_err(|_| analyze_error(PitchError::Decode))?;
            let key = format!("{}:{}:{}", pitch::ALGORITHM, pitch::VERSION, media.sha256);
            let cached = state.pitch_cache.blocking_lock().get(&key).cloned();
            let is_cached = cached.is_some();
            let map = match cached {
                Some(map) => map,
                None => Arc::new(
                    pitch::analyze_file(
                        file.try_clone()
                            .map_err(|_| analyze_error(PitchError::Decode))?,
                        &control,
                    )
                    .map_err(analyze_error)?,
                ),
            };
            control.check().map_err(analyze_error)?;
            let after = file
                .metadata()
                .map_err(|_| analyze_error(PitchError::Decode))?;
            let named = std::fs::metadata(path).map_err(|_| analyze_error(PitchError::Decode))?;
            if [after, named]
                .iter()
                .any(|m| m.len() != before.len() || m.modified().ok() != before.modified().ok())
            {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "pitch_media_changed",
                    "读取期间文件发生变化，请重新载入后分析",
                ));
            }
            if !is_cached {
                state.pitch_cache.blocking_lock().insert(key, map.clone());
            }
            Ok(Reply {
                media,
                cached: is_cached,
                map,
            })
        })
        .await
        .map_err(|_| analyze_error(PitchError::Decode))?
    };
    tokio::time::timeout_at(until.into(), work)
        .await
        .map_err(|_| timeout_error())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::{ensure, Result};
    use serde_json::json;
    use vmusic_core::Track;

    fn checked<T>(result: ApiResult<T>) -> Result<T> {
        result.map_err(|e| anyhow::anyhow!("{}: {}", e.code, e.message))
    }

    fn write_wav(path: &Path, hz: f64) -> std::io::Result<()> {
        let pcm: Vec<u8> = (0..16_000)
            .flat_map(|i| {
                let sample = (10_000.0
                    * (f64::from(i) * hz * std::f64::consts::TAU / 16_000.0).sin())
                    as i16;
                sample.to_le_bytes()
            })
            .collect();
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt \x10\0\0\0\x01\0\x01\0");
        bytes.extend_from_slice(&16_000u32.to_le_bytes());
        bytes.extend_from_slice(&32_000u32.to_le_bytes());
        bytes.extend_from_slice(b"\x02\0\x10\0data");
        bytes.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&pcm);
        std::fs::write(path, bytes)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn content_cache_shared_budget_and_http_rpc_are_consistent() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("hertz-pitch-{}", uuid::Uuid::new_v4()));
        let db = vmusic_store::open(&dir).await?;
        let (mut state, audio) = crate::state::tests::playback_state_with_db(db).await;
        state.data_dir = dir.clone();
        state.token = "pitch-test-official-token".into();
        let state = Arc::new(state);
        let app = crate::routes::router(state.clone()).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let server = tokio::spawn(async move { axum::serve(listener, app).await });
        let result: Result<()> = async {
            let path = dir.join("private-filename.wav");
            write_wav(&path, 220.0)?;
            let mut track = Track {
                id: "pitch-local".into(),
                path: path.to_string_lossy().into_owned(),
                source: TrackSource::Local,
                title: "Private title".into(),
                artist: None,
                album: None,
                duration_ms: Some(1000),
                bitrate: None,
                sample_rate: Some(16_000),
                channels: Some(1),
                has_cover: false,
                file_mtime: None,
                file_size: None,
                added_at: 0,
            };
            vmusic_store::upsert_track(&state.db, &track).await?;
            let request_id = || MediaRequest {
                track_id: track.id.clone(),
            };
            let first = checked(request(&state, request_id()).await)?;
            ensure!(
                !first.cached && !first.map.truncated && first.map.analyzed_ms == 1000,
                "initial analysis"
            );
            ensure!(
                first
                    .map
                    .points
                    .iter()
                    .all(|p| p.hz.is_some_and(|hz| (hz - 220.0).abs() < 1.0)),
                "decoded 220 Hz"
            );
            let cached = checked(request(&state, request_id()).await)?;
            ensure!(
                cached.cached && cached.media == first.media,
                "content cache hit"
            );
            let serialized = serde_json::to_string(&cached)?;
            ensure!(
                !serialized.contains("private-filename") && !serialized.contains("Private title"),
                "private fields leaked"
            );

            let rpc = crate::rpc::Rpc::new(state.clone());
            let reply = checked(
                rpc.call(crate::rpc::Call {
                    op: crate::rpc::Op::Post,
                    path: "v1/stage/pitch",
                    query: json!({}),
                    body: json!({"track_id":track.id}),
                    raw: None,
                    client_operation_id: None,
                })
                .await,
            )?;
            ensure!(
                reply.status == 200 && reply.body["cached"] == true,
                "RPC cache path"
            );
            let http = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()?;
            let reply_http: serde_json::Value = http
                .post(format!("http://127.0.0.1:{port}/v1/stage/pitch"))
                .bearer_auth(&state.token)
                .json(&json!({"track_id":track.id}))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            // Compare both facades after JSON decoding: the default serde_json
            // parser may round an f64 by one ULP relative to an in-memory Value.
            let rpc_wire: serde_json::Value =
                serde_json::from_slice(&serde_json::to_vec(&reply.body)?)?;
            ensure!(rpc_wire == reply_http, "HTTP and RPC shape drifted");
            let occupied = state.beat_slots.clone().acquire_many_owned(2).await?;
            ensure!(
                request(&state, request_id())
                    .await
                    .err()
                    .is_some_and(|e| e.code == "pitch_busy"),
                "shared FFT budget ignored"
            );
            drop(occupied);

            // Same path/size/track ID, changed content: never reuse the old F0 map.
            write_wav(&path, 440.0)?;
            let changed = checked(request(&state, request_id()).await)?;
            ensure!(
                !changed.cached && changed.media != first.media,
                "content change retained old map"
            );
            ensure!(
                changed
                    .map
                    .points
                    .iter()
                    .all(|p| p.hz.is_some_and(|hz| (hz - 440.0).abs() < 2.0)),
                "changed frequency"
            );
            let other = dir.join("same-bytes-new-path.wav");
            std::fs::copy(&path, &other)?;
            track.id = "same-content".into();
            track.path = other.to_string_lossy().into_owned();
            vmusic_store::upsert_track(&state.db, &track).await?;
            ensure!(
                checked(
                    request(
                        &state,
                        MediaRequest {
                            track_id: track.id.clone()
                        }
                    )
                    .await
                )?
                .cached,
                "cache depends on private path instead of content"
            );
            track.id = "remote".into();
            track.path = "https://example.invalid/pitch.wav".into();
            track.source = TrackSource::Remote;
            vmusic_store::upsert_track(&state.db, &track).await?;
            ensure!(
                request(
                    &state,
                    MediaRequest {
                        track_id: track.id.clone()
                    }
                )
                .await
                .err()
                .is_some_and(|e| e.code == "pitch_local_only"),
                "remote audio accepted"
            );
            ensure!(
                state.beat_slots.available_permits() == 2 && READER.available_permits() == 1,
                "analysis slot leaked"
            );
            ensure!(
                state.audio.snapshot().track_id.is_none(),
                "analysis changed current playback"
            );
            Ok(())
        }
        .await;
        server.abort();
        let _ = server.await;
        state.audio.shutdown();
        audio.join().unwrap();
        state.db.close().await;
        drop(state);
        std::fs::remove_dir_all(&dir)?;
        result
    }
}
