// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 原生媒体目标规划；文件/缓存仍由 AssetStore 和 image_prepare 持有。
//! resolve 在宿主后台查询，不隐式转换；会话按固定目标准入后才授予精确文件权限。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::assets::{AssetStore, DecodeInput, StagedPackage};
use super::budget::{BudgetRequest, OwnerKind, ResourceAmounts, ResourcePlan, SessionPlan};
use super::image_prepare::{self, ImagePurpose, ImageTarget};
use super::jobs::JobError;
use super::library::Library;
use super::media::{Container, MediaProbe};

type Result<T> = std::result::Result<T, JobError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AssetRef {
    pub package_hash: String,
    pub asset_id: String,
    pub variant_id: Option<String>,
}

impl AssetRef {
    pub(crate) fn validate(&self) -> Result<()> {
        if !hertz_wallpaper::valid_sha256_hex(&self.package_hash)
            || !hertz_wallpaper::valid_local_id(&self.asset_id)
            || self
                .variant_id
                .as_ref()
                .is_some_and(|id| !hertz_wallpaper::valid_local_id(id))
        {
            return Err(JobError::invalid_input("AssetRef 必须是包哈希和局部 id"));
        }
        Ok(())
    }
}

/// 缺少派生时交给 ImportJobs 的同一单槽 worker；不携带原始文件路径。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PrepareRequest {
    pub reference: AssetRef,
    pub target: ImageTarget,
}

pub(crate) enum Resolution {
    Ready(ResolvedMedia),
    PrepareRequired(PrepareRequest),
}

/// 解析后目标与字节事实不可修改；准入和页面描述使用同一份目标。
#[derive(Clone)]
pub(crate) struct ResolvedMedia {
    reference: AssetRef,
    content_key: String,
    url: String,
    input: Box<DecodeInput>,
    target: ImageTarget,
    poster: Option<Box<ResolvedMedia>>,
}

impl ResolvedMedia {
    pub(super) fn from_input(
        reference: AssetRef,
        input: DecodeInput,
        content_key: String,
        target: ImageTarget,
    ) -> Result<Self> {
        reference.validate()?;
        let target = image_prepare::normalize_target(target)?;
        let url = super::webresource::files_url(&reference.package_hash, &input.media.entry.path)
            .ok_or_else(|| JobError::invalid_input("媒体 URL 不能由已核验路径生成"))?;
        Ok(Self {
            reference,
            content_key,
            url,
            input: Box::new(input),
            target,
            poster: None,
        })
    }

    pub(crate) fn poster(&self) -> Option<&ResolvedMedia> {
        self.poster.as_deref()
    }

    pub(crate) fn retarget_static_image(mut self, target: ImageTarget) -> Result<Self> {
        if self.input.metadata.container != Container::Image {
            return Err(JobError::invalid_input("视频目标变化必须重新规划"));
        }
        self.target = image_prepare::normalize_target(target)?;
        Ok(self)
    }

    pub(crate) fn reference(&self) -> &AssetRef {
        &self.reference
    }

    pub(crate) fn content_key(&self) -> &str {
        &self.content_key
    }

    pub(crate) fn url(&self) -> &str {
        &self.url
    }

    pub(crate) fn input(&self) -> &DecodeInput {
        &self.input
    }

    pub(crate) fn target(&self) -> ImageTarget {
        self.target
    }

    /// 只按 resolve 固定的规范化目标记账；改尺寸/用途必须重新规划。
    /// 多目标和交接时旧 token 保持占用，不能用新计划覆盖旧账。
    pub(crate) fn budget_request(&self, session: String, generation: u64) -> Result<BudgetRequest> {
        presentation_request(&self.input.metadata, self.target, session, generation)
    }

