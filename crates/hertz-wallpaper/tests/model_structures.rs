// SPDX-License-Identifier: MIT
//! Real GLB/ZIP structure fixtures. Metadata bounds are not binary validity or
//! renderer qualification; the runtime model gate remains independently shut.

use hertz_wallpaper::{
    model_structure::{
        inspect_glb_resource, AccessorShape, GlbResource, ModelImage, MAX_MODEL_NODES,
        MAX_MODEL_RECORDS,
    },
    validate_archive, validate_package, Manifest,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Cursor, Write};
use zip::{write::SimpleFileOptions, ZipWriter};

fn glb(document: &Value, binary: Option<&[u8]>) -> Vec<u8> {
    let mut json = serde_json::to_vec(document).unwrap();
    while !json.len().is_multiple_of(4) {
        json.push(b' ');
    }
    let mut binary = binary.map(|bytes| bytes.to_vec());
    if let Some(binary) = &mut binary {
        while binary.len() % 4 != 0 {
            binary.push(0);
        }
    }
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
fn empty() -> Value {
    json!({"asset":{"version":"2.0"}})
}
fn triangle() -> Value {
    json!({"asset":{"version":"2.0"},
        "buffers":[{"byteLength":42}],
        "bufferViews":[{"buffer":0,"byteLength":36,"target":34962},{"buffer":0,"byteOffset":36,"byteLength":6,"target":34963}],
        "accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]},
            {"bufferView":1,"componentType":5123,"count":3,"type":"SCALAR"}],
        "meshes":[{"primitives":[{"attributes":{"POSITION":0},"indices":1}]}],
        "nodes":[{"mesh":0}],"scenes":[{"nodes":[0]}],"scene":0})
}
fn triangle_binary() -> Vec<u8> {
    let mut bytes = Vec::new();
    for value in [0f32, 0., 0., 1., 0., 0., 0., 1., 0.] {
        bytes.extend(value.to_le_bytes());
    }
    for index in [0u16, 1, 2] {
        bytes.extend(index.to_le_bytes());
    }
    bytes
}
fn manifest() -> Manifest {
    serde_json::from_value(json!({"formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae","version":1,"title":"Model structures",
        "content":{"kind":"builtin","sceneId":"zodiac","stateVersion":1,"params":{}},
        "assets":[],"files":[],"permissions":{"audioSpectrum":false,"pointer":false},
        "license":{"code":"none","assets":"CC0-1.0"}})).unwrap()
}
fn inspect(document: &Value, binary: Option<&[u8]>) -> GlbResource {
    let bytes = glb(document, binary);
    inspect_glb_resource(
        Cursor::new(&bytes),
        bytes.len() as u64,
        &manifest(),
        "assets/model.glb",
    )
    .unwrap()
}
fn error(document: &Value, binary: Option<&[u8]>) -> &'static str {
    let bytes = glb(document, binary);
    inspect_glb_resource(
        Cursor::new(&bytes),
        bytes.len() as u64,
        &manifest(),
        "assets/model.glb",
    )
    .unwrap_err()
    .code
}
fn accessor_document(shape: &str, component: u32, count: u64, length: u64) -> Value {
    json!({"asset":{"version":"2.0"},"buffers":[{"byteLength":length}],
        "bufferViews":[{"buffer":0,"byteLength":length}],
        "accessors":[{"bufferView":0,"componentType":component,"count":count,"type":shape}]})
}
fn image_manifest(path: &str, mime: &str, kind: &str, variant: bool) -> Manifest {
    let mut manifest = manifest();
    manifest.files = serde_json::from_value(
        json!([{"path":path,"bytes":4,"sha256":"ab".repeat(32),"mime":mime}]),
    )
    .unwrap();
    manifest.assets=serde_json::from_value(if variant {
        json!([{"id":"albedo","kind":kind,"source":"assets/source.png","variants":[{"id":"low","file":path,"purpose":"low"}]}])
    } else { json!([{"id":"albedo","kind":kind,"source":path,"variants":[]}]) }).unwrap();
    manifest
}
fn inspect_image(document: &Value, manifest: &Manifest) -> hertz_wallpaper::Result<GlbResource> {
    let bytes = glb(document, None);
    inspect_glb_resource(
        Cursor::new(&bytes),
        bytes.len() as u64,
        manifest,
        "assets/models/model.glb",
    )
}

#[test]
fn real_glb_retains_ranges_and_metadata_without_claiming_binary_validity() {
    let binary = triangle_binary();
    let bytes = glb(&triangle(), Some(&binary));
    let result = inspect_glb_resource(
        Cursor::new(&bytes),
        bytes.len() as u64,
        &manifest(),
        "assets/model.glb",
    )
    .unwrap();
    let structure = result.structure;
    assert_eq!(structure.nodes.len(), 1);
    assert_eq!(structure.mesh_triangles_upper_bound, 1);
    assert_eq!(structure.instantiated_triangles_upper_bound, 1);
    assert!(!structure.binary_content_validated);
    assert_eq!(structure.accessors[0].shape, AccessorShape::Vec3);
    assert_eq!(structure.accessors[0].stride, 12);
    assert_eq!(structure.accessors[1].range.bytes, 6);
    assert_eq!(
        &bytes[structure.accessors[1].range.offset as usize..][..6],
        &[0, 0, 1, 0, 2, 0]
    );
    // An invalid index and a NaN position are deliberately still metadata-only.
    let mut unvalidated = binary;
    unvalidated[..4].copy_from_slice(&f32::NAN.to_le_bytes());
    unvalidated[36..38].copy_from_slice(&999u16.to_le_bytes());
    assert!(
        !inspect(&triangle(), Some(&unvalidated))
            .structure
            .binary_content_validated
    );
}

