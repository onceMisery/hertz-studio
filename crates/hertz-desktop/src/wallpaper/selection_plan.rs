// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Resolve a persisted work/version through the existing installed bytes and preparation owner.
//! This runs on the management runtime; all hashing/decoding stays on its blocking workers.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use super::image_prepare::ImageTarget;
use super::jobs::{ImportJobs, JobError, JobState};
use super::target_planner::{self, AssetRef, Resolution, ResolvedMedia};

type Result<T> = std::result::Result<T, JobError>;

pub(crate) enum ResolvedSelection {
    Builtin(super::config::BuiltinState),
    Media(ResolvedMedia),
    Composition(super::composition_plan::PreparedComposition),
}
pub(crate) struct ResolvedPlan {
    pub content: ResolvedSelection,
    pub reference: super::playlist::FixedVersion,
    pub playlist: Option<super::playlist::Playlist>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct SelectionOptions {
    pub mirror_members: Option<usize>,
    pub resume: Option<PlaylistResume>,
    pub properties: serde_json::Map<String, serde_json::Value>,
    /// Exact composition canvas fit; ImageTarget keeps the original media
    /// preparation contract, which deliberately has no Stretch variant.
    pub composition_fit: Option<super::config::Fit>,
}

#[derive(Clone, Debug)]
pub(crate) struct PlaylistResume {
    pub revision: u64,
    pub reference: super::playlist::FixedVersion,
}

pub(crate) async fn resolve_selection(
    jobs: Arc<ImportJobs>,
    selection: super::config::Selection,
    target: ImageTarget,
    cancel: Arc<AtomicBool>,
) -> std::result::Result<ResolvedPlan, Failure> {
    resolve_selection_with_options(jobs, selection, target, SelectionOptions::default(), cancel)
        .await
}

pub(crate) async fn resolve_selection_with_layout(
    jobs: Arc<ImportJobs>,
    selection: super::config::Selection,
    target: ImageTarget,
    mirror_members: Option<usize>,
    cancel: Arc<AtomicBool>,
) -> std::result::Result<ResolvedPlan, Failure> {
    resolve_selection_with_options(
        jobs,
        selection,
        target,
        SelectionOptions {
            mirror_members,
            resume: None,
            properties: Default::default(),
            composition_fit: None,
        },
        cancel,
    )
    .await
}

pub(crate) async fn resolve_selection_with_options(
    jobs: Arc<ImportJobs>,
    selection: super::config::Selection,
    target: ImageTarget,
    options: SelectionOptions,
    cancel: Arc<AtomicBool>,
) -> std::result::Result<ResolvedPlan, Failure> {
    cancelled(&cancel)?;
    if let Some(members) = options.mirror_members {
        validate_members(members)?;
    }
    let (mut reference, playlist) = fixed_selection(&jobs, selection).await?;
    cancelled(&cancel)?;
    if let Some(resume) = options.resume {
        let playlist = playlist
            .as_ref()
            .ok_or_else(|| JobError::invalid_input("续播位置需要完整的轮播列表选择"))?;
        if playlist.revision == resume.revision {
            if !playlist.items.contains(&resume.reference) {
                return Err(JobError::new(
                    "playlist_conflict",
                    "续播版本不在当前轮播列表中，请重新读取列表",
                )
                .into());
            }
            reference = resume.reference;
        }
    }
    let request = Request {
        work_key: reference.work_key.clone(),
        package_hash: reference.package_hash.clone(),
        target,
        properties: options.properties,
    };
    if let Some(members) = options.mirror_members {
        // The validated list is the exact snapshot returned to the playback runner.
        // A later builtin/video must be rejected before preparing even the first image.
        let references = playlist
            .as_ref()
            .map_or_else(|| vec![reference.clone()], |list| list.items.clone());
        let source = Arc::clone(&jobs);
        let inspection_cancel = Arc::clone(&cancel);
        let runtime = tokio::runtime::Handle::current();
        let inspection = tokio::task::spawn_blocking(move || {
            runtime.block_on(inspect_references(
                &source,
                &references,
                members,
                &inspection_cancel,
            ))
        })
        .await
        .map_err(|_| JobError::new("worker_unavailable", "镜像资格检查线程已退出"))?;
        cancelled(&cancel)?;
        let inspection = match inspection {
            Ok(inspection) => inspection,
            Err(error) => return Err(recorded_failure(jobs, request, cancel, error).await),
        };
        if !inspection.mirror_eligible {
            return Err(JobError::new(
                "unsupported_layout",
                inspection.reason.unwrap_or("当前内容不支持镜像"),
            )
            .into());
        }
    }
    if let Some(list) = playlist.as_ref().filter(|_| !request.properties.is_empty()) {
        let references = list.items.clone();
        let source = Arc::clone(&jobs);
        let properties = request.properties.clone();
        let inspection_cancel = Arc::clone(&cancel);
        let runtime = tokio::runtime::Handle::current();
        let checked = tokio::task::spawn_blocking(move || {
            runtime.block_on(super::public_properties::validate_references(
                &source,
                &references,
                &properties,
                &inspection_cancel,
            ))
        })
        .await
        .map_err(|_| JobError::new("worker_unavailable", "公开属性核验线程已退出"))?;
        if let Err(error) = checked {
            return Err(recorded_failure(jobs, request, cancel, error).await);
        }
    }
    let content = resolve_with_fit(jobs, request, options.composition_fit, cancel).await?;
    Ok(ResolvedPlan {
        content,
        reference,
        playlist,
    })
}

async fn fixed_selection(
    jobs: &ImportJobs,
    selection: super::config::Selection,
) -> Result<(
    super::playlist::FixedVersion,
    Option<super::playlist::Playlist>,
)> {
    let result = match selection {
        super::config::Selection::Package {
            work_key,
            package_hash,
        } => (
            super::playlist::FixedVersion {
                work_key,
                package_hash,
            },
            None,
        ),
        super::config::Selection::Playlist { playlist_id } => {
            if !super::api::valid_selection_id(&playlist_id) {
                return Err(JobError::invalid_input("轮播列表身份无效"));
            }
            let playlist = super::playlist::Repository::new(jobs.library())
                .get(&playlist_id)
                .await?;
            (playlist.items[0].clone(), Some(playlist))
        }
        _ => return Err(JobError::invalid_input("需要作品版本或轮播列表")),
    };
    validate_reference(&result.0)?;
    Ok(result)
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LayoutInspection {
    layouts: Vec<&'static str>,
    mirror_eligible: bool,
    max_members: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    #[cfg(test)]
    #[serde(skip)]
    verified_versions: usize,
}

impl LayoutInspection {
    fn new(integrated: bool, video: bool, members: usize) -> Self {
        let max_members = if video { 2 } else { 4 };
        let reason = if integrated {
            Some("内置场景使用集成渲染，仅支持单屏或横跨")
        } else if members > max_members {
            Some("视频镜像最多支持 2 个显示器")
        } else {
            None
        };
        let mirror_eligible = reason.is_none();
        let mut layouts = vec!["single", "span"];
        if mirror_eligible {
            layouts.push("mirror");
        }
        Self {
            layouts,
            mirror_eligible,
            max_members,
            reason,
            #[cfg(test)]
            verified_versions: 0,
        }
    }
}

#[derive(Clone, Debug, serde::Serialize)]
pub(crate) struct LayoutSnapshot {
    selection: super::config::Selection,
    members: usize,
    playlist_revision: Option<u64>,
    references: Vec<super::playlist::FixedVersion>,
}

impl LayoutSnapshot {
    pub(crate) fn cache_key(&self) -> String {
        serde_json::to_string(self).expect("bounded layout snapshot")
    }
}

fn validate_members(members: usize) -> Result<()> {
    if !(1..=4).contains(&members) {
        return Err(JobError::invalid_input("布局检查需要 1–4 个显示器"));
    }
    Ok(())
}

fn validate_reference(reference: &super::playlist::FixedVersion) -> Result<()> {
    if !super::api::valid_selection_id(&reference.work_key)
        || !hertz_wallpaper::valid_sha256_hex(&reference.package_hash)
    {
        return Err(JobError::invalid_input(
            "作品选择需要有效 workKey 和固定 packageHash",
        ));
    }
    Ok(())
}

/// Read-only inspection; the caller must run this on a blocking worker because installed
/// integrity checks hash real files. No prepared resource, decode probe, or job is created.
pub(crate) async fn inspect_layout(
    jobs: &ImportJobs,
    selection: super::config::Selection,
    members: usize,
    cancel: &AtomicBool,
) -> Result<LayoutInspection> {
    cancelled(cancel)?;
    let snapshot = layout_snapshot(jobs, selection, members).await?;
    inspect_layout_snapshot(jobs, snapshot, cancel).await
}

/// Loading the bounded SQL snapshot is cheap enough for each poll; package bytes are
/// verified only by the one owning inspection task, against this exact playlist revision.
pub(crate) async fn layout_snapshot(
    jobs: &ImportJobs,
    selection: super::config::Selection,
    members: usize,
) -> Result<LayoutSnapshot> {
    validate_members(members)?;
    let (playlist_revision, references) = match &selection {
        super::config::Selection::Builtin {
            scene_id,
            state_version,
            params,
        } => {
            super::config::normalize_builtin(scene_id, *state_version, &mut params.clone())
                .map_err(|error| JobError::invalid_input(error.to_string()))?;
            (None, vec![])
        }
        super::config::Selection::FollowHertz { idle_builtin } => {
            super::config::normalize_builtin(
                &idle_builtin.scene_id,
                idle_builtin.state_version,
                &mut idle_builtin.params.clone(),
            )
            .map_err(|error| JobError::invalid_input(error.to_string()))?;
            (None, vec![])
        }
        selection => {
            let (reference, playlist) = fixed_selection(jobs, selection.clone()).await?;
            match playlist {
                Some(list) => (Some(list.revision), list.items),
                None => (None, vec![reference]),
            }
        }
    };
    Ok(LayoutSnapshot {
        selection,
        members,
        playlist_revision,
        references,
    })
}

pub(crate) async fn inspect_layout_snapshot(
    jobs: &ImportJobs,
    snapshot: LayoutSnapshot,
    cancel: &AtomicBool,
) -> Result<LayoutInspection> {
    cancelled(cancel)?;
    if snapshot.references.is_empty() {
        Ok(LayoutInspection::new(true, false, snapshot.members))
    } else {
        inspect_references(jobs, &snapshot.references, snapshot.members, cancel).await
    }
}

/// Native Apply preflight covers persisted mirror intent even when no display target is
/// currently online. Unlike UI polling, this never consumes a cached eligibility result.
pub(crate) async fn validate_mirror_layouts(
    jobs: &ImportJobs,
    selections: Vec<(super::config::Selection, usize)>,
    cancel: &AtomicBool,
) -> Result<()> {
    cancelled(cancel)?;
    if selections.is_empty() || selections.len() > 4 {
        return Err(JobError::invalid_input("镜像布局核验需要 1–4 个有效显示组"));
    }
    for (selection, members) in selections {
        let inspection = inspect_layout(jobs, selection, members, cancel).await?;
        cancelled(cancel)?;
        if !inspection.mirror_eligible {
            return Err(JobError::new(
                "unsupported_layout",
                inspection.reason.unwrap_or("当前内容不支持镜像"),
            ));
        }
    }
    cancelled(cancel)
}

async fn inspect_references(
    jobs: &ImportJobs,
    references: &[super::playlist::FixedVersion],
    members: usize,
    cancel: &AtomicBool,
) -> Result<LayoutInspection> {
    validate_members(members)?;
    if references.is_empty() || references.len() > 32 {
        return Err(JobError::invalid_input("布局检查需要 1–32 个固定版本"));
    }
    let mut integrated = false;
    let mut video = false;
    let mut verified = std::collections::HashSet::new();
    #[cfg(test)]
    let mut verified_versions = 0;
    for reference in references {
        cancelled(cancel)?;
        validate_reference(reference)?;
        if !verified.insert((&reference.work_key, &reference.package_hash)) {
            continue;
        }
        if !jobs
            .library()
            .contains_version(&reference.work_key, &reference.package_hash)
            .await?
        {
            // Like resolve_media, allow an explicit retry after recorded bytes were restored.
            // This is only membership; the cached manifest never grants layout eligibility.
            jobs.library()
                .cover_manifest(&reference.work_key, &reference.package_hash)
                .await?;
        }
        cancelled(cancel)?;
        // Keep the original immutable while verifying and reading its authoritative manifest.
        let _original = jobs
            .assets()
            .open_installed_original(&reference.package_hash)
            .map_err(|_| JobError::new("asset_unavailable", "已保存作品的原包缺失或不可读"))?;
        #[cfg(test)]
        {
            verified_versions += 1;
        }
        if jobs
            .assets()
            .verify_installed(&reference.package_hash)?
            .is_none()
        {
            return Err(JobError::new(
                "asset_unavailable",
                "已保存作品的原包或投影缺失、损坏",
            ));
        }
        cancelled(cancel)?;
        let package = jobs
            .assets()
            .read_installed_manifest(&reference.package_hash)?;
        cancelled(cancel)?;
        match package.manifest.content {
            hertz_wallpaper::Content::Image { asset } => {
                check_content_asset(
                    &package.manifest.assets,
                    &asset,
                    hertz_wallpaper::AssetKind::Image,
                )?;
            }
            hertz_wallpaper::Content::Video { asset } => {
                check_content_asset(
                    &package.manifest.assets,
                    &asset,
                    hertz_wallpaper::AssetKind::Video,
                )?;
                video = true;
            }
            hertz_wallpaper::Content::Builtin { .. } => integrated = true,
            _ => {
                return Err(JobError::new(
                    "unsupported_content",
                    "布局检查仅支持内置场景、图片或视频作品",
                ))
            }
        }
    }
    cancelled(cancel)?;
    let inspection = LayoutInspection::new(integrated, video, members);
    #[cfg(test)]
    let inspection = LayoutInspection {
        verified_versions,
        ..inspection
    };
    Ok(inspection)
}

fn check_content_asset(
    assets: &[hertz_wallpaper::manifest::AssetDescriptor],
    asset_id: &str,
    expected_kind: hertz_wallpaper::AssetKind,
) -> Result<()> {
    if !assets
        .iter()
        .any(|asset| asset.id == asset_id && asset.kind == expected_kind)
    {
        return Err(JobError::new(
            "unsupported_content",
            "作品内容类型与实际资源类型不一致，无法启用镜像",
        ));
    }
    Ok(())
}

pub(crate) struct Failure {
    pub error: JobError,
    pub poster: Option<Box<ResolvedMedia>>,
}

impl From<JobError> for Failure {
    fn from(error: JobError) -> Self {
        Self {
            error,
            poster: None,
        }
    }
}

impl std::fmt::Debug for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SelectionFailure")
            .field("error", &self.error)
            .field("has_poster", &self.poster.is_some())
            .finish()
    }
}

