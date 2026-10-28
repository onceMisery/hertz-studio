// SPDX-License-Identifier: MIT
#[path = "../../build-support/desktop-build.rs"]
mod desktop_build;

fn main() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    desktop_build::emit(&root, false);
}
