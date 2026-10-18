// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 受限本地能力门面：grants 生命周期、凭据认证与受限调用面。
//!
//! - 凭据是 256 位随机 opaque 值（getrandom），DB 只存 SHA-256 摘要；
//!   明文只落在 `DataDir/ai/grants/<grantId>.key`。路径由服务端固定子目录
//!   决定，不接受任意输出路径；应答与日志都只出现文件位置，不回显秘密。
//!   文件替换用「写临时名 + 同目录 rename」；Windows 上先移走旧目标，
//!   留有一个极小的非原子窗口——ACL、父目录与符号链接/重解析点行为按
//!   路线图 §13 在 R2-G/R4-J 实测固定，本层当前承诺的是固定子目录与
//!   摘要存储。
//! - 认证按凭据摘要查库：查无此凭据统一 401（不区分「格式对但不存在」），
//!   已撤销 403 `grant_revoked`。没有读缓存——每次调用都过库，撤权即时
//!   生效（§5.4 撤权检查在读缓存前执行）。
//! - `serverInstanceId` 来自进程内存（每次启动随机），`ownerInstanceId`
//!   持久于 `ai_instance`；调用方重启后必须凭新 context 重新对接。

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::{bad_request, internal, not_found, unauthorized, ApiError};
use crate::state::AppState;

/// `StoreError → CoreError::Store → ApiError`：错误.rs 只对 CoreError 实现
/// From，仓储调用统一收在这里转换（与 rpc 门面的既有写法一致）。
fn store_error(err: vmusic_core::StoreError) -> ApiError {
    ApiError::from(vmusic_core::CoreError::Store(err))
}

use super::capability::{CAPABILITIES, CAPABILITY_VERSION, SCOPES};

/// 凭据文件后缀。文件名是服务端生成的 grantId（UUID），不存在来自请求
/// 的路径成分。
const CREDENTIAL_SUFFIX: &str = ".key";

/// 凭据字节长度：256 位随机 opaque 值，落盘为 64 个十六进制字符。
const SECRET_BYTES: usize = 32;

/// 一份通过认证的受限调用上下文。中间件把它塞进 request extensions，
/// handler 只消费、不重建——身份与 scopes 来自可信的服务端查询，
/// 绝不从请求参数接受。
#[derive(Debug, Clone)]
pub(crate) struct GrantContext {
    pub grant_id: String,
    pub scopes: BTreeSet<String>,
    pub policy_revision: i64,
    pub owner_instance_id: String,
    pub server_instance_id: String,
}

/// grant 的安全摘要：给官方管理 UI 的应答形状。没有摘要、没有秘密。
#[derive(Debug, Serialize)]
pub(crate) struct GrantSummary {
    pub grant_id: String,
    pub label: String,
    pub scopes: Vec<String>,
    pub revoked: bool,
    pub created_at: i64,
    pub updated_at: i64,
    /// 凭据文件位置（不是凭据本身）。适配器从这里读 opaque 凭据。
    pub credential_path: String,
}

fn grants_dir(state: &AppState) -> PathBuf {
    state.data_dir.join("ai").join("grants")
}

fn credential_path(state: &AppState, grant_id: &str) -> PathBuf {
    grants_dir(state).join(format!("{grant_id}{CREDENTIAL_SUFFIX}"))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn random_secret() -> Result<String, ApiError> {
    let mut bytes = [0u8; SECRET_BYTES];
    getrandom::fill(&mut bytes).map_err(|e| internal(format!("生成凭据失败: {e}")))?;
    Ok(hex(&bytes))
}

fn digest(secret: &str) -> String {
    hex(&Sha256::digest(secret.as_bytes()))
}

/// 原子替换凭据文件：写同目录临时名后 rename。Windows 的 rename 不能覆盖
/// 已存在目标，先移走旧文件（窗口极小且目录固定；§13 留待实测收紧）。
fn write_credential_file(path: &PathBuf, secret: &str) -> Result<(), ApiError> {
    use std::fs;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| internal(format!("凭据目录创建失败: {e}")))?;
    }
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    fs::write(&tmp, secret).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        internal(format!("凭据写入失败: {e}"))
    })?;
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        internal(format!("凭据文件替换失败: {e}"))
    })
}