#[test]
fn empty_models_and_unused_empty_bin_are_format_facts() {
    for binary in [None, Some([].as_slice()), Some([0; 4].as_slice())] {
        let result = inspect(&empty(), binary);
        assert_eq!(result.structure.mesh_triangles_upper_bound, 0);
        assert_eq!(result.structure.instantiated_triangles_upper_bound, 0);
        assert!(!result.structure.binary_content_validated);
    }
}

#[test]
fn buffer_requires_internal_bin_and_exact_standard_padding() {
    let mut document = empty();
    document["buffers"] = json!([{"byteLength":1}]);
    assert_eq!(error(&document, None), "invalid_model_structure");
    for length in 1..=4 {
        document["buffers"][0]["byteLength"] = json!(length);
        inspect(&document, Some(&[0; 4]));
    }
    for length in [0, 5, 8, u64::MAX] {
        document["buffers"][0]["byteLength"] = json!(length);
        assert_eq!(error(&document, Some(&[0; 4])), "invalid_model_structure");
    }
    document["buffers"] = json!([{"byteLength":4},{"byteLength":4}]);
    assert_eq!(error(&document, Some(&[0; 4])), "invalid_model_structure");
    for uri in [
        "buffer.bin",
        "data:application/octet-stream;base64,AAAA",
        "https://example.test/a.bin",
    ] {
        document["buffers"] = json!([{"byteLength":4,"uri":uri}]);
        assert_eq!(
            error(&document, Some(&[0; 4])),
            "model_resource_unavailable"
        );
    }
}

#[test]
fn view_and_accessor_overflows_alignment_and_stride_are_rejected() {
    let mut base = accessor_document("VEC3", 5126, 3, 48);
    base["accessors"][0]["min"] = json!([0, 0, 0]);
    base["accessors"][0]["max"] = json!([1, 1, 1]);
    base["meshes"] = json!([{"primitives":[{"attributes":{"POSITION":0}}]}]);
    for (field, value) in [
        ("buffer", 1),
        ("byteOffset", u64::MAX),
        ("byteLength", u64::MAX),
        ("byteLength", 0),
        ("byteStride", 3),
        ("byteStride", 6),
        ("byteStride", 256),
        ("target", 1),
    ] {
        let mut document = base.clone();
        document["bufferViews"][0][field] = json!(value);
        assert_eq!(
            error(&document, Some(&[0; 48])),
            "invalid_model_structure",
            "{field}={value}"
        );
    }
    for (field, value) in [
        ("bufferView", 1),
        ("byteOffset", u64::MAX),
        ("byteOffset", 1),
        ("count", u64::MAX),
        ("count", 0),
        ("componentType", 5124),
    ] {
        let mut document = base.clone();
        document["accessors"][0][field] = json!(value);
        assert_eq!(
            error(&document, Some(&[0; 48])),
            "invalid_model_structure",
            "{field}={value}"
        );
    }
    let mut document = base.clone();
    document["bufferViews"][0]["byteStride"] = json!(16);
    let fact = &inspect(&document, Some(&[0; 48])).structure.accessors[0];
    assert_eq!((fact.stride, fact.range.bytes), (16, 44));
    document["bufferViews"][0]["byteLength"] = json!(43);
    assert_eq!(error(&document, Some(&[0; 48])), "invalid_model_structure");
    document = base;
    document["bufferViews"][0]["byteStride"] = json!(8);
    assert_eq!(error(&document, Some(&[0; 48])), "invalid_model_structure");
}

#[test]
fn matrix_columns_have_complete_four_byte_padding() {
    for (shape, component, stride, extent) in [
        ("MAT2", 5121, 8, 8),
        ("MAT3", 5121, 12, 12),
        ("MAT3", 5123, 24, 24),
        ("MAT4", 5126, 64, 64),
    ] {
        for count in [1, 2] {
            let length = stride * (count - 1) + extent;
            let document = accessor_document(shape, component, count, length);
            let binary = vec![0; length as usize];
            let result = inspect(&document, Some(&binary));
            assert_eq!(result.structure.accessors[0].stride, stride);
            assert_eq!(result.structure.accessors[0].range.bytes, length);
            let mut short = document.clone();
            short["bufferViews"][0]["byteLength"] = json!(length - 1);
            assert_eq!(error(&short, Some(&binary)), "invalid_model_structure");
        }
    }
    let mut document = accessor_document("MAT2", 5121, 1, 12);
    document["accessors"][0]["byteOffset"] = json!(1);
    inspect(&document, Some(&[0; 12]));
}

#[test]
fn unused_matrix_accessors_require_component_alignment_with_full_column_padding() {
    for (shape, component, offset, element_bytes) in [("MAT2", 5121, 1, 8), ("MAT3", 5123, 2, 24)] {
        let length = offset + element_bytes;
        let mut document = accessor_document(shape, component, 1, length);
        document["bufferViews"][0]["byteOffset"] = json!(offset);
        document["bufferViews"][0]["byteLength"] = json!(element_bytes);
        let result = inspect(&document, Some(&vec![0; length as usize]));
        assert_eq!(result.structure.accessors[0].range.bytes, element_bytes);
        assert!(!result.structure.binary_content_validated);
    }
}

#[test]
fn accessor_normalized_bounds_and_dimensions_must_be_legal() {
    for component in [5125, 5126] {
        let mut document = accessor_document("SCALAR", component, 1, 4);
        document["accessors"][0]["normalized"] = json!(true);
        assert_eq!(error(&document, Some(&[0; 4])), "invalid_model_structure");
    }
    for component in [5120, 5121, 5122, 5123] {
        let mut document = accessor_document("SCALAR", component, 1, 4);
        document["accessors"][0]["normalized"] = json!(true);
        inspect(&document, Some(&[0; 4]));
    }
    for value in [json!([0, 0]), json!([0, 0, 0, 0])] {
        let mut document = triangle();
        document["accessors"][0]["min"] = value;
        assert_eq!(
            error(&document, Some(&triangle_binary())),
            "invalid_model_structure"
        );
    }
    let mut document = triangle();
    document["accessors"][0]["min"] = json!([2, 0, 0]);
    assert_eq!(
        error(&document, Some(&triangle_binary())),
        "invalid_model_structure"
    );
}

