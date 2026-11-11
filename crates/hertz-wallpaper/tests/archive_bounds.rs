// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Actual ZIP body ranges and the exact HWPK inflation boundary at both entries.

use std::cell::Cell;
use std::io::{Cursor, Read, Seek, SeekFrom, Write};
use std::rc::Rc;

use hertz_wallpaper::{validate_archive, validate_manifest_bytes, validate_package, Manifest};
use sha2::{Digest, Sha256};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

const ASSET: &str = "assets/background.png";

fn manifest(payload: Option<&[u8]>) -> Vec<u8> {
    let mut value = serde_json::json!({
        "formatVersion": 1,
        "workId": "c17ed10a-5c55-4a52-85dc-7509f9e88aae",
        "version": 1, "title": "ZIP bounds",
        "content": {"kind":"builtin","sceneId":"zodiac","stateVersion":1,"params":{}},
        "assets": [], "files": [], "properties": [],
        "permissions": {"audioSpectrum":false,"pointer":false},
        "license": {"code":"none","assets":"CC0-1.0"}
    });
    if let Some(payload) = payload {
        value["assets"] = serde_json::json!([
            {"id":"background","kind":"image","source":ASSET,"variants":[]}
        ]);
        value["files"] = serde_json::json!([
            {"path":ASSET,"bytes":payload.len(),"sha256":format!("{:x}",Sha256::digest(payload)),"mime":"image/png"}
        ]);
    }
    serde_json::to_vec(&value).unwrap()
}

fn package(json: &[u8], payload: Option<&[u8]>, method: CompressionMethod) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file(
            "manifest.json",
            SimpleFileOptions::default().compression_method(method),
        )
        .unwrap();
    writer.write_all(json).unwrap();
    if let Some(payload) = payload {
        writer
            .start_file(
                ASSET,
                SimpleFileOptions::default().compression_method(method),
            )
            .unwrap();
        writer.write_all(payload).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

fn u16_at(bytes: &[u8], offset: usize) -> usize {
    u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap()) as usize
}

fn u32_at(bytes: &[u8], offset: usize) -> usize {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize
}

fn central_record(bytes: &[u8], name: &str) -> usize {
    let end = bytes.len() - 22;
    assert_eq!(&bytes[end..end + 4], b"PK\x05\x06");
    let mut offset = u32_at(bytes, end + 16);
    for _ in 0..u16_at(bytes, end + 10) {
        assert_eq!(&bytes[offset..offset + 4], b"PK\x01\x02");
        let name_len = u16_at(bytes, offset + 28);
        if &bytes[offset + 46..offset + 46 + name_len] == name.as_bytes() {
            return offset;
        }
        offset += 46 + name_len + u16_at(bytes, offset + 30) + u16_at(bytes, offset + 32);
    }
    panic!("missing fixture record {name}");
}

fn change_size(bytes: &mut [u8], name: &str, field: usize, size: u32) {
    let offset = central_record(bytes, name) + field;
    bytes[offset..offset + 4].copy_from_slice(&size.to_le_bytes());
}

fn body_range(bytes: &[u8], name: &str) -> (u64, u64) {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
    let file = archive.by_name(name).unwrap();
    (
        file.data_start(),
        file.data_start() + file.compressed_size(),
    )
}

struct Tracked {
    bytes: Cursor<Vec<u8>>,
    body: (u64, u64),
    reads: Rc<Cell<u64>>,
    reading_body: bool,
}

impl Read for Tracked {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        let start = self.bytes.position();
        let count = self.bytes.read(out)?;
        let overlap = (start + count as u64)
            .min(self.body.1)
            .saturating_sub(start.max(self.body.0));
        if self.reading_body {
            self.reads.set(self.reads.get() + overlap);
        }
        Ok(count)
    }
}

impl Seek for Tracked {
    fn seek(&mut self, from: SeekFrom) -> std::io::Result<u64> {
        // ZIP bootstrap scans raw bytes for directory signatures and may read
        // bytes that overlap the payload. Entry inflation starts only after
        // find_content explicitly seeks to this entry's data_start.
        self.reading_body = matches!(from, SeekFrom::Start(start) if start == self.body.0);
        self.bytes.seek(from)
    }
}

fn reject_both(bytes: &[u8], parsed: &Manifest, code: &str, unread: Option<(u64, u64)>) {
    for external_manifest in [false, true] {
        let reads = Rc::new(Cell::new(0));
        let reader = Tracked {
            bytes: Cursor::new(bytes.to_vec()),
            body: unread.unwrap_or((0, 0)),
            reads: reads.clone(),
            reading_body: false,
        };
        let error = if external_manifest {
            validate_archive(reader, parsed).unwrap_err()
        } else {
            validate_package(reader).unwrap_err()
        };
        assert_eq!(
            error.code, code,
            "external_manifest={external_manifest}: {error}"
        );
        if unread.is_some() {
            assert_eq!(reads.get(), 0, "rejected body was read: {error}");
        }
    }
}

