// SPDX-License-Identifier: MIT
//! Real TRS animation storage fixtures, independent of playback/GPU admission.

use std::io::{Cursor, Write};

use hertz_wallpaper::{
    model_binary::{inspect_glb_resource_content, CheckedGlbResource},
    model_structure::{inspect_glb_resource, AnimationInterpolation, MAX_MODEL_ANIMATIONS},
    validate_archive, validate_package, Manifest,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn manifest() -> Manifest {
    serde_json::from_value(json!({"formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae","version":1,"title":"Model animation",
        "content":{"kind":"builtin","sceneId":"zodiac","stateVersion":1,"params":{}},
        "assets":[],"files":[],"permissions":{"audioSpectrum":false,"pointer":false},
        "license":{"code":"none","assets":"CC0-1.0"}})).unwrap()
}
fn floats(values: &[f32]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}
fn glb(document: &Value, data: &[u8]) -> Vec<u8> {
    let mut text = serde_json::to_vec(document).unwrap();
    while !text.len().is_multiple_of(4) {
        text.push(b' ');
    }
    let length = data.len().div_ceil(4) * 4;
    let mut result = b"glTF".to_vec();
    result.extend(2_u32.to_le_bytes());
    result.extend((28_u32 + text.len() as u32 + length as u32).to_le_bytes());
    result.extend((text.len() as u32).to_le_bytes());
    result.extend(b"JSON");
    result.extend(text);
    result.extend((length as u32).to_le_bytes());
    result.extend([b'B', b'I', b'N', 0]);
    result.extend(data);
    result.resize(result.len() + length - data.len(), 0);
    result
}
fn fixture(path: &str, interpolation: &str, times: &[f32], values: &[f32]) -> (Value, Vec<u8>) {
    let components = if path == "rotation" { 4 } else { 3 };
    let mut data = floats(times);
    data.extend(floats(values));
    let document = json!({"asset":{"version":"2.0"},"buffers":[{"byteLength":data.len()}],
        "bufferViews":[{"buffer":0,"byteLength":times.len()*4},{"buffer":0,"byteOffset":times.len()*4,"byteLength":values.len()*4}],
        "accessors":[{"bufferView":0,"componentType":5126,"count":times.len(),"type":"SCALAR","min":[times[0]],"max":[times[times.len()-1]]},
            {"bufferView":1,"componentType":5126,"count":values.len()/components,"type":if components==4 {"VEC4"} else {"VEC3"}}],
        "nodes":[{}],"animations":[{"name":"motion","samplers":[{"input":0,"output":1,"interpolation":interpolation}],
            "channels":[{"sampler":0,"target":{"node":0,"path":path}}]}]});
    (document, data)
}
fn ordinary() -> (Value, Vec<u8>) {
    fixture(
        "translation",
        "LINEAR",
        &[0., 1.],
        &[0., 0., 0., 1., 2., 3.],
    )
}
fn inspect(document: &Value, data: &[u8]) -> CheckedGlbResource {
    let bytes = glb(document, data);
    inspect_glb_resource_content(
        Cursor::new(&bytes),
        bytes.len() as u64,
        &manifest(),
        "assets/model.glb",
    )
    .unwrap()
}
fn error(document: &Value, data: &[u8]) -> hertz_wallpaper::PackageError {
    let bytes = glb(document, data);
    inspect_glb_resource_content(
        Cursor::new(&bytes),
        bytes.len() as u64,
        &manifest(),
        "assets/model.glb",
    )
    .unwrap_err()
}

#[test]
fn omitted_animations_are_valid_but_explicit_empty_arrays_are_rejected() {
    let (mut document, data) = ordinary();
    document.as_object_mut().unwrap().remove("animations");
    assert!(inspect(&document, &data)
        .resource()
        .structure
        .animations
        .is_empty());
    document["animations"] = json!([]);
    assert_eq!(error(&document, &data).code, "invalid_model_structure");
}

#[test]
fn all_three_float_trs_paths_and_interpolations_have_checked_storage() {
    for path in ["translation", "rotation", "scale"] {
        for interpolation in ["STEP", "LINEAR", "CUBICSPLINE"] {
            let key = if path == "rotation" {
                vec![0., 0., 0., 1.]
            } else {
                vec![1., 2., 3.]
            };
            let mut values = Vec::new();
            for _ in 0..2 {
                if interpolation == "CUBICSPLINE" {
                    values.extend(vec![0.; key.len()]);
                }
                values.extend(&key);
                if interpolation == "CUBICSPLINE" {
                    values.extend(vec![0.; key.len()]);
                }
            }
            let (document, data) = fixture(path, interpolation, &[0., 1.], &values);
            let checked = inspect(&document, &data);
            let animation = &checked.resource().structure.animations[0];
            assert_eq!(animation.name.as_deref(), Some("motion"));
            assert_eq!(animation.duration_upper_bound, 1.);
            assert_eq!(animation.channels[0].target_node, Some(0));
            assert!(!checked.resource().structure.binary_content_validated);
            assert_eq!(
                checked.sha256_hex(),
                format!("{:x}", Sha256::digest(glb(&document, &data)))
            );
        }
    }
    let (mut document, data) = ordinary();
    document["animations"][0]["samplers"][0]
        .as_object_mut()
        .unwrap()
        .remove("interpolation");
    assert_eq!(
        inspect(&document, &data).resource().structure.animations[0].samplers[0].interpolation,
        AnimationInterpolation::Linear
    );
}

#[test]
fn metadata_duration_does_not_prove_actual_timestamp_values() {
    let (document, mut data) = ordinary();
    data[4..8].copy_from_slice(&0_f32.to_le_bytes());
    let bytes = glb(&document, &data);
    let metadata = inspect_glb_resource(
        Cursor::new(&bytes),
        bytes.len() as u64,
        &manifest(),
        "assets/model.glb",
    )
    .unwrap();
    assert_eq!(metadata.structure.animations[0].duration_upper_bound, 1.);
    assert!(!metadata.structure.binary_content_validated);
    let error = error(&document, &data);
    assert_eq!(error.code, "invalid_model_binary");
    assert!(error.message.contains("timestamps"));
}

#[test]
fn timestamp_keys_must_be_nonnegative_finite_and_strictly_increasing() {
    let (document, data) = ordinary();
    for times in [
        [-1_f32, 1.],
        [0., 0.],
        [1., 0.],
        [f32::NAN, 1.],
        [0., f32::INFINITY],
    ] {
        let mut wrong = data.clone();
        wrong[..8].copy_from_slice(&floats(&times));
        assert_eq!(error(&document, &wrong).code, "invalid_model_binary");
    }
    let (document, data) = fixture("translation", "STEP", &[-0., 1.], &[0., 0., 0., 1., 2., 3.]);
    inspect(&document, &data);
}

#[test]
fn sampler_refs_input_type_and_bounds_must_be_valid() {
    let (document, data) = ordinary();
    for (pointer, value) in [
        ("/animations/0/samplers/0/input", json!(99)),
        ("/animations/0/samplers/0/output", json!(99)),
        ("/animations/0/channels/0/sampler", json!(99)),
        ("/animations/0/channels/0/target/node", json!(99)),
        ("/accessors/0/componentType", json!(5125)),
        ("/accessors/0/type", json!("VEC2")),
    ] {
        let mut wrong = document.clone();
        *wrong.pointer_mut(pointer).unwrap() = value;
        assert_eq!(error(&wrong, &data).code, "invalid_model_structure");
    }
    for bound in ["min", "max"] {
        let mut wrong = document.clone();
        wrong["accessors"][0].as_object_mut().unwrap().remove(bound);
        assert_eq!(error(&wrong, &data).code, "invalid_model_structure");
    }
}

#[test]
fn output_type_count_and_interpolation_are_not_inferred_from_bytes() {
    let (document, data) = ordinary();
    for (pointer, value) in [
        ("/accessors/1/type", json!("VEC2")),
        ("/accessors/1/componentType", json!(5123)),
        ("/accessors/1/count", json!(1)),
        ("/animations/0/samplers/0/interpolation", json!("BEZIER")),
        ("/animations/0/channels/0/target/path", json!("opacity")),
    ] {
        let mut wrong = document.clone();
        *wrong.pointer_mut(pointer).unwrap() = value;
        assert_eq!(error(&wrong, &data).code, "invalid_model_structure");
    }
    for interpolation in ["STEP", "LINEAR"] {
        let (document, data) = fixture("translation", interpolation, &[0.], &[1., 2., 3.]);
        inspect(&document, &data);
    }
    let (document, data) = fixture("translation", "CUBICSPLINE", &[0.], &[0.; 9]);
    assert_eq!(error(&document, &data).code, "invalid_model_structure");
}

#[test]
fn trs_cannot_animate_matrix_nodes_and_targets_are_unique_per_animation() {
    let (document, data) = ordinary();
    let mut matrix = document.clone();
    matrix["nodes"][0]["matrix"] = json!([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    assert_eq!(error(&matrix, &data).code, "invalid_model_structure");
    let mut duplicate = document.clone();
    let channel = duplicate["animations"][0]["channels"][0].clone();
    duplicate["animations"][0]["channels"]
        .as_array_mut()
        .unwrap()
        .push(channel);
    assert_eq!(error(&duplicate, &data).code, "invalid_model_structure");
    let mut other_property = document.clone();
    other_property["animations"][0]["channels"]
        .as_array_mut()
        .unwrap()
        .push(json!({"sampler":0,"target":{"node":0,"path":"scale"}}));
    inspect(&other_property, &data);
    let mut separate = document.clone();
    let animation = separate["animations"][0].clone();
    separate["animations"]
        .as_array_mut()
        .unwrap()
        .push(animation);
    assert_eq!(
        inspect(&separate, &data)
            .resource()
            .structure
            .animations
            .len(),
        2
    );
}

#[test]
fn ignored_channels_have_no_target_duration_but_unused_inputs_are_still_checked() {
    let (mut document, mut data) = ordinary();
    document["animations"][0]["channels"][0]["target"]
        .as_object_mut()
        .unwrap()
        .remove("node");
    document["animations"][0]["channels"][0]["target"]["path"] = json!("weights");
    let checked = inspect(&document, &data);
    assert_eq!(
        checked.resource().structure.animations[0].duration_upper_bound,
        0.
    );
    assert_eq!(
        checked.resource().structure.animations[0].channels[0].target_node,
        None
    );
    data[4..8].copy_from_slice(&0_f32.to_le_bytes());
    let error = error(&document, &data);
    assert_eq!(error.code, "invalid_model_binary");
    assert!(error.message.contains("timestamps"));
}

#[test]
fn ignored_channel_output_shape_is_not_a_property_shape_requirement() {
    let (mut document, data) = ordinary();
    document["animations"][0]["channels"][0]["target"]
        .as_object_mut()
        .unwrap()
        .remove("node");
    document["accessors"][1]["type"] = json!("SCALAR");
    document["accessors"][1]["count"] = json!(6);
    inspect(&document, &data);
    document["animations"][0]["samplers"][0]["output"] = json!(999);
    assert_eq!(error(&document, &data).code, "invalid_model_structure");
}

#[test]
fn duration_only_uses_samplers_of_nonignored_channels() {
    let (mut document, mut data) = ordinary();
    let offset = data.len();
    data.extend(floats(&[0., 10.]));
    document["buffers"][0]["byteLength"] = json!(data.len());
    document["bufferViews"]
        .as_array_mut()
        .unwrap()
        .push(json!({"buffer":0,"byteOffset":offset,"byteLength":8}));
    document["accessors"].as_array_mut().unwrap().push(
        json!({"bufferView":2,"componentType":5126,"count":2,"type":"SCALAR","min":[0],"max":[10]}),
    );
    document["animations"][0]["samplers"]
        .as_array_mut()
        .unwrap()
        .push(json!({"input":2,"output":1}));
    document["animations"][0]["channels"]
        .as_array_mut()
        .unwrap()
        .push(json!({"sampler":1,"target":{"path":"translation"}}));
    assert_eq!(
        inspect(&document, &data).resource().structure.animations[0].duration_upper_bound,
        1.
    );
    data[offset + 4..offset + 8].copy_from_slice(&0_f32.to_le_bytes());
    assert_eq!(error(&document, &data).code, "invalid_model_binary");
}

#[test]
fn rotation_values_are_unit_but_cubic_derivatives_need_not_be() {
    for interpolation in ["LINEAR", "STEP"] {
        let (document, data) = fixture(
            "rotation",
            interpolation,
            &[0., 1.],
            &[0., 0., 0., 1., 0., 0., 1., 0.],
        );
        inspect(&document, &data);
        let mut wrong = data;
        wrong[8..24].copy_from_slice(&floats(&[0., 0., 0., 2.]));
        assert_eq!(error(&document, &wrong).code, "invalid_model_binary");
    }
    let values = [
        2., 3., -4., 5., 0., 0., 0., 1., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 1., 0., 3., 2.,
        1., 0.,
    ];
    let (document, mut data) = fixture("rotation", "CUBICSPLINE", &[0., 1.], &values);
    inspect(&document, &data);
    let mut nonfinite_derivative = data.clone();
    nonfinite_derivative[8..12].copy_from_slice(&f32::NAN.to_le_bytes());
    assert_eq!(
        error(&document, &nonfinite_derivative).code,
        "invalid_model_binary"
    );
    data[24..40].copy_from_slice(&floats(&[0.; 4]));
    assert_eq!(error(&document, &data).code, "invalid_model_binary");
}

#[test]
fn reused_rotation_layout_cannot_drop_linear_constraints_for_cubic_aliases() {
    let values = [
        0., 0., 0., 0., 0., 0., 0., 1., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 1., 0., 0., 0.,
        0.,
    ];
    let (mut document, mut data) = fixture("rotation", "CUBICSPLINE", &[0., 1.], &values);
    let offset = data.len();
    data.extend(floats(&[0., 1., 2., 3., 4., 5.]));
    document["buffers"][0]["byteLength"] = json!(data.len());
    document["bufferViews"]
        .as_array_mut()
        .unwrap()
        .push(json!({"buffer":0,"byteOffset":offset,"byteLength":24}));
    document["accessors"].as_array_mut().unwrap().push(
        json!({"bufferView":2,"componentType":5126,"count":6,"type":"SCALAR","min":[0],"max":[5]}),
    );
    let alias = document["accessors"][1].clone();
    document["accessors"].as_array_mut().unwrap().push(alias);
    document["nodes"].as_array_mut().unwrap().push(json!({}));
    document["animations"][0]["samplers"]
        .as_array_mut()
        .unwrap()
        .push(json!({"input":2,"output":3,"interpolation":"LINEAR"}));
    document["animations"][0]["channels"]
        .as_array_mut()
        .unwrap()
        .push(json!({"sampler":1,"target":{"node":1,"path":"rotation"}}));
    let error = error(&document, &data);
    assert_eq!(error.code, "invalid_model_binary");
    assert!(error.message.contains("unit quaternion"));
}

#[test]
fn timestamp_monotonicity_is_kept_across_stream_blocks() {
    let count = 17_000;
    let times: Vec<_> = (0..count).map(|value| value as f32).collect();
    let values = vec![0.; count * 3];
    let (document, mut data) = fixture("translation", "LINEAR", &times, &values);
    inspect(&document, &data);
    data[65_536..65_540].copy_from_slice(&16_383_f32.to_le_bytes());
    let error = error(&document, &data);
    assert_eq!(error.code, "invalid_model_binary");
    assert!(error.message.contains("timestamps"));
}

#[test]
fn animation_views_do_not_mix_roles_target_or_stride() {
    let (document, data) = ordinary();
    for (field, value) in [("target", json!(34962)), ("byteStride", json!(4))] {
        let mut wrong = document.clone();
        wrong["bufferViews"][0][field] = value;
        assert_eq!(error(&wrong, &data).code, "invalid_model_structure");
    }
    let (mut mixed, data) = fixture("translation", "LINEAR", &[0., 1., 2.], &[0.; 9]);
    mixed["accessors"][1]["min"] = json!([0, 0, 0]);
    mixed["accessors"][1]["max"] = json!([0, 0, 0]);
    mixed["meshes"] = json!([{"primitives":[{"attributes":{"POSITION":1}}]}]);
    let error = error(&mixed, &data);
    assert_eq!(error.code, "invalid_model_structure");
    assert!(error.message.contains("mix"));
}

#[test]
fn animation_extensions_stay_explicitly_unavailable() {
    for pointer in [
        "/animations/0/extensions",
        "/animations/0/samplers/0/extensions",
        "/animations/0/channels/0/extensions",
        "/animations/0/channels/0/target/extensions",
    ] {
        let (mut document, data) = ordinary();
        let (parent, key) = pointer.rsplit_once('/').unwrap();
        document.pointer_mut(parent).unwrap()[key] = json!({});
        assert_eq!(error(&document, &data).code, "model_resource_unavailable");
    }
}

#[test]
fn optional_field_null_and_unknown_types_do_not_become_ignored_channels() {
    let (document, data) = ordinary();
    for pointer in ["/animations/0/name", "/animations/0/channels/0/target/node"] {
        let mut wrong = document.clone();
        *wrong.pointer_mut(pointer).unwrap() = Value::Null;
        assert_eq!(error(&wrong, &data).code, "invalid_model_structure");
    }
    for (parent, key) in [
        ("/animations/0", "script"),
        ("/animations/0/samplers/0", "parameters"),
        ("/animations/0/channels/0/target", "url"),
    ] {
        let mut wrong = document.clone();
        wrong.pointer_mut(parent).unwrap()[key] = json!("https://example.test");
        assert_eq!(error(&wrong, &data).code, "invalid_model_structure");
    }
}

#[test]
fn animation_arrays_and_total_records_are_bounded() {
    let (document, data) = ordinary();
    let mut excessive = document.clone();
    excessive["animations"] = json!(vec![
        document["animations"][0].clone();
        MAX_MODEL_ANIMATIONS + 1
    ]);
    assert_eq!(error(&excessive, &data).code, "model_structure_limit");
    for field in ["samplers", "channels"] {
        let mut excessive = document.clone();
        let mut many = document["animations"][0].clone();
        let value = if field == "samplers" {
            json!({"input":0,"output":1})
        } else {
            json!({"sampler":0,"target":{"path":"translation"}})
        };
        many[field] = json!(vec![value; 16_384]);
        excessive["animations"] = json!([many, document["animations"][0].clone()]);
        assert_eq!(error(&excessive, &data).code, "model_structure_limit");
    }
    for field in ["samplers", "channels"] {
        let mut empty = document.clone();
        empty["animations"][0][field] = json!([]);
        assert_eq!(error(&empty, &data).code, "invalid_model_structure");
    }
}

fn package(model: &[u8], variant: bool) -> Vec<u8> {
    let mut manifest = serde_json::to_value(manifest()).unwrap();
    let path = if variant {
        "assets/low.glb"
    } else {
        "assets/model.glb"
    };
    let mut files = vec![(path, model.to_vec())];
    if variant {
        files.push((
            "assets/model.glb",
            glb(&json!({"asset":{"version":"2.0"}}), &[]),
        ));
    }
    manifest["assets"] = if variant {
        json!([{"id":"model","kind":"model","source":"assets/model.glb","variants":[{"id":"low","file":path,"purpose":"low"}]}])
    } else {
        json!([{"id":"model","kind":"model","source":path,"variants":[]}])
    };
    manifest["files"]=json!(files.iter().map(|(path,data)|json!({"path":path,"bytes":data.len(),"sha256":format!("{:x}",Sha256::digest(data)),"mime":"model/gltf-binary"})).collect::<Vec<_>>());
    files.push(("manifest.json", serde_json::to_vec(&manifest).unwrap()));
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (path, data) in files {
        writer
            .start_file(path, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(&data).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

#[test]
fn public_zip_entries_verify_actual_animation_source_and_variants() {
    let (document, mut data) = ordinary();
    for variant in [false, true] {
        let bytes = package(&glb(&document, &data), variant);
        let validated = validate_package(Cursor::new(&bytes)).unwrap();
        validate_archive(Cursor::new(&bytes), &validated.manifest).unwrap();
    }
    data[4..8].copy_from_slice(&0_f32.to_le_bytes());
    for variant in [false, true] {
        let bytes = package(&glb(&document, &data), variant);
        let error = validate_package(Cursor::new(&bytes)).unwrap_err();
        assert_eq!(error.code, "invalid_model_binary");
        assert!(error.message.contains(if variant {
            "assets/low.glb"
        } else {
            "assets/model.glb"
        }));
        let mut archive = zip::ZipArchive::new(Cursor::new(&bytes)).unwrap();
        let parsed: Manifest =
            serde_json::from_reader(archive.by_name("manifest.json").unwrap()).unwrap();
        assert_eq!(
            validate_archive(Cursor::new(&bytes), &parsed)
                .unwrap_err()
                .code,
            "invalid_model_binary"
        );
    }
}