    /// Both consumers draw from one fixed target plan. Decoder/CPU and presentation
    /// allocations do not each reserve another global target, preview or copy of the bytes.
    pub(crate) fn budget_plan(&self, session: String, generation: u64) -> Result<SessionPlan> {
        let request = self.budget_request(session, generation)?;
        let decoded = ResourceAmounts {
            decoders: u64::from(request.decoders),
            decode_pixel_rate: request.decode_pixel_rate,
            cpu_bytes: request.cpu_bytes,
            ..Default::default()
        };
        let presented = ResourceAmounts {
            gpu_bytes: request.gpu_bytes,
            output_pixel_rate: request.output_pixel_rate,
            ..Default::default()
        };
        SessionPlan::new(
            request,
            vec![
                ResourcePlan {
                    id: "decoded-media".into(),
                    maximum: decoded,
                },
                ResourcePlan {
                    id: "media-presentation".into(),
                    maximum: presented,
                },
            ],
        )
    }
}

struct Candidate<'a> {
    variant_id: Option<&'a str>,
    path: &'a str,
    bytes: u64,
    metadata: &'a MediaProbe,
}

fn mime(metadata: &MediaProbe) -> &'static str {
    match metadata.container {
        // 图片统一通过 SDR sRGB PNG 准备器；原图 MIME 不决定最终呈现格式。
        Container::Image => "image/png",
        Container::Webm => "video/webm",
        Container::Mp4 => "video/mp4",
    }
}

fn choose(
    candidates: &[Candidate<'_>],
    explicit: Option<&str>,
    target: ImageTarget,
    supported: &[String],
) -> Result<usize> {
    let source = candidates
        .first()
        .ok_or_else(|| JobError::new("asset_not_found", "资源没有已核验候选"))?;
    let required = image_prepare::target_dimensions(
        source.metadata.display_width,
        source.metadata.display_height,
        target,
    )?;
    let allowed = |candidate: &Candidate<'_>| {
        supported
            .iter()
            .any(|format| format == mime(candidate.metadata))
    };
    if let Some(id) = explicit {
        let index = candidates
            .iter()
            .position(|candidate| candidate.variant_id == Some(id))
            .ok_or_else(|| JobError::new("asset_not_found", "指定变体不存在"))?;
        if !allowed(&candidates[index]) {
            return Err(JobError::new(
                "format_unsupported",
                "指定变体格式不受目标支持",
            ));
        }
        return Ok(index);
    }
    let order = |candidate: &Candidate<'_>| {
        (
            u64::from(candidate.metadata.encoded_width)
                * u64::from(candidate.metadata.encoded_height),
            candidate.bytes,
        )
    };
    let suitable = |candidate: &Candidate<'_>| {
        candidate.metadata.display_width >= required.0
            && candidate.metadata.display_height >= required.1
    };
    candidates
        .iter()
        .enumerate()
        .filter(|(_, candidate)| allowed(candidate) && suitable(candidate))
        .min_by(|(_, a), (_, b)| order(a).cmp(&order(b)).then_with(|| a.path.cmp(b.path)))
        .map(|(index, _)| index)
        .ok_or_else(|| JobError::new("format_unsupported", "没有满足目标尺寸和格式的已核验候选"))
}

fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        return Err(JobError::new("cancelled", "目标规划已取消"));
    }
    Ok(())
}

/// 选择只接受原包声明与原生容器探测结果；作者填写的 variant 宽高/用途不作为真值。
pub(crate) fn select_input(
    package: &StagedPackage,
    inputs: &[DecodeInput],
    reference: &AssetRef,
    target: ImageTarget,
    supported: &[String],
) -> Result<(AssetRef, DecodeInput)> {
    reference.validate()?;
    if reference.package_hash != package.package_hash {
        return Err(JobError::new("hash_mismatch", "资源引用与固定包不符"));
    }
    let asset = package
        .manifest
        .assets
        .iter()
        .find(|asset| asset.id == reference.asset_id)
        .ok_or_else(|| JobError::new("asset_not_found", "包内资源不存在"))?;
    if !matches!(
        asset.kind,
        hertz_wallpaper::AssetKind::Image | hertz_wallpaper::AssetKind::Video
    ) {
        return Err(JobError::new(
            "format_unsupported",
            "当前规划器只接受图片和视频",
        ));
    }
    let mut candidates = Vec::new();
    let mut fixed = Vec::new();
    for (variant_id, path) in std::iter::once((None, asset.source.as_str())).chain(
        asset
            .variants
            .iter()
            .map(|variant| (Some(variant.id.as_str()), variant.file.as_str())),
    ) {
        let input = inputs
            .iter()
            .find(|input| {
                input.package_hash == reference.package_hash && input.media.entry.path == path
            })
            .ok_or_else(|| JobError::new("asset_not_found", "资源缺少原生探测事实"))?;
        candidates.push(Candidate {
            variant_id,
            path,
            bytes: input.media.entry.bytes,
            metadata: &input.metadata,
        });
        fixed.push(input);
    }
    let index = choose(
        &candidates,
        reference.variant_id.as_deref(),
        target,
        supported,
    )?;
    let input = fixed[index];
    Ok((
        AssetRef {
            variant_id: candidates[index].variant_id.map(str::to_string),
            ..reference.clone()
        },
        DecodeInput {
            package_hash: input.package_hash.clone(),
            metadata: input.metadata.clone(),
            media: Arc::clone(&input.media),
        },
    ))
}

