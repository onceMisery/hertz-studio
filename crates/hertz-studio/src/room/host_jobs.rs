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
use std::sync::Arc;
use tokio::sync::oneshot;
use uuid::Uuid;
use vmusic_lan::{members::Permissions, protocol::StreamIdentity};

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
pub(super) async fn source(
    state: Arc<AppState>,
    library: SharedLibrary,
    track: String,
    instance: u64,
    position_ms: u64,
    mode: String,
) -> RoomResult<Source> {
    let resource = library
        .resource_for(&track)
        .await
        .ok_or_else(RoomError::denied)?;
    let (_, path) = library.source(&state, resource).await?;
    let track_gain_db = gain(&state, &track, &mode).await;
    Ok(Source {
        path,
        instance,
        position_ms,
        track_gain_db,
    })
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
