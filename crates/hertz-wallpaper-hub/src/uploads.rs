// SPDX-License-Identifier: MIT
use crate::{
    config::canonical_id,
    error::{HubError, Result},
    model::{digest, encode, now, Actor, Candidate, Upload, UploadInput, CANDIDATE_SELECT},
    store::{remove_if_present, Hub},
};
use axum::body::Body;
use futures::StreamExt;
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::{
    io::{Read, Seek, SeekFrom},
    time::Duration,
};
use tokio::io::AsyncWriteExt;

impl Hub {
    pub(crate) async fn reserve_upload(
        &self,
        actor: &Actor,
        work: &str,
        input: UploadInput,
    ) -> Result<Upload> {
        canonical_id(work)?;
        input.validate()?;
        let expected = digest(&(work, &input))?;
        let time = now();
        let mut tx = self.pool.begin().await?;
        let owner: Option<String> = sqlx::query_scalar("SELECT owner_id FROM works WHERE id=?")
            .bind(work)
            .fetch_optional(&mut *tx)
            .await?;
        if owner.as_deref() != Some(actor.id.as_str()) {
            return Err(HubError::missing());
        }
        sqlx::query("UPDATE uploads SET state='expired' WHERE expires_at<=? AND state IN ('reserved','receiving','ready','validating')")
            .bind(time).execute(&mut *tx).await?;
        if let Some(existing) =
            sqlx::query_as::<_, Upload>("SELECT * FROM uploads WHERE owner_id=? AND operation_id=?")
                .bind(&actor.id)
                .bind(&input.operation_id)
                .fetch_optional(&mut *tx)
                .await?
        {
            if existing.operation_digest != expected {
                return Err(HubError::conflict("同一上传请求不能更换作品、包或长度"));
            }
            tx.commit().await?;
            return Ok(existing);
        }
        let attempts: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE actor_id=? AND action='upload_request' AND created_at>?")
            .bind(&actor.id).bind(time.saturating_sub(3600)).fetch_one(&mut *tx).await?;
        if attempts >= 10 {
            return Err(HubError::limited("每位作者每小时最多10次新上传申请"));
        }
        sqlx::query("INSERT INTO audit_events(actor_id,action,object_id,created_at) VALUES(?,'upload_request',?,?)")
            .bind(&actor.id).bind(work).bind(time).execute(&mut *tx).await?;
        let active = sqlx::query("SELECT count(*) AS total,coalesce(sum(CASE WHEN owner_id=? THEN 1 ELSE 0 END),0) AS own FROM uploads WHERE state IN ('reserved','receiving','ready','validating')")
            .bind(&actor.id).fetch_one(&mut *tx).await?;
        if active.try_get::<i64, _>("total")? >= 4 || active.try_get::<i64, _>("own")? >= 1 {
            tx.commit().await?;
            return Err(HubError::limited("上传槽繁忙，每位作者1个、服务合计4个"));
        }
        let bytes: i64 = sqlx::query_scalar("SELECT coalesce((SELECT sum(expected_bytes) FROM uploads WHERE owner_id=? AND state!='submitted' AND purged_at IS NULL),0)+coalesce((SELECT sum(bytes) FROM releases WHERE owner_id=?),0)")
            .bind(&actor.id).bind(&actor.id).fetch_one(&mut *tx).await?;
        if (bytes as u64).saturating_add(input.bytes) > 5 * 1024 * 1024 * 1024 {
            tx.commit().await?;
            return Err(HubError::limited("作者内容与预留总量不能超过5GiB"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO uploads(id,owner_id,work_id,operation_id,operation_digest,package_hash,expected_bytes,min_engine_protocol,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,'reserved',?,?)")
            .bind(&id).bind(&actor.id).bind(work).bind(&input.operation_id).bind(expected).bind(input.package_hash)
            .bind(input.bytes as i64).bind(i64::from(input.min_engine_protocol)).bind(time).bind(time+1800).execute(&mut *tx).await?;
        let upload = sqlx::query_as("SELECT * FROM uploads WHERE id=?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(upload)
    }

    pub(crate) async fn receive(
        &self,
        actor: Actor,
        id: String,
        content_length: u64,
        body: Body,
    ) -> Result<Upload> {
        let upload = self.upload(&actor, &id).await?;
        if content_length != upload.expected_bytes as u64 {
            return Err(HubError::invalid(
                "Content-Length必须等于申请中声明的包长度",
            ));
        }
        if matches!(upload.state.as_str(), "ready" | "validating" | "submitted") {
            return Ok(upload);
        }
        let permit = self
            .operations
            .clone()
            .try_acquire_owned()
            .map_err(|_| HubError::limited("上传工作槽暂满"))?;
        let hub = self.clone();
        // Owning the operation avoids a cancelled response leaving a half
        // successful state transition dependent on the HTTP request future.
        tokio::spawn(async move {
            let _permit = permit;
            let changed = sqlx::query("UPDATE uploads SET state='receiving' WHERE id=? AND owner_id=? AND state='reserved' AND expires_at>?")
                .bind(&id).bind(&actor.id).bind(now()).execute(&hub.pool).await?.rows_affected();
            if changed != 1 { return Err(HubError::conflict("上传已到期或正在接收；请查询原uploadId")); }
            let remaining = (upload.expires_at - now()).clamp(0, 1800) as u64;
            let transfer = tokio::time::timeout(Duration::from_secs(remaining), hub.transfer(&upload, body)).await
                .unwrap_or_else(|_| Err(HubError::conflict("上传超过30分钟期限")));
            if let Err(error) = transfer {
                remove_if_present(&hub.object(&id, true)?).await?;
                remove_if_present(&hub.object(&id, false)?).await?;
                sqlx::query("UPDATE uploads SET state=CASE WHEN expires_at<=? THEN 'expired' ELSE 'reserved' END WHERE id=? AND state='receiving'")
                    .bind(now()).bind(&id).execute(&hub.pool).await?;
                return Err(error);
            }
            let changed = sqlx::query("UPDATE uploads SET state='ready' WHERE id=? AND state='receiving' AND expires_at>?")
                .bind(&id).bind(now()).execute(&hub.pool).await?.rows_affected();
            if changed != 1 {
                remove_if_present(&hub.object(&id, false)?).await?;
                return Err(HubError::conflict("上传已到期，未创建待审版本"));
            }
            hub.upload(&actor, &id).await
        }).await.map_err(|_| HubError::unavailable())?
    }

    async fn transfer(&self, upload: &Upload, body: Body) -> Result<()> {
        let staging = self.object(&upload.id, true)?;
        let destination = self.object(&upload.id, false)?;
        let mut file = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staging)
            .await?;
        let mut stream = body.into_data_stream();
        let mut received = 0_u64;
        let mut hash = Sha256::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| HubError::invalid("上传流中断，请重试原uploadId"))?;
            received = received
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| HubError::invalid("上传长度溢出"))?;
            if received > upload.expected_bytes as u64 {
                return Err(HubError::invalid("实际包超过声明长度"));
            }
            hash.update(&chunk);
            file.write_all(&chunk).await?;
        }
        if received != upload.expected_bytes as u64
            || format!("{:x}", hash.finalize()) != upload.package_hash
        {
            return Err(HubError::invalid("实际包长度或SHA-256与申请不符"));
        }
        file.sync_all().await?;
        drop(file);
        // Only this receiving lease can own the destination. Never replace an
        // existing object after a partial operation.
        if tokio::fs::try_exists(&destination).await? {
            return Err(HubError::conflict("隔离对象已存在，需要协调原上传"));
        }
        tokio::fs::rename(staging, destination).await?;
        Ok(())
    }