#[derive(Clone)]
pub(crate) struct Request {
    pub work_key: String,
    pub package_hash: String,
    pub target: ImageTarget,
    pub properties: serde_json::Map<String, serde_json::Value>,
}

impl Request {
    pub(crate) fn validate(&self) -> Result<()> {
        if !super::api::valid_id(&self.work_key)
            || !hertz_wallpaper::valid_sha256_hex(&self.package_hash)
        {
            return Err(JobError::invalid_input(
                "作品选择需要有效 workKey 和固定 packageHash",
            ));
        }
        super::image_prepare::validate_target(Some(self.target))
    }
}

fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        Err(JobError::new("cancelled", "媒体选择已取消"))
    } else {
        Ok(())
    }
}

async fn resolve_target(
    jobs: Arc<ImportJobs>,
    reference: AssetRef,
    target: ImageTarget,
    cancel: Arc<AtomicBool>,
) -> Result<Resolution> {
    let runtime = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        runtime.block_on(target_planner::resolve(
            jobs.assets(),
            jobs.library(),
            &reference,
            target,
            &["image/png".into(), "video/mp4".into(), "video/webm".into()],
            &cancel,
        ))
    })
    .await
    .map_err(|_| JobError::new("worker_unavailable", "媒体目标解析线程已退出"))?
}

