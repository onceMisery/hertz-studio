// SPDX-License-Identifier: MIT
//! Real GLB/ZIP numeric fixtures; no loader or GPU qualification is implied.

use std::io::{self, Cursor, Read, Write};

use hertz_wallpaper::{
    model_binary::{
        inspect_glb_resource_content, CheckedGlbResource, MAX_MODEL_VALIDATION_ELEMENTS,
    },
    model_structure::inspect_glb_resource,
    validate_archive, validate_package, Manifest,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn manifest() -> Manifest {
    serde_json::from_value(json!({"formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae","version":1,"title":"Numeric model",
        "content":{"kind":"builtin","sceneId":"zodiac","stateVersion":1,"params":{}},
        "assets":[],"files":[],"permissions":{"audioSpectrum":false,"pointer":false},
        "license":{"code":"none","assets":"CC0-1.0"}})).unwrap()
}
fn prefix(document: &Value, bin_bytes: usize) -> Vec<u8> {
    let mut text = serde_json::to_vec(document).unwrap();
    while !text.len().is_multiple_of(4) {
        text.push(b' ');
    }
    let mut bytes = b"glTF".to_vec();
    bytes.extend(2_u32.to_le_bytes());
    bytes.extend((28_u32 + text.len() as u32 + bin_bytes as u32).to_le_bytes());
    bytes.extend((text.len() as u32).to_le_bytes());
    bytes.extend(b"JSON");
    bytes.extend(text);
    bytes.extend((bin_bytes as u32).to_le_bytes());
    bytes.extend([b'B', b'I', b'N', 0]);
    bytes
}
fn glb(document: &Value, data: &[u8]) -> Vec<u8> {
    let length = data.len().div_ceil(4) * 4;
    let mut bytes = prefix(document, length);
    bytes.extend(data);
    bytes.resize(bytes.len() + length - data.len(), 0);
    bytes
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
fn error(document: &Value, data: &[u8]) -> &'static str {
    let bytes = glb(document, data);
    inspect_glb_resource_content(
        Cursor::new(&bytes),
        bytes.len() as u64,
        &manifest(),
        "assets/model.glb",
    )
    .unwrap_err()
    .code
}
fn triangle() -> (Value, Vec<u8>) {
    let document = json!({"asset":{"version":"2.0"},"buffers":[{"byteLength":42}],
        "bufferViews":[{"buffer":0,"byteLength":36,"target":34962},{"buffer":0,"byteOffset":36,"byteLength":6,"target":34963}],
        "accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]},
            {"bufferView":1,"componentType":5123,"count":3,"type":"SCALAR"}],
        "meshes":[{"primitives":[{"attributes":{"POSITION":0},"indices":1}]}],"nodes":[{"mesh":0}]});
    let mut data = floats(&[0., 0., 0., 1., 0., 0., 0., 1., 0.]);
    for index in [0_u16, 1, 2] {
        data.extend(index.to_le_bytes());
    }
    (document, data)
}
fn floats(values: &[f32]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}
fn accessor_document(shape: &str, component: u32, count: u64, length: usize) -> Value {
    json!({"asset":{"version":"2.0"},"buffers":[{"byteLength":length}],
        "bufferViews":[{"buffer":0,"byteLength":length}],
        "accessors":[{"bufferView":0,"componentType":component,"count":count,"type":shape}]})
}
fn attribute(semantic: &str, shape: &str, values: &[f32]) -> (Value, Vec<u8>) {
    let (mut document, mut data) = triangle();
    while data.len() % 4 != 0 {
        data.push(0);
    }
    let offset = data.len();
    data.extend(floats(values));
    document["buffers"][0]["byteLength"] = json!(data.len());
    document["bufferViews"]
        .as_array_mut()
        .unwrap()
        .push(json!({"buffer":0,"byteOffset":offset,"byteLength":values.len()*4,"target":34962}));
    document["accessors"]
        .as_array_mut()
        .unwrap()
        .push(json!({"bufferView":2,"componentType":5126,"count":3,"type":shape}));
    document["meshes"][0]["primitives"][0]["attributes"][semantic] = json!(2);
    (document, data)
}

