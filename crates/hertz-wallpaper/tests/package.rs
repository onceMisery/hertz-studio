// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 包合同边界测试（设计 §21.1 `crates/hertz-wallpaper/tests/package.rs`）：
//! §6.1 文档 fixture 的真实包往返、哈希/长度/MIME 变异、C09 路径与容器反例、
//! 压缩比与符号链接拒绝。fixture 的 PNG 原始字节按文档 base64 解码（70 字节，
//! SHA-256 abc58d…de6f 与文档声明一致，测试内自证）。

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use hertz_wallpaper::{validate_package, PackageError};
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

const FIXTURE_PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
const FIXTURE_SHA256: &str = "abc58d5127d7cdf313beb9ec8ee839860a9c6bfbc48c8b8eb6a3f7d8bb63de6f";
const WORK_ID: &str = "c17ed10a-5c55-4a52-85dc-7509f9e88aae";

fn fixture_png() -> Vec<u8> {
    let bytes = STANDARD
        .decode(FIXTURE_PNG_B64)
        .expect("文档 fixture base64");
    assert_eq!(bytes.len(), 70);
    let digest = format!("{:x}", Sha256::digest(&bytes));
    assert_eq!(digest, FIXTURE_SHA256, "文档 fixture 哈希必须自洽");
    bytes
}

fn manifest_json(png_sha: &str, png_len: u64) -> String {
    format!(
        r#"{{
  "formatVersion": 1,
  "workId": "{WORK_ID}",
  "version": 1,
  "title": "静夜",
  "description": "静态图片壁纸",
  "content": {{"kind": "image", "asset": "background"}},
  "assets": [
    {{"id": "background", "kind": "image", "source": "assets/background.png", "variants": []}}
  ],
  "files": [
    {{"path": "assets/background.png", "bytes": {png_len}, "sha256": "{png_sha}", "mime": "image/png"}}
  ],
  "properties": [],
  "permissions": {{"audioSpectrum": false, "pointer": false}},
  "license": {{"code": "none", "assets": "CC0-1.0", "attribution": ""}}
}}"#
    )
}

fn build_package(entries: &[(&str, Vec<u8>)], deflate: bool) -> Vec<u8> {
    let mut buffer = std::io::Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut buffer);
        for (name, bytes) in entries {
            let options = if deflate {
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)
            } else {
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)
            };
            writer.start_file(*name, options).expect("zip 条目开始");
            std::io::Write::write_all(&mut writer, bytes).expect("zip 条目写入");
        }
        writer.finish().expect("zip 收尾");
    }
    buffer.into_inner()
}

fn valid_package() -> Vec<u8> {
    let png = fixture_png();
    let manifest = manifest_json(FIXTURE_SHA256, png.len() as u64);
    build_package(
        &[
            ("manifest.json", manifest.into_bytes()),
            ("assets/background.png", png),
        ],
        false,
    )
}

fn assert_code(error: PackageError, code: &str) {
    assert_eq!(error.code, code, "message={}", error.message);
}

#[test]
fn doc_fixture_round_trips_and_revalidates() {
    let bytes = valid_package();
    let first =
        validate_package(std::io::Cursor::new(bytes.clone())).expect("文档 fixture 必须可安装");
    assert_eq!(first.manifest.work_id, WORK_ID);
    assert_eq!(first.entries.len(), 1);
    assert_eq!(first.entries[0].sha256, FIXTURE_SHA256);
    assert_eq!(first.entries[0].bytes, 70);
    // C19 前置：重复校验幂等，字节不变。
    let second = validate_package(std::io::Cursor::new(bytes)).expect("重复校验必须幂等");
    assert_eq!(second.entries[0].sha256, FIXTURE_SHA256);
}

#[test]
fn doc_fixture_round_trips_with_deflate() {
    let png = fixture_png();
    let manifest = manifest_json(FIXTURE_SHA256, png.len() as u64);
    let bytes = build_package(
        &[
            ("manifest.json", manifest.into_bytes()),
            ("assets/background.png", png),
        ],
        true,
    );
    validate_package(std::io::Cursor::new(bytes)).expect("Deflate 条目合法");
}

#[test]
fn hash_and_length_mutations_are_rejected() {
    let png = fixture_png();
    // ① 哈希变异：合法格式但内容不符。
    let mut wrong = FIXTURE_SHA256.as_bytes().to_vec();
    wrong[0] = b'b';
    let manifest = manifest_json(std::str::from_utf8(&wrong).unwrap(), png.len() as u64);
    let error = validate_package(std::io::Cursor::new(build_package(
        &[
            ("manifest.json", manifest.into_bytes()),
            ("assets/background.png", png.clone()),
        ],
        false,
    )))
    .unwrap_err();
    assert_code(error, "hash_mismatch");
    // ② 长度变异（虚报大小）。
    let manifest = manifest_json(FIXTURE_SHA256, png.len() as u64 + 1);
    let error = validate_package(std::io::Cursor::new(build_package(
        &[
            ("manifest.json", manifest.into_bytes()),
            ("assets/background.png", png),
        ],
        false,
    )))
    .unwrap_err();
    assert_code(error, "size_mismatch");
}

