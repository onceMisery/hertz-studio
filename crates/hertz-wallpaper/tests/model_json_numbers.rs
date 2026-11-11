// SPDX-License-Identifier: MIT
//! Decimal spelling must survive the original GLB inspector with the same
//! binary64 value as JavaScript JSON.parse. Fixtures start from raw JSON.

use std::io::{Cursor, Write};

use hertz_wallpaper::{
    manifest::validate_manifest_bytes,
    model_binary::inspect_glb_resource_content,
    model_structure::{inspect_glb_resource, GlbResource, ModelNodeTransform},
    validate_archive, validate_package, Manifest,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use zip::{write::SimpleFileOptions, ZipWriter};

fn manifest() -> Manifest {
    validate_manifest_bytes(br#"{"formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae","version":1,"title":"Decimal facts","content":{"kind":"builtin","sceneId":"zodiac","stateVersion":1,"params":{}},"assets":[],"files":[],"permissions":{"audioSpectrum":false,"pointer":false},"license":{"code":"none","assets":"CC0-1.0"}}"#).unwrap()
}

fn glb(json: &str, binary: Option<&[u8]>) -> Vec<u8> {
    let mut json = json.as_bytes().to_vec();
    while !json.len().is_multiple_of(4) {
        json.push(b' ');
    }
    let binary = binary.map(|bytes| {
        let mut bytes = bytes.to_vec();
        while bytes.len() % 4 != 0 {
            bytes.push(0);
        }
        bytes
    });
    let length = 20 + json.len() + binary.as_ref().map_or(0, |bytes| 8 + bytes.len());
    let mut bytes = b"glTF".to_vec();
    bytes.extend(2_u32.to_le_bytes());
    bytes.extend((length as u32).to_le_bytes());
    bytes.extend((json.len() as u32).to_le_bytes());
    bytes.extend(b"JSON");
    bytes.extend(json);
    if let Some(binary) = binary {
        bytes.extend((binary.len() as u32).to_le_bytes());
        bytes.extend([b'B', b'I', b'N', 0]);
        bytes.extend(binary);
    }
    bytes
}

fn inspect(json: &str) -> GlbResource {
    let bytes = glb(json, None);
    inspect_glb_resource(
        Cursor::new(&bytes),
        bytes.len() as u64,
        &manifest(),
        "assets/model.glb",
    )
    .unwrap()
}

fn translation(resource: &GlbResource, index: usize) -> [f64; 3] {
    let ModelNodeTransform::Trs { translation, .. } = resource.structure.nodes[index].transform
    else {
        panic!("fixture expected TRS");
    };
    translation
}

// Fixed expectations independently read back with Node JSON.parse/DataView.
// Include halfway ties, a value above a tie, negative zero and finite extremes.
const CASES: &[(&str, u64)] = &[
    ("0.11000000000000001", 0x3fbc_28f5_c28f_5c2a),
    ("0.19999999999999999", 0x3fc9_9999_9999_9999),
    ("2.7182818284590452353602874713527", 0x4005_bf0a_8b14_5769),
    ("-0.11000000000000001", 0xbfbc_28f5_c28f_5c2a),
    ("-0", 0x8000_0000_0000_0000),
    ("-0.0", 0x8000_0000_0000_0000),
    (
        "1.00000000000000011102230246251565404236316680908203125",
        0x3ff0_0000_0000_0000,
    ),
    (
        "1.00000000000000011102230246251565404236316680908203126",
        0x3ff0_0000_0000_0001,
    ),
    ("5e-324", 1),
    ("2.2250738585072014e-308", 0x0010_0000_0000_0000),
    ("1.7976931348623157e308", 0x7fef_ffff_ffff_ffff),
    ("1.1000000000000001e-1", 0x3fbc_28f5_c28f_5c2a),
];

#[test]
fn raw_decimal_translation_matches_independent_binary64_bits() {
    for &(raw, bits) in CASES {
        let resource = inspect(&format!(
            r#"{{"asset":{{"version":"2.0"}},"nodes":[{{"translation":[{raw},0,0]}}]}}"#
        ));
        assert_eq!(translation(&resource, 0)[0].to_bits(), bits, "{raw}");
    }
}

#[test]
fn authored_scale_rotation_and_matrix_keep_the_same_decimal_bits() {
    let resource = inspect(
        r#"{"asset":{"version":"2.0"},"nodes":[
        {"translation":[0.11000000000000001,0.19999999999999999,2.7182818284590452353602874713527],
         "rotation":[0,0,0.707106781186547524400844362104849,0.707106781186547524400844362104849],
         "scale":[-0.11000000000000001,0.19999999999999999,2.7182818284590452353602874713527]},
        {"matrix":[-0.11000000000000001,0,0,0,0,0.19999999999999999,0,0,0,0,2.7182818284590452353602874713527,0,0.11000000000000001,0.19999999999999999,2.7182818284590452353602874713527,1]}]}"#,
    );
    let ModelNodeTransform::Trs {
        translation,
        rotation,
        scale,
    } = resource.structure.nodes[0].transform
    else {
        panic!("TRS expected");
    };
    assert_eq!(
        translation.map(f64::to_bits),
        [CASES[0].1, CASES[1].1, CASES[2].1]
    );
    assert_eq!(
        scale.map(f64::to_bits),
        [CASES[3].1, CASES[1].1, CASES[2].1]
    );
    let quarter_turn = "0.707106781186547524400844362104849"
        .parse::<f64>()
        .unwrap();
    assert_eq!(
        rotation.map(f64::to_bits),
        [0, 0, quarter_turn.to_bits(), quarter_turn.to_bits()]
    );
    let ModelNodeTransform::Matrix(matrix) = resource.structure.nodes[1].transform else {
        panic!("matrix expected");
    };
    for (index, bits) in [
        (0, CASES[3].1),
        (5, CASES[1].1),
        (10, CASES[2].1),
        (12, CASES[0].1),
        (13, CASES[1].1),
        (14, CASES[2].1),
    ] {
        assert_eq!(matrix[index].to_bits(), bits);
    }
}

