// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! The REST surface. Thin by design: handlers validate input, call into the
//! audio actor or the store, and shape a response. No business logic lives
//! here.

use std::path::Path;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{middleware, Json, Router};
use serde::{Deserialize, Serialize};
use vmusic_core::{PlayMode, PROTOCOL_VERSION};

use crate::daily;
use crate::error::{bad_request, not_found, unauthorized, ApiError, ApiResult};
use crate::online;
use crate::scan;
use crate::state::{AppState, ScanProgress};

/// Builds the API router.
///
/// The state is *not* attached here: the caller applies `with_state` once so
/// this router can be merged into another one carrying the same state type.
pub fn router(state: Arc<AppState>) -> Router<Arc<AppState>> {
    // Everything except /v1/health and the UI requires the bearer token.
    let api = Router::new()
        .route("/v1/state", get(get_state))
        .route("/v1/player/load", post(load))
        .route("/v1/player/play", post(play))
        .route("/v1/player/pause", post(pause))
        .route("/v1/player/stop", post(stop))
        .route("/v1/player/next", post(next))
        .route("/v1/player/previous", post(previous))
        .route("/v1/player/seek", post(seek))
        // Reordering the queue must not restart the current track, so it gets
        // its own endpoint instead of going through `load` (which calls
        // `play_index` and therefore `audio.load()` again).
        .route("/v1/player/queue", get(get_queue).put(set_queue))
        .route("/v1/player/volume", post(volume))
        .route("/v1/player/mode", post(mode))
        .route("/v1/devices", get(devices))
        .route("/v1/devices/select", post(select_device))
        .route("/v1/tracks", get(list_tracks))
        .route("/v1/tracks/{id}", get(get_track))
        .route("/v1/tracks/{id}/cover", get(get_cover))
        .route("/v1/tracks/{id}/lyrics", get(get_lyrics))
        .route("/v1/library/scan", post(start_scan))
        .route("/v1/library/status", get(scan_status))
        .route("/v1/playlists", get(list_playlists).post(create_playlist))
        .route(
            "/v1/playlists/{id}",
            get(noop).put(rename_playlist).delete(delete_playlist),
        )
        .route(
            "/v1/playlists/{id}/tracks",
            get(get_playlist_tracks).post(add_to_playlist),
        )
        .route(
            "/v1/playlists/{id}/tracks/order",
            axum::routing::put(reorder_playlist_tracks),
        )
        .route(
            "/v1/playlists/{id}/tracks/{track_id}",
            axum::routing::delete(remove_from_playlist),
        )
        .route("/v1/settings", get(get_settings).put(put_settings))
        // 收藏：列表 / 新增 / 删除 / 开关；membership 是给一整屏曲目批量判红的。
        .route("/v1/favorites", get(list_favorites).post(add_favorite))
        .route("/v1/favorites/membership", post(favorite_membership))
        .route("/v1/favorites/toggle", post(toggle_favorite))
        .route("/v1/favorites/{id}", axum::routing::delete(remove_favorite))
        // 每日推荐：本地规则引擎，按天确定性出榜。
        .route("/v1/recommend/daily", get(daily_recommend))
        // 播放历史：列表/清空/单删；replay 供错误条重试当前队列指定下标。
        .route("/v1/history", get(history_list).delete(history_clear))
        .route("/v1/history/{id}", axum::routing::delete(history_remove))
        .route("/v1/player/replay", post(replay_index))
        // 在线曲库：搜索与试听地址都由服务端代发，浏览器绕不开第三方接口的
        // CORS 与 Referer 校验。
        .route("/v1/online/sources", get(online_sources))
        .route("/v1/online/search", get(online_search))
        .route("/v1/online/search/all", get(online_search_all))
        .route("/v1/online/stream", get(online_stream))
        .route("/v1/online/detail", get(online_detail))
        .route("/v1/online/lyric", get(online_lyric))
        .route("/v1/online/play", post(online_play))
        .route(
            "/v1/online/quality",
            get(online_quality_get).post(online_quality_set),
        )
        .route("/v1/online/cookie", post(online_cookie))
        // 我的歌单 / 歌单详情 / 写操作
        .route("/v1/online/playlists", get(online_playlists))
        .route(
            "/v1/online/playlist",
            get(online_playlist)
                .post(online_playlist_create)
                .delete(online_playlist_delete),
        )
        .route("/v1/online/playlist/tracks/add", post(online_playlist_add))
        .route(
            "/v1/online/playlist/tracks/remove",
            post(online_playlist_remove),
        )
        .route("/v1/online/like", post(online_like))
        .route("/v1/online/recommend/songs", get(online_rec_songs))
        .route("/v1/online/recommend/playlists", get(online_rec_playlists))
        // 扫码登录：start 发票、poll 轮询、cancel 幂等关闭
        .route("/v1/online/qr/start", post(online_qr_start))
        .route("/v1/online/qr/poll", get(online_qr_poll))
        .route("/v1/online/qr/cancel", post(online_qr_cancel))
        .route("/v1/online/account", get(online_account))
        .layer(middleware::from_fn_with_state(state.clone(), require_token));

    Router::new().route("/v1/health", get(health)).merge(api)
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async fn require_token(
    State(state): State<Arc<AppState>>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let presented = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ").map(|s| s.to_string()))
        .or_else(|| {
            request
                .headers()
                .get("x-vmusic-token")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string())
        })
        // 浏览器没法给 <img src> 加请求头，所以封面只能走查询参数携带 token。
        // 这和 /ws 用 ?token= 是同一个理由。
        //
        // 严格限定 GET：查询参数会出现在日志、浏览器历史和 Referer 里，属于
        // 比请求头弱的信道。只读请求承担这点风险是可接受的，但绝不允许一个
        // 泄露出去的 URL 去触发播放控制或删库操作。
        .or_else(|| {
            if request.method() != axum::http::Method::GET {
                return None;
            }
            query_token(request.uri().query())
        });

    match presented {
        Some(token) if token == state.token => next.run(request).await,
        _ => unauthorized().into_response(),
    }
}

