// SPDX-License-Identifier: MIT
//! Optional, read-only DBX desktop data source. Linking/constructing it grants nothing.
//! AppState remains the sole playback and projection owner; this bridge holds only a Weak.

use crate::error::ApiError;
use hertz_desktop_ipc::{Profile, Scope};
use serde::Serialize;

#[cfg(all(windows, target_arch = "x86_64"))]
mod authorization;
#[cfg(all(windows, target_arch = "x86_64"))]
mod lifecycle;
#[cfg(all(windows, target_arch = "x86_64"))]
mod server;
#[cfg(all(windows, target_arch = "x86_64"))]
pub use lifecycle::{AuthorizationGeneration, DesktopBridge};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopError {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeFailure {
    pub scope: Scope,
    pub error: DesktopError,
}

/// Contains no credentials or process-management capability. launchMode is frozen to manual.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStatus {
    pub supported: bool,
    pub profile: Option<Profile>,
    pub launch_mode: &'static str,
    pub revision: Option<u64>,
    pub authorized_scopes: Vec<Scope>,
    pub active_scopes: Vec<Scope>,
    /// Only bridge gate/listener readiness; native sourceConnected requires D2 handshake.
    pub listener_ready: bool,
    pub persistent_revoked: bool,
    pub cleanup_incomplete: bool,
    pub scope_errors: Vec<ScopeFailure>,
    pub error: Option<DesktopError>,
}

impl DesktopStatus {
    fn empty(supported: bool, profile: Option<Profile>) -> Self {
        Self {
            supported,
            profile,
            launch_mode: "manual",
            revision: None,
            authorized_scopes: Vec::new(),
            active_scopes: Vec::new(),
            listener_ready: false,
            persistent_revoked: false,
            cleanup_incomplete: false,
            scope_errors: Vec::new(),
            error: None,
        }
    }
}

fn failure(code: &'static str, message: impl Into<String>) -> ApiError {
    ApiError::new(axum::http::StatusCode::SERVICE_UNAVAILABLE, code, message)
}

fn desktop_error(error: &ApiError) -> DesktopError {
    DesktopError {
        code: error.code,
        message: error.message.clone(),
    }
}

// Unsupported targets never normalize a directory, read files, acquire a lock or listen.
#[cfg(not(all(windows, target_arch = "x86_64")))]
mod unsupported {
    use super::*;
    use crate::state::AppState;
    use std::sync::Arc;
    pub struct DesktopBridge;
    #[derive(Clone)]
    pub struct AuthorizationGeneration;
    impl AuthorizationGeneration {
        pub fn epoch(&self) -> u64 {
            0
        }
        pub fn is_cancelled(&self) -> bool {
            true
        }
        pub async fn cancelled(&self) {}
    }
    impl DesktopBridge {
        pub fn new(_: &Arc<AppState>) -> Arc<Self> {
            Arc::new(Self)
        }
        pub fn profile(&self) -> Option<Profile> {
            None
        }
        pub fn status(&self) -> DesktopStatus {
            let mut status = DesktopStatus::empty(false, None);
            status.error = Some(desktop_error(&failure(
                "desktop_platform_unsupported",
                "DBX desktop data requires Windows x64",
            )));
            status
        }
        pub async fn restore(self: &Arc<Self>) -> Result<DesktopStatus, ApiError> {
            Err(failure(
                "desktop_platform_unsupported",
                "DBX desktop data requires Windows x64",
            ))
        }
        pub async fn connect_authorization(self: &Arc<Self>) -> Result<DesktopStatus, ApiError> {
            self.restore().await
        }
        pub async fn disconnect(self: &Arc<Self>) -> Result<DesktopStatus, ApiError> {
            self.restore().await
        }
        pub fn capture_generation(&self) -> Option<AuthorizationGeneration> {
            None
        }
        pub fn is_current(&self, _: &AuthorizationGeneration) -> bool {
            false
        }
        pub fn begin_shutdown(&self) {}
        pub async fn shutdown(self: &Arc<Self>) {}
    }
}
#[cfg(not(all(windows, target_arch = "x86_64")))]
pub use unsupported::{AuthorizationGeneration, DesktopBridge};
