// SPDX-License-Identifier: MIT
//! Read-only identity of the bytes being packaged; no service or filesystem use.
use sha2::{Digest, Sha256};

pub(super) fn description() -> serde_json::Value {
    let mut ui = Sha256::new();
    for (name, bytes) in [
        ("index.html", super::INDEX_HTML.as_bytes()),
        ("overlay.html", super::OVERLAY_HTML.as_bytes()),
    ]
    .into_iter()
    .chain(
        super::assets::UI_ASSETS
            .iter()
            .map(|asset| (asset.path, asset.body.gzip)),
    ) {
        ui.update((name.len() as u64).to_le_bytes());
        ui.update(name.as_bytes());
        ui.update((bytes.len() as u64).to_le_bytes());
        ui.update(bytes);
    }
    serde_json::json!({
        "schemaVersion": 1,
        "kind": "hertz-studio",
        "version": env!("CARGO_PKG_VERSION"),
        "edition": hertz_studio::edition::NAME,
        "target": env!("HERTZ_BUILD_TARGET"),
        "profile": env!("HERTZ_BUILD_PROFILE"),
        "compiler": env!("HERTZ_BUILD_RUSTC_VERSION"),
        "buildId": env!("HERTZ_STUDIO_BUILD_ID"),
        "uiSha256": format!("{:x}", ui.finalize()),
        "capabilities": {
            "nativeWindow": cfg!(feature = "native-window"),
            "windowsSystemMedia": cfg!(all(windows, feature = "native-window")),
            "embeddedDesktop": cfg!(windows),
            "windowsInstallGuard": cfg!(windows),
        },
        "desktopBuildId": env!("HERTZ_DESKTOP_BUILD_ID"),
        "databaseSchemaVersion": vmusic_store::upgrade::current_schema(),
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn description_matches_compiled_capabilities_and_embedded_resources() {
        let value = super::description();
        assert_eq!(value["edition"], hertz_studio::edition::NAME);
        assert_eq!(
            value["capabilities"]["nativeWindow"],
            cfg!(feature = "native-window")
        );
        assert_eq!(
            value["capabilities"]["windowsSystemMedia"],
            cfg!(all(windows, feature = "native-window"))
        );
        for key in ["buildId", "uiSha256", "desktopBuildId"] {
            let hash = value[key].as_str().unwrap();
            assert_eq!(hash.len(), 64);
            assert!(hash.chars().all(|character| character.is_ascii_hexdigit()));
        }
        assert_eq!(value, super::description());
    }
}
