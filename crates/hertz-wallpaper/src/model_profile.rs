// SPDX-License-Identifier: MIT
//! Prepared static-core GLB facts in the runtime profile schema. This consumes
//! the checked structure; it neither decodes images nor grants a GPU adapter.

use serde_json::{json, Value};

use crate::model_container::BinaryChunk;
use crate::model_structure::{
    AccessorShape, GlbResource, ModelAccessor, ModelAlphaMode, ModelImage, ModelMaterial,
    ModelNodeTransform, ModelNormalTexture, ModelOcclusionTexture, ModelPrimitive, ModelSampler,
    ModelTextureInfo, MODEL_SAMPLER_MAG_FILTER, MODEL_SAMPLER_MIN_FILTER, MODEL_SAMPLER_WRAP,
};
use crate::{PackageError, Result};

const PROFILE: &str = "static-core-pbr-v1";
const TEXTURED_PROFILE: &str = "static-pbr-texture-v1";
const LOADER_VERSION: &str = "three-0.186.0-gltfloader";
const MAX_NODES: usize = 5000;
const MAX_ITEMS: usize = 16384;

fn unavailable(message: &str) -> PackageError {
    PackageError::new("model_profile_unavailable", message)
}

fn checked_sum(values: impl IntoIterator<Item = u64>) -> Result<u64> {
    values.into_iter().try_fold(0_u64, |sum, value| {
        sum.checked_add(value)
            .ok_or_else(|| unavailable("model profile byte sum overflow"))
    })
}

fn shape_name(shape: AccessorShape) -> Option<&'static str> {
    match shape {
        AccessorShape::Scalar => Some("SCALAR"),
        AccessorShape::Vec3 => Some("VEC3"),
        _ => None,
    }
}

fn array(values: &[f64]) -> Value {
    Value::Array(values.iter().map(|value| json!(value)).collect())
}

fn transform(node: &ModelNodeTransform) -> Value {
    match node {
        ModelNodeTransform::Matrix(matrix) => json!({"kind": "matrix", "matrix": matrix}),
        ModelNodeTransform::Trs {
            translation,
            rotation,
            scale,
        } => {
            json!({"kind": "trs", "translation": translation, "rotation": rotation, "scale": scale})
        }
    }
}

fn check_accessor(accessor: &ModelAccessor) -> Result<()> {
    match accessor.shape {
        AccessorShape::Vec3 => {
            if accessor.component_type != 5126 {
                return Err(unavailable("core profile requires FLOAT VEC3 accessors"));
            }
        }
        AccessorShape::Scalar => {
            if ![5121, 5123, 5125].contains(&accessor.component_type) {
                return Err(unavailable("core profile requires unsigned SCALAR indices"));
            }
        }
        _ => {
            return Err(unavailable(
                "core profile allows only VEC3 and SCALAR accessors",
            ))
        }
    }
    if accessor.normalized || accessor.stride != accessor.element_bytes {
        return Err(unavailable(
            "core profile requires packed unnormalized accessors",
        ));
    }
    Ok(())
}

fn primitive_key(primitive: &ModelPrimitive, position: usize, normal: usize) -> String {
    let index = primitive
        .indices
        .map_or_else(|| "undefined".to_owned(), |value| value.to_string());
    let mode = primitive
        .authored_mode
        .map_or_else(|| "undefined".to_owned(), |value| value.to_string());
    format!("{index}:NORMAL:{normal};POSITION:{position};:{mode}")
}

fn view_offset(view: &BinaryChunk, binary: &BinaryChunk) -> Result<u64> {
    view.offset
        .checked_sub(binary.offset)
        .ok_or_else(|| unavailable("model bufferView precedes the BIN chunk"))
}

