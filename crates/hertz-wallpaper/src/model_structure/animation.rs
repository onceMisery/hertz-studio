// SPDX-License-Identifier: MIT
//! Typed TRS and morph weights storage facts owned by the structure inspector.

use std::collections::BTreeSet;

use serde::{de::IgnoredAny, Deserialize, Deserializer};

use super::{
    at, checked_mul, component_precision, invalid, AccessorShape, Limited, ModelAccessor,
    ModelBufferView, ModelMesh, Node, Pending, MAX_MODEL_ANIMATIONS, MAX_MODEL_RECORDS,
};
use crate::{PackageError, Result};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
pub enum AnimationInterpolation {
    #[serde(rename = "STEP")]
    Step,
    #[default]
    #[serde(rename = "LINEAR")]
    Linear,
    #[serde(rename = "CUBICSPLINE")]
    CubicSpline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnimationPath {
    Translation,
    Rotation,
    Scale,
    Weights,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelAnimationSampler {
    pub input: usize,
    pub output: usize,
    pub interpolation: AnimationInterpolation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelAnimationChannel {
    pub sampler: usize,
    /// Missing node means the core channel is ignored; no target is invented.
    pub target_node: Option<usize>,
    pub path: AnimationPath,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModelAnimation {
    pub name: Option<String>,
    pub samplers: Vec<ModelAnimationSampler>,
    pub channels: Vec<ModelAnimationChannel>,
    /// Used sampler max declarations at f32 precision. The metadata API has
    /// not checked their actual values; numeric validation is separate.
    pub duration_upper_bound: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Animation {
    #[serde(default, deserialize_with = "non_null")]
    name: Option<String>,
    samplers: Limited<Sampler, MAX_MODEL_RECORDS>,
    channels: Limited<Channel, MAX_MODEL_RECORDS>,
    #[serde(default, rename = "extensions")]
    _extensions: Pending,
    #[serde(default, rename = "extras")]
    _extras: Option<IgnoredAny>,
}

/// The field may be omitted; an explicitly present array must contain a clip.
pub(super) fn nonempty_animations<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Limited<Animation, MAX_MODEL_ANIMATIONS>, D::Error> {
    let animations = Limited::deserialize(deserializer)?;
    if animations.0.is_empty() {
        return Err(serde::de::Error::custom(
            "animations must be nonempty when present",
        ));
    }
    Ok(animations)
}

schema!(Sampler {
    input: usize,
    output: usize,
    #[serde(default)]
    interpolation: AnimationInterpolation,
});
schema!(Channel {
    sampler: usize,
    target: Target,
});
schema!(Target {
    #[serde(default,deserialize_with="non_null")] node: Option<usize>,
    path: AnimationPath,
});

/// Missing optional fields get None through serde default; explicit null must
/// still fail the actual field type instead of becoming an ignored channel.
fn non_null<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> std::result::Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

pub(super) fn inspect_views(
    animations: &[Animation],
    accessors: &[ModelAccessor],
    views: &[ModelBufferView],
    mut assign: impl FnMut(usize, u8) -> Result<()>,
) -> Result<()> {
    for animation in animations {
        for sampler in &animation.samplers.0 {
            for index in [sampler.input, sampler.output] {
                let accessor = at(accessors, index, "animation accessor")?;
                let view = &views[accessor.buffer_view];
                if view.byte_stride.is_some() || view.target.is_some() {
                    return Err(invalid(
                        "animation bufferView cannot define byteStride or target",
                    ));
                }
                assign(accessor.buffer_view, 4)?;
            }
        }
    }
    Ok(())
}

pub(super) fn inspect_animations(
    animations: &[Animation],
    nodes: &[Node],
    accessors: &[ModelAccessor],
    meshes: &[ModelMesh],
) -> Result<Vec<ModelAnimation>> {
    let mut total_samplers = 0_usize;
    let mut total_channels = 0_usize;
    let mut result = Vec::with_capacity(animations.len());
    for animation in animations {
        total_samplers += animation.samplers.0.len();
        total_channels += animation.channels.0.len();
        if total_samplers > MAX_MODEL_RECORDS || total_channels > MAX_MODEL_RECORDS {
            return Err(PackageError::new(
                "model_structure_limit",
                "too many animation samplers or channels",
            ));
        }
        if animation.samplers.0.is_empty() || animation.channels.0.is_empty() {
            return Err(invalid("animation requires nonempty samplers and channels"));
        }
        let mut samplers = Vec::with_capacity(animation.samplers.0.len());
        for sampler in &animation.samplers.0 {
            let input = at(accessors, sampler.input, "animation input")?;
            at(accessors, sampler.output, "animation output")?;
            if input.component_type != 5126
                || input.normalized
                || input.shape != AccessorShape::Scalar
                || input.min.is_none()
                || input.max.is_none()
            {
                return Err(invalid(
                    "animation input requires FLOAT SCALAR with min and max",
                ));
            }
            if sampler.interpolation == AnimationInterpolation::CubicSpline && input.count < 2 {
                return Err(invalid("CUBICSPLINE requires at least two timestamps"));
            }
            samplers.push(ModelAnimationSampler {
                input: sampler.input,
                output: sampler.output,
                interpolation: sampler.interpolation,
            });
        }
        let mut channels = Vec::with_capacity(animation.channels.0.len());
        let mut targets = BTreeSet::new();
        let mut duration = 0_f64;
        for channel in &animation.channels.0 {
            let sampler = at(&samplers, channel.sampler, "animation channel sampler")?;
            let fact = ModelAnimationChannel {
                sampler: channel.sampler,
                target_node: channel.target.node,
                path: channel.target.path,
            };
            let Some(node_index) = channel.target.node else {
                channels.push(fact);
                continue;
            };
            let node = at(nodes, node_index, "animation target node")?;
            let morph_count = if channel.target.path == AnimationPath::Weights {
                let mesh = node
                    .mesh
                    .ok_or_else(|| invalid("weights animation target requires a mesh"))?;
                let count = at(meshes, mesh, "weights animation mesh")?.morph_target_count;
                if count == 0 {
                    return Err(invalid("weights animation target requires morph targets"));
                }
                count as u64
            } else {
                1
            };
            if node.matrix.is_some() && channel.target.path != AnimationPath::Weights {
                return Err(invalid("TRS animation cannot target a node with matrix"));
            }
            if !targets.insert((node_index, channel.target.path)) {
                return Err(invalid(
                    "animation contains duplicate node/property targets",
                ));
            }
            let input = &accessors[sampler.input];
            let output = &accessors[sampler.output];
            let shape = match channel.target.path {
                AnimationPath::Rotation => AccessorShape::Vec4,
                AnimationPath::Weights => AccessorShape::Scalar,
                _ => AccessorShape::Vec3,
            };
            if output.shape != shape {
                return Err(invalid(
                    "animation output shape disagrees with the target property",
                ));
            }
            let multiplier = if sampler.interpolation == AnimationInterpolation::CubicSpline {
                3
            } else {
                1
            };
            if output.count != checked_mul(checked_mul(input.count, morph_count)?, multiplier)? {
                return Err(invalid(
                    "animation output count disagrees with timestamp/interpolation layout",
                ));
            }
            let float_output = output.component_type == 5126 && !output.normalized;
            let normalized_output = matches!(
                channel.target.path,
                AnimationPath::Rotation | AnimationPath::Weights
            ) && output.normalized
                && [5120, 5121, 5122, 5123].contains(&output.component_type);
            if !float_output && !normalized_output {
                return Err(invalid(
                    "animation output component type disagrees with the target property",
                ));
            }
            duration = duration.max(component_precision(
                input.max.as_ref().expect("input bounds checked")[0],
                5126,
            ));
            channels.push(fact);
        }
        result.push(ModelAnimation {
            name: animation.name.clone(),
            samplers,
            channels,
            duration_upper_bound: duration,
        });
    }
    Ok(result)
}
