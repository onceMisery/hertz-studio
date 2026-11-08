// SPDX-License-Identifier: MIT
//! The exact pure declaration segment is hashed once, like the scene catalog.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{AssetKind, PackageError, Result};

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Field {
    #[serde(rename = "type")]
    pub field_type: String,
    #[serde(default)]
    pub default: Option<Value>,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default)]
    pub integer: bool,
    #[serde(default)]
    pub animatable: bool,
    #[serde(default = "default_public")]
    pub public: bool,
    #[serde(default)]
    pub affects: Vec<String>,
    #[serde(default)]
    pub length: Option<usize>,
    #[serde(default)]
    pub max_length: Option<usize>,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub space: Option<String>,
    #[serde(default)]
    pub alternatives: BTreeMap<String, Field>,
}

fn default_public() -> bool {
    true
}

impl Field {
    pub(super) fn in_space(&self, space: &str) -> Option<&Self> {
        if let Some(alternative) = self.alternatives.get(space) {
            return Some(alternative);
        }
        if self
            .space
            .as_deref()
            .is_some_and(|required| required != space)
        {
            None
        } else {
            Some(self)
        }
    }

    pub(super) fn validate(&self, value: &Value) -> bool {
        let numeric = |number: f64| {
            number.is_finite()
                && self.min.is_some_and(|min| number >= min)
                && self.max.is_some_and(|max| number <= max)
                && (!self.integer || number.fract() == 0.0)
        };
        match self.field_type.as_str() {
            "number" => value.as_f64().is_some_and(numeric),
            "vector" => value.as_array().is_some_and(|array| {
                Some(array.len()) == self.length
                    && array.iter().all(|part| part.as_f64().is_some_and(numeric))
            }),
            "boolean" => value.is_boolean(),
            "select" => value
                .as_str()
                .is_some_and(|text| self.options.iter().any(|option| option == text)),
            "text" => value.as_str().is_some_and(|text| {
                self.max_length
                    .is_some_and(|max| text.encode_utf16().count() <= max)
            }),
            "color" => value.as_str().is_some_and(valid_color),
            "sceneId" => value.as_str().is_some_and(crate::valid_local_id),
            "sceneParams" => value.is_object(),
            _ => false,
        }
    }
}

pub(super) fn valid_color(color: &str) -> bool {
    (color.len() == 7 || color.len() == 9)
        && color.starts_with('#')
        && color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssetField {
    pub kinds: Vec<AssetKind>,
    pub required: bool,
    pub usage: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NodeSchema {
    #[serde(rename = "type")]
    pub node_type: String,
    pub state_version: u32,
    pub space: String,
    pub properties: BTreeMap<String, Field>,
    pub assets: BTreeMap<String, AssetField>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EffectSchema {
    #[serde(rename = "type")]
    pub effect_type: String,
    pub state_version: u32,
    pub targets: Vec<String>,
    pub properties: BTreeMap<String, Field>,
    pub assets: BTreeMap<String, AssetField>,
    pub input_textures: u32,
    pub output_format: String,
    pub sample_scale: f64,
    pub history: bool,
    pub quality: BTreeMap<String, QualityVariant>,
    pub cost: BTreeMap<String, EffectCost>,
}

#[derive(Debug, Clone, serde::Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct QualityVariant {
    pub sample_scale: f64,
}

#[derive(Debug, Clone, serde::Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EffectCost {
    pub surfaces: u32,
    pub draw_passes: u32,
    pub bytes_per_pixel: u32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Definitions {
    pub nodes: Vec<NodeSchema>,
    pub effects: Vec<EffectSchema>,
    pub inputs: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ContractFile {
    schema_version: u32,
    registry_hash: String,
    definitions: Definitions,
}

pub struct Contract {
    pub registry_hash: String,
    pub definitions: Definitions,
}

pub fn composition_catalog() -> &'static Contract {
    static CATALOG: OnceLock<Contract> = OnceLock::new();
    CATALOG.get_or_init(|| {
        parse_catalog(include_bytes!("../../contracts/composition.json"))
            .expect("composition metadata must match its published declaration hash")
    })
}

pub fn parse_catalog(bytes: &[u8]) -> Result<Contract> {
    crate::json::check_bounded_json(bytes, 16)?;
    let file: ContractFile = serde_json::from_slice(bytes)
        .map_err(|error| PackageError::new("invalid_composition_catalog", error.to_string()))?;
    let range = crate::json::top_level_raw_value(bytes, "definitions")
        .ok_or_else(|| PackageError::new("invalid_composition_catalog", "definitions missing"))?;
    let digest = format!("{:x}", Sha256::digest(&bytes[range]));
    if file.schema_version != 1
        || !crate::valid_sha256_hex(&file.registry_hash)
        || digest != file.registry_hash
    {
        return Err(PackageError::new(
            "composition_catalog_mismatch",
            "组合目录版本或声明哈希不符",
        ));
    }
    for node in &file.definitions.nodes {
        for field in node.properties.values() {
            check_field(field)?;
        }
    }
    for effect in &file.definitions.effects {
        if effect.input_textures == 0
            || effect.input_textures > 2
            || effect.output_format != "rgba8"
            || effect.history
            || !(0.0..=1.0).contains(&effect.sample_scale)
            || effect.sample_scale == 0.0
            || effect.quality.len() != 3
            || ["low", "medium", "high"]
                .iter()
                .any(|name| !effect.quality.contains_key(*name))
            || effect.quality.values().any(|quality| {
                !quality.sample_scale.is_finite()
                    || quality.sample_scale <= 0.0
                    || quality.sample_scale > 1.0
            })
            || effect
                .cost
                .values()
                .any(|cost| cost.surfaces > 2 || cost.draw_passes > 3 || cost.bytes_per_pixel != 4)
        {
            return Err(PackageError::new(
                "invalid_composition_catalog",
                "效果静态规划声明无效",
            ));
        }
        for field in effect.properties.values() {
            check_field(field)?;
        }
    }
    Ok(Contract {
        registry_hash: file.registry_hash,
        definitions: file.definitions,
    })
}

fn check_field(field: &Field) -> Result<()> {
    if field.affects.iter().any(|role| {
        ![
            "matrix",
            "layout",
            "material",
            "visibility",
            "resource",
            "geometry",
            "descendants",
        ]
        .contains(&role.as_str())
    }) {
        return Err(PackageError::new(
            "invalid_composition_catalog",
            "字段脏角色不在发布白名单",
        ));
    }
    if matches!(field.field_type.as_str(), "number" | "vector")
        && !(field
            .min
            .zip(field.max)
            .is_some_and(|(min, max)| min.is_finite() && max.is_finite() && min <= max))
    {
        return Err(PackageError::new(
            "invalid_composition_catalog",
            "数值字段必须声明有限范围",
        ));
    }
    if let Some(default) = &field.default {
        if !field.validate(default) {
            return Err(PackageError::new(
                "invalid_composition_catalog",
                "声明默认值不满足字段范围",
            ));
        }
    }
    for alternative in field.alternatives.values() {
        check_field(alternative)?;
    }
    Ok(())
}
