// SPDX-License-Identifier: MIT
//! Authored static facts from real GLB streams, without runtime qualification.

use std::io::{Cursor, Write};

use hertz_wallpaper::{
    model_binary::inspect_glb_resource_content,
    model_structure::{
        inspect_glb_resource, GlbResource, ModelNodeTransform, ModelStaticLoaderFields,
        MAX_MODEL_NODES,
    },
    validate_archive, validate_package, Manifest,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zip::{write::SimpleFileOptions, ZipWriter};

fn glb(document: &Value, binary: Option<&[u8]>) -> Vec<u8> {
    glb_json(serde_json::to_vec(document).unwrap(), binary)
}

fn glb_json(mut json: Vec<u8>, binary: Option<&[u8]>) -> Vec<u8> {
    while json.len() % 4 != 0 {
        json.push(b' ');
    }
    let mut binary = binary.map(<[u8]>::to_vec);
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

fn manifest() -> Manifest {
    serde_json::from_value(json!({
        "formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae",
        "version":1,"title":"Model static facts",
        "content":{"kind":"builtin","sceneId":"zodiac","stateVersion":1,"params":{}},
        "assets":[],"files":[],"permissions":{"audioSpectrum":false,"pointer":false},
        "license":{"code":"none","assets":"CC0-1.0"}
    }))
    .unwrap()
}

fn empty() -> Value {
    json!({"asset":{"version":"2.0"}})
}

fn triangle() -> Value {
    json!({"asset":{"version":"2.0"},
        "buffers":[{"byteLength":42}],
        "bufferViews":[{"buffer":0,"byteLength":36,"target":34962},
            {"buffer":0,"byteOffset":36,"byteLength":6,"target":34963}],
        "accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3",
            "min":[0,0,0],"max":[1,1,0]},
            {"bufferView":1,"componentType":5123,"count":3,"type":"SCALAR"}],
        "meshes":[{"primitives":[{"attributes":{"POSITION":0},"indices":1}]}],
        "nodes":[{"mesh":0}],"scenes":[{"nodes":[0]}],"scene":0})
}

