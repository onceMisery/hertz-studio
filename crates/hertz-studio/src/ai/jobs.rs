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
//! - **终态赢家负责初次结算**：worker 与 cancel 先 CAS 再按派发事实和
//!   可信 usage 结算；终态输家只允许在同 attempt 下独立校正迟到 usage。
//! - 价格快照与预留在受理时冻结。缺失 usage 按预留计 unknown；成功、
//!   失败、非法输出和取消均不决定实际费用。运行时仍是免费 fake provider。
//! - 任务最小记录保留 7 天，过期提案清除载荷；账本独立保留 13 个月。
//!   500 条任务与 20 MiB 逻辑数据满额时拒绝新受理，不淘汰受保护记录。
//!   明显校时回跳暂停新受理与清理；过期旧 key 绝不作为新收费动作。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use futures::FutureExt;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, RwLock};
use vmusic_core::StoreError;

use crate::error::{ApiError, ApiResult, bad_request, internal, not_found};
use crate::state::{AppState, WsEvent};
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
pub(crate) const HISTORY_JOB_LIMIT: i64 = 500;
pub(crate) const HISTORY_BYTE_LIMIT: i64 = 20 * 1024 * 1024;
pub(crate) const HISTORY_TASK_HEADROOM_BYTES: i64 = 36 * 1024;
/// 提案可读窗口（§7.3）：24 小时。
pub(crate) const PROPOSAL_TTL_MS: i64 = 24 * 3600 * 1000;
/// in-app 生成同意开关的 settings 键（§8.2）：默认关闭，官方设置里明确
/// 开启才受理新任务——「已同意 AI」这类笼统开关不做，开关与数据范围一一对应。
pub(crate) const CONSENT_KEY: &str = "ai_generation_consent";
/// 业务输入上限（§8.3：16 KiB）。
pub(crate) const MAX_INPUT_BYTES: usize = 16 * 1024;
use crate::ai::contract::{self, validate_intent};
use crate::ai::usage::{self, PriceQuote, PricingSnapshot, TrustedUsage};

// ---------------------------------------------------------------------------
// provider 接口与 fake 实现（R5 换真实 provider；fake 永远免费）
// ---------------------------------------------------------------------------

/// 生成一份 StageIntent 候选。一次任务最多一次调用（§8.1）：
/// 不自动修复、不自动重试，调用方不把 DB 事务重试包住它。
pub(crate) trait StageIntentProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn model(&self) -> &str;
    fn diagnostic(&self) -> Option<&'static str> {
        None
    }
    /// 就绪检查：cloud 凭据缺失/被禁用时返回 false，受理直接拒绝。
    fn ready(&self) -> bool;
    fn requires_openai_credential(&self) -> bool {
        false
    }
    /// Generic completions outside the persistent task/ledger path may only
    /// run on providers whose requests have no remote monetary cost.
    fn supports_zero_cost_completion(&self) -> bool {
        false
    }
    /// Freeze a reliable bound for the complete request, not just the brief.
    /// No network or model call is allowed while producing this quote.
    fn quote(&self, brief: &str) -> Result<PriceQuote, String>;
    fn generate(
        &self,
        brief: String,
        pricing: PricingSnapshot,
        credential: Option<crate::ai::credential::ProviderCredential>,
        cancellation: ProviderCancellation,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ProviderReply> + Send>>;

    /// Generic text completion for non-stage capabilities (lyric emotion
    /// classification). It reuses this provider's transport, credentials and
    /// cancellation; providers that only implement StageIntent keep the safe
    /// default rejection. Classification does not own a second HTTP client.
    fn complete(
        &self,
        _system: String,
        _user: String,
        _credential: Option<crate::ai::credential::ProviderCredential>,
        _cancellation: ProviderCancellation,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<CompletionReply, String>> + Send>>
    {
        Box::pin(async { Err("provider does not support generic completion".to_string()) })
    }
}

/// Generation validity and billing are independent: even a rejected candidate
/// or provider error may carry trustworthy billable counters.
pub(crate) struct ProviderReply {
    pub intent: Result<Value, String>,
    pub usage: Option<TrustedUsage>,
}

pub(crate) struct CompletionReply {
    pub text: String,
}

/// One task's terminal signal, independent of its HTTP/RPC observer. Removing
/// the committed task's input closes the sender only after terminal settlement.
/// Adapters stop their own transport; the worker still owns the execution slot
/// until that adapter future exits. A default signal is for standalone evals.
#[derive(Clone, Default)]
pub(crate) struct ProviderCancellation(Option<tokio::sync::watch::Receiver<()>>);

impl ProviderCancellation {
    pub(crate) fn from_receiver(receiver: tokio::sync::watch::Receiver<()>) -> Self {
        Self(Some(receiver))
    }

    pub(crate) async fn cancelled(&mut self) {
        match self.0.as_mut() {
            Some(receiver) => {
                let _ = receiver.changed().await;
            }
            None => std::future::pending().await,
        }
    }
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
    fn quote(&self, _brief: &str) -> Result<PriceQuote, String> {
        Ok(PriceQuote::fake())
    }
    fn generate(
        &self,
        brief: String,
        _pricing: PricingSnapshot,
        _credential: Option<crate::ai::credential::ProviderCredential>,
        _cancellation: ProviderCancellation,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ProviderReply> + Send>> {
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
                "patch": { format!("sc.{}", param.name): value },
            });
            ProviderReply {
                intent: Ok(intent),
                usage: Some(TrustedUsage::free()),
            }
        })
    }
}

// ---------------------------------------------------------------------------
// 运行时（挂在 AppState 上）
// ---------------------------------------------------------------------------

pub(crate) struct AiRuntime {
    pub(crate) credentials: Arc<super::credential::Service>,
    /// 有界内存输入：job_id → brief。容量受排队容量上限约束（≤9 条），
    /// 不落盘；提交后由服务端持有，HTTP waiter 消失不影响。
    inputs: Mutex<HashMap<String, (String, tokio::sync::watch::Sender<()>)>>,
    provider: RwLock<Arc<dyn StageIntentProvider>>,
    /// 模型执行槽（§8.3）：每 DataDir 1 个受管执行——worker 先拿槽再
    /// accepted→running，等满 8 个停在 accepted。清理中的调用仍占槽。
    execution_slots: Arc<tokio::sync::Semaphore>,
}

impl AiRuntime {
    pub(crate) fn new() -> Self {
        let runtime = Self::from_config(&crate::config::AiConfig::default());
        #[cfg(test)]
        let runtime = Self {
            credentials: super::credential::Service::isolated(),
            ..runtime
        };
        runtime
    }

    pub(crate) fn from_config(config: &crate::config::AiConfig) -> Self {
        Self {
            credentials: super::credential::Service::shared(),
            inputs: Mutex::new(HashMap::new()),
            provider: RwLock::new(super::provider::configured(config)),
            execution_slots: Arc::new(tokio::sync::Semaphore::new(1)),
        }
    }

    pub(crate) async fn provider(&self) -> Arc<dyn StageIntentProvider> {
        self.provider.read().await.clone()
    }

    pub(crate) fn completion_slots(&self) -> Arc<tokio::sync::Semaphore> {
        self.execution_slots.clone()
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
    pub usage: JobUsageView,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JobUsageView {
    pub accepted_month: String,
    pub reservation_micro_usd: i64,
    pub accounted_micro_usd: Option<i64>,
    pub usage_state: String,
    pub usage_revision: i64,
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
            usage: JobUsageView {
                accepted_month: utc_month_key(row.created_at),
                reservation_micro_usd: row.reservation_micro_usd,
                accounted_micro_usd: None,
                usage_state: "reserved".into(),
                usage_revision: 0,
            },
        }
    }

    async fn with_usage<'c, E: sqlx::Executor<'c, Database = sqlx::Sqlite>>(
        row: &store::JobRow,
        conn: E,
    ) -> ApiResult<Self> {
        let mut view = Self::of(row);
        if let Some(entry) = store::find_usage_entry(conn, &row.job_id)
            .await
            .map_err(store_error)?
        {
            view.usage = JobUsageView {
                accepted_month: entry.accepted_month,
                reservation_micro_usd: entry.reservation_micro_usd,
                accounted_micro_usd: Some(entry.accounted_micro_usd),
                usage_state: entry.usage_state,
                usage_revision: entry.revision,
            };
        }
        Ok(view)
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
            ));
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
    if now.saturating_sub(created) > KEY_WINDOW_MS {
        return Err(bad_request("idempotencyKey 已超出 7 天回放窗口"));
    }
    Ok(raw.to_string())
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
    let mut events = Vec::new();
    for job in candidates {
        // 结算先于状态收口（同事务原子）：not_dispatched 释放预留，
        // may_have_been_sent 按 unknown 保守转已计（§7.2）。
        settle_on_terminal(&mut tx, &job, "interrupted").await?;
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
            events.push((job.job_id, job.state_revision + 1));
        }
    }
    tx.commit().await.map_err(sql_error)?;
    let recovered = events.len();
    for (id, revision) in events {
        publish_task(state, "interrupted", &id, revision);
    }
    state.ai_runtime.inputs.lock().await.clear();
    if recovered > 0 {
        tracing::warn!("AI 恢复：{recovered} 个未完结任务收敛为 interrupted");
    }
    Ok(recovered)
}

/// 结算：谁把状态推到终态谁结算。not_dispatched → 全额释放；
/// may_have_been_sent → 全额按已计（unknown 保守，§8.4）。
async fn settle_on_terminal(
    tx: &mut sqlx::SqliteConnection,
    job: &store::JobRow,
    _to_state: &str,
) -> ApiResult<()> {
    usage::settle_terminal(tx, job, None, now_ms()).await
}

/// 受理一条生成任务。幂等、容量、水位、预算与任务行在短事务内收口；
/// commit 成功后输入归服务端所有，worker 由这里 spawn。
pub(crate) async fn submit(
    state: &Arc<AppState>,
    principal: &str,
    brief: &str,
    idempotency_key: Option<&str>,
) -> ApiResult<SubmitOutcome> {
    let state = state.clone();
    let principal = principal.to_string();
    let brief = brief.to_string();
    let key = idempotency_key.map(str::to_string);
    tokio::spawn(async move { submit_owned(&state, &principal, &brief, key.as_deref()).await })
        .await
        .map_err(|e| internal(format!("AI acceptance failed: {e}")))?
}

async fn check_generation(
    conn: &mut sqlx::SqliteConnection,
    owner: &str,
    now: i64,
) -> ApiResult<()> {
    let consent: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?1")
        .bind(CONSENT_KEY)
        .fetch_optional(&mut *conn)
        .await
        .map_err(sql_error)?;
    if consent
        .as_deref()
        .and_then(|v| serde_json::from_str::<Value>(v).ok())
        != Some(Value::Bool(true))
    {
        return Err(ApiError::new(
            axum::http::StatusCode::FORBIDDEN,
            "generation_disabled",
            "生成功能已关闭",
        ));
    }
    if store::ensure_budget_guard(conn, owner)
        .await
        .map_err(store_error)?
        .halted
    {
        return Err(ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "budget_halted",
            "生成预算已触发熔断",
        ));
    }
    if now.saturating_add(5 * 60_000)
        < store::accepted_watermark(&mut *conn)
            .await
            .map_err(store_error)?
    {
        return Err(ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "clock_skew",
            "系统时间明显回跳，生成受理已暂停",
        ));
    }
    Ok(())
}

async fn submit_owned(
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
                job: JobView::with_usage(&existing, &state.db).await?,
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

    let quote = provider.quote(brief).map_err(|reason| {
        ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "pricing_unavailable",
            reason,
        )
    })?;
    quote.validate().map_err(|reason| {
        ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "pricing_unavailable",
            reason,
        )
    })?;
    let credential = if provider.requires_openai_credential() {
        Some(state.ai_runtime.credentials.snapshot(&owner).await?)
    } else {
        None
    };
    let pricing = PricingSnapshot {
        provider: provider.id().to_string(),
        model: provider.model().to_string(),
        quote,
        credential: credential.as_ref().map(super::credential::Lease::identity),
    };

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
                job: JobView::with_usage(&existing, &mut *tx).await?,
            });
        }
        return Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "idempotency_conflict",
            "同一 idempotencyKey 携带了不同输入",
        ));
    }
    check_generation(&mut tx, &owner, now).await?;
    let (history_jobs, history_bytes) = store::ai_history_capacity(&mut tx)
        .await
        .map_err(store_error)?;
    // Reserve enough logical space for each admitted task's bounded proposal and metadata.
    let pending = store::count_incomplete_jobs(&mut *tx, &owner)
        .await
        .map_err(store_error)?;
    if history_jobs >= HISTORY_JOB_LIMIT
        || history_bytes.saturating_add((pending + 1) * HISTORY_TASK_HEADROOM_BYTES)
            > HISTORY_BYTE_LIMIT
    {
        return Err(ApiError::new(
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            "history_capacity_exceeded",
            "AI 受保护记录或逻辑数据容量已满，请等待保留期结束",
        ));
    }
    if pending >= QUEUE_CAPACITY {
        return Err(ApiError::new(
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            "capacity_exceeded",
            "排队容量已满，请稍后重试",
        ));
    }
    store::reserve(
        &mut tx,
        &utc_month_key(now),
        pricing.quote.reservation_micro_usd,
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
    store::advance_watermark(&mut tx, &owner, now)
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
        reservation_micro_usd: pricing.quote.reservation_micro_usd,
        pricing_snapshot: serde_json::to_string(&pricing).map_err(|e| internal(e.to_string()))?,
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
                        job: JobView::with_usage(&existing, &mut *tx).await?,
                    });
                }
            }
        }
        return Err(store_error(e));
    }
    // Serialize input handoff with cancellation cleanup, including the commit boundary.
    let mut inputs = state.ai_runtime.inputs.lock().await;
    tx.commit().await.map_err(sql_error)?;
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(());
    inputs.insert(job.job_id.clone(), (brief.to_string(), cancel_tx));
    drop(inputs);
    publish_task(state, "accepted", &job.job_id, job.state_revision);
    let queue_deadline =
        tokio::time::Instant::now() + std::time::Duration::from_millis(QUEUE_DEADLINE_MS as u64);
    tokio::spawn(run_job(
        state.clone(),
        job.job_id.clone(),
        queue_deadline,
        cancel_rx,
        provider,
    ));
    Ok(SubmitOutcome::Accepted {
        job: JobView::of(&job),
    })
}

