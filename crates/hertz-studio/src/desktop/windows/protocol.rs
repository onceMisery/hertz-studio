// SPDX-License-Identifier: MIT
use super::super::{error, DesktopError, SourceScopes};
use hertz_desktop_ipc::Profile;
use serde_json::{json, Value};

pub(super) const FRESHNESS: std::time::Duration = std::time::Duration::from_secs(3);

pub(super) fn compatible(value: &Value) -> bool {
    value.get("ok").and_then(Value::as_bool) == Some(true)
        && value.get("desktopBuildId").and_then(Value::as_str)
            == Some(env!("HERTZ_DESKTOP_BUILD_ID"))
        && value.get("managementProtocol").and_then(Value::as_u64) == Some(2)
        && value.get("bridgeProtocol").and_then(Value::as_u64) == Some(1)
        && ["targetProfile", "requestId", "requiredDesktopBuildId"]
            .iter()
            .all(|key| value["capabilities"][key] == true)
        && ["status", "open-center"].iter().all(|command| {
            value["capabilities"]["commands"]
                .as_array()
                .is_some_and(|commands| commands.iter().any(|v| v == command))
        })
        && value["capabilities"]["sourceFreshnessMs"]
            .as_u64()
            .is_some_and(|ms| ms > 0 && ms <= 3000)
        && value["capabilities"]["sourceSwitch"] == "native-center"
}
pub(super) fn envelope(profile: &Profile, command: &str, value: Value) -> (String, Value) {
    let id = uuid::Uuid::new_v4().to_string();
    let request = json!({ "managementProtocol": 2, "requestId": id,
        "requiredDesktopBuildId": env!("HERTZ_DESKTOP_BUILD_ID"),
        "targetProfile": profile, "command": command, "value": value });
    (id, request)
}
pub(super) fn validate(value: &Value, id: &str, target: &Profile) -> Result<(), DesktopError> {
    if value["requestId"].as_str() != Some(id)
        || value["desktopBuildId"].as_str() != Some(env!("HERTZ_DESKTOP_BUILD_ID"))
        || value["managementProtocol"].as_u64() != Some(2)
    {
        return Err(error(
            "desktop_response_invalid",
            "Desktop management reply identity does not match this request",
        ));
    }
    if value["ok"] != true {
        let code = match value["error"].as_str() {
            Some("control_busy") => "desktop_control_busy",
            Some("desktop_build_mismatch" | "unsupported_management_protocol") => {
                "desktop_component_incompatible"
            }
            Some("desktop_source_mismatch") => "desktop_source_mismatch",
            _ => "desktop_management_rejected",
        };
        return Err(error(code, "Desktop host rejected the management request; authorization remains available to retry or revoke"));
    }
    let reply_target = serde_json::from_value::<Profile>(value["targetProfile"].clone()).ok();
    if !compatible(value) || reply_target.as_ref() != Some(target) {
        return Err(error(
            "desktop_response_invalid",
            "Desktop reply has an invalid target or capability contract",
        ));
    }
    Ok(())
}
pub(super) fn scopes(value: &Value, target: &Profile, session: &str) -> SourceScopes {
    let active = serde_json::from_value::<Profile>(value["activeProfile"].clone()).ok();
    let reported = serde_json::from_value::<Profile>(value["targetProfile"].clone()).ok();
    if !active.as_ref().is_some_and(|active| {
        active
            .normalized()
            .ok()
            .zip(target.normalized().ok())
            .is_some_and(|(active, target)| active == target)
    }) || reported.as_ref() != Some(target)
        || value["sourceConnected"] != true
        || value["sourceSession"].as_str() != Some(session)
    {
        return SourceScopes::default();
    }
    SourceScopes {
        lyrics: value["sourceScopes"]["lyrics"] == true,
        wallpaper: value["sourceScopes"]["wallpaper"] == true,
    }
}
