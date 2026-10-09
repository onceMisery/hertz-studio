// SPDX-License-Identifier: MIT
//! Podcast API; shared request DTOs and service preserve HTTP/DBX parity.

use super::{body_as, query_as, Reply, RpcResult};
use crate::podcasts;
use crate::routes::{
    online_ctx, tagged, PodcastFeedQuery, PodcastSearchQuery, PodcastSubscribeRequest,
};
use crate::state::AppState;
use serde_json::{json, Value};
use std::sync::Arc;

pub async fn search(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let q: PodcastSearchQuery = query_as(query)?;
    Reply::json(&tagged(
        "podcast",
        podcasts::search(&online_ctx(state), &q.q, q.limit).await,
    )?)
}

pub async fn feed(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let q: PodcastFeedQuery = query_as(query)?;
    Reply::json(&tagged(
        "podcast",
        podcasts::feed(&online_ctx(state), &q.url, q.offset, q.limit, q.refresh).await,
    )?)
}

pub async fn subscriptions(state: &Arc<AppState>) -> RpcResult {
    let shows = tagged("podcast", podcasts::subscriptions(&online_ctx(state)).await)?;
    Ok(Reply::ok(json!({ "shows": shows })))
}

pub async fn subscribe(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let body: PodcastSubscribeRequest = body_as(body)?;
    let show = tagged(
        "podcast",
        podcasts::subscribe(&online_ctx(state), &body.feed_url).await,
    )?;
    Ok(Reply::ok(json!({ "show": show })))
}

pub async fn unsubscribe(state: &Arc<AppState>, id: &str) -> RpcResult {
    tagged(
        "podcast",
        podcasts::unsubscribe(&online_ctx(state), id).await,
    )?;
    Ok(Reply::ok(json!({ "ok": true })))
}