#[test]
fn correct_triangle_proves_only_numeric_facts_and_exact_whole_stream_digest() {
    let (document, data) = triangle();
    let bytes = glb(&document, &data);
    let checked = inspect(&document, &data);
    assert_eq!(
        checked.sha256_hex(),
        format!("{:x}", Sha256::digest(&bytes))
    );
    assert_eq!(
        checked.sha256().as_slice(),
        Sha256::digest(&bytes).as_slice()
    );
    assert_eq!(checked.bytes(), bytes.len() as u64);
    assert_eq!(checked.source_path(), "assets/model.glb");
    assert_eq!(checked.checked_accessors(), 2);
    assert_eq!(checked.unique_layouts(), 2);
    assert_eq!(checked.checked_elements(), 6);
    assert_eq!(checked.checked_components(), 12);
    assert!(!checked.resource().structure.binary_content_validated);
}

#[test]
fn metadata_api_still_cannot_prove_invalid_indices_or_nan_values() {
    let (document, mut data) = triangle();
    data[..4].copy_from_slice(&f32::NAN.to_le_bytes());
    data[36..38].copy_from_slice(&999_u16.to_le_bytes());
    let bytes = glb(&document, &data);
    let metadata = inspect_glb_resource(
        Cursor::new(&bytes),
        bytes.len() as u64,
        &manifest(),
        "assets/model.glb",
    )
    .unwrap();
    assert!(!metadata.structure.binary_content_validated);
    assert_eq!(error(&document, &data), "invalid_model_binary");
}

#[test]
fn actual_indices_must_reference_existing_vertices() {
    let (document, mut data) = triangle();
    for index in [3_u16, 999, u16::MAX] {
        data[36..38].copy_from_slice(&index.to_le_bytes());
        assert_eq!(error(&document, &data), "invalid_model_binary");
    }
    for index in [0_u16, 1, 2] {
        data[36..38].copy_from_slice(&index.to_le_bytes());
        inspect(&document, &data);
    }
}

#[test]
fn primitive_restart_values_are_rejected_for_each_index_component() {
    for (component, count, reserved) in [
        (5121, 256, 255_u32),
        (5123, 65536, 65535),
        (5125, 3, u32::MAX),
    ] {
        let width = match component {
            5121 => 1,
            5123 => 2,
            _ => 4,
        };
        let mut document = accessor_document("VEC3", 5126, count, count as usize * 12 + 3 * width);
        document["bufferViews"][0]["byteLength"] = json!(count * 12);
        document["bufferViews"]
            .as_array_mut()
            .unwrap()
            .push(json!({"buffer":0,"byteOffset":count*12,"byteLength":3*width}));
        document["accessors"][0]["min"] = json!([0, 0, 0]);
        document["accessors"][0]["max"] = json!([0, 0, 0]);
        document["accessors"]
            .as_array_mut()
            .unwrap()
            .push(json!({"bufferView":1,"componentType":component,"count":3,"type":"SCALAR"}));
        document["meshes"] = json!([{"primitives":[{"attributes":{"POSITION":0},"indices":1}]}]);
        let mut data = vec![0; count as usize * 12 + 3 * width];
        data[count as usize * 12..][..width].copy_from_slice(&reserved.to_le_bytes()[..width]);
        assert_eq!(error(&document, &data), "invalid_model_binary");
        data[count as usize * 12..][..width].copy_from_slice(&1_u32.to_le_bytes()[..width]);
        inspect(&document, &data);
    }
}

#[test]
fn shared_index_layout_obeys_the_smallest_using_primitive_vertex_count() {
    let (mut document, data) = triangle();
    document["bufferViews"][0]["byteStride"] = json!(12);
    document["accessors"].as_array_mut().unwrap().push(json!({"bufferView":0,"componentType":5126,"count":2,"type":"VEC3","min":[0,0,0],"max":[1,0,0]}));
    document["meshes"][0]["primitives"]
        .as_array_mut()
        .unwrap()
        .push(json!({"attributes":{"POSITION":2},"indices":1}));
    assert_eq!(error(&document, &data), "invalid_model_binary");
    let mut compatible = data;
    compatible[40..42].copy_from_slice(&1_u16.to_le_bytes());
    inspect(&document, &compatible);
}

