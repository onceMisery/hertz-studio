// SPDX-License-Identifier: MIT
//! Native composition projection. Installed bytes, preparation and admission stay
//! with AssetStore, ImportJobs and the existing GL/session owners.
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use hertz_wallpaper::document::{
    CompiledDocument, FinalPublicValues, PublicTarget, ResolvedAssetIdentity, TargetIdentity,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::assets::PinnedMedia;
use super::budget::{BudgetRequest, OwnerKind, ResourceAmounts, ResourcePlan, SessionPlan};
use super::gl_plan::{GlLimits, GlPlan, SharedAssetsEnvelope};
use super::image_prepare::ImageTarget;
use super::jobs::{ImportJobs, JobError};
use super::media::Container;
use super::target_planner::{AssetRef, ResolvedMedia};

type Result<T> = std::result::Result<T, JobError>;

pub(crate) struct PreparedComposition {
    package_hash: String,
    compiled: Arc<CompiledDocument>,
    final_values: FinalPublicValues,
    assets: BTreeMap<String, ResolvedMedia>,
    _document_pin: Arc<PinnedMedia>,
    target: ImageTarget,
    output_fit: super::config::Fit,
}

#[cfg(test)]
#[path = "composition_plan_tests.rs"]
mod tests;

impl std::fmt::Debug for PreparedComposition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparedComposition")
            .field("semantic_key", &self.compiled.ir().semantic_key())
            .field("assets", &self.assets.len())
            .finish()
    }
}

