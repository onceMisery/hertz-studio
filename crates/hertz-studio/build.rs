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
    println!(
        "cargo:rerun-if-changed={}",
        root.join("scripts/minify-ui.js").display()
    );
    for file in [
        "tools/space-stage/package.json",
        "tools/space-stage/package-lock.json",
    ] {
        println!("cargo:rerun-if-changed={}", root.join(file).display());
    }
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        let status = std::process::Command::new("node")
            .arg("-e")
            .arg("require(process.argv[1]).minifyUi(process.argv[2])")
            .arg(root.join("scripts/minify-ui.js"))
            .arg(&dest)
            .status()
            .expect(
                "release UI requires Node.js; install tools/space-stage dependencies with npm ci",
            );
        assert!(
            status.success(),
            "release UI minification failed; run npm ci --prefix tools/space-stage"
        );
    }
    compress_assets(&dest).expect("precompress embedded UI assets");
}

fn compress_assets(directory: &std::path::Path) -> std::io::Result<()> {
    use std::io::Write;
    for entry in std::fs::read_dir(directory)? {
        let path = entry?.path();
        if path.is_dir() {
            compress_assets(&path)?;
        } else if matches!(
            path.extension().and_then(|s| s.to_str()),
            Some("js" | "css")
        ) {
            // GzipBuilder's zero mtime and omitted filename make output reproducible.
            let mut encoder = flate2::GzBuilder::new()
                .mtime(0)
                .write(Vec::new(), flate2::Compression::best());
            encoder.write_all(&std::fs::read(&path)?)?;
            std::fs::write(
                path.with_extension(format!(
                    "{}.gz",
                    path.extension().unwrap().to_str().unwrap()
                )),
                encoder.finish()?,
            )?;
        }
    }
    Ok(())
}
