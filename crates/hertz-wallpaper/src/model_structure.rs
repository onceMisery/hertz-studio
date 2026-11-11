// SPDX-License-Identifier: MIT
//! Bounded glTF structure and package dependency checks, after the sole GLB
//! container inspector. These facts do not establish binary or GPU validity.

use std::{collections::BTreeMap, fmt, io::Read, marker::PhantomData, sync::Arc};

use serde::{
    de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer,
};

use crate::{
    manifest::{AssetKind, Manifest},
    model_container::{inspect_glb, BinaryChunk, GlbContainer},
    paths::validate_rel_path,
    PackageError, Result,
};

pub const MAX_MODEL_NODES: usize = 5_000;
pub const MAX_MODEL_TRIANGLES: u64 = 1_000_000;
/// Fixed structural limits, also enforced while deserializing each array.
pub const MAX_MODEL_RECORDS: usize = 16_384;
pub const MAX_MODEL_IMAGE_RECORDS: usize = 4_096;
pub const MAX_MODEL_ATTRIBUTES: usize = 32;
pub const MAX_MODEL_ANIMATIONS: usize = 1_024;

pub use heap_bounds::ModelHeapBounds;

pub use animation::{
    AnimationInterpolation, AnimationPath, ModelAnimation, ModelAnimationChannel,
    ModelAnimationSampler,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageImageRef {
    pub asset_id: String,
    pub variant_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelImage {
    Package {
        path: String,
        mime: String,
        bytes: u64,
        sha256: String,
        /// Same-path image entries share these immutable broker references;
        /// repeated image records cannot multiply manifest alias allocations.
        references: Arc<[PackageImageRef]>,
    },
    Embedded {
        buffer_view: usize,
        range: BinaryChunk,
        mime: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum AccessorShape {
    #[serde(rename = "SCALAR")]
    Scalar,
    #[serde(rename = "VEC2")]
    Vec2,
    #[serde(rename = "VEC3")]
    Vec3,
    #[serde(rename = "VEC4")]
    Vec4,
    #[serde(rename = "MAT2")]
    Mat2,
    #[serde(rename = "MAT3")]
    Mat3,
    #[serde(rename = "MAT4")]
    Mat4,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelBufferView {
    pub range: BinaryChunk,
    pub byte_stride: Option<u64>,
    pub target: Option<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModelAccessor {
    pub buffer_view: usize,
    pub byte_offset: u64,
    /// Absolute container range including gaps and matrix column padding.
    pub range: BinaryChunk,
    pub component_type: u32,
    pub shape: AccessorShape,
    pub count: u64,
    pub normalized: bool,
    pub stride: u64,
    pub element_bytes: u64,
    /// Declared component bounds, retained for later actual BIN comparison.
    pub min: Option<Vec<f64>>,
    pub max: Option<Vec<f64>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelPrimitive {
    pub attributes: BTreeMap<String, usize>,
    /// Author maps only; omitted targets are not expanded into zero deltas.
    pub targets: Vec<BTreeMap<String, usize>>,
    pub indices: Option<usize>,
    pub material: Option<usize>,
    /// Missing and explicitly authored TRIANGLES remain distinct facts.
    pub authored_mode: Option<u32>,
    pub triangles_upper_bound: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModelMesh {
    pub primitives: Vec<ModelPrimitive>,
    pub morph_target_count: usize,
    /// Missing means all zero; finite author f64 values remain unchanged.
    pub default_weights: Option<Vec<f64>>,
    pub triangles_upper_bound: u64,
    pub loader_pivot: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ModelNodeTransform {
    Matrix([f64; 16]),
    Trs {
        translation: [f64; 3],
        rotation: [f64; 4],
        scale: [f64; 3],
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModelNode {
    pub parent: Option<usize>,
    pub children: Vec<usize>,
    pub mesh: Option<usize>,
    pub camera: Option<usize>,
    pub skin: Option<usize>,
    pub transform: ModelNodeTransform,
    pub loader_pivot: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelScene {
    pub nodes: Vec<usize>,
}

/// Authored presence needed by the later static loader profile. These flags
/// neither reject historically accepted nulls nor establish loader validity.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ModelStaticLoaderFields {
    pub has_buffer_uri: bool,
    pub has_null_properties: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelSkin {
    pub joints: Vec<usize>,
    pub skeleton: Option<usize>,
    /// None denotes the specified identity matrices, without expanding them.
    pub inverse_bind_matrices: Option<usize>,
    pub common_root: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelSkinBinding {
    pub mesh: usize,
    pub primitive: usize,
    pub skin: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModelStructure {
    pub buffer_views: Vec<ModelBufferView>,
    pub accessors: Vec<ModelAccessor>,
    pub meshes: Vec<ModelMesh>,
    pub images: Vec<ModelImage>,
    pub animations: Vec<ModelAnimation>,
    pub skins: Vec<ModelSkin>,
    pub skin_bindings: Vec<ModelSkinBinding>,
    /// All author binding/pair consumers, before any numeric layout dedup.
    pub skin_binding_pair_refs: u64,
    pub nodes: Vec<ModelNode>,
    pub scenes: Vec<ModelScene>,
    pub default_scene: Option<usize>,
    /// Logical buffer length, excluding the GLB BIN chunk's padding.
    pub buffer_byte_length: Option<u64>,
    pub material_count: usize,
    pub texture_count: usize,
    pub sampler_count: usize,
    pub camera_count: usize,
    pub static_loader_fields: ModelStaticLoaderFields,
    /// Aligned with original node indices; None inherits the mesh defaults.
    pub node_morph_weights: Vec<Option<Vec<f64>>>,
    pub mesh_triangles_upper_bound: u64,
    /// Includes every mesh-bearing node, even outside the default scene.
    pub instantiated_triangles_upper_bound: u64,
    /// Index values, floats, image decoding, animation and GPU costs remain
    /// separate checks. No successful result from this module sets this true.
    pub binary_content_validated: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GlbResource {
    pub container: GlbContainer,
    pub structure: ModelStructure,
}

pub fn inspect_glb_resource<R: Read>(
    input: R,
    declared_bytes: u64,
    manifest: &Manifest,
    path: &str,
) -> Result<GlbResource> {
    validate_model_path(path)?;
    let container = inspect_glb(input, declared_bytes)?;
    let structure = structure_from_container(&container, manifest, path)?;
    Ok(GlbResource {
        container,
        structure,
    })
}

pub(crate) fn structure_from_container(
    container: &GlbContainer,
    manifest: &Manifest,
    path: &str,
) -> Result<ModelStructure> {
    validate_model_path(path)?;
    let document: Schema = serde_json::from_slice(&container.json).map_err(|error| {
        let message = error.to_string();
        if message.starts_with("model_resource_unavailable:") {
            unavailable(message)
        } else if message.starts_with("model_structure_limit:") {
            PackageError::new("model_structure_limit", message)
        } else {
            invalid(format!("invalid glTF structure: {message}"))
        }
    })?;
    inspect_structure(document, container, manifest, path)
}

fn invalid(message: impl Into<String>) -> PackageError {
    PackageError::new("invalid_model_structure", message)
}
fn validate_model_path(path: &str) -> Result<()> {
    if path.len() > crate::MAX_PATH_BYTES {
        return Err(invalid("model path exceeds package path byte limit"));
    }
    validate_rel_path(path).map_err(|error| invalid(error.message))
}
fn unavailable(message: impl Into<String>) -> PackageError {
    PackageError::new("model_resource_unavailable", message)
}
fn checked_add(left: u64, right: u64) -> Result<u64> {
    left.checked_add(right)
        .ok_or_else(|| invalid("model byte/count arithmetic overflow"))
}
fn checked_mul(left: u64, right: u64) -> Result<u64> {
    left.checked_mul(right)
        .ok_or_else(|| invalid("model byte/count arithmetic overflow"))
}
fn at<'a, T>(items: &'a [T], index: usize, role: &str) -> Result<&'a T> {
    items
        .get(index)
        .ok_or_else(|| invalid(format!("{role} index {index} is out of range")))
}
fn triangles(total: u64, increment: u64) -> Result<u64> {
    let result = checked_add(total, increment)?;
    if result > MAX_MODEL_TRIANGLES {
        return Err(PackageError::new(
            "model_structure_limit",
            "model metadata triangle upper bound exceeds 1000000",
        ));
    }
    Ok(result)
}

fn inspect_structure(
    mut document: Schema,
    container: &GlbContainer,
    manifest: &Manifest,
    path: &str,
) -> Result<ModelStructure> {
    inspect_morph_totals(&document)?;
    let skin_author = inspect_skin_author(&document)?;
    if !document.extensions_used.0.is_empty() || !document.extensions_required.0.is_empty() {
        return Err(unavailable(
            "model extensions require a qualified content adapter",
        ));
    }
    for buffer in &document.buffers.0 {
        if buffer.uri.value.is_some() {
            return Err(unavailable(
                "external/data buffer URI is not available in the BIN subset",
            ));
        }
    }
    if document.buffers.0.len() > 1 {
        return Err(invalid("only buffer 0 may reference the GLB BIN chunk"));
    }
    if let Some(buffer) = document.buffers.0.first() {
        let binary = container
            .binary
            .as_ref()
            .ok_or_else(|| invalid("buffer 0 has no GLB BIN chunk"))?;
        if buffer.byte_length == 0
            || buffer.byte_length > binary.bytes
            || binary.bytes - buffer.byte_length > 3
        {
            return Err(invalid(
                "buffer byteLength must match BIN with at most 3 padding bytes",
            ));
        }
    }
    let mut buffer_views = Vec::with_capacity(document.buffer_views.0.len());
    for view in &document.buffer_views.0 {
        let buffer = at(&document.buffers.0, view.buffer, "bufferView.buffer")?;
        if view.byte_length == 0
            || checked_add(view.byte_offset, view.byte_length)? > buffer.byte_length
        {
            return Err(invalid("bufferView range exceeds its declared buffer"));
        }
        if view.byte_stride.value.is_some_and(|stride| {
            !(4..=252).contains(&stride) || stride % 4 != 0 || stride > view.byte_length
        }) || view
            .target
            .is_some_and(|target| ![34962, 34963].contains(&target))
        {
            return Err(invalid("bufferView stride/target is not legal glTF"));
        }
        let binary = container.binary.as_ref().expect("validated buffer BIN");
        buffer_views.push(ModelBufferView {
            range: BinaryChunk {
                offset: checked_add(binary.offset, view.byte_offset)?,
                bytes: view.byte_length,
            },
            byte_stride: view.byte_stride.value,
            target: view.target,
        });
    }
    let mut accessors = Vec::with_capacity(document.accessors.0.len());
    for accessor in &document.accessors.0 {
        accessors.push(inspect_accessor(accessor, &buffer_views)?);
    }
    let images = inspect_images(&document.images.0, &buffer_views, manifest, path)?;
    inspect_materials(&document)?;
    inspect_view_roles(&document, &accessors, &buffer_views)?;
    let mut meshes = Vec::with_capacity(document.meshes.0.len());
    let mut mesh_triangles_upper_bound = 0;
    let mut primitive_count = 0usize;
    for mesh in &mut document.meshes.0 {
        if mesh.primitives.0.is_empty() {
            return Err(invalid("mesh must contain a primitive"));
        }
        primitive_count += mesh.primitives.0.len();
        if primitive_count > MAX_MODEL_RECORDS {
            return Err(PackageError::new(
                "model_structure_limit",
                "too many model primitives",
            ));
        }
        let mut result = ModelMesh {
            primitives: Vec::with_capacity(mesh.primitives.0.len()),
            morph_target_count: 0,
            default_weights: None,
            triangles_upper_bound: 0,
            loader_pivot: mesh._extras.loader_pivot,
        };
        for primitive in &mut mesh.primitives.0 {
            let fact =
                inspect_primitive(primitive, &accessors, &buffer_views, &document.materials.0)?;
            if !fact.targets.is_empty() {
                if result.morph_target_count != 0 && result.morph_target_count != fact.targets.len()
                {
                    return Err(invalid("mesh primitives disagree on morph target count"));
                }
                result.morph_target_count = fact.targets.len();
            }
            result.triangles_upper_bound =
                triangles(result.triangles_upper_bound, fact.triangles_upper_bound)?;
            result.primitives.push(fact);
        }
        result.default_weights = inspect_weights(mesh.weights.as_ref(), result.morph_target_count)?;
        mesh_triangles_upper_bound =
            triangles(mesh_triangles_upper_bound, result.triangles_upper_bound)?;
        meshes.push(result);
    }
    let nodes = inspect_nodes(&document, &meshes)?;
    let (skins, skin_bindings) = inspect_skins(&document, &accessors, &nodes.graph, &skin_author)?;
    let animations = animation::inspect_animations(
        &document.animations.0,
        &document.nodes.0,
        &accessors,
        &meshes,
    )?;
    let static_loader_fields = inspect_static_loader_fields(&document);
    // Exact original-owner capacities avoid Vec's in-place collect changing a
    // Node allocation into a larger-capacity ModelNode allocation.
    let mut retained_nodes = Vec::with_capacity(document.nodes.0.len());
    for (node, parent) in document.nodes.0.into_iter().zip(nodes.graph.parents) {
        retained_nodes.push(ModelNode {
            parent,
            children: node.children.0,
            mesh: node.mesh.value,
            camera: node.camera.value,
            skin: node.skin,
            transform: match node.matrix.value {
                Some(matrix) => ModelNodeTransform::Matrix(matrix),
                None => ModelNodeTransform::Trs {
                    translation: node.translation.value.unwrap_or([0.0; 3]),
                    rotation: node.rotation.value.unwrap_or([0.0, 0.0, 0.0, 1.0]),
                    scale: node.scale.value.unwrap_or([1.0; 3]),
                },
            },
            loader_pivot: node._extras.loader_pivot,
        });
    }
    let mut scenes = Vec::with_capacity(document.scenes.0.len());
    for scene in document.scenes.0 {
        scenes.push(ModelScene {
            nodes: scene.nodes.0,
        });
    }
    Ok(ModelStructure {
        buffer_views,
        accessors,
        meshes,
        images,
        animations,
        skins,
        skin_bindings,
        skin_binding_pair_refs: skin_author.pair_consumers,
        nodes: retained_nodes,
        scenes,
        default_scene: document.scene.value,
        buffer_byte_length: document.buffers.0.first().map(|buffer| buffer.byte_length),
        material_count: document.materials.0.len(),
        texture_count: document.textures.0.len(),
        sampler_count: document.samplers.0.len(),
        camera_count: document.cameras.0.len(),
        static_loader_fields,
        node_morph_weights: nodes.morph_weights,
        mesh_triangles_upper_bound,
        instantiated_triangles_upper_bound: nodes.total_triangles,
        binary_content_validated: false,
    })
}

fn inspect_static_loader_fields(document: &Schema) -> ModelStaticLoaderFields {
    ModelStaticLoaderFields {
        has_buffer_uri: document.buffers.0.iter().any(|buffer| buffer.uri.present),
        has_null_properties: document.scene.is_null()
            || document
                .buffer_views
                .0
                .iter()
                .any(|view| view.byte_stride.is_null())
            || document.meshes.0.iter().any(|mesh| {
                mesh.primitives
                    .0
                    .iter()
                    .any(|primitive| primitive.indices.is_null() || primitive.material.is_null())
            })
            || document.nodes.0.iter().any(|node| {
                node.mesh.is_null()
                    || node.camera.is_null()
                    || node.matrix.is_null()
                    || node.translation.is_null()
                    || node.rotation.is_null()
                    || node.scale.is_null()
            }),
    }
}

// Check all author totals before copying facts or traversing references. Local
// arrays/maps were already bounded before deserializing each extra element.
fn inspect_morph_totals(document: &Schema) -> Result<()> {
    let mut targets = 0usize;
    let mut references = 0usize;
    let mut weights = 0usize;
    let add = |total: &mut usize, count: usize| -> Result<()> {
        *total = total.checked_add(count).ok_or_else(|| {
            PackageError::new("model_structure_limit", "morph author total overflow")
        })?;
        if *total > MAX_MODEL_RECORDS {
            return Err(PackageError::new(
                "model_structure_limit",
                "morph author total exceeds 16384",
            ));
        }
        Ok(())
    };
    for mesh in &document.meshes.0 {
        if let Some(values) = &mesh.weights {
            add(&mut weights, values.0.len())?;
        }
        for primitive in &mesh.primitives.0 {
            add(&mut targets, primitive.targets.0.len())?;
            for target in &primitive.targets.0 {
                add(&mut references, target.0.len())?;
            }
        }
    }
    for node in &document.nodes.0 {
        if let Some(values) = &node.weights {
            add(&mut weights, values.0.len())?;
        }
    }
    Ok(())
}

fn inspect_weights(
    values: Option<&Limited<f64, MAX_MODEL_RECORDS>>,
    count: usize,
) -> Result<Option<Vec<f64>>> {
    values
        .map(|values| {
            if count == 0
                || values.0.len() != count
                || values.0.iter().any(|value| !value.is_finite())
            {
                return Err(invalid(
                    "morph weights require a morph mesh, matching length and finite values",
                ));
            }
            Ok(values.0.clone())
        })
        .transpose()
}

impl AccessorShape {
    pub(crate) fn dimensions(self) -> (u64, u64) {
        match self {
            Self::Scalar => (1, 1),
            Self::Vec2 => (1, 2),
            Self::Vec3 => (1, 3),
            Self::Vec4 => (1, 4),
            Self::Mat2 => (2, 2),
            Self::Mat3 => (3, 3),
            Self::Mat4 => (4, 4),
        }
    }
}

fn inspect_accessor(accessor: &Accessor, views: &[ModelBufferView]) -> Result<ModelAccessor> {
    let view_index = accessor
        .buffer_view
        .ok_or_else(|| invalid("accessor requires a bufferView in the non-sparse subset"))?;
    let view = at(views, view_index, "accessor.bufferView")?;
    let component_bytes = match accessor.component_type {
        5120 | 5121 => 1,
        5122 | 5123 => 2,
        5125 | 5126 => 4,
        _ => return Err(invalid("accessor componentType is not legal glTF")),
    };
    if accessor.count == 0
        || (accessor.normalized && ![5120, 5121, 5122, 5123].contains(&accessor.component_type))
    {
        return Err(invalid("accessor count/normalized is not legal glTF"));
    }
    let (columns, rows) = accessor.shape.dimensions();
    let column_bytes = rows * component_bytes;
    let padded_column = if columns > 1 {
        column_bytes.div_ceil(4) * 4
    } else {
        column_bytes
    };
    let packed_stride = columns * padded_column;
    let element_bytes = packed_stride;
    let stride = view.byte_stride.unwrap_or(packed_stride);
    let absolute_offset = checked_add(view.range.offset, accessor.byte_offset)?;
    if !accessor.byte_offset.is_multiple_of(component_bytes)
        || !absolute_offset.is_multiple_of(component_bytes)
        || stride < packed_stride
        || !stride.is_multiple_of(component_bytes)
    {
        return Err(invalid(
            "accessor offset/stride violates component or matrix alignment",
        ));
    }
    let bytes = checked_add(checked_mul(stride, accessor.count - 1)?, element_bytes)?;
    if checked_add(accessor.byte_offset, bytes)? > view.range.bytes {
        return Err(invalid("accessor range exceeds its bufferView"));
    }
    for bound in [&accessor.min, &accessor.max].into_iter().flatten() {
        if bound.0.len() as u64 != columns * rows
            || bound
                .0
                .iter()
                .any(|value| !component_bound(*value, accessor.component_type))
        {
            return Err(invalid("accessor min/max dimension/value is invalid"));
        }
    }
    if let (Some(min), Some(max)) = (&accessor.min, &accessor.max) {
        if min.0.iter().zip(&max.0).any(|(min, max)| {
            component_precision(*min, accessor.component_type)
                > component_precision(*max, accessor.component_type)
        }) {
            return Err(invalid("accessor min exceeds max"));
        }
    }
    Ok(ModelAccessor {
        buffer_view: view_index,
        byte_offset: accessor.byte_offset,
        range: BinaryChunk {
            offset: absolute_offset,
            bytes,
        },
        component_type: accessor.component_type,
        shape: accessor.shape,
        count: accessor.count,
        normalized: accessor.normalized,
        stride,
        element_bytes,
        min: accessor.min.as_ref().map(|values| values.0.clone()),
        max: accessor.max.as_ref().map(|values| values.0.clone()),
    })
}

fn inspect_primitive(
    primitive: &mut Primitive,
    accessors: &[ModelAccessor],
    views: &[ModelBufferView],
    materials: &[Material],
) -> Result<ModelPrimitive> {
    if primitive.mode.unwrap_or(4) != 4 {
        return Err(unavailable(
            "only TRIANGLES primitives are available in the structure subset",
        ));
    }
    let position_index = primitive
        .attributes
        .0
        .get("POSITION")
        .ok_or_else(|| invalid("primitive requires POSITION"))?;
    let position = at(accessors, *position_index, "primitive POSITION")?;
    if position.component_type != 5126
        || position.shape != AccessorShape::Vec3
        || position.normalized
        || position.min.is_none()
        || position.max.is_none()
    {
        return Err(invalid(
            "POSITION must be an unnormalized FLOAT VEC3 accessor with min/max bounds",
        ));
    }
    for (semantic, index) in &primitive.attributes.0 {
        let accessor = at(accessors, *index, "primitive attribute")?;
        let view = at(views, accessor.buffer_view, "attribute bufferView")?;
        if accessor.count != position.count
            || accessor.byte_offset % 4 != 0
            || accessor.stride % 4 != 0
            || (![5125, 5126].contains(&accessor.component_type) && view.byte_stride.is_none())
            || view.target == Some(34963)
        {
            return Err(invalid(
                "primitive attributes must have equal counts and vertex alignment/target",
            ));
        }
        inspect_semantic(semantic, accessor)?;
        for prefix in ["TEXCOORD_", "COLOR_", "JOINTS_", "WEIGHTS_"] {
            if let Some(suffix) = semantic.strip_prefix(prefix) {
                let index: u32 = suffix.parse().expect("validated semantic index");
                if index > 0
                    && !primitive
                        .attributes
                        .0
                        .contains_key(&format!("{prefix}{}", index - 1))
                {
                    return Err(invalid(
                        "indexed vertex attribute semantics cannot have gaps",
                    ));
                }
            }
        }
        for (prefix, partner) in [("JOINTS_", "WEIGHTS_"), ("WEIGHTS_", "JOINTS_")] {
            if let Some(suffix) = semantic.strip_prefix(prefix) {
                if !primitive
                    .attributes
                    .0
                    .contains_key(&format!("{partner}{suffix}"))
                {
                    return Err(invalid("JOINTS and WEIGHTS sets require matching partners"));
                }
            }
        }
    }
    for target in &primitive.targets.0 {
        for (semantic, index) in &target.0 {
            if !primitive.attributes.0.contains_key(semantic) {
                return Err(invalid(
                    "morph target semantic must exist in base attributes",
                ));
            }
            let accessor = at(accessors, *index, "morph target accessor")?;
            let view = &views[accessor.buffer_view];
            if accessor.count != position.count
                || accessor.byte_offset % 4 != 0
                || accessor.stride % 4 != 0
                || (![5125, 5126].contains(&accessor.component_type) && view.byte_stride.is_none())
                || view.target == Some(34963)
            {
                return Err(invalid(
                    "morph target count or vertex alignment/target is invalid",
                ));
            }
            inspect_morph_semantic(semantic, accessor)?;
        }
    }
    let count = if let Some(index) = primitive.indices.value {
        let accessor = at(accessors, index, "primitive.indices")?;
        let view = at(views, accessor.buffer_view, "indices bufferView")?;
        if accessor.shape != AccessorShape::Scalar
            || ![5121, 5123, 5125].contains(&accessor.component_type)
            || accessor.normalized
            || view.byte_stride.is_some()
            || view.target == Some(34962)
        {
            return Err(invalid(
                "indices require unsigned unnormalized SCALAR without vertex stride/target",
            ));
        }
        accessor.count
    } else {
        position.count
    };
    if count % 3 != 0 {
        return Err(invalid("TRIANGLES primitive count must be divisible by 3"));
    }
    if let Some(index) = primitive.material.value {
        let material = at(materials, index, "primitive.material")?;
        for tex_coord in material_texture_coordinates(material) {
            if !primitive
                .attributes
                .0
                .contains_key(&format!("TEXCOORD_{tex_coord}"))
            {
                return Err(invalid(
                    "material texture requires the corresponding TEXCOORD attribute",
                ));
            }
        }
    }
    Ok(ModelPrimitive {
        // Author totals and view roles were checked before any facts. Later
        // Schema users need only primitive counts/optional presence; the skin
        // owner already holds its bounded author summary. Move these complete
        // maps instead of keeping a second tree and key-string allocation.
        attributes: std::mem::take(&mut primitive.attributes.0),
        targets: {
            let mut targets = Vec::with_capacity(primitive.targets.0.len());
            for target in std::mem::take(&mut primitive.targets.0) {
                targets.push(target.0);
            }
            targets
        },
        indices: primitive.indices.value,
        material: primitive.material.value,
        authored_mode: primitive.mode,
        triangles_upper_bound: count / 3,
    })
}

fn inspect_view_roles(
    document: &Schema,
    accessors: &[ModelAccessor],
    views: &[ModelBufferView],
) -> Result<()> {
    let mut roles = vec![0u8; views.len()];
    let mut vertex_accessors = vec![false; accessors.len()];
    let mut first_vertex = vec![None; views.len()];
    let mut assign = |view: usize, role: u8| -> Result<()> {
        if roles[view] != 0 && roles[view] != role {
            return Err(invalid(
                "bufferView cannot mix vertex, index, animation, or image data roles",
            ));
        }
        roles[view] = role;
        Ok(())
    };
    for mesh in &document.meshes.0 {
        for primitive in &mesh.primitives.0 {
            for index in primitive.attributes.0.values().chain(
                primitive
                    .targets
                    .0
                    .iter()
                    .flat_map(|target| target.0.values()),
            ) {
                let accessor = at(accessors, *index, "primitive attribute")?;
                assign(accessor.buffer_view, 1)?;
                vertex_accessors[*index] = true;
                let first = &mut first_vertex[accessor.buffer_view];
                if first.is_some_and(|first| first != *index)
                    && views[accessor.buffer_view].byte_stride.is_none()
                {
                    return Err(invalid(
                        "multiple vertex accessors sharing a bufferView require byteStride",
                    ));
                }
                first.get_or_insert(*index);
            }
            if let Some(index) = primitive.indices.value {
                assign(at(accessors, index, "primitive.indices")?.buffer_view, 2)?;
            }
        }
    }
    animation::inspect_views(&document.animations.0, accessors, views, &mut assign)?;
    for skin in &document.skins.0 {
        if let Some(index) = skin.inverse_bind_matrices {
            let accessor = at(accessors, index, "skin.inverseBindMatrices")?;
            let view = &views[accessor.buffer_view];
            if view.byte_stride.is_some() || view.target.is_some() {
                return Err(invalid(
                    "inverse bind matrix bufferView cannot define stride or target",
                ));
            }
            assign(accessor.buffer_view, 5)?;
        }
    }
    for image in &document.images.0 {
        if let Some(index) = image.buffer_view {
            at(views, index, "image.bufferView")?;
            assign(index, 3)?;
        }
    }
    for (index, accessor) in accessors.iter().enumerate() {
        if roles[accessor.buffer_view] == 3 {
            return Err(invalid(
                "embedded image bufferView cannot be referenced by any accessor",
            ));
        }
        if !vertex_accessors[index] && views[accessor.buffer_view].byte_stride.is_some() {
            return Err(invalid(
                "non-vertex and unused accessors cannot use byteStride",
            ));
        }
    }
    Ok(())
}

pub(crate) fn component_precision(value: f64, component_type: u32) -> f64 {
    if component_type == 5126 {
        f64::from(value as f32)
    } else {
        value
    }
}

fn component_bound(value: f64, component_type: u32) -> bool {
    if !value.is_finite() {
        return false;
    }
    let range = match component_type {
        5120 => (-128.0, 127.0),
        5121 => (0.0, 255.0),
        5122 => (-32768.0, 32767.0),
        5123 => (0.0, 65535.0),
        5125 => (0.0, 4294967295.0),
        5126 => return (value as f32).is_finite(),
        _ => return false,
    };
    value.fract() == 0.0 && (range.0..=range.1).contains(&value)
}

fn material_texture_coordinates(material: &Material) -> Vec<u32> {
    let mut coordinates = Vec::with_capacity(5);
    if let Some(pbr) = &material.pbr_metallic_roughness {
        for info in [&pbr.base_color_texture, &pbr.metallic_roughness_texture]
            .into_iter()
            .flatten()
        {
            coordinates.push(info.tex_coord);
        }
    }
    if let Some(info) = &material.normal_texture {
        coordinates.push(info.tex_coord);
    }
    if let Some(info) = &material.occlusion_texture {
        coordinates.push(info.tex_coord);
    }
    if let Some(info) = &material.emissive_texture {
        coordinates.push(info.tex_coord);
    }
    coordinates
}

fn inspect_semantic(semantic: &str, accessor: &ModelAccessor) -> Result<()> {
    let float = accessor.component_type == 5126 && !accessor.normalized;
    let color_or_uv =
        float || ([5121, 5123].contains(&accessor.component_type) && accessor.normalized);
    let valid = match semantic {
        "POSITION" | "NORMAL" => float && accessor.shape == AccessorShape::Vec3,
        "TANGENT" => float && accessor.shape == AccessorShape::Vec4,
        name if name.starts_with("TEXCOORD_") && semantic_set(name, "TEXCOORD_") => {
            color_or_uv && accessor.shape == AccessorShape::Vec2
        }
        name if name.starts_with("COLOR_") && semantic_set(name, "COLOR_") => {
            color_or_uv && matches!(accessor.shape, AccessorShape::Vec3 | AccessorShape::Vec4)
        }
        name if semantic_set(name, "JOINTS_") => {
            !accessor.normalized
                && [5121, 5123].contains(&accessor.component_type)
                && accessor.shape == AccessorShape::Vec4
        }
        name if semantic_set(name, "WEIGHTS_") => {
            color_or_uv && accessor.shape == AccessorShape::Vec4
        }
        name if name.starts_with('_') => {
            if accessor.shape.dimensions().0 > 1 {
                return Err(unavailable(
                    "custom matrix vertex attributes require a qualified representation",
                ));
            }
            true
        }
        _ => false,
    };
    if !valid {
        return Err(invalid(format!(
            "attribute {semantic} has invalid semantic/component/type"
        )));
    }
    Ok(())
}
fn semantic_set(name: &str, prefix: &str) -> bool {
    name.strip_prefix(prefix).is_some_and(|suffix| {
        !suffix.is_empty()
            && suffix.len() <= 9
            && suffix.bytes().all(|byte| byte.is_ascii_digit())
            && (suffix == "0" || !suffix.starts_with('0'))
    })
}

fn inspect_morph_semantic(semantic: &str, accessor: &ModelAccessor) -> Result<()> {
    let float = accessor.component_type == 5126 && !accessor.normalized;
    let normalized =
        accessor.normalized && [5120, 5121, 5122, 5123].contains(&accessor.component_type);
    let valid = match semantic {
        "POSITION" => {
            float
                && accessor.shape == AccessorShape::Vec3
                && accessor.min.is_some()
                && accessor.max.is_some()
        }
        "NORMAL" | "TANGENT" => float && accessor.shape == AccessorShape::Vec3,
        name if semantic_set(name, "TEXCOORD_") => {
            (float || normalized) && accessor.shape == AccessorShape::Vec2
        }
        name if semantic_set(name, "COLOR_") => {
            (float || normalized)
                && matches!(accessor.shape, AccessorShape::Vec3 | AccessorShape::Vec4)
        }
        name if name.starts_with("JOINTS_") || name.starts_with("WEIGHTS_") => {
            return Err(invalid(
                "morph targets cannot contain JOINTS or WEIGHTS semantics",
            ));
        }
        name if name.starts_with('_') => return inspect_semantic(name, accessor),
        _ => false,
    };
    if !valid {
        return Err(invalid(format!(
            "morph target {semantic} has invalid semantic/component/type/bounds"
        )));
    }
    Ok(())
}

struct InspectedNodes {
    total_triangles: u64,
    morph_weights: Vec<Option<Vec<f64>>>,
    graph: NodeGraph,
}
struct NodeGraph {
    parents: Vec<Option<usize>>,
}
fn inspect_nodes(document: &Schema, meshes: &[ModelMesh]) -> Result<InspectedNodes> {
    let mut parents = vec![None; document.nodes.0.len()];
    let mut node_morph_weights = Vec::with_capacity(document.nodes.0.len());
    let mut total = 0;
    for (index, node) in document.nodes.0.iter().enumerate() {
        if node.matrix.value.is_some()
            && (node.translation.value.is_some()
                || node.rotation.value.is_some()
                || node.scale.value.is_some())
        {
            return Err(invalid("node matrix and TRS are mutually exclusive"));
        }
        for values in [
            node.matrix.value.as_ref().map(|v| v.as_slice()),
            node.translation.value.as_ref().map(|v| v.as_slice()),
            node.rotation.value.as_ref().map(|v| v.as_slice()),
            node.scale.value.as_ref().map(|v| v.as_slice()),
        ]
        .into_iter()
        .flatten()
        {
            if values.iter().any(|value| !value.is_finite()) {
                return Err(invalid("node transforms must be finite"));
            }
        }
        if node.rotation.value.is_some_and(|rotation| {
            (rotation.iter().map(|value| value * value).sum::<f64>() - 1.0).abs() > 1e-4
        }) {
            return Err(invalid("node rotation quaternion must have unit length"));
        }
        if let Some(matrix) = &node.matrix.value {
            inspect_matrix(matrix)?;
        }
        if let Some(mesh) = node.mesh.value {
            total = triangles(total, at(meshes, mesh, "node.mesh")?.triangles_upper_bound)?;
        }
        let weights = if node.weights.is_some() {
            let mesh = node
                .mesh
                .value
                .ok_or_else(|| invalid("node morph weights require a mesh"))?;
            inspect_weights(
                node.weights.as_ref(),
                at(meshes, mesh, "node.mesh")?.morph_target_count,
            )?
        } else {
            None
        };
        node_morph_weights.push(weights);
        if let Some(camera) = node.camera.value {
            at(&document.cameras.0, camera, "node.camera")?;
        }
        for child in &node.children.0 {
            let parent = parents
                .get_mut(*child)
                .ok_or_else(|| invalid("node child is out of range"))?;
            if parent.replace(index).is_some() {
                return Err(invalid("node has duplicate children or multiple parents"));
            }
        }
    }
    // Iterative root traversal is bounded by the nodes, including unreachable
    // nodes. A closed cycle has no root and therefore fails the visited count.
    let mut pending = Vec::with_capacity(parents.len());
    for (index, parent) in parents.iter().enumerate() {
        if parent.is_none() {
            pending.push(index);
        }
    }
    let mut visited = 0;
    while let Some(index) = pending.pop() {
        visited += 1;
        pending.extend(document.nodes.0[index].children.0.iter().copied());
    }
    if visited != document.nodes.0.len() {
        return Err(invalid("model node graph contains a cycle"));
    }
    for camera in &document.cameras.0 {
        inspect_camera(camera)?;
    }
    Ok(InspectedNodes {
        total_triangles: total,
        morph_weights: node_morph_weights,
        graph: NodeGraph { parents },
    })
}

struct SkinAuthor {
    joints: u64,
    uses: u64,
    bindings: u64,
    pair_consumers: u64,
    mesh_ranges: Vec<MeshSkinRange>,
    pair_primitives: Vec<u32>,
}
#[derive(Clone, Copy)]
#[repr(C)]
struct MeshSkinRange {
    first: u32,
    count: u32,
    pairs: u32,
}
fn skin_structure_limit() -> PackageError {
    PackageError::new(
        "model_structure_limit",
        "skin author totals or graph work exceed the bounded structure limit",
    )
}
fn primitive_pairs(primitive: &Primitive) -> usize {
    primitive
        .attributes
        .0
        .keys()
        .filter(|name| name.starts_with("JOINTS_"))
        .count()
}
fn inspect_skin_author(document: &Schema) -> Result<SkinAuthor> {
    let mut joints = 0_u64;
    for skin in &document.skins.0 {
        joints = joints
            .checked_add(skin.joints.0.len() as u64)
            .ok_or_else(skin_structure_limit)?;
        if joints > MAX_MODEL_RECORDS as u64 {
            return Err(skin_structure_limit());
        }
    }
    let mut pairs = 0_u64;
    let mut entries = 0_u64;
    let mut primitive_total = 0_usize;
    let mut attribute_refs = 0_u64;
    for mesh in &document.meshes.0 {
        primitive_total = primitive_total
            .checked_add(mesh.primitives.0.len())
            .ok_or_else(skin_structure_limit)?;
        if primitive_total > MAX_MODEL_RECORDS {
            return Err(skin_structure_limit());
        }
        for primitive in &mesh.primitives.0 {
            attribute_refs = attribute_refs
                .checked_add(primitive.attributes.0.len() as u64)
                .ok_or_else(skin_structure_limit)?;
            let count = primitive_pairs(primitive) as u64;
            pairs = pairs.checked_add(count).ok_or_else(skin_structure_limit)?;
            entries = entries
                .checked_add(u64::from(count != 0))
                .ok_or_else(skin_structure_limit)?;
            if pairs > MAX_MODEL_RECORDS as u64 {
                return Err(skin_structure_limit());
            }
        }
    }
    pairs.checked_mul(2).ok_or_else(skin_structure_limit)?;
    let mut uses = 0_u64;
    for node in &document.nodes.0 {
        if let Some(skin) = node.skin {
            at(&document.skins.0, skin, "node.skin")?;
            let mesh = node
                .mesh
                .value
                .ok_or_else(|| invalid("node.skin requires a mesh"))?;
            at(&document.meshes.0, mesh, "node.skin mesh")?;
            uses = uses.checked_add(1).ok_or_else(skin_structure_limit)?;
            if uses > MAX_MODEL_RECORDS as u64 {
                return Err(skin_structure_limit());
            }
        }
    }
    if uses == 0 {
        return Ok(SkinAuthor {
            joints,
            uses,
            bindings: 0,
            pair_consumers: 0,
            mesh_ranges: Vec::new(),
            pair_primitives: Vec::new(),
        });
    }
    // Separate bounded author preprocessing, not graph or numeric work:
    // two attribute/primitive passes, mesh ranges, and two node-use passes.
    let summary_work = attribute_refs
        .checked_mul(2)
        .and_then(|n| {
            (primitive_total as u64)
                .checked_mul(2)
                .and_then(|p| n.checked_add(p))
        })
        .and_then(|n| n.checked_add(document.meshes.0.len() as u64))
        .and_then(|n| {
            (document.nodes.0.len() as u64)
                .checked_mul(2)
                .and_then(|u| n.checked_add(u))
        })
        .ok_or_else(skin_structure_limit)?;
    if summary_work > 67_108_864 {
        return Err(skin_structure_limit());
    }
    // Admission precedes this bounded author summary. It prevents a mixed mesh
    // with many ordinary primitives from multiplying scans for every node use.
    let mut mesh_ranges = Vec::new();
    let mut pair_primitives = Vec::new();
    mesh_ranges
        .try_reserve_exact(document.meshes.0.len())
        .map_err(|_| skin_structure_limit())?;
    pair_primitives
        .try_reserve_exact(usize::try_from(entries).map_err(|_| skin_structure_limit())?)
        .map_err(|_| skin_structure_limit())?;
    let summary_bytes = mesh_ranges
        .capacity()
        .checked_mul(std::mem::size_of::<MeshSkinRange>())
        .and_then(|n| {
            pair_primitives
                .capacity()
                .checked_mul(std::mem::size_of::<u32>())
                .and_then(|p| n.checked_add(p))
        })
        .ok_or_else(skin_structure_limit)?;
    if summary_bytes > MAX_MODEL_NODES * 12 + MAX_MODEL_RECORDS * 4 {
        return Err(skin_structure_limit());
    }
    for mesh in &document.meshes.0 {
        let first = u32::try_from(pair_primitives.len()).map_err(|_| skin_structure_limit())?;
        let mut pairs = 0_u32;
        for (index, primitive) in mesh.primitives.0.iter().enumerate() {
            let count =
                u32::try_from(primitive_pairs(primitive)).map_err(|_| skin_structure_limit())?;
            pairs = pairs.checked_add(count).ok_or_else(skin_structure_limit)?;
            if count != 0 {
                pair_primitives.push(u32::try_from(index).map_err(|_| skin_structure_limit())?);
            }
        }
        mesh_ranges.push(MeshSkinRange {
            first,
            count: u32::try_from(pair_primitives.len())
                .map_err(|_| skin_structure_limit())?
                .checked_sub(first)
                .ok_or_else(skin_structure_limit)?,
            pairs,
        });
    }
    let mut result = SkinAuthor {
        joints,
        uses,
        bindings: 0,
        pair_consumers: 0,
        mesh_ranges,
        pair_primitives,
    };
    for node in &document.nodes.0 {
        if node.skin.is_some() {
            let summary = result.mesh_ranges[node.mesh.value.expect("skin mesh validated")];
            let pairs = u64::from(summary.pairs);
            let bindings = u64::from(summary.count);
            result.bindings = result
                .bindings
                .checked_add(bindings)
                .ok_or_else(skin_structure_limit)?;
            result.pair_consumers = result
                .pair_consumers
                .checked_add(pairs)
                .ok_or_else(skin_structure_limit)?;
            if result.uses > MAX_MODEL_RECORDS as u64
                || result.bindings > MAX_MODEL_RECORDS as u64
                || result.pair_consumers > (MAX_MODEL_RECORDS as u64) * 15
            {
                return Err(skin_structure_limit());
            }
        }
    }
    Ok(result)
}

struct SkinGraph {
    roots: Vec<usize>,
    depths: Vec<usize>,
    tin: Vec<usize>,
    tout: Vec<usize>,
    ancestors: Vec<[usize; 13]>,
}
impl SkinGraph {
    fn new(document: &Schema, parents: &[Option<usize>]) -> Result<Self> {
        let n = parents.len();
        let bytes = n
            .checked_mul(13)
            .and_then(|n| n.checked_mul(std::mem::size_of::<usize>()))
            .ok_or_else(skin_structure_limit)?;
        if bytes > 520_000 {
            return Err(skin_structure_limit());
        }
        let mut graph = Self {
            roots: vec![0; n],
            depths: vec![0; n],
            tin: vec![0; n],
            tout: vec![0; n],
            ancestors: vec![[0; 13]; n],
        };
        let mut pending = Vec::with_capacity(n.checked_mul(2).ok_or_else(skin_structure_limit)?);
        for (index, parent) in parents.iter().enumerate() {
            if parent.is_none() {
                pending.push((index, false));
            }
        }
        let mut clock = 0;
        while let Some((index, exit)) = pending.pop() {
            if exit {
                graph.tout[index] = clock;
                continue;
            }
            graph.tin[index] = clock;
            clock += 1;
            let parent = parents[index].unwrap_or(index);
            graph.roots[index] = if parent == index {
                index
            } else {
                graph.roots[parent]
            };
            graph.depths[index] = if parent == index {
                0
            } else {
                graph.depths[parent] + 1
            };
            graph.ancestors[index][0] = parent;
            for level in 1..13 {
                graph.ancestors[index][level] =
                    graph.ancestors[graph.ancestors[index][level - 1]][level - 1];
            }
            pending.push((index, true));
            for &child in &document.nodes.0[index].children.0 {
                pending.push((child, false));
            }
        }
        Ok(graph)
    }
    fn ancestor(&self, ancestor: usize, node: usize) -> bool {
        self.roots[ancestor] == self.roots[node]
            && self.tin[ancestor] <= self.tin[node]
            && self.tout[node] <= self.tout[ancestor]
    }
    fn lca(&self, mut left: usize, mut right: usize) -> usize {
        if self.depths[left] < self.depths[right] {
            std::mem::swap(&mut left, &mut right);
        }
        let difference = self.depths[left] - self.depths[right];
        for level in 0..13 {
            if difference & (1 << level) != 0 {
                left = self.ancestors[left][level];
            }
        }
        if left == right {
            return left;
        }
        for level in (0..13).rev() {
            if self.ancestors[left][level] != self.ancestors[right][level] {
                left = self.ancestors[left][level];
                right = self.ancestors[right][level];
            }
        }
        self.ancestors[left][0]
    }
}
fn inspect_scenes(
    document: &Schema,
    parents: &[Option<usize>],
    relations: &[(usize, usize)],
) -> Result<()> {
    if document
        .scene
        .value
        .is_some_and(|index| index >= document.scenes.0.len())
    {
        return Err(invalid("default scene is out of range"));
    }
    let mut seen = vec![false; parents.len()];
    for scene in &document.scenes.0 {
        seen.fill(false);
        for &root in &scene.nodes.0 {
            if at(parents, root, "scene root")?.is_some() || seen[root] {
                return Err(invalid("scene roots must be distinct parentless nodes"));
            }
            seen[root] = true;
        }
        for &(node_root, joint_root) in relations {
            if seen[node_root] && !seen[joint_root] {
                return Err(invalid(
                    "skin common root must belong to every scene containing its node",
                ));
            }
        }
    }
    Ok(())
}
fn inspect_skins(
    document: &Schema,
    accessors: &[ModelAccessor],
    nodes: &NodeGraph,
    author: &SkinAuthor,
) -> Result<(Vec<ModelSkin>, Vec<ModelSkinBinding>)> {
    if document.skins.0.is_empty() {
        inspect_scenes(document, &nodes.parents, &[])?;
        return Ok((Vec::new(), Vec::new()));
    }
    let base_work = checked_add(
        checked_add(
            checked_add(
                checked_mul(15, nodes.parents.len() as u64)?,
                checked_mul(26, author.joints)?,
            )?,
            author.uses,
        )?,
        author.bindings,
    )?;
    if base_work > 67_108_864 {
        return Err(skin_structure_limit());
    }
    let graph = SkinGraph::new(document, &nodes.parents)?;
    let mut generations = vec![0_u32; nodes.parents.len()];
    let mut skins = Vec::with_capacity(document.skins.0.len());
    for (index, skin) in document.skins.0.iter().enumerate() {
        let generation = u32::try_from(index + 1).map_err(|_| skin_structure_limit())?;
        let first = *skin.joints.0.first().expect("nonempty skin joints");
        at(&document.nodes.0, first, "skin joint")?;
        let mut common_root = first;
        for &joint in &skin.joints.0 {
            at(&document.nodes.0, joint, "skin joint")?;
            if generations[joint] == generation {
                return Err(invalid("skin contains duplicate joints"));
            }
            generations[joint] = generation;
            if graph.roots[joint] != graph.roots[first] {
                return Err(invalid("skin joints must share a common ancestor"));
            }
            common_root = graph.lca(common_root, joint);
        }
        if let Some(skeleton) = skin.skeleton {
            at(&document.nodes.0, skeleton, "skin.skeleton")?;
            if !graph.ancestor(skeleton, common_root) {
                return Err(invalid("skin skeleton must be an ancestor of all joints"));
            }
        }
        if let Some(ibm) = skin.inverse_bind_matrices {
            let accessor = at(accessors, ibm, "skin.inverseBindMatrices")?;
            if accessor.component_type != 5126
                || accessor.normalized
                || accessor.shape != AccessorShape::Mat4
                || accessor.count < skin.joints.0.len() as u64
            {
                return Err(invalid("inverse bind matrices require unnormalized FLOAT MAT4 and at least one matrix per joint"));
            }
        }
        skins.push(ModelSkin {
            joints: skin.joints.0.clone(),
            skeleton: skin.skeleton,
            inverse_bind_matrices: skin.inverse_bind_matrices,
            common_root,
        });
    }
    let mut cross = 0_u64;
    for (index, node) in document.nodes.0.iter().enumerate() {
        if let Some(skin) = node.skin {
            cross += u64::from(graph.roots[index] != graph.roots[skins[skin].common_root]);
        }
    }
    let work = checked_add(
        base_work,
        checked_add(
            checked_mul(cross, cross.saturating_sub(1))?,
            checked_mul(document.scenes.0.len() as u64, cross)?,
        )?,
    )?;
    if work > 67_108_864 {
        return Err(skin_structure_limit());
    }
    let mut relations =
        Vec::with_capacity(usize::try_from(cross).map_err(|_| skin_structure_limit())?);
    let mut bindings =
        Vec::with_capacity(usize::try_from(author.bindings).map_err(|_| skin_structure_limit())?);
    for (index, node) in document.nodes.0.iter().enumerate() {
        if let Some(skin) = node.skin {
            let relation = (graph.roots[index], graph.roots[skins[skin].common_root]);
            if relation.0 != relation.1 && !relations.contains(&relation) {
                relations.push(relation);
            }
            let mesh = node.mesh.value.expect("skin author mesh checked");
            let range = author.mesh_ranges[mesh];
            let end = range
                .first
                .checked_add(range.count)
                .ok_or_else(skin_structure_limit)?;
            for &primitive in &author.pair_primitives[range.first as usize..end as usize] {
                bindings.push(ModelSkinBinding {
                    mesh,
                    primitive: primitive as usize,
                    skin,
                });
            }
        }
    }
    inspect_scenes(document, &nodes.parents, &relations)?;
    Ok((skins, bindings))
}

fn inspect_matrix(matrix: &[f64; 16]) -> Result<()> {
    if [matrix[3], matrix[7], matrix[11], matrix[15]] != [0.0, 0.0, 0.0, 1.0] {
        return Err(invalid("node matrix must be an affine TRS transform"));
    }
    let mut columns = [[0.0; 3]; 3];
    for (index, column) in columns.iter_mut().enumerate() {
        let values = [
            matrix[index * 4],
            matrix[index * 4 + 1],
            matrix[index * 4 + 2],
        ];
        // Normalize with the largest component first to avoid intermediate
        // overflow/underflow from finite author-provided scales.
        let largest = values.iter().map(|value| value.abs()).fold(0.0, f64::max);
        if largest == 0.0 {
            return Err(invalid("node matrix cannot contain a zero scale column"));
        }
        let scaled = values.map(|value| value / largest);
        let length = scaled.iter().map(|value| value * value).sum::<f64>().sqrt();
        *column = scaled.map(|value| value / length);
    }
    let [a, b, c] = columns;
    for (left, right) in [(a, b), (a, c), (b, c)] {
        let dot = left
            .iter()
            .zip(right)
            .map(|(left, right)| left * right)
            .sum::<f64>();
        if dot.abs() > 1e-4 {
            return Err(invalid(
                "node matrix columns must be orthogonal without shear",
            ));
        }
    }
    let determinant = a[0] * (b[1] * c[2] - b[2] * c[1]) - b[0] * (a[1] * c[2] - a[2] * c[1])
        + c[0] * (a[1] * b[2] - a[2] * b[1]);
    if (determinant.abs() - 1.0).abs() > 1e-4 {
        return Err(invalid(
            "node matrix must be decomposable to TRS without shear",
        ));
    }
    Ok(())
}

fn inspect_images(
    images: &[Image],
    views: &[ModelBufferView],
    manifest: &Manifest,
    model_path: &str,
) -> Result<Vec<ModelImage>> {
    let mut result = Vec::with_capacity(images.len());
    let mut aliases: BTreeMap<String, Arc<[PackageImageRef]>> = BTreeMap::new();
    for image in images {
        match (&image.uri, image.buffer_view) {
            (Some(uri), None) => {
                validate_rel_path(uri).map_err(|_| {
                    unavailable("image URI must be an unencoded package relative path")
                })?;
                let path = model_path.rsplit_once('/').map_or_else(
                    || uri.clone(),
                    |(directory, _)| format!("{directory}/{uri}"),
                );
                validate_rel_path(&path)
                    .map_err(|_| unavailable("resolved image path exceeds package path rules"))?;
                let file = manifest
                    .file(&path)
                    .ok_or_else(|| invalid("image URI references an undeclared package file"))?;
                image_mime(&file.mime)?;
                if image
                    .mime_type
                    .as_ref()
                    .is_some_and(|mime| mime != &file.mime)
                {
                    return Err(invalid(
                        "image mimeType does not match the package file MIME",
                    ));
                }
                let references = if let Some(references) = aliases.get(&path) {
                    Arc::clone(references)
                } else {
                    // Count on the same immutable manifest; all matching
                    // source/variant records belong to this one path. No
                    // amortized grow or Vec-to-Arc shrink is needed.
                    let count = manifest
                        .assets
                        .iter()
                        .filter(|asset| matches!(asset.kind, AssetKind::Image | AssetKind::Texture))
                        .try_fold(0usize, |count, asset| {
                            count
                                .checked_add(usize::from(asset.source == path))
                                .and_then(|count| {
                                    count.checked_add(
                                        asset
                                            .variants
                                            .iter()
                                            .filter(|variant| variant.file == path)
                                            .count(),
                                    )
                                })
                                .ok_or_else(|| invalid("image reference count overflow"))
                        })?;
                    let mut references = Vec::with_capacity(count);
                    for asset in &manifest.assets {
                        if !matches!(asset.kind, AssetKind::Image | AssetKind::Texture) {
                            continue;
                        }
                        if asset.source == path {
                            references.push(PackageImageRef {
                                asset_id: asset.id.clone(),
                                variant_id: None,
                            });
                        }
                        for variant in &asset.variants {
                            if variant.file == path {
                                references.push(PackageImageRef {
                                    asset_id: asset.id.clone(),
                                    variant_id: Some(variant.id.clone()),
                                });
                            }
                        }
                    }
                    if references.is_empty() {
                        return Err(invalid(
                            "image URI must resolve to an Image/Texture asset source or variant",
                        ));
                    }
                    let references: Arc<[PackageImageRef]> = references.into();
                    aliases.insert(path.clone(), Arc::clone(&references));
                    references
                };
                result.push(ModelImage::Package {
                    path,
                    mime: file.mime.clone(),
                    bytes: file.bytes,
                    sha256: file.sha256.clone(),
                    references,
                });
            }
            (None, Some(index)) => {
                let view = at(views, index, "image.bufferView")?;
                let mime = image
                    .mime_type
                    .as_deref()
                    .ok_or_else(|| invalid("embedded image requires mimeType"))?;
                image_mime(mime)?;
                if view.byte_stride.is_some() || view.target.is_some() {
                    return Err(invalid(
                        "embedded image view must not have an accessor stride/target",
                    ));
                }
                result.push(ModelImage::Embedded {
                    buffer_view: index,
                    range: view.range.clone(),
                    mime: mime.to_owned(),
                });
            }
            _ => return Err(invalid("image requires exactly one URI or bufferView")),
        }
    }
    Ok(result)
}
fn image_mime(mime: &str) -> Result<()> {
    if !["image/png", "image/jpeg"].contains(&mime) {
        return Err(unavailable(
            "core glTF images require JPEG/PNG; other codecs require qualified extensions",
        ));
    }
    Ok(())
}

fn unit(values: &[f64], role: &str) -> Result<()> {
    if values
        .iter()
        .any(|value| !value.is_finite() || !(0.0..=1.0).contains(value))
    {
        return Err(invalid(format!("{role} must be finite within 0..1")));
    }
    Ok(())
}
fn inspect_materials(document: &Schema) -> Result<()> {
    for texture in &document.textures.0 {
        let source = texture
            .source
            .ok_or_else(|| invalid("texture requires a core image source"))?;
        at(&document.images.0, source, "texture.source")?;
        if let Some(sampler) = texture.sampler {
            at(&document.samplers.0, sampler, "texture.sampler")?;
        }
    }
    for sampler in &document.samplers.0 {
        if sampler
            .mag_filter
            .is_some_and(|value| ![9728, 9729].contains(&value))
            || sampler
                .min_filter
                .is_some_and(|value| ![9728, 9729, 9984, 9985, 9986, 9987].contains(&value))
            || ![33071, 33648, 10497].contains(&sampler.wrap_s)
            || ![33071, 33648, 10497].contains(&sampler.wrap_t)
        {
            return Err(invalid("sampler filter/wrap is not legal glTF"));
        }
    }
    let texture_info = |info: &TextureInfo| -> Result<()> {
        at(&document.textures.0, info.index, "material texture")?;
        Ok(())
    };
    for material in &document.materials.0 {
        if let Some(pbr) = &material.pbr_metallic_roughness {
            unit(&pbr.base_color_factor, "baseColorFactor")?;
            unit(&[pbr.metallic_factor, pbr.roughness_factor], "PBR factors")?;
            for info in [&pbr.base_color_texture, &pbr.metallic_roughness_texture]
                .into_iter()
                .flatten()
            {
                texture_info(info)?;
            }
        }
        unit(&material.emissive_factor, "emissiveFactor")?;
        if material.alpha_cutoff < 0.0 || !material.alpha_cutoff.is_finite() {
            return Err(invalid("alphaCutoff must be finite and nonnegative"));
        }
        if let Some(info) = &material.emissive_texture {
            texture_info(info)?;
        }
        if let Some(info) = &material.normal_texture {
            at(&document.textures.0, info.index, "normal texture")?;
            if !info.scale.is_finite() {
                return Err(invalid("normal scale must be finite"));
            }
        }
        if let Some(info) = &material.occlusion_texture {
            at(&document.textures.0, info.index, "occlusion texture")?;
            unit(&[info.strength], "occlusion strength")?;
        }
    }
    Ok(())
}
fn inspect_camera(camera: &Camera) -> Result<()> {
    match (&camera.kind, &camera.perspective, &camera.orthographic) {
        (CameraKind::Perspective, Some(p), None)
            if p.yfov.is_finite()
                && p.yfov > 0.0
                && p.yfov < std::f64::consts::PI
                && p.znear.is_finite()
                && p.znear > 0.0
                && p.aspect_ratio.is_none_or(|v| v.is_finite() && v > 0.0)
                && p.zfar.is_none_or(|v| v.is_finite() && v > p.znear) =>
        {
            Ok(())
        }
        (CameraKind::Orthographic, None, Some(p))
            if [p.xmag, p.ymag, p.znear, p.zfar]
                .iter()
                .all(|v| v.is_finite())
                && p.xmag != 0.0
                && p.ymag != 0.0
                && p.znear >= 0.0
                && p.zfar > p.znear =>
        {
            Ok(())
        }
        _ => Err(invalid("camera projection/type/range is not legal glTF")),
    }
}

// Limit before deserializing the next element; an excessive element is never
// materialized, even if it contains a large object. Unknown fields also fail
// rather than silently creating a new dependency path for a future loader.
struct Limited<T, const N: usize>(Vec<T>);
impl<T, const N: usize> Default for Limited<T, N> {
    fn default() -> Self {
        Self(Vec::new())
    }
}
struct Excess;
impl<'de> DeserializeSeed<'de> for Excess {
    type Value = ();
    fn deserialize<D: Deserializer<'de>>(self, _: D) -> std::result::Result<(), D::Error> {
        Err(de::Error::custom(
            "model_structure_limit: bounded array/map exceeded",
        ))
    }
}
impl<'de, T: Deserialize<'de>, const N: usize> Deserialize<'de> for Limited<T, N> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct Items<T, const N: usize>(PhantomData<T>);
        impl<'de, T: Deserialize<'de>, const N: usize> Visitor<'de> for Items<T, N> {
            type Value = Limited<T, N>;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                write!(formatter, "array of at most {N} elements")
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while values.len() < N {
                    match seq.next_element()? {
                        Some(value) => {
                            if values.len() == values.capacity() {
                                // Global's exact RawVec request, not its default
                                // minimum-four amortized allocation. A decoded
                                // current item stays on the stack during grow.
                                let capacity = values.capacity().saturating_mul(2).max(1).min(N);
                                values.try_reserve_exact(capacity - values.len()).map_err(
                                    |_| {
                                        de::Error::custom(
                                            "model_structure_limit: array allocation failed",
                                        )
                                    },
                                )?;
                                if values.capacity() != capacity {
                                    return Err(de::Error::custom(
                                        "model_structure_limit: unexpected array capacity",
                                    ));
                                }
                            }
                            values.push(value);
                        }
                        None => return Ok(Limited(values)),
                    }
                }
                seq.next_element_seed(Excess)?;
                Ok(Limited(values))
            }
        }
        deserializer.deserialize_seq(Items::<T, N>(PhantomData))
    }
}
struct Attributes(BTreeMap<String, usize>);
fn nonempty_targets<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Limited<Attributes, MAX_MODEL_RECORDS>, D::Error> {
    let targets = Limited::deserialize(deserializer)?;
    if targets.0.is_empty() {
        return Err(de::Error::custom("targets must be nonempty when present"));
    }
    Ok(targets)
}
fn author_weights<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Limited<f64, MAX_MODEL_RECORDS>>, D::Error> {
    let values = Limited::deserialize(deserializer)?;
    if values.0.is_empty() {
        return Err(de::Error::custom("weights must be nonempty when present"));
    }
    Ok(Some(values))
}
impl<'de> Deserialize<'de> for Attributes {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct Attrs;
        impl<'de> Visitor<'de> for Attrs {
            type Value = Attributes;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("bounded accessor attribute map")
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut values = BTreeMap::new();
                for _ in 0..MAX_MODEL_ATTRIBUTES {
                    let Some(key) = map.next_key::<String>()? else {
                        return Ok(Attributes(values));
                    };
                    if key.len() > 64 {
                        return Err(de::Error::custom(
                            "model_structure_limit: attribute name exceeds 64 bytes",
                        ));
                    }
                    if values.contains_key(&key) {
                        return Err(de::Error::custom("duplicate attribute semantic"));
                    }
                    values.insert(key, map.next_value()?);
                }
                map.next_key_seed(Excess)?;
                Ok(Attributes(values))
            }
        }
        deserializer.deserialize_map(Attrs)
    }
}
#[derive(Default)]
struct Pending;
impl<'de> Deserialize<'de> for Pending {
    fn deserialize<D: Deserializer<'de>>(_: D) -> std::result::Result<Self, D::Error> {
        Err(de::Error::custom(
            "model_resource_unavailable: extension/sparse content is pending validation",
        ))
    }
}

/// Missing and explicit null share their legacy Option value, but only the
/// latter is an authored property rejected by the later static loader profile.
struct AuthoredOptional<T> {
    present: bool,
    value: Option<T>,
}
impl<T> Default for AuthoredOptional<T> {
    fn default() -> Self {
        Self {
            present: false,
            value: None,
        }
    }
}
impl<T> AuthoredOptional<T> {
    fn is_null(&self) -> bool {
        self.present && self.value.is_none()
    }
}
// The existing private animation inspector only needs the legacy Option view.
impl<T> std::ops::Deref for AuthoredOptional<T> {
    type Target = Option<T>;
    fn deref(&self) -> &Self::Target {
        &self.value
    }
}
impl<'de, T: Deserialize<'de>> Deserialize<'de> for AuthoredOptional<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        Ok(Self {
            present: true,
            value: Option::deserialize(deserializer)?,
        })
    }
}

// These are private preflight schemas, not runtime scene representations.
macro_rules! schema {
    ($name:ident { $($fields:tt)* }) => {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields,rename_all="camelCase")]
        struct $name {
            $($fields)*
            #[serde(default,rename="extensions")] _extensions: Pending,
            #[serde(default,rename="extras")] _extras: $crate::model_structure::metadata::Extras,
        }
    };
}
macro_rules! named_schema {
    ($name:ident { $($fields:tt)* }) => {
        schema!($name {
            $($fields)*
            #[serde(default,rename="name")] _name: Option<String>,
        });
    };
}
mod animation;
mod heap_bounds;
mod metadata;