fn triangle_binary() -> Vec<u8> {
    let mut bytes = Vec::new();
    for value in [0_f32, 0., 0., 1., 0., 0., 0., 1., 0.] {
        bytes.extend(value.to_le_bytes());
    }
    for index in [0_u16, 1, 2] {
        bytes.extend(index.to_le_bytes());
    }
    bytes
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

fn default_trs() -> ModelNodeTransform {
    ModelNodeTransform::Trs {
        translation: [0.0; 3],
        rotation: [0.0, 0.0, 0.0, 1.0],
        scale: [1.0; 3],
    }
}

#[test]
fn transforms_retain_authored_f64_and_fill_only_missing_trs_defaults() {
    let translation = [1.25, -2.5, 3.75];
    // Within the original unit tolerance; retaining this catches normalization.
    let rotation = [0.0, 0.0, 0.0, 1.00001];
    let scale = [-2.25, 3.5, 0.125];
    let matrix = [
        0.0, -2.5, 0.0, 0.0, 3.75, 0.0, 0.0, 0.0, 0.0, 0.0, -0.125, 0.0, 1.25, -2.5, 3.75, 1.0,
    ];
    let mut document = empty();
    document["nodes"] = json!([
        {},
        {"translation":[0,0,0],"rotation":[0,0,0,1],"scale":[1,1,1]},
        {"translation":translation,"rotation":rotation,"scale":scale},
        {"matrix":matrix},
        {"translation":translation}
    ]);
    let structure = inspect(&document, None).structure;
    assert_eq!(structure.nodes[0].transform, default_trs());
    assert_eq!(structure.nodes[1].transform, default_trs());
    assert_eq!(
        structure.nodes[2].transform,
        ModelNodeTransform::Trs {
            translation,
            rotation,
            scale,
        }
    );
    assert_eq!(
        structure.nodes[3].transform,
        ModelNodeTransform::Matrix(matrix)
    );
    assert_eq!(
        structure.nodes[4].transform,
        ModelNodeTransform::Trs {
            translation,
            rotation: [0.0, 0.0, 0.0, 1.0],
            scale: [1.0; 3],
        }
    );
    assert!(structure.nodes.iter().all(|node| node.parent.is_none()
        && node.children.is_empty()
        && node.mesh.is_none()
        && node.camera.is_none()
        && node.skin.is_none()
        && !node.loader_pivot));
    assert_eq!(structure.node_morph_weights, vec![None; 5]);
    assert!(!structure.binary_content_validated);
}

#[test]
fn author_node_scene_and_child_order_and_orphans_are_preserved() {
    let mut document = triangle();
    document["nodes"] = json!([{"children":[3,1]}, {"mesh":0}, {}, {}, {}]);
    document["scenes"] = json!([{"nodes":[2,0]}, {"nodes":[4,0,2]}]);
    document["scene"] = json!(1);
    let structure = inspect(&document, Some(&triangle_binary())).structure;
    assert_eq!(structure.nodes.len(), 5);
    assert_eq!(structure.nodes[0].children, [3, 1]);
    assert_eq!(
        structure
            .nodes
            .iter()
            .map(|node| node.parent)
            .collect::<Vec<_>>(),
        [None, Some(0), None, Some(0), None]
    );
    assert_eq!(structure.nodes[1].mesh, Some(0));
    assert_eq!(structure.scenes[0].nodes, [2, 0]);
    assert_eq!(structure.scenes[1].nodes, [4, 0, 2]);
    assert_eq!(structure.default_scene, Some(1));
    document.as_object_mut().unwrap().remove("scene");
    assert_eq!(
        inspect(&document, Some(&triangle_binary()))
            .structure
            .default_scene,
        None
    );
    document["scenes"] = json!([{"nodes":[0]}]);
    let structure = inspect(&document, Some(&triangle_binary())).structure;
    assert_eq!(structure.nodes[4].parent, None);
    assert!(structure.nodes[4].children.is_empty());
}

#[test]
fn node_skin_is_retained_without_primitive_joint_weight_bindings() {
    let mut document = triangle();
    document["nodes"] = json!([{"mesh":0,"skin":0}, {}]);
    document["scenes"] = json!([{"nodes":[0,1]}]);
    document["skins"] = json!([{"joints":[1]}]);
    let structure = inspect(&document, Some(&triangle_binary())).structure;
    assert_eq!(structure.nodes[0].mesh, Some(0));
    assert_eq!(structure.nodes[0].skin, Some(0));
    assert_eq!(structure.nodes[1].skin, None);
    assert_eq!(structure.skins[0].joints, [1]);
    assert!(structure.skin_bindings.is_empty());
    assert_eq!(structure.skin_binding_pair_refs, 0);
}

#[test]
fn mode_presence_does_not_change_original_primitive_eligibility() {
    let binary = triangle_binary();
    let mut document = triangle();
    assert_eq!(
        inspect(&document, Some(&binary)).structure.meshes[0].primitives[0].authored_mode,
        None
    );
    document["meshes"][0]["primitives"][0]["mode"] = json!(4);
    let primitive = &inspect(&document, Some(&binary)).structure.meshes[0].primitives[0];
    assert_eq!(primitive.authored_mode, Some(4));
    assert_eq!(primitive.indices, Some(1));
    assert_eq!(primitive.material, None);
    assert_eq!(primitive.triangles_upper_bound, 1);
    document["meshes"][0]["primitives"][0]["mode"] = json!(5);
    assert_eq!(
        error(&document, Some(&binary)),
        "model_resource_unavailable"
    );
    for mode in [Value::Null, json!(-1), json!(4.5), json!("4")] {
        document["meshes"][0]["primitives"][0]["mode"] = mode;
        assert_eq!(error(&document, Some(&binary)), "invalid_model_structure");
    }
}

#[test]
fn declared_counts_logical_bin_and_empty_facts_are_distinct() {
    let mut document = triangle();
    document["buffers"][0]["byteLength"] = json!(46);
    document["bufferViews"]
        .as_array_mut()
        .unwrap()
        .push(json!({"buffer":0,"byteOffset":42,"byteLength":4}));
    document["images"] = json!([{"bufferView":2,"mimeType":"image/png"}]);
    document["textures"] = json!([{"source":0,"sampler":2}, {"source":0}]);
    document["samplers"] = json!([{}, {}, {}]);
    document["materials"] = json!([{}, {}, {}, {}]);
    document["cameras"] = json!([
        {"type":"perspective","perspective":{"yfov":1.25,"znear":0.1}},
        {"type":"orthographic","orthographic":{"xmag":2,"ymag":3,"znear":0,"zfar":10}}
    ]);
    document["nodes"][0]["camera"] = json!(1);
    let mut binary = triangle_binary();
    binary.extend([0; 4]);
    let result = inspect(&document, Some(&binary));
    let structure = result.structure;
    assert_eq!(structure.buffer_byte_length, Some(46));
    assert_eq!(result.container.binary.unwrap().bytes, 48);
    assert_eq!(structure.material_count, 4);
    assert_eq!(structure.texture_count, 2);
    assert_eq!(structure.sampler_count, 3);
    assert_eq!(structure.camera_count, 2);
    assert_eq!(structure.images.len(), 1);
    assert_eq!(structure.buffer_views.len(), 3);
    assert_eq!(structure.accessors.len(), 2);
    assert_eq!(structure.meshes.len(), 1);
    assert_eq!(structure.nodes.len(), 1);
    assert_eq!(structure.scenes.len(), 1);
    assert_eq!(structure.nodes[0].camera, Some(1));
    assert!(structure.animations.is_empty() && structure.skins.is_empty());
    assert_eq!(
        structure.static_loader_fields,
        ModelStaticLoaderFields::default()
    );
    for binary in [None, Some([].as_slice()), Some([0; 4].as_slice())] {
        let structure = inspect(&empty(), binary).structure;
        assert_eq!(structure.buffer_byte_length, None);
        assert!(structure.nodes.is_empty() && structure.scenes.is_empty());
        assert_eq!(structure.default_scene, None);
        assert_eq!(
            (
                structure.material_count,
                structure.texture_count,
                structure.sampler_count,
                structure.camera_count
            ),
            (0, 0, 0, 0)
        );
        assert_eq!(
            structure.static_loader_fields,
            ModelStaticLoaderFields::default()
        );
    }
}

#[test]
fn only_direct_or_one_json_proto_carrier_pivot_is_visible_on_node_and_mesh() {
    let cases = [
        (json!({"pivot":null}), true),
        (json!({"pivot":false}), true),
        (json!({"pivot":0}), true),
        (json!({"pivot":[]}), true),
        (json!({"pivot":{"nested":true}}), true),
        (json!({"__proto__":{"pivot":null}}), true),
        (json!({"__proto__":{"pivot":false}}), true),
        (json!({"__proto__":{"pivot":[]}}), true),
        (json!({"__proto__":{"__proto__":{"pivot":true}}}), false),
        (json!({"__proto__":{"nested":{"pivot":true}}}), false),
        (json!({"__proto__":null}), false),
        (json!({"__proto__":false}), false),
        (json!({"__proto__":[{"pivot":true}]}), false),
        (json!({"nested":{"pivot":true}}), false),
        (json!({"constructor":{"prototype":{"pivot":true}}}), false),
        (json!([{"pivot":true},{"__proto__":{"pivot":true}}]), false),
        (json!("pivot"), false),
        (json!(42), false),
        (json!(1.25), false),
        (json!(true), false),
        (Value::Null, false),
        (json!({}), false),
    ];
    for (extras, expected) in cases {
        let mut document = triangle();
        document["nodes"][0]["extras"] = extras.clone();
        document["meshes"][0]["extras"] = extras.clone();
        let structure = inspect(&document, Some(&triangle_binary())).structure;
        assert_eq!(structure.nodes[0].loader_pivot, expected, "{extras}");
        assert_eq!(structure.meshes[0].loader_pivot, expected, "{extras}");
        assert_eq!(
            structure.static_loader_fields,
            ModelStaticLoaderFields::default()
        );
        assert!(!structure.binary_content_validated);
    }
}

#[test]
fn scene_primitive_and_other_extras_do_not_pollute_node_mesh_or_presence_flags() {
    let mut document = triangle();
    document["extras"] = json!({"uri":null,"pivot":true});
    document["scenes"][0]["extras"] = json!({"pivot":true});
    document["meshes"][0]["primitives"][0]["extras"] = json!({"__proto__":{"pivot":true}});
    document["buffers"][0]["extras"] = json!({"uri":null});
    document["nodes"][0]["extras"] = Value::Null;
    document["meshes"][0]["extras"] = Value::Null;
    let structure = inspect(&document, Some(&triangle_binary())).structure;
    assert!(!structure.nodes[0].loader_pivot && !structure.meshes[0].loader_pivot);
    assert_eq!(
        structure.static_loader_fields,
        ModelStaticLoaderFields::default()
    );
}

#[test]
fn escaped_metadata_keys_and_null_sequences_keep_the_same_fixed_projection() {
    let bytes = glb_json(
        br#"{"asset":{"version":"2.0"},"nodes":[
        {"extras":{"p\u0069vot":null}},
        {"extras":{"__pr\u006fto__":{"piv\u006ft":false}}},
        {"extras":{"__proto__":{"__proto__":{"pivot":true}}}},
        {"extras":[null,false,"x",{"pivot":true}]},
        {"extras":{"unused\u0020key":[null,{"deep":[null]}]}},
        {"extras":{"nested":{"p\u0069vot":null}}}
    ]}"#
        .to_vec(),
        None,
    );
    let resource = inspect_glb_resource(
        Cursor::new(&bytes),
        bytes.len() as u64,
        &manifest(),
        "assets/model.glb",
    )
    .unwrap();
    assert_eq!(
        resource
            .structure
            .nodes
            .iter()
            .map(|node| node.loader_pivot)
            .collect::<Vec<_>>(),
        [true, true, false, false, false, false]
    );
    assert_eq!(
        resource.structure.static_loader_fields,
        ModelStaticLoaderFields::default()
    );
}

