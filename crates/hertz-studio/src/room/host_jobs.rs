// SPDX-License-Identifier: MIT
//! Typed preparation results. Workers may read resources, but only Owner commits
//! playback, queue or sharing state after checking the captured revisions.
use super::{
    contract::*,
    producer::Source,
    resources::{PreparedLibrary, SharedLibrary},
};
use crate::state::AppState;
use serde_json::Value;
use std::sync::{atomic::AtomicBool, Arc};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;
use uuid::Uuid;
use vmusic_audio::render::{NativePcmBudget, PreparedMedia};
use vmusic_lan::{
    members::Permissions,
    protocol::{FormatMode, StreamIdentity},
};

pub(super) enum Reply {
    Local(oneshot::Sender<RoomResult<Value>>),
    Remote(oneshot::Sender<Value>),
}
impl Reply {
    pub fn send(self, result: RoomResult<Value>) {
        match self {
            Self::Local(reply) => {
                let _ = reply.send(result);
            }
            Self::Remote(reply) => {
                let value = match result {
                    Ok(v) => serde_json::json!({"ok":true,"result":v}),
                    Err(e) => serde_json::json!({"ok":false,"error":e}),
                };
                let _ = reply.send(value);
            }
        }
    }
}
pub(super) enum PreparedAction {
    Queue {
        request: PeerRequest,
        tracks: Vec<String>,
    },
    Share(PreparedLibrary),
    Resource(Value),
}
pub(super) enum Completion {
    Mixer {
        change: u64,
        member: Uuid,
        session: Option<StreamIdentity>,
        result: RoomResult<std::collections::HashMap<u64, f32>>,
    },
    Diagnostic {
        reply: Reply,
        result: RoomResult<Value>,
    },
    Request {
        member: Uuid,
        session: Option<StreamIdentity>,
        permissions: Permissions,
        revision: u64,
        library_revision: u64,
        mutation: bool,
        reply: Reply,
        result: RoomResult<PreparedAction>,
    },
    Source {
        epoch: u64,
        instance: u64,
        position_ms: u64,
        loudness_mode: String,
        library_revision: u64,
        result: RoomResult<Source>,
    },
    Successor {
        epoch: u64,
        current: u64,
        token: u64,
        library_revision: u64,
        result: RoomResult<Source>,
    },
    Output {
        settings: OutputSettings,
        reply: Reply,
        result: RoomResult<
            Option<(
                super::receiver::ReceiverHandle,
                tokio::sync::mpsc::Receiver<super::receiver::ReceiverEvent>,
            )>,
        >,
    },
}
pub(super) struct SourceRequest {
    pub track: String,
    pub instance: u64,
    pub position_ms: u64,
    pub loudness_mode: String,
}
pub(super) async fn source(
    state: Arc<AppState>,
    library: SharedLibrary,
    request: SourceRequest,
    format_mode: FormatMode,
    native_budget: NativePcmBudget,
) -> RoomResult<Source> {
    let budget = if crate::online::split_virtual_id(&request.track).is_some() {
        20
    } else {
        5
    };
    let deadline = Instant::now() + Duration::from_secs(budget);
    // Work retains its original total deadline. The small outer grace permits
    // an interrupted decoder to return and release its actual input/cache lease.
    let cleanup = if format_mode == FormatMode::Native {
        Duration::from_millis(500)
    } else {
        Duration::ZERO
    };
    tokio::time::timeout_at(
        tokio::time::Instant::from_std(deadline + cleanup),
        prepare_source(
            state,
            library,
            request,
            format_mode,
            native_budget,
            deadline,
        ),
    )
    .await
    .map_err(|_| super::online_source::preparation_timeout(format_mode))?
}
async fn prepare_source(
    state: Arc<AppState>,
    library: SharedLibrary,
    request: SourceRequest,
    format_mode: FormatMode,
    native_budget: NativePcmBudget,
    deadline: Instant,
) -> RoomResult<Source> {
    let SourceRequest {
        track,
        instance,
        position_ms,
        loudness_mode: mode,
    } = request;
    super::online_source::check_deadline(deadline, format_mode)?;
    let resource = library
        .resource_for(&track)
        .await
        .ok_or_else(RoomError::denied)?;
    let (_, path) = library.source(&state, resource).await?;
    super::online_source::check_deadline(deadline, format_mode)?;
    let mut media = library
        .prepare_online_configured(
            &state,
            resource,
            position_ms,
            format_mode,
            native_budget.clone(),
            deadline,
        )
        .await?;
    if format_mode == FormatMode::Native && media.is_none() {
        media =
            Some(prepare_native_local(path.clone(), position_ms, native_budget, deadline).await?);
        // Revoke/change during input I/O invalidates this preparation too.
        if library.source(&state, resource).await?.1 != path {
            return Err(RoomError::denied());
        }
    }
    let track_gain_db = gain(&state, &track, &mode).await;
    super::online_source::check_deadline(deadline, format_mode)?;
    Ok(Source {
        path,
        media,
        instance,
        position_ms,
        track_gain_db,
    })
}

