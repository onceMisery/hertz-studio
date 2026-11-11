// SPDX-License-Identifier: MIT
//! Actual GLB, nonseekable stream, package and default admission fixtures.

use std::io::{self, Cursor, Read, Write};

use hertz_wallpaper::{
    model_binary::{
        inspect_glb_resource_content, CheckedGlbResource, MAX_MODEL_SKIN_ASSOCIATION_BYTES,
        MAX_MODEL_SKIN_ASSOCIATION_WORK,
    },
    model_structure::{inspect_glb_resource, GlbResource, MAX_MODEL_RECORDS},
    validate_archive, validate_package, Manifest, PackageError,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zip::{write::SimpleFileOptions, ZipWriter};

fn manifest() -> Manifest {
    serde_json::from_value(json!({"formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae","version":1,"title":"Skin associations",
        "content":{"kind":"builtin","sceneId":"zodiac","stateVersion":1,"params":{}},"assets":[],"files":[],
        "permissions":{"audioSpectrum":false,"pointer":false},"license":{"code":"none","assets":"CC0-1.0"}})).unwrap()
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
#[derive(Clone)]
struct Fixture {
    document: Value,
    data: Vec<u8>,
    indices: usize,
    gap: usize,
}
impl Fixture {
    fn new(joints: usize) -> Self {
        let mut nodes = vec![json!({"children":(1..=joints).collect::<Vec<_>>()})];
        nodes.extend((0..joints).map(|_| json!({})));
        let mut fixture = Self {
            document: json!({"asset":{"version":"2.0"},"buffers":[{"byteLength":1}],
            "bufferViews":[],"accessors":[],"meshes":[],"nodes":nodes,
            "skins":[{"joints":(1..=joints).collect::<Vec<_>>() }],"scenes":[{"nodes":[0]}],"scene":0}),
            data: Vec::new(),
            indices: 0,
            gap: 0,
        };
        fixture.indices = fixture.accessor(5123, "SCALAR", 3, &[0; 6], false);
        fixture
    }
    fn accessor(
        &mut self,
        component: u32,
        shape: &str,
        count: u64,
        values: &[u8],
        vertex: bool,
    ) -> usize {
        self.data.resize(self.data.len() + self.gap, 0);
        while !self.data.len().is_multiple_of(4) {
            self.data.push(0);
        }
        let offset = self.data.len();
        self.data.extend(values);
        let view = self.document["bufferViews"].as_array().unwrap().len();
        let mut metadata = json!({"buffer":0,"byteOffset":offset,"byteLength":values.len()});
        if vertex {
            metadata["byteStride"] = json!(values.len() as u64 / count);
            metadata["target"] = json!(34962);
        }
        self.document["bufferViews"]
            .as_array_mut()
            .unwrap()
            .push(metadata);
        let index = self.document["accessors"].as_array().unwrap().len();
        self.document["accessors"]
            .as_array_mut()
            .unwrap()
            .push(json!({"bufferView":view,"componentType":component,"count":count,"type":shape}));
        self.document["buffers"][0]["byteLength"] = json!(self.data.len());
        index
    }
    fn group(&mut self, vertices: u64, weight_types: &[u32], joint_type: u32) -> usize {
        let position = self.accessor(
            5126,
            "VEC3",
            vertices,
            &vec![0; vertices as usize * 12],
            true,
        );
        self.document["accessors"][position]["min"] = json!([0, 0, 0]);
        self.document["accessors"][position]["max"] = json!([0, 0, 0]);
        let mut attributes = json!({"POSITION":position});
        for (set, &component) in weight_types.iter().enumerate() {
            let joint_width = if joint_type == 5121 { 1 } else { 2 };
            let joint = self.accessor(
                joint_type,
                "VEC4",
                vertices,
                &vec![0; vertices as usize * 4 * joint_width],
                true,
            );
            let width = if component == 5121 {
                1
            } else if component == 5123 {
                2
            } else {
                4
            };
            let weight = self.accessor(
                component,
                "VEC4",
                vertices,
                &vec![0; vertices as usize * 4 * width],
                true,
            );
            if component != 5126 {
                self.document["accessors"][weight]["normalized"] = json!(true);
            }
            attributes[format!("JOINTS_{set}")] = json!(joint);
            attributes[format!("WEIGHTS_{set}")] = json!(weight);
            let total = if component == 5121 {
                255
            } else if component == 5123 {
                65535
            } else {
                1
            };
            let first = total / weight_types.len()
                + usize::from(set == weight_types.len() - 1) * (total % weight_types.len());
            for vertex in 0..vertices {
                self.write(joint, vertex, 0, set as f64);
                self.write(weight, vertex, 0, first as f64);
            }
        }
        let mesh = self.document["meshes"].as_array().unwrap().len();
        self.document["meshes"]
            .as_array_mut()
            .unwrap()
            .push(json!({"primitives":[{"attributes":attributes,"indices":self.indices}]}));
        let node = self.document["nodes"].as_array().unwrap().len();
        self.document["nodes"]
            .as_array_mut()
            .unwrap()
            .push(json!({"mesh":mesh,"skin":0}));
        self.document["scenes"][0]["nodes"]
            .as_array_mut()
            .unwrap()
            .push(json!(node));
        mesh
    }
    fn attr(&self, mesh: usize, semantic: &str) -> usize {
        self.document["meshes"][mesh]["primitives"][0]["attributes"][semantic]
            .as_u64()
            .unwrap() as usize
    }
    fn write(&mut self, accessor: usize, vertex: u64, component: usize, value: f64) {
        let metadata = &self.document["accessors"][accessor];
        let kind = metadata["componentType"].as_u64().unwrap();
        let view = &self.document["bufferViews"][metadata["bufferView"].as_u64().unwrap() as usize];
        let width = if kind == 5121 {
            1
        } else if kind == 5123 {
            2
        } else {
            4
        };
        let stride = view["byteStride"].as_u64().unwrap_or((4 * width) as u64);
        let offset = view["byteOffset"].as_u64().unwrap() as usize
            + vertex as usize * stride as usize
            + component * width;
        match kind {
            5121 => self.data[offset] = value as u8,
            5123 => self.data[offset..offset + 2].copy_from_slice(&(value as u16).to_le_bytes()),
            _ => self.data[offset..offset + 4].copy_from_slice(&(value as f32).to_le_bytes()),
        }
    }
    fn metadata(&self) -> hertz_wallpaper::Result<GlbResource> {
        let bytes = self.bytes();
        inspect_glb_resource(
            Cursor::new(&bytes),
            bytes.len() as u64,
            &manifest(),
            "assets/model.glb",
        )
    }
    fn content(&self) -> hertz_wallpaper::Result<CheckedGlbResource> {
        let bytes = self.bytes();
        inspect_glb_resource_content(
            Cursor::new(&bytes),
            bytes.len() as u64,
            &manifest(),
            "assets/model.glb",
        )
    }
    fn bytes(&self) -> Vec<u8> {
        glb(&self.document, &self.data)
    }
    fn good(&self) -> CheckedGlbResource {
        assert!(!self.metadata().unwrap().structure.binary_content_validated);
        let checked = self.content().unwrap();
        assert!(!checked.resource().structure.binary_content_validated);
        assert_eq!(
            checked.sha256_hex(),
            format!("{:x}", Sha256::digest(self.bytes()))
        );
        checked
    }
    fn bad_binary(&self, message: &str) {
        assert!(!self.metadata().unwrap().structure.binary_content_validated);
        let error = self.content().unwrap_err();
        assert_eq!(error.code, "invalid_model_binary");
        assert!(error.message.contains(message), "{error:?}");
    }
}
fn ordinary() -> Fixture {
    let mut fixture = Fixture::new(4);
    fixture.group(3, &[5121], 5121);
    fixture
}
fn bad_structure(fixture: &Fixture) {
    assert_eq!(
        fixture.metadata().unwrap_err().code,
        "invalid_model_structure"
    );
}

#[test]
fn typed_skin_fields_and_nonnull_refs() {
    let source = ordinary();
    for value in [
        json!([]),
        Value::Null,
        json!([{}]),
        json!([{"joints":[]}]),
        json!([{"joints":null}]),
        json!([{"joints":[1,1]}]),
        json!([{"joints":[999]}]),
    ] {
        let mut fixture = source.clone();
        fixture.document["skins"] = value;
        bad_structure(&fixture);
    }
    for pointer in [
        "/skins/0/skeleton",
        "/skins/0/inverseBindMatrices",
        "/nodes/5/skin",
    ] {
        for value in [Value::Null, json!({}), json!(-1), json!(999)] {
            let mut fixture = source.clone();
            let (parent, key) = pointer.rsplit_once('/').unwrap();
            fixture.document.pointer_mut(parent).unwrap()[key] = value;
            bad_structure(&fixture);
        }
    }
    let mut fixture = source.clone();
    fixture.document["nodes"][5]
        .as_object_mut()
        .unwrap()
        .remove("mesh");
    bad_structure(&fixture);
    let checked = source.good();
    assert_eq!(
        checked.resource().structure.skins[0].joints,
        vec![1, 2, 3, 4]
    );
    assert_eq!(checked.resource().structure.skins[0].common_root, 0);
    assert_eq!(checked.resource().structure.skin_binding_pair_refs, 1);
}

#[test]
fn skin_graph_and_all_scene_memberships() {
    let source = ordinary();
    for skeleton in [0, 1] {
        let mut fixture = source.clone();
        fixture.document["skins"][0]["skeleton"] = json!(skeleton);
        if skeleton == 0 {
            fixture.good();
        } else {
            bad_structure(&fixture);
        }
    }
    let mut fixture = source.clone();
    fixture.document["nodes"][0]["children"] = json!([1, 2, 3]);
    bad_structure(&fixture);
    let mut fixture = source.clone();
    fixture.document["scenes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"nodes":[5]}));
    bad_structure(&fixture);
    let mut fixture = source.clone();
    fixture.document["scenes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"nodes":[0,5]}));
    fixture.good();
    let mut fixture = source.clone();
    fixture.document["nodes"][0]["children"] = json!([1]);
    fixture.document["nodes"][1]["children"] = json!([2, 3, 4]);
    fixture.document["skins"][0]["joints"] = json!([2, 3, 4]);
    fixture.document["skins"][0]["skeleton"] = json!(1);
    fixture.good();
    fixture.document["skins"][0]["skeleton"] = json!(0);
    fixture.good();
    let mut unused = source;
    unused.document["nodes"][5]
        .as_object_mut()
        .unwrap()
        .remove("skin");
    unused.document["skins"][0]["joints"] = json!([1, 1]);
    bad_structure(&unused);
}

#[test]
fn mixed_and_unbound_primitives() {
    let mut fixture = ordinary();
    let position = fixture.attr(0, "POSITION");
    fixture.document["meshes"][0]["primitives"]
        .as_array_mut()
        .unwrap()
        .push(json!({"attributes":{"POSITION":position},"indices":fixture.indices}));
    fixture.good();
    fixture.document["meshes"][0]["primitives"][0]["attributes"] = json!({"POSITION":position});
    for (name, index) in [("_OLD_JOINTS", 2), ("_OLD_WEIGHTS", 3)] {
        fixture.document["meshes"][0]["primitives"][0]["attributes"][name] = json!(index);
    }
    assert_eq!(fixture.good().resource().structure.skin_bindings.len(), 0);
    fixture.document["scenes"] = json!([{"nodes":[5]}]);
    bad_structure(&fixture);
    let mut unbound = ordinary();
    unbound.document["nodes"][5]
        .as_object_mut()
        .unwrap()
        .remove("skin");
    unbound.document["skins"][0]["joints"] = json!([1]);
    let joint = unbound.attr(0, "JOINTS_0");
    for vertex in 0..3 {
        unbound.write(joint, vertex, 0, 3.);
    }
    unbound.good();
}

#[test]
fn base_skin_pair_types_counts_and_names() {
    let source = ordinary();
    for semantic in ["JOINTS_0", "WEIGHTS_0"] {
        let mut fixture = source.clone();
        fixture.document["meshes"][0]["primitives"][0]["attributes"]
            .as_object_mut()
            .unwrap()
            .remove(semantic);
        bad_structure(&fixture);
    }
    for (joint_name, weight_name) in [
        ("JOINTS_1", "WEIGHTS_1"),
        ("JOINTS_01", "WEIGHTS_01"),
        ("JOINTS_1000000000", "WEIGHTS_1000000000"),
    ] {
        let mut fixture = source.clone();
        let attrs = fixture.document["meshes"][0]["primitives"][0]["attributes"]
            .as_object_mut()
            .unwrap();
        let j = attrs.remove("JOINTS_0").unwrap();
        let w = attrs.remove("WEIGHTS_0").unwrap();
        attrs.insert(joint_name.into(), j);
        attrs.insert(weight_name.into(), w);
        bad_structure(&fixture);
    }
    for (semantic, field, value) in [
        ("JOINTS_0", "normalized", json!(true)),
        ("JOINTS_0", "componentType", json!(5120)),
        ("JOINTS_0", "componentType", json!(5125)),
        ("JOINTS_0", "componentType", json!(5126)),
        ("WEIGHTS_0", "normalized", json!(false)),
        ("WEIGHTS_0", "componentType", json!(5122)),
        ("WEIGHTS_0", "type", json!("VEC3")),
        ("JOINTS_0", "count", json!(2)),
    ] {
        let mut fixture = source.clone();
        let accessor = fixture.attr(0, semantic);
        fixture.document["accessors"][accessor][field] = value;
        bad_structure(&fixture);
    }
    let mut fixture = source;
    let joint = fixture.attr(0, "JOINTS_0");
    let view = fixture.document["accessors"][joint]["bufferView"]
        .as_u64()
        .unwrap() as usize;
    fixture.document["bufferViews"][view]
        .as_object_mut()
        .unwrap()
        .remove("byteStride");
    bad_structure(&fixture);
}

#[test]
fn joint_bounds_include_zero_weights_and_all_consumers() {
    let mut fixture = Fixture::new(256);
    fixture.group(1, &[5121], 5121);
    let joint = fixture.attr(0, "JOINTS_0");
    fixture.write(joint, 0, 0, 255.);
    fixture.good();
    let source = ordinary();
    for reverse in [false, true] {
        let mut fixture = source.clone();
        let joint = fixture.attr(0, "JOINTS_0");
        for vertex in 0..3 {
            fixture.write(joint, vertex, 0, 3.);
        }
        fixture.document["skins"]
            .as_array_mut()
            .unwrap()
            .push(json!({"joints":[1,2]}));
        fixture.document["nodes"]
            .as_array_mut()
            .unwrap()
            .push(json!({"mesh":0,"skin":1}));
        fixture.document["scenes"][0]["nodes"]
            .as_array_mut()
            .unwrap()
            .push(json!(6));
        if reverse {
            fixture.document["nodes"][5]["skin"] = json!(1);
            fixture.document["nodes"][6]["skin"] = json!(0);
        }
        assert_eq!(
            fixture.metadata().unwrap().structure.skin_binding_pair_refs,
            2
        );
        fixture.bad_binary("JOINTS");
    }
    let mut fixture = source;
    let joint = fixture.attr(0, "JOINTS_0");
    fixture.write(joint, 0, 3, 4.);
    fixture.bad_binary("JOINTS");
    fixture.write(joint, 0, 3, 3.);
    fixture.good();
}

#[test]
fn active_joint_uniqueness_and_float_weights() {
    let mut fixture = ordinary();
    let joint = fixture.attr(0, "JOINTS_0");
    let weight = fixture.attr(0, "WEIGHTS_0");
    fixture.write(weight, 0, 0, 127.);
    fixture.write(weight, 0, 1, 128.);
    fixture.bad_binary("same joint");
    fixture.write(joint, 0, 1, 1.);
    fixture.good();
    let mut fixture = Fixture::new(2);
    fixture.group(3, &[5121, 5121], 5121);
    let joint = fixture.attr(0, "JOINTS_1");
    fixture.write(joint, 1, 0, 0.);
    fixture.bad_binary("same joint");
    let mut floating = Fixture::new(2);
    floating.group(3, &[5126], 5121);
    let weight = floating.attr(0, "WEIGHTS_0");
    for vertex in 0..3 {
        floating.write(weight, vertex, 0, 2.);
    }
    floating.good();
    for value in [-1., f64::NAN] {
        floating.write(weight, 0, 0, value);
        floating.bad_binary(if value.is_nan() { "NaN" } else { "nonnegative" });
    }
    for vertex in 0..3 {
        floating.write(weight, vertex, 0, 0.);
    }
    floating.good();
}

#[test]
fn integer_weight_sum_is_across_all_sets() {
    let mut fixture = Fixture::new(8);
    fixture.group(3, &[5121, 5123], 5121);
    for vertex in 0..3 {
        for (set, values) in [[1., 4., 16., 64.], [640., 2080., 8200., 32770.]]
            .iter()
            .enumerate()
        {
            let joint = fixture.attr(0, &format!("JOINTS_{set}"));
            let weight = fixture.attr(0, &format!("WEIGHTS_{set}"));
            for (component, &value) in values.iter().enumerate() {
                fixture.write(joint, vertex, component, (set * 4 + component) as f64);
                fixture.write(weight, vertex, component, value);
            }
        }
    }
    fixture.good();
    let mut fixture = Fixture::new(2);
    fixture.group(3, &[5121, 5121], 5121);
    for set in 0..2 {
        let weight = fixture.attr(0, &format!("WEIGHTS_{set}"));
        fixture.write(weight, 0, 0, 255.);
    }
    fixture.bad_binary("sum exactly");
}

#[test]
fn separated_sets_prove_vertex_association() {
    let mut fixture = Fixture::new(2);
    fixture.gap = 65_540;
    fixture.group(2, &[5123, 5123], 5123);
    let weight0 = fixture.attr(0, "WEIGHTS_0");
    let weight1 = fixture.attr(0, "WEIGHTS_1");
    for (accessor, values) in [(weight0, [16384., 49151.]), (weight1, [49151., 16384.])] {
        for (vertex, value) in values.into_iter().enumerate() {
            fixture.write(accessor, vertex as u64, 0, value);
        }
        fixture.document["accessors"][accessor]["min"] = json!([16384, 0, 0, 0]);
        fixture.document["accessors"][accessor]["max"] = json!([49151, 0, 0, 0]);
    }
    fixture.good();
    fixture.write(weight1, 0, 0, 16384.);
    fixture.write(weight1, 1, 0, 49151.);
    fixture.bad_binary("sum exactly");
}

#[test]
fn raw_aliases_keep_every_partner_and_role() {
    let mut fixture = Fixture::new(2);
    fixture.group(3, &[5123], 5123);
    let joint = fixture.attr(0, "JOINTS_0");
    let weight = fixture.attr(0, "WEIGHTS_0");
    for vertex in 0..3 {
        fixture.write(weight, vertex, 0, 0.);
        fixture.write(weight, vertex, 1, 65535.);
        fixture.write(joint, vertex, 1, 1.);
    }
    let good = fixture.good();
    let mut alias = fixture.document["accessors"][weight].clone();
    alias["normalized"] = json!(false);
    let alias_index = fixture.document["accessors"].as_array().unwrap().len();
    fixture.document["accessors"]
        .as_array_mut()
        .unwrap()
        .push(alias);
    fixture.document["meshes"][0]["primitives"][0]["attributes"]["JOINTS_0"] = json!(alias_index);
    fixture.document["meshes"][0]["primitives"][0]["attributes"]["_ORIGINAL_JOINTS"] = json!(joint);
    fixture.bad_binary("JOINTS");
    fixture.document["nodes"].as_array_mut().unwrap()[3]
        .as_object_mut()
        .unwrap()
        .remove("skin");
    fixture.good();
    assert_eq!(fixture.good().unique_layouts(), good.unique_layouts());
    // Distinct groups share one weight job; only the second partner is invalid.
    let mut fixture = Fixture::new(2);
    fixture.group(3, &[5121], 5121);
    fixture.group(3, &[5121], 5121);
    let shared = fixture.attr(0, "WEIGHTS_0");
    fixture.document["meshes"][1]["primitives"][0]["attributes"]["WEIGHTS_0"] = json!(shared);
    fixture.document["meshes"][1]["primitives"][0]["attributes"]["_ORIGINAL_WEIGHTS"] =
        json!(fixture.document["accessors"].as_array().unwrap().len() - 1);
    let second_joint = fixture.attr(1, "JOINTS_0");
    let second_weight = fixture.attr(0, "WEIGHTS_0");
    fixture.write(second_weight, 0, 0, 127.);
    fixture.write(second_weight, 0, 1, 128.);
    let first_joint = fixture.attr(0, "JOINTS_0");
    fixture.write(first_joint, 0, 1, 1.);
    fixture.write(second_joint, 0, 1, 0.);
    fixture.bad_binary("same joint");
    fixture.write(second_joint, 0, 1, 1.);
    fixture.good();
    fixture.document["meshes"].as_array_mut().unwrap().reverse();
    fixture.good();
}

#[test]
fn same_job_joint_and_weight_observers_are_both_kept() {
    let mut fixture = Fixture::new(2);
    fixture.group(3, &[5123], 5123);
    let weight = fixture.attr(0, "WEIGHTS_0");
    let mut alias = fixture.document["accessors"][weight].clone();
    alias["normalized"] = json!(false);
    let index = fixture.document["accessors"].as_array().unwrap().len();
    fixture.document["accessors"]
        .as_array_mut()
        .unwrap()
        .push(alias);
    fixture.document["meshes"][0]["primitives"][0]["attributes"]["JOINTS_0"] = json!(index);
    let joint = fixture.document["accessors"].as_array().unwrap().len() - 3;
    fixture.document["meshes"][0]["primitives"][0]["attributes"]["_ORIGINAL_JOINTS"] = json!(joint);
    fixture.document["nodes"][3]
        .as_object_mut()
        .unwrap()
        .remove("skin");
    fixture.good();
    fixture.document["accessors"]
        .as_array_mut()
        .unwrap()
        .swap(weight, index);
    fixture.document["meshes"][0]["primitives"][0]["attributes"]["WEIGHTS_0"] = json!(index);
    fixture.document["meshes"][0]["primitives"][0]["attributes"]["JOINTS_0"] = json!(weight);
    fixture.good();
}

fn matrices(count: usize) -> Vec<u8> {
    (0..count)
        .flat_map(|_| {
            [
                1_f32, 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
            ]
        })
        .flat_map(f32::to_le_bytes)
        .collect()
}
#[test]
fn ibm_prefix_and_affine_singular() {
    let mut fixture = ordinary();
    let ibm = fixture.accessor(5126, "MAT4", 5, &matrices(5), false);
    fixture.document["skins"][0]["inverseBindMatrices"] = json!(ibm);
    fixture.good();
    let view = fixture.document["accessors"][ibm]["bufferView"]
        .as_u64()
        .unwrap() as usize;
    let offset = fixture.document["bufferViews"][view]["byteOffset"]
        .as_u64()
        .unwrap() as usize;
    fixture.data[offset + 4 * 64 + 3 * 4..offset + 4 * 64 + 4 * 4]
        .copy_from_slice(&7_f32.to_le_bytes());
    fixture.good();
    fixture.data[offset..offset + 64].fill(0);
    fixture.data[offset + 60..offset + 64].copy_from_slice(&1_f32.to_le_bytes());
    fixture.good();
    fixture.data[offset + 12..offset + 16].copy_from_slice(&1_f32.to_le_bytes());
    fixture.bad_binary("affine fourth");
    fixture.data[offset + 12..offset + 16].copy_from_slice(&0_f32.to_le_bytes());
    fixture.data[offset + 4 * 64..offset + 4 * 64 + 4].copy_from_slice(&f32::NAN.to_le_bytes());
    fixture.bad_binary("NaN");
    let mut too_short = ordinary();
    let ibm = too_short.accessor(5126, "MAT4", 3, &matrices(3), false);
    too_short.document["skins"][0]["inverseBindMatrices"] = json!(ibm);
    bad_structure(&too_short);
}

#[test]
fn unused_ibm_and_maximum_prefix_are_checked() {
    let mut fixture = ordinary();
    let ibm = fixture.accessor(5126, "MAT4", 4, &matrices(4), false);
    fixture.document["skins"][0]["joints"] = json!([1]);
    fixture.document["skins"][0]["inverseBindMatrices"] = json!(ibm);
    fixture.document["skins"]
        .as_array_mut()
        .unwrap()
        .push(json!({"joints":[1,2,3,4],"inverseBindMatrices":ibm}));
    let view = fixture.document["accessors"][ibm]["bufferView"]
        .as_u64()
        .unwrap() as usize;
    let offset = fixture.document["bufferViews"][view]["byteOffset"]
        .as_u64()
        .unwrap() as usize;
    fixture.data[offset + 3 * 64 + 12..offset + 3 * 64 + 16].copy_from_slice(&1_f32.to_le_bytes());
    fixture.bad_binary("affine fourth");
    for (field, value) in [("target", 34962), ("byteStride", 64)] {
        let mut invalid = fixture.clone();
        invalid.document["bufferViews"][view][field] = json!(value);
        bad_structure(&invalid);
    }
}

#[test]
fn ibm_types_and_exclusive_data_roles_remain_structural() {
    let mut fixture = ordinary();
    let ibm = fixture.accessor(5126, "MAT4", 4, &matrices(4), false);
    fixture.document["skins"][0]["inverseBindMatrices"] = json!(ibm);
    for (field, value) in [
        ("normalized", json!(true)),
        ("componentType", json!(5123)),
        ("type", json!("VEC4")),
    ] {
        let mut invalid = fixture.clone();
        invalid.document["accessors"][ibm][field] = value;
        bad_structure(&invalid);
    }
    let view = fixture.document["accessors"][ibm]["bufferView"]
        .as_u64()
        .unwrap();
    let extra = fixture.document["accessors"].as_array().unwrap().len();
    fixture.document["accessors"].as_array_mut().unwrap().push(json!({"bufferView":view,"componentType":5126,"count":1,"type":"SCALAR","min":[1],"max":[1]}));
    fixture.document["animations"] = json!([{"samplers":[{"input":extra,"output":extra}],"channels":[{"sampler":0,"target":{"path":"translation"}}]}]);
    bad_structure(&fixture);
}

#[test]
fn any_float_sets_keep_only_mandatory_weight_constraints() {
    let mut fixture = Fixture::new(2);
    fixture.group(3, &[5121, 5126], 5121);
    let integer = fixture.attr(0, "WEIGHTS_0");
    let float = fixture.attr(0, "WEIGHTS_1");
    for vertex in 0..3 {
        fixture.write(integer, vertex, 0, 255.);
        fixture.write(float, vertex, 0, 2.);
    }
    fixture.good();
    fixture.write(float, 0, 0, -0.25);
    fixture.bad_binary("nonnegative");
    for vertex in 0..3 {
        fixture.write(integer, vertex, 0, 0.);
        fixture.write(float, vertex, 0, 0.);
    }
    fixture.good();
}

#[test]
fn canonical_group_dedup_keeps_author_consumer_count_and_alias_bounds() {
    let mut fixture = ordinary();
    let primitive = fixture.document["meshes"][0]["primitives"][0].clone();
    fixture.document["meshes"][0]["primitives"]
        .as_array_mut()
        .unwrap()
        .push(primitive);
    let checked = fixture.good();
    assert_eq!(checked.resource().structure.skin_binding_pair_refs, 2);
    assert_eq!(checked.unique_layouts(), 4);
    let weight = fixture.attr(0, "WEIGHTS_0");
    let mut alias = fixture.document["accessors"][weight].clone();
    alias["min"] = json!([0, 0, 0, 0]);
    let index = fixture.document["accessors"].as_array().unwrap().len();
    fixture.document["accessors"]
        .as_array_mut()
        .unwrap()
        .push(alias);
    fixture.document["meshes"][0]["primitives"][1]["attributes"]["WEIGHTS_0"] = json!(index);
    fixture.bad_binary("extrema");
    fixture.document["accessors"][index]["min"] = json!([255, 0, 0, 0]);
    assert_eq!(fixture.good().unique_layouts(), 4);
}

#[test]
fn a_shared_joint_job_keeps_distinct_weight_partners() {
    let mut fixture = Fixture::new(2);
    fixture.group(3, &[5121], 5121);
    fixture.group(3, &[5121], 5121);
    let first = fixture.attr(0, "JOINTS_0");
    let old = fixture.attr(1, "JOINTS_0");
    fixture.document["meshes"][1]["primitives"][0]["attributes"]["JOINTS_0"] = json!(first);
    fixture.document["meshes"][1]["primitives"][0]["attributes"]["_OLD_JOINTS"] = json!(old);
    fixture.good();
    let second_weight = fixture.attr(1, "WEIGHTS_0");
    fixture.write(second_weight, 0, 0, 127.);
    fixture.write(second_weight, 0, 1, 128.);
    fixture.bad_binary("same joint");
    fixture.write(first, 0, 1, 1.);
    fixture.good();
    fixture.document["meshes"].as_array_mut().unwrap().reverse();
    fixture.good();
}

#[test]
fn all_sixty_nonzero_influences_use_the_last_active_slot() {
    let mut fixture = Fixture::new(60);
    fixture.group(1, &[5121; 15], 5121);
    for set in 0..15 {
        let joint = fixture.attr(0, &format!("JOINTS_{set}"));
        let weight = fixture.attr(0, &format!("WEIGHTS_{set}"));
        for component in 0..4 {
            let influence = set * 4 + component;
            fixture.write(joint, 0, component, influence as f64);
            fixture.write(weight, 0, component, if influence == 59 { 19. } else { 4. });
        }
    }
    fixture.good();
    let last_joint = fixture.attr(0, "JOINTS_14");
    fixture.write(last_joint, 0, 3, 0.);
    fixture.bad_binary("same joint");
}

#[test]
fn one_weight_job_observes_both_sets_of_the_same_group() {
    let mut fixture = Fixture::new(2);
    fixture.group(1, &[5126, 5126], 5121);
    let shared = fixture.attr(0, "WEIGHTS_0");
    let old = fixture.attr(0, "WEIGHTS_1");
    fixture.write(shared, 0, 0, 0.5);
    fixture.document["meshes"][0]["primitives"][0]["attributes"]["WEIGHTS_1"] = json!(shared);
    fixture.document["meshes"][0]["primitives"][0]["attributes"]["_OLD_WEIGHTS"] = json!(old);
    fixture.good();
    let second = fixture.attr(0, "JOINTS_1");
    fixture.write(second, 0, 0, 0.);
    fixture.bad_binary("same joint");
}

#[test]
fn morph_targets_cannot_use_skin_semantics() {
    for semantic in ["JOINTS_0", "WEIGHTS_0"] {
        let mut fixture = ordinary();
        let accessor = fixture.attr(0, semantic);
        fixture.document["meshes"][0]["primitives"][0]["targets"] = json!([{semantic:accessor}]);
        bad_structure(&fixture);
    }
}

struct ShortReader<'a> {
    bytes: &'a [u8],
    consumed: usize,
    max_requested: usize,
}
impl Read for ShortReader<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        self.max_requested = self.max_requested.max(output.len());
        let count = output.len().min(3).min(self.bytes.len() - self.consumed);
        output[..count].copy_from_slice(&self.bytes[self.consumed..self.consumed + count]);
        self.consumed += count;
        Ok(count)
    }
}
#[test]
fn nonseekable_distant_stream_hashes_unused_bytes_and_rejects_truncation() {
    let mut fixture = Fixture::new(2);
    fixture.gap = 65_540;
    fixture.group(2, &[5121, 5121], 5121);
    let bytes = fixture.bytes();
    let mut reader = ShortReader {
        bytes: &bytes,
        consumed: 0,
        max_requested: 0,
    };
    let checked = inspect_glb_resource_content(
        &mut reader,
        bytes.len() as u64,
        &manifest(),
        "assets/model.glb",
    )
    .unwrap();
    assert_eq!(reader.consumed, bytes.len());
    assert!(reader.max_requested <= 65_536);
    assert_eq!(
        checked.sha256_hex(),
        format!("{:x}", Sha256::digest(&bytes))
    );
    fixture.data[8] ^= 1;
    let changed = fixture.good();
    assert_ne!(changed.sha256(), checked.sha256());
    let bytes = fixture.bytes();
    let mut reader = ShortReader {
        bytes: &bytes[..bytes.len() - 1],
        consumed: 0,
        max_requested: 0,
    };
    assert!(inspect_glb_resource_content(
        &mut reader,
        bytes.len() as u64,
        &manifest(),
        "assets/model.glb"
    )
    .is_err());
    let weight = fixture.attr(0, "WEIGHTS_1");
    fixture.write(weight, 0, 0, 0.);
    let bytes = fixture.bytes();
    let mut reader = ShortReader {
        bytes: &bytes,
        consumed: 0,
        max_requested: 0,
    };
    assert_eq!(
        inspect_glb_resource_content(
            &mut reader,
            bytes.len() as u64,
            &manifest(),
            "assets/model.glb"
        )
        .unwrap_err()
        .code,
        "invalid_model_binary"
    );
    assert!(reader.max_requested <= 65_536);
}

fn reject_before_bin(fixture: &Fixture, message: &str) {
    assert!(
        !fixture
            .metadata()
            .unwrap()
            .structure
            .binary_content_validated
    );
    let bytes = fixture.bytes();
    let bin_start = prefix(&fixture.document, fixture.data.len().div_ceil(4) * 4).len();
    let mut reader = ShortReader {
        bytes: &bytes,
        consumed: 0,
        max_requested: 0,
    };
    let error = inspect_glb_resource_content(
        &mut reader,
        bytes.len() as u64,
        &manifest(),
        "assets/model.glb",
    )
    .unwrap_err();
    assert_eq!(error.code, "model_binary_limit");
    assert!(error.message.contains(message), "{error:?}");
    assert_eq!(reader.consumed, bin_start);
    assert_eq!(reader.consumed.saturating_sub(bin_start), 0);
}
#[test]
fn exact_default_state_cap_scans_and_one_vertex_over_reads_zero_bin() {
    assert_eq!(24 * 699_034 + 40 + 360, MAX_MODEL_SKIN_ASSOCIATION_BYTES);
    let mut fixture = Fixture::new(2);
    fixture.group(699_034, &[5121], 5121);
    fixture.group(1, &[5121, 5121], 5121);
    let checked = fixture.good();
    assert_eq!(checked.unique_layouts(), 9);
    assert_eq!(checked.checked_elements(), 3 * 699_034 + 5 + 3);
    assert_eq!(checked.checked_components(), 11 * 699_034 + 19 + 3);
    let mut over = Fixture::new(2);
    over.group(699_035, &[5121], 5121);
    over.group(1, &[5121, 5121], 5121);
    reject_before_bin(&over, "skin association state");
}
#[test]
fn exact_default_work_cap_scans_and_one_vertex_over_reads_zero_bin() {
    assert_eq!(
        2072 * 32_387 + 128 * 8 + 70 * 24 + 296,
        MAX_MODEL_SKIN_ASSOCIATION_WORK
    );
    let mut fixture = Fixture::new(15);
    fixture.group(32_387, &[5121; 15], 5121);
    fixture.group(8, &[5121; 3], 5121);
    fixture.group(24, &[5121; 2], 5121);
    let checked = fixture.good();
    assert_eq!(checked.unique_layouts(), 44);
    assert_eq!(checked.checked_elements(), 1_004_176);
    assert_eq!(checked.checked_components(), 3_984_276);
    assert_eq!(checked.resource().structure.skin_binding_pair_refs, 20);
    assert_eq!(
        24 * 3 + 32 * 20 + 24 * 44 + 248 * 32_387 + 56 * 8 + 40 * 24,
        8_035_152
    );
    let mut over = Fixture::new(15);
    over.group(32_387, &[5121; 15], 5121);
    over.group(8, &[5121; 3], 5121);
    over.group(25, &[5121; 2], 5121);
    reject_before_bin(&over, "skin association work");
}

#[test]
fn skin_author_totals_reject_before_binary() {
    let mut fixture = ordinary();
    fixture.document["skins"] = json!(vec![json!({"joints":[1,2,3,4]}); MAX_MODEL_RECORDS / 4 + 1]);
    assert_eq!(
        fixture.metadata().unwrap_err().code,
        "model_structure_limit"
    );
    let mut fixture = ordinary();
    let primitive = fixture.document["meshes"][0]["primitives"][0].clone();
    fixture.document["meshes"][0]["primitives"] = json!(vec![primitive; 5]);
    fixture.document["nodes"] = json!(vec![json!({"mesh":0,"skin":0}); 4000]);
    fixture.document.as_object_mut().unwrap().remove("scenes");
    fixture.document.as_object_mut().unwrap().remove("scene");
    assert_eq!(
        fixture.metadata().unwrap_err().code,
        "model_structure_limit"
    );
}

fn package(
    fixture: &Fixture,
    variant: bool,
    bad_hash: bool,
    bad_mime: bool,
) -> (Vec<u8>, Manifest) {
    let path = if variant {
        "assets/low.glb"
    } else {
        "assets/model.glb"
    };
    let mut files = vec![(path.to_owned(), fixture.bytes())];
    if variant {
        files.push(("assets/model.glb".into(), ordinary().bytes()));
    }
    let mut doc = serde_json::to_value(manifest()).unwrap();
    doc["assets"] = json!([{"id":"model","kind":"model","source":"assets/model.glb","variants":if variant {json!([{"id":"low","file":path,"purpose":"low"}])}else{json!([])}}]);
    doc["files"] = json!(files.iter().map(|(name,bytes)|json!({"path":name,"bytes":bytes.len(),"sha256":if bad_hash && name==path {"00".repeat(32)}else{format!("{:x}",Sha256::digest(bytes))},"mime":if bad_mime && name==path {"image/png"}else{"model/gltf-binary"}})).collect::<Vec<_>>());
    let parsed = serde_json::from_value(doc.clone()).unwrap();
    files.push(("manifest.json".into(), serde_json::to_vec(&doc).unwrap()));
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in files {
        writer
            .start_file(name, SimpleFileOptions::default())
            .unwrap();
        writer.write_all(&bytes).unwrap();
    }
    (writer.finish().unwrap().into_inner(), parsed)
}
fn package_error(package: &(Vec<u8>, Manifest), archive: bool) -> PackageError {
    if archive {
        validate_archive(Cursor::new(&package.0), &package.1).unwrap_err()
    } else {
        validate_package(Cursor::new(&package.0)).unwrap_err()
    }
}
#[test]
fn both_package_entries_check_source_and_variant_and_keep_hash_mime_priority() {
    for variant in [false, true] {
        for archive in [false, true] {
            let fixture = ordinary();
            let (bytes, parsed) = package(&fixture, variant, false, false);
            if archive {
                validate_archive(Cursor::new(&bytes), &parsed).unwrap();
            } else {
                validate_package(Cursor::new(&bytes)).unwrap();
            }
            let mut bad = fixture;
            let joint = bad.attr(0, "JOINTS_0");
            bad.write(joint, 0, 3, 99.);
            assert!(bad.metadata().is_ok());
            let error = package_error(&package(&bad, variant, false, false), archive);
            assert_eq!(error.code, "invalid_model_binary");
            assert!(error.message.contains(if variant {
                "assets/low.glb"
            } else {
                "assets/model.glb"
            }));
            assert_eq!(
                package_error(&package(&bad, variant, true, false), archive).code,
                "hash_mismatch"
            );
            assert_eq!(
                package_error(&package(&bad, variant, false, true), archive).code,
                "model_container_unavailable"
            );
        }
    }
}
