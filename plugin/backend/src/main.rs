// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! DBX 插件形态的 sidecar 入口。
//!
//! 与独立形态（`crates/hertz-studio/src/main.rs`）共用同一套业务逻辑与同一个
//! `AppState`，差别只在传输：那边是 axum HTTP + WebSocket，这边是 stdio JSON-RPC。
//!
//! # 协议约定
//!
//! UI 调 `dbxPlugin.invoke(method, params)`，其中：
//! - `method` 就是原来的 HTTP path 去掉前导斜杠，例如 `v1/player/play`；
//! - `params` 是信封 `{op, query, body}`，`op` 是原 HTTP 动词（同一路径可能同时
//!   挂 GET 和 POST，如 `v1/player/dsp`，所以必须显式带上）；上传二进制时另有
//!   `raw_base64` / `raw_content_type` 两个字段。
//!
//! 返回值一律是 JSON-RPC **成功**结果，形状 `{status, body}`，与 HTTP 响应一一对应。
//! 域错误不用 JSON-RPC error 传，因为宿主解码 sidecar 响应时只保留 `error.message`，
//! 会丢掉 `code` / `data`（dbx `crates/dbx-plugin-runtime/src/plugins/runtime.rs`
//! 的 `decode_response_value`），而前端契约要求错误体带稳定机器码、requestId、
//! 音源 id 和 HTTP 状态。只有协议级错误（信封非法、方法名非法）才用真 JSON-RPC error。
//!
//! # stdout 是协议信道
//!
//! 任何日志都不能写 stdout，否则会把帧写花。这里显式把 tracing 接到 stderr。

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use dbx_plugin_sdk::{
    PluginEmitter, PluginError, PluginHandler, PluginMetadata, PluginServer, RequestContext,
};
use hertz_studio::error::{ErrorBody, ErrorDetail};
use hertz_studio::rpc::{decode_base64, Call, Op, RawBody, Rpc, RpcResult};
use hertz_studio::state::AppState;
use serde_json::{json, Value};
use tokio::sync::broadcast;

/// 必须与 `plugin/manifest.json` 的 `id` 一致：宿主按它过滤事件，不一致的话
/// UI 一个事件都收不到。
const PLUGIN_ID: &str = "io.github.mmusic-studio.hertz-studio";

/// 服务端事件下发的方法名。UI 侧 `onEvent` 按它过滤后交给原来的 `handleEvent`，
/// 载荷就是独立形态下 WS 推的那个 `WsEvent`，字段口径完全一致。
const EVENT_METHOD: &str = "studio/event";

/// UI 建立事件订阅时调用的方法。
///
/// 之所以需要显式订阅：`PluginServer` 不提供注入 emitter 的入口，emitter 只在
/// `handle()` 里才拿得到；而转发任务必须复用 SDK 那把 stdout 互斥锁，否则两个
/// 写者会把帧交错写坏。所以转发器在首次调用时惰性启动，之后幂等。
const SUBSCRIBE_METHOD: &str = "studio/events/subscribe";

struct Plugin {
    runtime: tokio::runtime::Runtime,
    rpc: Rpc,
    state: Arc<AppState>,
    /// 保活音频 actor 的线程句柄。丢掉句柄只会 detach 而不会杀线程，但显式持有
    /// 到进程结束更贴近独立形态的语义。
    _booted: hertz_studio::bootstrap::Booted,
    /// 事件转发器是否已启动。
    forwarded: OnceLock<()>,
}

impl PluginHandler for Plugin {
    fn handle(
        &self,
        _context: RequestContext,
        method: &str,
        params: Value,
        emitter: &PluginEmitter,
    ) -> Result<Value, PluginError> {
        self.start_event_forwarder(emitter);

        if method == SUBSCRIBE_METHOD {
            return Ok(json!({ "status": 200, "body": { "ok": true } }));
        }

        let op = Op::parse(envelope_str(&params, "op")?.unwrap_or("GET")).ok_or_else(|| {
            PluginError::new(-32602, "envelope.op must be one of GET/POST/PUT/DELETE")
        })?;
        let query = params.get("query").cloned().unwrap_or(Value::Null);
        let body = params.get("body").cloned().unwrap_or(Value::Null);
        // 二进制体（封面替换）：base64 解不开是信封非法，属协议级错误，
        // 与 `op` 不合法同一档，不能塞进带内的 {status, body}。
        let raw = match envelope_str(&params, "raw_base64")? {
            Some(data) => Some(RawBody {
                bytes: decode_base64(data).map_err(|error| {
                    PluginError::new(
                        -32602,
                        format!("envelope.raw_base64 不是合法 base64: {error}"),
                    )
                })?,
                // 缺省值与前端 dbxRequest 的缺省一致，两边不会因一边省略而错位。
                content_type: envelope_str(&params, "raw_content_type")?
                    .unwrap_or("application/octet-stream")
                    .to_string(),
            }),
            None => None,
        };

        let result = self.runtime.block_on(self.rpc.call(Call {
            op,
            path: method,
            query,
            body,
            raw,
        }));
        Ok(envelope_result(result))
    }
}

