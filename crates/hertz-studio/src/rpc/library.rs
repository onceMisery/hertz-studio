// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 曲库域：曲目列表与编辑、封面、歌词、扫描根目录与进度、设置、收藏、播放历史。
//!
//! 逐个对应 `routes.rs` 里的同名 handler，逻辑照抄（理由见 `rpc/mod.rs`）。请求体
//! 结构与 `favorite_meta`、`track_filter_from`、`is_credential` 这些真正承载语义的
//! helper 直接复用 `routes` 那一份，不在这里重写第二遍。
//!
//! # 与 HTTP 版的三处真实差异
//!
//! 1. **封面是二进制**。HTTP 版 GET 直接回图片字节、POST 收裸 body；信封是 JSON，
//!    所以 GET 回 `{data: base64, content_type}`、POST 从 `raw_base64` 取字节。前端
//!    `ensureCover` 拼的正是 `data:<content_type>;base64,<data>`。
//! 2. **路径参数自己 parse**。axum 的 `Path<i64>` 解析失败给 400，这里必须同样给
//!    400 而不是 404——否则「删掉第 abc 条历史」会报成「查无此条」，前端按 404
//!    静默处理就把一个真实的参数错误咽下去了。
//! 3. **DELETE 的查询参数**。`/v1/library/roots?path=…` 这种把入参放 query 的
//!    DELETE，信封里同样在 `query` 上，取法与 GET 一致。

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::daily;
use crate::error::{bad_request, internal, not_found, ApiError};
use crate::routes::{
    favorite_meta, favorite_target, is_credential, parse_track_sort, store_err, track_filter_from,
    BatchDeleteRequest, BatchEditRequest, FavoriteBody, FavoritesQuery, HistoryQuery,
    LibraryRootRequest, LyricsImport, LyricsOffset, MembershipRequest, ScanRequest, ToggleRequest,
    TrackQuery, FAV_PAGE, FAV_PAGE_MAX,
};
use crate::rpc::{body_as, encode_base64, query_as, query_str, RawBody, Reply, RpcResult};
use crate::scan;
use crate::state::AppState;

// ---------------------------------------------------------------------------
// 曲目
// ---------------------------------------------------------------------------

pub async fn list_tracks(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let query: TrackQuery = query_as(query)?;
    let limit = query.limit.unwrap_or(200).clamp(1, 1000);
    let offset = query.offset.unwrap_or(0).max(0);
    let sort = parse_track_sort(query.sort.as_deref())?;
    let filter = track_filter_from(&query);
    let tracks = vmusic_store::list_tracks_filtered(
        &state.db,
        query.q.as_deref(),
        &filter,
        sort,
        limit,
        offset,
    )
    .await
    .map_err(store_err)?;
    let total = vmusic_store::count_tracks_filtered(&state.db, query.q.as_deref(), &filter)
        .await
        .map_err(store_err)?;
    Ok(Reply::ok(json!({ "total": total, "tracks": tracks })))
}

pub async fn list_track_ids(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let query: TrackQuery = query_as(query)?;
    let sort = parse_track_sort(query.sort.as_deref())?;
    let filter = track_filter_from(&query);
    let ids = vmusic_store::list_track_ids_filtered(&state.db, query.q.as_deref(), &filter, sort)
        .await
        .map_err(store_err)?;
    Ok(Reply::ok(json!({ "track_ids": ids })))
}

pub async fn get_track(state: &Arc<AppState>, id: &str) -> RpcResult {
    let track = vmusic_store::get_track(&state.db, &id.to_string())
        .await
        .map_err(store_err)?
        .ok_or_else(|| not_found(format!("track {id}")))?;
    Ok(Reply::ok(
        serde_json::to_value(&track).map_err(|e| internal(e.to_string()))?,
    ))
}

/// 专辑/歌手浏览面：名字与计数来自覆盖后的展示值，按曲目数排序。
pub async fn track_facets(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let kind = query_str(query, "kind").unwrap_or("artist");
    let values = vmusic_store::list_track_facets(&state.db, kind)
        .await
        .map_err(store_err)?;
    let facets: Vec<Value> = values
        .into_iter()
        .map(|(name, count)| json!({ "name": name, "count": count }))
        .collect();
    Ok(Reply::ok(json!({ "kind": kind, "facets": facets })))
}

