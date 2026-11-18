// SPDX-License-Identifier: MIT
//! Only a separately approved, signed complete snapshot changes public
//! revocations. Security hashes and their original effective times are retained.
use hertz_wallpaper::release::{
    watermarks::{self, RevocationsWatermark, Update},
    KeyPurpose, RevocationEntry, RevocationReason, Revocations, SignedRevocations,
    VerifiedRevocations, MAX_REVOCATIONS_BYTES,
};
use hertz_wallpaper_signer::protocol::{Approval, Document, Evidence};
use serde::{Deserialize, Serialize};

use crate::{
    config::{canonical_id, text},
    error::{HubError, Result},
    model::{digest, now, Actor, Candidate, CANDIDATE_SELECT},
    publication::{insert_operation, Operation},
    store::Hub,
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PrepareInput {
    pub operation_id: String,
    pub sequence: u64,
    pub issued_at: u64,
    pub expires_at: u64,
    pub reason: Option<RevocationReason>,
    pub effective_at: Option<u64>,
    pub review_reason: String,
}

impl Hub {
    pub(crate) async fn prepare_revocations(
        &self,
        actor: Actor,
        release: Option<String>,
        input: PrepareInput,
    ) -> Result<serde_json::Value> {
        if actor.role != "admin" {
            return Err(HubError::denied());
        }
        canonical_id(&input.operation_id)?;
        text(&input.review_reason, 4000)?;
        if let Some(id) = &release {
            canonical_id(id)?;
        }
        if release.is_some() != input.reason.is_some()
            || release.is_some() != input.effective_at.is_some()
        {
            return Err(HubError::invalid(
                "撤销单个版本须给出原因与生效时间；刷新清单不接受新增撤销项",
            ));
        }
        if now() <= 0 || input.issued_at > now() as u64 {
            return Err(HubError::invalid("撤销签发时间不能在未来"));
        }
        let permit = self
            .operations
            .clone()
            .try_acquire_owned()
            .map_err(|_| HubError::limited("撤销操作槽繁忙"))?;
        let hub = self.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let _writer = hub.publication.lock().await;
            let request_digest = digest(&(&release, &input))?;
            if let Some(existing) = hub.operation_optional(&input.operation_id).await? {
                if existing.kind != "revocations" || existing.request_digest != request_digest {
                    return Err(HubError::conflict("原撤销操作不能更换完整清单或原因"));
                }
                return hub.drive_operation(&existing.operation_id, matches!(existing.state.as_str(), "prepared" | "awaiting_approval")).await?.view();
            }
            let mut tx = hub.pool.begin().await?;
            let previous: i64 = sqlx::query_scalar("SELECT coalesce(max(sequence),0) FROM revocation_snapshots").fetch_one(&mut *tx).await?;
            if input.sequence <= previous as u64 { return Err(HubError::conflict("新撤销序号须高于已公开的完整清单")); }
            let rows: Vec<(Option<String>, Option<String>, i64)> = sqlx::query_as("SELECT CASE WHEN length(CAST(package_hash AS BLOB))=64 THEN package_hash ELSE NULL END,CASE WHEN length(CAST(reason AS BLOB))<=16 THEN reason ELSE NULL END,effective_at FROM revocations ORDER BY package_hash LIMIT ?")
                .bind((MAX_REVOCATIONS_BYTES / 64 + 1) as i64).fetch_all(&mut *tx).await?;
            if rows.len() > MAX_REVOCATIONS_BYTES / 64 { return Err(HubError::limited("完整撤销清单已满，须先升级协议")); }
            let mut entries = rows.into_iter().map(|(package_hash, reason, effective_at)| {
                let package_hash=package_hash.ok_or_else(HubError::unavailable)?;
                let reason=reason.ok_or_else(HubError::unavailable)?;
                if effective_at<=0{return Err(HubError::unavailable());}
                let reason = match reason.as_str() { "security" => RevocationReason::Security,
                    "copyright" => RevocationReason::Copyright, _ => return Err(HubError::unavailable()) };
                Ok(RevocationEntry { package_hash, reason, effective_at: effective_at as u64 })
            }).collect::<Result<Vec<_>>>()?;
            if let Some(id) = &release {
                let candidate: Candidate = sqlx::query_as(&format!("{CANDIDATE_SELECT} WHERE id=?"))
                    .bind(id).fetch_optional(&mut *tx).await?.ok_or_else(HubError::missing)?;
                if !matches!(candidate.state.as_str(), "published" | "signed_pending_public" | "security_revoked" | "copyright_revoked") {
                    return Err(HubError::conflict("须撤销已经签名的确切版本"));
                }
                hub.release_document(&candidate)?;
                let addition = RevocationEntry { package_hash: candidate.package_hash,
                    reason: input.reason.ok_or_else(HubError::unavailable)?, effective_at: input.effective_at.ok_or_else(HubError::unavailable)? };
                if let Some(prior) = entries.iter_mut().find(|entry| entry.package_hash == addition.package_hash) {
                    if prior.reason == RevocationReason::Security && (addition.reason != prior.reason || addition.effective_at != prior.effective_at) {
                        return Err(HubError::conflict("安全撤销及原生效时间不能删除、降级或改动"));
                    }
                    if prior.reason == RevocationReason::Copyright && addition.reason == RevocationReason::Security {
                        prior.reason = RevocationReason::Security;
                        prior.effective_at = prior.effective_at.min(addition.effective_at);
                    } else if prior.effective_at != addition.effective_at {
                        return Err(HubError::conflict("已有撤销不能推迟生效时间"));
                    }
                } else { entries.push(addition); }
            }
            entries.sort_by(|left, right| left.package_hash.cmp(&right.package_hash));
            let body = Revocations { hub_id: hub.config.hub_id.clone(), sequence: input.sequence,
                issued_at: input.issued_at, expires_at: input.expires_at, entries, key_id: hub.config.revocations_key_id.clone() };
            body.validate().map_err(|_| HubError::invalid("撤销序号、时间或完整条目无效"))?;
            let sized = SignedRevocations { revocations: body.clone(), signature: "A".repeat(86) };
            if serde_json::to_vec(&sized).map_err(|_| HubError::unavailable())?.len() > MAX_REVOCATIONS_BYTES {
                return Err(HubError::limited("完整撤销清单达到1MiB上限，须升级协议，不能截断"));
            }
            let approval = Approval { operation_id: input.operation_id.clone(), document: Document::Revocations(body),
                evidence: Evidence { license_checked: false, sources_checked: false, static_scan_passed: false,
                    preview_evidence: String::new(), reason: input.review_reason.clone() } };
            approval.validate().map_err(|_| HubError::invalid("撤销审批材料无效"))?;
            insert_operation(&mut tx, &actor, &input.sequence.to_string(), &request_digest, &approval).await?;
            tx.commit().await?;
            hub.drive_operation(&input.operation_id, true).await?.view()
        }).await.map_err(|_| HubError::unavailable())?
    }

    pub(crate) async fn signed_revocations(&self) -> Result<(String, String)> {
        let (bytes, signed, digest): (i64, Option<String>, Option<String>) = sqlx::query_as("SELECT length(CAST(signed_document AS BLOB)),CASE WHEN length(CAST(signed_document AS BLOB))<=1048576 THEN signed_document ELSE NULL END,CASE WHEN length(CAST(body_digest AS BLOB))=64 THEN body_digest ELSE NULL END FROM revocation_snapshots ORDER BY sequence DESC LIMIT 1")
            .fetch_optional(&self.pool).await?.ok_or_else(HubError::missing)?;
        if bytes <= 0 || bytes > MAX_REVOCATIONS_BYTES as i64 {
            return Err(HubError::unavailable());
        }
        let signed = signed.ok_or_else(HubError::unavailable)?;
        let digest = digest.ok_or_else(HubError::unavailable)?;
        let verified = verify_snapshot(self, signed.as_bytes())?;
        if verified.body().hub_id != self.config.hub_id || verified.canonical_digest() != digest {
            return Err(HubError::conflict("公开撤销回执与来源或正文摘要不一致"));
        }
        Ok((signed, digest))
    }
}

