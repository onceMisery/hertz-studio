// SPDX-License-Identifier: MIT
//! Literal author JSON through the original public owners, including raw_value
//! feature unification. A special-looking key is still an ordinary object key.

use std::io::{Cursor, Write};

use hertz_wallpaper::document::{catalog::Field, compile_document, Document, Effect, Node};
use hertz_wallpaper::properties::parse_property;
use hertz_wallpaper::{
    archive::inspect_package_identity, validate_manifest_bytes, Content, Manifest,
    PropertyDescriptor, PropertyType, SelectOption,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const RAW: &str = "$serde_json::private::RawValue";
const NUMBER: &str = "$serde_json::private::Number";

fn carrier(text: &str) -> Value {
    json!({RAW: text})
}

fn manifest_value() -> Value {
    json!({
        "formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae",
        "version":1,"title":"Literal JSON","description":"",
        "content":{"kind":"web","entry":"a","apiVersion":1},
        "assets":[],"files":[{"path":"a","bytes":1,
            "sha256":format!("{:x}",Sha256::digest(b"x")),"mime":"text/html"}],
        "properties":[],"permissions":{},"license":{"code":"none","assets":"none"}
    })
}

fn encoded(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}

fn archive(manifest: &[u8]) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    writer.start_file("manifest.json", options).unwrap();
    writer.write_all(manifest).unwrap();
    writer.start_file("a", options).unwrap();
    writer.write_all(b"x").unwrap();
    writer.finish().unwrap().into_inner()
}

fn rejected_manifest(bytes: &[u8], code: &str) {
    assert_eq!(validate_manifest_bytes(bytes).unwrap_err().code, code);
}

#[test]
fn root_and_escaped_carriers_cannot_replace_the_manifest() {
    let ordinary = encoded(&manifest_value());
    assert_eq!(
        validate_manifest_bytes(&ordinary).unwrap().title,
        "Literal JSON"
    );
    let text = String::from_utf8(ordinary).unwrap();
    let duplicate = format!("{},\"title\":\"hidden\"}}", &text[..text.len() - 1]);
    let deep = format!(
        "{},\"extra\":{}0{}}}",
        &text[..text.len() - 1],
        "[".repeat(30),
        "]".repeat(30)
    );
    for hidden in [&text, &duplicate, &deep, "null", "not JSON"] {
        let bytes = encoded(&carrier(hidden));
        rejected_manifest(&bytes, "invalid_manifest");
        let escaped = String::from_utf8(bytes)
            .unwrap()
            .replace("$serde", "\\u0024serde");
        rejected_manifest(escaped.as_bytes(), "invalid_manifest");
    }
}

#[test]
fn real_stored_zip_identity_rejects_hidden_duplicate_manifest() {
    let ordinary = encoded(&manifest_value());
    let identity = inspect_package_identity(Cursor::new(archive(&ordinary))).unwrap();
    assert_eq!(identity.manifest().title, "Literal JSON");
    assert_eq!(identity.entries().len(), 1);
    let text = String::from_utf8(ordinary).unwrap();
    let hidden = format!("{},\"title\":\"hidden\"}}", &text[..text.len() - 1]);
    let bytes = archive(&encoded(&carrier(&hidden)));
    let error = match inspect_package_identity(Cursor::new(bytes)) {
        Ok(_) => panic!("carrier received a canonical identity"),
        Err(error) => error,
    };
    assert_eq!(error.code, "invalid_manifest");
}