pub(crate) async fn resolve(
    jobs: Arc<ImportJobs>,
    request: Request,
    cancel: Arc<AtomicBool>,
) -> std::result::Result<ResolvedSelection, Failure> {
    resolve_with_fit(jobs, request, None, cancel).await
}

async fn resolve_with_fit(
    jobs: Arc<ImportJobs>,
    request: Request,
    composition_fit: Option<super::config::Fit>,
    cancel: Arc<AtomicBool>,
) -> std::result::Result<ResolvedSelection, Failure> {
    request.validate()?;
    match resolve_media(
        Arc::clone(&jobs),
        request.clone(),
        composition_fit,
        Arc::clone(&cancel),
    )
    .await
    {
        Ok(media) => Ok(media),
        Err(error) if error.code == "cancelled" || cancel.load(Ordering::Acquire) => {
            Err(JobError::new("cancelled", "媒体选择已取消并退出").into())
        }
        Err(error) => Err(recorded_failure(jobs, request, cancel, error).await),
    }
}

async fn recorded_failure(
    jobs: Arc<ImportJobs>,
    request: Request,
    cancel: Arc<AtomicBool>,
    error: JobError,
) -> Failure {
    if error.code == "cancelled" || cancel.load(Ordering::Acquire) {
        return JobError::new("cancelled", "媒体选择已取消并退出").into();
    }
    let runtime = tokio::runtime::Handle::current();
    let poster = tokio::task::spawn_blocking(move || {
        runtime.block_on(super::video_poster::resolve_recorded(
            jobs.assets(),
            jobs.library(),
            &request,
        ))
    })
    .await;
    if cancel.load(Ordering::Acquire) {
        return JobError::new("cancelled", "媒体选择已取消并退出").into();
    }
    Failure {
        error,
        poster: poster
            .ok()
            .and_then(std::result::Result::ok)
            .flatten()
            .map(Box::new),
    }
}

