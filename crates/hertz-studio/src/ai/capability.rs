// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 受限能力表：门面可执行的 operation 清单与分派。
//!
//! 技术路线 §5.1 的小型能力 registry——不是插件框架，也不登记全站路由。
//! 每个条目带 operation 名、MCP 工具名、所需 scope、效果类别与描述；
//! `tools/list`（R2-M）按会话 scope 从这里导出工具描述，而 HTTP/RPC 的
//! 官方 UI 播控不经过这里（它们直接走共享入口）。表只登记已实现的 A1
//! 能力，不提前公布未实现的工具，也不给模型一个可传任意 operation 的
//! 大入口。
//!
//! scope 模型（§5.2 A1）：每种传输播控一个独立 scope，pause-only 这类
//! 最小授权因此可表达；`playback:control` 是伞 scope，在核对时隐含六种
//! 传输播控（不含只读快照与曲库），让「全部播控」仍是一个词。
//!
//! 注册表与下面的 `execute` 分派是同一份事实的两面：新增 operation 必须
//! 同时落在这里的表和 match 臂，编译器的穷尽检查守住两边不漂移。

use std::collections::BTreeSet;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::error::{bad_request, ApiError};
use crate::idempotency::short_write;
use crate::state::{AppState, ControlOutcome};

use super::facade::GrantContext;

/// 能力协议版本：能力表与输入/输出形状的版本号。形状变更即 bump，
/// 适配器据 context 里的值判断兼容性，不做静默按当前版本解释。
pub(crate) const CAPABILITY_VERSION: &str = "1";

pub(crate) const SCOPE_PLAYBACK_PAUSE: &str = "playback:pause";
pub(crate) const SCOPE_PLAYBACK_RESUME: &str = "playback:resume";
pub(crate) const SCOPE_PLAYBACK_NEXT: &str = "playback:next";
pub(crate) const SCOPE_PLAYBACK_PREVIOUS: &str = "playback:previous";
pub(crate) const SCOPE_PLAYBACK_SEEK: &str = "playback:seek";
pub(crate) const SCOPE_PLAYBACK_VOLUME_SET: &str = "playback:volume_set";
/// 伞 scope：隐含六种传输播控（不含只读快照与曲库检索）。
pub(crate) const SCOPE_PLAYBACK_CONTROL: &str = "playback:control";
pub(crate) const SCOPE_PLAYBACK_READ: &str = "playback:read";
pub(crate) const SCOPE_LIBRARY_READ: &str = "library:read";

/// 创建 grant 时允许申请的全部 scope。scope 之外没有暗门：某个 scope
/// 没被授出，它对应的 operation 对这份凭据就不存在。
pub(crate) const SCOPES: &[&str] = &[
    SCOPE_PLAYBACK_PAUSE,
    SCOPE_PLAYBACK_RESUME,
    SCOPE_PLAYBACK_NEXT,
    SCOPE_PLAYBACK_PREVIOUS,
    SCOPE_PLAYBACK_SEEK,
    SCOPE_PLAYBACK_VOLUME_SET,
    SCOPE_PLAYBACK_CONTROL,
    SCOPE_PLAYBACK_READ,
    SCOPE_LIBRARY_READ,
];

/// scope 核对：直接命中，或由伞 scope 隐含（`playback:control` ⇒ 六种
/// 传输播控；只读快照与曲库检索不在伞内）。
pub(crate) fn scope_satisfied(granted: &BTreeSet<String>, required: &str) -> bool {
    if granted.contains(required) {
        return true;
    }
    required.starts_with("playback:")
        && required != SCOPE_PLAYBACK_READ
        && granted.contains(SCOPE_PLAYBACK_CONTROL)
}

/// 只读能力不占用去重表，也不产生播放副作用。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Effect {
    ReadOnly,
    Mutating,
}

impl Effect {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Effect::ReadOnly => "read_only",
            Effect::Mutating => "mutating",
        }
    }
}

/// 注册表里的一条能力。`operation` 是门面内部名（点分），`mcp_name` 是
/// MCP 工具名（下划线，与路线图 §5.2 的 A1 工具表一致）；两者都可作为
/// [`find`] 的键。
pub(crate) struct Capability {
    pub operation: &'static str,
    pub mcp_name: &'static str,
    pub scope: &'static str,
    pub effect: Effect,
    pub description: &'static str,
}