    pub(crate) async fn submit(&self, actor: Actor, id: String) -> Result<Candidate> {
        let upload = self.upload(&actor, &id).await?;
        if let Some(release) = &upload.release_id {
            return self.candidate(&actor, release).await;
        }
        let permit = self
            .operations
            .clone()
            .try_acquire_owned()
            .map_err(|_| HubError::limited("上传工作槽暂满"))?;
        let hub = self.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let changed = sqlx::query("UPDATE uploads SET state='validating' WHERE id=? AND owner_id=? AND state='ready' AND expires_at>?")
                .bind(&id).bind(&actor.id).bind(now()).execute(&hub.pool).await?.rows_affected();
            if changed != 1 { return Err(HubError::conflict("上传未完整接收、已到期或正在校验，请查询原uploadId")); }
            let result = hub.validate_and_submit(&actor, &upload).await;
            if let Err(error) = &result {
                let failed = error.status.is_client_error();
                sqlx::query("UPDATE uploads SET state=CASE WHEN expires_at<=? THEN 'expired' WHEN ? THEN 'rejected' ELSE 'ready' END WHERE id=? AND state='validating'")
                    .bind(now()).bind(failed).bind(&id).execute(&hub.pool).await?;
            }
            result
        }).await.map_err(|_| HubError::unavailable())?
    }

    async fn validate_and_submit(&self, actor: &Actor, upload: &Upload) -> Result<Candidate> {
        let path = self.object(&upload.id, false)?;
        let frozen = upload.clone();
        let permit = self
            .validator
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| HubError::unavailable())?;
        let manifest = tokio::task::spawn_blocking(move || -> Result<hertz_wallpaper::Manifest> {
            let _permit = permit;
            let mut file = std::fs::File::open(path)?;
            if file.metadata()?.len() != frozen.expected_bytes as u64 {
                return Err(HubError::invalid("隔离包长度发生变化"));
            }
            let mut hash = Sha256::new();
            let mut bytes = 0_u64;
            let mut buffer = [0_u8; 65_536];
            loop {
                let count = file.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                bytes += count as u64;
                if bytes > frozen.expected_bytes as u64 {
                    return Err(HubError::invalid("隔离包长度发生变化"));
                }
                hash.update(&buffer[..count]);
            }
            if bytes != frozen.expected_bytes as u64
                || format!("{:x}", hash.finalize()) != frozen.package_hash
            {
                return Err(HubError::invalid("隔离包完整性校验失败"));
            }
            file.seek(SeekFrom::Start(0))?;
            let package = hertz_wallpaper::validate_package(file).map_err(|error| {
                HubError::new(
                    axum::http::StatusCode::BAD_REQUEST,
                    error.code,
                    "上传包不符合共享壁纸包合同",
                )
            })?;
            let manifest = package.manifest;
            if matches!(manifest.content, hertz_wallpaper::Content::Web { .. }) {
                return Err(HubError::new(
                    axum::http::StatusCode::BAD_REQUEST,
                    "web_unqualified",
                    "当前社区只接收声明式包，作者网页尚未取得隔离资格",
                ));
            }
            Ok(manifest)
        })
        .await
        .map_err(|_| HubError::unavailable())??;
        if manifest.work_id != upload.work_id {
            return Err(HubError::conflict("包内workId不属于本次已认领作品"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let time = now();
        let release = hertz_wallpaper::release::Release {
            hub_id: self.config.hub_id.clone(),
            work_id: manifest.work_id.clone(),
            release_id: id.clone(),
            version: u64::from(manifest.version),
            package_hash: upload.package_hash.clone(),
            bytes: upload.expected_bytes as u64,
            permissions: manifest.permissions.clone(),
            min_engine_protocol: upload.min_engine_protocol as u32,
            published_at: time as u64,
            key_id: self.config.release_key_id.clone(),
        };
        let canonical = release
            .canonical_bytes()
            .map_err(|_| HubError::invalid("发布正文无效"))?;
        let permissions = encode(&manifest.permissions)?;
        let kind = match &manifest.content {
            hertz_wallpaper::Content::Builtin { .. } => "builtin",
            hertz_wallpaper::Content::Composition { .. } => "composition",
            hertz_wallpaper::Content::Image { .. } => "image",
            hertz_wallpaper::Content::Video { .. } => "video",
            hertz_wallpaper::Content::Web { .. } => {
                return Err(HubError::invalid("作者网页未开放"))
            }
        };
        let mut tx = self.pool.begin().await?;
        let work = sqlx::query("SELECT owner_id,next_version FROM works WHERE id=?")
            .bind(&upload.work_id)
            .fetch_one(&mut *tx)
            .await?;
        if work.try_get::<String, _>("owner_id")? != actor.id
            || i64::from(manifest.version) < work.try_get::<i64, _>("next_version")?
        {
            return Err(HubError::conflict("作品归属或单调版本校验失败"));
        }
        let changed = sqlx::query("UPDATE uploads SET state='submitted',release_id=? WHERE id=? AND owner_id=? AND state='validating' AND expires_at>?")
            .bind(&id).bind(&upload.id).bind(&actor.id).bind(time).execute(&mut *tx).await?.rows_affected();
        if changed != 1 {
            return Err(HubError::conflict("上传校验完成时申请已到期"));
        }
        sqlx::query("INSERT INTO releases(id,work_id,owner_id,upload_id,version,package_hash,bytes,title,description,kind,license_json,permissions_json,permissions_digest,body_json,body_digest,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending_review',?)")
            .bind(&id).bind(&upload.work_id).bind(&actor.id).bind(&upload.id).bind(i64::from(manifest.version))
            .bind(&upload.package_hash).bind(upload.expected_bytes).bind(manifest.title).bind(manifest.description).bind(kind)
            .bind(encode(&manifest.license)?).bind(permissions).bind(digest(&manifest.permissions)?).bind(encode(&release)?)
            .bind(format!("{:x}", Sha256::digest(canonical))).bind(time).execute(&mut *tx).await?;
        sqlx::query("UPDATE works SET next_version=? WHERE id=?")
            .bind(i64::from(manifest.version) + 1)
            .bind(&upload.work_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO audit_events(actor_id,action,object_id,created_at) VALUES(?,'release_submitted',?,?)")
            .bind(&actor.id).bind(&id).bind(time).execute(&mut *tx).await?;
        let candidate = sqlx::query_as(&format!("{CANDIDATE_SELECT} WHERE id=?"))
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(candidate)
    }
}
