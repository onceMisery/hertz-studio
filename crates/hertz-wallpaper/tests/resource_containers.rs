// SPDX-License-Identifier: MIT
//! Actual resource container and ZIP entry checks. These fixtures establish
//! framing/bounds only; no GLTF/DFD decoder or renderer qualification is claimed.

use hertz_wallpaper::{
    model_container::inspect_glb, texture_container::inspect_ktx2, validate_archive,
    validate_package, Manifest,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read, Write};
use zip::{write::SimpleFileOptions, ZipWriter};

fn glb_json(json: &[u8], binary: Option<&[u8]>) -> Vec<u8> {
    let mut json = json.to_vec();
    while !json.len().is_multiple_of(4) {
        json.push(b' ');
    }
    let length = 20 + json.len() + binary.map_or(0, |bytes| 8 + bytes.len());
    let mut result = b"glTF".to_vec();
    result.extend(2_u32.to_le_bytes());
    result.extend((length as u32).to_le_bytes());
    result.extend((json.len() as u32).to_le_bytes());
    result.extend(b"JSON");
    result.extend(json);
    if let Some(binary) = binary {
        result.extend((binary.len() as u32).to_le_bytes());
        result.extend([b'B', b'I', b'N', 0]);
        result.extend(binary);
    }
    result
}
fn glb(binary: Option<&[u8]>) -> Vec<u8> {
    glb_json(
        br#"{"asset":{"version":"2.0"},"extras":{"containerFixture":true}}"#,
        binary,
    )
}
fn put32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}
fn put64(bytes: &mut [u8], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}
fn ktx2() -> Vec<u8> {
    let mut bytes = vec![0; 196];
    bytes[..12].copy_from_slice(&[
        0xab, b'K', b'T', b'X', b' ', b'2', b'0', 0xbb, 13, 10, 26, 10,
    ]);
    for (offset, value) in [
        (12, 37),
        (16, 1),
        (20, 4),
        (24, 4),
        (36, 1),
        (40, 1),
        (48, 104),
        (52, 28),
        (104, 28),
    ] {
        put32(&mut bytes, offset, value);
    }
    put64(&mut bytes, 80, 132);
    put64(&mut bytes, 88, 64);
    put64(&mut bytes, 96, 64);
    bytes
}
fn model_error(bytes: &[u8]) -> &'static str {
    inspect_glb(Cursor::new(bytes), bytes.len() as u64)
        .unwrap_err()
        .code
}
fn texture_error(bytes: &[u8]) -> &'static str {
    inspect_ktx2(Cursor::new(bytes), bytes.len() as u64)
        .unwrap_err()
        .code
}

#[test]
fn glb_preserves_original_json_and_binary_range_without_materializing_binary() {
    let bytes = glb(Some(&[1, 2, 3, 4]));
    let result = inspect_glb(Cursor::new(&bytes), bytes.len() as u64).unwrap();
    let parsed: Value = serde_json::from_slice(&result.json).unwrap();
    assert_eq!(parsed["asset"]["version"], "2.0");
    let binary = result.binary.unwrap();
    assert_eq!(binary.offset, 28 + result.json.len() as u64);
    assert_eq!(binary.bytes, 4);
    assert_eq!(&bytes[binary.offset as usize..], &[1, 2, 3, 4]);
    let bytes = glb(None);
    assert!(inspect_glb(Cursor::new(&bytes), bytes.len() as u64)
        .unwrap()
        .binary
        .is_none());
}

#[test]
fn glb_refuses_magic_version_total_length_alignment_and_chunk_order() {
    let base = glb(Some(&[0; 4]));
    for (offset, value) in [(0, b'x'), (8, 0), (16, b'B')] {
        let mut bytes = base.clone();
        bytes[offset] = value;
        assert_eq!(model_error(&bytes), "invalid_model_container");
    }
    let mut bytes = base.clone();
    put32(&mut bytes, 4, 1);
    assert_eq!(model_error(&bytes), "model_container_unavailable");
    let mut bytes = base.clone();
    put32(&mut bytes, 12, 3);
    assert_eq!(model_error(&bytes), "invalid_model_container");
    let mut bytes = base.clone();
    let bin_header = bytes.len() - 12;
    bytes[bin_header + 4..bin_header + 8].copy_from_slice(b"JSON");
    assert_eq!(model_error(&bytes), "model_container_unavailable");
    let mut bytes = base.clone();
    put32(&mut bytes, bin_header, 8);
    assert_eq!(model_error(&bytes), "invalid_model_container");
    assert_eq!(
        model_error(&base[..base.len() - 1]),
        "invalid_model_container"
    );
    assert_eq!(
        inspect_glb(Cursor::new(&base[..base.len() - 4]), base.len() as u64)
            .unwrap_err()
            .code,
        "invalid_model_container"
    );
    let mut extra = base.clone();
    extra.push(0);
    assert_eq!(
        inspect_glb(Cursor::new(extra), base.len() as u64)
            .unwrap_err()
            .code,
        "invalid_model_container"
    );
}