pub(crate) const CAPABILITIES: &[Capability] = &[
    Capability {
        operation: "playback.snapshot_get",
        mcp_name: "playback_snapshot_get",
        scope: SCOPE_PLAYBACK_READ,
        effect: Effect::ReadOnly,
        description: "最小播放快照；标题/歌手等元数据不在内",
    },
    Capability {
        operation: "playback.pause",
        mcp_name: "playback_pause",
        scope: SCOPE_PLAYBACK_PAUSE,
        effect: Effect::Mutating,
        description: "暂停当前播放",
    },
    Capability {
        operation: "playback.resume",
        mcp_name: "playback_resume",
        scope: SCOPE_PLAYBACK_RESUME,
        effect: Effect::Mutating,
        description: "恢复当前已装载曲目；未装载时明确拒绝",
    },
    Capability {
        operation: "playback.next",
        mcp_name: "playback_next",
        scope: SCOPE_PLAYBACK_NEXT,
        effect: Effect::Mutating,
        description: "下一曲；完成事实含 applied/no_op/superseded",
    },
    Capability {
        operation: "playback.previous",
        mcp_name: "playback_previous",
        scope: SCOPE_PLAYBACK_PREVIOUS,
        effect: Effect::Mutating,
        description: "上一曲",
    },
    Capability {
        operation: "playback.seek",
        mcp_name: "playback_seek",
        scope: SCOPE_PLAYBACK_SEEK,
        effect: Effect::Mutating,
        description: "定位当前曲目，入参 positionMs",
    },
    Capability {
        operation: "playback.volume_set",
        mcp_name: "playback_volume_set",
        scope: SCOPE_PLAYBACK_VOLUME_SET,
        effect: Effect::Mutating,
        description: "设置音量，入参 value 取 0.0–1.0",
    },
    Capability {
        operation: "library_search",
        mcp_name: "library_search",
        scope: SCOPE_LIBRARY_READ,
        effect: Effect::ReadOnly,
        description:
            "检索已授权的本地/已导入曲库索引；limit 默认 20（1–50），offset 0–10000；不返回文件路径",
    },
];

/// 按内部名或 MCP 工具名查能力。
pub(crate) fn find(operation: &str) -> Option<&'static Capability> {
    CAPABILITIES
        .iter()
        .find(|c| c.operation == operation || c.mcp_name == operation)
}

