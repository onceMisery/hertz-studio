// SPDX-License-Identifier: MIT
//! Bounded glTF structure and package dependency checks, after the sole GLB
//! container inspector. These facts do not establish binary or GPU validity.

use std::{collections::BTreeMap, fmt, io::Read, marker::PhantomData, sync::Arc};

use serde::{
    de::{self, DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor},
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
    pub indices: Option<usize>,
    pub material: Option<usize>,
    pub triangles_upper_bound: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelMesh {
    pub primitives: Vec<ModelPrimitive>,
    pub triangles_upper_bound: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModelStructure {
    pub buffer_views: Vec<ModelBufferView>,
    pub accessors: Vec<ModelAccessor>,
    pub meshes: Vec<ModelMesh>,
    pub images: Vec<ModelImage>,
    pub animations: Vec<ModelAnimation>,
    pub node_count: usize,
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
    validate_rel_path(path).map_err(|error| invalid(error.message))?;
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
    validate_rel_path(path).map_err(|error| invalid(error.message))?;
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
    document: Schema,
    container: &GlbContainer,
    manifest: &Manifest,
    path: &str,
) -> Result<ModelStructure> {
    if !document.extensions_used.0.is_empty() || !document.extensions_required.0.is_empty() {
        return Err(unavailable(
            "model extensions require a qualified content adapter",
        ));
    }
    for buffer in &document.buffers.0 {
        if buffer.uri.is_some() {
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
        if view.byte_stride.is_some_and(|stride| {
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
            byte_stride: view.byte_stride,
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
    for mesh in &document.meshes.0 {
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
            triangles_upper_bound: 0,
        };
        for primitive in &mesh.primitives.0 {
            let fact =
                inspect_primitive(primitive, &accessors, &buffer_views, &document.materials.0)?;
            result.triangles_upper_bound =
                triangles(result.triangles_upper_bound, fact.triangles_upper_bound)?;
            result.primitives.push(fact);
        }
        mesh_triangles_upper_bound =
            triangles(mesh_triangles_upper_bound, result.triangles_upper_bound)?;
        meshes.push(result);
    }
    let instantiated_triangles_upper_bound = inspect_nodes(&document, &meshes)?;
    let animations =
        animation::inspect_animations(&document.animations.0, &document.nodes.0, &accessors)?;
    Ok(ModelStructure {
        buffer_views,
        accessors,
        meshes,
        images,
        animations,
        node_count: document.nodes.0.len(),
        mesh_triangles_upper_bound,
        instantiated_triangles_upper_bound,
        binary_content_validated: false,
    })
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
    if accessor.byte_offset % component_bytes != 0
        || absolute_offset % component_bytes != 0
        || stride < packed_stride
        || stride % component_bytes != 0
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
    primitive: &Primitive,
    accessors: &[ModelAccessor],
    views: &[ModelBufferView],
    materials: &[Material],
) -> Result<ModelPrimitive> {
    if primitive.mode != 4 {
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
        for prefix in ["TEXCOORD_", "COLOR_"] {
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
    }
    let count = if let Some(index) = primitive.indices {
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
    if let Some(index) = primitive.material {
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
        attributes: primitive.attributes.0.clone(),
        indices: primitive.indices,
        material: primitive.material,
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
            for index in primitive.attributes.0.values() {
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
            if let Some(index) = primitive.indices {
                assign(at(accessors, index, "primitive.indices")?.buffer_view, 2)?;
            }
        }
    }
    animation::inspect_views(&document.animations.0, accessors, views, &mut assign)?;
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
        name if name.starts_with("JOINTS_") || name.starts_with("WEIGHTS_") => {
            return Err(unavailable(
                "skinning attributes require binary and skin validation",
            ))
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

fn inspect_nodes(document: &Schema, meshes: &[ModelMesh]) -> Result<u64> {
    let mut parents = vec![None; document.nodes.0.len()];
    let mut total = 0;
    for (index, node) in document.nodes.0.iter().enumerate() {
        if node.matrix.is_some()
            && (node.translation.is_some() || node.rotation.is_some() || node.scale.is_some())
        {
            return Err(invalid("node matrix and TRS are mutually exclusive"));
        }
        for values in [
            node.matrix.as_ref().map(|v| v.as_slice()),
            node.translation.as_ref().map(|v| v.as_slice()),
            node.rotation.as_ref().map(|v| v.as_slice()),
            node.scale.as_ref().map(|v| v.as_slice()),
        ]
        .into_iter()
        .flatten()
        {
            if values.iter().any(|value| !value.is_finite()) {
                return Err(invalid("node transforms must be finite"));
            }
        }
        if node.rotation.is_some_and(|rotation| {
            (rotation.iter().map(|value| value * value).sum::<f64>() - 1.0).abs() > 1e-4
        }) {
            return Err(invalid("node rotation quaternion must have unit length"));
        }
        if let Some(matrix) = &node.matrix {
            inspect_matrix(matrix)?;
        }
        if let Some(mesh) = node.mesh {
            total = triangles(total, at(meshes, mesh, "node.mesh")?.triangles_upper_bound)?;
        }
        if let Some(camera) = node.camera {
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
    let mut pending: Vec<usize> = parents
        .iter()
        .enumerate()
        .filter_map(|(index, parent)| parent.is_none().then_some(index))
        .collect();
    let mut visited = 0;
    while let Some(index) = pending.pop() {
        visited += 1;
        pending.extend(document.nodes.0[index].children.0.iter().copied());
    }
    if visited != document.nodes.0.len() {
        return Err(invalid("model node graph contains a cycle"));
    }
    if document
        .scene
        .is_some_and(|index| index >= document.scenes.0.len())
    {
        return Err(invalid("default scene is out of range"));
    }
    for scene in &document.scenes.0 {
        let mut seen = vec![false; parents.len()];
        for root in &scene.nodes.0 {
            if at(&parents, *root, "scene root")?.is_some() || seen[*root] {
                return Err(invalid("scene roots must be distinct parentless nodes"));
            }
            seen[*root] = true;
        }
    }
    for camera in &document.cameras.0 {
        inspect_camera(camera)?;
    }
    Ok(total)
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
                    let mut references = Vec::new();
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
                        Some(value) => values.push(value),
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
                while values.len() < MAX_MODEL_ATTRIBUTES {
                    let Some(key) = map.next_key::<String>()? else {
                        return Ok(Attributes(values));
                    };
                    if key.len() > 64 {
                        return Err(de::Error::custom(
                            "model_structure_limit: attribute name exceeds 64 bytes",
                        ));
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
            "model_resource_unavailable: extension/skin/morph/sparse content is pending validation",
        ))
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
            #[serde(default,rename="extras")] _extras: Option<IgnoredAny>,
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

schema!(Schema {
    #[serde(rename="asset")] _asset: AssetHeader,
    #[serde(default)] buffers: Limited<Buffer,MAX_MODEL_RECORDS>,
    #[serde(default)] buffer_views: Limited<BufferView,MAX_MODEL_RECORDS>,
    #[serde(default)] accessors: Limited<Accessor,MAX_MODEL_RECORDS>,
    #[serde(default)] meshes: Limited<Mesh,MAX_MODEL_NODES>,
    #[serde(default)] nodes: Limited<Node,MAX_MODEL_NODES>,
    #[serde(default)] scenes: Limited<Scene,MAX_MODEL_NODES>,
    #[serde(default)] scene: Option<usize>,
    #[serde(default)] images: Limited<Image,MAX_MODEL_IMAGE_RECORDS>,
    #[serde(default)] textures: Limited<Texture,MAX_MODEL_IMAGE_RECORDS>,
    #[serde(default)] samplers: Limited<Sampler,MAX_MODEL_IMAGE_RECORDS>,
    #[serde(default)] materials: Limited<Material,MAX_MODEL_IMAGE_RECORDS>,
    #[serde(default)] cameras: Limited<Camera,MAX_MODEL_NODES>,
    #[serde(default)] extensions_used: Limited<String,MAX_MODEL_IMAGE_RECORDS>,
    #[serde(default)] extensions_required: Limited<String,MAX_MODEL_IMAGE_RECORDS>,
    #[serde(default,deserialize_with="animation::nonempty_animations")] animations: Limited<animation::Animation,MAX_MODEL_ANIMATIONS>,
    #[serde(default,rename="skins")] _skins: Pending,
});
schema!(AssetHeader {
    #[serde(rename="version")] _version:String,
    #[serde(default,rename="minVersion")] _min_version:Option<String>,
    #[serde(default,rename="generator")] _generator:Option<String>,
    #[serde(default,rename="copyright")] _copyright:Option<String>,
});
named_schema!(Buffer { byte_length:u64, #[serde(default)] uri:Option<String>, });
named_schema!(BufferView {
    buffer:usize, #[serde(default)] byte_offset:u64, byte_length:u64,
    #[serde(default)] byte_stride:Option<u64>, #[serde(default)] target:Option<u32>,
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
    #[serde(default,rename="weights")] _weights:Pending,
});
schema!(Primitive {
    attributes:Attributes, #[serde(default)] indices:Option<usize>,
    #[serde(default)] material:Option<usize>, #[serde(default="triangle_mode")] mode:u32,
    #[serde(default,rename="targets")] _targets:Pending,
});
fn triangle_mode() -> u32 {
    4
}
named_schema!(Node {
    #[serde(default)] children:Limited<usize,MAX_MODEL_NODES>,
    #[serde(default)] mesh:Option<usize>, #[serde(default)] camera:Option<usize>,
    #[serde(default)] matrix:Option<[f64;16]>, #[serde(default)] translation:Option<[f64;3]>,
    #[serde(default)] rotation:Option<[f64;4]>, #[serde(default)] scale:Option<[f64;3]>,
    #[serde(default,rename="skin")] _skin:Pending, #[serde(default,rename="weights")] _weights:Pending,
});
named_schema!(Scene { #[serde(default)] nodes:Limited<usize,MAX_MODEL_NODES>, });
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
