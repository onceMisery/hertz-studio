// SPDX-License-Identifier: MIT
use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::catalog::{composition_catalog, AssetField, Field};
use super::*;
use crate::properties::{PropertyConstraints, PropertyDescriptor, PropertyTarget, PropertyType};
use crate::Content;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NumericSlot {
    pub node_index: usize,
    pub property: String,
    pub component: Option<u32>,
    pub value: f64,
    pub min: f64,
    pub max: f64,
    pub animatable: bool,
    pub integer: bool,
    pub builtin_parameter: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstantSlot {
    pub node_index: usize,
    pub property: String,
    pub value: Value,
    pub builtin_parameter: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeIr {
    pub id: String,
    pub node_type: String,
    pub parent_index: i32,
    pub matrix_offset: usize,
    pub dirty_mask_offset: usize,
    pub property_slots: BTreeMap<String, Vec<usize>>,
    pub constant_slots: BTreeMap<String, usize>,
    pub assets: BTreeMap<String, String>,
    pub space: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceUse {
    pub asset_id: String,
    pub node_index: Option<usize>,
    pub effect_index: Option<usize>,
    pub field: String,
    /// The planner must resolve actual content dimensions/dependencies.
    pub usage: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StaticRequirement {
    /// Real target pixels/format are supplied by TargetPlanner, not canvas.
    OutputPixels,
    NodeDraw {
        node_index: usize,
    },
    ParticleInstances {
        node_index: usize,
        count_slot: usize,
    },
    TextLayout {
        node_index: usize,
        /// Evaluate this final value after declared public overrides.
        constant_slot: usize,
        max_utf16_units: usize,
    },
    ResolvedGeometry {
        node_index: usize,
    },
    EffectSurfaces {
        effect_index: usize,
        count: u32,
        input_textures: u32,
        output_format: String,
        sample_scale: f64,
        quality: BTreeMap<String, super::catalog::QualityVariant>,
        cost: super::catalog::EffectCost,
    },
}

pub const DIRTY_MATRIX: u32 = 1;
pub const DIRTY_LAYOUT: u32 = 2;
pub const DIRTY_MATERIAL: u32 = 4;
pub const DIRTY_VISIBILITY: u32 = 8;
pub const DIRTY_RESOURCE: u32 = 16;
pub const DIRTY_GEOMETRY: u32 = 32;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeDirty {
    pub node_index: usize,
    pub mask: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct DirtyDependency {
    pub nodes: Vec<NodeDirty>,
    pub effects: Vec<usize>,
    pub output: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledTrack {
    pub target_slot: usize,
    pub keys: Vec<Key>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Instruction {
    pub opcode: u8,
    pub index: usize,
    pub operands: [f64; 4],
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledBinding {
    pub id: String,
    pub target_slot: usize,
    pub mode: BindingMode,
    pub parameters: Vec<(String, f64)>,
    pub program: Vec<Instruction>,
    pub max_stack: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PublicTarget {
    Numeric {
        slot: usize,
    },
    Constant {
        slot: usize,
    },
    Asset {
        node_index: usize,
        field: String,
    },
    BindingParameter {
        binding_index: usize,
        parameter_index: usize,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicProperty {
    pub descriptor: PropertyDescriptor,
    pub target: PublicTarget,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticIr {
    compiler_version: u32,
    document_hash: String,
    registry_hash: String,
    scene_registry_hash: String,
    public_properties_hash: String,
    semantic_key: String,
    nodes: Vec<NodeIr>,
    numeric_slots: Vec<NumericSlot>,
    constant_slots: Vec<ConstantSlot>,
    painter_order: Vec<usize>,
    planar_order: Vec<usize>,
    spatial_order: Vec<usize>,
    /// Per-node fixed matrix descendants; same values need not be invalidated.
    matrix_dependents: Vec<Vec<usize>>,
    /// Resource changes dirty these users and the shared target output.
    resource_uses: Vec<ResourceUse>,
    static_requirements: Vec<StaticRequirement>,
    slot_dependencies: Vec<DirtyDependency>,
    constant_dependencies: Vec<BTreeMap<String, DirtyDependency>>,
    resource_dependencies: Vec<DirtyDependency>,
    effect_dependencies: Vec<DirtyDependency>,
    effect_targets: Vec<Option<usize>>,
    effects: Vec<Effect>,
    effect_surfaces: Vec<u32>,
    tracks: Vec<CompiledTrack>,
    bindings: Vec<CompiledBinding>,
    public_properties: Vec<PublicProperty>,
    inputs: Vec<String>,
}

impl SemanticIr {
    pub fn nodes(&self) -> &[NodeIr] {
        &self.nodes
    }
    pub fn numeric_slots(&self) -> &[NumericSlot] {
        &self.numeric_slots
    }
    pub fn constant_slots(&self) -> &[ConstantSlot] {
        &self.constant_slots
    }
    pub fn painter_order(&self) -> &[usize] {
        &self.painter_order
    }
    pub fn matrix_dependents(&self) -> &[Vec<usize>] {
        &self.matrix_dependents
    }
    pub fn resource_uses(&self) -> &[ResourceUse] {
        &self.resource_uses
    }
    pub fn static_requirements(&self) -> &[StaticRequirement] {
        &self.static_requirements
    }
    pub fn slot_dependencies(&self) -> &[DirtyDependency] {
        &self.slot_dependencies
    }
    pub fn constant_dependencies(&self) -> &[BTreeMap<String, DirtyDependency>] {
        &self.constant_dependencies
    }
    pub fn tracks(&self) -> &[CompiledTrack] {
        &self.tracks
    }
    pub fn bindings(&self) -> &[CompiledBinding] {
        &self.bindings
    }
    pub fn public_properties(&self) -> &[PublicProperty] {
        &self.public_properties
    }
    pub fn semantic_key(&self) -> &str {
        &self.semantic_key
    }
    pub fn document_hash(&self) -> &str {
        &self.document_hash
    }
}

#[derive(Debug, Clone)]
pub struct CompiledDocument {
    document: Document,
    ir: SemanticIr,
    normalized_bytes: Vec<u8>,
}

impl CompiledDocument {
    pub fn document(&self) -> &Document {
        &self.document
    }
    pub fn ir(&self) -> &SemanticIr {
        &self.ir
    }
    pub fn normalized_bytes(&self) -> &[u8] {
        &self.normalized_bytes
    }
}

pub(super) fn compile(mut document: Document, manifest: &Manifest) -> Result<CompiledDocument> {
    if document.document_version != 1 {
        return Err(PackageError::new(
            "unsupported_document_version",
            "组合 documentVersion 只接受 1",
        ));
    }
    if document.nodes.len() > MAX_NODES
        || document.effects.len() > MAX_EFFECTS
        || document.timeline.tracks.len() > MAX_TRACKS
        || document.bindings.len() > MAX_BINDINGS
    {
        return Err(invalid("组合节点、效果、轨道或绑定超过工程上限"));
    }
    validate_canvas(&mut document.canvas)?;
    let contract = composition_catalog();
    let definitions = &contract.definitions;
    let mut ids = BTreeMap::new();
    let mut spaces = Vec::with_capacity(document.nodes.len());
    let mut resources = Vec::new();
    let mut nodes = Vec::new();
    let mut slots = Vec::new();
    let mut constants = Vec::new();
    let mut builtin_count = 0;
    let mut model_count = 0;
    for (index, node) in document.nodes.iter_mut().enumerate() {
        check_id(&node.id)?;
        if ids.insert(node.id.clone(), index).is_some() {
            return Err(invalid("节点 id 重复"));
        }
        let schema = definitions
            .nodes
            .iter()
            .find(|schema| schema.node_type == node.node_type)
            .ok_or_else(|| invalid(format!("未知节点类型：{}", node.node_type)))?;
        if node.state_version != schema.state_version {
            return Err(invalid(format!("节点 {} 的 stateVersion 不支持", node.id)));
        }
        if node.node_type != "group" && !node.children.is_empty() {
            return Err(invalid("仅 group 可拥有 children"));
        }
        let space = if schema.space == "dynamic" {
            node.properties
                .get("space")
                .and_then(Value::as_str)
                .unwrap_or("2d")
                .to_owned()
        } else {
            schema.space.clone()
        };
        if space != "2d" && space != "3d" {
            return Err(invalid("group space 只接受 2d/3d"));
        }
        normalize_properties(&mut node.properties, &schema.properties, &space)?;
        validate_assets(
            &node.assets,
            &schema.assets,
            manifest,
            Some(index),
            None,
            &mut resources,
        )?;
        if node.node_type == "video" {
            validate_video_loop_range(
                node.properties["loopStartMs"]
                    .as_f64()
                    .expect("normalized video loop start"),
                node.properties["loopEndMs"].as_f64(),
            )?;
        }
        if node.node_type == "builtinScene" {
            builtin_count += 1;
            normalize_builtin(node, manifest)?;
        }
        if node.node_type == "model" {
            model_count += 1;
        }
        let mut node_ir = NodeIr {
            id: node.id.clone(),
            node_type: node.node_type.clone(),
            parent_index: -1,
            matrix_offset: index * 16,
            dirty_mask_offset: index,
            property_slots: BTreeMap::new(),
            constant_slots: BTreeMap::new(),
            assets: node.assets.clone(),
            space: space.clone(),
        };
        for (key, value) in &node.properties {
            let field = schema.properties[key]
                .in_space(&space)
                .expect("normalized field");
            if field.field_type == "number" || field.field_type == "vector" {
                add_slots(&mut slots, &mut node_ir, index, key, value, field, false);
            } else if field.field_type != "sceneParams" {
                node_ir.constant_slots.insert(key.clone(), constants.len());
                constants.push(ConstantSlot {
                    node_index: index,
                    property: key.clone(),
                    value: value.clone(),
                    builtin_parameter: false,
                });
            }
        }
        if node.node_type == "builtinScene" {
            let scene_id = node.properties["sceneId"]
                .as_str()
                .expect("validated scene id");
            let scene = crate::catalog()
                .scene(scene_id)
                .expect("validated registry");
            for (key, value) in node.properties["params"]
                .as_object()
                .expect("validated params")
            {
                let spec = &scene["params"][key];
                if spec["type"] == "number" {
                    let field = Field {
                        field_type: "number".into(),
                        default: None,
                        min: spec["min"].as_f64(),
                        max: spec["max"].as_f64(),
                        integer: false,
                        animatable: spec["animatable"].as_bool().unwrap_or(false),
                        public: true,
                        affects: vec!["geometry".into(), "material".into(), "resource".into()],
                        length: None,
                        max_length: None,
                        options: Vec::new(),
                        space: None,
                        alternatives: BTreeMap::new(),
                    };
                    if field.min.is_none() || field.max.is_none() {
                        return Err(invalid("内置数字参数缺少发布范围"));
                    }
                    if node_ir.property_slots.contains_key(key) {
                        return Err(invalid("内置参数与节点字段槽位冲突"));
                    }
                    add_slots(&mut slots, &mut node_ir, index, key, value, &field, true);
                } else {
                    node_ir.constant_slots.insert(key.clone(), constants.len());
                    constants.push(ConstantSlot {
                        node_index: index,
                        property: key.clone(),
                        value: value.clone(),
                        builtin_parameter: true,
                    });
                }
            }
        }
        spaces.push(space);
        nodes.push(node_ir);
    }
    if builtin_count > 1 || (builtin_count > 0 && model_count > 0) {
        return Err(invalid(
            "三维背景最多一个 builtinScene，且不能与 model 共存",
        ));
    }
    if model_count > 0 && document.canvas.scene3d.is_none() {
        return Err(invalid("model 必须声明 canvas.scene3d 相机"));
    }
    let (painter_order, matrix_dependents) =
        compile_graph(&document.nodes, &ids, &spaces, &mut nodes)?;
    let mut effect_ids = BTreeSet::new();
    let mut target_counts = BTreeMap::new();
    let mut effect_surfaces = Vec::new();
    let mut effect_targets = Vec::new();
    for (index, effect) in document.effects.iter_mut().enumerate() {
        check_id(&effect.id)?;
        if !effect_ids.insert(&effect.id) {
            return Err(invalid("效果 id 重复"));
        }
        let schema = definitions
            .effects
            .iter()
            .find(|schema| schema.effect_type == effect.effect_type)
            .ok_or_else(|| invalid("未知效果类型"))?;
        if effect.state_version != schema.state_version {
            return Err(invalid("效果 stateVersion 不支持"));
        }
        let kind = match &effect.target {
            EffectTarget::Output => "output",
            EffectTarget::Node { node_id } => {
                &document.nodes[*ids
                    .get(node_id)
                    .ok_or_else(|| invalid("效果目标节点不存在"))?]
                .node_type
            }
        };
        if !schema.targets.iter().any(|allowed| allowed == kind) {
            return Err(invalid("效果不支持此目标类型"));
        }
        let count = target_counts.entry(effect.target.clone()).or_insert(0);
        *count += 1;
        if *count > MAX_EFFECTS_PER_TARGET {
            return Err(invalid("同一目标最多 8 个效果"));
        }
        normalize_properties(&mut effect.properties, &schema.properties, "2d")?;
        validate_assets(
            &effect.assets,
            &schema.assets,
            manifest,
            None,
            Some(index),
            &mut resources,
        )?;
        let cost_scope = if matches!(effect.target, EffectTarget::Output) {
            "output"
        } else {
            "node"
        };
        let cost = schema
            .cost
            .get(cost_scope)
            .ok_or_else(|| invalid("效果缺少目标成本声明"))?;
        effect_surfaces.push(cost.surfaces);
        effect_targets.push(match &effect.target {
            EffectTarget::Output => None,
            EffectTarget::Node { node_id } => Some(ids[node_id]),
        });
    }
    let tracks = compile_tracks(&document, &ids, &nodes, &slots)?;
    let bindings = compile_bindings(&document, &ids, &nodes, &slots, &definitions.inputs)?;
    let public_properties = compile_public(manifest, &document, &ids, &nodes, &slots, &bindings)?;
    let (slot_dependencies, constant_dependencies) =
        compile_dependencies(&document, &nodes, &slots, &constants, &matrix_dependents)?;
    let effect_dependencies: Vec<_> = effect_targets
        .iter()
        .enumerate()
        .map(|(index, target)| DirtyDependency {
            nodes: target
                .map(|node_index| {
                    vec![NodeDirty {
                        node_index,
                        mask: DIRTY_MATERIAL,
                    }]
                })
                .unwrap_or_default(),
            effects: vec![index],
            output: true,
        })
        .collect();
    let resource_dependencies = resources
        .iter()
        .map(|resource| {
            if let Some(index) = resource.effect_index {
                return DirtyDependency {
                    nodes: effect_dependencies[index].nodes.clone(),
                    effects: vec![index],
                    output: true,
                };
            }
            let mask = DIRTY_RESOURCE
                | DIRTY_MATERIAL
                | match resource.usage.as_str() {
                    "font" => DIRTY_LAYOUT,
                    "model" => DIRTY_GEOMETRY,
                    _ => 0,
                };
            DirtyDependency {
                nodes: resource
                    .node_index
                    .map(|node_index| vec![NodeDirty { node_index, mask }])
                    .unwrap_or_default(),
                effects: Vec::new(),
                output: true,
            }
        })
        .collect();
    let mut static_requirements = vec![StaticRequirement::OutputPixels];
    for (index, node) in document.nodes.iter().enumerate() {
        match node.node_type.as_str() {
            "group" => {}
            "particles" => static_requirements.push(StaticRequirement::ParticleInstances {
                node_index: index,
                count_slot: nodes[index].property_slots["count"][0],
            }),
            "model" | "builtinScene" => {
                static_requirements.push(StaticRequirement::ResolvedGeometry { node_index: index })
            }
            "text" => static_requirements.push(StaticRequirement::TextLayout {
                node_index: index,
                constant_slot: nodes[index].constant_slots["text"],
                max_utf16_units: definitions
                    .nodes
                    .iter()
                    .find(|schema| schema.node_type == "text")
                    .expect("text schema")
                    .properties["text"]
                    .max_length
                    .expect("text limit"),
            }),
            _ => static_requirements.push(StaticRequirement::NodeDraw { node_index: index }),
        }
    }
    for (index, count) in effect_surfaces.iter().enumerate() {
        if *count > 0 {
            static_requirements.push(StaticRequirement::EffectSurfaces {
                effect_index: index,
                count: *count,
                input_textures: definitions
                    .effects
                    .iter()
                    .find(|schema| schema.effect_type == document.effects[index].effect_type)
                    .expect("effect")
                    .input_textures,
                output_format: "rgba8".into(),
                sample_scale: definitions
                    .effects
                    .iter()
                    .find(|schema| schema.effect_type == document.effects[index].effect_type)
                    .expect("effect")
                    .sample_scale,
                quality: definitions
                    .effects
                    .iter()
                    .find(|schema| schema.effect_type == document.effects[index].effect_type)
                    .expect("effect")
                    .quality
                    .clone(),
                cost: definitions
                    .effects
                    .iter()
                    .find(|schema| schema.effect_type == document.effects[index].effect_type)
                    .expect("effect")
                    .cost["output"]
                    .clone(),
            });
        }
    }
    let normalized_bytes =
        serde_json::to_vec(&document).map_err(|error| invalid(error.to_string()))?;
    if normalized_bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(invalid("补全默认值后的规范文档超过 1 MiB"));
    }
    let document_hash = digest(&normalized_bytes);
    let scene_registry_hash = crate::catalog().registry_hash.clone();
    // Public target/constraint declarations live in manifest.properties. They
    // affect this IR and therefore cannot alias in the semantic cache.
    let public_properties_hash = digest(
        &serde_json::to_vec(&public_properties).map_err(|error| invalid(error.to_string()))?,
    );
    let semantic_key = digest(
        format!(
        "{document_hash}\0{COMPILER_VERSION}\0{}\0{scene_registry_hash}\0{public_properties_hash}",
            contract.registry_hash
        )
        .as_bytes(),
    );
    let ir = SemanticIr {
        compiler_version: COMPILER_VERSION,
        document_hash,
        registry_hash: contract.registry_hash.clone(),
        scene_registry_hash,
        public_properties_hash,
        semantic_key,
        planar_order: painter_order
            .iter()
            .copied()
            .filter(|index| spaces[*index] == "2d")
            .collect(),
        spatial_order: painter_order
            .iter()
            .copied()
            .filter(|index| spaces[*index] == "3d")
            .collect(),
        nodes,
        numeric_slots: slots,
        constant_slots: constants,
        painter_order,
        matrix_dependents,
        resource_uses: resources,
        static_requirements,
        slot_dependencies,
        constant_dependencies,
        resource_dependencies,
        effect_dependencies,
        effect_targets,
        effects: document.effects.clone(),
        effect_surfaces,
        tracks,
        bindings,
        public_properties,
        inputs: definitions.inputs.clone(),
    };
    Ok(CompiledDocument {
        document,
        ir,
        normalized_bytes,
    })
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Pure authored/final-value invariant; real media duration belongs to admission.
pub(super) fn validate_video_loop_range(start: f64, end: Option<f64>) -> Result<()> {
    if !end.is_some_and(|end| end > start) {
        return Err(invalid(
            "视频 loopEndMs 必须大于 loopStartMs；真实时长在目标准入复核",
        ));
    }
    Ok(())
}
fn check_id(id: &str) -> Result<()> {
    if crate::valid_local_id(id) {
        Ok(())
    } else {
        Err(invalid(format!("非法局部 id：{id}")))
    }
}

fn validate_canvas(canvas: &mut Canvas) -> Result<()> {
    if !(1..=16384).contains(&canvas.width)
        || !(1..=16384).contains(&canvas.height)
        || canvas.color_space != "srgb"
        || !super::catalog::valid_color(&canvas.background)
    {
        return Err(invalid(
            "画布要求 1–16384 整数尺寸、srgb 和固定十六进制背景颜色",
        ));
    }
    canvas.background.make_ascii_lowercase();
    if let Some(camera) = &canvas.scene3d {
        if !camera
            .position
            .iter()
            .chain(camera.target.iter())
            .all(|value| value.is_finite() && value.abs() <= 10000.0)
            || !camera.fov_degrees.is_finite()
            || !(1.0..=120.0).contains(&camera.fov_degrees)
            || !camera.near.is_finite()
            || !camera.far.is_finite()
            || camera.near <= 0.0
            || camera.far <= camera.near
            || camera.far > 1000000.0
            || camera.position == camera.target
        {
            return Err(invalid("scene3d 相机必须有有效米制坐标、视角和裁剪面"));
        }
    }
    Ok(())
}

fn normalize_properties(
    values: &mut BTreeMap<String, Value>,
    fields: &BTreeMap<String, Field>,
    space: &str,
) -> Result<()> {
    for key in values.keys() {
        if fields
            .get(key)
            .and_then(|field| field.in_space(space))
            .is_none()
        {
            return Err(invalid(format!("未知或空间不匹配的属性：{key}")));
        }
    }
    for (key, definition) in fields {
        let Some(field) = definition.in_space(space) else {
            continue;
        };
        let value = values
            .get(key)
            .or(field.default.as_ref())
            .ok_or_else(|| invalid(format!("缺少属性：{key}")))?;
        if !field.validate(value) {
            return Err(invalid(format!("属性 {key} 不满足发布类型或范围")));
        }
        let canonical = match field.field_type.as_str() {
            "number" if field.integer => json!(value.as_f64().expect("number") as u64),
            "number" => json!(value.as_f64().expect("number")),
            "vector" => Value::Array(
                value
                    .as_array()
                    .expect("vector")
                    .iter()
                    .map(|part| json!(part.as_f64().expect("number")))
                    .collect(),
            ),
            "color" => json!(value.as_str().expect("color").to_ascii_lowercase()),
            _ => value.clone(),
        };
        values.insert(key.clone(), canonical);
    }
    Ok(())
}

fn normalize_builtin(node: &mut Node, manifest: &Manifest) -> Result<()> {
    let mut contextual = manifest.clone();
    contextual.properties.clear();
    contextual.content = Content::Builtin {
        scene_id: node.properties["sceneId"].as_str().expect("scene").into(),
        state_version: node.properties["stateVersion"].as_u64().expect("integer") as u32,
        params: node.properties["params"]
            .as_object()
            .expect("params")
            .clone(),
    };
    let Content::Builtin { mut params, .. } =
        crate::properties::effective_content(&contextual, &Map::new())?
    else {
        unreachable!()
    };
    if params
        .keys()
        .any(|key| ["sceneId", "stateVersion", "params"].contains(&key.as_str()))
    {
        return Err(invalid("内置参数与节点结构字段名称冲突"));
    }
    for value in params.values_mut() {
        if let Some(number) = value.as_f64() {
            *value = json!(number);
        }
    }
    node.properties
        .insert("params".into(), Value::Object(params));
    Ok(())
}

fn validate_assets(
    values: &BTreeMap<String, String>,
    fields: &BTreeMap<String, AssetField>,
    manifest: &Manifest,
    node_index: Option<usize>,
    effect_index: Option<usize>,
    uses: &mut Vec<ResourceUse>,
) -> Result<()> {
    for key in values.keys() {
        if !fields.contains_key(key) {
            return Err(invalid(format!("未知资源槽：{key}")));
        }
    }
    for (key, field) in fields {
        let Some(id) = values.get(key) else {
            if field.required {
                return Err(invalid(format!("缺少资源槽：{key}")));
            }
            continue;
        };
        check_id(id)?;
        let asset = manifest
            .assets
            .iter()
            .find(|asset| &asset.id == id)
            .ok_or_else(|| invalid(format!("同包资源不存在：{id}")))?;
        if !field.kinds.contains(&asset.kind) {
            return Err(invalid(format!("资源槽 {key} 类型不匹配")));
        }
        uses.push(ResourceUse {
            asset_id: id.clone(),
            node_index,
            effect_index,
            field: key.clone(),
            usage: field.usage.clone(),
        });
    }
    Ok(())
}

fn add_slots(
    slots: &mut Vec<NumericSlot>,
    node: &mut NodeIr,
    index: usize,
    key: &str,
    value: &Value,
    field: &Field,
    builtin: bool,
) {
    let values: Vec<f64> = if field.field_type == "vector" {
        value
            .as_array()
            .expect("vector")
            .iter()
            .map(|v| v.as_f64().expect("number"))
            .collect()
    } else {
        vec![value.as_f64().expect("number")]
    };
    let mut indices = Vec::with_capacity(values.len());
    for (component, value) in values.into_iter().enumerate() {
        indices.push(slots.len());
        slots.push(NumericSlot {
            node_index: index,
            property: key.into(),
            component: if field.field_type == "vector" {
                Some(component as u32)
            } else {
                None
            },
            value,
            min: field.min.expect("bounded field"),
            max: field.max.expect("bounded field"),
            animatable: field.animatable,
            integer: field.integer,
            builtin_parameter: builtin,
        });
    }
    node.property_slots.insert(key.into(), indices);
}

fn compile_graph(
    source: &[Node],
    ids: &BTreeMap<String, usize>,
    spaces: &[String],
    nodes: &mut [NodeIr],
) -> Result<(Vec<usize>, Vec<Vec<usize>>)> {
    let mut parents = vec![None; source.len()];
    let mut children = vec![Vec::new(); source.len()];
    for (index, node) in source.iter().enumerate() {
        let mut seen = BTreeSet::new();
        for child in &node.children {
            if !seen.insert(child) {
                return Err(invalid("children 内重复引用"));
            }
            let child_index = *ids
                .get(child)
                .ok_or_else(|| invalid("children 引用不存在"))?;
            if parents[child_index].replace(index).is_some() {
                return Err(invalid("节点不允许多个父节点"));
            }
            if spaces[index] != spaces[child_index] {
                return Err(invalid("group 与子节点空间不匹配"));
            }
            children[index].push(child_index);
        }
    }
    let mut dependents = vec![Vec::new(); source.len()];
    for index in 0..source.len() {
        let mut chain = BTreeSet::new();
        let mut parent = Some(index);
        while let Some(current) = parent {
            if !chain.insert(current) {
                return Err(invalid("节点父链存在循环"));
            }
            if chain.len() > MAX_PARENT_DEPTH {
                return Err(invalid("父子深度超过 8 层"));
            }
            if current != index {
                dependents[current].push(index);
            }
            parent = parents[current];
        }
        nodes[index].parent_index = parents[index].map_or(-1, |parent| parent as i32);
    }
    fn walk(index: usize, children: &[Vec<usize>], order: &mut Vec<usize>) {
        order.push(index);
        for child in &children[index] {
            walk(*child, children, order);
        }
    }
    let mut order = Vec::with_capacity(source.len());
    for (index, parent) in parents.iter().enumerate() {
        if parent.is_none() {
            walk(index, &children, &mut order);
        }
    }
    Ok((order, dependents))
}

type CompiledDependencies = (Vec<DirtyDependency>, Vec<BTreeMap<String, DirtyDependency>>);

fn compile_dependencies(
    document: &Document,
    nodes: &[NodeIr],
    slots: &[NumericSlot],
    constants: &[ConstantSlot],
    descendants: &[Vec<usize>],
) -> Result<CompiledDependencies> {
    fn dependency(index: usize, roles: &[String], descendants: &[Vec<usize>]) -> DirtyDependency {
        let mut mask = 0;
        for role in roles {
            mask |= match role.as_str() {
                "matrix" => DIRTY_MATRIX,
                "layout" => DIRTY_LAYOUT,
                "material" => DIRTY_MATERIAL,
                "visibility" => DIRTY_VISIBILITY,
                "resource" => DIRTY_RESOURCE,
                "geometry" => DIRTY_GEOMETRY,
                _ => 0,
            };
        }
        let mut nodes = if mask == 0 {
            Vec::new()
        } else {
            vec![NodeDirty {
                node_index: index,
                mask,
            }]
        };
        let inherited = roles.iter().any(|role| role == "descendants");
        let child_mask = if inherited { mask } else { mask & DIRTY_MATRIX };
        if child_mask != 0 {
            nodes.extend(descendants[index].iter().map(|child| NodeDirty {
                node_index: *child,
                mask: child_mask,
            }));
        }
        DirtyDependency {
            nodes,
            effects: Vec::new(),
            output: mask != 0,
        }
    }
    let slot_dependencies = slots
        .iter()
        .map(|slot| {
            let schema = composition_catalog()
                .definitions
                .nodes
                .iter()
                .find(|schema| schema.node_type == document.nodes[slot.node_index].node_type)
                .expect("node");
            let roles = if slot.builtin_parameter {
                vec!["material".into(), "geometry".into(), "resource".into()]
            } else {
                schema.properties[&slot.property]
                    .in_space(&nodes[slot.node_index].space)
                    .expect("field")
                    .affects
                    .clone()
            };
            dependency(slot.node_index, &roles, descendants)
        })
        .collect();
    let constant_dependencies = nodes
        .iter()
        .enumerate()
        .map(|(index, node)| {
            let schema = composition_catalog()
                .definitions
                .nodes
                .iter()
                .find(|schema| schema.node_type == node.node_type)
                .expect("node");
            node.constant_slots
                .iter()
                .map(|(key, slot)| {
                    let roles = if constants[*slot].builtin_parameter {
                        vec!["material".into(), "geometry".into(), "resource".into()]
                    } else {
                        schema.properties[key]
                            .in_space(&node.space)
                            .expect("field")
                            .affects
                            .clone()
                    };
                    (key.clone(), dependency(index, &roles, descendants))
                })
                .collect()
        })
        .collect();
    Ok((slot_dependencies, constant_dependencies))
}

fn target_slot(
    target: &NodeTarget,
    ids: &BTreeMap<String, usize>,
    nodes: &[NodeIr],
    slots: &[NumericSlot],
    animation: bool,
) -> Result<usize> {
    let node = *ids
        .get(&target.node_id)
        .ok_or_else(|| invalid("目标 nodeId 不存在"))?;
    let indices = nodes[node]
        .property_slots
        .get(&target.property)
        .ok_or_else(|| invalid("目标不是已声明数值槽"))?;
    let index = match target.component {
        None if indices.len() == 1 && slots[indices[0]].component.is_none() => indices[0],
        Some(component)
            if slots[indices[0]].component.is_some() && (component as usize) < indices.len() =>
        {
            indices[component as usize]
        }
        _ => return Err(invalid("目标 component 与标量/向量槽不匹配")),
    };
    if animation && !slots[index].animatable {
        return Err(invalid("此数值字段未声明 animatable"));
    }
    Ok(index)
}

fn compile_tracks(
    document: &Document,
    ids: &BTreeMap<String, usize>,
    nodes: &[NodeIr],
    slots: &[NumericSlot],
) -> Result<Vec<CompiledTrack>> {
    let duration = document.timeline.duration_seconds;
    if !duration.is_finite() || duration <= 0.0 || duration > 3600.0 {
        return Err(invalid("timeline durationSeconds 必须在 (0,3600]"));
    }
    let mut ids_seen = BTreeSet::new();
    let mut targets = BTreeSet::new();
    let mut count = 0;
    let mut result = Vec::new();
    for track in &document.timeline.tracks {
        check_id(&track.id)?;
        let target = target_slot(&track.target, ids, nodes, slots, true)?;
        if !ids_seen.insert(&track.id) || !targets.insert(target) {
            return Err(invalid("轨道 id 或目标重复"));
        }
        count += track.keys.len();
        if track.keys.is_empty() || count > MAX_KEYS {
            return Err(invalid("轨道需要关键帧，且总数最多 4096"));
        }
        let mut previous = -1.0;
        for key in &track.keys {
            if !key.time_seconds.is_finite()
                || key.time_seconds <= previous
                || key.time_seconds > duration
                || !key.value.is_finite()
                || key.value < slots[target].min
                || key.value > slots[target].max
            {
                return Err(invalid(
                    "关键帧时间须严格递增且在 timeline 内，值须符合槽范围",
                ));
            }
            if key.time_seconds < 0.0 {
                return Err(invalid("关键帧时间不能为负"));
            }
            previous = key.time_seconds;
        }
        result.push(CompiledTrack {
            target_slot: target,
            keys: track.keys.clone(),
        });
    }
    Ok(result)
}

fn compile_bindings(
    document: &Document,
    ids: &BTreeMap<String, usize>,
    nodes: &[NodeIr],
    slots: &[NumericSlot],
    inputs: &[String],
) -> Result<Vec<CompiledBinding>> {
    let mut names = BTreeSet::new();
    let mut targets = BTreeSet::new();
    let mut result = Vec::new();
    for binding in &document.bindings {
        check_id(&binding.id)?;
        let target = target_slot(&binding.target, ids, nodes, slots, true)?;
        if !names.insert(&binding.id) || !targets.insert(target) {
            return Err(invalid("绑定 id 或目标重复"));
        }
        if binding.program.is_empty()
            || binding.program.len() > MAX_OPERATIONS
            || binding.parameters.len() > MAX_OPERATIONS
        {
            return Err(invalid("绑定程序/参数最多 32 项且程序不可为空"));
        }
        for (name, value) in &binding.parameters {
            check_id(name)?;
            if !value.is_finite() {
                return Err(invalid("绑定参数必须有限"));
            }
        }
        let parameters: Vec<_> = binding
            .parameters
            .iter()
            .map(|(name, value)| (name.clone(), *value))
            .collect();
        let mut depth: usize = 0;
        let mut max_stack = 0;
        let mut program = Vec::new();
        for operation in &binding.program {
            let (opcode, index, operands, pops, pushes) = match operation {
                Operation::Input { name } => (
                    0,
                    inputs
                        .iter()
                        .position(|input| input == name)
                        .ok_or_else(|| invalid("绑定输入不在白名单"))?,
                    [0.0; 4],
                    0,
                    1,
                ),
                Operation::Parameter { name } => (
                    1,
                    parameters
                        .iter()
                        .position(|(parameter, _)| parameter == name)
                        .ok_or_else(|| invalid("绑定引用未知 parameter"))?,
                    [0.0; 4],
                    0,
                    1,
                ),
                Operation::Const { value } => (2, 0, [*value, 0.0, 0.0, 0.0], 0, 1),
                Operation::Add => (3, 0, [0.0; 4], 2, 1),
                Operation::Mul => (4, 0, [0.0; 4], 2, 1),
                Operation::Sin => (5, 0, [0.0; 4], 1, 1),
                Operation::Cos => (6, 0, [0.0; 4], 1, 1),
                Operation::Abs => (7, 0, [0.0; 4], 1, 1),
                Operation::Clamp { min, max } => {
                    if min > max {
                        return Err(invalid("clamp min 大于 max"));
                    }
                    (8, 0, [*min, *max, 0.0, 0.0], 1, 1)
                }
                Operation::Map {
                    input_min,
                    input_max,
                    output_min,
                    output_max,
                } => {
                    if input_min == input_max {
                        return Err(invalid("map 输入区间为零"));
                    }
                    (
                        9,
                        0,
                        [*input_min, *input_max, *output_min, *output_max],
                        1,
                        1,
                    )
                }
                Operation::Smoothstep { edge0, edge1 } => {
                    if edge0 >= edge1 {
                        return Err(invalid("smoothstep edge0 必须小于 edge1"));
                    }
                    (10, 0, [*edge0, *edge1, 0.0, 0.0], 1, 1)
                }
            };
            if !operands.iter().all(|value| value.is_finite()) || depth < pops {
                return Err(invalid("绑定运算包含非有限值或栈下溢"));
            }
            depth = depth - pops + pushes;
            max_stack = max_stack.max(depth);
            if depth > MAX_STACK {
                return Err(invalid("绑定栈深超过 8"));
            }
            program.push(Instruction {
                opcode,
                index,
                operands,
            });
        }
        if depth != 1 {
            return Err(invalid("绑定结束时必须恰好一个栈值"));
        }
        result.push(CompiledBinding {
            id: binding.id.clone(),
            target_slot: target,
            mode: binding.mode,
            parameters,
            program,
            max_stack,
        });
    }
    Ok(result)
}

fn compile_public(
    manifest: &Manifest,
    document: &Document,
    ids: &BTreeMap<String, usize>,
    nodes: &[NodeIr],
    slots: &[NumericSlot],
    bindings: &[CompiledBinding],
) -> Result<Vec<PublicProperty>> {
    let mut result = Vec::new();
    for descriptor in crate::properties::validate_properties(manifest)? {
        let target = match &descriptor.target {
            PropertyTarget::Binding {
                binding_id,
                parameter,
            } => {
                let index = bindings
                    .iter()
                    .position(|binding| &binding.id == binding_id)
                    .ok_or_else(|| invalid("公开参数 bindingId 不存在"))?;
                let parameter_index = bindings[index]
                    .parameters
                    .iter()
                    .position(|(name, _)| name == parameter)
                    .ok_or_else(|| invalid("公开参数 binding parameter 不存在"))?;
                if descriptor.property_type != PropertyType::Number {
                    return Err(invalid("绑定参数只接受有界数值公开属性"));
                }
                PublicTarget::BindingParameter {
                    binding_index: index,
                    parameter_index,
                }
            }
            PropertyTarget::Node {
                node_id,
                property,
                component,
            } => {
                let index = *ids
                    .get(node_id)
                    .ok_or_else(|| invalid("公开参数 nodeId 不存在"))?;
                let node = &document.nodes[index];
                let schema = composition_catalog()
                    .definitions
                    .nodes
                    .iter()
                    .find(|schema| schema.node_type == node.node_type)
                    .expect("validated schema");
                if let Some(asset) = schema.assets.get(property) {
                    if component.is_some() {
                        return Err(invalid("资源公开参数不接受 component"));
                    }
                    let PropertyConstraints::Asset { kind, .. } = &descriptor.constraints else {
                        return Err(invalid("资源槽公开参数须为 asset"));
                    };
                    if !asset.kinds.contains(kind) {
                        return Err(invalid("公开资源类型与槽不匹配"));
                    }
                    PublicTarget::Asset {
                        node_index: index,
                        field: property.clone(),
                    }
                } else if node.node_type == "builtinScene"
                    && node.properties["params"].get(property).is_some()
                {
                    let mut contextual = manifest.clone();
                    contextual.content = Content::Builtin {
                        scene_id: node.properties["sceneId"].as_str().expect("scene").into(),
                        state_version: node.properties["stateVersion"].as_u64().expect("version")
                            as u32,
                        params: node.properties["params"]
                            .as_object()
                            .expect("params")
                            .clone(),
                    };
                    let mut public = descriptor.clone();
                    public.target = PropertyTarget::Node {
                        node_id: "content".into(),
                        property: property.clone(),
                        component: *component,
                    };
                    contextual.properties = vec![serde_json::to_value(public)
                        .expect("descriptor")
                        .as_object()
                        .expect("object")
                        .clone()];
                    crate::properties::validate_properties(&contextual)?;
                    if nodes[index].property_slots.contains_key(property) {
                        PublicTarget::Numeric {
                            slot: target_slot(
                                &NodeTarget {
                                    node_id: node_id.clone(),
                                    property: property.clone(),
                                    component: *component,
                                },
                                ids,
                                nodes,
                                slots,
                                false,
                            )?,
                        }
                    } else {
                        PublicTarget::Constant {
                            slot: nodes[index].constant_slots[property],
                        }
                    }
                } else {
                    let field = schema
                        .properties
                        .get(property)
                        .and_then(|field| field.in_space(&nodes[index].space))
                        .ok_or_else(|| invalid("公开参数属性不存在"))?;
                    if !field.public {
                        return Err(invalid("结构或注册身份字段不能作为公开参数"));
                    }
                    if field.field_type == "number" || field.field_type == "vector" {
                        let slot = target_slot(
                            &NodeTarget {
                                node_id: node_id.clone(),
                                property: property.clone(),
                                component: *component,
                            },
                            ids,
                            nodes,
                            slots,
                            false,
                        )?;
                        let PropertyConstraints::Number { min, max, .. } = &descriptor.constraints
                        else {
                            return Err(invalid("数值槽公开参数须为 number"));
                        };
                        if *min < slots[slot].min || *max > slots[slot].max {
                            return Err(invalid("公开数值范围不能扩大节点范围"));
                        }
                        if slots[slot].integer
                            && descriptor
                                .default
                                .as_f64()
                                .is_none_or(|value| value.fract() != 0.0)
                        {
                            return Err(invalid("整数字段的公开默认值必须为整数"));
                        }
                        PublicTarget::Numeric { slot }
                    } else {
                        if component.is_some() || !field.validate(&descriptor.default) {
                            return Err(invalid("公开属性的默认值或 component 不匹配"));
                        }
                        let compatible = matches!(
                            (&*field.field_type, descriptor.property_type),
                            ("boolean", PropertyType::Boolean)
                                | ("color", PropertyType::Color)
                                | ("select", PropertyType::Select)
                                | ("text", PropertyType::Text)
                        );
                        if !compatible {
                            return Err(invalid("公开属性类型与节点不匹配"));
                        }
                        match &descriptor.constraints {
                            PropertyConstraints::Select { options }
                                if options.iter().any(|option| !field.validate(&option.value)) =>
                            {
                                return Err(invalid("公开选项不能扩大节点选项"))
                            }
                            PropertyConstraints::Text { max_length }
                                if field
                                    .max_length
                                    .is_none_or(|max| *max_length as usize > max) =>
                            {
                                return Err(invalid("公开文本长度不能扩大节点上限"))
                            }
                            _ => {}
                        }
                        PublicTarget::Constant {
                            slot: nodes[index].constant_slots[property],
                        }
                    }
                }
            }
        };
        result.push(PublicProperty { descriptor, target });
    }
    Ok(result)
}