/// 后台 resolve：缺少变体明确返回 PrepareRequired，不在 loader/帧路径中转换。
pub(crate) async fn resolve(
    store: &AssetStore,
    library: &Library,
    reference: &AssetRef,
    target: ImageTarget,
    supported: &[String],
    cancel: &AtomicBool,
) -> Result<Resolution> {
    reference.validate()?;
    let target = image_prepare::normalize_target(target)?;
    cancelled(cancel)?;
    if !library.is_installed(&reference.package_hash).await? {
        return Err(JobError::new("asset_not_found", "作品尚未安装或不可用"));
    }
    let package = store.read_installed_manifest(&reference.package_hash)?;
    let inputs = store.probe_installed_media(&package, cancel)?;
    let (reference, source) = select_input(&package, &inputs, reference, target, supported)?;
    let (input, content_key) = if source.metadata.container == Container::Image {
        let Some(prepared) =
            image_prepare::cached(store, library, &source, Some(target), cancel).await?
        else {
            return Ok(Resolution::PrepareRequired(PrepareRequest {
                reference,
                target,
            }));
        };
        (
            prepared.decode_input(store, &source)?,
            prepared.content_key(),
        )
    } else {
        let key = source.media.entry.sha256.clone();
        (source, key)
    };
    cancelled(cancel)?;
    let poster = if input.metadata.container != Container::Image {
        super::video_poster::resolve_for_media(store, library, &reference, &input, target)
            .await
            .unwrap_or_else(|error| {
                crate::app::log(&format!("optional presentation poster skipped: {error}"));
                None
            })
    } else {
        None
    };
    cancelled(cancel)?;
    let mut media = ResolvedMedia::from_input(reference, input, content_key, target)?;
    media.poster = poster.map(Box::new);
    Ok(Resolution::Ready(media))
}

fn presentation_request(
    metadata: &MediaProbe,
    target: ImageTarget,
    session: String,
    generation: u64,
) -> Result<BudgetRequest> {
    if session.is_empty() || session.len() > 128 || generation == 0 {
        return Err(JobError::invalid_input("呈现必须绑定有效会话和代际"));
    }
    let target = image_prepare::normalize_target(target)?;
    let mut request = super::decode_probe::decode_request(metadata, session)?;
    request.owner = if matches!(target.purpose, ImagePurpose::Preview) {
        OwnerKind::Preview
    } else {
        OwnerKind::Desktop
    };
    request.generation = generation;
    request.task_id = "presentation".into();
    request.targets = u32::from(request.owner == OwnerKind::Desktop);
    // 静态图片没有连续帧循环；视频不能按预览 GL 的 15 fps 少记。
    if metadata.container != Container::Image {
        let fps = metadata
            .fps_upper_bound
            .or(metadata.source_fps)
            .filter(|fps| fps.is_finite() && *fps > 0.0)
            .ok_or_else(|| JobError::new("format_unsupported", "视频缺少可信帧率上界"))?;
        let rate = (f64::from(target.width) * f64::from(target.height) * fps).ceil();
        if !rate.is_finite() || rate >= u64::MAX as f64 {
            return Err(JobError::new("budget_exceeded", "输出像素率溢出"));
        }
        request.output_pixel_rate = rate as u64;
    }
    Ok(request)
}

#[cfg(test)]
#[path = "target_planner_tests.rs"]
mod tests;
