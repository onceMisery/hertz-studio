// SPDX-License-Identifier: MIT
//! Local candidates and save receipts. Config, installer and preview retain their owners.
use super::{
    generation::receive::ReceivedBuiltin,
    jobs::JobError,
    library::{now_secs, Library},
    work_drafts::{Document, WorkDrafts},
};
use serde_json::{json, Value};
type Result<T> = std::result::Result<T, JobError>;
fn database(e: sqlx::Error) -> JobError {
    JobError::database(e.to_string())
}

#[derive(sqlx::FromRow)]
struct Row {
    receipt_id: String,
    state: String,
    metadata_json: String,
    document_json: Option<String>,
    expires_at: i64,
    draft_id: Option<String>,
    work_key: Option<String>,
    package_hash: Option<String>,
    kind: String,
    image_work_id: Option<String>,
    candidate_package_hash: Option<String>,
    candidate_bytes: i64,
    save_title: Option<String>,
    pending_package_hash: Option<String>,
    thumbnail_json: Option<String>,
}
pub(crate) enum PreviewSource {
    Builtin(Document),
    Image(String),
}
#[path = "ai_receipts_image.rs"]
mod image;
pub(crate) use image::ImageReception;
pub(crate) struct AiReceipts<'a>(&'a Library);
impl<'a> AiReceipts<'a> {
    pub(crate) fn new(library: &'a Library) -> Self {
        Self(library)
    }
    async fn row(&self, id: &str) -> Result<Row> {
        sqlx::query_as::<_, Row>("SELECT * FROM ai_receipts WHERE receipt_id=?")
            .bind(id)
            .fetch_optional(self.0.pool())
            .await
            .map_err(database)?
            .ok_or_else(|| JobError::new("candidate_not_found", "候选不存在"))
    }
    pub(crate) async fn get(&self, id: &str) -> Result<Value> {
        Ok(view(&self.row(id).await?))
    }
    pub(crate) async fn list(&self) -> Result<Value> {
        self.expire().await?;
        let rows:Vec<Row>=sqlx::query_as("SELECT * FROM ai_receipts WHERE state IN ('previewReady','saving','saved') ORDER BY state='saved',received_at DESC LIMIT 16")
            .fetch_all(self.0.pool()).await.map_err(database)?;
        Ok(json!({"candidates":rows.iter().map(view).collect::<Vec<_>>()}))
    }
    pub(crate) async fn expire(&self) -> Result<()> {
        sqlx::query("UPDATE ai_receipts SET state='expired',document_json=NULL WHERE state='previewReady' AND expires_at<=?")
            .bind(now_secs()).execute(self.0.pool()).await.map_err(database)?;
        Ok(())
    }
    pub(crate) async fn maintenance(&self) -> Result<Option<i64>> {
        self.expire().await?;
        sqlx::query_scalar("SELECT MIN(expires_at) FROM ai_receipts WHERE state='previewReady'")
            .fetch_one(self.0.pool())
            .await
            .map_err(database)
    }
    pub(crate) async fn receive<F, G>(
        &self,
        input: ReceivedBuiltin,
        commit_authority: F,
    ) -> Result<Value>
    where
        F: FnOnce() -> Result<G>,
    {
        let bytes = serde_json::to_vec(&input.artifact)
            .map_err(|e| JobError::invalid_input(e.to_string()))?;
        input
            .artifact
            .validate()
            .map_err(|e| JobError::new(e.code, e.message))?;
        use sha2::{Digest, Sha256};
        if input.artifact.bytes != input.bytes.len() as u64
            || input.artifact.sha256 != format!("{:x}", Sha256::digest(&input.bytes))
            || input.artifact.registry_hash != hertz_wallpaper::catalog().registry_hash
            || input.artifact.kind != hertz_wallpaper::generation::WallpaperGenerationKind::Builtin
            || [&input.service_owner, &input.provider, &input.model]
                .iter()
                .any(|s| s.is_empty() || s.len() > 128 || s.chars().any(char::is_control))
        {
            return Err(JobError::new(
                "ai_output_rejected",
                "候选字节或目录事实不符",
            ));
        }
        let output = hertz_wallpaper::generation::BuiltinSceneOutput::parse(&input.bytes)
            .map_err(|e| JobError::new(e.code, e.message))?;
        let document = Document {
            title: format!("AI 壁纸 · {}", output.scene_id),
            description: String::new(),
            scene_id: output.scene_id,
            state_version: output.state_version,
            params: output.params,
            properties: vec![],
        };
        // Reuse the exact work-document validation before permitting preview.
        document.effective_builtin()?;
        let expiry = input
            .artifact
            .expires_at
            .parse::<i64>()
            .map_err(|_| JobError::new("ai_artifact_expired", "候选期限无效"))?
            / 1000;
        let mut tx = self
            .0
            .pool()
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database)?;
        let existing:Option<String>=sqlx::query_scalar("SELECT receipt_id FROM ai_receipts WHERE service_owner=? AND job_id=? AND artifact_id=? AND output_hash=?")
            .bind(&input.service_owner).bind(&input.artifact.job_id).bind(&input.artifact.artifact_id).bind(&input.artifact.sha256)
            .fetch_optional(&mut *tx).await.map_err(database)?;
        if let Some(id) = existing {
            tx.commit().await.map_err(database)?;
            return self.get(&id).await;
        }
        if expiry <= now_secs() {
            return Err(JobError::new("ai_artifact_expired", "候选已到期"));
        }
        // Receipts are bounded metadata. Keep terminal identities for replay,
        // refusing new admissions rather than erasing a saved identity.
        let records: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_receipts")
            .fetch_one(&mut *tx)
            .await
            .map_err(database)?;
        if records >= 500 {
            return Err(JobError::new(
                "candidate_capacity_exceeded",
                "候选历史已达上限",
            ));
        }
        sqlx::query("UPDATE ai_receipts SET state='expired',document_json=NULL WHERE state='previewReady' AND expires_at<=?")
            .bind(now_secs()).execute(&mut *tx).await.map_err(database)?;
        let (count,size):(i64,i64)=sqlx::query_as("SELECT COALESCE(SUM(state IN ('previewReady','saving')),0),COALESCE(SUM(candidate_bytes+CASE WHEN state IN ('previewReady','saving') THEN COALESCE(length(CAST(document_json AS BLOB)),0) ELSE 0 END),0) FROM ai_receipts")
            .fetch_one(&mut *tx).await.map_err(database)?;
        let document_json =
            serde_json::to_string(&document).map_err(|e| JobError::invalid_input(e.to_string()))?;
        if count >= 8 || size.saturating_add(document_json.len() as i64) > 256 * 1024 * 1024 {
            return Err(JobError::new(
                "candidate_capacity_exceeded",
                "最多保留八份未保存候选，请先保存或删除",
            ));
        }
        let id = format!("work-ai-{}", uuid::Uuid::new_v4());
        sqlx::query("INSERT INTO ai_receipts(receipt_id,service_owner,job_id,artifact_id,output_hash,state,metadata_json,document_json,provider,model,received_at,expires_at) VALUES(?,?,?,?,?,'previewReady',?,?,?,?,?,?)")
            .bind(&id).bind(&input.service_owner).bind(&input.artifact.job_id).bind(&input.artifact.artifact_id).bind(&input.artifact.sha256)
            .bind(String::from_utf8(bytes).map_err(|_|JobError::invalid_input("候选信封编码无效"))?).bind(document_json)
            .bind(input.provider).bind(input.model).bind(now_secs()).bind(expiry.min(now_secs()+86400))
            .execute(&mut *tx).await.map_err(database)?;
        // The lifecycle permit is acquired after any SQLite wait and held
        // until the commit exits. Cancellation before this point rejects the
        // new row; a committed receipt keeps success even if cancelled later.
        let permit = commit_authority()?;
        tx.commit().await.map_err(database)?;
        drop(permit);
        self.0.ai_receipts_changed.notify_one();
        self.get(&id).await
    }
    pub(crate) async fn document(&self, id: &str, revision: u64) -> Result<Document> {
        let row = self.row(id).await?;
        if row.kind != "builtin"
            || revision != 1
            || row.state != "previewReady"
            || row.expires_at <= now_secs()
        {
            return Err(JobError::new(
                "ai_artifact_expired",
                "候选已保存、删除或到期，请从作品库打开已保存作品",
            ));
        }
        serde_json::from_str(row.document_json.as_deref().unwrap_or(""))
            .map_err(|_| JobError::new("ai_output_rejected", "候选文档无效"))
    }
    pub(crate) async fn preview_source(&self, id: &str, revision: u64) -> Result<PreviewSource> {
        let row = self.row(id).await?;
        if revision != 1 || row.state != "previewReady" || row.expires_at <= now_secs() {
            return Err(JobError::new("ai_artifact_expired", "候选已变化或到期"));
        }
        if row.kind == "image" {
            Ok(PreviewSource::Image(row.receipt_id))
        } else {
            self.document(id, revision)
                .await
                .map(PreviewSource::Builtin)
        }
    }
    pub(crate) async fn delete(&self, id: &str) -> Result<Value> {
        let row = self.row(id).await?;
        if row.state == "saving" || row.state == "saved" {
            return Err(JobError::new(
                "candidate_saved",
                "候选已转交作品保存，请在作品库管理",
            ));
        }
        let changed = sqlx::query("UPDATE ai_receipts SET state='deleted',document_json=NULL WHERE receipt_id=? AND state IN ('previewReady','expired','deleted')")
            .bind(id).execute(self.0.pool()).await.map_err(database)?.rows_affected();
        if changed != 1 {
            return Err(JobError::new(
                "candidate_changed",
                "候选正在保存，请重新读取回执",
            ));
        }
        self.0.ai_receipts_changed.notify_one();
        Ok(json!({"deleted":true}))
    }
    pub(crate) async fn save(
        &self,
        id: &str,
        title: String,
        assets: &super::assets::AssetStore,
    ) -> Result<Value> {
        let row = self.row(id).await?;
        if row.state == "saved" {
            return Ok(view(&row));
        }
        let drafts = WorkDrafts::new(self.0);
        let draft = if let Some(draft) = row.draft_id {
            drafts.get(&draft).await?
        } else {
            let mut document = self.document(id, 1).await?;
            document.title = title;
            drafts.create_ai(document, id).await?
        };
        self.0.ai_receipts_changed.notify_one();
        if draft.revision != 1 {
            return Err(JobError::new(
                "draft_conflict",
                "已保存草稿被修改，请从作品编辑器继续",
            ));
        }
        if draft.saved_revision != Some(1) {
            drafts.save(&draft.id, 1).await?;
        }
        drafts.publish(&draft.id, 1, assets).await?;
        self.get(id).await
    }
    pub(crate) async fn attach_draft(
        conn: &mut sqlx::SqliteConnection,
        id: &str,
        draft: &str,
    ) -> Result<()> {
        let n=sqlx::query("UPDATE ai_receipts SET state='saving',draft_id=? WHERE receipt_id=? AND state='previewReady' AND expires_at>?")
            .bind(draft).bind(id).bind(now_secs()).execute(conn).await.map_err(database)?.rows_affected();
        if n != 1 {
            return Err(JobError::new(
                "candidate_changed",
                "候选已变化，请重读原保存回执",
            ));
        }
        Ok(())
    }
    pub(crate) async fn finish_publication(
        conn: &mut sqlx::SqliteConnection,
        draft: &str,
        work: &str,
        version: u32,
        hash: &str,
    ) -> Result<()> {
        let record:Option<(String,String,String,i64,String)>=sqlx::query_as("SELECT receipt_id,provider,model,received_at,output_hash FROM ai_receipts WHERE draft_id=? AND state='saving'")
            .bind(draft).fetch_optional(&mut *conn).await.map_err(database)?;
        if let Some((id, provider, model, time, output)) = record {
            sqlx::query("INSERT INTO ai_origins(version_key,provider,model,generated_at,output_hash) VALUES(?,?,?,?,?)")
                .bind(format!("{work}@{version}")).bind(provider).bind(model).bind(time).bind(output).execute(&mut *conn).await.map_err(database)?;
            sqlx::query("UPDATE ai_receipts SET state='saved',work_key=?,package_hash=?,document_json=NULL WHERE receipt_id=?")
                .bind(work).bind(hash).bind(id).execute(conn).await.map_err(database)?;
        }
        Ok(())
    }
}
fn view(row: &Row) -> Value {
    let state = if row.state == "previewReady" && row.expires_at <= now_secs() {
        "expired"
    } else {
        row.state.as_str()
    };
    let scene = row
        .document_json
        .as_deref()
        .and_then(|document| serde_json::from_str::<Document>(document).ok())
        .map(|document| document.scene_id);
    json!({"receiptId":row.receipt_id,"state":state,"kind":row.kind,"title":row.save_title,"candidateBytes":row.candidate_bytes,"sceneId":scene,"draftId":row.receipt_id,"savedDraftId":row.draft_id,"draftRevision":1,
        "artifact":serde_json::from_str::<Value>(&row.metadata_json).unwrap_or(Value::Null),"workKey":row.work_key,"packageHash":row.package_hash,
        "saved":row.state=="saved"})
}