pub(crate) async fn publication_capacity(hub: &Hub) -> Result<()> {
    let length: i64 = sqlx::query_scalar(
        "SELECT coalesce(max(length(CAST(signed_document AS BLOB))),0) FROM revocation_snapshots",
    )
    .fetch_one(&hub.pool)
    .await?;
    if length > (MAX_REVOCATIONS_BYTES - 512) as i64 {
        return Err(HubError::limited(
            "完整撤销清单已达到容量边界，须升级协议后再新增发布",
        ));
    }
    Ok(())
}

fn verify_snapshot(hub: &Hub, bytes: &[u8]) -> Result<VerifiedRevocations> {
    let signed = SignedRevocations::parse(bytes).map_err(|_| HubError::unavailable())?;
    let key = hub
        .authorization
        .historical_key(&signed.revocations.key_id, KeyPurpose::Revocations)
        .map_err(|_| HubError::conflict("撤销密钥不在既有授权链"))?;
    signed
        .verify(&key)
        .map_err(|_| HubError::conflict("撤销完整正文签名无效"))
}

pub(crate) async fn publish(hub: &Hub, operation: &Operation, envelope: &str) -> Result<()> {
    let current = verify_snapshot(hub, envelope.as_bytes())?;
    if current.canonical_digest() != operation.body_digest
        || current.body().hub_id != hub.config.hub_id
    {
        return Err(HubError::conflict("撤销回执与原操作不一致"));
    }
    let mut tx = hub.pool.begin().await?;
    let previous: Option<Option<String>> = sqlx::query_scalar("SELECT CASE WHEN length(CAST(signed_document AS BLOB))<=1048576 THEN signed_document ELSE NULL END FROM revocation_snapshots ORDER BY sequence DESC LIMIT 1")
        .fetch_optional(&mut *tx).await?;
    let previous = previous
        .map(|bytes| bytes.ok_or_else(HubError::unavailable))
        .transpose()?;
    let previous: Option<RevocationsWatermark> = previous
        .map(|bytes| {
            let verified = verify_snapshot(hub, bytes.as_bytes())?;
            match watermarks::revocations_update(None, &hub.config.hub_id, &verified)
                .map_err(|_| HubError::unavailable())?
            {
                Update::Advance(watermark) => Ok(watermark),
                Update::Replay => Err(HubError::unavailable()),
            }
        })
        .transpose()?;
    watermarks::revocations_update(previous.as_ref(), &hub.config.hub_id, &current)
        .map_err(|_| HubError::conflict("撤销回放、同序号冲突或安全完整记录被移除"))?;
    let known: Vec<(Option<String>, i64)> = sqlx::query_as("SELECT CASE WHEN length(CAST(package_hash AS BLOB))=64 THEN package_hash ELSE NULL END,effective_at FROM revocations WHERE reason='security' LIMIT ?")
        .bind((MAX_REVOCATIONS_BYTES / 64 + 1) as i64).fetch_all(&mut *tx).await?;
    if known.len() > MAX_REVOCATIONS_BYTES / 64 {
        return Err(HubError::limited("完整安全清单已满"));
    }
    for (hash, at) in known {
        let hash = hash.ok_or_else(HubError::unavailable)?;
        if at <= 0 {
            return Err(HubError::unavailable());
        }
        if !current.body().entries.iter().any(|entry| {
            entry.package_hash == hash
                && entry.reason == RevocationReason::Security
                && entry.effective_at == at as u64
        }) {
            return Err(HubError::conflict("已知安全撤销不能从完整清单中遗漏或改动"));
        }
    }
    for entry in &current.body().entries {
        sqlx::query("INSERT INTO revocations(package_hash,reason,effective_at,snapshot_sequence) VALUES(?,?,?,?) ON CONFLICT(package_hash) DO UPDATE SET reason=excluded.reason,effective_at=excluded.effective_at,snapshot_sequence=excluded.snapshot_sequence")
            .bind(&entry.package_hash).bind(match entry.reason { RevocationReason::Security => "security", RevocationReason::Copyright => "copyright" })
            .bind(entry.effective_at as i64).bind(current.body().sequence as i64).execute(&mut *tx).await?;
    }
    sqlx::query("INSERT INTO revocation_snapshots(sequence,operation_id,body_digest,signed_document,issued_at,expires_at,published_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(sequence) DO NOTHING")
        .bind(current.body().sequence as i64).bind(&operation.operation_id).bind(&operation.body_digest).bind(envelope)
        .bind(current.body().issued_at as i64).bind(current.body().expires_at as i64).bind(now()).execute(&mut *tx).await?;
    sqlx::query("UPDATE releases SET state=CASE WHEN EXISTS(SELECT 1 FROM revocations v WHERE v.package_hash=releases.package_hash AND v.reason='security' AND v.effective_at<=?) THEN 'security_revoked' ELSE 'copyright_revoked' END WHERE state IN ('published','signed_pending_public','copyright_revoked') AND EXISTS(SELECT 1 FROM revocations v WHERE v.package_hash=releases.package_hash AND v.effective_at<=?)")
        .bind(now()).bind(now()).execute(&mut *tx).await?;
    sqlx::query("UPDATE publication_operations SET state='published',updated_at=? WHERE operation_id=? AND state='signed'")
        .bind(now()).bind(&operation.operation_id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO audit_events(actor_id,action,object_id,created_at) VALUES(?,'revocations_published',?,?)")
        .bind(&operation.actor_id).bind(current.body().sequence.to_string()).bind(now()).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