#[test]
fn glb_uses_original_duplicate_key_depth_and_asset_version_checks() {
    for value in [
        br#"{"asset":{"version":"2.0","version":"2.0"}}"#.as_slice(),
        br#"{"asset":{"version":"2.0"},"asset":{"version":"2.0"}}"#,
        br#"{"asset":{"version":"2.0"},"extras":1e999}"#,
        br#"{"asset":{"version":"2.0"},"extras":[{"nested":-1e999}]}"#,
        br#"{}"#,
    ] {
        assert_eq!(
            model_error(&glb_json(value, None)),
            "invalid_model_container"
        );
    }
    for value in [
        br#"{"asset":{"version":"2.1"}}"#.as_slice(),
        br#"{"asset":{"version":"2.0","minVersion":"2.1"}}"#,
    ] {
        assert_eq!(
            model_error(&glb_json(value, None)),
            "model_container_unavailable"
        );
    }
    let nested = format!(
        "{{\"asset\":{{\"version\":\"2.0\"}},\"extras\":{}0{}}}",
        "[".repeat(20),
        "]".repeat(20)
    );
    assert_eq!(
        model_error(&glb_json(nested.as_bytes(), None)),
        "invalid_model_container"
    );
}

struct GeneratedBody {
    prefix: Cursor<Vec<u8>>,
    body: u64,
    maximum_read: usize,
    reads: u64,
}
impl Read for GeneratedBody {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        self.maximum_read = self.maximum_read.max(output.len());
        let prefix = self.prefix.read(output)?;
        if prefix > 0 {
            self.reads += prefix as u64;
            return Ok(prefix);
        }
        let count = self.body.min(output.len() as u64) as usize;
        output[..count].fill(0);
        self.body -= count as u64;
        self.reads += count as u64;
        Ok(count)
    }
}

#[test]
fn glb_checks_json_limit_before_body_read_and_streams_large_binary_in_fixed_blocks() {
    let json_length = hertz_wallpaper::MAX_TEXT_BYTES + 4;
    let total = 20 + json_length;
    let mut prefix = b"glTF".to_vec();
    prefix.extend(2_u32.to_le_bytes());
    prefix.extend((total as u32).to_le_bytes());
    prefix.extend((json_length as u32).to_le_bytes());
    prefix.extend(b"JSON");
    let mut source = GeneratedBody {
        prefix: Cursor::new(prefix),
        body: json_length,
        maximum_read: 0,
        reads: 0,
    };
    assert_eq!(
        inspect_glb(&mut source, total).unwrap_err().code,
        "invalid_model_container"
    );
    assert_eq!(source.reads, 20);
    let body = 8 * 1024 * 1024;
    let mut prefix = glb(None);
    let total = prefix.len() as u64 + 8 + body;
    put32(&mut prefix, 8, total as u32);
    prefix.extend((body as u32).to_le_bytes());
    prefix.extend([b'B', b'I', b'N', 0]);
    let mut source = GeneratedBody {
        prefix: Cursor::new(prefix),
        body,
        maximum_read: 0,
        reads: 0,
    };
    let result = inspect_glb(&mut source, total).unwrap();
    assert_eq!(result.binary.unwrap().bytes, body);
    assert_eq!(source.reads, total);
    assert!(source.maximum_read <= 64 * 1024);
}

