// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 每日推荐：本地规则引擎按天确定性出榜，以及各在线平台已登录账号的汇总。
//!
//! 逐个对应 `routes.rs` 里的同名 handler。`online_ctx` 与 `DailyQuery` 复用 routes
//! 那一份——`online_ctx` 装配的是音源凭据与 HTTP 客户端，两处各拼一份，漏一个
//! 字段的表现是「某个平台在插件形态下永远未登录」。

use std::sync::Arc;

use serde_json::Value;

use crate::daily;
use crate::error::bad_request;
use crate::routes::{online_ctx, DailyQuery};
use crate::rpc::{query_as, Reply, RpcResult};
use crate::state::AppState;

pub async fn daily_recommend(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let q: DailyQuery = query_as(query)?;
    let limit = daily::parse_limit(q.limit)?;
    Reply::json(&daily::daily_at(&state.db, limit, q.day).await?)
}

/// 各在线平台每日推荐的汇总。
///
/// 刻意不做音源标注：整份汇总本来就是多平台的，把失败标到某一个音源上没有意义。
/// 单平台的缺席写在响应体的 `skipped` 里，状态恒为 200——一个平台没登录不该让
/// 用户看到一个红色错误条。
pub async fn daily_online_recommend(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let q: DailyQuery = query_as(query)?;
    let limit = match q.limit {
        None => daily::ONLINE_DEFAULT_LIMIT,
        Some(0) => return Err(bad_request("limit 必须大于 0")),
        Some(n) => n,
    };
    Reply::json(&daily::online_daily_at(&online_ctx(state), limit, q.day).await?)
}
