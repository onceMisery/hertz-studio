// SPDX-License-Identifier: MIT
//! AI subset boundaries; these tests exercise the shared published compiler.

use std::collections::BTreeMap;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::*;
use crate::AssetKind;

fn selected() -> AssetSet {
    AssetSet::parse(
        br#"{"assets":[{"alias":"picture","kind":"image","width":1920,"height":1080},{"alias":"font","kind":"font"},{"alias":"mask","kind":"texture","width":64,"height":64}]}"#,
    )
    .unwrap()
}

fn node(id: &str) -> Value {
    json!({"id":id,"type":"image","stateVersion":1,"assets":{"asset":"picture"},"properties":{}})
}

fn output() -> Value {
    json!({"kind":"composition","document":{
        "documentVersion":1,
        "canvas":{"width":1920,"height":1080,"colorSpace":"srgb","background":"#101010"},
        "nodes":[node("background")],
        "timeline":{"durationSeconds":30,"loop":true,"tracks":[]},
        "bindings":[],"effects":[]
    }})
}

fn parse(value: &Value) -> crate::Result<CompositionOutput> {
    CompositionOutput::parse(&serde_json::to_vec(value).unwrap(), &selected())
}

fn binding(id: &str, target: &str, input: &str) -> Value {
    json!({"id":id,"target":{"nodeId":target,"property":"opacity","component":null},
        "mode":"multiply","parameters":{},"program":[{"op":"input","name":input}]})
}

