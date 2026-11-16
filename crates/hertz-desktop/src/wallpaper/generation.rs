// SPDX-License-Identifier: MIT
//! Native connection and displayed-quote authority. Secrets never enter page replies.
use super::jobs::JobError;
use hertz_wallpaper::pairing::{self, Binding};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
type Result<T> = std::result::Result<T, JobError>;
fn error(code: &'static str, message: &str) -> JobError {
    JobError::new(code, message)
}
fn lock<T>(value: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Clone)]
struct Connection {
    binding: Binding,
    profile: crate::config::Profile,
    origin: String,
    service_generation: String,
    challenge: String,
    challenge_deadline: Instant,
    verified: bool,
    bearer: Option<String>,
    grant_id: Option<String>,
    expires: Option<Instant>,
}
struct Quote {
    owner: u64,
    token: String,
    quote_id: String,
    request_id: String,
    idempotency_key: String,
    summary: Value,
    expires: Instant,
    description: String,
    scene_id: String,
}
#[derive(Default)]
struct State {
    epoch: u64,
    quote_revision: u64,
    connection: Option<Connection>,
    quote: Option<Quote>,
    last_poll: Option<Instant>,
    job: Option<Value>,
    submission: Option<Value>,
}
pub(crate) struct NativeGeneration {
    state: Mutex<State>,
    busy: AtomicBool,
}
impl NativeGeneration {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State::default()),
            busy: AtomicBool::new(false),
        })
    }
    pub(crate) fn invalidate_quote(&self) {
        let mut state = lock(&self.state);
        state.quote = None;
        state.quote_revision = state.quote_revision.wrapping_add(1);
    }
    pub(crate) fn retire_profile(&self) {
        let connection = {
            let mut state = lock(&self.state);
            state.epoch = state.epoch.wrapping_add(1);
            state.quote = None;
            state.job = None;
            state.submission = None;
            state.connection.take()
        };
        if let Some(connection) = connection.filter(|c| c.bearer.is_some()) {
            let _ = std::thread::Builder::new()
                .name("wallpaper-ai-revoke".into())
                .spawn(move || {
                    if http(&connection, "DELETE", "/v1/ai/wallpaper/session", None).is_err() {
                        crate::app::log("wallpaper AI disconnect could not be confirmed");
                    }
                });
        }
    }
    pub(crate) fn confirmation(&self, owner: u64, token: &str) -> Result<String> {
        let state = lock(&self.state);
        let quote = state
            .quote
            .as_ref()
            .filter(|q| q.owner == owner && q.token == token && Instant::now() < q.expires)
            .ok_or_else(|| error("quote_expired", "报价已变化或到期，请重新报价"))?;
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Summary {
            provider: String,
            model: String,
            endpoint_label: String,
            data_scope: String,
            pricing_mode: String,
            maximum_cost_micro_usd: Option<i64>,
            max_input_tokens: u64,
            max_output_tokens: u64,
            maximum_wait_seconds: u64,
        }
        let summary: Summary = serde_json::from_value(quote.summary.clone())
            .map_err(|_| error("invalid_response", "报价确认信息不完整"))?;
        let price = match (
            summary.pricing_mode.as_str(),
            summary.maximum_cost_micro_usd,
        ) {
            ("free", Some(0)) => "本地离线 fixture，免费，不发送网络模型请求".to_owned(),
            ("metered", Some(amount)) if amount >= 0 => format!("费用预留上界：{amount} micro-USD"),
            ("token-only", None) => format!(
                "费用未知；最多 {} 输入 / {} 输出 token，没有美元费用封顶",
                summary.max_input_tokens, summary.max_output_tokens
            ),
            _ => return Err(error("invalid_response", "报价价格模式无效")),
        };
        Ok(format!("允许本次壁纸生成？\n\n模型：{} / {}\n地址：{}\n发送范围：{}\n规格：内置场景 {}，仅生成公开参数\n描述：{}\n最长等待：{} 秒\n{}\n\n仅生成候选，不保存或切换桌面。",
            summary.provider,summary.model,summary.endpoint_label,summary.data_scope,quote.scene_id,quote.description,summary.maximum_wait_seconds,price))
    }
    pub(crate) fn verify(
        &self,
        payload: Value,
        peer_pid: u32,
        profile: &crate::config::Profile,
    ) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Delivery {
            phase: String,
            challenge: String,
            binding: Binding,
            grant_id: Option<String>,
            bearer: Option<String>,
            expires_at: Option<i64>,
        }
        let delivery: Delivery = serde_json::from_value(payload)
            .map_err(|_| error("pairing_invalid", "配对信封无效"))?;
        let mut state = lock(&self.state);
        let connection = state
            .connection
            .as_mut()
            .ok_or_else(|| error("pairing_expired", "没有待配对连接"))?;
        let normalized = profile
            .normalized()
            .map_err(|_| error("profile_unavailable", "来源目录不可用"))?;
        if peer_pid != connection.binding.service_pid
            || delivery.binding != connection.binding
            || delivery.challenge != connection.challenge
            || Instant::now() >= connection.challenge_deadline
            || normalized != connection.profile
        {
            return Err(error(
                "pairing_identity_mismatch",
                "配对身份或 challenge 不匹配",
            ));
        }
        match delivery.phase.as_str() {
            "verify"
                if !connection.verified
                    && connection.bearer.is_none()
                    && delivery.bearer.is_none()
                    && delivery.grant_id.is_none()
                    && delivery.expires_at.is_none() =>
            {
                connection.verified = true;
            }
            "deliver" if connection.verified && connection.bearer.is_none() => {
                let token = delivery
                    .bearer
                    .filter(|s| pairing::hex64(s))
                    .ok_or_else(|| error("pairing_invalid", "短会话凭据无效"))?;
                let remaining = delivery.expires_at.unwrap_or(0) - now_ms();
                let grant = delivery
                    .grant_id
                    .filter(|id| super::api::valid_id(id))
                    .ok_or_else(|| error("pairing_invalid", "授权标识无效"))?;
                if remaining <= 0 || remaining > pairing::SESSION_MS {
                    return Err(error("pairing_invalid", "短会话期限无效"));
                }
                connection.bearer = Some(token);
                connection.grant_id = Some(grant);
                connection.expires = Some(Instant::now() + Duration::from_millis(remaining as u64));
                connection.challenge.clear();
            }
            _ => return Err(error("pairing_expired", "配对已使用，请重新连接")),
        }
        Ok(json!({"ok":true}))
    }
    pub(crate) fn run(
        self: &Arc<Self>,
        profile: crate::config::Profile,
        owner: u64,
        command: String,
        payload: Value,
        done: impl FnOnce(Result<Value>) + Send + 'static,
    ) -> Result<()> {
        if self.busy.swap(true, Ordering::AcqRel) {
            return Err(error("ai_busy", "上一操作尚未完成"));
        }
        let service = self.clone();
        let failed = self.clone();
        if std::thread::Builder::new()
            .name("wallpaper-ai-request".into())
            .spawn(move || {
                let result = service.perform(profile, owner, &command, payload);
                if matches!(
                    command.as_str(),
                    "wallpaper.ai.generate.confirm" | "wallpaper.ai.generate.recover"
                ) && result.as_ref().is_err_and(|e| {
                    e.details.as_ref().is_some_and(|d| {
                        matches!(
                            d["serviceCode"].as_str(),
                            Some(
                                "quote_unknown"
                                    | "quote_expired"
                                    | "quote_request_mismatch"
                                    | "quote_provider_changed"
                                    | "quote_consumed"
                                    | "idempotency_conflict"
                            )
                        )
                    })
                }) {
                    lock(&service.state).submission = None;
                }
                if result.as_ref().is_err_and(|e| {
                    matches!(
                        e.code,
                        "grant_revoked" | "wallpaper_session_expired" | "service_identity_mismatch"
                    )
                }) {
                    service.retire_profile();
                }
                service.busy.store(false, Ordering::Release);
                done(result);
            })
            .is_err()
        {
            failed.busy.store(false, Ordering::Release);
            return Err(error("worker_unavailable", "无法启动本机连接请求"));
        }
        Ok(())
    }
    fn perform(
        &self,
        profile: crate::config::Profile,
        owner: u64,
        command: &str,
        payload: Value,
    ) -> Result<Value> {
        if matches!(
            command,
            "wallpaper.ai.connect"
                | "wallpaper.ai.disconnect"
                | "wallpaper.ai.status"
                | "wallpaper.ai.capabilities"
                | "wallpaper.ai.generate.recover"
        ) && payload.as_object().is_none_or(|p| !p.is_empty())
        {
            return Err(error("invalid_input", "此操作不接受额外参数"));
        }
        if command == "wallpaper.ai.connect" {
            return self.connect(profile);
        }
        if command == "wallpaper.ai.status" {
            let mut state = lock(&self.state);
            if state.connection.as_ref().is_some_and(|c| {
                profile.normalized().ok().as_ref() != Some(&c.profile)
                    || current_discovery(c).is_err()
            }) {
                state.epoch = state.epoch.wrapping_add(1);
                state.connection = None;
                state.quote = None;
                state.job = None;
                state.submission = None;
                state.last_poll = None;
            }
            let mut result=state.connection.as_ref().map_or(json!({"connected":false}), |c| json!({
                "connected":c.bearer.is_some() && c.expires.is_some_and(|t| Instant::now()<t),
                "pending":c.bearer.is_none() && Instant::now()<c.challenge_deadline,
                "expiresInSeconds":c.expires.map(|t|t.saturating_duration_since(Instant::now()).as_secs())
            }));
            result["job"] = state.job.clone().unwrap_or(Value::Null);
            result["submissionPending"] = Value::Bool(state.submission.is_some());
            return Ok(result);
        }
        let (epoch, connection) = {
            let mut state = lock(&self.state);
            let connection = state
                .connection
                .clone()
                .ok_or_else(|| error("ai_not_connected", "先连接已运行的播放器"))?;
            if command == "wallpaper.ai.disconnect" {
                state.epoch = state.epoch.wrapping_add(1);
                state.quote = None;
                state.connection = None;
                state.job = None;
                state.submission = None;
            }
            (state.epoch, connection)
        };
        if command == "wallpaper.ai.disconnect" {
            if connection.bearer.is_some() {
                http(&connection, "DELETE", "/v1/ai/wallpaper/session", None)?;
            }
            return Ok(json!({"disconnected":true}));
        }
        if profile.normalized().ok().as_ref() != Some(&connection.profile)
            || connection.bearer.is_none()
            || connection.expires.is_none_or(|t| Instant::now() >= t)
        {
            return Err(error(
                "wallpaper_session_expired",
                "连接到期或来源已变化，请重新配对",
            ));
        }
        let result = match command {
            "wallpaper.ai.capabilities" => {
                let mut snapshot = http(&connection, "GET", "/v1/ai/wallpaper/capabilities", None)?;
                if snapshot["registryHash"] != hertz_wallpaper::catalog().registry_hash {
                    return Err(error(
                        "generation_catalog_mismatch",
                        "播放器与桌面目录不一致，请同步更新",
                    ));
                }
                snapshot["scenes"] = json!(hertz_wallpaper::catalog()
                    .scenes
                    .iter()
                    .map(|s| json!({"id":s["id"],"label":s["label"]}))
                    .collect::<Vec<_>>());
                snapshot
            }
            "wallpaper.ai.generate.quote" => {
                if lock(&self.state).submission.is_some() {
                    return Err(error("submission_pending", "请先查询已确认请求的结果"));
                }
                let quote_revision = lock(&self.state).quote_revision;
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Input {
                    brief: String,
                    scene_id: String,
                }
                let input: Input = serde_json::from_value(payload)
                    .map_err(|_| error("invalid_input", "描述或场景无效"))?;
                let snapshot = http(&connection, "GET", "/v1/ai/wallpaper/capabilities", None)?;
                if snapshot["registryHash"] != hertz_wallpaper::catalog().registry_hash {
                    return Err(error(
                        "generation_catalog_mismatch",
                        "播放器与桌面组件目录不一致，请同步更新",
                    ));
                }
                let request_id = uuid::Uuid::new_v4().to_string();
                let body = json!({"version":1,"requestId":request_id,"brief":input.brief,
                    "output":{"kind":"builtin","sceneId":input.scene_id},
                    "registryHash":snapshot["registryHash"],"generationSchemaHash":snapshot["generationSchemaHash"],
                    "capabilitySnapshotId":snapshot["snapshotId"]});
                hertz_wallpaper::generation::WallpaperGenerateRequest::parse(
                    &serde_json::to_vec(&body).expect("request"),
                )
                .map_err(|e| error(e.code, &e.message))?;
                let mut summary = http(&connection, "POST", "/v1/ai/wallpaper/quote", Some(body))?;
                let quote_id = summary["quoteId"]
                    .as_str()
                    .filter(|id| super::api::valid_id(id))
                    .ok_or_else(|| error("invalid_response", "报价标识无效"))?
                    .to_owned();
                let remaining = summary["expiresAt"].as_i64().unwrap_or(0) - now_ms();
                if remaining <= 0 || remaining > 300_000 {
                    return Err(error("quote_expired", "报价期限无效"));
                }
                let token = uuid::Uuid::new_v4().to_string();
                let mut state = lock(&self.state);
                if state.epoch != epoch || state.quote_revision != quote_revision {
                    return Err(error("ai_superseded", "连接或报价已变化"));
                }
                state.quote = Some(Quote {
                    owner,
                    token: token.clone(),
                    quote_id,
                    request_id,
                    idempotency_key: format!("v1.{}.{}", now_ms(), uuid::Uuid::new_v4().simple()),
                    summary: summary.clone(),
                    description: input.brief,
                    scene_id: input.scene_id,
                    expires: Instant::now() + Duration::from_millis(remaining as u64),
                });
                summary["confirmationToken"] = token.into();
                summary
            }
            "wallpaper.ai.generate.confirm" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Confirm {
                    confirmation_token: String,
                }
                let input: Confirm = serde_json::from_value(payload)
                    .map_err(|_| error("invalid_input", "确认参数无效"))?;
                let token = input.confirmation_token.as_str();
                let body = {
                    let mut state = lock(&self.state);
                    let q = state
                        .quote
                        .as_ref()
                        .filter(|q| {
                            q.owner == owner && q.token == token && Instant::now() < q.expires
                        })
                        .ok_or_else(|| error("quote_expired", "先重新报价并确认"))?;
                    let body = json!({"quoteId":q.quote_id,"requestId":q.request_id,"idempotencyKey":q.idempotency_key});
                    state.submission = Some(body.clone());
                    state.quote = None;
                    body
                };
                http(&connection, "POST", "/v1/ai/wallpaper/jobs", Some(body))?
            }
            "wallpaper.ai.generate.recover" => {
                let body = lock(&self.state)
                    .submission
                    .clone()
                    .ok_or_else(|| error("submission_unknown", "没有待查询的确认请求"))?;
                http(&connection, "POST", "/v1/ai/wallpaper/jobs", Some(body))?
            }
            "wallpaper.ai.generate.job" | "wallpaper.ai.generate.cancel" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Job {
                    job_id: String,
                    expected_state_revision: Option<i64>,
                }
                let job: Job = serde_json::from_value(payload)
                    .map_err(|_| error("invalid_input", "任务输入无效"))?;
                if !super::api::valid_id(&job.job_id) {
                    return Err(error("invalid_input", "任务标识无效"));
                }
                if command.ends_with(".job") {
                    let mut state = lock(&self.state);
                    if state
                        .last_poll
                        .is_some_and(|t| t.elapsed() < Duration::from_secs(2))
                    {
                        return Err(error("poll_too_soon", "任务查询间隔至少两秒"));
                    }
                    state.last_poll = Some(Instant::now());
                }
                let path = format!(
                    "/v1/ai/wallpaper/jobs/{}{}",
                    job.job_id,
                    if command.ends_with(".cancel") {
                        "/cancel"
                    } else {
                        ""
                    }
                );
                http(
                    &connection,
                    if command.ends_with(".cancel") {
                        "POST"
                    } else {
                        "GET"
                    },
                    &path,
                    command
                        .ends_with(".cancel")
                        .then(|| json!({"expectedStateRevision":job.expected_state_revision})),
                )?
            }
            _ => return Err(error("unsupported_command", "不支持的生成操作")),
        };
        let mut state = lock(&self.state);
        if state.epoch != epoch {
            return Err(error("ai_superseded", "连接已变化"));
        }
        if matches!(
            command,
            "wallpaper.ai.generate.confirm" | "wallpaper.ai.generate.recover"
        ) {
            if result["job"]["jobId"]
                .as_str()
                .is_none_or(|id| !super::api::valid_id(id))
            {
                return Err(error("invalid_response", "任务回执无效，请查询原请求"));
            }
            state.job = Some(result["job"].clone());
            state.submission = None;
        } else if matches!(
            command,
            "wallpaper.ai.generate.job" | "wallpaper.ai.generate.cancel"
        ) {
            state.job = Some(result.clone());
        }
        Ok(result)
    }
    fn connect(&self, profile: crate::config::Profile) -> Result<Value> {
        if crate::config::is_dbx(&profile) {
            return Err(error(
                "ai_standalone_required",
                "DBX 暂不支持生成，请连接独立播放器",
            ));
        }
        let profile = profile
            .normalized()
            .map_err(|_| error("profile_unavailable", "播放器目录不可用"))?;
        let discovery = crate::bridge::read_discovery(&profile)
            .map_err(|_| error("service_unavailable", "先启动所选来源的播放器"))?;
        if (profile.edition() != "custom"
            && discovery.edition.as_deref() != Some(profile.edition()))
            || !matches!(discovery.edition.as_deref(), Some("standard" | "full"))
            || discovery.protocol_version != vmusic_protocol()
            || discovery.port == 0
        {
            return Err(error("service_identity_mismatch", "播放器版本或来源不一致"));
        }
        let identity = hertz_desktop_ipc::windows::Identity::current()
            .map_err(|_| error("identity_unavailable", "无法核验登录身份"))?;
        let generation = hertz_desktop_ipc::windows::process_generation(std::process::id())
            .map_err(|_| error("identity_unavailable", "无法核验原生进程"))?;
        let service_generation = hertz_desktop_ipc::windows::process_generation(discovery.pid)
            .map_err(|_| error("service_identity_mismatch", "播放器进程已变化"))?;
        let binding = Binding {
            protocol: pairing::PROTOCOL,
            user_sid: identity.user_sid,
            windows_session_id: identity.windows_session_id,
            native_pid: std::process::id(),
            native_generation: generation,
            desktop_build_id: crate::component::BUILD_ID.into(),
            edition: discovery.edition.clone().expect("validated edition"),
            profile_digest: pairing::profile_digest(
                discovery.edition.as_deref().expect("validated edition"),
                profile.data_dir(),
            ),
            service_pid: discovery.pid,
            server_instance_id: discovery
                .server_instance_id
                .ok_or_else(|| error("service_identity_mismatch", "播放器缺少实例身份"))?,
        };
        if !binding.valid() {
            return Err(error("service_identity_mismatch", "播放器身份无效"));
        }
        let challenge = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let connection = Connection {
            binding,
            profile,
            service_generation,
            origin: format!("http://127.0.0.1:{}", discovery.port),
            challenge,
            challenge_deadline: Instant::now() + Duration::from_secs(pairing::CHALLENGE_SECONDS),
            verified: false,
            bearer: None,
            grant_id: None,
            expires: None,
        };
        let epoch = {
            let mut state = lock(&self.state);
            if state.connection.as_ref().is_some_and(|c| {
                c.bearer.is_some() && c.expires.is_some_and(|t| Instant::now() < t)
            }) {
                return Err(error("ai_already_connected", "先断开当前生成连接"));
            }
            state.epoch = state.epoch.wrapping_add(1);
            state.quote = None;
            state.job = None;
            state.submission = None;
            state.last_poll = None;
            state.connection = Some(connection.clone());
            state.epoch
        };
        let result = http(
            &connection,
            "POST",
            "/v1/ai/wallpaper/pairings/register",
            Some(json!({"challenge":connection.challenge,"binding":connection.binding})),
        );
        if result.is_err() {
            let mut state = lock(&self.state);
            if state.epoch == epoch {
                state.connection = None;
            }
        }
        result
    }
}
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn vmusic_protocol() -> u32 {
    1
}
fn current_discovery(connection: &Connection) -> Result<crate::bridge::Discovery> {
    let discovery = crate::bridge::read_discovery(&connection.profile)
        .map_err(|_| error("service_unavailable", "播放器已停止，请重新连接"))?;
    if discovery.pid != connection.binding.service_pid
        || discovery.edition.as_deref() != Some(connection.binding.edition.as_str())
        || discovery.server_instance_id.as_deref()
            != Some(connection.binding.server_instance_id.as_str())
        || format!("http://127.0.0.1:{}", discovery.port) != connection.origin
        || discovery.protocol_version != vmusic_protocol()
        || hertz_desktop_ipc::windows::process_generation(discovery.pid)
            .ok()
            .as_ref()
            != Some(&connection.service_generation)
    {
        return Err(error(
            "service_identity_mismatch",
            "播放器实例已变化，请重新配对",
        ));
    }
    Ok(discovery)
}
fn http(connection: &Connection, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
    // Discovery and process generation are checked before every request.
    let discovery = current_discovery(connection)?;
    if !path.starts_with("/v1/ai/wallpaper/") {
        return Err(error("invalid_input", "请求路径无效"));
    }
    let (success, bytes) = local_request(connection, discovery.port, method, path, body)?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| error("invalid_response", "服务响应无效"))?;
    if !success {
        let code = value["error"]["code"]
            .as_str()
            .or_else(|| value["code"].as_str())
            .unwrap_or("ai_request_failed");
        // The server's message is displayed without copying raw response bodies or credentials.
        let message = value["error"]["message"]
            .as_str()
            .or_else(|| value["message"].as_str())
            .unwrap_or("生成请求失败，请重新连接或重试原操作");
        let stable_code = match code {
            "grant_revoked" => "grant_revoked",
            "wallpaper_session_expired" => "wallpaper_session_expired",
            "wallpaper_session_expiring" => "wallpaper_session_expiring",
            "generation_consent_required" => "generation_consent_required",
            "quote_consumed" => "quote_consumed",
            "quote_expired" => "quote_expired",
            "state_conflict" => "state_conflict",
            "scope_required" => "scope_required",
            "ai_disabled" => "ai_disabled",
            "ai_locked" => "ai_locked",
            _ => "ai_request_failed",
        };
        return Err(JobError::new(stable_code, message).with_details(json!({"serviceCode":code})));
    }
    Ok(value)
}

