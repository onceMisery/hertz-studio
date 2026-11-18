// SPDX-License-Identifier: MIT
//! A branch of the original import slot, writer, cancellation and installation.
use super::*;
use crate::wallpaper::community::{
    self as trusted,
    subscriptions::{DownloadIntent, Subscriptions},
    AcceptedRelease,
};

pub(super) async fn run(
    request: &JobRequest,
    intent: &DownloadIntent,
    library: &Library,
    assets: &AssetStore,
    probe: &ProbeClient,
    writer: &super::super::content_quota::Writer<'_>,
) -> Result<String, JobError> {
    let _workspace = probe
        .budget_handle()
        .admit_working_bytes(8 * 1024 * 1024)
        .map_err(|e| JobError::new("budget_busy", e.message.to_string()))?;
    let result = async {
        cancelled(&request.cancel)?;
        let profile = library.trust().profile(&intent.plan.source_id).await?;
        let (chain, revocations) = trusted::network::safety(&profile).await?;
        // Security synchronization is independent of a missing/bad latest release.
        library
            .trust()
            .accept(&profile.source_id, &chain, &revocations, None)
            .await?;
        let release = trusted::network::latest(&profile, &intent.plan.remote_work_id).await?;
        let accepted = library
            .trust()
            .accept(
                &profile.source_id,
                &chain,
                &revocations,
                Some((&release, &intent.plan.remote_work_id)),
            )
            .await?
            .ok_or_else(|| JobError::new("release_missing", "社区未返回已签发布"))?;
        Subscriptions::new(library)
            .save_release(&intent.plan, &accepted)
            .await?;
        cancelled(&request.cancel)?;
        writer.preflight_growth(accepted.body().bytes.saturating_mul(2))?;
        assets.check_disk_space(accepted.body().bytes.saturating_mul(2))?;
        let staging = assets.staging_dir(&request.job_id);
        std::fs::create_dir(&staging).map_err(|e| JobError::io(e.to_string()))?;
        set_state(&request.status, JobState::Preparing);
        let receipt = trusted::network::download(
            &accepted,
            &request.job_id,
            &staging.join("original.hwpkg"),
            &request.cancel,
        )
        .await?;
        cancelled(&request.cancel)?;
        super::install_snapshot(
            request,
            receipt,
            library,
            assets,
            probe,
            writer,
            Some(&accepted),
        )
        .await
    }
    .await;
    if let Err(e) = &result {
        Subscriptions::new(library)
            .fail(
                &intent.plan.operation_id,
                &format!("{}: {}", e.code, e.message),
            )
            .await?;
    }
    result
}

pub(super) async fn index(
    library: &Library,
    package: &super::super::assets::StagedPackage,
    bytes: u64,
    release: Option<&AcceptedRelease>,
) -> Result<(), JobError> {
    library.trust().security_check(&package.package_hash)?;
    let source = if let Some(release) = release {
        release.validate_package(package, bytes)?;
        let profile = library.trust().profile(release.source_id()).await?;
        Subscriptions::new(library).project_source(&profile).await?;
        release.source_id()
    } else {
        LOCAL_SOURCE
    };
    let key = if source == LOCAL_SOURCE {
        format!("local-{}", package.manifest.work_id)
    } else {
        format!("hub-{}", uuid::Uuid::new_v4())
    };
    library
        .install(&super::super::library::InstallWork {
            remote_work_id: package.manifest.work_id.clone(),
            work_key: key,
            title: package.manifest.title.clone(),
            description: package.manifest.description.clone(),
            kind: manifest_kind(&package.manifest),
            package_hash: package.package_hash.clone(),
            manifest_json: package.manifest_json.clone(),
            package_bytes: bytes,
            version: package.manifest.version,
            source_id: source.to_owned(),
        })
        .await
}

pub(super) async fn recover(
    library: &Library,
    assets: &AssetStore,
    package: &super::super::assets::StagedPackage,
) -> Result<(), JobError> {
    let receipts = library
        .trust()
        .receipts_for_hash(&package.package_hash)
        .await?;
    let bytes = assets.installed_bytes(&package.package_hash)?;
    if receipts.is_empty() {
        index(library, package, bytes, None).await?;
    } else {
        for receipt in &receipts {
            index(library, package, bytes, Some(receipt)).await?;
        }
    }
    Ok(())
}
