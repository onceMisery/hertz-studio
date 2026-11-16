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
    CompiledDocument, EffectTarget, FinalPublicValues, PublicTarget, ResolvedAssetIdentity,
    ResourceUse, StaticRequirement, TargetIdentity,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::assets::PinnedMedia;
use super::budget::{BudgetRequest, OwnerKind, ResourceAmounts, ResourcePlan, SessionPlan};
use super::font_prepare::{FontInput, PreparedFont, RequiredText};
use super::gl_plan::{GlLimits, GlPlan, SharedAssetsEnvelope};
use super::image_prepare::ImageTarget;
use super::jobs::{
    FontGroupPrepareRequest, FontPrepareRequest, ImportJobs, JobError, LeasedReceiver,
};
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
    Model(Box<PreparedModel>),
}

/// One installed GLB whose checked structure was projected into the shipped
/// static-core runtime facts. The pin and facts describe the same package entry.
#[derive(Clone)]
pub(crate) struct PreparedModel {
    reference: AssetRef,
    media: Arc<PinnedMedia>,
    url: String,
    content_key: String,
    texture_upload_bytes: u64,
    texture_urls: BTreeMap<String, String>,
    texture_pins: Vec<Arc<PinnedMedia>>,
    facts: Value,
}

impl PreparedModel {
    fn reference(&self) -> &AssetRef {
        &self.reference
    }
    fn pin(&self) -> &Arc<PinnedMedia> {
        &self.media
    }
    fn url(&self) -> &str {
        &self.url
    }
    fn content_key(&self) -> &str {
        &self.content_key
    }
    fn texture_upload_bytes(&self) -> u64 {
        self.texture_upload_bytes
    }
    fn texture_urls(&self) -> &BTreeMap<String, String> {
        &self.texture_urls
    }
    fn texture_pins(&self) -> &[Arc<PinnedMedia>] {
        &self.texture_pins
    }
    fn facts(&self) -> &Value {
        &self.facts
    }
}