#[test]
fn ktx2_returns_declared_facts_and_accepts_zero_level_count_generation_flag() {
    let bytes = ktx2();
    let facts = inspect_ktx2(Cursor::new(&bytes), bytes.len() as u64).unwrap();
    assert_eq!(
        (
            facts.width,
            facts.height,
            facts.vk_format,
            facts.type_size,
            facts.supercompression
        ),
        (4, 4, 37, 1, 0)
    );
    assert_eq!(facts.levels.len(), 1);
    assert_eq!((facts.levels[0].offset, facts.levels[0].bytes), (132, 64));
    assert!(!facts.generate_mipmaps);
    let mut bytes = bytes;
    put32(&mut bytes, 40, 0);
    assert!(
        inspect_ktx2(Cursor::new(&bytes), bytes.len() as u64)
            .unwrap()
            .generate_mipmaps
    );
}

#[test]
fn ktx2_refuses_truncation_dimensions_mips_array_cube_depth_and_unknown_compression() {
    let base = ktx2();
    let mut bytes = base.clone();
    bytes[0] = 0;
    assert_eq!(texture_error(&bytes), "invalid_texture_container");
    for (offset, value) in [(20, 0), (24, 0), (20, 16_385), (40, 4), (16, 0)] {
        let mut bytes = base.clone();
        put32(&mut bytes, offset, value);
        assert_eq!(texture_error(&bytes), "invalid_texture_container");
    }
    let mut bytes = base.clone();
    put32(&mut bytes, 20, 16_384);
    put32(&mut bytes, 24, 4096);
    assert_eq!(texture_error(&bytes), "invalid_texture_container");
    for (offset, value) in [(28, 1), (32, 1), (36, 6), (44, 4)] {
        let mut bytes = base.clone();
        put32(&mut bytes, offset, value);
        assert_eq!(texture_error(&bytes), "texture_container_unavailable");
    }
    assert_eq!(
        inspect_ktx2(Cursor::new(&base[..150]), base.len() as u64)
            .unwrap_err()
            .code,
        "invalid_texture_container"
    );
    let mut extra = base.clone();
    extra.push(0);
    assert_eq!(
        inspect_ktx2(Cursor::new(extra), base.len() as u64)
            .unwrap_err()
            .code,
        "invalid_texture_container"
    );
}

#[test]
fn ktx2_refuses_overflows_overlaps_header_ranges_and_inconsistent_uncompressed_lengths() {
    let base = ktx2();
    for (offset, value) in [
        (80, 80),
        (80, 120),
        (80, u64::MAX - 3),
        (88, 0),
        (96, 63),
        (64, u64::MAX - 7),
    ] {
        let mut bytes = base.clone();
        put64(&mut bytes, offset, value);
        if offset == 64 {
            put64(&mut bytes, 72, 16);
        }
        assert_eq!(texture_error(&bytes), "invalid_texture_container");
    }
    for (offset, value) in [(48, 0), (52, 0), (52, 24), (56, 120), (60, 16)] {
        let mut bytes = base.clone();
        put32(&mut bytes, offset, value);
        assert_eq!(texture_error(&bytes), "invalid_texture_container");
    }
    let mut bytes = base;
    put32(&mut bytes, 44, 2);
    put64(&mut bytes, 96, 0);
    assert_eq!(texture_error(&bytes), "invalid_texture_container");
}

#[test]
fn ktx2_supercompressed_mips_need_no_padding_and_basis_lengths_are_zero() {
    // KTX specification: supercompressed levels have no mipPadding; BasisLZ
    // carries zero uncompressedByteLength, unlike Zstd/Zlib.
    for scheme in [1, 2, 3] {
        let mut bytes = vec![0; 176];
        bytes[..80].copy_from_slice(&ktx2()[..80]);
        put32(&mut bytes, 40, 2);
        put32(&mut bytes, 44, scheme);
        put32(&mut bytes, 48, 128);
        put32(&mut bytes, 128, 28);
        for (offset, value) in [(80, 165), (88, 11), (104, 156), (112, 9)] {
            put64(&mut bytes, offset, value);
        }
        let lengths = if scheme == 1 { [0, 0] } else { [64, 16] };
        put64(&mut bytes, 96, lengths[0]);
        put64(&mut bytes, 120, lengths[1]);
        let facts = inspect_ktx2(Cursor::new(&bytes), bytes.len() as u64).unwrap();
        assert_eq!(facts.levels[0].offset, 165);
        if scheme == 1 {
            put64(&mut bytes, 96, 64);
            assert_eq!(texture_error(&bytes), "invalid_texture_container");
        }
    }
}