#[test]
fn unused_and_custom_float_accessors_cannot_hide_nonfinite_values() {
    for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let document = accessor_document("SCALAR", 5126, 1, 4);
        assert_eq!(error(&document, &floats(&[value])), "invalid_model_binary");
        let (document, data) = attribute("_temperature", "SCALAR", &[value, 0., 1.]);
        assert_eq!(error(&document, &data), "invalid_model_binary");
    }
}

#[test]
fn actual_position_extrema_must_match_declared_bounds_exactly() {
    let (document, data) = triangle();
    for (label, bound) in [
        ("min", json!([-1, 0, 0])),
        ("max", json!([2, 1, 0])),
        ("max", json!([0.5, 1, 0])),
    ] {
        let mut wrong = document.clone();
        wrong["accessors"][0][label] = bound;
        assert_eq!(error(&wrong, &data), "invalid_model_binary");
    }
}

#[test]
fn float_bounds_are_rounded_to_the_actual_component_precision() {
    let mut document = accessor_document("SCALAR", 5126, 2, 8);
    document["accessors"][0]["min"] = json!([1.2]);
    document["accessors"][0]["max"] = json!([2.3]);
    inspect(&document, &floats(&[1.2, 2.3]));
    document["accessors"][0]["max"] = json!([2.300001]);
    assert_eq!(
        error(&document, &floats(&[1.2, 2.3])),
        "invalid_model_binary"
    );
}

#[test]
fn float_bound_order_is_checked_after_component_rounding_without_changing_declared_values() {
    let actual = f64::from(1.2_f32);
    assert!(actual > 1.2_f64);
    let mut document = accessor_document("SCALAR", 5126, 1, 4);
    document["accessors"][0]["min"] = json!([actual]);
    document["accessors"][0]["max"] = json!([1.2]);
    let checked = inspect(&document, &floats(&[1.2]));
    assert_eq!(
        checked.resource().structure.accessors[0].min.as_deref(),
        Some([actual].as_slice())
    );
    assert_eq!(
        checked.resource().structure.accessors[0].max.as_deref(),
        Some([1.2].as_slice())
    );
    let bytes = glb(&document, &floats(&[1.2]));
    inspect_glb_resource(
        Cursor::new(&bytes),
        bytes.len() as u64,
        &manifest(),
        "assets/model.glb",
    )
    .unwrap();
    document["accessors"][0]["max"] = json!([1.19999]);
    assert_eq!(error(&document, &floats(&[1.2])), "invalid_model_structure");
    let mut integers = accessor_document("SCALAR", 5123, 1, 2);
    integers["accessors"][0]["min"] = json!([2]);
    integers["accessors"][0]["max"] = json!([1]);
    assert_eq!(
        error(&integers, &1_u16.to_le_bytes()),
        "invalid_model_structure"
    );
}

#[test]
fn normalized_integer_bounds_compare_raw_integer_extrema() {
    for (component, data, min, max) in [
        (5120, vec![128_u8, 129], -128, -127),
        (
            5122,
            [-32768_i16, -32767]
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect(),
            -32768,
            -32767,
        ),
        (5121, vec![0, 255], 0, 255),
        (
            5123,
            [0_u16, 65535]
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect(),
            0,
            65535,
        ),
    ] {
        let mut document = accessor_document("SCALAR", component, 2, data.len());
        document["accessors"][0]["normalized"] = json!(true);
        document["accessors"][0]["min"] = json!([min]);
        document["accessors"][0]["max"] = json!([max]);
        inspect(&document, &data);
        document["accessors"][0]["max"] = json!([max - 1]);
        assert_eq!(error(&document, &data), "invalid_model_binary");
    }
}

