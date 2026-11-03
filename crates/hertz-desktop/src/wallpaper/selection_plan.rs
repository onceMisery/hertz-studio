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
) -> std::result::Result<ResolvedMedia, Failure> {
    request.validate()?;
    match resolve_media(Arc::clone(&jobs), request.clone(), Arc::clone(&cancel)).await {
        Ok(media) => Ok(media),
        Err(error) if error.code == "cancelled" || cancel.load(Ordering::Acquire) => {
            Err(JobError::new("cancelled", "媒体选择已取消并退出").into())
        }
        Err(error) => {
            let runtime = tokio::runtime::Handle::current();
            let poster = tokio::task::spawn_blocking(move || {
                runtime.block_on(super::video_poster::resolve_recorded(
                    jobs.assets(),
                    jobs.library(),
                    &request,
                ))
            })
            .await;
            cancelled(&cancel)?;
            let poster = match poster {
                Ok(Ok(poster)) => poster.map(Box::new),
                _ => None,
            };
            Err(Failure { error, poster })
        }
    }
}

async fn resolve_media(
    jobs: Arc<ImportJobs>,
    request: Request,
    cancel: Arc<AtomicBool>,
) -> Result<ResolvedMedia> {
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
    let source_cancel = Arc::clone(&cancel);
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
        let asset_id = match package.manifest.content {
            hertz_wallpaper::Content::Image { asset }
            | hertz_wallpaper::Content::Video { asset } => asset,
            _ => {
                return Err(JobError::new(
                    "unsupported_content",
                    "当前呈现入口只接受单张图片或单个视频作品",
                ))
            }
        };
        Ok(AssetRef {
            package_hash: hash,
            asset_id,
            variant_id: None,
        })
    })
    .await
    .map_err(|_| JobError::new("worker_unavailable", "媒体选择线程已退出"))?;
    let reference = match reference {
        Ok(reference) => reference,
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
    let preparation = match resolve_target(
        Arc::clone(&jobs),
        reference.clone(),
        request.target,
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
        match resolve_target(
            Arc::clone(&jobs),
            reference,
            request.target,
            Arc::clone(&cancel),
        )
        .await?
        {
            Resolution::Ready(media) => {
                cancelled(&cancel)?;
                jobs.library().mark_available(&request.package_hash).await?;
                Ok(media)
            }
            Resolution::PrepareRequired(_) => Err(JobError::new(
                "prepare_incomplete",
                "准备终态后仍缺少目标资源，未重复启动任务",
            )),
        }
    }
}
