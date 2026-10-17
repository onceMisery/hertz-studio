// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! AiService：持久生成任务的受理、执行、取消与恢复（技术路线 R4-J / §7）。
//!
//! 完整顺序（§7.1）：认证/实例/授权（传输层）→ 幂等键查询 → 新键的时间
//! 窗口、排队容量、provider 就绪与预算就绪 → 事务写 job + 费用预留 →
//! 返回 accepted → worker 复核派发授权 → 事务登记唯一派发标记 →
//! provider 一次调用 → 校验 intent → 事务写提案与终态。
//!
//! 不变量与约定：
//! - **输入不持久化**：brief 只存活在 [`AiRuntime`] 的有界内存里（容量受
//!   排队容量上限约束），commit 成功后归服务端所有；重启即丢，恢复把
//!   accepted/running 收敛为 interrupted，绝不自动重发 POST。
//! - **派发标记是本地线性化点**：`not_dispatched → may_have_been_sent`
//!   事务提交后才允许调用网络；其后的取消按 unknown 保守结算（预留全额
//!   转已计），这是避免低估费用的代价。
//! - **谁把状态推到终态，谁结算**：worker 与 cancel 都先 CAS 再按当时的
//!   dispatch_state 结算，输家（CAS 失败方）不碰预算。
//! - 本切片的 provider 是 fake：不产生真实费用，结算把预留全额释放、
//!   charged 记 0；「已派发但无 usage」的 unknown 路径按预留计入，与
//!   §8.4 的保守语义一致。usage entries 账本与熔断属于 R4-B。
//! - 任务行不清理（行本身是最小保护记录，无载荷存储）；容量上限按
//!   未完结数执行。7 天窗口之外的老 key 重试依赖行存在即回放，行不存在
//!   视为新任务——正式的墓碑台账归 R4-B。

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, RwLock};
use vmusic_core::StoreError;

use crate::error::{bad_request, internal, not_found, ApiError, ApiResult};
use crate::state::AppState;
use vmusic_store::ai_jobs as store;

/// 能力名（§7.1 完整顺序里的 capability 段）。
pub(crate) const CAPABILITY: &str = "stage.intent.generate";
/// 单任务费用预留（§8.3：单任务 50_000 micro-USD 上界）。
pub(crate) const RESERVATION_MICRO_USD: i64 = 50_000;
/// DataDir 月预算（§8.3：5 USD）。
pub(crate) const MONTHLY_LIMIT_MICRO_USD: i64 = 5_000_000;
/// 排队容量：1 个受管执行 + 最多 8 等待（§8.3）。
pub(crate) const QUEUE_CAPACITY: i64 = 9;
/// 排队 / 执行期限（§8.3）：60s / 30s。
pub(crate) const QUEUE_DEADLINE_MS: i64 = 60_000;
pub(crate) const RUN_DEADLINE_MS: i64 = 30_000;
/// 幂等键窗口（§7.2）：7 天。
pub(crate) const KEY_WINDOW_MS: i64 = 7 * 24 * 3600 * 1000;
/// 提案可读窗口（§7.3）：24 小时。
pub(crate) const PROPOSAL_TTL_MS: i64 = 24 * 3600 * 1000;
/// 业务输入上限（§8.3：16 KiB）。
pub(crate) const MAX_INPUT_BYTES: usize = 16 * 1024;
use crate::ai::contract;

// ---------------------------------------------------------------------------
// provider 接口与 fake 实现（R5 换真实 provider；fake 永远免费）
// ---------------------------------------------------------------------------

/// 生成一份 StageIntent 候选。一次任务最多一次调用（§8.1）：
/// 不自动修复、不自动重试，调用方不把 DB 事务重试包住它。
pub(crate) trait StageIntentProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn model(&self) -> &'static str;
    /// 就绪检查：cloud 凭据缺失/被禁用时返回 false，受理直接拒绝。
    fn ready(&self) -> bool;
    fn generate(
        &self,
        brief: String,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send>>;
}

/// fake provider：从 brief 派生确定性候选，零费用、零网络。供本切片的
/// 端到端验证与 R5 之前的官方 UI 联调；不对外宣传为模型能力。
pub(crate) struct FakeProvider;

impl StageIntentProvider for FakeProvider {
    fn id(&self) -> &'static str {
        "fake"
    }
    fn model(&self) -> &'static str {
        "fake-intent-v1"
    }
    fn ready(&self) -> bool {
        true
    }
    fn generate(
        &self,
        brief: String,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send>> {
        Box::pin(async move {
            let hash = Sha256::digest(brief.as_bytes());
            let seed = u32::from_be_bytes([hash[0], hash[1], hash[2], hash[3]]);
            // 场景与参数都来自内嵌的真实场景契约（creative-gl.js 导出物）：
            // 取该场景的第一个参数、把它拨到 min/max 之间由 seed 决定的位置，
            // 产出可复现且必然通过自家校验的候选。
            let scenes = contract::scenes();
            let scene = &scenes[(seed % scenes.len() as u32) as usize];
            let param = &scene.params[0];
            let value = match (param.min, param.max) {
                (Some(min), Some(max)) => min + (max - min) * f64::from(seed % 100) / 100.0,
                _ => 0.0,
            };
            let intent = json!({
                "version": 1,
                "scene": scene.id,
                "patch": { param.name.clone(): value },
            });
            Ok(intent)
        })
    }
}

// ---------------------------------------------------------------------------
// 运行时（挂在 AppState 上）
// ---------------------------------------------------------------------------

pub(crate) struct AiRuntime {
    /// 有界内存输入：job_id → brief。容量受排队容量上限约束（≤9 条），
    /// 不落盘；提交后由服务端持有，HTTP waiter 消失不影响。
    inputs: Mutex<HashMap<String, String>>,
    provider: RwLock<Arc<dyn StageIntentProvider>>,
    /// 模型执行槽（§8.3）：每 DataDir 1 个受管执行——worker 先拿槽再
    /// accepted→running，等满 8 个停在 accepted。清理中的调用仍占槽。
    execution_slots: Arc<tokio::sync::Semaphore>,
}

impl AiRuntime {
    pub(crate) fn new() -> Self {
        Self {
            inputs: Mutex::new(HashMap::new()),
            provider: RwLock::new(Arc::new(FakeProvider)),
            execution_slots: Arc::new(tokio::sync::Semaphore::new(1)),
        }
    }