/// This fixed-origin HTTP/1.1 JSON transport verifies the connected Windows
/// endpoint before writing headers. The service returns bounded, sized JSON;
/// redirects, proxies, chunked bodies and unrelated origins have no path here.
fn local_request(
    connection: &Connection,
    port: u16,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<(bool, Vec<u8>)> {
    if !matches!(method, "GET" | "POST" | "DELETE") || path.bytes().any(|b| b <= b' ' || b == 127) {
        return Err(error("invalid_input", "请求无效"));
    }
    let bytes = body
        .map(|body| serde_json::to_vec(&body))
        .transpose()
        .map_err(|_| error("invalid_input", "请求无法编码"))?
        .unwrap_or_default();
    if bytes.len() > 16 * 1024 {
        return Err(error("invalid_input", "请求超过16 KiB"));
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = std::net::TcpStream::connect_timeout(&address, Duration::from_secs(1))
        .map_err(|_| error("service_unavailable", "本机连接未完成"))?;
    hertz_desktop_ipc::windows::verify_loopback_peer(
        &stream,
        connection.binding.service_pid,
        &connection.service_generation,
    )
    .map_err(|_| error("service_identity_mismatch", "连接不属于已配对的播放器"))?;
    stream
        .set_write_timeout(Some(
            deadline
                .saturating_duration_since(Instant::now())
                .max(Duration::from_millis(1)),
        ))
        .map_err(|_| error("service_unavailable", "无法设置请求期限"))?;
    let auth = connection
        .bearer
        .as_ref()
        .map(|token| format!("Authorization: Bearer {token}\r\n"))
        .unwrap_or_default();
    let headers=format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{auth}\r\n",bytes.len());
    stream
        .write_all(headers.as_bytes())
        .and_then(|_| stream.write_all(&bytes))
        .map_err(|_| error("service_unavailable", "请求回执未完成，请查询原请求"))?;
    let mut received = Vec::new();
    let mut buffer = [0u8; 4096];
    let header_end = loop {
        read_response(&mut stream, &mut received, &mut buffer, deadline)?;
        if let Some(index) = received.windows(4).position(|w| w == b"\r\n\r\n") {
            if index > 8192 {
                return Err(error("invalid_response", "响应头过大"));
            }
            break index + 4;
        }
        if received.len() > 8192 {
            return Err(error("invalid_response", "响应头过大"));
        }
    };
    let header = std::str::from_utf8(&received[..header_end])
        .map_err(|_| error("invalid_response", "响应头无效"))?;
    let mut lines = header.split("\r\n");
    let mut status = lines.next().unwrap_or("").split(' ');
    if status.next() != Some("HTTP/1.1") {
        return Err(error("invalid_response", "响应协议无效"));
    }
    let code = status
        .next()
        .and_then(|s| s.parse::<u16>().ok())
        .filter(|n| (200..=599).contains(n))
        .ok_or_else(|| error("invalid_response", "响应状态无效"))?;
    let mut length = None;
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| error("invalid_response", "响应头无效"))?;
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return Err(error("invalid_response", "本机响应必须提供明确长度"));
        }
        if name.eq_ignore_ascii_case("content-length") {
            if length.is_some() {
                return Err(error("invalid_response", "响应长度重复"));
            }
            length = Some(
                value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| error("invalid_response", "响应长度无效"))?,
            );
        }
    }
    let length = length.ok_or_else(|| error("invalid_response", "响应缺少长度"))?;
    if length > 64 * 1024 {
        return Err(error("response_too_large", "响应超过64 KiB"));
    }
    while received.len() < header_end + length {
        read_response(&mut stream, &mut received, &mut buffer, deadline)?;
    }
    if received.len() != header_end + length {
        return Err(error("invalid_response", "响应长度不匹配"));
    }
    Ok(((200..300).contains(&code), received.split_off(header_end)))
}
fn read_response(
    stream: &mut std::net::TcpStream,
    received: &mut Vec<u8>,
    buffer: &mut [u8],
    deadline: Instant,
) -> Result<()> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or_else(|| error("service_unavailable", "读取响应已超时"))?;
    stream
        .set_read_timeout(Some(remaining))
        .map_err(|_| error("service_unavailable", "无法设置响应期限"))?;
    let count = stream
        .read(buffer)
        .map_err(|_| error("service_unavailable", "读取响应未完成，请查询原请求"))?;
    if count == 0 {
        return Err(error("invalid_response", "响应提前结束"));
    }
    if received.len() + count > 64 * 1024 + 8192 {
        return Err(error("response_too_large", "响应超过上限"));
    }
    received.extend_from_slice(&buffer[..count]);
    Ok(())
}

#[cfg(test)]
#[path = "generation_tests.rs"]
mod tests;
