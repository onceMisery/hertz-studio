// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 远程来源（WebDAV）：登记 / 浏览 / 导入。密码只进系统钥匙串，绝不入库。
//!
//! 逐个对应 `routes.rs` 里的同名 handler，逻辑照抄（理由见 `rpc/mod.rs`）。
//! `remote_cred_key` 复用 routes 那一份：它是钥匙串里的键名规则，两处各写一份，
//! 改了一边就等于把已存的密码丢了——读不到旧键，表现是「登记过的服务器突然要
//! 重新填密码」，而且没有任何报错。
//!
//! 浏览用的是实时 PROPFIND，条目不落库；只有用户显式「导入」的那几个文件才进
//! tracks 表（`source=remote`、`path` 存直链 URL）。所以这一域没有扫描进度可言。

use std::sync::Arc;

use serde_json::{json, Value};

use crate::error::{bad_request, internal, not_found, ApiError};
use crate::routes::{remote_cred_key, RemoteImportRequest, RemoteRootRequest};
use crate::rpc::{body_as, query_str, Reply, RpcResult};
use crate::state::AppState;

fn store_err(e: vmusic_core::StoreError) -> ApiError {
    ApiError::from(vmusic_core::CoreError::Store(e))
}

pub async fn list_roots(state: &Arc<AppState>) -> RpcResult {
    let roots = vmusic_store::remote_roots::list(&state.db)
        .await
        .map_err(store_err)?;
    Ok(Reply::ok(json!({ "roots": roots })))
}

pub async fn add_root(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: RemoteRootRequest = body_as(body)?;
    if request.name.trim().is_empty() || request.base_url.trim().is_empty() {
        return Err(bad_request("name and base_url are required"));
    }
    let url = reqwest::Url::parse(request.base_url.trim())
        .map_err(|_| bad_request("base_url must be an absolute http(s) URL"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(bad_request("base_url must be http(s)"));
    }
    let root = vmusic_store::remote_roots::create(
        &state.db,
        &request.name,
        &request.base_url,
        &request.username,
    )
    .await
    .map_err(store_err)?;
    // 密码只进钥匙串；memory 后端（CI）也不落盘。
    let cred = format!("{}:{}", request.username, request.password);
    let entry = crate::secrets::SecretEntry {
        cred: Some(cred),
        device: None,
    };
    crate::secrets::backend()
        .put(&remote_cred_key(&root.id), &entry)
        .map_err(|e| internal(e.to_string()))?;
    Reply::json(&root)
}

pub async fn delete_root(state: &Arc<AppState>, id: &str) -> RpcResult {
    let removed = vmusic_store::remote_roots::remove(&state.db, id)
        .await
        .map_err(store_err)?;
    if !removed {
        return Err(not_found("remote root"));
    }
    // 钥匙串残留必须清掉：登出语义与凭据一致性都靠它。
    crate::secrets::backend()
        .delete(&remote_cred_key(id))
        .map_err(|e| internal(e.to_string()))?;
    Ok(Reply::ok(json!({ "ok": true })))
}

/// 浏览：实时 PROPFIND。`is_audio` 供 UI 区分可导入的音频文件。
pub async fn browse_root(state: &Arc<AppState>, id: &str, query: &Value) -> RpcResult {
    let root = vmusic_store::remote_roots::get(&state.db, id)
        .await
        .map_err(store_err)?
        .ok_or_else(|| not_found("remote root"))?;
    let sub = query_str(query, "path")
        .map(str::to_string)
        .unwrap_or_else(|| "/".into());
    let auth = crate::remote::auth_for_url(
        &state.db,
        crate::secrets::backend().as_ref(),
        &root.base_url,
    )
    .await;
    let xml = crate::remote::propfind(&root.base_url, &sub, auth.as_ref())
        .await
        .map_err(bad_request)?;
    // 自条目跳过按「服务器绝对路径」比对：href 是服务器根相对的，而请求 path 是
    // 相对根 URL 的，先折算成服务器路径再传给解析器。
    let server_path = reqwest::Url::parse(&root.base_url)
        .map(|u| u.path().to_string())
        .unwrap_or_default();
    let joined = format!(
        "{}/{}",
        server_path.trim_end_matches('/'),
        sub.trim_start_matches('/')
    );
    let base = crate::remote::percent_decode(joined.trim_end_matches('/'));
    let entries = crate::remote::parse_propfind(&xml, &base)
        .ok_or_else(|| bad_request("响应不是 WebDAV 目录（multistatus）"))?;
    let entries: Vec<Value> = entries
        .into_iter()
        .map(|e| {
            json!({
                "path": e.path,
                "name": e.name,
                "is_dir": e.is_dir,
                "is_audio": !e.is_dir && crate::remote::is_audio_name(&e.name),
                "size": e.size,
                "mtime": e.mtime,
            })
        })
        .collect();
    Ok(Reply::ok(json!({ "entries": entries })))
}

/// 导入：把远程音频登记进曲库（source=remote，path=直链 URL，幂等）。
/// 播放时按 URL 前缀找到来源并从钥匙串取凭据，HTTP Range 直链取流。
pub async fn import_files(state: &Arc<AppState>, id: &str, body: &Value) -> RpcResult {
    let request: RemoteImportRequest = body_as(body)?;
    let root = vmusic_store::remote_roots::get(&state.db, id)
        .await
        .map_err(store_err)?
        .ok_or_else(|| not_found("remote root"))?;
    if request.paths.is_empty() {
        return Err(bad_request("paths must not be empty"));
    }
    let mut imported = 0u64;
    let mut skipped = 0u64;
    for path in &request.paths {
        if path.trim().is_empty() {
            skipped += 1;
            continue;
        }
        let name = path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or(path);
        let url = format!(
            "{}/{}",
            root.base_url.trim_end_matches('/'),
            path.trim_start_matches('/')
        );
        // 幂等：同一直链只登记一次。
        let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM tracks WHERE path = ?1")
            .bind(&url)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| bad_request(e.to_string()))?;
        if exists.is_some() {
            skipped += 1;
            continue;
        }
        let track = vmusic_core::Track {
            id: uuid::Uuid::new_v4().to_string(),
            path: url,
            source: vmusic_core::TrackSource::Remote,
            title: crate::remote::percent_decode(name),
            artist: None,
            album: Some(root.name.clone()),
            duration_ms: None,
            bitrate: None,
            sample_rate: None,
            channels: None,
            has_cover: false,
            file_mtime: None,
            file_size: None,
            added_at: vmusic_store::now_ms(),
        };
        vmusic_store::upsert_track(&state.db, &track)
            .await
            .map_err(store_err)?;
        imported += 1;
    }
    let _ = state.events.send(crate::state::WsEvent::LibraryChanged);
    Ok(Reply::ok(
        json!({ "ok": true, "imported": imported, "skipped": skipped }),
    ))
}