    pub(crate) async fn provider(&self) -> Arc<dyn StageIntentProvider> {
        self.provider.read().await.clone()
    }

    /// 测试与将来的运行时换装入口；R5 真实 provider 落地后由配置驱动。
    #[cfg(test)]
    pub(crate) async fn install_provider(&self, provider: Arc<dyn StageIntentProvider>) {
        *self.provider.write().await = provider;
    }
}

impl Default for AiRuntime {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// 错误与结果
// ---------------------------------------------------------------------------

/// 受理结果：新任务或同键回放（回放携带原任务的**当前**事实）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub(crate) enum SubmitOutcome {
    Accepted { job: JobView },
    Replayed { job: JobView },
}

/// 面向官方 UI 的任务视图：无敏感输入，只有事实与代际。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JobView {
    pub job_id: String,
    pub principal: String,
    pub capability: String,
    pub state: String,
    pub state_revision: i64,
    pub dispatch_state: String,
    pub provider: String,
    pub model: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub result_proposal_id: Option<String>,
}

impl JobView {
    fn of(row: &store::JobRow) -> Self {
        Self {
            job_id: row.job_id.clone(),
            principal: row.principal.clone(),
            capability: row.capability.clone(),
            state: row.state.clone(),
            state_revision: row.state_revision,
            dispatch_state: row.dispatch_state.clone(),
            provider: row.provider.clone(),
            model: row.model.clone(),
            created_at: row.created_at,
            updated_at: row.updated_at,
            result_proposal_id: row.result_proposal_id.clone(),
        }
    }
}

fn store_error(err: StoreError) -> ApiError {
    ApiError::from(vmusic_core::CoreError::Store(err))
}

/// sqlx 自身的错误（begin/commit/acquire）：同一清洗路径。
fn sql_error(err: sqlx::Error) -> ApiError {
    store_error(StoreError::Database(err.to_string()))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// UTC 自然月键（§8.4）：由服务端生成，避免随系统时区重置额度。
/// Howard Hinnant 的 civil-from-days 算法，无外部依赖。
pub(crate) fn utc_month_key(now_ms: i64) -> String {
    let z = now_ms.div_euclid(86_400_000) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}")
}

