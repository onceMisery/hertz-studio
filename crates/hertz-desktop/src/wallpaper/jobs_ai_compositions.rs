// SPDX-License-Identifier: MIT
//! Actual composition candidate packages use the original receive worker.
use super::*;
pub(super) async fn receive(
    request: &JobRequest,
    received: super::super::generation::receive::ReceivedBuiltin,
    native: &Arc<super::super::generation::NativeGeneration>,
    library: &Arc<Library>,
    assets: &Arc<AssetStore>,
    writer: &super::super::content_quota::Writer<'_>,
) -> Result<serde_json::Value, JobError> {
    let snapshots = super::super::ai_asset_sets::AiAssetSets(library);
    let snapshot = snapshots
        .by_job(&native.service_identity()?, &received.artifact.job_id)
        .await?;
    for (hash, frozen) in &snapshot.packages {
        let package = assets.read_installed_manifest(hash)?;
        if package.entries.len() != frozen.entries.len()
            || package.entries.iter().zip(&frozen.entries).any(|(a, b)| {
                a.path != b.path || a.bytes != b.bytes || a.sha256 != b.sha256 || a.mime != b.mime
            })
            || package.manifest.license.assets != frozen.license
            || package.manifest.license.attribution != frozen.attribution
        {
            return Err(JobError::new(
                "asset_set_changed",
                "冻结素材字节或许可事实已变化",
            ));
        }
    }
    let output = hertz_wallpaper::generation::composition::CompositionOutput::parse(
        &received.bytes,
        &snapshot.metadata,
    )
    .map_err(|e| JobError::new(e.code, e.message))?;
    let mapping = snapshot
        .frozen
        .iter()
        .map(|f| (f.alias.clone(), f.alias.clone()))
        .collect();
    let composition = output
        .remap_assets(&mapping)
        .map_err(|e| JobError::new(e.code, e.message))?;
    let work = uuid::Uuid::new_v4().to_string();
    let id = format!("work-ai-{work}");
    let mut document = super::super::work_drafts::Document {
        title: "AI 组合".into(),
        description: String::new(),
        scene_id: String::new(),
        state_version: 0,
        params: Default::default(),
        properties: vec![],
        composition: Some(composition),
        resources: snapshot.resources(),
        provenance: None,
    };
    let build = super::super::work_drafts::PackageBuild::resolve(
        &document,
        &work,
        1,
        assets,
        &request.cancel,
    )?;
    let maximum = build.maximum_bytes()?;
    writer.preflight_growth(maximum.saturating_mul(2))?;
    assets.check_disk_space(maximum.saturating_mul(2))?;
    build.write(
        &assets.staging_dir(&request.job_id).join("original.hwpkg"),
        &request.cancel,
    )?;
    drop(build);
    let package = assets.validate_staged(&request.job_id)?;
    assets.unpack_projection(&request.job_id, &package)?;
    document.resources = package
        .manifest
        .assets
        .iter()
        .map(|a| super::super::work_drafts::Resource {
            asset_id: a.id.clone(),
            kind: a.kind,
            work_key: format!("local-{work}"),
            package_hash: package.package_hash.clone(),
            source_asset_id: a.id.clone(),
            candidate_id: Some(id.clone()),
        })
        .collect();
    cancelled(&request.cancel)?;
    let bytes = writer.publish_candidate(&request.job_id, &id)?;
    library.ai_receipts_changed.notify_one();
    let epoch = received.epoch;
    let native = Arc::clone(native);
    let library = Arc::clone(library);
    let cancel = Arc::clone(&request.cancel);
    let runtime = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        runtime.block_on(
            super::super::ai_receipts::AiReceipts::new(&library).receive_composition(
                received,
                &id,
                &package,
                &document,
                bytes,
                || native.receive_permit(epoch, &cancel),
            ),
        )
    })
    .await
    .map_err(|e| JobError::io(e.to_string()))?
}
