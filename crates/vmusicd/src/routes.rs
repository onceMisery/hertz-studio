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
        // 在线曲库：搜索与试听地址都由服务端代发，浏览器绕不开第三方接口的
        // CORS 与 Referer 校验。
        .route("/v1/online/sources", get(online_sources))
        .route("/v1/online/search", get(online_search))
        .route("/v1/online/stream", get(online_stream))
        .route("/v1/online/detail", get(online_detail))
        .route("/v1/online/lyric", get(online_lyric))
        .route("/v1/online/play", post(online_play))
        .route("/v1/online/cookie", post(online_cookie))
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
    Json(serde_json::to_value(state.audio.snapshot()).unwrap_or_default())
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
    Ok(get_state(State(state)).await)
}

async fn previous(State(state): State<Arc<AppState>>) -> ApiResult<Json<serde_json::Value>> {
    state.step(-1, false).await?;
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

/// 设置表里存的是「用户在音源站点的登录 cookie」。这类键有三条规矩：
/// 不出现在 `GET /v1/settings` 里、不能从 `PUT /v1/settings` 写进去、
/// 改它只能走 `/v1/online/cookie`（那里才校验得了音源是否真的支持登录）。
fn is_credential(key: &str) -> bool {
    key.starts_with(online::COOKIE_PREFIX)
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
    let signed_in = !value.is_empty();
    vmusic_store::settings::set(
        &state.db,
        &format!("{}{}", online::COOKIE_PREFIX, body.source),
        &serde_json::Value::String(value),
    )
    .await
    .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    // 只回布尔：原文一旦回到前端，就可能进日志、进截图、进用户粘贴到别处的
    // 那段文本里。
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
    online::search(&online_ctx(&state), q).await.map(Json)
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
    online::stream(&online_ctx(&state), &source, &q.id, q.quality)
        .await
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
    online::detail(&online_ctx(&state), &source, &q.id)
        .await
        .map(Json)
}

/// 在线歌词。返回体与 `/v1/tracks/{id}/lyrics` 同形，前端可直接使用。
/// 无歌词/无权限时返回**空文档**（200），不报错——缺失是常态而非异常。
async fn online_lyric(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ItemQuery>,
) -> ApiResult<Json<vmusic_core::LyricDocument>> {
    let source = source_of(q.source);
    online::lyric(&online_ctx(&state), &source, &q.id)
        .await
        .map(Json)
}

#[derive(Debug, Deserialize)]
struct OnlinePlayRequest {
    source: Option<String>,
    id: String,
    /// 搜索结果里的元数据。服务端不保存这些字段（队列里只有虚拟 id），
    /// 带过来只是为了在返回体里回显，方便前端对齐。
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    duration_ms: Option<u64>,
    quality: Option<u32>,
}

/// 在线试听。
///
/// 拿到试听地址 → 落盘缓存 → 用虚拟 id 走一遍和本地曲目完全相同的 load 链路。
/// 队列里只放这一个 id：在线曲目没有「上一首 / 下一首」的语境，播完即停，
/// 不假装自己混在本地队列里。
async fn online_play(
    State(state): State<Arc<AppState>>,
    Json(body): Json<OnlinePlayRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let source = source_of(body.source);
    let ctx = online_ctx(&state);
    let info = online::stream(&ctx, &source, &body.id, body.quality).await?;
    let dir = state.online_cache_dir();
    let path = online::fetch_to_cache(&dir, &source, &body.id, &info.url).await?;
    let uri = path
        .to_str()
        .ok_or_else(|| ApiError::internal("缓存路径含非 UTF-8 字符".to_string()))?;

    let vid = online::virtual_id(&source, &body.id);
    state.set_queue(vec![vid.clone()], Some(0)).await;
    state
        .audio
        .load(uri, Some(vid.clone()))
        .await
        .map_err(vmusic_core::CoreError::Audio)?;
    state
        .audio
        .play()
        .await
        .map_err(vmusic_core::CoreError::Audio)?;
    state.publish(crate::state::WsEvent::State(state.audio.snapshot()));

    // 封面在搜索结果里经常缺失，这里主动补一次详情。
    // 补不到也不算失败——前端有占位图，不能让一张图片拖垮整次播放。
    let cover = online::detail(&ctx, &source, &body.id)
        .await
        .map(|d| d.cover)
        .unwrap_or(None);

    Ok(Json(serde_json::json!({
        "ok": true,
        "track_id": vid,
        "source": source,
        "id": body.id,
        "title": body.title.unwrap_or_default(),
        "artist": body.artist.unwrap_or_default(),
        "album": body.album.unwrap_or_default(),
        "duration_ms": body.duration_ms.unwrap_or(0),
        "cover": cover,
    })))
}

#[cfg(test)]
mod tests {
    use super::query_token;

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
}