/// 批量编辑：只写请求里出现的字段，其余字段不动（不覆盖各自已有编辑）。
pub async fn batch_edit_tracks(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: BatchEditRequest = body_as(body)?;
    if request.track_ids.is_empty() {
        return Err(bad_request("track_ids must not be empty"));
    }
    let input = vmusic_store::track_edits::EditInput {
        title: request.title,
        artist: request.artist,
        album: request.album,
    };
    let changed = vmusic_store::track_edits::apply_batch(&state.db, &request.track_ids, &input)
        .await
        .map_err(store_err)?;
    Ok(Reply::ok(json!({ "ok": true, "changed": changed })))
}

pub async fn get_track_edit(state: &Arc<AppState>, id: &str) -> RpcResult {
    let edit = vmusic_store::track_edits::get(&state.db, id)
        .await
        .map_err(store_err)?;
    Ok(Reply::ok(json!({ "edit": edit })))
}

/// 重置编辑：删掉覆盖行，回到文件标签。
pub async fn clear_track_edit(state: &Arc<AppState>, id: &str) -> RpcResult {
    vmusic_store::track_edits::remove(&state.db, id)
        .await
        .map_err(store_err)?;
    Ok(Reply::ok(json!({ "ok": true })))
}

pub async fn list_missing_tracks(state: &Arc<AppState>) -> RpcResult {
    let missing = crate::routes::missing_local_tracks(state).await?;
    Ok(Reply::ok(
        json!({ "missing": missing, "total": missing.len() }),
    ))
}

/// 批量删除（失效整理的执行端点）：删曲目行并清理封面缓存文件。
pub async fn batch_delete_tracks(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: BatchDeleteRequest = body_as(body)?;
    if request.track_ids.is_empty() {
        return Err(bad_request("track_ids must not be empty"));
    }
    // 与 HTTP 版同一道准入：清封面缓存会拿 id 拼路径，非法 id 整批拒掉。
    if let Some(bad) = request
        .track_ids
        .iter()
        .find(|id| crate::routes::safe_cover_id(id).is_none())
    {
        return Err(bad_request(format!("invalid cover id: {bad}")));
    }
    let deleted = vmusic_store::delete_tracks(&state.db, &request.track_ids)
        .await
        .map_err(store_err)?;
    let dir = state.cover_dir();
    let ids = request.track_ids;
    tokio::task::spawn_blocking(move || {
        for id in &ids {
            for ext in ["jpg", "png", "webp", "gif"] {
                let _ = std::fs::remove_file(dir.join(format!("{id}.{ext}")));
            }
        }
    })
    .await
    .ok();
    Ok(Reply::ok(json!({ "ok": true, "deleted": deleted })))
}

// ---------------------------------------------------------------------------
// 封面
// ---------------------------------------------------------------------------

/// 四种扩展名按固定顺序探测，与 HTTP 版一致：换封面时会先把其余三种删掉，
/// 所以同一时刻至多命中一个。
fn find_cover(dir: &Path, id: &str) -> Option<(std::path::PathBuf, &'static str)> {
    ["jpg", "png", "webp", "gif"].into_iter().find_map(|ext| {
        let path = dir.join(format!("{id}.{ext}"));
        path.is_file().then_some((path, ext))
    })
}

fn cover_mime(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/jpeg",
    }
}

/// 没有封面给 204（体为 null），与 HTTP 版同口径：前端 `ensureCover` 把
/// 「没有 data」和「取失败」都当成无封面，不会让整行渲染失败。
pub async fn get_cover(state: &Arc<AppState>, id: &str) -> RpcResult {
    // 非法 id 是真实的参数错误，不能落进 `no_content` 被前端当成「没有封面」咽下去
    // （同本模块开头对 `Path<i64>` 解析失败给 400 的理由）。
    let Some(id) = crate::routes::safe_cover_id(id) else {
        return Err(not_found("cover id must be a uuid"));
    };
    let found = find_cover(&state.cover_dir(), id);
    let Some((path, ext)) = found else {
        return Ok(Reply::no_content());
    };
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| internal(e.to_string()))?;
    Ok(Reply::ok(json!({
        "data": encode_base64(&bytes),
        "content_type": cover_mime(ext),
    })))
}