#[test]
fn generated_decimal_classes_match_correct_rounding_in_real_glb_nodes() {
    let mut cases = vec![
        "0.1".to_owned(),
        "0.11000000000000001".to_owned(),
        "0.10000000000000002".to_owned(),
        "0.19999999999999999".to_owned(),
        "2.7182818284590452353602874713527".to_owned(),
        "600.0000000000001".to_owned(),
        "2673.672666".to_owned(),
    ];
    for i in 1_u128..=4096 {
        cases.push(format!(
            "0.{:020}",
            (i * 2_718_281_828_459_045_235_u128) % 100_000_000_000_000_000_000_u128
        ));
    }
    for (sign, exponent) in [("", ""), ("-", ""), ("", "e-9"), ("-", "e9")] {
        let numbers = cases
            .iter()
            .map(|raw| format!("{sign}{raw}{exponent}"))
            .collect::<Vec<_>>();
        let nodes = numbers
            .iter()
            .map(|raw| format!(r#"{{"translation":[{raw},0,0]}}"#))
            .collect::<Vec<_>>()
            .join(",");
        let resource = inspect(&format!(
            r#"{{"asset":{{"version":"2.0"}},"nodes":[{nodes}],"scenes":[{{"nodes":[0]}}]}}"#
        ));
        assert_eq!(resource.structure.nodes.len(), 4103);
        for (index, raw) in numbers.iter().enumerate() {
            assert_eq!(
                translation(&resource, index)[0].to_bits(),
                raw.parse::<f64>().unwrap().to_bits(),
                "{raw}"
            );
        }
    }
}

#[test]
fn serialized_typed_values_and_value_consumer_retain_binary64_identity() {
    for &(raw, bits) in CASES {
        let resource = inspect(&format!(
            r#"{{"asset":{{"version":"2.0"}},"nodes":[{{"translation":[{raw},0,0]}}]}}"#
        ));
        let value = translation(&resource, 0)[0];
        let encoded = serde_json::to_string(&value).unwrap();
        assert_eq!(
            encoded.parse::<f64>().unwrap().to_bits(),
            bits,
            "{raw} -> {encoded}"
        );
        let parsed: serde_json::Value = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.as_f64().unwrap().to_bits(), bits, "Value {raw}");
        let parsed: f64 = serde_json::from_value(parsed).unwrap();
        assert_eq!(parsed.to_bits(), bits, "typed Value {raw}");
    }
}

fn triangle(raw: &str) -> Vec<u8> {
    let json = format!(
        r#"{{"asset":{{"version":"2.0"}},"buffers":[{{"byteLength":36}}],
        "bufferViews":[{{"buffer":0,"byteLength":36,"target":34962}}],
        "accessors":[{{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[{raw},0,0],"max":[{raw},1,1]}}],
        "meshes":[{{"primitives":[{{"attributes":{{"POSITION":0}}}}]}}],
        "nodes":[{{"mesh":0,"translation":[{raw},0,0]}}],"scenes":[{{"nodes":[0]}}],"scene":0}}"#
    );
    let mut binary = Vec::new();
    let x = raw.parse::<f32>().unwrap();
    for value in [x, 0., 0., x, 1., 0., x, 0., 1.] {
        binary.extend(value.to_le_bytes());
    }
    glb(&json, Some(&binary))
}

