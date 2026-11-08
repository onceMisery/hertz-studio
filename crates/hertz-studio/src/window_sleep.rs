// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Process-local sleep timer owned by the native main window.
//!
//! Every mutation is serialized by `AppState::play_commit`. The single worker
//! only owns a weak application reference; web views neither own nor run it.
//! The audio callback shares the suspend-aware deadline and silences output
//! before this worker gets a chance to reconcile the actor after OS resume.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::http::StatusCode;
use serde::{Deserialize, Deserializer, Serialize};
use tokio::sync::Notify;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

const MAX_SECONDS: u32 = 24 * 60 * 60;
// Tokio's clock may exclude suspended time. Recheck the audio clock regularly
// instead of relying on one long Tokio sleep to notice a Windows resume.
const CLOCK_CHECK: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    #[default]
    Idle,
    Armed,
    Expired,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub available: bool,
    pub revision: u64,
    pub phase: Phase,
    pub remaining_ms: u64,
    /// Informational display estimate only; never used to decide expiry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deadline_unix_ms: Option<u64>,
    pub server_now_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'static str>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    // A missing seconds field is an error; explicit null is cancellation.
    #[serde(deserialize_with = "required_seconds")]
    pub seconds: Option<u32>,
    pub expected_revision: u64,
}

fn required_seconds<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u32>, D::Error> {
    Option::<u32>::deserialize(deserializer)
}

#[derive(Default)]
struct Inner {
    revision: u64,
    phase: Phase,
    deadline: Option<u64>,
    error: Option<&'static str>,
}

impl Inner {
    fn due(&self, now: u64) -> bool {
        self.phase == Phase::Armed && self.deadline.is_some_and(|deadline| now >= deadline)
    }

    fn snapshot(&self, available: bool, now: u64, unix_now: u64) -> Snapshot {
        let remaining = self
            .deadline
            .filter(|_| self.phase == Phase::Armed)
            .map(|deadline| deadline.saturating_sub(now));
        Snapshot {
            available,
            revision: self.revision,
            phase: self.phase,
            remaining_ms: remaining.unwrap_or(0),
            deadline_unix_ms: remaining.map(|remaining| unix_now.saturating_add(remaining)),
            server_now_ms: unix_now,
            error: self.error,
        }
    }

    fn replace(&mut self, deadline: Option<u64>) {
        // At exhaustion all future client writes are rejected. Internal expiry
        // and owner cleanup must still be able to make playback safe.
        self.revision = self.revision.saturating_add(1);
        self.phase = if deadline.is_some() {
            Phase::Armed
        } else {
            Phase::Cancelled
        };
        self.deadline = deadline;
        self.error = None;
    }
}

pub struct WindowSleep {
    state: Weak<AppState>,
    inner: Mutex<Inner>,
    changed: Notify,
    stopped: AtomicBool,
}

impl WindowSleep {
    /// Call once the native host has acquired its owner token. The OnceLock
    /// also makes repeated attachment setup incapable of spawning two workers.
    pub fn install(state: &Arc<AppState>, runtime: &tokio::runtime::Handle) -> Arc<Self> {
        state
            .native_sleep
            .get_or_init(|| {
                let service = Arc::new(Self {
                    state: Arc::downgrade(state),
                    inner: Mutex::new(Inner::default()),
                    changed: Notify::new(),
                    stopped: AtomicBool::new(false),
                });
                runtime.spawn(Arc::clone(&service).run(state.exiting.subscribe()));
                service
            })
            .clone()
    }

    fn available(&self, state: &AppState) -> bool {
        !self.stopped.load(Ordering::Acquire)
            && !*state.exiting.borrow()
            && state
                .native_window
                .get()
                .is_some_and(|window| window.background_playback_active())
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.changed.notify_one();
    }

    pub async fn snapshot(&self) -> Snapshot {
        if let Some(state) = self.state.upgrade() {
            let _commit = state.play_commit.lock().await;
            self.expire_if_due_locked(&state).await;
            return self.read_snapshot(self.available(&state));
        }
        self.read_snapshot(false)
    }