/// 替换封面：信封里的 base64 即图片字节，`raw_content_type` 决定扩展名。写缓存
/// 文件并打 cover_edited 标记，增量扫描跳过内嵌封面重写，用户封面不会被盖回去。
pub async fn replace_cover(state: &Arc<AppState>, id: &str, raw: Option<&RawBody>) -> RpcResult {
    let id =
        crate::routes::safe_cover_id(id).ok_or_else(|| bad_request("cover id must be a uuid"))?;
    let raw = raw.ok_or_else(|| bad_request("cover body must not be empty"))?;
    if raw.bytes.is_empty() {
        return Err(bad_request("cover body must not be empty"));
    }
    let ext = match raw.content_type.as_str() {
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "jpg",
    };
    let dir = state.cover_dir();
    let file_id = id.to_string();
    let bytes = raw.bytes.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        for old_ext in ["jpg", "png", "webp", "gif"] {
            let _ = std::fs::remove_file(dir.join(format!("{file_id}.{old_ext}")));
        }
        std::fs::write(dir.join(format!("{file_id}.{ext}")), &bytes).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| bad_request(e.to_string()))?
    .map_err(bad_request)?;
    vmusic_store::track_edits::set_cover_edited(&state.db, id, true)
        .await
        .map_err(store_err)?;
    vmusic_store::set_has_cover(&state.db, &id.to_string(), true)
        .await
        .map_err(store_err)?;
    Ok(Reply::ok(
        json!({ "ok": true, "cover_key": format!("{id}.{ext}") }),
    ))
}

// ---------------------------------------------------------------------------
// 歌词
// ---------------------------------------------------------------------------

/// 本地曲目歌词读取，来源优先级固定为 imported > embedded > sidecar；每曲用户
/// 偏移与文件自身的 `[offset:]` 标签叠加（total = file_offset + user）。
pub async fn get_lyrics(state: &Arc<AppState>, id: &str) -> RpcResult {
    let track = vmusic_store::get_track(&state.db, &id.to_string())
        .await
        .map_err(store_err)?
        .ok_or_else(|| not_found(format!("track {id}")))?;

    let saved = vmusic_store::lyrics::get(&state.db, id)
        .await
        .map_err(store_err)?;
    let user_offset = saved.as_ref().map(|s| s.offset_ms).unwrap_or(0);

    let path = Path::new(&track.path);
    let (mut doc, imported) = match saved.filter(|s| !s.content.trim().is_empty()) {
        Some(saved) => (vmusic_lyrics::parse_lrc(&saved.content), true),
        None => (
            crate::routes::read_embedded_or_sidecar_lyrics(path).await,
            false,
        ),
    };
    doc.offset_ms += user_offset;
    vmusic_lyrics::apply_offset(&mut doc);

    let mut body = match serde_json::to_value(&doc).map_err(|e| internal(e.to_string()))? {
        Value::Object(map) => map,
        _ => unreachable!("LyricDocument serializes to an object"),
    };
    if imported {
        body.insert("source".into(), Value::String("imported".into()));
    }
    body.insert("user_offset_ms".into(), Value::from(user_offset));
    Ok(Reply::ok(Value::Object(body)))
}

/// 手动导入歌词：存 LRC 原文，读取端按 imported 优先返回。清空内容用 DELETE。
pub async fn import_lyrics(state: &Arc<AppState>, id: &str, body: &Value) -> RpcResult {
    let request: LyricsImport = body_as(body)?;
    if request.content.trim().is_empty() {
        return Err(bad_request("lyrics content must not be empty"));
    }
    vmusic_store::lyrics::import(&state.db, id, &request.content)
        .await
        .map_err(store_err)?;
    Ok(Reply::ok(json!({ "ok": true, "source": "imported" })))
}

/// 清除手动导入（偏移一并删除），歌词回退到内嵌/sidecar。
pub async fn clear_lyrics(state: &Arc<AppState>, id: &str) -> RpcResult {
    vmusic_store::lyrics::remove(&state.db, id)
        .await
        .map_err(store_err)?;
    Ok(Reply::ok(json!({ "ok": true })))
}

/// 保存每曲歌词偏移（毫秒），与歌词来源无关，重启后保留。
pub async fn set_lyrics_offset(state: &Arc<AppState>, id: &str, body: &Value) -> RpcResult {
    let request: LyricsOffset = body_as(body)?;
    vmusic_store::lyrics::set_offset(&state.db, id, request.offset_ms)
        .await
        .map_err(store_err)?;
    Ok(Reply::ok(
        json!({ "ok": true, "offset_ms": request.offset_ms }),
    ))
}

