// SPDX-License-Identifier: MIT
use super::{
    contract, error,
    model::{MAX_RECEIPTS, MAX_SECURITY_HASHES},
    now,
    store::{db, json, TrustStore},
};
use crate::wallpaper::jobs::JobError;
use hertz_wallpaper::release::{
    self,
    authorization::AuthorizationChain,
    watermarks::{self, ReleaseWatermark, RevocationsWatermark, Update},
    KeyPurpose, SignedRelease, SignedRevocations,
};

/// Constructed only after signature, pin, watermarks and security updates commit.
#[derive(Clone)]
pub(crate) struct AcceptedRelease {
    source_id: String,
    origin: String,
    envelope: SignedRelease,
    digest: String,
}

impl AcceptedRelease {
    pub(crate) fn source_id(&self) -> &str {
        &self.source_id
    }
    pub(crate) fn origin(&self) -> &str {
        &self.origin
    }
    pub(crate) fn body(&self) -> &release::Release {
        &self.envelope.release
    }
    pub(crate) fn digest(&self) -> &str {
        &self.digest
    }
    pub(crate) fn envelope_json(&self) -> Result<String, JobError> {
        serde_json::to_string(&self.envelope).map_err(json)
    }
    pub(crate) fn validate_package(
        &self,
        package: &crate::wallpaper::assets::StagedPackage,
        bytes: u64,
    ) -> Result<(), JobError> {
        let body = self.body();
        let manifest = &package.manifest;
        if body.package_hash != package.package_hash
            || body.bytes != bytes
            || body.work_id != manifest.work_id
            || body.version != u64::from(manifest.version)
            || body.permissions.audio_spectrum != manifest.permissions.audio_spectrum
            || body.permissions.pointer != manifest.permissions.pointer
            || body.min_engine_protocol > 1
        {
            return Err(error(
                "release_package_mismatch",
                "下载包与已签发布的作品、版本、长度、哈希或权限不一致",
            ));
        }
        Ok(())
    }
}

