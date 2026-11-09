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
use super::font_prepare::{FontInput, PreparedFont, RequiredText};
use super::gl_plan::{GlLimits, GlPlan, SharedAssetsEnvelope};
use super::image_prepare::ImageTarget;
use super::jobs::{FontGroupPrepareRequest, FontPrepareRequest, ImportJobs, JobError};
use super::media::Container;
use super::target_planner::{AssetRef, ResolvedMedia};
use super::text_raster::{self, TextRasterPlan};

type Result<T> = std::result::Result<T, JobError>;

/// Fixed compiler/final-value facts for the single original group job. This
/// context supplies a memory lower bound, never a runtime admission token.
#[derive(Clone)]
pub(crate) struct FontTextPreflightContext {
    package_hash: String,
    pub(crate) compiled: Arc<CompiledDocument>,
    pub(crate) final_values: FinalPublicValues,
    pub(crate) target: ImageTarget,
    pub(crate) output_fit: super::config::Fit,
}

impl FontTextPreflightContext {
    pub(crate) fn new(
        package_hash: String,
        compiled: Arc<CompiledDocument>,
        final_values: FinalPublicValues,
        target: ImageTarget,
        output_fit: super::config::Fit,
    ) -> Self {
        Self {
            package_hash,
            compiled,
            final_values,
            target,
            output_fit,
        }
    }

    pub(crate) fn package_hash(&self) -> &str {
        &self.package_hash
    }

