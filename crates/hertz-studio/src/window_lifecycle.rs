// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Service-owned lifecycle for the optional native main window.
//!
//! HTTP clients may request an exit, but only the native host may confirm it.
//! The single pending request survives a late host attachment and has no timer.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
pub use crate::window_focus::focus_existing;

mod placement;

pub const CLOSE_BEHAVIOR_KEY: &str = "native_window_close_behavior";

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CloseBehavior {
    #[default]
    Hide,
    Quit,
}

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    #[default]
    Idle,
    Pending,
    Exiting,
    Cancelled,
    Failed,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuitSource {
    WindowClose,
    Toolbar,
    Tray,
    Http,
}

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub playing: bool,
    pub room_active: bool,
}

impl Activity {
    pub fn needs_confirmation(self) -> bool {
        self.playing || self.room_active
    }

    fn read(state: &AppState) -> Self {
        Self {
            playing: state.audio.snapshot().playing,
            room_active: state.room.is_active(),
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub available: bool,
    pub background_playback: bool,
    pub request_id: Option<String>,
    pub phase: Phase,
    pub close_behavior: CloseBehavior,
    pub activity: Activity,
    pub needs_confirmation: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<QuitSource>,
    /// A bounded public error code; never a database error, URL or path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'static str>,
}

#[derive(Clone, Debug)]
pub enum Event {
    FocusRequested,
    /// Shared sender keeps lifecycle events clonable; the native host takes it once.
    FlushPlacement(Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>),
    /// Show/focus the existing main window and present its current exit guard.
    PendingQuit(Snapshot),
    StateChanged(Snapshot),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsRequest {
    pub close_behavior: CloseBehavior,
}

type Sink = Arc<dyn Fn(Event) + Send + Sync>;

#[derive(Default)]
struct Inner {
    background_playback: bool,
    close_behavior: CloseBehavior,
    phase: Phase,
    request_id: Option<String>,
    source: Option<QuitSource>,
    /// The facts supplied with this request, before an inactive guard can
    /// auto-approve. Newly active playback needs a fresh host decision.
    requested_activity: Activity,
    error: Option<&'static str>,
    sink: Option<Sink>,
}

impl Inner {
    fn snapshot(&self, activity: Activity) -> Snapshot {
        Snapshot {
            available: true,
            background_playback: self.background_playback && self.phase != Phase::Exiting,
            request_id: self.request_id.clone(),
            phase: self.phase,
            close_behavior: self.close_behavior,
            activity,
            needs_confirmation: activity.needs_confirmation(),
            source: self.source,
            error: self.error,
        }
    }

    fn begin(&mut self, source: QuitSource, activity: Activity) {
        self.phase = Phase::Pending;
        self.request_id = Some(uuid::Uuid::new_v4().to_string());
        self.source = Some(source);
        self.requested_activity = activity;
        self.error = None;
    }

    fn confirm(
        &mut self,
        request_id: &str,
        approve: bool,
        explicit: bool,
        activity_was_shown: Option<bool>,
        activity: Activity,
    ) -> bool {
        if self.phase != Phase::Pending || self.request_id.as_deref() != Some(request_id) {
            return false;
        }
        if !approve {
            self.phase = Phase::Cancelled;
        } else if activity.needs_confirmation()
            && (!explicit
                || !activity_was_shown.unwrap_or(self.requested_activity.needs_confirmation()))
        {
            // Invalidate the old inactive decision, including any duplicate IPC
            // delivery. The next guard now carries the actual active facts.
            self.begin(self.source.unwrap_or(QuitSource::Http), activity);
        } else {
            self.phase = Phase::Exiting;
        }
        true
    }
}

pub struct WindowLifecycle {
    state: Weak<AppState>,
    runtime: tokio::runtime::Handle,
    inner: Mutex<Inner>,
    /// Publish a preference only after its corresponding database write; also
    /// preserves the ordering of simultaneous settings requests.
    settings_write: tokio::sync::Mutex<()>,
    placement: Mutex<placement::PlacementState>,
    owner_alive: AtomicBool,
    owner_lost: AtomicBool,
}

pub struct NativeWindowOwner {
    lifecycle: Arc<WindowLifecycle>,
}

impl Drop for NativeWindowOwner {
    fn drop(&mut self) {
        self.lifecycle.owner_alive.store(false, Ordering::Release);
        self.lifecycle.owner_lost.store(true, Ordering::Release);
        self.lifecycle
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .background_playback = false;
        if let Some(state) = self.lifecycle.state.upgrade() {
            if let Some(media) = state.system_media.get() {
                media.stop();
            }
            state.audio.close_local_playback();
            if let Some(timer) = state.native_sleep.get() {
                timer.stop();
            }
            self.lifecycle.runtime.spawn(async move {
                let _commit = state.play_commit.lock().await;
                state.cancel_prepared_playback().await;
                state.play_generation.fetch_add(1, Ordering::Relaxed);
                let _ = state.pause_audio_locked().await;
                state.request_exit();
            });
        }
    }
}

impl WindowLifecycle {
    pub(crate) fn request_focus(&self, expected_instance: &str) -> ApiResult<()> {
        let state = self.state.upgrade().ok_or_else(|| {
            ApiError::new(
                axum::http::StatusCode::CONFLICT,
                "native_window_unavailable",
                "原生主窗口不可用",
            )
        })?;
        if expected_instance != state.server_instance_id() {
            return Err(ApiError::new(
                axum::http::StatusCode::CONFLICT,
                "instance_changed",
                "播放器实例已变化",
            ));
        }
        let sink = self
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .sink
            .clone();
        if !self.background_playback_active() || sink.is_none() {
            return Err(ApiError::new(
                axum::http::StatusCode::CONFLICT,
                "native_window_not_ready",
                "原生主窗口尚未就绪或正在退出",
            ));
        }
        sink.unwrap()(Event::FocusRequested);
        Ok(())
    }
    /// Call on the service runtime, only for the standalone `--window` host,
    /// before publishing the listening address. DBX/browser state stays empty.
    pub async fn install(state: &Arc<AppState>) -> Arc<Self> {
        #[cfg(all(windows, feature = "native-window"))]
        crate::system_media::SystemMedia::install(state);
        if let Some(lifecycle) = state.native_window.get() {
            return lifecycle.clone();
        }
        let close_behavior = match vmusic_store::settings::get(&state.db, CLOSE_BEHAVIOR_KEY).await
        {
            Ok(None) => CloseBehavior::Hide,
            Ok(Some(value)) => match serde_json::from_value::<CloseBehavior>(value) {
                Ok(behavior) => behavior,
                Err(_) => {
                    tracing::warn!("invalid native window close preference; defaulting to hide");
                    CloseBehavior::Hide
                }
            },
            Err(_) => {
                tracing::warn!("native window close preference unavailable; defaulting to hide");
                CloseBehavior::Hide
            }
        };
        let placement = placement::PlacementState::load(state).await;
        state
            .native_window
            .get_or_init(|| {
                Arc::new(Self {
                    state: Arc::downgrade(state),
                    runtime: tokio::runtime::Handle::current(),
                    inner: Mutex::new(Inner {
                        close_behavior,
                        ..Default::default()
                    }),
                    settings_write: tokio::sync::Mutex::new(()),
                    placement: Mutex::new(placement),
                    owner_alive: AtomicBool::new(false),
                    owner_lost: AtomicBool::new(false),
                })
            })
            .clone()
    }

    /// Attaching the host replays the current request, so an early HTTP exit
    /// cannot disappear while Wry is still being constructed.
    pub fn set_sink(&self, sink: Box<dyn Fn(Event) + Send + Sync>) {
        let sink: Sink = sink.into();
        let snapshot = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.sink = Some(sink.clone());
            inner.snapshot(self.activity())
        };
        Self::emit(Some(sink), snapshot);
    }

    pub fn snapshot(&self) -> Snapshot {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut snapshot = inner.snapshot(self.activity());
        snapshot.background_playback = self.background_playback_active();
        snapshot
    }

    #[cfg(all(windows, feature = "native-window"))]
    pub fn start_system_media(&self, hwnd: isize) {
        if let Some(state) = self.state.upgrade() {
            if let Some(media) = state.system_media.get() {
                media.start(hwnd);
            }
        }
    }

    pub fn attach_host(self: &Arc<Self>) -> Result<NativeWindowOwner, &'static str> {
        if self.owner_lost.load(Ordering::Acquire)
            || self
                .owner_alive
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return Err("原生主窗口播放所有者已存在或已退出");
        }
        if let Some(state) = self.state.upgrade() {
            crate::window_sleep::WindowSleep::install(&state, &self.runtime);
        }
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .background_playback = true;
        Ok(NativeWindowOwner {
            lifecycle: Arc::clone(self),
        })
    }