#[test]
fn historically_accepted_optional_nulls_retain_values_and_global_presence() {
    let binary = triangle_binary();
    for path in [
        "/scene",
        "/bufferViews/0/byteStride",
        "/meshes/0/primitives/0/indices",
        "/meshes/0/primitives/0/material",
        "/nodes/0/mesh",
        "/nodes/0/camera",
        "/nodes/0/matrix",
        "/nodes/0/translation",
        "/nodes/0/rotation",
        "/nodes/0/scale",
    ] {
        let mut document = triangle();
        let (parent, key) = path.rsplit_once('/').unwrap();
        document.pointer_mut(parent).unwrap()[key] = Value::Null;
        let structure = inspect(&document, Some(&binary)).structure;
        assert!(structure.static_loader_fields.has_null_properties, "{path}");
        assert!(!structure.static_loader_fields.has_buffer_uri, "{path}");
        assert_eq!(structure.nodes[0].transform, default_trs());
        match path {
            "/scene" => assert_eq!(structure.default_scene, None),
            "/bufferViews/0/byteStride" => assert_eq!(structure.buffer_views[0].byte_stride, None),
            "/meshes/0/primitives/0/indices" => {
                assert_eq!(structure.meshes[0].primitives[0].indices, None)
            }
            "/meshes/0/primitives/0/material" => {
                assert_eq!(structure.meshes[0].primitives[0].material, None)
            }
            "/nodes/0/mesh" => assert_eq!(structure.nodes[0].mesh, None),
            "/nodes/0/camera" => assert_eq!(structure.nodes[0].camera, None),
            _ => {}
        }
    }
    let mut document = triangle();
    document["buffers"][0]["uri"] = Value::Null;
    let structure = inspect(&document, Some(&binary)).structure;
    assert_eq!(
        structure.static_loader_fields,
        ModelStaticLoaderFields {
            has_buffer_uri: true,
            has_null_properties: false,
        }
    );
    document["buffers"][0]["uri"] = json!("buffer.bin");
    assert_eq!(
        error(&document, Some(&binary)),
        "model_resource_unavailable"
    );
    assert_eq!(
        inspect(&triangle(), Some(&binary))
            .structure
            .static_loader_fields,
        ModelStaticLoaderFields::default()
    );
}