#[test]
fn metadata_rejects_private_unknown_fields_and_duplicate_keys() {
    for field in [
        "filename",
        "path",
        "url",
        "description",
        "title",
        "license",
        "bytes",
        "sha256",
    ] {
        let mut value = json!({"assets":[{"alias":"font","kind":"font"}]});
        value["assets"][0][field] = json!("private-data");
        assert!(
            AssetSet::parse(&serde_json::to_vec(&value).unwrap()).is_err(),
            "{field}"
        );
    }
    assert!(
        AssetSet::parse(br#"{"assets":[{"alias":"font","kind":"font"}],"permissions":{}}"#)
            .is_err()
    );
    let duplicate = br#"{"assets":[{"alias":"font","alias":"other","kind":"font"}]}"#;
    assert_eq!(
        AssetSet::parse(duplicate).unwrap_err().code,
        "duplicate_key"
    );
    assert!(AssetSet::parse(br#"{"assets":[{"alias":"font","kind":"script"}]}"#).is_err());
    assert!(AssetSet::parse(&[0xff]).is_err());
}

#[test]
fn metadata_aliases_are_unique_bounded_local_ids() {
    for alias in [
        "",
        "A",
        "a_b",
        "../asset",
        "assets/image.png",
        "https://local/asset",
        "a\\b",
        "a\n",
    ] {
        let value = json!({"assets":[{"alias":alias,"kind":"font"}]});
        assert!(
            AssetSet::parse(&serde_json::to_vec(&value).unwrap()).is_err(),
            "{alias}"
        );
    }
    for length in [64, 65] {
        let value = json!({"assets":[{"alias":"a".repeat(length),"kind":"font"}]});
        assert_eq!(
            AssetSet::parse(&serde_json::to_vec(&value).unwrap()).is_ok(),
            length == 64
        );
    }
    assert!(AssetSet::parse(
        br#"{"assets":[{"alias":"font","kind":"font"},{"alias":"font","kind":"model"}]}"#
    )
    .is_err());
}

#[test]
fn metadata_counts_and_wire_bytes_are_bounded() {
    for count in [0, 1, MAX_ASSETS, MAX_ASSETS + 1] {
        let assets: Vec<_> = (0..count)
            .map(|i| json!({"alias":format!("font-{i}"),"kind":"font"}))
            .collect();
        let value = json!({"assets":assets});
        assert_eq!(
            AssetSet::parse(&serde_json::to_vec(&value).unwrap()).is_ok(),
            (1..=MAX_ASSETS).contains(&count)
        );
    }
    let mut bytes = br#"{"assets":[{"alias":"font","kind":"font"}]}"#.to_vec();
    bytes.resize(MAX_ASSET_SET_BYTES, b' ');
    assert!(AssetSet::parse(&bytes).is_ok());
    bytes.push(b' ');
    assert!(AssetSet::parse(&bytes).is_err());
}

#[test]
fn metadata_requires_only_dimensions_and_duration_needed_for_kind() {
    for kind in ["image", "video", "texture"] {
        let mut value = json!({"assets":[{"alias":"asset","kind":kind,"width":1,"height":16384}]});
        if kind == "video" {
            value["assets"][0]["durationMs"] = json!(1);
        }
        assert!(AssetSet::parse(&serde_json::to_vec(&value).unwrap()).is_ok());
        for field in ["width", "height"] {
            let mut missing = value.clone();
            missing["assets"][0].as_object_mut().unwrap().remove(field);
            assert!(AssetSet::parse(&serde_json::to_vec(&missing).unwrap()).is_err());
            for number in [0, 16385] {
                let mut invalid = value.clone();
                invalid["assets"][0][field] = json!(number);
                assert!(AssetSet::parse(&serde_json::to_vec(&invalid).unwrap()).is_err());
            }
        }
    }
    for kind in ["font", "model", "vector"] {
        let value = json!({"assets":[{"alias":"asset","kind":kind}]});
        assert!(AssetSet::parse(&serde_json::to_vec(&value).unwrap()).is_ok());
    }
    assert!(AssetSet::parse(
        br#"{"assets":[{"alias":"shape","kind":"vector","width":10,"height":20}]}"#
    )
    .is_ok());
    assert!(
        AssetSet::parse(br#"{"assets":[{"alias":"shape","kind":"vector","width":10}]}"#).is_err()
    );
    for kind in ["image", "texture", "font", "model", "vector"] {
        let mut value = json!({"assets":[{"alias":"asset","kind":kind,"durationMs":1}]});
        if kind == "image" || kind == "texture" {
            value["assets"][0]["width"] = json!(1);
            value["assets"][0]["height"] = json!(1);
        }
        assert!(AssetSet::parse(&serde_json::to_vec(&value).unwrap()).is_err());
    }
    for duration in [Value::Null, json!(0), json!(-1), json!(1.5)] {
        let value = json!({"assets":[{"alias":"clip","kind":"video","width":1,"height":1,"durationMs":duration}]});
        assert!(AssetSet::parse(&serde_json::to_vec(&value).unwrap()).is_err());
    }
    for kind in ["font", "model"] {
        let value = json!({"assets":[{"alias":"asset","kind":kind,"width":1,"height":1}]});
        assert!(AssetSet::parse(&serde_json::to_vec(&value).unwrap()).is_err());
    }
}

#[test]
fn vector_extents_are_positive_pairs_without_raster_edge_limit() {
    for width in [16_385, u32::MAX] {
        let value = json!({"assets":[{"alias":"shape","kind":"vector","width":width,"height":1}]});
        let parsed = AssetSet::parse(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(parsed.assets[0].width, Some(width));
        assert_eq!(parsed.assets[0].height, Some(1));
        assert!(parsed.validate().is_ok());
    }
    for value in [
        json!({"assets":[{"alias":"shape","kind":"vector","width":0,"height":1}]}),
        json!({"assets":[{"alias":"shape","kind":"vector","width":16385}]}),
        json!({"assets":[{"alias":"shape","kind":"vector","height":1}]}),
    ] {
        assert!(AssetSet::parse(&serde_json::to_vec(&value).unwrap()).is_err());
    }
}

fn near_wire_limit_text_output() -> Vec<u8> {
    let mut value = output();
    value["document"].as_object_mut().unwrap().remove("effects");
    value["document"]["nodes"] = json!((0..32)
        .map(|i| json!({
            "id":format!("n-{i}"),"type":"text","stateVersion":1,
            "assets":{"fontAsset":"font"},"properties":{"text":"x".repeat(1930)}
        }))
        .collect::<Vec<_>>());
    let raw = serde_json::to_vec(&value).unwrap();
    assert!(raw.len() <= MAX_OUTPUT_BYTES, "raw bytes {}", raw.len());
    let typed: CompositionOutput = serde_json::from_slice(&raw).unwrap();
    let typed_bytes = serde_json::to_vec(&typed).unwrap();
    assert!(
        typed_bytes.len() > MAX_OUTPUT_BYTES,
        "typed bytes {}",
        typed_bytes.len()
    );
    raw
}

#[test]
fn parsed_wire_limit_does_not_shrink_when_serde_inserts_defaults() {
    let raw = near_wire_limit_text_output();
    let parsed = CompositionOutput::parse(&raw, &selected()).unwrap();
    let compiled = parsed.validate(&selected()).unwrap();
    assert_eq!(compiled.document().nodes.len(), 32);
    assert_eq!(
        compiled.document().nodes[0].properties["text"],
        "x".repeat(1930)
    );
    let mut oversized = raw;
    oversized.resize(MAX_OUTPUT_BYTES + 1, b' ');
    assert!(CompositionOutput::parse(&oversized, &selected()).is_err());
}

#[test]
fn remapped_native_document_accepts_defaults_expanding_past_wire_limit() {
    let raw = near_wire_limit_text_output();
    let typed: CompositionOutput = serde_json::from_slice(&raw).unwrap();
    let remapped = typed
        .remap_assets(&BTreeMap::from([("font".into(), "saved-font".into())]))
        .unwrap();
    assert_eq!(remapped.nodes.len(), 32);
    for node in &remapped.nodes {
        assert_eq!(node.assets["fontAsset"], "saved-font");
        assert_eq!(node.properties["text"], "x".repeat(1930));
    }
    assert!(serde_json::to_vec(&remapped).unwrap().len() <= crate::document::MAX_DOCUMENT_BYTES);
}

#[test]
fn constructed_output_and_remap_keep_native_document_byte_cap() {
    let mut typed: CompositionOutput =
        serde_json::from_slice(&near_wire_limit_text_output()).unwrap();
    typed.document.nodes[0].properties.insert(
        "text".into(),
        json!("x".repeat(crate::document::MAX_DOCUMENT_BYTES)),
    );
    assert_eq!(
        typed.validate(&selected()).unwrap_err().code,
        "document_too_large"
    );
    assert_eq!(
        typed
            .remap_assets(&BTreeMap::from([("font".into(), "saved-font".into())]))
            .unwrap_err()
            .code,
        "document_too_large"
    );
}

#[test]
fn document_writer_rejects_oversize_fragments_before_buffer_growth() {
    use std::io::Write;

    let mut typed: CompositionOutput =
        serde_json::from_slice(&near_wire_limit_text_output()).unwrap();
    typed.document.nodes[0].properties.insert(
        "text".into(),
        json!("x".repeat(2 * crate::document::MAX_DOCUMENT_BYTES)),
    );
    let mut writer = DocumentWriter::default();
    assert!(serde_json::to_writer(&mut writer, &typed.document).is_err());
    assert!(writer.exceeded);
    // The real serializer presents this large ASCII string as one fragment.
    // The capped writer retains only its preceding JSON header, not the string.
    assert!(writer.bytes.len() < 16 * 1024);
    assert!(writer.bytes.capacity() <= crate::document::MAX_DOCUMENT_BYTES);

    let mut writer = DocumentWriter::default();
    writer
        .write_all(&vec![b'x'; crate::document::MAX_DOCUMENT_BYTES])
        .unwrap();
    assert_eq!(writer.bytes.len(), crate::document::MAX_DOCUMENT_BYTES);
    let capacity = writer.bytes.capacity();
    assert!(writer.write_all(b"more").is_err());
    assert_eq!(writer.bytes.len(), crate::document::MAX_DOCUMENT_BYTES);
    assert_eq!(writer.bytes.capacity(), capacity);
    assert!(capacity <= crate::document::MAX_DOCUMENT_BYTES);
}

#[test]
fn typed_property_depth_rejects_before_serialization_and_remap_clone() {
    let mut typed = parse(&output()).unwrap();
    let mut deep = json!(0);
    for _ in 0..32 {
        deep = Value::Array(vec![deep]);
    }
    // A post-serialization size check reports the later huge string instead.
    // Bounded prewalking must reject nesting before serde or document.clone.
    typed.document.nodes[0]
        .properties
        .insert("a-depth".into(), deep);
    typed.document.nodes[0].properties.insert(
        "z-payload".into(),
        json!("x".repeat(2 * crate::document::MAX_DOCUMENT_BYTES)),
    );
    assert_eq!(
        typed.validate(&selected()).unwrap_err().code,
        "manifest_depth"
    );
    assert_eq!(
        typed
            .remap_assets(&BTreeMap::from([("picture".into(), "saved".into())]))
            .unwrap_err()
            .code,
        "manifest_depth"
    );
}

#[test]
fn property_precheck_bounds_depth_and_flat_visits_without_a_member_queue() {
    let flat = Value::Array(vec![Value::Null; 1000]);
    let mut remaining = 8;
    assert_eq!(
        check_value_depth(&flat, 4, &mut remaining)
            .unwrap_err()
            .code,
        "document_too_large"
    );
    assert_eq!(remaining, 0);

    let mut remaining = crate::document::MAX_DOCUMENT_BYTES;
    assert!(check_value_depth(
        &json!([]),
        crate::document::MAX_DOCUMENT_DEPTH,
        &mut remaining
    )
    .is_ok());
    assert_eq!(
        check_value_depth(
            &json!([0]),
            crate::document::MAX_DOCUMENT_DEPTH,
            &mut remaining
        )
        .unwrap_err()
        .code,
        "manifest_depth"
    );

    let mut typed = parse(&output()).unwrap();
    typed.document.effects.push(
        serde_json::from_value(json!({
            "id":"effect","type":"colorAdjust","stateVersion":1,"target":{"kind":"output"}
        }))
        .unwrap(),
    );
    let mut deep = json!(0);
    for _ in 0..32 {
        deep = Value::Array(vec![deep]);
    }
    typed.document.effects[0]
        .properties
        .insert("nested".into(), deep);
    assert_eq!(
        typed.validate(&selected()).unwrap_err().code,
        "manifest_depth"
    );
}

#[test]
fn canonical_metadata_digest_binds_values_and_ignores_order() {
    let mut set = selected();
    let bytes = set.canonical_bytes().unwrap();
    assert_eq!(bytes, br#"{"assets":[{"alias":"font","kind":"font"},{"alias":"mask","kind":"texture","width":64,"height":64},{"alias":"picture","kind":"image","width":1920,"height":1080}]}"#);
    assert_eq!(
        set.digest().unwrap(),
        format!("{:x}", Sha256::digest(&bytes))
    );
    let digest = set.digest().unwrap();
    set.assets.reverse();
    assert_eq!(set.canonical_bytes().unwrap(), bytes);
    assert_eq!(set.digest().unwrap(), digest);
    set.assets[0].width = Some(1919);
    assert_ne!(set.digest().unwrap(), digest);
    set.assets[0].alias = "../private".into();
    assert!(set.validate().is_err());
    assert!(set.digest().is_err());
    assert!(set.canonical_bytes().is_err());
}

#[test]
fn composition_uses_published_compiler_without_changing_author_document() {
    let parsed = parse(&output()).unwrap();
    assert!(parsed.document.nodes[0].properties.is_empty());
    let compiled = parsed.validate(&selected()).unwrap();
    assert_eq!(compiled.document().nodes[0].properties["opacity"], 1.0);
    assert_eq!(compiled.ir().resource_uses()[0].asset_id, "picture");
    assert_eq!(compiled.ir().resource_uses()[0].usage, "color");
    assert_eq!(compiled.ir().nodes()[0].node_type, "image");
}

#[test]
fn composition_requires_fixed_tag_and_denies_model_owned_authority() {
    for kind in ["builtin", "image", "script", "Composition"] {
        let mut value = output();
        value["kind"] = json!(kind);
        assert!(parse(&value).is_err());
    }
    for field in [
        "workKey",
        "packageHash",
        "displayId",
        "configRevision",
        "permissions",
        "applied",
        "sha256",
    ] {
        let mut value = output();
        value[field] = json!(true);
        assert!(parse(&value).is_err(), "{field}");
    }
    let mut value = output();
    value["document"]["permissions"] = json!({"pointer":true});
    assert!(parse(&value).is_err());
    let mut direct = parse(&output()).unwrap();
    direct.kind = crate::generation::WallpaperGenerationKind::Image;
    assert!(direct.validate(&selected()).is_err());
    assert!(direct.remap_assets(&BTreeMap::new()).is_err());
}

#[test]
fn composition_rejects_unknown_selected_aliases_resource_slots_and_wrong_kinds() {
    for alias in ["unknown", "../picture", "https://host/picture"] {
        let mut value = output();
        value["document"]["nodes"][0]["assets"]["asset"] = json!(alias);
        assert!(parse(&value).is_err());
    }
    let mut value = output();
    value["document"]["nodes"][0]["assets"]["asset"] = json!("font");
    assert!(parse(&value).is_err());
    let mut value = output();
    value["document"]["nodes"][0]["assets"]["shader"] = json!("picture");
    assert!(parse(&value).is_err());
    let mut value = output();
    value["document"]["nodes"][0]["assets"] = json!({});
    assert!(parse(&value).is_err());
    let mut value = output();
    value["document"]["effects"] = json!([{"id":"mask-effect","type":"mask","stateVersion":1,"target":{"kind":"node","nodeId":"background"},"assets":{"maskAsset":"unknown"}}]);
    assert!(parse(&value).is_err());
}

#[test]
fn compiler_restrictions_reject_code_unknown_nodes_versions_and_bad_graphs() {
    for kind in ["web", "script", "shader", "unknown"] {
        let mut value = output();
        value["document"]["nodes"][0]["type"] = json!(kind);
        assert!(parse(&value).is_err());
    }
    for property in ["shader", "script", "expression", "url"] {
        let mut value = output();
        value["document"]["nodes"][0]["properties"][property] = json!("eval()");
        assert!(parse(&value).is_err());
    }
    let mut value = output();
    value["document"]["documentVersion"] = json!(2);
    assert!(parse(&value).is_err());
    let mut value = output();
    value["document"]["nodes"][0]["stateVersion"] = json!(2);
    assert!(parse(&value).is_err());
    let mut value = output();
    value["document"]["nodes"][0]["properties"]["opacity"] = json!(1.001);
    assert!(parse(&value).is_err());
    let mut value = output();
    value["document"]["nodes"][0]["children"] = json!(["background"]);
    assert!(parse(&value).is_err());
    let mut value = output();
    value["document"]["effects"] =
        json!([{"id":"shader","type":"shader","stateVersion":1,"target":{"kind":"output"}}]);
    assert!(parse(&value).is_err());
    let mut value = output();
    value["document"]["effects"] = json!([{"id":"glow","type":"glow","stateVersion":1,"target":{"kind":"node","nodeId":"background"}}]);
    assert!(parse(&value).is_err());
}

#[test]
fn binding_inputs_remain_published_data_and_permissions_are_not_model_fields() {
    for input in ["pointerX", "pointerY", "energy", "spectrum63", "sceneTime"] {
        let mut value = output();
        value["document"]["bindings"] = json!([binding("pulse", "background", input)]);
        assert!(parse(&value).is_ok(), "{input}");
    }
    for input in ["pointer.x", "spectrum64", "filesystem", "fetch", "eval()"] {
        let mut value = output();
        value["document"]["bindings"] = json!([binding("pulse", "background", input)]);
        assert!(parse(&value).is_err(), "{input}");
    }
    let mut value = output();
    value["document"]["bindings"] = json!([binding("pulse", "background", "energy")]);
    value["document"]["bindings"][0]["program"] = json!([{"op":"eval","source":"1"}]);
    assert!(parse(&value).is_err());
    let mut value = output();
    value["document"]["bindings"] = json!([binding("pulse", "background", "energy")]);
    value["document"]["bindings"][0]["program"] = json!([{"op":"add"}]);
    assert!(parse(&value).is_err());
}

#[test]
fn ai_subset_accepts_exact_caps_and_rejects_each_overflow_before_compile() {
    let mut value = output();
    value["document"]["nodes"] = json!((0..MAX_NODES)
        .map(|i| node(&format!("node-{i}")))
        .collect::<Vec<_>>());
    value["document"]["effects"] = json!((0..MAX_EFFECTS).map(|i| json!({"id":format!("effect-{i}"),"type":"colorAdjust","stateVersion":1,"target":{"kind":"output"}})).collect::<Vec<_>>());
    value["document"]["timeline"]["tracks"] = json!((0..MAX_TRACKS).map(|i| json!({"id":format!("track-{i}"),"target":{"nodeId":format!("node-{i}"),"property":"opacity","component":null},"keys":[{"timeSeconds":0,"value":1,"easing":"linear"}]})).collect::<Vec<_>>());
    value["document"]["bindings"] = json!((0..MAX_BINDINGS)
        .map(|i| binding(&format!("binding-{i}"), &format!("node-{i}"), "sceneTime"))
        .collect::<Vec<_>>());
    assert!(parse(&value).is_ok());
    for path in ["nodes", "effects", "bindings", "tracks"] {
        let mut bad = value.clone();
        let array = if path == "tracks" {
            &mut bad["document"]["timeline"][path]
        } else {
            &mut bad["document"][path]
        };
        let extra = array[0].clone();
        array.as_array_mut().unwrap().push(extra);
        assert_eq!(
            parse(&bad).unwrap_err().code,
            "invalid_generation",
            "{path}"
        );
    }
}

#[test]
fn composition_bounds_cover_wire_bytes_depth_duplicate_keys_and_utf8() {
    let mut bytes = serde_json::to_vec(&output()).unwrap();
    bytes.resize(MAX_OUTPUT_BYTES, b' ');
    assert!(CompositionOutput::parse(&bytes, &selected()).is_ok());
    bytes.push(b' ');
    assert!(CompositionOutput::parse(&bytes, &selected()).is_err());
    let duplicate = String::from_utf8(serde_json::to_vec(&output()).unwrap())
        .unwrap()
        .replace(
            "\"kind\":\"composition\"",
            "\"kind\":\"composition\",\"kind\":\"composition\"",
        );
    assert_eq!(
        CompositionOutput::parse(duplicate.as_bytes(), &selected())
            .unwrap_err()
            .code,
        "duplicate_key"
    );
    let nested = format!(
        "{}0{}",
        "[".repeat(MAX_OUTPUT_DEPTH + 1),
        "]".repeat(MAX_OUTPUT_DEPTH + 1)
    );
    assert_eq!(
        CompositionOutput::parse(nested.as_bytes(), &selected())
            .unwrap_err()
            .code,
        "manifest_depth"
    );
    assert!(CompositionOutput::parse(&[0xff], &selected()).is_err());
}

#[test]
fn remap_changes_only_schema_resource_slots_preserving_matching_text() {
    let mut value = output();
    value["document"]["nodes"][0]["assets"]["maskAsset"] = json!("mask");
    value["document"]["nodes"].as_array_mut().unwrap().push(json!({"id":"label","type":"text","stateVersion":1,"assets":{"fontAsset":"font"},"properties":{"text":"picture font mask https://example.com"}}));
    value["document"]["effects"] = json!([{"id":"mask-effect","type":"mask","stateVersion":1,"target":{"kind":"node","nodeId":"background"},"assets":{"maskAsset":"mask"}}]);
    let parsed = parse(&value).unwrap();
    let mapping = BTreeMap::from([
        ("picture".into(), "saved-picture".into()),
        ("font".into(), "saved-font".into()),
        ("mask".into(), "saved-mask".into()),
    ]);
    let remapped = parsed.remap_assets(&mapping).unwrap();
    assert_eq!(remapped.nodes[0].assets["asset"], "saved-picture");
    assert_eq!(remapped.nodes[0].assets["maskAsset"], "saved-mask");
    assert_eq!(remapped.nodes[1].assets["fontAsset"], "saved-font");
    assert_eq!(remapped.effects[0].assets["maskAsset"], "saved-mask");
    assert_eq!(
        remapped.nodes[1].properties["text"],
        "picture font mask https://example.com"
    );
    assert_eq!(
        remapped.nodes[0].properties,
        parsed.document.nodes[0].properties
    );
    assert_eq!(
        remapped.effects[0].properties,
        parsed.document.effects[0].properties
    );
    assert_eq!(parsed.document.nodes[0].assets["asset"], "picture");
}

#[test]
fn remap_requires_complete_safe_mappings_and_known_schema_slots() {
    let parsed = parse(&output()).unwrap();
    assert!(parsed.remap_assets(&BTreeMap::new()).is_err());
    for target in ["../new", "assets/new.png", "https://new", "A"] {
        assert!(parsed
            .remap_assets(&BTreeMap::from([("picture".into(), target.into())]))
            .is_err());
    }
    let mut invalid = parsed.clone();
    invalid.document.nodes[0]
        .assets
        .insert("shader".into(), "picture".into());
    assert!(invalid
        .remap_assets(&BTreeMap::from([("picture".into(), "saved".into())]))
        .is_err());
    let mut invalid = parsed.clone();
    invalid.document.nodes[0].node_type = "script".into();
    assert!(invalid
        .remap_assets(&BTreeMap::from([("picture".into(), "saved".into())]))
        .is_err());
    let mut invalid = selected();
    invalid.assets[0].kind = AssetKind::Font;
    assert!(parsed.validate(&invalid).is_err());
}
