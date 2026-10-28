// SPDX-License-Identifier: MIT
//! One desktop management owner for REST and DBX. Construction and cached reads do no I/O.

mod standalone;
#[cfg(all(windows, target_arch = "x86_64"))]
mod windows;

use crate::{
    desktop_bridge::{DesktopBridge, DesktopError, ScopeFailure},
    error::{bad_request, ApiError},
    state::AppState,
};
use hertz_desktop_ipc::{Profile, Scope};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{Arc, OnceLock, Weak};

#[cfg(test)]
pub(crate) use standalone::CONTROL_COMMANDS;
pub(crate) use standalone::{ControlRequest, CONTROL_BODY_BYTES};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Component {
    pub state: &'static str,
    pub origin: Option<&'static str>,
    pub error: Option<DesktopError>,
}
impl Default for Component {
    fn default() -> Self {
        Self {
            state: "unknown",
            origin: None,
            error: None,
        }
    }
}

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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationResult {
    pub ok: bool,
    pub error: Option<DesktopError>,
    pub center_opened: bool,
    pub capabilities: Capabilities,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CapabilitiesQuery {
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Tab {
    Lyrics,
    Wallpaper,
    #[default]
    Runtime,
}
impl Tab {
    pub fn name(self) -> &'static str {
        match self {
            Self::Lyrics => "lyrics",
            Self::Wallpaper => "wallpaper",
            Self::Runtime => "runtime",
        }
    }
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ConnectRequest {
    #[serde(default)]
    pub tab: Tab,
}

pub(crate) fn parse_connect(body: &Value) -> Result<ConnectRequest, ApiError> {
    if body.is_null() {
        return Ok(ConnectRequest::default());
    }
    if !body.is_object() {
        return Err(bad_request("桌面连接请求必须是对象"));
    }
    serde_json::from_value(body.clone())
        .map_err(|_| bad_request("桌面连接只接受 tab: lyrics、wallpaper 或 runtime"))
}
pub(crate) fn parse_empty(body: &Value) -> Result<(), ApiError> {
    if body.is_null() || body.as_object().is_some_and(|o| o.is_empty()) {
        Ok(())
    } else {
        Err(bad_request("桌面断开不接受参数"))
    }
}
pub(super) fn error(code: &'static str, message: impl Into<String>) -> DesktopError {
    DesktopError {
        code,
        message: message.into(),
    }
}
pub(super) fn api_error(error: &ApiError) -> DesktopError {
    self::error(error.code, error.message.clone())
}

pub(crate) struct Desktop {
    state: Weak<AppState>,
    bridge: OnceLock<Arc<DesktopBridge>>,
    #[cfg(all(windows, target_arch = "x86_64"))]
    runtime: windows::Runtime,
}

impl Desktop {
    pub fn for_state(state: &Arc<AppState>) -> Arc<Self> {
        state
            .desktop
            .get_or_init(|| {
                Arc::new(Self {
                    state: Arc::downgrade(state),
                    bridge: OnceLock::new(),
                    #[cfg(all(windows, target_arch = "x86_64"))]
                    runtime: windows::Runtime::default(),
                })
            })
            .clone()
    }
    /// Called only by the sidecar's actual bridge assembly; page input cannot select a form.
    pub fn attach_bridge(&self, bridge: Arc<DesktopBridge>) {
        let _ = self.bridge.set(bridge);
    }
    fn source(&self) -> Option<Profile> {
        if let Some(bridge) = self.bridge.get() {
            return bridge.profile();
        }
        self.state.upgrade().map(|state| Profile::Standalone {
            edition: crate::edition::NAME.into(),
            data_dir: state.data_dir.to_string_lossy().into_owned(),
        })
    }
    fn authorization(&self) -> Authorization {
        self.bridge
            .get()
            .map_or_else(Authorization::default, |bridge| {
                let status = bridge.status();
                Authorization {
                    scopes: status.authorized_scopes,
                    revision: status.revision,
                    gate: bridge.capture_generation().is_some(),
                    listener_ready: status.listener_ready,
                    persistent_revoked: status.persistent_revoked,
                    cleanup_incomplete: status.cleanup_incomplete,
                    scope_errors: status.scope_errors,
                    error: status.error,
                }
            })
    }
    fn empty(&self) -> Capabilities {
        let supported = cfg!(all(windows, target_arch = "x86_64"));
        Capabilities {
            supported,
            reason: Some(if supported {
                "not-detected"
            } else {
                "unsupported-target"
            }),
            error: None,
            source: self.source(),
            transport: if self.bridge.get().is_some() {
                "named-pipe"
            } else {
                "http"
            },
            build_id: env!("HERTZ_PLUGIN_BUILD_ID"),
            required_desktop_build_id: env!("HERTZ_DESKTOP_BUILD_ID"),
            launch_mode: "manual",
            component: Component::default(),
            authorization: self.authorization(),
            management_protocol: 2,
            bridge_protocol: 1,
            launch_requested: false,
            management_ready: false,
            source_connected: false,
            source_scopes: SourceScopes::default(),
        }
    }
    pub fn cached(&self) -> Capabilities {
        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            self.runtime.cached(self)
        }
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        {
            self.empty()
        }
    }
    pub async fn capabilities(self: &Arc<Self>, refresh: bool) -> Capabilities {
        if !refresh {
            return self.cached();
        }
        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            self.refresh().await
        }
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        {
            self.empty()
        }
    }
    fn result(&self, failure: Option<DesktopError>, center_opened: bool) -> OperationResult {
        OperationResult {
            ok: failure.is_none(),
            error: failure,
            center_opened,
            capabilities: self.cached(),
        }
    }
    pub async fn connect(self: &Arc<Self>, tab: Tab) -> OperationResult {
        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            self.connect_windows(tab).await
        }
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        {
            let _ = tab;
            self.result(
                Some(error(
                    "desktop_platform_unsupported",
                    "DBX desktop data requires Windows x64",
                )),
                false,
            )
        }
    }
    pub async fn disconnect(self: &Arc<Self>) -> OperationResult {
        #[cfg(all(windows, target_arch = "x86_64"))]
        self.runtime.invalidate();
        let Some(bridge) = self.bridge.get() else {
            return self.result(
                Some(error(
                    "desktop_dbx_required",
                    "Desktop source authorization requires a DBX sidecar",
                )),
                false,
            );
        };
        // No management-worker join or management lock before bridge.disconnect's gate closure.
        let result = bridge.disconnect().await;
        self.result(result.err().as_ref().map(api_error), false)
    }
    pub async fn control(self: &Arc<Self>, request: ControlRequest) -> Result<Value, ApiError> {
        if self.bridge.get().is_none() {
            return standalone::control(request).await;
        }
        match request.command.as_str() {
            "status" if request.value.as_ref().is_none_or(Value::is_null) => {
                Ok(serde_json::to_value(self.capabilities(true).await).expect("desktop DTO"))
            }
            "open-center" => {
                let request = parse_connect(request.value.as_ref().unwrap_or(&Value::Null))?;
                Ok(serde_json::to_value(self.connect(request.tab).await).expect("desktop DTO"))
            }
            _ => Err(bad_request(
                "DBX 桌面控制只支持 status 或 open-center；来源切换请使用桌面设置中心",
            )),
        }
    }
    pub async fn launch(self: &Arc<Self>, wallpaper: bool) -> Result<Value, ApiError> {
        if self.bridge.get().is_some() {
            return Ok(serde_json::to_value(
                self.connect(if wallpaper {
                    Tab::Wallpaper
                } else {
                    Tab::Lyrics
                })
                .await,
            )
            .expect("desktop DTO"));
        }
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| crate::error::internal("Service stopped"))?;
        let result = standalone::launch(&state, wallpaper)?;
        #[cfg(all(windows, target_arch = "x86_64"))]
        self.runtime.launched();
        Ok(result)
    }
}

#[cfg(test)]
mod tests;