#[test]
fn indices_position_attributes_and_triangle_counts_are_checked() {
    for (index, field, value) in [
        (1, "componentType", json!(5122)),
        (1, "normalized", json!(true)),
        (1, "type", json!("VEC2")),
        (0, "componentType", json!(5123)),
        (0, "type", json!("VEC2")),
    ] {
        let mut document = triangle();
        document["accessors"][index][field] = value;
        assert_eq!(
            error(&document, Some(&triangle_binary())),
            "invalid_model_structure"
        );
    }
    let mut document = triangle();
    document["accessors"][1]["count"] = json!(2);
    assert_eq!(
        error(&document, Some(&triangle_binary())),
        "invalid_model_structure"
    );
    let mut document = triangle();
    document["meshes"][0]["primitives"][0]["attributes"]["NORMAL"] = json!(1);
    assert_eq!(
        error(&document, Some(&triangle_binary())),
        "invalid_model_structure"
    );
    let mut document = triangle();
    document["meshes"][0]["primitives"][0]["mode"] = json!(5);
    assert_eq!(
        error(&document, Some(&triangle_binary())),
        "model_resource_unavailable"
    );
    let mut document = triangle();
    document["bufferViews"][1]["byteStride"] = json!(4);
    assert_eq!(
        error(&document, Some(&triangle_binary())),
        "invalid_model_structure"
    );
    let mut document = triangle();
    document["meshes"][0]["primitives"][0]["indices"] = json!(9);
    assert_eq!(
        error(&document, Some(&triangle_binary())),
        "invalid_model_structure"
    );
    let mut nonindexed = triangle();
    nonindexed["meshes"][0]["primitives"][0]
        .as_object_mut()
        .unwrap()
        .remove("indices");
    assert_eq!(
        inspect(&nonindexed, Some(&triangle_binary()))
            .structure
            .mesh_triangles_upper_bound,
        1
    );
    nonindexed["accessors"][0]["count"] = json!(2);
    assert_eq!(
        error(&nonindexed, Some(&triangle_binary())),
        "invalid_model_structure"
    );
}

#[test]
fn attributes_cannot_disagree_on_vertex_count_or_target() {
    let mut document = triangle();
    document["accessors"]
        .as_array_mut()
        .unwrap()
        .push(json!({"bufferView":0,"componentType":5126,"count":2,"type":"VEC3"}));
    document["meshes"][0]["primitives"][0]["attributes"]["NORMAL"] = json!(2);
    assert_eq!(
        error(&document, Some(&triangle_binary())),
        "invalid_model_structure"
    );
    let mut document = triangle();
    document["bufferViews"][0]["target"] = json!(34963);
    assert_eq!(
        error(&document, Some(&triangle_binary())),
        "invalid_model_structure"
    );
    let mut document = triangle();
    document["bufferViews"][1]["target"] = json!(34962);
    assert_eq!(
        error(&document, Some(&triangle_binary())),
        "invalid_model_structure"
    );
}

#[test]
fn position_bounds_are_required_and_preserved_for_binary_continuation() {
    let result = inspect(&triangle(), Some(&triangle_binary()));
    assert_eq!(
        result.structure.accessors[0].min.as_deref(),
        Some([0., 0., 0.].as_slice())
    );
    assert_eq!(
        result.structure.accessors[0].max.as_deref(),
        Some([1., 1., 0.].as_slice())
    );
    for bound in ["min", "max"] {
        let mut document = triangle();
        document["accessors"][0]
            .as_object_mut()
            .unwrap()
            .remove(bound);
        assert_eq!(
            error(&document, Some(&triangle_binary())),
            "invalid_model_structure"
        );
    }
    for (component, bound) in [
        (5121, json!([-1])),
        (5121, json!([256])),
        (5123, json!([65536])),
        (5122, json!([0.5])),
        (5126, json!([1e100])),
    ] {
        let mut document = accessor_document("SCALAR", component, 1, 4);
        document["accessors"][0]["min"] = bound;
        assert_eq!(error(&document, Some(&[0; 4])), "invalid_model_structure");
    }
}

#[test]
fn byte_vertex_attributes_require_explicit_stride_including_packed_rgba() {
    for shape in ["VEC3", "VEC4"] {
        let mut document = triangle();
        document["buffers"][0]["byteLength"] = json!(56);
        document["bufferViews"]
            .as_array_mut()
            .unwrap()
            .push(json!({"buffer":0,"byteOffset":44,"byteLength":12}));
        document["accessors"].as_array_mut().unwrap().push(
            json!({"bufferView":2,"componentType":5121,"count":3,"type":shape,"normalized":true}),
        );
        document["meshes"][0]["primitives"][0]["attributes"]["COLOR_0"] = json!(2);
        assert_eq!(error(&document, Some(&[0; 56])), "invalid_model_structure");
        document["bufferViews"][2]["byteStride"] = json!(4);
        inspect(&document, Some(&[0; 56]));
    }
}

#[test]
fn indexed_vertex_attribute_semantics_are_decimal_contiguous_and_bounded() {
    for name in [
        "COLOR_01",
        "COLOR_+1",
        "COLOR_1000000000",
        "COLOR_2",
        "TEXCOORD_1",
    ] {
        let mut document = triangle();
        document["meshes"][0]["primitives"][0]["attributes"][name] = json!(0);
        assert_eq!(
            error(&document, Some(&triangle_binary())),
            "invalid_model_structure",
            "{name}"
        );
    }
    let mut document = triangle();
    document["meshes"][0]["primitives"][0]["attributes"]["COLOR_0"] = json!(0);
    document["meshes"][0]["primitives"][0]["attributes"]["COLOR_1"] = json!(0);
    inspect(&document, Some(&triangle_binary()));
}

