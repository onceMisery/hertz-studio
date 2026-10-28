// SPDX-License-Identifier: MIT
//! Management business admission. The raw JSON pipe owns transport limits/cancellation only.

use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::{self, Profile};

pub(crate) const STALE_AFTER: Duration = Duration::from_secs(3);
pub(crate) const V2_COMMANDS: &[&str] = &[
    "status",
    "wallpaper-status",
    "open-center",
    "wallpaper-settings",
    "hide",
    "wallpaper-show",
    "wallpaper-hide",
    "wallpaper-retry",
    "wallpaper-preview",
    "wallpaper-preview-close",
    "wallpaper-preview-renew",
    "wallpaper-apply",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    management_protocol: u32,
    pub(crate) request_id: String,
    pub(crate) target_profile: Profile,
    required_desktop_build_id: String,
    pub(crate) command: String,
    #[serde(default)]
    pub(crate) value: Value,
}

pub(crate) fn is_versioned(value: &Value) -> bool {
    [
        "managementProtocol",
        "requestId",
        "targetProfile",
        "requiredDesktopBuildId",
    ]
    .iter()
    .any(|key| value.get(key).is_some())
}

pub(crate) fn error(code: &str) -> Value {
    json!({"ok": false, "error": code})
}

/// An occupied GUI slot has no admission for target normalization or business parsing.
pub(crate) fn busy_reply(request: &Value) -> Value {
    if is_versioned(request) {
        reply(
            error("control_busy"),
            request.get("requestId").and_then(Value::as_str),
        )
    } else {
        error("control busy")
    }
}

pub(crate) fn reply(mut response: Value, request_id: Option<&str>) -> Value {
    let request_id = request_id.filter(|id| valid_request_id(id));
    response["managementProtocol"] = crate::component::MANAGEMENT_PROTOCOL.into();
    response["desktopBuildId"] = crate::component::BUILD_ID.into();
    response["requestId"] = request_id.map(Value::from).unwrap_or(Value::Null);
    if hertz_desktop_ipc::frame::serialize_bounded(
        &response,
        hertz_desktop_ipc::management::MESSAGE_LIMIT,
    )
    .is_ok()
    {
        response
    } else {
        json!({
            "ok": false, "error": "management_response_too_large",
            "managementProtocol": crate::component::MANAGEMENT_PROTOCOL,
            "desktopBuildId": crate::component::BUILD_ID, "requestId": request_id,
        })
    }
}

fn valid_request_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_graphic())
}

pub(crate) fn parse(value: &Value) -> Result<Request, Value> {
    let request_id = value.get("requestId").and_then(Value::as_str);
    let fail = |code| reply(error(code), request_id);
    if value.get("managementProtocol").and_then(Value::as_u64) != Some(2) {
        return Err(fail("unsupported_management_protocol"));
    }
    if request_id.is_none_or(|id| !valid_request_id(id)) {
        return Err(fail("invalid_request_id"));
    }
    let mut request: Request =
        serde_json::from_value(value.clone()).map_err(|_| fail("invalid_management_request"))?;
    if request.management_protocol != 2 {
        return Err(fail("unsupported_management_protocol"));
    }
    request.target_profile = config::normalize_profile(request.target_profile)
        .map_err(|_| fail("invalid_target_profile"))?;
    if request.required_desktop_build_id != crate::component::BUILD_ID {
        return Err(fail("desktop_build_mismatch"));
    }
    if !V2_COMMANDS.contains(&request.command.as_str()) {
        return Err(fail("unsupported_command"));
    }
    Ok(request)
}

impl Request {
    pub(crate) fn check_target(&self, active: Option<&Profile>) -> Result<(), Value> {
        if matches!(
            self.command.as_str(),
            "status" | "wallpaper-status" | "open-center" | "wallpaper-settings"
        ) {
            return Ok(());
        }
        if !active.is_some_and(|active| config::same_profile(active, &self.target_profile)) {
            return Err(error("desktop_source_mismatch"));
        }
        Ok(())
    }