    fn read_snapshot(&self, available: bool) -> Snapshot {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshot(available, vmusic_audio::sleep_deadline::now_ms(), unix_ms())
    }

    pub async fn update(&self, request: Request) -> ApiResult<Snapshot> {
        if request
            .seconds
            .is_some_and(|seconds| !(1..=MAX_SECONDS).contains(&seconds))
        {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "sleep_timer_invalid_duration",
                "定时暂停时长必须为 1 至 86400 秒",
            ));
        }
        let state = self.state.upgrade().ok_or_else(unavailable)?;
        let _commit = state.play_commit.lock().await;
        if !self.available(&state) {
            return Err(unavailable());
        }
        // Reconcile a deadline before allowing a replacement to lift the
        // callback gate. Its new revision makes a stale UI refresh first.
        self.expire_if_due_locked(&state).await;
        {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if request.expected_revision != inner.revision {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "sleep_timer_revision_conflict",
                    "定时暂停已在其他界面或服务端更新，请刷新后重试",
                ));
            }
            if inner.revision == u64::MAX {
                return Err(ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "sleep_timer_revision_exhausted",
                    "定时暂停状态版本已用尽，请重新启动播放器",
                ));
            }
        }
        if request.seconds.is_some() && state.room.is_active() {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "sleep_timer_room_active",
                "一起听期间请使用房间的定时设置",
            ));
        }
        let failed = self.inner.lock().unwrap_or_else(|e| e.into_inner()).phase == Phase::Failed;
        if failed && state.room.is_active() {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "sleep_timer_room_active",
                "房间音频正在交接，请等待完成后再修改定时",
            ));
        }
        if failed && !state.room.is_active() {
            // Failed expiry is not retried in a background loop. An explicit
            // cancel/rearm retries once; output stays gated until pause wins.
            if state.pause_audio_locked().await.is_err() {
                return Err(pause_failed());
            }
        }
        // Host loss is synchronous and can occur while the actor pause above
        // was awaited, independently of the service's playback commit lock.
        if !self.available(&state) {
            return Err(unavailable());
        }
        if !failed && self.expire_if_due_locked(&state).await {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "sleep_timer_revision_conflict",
                "原定时已到期，请刷新状态后重新设置",
            ));
        }
        let deadline = request.seconds.map(|seconds| {
            vmusic_audio::sleep_deadline::now_ms().saturating_add(u64::from(seconds) * 1000)
        });
        state.audio.set_sleep_deadline(deadline).map_err(|_| {
            ApiError::new(
                StatusCode::CONFLICT,
                "sleep_timer_audio_unavailable",
                "当前音频模式无法设置定时暂停",
            )
        })?;
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replace(deadline);
        self.changed.notify_one();
        Ok(self.read_snapshot(true))
    }

    /// Caller holds play_commit. True means this playback intent must stop;
    /// callers return Superseded instead of treating it as a track failure.
    pub(crate) async fn expire_if_due_locked(&self, state: &AppState) -> bool {
        if !self.available(state) {
            return false;
        }
        if state.room.is_active() {
            self.cancel_for_room_locked(state).await;
            return false;
        }
        {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if inner.phase == Phase::Failed {
                return true;
            }
            if !inner.due(vmusic_audio::sleep_deadline::now_ms()) {
                return false;
            }
        }
        state.play_generation.fetch_add(1, Ordering::Relaxed);
        let paused = state.pause_audio_locked().await.is_ok();
        if paused {
            state.native_sleep_reconcile_prepared_locked().await;
        }
        state.cancel_prepared_playback().await;
        if paused {
            // No gate lifting while the actor may still be playing/fading.
            let _ = state.audio.set_sleep_deadline(None);
        }
        {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.revision = inner.revision.saturating_add(1);
            inner.phase = if paused {
                Phase::Expired
            } else {
                Phase::Failed
            };
            if paused {
                inner.deadline = None;
            }
            inner.error = (!paused).then_some("sleep_timer_pause_failed");
        }
        self.changed.notify_one();
        if !paused {
            tracing::warn!("native sleep timer pause failed; output remains gated");
        }
        true
    }

    /// Caller holds play_commit, before acquiring the room's exclusive audio
    /// lease. This never sends a transport command to an active room.
    pub(crate) async fn cancel_for_room_locked(&self, state: &AppState) {
        if self.inner.lock().unwrap_or_else(|e| e.into_inner()).phase == Phase::Failed {
            // A failed pause cannot lift the gate on a still-running local
            // backend. Only the acknowledged handoff may clear this state.
            return;
        }
        self.clear_gate_locked(state);
    }

    /// Caller holds play_commit after acquire_exclusive has acknowledged
    /// destruction of the local backend. A reservation alone is insufficient.
    pub(crate) async fn finish_room_handoff_locked(&self, state: &AppState) {
        self.clear_gate_locked(state);
    }

    fn clear_gate_locked(&self, state: &AppState) {
        let _ = state.audio.set_sleep_deadline(None);
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(inner.phase, Phase::Armed | Phase::Failed) {
            inner.replace(None);
            self.changed.notify_one();
        }
    }

    async fn retire_locked(&self, state: &AppState) {
        if !state
            .native_window
            .get()
            .is_some_and(|window| window.background_playback_active())
        {
            // Native owner loss installs its own closed audio gate before
            // waking us. Only the owner's final actor shutdown releases that
            // gate; this worker must not undo it while cleaning timer state.
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if matches!(inner.phase, Phase::Armed | Phase::Failed) {
                inner.replace(None);
            }
            return;
        }
        let output_gated = {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.phase == Phase::Failed || inner.due(vmusic_audio::sleep_deadline::now_ms())
        };
        // Owner loss and its transport cleanup are separate runtime tasks.
        // Never lift an already-closed gate ahead of that cleanup's pause.
        if output_gated && !state.room.is_active() {
            state.cancel_prepared_playback().await;
            state.play_generation.fetch_add(1, Ordering::Relaxed);
            if state.pause_audio_locked().await.is_err() {
                return; // Keep silence until the exiting actor is destroyed.
            }
        }
        self.clear_gate_locked(state);
    }

    async fn run(self: Arc<Self>, mut exiting: tokio::sync::watch::Receiver<bool>) {
        loop {
            let Some(state) = self.state.upgrade() else {
                return;
            };
            if !self.available(&state) {
                let _commit = state.play_commit.lock().await;
                self.retire_locked(&state).await;
                return;
            }
            {
                let _commit = state.play_commit.lock().await;
                self.expire_if_due_locked(&state).await;
            }
            let delay = {
                let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
                inner
                    .deadline
                    .filter(|_| inner.phase == Phase::Armed)
                    .map(|deadline| {
                        Duration::from_millis(
                            deadline.saturating_sub(vmusic_audio::sleep_deadline::now_ms()),
                        )
                        .min(CLOCK_CHECK)
                    })
            };
            drop(state);
            tokio::select! {
                _ = self.changed.notified() => {},
                _ = async {
                    if let Some(delay) = delay {
                        tokio::time::sleep(delay).await;
                    } else {
                        std::future::pending::<()>().await;
                    }
                } => {},
                changed = exiting.changed() => {
                    if changed.is_err() { return; }
                }
            }
        }
    }
}

