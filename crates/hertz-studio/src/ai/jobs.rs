// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! AiService：持久生成任务的受理、执行、取消与恢复（技术路线 R4-J / §7）。
//!
//! 完整顺序（§7.1）：认证/实例/授权（传输层）→ 幂等键查询 → 新键的时间
//! 窗口、排队容量、provider 就绪与预算就绪 → 事务写 job + 费用预留 →
//! 返回 accepted → worker 复核派发授权 → 事务登记唯一派发标记 →
//! provider 一次调用 → 校验 intent → 事务写提案与终态。已核价任务同时冻结
//! 金额预留；token-only 任务只冻结有限请求与 token 上界。
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
//! - 价格快照在受理时冻结。已核价任务缺失 usage 按预留计 unknown；
//!   token-only 任务不预留金额，可信 usage 只记 token，缺失时保持未知。
//!   默认 provider 是免费 fake；Ollama 需显式配置，OpenAI 在具体模型与
//!   费率 profile 确定前保持不可派发。
//! - 任务最小记录保留 7 天，过期提案清除载荷；账本独立保留 13 个月。
//!   500 条任务与 20 MiB 逻辑数据满额时拒绝新受理，不淘汰受保护记录。
//!   明显校时回跳暂停新受理与清理；过期旧 key 绝不作为新收费动作。

use std::collections::HashMap;
use std::sync::Arc;

use futures::FutureExt;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, RwLock};
use vmusic_core::StoreError;

use crate::error::{bad_request, internal, not_found, ApiError, ApiResult};
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
const TERMINAL_SETTLEMENT_RETRY_DELAYS_MS: [u64; 3] = [100, 250, 500];
const TERMINAL_CLEANUP_TIMEOUT_MS: u64 = 2_000;
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
// provider 接口与 fake 实现（fake 保留作默认及本地联调 provider）
// ---------------------------------------------------------------------------

/// 生成一份 StageIntent 候选。一次任务最多一次调用（§8.1）：
/// 不自动修复、不自动重试，调用方不把 DB 事务重试包住它。
pub(crate) trait StageIntentProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn model(&self) -> &str;
    fn endpoint_identity(&self) -> Option<&str> {
        None
    }
    fn diagnostic(&self) -> Option<&'static str> {
        None
    }
    /// 就绪检查：cloud 凭据缺失/被禁用时返回 false，受理直接拒绝。
    fn ready(&self) -> bool;
    fn requires_credential(&self) -> bool {
        false
    }
    /// Freeze a metered price or explicit token-only request bounds for the
    /// complete request. No network or model call is allowed while quoting.
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

    /// 结构化壁纸输出模式（§19.5）：一次调用返回待校验的 builtin 输出 JSON，
    /// 校验由 [`hertz_wallpaper::generation::BuiltinSceneOutput`] 的合同层
    /// 负责。未实现结构化模式的 provider 沿用安全默认拒绝，不假装支持。
    fn supports_wallpaper_builtin(&self) -> bool {
        false
    }

    fn generate_wallpaper_builtin(
        &self,
        _request: &hertz_wallpaper::generation::WallpaperGenerateRequest,
        _pricing: PricingSnapshot,
        _credential: Option<crate::ai::credential::ProviderCredential>,
        _cancellation: ProviderCancellation,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = WallpaperReply> + Send>> {
        Box::pin(async {
            WallpaperReply {
                output: Err("provider does not support wallpaper generation".to_string()),
                usage: None,
            }
        })
    }
}

/// Generation validity and billing are independent: even a rejected candidate
/// or provider error may carry trustworthy billable counters.
pub(crate) struct ProviderReply {
    pub intent: Result<Value, String>,
    pub usage: Option<TrustedUsage>,
}

pub(crate) struct CompletionReply {
    pub text: Result<String, String>,
    pub usage: Option<TrustedUsage>,
}

/// 壁纸结构化输出的 provider 回复：raw JSON 由合同层校验，校验失败按
/// invalid_output 结算，与舞台 intent 的失败语义一致。
pub(crate) struct WallpaperReply {
    pub output: Result<Value, String>,
    pub usage: Option<TrustedUsage>,
}

/// 生成能力注册项（§19.3）：队列/执行期限、输入上界与计费预留按能力
/// 注册；舞台继续使用 60/30 秒与原上界。
pub(crate) struct GenerationCapability {
    pub input_max_bytes: usize,
    pub queue_deadline_ms: i64,
    pub run_deadline_ms: i64,
    pub reservation_micro_usd: i64,
}

pub(crate) const WALLPAPER_CAPABILITY: &str = "wallpaper.generate";

pub(crate) fn generation_capability(name: &str) -> Option<&'static GenerationCapability> {
    const STAGE: GenerationCapability = GenerationCapability {
        input_max_bytes: MAX_INPUT_BYTES,
        queue_deadline_ms: QUEUE_DEADLINE_MS,
        run_deadline_ms: RUN_DEADLINE_MS,
        reservation_micro_usd: RESERVATION_MICRO_USD,
    };
    const WALLPAPER: GenerationCapability = GenerationCapability {
        input_max_bytes: hertz_wallpaper::generation::MAX_REQUEST_BYTES,
        queue_deadline_ms: QUEUE_DEADLINE_MS,
        run_deadline_ms: RUN_DEADLINE_MS,
        reservation_micro_usd: RESERVATION_MICRO_USD,
    };
    match name {
        CAPABILITY => Some(&STAGE),
        WALLPAPER_CAPABILITY => Some(&WALLPAPER),
        _ => None,
    }
}

/// 有界内存输入（§7.1 不持久化）：job_id → 输入 + 取消信号。舞台是 brief
/// 文本，壁纸是已通过合同层验证的结构化请求；重启即丢。
#[derive(Debug, Clone)]
pub(crate) enum GenerationInput {
    Stage(String),
    Wallpaper(hertz_wallpaper::generation::WallpaperGenerateRequest),
}

impl GenerationInput {
    /// 计费引用文本：舞台用 brief，壁纸用请求内的 brief。
    fn pricing_brief(&self) -> &str {
        match self {
            GenerationInput::Stage(brief) => brief,
            GenerationInput::Wallpaper(request) => &request.brief,
        }
    }

    /// 幂等输入指纹：舞台是 brief 字节，壁纸是规范化请求字节。
    fn input_bytes(&self) -> Vec<u8> {
        match self {
            GenerationInput::Stage(brief) => brief.clone().into_bytes(),
            GenerationInput::Wallpaper(request) => serde_json::to_vec(request).unwrap_or_default(),
        }
    }
}

struct RegisteredEvaluation {
    cancel: tokio::sync::watch::Sender<()>,
    credential_bound: bool,
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

    pub(crate) fn is_cancelled(&self) -> bool {
        self.0
            .as_ref()
            .is_some_and(|receiver| !matches!(receiver.has_changed(), Ok(false)))
    }
}