    /// Validate the accepted command's whole value before any window/config business call.
    pub(crate) fn check_value(&self, revision: u64, save_pending: bool) -> Result<(), Value> {
        let fields: &[&str] = match self.command.as_str() {
            "open-center" | "wallpaper-settings" => &["tab"],
            "wallpaper-preview" => &[
                "enabled",
                "fps",
                "musicResponse",
                "monitor",
                "source",
                "scene",
            ],
            "wallpaper-apply" => &["expectedRevision", "config"],
            _ => &[],
        };
        if !self.value.is_null()
            && !self
                .value
                .as_object()
                .is_some_and(|object| object.keys().all(|key| fields.contains(&key.as_str())))
        {
            return Err(error("invalid_value"));
        }
        if matches!(self.command.as_str(), "open-center" | "wallpaper-settings")
            && self.value.get("tab").is_some_and(|tab| {
                !matches!(tab.as_str(), Some("lyrics" | "wallpaper" | "runtime"))
            })
        {
            return Err(error("invalid_value"));
        }
        if self.command == "wallpaper-apply" {
            let expected = self
                .value
                .get("expectedRevision")
                .and_then(Value::as_u64)
                .ok_or_else(|| error("invalid_expected_revision"))?;
            if expected != revision || save_pending {
                return Err(error("desktop_revision_conflict"));
            }
            let config = self
                .value
                .get("config")
                .and_then(Value::as_object)
                .ok_or_else(|| error("invalid_value"))?;
            let fields = [
                "enabled",
                "fps",
                "musicResponse",
                "monitor",
                "source",
                "scene",
            ];
            if config.keys().any(|key| !fields.contains(&key.as_str())) {
                return Err(error("invalid_value"));
            }
        }
        Ok(())
    }
}

/// Accepted, authenticated source data only. No playback state or listener/discovery facts.
#[derive(Default)]
pub(crate) struct SourceHealth {
    session: Option<String>,
    lyrics: Option<Instant>,
    wallpaper: Option<Instant>,
}

impl SourceHealth {
    pub(crate) fn accept(&mut self, lyrics: bool, started: Instant, session: &str) {
        if self.session.as_deref() != Some(session) {
            *self = Self {
                session: Some(session.into()),
                ..Self::default()
            };
        }
        *if lyrics {
            &mut self.lyrics
        } else {
            &mut self.wallpaper
        } = Some(started);
    }
    pub(crate) fn fail(&mut self, lyrics: bool) {
        *if lyrics {
            &mut self.lyrics
        } else {
            &mut self.wallpaper
        } = None;
    }
    pub(crate) fn scopes(&self, target_is_active: bool, now: Instant) -> Value {
        let fresh = |at: Option<Instant>| {
            target_is_active && at.is_some_and(|at| now.saturating_duration_since(at) < STALE_AFTER)
        };
        json!({"lyrics": fresh(self.lyrics), "wallpaper": fresh(self.wallpaper)})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn busy_reply_preserves_legacy_shape_and_correlates_versioned_overload_without_admission() {
        assert_eq!(
            busy_reply(&json!({"command":"status"})),
            json!({"ok":false,"error":"control busy"})
        );
        let response = busy_reply(&json!({"requestId":"busy-7","targetProfile":"never parsed"}));
        assert_eq!(response["requestId"], "busy-7");
        assert_eq!(response["managementProtocol"], 2);
        assert_eq!(response["desktopBuildId"], crate::component::BUILD_ID);
        assert_eq!(response["error"], "control_busy");
        assert!(busy_reply(&json!({"requestId":"has space"}))["requestId"].is_null());
    }

    #[test]
    fn connectivity_requires_target_fresh_authenticated_scope_and_current_session() {
        let mut health = SourceHealth::default();
        let now = Instant::now();
        assert_eq!(
            health.scopes(true, now),
            json!({"lyrics":false,"wallpaper":false})
        );
        health.accept(true, now, "one");
        health.accept(false, now, "one");
        assert_eq!(
            health.scopes(false, now),
            json!({"lyrics":false,"wallpaper":false})
        );
        assert_eq!(
            health.scopes(true, now),
            json!({"lyrics":true,"wallpaper":true})
        );
        health.fail(true);
        assert_eq!(
            health.scopes(true, now),
            json!({"lyrics":false,"wallpaper":true})
        );
        assert_eq!(
            health.scopes(true, now + STALE_AFTER),
            json!({"lyrics":false,"wallpaper":false})
        );
        health.accept(true, now, "two");
        assert_eq!(
            health.scopes(true, now),
            json!({"lyrics":true,"wallpaper":false})
        );
    }

    #[test]
    fn transport_size_fallback_preserves_valid_correlation_without_reflecting_invalid_ids() {
        let response = reply(
            json!({"ok":true,"profile":"x".repeat(8192)}),
            Some("query-9"),
        );
        assert_eq!(response["requestId"], "query-9");
        assert_eq!(response["managementProtocol"], 2);
        assert_eq!(response["desktopBuildId"], crate::component::BUILD_ID);
        assert_eq!(response["error"], "management_response_too_large");
        assert!(serde_json::to_vec(&response).unwrap().len() < 8192);
        assert!(reply(error("invalid_request_id"), Some(&"x".repeat(8192)))["requestId"].is_null());
        assert!(reply(error("invalid_request_id"), Some("line\nbreak"))["requestId"].is_null());
    }
}