#[test]
fn ktx2_accepts_reference_writer_real_zlib_mips_in_verified_package() {
    let bytes = include_bytes!("fixtures/resource-containers/rgba8-zlib.ktx2");
    assert_eq!(
        format!("{:x}", Sha256::digest(bytes)),
        "beca00bc32c72bb559df378b4888d45f1f3e3edcd1788ccee243133b5d346716"
    );
    let facts = inspect_ktx2(Cursor::new(bytes), bytes.len() as u64).unwrap();
    assert_eq!(
        (facts.width, facts.height, facts.supercompression),
        (4, 4, 3)
    );
    assert_eq!(
        facts
            .levels
            .iter()
            .map(|level| (level.offset, level.bytes, level.uncompressed_bytes))
            .collect::<Vec<_>>(),
        [(263, 12, 64), (252, 11, 16)]
    );
    validate_package(Cursor::new(package(glb(None), bytes.to_vec()))).unwrap();
}

fn package(model: Vec<u8>, texture: Vec<u8>) -> Vec<u8> {
    package_with_assets(
        vec![
            ("assets/model.glb", model, "model/gltf-binary"),
            ("assets/texture.ktx2", texture, "image/ktx2"),
        ],
        json!([{"id":"model","kind":"model","source":"assets/model.glb","variants":[]},{"id":"texture","kind":"texture","source":"assets/texture.ktx2","variants":[]}]),
    )
}

