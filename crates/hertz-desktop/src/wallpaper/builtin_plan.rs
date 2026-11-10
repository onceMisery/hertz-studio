// SPDX-License-Identifier: MIT
//! Pure builtin composition admission and native single-raster planning.
//! Registry metadata declares source limits; author JSON never supplies DPI,
//! budget ceilings or a second raster. This module does not grant execution.

use std::collections::{BTreeMap, BTreeSet};

use hertz_wallpaper::document::{CompiledDocument, FinalPublicValues};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::budget::{BudgetCoordinator, OwnerKind};
use super::config::Fit;
use super::gl_plan::{self, CompositionOutputAllowance};
use super::image_prepare::{self, ImagePurpose, ImageTarget};
use super::jobs::JobError;

type Result<T> = std::result::Result<T, JobError>;

/// Supplied only by native selection callers after querying their actual target.
/// No Deserialize: these facts cannot be reconstructed from an author payload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TargetFacts {
    pub monitor_id: String,
    pub monitor_left: i32,
    pub monitor_top: i32,
    pub physical_width: u32,
    pub physical_height: u32,
    pub device_scale: f64,
    pub requested_quality: String,
    pub requested_fps: u32,
    pub refresh_hz: u32,
    pub purpose: ImagePurpose,
}

impl TargetFacts {
    pub(crate) fn from_monitor(
        monitor: &crate::native::WallpaperMonitor,
        configuration: &super::config::WallpaperConfig,
        purpose: ImagePurpose,
    ) -> Self {
        let requested_quality = match configuration.presentation().quality {
            crate::config::WallpaperQuality::Low => "low",
            crate::config::WallpaperQuality::Medium => "medium",
            crate::config::WallpaperQuality::High => "high",
        };
        Self {
            monitor_id: monitor.display_id(),
            monitor_left: monitor.left,
            monitor_top: monitor.top,
            // Invalid native dimensions stay invalid rather than becoming 1px.
            physical_width: u32::try_from(monitor.width).unwrap_or(0),
            physical_height: u32::try_from(monitor.height).unwrap_or(0),
            device_scale: crate::native::verified_wallpaper_monitor_dpi(monitor)
                .map_or(0.0, |dpi| f64::from(dpi) / 96.0),
            requested_quality: requested_quality.into(),
            requested_fps: u32::from(configuration.presentation().fps),
            refresh_hz: monitor.refresh_hz,
            purpose,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BufferPlan {
    pub id: String,
    pub cpu_peak_bytes: u64,
    pub cpu_retained_bytes: u64,
    pub buffer_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceResources {
    pub buffers: Vec<BufferPlan>,
    pub cpu_peak_bytes: u64,
    pub cpu_retained_bytes: u64,
    pub buffer_bytes: u64,
    pub programs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourcePrimitives {
    pub draw_calls: u64,
    pub points: u64,
    pub triangles: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceProfile {
    pub mode: String,
    pub fps: u32,
    pub density: f64,
    pub dpr_cap: f64,
    pub pixel_budget: u64,
    pub draw_calls: u64,
    pub particles: u64,
    pub triangles: u64,
    pub memory_bytes: u64,
    pub post: bool,
    pub source_resources: SourceResources,
    pub source_primitives: SourcePrimitives,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ClockContract {
    pub version: u32,
    pub time_unit: String,
    pub sampling: String,
    pub spectrum_capacity: u64,
    pub input_bank_length: u64,
    pub input_bank_count: u64,
    pub input_bytes: u64,
    pub neutral: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompositionContract {
    contract_version: u32,
    adapter_id: String,
    adapter_version: u32,
    supported_state_versions: Vec<u32>,
    root_only: bool,
    camera_source: String,
    needs_depth: bool,
    parameter_equals: BTreeMap<String, Value>,
    clock: ClockContract,
    qualities: BTreeMap<String, SourceProfile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BuiltinTargetPlan {
    pub node_index: usize,
    pub node_id: String,
    pub scene_id: String,
    pub state_version: u32,
    pub registry_hash: String,
    pub adapter_id: String,
    pub adapter_version: u32,
    pub clock: ClockContract,
    pub profile_hash: String,
    pub profile: SourceProfile,
    pub final_params: Map<String, Value>,
    pub target_facts: TargetFacts,
    pub requested_quality: String,
    pub actual_quality: String,
    pub downgrade_reason: Option<String>,
    pub fit: Fit,
    pub css_width: f64,
    pub css_height: f64,
    pub effective_dpr: f64,
    pub native_pixel_allowance: u64,
    pub allowance: CompositionOutputAllowance,
    pub target: ImageTarget,
}

impl BuiltinTargetPlan {
    /// Extends the original target/capability identity with every native and
    /// source fact used to prepare assets; runtime projection uses this digest.
    pub(crate) fn identity_digest(&self) -> Result<String> {
        digest(self)
    }
}

fn digest(value: &impl Serialize) -> Result<String> {
    let bytes = serde_json::to_vec(value).map_err(|error| JobError::io(error.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn unavailable(node: &str, scene: &str, reason: &str) -> JobError {
    JobError::new(
        "adapter_unavailable",
        format!("builtinScene node={node} scene={scene}: {reason}"),
    )
}

fn validate_contract(contract: &CompositionContract) -> bool {
    let clock = &contract.clock;
    contract.contract_version == 1
        && contract.adapter_id == "builtin-scene"
        && contract.adapter_version == 1
        && contract.root_only
        && contract.camera_source == "registry"
        && contract.needs_depth
        && !contract.supported_state_versions.is_empty()
        && contract.supported_state_versions.len() <= 16
        && contract
            .supported_state_versions
            .iter()
            .all(|version| *version > 0)
        && contract
            .supported_state_versions
            .iter()
            .collect::<BTreeSet<_>>()
            .len()
            == contract.supported_state_versions.len()
        && clock.version == 1
        && clock.time_unit == "seconds"
        && clock.sampling == "absolute"
        && clock.neutral == "zero"
        && (1..=64).contains(&clock.spectrum_capacity)
        && clock.input_bank_length == clock.spectrum_capacity + 11
        && clock.input_bank_count == 2
        && clock.input_bytes == clock.input_bank_length * clock.input_bank_count * 8
        && contract.qualities.len() == 1
        && contract.qualities.contains_key("low")
}

fn validate_profile(profile: &SourceProfile) -> bool {
    let resources = &profile.source_resources;
    let primitives = &profile.source_primitives;
    let sums = resources
        .buffers
        .iter()
        .try_fold([0u64; 3], |mut total, buffer| {
            total[0] = total[0].checked_add(buffer.cpu_peak_bytes)?;
            total[1] = total[1].checked_add(buffer.cpu_retained_bytes)?;
            total[2] = total[2].checked_add(buffer.buffer_bytes)?;
            Some(total)
        });
    profile.mode == "low"
        && (1..=60).contains(&profile.fps)
        && profile.dpr_cap.is_finite()
        && profile.dpr_cap > 0.0
        && profile.dpr_cap <= 2.0
        && profile.density.is_finite()
        && (0.0..=1.0).contains(&profile.density)
        && !profile.post
        && (1..=64_000_000).contains(&profile.pixel_budget)
        && (1..=super::budget::MAX_GPU_TRACKED_BYTES).contains(&profile.memory_bytes)
        && (1..=64).contains(&resources.programs)
        && !resources.buffers.is_empty()
        && resources.buffers.len() <= 16
        && resources.buffers.iter().all(|buffer| {
            hertz_wallpaper::valid_local_id(&buffer.id)
                && buffer.cpu_retained_bytes <= buffer.cpu_peak_bytes
                && buffer.cpu_peak_bytes <= profile.memory_bytes
                && buffer.buffer_bytes <= profile.memory_bytes
        })
        && resources
            .buffers
            .iter()
            .map(|buffer| &buffer.id)
            .collect::<BTreeSet<_>>()
            .len()
            == resources.buffers.len()
        && sums
            == Some([
                resources.cpu_peak_bytes,
                resources.cpu_retained_bytes,
                resources.buffer_bytes,
            ])
        && resources.cpu_peak_bytes <= profile.memory_bytes
        && resources.buffer_bytes <= profile.memory_bytes
        && primitives.draw_calls <= profile.draw_calls
        && primitives.points <= profile.particles
        && primitives.triangles <= profile.triangles
}

fn validate_parameters(
    node: &str,
    scene: &str,
    definition: &Value,
    params: &Map<String, Value>,
    predicates: &BTreeMap<String, Value>,
) -> Result<()> {
    let schema = definition["params"]
        .as_object()
        .ok_or_else(|| unavailable(node, scene, "registry 参数合同缺失"))?;
    if schema.len() != params.len() || params.keys().any(|id| !schema.contains_key(id)) {
        return Err(unavailable(
            node,
            scene,
            "最终参数与 registry 完整参数集合不符",
        ));
    }
    for (parameter, descriptor) in schema {
        let value = &params[parameter];
        let valid = match descriptor["type"].as_str() {
            Some("number") => value.as_f64().is_some_and(|value| {
                value.is_finite()
                    && descriptor["min"].as_f64().is_none_or(|min| value >= min)
                    && descriptor["max"].as_f64().is_none_or(|max| value <= max)
            }),
            Some("boolean") => value.is_boolean(),
            Some("select") => descriptor["options"]
                .as_array()
                .is_some_and(|options| options.iter().any(|option| option["value"] == *value)),
            _ => false,
        };
        if !valid {
            return Err(unavailable(
                node,
                scene,
                &format!("parameter={parameter}: 最终值不符合 registry 参数合同"),
            ));
        }
    }
    for (parameter, expected) in predicates {
        let equals = params.get(parameter).is_some_and(|actual| {
            if expected.is_number() {
                actual
                    .as_f64()
                    .zip(expected.as_f64())
                    .is_some_and(|(actual, expected)| actual.is_finite() && actual == expected)
            } else {
                actual == expected
            }
        });
        if !schema.contains_key(parameter) || !equals {
            return Err(unavailable(
                node,
                scene,
                &format!("parameter={parameter}: adapter 要求 {expected}"),
            ));
        }
    }
    Ok(())
}

/// Must run before preliminary media range checks or any font/media prepare.
/// Pure 2D compositions return None and retain their existing target behavior.
pub(crate) fn plan(
    compiled: &CompiledDocument,
    final_values: &FinalPublicValues,
    target: ImageTarget,
    fit: Fit,
    facts: Option<&TargetFacts>,
    budget: &BudgetCoordinator,
) -> Result<Option<BuiltinTargetPlan>> {
    plan_with_catalog(
        compiled,
        final_values,
        target,
        fit,
        facts,
        budget,
        hertz_wallpaper::catalog(),
    )
}

struct SourceAdmission {
    node_index: usize,
    node_id: String,
    scene_id: String,
    state_version: u32,
    contract: CompositionContract,
    profile: SourceProfile,
    params: Map<String, Value>,
}

/// The same generated contract and final slots supply inspection, preparation
/// and renderer costs. This pure query grants no native target or execution.
pub(crate) fn source_costs(
    compiled: &CompiledDocument,
    final_values: &FinalPublicValues,
) -> Result<Option<(SourceProfile, ClockContract)>> {
    Ok(
        admit_source(compiled, final_values, hertz_wallpaper::catalog())?
            .map(|source| (source.profile, source.contract.clock)),
    )
}

fn admit_source(
    compiled: &CompiledDocument,
    final_values: &FinalPublicValues,
    catalog: &hertz_wallpaper::catalog::CatalogContract,
) -> Result<Option<SourceAdmission>> {
    let nodes = compiled.ir().nodes();
    let builtin_nodes: Vec<_> = nodes
        .iter()
        .enumerate()
        .filter(|(_, node)| node.node_type == "builtinScene")
        .collect();
    let Some(&(node_index, node)) = builtin_nodes.first() else {
        return Ok(None);
    };
    let authored = &compiled.document().nodes[node_index];
    let scene_id = authored
        .properties
        .get("sceneId")
        .and_then(Value::as_str)
        .ok_or_else(|| unavailable(&node.id, "unknown", "固定 sceneId 缺失"))?;
    let reject = |reason: &str| unavailable(&node.id, scene_id, reason);
    if builtin_nodes.len() != 1 || node.parent_index != -1 {
        return Err(reject("adapter 要求唯一 root builtinScene"));
    }
    if compiled.document().canvas.scene3d.is_some()
        || nodes.iter().any(|node| {
            node.node_type == "model" || (node.space == "3d" && node.node_type != "builtinScene")
        })
    {
        return Err(reject(
            "model、3D group 或显式 canvas.scene3d camera 尚未支持",
        ));
    }
    if !compiled.document().effects.is_empty()
        || !compiled.ir().tracks().is_empty()
        || !compiled.ir().bindings().is_empty()
    {
        return Err(reject("效果、轨道或绑定 adapter 尚未支持"));
    }
    let definition = catalog
        .scene(scene_id)
        .ok_or_else(|| reject("registry scene 缺失"))?;
    let metadata = definition
        .get("composition")
        .ok_or_else(|| reject("registry 未发布 composition 合同"))?;
    let contract: CompositionContract = serde_json::from_value(metadata.clone())
        .map_err(|_| reject("composition metadata 字段无效或版本尚未支持"))?;
    if !validate_contract(&contract) {
        return Err(reject("composition adapter/profile/clock 合同尚未支持"));
    }
    let state_version = authored
        .properties
        .get("stateVersion")
        .and_then(Value::as_u64)
        .and_then(|version| u32::try_from(version).ok())
        .ok_or_else(|| reject("固定 stateVersion 缺失"))?;
    if definition["stateVersion"].as_u64() != Some(u64::from(state_version))
        || !contract.supported_state_versions.contains(&state_version)
    {
        return Err(reject("source stateVersion 不在 composition 合同中"));
    }
    let params = compiled
        .final_builtin_params(node_index, final_values)
        .map_err(|error| reject(&error.message))?;
    validate_parameters(
        &node.id,
        scene_id,
        definition,
        &params,
        &contract.parameter_equals,
    )?;
    let profile = contract
        .qualities
        .get("low")
        .expect("validated low profile")
        .clone();
    if !validate_profile(&profile) {
        return Err(reject("source low profile/资源成本合同无效"));
    }
    Ok(Some(SourceAdmission {
        node_index,
        node_id: node.id.clone(),
        scene_id: scene_id.into(),
        state_version,
        contract,
        profile,
        params,
    }))
}

fn plan_with_catalog(
    compiled: &CompiledDocument,
    final_values: &FinalPublicValues,
    target: ImageTarget,
    fit: Fit,
    facts: Option<&TargetFacts>,
    budget: &BudgetCoordinator,
    catalog: &hertz_wallpaper::catalog::CatalogContract,
) -> Result<Option<BuiltinTargetPlan>> {
    let Some(SourceAdmission {
        node_index,
        node_id,
        scene_id,
        state_version,
        contract,
        profile,
        params,
    }) = admit_source(compiled, final_values, catalog)?
    else {
        return Ok(None);
    };
    let reject = |reason: &str| unavailable(&node_id, &scene_id, reason);
    let facts = facts.ok_or_else(|| reject("缺少 native monitor/DPI 目标事实"))?;
    if facts.monitor_id.is_empty()
        || facts.monitor_id.len() > 4096
        || facts.physical_width == 0
        || facts.physical_height == 0
        || facts.physical_width.max(facts.physical_height) > 16384
        || !facts.device_scale.is_finite()
        || !(0.5..=8.0).contains(&facts.device_scale)
        || facts.purpose != target.purpose
        || target.width != facts.physical_width
        || target.height != facts.physical_height
        || !["low", "medium", "high"].contains(&facts.requested_quality.as_str())
        || match facts.purpose {
            ImagePurpose::Preview => false,
            ImagePurpose::Low => facts.requested_quality != "low",
            ImagePurpose::Medium => facts.requested_quality != "medium",
            ImagePurpose::High => facts.requested_quality != "high",
        }
    {
        return Err(reject(
            "native 物理目标、DPI、purpose 或 requestedQuality 无效/不一致",
        ));
    }
    let owner = if facts.purpose == ImagePurpose::Preview {
        OwnerKind::Preview
    } else {
        OwnerKind::Desktop
    };
    let allowance = gl_plan::composition_output_allowance(
        budget,
        owner,
        facts.refresh_hz,
        facts.requested_fps,
        profile.fps,
        "low",
    )
    .map_err(|error| {
        JobError::new(
            error.code,
            format!(
                "builtinScene node={} scene={scene_id}: {}",
                node_id, error.message
            ),
        )
    })?;
    let native_pixel_allowance = allowance
        .pixel_ceiling
        .min(allowance.output_pixel_rate / u64::from(allowance.effective_fps));
    let pixel_budget = profile.pixel_budget.min(native_pixel_allowance);
    let css_width = f64::from(facts.physical_width) / facts.device_scale;
    let css_height = f64::from(facts.physical_height) / facts.device_scale;
    let effective_dpr = facts
        .device_scale
        .min(profile.dpr_cap)
        .min((pixel_budget as f64 / (css_width * css_height)).sqrt());
    let width = (css_width * effective_dpr).floor() as u32;
    let height = (css_height * effective_dpr).floor() as u32;
    let pixels = u64::from(width) * u64::from(height);
    if width == 0 || height == 0 || !effective_dpr.is_finite() || pixels > pixel_budget {
        return Err(JobError::new(
            "budget_busy",
            format!(
                "builtinScene node={node_id} scene={scene_id}: 单一栅格不能满足 native/source 像素额度"
            ),
        ));
    }
    let target = ImageTarget {
        width,
        height,
        ..target
    };
    // The original preparation owner must accept this exact raster unchanged.
    // Its preview ceiling remains in force rather than creating a second target.
    if image_prepare::normalize_target(target)? != target {
        return Err(reject("单一栅格超出原媒体准备目标上限"));
    }
    Ok(Some(BuiltinTargetPlan {
        node_index,
        node_id,
        scene_id: scene_id.clone(),
        state_version,
        registry_hash: catalog.registry_hash.clone(),
        adapter_id: contract.adapter_id,
        adapter_version: contract.adapter_version,
        clock: contract.clock,
        profile_hash: digest(
            &catalog.scene(&scene_id).expect("admitted scene")["composition"]["qualities"]["low"],
        )?,
        profile,
        final_params: params,
        target_facts: facts.clone(),
        requested_quality: facts.requested_quality.clone(),
        actual_quality: "low".into(),
        downgrade_reason: (facts.requested_quality != "low")
            .then(|| "registry composition 合同仅支持 source low profile".into()),
        fit,
        css_width,
        css_height,
        effective_dpr,
        native_pixel_allowance,
        allowance,
        target,
    }))
}

#[cfg(test)]
#[path = "builtin_plan_tests.rs"]
mod tests;
