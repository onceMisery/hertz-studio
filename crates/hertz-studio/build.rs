// SPDX-License-Identifier: MIT
#[path = "../../build-support/desktop-build.rs"]
mod desktop_build;
#[path = "../../build-support/edition-ui.rs"]
mod edition_ui;

fn main() {
    for (output, input) in [
        ("HERTZ_BUILD_TARGET", "TARGET"),
        ("HERTZ_BUILD_PROFILE", "PROFILE"),
    ] {
        println!(
            "cargo:rustc-env={output}={}",
            std::env::var(input).expect("Cargo build identity")
        );
    }
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
    let root = std::path::PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"),
    )
    .join("../..");
    embed_windows_icon(&root).expect("embed Windows application icon");
    desktop_build::emit(&root, true);
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

/// A Windows .res file stores the ICO frames and their group directory directly.
/// Writing this small standard container avoids a resource-compiler dependency
/// for MSVC builds; the linker consumes the same format emitted by rc.exe.
fn embed_windows_icon(root: &std::path::Path) -> std::io::Result<()> {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return Ok(());
    }
    let icon_path = root.join("plugin/ui/icons/hertz-studio.ico");
    println!("cargo:rerun-if-changed={}", icon_path.display());
    let icon = std::fs::read(icon_path)?;
    let u16_at = |offset| u16::from_le_bytes(icon[offset..offset + 2].try_into().unwrap());
    let u32_at = |offset| u32::from_le_bytes(icon[offset..offset + 4].try_into().unwrap());
    assert!(
        icon.len() >= 6 && u16_at(0) == 0 && u16_at(2) == 1,
        "valid ICO"
    );
    let count = u16_at(4) as usize;
    assert!(icon.len() >= 6 + count * 16 && count > 0, "ICO entries");
    let mut resource = Vec::new();
    fn entry(out: &mut Vec<u8>, kind: u16, id: u16, data: &[u8], flags: u16) {
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&32u32.to_le_bytes());
        for value in [0xffffu16, kind, 0xffff, id] {
            out.extend_from_slice(&value.to_le_bytes());
        }
        out.extend_from_slice(&0u32.to_le_bytes()); // DataVersion
        out.extend_from_slice(&flags.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // language neutral
        out.extend_from_slice(&0u32.to_le_bytes()); // Version
        out.extend_from_slice(&0u32.to_le_bytes()); // Characteristics
        out.extend_from_slice(data);
        while out.len() % 4 != 0 {
            out.push(0);
        }
    }
    entry(&mut resource, 0, 0, &[], 0); // required null resource
    let mut group = icon[..6].to_vec();
    for index in 0..count {
        let cursor = 6 + index * 16;
        let size = u32_at(cursor + 8) as usize;
        let offset = u32_at(cursor + 12) as usize;
        assert!(offset + size <= icon.len(), "ICO frame bounds");
        let id = index as u16 + 1;
        entry(&mut resource, 3, id, &icon[offset..offset + size], 0x1010);
        group.extend_from_slice(&icon[cursor..cursor + 12]);
        group.extend_from_slice(&id.to_le_bytes());
    }
    entry(&mut resource, 14, 1, &group, 0x1030);
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let resource_path = output.join("hertz-studio-icon.res");
    std::fs::write(&resource_path, resource)?;
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!(
            "cargo:rustc-link-arg-bin=hertz-studio={}",
            resource_path.display()
        );
    } else {
        let object = output.join("hertz-studio-icon.o");
        let status = std::process::Command::new("windres")
            .args(["-J", "res", "-O", "coff", "-i"])
            .arg(&resource_path)
            .arg("-o")
            .arg(&object)
            .status()?;
        assert!(status.success(), "convert Windows icon resource");
        println!("cargo:rustc-link-arg-bin=hertz-studio={}", object.display());
    }
    Ok(())
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