#[test]
fn normal_vectors_have_an_explicit_numeric_tolerance() {
    for z in [1_f32, 1.00002] {
        let (document, data) = attribute("NORMAL", "VEC3", &[0., 0., z, 0., 0., 1., 0., 0., 1.]);
        inspect(&document, &data);
    }
    for z in [0_f32, 0.1, 1.01, -1.01] {
        let (document, data) = attribute("NORMAL", "VEC3", &[0., 0., z, 0., 0., 1., 0., 0., 1.]);
        assert_eq!(error(&document, &data), "invalid_model_binary");
    }
}

#[test]
fn tangent_xyz_is_unit_length_and_handedness_is_exactly_one() {
    for w in [-1_f32, 1.] {
        let (document, data) = attribute(
            "TANGENT",
            "VEC4",
            &[1., 0., 0., w, 1., 0., 0., 1., 1., 0., 0., -1.],
        );
        inspect(&document, &data);
    }
    for (x, w) in [(0_f32, 1_f32), (2., 1.), (1., 0.), (1., 0.99999)] {
        let (document, data) = attribute(
            "TANGENT",
            "VEC4",
            &[x, 0., 0., w, 1., 0., 0., 1., 1., 0., 0., -1.],
        );
        assert_eq!(error(&document, &data), "invalid_model_binary");
    }
}

#[test]
fn color_zero_float_values_are_in_the_closed_unit_interval() {
    let (document, data) = attribute(
        "COLOR_0",
        "VEC4",
        &[0., 0.5, 1., 1., 0., 0., 0., 0., 1., 1., 1., 1.],
    );
    inspect(&document, &data);
    for value in [-0.00001_f32, 1.00001] {
        let mut wrong = data.clone();
        wrong[44..48].copy_from_slice(&value.to_le_bytes());
        assert_eq!(error(&document, &wrong), "invalid_model_binary");
    }
}

