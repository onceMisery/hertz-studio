// SPDX-License-Identifier: MIT
//! Image candidates use the original single preparation worker and installer.
use super::super::{
    ai_receipts::{AiReceipts, ImageReception},
    assets::{DecodeInput, SnapshotReceipt},
    generation::receive::ReceivedImage,
};
use super::*;

async fn prepare(
    request: &JobRequest,
    input: &DecodeInput,
    target: Option<super::super::image_prepare::ImageTarget>,
    library: &Library,
    assets: &AssetStore,
    probe: &ProbeClient,
) -> Result<super::super::image_prepare::PreparedImage, JobError> {
    if input.metadata.container != super::super::media::Container::Image
        || input.metadata.codec != "png"
        || input
            .metadata
            .encoded_width
            .max(input.metadata.encoded_height)
            > 4096
        || u64::from(input.metadata.encoded_width) * u64::from(input.metadata.encoded_height)
            > 8 * 1024 * 1024
    {
        return Err(JobError::new(
            "ai_output_rejected",
            "图片候选必须是受限的标准单帧PNG",
        ));
    }
    let mut image = super::super::image_prepare::prepare(
        assets,
        library,
        probe,
        &request.job_id,
        input,
        target,
        &request.cancel,
    )
    .await?;
    probe
        .qualify(
            library,
            image.decode_input(assets, input)?,
            Arc::clone(&request.cancel),
        )
        .await?;
    cancelled(&request.cancel)?;
    image.publish(assets, library).await?;
    Ok(image)
}

pub(super) async fn receive(
    request: &JobRequest,
    received: ReceivedImage,
    library: &Library,
    assets: &AssetStore,
    probe: &ProbeClient,
) -> Result<ImageReception, JobError> {
    let work_id = uuid::Uuid::new_v4().to_string();
    let id = format!("work-ai-{work_id}");
    let snapshot = SnapshotReceipt {
        job_id: request.job_id.clone(),
        original: received.file.clone(),
        bytes: received.artifact.bytes,
        sha256: received.artifact.sha256.clone(),
    };
    super::super::raw_import::ensure_ai_image_package(
        assets,
        library,
        snapshot,
        &work_id,
        "AI 图片",
        &request.cancel,
    )
    .await?;
    let package = assets.validate_staged(&request.job_id)?;
    assets.unpack_projection(&request.job_id, &package)?;
    let thumbnail = {
        let inputs = assets.probe_staged_media(&request.job_id, &package, &request.cancel)?;
        if inputs.len() != 1 {
            return Err(JobError::new(
                "ai_output_rejected",
                "候选必须恰好有一张图片",
            ));
        }
        let image = prepare(request, &inputs[0], None, library, assets, probe).await?;
        image.candidate_thumbnail(assets, probe, &request.job_id, &request.cancel)?
    };
    cancelled(&request.cancel)?;
    Ok(ImageReception {
        received,
        package,
        id,
        job: request.job_id.clone(),
        thumbnail,
    })
}

pub(super) async fn preview(
    request: &JobRequest,
    id: &str,
    target: super::super::image_prepare::ImageTarget,
    library: &Library,
    assets: &AssetStore,
    probe: &ProbeClient,
) -> Result<super::super::target_planner::ResolvedMedia, JobError> {
    // Recheck live candidate authority after admission to the original worker.
    AiReceipts::new(library).preview_source(id, 1).await?;
    let identity = AiReceipts::new(library).image_identity(id, None).await?;
    let package = assets.read_candidate(id, &identity.candidate_hash)?;
    let inputs = assets.probe_media_at(
        &assets.candidate_dir(id)?.join("files"),
        &package,
        &request.cancel,
    )?;
    let reference = AssetRef {
        package_hash: package.package_hash.clone(),
        asset_id: "background".into(),
        variant_id: None,
    };
    let (reference, input) = super::super::target_planner::select_input(
        &package,
        &inputs,
        &reference,
        target,
        &["image/png".into()],
    )?;
    let image = prepare(request, &input, Some(target), library, assets, probe).await?;
    AiReceipts::new(library).preview_source(id, 1).await?;
    super::super::target_planner::ResolvedMedia::from_input(
        reference,
        image.decode_input(assets, &input)?,
        image.content_key(),
        target,
    )
}

pub(super) async fn save(
    request: &JobRequest,
    id: &str,
    title: &str,
    library: &Library,
    assets: &AssetStore,
    probe: &ProbeClient,
    writer: &super::super::content_quota::Writer<'_>,
) -> Result<serde_json::Value, JobError> {
    let receipts = AiReceipts::new(library);
    let current = receipts.get(id).await?;
    if current["state"] == "saved" {
        return Ok(current);
    }
    let identity = receipts.image_identity(id, Some(title)).await?;
    let package = assets.read_candidate(id, &identity.candidate_hash)?;
    let inputs = assets.probe_media_at(
        &assets.candidate_dir(id)?.join("files"),
        &package,
        &request.cancel,
    )?;
    if inputs.len() != 1 {
        return Err(JobError::new("ai_output_rejected", "候选图片数量无效"));
    }
    let file = super::super::assets::open_immutable(&inputs[0].media.path)?;
    let raw = assets.snapshot_open_file(&request.job_id, &file, Some(&request.cancel))?;
    drop(file);
    drop(inputs);
    let wrapped = super::super::raw_import::ensure_ai_image_package(
        assets,
        library,
        raw,
        &identity.work_id,
        &identity.title,
        &request.cancel,
    )
    .await?;
    cancelled(&request.cancel)?;
    receipts
        .freeze_image_save(id, &identity.title, &wrapped.sha256)
        .await?;
    install_snapshot(request, wrapped, library, assets, probe, writer, None).await?;
    library.ai_receipts_changed.notify_one();
    receipts.get(id).await
}