// The last entry can include padding after Deflate stream end. This makes the
// physical compressed range C exact without changing the decoded payload E.
fn pad_last_compressed_range(bytes: &mut Vec<u8>, name: &str, compressed: u32) {
    let mut archive = ZipArchive::new(Cursor::new(&*bytes)).unwrap();
    let directory = archive.central_directory_start() as usize;
    let file = archive.by_name(name).unwrap();
    assert_eq!(file.data_start() + file.compressed_size(), directory as u64);
    let padding = compressed as usize - file.compressed_size() as usize;
    drop(file);
    drop(archive);
    bytes.splice(directory..directory, std::iter::repeat_n(0, padding));
    let end = bytes.len() - 22;
    bytes[end + 16..end + 20].copy_from_slice(&((directory + padding) as u32).to_le_bytes());
    change_size(bytes, name, 20, compressed);
    let record = central_record(bytes, name);
    let local = u32_at(bytes, record + 42);
    bytes[local + 18..local + 22].copy_from_slice(&compressed.to_le_bytes());
}

#[test]
fn valid_stored_and_deflated_ranges_revalidate_at_both_entries() {
    let payload = b"small fixture bytes";
    let json = manifest(Some(payload));
    for method in [CompressionMethod::Stored, CompressionMethod::Deflated] {
        let bytes = package(&json, Some(payload), method);
        let checked = validate_package(Cursor::new(&bytes)).unwrap();
        let entries = validate_archive(Cursor::new(&bytes), &checked.manifest).unwrap();
        assert_eq!(entries[0].bytes, payload.len() as u64);
        assert_eq!(entries[0].sha256, format!("{:x}", Sha256::digest(payload)));
        let reads = Rc::new(Cell::new(0));
        let reader = Tracked {
            bytes: Cursor::new(bytes.clone()),
            body: body_range(&bytes, ASSET),
            reads: reads.clone(),
            reading_body: false,
        };
        validate_package(reader).unwrap();
        assert!(
            reads.get() > 0,
            "entry-read tracker must observe actual inflation"
        );
    }
}

#[test]
fn resource_compressed_range_cannot_cross_directory_even_inside_package() {
    let payload = b"small fixture bytes";
    let json = manifest(Some(payload));
    let parsed = validate_manifest_bytes(&json).unwrap();
    for method in [CompressionMethod::Stored, CompressionMethod::Deflated] {
        for excess in [1, 512] {
            let mut bytes = package(&json, Some(payload), method);
            let body = body_range(&bytes, ASSET);
            change_size(&mut bytes, ASSET, 20, (body.1 - body.0) as u32 + excess);
            reject_both(&bytes, &parsed, "invalid_compressed_range", Some(body));
        }
    }
}

#[test]
fn manifest_compressed_range_is_checked_before_body_reads_at_both_entries() {
    let json = manifest(None);
    let parsed = validate_manifest_bytes(&json).unwrap();
    for method in [CompressionMethod::Stored, CompressionMethod::Deflated] {
        let mut bytes = package(&json, None, method);
        let body = body_range(&bytes, "manifest.json");
        change_size(
            &mut bytes,
            "manifest.json",
            20,
            (body.1 - body.0 + 1) as u32,
        );
        reject_both(&bytes, &parsed, "invalid_compressed_range", Some(body));
    }
}

#[test]
fn deflated_resource_ratio_uses_canonical_bytes_despite_false_central_size() {
    let payload = vec![0; 8192];
    let json = manifest(Some(&payload));
    let parsed = validate_manifest_bytes(&json).unwrap();
    let mut bytes = package(&json, Some(&payload), CompressionMethod::Deflated);
    let body = body_range(&bytes, ASSET);
    change_size(&mut bytes, ASSET, 24, 1);
    reject_both(&bytes, &parsed, "ratio_exceeded", Some(body));
}

#[test]
fn zero_compressed_nonempty_resource_is_rejected_before_reading() {
    let payload = b"small fixture bytes";
    let json = manifest(Some(payload));
    let parsed = validate_manifest_bytes(&json).unwrap();
    let mut bytes = package(&json, Some(payload), CompressionMethod::Deflated);
    let body = body_range(&bytes, ASSET);
    change_size(&mut bytes, ASSET, 20, 0);
    reject_both(&bytes, &parsed, "ratio_exceeded", Some(body));
}

#[test]
fn resource_ratio_accepts_exactly_100_and_rejects_fractional_excess() {
    for length in [20_000, 20_001] {
        let payload = vec![0; length];
        let json = manifest(Some(&payload));
        let parsed = validate_manifest_bytes(&json).unwrap();
        let mut bytes = package(&json, Some(&payload), CompressionMethod::Deflated);
        pad_last_compressed_range(&mut bytes, ASSET, 200);
        if length == 20_000 {
            validate_package(Cursor::new(&bytes)).unwrap();
            validate_archive(Cursor::new(&bytes), &parsed).unwrap();
        } else {
            let body = body_range(&bytes, ASSET);
            reject_both(&bytes, &parsed, "ratio_exceeded", Some(body));
        }
    }
}