impl TrustStore {
    /// Commit safety before returning a download candidate. A stale but signed
    /// revocation snapshot can add security facts; it grants no new Web activation.
    pub(crate) async fn accept(
        &self,
        id: &str,
        chain_bytes: &[u8],
        revocations_bytes: &[u8],
        candidate: Option<(&[u8], &str)>,
    ) -> Result<Option<AcceptedRelease>, JobError> {
        let _workspace = crate::wallpaper::budget::global()
            .admit_working_bytes(16 * 1024 * 1024)
            .map_err(|e| error("budget_busy", e.message.to_string()))?;
        let _writer = self.writer.lock().await;
        let row = self.row(id).await?;
        let old_chain = row.verified()?;
        let next = AuthorizationChain::parse(chain_bytes)
            .map_err(contract)?
            .verify(old_chain.pin(), Some(old_chain.watermark()))
            .map_err(contract)?;
        let rev = SignedRevocations::parse(revocations_bytes).map_err(contract)?;
        let verified_rev = rev
            .clone()
            .verify(&next.latest_key(KeyPurpose::Revocations).map_err(contract)?)
            .map_err(contract)?;
        let previous_rev: Option<RevocationsWatermark> = row
            .revocations_watermark
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(json)?;
        let rev_update = watermarks::revocations_update(previous_rev.as_ref(), id, &verified_rev)
            .map_err(contract)?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        if let Update::Advance(mark) = rev_update {
            // The union is global: relabeling or importing from another source
            // cannot remove known security restrictions.
            for (hash, effective) in &mark.security {
                sqlx::query("INSERT INTO security_hashes(package_hash,effective_at) VALUES(?1,?2) ON CONFLICT(package_hash) DO UPDATE SET effective_at=min(effective_at,excluded.effective_at)")
                    .bind(hash).bind(*effective as i64).execute(&mut *tx).await.map_err(db)?;
            }
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM security_hashes")
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
            if count > MAX_SECURITY_HASHES as i64 {
                return Err(error(
                    "security_capacity",
                    "不能截断完整安全撤销，须先升级协议",
                ));
            }
            sqlx::query("UPDATE trust_sources SET revocations_json=?2,revocations_watermark=?3 WHERE source_id=?1")
                .bind(id).bind(serde_json::to_string(&rev).map_err(json)?).bind(serde_json::to_string(&mark).map_err(json)?).execute(&mut *tx).await.map_err(db)?;
        }
        sqlx::query("UPDATE trust_sources SET chain_json=?2,generation=?3,authorization_digest=?4,observed_at=max(observed_at,?5),last_sync=?5 WHERE source_id=?1")
            .bind(id).bind(String::from_utf8(next.canonical_bytes().map_err(contract)?).map_err(|_|error("trust_encoding","授权链编码无效"))?)
            .bind(next.watermark().generation as i64).bind(&next.watermark().canonical_digest).bind(now() as i64).execute(&mut *tx).await.map_err(db)?;
        sqlx::query("UPDATE trust_clock SET observed_at=max(observed_at,?1) WHERE singleton=1")
            .bind(self.observed_time().max(verified_rev.body().issued_at) as i64)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        // Safety updates survive a withheld/copyright/replayed candidate. Commit
        // them first, then persist the release in the same serialized owner.
        tx.commit().await.map_err(db)?;
        self.reload().await?;
        let accepted = match candidate {
            None => None,
            Some((bytes, work)) => {
                let signed = SignedRelease::parse(bytes).map_err(contract)?;
                let verified = signed
                    .clone()
                    .verify(&next.latest_key(KeyPurpose::Release).map_err(contract)?)
                    .map_err(contract)?;
                if verified.body().work_id != work
                    || verified.body().min_engine_protocol > 1
                    || verified.body().version > u64::from(u32::MAX)
                {
                    return Err(error(
                        "release_not_supported",
                        "发布作品身份或最低引擎协议不受支持",
                    ));
                }
                Some((signed, verified))
            }
        };
        let Some((signed, verified)) = accepted else {
            return Ok(None);
        };
        self.security_check(&signed.release.package_hash)?;
        if verified_rev
            .body()
            .entries
            .iter()
            .any(|e| e.package_hash == signed.release.package_hash && e.effective_at <= now())
        {
            return Err(error("release_revoked", "此发布已撤销，不能进行新下载"));
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let previous:Option<Option<String>>=sqlx::query_scalar("SELECT CASE WHEN length(CAST(watermark_json AS BLOB)) BETWEEN 2 AND 4096 THEN watermark_json ELSE NULL END FROM release_watermarks WHERE source_id=?1 AND remote_work_id=?2 AND channel='stable'")
            .bind(id).bind(&signed.release.work_id).fetch_optional(&mut *tx).await.map_err(db)?;
        let previous = previous
            .map(|text| text.ok_or_else(|| error("trust_database_invalid", "发布安全水位超出界限")))
            .transpose()?;
        let previous: Option<ReleaseWatermark> = previous
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(json)?;
        if let Update::Advance(mark) =
            watermarks::release_update(previous.as_ref(), id, &verified).map_err(contract)?
        {
            sqlx::query("INSERT INTO release_watermarks(source_id,remote_work_id,channel,watermark_json) VALUES(?1,?2,'stable',?3) ON CONFLICT(source_id,remote_work_id,channel) DO UPDATE SET watermark_json=excluded.watermark_json")
                .bind(id).bind(&signed.release.work_id).bind(serde_json::to_string(&mark).map_err(json)?).execute(&mut *tx).await.map_err(db)?;
        }
        let existing:Option<(Option<String>,Option<String>)>=sqlx::query_as("SELECT CASE WHEN length(CAST(package_hash AS BLOB))=64 THEN package_hash ELSE NULL END,CASE WHEN length(CAST(digest AS BLOB))=64 THEN digest ELSE NULL END FROM release_receipts WHERE source_id=?1 AND remote_work_id=?2 AND version=?3")
            .bind(id).bind(&signed.release.work_id).bind(signed.release.version as i64).fetch_optional(&mut *tx).await.map_err(db)?;
        if let Some((hash, digest)) = existing {
            let hash =
                hash.ok_or_else(|| error("trust_database_invalid", "发布回执哈希超出界限"))?;
            let digest =
                digest.ok_or_else(|| error("trust_database_invalid", "发布回执摘要超出界限"))?;
            if hash != signed.release.package_hash || digest != verified.canonical_digest() {
                return Err(error(
                    "release_version_conflict",
                    "历史发布回执与同版本正文冲突",
                ));
            }
        } else {
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM release_receipts")
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
            if count >= MAX_RECEIPTS as i64 {
                return Err(error(
                    "receipt_capacity",
                    "历史可信回执达到上限，保留现有安全水位",
                ));
            }
            sqlx::query("INSERT INTO release_receipts(source_id,remote_work_id,version,package_hash,digest,envelope_json) VALUES(?1,?2,?3,?4,?5,?6)")
                .bind(id).bind(&signed.release.work_id).bind(signed.release.version as i64).bind(&signed.release.package_hash).bind(verified.canonical_digest()).bind(serde_json::to_string(&signed).map_err(json)?)
                .execute(&mut *tx).await.map_err(db)?;
        }
        tx.commit().await.map_err(db)?;
        self.reload().await?;
        Ok(Some(AcceptedRelease {
            source_id: id.to_owned(),
            origin: row.origin,
            envelope: signed,
            digest: verified.canonical_digest().to_owned(),
        }))
    }

    /// Installed rollback/recovery rechecks a retained receipt with historical
    /// authorized work keys; it never lowers the newest stable watermark.
    pub(crate) async fn installed_receipt(
        &self,
        id: &str,
        hash: &str,
    ) -> Result<AcceptedRelease, JobError> {
        self.security_check(hash)?;
        let row = self.row(id).await?;
        let chain = row.verified()?;
        let text:Option<String>=sqlx::query_scalar("SELECT envelope_json FROM release_receipts WHERE source_id=?1 AND package_hash=?2 AND length(CAST(envelope_json AS BLOB))<=65536 LIMIT 1")
            .bind(id).bind(hash).fetch_optional(&*self.pool).await.map_err(db)?;
        let signed = SignedRelease::parse(
            text.ok_or_else(|| error("release_receipt_missing", "版本缺少独立保存的可信回执"))?
                .as_bytes(),
        )
        .map_err(contract)?;
        let verified = signed
            .clone()
            .verify(
                &chain
                    .historical_key(&signed.release.key_id, KeyPurpose::Release)
                    .map_err(contract)?,
            )
            .map_err(contract)?;
        if signed.release.package_hash != hash {
            return Err(error("release_receipt_conflict", "回执包哈希不一致"));
        }
        Ok(AcceptedRelease {
            source_id: id.to_owned(),
            origin: row.origin,
            envelope: signed,
            digest: verified.canonical_digest().to_owned(),
        })
    }

    pub(crate) async fn receipts_for_hash(
        &self,
        hash: &str,
    ) -> Result<Vec<AcceptedRelease>, JobError> {
        let ids:Vec<Option<String>>=sqlx::query_scalar("SELECT DISTINCT CASE WHEN length(CAST(source_id AS BLOB))=36 THEN source_id ELSE NULL END FROM release_receipts WHERE package_hash=?1 LIMIT 17").bind(hash).fetch_all(&*self.pool).await.map_err(db)?;
        if ids.len() > super::model::MAX_SOURCES {
            return Err(error("trust_database_invalid", "包来源数量异常"));
        }
        let mut result = Vec::with_capacity(ids.len());
        for id in ids {
            let id = id.ok_or_else(|| error("trust_database_invalid", "包来源身份超出界限"))?;
            result.push(self.installed_receipt(&id, hash).await?);
        }
        Ok(result)
    }
}