// ---------------------------------------------------------------------------
// 扫描：根目录与进度
// ---------------------------------------------------------------------------

pub async fn library_roots(state: &Arc<AppState>) -> RpcResult {
    let roots = vmusic_store::scan_roots::list(&state.db)
        .await
        .map_err(store_err)?;
    Ok(Reply::ok(json!({ "roots": roots })))
}

pub async fn add_library_root(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: LibraryRootRequest = body_as(body)?;
    let enabled = request.enabled.unwrap_or(true);
    let root = tokio::task::spawn_blocking(move || scan::normalize_root(Path::new(&request.path)))
        .await
        .map_err(|error| bad_request(error.to_string()))?
        .map_err(bad_request)?;
    vmusic_store::scan_roots::upsert(&state.db, &root.to_string_lossy(), enabled)
        .await
        .map_err(store_err)?;
    library_roots(state).await
}

pub async fn update_library_root(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: LibraryRootRequest = body_as(body)?;
    let enabled = request
        .enabled
        .ok_or_else(|| bad_request("enabled is required"))?;
    let roots = vmusic_store::scan_roots::list(&state.db)
        .await
        .map_err(store_err)?;
    if !roots.iter().any(|root| root.path == request.path) {
        return Err(not_found("music directory"));
    }
    vmusic_store::scan_roots::set_enabled(&state.db, &request.path, enabled)
        .await
        .map_err(store_err)?;
    if !enabled {
        scan::cancel_root(state, &request.path).await;
    }
    library_roots(state).await
}

/// 删除的入参在 query 上（`?path=…`），HTTP 版用 `Query<LibraryRootRequest>` 抽取，
/// 这里走同一个结构体，缺 path 同样 400。
pub async fn remove_library_root(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let request: LibraryRootRequest = query_as(query)?;
    let path = request.path;
    vmusic_store::scan_roots::remove(&state.db, &path)
        .await
        .map_err(store_err)?;
    scan::cancel_root(state, &path).await;
    library_roots(state).await
}

pub async fn start_scan(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: ScanRequest = body_as(body)?;
    scan::start(state.clone(), Path::new(&request.root).to_path_buf())
        .await
        .map_err(bad_request)?;
    Ok(Reply::ok(json!({ "started": true })))
}

pub async fn cancel_scan(state: &Arc<AppState>) -> RpcResult {
    scan::cancel(state).await;
    Ok(Reply::ok(json!({ "ok": true })))
}