fn package_with_assets(files: Vec<(&str, Vec<u8>, &str)>, assets: Value) -> Vec<u8> {
    let manifest = json!({"formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae","version":1,"title":"Containers","description":"",
        "content":{"kind":"builtin","sceneId":"zodiac","stateVersion":1,"params":{}},
        "assets":assets,
        "files":files.iter().map(|(path,bytes,mime)|json!({"path":path,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes)),"mime":mime})).collect::<Vec<_>>(),
        "properties":[],"permissions":{"audioSpectrum":false,"pointer":false},"license":{"code":"none","assets":"CC0-1.0","attribution":""}});
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file("manifest.json", SimpleFileOptions::default())
        .unwrap();
    writer
        .write_all(&serde_json::to_vec(&manifest).unwrap())
        .unwrap();
    for (path, bytes, _) in files {
        writer
            .start_file(path, SimpleFileOptions::default())
            .unwrap();
        writer.write_all(&bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

#[test]
fn real_package_validation_checks_declared_model_and_texture_bytes_after_hashing() {
    let bytes = package(glb(Some(&[0; 4])), ktx2());
    let validated = validate_package(Cursor::new(bytes)).unwrap();
    assert_eq!(validated.entries.len(), 2);
    let mut model = glb(None);
    model[0] = 0;
    let error = validate_package(Cursor::new(package(model, ktx2()))).unwrap_err();
    assert_eq!(error.code, "invalid_model_container");
    assert!(error.message.contains("assets/model.glb"));
    let mut texture = ktx2();
    put64(&mut texture, 80, 120);
    let error = validate_package(Cursor::new(package(glb(None), texture))).unwrap_err();
    assert_eq!(error.code, "invalid_texture_container");
    assert!(error.message.contains("assets/texture.ktx2"));
}

#[test]
fn real_package_hash_mismatch_precedes_resource_container_errors() {
    for damaged in ["assets/model.glb", "assets/texture.ktx2"] {
        let mut source = zip::ZipArchive::new(Cursor::new(package(glb(None), ktx2()))).unwrap();
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for index in 0..source.len() {
            let mut entry = source.by_index(index).unwrap();
            let path = entry.name().to_owned();
            let mut body = Vec::new();
            entry.read_to_end(&mut body).unwrap();
            if path == damaged {
                body[0] = 0;
            }
            writer
                .start_file(path, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(&body).unwrap();
        }
        let error =
            validate_package(Cursor::new(writer.finish().unwrap().into_inner())).unwrap_err();
        assert_eq!(error.code, "hash_mismatch");
        assert!(error.message.contains(damaged));
    }
}

#[test]
fn ktx2_streams_body_in_fixed_blocks_and_rejects_length_before_reading() {
    let total = 8 * 1024 * 1024;
    let prefix = ktx2();
    let mut source = GeneratedBody {
        body: total - prefix.len() as u64,
        prefix: Cursor::new(prefix),
        maximum_read: 0,
        reads: 0,
    };
    inspect_ktx2(&mut source, total).unwrap();
    assert_eq!(source.reads, total);
    assert!(source.maximum_read <= 64 * 1024);
    source.reads = 0;
    assert_eq!(
        inspect_ktx2(&mut source, hertz_wallpaper::MAX_TEXTURE_BYTES + 1)
            .unwrap_err()
            .code,
        "invalid_texture_container"
    );
    assert_eq!(source.reads, 0);
}

#[test]
fn real_package_checks_every_model_and_ktx2_variant() {
    for kind in ["model", "texture"] {
        let (source, mime) = if kind == "model" {
            (glb(None), "model/gltf-binary")
        } else {
            (ktx2(), "image/ktx2")
        };
        let mut invalid = source.clone();
        invalid[0] = 0;
        let assets = json!([{"id":"resource","kind":kind,"source":"assets/source","variants":[{"id":"low","file":"assets/variant","purpose":"low"}]}]);
        let bytes = package_with_assets(
            vec![
                ("assets/source", source.clone(), mime),
                ("assets/variant", source, mime),
            ],
            assets.clone(),
        );
        validate_package(Cursor::new(bytes)).unwrap();
        let bytes = package_with_assets(
            vec![
                (
                    "assets/source",
                    if kind == "model" { glb(None) } else { ktx2() },
                    mime,
                ),
                ("assets/variant", invalid, mime),
            ],
            assets,
        );
        let error = validate_package(Cursor::new(bytes)).unwrap_err();
        assert_eq!(
            error.code,
            if kind == "model" {
                "invalid_model_container"
            } else {
                "invalid_texture_container"
            }
        );
        assert!(error.message.contains("assets/variant"));
    }
}

#[test]
fn real_package_aliases_cannot_skip_model_mime_requirements() {
    for variant in [false, true] {
        for model_first in [false, true] {
            let texture =
                json!({"id":"texture","kind":"texture","source":"assets/shared","variants":[]});
            let model = if variant {
                json!({"id":"model","kind":"model","source":"assets/model","variants":[{"id":"low","file":"assets/shared","purpose":"low"}]})
            } else {
                json!({"id":"model","kind":"model","source":"assets/shared","variants":[]})
            };
            let assets = if model_first {
                json!([model, texture])
            } else {
                json!([texture, model])
            };
            let mut files = vec![("assets/shared", ktx2(), "image/ktx2")];
            if variant {
                files.push(("assets/model", glb(None), "model/gltf-binary"));
            }
            let bytes = package_with_assets(files, assets);
            let error = validate_package(Cursor::new(bytes)).unwrap_err();
            assert_eq!(error.code, "model_container_unavailable");
            assert!(error.message.contains("assets/shared"));
        }
    }
    let bytes = package_with_assets(
        vec![("assets/shared", glb(None), "model/gltf-binary")],
        json!([
            {"id":"model-a","kind":"model","source":"assets/shared","variants":[{"id":"low","file":"assets/shared","purpose":"low"}]},
            {"id":"model-b","kind":"model","source":"assets/shared","variants":[]}
        ]),
    );
    validate_package(Cursor::new(bytes)).unwrap();
}

#[test]
fn public_archive_returns_missing_file_for_hand_constructed_model_and_texture_references() {
    let bytes = package(glb(None), ktx2());
    let valid = validate_package(Cursor::new(&bytes)).unwrap().manifest;
    for kind in ["model", "texture"] {
        for variant in [false, true] {
            let mut manifest = valid.clone();
            let asset = manifest
                .assets
                .iter_mut()
                .find(|asset| {
                    if kind == "model" {
                        asset.id == "model"
                    } else {
                        asset.id == "texture"
                    }
                })
                .unwrap();
            if variant {
                asset.variants = serde_json::from_value(
                    json!([{"id":"low","file":"assets/absent","purpose":"low"}]),
                )
                .unwrap();
            } else {
                asset.source = "assets/absent".into();
            }
            let error = validate_archive(Cursor::new(&bytes), &manifest).unwrap_err();
            assert_eq!(error.code, "missing_file");
            assert!(error.message.contains("assets/absent"));
        }
    }
    // This new check only owns model/texture; the public archive entry point's
    // pre-existing behavior for other unvalidated manifest roles is preserved.
    let mut manifest: Manifest = valid;
    manifest.assets = serde_json::from_value(
        json!([{"id":"image","kind":"image","source":"assets/absent","variants":[]}]),
    )
    .unwrap();
    validate_archive(Cursor::new(&bytes), &manifest).unwrap();
}
