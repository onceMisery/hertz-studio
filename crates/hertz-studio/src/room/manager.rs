// SPDX-License-Identifier: MIT
//! Local lifecycle owner. Mode transitions serialize with all legacy commits.
use super::contract::{LocalRequest, RoomError, RoomResult};
use crate::state::AppState;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use tokio::sync::{mpsc, oneshot, watch, Mutex};

type LocalResume = (Vec<String>, Option<usize>, u64);
type SharedLocalResume = Arc<std::sync::Mutex<Option<LocalResume>>>;

pub(crate) struct Envelope {
    pub request: LocalRequest,
    pub reply: oneshot::Sender<RoomResult<Value>>,
}
pub(crate) struct Session {
    pub commands: mpsc::Sender<Envelope>,
    pub stop: watch::Sender<bool>,
    pub done: tokio::task::JoinHandle<()>,
    pub cleanup: watch::Receiver<bool>,
}
pub struct RoomManager {
    active: Arc<AtomicBool>,
    session: std::sync::Mutex<Option<Session>>,
    cleanup: std::sync::Mutex<Option<watch::Receiver<bool>>>,
    local_resume: SharedLocalResume,
    transition: Mutex<()>,
    discovery: tokio::sync::Semaphore,
    device_discovery: Arc<tokio::sync::Semaphore>,
    projection: Arc<RwLock<Value>>,
}
/// Owns both the original local state and the exclusive audio permission.
/// Cancellation and task panic follow the same asynchronous release barrier.
pub(super) struct ModeLease {
    restoration: Option<ModeRestoration>,
    pub completion: watch::Receiver<bool>,
    pub receiver: super::receiver::ReceiverRegistry,
}
// Recovery data has no asynchronous Drop of its own. Runtime cancellation can
// discard a recovery task without recursively spawning another recovery task.
struct ModeRestoration {
    state: Arc<AppState>,
    active: Arc<AtomicBool>,
    saved: Option<LocalResume>,
    local_resume: SharedLocalResume,
    audio: Option<vmusic_audio::actor::ExclusiveAudio>,
    done: watch::Sender<bool>,
    receiver: super::receiver::ReceiverRegistry,
}
impl ModeLease {
    async fn enter(
        state: Arc<AppState>,
        active: Arc<AtomicBool>,
        cleanup: &std::sync::Mutex<Option<watch::Receiver<bool>>>,
        local_resume: SharedLocalResume,
    ) -> RoomResult<Self> {
        let _commit = state.play_commit.lock().await;
        let snap = state.audio.snapshot();
        let queue = state.queue.lock().await.clone();
        let cursor = *state.cursor.lock().await;
        let position = if snap.track_id.is_none() {
            state
                .pending_restore_seek
                .lock()
                .await
                .as_ref()
                .filter(|p| {
                    cursor
                        .and_then(|i| queue.get(i))
                        .is_some_and(|id| id == &p.track_id)
                })
                .map(|p| p.position_ms)
                .unwrap_or(0)
        } else if cursor.and_then(|index| queue.get(index)) == snap.track_id.as_ref() {
            snap.position_ms
        } else {
            // A newer load can optimistically select B while the actor still
            // owns A. Its elapsed position must never become B's restore seek.
            0
        };
        let saved = (queue, cursor, position);
        state.cancel_prepared_playback().await;
        {
            let mut radio = state.radio.lock().await;
            radio.session = radio.session.wrapping_add(1);
            radio.active = false;
            radio.loading = false;
            radio.initial_generation = None;
        }
        {
            let mut load = state.playlist_load.lock().await;
            load.session = load.session.wrapping_add(1);
            load.active = None;
        }
        state.play_generation.fetch_add(1, Ordering::AcqRel);
        let (done, completion) = watch::channel(false);
        *cleanup.lock().unwrap_or_else(|e| e.into_inner()) = Some(completion.clone());
        *local_resume.lock().unwrap_or_else(|e| e.into_inner()) = Some(saved.clone());
        let receiver = super::receiver::ReceiverRegistry::default();
        active.store(true, Ordering::Release);
        let mut guard = Self {
            restoration: Some(ModeRestoration {
                state: state.clone(),
                active,
                local_resume,
                saved: Some(saved),
                audio: None,
                done,
                receiver: receiver.clone(),
            }),
            completion,
            receiver,
        };
        guard
            .restoration
            .as_mut()
            .expect("new lease owns restoration")
            .audio = Some(
            state
                .audio
                .acquire_exclusive()
                .await
                .map_err(|e| RoomError::new("room_audio", e.to_string()))?,
        );
        state.queue.lock().await.clear();
        *state.cursor.lock().await = None;
        *state.pending_restore_seek.lock().await = None;
        Ok(guard)
    }
    pub async fn finish(mut self) {
        if let Some(restoration) = &mut self.restoration {
            restoration.restore().await;
        }
    }
}
impl ModeRestoration {
    async fn restore(&mut self) {
        self.receiver.begin_close();
        let _ = self.receiver.close_current().await;
        if self.saved.is_some() {
            let _commit = self.state.play_commit.lock().await;
            let mut queue_state = self.state.queue.lock().await;
            let mut cursor_state = self.state.cursor.lock().await;
            let mut pending_state = self.state.pending_restore_seek.lock().await;
            let (queue, cursor, position) = self.saved.take().expect("restoration is serialized");
            let pending =
                cursor
                    .and_then(|i| queue.get(i))
                    .map(|track_id| crate::state::PendingRestore {
                        track_id: track_id.clone(),
                        position_ms: position,
                    });
            *queue_state = queue;
            *cursor_state = cursor;
            *pending_state = pending;
            self.state.publish(crate::state::WsEvent::QueueChanged);
            self.local_resume
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
            self.audio.take();
            self.active.store(false, Ordering::Release);
            self.done.send_replace(true);
        }
    }
}
impl Drop for ModeLease {
    fn drop(&mut self) {
        let Some(mut recovery) = self.restoration.take().filter(|r| r.saved.is_some()) else {
            return;
        };
        recovery.receiver.begin_close();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                recovery.restore().await;
            });
        }
    }
}
impl Default for RoomManager {
    fn default() -> Self {
        Self {
            active: Arc::new(AtomicBool::new(false)),
            session: std::sync::Mutex::new(None),
            cleanup: std::sync::Mutex::new(None),
            local_resume: Arc::default(),
            transition: Mutex::new(()),
            discovery: tokio::sync::Semaphore::new(1),
            device_discovery: Arc::new(tokio::sync::Semaphore::new(1)),
            projection: Arc::new(RwLock::new(json!({"mode":"local"}))),
        }
    }
}
impl RoomManager {
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }
    pub(crate) fn local_resume(&self) -> Option<LocalResume> {
        self.local_resume
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub fn snapshot(&self) -> Value {
        self.projection
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub(crate) async fn request(
        &self,
        state: Arc<AppState>,
        request: LocalRequest,
    ) -> RoomResult<Value> {
        match request {
            LocalRequest::Snapshot => Ok(self.snapshot()),
            LocalRequest::SavedRoom => {
                let _transition = self
                    .transition
                    .try_lock()
                    .map_err(|_| RoomError::new("room_busy", "正在切换房间，请稍后读取保存记录"))?;
                let secrets = super::credentials::ProfileSecrets::new(
                    &state.data_dir,
                    crate::secrets::backend(),
                );
                Ok(json!({"saved_room": secrets.saved_room().await?}))
            }
            LocalRequest::Devices => {
                let permit = self
                    .device_discovery
                    .clone()
                    .try_acquire_owned()
                    .map_err(|_| RoomError::new("room_busy", "正在读取输出设备"))?;
                let task = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    vmusic_audio::scheduled_output::enumerate_output_devices()
                });
                let devices = tokio::time::timeout(std::time::Duration::from_secs(3), task)
                    .await
                    .map_err(|_| RoomError::new("room_output_timeout", "输出设备枚举超时"))?
                    .map_err(|_| RoomError::new("room_output_devices", "输出设备枚举失败"))?
                    .map_err(|e| RoomError::new("room_output_devices", e.to_string()))?;
                Ok(json!({"devices":devices}))
            }
            LocalRequest::Discover => {
                let _permit = self
                    .discovery
                    .try_acquire()
                    .map_err(|_| RoomError::new("room_busy", "正在发现局域网房间"))?;
                let interfaces = vmusic_lan::discovery::interfaces()
                    .map_err(|_| RoomError::new("room_discovery", "无法读取网卡"))?;
                let discovery = vmusic_lan::discovery::Discovery::start().ok();
                tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                Ok(
                    json!({"interfaces":interfaces,"rooms":discovery.as_ref().map(|d|d.candidates()).unwrap_or_default(),"discovery_available":discovery.is_some()}),
                )
            }
            LocalRequest::Create {
                name,
                address,
                sample_rate,
                local_output,
            } => {
                let _transition = self.transition.lock().await;
                if self.is_active() {
                    return Err(RoomError::new("room_busy", "请先离开当前房间"));
                }
                let lease = ModeLease::enter(
                    state.clone(),
                    self.active.clone(),
                    &self.cleanup,
                    self.local_resume.clone(),
                )
                .await?;
                match super::host::start(
                    state,
                    super::host::HostOptions {
                        name,
                        address,
                        sample_rate,
                        local_output,
                    },
                    lease,
                    self.projection.clone(),
                    self.active.clone(),
                )
                .await
                {
                    Ok(session) => {
                        *self.session.lock().unwrap_or_else(|e| e.into_inner()) = Some(session);
                        Ok(self.snapshot())
                    }
                    Err(error) => Err(error),
                }
            }
            request @ (LocalRequest::Join { .. } | LocalRequest::Resume) => {
                let _transition = self.transition.lock().await;
                if self.is_active() {
                    return Err(RoomError::new("room_busy", "请先离开当前房间"));
                }
                if matches!(request, LocalRequest::Resume) {
                    let secrets = super::credentials::ProfileSecrets::new(
                        &state.data_dir,
                        crate::secrets::backend(),
                    );
                    secrets
                        .saved_room()
                        .await?
                        .ok_or(super::credentials::CredentialError::MissingRoom)?;
                }
                let lease = ModeLease::enter(
                    state.clone(),
                    self.active.clone(),
                    &self.cleanup,
                    self.local_resume.clone(),
                )
                .await?;
                let started = match request {
                    LocalRequest::Join {
                        invitation,
                        name,
                        listen,
                    } => {
                        super::guest::start(
                            state,
                            invitation,
                            name,
                            listen,
                            lease,
                            self.projection.clone(),
                            self.active.clone(),
                        )
                        .await
                    }
                    LocalRequest::Resume => {
                        super::guest::resume(
                            state,
                            lease,
                            self.projection.clone(),
                            self.active.clone(),
                        )
                        .await
                    }
                    _ => unreachable!(),
                };
                match started {
                    Ok(session) => {
                        *self.session.lock().unwrap_or_else(|e| e.into_inner()) = Some(session);
                        Ok(self.snapshot())
                    }
                    Err(error) => Err(error),
                }
            }
            LocalRequest::Leave => {
                let _transition = self.transition.lock().await;
                let session = self
                    .session
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .take();
                if let Some(mut session) = session {
                    session.stop.send_replace(true);
                    let _ = session.done.await;
                    while !*session.cleanup.borrow() {
                        if session.cleanup.changed().await.is_err() {
                            break;
                        }
                    }
                }
                let cleanup = self
                    .cleanup
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                if let Some(mut cleanup) = cleanup {
                    while !*cleanup.borrow() {
                        if cleanup.changed().await.is_err() {
                            break;
                        }
                    }
                }
                self.active.store(false, Ordering::Release);
                let last_error = self.snapshot()["last_error"].clone();
                *self.projection.write().unwrap_or_else(|e| e.into_inner()) =
                    json!({"mode":"local","last_error":last_error});
                Ok(self.snapshot())
            }
            request => {
                let sender = self
                    .session
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .as_ref()
                    .map(|s| s.commands.clone())
                    .ok_or_else(RoomError::inactive)?;
                let (reply, result) = oneshot::channel();
                sender
                    .try_send(Envelope { request, reply })
                    .map_err(|_| RoomError::new("room_busy", "房间操作队列繁忙"))?;
                tokio::time::timeout(std::time::Duration::from_secs(8), result)
                    .await
                    .map_err(|_| RoomError::new("room_timeout", "操作结果尚未确定，请查询状态"))?
                    .map_err(|_| RoomError::inactive())?
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn resume_test_state() -> (Arc<AppState>, std::thread::JoinHandle<()>) {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .execute(&db)
            .await
            .unwrap();
        let (state, thread) = crate::state::tests::playback_state_with_db(db).await;
        (Arc::new(state), thread)
    }

    #[tokio::test]
    async fn saved_room_survives_service_shutdown_and_rejoins_with_new_permissions_then_leave_forgets(
    ) {
        use super::super::credentials::{ProfileSecrets, RecentRoom};
        use vmusic_lan::client;
        use vmusic_lan::server::{Inbound, RoomServer};
        let identity = vmusic_lan::tls::HostIdentity::generate().unwrap();
        let room_id = uuid::Uuid::new_v4();
        let (server, mut inbound) = RoomServer::bind(
            "127.0.0.1:0".parse().unwrap(),
            room_id,
            uuid::Uuid::new_v4(),
            &identity,
            Default::default(),
        )
        .await
        .unwrap();
        let invitation = server.transport.invite(Default::default()).unwrap();
        let paired = client::pair(
            server.address,
            server.fingerprint,
            room_id,
            &invitation,
            "恢复电脑",
        )
        .await
        .unwrap();
        let descriptor = RecentRoom {
            version: 1,
            address: server.address,
            fingerprint: server.fingerprint.hex(),
            room_id,
            member_id: paired.member_id,
            name: "恢复电脑".into(),
            listen: true,
        };
        let backend = Arc::new(crate::secrets::MemoryStore::default());
        let secrets = ProfileSecrets::new(std::path::Path::new("restart-profile"), backend.clone());
        let audio_attached = Arc::new(AtomicBool::new(false));
        let audio_seen = audio_attached.clone();
        let responder = tokio::spawn(async move {
            while let Some(event) = inbound.recv().await {
                match event {
                    Inbound::Request { reply, .. } => {
                        let _ = reply
                            .send(json!({"ok":true,"result":{"permissions":{"listen":false}}}));
                    }
                    Inbound::AudioAttached { .. } => {
                        audio_seen.store(true, Ordering::Release);
                    }
                    _ => {}
                }
            }
        });
        let (state, thread) = resume_test_state().await;
        let lease = ModeLease::enter(
            state.clone(),
            state.room.active.clone(),
            &state.room.cleanup,
            state.room.local_resume.clone(),
        )
        .await
        .unwrap();
        let session = super::super::guest::start_session(
            state.clone(),
            descriptor.clone(),
            paired.credential,
            secrets.clone(),
            lease,
            state.room.projection.clone(),
            state.room.active.clone(),
        )
        .await
        .unwrap();
        let old_session = state.room.snapshot()["session_id"].clone();
        state.exiting.send_replace(true);
        tokio::time::timeout(std::time::Duration::from_secs(3), session.done)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            secrets.saved_room().await.unwrap(),
            Some(descriptor.clone())
        );
        state.audio.shutdown();
        thread.join().unwrap();

        // Fresh application/credential owners represent a restarted client.
        let secrets = ProfileSecrets::new(std::path::Path::new("restart-profile"), backend);
        let (state, thread) = resume_test_state().await;
        assert!(secrets.saved_room().await.unwrap().is_some());
        assert!(!state.room.is_active());
        assert!(!state.audio.exclusively_owned());
        let (saved, credential) = secrets.load_recent().await.unwrap().unwrap();
        let lease = ModeLease::enter(
            state.clone(),
            state.room.active.clone(),
            &state.room.cleanup,
            state.room.local_resume.clone(),
        )
        .await
        .unwrap();
        let session = super::super::guest::start_session(
            state.clone(),
            saved,
            credential,
            secrets.clone(),
            lease,
            state.room.projection.clone(),
            state.room.active.clone(),
        )
        .await
        .unwrap();
        assert_ne!(state.room.snapshot()["session_id"], old_session);
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while state.room.snapshot()["permissions"]["listen"] != false {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            !audio_attached.load(Ordering::Acquire),
            "saved listen preference must not bypass fresh permissions"
        );
        *state.room.session.lock().unwrap() = Some(session);
        state
            .room
            .request(state.clone(), LocalRequest::Leave)
            .await
            .unwrap();
        assert!(secrets.saved_room().await.unwrap().is_none());
        assert!(!state.room.is_active());
        state.audio.shutdown();
        thread.join().unwrap();
        server.shutdown().await;
        responder.await.unwrap();
    }

    #[tokio::test]
    async fn revoked_saved_membership_is_forgotten_on_explicit_rejoin() {
        use super::super::credentials::{ProfileSecrets, RecentRoom};
        use vmusic_lan::server::RoomServer;
        let identity = vmusic_lan::tls::HostIdentity::generate().unwrap();
        let room_id = uuid::Uuid::new_v4();
        let (server, _inbound) = RoomServer::bind(
            "127.0.0.1:0".parse().unwrap(),
            room_id,
            uuid::Uuid::new_v4(),
            &identity,
            Default::default(),
        )
        .await
        .unwrap();
        let invite = server.transport.invite(Default::default()).unwrap();
        let paired = vmusic_lan::client::pair(
            server.address,
            server.fingerprint,
            room_id,
            &invite,
            "expired",
        )
        .await
        .unwrap();
        let descriptor = RecentRoom {
            version: 1,
            address: server.address,
            fingerprint: server.fingerprint.hex(),
            room_id,
            member_id: paired.member_id,
            name: "expired".into(),
            listen: false,
        };
        let secrets = ProfileSecrets::new(
            std::path::Path::new("expired-profile"),
            Arc::new(crate::secrets::MemoryStore::default()),
        );
        secrets
            .save_recent(descriptor.clone(), paired.credential)
            .await
            .unwrap();
        server.transport.revoke(descriptor.member_id).unwrap();
        let (saved, credential) = secrets.load_recent().await.unwrap().unwrap();
        let (state, thread) = resume_test_state().await;
        let lease = ModeLease::enter(
            state.clone(),
            state.room.active.clone(),
            &state.room.cleanup,
            state.room.local_resume.clone(),
        )
        .await
        .unwrap();
        let mut cleanup = lease.completion.clone();
        let result = super::super::guest::start_session(
            state.clone(),
            saved,
            credential,
            secrets.clone(),
            lease,
            state.room.projection.clone(),
            state.room.active.clone(),
        )
        .await;
        let error = result
            .err()
            .expect("revoked credentials must reject rejoin");
        assert!(error.message.contains("authorization"));
        while !*cleanup.borrow() {
            cleanup.changed().await.unwrap();
        }
        assert!(secrets.saved_room().await.unwrap().is_none());
        assert!(!state.room.is_active());
        state.audio.shutdown();
        thread.join().unwrap();
        server.shutdown().await;
    }

    #[tokio::test]
    async fn failed_initial_connection_does_not_persist_a_member_or_hold_audio() {
        use super::super::credentials::{ProfileSecrets, RecentRoom};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let descriptor = RecentRoom {
            version: 1,
            address,
            fingerprint: vmusic_lan::tls::Fingerprint::of(b"host").hex(),
            room_id: uuid::Uuid::new_v4(),
            member_id: uuid::Uuid::new_v4(),
            name: "offline".into(),
            listen: false,
        };
        let secrets = ProfileSecrets::new(
            std::path::Path::new("failed-start-profile"),
            Arc::new(crate::secrets::MemoryStore::default()),
        );
        let (state, thread) = resume_test_state().await;
        let lease = ModeLease::enter(
            state.clone(),
            state.room.active.clone(),
            &state.room.cleanup,
            state.room.local_resume.clone(),
        )
        .await
        .unwrap();
        let mut cleanup = lease.completion.clone();
        assert!(super::super::guest::start_session(
            state.clone(),
            descriptor.clone(),
            vmusic_lan::members::Secret::generate().unwrap(),
            secrets.clone(),
            lease,
            state.room.projection.clone(),
            state.room.active.clone(),
        )
        .await
        .is_err());
        while !*cleanup.borrow() {
            cleanup.changed().await.unwrap();
        }
        assert!(secrets.saved_room().await.unwrap().is_none());
        assert!(!state.room.is_active());
        assert!(!state.audio.exclusively_owned());
        // A previously saved membership survives the identical network error.
        secrets
            .save_recent(
                descriptor.clone(),
                vmusic_lan::members::Secret::generate().unwrap(),
            )
            .await
            .unwrap();
        let (saved, credential) = secrets.load_recent().await.unwrap().unwrap();
        let lease = ModeLease::enter(
            state.clone(),
            state.room.active.clone(),
            &state.room.cleanup,
            state.room.local_resume.clone(),
        )
        .await
        .unwrap();
        let mut cleanup = lease.completion.clone();
        assert!(super::super::guest::start_session(
            state.clone(),
            saved,
            credential,
            secrets.clone(),
            lease,
            state.room.projection.clone(),
            state.room.active.clone(),
        )
        .await
        .is_err());
        while !*cleanup.borrow() {
            cleanup.changed().await.unwrap();
        }
        assert_eq!(secrets.saved_room().await.unwrap(), Some(descriptor));
        state.audio.shutdown();
        thread.join().unwrap();
    }
    #[tokio::test]
    async fn mode_restores_queue_cursor_position_without_automatically_playing() {
        let (state, thread) = crate::state::tests::playback_state().await;
        let state = Arc::new(state);
        *state.queue.lock().await = vec!["original-a".into(), "original-b".into()];
        *state.cursor.lock().await = Some(1);
        *state.pending_restore_seek.lock().await = Some(crate::state::PendingRestore {
            track_id: "original-b".into(),
            position_ms: 60_123,
        });
        let mut events = state.events.subscribe();
        let lease = ModeLease::enter(
            state.clone(),
            state.room.active.clone(),
            &state.room.cleanup,
            state.room.local_resume.clone(),
        )
        .await
        .unwrap();
        assert!(state.room.is_active());
        assert!(state.audio.exclusively_owned());
        assert!(state.queue.lock().await.is_empty());
        assert!(state
            .set_queue(vec!["legacy".into()], Some(0))
            .await
            .is_err());
        *state.queue.lock().await = vec!["room-song".into()];
        *state.cursor.lock().await = Some(0);
        lease.finish().await;
        assert_eq!(*state.queue.lock().await, ["original-a", "original-b"]);
        assert_eq!(*state.cursor.lock().await, Some(1));
        assert_eq!(
            *state.pending_restore_seek.lock().await,
            Some(crate::state::PendingRestore {
                track_id: "original-b".into(),
                position_ms: 60_123
            })
        );
        assert!(!state.audio.snapshot().playing);
        assert!(!state.room.is_active());
        assert!(state.room.local_resume().is_none());
        assert!(matches!(
            events.try_recv(),
            Ok(crate::state::WsEvent::QueueChanged)
        ));
        state.audio.shutdown();
        let _ = thread.join();
    }

    #[tokio::test]
    async fn entering_room_during_optimistic_track_selection_does_not_misbind_position() {
        let (state, thread) = crate::state::tests::playback_state().await;
        let state = Arc::new(state);
        state
            .audio
            .load("fixture-a.wav", Some("a".into()))
            .await
            .unwrap();
        state.audio.seek(60_000).await.unwrap();
        *state.queue.lock().await = vec!["a".into(), "b".into()];
        // B has been selected while the asynchronous B load is still pending;
        // the audio owner still reports A's sixty-second position.
        *state.cursor.lock().await = Some(1);
        let lease = ModeLease::enter(
            state.clone(),
            state.room.active.clone(),
            &state.room.cleanup,
            state.room.local_resume.clone(),
        )
        .await
        .unwrap();
        lease.finish().await;
        assert_eq!(
            *state.pending_restore_seek.lock().await,
            Some(crate::state::PendingRestore {
                track_id: "b".into(),
                position_ms: 0
            })
        );
        assert!(!state.audio.snapshot().playing);
        state.audio.shutdown();
        thread.join().unwrap();
    }
    #[tokio::test]
    async fn normal_host_end_restores_local_mode_and_forgets_saved_guest_membership() {
        use super::super::credentials::{ProfileSecrets, RecentRoom};
        use vmusic_lan::{
            client,
            server::{Inbound, RoomServer},
        };
        let identity = vmusic_lan::tls::HostIdentity::generate().unwrap();
        let room_id = uuid::Uuid::new_v4();
        let (server, mut inbound) = RoomServer::bind(
            "127.0.0.1:0".parse().unwrap(),
            room_id,
            uuid::Uuid::new_v4(),
            &identity,
            Default::default(),
        )
        .await
        .unwrap();
        let invitation = server.transport.invite(Default::default()).unwrap();
        let paired = client::pair(
            server.address,
            server.fingerprint,
            room_id,
            &invitation,
            "guest",
        )
        .await
        .unwrap();
        let descriptor = RecentRoom {
            version: 1,
            address: server.address,
            fingerprint: server.fingerprint.hex(),
            room_id,
            member_id: paired.member_id,
            name: "guest".into(),
            listen: false,
        };
        let backend = Arc::new(crate::secrets::MemoryStore::default());
        let profile = std::env::temp_dir().join(format!("room-end-{}", uuid::Uuid::new_v4()));
        let secrets = ProfileSecrets::new(&profile, backend);
        let responder = tokio::spawn(async move {
            while let Some(event) = inbound.recv().await {
                if let Inbound::Request { reply, .. } = event {
                    let _ =
                        reply.send(json!({"ok":true,"result":{"permissions":{"listen":false}}}));
                }
            }
        });
        let (state, audio_thread) = resume_test_state().await;
        let lease = ModeLease::enter(
            state.clone(),
            state.room.active.clone(),
            &state.room.cleanup,
            state.room.local_resume.clone(),
        )
        .await
        .unwrap();
        let session = super::super::guest::start_session(
            state.clone(),
            descriptor,
            paired.credential,
            secrets.clone(),
            lease,
            state.room.projection.clone(),
            state.room.active.clone(),
        )
        .await
        .unwrap();
        assert!(secrets.saved_room().await.unwrap().is_some());
        server.shutdown().await;
        tokio::time::timeout(std::time::Duration::from_secs(3), session.done)
            .await
            .unwrap_or_else(|e| {
                panic!(
                    "guest did not finish: {e}; projection={}",
                    state.room.snapshot()
                )
            })
            .unwrap();
        assert!(!state.room.is_active());
        assert_eq!(state.room.snapshot()["mode"], "local");
        assert!(secrets.saved_room().await.unwrap().is_none());
        state.audio.shutdown();
        audio_thread.join().unwrap();
        responder.await.unwrap();
    }
    #[test]
    fn runtime_shutdown_drops_pending_mode_recovery_without_rescheduling_itself() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (state, audio) = runtime.block_on(resume_test_state());
        let lease = runtime
            .block_on(ModeLease::enter(
                state.clone(),
                state.room.active.clone(),
                &state.room.cleanup,
                state.room.local_resume.clone(),
            ))
            .unwrap();
        let completion = lease.completion.clone();
        let commit = runtime.block_on(state.play_commit.lock());
        runtime.block_on(async move {
            drop(lease);
            tokio::task::yield_now().await;
        });
        assert!(!*completion.borrow());
        // Recovery is blocked on the real commit lock when Tokio cancels it.
        // A Drop that spawned another ModeLease would recurse here.
        drop(runtime);
        drop(commit);
        assert!(!state.audio.exclusively_owned());
        state.audio.shutdown();
        audio.join().unwrap();
    }

    #[tokio::test]
    async fn dropping_mode_lease_seals_native_creation_before_scheduling_recovery() {
        let (state, thread) = resume_test_state().await;
        let lease = ModeLease::enter(
            state.clone(),
            state.room.active.clone(),
            &state.room.cleanup,
            state.room.local_resume.clone(),
        )
        .await
        .unwrap();
        let registry = lease.receiver.clone();
        let mut completion = lease.completion.clone();
        let commit = state.play_commit.lock().await;
        drop(lease);
        // Recovery cannot acquire the commit lock yet. Native creation must
        // already be sealed by synchronous Drop, before that task can run.
        assert!(registry.is_closing());
        assert!(!*completion.borrow());
        assert!(state.audio.exclusively_owned());
        drop(commit);
        while !*completion.borrow_and_update() {
            completion.changed().await.unwrap();
        }
        assert!(!state.audio.exclusively_owned());
        state.audio.shutdown();
        thread.join().unwrap();
    }

    #[tokio::test]
    async fn leave_waits_for_cancelled_startup_even_before_a_session_is_published() {
        let (state, thread) = crate::state::tests::playback_state().await;
        let state = Arc::new(state);
        *state.queue.lock().await = vec!["local".into()];
        *state.cursor.lock().await = Some(0);
        *state.pending_restore_seek.lock().await = Some(crate::state::PendingRestore {
            track_id: "local".into(),
            position_ms: 44_000,
        });
        let lease = ModeLease::enter(
            state.clone(),
            state.room.active.clone(),
            &state.room.cleanup,
            state.room.local_resume.clone(),
        )
        .await
        .unwrap();
        let completion = lease.completion.clone();
        drop(lease);
        let result = state
            .room
            .request(state.clone(), LocalRequest::Leave)
            .await
            .unwrap();
        assert_eq!(result["mode"], "local");
        assert!(*completion.borrow());
        assert_eq!(*state.queue.lock().await, ["local"]);
        assert_eq!(
            *state.pending_restore_seek.lock().await,
            Some(crate::state::PendingRestore {
                track_id: "local".into(),
                position_ms: 44_000
            })
        );
        state.audio.shutdown();
        let _ = thread.join();
    }
}
