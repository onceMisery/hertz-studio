// SPDX-License-Identifier: MIT
//! Standalone desktop facade. The original in-process host owns every window and command.
//! DBX has no desktop management RPC, discovery, authorization or launch path.
pub(crate) mod standalone;

use crate::{
    error::{internal, ApiError},
    state::AppState,
};
use hertz_desktop_ipc::{Profile, Scope};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{Arc, Weak};

#[cfg(test)]
pub(crate) use standalone::CONTROL_COMMANDS;
pub(crate) use standalone::{ControlRequest, CONTROL_BODY_BYTES};

#[derive(Debug, Clone, Serialize)]
pub(crate) struct DesktopError {
    pub code: &'static str,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Component {
    pub state: &'static str,
    pub origin: Option<&'static str>,
    pub error: Option<DesktopError>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ScopeFailure {
    pub scope: Scope,
    pub error: DesktopError,
}

// Retain the REST response fields for existing standalone clients. No bridge
// authorization is inferred from old files, and no listener is created here.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Authorization {
    pub scopes: Vec<Scope>,
    pub revision: Option<u64>,
    pub gate: bool,
    pub listener_ready: bool,
    pub persistent_revoked: bool,
    pub cleanup_incomplete: bool,
    pub scope_errors: Vec<ScopeFailure>,
    pub error: Option<DesktopError>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub(crate) struct SourceScopes {
    pub lyrics: bool,
    pub wallpaper: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Capabilities {
    pub supported: bool,
    pub reason: Option<&'static str>,
    pub error: Option<DesktopError>,
    pub source: Option<Profile>,
    pub transport: &'static str,
    pub build_id: &'static str,
    pub required_desktop_build_id: &'static str,
    pub launch_mode: &'static str,
    pub component: Component,
    pub authorization: Authorization,
    pub management_protocol: u32,
    pub bridge_protocol: u32,
    pub launch_requested: bool,
    pub management_ready: bool,
    pub source_connected: bool,
    pub source_scopes: SourceScopes,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CapabilitiesQuery {
    #[serde(default)]
    pub refresh: bool,
}

pub(crate) struct Desktop {
    state: Weak<AppState>,
}

impl Desktop {
    pub fn for_state(state: &Arc<AppState>) -> Arc<Self> {
        state
            .desktop
            .get_or_init(|| {
                Arc::new(Self {
                    state: Arc::downgrade(state),
                })
            })
            .clone()
    }

    pub(crate) async fn calibration_authorization(
        &self,
        enabled: Option<bool>,
    ) -> Result<Value, ApiError> {
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| internal("Service stopped"))?;
        state
            .lyrics_calibration
            .standalone_authorization(&state, enabled)
    }

    fn source(&self) -> Option<Profile> {
        self.state.upgrade().map(|state| Profile::Standalone {
            // The embedded host binds HostOptions.data_dir as a custom standalone source.
            edition: "custom".into(),
            data_dir: state.data_dir.to_string_lossy().into_owned(),
        })
    }

    /// In-process liveness only. Reading capabilities never starts a window or probes files/pipes.
    pub fn cached(&self) -> Capabilities {
        let supported = cfg!(all(
            windows,
            target_arch = "x86_64",
            feature = "desktop-host"
        ));
        let running = supported && crate::desktop_host::is_running();
        Capabilities {
            supported,
            reason: Some(if !cfg!(feature = "desktop-host") {
                "desktop-feature-disabled"
            } else if !supported {
                "unsupported-target"
            } else if running {
                "host-running"
            } else {
                "not-running"
            }),
            error: None,
            source: self.source(),
            transport: "in-process",
            build_id: env!("HERTZ_STUDIO_BUILD_ID"),
            required_desktop_build_id: env!("HERTZ_DESKTOP_BUILD_ID"),
            launch_mode: "embedded",
            component: Component {
                state: if running { "ready" } else { "not-running" },
                origin: Some("embedded"),
                error: None,
            },
            authorization: Authorization::default(),
            management_protocol: 2,
            bridge_protocol: 0,
            launch_requested: running,
            management_ready: false,
            source_connected: false,
            source_scopes: SourceScopes::default(),
        }
    }

    pub async fn capabilities(self: &Arc<Self>, refresh: bool) -> Capabilities {
        let mut result = self.cached();
        if !refresh || !result.launch_requested {
            return result;
        }
        match self
            .control(ControlRequest {
                command: "status".into(),
                value: None,
            })
            .await
        {
            Ok(status)
                if status["ok"] == true
                    && status["desktopBuildId"] == result.required_desktop_build_id =>
            {
                result.management_ready = true;
                if is_active_source(&status["activeProfile"], result.source.as_ref()) {
                    result.source_scopes.lyrics = status["sourceScopes"]["lyrics"] == true;
                    result.source_scopes.wallpaper = status["sourceScopes"]["wallpaper"] == true;
                    result.source_connected =
                        result.source_scopes.lyrics || result.source_scopes.wallpaper;
                }
            }
            Ok(_) => {
                result.error = Some(DesktopError {
                    code: "desktop_response_invalid",
                    message: "桌面宿主返回了不匹配的状态".into(),
                })
            }
            Err(error) => {
                result.error = Some(DesktopError {
                    code: error.code,
                    message: error.message,
                })
            }
        }
        result
    }

    pub async fn control(self: &Arc<Self>, request: ControlRequest) -> Result<Value, ApiError> {
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| internal("Service stopped"))?;
        standalone::control(&state, request).await
    }

    pub async fn launch(self: &Arc<Self>, wallpaper: bool) -> Result<Value, ApiError> {
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| internal("Service stopped"))?;
        standalone::launch(&state, wallpaper).await
    }
}

/// Refresh compares the host's validated source identity, including Windows path aliases.
fn is_active_source(value: &Value, expected: Option<&Profile>) -> bool {
    let Some(expected) = expected else {
        return false;
    };
    let Ok(active) = serde_json::from_value::<Profile>(value.clone()) else {
        return false;
    };
    if !matches!(active, Profile::Standalone { .. }) {
        return false;
    }
    match (expected.normalized(), active.normalized()) {
        (Ok(expected), Ok(active)) => expected == active,
        _ => false,
    }
}

#[cfg(test)]
mod tests;
