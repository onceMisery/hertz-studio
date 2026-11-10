// SPDX-License-Identifier: MIT
//! Actual normalized integer animation storage, raw aliases and package boundaries.

use std::io::{self, Cursor, Read, Write};

use hertz_wallpaper::{
    model_binary::{inspect_glb_resource_content, CheckedGlbResource},
    model_structure::inspect_glb_resource,
    validate_archive, validate_package, Manifest, PackageError,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn manifest() -> Manifest {
    serde_json::from_value(json!({"formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae","version":1,"title":"Normalized animation",
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
fn packed(component: u32, values: &[i32]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|&value| match component {
            5120 => i8::try_from(value).unwrap().to_le_bytes().to_vec(),
            5121 => u8::try_from(value).unwrap().to_le_bytes().to_vec(),
            5122 => i16::try_from(value).unwrap().to_le_bytes().to_vec(),
            5123 => u16::try_from(value).unwrap().to_le_bytes().to_vec(),
            _ => panic!("fixture requires a normalized integer component"),
        })
        .collect()
}
fn denominator(component: u32) -> i32 {
    match component {
        5120 => 127,
        5121 => 255,
        5122 => 32767,
        5123 => 65535,
        _ => panic!("unsupported fixture component"),
    }
}
fn minimum(component: u32) -> i32 {
    match component {
        5120 => -128,
        5122 => -32768,
        _ => 0,
    }
}
fn prefix(document: &Value, bin_bytes: usize) -> Vec<u8> {
    let mut text = serde_json::to_vec(document).unwrap();
    while text.len() % 4 != 0 {
        text.push(b' ');
    }
    let length = bin_bytes.div_ceil(4) * 4;
    let mut bytes = b"glTF".to_vec();
    bytes.extend(2_u32.to_le_bytes());
    bytes.extend((28_u32 + text.len() as u32 + length as u32).to_le_bytes());
    bytes.extend((text.len() as u32).to_le_bytes());
    bytes.extend(b"JSON");
    bytes.extend(text);
    bytes.extend((length as u32).to_le_bytes());
    bytes.extend([b'B', b'I', b'N', 0]);
    bytes
}
fn glb(document: &Value, data: &[u8]) -> Vec<u8> {
    let mut bytes = prefix(document, data.len());
    bytes.extend(data);
    bytes.resize(bytes.len() + data.len().div_ceil(4) * 4 - data.len(), 0);
    bytes
}
fn add_accessor(
    document: &mut Value,
    data: &mut Vec<u8>,
    mut accessor: Value,
    block: &[u8],
) -> usize {
    while data.len() % 4 != 0 {
        data.push(0);
    }
    let views = document["bufferViews"].as_array_mut().unwrap();
    accessor["bufferView"] = json!(views.len());
    views.push(json!({"buffer":0,"byteOffset":data.len(),"byteLength":block.len()}));
    data.extend(block);
    document["buffers"][0]["byteLength"] = json!(data.len());
    let accessors = document["accessors"].as_array_mut().unwrap();
    let index = accessors.len();
    accessors.push(accessor);
    index
}
fn fixture_bytes(
    component: u32,
    path: &str,
    interpolation: &str,
    times: &[f32],
    count: usize,
    output: &[u8],
) -> (Value, Vec<u8>) {
    let mut data = floats(times);
    data.extend(output);
    let mut document = json!({"asset":{"version":"2.0"},"buffers":[{"byteLength":data.len()}],
        "bufferViews":[{"buffer":0,"byteLength":times.len()*4},{"buffer":0,"byteOffset":times.len()*4,"byteLength":output.len()}],
        "accessors":[{"bufferView":0,"componentType":5126,"count":times.len(),"type":"SCALAR","min":[times[0]],"max":[times[times.len()-1]]},
            {"bufferView":1,"componentType":component,"normalized":true,"count":count,"type":if path=="rotation" {"VEC4"} else {"SCALAR"}}],
        "nodes":[{}],"animations":[{"samplers":[{"input":0,"output":1,"interpolation":interpolation}],
            "channels":[{"sampler":0,"target":{"node":0,"path":path}}]}]});
    if path == "weights" {
        let position = add_accessor(
            &mut document,
            &mut data,
            json!({"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]}),
            &floats(&[0., 0., 0., 1., 0., 0., 0., 1., 0.]),
        );
        document["meshes"] = json!([{"primitives":[{"attributes":{"POSITION":position},"targets":[{},{}]}],"weights":[-0.5,2]}]);
        document["nodes"] = json!([{"mesh":0,"weights":[2,-1]}]);
    }
    (document, data)
}
fn fixture(
    component: u32,
    path: &str,
    interpolation: &str,
    times: &[f32],
    values: &[i32],
) -> (Value, Vec<u8>) {
    let count = values.len() / if path == "rotation" { 4 } else { 1 };
    fixture_bytes(
        component,
        path,
        interpolation,
        times,
        count,
        &packed(component, values),
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
fn assert_failure(document: &Value, data: &[u8], code: &str, message: &str) {
    let error = error(document, data);
    assert_eq!(error.code, code, "{}", error.message);
    assert!(error.message.contains(message), "{}", error.message);
}

#[test]
fn all_twenty_four_normalized_storage_combinations_keep_duration_hash_and_defaults() {
    let mut combinations = 0;
    for component in [5120, 5121, 5122, 5123] {
        for path in ["rotation", "weights"] {
            for interpolation in ["STEP", "LINEAR", "CUBICSPLINE"] {
                let high = denominator(component);
                let key = if path == "rotation" {
                    vec![0, 0, 0, high]
                } else if minimum(component) == 0 {
                    vec![high, high]
                } else {
                    vec![minimum(component), high]
                };
                let mut values = Vec::new();
                for _ in 0..2 {
                    if interpolation == "CUBICSPLINE" {
                        values.extend(vec![high; key.len()]);
                    }
                    values.extend(&key);
                    if interpolation == "CUBICSPLINE" {
                        values.extend(vec![0; key.len()]);
                    }
                }
                let (document, data) = fixture(component, path, interpolation, &[0., 1.], &values);
                let checked = inspect(&document, &data);
                let bytes = glb(&document, &data);
                let metadata = inspect_glb_resource(
                    Cursor::new(&bytes),
                    bytes.len() as u64,
                    &manifest(),
                    "assets/model.glb",
                )
                .unwrap();
                assert!(!metadata.structure.binary_content_validated);
                assert_eq!(
                    checked.resource().structure.animations[0].duration_upper_bound,
                    1.
                );
                assert!(!checked.resource().structure.binary_content_validated);
                assert_eq!(
                    checked.sha256_hex(),
                    format!("{:x}", Sha256::digest(glb(&document, &data)))
                );
                if path == "weights" {
                    assert_eq!(
                        checked.resource().structure.node_morph_weights,
                        vec![Some(vec![2., -1.])]
                    );
                    assert_eq!(
                        checked.resource().structure.meshes[0].default_weights,
                        Some(vec![-0.5, 2.])
                    );
                }
                combinations += 1;
            }
        }
    }
    assert_eq!(combinations, 24);
}

#[test]
fn signed_redundant_endpoints_are_unit_but_bounds_stay_raw_for_every_alias_order() {
    for (component, low, negative_max) in [(5120, -128, -127), (5122, -32768, -32767)] {
        let (mut document, data) = fixture(
            component,
            "rotation",
            "LINEAR",
            &[0., 1.],
            &[0, 0, 0, low, 0, 0, 0, negative_max],
        );
        document["accessors"][1]["min"] = json!([0, 0, 0, low]);
        document["accessors"][1]["max"] = json!([0, 0, 0, negative_max]);
        inspect(&document, &data);
        for raw_first in [false, true] {
            let mut aliased = document.clone();
            let mut raw = aliased["accessors"][1].clone();
            raw["normalized"] = json!(false);
            if raw_first {
                aliased["accessors"].as_array_mut().unwrap().insert(1, raw);
                aliased["animations"][0]["samplers"][0]["output"] = json!(2);
            } else {
                aliased["accessors"].as_array_mut().unwrap().push(raw);
            }
            let checked = inspect(&aliased, &data);
            assert_eq!(checked.unique_layouts(), 2);
            assert_eq!(checked.checked_elements(), 4);
            assert_eq!(checked.checked_components(), 10);
            let raw_index = if raw_first { 1 } else { 2 };
            aliased["accessors"][raw_index]["max"] = json!([0, 0, 0, low]);
            assert_failure(&aliased, &data, "invalid_model_binary", "max");
            aliased["accessors"][raw_index]["max"] = json!([0, 0, 0, negative_max]);
            let used_index = if raw_first { 2 } else { 1 };
            aliased["accessors"][used_index]["min"] = json!([0, 0, 0, -1]);
            aliased["accessors"][used_index]["max"] = json!([0, 0, 0, -1]);
            assert_failure(&aliased, &data, "invalid_model_binary", "min");
        }
    }
}

#[test]
fn quantized_quaternions_keep_the_original_squared_length_tolerance() {
    for (component, key) in [
        (5120, [90, 90, 0, 0]),
        (5120, [0, 0, 0, 126]),
        (5121, [0, 0, 0, 0]),
        (5121, [255, 255, 0, 0]),
        (5123, [0, 0, 0, 0]),
        (5123, [65535, 65535, 0, 0]),
    ] {
        let values = [key, key].concat();
        let (document, data) = fixture(component, "rotation", "LINEAR", &[0., 1.], &values);
        assert_failure(&document, &data, "invalid_model_binary", "unit quaternion");
    }
    let (document, data) = fixture(
        5122,
        "rotation",
        "LINEAR",
        &[0., 1.],
        &[23170, 23170, 0, 0, 23170, 23170, 0, 0],
    );
    inspect(&document, &data);
}

#[test]
fn cubic_value_roles_and_linear_alias_roles_are_combined_in_either_clip_order() {
    for component in [5120, 5121, 5122, 5123] {
        let high = denominator(component);
        let values = [
            vec![high; 4],
            vec![0, 0, 0, high],
            vec![0; 4],
            vec![high; 4],
            vec![0, 0, 0, high],
            vec![high; 4],
        ]
        .concat();
        let (document, data) = fixture(component, "rotation", "CUBICSPLINE", &[0., 1.], &values);
        inspect(&document, &data);
        let mut wrong = data.clone();
        let width = if component < 5122 { 1 } else { 2 };
        wrong[8 + 4 * width..8 + 8 * width].copy_from_slice(&packed(component, &[0; 4]));
        assert_failure(&document, &wrong, "invalid_model_binary", "unit quaternion");
        for linear_first in [false, true] {
            let mut aliased = document.clone();
            let mut bytes = data.clone();
            let output = aliased["accessors"].as_array_mut().unwrap().len();
            let alias = aliased["accessors"][1].clone();
            aliased["accessors"].as_array_mut().unwrap().push(alias);
            let input = add_accessor(
                &mut aliased,
                &mut bytes,
                json!({"componentType":5126,"count":6,"type":"SCALAR","min":[0],"max":[5]}),
                &floats(&[0., 1., 2., 3., 4., 5.]),
            );
            let linear = json!({"samplers":[{"input":input,"output":output,"interpolation":"LINEAR"}],"channels":[{"sampler":0,"target":{"node":0,"path":"rotation"}}]});
            if linear_first {
                aliased["animations"]
                    .as_array_mut()
                    .unwrap()
                    .insert(0, linear);
            } else {
                aliased["animations"].as_array_mut().unwrap().push(linear);
            }
            assert_failure(&aliased, &bytes, "invalid_model_binary", "unit quaternion");
            bytes[8..8 + 24 * width]
                .copy_from_slice(&packed(component, &vec![vec![0, 0, 0, high]; 6].concat()));
            assert_eq!(inspect(&aliased, &bytes).unique_layouts(), 3);
        }
    }
}

#[test]
fn normalized_component_property_shape_and_exact_counts_are_structural_requirements() {
    for component in [5120, 5121, 5122, 5123] {
        for path in ["rotation", "weights"] {
            let values = if path == "rotation" {
                vec![
                    0,
                    0,
                    0,
                    denominator(component),
                    0,
                    0,
                    0,
                    denominator(component),
                ]
            } else {
                vec![0; 4]
            };
            let (document, data) = fixture(component, path, "LINEAR", &[0., 1.], &values);
            let mut wrong = document.clone();
            wrong["accessors"][1]["normalized"] = json!(false);
            assert_failure(&wrong, &data, "invalid_model_structure", "component type");
            for property in ["translation", "scale"] {
                let mut wrong = document.clone();
                wrong["accessors"][1]["type"] = json!("VEC3");
                wrong["accessors"][1]["count"] = json!(2);
                // Six actual components keep the declared VEC3 range valid.
                let (mut shaped, binary) = fixture(component, path, "LINEAR", &[0., 1.], &[0; 6]);
                shaped["accessors"][1] = wrong["accessors"][1].clone();
                shaped["animations"][0]["channels"][0]["target"]["path"] = json!(property);
                assert_failure(
                    &shaped,
                    &binary,
                    "invalid_model_structure",
                    "component type",
                );
            }
            let mut wrong = document.clone();
            wrong["accessors"][1]["type"] = json!("VEC2");
            wrong["accessors"][1]["count"] = json!(values.len() / 2);
            assert_failure(&wrong, &data, "invalid_model_structure", "shape");
            let mut wrong = document.clone();
            wrong["accessors"][1]["count"] = json!(1);
            assert_failure(&wrong, &data, "invalid_model_structure", "count");
        }
        let (good, data) = fixture(component, "weights", "CUBICSPLINE", &[0., 1.], &[0; 12]);
        inspect(&good, &data);
        for count in [4, 6, 11, 13] {
            let (wrong, data) = fixture(
                component,
                "weights",
                "CUBICSPLINE",
                &[0., 1.],
                &vec![0; count],
            );
            assert_failure(&wrong, &data, "invalid_model_structure", "count");
        }
        let (wrong, data) = fixture(component, "weights", "CUBICSPLINE", &[0.], &[0; 6]);
        assert_failure(&wrong, &data, "invalid_model_structure", "at least two");
        let (wrong, data) = fixture(component, "rotation", "CUBICSPLINE", &[0.], &[0; 12]);
        assert_failure(&wrong, &data, "invalid_model_structure", "at least two");
    }
    for path in ["rotation", "weights"] {
        let count = if path == "rotation" { 2 } else { 4 };
        let components = if path == "rotation" { 8 } else { 4 };
        let output = vec![0_u32; components]
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect::<Vec<_>>();
        let (mut document, data) = fixture_bytes(5125, path, "LINEAR", &[0., 1.], count, &output);
        document["accessors"][1]["normalized"] = json!(false);
        assert_failure(
            &document,
            &data,
            "invalid_model_structure",
            "component type",
        );
        let (document, data) = fixture_bytes(
            5126,
            path,
            "LINEAR",
            &[0., 1.],
            count,
            &floats(&vec![0.; components]),
        );
        assert_failure(&document, &data, "invalid_model_structure", "normalized");
    }
}

#[test]
fn ignored_normalized_outputs_still_preserve_references_and_every_float_scan() {
    let (mut document, mut data) = fixture(5120, "rotation", "LINEAR", &[0., 1.], &[0; 8]);
    document["animations"][0]["channels"][0]["target"]
        .as_object_mut()
        .unwrap()
        .remove("node");
    document["accessors"][1]["type"] = json!("SCALAR");
    document["accessors"][1]["count"] = json!(8);
    assert_eq!(
        inspect(&document, &data).resource().structure.animations[0].duration_upper_bound,
        0.
    );
    let mut wrong = document.clone();
    wrong["animations"][0]["channels"][0]["target"]["node"] = Value::Null;
    assert_eq!(error(&wrong, &data).code, "invalid_model_structure");
    for (object, field) in [
        ("samplers", "input"),
        ("samplers", "output"),
        ("channels", "sampler"),
    ] {
        let mut wrong = document.clone();
        wrong["animations"][0][object][0][field] = json!(999);
        assert_eq!(error(&wrong, &data).code, "invalid_model_structure");
    }
    for time in [0_f32, f32::NAN] {
        let mut wrong = data.clone();
        wrong[4..8].copy_from_slice(&time.to_le_bytes());
        assert_eq!(error(&document, &wrong).code, "invalid_model_binary");
    }
    add_accessor(
        &mut document,
        &mut data,
        json!({"componentType":5126,"count":1,"type":"SCALAR"}),
        &floats(&[f32::NAN]),
    );
    assert_failure(&document, &data, "invalid_model_binary", "NaN");
}

#[test]
fn normalized_weights_alias_keeps_raw_index_limits_on_an_independent_view() {
    let (mut document, data) = fixture(5121, "weights", "LINEAR", &[0., 1., 2.], &[0, 1, 2]);
    document["meshes"][0]["primitives"][0]["targets"] = json!([{}]);
    document["meshes"][0]["weights"] = json!([2]);
    document["nodes"][0]["weights"] = json!([-1]);
    let view = document["bufferViews"][1].clone();
    document["bufferViews"].as_array_mut().unwrap().push(view);
    document["accessors"].as_array_mut().unwrap().push(
        json!({"bufferView":3,"componentType":5121,"count":3,"type":"SCALAR","min":[0],"max":[2]}),
    );
    document["meshes"][0]["primitives"][0]["indices"] = json!(3);
    let checked = inspect(&document, &data);
    assert_eq!(checked.unique_layouts(), 3);
    let mut wrong = data;
    wrong[14] = 3;
    assert_failure(&document, &wrong, "invalid_model_binary", "index");
}

#[test]
fn normalized_rotation_alias_keeps_color_view_rules_and_independent_raw_bounds() {
    let (mut document, mut data) = fixture(
        5121,
        "rotation",
        "LINEAR",
        &[0., 1., 2.],
        &[0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255],
    );
    document["accessors"][1]["min"] = json!([0, 0, 0, 255]);
    document["accessors"][1]["max"] = json!([0, 0, 0, 255]);
    let position = add_accessor(
        &mut document,
        &mut data,
        json!({"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]}),
        &floats(&[0., 0., 0., 1., 0., 0., 0., 1., 0.]),
    );
    let view = document["bufferViews"][1].clone();
    document["bufferViews"].as_array_mut().unwrap().push(view);
    let mut color = document["accessors"][1].clone();
    document["bufferViews"][3]["byteStride"] = json!(4);
    color["bufferView"] = json!(3);
    document["accessors"].as_array_mut().unwrap().push(color);
    document["meshes"] = json!([{"primitives":[{"attributes":{"POSITION":position,"COLOR_0":3}}]}]);
    assert_eq!(inspect(&document, &data).unique_layouts(), 3);
    document["accessors"][3]["min"] = json!([0, 0, 0, 254]);
    assert_failure(&document, &data, "invalid_model_binary", "min");
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
fn signed_short_rotation_crosses_the_fixed_window_on_a_nonseekable_three_byte_stream() {
    let (mut document, original) = fixture(
        5122,
        "rotation",
        "LINEAR",
        &[0., 1.],
        &[0, 0, 0, -32768, 0, 0, 0, -32767],
    );
    let mut data = original[..8].to_vec();
    data.resize(65534, 0);
    data.extend(&original[8..]);
    data.extend([0; 6]);
    document["buffers"][0]["byteLength"] = json!(data.len());
    document["bufferViews"][1]["byteOffset"] = json!(65534);
    document["accessors"][1]["min"] = json!([0, 0, 0, -32768]);
    document["accessors"][1]["max"] = json!([0, 0, 0, -32767]);
    let bytes = glb(&document, &data);
    let mut reader = ShortReader {
        cursor: Cursor::new(&bytes),
        bin_offset: prefix(&document, data.len()).len() as u64,
        max_bin_request: 0,
    };
    let checked = inspect_glb_resource_content(
        &mut reader,
        bytes.len() as u64,
        &manifest(),
        "assets/model.glb",
    )
    .unwrap();
    assert_eq!(
        checked.sha256_hex(),
        format!("{:x}", Sha256::digest(&bytes))
    );
    assert_eq!(checked.bytes(), bytes.len() as u64);
    assert!(!checked.resource().structure.binary_content_validated);
    assert!(reader.max_bin_request > 0 && reader.max_bin_request <= 65536);
    let mut cross_key = data.clone();
    cross_key[65534..65542].fill(0);
    assert_failure(
        &document,
        &cross_key,
        "invalid_model_binary",
        "unit quaternion",
    );
    let last = data.len() - 1;
    data[last] = 1;
    assert_ne!(inspect(&document, &data).sha256_hex(), checked.sha256_hex());
    assert!(inspect_glb_resource_content(
        Cursor::new(&bytes[..bytes.len() - 1]),
        bytes.len() as u64,
        &manifest(),
        "assets/model.glb"
    )
    .is_err());
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
fn normalized_animation_does_not_bypass_either_unique_numeric_budget_before_bin() {
    for components in [false, true] {
        let (mut document, mut data) = fixture(
            5120,
            "rotation",
            "LINEAR",
            &[0., 1.],
            &[0, 0, 0, 127, 0, 0, 0, 127],
        );
        let count = 6000;
        let layouts = if components { 700 } else { 2800 };
        let element_bytes = if components { 64 } else { 4 };
        let offset = data.len();
        let length = count * element_bytes + (layouts - 1) * 4;
        data.resize(offset + length, 0);
        document["buffers"][0]["byteLength"] = json!(data.len());
        document["bufferViews"]
            .as_array_mut()
            .unwrap()
            .push(json!({"buffer":0,"byteOffset":offset,"byteLength":length}));
        for index in 0..layouts {
            document["accessors"].as_array_mut().unwrap().push(json!({"bufferView":2,"byteOffset":index*4,"componentType":5126,"count":count,"type":if components {"MAT4"} else {"SCALAR"}}));
        }
        assert!(serde_json::to_vec(&document).unwrap().len() < 4 * 1024 * 1024);
        let prefix = prefix(&document, data.len());
        let declared = prefix.len() as u64 + data.len() as u64;
        let mut reader = ZeroTail {
            prefix,
            length: declared,
            offset: 0,
            bin_read: 0,
        };
        let failure =
            inspect_glb_resource_content(&mut reader, declared, &manifest(), "assets/model.glb")
                .unwrap_err();
        assert_eq!(
            failure.code, "model_binary_limit",
            "components={components}: {}",
            failure.message
        );
        assert_eq!(reader.bin_read, 0);
    }
    let (mut document, data) = fixture(
        5120,
        "rotation",
        "LINEAR",
        &[0., 1.],
        &[0, 0, 0, 127, 0, 0, 0, 127],
    );
    let alias = document["accessors"][1].clone();
    for _ in 0..2800 {
        document["accessors"]
            .as_array_mut()
            .unwrap()
            .push(alias.clone());
    }
    let checked = inspect(&document, &data);
    assert_eq!(checked.unique_layouts(), 2);
    assert_eq!(checked.checked_elements(), 4);
    assert_eq!(checked.checked_components(), 10);
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
    let (valid_document, valid_data) = fixture(
        5120,
        "rotation",
        "LINEAR",
        &[0., 1.],
        &[0, 0, 0, -128, 0, 0, 0, -127],
    );
    let mut files = vec![(
        path,
        if role_collision {
            ktx2()
        } else {
            model.to_vec()
        },
    )];
    if variant {
        files.push(("assets/model.glb", glb(&valid_document, &valid_data)));
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
    document["files"] = json!(files.iter().map(|(file_path,data)|json!({"path":file_path,"bytes":data.len(),"sha256":if wrong_hash {"0".repeat(64)} else {format!("{:x}",Sha256::digest(data))},"mime":if role_collision && *file_path==path {"image/ktx2"} else {"model/gltf-binary"}})).collect::<Vec<_>>());
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
fn both_public_zip_entries_validate_actual_normalized_source_and_variant_values() {
    let (document, data) = fixture(
        5120,
        "rotation",
        "LINEAR",
        &[0., 1.],
        &[0, 0, 0, -128, 0, 0, 0, -127],
    );
    for variant in [false, true] {
        let path = if variant {
            "assets/low.glb"
        } else {
            "assets/model.glb"
        };
        let (bytes, parsed) = package(&glb(&document, &data), variant, false, false);
        validate_package(Cursor::new(&bytes)).unwrap();
        validate_archive(Cursor::new(&bytes), &parsed).unwrap();
        for failure in ["quaternion", "bounds", "reference"] {
            let mut wrong = document.clone();
            let mut binary = data.clone();
            let expected = if failure == "reference" {
                wrong["animations"][0]["samplers"][0]["output"] = json!(999);
                "invalid_model_structure"
            } else {
                if failure == "quaternion" {
                    binary[8..12].fill(0);
                } else {
                    wrong["accessors"][1]["min"] = json!([0, 0, 0, -1]);
                    wrong["accessors"][1]["max"] = json!([0, 0, 0, -1]);
                }
                "invalid_model_binary"
            };
            let (bytes, parsed) = package(&glb(&wrong, &binary), variant, false, false);
            for failure in [
                validate_package(Cursor::new(&bytes)).unwrap_err(),
                validate_archive(Cursor::new(&bytes), &parsed).unwrap_err(),
            ] {
                assert_eq!(failure.code, expected);
                assert!(failure.message.contains(path), "{}", failure.message);
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
        for failure in [
            validate_package(Cursor::new(&bytes)).unwrap_err(),
            validate_archive(Cursor::new(&bytes), &parsed).unwrap_err(),
        ] {
            assert_eq!(failure.code, "model_container_unavailable");
            assert!(failure.message.contains(path));
        }
    }
}
