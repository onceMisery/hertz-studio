// SPDX-License-Identifier: MIT
//! Shared build identity calculation for the desktop component and its callers.
//! Hash source/resource inputs, not checkout paths, timestamps or a mutable tag.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

pub fn emit(root: &Path, plugin: bool) {
    // Cargo can reuse a compiled build script in another checkout sharing target/.
    // Resolve inputs from that invocation and invalidate cached output when it moves.
    println!("cargo:rerun-if-env-changed=CARGO_MANIFEST_DIR");
    println!("cargo:rerun-if-env-changed=RUSTC");
    println!("cargo:rerun-if-env-changed=CARGO_ENCODED_RUSTFLAGS");
    let mut desktop = BTreeSet::new();
    for relative in [
        "Cargo.toml",
        "Cargo.lock",
        "build-support/desktop-build.rs",
        "crates/hertz-desktop/Cargo.toml",
        "crates/hertz-desktop/build.rs",
        "crates/hertz-desktop/src",
        "crates/hertz-desktop/assets",
        "crates/hertz-desktop-ipc/Cargo.toml",
        "crates/hertz-desktop-ipc/src",
        "plugin/ui/vendor/stage-runtime.js",
        "plugin/ui/vendor/zodiac-stage.js",
    ] {
        collect(root, relative, &mut desktop);
    }
    let compiler = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let output = std::process::Command::new(compiler)
        .arg("--version")
        .output()
        .expect("read desktop build compiler identity");
    assert!(
        output.status.success(),
        "read desktop build compiler identity"
    );
    let compiler = String::from_utf8(output.stdout).expect("compiler identity is UTF-8");
    let profile = std::env::var("PROFILE").expect("Cargo profile");
    let flags = std::env::var("CARGO_ENCODED_RUSTFLAGS").unwrap_or_default();
    let target = std::env::var("TARGET").expect("Cargo target");
    // Unsupported plugin platforms refer to the published Windows MSVC component.
    // On Windows retain the actual ABI; a GNU build must not claim the MSVC identity.
    let desktop_target = if target.contains("-windows-") {
        target.as_str()
    } else {
        "x86_64-pc-windows-msvc"
    };
    let mut desktop_context = format!(
        "desktop/2\n{desktop_target}\n{}\n{profile}\n{flags}",
        compiler.trim()
    );
    for setting in [
        "OPT_LEVEL",
        "DEBUG",
        "CARGO_CFG_PANIC",
        "CARGO_CFG_DEBUG_ASSERTIONS",
    ] {
        println!("cargo:rerun-if-env-changed={setting}");
        desktop_context.push_str(&format!(
            "\n{setting}={}",
            std::env::var(setting).unwrap_or_default()
        ));
    }
    // Cargo exposes only a subset of the effective profile as direct build-script
    // variables. Retain explicit profile overrides as well (LTO, debug level,
    // codegen units, etc.); manifest settings are already source inputs above.
    let mut overrides: Vec<_> = std::env::vars()
        .filter(|(name, _)| name.starts_with("CARGO_PROFILE_"))
        .collect();
    overrides.sort();
    for (name, value) in overrides {
        println!("cargo:rerun-if-env-changed={name}");
        desktop_context.push_str(&format!("\n{name}={value}"));
    }
    let desktop_id = digest(root, &desktop, &desktop_context);
    println!("cargo:rustc-env=HERTZ_DESKTOP_BUILD_ID={desktop_id}");
    if plugin {
        let mut inputs = desktop;
        for relative in [
            "crates",
            "migrations",
            "plugin/backend/Cargo.toml",
            "plugin/backend/src",
            "plugin/vendor/dbx-plugin-sdk/src",
            "plugin/vendor/dbx-plugin-sdk/Cargo.toml",
            "plugin/ui",
            "plugin/assets",
            "plugin/manifest.json",
            "plugin/dbx-plugin.toml",
            "build-support/edition-ui.rs",
            "scripts/prepare-edition.js",
            "scripts/minify-ui.js",
            "tools/space-stage/package.json",
            "tools/space-stage/package-lock.json",
        ] {
            collect(root, relative, &mut inputs);
        }
        let edition = if std::env::var_os("CARGO_FEATURE_FULL").is_some() {
            "full"
        } else {
            "standard"
        };
        let context = format!("dbx/1\n{edition}\n{target}\n{desktop_context}");
        let plugin_id = digest(root, &inputs, &context);
        println!("cargo:rustc-env=HERTZ_PLUGIN_BUILD_ID={plugin_id}");
    }
}

fn collect(root: &Path, relative: &str, inputs: &mut BTreeSet<PathBuf>) {
    let path = root.join(relative);
    println!("cargo:rerun-if-changed={}", path.display());
    if !path.exists() {
        // During D0 the shared IPC crate is introduced independently. A missing
        // input is represented explicitly, never silently substituted by Git.
        inputs.insert(PathBuf::from(relative));
        return;
    }
    if path.is_dir() {
        for entry in std::fs::read_dir(&path).expect("read build input directory") {
            let entry = entry.expect("read build input entry");
            let name = entry.file_name();
            if matches!(
                name.to_str(),
                Some("target" | "node_modules" | "output" | ".git")
            ) {
                continue;
            }
            let child = PathBuf::from(relative).join(name);
            collect(root, &child.to_string_lossy(), inputs);
        }
    } else {
        inputs.insert(PathBuf::from(relative));
    }
}

fn digest(root: &Path, inputs: &BTreeSet<PathBuf>, context: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(context.as_bytes());
    for relative in inputs {
        let name = relative.to_string_lossy().replace('\\', "/");
        hash.update((name.len() as u64).to_le_bytes());
        hash.update(name.as_bytes());
        match std::fs::read(root.join(relative)) {
            Ok(bytes) => {
                hash.update([1]);
                hash.update((bytes.len() as u64).to_le_bytes());
                hash.update(bytes);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => hash.update([0]),
            Err(error) => panic!("read build input {name}: {error}"),
        }
    }
    format!("{:x}", hash.finalize())
}