#[test]
fn application_vertex_semantics_accept_lowercase_and_uint32_without_claiming_custom_matrices() {
    let mut document = triangle();
    document["meshes"][0]["primitives"][0]["attributes"]["_temperature"] = json!(0);
    inspect(&document, Some(&triangle_binary()));
    document["buffers"][0]["byteLength"] = json!(56);
    document["bufferViews"]
        .as_array_mut()
        .unwrap()
        .push(json!({"buffer":0,"byteOffset":44,"byteLength":12}));
    document["accessors"]
        .as_array_mut()
        .unwrap()
        .push(json!({"bufferView":2,"componentType":5125,"count":3,"type":"SCALAR"}));
    document["meshes"][0]["primitives"][0]["attributes"]["_integer"] = json!(2);
    inspect(&document, Some(&[0; 56]));
    document["buffers"][0]["byteLength"] = json!(92);
    document["bufferViews"][2]["byteLength"] = json!(48);
    document["accessors"][2]["componentType"] = json!(5126);
    document["accessors"][2]["type"] = json!("MAT2");
    assert_eq!(
        error(&document, Some(&[0; 92])),
        "model_resource_unavailable"
    );
}

#[test]
fn byte_and_short_vertex_alignment_is_relative_to_the_view() {
    for (component, color_offset, stride, color_length, bytes) in
        [(5121, 43, 4, 12, 55), (5123, 2, 8, 24, 70)]
    {
        let mut document = triangle();
        document["buffers"][0]["byteLength"] = json!(bytes);
        if component == 5123 {
            document["bufferViews"][0]["byteOffset"] = json!(28);
            document["bufferViews"][1]["byteOffset"] = json!(64);
        }
        document["bufferViews"].as_array_mut().unwrap().push(json!({"buffer":0,"byteOffset":color_offset,"byteLength":color_length,"byteStride":stride}));
        document["accessors"].as_array_mut().unwrap().push(json!({"bufferView":2,"componentType":component,"count":3,"type":"VEC3","normalized":true}));
        document["meshes"][0]["primitives"][0]["attributes"]["COLOR_0"] = json!(2);
        let result = inspect(&document, Some(&vec![0; bytes as usize]));
        assert_eq!(result.structure.mesh_triangles_upper_bound, 1);
        assert_eq!(result.structure.accessors[2].byte_offset, 0);
        if component == 5123 {
            document["bufferViews"][2]["byteOffset"] = json!(3);
            assert_eq!(
                error(&document, Some(&vec![0; bytes as usize])),
                "invalid_model_structure"
            );
        }
    }
}

#[test]
fn buffer_view_data_roles_and_cross_mesh_attribute_stride_are_global() {
    let mut document = triangle();
    document["bufferViews"][0]
        .as_object_mut()
        .unwrap()
        .remove("target");
    document["bufferViews"][1]
        .as_object_mut()
        .unwrap()
        .remove("target");
    document["accessors"][1]["bufferView"] = json!(0);
    assert_eq!(
        error(&document, Some(&triangle_binary())),
        "invalid_model_structure"
    );
    let mut document = triangle();
    document["bufferViews"][0]
        .as_object_mut()
        .unwrap()
        .remove("target");
    document["images"] = json!([{"bufferView":0,"mimeType":"image/png"}]);
    assert_eq!(
        error(&document, Some(&triangle_binary())),
        "invalid_model_structure"
    );
    let mut document = triangle();
    document["bufferViews"][1]
        .as_object_mut()
        .unwrap()
        .remove("target");
    document["images"] = json!([{"bufferView":1,"mimeType":"image/png"}]);
    assert_eq!(
        error(&document, Some(&triangle_binary())),
        "invalid_model_structure"
    );
    let mut document = triangle();
    let other_accessor = document["accessors"][0].clone();
    document["accessors"]
        .as_array_mut()
        .unwrap()
        .push(other_accessor);
    let mut other = document["meshes"][0].clone();
    other["primitives"][0]["attributes"]["POSITION"] = json!(2);
    document["meshes"].as_array_mut().unwrap().push(other);
    assert_eq!(
        error(&document, Some(&triangle_binary())),
        "invalid_model_structure"
    );
    document["bufferViews"][0]["byteStride"] = json!(12);
    assert_eq!(
        inspect(&document, Some(&triangle_binary()))
            .structure
            .mesh_triangles_upper_bound,
        2
    );
    let mut document = accessor_document("VEC3", 5126, 1, 16);
    document["bufferViews"][0]["byteStride"] = json!(16);
    assert_eq!(error(&document, Some(&[0; 16])), "invalid_model_structure");
}

#[test]
fn view_stride_must_fit_view_even_for_single_vertex_indexed_triangles() {
    let mut document = triangle();
    document["buffers"][0]["byteLength"] = json!(18);
    document["bufferViews"][0]["byteLength"] = json!(12);
    document["bufferViews"][0]["byteStride"] = json!(16);
    document["bufferViews"][1]["byteOffset"] = json!(12);
    document["accessors"][0]["count"] = json!(1);
    assert_eq!(error(&document, Some(&[0; 18])), "invalid_model_structure");
    document["bufferViews"][0]["byteStride"] = json!(12);
    let result = inspect(&document, Some(&[0; 18]));
    assert_eq!(result.structure.mesh_triangles_upper_bound, 1);
    assert!(!result.structure.binary_content_validated);
}

#[test]
fn whole_embedded_image_view_cannot_have_even_an_unused_accessor() {
    let mut document = accessor_document("VEC3", 5126, 1, 12);
    document["images"] = json!([{"bufferView":0,"mimeType":"image/png"}]);
    assert_eq!(error(&document, Some(&[0; 12])), "invalid_model_structure");
    document.as_object_mut().unwrap().remove("accessors");
    let result = inspect(&document, Some(&[0; 12]));
    assert_eq!(result.structure.images.len(), 1);
    assert!(!result.structure.binary_content_validated);
}

