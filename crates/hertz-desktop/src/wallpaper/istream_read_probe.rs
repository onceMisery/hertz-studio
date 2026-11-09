// SPDX-License-Identifier: MIT
//! Bounded debug observation of the original COM file Read. No resource ownership.
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::ThreadId;
use std::time::{Duration, Instant};

pub(crate) const MIN_HOLD_MS: u32 = 500;
pub(crate) const MAX_HOLD_MS: u32 = 30_000;
const MAX_ARM_MS: u64 = 45_000;
const MAX_SAFE_ID: u64 = 9_007_199_254_740_991;
static NEXT_STREAM: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
pub(crate) const PREFIX: &str = "decode_probe_read ";

/// One original Pending response's diagnostic assignment bit. Shared by natural
/// COM clones, with no file, permit, pin or scope reference in either direction.
pub(crate) struct NativeResponse {
    pub(crate) request_id: u64,
    pub(crate) controller_id: u64,
    assigned: std::sync::atomic::AtomicBool,
}
impl NativeResponse {
    pub(crate) fn new(request_id: u64, controller_id: u64) -> Arc<Self> {
        Arc::new(Self {
            request_id,
            controller_id,
            assigned: std::sync::atomic::AtomicBool::new(false),
        })
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadOwner {
    pub(crate) probe_id: u64,
    pub(crate) generation: u64,
    pub(crate) session: String,
    pub(crate) package_hash: String,
    pub(crate) entry_path: String,
    pub(crate) content_sha256: String,
    pub(crate) content_bytes: u64,
}

#[derive(Clone)]
pub(crate) struct StreamBinding {
    pub(crate) gate: Arc<ReadGate>,
    pub(crate) native_request_id: u64,
    pub(crate) native_controller_id: u64,
    pub(crate) stream_id: u64,
    pub(crate) parent_stream_id: Option<u64>,
    pub(crate) window_base: u64,
    pub(crate) window_len: u64,
    response: Arc<NativeResponse>,
}

impl StreamBinding {
    pub(crate) fn new(
        gate: Arc<ReadGate>,
        response: Arc<NativeResponse>,
        window: (u64, u64),
        parent: Option<u64>,
    ) -> Self {
        Self {
            gate,
            native_request_id: response.request_id,
            native_controller_id: response.controller_id,
            stream_id: NEXT_STREAM.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            parent_stream_id: parent,
            window_base: window.0,
            window_len: window.1,
            response,
        }
    }
}

#[derive(Clone, Copy, serde::Serialize)]
pub(crate) enum ReleaseReason {
    Explicit,
    Deadline,
    HostDrop,
    InternalFailure,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadProbeSnapshot {
    #[serde(flatten)]
    pub(crate) owner: ReadOwner,
    pub(crate) native_request_id: Option<u64>,
    pub(crate) native_controller_id: Option<u64>,
    pub(crate) response_assigned: bool,
    pub(crate) stream_id: Option<u64>,
    pub(crate) parent_stream_id: Option<u64>,
    pub(crate) window_base: Option<u64>,
    pub(crate) window_len: Option<u64>,
    pub(crate) phase: &'static str,
    pub(crate) hold_token: String,
    pub(crate) hold_ms: u32,
    pub(crate) entered_at_ms: Option<u64>,
    pub(crate) release_at_ms: Option<u64>,
    pub(crate) read_exited_at_ms: Option<u64>,
    pub(crate) hold_elapsed_ms: u64,
    pub(crate) release_reason: Option<ReleaseReason>,
    pub(crate) read_thread_id: Option<String>,
    pub(crate) ui_thread_id: String,
    pub(crate) on_ui_thread: Option<bool>,
    pub(crate) ui_thread_read_skipped: u64,
    pub(crate) ui_concurrent_stream_call_skipped: u64,
    pub(crate) read_offset: Option<u64>,
    pub(crate) requested_bytes: Option<u32>,
    pub(crate) physical_read_bytes: u64,
    pub(crate) read_in_flight: bool,
    pub(crate) file_held: bool,
    pub(crate) stream_slot_held: bool,
    pub(crate) read_permit_held: bool,
    pub(crate) read_exit_hresult: Option<String>,
    pub(crate) resources_reclaimed: bool,
}

struct State {
    snapshot: ReadProbeSnapshot,
    entered: Option<Instant>,
    released: bool,
    expired: bool,
    failed: bool,
}

pub(crate) struct ReadGate {
    pub(crate) owner: ReadOwner,
    ui_thread: ThreadId,
    armed: Instant,
    hold: Duration,
    arm: Duration,
    state: Mutex<State>,
    changed: Condvar,
}

impl ReadGate {
    pub(crate) fn new(owner: ReadOwner, hold_ms: u32, ui_thread: ThreadId) -> Option<Arc<Self>> {
        if !(MIN_HOLD_MS..=MAX_HOLD_MS).contains(&hold_ms)
            || !safe(owner.probe_id)
            || !safe(owner.generation)
            || owner.session != format!("probe-{}", owner.probe_id)
            || owner.package_hash.len() != 64
            || owner.entry_path.len() > 256
            || owner.content_sha256.len() != 64
            || owner.content_bytes == 0
        {
            return None;
        }
        Some(Self::create(
            owner,
            hold_ms,
            ui_thread,
            Duration::from_millis(hold_ms.into()),
            Duration::from_millis(MAX_ARM_MS),
        ))
    }

    fn create(
        owner: ReadOwner,
        hold_ms: u32,
        ui_thread: ThreadId,
        hold: Duration,
        arm: Duration,
    ) -> Arc<Self> {
        let snapshot = ReadProbeSnapshot {
            owner: owner.clone(),
            native_request_id: None,
            native_controller_id: None,
            response_assigned: false,
            stream_id: None,
            parent_stream_id: None,
            window_base: None,
            window_len: None,
            phase: "armed",
            hold_token: uuid::Uuid::new_v4().simple().to_string(),
            hold_ms,
            entered_at_ms: None,
            release_at_ms: None,
            read_exited_at_ms: None,
            hold_elapsed_ms: 0,
            release_reason: None,
            read_thread_id: None,
            ui_thread_id: format!("{ui_thread:?}"),
            on_ui_thread: None,
            ui_thread_read_skipped: 0,
            ui_concurrent_stream_call_skipped: 0,
            read_offset: None,
            requested_bytes: None,
            physical_read_bytes: 0,
            read_in_flight: false,
            file_held: false,
            stream_slot_held: false,
            read_permit_held: false,
            read_exit_hresult: None,
            resources_reclaimed: false,
        };
        Arc::new(Self {
            owner,
            ui_thread,
            armed: Instant::now(),
            hold,
            arm,
            state: Mutex::new(State {
                snapshot,
                entered: None,
                released: false,
                expired: false,
                failed: false,
            }),
            changed: Condvar::new(),
        })
    }

    #[cfg(test)]
    pub(crate) fn with_test_deadlines(
        owner: ReadOwner,
        hold: Duration,
        arm: Duration,
    ) -> Arc<Self> {
        Self::create(owner, MIN_HOLD_MS, std::thread::current().id(), hold, arm)
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|error| {
            let mut state = error.into_inner();
            self.release_locked(&mut state, ReleaseReason::InternalFailure);
            state
        })
    }
    fn ms(&self, at: Instant) -> u64 {
        at.saturating_duration_since(self.armed)
            .as_millis()
            .min(u64::MAX.into()) as u64
    }
    fn release_locked(&self, state: &mut State, reason: ReleaseReason) {
        if matches!(reason, ReleaseReason::InternalFailure) {
            state.failed = true;
        }
        if !state.released {
            state.released = true;
            state.snapshot.release_at_ms = Some(self.ms(Instant::now()));
            state.snapshot.release_reason = Some(reason);
        }
        self.changed.notify_all();
    }
    fn expire(&self, state: &mut State) {
        if state.entered.is_none() && !state.released && self.armed.elapsed() >= self.arm {
            state.expired = true;
            self.release_locked(state, ReleaseReason::Deadline);
        }
    }
    pub(crate) fn on_ui_thread(&self) -> bool {
        std::thread::current().id() == self.ui_thread
    }
    pub(crate) fn ui_concurrent_call(&self) {
        let mut state = self.lock();
        state.snapshot.ui_concurrent_stream_call_skipped = state
            .snapshot
            .ui_concurrent_stream_call_skipped
            .saturating_add(1);
    }
    pub(crate) fn response_assigned(&self, response: &NativeResponse, assigned: bool) {
        response
            .assigned
            .store(assigned, std::sync::atomic::Ordering::Release);
        let mut state = self.lock();
        if !safe(response.request_id) || !safe(response.controller_id) {
            self.release_locked(&mut state, ReleaseReason::InternalFailure);
            return;
        }
        if state.entered.is_none()
            || (state.snapshot.native_request_id == Some(response.request_id)
                && state.snapshot.native_controller_id == Some(response.controller_id))
        {
            state.snapshot.native_request_id = Some(response.request_id);
            state.snapshot.native_controller_id = Some(response.controller_id);
            state.snapshot.response_assigned = assigned;
        }
        if !assigned {
            self.release_locked(&mut state, ReleaseReason::InternalFailure);
        }
    }

    /// Called only after physical file.read_at > 0, while the original stream lock
    /// and its exact active pin/permit/file are still held by the COM Read caller.
    pub(crate) fn claim_and_wait(
        &self,
        binding: &StreamBinding,
        offset: u64,
        requested: u32,
        count: usize,
        exact_active_file: bool,
        exit: &mut Option<ReadExit>,
    ) -> bool {
        let mut state = self.lock();
        self.expire(&mut state);
        if state.entered.is_some()
            || state.released
            || !exact_active_file
            || count == 0
            || !binding
                .response
                .assigned
                .load(std::sync::atomic::Ordering::Acquire)
            || !safe(binding.native_request_id)
            || !safe(binding.native_controller_id)
            || binding.window_len == 0
            || offset < binding.window_base
            || offset
                .checked_add(count as u64)
                .is_none_or(|end| end > binding.window_base.saturating_add(binding.window_len))
        {
            return false;
        }
        if self.on_ui_thread() {
            state.snapshot.ui_thread_read_skipped =
                state.snapshot.ui_thread_read_skipped.saturating_add(1);
            state.snapshot.read_thread_id = Some(format!("{:?}", std::thread::current().id()));
            state.snapshot.on_ui_thread = Some(true);
            return false;
        }
        let entered = Instant::now();
        state.entered = Some(entered);
        let snapshot = &mut state.snapshot;
        snapshot.native_request_id = Some(binding.native_request_id);
        snapshot.native_controller_id = Some(binding.native_controller_id);
        snapshot.response_assigned = true;
        snapshot.stream_id = Some(binding.stream_id);
        snapshot.parent_stream_id = binding.parent_stream_id;
        snapshot.window_base = Some(binding.window_base);
        snapshot.window_len = Some(binding.window_len);
        snapshot.entered_at_ms = Some(self.ms(entered));
        snapshot.read_thread_id = Some(format!("{:?}", std::thread::current().id()));
        snapshot.on_ui_thread = Some(false);
        snapshot.read_offset = Some(offset);
        snapshot.requested_bytes = Some(requested);
        snapshot.physical_read_bytes = count as u64;
        snapshot.read_in_flight = true;
        snapshot.file_held = true;
        snapshot.stream_slot_held = true;
        snapshot.read_permit_held = true;
        *exit = Some(ReadExit(binding.clone(), None));
        let deadline = (entered + self.hold).min(self.armed + self.arm);
        while !state.released {
            let now = Instant::now();
            if now >= deadline {
                self.release_locked(&mut state, ReleaseReason::Deadline);
                break;
            }
            state = match self
                .changed
                .wait_timeout(state, deadline.saturating_duration_since(now))
            {
                Ok((state, _)) => state,
                Err(error) => {
                    let (mut state, _) = error.into_inner();
                    self.release_locked(&mut state, ReleaseReason::InternalFailure);
                    state
                }
            };
        }
        true
    }

    pub(crate) fn release(&self, reason: ReleaseReason) {
        self.release_locked(&mut self.lock(), reason);
    }
    pub(crate) fn snapshot(&self) -> ReadProbeSnapshot {
        let mut state = self.lock();
        self.expire(&mut state);
        let mut snapshot = state.snapshot.clone();
        snapshot.hold_elapsed_ms = state.entered.map_or(0, |entered| {
            snapshot
                .release_at_ms
                .unwrap_or_else(|| self.ms(Instant::now()))
                .saturating_sub(self.ms(entered))
        });
        snapshot.phase = if state.failed {
            "failed"
        } else if state.expired {
            "expired"
        } else if snapshot.ui_thread_read_skipped > 0
            || snapshot.ui_concurrent_stream_call_skipped > 0
        {
            "skipped"
        } else if snapshot.resources_reclaimed {
            "reclaimed"
        } else if snapshot.read_exited_at_ms.is_some() {
            "exited"
        } else if state.released {
            "released"
        } else if state.entered.is_some() {
            "held"
        } else {
            "armed"
        };
        snapshot
    }
    pub(crate) fn exited(&self, stream_id: u64, hresult: Option<i32>) {
        let mut state = self.lock();
        if state.snapshot.stream_id != Some(stream_id) || state.snapshot.read_exited_at_ms.is_some()
        {
            return;
        }
        if hresult.is_none() {
            self.release_locked(&mut state, ReleaseReason::InternalFailure);
        }
        state.snapshot.read_in_flight = false;
        state.snapshot.read_exited_at_ms = Some(self.ms(Instant::now()));
        state.snapshot.read_exit_hresult = hresult.map(|hr| format!("0x{:08X}", hr as u32));
    }
    pub(crate) fn reclaimed(&self, stream_id: u64) {
        let mut state = self.lock();
        if state.snapshot.stream_id == Some(stream_id) {
            state.snapshot.file_held = false;
            state.snapshot.stream_slot_held = false;
            state.snapshot.read_permit_held = false;
            state.snapshot.resources_reclaimed = true;
        }
    }
    pub(crate) fn handle(&self, request: &ReadControl, source_id: u64, hosted_id: u64) -> bool {
        if source_id != hosted_id
            || request.probe_id() != hosted_id
            || self.owner.probe_id != hosted_id
        {
            return false;
        }
        match request {
            ReadControl::Snapshot { .. } => true,
            ReadControl::Release {
                generation,
                session,
                native_request_id,
                native_controller_id,
                stream_id,
                hold_token,
                ..
            } => {
                let mut state = self.lock();
                if *generation != self.owner.generation
                    || session != &self.owner.session
                    || state.snapshot.native_request_id != Some(*native_request_id)
                    || state.snapshot.native_controller_id != Some(*native_controller_id)
                    || state.snapshot.stream_id != Some(*stream_id)
                    || hold_token != &state.snapshot.hold_token
                {
                    return false;
                }
                self.release_locked(&mut state, ReleaseReason::Explicit);
                true
            }
        }
    }
    #[cfg(test)]
    pub(crate) fn wake_for_test(&self) {
        self.changed.notify_all();
    }
    #[cfg(test)]
    pub(crate) fn poison_for_test(&self) {
        let _state = self.state.lock().unwrap();
        panic!("diagnostic poison");
    }
}

/// Declared before the StreamState guard: panic unwinding drops that guard first.
pub(crate) struct ReadExit(pub(crate) StreamBinding, pub(crate) Option<i32>);
impl Drop for ReadExit {
    fn drop(&mut self) {
        self.0.gate.exited(self.0.stream_id, self.1);
    }
}
pub(crate) struct HostDropGuard(pub(crate) Option<Arc<ReadGate>>);
impl Drop for HostDropGuard {
    fn drop(&mut self) {
        if let Some(gate) = &self.0 {
            gate.release(ReleaseReason::HostDrop);
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum ReadControl {
    Snapshot {
        nonce: u64,
        #[serde(rename = "probeId")]
        probe_id: u64,
    },
    Release {
        nonce: u64,
        #[serde(rename = "probeId")]
        probe_id: u64,
        generation: u64,
        session: String,
        #[serde(rename = "nativeRequestId")]
        native_request_id: u64,
        #[serde(rename = "nativeControllerId")]
        native_controller_id: u64,
        #[serde(rename = "streamId")]
        stream_id: u64,
        #[serde(rename = "holdToken")]
        hold_token: String,
    },
}
fn safe(id: u64) -> bool {
    id > 0 && id <= MAX_SAFE_ID
}
impl ReadControl {
    pub(crate) fn nonce(&self) -> u64 {
        match self {
            Self::Snapshot { nonce, .. } | Self::Release { nonce, .. } => *nonce,
        }
    }
    fn probe_id(&self) -> u64 {
        match self {
            Self::Snapshot { probe_id, .. } | Self::Release { probe_id, .. } => *probe_id,
        }
    }
    pub(crate) fn parse(body: &str) -> Option<Self> {
        if body.len() > 512 {
            return None;
        }
        let request: Self = serde_json::from_str(body).ok()?;
        if !safe(request.nonce()) || !safe(request.probe_id()) {
            return None;
        }
        if let Self::Release {
            generation,
            native_request_id,
            native_controller_id,
            stream_id,
            hold_token,
            ..
        } = &request
        {
            if ![
                *generation,
                *native_request_id,
                *native_controller_id,
                *stream_id,
            ]
            .into_iter()
            .all(safe)
                || hold_token.len() != 32
                || !hold_token
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return None;
            }
        }
        Some(request)
    }
}
