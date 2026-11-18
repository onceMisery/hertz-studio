// SPDX-License-Identifier: MIT
//! Composition candidate receipts retain the original AI publication identity.
use super::super::{assets::StagedPackage, jobs::ImportJobs};
use super::*;
use std::sync::{atomic::AtomicBool, Arc};
impl AiReceipts<'_> {
    pub(crate) async fn existing_job(&self, job: &str) -> Result<Option<Value>> {
        let id:Option<String>=sqlx::query_scalar("SELECT receipt_id FROM ai_receipts WHERE job_id=? AND state IN ('preparing','failed','previewReady','saving','saved')").bind(job).fetch_optional(self.0.pool()).await.map_err(database)?;
        match id {
            Some(id) => self.get(&id).await.map(Some),
            None => Ok(None),
        }
    }
    pub(crate) async fn receive_composition<F, G>(
        &self,
        received: ReceivedBuiltin,
        id: &str,
        package: &StagedPackage,
        document: &Document,
        bytes: u64,
        authority: F,
    ) -> Result<Value>
    where
        F: FnOnce() -> Result<G>,
    {
        use sha2::{Digest, Sha256};
        received
            .artifact
            .validate()
            .map_err(|e| JobError::new(e.code, e.message))?;
        if received.artifact.kind
            != hertz_wallpaper::generation::WallpaperGenerationKind::Composition
            || received.bytes.len() as u64 != received.artifact.bytes
            || format!("{:x}", Sha256::digest(&received.bytes)) != received.artifact.sha256
            || document.composition.is_none()
            || package.manifest.work_id != id.strip_prefix("work-ai-").unwrap_or("")
        {
            return Err(JobError::new("ai_output_rejected", "组合包与来源身份不符"));
        }
        let expiry = received
            .artifact
            .expires_at
            .parse::<i64>()
            .map_err(|_| JobError::invalid_input("组合期限无效"))?
            / 1000;
        let mut tx = self
            .0
            .pool()
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database)?;
        Self::expire_in(&mut tx).await?;
        let count:i64=sqlx::query_scalar("SELECT COUNT(*) FROM ai_receipts WHERE state IN ('preparing','failed','previewReady','saving')").fetch_one(&mut *tx).await.map_err(database)?;
        super::super::ai_receipt_budget::ensure_room(
            &mut tx,
            super::super::ai_receipt_budget::Reservation::Candidate,
        )
        .await?;
        if count >= 8 || expiry <= now_secs() || expiry > now_secs() + 86400 {
            return Err(JobError::new(
                "candidate_capacity_exceeded",
                "组合候选数量或期限超限",
            ));
        }
        let json =
            serde_json::to_string(document).map_err(|e| JobError::invalid_input(e.to_string()))?;
        let metadata = serde_json::to_string(&received.artifact)
            .map_err(|e| JobError::invalid_input(e.to_string()))?;
        sqlx::query("INSERT INTO ai_receipts(receipt_id,service_owner,job_id,artifact_id,output_hash,state,metadata_json,document_json,provider,model,received_at,expires_at,kind,candidate_package_hash,candidate_bytes) VALUES(?,?,?,?,?,'preparing',?,?,?,?,?,?,'composition',?,?)")
        .bind(id).bind(received.service_owner).bind(received.artifact.job_id).bind(received.artifact.artifact_id).bind(received.artifact.sha256).bind(metadata).bind(json).bind(received.provider).bind(received.model).bind(now_secs()).bind(expiry).bind(&package.package_hash).bind(bytes as i64).execute(&mut *tx).await.map_err(database)?;
        let permit = authority()?;
        tx.commit().await.map_err(database)?;
        drop(permit);
        self.0.ai_receipts_changed.notify_one();
        self.get(id).await
    }
    pub(crate) async fn prepare_composition(
        &self,
        id: &str,
        jobs: Arc<ImportJobs>,
    ) -> Result<Value> {
        let row = self.row(id).await?;
        if row.kind != "composition" || row.state != "preparing" {
            return self.get(id).await;
        }
        if row.expires_at <= now_secs() {
            self.expire().await?;
            return self.get(id).await;
        }
        match self.prepare_composition_inner(id, jobs, row).await {
            Ok(value) => Ok(value),
            Err(error) => {
                self.preparation_failed(id, &error).await?;
                self.get(id).await
            }
        }
    }
    pub(crate) async fn preparation_failed(&self, id: &str, error: &JobError) -> Result<()> {
        let diagnostics = json!({"code":error.code,"message":error.message.chars().take(1024).collect::<String>()}).to_string();
        let mut tx = self
            .0
            .pool()
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database)?;
        Self::expire_in(&mut tx).await?;
        sqlx::query("UPDATE ai_receipts SET state='failed',diagnostics_json=? WHERE receipt_id=? AND kind='composition' AND state='preparing' AND draft_id IS NULL AND expires_at>?")
        .bind(diagnostics).bind(id).bind(now_secs()).execute(&mut *tx).await.map_err(database)?;
        tx.commit().await.map_err(database)?;
        self.0.ai_receipts_changed.notify_one();
        Ok(())
    }
    pub(crate) async fn retry_composition(&self, id: &str) -> Result<Value> {
        let changed=sqlx::query("UPDATE ai_receipts SET state='preparing',diagnostics_json=NULL WHERE receipt_id=? AND kind='composition' AND state='failed' AND draft_id IS NULL AND expires_at>?")
        .bind(id).bind(now_secs()).execute(self.0.pool()).await.map_err(database)?.rows_affected();
        if changed != 1 {
            return Err(JobError::new(
                "candidate_changed",
                "候选已变化或到期；已有草稿请使用编辑入口",
            ));
        }
        self.0.ai_receipts_changed.notify_one();
        self.get(id).await
    }
    async fn prepare_composition_inner(
        &self,
        id: &str,
        jobs: Arc<ImportJobs>,
        row: Row,
    ) -> Result<Value> {
        let document: Document =
            serde_json::from_str(row.document_json.as_deref().unwrap_or(""))
                .map_err(|_| JobError::new("ai_output_rejected", "组合候选文档无效"))?;
        let package = jobs
            .assets()
            .read_candidate(id, row.candidate_package_hash.as_deref().unwrap_or(""))?;
        let mut monitor = crate::native::wallpaper_monitors()
            .into_iter()
            .find(|m| m.primary);
        if let Some(m) = &mut monitor {
            m.width = 640;
            m.height = 360;
        }
        let target = super::super::image_prepare::ImageTarget {
            width: 640,
            height: 360,
            fit: super::super::image_prepare::ImageFit::Contain,
            purpose: super::super::image_prepare::ImagePurpose::Preview,
        };
        let facts = monitor.as_ref().map(|m| {
            super::super::builtin_plan::TargetFacts::from_monitor(
                m,
                &super::super::config::WallpaperConfig::default(),
                target.purpose,
            )
        });
        let refresh = monitor.as_ref().map_or(60, |m| m.refresh_hz);
        let prepared = super::super::composition_plan::resolve_source(
            jobs,
            package,
            Default::default(),
            target,
            super::super::config::Fit::Contain,
            facts,
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .and_then(|p| {
            let plan = p.gl_plan(
                super::super::budget::OwnerKind::Preview,
                format!("candidate-{id}"),
                1,
                refresh,
                15,
            )?;
            super::super::budget::global()
                .check_session_plan(&plan.session)
                .map_err(|e| JobError::new("budget_exceeded", e.message.to_string()))?;
            Ok(p)
        });
        let result_state = if prepared.is_ok() {
            "previewReady"
        } else {
            "failed"
        };
        let diagnostics=prepared.as_ref().err().map(|e|serde_json::json!({"code":e.code,"message":e.message.chars().take(1024).collect::<String>()})).map(|v|v.to_string());
        drop(prepared);
        WorkDrafts::new(self.0)
            .create_prepared_ai(document, id, result_state, diagnostics.as_deref())
            .await?;
        self.0.ai_receipts_changed.notify_one();
        self.get(id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallpaper::{assets::AssetStore, library::tempfileish};

    fn document() -> Document {
        serde_json::from_value(json!({"title":"Composition lifecycle","composition":{"documentVersion":1,"canvas":{"width":640,"height":360,"colorSpace":"srgb","background":"#000000"},"nodes":[],"effects":[],"timeline":{"durationSeconds":1.0,"loop":true,"tracks":[]},"bindings":[]}})).unwrap()
    }

    async fn seed(library: &Library, index: usize, state: &str) -> String {
        let id = format!("work-ai-{}", uuid::Uuid::new_v4());
        sqlx::query("INSERT INTO ai_receipts(receipt_id,service_owner,job_id,artifact_id,output_hash,state,metadata_json,document_json,provider,model,received_at,expires_at,kind,candidate_package_hash,candidate_bytes) VALUES(?,'owner',?,?,?,?,'{}',?,'fake','fixture',1,?,'composition',?,3)")
            .bind(&id).bind(format!("job-{index}")).bind(format!("artifact-{index}")).bind("a".repeat(64)).bind(state)
            .bind(serde_json::to_string(&document()).unwrap()).bind(now_secs()+3600).bind("b".repeat(64)).execute(library.pool()).await.unwrap();
        sqlx::query("INSERT INTO ai_asset_sets(asset_set_id,service_identity,digest,metadata_json,selections_json,job_id,created_at,expires_at) VALUES(?,'owner',?,'{}','[]',?,1,?)")
            .bind(format!("set-{index}")).bind("c".repeat(64)).bind(format!("job-{index}")).bind(now_secs()+3600).execute(library.pool()).await.unwrap();
        id
    }

    async fn linked_draft(library: &Library, id: &str) -> String {
        let draft = WorkDrafts::new(library)
            .create_ai(document(), id)
            .await
            .unwrap();
        sqlx::query("INSERT INTO draft_resource_references(draft_id,work_key,package_hash,candidate_id) VALUES(?,'local-source',?,?)")
            .bind(&draft.id).bind("b".repeat(64)).bind(id).execute(library.pool()).await.unwrap();
        draft.id
    }

    #[tokio::test]
    async fn composition_preparation_errors_reach_a_bounded_failed_state() {
        let root = tempfileish::temp_dir("composition-prepare-failure");
        let library = Library::open(root.path()).await.unwrap();
        let jobs = Arc::new(ImportJobs::start(
            library,
            AssetStore::new(root.path()).unwrap(),
            crate::wallpaper::decode_probe::ProbeClient::testing(|_, _| Box::pin(async { Ok(()) })),
        ));
        let receipts = AiReceipts::new(jobs.library());
        for index in 0..2 {
            let id = seed(jobs.library(), index, "preparing").await;
            if index == 0 {
                sqlx::query("UPDATE ai_receipts SET document_json='invalid' WHERE receipt_id=?")
                    .bind(&id)
                    .execute(jobs.library().pool())
                    .await
                    .unwrap();
            }
            let result = receipts
                .prepare_composition(&id, Arc::clone(&jobs))
                .await
                .unwrap();
            assert_eq!(result["state"], "failed");
            assert!(result["diagnostics"]["code"].is_string());
            assert!(result["diagnostics"]["message"].as_str().unwrap().len() <= 4096);
            assert_eq!(
                receipts
                    .prepare_composition(&id, Arc::clone(&jobs))
                    .await
                    .unwrap(),
                result
            );
            assert_eq!(
                receipts.retry_composition(&id).await.unwrap()["state"],
                "preparing"
            );
            receipts
                .preparation_failed(&id, &JobError::new("draft_limit", "请先丢弃不需要的草稿"))
                .await
                .unwrap();
            assert_eq!(
                receipts.get(&id).await.unwrap()["diagnostics"]["code"],
                "draft_limit"
            );
            receipts.delete(&id).await.unwrap();
            assert!(receipts.retry_composition(&id).await.is_err());
            assert_eq!(receipts.get(&id).await.unwrap()["state"], "deleted");
        }
        jobs.library().pool().close().await;
    }

    #[tokio::test]
    async fn composition_candidate_delete_releases_uncommitted_drafts_and_snapshots() {
        let root = tempfileish::temp_dir("composition-delete-lifecycle");
        let library = Library::open(root.path()).await.unwrap();
        let receipts = AiReceipts::new(&library);
        let assets = AssetStore::new(root.path()).unwrap();
        for (index, state) in ["preparing", "failed", "previewReady"].iter().enumerate() {
            let id = seed(&library, index, state).await;
            let draft = if *state == "preparing" {
                None
            } else {
                Some(linked_draft(&library, &id).await)
            };
            let directory = assets.candidate_dir(&id).unwrap();
            std::fs::create_dir(&directory).unwrap();
            let path = directory.join("original.hwpkg");
            std::fs::write(&path, b"zip").unwrap();
            let reader = crate::wallpaper::assets::open_immutable(&path).unwrap();
            receipts.delete(&id).await.unwrap();
            assert_eq!(receipts.get(&id).await.unwrap()["state"], "deleted");
            if let Some(draft) = draft {
                assert!(WorkDrafts::new(&library).get(&draft).await.is_err());
            }
            let counts: (i64, i64) = sqlx::query_as("SELECT (SELECT COUNT(*) FROM draft_resource_references),(SELECT COUNT(*) FROM ai_asset_sets)").fetch_one(library.pool()).await.unwrap();
            assert_eq!(counts, (0, 0));
            #[cfg(windows)]
            {
                assert!(receipts.maintenance_files(&assets).await.unwrap().is_some());
                assert!(path.exists());
                assert_eq!(receipts.get(&id).await.unwrap()["candidateBytes"], 3);
            }
            drop(reader);
            receipts.maintenance_files(&assets).await.unwrap();
            assert!(!directory.exists());
            assert_eq!(receipts.get(&id).await.unwrap()["candidateBytes"], 0);
        }
        library.pool().close().await;
    }

    #[tokio::test]
    async fn composition_expiry_cleans_temporary_drafts_but_preserves_committed_ownership() {
        let root = tempfileish::temp_dir("composition-expiry-lifecycle");
        let library = Library::open(root.path()).await.unwrap();
        let receipts = AiReceipts::new(&library);
        for (index, state) in ["preparing", "failed", "previewReady"].iter().enumerate() {
            let id = seed(&library, index, state).await;
            let draft = if *state == "preparing" {
                None
            } else {
                Some(linked_draft(&library, &id).await)
            };
            sqlx::query("UPDATE ai_receipts SET expires_at=0 WHERE receipt_id=?")
                .bind(&id)
                .execute(library.pool())
                .await
                .unwrap();
            receipts.expire().await.unwrap();
            assert_eq!(receipts.get(&id).await.unwrap()["state"], "expired");
            if let Some(draft) = draft {
                assert!(WorkDrafts::new(&library).get(&draft).await.is_err());
            }
        }
        let id = seed(&library, 3, "previewReady").await;
        let draft = linked_draft(&library, &id).await;
        WorkDrafts::new(&library).save(&draft, 1).await.unwrap();
        sqlx::query("UPDATE ai_receipts SET expires_at=0 WHERE receipt_id=?")
            .bind(&id)
            .execute(library.pool())
            .await
            .unwrap();
        receipts.expire().await.unwrap();
        assert_eq!(receipts.get(&id).await.unwrap()["state"], "saving");
        assert_eq!(
            WorkDrafts::new(&library)
                .get(&draft)
                .await
                .unwrap()
                .saved_revision,
            Some(1)
        );
        assert_eq!(
            receipts.delete(&id).await.unwrap_err().code,
            "candidate_saved"
        );
        library.pool().close().await;
    }
}
