// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Renderer-independent projection and narrow transport for operating-system media controls.
//!
//! The native adapter owns only this value and an action callback. Playback,
//! room permissions, sleep deadlines and queue changes remain with their
//! existing service owners. No service credentials, source URLs or paths are
//! included in the projection.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde_json::Value;
use vmusic_lan::protocol::Counter;

use crate::room::contract::{LocalRequest, PeerRequest, Playback};
use crate::state::{AppState, ControlOutcome};

mod owner;
pub use owner::SystemMedia;
#[cfg(all(windows, feature = "native-window"))]
mod windows;

const MAX_METADATA_CHARS: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlaybackState {
    Stopped,
    Paused,
    Playing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaMode {
    Local,
    Room,
}

/// A callback must carry the identity that was displayed when it was received.
/// This is an in-process comparison token, never a transport credential.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    pub server_instance: String,
    pub mode: MediaMode,
    pub local_generation: u64,
    pub local_intent_generation: usize,
    pub track_id: Option<String>,
    pub room_id: Option<String>,
    pub room_session: Option<String>,
    pub room_instance: Option<String>,
    pub room_member: Option<String>,
    pub track_instance: Option<String>,
    pub media_epoch: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Controls {
    pub play: bool,
    pub pause: bool,
    pub stop: bool,
    pub next: bool,
    pub previous: bool,
    pub seek: bool,
}

impl Controls {
    pub fn allows(self, action: Action) -> bool {
        match action {
            Action::Play => self.play,
            Action::Pause => self.pause,
            Action::Stop => self.stop,
            Action::Next => self.next,
            Action::Previous => self.previous,
            Action::Seek { .. } => self.seek,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Play,
    Pause,
    Stop,
    Next,
    Previous,
    Seek { position_ms: u64 },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Projection {
    pub identity: Option<Identity>,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: Option<u64>,
    pub position_ms: u64,
    pub playback: PlaybackState,
    pub buffering: bool,
    pub controls: Controls,
    /// Local library UUID only; the native adapter must never fetch a URL.
    pub cover_key: Option<String>,
}

impl Default for Projection {
    fn default() -> Self {
        Self {
            identity: None,
            title: String::new(),
            artist: String::new(),
            album: String::new(),
            duration_ms: None,
            position_ms: 0,
            playback: PlaybackState::Stopped,
            buffering: false,
            controls: Controls::default(),
            cover_key: None,
        }
    }
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum DispatchError {
    #[error("system media playback identity changed")]
    Stale,
    #[error("system media action is not currently available")]
    Unavailable,
    #[error("system media action was rejected: {0}")]
    Rejected(String),
}

fn metadata(text: &str) -> String {
    text.chars()
        .filter(|character| !character.is_control())
        .take(MAX_METADATA_CHARS)
        .collect()
}

fn string(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn counter(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_str()?.parse().ok())
}

fn local_identity(state: &AppState, player: &vmusic_core::PlayerSnapshot) -> Identity {
    Identity {
        server_instance: state.server_instance_id().to_owned(),
        mode: MediaMode::Local,
        local_generation: player.generation,
        local_intent_generation: state.play_generation.load(Ordering::Acquire),
        track_id: player.track_id.clone(),
        room_id: None,
        room_session: None,
        room_instance: None,
        room_member: None,
        track_instance: None,
        media_epoch: None,
    }
}

impl Identity {
    /// Also used by the room command owner immediately before it handles a
    /// queued native action, including across a guest reconnection.
    pub(crate) fn matches_room_snapshot(&self, room: &Value) -> bool {
        self.mode == MediaMode::Room
            && matches!(room["mode"].as_str(), Some("host" | "guest"))
            && self.room_id == string(&room["room_id"])
            && self.room_instance == string(&room["instance_id"])
            && self.room_session == string(&room["session_id"])
            && self.room_member == string(&room["member_id"])
            && self.track_instance == string(&room["track_instance_id"])
            && self.track_id == string(&room["current_track"]["resource_id"])
            && self.media_epoch == string(&room["output"]["current_epoch"])
    }
}

fn room_projection(server_instance: &str, room: &Value) -> Projection {
    // Reconnecting snapshots retain their previous media, but cannot accept
    // new commands until the guest's new session is authoritative.
    let connected = matches!(room["mode"].as_str(), Some("host" | "guest"));
    let track = &room["current_track"];
    let Some(track_id) = string(&track["resource_id"]) else {
        return Projection::default();
    };
    let Some(room_id) = string(&room["room_id"]) else {
        return Projection::default();
    };
    let Some(room_instance) = string(&room["instance_id"]) else {
        return Projection::default();
    };
    let Some(track_instance) = string(&room["track_instance_id"]) else {
        return Projection::default();
    };
    let playing = room["playing"].as_bool().unwrap_or(false);
    let duration_ms = counter(&track["duration_ms"]).filter(|duration| *duration > 0);
    let position = counter(&room["position_ms"]).unwrap_or(0);
    let transport = connected && room["permissions"]["transport"] == true;
    let has_queue = counter(&room["queue_count"]).unwrap_or(0) > 0;
    Projection {
        identity: Some(Identity {
            server_instance: server_instance.to_owned(),
            mode: MediaMode::Room,
            local_generation: 0,
            local_intent_generation: 0,
            track_id: Some(track_id),
            room_id: Some(room_id),
            room_instance: Some(room_instance),
            room_session: string(&room["session_id"]),
            room_member: string(&room["member_id"]),
            track_instance: Some(track_instance),
            media_epoch: string(&room["output"]["current_epoch"]),
        }),
        title: metadata(track["title"].as_str().unwrap_or("共享歌曲")),
        artist: metadata(track["artist"].as_str().unwrap_or_default()),
        album: metadata(track["album"].as_str().unwrap_or_default()),
        duration_ms,
        position_ms: duration_ms.map_or(position, |duration| position.min(duration)),
        playback: if playing {
            PlaybackState::Playing
        } else {
            PlaybackState::Paused
        },
        buffering: !connected,
        controls: Controls {
            play: transport && !playing,
            pause: transport && playing,
            stop: transport,
            next: transport && has_queue,
            previous: transport && has_queue,
            seek: transport && duration_ms.is_some(),
        },
        cover_key: None,
    }
}

/// Read a bounded metadata projection. No browser, websocket audience, network
/// metadata fetch, or cover I/O is needed to keep this current.
pub async fn snapshot(state: &Arc<AppState>) -> Projection {
    if *state.exiting.borrow() {
        return Projection::default();
    }
    if state.room.is_active() {
        return room_projection(state.server_instance_id(), &state.room.snapshot());
    }
    let player = state.audio.snapshot();
    let Some(track_id) = player.track_id.as_deref() else {
        return Projection::default();
    };
    let identity = local_identity(state, &player);
    let (buffering, _) = *state.buffering.lock().await;
    let has_queue = !state.queue.lock().await.is_empty();
    let mut projection = Projection {
        identity: Some(identity.clone()),
        title: "未知曲目".into(),
        duration_ms: player.duration_ms,
        position_ms: player.position_ms,
        playback: if player.playing {
            PlaybackState::Playing
        } else {
            PlaybackState::Paused
        },
        buffering,
        ..Projection::default()
    };
    if let Some((_, ref_id)) = crate::online::split_virtual_id(track_id) {
        let online = state.online_meta.lock().await.get(track_id).cloned();
        projection.title = metadata(online.as_ref().map_or(&ref_id, |track| &track.title));
        if let Some(track) = online {
            projection.artist = metadata(track.artist.as_deref().unwrap_or_default());
            projection.album = metadata(track.album.as_deref().unwrap_or_default());
            projection.duration_ms = projection.duration_ms.or(track.duration_ms);
        }
    } else if let Ok(Some(track)) = vmusic_store::get_track(&state.db, &track_id.to_owned()).await {
        projection.title = metadata(&track.title);
        projection.artist = metadata(track.artist.as_deref().unwrap_or_default());
        projection.album = metadata(track.album.as_deref().unwrap_or_default());
        projection.duration_ms = projection.duration_ms.or(track.duration_ms);
        projection.cover_key = track
            .has_cover
            .then(|| uuid::Uuid::parse_str(&track.id).ok())
            .flatten()
            .map(|id| id.to_string());
    }
    projection.duration_ms = projection.duration_ms.filter(|duration| *duration > 0);
    if let Some(duration) = projection.duration_ms {
        projection.position_ms = projection.position_ms.min(duration);
    }
    // Metadata lookup can await a database connection. Never attach the old
    // track's labels to a newly loaded track or to a new room lease.
    if state.room.is_active() || identity != local_identity(state, &state.audio.snapshot()) {
        return Projection::default();
    }
    let available = state.require_local_playback().is_ok();
    projection.controls = Controls {
        play: available && !player.playing,
        pause: available && (player.playing || buffering),
        stop: available,
        next: available && has_queue,
        previous: available && has_queue,
        seek: available && projection.duration_ms.is_some(),
    };
    projection
}

fn outcome(result: ControlOutcome) -> Result<(), DispatchError> {
    match result {
        ControlOutcome::Applied { .. } => Ok(()),
        ControlOutcome::Superseded { .. } => Err(DispatchError::Stale),
        ControlOutcome::NoOp { code } => Err(DispatchError::Rejected(code.as_str().to_owned())),
    }
}

/// Execute one callback through the existing playback owners. The host bounds
/// and serializes callback admission; this function never retries a relative
/// room action after an unknown result or allocates a second operation token.
pub async fn dispatch(
    state: Arc<AppState>,
    expected: Identity,
    action: Action,
) -> Result<(), DispatchError> {
    if expected.server_instance != state.server_instance_id() || *state.exiting.borrow() {
        return Err(DispatchError::Stale);
    }
    let current = snapshot(&state).await;
    if current.identity.as_ref() != Some(&expected) {
        return Err(DispatchError::Stale);
    }
    if !current.controls.allows(action) {
        return Err(DispatchError::Unavailable);
    }
    match expected.mode {
        MediaMode::Local => {
            let track = expected.track_id.as_deref().ok_or(DispatchError::Stale)?;
            let identity = Some((
                track,
                expected.local_generation,
                expected.local_intent_generation,
            ));
            let result = match action {
                Action::Play => state.resume_control_if(true, identity).await,
                Action::Pause => state.pause_control_if(identity).await,
                // Reuse the queue owner, including radio refill, track
                // preparation, history and native sleep checks.
                Action::Next => state.step_by_user_if(1, identity).await,
                Action::Previous => state.step_by_user_if(-1, identity).await,
                Action::Seek { position_ms } => {
                    state
                        .seek_control_if(
                            current
                                .duration_ms
                                .map_or(position_ms, |duration| position_ms.min(duration)),
                            identity,
                        )
                        .await
                }
                Action::Stop => state.stop_control_if(identity).await,
            };
            outcome(result.map_err(|error| DispatchError::Rejected(error.code().to_owned()))?)
        }
        MediaMode::Room => {
            let room = state.room.snapshot();
            if !expected.matches_room_snapshot(&room) {
                return Err(DispatchError::Stale);
            }
            let command = match action {
                Action::Play => Playback::Play,
                Action::Pause => Playback::Pause,
                Action::Stop => Playback::Stop,
                Action::Next => Playback::Next,
                Action::Previous => Playback::Previous,
                Action::Seek { position_ms } => Playback::Seek {
                    instance_id: Counter(
                        counter(&room["track_instance_id"]).ok_or(DispatchError::Stale)?,
                    ),
                    position_ms: Counter(
                        current
                            .duration_ms
                            .map_or(position_ms, |duration| position_ms.min(duration)),
                    ),
                },
            };
            let request = LocalRequest::Peer {
                request: PeerRequest::Playback {
                    operation_id: Counter(
                        counter(&room["next_operation_id"]).ok_or(DispatchError::Unavailable)?,
                    ),
                    expected_revision: Counter(
                        counter(&room["revision"]).ok_or(DispatchError::Unavailable)?,
                    ),
                    command,
                },
            };
            // The original operation token is used once. A collision with a
            // concurrent UI request fails through the normal room contract.
            let result = state
                .room
                .request_for_media(state.clone(), request, expected)
                .await
                .map_err(|error| DispatchError::Rejected(error.code))?;
            room_outcome(&result)
        }
    }
}

fn room_outcome(result: &Value) -> Result<(), DispatchError> {
    let status = result["state"]
        .as_str()
        .or_else(|| result["state"]["status"].as_str());
    match status {
        Some("applied" | "preparing" | "scheduled") => Ok(()),
        Some("superseded") => Err(DispatchError::Stale),
        Some("failed" | "no_op") => Err(DispatchError::Rejected(status.unwrap().to_owned())),
        _ => Err(DispatchError::Rejected("room_outcome_unknown".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn room() -> Value {
        json!({
            "mode":"guest", "room_id":"room", "instance_id":"instance", "member_id":"member",
            "session_id":"session", "track_instance_id":"7", "revision":"9", "next_operation_id":"4",
            "current_track":{"resource_id":"resource", "title":"歌曲", "artist":"歌手", "album":"专辑", "duration_ms":50000},
            "position_ms":"12000", "playing":false, "queue_count":2,
            "permissions":{"transport":true}, "output":{"current_epoch":"2"}
        })
    }

    #[test]
    fn paused_room_retains_metadata_and_empty_media_clears_everything() {
        let room = room();
        let projection = room_projection("server", &room);
        assert_eq!(projection.playback, PlaybackState::Paused);
        assert_eq!(projection.title, "歌曲");
        assert_eq!(projection.position_ms, 12000);
        assert!(projection.controls.play && projection.controls.seek);
        assert!(!projection.controls.pause);
        assert_eq!(
            room_projection("server", &json!({"mode":"local"})),
            Projection::default()
        );
    }

    #[test]
    fn room_permissions_and_reconnection_disable_all_controls() {
        let mut room = room();
        room["permissions"]["transport"] = json!(false);
        assert_eq!(
            room_projection("server", &room).controls,
            Controls::default()
        );
        room["permissions"]["transport"] = json!(true);
        room["mode"] = json!("reconnecting");
        let reconnecting = room_projection("server", &room);
        assert_eq!(reconnecting.controls, Controls::default());
        assert!(!reconnecting.identity.unwrap().matches_room_snapshot(&room));
    }

    #[test]
    fn room_callback_identity_cannot_cross_session_track_or_epoch() {
        let original = room();
        let identity = room_projection("server", &original).identity.unwrap();
        assert!(identity.matches_room_snapshot(&original));
        for field in [
            "room_id",
            "instance_id",
            "session_id",
            "member_id",
            "track_instance_id",
        ] {
            let mut changed = original.clone();
            changed[field] = json!("changed");
            assert!(!identity.matches_room_snapshot(&changed), "{field}");
        }
        let mut changed = original.clone();
        changed["output"]["current_epoch"] = json!("3");
        assert!(!identity.matches_room_snapshot(&changed));
    }

    #[test]
    fn metadata_is_unicode_bounded_and_duration_bounds_position() {
        let mut room = room();
        room["current_track"]["title"] = json!(format!("\0{}\n", "音🎵".repeat(600)));
        room["position_ms"] = json!("999999");
        let projection = room_projection("server", &room);
        assert_eq!(projection.title.chars().count(), MAX_METADATA_CHARS);
        assert!(!projection.title.chars().any(char::is_control));
        assert_eq!(projection.position_ms, 50000);
    }

    #[test]
    fn accepted_room_schedule_is_distinct_from_rejection_or_unknown_result() {
        for status in ["applied", "preparing", "scheduled"] {
            assert_eq!(room_outcome(&json!({"state":{"status":status}})), Ok(()));
        }
        assert_eq!(
            room_outcome(&json!({"state":"superseded"})),
            Err(DispatchError::Stale)
        );
        assert!(room_outcome(&json!({"state":{"status":"failed"}})).is_err());
        assert!(room_outcome(&json!({})).is_err());
    }

    #[tokio::test]
    async fn local_controls_work_without_renderer_and_reject_stale_generation() {
        let (state, audio) = crate::state::tests::playback_state().await;
        let state = Arc::new(state);
        assert_eq!(snapshot(&state).await, Projection::default());
        state
            .set_queue(vec!["first".into()], Some(0))
            .await
            .unwrap();
        state
            .audio
            .load("first.wav", Some("first".into()))
            .await
            .unwrap();
        let paused = snapshot(&state).await;
        assert_eq!(paused.playback, PlaybackState::Paused);
        assert_eq!(state.viewers.load(Ordering::Acquire), 0);
        let old = paused.identity.unwrap();
        dispatch(state.clone(), old.clone(), Action::Play)
            .await
            .unwrap();
        assert!(state.audio.snapshot().playing);
        assert_eq!(
            dispatch(state.clone(), old, Action::Pause).await,
            Err(DispatchError::Stale)
        );
        let playing = snapshot(&state).await;
        dispatch(state.clone(), playing.identity.unwrap(), Action::Pause)
            .await
            .unwrap();
        assert!(!state.audio.snapshot().playing);
        state.audio.stop().await.unwrap();
        let stopped = snapshot(&state).await;
        assert_eq!(stopped.playback, PlaybackState::Paused);
        assert!(stopped.identity.is_some());
        assert_eq!(stopped.position_ms, 0);
        state.audio.shutdown();
        audio.join().unwrap();
    }

    #[tokio::test]
    async fn local_callback_cannot_cross_a_seek_or_a_new_server_instance() {
        let (state, audio) = crate::state::tests::playback_state().await;
        let state = Arc::new(state);
        state
            .audio
            .load("first.wav", Some("first".into()))
            .await
            .unwrap();
        let old = snapshot(&state).await.identity.unwrap();
        state.audio.seek(1234).await.unwrap();
        assert_eq!(
            dispatch(state.clone(), old, Action::Play).await,
            Err(DispatchError::Stale)
        );
        let mut foreign = snapshot(&state).await.identity.unwrap();
        foreign.server_instance = "old-server".into();
        assert_eq!(
            dispatch(state.clone(), foreign, Action::Play).await,
            Err(DispatchError::Stale)
        );
        assert!(!state.audio.snapshot().playing);
        state.audio.shutdown();
        audio.join().unwrap();
    }

    #[tokio::test]
    async fn local_play_respects_the_audio_sleep_deadline() {
        let (state, audio) = crate::state::tests::playback_state().await;
        let state = Arc::new(state);
        state
            .audio
            .load("first.wav", Some("first".into()))
            .await
            .unwrap();
        let identity = snapshot(&state).await.identity.unwrap();
        state.audio.set_sleep_deadline(Some(1)).unwrap();
        assert!(dispatch(state.clone(), identity, Action::Play)
            .await
            .is_err());
        assert!(!state.audio.snapshot().playing);
        state.audio.shutdown();
        audio.join().unwrap();
    }

    #[tokio::test]
    async fn local_play_respects_a_lost_native_window_owner() {
        let (state, audio) = crate::state::tests::playback_state().await;
        let state = Arc::new(state);
        let window = crate::window_lifecycle::WindowLifecycle::install(&state).await;
        let owner = window.attach_host().unwrap();
        state
            .audio
            .load("first.wav", Some("first".into()))
            .await
            .unwrap();
        let identity = snapshot(&state).await.identity.unwrap();
        drop(owner);
        assert!(dispatch(state.clone(), identity, Action::Play)
            .await
            .is_err());
        assert!(!state.audio.snapshot().playing);
        state.audio.shutdown();
        audio.join().unwrap();
    }

    #[tokio::test]
    async fn native_controls_recheck_intent_after_waiting_for_commit() {
        let (state, audio) = crate::state::tests::playback_state().await;
        let state = Arc::new(state);
        state
            .set_queue(vec!["first".into(), "second".into()], Some(0))
            .await
            .unwrap();
        state
            .audio
            .load("first.wav", Some("first".into()))
            .await
            .unwrap();
        for action in [
            Action::Play,
            Action::Pause,
            Action::Stop,
            Action::Next,
            Action::Previous,
            Action::Seek { position_ms: 1000 },
        ] {
            // Pause needs a playing projection; others are checked independently.
            if action == Action::Pause {
                state.audio.play().await.unwrap();
            } else {
                state.audio.pause().await.unwrap();
            }
            let identity = snapshot(&state).await.identity.unwrap();
            let commit = state.play_commit.lock().await;
            let pending = async {
                let expected = Some((
                    "first",
                    identity.local_generation,
                    identity.local_intent_generation,
                ));
                match action {
                    Action::Play => state.resume_control_if(true, expected).await,
                    Action::Pause => state.pause_control_if(expected).await,
                    Action::Stop => state.stop_control_if(expected).await,
                    Action::Next => state.step_by_user_if(1, expected).await,
                    Action::Previous => state.step_by_user_if(-1, expected).await,
                    Action::Seek { position_ms } => {
                        state.seek_control_if(position_ms, expected).await
                    }
                }
            };
            tokio::pin!(pending);
            // Poll the real future up to its locked commit boundary.
            assert!(futures::poll!(&mut pending).is_pending());
            state.play_generation.fetch_add(1, Ordering::AcqRel);
            let before = state.audio.snapshot();
            drop(commit);
            assert!(
                matches!(pending.await.unwrap(), ControlOutcome::Superseded { .. }),
                "{action:?}"
            );
            let after = state.audio.snapshot();
            assert_eq!(after.track_id, before.track_id);
            assert_eq!(after.generation, before.generation);
            assert_eq!(after.playing, before.playing);
            assert_eq!(*state.cursor.lock().await, Some(0));
        }
        state.audio.shutdown();
        audio.join().unwrap();
    }

    #[tokio::test]
    async fn native_stop_reuses_transport_owner_and_preserves_resumable_track() {
        let (state, audio) = crate::state::tests::playback_state().await;
        let state = Arc::new(state);
        state
            .audio
            .load("first.wav", Some("first".into()))
            .await
            .unwrap();
        state.audio.seek(1200).await.unwrap();
        state.audio.play().await.unwrap();
        let identity = snapshot(&state).await.identity.unwrap();
        dispatch(state.clone(), identity, Action::Stop)
            .await
            .unwrap();
        let stopped = snapshot(&state).await;
        assert_eq!(stopped.position_ms, 0);
        assert_eq!(stopped.playback, PlaybackState::Paused);
        assert!(stopped.controls.play);
        dispatch(state.clone(), stopped.identity.unwrap(), Action::Play)
            .await
            .unwrap();
        assert!(state.audio.snapshot().playing);
        state.audio.shutdown();
        audio.join().unwrap();
    }
}