#[cfg(test)]
mod tests {
    use super::super::{assets::AssetStore, library::tempfileish};
    use super::*;
    use hertz_wallpaper::generation::{WallpaperArtifact, WallpaperGenerationKind};
    use sha2::{Digest, Sha256};

    fn input(index: u32) -> ReceivedBuiltin {
        let bytes = serde_json::to_vec(
            &json!({"kind":"builtin","sceneId":"coast","stateVersion":1,"params":{}}),
        )
        .unwrap();
        ReceivedBuiltin {
            artifact: WallpaperArtifact {
                artifact_id: uuid::Uuid::new_v4().to_string(),
                job_id: format!("fixture-{index}"),
                kind: WallpaperGenerationKind::Builtin,
                bytes: bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(&bytes)),
                mime: "application/json".into(),
                registry_hash: hertz_wallpaper::catalog().registry_hash.clone(),
                generation_schema_hash: "b".repeat(64),
                expires_at: ((now_secs() + 3600) * 1000).to_string(),
            },
            service_owner: "fixture-owner".into(),
            provider: "fake".into(),
            model: "fake-v1".into(),
            bytes,
            epoch: 0,
        }
    }

    #[tokio::test]
    async fn receive_save_and_restart_return_the_original_immutable_work() {
        let root = tempfileish::temp_dir("ai-receipt-roundtrip");
        let library = Library::open(root.path()).await.unwrap();
        let assets = AssetStore::new(root.path()).unwrap();
        let receipts = AiReceipts::new(&library);
        let candidate = input(0);
        let artifact = candidate.artifact.clone();
        let first = receipts.receive(candidate, || Ok(())).await.unwrap();
        let mut replay = input(0);
        replay.artifact = artifact;
        assert_eq!(receipts.receive(replay, || Ok(())).await.unwrap(), first);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM drafts")
            .fetch_one(library.pool())
            .await
            .unwrap();
        assert_eq!(
            count, 0,
            "receiving and previewing must not create ordinary drafts"
        );
        let id = first["receiptId"].as_str().unwrap();
        receipts.document(id, 1).await.unwrap();
        let saved = receipts.save(id, "我的海岸".into(), &assets).await.unwrap();
        assert_eq!(saved["state"], "saved");
        let hash = saved["packageHash"].as_str().unwrap();
        assert!(assets.verify_installed(hash).unwrap().is_some());
        assert_eq!(
            receipts
                .save(id, "不能重命名原保存".into(), &assets)
                .await
                .unwrap(),
            saved
        );
        assert_eq!(
            receipts.delete(id).await.unwrap_err().code,
            "candidate_saved"
        );
        let origin: (String, String, String) =
            sqlx::query_as("SELECT provider,model,output_hash FROM ai_origins")
                .fetch_one(library.pool())
                .await
                .unwrap();
        assert_eq!(
            origin,
            (
                "fake".into(),
                "fake-v1".into(),
                first["artifact"]["sha256"].as_str().unwrap().to_owned()
            )
        );
        library.pool().close().await;
        let reopened = Library::open(root.path()).await.unwrap();
        assert_eq!(
            AiReceipts::new(&reopened)
                .save(id, "重开".into(), &assets)
                .await
                .unwrap(),
            saved
        );
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM versions")
            .fetch_one(reopened.pool())
            .await
            .unwrap();
        assert_eq!(count, 1);
        reopened.pool().close().await;
    }

    #[tokio::test]
    async fn maintenance_uses_candidate_deadlines_and_empty_domain_has_no_next_wake() {
        let root = tempfileish::temp_dir("ai-receipt-maintenance");
        let library = Library::open(root.path()).await.unwrap();
        let receipts = AiReceipts::new(&library);
        library.ai_receipts_changed.notified().await;
        assert_eq!(receipts.maintenance().await.unwrap(), None);
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(25),
            library.ai_receipts_changed.notified()
        )
        .await
        .is_err());
        let candidate = input(0);
        let expiry = candidate.artifact.expires_at.parse::<i64>().unwrap() / 1000;
        let candidate = receipts.receive(candidate, || Ok(())).await.unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            library.ai_receipts_changed.notified(),
        )
        .await
        .unwrap();
        assert_eq!(receipts.maintenance().await.unwrap(), Some(expiry));
        receipts
            .delete(candidate["receiptId"].as_str().unwrap())
            .await
            .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            library.ai_receipts_changed.notified(),
        )
        .await
        .unwrap();
        assert_eq!(receipts.maintenance().await.unwrap(), None);
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(25),
            library.ai_receipts_changed.notified()
        )
        .await
        .is_err());
        library.pool().close().await;
    }

    #[tokio::test]
    async fn publication_failure_keeps_one_saved_draft_and_retry_finishes_its_receipt() {
        let root = tempfileish::temp_dir("ai-receipt-failure");
        let library = Library::open(root.path()).await.unwrap();
        let receipts = AiReceipts::new(&library);
        let first = receipts.receive(input(0), || Ok(())).await.unwrap();
        let id = first["receiptId"].as_str().unwrap();
        let tiny = AssetStore::new(root.path())
            .unwrap()
            .with_content_capacity(1);
        assert_eq!(
            receipts
                .save(id, "保留保存意图".into(), &tiny)
                .await
                .unwrap_err()
                .code,
            "library_full"
        );
        assert_eq!(receipts.get(id).await.unwrap()["state"], "saving");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM drafts")
            .fetch_one(library.pool())
            .await
            .unwrap();
        assert_eq!(count, 1);
        let origins: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_origins")
            .fetch_one(library.pool())
            .await
            .unwrap();
        assert_eq!(origins, 0);
        let assets = AssetStore::new(root.path()).unwrap();
        assert_eq!(
            receipts.save(id, "不新建".into(), &assets).await.unwrap()["state"],
            "saved"
        );
        library.pool().close().await;
    }

    #[tokio::test]
    async fn quota_expiry_and_deletion_preserve_receipt_identity() {
        let root = tempfileish::temp_dir("ai-receipt-quota");
        let library = Library::open(root.path()).await.unwrap();
        let receipts = AiReceipts::new(&library);
        let mut first = None;
        for i in 0..8 {
            let row = receipts.receive(input(i), || Ok(())).await.unwrap();
            if i == 0 {
                first = Some(row);
            }
        }
        assert_eq!(
            receipts
                .receive(input(8), || Ok(()))
                .await
                .unwrap_err()
                .code,
            "candidate_capacity_exceeded"
        );
        let id = first.as_ref().unwrap()["receiptId"].as_str().unwrap();
        sqlx::query("UPDATE ai_receipts SET expires_at=0 WHERE receipt_id=?")
            .bind(id)
            .execute(library.pool())
            .await
            .unwrap();
        receipts.expire().await.unwrap();
        assert_eq!(receipts.get(id).await.unwrap()["state"], "expired");
        assert!(receipts.document(id, 1).await.is_err());
        assert!(receipts.receive(input(9), || Ok(())).await.is_ok());
        receipts.delete(id).await.unwrap();
        assert_eq!(receipts.get(id).await.unwrap()["state"], "deleted");
        library.pool().close().await;
    }

    #[tokio::test]
    async fn altered_bytes_and_invalid_builtin_do_not_admit_a_candidate() {
        let root = tempfileish::temp_dir("ai-receipt-invalid");
        let library = Library::open(root.path()).await.unwrap();
        let receipts = AiReceipts::new(&library);
        let mut wrong = input(0);
        wrong.bytes.push(b' ');
        assert!(receipts.receive(wrong, || Ok(())).await.is_err());
        let mut wrong = input(1);
        wrong.bytes = serde_json::to_vec(
            &json!({"kind":"builtin","sceneId":"coast","stateVersion":1,"params":{"unknown":3}}),
        )
        .unwrap();
        wrong.artifact.bytes = wrong.bytes.len() as u64;
        wrong.artifact.sha256 = format!("{:x}", Sha256::digest(&wrong.bytes));
        assert!(receipts.receive(wrong, || Ok(())).await.is_err());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_receipts")
            .fetch_one(library.pool())
            .await
            .unwrap();
        assert_eq!(count, 0);
        library.pool().close().await;
    }

    #[tokio::test]
    async fn cancellation_while_waiting_for_database_cannot_create_a_new_candidate() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let root = tempfileish::temp_dir("ai-receipt-cancel");
        let library = Arc::new(Library::open(root.path()).await.unwrap());
        let writer = library.pool().begin_with("BEGIN IMMEDIATE").await.unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = cancel.clone();
        let worker_library = library.clone();
        let worker = tokio::spawn(async move {
            AiReceipts::new(&worker_library)
                .receive(input(0), || {
                    if worker_cancel.load(Ordering::Acquire) {
                        Err(JobError::new("cancelled", "接收已取消"))
                    } else {
                        Ok(())
                    }
                })
                .await
        });
        tokio::task::yield_now().await;
        cancel.store(true, Ordering::Release);
        writer.rollback().await.unwrap();
        assert_eq!(worker.await.unwrap().unwrap_err().code, "cancelled");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_receipts")
            .fetch_one(library.pool())
            .await
            .unwrap();
        assert_eq!(count, 0);
        library.pool().close().await;
    }

    #[tokio::test]
    async fn discarding_failed_saved_draft_releases_the_candidate_slot() {
        let root = tempfileish::temp_dir("ai-receipt-discard");
        let library = Library::open(root.path()).await.unwrap();
        let receipts = AiReceipts::new(&library);
        let first = receipts.receive(input(0), || Ok(())).await.unwrap();
        let id = first["receiptId"].as_str().unwrap();
        let tiny = AssetStore::new(root.path())
            .unwrap()
            .with_content_capacity(1);
        assert!(receipts.save(id, "明确保存".into(), &tiny).await.is_err());
        let row = receipts.row(id).await.unwrap();
        WorkDrafts::new(&library)
            .discard(row.draft_id.as_deref().unwrap(), 1)
            .await
            .unwrap();
        assert_eq!(receipts.get(id).await.unwrap()["state"], "expired");
        receipts.delete(id).await.unwrap();
        for i in 1..=8 {
            receipts.receive(input(i), || Ok(())).await.unwrap();
        }
        library.pool().close().await;
    }
}