async fn resolve_media(
    jobs: Arc<ImportJobs>,
    request: Request,
    composition_fit: Option<super::config::Fit>,
    cancel: Arc<AtomicBool>,
) -> Result<ResolvedSelection> {
    request.validate()?;
    cancelled(&cancel)?;
    if !jobs
        .library()
        .contains_version(&request.work_key, &request.package_hash)
        .await?
    {
        // An explicit retry can recover restored bytes of an unavailable recorded version.
        // This metadata check does not grant playback; immutable bytes are reverified below.
        jobs.library()
            .cover_manifest(&request.work_key, &request.package_hash)
            .await?;
    }
    // Read the authoritative installed manifest, never infer a resource from UI summaries/URLs.
    let source = Arc::clone(&jobs);
    let hash = request.package_hash.clone();
    let properties = request.properties.clone();
    let source_cancel = Arc::clone(&cancel);
    enum Source {
        Ready(ResolvedSelection),
        Media(AssetRef),
    }
    let runtime = tokio::runtime::Handle::current();
    let target = request.target;
    let reference = tokio::task::spawn_blocking(move || {
        cancelled(&source_cancel)?;
        if source.assets().verify_installed(&hash)?.is_none() {
            return Err(JobError::new(
                "asset_unavailable",
                "已保存作品的原包或投影缺失、损坏",
            ));
        }
        let package = source.assets().read_installed_manifest(&hash)?;
        cancelled(&source_cancel)?;
        if matches!(
            package.manifest.content,
            hertz_wallpaper::Content::Composition { .. }
        ) {
            return runtime
                .block_on(super::composition_plan::resolve(
                    Arc::clone(&source),
                    hash,
                    properties,
                    target,
                    composition_fit.unwrap_or(match target.fit {
                        super::image_prepare::ImageFit::Contain => super::config::Fit::Contain,
                        super::image_prepare::ImageFit::Cover => super::config::Fit::Cover,
                    }),
                    source_cancel,
                ))
                .map(|plan| Source::Ready(ResolvedSelection::Composition(plan)));
        }
        let effective =
            hertz_wallpaper::properties::effective_content(&package.manifest, &properties)
                .map_err(super::public_properties::property_error)?;
        let asset_id = match effective {
            hertz_wallpaper::Content::Builtin {
                scene_id,
                state_version,
                mut params,
            } => {
                super::config::normalize_builtin(&scene_id, state_version, &mut params)
                    .map_err(|error| JobError::invalid_input(error.to_string()))?;
                return Ok(Source::Ready(ResolvedSelection::Builtin(
                    super::config::BuiltinState {
                        scene_id,
                        state_version,
                        params,
                    },
                )));
            }
            hertz_wallpaper::Content::Image { asset }
            | hertz_wallpaper::Content::Video { asset } => asset,
            _ => {
                return Err(JobError::new(
                    "unsupported_content",
                    "当前呈现入口尚未准备此内容 adapter",
                ))
            }
        };
        Ok(Source::Media(AssetRef {
            package_hash: hash,
            asset_id,
            variant_id: None,
        }))
    })
    .await
    .map_err(|_| JobError::new("worker_unavailable", "媒体选择线程已退出"))?;
    let reference = match reference {
        Ok(Source::Ready(content)) => {
            cancelled(&cancel)?;
            jobs.library().mark_available(&request.package_hash).await?;
            return Ok(content);
        }
        Ok(Source::Media(reference)) => reference,
        Err(error) => {
            if matches!(
                error.code,
                "asset_unavailable" | "package_invalid" | "hash_mismatch" | "io"
            ) {
                jobs.library()
                    .mark_unavailable(&request.package_hash)
                    .await?;
            }
            return Err(error);
        }
    };
    let media = prepare_target(
        Arc::clone(&jobs),
        reference,
        request.target,
        Arc::clone(&cancel),
    )
    .await?;
    jobs.library().mark_available(&request.package_hash).await?;
    Ok(ResolvedSelection::Media(media))
}