pub(crate) fn unavailable() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "native_sleep_timer_unavailable",
        "当前运行方式没有可用的原生窗口定时暂停",
    )
}

fn pause_failed() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "sleep_timer_pause_failed",
        "音频暂停失败，输出保持静音，请重试取消或重新设置",
    )
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn fixture() -> (
        Arc<AppState>,
        Arc<WindowSleep>,
        crate::window_lifecycle::NativeWindowOwner,
        std::thread::JoinHandle<()>,
    ) {
        let (mut state, audio) = crate::state::tests::playback_state().await;
        state.token = "native-sleep-fixture".into();
        let state = Arc::new(state);
        let window = crate::window_lifecycle::WindowLifecycle::install(&state).await;
        let owner = window.attach_host().unwrap();
        let timer = WindowSleep::install(&state, &tokio::runtime::Handle::current());
        (state, timer, owner, audio)
    }

    async fn finish(
        state: Arc<AppState>,
        timer: Arc<WindowSleep>,
        owner: crate::window_lifecycle::NativeWindowOwner,
        audio: std::thread::JoinHandle<()>,
    ) {
        timer.stop();
        state.exiting.send_replace(true);
        drop(owner);
        tokio::task::yield_now().await;
        state.audio.shutdown();
        audio.join().unwrap();
    }

    async fn start_audio(state: &AppState) {
        state
            .set_queue(vec!["first".into(), "second".into()], Some(0))
            .await
            .unwrap();
        state
            .audio
            .load("first.wav", Some("first".into()))
            .await
            .unwrap();
        state.audio.seek(12_345).await.unwrap();
        state.audio.play().await.unwrap();
    }

    fn force_due_locked(timer: &WindowSleep, state: &AppState) {
        // Deterministic stand-in for returning from OS sleep. This changes the
        // shared clock deadline, without advancing Tokio's timer driver.
        timer.inner.lock().unwrap().deadline = Some(1);
        state.audio.set_sleep_deadline(Some(1)).unwrap();
    }

    #[test]
    fn strict_requests_require_both_fields_and_explicit_null_for_cancellation() {
        for body in [
            json!({"expectedRevision": 0}),
            json!({"seconds": 10}),
            json!({"seconds": 10, "expectedRevision": 0, "extra": true}),
            json!({"seconds": -1, "expectedRevision": 0}),
            json!({"seconds": 1.5, "expectedRevision": 0}),
            json!({"seconds": "10", "expectedRevision": 0}),
        ] {
            assert!(serde_json::from_value::<Request>(body).is_err());
        }
        let cancel: Request =
            serde_json::from_value(json!({"seconds": null, "expectedRevision": 7})).unwrap();
        assert_eq!(cancel.seconds, None);
        assert_eq!(cancel.expected_revision, 7);
    }

    #[test]
    fn deadline_boundary_replacement_and_clock_change_use_only_elapsed_time() {
        let mut inner = Inner::default();
        inner.replace(Some(5000));
        assert!(!inner.due(4999));
        assert!(inner.due(5000));
        let earlier_wall = inner.snapshot(true, 4000, 20_000);
        let later_wall = inner.snapshot(true, 4000, 90_000);
        assert_eq!(earlier_wall.remaining_ms, 1000);
        assert_eq!(later_wall.remaining_ms, 1000);
        assert_eq!(earlier_wall.deadline_unix_ms, Some(21_000));
        assert_eq!(later_wall.deadline_unix_ms, Some(91_000));
        inner.replace(Some(9000));
        assert!(!inner.due(5000));
        assert_eq!(inner.revision, 2);
        inner.replace(None);
        assert!(!inner.due(u64::MAX));
        assert_eq!(inner.snapshot(true, 9000, 1).remaining_ms, 0);
    }

    #[tokio::test]
    async fn concurrent_clients_compare_revision_and_cannot_overwrite_each_other() {
        let (state, timer, owner, audio) = fixture().await;
        assert!(Arc::ptr_eq(
            &timer,
            &WindowSleep::install(&state, &tokio::runtime::Handle::current())
        ));
        let (first, second) = tokio::join!(
            timer.update(Request {
                seconds: Some(600),
                expected_revision: 0
            }),
            timer.update(Request {
                seconds: Some(1200),
                expected_revision: 0
            }),
        );
        let (accepted, rejected) = if first.is_ok() {
            (first, second)
        } else {
            (second, first)
        };
        let accepted = accepted.unwrap();
        assert_eq!(accepted.revision, 1);
        assert_eq!(accepted.phase, Phase::Armed);
        assert_eq!(rejected.unwrap_err().code, "sleep_timer_revision_conflict");
        for seconds in [0, 86_401] {
            assert_eq!(
                timer
                    .update(Request {
                        seconds: Some(seconds),
                        expected_revision: 1
                    })
                    .await
                    .unwrap_err()
                    .code,
                "sleep_timer_invalid_duration"
            );
        }
        let cancelled = timer
            .update(Request {
                seconds: None,
                expected_revision: 1,
            })
            .await
            .unwrap();
        assert_eq!(cancelled.phase, Phase::Cancelled);
        assert_eq!(cancelled.revision, 2);
        finish(state, timer, owner, audio).await;
    }

    #[tokio::test]
    async fn revision_exhaustion_rejects_writes_without_wrapping_or_lifting_a_deadline() {
        let (state, timer, owner, audio) = fixture().await;
        timer.inner.lock().unwrap().revision = u64::MAX;
        let error = timer
            .update(Request {
                seconds: Some(60),
                expected_revision: u64::MAX,
            })
            .await
            .unwrap_err();
        assert_eq!(error.code, "sleep_timer_revision_exhausted");
        assert_eq!(timer.read_snapshot(true).phase, Phase::Idle);
        {
            let mut inner = timer.inner.lock().unwrap();
            inner.replace(None);
            assert_eq!(inner.revision, u64::MAX);
            assert_eq!(inner.phase, Phase::Cancelled);
        }
        finish(state, timer, owner, audio).await;
    }

    #[tokio::test]
    async fn worker_reconciles_a_resumed_clock_without_a_client_request() {
        let (state, timer, owner, audio) = fixture().await;
        start_audio(&state).await;
        timer
            .update(Request {
                seconds: Some(60),
                expected_revision: 0,
            })
            .await
            .unwrap();
        {
            let _commit = state.play_commit.lock().await;
            force_due_locked(&timer, &state);
            timer.changed.notify_one();
        }
        tokio::time::timeout(Duration::from_secs(2), async {
            // Read the model directly: the HTTP snapshot method deliberately
            // also reconciles expiry, and would hide a missing worker here.
            while timer.read_snapshot(true).phase == Phase::Armed {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(timer.read_snapshot(true).phase, Phase::Expired);
        assert_eq!(state.viewers.load(Ordering::Acquire), 0);
        assert!(!state.audio.snapshot().playing);
        finish(state, timer, owner, audio).await;
    }

    #[tokio::test]
    async fn expiry_without_websocket_pauses_preserves_queue_and_invalidates_pending_work() {
        let (state, timer, owner, audio) = fixture().await;
        start_audio(&state).await;
        state.set_buffering(true, Some(20)).await;
        timer
            .update(Request {
                seconds: Some(60),
                expected_revision: 0,
            })
            .await
            .unwrap();
        assert_eq!(state.viewers.load(Ordering::Acquire), 0);
        let commit = state.play_commit.lock().await;
        let generation = state.play_generation.load(Ordering::Relaxed);
        let prepare_sequence = state.prepare_sequence.load(Ordering::Relaxed);
        force_due_locked(&timer, &state);
        assert!(timer.expire_if_due_locked(&state).await);
        assert!(!state.audio.snapshot().playing);
        assert_eq!(state.audio.snapshot().track_id.as_deref(), Some("first"));
        assert!(state.audio.snapshot().position_ms >= 12_345);
        assert_eq!(*state.queue.lock().await, vec!["first", "second"]);
        assert_eq!(*state.cursor.lock().await, Some(0));
        assert_eq!(*state.buffering.lock().await, (false, None));
        assert_eq!(
            state.play_generation.load(Ordering::Relaxed),
            generation + 1
        );
        assert_eq!(
            state.prepare_sequence.load(Ordering::Relaxed),
            prepare_sequence + 1
        );
        assert!(!timer.expire_if_due_locked(&state).await);
        assert_eq!(
            state.play_generation.load(Ordering::Relaxed),
            generation + 1
        );
        drop(commit);
        assert_eq!(timer.snapshot().await.phase, Phase::Expired);
        // Expiry itself does not resume. A new explicit playback intent works.
        state.resume_control(true).await.unwrap();
        assert!(state.audio.snapshot().playing);
        finish(state, timer, owner, audio).await;
    }

    #[tokio::test]
    async fn replacement_and_cancel_never_pause_a_newer_intent() {
        let (state, timer, owner, audio) = fixture().await;
        start_audio(&state).await;
        timer
            .update(Request {
                seconds: Some(60),
                expected_revision: 0,
            })
            .await
            .unwrap();
        let replacement = timer
            .update(Request {
                seconds: Some(120),
                expected_revision: 1,
            })
            .await
            .unwrap();
        assert_eq!(replacement.revision, 2);
        assert!(replacement.remaining_ms > 60_000);
        let cancelled = timer
            .update(Request {
                seconds: None,
                expected_revision: 2,
            })
            .await
            .unwrap();
        assert_eq!(cancelled.phase, Phase::Cancelled);
        let commit = state.play_commit.lock().await;
        let generation = state.play_generation.load(Ordering::Relaxed);
        // A previous deadline may still have a queued wake; it reads the new
        // phase under the same lock and cannot act on its old timestamp.
        timer.inner.lock().unwrap().deadline = Some(1);
        assert!(!timer.expire_if_due_locked(&state).await);
        assert_eq!(state.play_generation.load(Ordering::Relaxed), generation);
        assert!(state.audio.snapshot().playing);
        drop(commit);
        state.pause_control().await.unwrap();
        timer
            .update(Request {
                seconds: Some(60),
                expected_revision: 3,
            })
            .await
            .unwrap();
        timer
            .update(Request {
                seconds: None,
                expected_revision: 4,
            })
            .await
            .unwrap();
        assert!(
            !state.audio.snapshot().playing,
            "cancellation never resumes paused playback"
        );
        finish(state, timer, owner, audio).await;
    }

    #[tokio::test]
    async fn elapsed_timer_is_reconciled_before_a_stale_rearm_can_lift_its_gate() {
        let (state, timer, owner, audio) = fixture().await;
        start_audio(&state).await;
        timer
            .update(Request {
                seconds: Some(60),
                expected_revision: 0,
            })
            .await
            .unwrap();
        {
            let _commit = state.play_commit.lock().await;
            force_due_locked(&timer, &state);
        }
        let error = timer
            .update(Request {
                seconds: Some(120),
                expected_revision: 1,
            })
            .await
            .unwrap_err();
        assert_eq!(error.code, "sleep_timer_revision_conflict");
        assert!(!state.audio.snapshot().playing);
        let snapshot = timer.snapshot().await;
        assert_eq!(snapshot.revision, 2);
        assert_eq!(snapshot.phase, Phase::Expired);
        finish(state, timer, owner, audio).await;
    }

    #[tokio::test]
    async fn failed_pause_is_bounded_and_requires_explicit_retry() {
        let (state, timer, owner, audio) = fixture().await;
        timer
            .update(Request {
                seconds: Some(60),
                expected_revision: 0,
            })
            .await
            .unwrap();
        let commit = state.play_commit.lock().await;
        force_due_locked(&timer, &state);
        state.audio.shutdown();
        audio.join().unwrap();
        assert!(timer.expire_if_due_locked(&state).await);
        let snapshot = timer.read_snapshot(true);
        assert_eq!(snapshot.phase, Phase::Failed);
        assert_eq!(snapshot.error, Some("sleep_timer_pause_failed"));
        let generation = state.play_generation.load(Ordering::Relaxed);
        assert!(timer.expire_if_due_locked(&state).await);
        assert_eq!(state.play_generation.load(Ordering::Relaxed), generation);
        assert_eq!(timer.read_snapshot(true).revision, snapshot.revision);
        drop(commit);
        let error = timer
            .update(Request {
                seconds: None,
                expected_revision: snapshot.revision,
            })
            .await
            .unwrap_err();
        assert_eq!(error.code, "sleep_timer_pause_failed");
        timer.stop();
        state.exiting.send_replace(true);
        drop(owner);
    }

    #[tokio::test]
    async fn failed_expiry_keeps_gate_closed_until_room_acquisition_acknowledges() {
        let (state, timer, owner, audio) = fixture().await;
        start_audio(&state).await;
        timer
            .update(Request {
                seconds: Some(60),
                expected_revision: 0,
            })
            .await
            .unwrap();
        let commit = state.play_commit.lock().await;
        force_due_locked(&timer, &state);
        {
            let mut inner = timer.inner.lock().unwrap();
            inner.phase = Phase::Failed;
            inner.error = Some("sleep_timer_pause_failed");
        }
        timer.cancel_for_room_locked(&state).await;
        assert_eq!(timer.read_snapshot(true).phase, Phase::Failed);
        assert!(state.audio.play().await.is_err());
        let lease = state.audio.acquire_exclusive().await.unwrap();
        timer.finish_room_handoff_locked(&state).await;
        assert_eq!(timer.read_snapshot(true).phase, Phase::Cancelled);
        assert_eq!(timer.read_snapshot(true).error, None);
        drop(lease);
        state.audio.pause().await.unwrap();
        assert!(!state.audio.snapshot().playing);
        drop(commit);
        finish(state, timer, owner, audio).await;
    }

    #[tokio::test]
    async fn worker_does_not_keep_application_alive() {
        let (state, timer, owner, audio) = fixture().await;
        let weak = Arc::downgrade(&state);
        state.audio.shutdown();
        audio.join().unwrap();
        drop(state);
        tokio::time::timeout(Duration::from_secs(2), async {
            while weak.upgrade().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!timer.snapshot().await.available);
        drop(owner);
    }

    #[tokio::test]
    async fn http_api_requires_auth_and_a_live_native_owner() {
        let (mut plain, audio) = crate::state::tests::playback_state().await;
        plain.token = "native-sleep-http".into();
        let state = Arc::new(plain);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/v1/window/sleep-timer",
            listener.local_addr().unwrap()
        );
        let router = crate::routes::router(state.clone()).with_state(state.clone());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        assert_eq!(client.get(&url).send().await.unwrap().status(), 401);
        let unavailable: serde_json::Value = client
            .get(&url)
            .bearer_auth(&state.token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(unavailable, json!({"available": false}));
        assert_eq!(
            client
                .put(&url)
                .bearer_auth(&state.token)
                .json(&json!({"seconds": 60, "expectedRevision": 0}))
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        let window = crate::window_lifecycle::WindowLifecycle::install(&state).await;
        assert!(
            state.native_sleep.get().is_none(),
            "installation alone has no playback owner"
        );
        let owner = window.attach_host().unwrap();
        let timer = WindowSleep::install(&state, &tokio::runtime::Handle::current());
        let response = client
            .put(&url)
            .bearer_auth(&state.token)
            .json(&json!({"seconds": 60, "expectedRevision": 0}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let armed: serde_json::Value = response.json().await.unwrap();
        assert_eq!(armed["available"], true);
        assert_eq!(armed["phase"], "armed");
        assert_eq!(armed["revision"], 1);
        assert_eq!(
            client
                .put(&url)
                .bearer_auth(&state.token)
                .json(&json!({"seconds": null, "expectedRevision": 0}))
                .send()
                .await
                .unwrap()
                .status(),
            409
        );
        assert_eq!(
            client
                .put(&url)
                .bearer_auth(&state.token)
                .json(&json!({"seconds": 10, "expectedRevision": 1, "extra": true}))
                .send()
                .await
                .unwrap()
                .status(),
            422
        );
        drop(owner);
        assert!(window.attach_host().is_err());
        let unavailable: serde_json::Value = client
            .get(&url)
            .bearer_auth(&state.token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(unavailable, json!({"available": false}));
        assert_eq!(
            client
                .put(&url)
                .bearer_auth(&state.token)
                .json(&json!({"seconds": null, "expectedRevision": 1}))
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        server.abort();
        let _ = server.await;
        timer.stop();
        state.exiting.send_replace(true);
        state.audio.shutdown();
        audio.join().unwrap();
    }
}