impl Plugin {
    /// 把 `state.events` 上的服务端事件转发到 UI。幂等：只有第一次调用真正起任务。
    ///
    /// 订阅之前产生的事件会丢，这与独立形态的 WS 语义一致（连接建立时补发一帧
    /// 完整 state，UI 启动时也会主动拉一次 `/v1/state`），所以不影响正确性。
    fn start_event_forwarder(&self, emitter: &PluginEmitter) {
        if self.forwarded.set(()).is_err() {
            return;
        }
        let mut receiver = self.state.events.subscribe();
        let emitter = emitter.clone();
        self.runtime.spawn(async move {
            loop {
                match receiver.recv().await {
                    Ok(event) => {
                        let Ok(params) = serde_json::to_value(&event) else {
                            continue;
                        };
                        if let Err(error) = emitter.event(EVENT_METHOD, params) {
                            tracing::warn!("事件转发失败，停止下发: {}", error.message);
                            break;
                        }
                    }
                    // 宿主侧 broadcast 队列只有 256 深，UI 卡住时会走到这里。
                    // 丢掉积压帧继续跑正是频谱这类流式数据想要的语义。
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::debug!("事件积压，丢弃 {skipped} 帧");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }
}

fn envelope_str<'a>(params: &'a Value, key: &str) -> Result<Option<&'a str>, PluginError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text)),
        Some(_) => Err(PluginError::new(
            -32602,
            format!("envelope.{key} must be a string"),
        )),
    }
}

/// 把门面结果包成与 HTTP 响应同构的信封。
///
/// 错误体直接复用 `error::ErrorBody`，而不是在这里手搓一份 JSON：字段名
/// （`request_id` 是 snake_case）、`source` 的缺省语义都跟着 HTTP 版走，
/// 前端 `app.js` 的错误归一化逻辑因此可以原样复用，不会出现两边漂移。
fn envelope_result(result: RpcResult) -> Value {
    match result {
        Ok(reply) => json!({ "status": reply.status, "body": reply.body }),
        Err(error) => {
            let status = error.status.as_u16();
            let body = ErrorBody {
                error: ErrorDetail {
                    code: error.code,
                    message: error.message,
                    request_id: error.request_id,
                    source: error.source,
                },
            };
            json!({ "status": status, "body": body })
        }
    }
}

/// 数据目录由宿主通过 `DBX_PLUGIN_DATA_DIR` 指定（`<dbx data>/plugin-data/<plugin id>`）。
///
/// 手工跑这个二进制调试时该变量不存在。这时**不能**回落到独立形态的默认目录：
/// 两个进程同时写同一个 SQLite 会互相踩。所以退到默认目录下的一个专属子目录。
fn resolve_data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("DBX_PLUGIN_DATA_DIR").filter(|value| !value.is_empty()) {
        return PathBuf::from(dir);
    }
    tracing::warn!("DBX_PLUGIN_DATA_DIR 未设置，回落到独立数据目录之外的专属子目录");
    hertz_studio::config::default_data_dir().join("dbx-plugin")
}

fn init_logging() {
    // stdout 是协议信道，日志一律走 stderr。
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("VMUSIC_LOG")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .init();
}

/// 装配运行时。与 `Plugin::handle` 分开是因为 `runtime.block_on` 借用 runtime，
/// 不能在同一表达式里把 runtime 移进它自己跑的 future。
async fn boot_plugin() -> anyhow::Result<hertz_studio::bootstrap::Booted> {
    let data_dir = resolve_data_dir();
    let config = hertz_studio::bootstrap::prepare(&data_dir).await?;
    // stdio 天然可信，没有 HTTP 那一层的 bearer token；`AppState` 要求有值，
    // 所以填一个随机串，永不外泄也永不校验。
    let token = uuid::Uuid::new_v4().to_string();
    let booted = hertz_studio::bootstrap::boot(data_dir, config, token).await?;
    tracing::info!(backend = %booted.backend_label, "mmusic-studio sidecar 就绪");
    Ok(booted)
}

fn main() -> std::io::Result<()> {
    init_logging();

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    let booted = match runtime.block_on(boot_plugin()) {
        Ok(booted) => booted,
        Err(error) => {
            // 退出而不是 panic：宿主会把子进程死亡当成插件崩溃上报，带着一行
            // 可读的原因比一个 backtrace 更容易定位。
            eprintln!("[dbx-plugin-hertz] 启动失败: {error:?}");
            return Ok(());
        }
    };

    let plugin = Plugin {
        rpc: Rpc::new(booted.state.clone()),
        state: booted.state.clone(),
        forwarded: OnceLock::new(),
        runtime,
        _booted: booted,
    };

    let metadata = PluginMetadata::new(PLUGIN_ID, env!("CARGO_PKG_VERSION"));
    PluginServer::new(metadata, plugin).serve()
}