#[test]
fn nulls_in_unused_declarations_still_set_profile_presence() {
    for field in [
        "mesh",
        "camera",
        "matrix",
        "translation",
        "rotation",
        "scale",
    ] {
        let mut document = triangle();
        document["nodes"]
            .as_array_mut()
            .unwrap()
            .push(json!({field:null}));
        let structure = inspect(&document, Some(&triangle_binary())).structure;
        assert!(
            structure.static_loader_fields.has_null_properties,
            "{field}"
        );
        assert_eq!(structure.nodes.len(), 2);
        assert_eq!(structure.scenes[0].nodes, [0]);
    }
    for field in ["indices", "material"] {
        let mut document = triangle();
        document["meshes"]
            .as_array_mut()
            .unwrap()
            .push(json!({"primitives":[{"attributes":{"POSITION":0},field:null}]}));
        assert!(
            inspect(&document, Some(&triangle_binary()))
                .structure
                .static_loader_fields
                .has_null_properties,
            "{field}"
        );
    }
    let mut document = triangle();
    document["bufferViews"]
        .as_array_mut()
        .unwrap()
        .push(json!({"buffer":0,"byteLength":4,"byteStride":null}));
    assert!(
        inspect(&document, Some(&triangle_binary()))
            .structure
            .static_loader_fields
            .has_null_properties
    );
}

