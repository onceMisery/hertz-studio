// SPDX-License-Identifier: MIT
//! Versioned application contract shared by local UI and restricted LAN peers.
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use vmusic_lan::members::Permissions;
use vmusic_lan::protocol::Counter;

pub type RoomResult<T> = Result<T, RoomError>;
#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[error("{message}")]
pub struct RoomError {
    pub code: String,
    pub message: String,
}
impl RoomError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("room_invalid", message)
    }
    pub fn denied() -> Self {
        Self::new("room_denied", "没有执行此房间操作的权限，或授权已经失效")
    }
    pub fn inactive() -> Self {
        Self::new("room_inactive", "当前没有活动房间")
    }
    pub fn storage() -> Self {
        Self::new("room_storage", "本地存储操作失败")
    }
    pub fn exhausted() -> Self {
        Self::new("room_counter_exhausted", "房间计数器已用尽，请重新创建房间")
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Playback {
    Play,
    Pause,
    Stop,
    Next,
    Previous,
    Pick {
        instance_id: Counter,
    },
    Seek {
        instance_id: Counter,
        position_ms: Counter,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum PeerRequest {
    Snapshot,
    Operation {
        operation_id: Counter,
    },
    Library {
        offset: usize,
        limit: usize,
        #[serde(default)]
        revision: Option<Counter>,
    },
    QueuePage {
        offset: usize,
        limit: usize,
        #[serde(default)]
        revision: Option<Counter>,
    },
    Playback {
        operation_id: Counter,
        expected_revision: Counter,
        command: Playback,
    },
    Queue {
        operation_id: Counter,
        expected_revision: Counter,
        resources: Vec<Uuid>,
    },
    Mode {
        operation_id: Counter,
        expected_revision: Counter,
        mode: vmusic_core::PlayMode,
    },
    Volume {
        operation_id: Counter,
        expected_revision: Counter,
        volume: f32,
    },
    Resource {
        resource_id: Uuid,
        kind: super::resources::ResourceKind,
        offset: usize,
        revision: Option<String>,
    },
    ChatSend {
        operation_id: Counter,
        text: String,
    },
    ChatOperation {
        operation_id: Counter,
    },
    ChatHistory {
        before: Option<Counter>,
        revision: Option<Counter>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutputSettings {
    pub device_id: Option<String>,
    pub volume: f32,
    pub latency_correction_ms: i32,
    #[serde(default)]
    pub calibration_binding: Option<vmusic_audio::OutputBinding>,
}
impl Default for OutputSettings {
    fn default() -> Self {
        Self {
            device_id: None,
            volume: 1.0,
            latency_correction_ms: 0,
            calibration_binding: None,
        }
    }
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum LocalRequest {
    Snapshot,
    Devices,
    Discover,
    SavedRoom,
    Resume,
    Create {
        name: String,
        address: std::net::SocketAddr,
        sample_rate: u32,
        local_output: bool,
    },
    Join {
        invitation: String,
        name: String,
        listen: bool,
    },
    Leave,
    Invite {
        permissions: Permissions,
    },
    Share {
        track_ids: Vec<String>,
    },
    Permissions {
        member_id: Uuid,
        permissions: Permissions,
    },
    Remove {
        member_id: Uuid,
    },
    Output {
        settings: OutputSettings,
        enabled: bool,
    },
    SleepTimer {
        seconds: Option<u32>,
    },
    TestOutput,
    Peer {
        request: PeerRequest,
    },
    ChatAdmin {
        command: super::chat::ChatAdmin,
    },
    Dsp {
        params: vmusic_core::DspParams,
        crossfade_ms: u64,
        loudness_mode: String,
    },
}
