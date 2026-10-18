// SPDX-License-Identifier: MIT
#[path = "../../build-support/edition-ui.rs"]
mod edition_ui;

fn main() {
    println!("cargo:rerun-if-env-changed=RUSTC");
    let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let compiler = std::process::Command::new(rustc)
        .arg("--version")
        .output()
        .expect("run the compiler selected by Cargo");
    assert!(compiler.status.success(), "read compiler version");
    println!(
        "cargo:rustc-env=HERTZ_BUILD_RUSTC_VERSION={}",
        String::from_utf8(compiler.stdout)
            .expect("compiler version is UTF-8")
            .trim()
    );
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let source = root.join("plugin/ui");
    println!("cargo:rerun-if-changed={}", source.display());
    println!(
        "cargo:rerun-if-changed={}",
        root.join("build-support/edition-ui.rs").display()
    );
    let dest = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("ui");
    // Cargo may reuse OUT_DIR after switching features.
    if dest.exists() {
        std::fs::remove_dir_all(&dest).unwrap();
    }
    edition_ui::generate(
        &source,
        &dest,
        std::env::var_os("CARGO_FEATURE_FULL").is_some(),
    )
    .unwrap();
}