#[test]
fn original_5000_node_chain_and_wide_graph_keep_complete_author_facts() {
    for chain in [true, false] {
        let mut document = empty();
        document["nodes"] = json!((0..MAX_MODEL_NODES)
            .map(|index| {
                if chain && index + 1 < MAX_MODEL_NODES {
                    json!({"children":[index+1]})
                } else if !chain && index == 0 {
                    json!({"children":(1..MAX_MODEL_NODES).rev().collect::<Vec<_>>()})
                } else {
                    json!({})
                }
            })
            .collect::<Vec<_>>());
        document["scenes"] = json!([{"nodes":[0]}]);
        let structure = inspect(&document, None).structure;
        assert_eq!(structure.nodes.len(), MAX_MODEL_NODES);
        assert_eq!(structure.scenes[0].nodes, [0]);
        for (index, node) in structure.nodes.iter().enumerate() {
            assert_eq!(
                node.parent,
                if index == 0 {
                    None
                } else if chain {
                    Some(index - 1)
                } else {
                    Some(0)
                }
            );
            if chain {
                assert_eq!(
                    node.children,
                    if index + 1 < MAX_MODEL_NODES {
                        vec![index + 1]
                    } else {
                        vec![]
                    }
                );
            } else if index == 0 {
                assert_eq!(
                    node.children,
                    (1..MAX_MODEL_NODES).rev().collect::<Vec<_>>()
                );
            } else {
                assert!(node.children.is_empty());
            }
            assert_eq!(node.transform, default_trs());
        }
        document["nodes"].as_array_mut().unwrap().push(json!({}));
        assert_eq!(error(&document, None), "model_structure_limit");
    }
}

