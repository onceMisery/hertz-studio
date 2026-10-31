// SPDX-License-Identifier: MIT
//! Side-effect-free component identity. Describing a binary never opens the UI or config.

pub(crate) const MANAGEMENT_PROTOCOL: u32 = 2;
pub(crate) const DBX_BRIDGE_PROTOCOL: Option<u32> = Some(1);
pub(crate) const BUILD_ID: &str = env!("HERTZ_DESKTOP_BUILD_ID");

pub(crate) fn description() -> serde_json::Value {
    serde_json::json!({
        "componentProtocol": 1,
        "version": env!("CARGO_PKG_VERSION"),
        "target": if cfg!(target_arch = "x86_64") { "windows-x64" } else { "unsupported" },
        "desktopBuildId": BUILD_ID,
        "managementProtocol": MANAGEMENT_PROTOCOL,
        "bridgeProtocol": DBX_BRIDGE_PROTOCOL,
        "launchMode": "manual",
    })
}