fn input_hash(brief: &str) -> String {
    let digest = Sha256::digest(brief.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// 幂等键（§7.2）：`v1.<createdAtUnixMs>.<128-bit-hex>`。客户端键必须
/// 原样符合该格式（时间戳用于未来键拒绝），缺省时服务端生成全新键。
fn normalize_key(client_key: Option<&str>, now: i64) -> ApiResult<String> {
    let Some(raw) = client_key.map(str::trim).filter(|k| !k.is_empty()) else {
        let hex: String = uuid::Uuid::new_v4().simple().to_string();
        return Ok(format!("v1.{now}.{hex}"));
    };
    let parts: Vec<&str> = raw.splitn(3, '.').collect();
    let (prefix, ts, hex) = match parts.as_slice() {
        [prefix, ts, hex] => (*prefix, *ts, *hex),
        _ => {
            return Err(bad_request(
                "idempotencyKey 必须是 v1.<毫秒时间戳>.<32 位十六进制>",
            ))
        }
    };
    if prefix != "v1" || hex.len() != 32 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(bad_request(
            "idempotencyKey 必须是 v1.<毫秒时间戳>.<32 位十六进制>",
        ));
    }
    let created: i64 = ts
        .parse()
        .map_err(|_| bad_request("idempotencyKey 时间戳不合法"))?;
    if created > now + 5 * 60_000 {
        return Err(bad_request("idempotencyKey 来自超过 5 分钟的未来，已拒绝"));
    }
    if now - created > KEY_WINDOW_MS {
        return Err(bad_request("idempotencyKey 已超出 7 天回放窗口"));
    }
    Ok(raw.to_string())
}

/// StageIntent 候选校验（受控入口 §8.1）：白名单顶层键、深度 ≤ 8、
/// 总大小 ≤ 16 KiB、version/scene 形状。非法输出任务失败、不产提案。
fn validate_intent(intent: &Value) -> Result<(), String> {
    let serialized = serde_json::to_vec(intent).map_err(|e| e.to_string())?;
    if serialized.len() > MAX_INPUT_BYTES {
        return Err("intent 超过 16 KiB 上限".into());
    }
    const TOP: &[&str] = &["version", "scene", "patch", "director", "hand", "ruleIds"];
    let Value::Object(map) = intent else {
        return Err("intent 必须是对象".into());
    };
    for key in map.keys() {
        if !TOP.contains(&key.as_str()) {
            return Err(format!("intent 含未知顶层键: {key}"));
        }
    }
    if map.get("version").and_then(Value::as_i64) != Some(1) {
        return Err("intent.version 必须是 1".into());
    }
    // scene 必须能按真实契约解析（id 或别名），patch 键必须落在该场景的
    // 参数表内——结构合法但指向不存在参数的候选在这里失败，不假装成功。
    let scene = match map.get("scene") {
        Some(Value::String(scene)) if !scene.is_empty() && scene.len() <= 64 => scene,
        _ => return Err("intent.scene 必须是非空短字符串".into()),
    };
    let scene_def = contract::resolve_scene(scene)
        .ok_or_else(|| format!("intent.scene 不在当前场景契约内: {scene}"))?;
    if let Some(Value::Object(patch)) = map.get("patch") {
        for key in patch.keys() {
            if !contract::scene_has_param(scene_def, key) {
                return Err(format!(
                    "intent.patch 含场景 {} 未登记的参数: {key}",
                    scene_def.id
                ));
            }
        }
    }
    if !matches!(map.get("patch"), Some(Value::Object(_))) {
        return Err("intent.patch 必须是对象".into());
    }
    fn depth(v: &Value, d: usize) -> Result<(), String> {
        if d > 8 {
            return Err("intent 嵌套深度超过 8".into());
        }
        match v {
            Value::Object(map) => {
                for value in map.values() {
                    depth(value, d + 1)?;
                }
                Ok(())
            }
            Value::Array(items) => {
                for value in items {
                    depth(value, d + 1)?;
                }
                Ok(())
            }
            Value::Number(n) => {
                if !n.is_f64() || n.as_f64().is_some_and(|f| f.is_finite()) {
                    Ok(())
                } else {
                    Err("intent 含非有限数值".into())
                }
            }
            _ => Ok(()),
        }
    }
    depth(intent, 0)
}

// ---------------------------------------------------------------------------
// 受理 / 执行 / 取消 / 恢复 / 清扫
// ---------------------------------------------------------------------------

/// 重启恢复：accepted/running → interrupted，并按派发标记结算预留。
/// 必须在持有 AI runner 锁的进程里调用（bootstrap 已保证）。
pub(crate) async fn recover(state: &Arc<AppState>) -> ApiResult<usize> {
    let mut tx = vmusic_store::begin_immediate(&state.db)
        .await
        .map_err(store_error)?;
    let candidates = store::recovery_candidates(&mut *tx)
        .await
        .map_err(store_error)?;
    let now = now_ms();
    let mut recovered = 0;
    for job in candidates {
        // 结算先于状态收口（同事务原子）：not_dispatched 释放预留，
        // may_have_been_sent 按 unknown 保守转已计（§7.2）。
        settle_on_terminal(&mut *tx, &job).await?;
        if store::cas_job_state(
            &mut *tx,
            &job.job_id,
            &job.state,
            job.state_revision,
            "interrupted",
            now,
        )
        .await
        .map_err(store_error)?
        {
            recovered += 1;
        }
    }
    tx.commit().await.map_err(sql_error)?;
    state.ai_runtime.inputs.lock().await.clear();
    if recovered > 0 {
        tracing::warn!("AI 恢复：{recovered} 个未完结任务收敛为 interrupted");
    }
    Ok(recovered)
}

/// 结算：谁把状态推到终态谁结算。not_dispatched → 全额释放；
/// may_have_been_sent → 全额按已计（unknown 保守，§8.4）。
async fn settle_on_terminal(tx: &mut sqlx::SqliteConnection, job: &store::JobRow) -> ApiResult<()> {
    let month = utc_month_key(job.created_at);
    let (release, charge) = if job.dispatch_state == "may_have_been_sent" {
        // unknown（§8.4）：去预留，同时按预留金额计入已用一次。
        (RESERVATION_MICRO_USD, RESERVATION_MICRO_USD)
    } else {
        (RESERVATION_MICRO_USD, 0)
    };

    store::settle(&mut *tx, &month, release, charge)
        .await
        .map_err(store_error)?;
    Ok(())
}

/// 受理一条生成任务。幂等、容量、水位、预算与任务行在短事务内收口；
/// commit 成功后输入归服务端所有，worker 由这里 spawn。
pub(crate) async fn submit(
    state: &Arc<AppState>,
    principal: &str,
    brief: &str,
    idempotency_key: Option<&str>,
) -> ApiResult<SubmitOutcome> {
    // 唯一 AI runner（§5.5）：锁失的进程不受理新生成，即使共享 DataDir。
    if !state.ai_runner_held() {
        return Err(ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "ai_locked",
            "本进程未持有 AI runner 锁，生成受理停用",
        ));
    }
    let brief = brief.trim();
    if brief.is_empty() {
        return Err(bad_request("brief 不能为空"));
    }
    if brief.len() > MAX_INPUT_BYTES {
        return Err(bad_request("brief 超过 16 KiB 上限"));
    }
    let now = now_ms();
    // 实例身份先行（会创建 ai_instance 行），水位检查才有落点。
    let owner = instance_owner(state).await?;
    let watermark = {
        let mut conn = state.db.acquire().await.map_err(sql_error)?;
        store::accepted_watermark(&mut *conn)
            .await
            .map_err(store_error)?
    };
    if now + 5 * 60_000 < watermark {
        return Err(ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "clock_skew",
            "系统时间明显回跳，生成受理已暂停",
        ));
    }
    let key = normalize_key(idempotency_key, now)?;
    let hash = input_hash(brief);
    // 幂等回放先于 provider 就绪检查（§7.1 顺序）：已存在任务的合法回放
    // 不依赖当前 provider——删除或更换模型后旧事实仍可查。
    if let Some(existing) = store::find_job_by_key(&state.db, principal, CAPABILITY, &key)
        .await
        .map_err(store_error)?
    {
        if existing.input_hash == hash {
            return Ok(SubmitOutcome::Replayed {
                job: JobView::of(&existing),
            });
        }
        return Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "idempotency_conflict",
            "同一 idempotencyKey 携带了不同输入",
        ));
    }
    let provider = state.ai_runtime.provider().await;
    if !provider.ready() {
        return Err(ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "provider_unavailable",
            "生成 provider 当前不可用",
        ));
    }

    // 过期清扫先于容量检查：让可回收的名额先回来。
    sweep(state).await?;

    let mut tx = vmusic_store::begin_immediate(&state.db)
        .await
        .map_err(store_error)?;
    // 并发同键在唯一索引上兜底：查无此键的两个提交只有一个能插入。
    if let Some(existing) = store::find_job_by_key(&mut *tx, principal, CAPABILITY, &key)
        .await
        .map_err(store_error)?
    {
        if existing.input_hash == hash {
            return Ok(SubmitOutcome::Replayed {
                job: JobView::of(&existing),
            });
        }
        return Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "idempotency_conflict",
            "同一 idempotencyKey 携带了不同输入",
        ));
    }
    let incomplete = store::count_incomplete_jobs(&mut *tx, &owner)
        .await
        .map_err(store_error)?;
    if incomplete >= QUEUE_CAPACITY {
        return Err(ApiError::new(
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            "capacity_exceeded",
            "排队容量已满，请稍后重试",
        ));
    }
    store::reserve(
        &mut *tx,
        &utc_month_key(now),
        RESERVATION_MICRO_USD,
        MONTHLY_LIMIT_MICRO_USD,
    )
    .await
    .map_err(|e| match e {
        StoreError::Database(ref detail) if detail.starts_with("budget_exceeded") => ApiError::new(
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            "budget_exceeded",
            "本月生成预算已用尽",
        ),
        other => store_error(other),
    })?;
    store::advance_watermark(&mut *tx, &owner, now)
        .await
        .map_err(store_error)?;
    let job = store::JobRow {
        job_id: uuid::Uuid::new_v4().to_string(),
        owner_instance_id: owner.clone(),
        principal: principal.to_string(),
        capability: CAPABILITY.into(),
        key,
        input_hash: hash,
        state: "accepted".into(),
        state_revision: 1,
        dispatch_state: "not_dispatched".into(),
        attempt_id: None,
        provider: provider.id().to_string(),
        model: provider.model().to_string(),
        created_at: now,
        updated_at: now,
        result_proposal_id: None,
    };
    if let Err(e) = store::insert_job(&mut *tx, &job).await {
        // 并发同键撞唯一索引：按回放/冲突如实收口，而不是 500。
        if matches!(&e, StoreError::Database(detail) if detail.contains("UNIQUE")) {
            if let Some(existing) =
                store::find_job_by_key(&mut *tx, principal, CAPABILITY, &job.key)
                    .await
                    .map_err(store_error)?
            {
                if existing.input_hash == job.input_hash {
                    return Ok(SubmitOutcome::Replayed {
                        job: JobView::of(&existing),
                    });
                }
            }
        }
        return Err(store_error(e));
    }
    tx.commit().await.map_err(sql_error)?;

    // commit 成功：输入与许可归服务端所有。
    state
        .ai_runtime
        .inputs
        .lock()
        .await
        .insert(job.job_id.clone(), brief.to_string());
    tokio::spawn(run_job(state.clone(), job.job_id.clone()));
    Ok(SubmitOutcome::Accepted {
        job: JobView::of(&job),
    })
}