#[test]
fn mime_mutation_flips_content_inconsistency() {
    // MIME 变异不改变字节事实：包层允许（mime 只决定导入器选 adapter），
    // 但值域非法的 mime 必须被拒。
    let png = fixture_png();
    let mut value: serde_json::Value =
        serde_json::from_str(&manifest_json(FIXTURE_SHA256, png.len() as u64)).unwrap();
    value["files"][0]["mime"] = "IMAGE/PNG".into();
    let manifest = serde_json::to_vec(&value).unwrap();
    let error = validate_package(std::io::Cursor::new(build_package(
        &[
            ("manifest.json", manifest),
            ("assets/background.png", png.clone()),
        ],
        false,
    )))
    .unwrap_err();
    assert_code(error, "invalid_mime");
    // 合法但类型不同的 mime（image/jpeg）通过包层校验。
    value["files"][0]["mime"] = "image/jpeg".into();
    let manifest = serde_json::to_vec(&value).unwrap();
    validate_package(std::io::Cursor::new(build_package(
        &[("manifest.json", manifest), ("assets/background.png", png)],
        false,
    )))
    .expect("合法 mime 变异不破坏包合同");
}

#[test]
fn c09_container_traps_are_rejected() {
    let png = fixture_png();
    let build = |entries: &[(&str, Vec<u8>)]| build_package(entries, false);
    // 路径穿越（manifest 规则层）。
    let evil = b"evil".to_vec();
    let bad_manifest = manifest_json(FIXTURE_SHA256, evil.len() as u64)
        .replace("assets/background.png", "assets/../evil.png");
    let error = validate_package(std::io::Cursor::new(build(&[
        ("manifest.json", bad_manifest.into_bytes()),
        ("assets/../evil.png", evil.clone()),
    ])))
    .unwrap_err();
    assert_code(error, "invalid_path");
    // 未声明文件。
    let manifest = manifest_json(FIXTURE_SHA256, png.len() as u64);
    let error = validate_package(std::io::Cursor::new(build(&[
        ("manifest.json", manifest.clone().into_bytes()),
        ("assets/background.png", png.clone()),
        ("assets/extra.bin", evil.clone()),
    ])))
    .unwrap_err();
    assert_code(error, "undeclared_file");
    // 声明文件缺失。
    let error = validate_package(std::io::Cursor::new(build(&[(
        "manifest.json",
        manifest.clone().into_bytes(),
    )])))
    .unwrap_err();
    assert_code(error, "missing_file");
    // 大小写折叠冲突：字符集全小写使冲突在结构上不可能，大写条目先撞
    // invalid_path；archive 的折叠查重保留为纵深防御（规则放宽时兜底）。
    let upper_manifest = manifest_json(FIXTURE_SHA256, png.len() as u64)
        .replace("assets/background.png", "Assets/Background.png");
    let error = validate_package(std::io::Cursor::new(build(&[
        ("manifest.json", upper_manifest.into_bytes()),
        ("Assets/Background.png", png.clone()),
        ("assets/background.png", png),
    ])))
    .unwrap_err();
    assert_code(error, "invalid_path");
}

#[test]
fn symlink_entries_are_rejected() {
    let png = fixture_png();
    let manifest = manifest_json(FIXTURE_SHA256, png.len() as u64);
    let mut buffer = std::io::Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut buffer);
        writer
            .start_file("manifest.json", SimpleFileOptions::default())
            .unwrap();
        std::io::Write::write_all(&mut writer, manifest.as_bytes()).unwrap();
        writer
            .add_symlink(
                "assets/link.png",
                "assets/background.png",
                SimpleFileOptions::default(),
            )
            .unwrap();
        writer.finish().unwrap();
    }
    // 符号链接在声明检查之前被拒；即便声明了也必须挡在解包之前。
    let error = validate_package(std::io::Cursor::new(buffer.into_inner())).unwrap_err();
    assert!(
        error.code == "symlink_entry"
            || error.code == "undeclared_file"
            || error.code == "invalid_path",
        "符号链接必须被拒绝：{error}"
    );
}

#[test]
fn compression_bombs_are_rejected() {
    // 全零负载经 Deflate 压缩比远超 100:1；声明真实哈希仍必须被压缩比规则拒绝。
    let bomb = vec![0u8; 8192];
    let bomb_sha = format!("{:x}", Sha256::digest(&bomb));
    let manifest = manifest_json(&bomb_sha, bomb.len() as u64);
    let error = validate_package(std::io::Cursor::new(build_package(
        &[
            ("manifest.json", manifest.into_bytes()),
            ("assets/background.png", bomb),
        ],
        true,
    )))
    .unwrap_err();
    assert_code(error, "ratio_exceeded");
}

#[test]
fn oversize_manifest_is_rejected_before_parse() {
    let big = vec![b' '; hertz_wallpaper::MAX_MANIFEST_BYTES + 1];
    assert_code(validate_package_from_manifest(&big), "manifest_too_large");
}

#[test]
fn compressed_manifest_bomb_is_bounded_before_json_parsing() {
    let zip = build_package(&[("manifest.json", vec![b' '; 4 * 1024 * 1024])], true);
    assert_code(
        validate_package(std::io::Cursor::new(zip)).unwrap_err(),
        "manifest_too_large",
    );
}

fn validate_package_from_manifest(bytes: &[u8]) -> PackageError {
    let mut buffer = std::io::Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut buffer);
        writer
            .start_file("manifest.json", SimpleFileOptions::default())
            .unwrap();
        std::io::Write::write_all(&mut writer, bytes).unwrap();
        writer.finish().unwrap();
    }
    validate_package(std::io::Cursor::new(buffer.into_inner())).unwrap_err()
}
