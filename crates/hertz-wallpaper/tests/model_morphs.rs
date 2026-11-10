// SPDX-License-Identifier: MIT
//! Real morph GLB/ZIP storage and stream boundaries, independent of playback.

use std::io::{self, Cursor, Read, Write};

use hertz_wallpaper::{
    model_binary::{inspect_glb_resource_content, CheckedGlbResource},
    model_structure::{inspect_glb_resource, AnimationPath, MAX_MODEL_RECORDS},
    validate_archive, validate_package, Manifest, PackageError,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn manifest() -> Manifest {
    serde_json::from_value(json!({"formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae","version":1,"title":"Model morph",
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
fn prefix_raw(text: &[u8], bin_bytes: usize) -> Vec<u8> {
    let mut text = text.to_vec();
    while text.len() % 4 != 0 {
        text.push(b' ');
    }
    let mut result = b"glTF".to_vec();
    result.extend(2_u32.to_le_bytes());
    result.extend((28_u32 + text.len() as u32 + bin_bytes.div_ceil(4) as u32 * 4).to_le_bytes());
    result.extend((text.len() as u32).to_le_bytes());
    result.extend(b"JSON");
    result.extend(text);
    result.extend((bin_bytes.div_ceil(4) as u32 * 4).to_le_bytes());
    result.extend([b'B', b'I', b'N', 0]);
    result
}
fn glb_raw(text: &[u8], data: &[u8]) -> Vec<u8> {
    let mut result = prefix_raw(text, data.len());
    result.extend(data);
    result.resize(result.len() + data.len().div_ceil(4) * 4 - data.len(), 0);
    result
}
fn glb(document: &Value, data: &[u8]) -> Vec<u8> {
    glb_raw(&serde_json::to_vec(document).unwrap(), data)
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
fn error(document: &Value, data: &[u8]) -> PackageError {
    let bytes = glb(document, data);
    inspect_glb_resource_content(
        Cursor::new(&bytes),
        bytes.len() as u64,
        &manifest(),
        "assets/model.glb",
    )
    .unwrap_err()
}
fn raw_error(text: &str, data: &[u8]) -> PackageError {
    let bytes = glb_raw(text.as_bytes(), data);
    inspect_glb_resource_content(
        Cursor::new(&bytes),
        bytes.len() as u64,
        &manifest(),
        "assets/model.glb",
    )
    .unwrap_err()
}
fn add_accessor(
    document: &mut Value,
    data: &mut Vec<u8>,
    mut accessor: Value,
    block: &[u8],
    stride: Option<usize>,
) -> usize {
    while data.len() % 4 != 0 {
        data.push(0);
    }
    let mut view = json!({"buffer":0,"byteOffset":data.len(),"byteLength":block.len()});
    if let Some(stride) = stride {
        view["byteStride"] = json!(stride);
    }
    let views = document["bufferViews"].as_array_mut().unwrap();
    accessor["bufferView"] = json!(views.len());
    views.push(view);
    data.extend(block);
    document["buffers"][0]["byteLength"] = json!(data.len());
    let accessors = document["accessors"].as_array_mut().unwrap();
    let index = accessors.len();
    accessors.push(accessor);
    index
}
fn ordinary() -> (Value, Vec<u8>) {
    let mut document = json!({"asset":{"version":"2.0"},"buffers":[{"byteLength":1}],"bufferViews":[],"accessors":[],
        "meshes":[{"primitives":[{"attributes":{"POSITION":0},"targets":[{"POSITION":1},{}]}],"weights":[-0.5,1.75]}],
        "nodes":[{"mesh":0,"weights":[2,-1]},{"mesh":0}],
        "animations":[{"samplers":[{"input":2,"output":3}],"channels":[{"sampler":0,"target":{"node":0,"path":"weights"}}]}]});
    let mut data = Vec::new();
    add_accessor(
        &mut document,
        &mut data,
        json!({"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]}),
        &floats(&[0., 0., 0., 1., 0., 0., 0., 1., 0.]),
        None,
    );
    add_accessor(
        &mut document,
        &mut data,
        json!({"componentType":5126,"count":3,"type":"VEC3","min":[-1,0,0],"max":[0,2,3]}),
        &floats(&[-1., 0., 0., 0., 2., 0., 0., 0., 3.]),
        None,
    );
    add_accessor(
        &mut document,
        &mut data,
        json!({"componentType":5126,"count":2,"type":"SCALAR","min":[0],"max":[1]}),
        &floats(&[0., 1.]),
        None,
    );
    add_accessor(
        &mut document,
        &mut data,
        json!({"componentType":5126,"count":4,"type":"SCALAR"}),
        &floats(&[-0.5, 1.75, 2., -1.]),
        None,
    );
    (document, data)
}
fn without_animation(document: &mut Value) {
    document.as_object_mut().unwrap().remove("animations");
}
fn weights_fixture(interpolation: &str, times: &[f32], values: &[f32]) -> (Value, Vec<u8>) {
    let (mut document, mut data) = ordinary();
    data.truncate(72);
    document["accessors"].as_array_mut().unwrap().truncate(2);
    document["bufferViews"].as_array_mut().unwrap().truncate(2);
    add_accessor(
        &mut document,
        &mut data,
        json!({"componentType":5126,"count":times.len(),"type":"SCALAR","min":[times[0]],"max":[times[times.len()-1]]}),
        &floats(times),
        None,
    );
    add_accessor(
        &mut document,
        &mut data,
        json!({"componentType":5126,"count":values.len(),"type":"SCALAR"}),
        &floats(values),
        None,
    );
    document["animations"][0]["samplers"][0]["interpolation"] = json!(interpolation);
    (document, data)
}

#[test]
fn morph_defaults_and_float_weights_use_author_order() {
    let (document, data) = ordinary();
    let checked = inspect(&document, &data);
    let structure = &checked.resource().structure;
    assert_eq!(structure.meshes[0].morph_target_count, 2);
    assert_eq!(structure.meshes[0].default_weights, Some(vec![-0.5, 1.75]));
    assert_eq!(
        structure.node_morph_weights,
        vec![Some(vec![2., -1.]), None]
    );
    assert_eq!(structure.meshes[0].primitives[0].targets[0]["POSITION"], 1);
    assert!(structure.meshes[0].primitives[0].targets[1].is_empty());
    assert_eq!(
        structure.animations[0].channels[0].path,
        AnimationPath::Weights
    );
    assert_eq!(structure.animations[0].duration_upper_bound, 1.);
    assert!(!structure.binary_content_validated);
    assert_eq!(
        checked.sha256_hex(),
        format!("{:x}", Sha256::digest(glb(&document, &data)))
    );
    let mut large = document.clone();
    large["meshes"][0]["weights"] = json!([-0.0, 1e300]);
    large["nodes"][1]["weights"] = json!([-3, 7]);
    let checked = inspect(&large, &data);
    let structure = &checked.resource().structure;
    assert_eq!(
        structure.meshes[0].default_weights.as_ref().unwrap()[1],
        1e300
    );
    assert!(structure.meshes[0].default_weights.as_ref().unwrap()[0].is_sign_negative());
    assert_eq!(structure.node_morph_weights[1], Some(vec![-3., 7.]));
}

#[test]
fn mixed_primitives_and_empty_targets_preserve_zero_deltas() {
    let (mut document, data) = ordinary();
    let primitive = document["meshes"][0]["primitives"][0].clone();
    document["meshes"][0]["primitives"] =
        json!([{"attributes":{"POSITION":0}},primitive.clone(),primitive]);
    let checked = inspect(&document, &data);
    let mesh = &checked.resource().structure.meshes[0];
    assert_eq!(mesh.morph_target_count, 2);
    assert!(mesh.primitives[0].targets.is_empty());
    assert_eq!(mesh.triangles_upper_bound, 3);
    document["meshes"][0]["primitives"] = json!([{"attributes":{"POSITION":0},"targets":[{},{}]}]);
    document["meshes"][0]
        .as_object_mut()
        .unwrap()
        .remove("weights");
    document["nodes"][0]
        .as_object_mut()
        .unwrap()
        .remove("weights");
    let checked = inspect(&document, &data);
    let structure = &checked.resource().structure;
    assert_eq!(structure.meshes[0].morph_target_count, 2);
    assert_eq!(structure.meshes[0].default_weights, None);
    assert_eq!(structure.node_morph_weights, vec![None, None]);
}

#[test]
fn all_core_morph_semantics_use_delta_shapes() {
    for (semantic, base_shape, delta_shape, base, delta) in [
        ("NORMAL", "VEC3", "VEC3", vec![0., 0., 1.], vec![0., 0., 0.]),
        (
            "TANGENT",
            "VEC4",
            "VEC3",
            vec![1., 0., 0., 1.],
            vec![-4., 0., 0.],
        ),
        ("TEXCOORD_0", "VEC2", "VEC2", vec![0., 1.], vec![-2., 3.]),
        (
            "COLOR_0",
            "VEC3",
            "VEC4",
            vec![0.2, 0.3, 0.4],
            vec![-2., 3., 0., -1.],
        ),
        (
            "COLOR_0",
            "VEC4",
            "VEC3",
            vec![0.2, 0.3, 0.4, 1.],
            vec![-2., 3., 0.],
        ),
        ("_CUSTOM", "SCALAR", "VEC2", vec![4.], vec![-8., 2.]),
    ] {
        let (mut document, mut data) = ordinary();
        let base_index = add_accessor(
            &mut document,
            &mut data,
            json!({"componentType":5126,"count":3,"type":base_shape}),
            &floats(&base.repeat(3)),
            None,
        );
        let delta_index = add_accessor(
            &mut document,
            &mut data,
            json!({"componentType":5126,"count":3,"type":delta_shape}),
            &floats(&delta.repeat(3)),
            None,
        );
        document["meshes"][0]["primitives"][0]["attributes"][semantic] = json!(base_index);
        document["meshes"][0]["primitives"][0]["targets"][0][semantic] = json!(delta_index);
        inspect(&document, &data);
    }
    // Missing lower delta sets are zero: indexed base attributes still have no gaps.
    let (mut document, mut data) = ordinary();
    let index = add_accessor(
        &mut document,
        &mut data,
        json!({"componentType":5126,"count":3,"type":"VEC2"}),
        &floats(&[0.; 6]),
        None,
    );
    document["meshes"][0]["primitives"][0]["attributes"]["TEXCOORD_0"] = json!(index);
    document["meshes"][0]["primitives"][0]["attributes"]["TEXCOORD_1"] = json!(index);
    document["meshes"][0]["primitives"][0]["targets"][0]["TEXCOORD_1"] = json!(index);
    inspect(&document, &data);
}

#[test]
fn normalized_uv_color_deltas_keep_raw_signed_endpoint_bounds() {
    for component in [5120, 5121, 5122, 5123] {
        for (semantic, shape, rows) in [("TEXCOORD_0", "VEC2", 2), ("COLOR_0", "VEC3", 3)] {
            let (mut document, mut data) = ordinary();
            let base_index = add_accessor(
                &mut document,
                &mut data,
                json!({"componentType":5126,"count":3,"type":shape}),
                &floats(&vec![0.25; rows * 3]),
                None,
            );
            let (low, near, high, width) = match component {
                5120 => (-128, -127, 127, 1),
                5121 => (0, 1, 255, 1),
                5122 => (-32768, -32767, 32767, 2),
                _ => (0, 1, 65535, 2),
            };
            let stride = (rows * width).div_ceil(4) * 4;
            let mut block = Vec::new();
            for value in [low, near, high] {
                for _ in 0..rows {
                    if width == 1 {
                        block.push(value as u8);
                    } else {
                        block.extend((value as u16).to_le_bytes());
                    }
                }
                block.resize(block.len() + stride - rows * width, 0);
            }
            let delta = add_accessor(
                &mut document,
                &mut data,
                json!({"componentType":component,"normalized":true,"count":3,"type":shape,"min":vec![low;rows],"max":vec![high;rows]}),
                &block,
                Some(stride),
            );
            document["meshes"][0]["primitives"][0]["attributes"][semantic] = json!(base_index);
            document["meshes"][0]["primitives"][0]["targets"][0][semantic] = json!(delta);
            let checked = inspect(&document, &data);
            assert_eq!(
                checked.resource().structure.accessors[delta].min,
                Some(vec![low as f64; rows])
            );
            document["accessors"][delta]["min"] = json!(vec![-1; rows]);
            let expected = if component == 5121 || component == 5123 {
                "invalid_model_structure"
            } else {
                "invalid_model_binary"
            };
            assert_eq!(error(&document, &data).code, expected);
        }
    }
}

#[test]
fn morph_refs_counts_shapes_and_defaults_are_not_guessed() {
    let (document, data) = ordinary();
    for (pointer, value) in [
        ("/meshes/0/primitives/0/targets/0/POSITION", json!(99)),
        ("/accessors/1/count", json!(2)),
        ("/accessors/1/type", json!("VEC2")),
        ("/meshes/0/weights", json!([1])),
        ("/nodes/0/weights", json!([1, 2, 3])),
        ("/meshes/0/weights", json!([])),
        ("/nodes/0/weights", json!([])),
        ("/meshes/0/weights", Value::Null),
        ("/nodes/0/weights", Value::Null),
        ("/meshes/0/weights", json!({})),
        ("/nodes/0/weights", json!("bad")),
        ("/meshes/0/primitives/0/targets", json!([])),
        ("/meshes/0/primitives/0/targets", Value::Null),
        ("/meshes/0/primitives/0/targets", json!([{"POSITION":null}])),
        ("/meshes/0/primitives/0/targets", json!([{"POSITION":1.5}])),
        ("/meshes/0/primitives/0/targets", json!([{"POSITION":{}}])),
        ("/meshes/0/primitives/0/targets", json!([{"POSITION":[]}])),
        ("/meshes/0/primitives/0/targets", json!([{"NORMAL":1},{}])),
    ] {
        let mut wrong = document.clone();
        *wrong.pointer_mut(pointer).unwrap() = value;
        assert_eq!(
            error(&wrong, &data).code,
            "invalid_model_structure",
            "{pointer}"
        );
    }
    let mut wrong = document.clone();
    wrong["accessors"][1].as_object_mut().unwrap().remove("min");
    assert_eq!(error(&wrong, &data).code, "invalid_model_structure");
    let mut wrong = document.clone();
    wrong["meshes"][0]["primitives"]
        .as_array_mut()
        .unwrap()
        .push(json!({"attributes":{"POSITION":0},"targets":[{}]}));
    assert_eq!(error(&wrong, &data).code, "invalid_model_structure");
    let mut wrong = document.clone();
    wrong["nodes"][0].as_object_mut().unwrap().remove("mesh");
    assert_eq!(error(&wrong, &data).code, "invalid_model_structure");
    let mut wrong = document.clone();
    without_animation(&mut wrong);
    wrong["meshes"][0]["primitives"][0]
        .as_object_mut()
        .unwrap()
        .remove("targets");
    assert_eq!(error(&wrong, &data).code, "invalid_model_structure");
    for semantic in [
        "TANGENT",
        "TEXCOORD_0",
        "COLOR_0",
        "TEXCOORD_01",
        "POSITION_0",
    ] {
        let mut wrong = document.clone();
        wrong["meshes"][0]["primitives"][0]["attributes"][semantic] = json!(0);
        wrong["meshes"][0]["primitives"][0]["targets"][0][semantic] = json!(0);
        if semantic == "COLOR_0" {
            wrong["accessors"][1]["type"] = json!("VEC2");
            wrong["meshes"][0]["primitives"][0]["targets"][0][semantic] = json!(1);
        }
        assert_eq!(
            error(&wrong, &data).code,
            "invalid_model_structure",
            "{semantic}"
        );
    }
    for (semantic, base_shape, delta_shape, base) in [
        ("TANGENT", "VEC4", "VEC4", vec![1., 0., 0., 1.]),
        ("TEXCOORD_0", "VEC2", "VEC3", vec![0., 1.]),
        ("COLOR_0", "VEC3", "VEC2", vec![0.2, 0.3, 0.4]),
    ] {
        let (mut wrong, mut binary) = ordinary();
        let base_index = add_accessor(
            &mut wrong,
            &mut binary,
            json!({"componentType":5126,"count":3,"type":base_shape}),
            &floats(&base.repeat(3)),
            None,
        );
        let rows = match delta_shape {
            "VEC4" => 4,
            "VEC3" => 3,
            _ => 2,
        };
        let delta = add_accessor(
            &mut wrong,
            &mut binary,
            json!({"componentType":5126,"count":3,"type":delta_shape}),
            &floats(&vec![0.; rows * 3]),
            None,
        );
        wrong["meshes"][0]["primitives"][0]["attributes"][semantic] = json!(base_index);
        wrong["meshes"][0]["primitives"][0]["targets"][0][semantic] = json!(delta);
        let error = error(&wrong, &binary);
        assert_eq!(error.code, "invalid_model_structure");
        assert!(error.message.contains("morph target"));
    }
}

#[test]
fn target_views_keep_vertex_alignment_and_exclusive_roles() {
    let (document, data) = ordinary();
    for (field, value) in [("target", json!(34963)), ("byteStride", json!(14))] {
        let mut wrong = document.clone();
        wrong["bufferViews"][1][field] = value;
        assert_eq!(error(&wrong, &data).code, "invalid_model_structure");
    }
    for role in ["animation", "image"] {
        let (mut wrong, mut binary) = ordinary();
        let index = add_accessor(
            &mut wrong,
            &mut binary,
            json!({"componentType":5126,"count":3,"type":"VEC3"}),
            &floats(&[0.; 9]),
            None,
        );
        wrong["meshes"][0]["primitives"][0]["attributes"]["_CUSTOM"] = json!(index);
        wrong["meshes"][0]["primitives"][0]["targets"][0]["_CUSTOM"] = json!(index);
        if role == "animation" {
            wrong["animations"][0]["samplers"][0]["output"] = json!(index);
        } else {
            wrong["images"] = json!([{"bufferView":4,"mimeType":"image/png"}]);
        }
        let error = error(&wrong, &binary);
        assert_eq!(error.code, "invalid_model_structure");
        assert!(error.message.contains("mix"));
    }
    let (mut wrong, mut binary) = ordinary();
    let index = add_accessor(
        &mut wrong,
        &mut binary,
        json!({"componentType":5123,"count":3,"type":"SCALAR"}),
        &[0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0],
        Some(4),
    );
    wrong["meshes"][0]["primitives"][0]["attributes"]["_CUSTOM"] = json!(index);
    wrong["meshes"][0]["primitives"][0]["targets"][0]["_CUSTOM"] = json!(index);
    wrong["meshes"][0]["primitives"][0]["indices"] = json!(index);
    let error = error(&wrong, &binary);
    assert_eq!(error.code, "invalid_model_structure");
    assert!(error.message.contains("mix"));
}

#[test]
fn weights_channels_validate_mesh_length_matrix_and_unique_targets() {
    let (document, data) = ordinary();
    let mut matrix = document.clone();
    matrix["nodes"][0]["matrix"] = json!([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    inspect(&matrix, &data);
    matrix["animations"][0]["channels"][0]["target"]["path"] = json!("translation");
    assert!(error(&matrix, &data).message.contains("matrix"));
    for no_mesh in [true, false] {
        let mut wrong = document.clone();
        wrong["nodes"][0].as_object_mut().unwrap().remove("weights");
        if no_mesh {
            wrong["nodes"][0].as_object_mut().unwrap().remove("mesh");
        } else {
            wrong["meshes"][0]
                .as_object_mut()
                .unwrap()
                .remove("weights");
            wrong["meshes"][0]["primitives"][0]
                .as_object_mut()
                .unwrap()
                .remove("targets");
        }
        assert_eq!(error(&wrong, &data).code, "invalid_model_structure");
    }
    let mut node = document.clone();
    node["nodes"][0]["weights"] = json!(["WEIGHT_SENTINEL"]);
    let excessive = format!(
        "[{},{{\"invalid\":[]}}]",
        vec!["0"; MAX_MODEL_RECORDS].join(",")
    );
    assert_eq!(
        raw_error(
            &serde_json::to_string(&node)
                .unwrap()
                .replace("[\"WEIGHT_SENTINEL\"]", &excessive),
            &data
        )
        .code,
        "model_structure_limit"
    );
    let mut duplicate = document.clone();
    let channel = duplicate["animations"][0]["channels"][0].clone();
    duplicate["animations"][0]["channels"]
        .as_array_mut()
        .unwrap()
        .push(channel);
    assert!(error(&duplicate, &data).message.contains("duplicate"));
    let mut across = document.clone();
    let clip = across["animations"][0].clone();
    across["animations"].as_array_mut().unwrap().push(clip);
    inspect(&across, &data);
    let mut shared = document.clone();
    shared["meshes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"primitives":[{"attributes":{"POSITION":0},"targets":[{}]}]}));
    shared["nodes"][1]["mesh"] = json!(1);
    shared["animations"][0]["channels"]
        .as_array_mut()
        .unwrap()
        .push(json!({"sampler":0,"target":{"node":1,"path":"weights"}}));
    assert_eq!(error(&shared, &data).code, "invalid_model_structure");
    let mut ignored = document.clone();
    ignored["animations"][0]["channels"][0]["target"]
        .as_object_mut()
        .unwrap()
        .remove("node");
    ignored["accessors"][3]["type"] = json!("VEC2");
    ignored["accessors"][3]["count"] = json!(2);
    let checked = inspect(&ignored, &data);
    assert_eq!(
        checked.resource().structure.animations[0].duration_upper_bound,
        0.
    );
    ignored["animations"][0]["channels"][0]["target"]["node"] = Value::Null;
    assert_eq!(error(&ignored, &data).code, "invalid_model_structure");
}

#[test]
fn weights_scalar_flattening_covers_all_interpolations() {
    for interpolation in ["STEP", "LINEAR", "CUBICSPLINE"] {
        let values = if interpolation == "CUBICSPLINE" {
            vec![0., 0., -0.5, 1.75, 0., 0., 2., -2., 2., -1., 3., 4.]
        } else {
            vec![-0.5, 1.75, 2., -1.]
        };
        let (document, data) = weights_fixture(interpolation, &[0., 1.], &values);
        inspect(&document, &data);
        for count in [1, 3, 6, 8] {
            let mut wrong = document.clone();
            wrong["accessors"][3]["count"] = json!(count);
            assert_eq!(error(&wrong, &data).code, "invalid_model_structure");
        }
        let mut wrong = document.clone();
        wrong["accessors"][3]["type"] = json!("VEC2");
        wrong["accessors"][3]["count"] = json!(values.len() / 2);
        assert_eq!(error(&wrong, &data).code, "invalid_model_structure");
        let single_values = if interpolation == "CUBICSPLINE" {
            vec![0.; 6]
        } else {
            vec![-2., 5.]
        };
        let (single, data) = weights_fixture(interpolation, &[0.], &single_values);
        if interpolation == "CUBICSPLINE" {
            assert_eq!(error(&single, &data).code, "invalid_model_structure");
        } else {
            inspect(&single, &data);
        }
    }
}

#[test]
fn normalized_weights_remain_explicitly_unavailable() {
    for component in [5120, 5121, 5122, 5123] {
        let (mut document, data) = ordinary();
        document["accessors"][3]["componentType"] = json!(component);
        document["accessors"][3]["normalized"] = json!(true);
        let unavailable = error(&document, &data);
        assert_eq!(unavailable.code, "model_resource_unavailable");
        assert!(unavailable.message.contains("precision"));
        document["accessors"][3]["count"] = json!(3);
        assert_eq!(error(&document, &data).code, "invalid_model_structure");
        document["accessors"][3]["count"] = json!(4);
        document["accessors"][3]["normalized"] = json!(false);
        assert_eq!(error(&document, &data).code, "invalid_model_structure");
    }
}

#[test]
fn morph_and_weights_actual_values_must_be_finite() {
    let (document, data) = ordinary();
    for offset in [36, 52, 68, 80, 84, 88, 92] {
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let mut wrong = data.clone();
            wrong[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            assert_eq!(error(&document, &wrong).code, "invalid_model_binary");
        }
    }
    let (document, data) = weights_fixture(
        "CUBICSPLINE",
        &[0., 1.],
        &[0., 0., -0.5, 1.75, 0., 0., 2., -2., 2., -1., 3., 4.],
    );
    for index in 0..12 {
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let mut wrong = data.clone();
            wrong[80 + index * 4..84 + index * 4].copy_from_slice(&value.to_le_bytes());
            assert_eq!(error(&document, &wrong).code, "invalid_model_binary");
        }
    }
    let (mut document, mut data) = ordinary();
    data[36..40].copy_from_slice(&(-2_f32).to_le_bytes());
    assert_eq!(error(&document, &data).code, "invalid_model_binary");
    data[36..40].copy_from_slice(&(-1.2_f32).to_le_bytes());
    document["accessors"][1]["min"] = json!([-1.2, 0, 0]);
    inspect(&document, &data);
    for value in [-f32::MAX, f32::MAX] {
        data[80..84].copy_from_slice(&value.to_le_bytes());
        inspect(&document, &data);
    }
}

#[test]
fn morph_delta_roles_do_not_replace_base_or_timestamp_roles() {
    for (semantic, base) in [
        ("NORMAL", vec![0., 0., 1.]),
        ("COLOR_0", vec![0.2, 0.3, 0.4]),
    ] {
        let (mut document, mut data) = ordinary();
        let base_index = add_accessor(
            &mut document,
            &mut data,
            json!({"componentType":5126,"count":3,"type":"VEC3"}),
            &floats(&base.repeat(3)),
            None,
        );
        document["meshes"][0]["primitives"][0]["attributes"][semantic] = json!(base_index);
        document["meshes"][0]["primitives"][0]["targets"][0][semantic] = json!(1);
        inspect(&document, &data);
        // A distinct accessor with the same exact layout still owns the base role.
        let mut alias = document["accessors"][1].clone();
        alias.as_object_mut().unwrap().remove("min");
        alias.as_object_mut().unwrap().remove("max");
        let index = document["accessors"].as_array().unwrap().len();
        document["accessors"].as_array_mut().unwrap().push(alias);
        document["bufferViews"][1]["byteStride"] = json!(12);
        document["meshes"][0]["primitives"][0]["attributes"][semantic] = json!(index);
        assert_eq!(error(&document, &data).code, "invalid_model_binary");
    }
    let (mut document, mut data) = weights_fixture("STEP", &[0., 1.], &[2., -1.]);
    document["meshes"][0]["primitives"][0]["targets"] = json!([{}]);
    document["meshes"][0]["weights"] = json!([1]);
    document["nodes"][0]["weights"] = json!([1]);
    document["accessors"][3] = document["accessors"][2].clone();
    inspect(&document, &data);
    data[76..80].copy_from_slice(&0_f32.to_le_bytes());
    let error = error(&document, &data);
    assert_eq!(error.code, "invalid_model_binary");
    assert!(error.message.contains("timestamps"));
}

#[test]
fn morph_arrays_maps_and_global_totals_are_bounded() {
    let (mut document, data) = ordinary();
    without_animation(&mut document);
    document["meshes"][0]
        .as_object_mut()
        .unwrap()
        .remove("weights");
    document["nodes"] = json!([]);
    document["meshes"][0]["primitives"][0]["targets"] = json!(vec![json!({}); MAX_MODEL_RECORDS]);
    inspect(&document, &data);
    let text = serde_json::to_string(&document).unwrap();
    let empty_targets = format!("[{}]", vec!["{}"; MAX_MODEL_RECORDS].join(","));
    let excessive_targets = format!("[{},null]", vec!["{}"; MAX_MODEL_RECORDS].join(","));
    assert_eq!(
        raw_error(&text.replace(&empty_targets, &excessive_targets), &data).code,
        "model_structure_limit"
    );
    let (document, data) = ordinary();
    for field in ["weights", "targets"] {
        let marker = if field == "weights" {
            json!(["WEIGHT_SENTINEL"])
        } else {
            json!(["TARGET_SENTINEL"])
        };
        let mut raw = document.clone();
        raw["meshes"][0][if field == "weights" {
            "weights"
        } else {
            "primitives"
        }] = if field == "weights" {
            marker.clone()
        } else {
            json!([{"attributes":{"POSITION":0},"targets":marker}])
        };
        let text = serde_json::to_string(&raw).unwrap();
        let item = if field == "weights" { "0" } else { "{}" };
        let placeholder = if field == "weights" {
            "[\"WEIGHT_SENTINEL\"]"
        } else {
            "[\"TARGET_SENTINEL\"]"
        };
        let replacement = format!(
            "[{},{{\"invalid\":[]}}]",
            vec![item; MAX_MODEL_RECORDS].join(",")
        );
        assert_eq!(
            raw_error(&text.replace(placeholder, &replacement), &data).code,
            "model_structure_limit"
        );
    }
    let (mut document, data) = ordinary();
    without_animation(&mut document);
    document["meshes"][0]
        .as_object_mut()
        .unwrap()
        .remove("weights");
    document["nodes"] = json!([]);
    let mut attributes = serde_json::Map::new();
    attributes.insert("POSITION".into(), json!(0));
    for index in 0..31 {
        attributes.insert(format!("_X{index}"), json!(0));
    }
    document["meshes"][0]["primitives"][0]["attributes"] = Value::Object(attributes.clone());
    document["meshes"][0]["primitives"][0]["targets"] =
        json!(vec![Value::Object(attributes.clone()); 512]);
    inspect(&document, &data);
    document["meshes"][0]["primitives"][0]["targets"]
        .as_array_mut()
        .unwrap()
        .push(json!({"POSITION":0}));
    structure_limit_before_bin(&document, &data);
    let (mut document, data) = ordinary();
    without_animation(&mut document);
    document["meshes"][0]
        .as_object_mut()
        .unwrap()
        .remove("weights");
    document["nodes"] = json!([]);
    let primitive = json!({"attributes":{"POSITION":0},"targets":vec![json!({});8192]});
    document["meshes"][0]["primitives"] = json!([primitive.clone(), primitive]);
    inspect(&document, &data);
    document["meshes"][0]["primitives"]
        .as_array_mut()
        .unwrap()
        .push(json!({"attributes":{"POSITION":0},"targets":[{}]}));
    structure_limit_before_bin(&document, &data);
    let (mut document, data) = ordinary();
    without_animation(&mut document);
    document["meshes"][0]["primitives"][0]["targets"] = json!(vec![json!({}); 8192]);
    document["meshes"][0]["weights"] = json!(vec![0.; 8192]);
    document["nodes"] = json!([{"mesh":0,"weights":vec![0.;8192]}]);
    inspect(&document, &data);
    document["nodes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"mesh":0,"weights":[0]}));
    structure_limit_before_bin(&document, &data);
    let (document, data) = ordinary();
    let text = serde_json::to_string(&document).unwrap();
    for original in [
        "\"attributes\":{\"POSITION\":0}",
        "\"targets\":[{\"POSITION\":1},{}]",
    ] {
        let duplicate = if original.starts_with("\"attributes") {
            "\"attributes\":{\"POSITION\":0,\"POSITION\":0}"
        } else {
            "\"targets\":[{\"POSITION\":1,\"POSITION\":1},{}]"
        };
        assert!(text.contains(original));
        assert_eq!(
            raw_error(&text.replace(original, duplicate), &data).code,
            "invalid_model_container"
        );
    }
    let extra = format!(
        "{{{},\"_EXTRA\":{{\"bad\":[]}}}}",
        (0..32)
            .map(|i| format!("\"_X{i}\":0"))
            .collect::<Vec<_>>()
            .join(",")
    );
    let excessive = text.replace("{\"POSITION\":1}", &extra);
    assert_eq!(raw_error(&excessive, &data).code, "model_structure_limit");
    let long = text.replace("{\"POSITION\":1}", &format!("{{\"{}\":1}}", "_".repeat(65)));
    assert_eq!(raw_error(&long, &data).code, "model_structure_limit");
    let (mut document, data) = ordinary();
    let name = "_".repeat(64);
    document["meshes"][0]["primitives"][0]["attributes"][&name] = json!(0);
    document["meshes"][0]["primitives"][0]["targets"][0][&name] = json!(0);
    inspect(&document, &data);
}

fn structure_limit_before_bin(document: &Value, data: &[u8]) {
    let prefix = prefix_raw(&serde_json::to_vec(document).unwrap(), data.len());
    let declared = prefix.len() as u64 + data.len() as u64;
    let mut reader = ZeroTail {
        prefix,
        length: declared,
        offset: 0,
        bin_read: 0,
    };
    assert_eq!(
        inspect_glb_resource_content(&mut reader, declared, &manifest(), "assets/model.glb")
            .unwrap_err()
            .code,
        "model_structure_limit"
    );
    assert_eq!(reader.bin_read, 0);
}

struct ZeroTail {
    prefix: Vec<u8>,
    length: u64,
    offset: u64,
    bin_read: u64,
}
impl Read for ZeroTail {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let count = (self.length - self.offset).min(output.len() as u64) as usize;
        let prefix_left = (self.prefix.len() as u64)
            .saturating_sub(self.offset)
            .min(count as u64) as usize;
        if prefix_left > 0 {
            output[..prefix_left]
                .copy_from_slice(&self.prefix[self.offset as usize..][..prefix_left]);
        }
        output[prefix_left..count].fill(0);
        self.offset += count as u64;
        self.bin_read += (count - prefix_left) as u64;
        Ok(count)
    }
}

#[test]
fn morph_numeric_work_is_rejected_before_bin_read() {
    let count = 6000;
    let length = count * 12 + 2800 * 4;
    let mut document = json!({"asset":{"version":"2.0"},"buffers":[{"byteLength":length}],"bufferViews":[{"buffer":0,"byteLength":length,"byteStride":12}],
        "accessors":(0..2801).map(|i|json!({"bufferView":0,"byteOffset":i*4,"componentType":5126,"count":count,"type":"VEC3","min":[0,0,0],"max":[0,0,0]})).collect::<Vec<_>>(),
        "meshes":[{"primitives":[{"attributes":{"POSITION":0},"targets":(1..2801).map(|i|json!({"POSITION":i})).collect::<Vec<_>>()}]}]});
    for components in [false, true] {
        let bin_length = if components {
            let length = count * 64 + 700 * 4;
            document["buffers"][0]["byteLength"] = json!(count * 24 + length);
            document["bufferViews"] = json!([{"buffer":0,"byteLength":count*12},{"buffer":0,"byteOffset":count*12,"byteLength":count*12},{"buffer":0,"byteOffset":count*24,"byteLength":length}]);
            document["accessors"] = json!([{"bufferView":0,"componentType":5126,"count":count,"type":"VEC3","min":[0,0,0],"max":[0,0,0]},{"bufferView":1,"componentType":5126,"count":count,"type":"VEC3","min":[0,0,0],"max":[0,0,0]}]);
            for index in 0..700 {
                document["accessors"].as_array_mut().unwrap().push(json!({"bufferView":2,"byteOffset":index*4,"componentType":5126,"count":count,"type":"MAT4"}));
            }
            document["meshes"][0]["primitives"][0]["targets"] = json!([{"POSITION":1}]);
            count * 24 + length
        } else {
            length
        };
        let prefix = prefix_raw(&serde_json::to_vec(&document).unwrap(), bin_length);
        let declared = prefix.len() as u64 + bin_length as u64;
        let mut reader = ZeroTail {
            prefix,
            length: declared,
            offset: 0,
            bin_read: 0,
        };
        let error =
            inspect_glb_resource_content(&mut reader, declared, &manifest(), "assets/model.glb")
                .unwrap_err();
        assert_eq!(
            error.code, "model_binary_limit",
            "components={components}: {}",
            error.message
        );
        assert_eq!(reader.bin_read, 0);
    }
    let (mut document, data) = ordinary();
    let alias = document["accessors"][1].clone();
    document["accessors"].as_array_mut().unwrap().push(alias);
    document["bufferViews"][1]["byteStride"] = json!(12);
    document["meshes"][0]["primitives"][0]["targets"][1] = json!({"POSITION":4});
    let checked = inspect(&document, &data);
    assert_eq!(checked.unique_layouts(), 4);
    assert_eq!(checked.checked_elements(), 12);
}

struct ShortReader<'a> {
    cursor: Cursor<&'a [u8]>,
    bin_offset: u64,
    max_bin_request: usize,
}
impl Read for ShortReader<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if self.cursor.position() >= self.bin_offset {
            self.max_bin_request = self.max_bin_request.max(output.len());
        }
        let count = output.len().min(3);
        self.cursor.read(&mut output[..count])
    }
}

#[test]
fn morph_nonseekable_stream_keeps_window_hash_and_metadata_boundary() {
    let count = 5502;
    let mut data = floats(&vec![0.; count * 3]);
    data.extend(floats(&vec![1.2; count * 3]));
    data.extend([0; 8]);
    let document = json!({"asset":{"version":"2.0"},"buffers":[{"byteLength":data.len()}],"bufferViews":[{"buffer":0,"byteLength":count*12},{"buffer":0,"byteOffset":count*12,"byteLength":count*12}],"accessors":[{"bufferView":0,"componentType":5126,"count":count,"type":"VEC3","min":[0,0,0],"max":[0,0,0]},{"bufferView":1,"componentType":5126,"count":count,"type":"VEC3","min":[1.2,1.2,1.2],"max":[1.2,1.2,1.2]}],"meshes":[{"primitives":[{"attributes":{"POSITION":0},"targets":[{"POSITION":1},{}]}]}]});
    let bytes = glb(&document, &data);
    let offset = prefix_raw(&serde_json::to_vec(&document).unwrap(), data.len()).len() as u64;
    let mut reader = ShortReader {
        cursor: Cursor::new(&bytes),
        bin_offset: offset,
        max_bin_request: 0,
    };
    let checked = inspect_glb_resource_content(
        &mut reader,
        bytes.len() as u64,
        &manifest(),
        "assets/model.glb",
    )
    .unwrap();
    assert_eq!(checked.bytes(), bytes.len() as u64);
    assert_eq!(
        checked.sha256_hex(),
        format!("{:x}", Sha256::digest(&bytes))
    );
    assert!(reader.max_bin_request <= 65536);
    assert!(reader.max_bin_request > 0);
    let original = checked.sha256_hex();
    let last = data.len() - 1;
    data[last] = 1;
    assert_ne!(inspect(&document, &data).sha256_hex(), original);
    let truncated = &bytes[..bytes.len() - 1];
    assert!(inspect_glb_resource_content(
        Cursor::new(truncated),
        bytes.len() as u64,
        &manifest(),
        "assets/model.glb"
    )
    .is_err());
    data[count * 12..count * 12 + 4].copy_from_slice(&f32::NAN.to_le_bytes());
    let wrong = glb(&document, &data);
    let metadata = inspect_glb_resource(
        Cursor::new(&wrong),
        wrong.len() as u64,
        &manifest(),
        "assets/model.glb",
    )
    .unwrap();
    assert!(!metadata.structure.binary_content_validated);
    assert_eq!(error(&document, &data).code, "invalid_model_binary");
}

fn ktx2() -> Vec<u8> {
    let mut bytes = vec![0; 196];
    bytes[..12].copy_from_slice(&[
        0xab, b'K', b'T', b'X', b' ', b'2', b'0', 0xbb, 13, 10, 26, 10,
    ]);
    for (offset, value) in [
        (12, 37_u32),
        (16, 1),
        (20, 4),
        (24, 4),
        (36, 1),
        (40, 1),
        (48, 104),
        (52, 28),
        (104, 28),
    ] {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    for (offset, value) in [(80, 132_u64), (88, 64), (96, 64)] {
        bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }
    bytes
}

fn package(
    model: &[u8],
    variant: bool,
    wrong_hash: bool,
    role_collision: bool,
) -> (Vec<u8>, Manifest) {
    let path = if variant {
        "assets/low.glb"
    } else {
        "assets/model.glb"
    };
    let mut files = vec![(
        path,
        if role_collision {
            ktx2()
        } else {
            model.to_vec()
        },
    )];
    if variant {
        files.push((
            "assets/model.glb",
            glb(&json!({"asset":{"version":"2.0"}}), &[]),
        ));
    }
    let mut document = serde_json::to_value(manifest()).unwrap();
    document["assets"] = if variant {
        json!([{"id":"model","kind":"model","source":"assets/model.glb","variants":[{"id":"low","file":path,"purpose":"low"}]}])
    } else {
        json!([{"id":"model","kind":"model","source":path,"variants":[]}])
    };
    if role_collision {
        document["assets"].as_array_mut().unwrap().insert(
            0,
            json!({"id":"texture","kind":"texture","source":path,"variants":[]}),
        );
    }
    document["files"]=json!(files.iter().map(|(file_path,data)|json!({"path":file_path,"bytes":data.len(),"sha256":if wrong_hash {"0".repeat(64)} else {format!("{:x}",Sha256::digest(data))},"mime":if role_collision && *file_path == path {"image/ktx2"} else {"model/gltf-binary"}})).collect::<Vec<_>>());
    let parsed = serde_json::from_value(document.clone()).unwrap();
    files.push(("manifest.json", serde_json::to_vec(&document).unwrap()));
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (path, data) in files {
        writer
            .start_file(path, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(&data).unwrap();
    }
    (writer.finish().unwrap().into_inner(), parsed)
}

#[test]
fn both_package_entries_check_source_and_variant_morph_values() {
    let (document, data) = ordinary();
    for variant in [false, true] {
        let (bytes, parsed) = package(&glb(&document, &data), variant, false, false);
        validate_package(Cursor::new(&bytes)).unwrap();
        validate_archive(Cursor::new(&bytes), &parsed).unwrap();
        for failure in ["delta", "weight_tangent", "reference"] {
            let (mut wrong, mut binary) = if failure == "weight_tangent" {
                weights_fixture("CUBICSPLINE", &[0., 1.], &[0.; 12])
            } else {
                (document.clone(), data.clone())
            };
            let expected = if failure == "reference" {
                wrong["meshes"][0]["primitives"][0]["targets"][0]["POSITION"] = json!(999);
                "invalid_model_structure"
            } else {
                let offset = if failure == "delta" { 36 } else { 80 };
                binary[offset..offset + 4].copy_from_slice(&f32::INFINITY.to_le_bytes());
                "invalid_model_binary"
            };
            let (bytes, parsed) = package(&glb(&wrong, &binary), variant, false, false);
            for error in [
                validate_package(Cursor::new(&bytes)).unwrap_err(),
                validate_archive(Cursor::new(&bytes), &parsed).unwrap_err(),
            ] {
                assert_eq!(error.code, expected);
                assert!(error.message.contains(if variant {
                    "assets/low.glb"
                } else {
                    "assets/model.glb"
                }));
            }
            let (bytes, parsed) = package(&glb(&wrong, &binary), variant, true, false);
            assert_eq!(
                validate_package(Cursor::new(&bytes)).unwrap_err().code,
                "hash_mismatch"
            );
            assert_eq!(
                validate_archive(Cursor::new(&bytes), &parsed)
                    .unwrap_err()
                    .code,
                "hash_mismatch"
            );
        }
        let (bytes, parsed) = package(&glb(&document, &data), variant, false, true);
        let error = validate_package(Cursor::new(&bytes)).unwrap_err();
        assert_eq!(error.code, "model_container_unavailable");
        assert!(error.message.contains(if variant {
            "assets/low.glb"
        } else {
            "assets/model.glb"
        }));
        let error = validate_archive(Cursor::new(&bytes), &parsed).unwrap_err();
        assert_eq!(error.code, "model_container_unavailable");
        assert!(error.message.contains(if variant {
            "assets/low.glb"
        } else {
            "assets/model.glb"
        }));
    }
}
