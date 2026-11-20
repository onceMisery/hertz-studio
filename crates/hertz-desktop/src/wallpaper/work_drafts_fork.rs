// SPDX-License-Identifier: MIT
//! Explicit save-as keeps immutable provenance in the original draft owner.
use super::*;
use std::{io::Read, sync::atomic::AtomicBool};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Provenance {
    pub work_key: String,
    pub package_hash: String,
}
impl Provenance {
    pub(super) fn validate(&self) -> Result<()> {
        if !super::super::api::valid_id(&self.work_key)
            || !hertz_wallpaper::valid_sha256_hex(&self.package_hash)
        {
            return Err(invalid("派生来源身份无效"));
        }
        Ok(())
    }
}

impl WorkDrafts<'_> {
    /// Caller holds AssetStore's content writer through license verification
    /// and insertion, so deletion cannot race the provenance reference.
    pub(crate) async fn fork_from_version(
        &self,
        work_key: &str,
        package_hash: &str,
        assets: &AssetStore,
    ) -> Result<Draft> {
        if !self
            .library
            .contains_version(work_key, package_hash)
            .await?
        {
            return Err(JobError::new("version_not_found", "作品版本尚未安装"));
        }
        let work = self
            .library
            .get_work(work_key)
            .await?
            .ok_or_else(|| JobError::new("work_not_found", "作品不存在"))?;
        let package = assets.read_installed_manifest(package_hash)?;
        if work.remote_work_id.as_deref() != Some(package.manifest.work_id.as_str()) {
            return Err(invalid("作品来源身份不符"));
        }
        let authored: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM authored_versions a JOIN versions v ON v.version_key=a.version_key WHERE v.work_key=? AND v.package_hash=?)")
            .bind(work_key).bind(package_hash).fetch_one(self.library.pool()).await.map_err(database)?;
        // This is an ownership fact, never a checkbox or workId/title claim.
        let locally_authored = work.source_id == "local" && authored;
        let mut document = document_from_package(work_key, &package, assets)?;
        composition::validate_derivative_license(&package, assets, locally_authored, self.library)
            .await?;
        document.title = format!(
            "{}（副本）",
            document.title.chars().take(116).collect::<String>()
        );
        self.create_owned(document, None, None).await
    }
}

pub(super) fn document_from_package(
    work_key: &str,
    package: &crate::wallpaper::assets::StagedPackage,
    assets: &AssetStore,
) -> Result<Document> {
    let manifest = &package.manifest;
    let mut document = Document {
        title: manifest.title.clone(),
        description: manifest.description.clone(),
        scene_id: String::new(),
        state_version: 0,
        params: Map::new(),
        properties: hertz_wallpaper::properties::validate_properties(manifest).map_err(invalid)?,
        composition: None,
        resources: vec![],
        provenance: Some(Provenance {
            work_key: work_key.into(),
            package_hash: package.package_hash.clone(),
        }),
    };
    match &manifest.content {
        hertz_wallpaper::Content::Builtin {
            scene_id,
            state_version,
            params,
        } => {
            // The builtin editor cannot consume attachment assets; refusing is
            // preferable to silently dropping them or their license obligations.
            if !manifest.assets.is_empty() {
                return Err(JobError::new(
                    "work_not_editable",
                    "内置作品含当前编辑器不支持的附件素材",
                ));
            }
            document.scene_id = scene_id.clone();
            document.state_version = *state_version;
            document.params = params.clone();
        }
        hertz_wallpaper::Content::Composition { document: path } => {
            let pin = assets.pin_package_entry(package, path, &AtomicBool::new(false))?;
            let mut bytes = Vec::new();
            crate::wallpaper::assets::open_immutable(&pin.path)?
                .take(MAX_DOCUMENT_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(io)?;
            let compiled =
                hertz_wallpaper::document::compile_document(&bytes, manifest).map_err(invalid)?;
            document.composition = Some(compiled.document().clone());
            document.resources = manifest
                .assets
                .iter()
                .map(|asset| Resource {
                    asset_id: asset.id.clone(),
                    kind: asset.kind,
                    work_key: work_key.into(),
                    package_hash: package.package_hash.clone(),
                    source_asset_id: asset.id.clone(),
                    candidate_id: None,
                })
                .collect();
        }
        _ => {
            return Err(JobError::new(
                "work_not_editable",
                "当前仅支持将内置场景或组合作品另存为新作品",
            ))
        }
    }
    document.normalize()?;
    Ok(document)
}

#[cfg(test)]
#[path = "work_drafts_fork_tests.rs"]
mod tests;
