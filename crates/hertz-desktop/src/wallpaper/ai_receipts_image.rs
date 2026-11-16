// SPDX-License-Identifier: MIT
//! Image handling on the original candidate receipt, content writer and install transaction.
use super::super::{
    assets::{AssetStore, StagedPackage},
    content_quota,
    generation::receive::ReceivedImage,
};
use super::*;

#[cfg(test)]
#[path = "ai_receipts_image_tests.rs"]
mod tests;

pub(crate) struct ImageReception {
    pub received: ReceivedImage,
    pub package: StagedPackage,
    pub id: String,
    pub job: String,
    pub thumbnail: super::super::image_prepare::Output,
}
pub(crate) struct ImageIdentity {
    pub work_id: String,
    pub title: String,
    pub candidate_hash: String,
}

impl AiReceipts<'_> {
    pub(crate) async fn maintenance_files(&self, assets: &AssetStore) -> Result<Option<i64>> {
        let expiry = self.maintenance().await?;
        let _writer = assets.content_writer()?;
        let live: Vec<String> = sqlx::query_scalar("SELECT receipt_id FROM ai_receipts WHERE kind='image' AND state IN ('previewReady','saving')")
            .fetch_all(self.0.pool()).await.map_err(database)?;
        let root = assets.root().join("ai-candidates");
        let mut retry = false;
        for (index, entry) in std::fs::read_dir(&root)
            .map_err(|e| JobError::io(e.to_string()))?
            .enumerate()
        {
            if index >= 1024 {
                return Err(JobError::new(
                    "candidate_capacity_exceeded",
                    "候选目录枚举超过上限",
                ));
            }
            let entry = entry.map_err(|e| JobError::io(e.to_string()))?;
            let id = entry.file_name().to_string_lossy().into_owned();
            let path = assets.candidate_dir(&id)?;
            crate::root_owner::ordinary(
                &std::fs::symlink_metadata(&path).map_err(|e| JobError::io(e.to_string()))?,
            )
            .map_err(|e| JobError::io(e.to_string()))?;
            if live.contains(&id) {
                continue;
            }
            // Fixed package/source handles deny deletion until the real preview readers exit.
            match std::fs::remove_dir_all(&path) {
                Ok(()) => {
                    sqlx::query("UPDATE ai_receipts SET candidate_bytes=0 WHERE receipt_id=? AND state NOT IN ('previewReady','saving')")
                    .bind(&id).execute(self.0.pool()).await.map_err(database)?;
                }
                Err(e) if matches!(e.raw_os_error(), Some(32 | 33)) => retry = true,
                Err(e) => return Err(JobError::io(e.to_string())),
            }
        }
        // Repair a crash after physical deletion and before the byte receipt update.
        let rows: Vec<String> = sqlx::query_scalar("SELECT receipt_id FROM ai_receipts WHERE kind='image' AND candidate_bytes>0 AND state NOT IN ('previewReady','saving')")
            .fetch_all(self.0.pool()).await.map_err(database)?;
        for id in rows {
            if !assets
                .candidate_dir(&id)?
                .try_exists()
                .map_err(|e| JobError::io(e.to_string()))?
            {
                sqlx::query("UPDATE ai_receipts SET candidate_bytes=0 WHERE receipt_id=? AND state NOT IN ('previewReady','saving')")
                    .bind(id).execute(self.0.pool()).await.map_err(database)?;
            }
        }
        Ok(if retry {
            Some(expiry.unwrap_or(i64::MAX).min(now_secs() + 30))
        } else {
            expiry
        })
    }

    pub(crate) async fn receive_image<F, G>(
        &self,
        packet: ImageReception,
        bytes: u64,
        assets: &AssetStore,
        commit_authority: F,
    ) -> Result<Value>
    where
        F: FnOnce() -> Result<G>,
    {
        let ImageReception {
            received,
            package,
            id,
            job,
            thumbnail,
        } = packet;
        received
            .artifact
            .validate()
            .map_err(|e| JobError::new(e.code, e.message))?;
        let hertz_wallpaper::Content::Image { asset } = &package.manifest.content else {
            return Err(JobError::new("ai_output_rejected", "候选包不是图片"));
        };
        let source = package
            .manifest
            .assets
            .iter()
            .find(|a| a.id == *asset)
            .and_then(|a| package.entries.iter().find(|e| e.path == a.source))
            .ok_or_else(|| JobError::new("ai_output_rejected", "候选图片未声明"))?;
        let work_id = id
            .strip_prefix("work-ai-")
            .ok_or_else(|| JobError::invalid_input("候选身份无效"))?;
        if received.artifact.kind != hertz_wallpaper::generation::WallpaperGenerationKind::Image
            || received.artifact.mime != "image/png"
            || received.artifact.sha256 != source.sha256
            || received.artifact.bytes != source.bytes
            || received.artifact.registry_hash != hertz_wallpaper::catalog().registry_hash
            || received.file != assets.staging_dir(&job).join("original.hwpkg")
            || package.manifest.work_id != work_id
            || [&received.service_owner, &received.provider, &received.model]
                .iter()
                .any(|s| s.is_empty() || s.len() > 128 || s.chars().any(char::is_control))
        {
            return Err(JobError::new(
                "ai_output_rejected",
                "候选图片与来源回执不符",
            ));
        }
        let expiry = received
            .artifact
            .expires_at
            .parse::<i64>()
            .map_err(|_| JobError::invalid_input("候选期限无效"))?
            / 1000;
        if content_quota::directory_bytes(&assets.candidate_dir(&id)?)? != bytes {
            return Err(JobError::new("candidate_changed", "候选实际长度已变化"));
        }
        let mut tx = self
            .0
            .pool()
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database)?;
        let existing: Option<String> = sqlx::query_scalar("SELECT receipt_id FROM ai_receipts WHERE service_owner=? AND job_id=? AND artifact_id=? AND output_hash=?")
            .bind(&received.service_owner).bind(&received.artifact.job_id).bind(&received.artifact.artifact_id).bind(&received.artifact.sha256)
            .fetch_optional(&mut *tx).await.map_err(database)?;
        if let Some(id) = existing {
            tx.commit().await.map_err(database)?;
            return self.get(&id).await;
        }
        if expiry <= now_secs() || expiry > now_secs() + 86400 {
            return Err(JobError::new("ai_artifact_expired", "候选已到期或期限无效"));
        }
        sqlx::query("UPDATE ai_receipts SET state='expired',document_json=NULL WHERE state='previewReady' AND expires_at<=?")
            .bind(now_secs()).execute(&mut *tx).await.map_err(database)?;
        let (records, count, held): (i64,i64,i64) = sqlx::query_as("SELECT COUNT(*),COALESCE(SUM(state IN ('previewReady','saving')),0),COALESCE(SUM(candidate_bytes+CASE WHEN state IN ('previewReady','saving') THEN COALESCE(length(CAST(document_json AS BLOB)),0) ELSE 0 END),0) FROM ai_receipts")
            .fetch_one(&mut *tx).await.map_err(database)?;
        if records >= 500 || count >= 8 || held.saturating_add(bytes as i64) > 256 * 1024 * 1024 {
            return Err(JobError::new(
                "candidate_capacity_exceeded",
                "候选数量或实际文件容量已达上限，请先保存或删除并结束预览",
            ));
        }
        let metadata = serde_json::to_string(&received.artifact)
            .map_err(|e| JobError::invalid_input(e.to_string()))?;
        let thumbnail = serde_json::to_string(&thumbnail)
            .map_err(|e| JobError::invalid_input(e.to_string()))?;
        sqlx::query("INSERT INTO ai_receipts(receipt_id,service_owner,job_id,artifact_id,output_hash,state,metadata_json,provider,model,received_at,expires_at,kind,image_work_id,candidate_package_hash,candidate_bytes,thumbnail_json) VALUES(?,?,?,?,?,'previewReady',?,?,?,?,?,'image',?,?,?,?)")
            .bind(&id).bind(received.service_owner).bind(received.artifact.job_id).bind(received.artifact.artifact_id).bind(received.artifact.sha256)
            .bind(metadata).bind(received.provider).bind(received.model).bind(now_secs()).bind(expiry).bind(work_id).bind(&package.package_hash).bind(bytes as i64).bind(thumbnail)
            .execute(&mut *tx).await.map_err(database)?;
        let permit = commit_authority()?;
        self.0.ai_receipts_changed.notify_one();
        tx.commit().await.map_err(database)?;
        drop(permit);
        self.get(&id).await
    }

    pub(crate) async fn image_identity(
        &self,
        id: &str,
        title: Option<&str>,
    ) -> Result<ImageIdentity> {
        let row = self.row(id).await?;
        if row.kind != "image"
            || !matches!(row.state.as_str(), "previewReady" | "saving")
            || (row.state == "previewReady" && row.expires_at <= now_secs())
        {
            return Err(JobError::new("ai_artifact_expired", "图片候选已变化或到期"));
        }
        let title = row
            .save_title
            .as_deref()
            .or(title)
            .unwrap_or("AI 图片")
            .trim()
            .to_owned();
        if title.is_empty() || title.chars().count() > 120 || title.chars().any(char::is_control) {
            return Err(JobError::invalid_input("作品名需为1–120个字符"));
        }
        Ok(ImageIdentity {
            work_id: row
                .image_work_id
                .ok_or_else(|| JobError::new("ai_output_rejected", "候选作品身份缺失"))?,
            candidate_hash: row
                .candidate_package_hash
                .ok_or_else(|| JobError::new("ai_output_rejected", "候选包身份缺失"))?,
            title,
        })
    }

    pub(crate) async fn image_thumbnail(&self, id: &str, assets: &AssetStore) -> Result<Value> {
        use base64::Engine;
        use sha2::{Digest, Sha256};
        use std::io::Read;
        self.preview_source(id, 1).await?;
        let row = self.row(id).await?;
        if row.kind != "image" {
            return Err(JobError::invalid_input("需要图片候选"));
        }
        let thumbnail: super::super::image_prepare::Output = serde_json::from_str(
            row.thumbnail_json
                .as_deref()
                .ok_or_else(|| JobError::new("thumbnail_missing", "候选缩略图不存在"))?,
        )
        .map_err(|e| JobError::invalid_input(e.to_string()))?;
        if thumbnail.bytes > 40 * 1024
            || thumbnail.width == 0
            || thumbnail.height == 0
            || thumbnail.width.max(thumbnail.height) > 96
        {
            return Err(JobError::new("ai_output_rejected", "缩略图超出静态边界"));
        }
        let mut file = super::super::assets::open_immutable(
            &assets.candidate_dir(id)?.join("ai-thumbnail.png"),
        )?;
        if file
            .metadata()
            .map_err(|e| JobError::io(e.to_string()))?
            .len()
            != thumbnail.bytes
        {
            return Err(JobError::new("candidate_changed", "缩略图长度已变化"));
        }
        let mut bytes = Vec::with_capacity(thumbnail.bytes as usize);
        (&mut file)
            .take(thumbnail.bytes + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| JobError::io(e.to_string()))?;
        if bytes.len() as u64 != thumbnail.bytes
            || format!("{:x}", Sha256::digest(&bytes)) != thumbnail.sha256
        {
            return Err(JobError::new("candidate_changed", "缩略图哈希已变化"));
        }
        self.preview_source(id, 1).await?;
        Ok(
            json!({"width":thumbnail.width,"height":thumbnail.height,"data":base64::engine::general_purpose::STANDARD.encode(bytes)}),
        )
    }

    pub(crate) async fn freeze_image_save(&self, id: &str, title: &str, hash: &str) -> Result<()> {
        let mut tx = self
            .0
            .pool()
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database)?;
        let row: Row = sqlx::query_as("SELECT * FROM ai_receipts WHERE receipt_id=?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await
            .map_err(database)?;
        if row.kind != "image" {
            return Err(JobError::invalid_input("需要图片候选"));
        }
        if row.state == "saving" {
            if row.pending_package_hash.as_deref() != Some(hash)
                || row.save_title.as_deref() != Some(title)
            {
                return Err(JobError::new(
                    "candidate_changed",
                    "已有原保存请求，请重新读取并继续原保存",
                ));
            }
        } else {
            if row.state != "previewReady" || row.expires_at <= now_secs() {
                return Err(JobError::new("candidate_changed", "候选已变化或到期"));
            }
            sqlx::query("UPDATE ai_receipts SET state='saving',save_title=?,pending_package_hash=? WHERE receipt_id=?")
                .bind(title).bind(hash).bind(id).execute(&mut *tx).await.map_err(database)?;
        }
        tx.commit().await.map_err(database)?;
        self.0.ai_receipts_changed.notify_one();
        Ok(())
    }

    pub(crate) async fn finish_image_install(
        conn: &mut sqlx::SqliteConnection,
        work: &super::super::library::InstallWork,
        work_key: &str,
    ) -> Result<()> {
        let row: Option<(String,String,String,i64,String,String,String)> = sqlx::query_as("SELECT receipt_id,provider,model,received_at,output_hash,image_work_id,save_title FROM ai_receipts WHERE kind='image' AND state='saving' AND pending_package_hash=?")
            .bind(&work.package_hash).fetch_optional(&mut *conn).await.map_err(database)?;
        if let Some((id, provider, model, time, output, work_id, title)) = row {
            if work.remote_work_id != work_id
                || work.title != title
                || work.kind != "image"
                || work.version != 1
            {
                return Err(JobError::new(
                    "ai_output_rejected",
                    "安装事实与原图片保存不符",
                ));
            }
            sqlx::query("INSERT INTO ai_origins(version_key,provider,model,generated_at,output_hash) VALUES(?,?,?,?,?)")
                .bind(format!("{work_key}@1")).bind(provider).bind(model).bind(time).bind(output).execute(&mut *conn).await.map_err(database)?;
            sqlx::query("UPDATE ai_receipts SET state='saved',work_key=?,package_hash=?,document_json=NULL WHERE receipt_id=?")
                .bind(work_key).bind(&work.package_hash).bind(id).execute(conn).await.map_err(database)?;
        }
        Ok(())
    }
}