/// The original single-slot media qualification pipeline, also used by fixed
/// composition slots. Never creates another preparation worker.
pub(crate) async fn prepare_target(
    jobs: Arc<ImportJobs>,
    reference: AssetRef,
    target: ImageTarget,
    cancel: Arc<AtomicBool>,
) -> Result<ResolvedMedia> {
    let preparation = match resolve_target(
        Arc::clone(&jobs),
        reference.clone(),
        target,
        Arc::clone(&cancel),
    )
    .await?
    {
        Resolution::Ready(media) => super::target_planner::PrepareRequest {
            reference: media.reference().clone(),
            target: media.target(),
        },
        Resolution::PrepareRequired(prepare) => prepare,
    };
    // Installed bytes are not a permanent promise about the current decoder environment.
    // Qualification (including cache hits) runs under the same single preparation owner.
    {
        let prepare = preparation;
        cancelled(&cancel)?;
        let job_id = jobs.prepare_asset(super::jobs::new_job_id(), prepare)?;
        // Cancellation observes the worker's real terminal state. A timeout/drop is not a
        // decoder/controller exit receipt and must not make the slot available early.
        loop {
            let is_cancelled = cancel.load(Ordering::Acquire);
            if is_cancelled {
                jobs.cancel(&job_id);
            }
            let status = jobs
                .status(&job_id)
                .ok_or_else(|| JobError::new("job_not_found", "媒体准备任务记录不可用"))?;
            match status.state {
                JobState::Done => {
                    cancelled(&cancel)?;
                    break;
                }
                JobState::Failed => {
                    return Err(JobError::new(
                        "prepare_failed",
                        status.error.unwrap_or_else(|| "媒体准备失败".into()),
                    ))
                }
                JobState::Cancelled => {
                    return Err(JobError::new("cancelled", "媒体准备已取消并退出"))
                }
                _ => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        }
        match resolve_target(Arc::clone(&jobs), reference, target, Arc::clone(&cancel)).await? {
            Resolution::Ready(media) => {
                cancelled(&cancel)?;
                Ok(media)
            }
            Resolution::PrepareRequired(_) => Err(JobError::new(
                "prepare_incomplete",
                "准备终态后仍缺少目标资源，未重复启动任务",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallpaper::{
        assets::AssetStore,
        config::Selection,
        decode_probe::ProbeClient,
        image_prepare::{ImageFit, ImagePurpose},
        library::{tempfileish, InstallWork, Library, LOCAL_SOURCE},
        playlist::{FixedVersion, Mode, Playlist, Repository},
    };
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::io::{Cursor, Write};
    use std::sync::atomic::AtomicUsize;

    const WORK_ID: &str = "c17ed10a-5c55-4a52-85dc-7509f9e88aae";

    fn package(kind: &str, version: u32) -> Vec<u8> {
        if kind == "builtin" {
            return crate::wallpaper::work_drafts::builtin_package(
                &crate::wallpaper::work_drafts::Document {
                    title: "内置场景固定版本".into(),
                    description: String::new(),
                    scene_id: "coast".into(),
                    state_version: 1,
                    params: serde_json::Map::new(),
                    properties: vec![],
                },
                WORK_ID,
                version,
            )
            .unwrap();
        }
        let (bytes, mime, asset_kind, content) = match kind {
            "image" => (
                base64::Engine::decode(
                    &base64::engine::general_purpose::STANDARD,
                    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
                )
                .unwrap(),
                "image/png",
                "image",
                json!({"kind":"image","asset":"background"}),
            ),
            "video" => (
                include_bytes!("../../../../scripts/fixtures/wallpaper-vp8.webm").to_vec(),
                "video/webm",
                "video",
                json!({"kind":"video","asset":"background"}),
            ),
            "image-with-video-asset" => (
                include_bytes!("../../../../scripts/fixtures/wallpaper-vp8.webm").to_vec(),
                "video/webm",
                "video",
                json!({"kind":"image","asset":"background"}),
            ),
            "composition" => (
                serde_json::to_vec(&json!({"documentVersion":1,"canvas":{"width":64,"height":64,"colorSpace":"srgb","background":"#000000"},
                    "nodes":[{"id":"group","type":"group","stateVersion":1}],"timeline":{"durationSeconds":1,"loop":true,"tracks":[]},"bindings":[]})).unwrap(),
                "application/json",
                "vector",
                json!({"kind":"composition","document":"assets/content.bin"}),
            ),
            _ => panic!("unsupported test fixture"),
        };
        let manifest = json!({
            "formatVersion":1,"workId":WORK_ID,"version":version,"title":"固定内容版本",
            "description":"","content":content,
            "assets":[{"id":"background","kind":asset_kind,"source":"assets/content.bin","variants":[]}],
            "files":[{"path":"assets/content.bin","bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes)),"mime":mime}],
            "properties":[],"permissions":{"audioSpectrum":false,"pointer":false},
            "license":{"code":"none","assets":"none","attribution":""}
        });
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(manifest.to_string().as_bytes()).unwrap();
        zip.start_file("assets/content.bin", options).unwrap();
        zip.write_all(&bytes).unwrap();
        zip.finish().unwrap().into_inner()
    }

    async fn install(
        jobs: &ImportJobs,
        kind: &str,
        version: u32,
        summary_kind: &str,
    ) -> FixedVersion {
        let id = format!("layout-fixture-{version}");
        let source = jobs.assets().root().join(format!("{id}.hwpkg"));
        std::fs::write(&source, package(kind, version)).unwrap();
        jobs.assets().snapshot_input(&id, &source, None).unwrap();
        let package = jobs.assets().validate_staged(&id).unwrap();
        jobs.assets().unpack_projection(&id, &package).unwrap();
        jobs.assets()
            .content_writer()
            .unwrap()
            .publish_staging(&id, &package.package_hash)
            .unwrap();
        let reference = FixedVersion {
            work_key: format!("local-{WORK_ID}"),
            package_hash: package.package_hash.clone(),
        };
        jobs.library()
            .install(&InstallWork {
                remote_work_id: WORK_ID.into(),
                work_key: reference.work_key.clone(),
                title: package.manifest.title,
                description: String::new(),
                kind: summary_kind.into(),
                package_hash: package.package_hash.clone(),
                manifest_json: package.manifest_json,
                package_bytes: jobs
                    .assets()
                    .installed_bytes(&package.package_hash)
                    .unwrap(),
                version,
                source_id: LOCAL_SOURCE.into(),
            })
            .await
            .unwrap();
        std::fs::remove_file(source).unwrap();
        reference
    }

    async fn jobs(root: &std::path::Path, decodes: &Arc<AtomicUsize>) -> Arc<ImportJobs> {
        let decodes = Arc::clone(decodes);
        Arc::new(ImportJobs::start(
            Library::open(root).await.unwrap(),
            AssetStore::new(root).unwrap(),
            ProbeClient::testing(move |_, _| {
                decodes.fetch_add(1, Ordering::AcqRel);
                Box::pin(async { Ok(()) })
            }),
        ))
    }

    async fn inspect(
        jobs: &Arc<ImportJobs>,
        selection: Selection,
        members: usize,
    ) -> Result<LayoutInspection> {
        let jobs = Arc::clone(jobs);
        let runtime = tokio::runtime::Handle::current();
        tokio::task::spawn_blocking(move || {
            runtime.block_on(inspect_layout(
                &jobs,
                selection,
                members,
                &AtomicBool::new(false),
            ))
        })
        .await
        .unwrap()
    }

    async fn playlist(jobs: &ImportJobs, items: Vec<FixedVersion>) -> Playlist {
        Repository::new(jobs.library())
            .save(
                None,
                None,
                "镜像资格列表".into(),
                Mode::Sequential,
                60,
                items,
            )
            .await
            .unwrap()
    }

    fn selection(playlist: &Playlist) -> Selection {
        Selection::Playlist {
            playlist_id: playlist.playlist_id.clone(),
        }
    }

    fn target() -> ImageTarget {
        ImageTarget {
            width: 41,
            height: 41,
            fit: ImageFit::Contain,
            purpose: ImagePurpose::Preview,
        }
    }

    async fn mirror_failure(
        jobs: &Arc<ImportJobs>,
        selection: Selection,
        members: usize,
    ) -> Failure {
        resolve_selection_with_layout(
            Arc::clone(jobs),
            selection,
            target(),
            Some(members),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .err()
        .expect("selection must fail before media preparation")
    }

    #[tokio::test]
    async fn layout_inspects_installed_fixed_versions_instead_of_cached_work_kind() {
        let root = tempfileish::temp_dir("layout-fixed-version");
        let decodes = Arc::new(AtomicUsize::new(0));
        let jobs = jobs(root.path(), &decodes).await;
        let image = install(&jobs, "image", 1, "builtin").await;
        let builtin = install(&jobs, "builtin", 2, "image").await;
        assert_eq!(
            jobs.library()
                .get_work(&image.work_key)
                .await
                .unwrap()
                .unwrap()
                .kind,
            "builtin",
            "the cached work summary deliberately disagrees with the image version"
        );
        let eligible = inspect(&jobs, image.selection(), 4).await.unwrap();
        assert!(eligible.mirror_eligible);
        assert_eq!(eligible.max_members, 4);
        assert_eq!(eligible.layouts, ["single", "span", "mirror"]);
        assert!(eligible.reason.is_none());
        sqlx::query("UPDATE works SET kind='image' WHERE work_key=?")
            .bind(&image.work_key)
            .execute(jobs.library().pool())
            .await
            .unwrap();
        let integrated = inspect(&jobs, builtin.selection(), 2).await.unwrap();
        assert!(!integrated.mirror_eligible);
        assert_eq!(integrated.layouts, ["single", "span"]);
        assert!(integrated.reason.unwrap().contains("内置"));
        assert_eq!(
            mirror_failure(&jobs, builtin.selection(), 2)
                .await
                .error
                .code,
            "unsupported_layout"
        );
        let forged = Selection::Package {
            work_key: "another-work".into(),
            package_hash: image.package_hash.clone(),
        };
        assert_eq!(
            inspect(&jobs, forged, 2).await.unwrap_err().code,
            "version_not_found"
        );

        jobs.library()
            .mark_unavailable(&image.package_hash)
            .await
            .unwrap();
        assert!(
            inspect(&jobs, image.selection(), 2)
                .await
                .unwrap()
                .mirror_eligible
        );
        assert!(!jobs
            .library()
            .contains_version(&image.work_key, &image.package_hash)
            .await
            .unwrap());
        jobs.library()
            .mark_available(&image.package_hash)
            .await
            .unwrap();

        std::fs::write(
            jobs.assets()
                .package_dir(&image.package_hash)
                .join("files/assets/content.bin"),
            b"tampered projection",
        )
        .unwrap();
        assert_eq!(
            inspect(&jobs, image.selection(), 2).await.unwrap_err().code,
            "asset_unavailable"
        );
        assert!(
            jobs.library()
                .contains_version(&image.work_key, &image.package_hash)
                .await
                .unwrap(),
            "the inspection must not mutate availability or other library rows"
        );
        assert_eq!(decodes.load(Ordering::Acquire), 0);
        assert!(jobs.active_status().is_none());
    }

    #[tokio::test]
    async fn mirror_rejects_later_builtin_video_overflow_and_future_content_before_preparing() {
        let root = tempfileish::temp_dir("layout-playlist");
        let decodes = Arc::new(AtomicUsize::new(0));
        let jobs = jobs(root.path(), &decodes).await;
        let image = install(&jobs, "image", 1, "image").await;
        let video = install(&jobs, "video", 2, "image").await;
        let builtin = install(&jobs, "builtin", 3, "image").await;
        let future = install(&jobs, "composition", 4, "image").await;
        let disguised_video = install(&jobs, "image-with-video-asset", 5, "image").await;

        let images = playlist(&jobs, vec![image.clone(), image.clone()]).await;
        let eligible = inspect(&jobs, selection(&images), 4).await.unwrap();
        assert!(eligible.mirror_eligible);
        assert_eq!(eligible.max_members, 4);
        assert_eq!(
            eligible.verified_versions, 1,
            "duplicate fixed versions are hashed once"
        );
        let repeated_videos = playlist(&jobs, vec![video.clone(); 32]).await;
        let repeated = inspect(&jobs, selection(&repeated_videos), 2)
            .await
            .unwrap();
        assert!(repeated.mirror_eligible);
        assert_eq!(repeated.max_members, 2);
        assert_eq!(repeated.verified_versions, 1);

        let videos = playlist(&jobs, vec![image.clone(), video.clone()]).await;
        let two = inspect(&jobs, selection(&videos), 2).await.unwrap();
        assert!(two.mirror_eligible);
        assert_eq!(two.max_members, 2);
        let three = inspect(&jobs, selection(&videos), 3).await.unwrap();
        assert!(!three.mirror_eligible);
        assert_eq!(three.max_members, 2);
        assert!(three.reason.unwrap().contains("2"));
        assert_eq!(
            mirror_failure(&jobs, selection(&videos), 3)
                .await
                .error
                .code,
            "unsupported_layout"
        );
        assert_eq!(
            mirror_failure(&jobs, video.selection(), 3).await.error.code,
            "unsupported_layout"
        );
        let resuming_image = resolve_selection_with_options(
            Arc::clone(&jobs),
            selection(&videos),
            target(),
            SelectionOptions {
                mirror_members: Some(3),
                properties: Default::default(),
                composition_fit: None,
                resume: Some(PlaylistResume {
                    revision: videos.revision,
                    reference: image.clone(),
                }),
            },
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .err()
        .expect("resuming the image must still qualify the later video");
        assert_eq!(resuming_image.error.code, "unsupported_layout");
        assert!(resuming_image.poster.is_none());

        let mixed = playlist(&jobs, vec![image.clone(), builtin, video]).await;
        let integrated = inspect(&jobs, selection(&mixed), 2).await.unwrap();
        assert!(!integrated.mirror_eligible);
        assert_eq!(
            integrated.max_members, 2,
            "all entries are inspected after a builtin"
        );
        let failure = mirror_failure(&jobs, selection(&mixed), 2).await;
        assert_eq!(failure.error.code, "unsupported_layout");
        assert!(failure.poster.is_none());

        let unsupported = playlist(&jobs, vec![image, future]).await;
        assert_eq!(
            inspect(&jobs, selection(&unsupported), 2)
                .await
                .unwrap_err()
                .code,
            "unsupported_content"
        );
        assert_eq!(
            mirror_failure(&jobs, selection(&unsupported), 2)
                .await
                .error
                .code,
            "unsupported_content"
        );
        assert_eq!(
            mirror_failure(&jobs, disguised_video.selection(), 3)
                .await
                .error
                .code,
            "unsupported_content"
        );
        assert_eq!(decodes.load(Ordering::Acquire), 0);
        assert!(jobs.active_status().is_none());
    }

    #[tokio::test]
    async fn layout_bounds_and_cancellation_precede_lookup_or_media_preparation() {
        let root = tempfileish::temp_dir("layout-cancel");
        let decodes = Arc::new(AtomicUsize::new(0));
        let jobs = jobs(root.path(), &decodes).await;
        let missing = Selection::Playlist {
            playlist_id: "missing-list".into(),
        };
        for members in [0, 5] {
            assert_eq!(
                mirror_failure(&jobs, missing.clone(), members)
                    .await
                    .error
                    .code,
                "invalid_input"
            );
        }
        let cancelled = Arc::new(AtomicBool::new(true));
        let failure =
            resolve_selection_with_layout(Arc::clone(&jobs), missing, target(), Some(2), cancelled)
                .await
                .err()
                .unwrap();
        assert_eq!(failure.error.code, "cancelled");
        assert_eq!(decodes.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn mirror_resume_uses_matching_snapshot_and_restarts_after_revision_change() {
        let root = tempfileish::temp_dir("layout-resume");
        let decodes = Arc::new(AtomicUsize::new(0));
        let jobs = jobs(root.path(), &decodes).await;
        let first = install(&jobs, "image", 1, "image").await;
        let second = install(&jobs, "image", 2, "image").await;
        let outside = install(&jobs, "builtin", 3, "image").await;
        let original = playlist(&jobs, vec![first.clone(), second.clone()]).await;
        let options = |reference| SelectionOptions {
            mirror_members: Some(2),
            properties: Default::default(),
            composition_fit: None,
            resume: Some(PlaylistResume {
                revision: original.revision,
                reference,
            }),
        };
        let invalid = resolve_selection_with_options(
            Arc::clone(&jobs),
            selection(&original),
            target(),
            options(outside),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .err()
        .expect("a matching revision cannot resume a reference outside its snapshot");
        assert_eq!(invalid.error.code, "playlist_conflict");
        assert_eq!(decodes.load(Ordering::Acquire), 0);
        let resumed = resolve_selection_with_options(
            Arc::clone(&jobs),
            selection(&original),
            target(),
            options(second.clone()),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        assert_eq!(resumed.reference, second);
        let ResolvedSelection::Media(media) = resumed.content else {
            panic!("the resumed image must resolve as media");
        };
        assert_eq!(media.reference().package_hash, second.package_hash);
        assert_eq!(
            resumed.playlist.as_ref().unwrap().revision,
            original.revision
        );
        assert_eq!(resumed.playlist.unwrap().items, original.items);
        drop(media);

        let updated = Repository::new(jobs.library())
            .save(
                Some(&original.playlist_id),
                Some(original.revision),
                original.title.clone(),
                original.mode,
                original.interval_seconds,
                vec![first.clone()],
            )
            .await
            .unwrap();
        let restarted = resolve_selection_with_options(
            Arc::clone(&jobs),
            selection(&updated),
            target(),
            options(second),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        assert_eq!(restarted.reference, first);
        let retained = restarted.playlist.unwrap();
        assert_eq!(retained.revision, updated.revision);
        assert_eq!(retained.items, updated.items);
    }

    #[tokio::test]
    async fn mirror_intent_preflight_checks_offline_sources_without_media_preparation() {
        let root = tempfileish::temp_dir("layout-offline-intent");
        let decodes = Arc::new(AtomicUsize::new(0));
        let jobs = jobs(root.path(), &decodes).await;
        let image = install(&jobs, "image", 1, "image").await;
        let video = install(&jobs, "video", 2, "image").await;
        let builtin = install(&jobs, "builtin", 3, "image").await;
        let mixed = playlist(&jobs, vec![image.clone(), builtin]).await;
        let validate = |selections| {
            let jobs = Arc::clone(&jobs);
            let runtime = tokio::runtime::Handle::current();
            tokio::task::spawn_blocking(move || {
                runtime.block_on(validate_mirror_layouts(
                    &jobs,
                    selections,
                    &AtomicBool::new(false),
                ))
            })
        };
        validate(vec![(image.selection(), 4)])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            validate(vec![(image.selection(), 2), (video.selection(), 3)])
                .await
                .unwrap()
                .unwrap_err()
                .code,
            "unsupported_layout"
        );
        assert_eq!(
            validate(vec![(selection(&mixed), 2)])
                .await
                .unwrap()
                .unwrap_err()
                .code,
            "unsupported_layout"
        );
        assert_eq!(
            validate(vec![(
                Selection::Builtin {
                    scene_id: "coast".into(),
                    state_version: 1,
                    params: serde_json::Map::new()
                },
                2
            )])
            .await
            .unwrap()
            .unwrap_err()
            .code,
            "unsupported_layout"
        );
        assert_eq!(decodes.load(Ordering::Acquire), 0);
        assert!(jobs.active_status().is_none());
        std::fs::write(
            jobs.assets()
                .package_dir(&image.package_hash)
                .join("files/assets/content.bin"),
            b"changed after the first inspection",
        )
        .unwrap();
        assert_eq!(
            validate(vec![(image.selection(), 4)])
                .await
                .unwrap()
                .unwrap_err()
                .code,
            "asset_unavailable",
            "native intent preflight rechecks actual bytes after an earlier success"
        );
    }

    #[tokio::test]
    async fn mirror_plan_retains_the_inspected_playlist_revision_during_preparation() {
        let root = tempfileish::temp_dir("layout-snapshot");
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let first_probe = Arc::new(AtomicBool::new(true));
        struct ReleaseOnDrop(Arc<tokio::sync::Notify>);
        impl Drop for ReleaseOnDrop {
            fn drop(&mut self) {
                self.0.notify_one();
            }
        }
        let _release_on_drop = ReleaseOnDrop(Arc::clone(&release));
        let probe_entered = Arc::clone(&entered);
        let probe_release = Arc::clone(&release);
        let jobs = Arc::new(ImportJobs::start(
            Library::open(root.path()).await.unwrap(),
            AssetStore::new(root.path()).unwrap(),
            ProbeClient::testing(move |_, _| {
                let first = first_probe.swap(false, Ordering::AcqRel);
                let entered = Arc::clone(&probe_entered);
                let release = Arc::clone(&probe_release);
                Box::pin(async move {
                    if first {
                        entered.notify_one();
                        release.notified().await;
                    }
                    Ok(())
                })
            }),
        ));
        let image = install(&jobs, "image", 1, "image").await;
        let resumed_image = install(&jobs, "image", 2, "image").await;
        let builtin = install(&jobs, "builtin", 3, "image").await;
        let original = playlist(&jobs, vec![image.clone(), resumed_image.clone()]).await;
        let resolve = resolve_selection_with_options(
            Arc::clone(&jobs),
            selection(&original),
            target(),
            SelectionOptions {
                mirror_members: Some(2),
                properties: Default::default(),
                composition_fit: None,
                resume: Some(PlaylistResume {
                    revision: original.revision,
                    reference: resumed_image.clone(),
                }),
            },
            Arc::new(AtomicBool::new(false)),
        );
        let update = async {
            tokio::time::timeout(Duration::from_secs(5), entered.notified())
                .await
                .expect("the resumed image reached preparation");
            let updated = Repository::new(jobs.library())
                .save(
                    Some(&original.playlist_id),
                    Some(original.revision),
                    original.title.clone(),
                    original.mode,
                    original.interval_seconds,
                    vec![image.clone(), builtin],
                )
                .await
                .unwrap();
            release.notify_one();
            updated
        };
        let (resolved, updated) = tokio::join!(resolve, update);
        let plan = resolved.unwrap();
        assert!(matches!(plan.content, ResolvedSelection::Media(_)));
        assert_eq!(plan.reference, resumed_image);
        let retained = plan.playlist.unwrap();
        assert_eq!(retained.revision, original.revision);
        assert_eq!(retained.items, original.items);
        assert_eq!(updated.revision, original.revision + 1);
        assert!(
            !inspect(&jobs, selection(&updated), 2)
                .await
                .unwrap()
                .mirror_eligible
        );
    }
}