#[test]
fn raw_accessor_bounds_keep_binary64_while_content_uses_effective_float_precision() {
    let bytes = triangle(CASES[0].0);
    let checked = inspect_glb_resource_content(
        Cursor::new(&bytes),
        bytes.len() as u64,
        &manifest(),
        "assets/model.glb",
    )
    .unwrap();
    let accessor = &checked.resource().structure.accessors[0];
    assert_eq!(accessor.min.as_ref().unwrap()[0].to_bits(), CASES[0].1);
    assert_eq!(accessor.max.as_ref().unwrap()[0].to_bits(), CASES[0].1);
    assert_eq!(accessor.min.as_ref().unwrap()[0] as f32, 0.11_f32);
    assert_eq!(translation(checked.resource(), 0)[0].to_bits(), CASES[0].1);
    assert_eq!(checked.bytes(), bytes.len() as u64);
    assert_eq!(
        checked.sha256_hex(),
        format!("{:x}", Sha256::digest(&bytes))
    );
    assert_eq!(checked.checked_elements(), 3);
    assert_eq!(checked.checked_components(), 9);
}

#[test]
fn real_hwpk_source_and_variant_keep_exact_hashes_and_decimal_facts() {
    let files = [
        ("assets/model.glb", triangle(CASES[0].0)),
        ("assets/low.glb", triangle(CASES[1].0)),
    ];
    let mut manifest_value = serde_json::to_value(manifest()).unwrap();
    manifest_value["assets"] = json!([{"id":"model","kind":"model","source":"assets/model.glb","variants":[{"id":"low","file":"assets/low.glb","purpose":"low"}]}]);
    manifest_value["files"] = json!(files.iter().map(|(path, bytes)| json!({"path":path,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes)),"mime":"model/gltf-binary"})).collect::<Vec<_>>());
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file("manifest.json", SimpleFileOptions::default())
        .unwrap();
    writer
        .write_all(&serde_json::to_vec(&manifest_value).unwrap())
        .unwrap();
    for (path, bytes) in &files {
        writer
            .start_file(*path, SimpleFileOptions::default())
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    let archive = writer.finish().unwrap().into_inner();
    let validated = validate_package(Cursor::new(&archive)).unwrap();
    validate_archive(Cursor::new(&archive), &validated.manifest).unwrap();
    for ((path, bytes), bits) in files.iter().zip([CASES[0].1, CASES[1].1]) {
        let checked = inspect_glb_resource_content(
            Cursor::new(bytes),
            bytes.len() as u64,
            &validated.manifest,
            path,
        )
        .unwrap();
        assert_eq!(checked.source_path(), *path);
        assert_eq!(checked.sha256_hex(), format!("{:x}", Sha256::digest(bytes)));
        assert_eq!(translation(checked.resource(), 0)[0].to_bits(), bits);
        let entry = validated
            .manifest
            .files
            .iter()
            .find(|entry| entry.path == *path)
            .unwrap();
        assert_eq!(entry.sha256, checked.sha256_hex());
        assert_eq!(entry.bytes, checked.bytes());
    }
    assert_ne!(Sha256::digest(&files[0].1), Sha256::digest(&files[1].1));
}

#[test]
fn correct_rounding_keeps_overflow_and_duplicate_rejections() {
    for json in [
        r#"{"asset":{"version":"2.0"},"nodes":[{"translation":[1e309,0,0]}]}"#,
        r#"{"asset":{"version":"2.0"},"extras":{"ignored":1e309}}"#,
        r#"{"asset":{"version":"2.0"},"nodes":[{"translation":[0.11,0,0],"translation":[0.12,0,0]}]}"#,
    ] {
        let bytes = glb(json, None);
        assert!(
            inspect_glb_resource(
                Cursor::new(&bytes),
                bytes.len() as u64,
                &manifest(),
                "assets/model.glb"
            )
            .is_err(),
            "{json}"
        );
    }
}
