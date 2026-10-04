// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 歌单域：列表、新建、改名、删除、曲目增删与排序、M3U 导入导出。
//!
//! 逐个对应 `routes.rs` 里的同名 handler，逻辑照抄（理由见 `rpc/mod.rs`）。
//! `normalize_playlist_entries` 直接复用 routes 那一份：它承载「在线曲目拼虚拟
//! id + 落元数据快照」这套身份协议，两边各写一份迟早漂移，而漂移的表现是歌单里
//! 的在线曲目重启后变成一堆平台 id。
//!
//! # 与 HTTP 版的一处真实差异
//!
//! `GET {id}/m3u` 在 HTTP 上是 `audio/x-mpegurl` 纯文本加 Content-Disposition
//! 附件下载；信封只能装 JSON，所以这里把文本作为**裸 JSON 字符串**返回。前端只在
//! 插件形态下走这条 RPC（独立形态用 `window.open` 直连带 token 的下载链接），而它
//! 那边写的正是 `typeof text === 'string' ? text : ''`——裸字符串就是它要的。

use std::sync::Arc;

use serde_json::{json, Value};

use crate::error::{bad_request, internal, not_found};
use crate::routes::{
    normalize_playlist_entries, store_err, CreatePlaylist, ImportM3uRequest, PlaylistTracks,
    ReorderPlaylistTracks,
};
use crate::rpc::{body_as, Reply, RpcResult};
use crate::state::AppState;

pub async fn list_playlists(state: &Arc<AppState>) -> RpcResult {
    let playlists = vmusic_store::list_playlists(&state.db)
        .await
        .map_err(store_err)?;
    Ok(Reply::ok(json!({ "playlists": playlists })))
}

pub async fn create_playlist(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: CreatePlaylist = body_as(body)?;
    if request.name.trim().is_empty() {
        return Err(bad_request("name must not be empty"));
    }
    let playlist = vmusic_store::playlists::create(&state.db, request.name.trim())
        .await
        .map_err(store_err)?;
    // HTTP 版直接回 Playlist 对象本身、不包一层，前端 `transport.post` 拿到的
    // 就是它，所以这里也不能包。
    Ok(Reply::ok(
        serde_json::to_value(&playlist).map_err(|e| internal(e.to_string()))?,
    ))
}

pub async fn rename_playlist(state: &Arc<AppState>, id: &str, body: &Value) -> RpcResult {
    let request: CreatePlaylist = body_as(body)?;
    vmusic_store::playlists::rename(&state.db, &id.to_string(), request.name.trim())
        .await
        .map_err(store_err)?;
    Ok(Reply::ok(json!({ "ok": true })))
}

pub async fn delete_playlist(state: &Arc<AppState>, id: &str) -> RpcResult {
    vmusic_store::playlists::delete(&state.db, &id.to_string())
        .await
        .map_err(store_err)?;
    Ok(Reply::ok(json!({ "ok": true })))
}

/// 读取歌单内容，两种形状都回：`track_ids` 与写入体对称，`tracks` 省掉前端为每个
/// id 再跑一次往返。
///
/// 解析顺序按身份协议分层：本地 id 走 tracks 表的实时字段（标签编辑、换封面后
/// 歌单跟着变）；`online:` 虚拟 id 回退到入单时的快照行（重启后显示与顺序不丢）；
/// 两者都拿不到的 id 只保留在 `track_ids` 里，客户端渲染占位行。所以 `tracks` 的
/// 长度可以短于 `track_ids`——这不是 bug，前端就是按这个契约渲染的。
pub async fn get_playlist_tracks(state: &Arc<AppState>, id: &str) -> RpcResult {
    let entries = vmusic_store::playlists::list_entries(&state.db, &id.to_string())
        .await
        .map_err(store_err)?;
    let ids: Vec<String> = entries.iter().map(|e| e.track_id.clone()).collect();

    let mut tracks = Vec::with_capacity(entries.len());
    for entry in &entries {
        if let Some(track) = vmusic_store::get_track(&state.db, &entry.track_id)
            .await
            .map_err(store_err)?
        {
            tracks.push(serde_json::to_value(&track).map_err(|e| internal(e.to_string()))?);
            continue;
        }
        if let Some(meta) = &entry.meta {
            tracks.push(json!({
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

    Ok(Reply::ok(json!({ "track_ids": ids, "tracks": tracks })))
}

pub async fn add_to_playlist(state: &Arc<AppState>, id: &str, body: &Value) -> RpcResult {
    let request: PlaylistTracks = body_as(body)?;
    let entries = normalize_playlist_entries(request)?;
    vmusic_store::playlists::add_entries(&state.db, &id.to_string(), &entries)
        .await
        .map_err(store_err)?;
    Ok(Reply::ok(json!({ "ok": true })))
}

/// 整单重排。成员校验在 store 里：提交的 id 必须正好是当下成员的一个排列，
/// 多一个少一个都报错——排序请求里混进别的曲目等于一次静默的成员变更。
pub async fn reorder_playlist_tracks(state: &Arc<AppState>, id: &str, body: &Value) -> RpcResult {
    let request: ReorderPlaylistTracks = body_as(body)?;
    vmusic_store::playlists::reorder(&state.db, &id.to_string(), &request.track_ids)
        .await
        .map_err(store_err)?;
    Ok(Reply::ok(json!({ "ok": true })))
}

pub async fn remove_from_playlist(state: &Arc<AppState>, id: &str, track: &str) -> RpcResult {
    vmusic_store::playlists::remove_track(&state.db, &id.to_string(), &track.to_string())
        .await
        .map_err(store_err)?;
    Ok(Reply::ok(json!({ "ok": true })))
}

/// 导出为 M3U8 文本。在线曲没有本地路径，store 那边就不输出。
pub async fn export_m3u(state: &Arc<AppState>, id: &str) -> RpcResult {
    let text = vmusic_store::backup::export_m3u(&state.db, id)
        .await
        .map_err(|e| bad_request(e.to_string()))?;
    match text {
        Some(text) => Ok(Reply::ok(Value::String(text))),
        None => Err(not_found("playlist")),
    }
}

/// 导入 M3U：路径精确匹配本地曲目，未命中的行计入 skipped 而不是整单失败。
pub async fn import_m3u(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: ImportM3uRequest = body_as(body)?;
    if request.name.trim().is_empty() {
        return Err(bad_request("name must not be empty"));
    }
    let result = vmusic_store::backup::import_m3u(&state.db, &request.name, &request.content)
        .await
        .map_err(|e| bad_request(e.to_string()))?;
    match result {
        Some((playlist_id, added, skipped)) => Ok(Reply::ok(json!({
            "ok": true,
            "playlist_id": playlist_id,
            "added": added,
            "skipped": skipped,
        }))),
        None => Err(bad_request("content is not an M3U playlist")),
    }
}

/// `GET /v1/playlists/{id}` 在 HTTP 版是个 noop（axum 的 PUT|DELETE 组合需要挂一个
/// GET），照搬过来保持路由表一一对应。
pub async fn noop() -> RpcResult {
    Ok(Reply::ok(json!({ "ok": true })))
}
