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
use axum::routing::{get, post, put};
use axum::{middleware, Json, Router};
use serde::{Deserialize, Serialize};
use vmusic_core::{PlayMode, PROTOCOL_VERSION};

use crate::daily;
use crate::error::{bad_request, internal, not_found, unauthorized, ApiError, ApiResult};
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
        .route("/v1/player/dsp", get(get_dsp).post(set_dsp))
        .route("/v1/devices", get(devices))
        .route("/v1/devices/select", post(select_device))
        .route("/v1/tracks", get(list_tracks))
        .route("/v1/tracks/ids", get(list_track_ids))
        .route("/v1/tracks/facets", get(track_facets))
        .route("/v1/tracks/batch-edit", post(batch_edit_tracks))
        .route("/v1/tracks/batch-delete", post(batch_delete_tracks))
        .route("/v1/tracks/missing", get(list_missing_tracks))
        .route("/v1/tracks/{id}", get(get_track))
        .route("/v1/tracks/{id}/cover", get(get_cover).post(replace_cover))
        .route(
            "/v1/tracks/{id}/edit",
            get(get_track_edit).delete(clear_track_edit),
        )
        .route(
            "/v1/tracks/{id}/lyrics",
            get(get_lyrics).put(import_lyrics).delete(clear_lyrics),
        )
        .route("/v1/tracks/{id}/lyrics/offset", put(set_lyrics_offset))
        .route("/v1/library/scan", post(start_scan))
        .route("/v1/library/status", get(scan_status))
        .route("/v1/library/scan/cancel", post(cancel_scan))
        .route(
            "/v1/library/roots",
            get(library_roots)
                .post(add_library_root)
                .put(update_library_root)
                .delete(remove_library_root),
        )
        .route("/v1/playlists", get(list_playlists).post(create_playlist))
        .route("/v1/playlists/import-m3u", post(import_m3u_route))
        .route("/v1/backup", get(export_backup))
        .route("/v1/backup/restore", post(restore_backup))
        .route(
            "/v1/playlists/{id}",
            get(noop).put(rename_playlist).delete(delete_playlist),
        )
        .route("/v1/playlists/{id}/m3u", get(export_playlist_m3u))
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
        .route("/v1/online/cache", get(online_cache_stats))
        .route("/v1/online/cache/clear", post(online_cache_clear))
        .route("/v1/online/cache/keep", post(online_cache_keep))
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
        // 节拍地图：200 完整地图 / 202 分析中 / 404 不可用（前端静默回落 onset）。
        .route("/v1/stage/beatmap", get(beatmap))
        .layer(middleware::from_fn_with_state(state.clone(), require_token));

    Router::new().route("/v1/health", get(health)).merge(api)
}

// ---------------------------------------------------------------------------
// 舞台节拍地图
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(super) struct BeatmapQuery {
    track: String,
}

/// 三态响应手写状态码与 JSON 体：404 体是 `{status,reason}` 而不是标准
/// ApiError 的 `{error}`，前端按 err.status / body.status 分流，不弹错。
async fn beatmap(State(state): State<Arc<AppState>>, Query(q): Query<BeatmapQuery>) -> Response {
    match crate::stage_beats::request_on_demand(&state, &q.track).await {
        crate::stage_beats::Outcome::Ready { map, cached } => {
            let mut value = serde_json::to_value(&map).unwrap_or(serde_json::Value::Null);
            if let Some(obj) = value.as_object_mut() {
                obj.insert("cached".into(), serde_json::Value::Bool(cached));
            }
            (StatusCode::OK, Json(value)).into_response()
        }
        crate::stage_beats::Outcome::Analyzing => (
            StatusCode::ACCEPTED,
            Json(serde_json::json!({ "status": "analyzing" })),
        )
            .into_response(),
        crate::stage_beats::Outcome::Unavailable(reason) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "status": "unavailable",
                "reason": reason.as_str(),
            })),
        )
            .into_response(),
    }
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
    /// Optional per-id metadata snapshot for online queue entries. 重启后从
    /// 歌单/收藏整单播放时，客户端持有快照而服务端内存 `online_meta` 已清空；
    /// 不注入的话播放历史的标题会退化成平台 id。仅接受合法虚拟 id 的键。
    #[serde(default)]
    pub meta: Option<std::collections::HashMap<String, crate::state::OnlineMetaSnap>>,
}

