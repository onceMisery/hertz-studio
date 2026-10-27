// SPDX-License-Identifier: MIT
//! Reader API; HTTP/DBX parity follows the podcasts facade.

use super::{body_as, encode_base64, query_as, Reply, RpcResult};
use crate::reader;
use crate::routes::{fetch_remote_image, online_ctx, public_https_url, tagged};
use crate::state::AppState;
use serde_json::{json, Value};
use std::sync::Arc;

pub async fn preview(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let body: reader::ReaderPreviewRequest = body_as(body)?;
    let preview = tagged(
        "reader",
        reader::preview(&online_ctx(state), &body.feed_url).await,
    )?;
    Ok(Reply::ok(json!({ "preview": preview })))
}

pub async fn subscriptions(state: &Arc<AppState>) -> RpcResult {
    let feeds = tagged("reader", reader::subscriptions(&online_ctx(state)).await)?;
    Ok(Reply::ok(json!({ "feeds": feeds })))
}

pub async fn subscribe(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let body: reader::ReaderSubscribeRequest = body_as(body)?;
    let feed = tagged(
        "reader",
        reader::subscribe(&online_ctx(state), &body.feed_url).await,
    )?;
    Ok(Reply::ok(json!({ "feed": feed })))
}

pub async fn unsubscribe(state: &Arc<AppState>, id: &str) -> RpcResult {
    tagged("reader", reader::unsubscribe(&online_ctx(state), id).await)?;
    Ok(Reply::ok(json!({ "ok": true })))
}

pub async fn delete_feed(state: &Arc<AppState>, id: &str) -> RpcResult {
    tagged("reader", reader::delete_feed(&online_ctx(state), id).await)?;
    Ok(Reply::ok(json!({ "ok": true })))
}

pub async fn refresh(state: &Arc<AppState>, id: &str, body: &Value) -> RpcResult {
    // 手动刷新可省略 body；TTL 合并语义由服务端决定。
    let force = body.get("force").and_then(Value::as_bool).unwrap_or(true);
    let result = tagged(
        "reader",
        reader::refresh(&online_ctx(state), id, force).await,
    )?;
    Ok(Reply::ok(json!({ "result": result })))
}

pub async fn entries(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let q: reader::ReaderEntriesQuery = query_as(query)?;
    let page = tagged("reader", reader::entries(&online_ctx(state), &q).await)?;
    Reply::json(&page)
}

pub async fn entry_detail(state: &Arc<AppState>, id: &str) -> RpcResult {
    let entry = tagged("reader", reader::entry_detail(&online_ctx(state), id).await)?;
    Ok(Reply::ok(json!({ "entry": entry })))
}

pub async fn set_state(state: &Arc<AppState>, id: &str, body: &Value) -> RpcResult {
    let body: reader::ReaderEntryStateRequest = body_as(body)?;
    tagged(
        "reader",
        reader::set_state(&online_ctx(state), id, body.is_read, body.starred).await,
    )?;
    Ok(Reply::ok(json!({ "ok": true })))
}

/// 图片信封与封面代理同形状（`{data, content_type}`），前端复用同一条 data-URL 链路。
pub async fn entry_image(state: &Arc<AppState>, id: &str, key: &str) -> RpcResult {
    let url = reader::image_target(&online_ctx(state), id, key).await?;
    let url = public_https_url(&url)?;
    let (bytes, content_type) = fetch_remote_image(&url).await?;
    Ok(Reply::ok(json!({
        "data": encode_base64(&bytes),
        "content_type": content_type,
    })))
}