/// 任务状态事件（R4-E）：先落库后发布；只带 ID/状态/revision（§7.4）。
fn publish_task(state: &AppState, to_state: &str, job_id: &str, state_revision: i64) {
    state.publish(WsEvent::AiTask {
        job_id: job_id.to_string(),
        state: to_state.to_string(),
        state_revision,
    });
}

/// worker：唯一一次 provider 调用的执行 owner。
async fn run_job(
    state: Arc<AppState>,
    job_id: String,
    queue_deadline: tokio::time::Instant,
    cancelled: tokio::sync::watch::Receiver<()>,
    provider: Arc<dyn StageIntentProvider>,
) {
    let result = std::panic::AssertUnwindSafe(run_job_inner(
        state.clone(),
        job_id.clone(),
        queue_deadline,
        cancelled,
        provider,
    ))
    .catch_unwind()
    .await;
    if result.is_err() {
        tracing::error!("AI worker panicked; converging task to interrupted");
        interrupt_worker_failure(&state, &job_id).await;
    }
}

async fn run_job_inner(
    state: Arc<AppState>,
    job_id: String,
    queue_deadline: tokio::time::Instant,
    mut cancelled: tokio::sync::watch::Receiver<()>,
    provider: Arc<dyn StageIntentProvider>,
) {
    // 运行槽：§7.1 状态图里 accepted→running 的条件就是「worker 获得运行槽」。
    // 取消/过期在槽外赢走终态时，这里拿槽后 CAS 失败即安静退出。
    let _slot = tokio::select! {
        slot = state.ai_runtime.execution_slots.acquire() => match slot { Ok(slot) => slot, Err(_) => return },
        _ = cancelled.changed() => return,
        _ = tokio::time::sleep_until(queue_deadline) => {
            if let Err(error) = start_running(&state, &job_id, queue_deadline).await {
                tracing::error!("AI queue expiry failed: {error:?}");
                interrupt_worker_failure(&state, &job_id).await;
            }
            state.ai_runtime.inputs.lock().await.remove(&job_id);
            return;
        }
    };
    match start_running(&state, &job_id, queue_deadline).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            state.ai_runtime.inputs.lock().await.remove(&job_id);
            return;
        }
        Err(error) => {
            tracing::error!("AI worker could not enter running state: {error:?}");
            interrupt_worker_failure(&state, &job_id).await;
            return;
        }
    }
    let run_deadline =
        tokio::time::Instant::now() + std::time::Duration::from_millis(RUN_DEADLINE_MS as u64);
    // 重取：running 的 CAS 已把 revision 推进，后续终态 CAS 必须用新值。
    let mut job = match store::find_job_by_id(&state.db, &job_id)
        .await
        .map_err(store_error)
    {
        Ok(Some(job)) => job,
        Ok(None) => {
            state.ai_runtime.inputs.lock().await.remove(&job_id);
            return;
        }
        Err(error) => {
            tracing::error!("AI running task reload failed: {error:?}");
            interrupt_worker_failure(&state, &job_id).await;
            return;
        }
    };
    if job.state != "running" {
        state.ai_runtime.inputs.lock().await.remove(&job_id);
        return;
    }
    publish_task(&state, "running", &job.job_id, job.state_revision);
    let pricing: PricingSnapshot =
        match serde_json::from_str::<PricingSnapshot>(&job.pricing_snapshot) {
            Ok(pricing)
                if pricing.quote.validate().is_ok()
                    && pricing.provider == provider.id()
                    && pricing.model == provider.model()
                    && pricing.credential.is_some() == provider.requires_openai_credential() =>
            {
                pricing
            }
            _ => {
                finish_running(state.clone(), &job_id, "failed").await;
                state.ai_runtime.inputs.lock().await.remove(&job_id);
                return;
            }
        };
    // Keep the read lease through the dispatch commit. Management cannot rotate
    // the stored key between this comparison and the local dispatch marker.
    let credential = if let Some(expected) = &pricing.credential {
        match state
            .ai_runtime
            .credentials
            .for_dispatch(&job.owner_instance_id, expected)
            .await
        {
            Ok(lease) => Some(lease),
            Err(error) => {
                let terminal = if matches!(
                    error.code,
                    "ai_credential_missing" | "ai_credential_changed"
                ) {
                    "cancelled"
                } else {
                    "failed"
                };
                finish_running(state.clone(), &job_id, terminal).await;
                state.ai_runtime.inputs.lock().await.remove(&job_id);
                return;
            }
        }
    } else {
        None
    };
    // 派发标记：本地派发线性化点。没抢到说明取消已赢——按 not_dispatched
    // 由取消方结算，这里直接退出。
    let attempt_id = uuid::Uuid::new_v4().to_string();
    let marked = async {
        let Ok(mut tx) = vmusic_store::begin_immediate(&state.db).await else {
            return false;
        };
        if tokio::time::Instant::now() >= run_deadline
            || check_generation(&mut tx, &job.owner_instance_id, now_ms())
                .await
                .is_err()
            || !provider.ready()
        {
            return false;
        }
        let Ok(marked) = store::mark_dispatched(&mut *tx, &job_id, &attempt_id).await else {
            return false;
        };
        // 0 行 = 取消/过期已赢（或已派发过）：不能继续执行。
        marked && tx.commit().await.is_ok()
    }
    .await;
    if !marked {
        finish_running(state.clone(), &job_id, "failed").await;
        state.ai_runtime.inputs.lock().await.remove(&job_id);
        return;
    }
    job.dispatch_state = "may_have_been_sent".into();
    job.attempt_id = Some(attempt_id.clone());
    let brief = state
        .ai_runtime
        .inputs
        .lock()
        .await
        .get(&job_id)
        .map(|input| input.0.clone());
    let Some(brief) = brief else {
        // 输入丢失（不应发生）：如实失败，按 unknown 结算。
        finish_running(state.clone(), &job_id, "failed").await;
        return;
    };

    let credential = credential.map(super::credential::Lease::into_secret);
    // A terminal winner removes the input sender after its commit. Observe
    // known cancellation once more before constructing any provider request.
    if cancelled.has_changed().is_err() {
        return;
    }

    // 一次调用；不自动修复、不自动重试。将终态信号交给 adapter 协作取消，
    // 不在外层 select 丢掉它；已完成 usage 的观察与资源结束仍由本任务负责。
    // 执行期限（§8.3：30s）到点终止卡住的 future——超时按 provider 失败
    // 走 failed + 结算，不无限驻留。
    let outcome = match tokio::time::timeout_at(
        run_deadline,
        provider.generate(
            brief,
            pricing,
            credential,
            ProviderCancellation::from_receiver(cancelled),
        ),
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
    let trusted_usage = outcome.usage;
    match outcome.intent {
        Ok(intent) => match validate_intent(&intent)
            .and_then(|_| contract::validate_artifact(&contract::artifact(&intent)).map(|_| ()))
        {
            Ok(()) => {
                // 事务顺序即事实顺序：先 CAS 终态，赢了才落提案——否则
                // 「已取消的任务留下可读提案」。CAS 输掉时只处理独立的
                // 迟到 usage；不能复活任务或创建提案。
                let result = async {
                    let proposal_id = uuid::Uuid::new_v4().to_string();
                    let now = now_ms();
                    let mut tx = vmusic_store::begin_immediate(&state.db)
                        .await
                        .map_err(store_error)?;
                    let won = store::cas_job_state(
                        &mut *tx,
                        &job.job_id,
                        "running",
                        job.state_revision,
                        "succeeded",
                        now,
                    )
                    .await
                    .map_err(store_error)?;
                    if !won {
                        usage::settle_terminal(&mut tx, &job, trusted_usage.as_ref(), now).await?;
                        tx.commit().await.map_err(sql_error)?;
                        return Ok::<(), ApiError>(());
                    }
                    let proposal = store::ProposalRow {
                        proposal_id: proposal_id.clone(),
                        job_id: job.job_id.clone(),
                        validated_intent: contract::artifact(&intent).to_string(),
                        schema_version: "artifact:1".into(),
                        state: "pending".into(),
                        revision: 1,
                        created_at: now,
                        expires_at: now + PROPOSAL_TTL_MS,
                    };
                    store::insert_proposal(&mut *tx, &proposal)
                        .await
                        .map_err(store_error)?;
                    store::attach_proposal(&mut *tx, &job.job_id, &proposal_id)
                        .await
                        .map_err(store_error)?;
                    usage::settle_terminal(&mut tx, &job, trusted_usage.as_ref(), now).await?;
                    tx.commit().await.map_err(sql_error)?;
                    publish_task(&state, "succeeded", &job.job_id, job.state_revision + 1);
                    Ok(())
                }
                .await;
                if let Err(error) = result {
                    tracing::error!("AI result transaction failed: {error:?}");
                    finish_running(state.clone(), &job_id, "failed").await;
                }
            }
            Err(reason) => {
                tracing::warn!("AI 输出校验失败: {reason}");
                finish_running_with_usage(
                    state.clone(),
                    &job.job_id,
                    "failed",
                    trusted_usage.as_ref(),
                )
                .await;
            }
        },
        Err(reason) => {
            tracing::warn!("AI provider 调用失败: {reason}");
            finish_running_with_usage(state.clone(), &job.job_id, "failed", trusted_usage.as_ref())
                .await;
        }
    }
    state.ai_runtime.inputs.lock().await.remove(&job_id);
}

/// Claim a queued worker without allowing a late slot wakeup to bypass its deadline.
async fn start_running(
    state: &Arc<AppState>,
    job_id: &str,
    queue_deadline: tokio::time::Instant,
) -> ApiResult<Option<store::JobRow>> {
    let mut tx = vmusic_store::begin_immediate(&state.db)
        .await
        .map_err(store_error)?;
    let Some(job) = store::find_job_by_id(&mut *tx, job_id)
        .await
        .map_err(store_error)?
    else {
        return Ok(None);
    };
    let now = now_ms();
    let to = if job.state == "accepted" && tokio::time::Instant::now() >= queue_deadline {
        "expired"
    } else {
        "running"
    };
    if store::cas_job_state(&mut *tx, job_id, "accepted", job.state_revision, to, now)
        .await
        .map_err(store_error)?
    {
        if to == "expired" {
            settle_on_terminal(&mut tx, &job, to).await?;
        }
        tx.commit().await.map_err(sql_error)?;
        if to == "expired" {
            publish_task(state, to, job_id, job.state_revision + 1);
            Ok(None)
        } else {
            Ok(Some(job))
        }
    } else {
        Ok(None)
    }
}

/// 终态推进 + 结算（worker 的失败路径）。必须重取最新行：派发标记在
/// transition 之后才落库，拿旧对象结算会把已派发的预留误判成未派发。
async fn finish_running(state: Arc<AppState>, job_id: &str, to: &str) {
    finish_running_with_usage(state, job_id, to, None).await;
}

async fn finish_running_with_usage(
    state: Arc<AppState>,
    job_id: &str,
    to: &str,
    trusted_usage: Option<&TrustedUsage>,
) {
    let result = async {
        let mut tx = vmusic_store::begin_immediate(&state.db)
            .await
            .map_err(store_error)?;
        let Some(job) = store::find_job_by_id(&mut *tx, job_id)
            .await
            .map_err(store_error)?
        else {
            return Ok::<(), ApiError>(());
        };
        let won = job.state == "running"
            && store::cas_job_state(
                &mut *tx,
                job_id,
                "running",
                job.state_revision,
                to,
                now_ms(),
            )
            .await
            .map_err(store_error)?;
        if !won && trusted_usage.is_none() {
            return Ok(());
        }
        // A cancelled/expired task stays terminal. Only its usage may advance.
        usage::settle_terminal(&mut tx, &job, trusted_usage, now_ms()).await?;
        tx.commit().await.map_err(sql_error)?;
        if won {
            publish_task(&state, to, job_id, job.state_revision + 1);
        }
        Ok(())
    }
    .await;
    if let Err(error) = result {
        tracing::error!("AI terminal settlement failed; leaving facts recoverable: {error:?}");
    }
}