/// Returns the exact `static-core-pbr-v1` facts consumed by the shipped Three
/// profile. `encoded_bytes` is the whole original GLB length already checked by
/// the inspector. Any images, materials, skins, animations, cameras, morphs or
/// non-TRIANGLES primitives are unavailable for this profile.
pub fn static_core_profile_facts(resource: &GlbResource, encoded_bytes: u64) -> Result<Value> {
    let structure = &resource.structure;
    let binary = resource
        .container
        .binary
        .as_ref()
        .ok_or_else(|| unavailable("core profile requires a GLB BIN chunk"))?;
    if structure.scenes.len() != 1 || structure.default_scene.is_some_and(|scene| scene != 0) {
        return Err(unavailable(
            "core profile requires exactly one default scene",
        ));
    }
    let scene = structure
        .scenes
        .first()
        .ok_or_else(|| unavailable("core profile requires a scene"))?;
    if scene.nodes.is_empty()
        || structure.nodes.len() > MAX_NODES
        || structure.meshes.len() > MAX_ITEMS
        || structure.accessors.len() > MAX_ITEMS
        || structure.buffer_views.len() > MAX_ITEMS
    {
        return Err(unavailable("core profile item limits"));
    }
    if !structure.images.is_empty()
        || !structure.materials.is_empty()
        || !structure.textures.is_empty()
        || !structure.samplers.is_empty()
        || !structure.animations.is_empty()
        || !structure.skins.is_empty()
        || structure.camera_count != 0
    {
        return Err(unavailable(
            "core profile rejects images, materials and delegates",
        ));
    }
    if structure
        .node_morph_weights
        .iter()
        .any(|weights| weights.is_some())
        || structure
            .meshes
            .iter()
            .any(|mesh| mesh.morph_target_count != 0)
    {
        return Err(unavailable("core profile rejects morph targets"));
    }
    let buffer_bytes = structure
        .buffer_byte_length
        .ok_or_else(|| unavailable("core profile requires one BIN buffer"))?;
    if buffer_bytes == 0 || buffer_bytes > binary.bytes || binary.bytes - buffer_bytes > 3 {
        return Err(unavailable("core profile BIN buffer length mismatch"));
    }
    for accessor in &structure.accessors {
        check_accessor(accessor)?;
    }
    let mut primitive_count = 0usize;
    for mesh in &structure.meshes {
        if mesh.primitives.is_empty() {
            return Err(unavailable("core profile requires mesh primitives"));
        }
        primitive_count += mesh.primitives.len();
        if primitive_count > MAX_ITEMS {
            return Err(unavailable("core profile primitive limit"));
        }
        for primitive in &mesh.primitives {
            if primitive.material.is_some()
                || !primitive.targets.is_empty()
                || !matches!(primitive.authored_mode, None | Some(4))
            {
                return Err(unavailable(
                    "core profile requires default-material TRIANGLES",
                ));
            }
            if primitive.attributes.len() != 2
                || !primitive.attributes.contains_key("POSITION")
                || !primitive.attributes.contains_key("NORMAL")
            {
                return Err(unavailable(
                    "core profile requires POSITION and NORMAL only",
                ));
            }
        }
    }
    let mut parents = vec![None; structure.nodes.len()];
    let mut mesh_references = vec![0_u64; structure.meshes.len()];
    for (index, node) in structure.nodes.iter().enumerate() {
        if node.camera.is_some() || node.skin.is_some() {
            return Err(unavailable("core profile rejects cameras and skins"));
        }
        if let Some(mesh) = node.mesh {
            if mesh >= structure.meshes.len() {
                return Err(unavailable("core profile node mesh index"));
            }
            mesh_references[mesh] += 1;
        }
        for &child in &node.children {
            if child >= parents.len() || parents[child].replace(index).is_some() {
                return Err(unavailable("core profile node hierarchy"));
            }
        }
    }
    let mut reachable = std::collections::BTreeSet::new();
    let mut stack: Vec<(usize, usize)> = scene.nodes.iter().map(|&node| (node, 1)).collect();
    let mut max_depth = 0usize;
    while let Some((index, depth)) = stack.pop() {
        if index >= structure.nodes.len() || depth > 128 || !reachable.insert(index) {
            if index >= structure.nodes.len() || depth > 128 {
                return Err(unavailable("core profile scene node range or depth"));
            }
            continue;
        }
        max_depth = max_depth.max(depth);
        for &child in &structure.nodes[index].children {
            stack.push((child, depth + 1));
        }
    }
    let mut used_meshes = std::collections::BTreeSet::new();
    let mut used_accessors = std::collections::BTreeSet::new();
    let mut geometries: std::collections::BTreeMap<String, Value> =
        std::collections::BTreeMap::new();
    let mut scene_nodes = Vec::with_capacity(reachable.len());
    let mut draw_calls = 0u64;
    let mut triangles = 0u64;
    let mut object_count = 1u64;
    for &index in &reachable {
        let node = &structure.nodes[index];
        let primitives: &[ModelPrimitive] = node
            .mesh
            .map(|mesh| &structure.meshes[mesh].primitives[..])
            .unwrap_or(&[]);
        if let Some(mesh) = node.mesh {
            used_meshes.insert(mesh);
        }
        object_count = object_count
            .checked_add(
                1 + if primitives.len() > 1 {
                    primitives.len() as u64
                } else {
                    0
                },
            )
            .ok_or_else(|| unavailable("core profile object count overflow"))?;
        for primitive in primitives {
            let position = *primitive
                .attributes
                .get("POSITION")
                .expect("checked POSITION");
            let normal = *primitive.attributes.get("NORMAL").expect("checked NORMAL");
            let accessor = structure
                .accessors
                .get(position)
                .ok_or_else(|| unavailable("core profile position accessor"))?;
            if accessor.min.is_none() || accessor.max.is_none() {
                return Err(unavailable("core profile POSITION requires bounds"));
            }
            draw_calls += 1;
            triangles = triangles
                .checked_add(primitive.triangles_upper_bound)
                .ok_or_else(|| unavailable("core profile triangle overflow"))?;
            used_accessors.insert(position);
            used_accessors.insert(normal);
            if let Some(indices) = primitive.indices {
                used_accessors.insert(indices);
            }
            let key = primitive_key(primitive, position, normal);
            geometries.entry(key.clone()).or_insert_with(|| {
                json!({
                    "key": key,
                    "positionAccessor": position,
                    "normalAccessor": normal,
                    "indexAccessor": primitive.indices,
                    "mode": primitive.authored_mode,
                    "triangles": primitive.triangles_upper_bound,
                    "positionMin": array(accessor.min.as_ref().expect("checked bounds")),
                    "positionMax": array(accessor.max.as_ref().expect("checked bounds"))
                })
            });
        }
        scene_nodes.push(json!({
            "index": index,
            "parentIndex": parents[index],
            "meshIndex": node.mesh,
            "children": &node.children,
            "transform": transform(&node.transform)
        }));
    }
    if draw_calls == 0 {
        return Err(unavailable("core profile requires a visible triangle"));
    }
    let mut allocated_object_count = object_count;
    for mesh in used_meshes {
        if mesh_references[mesh] > 1 {
            let count = structure.meshes[mesh].primitives.len() as u64;
            allocated_object_count = allocated_object_count
                .checked_add(count + if count > 1 { 1 } else { 0 })
                .ok_or_else(|| unavailable("core profile allocated object overflow"))?;
        }
    }
    let used_layouts: Vec<&ModelAccessor> = used_accessors
        .iter()
        .map(|&index| &structure.accessors[index])
        .collect();
    let mut used_views = std::collections::BTreeSet::new();
    for accessor in &used_layouts {
        if accessor.buffer_view >= structure.buffer_views.len() {
            return Err(unavailable("core profile accessor bufferView"));
        }
        used_views.insert(accessor.buffer_view);
    }
    let accessor_facts: Vec<Value> = used_accessors
        .iter()
        .map(|&index| {
            let accessor = &structure.accessors[index];
            let item_bytes = accessor
                .count
                .checked_mul(accessor.element_bytes)
                .ok_or_else(|| unavailable("core profile accessor bytes overflow"))?;
            Ok(json!({
                "index": index,
                "viewIndex": accessor.buffer_view,
                "componentType": accessor.component_type,
                "type": shape_name(accessor.shape).expect("checked shape"),
                "count": accessor.count,
                "byteOffset": accessor.byte_offset,
                "byteLength": item_bytes
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    let view_facts: Vec<Value> = used_views
        .iter()
        .map(|&index| {
            let view = &structure.buffer_views[index];
            Ok(json!({
                "index": index,
                "byteOffset": view_offset(&view.range, binary)?,
                "byteLength": view.range.bytes
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    let gpu_buffer_bytes = checked_sum(
        accessor_facts
            .iter()
            .map(|fact| fact["byteLength"].as_u64().expect("checked byte length")),
    )?;
    let cpu_backing_bytes = checked_sum(
        used_views
            .iter()
            .map(|&index| structure.buffer_views[index].range.bytes),
    )?;
    let geometry_count = geometries.len();
    let attribute_count = used_layouts.len();
    let backing_count = used_views.len();
    let geometry_facts: Vec<Value> = geometries.into_values().collect();
    Ok(json!({
        "profile": PROFILE,
        "loaderVersion": LOADER_VERSION,
        "input": {
            "encodedBytes": encoded_bytes,
            "jsonBytes": resource.container.json.len(),
            "binBytes": binary.bytes
        },
        "declared": {
            "nodes": structure.nodes.len(),
            "meshes": structure.meshes.len(),
            "primitives": primitive_count,
            "accessors": structure.accessors.len(),
            "bufferViews": structure.buffer_views.len()
        },
        "scene": {
            "index": 0,
            "roots": &scene.nodes,
            "nodes": scene_nodes,
            "maxDepth": max_depth,
            "objectCount": object_count,
            "allocatedObjectCount": allocated_object_count,
            "drawCalls": draw_calls,
            "triangles": triangles
        },
        "resources": {
            "geometries": geometry_facts,
            "accessors": accessor_facts,
            "bufferViews": view_facts,
            "geometryCount": geometry_count,
            "attributeCount": attribute_count,
            "backingCount": backing_count,
            "gpuBufferBytes": gpu_buffer_bytes,
            "cpuBackingBytes": cpu_backing_bytes,
            "allocatedMaterialCount": 2,
            "retainedMaterialCount": 1
        }
    }))
}

fn textured_shape(shape: AccessorShape) -> Option<&'static str> {
    match shape {
        AccessorShape::Scalar => Some("SCALAR"),
        AccessorShape::Vec2 => Some("VEC2"),
        AccessorShape::Vec3 => Some("VEC3"),
        _ => None,
    }
}

fn check_textured_accessor(accessor: &ModelAccessor) -> Result<()> {
    match accessor.shape {
        AccessorShape::Vec2 | AccessorShape::Vec3 => {
            if accessor.component_type != 5126 {
                return Err(unavailable(
                    "textured profile requires FLOAT UV/VEC3 accessors",
                ));
            }
        }
        AccessorShape::Scalar => {
            if ![5121, 5123, 5125].contains(&accessor.component_type) {
                return Err(unavailable(
                    "textured profile requires unsigned SCALAR indices",
                ));
            }
        }
        _ => {
            return Err(unavailable(
                "textured profile allows VEC2/VEC3/SCALAR accessors",
            ))
        }
    }
    if accessor.normalized || accessor.stride != accessor.element_bytes {
        return Err(unavailable(
            "textured profile requires packed unnormalized accessors",
        ));
    }
    Ok(())
}

fn slot_facts(info: Option<ModelTextureInfo>) -> Value {
    info.map_or(
        Value::Null,
        |info| json!({"index": info.texture, "texCoord": info.tex_coord}),
    )
}

fn normal_facts(info: Option<ModelNormalTexture>) -> Value {
    info.map_or(
        Value::Null,
        |info| json!({"index": info.texture, "texCoord": info.tex_coord, "scale": info.scale}),
    )
}

fn occlusion_facts(info: Option<ModelOcclusionTexture>) -> Value {
    info.map_or(Value::Null, |info| {
        json!({"index": info.texture, "texCoord": info.tex_coord, "strength": info.strength})
    })
}

fn alpha_name(mode: ModelAlphaMode) -> &'static str {
    match mode {
        ModelAlphaMode::Opaque => "OPAQUE",
        ModelAlphaMode::Mask => "MASK",
        ModelAlphaMode::Blend => "BLEND",
    }
}

fn material_facts(index: usize, material: &ModelMaterial) -> Value {
    let (base_color_factor, metallic, roughness, base, metallic_roughness) =
        material
            .pbr
            .map_or(([1.0, 1.0, 1.0, 1.0], 1.0, 1.0, None, None), |pbr| {
                (
                    pbr.base_color_factor,
                    pbr.metallic_factor,
                    pbr.roughness_factor,
                    pbr.base_color_texture,
                    pbr.metallic_roughness_texture,
                )
            });
    json!({
        "index": index,
        "baseColorFactor": base_color_factor,
        "metallicFactor": metallic,
        "roughnessFactor": roughness,
        "baseColorTexture": slot_facts(base),
        "metallicRoughnessTexture": slot_facts(metallic_roughness),
        "normalTexture": normal_facts(material.normal_texture),
        "occlusionTexture": occlusion_facts(material.occlusion_texture),
        "emissiveTexture": slot_facts(material.emissive_texture),
        "emissiveFactor": material.emissive_factor,
        "alphaMode": alpha_name(material.alpha_mode),
        "alphaCutoff": material.alpha_cutoff,
        "doubleSided": material.double_sided
    })
}

fn image_facts(index: usize, image: &ModelImage) -> Result<Value> {
    match image {
        ModelImage::Embedded { range, mime, .. } => {
            if mime != "image/png" && mime != "image/jpeg" {
                return Err(unavailable(
                    "textured profile requires PNG/JPEG embedded images",
                ));
            }
            Ok(json!({"index": index, "source": "embedded", "mime": mime, "bytes": range.bytes}))
        }
        // External image broker URLs are a separate native preparation slice.
        ModelImage::Package { .. } => Err(unavailable("external model textures are not prepared")),
    }
}

fn sampler_for(
    structure: &crate::model_structure::ModelStructure,
    sampler: Option<usize>,
) -> ModelSampler {
    sampler
        .and_then(|index| structure.samplers.get(index))
        .copied()
        .unwrap_or(ModelSampler {
            mag_filter: MODEL_SAMPLER_MAG_FILTER,
            min_filter: MODEL_SAMPLER_MIN_FILTER,
            wrap_s: MODEL_SAMPLER_WRAP,
            wrap_t: MODEL_SAMPLER_WRAP,
        })
}

/// Textured PBR facts for the shipped profile. Only embedded PNG/JPEG images
/// are projected in this slice; external package textures stay unavailable until
/// their broker closure is admitted separately.
pub fn static_textured_profile_facts(resource: &GlbResource, encoded_bytes: u64) -> Result<Value> {
    let structure = &resource.structure;
    let binary = resource
        .container
        .binary
        .as_ref()
        .ok_or_else(|| unavailable("textured profile requires a GLB BIN chunk"))?;
    if structure.scenes.len() != 1 || structure.default_scene.is_some_and(|scene| scene != 0) {
        return Err(unavailable(
            "textured profile requires exactly one default scene",
        ));
    }
    let scene = structure
        .scenes
        .first()
        .ok_or_else(|| unavailable("textured profile requires a scene"))?;
    if scene.nodes.is_empty()
        || structure.nodes.len() > MAX_NODES
        || structure.meshes.len() > MAX_ITEMS
        || structure.accessors.len() > MAX_ITEMS
        || structure.buffer_views.len() > MAX_ITEMS
        || structure.materials.len() > MAX_ITEMS
        || structure.textures.len() > MAX_ITEMS
        || structure.images.len() > MAX_ITEMS
    {
        return Err(unavailable("textured profile item limits"));
    }
    if !structure.animations.is_empty()
        || !structure.skins.is_empty()
        || structure.camera_count != 0
        || structure
            .node_morph_weights
            .iter()
            .any(|weights| weights.is_some())
        || structure
            .meshes
            .iter()
            .any(|mesh| mesh.morph_target_count != 0)
    {
        return Err(unavailable(
            "textured profile rejects skins, morphs and delegates",
        ));
    }
    let buffer_bytes = structure
        .buffer_byte_length
        .ok_or_else(|| unavailable("textured profile requires one BIN buffer"))?;
    if buffer_bytes == 0 || buffer_bytes > binary.bytes || binary.bytes - buffer_bytes > 3 {
        return Err(unavailable("textured profile BIN buffer length mismatch"));
    }
    for accessor in &structure.accessors {
        check_textured_accessor(accessor)?;
    }
    let mut primitive_count = 0usize;
    for mesh in &structure.meshes {
        if mesh.primitives.is_empty() {
            return Err(unavailable("textured profile requires mesh primitives"));
        }
        primitive_count += mesh.primitives.len();
        if primitive_count > MAX_ITEMS {
            return Err(unavailable("textured profile primitive limit"));
        }
        for primitive in &mesh.primitives {
            if !primitive.targets.is_empty() || !matches!(primitive.authored_mode, None | Some(4)) {
                return Err(unavailable(
                    "textured profile requires TRIANGLES without morphs",
                ));
            }
        }
    }
    let mut parents = vec![None; structure.nodes.len()];
    let mut mesh_references = vec![0_u64; structure.meshes.len()];
    for (index, node) in structure.nodes.iter().enumerate() {
        if node.camera.is_some() || node.skin.is_some() {
            return Err(unavailable("textured profile rejects cameras and skins"));
        }
        if let Some(mesh) = node.mesh {
            if mesh >= structure.meshes.len() {
                return Err(unavailable("textured profile node mesh index"));
            }
            mesh_references[mesh] += 1;
        }
        for &child in &node.children {
            if child >= parents.len() || parents[child].replace(index).is_some() {
                return Err(unavailable("textured profile node hierarchy"));
            }
        }
    }
    let mut reachable = std::collections::BTreeSet::new();
    let mut stack: Vec<(usize, usize)> = scene.nodes.iter().map(|&node| (node, 1)).collect();
    let mut max_depth = 0usize;
    while let Some((index, depth)) = stack.pop() {
        if index >= structure.nodes.len() || depth > 128 {
            return Err(unavailable("textured profile scene node range or depth"));
        }
        if !reachable.insert(index) {
            continue;
        }
        max_depth = max_depth.max(depth);
        for &child in &structure.nodes[index].children {
            stack.push((child, depth + 1));
        }
    }
    let mut used_materials = std::collections::BTreeSet::new();
    let mut used_views = std::collections::BTreeSet::new();
    let mut used_accessors = std::collections::BTreeSet::new();
    let mut used_textures = std::collections::BTreeSet::new();
    let mut used_images = std::collections::BTreeSet::new();
    let mut geometries: std::collections::BTreeMap<String, Value> =
        std::collections::BTreeMap::new();
    let mut scene_nodes = Vec::with_capacity(reachable.len());
    let mut draw_calls = 0u64;
    let mut triangles = 0u64;
    let mut object_count = 1u64;
    for &index in &reachable {
        let node = &structure.nodes[index];
        let primitives: &[ModelPrimitive] = node
            .mesh
            .map(|mesh| &structure.meshes[mesh].primitives[..])
            .unwrap_or(&[]);
        object_count = object_count
            .checked_add(
                1 + if primitives.len() > 1 {
                    primitives.len() as u64
                } else {
                    0
                },
            )
            .ok_or_else(|| unavailable("textured profile object count overflow"))?;
        for primitive in primitives {
            let position = *primitive
                .attributes
                .get("POSITION")
                .expect("checked POSITION");
            let normal = *primitive.attributes.get("NORMAL").expect("checked NORMAL");
            let accessor = structure
                .accessors
                .get(position)
                .ok_or_else(|| unavailable("textured profile position accessor"))?;
            if accessor.min.is_none() || accessor.max.is_none() {
                return Err(unavailable("textured profile POSITION requires bounds"));
            }
            let material = primitive.material;
            if let Some(material) = material {
                if !structure.materials.get(material).is_some_and(|facts| {
                    let slots = material_texture_infos(facts);
                    let used: std::collections::BTreeSet<usize> =
                        slots.iter().map(|info| info.texture).collect();
                    let coords: std::collections::BTreeSet<u32> =
                        slots.iter().map(|info| info.tex_coord).collect();
                    let present: std::collections::BTreeSet<u32> = primitive
                        .attributes
                        .keys()
                        .filter_map(|key| key.strip_prefix("TEXCOORD_")?.parse().ok())
                        .collect();
                    used.len() == slots.len() && coords == present
                }) {
                    return Err(unavailable(
                        "textured profile material texture sharing or TEXCOORD usage",
                    ));
                }
            } else if primitive.attributes.len() != 2 {
                return Err(unavailable(
                    "textured profile default material requires POSITION/NORMAL",
                ));
            }
            draw_calls += 1;
            triangles = triangles
                .checked_add(primitive.triangles_upper_bound)
                .ok_or_else(|| unavailable("textured profile triangle overflow"))?;
            used_accessors.insert(position);
            used_accessors.insert(normal);
            if let Some(indices) = primitive.indices {
                used_accessors.insert(indices);
            }
            let mut uv_facts = Vec::new();
            for (semantic, accessor_index) in &primitive.attributes {
                if let Some(set) = semantic.strip_prefix("TEXCOORD_") {
                    let set: u32 = set
                        .parse()
                        .map_err(|_| unavailable("textured profile TEXCOORD index"))?;
                    let uv = structure
                        .accessors
                        .get(*accessor_index)
                        .ok_or_else(|| unavailable("textured profile TEXCOORD accessor"))?;
                    if uv.shape != AccessorShape::Vec2 || uv.count != accessor.count {
                        return Err(unavailable("textured profile TEXCOORD shape"));
                    }
                    used_accessors.insert(*accessor_index);
                    uv_facts.push(json!({"set": set, "accessor": accessor_index}));
                }
            }
            if let Some(material) = material {
                used_materials.insert(material);
                for info in material_texture_infos(
                    structure.materials.get(material).expect("checked material"),
                ) {
                    used_textures.insert(info.texture);
                    let texture = structure
                        .textures
                        .get(info.texture)
                        .ok_or_else(|| unavailable("textured profile texture index"))?;
                    if texture.source >= structure.images.len() {
                        return Err(unavailable("textured profile texture source"));
                    }
                    used_images.insert(texture.source);
                }
            }
            let attributes = primitive
                .attributes
                .iter()
                .map(|(semantic, accessor)| format!("{semantic}:{accessor};"))
                .collect::<String>();
            let index_part = primitive
                .indices
                .map_or_else(|| "undefined".to_owned(), |value| value.to_string());
            let mode = primitive
                .authored_mode
                .map_or_else(|| "undefined".to_owned(), |value| value.to_string());
            let key = format!("{index_part}:{attributes}:{mode}");
            geometries.entry(key.clone()).or_insert_with(|| {
                json!({
                    "key": key,
                    "material": material,
                    "positionAccessor": position,
                    "normalAccessor": normal,
                    "uvAccessors": uv_facts,
                    "indexAccessor": primitive.indices,
                    "mode": primitive.authored_mode,
                    "triangles": primitive.triangles_upper_bound,
                    "positionMin": array(accessor.min.as_ref().expect("checked bounds")),
                    "positionMax": array(accessor.max.as_ref().expect("checked bounds"))
                })
            });
        }
        scene_nodes.push(json!({
            "index": index,
            "parentIndex": parents[index],
            "meshIndex": node.mesh,
            "children": &node.children,
            "transform": transform(&node.transform)
        }));
    }
    if draw_calls == 0 {
        return Err(unavailable("textured profile requires a visible triangle"));
    }
    let mut allocated_object_count = object_count;
    for &mesh in &reachable
        .iter()
        .filter_map(|&index| structure.nodes[index].mesh)
        .collect::<std::collections::BTreeSet<_>>()
    {
        if mesh_references[mesh] > 1 {
            let count = structure.meshes[mesh].primitives.len() as u64;
            allocated_object_count = allocated_object_count
                .checked_add(count + if count > 1 { 1 } else { 0 })
                .ok_or_else(|| unavailable("textured profile allocated object overflow"))?;
        }
    }
    for accessor in used_accessors
        .iter()
        .map(|&index| &structure.accessors[index])
    {
        used_views.insert(accessor.buffer_view);
    }
    let accessor_facts: Vec<Value> = used_accessors
        .iter()
        .map(|&index| {
            let accessor = &structure.accessors[index];
            let item_bytes = accessor
                .count
                .checked_mul(accessor.element_bytes)
                .ok_or_else(|| unavailable("textured profile accessor bytes overflow"))?;
            Ok(json!({
                "index": index,
                "viewIndex": accessor.buffer_view,
                "componentType": accessor.component_type,
                "type": textured_shape(accessor.shape).expect("checked shape"),
                "count": accessor.count,
                "byteOffset": accessor.byte_offset,
                "byteLength": item_bytes
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    let view_facts: Vec<Value> = used_views
        .iter()
        .map(|&index| {
            let view = &structure.buffer_views[index];
            Ok(json!({
                "index": index,
                "byteOffset": view_offset(&view.range, binary)?,
                "byteLength": view.range.bytes
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    let image_facts_used: Vec<Value> = used_images
        .iter()
        .map(|&index| {
            image_facts(
                index,
                structure
                    .images
                    .get(index)
                    .ok_or_else(|| unavailable("textured profile image index"))?,
            )
        })
        .collect::<Result<Vec<_>>>()?;
    let texture_facts: Vec<Value> = used_textures
        .iter()
        .map(|&index| {
            let texture = structure
                .textures
                .get(index)
                .ok_or_else(|| unavailable("textured profile texture index"))?;
            let source = image_facts(
                texture.source,
                structure
                    .images
                    .get(texture.source)
                    .ok_or_else(|| unavailable("textured profile texture image"))?,
            )?;
            let sampler = sampler_for(structure, texture.sampler);
            Ok(json!({
                "index": index,
                "source": source,
                "sampler": {"magFilter": sampler.mag_filter, "minFilter": sampler.min_filter,
                    "wrapS": sampler.wrap_s, "wrapT": sampler.wrap_t}
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    let material_facts_used: Vec<Value> = used_materials
        .iter()
        .map(|&index| material_facts(index, &structure.materials[index]))
        .collect();
    let gpu_buffer_bytes = checked_sum(
        accessor_facts
            .iter()
            .map(|fact| fact["byteLength"].as_u64().expect("checked byte length")),
    )?;
    let cpu_backing_bytes = checked_sum(
        used_views
            .iter()
            .map(|&index| structure.buffer_views[index].range.bytes),
    )?;
    let geometry_count = geometries.len();
    let geometry_facts: Vec<Value> = geometries.into_values().collect();
    Ok(json!({
        "profile": TEXTURED_PROFILE,
        "loaderVersion": LOADER_VERSION,
        "input": {
            "encodedBytes": encoded_bytes,
            "jsonBytes": resource.container.json.len(),
            "binBytes": binary.bytes
        },
        "declared": {
            "nodes": structure.nodes.len(),
            "meshes": structure.meshes.len(),
            "primitives": primitive_count,
            "accessors": structure.accessors.len(),
            "bufferViews": structure.buffer_views.len(),
            "materials": structure.materials.len(),
            "textures": structure.textures.len(),
            "images": structure.images.len()
        },
        "scene": {
            "index": 0,
            "roots": &scene.nodes,
            "nodes": scene_nodes,
            "maxDepth": max_depth,
            "objectCount": object_count,
            "allocatedObjectCount": allocated_object_count,
            "drawCalls": draw_calls,
            "triangles": triangles
        },
        "materials": material_facts_used,
        "textures": texture_facts,
        "images": image_facts_used,
        "resources": {
            "geometries": geometry_facts,
            "accessors": accessor_facts,
            "bufferViews": view_facts,
            "geometryCount": geometry_count,
            "attributeCount": used_accessors.len(),
            "backingCount": used_views.len(),
            "gpuBufferBytes": gpu_buffer_bytes,
            "cpuBackingBytes": cpu_backing_bytes,
            "materialCount": used_materials.len(),
            "allocatedMaterialCount": used_materials.len() * 2,
            "textureCount": used_textures.len(),
            "imageCount": used_images.len()
        }
    }))
}

fn material_texture_infos(material: &ModelMaterial) -> Vec<ModelTextureInfo> {
    let mut slots = Vec::new();
    if let Some(pbr) = material.pbr {
        for info in [pbr.base_color_texture, pbr.metallic_roughness_texture]
            .into_iter()
            .flatten()
        {
            slots.push(info);
        }
    }
    if let Some(info) = material.normal_texture {
        slots.push(ModelTextureInfo {
            texture: info.texture,
            tex_coord: info.tex_coord,
        });
    }
    if let Some(info) = material.occlusion_texture {
        slots.push(ModelTextureInfo {
            texture: info.texture,
            tex_coord: info.tex_coord,
        });
    }
    if let Some(info) = material.emissive_texture {
        slots.push(info);
    }
    slots
}

/// Conservative upload bytes for one embedded image: base RGBA plus a doubled
/// full-mip bound. The caller's runtime upload ticket uses this declared value.
/// `glb` is the complete original GLB stream the resource was inspected from.
pub fn embedded_image_upload_bytes(
    glb: &[u8],
    resource: &GlbResource,
    index: usize,
) -> Result<u64> {
    let image = resource
        .structure
        .images
        .get(index)
        .ok_or_else(|| unavailable("model image index"))?;
    let ModelImage::Embedded { range, mime, .. } = image else {
        return Err(unavailable("external model textures are not prepared"));
    };
    let start = usize::try_from(range.offset).map_err(|_| unavailable("model image range"))?;
    let length = usize::try_from(range.bytes).map_err(|_| unavailable("model image range"))?;
    let bytes = glb
        .get(start..start + length)
        .ok_or_else(|| unavailable("model image range"))?;
    let (width, height) = match mime.as_str() {
        "image/png" => png_dimensions(bytes)?,
        "image/jpeg" => jpeg_dimensions(bytes)?,
        _ => return Err(unavailable("unsupported model image mime")),
    };
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(|| unavailable("model image pixel overflow"))?;
    checked_sum([checked_product(pixels, 4)?, checked_product(pixels, 4)?])
}

fn checked_product(a: u64, b: u64) -> Result<u64> {
    a.checked_mul(b)
        .ok_or_else(|| unavailable("model image bytes overflow"))
}

fn png_dimensions(bytes: &[u8]) -> Result<(u32, u32)> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return Err(unavailable("PNG image header"));
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().expect("checked PNG width"));
    let height = u32::from_be_bytes(bytes[20..24].try_into().expect("checked PNG height"));
    if width == 0 || height == 0 {
        return Err(unavailable("PNG image dimensions"));
    }
    Ok((width, height))
}

fn jpeg_dimensions(bytes: &[u8]) -> Result<(u32, u32)> {
    if bytes.len() < 4 || bytes[0] != 0xff || bytes[1] != 0xd8 {
        return Err(unavailable("JPEG image header"));
    }
    let mut offset = 2usize;
    while offset + 4 <= bytes.len() {
        if bytes[offset] != 0xff {
            return Err(unavailable("JPEG marker"));
        }
        let marker = bytes[offset + 1];
        if marker == 0xd8 || marker == 0xd9 {
            offset += 2;
            continue;
        }
        if offset + 4 > bytes.len() {
            break;
        }
        let length = u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]]) as usize;
        if length < 2 || offset + 2 + length > bytes.len() {
            return Err(unavailable("JPEG segment length"));
        }
        if matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        ) && length >= 7
        {
            let height = u16::from_be_bytes([bytes[offset + 5], bytes[offset + 6]]) as u32;
            let width = u16::from_be_bytes([bytes[offset + 7], bytes[offset + 8]]) as u32;
            if width > 0 && height > 0 {
                return Ok((width, height));
            }
            return Err(unavailable("JPEG image dimensions"));
        }
        offset += 2 + length;
    }
    Err(unavailable("JPEG SOF segment"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::validate_manifest_bytes;
    use crate::model_binary::inspect_glb_resource_content;
    use serde_json::json;
    use std::io::Cursor;

    fn manifest() -> crate::manifest::Manifest {
        validate_manifest_bytes(br#"{"formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae","version":1,"title":"Model profile","content":{"kind":"builtin","sceneId":"zodiac","stateVersion":1,"params":{}},"assets":[],"files":[],"permissions":{"audioSpectrum":false,"pointer":false},"license":{"code":"none","assets":"CC0-1.0"}}"#).unwrap()
    }

    fn glb(json: Value, bin: &[u8]) -> Vec<u8> {
        let text = serde_json::to_vec(&json).unwrap();
        let json_len = text.len().div_ceil(4) * 4;
        let bin_len = bin.len().div_ceil(4) * 4;
        let total = 12 + 8 + json_len + 8 + bin_len;
        let mut bytes = vec![0_u8; total];
        bytes[0..4].copy_from_slice(b"glTF");
        bytes[4..8].copy_from_slice(&2_u32.to_le_bytes());
        bytes[8..12].copy_from_slice(&(total as u32).to_le_bytes());
        bytes[12..16].copy_from_slice(&(json_len as u32).to_le_bytes());
        bytes[16..20].copy_from_slice(b"JSON");
        bytes[20..20 + text.len()].copy_from_slice(&text);
        bytes[20 + text.len()..20 + json_len].fill(0x20);
        let head = 20 + json_len;
        bytes[head..head + 4].copy_from_slice(&(bin_len as u32).to_le_bytes());
        bytes[head + 4..head + 8].copy_from_slice(b"BIN\0");
        bytes[head + 8..head + 8 + bin.len()].copy_from_slice(bin);
        bytes
    }

    fn triangle(material: bool) -> Vec<u8> {
        let mut bin = vec![0_u8; 80];
        for (index, value) in [0.0_f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
            .iter()
            .enumerate()
        {
            bin[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes());
        }
        for (index, value) in [0.0_f32, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0]
            .iter()
            .enumerate()
        {
            bin[36 + index * 4..36 + index * 4 + 4].copy_from_slice(&value.to_le_bytes());
        }
        for (index, value) in [0_u16, 1, 2].iter().enumerate() {
            bin[72 + index * 2..72 + index * 2 + 2].copy_from_slice(&value.to_le_bytes());
        }
        let mut primitive = json!({"attributes":{"POSITION":0,"NORMAL":1},"indices":2});
        let mut document = json!({
            "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
            "meshes": [{"primitives": [primitive]}],
            "buffers": [{"byteLength": 80}],
            "bufferViews": [{"buffer":0,"byteOffset":0,"byteLength":36},
                {"buffer":0,"byteOffset":36,"byteLength":36},
                {"buffer":0,"byteOffset":72,"byteLength":8}],
            "accessors": [
                {"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]},
                {"bufferView":1,"componentType":5126,"count":3,"type":"VEC3"},
                {"bufferView":2,"componentType":5123,"count":3,"type":"SCALAR"}
            ]
        });
        if material {
            document["materials"] = json!([{"pbrMetallicRoughness": {}}]);
            primitive["material"] = json!(0);
            document["meshes"] = json!([{"primitives": [primitive]}]);
        }
        glb(document, &bin)
    }

    fn facts(bytes: Vec<u8>) -> Result<Value> {
        let content = inspect_glb_resource_content(
            Cursor::new(&bytes),
            bytes.len() as u64,
            &manifest(),
            "assets/model.glb",
        )
        .unwrap();
        static_core_profile_facts(content.resource(), content.bytes())
    }

    #[test]
    fn static_core_facts_match_the_runtime_profile_schema() {
        let bytes = triangle(false);
        let facts = facts(bytes.clone()).unwrap();
        assert_eq!(facts["profile"], PROFILE);
        assert_eq!(facts["input"]["encodedBytes"], json!(bytes.len() as u64));
        assert_eq!(
            facts["input"]["jsonBytes"],
            json!(content_json_bytes(&bytes))
        );
        assert_eq!(facts["declared"]["nodes"], 1);
        assert_eq!(facts["declared"]["bufferViews"], 3);
        assert_eq!(facts["scene"]["roots"], json!([0]));
        assert_eq!(facts["scene"]["objectCount"], 2);
        assert_eq!(facts["scene"]["allocatedObjectCount"], 2);
        assert_eq!(facts["scene"]["drawCalls"], 1);
        assert_eq!(facts["scene"]["triangles"], 1);
        assert_eq!(
            facts["resources"]["geometries"][0]["key"],
            "2:NORMAL:1;POSITION:0;:undefined"
        );
        assert_eq!(facts["resources"]["gpuBufferBytes"], 78);
        assert_eq!(facts["resources"]["cpuBackingBytes"], 80);
        assert_eq!(facts["resources"]["allocatedMaterialCount"], 2);
    }

    #[test]
    fn static_core_facts_reject_authored_materials() {
        let error = facts(triangle(true)).unwrap_err();
        assert_eq!(error.code, "model_profile_unavailable");
    }

    const TEXTURED_PNG: &[u8] = &[
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 2, 8, 6,
        0, 0, 0, 114, 182, 13, 36, 0, 0, 0, 16, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 240,
        31, 10, 33, 20, 0, 69, 204, 7, 249, 102, 203, 255, 57, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66,
        96, 130,
    ];

    fn textured_triangle() -> Vec<u8> {
        let mut bin = vec![0_u8; 104 + TEXTURED_PNG.len()];
        for (index, value) in [0.0_f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
            .iter()
            .enumerate()
        {
            bin[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes());
        }
        for (index, value) in [0.0_f32, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0]
            .iter()
            .enumerate()
        {
            bin[36 + index * 4..36 + index * 4 + 4].copy_from_slice(&value.to_le_bytes());
        }
        for (index, value) in [0.0_f32, 0.0, 1.0, 0.0, 0.0, 1.0].iter().enumerate() {
            bin[72 + index * 4..72 + index * 4 + 4].copy_from_slice(&value.to_le_bytes());
        }
        for (index, value) in [0_u16, 1, 2].iter().enumerate() {
            bin[96 + index * 2..96 + index * 2 + 2].copy_from_slice(&value.to_le_bytes());
        }
        bin[104..].copy_from_slice(TEXTURED_PNG);
        let document = json!({
            "asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[0]}],"nodes":[{"mesh":0}],
            "meshes":[{"primitives":[{"attributes":{"POSITION":0,"NORMAL":1,"TEXCOORD_0":3},
                "indices":2,"material":0}]}],
            "buffers":[{"byteLength":bin.len()}],
            "bufferViews":[{"buffer":0,"byteOffset":0,"byteLength":36},
                {"buffer":0,"byteOffset":36,"byteLength":36},
                {"buffer":0,"byteOffset":72,"byteLength":24},
                {"buffer":0,"byteOffset":96,"byteLength":8},
                {"buffer":0,"byteOffset":104,"byteLength":TEXTURED_PNG.len()}],
            "accessors":[
                {"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]},
                {"bufferView":1,"componentType":5126,"count":3,"type":"VEC3"},
                {"bufferView":3,"componentType":5123,"count":3,"type":"SCALAR"},
                {"bufferView":2,"componentType":5126,"count":3,"type":"VEC2"}],
            "images":[{"bufferView":4,"mimeType":"image/png"}],
            "samplers":[{"magFilter":9728,"minFilter":9728,"wrapS":33071,"wrapT":33071}],
            "textures":[{"source":0,"sampler":0}],
            "materials":[{"pbrMetallicRoughness":{"baseColorFactor":[1,1,1,1],
                "baseColorTexture":{"index":0,"texCoord":0},"metallicFactor":0,"roughnessFactor":1},
                "alphaMode":"OPAQUE"}]
        });
        glb(document, &bin)
    }

    #[test]
    fn static_textured_facts_and_embedded_upload_bytes_match_the_runtime() {
        let bytes = textured_triangle();
        let content = inspect_glb_resource_content(
            Cursor::new(&bytes),
            bytes.len() as u64,
            &manifest(),
            "assets/model.glb",
        )
        .unwrap();
        let facts = static_textured_profile_facts(content.resource(), content.bytes()).unwrap();
        assert_eq!(facts["profile"], TEXTURED_PROFILE);
        assert_eq!(facts["declared"]["materials"], 1);
        assert_eq!(facts["scene"]["drawCalls"], 1);
        assert_eq!(
            facts["resources"]["geometries"][0]["key"],
            "2:NORMAL:1;POSITION:0;TEXCOORD_0:3;:undefined"
        );
        assert_eq!(facts["resources"]["gpuBufferBytes"], 102);
        assert_eq!(facts["resources"]["materialCount"], 1);
        assert_eq!(facts["resources"]["allocatedMaterialCount"], 2);
        assert_eq!(facts["resources"]["textureCount"], 1);
        assert_eq!(facts["resources"]["imageCount"], 1);
        assert_eq!(facts["materials"][0]["metallicFactor"], 0.0);
        assert_eq!(facts["materials"][0]["baseColorTexture"]["index"], 0);
        assert_eq!(facts["textures"][0]["sampler"]["magFilter"], 9728);
        assert_eq!(facts["images"][0]["bytes"], TEXTURED_PNG.len());
        assert_eq!(
            embedded_image_upload_bytes(&bytes, content.resource(), 0).unwrap(),
            32
        );
    }

    fn content_json_bytes(bytes: &[u8]) -> u64 {
        u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as u64
    }
}