/// 一次受限调用的入参。
pub(crate) struct CapabilityCall {
    pub operation: String,
    pub client_operation_id: Option<String>,
    pub input: Value,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SeekInput {
    position_ms: u64,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct VolumeInput {
    value: f32,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct LibrarySearchInput {
    q: String,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    offset: Option<i64>,
}

/// 执行一次受限能力调用。scope 在查表之后、执行之前核对；变更命令统一走
/// [`short_write`]，principal 绑定 grantId——与官方 UI 的 local-owner 互不
/// 串键，完成事实就是共享入口给出的那一份，不在这里二次粉饰。
pub(crate) async fn execute(
    state: &Arc<AppState>,
    ctx: &GrantContext,
    call: CapabilityCall,
) -> Result<Value, ApiError> {
    let capability = find(&call.operation).ok_or_else(|| {
        ApiError::capability_unsupported(format!("未登记的能力: {}", call.operation))
    })?;
    if !scope_satisfied(&ctx.scopes, capability.scope) {
        return Err(ApiError::new(
            axum::http::StatusCode::FORBIDDEN,
            "scope_required",
            format!("该凭据缺少 scope: {}", capability.scope),
        ));
    }
    match capability.operation {
        "playback.snapshot_get" => {
            require_no_input(&call.input)?;
            Ok(snapshot(state).await)
        }
        "playback.pause" => {
            require_no_input(&call.input)?;
            mutate(
                state,
                ctx,
                call.client_operation_id.as_deref(),
                "playback.pause",
                Value::Null,
                |s| async move { s.pause_control().await },
            )
            .await
        }
        "playback.resume" => {
            require_no_input(&call.input)?;
            // 受限门面的 resume 是严格语义（§5.2）：未装载明确拒绝，
            // 绝不走官方 UI 的会话恢复分支。
            mutate(
                state,
                ctx,
                call.client_operation_id.as_deref(),
                "playback.resume",
                Value::Null,
                |s| async move { s.resume_control(true).await },
            )
            .await
        }
        "playback.next" => {
            require_no_input(&call.input)?;
            mutate(
                state,
                ctx,
                call.client_operation_id.as_deref(),
                "playback.next",
                Value::Null,
                |s| async move { s.step_by_user(1).await },
            )
            .await
        }
        "playback.previous" => {
            require_no_input(&call.input)?;
            mutate(
                state,
                ctx,
                call.client_operation_id.as_deref(),
                "playback.previous",
                Value::Null,
                |s| async move { s.step_by_user(-1).await },
            )
            .await
        }
        "playback.seek" => {
            let input: SeekInput = parse_input(&call.input)?;
            let position_ms = input.position_ms;
            mutate(
                state,
                ctx,
                call.client_operation_id.as_deref(),
                "playback.seek",
                json!(position_ms),
                move |s| async move { s.seek_control(position_ms).await },
            )
            .await
        }
        "playback.volume_set" => {
            let input: VolumeInput = parse_input(&call.input)?;
            let value = input.value;
            mutate(
                state,
                ctx,
                call.client_operation_id.as_deref(),
                "playback.volume_set",
                json!(value),
                move |s| async move { s.set_volume_control(value).await },
            )
            .await
        }
        "library_search" => {
            // 本地索引查询不走在线搜索闸（§4.1 的闸管的是上游音源调用）。
            // 投影白名单：不返回文件路径；凭据类字段本就不在曲库表里。
            let input: LibrarySearchInput = parse_input(&call.input)?;
            let limit = input.limit.unwrap_or(20).clamp(1, 50);
            let offset = input.offset.unwrap_or(0).clamp(0, 10_000);
            let tracks = vmusic_store::list_tracks(&state.db, Some(&input.q), limit, offset)
                .await
                .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
            let tracks: Vec<Value> = tracks
                .iter()
                .map(|t| {
                    json!({
                        "id": t.id,
                        "title": t.title,
                        "artist": t.artist,
                        "album": t.album,
                        "durationMs": t.duration_ms,
                        "source": t.source,
                    })
                })
                .collect();
            Ok(json!({
                "outcome": "ok",
                "code": "ok",
                "data": { "tracks": tracks },
            }))
        }
        // 能力表与 match 同步由注册表条目保证；走到这里说明表里登记了
        // 没有分派的 operation，按未实现拒绝而不是猜。
        _ => Err(ApiError::capability_unsupported(format!(
            "能力已登记但未实现: {}",
            capability.operation
        ))),
    }
}

/// 变更能力的公共路径：无参命令的 input 已由调用方核对，这里统一进
/// 幂等入口并折叠成类型化应答。
async fn mutate<F, Fut>(
    state: &Arc<AppState>,
    ctx: &GrantContext,
    client_operation_id: Option<&str>,
    op: &'static str,
    input: Value,
    exec: F,
) -> Result<Value, ApiError>
where
    F: FnOnce(Arc<AppState>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<ControlOutcome, vmusic_core::CoreError>>
        + Send
        + 'static,
{
    // 幂等输入必须携带真实参数：同键不同参数是冲突，不是回放——
    // 统一塞 Null 会让「同键把音量从 0.2 改成 0.8」静默变成第二次执行。
    let outcome = short_write(
        state.clone(),
        &ctx.grant_id,
        op,
        client_operation_id,
        input,
        exec,
    )
    .await
    .map_err(ApiError::from)?;
    Ok(outcome_json(&outcome))
}

/// 统一结果形状（§5.6）：outcome 是粗事实，code 是稳定机器码，generation
/// 只在事实携带它时出现。快照只提供随后观察，不属于这里。
fn outcome_json(outcome: &ControlOutcome) -> Value {
    match outcome {
        ControlOutcome::Applied { generation } => {
            json!({ "outcome": "applied", "code": "applied", "generation": generation })
        }
        ControlOutcome::NoOp { code } => {
            json!({ "outcome": "no_op", "code": code.as_str(), "generation": Value::Null })
        }
        ControlOutcome::Superseded { generation } => {
            json!({ "outcome": "superseded", "code": "superseded", "generation": generation })
        }
    }
}

/// 最小播放快照（§5.2 A1）：投影白名单里的字段。标题/歌手等元数据需要
/// trackMetadata 类 scope，本轮未登记——连错误响应也不得透露曲名。
async fn snapshot(state: &Arc<AppState>) -> Value {
    let snap = state.audio.snapshot();
    json!({
        "outcome": "ok",
        "code": "ok",
        "data": {
            "trackId": snap.track_id,
            "positionMs": snap.position_ms,
            "durationMs": snap.duration_ms,
            "playing": snap.playing,
            "volume": snap.volume,
            "mode": snap.mode,
            "generation": snap.generation,
            "queueLength": state.queue.lock().await.len(),
            "queueIndex": state.current_index().await,
        }
    })
}

/// 无参能力的输入闸：Null 或空对象之外一律拒绝——未知字段不允许从
/// 受控入口溜进去（§8.1）。
fn require_no_input(input: &Value) -> Result<(), ApiError> {
    match input {
        Value::Null => Ok(()),
        Value::Object(map) if map.is_empty() => Ok(()),
        _ => Err(bad_request("该能力不接受输入参数")),
    }
}

fn parse_input<T: serde::de::DeserializeOwned>(input: &Value) -> Result<T, ApiError> {
    serde_json::from_value(input.clone()).map_err(|e| bad_request(format!("能力入参不合法: {e}")))
}
