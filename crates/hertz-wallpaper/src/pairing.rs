// SPDX-License-Identifier: MIT
//! Pure short-session identity contract; transport and grant storage stay with their owners.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const PROTOCOL: u32 = 1;
pub const CHALLENGE_SECONDS: u64 = 60;
pub const SESSION_MS: i64 = 30 * 60 * 1000;
pub const TASK_MS: i64 = 90 * 1000;
pub const SCOPES: &[&str] = &[
    "wallpaper:capabilities",
    "wallpaper:quote",
    "wallpaper:submit",
    "wallpaper:own_job",
    "wallpaper:cancel",
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub protocol: u32,
    pub user_sid: String,
    pub windows_session_id: u32,
    pub native_pid: u32,
    pub native_generation: String,
    pub desktop_build_id: String,
    pub edition: String,
    pub profile_digest: String,
    pub service_pid: u32,
    pub server_instance_id: String,
}

impl Binding {
    pub fn valid(&self) -> bool {
        self.protocol == PROTOCOL
            && self.native_pid > 0
            && self.service_pid > 0
            && self.windows_session_id > 0
            && matches!(self.edition.as_str(), "standard" | "full")
            && self.user_sid.starts_with("S-1-")
            && self.user_sid.len() <= 184
            && !self.native_generation.is_empty()
            && self.native_generation.len() <= 32
            && hex64(&self.desktop_build_id)
            && hex64(&self.profile_digest)
            && !self.server_instance_id.is_empty()
            && self.server_instance_id.len() <= 128
    }
}

pub fn hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Both callers pass the canonical standalone data directory, never a display label.
pub fn profile_digest(edition: &str, canonical_dir: &str) -> String {
    let value = serde_json::json!({"edition":edition,"dataDir":canonical_dir});
    Sha256::digest(value.to_string().as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
