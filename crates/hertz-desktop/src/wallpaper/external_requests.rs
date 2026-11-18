// SPDX-License-Identifier: MIT
//! Narrow external-request authority. The page receives summaries, never proofs.
use super::ai_requests::{AiRequests, Origin, Outcome};
use super::{ai, jobs::JobError};
use hertz_wallpaper::external_requests::{Receipt, Request, RequestState};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, JobError>;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ServiceIdentity {
    pub pid: u32,
    pub generation: String,
    pub server_instance_id: String,
    pub edition: String,
    pub profile_digest: String,
    pub user_sid: String,
    pub windows_session_id: u32,
}

pub(crate) fn check_service(
    supplied: &ServiceIdentity,
    current: &ServiceIdentity,
    peer_pid: u32,
) -> Result<()> {
    if peer_pid == 0 || peer_pid != current.pid || supplied != current {
        return Err(JobError::new(
            "service_identity_mismatch",
            "申请来源不属于当前播放器实例",
        ));
    }
    Ok(())
}

#[derive(Default)]
pub(crate) struct Panel {
    pub owner: u64,
    pub epoch: u64,
    pub open: bool,
}
impl Panel {
    pub(crate) fn permits(&self, owner: u64, window_visible: bool) -> bool {
        self.open && owner != 0 && self.owner == owner && window_visible
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Forward {
    pub version: u32,
    pub service: ServiceIdentity,
    pub subject: String,
    pub credential_revision: String,
    pub label: String,
    pub operation: String,
    pub request_json: String,
    pub proof: Option<String>,
}
impl Forward {
    pub(crate) fn parse(&self) -> Result<Request> {
        let operation = match self.operation.as_str() {
            "wallpaper.catalog_get" => "catalog",
            "wallpaper.switch_request" => "switch",
            "wallpaper.generate_request" => "generate",
            "wallpaper.request_get" => "get",
            _ => return Err(JobError::new("unsupported_command", "此转发操作不可用")),
        };
        if self.version != 1
            || !hertz_wallpaper::valid_sha256_hex(&self.subject)
            || !hertz_wallpaper::valid_sha256_hex(&self.credential_revision)
            || self.label.is_empty()
            || self.label.len() > 128
            || self.label.chars().any(char::is_control)
        {
            return Err(JobError::new("invalid_input", "申请来源信封无效"));
        }
        let request =
            hertz_wallpaper::external_requests::parse(operation, self.request_json.as_bytes())
                .map_err(|e| JobError::new(e.code, e.message))?;
        if !match &request {
            Request::Switch(_) | Request::Generate(_) => self
                .proof
                .as_ref()
                .is_some_and(|p| hertz_wallpaper::valid_sha256_hex(p)),
            _ => self.proof.is_none(),
        } {
            return Err(JobError::new("invalid_input", "申请确认凭据无效"));
        }
        Ok(request)
    }
}

pub(crate) struct Target {
    pub subject: String,
    pub revision: String,
    pub service: ServiceIdentity,
    pub panel_epoch: u64,
    pub binding: ai::Binding,
    pub actions: Vec<ai::Action>,
    pub expires: Instant,
}
#[derive(Clone)]
pub(crate) struct Pending {
    pub owner: u64,
    pub origin: Origin,
    pub request: Request,
    pub receipt: Receipt,
    pub digest: String,
    pub service: ServiceIdentity,
    pub panel_epoch: u64,
    pub binding: Option<ai::Binding>,
    pub action: Option<ai::Action>,
    pub proof: String,
    pub generation_request_id: Option<String>,
    pub accepting: bool,
    pub outcome: OutcomeDelivery,
}

/// One unsaved fact per admitted request, never another action or runner.
#[derive(Clone)]
pub(crate) enum OutcomeFact {
    Rejected,
    Completed(Outcome),
    AcceptanceFailed(String),
}

impl OutcomeFact {
    fn state(&self) -> RequestState {
        match self {
            Self::Rejected => RequestState::Rejected,
            Self::Completed(outcome) => outcome.state,
            Self::AcceptanceFailed(_) => RequestState::Failed,
        }
    }

    pub(crate) async fn persist(
        self,
        store: &AiRequests<'_>,
        origin: &Origin,
        id: &str,
        now: i64,
    ) -> Result<Receipt> {
        match self {
            Self::Completed(outcome) => store.complete(origin, id, outcome, now).await,
            Self::AcceptanceFailed(code) => {
                // Acceptance may have failed before committing, or committed
                // before a later native validation failed. Read its owner.
                let receipt = store.get(origin, id, now).await?;
                if receipt.state == RequestState::Accepted {
                    store
                        .complete(
                            origin,
                            id,
                            Outcome {
                                state: RequestState::Failed,
                                job_id: None,
                                native_operation_id: None,
                                error_code: Some(code),
                            },
                            now,
                        )
                        .await
                } else {
                    Ok(receipt)
                }
            }
            Self::Rejected => match store.reject(origin, id, now).await {
                // A queued No can reach the store after its confirmation expired.
                Err(error) if error.code == "ai_request_state_changed" => {
                    let receipt = store.get(origin, id, now).await?;
                    if receipt.state.is_active() {
                        Err(error)
                    } else {
                        Ok(receipt)
                    }
                }
                result => result,
            },
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct OutcomeDelivery {
    fact: Option<OutcomeFact>,
    revision: u64,
    in_flight: Option<u64>,
    retry_after: Option<Instant>,
    failures: u8,
}

impl Pending {
    pub(crate) fn outcome_pending(&self) -> bool {
        self.outcome.fact.is_some()
    }

    pub(crate) fn retain_outcome(&mut self, mut fact: OutcomeFact) {
        if !self.receipt.state.is_active()
            || self
                .outcome
                .fact
                .as_ref()
                .is_some_and(|known| !known.state().is_active())
        {
            return;
        }
        if let OutcomeFact::Completed(next) = &mut fact {
            let known = self.outcome.fact.as_ref().and_then(|known| match known {
                OutcomeFact::Completed(outcome) => Some(outcome),
                OutcomeFact::Rejected | OutcomeFact::AcceptanceFailed(_) => None,
            });
            next.job_id = next
                .job_id
                .take()
                .or_else(|| known.and_then(|o| o.job_id.clone()))
                .or_else(|| self.receipt.job_id.clone());
            next.native_operation_id = next
                .native_operation_id
                .take()
                .or_else(|| known.and_then(|o| o.native_operation_id.clone()))
                .or_else(|| self.receipt.native_operation_id.clone());
            let duplicate = known.map_or_else(
                || {
                    self.receipt.state == next.state
                        && self.receipt.job_id == next.job_id
                        && self.receipt.native_operation_id == next.native_operation_id
                        && self.receipt.error_code == next.error_code
                },
                |known| {
                    known.state == next.state
                        && known.job_id == next.job_id
                        && known.native_operation_id == next.native_operation_id
                        && known.error_code == next.error_code
                },
            );
            if duplicate {
                return;
            }
        }
        self.outcome.revision = self.outcome.revision.wrapping_add(1);
        self.outcome.fact = Some(fact);
        self.outcome.retry_after = None;
        self.outcome.failures = 0;
        self.receipt.error_code = Some("receipt_pending".into());
        self.accepting = true;
        self.proof.clear();
    }

    pub(crate) fn begin_outcome(&mut self, now: Instant) -> Option<(u64, OutcomeFact)> {
        if self.outcome.in_flight.is_some()
            || self.outcome.retry_after.is_some_and(|retry| now < retry)
        {
            return None;
        }
        let fact = self.outcome.fact.clone()?;
        self.outcome.in_flight = Some(self.outcome.revision);
        Some((self.outcome.revision, fact))
    }

    pub(crate) fn finish_outcome(&mut self, revision: u64, result: Result<Receipt>, now: Instant) {
        if self.outcome.in_flight != Some(revision) {
            return;
        }
        self.outcome.in_flight = None;
        if revision != self.outcome.revision {
            // The accepted write finished after a terminal job fact arrived.
            // Its acknowledgement cannot erase that newer unsaved fact.
            return;
        }
        match result {
            Ok(receipt) => {
                self.outcome.fact = None;
                self.outcome.retry_after = None;
                self.outcome.failures = 0;
                self.observe_receipt(receipt);
                self.accepting = false;
                self.proof.clear();
            }
            Err(error) => {
                self.outcome.failures = self.outcome.failures.saturating_add(1);
                let delay = if error.code == "budget_busy" {
                    Duration::from_millis(250)
                } else {
                    Duration::from_secs(1 << self.outcome.failures.min(5))
                };
                self.outcome.retry_after = Some(now + delay);
                self.receipt.error_code = Some("receipt_pending".into());
            }
        }
    }

    pub(crate) fn observe_receipt(&mut self, mut receipt: Receipt) {
        if self.outcome_pending()
            || !self.receipt.state.is_active()
            || self.receipt.state == RequestState::Accepted
                && receipt.state == RequestState::PendingConfirmation
        {
            return;
        }
        receipt.job_id = receipt.job_id.or_else(|| self.receipt.job_id.clone());
        receipt.native_operation_id = receipt
            .native_operation_id
            .or_else(|| self.receipt.native_operation_id.clone());
        self.receipt = receipt;
        if !self.receipt.state.is_active() {
            self.proof.clear();
            self.accepting = false;
        }
    }

    pub(crate) fn matches_generation(&self, response: &serde_json::Value) -> bool {
        let mut receipt = self.receipt.clone();
        if let Some(OutcomeFact::Completed(outcome)) = &self.outcome.fact {
            receipt.job_id = outcome.job_id.clone().or(receipt.job_id);
        }
        generation_matches(&receipt, self.generation_request_id.as_deref(), response)
    }
}

pub(crate) fn generation_matches(
    receipt: &Receipt,
    submission_request_id: Option<&str>,
    response: &serde_json::Value,
) -> bool {
    let job = if response["job"].is_object() {
        &response["job"]
    } else {
        response
    };
    let Some(job_id) = job["jobId"].as_str() else {
        return false;
    };
    match receipt.job_id.as_deref() {
        Some(known) => known == job_id,
        None => submission_request_id
            .is_some_and(|expected| response["generationRequestId"].as_str() == Some(expected)),
    }
}
#[derive(Default)]
pub(crate) struct NativeExternal {
    pub panel: Panel,
    pub targets: BTreeMap<String, Target>,
    pub requests: BTreeMap<String, Pending>,
}
impl NativeExternal {
    pub(crate) fn has_pending_outcomes(&self) -> bool {
        self.requests.values().any(Pending::outcome_pending)
    }
    pub(crate) fn flush_outcomes(
        &mut self,
        service: &super::service::LibraryService,
        now: Instant,
        complete: impl Fn(String, u64, Result<Receipt>) + Clone + Send + 'static,
    ) {
        for (id, entry) in &mut self.requests {
            let Some((revision, fact)) = entry.begin_outcome(now) else {
                continue;
            };
            let completion_id = id.clone();
            let origin = entry.origin.clone();
            let complete = complete.clone();
            let queued = service.external_request(move |jobs| async move {
                let result = async {
                    let jobs = jobs?;
                    fact.persist(
                        &AiRequests::new(jobs.library()),
                        &origin,
                        &completion_id,
                        super::library::now_secs(),
                    )
                    .await
                }
                .await;
                complete(completion_id, revision, result);
            });
            if let Err(error) = queued {
                entry.finish_outcome(revision, Err(error), now);
            }
        }
    }
    pub(crate) fn set_owner(&mut self, owner: u64) {
        if self.panel.owner != owner {
            self.panel.owner = owner;
            self.panel.open = false;
            self.panel.epoch = self.panel.epoch.wrapping_add(1);
            self.targets.clear();
        }
    }
    pub(crate) fn set_panel(&mut self, open: bool) {
        if self.panel.open != open {
            self.panel.open = open;
            self.panel.epoch = self.panel.epoch.wrapping_add(1);
            self.targets.clear();
        }
    }
    pub(crate) fn prune(&mut self, now: Instant) {
        self.targets.retain(|_, target| target.expires > now);
        let seconds = super::library::now_secs();
        self.requests.retain(|_, entry| {
            entry.receipt.expires_at > seconds
                || entry.accepting
                || entry.outcome_pending()
                || entry.receipt.state == hertz_wallpaper::external_requests::RequestState::Accepted
        });
        while self.requests.len() > 16 {
            let oldest = self
                .requests
                .iter()
                .filter(|(_, entry)| {
                    !entry.receipt.state.is_active() && !entry.accepting && !entry.outcome_pending()
                })
                .min_by_key(|(_, entry)| entry.receipt.created_at)
                .map(|(id, _)| id.clone());
            let Some(id) = oldest else {
                break;
            };
            self.requests.remove(&id);
        }
    }
    pub(crate) fn target(
        &self,
        input: &hertz_wallpaper::external_requests::SwitchRequest,
        forward: &Forward,
        binding: &ai::Binding,
        now: Instant,
    ) -> Result<ai::Action> {
        let target = self
            .targets
            .get(&input.target_handle)
            .ok_or_else(target_stale)?;
        check_target(
            TargetIdentity {
                subject: &target.subject,
                revision: &target.revision,
                binding: &target.binding,
            },
            TargetIdentity {
                subject: &forward.subject,
                revision: &forward.credential_revision,
                binding,
            },
            target.expires,
            now,
        )?;
        if target.service != forward.service || target.panel_epoch != self.panel.epoch {
            return Err(target_stale());
        }
        target
            .actions
            .iter()
            .find(|action| {
                action.work_key == input.work_key && action.package_hash == input.package_hash
            })
            .cloned()
            .ok_or_else(target_stale)
    }
    pub(crate) fn catalog(
        &mut self,
        forward: &Forward,
        binding: ai::Binding,
        catalog: ai::ExternalCatalog,
        now: Instant,
    ) -> Result<serde_json::Value> {
        self.prune(now);
        if self.targets.len() >= 128 {
            return Err(JobError::new("budget_busy", "目录目标句柄暂满，请稍后读取"));
        }
        let handle = ai::random_256()?;
        let works: Vec<_> = catalog
            .items
            .iter()
            .map(|item| {
                serde_json::json!({"workKey":item.action.work_key,
            "packageHash":item.action.package_hash,"title":item.action.title,"tags":item.tags,
            "kind":item.kind,"version":item.action.version})
            })
            .collect();
        self.targets.insert(
            handle.clone(),
            Target {
                subject: forward.subject.clone(),
                revision: forward.credential_revision.clone(),
                service: forward.service.clone(),
                panel_epoch: self.panel.epoch,
                binding,
                actions: catalog.items.into_iter().map(|item| item.action).collect(),
                expires: now + Duration::from_secs(60),
            },
        );
        Ok(
            serde_json::json!({"works":works,"targetHandle":handle,"expiresAt":super::library::now_secs()+60,
            "nextCursor":catalog.next_cursor}),
        )
    }
}
pub(crate) fn target_stale() -> JobError {
    JobError::new(
        "ai_target_changed",
        "目录目标已变化或到期，请重新读取目录并申请",
    )
}
pub(crate) fn desktop_unavailable() -> JobError {
    JobError::new("desktop_unavailable", "请打开当前原生设置中的 AI 面板")
}
pub(crate) fn current_service(profile: &crate::config::Profile) -> Result<ServiceIdentity> {
    let profile = profile.normalized().map_err(|_| desktop_unavailable())?;
    let discovery = crate::bridge::read_discovery(&profile).map_err(|_| desktop_unavailable())?;
    let identity =
        hertz_desktop_ipc::windows::Identity::current().map_err(|_| desktop_unavailable())?;
    let generation = hertz_desktop_ipc::windows::process_generation(discovery.pid)
        .map_err(|_| desktop_unavailable())?;
    let edition = discovery
        .edition
        .filter(|value| matches!(value.as_str(), "standard" | "full"))
        .ok_or_else(desktop_unavailable)?;
    if discovery.protocol_version != 1
        || discovery.port == 0
        || profile.edition() != "custom" && profile.edition() != edition
    {
        return Err(desktop_unavailable());
    }
    Ok(ServiceIdentity {
        pid: discovery.pid,
        generation,
        server_instance_id: discovery
            .server_instance_id
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .ok_or_else(desktop_unavailable)?,
        profile_digest: hertz_wallpaper::pairing::profile_digest(&edition, profile.data_dir()),
        edition,
        user_sid: identity.user_sid,
        windows_session_id: identity.windows_session_id,
    })
}
pub(crate) fn native_binding(settings_generation: u64) -> Result<serde_json::Value> {
    let pid = std::process::id();
    let generation =
        hertz_desktop_ipc::windows::process_generation(pid).map_err(|_| desktop_unavailable())?;
    Ok(
        serde_json::json!({"nativePid":pid,"nativeGeneration":generation,"settingsGeneration":settings_generation}),
    )
}

pub(crate) struct TargetIdentity<'a> {
    pub subject: &'a str,
    pub revision: &'a str,
    pub binding: &'a ai::Binding,
}
pub(crate) fn check_target(
    bound: TargetIdentity<'_>,
    current: TargetIdentity<'_>,
    expires: Instant,
    now: Instant,
) -> Result<()> {
    if bound.subject != current.subject
        || bound.revision != current.revision
        || bound.binding != current.binding
        || expires <= now
    {
        return Err(target_stale());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending() -> Pending {
        let request = hertz_wallpaper::external_requests::parse(
            "generate",
            br#"{"operationId":"operation-a","brief":"coast","outputKind":"builtin"}"#,
        )
        .unwrap();
        Pending {
            owner: 1,
            origin: Origin::new(
                &"a".repeat(64),
                &"b".repeat(64),
                &"c".repeat(64),
                "assistant",
            )
            .unwrap(),
            digest: request.digest(),
            request,
            receipt: Receipt {
                request_id: "request-a".into(),
                operation_id: "operation-a".into(),
                state: RequestState::Accepted,
                output_kind: Some(hertz_wallpaper::generation::WallpaperGenerationKind::Builtin),
                job_id: None,
                native_operation_id: None,
                created_at: 100,
                expires_at: 220,
                error_code: None,
            },
            service: service(),
            panel_epoch: 1,
            binding: None,
            action: None,
            proof: "proof".into(),
            generation_request_id: Some("submission-a".into()),
            accepting: false,
            outcome: Default::default(),
        }
    }

    fn outcome(state: RequestState) -> OutcomeFact {
        OutcomeFact::Completed(Outcome {
            state,
            job_id: Some("job-a".into()),
            native_operation_id: None,
            error_code: None,
        })
    }

    #[test]
    fn full_management_slots_retain_committed_outcome_until_original_worker_can_persist() {
        use super::super::{
            decode_probe::ProbeClient, library::tempfileish, service::LibraryService,
        };
        let root = tempfileish::temp_dir("external-outcome-slots");
        let service = LibraryService::start(
            root.path().to_path_buf(),
            ProbeClient::testing(|_, _| Box::pin(async { Ok(()) })),
        );
        let mut entry = pending();
        let origin = entry.origin.clone();
        let request = entry.request.clone();
        let (admitted, receive) = std::sync::mpsc::sync_channel(1);
        let (release, held) = tokio::sync::oneshot::channel();
        service
            .external_request(move |jobs| async move {
                let jobs = jobs.unwrap();
                let store = AiRequests::new(jobs.library());
                let now = super::super::library::now_secs();
                let pending = store.admit(&origin, &request, now).await.unwrap();
                let accepted = store
                    .accept(
                        &origin,
                        &pending.request_id,
                        &request.digest(),
                        "acceptance-a",
                        now,
                    )
                    .await
                    .unwrap();
                admitted.send(accepted).unwrap();
                let _ = held.await;
            })
            .unwrap();
        entry.receipt = receive.recv_timeout(Duration::from_secs(10)).unwrap();
        let id = entry.receipt.request_id.clone();
        let occupied: Vec<_> = (0..3).map(|_| service.reserve().unwrap()).collect();
        entry.retain_outcome(outcome(RequestState::Succeeded));
        let mut native = NativeExternal::default();
        native.requests.insert(id.clone(), entry);
        let now = Instant::now();
        let (send, receive) = std::sync::mpsc::channel();
        let complete = move |id, revision, result| {
            send.send((id, revision, result)).unwrap();
        };
        native.flush_outcomes(&service, now, complete.clone());
        assert!(native.has_pending_outcomes());
        let entry = native.requests.get_mut(&id).unwrap();
        assert!(entry.outcome.in_flight.is_none());
        assert_eq!(entry.receipt.error_code.as_deref(), Some("receipt_pending"));
        entry.receipt.expires_at = 0;
        entry.accepting = false;
        native.prune(now);
        assert!(
            native.requests.contains_key(&id),
            "pruning cannot discard unsaved facts"
        );
        assert!(receive.try_recv().is_err());
        release.send(()).unwrap();
        drop(occupied);
        native.flush_outcomes(&service, now + Duration::from_secs(1), complete.clone());
        let (id, revision, result) = receive.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(result.as_ref().unwrap().state, RequestState::Succeeded);
        native
            .requests
            .get_mut(&id)
            .unwrap()
            .finish_outcome(revision, result, now);
        assert!(!native.has_pending_outcomes());
        native.flush_outcomes(&service, now + Duration::from_secs(2), complete);
        assert!(
            receive.try_recv().is_err(),
            "a persisted fact must not be resubmitted"
        );
        let origin = native.requests[&id].origin.clone();
        let (send, receive) = std::sync::mpsc::channel();
        service
            .external_request(move |jobs| async move {
                let jobs = jobs.unwrap();
                let receipt = AiRequests::new(jobs.library())
                    .get(&origin, &id, super::super::library::now_secs())
                    .await
                    .unwrap();
                send.send(receipt).unwrap();
            })
            .unwrap();
        let persisted = receive.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(persisted.state, RequestState::Succeeded);
        assert_eq!(persisted.job_id.as_deref(), Some("job-a"));
    }

    #[test]
    fn accepted_ack_and_poll_cannot_erase_newer_terminal_fact() {
        let mut entry = pending();
        let now = Instant::now();
        entry.retain_outcome(outcome(RequestState::Accepted));
        let (accepted_revision, _) = entry.begin_outcome(now).unwrap();
        entry.retain_outcome(outcome(RequestState::Succeeded));
        assert!(
            entry.begin_outcome(now).is_none(),
            "only one write per request may be in flight"
        );
        let accepted = Receipt {
            job_id: Some("job-a".into()),
            ..entry.receipt.clone()
        };
        entry.observe_receipt(accepted.clone());
        entry.retain_outcome(outcome(RequestState::Accepted));
        entry.finish_outcome(accepted_revision, Ok(accepted.clone()), now);
        assert!(entry.outcome_pending());
        let (terminal_revision, fact) = entry.begin_outcome(now).unwrap();
        assert_ne!(terminal_revision, accepted_revision);
        assert_eq!(fact.state(), RequestState::Succeeded);
        entry.finish_outcome(accepted_revision, Ok(accepted.clone()), now);
        assert!(
            entry.begin_outcome(now).is_none(),
            "duplicate older acknowledgements cannot release the new write"
        );
        entry.finish_outcome(
            terminal_revision,
            Ok(Receipt {
                state: RequestState::Succeeded,
                error_code: None,
                ..accepted.clone()
            }),
            now,
        );
        entry.observe_receipt(accepted);
        entry.retain_outcome(outcome(RequestState::Accepted));
        assert_eq!(entry.receipt.state, RequestState::Succeeded);
        assert!(!entry.outcome_pending());
    }

    #[test]
    fn database_failure_keeps_the_fact_with_bounded_retry_frequency() {
        let mut entry = pending();
        let mut now = Instant::now();
        entry.retain_outcome(outcome(RequestState::Succeeded));
        for attempt in 1..=12 {
            let (revision, fact) = entry.begin_outcome(now).unwrap();
            assert_eq!(fact.state(), RequestState::Succeeded);
            entry.finish_outcome(revision, Err(JobError::database("unavailable")), now);
            let delay = Duration::from_secs(1 << attempt.min(5));
            assert!(entry.outcome_pending());
            assert_eq!(entry.receipt.error_code.as_deref(), Some("receipt_pending"));
            assert!(entry
                .begin_outcome(now + delay - Duration::from_millis(1))
                .is_none());
            now += delay;
        }
    }

    #[tokio::test]
    async fn delayed_rejection_reads_durable_expiry_without_reopening_confirmation() {
        use super::super::library::{tempfileish, Library};
        let root = tempfileish::temp_dir("external-outcome-expiry");
        let library = Library::open(root.path()).await.unwrap();
        let store = AiRequests::new(&library);
        let mut entry = pending();
        entry.receipt = store
            .admit(&entry.origin, &entry.request, 100)
            .await
            .unwrap();
        entry.retain_outcome(OutcomeFact::Rejected);
        assert!(entry.outcome_pending());
        assert!(entry.accepting);
        assert!(entry.proof.is_empty());
        let now = Instant::now();
        let (revision, fact) = entry.begin_outcome(now).unwrap();
        let result = fact
            .persist(&store, &entry.origin, &entry.receipt.request_id, 221)
            .await;
        assert_eq!(result.as_ref().unwrap().state, RequestState::Expired);
        entry.finish_outcome(revision, result, now);
        assert!(!entry.outcome_pending());
        assert_eq!(entry.receipt.state, RequestState::Expired);
        library.pool().close().await;
    }

    #[tokio::test]
    async fn failed_acceptance_reconciles_pending_expired_and_committed_receipts() {
        use super::super::library::{tempfileish, Library};
        for (accepted, seconds, expected) in [
            (false, 101, RequestState::PendingConfirmation),
            (false, 221, RequestState::Expired),
            (true, 101, RequestState::Failed),
        ] {
            let root = tempfileish::temp_dir("external-acceptance-reconcile");
            let library = Library::open(root.path()).await.unwrap();
            let store = AiRequests::new(&library);
            let mut entry = pending();
            entry.receipt = store
                .admit(&entry.origin, &entry.request, 100)
                .await
                .unwrap();
            if accepted {
                store
                    .accept(
                        &entry.origin,
                        &entry.receipt.request_id,
                        &entry.request.digest(),
                        "accepted-once",
                        100,
                    )
                    .await
                    .unwrap();
            }
            entry.retain_outcome(OutcomeFact::AcceptanceFailed(
                "ai_request_state_changed".into(),
            ));
            let now = Instant::now();
            let (revision, fact) = entry.begin_outcome(now).unwrap();
            let result = fact
                .persist(&store, &entry.origin, &entry.receipt.request_id, seconds)
                .await;
            assert_eq!(result.as_ref().unwrap().state, expected);
            entry.finish_outcome(revision, result, now);
            assert!(!entry.outcome_pending());
            assert!(!entry.accepting);
            assert_eq!(entry.receipt.state, expected);
            assert_eq!(
                store
                    .get(&entry.origin, &entry.receipt.request_id, seconds)
                    .await
                    .unwrap()
                    .state,
                expected
            );
            library.pool().close().await;
        }
    }

    #[test]
    fn unknown_generation_receipt_cannot_claim_an_unrelated_local_job() {
        let receipt = Receipt {
            request_id: "external-a".into(),
            operation_id: "operation-a".into(),
            state: hertz_wallpaper::external_requests::RequestState::Accepted,
            created_at: 100,
            expires_at: 220,
            output_kind: Some(hertz_wallpaper::generation::WallpaperGenerationKind::Builtin),
            job_id: None,
            native_operation_id: None,
            error_code: Some("receipt_pending".into()),
        };
        let unrelated = serde_json::json!({"jobId":"local-job-b","state":"succeeded"});
        assert!(!generation_matches(
            &receipt,
            Some("submission-a"),
            &unrelated
        ));
        let wrong_submission = serde_json::json!({"generationRequestId":"submission-b","job":{"jobId":"local-job-b","state":"succeeded"}});
        assert!(!generation_matches(
            &receipt,
            Some("submission-a"),
            &wrong_submission
        ));
        let recovered = serde_json::json!({"generationRequestId":"submission-a","job":{"jobId":"external-job-a","state":"running"}});
        assert!(generation_matches(
            &receipt,
            Some("submission-a"),
            &recovered
        ));
        assert!(!generation_matches(&receipt, None, &recovered));
        let known = Receipt {
            job_id: Some("external-job-a".into()),
            ..receipt
        };
        assert!(generation_matches(
            &known,
            None,
            &serde_json::json!({"jobId":"external-job-a","state":"succeeded"})
        ));
        assert!(!generation_matches(
            &known,
            Some("submission-a"),
            &unrelated
        ));
    }
    fn service() -> ServiceIdentity {
        ServiceIdentity {
            pid: 7,
            generation: "generation".into(),
            server_instance_id: "service".into(),
            edition: "full".into(),
            profile_digest: "a".repeat(64),
            user_sid: "S-1-5-21".into(),
            windows_session_id: 1,
        }
    }
    fn binding() -> ai::Binding {
        ai::Binding {
            principal: "S-1-5-21".into(),
            settings_session: 2,
            host_generation: "native".into(),
            profile_digest: "b".repeat(64),
            target_group_id: "group".into(),
            selection_generation: 1,
            topology_revision: "topology".into(),
            expected_config_revision: 1,
            context_digest: "context".into(),
        }
    }
    #[test]
    fn external_forward_rejects_wrong_service_pid_instance_profile_and_generation() {
        let current = service();
        assert!(check_service(&current, &current, current.pid).is_ok());
        assert!(check_service(&current, &current, 8).is_err());
        for mutate in [0, 1, 2, 3, 4, 5] {
            let mut supplied = current.clone();
            match mutate {
                0 => supplied.pid += 1,
                1 => supplied.server_instance_id.push('x'),
                2 => supplied.profile_digest.push('x'),
                3 => supplied.generation.push('x'),
                4 => supplied.user_sid.push('x'),
                _ => supplied.windows_session_id += 1,
            }
            assert!(check_service(&supplied, &current, current.pid).is_err());
        }
    }
    #[test]
    fn external_forward_requires_current_open_visible_panel() {
        let panel = Panel {
            owner: 2,
            epoch: 1,
            open: true,
        };
        assert!(panel.permits(2, true));
        assert!(!panel.permits(2, false));
        assert!(!panel.permits(3, true));
        assert!(!Panel::default().permits(0, true));
        assert!(!Panel {
            open: false,
            ..panel
        }
        .permits(2, true));
    }
    #[test]
    fn opaque_target_rejects_cross_grant_rotation_expiry_and_topology_change() {
        let bound = binding();
        let now = Instant::now();
        let facts = |subject, revision, binding| TargetIdentity {
            subject,
            revision,
            binding,
        };
        assert!(check_target(
            facts("grant", "revision", &bound),
            facts("grant", "revision", &bound),
            now + std::time::Duration::from_secs(60),
            now
        )
        .is_ok());
        assert!(check_target(
            facts("grant", "revision", &bound),
            facts("other", "revision", &bound),
            now + std::time::Duration::from_secs(60),
            now
        )
        .is_err());
        assert!(check_target(
            facts("grant", "revision", &bound),
            facts("grant", "rotated", &bound),
            now + std::time::Duration::from_secs(60),
            now
        )
        .is_err());
        assert!(check_target(
            facts("grant", "revision", &bound),
            facts("grant", "revision", &bound),
            now,
            now
        )
        .is_err());
        let mut changed = bound.clone();
        changed.topology_revision.push('x');
        assert!(check_target(
            facts("grant", "revision", &bound),
            facts("grant", "revision", &changed),
            now + std::time::Duration::from_secs(60),
            now
        )
        .is_err());
    }
}
