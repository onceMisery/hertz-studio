// SPDX-License-Identifier: MIT
//! Request-bound presentation pauses. These are not provider execution slots.
use super::*;
use std::collections::BTreeMap;

#[derive(Default)]
pub(super) struct Pauses {
    leases: BTreeMap<String, Lease>,
    release: Option<&'static str>,
    // Released presentation leases do not prove external inference has exited.
    // Keep a bounded set of identities so a later matching completion can resolve
    // them. Overflow stays conservative until this native session is destroyed.
    unresolved: BTreeMap<String, (u64, Option<String>)>,
    unresolved_overflow: bool,
}
struct Lease {
    epoch: u64,
    job: Option<String>,
    deadline: Instant,
    submitted: bool,
    uncertain: bool,
}

impl Pauses {
    pub(super) fn prepare(
        &mut self,
        epoch: u64,
        request: &str,
        deadline: Instant,
        now: Instant,
    ) -> Result<()> {
        self.expire(now);
        if self.leases.contains_key(request) {
            return Ok(());
        }
        if self.leases.len() >= 32 {
            return Err(error("ai_busy", "请先恢复或等待之前的生成暂停结束"));
        }
        self.leases.insert(
            request.into(),
            Lease {
                epoch,
                job: None,
                deadline,
                submitted: false,
                uncertain: false,
            },
        );
        self.release = None;
        Ok(())
    }
    pub(super) fn submitted(&mut self, epoch: u64, request: &str) {
        if let Some(lease) = self.leases.get_mut(request).filter(|l| l.epoch == epoch) {
            lease.submitted = true;
        }
    }
    pub(super) fn reject(&mut self, epoch: u64, request: &str) {
        if self.leases.get(request).is_some_and(|l| l.epoch == epoch) {
            self.leases.remove(request);
            self.release = Some("notDispatched");
        }
    }
    pub(super) fn failed_before_submission(&mut self, request: &str) {
        if self.leases.get(request).is_some_and(|l| !l.submitted) {
            self.leases.remove(request);
            self.release = Some("notDispatched");
        }
    }
    pub(super) fn interrupted(&mut self, epoch: u64) {
        for lease in self.leases.values_mut().filter(|l| l.epoch == epoch) {
            lease.uncertain = true;
        }
    }
    pub(super) fn observe(&mut self, epoch: u64, request: Option<&str>, job: &Value) {
        let Some(id) = job["jobId"]
            .as_str()
            .filter(|id| super::super::api::valid_id(id))
        else {
            return;
        };
        if let Some(request) = request {
            if let Some(lease) = self.leases.get_mut(request).filter(|l| l.epoch == epoch) {
                if lease.job.as_deref().is_some_and(|old| old != id) {
                    return;
                }
                lease.job = Some(id.into());
            }
        }
        let terminal = matches!(
            job["state"].as_str(),
            Some("succeeded" | "cancelled" | "failed" | "interrupted" | "expired")
        );
        let stopped =
            job["state"] == "succeeded" || terminal && job["dispatchState"] == "not_dispatched";
        if stopped {
            self.unresolved
                .retain(|request_id, (released_epoch, released_job)| {
                    *released_epoch != epoch
                        || !released_job
                            .as_deref()
                            .map_or(request == Some(request_id.as_str()), |known| known == id)
                });
        }
        let mut released = false;
        self.leases.retain(|_, lease| {
            if lease.epoch != epoch || lease.job.as_deref() != Some(id) {
                return true;
            }
            if stopped {
                released = true;
                return false;
            }
            if terminal {
                lease.uncertain = true;
            }
            true
        });
        if released {
            self.release = Some("completed");
        }
    }
    fn remember_unresolved(&mut self, request: String, lease: Lease) {
        if !lease.submitted {
            return;
        }
        if self.unresolved.len() < 32 || self.unresolved.contains_key(&request) {
            self.unresolved.insert(request, (lease.epoch, lease.job));
        } else {
            self.unresolved_overflow = true;
        }
    }
    fn expire(&mut self, now: Instant) {
        let expired: Vec<_> = self
            .leases
            .iter()
            .filter(|(_, lease)| lease.deadline <= now)
            .map(|(id, _)| id.clone())
            .collect();
        for request in expired {
            let lease = self.leases.remove(&request).expect("expired lease");
            self.remember_unresolved(request, lease);
            self.release = Some("deadline");
        }
    }
    pub(super) fn active(&mut self, now: Instant) -> bool {
        self.expire(now);
        !self.leases.is_empty()
    }
    pub(super) fn snapshot(&mut self, now: Instant) -> Value {
        self.expire(now);
        let stopping = self.leases.values().any(|l| l.uncertain);
        json!({
            "active":!self.leases.is_empty(), "stopping":stopping,
            "externalMayRun":stopping || !self.unresolved.is_empty() || self.unresolved_overflow,
            "releaseReason":self.release,
            "requests":self.leases.iter().map(|(id, l)| json!({
                "requestId":id, "jobId":l.job,
                "remainingSeconds":l.deadline.saturating_duration_since(now).as_secs().saturating_add(1)
            })).collect::<Vec<_>>()
        })
    }
    pub(super) fn resume(&mut self, requests: &[String]) {
        let mut released = false;
        for request in requests {
            if let Some(lease) = self.leases.remove(request) {
                released = true;
                self.remember_unresolved(request.clone(), lease);
            }
        }
        if released {
            self.release = Some("explicit");
        }
    }
    pub(super) fn end_session(&mut self) {
        for (request, lease) in std::mem::take(&mut self.leases) {
            self.remember_unresolved(request, lease);
        }
        self.release = Some("sessionEnded");
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Confirm {
    pub confirmation_token: String,
    pub pause_dynamic: Option<bool>,
}

impl NativeGeneration {
    pub(crate) fn resume_pause(&self, payload: Value) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Resume {
            request_ids: Vec<String>,
        }
        let input: Resume =
            serde_json::from_value(payload).map_err(|_| error("invalid_input", "恢复参数无效"))?;
        if input.request_ids.is_empty()
            || input.request_ids.len() > 32
            || input
                .request_ids
                .iter()
                .any(|id| !super::super::api::valid_id(id))
        {
            return Err(error("invalid_input", "恢复请求标识无效"));
        }
        let mut state = lock(&self.state);
        state.pauses.resume(&input.request_ids);
        Ok(state.pauses.snapshot(Instant::now()))
    }
    /// Called on the event thread after consent, before starting the HTTP worker.
    /// Presentation policy consumes the lease before dispatch can begin.
    pub(crate) fn prepare_pause(&self, owner: u64, payload: &Value) -> Result<()> {
        if self.busy.load(Ordering::Acquire) {
            return Err(error("ai_busy", "上一操作尚未完成"));
        }
        let input: Confirm = serde_json::from_value(payload.clone())
            .map_err(|_| error("invalid_input", "确认参数无效"))?;
        let now = Instant::now();
        let mut state = lock(&self.state);
        let q = state
            .quote
            .as_ref()
            .filter(|q| q.owner == owner && q.token == input.confirmation_token && q.expires > now)
            .ok_or_else(|| error("quote_expired", "先重新报价并确认"))?;
        if !input.pause_dynamic.unwrap_or(true) || q.summary["provider"] != "ollama-local" {
            return Ok(());
        }
        let seconds = q.summary["maximumWaitSeconds"]
            .as_u64()
            .filter(|n| (1..=600).contains(n))
            .ok_or_else(|| error("invalid_response", "本地生成报价缺少有效期限"))?;
        let session_deadline = state
            .connection
            .as_ref()
            .and_then(|c| c.expires)
            .filter(|t| *t > now)
            .ok_or_else(|| error("wallpaper_session_expired", "生成连接已到期"))?;
        let deadline = (now + Duration::from_secs(seconds)).min(session_deadline);
        let request = q.request_id.clone();
        let epoch = state.epoch;
        state.pauses.prepare(epoch, &request, deadline, now)
    }
    pub(crate) fn pause_active(&self) -> bool {
        lock(&self.state).pauses.active(Instant::now())
    }
    pub(crate) fn end_presentation_session(&self) {
        lock(&self.state).pauses.end_session();
    }
}