/// worker：唯一一次 provider 调用的执行 owner。
async fn run_job(state: Arc<AppState>, job_id: String) {
    let provider = state.ai_runtime.provider().await;
    // 运行槽：§7.1 状态图里 accepted→running 的条件就是「worker 获得运行槽」。
    // 取消/过期在槽外赢走终态时，这里拿槽后 CAS 失败即安静退出。
    let _slot = state.ai_runtime.execution_slots.acquire().await;
    let Some(_) = transition(state.clone(), &job_id, "accepted", "running").await else {
        state.ai_runtime.inputs.lock().await.remove(&job_id);
        return;
    };
    // 重取：running 的 CAS 已把 revision 推进，后续终态 CAS 必须用新值。
    let Some(job) = store::find_job_by_id(&state.db, &job_id)
        .await
        .ok()
        .flatten()
    else {
        state.ai_runtime.inputs.lock().await.remove(&job_id);
        return;
    };
    // 派发标记：本地派发线性化点。没抢到说明取消已赢——按 not_dispatched
    // 由取消方结算，这里直接退出。
    let attempt_id = uuid::Uuid::new_v4().to_string();
    let marked = async {
        let Ok(mut tx) = vmusic_store::begin_immediate(&state.db).await else {
            return false;
        };
        let Ok(marked) = store::mark_dispatched(&mut *tx, &job_id, &attempt_id).await else {
            return false;
        };
        // 0 行 = 取消/过期已赢（或已派发过）：不能继续执行。
        marked && tx.commit().await.is_ok()
    }
    .await;
    if !marked {
        state.ai_runtime.inputs.lock().await.remove(&job_id);
        return;
    }
    let brief = state.ai_runtime.inputs.lock().await.get(&job_id).cloned();
    let Some(brief) = brief else {
        // 输入丢失（不应发生）：如实失败，按 unknown 结算。
        finish_running(state.clone(), &job_id, "failed").await;
        return;
    };

    // 一次调用；不自动修复、不自动重试。取消已赢时这里照常跑完——
    // UI 事实已由取消方给出，资源结束由本任务负责（§8.1）。
    // 执行期限（§8.3：30s）到点终止卡住的 future——超时按 provider 失败
    // 走 failed + 结算，不无限驻留。
    let outcome = match tokio::time::timeout(
        std::time::Duration::from_millis(RUN_DEADLINE_MS as u64),
        provider.generate(brief),
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(_) => {
            tracing::warn!("AI provider 调用超过执行期限，已终止");
            finish_running(state.clone(), &job.job_id, "failed").await;
            state.ai_runtime.inputs.lock().await.remove(&job_id);
            return;
        }
    };
    match outcome {
        Ok(intent) => match validate_intent(&intent) {
            Ok(()) => {
                // 事务顺序即事实顺序：先 CAS 终态，赢了才落提案——否则
                // 「已取消的任务留下可读提案」。CAS 输掉时整个事务回滚，
                // 结算由赢家（取消/过期方）负责。
                let proposal_id = uuid::Uuid::new_v4().to_string();
                let now = now_ms();
                let mut tx = match vmusic_store::begin_immediate(&state.db).await {
                    Ok(tx) => tx,
                    Err(_) => return,
                };
                let won = store::cas_job_state(
                    &mut *tx,
                    &job.job_id,
                    "running",
                    job.state_revision,
                    "succeeded",
                    now,
                )
                .await
                .unwrap_or(false);
                if !won {
                    return;
                }
                let proposal = store::ProposalRow {
                    proposal_id: proposal_id.clone(),
                    job_id: job.job_id.clone(),
                    validated_intent: intent.to_string(),
                    schema_version: "1".into(),
                    state: "pending".into(),
                    revision: 1,
                    created_at: now,
                    expires_at: now + PROPOSAL_TTL_MS,
                };
                if store::insert_proposal(&mut *tx, &proposal).await.is_err()
                    || store::attach_proposal(&mut *tx, &job.job_id, &proposal_id)
                        .await
                        .is_err()
                {
                    return;
                }
                // fake 免费：预留全额释放，charged 记 0。
                let _ = store::settle(
                    &mut *tx,
                    &utc_month_key(job.created_at),
                    RESERVATION_MICRO_USD,
                    0,
                )
                .await;
                if tx.commit().await.is_err() {
                    return;
                }
            }
            Err(reason) => {
                tracing::warn!("AI 输出校验失败: {reason}");
                finish_running(state.clone(), &job.job_id, "failed").await;
            }
        },
        Err(reason) => {
            tracing::warn!("AI provider 调用失败: {reason}");
            finish_running(state.clone(), &job.job_id, "failed").await;
        }
    }
    state.ai_runtime.inputs.lock().await.remove(&job_id);
}

/// CAS 推进状态（accepted→running 的竞争入口）；成功返回任务行。
async fn transition(
    state: Arc<AppState>,
    job_id: &str,
    from: &str,
    to: &str,
) -> Option<store::JobRow> {
    let mut tx = vmusic_store::begin_immediate(&state.db).await.ok()?;
    let job = store::find_job_by_id(&mut *tx, job_id).await.ok()??;
    if store::cas_job_state(&mut *tx, job_id, from, job.state_revision, to, now_ms())
        .await
        .ok()?
    {
        tx.commit().await.ok()?;
        Some(job)
    } else {
        None
    }
}