fn package(files: &[(&str, Vec<u8>)], variant: bool) -> Vec<u8> {
    let mut manifest = serde_json::to_value(manifest()).unwrap();
    manifest["assets"] = json!([{"id":"model","kind":"model","source":"assets/model.glb",
        "variants": if variant {
            json!([{"id":"low","file":"assets/low.glb","purpose":"low"}])
        } else { json!([]) }}]);
    manifest["files"] = json!(files
        .iter()
        .map(|(path, bytes)| json!({
            "path":path,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes)),
            "mime":"model/gltf-binary"
        }))
        .collect::<Vec<_>>());
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file("manifest.json", SimpleFileOptions::default())
        .unwrap();
    writer
        .write_all(&serde_json::to_vec(&manifest).unwrap())
        .unwrap();
    for (path, bytes) in files {
        writer
            .start_file(*path, SimpleFileOptions::default())
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

#[test]
fn checked_stream_and_real_package_sources_and_variants_keep_the_same_facts() {
    let mut source = triangle();
    source["nodes"][0]["extras"] = json!({"pivot":false});
    source["nodes"][0]["scale"] = json!([-2.25, 3.5, 0.125]);
    source["meshes"][0]["primitives"][0]["mode"] = json!(4);
    let mut variant = source.clone();
    variant["nodes"][0]["extras"] = json!({"__proto__":{"pivot":null}});
    variant["buffers"][0]["uri"] = Value::Null;
    variant["meshes"][0]["primitives"][0]["material"] = Value::Null;
    // The final two bytes are unused padding and remain part of the hash.
    let source_bytes = glb(&source, Some(&triangle_binary()));
    let mut variant_bytes = glb(&variant, Some(&triangle_binary()));
    *variant_bytes.last_mut().unwrap() = 73;
    for use_variant in [false, true] {
        let mut files = vec![("assets/model.glb", source_bytes.clone())];
        if use_variant {
            files.push(("assets/low.glb", variant_bytes.clone()));
        }
        let archive = package(&files, use_variant);
        let validated = validate_package(Cursor::new(&archive)).unwrap();
        validate_archive(Cursor::new(&archive), &validated.manifest).unwrap();
        for (path, bytes) in files {
            let checked = inspect_glb_resource_content(
                Cursor::new(&bytes),
                bytes.len() as u64,
                &validated.manifest,
                path,
            )
            .unwrap();
            let typed = inspect_glb_resource(
                Cursor::new(&bytes),
                bytes.len() as u64,
                &validated.manifest,
                path,
            )
            .unwrap();
            assert_eq!(checked.resource(), &typed);
            assert_eq!(checked.bytes(), bytes.len() as u64);
            assert_eq!(checked.source_path(), path);
            assert_eq!(
                checked.sha256_hex(),
                format!("{:x}", Sha256::digest(&bytes))
            );
            let structure = &checked.resource().structure;
            assert!(structure.nodes[0].loader_pivot);
            assert_eq!(structure.buffer_byte_length, Some(42));
            assert_eq!(structure.nodes[0].mesh, Some(0));
            assert_eq!(structure.meshes[0].primitives[0].authored_mode, Some(4));
            assert_eq!(
                structure.static_loader_fields,
                ModelStaticLoaderFields {
                    has_buffer_uri: path == "assets/low.glb",
                    has_null_properties: path == "assets/low.glb",
                }
            );
            assert_eq!(structure.scenes[0].nodes, [0]);
            assert!(!structure.binary_content_validated);
        }
    }
    assert_ne!(
        Sha256::digest(&source_bytes),
        Sha256::digest(&variant_bytes)
    );
}