#[test]
fn node_graph_rejects_duplicate_multi_parent_cycles_and_bad_scene_roots() {
    for nodes in [
        json!([{"children":[1,1]},{}]),
        json!([{"children":[2]},{"children":[2]},{}]),
        json!([{"children":[1]},{"children":[0]}]),
        json!([{"children":[0]}]),
        json!([{"children":[8]}]),
    ] {
        let mut document = empty();
        document["nodes"] = nodes;
        assert_eq!(error(&document, None), "invalid_model_structure");
    }
    for roots in [json!([1]), json!([0, 0]), json!([9])] {
        let mut document = empty();
        document["nodes"] = json!([{"children":[1]},{}]);
        document["scenes"] = json!([{"nodes":roots}]);
        assert_eq!(error(&document, None), "invalid_model_structure");
    }
    let mut document = empty();
    document["scene"] = json!(0);
    assert_eq!(error(&document, None), "invalid_model_structure");
}

#[test]
fn maximum_depth_five_thousand_node_chain_uses_bounded_iterative_graph_walk() {
    let nodes = (0..MAX_MODEL_NODES)
        .map(|index| {
            if index + 1 < MAX_MODEL_NODES {
                json!({"children":[index+1]})
            } else {
                json!({})
            }
        })
        .collect::<Vec<_>>();
    let mut document = empty();
    document["nodes"] = json!(nodes);
    document["scenes"] = json!([{"nodes":[0]}]);
    assert_eq!(
        inspect(&document, None).structure.nodes.len(),
        MAX_MODEL_NODES
    );
    document["nodes"][MAX_MODEL_NODES - 1]["children"] = json!([0]);
    assert_eq!(error(&document, None), "invalid_model_structure");
}

#[test]
fn transforms_and_camera_references_are_closed_without_changing_composition_camera() {
    for node in [
        json!({"matrix":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],"translation":[0,0,0]}),
        json!({"rotation":[0,0,0,0]}),
        json!({"rotation":[0,0,1]}),
        json!({"translation":[0,0]}),
        json!({"mesh":0}),
        json!({"camera":0}),
    ] {
        let mut document = empty();
        document["nodes"] = json!([node]);
        assert_eq!(error(&document, None), "invalid_model_structure");
    }
    let mut document = empty();
    document["nodes"] = json!([{"rotation":[0,0,0,1],"camera":0}]);
    document["cameras"] =
        json!([{"type":"perspective","perspective":{"yfov":1,"znear":0.1,"zfar":100}}]);
    assert_eq!(inspect(&document, None).structure.nodes.len(), 1);
    document["cameras"][0]["perspective"]["zfar"] = json!(0.1);
    assert_eq!(error(&document, None), "invalid_model_structure");
    document["cameras"] =
        json!([{"type":"orthographic","orthographic":{"xmag":1,"ymag":1,"znear":0,"zfar":1}}]);
    inspect(&document, None);
}

