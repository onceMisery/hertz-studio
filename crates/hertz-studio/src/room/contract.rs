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
#[serde(deny_unknown_fields)]
pub struct QueueItem {
    /// Null allocates a new occurrence; an existing ID preserves that exact
    /// occurrence and must still refer to this resource at expected_revision.
    #[serde(deserialize_with = "Option::deserialize")]
    pub instance_id: Option<Counter>,
    pub resource_id: Uuid,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueueOrder {
    #[default]
    Manual,
    Votes,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum PeerRequest {
    Snapshot,
    Invite,
    RevokeInvitation {
        invitation_id: Uuid,
    },
    Operation {
        operation_id: Counter,
    },
    Library {
        offset: usize,
        limit: usize,
        #[serde(default)]
        revision: Option<Counter>,
    },
    ResolveFavorites {
        keys: Vec<String>,
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
        items: Vec<QueueItem>,
    },
    Vote {
        operation_id: Counter,
        expected_revision: Counter,
        instance_id: Counter,
        voted: bool,
    },
    QueueOrder {
        operation_id: Counter,
        expected_revision: Counter,
        mode: QueueOrder,
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
    ChatSong {
        operation_id: Counter,
        resource_id: Uuid,
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
        #[serde(default = "default_discoverable")]
        discoverable: bool,
    },
    Join {
        invitation: String,
        name: String,
        listen: bool,
    },
    Apply {
        address: std::net::SocketAddr,
        fingerprint: String,
        room_id: Uuid,
        room_code: String,
        name: String,
    },
    AdmissionStatus {
        address: std::net::SocketAddr,
        fingerprint: String,
        room_id: Uuid,
        application_id: Uuid,
        applicant_secret: vmusic_lan::members::Secret,
    },
    AdmissionReview {
        application_id: Uuid,
        approve: bool,
        permissions: Permissions,
    },
    AdmissionRevoke {
        application_id: Uuid,
    },
    Leave,
    Invite {
        permissions: Permissions,
    },
    RevokeInvitation {
        invitation_id: Uuid,
    },
    Discoverable {
        enabled: bool,
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
fn default_discoverable() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn discoverability_preserves_old_create_requests_and_is_host_local_only() {
        let old = json!({"action":"create","name":"room","address":"127.0.0.1:0","sample_rate":48000,"local_output":false});
        assert!(matches!(
            serde_json::from_value::<LocalRequest>(old.clone()).unwrap(),
            LocalRequest::Create {
                discoverable: true,
                ..
            }
        ));
        let mut hidden = old.clone();
        hidden["discoverable"] = json!(false);
        assert!(matches!(
            serde_json::from_value::<LocalRequest>(hidden.clone()).unwrap(),
            LocalRequest::Create {
                discoverable: false,
                ..
            }
        ));
        hidden["discoverable"] = json!("false");
        assert!(serde_json::from_value::<LocalRequest>(hidden).is_err());
        assert!(serde_json::from_value::<PeerRequest>(
            json!({"action":"discoverable","enabled":true})
        )
        .is_err());
    }

    #[test]
    fn queue_contract_requires_explicit_instance_identity_and_rejects_the_old_resource_list() {
        let resource = Uuid::new_v4();
        let request = json!({"action":"queue", "operation_id":"1", "expected_revision":"2",
            "items":[{"instance_id":"9007199254740993","resource_id":resource},
                     {"instance_id":null,"resource_id":resource}]});
        let parsed: PeerRequest = serde_json::from_value(request.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), request);
        for items in [
            json!([{"resource_id":resource}]),
            json!([{"instance_id":1,"resource_id":resource}]),
            json!([{"instance_id":null,"resource_id":resource,"unknown":true}]),
        ] {
            let mut invalid = request.clone();
            invalid["items"] = items;
            assert!(serde_json::from_value::<PeerRequest>(invalid).is_err());
        }
        assert!(
            serde_json::from_value::<PeerRequest>(json!({"action":"queue",
            "operation_id":"1","expected_revision":"2","resources":[resource]}))
            .is_err()
        );
    }
}
