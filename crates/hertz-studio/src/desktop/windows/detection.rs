// SPDX-License-Identifier: MIT
//! Prefer a compatible running host before inspecting the fixed optional installation.
use super::super::error;
use super::{check, component, io_error, protocol, Component, DesktopError, Environment};
use hertz_desktop_ipc::{management, windows::Cancellation};
use serde_json::json;
use std::{io, time::Instant};
#[derive(Clone)]
pub(super) struct Detection {
    pub component: Component,
    pub running: bool,
    pub reason: &'static str,
    pub error: Option<DesktopError>,
}
pub(super) fn detect(
    environment: &Environment,
    cancel: &Cancellation,
    deadline: Instant,
) -> Result<Detection, DesktopError> {
    check(cancel, deadline).map_err(|e| io_error(&e))?;
    // Legacy status is the ONLY request sent before compatibility has been established.
    let probe = management::request_until(
        &environment.pipe,
        &json!({"command":"status"}),
        cancel,
        Some(deadline),
    );
    check(cancel, deadline).map_err(|e| io_error(&e))?;
    if probe.as_ref().is_ok_and(protocol::compatible) {
        return Ok(Detection {
            component: Component {
                state: "ready",
                origin: Some("running"),
                error: None,
            },
            running: true,
            reason: "management-ready",
            error: None,
        });
    }
    let component = component::discover(environment.installation.as_deref(), cancel, deadline);
    check(cancel, deadline).map_err(|e| io_error(&e))?;
    let (reason, failure) = match probe {
        Ok(value) if matches!(value["error"].as_str(), Some("control busy" | "control_busy")) => ("management-busy", error("desktop_control_busy", "The desktop component is busy; retry shortly")),
        Ok(_) => ("incompatible-host", error("desktop_component_incompatible", "The running desktop host does not support this plugin build and management contract")),
        Err(failure) if failure.kind() != io::ErrorKind::NotFound => ("management-unknown", io_error(&failure)),
        Err(_) => match component.state {
            "ready" => ("start-required", error("desktop_component_start_required", "The compatible desktop component is installed; start it manually and retry")),
            "missing" => ("component-missing", component.error.clone().expect("missing diagnostic")),
            "incompatible" => ("component-incompatible", component.error.clone().expect("integrity diagnostic")),
            _ => ("component-unknown", component.error.clone().unwrap_or_else(|| error("desktop_unavailable", "Cannot inspect the desktop component"))),
        },
    };
    Ok(Detection {
        component,
        running: false,
        reason,
        error: Some(failure),
    })
}