fn cancellation_pending(receiver: &tokio::sync::watch::Receiver<()>) -> bool {
    !matches!(receiver.has_changed(), Ok(false))
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

    fn supports_wallpaper_builtin(&self) -> bool {
        true
    }

    /// 确定性壁纸输出：使用用户选定的资格目录场景，参数走目录默认
    /// （空 params 合法）；产物必然通过自家合同校验，供本地联调与回归。
    fn generate_wallpaper_builtin(
        &self,
        request: &hertz_wallpaper::generation::WallpaperGenerateRequest,
        _pricing: PricingSnapshot,
        _credential: Option<crate::ai::credential::ProviderCredential>,
        _cancellation: ProviderCancellation,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = WallpaperReply> + Send>> {
        let scene_id = request.output.scene_id.clone();
        Box::pin(async move {
            let catalog = hertz_wallpaper::catalog();
            let Some(scene_id) = scene_id.filter(|id| catalog.scene(id).is_some()) else {
                return WallpaperReply {
                    output: Err("缺少有效的选定场景".into()),
                    usage: Some(TrustedUsage::free()),
                };
            };
            let state_version = catalog
                .scene(&scene_id)
                .and_then(|scene| scene.get("stateVersion"))
                .and_then(|value| value.as_u64())
                .unwrap_or(1) as u32;
            let output = json!({
                "kind": "builtin",
                "sceneId": scene_id,
                "stateVersion": state_version,
                "params": {},
            });
            WallpaperReply {
                output: Ok(output),
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
    /// 有界内存输入：job_id → [`GenerationInput`]。容量受排队容量上限约束
    /// （≤9 条），不落盘；提交后由服务端持有，HTTP waiter 消失不影响。
    inputs: Mutex<HashMap<String, (GenerationInput, tokio::sync::watch::Sender<()>)>>,
    /// Ephemeral evaluator calls share the model slot and consent cancellation
    /// path without becoming durable jobs or retaining briefs.
    evaluations: Mutex<HashMap<String, RegisteredEvaluation>>,
    provider: RwLock<Arc<dyn StageIntentProvider>>,
    /// 模型执行槽（§8.3）：每 DataDir 1 个受管执行——worker 先拿槽再
    /// accepted→running，等满 8 个停在 accepted。清理中的调用仍占槽。
    execution_slots: Arc<tokio::sync::Semaphore>,
    /// 壁纸生成 quote 内存态（§19.4）：重启即丢，不写任何持久层。
    wallpaper_quotes: Mutex<super::wallpaper_jobs::QuoteStore>,
    pub(super) wallpaper_pairings: Mutex<super::wallpaper_pairing::PendingStore>,
    pub(super) wallpaper_session_deadlines: Mutex<HashMap<String, std::time::Instant>>,
}

impl AiRuntime {
    #[cfg(test)]
    pub(super) fn with_test_provider(provider: Arc<dyn StageIntentProvider>) -> Self {
        let mut runtime = Self::new();
        runtime.provider = RwLock::new(provider);
        runtime
    }
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
            credentials: super::credential::Service::configured(config),
            inputs: Mutex::new(HashMap::new()),
            evaluations: Mutex::new(HashMap::new()),
            provider: RwLock::new(super::provider::configured(config)),
            execution_slots: Arc::new(tokio::sync::Semaphore::new(1)),
            wallpaper_quotes: Mutex::new(super::wallpaper_jobs::QuoteStore::default()),
            wallpaper_pairings: Mutex::new(super::wallpaper_pairing::PendingStore::default()),
            wallpaper_session_deadlines: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) async fn provider(&self) -> Arc<dyn StageIntentProvider> {
        self.provider.read().await.clone()
    }

    pub(crate) fn completion_slots(&self) -> Arc<tokio::sync::Semaphore> {
        self.execution_slots.clone()
    }

    pub(super) async fn discard_wallpaper_quotes(&self, principal: &str) {
        self.wallpaper_quotes.lock().await.discard(principal);
    }

    pub(crate) fn try_evaluation_slot(&self) -> Option<tokio::sync::OwnedSemaphorePermit> {
        self.execution_slots.clone().try_acquire_owned().ok()
    }

    pub(crate) async fn register_evaluation(
        &self,
        id: String,
        cancel: tokio::sync::watch::Sender<()>,
        credential_bound: bool,
    ) {
        self.evaluations.lock().await.insert(
            id,
            RegisteredEvaluation {
                cancel,
                credential_bound,
            },
        );
    }

    pub(crate) async fn remove_evaluation(&self, id: &str) {
        self.evaluations.lock().await.remove(id);
    }

    async fn cancel_evaluations(&self) {
        for evaluation in self.evaluations.lock().await.values() {
            let _ = evaluation.cancel.send(());
        }
    }

    async fn cancel_credential_evaluations(&self) {
        for evaluation in self.evaluations.lock().await.values() {
            if evaluation.credential_bound {
                let _ = evaluation.cancel.send(());
            }
        }
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
    pub failure_code: Option<String>,
    pub provider_http_status: Option<i64>,
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
    pub pricing_known: bool,
    pub reported_usage: Option<TrustedUsage>,
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
            failure_code: row.failure_code.clone(),
            provider_http_status: row.provider_http_status,
            usage: JobUsageView {
                accepted_month: utc_month_key(row.created_at),
                reservation_micro_usd: row.reservation_micro_usd,
                accounted_micro_usd: None,
                usage_state: "reserved".into(),
                usage_revision: 0,
                pricing_known: serde_json::from_str::<PricingSnapshot>(&row.pricing_snapshot)
                    .ok()
                    .is_some_and(|snapshot| snapshot.pricing_known()),
                reported_usage: None,
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
                accounted_micro_usd: (entry.usage_state != "unpriced")
                    .then_some(entry.accounted_micro_usd),
                usage_state: entry.usage_state,
                usage_revision: entry.revision,
                pricing_known: serde_json::from_str::<PricingSnapshot>(&entry.pricing_snapshot)
                    .ok()
                    .is_some_and(|snapshot| snapshot.pricing_known()),
                reported_usage: entry
                    .reported_usage
                    .as_deref()
                    .and_then(|usage| serde_json::from_str(usage).ok()),
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

fn input_hash(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
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
    let candidates = store::recovery_candidates(&state.db)
        .await
        .map_err(store_error)?;
    let now = now_ms();
    let mut events = Vec::new();
    let mut first_error = None;
    for candidate in candidates {
        let result: ApiResult<Option<String>> = async {
            let mut tx = vmusic_store::begin_immediate(&state.db)
                .await
                .map_err(store_error)?;
            let Some(job) = store::find_job_by_id(&mut *tx, &candidate.job_id)
                .await
                .map_err(store_error)?
            else {
                return Ok(None);
            };
            if !matches!(job.state.as_str(), "accepted" | "running") {
                return Ok(None);
            }
            // Each task's state transition and settlement stay atomic, while a
            // corrupt row or transient failure cannot roll back other recovery.
            if !store::cas_job_state(
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
                return Ok(None);
            }
            settle_on_terminal(&mut tx, &job, "interrupted").await?;
            tx.commit().await.map_err(sql_error)?;
            Ok(Some(job.job_id))
        }
        .await;
        match result {
            Ok(Some(event)) => events.push(event),
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(
                    "AI task recovery failed for {}: {}",
                    candidate.job_id,
                    error.code
                );
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }
    let mut recovered = events.len();
    for id in events {
        state.ai_runtime.inputs.lock().await.remove(&id);
        publish_task(state);
    }
    match drain_pending_usage(state).await {
        Ok(additional) => recovered += additional,
        Err(error) => {
            if first_error.is_none() {
                first_error = Some(error);
            }
        }
    }
    if let Some(error) = first_error {
        return Err(error);
    }
    if recovered > 0 {
        tracing::warn!("AI 恢复：{recovered} 个未完结任务收敛为 interrupted");
    }
    Ok(recovered)
}

async fn drain_pending_usage(state: &Arc<AppState>) -> ApiResult<usize> {
    let candidates = {
        let mut conn = state
            .db
            .acquire()
            .await
            .map_err(|error| store_error(StoreError::Database(error.to_string())))?;
        store::list_pending_usage(&mut conn, 1000)
            .await
            .map_err(store_error)?
    };
    let mut interrupted = 0;
    let mut first_error = None;
    for candidate in candidates {
        let result: ApiResult<Option<String>> = async {
            let mut tx = vmusic_store::begin_immediate(&state.db)
                .await
                .map_err(store_error)?;
            let Some(pending) = store::find_pending_usage(
                &mut tx,
                &candidate.job_id,
                &candidate.attempt_id,
            )
            .await
            .map_err(store_error)?
            else {
                return Ok(None);
            };
            let decoded = serde_json::from_str::<TrustedUsage>(&pending.usage_json)
                .map_err(|error| internal(format!("invalid pending trusted usage: {error}")))?;
            let Some(job) = store::find_job_by_id(&mut *tx, &pending.job_id)
                .await
                .map_err(store_error)?
            else {
                let Some(entry) = store::find_usage_entry(&mut *tx, &pending.job_id)
                    .await
                    .map_err(store_error)?
                else {
                    tracing::error!(job_id = %pending.job_id, "pending AI usage has neither task nor ledger");
                    return Ok(None);
                };
                if entry.owner_instance_id.as_deref()
                    != Some(pending.owner_instance_id.as_str())
                    || entry.attempt_id.as_deref() != Some(pending.attempt_id.as_str())
                {
                    return Ok(None);
                }
                let applied = usage::reconcile(
                    &mut tx,
                    &pending.owner_instance_id,
                    &pending.job_id,
                    &pending.attempt_id,
                    entry.revision,
                    &decoded,
                )
                .await?;
                if applied {
                    store::delete_pending_usage(
                        &mut *tx,
                        &pending.job_id,
                        &pending.attempt_id,
                    )
                    .await
                    .map_err(store_error)?;
                }
                tx.commit().await.map_err(sql_error)?;
                return Ok(None);
            };
            if job.owner_instance_id != pending.owner_instance_id
                || job.attempt_id.as_deref() != Some(pending.attempt_id.as_str())
            {
                return Ok(None);
            }
            let live_worker = state
                .ai_runtime
                .inputs
                .lock()
                .await
                .contains_key(&job.job_id);
            if live_worker && matches!(job.state.as_str(), "accepted" | "running") {
                return Ok(None);
            }
            let state_event = if matches!(job.state.as_str(), "accepted" | "running") {
                if !store::cas_job_state(
                    &mut *tx,
                    &job.job_id,
                    &job.state,
                    job.state_revision,
                    "interrupted",
                    now_ms(),
                )
                .await
                .map_err(store_error)?
                {
                    return Ok(None);
                }
                Some(job.job_id.clone())
            } else {
                None
            };
            usage::settle_terminal(&mut tx, &job, None, now_ms()).await?;
            tx.commit().await.map_err(sql_error)?;
            Ok(state_event)
        }
        .await;
        match result {
            Ok(Some(id)) => {
                interrupted += 1;
                state.ai_runtime.inputs.lock().await.remove(&id);
                publish_task(state);
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(
                    job_id = %candidate.job_id,
                    error = %error.code,
                    "pending AI usage settlement failed"
                );
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }
    if let Some(error) = first_error {
        return Err(error);
    }
    Ok(interrupted)
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
    let input = GenerationInput::Stage(brief.trim().to_string());
    let key = idempotency_key.map(str::to_string);
    tokio::spawn(async move {
        submit_owned(
            &state,
            &principal,
            input,
            CAPABILITY,
            key.as_deref(),
            None,
            None,
        )
        .await
    })
    .await
    .map_err(|e| internal(format!("AI acceptance failed: {e}")))?
}

async fn check_generation(conn: &mut sqlx::SqliteConnection, now: i64) -> ApiResult<()> {
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
    check_clock(conn, now).await
}

pub(crate) async fn generation_consent_enabled(state: &AppState) -> ApiResult<bool> {
    Ok(vmusic_store::settings::get(&state.db, CONSENT_KEY)
        .await
        .map_err(store_error)?
        .is_some_and(|value| value == Value::Bool(true)))
}

pub(crate) async fn check_clock(conn: &mut sqlx::SqliteConnection, now: i64) -> ApiResult<()> {
    if now.saturating_add(5 * 60_000)
        < store::accepted_watermark(&mut *conn)
            .await
            .map_err(store_error)?
    {
        return Err(ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "clock_skew",
            "系统时间明显回跳，AI 请求受理已暂停",
        ));
    }
    Ok(())
}

pub(crate) async fn check_history_capacity(
    conn: &mut sqlx::SqliteConnection,
    owner: &str,
) -> ApiResult<i64> {
    let (history_jobs, history_bytes) = store::ai_history_capacity(&mut *conn)
        .await
        .map_err(store_error)?;
    let pending = store::count_incomplete_jobs(&mut *conn, owner)
        .await
        .map_err(store_error)?;
    let projected_bytes = history_bytes.saturating_add(
        pending
            .saturating_add(1)
            .saturating_mul(HISTORY_TASK_HEADROOM_BYTES),
    );
    if history_jobs >= HISTORY_JOB_LIMIT || projected_bytes > HISTORY_BYTE_LIMIT {
        return Err(ApiError::new(
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            "history_capacity_exceeded",
            "AI 受保护记录或逻辑数据容量已满，请等待保留期结束",
        ));
    }
    Ok(pending)
}

pub(crate) async fn retain_history(db: &sqlx::SqlitePool, now: i64) -> ApiResult<()> {
    let mut tx = vmusic_store::begin_immediate(db)
        .await
        .map_err(store_error)?;
    let watermark = store::accepted_watermark(&mut tx)
        .await
        .map_err(store_error)?;
    if now.saturating_add(5 * 60_000) >= watermark {
        let month = utc_month_key(now);
        let year: i32 = month[..4]
            .parse()
            .map_err(|_| internal("invalid UTC month"))?;
        let month: i32 = month[5..]
            .parse()
            .map_err(|_| internal("invalid UTC month"))?;
        let index = year * 12 + month - 1 - 12;
        let cutoff = format!(
            "{:04}-{:02}",
            index.div_euclid(12),
            index.rem_euclid(12) + 1
        );
        store::retain_ai_history(&mut tx, now, now.saturating_sub(KEY_WINDOW_MS), &cutoff)
            .await
            .map_err(store_error)?;
    }
    tx.commit().await.map_err(sql_error)
}

async fn submit_owned(
    state: &Arc<AppState>,
    principal: &str,
    input: GenerationInput,
    capability: &'static str,
    idempotency_key: Option<&str>,
    quoted_pricing: Option<PricingSnapshot>,
    wallpaper_binding: Option<(&str, &str)>,
) -> ApiResult<SubmitOutcome> {
    let cap = generation_capability(capability).ok_or_else(|| bad_request("未注册的生成能力"))?;
    // 输入验证按 capability 走注册上界：舞台 brief 有界文本，壁纸请求已在
    // 合同层 parse 时全量校验，这里复验一次保持防御对称。
    match &input {
        GenerationInput::Stage(brief) => {
            let brief = brief.trim();
            if brief.is_empty() {
                return Err(bad_request("brief 不能为空"));
            }
            if brief.len() > cap.input_max_bytes {
                return Err(bad_request("brief 超过 16 KiB 上限"));
            }
        }
        GenerationInput::Wallpaper(request) => {
            if request.brief.len() > cap.input_max_bytes {
                return Err(bad_request("生成请求超过能力输入上限"));
            }
            request.validate().map_err(|error| {
                ApiError::new(
                    axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                    error.code,
                    error.message,
                )
            })?;
        }
    }
    let now = now_ms();
    let key = normalize_key(idempotency_key, now)?;
    let hash = input_hash(&input.input_bytes());
    // 幂等回放先于 provider 就绪检查（§7.1 顺序）：已存在任务的合法回放
    // 不依赖当前 provider——删除或更换模型后旧事实仍可查。
    if let Some(existing) = store::find_job_by_key(&state.db, principal, capability, &key)
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
    // Existing work remains replayable after the runner lock moves. Only new
    // admissions require this process to own the shared DataDir runner.
    if !state.ai_runner_held() {
        return Err(ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "ai_locked",
            "本进程未持有 AI runner 锁，生成受理停用",
        ));
    }
    // 实例身份先行（会创建 ai_instance 行），水位检查才有落点。
    let owner = instance_owner(state).await?;
    let provider = state.ai_runtime.provider().await;
    if !provider.ready() {
        return Err(ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "provider_unavailable",
            "生成 provider 当前不可用",
        ));
    }

    let quote = provider.quote(input.pricing_brief()).map_err(|reason| {
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
    let credential = if provider.requires_credential() {
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
    if quoted_pricing
        .as_ref()
        .is_some_and(|quoted| quoted != &pricing)
    {
        return Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "quote_pricing_changed",
            "报价或凭据已变化，请重新报价并确认",
        ));
    }
    // 计费预留上界按 capability 注册项收紧（§19.3）。
    if pricing.quote.reservation_micro_usd > cap.reservation_micro_usd {
        return Err(ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "pricing_over_bound",
            "quote 预留超出能力计费上界",
        ));
    }

    // 过期清扫先于容量检查：让可回收的名额先回来。
    sweep(state).await?;

    let mut tx = vmusic_store::begin_immediate(&state.db)
        .await
        .map_err(store_error)?;
    // 并发同键在唯一索引上兜底：查无此键的两个提交只有一个能插入。
    if let Some(existing) = store::find_job_by_key(&mut *tx, principal, capability, &key)
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
    let now = now_ms();
    if capability == WALLPAPER_CAPABILITY && principal != crate::idempotency::LOCAL_OWNER {
        super::wallpaper_pairing::require_transaction_time(
            state,
            &mut tx,
            principal,
            &owner,
            hertz_wallpaper::pairing::TASK_MS,
        )
        .await?;
    }
    check_generation(&mut tx, now).await?;
    let guard = store::ensure_budget_guard(&mut tx, &owner)
        .await
        .map_err(store_error)?;
    if pricing.pricing_known() && guard.halted {
        return Err(ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "budget_halted",
            "生成预算已触发熔断",
        ));
    }
    let pending = check_history_capacity(&mut tx, &owner).await?;
    if pending >= QUEUE_CAPACITY {
        return Err(ApiError::new(
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            "capacity_exceeded",
            "排队容量已满，请稍后重试",
        ));
    }
    if pricing.pricing_known() {
        store::reserve(
            &mut tx,
            &utc_month_key(now),
            pricing.quote.reservation_micro_usd,
            MONTHLY_LIMIT_MICRO_USD,
        )
        .await
        .map_err(|e| match e {
            StoreError::Database(ref detail) if detail.starts_with("budget_exceeded") => {
                ApiError::new(
                    axum::http::StatusCode::TOO_MANY_REQUESTS,
                    "budget_exceeded",
                    "本月生成预算已用尽",
                )
            }
            other => store_error(other),
        })?;
    } else {
        store::get_or_create_month(&mut tx, &utc_month_key(now))
            .await
            .map_err(store_error)?;
    }
    store::advance_watermark(&mut tx, &owner, now)
        .await
        .map_err(store_error)?;
    let job = store::JobRow {
        job_id: uuid::Uuid::new_v4().to_string(),
        owner_instance_id: owner.clone(),
        principal: principal.to_string(),
        capability: capability.to_string(),
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
        failure_code: None,
        provider_http_status: None,
    };
    if let Err(e) = store::insert_job(&mut *tx, &job).await {
        // 并发同键撞唯一索引：按回放/冲突如实收口，而不是 500。
        if matches!(&e, StoreError::Database(detail) if detail.contains("UNIQUE")) {
            if let Some(existing) =
                store::find_job_by_key(&mut *tx, principal, capability, &job.key)
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
    if let Some((quote_id, request_id)) = wallpaper_binding {
        sqlx::query(
            "INSERT INTO ai_wallpaper_submissions(job_id,quote_id,request_id) VALUES(?,?,?)",
        )
        .bind(&job.job_id)
        .bind(quote_id)
        .bind(request_id)
        .execute(&mut *tx)
        .await
        .map_err(sql_error)?;
    }
    // Serialize input handoff with cancellation cleanup, including the commit boundary.
    let mut inputs = state.ai_runtime.inputs.lock().await;
    if capability == WALLPAPER_CAPABILITY && principal != crate::idempotency::LOCAL_OWNER {
        super::wallpaper_pairing::require_transaction_time(
            state,
            &mut tx,
            principal,
            &owner,
            hertz_wallpaper::pairing::TASK_MS,
        )
        .await?;
    }
    tx.commit().await.map_err(sql_error)?;
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(());
    inputs.insert(job.job_id.clone(), (input, cancel_tx));
    drop(inputs);
    publish_task(state);
    let queue_deadline = tokio::time::Instant::now()
        + std::time::Duration::from_millis(cap.queue_deadline_ms as u64);
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

/// 任务状态变化已提交后发布无载荷提示，UI 再查询其有权访问的快照。
fn publish_task(state: &AppState) {
    state.publish(WsEvent::AiTasksResync);
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
        slot = state.ai_runtime.execution_slots.acquire() => match slot {
            Ok(slot) => slot,
            Err(error) => {
                tracing::error!("AI execution slot unavailable: {error:?}");
                interrupt_worker_failure(&state, &job_id).await;
                return;
            }
        },
        _ = cancelled.changed() => {
            cancel_worker_after_signal(&state, &job_id).await;
            return;
        },
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
    let loaded = match tokio::time::timeout_at(
        run_deadline,
        store::find_job_by_id(&state.db, &job_id),
    )
    .await
    {
        Ok(loaded) => loaded,
        Err(_) => {
            tracing::warn!("AI running task reload exceeded its execution deadline");
            finish_running(state.clone(), &job_id, "expired").await;
            state.ai_runtime.inputs.lock().await.remove(&job_id);
            return;
        }
    };
    let mut job = match loaded.map_err(store_error) {
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
    // 运行期限按 capability 注册项：上面的重载仍用原 deadline，调用段从这里
    // 重新起算。
    let run_deadline = tokio::time::Instant::now()
        + std::time::Duration::from_millis(
            generation_capability(&job.capability)
                .map(|capability| capability.run_deadline_ms)
                .unwrap_or(RUN_DEADLINE_MS) as u64,
        );
    publish_task(&state);
    let pricing: PricingSnapshot =
        match serde_json::from_str::<PricingSnapshot>(&job.pricing_snapshot) {
            Ok(pricing)
                if pricing.quote.validate().is_ok()
                    && pricing.provider == provider.id()
                    && pricing.model == provider.model()
                    && pricing.credential.is_some() == provider.requires_credential() =>
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
        let lease = tokio::time::timeout_at(
            run_deadline,
            state
                .ai_runtime
                .credentials
                .for_dispatch(&job.owner_instance_id, expected),
        )
        .await;
        match lease {
            Ok(Ok(lease)) => Some(lease),
            Err(_) => {
                tracing::warn!("AI credential lease exceeded its execution deadline");
                finish_running(state.clone(), &job_id, "expired").await;
                state.ai_runtime.inputs.lock().await.remove(&job_id);
                return;
            }
            Ok(Err(error)) => {
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
    let dispatch = tokio::time::timeout_at(run_deadline, async {
        let Ok(mut tx) = vmusic_store::begin_immediate(&state.db).await else {
            return Err("failed");
        };
        if tokio::time::Instant::now() >= run_deadline {
            return Err("expired");
        }
        if !provider.ready() {
            return Err("failed");
        }
        if let Err(error) = check_generation(&mut tx, now_ms()).await {
            tracing::warn!("AI dispatch blocked before send: {}", error.code);
            return Err("failed");
        }
        if job.capability == WALLPAPER_CAPABILITY
            && job.principal != crate::idempotency::LOCAL_OWNER
            && super::wallpaper_pairing::require_transaction_time(
                &state,
                &mut tx,
                &job.principal,
                &job.owner_instance_id,
                1,
            )
            .await
            .is_err()
        {
            return Err("cancelled");
        }
        let guard = match store::ensure_budget_guard(&mut tx, &job.owner_instance_id).await {
            Ok(guard) => guard,
            Err(_) => return Err("failed"),
        };
        if pricing.pricing_known() && guard.halted {
            return Err("failed");
        }
        let Ok(marked) = store::mark_dispatched(&mut *tx, &job_id, &attempt_id).await else {
            return Err("failed");
        };
        // 0 行 = 取消/过期已赢（或已派发过）：不能继续执行。
        if !marked {
            return Err("cancelled");
        }
        tx.commit().await.map_err(|_| "failed")?;
        Ok(true)
    })
    .await
    .unwrap_or(Err("expired"));
    if !matches!(dispatch, Ok(true)) {
        let terminal = match dispatch {
            Err("cancelled") => "cancelled",
            Err("expired") => "expired",
            _ => "failed",
        };
        if terminal == "cancelled" {
            cancel_worker_after_signal(&state, &job_id).await;
        } else {
            finish_running(state.clone(), &job_id, terminal).await;
            state.ai_runtime.inputs.lock().await.remove(&job_id);
        }
        return;
    }
    job.dispatch_state = "may_have_been_sent".into();
    job.attempt_id = Some(attempt_id.clone());
    let input = match tokio::time::timeout_at(run_deadline, async {
        state
            .ai_runtime
            .inputs
            .lock()
            .await
            .get(&job_id)
            .map(|entry| entry.0.clone())
    })
    .await
    {
        Ok(input) => input,
        Err(_) => {
            finish_running(state.clone(), &job_id, "expired").await;
            state.ai_runtime.inputs.lock().await.remove(&job_id);
            return;
        }
    };
    let Some(input) = input else {
        // 输入丢失（不应发生）：如实失败，按 unknown 结算。
        finish_running(state.clone(), &job_id, "failed").await;
        return;
    };

    let credential = credential.map(super::credential::Lease::into_secret);
    // Consent revocation can signal before its ledger transaction commits.
    // Settle cancellation before constructing any provider request.
    if cancellation_pending(&cancelled) {
        cancel_worker_after_signal(&state, &job_id).await;
        return;
    }

    // 一次调用；不自动修复、不自动重试。将终态信号交给 adapter 协作取消，
    // 不在外层 select 丢掉它；已完成 usage 的观察与资源结束仍由本任务负责。
    // 执行期限按 capability 注册项到点终止卡住的 future，按 expired 收敛。
    // §19.5：壁纸走结构化输出模式，不复用返回 StageIntent 的 generate()。
    enum ProviderCall {
        Stage(ProviderReply),
        Wallpaper(WallpaperReply),
    }
    let call: std::pin::Pin<Box<dyn std::future::Future<Output = ProviderCall> + Send>> =
        match (&input, job.capability.as_str()) {
            (GenerationInput::Stage(brief), CAPABILITY) => {
                let brief = brief.clone();
                let cancelled = cancelled.clone();
                Box::pin(async move {
                    ProviderCall::Stage(
                        provider
                            .generate(
                                brief,
                                pricing,
                                credential,
                                ProviderCancellation::from_receiver(cancelled),
                            )
                            .await,
                    )
                })
            }
            (GenerationInput::Wallpaper(request), WALLPAPER_CAPABILITY) => {
                let request = request.clone();
                let cancelled = cancelled.clone();
                Box::pin(async move {
                    ProviderCall::Wallpaper(
                        provider
                            .generate_wallpaper_builtin(
                                &request,
                                pricing,
                                credential,
                                ProviderCancellation::from_receiver(cancelled),
                            )
                            .await,
                    )
                })
            }
            _ => {
                // 能力与输入不匹配（不应发生）：如实失败，按 unknown 结算。
                finish_running_with_failure_code(
                    state.clone(),
                    &job_id,
                    "failed",
                    None,
                    "invalid_input",
                )
                .await;
                state.ai_runtime.inputs.lock().await.remove(&job_id);
                return;
            }
        };
    let outcome = match tokio::time::timeout_at(run_deadline, call).await {
        Ok(outcome) => outcome,
        Err(_) => {
            tracing::warn!("AI provider 调用超过执行期限，已终止");
            finish_running(state.clone(), &job.job_id, "expired").await;
            state.ai_runtime.inputs.lock().await.remove(&job_id);
            return;
        }
    };
    let (raw_output, trusted_usage) = match outcome {
        ProviderCall::Stage(reply) => (reply.intent, reply.usage),
        ProviderCall::Wallpaper(reply) => (reply.output, reply.usage),
    };
    if let Some(usage) = trusted_usage.as_ref() {
        if let Err(error) = usage::persist_pending_usage(&state.db, &job, usage).await {
            tracing::warn!(
                job_id = %job.job_id,
                error = %error.code,
                "trusted AI usage could not be staged"
            );
        }
    }
    if cancellation_pending(&cancelled) {
        finish_running_with_usage(state.clone(), &job_id, "cancelled", trusted_usage.as_ref())
            .await;
        state.ai_runtime.inputs.lock().await.remove(&job_id);
        return;
    }
    match raw_output {
        Ok(value) => {
            // 输出校验按 capability 走合同层：舞台沿 intent/artifact 合同，
            // 壁纸输出经 generation.rs 的 BuiltinSceneOutput 全量校验后再落
            // proposal，两类都不 clamp。
            let validated: Result<(&'static str, String), String> =
                match (&input, job.capability.as_str()) {
                    (GenerationInput::Stage(_), CAPABILITY) => validate_intent(&value)
                        .and_then(|_| {
                            contract::validate_artifact(&contract::artifact(&value)).map(|_| ())
                        })
                        .map(|_| ("artifact:1", contract::artifact(&value).to_string())),
                    (GenerationInput::Wallpaper(request), WALLPAPER_CAPABILITY) => {
                        match serde_json::to_vec(&value) {
                            Ok(bytes) => {
                                match super::wallpaper_jobs::validate_builtin_output(
                                    request, &bytes,
                                ) {
                                    Ok(output) => match serde_json::to_string(&output) {
                                        Ok(payload) => Ok(("wallpaper.builtin:1", payload)),
                                        Err(error) => Err(format!("输出序列化失败: {error}")),
                                    },
                                    Err(error) => Err(error),
                                }
                            }
                            Err(error) => Err(format!("输出序列化失败: {error}")),
                        }
                    }
                    _ => Err("capability 与输入不匹配".to_string()),
                };
            match validated {
                Ok((proposal_schema, proposal_payload)) => {
                    // 事务顺序即事实顺序：先 CAS 终态，赢了才落提案——否则
                    // 「已取消的任务留下可读提案」。CAS 输掉时只处理独立的
                    // 迟到 usage；不能复活任务或创建提案。
                    let result = async {
                        let proposal_id = uuid::Uuid::new_v4().to_string();
                        let now = now_ms();
                        let mut tx = vmusic_store::begin_immediate(&state.db)
                            .await
                            .map_err(store_error)?;
                        if let Err(error) = check_generation(&mut tx, now).await {
                            if error.code != "generation_disabled" {
                                return Err(error);
                            }
                            let cancelled = store::cas_job_state(
                                &mut *tx,
                                &job.job_id,
                                "running",
                                job.state_revision,
                                "cancelled",
                                now,
                            )
                            .await
                            .map_err(store_error)?;
                            tx.commit().await.map_err(sql_error)?;
                            if cancelled {
                                publish_task(&state);
                            }
                            return Ok::<(), ApiError>(());
                        }
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
                            tx.commit().await.map_err(sql_error)?;
                            return Ok::<(), ApiError>(());
                        }
                        let proposal = store::ProposalRow {
                            proposal_id: proposal_id.clone(),
                            job_id: job.job_id.clone(),
                            validated_intent: proposal_payload,
                            schema_version: proposal_schema.into(),
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
                        tx.commit().await.map_err(sql_error)?;
                        publish_task(&state);
                        Ok(())
                    }
                    .await;
                    if let Err(error) = result {
                        tracing::error!("AI result transaction failed: {error:?}");
                        finish_running_with_usage(
                            state.clone(),
                            &job_id,
                            "failed",
                            trusted_usage.as_ref(),
                        )
                        .await;
                    } else {
                        settle_terminal_after_commit(&state, &job.job_id, trusted_usage.as_ref())
                            .await;
                    }
                }
                Err(reason) => {
                    tracing::warn!("AI 输出校验失败: {reason}");
                    finish_running_with_failure_code(
                        state.clone(),
                        &job_id,
                        "failed",
                        trusted_usage.as_ref(),
                        "invalid_output",
                    )
                    .await;
                }
            }
        }
        Err(reason) => {
            tracing::warn!("AI provider 调用失败: {reason}");
            finish_running_with_provider_error(
                state.clone(),
                &job.job_id,
                "failed",
                trusted_usage.as_ref(),
                &reason,
            )
            .await;
        }
    }
    state.ai_runtime.inputs.lock().await.remove(&job_id);
}

async fn settle_terminal_after_commit(
    state: &Arc<AppState>,
    job_id: &str,
    trusted_usage: Option<&TrustedUsage>,
) {
    let deadline =
        tokio::time::Instant::now() + std::time::Duration::from_millis(TERMINAL_CLEANUP_TIMEOUT_MS);
    let result = tokio::time::timeout_at(deadline, async {
        let mut tx = vmusic_store::begin_immediate(&state.db)
            .await
            .map_err(store_error)?;
        let Some(job) = store::find_job_by_id(&mut *tx, job_id)
            .await
            .map_err(store_error)?
        else {
            return Ok::<(), ApiError>(());
        };
        if !matches!(
            job.state.as_str(),
            "succeeded" | "cancelled" | "failed" | "expired" | "interrupted"
        ) {
            return Ok(());
        }
        usage::settle_terminal(&mut tx, &job, trusted_usage, now_ms()).await?;
        tx.commit().await.map_err(sql_error)
    })
    .await;
    match result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => tracing::warn!(
            job_id = %job_id,
            error = %error.code,
            "AI task result was committed; usage settlement is deferred"
        ),
        Err(_) => tracing::warn!(
            job_id = %job_id,
            "AI task result was committed; usage settlement exceeded its cleanup deadline"
        ),
    }
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
            publish_task(state);
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
    let failure_code = (to == "failed").then_some("internal_error");
    finish_running_with_failure(state, job_id, to, trusted_usage, failure_code).await;
}

async fn finish_running_with_failure_code(
    state: Arc<AppState>,
    job_id: &str,
    to: &str,
    trusted_usage: Option<&TrustedUsage>,
    failure_code: &'static str,
) {
    finish_running_with_failure(state, job_id, to, trusted_usage, Some(failure_code)).await;
}

async fn finish_running_with_provider_error(
    state: Arc<AppState>,
    job_id: &str,
    to: &str,
    trusted_usage: Option<&TrustedUsage>,
    reason: &str,
) {
    let status = super::provider::provider_http_status(reason);
    finish_running_with_failure_details(
        state,
        job_id,
        to,
        trusted_usage,
        Some("provider_error"),
        status,
    )
    .await;
}

async fn finish_running_with_failure(
    state: Arc<AppState>,
    job_id: &str,
    to: &str,
    trusted_usage: Option<&TrustedUsage>,
    failure_code: Option<&str>,
) {
    finish_running_with_failure_details(state, job_id, to, trusted_usage, failure_code, None).await;
}

async fn finish_running_with_failure_details(
    state: Arc<AppState>,
    job_id: &str,
    to: &str,
    trusted_usage: Option<&TrustedUsage>,
    failure_code: Option<&str>,
    provider_http_status: Option<u16>,
) {
    let deadline =
        tokio::time::Instant::now() + std::time::Duration::from_millis(TERMINAL_CLEANUP_TIMEOUT_MS);
    let result = tokio::time::timeout_at(deadline, async {
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
        if won {
            if let Some(code) = failure_code {
                store::set_job_failure_details(&mut *tx, job_id, code, provider_http_status)
                    .await
                    .map_err(store_error)?;
            }
        }
        if !won && trusted_usage.is_none() {
            return Ok(());
        }
        // A cancelled/expired task stays terminal. Only its usage may advance.
        usage::settle_terminal(&mut tx, &job, trusted_usage, now_ms()).await?;
        tx.commit().await.map_err(sql_error)?;
        if won {
            publish_task(&state);
        }
        Ok(())
    })
    .await;
    match result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            tracing::error!(
                "AI terminal settlement failed; attempting conservative interruption: {error:?}"
            );
            interrupt_worker_failure_until(&state, job_id, deadline).await;
        }
        Err(_) => {
            tracing::error!(
                job_id = %job_id,
                "AI terminal settlement exceeded its cleanup deadline"
            );
            interrupt_worker_failure_until(&state, job_id, deadline).await;
        }
    }
}

/// A cancellation signal may arrive before the revoker's ledger transaction
/// commits. The worker retries the same cancelled transition so a transient
/// settlement failure cannot strand accepted/running work without an owner.
async fn cancel_worker_after_signal(state: &Arc<AppState>, job_id: &str) {
    let deadline =
        tokio::time::Instant::now() + std::time::Duration::from_millis(TERMINAL_CLEANUP_TIMEOUT_MS);
    let attempts = TERMINAL_SETTLEMENT_RETRY_DELAYS_MS.len() + 1;
    let settlement = async {
        for (attempt, retry_delay_ms) in TERMINAL_SETTLEMENT_RETRY_DELAYS_MS
            .iter()
            .copied()
            .map(Some)
            .chain(std::iter::once(None))
            .enumerate()
        {
            match cancel_worker_once(state, job_id).await {
                Ok(()) => break,
                Err(error) => match retry_delay_ms {
                    Some(delay_ms) => {
                        tracing::warn!(
                            attempt = attempt + 1,
                            total_attempts = attempts,
                            retry_in_ms = delay_ms,
                            "AI cancellation settlement failed; retrying: {error:?}"
                        );
                        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                    }
                    None => tracing::error!(
                        attempt = attempt + 1,
                        total_attempts = attempts,
                        "AI cancellation settlement failed; task remains recoverable: {error:?}"
                    ),
                },
            }
        }
    };
    if tokio::time::timeout_at(deadline, settlement).await.is_err() {
        tracing::error!(
            job_id = %job_id,
            "AI cancellation settlement exceeded its cleanup deadline; task remains recoverable"
        );
    }
    state.ai_runtime.inputs.lock().await.remove(job_id);
}

async fn cancel_worker_once(state: &Arc<AppState>, job_id: &str) -> ApiResult<()> {
    let mut tx = vmusic_store::begin_immediate(&state.db)
        .await
        .map_err(store_error)?;
    let Some(job) = store::find_job_by_id(&mut *tx, job_id)
        .await
        .map_err(store_error)?
    else {
        return Ok(());
    };
    if !matches!(job.state.as_str(), "accepted" | "running") {
        return Ok(());
    }
    if !store::cas_job_state(
        &mut *tx,
        job_id,
        &job.state,
        job.state_revision,
        "cancelled",
        now_ms(),
    )
    .await
    .map_err(store_error)?
    {
        return Ok(());
    }
    usage::settle_terminal(&mut tx, &job, None, now_ms()).await?;
    tx.commit().await.map_err(sql_error)?;
    publish_task(state);
    Ok(())
}

/// A worker that can no longer make progress must persist an interrupted state
/// and settle from the durable dispatch marker before releasing its input. A
/// short bounded retry handles transient SQLite failures without orphaning the
/// task until its normal expiry sweep.
async fn interrupt_worker_failure(state: &Arc<AppState>, job_id: &str) {
    let deadline =
        tokio::time::Instant::now() + std::time::Duration::from_millis(TERMINAL_CLEANUP_TIMEOUT_MS);
    interrupt_worker_failure_until(state, job_id, deadline).await;
}

async fn interrupt_worker_failure_until(
    state: &Arc<AppState>,
    job_id: &str,
    deadline: tokio::time::Instant,
) {
    let attempts = TERMINAL_SETTLEMENT_RETRY_DELAYS_MS.len() + 1;
    let settlement = async {
        for (attempt, retry_delay_ms) in TERMINAL_SETTLEMENT_RETRY_DELAYS_MS
            .iter()
            .copied()
            .map(Some)
            .chain(std::iter::once(None))
            .enumerate()
        {
            match interrupt_worker_failure_once(state, job_id).await {
                Ok(()) => break,
                Err(error) => match retry_delay_ms {
                    Some(delay_ms) => {
                        tracing::warn!(
                            attempt = attempt + 1,
                            total_attempts = attempts,
                            retry_in_ms = delay_ms,
                            "AI worker interruption settlement failed; retrying: {error:?}"
                        );
                        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                    }
                    None => tracing::error!(
                        attempt = attempt + 1,
                        total_attempts = attempts,
                        "AI worker interruption settlement failed; leaving facts recoverable: {error:?}"
                    ),
                },
            }
        }
    };
    if tokio::time::timeout_at(deadline, settlement).await.is_err() {
        tracing::error!(
            job_id = %job_id,
            "AI worker interruption settlement exceeded its cleanup deadline; task remains recoverable"
        );
    }
    state.ai_runtime.inputs.lock().await.remove(job_id);
}

async fn interrupt_worker_failure_once(state: &Arc<AppState>, job_id: &str) -> ApiResult<()> {
    let mut tx = vmusic_store::begin_immediate(&state.db)
        .await
        .map_err(store_error)?;
    let Some(job) = store::find_job_by_id(&mut *tx, job_id)
        .await
        .map_err(store_error)?
    else {
        return Ok(());
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
    usage::settle_terminal_unknown(&mut tx, &job, now_ms()).await?;
    tx.commit().await.map_err(sql_error)?;
    publish_task(state);
    Ok(())
}

/// 取消：expectedStateRevision 下的 CAS 竞争；赢家负责结算与输入清理。
pub(crate) async fn cancel(
    state: &Arc<AppState>,
    principal: &str,
    job_id: &str,
    expected_state_revision: i64,
) -> ApiResult<JobView> {
    if !state.ai_runner_held() {
        return Err(ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "ai_locked",
            "本进程未持有 AI runner 锁",
        ));
    }
    if let Err(error) = sweep(state).await {
        tracing::warn!(
            "AI task sweep failed before cancellation of {}: {}",
            job_id,
            error.code
        );
    }
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
    publish_task(state);
    state.ai_runtime.inputs.lock().await.remove(job_id);
    let mut view = JobView::with_usage(&job, &state.db).await?;
    view.state = "cancelled".into();
    view.state_revision = job.state_revision + 1;
    Ok(view)
}

/// Consent revocation is a task cancellation, not merely an admission flag.
/// Settle each official generation task from its durable dispatch marker, then
/// drop its input sender so an in-flight provider observes cancellation.
pub(crate) async fn revoke_generation_consent(state: &Arc<AppState>) -> ApiResult<()> {
    if !state.ai_runner_held() {
        return Err(ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "ai_locked",
            "请在持有 AI 服务锁的 Hertz 实例中撤回生成同意",
        ));
    }
    // Settings have already been persisted by the caller. Signal workers before
    // fallible ledger work, but keep their owner markers until settlement or
    // worker cleanup completes so a concurrent lazy sweep cannot steal the CAS.
    {
        let inputs = state.ai_runtime.inputs.lock().await;
        for (_, cancel) in inputs.values() {
            let _ = cancel.send(());
        }
    }
    state.ai_runtime.cancel_evaluations().await;
    let owner = instance_owner(state).await?;
    let mut tx = vmusic_store::begin_immediate(&state.db)
        .await
        .map_err(store_error)?;
    let candidates = store::recovery_candidates(&mut *tx)
        .await
        .map_err(store_error)?;
    let mut events = Vec::new();
    for job in candidates {
        if job.owner_instance_id != owner || generation_capability(&job.capability).is_none() {
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
            events.push(job.job_id);
        }
    }
    tx.commit().await.map_err(sql_error)?;
    let mut inputs = state.ai_runtime.inputs.lock().await;
    for id in events {
        inputs.remove(&id);
        publish_task(state);
    }
    Ok(())
}

/// The lifecycle owner holds admission closed while this transaction reads
/// fresh revisions, signals workers, and settles all of this principal's jobs.
pub(super) async fn cancel_principal_jobs(state: &Arc<AppState>, principal: &str) -> ApiResult<()> {
    let mut tx = vmusic_store::begin_immediate(&state.db)
        .await
        .map_err(store_error)?;
    let candidates = store::recovery_candidates(&mut *tx)
        .await
        .map_err(store_error)?;
    let jobs: Vec<_> = candidates
        .into_iter()
        .filter(|job| job.principal == principal && job.capability == WALLPAPER_CAPABILITY)
        .collect();
    {
        let inputs = state.ai_runtime.inputs.lock().await;
        for job in &jobs {
            if let Some((_, sender)) = inputs.get(&job.job_id) {
                let _ = sender.send(());
            }
        }
    }
    for job in &jobs {
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
            settle_on_terminal(&mut tx, job, "cancelled").await?;
        }
    }
    tx.commit().await.map_err(sql_error)?;
    let mut inputs = state.ai_runtime.inputs.lock().await;
    for job in jobs {
        inputs.remove(&job.job_id);
        publish_task(state);
    }
    Ok(())
}

/// Called under the credential service's exclusive lifecycle guard, before OS
/// mutation. Conservative cancellation also applies when the OS write fails.
pub(super) async fn invalidate_credentials(state: &Arc<AppState>, owner: &str) -> ApiResult<()> {
    state.ai_runtime.cancel_credential_evaluations().await;
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
            events.push(job.job_id);
        }
    }
    tx.commit().await.map_err(sql_error)?;
    for id in events {
        state.ai_runtime.inputs.lock().await.remove(&id);
        publish_task(state);
    }
    Ok(())
}

/// 惰性清扫（submit/cancel/查询入口触发），无后台定时器。超期任务转为 expired；
/// 仍未超期但已没有本进程 worker owner 的任务转为 interrupted。
pub(super) async fn sweep(state: &Arc<AppState>) -> ApiResult<()> {
    // Only the runner can know which persisted tasks still have live workers
    // and cancellation senders in this process. Non-runners keep query paths
    // read-only instead of expiring another process's active work.
    if !state.ai_runner_held() {
        return Ok(());
    }
    let now = now_ms();
    let queue_cutoff = now - QUEUE_DEADLINE_MS;
    let run_cutoff = now - RUN_DEADLINE_MS;
    let candidates = store::recovery_candidates(&state.db)
        .await
        .map_err(store_error)?;
    let mut events = Vec::new();
    let mut first_error = None;
    for job in candidates {
        let result: ApiResult<Option<String>> = async {
            let mut tx = vmusic_store::begin_immediate(&state.db)
                .await
                .map_err(store_error)?;
            let Some(job) = store::find_job_by_id(&mut *tx, &job.job_id)
                .await
                .map_err(store_error)?
            else {
                return Ok(None);
            };
            let is_expired = match job.state.as_str() {
                "accepted" => job.created_at < queue_cutoff,
                "running" => job.updated_at < run_cutoff,
                _ => return Ok(None),
            };
            // Submission commits the row and inserts the owner while holding
            // this lock, so a recent task without an owner is a stranded worker.
            if state
                .ai_runtime
                .inputs
                .lock()
                .await
                .contains_key(&job.job_id)
            {
                return Ok(None);
            }
            let next_state = if is_expired { "expired" } else { "interrupted" };
            if !store::cas_job_state(
                &mut *tx,
                &job.job_id,
                &job.state,
                job.state_revision,
                next_state,
                now,
            )
            .await
            .map_err(store_error)?
            {
                return Ok(None);
            }
            settle_on_terminal(&mut tx, &job, next_state).await?;
            tx.commit().await.map_err(sql_error)?;
            Ok(Some(job.job_id))
        }
        .await;
        match result {
            Ok(Some(event)) => events.push(event),
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(
                    "AI orphan task sweep failed for {}: {}",
                    job.job_id,
                    error.code
                );
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }
    match drain_pending_usage(state).await {
        Ok(_) => {}
        Err(error) => {
            tracing::warn!("AI pending usage sweep failed: {}", error.code);
            if first_error.is_none() {
                first_error = Some(error);
            }
        }
    }
    let retention_result = retain_history(&state.db, now).await;
    if let Err(error) = retention_result {
        tracing::warn!("AI history retention failed: {}", error.code);
        if first_error.is_none() {
            first_error = Some(error);
        }
    }
    for _ in events {
        publish_task(state);
    }
    if let Some(error) = first_error {
        return Err(error);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

async fn sweep_before_query(state: &Arc<AppState>, query: &'static str) {
    if let Err(error) = sweep(state).await {
        tracing::warn!(
            "AI task sweep failed before {} query: {}",
            query,
            error.code
        );
    }
}

pub(crate) async fn get_job(
    state: &Arc<AppState>,
    principal: &str,
    job_id: &str,
) -> ApiResult<JobView> {
    sweep_before_query(state, "get job").await;
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
    sweep_before_query(state, "list jobs").await;
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
        let expired =
            store::cas_proposal_state(&state.db, proposal_id, proposal.revision, "expired")
                .await
                .map_err(store_error)?;
        if expired {
            publish_task(state);
        }
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
    publish_task(state);
    view.state = "rejected".into();
    view.revision = expected_revision + 1;
    Ok(view)
}

/// 熔断复位（官方管理专用，§8.4）：revision、无在飞调用、无未完任务
/// 与当前月预算健康度均由服务端检查，并与复位原子提交。
pub(crate) async fn budget_guard_reset(
    state: &Arc<AppState>,
    expected_revision: i64,
    expected_config_fingerprint: &str,
) -> ApiResult<Value> {
    if !state.ai_runner_held() {
        return Err(ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "ai_locked",
            "本进程未持有 AI runner 锁",
        ));
    }
    if expected_config_fingerprint.len() != 64
        || !expected_config_fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(bad_request("config_fingerprint 必须是小写 SHA-256"));
    }
    let provider = state.ai_runtime.provider().await;
    let config_fingerprint = guard_reset_fingerprint(provider.as_ref()).map_err(|_| {
        ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "configuration_unavailable",
            "当前 provider 配置尚不可核对，请先修复配置并刷新状态",
        )
    })?;
    if config_fingerprint != expected_config_fingerprint {
        return Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "configuration_changed",
            "provider 或有效价格配置已变化，请刷新状态后重新确认",
        ));
    }
    let owner = instance_owner(state).await?;
    let mut tx = vmusic_store::begin_immediate(&state.db)
        .await
        .map_err(store_error)?;
    let guard = store::ensure_budget_guard(&mut tx, &owner)
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
    if guard.halted
        && budget
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
    let audit_id = uuid::Uuid::new_v4().to_string();
    store::insert_budget_guard_reset_audit(
        &mut *tx,
        &audit_id,
        &owner,
        expected_revision,
        &config_fingerprint,
        now_ms(),
    )
    .await
    .map_err(store_error)?;
    tx.commit().await.map_err(sql_error)?;
    let guard = store::budget_guard(&state.db).await.map_err(store_error)?;
    Ok(json!({
        "halted": guard.as_ref().map(|g| g.halted).unwrap_or(false),
        "tokenHalted": guard.as_ref().map(|g| g.token_halted).unwrap_or(false),
        "revision": guard.as_ref().map(|g| g.revision).unwrap_or(0),
        "auditId": audit_id,
    }))
}

fn guard_reset_fingerprint(provider: &dyn StageIntentProvider) -> Result<String, String> {
    let quote = provider.quote("")?;
    quote.validate().map_err(str::to_owned)?;
    let material = serde_json::to_vec(&(
        provider.id(),
        provider.model(),
        provider.endpoint_identity(),
        provider.requires_credential(),
        quote,
    ))
    .map_err(|error| error.to_string())?;
    Ok(format!("{:x}", Sha256::digest(material)))
}

/// 状态摘要（官方 UI 的 `GET /v1/ai/status`）。
pub(crate) async fn status(state: &Arc<AppState>, owner: &str) -> ApiResult<Value> {
    sweep_before_query(state, "status").await;
    let provider = state.ai_runtime.provider().await;
    let reset_fingerprint = guard_reset_fingerprint(provider.as_ref()).ok();
    let pricing_mode = match provider.quote("") {
        Ok(quote) if quote.validate().is_ok() => {
            if quote.pricing_version == usage::TOKEN_ONLY_PRICING_VERSION {
                "token_only"
            } else {
                "metered"
            }
        }
        _ => "unavailable",
    };
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
            "diagnostic": provider.diagnostic(), "pricingMode": pricing_mode,
            "resetConfigFingerprint": reset_fingerprint },
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
            "tokenHalted": guard.token_halted,
            "tokenReason": guard.token_reason,
            "tokenTriggerJob": guard.token_trigger_job,
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

// ---------------------------------------------------------------------------
// 壁纸生成（AI-02 切片 2）：capability snapshot、quote 与 submit
// （§19.3/§19.4）。短会话配对（§19.2）属后续切片，当前走官方 UI 的
// local-owner 直连路径。
// ---------------------------------------------------------------------------

pub(crate) async fn wallpaper_capabilities(
    state: &Arc<AppState>,
) -> ApiResult<super::wallpaper_jobs::CapabilitySnapshot> {
    Ok(super::wallpaper_jobs::capability_snapshot(state).await)
}

/// 本地编码/计价（§19.4）：不发 provider 网络请求。schema 哈希、能力快照与
/// builtin 的场景目录哈希都必须与当前服务版本一致，不做静默降级。
pub(crate) async fn wallpaper_quote(
    state: &Arc<AppState>,
    principal: &str,
    bytes: &[u8],
) -> ApiResult<serde_json::Value> {
    let _grant = if principal != crate::idempotency::LOCAL_OWNER {
        let guard = super::facade::grant_lifecycle().lock().await;
        super::wallpaper_pairing::require_time(state, principal).await?;
        Some(guard)
    } else {
        None
    };
    let request =
        hertz_wallpaper::generation::WallpaperGenerateRequest::parse(bytes).map_err(|error| {
            ApiError::new(
                axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                error.code,
                error.message,
            )
        })?;
    let snapshot = super::wallpaper_jobs::capability_snapshot(state).await;
    if request.generation_schema_hash != snapshot.generation_schema_hash {
        return Err(ApiError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "generation_schema_mismatch",
            "生成合同 schema 与当前服务版本不一致",
        ));
    }
    if request.capability_snapshot_id != snapshot.snapshot_id {
        return Err(ApiError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "capability_snapshot_stale",
            "能力快照已过期，请重新读取能力目录",
        ));
    }
    if request.output.kind == hertz_wallpaper::generation::WallpaperGenerationKind::Builtin
        && request.registry_hash != snapshot.registry_hash
    {
        return Err(ApiError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "registry_mismatch",
            "场景目录注册哈希与当前服务不一致",
        ));
    }
    let provider = state.ai_runtime.provider().await;
    if !provider.ready() || !provider.supports_wallpaper_builtin() {
        return Err(ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "provider_unavailable",
            "壁纸生成 provider 当前不可用",
        ));
    }
    let quote = provider.quote(&request.brief).map_err(|reason| {
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
    let owner = instance_owner(state).await?;
    let credential = if provider.requires_credential() {
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
    let now = now_ms();
    let request_digest = input_hash(&GenerationInput::Wallpaper(request.clone()).input_bytes());
    let quote_id = uuid::Uuid::new_v4().to_string();
    let expires_at = state.ai_runtime.wallpaper_quotes.lock().await.insert(
        principal,
        quote_id.clone(),
        request,
        request_digest,
        super::wallpaper_jobs::ProviderQuote {
            pricing: pricing.clone(),
            endpoint_identity: provider.endpoint_identity().map(str::to_owned),
        },
        now,
    )?;
    Ok(json!({
        "quoteId": quote_id,
        "expiresAt": expires_at,
        "snapshotId": snapshot.snapshot_id,
        "provider": pricing.provider,
        "model": pricing.model,
        "reservationMicroUsd": pricing.quote.reservation_micro_usd,
        "pricingKnown": pricing.pricing_known(),
        "pricingMode": if pricing.quote.pricing_version=="fake-free-v1" {"free"} else if pricing.pricing_known() {"metered"} else {"token-only"},
        "maximumCostMicroUsd": if pricing.quote.pricing_version=="fake-free-v1" {Some(0)} else if pricing.pricing_known() {Some(pricing.quote.reservation_micro_usd)} else {None},
        "maxInputTokens": pricing.quote.max_input_tokens,
        "maxOutputTokens": pricing.quote.max_output_tokens,
        "endpointLabel": provider.endpoint_identity().and_then(|endpoint|reqwest::Url::parse(endpoint).ok()).map(|url|format!("{}://{}:{}",url.scheme(),url.host_str().unwrap_or(""),url.port_or_known_default().unwrap_or(0))).unwrap_or_else(||"本地离线 fixture".into()),
        "dataScope": "仅本次描述与所选内置场景的参数合同",
        "maximumWaitSeconds": 90,
    }))
}

/// quote 消费与幂等（§19.4）：submit 只引用 quoteId 与 requestId。未消费
/// quote 先乐观标记（并发同 quote 只有一个受理），受理失败还原为未消费；
/// 已消费 quote 仅允许同键同载荷回放原 job，不能创建第二个任务。
pub(crate) async fn wallpaper_submit(
    state: &Arc<AppState>,
    principal: &str,
    quote_id: &str,
    request_id: &str,
    idempotency_key: Option<&str>,
) -> ApiResult<SubmitOutcome> {
    let state = state.clone();
    let principal = principal.to_owned();
    let quote_id = quote_id.to_owned();
    let request_id = request_id.to_owned();
    let key = idempotency_key.map(str::to_owned);
    // Observer cancellation must not release authority while admission continues.
    tokio::spawn(async move {
        wallpaper_submit_owned(&state, &principal, &quote_id, &request_id, key.as_deref()).await
    })
    .await
    .map_err(|e| internal(format!("AI acceptance failed: {e}")))?
}

async fn wallpaper_submit_owned(
    state: &Arc<AppState>,
    principal: &str,
    quote_id: &str,
    request_id: &str,
    idempotency_key: Option<&str>,
) -> ApiResult<SubmitOutcome> {
    // Quote consumption and receipt recovery share one lifecycle for both the
    // official owner and grants; concurrent quotes cannot bypass exact binding.
    let _grant = super::facade::grant_lifecycle().lock().await;
    if principal != crate::idempotency::LOCAL_OWNER {
        let row = vmusic_store::ai::find_grant_by_id(&state.db, principal)
            .await
            .map_err(store_error)?
            .ok_or_else(crate::error::unauthorized)?;
        super::wallpaper_pairing::validate_grant(state, &row).await?;
    }
    let now = now_ms();
    let key = normalize_key(idempotency_key, now)?;
    // An accepted receipt outlives its quote. Recover only the exact submission
    // in this principal; this path cannot create a job or call a provider.
    if let Some(job) = store::find_job_by_key(&state.db, principal, WALLPAPER_CAPABILITY, &key)
        .await
        .map_err(store_error)?
    {
        let binding: Option<(String, String)> = sqlx::query_as(
            "SELECT quote_id,request_id FROM ai_wallpaper_submissions WHERE job_id=?",
        )
        .bind(&job.job_id)
        .fetch_optional(&state.db)
        .await
        .map_err(sql_error)?;
        if binding
            .as_ref()
            .is_some_and(|(q, r)| q == quote_id && r == request_id)
        {
            return Ok(SubmitOutcome::Replayed {
                job: JobView::with_usage(&job, &state.db).await?,
            });
        }
        return Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "idempotency_conflict",
            "同一 idempotencyKey 携带了不同确认请求",
        ));
    }
    let lookup = {
        let quotes = state.ai_runtime.wallpaper_quotes.lock().await;
        quotes.lookup(principal, quote_id, now).map(|quote| {
            (
                quote.request_digest.clone(),
                quote.consumed,
                quote.request.request_id.clone(),
                quote.pricing.provider.clone(),
                quote.pricing.model.clone(),
                quote.endpoint_identity.clone(),
            )
        })
    };
    let Some((digest, consumed, quote_request_id, quote_provider, quote_model, quote_endpoint)) =
        lookup
    else {
        return Err(ApiError::new(
            axum::http::StatusCode::NOT_FOUND,
            "quote_unknown",
            "quote 不存在或已过期",
        ));
    };
    if quote_request_id != request_id {
        return Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "quote_request_mismatch",
            "quote 与 requestId 不匹配",
        ));
    }
    if consumed {
        let existing = store::find_job_by_key(&state.db, principal, WALLPAPER_CAPABILITY, &key)
            .await
            .map_err(store_error)?;
        if let Some(job) = existing {
            if job.input_hash == digest {
                return Ok(SubmitOutcome::Replayed {
                    job: JobView::with_usage(&job, &state.db).await?,
                });
            }
            return Err(ApiError::new(
                axum::http::StatusCode::CONFLICT,
                "idempotency_conflict",
                "同一 idempotencyKey 携带了不同输入",
            ));
        }
        return Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "quote_consumed",
            "quote 已消费，不能创建第二个任务",
        ));
    }
    // quote 绑定 provider/model：确认后模型或 provider 被换即拒绝重试，
    // 不把旧报价落到新 adapter 上（§19.4）。
    let provider = state.ai_runtime.provider().await;
    if provider.id() != quote_provider
        || provider.model() != quote_model
        || provider.endpoint_identity() != quote_endpoint.as_deref()
    {
        return Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "quote_provider_changed",
            "quote 绑定的 provider/model 已变更",
        ));
    }
    state
        .ai_runtime
        .wallpaper_quotes
        .lock()
        .await
        .mark_consumed(principal, quote_id);
    let request = {
        let quotes = state.ai_runtime.wallpaper_quotes.lock().await;
        quotes
            .lookup(principal, quote_id, now)
            .map(|quote| (quote.request.clone(), quote.pricing.clone()))
    };
    let Some((request, pricing)) = request else {
        return Err(ApiError::new(
            axum::http::StatusCode::NOT_FOUND,
            "quote_unknown",
            "quote 不存在或已过期",
        ));
    };
    let input = GenerationInput::Wallpaper(request);
    let outcome = submit_owned(
        state,
        principal,
        input,
        WALLPAPER_CAPABILITY,
        Some(key.as_str()),
        Some(pricing),
        Some((quote_id, request_id)),
    )
    .await;
    match &outcome {
        Ok(_) => {
            state
                .ai_runtime
                .wallpaper_quotes
                .lock()
                .await
                .mark_consumed(principal, quote_id);
        }
        Err(_) => {
            // 受理失败还原为未消费，用户修正后可重试同一 quote。
            state
                .ai_runtime
                .wallpaper_quotes
                .lock()
                .await
                .restore(principal, quote_id);
        }
    }
    outcome
}

#[cfg(test)]
mod tests;