pub async fn scan_status(state: &Arc<AppState>) -> RpcResult {
    let progress = state.scan.lock().await.clone();
    Ok(Reply::ok(
        serde_json::to_value(&progress).map_err(|e| internal(e.to_string()))?,
    ))
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

/// 凭据只进不出：过滤规则与 HTTP 版共用 `is_credential`，两边不会一边漏一边不漏。
pub async fn get_settings(state: &Arc<AppState>) -> RpcResult {
    let values = vmusic_store::settings::get_all(&state.db)
        .await
        .map_err(store_err)?;
    let public: Value = values
        .into_iter()
        .filter(|(key, _)| !is_credential(key))
        .collect::<serde_json::Map<_, _>>()
        .into();
    Ok(Reply::ok(public))
}

pub async fn put_settings(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: std::collections::BTreeMap<String, Value> = body_as(body)?;
    if let Some(key) = request.keys().find(|k| is_credential(k)) {
        return Err(bad_request(format!(
            "{key} 属于音源凭据，只能通过 /v1/online/cookie 修改"
        )));
    }
    vmusic_store::settings::set_all(&state.db, &request)
        .await
        .map_err(store_err)?;
    Ok(Reply::ok(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// 收藏
// ---------------------------------------------------------------------------

pub async fn list_favorites(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let q: FavoritesQuery = query_as(query)?;
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
    Ok(Reply::ok(json!({
        "favorites": favorites,
        "total": total,
        "offset": offset,
        "limit": limit,
        "counts": { "track": track_count, "radio": radio_count },
    })))
}

pub async fn add_favorite(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: FavoriteBody = body_as(body)?;
    let (kind, source, ref_id) = favorite_target(&request)?;
    let meta = favorite_meta(&state.db, &request, kind, &source, &ref_id).await?;
    let favorite = vmusic_store::favorites::add(&state.db, kind, &source, &ref_id, &meta)
        .await
        .map_err(store_err)?;
    Ok(Reply::ok(
        json!({ "favorite": favorite, "favorited": true }),
    ))
}

pub async fn remove_favorite(state: &Arc<AppState>, id: &str) -> RpcResult {
    let removed = vmusic_store::favorites::remove(&state.db, id)
        .await
        .map_err(store_err)?;
    // 取消一个不存在的收藏按成功处理：前端的心形按钮可能在刷新竞态下连点两次。
    Ok(Reply::ok(json!({ "ok": true, "removed": removed })))
}

/// 红心开关。返回**最终态**而不是「操作成功」：按钮的乐观更新需要知道结果是什么。
pub async fn toggle_favorite(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: ToggleRequest = body_as(body)?;
    let (kind, source, ref_id) = favorite_target(&request.body)?;
    let id = vmusic_store::favorites::identity(kind, &source, &ref_id);
    let existing = vmusic_store::favorites::get(&state.db, &id)
        .await
        .map_err(store_err)?;
    let want = request.favorited.unwrap_or(existing.is_none());

    if !want {
        vmusic_store::favorites::remove(&state.db, &id)
            .await
            .map_err(store_err)?;
        return Ok(Reply::ok(
            json!({ "favorited": false, "favorite": null, "id": id }),
        ));
    }

    let meta = favorite_meta(&state.db, &request.body, kind, &source, &ref_id).await?;
    let favorite = vmusic_store::favorites::add(&state.db, kind, &source, &ref_id, &meta)
        .await
        .map_err(store_err)?;
    Ok(Reply::ok(
        json!({ "favorited": true, "favorite": favorite, "id": id }),
    ))
}

/// 批量判断「这一屏里哪些已收藏」。曲库一屏 200 行，逐行问一次是 200 次往返。
pub async fn favorite_membership(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: MembershipRequest = body_as(body)?;
    let kind = daily::parse_kind(&request.kind)?;
    let source = request.source.trim().to_string();
    if source.is_empty() {
        return Err(bad_request("缺少 source"));
    }
    if request.ids.is_empty() {
        return Ok(Reply::ok(json!({ "ids": [] })));
    }
    // 上限与曲库分页对齐：超出就是前端构造错了，不该让 SQL 参数无限膨胀。
    if request.ids.len() > FAV_PAGE_MAX as usize {
        return Err(bad_request(format!("ids 数量超过上限 {}", FAV_PAGE_MAX)));
    }
    let ids: Vec<String> = request
        .ids
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let hit = vmusic_store::favorites::is_favorited(&state.db, kind, &source, &ids)
        .await
        .map_err(store_err)?;
    Ok(Reply::ok(json!({ "ids": hit })))
}

// ---------------------------------------------------------------------------
// 播放历史
// ---------------------------------------------------------------------------

pub async fn history_list(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let q: HistoryQuery = query_as(query)?;
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let offset = q.offset.unwrap_or(0).max(0);
    let (items, total) = crate::history::list_filtered(
        &state.db,
        q.q.as_deref(),
        q.source.as_deref(),
        limit,
        offset,
    )
    .await
    .map_err(ApiError::internal)?;
    Ok(Reply::ok(json!({ "items": items, "total": total })))
}

pub async fn history_clear(state: &Arc<AppState>) -> RpcResult {
    let removed = crate::history::clear(&state.db)
        .await
        .map_err(ApiError::internal)?;
    Ok(Reply::ok(json!({ "removed": removed })))
}

/// `id` 是 i64。axum 的 `Path<i64>` 解析失败给 400，这里必须同口径：给 404 的话
/// 一个参数错误会被前端当成「这条已经不在了」静默吞掉。
pub async fn history_remove(state: &Arc<AppState>, id: &str) -> RpcResult {
    let id = id
        .parse::<i64>()
        .map_err(|_| bad_request("历史记录 id 必须是整数"))?;
    let removed = crate::history::remove(&state.db, id)
        .await
        .map_err(ApiError::internal)?;
    if removed == 0 {
        return Err(not_found("历史记录不存在"));
    }
    Ok(Reply::ok(json!({ "removed": removed })))
}