/// 终态推进 + 结算（worker 的失败路径）。必须重取最新行：派发标记在
/// transition 之后才落库，拿旧对象结算会把已派发的预留误判成未派发。
async fn finish_running(state: Arc<AppState>, job_id: &str, to: &str) {
    let mut tx = match vmusic_store::begin_immediate(&state.db).await {
        Ok(tx) => tx,
        Err(_) => return,
    };
    let Some(job) = (match store::find_job_by_id(&mut *tx, job_id).await {
        Ok(job) => job,
        Err(_) => return,
    }) else {
        return;
    };
    if job.state != "running" {
        return;
    }
    if store::cas_job_state(
        &mut *tx,
        job_id,
        "running",
        job.state_revision,
        to,
        now_ms(),
    )
    .await
    .unwrap_or(false)
    {
        let _ = settle_on_terminal(&mut *tx, &job).await;
    }
    let _ = tx.commit().await;
}

/// 取消：expectedStateRevision 下的 CAS 竞争；赢家负责结算与输入清理。
pub(crate) async fn cancel(
    state: &Arc<AppState>,
    principal: &str,
    job_id: &str,
    expected_state_revision: i64,
) -> ApiResult<JobView> {
    sweep(state).await?;
    let mut tx = vmusic_store::begin_immediate(&state.db)
        .await
        .map_err(store_error)?;
    let job = store::find_job_by_id(&mut *tx, job_id)
        .await
        .map_err(store_error)?
        .filter(|job| job.principal == principal)
        .ok_or_else(|| not_found(format!("查无此任务: {job_id}")))?;
    if !matches!(job.state.as_str(), "accepted" | "running") {
        return Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "state_conflict",
            format!("任务已是终态: {}", job.state),
        ));
    }
    let from = job.state.clone();
    if !store::cas_job_state(
        &mut *tx,
        job_id,
        &from,
        expected_state_revision,
        "cancelled",
        now_ms(),
    )
    .await
    .map_err(store_error)?
    {
        return Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "state_conflict",
            "stateRevision 已过期，请重查后再试",
        ));
    }
    settle_on_terminal(&mut *tx, &job).await?;
    tx.commit().await.map_err(sql_error)?;
    state.ai_runtime.inputs.lock().await.remove(job_id);
    let mut view = JobView::of(&job);
    view.state = "cancelled".into();
    view.state_revision = job.state_revision + 1;
    Ok(view)
}

/// 过期清扫：排队超期（accepted >60s）与执行超期（running >30s）。
/// 惰性触发（submit/cancel/查询入口先扫一遍），无后台定时器。
async fn sweep(state: &Arc<AppState>) -> ApiResult<()> {
    let now = now_ms();
    let mut tx = vmusic_store::begin_immediate(&state.db)
        .await
        .map_err(store_error)?;
    let candidates =
        store::expired_candidates(&mut *tx, now - QUEUE_DEADLINE_MS, now - RUN_DEADLINE_MS)
            .await
            .map_err(store_error)?;
    for job in candidates {
        let to = if job.state == "accepted" {
            "expired"
        } else {
            "expired"
        };
        if store::cas_job_state(
            &mut *tx,
            &job.job_id,
            &job.state,
            job.state_revision,
            to,
            now,
        )
        .await
        .unwrap_or(false)
        {
            settle_on_terminal(&mut *tx, &job).await?;
            state.ai_runtime.inputs.lock().await.remove(&job.job_id);
        }
    }
    tx.commit().await.map_err(sql_error)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

pub(crate) async fn get_job(
    state: &Arc<AppState>,
    principal: &str,
    job_id: &str,
) -> ApiResult<JobView> {
    sweep(state).await?;
    let job = store::find_job_by_id(&state.db, job_id)
        .await
        .map_err(store_error)?
        .filter(|job| job.principal == principal)
        .ok_or_else(|| not_found(format!("查无此任务: {job_id}")))?;
    Ok(JobView::of(&job))
}

pub(crate) async fn list_jobs(
    state: &Arc<AppState>,
    principal: &str,
    owner: &str,
    before_created_at: Option<i64>,
    before_job_id: Option<&str>,
    limit: i64,
) -> ApiResult<Vec<JobView>> {
    sweep(state).await?;
    let rows = store::list_jobs(
        &state.db,
        owner,
        before_created_at,
        before_job_id,
        limit.clamp(1, 50),
    )
    .await
    .map_err(store_error)?;
    Ok(rows
        .iter()
        .filter(|job| &job.principal == principal)
        .map(JobView::of)
        .collect())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProposalView {
    pub proposal_id: String,
    pub job_id: String,
    pub state: String,
    pub revision: i64,
    pub created_at: i64,
    pub expires_at: i64,
    pub validated_intent: Value,
}

pub(crate) async fn get_proposal(
    state: &Arc<AppState>,
    principal: &str,
    proposal_id: &str,
) -> ApiResult<ProposalView> {
    let mut proposal = store::find_proposal(&state.db, proposal_id)
        .await
        .map_err(store_error)?
        .ok_or_else(|| not_found(format!("查无此提案: {proposal_id}")))?;
    // 过期惰性收口（§7.3 pending→expired）：过期提案不再以 pending 形状
    // 携带完整内容返回。
    if proposal.state == "pending" && proposal.expires_at <= now_ms() {
        if store::cas_proposal_state(&state.db, proposal_id, proposal.revision, "expired")
            .await
            .map_err(store_error)?
        {
            proposal.state = "expired".into();
            proposal.revision += 1;
        }
    }
    let job = store::find_job_by_id(&state.db, &proposal.job_id)
        .await
        .map_err(store_error)?
        .filter(|job| job.principal == principal)
        .ok_or_else(|| not_found(format!("查无此提案: {proposal_id}")))?;
    let _ = job;
    // expired 的提案只留事实，不带内容（与「过期不得以 pending 形状返回」
    // 同一条规则的另一半）。
    let intent: Value = if proposal.state == "expired" {
        Value::Null
    } else {
        serde_json::from_str(&proposal.validated_intent).map_err(|e| internal(e.to_string()))?
    };
    Ok(ProposalView {
        proposal_id: proposal.proposal_id,
        job_id: proposal.job_id,
        state: proposal.state,
        revision: proposal.revision,
        created_at: proposal.created_at,
        expires_at: proposal.expires_at,
        validated_intent: intent,
    })
}

/// 拒绝提案：expectedRevision 下的 CAS；不提供 apply（应用是原 owner 的
/// 前端职责，§6.3）。
pub(crate) async fn reject_proposal(
    state: &Arc<AppState>,
    principal: &str,
    proposal_id: &str,
    expected_revision: i64,
) -> ApiResult<ProposalView> {
    let mut view = get_proposal(state, principal, proposal_id).await?;
    let proposal = store::find_proposal(&state.db, proposal_id)
        .await
        .map_err(store_error)?
        .ok_or_else(|| not_found(format!("查无此提案: {proposal_id}")))?;
    if proposal.state != "pending" {
        return Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "state_conflict",
            format!("提案已是终态: {}", proposal.state),
        ));
    }
    if !store::cas_proposal_state(&state.db, proposal_id, expected_revision, "rejected")
        .await
        .map_err(store_error)?
    {
        return Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "state_conflict",
            "revision 已过期，请重查后再试",
        ));
    }
    view.state = "rejected".into();
    view.revision = expected_revision + 1;
    Ok(view)
}