async fn prepare_native_local(
    path: std::path::PathBuf,
    position_ms: u64,
    native_budget: NativePcmBudget,
    deadline: Instant,
) -> RoomResult<PreparedMedia> {
    use super::online_source::{await_prepared, check_deadline, PreparationGuard};
    check_deadline(deadline, FormatMode::Native)?;
    let stop = Arc::new(AtomicBool::new(false));
    let mut guard = PreparationGuard::new(stop.clone(), deadline);
    let worker_stop = stop.clone();
    let worker = tokio::task::spawn_blocking(move || {
        if worker_stop.load(std::sync::atomic::Ordering::Acquire) || Instant::now() >= deadline {
            return Err(vmusic_core::AudioError::DecodeFailed(
                "native_source_preparation_timeout".into(),
            ));
        }
        let ext = path.extension().and_then(|ext| ext.to_str());
        let source = crate::online::progressive::FileMediaSource::open(&path).map_err(|_| {
            vmusic_core::AudioError::DecodeFailed("native_source_unreadable".into())
        })?;
        let mut media = PreparedMedia::open_native_interruptible(
            Box::new(source),
            ext,
            worker_stop,
            native_budget.clone(),
            deadline,
        )?;
        media.set_native_eof_check(Arc::new(|| true));
        if position_ms > 0 {
            media.seek_native(position_ms, native_budget, deadline)?;
        } else {
            media.validate_native(native_budget, deadline)?;
        }
        Ok(media)
    });
    guard.arm_worker(&worker);
    let media = await_prepared(worker, &stop, deadline, FormatMode::Native).await?;
    check_deadline(deadline, FormatMode::Native)?;
    guard.disarm();
    Ok(media)
}
pub(super) async fn gain(state: &AppState, track: &str, mode: &str) -> f32 {
    if mode == "off" {
        0.0
    } else {
        state
            .loudness_for(track, mode)
            .await
            .map(|v| v.0 as f32)
            .filter(|g| g.is_finite())
            .unwrap_or(0.0)
    }
}
pub(super) async fn bounded<T>(
    future: impl std::future::Future<Output = RoomResult<T>>,
) -> RoomResult<T> {
    tokio::time::timeout(std::time::Duration::from_secs(5), future)
        .await
        .map_err(|_| RoomError::new("room_preparation_timeout", "读取本地资源超时；操作未提交"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(rate: u32, frames: u32) -> Vec<u8> {
        let size = frames * 2;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + size).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&rate.to_le_bytes());
        bytes.extend_from_slice(&(rate * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&size.to_le_bytes());
        for frame in 0..frames {
            bytes.extend_from_slice(&(frame as i16).to_le_bytes());
        }
        bytes
    }

    #[tokio::test]
    async fn native_local_preparation_returns_actual_format_and_the_requested_seek_prefix() {
        let path = std::env::temp_dir().join(format!("hertz-native-local-{}.wav", Uuid::new_v4()));
        tokio::fs::write(&path, wav(48_000, 2_000)).await.unwrap();
        let budget = NativePcmBudget::default();
        let media = prepare_native_local(
            path.clone(),
            20,
            budget.clone(),
            Instant::now() + Duration::from_secs(2),
        )
        .await
        .unwrap();
        assert_eq!(media.decoded_format().unwrap().sample_rate, 48_000);
        assert_eq!(media.decoded_format().unwrap().channels, 1);
        assert_eq!(media.declared_info().sample_rate, Some(48_000));
        assert!(budget.usage().bytes > 0);
        drop(media);
        assert_eq!(budget.usage(), Default::default());
        tokio::fs::remove_file(path).await.unwrap();
    }

    #[tokio::test]
    async fn native_local_preparation_does_not_keep_a_worker_after_budget_deadline() {
        let path =
            std::env::temp_dir().join(format!("hertz-native-deadline-{}.wav", Uuid::new_v4()));
        tokio::fs::write(&path, wav(48_000, 37)).await.unwrap();
        let budget = NativePcmBudget::default();
        let held = budget.reserve(144_000, 48_000, 144_000 * 8).unwrap();
        let started = Instant::now();
        let error = prepare_native_local(
            path.clone(),
            0,
            budget.clone(),
            Instant::now() + Duration::from_millis(50),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "native_source_preparation_timeout");
        assert!(started.elapsed() < Duration::from_millis(650));
        assert_eq!(budget.usage(), held.usage());
        drop(held);
        assert_eq!(budget.usage(), Default::default());
        tokio::fs::remove_file(path).await.unwrap();
    }

    #[tokio::test]
    async fn native_host_source_always_owns_verified_media_and_fixed_retains_its_path_contract() {
        let (state, audio) = crate::state::tests::playback_state().await;
        sqlx::migrate!("../../migrations")
            .run(&state.db)
            .await
            .unwrap();
        let state = Arc::new(state);
        let path = std::env::temp_dir().join(format!("hertz-native-host-{}.wav", Uuid::new_v4()));
        tokio::fs::write(&path, wav(48_000, 2_000)).await.unwrap();
        let track = vmusic_library::build_track(&path, Default::default());
        vmusic_store::upsert_track(&state.db, &track).await.unwrap();
        let library = SharedLibrary::default();
        let prepared = library
            .prepare_replace(&state, vec![track.id.clone()])
            .await
            .unwrap();
        library.commit_replace(prepared).await.unwrap();
        let resource = library.resource_for(&track.id).await.unwrap();
        assert!(library
            .prepare_online(&state, resource, 20)
            .await
            .unwrap()
            .is_none());
        let budget = NativePcmBudget::default();
        let native = source(
            state.clone(),
            library.clone(),
            SourceRequest {
                track: track.id.clone(),
                instance: 99,
                position_ms: 20,
                loudness_mode: "off".into(),
            },
            FormatMode::Native,
            budget.clone(),
        )
        .await
        .unwrap();
        assert_eq!(native.instance, 99);
        assert_eq!(native.position_ms, 20);
        assert_eq!(
            native
                .media
                .as_ref()
                .unwrap()
                .decoded_format()
                .unwrap()
                .sample_rate,
            48_000
        );
        drop(native);
        assert_eq!(budget.usage(), Default::default());
        let fixed = source(
            state.clone(),
            library,
            SourceRequest {
                track: track.id,
                instance: 99,
                position_ms: 20,
                loudness_mode: "off".into(),
            },
            FormatMode::Fixed,
            budget,
        )
        .await
        .unwrap();
        assert!(fixed.media.is_none());
        assert!(!fixed.path.as_os_str().is_empty());
        drop(fixed);
        drop(state);
        audio.join().unwrap();
        tokio::fs::remove_file(path).await.unwrap();
    }
}