/// A panic ends the only in-process worker. Persist an interrupted terminal
/// state and settle from the durable dispatch marker before releasing its input.
async fn interrupt_worker_failure(state: &Arc<AppState>, job_id: &str) {
    let result = async {
        let mut tx = vmusic_store::begin_immediate(&state.db)
            .await
            .map_err(store_error)?;
        let Some(job) = store::find_job_by_id(&mut *tx, job_id)
            .await
            .map_err(store_error)?
        else {
            return Ok::<(), ApiError>(());
        };
        if !matches!(job.state.as_str(), "accepted" | "running") {
            return Ok(());
        }
        if !store::cas_job_state(
            &mut *tx,
            job_id,
            &job.state,
            job.state_revision,
            "interrupted",
            now_ms(),
        )
        .await
        .map_err(store_error)?
        {
            return Ok(());
        }
        usage::settle_terminal(&mut tx, &job, None, now_ms()).await?;
        tx.commit().await.map_err(sql_error)?;
        publish_task(state, "interrupted", job_id, job.state_revision + 1);
        Ok(())
    }
    .await;
    if let Err(error) = result {
        tracing::error!("AI worker panic settlement failed; leaving facts recoverable: {error:?}");
    }
    state.ai_runtime.inputs.lock().await.remove(job_id);
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
    settle_on_terminal(&mut tx, &job, "cancelled").await?;
    tx.commit().await.map_err(sql_error)?;
    publish_task(state, "cancelled", &job.job_id, job.state_revision + 1);
    state.ai_runtime.inputs.lock().await.remove(job_id);
    let mut view = JobView::with_usage(&job, &state.db).await?;
    view.state = "cancelled".into();
    view.state_revision = job.state_revision + 1;
    Ok(view)
}

/// Called under the credential service's exclusive lifecycle guard, before OS
/// mutation. Conservative cancellation also applies when the OS write fails.
pub(super) async fn invalidate_credentials(state: &Arc<AppState>, owner: &str) -> ApiResult<()> {
    let mut tx = vmusic_store::begin_immediate(&state.db)
        .await
        .map_err(store_error)?;
    let candidates = store::recovery_candidates(&mut *tx)
        .await
        .map_err(store_error)?;
    let mut events = Vec::new();
    for job in candidates {
        if job.owner_instance_id != owner {
            continue;
        }
        // Free/local jobs have no credential binding and remain independent.
        let credential_bound = serde_json::from_str::<PricingSnapshot>(&job.pricing_snapshot)
            .map(|snapshot| snapshot.credential.is_some())
            .unwrap_or(true);
        if !credential_bound {
            continue;
        }
        if store::cas_job_state(
            &mut *tx,
            &job.job_id,
            &job.state,
            job.state_revision,
            "cancelled",
            now_ms(),
        )
        .await
        .map_err(store_error)?
        {
            settle_on_terminal(&mut tx, &job, "cancelled").await?;
            events.push((job.job_id, job.state_revision + 1));
        }
    }
    tx.commit().await.map_err(sql_error)?;
    for (id, revision) in events {
        state.ai_runtime.inputs.lock().await.remove(&id);
        publish_task(state, "cancelled", &id, revision);
    }
    Ok(())
}