    pub fn background_playback_active(&self) -> bool {
        self.owner_alive.load(Ordering::Acquire)
            && !self.owner_lost.load(Ordering::Acquire)
            && self
                .state
                .upgrade()
                .is_some_and(|state| !*state.exiting.borrow())
    }

    pub(crate) fn allows_local_playback(&self) -> bool {
        !self.owner_lost.load(Ordering::Acquire)
            && self
                .state
                .upgrade()
                .is_some_and(|state| !*state.exiting.borrow())
    }

    pub fn close_behavior(&self) -> CloseBehavior {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .close_behavior
    }

    /// All sources reuse one pending token. Repetition only asks the native
    /// host to focus the same guard; it never arms another shutdown.
    pub fn request_exit(&self, source: QuitSource) -> Snapshot {
        let (snapshot, sink) = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let activity = self.activity();
            if !matches!(inner.phase, Phase::Pending | Phase::Exiting) {
                inner.begin(source, activity);
            }
            (inner.snapshot(activity), inner.sink.clone())
        };
        Self::emit(sink, snapshot.clone());
        snapshot
    }

    /// Trusted in-process host entry only. Deliberately has no HTTP/RPC route.
    /// This is safe on the Tao thread: runtime work uses the captured handle.
    pub fn confirm(&self, request_id: &str, approve: bool) -> Snapshot {
        self.confirm_with_explicit(request_id, approve, true, None)
    }

    /// Confirm an explicit user decision against the warning actually shown by
    /// the trusted native host. The host supplies this fact from its presented
    /// snapshot, never from an untrusted renderer field. This prevents a second
    /// prompt when activity started after the request but before presentation.
    pub fn confirm_presented(
        &self,
        request_id: &str,
        approve: bool,
        activity_was_shown: bool,
    ) -> Snapshot {
        self.confirm_with_explicit(request_id, approve, true, Some(activity_was_shown))
    }

    /// Accept an automatic idle decision only while the service is still idle.
    /// An earlier active request is not evidence that the current renderer
    /// presentation warned the user: playback may have paused and resumed.
    pub fn confirm_idle(&self, request_id: &str) -> Snapshot {
        self.confirm_with_explicit(request_id, true, false, None)
    }

    fn confirm_with_explicit(
        &self,
        request_id: &str,
        approve: bool,
        explicit: bool,
        activity_was_shown: Option<bool>,
    ) -> Snapshot {
        let state = self.state.upgrade();
        let (snapshot, sink, changed) = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let activity = state.as_deref().map(Activity::read).unwrap_or_default();
            let changed =
                inner.confirm(request_id, approve, explicit, activity_was_shown, activity);
            if changed && inner.phase == Phase::Exiting && state.is_none() {
                inner.phase = Phase::Failed;
                inner.error = Some("service_unavailable");
            }
            (inner.snapshot(activity), inner.sink.clone(), changed)
        };
        if changed {
            if snapshot.phase == Phase::Exiting {
                if let Some(state) = state {
                    self.runtime.spawn(async move { state.request_exit() });
                }
            }
            Self::emit(sink, snapshot.clone());
        }
        snapshot
    }

    /// End a request that the native host cannot present. Raw platform failure
    /// details are deliberately discarded; retry starts a new guarded request.
    pub fn fail_pending(&self, request_id: &str, _reason: &str) -> Snapshot {
        let (snapshot, sink, changed) = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let changed =
                inner.phase == Phase::Pending && inner.request_id.as_deref() == Some(request_id);
            if changed {
                inner.phase = Phase::Failed;
                inner.error = Some("native_window_confirmation_failed");
            }
            (inner.snapshot(self.activity()), inner.sink.clone(), changed)
        };
        if changed {
            Self::emit(sink, snapshot.clone());
        }
        snapshot
    }

    pub async fn set_close_behavior(&self, behavior: CloseBehavior) -> ApiResult<Snapshot> {
        let _write = self.settings_write.lock().await;
        let state = self.state.upgrade().ok_or_else(|| {
            ApiError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "native_window_unavailable",
                "原生主窗口服务不可用",
            )
        })?;
        vmusic_store::settings::set(&state.db, CLOSE_BEHAVIOR_KEY, &serde_json::json!(behavior))
            .await
            .map_err(|_| {
                tracing::warn!("native window close preference could not be saved");
                ApiError::new(
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "native_window_settings_failed",
                    "关闭行为保存失败，请重试",
                )
            })?;
        let (snapshot, sink) = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.close_behavior = behavior;
            (inner.snapshot(Activity::read(&state)), inner.sink.clone())
        };
        if let Some(sink) = sink {
            sink(Event::StateChanged(snapshot.clone()));
        }
        Ok(snapshot)
    }

    fn activity(&self) -> Activity {
        self.state
            .upgrade()
            .as_deref()
            .map(Activity::read)
            .unwrap_or_default()
    }

    fn emit(sink: Option<Sink>, snapshot: Snapshot) {
        if let Some(sink) = sink {
            let event = if snapshot.phase == Phase::Pending {
                Event::PendingQuit(snapshot)
            } else {
                Event::StateChanged(snapshot)
            };
            // Never invoke a host callback while holding the lifecycle lock.
            sink(event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[tokio::test]
    async fn native_owner_keeps_zero_viewer_playback_and_loss_closes_admission() {
        let (state, audio) = fixture().await;
        let lifecycle = WindowLifecycle::install(&state).await;
        let owner = lifecycle.attach_host().unwrap();
        state
            .audio
            .load("background.wav", Some("background".into()))
            .await
            .unwrap();
        state.audio.play().await.unwrap();
        assert_eq!(state.viewers.load(Ordering::Acquire), 0);
        assert!(!state.pause_if_alone().await);
        assert!(state.audio.snapshot().playing);
        assert!(lifecycle.snapshot().background_playback);
        assert!(lifecycle.attach_host().is_err());
        drop(owner);
        assert!(!lifecycle.background_playback_active());
        assert!(state.require_local_playback().is_err());
        assert!(state.audio.play().await.is_err());
        state.audio.set_sleep_deadline(None).unwrap();
        assert!(
            state.audio.play().await.is_err(),
            "timer cleanup cannot reopen a lost owner"
        );
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !*state.exiting.borrow() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        state.audio.shutdown();
        audio.join().unwrap();
    }

    async fn fixture() -> (Arc<AppState>, std::thread::JoinHandle<()>) {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)")
            .execute(&db)
            .await
            .unwrap();
        let (mut state, audio) = crate::state::tests::playback_state_with_db(db).await;
        state.token = "window-lifecycle-fixture".into();
        (Arc::new(state), audio)
    }

    #[tokio::test]
    async fn focus_requires_auth_live_owner_and_exact_server_instance() {
        let (state, audio) = fixture().await;
        let lifecycle = WindowLifecycle::install(&state).await;
        let (base, server) = serve(state.clone()).await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let endpoint = format!("{base}/v1/window/focus");
        let body = json!({"serverInstanceId":state.server_instance_id()});
        assert_eq!(
            client
                .post(&endpoint)
                .json(&body)
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        assert_eq!(
            client
                .post(&endpoint)
                .bearer_auth(&state.token)
                .json(&body)
                .send()
                .await
                .unwrap()
                .status(),
            409
        );
        let owner = lifecycle.attach_host().unwrap();
        let seen = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let sink = seen.clone();
        lifecycle.set_sink(Box::new(move |event| {
            if matches!(event, Event::FocusRequested) {
                sink.fetch_add(1, Ordering::SeqCst);
            }
        }));
        assert_eq!(
            client
                .post(&endpoint)
                .bearer_auth(&state.token)
                .json(&json!({"serverInstanceId":"old"}))
                .send()
                .await
                .unwrap()
                .status(),
            409
        );
        assert_eq!(seen.load(Ordering::SeqCst), 0);
        assert_eq!(
            client
                .post(&endpoint)
                .bearer_auth(&state.token)
                .json(&body)
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        assert_eq!(seen.load(Ordering::SeqCst), 1);
        drop(owner);
        assert_eq!(
            client
                .post(&endpoint)
                .bearer_auth(&state.token)
                .json(&body)
                .send()
                .await
                .unwrap()
                .status(),
            409
        );
        assert_eq!(seen.load(Ordering::SeqCst), 1);
        server.abort();
        let _ = server.await;
        state.audio.shutdown();
        audio.join().unwrap();
    }

    #[tokio::test]
    async fn requests_coalesce_cancel_and_replay_after_host_attachment() {
        let (state, audio) = fixture().await;
        let lifecycle = WindowLifecycle::install(&state).await;
        assert!(Arc::ptr_eq(
            &lifecycle,
            &WindowLifecycle::install(&state).await
        ));
        let first = lifecycle.request_exit(QuitSource::Http);
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let lifecycle = lifecycle.clone();
                std::thread::spawn(move || lifecycle.request_exit(QuitSource::Tray))
            })
            .collect();
        for thread in threads {
            assert_eq!(thread.join().unwrap().request_id, first.request_id);
        }
        assert!(!*state.exiting.borrow());

        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink_seen = seen.clone();
        let weak = Arc::downgrade(&lifecycle);
        lifecycle.set_sink(Box::new(move |event| {
            // Re-entering the owner from a callback must not deadlock.
            let _current = weak.upgrade().unwrap().snapshot();
            sink_seen.lock().unwrap().push(event);
        }));
        assert!(
            matches!(seen.lock().unwrap().first(), Some(Event::PendingQuit(snapshot)) if snapshot.request_id == first.request_id)
        );

        let first_id = first.request_id.as_deref().unwrap();
        assert_eq!(lifecycle.confirm("stale-id", true).phase, Phase::Pending);
        assert_eq!(lifecycle.confirm(first_id, false).phase, Phase::Cancelled);
        assert_eq!(lifecycle.confirm(first_id, true).phase, Phase::Cancelled);
        let retry = lifecycle.request_exit(QuitSource::Toolbar);
        assert_ne!(retry.request_id, first.request_id);
        assert_eq!(
            lifecycle.confirm(first_id, true).request_id,
            retry.request_id
        );
        let failed = lifecycle.fail_pending(retry.request_id.as_deref().unwrap(), "secret/path");
        assert_eq!(failed.phase, Phase::Failed);
        assert_eq!(failed.error, Some("native_window_confirmation_failed"));
        assert!(!serde_json::to_string(&failed)
            .unwrap()
            .contains("secret/path"));
        assert!(!*state.exiting.borrow());
        state.audio.shutdown();
        audio.join().unwrap();
    }

    #[tokio::test]
    async fn confirmation_rechecks_service_activity_and_uses_captured_runtime() {
        let (state, audio) = fixture().await;
        let lifecycle = WindowLifecycle::install(&state).await;
        let first = lifecycle.request_exit(QuitSource::WindowClose);
        assert!(!first.needs_confirmation);
        state
            .audio
            .load("first.wav", Some("first".into()))
            .await
            .unwrap();
        state.audio.play().await.unwrap();
        assert!(lifecycle.snapshot().activity.playing);

        let old_id = first.request_id.clone().unwrap();
        let thread_owner = lifecycle.clone();
        let pending = std::thread::spawn(move || thread_owner.confirm(&old_id, true))
            .join()
            .unwrap();
        assert_eq!(pending.phase, Phase::Pending);
        assert!(pending.needs_confirmation);
        assert_ne!(pending.request_id, first.request_id);
        assert!(!*state.exiting.borrow());
        assert_eq!(
            lifecycle
                .confirm(first.request_id.as_deref().unwrap(), true)
                .request_id,
            pending.request_id
        );

        let mut exiting = state.exiting_signal();
        let pending_id = pending.request_id.unwrap();
        let thread_owner = lifecycle.clone();
        let confirmed = std::thread::spawn(move || thread_owner.confirm(&pending_id, true))
            .join()
            .unwrap();
        assert_eq!(confirmed.phase, Phase::Exiting);
        assert_eq!(
            lifecycle.confirm(confirmed.request_id.as_deref().unwrap(), true),
            confirmed
        );
        tokio::time::timeout(std::time::Duration::from_secs(2), exiting.changed())
            .await
            .unwrap()
            .unwrap();
        assert!(*exiting.borrow());
        state.audio.shutdown();
        audio.join().unwrap();
    }

    #[test]
    fn a_room_without_local_audio_also_requires_a_fresh_decision() {
        let room = Activity {
            playing: false,
            room_active: true,
        };
        assert!(room.needs_confirmation());
        let mut inner = Inner::default();
        inner.begin(QuitSource::Tray, Activity::default());
        let old_id = inner.request_id.clone().unwrap();
        assert!(inner.confirm(&old_id, true, true, None, room));
        assert_eq!(inner.phase, Phase::Pending);
        assert_ne!(inner.request_id.as_deref(), Some(old_id.as_str()));
        assert!(!inner.confirm(&old_id, true, true, None, room));
        let new_id = inner.request_id.clone().unwrap();
        assert!(inner.confirm(&new_id, true, true, None, room));
        assert_eq!(inner.phase, Phase::Exiting);
    }

    #[tokio::test]
    async fn native_presentation_warning_allows_one_explicit_confirmation_of_new_activity() {
        for activity_was_shown in [false, true] {
            let (state, audio) = fixture().await;
            let lifecycle = WindowLifecycle::install(&state).await;
            let first = lifecycle.request_exit(QuitSource::Toolbar);
            assert!(!first.needs_confirmation);
            state
                .audio
                .load("first.wav", Some("first".into()))
                .await
                .unwrap();
            state.audio.play().await.unwrap();
            assert!(lifecycle.snapshot().needs_confirmation);
            let mut exiting = state.exiting_signal();
            let confirmed = lifecycle.confirm_presented(
                first.request_id.as_deref().unwrap(),
                true,
                activity_was_shown,
            );
            if activity_was_shown {
                assert_eq!(confirmed.phase, Phase::Exiting);
                assert_eq!(confirmed.request_id, first.request_id);
                assert_eq!(
                    lifecycle.confirm_presented(first.request_id.as_deref().unwrap(), true, true),
                    confirmed
                );
                tokio::time::timeout(std::time::Duration::from_secs(2), exiting.changed())
                    .await
                    .unwrap()
                    .unwrap();
                assert!(*exiting.borrow());
            } else {
                assert_eq!(confirmed.phase, Phase::Pending);
                assert_ne!(confirmed.request_id, first.request_id);
                assert!(!*exiting.borrow());
                lifecycle.confirm(confirmed.request_id.as_deref().unwrap(), false);
            }
            state.audio.shutdown();
            audio.join().unwrap();
        }
    }

    #[tokio::test]
    async fn idle_autoapproval_cannot_reuse_an_earlier_active_request_after_playback_resumes() {
        let (state, audio) = fixture().await;
        let lifecycle = WindowLifecycle::install(&state).await;
        state
            .audio
            .load("first.wav", Some("first".into()))
            .await
            .unwrap();
        state.audio.play().await.unwrap();
        let first = lifecycle.request_exit(QuitSource::Toolbar);
        assert!(first.needs_confirmation);

        // The renderer receives an idle presentation, then playback resumes
        // while it flushes state before sending its automatic approval.
        state.audio.pause().await.unwrap();
        assert!(!lifecycle.snapshot().needs_confirmation);
        state.audio.play().await.unwrap();
        let first_id = first.request_id.as_deref().unwrap();
        let renewed = lifecycle.confirm_idle(first_id);
        assert_eq!(renewed.phase, Phase::Pending);
        assert!(renewed.needs_confirmation);
        assert_ne!(renewed.request_id, first.request_id);
        assert!(!*state.exiting.borrow());
        assert_eq!(lifecycle.confirm_idle(first_id), renewed);

        // Once truly idle, the new request can use the automatic path.
        state.audio.pause().await.unwrap();
        let mut exiting = state.exiting_signal();
        let confirmed = lifecycle.confirm_idle(renewed.request_id.as_deref().unwrap());
        assert_eq!(confirmed.phase, Phase::Exiting);
        tokio::time::timeout(std::time::Duration::from_secs(2), exiting.changed())
            .await
            .unwrap()
            .unwrap();
        assert!(*exiting.borrow());
        state.audio.shutdown();
        audio.join().unwrap();
    }

    #[tokio::test]
    async fn preference_is_durable_and_failed_writes_leave_runtime_unchanged() {
        let (state, audio) = fixture().await;
        let lifecycle = WindowLifecycle::install(&state).await;
        assert_eq!(lifecycle.close_behavior(), CloseBehavior::Hide);
        lifecycle
            .set_close_behavior(CloseBehavior::Quit)
            .await
            .unwrap();
        assert_eq!(
            vmusic_store::settings::get(&state.db, CLOSE_BEHAVIOR_KEY)
                .await
                .unwrap(),
            Some(json!("quit"))
        );
        let (next_state, next_audio) =
            crate::state::tests::playback_state_with_db(state.db.clone()).await;
        let next_state = Arc::new(next_state);
        assert_eq!(
            WindowLifecycle::install(&next_state).await.close_behavior(),
            CloseBehavior::Quit
        );

        vmusic_store::settings::set(
            &state.db,
            CLOSE_BEHAVIOR_KEY,
            &json!("unknown-restored-value"),
        )
        .await
        .unwrap();
        let (restored_state, restored_audio) =
            crate::state::tests::playback_state_with_db(state.db.clone()).await;
        let restored_state = Arc::new(restored_state);
        assert_eq!(
            WindowLifecycle::install(&restored_state)
                .await
                .close_behavior(),
            CloseBehavior::Hide
        );

        sqlx::query("DROP TABLE settings")
            .execute(&state.db)
            .await
            .unwrap();
        let before = lifecycle.snapshot();
        let error = lifecycle
            .set_close_behavior(CloseBehavior::Hide)
            .await
            .unwrap_err();
        assert_eq!(error.code, "native_window_settings_failed");
        assert_eq!(lifecycle.snapshot(), before);
        for state in [&state, &next_state, &restored_state] {
            state.audio.shutdown();
        }
        audio.join().unwrap();
        next_audio.join().unwrap();
        restored_audio.join().unwrap();
    }

    fn placement(x: i32) -> crate::window_placement::WindowPlacement {
        use crate::window_placement::{Rect, WindowPlacement};
        WindowPlacement::new(
            Rect::new(x, 100, 900, 600).unwrap(),
            Rect::new(0, 0, 3840, 2120).unwrap(),
            1.0,
            false,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn placement_native_bursts_coalesce_and_older_workers_cannot_overwrite_latest() {
        use crate::window_placement::PLACEMENT_KEY;
        let (state, audio) = fixture().await;
        let lifecycle = WindowLifecycle::install(&state).await;
        let owner = Arc::new(lifecycle.attach_host().unwrap());
        sqlx::query("CREATE TABLE placement_writes(value TEXT NOT NULL)")
            .execute(&state.db)
            .await
            .unwrap();
        for (name, event) in [
            ("placement_insert", "INSERT"),
            ("placement_update", "UPDATE"),
        ] {
            sqlx::query(&format!("CREATE TRIGGER {name} AFTER {event} ON settings WHEN NEW.key = 'native_window_placement' BEGIN INSERT INTO placement_writes(value) VALUES(NEW.value); END"))
                .execute(&state.db).await.unwrap();
        }
        let write = lifecycle.settings_write.lock().await;
        let native_owner = Arc::clone(&owner);
        // The native thread has no entered Tokio runtime; captured Handle owns
        // all persistence. Recording must not require database availability.
        std::thread::spawn(move || {
            for x in [100, 200, 300] {
                native_owner.record_placement(placement(x)).unwrap();
            }
        })
        .join()
        .unwrap();
        let flushing = Arc::clone(&lifecycle);
        let flush = tokio::spawn(async move { flushing.flush_placement().await });
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        owner.record_placement(placement(400)).unwrap();
        assert!(vmusic_store::settings::get(&state.db, PLACEMENT_KEY)
            .await
            .unwrap()
            .is_none());
        drop(write);
        flush.await.unwrap().unwrap();
        lifecycle
            .set_close_behavior(CloseBehavior::Quit)
            .await
            .unwrap();
        assert_eq!(
            vmusic_store::settings::get(&state.db, PLACEMENT_KEY)
                .await
                .unwrap(),
            Some(json!(placement(400)))
        );
        let values: Vec<String> = sqlx::query_scalar("SELECT value FROM placement_writes")
            .fetch_all(&state.db)
            .await
            .unwrap();
        assert_eq!(
            values.len(),
            1,
            "one coalesced durable write for the blocked burst"
        );
        assert_eq!(
            serde_json::from_str::<Value>(&values[0]).unwrap(),
            json!(placement(400))
        );
        state.audio.shutdown();
        audio.join().unwrap();
    }

    #[tokio::test]
    async fn placement_failed_store_writes_keep_latest_dirty_and_retry_without_losing_close_preference(
    ) {
        use crate::window_placement::PLACEMENT_KEY;
        let (state, audio) = fixture().await;
        let lifecycle = WindowLifecycle::install(&state).await;
        let owner = lifecycle.attach_host().unwrap();
        sqlx::query("CREATE TRIGGER deny_placement BEFORE INSERT ON settings WHEN NEW.key = 'native_window_placement' BEGIN SELECT RAISE(FAIL, 'placement unavailable'); END")
            .execute(&state.db).await.unwrap();
        owner.record_placement(placement(100)).unwrap();
        assert!(lifecycle.flush_placement().await.is_err());
        assert_eq!(lifecycle.saved_placement(), Some(placement(100)));
        assert!(vmusic_store::settings::get(&state.db, PLACEMENT_KEY)
            .await
            .unwrap()
            .is_none());
        lifecycle
            .set_close_behavior(CloseBehavior::Quit)
            .await
            .unwrap();
        owner.record_placement(placement(500)).unwrap();
        assert!(lifecycle.flush_placement().await.is_err());
        sqlx::query("DROP TRIGGER deny_placement")
            .execute(&state.db)
            .await
            .unwrap();
        lifecycle.flush_placement().await.unwrap();
        assert_eq!(
            vmusic_store::settings::get(&state.db, PLACEMENT_KEY)
                .await
                .unwrap(),
            Some(json!(placement(500)))
        );
        assert_eq!(
            vmusic_store::settings::get(&state.db, CLOSE_BEHAVIOR_KEY)
                .await
                .unwrap(),
            Some(json!("quit"))
        );
        state.audio.shutdown();
        audio.join().unwrap();
    }

    #[tokio::test]
    async fn placement_final_host_capture_flushes_latest_and_seals_native_admission() {
        use crate::window_placement::PLACEMENT_KEY;
        let (state, audio) = fixture().await;
        let lifecycle = WindowLifecycle::install(&state).await;
        let owner = Arc::new(lifecycle.attach_host().unwrap());
        owner.record_placement(placement(100)).unwrap();
        let native_owner = Arc::downgrade(&owner);
        lifecycle.set_sink(Box::new(move |event| {
            if let Event::FlushPlacement(complete) = event {
                let owner = native_owner.upgrade().unwrap();
                owner.record_placement(placement(700)).unwrap();
                owner.seal_placement();
                complete.lock().unwrap().take().unwrap().send(()).unwrap();
            }
        }));
        lifecycle.finish_placement().await;
        assert_eq!(
            vmusic_store::settings::get(&state.db, PLACEMENT_KEY)
                .await
                .unwrap(),
            Some(json!(placement(700)))
        );
        assert!(owner.record_placement(placement(800)).is_err());
        lifecycle.flush_placement().await.unwrap();
        assert_eq!(
            vmusic_store::settings::get(&state.db, PLACEMENT_KEY)
                .await
                .unwrap(),
            Some(json!(placement(700)))
        );
        state.audio.shutdown();
        audio.join().unwrap();
    }

    #[tokio::test]
    async fn placement_failed_final_delivery_still_flushes_last_accepted_snapshot() {
        use crate::window_placement::PLACEMENT_KEY;
        let (state, audio) = fixture().await;
        let lifecycle = WindowLifecycle::install(&state).await;
        let owner = lifecycle.attach_host().unwrap();
        owner.record_placement(placement(900)).unwrap();
        lifecycle.set_sink(Box::new(|_event| {})); // Failed native post drops the sender.
        lifecycle.finish_placement().await;
        assert_eq!(
            vmusic_store::settings::get(&state.db, PLACEMENT_KEY)
                .await
                .unwrap(),
            Some(json!(placement(900)))
        );
        assert!(owner.record_placement(placement(950)).is_err());
        state.audio.shutdown();
        audio.join().unwrap();
    }

    #[tokio::test]
    async fn placement_unresponsive_host_times_out_then_flushes_and_seals_latest() {
        use crate::window_placement::PLACEMENT_KEY;
        let (state, audio) = fixture().await;
        let lifecycle = WindowLifecycle::install(&state).await;
        let owner = lifecycle.attach_host().unwrap();
        owner.record_placement(placement(100)).unwrap();
        let retained_ack = Arc::new(Mutex::new(None));
        let host_ack = Arc::clone(&retained_ack);
        lifecycle.set_sink(Box::new(move |event| {
            if let Event::FlushPlacement(complete) = event {
                *host_ack.lock().unwrap() = Some(complete);
            }
        }));
        tokio::time::pause();
        let finishing = Arc::clone(&lifecycle);
        let finish = tokio::spawn(async move { finishing.finish_placement().await });
        tokio::task::yield_now().await;
        assert!(retained_ack.lock().unwrap().is_some());
        tokio::time::advance(std::time::Duration::from_millis(999)).await;
        assert!(
            !finish.is_finished(),
            "a retained ACK must wait for the host deadline"
        );
        tokio::time::advance(std::time::Duration::from_millis(1)).await;
        finish.await.unwrap();
        tokio::time::resume();
        assert!(owner.record_placement(placement(200)).is_err());
        assert_eq!(
            vmusic_store::settings::get(&state.db, PLACEMENT_KEY)
                .await
                .unwrap(),
            Some(json!(placement(100)))
        );
        state.audio.shutdown();
        audio.join().unwrap();
    }

    #[tokio::test]
    async fn placement_slow_store_timeout_releases_serialization_keeps_dirty_and_allows_shutdown() {
        use crate::window_placement::PLACEMENT_KEY;
        let (state, audio) = fixture().await;
        let lifecycle = WindowLifecycle::install(&state).await;
        let owner = lifecycle.attach_host().unwrap();
        // The fixture pool has exactly one connection; holding it suspends an
        // actual settings write without shortening any production deadline.
        let mut connection = state.db.acquire().await.unwrap();
        owner.record_placement(placement(300)).unwrap();
        lifecycle.set_sink(Box::new(|event| {
            if let Event::FlushPlacement(complete) = event {
                complete.lock().unwrap().take().unwrap().send(()).unwrap();
            }
        }));
        let started = tokio::time::Instant::now();
        let finishing = Arc::clone(&lifecycle);
        let finish = tokio::spawn(async move { finishing.finish_placement().await });
        tokio::task::yield_now().await;
        assert!(lifecycle.settings_write.try_lock().is_err());
        let observing = Arc::clone(&lifecycle);
        let released = tokio::spawn(async move {
            let _write = observing.settings_write.lock().await;
        });
        tokio::task::yield_now().await;
        state.shutdown().await;
        assert!(
            *state.exiting.borrow(),
            "geometry persistence must not gate service shutdown"
        );
        tokio::time::pause();
        let until_deadline = std::time::Duration::from_secs(2).saturating_sub(started.elapsed());
        tokio::time::advance(until_deadline.saturating_sub(std::time::Duration::from_millis(1)))
            .await;
        assert!(!finish.is_finished());
        assert!(!released.is_finished());
        tokio::time::advance(std::time::Duration::from_millis(1)).await;
        finish.await.unwrap();
        released.await.unwrap();
        tokio::time::resume();
        assert_eq!(lifecycle.saved_placement(), Some(placement(300)));
        assert!(owner.record_placement(placement(400)).is_err());
        let persisted: Option<String> =
            sqlx::query_scalar("SELECT value FROM settings WHERE key=?1")
                .bind(PLACEMENT_KEY)
                .fetch_optional(&mut *connection)
                .await
                .unwrap();
        assert!(
            persisted.is_none(),
            "a timed-out write must not be acknowledged as saved"
        );
        drop(connection);
        lifecycle.flush_placement().await.unwrap();
        assert_eq!(
            vmusic_store::settings::get(&state.db, PLACEMENT_KEY)
                .await
                .unwrap(),
            Some(json!(placement(300)))
        );
        audio.join().unwrap();
    }

    #[tokio::test]
    async fn placement_unknown_invalid_and_unread_state_is_preserved_from_automatic_defaults() {
        use crate::window_placement::PLACEMENT_KEY;
        for raw in [r#"{"schemaVersion":42,"futureShape":{"anchor":"left"}}"#.to_string(), "{malformed-json".to_string(), json!({"schemaVersion":1,"normalBounds":{"x":0,"y":0,"width":0,"height":600},"workArea":{"x":0,"y":0,"width":1920,"height":1040},"scaleFactor":1,"maximized":false}).to_string()] {
            let (state, audio) = fixture().await;
            sqlx::query("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,0)").bind(PLACEMENT_KEY).bind(&raw).execute(&state.db).await.unwrap();
            let lifecycle = WindowLifecycle::install(&state).await;
            let owner = lifecycle.attach_host().unwrap();
            assert!(lifecycle.saved_placement().is_none());
            assert!(owner.record_placement(placement(100)).is_err());
            lifecycle.flush_placement().await.unwrap();
            let stored: String = sqlx::query_scalar("SELECT value FROM settings WHERE key=?1").bind(PLACEMENT_KEY).fetch_one(&state.db).await.unwrap();
            assert_eq!(stored, raw);
            state.audio.shutdown(); audio.join().unwrap();
        }
        let (state, audio) = fixture().await;
        vmusic_store::settings::set(&state.db, PLACEMENT_KEY, &json!(placement(100)))
            .await
            .unwrap();
        sqlx::query("ALTER TABLE settings RENAME TO settings_unread")
            .execute(&state.db)
            .await
            .unwrap();
        let lifecycle = WindowLifecycle::install(&state).await;
        sqlx::query("ALTER TABLE settings_unread RENAME TO settings")
            .execute(&state.db)
            .await
            .unwrap();
        let owner = lifecycle.attach_host().unwrap();
        assert!(lifecycle.saved_placement().is_none());
        assert!(owner.record_placement(placement(500)).is_err());
        lifecycle.flush_placement().await.unwrap();
        assert_eq!(
            vmusic_store::settings::get(&state.db, PLACEMENT_KEY)
                .await
                .unwrap(),
            Some(json!(placement(100)))
        );
        state.audio.shutdown();
        audio.join().unwrap();
    }

    async fn serve(state: Arc<AppState>) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = crate::routes::router(state.clone()).with_state(state);
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (base, server)
    }

    #[tokio::test]
    async fn native_http_requests_are_guarded_and_cannot_confirm_or_bypass_settings() {
        let (state, audio) = fixture().await;
        let lifecycle = WindowLifecycle::install(&state).await;
        let (base, server) = serve(state.clone()).await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        assert_eq!(
            client
                .get(format!("{base}/v1/window/state"))
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        let response = client
            .post(format!("{base}/v1/system/shutdown"))
            .bearer_auth(&state.token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 202);
        let first: Value = response.json().await.unwrap();
        assert_eq!(first["phase"], "pending");
        assert_eq!(first["available"], true);
        let again: Value = client
            .post(format!("{base}/v1/system/shutdown"))
            .bearer_auth(&state.token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(again["requestId"], first["requestId"]);
        let mut exiting = state.exiting_signal();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(250), exiting.changed())
                .await
                .is_err()
        );

        for body in [
            json!({"closeBehavior":"quit","unexpected":true}),
            json!({"closeBehavior":"kill"}),
        ] {
            let response = client
                .put(format!("{base}/v1/window/settings"))
                .bearer_auth(&state.token)
                .json(&body)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 422);
        }
        let response = client
            .put(format!("{base}/v1/settings"))
            .bearer_auth(&state.token)
            .json(&json!({"native_window_close_behavior":"quit","unrelated":true}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 400);
        assert!(vmusic_store::settings::get(&state.db, "unrelated")
            .await
            .unwrap()
            .is_none());
        let response = client
            .put(format!("{base}/v1/settings"))
            .bearer_auth(&state.token)
            .json(&json!({"native_window_placement":placement(100),"geometry_unrelated":true}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 400);
        assert!(vmusic_store::settings::get(&state.db, "geometry_unrelated")
            .await
            .unwrap()
            .is_none());
        assert!(
            vmusic_store::settings::get(&state.db, crate::window_placement::PLACEMENT_KEY)
                .await
                .unwrap()
                .is_none()
        );
        let pending_before_http_confirmation = lifecycle.snapshot();
        let response = client
            .post(format!("{base}/v1/window/confirm"))
            .bearer_auth(&state.token)
            .json(&json!({"requestId":first["requestId"],"approve":true}))
            .send()
            .await
            .unwrap();
        // Unmatched paths pass through the merged native-component fallback,
        // whose allowlist rejects this path before a 404 can be returned.
        assert_eq!(response.status(), 401);
        assert_eq!(lifecycle.snapshot(), pending_before_http_confirmation);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(250), exiting.changed())
                .await
                .is_err()
        );
        lifecycle.confirm(first["requestId"].as_str().unwrap(), false);
        assert!(!*state.exiting.borrow());
        server.abort();
        let _ = server.await;
        state.audio.shutdown();
        audio.join().unwrap();
    }

    #[tokio::test]
    async fn browser_service_keeps_legacy_shutdown_and_rpc_has_no_window_routes() {
        let (state, audio) = fixture().await;
        let (base, server) = serve(state.clone()).await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let snapshot: Value = client
            .get(format!("{base}/v1/window/state"))
            .bearer_auth(&state.token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(snapshot, json!({"available":false}));
        let response = client
            .put(format!("{base}/v1/window/settings"))
            .bearer_auth(&state.token)
            .json(&json!({"closeBehavior":"quit"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 404);
        let rpc = crate::rpc::Rpc::new(state.clone());
        let error = rpc
            .call(crate::rpc::Call {
                op: crate::rpc::Op::Get,
                path: "v1/window/state",
                query: json!({}),
                body: Value::Null,
                raw: None,
                client_operation_id: None,
            })
            .await
            .err()
            .expect("DBX must not expose native window methods");
        assert_eq!(error.status, 404);
        assert!(state.native_window.get().is_none());
        let mut exiting = state.exiting_signal();
        let response = client
            .post(format!("{base}/v1/system/shutdown"))
            .bearer_auth(&state.token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({"status":"exiting"})
        );
        tokio::time::timeout(std::time::Duration::from_secs(2), exiting.changed())
            .await
            .unwrap()
            .unwrap();
        assert!(*exiting.borrow());
        server.abort();
        let _ = server.await;
        state.audio.shutdown();
        audio.join().unwrap();
    }
}
