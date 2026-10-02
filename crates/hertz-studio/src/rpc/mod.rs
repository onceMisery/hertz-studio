// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! 与传输无关的 JSON 门面。
//!
//! DBX 插件的 sidecar 把 UI 的 `invoke(method, params)` 翻译成这里的 [`Rpc::call`]。
//! method 名就是原来的 HTTP path 去掉前导斜杠（`v1/player/play`），信封里带
//! `op`（原 HTTP 动词）、`query`、`body`，所以端点是机械平移，`routes.rs` 里的
//! handler 逻辑可以照抄。
//!
//! 这一层既不认识 axum 也不认识 dbx-plugin-sdk：进来是 JSON，出去是
//! `Result<Reply, ApiError>`，两端各自适配。之所以放在本 crate 内部而不是
//! `plugin/backend`，是因为 `AppState` 有一批 `pub(crate)` 字段（`radio`、
//! `online_meta`、`downloads`、`quality`、`keep`、`protected`），外部 crate 碰不到。
//!
//! # 路由表为什么用 slice pattern
//!
//! `match (op, segments.as_slice())` 配 `["v1", "tracks", id]` 这样的模式，路径
//! 参数直接绑定成变量，不需要额外的匹配器，也不会有"模式写重了导致后面的分支
//! 永远走不到"这类只有运行期才暴露的问题——编译器会按顺序取第一个匹配，和
//! axum 的路由优先级一样直观。
//!
//! # 错误为什么不走 JSON-RPC error
//!
//! 宿主解码 sidecar 响应时只保留 `error.message`，`code` 和 `data` 会被丢掉
//! （dbx `crates/dbx-plugin-runtime/src/plugins/runtime.rs` 的
//! `decode_response_value`）。而前端契约要求错误体带稳定的机器码、request_id、
//! 音源 id 和 HTTP 状态。所以域错误一律以**成功结果**的形式返回，由 sidecar
//! 包成 `{status, body}`，`body` 就是原来那个 `{"error":{...}}`。协议级错误
//! （方法不存在、信封非法）才用真正的 JSON-RPC error。

pub mod playback;

use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use vmusic_core::PROTOCOL_VERSION;

use crate::error::{bad_request, not_found, ApiError};
use crate::state::AppState;

/// 原 HTTP 动词。同一路径可能同时挂 GET 和另一个动词（例如 `/v1/player/dsp`
/// 是 GET|POST、`/v1/player/queue` 是 GET|PUT），所以必须随信封一起传进来，
/// 不能只靠 path 区分。
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

/// 一次调用的应答，与 HTTP 响应同构。
///
/// 允许自定义状态码与体，是因为有几个端点的应答不是标准形状：`stage/beatmap`
/// 的 202/404 体是 `{status, reason}`，返回 204 的端点体为空。这些都不能塞进
/// `ApiError`——那是错误通道，形状固定为 `{"error":{...}}`。
pub struct Reply {
    pub status: u16,
    pub body: Value,
}

impl Reply {
    pub fn ok(body: Value) -> Self {
        Self { status: 200, body }
    }

    /// 204：前端 `request()` 对 204 返回 null，所以体是 Null 而不是缺省。
    pub fn no_content() -> Self {
        Self {
            status: 204,
            body: Value::Null,
        }
    }

    pub fn with_status(status: u16, body: Value) -> Self {
        Self { status, body }
    }
}

pub type RpcResult = Result<Reply, ApiError>;

/// 反序列化信封里的请求体。缺体按 Null 处理，交给 serde 报缺字段——
/// 错误消息与 HTTP 版 `Json(body)` 抽取器失败时同源。
pub fn body_as<T: DeserializeOwned>(body: &Value) -> Result<T, ApiError> {
    serde_json::from_value(body.clone()).map_err(|e| bad_request(format!("请求体不合法: {e}")))
}

/// 取查询参数。
///
/// 一律按字符串读再解析：UI 那边 `URLSearchParams` 出来的值天然是字符串，
/// 这与 axum 的 `Query<T>`（serde_urlencoded）行为一致，所以数字/布尔参数在
/// 两条路上接受同样的写法。
pub fn query_str<'a>(query: &'a Value, key: &str) -> Option<&'a str> {
    match query.get(key)? {
        Value::String(text) => Some(text),
        _ => None,
    }
}