impl CompositionAsset {
    fn as_media(&self) -> Option<&ResolvedMedia> {
        match self {
            Self::Media(media) => Some(media),
            Self::Font(_) | Self::Model(_) => None,
        }
    }
    fn as_font(&self) -> Option<&PreparedFont> {
        match self {
            Self::Font(font) => Some(font),
            Self::Media(_) | Self::Model(_) => None,
        }
    }
    fn as_model(&self) -> Option<&PreparedModel> {
        match self {
            Self::Model(model) => Some(model),
            Self::Media(_) | Self::Font(_) => None,
        }
    }
    fn reference(&self) -> &AssetRef {
        match self {
            Self::Media(media) => media.reference(),
            Self::Font(font) => font.reference(),
            Self::Model(model) => model.reference(),
        }
    }
    fn pin(&self) -> &Arc<PinnedMedia> {
        match self {
            Self::Media(media) => &media.input().media,
            Self::Font(font) => &font.input().media,
            Self::Model(model) => model.pin(),
        }
    }
    fn content_key(&self) -> &str {
        match self {
            Self::Media(media) => media.content_key(),
            Self::Font(font) => font.content_key(),
            Self::Model(model) => model.content_key(),
        }
    }
    fn url(&self) -> &str {
        match self {
            Self::Media(media) => media.url(),
            Self::Font(font) => font.url(),
            Self::Model(model) => model.url(),
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
    builtin_target: Option<Box<super::builtin_plan::BuiltinTargetPlan>>,
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
        let schema = if let Some(effect_index) = usage.effect_index {
            let effect = compiled
                .document()
                .effects
                .get(effect_index)
                .ok_or_else(|| JobError::invalid_input("效果资源索引无效"))?;
            catalog
                .definitions
                .effects
                .iter()
                .find(|schema| schema.effect_type == effect.effect_type)
                .and_then(|schema| schema.assets.get(&usage.field))
        } else {
            let node = usage
                .node_index
                .and_then(|index| compiled.ir().nodes().get(index))
                .ok_or_else(|| JobError::new("adapter_unavailable", "效果资源未准备"))?;
            catalog
                .definitions
                .nodes
                .iter()
                .find(|schema| schema.node_type == node.node_type)
                .and_then(|schema| schema.assets.get(&usage.field))
        }
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
        source: package.source.clone(),
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
    mut receive: LeasedReceiver<Result<T>>,
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
    let pin = store.pin_package_entry(package, document, &AtomicBool::new(false))?;
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
#[cfg(test)]
pub(crate) async fn resolve(
    jobs: Arc<ImportJobs>,
    package_hash: String,
    properties: serde_json::Map<String, Value>,
    target: ImageTarget,
    output_fit: super::config::Fit,
    cancel: Arc<AtomicBool>,
) -> Result<PreparedComposition> {
    resolve_with_target_facts(
        jobs,
        package_hash,
        properties,
        target,
        output_fit,
        None,
        cancel,
    )
    .await
}

pub(crate) async fn resolve_with_target_facts(
    jobs: Arc<ImportJobs>,
    package_hash: String,
    properties: serde_json::Map<String, Value>,
    target: ImageTarget,
    output_fit: super::config::Fit,
    target_facts: Option<super::builtin_plan::TargetFacts>,
    cancel: Arc<AtomicBool>,
) -> Result<PreparedComposition> {
    check_cancel(&cancel)?;
    let package = jobs.assets().read_installed_manifest(&package_hash)?;
    resolve_source(
        jobs,
        package,
        properties,
        target,
        output_fit,
        target_facts,
        cancel,
    )
    .await
}
pub(crate) async fn resolve_source(
    jobs: Arc<ImportJobs>,
    package: super::assets::StagedPackage,
    properties: serde_json::Map<String, Value>,
    target: ImageTarget,
    output_fit: super::config::Fit,
    target_facts: Option<super::builtin_plan::TargetFacts>,
    cancel: Arc<AtomicBool>,
) -> Result<PreparedComposition> {
    let package_hash = package.package_hash.clone();
    check_cancel(&cancel)?;
    let (compiled, final_values, document_pin) =
        read_document(jobs.assets(), &package, &properties)?;
    let builtin_target = super::builtin_plan::plan(
        &compiled,
        &final_values,
        target,
        output_fit,
        target_facts.as_ref(),
        &super::budget::global(),
    )?
    .map(Box::new);
    let target = builtin_target.as_ref().map_or(target, |plan| plan.target);
    // Metadata/target planning is complete before any media/font/text work.
    // Execution stays closed until costs, projection and the renderer qualify.
    validate_adapters(&compiled)?;
    validate_resource_uses(&compiled, &final_values, &package)?;
    let inputs = jobs.assets().probe_source_media(&package, &cancel)?;
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
        builtin_target: builtin_target.clone(),
    };
    let mut preliminary_costs = preliminary.media_costs_with_unprepared_vectors(true)?;
    if builtin_target.is_some() {
        complete_costs(
            &mut preliminary_costs,
            &compiled,
            &final_values,
            &TextRasterPlan::default(),
            target,
            0,
        )?;
    }
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
        builtin_target,
    };
    // Range qualification consumes the combined final numeric projection, not
    // the author's defaults or requested canvas dimensions.
    result.finish()
}

/// Pins one model texture entry, verifies its tuple and reads it for container
/// facts or upload-size parsing. The returned Arc is published only for used images.
fn pin_model_texture(
    jobs: &Arc<ImportJobs>,
    package: &super::assets::StagedPackage,
    path: &str,
    entry_bytes: u64,
    sha256: &str,
    mime: &str,
) -> Result<(Arc<PinnedMedia>, Vec<u8>)> {
    let media = jobs
        .assets()
        .pin_package_entry(package, path, &AtomicBool::new(false))?;
    if media.entry.bytes != entry_bytes
        || media.entry.sha256 != sha256
        || media.entry.mime.as_deref() != Some(mime)
    {
        return Err(JobError::new("hash_mismatch", "model 纹理条目不一致"));
    }
    let mut texture_bytes = Vec::with_capacity(
        usize::try_from(media.entry.bytes)
            .unwrap_or(usize::MAX)
            .saturating_add(1),
    );
    super::assets::open_immutable(&media.path)?
        .take(hertz_wallpaper::MAX_MODEL_BYTES + 1)
        .read_to_end(&mut texture_bytes)
        .map_err(|error| JobError::io(format!("读取固定模型纹理失败：{error}")))?;
    if texture_bytes.len() as u64 != media.entry.bytes {
        return Err(JobError::new("hash_mismatch", "model 纹理长度变化"));
    }
    Ok((media, texture_bytes))
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
        let vector = package
            .manifest
            .assets
            .iter()
            .any(|a| a.id == usage.asset_id && a.kind == hertz_wallpaper::AssetKind::Vector);
        let representation = if vector {
            svg_use_id(usage)
        } else {
            usage.asset_id.clone()
        };
        if assets.contains_key(&representation) {
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
                    super::selection_plan::prepare_target_source(
                        Arc::clone(jobs),
                        AssetRef {
                            package_hash: package.package_hash.clone(),
                            asset_id: asset.id.clone(),
                            variant_id: None,
                        },
                        target,
                        Arc::clone(cancel),
                        package.source.clone(),
                    )
                    .await?,
                )
            }
            hertz_wallpaper::AssetKind::Vector => {
                let node_index = usage.node_index.ok_or_else(|| {
                    JobError::new("adapter_unavailable", "SVG effect 资源尚未准备")
                })?;
                let scale = text_raster::consumer_sampling_scale(
                    compiled,
                    final_values,
                    node_index,
                    target,
                    output_fit,
                )?;
                let node = &compiled.ir().nodes()[node_index];
                let (width, height) = if node.node_type == "particles" {
                    (4.0, 4.0)
                } else {
                    (
                        final_number(compiled, final_values, node_index, "width")?,
                        final_number(compiled, final_values, node_index, "height")?,
                    )
                };
                let sample = |v: f64| -> Result<u32> {
                    let pixels = (v * scale).ceil().max(1.0);
                    if !pixels.is_finite() || pixels > 16384.0 {
                        return Err(JobError::new("budget_exceeded", "SVG 最终采样目标超限"));
                    }
                    Ok(pixels as u32)
                };
                let fit = if node.node_type == "particles" {
                    super::image_prepare::ImageFit::Contain
                } else {
                    let slot = node
                        .constant_slots
                        .get("fit")
                        .ok_or_else(|| JobError::invalid_input("SVG fit 槽缺失"))?;
                    let authored=compiled.ir().public_properties().iter().find_map(|public|if matches!(public.target,PublicTarget::Constant{slot:target} if target==*slot){final_values.values().get(&public.descriptor.id).and_then(Value::as_str)}else{None}).unwrap_or_else(||compiled.ir().constant_slots()[*slot].value.as_str().unwrap_or("contain"));
                    if authored == "cover" || authored == "stretch" {
                        super::image_prepare::ImageFit::Cover
                    } else {
                        super::image_prepare::ImageFit::Contain
                    }
                };
                // Original particles shader fixes gl_PointSize=4 output pixels; ancestor
                // transforms move centers, they do not scale the raster footprint.
                let (width, height) = if node.node_type == "particles" {
                    (4, 4)
                } else {
                    (sample(width)?, sample(height)?)
                };
                let vector_target = ImageTarget {
                    width,
                    height,
                    fit,
                    purpose: target.purpose,
                };
                let (job_id, receive) = jobs.prepare_svg(
                    super::jobs::new_job_id(),
                    super::jobs::SvgPrepareRequest {
                        source: package.source.clone(),
                        reference: AssetRef {
                            package_hash: package.package_hash.clone(),
                            asset_id: asset.id.clone(),
                            variant_id: None,
                        },
                        target: vector_target,
                        usage: usage.usage.clone(),
                    },
                )?;
                CompositionAsset::Media(wait_font_reply(jobs, &job_id, receive, cancel).await?)
            }
            hertz_wallpaper::AssetKind::Font => {
                return Err(JobError::new("font_not_prepared", "最终字体没有文字集合"));
            }
            hertz_wallpaper::AssetKind::Model => {
                let media = jobs
                    .assets()
                    .pin_package_entry(package, &asset.source, cancel)?;
                if media.entry.path != asset.source {
                    return Err(JobError::new("hash_mismatch", "model 条目路径不一致"));
                }
                check_cancel(cancel)?;
                let mut bytes = Vec::with_capacity(media.entry.bytes as usize + 1);
                super::assets::open_immutable(&media.path)?
                    .take(hertz_wallpaper::MAX_MODEL_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|error| JobError::io(format!("读取固定模型失败：{error}")))?;
                check_cancel(cancel)?;
                if bytes.len() as u64 != media.entry.bytes {
                    return Err(JobError::new("hash_mismatch", "model 条目长度变化"));
                }
                let checked =
                    hertz_wallpaper::model_binary::inspect_glb_resource_content_with_cancel(
                        &bytes[..],
                        media.entry.bytes,
                        &package.manifest,
                        &asset.source,
                        Some(cancel),
                    )
                    .map_err(package_error)?;
                let structure = &checked.resource().structure;
                let ktx2 = structure.images.iter().any(|image| {
                    matches!(
                        image,
                        hertz_wallpaper::model_structure::ModelImage::Embedded { mime, .. }
                            | hertz_wallpaper::model_structure::ModelImage::Package { mime, .. }
                            if mime == "image/ktx2"
                    )
                });
                let textured = !structure.images.is_empty()
                    || !structure.materials.is_empty()
                    || !structure.textures.is_empty();
                // KTX2 container facts consume the same pinned bytes an external
                // URL serves. Only declared basisu texture images are read here;
                // publication below stays limited to used images.
                let mut pinned_textures: BTreeMap<usize, Arc<PinnedMedia>> = BTreeMap::new();
                let mut external_textures = BTreeMap::new();
                if ktx2 {
                    for texture in &structure.textures {
                        let Some(hertz_wallpaper::model_structure::ModelImage::Package {
                            path,
                            mime,
                            bytes: entry_bytes,
                            sha256,
                            ..
                        }) = structure.images.get(texture.source)
                        else {
                            continue;
                        };
                        if mime != "image/ktx2" || external_textures.contains_key(&texture.source) {
                            continue;
                        }
                        let (pinned, texture_bytes) =
                            pin_model_texture(jobs, package, path, *entry_bytes, sha256, mime)?;
                        pinned_textures.insert(texture.source, pinned);
                        external_textures.insert(texture.source, texture_bytes);
                    }
                }
                let facts = if ktx2 {
                    hertz_wallpaper::model_profile::static_ktx2_profile_facts(
                        &bytes,
                        checked.resource(),
                        checked.bytes(),
                        &asset.source,
                        &external_textures,
                    )
                    .map_err(package_error)?
                } else if textured {
                    hertz_wallpaper::model_profile::static_textured_profile_facts(
                        checked.resource(),
                        checked.bytes(),
                        &asset.source,
                    )
                    .map_err(package_error)?
                } else {
                    hertz_wallpaper::model_profile::static_core_profile_facts(
                        checked.resource(),
                        checked.bytes(),
                    )
                    .map_err(package_error)?
                };
                let profile = facts["profile"]
                    .as_str()
                    .ok_or_else(|| JobError::new("adapter_unavailable", "model profile 无效"))?
                    .to_owned();
                let mut texture_upload_bytes = 0_u64;
                let mut texture_urls = BTreeMap::new();
                let mut texture_pins: Vec<Arc<PinnedMedia>> = Vec::new();
                if profile == "static-pbr-texture-v1" {
                    let images = facts["images"]
                        .as_array()
                        .ok_or_else(|| JobError::new("adapter_unavailable", "model images 缺失"))?;
                    let structure = &checked.resource().structure;
                    for image in images {
                        let index = image["index"].as_u64().ok_or_else(|| {
                            JobError::new("adapter_unavailable", "model image 索引无效")
                        })? as usize;
                        let fact = structure.images.get(index).ok_or_else(|| {
                            JobError::new("adapter_unavailable", "model image 索引无效")
                        })?;
                        let upload = match fact {
                            hertz_wallpaper::model_structure::ModelImage::Embedded { .. } => {
                                hertz_wallpaper::model_profile::embedded_image_upload_bytes(
                                    &bytes,
                                    checked.resource(),
                                    index,
                                )
                                .map_err(package_error)?
                            }
                            hertz_wallpaper::model_structure::ModelImage::Package {
                                path,
                                mime,
                                bytes: entry_bytes,
                                sha256,
                                ..
                            } => {
                                let uri = image["uri"].as_str().ok_or_else(|| {
                                    JobError::new("adapter_unavailable", "model texture URI 无效")
                                })?;
                                let (media, texture_bytes) = pin_model_texture(
                                    jobs,
                                    package,
                                    path,
                                    *entry_bytes,
                                    sha256,
                                    mime,
                                )?;
                                let url =
                                    super::webresource::files_url(&package.package_hash, path)
                                        .ok_or_else(|| {
                                            JobError::new(
                                                "adapter_unavailable",
                                                "model 纹理 URL 无效",
                                            )
                                        })?;
                                texture_urls.insert(uri.to_owned(), url);
                                if !texture_pins.iter().any(|pinned| pinned.path == media.path) {
                                    texture_pins.push(Arc::clone(&media));
                                }
                                hertz_wallpaper::model_profile::image_upload_bytes(
                                    &texture_bytes,
                                    mime,
                                )
                                .map_err(package_error)?
                            }
                        };
                        texture_upload_bytes = checked_sum(&[texture_upload_bytes, upload])?;
                    }
                    if texture_upload_bytes == 0 {
                        return Err(JobError::new(
                            "adapter_unavailable",
                            "model textures 未准备",
                        ));
                    }
                } else if profile == "static-ktx2-texture-v1" {
                    let images = facts["images"]
                        .as_array()
                        .ok_or_else(|| JobError::new("adapter_unavailable", "model images 缺失"))?;
                    for image in images {
                        let index = image["index"].as_u64().ok_or_else(|| {
                            JobError::new("adapter_unavailable", "model image 索引无效")
                        })? as usize;
                        let upload = image["uploadBytes"].as_u64().ok_or_else(|| {
                            JobError::new("adapter_unavailable", "KTX2 上传字节无效")
                        })?;
                        texture_upload_bytes = checked_sum(&[texture_upload_bytes, upload])?;
                        if image["source"] != "external" {
                            continue;
                        }
                        let uri = image["uri"].as_str().ok_or_else(|| {
                            JobError::new("adapter_unavailable", "KTX2 纹理 URI 无效")
                        })?;
                        let pinned = pinned_textures
                            .get(&index)
                            .ok_or_else(|| JobError::new("hash_mismatch", "KTX2 纹理未固定"))?;
                        let url = super::webresource::files_url(
                            &package.package_hash,
                            &pinned.entry.path,
                        )
                        .ok_or_else(|| {
                            JobError::new("adapter_unavailable", "KTX2 纹理 URL 无效")
                        })?;
                        texture_urls.insert(uri.to_owned(), url);
                        if !texture_pins.iter().any(|item| item.path == pinned.path) {
                            texture_pins.push(Arc::clone(pinned));
                        }
                    }
                    if texture_upload_bytes == 0 {
                        return Err(JobError::new(
                            "adapter_unavailable",
                            "KTX2 model textures 未准备",
                        ));
                    }
                }
                // Three packs morph POSITION/NORMAL targets into a per-geometry
                // DataArrayTexture; its upload is a texture cost, not a vertex buffer.
                texture_upload_bytes = checked_sum(&[
                    texture_upload_bytes,
                    facts["resources"]["morphTextureBytes"]
                        .as_u64()
                        .unwrap_or(0),
                    facts["resources"]["skinTextureBytes"].as_u64().unwrap_or(0),
                ])?;
                let url = super::webresource::files_url(&package.package_hash, &asset.source)
                    .ok_or_else(|| JobError::new("adapter_unavailable", "model URL 无效"))?;
                CompositionAsset::Model(Box::new(PreparedModel {
                    reference: AssetRef {
                        package_hash: package.package_hash.clone(),
                        asset_id: asset.id.clone(),
                        variant_id: None,
                    },
                    media,
                    url,
                    content_key: checked.sha256_hex(),
                    texture_upload_bytes,
                    texture_urls,
                    texture_pins,
                    facts,
                }))
            }
            _ => {
                return Err(JobError::new(
                    "adapter_unavailable",
                    format!("组合资源尚无已准备 adapter：{}", asset.id),
                ));
            }
        };
        assets.insert(representation, prepared);
        if assets.len() > hertz_wallpaper::MAX_FILES {
            return Err(JobError::new("budget_exceeded", "组合表示数超过原闭包限额"));
        }
    }
    check_cancel(cancel)?;
    Ok(assets)
}

