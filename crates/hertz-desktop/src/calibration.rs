// SPDX-License-Identifier: MIT
//! Native-only UI credential and bounded current-source request. Never writes an offset.
use crate::{config::Profile, feed::Snapshot};
use serde_json::{json, Value};
use std::{
    io::Read,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
static NATIVE_SESSION: OnceLock<String> = OnceLock::new();
#[derive(Clone)]
pub(crate) struct Pending {
    pub id: String,
    pub session: String,
    pub track: String,
    pub generation: String,
    pub cancel: Arc<AtomicBool>,
    pub binding: Arc<Mutex<String>>,
    pub started: Instant,
    pub deadline_monotonic_ms: u64,
    native_session: String,
    request_sequence: u64,
}
impl Pending {
    pub(crate) fn new(snapshot: &Snapshot) -> Option<Self> {
        let deadline_monotonic_ms =
            hertz_desktop_ipc::monotonic::now_millis()?.checked_add(5000)?;
        // Acceptance order belongs to this native process, before any transport
        // can wait or be overtaken by a later click. A restart gets a new subject.
        // Rust 1.88 does not have stable try_update; preserve its atomic API.
        #[allow(deprecated)]
        let request_sequence = SEQUENCE
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_add(1))
            .ok()?
            + 1;
        let started = Instant::now();
        Some(Self {
            id: uuid::Uuid::new_v4().to_string(),
            session: snapshot.server.session.clone(),
            track: snapshot.track.as_ref()?.id.clone(),
            generation: snapshot.generation.clone(),
            cancel: Arc::new(AtomicBool::new(false)),
            binding: Arc::new(Mutex::new(String::new())),
            started,
            deadline_monotonic_ms,
            native_session: NATIVE_SESSION
                .get_or_init(|| uuid::Uuid::new_v4().to_string())
                .clone(),
            request_sequence,
        })
    }
    pub(crate) fn cancel(self, profile: Profile) {
        self.cancel.store(true, Ordering::Release);
        let binding = self
            .binding
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if !binding.is_empty() {
            std::thread::spawn(move || {
                let _ = call(
                    &profile,
                    &self.session,
                    "cancel",
                    json!({"bindingId":binding,"requestId":self.id}),
                    Instant::now() + Duration::from_millis(500),
                    &self.cancel,
                );
            });
        }
    }
    pub(crate) fn matches(&self, snapshot: &Snapshot) -> bool {
        self.session == snapshot.server.session
            && snapshot.track.as_ref().is_some_and(|t| t.id == self.track)
            && self.generation == snapshot.generation
    }
}
fn call(
    profile: &Profile,
    session: &str,
    op: &str,
    mut body: Value,
    deadline: Instant,
    cancel: &Arc<AtomicBool>,
) -> Result<Value, &'static str> {
    if cancel.load(Ordering::Acquire) && op != "cancel" {
        return Err("cancelled");
    }
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        return Err("timeout");
    }
    if serde_json::to_vec(&body).map_or(true, |b| b.len() > 4096) {
        return Err("invalid-request");
    }
    if matches!(op, "bind" | "request")
        && hertz_desktop_ipc::monotonic::remaining(
            body["deadlineClock"].as_str().unwrap_or_default(),
            body["deadlineMonotonicMs"].as_u64().unwrap_or(0),
        )
        .is_none()
    {
        return Err("timeout");
    }
    if crate::config::is_dbx(profile) {
        return crate::dbx_feed::calibration_call(profile, session, op, body, deadline, cancel);
    }
    let discovery = crate::bridge::read_discovery(profile).map_err(|_| "receiver-unavailable")?;
    if discovery.server_instance_id.as_deref() != Some(session)
        || (profile.edition() != "custom"
            && discovery.edition.as_deref() != Some(profile.edition()))
    {
        return Err("track-changed");
    }
    let key = crate::bridge::read_key(
        std::path::Path::new(profile.data_dir()),
        "desktop-lyrics-calibration-key",
        "校准UI",
    )
    .map_err(|_| "permission-required")?;
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        return Err("timeout");
    }
    if op == "request" {
        let wire_left = hertz_desktop_ipc::monotonic::remaining(
            body["deadlineClock"].as_str().unwrap_or_default(),
            body["deadlineMonotonicMs"].as_u64().unwrap_or(0),
        )
        .ok_or("timeout")?;
        body["remainingMs"] = (left.as_millis() as u64).min(wire_left).into();
    }
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(left.min(Duration::from_secs(1)))
        .timeout(left)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "receiver-unavailable")?;
    let reply = client
        .post(format!(
            "http://127.0.0.1:{}/v1/desktop-lyrics/calibration/{op}",
            discovery.port
        ))
        .header("Authorization", format!("LyricsCalibration {key}"))
        .json(&body)
        .send()
        .map_err(|_| "timeout")?;
    let status = reply.status();
    let mut bytes = Vec::new();
    reply
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| "timeout")?;
    if bytes.len() > 4096 {
        return Err("invalid-response");
    }
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("permission-required");
    }
    let reply: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid-response")?;
    if !status.is_success() {
        return Err(match reply["error"]["code"].as_str() {
            Some("track-changed") => "track-changed",
            Some("receiver-unavailable") => "receiver-unavailable",
            Some("room-active") => "room-active",
            Some("permission-required") => "permission-required",
            _ => "timeout",
        });
    }
    Ok(reply)
}
pub(crate) fn run(profile: Profile, pending: Pending) -> Value {
    let Pending {
        id,
        session,
        track,
        generation,
        cancel,
        binding: binding_shared,
        started,
        deadline_monotonic_ms,
        native_session,
        request_sequence,
    } = pending;
    let deadline = started + Duration::from_secs(5);
    let mut binding = String::new();
    let result = (|| {
        let reply = call(
            &profile,
            &session,
            "bind",
            json!({"deadlineClock":hertz_desktop_ipc::monotonic::CLOCK,"deadlineMonotonicMs":deadline_monotonic_ms,"nativeSession":native_session,"requestSequence":request_sequence,"session":session}),
            deadline,
            &cancel,
        )?;
        binding = reply["bindingId"]
            .as_str()
            .ok_or("invalid-response")?
            .into();
        *binding_shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = binding.clone();
        let body = json!({"version":1,"requestId":id,"bindingId":binding,"requestSequence":request_sequence,"remainingMs":deadline.saturating_duration_since(Instant::now()).as_millis() as u64,"deadlineClock":hertz_desktop_ipc::monotonic::CLOCK,"deadlineMonotonicMs":deadline_monotonic_ms,"session":session,"trackId":track,"generation":generation});
        let mut reply = call(&profile, &session, "request", body, deadline, &cancel)?;
        loop {
            if cancel.load(Ordering::Acquire) {
                return Err("cancelled");
            }
            if Instant::now() >= deadline
                || hertz_desktop_ipc::monotonic::remaining(
                    hertz_desktop_ipc::monotonic::CLOCK,
                    deadline_monotonic_ms,
                )
                .is_none()
            {
                return Err("timeout");
            }
            match reply["state"].as_str() {
                Some("accepted") => {}
                Some("shown") => return Ok("shown"),
                Some("focus-unavailable") => return Ok("focus-unavailable"),
                Some("track-changed") => return Err("track-changed"),
                Some("permission-required") => return Err("permission-required"),
                Some("receiver-unavailable") => return Err("receiver-unavailable"),
                Some("room-active") => return Err("room-active"),
                Some("lyrics-unavailable") => return Err("lyrics-unavailable"),
                _ => return Err("timeout"),
            }
            std::thread::park_timeout(
                Duration::from_millis(80).min(deadline.saturating_duration_since(Instant::now())),
            );
            reply = call(
                &profile,
                &session,
                "result",
                json!({"bindingId":binding,"requestId":id}),
                deadline,
                &cancel,
            )?;
        }
    })();
    if result.is_err() && !binding.is_empty() {
        let _ = call(
            &profile,
            &session,
            "cancel",
            json!({"bindingId":binding,"requestId":id}),
            Instant::now() + Duration::from_millis(500),
            &cancel,
        );
    }
    json!({"requestId":id,"state":result.unwrap_or_else(|e|e)})
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn calibration_native_acceptance_fixes_process_subject_and_sequence_before_io() {
        let snapshot: Snapshot = serde_json::from_value(json!({"protocol":1,"seq":1,"server":{"session":"source","edition":"standard","version":"test"},"generation":"1","positionMs":0,"durationMs":null,"playing":false,"buffering":false,"track":{"id":"first","title":"First"},"lyrics":{"status":"ready"}})).unwrap();
        let a = Pending::new(&snapshot).unwrap();
        let b = Pending::new(&snapshot).unwrap();
        assert_eq!(a.native_session, b.native_session);
        assert!(uuid::Uuid::parse_str(&a.native_session).is_ok());
        assert!(a.request_sequence < b.request_sequence);
        assert!(a.deadline_monotonic_ms <= b.deadline_monotonic_ms);
        let worker_a = a.clone();
        a.cancel.store(true, Ordering::Release);
        assert_eq!(worker_a.request_sequence, a.request_sequence);
        assert!(worker_a.cancel.load(Ordering::Acquire));
        assert!(worker_a.request_sequence < b.request_sequence);
    }
}
