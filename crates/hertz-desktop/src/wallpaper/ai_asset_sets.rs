// SPDX-License-Identifier: MIT
//! Native frozen version/alias mapping. The service sees only bounded metadata.
#[cfg(test)]
#[path = "ai_asset_sets_lifecycle_tests.rs"]
mod lifecycle_tests;
use super::{
    assets::{AssetStore, StagedPackage},
    jobs::JobError,
    library::{now_secs, Library},
    work_drafts::Resource,
};
use hertz_wallpaper::generation::composition::{AssetMetadata, AssetSet};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeSet, sync::atomic::AtomicBool};
type Result<T> = std::result::Result<T, JobError>;
fn db(e: impl std::fmt::Display) -> JobError {
    JobError::database(e.to_string())
}
fn invalid(e: impl std::fmt::Display) -> JobError {
    JobError::invalid_input(e.to_string())
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Selection {
    pub work_key: String,
    pub package_hash: String,
    pub asset_id: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Frozen {
    pub alias: String,
    pub selection: Selection,
    pub kind: hertz_wallpaper::AssetKind,
    pub rights_basis: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FrozenPackage {
    pub entries: Vec<hertz_wallpaper::VerifiedEntry>,
    pub license: String,
    pub attribution: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalSnapshot {
    selections: Vec<Frozen>,
    packages: std::collections::BTreeMap<String, FrozenPackage>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyFrozen {
    alias: String,
    selection: Selection,
    kind: hertz_wallpaper::AssetKind,
    entries: Vec<hertz_wallpaper::VerifiedEntry>,
    license: String,
    attribution: String,
    rights_basis: String,
}
#[derive(Clone)]
pub(crate) struct Snapshot {
    pub metadata: AssetSet,
    pub frozen: Vec<Frozen>,
    pub packages: std::collections::BTreeMap<String, FrozenPackage>,
}
pub(crate) struct AiAssetSets<'a>(pub &'a Library);
impl<'a> AiAssetSets<'a> {
    pub(crate) async fn list(
        &self,
        assets: &AssetStore,
        limit: u32,
        cursor: Option<&str>,
    ) -> Result<Value> {
        let mut position = cursor
            .map(|value| serde_json::from_str::<(String, String, usize)>(value).map_err(invalid))
            .transpose()?;
        if position.as_ref().is_some_and(|(work, hash, index)| {
            !super::api::valid_id(work) || !hertz_wallpaper::valid_sha256_hex(hash) || *index > 4096
        }) {
            return Err(invalid("素材游标无效"));
        }
        let limit = limit.clamp(1, 20) as usize;
        let mut items = Vec::with_capacity(limit);
        let mut inclusive = position.is_some();
        loop {
            let rows:Vec<(String,String,String)>=sqlx::query_as("SELECT DISTINCT v.work_key,v.package_hash,w.title FROM versions v JOIN packages p ON p.package_hash=v.package_hash JOIN works w ON w.work_key=v.work_key WHERE p.state='installed' AND (?1 IS NULL OR (v.work_key,v.package_hash)>(?1,?2) OR (?3 AND v.work_key=?1 AND v.package_hash=?2)) ORDER BY v.work_key,v.package_hash LIMIT 21")
    .bind(position.as_ref().map(|p|&p.0)).bind(position.as_ref().map(|p|&p.1)).bind(inclusive).fetch_all(self.0.pool()).await.map_err(db)?;
            let count = rows.len();
            if count == 0 {
                break;
            }
            for (work, hash, title) in rows {
                let package = assets.read_installed_manifest(&hash)?;
                let authored = self.authored(&work, &hash).await?;
                let rights = rights(&package, authored, false);
                let start = position
                    .as_ref()
                    .filter(|p| inclusive && p.0 == work && p.1 == hash)
                    .map_or(0, |p| p.2);
                if start > package.manifest.assets.len() {
                    return Err(invalid("素材游标已变化"));
                }
                for (index, asset) in package.manifest.assets.iter().enumerate().skip(start) {
                    if items.len() == limit {
                        return Ok(
                            json!({"assets":items,"nextCursor":serde_json::to_string(&(work,hash,index)).map_err(invalid)?}),
                        );
                    }
                    let metadata = metadata_for(assets, &package, asset)?;
                    let mut item = json!({"workKey":work,"packageHash":hash,"assetId":asset.id,"label":format!("{} · {}",title,asset.id),"kind":asset.kind,"rights":rights});
                    if let Some(width) = metadata.0 {
                        item["width"] = json!(width)
                    }
                    if let Some(height) = metadata.1 {
                        item["height"] = json!(height)
                    }
                    if let Some(duration) = metadata.2 {
                        item["durationMs"] = json!(duration)
                    }
                    items.push(item);
                }
                position = Some((work, hash, 0));
                inclusive = false;
            }
            if count < 21 {
                break;
            }
        }
        Ok(json!({"assets":items,"nextCursor":Value::Null}))
    }
    async fn authored(&self, work: &str, hash: &str) -> Result<bool> {
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM authored_versions a JOIN versions v ON v.version_key=a.version_key WHERE v.work_key=? AND v.package_hash=?)").bind(work).bind(hash).fetch_one(self.0.pool()).await.map_err(db)
    }
    pub(crate) async fn freeze(
        &self,
        assets: &AssetStore,
        selections: Vec<Selection>,
        confirmed: bool,
    ) -> Result<Snapshot> {
        if !confirmed || selections.is_empty() || selections.len() > 32 {
            return Err(invalid("请确认有权改编1至32项素材"));
        }
        let mut unique = BTreeSet::new();
        let mut packages = std::collections::BTreeMap::new();
        let mut frozen_packages = std::collections::BTreeMap::new();
        let mut frozen = Vec::new();
        let mut metadata = Vec::new();
        for (number, selection) in selections.into_iter().enumerate() {
            if !hertz_wallpaper::valid_sha256_hex(&selection.package_hash)
                || !hertz_wallpaper::valid_local_id(&selection.asset_id)
                || !super::api::valid_id(&selection.work_key)
                || !unique.insert((
                    selection.work_key.clone(),
                    selection.package_hash.clone(),
                    selection.asset_id.clone(),
                ))
            {
                return Err(invalid("素材身份无效或重复"));
            }
            if !self
                .0
                .contains_version(&selection.work_key, &selection.package_hash)
                .await?
            {
                return Err(invalid("选定版本已被移除"));
            }
            let first_package = !packages.contains_key(&selection.package_hash);
            if first_package {
                packages.insert(
                    selection.package_hash.clone(),
                    assets.read_installed_manifest(&selection.package_hash)?,
                );
            }
            let package = &packages[&selection.package_hash];
            let authored = self
                .authored(&selection.work_key, &selection.package_hash)
                .await?;
            let right = rights(package, authored, true);
            if right["eligible"] != true {
                return Err(JobError::new(
                    "asset_rights_unsupported",
                    "选定素材许可不允许改编或缺少明确使用权",
                ));
            }
            let asset = package
                .manifest
                .assets
                .iter()
                .find(|a| a.id == selection.asset_id)
                .ok_or_else(|| invalid("选定资源不存在"))?;
            let facts = metadata_for(assets, package, asset)?;
            let alias = format!("a{number:02}");
            metadata.push(AssetMetadata {
                alias: alias.clone(),
                kind: asset.kind,
                width: facts.0,
                height: facts.1,
                duration_ms: facts.2,
            });
            // Freeze archive-verified tuples including dependency inventory. They are
            // local-only and checked again at the actual read, never sent to the model.
            if first_package {
                frozen_packages.insert(
                    selection.package_hash.clone(),
                    FrozenPackage {
                        entries: package.entries.clone(),
                        license: package.manifest.license.assets.clone(),
                        attribution: package.manifest.license.attribution.clone(),
                    },
                );
            }
            frozen.push(Frozen {
                alias,
                selection,
                kind: asset.kind,
                rights_basis: right["basis"].as_str().unwrap_or("").into(),
            });
        }
        let metadata = AssetSet { assets: metadata };
        metadata.validate().map_err(invalid)?;
        let snapshot = Snapshot {
            metadata,
            frozen,
            packages: frozen_packages,
        };
        if snapshot.local_json()?.len() > 131072 {
            return Err(invalid("本机素材依赖快照超过128 KiB"));
        }
        Ok(snapshot)
    }
    pub(crate) async fn insert<F, G>(
        &self,
        snapshot: &Snapshot,
        service: &str,
        response: &Value,
        authority: F,
    ) -> Result<Value>
    where
        F: FnOnce() -> Result<G>,
    {
        let id = response["assetSetId"]
            .as_str()
            .filter(|v| super::api::valid_id(v))
            .ok_or_else(|| invalid("服务素材集ID无效"))?;
        let digest = snapshot.metadata.digest().map_err(invalid)?;
        let expiry = response["expiresAt"]
            .as_i64()
            .ok_or_else(|| invalid("素材集期限无效"))?
            / 1000;
        if response["digest"] != digest
            || response["assetCount"] != snapshot.frozen.len()
            || expiry <= now_secs()
            || expiry > now_secs() + 300
        {
            return Err(invalid("服务素材集摘要或期限不符"));
        }
        let mut tx = self
            .0
            .pool()
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(db)?;
        sqlx::query("DELETE FROM ai_asset_sets WHERE expires_at<=?")
            .bind(now_secs())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM ai_asset_sets WHERE service_identity=?")
                .bind(service)
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if count >= 8 {
            return Err(JobError::new(
                "asset_set_capacity",
                "当前来源最多保留8组素材快照",
            ));
        }
        for item in &snapshot.frozen {
            let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM versions v JOIN packages p ON p.package_hash=v.package_hash WHERE v.work_key=? AND v.package_hash=? AND p.state='installed')").bind(&item.selection.work_key).bind(&item.selection.package_hash).fetch_one(&mut *tx).await.map_err(db)?;
            if !exists {
                return Err(invalid("选定版本在建立快照前已被移除"));
            }
        }
        sqlx::query("INSERT INTO ai_asset_sets(asset_set_id,service_identity,digest,metadata_json,selections_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)").bind(id).bind(service).bind(digest).bind(serde_json::to_string(&snapshot.metadata).map_err(invalid)?).bind(snapshot.local_json()?).bind(now_secs()).bind(expiry).execute(&mut *tx).await.map_err(db)?;
        for item in &snapshot.frozen {
            sqlx::query("INSERT OR IGNORE INTO ai_asset_references(asset_set_id,work_key,package_hash) VALUES(?,?,?)").bind(id).bind(&item.selection.work_key).bind(&item.selection.package_hash).execute(&mut *tx).await.map_err(db)?;
        }
        let permit = authority()?;
        tx.commit().await.map_err(db)?;
        drop(permit);
        Ok(response.clone())
    }
    pub(crate) async fn bind_quote(
        &self,
        id: &str,
        service: &str,
        digest: &str,
        quote: &str,
        request: &str,
    ) -> Result<()> {
        let changed=sqlx::query("UPDATE ai_asset_sets SET quote_id=?,request_id=?,expires_at=? WHERE asset_set_id=? AND service_identity=? AND digest=? AND expires_at>? AND job_id IS NULL").bind(quote).bind(request).bind(now_secs()+300).bind(id).bind(service).bind(digest).bind(now_secs()).execute(self.0.pool()).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(JobError::new(
                "asset_set_changed",
                "本机素材快照已变化或到期",
            ));
        }
        Ok(())
    }
    pub(crate) async fn digest(&self, id: &str, service: &str) -> Result<String> {
        sqlx::query_scalar("SELECT digest FROM ai_asset_sets WHERE asset_set_id=? AND service_identity=? AND expires_at>? AND job_id IS NULL").bind(id).bind(service).bind(now_secs()).fetch_optional(self.0.pool()).await.map_err(db)?.ok_or_else(||JobError::new("asset_set_unavailable","本机素材快照已变化或到期"))
    }
    pub(crate) async fn begin_submission(
        &self,
        id: &str,
        service: &str,
        quote: &str,
        request: &str,
    ) -> Result<()> {
        let mut tx = self
            .0
            .pool()
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(db)?;
        Self::check_references(&mut tx, id).await?;
        let changed=sqlx::query("UPDATE ai_asset_sets SET expires_at=? WHERE asset_set_id=? AND service_identity=? AND quote_id=? AND request_id=? AND expires_at>? AND job_id IS NULL")
   .bind(now_secs()+86400).bind(id).bind(service).bind(quote).bind(request).bind(now_secs()).execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(JobError::new(
                "asset_set_changed",
                "选定素材已变化或到期，请重新选择并报价",
            ));
        }
        tx.commit().await.map_err(db)?;
        self.0.ai_receipts_changed.notify_one();
        Ok(())
    }
    async fn check_references(conn: &mut sqlx::SqliteConnection, id: &str) -> Result<()> {
        let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM ai_asset_references WHERE asset_set_id=?) AND NOT EXISTS(SELECT 1 FROM ai_asset_references r WHERE r.asset_set_id=? AND NOT EXISTS(SELECT 1 FROM versions v JOIN packages p ON p.package_hash=v.package_hash WHERE v.work_key=r.work_key AND v.package_hash=r.package_hash AND p.state='installed'))")
   .bind(id).bind(id).fetch_one(conn).await.map_err(db)?;
        if !valid {
            return Err(JobError::new(
                "asset_set_changed",
                "选定素材版本已被移除，请重新选择并报价",
            ));
        }
        Ok(())
    }
    pub(crate) async fn bind_job(&self, quote: &str, request: &str, job: &str) -> Result<()> {
        let mut tx = self
            .0
            .pool()
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(db)?;
        let id:Option<String>=sqlx::query_scalar("SELECT asset_set_id FROM ai_asset_sets WHERE quote_id=? AND request_id=? AND expires_at>? AND (job_id IS NULL OR job_id=?)")
   .bind(quote).bind(request).bind(now_secs()).bind(job).fetch_optional(&mut *tx).await.map_err(db)?;
        let id = id.ok_or_else(|| {
            JobError::new("asset_set_changed", "本机素材快照已到期或不属于此任务")
        })?;
        Self::check_references(&mut tx, &id).await?;
        let changed=sqlx::query("UPDATE ai_asset_sets SET job_id=? WHERE asset_set_id=? AND expires_at>? AND (job_id IS NULL OR job_id=?)")
   .bind(job).bind(id).bind(now_secs()).bind(job).execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(JobError::new("asset_set_changed", "本机素材快照已变化"));
        }
        tx.commit().await.map_err(db)?;
        Ok(())
    }
    pub(crate) async fn release_terminal(&self, service: &str, job: &str) -> Result<()> {
        sqlx::query("DELETE FROM ai_asset_sets WHERE service_identity=? AND job_id=? AND NOT EXISTS(SELECT 1 FROM ai_receipts r WHERE r.service_owner=ai_asset_sets.service_identity AND r.job_id=ai_asset_sets.job_id AND r.state IN ('preparing','failed','previewReady','saving','saved'))")
   .bind(service).bind(job).execute(self.0.pool()).await.map_err(db)?;
        self.0.ai_receipts_changed.notify_one();
        Ok(())
    }
    pub(crate) async fn release_pending(
        &self,
        id: &str,
        service: &str,
        quote: &str,
        request: &str,
    ) -> Result<()> {
        sqlx::query("DELETE FROM ai_asset_sets WHERE asset_set_id=? AND service_identity=? AND quote_id=? AND request_id=? AND job_id IS NULL")
   .bind(id).bind(service).bind(quote).bind(request).execute(self.0.pool()).await.map_err(db)?;
        self.0.ai_receipts_changed.notify_one();
        Ok(())
    }
    pub(crate) async fn by_job(&self, service: &str, job: &str) -> Result<Snapshot> {
        let row:Option<(String,String)>=sqlx::query_as("SELECT metadata_json,selections_json FROM ai_asset_sets WHERE service_identity=? AND job_id=? AND expires_at>?").bind(service).bind(job).bind(now_secs()).fetch_optional(self.0.pool()).await.map_err(db)?;
        let (metadata, frozen) = row.ok_or_else(|| {
            JobError::new(
                "asset_set_unavailable",
                "本机冻结素材映射已到期或不属于此任务",
            )
        })?;
        Snapshot::from_local(&metadata, &frozen)
    }
}
fn metadata_for(
    assets: &AssetStore,
    package: &StagedPackage,
    asset: &hertz_wallpaper::AssetDescriptor,
) -> Result<(Option<u32>, Option<u32>, Option<u64>)> {
    if !matches!(
        asset.kind,
        hertz_wallpaper::AssetKind::Image
            | hertz_wallpaper::AssetKind::Video
            | hertz_wallpaper::AssetKind::Texture
    ) {
        return Ok((None, None, None));
    }
    let pin = assets.pin_package_entry(package, &asset.source, &AtomicBool::new(false))?;
    let mut file = super::assets::open_immutable(&pin.path)?;
    if asset.kind == hertz_wallpaper::AssetKind::Texture
        && pin.entry.mime.as_deref() == Some("image/ktx2")
    {
        let metadata = hertz_wallpaper::texture_container::inspect_ktx2(file, pin.entry.bytes)
            .map_err(invalid)?;
        return Ok((Some(metadata.width), Some(metadata.height), None));
    }
    let metadata = super::media::probe(&mut file).map_err(invalid)?;
    if (asset.kind != hertz_wallpaper::AssetKind::Video)
        != (metadata.container == super::media::Container::Image)
    {
        return Err(invalid("素材kind与实际容器不符"));
    }
    let mime = match metadata.container {
        super::media::Container::Image => format!("image/{}", metadata.codec),
        super::media::Container::Mp4 => "video/mp4".into(),
        super::media::Container::Webm => "video/webm".into(),
    };
    if pin.entry.mime.as_deref() != Some(mime.as_str()) {
        return Err(invalid("素材MIME与实际容器不符"));
    }
    Ok((
        Some(metadata.display_width),
        Some(metadata.display_height),
        if asset.kind == hertz_wallpaper::AssetKind::Video {
            metadata.duration_ms
        } else {
            None
        },
    ))
}
fn rights(package: &StagedPackage, authored: bool, confirmed: bool) -> Value {
    let license = package.manifest.license.assets.as_str();
    let allowed = matches!(
        license,
        "CC0-1.0" | "CC-BY-4.0" | "CC-BY-SA-4.0" | "MIT" | "OFL-1.1"
    );
    let declared = license == "none";
    let denied = license.contains("-ND-");
    let eligible = !denied && (allowed || authored || declared);
    let basis = if authored {
        "local-authorship"
    } else if allowed {
        "adaptable-license"
    } else if declared && confirmed {
        "user-rights-confirmation"
    } else if declared {
        "requires-user-confirmation"
    } else {
        "unsupported-license"
    };
    json!({"eligible":eligible,"basis":basis,"explanation":if denied{"此许可禁止改编"}else if authored{"本机创作；保存保留原素材许可与署名"}else if allowed{"许可允许改编；保存保留署名与许可"}else if declared{"提交前需确认已拥有素材改编与再发布权"}else{"尚未支持此许可；不能通过确认覆盖许可限制"}})
}
impl Snapshot {
    fn local_json(&self) -> Result<String> {
        serde_json::to_string(&LocalSnapshot {
            selections: self.frozen.clone(),
            packages: self.packages.clone(),
        })
        .map_err(invalid)
    }
    fn from_local(metadata: &str, local: &str) -> Result<Self> {
        let metadata: AssetSet = serde_json::from_str(metadata).map_err(db)?;
        metadata.validate().map_err(invalid)?;
        let stored = if local.trim_start().starts_with('[') {
            // Explicitly normalize development snapshots with repeated inventories.
            let old: Vec<LegacyFrozen> = serde_json::from_str(local).map_err(db)?;
            let mut selections = Vec::new();
            let mut packages = std::collections::BTreeMap::new();
            for item in old {
                let package = FrozenPackage {
                    entries: item.entries,
                    license: item.license,
                    attribution: item.attribution,
                };
                if let Some(prior) = packages.get(&item.selection.package_hash) {
                    if serde_json::to_value(prior).map_err(db)?
                        != serde_json::to_value(&package).map_err(db)?
                    {
                        return Err(invalid("旧快照重复包事实不符"));
                    }
                } else {
                    packages.insert(item.selection.package_hash.clone(), package);
                }
                selections.push(Frozen {
                    alias: item.alias,
                    selection: item.selection,
                    kind: item.kind,
                    rights_basis: item.rights_basis,
                });
            }
            LocalSnapshot {
                selections,
                packages,
            }
        } else {
            serde_json::from_str::<LocalSnapshot>(local).map_err(db)?
        };
        if stored.selections.len() != metadata.assets.len()
            || stored.packages.is_empty()
            || stored.packages.len() > 32
        {
            return Err(invalid("本机素材快照结构无效"));
        }
        for (selection, asset) in stored.selections.iter().zip(&metadata.assets) {
            if selection.alias != asset.alias
                || selection.kind != asset.kind
                || !stored
                    .packages
                    .contains_key(&selection.selection.package_hash)
            {
                return Err(invalid("本机素材映射与metadata不符"));
            }
        }
        Ok(Self {
            metadata,
            frozen: stored.selections,
            packages: stored.packages,
        })
    }
    pub(crate) fn resources(&self) -> Vec<Resource> {
        self.frozen
            .iter()
            .map(|f| Resource {
                asset_id: f.alias.clone(),
                kind: f.kind,
                work_key: f.selection.work_key.clone(),
                package_hash: f.selection.package_hash.clone(),
                source_asset_id: f.selection.asset_id.clone(),
                candidate_id: None,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallpaper::{library::tempfileish, work_drafts::install_composition_test_source};
    #[tokio::test]
    async fn thirty_two_same_package_selections_share_one_explicit_inventory_and_restart_mapping() {
        let root = tempfileish::temp_dir("asset-set-thirty-two");
        let library = Library::open(root.path()).await.unwrap();
        let assets = AssetStore::new(root.path()).unwrap();
        let (work, hash, _) = install_composition_test_source(&library, &assets, false, 32).await;
        let sets = AiAssetSets(&library);
        let selected = (0..32)
            .map(|index| Selection {
                work_key: work.clone(),
                package_hash: hash.clone(),
                asset_id: format!("pixel-{index}"),
            })
            .collect();
        let snapshot = sets.freeze(&assets, selected, true).await.unwrap();
        assert_eq!(snapshot.metadata.assets.len(), 32);
        assert_eq!(snapshot.packages.len(), 1);
        let local = snapshot.local_json().unwrap();
        assert!(local.len() < 131072);
        let value: Value = serde_json::from_str(&local).unwrap();
        assert_eq!(value["packages"].as_object().unwrap().len(), 1);
        assert_eq!(value["selections"].as_array().unwrap().len(), 32);
        let rebuilt =
            Snapshot::from_local(&serde_json::to_string(&snapshot.metadata).unwrap(), &local)
                .unwrap();
        assert_eq!(rebuilt.resources(), snapshot.resources());
        let package = assets.read_installed_manifest(&hash).unwrap();
        let texture = hertz_wallpaper::AssetDescriptor {
            id: "texture".into(),
            kind: hertz_wallpaper::AssetKind::Texture,
            source: package.manifest.assets[0].source.clone(),
            variants: vec![],
        };
        assert_eq!(
            metadata_for(&assets, &package, &texture).unwrap(),
            (Some(1), Some(1), None)
        );
        let digest = snapshot.metadata.digest().unwrap();
        let response = json!({"assetSetId":"set-thirty-two","digest":digest,"assetCount":32,"expiresAt":(now_secs()+300)*1000});
        sets.insert(&snapshot, "service", &response, || Ok(()))
            .await
            .unwrap();
        sets.bind_quote(
            "set-thirty-two",
            "service",
            &digest,
            "quote-32",
            "request-32",
        )
        .await
        .unwrap();
        sets.begin_submission("set-thirty-two", "service", "quote-32", "request-32")
            .await
            .unwrap();
        sets.bind_job("quote-32", "request-32", "job-32")
            .await
            .unwrap();
        library.pool().close().await;
        drop(library);
        let reopened = Library::open(root.path()).await.unwrap();
        let restored = AiAssetSets(&reopened)
            .by_job("service", "job-32")
            .await
            .unwrap();
        assert_eq!(restored.resources(), snapshot.resources());
        assert_eq!(restored.packages.len(), 1);
        reopened.pool().close().await;
    }
    #[tokio::test]
    async fn asset_pages_reach_versions_after_five_hundred_without_probing_the_whole_library() {
        let root = tempfileish::temp_dir("asset-pages-beyond-five-hundred");
        let library = Library::open(root.path()).await.unwrap();
        let assets = AssetStore::new(root.path()).unwrap();
        let (_, hash, _) = install_composition_test_source(&library, &assets, false, 1).await;
        let mut tx = library.pool().begin().await.unwrap();
        for index in 0..505 {
            let work = format!("local-page-{index:04}");
            sqlx::query("INSERT INTO works(work_key,source_id,title,kind,created_at,updated_at) VALUES(?,'local','Page fixture','image',1,1)").bind(&work).execute(&mut *tx).await.unwrap();
            sqlx::query("INSERT INTO versions(version_key,work_key,version,package_hash,created_at) VALUES(?,?,1,?,1)").bind(format!("{work}@1")).bind(work).bind(&hash).execute(&mut *tx).await.unwrap();
        }
        tx.commit().await.unwrap();
        let sets = AiAssetSets(&library);
        let mut cursor = None;
        let mut seen = BTreeSet::new();
        loop {
            let page = sets.list(&assets, 20, cursor.as_deref()).await.unwrap();
            let items = page["assets"].as_array().unwrap();
            assert!(items.len() <= 20);
            for item in items {
                assert!(seen.insert(item["workKey"].as_str().unwrap().to_owned()));
            }
            cursor = page["nextCursor"].as_str().map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(seen.len(), 506);
        assert!(seen.contains("local-page-0504"));
        library.pool().close().await;
    }
}
