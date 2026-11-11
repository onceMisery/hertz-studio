// SPDX-License-Identifier: MIT
//! Pure composition semantics. No file/GPU handles, platform API or scheduler.
//! Author data is accepted here once; renderers consume the resulting fixed IR.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::{Manifest, PackageError, Result};

mod cache;
pub mod catalog;
mod compile;
pub use cache::{FinalPublicValues, ResolvedAssetIdentity, SemanticCache, TargetIdentity};
pub use compile::{
    CompiledBinding, CompiledDocument, CompiledTrack, ConstantSlot, DirtyDependency, Instruction,
    NodeDirty, NodeIr, NumericSlot, PublicProperty, PublicTarget, ResourceUse, SemanticIr,
    StaticRequirement,
};

pub const MAX_DOCUMENT_BYTES: usize = 1024 * 1024;
pub const MAX_DOCUMENT_DEPTH: usize = 16;
pub const MAX_NODES: usize = 128;
pub const MAX_PARENT_DEPTH: usize = 8;
pub const MAX_EFFECTS: usize = 64;
pub const MAX_EFFECTS_PER_TARGET: usize = 8;
pub const MAX_TRACKS: usize = 256;
pub const MAX_KEYS: usize = 4096;
pub const MAX_BINDINGS: usize = 64;
pub const MAX_OPERATIONS: usize = 32;
pub const MAX_STACK: usize = 8;
pub const COMPILER_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Document {
    pub document_version: u32,
    pub canvas: Canvas,
    pub nodes: Vec<Node>,
    pub timeline: Timeline,
    pub bindings: Vec<Binding>,
    #[serde(default)]
    pub effects: Vec<Effect>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Canvas {
    pub width: u32,
    pub height: u32,
    pub color_space: String,
    pub background: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene3d: Option<Camera>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Camera {
    pub position: [f64; 3],
    pub target: [f64; 3],
    pub fov_degrees: f64,
    pub near: f64,
    pub far: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub state_version: u32,
    #[serde(default)]
    pub children: Vec<String>,
    #[serde(default)]
    pub assets: BTreeMap<String, String>,
    #[serde(
        default,
        deserialize_with = "crate::json::deserialize_literal_btree_map"
    )]
    pub properties: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Effect {
    pub id: String,
    #[serde(rename = "type")]
    pub effect_type: String,
    pub state_version: u32,
    pub target: EffectTarget,
    #[serde(default)]
    pub assets: BTreeMap<String, String>,
    #[serde(
        default,
        deserialize_with = "crate::json::deserialize_literal_btree_map"
    )]
    pub properties: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum EffectTarget {
    Node { node_id: String },
    Output,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Timeline {
    pub duration_seconds: f64,
    pub r#loop: bool,
    pub tracks: Vec<Track>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Track {
    pub id: String,
    pub target: NodeTarget,
    pub keys: Vec<Key>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NodeTarget {
    pub node_id: String,
    pub property: String,
    #[serde(deserialize_with = "required_component")]
    pub component: Option<u32>,
}

fn required_component<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<u32>, D::Error> {
    Option::<u32>::deserialize(deserializer)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Key {
    pub time_seconds: f64,
    pub value: f64,
    pub easing: Easing,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Easing {
    Linear,
    EaseInOut,
    Step,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub id: String,
    pub target: NodeTarget,
    pub mode: BindingMode,
    pub parameters: BTreeMap<String, f64>,
    pub program: Vec<Operation>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BindingMode {
    Add,
    Multiply,
    Replace,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Operation {
    Input {
        name: String,
    },
    Parameter {
        name: String,
    },
    Const {
        value: f64,
    },
    Add,
    Mul,
    Sin,
    Cos,
    Abs,
    Clamp {
        min: f64,
        max: f64,
    },
    Map {
        input_min: f64,
        input_max: f64,
        output_min: f64,
        output_max: f64,
    },
    Smoothstep {
        edge0: f64,
        edge1: f64,
    },
}

/// Accepts validated package metadata, never an arbitrary external path.
/// Rechecks manifest constraints so direct callers cannot bypass package rules.
pub fn compile_document(bytes: &[u8], manifest: &Manifest) -> Result<CompiledDocument> {
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(PackageError::new(
            "document_too_large",
            "组合文档超过 1 MiB",
        ));
    }
    crate::json::check_bounded_json(bytes, MAX_DOCUMENT_DEPTH)?;
    crate::manifest::validate_manifest(manifest)?;
    if !matches!(manifest.content, crate::Content::Composition { .. }) {
        return Err(invalid("组合编译要求 composition 包元数据"));
    }
    let document: Document = serde_json::from_slice(bytes)
        .map_err(|error| invalid(format!("组合文档结构无效：{error}")))?;
    compile::compile(document, manifest)
}

fn invalid(message: impl Into<String>) -> PackageError {
    PackageError::new("invalid_composition", message)
}