fn check_cancel(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        Err(JobError::new("cancelled", "组合准备已取消并退出"))
    } else {
        Ok(())
    }
}
fn digest(value: &impl serde::Serialize) -> Result<String> {
    let bytes =
        serde_json::to_vec(value).map_err(|error| JobError::invalid_input(error.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
fn package_error(error: hertz_wallpaper::PackageError) -> JobError {
    JobError::new(error.code, error.message)
}

fn read_document(
    store: &super::assets::AssetStore,
    package: &super::assets::StagedPackage,
    properties: &serde_json::Map<String, Value>,
) -> Result<(Arc<CompiledDocument>, FinalPublicValues, Arc<PinnedMedia>)> {
    let hertz_wallpaper::Content::Composition { document } = &package.manifest.content else {
        return Err(JobError::invalid_input("组合规划要求固定 composition 包"));
    };
    let pin = Arc::new(
        store
            .pin_verified_media(&package.package_hash, document)?
            .ok_or_else(|| JobError::new("asset_unavailable", "组合文档未通过固定包核验"))?,
    );
    let mut bytes = Vec::new();
    super::assets::open_immutable(&pin.path)?
        .take(hertz_wallpaper::document::MAX_DOCUMENT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| JobError::io(error.to_string()))?;
    let compiled = Arc::new(
        hertz_wallpaper::document::compile_document(&bytes, &package.manifest)
            .map_err(package_error)?,
    );
    let values = compiled
        .final_public_values(
            &properties
                .iter()
                .map(|(id, value)| (id.clone(), value.clone()))
                .collect(),
        )
        .map_err(package_error)?;
    Ok((compiled, values, pin))
}

/// Read-only management validation of every fixed playlist reference uses the
/// same compiler/public-value owner. It does not prepare media or grant playback.
pub(crate) fn validate_public_properties(
    store: &super::assets::AssetStore,
    package: &super::assets::StagedPackage,
    properties: &serde_json::Map<String, Value>,
) -> Result<()> {
    read_document(store, package, properties).map(|_| ())
}

/// This must run on the management blocking worker: package integrity checks hash
/// actual bytes. Each media qualification uses ImportJobs' original single slot.
pub(crate) async fn resolve(
    jobs: Arc<ImportJobs>,
    package_hash: String,
    properties: serde_json::Map<String, Value>,
    target: ImageTarget,
    output_fit: super::config::Fit,
    cancel: Arc<AtomicBool>,
) -> Result<PreparedComposition> {
    check_cancel(&cancel)?;
    let package = jobs.assets().read_installed_manifest(&package_hash)?;
    let (compiled, final_values, document_pin) =
        read_document(jobs.assets(), &package, &properties)?;
    validate_adapters(&compiled)?;
    let inputs = jobs.assets().probe_installed_media(&package, &cancel)?;
    // Validate true container/range facts before any decode qualification. The
    // same fixed input is then qualified through the original preparation slot.
    let preliminary = PreparedComposition {
        package_hash: package_hash.clone(),
        compiled: Arc::clone(&compiled),
        final_values: final_values.clone(),
        assets: final_values
            .resource_uses()
            .iter()
            .filter_map(|usage| {
                let asset = package
                    .manifest
                    .assets
                    .iter()
                    .find(|asset| asset.id == usage.asset_id)?;
                let input = inputs
                    .iter()
                    .find(|input| input.media.entry.path == asset.source)?
                    .clone();
                Some(
                    ResolvedMedia::from_input(
                        AssetRef {
                            package_hash: package_hash.clone(),
                            asset_id: asset.id.clone(),
                            variant_id: None,
                        },
                        input.clone(),
                        input.media.entry.sha256.clone(),
                        target,
                    )
                    .map(|media| (asset.id.clone(), media)),
                )
            })
            .collect::<Result<BTreeMap<_, _>>>()?,
        _document_pin: Arc::clone(&document_pin),
        target,
        output_fit,
    };
    preliminary.costs()?;
    let mut assets = BTreeMap::new();
    for usage in final_values.resource_uses() {
        check_cancel(&cancel)?;
        if assets.contains_key(&usage.asset_id) {
            continue;
        }
        let asset = package
            .manifest
            .assets
            .iter()
            .find(|asset| asset.id == usage.asset_id)
            .ok_or_else(|| JobError::new("asset_not_found", "最终资源槽不属于固定包"))?;
        let node = &compiled.ir().nodes()[usage
            .node_index
            .ok_or_else(|| JobError::new("adapter_unavailable", "效果资源未准备"))?];
        let catalog = hertz_wallpaper::document::catalog::composition_catalog();
        let schema = catalog
            .definitions
            .nodes
            .iter()
            .find(|schema| schema.node_type == node.node_type)
            .and_then(|schema| schema.assets.get(&usage.field))
            .ok_or_else(|| JobError::invalid_input("最终资源槽未在合同中声明"))?;
        if !schema.kinds.contains(&asset.kind) {
            return Err(JobError::new(
                "format_unsupported",
                "最终资源覆盖 kind 与编译槽不匹配",
            ));
        }
        if !matches!(
            asset.kind,
            hertz_wallpaper::AssetKind::Image | hertz_wallpaper::AssetKind::Video
        ) {
            return Err(JobError::new(
                "adapter_unavailable",
                format!("组合资源尚无已准备 adapter：{}", asset.id),
            ));
        }
        let media = super::selection_plan::prepare_target(
            Arc::clone(&jobs),
            AssetRef {
                package_hash: package_hash.clone(),
                asset_id: asset.id.clone(),
                variant_id: None,
            },
            target,
            Arc::clone(&cancel),
        )
        .await?;
        assets.insert(asset.id.clone(), media);
    }
    check_cancel(&cancel)?;
    let result = PreparedComposition {
        package_hash,
        compiled,
        final_values,
        assets,
        _document_pin: document_pin,
        target,
        output_fit,
    };
    // Range qualification consumes the combined final numeric projection, not
    // the author's defaults or requested canvas dimensions.
    result.costs()?;
    Ok(result)
}

fn validate_adapters(compiled: &CompiledDocument) -> Result<()> {
    let document = compiled.document();
    if !document.effects.is_empty()
        || !compiled.ir().tracks().is_empty()
        || !compiled.ir().bindings().is_empty()
        || document.canvas.scene3d.is_some()
    {
        return Err(JobError::new(
            "adapter_unavailable",
            "P2-02 尚未准备效果、轨道、绑定或 3D adapter",
        ));
    }
    for node in compiled.ir().nodes() {
        if node.node_type == "text" {
            return Err(JobError::new(
                "font_not_prepared",
                "组合文字需要原生已准备字体与实测布局资格",
            ));
        }
        if node.space != "2d"
            || !matches!(
                node.node_type.as_str(),
                "image" | "video" | "group" | "particles"
            )
        {
            return Err(JobError::new(
                "adapter_unavailable",
                format!("P2-02 adapter 尚未准备：{}:{}", node.node_type, node.space),
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Default)]
struct Costs {
    cpu: u64,
    gpu: u64,
    decoders: u32,
    decode_rate: u64,
    texture_bytes: u64,
    decode_bytes: u64,
    buffer_bytes: u64,
    programs: u64,
    semantic_bytes: u64,
    video_upload_peak_bytes: u64,
}

impl PreparedComposition {
    fn number(&self, index: usize, property: &str) -> Result<f64> {
        let node = &self.compiled.ir().nodes()[index];
        let slot = *node
            .property_slots
            .get(property)
            .and_then(|slots| slots.first())
            .ok_or_else(|| JobError::invalid_input("组合数值槽缺失"))?;
        let value = self
            .compiled
            .ir()
            .public_properties()
            .iter()
            .find_map(|public| {
                if matches!(public.target, PublicTarget::Numeric { slot: target } if target == slot)
                {
                    self.final_values
                        .values()
                        .get(&public.descriptor.id)
                        .and_then(Value::as_f64)
                } else {
                    None
                }
            })
            .unwrap_or(self.compiled.ir().numeric_slots()[slot].value);
        Ok(value)
    }
    fn decode_options(&self, media: &ResolvedMedia) -> Value {
        json!({"colorSpace":"srgb","alphaMode":"straight","mipmaps":false,
            "encodedWidth":media.input().metadata.encoded_width,"encodedHeight":media.input().metadata.encoded_height,
            "rotationDegrees":media.input().metadata.rotation_degrees})
    }
    fn adapter(media: &ResolvedMedia) -> &'static str {
        if media.input().metadata.container == Container::Image {
            "prepared-srgb-image"
        } else {
            "silent-video"
        }
    }
    fn costs(&self) -> Result<Costs> {
        validate_adapters(&self.compiled)?;
        let mut cost = Costs {
            buffer_bytes: 92,
            programs: 2,
            ..Default::default()
        };
        let mut identities = BTreeSet::new();
        for usage in self.final_values.resource_uses() {
            let media = self
                .assets
                .get(&usage.asset_id)
                .ok_or_else(|| JobError::new("asset_not_found", "最终资源闭包未准备"))?;
            let metadata = &media.input().metadata;
            let index = usage
                .node_index
                .ok_or_else(|| JobError::new("adapter_unavailable", "效果资源未准备"))?;
            let is_video = metadata.container != Container::Image;
            if is_video
                && (metadata.rotation_degrees != 0
                    || metadata.encoded_width != metadata.display_width
                    || metadata.encoded_height != metadata.display_height)
            {
                return Err(JobError::new(
                    "adapter_unavailable",
                    "组合视频的旋转/像素宽高比 adapter 尚未准备",
                ));
            }
            let node = &self.compiled.ir().nodes()[index];
            if (node.node_type == "video") != is_video && usage.field == "asset" {
                return Err(JobError::new(
                    "format_unsupported",
                    "最终资源 kind 与节点 adapter 不一致",
                ));
            }
            let mut options = self.decode_options(media);
            options["usage"] = usage.usage.clone().into();
            if is_video {
                let start = self.number(index, "loopStartMs")?;
                let end = self.number(index, "loopEndMs")?;
                if metadata
                    .duration_ms
                    .is_none_or(|duration| start < 0.0 || end <= start || end > duration as f64)
                {
                    return Err(JobError::new(
                        "invalid_video_range",
                        "最终 loopEnd 超出真实视频 duration",
                    ));
                }
                options["clock"] =
                    json!({"loopStartMs":start,"loopEndMs":end,"seekStrategy":"absolute"});
            }
            let key = digest(&(media.content_key(), Self::adapter(media), options))?;
            if !identities.insert(key) {
                continue;
            }
            let decoded_pixels =
                u64::from(metadata.encoded_width) * u64::from(metadata.encoded_height);
            let texture_pixels =
                u64::from(metadata.display_width) * u64::from(metadata.display_height);
            cost.texture_bytes += texture_pixels * 4;
            cost.decode_bytes += decoded_pixels * if is_video { 12 } else { 4 };
            if is_video {
                // The native GL owner fences same-size texImage storage
                // replacement. It admits only one unfinished frame at a time.
                cost.video_upload_peak_bytes += texture_pixels * 4;
                cost.decoders += 1;
                let fps = metadata
                    .fps_upper_bound
                    .filter(|fps| fps.is_finite() && *fps > 0.0 && *fps <= 240.0)
                    .ok_or_else(|| {
                        JobError::new("format_unsupported", "组合视频缺少真实帧率上界")
                    })?;
                cost.decode_rate += (decoded_pixels as f64 * fps).ceil() as u64;
            }
        }
        for (index, node) in self.compiled.ir().nodes().iter().enumerate() {
            cost.buffer_bytes += match node.node_type.as_str() {
                "group" => 0,
                "particles" => {
                    cost.programs = 3;
                    self.number(index, "count")? as u64 * 20
                }
                _ => 92,
            };
        }
        // Charge the actual serialized semantic/closure content for the retained
        // native projection and page transfer too; physical process overhead is
        // separately measured during native qualification.
        let bytes = self.compiled.normalized_bytes().len()
            + serde_json::to_vec(self.compiled.ir())
                .map_err(|error| JobError::io(error.to_string()))?
                .len()
            + serde_json::to_vec(&self.final_values)
                .map_err(|error| JobError::io(error.to_string()))?
                .len();
        cost.semantic_bytes = bytes as u64 * 3
            + 4096
            + self
                .assets
                .values()
                .map(|media| media.url().len() as u64 + media.content_key().len() as u64 + 1024)
                .sum::<u64>();
        cost.cpu = cost.decode_bytes + cost.buffer_bytes + cost.semantic_bytes;
        // One original RGBA8/depth drawing buffer (8P), one linear RGBA16F
        // composition target (8P), actual textures and fixed private geometry.
        cost.gpu = u64::from(self.target.width) * u64::from(self.target.height) * 16
            + cost.texture_bytes
            + cost.buffer_bytes
            + cost.video_upload_peak_bytes
            + super::gl_plan::THREE_BOOTSTRAP_GPU_PEAK_BYTES;
        Ok(cost)
    }

    pub(crate) fn gl_plan(
        &self,
        owner: OwnerKind,
        session: String,
        generation: u64,
        refresh_hz: u32,
        fps: u32,
    ) -> Result<GlPlan> {
        if !(5..=1000).contains(&refresh_hz) || !(1..=60).contains(&fps) {
            return Err(JobError::invalid_input("组合输出帧率无效"));
        }
        let cost = self.costs()?;
        let fps = if owner == OwnerKind::Preview {
            fps.min(15)
        } else {
            fps
        };
        let divisor = refresh_hz.div_ceil(fps);
        let pixels = u64::from(self.target.width) * u64::from(self.target.height);
        let request = BudgetRequest {
            owner,
            session,
            generation,
            task_id: "composition-gl".into(),
            targets: u32::from(owner == OwnerKind::Desktop),
            contexts: 1,
            decoders: cost.decoders,
            transcode_slots: 0,
            decode_pixel_rate: cost.decode_rate,
            output_pixel_rate: (pixels * u64::from(refresh_hz)).div_ceil(u64::from(divisor)),
            // Each unique video texture uploads on the original output frame
            // gate, even when source FPS is lower. Never charge author pixels.
            texture_upload_bytes_per_second: (cost.video_upload_peak_bytes * u64::from(refresh_hz))
                .div_ceil(u64::from(divisor)),
            cpu_bytes: cost.cpu,
            prepare_cpu_bytes: 0,
            asset_cpu_bytes: 0,
            gpu_bytes: cost.gpu,
            prepare_tasks: 0,
        };
        Ok(GlPlan {
            limits: GlLimits {
                quality: "low".into(),
                requested_quality: "low".into(),
                fps,
                requested_fps: fps,
                refresh_hz,
                frame_divisor: divisor,
                pixel_budget: pixels,
                gpu_bytes: cost.gpu,
                shared_assets: SharedAssetsEnvelope {
                    max_entries: 0,
                    max_entry_bytes: 0,
                    cpu_bytes: 0,
                },
            },
            session: SessionPlan::new(
                request.clone(),
                vec![
                    ResourcePlan {
                        id: "gl-renderer".into(),
                        maximum: ResourceAmounts::from_request(&request),
                    },
                    ResourcePlan {
                        id: "shared-assets".into(),
                        maximum: ResourceAmounts::default(),
                    },
                ],
            )?,
        })
    }

    pub(crate) fn target(&self) -> ImageTarget {
        self.target
    }
    pub(crate) fn output_fit(&self) -> super::config::Fit {
        self.output_fit
    }
    pub(crate) fn package_hash(&self) -> &str {
        &self.package_hash
    }
    pub(crate) fn pins(&self) -> Vec<(String, Arc<PinnedMedia>)> {
        self.assets
            .values()
            .map(|media| {
                (
                    media.reference().package_hash.clone(),
                    Arc::clone(&media.input().media),
                )
            })
            .collect()
    }
    pub(crate) fn projection(
        &self,
        session_id: &str,
        generation: u64,
        allocation_revision: u64,
        limits: &GlLimits,
    ) -> Result<Value> {
        let resolved_assets: Vec<_> = self.assets.iter().map(|(id,media)| json!({"assetId":id,"contentKey":media.content_key(),
            "kind":if media.input().metadata.container == Container::Image {"image"} else {"video"},
            "byteLength":media.input().media.entry.bytes,"width":media.input().metadata.display_width,
            "height":media.input().metadata.display_height,"durationMs":media.input().metadata.duration_ms,
            "url":media.url(),"decodeOptions":self.decode_options(media),"adapterId":Self::adapter(media),"adapterVersion":1})).collect();
        let identities = self
            .assets
            .iter()
            .map(|(id, media)| {
                Ok((
                    id.clone(),
                    ResolvedAssetIdentity {
                        content_key: media.content_key().into(),
                        decode_options_hash: digest(&self.decode_options(media))?,
                        adapter_version: 1,
                        dependency_keys: BTreeMap::from([(
                            "adapter".into(),
                            digest(&Self::adapter(media))?,
                        )]),
                    },
                ))
            })
            .collect::<Result<BTreeMap<_, _>>>()?;
        let identity = TargetIdentity {
            public_values: self.final_values.clone(),
            resolved_assets: identities,
            capability_digest: digest(&"p2-02-image-video-group-particles-v1")?,
            output_width: self.target.width,
            output_height: self.target.height,
            effective_budget_fps: f64::from(limits.refresh_hz) / f64::from(limits.frame_divisor),
            budget_allocation_revision: allocation_revision,
        };
        let target_key = digest(&(
            identity.cache_key(&self.compiled).map_err(package_error)?,
            self.output_fit,
        ))?;
        let cost = self.costs()?;
        Ok(
            json!({"semanticKey":self.compiled.ir().semantic_key(),"targetKey":target_key,"ir":self.compiled.ir(),
            "finalPublicValues":self.final_values,"canvas":self.compiled.document().canvas,"timeline":self.compiled.document().timeline,
            "resolvedAssets":resolved_assets,"target":{"width":self.target.width,"height":self.target.height,"fit":self.output_fit,
                "budgetFps":identity.effective_budget_fps,"budgetAllocationRevision":allocation_revision},"sessionId":session_id,"generation":generation,
            "pageLimits":{"gpuContexts":1,"drawingBufferPixels":u64::from(self.target.width)*u64::from(self.target.height),
                "renderTargetDeclaredBytes":u64::from(self.target.width)*u64::from(self.target.height)*16,"textureDeclaredBytes":cost.texture_bytes,
                "bufferDeclaredBytes":cost.buffer_bytes,"ownedCpuBytes":cost.buffer_bytes,"decodeReservedBytes":cost.decode_bytes,
                "decoderLeases":cost.decoders,"programs":cost.programs,"canvases":0}}),
        )
    }
}
