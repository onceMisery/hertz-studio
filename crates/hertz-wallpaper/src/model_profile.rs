// SPDX-License-Identifier: MIT
//! Prepared static-core GLB facts in the runtime profile schema. This consumes
//! the checked structure; it neither decodes images nor grants a GPU adapter.

use serde_json::{json, Value};

use crate::model_container::BinaryChunk;
use crate::model_structure::{
    AccessorShape, AnimationInterpolation, AnimationPath, GlbResource, ModelAccessor,
    ModelAlphaMode, ModelImage, ModelMaterial, ModelNodeTransform, ModelNormalTexture,
    ModelOcclusionTexture, ModelPrimitive, ModelSampler, ModelStructure, ModelTextureInfo,
    MODEL_SAMPLER_MAG_FILTER, MODEL_SAMPLER_MIN_FILTER, MODEL_SAMPLER_WRAP,
};
use crate::{PackageError, Result};

const PROFILE: &str = "static-core-pbr-v1";
const TEXTURED_PROFILE: &str = "static-pbr-texture-v1";
const KTX2_PROFILE: &str = "static-ktx2-texture-v1";
const LOADER_VERSION: &str = "three-0.186.0-gltfloader";
const MAX_NODES: usize = 5000;
const MAX_ITEMS: usize = 16384;
const VK_FORMAT_RGBA8_UNORM: u32 = 37;
const VK_FORMAT_RGBA8_SRGB: u32 = 43;
const KHR_DF_MODEL_ETC1S: u8 = 163;
const KHR_DF_MODEL_UASTC: u8 = 166;