/// 从查询串里取出 `token`。
///
/// 不做 percent-decode：token 是两个 `Uuid::simple()` 拼出来的纯小写十六进制
/// （见 main.rs 的 load_or_create_token），字符集天然 URL 安全。如果哪天换了
/// token 生成方式引入保留字符，这里要一起改。
fn query_token(query: Option<&str>) -> Option<String> {
    let query = query?;
    for pair in query.split('&') {
        let mut kv = pair.splitn(2, '=');
        if kv.next()? == "token" {
            return Some(kv.next()?.to_string());
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct Health {
    status: &'static str,
    version: String,
    protocol_version: u32,
    backend: String,
}

async fn health(State(state): State<Arc<AppState>>) -> Json<Health> {
    Json(Health {
        status: "ok",
        version: env!("CARGO_PKG_VERSION").to_string(),
        protocol_version: PROTOCOL_VERSION,
        // The snapshot does not carry the backend name, so read it from config.
        backend: state.config.audio.backend.clone(),
    })
}

async fn get_state(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    // 播放器快照之外叠加「在线曲缓冲覆盖态」：buffering 与 WS Buffering 事件
    // 读同一个 state.buffering，轮询 /state 的客户端拿到的口径与推送一致。
    let mut v = serde_json::to_value(state.audio.snapshot()).unwrap_or_default();
    if let Some(obj) = v.as_object_mut() {
        // 字段口径与 WS Buffering 事件一致：buffering + pct（旧名 buffer_pct
        // 已移除，前端只消费 WS 推送，轮询快照仅作首帧/降级对齐）。
        let (active, pct) = *state.buffering.lock().await;
        obj.insert("buffering".into(), serde_json::Value::Bool(active));
        if let Some(p) = pct {
            obj.insert("pct".into(), serde_json::Value::from(p));
        }
    }
    Json(v)
}

async fn play(State(state): State<Arc<AppState>>) -> ApiResult<Json<serde_json::Value>> {
    state
        .audio
        .play()
        .await
        .map_err(vmusic_core::CoreError::Audio)?;
    Ok(get_state(State(state)).await)
}

async fn pause(State(state): State<Arc<AppState>>) -> ApiResult<Json<serde_json::Value>> {
    state
        .audio
        .pause()
        .await
        .map_err(vmusic_core::CoreError::Audio)?;
    Ok(get_state(State(state)).await)
}

async fn stop(State(state): State<Arc<AppState>>) -> ApiResult<Json<serde_json::Value>> {
    state
        .audio
        .stop()
        .await
        .map_err(vmusic_core::CoreError::Audio)?;
    Ok(get_state(State(state)).await)
}

async fn next(State(state): State<Arc<AppState>>) -> ApiResult<Json<serde_json::Value>> {
    state.step(1, false).await?;
    // 成功起播后在路由入口 detach 预取 + LRU（每首恰好一次）。
    state.post_commit_background();
    Ok(get_state(State(state)).await)
}

async fn previous(State(state): State<Arc<AppState>>) -> ApiResult<Json<serde_json::Value>> {
    state.step(-1, false).await?;
    state.post_commit_background();
    Ok(get_state(State(state)).await)
}

#[derive(Deserialize)]
pub struct LoadRequest {
    pub track_id: String,
    /// Optional playback queue; when present the track is played from it and
    /// "next / previous" walk this list.
    pub queue: Option<Vec<String>>,
}

async fn load(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LoadRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let queue = body.queue.unwrap_or_else(|| vec![body.track_id.clone()]);
    let index = queue
        .iter()
        .position(|id| *id == body.track_id)
        .unwrap_or(0);
    state.set_queue(queue, Some(index)).await;
    state.play_index(index).await?;
    state.post_commit_background();
    Ok(get_state(State(state)).await)
}

/// The queue used to live only in server memory with no way to read it back,
/// so a page reload lost it.
async fn get_queue(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let queue = state.queue.lock().await.clone();
    let index = state.current_index().await;
    Json(serde_json::json!({ "queue": queue, "index": index }))
}

#[derive(Deserialize)]
pub struct SetQueueRequest {
    pub queue: Vec<String>,
    pub index: Option<usize>,
    /// Kept in the contract so a client can say "this was an edit, not a jump".
    /// Nothing here reloads the audio actor, so playback is never interrupted
    /// either way.
    pub resume: Option<bool>,
}

/// Replaces the queue **without** reloading the current track.
///
/// `AppState::set_queue` only writes the queue and the cursor; it never talks
/// to the audio actor. `player/load` would call `play_index` and restart the
/// track from 0:00, which is exactly what dragging a row must not do.
async fn set_queue(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SetQueueRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let index = match body.index {
        Some(i) if i < body.queue.len() => Some(i),
        // A pure reorder sends no index. Dropping the cursor there would break
        // "next" until the next load, so keep it when the client asks to resume.
        _ if body.resume == Some(true) => state
            .current_index()
            .await
            .filter(|i| *i < body.queue.len()),
        _ => None,
    };
    state.set_queue(body.queue.clone(), index).await;
    Ok(Json(serde_json::json!({
        "queue": body.queue,
        "index": index,
    })))
}

#[derive(Deserialize)]
pub struct SeekRequest {
    pub position_ms: u64,
}

async fn seek(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SeekRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    state
        .audio
        .seek(body.position_ms)
        .await
        .map_err(vmusic_core::CoreError::Audio)?;
    Ok(get_state(State(state)).await)
}

#[derive(Deserialize)]
pub struct VolumeRequest {
    pub volume: f32,
}

async fn volume(
    State(state): State<Arc<AppState>>,
    Json(body): Json<VolumeRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    if !(0.0..=1.0).contains(&body.volume) {
        return Err(bad_request("volume must be between 0.0 and 1.0"));
    }
    state
        .audio
        .set_volume(body.volume)
        .await
        .map_err(vmusic_core::CoreError::Audio)?;
    crate::persist::save_volume(&state.db, body.volume).await;
    Ok(get_state(State(state)).await)
}

#[derive(Deserialize)]
pub struct ModeRequest {
    pub mode: PlayMode,
}

async fn mode(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ModeRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    state
        .audio
        .set_mode(body.mode)
        .await
        .map_err(vmusic_core::CoreError::Audio)?;
    crate::persist::save_mode(&state.db, body.mode).await;
    Ok(get_state(State(state)).await)
}

async fn devices(State(state): State<Arc<AppState>>) -> ApiResult<Json<serde_json::Value>> {
    let devices = state
        .audio
        .devices()
        .await
        .map_err(vmusic_core::CoreError::Audio)?;
    Ok(Json(serde_json::json!({ "devices": devices })))
}

#[derive(Deserialize)]
pub struct SelectDeviceRequest {
    pub id: Option<String>,
}

async fn select_device(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SelectDeviceRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    state
        .audio
        .select_device(body.id)
        .await
        .map_err(vmusic_core::CoreError::Audio)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct TrackQuery {
    pub q: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Serialize)]
struct TrackPage {
    total: i64,
    tracks: Vec<vmusic_core::Track>,
}

async fn list_tracks(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TrackQuery>,
) -> ApiResult<Json<TrackPage>> {
    let limit = query.limit.unwrap_or(200).clamp(1, 1000);
    let offset = query.offset.unwrap_or(0).max(0);
    let tracks = vmusic_store::list_tracks(&state.db, query.q.as_deref(), limit, offset)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    let total = vmusic_store::count_tracks(&state.db, query.q.as_deref())
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    Ok(Json(TrackPage { total, tracks }))
}

async fn get_track(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<vmusic_core::Track>> {
    vmusic_store::get_track(&state.db, &id)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?
        .map(Json)
        .ok_or_else(|| not_found(format!("track {id}")))
}

async fn get_cover(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> Response {
    let dir = state.cover_dir();
    let found = ["jpg", "png", "webp", "gif"].iter().find_map(|ext| {
        let path = dir.join(format!("{id}.{ext}"));
        if path.is_file() {
            Some((path, *ext))
        } else {
            None
        }
    });

    match found {
        Some((path, ext)) => match tokio::fs::read(&path).await {
            Ok(bytes) => {
                let mime = match ext {
                    "png" => "image/png",
                    "webp" => "image/webp",
                    "gif" => "image/gif",
                    _ => "image/jpeg",
                };
                (
                    StatusCode::OK,
                    [
                        (header::CONTENT_TYPE, mime),
                        (header::CACHE_CONTROL, "max-age=86400"),
                    ],
                    Bytes::from(bytes),
                )
                    .into_response()
            }
            Err(e) => ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", e.to_string())
                .into_response(),
        },
        None => StatusCode::NO_CONTENT.into_response(),
    }
}

async fn get_lyrics(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<vmusic_core::LyricDocument>> {
    let track = vmusic_store::get_track(&state.db, &id)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?
        .ok_or_else(|| not_found(format!("track {id}")))?;

    let path = Path::new(&track.path);
    let mut doc = match vmusic_library::find_sidecar_lyrics(path) {
        Some(lrc) => match tokio::fs::read_to_string(&lrc).await {
            Ok(text) => vmusic_lyrics::parse_lrc(&text),
            Err(e) => {
                tracing::debug!("cannot read {}: {e}", lrc.display());
                vmusic_core::LyricDocument::empty()
            }
        },
        None => vmusic_core::LyricDocument::empty(),
    };
    vmusic_lyrics::apply_offset(&mut doc);
    Ok(Json(doc))
}

#[derive(Deserialize)]
pub struct ScanRequest {
    pub root: String,
}

async fn start_scan(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ScanRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let root = Path::new(&body.root).to_path_buf();
    if !root.is_dir() {
        return Err(bad_request(format!("{} is not a directory", body.root)));
    }
    if state.scan.lock().await.running {
        return Err(bad_request("a scan is already running"));
    }
    tokio::spawn(scan::run_scan(state, root));
    Ok(Json(serde_json::json!({ "started": true })))
}

async fn scan_status(State(state): State<Arc<AppState>>) -> Json<ScanProgress> {
    Json(state.scan.lock().await.clone())
}

async fn list_playlists(State(state): State<Arc<AppState>>) -> ApiResult<Json<serde_json::Value>> {
    let playlists = vmusic_store::list_playlists(&state.db)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    Ok(Json(serde_json::json!({ "playlists": playlists })))
}

#[derive(Deserialize)]
pub struct CreatePlaylist {
    pub name: String,
}

async fn create_playlist(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreatePlaylist>,
) -> ApiResult<Json<vmusic_core::Playlist>> {
    if body.name.trim().is_empty() {
        return Err(bad_request("name must not be empty"));
    }
    vmusic_store::playlists::create(&state.db, body.name.trim())
        .await
        .map(Json)
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))
}

async fn rename_playlist(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<CreatePlaylist>,
) -> ApiResult<Json<serde_json::Value>> {
    vmusic_store::playlists::rename(&state.db, &id, body.name.trim())
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn delete_playlist(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<serde_json::Value>> {
    vmusic_store::playlists::delete(&state.db, &id)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct PlaylistTracks {
    pub track_ids: Vec<String>,
}

async fn add_to_playlist(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<PlaylistTracks>,
) -> ApiResult<Json<serde_json::Value>> {
    vmusic_store::playlists::add_tracks(&state.db, &id, &body.track_ids)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct ReorderPlaylistTracks {
    pub track_ids: Vec<String>,
}

/// Replaces the whole track order of a playlist (`PUT .../tracks/order`).
/// Membership validation lives in the store: the submitted ids must be the
/// current membership in some permutation.
async fn reorder_playlist_tracks(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<ReorderPlaylistTracks>,
) -> ApiResult<Json<serde_json::Value>> {
    vmusic_store::playlists::reorder(&state.db, &id, &body.track_ids)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Reads a playlist's contents.
///
/// Only `POST` (append) was registered before, so the UI's click on a playlist
/// had no way to learn what is inside it. Both shapes are returned:
/// `track_ids` mirrors the write body, `tracks` saves the client a round trip
/// per id (the queue view needs titles, and those tracks may be outside the
/// library page currently loaded).
async fn get_playlist_tracks(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let ids = vmusic_store::get_playlist_track_ids(&state.db, &id)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;

    let mut tracks = Vec::with_capacity(ids.len());
    for track_id in &ids {
        if let Some(track) = vmusic_store::get_track(&state.db, track_id)
            .await
            .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?
        {
            tracks.push(track);
        }
    }

    Ok(Json(
        serde_json::json!({ "track_ids": ids, "tracks": tracks }),
    ))
}

async fn remove_from_playlist(
    State(state): State<Arc<AppState>>,
    AxumPath((id, track)): AxumPath<(String, String)>,
) -> ApiResult<Json<serde_json::Value>> {
    vmusic_store::playlists::remove_track(&state.db, &id, &track)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn noop() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

async fn get_settings(State(state): State<Arc<AppState>>) -> ApiResult<Json<serde_json::Value>> {
    let values = vmusic_store::settings::get_all(&state.db)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    // 凭据只进不出，见 `is_credential`。
    let public: serde_json::Value = values
        .into_iter()
        .filter(|(key, _)| !is_credential(key))
        .collect::<serde_json::Map<_, _>>()
        .into();
    Ok(Json(public))
}

async fn put_settings(
    State(state): State<Arc<AppState>>,
    Json(body): Json<std::collections::BTreeMap<String, serde_json::Value>>,
) -> ApiResult<Json<serde_json::Value>> {
    if let Some(key) = body.keys().find(|k| is_credential(k)) {
        return Err(bad_request(format!(
            "{key} 属于音源凭据，只能通过 /v1/online/cookie 修改"
        )));
    }
    vmusic_store::settings::set_all(&state.db, &body)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// 设置表里存的是「用户在音源站点的登录凭据」（旧版裸 cookie 键
/// `online_cookie_*` 与新版结构化凭据键 `online_cred_*`）。这类键有三条规矩：
/// 不出现在 `GET /v1/settings` 里、不能从 `PUT /v1/settings` 写进去、
/// 改它只能走 `/v1/online/cookie`（那里才校验得了音源是否真的支持登录）。
/// `online_device_*` 是非敏感设备身份，不在此列。
fn is_credential(key: &str) -> bool {
    key.starts_with(online::COOKIE_PREFIX) || key.starts_with(online::CRED_PREFIX)
}

// ---------------------------------------------------------------------------
// 收藏
// ---------------------------------------------------------------------------

/// 收藏列表的默认/最大分页。
const FAV_PAGE: i64 = 200;
const FAV_PAGE_MAX: i64 = 500;

fn store_err(e: vmusic_core::StoreError) -> ApiError {
    ApiError::from(vmusic_core::CoreError::Store(e))
}

#[derive(Debug, Deserialize)]
struct FavoritesQuery {
    /// track | radio；省略表示全部。
    kind: Option<String>,
    #[serde(default)]
    offset: i64,
    limit: Option<i64>,
}

async fn list_favorites(
    State(state): State<Arc<AppState>>,
    Query(q): Query<FavoritesQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    let kind = match q.kind.as_deref() {
        Some(raw) if !raw.trim().is_empty() => Some(daily::parse_kind(raw)?),
        _ => None,
    };
    let limit = q.limit.unwrap_or(FAV_PAGE).clamp(1, FAV_PAGE_MAX);
    let offset = q.offset.max(0);
    let favorites = vmusic_store::favorites::list(&state.db, kind, limit, offset)
        .await
        .map_err(store_err)?;
    let total = vmusic_store::favorites::count(&state.db, kind)
        .await
        .map_err(store_err)?;
    // 两个 tab 各自的总数：前端一次拿到就不用为「歌曲 / 电台」各请求一遍。
    let track_count =
        vmusic_store::favorites::count(&state.db, Some(vmusic_core::FavoriteKind::Track))
            .await
            .map_err(store_err)?;
    let radio_count =
        vmusic_store::favorites::count(&state.db, Some(vmusic_core::FavoriteKind::Radio))
            .await
            .map_err(store_err)?;
    Ok(Json(serde_json::json!({
        "favorites": favorites,
        "total": total,
        "offset": offset,
        "limit": limit,
        "counts": { "track": track_count, "radio": radio_count },
    })))
}

/// 入站收藏项的公共字段。新增与开关两个端点形状相同，只是一处多一个
/// `favorited`，所以解析成两个请求体、共用这一个结构体。
#[derive(Debug, Clone, Deserialize)]
struct FavoriteBody {
    /// track | radio
    kind: String,
    /// local 或音源 id（netease/qq/kugou/qishui/ccmixter）
    #[serde(default = "default_favorite_source")]
    source: String,
    /// 本地曲目 id 或音源内的曲目/电台 id
    #[serde(default)]
    ref_id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    artist: Option<String>,
    #[serde(default)]
    album: Option<String>,
    #[serde(default)]
    duration_ms: Option<u64>,
    #[serde(default)]
    cover: Option<String>,
}

fn default_favorite_source() -> String {
    "local".to_string()
}

/// 校验并归一「收藏指向什么」。
fn favorite_target(body: &FavoriteBody) -> ApiResult<(vmusic_core::FavoriteKind, String, String)> {
    let kind = daily::parse_kind(&body.kind)?;
    let source = body.source.trim().to_string();
    let ref_id = body.ref_id.trim().to_string();
    if source.is_empty() {
        return Err(bad_request("缺少 source"));
    }
    if ref_id.is_empty() {
        return Err(bad_request("缺少 ref_id"));
    }
    Ok((kind, source, ref_id))
}

/// 空串一律折成 None：收藏表里 artist/album/cover 允许为 NULL，存空串会让
/// 「未知艺术家」这类判断在前后端出现两套写法。
fn clean(value: Option<&String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 构造要落盘的元数据快照。
///
/// `title` 允许省略：收藏本地曲目时前端往往只持有 id，标题由服务端回读本地库
/// 补上，省掉前端为一次点击先拉一次曲目详情。
///
/// 回读是**尽力而为**，不是前置条件：本地库里查不到时不能把整个收藏动作判死。
/// 曲库可能还没扫描完、文件可能刚被移走，而用户此刻明确点了一次红心——
/// 那种情况下落一条「未知曲目」的收藏，也比回 404 让他白点一次好。
async fn favorite_meta(
    db: &sqlx::SqlitePool,
    body: &FavoriteBody,
    kind: vmusic_core::FavoriteKind,
    source: &str,
    ref_id: &str,
) -> ApiResult<vmusic_store::favorites::FavoriteMeta> {
    let mut meta = vmusic_store::favorites::FavoriteMeta {
        title: clean(body.title.as_ref()).unwrap_or_else(|| "未知曲目".to_string()),
        artist: clean(body.artist.as_ref()),
        album: clean(body.album.as_ref()),
        duration_ms: body.duration_ms,
        cover: clean(body.cover.as_ref()),
    };
    if kind == vmusic_core::FavoriteKind::Track && source == "local" && body.title.is_none() {
        if let Some(t) = vmusic_store::get_track(db, &ref_id.to_string())
            .await
            .map_err(store_err)?
        {
            meta.title = t.title.clone();
            meta.artist = t.artist.clone();
            meta.album = t.album.clone();
            meta.duration_ms = t.duration_ms;
        }
    }
    Ok(meta)
}

async fn add_favorite(
    State(state): State<Arc<AppState>>,
    Json(body): Json<FavoriteBody>,
) -> ApiResult<Json<serde_json::Value>> {
    let (kind, source, ref_id) = favorite_target(&body)?;
    let meta = favorite_meta(&state.db, &body, kind, &source, &ref_id).await?;
    let favorite = vmusic_store::favorites::add(&state.db, kind, &source, &ref_id, &meta)
        .await
        .map_err(store_err)?;
    Ok(Json(
        serde_json::json!({ "favorite": favorite, "favorited": true }),
    ))
}

async fn remove_favorite(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let removed = vmusic_store::favorites::remove(&state.db, &id)
        .await
        .map_err(store_err)?;
    // 取消一个不存在的收藏按成功处理：前端的心形按钮可能在刷新竞态下连点两次。
    Ok(Json(serde_json::json!({ "ok": true, "removed": removed })))
}

#[derive(Debug, Deserialize)]
struct ToggleRequest {
    #[serde(flatten)]
    body: FavoriteBody,
    /// 显式指定目标态；省略则按当前状态取反。
    #[serde(default)]
    favorited: Option<bool>,
}

/// 红心开关。
///
/// 返回**最终态**而不是「操作成功」：按钮的乐观更新需要知道结果是什么，而
/// 「加了还是删了」在连点时不能靠前端自己记。
async fn toggle_favorite(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ToggleRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let (kind, source, ref_id) = favorite_target(&req.body)?;
    let id = vmusic_store::favorites::identity(kind, &source, &ref_id);
    let existing = vmusic_store::favorites::get(&state.db, &id)
        .await
        .map_err(store_err)?;
    let want = req.favorited.unwrap_or(existing.is_none());

    if !want {
        vmusic_store::favorites::remove(&state.db, &id)
            .await
            .map_err(store_err)?;
        return Ok(Json(
            serde_json::json!({ "favorited": false, "favorite": null, "id": id }),
        ));
    }

    let meta = favorite_meta(&state.db, &req.body, kind, &source, &ref_id).await?;
    let favorite = vmusic_store::favorites::add(&state.db, kind, &source, &ref_id, &meta)
        .await
        .map_err(store_err)?;
    Ok(Json(
        serde_json::json!({ "favorited": true, "favorite": favorite, "id": id }),
    ))
}

#[derive(Debug, Deserialize)]
struct MembershipRequest {
    /// track | radio
    kind: String,
    #[serde(default = "default_favorite_source")]
    source: String,
    /// 一屏曲目的 ref_id。
    #[serde(default)]
    ids: Vec<String>,
}

/// 批量判断「这一屏里哪些已收藏」。
///
/// 曲库一屏 200 行，逐行问一次是 200 次往返；这里一次捞回命中的 ref_id 集合。
async fn favorite_membership(
    State(state): State<Arc<AppState>>,
    Json(body): Json<MembershipRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let kind = daily::parse_kind(&body.kind)?;
    let source = body.source.trim().to_string();
    if source.is_empty() {
        return Err(bad_request("缺少 source"));
    }
    if body.ids.is_empty() {
        return Ok(Json(serde_json::json!({ "ids": [] })));
    }
    // 上限与曲库分页对齐：超出就是前端构造错了，不该让 SQL 参数无限膨胀。
    if body.ids.len() > FAV_PAGE_MAX as usize {
        return Err(bad_request(format!("ids 数量超过上限 {}", FAV_PAGE_MAX)));
    }
    let ids: Vec<String> = body
        .ids
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let hit = vmusic_store::favorites::is_favorited(&state.db, kind, &source, &ids)
        .await
        .map_err(store_err)?;
    Ok(Json(serde_json::json!({ "ids": hit })))
}

// ---------------------------------------------------------------------------
// 每日推荐
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct DailyQuery {
    limit: Option<usize>,
}

async fn daily_recommend(
    State(state): State<Arc<AppState>>,
    Query(q): Query<DailyQuery>,
) -> ApiResult<Json<daily::DailyPage>> {
    let limit = daily::parse_limit(q.limit)?;
    daily::daily(&state.db, limit).await.map(Json)
}

// ---------------------------------------------------------------------------
// 播放历史与重放
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct HistoryQuery {
    limit: Option<i64>,
}

async fn history_list(
    State(state): State<Arc<AppState>>,
    Query(q): Query<HistoryQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    let limit = q.limit.unwrap_or(50).clamp(1, 100);
    let items = crate::history::list_recent(&state.db, limit)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(serde_json::json!({ "items": items })))
}

async fn history_clear(State(state): State<Arc<AppState>>) -> ApiResult<Json<serde_json::Value>> {
    let n = crate::history::clear(&state.db)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(serde_json::json!({ "removed": n })))
}

async fn history_remove(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<i64>,
) -> ApiResult<Json<serde_json::Value>> {
    let n = crate::history::remove(&state.db, id)
        .await
        .map_err(ApiError::internal)?;
    if n == 0 {
        return Err(not_found("历史记录不存在"));
    }
    Ok(Json(serde_json::json!({ "removed": n })))
}

#[derive(Debug, Deserialize)]
struct ReplayRequest {
    index: usize,
}

/// 错误条「重试」/ 音质热切换：重新播放当前队列指定下标（在线曲重新取流），
/// 并接续切换前的播放进度（>1s 才 seek；渐进源会在解码侧等到对应字节）。
async fn replay_index(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ReplayRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    // 在重新取流（数秒 await）之前抓进度：提交后旧曲已被换装，快照归零。
    let resume = state.audio.snapshot().position_ms;
    let outcome = state
        .play_index_for(body.index, None, false)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    // 只有真正起播才 seek + 触发后台预取 + LRU；被更新代际顶掉时不收口。
    if outcome.committed {
        if resume > 1000 {
            // seek 失败不致命：从头播也好过半途整个请求报错。
            state.audio.seek(resume).await.ok();
        }
        state.post_commit_background();
    }
    Ok(get_state(State(state)).await)
}

#[derive(Debug, Deserialize)]
struct CookieRequest {
    source: String,
    /// 省略或空串都表示清除。
    cookie: Option<String>,
}

/// 保存/清除用户自己账号的 cookie —— 本项目对「第三方登录」的全部实现。
///
/// 它只是把用户粘进来的字符串原样放进 `Cookie:` 头，发给**同一个音源站点自己**
/// 的公开接口，和浏览器登录后的行为一致。反过来说，这里不会有：从别人账号
/// 池子里取凭据、逆向出来的签名/指纹算法、或者对加密音频的解密。
async fn online_cookie(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CookieRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let Some(info) = online::find(&body.source) else {
        return Err(bad_request(format!("不支持的音源: {}", body.source)));
    };
    if !info.supports_cookie {
        return Err(bad_request(format!(
            "{} 不需要登录，也不接受 cookie",
            info.label
        )));
    }
    let value = body.cookie.unwrap_or_default().trim().to_string();
    // 上限是防一手误粘超大内容：settings 是 SQLite 的一行文本，cookie 头部
    // 超过服务器容忍度时表现是「所有请求 400」，而报错的地方离原因很远。
    if value.len() > 8192 {
        return Err(bad_request("cookie 过长（上限 8192 字节）"));
    }
    // 统一走 cred 保险库：空串=登出（新键与历史裸键一起清，否则扫码写入的
    // cred 会让「清空 cookie」不生效）；非空时先按平台规则补齐判态字段再存，
    // 否则酷狗的 userid/token 缺失会被误判成未登录。
    let store_err = |e: vmusic_core::StoreError| ApiError::from(vmusic_core::CoreError::Store(e));
    if value.is_empty() {
        online::cred_clear(&state.db, &body.source)
            .await
            .map_err(store_err)?;
    } else {
        online::cred_put_cookie(&state.db, &body.source, &value)
            .await
            .map_err(store_err)?;
    }
    // 只回布尔：原文一旦回到前端，就可能进日志、进截图、进用户粘贴到别处的
    // 那段文本里。
    //
    // signedIn 不能用「cookie 非空」冒充：贴进来的串可能缺平台判态关键字段
    // （网易 MUSIC_U、QQ qm_keyst、酷狗 token），那种包存得进去但各平台仍按
    // 未登录处理。回读 cred 包走平台自己的判据，能力失败绝不伪造成功。
    let signed_in = online::cred_get(&state.db, &body.source)
        .await
        .map_err(store_err)?
        .is_some_and(|pack| online::cred_is_signed_in(&body.source, &pack));
    Ok(Json(serde_json::json!({
        "ok": true,
        "source": body.source,
        "signedIn": signed_in,
    })))
}

// ---------------------------------------------------------------------------
// 在线曲库（代理）
// ---------------------------------------------------------------------------

/// 每个上游请求都要摸到设置表（读用户自己填的凭据），所以统一从这里造 Ctx。
fn online_ctx(state: &AppState) -> online::Ctx {
    online::Ctx {
        db: state.db.clone(),
    }
}

/// 没带 source 参数时用注册表的第一个音源，而不是把名字再抄一遍进代码。
fn source_of(raw: Option<String>) -> String {
    raw.filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| online::SOURCES[0].id.to_string())
}

/// spec §1.2：在线代理错误体带音源 id，前端按源分流提示，不必解析 message。
fn tagged<T>(source: &str, result: ApiResult<T>) -> ApiResult<T> {
    result.map_err(|e| e.with_source(source))
}

/// 歌单 scope 白名单。平台模块各自再做映射，路由层先挡住非法值，
/// 避免「拼错 scope 被静默当成全部歌单」。
fn playlist_scope(raw: Option<String>) -> ApiResult<String> {
    let scope = raw.unwrap_or_else(|| "created".to_string());
    match scope.as_str() {
        "created" | "collected" | "liked" => Ok(scope),
        other => Err(bad_request(format!(
            "scope 只能是 created|collected|liked，收到: {other}"
        ))),
    }
}

/// 整盘播放的起始下标归一：缺省 0；越界夹到最后一首而不是直接 400——
/// 前端分页/刷新后传来旧 index 是常事，夹一下比播失败友好。
/// 空列表也安全（当前调用点已保证非空，纯防御）：返回 0 而不是下溢。
fn pick_index(requested: Option<usize>, len: usize) -> usize {
    match requested {
        Some(i) if i < len => i,
        Some(_) => len.saturating_sub(1),
        None => 0,
    }
}

/// 取二维码会话并校验它属于请求的音源。
///
/// 这一步不能省：票是不透明的随机串，但 Registry 里记着它的来源平台。
/// 若 A 平台的票能投到 B 平台的 qr_check，confirmed 时平台模块会把 A 的
/// 凭据写进 B 的保险库——属于跨源凭据污染。票过期/已取消则让前端重新扫码。
fn qr_session(source: &str, sess: Option<online::qr::Session>) -> ApiResult<online::qr::Session> {
    let sess = sess.ok_or_else(|| bad_request("二维码已过期，请重新扫码"))?;
    if sess.source != source {
        return Err(bad_request("二维码会话与音源不匹配，请重新扫码"));
    }
    Ok(sess)
}

/// 音源清单：id、显示名、分类、是否支持 cookie、当前是否已登录。
/// 前端的音源下拉框和分类 chips 全部由它生成。
async fn online_sources(State(state): State<Arc<AppState>>) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(serde_json::json!({
        "sources": online::list_sources(&online_ctx(&state)).await,
    })))
}

async fn online_search(
    State(state): State<Arc<AppState>>,
    Query(q): Query<online::SearchQuery>,
) -> ApiResult<Json<online::SearchPage>> {
    let source = q.source.clone();
    tagged(&source, online::search(&online_ctx(&state), q).await).map(Json)
}

#[derive(Debug, Deserialize)]
struct StreamQuery {
    source: Option<String>,
    id: String,
    /// 目标码率（bps）；不传时用 320k
    quality: Option<u32>,
}

async fn online_stream(
    State(state): State<Arc<AppState>>,
    Query(q): Query<StreamQuery>,
) -> ApiResult<Json<online::StreamInfo>> {
    let source = source_of(q.source);
    // GET 形态没有 track_ref，平台模块按 id 回落取流。
    tagged(
        &source,
        online::stream(&online_ctx(&state), &source, &q.id, None, q.quality).await,
    )
    .map(Json)
}

#[derive(Debug, Deserialize)]
struct ItemQuery {
    source: Option<String>,
    id: String,
}

/// 单曲详情（封面等）。搜索结果里的封面常常缺失，播放前用它补齐。
async fn online_detail(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ItemQuery>,
) -> ApiResult<Json<online::OnlineDetail>> {
    let source = source_of(q.source);
    tagged(
        &source,
        online::detail(&online_ctx(&state), &source, &q.id).await,
    )
    .map(Json)
}

/// 在线歌词。返回体与 `/v1/tracks/{id}/lyrics` 同形，前端可直接使用。
/// 无歌词/无权限时返回**空文档**（200），不报错——缺失是常态而非异常。
async fn online_lyric(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ItemQuery>,
) -> ApiResult<Json<vmusic_core::LyricDocument>> {
    let source = source_of(q.source);
    tagged(
        &source,
        online::lyric(&online_ctx(&state), &source, &q.id).await,
    )
    .map(Json)
}

#[derive(Debug, Deserialize)]
struct OnlinePlayRequest {
    source: Option<String>,
    /// 旧单曲形态的曲目 id；新整盘形态只给 tracks。两者都缺时回 400。
    #[serde(default)]
    id: Option<String>,
    /// 旧单曲形态的元数据回显字段。
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    duration_ms: Option<u64>,
    // Task 9 起音质以服务端逐源偏好（settings online_quality）为权威，请求体
    // 里的单次 quality 不再读取；保留字段以兼容旧客户端入参，待播放端点版本
    // 演进时连同旧单曲形态一起评估移除。
    #[allow(dead_code)]
    quality: Option<u32>,
    /// 整盘形态：一整首歌单/专辑的曲目列表，当前曲由 index 指定。
    #[serde(default)]
    tracks: Option<Vec<OnlinePlayTrack>>,
    #[serde(default)]
    index: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct OnlinePlayTrack {
    id: String,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    duration_ms: Option<u64>,
    cover: Option<String>,
    /// 搜索/歌单结果里随曲目带来的平台原始引用（QQ media_mid 等），
    /// 取流时原样透传给平台模块；JSON 字段名与 OnlineTrack 一致为 ref。
    ///
    /// Task 9 起队列只存虚拟 id、播放按稳定 id 取流，暂不读取本字段；
    /// 仍须接收以免 serde 拒绝前端载荷，后续首曲最优音质透传恢复时启用。
    #[serde(default, rename = "ref")]
    #[allow(dead_code)]
    track_ref: Option<online::TrackRef>,
}

async fn online_quality_get(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<serde_json::Value>> {
    let prefs = online::quality::load(&state.db)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    let sources = ["netease", "qq", "kugou", "qishui", "ccmixter"];
    Ok(Json(serde_json::json!({
        "prefs": sources.iter().map(|s| {
            let q = online::quality::get(&prefs, s);
            serde_json::json!({
                "source": s,
                "selected": q.as_str(),
                "options": online::quality::allowed_for(s).iter().map(|c|
                    serde_json::json!({"value": c.as_str(), "label": c.label()})
                ).collect::<Vec<_>>(),
            })
        }).collect::<Vec<_>>()
    })))
}

#[derive(Debug, Deserialize)]
struct OnlineQualityRequest {
    source: String,
    quality: String,
}

async fn online_quality_set(
    State(state): State<Arc<AppState>>,
    Json(body): Json<OnlineQualityRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    if !["netease", "qq", "kugou", "qishui", "ccmixter"].contains(&body.source.as_str()) {
        return Err(bad_request("不支持的音源"));
    }
    let mut prefs = online::quality::load(&state.db)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    let q = online::quality::save_source(&state.db, &mut prefs, &body.source, &body.quality)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    // 内存偏好表同步热更新：play_index_for 读这张表决定取流码率，不热更的话
    // 要等重启才生效。
    state.quality.lock().await.insert(body.source.clone(), q);
    Ok(Json(
        serde_json::json!({ "source": body.source, "selected": q.as_str() }),
    ))
}

/// 在线试听：先把整盘虚拟 id 占进队列，再交给 play_index_for 按服务端音质
/// 偏好在线取流、边下边播，提交链路与本地曲目完全相同。
///
/// 队列必须先占：stream/下载是数秒级 await，期间用户可能改点别的。早 set_queue
/// 立即顶代际并挂出新队列，起播调用回来后凭代际复核——已被顶掉的迟到结果静默
/// 收在当前播放器状态上，绝不允许整盘换回、把用户后来选的曲盖掉。
///
/// 队列只存虚拟 id、不存 track_ref，所以 play_index_for 按稳定 id 回落取流，
/// 可能拿不到最优音质——这是队列状态机的有意取舍，不在本端点扩大。
async fn online_play(
    State(state): State<Arc<AppState>>,
    Json(body): Json<OnlinePlayRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let source = source_of(body.source);

    // 归一两种入站形态：整盘 tracks 优先；旧单曲 {id,+元数据} 包成长度 1。
    let mut tracks = body.tracks.unwrap_or_default();
    if tracks.is_empty() {
        let id = body.id.as_deref().unwrap_or("").trim().to_string();
        if id.is_empty() {
            return Err(bad_request("缺少曲目 id"));
        }
        tracks.push(OnlinePlayTrack {
            id,
            title: body.title,
            artist: body.artist,
            album: body.album,
            duration_ms: body.duration_ms,
            cover: None,
            track_ref: None,
        });
    }
    // virtual_id 必须能反解出非空 id，任何一项空都在入队前拒绝。
    if tracks.iter().any(|t| t.id.trim().is_empty()) {
        return Err(bad_request("tracks 中存在缺少 id 的曲目"));
    }
    let index = pick_index(body.index, tracks.len());
    let current = &tracks[index];

    let vids: Vec<String> = tracks
        .iter()
        .map(|t| online::virtual_id(&source, &t.id))
        .collect();

    // 先占队列再起播（见函数文档）。set_queue 原子地顶代际并挂出新队列；
    // 起播窗口里被顶代际则由 play_index_for 的预留复核静默收在「当前」播放器
    // 状态上。占队前的 (queue, cursor) 快照（第 2、3 个返回值）已无消费方：
    // Task 9 后起播失败由 state::online_failed 收口（cursor 回退由它负责），
    // 不再整盘还原队列，故这里只取代际。
    //
    // 取流与渐进式下载全部在 play_index_for 内按服务端音质偏好完成；首曲不再
    // 走「先整首下载预热」的旧路径——那会让首曲下两遍。
    let (gen, _, _) = state.set_queue(vids.clone(), Some(index)).await;

    // 整盘元数据入内存暂存：play_index_for 提交成功后据此写历史（在线曲的
    // URL 会过期，历史只存元数据快照，重播时重新实时取流）。
    {
        let mut meta = state.online_meta.lock().await;
        for (t, vid) in tracks.iter().zip(vids.iter()) {
            meta.insert(
                vid.clone(),
                crate::state::OnlineMetaSnap {
                    title: t.title.clone().unwrap_or_else(|| t.id.clone()),
                    artist: t.artist.clone(),
                    album: t.album.clone(),
                    cover: t.cover.clone(),
                    duration_ms: t.duration_ms.filter(|v| *v > 0),
                },
            );
        }
    }

    let outcome = state.play_index_for(index, Some(gen), false).await?;
    if !outcome.committed {
        return Ok(get_state(State(state.clone())).await);
    }
    // 首曲确认起播：后台预取后一首 + LRU（play_index_for 内部不预取）。
    state.post_commit_background();

    // 封面：整盘曲目通常已带 cover；缺失时补一次详情。补不到不算失败——
    // 前端有占位图，不能让一张图片拖垮整次播放。
    let ctx = online_ctx(&state);
    let cover = match &current.cover {
        Some(c) if !c.is_empty() => Some(c.clone()),
        _ => online::detail(&ctx, &source, &current.id)
            .await
            .ok()
            .and_then(|d| d.cover),
    };

    Ok(Json(serde_json::json!({
        "ok": true,
        "track_id": vids[index],
        // 前端 Task 18 用它填充队列 UI，避免再拼一遍虚拟 id。
        "track_ids": vids,
        "index": index,
        "source": source,
        "id": current.id,
        "title": current.title.clone().unwrap_or_default(),
        "artist": current.artist.clone().unwrap_or_default(),
        "album": current.album.clone().unwrap_or_default(),
        "duration_ms": current.duration_ms.unwrap_or(0),
        "cover": cover,
        // 平台实际给到的音质档位（缓存命中/预取接管时为 null）。
        "actual_quality": outcome.actual_quality.map(|q| q.as_str()),
    })))
}

// ---------------------------------------------------------------------------
// 在线曲库：账号 / 歌单 / 红心 / 推荐
//
// 全部是薄转发：校验入参 → 过能力闸门（在 online::dispatch 内）→ 回统一 DTO。
// 任何写操作失败都直接透传 ApiError，绝不伪造空成功。
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct PlaylistsQuery {
    source: String,
    scope: Option<String>,
    #[serde(default)]
    offset: usize,
    #[serde(default = "default_page_limit")]
    limit: usize,
}

fn default_page_limit() -> usize {
    30
}

async fn online_playlists(
    State(state): State<Arc<AppState>>,
    Query(q): Query<PlaylistsQuery>,
) -> ApiResult<Json<Vec<online::OnlinePlaylist>>> {
    let scope = playlist_scope(q.scope)?;
    let limit = q.limit.clamp(1, 50);
    tagged(
        &q.source,
        online::playlists(&online_ctx(&state), &q.source, &scope, q.offset, limit).await,
    )
    .map(Json)
}

#[derive(Debug, Deserialize)]
struct PlaylistQuery {
    source: String,
    id: String,
    #[serde(default)]
    offset: usize,
    #[serde(default = "default_page_limit")]
    limit: usize,
}

async fn online_playlist(
    State(state): State<Arc<AppState>>,
    Query(q): Query<PlaylistQuery>,
) -> ApiResult<Json<online::PlaylistDetail>> {
    let limit = q.limit.clamp(1, 50);
    tagged(
        &q.source,
        online::playlist_detail(&online_ctx(&state), &q.source, &q.id, q.offset, limit).await,
    )
    .map(Json)
}

#[derive(Debug, Deserialize)]
struct PlaylistCreateRequest {
    source: String,
    name: String,
}

async fn online_playlist_create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PlaylistCreateRequest>,
) -> ApiResult<Json<online::OnlinePlaylist>> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(bad_request("歌单名不能为空"));
    }
    tagged(
        &body.source,
        online::playlist_create(&online_ctx(&state), &body.source, name).await,
    )
    .map(Json)
}

#[derive(Debug, Deserialize)]
struct PlaylistDeleteRequest {
    source: String,
    id: String,
}

async fn online_playlist_delete(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PlaylistDeleteRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    if body.id.trim().is_empty() {
        return Err(bad_request("缺少歌单 id"));
    }
    tagged(
        &body.source,
        online::playlist_delete(&online_ctx(&state), &body.source, &body.id).await,
    )?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
struct PlaylistTracksRequest {
    source: String,
    id: String,
    tracks: Vec<online::TrackEntry>,
}

async fn online_playlist_add(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PlaylistTracksRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    if body.id.trim().is_empty() {
        return Err(bad_request("缺少歌单 id"));
    }
    if body.tracks.is_empty() {
        return Err(bad_request("没有要添加的曲目"));
    }
    tagged(
        &body.source,
        online::playlist_add(&online_ctx(&state), &body.source, &body.id, &body.tracks).await,
    )?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn online_playlist_remove(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PlaylistTracksRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    if body.id.trim().is_empty() {
        return Err(bad_request("缺少歌单 id"));
    }
    if body.tracks.is_empty() {
        return Err(bad_request("没有要移除的曲目"));
    }
    tagged(
        &body.source,
        online::playlist_remove(&online_ctx(&state), &body.source, &body.id, &body.tracks).await,
    )?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
struct LikeRequest {
    source: String,
    id: String,
    liked: bool,
}

async fn online_like(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LikeRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    if body.id.trim().is_empty() {
        return Err(bad_request("缺少曲目 id"));
    }
    tagged(
        &body.source,
        online::like(&online_ctx(&state), &body.source, &body.id, body.liked).await,
    )?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
struct RecommendQuery {
    source: String,
    #[serde(default)]
    offset: usize,
    #[serde(default = "default_page_limit")]
    limit: usize,
}

async fn online_rec_songs(
    State(state): State<Arc<AppState>>,
    Query(q): Query<RecommendQuery>,
) -> ApiResult<Json<Vec<online::OnlineTrack>>> {
    let limit = q.limit.clamp(1, 50);
    tagged(
        &q.source,
        online::recommend_songs(&online_ctx(&state), &q.source, q.offset, limit).await,
    )
    .map(Json)
}

async fn online_rec_playlists(
    State(state): State<Arc<AppState>>,
    Query(q): Query<RecommendQuery>,
) -> ApiResult<Json<Vec<online::OnlinePlaylist>>> {
    let limit = q.limit.clamp(1, 50);
    tagged(
        &q.source,
        online::recommend_playlists(&online_ctx(&state), &q.source, q.offset, limit).await,
    )
    .map(Json)
}

#[derive(Debug, Deserialize)]
struct SearchAllQuery {
    q: String,
    #[serde(default = "default_page_limit")]
    limit: usize,
}

async fn online_search_all(
    State(state): State<Arc<AppState>>,
    Query(q): Query<SearchAllQuery>,
) -> ApiResult<Json<online::AggregateSearch>> {
    // 路由层先夹到 30（聚合要并发打全部源），dispatch 内还有 1..=50 的兜底。
    online::search_all(&online_ctx(&state), q.q.trim(), q.limit.clamp(1, 30))
        .await
        .map(Json)
}

// ---------------------------------------------------------------------------
// 在线曲库：扫码登录
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct SourceRequest {
    source: String,
    /// QQ 专用："qq"（默认）或 "wx"（微信扫码）。
    #[serde(default)]
    channel: Option<String>,
}

async fn online_qr_start(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SourceRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    // 平台握手票绝不离开服务端：进 Registry 换成不透明 ticket，
    // 前端轮询/取消只认 ticket。
    let payload = tagged(
        &body.source,
        online::qr_start(&online_ctx(&state), &body.source, body.channel.as_deref()).await,
    )?;
    let ticket = state.qr.start(&body.source, payload.platform_ticket).await;
    Ok(Json(serde_json::json!({
        "ticket": ticket,
        "qr_text": payload.qr_text,
        "qr_image": payload.qr_image,
        "poll_ms": payload.poll_ms,
    })))
}

#[derive(Debug, Deserialize)]
struct QrPollQuery {
    source: String,
    ticket: String,
}

async fn online_qr_poll(
    State(state): State<Arc<AppState>>,
    Query(q): Query<QrPollQuery>,
) -> ApiResult<Json<online::QrPoll>> {
    let sess = qr_session(&q.source, state.qr.take(&q.ticket).await)?;
    // 终态直接回本地票态、不再打上游：confirmed/expired 不可回退，QQ 的
    // check_sig 是一次性凭证，confirmed 后重放只会报错并可能逼票态降级。
    // account 在首次 confirmed 响应里已带过，前端见终态即停止轮询。
    if online::qr::is_terminal(&sess.state) {
        return Ok(Json(online::QrPoll {
            state: sess.state,
            account: None,
        }));
    }
    let (state_name, account) = tagged(
        &q.source,
        online::qr_poll(&online_ctx(&state), &q.source, &sess.platform_ticket).await,
    )?;
    // 平台已确认时凭据由平台模块自己写入 cred 保险库；这里只同步票态。
    // 上游调用失败时不更新票态，让前端按原节奏继续轮询；Registry 自身
    // 再挡一道：终态不会被任何上游返回降级。
    state.qr.update(&q.ticket, &state_name).await;
    Ok(Json(online::QrPoll {
        state: state_name,
        account,
    }))
}

#[derive(Debug, Deserialize)]
struct QrCancelRequest {
    source: String,
    /// 前端关弹窗时总会调一次 cancel（可能从未拿到票）；空票按幂等成功处理。
    #[serde(default)]
    ticket: String,
}

async fn online_qr_cancel(
    State(state): State<Arc<AppState>>,
    Json(body): Json<QrCancelRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    if !body.ticket.is_empty() {
        // 取消同样要验源：不能拿一个源的 ticket 去删另一个源的会话。
        if let Some(sess) = state.qr.take(&body.ticket).await {
            if sess.source != body.source {
                return Err(bad_request("二维码会话与音源不匹配，请重新扫码"));
            }
            state.qr.cancel(&body.ticket).await;
        }
        // 票已过期/不存在：cancel 本就是幂等清理，返回成功即可。
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
struct AccountQuery {
    source: String,
}

async fn online_account(
    State(state): State<Arc<AppState>>,
    Query(q): Query<AccountQuery>,
) -> ApiResult<Json<online::AccountInfo>> {
    tagged(
        &q.source,
        online::account(&online_ctx(&state), &q.source).await,
    )
    .map(Json)
}

#[cfg(test)]
mod tests {
    use super::{pick_index, playlist_scope, qr_session, query_token};

    #[test]
    fn token_is_read_from_a_query_string() {
        assert_eq!(query_token(Some("token=abc123")).as_deref(), Some("abc123"));
        assert_eq!(
            query_token(Some("source=netease&token=abc123&id=9")).as_deref(),
            Some("abc123")
        );
    }

    #[test]
    fn absent_or_empty_token_is_none() {
        assert_eq!(query_token(None), None);
        assert_eq!(query_token(Some("id=9")).as_deref(), None);
        // 空串会被原样取出来，交给上层和真实 token 比对后落到 401 分支。
        // 这里不特殊处理，是为了让"没带 token"和"带了个错的 token"走同一条路径。
        assert_eq!(query_token(Some("token=")).as_deref(), Some(""));
    }

    #[test]
    fn playlist_scope_defaults_and_whitelists() {
        assert_eq!(playlist_scope(None).unwrap(), "created");
        assert_eq!(playlist_scope(Some("liked".into())).unwrap(), "liked");
        // 非法 scope 必须 400，不能被平台模块静默当成「全部歌单」。
        let err = playlist_scope(Some("friends".into())).unwrap_err();
        assert_eq!(err.status, 400);
    }

    #[test]
    fn pick_index_clamps_out_of_range() {
        assert_eq!(pick_index(None, 5), 0);
        assert_eq!(pick_index(Some(2), 5), 2);
        // 越界（前端分页后传来旧下标）夹到最后一首而非报错。
        assert_eq!(pick_index(Some(99), 5), 4);
        // 空列表不允许下溢 panic：两个分支都收 0。
        assert_eq!(pick_index(None, 0), 0);
        assert_eq!(pick_index(Some(0), 0), 0);
    }

    #[test]
    fn qr_session_rejects_missing_and_cross_source_tickets() {
        // 过期/未知票：400 引导重新扫码。
        assert_eq!(qr_session("netease", None).unwrap_err().status, 400);

        let sess = crate::online::qr::Session {
            source: "qq".into(),
            state: "waiting".into(),
            created_ms: 0,
            platform_ticket: "pt".into(),
        };
        // A 平台的票不能投到 B 平台的 qr_check。
        assert_eq!(
            qr_session("netease", Some(sess.clone()))
                .unwrap_err()
                .status,
            400
        );
        // 同源放行，平台票原样可取。
        let ok = qr_session("qq", Some(sess)).unwrap();
        assert_eq!(ok.platform_ticket, "pt");
    }
}