fn svg_use_id(usage: &hertz_wallpaper::document::ResourceUse) -> String {
    // Author asset IDs only admit [a-z][a-z0-9-]{0,63}.
    format!(
        "@svg-use/{}/{}",
        usage.node_index.unwrap_or(usize::MAX),
        usage.field
    )
}

/// Effect-owned resources (currently only the mask texture) have no direct
/// node index; their sampler still belongs to the effect target node.
fn usage_node_index(compiled: &CompiledDocument, usage: &ResourceUse) -> Option<usize> {
    if let Some(index) = usage.node_index {
        return Some(index);
    }
    let effect = compiled.document().effects.get(usage.effect_index?)?;
    match &effect.target {
        EffectTarget::Node { node_id } => compiled
            .ir()
            .nodes()
            .iter()
            .position(|node| &node.id == node_id),
        EffectTarget::Output => None,
    }
}

fn validate_adapters(compiled: &CompiledDocument) -> Result<()> {
    // A declaration grants no access: text still needs sealed glyph coverage,
    // native FontFace qualification, complete admission and real first submit.
    validate_structure(compiled)
}

fn validate_structure(compiled: &CompiledDocument) -> Result<()> {
    let document = compiled.document();
    let graphic3d = compiled
        .ir()
        .nodes()
        .iter()
        .any(|node| node.node_type != "builtinScene" && node.space == "3d");
    if graphic3d && document.canvas.scene3d.is_none() {
        return Err(JobError::new(
            "adapter_unavailable",
            "3D 节点必须声明 canvas.scene3d 相机",
        ));
    }
    if graphic3d {
        let mut seen2d = false;
        for &index in compiled.ir().painter_order() {
            let node = &compiled.ir().nodes()[index];
            if node.node_type == "builtinScene" {
                continue;
            }
            if node.space == "3d" {
                if seen2d {
                    return Err(JobError::new(
                        "adapter_unavailable",
                        "3D 节点必须是 painterOrder 前缀",
                    ));
                }
            } else {
                seen2d = true;
            }
        }
    }
    // Tracks are evaluated by the shipped runtime only for plain numeric
    // properties; layout rebuilds, particle instance changes and 3D transforms
    // would need a new static plan, so the native projection rejects them here.
    for track in compiled.ir().tracks() {
        let slot = compiled
            .ir()
            .numeric_slots()
            .get(track.target_slot)
            .ok_or_else(|| JobError::new("adapter_unavailable", "P2-02 track target 无效"))?;
        let node = compiled
            .ir()
            .nodes()
            .get(slot.node_index)
            .ok_or_else(|| JobError::new("adapter_unavailable", "P2-02 track target 无效"))?;
        let rebuild = node.space == "3d"
            || node.node_type == "builtinScene"
            || (node.node_type == "text"
                && ["width", "height", "fontSize", "lineHeight"].contains(&slot.property.as_str()))
            || (node.node_type == "particles"
                && ["count", "seed"].contains(&slot.property.as_str()));
        if rebuild {
            return Err(JobError::new(
                "adapter_unavailable",
                format!(
                    "P2-02 track adapter 尚未准备：{}:{}",
                    node.node_type, slot.property
                ),
            ));
        }
    }
    for binding in compiled.ir().bindings() {
        let node = compiled
            .ir()
            .numeric_slots()
            .get(binding.target_slot)
            .and_then(|slot| compiled.ir().nodes().get(slot.node_index));
        if node.is_some_and(|node| node.space == "3d") {
            return Err(JobError::new(
                "adapter_unavailable",
                "3D binding adapter 尚未准备",
            ));
        }
    }
    for effect in &document.effects {
        let supported = matches!(
            (&effect.target, effect.effect_type.as_str()),
            (EffectTarget::Output, "colorAdjust" | "glow")
                | (
                    EffectTarget::Node { .. },
                    "colorAdjust" | "ripple" | "wind" | "mask"
                )
        );
        if !supported {
            return Err(JobError::new(
                "adapter_unavailable",
                format!("P2-02 effect adapter 尚未准备：{}", effect.effect_type),
            ));
        }
        if let EffectTarget::Node { node_id } = &effect.target {
            let node = compiled
                .ir()
                .nodes()
                .iter()
                .find(|node| &node.id == node_id)
                .ok_or_else(|| JobError::new("adapter_unavailable", "effect target 无效"))?;
            if node.space == "3d" {
                return Err(JobError::new(
                    "adapter_unavailable",
                    "3D 节点 effect adapter 尚未准备",
                ));
            }
        }
        // The mask effect is the only effect with one prepared mask texture;
        // every other effect must stay asset-free until its own adapter lands.
        if !effect.assets.is_empty() && effect.effect_type != "mask" {
            return Err(JobError::new(
                "adapter_unavailable",
                format!("P2-02 effect 资源尚未准备：{}", effect.effect_type),
            ));
        }
    }
    for node in compiled.ir().nodes() {
        if node.node_type == "builtinScene" {
            continue;
        }
        if !matches!(
            node.node_type.as_str(),
            "image" | "video" | "group" | "particles" | "text" | "model"
        ) || (node.space != "2d"
            && (node.space != "3d" || !matches!(node.node_type.as_str(), "group" | "model")))
        {
            return Err(JobError::new(
                "adapter_unavailable",
                format!("P2-02 adapter 尚未准备：{}:{}", node.node_type, node.space),
            ));
        }
        let mut clip_names: Vec<&str> = Vec::new();
        for property in ["animationClip", "animationClipB"] {
            if let Some(clip) = node
                .constant_slots
                .get(property)
                .and_then(|slot| compiled.ir().constant_slots()[*slot].value.as_str())
                .filter(|clip| !clip.is_empty())
            {
                if node.node_type != "model" || node.space != "3d" || clip.len() > 128 {
                    return Err(JobError::new(
                        "adapter_unavailable",
                        "model animation 仅支持 3D model 节点的有界 clip 名称",
                    ));
                }
                clip_names.push(clip);
            }
        }
        if clip_names.len() == 2 && clip_names[0] == clip_names[1] {
            return Err(JobError::new(
                "adapter_unavailable",
                "model animation 混合两侧不能使用同一 clip",
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
    private_cpu_bytes: u64,
    source_cpu_retained_bytes: u64,
    input_bytes: u64,
    depth_bytes_per_pixel: u64,
    draw_calls: u64,
    points: u64,
    triangles: u64,
    effect_surface_bytes: u64,
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

fn final_constant(
    compiled: &CompiledDocument,
    final_values: &FinalPublicValues,
    index: usize,
    property: &str,
) -> Result<String> {
    let node = &compiled.ir().nodes()[index];
    let slot = *node
        .constant_slots
        .get(property)
        .ok_or_else(|| JobError::invalid_input("组合常量槽缺失"))?;
    Ok(compiled
        .ir()
        .public_properties()
        .iter()
        .find_map(|public| {
            if matches!(public.target, PublicTarget::Constant { slot: target } if target == slot) {
                final_values
                    .values()
                    .get(&public.descriptor.id)
                    .and_then(Value::as_str)
            } else {
                None
            }
        })
        .unwrap_or_else(|| {
            compiled.ir().constant_slots()[slot]
                .value
                .as_str()
                .unwrap_or("")
        })
        .to_owned())
}

fn geometry_costs(compiled: &CompiledDocument, final_values: &FinalPublicValues) -> Result<Costs> {
    validate_structure(compiled)?;
    let mut costs = Costs {
        buffer_bytes: 92,
        private_cpu_bytes: 92,
        programs: 2,
        draw_calls: 1,
        triangles: 2,
        ..Default::default()
    };
    let source = super::builtin_plan::source_costs(compiled, final_values)?;
    if let Some((profile, clock)) = &source {
        costs.buffer_bytes =
            checked_sum(&[costs.buffer_bytes, profile.source_resources.buffer_bytes])?;
        costs.private_cpu_bytes = checked_sum(&[
            costs.private_cpu_bytes,
            profile.source_resources.cpu_peak_bytes,
        ])?;
        costs.source_cpu_retained_bytes = profile.source_resources.cpu_retained_bytes;
        costs.input_bytes = clock.input_bytes;
        costs.depth_bytes_per_pixel = 4;
        costs.programs += profile.source_resources.programs;
        costs.draw_calls += profile.source_primitives.draw_calls;
        costs.points += profile.source_primitives.points;
        costs.triangles += profile.source_primitives.triangles;
    }
    for (index, node) in compiled.ir().nodes().iter().enumerate() {
        if node.space == "3d" && node.node_type != "builtinScene" {
            let opacity = final_number(compiled, final_values, index, "opacity")?;
            if !(0.0..=1.0).contains(&opacity) {
                return Err(JobError::new(
                    "adapter_unavailable",
                    "3D 节点 opacity 必须是 0..1 内的有限值",
                ));
            }
            costs.depth_bytes_per_pixel = 4;
        }
        if node.node_type == "model" {
            let weight = final_number(compiled, final_values, index, "animationWeight")?;
            if !(0.0..=1.0).contains(&weight) {
                return Err(JobError::new(
                    "adapter_unavailable",
                    "model animationWeight 必须是 0..1 内的有限值",
                ));
            }
        }
        let bytes = match node.node_type.as_str() {
            "group" | "builtinScene" | "model" => 0,
            "particles" => {
                costs.programs = costs.programs.max(if source.is_some() { 7 } else { 3 });
                let count = final_number(compiled, final_values, index, "count")? as u64;
                costs.draw_calls += 1;
                costs.points += count;
                checked_product(count, 20)?
            }
            _ => {
                costs.draw_calls += 1;
                costs.triangles += 2;
                92
            }
        };
        costs.buffer_bytes = checked_sum(&[costs.buffer_bytes, bytes])?;
        costs.private_cpu_bytes = checked_sum(&[costs.private_cpu_bytes, bytes])?;
    }
    if source.as_ref().is_some_and(|(profile, _)| {
        costs.draw_calls > profile.draw_calls
            || costs.points > profile.particles
            || costs.triangles > profile.triangles
    }) {
        return Err(JobError::new(
            "budget_exceeded",
            "builtinScene 整组合 primitive 成本超出 source low profile",
        ));
    }
    // Output effects own real passes/programs in the shipped runtime: glow is a
    // threshold plus one shared two-axis blur program, node effects reuse the
    // node program and only change uniforms.
    for requirement in compiled.ir().static_requirements() {
        let StaticRequirement::EffectSurfaces {
            effect_index,
            count,
            cost,
            ..
        } = requirement
        else {
            continue;
        };
        if *count == 0 {
            continue;
        }
        let effect = &compiled.document().effects[*effect_index];
        let passes = u64::from(cost.draw_passes);
        costs.draw_calls = checked_sum(&[costs.draw_calls, passes])?;
        costs.triangles = checked_sum(&[costs.triangles, checked_product(passes, 2)?])?;
        if effect.effect_type == "glow" {
            costs.programs = checked_sum(&[costs.programs, 2])?;
        }
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
    let mut effect_surface_bytes = 0_u64;
    for requirement in compiled.ir().static_requirements() {
        let StaticRequirement::EffectSurfaces {
            count,
            sample_scale,
            cost,
            ..
        } = requirement
        else {
            continue;
        };
        if *count == 0 {
            continue;
        }
        let width = (f64::from(target.width) * sample_scale).ceil().max(1.0) as u64;
        let height = (f64::from(target.height) * sample_scale).ceil().max(1.0) as u64;
        let surface = checked_product(width, height)?;
        let surfaces = checked_product(surface, u64::from(*count))?;
        effect_surface_bytes = checked_sum(&[
            effect_surface_bytes,
            checked_product(surfaces, u64::from(cost.bytes_per_pixel))?,
        ])?;
    }
    costs.effect_surface_bytes = effect_surface_bytes;
    costs.cpu = checked_sum(&[
        costs.decode_bytes,
        costs.private_cpu_bytes,
        costs.input_bytes,
        costs.semantic_bytes,
        costs.font_cpu_bytes,
        costs.raster_bytes,
    ])?;
    // Original RGBA8/depth buffer (8P), linear RGBA16F target (8P),
    // actual textures/private geometry, effect surfaces and unfinished
    // video/bootstrap peaks.
    costs.gpu = checked_sum(&[
        checked_product(
            checked_product(u64::from(target.width), u64::from(target.height))?,
            16 + costs.depth_bytes_per_pixel,
        )?,
        costs.texture_bytes,
        costs.raster_bytes,
        costs.buffer_bytes,
        costs.video_upload_peak_bytes,
        costs.effect_surface_bytes,
        super::gl_plan::THREE_BOOTSTRAP_GPU_PEAK_BYTES,
    ])?;
    if super::builtin_plan::source_costs(compiled, final_values)?
        .as_ref()
        .is_some_and(|(profile, _)| {
            costs.gpu > profile.memory_bytes || costs.cpu > profile.memory_bytes
        })
    {
        return Err(JobError::new(
            "budget_exceeded",
            "builtinScene 整组合 CPU/GPU 成本超出 source low memoryBytes",
        ));
    }
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
                .or_else(|| self.assets.get(&svg_use_id(usage)))
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
        if let Some(svg) = media.svg() {
            return json!({"colorSpace":"srgb","alphaMode":"straight","mipmaps":false,"encodedWidth":media.input().metadata.encoded_width,"encodedHeight":media.input().metadata.encoded_height,"rotationDegrees":0,"svgAdapterVersion":super::svg_prepare::PIPELINE,"svgCanonicalOptions":svg.options,"svgFontDependencies":svg.fonts});
        }
        json!({"colorSpace":"srgb","alphaMode":"straight","mipmaps":false,
            "encodedWidth":media.input().metadata.encoded_width,"encodedHeight":media.input().metadata.encoded_height,
            "rotationDegrees":media.input().metadata.rotation_degrees})
    }
    fn adapter(media: &ResolvedMedia) -> &'static str {
        if media.svg().is_some() {
            super::svg_prepare::ADAPTER_ID
        } else if media.input().metadata.container == Container::Image {
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
            CompositionAsset::Model(model) => json!({"profile": model.facts()["profile"]}),
        }
    }
    fn media_costs(&self) -> Result<Costs> {
        self.media_costs_with_unprepared_vectors(false)
    }
    fn media_costs_with_unprepared_vectors(&self, allow_unprepared: bool) -> Result<Costs> {
        let mut cost = geometry_costs(&self.compiled, &self.final_values)?;
        for (index, node) in self.compiled.ir().nodes().iter().enumerate() {
            if self.assets.is_empty() {
                break;
            }
            if node.node_type != "model" {
                continue;
            }
            let clip = final_constant(&self.compiled, &self.final_values, index, "animationClip")?;
            if clip.is_empty() {
                continue;
            }
            let usage = self
                .final_values
                .resource_uses()
                .iter()
                .find(|usage| {
                    usage.node_index == Some(index)
                        && usage.field == "asset"
                        && usage.usage == "model"
                })
                .ok_or_else(|| {
                    JobError::new("adapter_unavailable", "model animation 资源未准备")
                })?;
            let available = self
                .assets
                .get(&usage.asset_id)
                .and_then(CompositionAsset::as_model);
            let names: Vec<String> = available
                .iter()
                .flat_map(|model| {
                    model.facts()["animations"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|animation| animation["name"].as_str().map(str::to_owned))
                        .collect::<Vec<_>>()
                })
                .collect();
            if !names.iter().any(|name| name == &clip) {
                return Err(JobError::new(
                    "adapter_unavailable",
                    "model animation clip 未准备",
                ));
            }
            let clip_b =
                final_constant(&self.compiled, &self.final_values, index, "animationClipB")?;
            if !clip_b.is_empty() && !names.iter().any(|name| name == &clip_b) {
                return Err(JobError::new(
                    "adapter_unavailable",
                    "model animation clip 未准备",
                ));
            }
        }
        let mut identities = BTreeSet::new();
        for usage in self.final_values.resource_uses() {
            // Font preparation has its own typed receipt; model preparation is
            // a checked GLB projection with its own facts-based costs below.
            if usage.usage == "font" || usage.usage == "model" {
                continue;
            }
            let media = self
                .assets
                .get(&usage.asset_id)
                .or_else(|| self.assets.get(&svg_use_id(usage)))
                .and_then(CompositionAsset::as_media);
            let Some(media) = media else {
                if allow_unprepared {
                    continue;
                }
                return Err(JobError::new("asset_not_found", "最终资源闭包未准备"));
            };
            let metadata = &media.input().metadata;
            let index = usage_node_index(&self.compiled, usage)
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
        for asset in self.assets.values() {
            let Some(model) = asset.as_model() else {
                continue;
            };
            let facts = model.facts();
            let invalid = || JobError::new("adapter_unavailable", "model facts 无效");
            let input = facts.get("input").ok_or_else(invalid)?;
            let resources = facts.get("resources").ok_or_else(invalid)?;
            let scene = facts.get("scene").ok_or_else(invalid)?;
            let json = input["jsonBytes"].as_u64().ok_or_else(invalid)?;
            let animation_cpu = if facts
                .get("animations")
                .and_then(Value::as_array)
                .is_some_and(|animations| !animations.is_empty())
            {
                resources["animationCpuBytes"]
                    .as_u64()
                    .ok_or_else(invalid)?
            } else {
                0
            };
            let skin_cpu = resources["skinCpuBytes"].as_u64().unwrap_or(0);
            let material_clone_bytes = checked_product(
                std::cmp::max(1, resources["materialCount"].as_u64().unwrap_or(1)),
                1024,
            )?;
            cost.buffer_bytes = checked_sum(&[
                cost.buffer_bytes,
                resources["gpuBufferBytes"].as_u64().ok_or_else(invalid)?,
            ])?;
            cost.private_cpu_bytes = checked_sum(&[
                cost.private_cpu_bytes,
                input["encodedBytes"].as_u64().ok_or_else(invalid)?,
                input["binBytes"].as_u64().ok_or_else(invalid)?,
                checked_product(json, 2)?,
                resources["cpuBackingBytes"].as_u64().ok_or_else(invalid)?,
                animation_cpu,
                skin_cpu,
                material_clone_bytes,
            ])?;
            let program_count = resources["programCount"]
                .as_u64()
                .or_else(|| resources["materialCount"].as_u64())
                .unwrap_or(1);
            cost.programs = checked_sum(&[cost.programs, std::cmp::max(1, program_count)])?;
            if model.texture_upload_bytes() > 0 {
                cost.texture_bytes =
                    checked_sum(&[cost.texture_bytes, model.texture_upload_bytes()])?;
                cost.decode_bytes =
                    checked_sum(&[cost.decode_bytes, model.texture_upload_bytes()])?;
            }
            // The original native page binds one fixed small fallback texture
            // even for a texture-free composition; declare bounded headroom so
            // the page GL reservation can cover it without touching caps.
            cost.texture_bytes = checked_sum(&[cost.texture_bytes, 4096])?;
            cost.draw_calls = checked_sum(&[
                cost.draw_calls,
                scene["drawCalls"].as_u64().ok_or_else(invalid)?,
            ])?;
            cost.triangles = checked_sum(&[
                cost.triangles,
                scene["triangles"].as_u64().ok_or_else(invalid)?,
            ])?;
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
        if self.builtin_target.as_ref().is_some_and(|plan| {
            let planned_owner =
                if plan.target_facts.purpose == super::image_prepare::ImagePurpose::Preview {
                    OwnerKind::Preview
                } else {
                    OwnerKind::Desktop
                };
            owner != planned_owner || refresh_hz != plan.allowance.refresh_hz
        }) {
            return Err(JobError::invalid_input(
                "builtinScene 输出用途或刷新率已改变，必须重新规划",
            ));
        }
        let cost = self.costs()?;
        let fps = if owner == OwnerKind::Preview {
            fps.min(15)
        } else {
            fps
        };
        let fps = self
            .builtin_target
            .as_ref()
            .map_or(fps, |plan| fps.min(plan.allowance.effective_fps));
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
                requested_quality: self
                    .builtin_target
                    .as_ref()
                    .map_or_else(|| "low".into(), |plan| plan.requested_quality.clone()),
                fps,
                requested_fps: self
                    .builtin_target
                    .as_ref()
                    .map_or(fps, |plan| plan.target_facts.requested_fps),
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
    pub(crate) fn builtin_target(&self) -> Option<&super::builtin_plan::BuiltinTargetPlan> {
        self.builtin_target.as_deref()
    }
    pub(crate) fn output_fit(&self) -> super::config::Fit {
        self.output_fit
    }
    pub(crate) fn package_hash(&self) -> &str {
        &self.package_hash
    }
    pub(crate) fn pins(&self) -> Vec<(String, Arc<PinnedMedia>)> {
        let mut pins: Vec<(String, Arc<PinnedMedia>)> = self
            .assets
            .values()
            .map(|asset| {
                (
                    asset.reference().package_hash.clone(),
                    Arc::clone(asset.pin()),
                )
            })
            .collect();
        // External model textures are package entries outside the asset map;
        // their broker keys must stay pinned for the whole composition lifetime.
        for asset in self.assets.values() {
            if let Some(model) = asset.as_model() {
                for pin in model.texture_pins() {
                    pins.push((model.reference().package_hash.clone(), Arc::clone(pin)));
                }
            }
        }
        pins
    }
    pub(crate) fn projection(
        &self,
        session_id: &str,
        generation: u64,
        allocation_revision: u64,
        limits: &GlLimits,
    ) -> Result<Value> {
        let resolved_assets: Vec<_> = self.assets.iter().map(|(id, asset)| match asset {
            CompositionAsset::Media(media) => json!({"assetId":media.reference().asset_id,"representationId":id,"contentKey":media.content_key(),
                "logicalKind":if media.svg().is_some(){"vector"}else if media.input().metadata.container==Container::Image{"image"}else{"video"},
                "representationKind":if media.input().metadata.container==Container::Image{"image"}else{"video"},"mime":media.input().media.entry.mime,
                "sourceHash":media.svg().map(|svg|svg.input_hash.as_str()),
                "kind":if media.input().metadata.container == Container::Image {"image"} else {"video"},
                "byteLength":media.input().media.entry.bytes,"width":media.input().metadata.display_width,
                "height":media.input().metadata.display_height,"durationMs":media.input().metadata.duration_ms,
                "url":media.url(),"decodeOptions":self.asset_decode_options(asset),"adapterId":Self::adapter(media),"adapterVersion":1}),
            CompositionAsset::Font(font) => json!({"assetId":id,"representationId":id,"kind":"font","contentKey":font.content_key(),
                "byteLength":font.input().media.entry.bytes,"url":font.url(),"adapterId":font.adapter_id(),
                "adapterVersion":1,"decodeOptions":self.asset_decode_options(asset),"fontMetadata":font.input().metadata}),
            CompositionAsset::Model(model) => {
                let mut value = json!({"assetId":id,"representationId":id,"kind":"model",
                    "logicalKind":"model","representationKind":"model","mime":"model/gltf-binary",
                    "contentKey":model.content_key(),"byteLength":model.pin().entry.bytes,"url":model.url(),
                    "adapterId":"three-gltf-loader","adapterVersion":1,
                    "decodeOptions":self.asset_decode_options(asset),"modelFacts":model.facts()});
                if model.texture_upload_bytes() > 0 {
                    value["textureUploadBytes"] = json!(model.texture_upload_bytes());
                    value["textureUrls"] = json!(model.texture_urls());
                }
                value
            }
        }).collect();
        let mut identities = BTreeMap::new();
        let mut grouped: BTreeMap<String, Vec<(String, ResolvedAssetIdentity)>> = BTreeMap::new();
        for (id, asset) in &self.assets {
            let dependency_keys = match asset {
                CompositionAsset::Media(media) => {
                    let mut keys =
                        BTreeMap::from([("adapter".into(), digest(&Self::adapter(media))?)]);
                    if let Some(svg) = media.svg() {
                        keys.insert("svgAdapterVersion".into(), digest(&svg.pipeline)?);
                        keys.insert("svgFonts".into(), digest(&svg.fonts)?);
                        keys.insert("sourceHash".into(), svg.input_hash.clone());
                    }
                    keys
                }
                CompositionAsset::Font(font) => BTreeMap::from([
                    ("adapter".into(), digest(&font.adapter_id())?),
                    (
                        "fontAdapterVersion".into(),
                        digest(&font.adapter_version())?,
                    ),
                ]),
                CompositionAsset::Model(_) => BTreeMap::from([
                    ("adapter".into(), digest(&"three-gltf-loader")?),
                    ("modelProfile".into(), digest(&"static-core-pbr-v1")?),
                ]),
            };
            grouped
                .entry(asset.reference().asset_id.clone())
                .or_default()
                .push((
                    id.clone(),
                    ResolvedAssetIdentity {
                        content_key: asset.content_key().into(),
                        decode_options_hash: digest(&self.asset_decode_options(asset))?,
                        adapter_version: 1,
                        dependency_keys,
                    },
                ));
        }
        for (id, representations) in grouped {
            let identity = if representations.len() == 1 {
                representations
                    .into_iter()
                    .next()
                    .expect("one representation")
                    .1
            } else {
                let hash = digest(&representations)?;
                ResolvedAssetIdentity {
                    content_key: hash.clone(),
                    decode_options_hash: hash.clone(),
                    adapter_version: 1,
                    dependency_keys: BTreeMap::from([("representations".into(), hash)]),
                }
            };
            identities.insert(id, identity);
        }
        let identity = TargetIdentity {
            public_values: self.final_values.clone(),
            resolved_assets: identities,
            // Preserve the existing media-only cache identity. Text extends the
            // same target owner with the parser, raster and wrapping versions.
            capability_digest: if let Some(plan) = &self.builtin_target {
                digest(&(
                    "p2-02-image-video-group-particles-v1",
                    plan.identity_digest()?,
                    super::font_prepare::ADAPTER_VERSION,
                    text_raster::ADAPTER_ID,
                    text_raster::ADAPTER_VERSION,
                    text_raster::WRAP_VERSION,
                ))?
            } else if self.assets.values().any(|asset| asset.as_font().is_some()) {
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
        let projection = json!({"semanticKey":self.compiled.ir().semantic_key(),"targetKey":target_key,"ir":self.compiled.ir(),"builtinTarget":self.builtin_target,
            "finalPublicValues":self.final_values,"canvas":self.compiled.document().canvas,"timeline":self.compiled.document().timeline,
            "resolvedAssets":resolved_assets,"resolvedUses":self.final_values.resource_uses().iter().map(|usage|if self.assets.contains_key(&usage.asset_id){usage.asset_id.clone()}else{svg_use_id(usage)}).collect::<Vec<_>>(),"textRasters":self.text_rasters.text_rasters(),"target":{"width":self.target.width,"height":self.target.height,"fit":self.output_fit,
                "budgetFps":identity.effective_budget_fps,"budgetAllocationRevision":allocation_revision},"sessionId":session_id,"generation":generation,
            "pageLimits":{"gpuContexts":1,"drawingBufferPixels":checked_sum(&[pixels,self.text_rasters.raster_pixels()])?,
                "renderTargetDeclaredBytes":checked_sum(&[checked_product(pixels,16 + cost.depth_bytes_per_pixel)?,cost.effect_surface_bytes])?,"textureDeclaredBytes":checked_sum(&[cost.texture_bytes,cost.raster_bytes])?,
                "bufferDeclaredBytes":cost.buffer_bytes,"ownedCpuBytes":checked_sum(&[cost.private_cpu_bytes,cost.input_bytes,cost.font_cpu_bytes,cost.raster_bytes])?,"decodeReservedBytes":cost.decode_bytes,
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