#[test]
fn literal_duplicate_depth_and_unknown_error_priorities_are_preserved() {
    let text = String::from_utf8(encoded(&manifest_value())).unwrap();
    let duplicate = format!(
        "{},\"title\":\"hidden\",\"unknown\":true}}",
        &text[..text.len() - 1]
    );
    rejected_manifest(duplicate.as_bytes(), "duplicate_key");
    let escaped = format!("{},\"\\u0074itle\":\"hidden\"}}", &text[..text.len() - 1]);
    rejected_manifest(escaped.as_bytes(), "duplicate_key");
    let deep = format!(
        "{},\"unknown\":{}0{}}}",
        &text[..text.len() - 1],
        "[".repeat(30),
        "]".repeat(30)
    );
    rejected_manifest(deep.as_bytes(), "manifest_depth");
    let mut value = manifest_value();
    value["unknown"] = json!(true);
    rejected_manifest(&encoded(&value), "invalid_manifest");
    value["content"]["unknown"] = json!(true);
    rejected_manifest(&encoded(&value), "unknown_field");
    rejected_manifest(br#"{"a":1e999}"#, "invalid_json");
}

fn literal_values() -> Value {
    json!({
        RAW:"{\"hidden\":true}", NUMBER:"1.25",
        "nested":[null,true,-2,3,0.25,"quote\" slash\\ newline\n 中文 🙂",
            {RAW:"[1,2]","child":[{RAW:"null"}]}],
        "\\u0024serde_json::private::RawValue":"distinct literal backslash"
    })
}

#[test]
fn manifest_and_content_from_value_keep_nested_literal_objects() {
    let slots = literal_values();
    let mut value = manifest_value();
    value["properties"] = json!([slots.clone(), {}]);
    value["content"] = json!({"kind":"builtin","sceneId":"zodiac","stateVersion":1,"params":slots});
    let from_value: Manifest = serde_json::from_value(value.clone()).unwrap();
    let from_bytes: Manifest = serde_json::from_slice(&encoded(&value)).unwrap();
    for manifest in [from_value, from_bytes] {
        assert_eq!(
            manifest.properties[0],
            value["properties"][0].as_object().unwrap().clone()
        );
        assert!(manifest.properties[1].is_empty());
        let Content::Builtin { params, .. } = manifest.content else {
            panic!("builtin required")
        };
        assert_eq!(Value::Object(params), value["content"]["params"]);
    }
    let content: Content = serde_json::from_value(value["content"].clone()).unwrap();
    let Content::Builtin { params, .. } = content else {
        panic!("builtin required")
    };
    assert_eq!(Value::Object(params), value["content"]["params"]);
}

#[test]
fn open_select_option_slots_keep_scalars_escaped_keys_and_containers() {
    let ordinary = json!([
        null,
        true,
        false,
        -1,
        0,
        18446744073709551615u64,
        0.5,
        "x\n🙂",
        [],
        {},
        literal_values()
    ]);
    for value in ordinary.as_array().unwrap() {
        let option = json!({"value":value,"label":"Literal"});
        let parsed: SelectOption = serde_json::from_slice(&encoded(&option)).unwrap();
        assert_eq!(&parsed.value, value);
        let parsed: SelectOption = serde_json::from_value(option).unwrap();
        assert_eq!(&parsed.value, value);
    }
    let bytes = br#"{"value":{"\u0024serde_json::private::RawValue":"null","a\/b":["\ud83d\ude42",{"\u006b":true}]},"label":"escaped"}"#;
    let parsed: SelectOption = serde_json::from_slice(bytes).unwrap();
    assert_eq!(parsed.value[RAW], "null");
    assert_eq!(parsed.value["a/b"][0], "🙂");
    assert_eq!(parsed.value["a/b"][1]["k"], true);
}

fn property() -> Value {
    json!({"id":"gain","label":"Gain","type":"number","default":0.5,
        "constraints":{"min":0,"max":1},
        "target":{"kind":"node","nodeId":"content","property":"gain","component":null}})
}

#[test]
fn property_default_constraints_and_option_values_cannot_be_reinterpreted() {
    let normal = property();
    assert_eq!(
        parse_property(normal.as_object().unwrap()).unwrap().default,
        0.5
    );
    for key in ["default", "constraints"] {
        let mut value = normal.clone();
        value[key] = carrier(&serde_json::to_string(&value[key]).unwrap());
        assert!(parse_property(value.as_object().unwrap()).is_err(), "{key}");
        assert!(
            serde_json::from_value::<PropertyDescriptor>(value.clone()).is_err(),
            "{key}"
        );
        assert!(
            serde_json::from_slice::<PropertyDescriptor>(&encoded(&value)).is_err(),
            "{key}"
        );
    }
    let mut select = normal;
    select["type"] = json!("select");
    select["constraints"] = json!({"options":[{"value":0.5,"label":"Half"}]});
    assert!(parse_property(select.as_object().unwrap()).is_ok());
    select["constraints"]["options"][0]["value"] = carrier("0.5");
    assert!(parse_property(select.as_object().unwrap()).is_err());
    assert!(serde_json::from_value::<PropertyDescriptor>(select).is_err());
}

#[test]
fn original_unit_enums_target_sequences_and_struct_sequences_remain_legal() {
    let mut select = property();
    for spelling in [json!("select"), json!({"select":null})] {
        select["type"] = spelling;
        select["constraints"] = json!({"options":[{"value":0.5,"label":"Half"}]});
        select["target"] =
            json!({"kind":"node","nodeId":"content","property":"gain","component":null});
        let parsed: PropertyDescriptor = serde_json::from_value(select.clone()).unwrap();
        assert_eq!(parsed.property_type, PropertyType::Select);
    }
    select["target"] = json!(["node", "content", "gain", null]);
    // Internally tagged enums accept a sequence whose first item is the tag,
    // followed by the original variant struct fields.
    let parsed: PropertyDescriptor = serde_json::from_value(select).unwrap();
    assert_eq!(parsed.property_type, PropertyType::Select);
    let mut value = manifest_value();
    value["content"] = json!(["builtin", "zodiac", 1, {}]);
    let parsed: Manifest = serde_json::from_value(value.clone()).unwrap();
    assert!(matches!(parsed.content, Content::Builtin { params, .. } if params.is_empty()));
    let sequence = json!([
        value["formatVersion"],
        value["workId"],
        value["version"],
        value["title"],
        value["description"],
        value["content"],
        value["assets"],
        value["files"],
        value["properties"],
        value["permissions"],
        value["license"]
    ]);
    let parsed: Manifest = serde_json::from_value(sequence).unwrap();
    assert_eq!(parsed.title, "Literal JSON");
    let option: SelectOption =
        serde_json::from_value(json!([literal_values(), "sequence"])).unwrap();
    assert_eq!(option.value, literal_values());
}

#[test]
fn null_empty_and_missing_maps_and_options_keep_original_semantics() {
    let value = json!({"kind":"builtin","sceneId":"zodiac","stateVersion":1,"params":{}});
    let parsed: Content = serde_json::from_value(value).unwrap();
    assert!(matches!(parsed, Content::Builtin { params, .. } if params.is_empty()));
    let parsed: Content =
        serde_json::from_value(json!({"kind":"builtin","sceneId":"zodiac","stateVersion":1}))
            .unwrap();
    assert!(matches!(parsed, Content::Builtin { params, .. } if params.is_empty()));
    let null = json!({"kind":"builtin","sceneId":"zodiac","stateVersion":1,"params":null});
    assert!(serde_json::from_value::<Content>(null.clone()).is_err());
    assert!(serde_json::from_slice::<Content>(&encoded(&null)).is_err());
    let mut value = manifest_value();
    value["properties"] = json!([null]);
    assert!(serde_json::from_value::<Manifest>(value.clone()).is_err());
    assert!(serde_json::from_slice::<Manifest>(&encoded(&value)).is_err());
    for default in [Value::Null, json!(false), json!({})] {
        let field: Field =
            serde_json::from_value(json!({"type":"sceneParams","default":default})).unwrap();
        assert_eq!(
            field.default,
            if default.is_null() {
                None
            } else {
                Some(default)
            }
        );
    }
    let field: Field = serde_json::from_value(json!({"type":"sceneParams"})).unwrap();
    assert!(field.default.is_none());
    let mut node = json!({"id":"n","type":"group","stateVersion":1});
    assert!(serde_json::from_value::<Node>(node.clone())
        .unwrap()
        .properties
        .is_empty());
    node["properties"] = json!({});
    assert!(serde_json::from_value::<Node>(node.clone()).is_ok());
    node["properties"] = Value::Null;
    assert!(serde_json::from_value::<Node>(node).is_err());
}

fn document_value() -> Value {
    json!({"documentVersion":1,"canvas":{"width":1920,"height":1080,"colorSpace":"srgb","background":"#101010"},
        "nodes":[{"id":"g","type":"group","stateVersion":1,"properties":{"opacity":0.5}}],
        "timeline":{"durationSeconds":30,"loop":true,"tracks":[]},"bindings":[],
        "effects":[{"id":"glow","type":"glow","stateVersion":1,"target":{"kind":"output"},"properties":{}}]})
}

fn compile(value: &Value) -> hertz_wallpaper::Result<hertz_wallpaper::document::CompiledDocument> {
    let bytes = encoded(value);
    let mut manifest = manifest_value();
    manifest["content"] = json!({"kind":"composition","document":"a"});
    manifest["files"][0]["bytes"] = json!(bytes.len());
    manifest["files"][0]["sha256"] = json!(format!("{:x}", Sha256::digest(&bytes)));
    manifest["files"][0]["mime"] = json!("application/json");
    compile_document(
        &bytes,
        &validate_manifest_bytes(&encoded(&manifest)).unwrap(),
    )
}

#[test]
fn document_node_and_effect_values_remain_literal_at_parse_and_compile() {
    let normal = document_value();
    let compiled = compile(&normal).unwrap();
    assert_eq!(compiled.document().nodes[0].properties["opacity"], 0.5);
    for slot in ["node", "effect"] {
        let mut value = normal.clone();
        let properties = if slot == "node" {
            &mut value["nodes"][0]["properties"]
        } else {
            &mut value["effects"][0]["properties"]
        };
        properties[if slot == "node" {
            "opacity"
        } else {
            "strength"
        }] = carrier("0.5");
        let parsed: Document = serde_json::from_slice(&encoded(&value)).unwrap();
        let retained = if slot == "node" {
            &parsed.nodes[0].properties["opacity"]
        } else {
            &parsed.effects[0].properties["strength"]
        };
        assert_eq!(retained, &carrier("0.5"));
        assert_eq!(compile(&value).unwrap_err().code, "invalid_composition");
    }
    let node: Node =
        serde_json::from_value(json!(["n", "group", 1, [], {}, literal_values()])).unwrap();
    assert_eq!(
        Value::Object(node.properties.into_iter().collect()),
        literal_values()
    );
    let effect: Effect =
        serde_json::from_value(json!(["e","glow",1,{"kind":"output"},{},literal_values()]))
            .unwrap();
    assert_eq!(effect.properties[RAW], "{\"hidden\":true}");
}

#[test]
fn scene_catalog_keeps_literal_carriers_and_raw_hash_identity() {
    let hidden = format!(
        "{{\"id\":\"hidden\",\"x\":{}0{}}}",
        "[".repeat(30),
        "]".repeat(30)
    );
    let scenes = json!([carrier(&hidden), literal_values(), null, [true, {RAW:"null"}]]);
    let bytes = encoded(&scenes);
    let catalog = encoded(
        &json!({"schemaVersion":1,"registryHash":format!("{:x}",Sha256::digest(&bytes)),"scenes":scenes}),
    );
    let parsed = hertz_wallpaper::catalog::parse_catalog(&catalog).unwrap();
    assert_eq!(parsed.scenes, scenes.as_array().unwrap().clone());
    assert_eq!(parsed.scenes[0][RAW], hidden);
    assert!(parsed.scene("hidden").is_none());
    let padded = String::from_utf8(catalog)
        .unwrap()
        .replace("\"scenes\":[", "\"scenes\":[ ");
    assert_eq!(
        hertz_wallpaper::catalog::parse_catalog(padded.as_bytes())
            .unwrap_err()
            .code,
        "registry_hash_mismatch"
    );
}

#[test]
fn composition_declaration_defaults_keep_literal_values_before_validation() {
    let default = literal_values();
    let field: Field =
        serde_json::from_value(json!({"type":"sceneParams","default":default})).unwrap();
    assert_eq!(field.default.as_ref(), Some(&default));
    let definitions = json!({"nodes":[{"type":"group","stateVersion":1,"space":"2d",
        "properties":{"opacity":{"type":"number","min":0,"max":1,"default":0.5}},"assets":{}}],
        "effects":[],"inputs":[]});
    let catalog = |definitions: &Value| {
        encoded(&json!({"schemaVersion":1,
        "registryHash":format!("{:x}",Sha256::digest(encoded(definitions))),"definitions":definitions}))
    };
    assert!(hertz_wallpaper::document::catalog::parse_catalog(&catalog(&definitions)).is_ok());
    let mut hidden = definitions;
    hidden["nodes"][0]["properties"]["opacity"]["default"] = carrier("0.5");
    let error = match hertz_wallpaper::document::catalog::parse_catalog(&catalog(&hidden)) {
        Ok(_) => panic!("literal default was reinterpreted"),
        Err(error) => error,
    };
    assert_eq!(error.code, "invalid_composition_catalog");
}

#[derive(Clone, Copy)]
enum Scalar {
    I128(i128),
    U128(u128),
    Float(f64),
    None,
    Unit,
    Some,
    Label,
}

impl<'de> serde::Deserializer<'de> for Scalar {
    type Error = serde::de::value::Error;

    fn deserialize_any<V: serde::de::Visitor<'de>>(
        self,
        visitor: V,
    ) -> Result<V::Value, Self::Error> {
        match self {
            Self::I128(value) => visitor.visit_i128(value),
            Self::U128(value) => visitor.visit_u128(value),
            Self::Float(value) => visitor.visit_f64(value),
            Self::None => visitor.visit_none(),
            Self::Unit => visitor.visit_unit(),
            Self::Some => visitor.visit_some(Scalar::I128(7)),
            Self::Label => visitor.visit_string("Scalar".to_owned()),
        }
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes byte_buf
        option unit unit_struct newtype_struct seq tuple tuple_struct map struct enum identifier ignored_any
    }
}

impl<'de> serde::de::IntoDeserializer<'de, serde::de::value::Error> for Scalar {
    type Deserializer = Self;
    fn into_deserializer(self) -> Self {
        self
    }
}

#[test]
fn literal_scalar_callbacks_match_locked_value_scalar_semantics_and_errors() {
    for scalar in [
        Scalar::I128(-7),
        Scalar::I128(i128::MAX),
        Scalar::U128(7),
        Scalar::U128(u128::MAX),
        Scalar::Float(0.5),
        Scalar::Float(f64::NAN),
        Scalar::Float(f64::INFINITY),
        Scalar::None,
        Scalar::Unit,
        Scalar::Some,
        Scalar::Label,
    ] {
        let expected = Value::deserialize(scalar);
        let entries = [("value", scalar), ("label", Scalar::Label)];
        let actual =
            SelectOption::deserialize(serde::de::value::MapDeserializer::new(entries.into_iter()));
        match (expected, actual) {
            (Ok(expected), Ok(actual)) => assert_eq!(actual.value, expected),
            (Err(expected), Err(actual)) => assert_eq!(actual.to_string(), expected.to_string()),
            (expected, actual) => panic!("scalar compatibility mismatch: {expected:?}, {actual:?}"),
        }
    }
}
