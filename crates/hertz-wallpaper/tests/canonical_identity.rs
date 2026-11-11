// SPDX-License-Identifier: MIT
//! Canonical source/variant mapping through the actual original ZIP owner.

use std::io::{Cursor, Write};

use hertz_wallpaper::{
    archive::{inspect_package_identity, inspect_package_identity_with_limits},
    validate_package, AssetKind, MAX_FILES,
};
use sha2::{Digest, Sha256};
use zip::{read::MetadataLimits, write::SimpleFileOptions, ZipArchive, ZipWriter};

const SOURCE: &str = "models/source.glb";
const VARIANT: &str = "models/variant.glb";

fn fixture(edit: impl FnOnce(&mut serde_json::Value), extra: bool) -> Vec<u8> {
    let payloads = [(SOURCE, b"glTF"), (VARIANT, b"else")];
    let mut manifest = serde_json::json!({
        "formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae",
        "version":1,"title":"Canonical model binding",
        "content":{"kind":"builtin","sceneId":"zodiac","stateVersion":1,"params":{}},
        "assets":[
            {"id":"model-main","kind":"model","source":SOURCE,"variants":[
                {"id":"low","file":VARIANT,"purpose":"low"},
                {"id":"alias","file":SOURCE,"purpose":"preview"}
            ]},
            {"id":"image-alias","kind":"image","source":SOURCE,"variants":[]}
        ],
        "files":payloads.iter().map(|(path, payload)| serde_json::json!({
            "path":path,"bytes":payload.len(),"mime":"model/gltf-binary",
            "sha256":format!("{:x}",Sha256::digest(payload))
        })).collect::<Vec<_>>(),
        "properties":[],"permissions":{},"license":{"code":"none","assets":"CC0-1.0"}
    });
    edit(&mut manifest);
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    writer.start_file("manifest.json", options).unwrap();
    writer
        .write_all(&serde_json::to_vec(&manifest).unwrap())
        .unwrap();
    for (path, payload) in payloads {
        writer.start_file(path, options).unwrap();
        writer.write_all(payload).unwrap();
    }
    if extra {
        writer.start_file("undeclared.bin", options).unwrap();
        writer.write_all(b"extra").unwrap();
    }
    writer.finish().unwrap().into_inner()
}

fn limits() -> MetadataLimits {
    MetadataLimits {
        max_raw_entries: MAX_FILES + 8,
        max_variable_bytes: usize::MAX,
        max_zip64_extensible_bytes: usize::MAX,
        max_eocd_comment_bytes: usize::MAX,
    }
}

#[test]
fn source_and_exact_variant_resolve_actual_canonical_entries() {
    let bytes = fixture(|_| {}, false);
    let identity = inspect_package_identity(Cursor::new(bytes)).unwrap();
    assert_eq!(identity.entries().len(), 2);
    let source = identity.model_binding("model-main", None).unwrap();
    assert_eq!(source.asset_id(), "model-main");
    assert_eq!(source.variant_id(), None);
    assert_eq!(source.entry().path, SOURCE);
    assert_eq!(source.entry().bytes, 4);
    assert_eq!(source.entry().mime, "model/gltf-binary");
    assert_eq!(
        source.entry().sha256,
        format!("{:x}", Sha256::digest(b"glTF"))
    );
    let variant = identity.model_binding("model-main", Some("low")).unwrap();
    assert_eq!(variant.variant_id(), Some("low"));
    assert_eq!(variant.entry().path, VARIANT);
    assert_eq!(
        variant.entry().sha256,
        format!("{:x}", Sha256::digest(b"else"))
    );
}

#[test]
fn same_file_alias_does_not_erase_the_authored_variant_selection() {
    let identity = inspect_package_identity(Cursor::new(fixture(|_| {}, false))).unwrap();
    let source = identity.model_binding("model-main", None).unwrap();
    let alias = identity.model_binding("model-main", Some("alias")).unwrap();
    assert_eq!(source.entry().path, alias.entry().path);
    assert_eq!(source.entry().sha256, alias.entry().sha256);
    assert_eq!(source.variant_id(), None);
    assert_eq!(alias.variant_id(), Some("alias"));
}

