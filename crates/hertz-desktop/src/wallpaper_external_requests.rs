// SPDX-License-Identifier: MIT
//! Existing settings/pipe/host coordinator for four fixed external operations.
use super::*;
use crate::wallpaper::{
    ai,
    ai_requests::{AiRequests, Origin, Outcome},
    api,
    external_requests::{self as external, Forward, Pending},
    jobs::JobError,
};
use hertz_wallpaper::external_requests::{Receipt, Request, RequestState};
use serde_json::{json, Value};
type ExternalResult<T> = std::result::Result<T, JobError>;

pub(crate) struct ForwardSnapshot {
    forward: Forward,
    request: Request,
    origin: Origin,
    owner: u64,
    epoch: u64,
    context: Option<ai::CatalogContext>,
    action: Option<ai::Action>,
    admission_error: Option<JobError>,
    outcome_pending: bool,
}
pub(crate) enum ForwardValue {
    Catalog(ai::ExternalCatalog),
    Receipt(Receipt),
    Replay(Receipt),
}
pub(crate) enum Completion {
    Forward(Box<ForwardSnapshot>, ApiReply, ExternalResult<ForwardValue>),
    Rejected(api::Request, u64, String, ExternalResult<Receipt>),
    Acceptance(
        api::Request,
        u64,
        String,
        Option<String>,
        ExternalResult<Value>,
    ),
    Accepted(
        api::Request,
        u64,
        String,
        Option<String>,
        ExternalResult<Receipt>,
    ),
    Generated(
        api::Request,
        u64,
        String,
        ExternalResult<Value>,
        Option<crate::wallpaper::generation::SubmissionOutcome>,
    ),
    GenerationObserved(
        ApiReply,
        Option<String>,
        ExternalResult<Value>,
        Option<crate::wallpaper::generation::SubmissionOutcome>,
    ),
    Outcome(String, u64, ExternalResult<Receipt>),
}
impl App {
    pub(super) fn external_window_visible(&self) -> bool {
        use windows_sys::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindowVisible};
        self.settings.as_ref().is_some_and(|s| {
            let hwnd = s.window.hwnd() as HWND;
            unsafe { IsWindowVisible(hwnd) != 0 && IsIconic(hwnd) == 0 }
        })
    }
    fn external_panel(&self, owner: u64) -> ExternalResult<()> {
        if self
            .wallpaper_external
            .panel
            .permits(owner, self.external_window_visible())
            && owner == self.settings_generation
            && self.settings.is_some()
        {
            Ok(())
        } else {
            Err(external::desktop_unavailable())
        }
    }
    fn external_live(&self, id: &str, owner: u64) -> ExternalResult<Pending> {
        self.external_panel(owner)?;
        let entry = self
            .wallpaper_external
            .requests
            .get(id)
            .cloned()
            .ok_or_else(external::target_stale)?;
        if entry.receipt.expires_at <= crate::wallpaper::library::now_secs()
            || entry.panel_epoch != self.wallpaper_external.panel.epoch
            || entry.receipt.state != RequestState::PendingConfirmation
            || entry.outcome_pending()
        {
            return Err(external::target_stale());
        }
        let current = external::current_service(&self.profile)?;
        external::check_service(&entry.service, &current, entry.service.pid)?;
        if let Some(binding) = &entry.binding {
            if self.ai_context(owner)?.binding != *binding {
                return Err(external::target_stale());
            }
        }
        Ok(entry)
    }
    fn forward_reply(&self, reply: ApiReply, result: ExternalResult<Value>) {
        let mut value = match result
            .and_then(|value| Ok((value, external::native_binding(self.settings_generation)?)))
        {
            Ok((value, binding)) => json!({"ok":true,"value":value,"binding":binding}),
            Err(error) => json!({"ok":false,"error":{"code":error.code,"message":error.message}}),
        };
        if hertz_desktop_ipc::frame::serialize_bounded(
            &value,
            hertz_desktop_ipc::management::RESPONSE_LIMIT,
        )
        .is_err()
        {
            value = json!({"ok":false,"error":{"code":"response_too_large","message":"目录响应过大，请缩小分页"}});
        }
        match reply {
            ApiReply::Pipe(reply, admission) if admission.is_valid() => {
                let _ = reply.send(value);
            }
            ApiReply::Host(reply) => {
                let _ = reply.send(value);
            }
            _ => {}
        }
    }
    pub(super) fn handle_external_forward(&mut self, value: Value, peer_pid: u32, reply: ApiReply) {
        let prepare = (|| -> ExternalResult<ForwardSnapshot> {
            let forward: Forward = serde_json::from_value(value)
                .map_err(|_| JobError::new("invalid_input", "申请转发信封无效"))?;
            let current = external::current_service(&self.profile)?;
            external::check_service(&forward.service, &current, peer_pid)?;
            let request = forward.parse()?;
            let owner = self.settings_generation;
            self.wallpaper_external.prune(Instant::now());
            if !matches!(request, Request::Get(_)) {
                self.external_panel(owner)?;
            }
            let context = if matches!(request, Request::Catalog(_) | Request::Switch(_)) {
                Some(
                    self.ai_context(owner)
                        .map_err(|_| external::desktop_unavailable())?,
                )
            } else {
                None
            };
            let action = match (&request, &context) {
                (Request::Switch(input), Some(context)) => self
                    .wallpaper_external
                    .target(input, &forward, &context.binding, Instant::now())
                    .map(Some),
                _ => Ok(None),
            };
            let (action, admission_error) = match action {
                Ok(action) => (action, None),
                Err(error) => (None, Some(error)),
            };
            let binding = json!({"service":forward.service,"native":external::native_binding(owner)?,
                "panelEpoch":self.wallpaper_external.panel.epoch,"context":context.as_ref().map(|c| &c.binding.context_digest)});
            let mut origin = Origin::new(
                &forward.subject,
                &forward.credential_revision,
                &ai::digest(&binding),
                &forward.label,
            )?;
            // Receipt lookup authenticates the grant and revision independently of
            // the current panel epoch; it cannot resume an old action.
            if let Request::Get(input) = &request {
                if let Some(entry) = self.wallpaper_external.requests.get(&input.request_id) {
                    if entry.origin.subject_digest == origin.subject_digest
                        && entry.origin.credential_revision == origin.credential_revision
                    {
                        origin = entry.origin.clone();
                    }
                }
            }
            Ok(ForwardSnapshot {
                forward,
                request,
                origin,
                owner,
                epoch: self.wallpaper_external.panel.epoch,
                context,
                action,
                admission_error,
                outcome_pending: self.wallpaper_external.has_pending_outcomes(),
            })
        })();
        let mut snapshot = match prepare {
            Ok(value) => value,
            Err(error) => {
                self.forward_reply(reply, Err(error));
                return;
            }
        };
        let existing = match &snapshot.request {
            Request::Get(input) => self
                .wallpaper_external
                .requests
                .get(&input.request_id)
                .cloned(),
            _ => None,
        };
        let generation = self.wallpaper_ai.generation.clone();
        let profile = self.profile.clone();
        let proxy = self.proxy.clone();
        let receiver = reply.clone();
        let queued = self
            .wallpaper_library
            .external_request(move |jobs| async move {
                let result = async {
                    let jobs = jobs?;
                    let store = AiRequests::new(jobs.library());
                    let now = crate::wallpaper::library::now_secs();
                    match &snapshot.request {
                        Request::Catalog(input) => Ok(ForwardValue::Catalog(
                            ai::external_catalog(
                                jobs.clone(),
                                input.clone(),
                                snapshot
                                    .context
                                    .clone()
                                    .ok_or_else(external::desktop_unavailable)?,
                            )
                            .await?,
                        )),
                        Request::Get(input) => {
                            let mut receipt =
                                store.get(&snapshot.origin, &input.request_id, now).await?;
                            if let Some(entry) = existing.filter(|entry| {
                                entry.origin.subject_digest == snapshot.origin.subject_digest
                                    && entry.origin.credential_revision
                                        == snapshot.origin.credential_revision
                                    && matches!(entry.request, Request::Generate(_))
                                    && receipt.state == RequestState::Accepted
                            }) {
                                if let Some(job_id) = receipt.job_id.clone() {
                                    if let Ok(Ok(job)) = tokio::task::spawn_blocking(move || {
                                        generation.read_external_job(
                                            profile,
                                            entry.owner,
                                            job_id.clone(),
                                        )
                                    })
                                    .await
                                    {
                                        if let Some(state) = external_job_state(&job) {
                                            receipt = store
                                                .complete(
                                                    &snapshot.origin,
                                                    &input.request_id,
                                                    Outcome {
                                                        state,
                                                        job_id: job["jobId"]
                                                            .as_str()
                                                            .map(str::to_owned),
                                                        native_operation_id: None,
                                                        error_code: None,
                                                    },
                                                    crate::wallpaper::library::now_secs(),
                                                )
                                                .await?;
                                        }
                                    }
                                }
                            }
                            Ok(ForwardValue::Receipt(receipt))
                        }
                        Request::Switch(_) | Request::Generate(_) => {
                            if let Some(receipt) = store
                                .replay(&snapshot.origin, &snapshot.request, now)
                                .await?
                            {
                                return Ok(ForwardValue::Replay(receipt));
                            }
                            if let Some(error) = snapshot.admission_error.take() {
                                return Err(error);
                            }
                            if snapshot.outcome_pending {
                                return Err(JobError::new(
                                    "budget_busy",
                                    "正在保存上次申请结果，请稍后重试",
                                ));
                            }
                            let receipt = store
                                .admit(&snapshot.origin, &snapshot.request, now)
                                .await?;
                            if receipt.state == RequestState::PendingConfirmation {
                                let pending = store.pending(now).await?;
                                if pending
                                    .iter()
                                    .find(|pending| pending.request_id == receipt.request_id)
                                    .is_none_or(|pending| {
                                        pending.digest != snapshot.request.digest()
                                            || pending.origin != snapshot.origin
                                            || pending.request.canonical_bytes()
                                                != snapshot.request.canonical_bytes()
                                    })
                                {
                                    return Err(JobError::new(
                                        "ai_request_conflict",
                                        "申请摘要与原收据不一致",
                                    ));
                                }
                            }
                            Ok(ForwardValue::Receipt(receipt))
                        }
                    }
                }
                .await;
                let _ = proxy.send_event(UserEvent::WallpaperExternal(Box::new(
                    Completion::Forward(Box::new(snapshot), receiver, result),
                )));
            });
        if let Err(error) = queued {
            self.forward_reply(reply, Err(error));
        }
    }
    pub(super) fn handle_external_settings(
        &mut self,
        request: &api::Request,
        owner: u64,
    ) -> ExternalResult<Option<Value>> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Id {
            request_id: String,
        }
        match request.command.as_str() {
            "wallpaper.ai.external.panel" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Visibility {
                    visible: bool,
                }
                let input: Visibility = serde_json::from_value(request.payload.clone())
                    .map_err(|_| JobError::invalid_input("面板状态无效"))?;
                self.wallpaper_external.set_owner(owner);
                self.wallpaper_external
                    .set_panel(input.visible && self.external_window_visible());
                Ok(Some(json!({"visible":self.wallpaper_external.panel.open})))
            }
            "wallpaper.ai.external.list" => {
                if request.payload.as_object().is_none_or(|p| !p.is_empty()) {
                    return Err(JobError::invalid_input("申请列表不接受参数"));
                }
                self.external_panel(owner)?;
                self.wallpaper_external.prune(Instant::now());
                let requests: Vec<_> = self.wallpaper_external.requests.iter().map(|(id, entry)| {
                    let mut value = json!({"requestId":id,"operation":entry.request.operation(),"label":entry.origin.label,
                        "state":entry.receipt.state,"expiresAt":entry.receipt.expires_at,"confirmable":self.external_live(id, owner).is_ok() && !entry.accepting,
                        "jobId":entry.receipt.job_id,"nativeOperationId":entry.receipt.native_operation_id,"errorCode":entry.receipt.error_code});
                    match &entry.request {
                        Request::Generate(input) => { value["brief"] = input.brief.clone().into(); value["outputKind"] = serde_json::to_value(input.output_kind).expect("kind"); }
                        Request::Switch(_) => if let Some(action) = &entry.action { value["title"] = action.title.clone().into(); value["version"] = action.version.into(); },
                        _ => {}
                    }
                    value
                }).collect();
                Ok(Some(json!({"requests":requests})))
            }
            "wallpaper.ai.external.open" => {
                let input: Id = serde_json::from_value(request.payload.clone())
                    .map_err(|_| JobError::invalid_input("申请标识无效"))?;
                let entry = self.external_live(&input.request_id, owner)?;
                let Request::Generate(input) = entry.request else {
                    return Err(JobError::invalid_input("请选择生成申请"));
                };
                Ok(Some(
                    json!({"requestId":entry.receipt.request_id,"brief":input.brief,"outputKind":input.output_kind,"label":entry.origin.label}),
                ))
            }
            "wallpaper.ai.external.reject" => {
                let input: Id = serde_json::from_value(request.payload.clone())
                    .map_err(|_| JobError::invalid_input("申请标识无效"))?;
                self.external_panel(owner)?;
                let entry = self
                    .wallpaper_external
                    .requests
                    .get(&input.request_id)
                    .cloned()
                    .ok_or_else(external::target_stale)?;
                if entry.accepting {
                    return Err(JobError::new("ai_busy", "正在核验申请，请稍候"));
                }
                let proxy = self.proxy.clone();
                let ui_request = request.clone();
                self.wallpaper_library
                    .external_request(move |jobs| async move {
                        let result = async {
                            let jobs = jobs?;
                            AiRequests::new(jobs.library())
                                .reject(
                                    &entry.origin,
                                    &input.request_id,
                                    crate::wallpaper::library::now_secs(),
                                )
                                .await
                        }
                        .await;
                        let _ = proxy.send_event(UserEvent::WallpaperExternal(Box::new(
                            Completion::Rejected(ui_request, owner, input.request_id, result),
                        )));
                    })?;
                Ok(None)
            }
            "wallpaper.ai.external.confirm" => {
                let input: Id = serde_json::from_value(request.payload.clone())
                    .map_err(|_| JobError::invalid_input("申请标识无效"))?;
                let entry = self.external_live(&input.request_id, owner)?;
                let action = entry
                    .action
                    .as_ref()
                    .ok_or_else(|| JobError::invalid_input("生成申请请先查看报价"))?;
                let text = format!("允许外部助手提出的这次壁纸切换？\n\n来源：{}\n作品：{} · v{}\n目标：当前已保存显示组\n\n确认后保存并切换这一确切版本。", entry.origin.label, action.title, action.version);
                if !crate::native::confirm_wallpaper_switch(self.hwnd(), &text) {
                    let mut rejected = request.clone();
                    rejected.command = "wallpaper.ai.external.reject".into();
                    return self.handle_external_settings(&rejected, owner);
                }
                self.start_external_acceptance(request.clone(), owner, input.request_id, None)?;
                Ok(None)
            }
            _ => Err(JobError::new("unsupported_command", "此申请面板命令不可用")),
        }
    }
    pub(super) fn start_external_acceptance(
        &mut self,
        request: api::Request,
        owner: u64,
        id: String,
        token: Option<String>,
    ) -> ExternalResult<()> {
        let entry = self.external_live(&id, owner)?;
        if entry.accepting {
            return Err(JobError::new("ai_busy", "正在核验这份申请"));
        }
        if let Some(token) = &token {
            self.wallpaper_ai.generation.confirmation(owner, token)?;
            let generation_request_id = self
                .wallpaper_ai
                .generation
                .confirmation_request_id(owner, token)?;
            self.wallpaper_external
                .requests
                .get_mut(&id)
                .expect("live entry")
                .generation_request_id = Some(generation_request_id);
        }
        self.wallpaper_external
            .requests
            .get_mut(&id)
            .expect("live entry")
            .accepting = true;
        let proxy = self.proxy.clone();
        let profile = self.profile.clone();
        let response_id = id.clone();
        let completion_id = id.clone();
        let queued = self
            .wallpaper_library
            .external_request(move |_jobs| async move {
                let result = tokio::task::spawn_blocking(move || {
                    crate::wallpaper::generation::NativeGeneration::accept_external(
                        profile,
                        entry.service,
                        entry.proof,
                        response_id,
                        entry.digest,
                        owner,
                    )
                })
                .await
                .unwrap_or_else(|_| {
                    Err(JobError::new(
                        "worker_unavailable",
                        "申请核验已退出，请重试原申请",
                    ))
                });
                let _ = proxy.send_event(UserEvent::WallpaperExternal(Box::new(
                    Completion::Acceptance(request, owner, completion_id, token, result),
                )));
            });
        if queued.is_err() {
            if let Some(entry) = self.wallpaper_external.requests.get_mut(&id) {
                entry.accepting = false;
            }
        }
        queued
    }
    pub(super) fn finish_external(&mut self, completion: Completion) {
        match completion {
            Completion::Forward(snapshot, reply, result) => {
                let result = result.and_then(|result| {
                    external::check_service(
                        &snapshot.forward.service,
                        &external::current_service(&self.profile)?,
                        snapshot.forward.service.pid,
                    )?;
                    if !matches!(snapshot.request, Request::Get(_)) {
                        self.external_panel(snapshot.owner)?;
                        if snapshot.epoch != self.wallpaper_external.panel.epoch {
                            return Err(external::desktop_unavailable());
                        }
                    }
                    match result {
                        ForwardValue::Replay(receipt) => {
                            // Reading an original identity grants no fresh proof,
                            // target handle, deadline, or action eligibility.
                            Ok(serde_json::to_value(receipt).expect("receipt"))
                        }
                        ForwardValue::Catalog(catalog) => {
                            let binding = snapshot
                                .context
                                .as_ref()
                                .ok_or_else(external::desktop_unavailable)?
                                .binding
                                .clone();
                            if self.ai_context(snapshot.owner)?.binding != binding {
                                return Err(external::target_stale());
                            }
                            self.wallpaper_external.catalog(
                                &snapshot.forward,
                                binding,
                                catalog,
                                Instant::now(),
                            )
                        }
                        ForwardValue::Receipt(receipt) => {
                            if !matches!(snapshot.request, Request::Get(_))
                                && receipt.state == RequestState::PendingConfirmation
                            {
                                // An idempotent replay never replaces the original proof or action facts.
                                self.wallpaper_external
                                    .requests
                                    .entry(receipt.request_id.clone())
                                    .or_insert_with(|| Pending {
                                        owner: snapshot.owner,
                                        origin: snapshot.origin.clone(),
                                        request: snapshot.request.clone(),
                                        digest: snapshot.request.digest(),
                                        receipt: receipt.clone(),
                                        service: snapshot.forward.service.clone(),
                                        panel_epoch: snapshot.epoch,
                                        binding: snapshot
                                            .context
                                            .as_ref()
                                            .map(|c| c.binding.clone()),
                                        action: snapshot.action.clone(),
                                        proof: snapshot.forward.proof.clone().unwrap_or_default(),
                                        generation_request_id: None,
                                        accepting: false,
                                        outcome: Default::default(),
                                    });
                                self.wallpaper_external.prune(Instant::now());
                            }
                            if let Request::Get(input) = &snapshot.request {
                                if let Some(entry) =
                                    self.wallpaper_external.requests.get_mut(&input.request_id)
                                {
                                    entry.observe_receipt(receipt.clone());
                                    if !receipt.state.is_active() {
                                        entry.proof.clear();
                                        entry.accepting = false;
                                    }
                                }
                            }
                            Ok(serde_json::to_value(receipt).expect("receipt"))
                        }
                    }
                });
                self.forward_reply(reply, result);
            }
            Completion::Rejected(request, owner, id, result) => {
                if let Ok(receipt) = &result {
                    if let Some(entry) = self.wallpaper_external.requests.get_mut(&id) {
                        entry.receipt = receipt.clone();
                        entry.proof.clear();
                    }
                }
                self.send_wallpaper_management(
                    ApiReply::Settings(owner),
                    api::response(
                        Some(&request.request_id),
                        result.map(|r| serde_json::to_value(r).expect("receipt")),
                        None,
                    ),
                );
            }
            Completion::Acceptance(request, owner, id, token, result) => {
                let accepted = result.and_then(|value| {
                    let entry = self.external_live(&id, owner)?;
                    if let Some(token) = &token {
                        self.wallpaper_ai.generation.confirmation(owner, token)?;
                    }
                    let acceptance = value["acceptanceId"]
                        .as_str()
                        .ok_or_else(external::target_stale)?
                        .to_owned();
                    Ok((entry, acceptance))
                });
                match accepted {
                    Ok((entry, acceptance)) => {
                        let proxy = self.proxy.clone();
                        let response = request.clone();
                        let request_id = id.clone();
                        if let Err(error) =
                            self.wallpaper_library
                                .external_request(move |jobs| async move {
                                    let result = async {
                                        let jobs = jobs?;
                                        AiRequests::new(jobs.library())
                                            .accept(
                                                &entry.origin,
                                                &request_id,
                                                &entry.digest,
                                                &acceptance,
                                                crate::wallpaper::library::now_secs(),
                                            )
                                            .await
                                    }
                                    .await;
                                    let _ = proxy.send_event(UserEvent::WallpaperExternal(
                                        Box::new(Completion::Accepted(
                                            response, owner, request_id, token, result,
                                        )),
                                    ));
                                })
                        {
                            self.external_action_error(&request, owner, &id, error);
                        }
                    }
                    Err(error) => self.external_action_error(&request, owner, &id, error),
                }
            }
            Completion::Accepted(request, owner, id, token, result) => {
                let run = result.and_then(|receipt| {
                    let entry = self.external_live(&id, owner)?;
                    if receipt.state != RequestState::Accepted {
                        return Err(external::target_stale());
                    }
                    if let Some(token) = &token {
                        self.wallpaper_ai.generation.confirmation(owner, token)?;
                    }
                    self.wallpaper_external
                        .requests
                        .get_mut(&id)
                        .expect("entry")
                        .receipt = receipt;
                    if let Some(token) = token {
                        let proxy = self.proxy.clone();
                        let response = request.clone();
                        let external_id = id.clone();
                        self.wallpaper_ai.generation.run_with_submission(
                            self.profile.clone(),
                            owner,
                            "wallpaper.ai.generate.confirm".into(),
                            json!({"confirmationToken":token}),
                            move |result, submission_pending| {
                                let _ = proxy.send_event(UserEvent::WallpaperExternal(Box::new(
                                    Completion::Generated(
                                        response,
                                        owner,
                                        external_id,
                                        result,
                                        submission_pending,
                                    ),
                                )));
                            },
                        )?;
                    } else {
                        let action = entry.action.ok_or_else(external::target_stale)?;
                        let binding = entry.binding.ok_or_else(external::target_stale)?;
                        self.wallpaper_ai.show(
                            &ai::Catalog {
                                binding: binding.clone(),
                                actions: vec![action.clone()],
                                explicit_action: None,
                                ambiguous: false,
                                inspected: 1,
                            },
                            &binding,
                        )?;
                        let native = api::Request {
                            protocol: 2,
                            request_id: id.clone(),
                            command: "wallpaper.ai.confirm".into(),
                            expected_revision: Some(binding.expected_config_revision),
                            payload: json!({"actionId":action.action_id}),
                        };
                        self.start_ai_switch(native, owner, &action.action_id, binding)?;
                        self.send_wallpaper_management(
                            ApiReply::Settings(owner),
                            api::response(
                                Some(&request.request_id),
                                Ok(json!({"accepted":true,"requestId":id})),
                                None,
                            ),
                        );
                    }
                    Ok(())
                });
                if let Err(error) = run {
                    if let Some(entry) = self.wallpaper_external.requests.get_mut(&id) {
                        entry.retain_outcome(external::OutcomeFact::AcceptanceFailed(
                            error.code.into(),
                        ));
                    }
                    self.flush_external_outcomes();
                    self.external_action_error(&request, owner, &id, error);
                }
            }
            Completion::Generated(request, owner, id, result, submission) => {
                if let Some(outcome) = &submission {
                    self.observe_external_submission(outcome, result.as_ref().err());
                }
                match &result {
                    Ok(value) => {
                        if let Some(job) = value["job"]["jobId"].as_str() {
                            self.record_external_outcome(
                                &id,
                                RequestState::Accepted,
                                Some(job.into()),
                                None,
                                None,
                            );
                        }
                    }
                    // A missing HTTP receipt can follow a committed job. Keep
                    // the original NativeGeneration submission for recovery.
                    Err(error) if submission.is_none() => self.record_external_outcome(
                        &id,
                        RequestState::Failed,
                        None,
                        None,
                        Some(error.code.into()),
                    ),
                    Err(_) => {}
                }
                if let Some(entry) = self.wallpaper_external.requests.get_mut(&id) {
                    entry.accepting = false;
                    entry.proof.clear();
                }
                self.send_wallpaper_management(
                    ApiReply::Settings(owner),
                    api::response(Some(&request.request_id), result, None),
                );
            }
            Completion::GenerationObserved(reply, request_id, result, submission) => {
                if let Some(submission) = submission {
                    self.observe_external_submission(&submission, result.as_ref().err());
                }
                self.send_wallpaper_management(
                    reply,
                    api::response(request_id.as_deref(), result, None),
                );
            }
            Completion::Outcome(id, revision, result) => {
                if let Some(entry) = self.wallpaper_external.requests.get_mut(&id) {
                    entry.finish_outcome(revision, result, Instant::now());
                }
            }
        }
    }
    pub(super) fn observe_external_submission(
        &mut self,
        outcome: &crate::wallpaper::generation::SubmissionOutcome,
        error: Option<&JobError>,
    ) {
        let affected: Vec<_> = self
            .wallpaper_external
            .requests
            .iter()
            .filter_map(|(id, entry)| {
                if entry.receipt.state != RequestState::Accepted
                    || !matches!(entry.request, Request::Generate(_))
                {
                    return None;
                }
                let original =
                    entry.generation_request_id.as_deref() == Some(outcome.request_id.as_str());
                let retired = outcome.retired_service_instance.as_deref()
                    == Some(entry.service.server_instance_id.as_str());
                if original && (error.is_some() || outcome.interrupted) {
                    let state = if outcome.interrupted {
                        RequestState::Interrupted
                    } else if outcome.pending {
                        RequestState::Accepted
                    } else {
                        RequestState::Failed
                    };
                    let code = if state == RequestState::Accepted {
                        "receipt_pending"
                    } else {
                        error.map_or("generation_interrupted", |e| e.code)
                    };
                    Some((id.clone(), state, code.to_owned()))
                } else if retired {
                    Some((
                        id.clone(),
                        RequestState::Interrupted,
                        "generation_interrupted".into(),
                    ))
                } else {
                    None
                }
            })
            .collect();
        for (id, state, code) in affected {
            self.record_external_outcome(&id, state, None, None, Some(code));
        }
    }
    fn external_action_error(
        &mut self,
        request: &api::Request,
        owner: u64,
        id: &str,
        error: JobError,
    ) {
        if request.command == "wallpaper.ai.generate.confirm" {
            self.wallpaper_ai.generation.invalidate_quote();
        }
        if let Some(entry) = self.wallpaper_external.requests.get_mut(id) {
            entry.accepting = false;
        }
        self.send_wallpaper_management(
            ApiReply::Settings(owner),
            api::response(Some(&request.request_id), Err(error), None),
        );
    }
    pub(super) fn validate_external_generation(&self, id: &str, owner: u64) -> ExternalResult<()> {
        let entry = self.external_live(id, owner)?;
        if !matches!(entry.request, Request::Generate(_)) || entry.accepting {
            return Err(external::target_stale());
        }
        Ok(())
    }
    pub(super) fn reject_external_generation(&mut self, id: &str) {
        if let Some(entry) = self.wallpaper_external.requests.get_mut(id) {
            entry.retain_outcome(external::OutcomeFact::Rejected);
        }
        self.flush_external_outcomes();
    }
    pub(super) fn observe_external_generation(&mut self, value: &Value) {
        let response = value;
        let value = if response["job"].is_object() {
            &response["job"]
        } else {
            value
        };
        let Some(job) = value["jobId"].as_str() else {
            return;
        };
        let entry = self.wallpaper_external.requests.iter().find(|(_, entry)| {
            matches!(entry.request, Request::Generate(_))
                && entry.receipt.state == RequestState::Accepted
                && entry.matches_generation(response)
        });
        let Some((id, _)) = entry else {
            return;
        };
        let Some(state) = external_job_state(value) else {
            return;
        };
        let id = id.clone();
        self.record_external_outcome(&id, state, Some(job.into()), None, None);
    }
    pub(super) fn record_external_outcome(
        &mut self,
        id: &str,
        state: RequestState,
        job_id: Option<String>,
        native_operation_id: Option<String>,
        error_code: Option<String>,
    ) {
        if let Some(entry) = self.wallpaper_external.requests.get_mut(id) {
            entry.retain_outcome(external::OutcomeFact::Completed(Outcome {
                state,
                job_id,
                native_operation_id,
                error_code,
            }));
        }
        self.flush_external_outcomes();
    }

    pub(super) fn flush_external_outcomes(&mut self) {
        let proxy = self.proxy.clone();
        self.wallpaper_external.flush_outcomes(
            &self.wallpaper_library,
            Instant::now(),
            move |id, revision, result| {
                let _ = proxy.send_event(UserEvent::WallpaperExternal(Box::new(
                    Completion::Outcome(id, revision, result),
                )));
            },
        );
    }
}

fn external_job_state(value: &Value) -> Option<RequestState> {
    Some(match value["state"].as_str()? {
        "succeeded" => RequestState::Succeeded,
        "failed" => RequestState::Failed,
        "cancelled" => RequestState::Cancelled,
        "interrupted" | "expired" => RequestState::Interrupted,
        "accepted" | "running" => RequestState::Accepted,
        _ => return None,
    })
}