pub fn query_i64(query: &Value, key: &str) -> Option<i64> {
    match query.get(key)? {
        Value::String(text) => text.trim().parse::<i64>().ok(),
        Value::Number(number) => number.as_i64(),
        _ => None,
    }
}

pub fn query_bool(query: &Value, key: &str) -> Option<bool> {
    match query.get(key)? {
        Value::Bool(flag) => Some(*flag),
        Value::String(text) => match text.trim() {
            "1" | "true" | "yes" => Some(true),
            "0" | "false" | "no" => Some(false),
            _ => None,
        },
        _ => None,
    }
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

    pub async fn call(&self, call: Call<'_>) -> RpcResult {
        let segments: Vec<&str> = call.path.split('/').filter(|s| !s.is_empty()).collect();
        let state = &self.state;
        let query = &call.query;
        let body = &call.body;

        match (call.op, segments.as_slice()) {
            // --- 元信息 / 状态 ---
            (Op::Get, ["v1", "health"]) => Ok(Reply::ok(self.health())),
            (Op::Get, ["v1", "state"]) => Ok(Reply::ok(playback::snapshot(state).await)),

            // --- 播放控制 ---
            (Op::Post, ["v1", "player", "load"]) => playback::load(state, body).await,
            (Op::Post, ["v1", "player", "play"]) => playback::play(state).await,
            (Op::Post, ["v1", "player", "pause"]) => playback::pause(state).await,
            (Op::Post, ["v1", "player", "stop"]) => playback::stop(state).await,
            (Op::Post, ["v1", "player", "next"]) => playback::next(state).await,
            (Op::Post, ["v1", "player", "previous"]) => playback::previous(state).await,
            (Op::Post, ["v1", "player", "seek"]) => playback::seek(state, body).await,
            (Op::Post, ["v1", "player", "volume"]) => playback::volume(state, body).await,
            (Op::Post, ["v1", "player", "mode"]) => playback::mode(state, body).await,
            (Op::Post, ["v1", "player", "replay"]) => playback::replay(state, body).await,
            (Op::Get, ["v1", "player", "queue"]) => playback::get_queue(state).await,
            (Op::Put, ["v1", "player", "queue"]) => playback::set_queue(state, body).await,
            (Op::Get, ["v1", "player", "dsp"]) => playback::get_dsp(state).await,
            (Op::Post, ["v1", "player", "dsp"]) => playback::set_dsp(state, body).await,

            // --- 音频设备 ---
            (Op::Get, ["v1", "devices"]) => playback::devices(state).await,
            (Op::Post, ["v1", "devices", "select"]) => playback::select_device(state, body).await,

            // --- 舞台节拍图 ---
            (Op::Get, ["v1", "stage", "beatmap"]) => playback::beatmap(state, query).await,

            _ => Err(not_found(format!(
                "no such method: {} {:?}",
                call.path, call.op
            ))),
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

    #[test]
    fn query_helpers_accept_url_shaped_strings() {
        // UI 侧 URLSearchParams 出来的一律是字符串，与 axum Query<T> 同口径。
        let query = json!({ "limit": "50", "flag": "true", "name": "夜曲", "bad": "x" });
        assert_eq!(query_i64(&query, "limit"), Some(50));
        assert_eq!(query_bool(&query, "flag"), Some(true));
        assert_eq!(query_str(&query, "name"), Some("夜曲"));
        // 解析不出来就是没传，让调用方走默认值，而不是当成 0/false。
        assert_eq!(query_i64(&query, "bad"), None);
        assert_eq!(query_i64(&query, "missing"), None);
        // JSON 数字也接受：sidecar 之间互调时不必先转成字符串。
        assert_eq!(query_i64(&json!({ "limit": 50 }), "limit"), Some(50));
    }

    #[test]
    fn reply_status_codes_carry_through() {
        assert_eq!(Reply::ok(json!({})).status, 200);
        // 204 的体必须是 Null：前端 request() 对 204 返回 null。
        assert_eq!(Reply::no_content().status, 204);
        assert!(Reply::no_content().body.is_null());
        assert_eq!(Reply::with_status(202, json!({"status":"analyzing"})).status, 202);
    }
}
