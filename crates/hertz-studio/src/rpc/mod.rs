// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! 与传输无关的 JSON 门面。
//!
//! DBX 插件的 sidecar 把 UI 的 `invoke(method, params)` 翻译成这里的 [`Rpc::call`]。
//! method 名就是原来的 HTTP path 去掉前导斜杠（`v1/player/play`），信封里带
//! `op`（原 HTTP 动词）、`query`、`body`，所以 103 个端点是机械平移，
//! `routes.rs` 里的 handler 逻辑可以照抄。
//!
//! 这一层既不认识 axum 也不认识 dbx-plugin-sdk：进来是 JSON，出去是
//! `Result<Value, ApiError>`，两端各自适配。之所以放在本 crate 内部而不是
//! `plugin/backend`，是因为 `AppState` 有一批 `pub(crate)` 字段（`radio`、
//! `online_meta`、`downloads`、`quality`、`keep`、`protected`），外部 crate 碰不到。
//!
//! # 错误为什么不走 JSON-RPC error
//!
//! 宿主解码 sidecar 响应时只保留 `error.message`，`code` 和 `data` 会被丢掉
//! （dbx `crates/dbx-plugin-runtime/src/plugins/runtime.rs` 的
//! `decode_response_value`）。而前端契约要求错误体带稳定的机器码、requestId、
//! 音源 id 和 HTTP 状态。所以域错误一律以**成功结果**的形式返回，由 sidecar
//! 包成 `{status, body}`，`body` 就是原来那个 `{"error":{...}}`。协议级错误
//! （方法不存在、信封非法）才用真正的 JSON-RPC error。

use std::sync::Arc;

use serde_json::{json, Value};
use vmusic_core::PROTOCOL_VERSION;

use crate::error::{not_found, ApiResult};
use crate::state::AppState;

/// 原 HTTP 动词。同一路径可能同时挂 GET 和 POST（例如 `/v1/player/dsp`），
/// 所以必须随信封一起传进来，不能只靠 path 区分。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Get,
    Post,
    Put,
    Delete,
}

impl Op {
    pub fn parse(value: &str) -> Option<Self> {
        match value.to_ascii_uppercase().as_str() {
            "GET" => Some(Self::Get),
            "POST" => Some(Self::Post),
            "PUT" => Some(Self::Put),
            "DELETE" => Some(Self::Delete),
            _ => None,
        }
    }
}

/// 一次调用的全部入参。`path` 已经去掉前导斜杠，路径参数（`{id}`）还是原样的
/// 具体值，由路由表按段匹配后提取。
pub struct Call<'a> {
    pub op: Op,
    pub path: &'a str,
    pub query: Value,
    pub body: Value,
}

pub struct Rpc {
    state: Arc<AppState>,
}

impl Rpc {
    pub fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }

    pub fn state(&self) -> Arc<AppState> {
        self.state.clone()
    }

    pub async fn call(&self, call: Call<'_>) -> ApiResult<Value> {
        let segments: Vec<&str> = call.path.split('/').filter(|s| !s.is_empty()).collect();
        match (call.op, segments.as_slice()) {
            (Op::Get, ["v1", "health"]) => Ok(self.health()),
            (Op::Get, ["v1", "state"]) => Ok(self.player_state().await),
            _ => Err(not_found(format!("no such method: {} {:?}", call.path, call.op))),
        }
    }

    fn health(&self) -> Value {
        json!({
            "status": "ok",
            "version": env!("CARGO_PKG_VERSION"),
            "protocol_version": PROTOCOL_VERSION,
            // 快照里没有后端名，从 config 读，口径与 HTTP 版一致。
            "backend": self.state.config.audio.backend,
            // 让前端能区分自己跑在哪个宿主上：独立版是 http，插件是 dbx。
            "host": "dbx",
        })
    }

    /// 播放器快照叠加「在线曲缓冲覆盖态」，与 `routes::get_state` 同口径：
    /// 轮询拿到的字段和 WS `buffering` 事件读的是同一个 `state.buffering`。
    async fn player_state(&self) -> Value {
        let mut value = serde_json::to_value(self.state.audio.snapshot()).unwrap_or_default();
        if let Some(obj) = value.as_object_mut() {
            let (active, pct) = *self.state.buffering.lock().await;
            obj.insert("buffering".into(), Value::Bool(active));
            if let Some(pct) = pct {
                obj.insert("pct".into(), Value::from(pct));
            }
        }
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn op_parsing_is_case_insensitive_and_rejects_unknown_verbs() {
        assert_eq!(Op::parse("get"), Some(Op::Get));
        assert_eq!(Op::parse("POST"), Some(Op::Post));
        assert_eq!(Op::parse("Put"), Some(Op::Put));
        assert_eq!(Op::parse("DELETE"), Some(Op::Delete));
        assert_eq!(Op::parse("PATCH"), None);
        assert_eq!(Op::parse(""), None);
    }
}