/// 状态摘要（官方 UI 的 `GET /v1/ai/status`）。
pub(crate) async fn status(state: &Arc<AppState>, owner: &str) -> ApiResult<Value> {
    sweep(state).await?;
    let provider = state.ai_runtime.provider().await;
    let incomplete = store::count_incomplete_jobs(&state.db, owner)
        .await
        .map_err(store_error)?;
    let budget = {
        let mut conn = state.db.acquire().await.map_err(sql_error)?;
        store::get_or_create_month(&mut *conn, &utc_month_key(now_ms()))
            .await
            .map_err(store_error)?
    };
    Ok(json!({
        "capability": CAPABILITY,
        "provider": { "id": provider.id(), "model": provider.model(), "ready": provider.ready() },
        "queue": { "incomplete": incomplete, "capacity": QUEUE_CAPACITY },
        "budget": {
            "month": budget.month,
            "reservedMicroUsd": budget.reserved_micro_usd,
            "chargedMicroUsd": budget.charged_micro_usd,
            "limitMicroUsd": MONTHLY_LIMIT_MICRO_USD,
        },
    }))
}

pub(crate) async fn instance_owner(state: &Arc<AppState>) -> ApiResult<String> {
    Ok(vmusic_store::ai::get_or_create_instance(&state.db)
        .await
        .map_err(store_error)?
        .owner_instance_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct BlockedProvider {
        counter: Arc<std::sync::atomic::AtomicUsize>,
        gate: Arc<std::sync::atomic::AtomicBool>,
    }

    impl StageIntentProvider for BlockedProvider {
        fn id(&self) -> &'static str {
            "test"
        }
        fn model(&self) -> &'static str {
            "test-v1"
        }
        fn ready(&self) -> bool {
            true
        }
        fn generate(
            &self,
            _brief: String,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send>>
        {
            let counter = self.counter.clone();
            let gate = self.gate.clone();
            Box::pin(async move {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                // 轮询闸门：不依赖唤醒顺序，晚到的调用者也能等到放行。
                while !gate.load(std::sync::atomic::Ordering::SeqCst) {
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
                Ok(json!({ "version": 1, "scene": "space", "patch": {} }))
            })
        }
    }

    async fn jobs_state() -> (Arc<AppState>, std::thread::JoinHandle<()>) {
        let dir = std::env::temp_dir().join(format!("vmusic-aijobs-{}", uuid::Uuid::new_v4()));
        let db = vmusic_store::open(&dir).await.unwrap();
        let (state, handle) = crate::state::tests::playback_state_with_db(db).await;
        // 测试进程模拟「持锁服务」：生成受理的门禁打开。
        state
            .ai_runner_held
            .store(true, std::sync::atomic::Ordering::Relaxed);
        (Arc::new(state), handle)
    }

    #[tokio::test]
    async fn submit_is_gated_on_the_runner_lock() {
        let (state, handle) = jobs_state().await;
        state
            .ai_runner_held
            .store(false, std::sync::atomic::Ordering::Relaxed);
        let err = submit(&state, crate::idempotency::LOCAL_OWNER, "锁失进程", None)
            .await
            .unwrap_err();
        assert_eq!(err.status.as_u16(), 503);
        assert_eq!(err.code, "ai_locked");
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn stale_epoch_key_is_rejected_not_treated_as_new() {
        let (state, handle) = jobs_state().await;
        // 1970 年时间戳的键：从未出现过也不能当新收费动作受理（§7.2）。
        let key = "v1.0.00000000000000000000000000000000";
        let err = submit(
            &state,
            crate::idempotency::LOCAL_OWNER,
            "太老的键",
            Some(key),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "bad_request");
        assert!(err.message.contains("7 天"));
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn replay_works_even_when_provider_is_not_ready() {
        struct NotReady;
        impl StageIntentProvider for NotReady {
            fn id(&self) -> &'static str {
                "not-ready"
            }
            fn model(&self) -> &'static str {
                "none"
            }
            fn ready(&self) -> bool {
                false
            }
            fn generate(
                &self,
                _: String,
            ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send>>
            {
                Box::pin(async { Err("不该被调用".into()) })
            }
        }
        let (state, handle) = jobs_state().await;
        let key = format!("v1.{}.{:032x}", now_ms(), 42u128);
        let SubmitOutcome::Accepted { job } = submit(
            &state,
            crate::idempotency::LOCAL_OWNER,
            "先正常受理",
            Some(&key),
        )
        .await
        .unwrap() else {
            panic!("首次提交必须受理");
        };
        for _ in 0..200 {
            if job_row(&state, &job.job_id).await.state == "succeeded" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        // provider 不可用后：同键同输入仍然回放旧事实（§7.1 顺序）。
        state.ai_runtime.install_provider(Arc::new(NotReady)).await;
        let replay = submit(
            &state,
            crate::idempotency::LOCAL_OWNER,
            "先正常受理",
            Some(&key),
        )
        .await
        .unwrap();
        let SubmitOutcome::Replayed { job: replayed } = replay else {
            panic!("回放不得依赖 provider 就绪");
        };
        assert_eq!(replayed.job_id, job.job_id);
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn expired_proposal_is_swept_and_carries_no_content() {
        let (state, handle) = jobs_state().await;
        let SubmitOutcome::Accepted { job } = submit(
            &state,
            crate::idempotency::LOCAL_OWNER,
            "过期提案候选",
            None,
        )
        .await
        .unwrap() else {
            panic!("首次提交必须受理");
        };
        for _ in 0..200 {
            if job_row(&state, &job.job_id).await.state == "succeeded" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let done = job_row(&state, &job.job_id).await;
        let proposal_id = done.result_proposal_id.clone().unwrap();
        // 把过期时间拨回过去：读取时惰性收口为 expired。
        sqlx::query("UPDATE ai_proposals SET expires_at = 0 WHERE proposal_id = ?1")
            .bind(&proposal_id)
            .execute(&state.db)
            .await
            .unwrap();
        let view = get_proposal(&state, crate::idempotency::LOCAL_OWNER, &proposal_id)
            .await
            .unwrap();
        assert_eq!(view.state, "expired");
        assert!(view.validated_intent.is_null(), "过期提案不得携带完整内容");
        // 过期提案不能再被拒绝（非 pending）。
        let err = reject_proposal(&state, crate::idempotency::LOCAL_OWNER, &proposal_id, 1)
            .await
            .unwrap_err();
        assert_eq!(err.code, "state_conflict");
        state.audio.shutdown();
        handle.join().unwrap();
    }

    async fn job_row(state: &Arc<AppState>, job_id: &str) -> store::JobRow {
        store::find_job_by_id(&state.db, job_id)
            .await
            .unwrap()
            .unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn submit_runs_to_succeeded_and_proposal_is_readable() {
        let (state, handle) = jobs_state().await;
        let outcome = submit(
            &state,
            crate::idempotency::LOCAL_OWNER,
            "写一段深空缓慢推进",
            None,
        )
        .await
        .unwrap();
        let SubmitOutcome::Accepted { job } = outcome else {
            panic!("新键必须受理");
        };
        // 等 worker 完成（fake 即时）。
        for _ in 0..100 {
            if job_row(&state, &job.job_id).await.state == "succeeded" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let done = job_row(&state, &job.job_id).await;
        assert_eq!(done.state, "succeeded");
        assert_eq!(done.dispatch_state, "may_have_been_sent");
        let proposal = get_proposal(
            &state,
            crate::idempotency::LOCAL_OWNER,
            done.result_proposal_id.as_ref().unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(proposal.validated_intent["version"], 1);
        assert_eq!(proposal.state, "pending");
        // fake 免费：预留全额释放，charged 为 0。
        let status = status(&state, done.owner_instance_id.as_str())
            .await
            .unwrap();
        assert_eq!(status["budget"]["reservedMicroUsd"], json!(0));
        assert_eq!(status["budget"]["chargedMicroUsd"], json!(0));
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn idempotent_key_replays_and_conflicts() {
        let (state, handle) = jobs_state().await;
        let key = format!("v1.{}.{:032x}", now_ms(), 7u128);
        let outcome = submit(
            &state,
            crate::idempotency::LOCAL_OWNER,
            "同一个 brief",
            Some(&key),
        )
        .await
        .unwrap();
        let SubmitOutcome::Accepted { job } = outcome else {
            panic!("首次提交必须受理");
        };
        // 同键同输入：回放原任务（worker 可能还没跑完，回放返回当前事实）。
        let replay = submit(
            &state,
            crate::idempotency::LOCAL_OWNER,
            "同一个 brief",
            Some(&key),
        )
        .await
        .unwrap();
        let SubmitOutcome::Replayed { job: replayed } = replay else {
            panic!("同键同输入必须回放");
        };
        assert_eq!(replayed.job_id, job.job_id);
        // 同键异输入：冲突，不产生新任务。
        let err = submit(
            &state,
            crate::idempotency::LOCAL_OWNER,
            "另一个 brief",
            Some(&key),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "idempotency_conflict");
        // 未来键拒绝。
        let future = format!("v1.{}.{:032x}", now_ms() + 10 * 60_000, 8u128);
        let err = submit(&state, crate::idempotency::LOCAL_OWNER, "x", Some(&future))
            .await
            .unwrap_err();
        assert_eq!(err.code, "bad_request");
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn queue_capacity_rejects_the_tenth_incomplete_job() {
        let (state, handle) = jobs_state().await;
        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let gate = Arc::new(std::sync::atomic::AtomicBool::new(false));
        state
            .ai_runtime
            .install_provider(Arc::new(BlockedProvider {
                counter: counter.clone(),
                gate: gate.clone(),
            }))
            .await;
        // 9 个未完结：1 running + 8 accepted（provider 全部阻塞）。
        for _ in 0..QUEUE_CAPACITY {
            submit(
                &state,
                crate::idempotency::LOCAL_OWNER,
                &format!(
                    "brief-{}",
                    counter.load(std::sync::atomic::Ordering::SeqCst)
                ),
                None,
            )
            .await
            .unwrap();
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let err = submit(&state, crate::idempotency::LOCAL_OWNER, "第 10 个", None)
            .await
            .unwrap_err();
        assert_eq!(err.code, "capacity_exceeded");
        assert_eq!(err.status.as_u16(), 429);
        // 放行后容量回笼：轮询等全部任务到终态，再提交第 10 个。
        let done_owner = crate::ai::jobs::instance_owner(&state).await.unwrap();
        gate.store(true, std::sync::atomic::Ordering::SeqCst);
        for _ in 0..200 {
            if store::count_incomplete_jobs(&state.db, done_owner.as_str())
                .await
                .unwrap()
                == 0
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        submit(&state, crate::idempotency::LOCAL_OWNER, "第 10 个", None)
            .await
            .unwrap();
        for _ in 0..200 {
            if counter.load(std::sync::atomic::Ordering::SeqCst) == QUEUE_CAPACITY as usize + 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(
            counter.load(std::sync::atomic::Ordering::SeqCst),
            QUEUE_CAPACITY as usize + 1
        );
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_wins_by_revision_and_settles_by_dispatch_state() {
        let (state, handle) = jobs_state().await;
        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let gate = Arc::new(std::sync::atomic::AtomicBool::new(false));
        state
            .ai_runtime
            .install_provider(Arc::new(BlockedProvider {
                counter: counter.clone(),
                gate: gate.clone(),
            }))
            .await;
        let SubmitOutcome::Accepted { job } =
            submit(&state, crate::idempotency::LOCAL_OWNER, "阻塞后取消", None)
                .await
                .unwrap()
        else {
            panic!("首次提交必须受理");
        };
        // 等 worker 进入 running 且完成派发标记（两个提交点不同）。
        for _ in 0..200 {
            let row = job_row(&state, &job.job_id).await;
            if row.state == "running" && row.dispatch_state == "may_have_been_sent" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let running = job_row(&state, &job.job_id).await;
        assert_eq!(running.dispatch_state, "may_have_been_sent");
        // 过期 revision：冲突。
        let err = cancel(
            &state,
            crate::idempotency::LOCAL_OWNER,
            &job.job_id,
            running.state_revision - 1,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "state_conflict");
        // 正确 revision：取消成功，unknown 结算（已派发 → 预留转已计）。
        let view = cancel(
            &state,
            crate::idempotency::LOCAL_OWNER,
            &job.job_id,
            running.state_revision,
        )
        .await
        .unwrap();
        assert_eq!(view.state, "cancelled");
        let status = status(&state, running.owner_instance_id.as_str())
            .await
            .unwrap();
        assert_eq!(
            status["budget"]["chargedMicroUsd"],
            json!(RESERVATION_MICRO_USD)
        );
        assert_eq!(status["budget"]["reservedMicroUsd"], json!(0));
        // 重复取消：终态冲突。
        let err = cancel(
            &state,
            crate::idempotency::LOCAL_OWNER,
            &job.job_id,
            running.state_revision,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "state_conflict");
        // 放行阻塞的 provider：worker 静默退出，不再改写终态。
        gate.store(true, std::sync::atomic::Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(job_row(&state, &job.job_id).await.state, "cancelled");
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recovery_marks_incomplete_jobs_interrupted_and_settles() {
        let (state, handle) = jobs_state().await;
        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let gate = Arc::new(std::sync::atomic::AtomicBool::new(false));
        state
            .ai_runtime
            .install_provider(Arc::new(BlockedProvider {
                counter: counter.clone(),
                gate: gate.clone(),
            }))
            .await;
        let SubmitOutcome::Accepted { job } =
            submit(&state, crate::idempotency::LOCAL_OWNER, "重启前受理", None)
                .await
                .unwrap()
        else {
            panic!("首次提交必须受理");
        };
        // 等 worker 完成「running + 已派发标记」两个提交点。
        for _ in 0..200 {
            let row = job_row(&state, &job.job_id).await;
            if row.state == "running" && row.dispatch_state == "may_have_been_sent" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        // 模拟重启：内存输入全丢，恢复把未完结收敛为 interrupted。
        let recovered = recover(&state).await.unwrap();
        assert_eq!(recovered, 1);
        let after = job_row(&state, &job.job_id).await;
        assert_eq!(after.state, "interrupted");
        // 已派发：保守按 unknown 结算（预留转已计），不释放额度。
        let status = status(&state, after.owner_instance_id.as_str())
            .await
            .unwrap();
        assert_eq!(
            status["budget"]["chargedMicroUsd"],
            json!(RESERVATION_MICRO_USD)
        );
        // 放行：worker 的迟到 provider 结果不得改写终态。
        gate.store(true, std::sync::atomic::Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(job_row(&state, &job.job_id).await.state, "interrupted");
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn expired_jobs_are_swept_and_reservation_released() {
        let (state, handle) = jobs_state().await;
        // 用阻塞 provider 造一个 accepted，但把受理时间拨回 61 秒前。
        state
            .ai_runtime
            .install_provider(Arc::new(BlockedProvider {
                counter: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                gate: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            }))
            .await;
        let SubmitOutcome::Accepted { job } =
            submit(&state, crate::idempotency::LOCAL_OWNER, "过期候选", None)
                .await
                .unwrap()
        else {
            panic!("首次提交必须受理");
        };
        let stale = now_ms() - QUEUE_DEADLINE_MS - 1000;
        sqlx::query("UPDATE ai_jobs SET created_at = ?2 WHERE job_id = ?1")
            .bind(&job.job_id)
            .bind(stale)
            .execute(&state.db)
            .await
            .unwrap();
        sweep(&state).await.unwrap();
        let after = job_row(&state, &job.job_id).await;
        assert_eq!(after.state, "expired");
        let status = status(&state, after.owner_instance_id.as_str())
            .await
            .unwrap();
        assert_eq!(status["budget"]["reservedMicroUsd"], json!(0));
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[test]
    fn intent_validation_rejects_unknown_and_oversized() {
        assert!(validate_intent(&json!({ "version": 1, "scene": "towers", "patch": {} })).is_ok());
        // 不在当前场景表里的 scene 一律失败（"space" 曾是假场景名）。
        assert!(validate_intent(&json!({ "version": 1, "scene": "space", "patch": {} })).is_err());
        assert!(validate_intent(&json!({ "version": 2, "scene": "towers", "patch": {} })).is_err());
        assert!(validate_intent(
            &json!({ "version": 1, "scene": "towers", "patch": {}, "junk": 1 })
        )
        .is_err());
        // patch 键必须落在场景参数表内（结构合法但参数不存在也失败）。
        assert!(validate_intent(
            &json!({ "version": 1, "scene": "towers", "patch": { "intensity": 1 } })
        )
        .is_err());
        assert!(validate_intent(
            &json!({ "version": 1, "scene": "towers", "patch": { "height": 5.5 } })
        )
        .is_ok());
        let deep = json!({ "version": 1, "scene": "s", "patch": { "a": { "b": { "c": { "d": { "e": { "f": { "g": { "h": { "i": 1 } } } } } } } } } });
        assert!(validate_intent(&deep).is_err());
        let oversized = json!({ "version": 1, "scene": "x".repeat(20000), "patch": {} });
        assert!(validate_intent(&oversized).is_err());
    }

    #[test]
    fn month_key_is_utc_natural_month() {
        // 2026-10-17T00:00:00Z ≈ 1792070400000ms。
        assert_eq!(utc_month_key(1_792_070_400_000), "2026-10");
        // 2026-01-01T00:00:00Z。
        assert_eq!(utc_month_key(1_767_225_600_000), "2026-01");
        // 跨年边界：2025-12-31T23:59:59Z。
        assert_eq!(utc_month_key(1_767_225_599_000), "2025-12");
    }
}