/// Image payload policy for the shared textured scene/material projection.
enum ImageProjection<'a> {
    /// PNG/JPEG sizes are read from the authored bytes by the caller.
    Raster,
    /// KTX2 containers are inspected here; package images are pinned by the caller.
    Ktx2 {
        glb: &'a [u8],
        external: &'a std::collections::BTreeMap<usize, Vec<u8>>,
    },
}

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
        AccessorShape::Vec3 | AccessorShape::Vec4 => {
            if accessor.component_type != 5126 {
                return Err(unavailable(
                    "core profile requires FLOAT VEC3/VEC4 accessors",
                ));
            }
        }
        AccessorShape::Scalar => {
            if accessor.component_type != 5126
                && ![5121, 5123, 5125].contains(&accessor.component_type)
            {
                return Err(unavailable(
                    "core profile requires FLOAT SCALAR or unsigned SCALAR accessors",
                ));
            }
        }
        _ => {
            return Err(unavailable(
                "core profile allows only VEC3/VEC4 and SCALAR accessors",
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
            for semantic in ["POSITION", "NORMAL"] {
                let accessor = &structure.accessors[primitive.attributes[semantic]];
                if accessor.shape != AccessorShape::Vec3 || accessor.component_type != 5126 {
                    return Err(unavailable(
                        "core profile requires FLOAT VEC3 POSITION/NORMAL",
                    ));
                }
            }
            if let Some(indices) = primitive.indices {
                let accessor = &structure.accessors[indices];
                if accessor.shape != AccessorShape::Scalar
                    || ![5121, 5123, 5125].contains(&accessor.component_type)
                {
                    return Err(unavailable("core profile requires unsigned SCALAR indices"));
                }
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
    let animation = animation_projection(structure, binary, &reachable)?;
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
            .copied()
            .chain(
                animation
                    .as_ref()
                    .into_iter()
                    .flat_map(|animation| animation.view_indices.iter().copied()),
            )
            .collect::<std::collections::BTreeSet<_>>()
            .iter()
            .map(|&index| structure.buffer_views[index].range.bytes),
    )?;
    let geometry_count = geometries.len();
    let attribute_count = used_layouts.len();
    let backing_count = used_views.len();
    let geometry_facts: Vec<Value> = geometries.into_values().collect();
    let mut facts = json!({
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
    });
    if let Some(animation) = animation {
        let clip_count = animation.clips.len();
        facts["animations"] = json!(animation.clips);
        facts["resources"]["animationAccessors"] = json!(animation.accessors);
        facts["resources"]["animationBufferViews"] = json!(animation.views);
        facts["resources"]["animationCount"] = json!(clip_count);
        facts["resources"]["animationChannelCount"] = json!(animation.channel_count);
        facts["resources"]["animationCpuBytes"] = json!(animation.cpu_bytes);
    }
    Ok(facts)
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
        AccessorShape::Vec2 | AccessorShape::Vec3 | AccessorShape::Vec4 => {
            if accessor.component_type != 5126 {
                return Err(unavailable(
                    "textured profile requires FLOAT UV/VEC3/VEC4 accessors",
                ));
            }
        }
        AccessorShape::Scalar => {
            if accessor.component_type != 5126
                && ![5121, 5123, 5125].contains(&accessor.component_type)
            {
                return Err(unavailable(
                    "textured profile requires FLOAT SCALAR or unsigned SCALAR accessors",
                ));
            }
        }
        _ => {
            return Err(unavailable(
                "textured profile allows VEC2/VEC3/VEC4/SCALAR accessors",
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

/// Three's program cache key for this qualified profile reduces to the texture
/// channel of each present slot, whether alpha test is active, sidedness, the
/// geometry's morph target count and whether the draw is skinned. Base factors,
/// opacity and blending are uniforms/state, not shader variants. `None` is the
/// loader's default PBR material.
fn material_program_key(facts: Option<&Value>, morph_targets: usize, skinning: bool) -> String {
    let channel = |slot: &str| {
        facts
            .and_then(|facts| facts[slot].get("texCoord"))
            .and_then(Value::as_u64)
            .map(|value| value.to_string())
            .unwrap_or_else(|| "-".to_owned())
    };
    let alpha_test = facts.is_some_and(|facts| {
        facts["alphaMode"] == "MASK"
            && facts["alphaCutoff"]
                .as_f64()
                .is_some_and(|cutoff| cutoff > 0.0)
    });
    // Three keys `opaque` (transparent false + normal blending) into the cache.
    let opaque = facts.is_none_or(|facts| facts["alphaMode"] != "BLEND");
    let double_sided = facts.is_some_and(|facts| facts["doubleSided"] == true);
    [
        channel("baseColorTexture"),
        channel("metallicRoughnessTexture"),
        channel("normalTexture"),
        channel("occlusionTexture"),
        channel("emissiveTexture"),
        alpha_test.to_string(),
        opaque.to_string(),
        double_sided.to_string(),
        format!("morph:{morph_targets}"),
        format!("skin:{skinning}"),
    ]
    .join(":")
}

fn image_facts(
    index: usize,
    image: &ModelImage,
    model_path: &str,
    projection: &ImageProjection<'_>,
) -> Result<(Value, Option<u64>)> {
    match projection {
        ImageProjection::Raster => {
            raster_image_facts(index, image, model_path).map(|facts| (facts, None))
        }
        ImageProjection::Ktx2 { glb, external } => {
            ktx2_image_facts(index, image, model_path, glb, external)
        }
    }
}

fn raster_image_facts(index: usize, image: &ModelImage, model_path: &str) -> Result<Value> {
    match image {
        ModelImage::Embedded { range, mime, .. } => {
            if mime != "image/png" && mime != "image/jpeg" {
                return Err(unavailable(
                    "textured profile requires PNG/JPEG embedded images",
                ));
            }
            Ok(json!({"index": index, "source": "embedded", "mime": mime, "bytes": range.bytes}))
        }
        ModelImage::Package { path, mime, .. } => {
            if mime != "image/png" && mime != "image/jpeg" {
                return Err(unavailable(
                    "textured profile requires PNG/JPEG package images",
                ));
            }
            // The loader profile keeps the authored model-relative URI.
            let uri = model_path
                .rsplit_once('/')
                .map(|(directory, _)| directory)
                .and_then(|directory| path.strip_prefix(directory))
                .and_then(|rest| rest.strip_prefix('/'))
                .unwrap_or(path);
            Ok(json!({"index": index, "source": "external", "mime": mime, "uri": uri}))
        }
    }
}

fn ktx2_image_facts(
    index: usize,
    image: &ModelImage,
    model_path: &str,
    glb: &[u8],
    external: &std::collections::BTreeMap<usize, Vec<u8>>,
) -> Result<(Value, Option<u64>)> {
    let (source, bytes): (Value, &[u8]) = match image {
        ModelImage::Embedded { range, mime, .. } => {
            if mime != "image/ktx2" {
                return Err(unavailable(
                    "KTX2 profile requires image/ktx2 embedded images",
                ));
            }
            let start =
                usize::try_from(range.offset).map_err(|_| unavailable("KTX2 model image range"))?;
            let length =
                usize::try_from(range.bytes).map_err(|_| unavailable("KTX2 model image range"))?;
            let bytes = glb
                .get(start..start.saturating_add(length))
                .ok_or_else(|| unavailable("KTX2 model image range"))?;
            (
                json!({"index": index, "source": "embedded", "mime": mime, "bytes": range.bytes}),
                bytes,
            )
        }
        ModelImage::Package { path, mime, .. } => {
            if mime != "image/ktx2" {
                return Err(unavailable(
                    "KTX2 profile requires image/ktx2 package images",
                ));
            }
            let uri = model_path
                .rsplit_once('/')
                .map(|(directory, _)| directory)
                .and_then(|directory| path.strip_prefix(directory))
                .and_then(|rest| rest.strip_prefix('/'))
                .unwrap_or(path);
            let bytes = external
                .get(&index)
                .ok_or_else(|| unavailable("external KTX2 model images require pinned bytes"))?;
            (
                json!({"index": index, "source": "external", "mime": mime, "uri": uri}),
                bytes.as_slice(),
            )
        }
    };
    let container = crate::texture_container::inspect_ktx2(bytes, bytes.len() as u64)?;
    if container.levels.is_empty() || container.generate_mipmaps {
        return Err(unavailable("KTX2 profile requires declared texture levels"));
    }
    let basis = matches!(
        container.data_format.color_model,
        KHR_DF_MODEL_ETC1S | KHR_DF_MODEL_UASTC
    );
    let level_byte_lengths: Vec<u64> = container.levels.iter().map(|level| level.bytes).collect();
    let (upload_bytes, basis_srgb) = if basis {
        match container.data_format.color_model {
            KHR_DF_MODEL_ETC1S if container.supercompression == 1 => {}
            KHR_DF_MODEL_UASTC if container.supercompression == 0 => {}
            _ => {
                return Err(unavailable(
                    "KTX2 Basis requires ETC1S+BasisLZ or UASTC storage",
                ))
            }
        }
        match crate::ktx2_upload::plan_ktx2_upload(
            &container,
            crate::ktx2_upload::Ktx2UploadCapabilities::default(),
        )? {
            crate::ktx2_upload::Ktx2UploadPlan::Transcode {
                rgba_bytes, srgb, ..
            } => (rgba_bytes, Some(srgb)),
            _ => return Err(unavailable("KTX2 Basis requires transcoding")),
        }
    } else {
        if container.supercompression != 0 {
            return Err(unavailable(
                "KTX2 profile requires uncompressed texture levels",
            ));
        }
        if !matches!(
            container.vk_format,
            VK_FORMAT_RGBA8_UNORM | VK_FORMAT_RGBA8_SRGB
        ) {
            return Err(unavailable(
                "KTX2 profile requires RGBA8 UNORM/SRGB textures",
            ));
        }
        if !matches!(
            crate::ktx2_upload::plan_ktx2_upload(
                &container,
                crate::ktx2_upload::Ktx2UploadCapabilities::default()
            )?,
            crate::ktx2_upload::Ktx2UploadPlan::Direct { .. }
        ) {
            return Err(unavailable(
                "KTX2 profile requires a direct GPU upload format",
            ));
        }
        (checked_sum(level_byte_lengths.iter().copied())?, None)
    };
    let mut facts = source;
    facts["width"] = json!(container.width);
    facts["height"] = json!(container.height);
    facts["vkFormat"] = json!(container.vk_format);
    facts["srgb"] = json!(basis_srgb.unwrap_or(container.vk_format == VK_FORMAT_RGBA8_SRGB));
    facts["levelCount"] = json!(level_byte_lengths.len());
    facts["levelByteLengths"] = json!(level_byte_lengths);
    facts["uploadBytes"] = json!(upload_bytes);
    if basis_srgb.is_some() {
        facts["transcode"] = json!(true);
        facts["rgbaBytes"] = json!(upload_bytes);
    }
    Ok((facts, Some(upload_bytes)))
}

struct AnimationProjection {
    clips: Vec<Value>,
    accessors: Vec<Value>,
    views: Vec<Value>,
    view_indices: std::collections::BTreeSet<usize>,
    cpu_bytes: u64,
    channel_count: u64,
}

fn animation_shape(shape: AccessorShape) -> Option<&'static str> {
    match shape {
        AccessorShape::Scalar => Some("SCALAR"),
        AccessorShape::Vec3 => Some("VEC3"),
        AccessorShape::Vec4 => Some("VEC4"),
        _ => None,
    }
}

fn record_animation_accessor(
    structure: &ModelStructure,
    binary: &BinaryChunk,
    index: usize,
    accessors: &mut std::collections::BTreeMap<usize, Value>,
    views: &mut std::collections::BTreeMap<usize, Value>,
    view_indices: &mut std::collections::BTreeSet<usize>,
    accessor_bytes: &mut u64,
) -> Result<()> {
    if accessors.contains_key(&index) {
        return Ok(());
    }
    let accessor = structure
        .accessors
        .get(index)
        .ok_or_else(|| unavailable("animation accessor index"))?;
    if accessor.normalized || accessor.stride != accessor.element_bytes {
        return Err(unavailable(
            "animation profile requires packed unnormalized accessors",
        ));
    }
    let view = structure
        .buffer_views
        .get(accessor.buffer_view)
        .ok_or_else(|| unavailable("animation accessor bufferView"))?;
    let item_bytes = accessor
        .count
        .checked_mul(accessor.element_bytes)
        .ok_or_else(|| unavailable("animation accessor bytes overflow"))?;
    accessors.insert(
        index,
        json!({
            "index": index,
            "viewIndex": accessor.buffer_view,
            "componentType": accessor.component_type,
            "type": animation_shape(accessor.shape).expect("checked animation shape"),
            "count": accessor.count,
            "byteOffset": accessor.byte_offset,
            "byteLength": item_bytes
        }),
    );
    views.entry(accessor.buffer_view).or_insert_with(|| {
        json!({
            "index": accessor.buffer_view,
            "byteOffset": view_offset(&view.range, binary).expect("checked animation view"),
            "byteLength": view.range.bytes
        })
    });
    view_indices.insert(accessor.buffer_view);
    *accessor_bytes = checked_sum([*accessor_bytes, item_bytes])?;
    Ok(())
}

fn accessor_facts_for(structure: &ModelStructure, index: usize) -> Result<Value> {
    let accessor = structure
        .accessors
        .get(index)
        .ok_or_else(|| unavailable("textured profile accessor index"))?;
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
}

fn animation_projection(
    structure: &ModelStructure,
    binary: &BinaryChunk,
    reachable: &std::collections::BTreeSet<usize>,
) -> Result<Option<AnimationProjection>> {
    if structure.animations.is_empty() {
        return Ok(None);
    }
    let mut names = std::collections::BTreeSet::new();
    let mut clips = Vec::with_capacity(structure.animations.len());
    let mut accessors = std::collections::BTreeMap::new();
    let mut views = std::collections::BTreeMap::new();
    let mut view_indices = std::collections::BTreeSet::new();
    let mut accessor_bytes = 0_u64;
    let mut channel_count = 0_u64;
    for (clip_index, animation) in structure.animations.iter().enumerate() {
        let name = animation
            .name
            .clone()
            .unwrap_or_else(|| format!("animation_{clip_index}"));
        if name.is_empty() || name.len() > 128 || !names.insert(name.clone()) {
            return Err(unavailable("animation names must be unique and bounded"));
        }
        if !animation.duration_upper_bound.is_finite() || animation.duration_upper_bound <= 0.0 {
            return Err(unavailable(
                "animation clips require a positive declared duration",
            ));
        }
        let mut channels = Vec::with_capacity(animation.channels.len());
        for channel in &animation.channels {
            let node = channel
                .target_node
                .ok_or_else(|| unavailable("animation channels require a target node"))?;
            if node >= structure.nodes.len() || !reachable.contains(&node) {
                return Err(unavailable("animation target node is not reachable"));
            }
            let (path, components) = match channel.path {
                AnimationPath::Translation => ("translation", 3_u64),
                AnimationPath::Rotation => ("rotation", 4_u64),
                AnimationPath::Scale => ("scale", 3_u64),
                AnimationPath::Weights => {
                    let mesh = structure.nodes[node]
                        .mesh
                        .ok_or_else(|| unavailable("weights animation requires a mesh"))?;
                    let count = structure
                        .meshes
                        .get(mesh)
                        .ok_or_else(|| unavailable("weights animation mesh index"))?
                        .morph_target_count;
                    if count == 0 {
                        return Err(unavailable(
                            "weights animation requires a morph target mesh",
                        ));
                    }
                    ("weights", count as u64)
                }
            };
            let sampler = animation
                .samplers
                .get(channel.sampler)
                .ok_or_else(|| unavailable("animation sampler index"))?;
            let input = structure
                .accessors
                .get(sampler.input)
                .ok_or_else(|| unavailable("animation input accessor"))?;
            let output = structure
                .accessors
                .get(sampler.output)
                .ok_or_else(|| unavailable("animation output accessor"))?;
            if input.normalized
                || input.component_type != 5126
                || input.shape != AccessorShape::Scalar
                || input.count == 0
            {
                return Err(unavailable(
                    "animation times require packed FLOAT SCALAR accessors",
                ));
            }
            let shape = match path {
                "rotation" => AccessorShape::Vec4,
                "weights" => AccessorShape::Scalar,
                _ => AccessorShape::Vec3,
            };
            let multiplier = if sampler.interpolation == AnimationInterpolation::CubicSpline {
                3_u64
            } else {
                1_u64
            };
            let required_values = if path == "weights" {
                input
                    .count
                    .checked_mul(components)
                    .and_then(|count| count.checked_mul(multiplier))
                    .ok_or_else(|| unavailable("animation output count overflow"))?
            } else {
                input
                    .count
                    .checked_mul(multiplier)
                    .ok_or_else(|| unavailable("animation output count overflow"))?
            };
            if output.normalized
                || output.component_type != 5126
                || output.shape != shape
                || output.count != required_values
            {
                return Err(unavailable("animation output accessor shape or count"));
            }
            record_animation_accessor(
                structure,
                binary,
                sampler.input,
                &mut accessors,
                &mut views,
                &mut view_indices,
                &mut accessor_bytes,
            )?;
            record_animation_accessor(
                structure,
                binary,
                sampler.output,
                &mut accessors,
                &mut views,
                &mut view_indices,
                &mut accessor_bytes,
            )?;
            let interpolation = match sampler.interpolation {
                AnimationInterpolation::Step => "STEP",
                AnimationInterpolation::Linear => "LINEAR",
                AnimationInterpolation::CubicSpline => "CUBICSPLINE",
            };
            channels.push(json!({
                "node": node,
                "path": path,
                "interpolation": interpolation,
                "inputAccessor": sampler.input,
                "outputAccessor": sampler.output,
                "times": input.count,
                "values": output.count,
                "components": components
            }));
            channel_count = checked_sum([channel_count, 1])?;
        }
        if channels.is_empty() {
            return Err(unavailable("animation clips require target channels"));
        }
        clips.push(json!({
            "index": clip_index,
            "name": name,
            "duration": animation.duration_upper_bound,
            "channels": channels
        }));
        if clips.len() > MAX_ITEMS {
            return Err(unavailable("animation clip limit"));
        }
    }
    // Conservative mixer binding allowance per resolved channel; track arrays
    // are BIN views already counted by the caller's CPU backing bytes.
    let cpu_bytes = checked_sum([accessor_bytes, channel_count.saturating_mul(512)])?;
    Ok(Some(AnimationProjection {
        clips,
        accessors: accessors.into_values().collect(),
        views: views.into_values().collect(),
        view_indices,
        cpu_bytes,
        channel_count,
    }))
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

/// Textured PBR facts for the shipped profile. Embedded images and package
/// images (authored model-relative URI) are both projected; the caller owns
/// texture URL publication and pinning.
pub fn static_textured_profile_facts(
    resource: &GlbResource,
    encoded_bytes: u64,
    model_path: &str,
) -> Result<Value> {
    textured_profile_facts(
        resource,
        encoded_bytes,
        model_path,
        &ImageProjection::Raster,
    )
}

/// Direct-format KTX2 facts for the shipped profile. Embedded containers are
/// inspected from the complete GLB stream; package containers must be supplied
/// as bytes read from the caller's pinned package files.
pub fn static_ktx2_profile_facts(
    glb: &[u8],
    resource: &GlbResource,
    encoded_bytes: u64,
    model_path: &str,
    external: &std::collections::BTreeMap<usize, Vec<u8>>,
) -> Result<Value> {
    textured_profile_facts(
        resource,
        encoded_bytes,
        model_path,
        &ImageProjection::Ktx2 { glb, external },
    )
}

fn textured_profile_facts(
    resource: &GlbResource,
    encoded_bytes: u64,
    model_path: &str,
    projection: &ImageProjection<'_>,
) -> Result<Value> {
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
    if !structure.skins.is_empty() || structure.camera_count != 0 {
        return Err(unavailable("textured profile rejects cameras and skins"));
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
            if !matches!(primitive.authored_mode, None | Some(4)) {
                return Err(unavailable("textured profile requires TRIANGLES"));
            }
            let position = *primitive
                .attributes
                .get("POSITION")
                .ok_or_else(|| unavailable("textured profile requires POSITION"))?;
            let vertex_count = structure
                .accessors
                .get(position)
                .ok_or_else(|| unavailable("textured profile position accessor"))?
                .count;
            if primitive.targets.len() != mesh.morph_target_count {
                return Err(unavailable(
                    "textured profile requires every primitive to author the mesh morph target count",
                ));
            }
            for target in &primitive.targets {
                if target.len() != 2
                    || !target.contains_key("POSITION")
                    || !target.contains_key("NORMAL")
                {
                    return Err(unavailable(
                        "textured profile morph targets require POSITION and NORMAL only",
                    ));
                }
                for semantic in ["POSITION", "NORMAL"] {
                    let accessor = structure
                        .accessors
                        .get(target[semantic])
                        .ok_or_else(|| unavailable("textured profile morph accessor"))?;
                    if accessor.shape != AccessorShape::Vec3
                        || accessor.component_type != 5126
                        || accessor.normalized
                        || accessor.stride != accessor.element_bytes
                        || accessor.count != vertex_count
                        || accessor.count > 8192
                    {
                        return Err(unavailable(
                            "textured profile morph targets require packed FLOAT VEC3 vertex deltas within the morph texture width",
                        ));
                    }
                }
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
    let animation = animation_projection(structure, binary, &reachable)?;
    let mut used_materials = std::collections::BTreeSet::new();
    let mut used_meshes = std::collections::BTreeSet::new();
    let mut used_views = std::collections::BTreeSet::new();
    let mut used_accessors = std::collections::BTreeSet::new();
    let mut morph_accessors = std::collections::BTreeSet::new();
    let mut used_textures = std::collections::BTreeSet::new();
    let mut used_images = std::collections::BTreeSet::new();
    let mut program_keys = std::collections::BTreeSet::new();
    let mut geometries: std::collections::BTreeMap<String, Value> =
        std::collections::BTreeMap::new();
    let mut scene_nodes = Vec::with_capacity(reachable.len());
    let mut draw_calls = 0u64;
    let mut triangles = 0u64;
    let mut object_count = 1u64;
    for &index in &reachable {
        let node = &structure.nodes[index];
        if let Some(mesh) = node.mesh {
            used_meshes.insert(mesh);
        }
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
            let mut morph_facts = Vec::new();
            for target in &primitive.targets {
                let target_position = target["POSITION"];
                let target_normal = target["NORMAL"];
                morph_accessors.insert(target_position);
                morph_accessors.insert(target_normal);
                morph_facts.push(json!({
                    "positionAccessor": target_position,
                    "normalAccessor": target_normal
                }));
            }
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
            program_keys.insert(material_program_key(
                material
                    .map(|material| material_facts(material, &structure.materials[material]))
                    .as_ref(),
                primitive.targets.len(),
                false,
            ));
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
            let mut key = format!("{index_part}:{attributes}:{mode}");
            // GLTFLoader's primitive cache appends each target's attribute map.
            for target in &primitive.targets {
                key.push(':');
                for (semantic, accessor) in target {
                    key.push_str(&format!("{semantic}:{accessor};"));
                }
            }
            let geometry_key = key.clone();
            geometries.entry(key).or_insert_with(|| {
                let mut bounding_min = accessor.min.clone().expect("checked bounds");
                let mut bounding_max = accessor.max.clone().expect("checked bounds");
                let mut displacement = [0.0_f64; 3];
                for target in &primitive.targets {
                    let target = &structure.accessors[target["POSITION"]];
                    if let (Some(min), Some(max)) = (&target.min, &target.max) {
                        for (axis, value) in displacement.iter_mut().enumerate() {
                            *value = value.max(min[axis].abs().max(max[axis].abs()));
                        }
                    }
                }
                for (axis, value) in displacement.iter().enumerate() {
                    bounding_min[axis] -= value;
                    bounding_max[axis] += value;
                }
                let mut geometry = json!({
                    "key": geometry_key,
                    "material": material,
                    "positionAccessor": position,
                    "normalAccessor": normal,
                    "uvAccessors": uv_facts,
                    "morphTargets": morph_facts,
                    "indexAccessor": primitive.indices,
                    "mode": primitive.authored_mode,
                    "triangles": primitive.triangles_upper_bound,
                    "positionMin": array(accessor.min.as_ref().expect("checked bounds")),
                    "positionMax": array(accessor.max.as_ref().expect("checked bounds"))
                });
                // GLTFLoader expands the base accessor bounds by the largest
                // per-axis absolute morph POSITION delta before instancing.
                if !primitive.targets.is_empty() {
                    geometry["boundingBoxMin"] = array(&bounding_min);
                    geometry["boundingBoxMax"] = array(&bounding_max);
                }
                geometry
            });
        }
        scene_nodes.push(json!({
            "index": index,
            "parentIndex": parents[index],
            "meshIndex": node.mesh,
            "morphTargetCount": node.mesh.map_or(0, |mesh| structure.meshes[mesh].morph_target_count),
            "morphWeights": structure.node_morph_weights[index],
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
        .chain(morph_accessors.iter())
        .map(|&index| &structure.accessors[index])
    {
        used_views.insert(accessor.buffer_view);
    }
    let accessor_facts: Vec<Value> = used_accessors
        .iter()
        .map(|&index| accessor_facts_for(structure, index))
        .collect::<Result<Vec<_>>>()?;
    let morph_accessor_facts: Vec<Value> = morph_accessors
        .iter()
        .map(|&index| accessor_facts_for(structure, index))
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
    let mut image_upload_bytes = 0_u64;
    let image_facts_used: Vec<Value> = used_images
        .iter()
        .map(|&index| {
            let (facts, upload) = image_facts(
                index,
                structure
                    .images
                    .get(index)
                    .ok_or_else(|| unavailable("textured profile image index"))?,
                model_path,
                projection,
            )?;
            if let Some(upload) = upload {
                image_upload_bytes = checked_sum([image_upload_bytes, upload])?;
            }
            Ok(facts)
        })
        .collect::<Result<Vec<_>>>()?;
    let texture_facts: Vec<Value> = used_textures
        .iter()
        .map(|&index| {
            let texture = structure
                .textures
                .get(index)
                .ok_or_else(|| unavailable("textured profile texture index"))?;
            let (source, _) = image_facts(
                texture.source,
                structure
                    .images
                    .get(texture.source)
                    .ok_or_else(|| unavailable("textured profile texture image"))?,
                model_path,
                projection,
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
    let mesh_facts: Vec<Value> = used_meshes
        .iter()
        .map(|&index| {
            let mesh = &structure.meshes[index];
            json!({
                "index": index,
                "morphTargetCount": mesh.morph_target_count,
                "defaultWeights": mesh.default_weights
            })
        })
        .collect();
    let program_count = program_keys.len();
    let gpu_buffer_bytes = checked_sum(
        accessor_facts
            .iter()
            .map(|fact| fact["byteLength"].as_u64().expect("checked byte length")),
    )?;
    let cpu_backing_bytes = checked_sum(
        used_views
            .iter()
            .copied()
            .chain(
                animation
                    .as_ref()
                    .into_iter()
                    .flat_map(|animation| animation.view_indices.iter().copied()),
            )
            .collect::<std::collections::BTreeSet<_>>()
            .iter()
            .map(|&index| structure.buffer_views[index].range.bytes),
    )?;
    let geometry_count = geometries.len();
    let geometry_facts: Vec<Value> = geometries.into_values().collect();
    let mut morph_texture_bytes = 0_u64;
    for geometry in &geometry_facts {
        let targets = geometry["morphTargets"]
            .as_array()
            .map_or(0, std::vec::Vec::len);
        if targets == 0 {
            continue;
        }
        let vertices = structure.accessors[geometry["positionAccessor"]
            .as_u64()
            .expect("checked position") as usize]
            .count;
        let bytes = vertices
            .checked_mul(2)
            .and_then(|value| value.checked_mul(4 * 4))
            .and_then(|value| value.checked_mul(targets as u64))
            .ok_or_else(|| unavailable("textured profile morph texture bytes overflow"))?;
        morph_texture_bytes = checked_sum([morph_texture_bytes, bytes])?;
    }
    let profile = match projection {
        ImageProjection::Raster => TEXTURED_PROFILE,
        ImageProjection::Ktx2 { .. } => KTX2_PROFILE,
    };
    let mut facts = json!({
        "profile": profile,
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
        "meshes": mesh_facts,
        "textures": texture_facts,
        "images": image_facts_used,
        "resources": {
            "geometries": geometry_facts,
            "accessors": accessor_facts,
            "bufferViews": view_facts,
            "geometryCount": geometry_count,
            "attributeCount": used_accessors.len() + morph_accessors.len(),
            "backingCount": used_views.len(),
            "gpuBufferBytes": gpu_buffer_bytes,
            "cpuBackingBytes": cpu_backing_bytes,
            "materialCount": used_materials.len(),
            "allocatedMaterialCount": used_materials.len() * 2,
            "programCount": program_count,
            "textureCount": used_textures.len(),
            "imageCount": used_images.len()
        }
    });
    if matches!(projection, ImageProjection::Ktx2 { .. }) {
        facts["resources"]["imageUploadBytes"] = json!(image_upload_bytes);
    }
    if !morph_accessor_facts.is_empty() {
        facts["resources"]["morphAccessors"] = json!(morph_accessor_facts);
        facts["resources"]["morphTextureBytes"] = json!(morph_texture_bytes);
    }
    if let Some(animation) = animation {
        let clip_count = animation.clips.len();
        facts["animations"] = json!(animation.clips);
        facts["resources"]["animationAccessors"] = json!(animation.accessors);
        facts["resources"]["animationBufferViews"] = json!(animation.views);
        facts["resources"]["animationCount"] = json!(clip_count);
        facts["resources"]["animationChannelCount"] = json!(animation.channel_count);
        facts["resources"]["animationCpuBytes"] = json!(animation.cpu_bytes);
    }
    Ok(facts)
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
    image_upload_bytes(bytes, mime)
}

/// Declared upload bound for one PNG/JPEG texture: `2 × w × h × 4` covers the
/// base level and a conservative full mip chain.
pub fn image_upload_bytes(bytes: &[u8], mime: &str) -> Result<u64> {
    let (width, height) = match mime {
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

    fn animated_triangle(name: Option<&str>, path: &str, interpolation: &str) -> Vec<u8> {
        let mut bin = vec![0_u8; 112];
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
        for (index, value) in [0.0_f32, 1.0].iter().enumerate() {
            bin[80 + index * 4..80 + index * 4 + 4].copy_from_slice(&value.to_le_bytes());
        }
        for (index, value) in [0.0_f32, 0.0, 0.0, 0.5, 0.0, 0.0].iter().enumerate() {
            bin[88 + index * 4..88 + index * 4 + 4].copy_from_slice(&value.to_le_bytes());
        }
        let mut animation = json!({
            "samplers":[{"input":3,"output":4,"interpolation":interpolation}],
            "channels":[{"sampler":0,"target":{"node":0,"path":path}}]
        });
        if let Some(name) = name {
            animation["name"] = json!(name);
        }
        let document = json!({
            "asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[0]}],
            "nodes":[{"mesh":0,"name":"mesh"}],
            "meshes":[{"primitives":[{"attributes":{"POSITION":0,"NORMAL":1},"indices":2}]}],
            "buffers":[{"byteLength":bin.len()}],
            "bufferViews":[
                {"buffer":0,"byteOffset":0,"byteLength":36},
                {"buffer":0,"byteOffset":36,"byteLength":36},
                {"buffer":0,"byteOffset":72,"byteLength":8},
                {"buffer":0,"byteOffset":80,"byteLength":8},
                {"buffer":0,"byteOffset":88,"byteLength":24}],
            "accessors":[
                {"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]},
                {"bufferView":1,"componentType":5126,"count":3,"type":"VEC3"},
                {"bufferView":2,"componentType":5123,"count":3,"type":"SCALAR"},
                {"bufferView":3,"componentType":5126,"count":2,"type":"SCALAR","min":[0],"max":[1]},
                {"bufferView":4,"componentType":5126,"count":2,"type":"VEC3"}],
            "animations":[animation]
        });
        glb(document, &bin)
    }

    fn single_key_animation() -> Vec<u8> {
        let mut bin = vec![0_u8; 96];
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
        let document = json!({
            "asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[0]}],
            "nodes":[{"mesh":0,"name":"mesh"}],
            "meshes":[{"primitives":[{"attributes":{"POSITION":0,"NORMAL":1},"indices":2}]}],
            "buffers":[{"byteLength":bin.len()}],
            "bufferViews":[
                {"buffer":0,"byteOffset":0,"byteLength":36},
                {"buffer":0,"byteOffset":36,"byteLength":36},
                {"buffer":0,"byteOffset":72,"byteLength":8},
                {"buffer":0,"byteOffset":80,"byteLength":4},
                {"buffer":0,"byteOffset":84,"byteLength":12}],
            "accessors":[
                {"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]},
                {"bufferView":1,"componentType":5126,"count":3,"type":"VEC3"},
                {"bufferView":2,"componentType":5123,"count":3,"type":"SCALAR"},
                {"bufferView":3,"componentType":5126,"count":1,"type":"SCALAR","min":[0],"max":[0]},
                {"bufferView":4,"componentType":5126,"count":1,"type":"VEC3"}],
            "animations":[{"name":"still","samplers":[{"input":3,"output":4,"interpolation":"STEP"}],
                "channels":[{"sampler":0,"target":{"node":0,"path":"translation"}}]}]
        });
        glb(document, &bin)
    }

    #[test]
    fn static_core_facts_project_animation_clips_and_cpu_bytes() {
        let projected = facts(animated_triangle(Some("move"), "translation", "LINEAR")).unwrap();
        assert_eq!(projected["animations"][0]["name"], "move");
        assert_eq!(projected["animations"][0]["duration"], json!(1.0));
        let channel = &projected["animations"][0]["channels"][0];
        assert_eq!(channel["node"], 0);
        assert_eq!(channel["path"], "translation");
        assert_eq!(channel["interpolation"], "LINEAR");
        assert_eq!(channel["inputAccessor"], 3);
        assert_eq!(channel["outputAccessor"], 4);
        assert_eq!(channel["times"], 2);
        assert_eq!(channel["values"], 2);
        assert_eq!(channel["components"], 3);
        assert_eq!(projected["resources"]["animationCount"], 1);
        assert_eq!(projected["resources"]["animationChannelCount"], 1);
        assert_eq!(
            projected["resources"]["animationAccessors"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            projected["resources"]["animationBufferViews"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(projected["resources"]["animationCpuBytes"], 8 + 24 + 512);
        assert_eq!(projected["resources"]["cpuBackingBytes"], 80 + 32);
        assert_eq!(projected["resources"]["gpuBufferBytes"], 78);
        let unnamed = facts(animated_triangle(None, "scale", "STEP")).unwrap();
        assert_eq!(unnamed["animations"][0]["name"], "animation_0");
        assert_eq!(
            unnamed["animations"][0]["channels"][0]["interpolation"],
            "STEP"
        );
        assert_eq!(
            facts(single_key_animation()).unwrap_err().code,
            "model_profile_unavailable"
        );
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

    fn textured_animated_triangle() -> Vec<u8> {
        let times_offset = (104 + TEXTURED_PNG.len() + 3) & !3;
        let values_offset = times_offset + 8;
        let mut bin = vec![0_u8; values_offset + 24];
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
        bin[104..104 + TEXTURED_PNG.len()].copy_from_slice(TEXTURED_PNG);
        for (index, value) in [0.0_f32, 1.0].iter().enumerate() {
            bin[times_offset + index * 4..times_offset + index * 4 + 4]
                .copy_from_slice(&value.to_le_bytes());
        }
        for (index, value) in [0.0_f32, 0.0, 0.0, 1.0, 0.0, 0.0].iter().enumerate() {
            bin[values_offset + index * 4..values_offset + index * 4 + 4]
                .copy_from_slice(&value.to_le_bytes());
        }
        let document = json!({
            "asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[0]}],
            "nodes":[{"mesh":0,"name":"mesh"}],
            "meshes":[{"primitives":[{"attributes":{"POSITION":0,"NORMAL":1,"TEXCOORD_0":3},
                "indices":2,"material":0}]}],
            "buffers":[{"byteLength":bin.len()}],
            "bufferViews":[{"buffer":0,"byteOffset":0,"byteLength":36},
                {"buffer":0,"byteOffset":36,"byteLength":36},
                {"buffer":0,"byteOffset":72,"byteLength":24},
                {"buffer":0,"byteOffset":96,"byteLength":8},
                {"buffer":0,"byteOffset":104,"byteLength":TEXTURED_PNG.len()},
                {"buffer":0,"byteOffset":times_offset,"byteLength":8},
                {"buffer":0,"byteOffset":values_offset,"byteLength":24}],
            "accessors":[
                {"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]},
                {"bufferView":1,"componentType":5126,"count":3,"type":"VEC3"},
                {"bufferView":3,"componentType":5123,"count":3,"type":"SCALAR"},
                {"bufferView":2,"componentType":5126,"count":3,"type":"VEC2"},
                {"bufferView":5,"componentType":5126,"count":2,"type":"SCALAR","min":[0],"max":[1]},
                {"bufferView":6,"componentType":5126,"count":2,"type":"VEC3"}],
            "images":[{"bufferView":4,"mimeType":"image/png"}],
            "samplers":[{"magFilter":9728,"minFilter":9728,"wrapS":33071,"wrapT":33071}],
            "textures":[{"source":0,"sampler":0}],
            "materials":[{"pbrMetallicRoughness":{"baseColorFactor":[1,1,1,1],
                "baseColorTexture":{"index":0,"texCoord":0},"metallicFactor":0,"roughnessFactor":1},
                "alphaMode":"OPAQUE"}],
            "animations":[{"name":"move",
                "samplers":[{"input":4,"output":5,"interpolation":"LINEAR"}],
                "channels":[{"sampler":0,"target":{"node":0,"path":"translation"}}]}]
        });
        glb(document, &bin)
    }

    fn textured_morph_triangle() -> Vec<u8> {
        let morph_offset = (104 + TEXTURED_PNG.len() + 3) & !3;
        let normal_offset = morph_offset + 36;
        let times_offset = normal_offset + 36;
        let weights_offset = times_offset + 8;
        let mut bin = vec![0_u8; weights_offset + 8];
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
        bin[104..104 + TEXTURED_PNG.len()].copy_from_slice(TEXTURED_PNG);
        for (index, value) in [1.0_f32, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
            .iter()
            .enumerate()
        {
            bin[morph_offset + index * 4..morph_offset + index * 4 + 4]
                .copy_from_slice(&value.to_le_bytes());
        }
        for (index, value) in [0.0_f32, 1.0].iter().enumerate() {
            bin[times_offset + index * 4..times_offset + index * 4 + 4]
                .copy_from_slice(&value.to_le_bytes());
        }
        for (index, value) in [0.0_f32, 1.0].iter().enumerate() {
            bin[weights_offset + index * 4..weights_offset + index * 4 + 4]
                .copy_from_slice(&value.to_le_bytes());
        }
        let document = json!({
            "asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[0]}],
            "nodes":[{"mesh":0,"name":"mesh","weights":[0.5]}],
            "meshes":[{"weights":[0.25],"primitives":[
                {"attributes":{"POSITION":0,"NORMAL":1,"TEXCOORD_0":3},"indices":2,"material":0,
                 "targets":[{"POSITION":4,"NORMAL":5}]}]}],
            "buffers":[{"byteLength":bin.len()}],
            "bufferViews":[
                {"buffer":0,"byteOffset":0,"byteLength":36},
                {"buffer":0,"byteOffset":36,"byteLength":36},
                {"buffer":0,"byteOffset":72,"byteLength":24},
                {"buffer":0,"byteOffset":96,"byteLength":8},
                {"buffer":0,"byteOffset":104,"byteLength":TEXTURED_PNG.len()},
                {"buffer":0,"byteOffset":morph_offset,"byteLength":36},
                {"buffer":0,"byteOffset":normal_offset,"byteLength":36},
                {"buffer":0,"byteOffset":times_offset,"byteLength":8},
                {"buffer":0,"byteOffset":weights_offset,"byteLength":8}],
            "accessors":[
                {"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]},
                {"bufferView":1,"componentType":5126,"count":3,"type":"VEC3"},
                {"bufferView":3,"componentType":5123,"count":3,"type":"SCALAR"},
                {"bufferView":2,"componentType":5126,"count":3,"type":"VEC2"},
                {"bufferView":5,"componentType":5126,"count":3,"type":"VEC3","min":[1,0,0],"max":[1,0,0]},
                {"bufferView":6,"componentType":5126,"count":3,"type":"VEC3"},
                {"bufferView":7,"componentType":5126,"count":2,"type":"SCALAR","min":[0],"max":[1]},
                {"bufferView":8,"componentType":5126,"count":2,"type":"SCALAR"}],
            "images":[{"bufferView":4,"mimeType":"image/png"}],
            "samplers":[{"magFilter":9728,"minFilter":9728,"wrapS":33071,"wrapT":33071}],
            "textures":[{"source":0,"sampler":0}],
            "materials":[{"pbrMetallicRoughness":{"baseColorFactor":[1,1,1,1],
                "baseColorTexture":{"index":0,"texCoord":0},"metallicFactor":0,"roughnessFactor":1},
                "alphaMode":"OPAQUE"}],
            "animations":[{"name":"warp",
                "samplers":[{"input":6,"output":7,"interpolation":"LINEAR"}],
                "channels":[{"sampler":0,"target":{"node":0,"path":"weights"}}]}]
        });
        glb(document, &bin)
    }

    #[test]
    fn static_textured_morph_facts_cover_targets_weights_and_animation() {
        let bytes = textured_morph_triangle();
        let content = inspect_glb_resource_content(
            Cursor::new(&bytes),
            bytes.len() as u64,
            &manifest(),
            "assets/model.glb",
        )
        .unwrap();
        let facts =
            static_textured_profile_facts(content.resource(), content.bytes(), "assets/model.glb")
                .unwrap();
        assert_eq!(facts["profile"], TEXTURED_PROFILE);
        assert_eq!(facts["scene"]["nodes"][0]["morphTargetCount"], 1);
        assert_eq!(facts["scene"]["nodes"][0]["morphWeights"], json!([0.5]));
        assert_eq!(facts["meshes"][0]["morphTargetCount"], 1);
        assert_eq!(facts["meshes"][0]["defaultWeights"], json!([0.25]));
        let geometry = &facts["resources"]["geometries"][0];
        assert_eq!(
            geometry["key"],
            "2:NORMAL:1;POSITION:0;TEXCOORD_0:3;:undefined:NORMAL:5;POSITION:4;"
        );
        assert_eq!(geometry["morphTargets"][0]["positionAccessor"], 4);
        assert_eq!(geometry["morphTargets"][0]["normalAccessor"], 5);
        assert_eq!(geometry["boundingBoxMin"], json!([-1.0, 0.0, 0.0]));
        assert_eq!(geometry["boundingBoxMax"], json!([2.0, 1.0, 0.0]));
        assert_eq!(
            facts["resources"]["geometries"][0]["morphTargets"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(facts["resources"]["gpuBufferBytes"], 102);
        assert_eq!(
            facts["resources"]["morphAccessors"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(facts["resources"]["morphTextureBytes"], 3 * 2 * 4 * 4);
        assert_eq!(facts["resources"]["attributeCount"], 6);
        assert_eq!(facts["resources"]["backingCount"], 6);
        assert_eq!(facts["resources"]["programCount"], 1);
        let channel = &facts["animations"][0]["channels"][0];
        assert_eq!(channel["path"], "weights");
        assert_eq!(channel["components"], 1);
        assert_eq!(channel["times"], 2);
        assert_eq!(channel["values"], 2);
        assert_eq!(facts["resources"]["animationCpuBytes"], 8 + 8 + 512);
        assert_eq!(facts["resources"]["cpuBackingBytes"], 104 + 36 + 36 + 8 + 8);
    }

    #[test]
    fn static_textured_facts_share_the_animation_projection() {
        let bytes = textured_animated_triangle();
        let content = inspect_glb_resource_content(
            Cursor::new(&bytes),
            bytes.len() as u64,
            &manifest(),
            "assets/model.glb",
        )
        .unwrap();
        let facts =
            static_textured_profile_facts(content.resource(), content.bytes(), "assets/model.glb")
                .unwrap();
        assert_eq!(facts["profile"], TEXTURED_PROFILE);
        assert_eq!(facts["animations"][0]["name"], "move");
        assert_eq!(facts["animations"][0]["duration"], json!(1.0));
        assert_eq!(facts["animations"][0]["channels"][0]["path"], "translation");
        assert_eq!(facts["resources"]["animationCpuBytes"], 8 + 24 + 512);
        assert_eq!(facts["resources"]["animationChannelCount"], 1);
        assert_eq!(facts["resources"]["cpuBackingBytes"], 104 + 32);
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
        let facts =
            static_textured_profile_facts(content.resource(), content.bytes(), "assets/model.glb")
                .unwrap();
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

    fn ktx2_rgba8(vk_format: u32, supercompression: u32) -> Vec<u8> {
        const EDGE: usize = 2;
        const LEVEL_BYTES: usize = EDGE * EDGE * 4;
        let mut bytes = vec![0_u8; 196 + LEVEL_BYTES];
        bytes[..12].copy_from_slice(&[
            0xab, b'K', b'T', b'X', b' ', b'2', b'0', 0xbb, 13, 10, 26, 10,
        ]);
        for (offset, value) in [
            (12, vk_format),
            (16, 1),
            (20, EDGE as u32),
            (24, EDGE as u32),
            (28, 0),
            (32, 0),
            (36, 1),
            (40, 1),
            (44, supercompression),
            (48, 104),
            (52, 92),
            (104, 92),
        ] {
            bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        for (offset, value) in [
            (80, 196_u64),
            (88, LEVEL_BYTES as u64),
            (96, LEVEL_BYTES as u64),
        ] {
            bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
        }
        bytes[112..114].copy_from_slice(&2_u16.to_le_bytes());
        bytes[114..116].copy_from_slice(&88_u16.to_le_bytes());
        bytes[116..120].copy_from_slice(&[1, 1, 2, 0]);
        bytes[124] = 4;
        for (index, channel) in [0_u8, 1, 2, 15].into_iter().enumerate() {
            let sample = 132 + index * 16;
            bytes[sample..sample + 2].copy_from_slice(&((index as u16) * 8).to_le_bytes());
            bytes[sample + 2] = 8;
            bytes[sample + 3] = channel;
            bytes[sample + 12..sample + 16].copy_from_slice(&0xff_u32.to_le_bytes());
        }
        let pixels = [
            255_u8, 0, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255,
        ];
        bytes[196..].copy_from_slice(&pixels);
        bytes
    }

    fn ktx2_triangle(vk_format: u32, supercompression: u32, external: bool) -> Vec<u8> {
        ktx2_triangle_image(&ktx2_rgba8(vk_format, supercompression), external)
    }

    fn ktx2_triangle_image(ktx2: &[u8], external: bool) -> Vec<u8> {
        let mut bin = vec![0_u8; if external { 104 } else { 104 + ktx2.len() }];
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
        if !external {
            bin[104..].copy_from_slice(ktx2);
        }
        let mut views = vec![
            json!({"buffer":0,"byteOffset":0,"byteLength":36}),
            json!({"buffer":0,"byteOffset":36,"byteLength":36}),
            json!({"buffer":0,"byteOffset":72,"byteLength":24}),
            json!({"buffer":0,"byteOffset":96,"byteLength":8}),
        ];
        let image = if external {
            json!({"uri":"textures/red.ktx2","mimeType":"image/ktx2"})
        } else {
            views.push(json!({"buffer":0,"byteOffset":104,"byteLength":ktx2.len()}));
            json!({"bufferView":4,"mimeType":"image/ktx2"})
        };
        let document = json!({
            "asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[0]}],"nodes":[{"mesh":0}],
            "extensionsUsed":["KHR_texture_basisu"],"extensionsRequired":["KHR_texture_basisu"],
            "meshes":[{"primitives":[{"attributes":{"POSITION":0,"NORMAL":1,"TEXCOORD_0":3},
                "indices":2,"material":0}]}],
            "buffers":[{"byteLength":bin.len()}],
            "bufferViews":views,
            "accessors":[
                {"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]},
                {"bufferView":1,"componentType":5126,"count":3,"type":"VEC3"},
                {"bufferView":3,"componentType":5123,"count":3,"type":"SCALAR"},
                {"bufferView":2,"componentType":5126,"count":3,"type":"VEC2"}],
            "images":[image],
            "samplers":[{"magFilter":9728,"minFilter":9728,"wrapS":33071,"wrapT":33071}],
            "textures":[{"sampler":0,"extensions":{"KHR_texture_basisu":{"source":0}}}],
            "materials":[{"pbrMetallicRoughness":{"baseColorFactor":[1,1,1,1],
                "baseColorTexture":{"index":0,"texCoord":0},"metallicFactor":0,"roughnessFactor":1},
                "alphaMode":"OPAQUE"}]
        });
        glb(document, &bin)
    }

    fn ktx2_facts(bytes: &[u8]) -> Result<Value> {
        let content = inspect_glb_resource_content(
            Cursor::new(bytes),
            bytes.len() as u64,
            &manifest(),
            "assets/model.glb",
        )
        .unwrap();
        static_ktx2_profile_facts(
            bytes,
            content.resource(),
            content.bytes(),
            "assets/model.glb",
            &std::collections::BTreeMap::new(),
        )
    }

    #[test]
    fn static_ktx2_facts_project_direct_rgba8_containers() {
        let bytes = ktx2_triangle(43, 0, false);
        let facts = ktx2_facts(&bytes).unwrap();
        assert_eq!(facts["profile"], KTX2_PROFILE);
        assert_eq!(facts["declared"]["images"], 1);
        assert_eq!(facts["declared"]["textures"], 1);
        assert_eq!(facts["textures"][0]["source"]["source"], "embedded");
        assert_eq!(facts["images"][0]["mime"], "image/ktx2");
        assert_eq!(facts["images"][0]["width"], 2);
        assert_eq!(facts["images"][0]["height"], 2);
        assert_eq!(facts["images"][0]["vkFormat"], 43);
        assert_eq!(facts["images"][0]["srgb"], true);
        assert_eq!(facts["images"][0]["levelCount"], 1);
        assert_eq!(facts["images"][0]["levelByteLengths"], json!([16]));
        assert_eq!(facts["images"][0]["uploadBytes"], 16);
        assert_eq!(facts["resources"]["imageUploadBytes"], 16);
        assert_eq!(facts["resources"]["textureCount"], 1);
        assert_eq!(
            facts["resources"]["geometries"][0]["key"],
            "2:NORMAL:1;POSITION:0;TEXCOORD_0:3;:undefined"
        );
        // The raster profile still rejects KTX2 images.
        let content = inspect_glb_resource_content(
            Cursor::new(&bytes),
            bytes.len() as u64,
            &manifest(),
            "assets/model.glb",
        )
        .unwrap();
        assert_eq!(
            static_textured_profile_facts(content.resource(), content.bytes(), "assets/model.glb")
                .unwrap_err()
                .code,
            "model_profile_unavailable"
        );
    }

    #[test]
    fn static_ktx2_facts_reject_non_direct_and_compressed_containers() {
        for bytes in [
            ktx2_triangle(9, 0, false),
            ktx2_triangle(43, 3, false),
            ktx2_triangle(43, 1, false),
        ] {
            let code = ktx2_facts(&bytes).unwrap_err().code;
            assert!(
                code == "model_profile_unavailable" || code == "invalid_texture_container",
                "{code}"
            );
        }
    }

    fn uastc_red_container() -> Vec<u8> {
        // 4x4 UASTC solid-color (mode 8) block: opaque red, 16-byte block.
        let block = [
            0xf7_u8, 0x1f, 0x00, 0xe0, 0x1f, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ];
        let dfd_bytes = 44_u32;
        let dfd_offset = 80 + 24;
        let level_offset = dfd_offset + dfd_bytes as usize;
        let mut bytes = vec![0_u8; level_offset + block.len()];
        bytes[..12].copy_from_slice(&[
            0xab, b'K', b'T', b'X', b' ', b'2', b'0', 0xbb, 13, 10, 26, 10,
        ]);
        for (offset, value) in [
            (12, 0_u32),
            (16, 1),
            (20, 4),
            (24, 4),
            (28, 0),
            (32, 0),
            (36, 1),
            (40, 1),
            (44, 0),
            (48, dfd_offset as u32),
            (52, dfd_bytes),
            (56, 0),
            (60, 0),
        ] {
            bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        for (offset, value) in [
            (64, 0_u64),
            (72, 0),
            (80, level_offset as u64),
            (88, block.len() as u64),
            (96, block.len() as u64),
        ] {
            bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
        }
        bytes[dfd_offset..dfd_offset + 4].copy_from_slice(&dfd_bytes.to_le_bytes());
        bytes[dfd_offset + 8..dfd_offset + 10].copy_from_slice(&2_u16.to_le_bytes());
        bytes[dfd_offset + 10..dfd_offset + 12].copy_from_slice(&40_u16.to_le_bytes());
        bytes[dfd_offset + 12] = 166;
        bytes[dfd_offset + 13] = 1;
        bytes[dfd_offset + 14] = 2;
        bytes[dfd_offset + 16] = 3;
        bytes[dfd_offset + 17] = 3;
        bytes[dfd_offset + 20] = 16;
        bytes[dfd_offset + 30] = 128;
        bytes[dfd_offset + 40..dfd_offset + 44].copy_from_slice(&0xffff_ffff_u32.to_le_bytes());
        bytes[level_offset..].copy_from_slice(&block);
        bytes
    }

    #[test]
    fn static_ktx2_facts_project_basis_transcode_uploads() {
        // Real 64x64 ETC1S+BasisLZ mip chain (Khronos KTX-Software test asset).
        let etc1s = include_bytes!("../../../scripts/fixtures/basis-etc1s-mip.ktx2");
        let facts = ktx2_facts(&ktx2_triangle_image(etc1s, false)).unwrap();
        assert_eq!(facts["profile"], KTX2_PROFILE);
        let image = &facts["images"][0];
        assert_eq!(image["mime"], "image/ktx2");
        assert_eq!(
            (image["width"].as_u64(), image["height"].as_u64()),
            (Some(64), Some(64))
        );
        assert_eq!(image["vkFormat"], 0);
        assert_eq!(image["srgb"], true);
        assert_eq!(image["levelCount"], 7);
        assert_eq!(image["transcode"], true);
        assert_eq!(image["rgbaBytes"], 21_844);
        assert_eq!(image["uploadBytes"], 21_844);
        assert_eq!(facts["resources"]["imageUploadBytes"], 21_844);
        assert_eq!(facts["resources"]["textureCount"], 1);
        // UASTC is stored without supercompression and still transcodes.
        let facts = ktx2_facts(&ktx2_triangle_image(&uastc_red_container(), false)).unwrap();
        let image = &facts["images"][0];
        assert_eq!(
            (image["width"].as_u64(), image["height"].as_u64()),
            (Some(4), Some(4))
        );
        assert_eq!(image["levelCount"], 1);
        assert_eq!(image["transcode"], true);
        assert_eq!(image["rgbaBytes"], 64);
        assert_eq!(image["uploadBytes"], 64);
        assert_eq!(facts["resources"]["imageUploadBytes"], 64);
    }

    #[test]
    fn static_ktx2_facts_require_basis_storage_schemes() {
        let mut zstd = include_bytes!("../../../scripts/fixtures/basis-etc1s-mip.ktx2").to_vec();
        zstd[44..48].copy_from_slice(&2_u32.to_le_bytes());
        for level in 0..7 {
            let offset = 80 + level * 24 + 16;
            zstd[offset..offset + 8].copy_from_slice(&64_u64.to_le_bytes());
        }
        // ETC1S payloads must use BasisLZ, UASTC must be stored directly.
        let code = ktx2_facts(&ktx2_triangle_image(&zstd, false))
            .unwrap_err()
            .code;
        assert_eq!(code, "model_profile_unavailable");
    }

    #[test]
    fn static_ktx2_facts_consume_pinned_package_bytes() {
        let bytes = ktx2_triangle(37, 0, true);
        let mut manifest = manifest();
        manifest.files = serde_json::from_value(json!([{
            "path":"assets/textures/red.ktx2","bytes":212,"sha256":"ab".repeat(32),"mime":"image/ktx2"
        }]))
        .unwrap();
        manifest.assets = serde_json::from_value(json!([{
            "id":"red","kind":"texture","source":"assets/textures/red.ktx2","variants":[]
        }]))
        .unwrap();
        let content = inspect_glb_resource_content(
            Cursor::new(&bytes),
            bytes.len() as u64,
            &manifest,
            "assets/model.glb",
        )
        .unwrap();
        let external = std::collections::BTreeMap::from([(0, ktx2_rgba8(37, 0))]);
        let facts = static_ktx2_profile_facts(
            &bytes,
            content.resource(),
            content.bytes(),
            "assets/model.glb",
            &external,
        )
        .unwrap();
        assert_eq!(facts["images"][0]["source"], "external");
        assert_eq!(facts["images"][0]["uri"], "textures/red.ktx2");
        assert_eq!(facts["images"][0]["vkFormat"], 37);
        assert_eq!(facts["images"][0]["srgb"], false);
        assert_eq!(facts["resources"]["imageUploadBytes"], 16);
        assert_eq!(
            static_ktx2_profile_facts(
                &bytes,
                content.resource(),
                content.bytes(),
                "assets/model.glb",
                &std::collections::BTreeMap::new()
            )
            .unwrap_err()
            .code,
            "model_profile_unavailable"
        );
    }

    fn content_json_bytes(bytes: &[u8]) -> u64 {
        u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as u64
    }
}