schema!(Schema {
    #[serde(rename="asset")] _asset: AssetHeader,
    #[serde(default)] buffers: Limited<Buffer,MAX_MODEL_RECORDS>,
    #[serde(default)] buffer_views: Limited<BufferView,MAX_MODEL_RECORDS>,
    #[serde(default)] accessors: Limited<Accessor,MAX_MODEL_RECORDS>,
    #[serde(default)] meshes: Limited<Mesh,MAX_MODEL_NODES>,
    #[serde(default)] nodes: Limited<Node,MAX_MODEL_NODES>,
    #[serde(default)] scenes: Limited<Scene,MAX_MODEL_NODES>,
    #[serde(default)] scene: AuthoredOptional<usize>,
    #[serde(default)] images: Limited<Image,MAX_MODEL_IMAGE_RECORDS>,
    #[serde(default)] textures: Limited<Texture,MAX_MODEL_IMAGE_RECORDS>,
    #[serde(default)] samplers: Limited<Sampler,MAX_MODEL_IMAGE_RECORDS>,
    #[serde(default)] materials: Limited<Material,MAX_MODEL_IMAGE_RECORDS>,
    #[serde(default)] cameras: Limited<Camera,MAX_MODEL_NODES>,
    #[serde(default)] extensions_used: Limited<String,MAX_MODEL_IMAGE_RECORDS>,
    #[serde(default)] extensions_required: Limited<String,MAX_MODEL_IMAGE_RECORDS>,
    #[serde(default,deserialize_with="animation::nonempty_animations")] animations: Limited<animation::Animation,MAX_MODEL_ANIMATIONS>,
    #[serde(default,deserialize_with="nonempty_skins")] skins: Limited<Skin,MAX_MODEL_RECORDS>,
});
schema!(AssetHeader {
    #[serde(rename="version")] _version:String,
    #[serde(default,rename="minVersion")] _min_version:Option<String>,
    #[serde(default,rename="generator")] _generator:Option<String>,
    #[serde(default,rename="copyright")] _copyright:Option<String>,
});
named_schema!(Buffer { byte_length:u64, #[serde(default)] uri:AuthoredOptional<String>, });
named_schema!(BufferView {
    buffer:usize, #[serde(default)] byte_offset:u64, byte_length:u64,
    #[serde(default)] byte_stride:AuthoredOptional<u64>, #[serde(default)] target:Option<u32>,
});
named_schema!(Accessor {
    #[serde(default)] buffer_view:Option<usize>, #[serde(default)] byte_offset:u64,
    component_type:u32, #[serde(default)] normalized:bool, count:u64,
    #[serde(rename="type")] shape:AccessorShape,
    #[serde(default)] min:Option<Limited<f64,16>>, #[serde(default)] max:Option<Limited<f64,16>>,
    #[serde(default,rename="sparse")] _sparse:Pending,
});
named_schema!(Mesh {
    primitives:Limited<Primitive,MAX_MODEL_RECORDS>,
    #[serde(default,deserialize_with="author_weights")] weights:Option<Limited<f64,MAX_MODEL_RECORDS>>,
});
schema!(Primitive {
    attributes:Attributes, #[serde(default)] indices:AuthoredOptional<usize>,
    #[serde(default)] material:AuthoredOptional<usize>, #[serde(default,deserialize_with="optional_mode")] mode:Option<u32>,
    #[serde(default,deserialize_with="nonempty_targets")] targets:Limited<Attributes,MAX_MODEL_RECORDS>,
});
fn optional_mode<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<u32>, D::Error> {
    u32::deserialize(deserializer).map(Some)
}
named_schema!(Node {
    #[serde(default)] children:Limited<usize,MAX_MODEL_NODES>,
    #[serde(default)] mesh:AuthoredOptional<usize>, #[serde(default)] camera:AuthoredOptional<usize>,
    #[serde(default)] matrix:AuthoredOptional<[f64;16]>, #[serde(default)] translation:AuthoredOptional<[f64;3]>,
    #[serde(default)] rotation:AuthoredOptional<[f64;4]>, #[serde(default)] scale:AuthoredOptional<[f64;3]>,
    #[serde(default,deserialize_with="optional_index")] skin:Option<usize>,
    #[serde(default,deserialize_with="author_weights")] weights:Option<Limited<f64,MAX_MODEL_RECORDS>>,
});
named_schema!(Scene { #[serde(default)] nodes:Limited<usize,MAX_MODEL_NODES>, });
named_schema!(Skin {
    #[serde(deserialize_with="nonempty_joints")] joints:Limited<usize,MAX_MODEL_NODES>,
    #[serde(default,deserialize_with="optional_index")] skeleton:Option<usize>,
    #[serde(default,deserialize_with="optional_index")] inverse_bind_matrices:Option<usize>,
});
fn optional_index<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<usize>, D::Error> {
    usize::deserialize(deserializer).map(Some)
}
fn nonempty_skins<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Limited<Skin, MAX_MODEL_RECORDS>, D::Error> {
    let value = Limited::deserialize(deserializer)?;
    if value.0.is_empty() {
        return Err(de::Error::custom("skins must be nonempty when present"));
    }
    Ok(value)
}
fn nonempty_joints<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Limited<usize, MAX_MODEL_NODES>, D::Error> {
    let value = Limited::deserialize(deserializer)?;
    if value.0.is_empty() {
        return Err(de::Error::custom("skin joints must be nonempty"));
    }
    Ok(value)
}
named_schema!(Image {
    #[serde(default)] uri:Option<String>, #[serde(default)] buffer_view:Option<usize>,
    #[serde(default)] mime_type:Option<String>,
});
named_schema!(Texture { #[serde(default)] source:Option<usize>, #[serde(default)] sampler:Option<usize>, });
named_schema!(Sampler {
    #[serde(default)] mag_filter:Option<u32>, #[serde(default)] min_filter:Option<u32>,
    #[serde(default="repeat_wrap")] wrap_s:u32, #[serde(default="repeat_wrap")] wrap_t:u32,
});
fn repeat_wrap() -> u32 {
    10497
}
named_schema!(Material {
    #[serde(default)] pbr_metallic_roughness:Option<Pbr>,
    #[serde(default)] normal_texture:Option<NormalTexture>,
    #[serde(default)] occlusion_texture:Option<OcclusionTexture>,
    #[serde(default)] emissive_texture:Option<TextureInfo>,
    #[serde(default)] emissive_factor:[f64;3],
    #[serde(default,rename="alphaMode")] _alpha_mode:AlphaMode,
    #[serde(default="half")] alpha_cutoff:f64,
    #[serde(default,rename="doubleSided")] _double_sided:bool,
});
#[derive(Default, Deserialize)]
enum AlphaMode {
    #[default]
    #[serde(rename = "OPAQUE")]
    Opaque,
    #[serde(rename = "MASK")]
    Mask,
    #[serde(rename = "BLEND")]
    Blend,
}
schema!(Pbr {
    #[serde(default="white")] base_color_factor:[f64;4],
    #[serde(default)] base_color_texture:Option<TextureInfo>,
    #[serde(default="one")] metallic_factor:f64, #[serde(default="one")] roughness_factor:f64,
    #[serde(default)] metallic_roughness_texture:Option<TextureInfo>,
});
fn white() -> [f64; 4] {
    [1.0; 4]
}
fn one() -> f64 {
    1.0
}
fn half() -> f64 {
    0.5
}
schema!(TextureInfo {
    index: usize,
    #[serde(default)]
    tex_coord: u32,
});
schema!(NormalTexture {
    index: usize,
    #[serde(default)]
    tex_coord: u32,
    #[serde(default = "one")]
    scale: f64,
});
schema!(OcclusionTexture {
    index: usize,
    #[serde(default)]
    tex_coord: u32,
    #[serde(default = "one")]
    strength: f64,
});
named_schema!(Camera {
    #[serde(rename="type")] kind:CameraKind,
    #[serde(default)] orthographic:Option<Orthographic>, #[serde(default)] perspective:Option<Perspective>,
});
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum CameraKind {
    Orthographic,
    Perspective,
}
schema!(Perspective { #[serde(default)] aspect_ratio:Option<f64>, yfov:f64, znear:f64, #[serde(default)] zfar:Option<f64>, });
schema!(Orthographic {
    xmag: f64,
    ymag: f64,
    znear: f64,
    zfar: f64,
});