fn scopes_json(scopes: &[String]) -> String {
    serde_json::to_string(scopes).unwrap_or_else(|_| "[]".to_string())
}

fn parse_scopes(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn summary(state: &AppState, row: vmusic_store::ai::GrantRow) -> GrantSummary {
    GrantSummary {
        credential_path: credential_path(state, &row.grant_id)
            .to_string_lossy()
            .into_owned(),
        grant_id: row.grant_id,
        label: row.label,
        scopes: parse_scopes(&row.scopes),
        revoked: row.revoked,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

/// 校验申请的 scope：逐项过白名单，去重；空申请没有意义，直接拒绝。
fn normalize_scopes(scopes: &[String]) -> Result<Vec<String>, ApiError> {
    if scopes.is_empty() {
        return Err(bad_request("至少申请一个 scope"));
    }
    let mut out: Vec<String> = Vec::new();
    for scope in scopes {
        if !SCOPES.contains(&scope.as_str()) {
            return Err(bad_request(format!("未知 scope: {scope}")));
        }
        if !out.contains(scope) {
            out.push(scope.clone());
        }
    }
    Ok(out)
}

pub(crate) async fn list_grants(state: &Arc<AppState>) -> Result<Vec<GrantSummary>, ApiError> {
    let rows = vmusic_store::ai::list_grants(&state.db)
        .await
        .map_err(store_error)?;
    Ok(rows.iter().map(|row| summary(state, row.clone())).collect())
}

pub(crate) async fn create_grant(
    state: &Arc<AppState>,
    label: &str,
    scopes: &[String],
) -> Result<GrantSummary, ApiError> {
    let scopes = normalize_scopes(scopes)?;
    let label = label.trim();
    if label.len() > 128 {
        return Err(bad_request("label 超过 128 字符上限"));
    }
    let grant_id = uuid::Uuid::new_v4().to_string();
    let secret = random_secret()?;
    vmusic_store::ai::insert_grant(
        &state.db,
        &grant_id,
        label,
        &digest(&secret),
        &scopes_json(&scopes),
    )
    .await
    .map_err(store_error)?;
    let path = credential_path(state, &grant_id);
    if let Err(err) = write_credential_file(&path, &secret) {
        // 文件写不进去的 grant 对适配器毫无用处：回滚登记，别留一条
        // 「活着但永远连不上」的记录。
        let _ = vmusic_store::ai::revoke_grant(&state.db, &grant_id).await;
        return Err(err);
    }
    vmusic_store::ai::bump_policy_revision(&state.db)
        .await
        .map_err(store_error)?;
    let row = vmusic_store::ai::find_grant_by_id(&state.db, &grant_id)
        .await
        .map_err(store_error)?
        .ok_or_else(|| internal("grant 创建后不可见"))?;
    Ok(summary(state, row))
}

pub(crate) async fn rotate_grant(
    state: &Arc<AppState>,
    grant_id: &str,
) -> Result<GrantSummary, ApiError> {
    let row = vmusic_store::ai::find_grant_by_id(&state.db, grant_id)
        .await
        .map_err(store_error)?
        .ok_or_else(|| not_found(format!("查无此 grant: {grant_id}")))?;
    if row.revoked {
        return Err(bad_request("已撤销的授权不能轮换，请新建"));
    }
    let secret = random_secret()?;
    vmusic_store::ai::update_grant_credential(&state.db, grant_id, &digest(&secret))
        .await
        .map_err(store_error)?;
    write_credential_file(&credential_path(state, grant_id), &secret)?;
    vmusic_store::ai::bump_policy_revision(&state.db)
        .await
        .map_err(store_error)?;
    let row = vmusic_store::ai::find_grant_by_id(&state.db, grant_id)
        .await
        .map_err(store_error)?
        .ok_or_else(|| internal("grant 轮换后不可见"))?;
    Ok(summary(state, row))
}

pub(crate) async fn revoke_grant(
    state: &Arc<AppState>,
    grant_id: &str,
) -> Result<GrantSummary, ApiError> {
    let existed = vmusic_store::ai::revoke_grant(&state.db, grant_id)
        .await
        .map_err(store_error)?;
    if !existed {
        return Err(not_found(format!("查无此 grant: {grant_id}")));
    }
    // 凭据文件一并清掉：旧的适配器进程即使重启也拿不到可用的秘密。
    let _ = std::fs::remove_file(credential_path(state, grant_id));
    vmusic_store::ai::bump_policy_revision(&state.db)
        .await
        .map_err(store_error)?;
    let row = vmusic_store::ai::find_grant_by_id(&state.db, grant_id)
        .await
        .map_err(store_error)?
        .ok_or_else(|| internal("grant 撤销后不可见"))?;
    Ok(summary(state, row))
}

/// 用呈现的凭据换可信上下文。错误统一不回显凭据内容，也不区分
/// 「凭据不存在」与「凭据错误」——两种情况对攻击者是一样的信息。
pub(crate) async fn authenticate(
    state: &Arc<AppState>,
    presented: &str,
) -> Result<GrantContext, ApiError> {
    let row = vmusic_store::ai::find_grant_by_digest(&state.db, &digest(presented))
        .await
        .map_err(store_error)?;
    let Some(row) = row else {
        return Err(unauthorized());
    };
    if row.revoked {
        return Err(ApiError::new(
            axum::http::StatusCode::FORBIDDEN,
            "grant_revoked",
            "该授权已被撤销",
        ));
    }
    let instance = vmusic_store::ai::get_or_create_instance(&state.db)
        .await
        .map_err(store_error)?;
    Ok(GrantContext {
        grant_id: row.grant_id,
        scopes: parse_scopes(&row.scopes).into_iter().collect(),
        policy_revision: instance.policy_revision,
        owner_instance_id: instance.owner_instance_id,
        server_instance_id: state.server_instance_id.clone(),
    })
}

/// 受限门面的身份与能力投影（§5.4）：主体、scope、策略水位、实例身份与
/// 能力表。调用方拿它与本地快照比对，revision 变了就重新对接。
pub(crate) fn context_json(ctx: &GrantContext, stage_tools_enabled: bool) -> Value {
    json!({
        "protocolVersion": CAPABILITY_VERSION,
        "principal": { "kind": "grant", "grantId": ctx.grant_id },
        "scopes": ctx.scopes.iter().collect::<Vec<_>>(),
        "policyRevision": ctx.policy_revision,
        "stageIntentToolsEnabled": stage_tools_enabled,
        "instance": {
            "ownerInstanceId": ctx.owner_instance_id,
            "serverInstanceId": ctx.server_instance_id,
            "edition": crate::edition::NAME,
            "transport": "http",
        },
        "capabilities": CAPABILITIES.iter().filter(|c| !c.operation.starts_with("stage.") || stage_tools_enabled).map(|c| json!({
            "operation": c.operation,
            "scope": c.scope,
            "effect": c.effect.as_str(),
            "description": c.description,
        })).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::capability::{execute, CapabilityCall};
    use serde_json::{json, Value};

    #[tokio::test]
    async fn stage_tools_require_scopes_and_switch_and_do_not_create_jobs() {
        let (state, handle) = ai_state().await;
        let no_scope = ctx_of("reader", &["playback:read"]);
        let ctx = ctx_of(
            "stage-reader",
            &["stage:capabilities_read", "stage:intent_validate"],
        );
        let request = || CapabilityCall {
            operation: "stage_capabilities_get".into(),
            client_operation_id: None,
            input: json!({"limit": 2}),
        };
        assert_eq!(
            execute(&state, &no_scope, request())
                .await
                .unwrap_err()
                .code,
            "scope_required"
        );
        assert_eq!(
            execute(&state, &ctx, request()).await.unwrap_err().code,
            "stage_tools_disabled"
        );
        vmusic_store::settings::set(
            &state.db,
            crate::ai::capability::STAGE_TOOLS_KEY,
            &json!(true),
        )
        .await
        .unwrap();
        let page = execute(&state, &ctx, request()).await.unwrap();
        assert_eq!(page["scenes"].as_array().unwrap().len(), 2);
        assert_eq!(page["nextOffset"], 2);
        let a = crate::ai::contract::artifact(
            &json!({"version": 1, "scene": "orb", "patch": {"sc.radius": 9999}}),
        );
        let validate = |input| CapabilityCall {
            operation: "stage_intent_validate".into(),
            client_operation_id: None,
            input,
        };
        let out = execute(&state, &ctx, validate(a.clone())).await.unwrap();
        assert_eq!(out["validationStage"], "intent");
        assert_eq!(out["applied"], false);
        let mut stale = a;
        stale["basePresetHash"] = json!("old");
        assert_eq!(
            execute(&state, &ctx, validate(stale))
                .await
                .unwrap_err()
                .code,
            "stage_artifact_invalid"
        );
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM ai_jobs")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(count.0, 0);
        state.audio.shutdown();
        handle.join().unwrap();
    }

    /// 门面测试用真实文件库 + 真实 DataDir：grants 表要 schema，
    /// 凭据文件要落在能被清理的目录里。
    async fn ai_state() -> (Arc<AppState>, std::thread::JoinHandle<()>) {
        let dir = std::env::temp_dir().join(format!("vmusic-ai-{}", uuid::Uuid::new_v4()));
        let db = vmusic_store::open(&dir).await.unwrap();
        let (mut state, handle) = crate::state::tests::playback_state_with_db(db).await;
        state.data_dir = dir;
        (Arc::new(state), handle)
    }

    /// 建 grant 并从凭据文件读回明文（服务端不回传，文件是唯一出口）。
    async fn make_grant(state: &Arc<AppState>, label: &str, scopes: &[&str]) -> (String, String) {
        let scopes: Vec<String> = scopes.iter().map(|s| s.to_string()).collect();
        let summary = create_grant(state, label, &scopes).await.unwrap();
        let secret = std::fs::read_to_string(&summary.credential_path).unwrap();
        (summary.grant_id, secret)
    }

    fn ctx_of(grant_id: &str, scopes: &[&str]) -> GrantContext {
        GrantContext {
            grant_id: grant_id.to_string(),
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
            policy_revision: 1,
            owner_instance_id: "owner-1".into(),
            server_instance_id: "server-1".into(),
        }
    }

    async fn call(
        state: &Arc<AppState>,
        ctx: &GrantContext,
        operation: &str,
        client_op: Option<&str>,
        input: Value,
    ) -> Result<Value, ApiError> {
        execute(
            state,
            ctx,
            CapabilityCall {
                operation: operation.to_string(),
                client_operation_id: client_op.map(str::to_string),
                input,
            },
        )
        .await
    }

    #[tokio::test]
    async fn grant_lifecycle_keeps_the_secret_out_of_every_answer() {
        let (state, handle) = ai_state().await;
        let (grant_id, secret) =
            make_grant(&state, "obs", &["playback:read", "playback:control"]).await;
        // 凭据是 64 个十六进制字符（256 位），只存在于文件里。
        assert_eq!(secret.len(), 64);
        assert!(secret.bytes().all(|b| b.is_ascii_hexdigit()));
        // 认证成功：上下文带 grantId、scopes 与递增过的策略水位。
        let ctx = authenticate(&state, &secret).await.unwrap();
        assert_eq!(ctx.grant_id, grant_id);
        assert_eq!(ctx.scopes.len(), 2);
        assert!(ctx.policy_revision >= 1);
        assert_eq!(ctx.server_instance_id, state.server_instance_id);
        assert!(!ctx.owner_instance_id.is_empty());

        // 轮换：旧凭据立即失效，新凭据生效，文件内容被替换。
        let summary = rotate_grant(&state, &grant_id).await.unwrap();
        let new_secret = std::fs::read_to_string(&summary.credential_path).unwrap();
        assert_ne!(new_secret, secret);
        let err = authenticate(&state, &secret).await.unwrap_err();
        assert_eq!(err.code, "unauthorized");
        assert!(authenticate(&state, &new_secret).await.is_ok());

        // 撤销：403 且凭据文件被清掉，重启后的适配器也拿不到可用秘密。
        revoke_grant(&state, &grant_id).await.unwrap();
        let err = authenticate(&state, &new_secret).await.unwrap_err();
        assert_eq!(err.code, "grant_revoked");
        assert!(!std::path::Path::new(&summary.credential_path).exists());
        // 列表保留历史（revoked 可查），但不含任何秘密。
        let grants = list_grants(&state).await.unwrap();
        assert_eq!(grants.len(), 1);
        assert!(grants[0].revoked);
        let encoded = serde_json::to_string(&grants).unwrap();
        assert!(!encoded.contains(&new_secret), "摘要应答不得回显凭据");
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn bad_credentials_fail_without_echoing_themselves() {
        let (state, handle) = ai_state().await;
        let err = authenticate(&state, "not-a-real-credential")
            .await
            .unwrap_err();
        assert_eq!(err.code, "unauthorized");
        assert!(!err.message.contains("not-a-real-credential"));
        // scope 申请的准入边界。
        assert_eq!(
            create_grant(&state, "x", &[]).await.unwrap_err().code,
            "bad_request"
        );
        let err = create_grant(&state, "x", &["nope:scope".into()])
            .await
            .unwrap_err();
        assert_eq!(err.code, "bad_request");
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn capability_call_enforces_scopes_and_projection() {
        let (state, handle) = ai_state().await;
        let (_id, secret) = make_grant(&state, "readonly", &["playback:read"]).await;
        let ctx = authenticate(&state, &secret).await.unwrap();
        // GrantContext 的手工构造保持可编译（受限中间件之外不应出现）。
        let _ = ctx_of("unused", &[]);

        // 只读快照：最小投影，没有元数据字段。
        let snap = call(&state, &ctx, "playback.snapshot_get", None, Value::Null)
            .await
            .unwrap();
        assert_eq!(snap["outcome"], "ok");
        let data = snap["data"].as_object().unwrap();
        assert!(data.contains_key("volume") && data.contains_key("positionMs"));
        assert!(!data.contains_key("title") && !data.contains_key("artist"));

        // 没有 control scope 的凭据对变更能力没有执行权。
        let err = call(&state, &ctx, "playback.next", None, Value::Null)
            .await
            .unwrap_err();
        assert_eq!(err.code, "scope_required");
        assert_eq!(err.status.as_u16(), 403);
        // 未登记的能力 404，无参命令拒绝携带未知字段。
        let err = call(&state, &ctx, "playback.replace_queue", None, Value::Null)
            .await
            .unwrap_err();
        assert_eq!(err.code, "capability_unsupported");
        let err = call(
            &state,
            &ctx,
            "playback.snapshot_get",
            None,
            json!({"junk": 1}),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "bad_request");
        state.audio.shutdown();
        handle.join().unwrap();
    }

    async fn upsert(state: &Arc<AppState>, id: &str) {
        vmusic_store::upsert_track(
            &state.db,
            &vmusic_core::Track {
                id: id.into(),
                path: format!("{id}.wav"),
                source: vmusic_core::TrackSource::Local,
                title: id.into(),
                artist: None,
                album: None,
                duration_ms: None,
                bitrate: None,
                sample_rate: None,
                channels: None,
                has_cover: false,
                file_mtime: None,
                file_size: None,
                added_at: 0,
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn mutation_calls_flow_through_short_write_per_grant() {
        let (state, handle) = ai_state().await;
        state
            .set_queue(
                vec!["first".into(), "second".into(), "third".into()],
                Some(0),
            )
            .await;
        state
            .audio
            .load("first.wav", Some("first".into()))
            .await
            .unwrap();
        upsert(&state, "second").await;
        upsert(&state, "third").await;
        let (_id_a, secret_a) = make_grant(&state, "a", &["playback:control"]).await;
        let (_id_b, secret_b) = make_grant(&state, "b", &["playback:control"]).await;
        let ctx_a = authenticate(&state, &secret_a).await.unwrap();
        let ctx_b = authenticate(&state, &secret_b).await.unwrap();

        // 同一 grant、同一键、同一输入：第二次回放，不真正切歌。
        let first = call(&state, &ctx_a, "playback.next", Some("op-1"), Value::Null)
            .await
            .unwrap();
        let second = call(&state, &ctx_a, "playback.next", Some("op-1"), Value::Null)
            .await
            .unwrap();
        assert_eq!(first["outcome"], "applied");
        assert_eq!(first, second);
        assert_eq!(state.current_index().await, Some(1));

        // 另一个 grant 用同一个 clientOperationId：principal 不同，各走各的。
        let other = call(&state, &ctx_b, "playback.next", Some("op-1"), Value::Null)
            .await
            .unwrap();
        assert_eq!(other["outcome"], "applied");
        assert_eq!(state.current_index().await, Some(2));

        // 输入投影：seek 带 camelCase 入参，未知字段拒绝；音量越界映射回
        // 既有 bad_request 机器码。
        let seek = call(
            &state,
            &ctx_a,
            "playback.seek",
            None,
            json!({"positionMs": 100}),
        )
        .await
        .unwrap();
        assert_eq!(seek["outcome"], "applied");
        let err = call(
            &state,
            &ctx_a,
            "playback.seek",
            None,
            json!({"positionMs": 100, "junk": 2}),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "bad_request");
        let err = call(
            &state,
            &ctx_a,
            "playback.volume_set",
            None,
            json!({"value": 1.5}),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "bad_request");

        // 受限门面的 resume 是严格语义：未装载曲目时如实上报 no_op。
        let (state2, handle2) = ai_state().await;
        state2.set_queue(vec!["first".into()], Some(0)).await;
        let (_id_c, secret_c) = make_grant(&state2, "c", &["playback:control"]).await;
        let ctx_c = authenticate(&state2, &secret_c).await.unwrap();
        let resumed = call(&state2, &ctx_c, "playback.resume", None, Value::Null)
            .await
            .unwrap();
        assert_eq!(resumed["outcome"], "no_op");
        assert_eq!(resumed["code"], "no_loaded_track");
        state.audio.shutdown();
        handle.join().unwrap();
        state2.audio.shutdown();
        handle2.join().unwrap();
    }

    #[tokio::test]
    async fn context_reports_identity_and_capabilities() {
        let (state, handle) = ai_state().await;
        let (_id, secret) = make_grant(&state, "ui", &["playback:read"]).await;
        let ctx = authenticate(&state, &secret).await.unwrap();
        let value = context_json(&ctx, false);
        assert_eq!(value["protocolVersion"], "1");
        assert_eq!(value["principal"]["kind"], "grant");
        assert_eq!(
            value["instance"]["serverInstanceId"],
            state.server_instance_id
        );
        assert_eq!(value["instance"]["edition"], crate::edition::NAME);
        let capabilities = value["capabilities"].as_array().unwrap();
        assert_eq!(capabilities.len(), 8);
        assert!(capabilities
            .iter()
            .all(|c| c["scope"].is_string() && c["operation"].is_string()));
        state.audio.shutdown();
        handle.join().unwrap();
    }
}