#[test]
fn node_matrices_are_decomposable_trs_and_explicit_trs_can_have_zero_scale() {
    let identity = json!([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    let mut document = empty();
    document["nodes"] = json!([{"matrix":identity.clone()}]);
    inspect(&document, None);
    document["nodes"][0]["matrix"][0] = json!(-2);
    document["nodes"][0]["matrix"][5] = json!(3);
    document["nodes"][0]["matrix"][10] = json!(4);
    document["nodes"][0]["matrix"][12] = json!(20);
    inspect(&document, None);
    for (index, value) in [
        (3, json!(1)),
        (15, json!(0)),
        (0, json!(0)),
        (4, json!(1)),
        (4, json!(0.01)),
    ] {
        document["nodes"][0]["matrix"] = identity.clone();
        document["nodes"][0]["matrix"][index] = value;
        assert_eq!(
            error(&document, None),
            "invalid_model_structure",
            "matrix[{index}]"
        );
    }
    document["nodes"] = json!([{"translation":[0,0,0],"scale":[0,1,1],"rotation":[0,0,0,1]}]);
    inspect(&document, None);
}

#[test]
fn metadata_triangle_limit_counts_unselected_mesh_instances() {
    let mut document = triangle();
    // Reusing the valid small POSITION accessor with a large index count does
    // not validate the index values. It does establish a conservative count.
    let count = 600_000u64;
    let length = 36 + count * 2;
    document["buffers"][0]["byteLength"] = json!(length);
    document["bufferViews"][1]["byteLength"] = json!(count * 2);
    document["accessors"][1]["count"] = json!(count);
    let binary = vec![0; length as usize];
    document["nodes"] = json!([{"mesh":0},{"mesh":0},{"mesh":0},{"mesh":0},{"mesh":0}]);
    document["scenes"] = json!([{"nodes":[0]}]);
    let result = inspect(&document, Some(&binary));
    assert_eq!(result.structure.mesh_triangles_upper_bound, 200_000);
    assert_eq!(
        result.structure.instantiated_triangles_upper_bound,
        1_000_000
    );
    document["nodes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"mesh":0}));
    assert_eq!(error(&document, Some(&binary)), "model_structure_limit");
    document["nodes"] = json!([]);
    document["scenes"] = json!([]);
    document["meshes"] = json!(vec![document["meshes"][0].clone(); 6]);
    assert_eq!(error(&document, Some(&binary)), "model_structure_limit");
}

#[test]
fn orthographic_magnitudes_allow_negative_values_but_require_nonzero() {
    let mut document = empty();
    document["cameras"] =
        json!([{"type":"orthographic","orthographic":{"xmag":-1,"ymag":-2,"znear":0,"zfar":1}}]);
    inspect(&document, None);
    for field in ["xmag", "ymag"] {
        let mut invalid = document.clone();
        invalid["cameras"][0]["orthographic"][field] = json!(0);
        assert_eq!(error(&invalid, None), "invalid_model_structure");
    }
}

#[test]
fn package_image_source_and_variants_produce_typed_broker_references() {
    let mut document = empty();
    document["images"] = json!([{"uri":"textures/albedo.png","mimeType":"image/png"}]);
    for kind in ["image", "texture"] {
        for variant in [false, true] {
            let manifest = image_manifest(
                "assets/models/textures/albedo.png",
                "image/png",
                kind,
                variant,
            );
            let result = inspect_image(&document, &manifest).unwrap();
            match &result.structure.images[0] {
                ModelImage::Package {
                    path,
                    mime,
                    bytes,
                    sha256,
                    references,
                } => {
                    assert_eq!(path, "assets/models/textures/albedo.png");
                    assert_eq!(mime, "image/png");
                    assert_eq!(*bytes, 4);
                    assert_eq!(sha256, &"ab".repeat(32));
                    assert_eq!(references[0].asset_id, "albedo");
                    assert_eq!(
                        references[0].variant_id.as_deref(),
                        variant.then_some("low")
                    );
                }
                _ => panic!("expected package image"),
            }
        }
    }
}

#[test]
fn repeated_images_share_broker_aliases_instead_of_multiplying_manifest_memory() {
    let mut document = empty();
    document["images"] = json!(vec![json!({"uri":"albedo.png"}); 4096]);
    let mut manifest = image_manifest("assets/models/albedo.png", "image/png", "image", false);
    manifest.assets=(0..1000).map(|index| serde_json::from_value(json!({"id":format!("alias-{index}"),"kind":"image","source":"assets/models/albedo.png","variants":[]})).unwrap()).collect();
    let result = inspect_image(&document, &manifest).unwrap();
    let ModelImage::Package {
        references: first, ..
    } = &result.structure.images[0]
    else {
        panic!("package image expected")
    };
    assert_eq!(first.len(), 1000);
    for image in &result.structure.images {
        let ModelImage::Package { references, .. } = image else {
            panic!("package image expected")
        };
        assert!(std::sync::Arc::ptr_eq(first, references));
    }
}

#[test]
fn package_images_reject_external_ambiguous_untyped_and_wrong_mime_references() {
    let manifest = image_manifest("assets/models/albedo.png", "image/png", "image", false);
    for uri in [
        "../albedo.png",
        "/albedo.png",
        "https://example.test/albedo.png",
        "data:image/png;base64,AAAA",
        "albedo%2epng",
        "albedo.png?x=1",
        "albedo.png#x",
        r"textures\albedo.png",
        "C:/albedo.png",
        "Albedo.png",
    ] {
        let mut document = empty();
        document["images"] = json!([{"uri":uri}]);
        assert_eq!(
            inspect_image(&document, &manifest).unwrap_err().code,
            "model_resource_unavailable",
            "{uri}"
        );
    }
    let mut document = empty();
    document["images"] = json!([{"uri":"missing.png"}]);
    assert_eq!(
        inspect_image(&document, &manifest).unwrap_err().code,
        "invalid_model_structure"
    );
    document["images"] = json!([{"uri":"albedo.png","mimeType":"image/jpeg"}]);
    assert_eq!(
        inspect_image(&document, &manifest).unwrap_err().code,
        "invalid_model_structure"
    );
    document["images"] = json!([{"uri":"albedo.png"}]);
    let wrong = image_manifest("assets/models/albedo.png", "image/png", "model", false);
    assert_eq!(
        inspect_image(&document, &wrong).unwrap_err().code,
        "invalid_model_structure"
    );
    let wrong = image_manifest("assets/models/albedo.png", "image/ktx2", "texture", false);
    assert_eq!(
        inspect_image(&document, &wrong).unwrap_err().code,
        "model_resource_unavailable"
    );
    document["images"] = json!([{"uri":"albedo.png","bufferView":0}]);
    assert_eq!(
        inspect_image(&document, &manifest).unwrap_err().code,
        "invalid_model_structure"
    );
}

#[test]
fn embedded_images_retain_bounded_binary_range_and_required_mime() {
    let mut document = empty();
    document["buffers"] = json!([{"byteLength":4}]);
    document["bufferViews"] = json!([{"buffer":0,"byteLength":4}]);
    document["images"] = json!([{"bufferView":0,"mimeType":"image/png"}]);
    let result = inspect(&document, Some(&[0; 4]));
    match &result.structure.images[0] {
        ModelImage::Embedded { range, mime, .. } => {
            assert_eq!(range.bytes, 4);
            assert_eq!(mime, "image/png");
        }
        _ => panic!("embedded image expected"),
    }
    assert!(!result.structure.binary_content_validated);
    for image in [
        json!({"bufferView":0}),
        json!({"bufferView":9,"mimeType":"image/png"}),
        json!({}),
        json!({"bufferView":0,"mimeType":"image/webp"}),
    ] {
        document["images"] = json!([image]);
        assert!(matches!(
            error(&document, Some(&[0; 4])),
            "invalid_model_structure" | "model_resource_unavailable"
        ));
    }
}

#[test]
fn texture_sampler_and_every_core_material_texture_reference_are_closed() {
    let mut document = empty();
    document["buffers"] = json!([{"byteLength":4}]);
    document["bufferViews"] = json!([{"buffer":0,"byteLength":4}]);
    document["images"] = json!([{"bufferView":0,"mimeType":"image/png"}]);
    document["samplers"] = json!([{}]);
    document["textures"] = json!([{"source":0,"sampler":0}]);
    document["materials"] = json!([{"pbrMetallicRoughness":{"baseColorTexture":{"index":0},"metallicRoughnessTexture":{"index":0}},"normalTexture":{"index":0},"occlusionTexture":{"index":0},"emissiveTexture":{"index":0}}]);
    inspect(&document, Some(&[0; 4]));
    for pointer in [
        "/textures/0/source",
        "/textures/0/sampler",
        "/materials/0/pbrMetallicRoughness/baseColorTexture/index",
        "/materials/0/pbrMetallicRoughness/metallicRoughnessTexture/index",
        "/materials/0/normalTexture/index",
        "/materials/0/occlusionTexture/index",
        "/materials/0/emissiveTexture/index",
    ] {
        let mut invalid = document.clone();
        *invalid.pointer_mut(pointer).unwrap() = json!(8);
        assert_eq!(
            error(&invalid, Some(&[0; 4])),
            "invalid_model_structure",
            "{pointer}"
        );
    }
    for pointer in [
        "/samplers/0/magFilter",
        "/samplers/0/minFilter",
        "/samplers/0/wrapS",
        "/samplers/0/wrapT",
    ] {
        let mut invalid = document.clone();
        let (object, key) = pointer.rsplit_once('/').unwrap();
        invalid.pointer_mut(object).unwrap()[key] = json!(1);
        assert_eq!(error(&invalid, Some(&[0; 4])), "invalid_model_structure");
    }
    let mut invalid = document.clone();
    invalid["materials"][0]["pbrMetallicRoughness"]["metallicFactor"] = json!(2);
    assert_eq!(error(&invalid, Some(&[0; 4])), "invalid_model_structure");
}

fn material_texture(role: &str, info: Value) -> Value {
    if ["baseColorTexture", "metallicRoughnessTexture"].contains(&role) {
        let mut pbr = json!({});
        pbr[role] = info;
        json!({"pbrMetallicRoughness":pbr})
    } else {
        let mut material = json!({});
        material[role] = info;
        material
    }
}

#[test]
fn every_used_core_material_texture_requires_its_selected_uv_set() {
    for role in [
        "baseColorTexture",
        "metallicRoughnessTexture",
        "normalTexture",
        "occlusionTexture",
        "emissiveTexture",
    ] {
        let mut document = triangle();
        document["buffers"][0]["byteLength"] = json!(48);
        document["bufferViews"][0]["byteStride"] = json!(12);
        document["bufferViews"]
            .as_array_mut()
            .unwrap()
            .push(json!({"buffer":0,"byteOffset":44,"byteLength":4}));
        document["accessors"]
            .as_array_mut()
            .unwrap()
            .push(json!({"bufferView":0,"componentType":5126,"count":3,"type":"VEC2"}));
        document["images"] = json!([{"bufferView":2,"mimeType":"image/png"}]);
        document["textures"] = json!([{"source":0}]);
        document["materials"] = json!([material_texture(role, json!({"index":0}))]);
        document["meshes"][0]["primitives"][0]["material"] = json!(0);
        assert_eq!(
            error(&document, Some(&[0; 48])),
            "invalid_model_structure",
            "{role} missing TEXCOORD_0"
        );
        document["meshes"][0]["primitives"][0]["attributes"]["TEXCOORD_0"] = json!(2);
        inspect(&document, Some(&[0; 48]));
        document["materials"] = json!([material_texture(role, json!({"index":0,"texCoord":1}))]);
        assert_eq!(
            error(&document, Some(&[0; 48])),
            "invalid_model_structure",
            "{role} missing TEXCOORD_1"
        );
        document["meshes"][0]["primitives"][0]["attributes"]["TEXCOORD_1"] = json!(2);
        inspect(&document, Some(&[0; 48]));
    }
    // Unused material metadata does not imply any primitive or UV attribute.
    let mut document = empty();
    document["buffers"] = json!([{"byteLength":4}]);
    document["bufferViews"] = json!([{"buffer":0,"byteLength":4}]);
    document["images"] = json!([{"bufferView":0,"mimeType":"image/png"}]);
    document["textures"] = json!([{"source":0}]);
    document["materials"] = json!([material_texture(
        "baseColorTexture",
        json!({"index":0,"texCoord":7})
    )]);
    inspect(&document, Some(&[0; 4]));
}

#[test]
fn pending_content_and_nested_extension_payloads_cannot_hide_dependencies() {
    for (field, value) in [
        ("extensions", json!({"KHR_lights_punctual":{}})),
        ("extensions", Value::Null),
        ("extensionsUsed", json!(["KHR_draco_mesh_compression"])),
        ("extensionsRequired", json!(["KHR_texture_basisu"])),
    ] {
        let mut document = empty();
        document[field] = value;
        assert_eq!(
            error(&document, None),
            "model_resource_unavailable",
            "{field}"
        );
    }
    for pointer in [
        "/asset/extensions",
        "/buffers/0/extensions",
        "/bufferViews/0/extensions",
        "/accessors/0/sparse",
        "/meshes/0/primitives/0/extensions",
    ] {
        let mut document = triangle();
        let (object, key) = pointer.rsplit_once('/').unwrap();
        document.pointer_mut(object).unwrap()[key] = json!({});
        assert_eq!(
            error(&document, Some(&triangle_binary())),
            "model_resource_unavailable",
            "{pointer}"
        );
    }
    for pointer in [
        "/meshes/0/weights",
        "/meshes/0/primitives/0/targets",
        "/nodes/0/weights",
    ] {
        let mut document = triangle();
        let (object, key) = pointer.rsplit_once('/').unwrap();
        document.pointer_mut(object).unwrap()[key] = json!({});
        assert_eq!(
            error(&document, Some(&triangle_binary())),
            "invalid_model_structure",
            "{pointer}"
        );
    }
    let mut document = empty();
    document["skins"] = json!([]);
    assert_eq!(error(&document, None), "invalid_model_structure");
    let mut document = triangle();
    document["nodes"][0]["skin"] = json!({});
    assert_eq!(
        error(&document, Some(&triangle_binary())),
        "invalid_model_structure"
    );
    let mut document = triangle();
    document["meshes"][0]["primitives"][0]["attributes"]["JOINTS_0"] = json!(0);
    assert_eq!(
        error(&document, Some(&triangle_binary())),
        "invalid_model_structure"
    );
    let mut document = empty();
    document["futureDependencies"] = json!(["https://example.test/resource"]);
    assert_eq!(error(&document, None), "invalid_model_structure");
    document = empty();
    document["extras"] =
        json!({"opaqueAuthorMetadata":[1,{"note":"retained only in bounded raw JSON"}]});
    inspect(&document, None);
}

#[test]
fn arrays_and_attribute_maps_are_bounded_during_deserialization() {
    let mut document = empty();
    document["nodes"] = json!(vec![json!({}); MAX_MODEL_NODES + 1]);
    assert_eq!(error(&document, None), "model_structure_limit");
    document = empty();
    document["accessors"] = json!(vec![
        json!({"bufferView":0,"componentType":5126,"count":1,"type":"VEC3"});
        MAX_MODEL_RECORDS + 1
    ]);
    assert_eq!(error(&document, None), "model_structure_limit");
    document = triangle();
    let mut attributes = serde_json::Map::new();
    attributes.insert("POSITION".into(), json!(0));
    for index in 0..32 {
        attributes.insert(format!("_CUSTOM_{index}"), json!(0));
    }
    document["meshes"][0]["primitives"][0]["attributes"] = Value::Object(attributes);
    assert_eq!(
        error(&document, Some(&triangle_binary())),
        "model_structure_limit"
    );
}

fn package(files: Vec<(&str, Vec<u8>, &str)>, assets: Value) -> Vec<u8> {
    let mut manifest = serde_json::to_value(manifest()).unwrap();
    manifest["assets"] = assets;
    manifest["files"]=json!(files.iter().map(|(path,bytes,mime)|json!({"path":path,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes)),"mime":mime})).collect::<Vec<_>>());
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
fn real_zip_checks_model_structure_for_source_variants_and_aliases_after_hashing() {
    let valid = glb(&triangle(), Some(&triangle_binary()));
    let mut document = triangle();
    document["nodes"][0]["mesh"] = json!(8);
    let invalid = glb(&document, Some(&triangle_binary()));
    for variant in [false, true] {
        let assets = if variant {
            json!([{"id":"model","kind":"model","source":"assets/model.glb","variants":[{"id":"low","file":"assets/low.glb","purpose":"low"}]}])
        } else {
            json!([{"id":"model","kind":"model","source":"assets/model.glb","variants":[]}])
        };
        let files = if variant {
            vec![
                ("assets/model.glb", valid.clone(), "model/gltf-binary"),
                ("assets/low.glb", invalid.clone(), "model/gltf-binary"),
            ]
        } else {
            vec![("assets/model.glb", invalid.clone(), "model/gltf-binary")]
        };
        let error = validate_package(Cursor::new(package(files, assets))).unwrap_err();
        assert_eq!(error.code, "invalid_model_structure");
        assert!(error.message.contains(if variant {
            "assets/low.glb"
        } else {
            "assets/model.glb"
        }));
    }
    let bytes = package(
        vec![("assets/model.glb", valid, "model/gltf-binary")],
        json!([{"id":"model","kind":"model","source":"assets/model.glb","variants":[{"id":"alias","file":"assets/model.glb","purpose":"low"}]},{"id":"model-alias","kind":"model","source":"assets/model.glb","variants":[]}]),
    );
    let validated = validate_package(Cursor::new(&bytes)).unwrap();
    validate_archive(Cursor::new(&bytes), &validated.manifest).unwrap();
}

#[test]
fn real_zip_requires_transitive_image_asset_reference_and_correct_mime() {
    let png=base64::Engine::decode(&base64::engine::general_purpose::STANDARD,"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==").unwrap();
    let mut document = triangle();
    document["images"] = json!([{"uri":"albedo.png","mimeType":"image/png"}]);
    document["textures"] = json!([{"source":0}]);
    document["materials"] = json!([{"pbrMetallicRoughness":{"baseColorTexture":{"index":0}}}]);
    document["meshes"][0]["primitives"][0]["material"] = json!(0);
    document["bufferViews"][0]["byteStride"] = json!(12);
    document["accessors"]
        .as_array_mut()
        .unwrap()
        .push(json!({"bufferView":0,"componentType":5126,"count":3,"type":"VEC2"}));
    document["meshes"][0]["primitives"][0]["attributes"]["TEXCOORD_0"] = json!(2);
    let model = glb(&document, Some(&triangle_binary()));
    let models = json!({"id":"model","kind":"model","source":"assets/model.glb","variants":[]});
    for variant in [false, true] {
        let image = if variant {
            json!({"id":"albedo","kind":"texture","source":"assets/source.png","variants":[{"id":"low","file":"assets/albedo.png","purpose":"low"}]})
        } else {
            json!({"id":"albedo","kind":"image","source":"assets/albedo.png","variants":[]})
        };
        let mut files = vec![
            ("assets/model.glb", model.clone(), "model/gltf-binary"),
            ("assets/albedo.png", png.clone(), "image/png"),
        ];
        if variant {
            files.push(("assets/source.png", png.clone(), "image/png"));
        }
        validate_package(Cursor::new(package(files, json!([models.clone(), image])))).unwrap();
    }
    let files = vec![
        ("assets/model.glb", model.clone(), "model/gltf-binary"),
        ("assets/albedo.png", png.clone(), "image/png"),
    ];
    assert_eq!(
        validate_package(Cursor::new(package(files, json!([models.clone()]))))
            .unwrap_err()
            .code,
        "invalid_model_structure"
    );
    let files = vec![
        ("assets/model.glb", model, "model/gltf-binary"),
        ("assets/albedo.png", png, "image/jpeg"),
    ];
    let image = json!({"id":"albedo","kind":"image","source":"assets/albedo.png","variants":[]});
    assert_eq!(
        validate_package(Cursor::new(package(files, json!([models, image]))))
            .unwrap_err()
            .code,
        "invalid_model_structure"
    );
}