    pub(crate) fn memory_request(
        &self,
        inputs: &BTreeMap<String, FontInput>,
        session: String,
        generation: u64,
    ) -> Result<BudgetRequest> {
        let facts = inputs
            .iter()
            .map(|(id, input)| {
                let facts = input.plan_facts()?;
                if facts.reference().package_hash != self.package_hash {
                    return Err(JobError::new(
                        "font_not_prepared",
                        "字体输入不属于预检固定包",
                    ));
                }
                Ok((id.clone(), facts))
            })
            .collect::<Result<BTreeMap<_, _>>>()?;
        let rasters = text_raster::plan_text_rasters_from_facts(
            &self.compiled,
            &self.final_values,
            &facts,
            self.target,
            self.output_fit,
        )?;
        let asset_ids: BTreeSet<_> = self
            .final_values
            .resource_uses()
            .iter()
            .map(|usage| usage.asset_id.as_str())
            .collect();
        let closure = asset_ids
            .iter()
            .map(|id| {
                facts.get(*id).map_or(Ok((0, 0)), |font| {
                    Ok((font.url()?.len() as u64, font.content_key().len() as u64))
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let mut costs = geometry_costs(&self.compiled, &self.final_values)?;
        complete_costs(
            &mut costs,
            &self.compiled,
            &self.final_values,
            &rasters,
            self.target,
            closure_costs(closure)?,
        )?;
        Ok(BudgetRequest {
            owner: OwnerKind::Probe,
            session,
            generation,
            task_id: "font-text-preflight".into(),
            targets: 0,
            contexts: 0,
            decoders: 0,
            transcode_slots: 0,
            decode_pixel_rate: 0,
            output_pixel_rate: 0,
            texture_upload_bytes_per_second: 0,
            cpu_bytes: costs.cpu,
            prepare_cpu_bytes: 0,
            asset_cpu_bytes: 0,
            gpu_bytes: costs.gpu,
            // The group's original prepare reservation already holds its slot.
            prepare_tasks: 0,
        })
    }
}

#[derive(Clone)]
enum CompositionAsset {
    Media(ResolvedMedia),
    Font(Box<PreparedFont>),
}

impl CompositionAsset {
    fn as_media(&self) -> Option<&ResolvedMedia> {
        match self {
            Self::Media(media) => Some(media),
            Self::Font(_) => None,
        }
    }
    fn as_font(&self) -> Option<&PreparedFont> {
        match self {
            Self::Font(font) => Some(font),
            Self::Media(_) => None,
        }
    }
    fn reference(&self) -> &AssetRef {
        match self {
            Self::Media(media) => media.reference(),
            Self::Font(font) => font.reference(),
        }
    }
    fn pin(&self) -> &Arc<PinnedMedia> {
        match self {
            Self::Media(media) => &media.input().media,
            Self::Font(font) => &font.input().media,
        }
    }
    fn content_key(&self) -> &str {
        match self {
            Self::Media(media) => media.content_key(),
            Self::Font(font) => font.content_key(),
        }
    }
    fn url(&self) -> &str {
        match self {
            Self::Media(media) => media.url(),
            Self::Font(font) => font.url(),
        }
    }
}

pub(crate) struct PreparedComposition {
    package_hash: String,
    compiled: Arc<CompiledDocument>,
    final_values: FinalPublicValues,
    assets: BTreeMap<String, CompositionAsset>,
    text_rasters: TextRasterPlan,
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

fn cost_exceeded() -> JobError {
    JobError::new("budget_exceeded", "组合资源成本超出可表示范围")
}
fn checked_sum(values: &[u64]) -> Result<u64> {
    values.iter().try_fold(0_u64, |sum, value| {
        sum.checked_add(*value).ok_or_else(cost_exceeded)
    })
}
fn checked_product(a: u64, b: u64) -> Result<u64> {
    a.checked_mul(b).ok_or_else(cost_exceeded)
}

/// Every final slot is checked independently, including same-content aliases.
fn validate_resource_uses(
    compiled: &CompiledDocument,
    final_values: &FinalPublicValues,
    package: &super::assets::StagedPackage,
) -> Result<()> {
    let catalog = hertz_wallpaper::document::catalog::composition_catalog();
    for usage in final_values.resource_uses() {
        let asset = package
            .manifest
            .assets
            .iter()
            .find(|asset| asset.id == usage.asset_id)
            .ok_or_else(|| JobError::new("asset_not_found", "最终资源槽不属于固定包"))?;
        let node = usage
            .node_index
            .and_then(|index| compiled.ir().nodes().get(index))
            .ok_or_else(|| JobError::new("adapter_unavailable", "效果资源未准备"))?;
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
    }
    Ok(())
}

fn font_prepare_request(
    package: &super::assets::StagedPackage,
    asset_id: &str,
    required_texts: Vec<RequiredText>,
) -> Result<FontPrepareRequest> {
    let asset = package
        .manifest
        .assets
        .iter()
        .find(|asset| asset.id == asset_id && asset.kind == hertz_wallpaper::AssetKind::Font)
        .ok_or_else(|| JobError::new("font_asset_kind_mismatch", "文字必须引用同包 font 资源"))?;
    let expected_entry = package
        .entries
        .iter()
        .find(|entry| entry.path == asset.source)
        .ok_or_else(|| JobError::new("asset_unavailable", "字体条目未通过固定包核验"))?
        .clone();
    Ok(FontPrepareRequest {
        reference: AssetRef {
            package_hash: package.package_hash.clone(),
            asset_id: asset_id.to_owned(),
            variant_id: None,
        },
        expected_entry,
        required_texts,
    })
}

/// The typed receiver is sent only after the original worker has really exited.
/// Repeated cancellation forwarding never drops that completion barrier.
async fn wait_font_reply<T>(
    jobs: &ImportJobs,
    job_id: &str,
    mut receive: tokio::sync::oneshot::Receiver<Result<T>>,
    cancel: &AtomicBool,
) -> Result<T> {
    loop {
        if cancel.load(Ordering::Acquire) {
            jobs.cancel(job_id);
        }
        match receive.try_recv() {
            Ok(result) => {
                check_cancel(cancel)?;
                return result;
            }
            Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                return Err(JobError::new(
                    "prepare_failed",
                    "字体准备任务终态回执不可用",
                ));
            }
            Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
    }
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
/// actual bytes. Every font/media qualification uses the original single slot.
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
    validate_resource_uses(&compiled, &final_values, &package)?;
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
                    .map(|media| (asset.id.clone(), CompositionAsset::Media(media))),
                )
            })
            .collect::<Result<BTreeMap<_, _>>>()?,
        text_rasters: TextRasterPlan::default(),
        _document_pin: Arc::clone(&document_pin),
        target,
        output_fit,
    };
    preliminary.media_costs()?;
    let assets = prepare_assets(
        &jobs,
        &package,
        &compiled,
        &final_values,
        target,
        output_fit,
        &cancel,
    )
    .await?;
    check_cancel(&cancel)?;
    let result = PreparedComposition {
        package_hash,
        compiled,
        final_values,
        assets,
        text_rasters: TextRasterPlan::default(),
        _document_pin: document_pin,
        target,
        output_fit,
    };
    // Range qualification consumes the combined final numeric projection, not
    // the author's defaults or requested canvas dimensions.
    result.finish()
}

/// Shared final-use closure preparation. Every final font is inspected and
/// qualified before any final media asset can enter its original preparation.
async fn prepare_assets(
    jobs: &Arc<ImportJobs>,
    package: &super::assets::StagedPackage,
    compiled: &Arc<CompiledDocument>,
    final_values: &FinalPublicValues,
    target: ImageTarget,
    output_fit: super::config::Fit,
    cancel: &Arc<AtomicBool>,
) -> Result<BTreeMap<String, CompositionAsset>> {
    validate_resource_uses(compiled, final_values, package)?;
    let required_texts = text_raster::required_texts_by_font(compiled, final_values)?;
    let mut assets = BTreeMap::new();
    if !required_texts.is_empty() {
        let fonts = required_texts
            .into_iter()
            .map(|(id, texts)| font_prepare_request(package, &id, texts))
            .collect::<Result<Vec<_>>>()?;
        let (job_id, receive) = jobs.prepare_font_group(
            super::jobs::new_job_id(),
            FontGroupPrepareRequest {
                fonts,
                composition: FontTextPreflightContext::new(
                    package.package_hash.clone(),
                    Arc::clone(compiled),
                    final_values.clone(),
                    target,
                    output_fit,
                ),
            },
        )?;
        let fonts = wait_font_reply(jobs, &job_id, receive, cancel).await?;
        assets.extend(
            fonts
                .into_iter()
                .map(|(id, font)| (id, CompositionAsset::Font(Box::new(font)))),
        );
    }
    for usage in final_values.resource_uses() {
        check_cancel(cancel)?;
        if assets.contains_key(&usage.asset_id) {
            continue;
        }
        let asset = package
            .manifest
            .assets
            .iter()
            .find(|asset| asset.id == usage.asset_id)
            .ok_or_else(|| JobError::new("asset_not_found", "最终资源槽不属于固定包"))?;
        let prepared = match asset.kind {
            hertz_wallpaper::AssetKind::Image | hertz_wallpaper::AssetKind::Video => {
                CompositionAsset::Media(
                    super::selection_plan::prepare_target(
                        Arc::clone(jobs),
                        AssetRef {
                            package_hash: package.package_hash.clone(),
                            asset_id: asset.id.clone(),
                            variant_id: None,
                        },
                        target,
                        Arc::clone(cancel),
                    )
                    .await?,
                )
            }
            hertz_wallpaper::AssetKind::Font => {
                return Err(JobError::new("font_not_prepared", "最终字体没有文字集合"));
            }
            _ => {
                return Err(JobError::new(
                    "adapter_unavailable",
                    format!("组合资源尚无已准备 adapter：{}", asset.id),
                ));
            }
        };
        assets.insert(asset.id.clone(), prepared);
    }
    check_cancel(cancel)?;
    Ok(assets)
}

fn validate_adapters(compiled: &CompiledDocument) -> Result<()> {
    // A declaration grants no access: text still needs sealed glyph coverage,
    // native FontFace qualification, complete admission and real first submit.
    validate_structure(compiled)
}

fn validate_structure(compiled: &CompiledDocument) -> Result<()> {
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
        if node.space != "2d"
            || !matches!(
                node.node_type.as_str(),
                "image" | "video" | "group" | "particles" | "text"
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
    font_cpu_bytes: u64,
    raster_bytes: u64,
}

fn final_number(
    compiled: &CompiledDocument,
    final_values: &FinalPublicValues,
    index: usize,
    property: &str,
) -> Result<f64> {
    let node = &compiled.ir().nodes()[index];
    let slot = *node
        .property_slots
        .get(property)
        .and_then(|slots| slots.first())
        .ok_or_else(|| JobError::invalid_input("组合数值槽缺失"))?;
    Ok(compiled
        .ir()
        .public_properties()
        .iter()
        .find_map(|public| {
            if matches!(public.target, PublicTarget::Numeric { slot: target } if target == slot) {
                final_values
                    .values()
                    .get(&public.descriptor.id)
                    .and_then(Value::as_f64)
            } else {
                None
            }
        })
        .unwrap_or(compiled.ir().numeric_slots()[slot].value))
}

fn geometry_costs(compiled: &CompiledDocument, final_values: &FinalPublicValues) -> Result<Costs> {
    validate_structure(compiled)?;
    let mut costs = Costs {
        buffer_bytes: 92,
        programs: 2,
        ..Default::default()
    };
    for (index, node) in compiled.ir().nodes().iter().enumerate() {
        let bytes = match node.node_type.as_str() {
            "group" => 0,
            "particles" => {
                costs.programs = 3;
                checked_product(
                    final_number(compiled, final_values, index, "count")? as u64,
                    20,
                )?
            }
            _ => 92,
        };
        costs.buffer_bytes = checked_sum(&[costs.buffer_bytes, bytes])?;
    }
    Ok(costs)
}

fn closure_costs(assets: impl IntoIterator<Item = (u64, u64)>) -> Result<u64> {
    assets.into_iter().try_fold(0, |total, (url, content_key)| {
        checked_sum(&[total, url, content_key, 1024])
    })
}

/// Final plans add media charges to these common facts; inspection leaves those
/// unknown charges at zero. Both paths use exactly the same retained semantics,
/// geometry, font/raster costs and output/bootstrap memory calculation.
fn complete_costs(
    costs: &mut Costs,
    compiled: &CompiledDocument,
    final_values: &FinalPublicValues,
    rasters: &TextRasterPlan,
    target: ImageTarget,
    closure_bytes: u64,
) -> Result<()> {
    let bytes = checked_sum(&[
        compiled.normalized_bytes().len() as u64,
        serde_json::to_vec(compiled.ir())
            .map_err(|error| JobError::io(error.to_string()))?
            .len() as u64,
        serde_json::to_vec(final_values)
            .map_err(|error| JobError::io(error.to_string()))?
            .len() as u64,
        serde_json::to_vec(rasters.text_rasters())
            .map_err(|error| JobError::io(error.to_string()))?
            .len() as u64,
    ])?;
    costs.semantic_bytes = checked_sum(&[checked_product(bytes, 3)?, 4096, closure_bytes])?;
    costs.font_cpu_bytes = rasters.font_cpu_bytes();
    costs.raster_bytes = rasters.raster_rgba_bytes();
    costs.cpu = checked_sum(&[
        costs.decode_bytes,
        costs.buffer_bytes,
        costs.semantic_bytes,
        costs.font_cpu_bytes,
        costs.raster_bytes,
    ])?;
    // Original RGBA8/depth buffer (8P), linear RGBA16F target (8P),
    // actual textures/private geometry and unfinished video/bootstrap peaks.
    costs.gpu = checked_sum(&[
        checked_product(
            checked_product(u64::from(target.width), u64::from(target.height))?,
            16,
        )?,
        costs.texture_bytes,
        costs.raster_bytes,
        costs.buffer_bytes,
        costs.video_upload_peak_bytes,
        super::gl_plan::THREE_BOOTSTRAP_GPU_PEAK_BYTES,
    ])?;
    Ok(())
}

impl PreparedComposition {
    /// Seals the pure planner's facts once after all original prepare receipts.
    /// This does not grant production text capability or create a runtime owner.
    fn finish(mut self) -> Result<Self> {
        validate_structure(&self.compiled)?;
        for usage in self.final_values.resource_uses() {
            let asset = self
                .assets
                .get(&usage.asset_id)
                .ok_or_else(|| JobError::new("asset_not_found", "最终资源闭包未准备"))?;
            let reference = asset.reference();
            if reference.package_hash != self.package_hash
                || reference.asset_id != usage.asset_id
                || (asset.as_font().is_some() && reference.variant_id.is_some())
                || (usage.usage == "font") != asset.as_font().is_some()
            {
                return Err(JobError::new(
                    "font_not_prepared",
                    "最终资源准备对象不属于确切同包引用",
                ));
            }
        }
        self.text_rasters = text_raster::plan_text_rasters(
            &self.compiled,
            &self.final_values,
            &self
                .assets
                .iter()
                .filter_map(|(id, asset)| asset.as_font().map(|font| (id.clone(), font)))
                .collect(),
            self.target,
            self.output_fit,
        )?;
        self.costs()?;
        Ok(self)
    }

    fn number(&self, index: usize, property: &str) -> Result<f64> {
        final_number(&self.compiled, &self.final_values, index, property)
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
    fn asset_decode_options(&self, asset: &CompositionAsset) -> Value {
        match asset {
            CompositionAsset::Media(media) => self.decode_options(media),
            CompositionAsset::Font(font) => {
                json!({"colorSpace":"none","fontAdapterVersion":font.adapter_version()})
            }
        }
    }
    fn media_costs(&self) -> Result<Costs> {
        let mut cost = geometry_costs(&self.compiled, &self.final_values)?;
        let mut identities = BTreeSet::new();
        for usage in self.final_values.resource_uses() {
            // Font preparation has its own typed receipt; preliminary media
            // range checks still run before any decoder/native qualification.
            if usage.usage == "font" {
                continue;
            }
            let media = self
                .assets
                .get(&usage.asset_id)
                .and_then(CompositionAsset::as_media)
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
            let decoded_pixels = checked_product(
                u64::from(metadata.encoded_width),
                u64::from(metadata.encoded_height),
            )?;
            let texture_pixels = checked_product(
                u64::from(metadata.display_width),
                u64::from(metadata.display_height),
            )?;
            cost.texture_bytes =
                checked_sum(&[cost.texture_bytes, checked_product(texture_pixels, 4)?])?;
            cost.decode_bytes = checked_sum(&[
                cost.decode_bytes,
                checked_product(decoded_pixels, if is_video { 12 } else { 4 })?,
            ])?;
            if is_video {
                // The native GL owner fences same-size texImage storage
                // replacement. It admits only one unfinished frame at a time.
                cost.video_upload_peak_bytes = checked_sum(&[
                    cost.video_upload_peak_bytes,
                    checked_product(texture_pixels, 4)?,
                ])?;
                cost.decoders = cost.decoders.checked_add(1).ok_or_else(cost_exceeded)?;
                let fps = metadata
                    .fps_upper_bound
                    .filter(|fps| fps.is_finite() && *fps > 0.0 && *fps <= 240.0)
                    .ok_or_else(|| {
                        JobError::new("format_unsupported", "组合视频缺少真实帧率上界")
                    })?;
                let rate = (decoded_pixels as f64 * fps).ceil();
                if !rate.is_finite() || rate >= u64::MAX as f64 {
                    return Err(cost_exceeded());
                }
                cost.decode_rate = checked_sum(&[cost.decode_rate, rate as u64])?;
            }
        }
        Ok(cost)
    }

    fn costs(&self) -> Result<Costs> {
        let mut cost = self.media_costs()?;
        let closure_bytes = closure_costs(
            self.assets
                .values()
                .map(|asset| (asset.url().len() as u64, asset.content_key().len() as u64)),
        )?;
        complete_costs(
            &mut cost,
            &self.compiled,
            &self.final_values,
            &self.text_rasters,
            self.target,
            closure_bytes,
        )?;
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
        let pixels = checked_product(u64::from(self.target.width), u64::from(self.target.height))?;
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
            output_pixel_rate: checked_product(pixels, u64::from(refresh_hz))?
                .div_ceil(u64::from(divisor)),
            // Each unique video texture uploads on the original output frame
            // gate, even when source FPS is lower. Never charge author pixels.
            texture_upload_bytes_per_second: checked_product(
                cost.video_upload_peak_bytes,
                u64::from(refresh_hz),
            )?
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
            .map(|asset| {
                (
                    asset.reference().package_hash.clone(),
                    Arc::clone(asset.pin()),
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
        let resolved_assets: Vec<_> = self.assets.iter().map(|(id, asset)| match asset {
            CompositionAsset::Media(media) => json!({"assetId":id,"contentKey":media.content_key(),
                "kind":if media.input().metadata.container == Container::Image {"image"} else {"video"},
                "byteLength":media.input().media.entry.bytes,"width":media.input().metadata.display_width,
                "height":media.input().metadata.display_height,"durationMs":media.input().metadata.duration_ms,
                "url":media.url(),"decodeOptions":self.asset_decode_options(asset),"adapterId":Self::adapter(media),"adapterVersion":1}),
            CompositionAsset::Font(font) => json!({"assetId":id,"kind":"font","contentKey":font.content_key(),
                "byteLength":font.input().media.entry.bytes,"url":font.url(),"adapterId":font.adapter_id(),
                "adapterVersion":1,"decodeOptions":self.asset_decode_options(asset),"fontMetadata":font.input().metadata}),
        }).collect();
        let identities = self
            .assets
            .iter()
            .map(|(id, asset)| {
                let dependency_keys = match asset {
                    CompositionAsset::Media(media) => {
                        BTreeMap::from([("adapter".into(), digest(&Self::adapter(media))?)])
                    }
                    CompositionAsset::Font(font) => BTreeMap::from([
                        ("adapter".into(), digest(&font.adapter_id())?),
                        (
                            "fontAdapterVersion".into(),
                            digest(&font.adapter_version())?,
                        ),
                    ]),
                };
                Ok((
                    id.clone(),
                    ResolvedAssetIdentity {
                        content_key: asset.content_key().into(),
                        decode_options_hash: digest(&self.asset_decode_options(asset))?,
                        adapter_version: 1,
                        dependency_keys,
                    },
                ))
            })
            .collect::<Result<BTreeMap<_, _>>>()?;
        let identity = TargetIdentity {
            public_values: self.final_values.clone(),
            resolved_assets: identities,
            // Preserve the existing media-only cache identity. Text extends the
            // same target owner with the parser, raster and wrapping versions.
            capability_digest: if self.assets.values().any(|asset| asset.as_font().is_some()) {
                digest(&(
                    "p2-02-image-video-group-particles-v1",
                    super::font_prepare::ADAPTER_VERSION,
                    text_raster::ADAPTER_ID,
                    text_raster::ADAPTER_VERSION,
                    text_raster::WRAP_VERSION,
                ))?
            } else {
                digest(&"p2-02-image-video-group-particles-v1")?
            },
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
        let pixels = checked_product(u64::from(self.target.width), u64::from(self.target.height))?;
        let projection = json!({"semanticKey":self.compiled.ir().semantic_key(),"targetKey":target_key,"ir":self.compiled.ir(),
            "finalPublicValues":self.final_values,"canvas":self.compiled.document().canvas,"timeline":self.compiled.document().timeline,
            "resolvedAssets":resolved_assets,"textRasters":self.text_rasters.text_rasters(),"target":{"width":self.target.width,"height":self.target.height,"fit":self.output_fit,
                "budgetFps":identity.effective_budget_fps,"budgetAllocationRevision":allocation_revision},"sessionId":session_id,"generation":generation,
            "pageLimits":{"gpuContexts":1,"drawingBufferPixels":checked_sum(&[pixels,self.text_rasters.raster_pixels()])?,
                "renderTargetDeclaredBytes":checked_product(pixels,16)?,"textureDeclaredBytes":checked_sum(&[cost.texture_bytes,cost.raster_bytes])?,
                "bufferDeclaredBytes":cost.buffer_bytes,"ownedCpuBytes":checked_sum(&[cost.buffer_bytes,cost.font_cpu_bytes,cost.raster_bytes])?,"decodeReservedBytes":cost.decode_bytes,
                "decoderLeases":cost.decoders,"programs":cost.programs,"canvases":self.text_rasters.unique_raster_count()}});
        // Match the existing MediaAccess payload ceiling before granting the
        // composition scope or loading its first page.
        if serde_json::to_vec(&projection)
            .map_err(|error| JobError::io(error.to_string()))?
            .len()
            > 4 * 1024 * 1024
        {
            return Err(JobError::new(
                "budget_exceeded",
                "组合投影超出原权限载荷上限",
            ));
        }
        Ok(projection)
    }
}
