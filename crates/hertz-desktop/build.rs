// SPDX-License-Identifier: MIT
#[path = "../../build-support/desktop-build.rs"]
mod desktop_build;

fn main() {
    let root = std::path::PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"),
    )
    .join("../..");
    desktop_build::emit(&root, false);
}