/// 过期清扫：排队超期（accepted >60s）与执行超期（running >30s）。
/// 惰性触发（submit/cancel/查询入口先扫一遍），无后台定时器。
pub(super) async fn sweep(state: &Arc<AppState>) -> ApiResult<()> {
    let now = now_ms();
    let candidates =
        store::expired_candidates(&state.db, now - QUEUE_DEADLINE_MS, now - RUN_DEADLINE_MS)
            .await
            .map_err(store_error)?;
    let owned_jobs: HashSet<String> = state
        .ai_runtime
        .inputs
        .lock()
        .await
        .keys()
        .cloned()
        .collect();
    let mut tx = vmusic_store::begin_immediate(&state.db)
        .await
        .map_err(store_error)?;
    let mut events = Vec::new();
    for job in candidates {
        // Active in-process owners use monotonic deadlines. Wall time only
        // sweeps orphaned persisted rows, such as work left after a DB error.
        if owned_jobs.contains(&job.job_id) {
            continue;
        }
        let to = "expired";
        if store::cas_job_state(
            &mut *tx,
            &job.job_id,
            &job.state,
            job.state_revision,
            to,
            now,
        )
        .await
        .map_err(store_error)?
        {
            settle_on_terminal(&mut tx, &job, to).await?;
            events.push((job.job_id, job.state_revision + 1));
        }
    }
    let watermark = store::accepted_watermark(&mut tx)
        .await
        .map_err(store_error)?;
    if now.saturating_add(5 * 60_000) >= watermark {
        let month = utc_month_key(now);
        let year: i32 = month[..4]
            .parse()
            .map_err(|_| internal("invalid UTC month"))?;
        let m: i32 = month[5..]
            .parse()
            .map_err(|_| internal("invalid UTC month"))?;
        let index = year * 12 + m - 1 - 12;
        let cutoff = format!(
            "{:04}-{:02}",
            index.div_euclid(12),
            index.rem_euclid(12) + 1
        );
        store::retain_ai_history(&mut tx, now, now.saturating_sub(KEY_WINDOW_MS), &cutoff)
            .await
            .map_err(store_error)?;
    }
    tx.commit().await.map_err(sql_error)?;
    for (id, revision) in events {
        state.ai_runtime.inputs.lock().await.remove(&id);
        publish_task(state, "expired", &id, revision);
    }
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
    JobView::with_usage(&job, &state.db).await
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
        principal,
        before_created_at,
        before_job_id,
        limit.clamp(1, 50),
    )
    .await
    .map_err(store_error)?;
    let mut views = Vec::with_capacity(rows.len());
    for row in &rows {
        views.push(JobView::with_usage(row, &state.db).await?);
    }
    Ok(views)
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
    pub artifact: Value,
    pub validation_stage: &'static str,
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
    store::find_job_by_id(&state.db, &proposal.job_id)
        .await
        .map_err(store_error)?
        .filter(|job| job.principal == principal)
        .ok_or_else(|| not_found(format!("查无此提案: {proposal_id}")))?;
    if proposal.state == "pending" && proposal.expires_at <= now_ms() {
        store::cas_proposal_state(&state.db, proposal_id, proposal.revision, "expired")
            .await
            .map_err(store_error)?;
        proposal = store::find_proposal(&state.db, proposal_id)
            .await
            .map_err(store_error)?
            .ok_or_else(|| not_found(format!("查无此提案: {proposal_id}")))?;
    }
    // expired 的提案只留事实，不带内容（与「过期不得以 pending 形状返回」
    // 同一条规则的另一半）。
    let intent: Value = if proposal.state == "expired" || proposal.expires_at <= now_ms() {
        Value::Null
    } else {
        serde_json::from_str(&proposal.validated_intent).map_err(|e| internal(e.to_string()))?
    };
    // Legacy proposals retain their intent but cannot be silently stamped with current hashes.
    let artifact = if proposal.schema_version == "artifact:1" {
        intent.clone()
    } else {
        Value::Null
    };
    let intent = if artifact.is_null() {
        intent
    } else {
        artifact["intent"].clone()
    };
    Ok(ProposalView {
        proposal_id: proposal.proposal_id,
        job_id: proposal.job_id,
        state: proposal.state,
        revision: proposal.revision,
        created_at: proposal.created_at,
        expires_at: proposal.expires_at,
        validated_intent: intent,
        artifact,
        validation_stage: "intent",
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

/// 熔断复位（官方管理专用，§8.4）：revision、无在飞调用、无未完任务
/// 与当前月预算健康度均由服务端检查，并与复位原子提交。
pub(crate) async fn budget_guard_reset(
    state: &Arc<AppState>,
    expected_revision: i64,
) -> ApiResult<Value> {
    if !state.ai_runner_held() {
        return Err(ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "ai_locked",
            "本进程未持有 AI runner 锁",
        ));
    }
    let owner = instance_owner(state).await?;
    let mut tx = vmusic_store::begin_immediate(&state.db)
        .await
        .map_err(store_error)?;
    store::ensure_budget_guard(&mut tx, &owner)
        .await
        .map_err(store_error)?;
    if !store::reset_budget_guard(&mut *tx, expected_revision)
        .await
        .map_err(store_error)?
    {
        return Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "state_conflict",
            "revision 已过期，请重查后再试",
        ));
    }
    // Hold the execution slot through commit: a cancelled provider can still be in flight.
    let _slot = state
        .ai_runtime
        .execution_slots
        .try_acquire()
        .map_err(|_| {
            ApiError::new(
                axum::http::StatusCode::CONFLICT,
                "generation_in_flight",
                "仍有生成调用在执行，暂不能复位",
            )
        })?;
    if store::count_incomplete_jobs(&mut *tx, &owner)
        .await
        .map_err(store_error)?
        > 0
    {
        return Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "generation_in_flight",
            "仍有未结清任务，暂不能复位",
        ));
    }
    let budget = store::get_or_create_month(&mut tx, &utc_month_key(now_ms()))
        .await
        .map_err(store_error)?;
    if budget
        .charged_micro_usd
        .saturating_add(budget.reserved_micro_usd)
        > MONTHLY_LIMIT_MICRO_USD
    {
        return Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "budget_unhealthy",
            "当前月账仍超出预算，暂不能复位",
        ));
    }
    tx.commit().await.map_err(sql_error)?;
    let guard = store::budget_guard(&state.db).await.map_err(store_error)?;
    Ok(json!({
        "halted": guard.as_ref().map(|g| g.halted).unwrap_or(false),
        "revision": guard.as_ref().map(|g| g.revision).unwrap_or(0),
    }))
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
        store::get_or_create_month(&mut conn, &utc_month_key(now_ms()))
            .await
            .map_err(store_error)?
    };
    let guard = {
        let mut conn = state.db.acquire().await.map_err(sql_error)?;
        store::ensure_budget_guard(&mut conn, owner)
            .await
            .map_err(store_error)?
    };
    let consent = vmusic_store::settings::get(&state.db, CONSENT_KEY)
        .await
        .map_err(store_error)?
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    Ok(json!({
        "capability": CAPABILITY,
        "provider": { "id": provider.id(), "model": provider.model(), "ready": provider.ready(),
            "diagnostic": provider.diagnostic() },
        "queue": { "incomplete": incomplete, "capacity": QUEUE_CAPACITY },
        "budget": {
            "month": budget.month,
            "reservedMicroUsd": budget.reserved_micro_usd,
            "chargedMicroUsd": budget.charged_micro_usd,
            "chargedTotalOverflowed": budget.charged_micro_usd == i64::MAX,
            "limitMicroUsd": MONTHLY_LIMIT_MICRO_USD,
        },
        "guard": {
            "halted": guard.halted,
            "reason": guard.reason,
            "revision": guard.revision,
        },
        "consent": { "inAppGeneration": consent },
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

    struct PanickingProvider {
        panic_before_dispatch: bool,
        ready_calls: std::sync::atomic::AtomicUsize,
    }

    impl StageIntentProvider for PanickingProvider {
        fn id(&self) -> &'static str {
            "panic-test"
        }
        fn model(&self) -> &'static str {
            "panic-v1"
        }
        fn ready(&self) -> bool {
            if self.panic_before_dispatch
                && self
                    .ready_calls
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                    > 0
            {
                panic!("fixture panic before dispatch");
            }
            true
        }
        fn quote(&self, _: &str) -> Result<PriceQuote, String> {
            Ok(PriceQuote::fake())
        }
        fn generate(
            &self,
            _: String,
            _: PricingSnapshot,
            _: Option<crate::ai::credential::ProviderCredential>,
            _: ProviderCancellation,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ProviderReply> + Send>> {
            Box::pin(async { panic!("fixture panic during provider call") })
        }
    }

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
        fn quote(&self, _: &str) -> Result<PriceQuote, String> {
            Ok(PriceQuote::fake())
        }
        fn generate(
            &self,
            _brief: String,
            _pricing: PricingSnapshot,
            _credential: Option<crate::ai::credential::ProviderCredential>,
            _cancellation: ProviderCancellation,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ProviderReply> + Send>> {
            let counter = self.counter.clone();
            let gate = self.gate.clone();
            Box::pin(async move {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                // 轮询闸门：不依赖唤醒顺序，晚到的调用者也能等到放行。
                while !gate.load(std::sync::atomic::Ordering::SeqCst) {
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
                ProviderReply {
                    intent: Ok(json!({ "version": 1, "scene": "space", "patch": {} })),
                    usage: None,
                }
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
        vmusic_store::settings::set(&state.db, CONSENT_KEY, &serde_json::Value::Bool(true))
            .await
            .unwrap();
        (Arc::new(state), handle)
    }

    struct CredentialFixture {
        calls: Arc<std::sync::atomic::AtomicUsize>,
        gate: Arc<std::sync::atomic::AtomicBool>,
        expected: &'static str,
    }

    impl StageIntentProvider for CredentialFixture {
        fn id(&self) -> &'static str {
            "credential-fixture"
        }
        fn model(&self) -> &'static str {
            "free-fixture-v1"
        }
        fn ready(&self) -> bool {
            true
        }
        fn requires_openai_credential(&self) -> bool {
            true
        }
        fn quote(&self, _: &str) -> Result<PriceQuote, String> {
            Ok(PriceQuote::fake())
        }
        fn generate(
            &self,
            _: String,
            _: PricingSnapshot,
            credential: Option<crate::ai::credential::ProviderCredential>,
            _cancellation: ProviderCancellation,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ProviderReply> + Send>> {
            let calls = self.calls.clone();
            let gate = self.gate.clone();
            let expected = self.expected;
            Box::pin(async move {
                assert_eq!(credential.unwrap().as_ref(), expected);
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                while !gate.load(std::sync::atomic::Ordering::SeqCst) {
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
                ProviderReply {
                    intent: Ok(json!({"version":1,"scene":"orb","patch":{}})),
                    usage: Some(TrustedUsage::free()),
                }
            })
        }
    }

    async fn save_fixture_key(
        state: &Arc<AppState>,
        value: &str,
    ) -> ApiResult<super::super::credential::CredentialStatus> {
        let request =
            super::super::credential::CredentialRequest::from_value(&json!({"api_key":value}))?;
        super::super::credential::put(state, request).await
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn credential_mutation_cancels_queued_jobs_and_preserves_free_jobs() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        for delete in [false, true] {
            let (state, handle) = jobs_state().await;
            save_fixture_key(&state, "old-fixture-key").await.unwrap();
            let calls = Arc::new(AtomicUsize::new(0));
            state
                .ai_runtime
                .install_provider(Arc::new(CredentialFixture {
                    calls: calls.clone(),
                    gate: Arc::new(AtomicBool::new(true)),
                    expected: "old-fixture-key",
                }))
                .await;
            let slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
            let SubmitOutcome::Accepted { job } =
                submit(&state, "local-owner", "queued keyed job", None)
                    .await
                    .unwrap()
            else {
                panic!()
            };
            let row = store::find_job_by_id(&state.db, &job.job_id)
                .await
                .unwrap()
                .unwrap();
            let frozen: PricingSnapshot = serde_json::from_str(&row.pricing_snapshot).unwrap();
            assert!(frozen.credential.is_some());
            assert!(!row.pricing_snapshot.contains("old-fixture-key"));
            state
                .ai_runtime
                .install_provider(Arc::new(FakeProvider))
                .await;
            let SubmitOutcome::Accepted { job: free } =
                submit(&state, "local-owner", "independent free job", None)
                    .await
                    .unwrap()
            else {
                panic!()
            };
            if delete {
                super::super::credential::delete(&state).await.unwrap();
            } else {
                save_fixture_key(&state, "new-fixture-key").await.unwrap();
            }
            let cancelled = store::find_job_by_id(&state.db, &job.job_id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(cancelled.state, "cancelled");
            assert_eq!(cancelled.dispatch_state, "not_dispatched");
            let usage = store::find_usage_entry(&state.db, &job.job_id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(usage.accounted_micro_usd, 0);
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            assert_eq!(
                store::find_job_by_id(&state.db, &free.job_id)
                    .await
                    .unwrap()
                    .unwrap()
                    .state,
                "accepted"
            );
            drop(slot);
            assert_eq!(
                await_terminal(&state, &free.job_id).await.state,
                "succeeded"
            );
            state.audio.shutdown();
            handle.join().unwrap();
            state.db.close().await;
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn frozen_credential_is_delivered_only_to_matching_dispatch_and_missing_key_reserves_nothing()
     {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let (state, handle) = jobs_state().await;
        let calls = Arc::new(AtomicUsize::new(0));
        state
            .ai_runtime
            .install_provider(Arc::new(CredentialFixture {
                calls: calls.clone(),
                gate: Arc::new(AtomicBool::new(true)),
                expected: "exact-fixture-key",
            }))
            .await;
        assert_eq!(
            submit(&state, "local-owner", "no credential", None)
                .await
                .err()
                .unwrap()
                .code,
            "ai_credential_missing"
        );
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_jobs")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(count, 0);
        save_fixture_key(&state, "exact-fixture-key").await.unwrap();
        let SubmitOutcome::Accepted { job } =
            submit(&state, "local-owner", "matching credential", None)
                .await
                .unwrap()
        else {
            panic!()
        };
        assert_eq!(await_terminal(&state, &job.job_id).await.state, "succeeded");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        state.audio.shutdown();
        handle.join().unwrap();
        state.db.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn credential_rotation_keeps_sent_accounting_and_execution_owner_until_reply() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let (state, handle) = jobs_state().await;
        save_fixture_key(&state, "old-fixture-key").await.unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(AtomicBool::new(false));
        state
            .ai_runtime
            .install_provider(Arc::new(CredentialFixture {
                calls: calls.clone(),
                gate: gate.clone(),
                expected: "old-fixture-key",
            }))
            .await;
        let SubmitOutcome::Accepted { job } = submit(&state, "local-owner", "already sent", None)
            .await
            .unwrap()
        else {
            panic!()
        };
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while calls.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        save_fixture_key(&state, "new-fixture-key").await.unwrap();
        let cancelled = store::find_job_by_id(&state.db, &job.job_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(cancelled.state, "cancelled");
        assert_eq!(cancelled.dispatch_state, "may_have_been_sent");
        assert_eq!(state.ai_runtime.execution_slots.available_permits(), 0);
        assert_eq!(
            store::find_usage_entry(&state.db, &job.job_id)
                .await
                .unwrap()
                .unwrap()
                .accounted_micro_usd,
            RESERVATION_MICRO_USD
        );
        state
            .ai_runtime
            .install_provider(Arc::new(CredentialFixture {
                calls: calls.clone(),
                gate: Arc::new(AtomicBool::new(true)),
                expected: "new-fixture-key",
            }))
            .await;
        let SubmitOutcome::Accepted { job: next } =
            submit(&state, "local-owner", "new generation", None)
                .await
                .unwrap()
        else {
            panic!()
        };
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        gate.store(true, Ordering::SeqCst);
        assert_eq!(
            await_terminal(&state, &next.job_id).await.state,
            "succeeded"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            store::find_job_by_id(&state.db, &job.job_id)
                .await
                .unwrap()
                .unwrap()
                .state,
            "cancelled"
        );
        assert_eq!(
            store::find_usage_entry(&state.db, &job.job_id)
                .await
                .unwrap()
                .unwrap()
                .accounted_micro_usd,
            0
        );
        state.audio.shutdown();
        handle.join().unwrap();
        state.db.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn credential_mutation_survives_waiter_loss_and_db_failure_prevents_os_write() {
        use std::sync::atomic::{AtomicBool, AtomicUsize};
        let (state, handle) = jobs_state().await;
        save_fixture_key(&state, "old-fixture-key").await.unwrap();
        state
            .ai_runtime
            .install_provider(Arc::new(CredentialFixture {
                calls: Arc::new(AtomicUsize::new(0)),
                gate: Arc::new(AtomicBool::new(true)),
                expected: "old-fixture-key",
            }))
            .await;
        let slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
        let SubmitOutcome::Accepted { job } =
            submit(&state, "local-owner", "mutation rollback", None)
                .await
                .unwrap()
        else {
            panic!()
        };
        sqlx::query("CREATE TRIGGER fail_credential_cancel BEFORE UPDATE OF state ON ai_jobs BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
            .execute(&state.db).await.unwrap();
        assert!(
            save_fixture_key(&state, "must-not-be-written")
                .await
                .is_err()
        );
        assert_eq!(
            store::find_job_by_id(&state.db, &job.job_id)
                .await
                .unwrap()
                .unwrap()
                .state,
            "accepted"
        );
        let owner = instance_owner(&state).await.unwrap();
        assert_eq!(
            state
                .ai_runtime
                .credentials
                .snapshot(&owner)
                .await
                .unwrap()
                .into_secret()
                .as_ref(),
            "old-fixture-key"
        );
        sqlx::query("DROP TRIGGER fail_credential_cancel")
            .execute(&state.db)
            .await
            .unwrap();
        let tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
        let started = state.ai_runtime.credentials.mutation_started.notified();
        tokio::pin!(started);
        started.as_mut().enable();
        let waiter_state = state.clone();
        let waiter =
            tokio::spawn(async move { save_fixture_key(&waiter_state, "new-fixture-key").await });
        // Observe acquisition without taking competing read leases ourselves.
        tokio::time::timeout(std::time::Duration::from_secs(2), started)
            .await
            .unwrap();
        waiter.abort();
        assert!(waiter.await.err().unwrap().is_cancelled());
        tx.rollback().await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                match state.ai_runtime.credentials.snapshot(&owner).await {
                    Ok(lease) => {
                        assert_eq!(lease.into_secret().as_ref(), "new-fixture-key");
                        break;
                    }
                    Err(error) if error.code == "ai_credential_busy" => {
                        tokio::task::yield_now().await
                    }
                    Err(error) => panic!("unexpected snapshot error: {}", error.code),
                }
            }
        })
        .await
        .unwrap();
        let row = store::find_job_by_id(&state.db, &job.job_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.state, "cancelled");
        assert_eq!(row.dispatch_state, "not_dispatched");
        let SubmitOutcome::Replayed { job: replay } =
            submit(&state, "local-owner", "mutation rollback", Some(&row.key))
                .await
                .unwrap()
        else {
            panic!()
        };
        assert_eq!(replay.state, "cancelled");
        drop(slot);
        state.audio.shutdown();
        handle.join().unwrap();
        state.db.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stale_persisted_credential_identity_never_marks_dispatch_or_calls_provider() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let (state, handle) = jobs_state().await;
        save_fixture_key(&state, "current-fixture-key")
            .await
            .unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        state
            .ai_runtime
            .install_provider(Arc::new(CredentialFixture {
                calls: calls.clone(),
                gate: Arc::new(AtomicBool::new(true)),
                expected: "current-fixture-key",
            }))
            .await;
        let slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
        let SubmitOutcome::Accepted { job } =
            submit(&state, "local-owner", "stale restored snapshot", None)
                .await
                .unwrap()
        else {
            panic!()
        };
        let row = store::find_job_by_id(&state.db, &job.job_id)
            .await
            .unwrap()
            .unwrap();
        let mut snapshot: Value = serde_json::from_str(&row.pricing_snapshot).unwrap();
        snapshot["credential"]["generation"] = json!(uuid::Uuid::new_v4().to_string());
        sqlx::query("UPDATE ai_jobs SET pricing_snapshot = ?1 WHERE job_id = ?2")
            .bind(snapshot.to_string())
            .bind(&job.job_id)
            .execute(&state.db)
            .await
            .unwrap();
        drop(slot);
        let terminal = await_terminal(&state, &job.job_id).await;
        assert_eq!(terminal.state, "cancelled");
        assert_eq!(terminal.dispatch_state, "not_dispatched");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            store::find_usage_entry(&state.db, &job.job_id)
                .await
                .unwrap()
                .unwrap()
                .accounted_micro_usd,
            0
        );
        state.audio.shutdown();
        handle.join().unwrap();
        state.db.close().await;
    }

    #[tokio::test]
    async fn credential_management_requires_runner_ownership_but_not_generation_consent() {
        let (state, handle) = jobs_state().await;
        vmusic_store::settings::set(&state.db, CONSENT_KEY, &Value::Bool(false))
            .await
            .unwrap();
        save_fixture_key(&state, "owner-fixture-key").await.unwrap();
        state
            .ai_runner_held
            .store(false, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(
            save_fixture_key(&state, "must-not-change")
                .await
                .err()
                .unwrap()
                .code,
            "ai_locked"
        );
        assert_eq!(
            super::super::credential::delete(&state)
                .await
                .err()
                .unwrap()
                .code,
            "ai_locked"
        );
        assert_eq!(
            super::super::credential::status(&state)
                .await
                .err()
                .unwrap()
                .code,
            "ai_locked"
        );
        state
            .ai_runner_held
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let owner = instance_owner(&state).await.unwrap();
        assert_eq!(
            state
                .ai_runtime
                .credentials
                .snapshot(&owner)
                .await
                .unwrap()
                .into_secret()
                .as_ref(),
            "owner-fixture-key"
        );
        super::super::credential::delete(&state).await.unwrap();
        state.audio.shutdown();
        handle.join().unwrap();
        state.db.close().await;
    }

    struct MeteredProvider {
        gate: Arc<std::sync::atomic::AtomicBool>,
        rate: Arc<std::sync::atomic::AtomicU64>,
        reply: Result<Value, String>,
        usage: Option<TrustedUsage>,
    }

    fn metered_quote() -> PriceQuote {
        PriceQuote {
            pricing_version: "test-prices-v1".into(),
            reservation_micro_usd: 30_000,
            input_micro_usd_per_million: 1_000_000,
            output_micro_usd_per_million: 2_000_000,
            max_input_tokens: 10_000,
            max_output_tokens: 10_000,
        }
    }

    impl StageIntentProvider for MeteredProvider {
        fn id(&self) -> &'static str {
            "metered-test"
        }
        fn model(&self) -> &'static str {
            "metered-v1"
        }
        fn ready(&self) -> bool {
            true
        }
        fn quote(&self, _: &str) -> Result<PriceQuote, String> {
            let mut quote = metered_quote();
            quote.input_micro_usd_per_million = self.rate.load(std::sync::atomic::Ordering::SeqCst);
            Ok(quote)
        }
        fn generate(
            &self,
            _: String,
            pricing: PricingSnapshot,
            _credential: Option<crate::ai::credential::ProviderCredential>,
            _cancellation: ProviderCancellation,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ProviderReply> + Send>> {
            let gate = self.gate.clone();
            let reply = self.reply.clone();
            let usage = self.usage.clone();
            Box::pin(async move {
                assert_eq!(pricing.quote.pricing_version, "test-prices-v1");
                while !gate.load(std::sync::atomic::Ordering::SeqCst) {
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
                ProviderReply {
                    intent: reply,
                    usage,
                }
            })
        }
    }

    fn metered(
        gate: bool,
        reply: Result<Value, String>,
        usage: Option<TrustedUsage>,
    ) -> MeteredProvider {
        MeteredProvider {
            gate: Arc::new(std::sync::atomic::AtomicBool::new(gate)),
            rate: Arc::new(std::sync::atomic::AtomicU64::new(1_000_000)),
            reply,
            usage,
        }
    }

    async fn await_terminal(state: &Arc<AppState>, id: &str) -> store::JobRow {
        for _ in 0..400 {
            let row = job_row(state, id).await;
            if !matches!(row.state.as_str(), "accepted" | "running") {
                return row;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        panic!("task did not finish");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn worker_panics_interrupt_and_settle_according_to_dispatch_state() {
        let (state, handle) = jobs_state().await;
        for (panic_before_dispatch, expected_dispatch, expected_usage, expected_charge) in [
            (true, "not_dispatched", "released", 0),
            (
                false,
                "may_have_been_sent",
                "unknown",
                RESERVATION_MICRO_USD,
            ),
        ] {
            state
                .ai_runtime
                .install_provider(Arc::new(PanickingProvider {
                    panic_before_dispatch,
                    ready_calls: std::sync::atomic::AtomicUsize::new(0),
                }))
                .await;
            let SubmitOutcome::Accepted { job } =
                submit(&state, "local-owner", "panic fixture", None)
                    .await
                    .unwrap()
            else {
                panic!()
            };
            let terminal = await_terminal(&state, &job.job_id).await;
            assert_eq!(terminal.state, "interrupted");
            assert_eq!(terminal.dispatch_state, expected_dispatch);
            let usage = store::find_usage_entry(&state.db, &job.job_id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(usage.usage_state, expected_usage);
            assert_eq!(usage.accounted_micro_usd, expected_charge);
            assert!(
                !state
                    .ai_runtime
                    .inputs
                    .lock()
                    .await
                    .contains_key(&job.job_id)
            );
            assert_eq!(state.ai_runtime.execution_slots.available_permits(), 1);
        }
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn running_transition_storage_error_interrupts_accepted_task() {
        let (state, handle) = jobs_state().await;
        sqlx::query("CREATE TRIGGER fail_running_transition BEFORE UPDATE OF state ON ai_jobs WHEN OLD.state = 'accepted' AND NEW.state = 'running' BEGIN SELECT RAISE(ABORT, 'fixture transition failure'); END")
            .execute(&state.db)
            .await
            .unwrap();
        let SubmitOutcome::Accepted { job } =
            submit(&state, "local-owner", "transition fixture", None)
                .await
                .unwrap()
        else {
            panic!()
        };

        let terminal = await_terminal(&state, &job.job_id).await;
        assert_eq!(terminal.state, "interrupted");
        assert_eq!(terminal.dispatch_state, "not_dispatched");
        let usage = store::find_usage_entry(&state.db, &job.job_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(usage.usage_state, "released");
        assert_eq!(usage.accounted_micro_usd, 0);
        assert!(
            !state
                .ai_runtime
                .inputs
                .lock()
                .await
                .contains_key(&job.job_id)
        );

        sqlx::query("DROP TRIGGER fail_running_transition")
            .execute(&state.db)
            .await
            .unwrap();
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn wall_clock_age_does_not_expire_a_live_queued_worker() {
        let (state, handle) = jobs_state().await;
        let slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
        let SubmitOutcome::Accepted { job } =
            submit(&state, "local-owner", "expired while queued", None)
                .await
                .unwrap()
        else {
            panic!()
        };
        sqlx::query("UPDATE ai_jobs SET created_at = ?1 WHERE job_id = ?2")
            .bind(now_ms() - QUEUE_DEADLINE_MS - 1)
            .bind(&job.job_id)
            .execute(&state.db)
            .await
            .unwrap();
        sweep(&state).await.unwrap();
        assert_eq!(job_row(&state, &job.job_id).await.state, "accepted");
        drop(slot);

        let terminal = await_terminal(&state, &job.job_id).await;
        assert_eq!(terminal.state, "succeeded");
        assert_eq!(terminal.dispatch_state, "may_have_been_sent");
        let usage = store::find_usage_entry(&state.db, &job.job_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(usage.usage_state, "reported");
        assert_eq!(usage.accounted_micro_usd, 0);
        assert_eq!(state.ai_runtime.execution_slots.available_permits(), 1);
        assert!(
            !state
                .ai_runtime
                .inputs
                .lock()
                .await
                .contains_key(&job.job_id)
        );
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn monotonic_queue_deadline_expires_even_if_wall_clock_is_unchanged() {
        let (state, handle) = jobs_state().await;
        let slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
        let SubmitOutcome::Accepted { job } =
            submit(&state, "local-owner", "monotonic deadline fixture", None)
                .await
                .unwrap()
        else {
            panic!()
        };
        let expired_deadline = tokio::time::Instant::now() - std::time::Duration::from_millis(1);

        assert!(
            start_running(&state, &job.job_id, expired_deadline)
                .await
                .unwrap()
                .is_none()
        );
        let terminal = job_row(&state, &job.job_id).await;
        assert_eq!(terminal.state, "expired");
        assert_eq!(terminal.dispatch_state, "not_dispatched");
        let usage = store::find_usage_entry(&state.db, &job.job_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(usage.usage_state, "released");
        assert_eq!(usage.accounted_micro_usd, 0);

        drop(slot);
        let worker_slot = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            state.ai_runtime.execution_slots.acquire(),
        )
        .await
        .unwrap()
        .unwrap();
        drop(worker_slot);
        assert_eq!(state.ai_runtime.execution_slots.available_permits(), 1);
        assert!(
            !state
                .ai_runtime
                .inputs
                .lock()
                .await
                .contains_key(&job.job_id)
        );
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn trusted_usage_charges_success_invalid_output_and_provider_error() {
        let (state, handle) = jobs_state().await;
        let valid = json!({"version":1,"scene":"orb","patch":{}});
        for (reply, expected, counters) in [
            (
                Ok(valid.clone()),
                "succeeded",
                Some(TrustedUsage {
                    input_tokens: 123,
                    output_tokens: 7,
                }),
            ),
            (
                Ok(json!({"bad":"candidate"})),
                "failed",
                Some(TrustedUsage {
                    input_tokens: 123,
                    output_tokens: 7,
                }),
            ),
            (
                Err("truncated response".into()),
                "failed",
                Some(TrustedUsage {
                    input_tokens: 123,
                    output_tokens: 7,
                }),
            ),
            (Ok(valid), "succeeded", None),
        ] {
            state
                .ai_runtime
                .install_provider(Arc::new(metered(true, reply, counters.clone())))
                .await;
            let SubmitOutcome::Accepted { job } = submit(&state, "local-owner", "metered", None)
                .await
                .unwrap()
            else {
                panic!()
            };
            let terminal = await_terminal(&state, &job.job_id).await;
            assert_eq!(terminal.state, expected);
            let view = get_job(&state, "local-owner", &job.job_id).await.unwrap();
            assert_eq!(view.usage.reservation_micro_usd, 30_000);
            assert_eq!(
                view.usage.usage_state,
                if counters.is_some() {
                    "reported"
                } else {
                    "unknown"
                }
            );
            assert_eq!(
                view.usage.accounted_micro_usd,
                Some(if counters.is_some() { 137 } else { 30_000 })
            );
            assert!(
                get_job(&state, "another-principal", &job.job_id)
                    .await
                    .is_err()
            );
        }
        let budget = status(&state, &instance_owner(&state).await.unwrap())
            .await
            .unwrap();
        assert_eq!(budget["budget"]["chargedMicroUsd"], 30_411);
        assert_eq!(budget["budget"]["reservedMicroUsd"], 0);
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancellation_keeps_its_terminal_state_but_late_usage_uses_frozen_prices() {
        let (state, handle) = jobs_state().await;
        let provider = metered(
            false,
            Ok(json!({"version":1,"scene":"orb","patch":{}})),
            Some(TrustedUsage {
                input_tokens: 123,
                output_tokens: 7,
            }),
        );
        let gate = provider.gate.clone();
        let rate = provider.rate.clone();
        state.ai_runtime.install_provider(Arc::new(provider)).await;
        let slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
        let SubmitOutcome::Accepted { job } =
            submit(&state, "local-owner", "cancel then bill", None)
                .await
                .unwrap()
        else {
            panic!()
        };
        rate.store(10_000_000, std::sync::atomic::Ordering::SeqCst);
        drop(slot);
        for _ in 0..400 {
            if job_row(&state, &job.job_id).await.dispatch_state == "may_have_been_sent" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let running = job_row(&state, &job.job_id).await;
        assert_eq!(running.dispatch_state, "may_have_been_sent");
        let cancelled = cancel(&state, "local-owner", &job.job_id, running.state_revision)
            .await
            .unwrap();
        assert_eq!(cancelled.usage.accounted_micro_usd, Some(30_000));
        let mut events = state.events.subscribe();
        gate.store(true, std::sync::atomic::Ordering::SeqCst);
        let _slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
        let latest = get_job(&state, "local-owner", &job.job_id).await.unwrap();
        assert_eq!(latest.state, "cancelled");
        assert_eq!(latest.state_revision, cancelled.state_revision);
        assert_eq!(latest.result_proposal_id, None);
        assert_eq!(latest.usage.accounted_micro_usd, Some(137));
        assert_eq!(latest.usage.usage_revision, 2);
        assert_eq!(latest.usage.usage_state, "reported");
        while let Ok(event) = events.try_recv() {
            assert!(!matches!(event, WsEvent::AiTask { state, .. } if state == "succeeded"));
        }
        let row = job_row(&state, &job.job_id).await;
        let snapshot: PricingSnapshot = serde_json::from_str(&row.pricing_snapshot).unwrap();
        assert_eq!(snapshot.quote.input_micro_usd_per_million, 1_000_000);
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn cooperative_cancellation_keeps_execution_slot_until_adapter_cleanup_finishes() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::sync::Notify;
        struct CleanupProvider {
            calls: AtomicUsize,
            started: Notify,
            observed_cancel: Arc<Notify>,
            release: Arc<Notify>,
        }
        impl StageIntentProvider for CleanupProvider {
            fn id(&self) -> &'static str {
                "cleanup-fixture"
            }
            fn model(&self) -> &str {
                "cleanup-v1"
            }
            fn ready(&self) -> bool {
                true
            }
            fn quote(&self, _: &str) -> Result<PriceQuote, String> {
                Ok(metered_quote())
            }
            fn generate(
                &self,
                _: String,
                _: PricingSnapshot,
                _: Option<crate::ai::credential::ProviderCredential>,
                mut cancellation: ProviderCancellation,
            ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ProviderReply> + Send>>
            {
                let first = self.calls.fetch_add(1, Ordering::SeqCst) == 0;
                let observed_cancel = self.observed_cancel.clone();
                let release = self.release.clone();
                self.started.notify_one();
                Box::pin(async move {
                    if first {
                        cancellation.cancelled().await;
                        observed_cancel.notify_one();
                        release.notified().await;
                        ProviderReply {
                            intent: Err("cancelled transport finished cleanup".into()),
                            usage: None,
                        }
                    } else {
                        ProviderReply {
                            intent: Ok(json!({"version":1,"scene":"orb","patch":{}})),
                            usage: Some(TrustedUsage::free()),
                        }
                    }
                })
            }
        }
        let (state, handle) = jobs_state().await;
        let provider = Arc::new(CleanupProvider {
            calls: AtomicUsize::new(0),
            started: Notify::new(),
            observed_cancel: Arc::new(Notify::new()),
            release: Arc::new(Notify::new()),
        });
        state.ai_runtime.install_provider(provider.clone()).await;
        let SubmitOutcome::Accepted { job } =
            submit(&state, "local-owner", "cancel transport", None)
                .await
                .unwrap()
        else {
            panic!()
        };
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            provider.started.notified(),
        )
        .await
        .unwrap();
        let running = job_row(&state, &job.job_id).await;
        let terminal = cancel(&state, "local-owner", &job.job_id, running.state_revision)
            .await
            .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            provider.observed_cancel.notified(),
        )
        .await
        .unwrap();
        assert_eq!(terminal.state, "cancelled");
        assert_eq!(terminal.usage.usage_state, "unknown");
        assert_eq!(terminal.usage.accounted_micro_usd, Some(30_000));
        assert!(state.ai_runtime.execution_slots.try_acquire().is_err());
        let SubmitOutcome::Accepted { job: next } =
            submit(&state, "local-owner", "next request", None)
                .await
                .unwrap()
        else {
            panic!()
        };
        assert_eq!(job_row(&state, &next.job_id).await.state, "accepted");
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
        provider.release.notify_one();
        assert_eq!(
            await_terminal(&state, &next.job_id).await.state,
            "succeeded"
        );
        let slot = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            state.ai_runtime.execution_slots.acquire(),
        )
        .await
        .unwrap()
        .unwrap();
        let latest = get_job(&state, "local-owner", &job.job_id).await.unwrap();
        assert_eq!(latest.state, "cancelled");
        assert_eq!(latest.result_proposal_id, None);
        assert_eq!(latest.usage.usage_state, "unknown");
        assert_eq!(latest.usage.accounted_micro_usd, Some(30_000));
        assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
        drop(slot);
        state.audio.shutdown();
        handle.join().unwrap();
    }

    async fn estimated_entry(state: &Arc<AppState>, id: &str) {
        let snapshot = PricingSnapshot {
            provider: "metered-test".into(),
            model: "metered-v1".into(),
            quote: metered_quote(),
            credential: None,
        };
        store::insert_usage_entry(
            &state.db,
            &store::UsageEntryRow {
                job_id: id.into(),
                accepted_month: "2026-09".into(),
                attempt_id: Some("original-attempt".into()),
                reservation_micro_usd: 30_000,
                accounted_micro_usd: 30_000,
                usage_state: "estimated_final".into(),
                pricing_snapshot: serde_json::to_string(&snapshot).unwrap(),
                reported_usage: None,
                revision: 2,
                created_at: 0,
            },
        )
        .await
        .unwrap();
        let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
        store::settle(&mut tx, "2026-09", 0, 30_000).await.unwrap();
        tx.commit().await.unwrap();
    }

    #[tokio::test]
    async fn late_usage_is_cas_idempotent_in_original_month_without_a_job() {
        let (state, handle) = jobs_state().await;
        let owner = instance_owner(&state).await.unwrap();
        estimated_entry(&state, "retained-ledger").await;
        let counters = TrustedUsage {
            input_tokens: 123,
            output_tokens: 7,
        };
        let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
        store::settle(&mut tx, "2026-10", 0, 42).await.unwrap();
        for (attempt, revision) in [("wrong-attempt", 2), ("original-attempt", 1)] {
            assert!(
                !usage::reconcile(
                    &mut tx,
                    &owner,
                    "retained-ledger",
                    attempt,
                    revision,
                    &counters
                )
                .await
                .unwrap()
            );
        }
        assert!(
            usage::reconcile(
                &mut tx,
                &owner,
                "retained-ledger",
                "original-attempt",
                2,
                &counters
            )
            .await
            .unwrap()
        );
        let revised = store::find_usage_entry(&mut *tx, "retained-ledger")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(revised.revision, 3);
        let old = store::get_or_create_month(&mut tx, "2026-09")
            .await
            .unwrap();
        assert_eq!(old.charged_micro_usd, 137);
        assert_eq!(old.reserved_micro_usd, 0);
        let revision = old.revision;
        // Same callback with stale revision is a no-op. Conflicting facts never overwrite it.
        assert!(
            usage::reconcile(
                &mut tx,
                &owner,
                "retained-ledger",
                "original-attempt",
                2,
                &counters
            )
            .await
            .unwrap()
        );
        assert!(
            !usage::reconcile(
                &mut tx,
                &owner,
                "retained-ledger",
                "original-attempt",
                3,
                &TrustedUsage::free()
            )
            .await
            .unwrap()
        );
        assert!(
            !usage::reconcile(
                &mut tx,
                &owner,
                "retained-ledger",
                "another-attempt",
                3,
                &counters
            )
            .await
            .unwrap()
        );
        assert_eq!(
            store::get_or_create_month(&mut tx, "2026-09")
                .await
                .unwrap()
                .revision,
            revision
        );
        assert_eq!(
            store::get_or_create_month(&mut tx, "2026-10")
                .await
                .unwrap()
                .charged_micro_usd,
            42
        );
        assert!(
            store::find_job_by_id(&mut *tx, "retained-ledger")
                .await
                .unwrap()
                .is_none()
        );
        tx.commit().await.unwrap();
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn late_usage_and_month_adjustment_roll_back_together() {
        let (state, handle) = jobs_state().await;
        let owner = instance_owner(&state).await.unwrap();
        estimated_entry(&state, "rollback").await;
        sqlx::query("CREATE TRIGGER fail_month BEFORE UPDATE ON ai_budget_months BEGIN SELECT RAISE(ABORT, 'month failure'); END")
            .execute(&state.db).await.unwrap();
        let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
        assert!(
            usage::reconcile(
                &mut tx,
                &owner,
                "rollback",
                "original-attempt",
                2,
                &TrustedUsage {
                    input_tokens: 1,
                    output_tokens: 1
                }
            )
            .await
            .is_err()
        );
        tx.rollback().await.unwrap();
        let entry = store::find_usage_entry(&state.db, "rollback")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(entry.usage_state, "estimated_final");
        assert_eq!(entry.revision, 2);
        assert_eq!(entry.accounted_micro_usd, 30_000);
        let mut conn = state.db.acquire().await.unwrap();
        assert_eq!(
            store::get_or_create_month(&mut conn, "2026-09")
                .await
                .unwrap()
                .charged_micro_usd,
            30_000
        );
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn actual_over_reservation_halts_even_below_month_limit() {
        let (state, handle) = jobs_state().await;
        state
            .ai_runtime
            .install_provider(Arc::new(metered(
                true,
                Err("invalid output".into()),
                Some(TrustedUsage {
                    input_tokens: 40_000,
                    output_tokens: 7,
                }),
            )))
            .await;
        let SubmitOutcome::Accepted { job } = submit(&state, "local-owner", "over bound", None)
            .await
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(await_terminal(&state, &job.job_id).await.state, "failed");
        let entry = store::find_usage_entry(&state.db, &job.job_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(entry.accounted_micro_usd, 40_014);
        assert_eq!(entry.usage_state, "reported");
        assert!(
            store::budget_guard(&state.db)
                .await
                .unwrap()
                .unwrap()
                .halted
        );
        assert_eq!(
            submit(&state, "local-owner", "blocked", None)
                .await
                .unwrap_err()
                .code,
            "budget_halted"
        );
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn invalid_price_bound_is_rejected_before_any_reservation() {
        let (state, handle) = jobs_state().await;
        let provider = metered(true, Err("must not call".into()), None);
        provider
            .rate
            .store(10_000_000, std::sync::atomic::Ordering::SeqCst);
        state.ai_runtime.install_provider(Arc::new(provider)).await;
        assert_eq!(
            submit(&state, "local-owner", "bad quote", None)
                .await
                .unwrap_err()
                .code,
            "pricing_unavailable"
        );
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_jobs")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(count, 0);
        let mut conn = state.db.acquire().await.unwrap();
        let budget = store::get_or_create_month(&mut conn, &utc_month_key(now_ms()))
            .await
            .unwrap();
        assert_eq!(budget.reserved_micro_usd, 0);
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn late_usage_can_increase_charges_without_releasing_other_reservations() {
        let (state, handle) = jobs_state().await;
        let owner = instance_owner(&state).await.unwrap();
        estimated_entry(&state, "late-over-bound").await;
        let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
        store::reserve(&mut tx, "2026-09", 20_000, MONTHLY_LIMIT_MICRO_USD)
            .await
            .unwrap();
        assert!(
            usage::reconcile(
                &mut tx,
                &owner,
                "late-over-bound",
                "original-attempt",
                2,
                &TrustedUsage {
                    input_tokens: 40_000,
                    output_tokens: 7
                }
            )
            .await
            .unwrap()
        );
        let month = store::get_or_create_month(&mut tx, "2026-09")
            .await
            .unwrap();
        assert_eq!(month.reserved_micro_usd, 20_000);
        assert_eq!(month.charged_micro_usd, 40_014);
        assert!(store::budget_guard(&mut *tx).await.unwrap().unwrap().halted);
        tx.commit().await.unwrap();
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn late_usage_month_total_overflow_saturates_and_keeps_estimate() {
        let (state, handle) = jobs_state().await;
        let owner = instance_owner(&state).await.unwrap();
        estimated_entry(&state, "late-month-overflow").await;
        let mut reservation_tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
        store::reserve(
            &mut reservation_tx,
            "2026-09",
            20_000,
            MONTHLY_LIMIT_MICRO_USD,
        )
        .await
        .unwrap();
        reservation_tx.commit().await.unwrap();
        sqlx::query("UPDATE ai_budget_months SET charged_micro_usd = ?1 WHERE month = '2026-09'")
            .bind(i64::MAX - 100)
            .execute(&state.db)
            .await
            .unwrap();

        let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
        assert!(
            !usage::reconcile(
                &mut tx,
                &owner,
                "late-month-overflow",
                "original-attempt",
                2,
                &TrustedUsage {
                    input_tokens: 40_000,
                    output_tokens: 7,
                }
            )
            .await
            .unwrap()
        );
        tx.commit().await.unwrap();

        let entry = store::find_usage_entry(&state.db, "late-month-overflow")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(entry.usage_state, "estimated_final");
        assert_eq!(entry.revision, 2);
        assert_eq!(entry.accounted_micro_usd, 30_000);
        let mut conn = state.db.acquire().await.unwrap();
        let month = store::get_or_create_month(&mut conn, "2026-09")
            .await
            .unwrap();
        assert_eq!(month.charged_micro_usd, i64::MAX);
        assert_eq!(month.reserved_micro_usd, 20_000);
        let guard = store::budget_guard(&mut *conn).await.unwrap().unwrap();
        assert!(guard.halted);
        assert_eq!(guard.reason, "usage month total overflow");
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn late_usage_adjustment_underflow_halts_and_keeps_estimate() {
        let (state, handle) = jobs_state().await;
        let owner = instance_owner(&state).await.unwrap();
        estimated_entry(&state, "late-month-underflow").await;
        sqlx::query("UPDATE ai_budget_months SET charged_micro_usd = 0 WHERE month = '2026-09'")
            .execute(&state.db)
            .await
            .unwrap();

        let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
        assert!(
            !usage::reconcile(
                &mut tx,
                &owner,
                "late-month-underflow",
                "original-attempt",
                2,
                &TrustedUsage::free(),
            )
            .await
            .unwrap()
        );
        tx.commit().await.unwrap();

        let entry = store::find_usage_entry(&state.db, "late-month-underflow")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(entry.usage_state, "estimated_final");
        assert_eq!(entry.revision, 2);
        assert_eq!(entry.accounted_micro_usd, 30_000);
        let mut conn = state.db.acquire().await.unwrap();
        assert_eq!(
            store::get_or_create_month(&mut conn, "2026-09")
                .await
                .unwrap()
                .charged_micro_usd,
            0
        );
        let guard = store::budget_guard(&mut *conn).await.unwrap().unwrap();
        assert!(guard.halted);
        assert_eq!(guard.reason, "usage month adjustment underflow");
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_usage_callbacks_adjust_the_month_once() {
        async fn callback(state: &Arc<AppState>, owner: &str) -> bool {
            let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
            let applied = usage::reconcile(
                &mut tx,
                owner,
                "concurrent",
                "original-attempt",
                2,
                &TrustedUsage {
                    input_tokens: 123,
                    output_tokens: 7,
                },
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();
            applied
        }
        let (state, handle) = jobs_state().await;
        let owner = instance_owner(&state).await.unwrap();
        estimated_entry(&state, "concurrent").await;
        assert_eq!(
            tokio::join!(callback(&state, &owner), callback(&state, &owner)),
            (true, true)
        );
        let entry = store::find_usage_entry(&state.db, "concurrent")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(entry.revision, 3);
        let mut conn = state.db.acquire().await.unwrap();
        assert_eq!(
            store::get_or_create_month(&mut conn, "2026-09")
                .await
                .unwrap()
                .charged_micro_usd,
            137
        );
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn terminal_month_overflow_retains_estimate_and_persistent_guard() {
        let (state, handle) = jobs_state().await;
        let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
        store::settle(&mut tx, &utc_month_key(now_ms()), 0, 1)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        state
            .ai_runtime
            .install_provider(Arc::new(metered(
                true,
                Err("oversized bill".into()),
                Some(TrustedUsage {
                    input_tokens: i64::MAX as u64,
                    output_tokens: 0,
                }),
            )))
            .await;
        let SubmitOutcome::Accepted { job } =
            submit(&state, "local-owner", "aggregate overflow", None)
                .await
                .unwrap()
        else {
            panic!()
        };
        assert_eq!(await_terminal(&state, &job.job_id).await.state, "failed");
        let entry = store::find_usage_entry(&state.db, &job.job_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(entry.accounted_micro_usd, 30_000);
        assert_eq!(entry.usage_state, "unknown");
        let mut conn = state.db.acquire().await.unwrap();
        let month = store::get_or_create_month(&mut conn, &utc_month_key(now_ms()))
            .await
            .unwrap();
        assert_eq!(month.charged_micro_usd, i64::MAX);
        assert_eq!(month.reserved_micro_usd, 0);
        assert!(
            store::budget_guard(&mut *conn)
                .await
                .unwrap()
                .unwrap()
                .halted
        );
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unrepresentable_month_total_saturates_and_commits_terminal_state() {
        let (state, handle) = jobs_state().await;
        let provider = metered(
            false,
            Err("provider returned an oversized bill".into()),
            Some(TrustedUsage {
                input_tokens: 123,
                output_tokens: 7,
            }),
        );
        let gate = provider.gate.clone();
        state.ai_runtime.install_provider(Arc::new(provider)).await;
        let SubmitOutcome::Accepted { job } =
            submit(&state, "local-owner", "aggregate overflow", None)
                .await
                .unwrap()
        else {
            panic!("task should be accepted before the overflow is injected");
        };
        for _ in 0..200 {
            let row = job_row(&state, &job.job_id).await;
            if row.state == "running" && row.dispatch_state == "may_have_been_sent" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(
            job_row(&state, &job.job_id).await.dispatch_state,
            "may_have_been_sent"
        );

        let month = utc_month_key(now_ms());
        let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
        store::reserve(&mut tx, &month, 20_000, MONTHLY_LIMIT_MICRO_USD)
            .await
            .unwrap();
        store::settle(&mut tx, &month, 0, i64::MAX - 100)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        gate.store(true, std::sync::atomic::Ordering::SeqCst);

        assert_eq!(await_terminal(&state, &job.job_id).await.state, "failed");
        let entry = store::find_usage_entry(&state.db, &job.job_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(entry.accounted_micro_usd, 30_000);
        assert_eq!(entry.usage_state, "unknown");
        assert!(entry.reported_usage.is_none());
        let task = job_row(&state, &job.job_id).await;
        let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
        assert!(
            !usage::reconcile(
                &mut tx,
                &task.owner_instance_id,
                &job.job_id,
                task.attempt_id.as_deref().unwrap(),
                entry.revision,
                &TrustedUsage::free(),
            )
            .await
            .unwrap()
        );
        tx.commit().await.unwrap();
        let unchanged = store::find_usage_entry(&state.db, &job.job_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.revision, entry.revision);
        assert_eq!(unchanged.accounted_micro_usd, 30_000);
        assert_eq!(unchanged.usage_state, "unknown");
        let mut conn = state.db.acquire().await.unwrap();
        let budget = store::get_or_create_month(&mut conn, &month).await.unwrap();
        assert_eq!(budget.charged_micro_usd, i64::MAX);
        assert_eq!(budget.reserved_micro_usd, 20_000);
        let guard = store::budget_guard(&mut *conn).await.unwrap().unwrap();
        assert!(guard.halted);
        assert_eq!(guard.reason, "usage month total overflow");
        drop(conn);
        let owner = instance_owner(&state).await.unwrap();
        assert_eq!(
            status(&state, &owner).await.unwrap()["budget"]["chargedTotalOverflowed"],
            true
        );
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn unrepresentable_usage_retains_estimate_and_halts() {
        let (state, handle) = jobs_state().await;
        let owner = instance_owner(&state).await.unwrap();
        estimated_entry(&state, "overflow").await;
        let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
        assert!(
            !usage::reconcile(
                &mut tx,
                &owner,
                "overflow",
                "original-attempt",
                2,
                &TrustedUsage {
                    input_tokens: u64::MAX,
                    output_tokens: u64::MAX
                }
            )
            .await
            .unwrap()
        );
        tx.commit().await.unwrap();
        let entry = store::find_usage_entry(&state.db, "overflow")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(entry.accounted_micro_usd, 30_000);
        assert_eq!(entry.revision, 2);
        assert!(
            store::budget_guard(&state.db)
                .await
                .unwrap()
                .unwrap()
                .halted
        );
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn terminal_unrepresentable_usage_keeps_estimate_and_halts() {
        let (state, handle) = jobs_state().await;
        state
            .ai_runtime
            .install_provider(Arc::new(metered(
                true,
                Err("provider returned unrepresentable usage".into()),
                Some(TrustedUsage {
                    input_tokens: u64::MAX,
                    output_tokens: 0,
                }),
            )))
            .await;
        let SubmitOutcome::Accepted { job } = submit(
            &state,
            "local-owner",
            "unrepresentable terminal usage",
            None,
        )
        .await
        .unwrap() else {
            panic!()
        };

        assert_eq!(await_terminal(&state, &job.job_id).await.state, "failed");
        let entry = store::find_usage_entry(&state.db, &job.job_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(entry.usage_state, "unknown");
        assert_eq!(entry.accounted_micro_usd, 30_000);
        assert!(entry.reported_usage.is_none());
        let mut conn = state.db.acquire().await.unwrap();
        let month = store::get_or_create_month(&mut conn, &utc_month_key(now_ms()))
            .await
            .unwrap();
        assert_eq!(month.charged_micro_usd, 30_000);
        assert_eq!(month.reserved_micro_usd, 0);
        let guard = store::budget_guard(&mut *conn).await.unwrap().unwrap();
        assert!(guard.halted);
        assert_eq!(guard.reason, "usage amount overflow");
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn retention_clears_payloads_preserves_keys_and_keeps_ledger_attribution() {
        let (state, handle) = jobs_state().await;
        let owner = instance_owner(&state).await.unwrap();
        let now = now_ms();
        for (id, age) in [("protected", 2), ("old", 8)] {
            let created = now - age * 86_400_000;
            let key = format!("v1.{created}.00000000000000000000000000000001");
            sqlx::query("INSERT INTO ai_jobs (job_id,owner_instance_id,principal,capability,key,input_hash,state,state_revision,dispatch_state,attempt_id,provider,model,created_at,updated_at) VALUES (?1,?2,'local-owner',?3,?4,'hash','cancelled',2,'may_have_been_sent','attempt','fake','fake',?5,?5)")
                .bind(id).bind(&owner).bind(CAPABILITY).bind(key).bind(created).execute(&state.db).await.unwrap();
            store::insert_proposal(
                &state.db,
                &store::ProposalRow {
                    proposal_id: format!("proposal-{id}"),
                    job_id: id.into(),
                    validated_intent: "sensitive-validated-candidate".into(),
                    schema_version: "1".into(),
                    state: "pending".into(),
                    revision: 1,
                    created_at: created,
                    expires_at: now - 1,
                },
            )
            .await
            .unwrap();
            store::insert_usage_entry(
                &state.db,
                &store::UsageEntryRow {
                    job_id: id.into(),
                    accepted_month: utc_month_key(created),
                    attempt_id: Some("attempt".into()),
                    reservation_micro_usd: 50_000,
                    accounted_micro_usd: 50_000,
                    usage_state: "unknown".into(),
                    pricing_snapshot: "{}".into(),
                    reported_usage: None,
                    revision: 1,
                    created_at: created,
                },
            )
            .await
            .unwrap();
        }
        sweep(&state).await.unwrap();
        let proposal = store::find_proposal(&state.db, "proposal-protected")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(proposal.validated_intent, "null");
        assert_eq!(proposal.state, "expired");
        assert!(
            store::find_job_by_id(&state.db, "protected")
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            store::find_job_by_id(&state.db, "old")
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            store::find_proposal(&state.db, "proposal-old")
                .await
                .unwrap()
                .is_none()
        );
        let entry = store::find_usage_entry(&state.db, "old")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(entry.usage_state, "estimated_final");
        assert_eq!(
            entry.accounted_micro_usd, 50_000,
            "24h unknown is never a refund or an extra charge"
        );
        assert_eq!(entry.accepted_month, utc_month_key(now - 8 * 86_400_000));
        assert_eq!(entry.attempt_id.as_deref(), Some("attempt"));
        let revision = entry.revision;
        sweep(&state).await.unwrap();
        assert_eq!(
            store::find_usage_entry(&state.db, "old")
                .await
                .unwrap()
                .unwrap()
                .revision,
            revision
        );
        let old_key = format!(
            "v1.{}.00000000000000000000000000000001",
            now - 8 * 86_400_000
        );
        assert_eq!(
            submit(&state, "local-owner", "old retry", Some(&old_key))
                .await
                .unwrap_err()
                .code,
            "bad_request"
        );
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn protected_history_capacity_fails_closed_without_reserving() {
        let (state, handle) = jobs_state().await;
        let owner = instance_owner(&state).await.unwrap();
        sqlx::query("WITH RECURSIVE ids(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM ids WHERE x < 500)
            INSERT INTO ai_jobs (job_id,owner_instance_id,principal,capability,key,input_hash,state,state_revision,dispatch_state,provider,model,created_at,updated_at)
            SELECT 'full-'||x,?1,'local-owner',?2,'key-'||x,'hash','failed',2,'not_dispatched','fake','fake',?3,?3 FROM ids")
            .bind(&owner).bind(CAPABILITY).bind(now_ms()).execute(&state.db).await.unwrap();
        assert_eq!(
            submit(&state, "local-owner", "full", None)
                .await
                .unwrap_err()
                .code,
            "history_capacity_exceeded"
        );
        let budget = {
            let mut c = state.db.acquire().await.unwrap();
            store::get_or_create_month(&mut c, &utc_month_key(now_ms()))
                .await
                .unwrap()
        };
        assert_eq!(budget.reserved_micro_usd, 0);
        sqlx::query("DELETE FROM ai_jobs")
            .execute(&state.db)
            .await
            .unwrap();
        store::insert_usage_entry(
            &state.db,
            &store::UsageEntryRow {
                job_id: "large-ledger".into(),
                accepted_month: utc_month_key(now_ms()),
                attempt_id: None,
                reservation_micro_usd: 0,
                accounted_micro_usd: 0,
                usage_state: "reported".into(),
                pricing_snapshot: "x".repeat(HISTORY_BYTE_LIMIT as usize),
                reported_usage: None,
                revision: 1,
                created_at: now_ms(),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            submit(&state, "local-owner", "large", None)
                .await
                .unwrap_err()
                .code,
            "history_capacity_exceeded"
        );
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn retention_pauses_on_clock_rollback_and_ledger_keeps_thirteen_months() {
        let (state, handle) = jobs_state().await;
        let owner = instance_owner(&state).await.unwrap();
        let now = now_ms();
        store::insert_proposal(
            &state.db,
            &store::ProposalRow {
                proposal_id: "clock".into(),
                job_id: "none".into(),
                validated_intent: "keep-until-clock-stable".into(),
                schema_version: "1".into(),
                state: "pending".into(),
                revision: 1,
                created_at: now - 100,
                expires_at: now - 1,
            },
        )
        .await
        .unwrap();
        {
            let mut c = state.db.acquire().await.unwrap();
            store::advance_watermark(&mut c, &owner, now + 600_000)
                .await
                .unwrap();
        }
        sweep(&state).await.unwrap();
        assert_eq!(
            store::find_proposal(&state.db, "clock")
                .await
                .unwrap()
                .unwrap()
                .validated_intent,
            "keep-until-clock-stable"
        );
        assert_eq!(
            submit(&state, "local-owner", "clock", None)
                .await
                .unwrap_err()
                .code,
            "clock_skew"
        );
        {
            let mut c = state.db.acquire().await.unwrap();
            for (id, month) in [("past", "2025-09"), ("boundary", "2025-10")] {
                store::insert_usage_entry(
                    &mut *c,
                    &store::UsageEntryRow {
                        job_id: id.into(),
                        accepted_month: month.into(),
                        attempt_id: Some("retained-attempt".into()),
                        reservation_micro_usd: 100,
                        accounted_micro_usd: 100,
                        usage_state: "estimated_final".into(),
                        pricing_snapshot: "{}".into(),
                        reported_usage: None,
                        revision: 1,
                        created_at: now,
                    },
                )
                .await
                .unwrap();
            }
            sqlx::query("INSERT INTO ai_jobs (job_id,owner_instance_id,principal,capability,key,input_hash,state,state_revision,dispatch_state,provider,model,created_at,updated_at) VALUES ('held',?1,'local-owner','generate','held-key','hash','cancelled',2,'may_have_been_sent','fake','fake',0,?2)")
                .bind(&owner).bind(now).execute(&mut *c).await.unwrap();
            store::insert_usage_entry(
                &mut *c,
                &store::UsageEntryRow {
                    job_id: "held".into(),
                    accepted_month: "2025-08".into(),
                    attempt_id: Some("held-attempt".into()),
                    reservation_micro_usd: 100,
                    accounted_micro_usd: 100,
                    usage_state: "estimated_final".into(),
                    pricing_snapshot: "{}".into(),
                    reported_usage: None,
                    revision: 1,
                    created_at: now,
                },
            )
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO ai_budget_months (month,charged_micro_usd) VALUES ('2025-08',100)",
            )
            .execute(&mut *c)
            .await
            .unwrap();
            store::retain_ai_history(&mut c, now, now - KEY_WINDOW_MS, "2025-10")
                .await
                .unwrap();
        }
        assert!(
            store::find_usage_entry(&state.db, "past")
                .await
                .unwrap()
                .is_none()
        );
        let retained_budget: i64 = sqlx::query_scalar(
            "SELECT charged_micro_usd FROM ai_budget_months WHERE month = '2025-08'",
        )
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(
            retained_budget, 100,
            "retained usage must retain its original month's aggregate"
        );
        assert!(
            store::find_usage_entry(&state.db, "boundary")
                .await
                .unwrap()
                .is_some()
        );
        state.audio.shutdown();
        handle.join().unwrap();
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
            fn quote(&self, _: &str) -> Result<PriceQuote, String> {
                Err("not ready".into())
            }
            fn generate(
                &self,
                _: String,
                _: PricingSnapshot,
                _credential: Option<crate::ai::credential::ProviderCredential>,
                _cancellation: ProviderCancellation,
            ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ProviderReply> + Send>>
            {
                Box::pin(async {
                    ProviderReply {
                        intent: Err("不该被调用".into()),
                        usage: None,
                    }
                })
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
        assert!(
            get_proposal(&state, "other-principal", &proposal_id)
                .await
                .is_err()
        );
        assert_eq!(
            store::find_proposal(&state.db, &proposal_id)
                .await
                .unwrap()
                .unwrap()
                .state,
            "pending"
        );
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
        // Hold the slot so the fixture remains accepted until the sweep.
        let _slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
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
        state.ai_runtime.inputs.lock().await.remove(&job.job_id);
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
        assert!(
            validate_intent(&json!({ "version": 1, "scene": "towers", "patch": {}, "junk": 1 }))
                .is_err()
        );
        // patch 键必须落在场景参数表内（结构合法但参数不存在也失败）。
        assert!(
            validate_intent(
                &json!({ "version": 1, "scene": "towers", "patch": { "intensity": 1 } })
            )
            .is_err()
        );
        assert!(
            validate_intent(
                &json!({ "version": 1, "scene": "towers", "patch": { "sc.height": 5.5 } })
            )
            .is_ok()
        );
        for bad in [
            json!({"version":1,"scene":"towers","patch":{"height":1}}),
            json!({"version":1,"scene":"towers","patch":{"sc.height":"1"}}),
            json!({"version":1,"scene":"towers","patch":{},"director":"yes"}),
            json!({"version":1,"scene":"towers","patch":{},"hand":{"on":1}}),
        ] {
            assert!(validate_intent(&bad).is_err(), "{bad}");
        }
        let deep = json!({ "version": 1, "scene": "s", "patch": { "a": { "b": { "c": { "d": { "e": { "f": { "g": { "h": { "i": 1 } } } } } } } } } });
        assert!(validate_intent(&deep).is_err());
        let oversized = json!({ "version": 1, "scene": "x".repeat(20000), "patch": {} });
        assert!(validate_intent(&oversized).is_err());
    }

    #[tokio::test]
    async fn consent_gate_blocks_when_switch_is_off() {
        let (state, handle) = jobs_state().await;
        // jobs_state 已置位：先证明受理可用，再关掉开关验证默认拒绝。
        let owner = instance_owner(&state).await.unwrap();
        let status = status(&state, owner.as_str()).await.unwrap();
        assert_eq!(status["consent"]["inAppGeneration"], json!(true));
        vmusic_store::settings::set(&state.db, CONSENT_KEY, &serde_json::Value::Bool(false))
            .await
            .unwrap();
        let err = submit(&state, crate::idempotency::LOCAL_OWNER, "未同意", None)
            .await
            .unwrap_err();
        assert_eq!(err.status.as_u16(), 403);
        assert_eq!(err.code, "generation_disabled");
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn usage_entries_record_each_terminal_path() {
        let (state, handle) = jobs_state().await;
        // 成功路径：reported、accounted 0（fake 免费）。
        let SubmitOutcome::Accepted { job } =
            submit(&state, crate::idempotency::LOCAL_OWNER, "成功账目", None)
                .await
                .unwrap()
        else {
            panic!("受理");
        };
        for _ in 0..200 {
            if job_row(&state, &job.job_id).await.state == "succeeded" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let entry = store::find_usage_entry(&state.db, &job.job_id)
            .await
            .unwrap()
            .expect("成功任务必须有账目");
        assert_eq!(entry.usage_state, "reported");
        assert_eq!(entry.accounted_micro_usd, 0);

        // 已派发后取消：unknown、按预留计（§8.4）。
        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let gate = Arc::new(std::sync::atomic::AtomicBool::new(false));
        state
            .ai_runtime
            .install_provider(Arc::new(BlockedProvider {
                counter: counter.clone(),
                gate: gate.clone(),
            }))
            .await;
        let SubmitOutcome::Accepted { job: blocked } =
            submit(&state, crate::idempotency::LOCAL_OWNER, "派发后取消", None)
                .await
                .unwrap()
        else {
            panic!("受理");
        };
        for _ in 0..200 {
            let row = job_row(&state, &blocked.job_id).await;
            if row.state == "running" && row.dispatch_state == "may_have_been_sent" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let revision = job_row(&state, &blocked.job_id).await.state_revision;
        cancel(
            &state,
            crate::idempotency::LOCAL_OWNER,
            &blocked.job_id,
            revision,
        )
        .await
        .unwrap();
        let entry = store::find_usage_entry(&state.db, &blocked.job_id)
            .await
            .unwrap()
            .expect("已派发取消必须有账目");
        assert_eq!(entry.usage_state, "unknown", "已派发取消按 unknown 计");
        assert_eq!(entry.accounted_micro_usd, RESERVATION_MICRO_USD);
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn budget_guard_halts_persistently_and_resets_by_revision() {
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
        // 受理一个任务（预留先占住），然后把月账的其他部分灌到限额满——
        // 这正是「迟到 usage 越界」的形状：预留时还有余量，结算时越界。
        let SubmitOutcome::Accepted { job } =
            submit(&state, crate::idempotency::LOCAL_OWNER, "越界候选", None)
                .await
                .unwrap()
        else {
            panic!("受理");
        };
        for _ in 0..200 {
            let row = job_row(&state, &job.job_id).await;
            if row.state == "running" && row.dispatch_state == "may_have_been_sent" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let month = utc_month_key(now_ms());
        {
            let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
            store::settle(&mut tx, &month, 0, MONTHLY_LIMIT_MICRO_USD)
                .await
                .unwrap();
            tx.commit().await.unwrap();
        }
        // 取消该任务 → unknown 结算 +50000 → charged 越过限额 → 持久熔断。
        let revision = job_row(&state, &job.job_id).await.state_revision;
        cancel(
            &state,
            crate::idempotency::LOCAL_OWNER,
            &job.job_id,
            revision,
        )
        .await
        .unwrap();
        let guard = store::budget_guard(&state.db).await.unwrap().unwrap();
        assert!(guard.halted, "越过限额必须置位持久熔断");
        assert_eq!(guard.trigger_job.as_deref(), Some(job.job_id.as_str()));
        // 熔断期间 submit → 503 budget_halted（先于 reserve）。
        let err = submit(&state, crate::idempotency::LOCAL_OWNER, "熔断中", None)
            .await
            .unwrap_err();
        assert_eq!(err.code, "budget_halted");
        // reset：错误 revision 冲突；正确 revision 恢复。
        let err = budget_guard_reset(&state, guard.revision - 1)
            .await
            .unwrap_err();
        assert_eq!(err.code, "state_conflict");
        assert_eq!(
            budget_guard_reset(&state, guard.revision)
                .await
                .unwrap_err()
                .code,
            "generation_in_flight"
        );
        gate.store(true, std::sync::atomic::Ordering::SeqCst);
        let slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
        drop(slot);
        assert_eq!(
            budget_guard_reset(&state, guard.revision)
                .await
                .unwrap_err()
                .code,
            "budget_unhealthy"
        );
        sqlx::query("UPDATE ai_budget_months SET charged_micro_usd = 0")
            .execute(&state.db)
            .await
            .unwrap();
        let result = budget_guard_reset(&state, guard.revision).await.unwrap();
        assert_eq!(result["halted"], json!(false));
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn task_state_changes_are_broadcast_as_small_events() {
        let (state, handle) = jobs_state().await;
        let mut events = state.events.subscribe();
        let SubmitOutcome::Accepted { job } =
            submit(&state, crate::idempotency::LOCAL_OWNER, "事件候选", None)
                .await
                .unwrap()
        else {
            panic!("受理");
        };
        // 收集直到终态事件（顺序允许乱序，内容必须只含 ID/状态/revision）。
        let mut seen = Vec::new();
        for _ in 0..200 {
            while let Ok(event) = events.try_recv() {
                if let WsEvent::AiTask {
                    job_id,
                    state: task_state,
                    state_revision,
                } = &event
                {
                    assert_eq!(job_id, &job.job_id);
                    let encoded = serde_json::to_string(&event).unwrap();
                    assert!(encoded.len() < 2048, "任务事件必须小于 2KiB");
                    assert!(!encoded.contains("brief"));
                    seen.push(task_state.clone());
                    let _ = state_revision;
                }
            }
            if seen.last().map(|s| s.as_str()) == Some("succeeded") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(
            seen.contains(&"accepted".to_string()),
            "缺 accepted 事件: {seen:?}"
        );
        assert!(
            seen.contains(&"running".to_string()),
            "缺 running 事件: {seen:?}"
        );
        assert!(
            seen.contains(&"succeeded".to_string()),
            "缺终态事件: {seen:?}"
        );
        state.audio.shutdown();
        handle.join().unwrap();
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
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ledger_failure_rolls_back_proposal_and_success() {
        let (state, handle) = jobs_state().await;
        sqlx::query("CREATE TRIGGER fail_report BEFORE INSERT ON ai_usage_entries WHEN NEW.usage_state = 'reported' BEGIN SELECT RAISE(ABORT, 'injected ledger failure'); END")
            .execute(&state.db).await.unwrap();
        let SubmitOutcome::Accepted { job } = submit(&state, "local-owner", "ledger fault", None)
            .await
            .unwrap()
        else {
            panic!()
        };
        let slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
        // The worker may not have acquired its slot yet. Wait via DB rather than assuming spawn order.
        drop(slot);
        for _ in 0..200 {
            if job_row(&state, &job.job_id).await.state == "failed" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let row = job_row(&state, &job.job_id).await;
        assert_eq!(row.state, "failed");
        assert!(row.result_proposal_id.is_none());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_proposals")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(count, 0);
        let usage = store::find_usage_entry(&state.db, &job.job_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(usage.usage_state, "unknown");
        let budget = status(&state, &row.owner_instance_id).await.unwrap();
        assert_eq!(budget["budget"]["reservedMicroUsd"], 0);
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn failed_terminal_transactions_publish_no_events_and_orphan_sweep_rolls_back() {
        let (state, handle) = jobs_state().await;
        let _slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
        let SubmitOutcome::Accepted { job } = submit(&state, "local-owner", "atomic expiry", None)
            .await
            .unwrap()
        else {
            panic!()
        };
        let mut events = state.events.subscribe();
        sqlx::query("CREATE TRIGGER fail_usage BEFORE INSERT ON ai_usage_entries BEGIN SELECT RAISE(ABORT, 'injected failure'); END")
            .execute(&state.db).await.unwrap();
        assert!(cancel(&state, "local-owner", &job.job_id, 1).await.is_err());
        assert!(recover(&state).await.is_err());
        assert!(state
            .ai_runtime
            .inputs
            .lock()
            .await
            .contains_key(&job.job_id));
        sqlx::query("UPDATE ai_jobs SET created_at = ?1 WHERE job_id = ?2")
            .bind(now_ms() - QUEUE_DEADLINE_MS - 1000)
            .bind(&job.job_id)
            .execute(&state.db)
            .await
            .unwrap();
        state.ai_runtime.inputs.lock().await.remove(&job.job_id);
        assert!(sweep(&state).await.is_err());
        assert_eq!(job_row(&state, &job.job_id).await.state, "accepted");
        while let Ok(event) = events.try_recv() {
            assert!(!matches!(event, WsEvent::AiTask { .. }));
        }
        sqlx::query("DROP TRIGGER fail_usage")
            .execute(&state.db)
            .await
            .unwrap();
        assert_eq!(recover(&state).await.unwrap(), 1);
        assert_eq!(job_row(&state, &job.job_id).await.state, "interrupted");
        assert!(
            matches!(events.try_recv().unwrap(), WsEvent::AiTask { state, .. } if state == "interrupted")
        );
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn disabled_generation_replays_but_does_not_dispatch_queued_jobs() {
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
        submit(&state, "local-owner", "active", None).await.unwrap();
        for _ in 0..200 {
            if counter.load(std::sync::atomic::Ordering::SeqCst) == 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let key = format!("v1.{}.{}", now_ms(), uuid::Uuid::new_v4().simple());
        let SubmitOutcome::Accepted { job } = submit(&state, "local-owner", "queued", Some(&key))
            .await
            .unwrap()
        else {
            panic!()
        };
        vmusic_store::settings::set(&state.db, CONSENT_KEY, &json!(false))
            .await
            .unwrap();
        assert!(matches!(
            submit(&state, "local-owner", "queued", Some(&key))
                .await
                .unwrap(),
            SubmitOutcome::Replayed { .. }
        ));
        gate.store(true, std::sync::atomic::Ordering::SeqCst);
        for _ in 0..200 {
            if job_row(&state, &job.job_id).await.state == "failed" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let row = job_row(&state, &job.job_id).await;
        assert_eq!(row.state, "failed");
        assert_eq!(row.dispatch_state, "not_dispatched");
        assert_eq!(counter.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(
            store::find_usage_entry(&state.db, &job.job_id)
                .await
                .unwrap()
                .unwrap()
                .usage_state,
            "released"
        );
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn acceptance_survives_waiter_abort_and_history_filters_before_limit() {
        let (state, handle) = jobs_state().await;
        let slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
        let owner = instance_owner(&state).await.unwrap();
        let inputs = state.ai_runtime.inputs.lock().await;
        let task_state = state.clone();
        let waiter =
            tokio::spawn(async move { submit(&task_state, "alice", "detached", None).await });
        // Admission is detached and blocked on the handoff mutex. Abort only the caller.
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        waiter.abort();
        let _ = waiter.await;
        drop(inputs);
        let mut rows = Vec::new();
        for _ in 0..200 {
            rows = store::list_jobs(&state.db, &owner, "alice", None, None, 1)
                .await
                .unwrap();
            if !rows.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let job = rows.first().unwrap().clone();
        submit(&state, "bob", "newer", None).await.unwrap();
        sqlx::query("UPDATE ai_jobs SET created_at = created_at + 1 WHERE principal = 'bob'")
            .execute(&state.db)
            .await
            .unwrap();
        let listed = list_jobs(&state, "alice", &owner, None, None, 1)
            .await
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].job_id, job.job_id);
        drop(slot);
        for _ in 0..200 {
            if job_row(&state, &job.job_id).await.state == "succeeded" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(job_row(&state, &job.job_id).await.state, "succeeded");
        state.audio.shutdown();
        handle.join().unwrap();
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn official_rpc_exposes_the_same_persistent_job_lifecycle() {
        use crate::rpc::{Call, Op, Rpc};
        async fn call(rpc: &Rpc, op: Op, path: &str, body: Value) -> Value {
            rpc.call(Call {
                op,
                path,
                query: json!({}),
                body,
                raw: None,
                client_operation_id: None,
            })
            .await
            .unwrap()
            .body
        }
        let (state, handle) = jobs_state().await;
        let rpc = Rpc::new(state.clone());
        assert_eq!(
            call(&rpc, Op::Get, "v1/ai/status", Value::Null).await["consent"]["inAppGeneration"],
            true
        );
        let result = call(&rpc, Op::Post, "v1/ai/jobs", json!({"brief":"RPC stage"})).await;
        let id = result["job"]["jobId"].as_str().unwrap();
        let mut done = Value::Null;
        for _ in 0..200 {
            done = call(&rpc, Op::Get, &format!("v1/ai/jobs/{id}"), Value::Null).await;
            if done["state"] == "succeeded" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(done["state"], "succeeded");
        assert_eq!(
            call(&rpc, Op::Get, "v1/ai/jobs", Value::Null).await["jobs"][0]["jobId"],
            id
        );
        let proposal_id = done["resultProposalId"].as_str().unwrap();
        let path = format!("v1/ai/proposals/{proposal_id}");
        let proposal = call(&rpc, Op::Get, &path, Value::Null).await;
        assert_eq!(proposal["state"], "pending");
        assert_eq!(
            call(
                &rpc,
                Op::Post,
                &(path + "/reject"),
                json!({"expected_revision":proposal["revision"]})
            )
            .await["state"],
            "rejected"
        );
        state.audio.shutdown();
        handle.join().unwrap();
    }
}