#[test]
fn matrices_skip_full_column_padding_and_compare_all_components() {
    for (component, width) in [(5121, 1), (5123, 2)] {
        let column = (3_usize * width).div_ceil(4) * 4;
        let mut data = vec![0xff; column * 3];
        for c in 0..3 {
            for r in 0..3 {
                let value = (c * 3 + r + 1) as u16;
                data[c * column + r * width..][..width]
                    .copy_from_slice(&value.to_le_bytes()[..width]);
            }
        }
        let mut document = accessor_document("MAT3", component, 1, data.len());
        document["accessors"][0]["min"] = json!([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        document["accessors"][0]["max"] = json!([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        inspect(&document, &data);
        document["accessors"][0]["max"][8] = json!(10);
        assert_eq!(error(&document, &data), "invalid_model_binary");
    }
}

#[test]
fn exact_layout_aliases_share_scans_but_keep_individual_declared_bounds() {
    let mut document = accessor_document("SCALAR", 5121, 4096, 4096);
    let accessor = document["accessors"][0].clone();
    document["accessors"] = json!(vec![accessor; 1000]);
    let data = vec![7; 4096];
    let checked = inspect(&document, &data);
    assert_eq!(checked.checked_accessors(), 1000);
    assert_eq!(checked.unique_layouts(), 1);
    assert_eq!(checked.checked_elements(), 4096);
    document["accessors"][999]["min"] = json!([6]);
    assert_eq!(error(&document, &data), "invalid_model_binary");
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
fn overlapping_distinct_layout_work_is_rejected_before_any_bin_read() {
    let count = MAX_MODEL_VALIDATION_ELEMENTS / 16;
    let length = (count + 16) as usize;
    let mut document = accessor_document("SCALAR", 5121, count, length);
    document["accessors"] = json!((0..17).map(|offset|json!({"bufferView":0,"byteOffset":offset,"componentType":5121,"count":count,"type":"SCALAR"})).collect::<Vec<_>>());
    let prefix = prefix(&document, length);
    let declared = prefix.len() as u64 + length as u64;
    let mut input = ZeroTail {
        prefix,
        length: declared,
        offset: 0,
        bin_read: 0,
    };
    let error = inspect_glb_resource_content(&mut input, declared, &manifest(), "assets/model.glb")
        .unwrap_err();
    assert_eq!(error.code, "model_binary_limit");
    assert_eq!(input.bin_read, 0);
}

struct ShortReader<'a> {
    cursor: Cursor<&'a [u8]>,
    max: usize,
    bin_offset: u64,
    max_bin_request: usize,
}

#[test]
fn overlapping_matrix_component_work_is_also_rejected_before_bin_read() {
    let count = 1_048_576;
    let length = count * 64 + 16;
    let mut document = accessor_document("MAT4", 5126, count as u64, length);
    document["accessors"] = json!((0..5)
        .map(|index| json!({
            "bufferView":0,"byteOffset":index*4,"componentType":5126,"count":count,"type":"MAT4"
        }))
        .collect::<Vec<_>>());
    let prefix = prefix(&document, length);
    let declared = prefix.len() as u64 + length as u64;
    let mut input = ZeroTail {
        prefix,
        length: declared,
        offset: 0,
        bin_read: 0,
    };
    assert_eq!(
        inspect_glb_resource_content(&mut input, declared, &manifest(), "assets/model.glb")
            .unwrap_err()
            .code,
        "model_binary_limit"
    );
    assert_eq!(input.bin_read, 0);
}

#[test]
fn interleaved_position_and_normal_streams_cross_blocks_without_rereads() {
    let count = 6_000;
    let document = json!({"asset":{"version":"2.0"},"buffers":[{"byteLength":count*24}],
        "bufferViews":[{"buffer":0,"byteLength":count*24,"byteStride":24,"target":34962}],
        "accessors":[{"bufferView":0,"componentType":5126,"count":count,"type":"VEC3","min":[0,0,0],"max":[1,0,0]},
            {"bufferView":0,"byteOffset":12,"componentType":5126,"count":count,"type":"VEC3"}],
        "meshes":[{"primitives":[{"attributes":{"POSITION":0,"NORMAL":1}}]}]});
    let mut data = Vec::with_capacity(count * 24);
    for index in 0..count {
        data.extend(floats(&[(index % 2) as f32, 0., 0., 0., 0., 1.]));
    }
    let checked = inspect(&document, &data);
    assert_eq!(checked.unique_layouts(), 2);
    assert_eq!(checked.checked_elements(), 12_000);
    assert_eq!(checked.bytes(), glb(&document, &data).len() as u64);
    let offset = (count - 1) * 24 + 12;
    data[offset..offset + 4].copy_from_slice(&f32::INFINITY.to_le_bytes());
    assert_eq!(error(&document, &data), "invalid_model_binary");
}

#[test]
fn signed_unused_and_uint32_custom_extrema_preserve_raw_component_values() {
    let mut document = accessor_document("SCALAR", 5125, 2, 8);
    document["accessors"][0]["min"] = json!([0]);
    document["accessors"][0]["max"] = json!([u32::MAX]);
    let data: Vec<_> = [0_u32, u32::MAX]
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect();
    inspect(&document, &data);
    let (mut document, mut data) = triangle();
    document["bufferViews"][1]
        .as_object_mut()
        .unwrap()
        .remove("target");
    document["accessors"][1]["min"] = json!([0]);
    document["accessors"][1]["max"] = json!([65535]);
    document["meshes"][0]["primitives"][0]
        .as_object_mut()
        .unwrap()
        .remove("indices");
    data[40..42].copy_from_slice(&u16::MAX.to_le_bytes());
    inspect(&document, &data);
}
impl Read for ShortReader<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if self.cursor.position() >= self.bin_offset {
            self.max_bin_request = self.max_bin_request.max(output.len());
        }
        let count = output.len().min(self.max);
        self.cursor.read(&mut output[..count])
    }
}

#[test]
fn nonseekable_short_reads_and_cross_window_elements_preserve_values_and_hash() {
    let count = 5500;
    let length = count * 12;
    let document = accessor_document("VEC3", 5126, count as u64, length);
    let data = floats(&vec![1.2; count * 3]);
    let bytes = glb(&document, &data);
    let mut input = ShortReader {
        cursor: Cursor::new(bytes.as_slice()),
        max: 3,
        bin_offset: prefix(&document, length).len() as u64,
        max_bin_request: 0,
    };
    let checked = inspect_glb_resource_content(
        &mut input,
        bytes.len() as u64,
        &manifest(),
        "assets/model.glb",
    )
    .unwrap();
    assert_eq!(checked.checked_elements(), count as u64);
    assert_eq!(
        checked.sha256_hex(),
        format!("{:x}", Sha256::digest(&bytes))
    );
    assert!(input.max_bin_request <= 64 * 1024);
    let mut truncated = bytes.clone();
    truncated.truncate(truncated.len() - 12);
    let error = inspect_glb_resource_content(
        Cursor::new(&truncated),
        bytes.len() as u64,
        &manifest(),
        "assets/model.glb",
    )
    .unwrap_err();
    assert_eq!(error.code, "invalid_model_binary");
}

#[test]
fn unused_bin_bytes_are_hashed_and_trailing_bytes_still_reject() {
    let document = json!({"asset":{"version":"2.0"}});
    let first = inspect(&document, &[1, 2, 3, 4]);
    let second = inspect(&document, &[1, 2, 3, 5]);
    assert_ne!(first.sha256(), second.sha256());
    assert_eq!(first.checked_accessors(), 0);
    let mut bytes = glb(&document, &[1, 2, 3, 4]);
    let length = bytes.len() as u64;
    bytes.push(0);
    assert_eq!(
        inspect_glb_resource_content(Cursor::new(&bytes), length, &manifest(), "assets/model.glb")
            .unwrap_err()
            .code,
        "invalid_model_container"
    );
}

fn package(model: &[u8], variant: bool) -> Vec<u8> {
    let mut manifest = serde_json::to_value(manifest()).unwrap();
    let path = if variant {
        "assets/variant.glb"
    } else {
        "assets/model.glb"
    };
    let empty = glb(&json!({"asset":{"version":"2.0"}}), &[]);
    manifest["assets"] = if variant {
        json!([{"id":"model","kind":"model","source":"assets/model.glb","variants":[{"id":"low","file":path,"purpose":"low"}]}])
    } else {
        json!([{"id":"model","kind":"model","source":path,"variants":[]}])
    };
    let mut files = vec![(path, model.to_vec())];
    if variant {
        files.push(("assets/model.glb", empty));
    }
    manifest["files"] = json!(files.iter().map(|(path,data)|json!({"path":path,"bytes":data.len(),"sha256":format!("{:x}",Sha256::digest(data)),"mime":"model/gltf-binary"})).collect::<Vec<_>>());
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
fn both_public_package_entries_check_real_source_and_variant_values() {
    let (document, mut data) = triangle();
    for variant in [false, true] {
        let valid = package(&glb(&document, &data), variant);
        let checked = validate_package(Cursor::new(&valid)).unwrap();
        validate_archive(Cursor::new(&valid), &checked.manifest).unwrap();
    }
    data[36..38].copy_from_slice(&999_u16.to_le_bytes());
    let model = glb(&document, &data);
    for variant in [false, true] {
        let bytes = package(&model, variant);
        let error = validate_package(Cursor::new(&bytes)).unwrap_err();
        assert_eq!(error.code, "invalid_model_binary");
        assert!(error.message.contains(if variant {
            "assets/variant.glb"
        } else {
            "assets/model.glb"
        }));
        let mut zip = zip::ZipArchive::new(Cursor::new(&bytes)).unwrap();
        let parsed: Manifest =
            serde_json::from_reader(zip.by_name("manifest.json").unwrap()).unwrap();
        assert_eq!(
            validate_archive(Cursor::new(&bytes), &parsed)
                .unwrap_err()
                .code,
            "invalid_model_binary"
        );
    }
}
