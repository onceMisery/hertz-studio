// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Public properties shared by package import, authoring, settings and playback.
//!
//! The wire shape is `{id,label,type,default,constraints,target}`. Evaluation
//! writes only the declared target into a copy of content; package data is never
//! changed. Composition and web targets receive structural validation only and
//! cannot be evaluated by this module.

use std::collections::BTreeSet;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Map, Value};

use crate::{catalog, valid_local_id, AssetKind, Content, Manifest, PackageError, Result};

pub const MAX_PROPERTIES: usize = 64;
pub const MAX_PROPERTY_BYTES: usize = 2048;
pub const MAX_PROPERTY_OPTIONS: usize = 64;
pub const MAX_TEXT_LENGTH: u32 = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PropertyType {
    Number,
    Boolean,
    Select,
    Color,
    Text,
    Asset,
}

/// The §9.3 target union. `component` is required even when it is null.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PropertyTarget {
    Node {
        node_id: String,
        property: String,
        #[serde(deserialize_with = "required_component")]
        component: Option<u32>,
    },
    Binding {
        binding_id: String,
        parameter: String,
    },
}

fn required_component<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<u32>, D::Error> {
    Option::<u32>::deserialize(deserializer)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelectOption {
    #[serde(deserialize_with = "crate::json::deserialize_literal_value")]
    pub value: Value,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PropertyConstraints {
    Number {
        min: f64,
        max: f64,
        /// Presentation hint, not a discrete grid imposed on native values.
        step: Option<f64>,
    },
    Boolean,
    Select {
        options: Vec<SelectOption>,
    },
    Color,
    Text {
        /// UTF-16 code units, matching the registry and browser string length.
        max_length: u32,
    },
    Asset {
        kind: AssetKind,
        options: Vec<String>,
    },
}

impl Serialize for PropertyConstraints {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let value = match self {
            Self::Number { min, max, step } => {
                let mut value = json!({ "min": min, "max": max });
                if let Some(step) = step {
                    value["step"] = json!(step);
                }
                value
            }
            Self::Boolean | Self::Color => json!({}),
            Self::Select { options } => json!({ "options": options }),
            Self::Text { max_length } => json!({ "maxLength": max_length }),
            Self::Asset { kind, options } => json!({ "kind": kind, "options": options }),
        };
        value.serialize(serializer)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyDescriptor {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub property_type: PropertyType,
    pub default: Value,
    pub constraints: PropertyConstraints,
    pub target: PropertyTarget,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawDescriptor {
    id: String,
    label: String,
    #[serde(rename = "type")]
    property_type: PropertyType,
    #[serde(deserialize_with = "crate::json::deserialize_literal_value")]
    default: Value,
    #[serde(deserialize_with = "crate::json::deserialize_literal_value")]
    constraints: Value,
    target: PropertyTarget,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NumberConstraints {
    min: f64,
    max: f64,
    #[serde(default, deserialize_with = "optional_step")]
    step: Option<f64>,
}

// Omitted step is allowed; explicit null is not a number.
fn optional_step<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<f64>, D::Error> {
    f64::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyConstraints {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SelectConstraints {
    options: Vec<SelectOption>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TextConstraints {
    max_length: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AssetConstraints {
    kind: AssetKind,
    options: Vec<String>,
}

impl<'de> Deserialize<'de> for PropertyDescriptor {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct DescriptorVisitor;
        impl<'de> serde::de::Visitor<'de> for DescriptorVisitor {
            type Value = PropertyDescriptor;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a public property object")
            }

            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let raw =
                    RawDescriptor::deserialize(serde::de::value::MapAccessDeserializer::new(map))?;
                let constraints = parse_constraints(raw.property_type, raw.constraints)
                    .map_err(serde::de::Error::custom)?;
                let property = PropertyDescriptor {
                    id: raw.id,
                    label: raw.label,
                    property_type: raw.property_type,
                    default: raw.default,
                    constraints,
                    target: raw.target,
                };
                validate_descriptor(&property).map_err(serde::de::Error::custom)?;
                Ok(property)
            }
        }
        deserializer.deserialize_map(DescriptorVisitor)
    }
}

fn parse_constraints(property_type: PropertyType, value: Value) -> Result<PropertyConstraints> {
    if !value.is_object() {
        return Err(invalid("公开参数 constraints 必须是对象"));
    }
    fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T> {
        serde_json::from_value(value).map_err(|error| invalid(format!("约束结构无效：{error}")))
    }
    Ok(match property_type {
        PropertyType::Number => {
            let NumberConstraints { min, max, step } = decode(value)?;
            PropertyConstraints::Number { min, max, step }
        }
        PropertyType::Boolean => {
            let _: EmptyConstraints = decode(value)?;
            PropertyConstraints::Boolean
        }
        PropertyType::Select => {
            if !value["options"]
                .as_array()
                .is_some_and(|options| options.iter().all(Value::is_object))
            {
                return Err(invalid("select options 必须是 value/label 对象数组"));
            }
            let SelectConstraints { options } = decode(value)?;
            PropertyConstraints::Select { options }
        }
        PropertyType::Color => {
            let _: EmptyConstraints = decode(value)?;
            PropertyConstraints::Color
        }
        PropertyType::Text => {
            let TextConstraints { max_length } = decode(value)?;
            PropertyConstraints::Text { max_length }
        }
        PropertyType::Asset => {
            let AssetConstraints { kind, options } = decode(value)?;
            PropertyConstraints::Asset { kind, options }
        }
    })
}

impl PropertyDescriptor {
    /// Bridge for the backwards-compatible `Manifest.properties` map storage.
    pub fn to_map(&self) -> Result<Map<String, Value>> {
        validate_descriptor(self)?;
        let Value::Object(object) = serde_json::to_value(self)
            .map_err(|error| invalid(format!("公开参数不可序列化：{error}")))?
        else {
            unreachable!("property descriptors serialize as objects")
        };
        Ok(object)
    }
}

/// Parse one strict descriptor, including bounds, target syntax and its default.
/// Use `validate_properties` for contextual registry/resource checks.
pub fn parse_property(object: &Map<String, Value>) -> Result<PropertyDescriptor> {
    check_encoded_size(object)?;
    serde_json::from_value(Value::Object(object.clone()))
        .map_err(|error| invalid(format!("公开参数结构无效：{error}")))
}

/// Validate the descriptor set and each explicit target against this manifest.
/// This deliberately does not call `validate_manifest`, avoiding recursion.
pub fn validate_properties(manifest: &Manifest) -> Result<Vec<PropertyDescriptor>> {
    if manifest.properties.len() > MAX_PROPERTIES {
        return Err(PackageError::new(
            "too_many_properties",
            "公开参数最多 64 项",
        ));
    }
    let schema = match &manifest.content {
        Content::Builtin {
            scene_id,
            state_version,
            params,
        } => {
            let schema = builtin_schema(scene_id, *state_version)?;
            validate_builtin_params(schema, params)?;
            Some(schema)
        }
        _ => None,
    };
    let mut ids = BTreeSet::new();
    let mut targets = BTreeSet::new();
    let mut properties = Vec::with_capacity(manifest.properties.len());
    for object in &manifest.properties {
        let property = parse_property(object)?;
        if !ids.insert(property.id.clone()) {
            return Err(invalid(format!("公开参数 id 重复：{}", property.id)));
        }
        if !targets.insert(property.target.clone()) {
            return Err(invalid(format!("公开参数 target 重复：{}", property.id)));
        }
        validate_asset_options(&property, manifest)?;
        match &manifest.content {
            Content::Builtin { .. } => {
                let parameter = content_target(&property)?;
                let spec = schema
                    .and_then(|schema| schema.get(parameter))
                    .ok_or_else(|| invalid(format!("公开参数目标不存在：{parameter}")))?;
                validate_registry_constraints(&property, spec)?;
            }
            Content::Image { .. } => validate_media_target(&property, AssetKind::Image)?,
            Content::Video { .. } => validate_media_target(&property, AssetKind::Video)?,
            Content::Composition { .. } | Content::Web { .. } => {}
        }
        properties.push(property);
    }
    Ok(properties)
}

/// Pure value validation used by settings preflight and content evaluation.
/// Values are never coerced, clamped or rounded onto the optional step hint.
pub fn validate_property_value(property: &PropertyDescriptor, value: &Value) -> Result<()> {
    validate_descriptor(property)?;
    validate_value(property, value)
}

/// Validate all overrides and reject unknown IDs, even when no target is active.
pub fn validate_overrides(manifest: &Manifest, overrides: &Map<String, Value>) -> Result<()> {
    let properties = validate_properties(manifest)?;
    validate_override_set(&properties, overrides)
}

/// Resolve defaults and overrides onto a cloned supported content value.
/// Composition/web execution requires their future document/runtime compiler.
pub fn effective_content(manifest: &Manifest, overrides: &Map<String, Value>) -> Result<Content> {
    let properties = validate_properties(manifest)?;
    validate_override_set(&properties, overrides)?;
    if matches!(
        manifest.content,
        Content::Composition { .. } | Content::Web { .. }
    ) {
        return Err(PackageError::new(
            "unsupported_content",
            "此内容尚不支持公开参数运行时求值",
        ));
    }
    let mut content = manifest.content.clone();
    for property in &properties {
        let value = overrides.get(&property.id).unwrap_or(&property.default);
        let parameter = content_target(property)?;
        match &mut content {
            Content::Builtin { params, .. } => {
                params.insert(parameter.to_owned(), value.clone());
            }
            Content::Image { asset } | Content::Video { asset } => {
                *asset = value.as_str().expect("validated asset id").to_owned();
            }
            _ => unreachable!("unsupported content was rejected above"),
        }
    }
    if let Content::Builtin {
        scene_id,
        state_version,
        params,
    } = &mut content
    {
        let schema = builtin_schema(scene_id, *state_version)?;
        validate_builtin_params(schema, params)?;
        for (key, spec) in schema {
            params
                .entry(key.clone())
                .or_insert_with(|| spec["default"].clone());
        }
    }
    Ok(content)
}

/// Construct an author-facing descriptor from one real catalog parameter.
pub fn builtin_property(
    scene_id: &str,
    state_version: u32,
    parameter: &str,
    id: &str,
    label: &str,
    default: Value,
) -> Result<PropertyDescriptor> {
    let schema = builtin_schema(scene_id, state_version)?;
    let spec = schema
        .get(parameter)
        .ok_or_else(|| invalid(format!("公开参数目标不存在：{parameter}")))?;
    let (property_type, constraints) = registry_constraints(spec)?;
    let property = PropertyDescriptor {
        id: id.to_owned(),
        label: label.to_owned(),
        property_type,
        default,
        constraints,
        target: PropertyTarget::Node {
            node_id: "content".into(),
            property: parameter.into(),
            component: None,
        },
    };
    validate_descriptor(&property)?;
    validate_registry_constraints(&property, spec)?;
    Ok(property)
}

fn validate_descriptor(property: &PropertyDescriptor) -> Result<()> {
    if !valid_local_id(&property.id) || !valid_label(&property.label) {
        return Err(invalid(
            "公开参数 id 或 label 无效（label 为 1–120 字符且不含控制字符）",
        ));
    }
    let target_valid = match &property.target {
        PropertyTarget::Node {
            node_id, property, ..
        } => valid_local_id(node_id) && valid_slot(property),
        PropertyTarget::Binding {
            binding_id,
            parameter,
        } => valid_local_id(binding_id) && valid_slot(parameter),
    };
    if !target_valid {
        return Err(invalid(format!("公开参数目标格式无效：{}", property.id)));
    }
    let constraints_valid = match (&property.property_type, &property.constraints) {
        (PropertyType::Number, PropertyConstraints::Number { min, max, step }) => {
            min.is_finite()
                && max.is_finite()
                && min <= max
                && step.is_none_or(|step| step.is_finite() && step > 0.0)
        }
        (PropertyType::Boolean, PropertyConstraints::Boolean)
        | (PropertyType::Color, PropertyConstraints::Color) => true,
        (PropertyType::Select, PropertyConstraints::Select { options }) => {
            !options.is_empty()
                && options.len() <= MAX_PROPERTY_OPTIONS
                && options.iter().enumerate().all(|(index, option)| {
                    valid_label(&option.label)
                        && valid_select_value(&option.value)
                        && options[..index].iter().all(|previous| {
                            previous.label != option.label
                                && !same_value(&previous.value, &option.value)
                        })
                })
        }
        (PropertyType::Text, PropertyConstraints::Text { max_length }) => {
            *max_length <= MAX_TEXT_LENGTH
        }
        (PropertyType::Asset, PropertyConstraints::Asset { options, .. }) => {
            !options.is_empty()
                && options.len() <= MAX_PROPERTY_OPTIONS
                && options
                    .iter()
                    .enumerate()
                    .all(|(index, id)| valid_local_id(id) && !options[..index].contains(id))
        }
        _ => false,
    };
    if !constraints_valid {
        return Err(invalid(format!("公开参数约束无效：{}", property.id)));
    }
    validate_value(property, &property.default).map_err(|error| {
        invalid(format!(
            "公开参数默认值无效：{}（{}）",
            property.id, error.message
        ))
    })?;
    check_encoded_size(property)
}

fn validate_value(property: &PropertyDescriptor, value: &Value) -> Result<()> {
    let valid = match &property.constraints {
        PropertyConstraints::Number { min, max, .. } => value
            .as_f64()
            .is_some_and(|number| number.is_finite() && number >= *min && number <= *max),
        PropertyConstraints::Boolean => value.is_boolean(),
        PropertyConstraints::Select { options } => {
            options.iter().any(|option| &option.value == value)
        }
        PropertyConstraints::Color => valid_color(value),
        PropertyConstraints::Text { max_length } => value
            .as_str()
            .is_some_and(|text| text.encode_utf16().count() <= *max_length as usize),
        PropertyConstraints::Asset { options, .. } => value
            .as_str()
            .is_some_and(|id| options.iter().any(|option| option == id)),
    };
    if valid {
        Ok(())
    } else {
        Err(PackageError::new(
            "invalid_property_value",
            format!("公开参数值类型或范围无效：{}", property.id),
        ))
    }
}

fn validate_override_set(
    properties: &[PropertyDescriptor],
    overrides: &Map<String, Value>,
) -> Result<()> {
    for (id, value) in overrides {
        let property = properties
            .iter()
            .find(|property| &property.id == id)
            .ok_or_else(|| {
                PackageError::new("invalid_property_value", format!("未知公开参数：{id}"))
            })?;
        validate_value(property, value)?;
    }
    Ok(())
}

fn content_target(property: &PropertyDescriptor) -> Result<&str> {
    match &property.target {
        PropertyTarget::Node {
            node_id,
            property,
            component: None,
        } if node_id == "content" => Ok(property),
        _ => Err(invalid(format!(
            "此内容只接受 nodeId=content、component=null 的 node 目标：{}",
            property.id
        ))),
    }
}

fn validate_media_target(property: &PropertyDescriptor, expected: AssetKind) -> Result<()> {
    if content_target(property)? != "asset"
        || !matches!(&property.constraints, PropertyConstraints::Asset { kind, .. } if *kind == expected)
    {
        return Err(invalid(format!(
            "媒体目标必须是同类型的 asset：{}",
            property.id
        )));
    }
    Ok(())
}

fn validate_asset_options(property: &PropertyDescriptor, manifest: &Manifest) -> Result<()> {
    if let PropertyConstraints::Asset { kind, options } = &property.constraints {
        for id in options {
            if !manifest
                .assets
                .iter()
                .any(|asset| asset.id == *id && asset.kind == *kind)
            {
                return Err(invalid(format!(
                    "公开参数引用未声明或类型不兼容的资源：{id}"
                )));
            }
        }
    }
    Ok(())
}

fn builtin_schema(scene_id: &str, version: u32) -> Result<&'static Map<String, Value>> {
    let scene = catalog().scene(scene_id).ok_or_else(|| {
        PackageError::new("invalid_scene_id", format!("内置场景不存在：{scene_id}"))
    })?;
    if scene["stateVersion"].as_u64() != Some(u64::from(version)) {
        return Err(PackageError::new(
            "invalid_manifest",
            "内置场景状态版本不匹配",
        ));
    }
    scene["params"]
        .as_object()
        .ok_or_else(|| PackageError::new("invalid_catalog", "场景参数合同无效"))
}

fn validate_builtin_params(schema: &Map<String, Value>, params: &Map<String, Value>) -> Result<()> {
    if let Some(key) = params.keys().find(|key| !schema.contains_key(*key)) {
        return Err(PackageError::new(
            "invalid_manifest",
            format!("内置场景含未知参数：{key}"),
        ));
    }
    for (key, spec) in schema {
        if !registry_value_valid(spec, params.get(key).unwrap_or(&spec["default"])) {
            return Err(PackageError::new(
                "invalid_manifest",
                format!("内置场景参数值无效：{key}"),
            ));
        }
    }
    Ok(())
}

fn registry_value_valid(spec: &Value, value: &Value) -> bool {
    match spec["type"].as_str() {
        Some("number") => value.as_f64().is_some_and(|value| {
            value.is_finite()
                && spec["min"].as_f64().is_some_and(|min| value >= min)
                && spec["max"].as_f64().is_some_and(|max| value <= max)
        }),
        Some("boolean") => value.is_boolean(),
        Some("select") => spec["options"].as_array().is_some_and(|options| {
            options
                .iter()
                .any(|option| option.get("value").unwrap_or(option) == value)
        }),
        Some("color") => valid_color(value),
        Some("string") => value.as_str().is_some_and(|value| {
            value.encode_utf16().count() as u64 <= spec["maxLength"].as_u64().unwrap_or(256)
        }),
        _ => false,
    }
}

fn registry_constraints(spec: &Value) -> Result<(PropertyType, PropertyConstraints)> {
    let invalid_schema = || invalid("目标 registry 参数不支持公开属性或约束无效");
    Ok(match spec["type"].as_str() {
        Some("number") => (
            PropertyType::Number,
            PropertyConstraints::Number {
                min: spec["min"].as_f64().ok_or_else(invalid_schema)?,
                max: spec["max"].as_f64().ok_or_else(invalid_schema)?,
                step: spec.get("step").and_then(Value::as_f64),
            },
        ),
        Some("boolean") => (PropertyType::Boolean, PropertyConstraints::Boolean),
        Some("select") => {
            let options = spec["options"]
                .as_array()
                .ok_or_else(invalid_schema)?
                .iter()
                .map(|option| {
                    if option.is_object() {
                        serde_json::from_value(option.clone()).map_err(|_| invalid_schema())
                    } else {
                        Ok(SelectOption {
                            value: option.clone(),
                            label: option
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| option.to_string()),
                        })
                    }
                })
                .collect::<Result<Vec<_>>>()?;
            (
                PropertyType::Select,
                PropertyConstraints::Select { options },
            )
        }
        Some("color") => (PropertyType::Color, PropertyConstraints::Color),
        Some("string") => (
            PropertyType::Text,
            PropertyConstraints::Text {
                max_length: spec["maxLength"]
                    .as_u64()
                    .unwrap_or(256)
                    .min(u64::from(MAX_TEXT_LENGTH)) as u32,
            },
        ),
        _ => return Err(invalid_schema()),
    })
}

fn validate_registry_constraints(property: &PropertyDescriptor, spec: &Value) -> Result<()> {
    let valid = match (&property.constraints, spec["type"].as_str()) {
        (PropertyConstraints::Number { min, max, .. }, Some("number")) => {
            spec["min"].as_f64().is_some_and(|lower| *min >= lower)
                && spec["max"].as_f64().is_some_and(|upper| *max <= upper)
        }
        (PropertyConstraints::Boolean, Some("boolean"))
        | (PropertyConstraints::Color, Some("color")) => true,
        (PropertyConstraints::Select { options }, Some("select")) => options
            .iter()
            .all(|option| registry_value_valid(spec, &option.value)),
        (PropertyConstraints::Text { max_length }, Some("string")) => {
            u64::from(*max_length) <= spec["maxLength"].as_u64().unwrap_or(256)
        }
        _ => false,
    };
    if valid && registry_value_valid(spec, &property.default) {
        Ok(())
    } else {
        Err(invalid(format!(
            "公开参数必须缩窄目标 registry 的类型和范围：{}",
            property.id
        )))
    }
}

fn check_encoded_size<T: Serialize>(value: &T) -> Result<()> {
    let encoded = serde_json::to_vec(value)
        .map_err(|error| invalid(format!("公开参数不可序列化：{error}")))?;
    if encoded.len() > MAX_PROPERTY_BYTES {
        Err(invalid("公开参数项超过 2 KiB"))
    } else {
        Ok(())
    }
}

fn valid_label(label: &str) -> bool {
    !label.trim().is_empty() && label.chars().count() <= 120 && !label.chars().any(char::is_control)
}

fn valid_slot(slot: &str) -> bool {
    matches!(slot.as_bytes().first(), Some(first) if first.is_ascii_alphabetic())
        && slot.len() <= 64
        && slot
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn valid_select_value(value: &Value) -> bool {
    value.is_string() || value.is_boolean() || value.as_f64().is_some_and(f64::is_finite)
}

fn same_value(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => {
            left == right || left.as_f64() == right.as_f64()
        }
        _ => left == right,
    }
}

fn valid_color(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        value.len() == 7
            && value.starts_with('#')
            && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
    })
}

fn invalid(message: impl Into<String>) -> PackageError {
    PackageError::new("invalid_property", message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{validate_manifest, validate_manifest_bytes};

    fn manifest(content: Value) -> Manifest {
        serde_json::from_value(json!({
            "formatVersion": 1,
            "workId": "c17ed10a-5c55-4a52-85dc-7509f9e88aae",
            "version": 1,
            "title": "Property fixture",
            "content": content,
            "assets": [
                {"id":"first", "kind":"image", "source":"assets/first.png"},
                {"id":"second", "kind":"image", "source":"assets/second.png"},
                {"id":"movie", "kind":"video", "source":"assets/movie.mp4"}
            ],
            "files": [
                {"path":"assets/first.png", "bytes":70, "sha256":"a".repeat(64), "mime":"image/png"},
                {"path":"assets/second.png", "bytes":70, "sha256":"b".repeat(64), "mime":"image/png"},
                {"path":"assets/movie.mp4", "bytes":70, "sha256":"c".repeat(64), "mime":"video/mp4"}
            ],
            "permissions": {},
            "license": {"code":"none", "assets":"CC0-1.0"}
        })).unwrap()
    }

    fn builtin() -> Manifest {
        manifest(
            json!({"kind":"builtin", "sceneId":"zodiac", "stateVersion":1, "params":{"glow":0.5}}),
        )
    }

    fn descriptor(property_type: &str, default: Value, constraints: Value) -> Value {
        json!({
            "id": "public-value", "label": "Public value", "type": property_type,
            "default": default, "constraints": constraints,
            "target": {"kind":"node", "nodeId":"content", "property":"glow", "component":null}
        })
    }

    fn parse(value: &Value) -> Result<PropertyDescriptor> {
        parse_property(value.as_object().unwrap())
    }

    fn glow() -> PropertyDescriptor {
        builtin_property("zodiac", 1, "glow", "public-glow", "Glow", json!(1.25)).unwrap()
    }

    #[test]
    fn all_six_types_keep_exact_values_and_round_trip() {
        for (value, accepted, rejected) in [
            (
                descriptor("number", json!(0.2), json!({"min":0, "max":1, "step":0.1})),
                json!(0.37),
                json!("0.37"),
            ),
            (
                descriptor("boolean", json!(true), json!({})),
                json!(false),
                json!(1),
            ),
            (
                descriptor(
                    "select",
                    json!(1),
                    json!({"options":[{"value":1,"label":"Numeric"},{"value":"1","label":"String"},{"value":false,"label":"Boolean"}]}),
                ),
                json!("1"),
                json!(true),
            ),
            (
                descriptor("color", json!("#12aBcF"), json!({})),
                json!("#FFFFFF"),
                json!("rgb(255,255,255)"),
            ),
            (
                descriptor("text", json!("🙂"), json!({"maxLength":2})),
                json!("ab"),
                json!("🙂a"),
            ),
            (
                descriptor(
                    "asset",
                    json!("first"),
                    json!({"kind":"image","options":["first","second"]}),
                ),
                json!("second"),
                json!("https://host/second.png"),
            ),
        ] {
            let property = parse(&value).unwrap();
            validate_property_value(&property, &accepted).unwrap();
            assert_eq!(
                validate_property_value(&property, &rejected)
                    .unwrap_err()
                    .code,
                "invalid_property_value"
            );
            let round_trip: PropertyDescriptor =
                serde_json::from_value(serde_json::to_value(&property).unwrap()).unwrap();
            assert_eq!(round_trip, property);
        }
    }

    #[test]
    fn strict_shape_rejects_unknown_missing_and_wrong_fields() {
        let base = descriptor("number", json!(1), json!({"min":0,"max":2}));
        let mut cases = vec![];
        for key in ["id", "label", "type", "default", "constraints", "target"] {
            let mut value = base.clone();
            value.as_object_mut().unwrap().remove(key);
            cases.push(value);
        }
        let mut value = base.clone();
        value["unknown"] = json!(true);
        cases.push(value);
        let mut value = base.clone();
        value["type"] = json!("string");
        cases.push(value);
        let mut value = base.clone();
        value["constraints"]["unknown"] = json!(true);
        cases.push(value);
        let mut value = base.clone();
        value["constraints"]["step"] = Value::Null;
        cases.push(value);
        let mut value = base.clone();
        value["target"]["extra"] = json!(true);
        cases.push(value);
        let mut value = base.clone();
        value["target"].as_object_mut().unwrap().remove("component");
        cases.push(value);
        for component in [json!("x"), json!(-1), json!(0.5)] {
            let mut value = base.clone();
            value["target"]["component"] = component;
            cases.push(value);
        }
        cases.push(descriptor("boolean", json!(true), json!([])));
        cases.push(descriptor(
            "select",
            json!("a"),
            json!({"options":[["a","A"]]}),
        ));
        for value in cases {
            assert_eq!(
                parse(&value).unwrap_err().code,
                "invalid_property",
                "{value}"
            );
        }
        assert!(serde_json::from_value::<PropertyDescriptor>(json!([
            "public-value", "Public value", "number", 1, {"min":0,"max":2},
            {"kind":"node","nodeId":"content","property":"glow","component":null}
        ]))
        .is_err());
    }

    #[test]
    fn bounds_defaults_and_labels_are_rejected_without_clamping() {
        for (default, constraints) in [
            (json!(1), json!({"min":2,"max":0})),
            (json!(3), json!({"min":0,"max":2})),
            (json!(1), json!({"min":0,"max":2,"step":0})),
            (json!(1), json!({"min":0,"max":2,"step":-0.1})),
            (json!("1"), json!({"min":0,"max":2})),
        ] {
            assert!(parse(&descriptor("number", default, constraints)).is_err());
        }
        // Native values need not lie on the editor's step grid.
        parse(&descriptor(
            "number",
            json!(0.37),
            json!({"min":0,"max":1,"step":0.1}),
        ))
        .unwrap();
        parse(&descriptor("number", json!(1), json!({"min":1,"max":1}))).unwrap();
        for label in [
            "".to_string(),
            " ".into(),
            "a".repeat(121),
            "Bad\nlabel".into(),
        ] {
            let mut value = descriptor("boolean", json!(true), json!({}));
            value["label"] = label.into();
            assert!(parse(&value).is_err());
        }
        let mut value = glow();
        value.constraints = PropertyConstraints::Number {
            min: f64::NEG_INFINITY,
            max: 2.0,
            step: None,
        };
        assert!(value.to_map().is_err());
        assert!(parse(&descriptor("text", json!(""), json!({"maxLength":4097}))).is_err());
        assert!(parse(&descriptor("text", json!("🙂"), json!({"maxLength":1}))).is_err());
        parse(&descriptor("text", json!(""), json!({"maxLength":0}))).unwrap();
        assert!(parse(&descriptor("color", json!("#FFF"), json!({}))).is_err());
    }

    #[test]
    fn select_options_are_bounded_distinct_labeled_primitives() {
        for options in [
            json!([]),
            json!([{"value":null,"label":"Null"}]),
            json!([{"value":{},"label":"Object"}]),
            json!([{"value":"a","label":""}]),
            json!([{"value":"a","label":"A","extra":1}]),
            json!([{"value":"a","label":"A"},{"value":"a","label":"B"}]),
            json!([{"value":"a","label":"A"},{"value":"b","label":"A"}]),
            json!([{"value":1,"label":"One"},{"value":1.0,"label":"Also one"}]),
            json!((0..65)
                .map(|n| json!({"value":n,"label":n.to_string()}))
                .collect::<Vec<_>>()),
        ] {
            assert!(parse(&descriptor(
                "select",
                json!("a"),
                json!({"options":options})
            ))
            .is_err());
        }
        assert!(parse(&descriptor(
            "select",
            json!("b"),
            json!({"options":[{"value":"a","label":"A"}]})
        ))
        .is_err());
    }

    #[test]
    fn duplicate_ids_targets_and_encoded_set_limits_are_rejected() {
        let mut manifest = builtin();
        let first = glow();
        manifest.properties = vec![first.to_map().unwrap(), first.to_map().unwrap()];
        assert!(validate_properties(&manifest)
            .unwrap_err()
            .message
            .contains("id 重复"));
        let mut second = first.clone();
        second.id = "another-id".into();
        manifest.properties[1] = second.to_map().unwrap();
        assert!(validate_properties(&manifest)
            .unwrap_err()
            .message
            .contains("target 重复"));
        manifest.properties = vec![first.to_map().unwrap(); 65];
        assert_eq!(
            validate_properties(&manifest).unwrap_err().code,
            "too_many_properties"
        );

        let oversized = descriptor("text", json!("x".repeat(2048)), json!({"maxLength":4096}));
        assert_eq!(parse(&oversized).unwrap_err().code, "invalid_property");
        let mut boundary = descriptor("text", json!(""), json!({"maxLength":4096}));
        let overhead = serde_json::to_vec(&boundary).unwrap().len();
        boundary["default"] = json!("x".repeat(MAX_PROPERTY_BYTES - overhead));
        assert_eq!(
            serde_json::to_vec(&boundary).unwrap().len(),
            MAX_PROPERTY_BYTES
        );
        parse(&boundary).unwrap();
        boundary["default"] = json!("x".repeat(MAX_PROPERTY_BYTES - overhead + 1));
        assert!(parse(&boundary).is_err());
    }

    #[test]
    fn registry_targets_must_exist_match_type_and_only_narrow_domain() {
        let mut manifest = builtin();
        let mut property = glow();
        property.constraints = PropertyConstraints::Number {
            min: 1.0,
            max: 1.5,
            step: Some(0.1),
        };
        manifest.properties = vec![property.to_map().unwrap()];
        validate_properties(&manifest).unwrap();
        property.constraints = PropertyConstraints::Number {
            min: -1.0,
            max: 1.5,
            step: None,
        };
        manifest.properties = vec![property.to_map().unwrap()];
        assert_eq!(
            validate_properties(&manifest).unwrap_err().code,
            "invalid_property"
        );

        for target in [
            json!({"kind":"node","nodeId":"missing","property":"glow","component":null}),
            json!({"kind":"node","nodeId":"content","property":"invented","component":null}),
            json!({"kind":"node","nodeId":"content","property":"glow","component":0}),
            json!({"kind":"binding","bindingId":"pulse","parameter":"gain"}),
        ] {
            let mut value = serde_json::to_value(glow()).unwrap();
            value["target"] = target;
            manifest.properties = vec![value.as_object().unwrap().clone()];
            assert_eq!(
                validate_properties(&manifest).unwrap_err().code,
                "invalid_property"
            );
        }
        let mut value = descriptor("boolean", json!(true), json!({}));
        manifest.properties = vec![value.as_object().unwrap().clone()];
        assert!(validate_properties(&manifest).is_err());
        value = descriptor(
            "select",
            json!("aries"),
            json!({"options":[{"value":"aries","label":"Aries"}]}),
        );
        value["target"]["property"] = json!("sign");
        manifest.properties = vec![value.as_object().unwrap().clone()];
        validate_properties(&manifest).unwrap();
        value["constraints"]["options"][0]["value"] = json!("invalid-sign");
        value["default"] = json!("invalid-sign");
        manifest.properties = vec![value.as_object().unwrap().clone()];
        assert!(validate_properties(&manifest).is_err());
        // Public IDs use kebab-case while real registry slots retain camelCase.
        builtin_property(
            "zodiac",
            1,
            "pointerStrength",
            "pointer-strength",
            "Pointer",
            json!(0.8),
        )
        .unwrap();
        assert!(builtin_property(
            "zodiac",
            1,
            "pointerStrength",
            "pointerStrength",
            "Pointer",
            json!(0.8)
        )
        .is_err());
    }

    #[test]
    fn catalog_and_version_are_validated_before_property_crosschecks() {
        let mut manifest = builtin();
        manifest.properties = vec![json!({"id":"broken"}).as_object().unwrap().clone()];
        if let Content::Builtin { scene_id, .. } = &mut manifest.content {
            *scene_id = "missing-scene".into();
        }
        assert_eq!(
            validate_properties(&manifest).unwrap_err().code,
            "invalid_scene_id"
        );
        manifest = builtin();
        if let Content::Builtin { state_version, .. } = &mut manifest.content {
            *state_version = 999;
        }
        assert_eq!(
            validate_properties(&manifest).unwrap_err().code,
            "invalid_manifest"
        );
        manifest = builtin();
        if let Content::Builtin { params, .. } = &mut manifest.content {
            params.insert("glow".into(), json!(3));
        }
        assert_eq!(
            validate_manifest(&manifest).unwrap_err().code,
            "invalid_manifest"
        );
    }

    #[test]
    fn registry_color_text_and_numeric_select_constraints_remain_typed() {
        let color = parse(&descriptor("color", json!("#abcdef"), json!({}))).unwrap();
        validate_registry_constraints(&color, &json!({"type":"color"})).unwrap();
        assert!(validate_registry_constraints(&color, &json!({"type":"string"})).is_err());
        let text = parse(&descriptor("text", json!("🙂"), json!({"maxLength":2}))).unwrap();
        validate_registry_constraints(&text, &json!({"type":"string","maxLength":2})).unwrap();
        assert!(
            validate_registry_constraints(&text, &json!({"type":"string","maxLength":1})).is_err()
        );
        let select = parse(&descriptor(
            "select",
            json!(1),
            json!({"options":[{"value":1,"label":"One"}]}),
        ))
        .unwrap();
        assert!(validate_property_value(&select, &json!(1.0)).is_err());
        validate_registry_constraints(
            &select,
            &json!({"type":"select","options":[{"value":1,"label":"One"},2]}),
        )
        .unwrap();
        assert!(
            validate_registry_constraints(&select, &json!({"type":"select","options":["1"]}))
                .is_err()
        );
        assert!(
            validate_registry_constraints(&select, &json!({"type":"select","options":[1.0]}))
                .is_err()
        );
        let (kind, constraints) =
            registry_constraints(&json!({"type":"string","maxLength":20})).unwrap();
        assert_eq!(kind, PropertyType::Text);
        assert_eq!(constraints, PropertyConstraints::Text { max_length: 20 });
    }

    #[test]
    fn media_assets_must_be_declared_same_kind_and_the_only_media_slot() {
        let mut manifest = manifest(json!({"kind":"image","asset":"first"}));
        let mut value = descriptor(
            "asset",
            json!("second"),
            json!({"kind":"image","options":["first","second"]}),
        );
        value["target"]["property"] = json!("asset");
        manifest.properties = vec![value.as_object().unwrap().clone()];
        validate_manifest(&manifest).unwrap();
        let original = serde_json::to_value(&manifest).unwrap();
        assert!(
            matches!(effective_content(&manifest, &Map::new()).unwrap(), Content::Image { asset } if asset == "second")
        );
        assert!(
            matches!(effective_content(&manifest, json!({"public-value":"first"}).as_object().unwrap()).unwrap(), Content::Image { asset } if asset == "first")
        );
        assert_eq!(serde_json::to_value(&manifest).unwrap(), original);
        for (kind, options, default) in [
            ("image", json!(["movie"]), "movie"),
            ("video", json!(["movie"]), "movie"),
            ("image", json!(["missing"]), "missing"),
            (
                "image",
                json!(["https://host/image.png"]),
                "https://host/image.png",
            ),
            ("image", json!(["../first"]), "../first"),
        ] {
            let mut invalid = value.clone();
            invalid["constraints"] = json!({"kind":kind,"options":options});
            invalid["default"] = json!(default);
            manifest.properties = vec![invalid.as_object().unwrap().clone()];
            assert!(validate_properties(&manifest).is_err());
        }
        value["target"]["property"] = json!("fit");
        manifest.properties = vec![value.as_object().unwrap().clone()];
        assert!(validate_properties(&manifest).is_err());
        manifest.content = Content::Video {
            asset: "movie".into(),
        };
        value["target"]["property"] = json!("asset");
        value["default"] = json!("movie");
        value["constraints"] = json!({"kind":"video","options":["movie"]});
        manifest.properties = vec![value.as_object().unwrap().clone()];
        assert!(
            matches!(effective_content(&manifest, &Map::new()).unwrap(), Content::Video { asset } if asset == "movie")
        );
    }

    #[test]
    fn effective_content_uses_defaults_then_overrides_and_keeps_manifest_immutable() {
        let mut manifest = builtin();
        manifest.properties = vec![glow().to_map().unwrap()];
        let before = serde_json::to_vec(&manifest).unwrap();
        let Content::Builtin { params, .. } = effective_content(&manifest, &Map::new()).unwrap()
        else {
            panic!()
        };
        assert_eq!(params["glow"], json!(1.25));
        assert_eq!(params["sign"], json!("cycle"));
        let overrides = json!({"public-glow":0.75});
        validate_overrides(&manifest, overrides.as_object().unwrap()).unwrap();
        let Content::Builtin { params, .. } =
            effective_content(&manifest, overrides.as_object().unwrap()).unwrap()
        else {
            panic!()
        };
        assert_eq!(params["glow"], json!(0.75));
        for overrides in [
            json!({"unknown":1}),
            json!({"public-glow":3}),
            json!({"public-glow":"1"}),
        ] {
            assert_eq!(
                effective_content(&manifest, overrides.as_object().unwrap())
                    .unwrap_err()
                    .code,
                "invalid_property_value"
            );
        }
        assert_eq!(serde_json::to_vec(&manifest).unwrap(), before);
        validate_manifest_bytes(&before).unwrap();
    }

    #[test]
    fn composition_and_web_accept_structure_without_claiming_execution() {
        for content in [
            json!({"kind":"composition","document":"content/scene.json"}),
            json!({"kind":"web","entry":"content/index.html","apiVersion":1}),
        ] {
            let mut manifest = manifest(content);
            manifest.files.push(crate::FileEntry {
                path: manifest.content_file().unwrap().to_owned(),
                bytes: 70,
                sha256: "d".repeat(64),
                mime: if matches!(manifest.content, Content::Composition { .. }) {
                    "application/json".to_owned()
                } else {
                    "text/html".to_owned()
                },
            });
            let mut value = descriptor("number", json!(1), json!({"min":0,"max":2}));
            value["target"] = json!({"kind":"binding","bindingId":"pulse","parameter":"gain"});
            manifest.properties = vec![value.as_object().unwrap().clone()];
            validate_manifest(&manifest).unwrap();
            assert_eq!(
                effective_content(&manifest, &Map::new()).unwrap_err().code,
                "unsupported_content"
            );
            value["target"]["invented"] = json!(true);
            manifest.properties = vec![value.as_object().unwrap().clone()];
            assert_eq!(
                validate_manifest(&manifest).unwrap_err().code,
                "invalid_property"
            );
        }
    }
}