#[test]
fn caller_mapping_cannot_change_the_original_asset_kind_or_variant() {
    let identity = inspect_package_identity(Cursor::new(fixture(|_| {}, false))).unwrap();
    let mut caller_manifest = identity.manifest().clone();
    caller_manifest.assets[0].source = VARIANT.into();
    caller_manifest.assets[1].kind = AssetKind::Model;
    assert_eq!(
        identity
            .model_binding("model-main", None)
            .unwrap()
            .entry()
            .path,
        SOURCE
    );
    for (id, variant) in [
        ("unknown", None),
        ("image-alias", None),
        ("model-main", Some("source")),
    ] {
        assert_eq!(
            identity.model_binding(id, variant).unwrap_err().code,
            "invalid_model_reference"
        );
    }
}

#[test]
fn identity_does_not_bypass_the_complete_resource_validator() {
    let bytes = fixture(|_| {}, false);
    inspect_package_identity(Cursor::new(bytes.clone())).unwrap();
    assert_eq!(
        validate_package(Cursor::new(bytes)).unwrap_err().code,
        "invalid_model_container"
    );
}

#[test]
fn all_original_entries_are_hashed_before_a_binding_can_exist() {
    let bytes = fixture(
        |manifest| manifest["files"][1]["sha256"] = "f".repeat(64).into(),
        false,
    );
    assert_eq!(
        inspect_package_identity(Cursor::new(bytes))
            .unwrap_err()
            .code,
        "hash_mismatch"
    );
}

#[test]
fn undeclared_files_cannot_be_hidden_behind_a_selected_model() {
    let bytes = fixture(|_| {}, true);
    assert_eq!(
        inspect_package_identity(Cursor::new(bytes))
            .unwrap_err()
            .code,
        "undeclared_file"
    );
}

#[test]
fn native_metadata_limits_are_enforced_at_the_original_constructor() {
    let bytes = fixture(|_| {}, false);
    let mut bounded = limits();
    bounded.max_variable_bytes = 0;
    assert_eq!(
        inspect_package_identity_with_limits(Cursor::new(&bytes), bounded)
            .unwrap_err()
            .code,
        "zip_metadata_limit"
    );
    bounded = limits();
    bounded.max_raw_entries = 1;
    assert_eq!(
        inspect_package_identity_with_limits(Cursor::new(&bytes), bounded)
            .unwrap_err()
            .code,
        "zip_metadata_limit"
    );
}

#[test]
fn exact_metadata_limit_is_accepted_without_raising_a_smaller_limit() {
    let bytes = fixture(|_| {}, false);
    let original_archive = ZipArchive::new(Cursor::new(&bytes)).unwrap();
    let original = original_archive.metadata_usage();
    let mut bounded = limits();
    bounded.max_variable_bytes = original.variable_bytes();
    inspect_package_identity_with_limits(Cursor::new(&bytes), bounded).unwrap();
    bounded.max_variable_bytes -= 1;
    assert_eq!(
        inspect_package_identity_with_limits(Cursor::new(&bytes), bounded)
            .unwrap_err()
            .code,
        "zip_metadata_limit"
    );
}

#[test]
fn caller_limits_cannot_relax_the_original_package_entry_cap() {
    let mut bytes = fixture(|_| {}, false);
    let footer = bytes.len() - 22;
    let false_count = ((MAX_FILES + 9) as u16).to_le_bytes();
    for field in [8, 10] {
        bytes[footer + field..footer + field + 2].copy_from_slice(&false_count);
    }
    let mut bounded = limits();
    bounded.max_raw_entries = usize::MAX;
    assert_eq!(
        inspect_package_identity_with_limits(Cursor::new(bytes), bounded)
            .unwrap_err()
            .code,
        "too_many_files"
    );
}