async fn load(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LoadRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    if let Some(meta) = &body.meta {
        let mut online_meta = state.online_meta.lock().await;
        for (id, snap) in meta {
            if crate::online::split_virtual_id(id).is_some() {
                online_meta.insert(id.clone(), snap.clone());
            }
        }
    }
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


/// 读取 DSP 设置（EQ/preamp/响度归一化/交叉淡化）。
async fn get_dsp(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<serde_json::Value>> {
    let settings = vmusic_store::settings::get_all(&state.db)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    let cfg = crate::state::DspConfig::from_settings(&settings);
    Ok(Json(serde_json::to_value(&cfg).map_err(|e| internal(e.to_string()))?))
}

#[derive(Deserialize)]
struct DspUpdate {
    eq_gains_db: Option<[f32; 6]>,
    preamp_db: Option<f32>,
    loudness_norm: Option<bool>,
    crossfade_ms: Option<u64>,
}

/// 更新 DSP 设置并即时下发到音频后端；交叉淡化同步换装/尾淡出时长。
async fn set_dsp(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DspUpdate>,
) -> ApiResult<Json<serde_json::Value>> {
    let settings = vmusic_store::settings::get_all(&state.db)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    let mut cfg = crate::state::DspConfig::from_settings(&settings);
    if let Some(eq) = body.eq_gains_db {
        cfg.eq_gains_db = eq;
        cfg.clamp_eq();
    }
    if let Some(pre) = body.preamp_db {
        cfg.preamp_db = pre.clamp(-24.0, 12.0);
    }
    if let Some(l) = body.loudness_norm {
        cfg.loudness_norm = l;
    }
    if let Some(ms) = body.crossfade_ms {
        cfg.crossfade_ms = ms.min(8000);
    }
    let eq_json = serde_json::json!(cfg.eq_gains_db);
    vmusic_store::settings::set(&state.db, "dsp_eq", &eq_json)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    for (key, value) in [
        ("dsp_preamp", serde_json::json!(cfg.preamp_db)),
        ("dsp_loudness", serde_json::json!(cfg.loudness_norm)),
        ("dsp_crossfade_ms", serde_json::json!(cfg.crossfade_ms)),
    ] {
        vmusic_store::settings::set(&state.db, key, &value)
            .await
            .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    }
    // 即时生效：EQ/增益走 set_dsp，交叉淡化走 set_crossfade。
    let track_gain = if cfg.loudness_norm {
        state.current_rg_gain().await.unwrap_or(0.0) as f32
    } else {
        0.0
    };
    state
        .audio
        .set_dsp(vmusic_core::DspParams {
            eq_gains_db: cfg.eq_gains_db,
            preamp_db: cfg.preamp_db,
            track_gain_db: track_gain,
        })
        .await
        .ok();
    state.audio.set_crossfade(cfg.crossfade_ms).await.ok();
    Ok(Json(serde_json::to_value(&cfg).map_err(|e| internal(e.to_string()))?))
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
    pub sort: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    /// 专辑/歌手浏览：按覆盖后的展示值精确过滤。
    pub artist: Option<String>,
    pub album: Option<String>,
}

fn track_filter_from(query: &TrackQuery) -> vmusic_store::TrackFilter {
    vmusic_store::TrackFilter {
        artist: query.artist.as_deref().filter(|v| !v.trim().is_empty()).map(String::from),
        album: query.album.as_deref().filter(|v| !v.trim().is_empty()).map(String::from),
    }
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
    let sort = parse_track_sort(query.sort.as_deref())?;
    let filter = track_filter_from(&query);
    let tracks = vmusic_store::list_tracks_filtered(
        &state.db, query.q.as_deref(), &filter, sort, limit, offset)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    let total = vmusic_store::count_tracks_filtered(&state.db, query.q.as_deref(), &filter)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    Ok(Json(TrackPage { total, tracks }))
}

fn parse_track_sort(value: Option<&str>) -> ApiResult<vmusic_store::TrackSort> {
    vmusic_store::TrackSort::parse(value.unwrap_or("title"))
        .ok_or_else(|| bad_request("sort must be title, artist, album or added"))
}

async fn list_track_ids(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TrackQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    let sort = parse_track_sort(query.sort.as_deref())?;
    let filter = track_filter_from(&query);
    let ids = vmusic_store::list_track_ids_filtered(&state.db, query.q.as_deref(), &filter, sort)
        .await
        .map_err(store_err)?;
    Ok(Json(serde_json::json!({ "track_ids": ids })))
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

/// 专辑/歌手浏览面：名字与计数来自覆盖后的展示值，按曲目数排序。
async fn track_facets(
    State(state): State<Arc<AppState>>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> ApiResult<Json<serde_json::Value>> {
    let kind = q.get("kind").map(String::as_str).unwrap_or("artist");
    let values = vmusic_store::list_track_facets(&state.db, kind)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    let facets: Vec<serde_json::Value> = values
        .into_iter()
        .map(|(name, count)| serde_json::json!({ "name": name, "count": count }))
        .collect();
    Ok(Json(serde_json::json!({ "kind": kind, "facets": facets })))
}

#[derive(Deserialize)]
struct BatchEditRequest {
    track_ids: Vec<String>,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
}

/// 批量编辑：只写请求里出现的字段，其余字段不动（不覆盖各自已有编辑）。
async fn batch_edit_tracks(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BatchEditRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    if body.track_ids.is_empty() {
        return Err(bad_request("track_ids must not be empty"));
    }
    let input = vmusic_store::track_edits::EditInput {
        title: body.title,
        artist: body.artist,
        album: body.album,
    };
    let changed = vmusic_store::track_edits::apply_batch(&state.db, &body.track_ids, &input)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    Ok(Json(serde_json::json!({ "ok": true, "changed": changed })))
}

/// 单曲编辑覆盖读取（UI 回显用）。
async fn get_track_edit(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let edit = vmusic_store::track_edits::get(&state.db, &id)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    Ok(Json(serde_json::json!({ "edit": edit })))
}

/// 重置编辑：删掉覆盖行，回到文件标签。
async fn clear_track_edit(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<serde_json::Value>> {
    vmusic_store::track_edits::remove(&state.db, &id)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// 替换封面：请求体即图片字节，Content-Type 决定扩展名。写缓存文件并打
/// cover_edited 标记，增量扫描跳过内嵌封面重写，用户封面不会被盖回去。
async fn replace_cover(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> ApiResult<Json<serde_json::Value>> {
    if body.is_empty() {
        return Err(bad_request("cover body must not be empty"));
    }
    let media_type = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    let ext = match media_type.as_str() {
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "jpg",
    };
    let file_id = id.clone();
    let dir = state.cover_dir();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        for old_ext in ["jpg", "png", "webp", "gif"] {
            let _ = std::fs::remove_file(dir.join(format!("{file_id}.{old_ext}")));
        }
        std::fs::write(dir.join(format!("{file_id}.{ext}")), &body).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| bad_request(e.to_string()))?
    .map_err(bad_request)?;
    vmusic_store::track_edits::set_cover_edited(&state.db, &id, true)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    vmusic_store::set_has_cover(&state.db, &id, true)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    Ok(Json(serde_json::json!({ "ok": true, "cover_key": format!("{id}.{ext}") })))
}

/// 失效文件整理：文件已不存在的曲目清单（含路径，供界面确认）。
async fn list_missing_tracks(State(state): State<Arc<AppState>>) -> ApiResult<Json<serde_json::Value>> {
    let rows: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
        "SELECT t.id, t.path, COALESCE(NULLIF(TRIM(e.title), ''), t.title),          COALESCE(NULLIF(TRIM(e.artist), ''), t.artist)          FROM tracks t LEFT JOIN track_edits e ON e.track_id = t.id WHERE t.source = 'local'",
    )
    .fetch_all(&state.db)
    .await
    .map_err(|e| bad_request(e.to_string()))?;
    let missing: Vec<serde_json::Value> =
        tokio::task::spawn_blocking(move || {
            rows.into_iter()
                .filter(|(_, path, _, _)| !std::path::Path::new(path).is_file())
                .map(|(id, path, title, artist)| {
                    serde_json::json!({ "id": id, "path": path, "title": title, "artist": artist })
                })
                .collect()
        })
        .await
        .map_err(|e| bad_request(e.to_string()))?;
    Ok(Json(serde_json::json!({ "missing": missing, "total": missing.len() })))
}

/// 批量删除（失效整理的执行端点）：删曲目行并清理封面缓存文件。
async fn batch_delete_tracks(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BatchDeleteRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    if body.track_ids.is_empty() {
        return Err(bad_request("track_ids must not be empty"));
    }
    let deleted = vmusic_store::delete_tracks(&state.db, &body.track_ids)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    let dir = state.cover_dir();
    tokio::task::spawn_blocking(move || {
        for id in &body.track_ids {
            for ext in ["jpg", "png", "webp", "gif"] {
                let _ = std::fs::remove_file(dir.join(format!("{id}.{ext}")));
            }
        }
    })
    .await
    .ok();
    Ok(Json(serde_json::json!({ "ok": true, "deleted": deleted })))
}

#[derive(Deserialize)]
struct BatchDeleteRequest {
    track_ids: Vec<String>,
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

/// 本地曲目歌词读取，来源优先级固定为 imported > embedded > sidecar：
/// - imported：用户手动导入/关联、存在数据库里的 LRC 原文（用户明确指定的赢）；
/// - embedded：音频容器内嵌的歌词标签，每次实时从文件解析，永远与文件同步；
/// - sidecar：同目录同名 `.lrc`（既有行为，不破坏）。
///
/// 每曲用户偏移与文件自身的 `[offset:]` 标签叠加：total = file_offset + user，
/// 读取端一次应用。响应体额外带 `user_offset_ms` 供 UI 显示与调整。
async fn get_lyrics(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let track = vmusic_store::get_track(&state.db, &id)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?
        .ok_or_else(|| not_found(format!("track {id}")))?;

    let saved = vmusic_store::lyrics::get(&state.db, &id)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    let user_offset = saved.as_ref().map(|s| s.offset_ms).unwrap_or(0);

    let path = Path::new(&track.path);
    let (mut doc, imported) = match saved.filter(|s| !s.content.trim().is_empty()) {
        Some(saved) => (vmusic_lyrics::parse_lrc(&saved.content), true),
        None => (read_embedded_or_sidecar_lyrics(path).await, false),
    };
    doc.offset_ms += user_offset;
    vmusic_lyrics::apply_offset(&mut doc);

    let body = serde_json::to_value(&doc).map_err(|e| internal(e.to_string()))?;
    let mut body = match body {
        serde_json::Value::Object(map) => map,
        _ => unreachable!("LyricDocument serializes to an object"),
    };
    if imported {
        body.insert(
            "source".into(),
            serde_json::Value::String("imported".into()),
        );
    }
    body.insert(
        "user_offset_ms".into(),
        serde_json::Value::from(user_offset),
    );
    Ok(Json(serde_json::Value::Object(body)))
}

/// 无手动导入时的回退链：容器内嵌歌词标签 → 同目录 sidecar `.lrc`。
async fn read_embedded_or_sidecar_lyrics(path: &Path) -> vmusic_core::LyricDocument {
    let embedded = {
        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || {
            vmusic_library::read_metadata(&path).ok().and_then(|m| m.lyrics)
        })
        .await
        .unwrap_or(None)
    };
    if let Some(text) = embedded {
        let mut doc = vmusic_lyrics::parse_lrc(&text);
        if !doc.lines.is_empty() {
            doc.source = vmusic_core::LyricSource::Embedded;
            return doc;
        }
    }
    match vmusic_library::find_sidecar_lyrics(path) {
        Some(lrc) => match tokio::fs::read_to_string(&lrc).await {
            Ok(text) => vmusic_lyrics::parse_lrc(&text),
            Err(e) => {
                tracing::debug!("cannot read {}: {e}", lrc.display());
                vmusic_core::LyricDocument::empty()
            }
        },
        None => vmusic_core::LyricDocument::empty(),
    }
}

#[derive(Deserialize)]
struct LyricsImport {
    content: String,
}

/// 手动导入歌词：存 LRC 原文，读取端按 imported 优先返回。清空内容用 DELETE。
async fn import_lyrics(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<LyricsImport>,
) -> ApiResult<Json<serde_json::Value>> {
    if body.content.trim().is_empty() {
        return Err(bad_request("lyrics content must not be empty"));
    }
    vmusic_store::lyrics::import(&state.db, &id, &body.content)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    Ok(Json(serde_json::json!({ "ok": true, "source": "imported" })))
}

/// 清除手动导入（偏移一并删除），歌词回退到内嵌/sidecar。
async fn clear_lyrics(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<serde_json::Value>> {
    vmusic_store::lyrics::remove(&state.db, &id)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
struct LyricsOffset {
    offset_ms: i64,
}

/// 保存每曲歌词偏移（毫秒），与歌词来源无关，重启后保留。
async fn set_lyrics_offset(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<LyricsOffset>,
) -> ApiResult<Json<serde_json::Value>> {
    vmusic_store::lyrics::set_offset(&state.db, &id, body.offset_ms)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    Ok(Json(serde_json::json!({ "ok": true, "offset_ms": body.offset_ms })))
}

#[derive(Deserialize)]
pub struct ScanRequest {
    pub root: String,
}

async fn start_scan(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ScanRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    scan::start(state, Path::new(&body.root).to_path_buf())
        .await
        .map_err(bad_request)?;
    Ok(Json(serde_json::json!({ "started": true })))
}

async fn cancel_scan(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    scan::cancel(&state).await;
    Json(serde_json::json!({ "ok": true }))
}

async fn library_roots(State(state): State<Arc<AppState>>) -> ApiResult<Json<serde_json::Value>> {
    let roots = vmusic_store::scan_roots::list(&state.db)
        .await
        .map_err(store_err)?;
    Ok(Json(serde_json::json!({ "roots": roots })))
}

#[derive(Deserialize)]
struct LibraryRootRequest {
    path: String,
    enabled: Option<bool>,
}

async fn add_library_root(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LibraryRootRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let root = tokio::task::spawn_blocking(move || scan::normalize_root(Path::new(&body.path)))
        .await
        .map_err(|error| bad_request(error.to_string()))?
        .map_err(bad_request)?;
    vmusic_store::scan_roots::upsert(
        &state.db,
        &root.to_string_lossy(),
        body.enabled.unwrap_or(true),
    )
    .await
    .map_err(store_err)?;
    library_roots(State(state)).await
}

async fn update_library_root(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LibraryRootRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let enabled = body
        .enabled
        .ok_or_else(|| bad_request("enabled is required"))?;
    let roots = vmusic_store::scan_roots::list(&state.db)
        .await
        .map_err(store_err)?;
    if !roots.iter().any(|root| root.path == body.path) {
        return Err(not_found("music directory"));
    }
    vmusic_store::scan_roots::set_enabled(&state.db, &body.path, enabled)
        .await
        .map_err(store_err)?;
    if !enabled {
        scan::cancel_root(&state, &body.path).await;
    }
    library_roots(State(state)).await
}

async fn remove_library_root(
    State(state): State<Arc<AppState>>,
    Query(body): Query<LibraryRootRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    vmusic_store::scan_roots::remove(&state.db, &body.path)
        .await
        .map_err(store_err)?;
    scan::cancel_root(&state, &body.path).await;
    library_roots(State(state)).await
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
    /// 纯 id 形态（本地曲库右键入单走这里，保持旧契约）。
    pub track_ids: Option<Vec<String>>,
    /// 富形态：在线曲目随单携带元数据快照。`source` 缺省或为 `local` 时按
    /// 本地 id 处理，不写快照。
    #[serde(default)]
    pub tracks: Vec<PlaylistTrackInput>,
}

#[derive(Deserialize)]
pub struct PlaylistTrackInput {
    pub id: String,
    pub source: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: Option<u64>,
    pub cover: Option<String>,
}

/// 把入站条目折成 (track_id, 快照)。在线身份沿用 `online:<source>:<id>` 协议：
/// 客户端传平台 id 时在此拼虚拟 id，传过来的已是虚拟 id 则原样保留。
fn normalize_playlist_entries(
    body: PlaylistTracks,
) -> Result<Vec<(String, Option<vmusic_store::playlists::TrackMeta>)>, ApiError> {
    let mut entries = Vec::new();
    for id in body.track_ids.unwrap_or_default() {
        entries.push((id, None));
    }
    for input in body.tracks {
        let id = input.id.trim().to_string();
        if id.is_empty() {
            return Err(bad_request("tracks 中存在缺少 id 的条目"));
        }
        let source = input
            .source
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "local");
        let (track_id, meta) = match source {
            None => (id, None),
            Some(source) => {
                let title = input.title.unwrap_or_default();
                if title.trim().is_empty() && input.artist.is_none() && input.cover.is_none() {
                    // 没有任何元数据的在线条目存了也无法渲染：明确拒绝，
                    // 不让一条空快照混进歌单。
                    return Err(bad_request("在线曲目缺少可存的元数据"));
                }
                let vid = if id.starts_with("online:") {
                    id.clone()
                } else {
                    online::virtual_id(source, &id)
                };
                let meta = vmusic_store::playlists::TrackMeta {
                    source: source.to_string(),
                    title: if title.trim().is_empty() { id.clone() } else { title },
                    artist: input.artist,
                    album: input.album,
                    duration_ms: input.duration_ms.map(|v| v as i64),
                    cover: input.cover,
                };
                (vid, Some(meta))
            }
        };
        entries.push((track_id, meta));
    }
    if entries.is_empty() {
        return Err(bad_request("没有可加入的曲目"));
    }
    Ok(entries)
}

async fn add_to_playlist(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<PlaylistTracks>,
) -> ApiResult<Json<serde_json::Value>> {
    let entries = normalize_playlist_entries(body)?;
    vmusic_store::playlists::add_entries(&state.db, &id, &entries)
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
/// Both shapes are returned: `track_ids` mirrors the write body, `tracks`
/// saves the client a round trip per id. 解析顺序按身份协议分层：本地 id 走
/// tracks 表实时字段（标签编辑、换封面后歌单跟着变）；`online:` 虚拟 id 回
/// 退到入单时的快照行（重启后显示与顺序不丢）；两者都拿不到的 id 只保留在
/// `track_ids` 里，客户端渲染占位行。
async fn get_playlist_tracks(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let entries = vmusic_store::playlists::list_entries(&state.db, &id)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    let ids: Vec<String> = entries.iter().map(|e| e.track_id.clone()).collect();

    let mut tracks = Vec::with_capacity(entries.len());
    for entry in &entries {
        if let Some(track) = vmusic_store::get_track(&state.db, &entry.track_id)
            .await
            .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?
        {
            tracks.push(serde_json::to_value(track).map_err(|e| internal(e.to_string()))?);
            continue;
        }
        if let Some(meta) = &entry.meta {
            tracks.push(serde_json::json!({
                "id": entry.track_id,
                "source": meta.source,
                "title": meta.title,
                "artist": meta.artist,
                "album": meta.album,
                "duration_ms": meta.duration_ms,
                "has_cover": false,
                "cover": meta.cover,
            }));
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

/// 导出用户数据备份（JSON）。不含凭据：凭据只存系统钥匙串。
async fn export_backup(State(state): State<Arc<AppState>>) -> ApiResult<Json<serde_json::Value>> {
    let backup = vmusic_store::backup::export(&state.db)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    let value = serde_json::to_value(&backup).map_err(|e| internal(e.to_string()))?;
    Ok(Json(value))
}

/// 恢复备份：格式校验失败 400，单事务写入，幂等。
async fn restore_backup(
    State(state): State<Arc<AppState>>,
    Json(body): Json<vmusic_store::backup::BackupFile>,
) -> ApiResult<Json<serde_json::Value>> {
    let report = vmusic_store::backup::restore(&state.db, &body)
        .await
        .map_err(|e| bad_request(e.to_string()))?;
    Ok(Json(serde_json::to_value(&report).map_err(|e| internal(e.to_string()))?))
}

/// 歌单导出为 M3U8 文本（在线曲没有本地路径，不输出）。
async fn export_playlist_m3u(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Result<axum::response::Response, ApiError> {
    let text = vmusic_store::backup::export_m3u(&state.db, &id)
        .await
        .map_err(|e| bad_request(e.to_string()))?;
    match text {
        Some(text) => Ok((
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "audio/x-mpegurl; charset=utf-8"),
                (
                    header::CONTENT_DISPOSITION,
                    format!(r#"attachment; filename="playlist-{id}.m3u8""#).as_str(),
                ),
            ],
            text,
        )
            .into_response()),
        None => Err(not_found("playlist")),
    }
}

#[derive(Deserialize)]
struct ImportM3uRequest {
    name: String,
    content: String,
}

/// 导入 M3U：路径精确匹配本地曲目，未命中行计入 skipped。
async fn import_m3u_route(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ImportM3uRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    if body.name.trim().is_empty() {
        return Err(bad_request("name must not be empty"));
    }
    let result = vmusic_store::backup::import_m3u(&state.db, &body.name, &body.content)
        .await
        .map_err(|e| bad_request(e.to_string()))?;
    match result {
        Some((playlist_id, added, skipped)) => Ok(Json(serde_json::json!({
            "ok": true,
            "playlist_id": playlist_id,
            "added": added,
            "skipped": skipped,
        }))),
        None => Err(bad_request("content is not an M3U playlist")),
    }
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
    offset: Option<i64>,
    /// 来源筛选（local / netease / ...），空 = 全部。
    source: Option<String>,
    /// 标题/歌手/专辑子串搜索。
    q: Option<String>,
}

async fn history_list(
    State(state): State<Arc<AppState>>,
    Query(q): Query<HistoryQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let offset = q.offset.unwrap_or(0).max(0);
    let (items, total) =
        crate::history::list_filtered(&state.db, q.q.as_deref(), q.source.as_deref(), limit, offset)
            .await
            .map_err(ApiError::internal)?;
    Ok(Json(serde_json::json!({ "items": items, "total": total })))
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

/// 缓存占用展示：总量/文件数/按音源分组 + 配置上限 + 用户保留名单。
async fn online_cache_stats(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<serde_json::Value>> {
    let stats = crate::online::cache::cache_stats(&state.online_cache_dir()).await;
    let keep = state.keep.lock().await.clone();
    let max = state.config.online.cache_max_bytes;
    Ok(Json(serde_json::json!({
        "total_bytes": stats.total_bytes,
        "files": stats.files,
        "by_source": stats.by_source,
        "max_bytes": max,
        "keep": keep,
    })))
}

#[derive(Deserialize)]
struct CacheClearRequest {
    /// 省略 = 全部音源；指定 = 只清该音源。
    source: Option<String>,
}

/// 手动清理：当前播放与用户保留项豁免，返回删除字节数。
async fn online_cache_clear(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CacheClearRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    if let Some(src) = &body.source {
        if src.trim().is_empty() {
            return Err(bad_request("source must not be empty"));
        }
    }
    let protected = state.protected_all().await;
    let dir = state.online_cache_dir();
    let source = body.source.clone();
    let removed = tokio::task::spawn_blocking(move || {
        tokio::runtime::Handle::current().block_on(async {
            crate::online::cache::clear_cache(&dir, &protected, source.as_deref()).await
        })
    })
    .await
    .map_err(|e| bad_request(e.to_string()))?
    .map_err(|e| internal(e.to_string()))?;
    Ok(Json(serde_json::json!({ "ok": true, "removed_bytes": removed })))
}

#[derive(Deserialize)]
struct CacheKeepRequest {
    source: String,
    id: String,
    keep: bool,
}

/// 指定内容保留/取消保留：以 `{stem}.` 前缀写入豁免名单并持久化，
/// 覆盖该曲目全部音质档。LRU 与手动清理都尊重它。
async fn online_cache_keep(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CacheKeepRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    if body.source.trim().is_empty() || body.id.trim().is_empty() {
        return Err(bad_request("source and id are required"));
    }
    // 保留粒度是「曲目全部音质档」：文件名形如 {stem}-{quality}.{ext}，
    // 豁免名单按 `{stem}-` 前缀匹配。代价是 id 前缀撞车（保留 1 会连带
    // 豁免 10/100）——多保留几首比误删用户想留的歌便宜。
    let stem = {
        let sanitized: String = format!("{}-{}", body.source.trim(), body.id.trim())
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        format!("{sanitized}-")
    };
    let mut keep = state.keep.lock().await;
    if body.keep {
        if !keep.iter().any(|k| k == &stem) {
            keep.push(stem.clone());
        }
    } else {
        keep.retain(|k| k != &stem);
    }
    let snapshot = keep.clone();
    drop(keep);
    crate::persist::save_strings(&state.db, "online_keep", &snapshot)
        .await
        .map_err(|e| bad_request(e.to_string()))?;
    Ok(Json(serde_json::json!({ "ok": true, "keep": snapshot })))
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