#[test]
fn manifest_ratio_uses_actual_bytes_and_exact_boundary_before_json_parse() {
    for length in [50_000, 50_001] {
        let mut json = manifest(None);
        json.resize(length, b' ');
        let parsed = validate_manifest_bytes(&json).unwrap();
        let mut bytes = package(&json, None, CompressionMethod::Deflated);
        pad_last_compressed_range(&mut bytes, "manifest.json", 500);
        change_size(&mut bytes, "manifest.json", 24, 1);
        if length == 50_000 {
            validate_package(Cursor::new(&bytes)).unwrap();
            validate_archive(Cursor::new(&bytes), &parsed).unwrap();
        } else {
            reject_both(&bytes, &parsed, "ratio_exceeded", None);
        }
    }
}

#[test]
fn manifest_inflation_limit_is_preserved_when_central_size_is_false() {
    let parsed = validate_manifest_bytes(&manifest(None)).unwrap();
    let mut bytes = package(
        &vec![b' '; hertz_wallpaper::MAX_MANIFEST_BYTES + 1],
        None,
        CompressionMethod::Deflated,
    );
    change_size(&mut bytes, "manifest.json", 24, 1);
    reject_both(&bytes, &parsed, "manifest_too_large", None);
}

#[test]
fn highly_compressed_manifest_is_rejected_at_both_entries() {
    let mut json = manifest(None);
    json.resize(32 * 1024, b' ');
    let parsed = validate_manifest_bytes(&json).unwrap();
    let bytes = package(&json, None, CompressionMethod::Deflated);
    reject_both(&bytes, &parsed, "ratio_exceeded", None);
}

#[test]
fn r8_actual_glb_cannot_hide_compressed_range_outside_the_package() {
    let mut json = br#"{"asset":{"version":"2.0"},"extras":{"note":""#.to_vec();
    json.resize(256 * 1024 - 3, b'x');
    json.extend_from_slice(br#""}}"#);
    let mut glb = b"glTF".to_vec();
    glb.extend_from_slice(&2u32.to_le_bytes());
    glb.extend_from_slice(&((20 + json.len()) as u32).to_le_bytes());
    glb.extend_from_slice(&(json.len() as u32).to_le_bytes());
    glb.extend_from_slice(b"JSON");
    glb.extend_from_slice(&json);
    let mut value: serde_json::Value = serde_json::from_slice(&manifest(Some(&glb))).unwrap();
    value["assets"][0]["kind"] = serde_json::json!("model");
    value["files"][0]["mime"] = serde_json::json!("model/gltf-binary");
    let manifest_bytes = serde_json::to_vec(&value).unwrap();
    let parsed = validate_manifest_bytes(&manifest_bytes).unwrap();
    let mut bytes = package(&manifest_bytes, Some(&glb), CompressionMethod::Deflated);
    let body = body_range(&bytes, ASSET);
    assert!(json.len() > bytes.len() * 100);
    reject_both(&bytes, &parsed, "ratio_exceeded", Some(body));
    change_size(&mut bytes, ASSET, 20, glb.len() as u32);
    reject_both(&bytes, &parsed, "invalid_compressed_range", Some(body));
}

#[test]
fn zip64_compressed_range_addition_overflow_is_rejected_before_inflation() {
    let payload = b"small fixture bytes";
    let json = manifest(Some(payload));
    let parsed = validate_manifest_bytes(&json).unwrap();
    let mut bytes = package(&json, Some(payload), CompressionMethod::Deflated);
    let body = body_range(&bytes, ASSET);
    let record = central_record(&bytes, ASSET);
    assert_eq!(u16_at(&bytes, record + 30), 0);
    let extra_start = record + 46 + u16_at(&bytes, record + 28);
    let mut zip64 = vec![1, 0, 8, 0];
    zip64.extend_from_slice(&u64::MAX.to_le_bytes());
    bytes.splice(extra_start..extra_start, zip64);
    bytes[record + 30..record + 32].copy_from_slice(&12u16.to_le_bytes());
    change_size(&mut bytes, ASSET, 20, u32::MAX);
    let end = bytes.len() - 22;
    let directory_bytes = u32_at(&bytes, end + 12) as u32 + 12;
    bytes[end + 12..end + 16].copy_from_slice(&directory_bytes.to_le_bytes());
    reject_both(&bytes, &parsed, "invalid_compressed_range", Some(body));
}

#[test]
fn prepended_zip_preserves_absolute_range_offsets() {
    let payload = b"small fixture bytes";
    let json = manifest(Some(payload));
    let parsed = validate_manifest_bytes(&json).unwrap();
    let mut bytes = b"MZ-test-prefix".to_vec();
    bytes.extend_from_slice(&package(&json, Some(payload), CompressionMethod::Deflated));
    validate_package(Cursor::new(&bytes)).unwrap();
    validate_archive(Cursor::new(&bytes), &parsed).unwrap();
}
