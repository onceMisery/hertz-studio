// SPDX-License-Identifier: MIT
//! Author-data semantics and real ZIP admission, without claiming GPU execution.
use std::io::{Cursor, Write};

use hertz_wallpaper::document::{catalog::parse_catalog, compile_document, CompiledDocument};
use hertz_wallpaper::{validate_archive, validate_manifest_bytes, validate_package, Manifest};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

fn base() -> Value {
    json!({"documentVersion":1,"canvas":{"width":1920,"height":1080,"colorSpace":"srgb","background":"#101010"},
        "nodes":[{"id":"background-layer","type":"image","stateVersion":1,"assets":{"asset":"background"},"properties":{}}],
        "timeline":{"durationSeconds":30,"loop":true,"tracks":[]},"bindings":[]})
}

fn node(id: &str, kind: &str) -> Value {
    json!({"id":id,"type":kind,"stateVersion":1,"children":[],"assets":{},"properties":{}})
}

fn manifest(bytes: &[u8]) -> Manifest {
    let image = b"synthetic-contract-asset";
    validate_manifest_bytes(&serde_json::to_vec(&json!({"formatVersion":1,
        "workId":"8bc16f98-a0ef-4df9-a9a4-aecdb4c3f772","version":1,"title":"组合边界样本",
        "content":{"kind":"composition","document":"document.json"},
        "assets":[{"id":"background","kind":"image","source":"assets/background.png"}],
        "files":[{"path":"document.json","bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes)),"mime":"application/json"},
            {"path":"assets/background.png","bytes":image.len(),"sha256":format!("{:x}",Sha256::digest(image)),"mime":"image/png"}],
        "permissions":{"audioSpectrum":false,"pointer":false},"license":{"code":"MIT","assets":"CC0-1.0"}})).unwrap()).unwrap()
}

fn compile(value: &Value) -> hertz_wallpaper::Result<CompiledDocument> {
    let bytes = serde_json::to_vec(value).unwrap();
    compile_document(&bytes, &manifest(&bytes))
}

fn rejected(value: Value) {
    assert!(compile(&value).is_err(), "unexpectedly accepted: {value}");
}

fn track(property: &str, component: Value) -> Value {
    json!({"id":"fade","target":{"nodeId":"background-layer","property":property,"component":component},
        "keys":[{"timeSeconds":0,"value":0.4,"easing":"step"},{"timeSeconds":2,"value":1,"easing":"easeInOut"}]})
}

fn binding(program: Value) -> Value {
    json!({"id":"pulse","target":{"nodeId":"background-layer","property":"opacity","component":null},
        "mode":"multiply","parameters":{"gain":1},"program":program})
}

#[test]
fn defaults_normalization_and_hash_are_idempotent() {
    let compiled = compile(&base()).unwrap();
    assert_eq!(compiled.document().effects.len(), 0);
    assert_eq!(compiled.document().nodes[0].properties["opacity"], 1.0);
    assert_eq!(compiled.document().nodes[0].properties["fit"], "cover");
    let again = compile_document(
        compiled.normalized_bytes(),
        &manifest(compiled.normalized_bytes()),
    )
    .unwrap();
    assert_eq!(compiled.normalized_bytes(), again.normalized_bytes());
    assert_eq!(compiled.ir().semantic_key(), again.ir().semantic_key());
    let mut alternate = base();
    alternate["nodes"][0]["properties"] = json!({"opacity":1.0,"x":0.0});
    assert_eq!(
        compiled.ir().document_hash(),
        compile(&alternate).unwrap().ir().document_hash()
    );
    let mut changed = base();
    changed["nodes"][0]["properties"]["opacity"] = json!(0.5);
    assert_ne!(
        compiled.ir().semantic_key(),
        compile(&changed).unwrap().ir().semantic_key()
    );
    assert_eq!(compiled.ir().resource_uses()[0].usage, "color");
    assert_eq!(compiled.ir().nodes()[0].matrix_offset, 0);
}

#[test]
fn author_shape_versions_and_field_ranges_are_strict() {
    let mut cases = Vec::new();
    let mut value = base();
    value["unexpected"] = json!(true);
    cases.push(value);
    let mut value = base();
    value["documentVersion"] = json!(2);
    cases.push(value);
    let mut value = base();
    value["nodes"][0]["stateVersion"] = json!(0);
    cases.push(value);
    let mut value = base();
    value["nodes"][0]["asset"] = json!("background");
    cases.push(value);
    let mut value = base();
    value["nodes"][0]["properties"]["shader"] = json!("exec()");
    cases.push(value);
    let mut value = base();
    value["nodes"][0]["properties"]["opacity"] = json!(1.01);
    cases.push(value);
    let mut value = base();
    value["nodes"][0]["properties"]["width"] = json!(0);
    cases.push(value);
    let mut value = base();
    value["nodes"][0]["properties"]["visible"] = json!(1);
    cases.push(value);
    let mut value = base();
    value["nodes"][0]["assets"]["asset"] = json!("https://example.org/remote");
    cases.push(value);
    let mut value = base();
    value["nodes"][0]["assets"]["asset"] = json!("unknown");
    cases.push(value);
    let mut value = base();
    value["nodes"][0]["children"] = json!(["background-layer"]);
    cases.push(value);
    for value in cases {
        rejected(value);
    }
}

#[test]
fn bytes_depth_and_duplicate_keys_are_checked_before_deserialization() {
    let bytes = serde_json::to_vec(&base()).unwrap();
    let manifest = manifest(&bytes);
    let duplicate = String::from_utf8(bytes.clone()).unwrap().replace(
        "\"documentVersion\":1",
        "\"documentVersion\":1,\"documentVersion\":1",
    );
    assert!(compile_document(duplicate.as_bytes(), &manifest).is_err());
    assert_eq!(
        compile_document(&vec![b' '; 1024 * 1024 + 1], &manifest)
            .unwrap_err()
            .code,
        "document_too_large"
    );
    let deep = format!("{}0{}", "[".repeat(18), "]".repeat(18));
    assert!(compile_document(deep.as_bytes(), &manifest).is_err());
    let nonfinite = String::from_utf8(bytes)
        .unwrap()
        .replace("\"properties\":{}", "\"properties\":{\"x\":1e999}");
    assert!(compile_document(nonfinite.as_bytes(), &manifest).is_err());
}

#[test]
fn painter_order_follows_roots_and_author_children_without_reordering() {
    let mut value = base();
    let mut first = value["nodes"][0].clone();
    first["id"] = json!("first");
    let mut second = first.clone();
    second["id"] = json!("second");
    let mut group = node("container", "group");
    group["children"] = json!(["second", "first"]);
    value["nodes"] = json!([first, group, second]);
    let compiled = compile(&value).unwrap();
    assert_eq!(compiled.ir().painter_order(), &[1, 2, 0]);
    assert_eq!(compiled.ir().nodes()[0].parent_index, 1);
    assert_eq!(compiled.ir().matrix_dependents()[1], vec![0, 2]);
    let mut reversed = value.clone();
    reversed["nodes"][1]["children"] = json!(["first", "second"]);
    assert_ne!(
        compiled.ir().semantic_key(),
        compile(&reversed).unwrap().ir().semantic_key()
    );
}

#[test]
fn graph_rejects_duplicate_children_multi_parent_cycles_missing_and_depth() {
    let mut root = node("root", "group");
    root["children"] = json!(["background-layer", "background-layer"]);
    let mut value = base();
    value["nodes"].as_array_mut().unwrap().push(root);
    rejected(value);
    let mut a = node("alpha", "group");
    a["children"] = json!(["background-layer"]);
    let mut b = node("beta", "group");
    b["children"] = json!(["background-layer"]);
    let mut value = base();
    value["nodes"].as_array_mut().unwrap().extend([a, b]);
    rejected(value);
    let mut a = node("alpha", "group");
    a["children"] = json!(["beta"]);
    let mut b = node("beta", "group");
    b["children"] = json!(["alpha"]);
    let mut value = base();
    value["nodes"] = json!([a, b]);
    rejected(value);
    let mut root = node("root", "group");
    root["children"] = json!(["missing"]);
    let mut value = base();
    value["nodes"] = json!([root]);
    rejected(value);
    let mut value = base();
    let mut chain = Vec::new();
    for index in 0..9 {
        let mut group = node(&format!("group-{index}"), "group");
        if index < 8 {
            group["children"] = json!([format!("group-{}", index + 1)]);
        }
        chain.push(group);
    }
    value["nodes"] = json!(chain);
    rejected(value.clone());
    value["nodes"].as_array_mut().unwrap().pop();
    value["nodes"][7]["children"] = json!([]);
    assert!(compile(&value).is_ok());
}

#[test]
fn group_spaces_choose_the_correct_rotation_shape_and_never_mix() {
    let mut value = base();
    let mut group = node("space-group", "group");
    group["properties"] = json!({"space":"3d","rotation":[0,0,0]});
    value["nodes"] = json!([group]);
    let compiled = compile(&value).unwrap();
    assert_eq!(compiled.ir().nodes()[0].space, "3d");
    assert!(!compiled.document().nodes[0]
        .properties
        .contains_key("width"));
    value["nodes"][0]["properties"]["x"] = json!(1);
    rejected(value);
    let mut value = base();
    let mut group = node("space-group", "group");
    group["properties"] = json!({"space":"3d"});
    group["children"] = json!(["background-layer"]);
    value["nodes"].as_array_mut().unwrap().push(group);
    rejected(value);
}

#[test]
fn canvas_and_model_camera_are_validated_without_using_model_claims() {
    for (field, bad) in [
        ("width", json!(0)),
        ("height", json!(16385)),
        ("width", json!(1.1)),
        ("background", json!("url(remote)")),
        ("colorSpace", json!("display-p3")),
    ] {
        let mut value = base();
        value["canvas"][field] = bad;
        rejected(value);
    }
    let mut value = base();
    value["nodes"] = json!([node("model-layer", "model")]);
    value["nodes"][0]["assets"] = json!({"asset":"background"});
    let bytes = serde_json::to_vec(&value).unwrap();
    let mut model_manifest = manifest(&bytes);
    model_manifest.assets[0].kind = hertz_wallpaper::AssetKind::Model;
    assert!(compile_document(&bytes, &model_manifest).is_err());
    value["canvas"]["scene3d"] =
        json!({"position":[0,0,5],"target":[0,0,0],"fovDegrees":45,"near":0.1,"far":100});
    assert!(compile_document(&serde_json::to_vec(&value).unwrap(), &model_manifest).is_ok());
    value["canvas"]["scene3d"]["far"] = json!(0.01);
    assert!(compile_document(&serde_json::to_vec(&value).unwrap(), &model_manifest).is_err());
}

#[test]
fn builtin_defaults_keep_the_original_registry_owner_and_background_exclusion() {
    let mut value = base();
    let mut builtin = node("original", "builtinScene");
    builtin["properties"] = json!({"sceneId":"zodiac","params":{"glow":0.5}});
    value["nodes"] = json!([builtin.clone()]);
    let compiled = compile(&value).unwrap();
    assert_eq!(
        compiled.document().nodes[0].properties["params"]["glow"],
        0.5
    );
    builtin["properties"]["params"]["script"] = json!(1);
    value["nodes"] = json!([builtin]);
    rejected(value);
    let mut value = base();
    let mut a = node("alpha", "builtinScene");
    a["properties"] = json!({"sceneId":"zodiac"});
    let mut b = a.clone();
    b["id"] = json!("beta");
    value["nodes"] = json!([a, b]);
    rejected(value);
}

#[test]
fn effects_are_fixed_order_bounded_and_cannot_form_cross_node_graphs() {
    let color = json!({"id":"tint","type":"colorAdjust","stateVersion":1,"target":{"kind":"node","nodeId":"background-layer"},"properties":{}});
    let glow = json!({"id":"glow","type":"glow","stateVersion":1,"target":{"kind":"output"},"properties":{}});
    let mut value = base();
    value["effects"] = json!([color.clone(), glow.clone()]);
    let compiled = compile(&value).unwrap();
    assert_eq!(compiled.document().effects[0].id, "tint");
    let mut bad = value.clone();
    bad["effects"][1]["target"] = color["target"].clone();
    rejected(bad);
    let mut bad = value.clone();
    bad["effects"][0]["sourceNode"] = json!("other");
    rejected(bad);
    let mut bad = value.clone();
    bad["effects"][0]["type"] = json!("customShader");
    rejected(bad);
    let effects: Vec<_> = (0..9)
        .map(|index| {
            let mut effect = glow.clone();
            effect["id"] = json!(format!("effect-{index}"));
            effect
        })
        .collect();
    value["effects"] = json!(effects);
    rejected(value);
}

#[test]
fn tracks_resolve_fixed_slots_and_reject_wrong_targets_and_keys() {
    let mut value = base();
    value["timeline"]["tracks"] = json!([track("opacity", Value::Null)]);
    let compiled = compile(&value).unwrap();
    assert_eq!(compiled.ir().tracks().len(), 1);
    assert_eq!(
        compiled.ir().numeric_slots()[compiled.ir().tracks()[0].target_slot].property,
        "opacity"
    );
    for target in ["fit", "asset", "glow"] {
        let mut bad = value.clone();
        bad["timeline"]["tracks"][0]["target"]["property"] = json!(target);
        rejected(bad);
    }
    let mut bad = value.clone();
    bad["timeline"]["tracks"][0]["target"]
        .as_object_mut()
        .unwrap()
        .remove("component");
    rejected(bad);
    let mut bad = value.clone();
    bad["timeline"]["tracks"][0]["keys"][1]["timeSeconds"] = json!(0);
    rejected(bad);
    let mut bad = value.clone();
    bad["timeline"]["tracks"][0]["keys"][1]["value"] = json!(2);
    rejected(bad);
    let mut bad = value.clone();
    bad["timeline"]["tracks"][0]["keys"][1]["timeSeconds"] = json!(31);
    rejected(bad);
    let mut bad = value.clone();
    bad["timeline"]["tracks"][0]["target"]["component"] = json!(0);
    rejected(bad);
    let mut bad = value.clone();
    bad["timeline"]["tracks"]
        .as_array_mut()
        .unwrap()
        .push(track("opacity", Value::Null));
    rejected(bad);
}

#[test]
fn binding_programs_have_no_strings_or_jumps_in_the_compiled_hot_loop() {
    let mut value = base();
    value["bindings"] = json!([binding(json!([
        {"op":"input","name":"energy"},{"op":"parameter","name":"gain"},{"op":"mul"},
        {"op":"const","value":0.5},{"op":"add"},{"op":"clamp","min":0,"max":1}]))]);
    let compiled = compile(&value).unwrap();
    let compiled_binding = &compiled.ir().bindings()[0];
    assert_eq!(compiled_binding.max_stack, 2);
    assert_eq!(compiled_binding.program[0].opcode, 0);
    assert_eq!(compiled_binding.program[0].index, 0);
    assert_eq!(compiled_binding.program[1].index, 0);
    assert_eq!(compiled_binding.program[5].operands, [0.0, 1.0, 0.0, 0.0]);
    for program in [
        json!([{"op":"add"}]),
        json!([{"op":"input","name":"token"}]),
        json!([{"op":"parameter","name":"unknown"}]),
        json!([{"op":"const","value":1},{"op":"const","value":2}]),
        json!([{"op":"const","value":1},{"op":"map","inputMin":0,"inputMax":0,"outputMin":0,"outputMax":1}]),
        json!([{"op":"const","value":1},{"op":"smoothstep","edge0":1,"edge1":0}]),
        json!([{"op":"const","value":1,"script":"ignored"}]),
    ] {
        let mut bad = base();
        bad["bindings"] = json!([binding(program)]);
        rejected(bad);
    }
    let deep: Vec<_> = (0..9).map(|_| json!({"op":"const","value":1})).collect();
    let mut bad = base();
    bad["bindings"] = json!([binding(json!(deep))]);
    rejected(bad);
}

#[test]
fn public_properties_resolve_only_declared_slots_without_effect_automation() {
    let value = base();
    let bytes = serde_json::to_vec(&value).unwrap();
    let mut metadata = manifest(&bytes);
    let property = json!({"id":"opacity","label":"透明度","type":"number","default":0.8,
        "constraints":{"min":0,"max":1},"target":{"kind":"node","nodeId":"background-layer","property":"opacity","component":null}});
    metadata
        .properties
        .push(property.as_object().unwrap().clone());
    assert_eq!(
        compile_document(&bytes, &metadata)
            .unwrap()
            .ir()
            .public_properties()
            .len(),
        1
    );
    metadata.properties[0]["constraints"] = json!({"min":0,"max":2});
    assert!(compile_document(&bytes, &metadata).is_err());
    metadata.properties[0]["constraints"] = json!({"min":0,"max":1});
    metadata.properties[0]["target"] =
        json!({"kind":"node","nodeId":"tint","property":"brightness","component":null});
    assert!(compile_document(&bytes, &metadata).is_err());
}

fn package(value: &Value) -> (Vec<u8>, Manifest) {
    package_document_bytes(serde_json::to_vec(value).unwrap())
}

fn package_document_bytes(bytes: Vec<u8>) -> (Vec<u8>, Manifest) {
    let metadata = manifest(&bytes);
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    for (name, body) in [
        ("manifest.json", serde_json::to_vec(&metadata).unwrap()),
        ("document.json", bytes),
        (
            "assets/background.png",
            b"synthetic-contract-asset".to_vec(),
        ),
    ] {
        zip.start_file(name, options).unwrap();
        zip.write_all(&body).unwrap();
    }
    (zip.finish().unwrap().into_inner(), metadata)
}

#[test]
fn both_package_entry_points_reject_hash_valid_but_semantically_invalid_documents() {
    let (bytes, metadata) = package(&base());
    validate_package(Cursor::new(&bytes)).unwrap();
    validate_archive(Cursor::new(&bytes), &metadata).unwrap();
    let mut bad = base();
    bad["nodes"][0]["properties"]["opacity"] = json!(2);
    let (bytes, metadata) = package(&bad);
    assert_eq!(
        validate_package(Cursor::new(&bytes)).unwrap_err().code,
        "invalid_composition"
    );
    assert_eq!(
        validate_archive(Cursor::new(&bytes), &metadata)
            .unwrap_err()
            .code,
        "invalid_composition"
    );
}

#[test]
fn decoded_duplicate_properties_are_rejected_at_real_zip_admission() {
    let original = serde_json::to_string(&base()).unwrap();
    for properties in [
        r#""properties":{"opacity":0.1,"\u006fpacity":0.9}"#,
        r#""properties":{"\u006fpacity":0.1,"\u006F\u0070acity":0.9}"#,
    ] {
        let document = original.replace(r#""properties":{}"#, properties);
        let (bytes, metadata) = package_document_bytes(document.into_bytes());
        assert_eq!(
            validate_package(Cursor::new(&bytes)).unwrap_err().code,
            "duplicate_key"
        );
        assert_eq!(
            validate_archive(Cursor::new(&bytes), &metadata)
                .unwrap_err()
                .code,
            "duplicate_key"
        );
    }
    let document = original.replace(r#""properties":{}"#, r#""properties":{"\u006fpacity":0.9}"#);
    let (bytes, metadata) = package_document_bytes(document.into_bytes());
    validate_package(Cursor::new(&bytes)).unwrap();
    validate_archive(Cursor::new(&bytes), &metadata).unwrap();
}

#[test]
fn registry_identity_rejects_altered_metadata_and_unsupported_contract_version() {
    let bytes = include_bytes!("../contracts/composition.json");
    assert!(parse_catalog(bytes).is_ok());
    let altered = String::from_utf8(bytes.to_vec())
        .unwrap()
        .replace("\"schemaVersion\": 1", "\"schemaVersion\": 2");
    assert!(parse_catalog(altered.as_bytes()).is_err());
    let escaped = String::from_utf8(bytes.to_vec())
        .unwrap()
        .replace("\"definitions\":", "\"\\u0064efinitions\":");
    assert!(parse_catalog(escaped.as_bytes()).is_ok());
    let altered = String::from_utf8(bytes.to_vec())
        .unwrap()
        .replace("\"opacity\":", "\"wrongOpacity\":");
    assert!(parse_catalog(altered.as_bytes()).is_err());
}

#[test]
fn pure_cache_eviction_keeps_consumers_and_target_identity_covers_device_facts() {
    use hertz_wallpaper::document::{ResolvedAssetIdentity, SemanticCache, TargetIdentity};
    use std::collections::BTreeMap;
    let compiled = compile(&base()).unwrap();
    let original_key = compiled.ir().semantic_key().to_owned();
    let mut cache = SemanticCache::new(1, 4 * 1024 * 1024);
    let original = cache.insert(compiled).unwrap();
    assert_eq!(cache.len(), 1);
    let mut changed = base();
    changed["nodes"][0]["properties"]["x"] = json!(4);
    cache.insert(compile(&changed).unwrap()).unwrap();
    assert!(cache.get(&original_key).is_none());
    assert_eq!(original.ir().semantic_key(), original_key);
    let mut identity = TargetIdentity {
        public_values: original.final_public_values(&BTreeMap::new()).unwrap(),
        resolved_assets: BTreeMap::from([(
            "background".to_owned(),
            ResolvedAssetIdentity {
                content_key: "immutable-content".into(),
                decode_options_hash: "a".repeat(64),
                adapter_version: 1,
                dependency_keys: BTreeMap::new(),
            },
        )]),
        capability_digest: "b".repeat(64),
        output_width: 1920,
        output_height: 1080,
        effective_budget_fps: 30.0,
        budget_allocation_revision: 1,
    };
    let key = identity.cache_key(&original).unwrap();
    identity.output_width = 2560;
    assert_ne!(key, identity.cache_key(&original).unwrap());
    identity.output_width = 1920;
    identity.budget_allocation_revision = 2;
    assert_ne!(key, identity.cache_key(&original).unwrap());
    identity.resolved_assets.clear();
    assert!(identity.cache_key(&original).is_err());
    cache.clear();
    assert!(cache.is_empty());
    assert_eq!(cache.serialized_bytes(), 0);
    let mut refused = SemanticCache::new(8, 1);
    let consumer = refused.insert(compile(&base()).unwrap()).unwrap();
    assert!(refused.is_empty());
    assert_eq!(consumer.ir().semantic_key(), original_key);
}

fn target_identity(
    compiled: &CompiledDocument,
    overrides: serde_json::Map<String, Value>,
) -> hertz_wallpaper::document::TargetIdentity {
    use hertz_wallpaper::document::{ResolvedAssetIdentity, TargetIdentity};
    use std::collections::BTreeMap;
    let public_values = compiled
        .final_public_values(&overrides.into_iter().collect())
        .unwrap();
    let resolved_assets = public_values
        .resource_uses()
        .iter()
        .map(|resource| {
            (
                resource.asset_id.clone(),
                ResolvedAssetIdentity {
                    content_key: format!("immutable-{}", resource.asset_id),
                    decode_options_hash: "a".repeat(64),
                    adapter_version: 1,
                    dependency_keys: BTreeMap::new(),
                },
            )
        })
        .collect();
    TargetIdentity {
        public_values,
        resolved_assets,
        capability_digest: "b".repeat(64),
        output_width: 1920,
        output_height: 1080,
        effective_budget_fps: 30.0,
        budget_allocation_revision: 1,
    }
}

#[test]
fn final_public_cost_values_change_target_keys_and_canonical_defaults_do_not() {
    use std::collections::BTreeMap;
    let mut value = base();
    let mut label = node("label", "text");
    label["assets"] = json!({"fontAsset":"background"});
    value["nodes"] = json!([node("dust", "particles"), label]);
    let bytes = serde_json::to_vec(&value).unwrap();
    let mut metadata = manifest(&bytes);
    metadata.assets[0].kind = hertz_wallpaper::AssetKind::Font;
    metadata.properties = vec![
        json!({"id":"count","label":"粒子数","type":"number","default":2048,
            "constraints":{"min":0,"max":65536},"target":{"kind":"node","nodeId":"dust","property":"count","component":null}})
            .as_object().unwrap().clone(),
        json!({"id":"caption","label":"文字","type":"text","default":"短文字",
            "constraints":{"maxLength":4096},"target":{"kind":"node","nodeId":"label","property":"text","component":null}})
            .as_object().unwrap().clone(),
    ];
    let compiled = compile_document(&bytes, &metadata).unwrap();
    let initial = target_identity(&compiled, serde_json::Map::new());
    assert_eq!(initial.public_values.values()["count"], json!(2048.0));
    let key = initial.cache_key(&compiled).unwrap();
    for overrides in [
        json!({"count":2048}),
        json!({"count":2048.0,"caption":"短文字"}),
    ] {
        assert_eq!(
            key,
            target_identity(&compiled, overrides.as_object().unwrap().clone())
                .cache_key(&compiled)
                .unwrap()
        );
    }
    for overrides in [
        json!({"count":65536}),
        json!({"caption":"最终公开覆盖后的更长文字"}),
    ] {
        assert_ne!(
            key,
            target_identity(&compiled, overrides.as_object().unwrap().clone())
                .cache_key(&compiled)
                .unwrap()
        );
    }
    let zero = target_identity(&compiled, json!({"count":0}).as_object().unwrap().clone());
    let negative_zero = target_identity(
        &compiled,
        json!({"count":-0.0}).as_object().unwrap().clone(),
    );
    assert_eq!(
        zero.cache_key(&compiled).unwrap(),
        negative_zero.cache_key(&compiled).unwrap()
    );
    for overrides in [
        json!({"unknown":1}),
        json!({"count":"2048"}),
        json!({"count":[2048]}),
        json!({"count":2048.5}),
        json!({"count":65537}),
        json!({"caption":null}),
        json!({"caption":"🙂".repeat(2049)}),
    ] {
        let overrides: BTreeMap<_, _> =
            overrides.as_object().unwrap().clone().into_iter().collect();
        assert_eq!(
            compiled.final_public_values(&overrides).unwrap_err().code,
            "invalid_property_value"
        );
    }
    let mut different = value.clone();
    different["nodes"][0]["properties"]["spread"] = json!(10);
    let different = compile_document(&serde_json::to_vec(&different).unwrap(), &metadata).unwrap();
    assert!(initial.cache_key(&different).is_err());
    metadata.properties[0]["default"] = json!(2048.5);
    assert!(compile_document(&bytes, &metadata).is_err());
}

#[test]
fn final_public_video_ranges_validate_combined_defaults_and_overrides() {
    use std::collections::BTreeMap;
    let mut value = base();
    value["nodes"][0]["type"] = json!("video");
    value["nodes"][0]["properties"] = json!({"loopStartMs":0,"loopEndMs":1000});
    let bytes = serde_json::to_vec(&value).unwrap();
    let mut metadata = manifest(&bytes);
    metadata.assets[0].kind = hertz_wallpaper::AssetKind::Video;
    metadata.properties = vec![
        json!({"id":"start","label":"开始","type":"number","default":0,
            "constraints":{"min":0,"max":86400000},"target":{"kind":"node","nodeId":"background-layer","property":"loopStartMs","component":null}})
            .as_object().unwrap().clone(),
        json!({"id":"end","label":"结束","type":"number","default":1000,
            "constraints":{"min":0.001,"max":86400000},"target":{"kind":"node","nodeId":"background-layer","property":"loopEndMs","component":null}})
            .as_object().unwrap().clone(),
    ];
    let compiled = compile_document(&bytes, &metadata).unwrap();
    let initial = target_identity(&compiled, serde_json::Map::new());
    let mut start_only = metadata.clone();
    start_only.properties.truncate(1);
    let start_only_compiled = compile_document(&bytes, &start_only).unwrap();
    assert!(start_only_compiled
        .final_public_values(&BTreeMap::from([("start".to_owned(), json!(2000))]))
        .is_err());
    start_only.properties[0]["default"] = json!(2000);
    assert!(compile_document(&bytes, &start_only)
        .unwrap()
        .final_public_values(&BTreeMap::new())
        .is_err());
    for overrides in [
        json!({"start":2000,"end":3000}),
        json!({"start":250.5,"end":750.5}),
        json!({"end":1500}),
    ] {
        let final_identity = target_identity(&compiled, overrides.as_object().unwrap().clone());
        assert_ne!(
            initial.cache_key(&compiled).unwrap(),
            final_identity.cache_key(&compiled).unwrap()
        );
    }
    for overrides in [
        json!({"start":1000}),
        json!({"start":2000}),
        json!({"start":2000,"end":2000}),
        json!({"start":2000,"end":1500}),
    ] {
        let overrides: BTreeMap<_, _> =
            overrides.as_object().unwrap().clone().into_iter().collect();
        assert_eq!(
            compiled.final_public_values(&overrides).unwrap_err().code,
            "invalid_composition"
        );
    }
    metadata.properties[0]["default"] = json!(2000);
    let invalid_defaults = compile_document(&bytes, &metadata).unwrap();
    assert_eq!(
        invalid_defaults
            .final_public_values(&BTreeMap::new())
            .unwrap_err()
            .code,
        "invalid_composition"
    );
    // A complete final input can repair the public defaults atomically.
    invalid_defaults
        .final_public_values(&BTreeMap::from([("end".to_owned(), json!(3000))]))
        .unwrap();
    metadata.properties[1]["default"] = json!(3000);
    compile_document(&bytes, &metadata)
        .unwrap()
        .final_public_values(&BTreeMap::new())
        .unwrap();
    for end in [json!(0), json!(-1), Value::Null] {
        value["nodes"][0]["properties"]["loopEndMs"] = end;
        assert!(compile_document(&serde_json::to_vec(&value).unwrap(), &metadata).is_err());
    }
}

#[test]
fn public_vector_components_remain_scalar_and_use_compiled_target_constraints() {
    use std::collections::BTreeMap;
    let mut value = base();
    let mut group = node("spatial", "group");
    group["properties"] = json!({"space":"3d"});
    value["nodes"] = json!([group]);
    let bytes = serde_json::to_vec(&value).unwrap();
    let mut metadata = manifest(&bytes);
    metadata.properties = vec![json!({"id":"turn","label":"旋转","type":"number","default":0,
        "constraints":{"min":-10000,"max":10000},"target":{"kind":"node","nodeId":"spatial","property":"rotation","component":1}})
        .as_object().unwrap().clone()];
    let compiled = compile_document(&bytes, &metadata).unwrap();
    compiled
        .final_public_values(&BTreeMap::from([("turn".to_owned(), json!(0.5))]))
        .unwrap();
    assert!(compiled
        .final_public_values(&BTreeMap::from([("turn".to_owned(), json!([0, 0.5, 0]))]))
        .is_err());
    for component in [Value::Null, json!(3)] {
        metadata.properties[0]["target"]["component"] = component;
        assert!(compile_document(&bytes, &metadata).is_err());
    }
    metadata.properties[0]["target"]["component"] = json!(1);
    metadata.properties[0]["constraints"]["max"] = json!(10001);
    assert!(compile_document(&bytes, &metadata).is_err());
    metadata.properties[0]["target"] =
        json!({"kind":"node","nodeId":"spatial","property":"opacity","component":0});
    metadata.properties[0]["constraints"] = json!({"min":0,"max":1});
    assert!(compile_document(&bytes, &metadata).is_err());
}

#[test]
fn final_public_asset_slots_require_the_replacement_and_preserve_other_users() {
    use std::collections::BTreeMap;
    let bytes = serde_json::to_vec(&base()).unwrap();
    let mut metadata = manifest(&bytes);
    let mut replacement = metadata.assets[0].clone();
    replacement.id = "replacement".to_owned();
    metadata.assets.push(replacement);
    metadata.properties = vec![
        json!({"id":"picture","label":"图片","type":"asset","default":"background",
        "constraints":{"kind":"image","options":["background","replacement"]},
        "target":{"kind":"node","nodeId":"background-layer","property":"asset","component":null}})
        .as_object()
        .unwrap()
        .clone(),
    ];
    let compiled = compile_document(&bytes, &metadata).unwrap();
    let mut replaced = target_identity(
        &compiled,
        json!({"picture":"replacement"})
            .as_object()
            .unwrap()
            .clone(),
    );
    assert_eq!(
        replaced.public_values.resource_uses()[0].asset_id,
        "replacement"
    );
    assert!(!replaced.resolved_assets.contains_key("background"));
    replaced.cache_key(&compiled).unwrap();
    let only_base = target_identity(&compiled, serde_json::Map::new()).resolved_assets;
    replaced.resolved_assets = only_base;
    assert!(replaced.cache_key(&compiled).is_err());
    for value in [json!("missing"), json!(3), json!("https://host/image.png")] {
        assert!(compiled
            .final_public_values(&BTreeMap::from([("picture".to_owned(), value)]))
            .is_err());
    }
    metadata.assets[1].kind = hertz_wallpaper::AssetKind::Video;
    assert!(compile_document(&bytes, &metadata).is_err());
    metadata.assets[1].kind = hertz_wallpaper::AssetKind::Image;
    let mut shared = base();
    shared["effects"] = json!([{"id":"mask","type":"mask","stateVersion":1,
        "target":{"kind":"node","nodeId":"background-layer"},"assets":{"maskAsset":"background"}}]);
    let shared = compile_document(&serde_json::to_vec(&shared).unwrap(), &metadata).unwrap();
    let mut replaced = target_identity(
        &shared,
        json!({"picture":"replacement"})
            .as_object()
            .unwrap()
            .clone(),
    );
    assert_eq!(replaced.public_values.resource_uses().len(), 2);
    replaced.cache_key(&shared).unwrap();
    replaced.resolved_assets.remove("background");
    assert!(replaced.cache_key(&shared).is_err());
}

#[test]
fn public_asset_defaults_populate_optional_final_slots() {
    let mut value = base();
    value["nodes"] = json!([node("dust", "particles")]);
    let bytes = serde_json::to_vec(&value).unwrap();
    let mut metadata = manifest(&bytes);
    metadata.properties = vec![
        json!({"id":"sprite","label":"粒子图片","type":"asset","default":"background",
        "constraints":{"kind":"image","options":["background"]},
        "target":{"kind":"node","nodeId":"dust","property":"spriteAsset","component":null}})
        .as_object()
        .unwrap()
        .clone(),
    ];
    let compiled = compile_document(&bytes, &metadata).unwrap();
    assert!(compiled.ir().resource_uses().is_empty());
    let mut final_identity = target_identity(&compiled, serde_json::Map::new());
    let resource = &final_identity.public_values.resource_uses()[0];
    assert_eq!(resource.asset_id, "background");
    assert_eq!(resource.field, "spriteAsset");
    assert_eq!(resource.usage, "color");
    final_identity.cache_key(&compiled).unwrap();
    final_identity.resolved_assets.clear();
    assert!(final_identity.cache_key(&compiled).is_err());
}

#[test]
fn public_manifest_semantics_cannot_alias_same_document_in_the_cache() {
    let bytes = serde_json::to_vec(&base()).unwrap();
    let mut metadata = manifest(&bytes);
    let first = compile_document(&bytes, &metadata).unwrap();
    metadata.properties.push(json!({"id":"opacity","label":"透明度","type":"number","default":0.8,
        "constraints":{"min":0,"max":1},"target":{"kind":"node","nodeId":"background-layer","property":"opacity","component":null}})
        .as_object().unwrap().clone());
    let second = compile_document(&bytes, &metadata).unwrap();
    assert_eq!(first.ir().document_hash(), second.ir().document_hash());
    assert_ne!(first.ir().semantic_key(), second.ir().semantic_key());
}

#[test]
fn structural_identity_fields_are_not_public_and_group_inheritance_is_compiled() {
    let mut value = base();
    let mut group = node("container", "group");
    group["children"] = json!(["background-layer"]);
    value["nodes"].as_array_mut().unwrap().push(group);
    let bytes = serde_json::to_vec(&value).unwrap();
    let mut metadata = manifest(&bytes);
    metadata.properties.push(
        json!({"id":"space","label":"空间","type":"select","default":"3d",
        "constraints":{"options":[{"value":"2d","label":"平面"},{"value":"3d","label":"空间"}]},
        "target":{"kind":"node","nodeId":"container","property":"space","component":null}})
        .as_object()
        .unwrap()
        .clone(),
    );
    assert!(compile_document(&bytes, &metadata).is_err());
    let compiled = compile(&value).unwrap();
    let slot = compiled.ir().nodes()[1].property_slots["opacity"][0];
    assert!(compiled.ir().slot_dependencies()[slot]
        .nodes
        .iter()
        .any(|target| target.node_index == 0 && target.mask & 4 != 0));
    assert!(compiled.ir().slot_dependencies()[slot].output);
    let visible = &compiled.ir().constant_dependencies()[1]["visible"];
    assert!(visible
        .nodes
        .iter()
        .any(|target| target.node_index == 0 && target.mask & 8 != 0));
    let mut value = base();
    let mut scene = node("original", "builtinScene");
    scene["properties"] = json!({"sceneId":"zodiac"});
    value["nodes"] = json!([scene]);
    let bytes = serde_json::to_vec(&value).unwrap();
    let mut metadata = manifest(&bytes);
    metadata.properties.push(json!({"id":"version","label":"版本","type":"number","default":2,
        "constraints":{"min":1,"max":2},"target":{"kind":"node","nodeId":"original","property":"stateVersion","component":null}})
        .as_object().unwrap().clone());
    assert!(compile_document(&bytes, &metadata).is_err());
}

#[test]
fn effect_metadata_declares_real_format_sampling_and_output_cost() {
    let mut value = base();
    value["effects"] = json!([{"id":"tint","type":"colorAdjust","stateVersion":1,"target":{"kind":"output"}},
        {"id":"glow","type":"glow","stateVersion":1,"target":{"kind":"output"}}]);
    let ir = serde_json::to_value(compile(&value).unwrap().ir()).unwrap();
    assert_eq!(ir["effectSurfaces"], json!([1, 2]));
    let requirements = ir["staticRequirements"].as_array().unwrap();
    let glow = requirements
        .iter()
        .find(|requirement| requirement["effectIndex"] == 1)
        .unwrap();
    assert_eq!(glow["outputFormat"], "rgba8");
    assert_eq!(glow["quality"]["low"]["sampleScale"], 0.25);
    assert_eq!(glow["cost"]["bytesPerPixel"], 4);
    assert_eq!(glow["inputTextures"], 1);
    assert_eq!(ir["effectDependencies"][1]["output"], true);
}

#[test]
fn text_cost_references_final_constant_and_builtin_constants_have_dirty_roles() {
    let mut value = base();
    let mut label = node("label", "text");
    label["assets"] = json!({"fontAsset":"background"});
    value["nodes"] = json!([label]);
    let bytes = serde_json::to_vec(&value).unwrap();
    let mut metadata = manifest(&bytes);
    metadata.assets[0].kind = hertz_wallpaper::AssetKind::Font;
    metadata.properties.push(json!({"id":"label","label":"文字","type":"text","default":"后来输入的文字",
        "constraints":{"maxLength":4096},"target":{"kind":"node","nodeId":"label","property":"text","component":null}})
        .as_object().unwrap().clone());
    let compiled = compile_document(&bytes, &metadata).unwrap();
    let ir = serde_json::to_value(compiled.ir()).unwrap();
    let requirement = ir["staticRequirements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|requirement| requirement["kind"] == "textLayout")
        .unwrap();
    let slot = requirement["constantSlot"].as_u64().unwrap() as usize;
    assert_eq!(
        ir["publicProperties"][0]["target"]["slot"]
            .as_u64()
            .unwrap() as usize,
        slot
    );
    assert_eq!(compiled.ir().constant_slots()[slot].property, "text");
    assert_eq!(requirement["maxUtf16Units"], 4096);
    assert!(requirement.get("utf16Units").is_none());
    let mut value = base();
    let mut scene = node("original", "builtinScene");
    scene["properties"] = json!({"sceneId":"zodiac"});
    value["nodes"] = json!([scene]);
    let compiled = compile(&value).unwrap();
    let constants: Vec<_> = compiled
        .ir()
        .constant_slots()
        .iter()
        .filter(|slot| slot.builtin_parameter)
        .collect();
    assert!(!constants.is_empty());
    for constant in constants {
        assert!(compiled.ir().constant_dependencies()[0][&constant.property].output);
    }
}
