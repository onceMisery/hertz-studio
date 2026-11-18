// SPDX-License-Identifier: MIT
//! Side-effect-free component identity. Describing a binary never opens the UI or config.

pub(crate) const MANAGEMENT_PROTOCOL: u32 = 2;
pub(crate) const BRIDGE_PROTOCOL: Option<u32> = None;
pub(crate) const BUILD_ID: &str = env!("HERTZ_DESKTOP_BUILD_ID");

pub(crate) fn description() -> serde_json::Value {
    serde_json::json!({
        "componentProtocol": 1,
        "version": env!("CARGO_PKG_VERSION"),
        "target": if cfg!(target_arch = "x86_64") { "windows-x64" } else { "unsupported" },
        "desktopBuildId": BUILD_ID,
        "managementProtocol": MANAGEMENT_PROTOCOL,
        "bridgeProtocol": BRIDGE_PROTOCOL,
        "launchMode": "manual",
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn component_identity_no_longer_advertises_a_dbx_bridge() {
        let identity = super::description();
        assert!(identity["bridgeProtocol"].is_null());
        assert_eq!(identity["managementProtocol"], 2);
        assert_eq!(identity["desktopBuildId"], super::BUILD_ID);
    }
}
