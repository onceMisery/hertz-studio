// SPDX-License-Identifier: MIT
//! Durable publication operations. Response loss permits querying the original
//! Signer operation; it never invents another approval or signing request ID.
use hertz_wallpaper::release::{KeyPurpose, Release};
use hertz_wallpaper_signer::protocol::{self as signer, Approval, Document, Evidence, Response};
use serde::{Deserialize, Serialize};
use sqlx::{Sqlite, Transaction};

use crate::{
    config::canonical_id,
    error::{HubError, Result},
    model::{digest, encode, now, Actor, Candidate, CANDIDATE_SELECT},
    store::Hub,
};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PublishInput {
    pub operation_id: String,
    pub body_digest: String,
    pub package_hash: String,
    pub permissions_digest: String,
}

#[derive(Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Operation {
    pub operation_id: String,
    #[serde(skip)]
    pub actor_id: String,
    pub kind: String,
    pub object_id: String,
    #[serde(skip)]
    pub request_digest: String,
    #[serde(skip)]
    pub body_json: String,
    pub body_digest: String,
    #[serde(skip)]
    pub evidence_json: String,
    pub state: String,
    #[serde(skip)]
    pub receipt_json: Option<String>,
    pub error_code: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

const OPERATION_BOUNDS:&str=concat!(
    "length(CAST(operation_id AS BLOB))=36 AND length(CAST(actor_id AS BLOB))=36 ",
    "AND kind IN ('release','revocations') AND length(CAST(object_id AS BLOB)) BETWEEN 1 AND 64 ",
    "AND length(CAST(request_digest AS BLOB))=64 AND length(CAST(body_digest AS BLOB))=64 ",
    "AND length(CAST(body_json AS BLOB)) BETWEEN 2 AND 1100000 ",
    "AND length(CAST(evidence_json AS BLOB)) BETWEEN 2 AND 16384 ",
    "AND coalesce(length(CAST(receipt_json AS BLOB)),0)<=1100000 ",
    "AND coalesce(length(CAST(error_code AS BLOB)),0)<=256 ",
    "AND state IN ('prepared','awaiting_approval','requested','unknown','signed','published','rejected') ",
    "AND typeof(created_at)='integer' AND created_at>0 ",
    "AND typeof(updated_at)='integer' AND updated_at>=created_at"
);

impl Operation {
    pub fn approval(&self) -> Result<Approval> {
        let document: Document =
            signer::parse(self.body_json.as_bytes()).map_err(|_| HubError::unavailable())?;
        let evidence: Evidence =
            signer::parse(self.evidence_json.as_bytes()).map_err(|_| HubError::unavailable())?;
        let approval = Approval {
            operation_id: self.operation_id.clone(),
            document,
            evidence,
        };
        approval.validate().map_err(|_| HubError::unavailable())?;
        let object = match &approval.document {
            Document::Release(body) => body.release_id.clone(),
            Document::Revocations(body) => body.sequence.to_string(),
        };
        if approval
            .document
            .digest()
            .map_err(|_| HubError::unavailable())?
            != self.body_digest
            || approval.document.kind() != self.kind
            || object != self.object_id
        {
            return Err(HubError::conflict("已登记操作的确切签名正文不一致"));
        }
        Ok(approval)
    }

    pub fn view(&self) -> Result<serde_json::Value> {
        Ok(
            serde_json::json!({"operation":self,"approvalTemplate":self.approval()?,
            "requiresIndependentSignerApproval":true}),
        )
    }
}

impl Hub {
    pub(crate) async fn operation_optional(&self, id: &str) -> Result<Option<Operation>> {
        canonical_id(id)?;
        let valid:Option<bool>=sqlx::query_scalar(&format!("SELECT CASE WHEN {OPERATION_BOUNDS} THEN 1 ELSE 0 END FROM publication_operations WHERE operation_id=?"))
            .bind(id).fetch_optional(&self.pool).await?;
        match valid {
            None => return Ok(None),
            Some(false) => return Err(HubError::conflict("发布账本记录超出有界合同，须运维修复")),
            Some(true) => {}
        }
        // Keep the predicate on the materializing read, including after recovery.
        let operation: Operation = sqlx::query_as(&format!(
            "SELECT * FROM publication_operations WHERE operation_id=? AND {OPERATION_BOUNDS}"
        ))
        .bind(id)
        .fetch_one(&self.pool)
        .await?;
        canonical_id(&operation.actor_id)?;
        if !hertz_wallpaper::valid_sha256_hex(&operation.request_digest) {
            return Err(HubError::unavailable());
        }
        operation.approval()?;
        Ok(Some(operation))
    }

    pub(crate) async fn operation(&self, id: &str) -> Result<Operation> {
        self.operation_optional(id)
            .await?
            .ok_or_else(HubError::missing)
    }

    pub(crate) async fn publication_status(
        &self,
        actor: &Actor,
        id: &str,
    ) -> Result<serde_json::Value> {
        if !actor.reviewer() {
            return Err(HubError::denied());
        }
        // Querying has an owned task too: an HTTP disconnect does not abandon a
        // receipt that arrived while this Hub was completing its transaction.
        let permit = self
            .operations
            .clone()
            .try_acquire_owned()
            .map_err(|_| HubError::limited("发布操作槽繁忙"))?;
        let hub = self.clone();
        let id = id.to_owned();
        tokio::spawn(async move {
            let _permit = permit;
            let _writer = hub.publication.lock().await;
            hub.drive_operation(&id, false).await?.view()
        })
        .await
        .map_err(|_| HubError::unavailable())?
    }

    pub(crate) async fn publish(
        &self,
        actor: Actor,
        release_id: String,
        input: PublishInput,
    ) -> Result<serde_json::Value> {
        if !actor.reviewer() {
            return Err(HubError::denied());
        }
        canonical_id(&release_id)?;
        canonical_id(&input.operation_id)?;
        for hash in [
            &input.body_digest,
            &input.package_hash,
            &input.permissions_digest,
        ] {
            if !hertz_wallpaper::valid_sha256_hex(hash) {
                return Err(HubError::invalid("发布须绑定完整包、权限与正文摘要"));
            }
        }
        let permit = self
            .operations
            .clone()
            .try_acquire_owned()
            .map_err(|_| HubError::limited("发布操作槽繁忙"))?;
        let hub = self.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let _writer = hub.publication.lock().await;
            let request_digest = digest(&(&release_id, &input))?;
            if let Some(existing) = hub.operation_optional(&input.operation_id).await? {
                if existing.kind != "release" || existing.object_id != release_id || existing.request_digest != request_digest {
                    return Err(HubError::conflict("原发布操作不能更换候选或正文"));
                }
                return hub.drive_operation(&existing.operation_id, matches!(existing.state.as_str(), "prepared" | "awaiting_approval")).await?.view();
            }
            crate::revocation::publication_capacity(&hub).await?;
            let mut tx = hub.pool.begin().await?;
            let candidate: Candidate = sqlx::query_as(&format!("{CANDIDATE_SELECT} WHERE id=?"))
                .bind(&release_id).fetch_optional(&mut *tx).await?.ok_or_else(HubError::missing)?;
            if candidate.owner_id == actor.id || candidate.state != "approved_pending_signature"
                || candidate.body_digest != input.body_digest || candidate.package_hash != input.package_hash
                || candidate.permissions_digest != input.permissions_digest {
                return Err(HubError::conflict("须读取已批准且未变化的确切候选"));
            }
            let document = hub.release_document(&candidate)?;
            hub.check_latest_document(&document)?;
            let evidence: Option<Option<String>> = sqlx::query_scalar("SELECT CASE WHEN length(CAST(evidence_json AS BLOB)) BETWEEN 2 AND 16384 THEN evidence_json ELSE NULL END FROM reviews WHERE release_id=? AND decision='approve' AND package_hash=? AND permissions_digest=? AND body_digest=? ORDER BY created_at DESC,id DESC LIMIT 1")
                .bind(&candidate.id).bind(&candidate.package_hash).bind(&candidate.permissions_digest).bind(&candidate.body_digest)
                .fetch_optional(&mut *tx).await?;
            let evidence: Evidence = signer::parse(evidence.ok_or_else(HubError::missing)?.ok_or_else(HubError::unavailable)?.as_bytes())
                .map_err(|_| HubError::unavailable())?;
            let approval = Approval { operation_id: input.operation_id.clone(), document, evidence };
            approval.validate().map_err(|_| HubError::conflict("Hub审核材料不完整"))?;
            insert_operation(&mut tx, &actor, &release_id, &request_digest, &approval).await?;
            tx.commit().await?;
            hub.drive_operation(&input.operation_id, true).await?.view()
        }).await.map_err(|_| HubError::unavailable())?
    }

    pub(crate) fn release_document(&self, candidate: &Candidate) -> Result<Document> {
        if candidate.body_json.len() > hertz_wallpaper::release::MAX_RELEASE_BYTES
            || candidate.kind == "web"
        {
            return Err(HubError::conflict("发布正文超限或网页尚未取得隔离资格"));
        }
        let release: Release =
            signer::parse(candidate.body_json.as_bytes()).map_err(|_| HubError::unavailable())?;
        let document = Document::Release(release.clone());
        if document.digest().map_err(|_| HubError::unavailable())? != candidate.body_digest
            || release.hub_id != self.config.hub_id
            || release.work_id != candidate.work_id
            || release.release_id != candidate.id
            || release.package_hash != candidate.package_hash
            || release.version != candidate.version as u64
            || release.bytes != candidate.bytes as u64
            || encode(&release.permissions)? != candidate.permissions_json
            || digest(&release.permissions)? != candidate.permissions_digest
        {
            return Err(HubError::conflict(
                "不可变发布正文与已审核包/权限/版本不一致",
            ));
        }
        Ok(document)
    }

    fn check_latest_document(&self, document: &Document) -> Result<()> {
        let purpose = match document {
            Document::Release(_) => KeyPurpose::Release,
            Document::Revocations(_) => KeyPurpose::Revocations,
        };
        let body = self
            .authorization
            .generation(self.authorization.watermark().generation)
            .map_err(|_| HubError::unavailable())?;
        if document.hub_id() != self.config.hub_id
            || body
                .key(purpose)
                .map_err(|_| HubError::unavailable())?
                .key_id
                != document.key_id()
        {
            return Err(HubError::conflict(
                "新签名请求须使用当前来源最新授权工作密钥",
            ));
        }
        Ok(())
    }

    pub(crate) async fn drive_operation(&self, id: &str, dispatch: bool) -> Result<Operation> {
        let operation = self.operation(id).await?;
        if matches!(operation.state.as_str(), "published" | "rejected") {
            return Ok(operation);
        }
        if operation.state == "signed" {
            self.publish_signed(&operation).await?;
            return self.operation(id).await;
        }
        let queried = self.signer.query(id, &operation.body_digest).await;
        let response = match queried {
            Ok(response) => response,
            Err(_) => {
                self.operation_state(
                    id,
                    if matches!(operation.state.as_str(), "prepared" | "awaiting_approval") {
                        "awaiting_approval"
                    } else {
                        "unknown"
                    },
                    Some("signer_unavailable"),
                )
                .await?;
                return self.operation(id).await;
            }
        };
        if response.state == "signed" {
            self.accept_receipt(&operation, response).await?;
        } else if response.state == "registered" {
            self.verify_intent_proof(&operation, &response)?;
            // This UUID/body already has a durable signing intent. Querying is
            // its only recovery path, even if the Hub still says prepared.
            self.operation_state(id, "unknown", Some("signer_intent_pending"))
                .await?;
        } else if response.state == "revoked" {
            self.verify_approval(&operation, &response)?;
            self.operation_state(id, "rejected", Some("signer_approval_revoked"))
                .await?;
        } else if response.state == "approved"
            && dispatch
            && matches!(operation.state.as_str(), "prepared" | "awaiting_approval")
        {
            self.verify_approval(&operation, &response)?;
            let approval = operation.approval()?;
            self.check_latest_document(&approval.document)?;
            let mut tx = self.pool.begin().await?;
            if operation.kind == "release" {
                let current: Candidate = sqlx::query_as(&format!("{CANDIDATE_SELECT} WHERE id=?"))
                    .bind(&operation.object_id)
                    .fetch_one(&mut *tx)
                    .await?;
                if current.state != "approved_pending_signature"
                    || self
                        .release_document(&current)?
                        .digest()
                        .map_err(|_| HubError::unavailable())?
                        != operation.body_digest
                {
                    return Err(HubError::conflict("候选已撤回或审核正文已变化"));
                }
            }
            sqlx::query("UPDATE publication_operations SET state='requested',error_code=NULL,updated_at=? WHERE operation_id=? AND state IN ('prepared','awaiting_approval')")
                .bind(now()).bind(id).execute(&mut *tx).await?;
            tx.commit().await?;
            // Only this persisted first dispatch sends a signing request. All
            // later requested/unknown operations use the query path above.
            let result = if operation.kind == "release" {
                self.signer.sign_release(id, &operation.body_digest).await
            } else {
                self.signer
                    .sign_revocations(id, &operation.body_digest)
                    .await
            };
            match result {
                Ok(response) if response.state == "signed" => {
                    self.accept_receipt(&operation, response).await?
                }
                Ok(response) if response.state == "registered" => {
                    self.verify_intent_proof(&operation, &response)?;
                    self.operation_state(id, "unknown", Some("signer_intent_pending"))
                        .await?;
                }
                Ok(response)
                    if response.state == "rejected"
                        && response.error.as_deref() != Some("operation_outcome_unknown") =>
                {
                    self.operation_state(id, "rejected", response.error.as_deref())
                        .await?;
                }
                _ => {
                    self.operation_state(id, "unknown", Some("signer_outcome_unknown"))
                        .await?
                }
            }
        } else if matches!(operation.state.as_str(), "prepared" | "awaiting_approval") {
            self.operation_state(id, "awaiting_approval", response.error.as_deref())
                .await?;
        } else {
            self.operation_state(
                id,
                "unknown",
                Some(if response.state == "approved" {
                    "signer_intent_not_registered"
                } else {
                    "signer_outcome_pending"
                }),
            )
            .await?;
        }
        let current = self.operation(id).await?;
        if current.state == "signed" {
            self.publish_signed(&current).await?;
        }
        self.operation(id).await
    }

    async fn accept_receipt(&self, operation: &Operation, response: Response) -> Result<()> {
        let envelope = self.verified_envelope(operation, &response)?;
        let mut tx = self.pool.begin().await?;
        if operation.kind == "release" {
            let candidate: Candidate = sqlx::query_as(&format!("{CANDIDATE_SELECT} WHERE id=?"))
                .bind(&operation.object_id)
                .fetch_one(&mut *tx)
                .await?;
            if !matches!(
                candidate.state.as_str(),
                "approved_pending_signature" | "signed_pending_public"
            ) || self
                .release_document(&candidate)?
                .digest()
                .map_err(|_| HubError::unavailable())?
                != operation.body_digest
            {
                return Err(HubError::conflict("签名返回时候选已失效"));
            }
            sqlx::query("UPDATE releases SET signed_release=?,state='signed_pending_public' WHERE id=? AND body_digest=? AND state IN ('approved_pending_signature','signed_pending_public')")
                .bind(envelope).bind(&candidate.id).bind(&operation.body_digest).execute(&mut *tx).await?;
        }
        sqlx::query("UPDATE publication_operations SET state='signed',receipt_json=?,error_code=NULL,updated_at=? WHERE operation_id=? AND body_digest=? AND state!='published'")
            .bind(encode(&response)?).bind(now()).bind(&operation.operation_id).bind(&operation.body_digest).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }

    async fn publish_signed(&self, operation: &Operation) -> Result<()> {
        let response: Response = signer::parse(
            operation
                .receipt_json
                .as_deref()
                .ok_or_else(HubError::unavailable)?
                .as_bytes(),
        )
        .map_err(|_| HubError::unavailable())?;
        let envelope = self.verified_envelope(operation, &response)?;
        if operation.kind == "revocations" {
            return crate::revocation::publish(self, operation, &envelope).await;
        }
        let mut tx = self.pool.begin().await?;
        let candidate: Candidate = sqlx::query_as(&format!("{CANDIDATE_SELECT} WHERE id=?"))
            .bind(&operation.object_id)
            .fetch_one(&mut *tx)
            .await?;
        if candidate.state != "signed_pending_public"
            || candidate.signed_release.as_deref() != Some(envelope.as_str())
            || self
                .release_document(&candidate)?
                .digest()
                .map_err(|_| HubError::unavailable())?
                != operation.body_digest
        {
            return Err(HubError::conflict("已签待公开事实不一致"));
        }
        let revoked: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM revocations WHERE package_hash=? AND effective_at<=?",
        )
        .bind(&candidate.package_hash)
        .bind(now())
        .fetch_one(&mut *tx)
        .await?;
        if revoked != 0 {
            return Err(HubError::conflict("已撤销包不能公开"));
        }
        sqlx::query(
            "UPDATE releases SET state='published' WHERE id=? AND state='signed_pending_public'",
        )
        .bind(&candidate.id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE publication_operations SET state='published',updated_at=? WHERE operation_id=? AND state='signed'")
            .bind(now()).bind(&operation.operation_id).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO audit_events(actor_id,action,object_id,created_at) VALUES(?,'release_published',?,?)")
            .bind(&operation.actor_id).bind(&candidate.id).bind(now()).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }

    pub(crate) async fn operation_state(
        &self,
        id: &str,
        state: &str,
        error: Option<&str>,
    ) -> Result<()> {
        let error = error.filter(|value| {
            value.len() <= 256
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        });
        // A failed public transition does not undo the stored signed receipt.
        // Keep its diagnostic visible without relabeling a known signature unknown.
        sqlx::query("UPDATE publication_operations SET state=CASE WHEN state='signed' THEN state ELSE ? END,error_code=?,updated_at=max(updated_at,?) WHERE operation_id=? AND state NOT IN ('published','rejected')")
            .bind(state).bind(error).bind(now()).bind(id).execute(&self.pool).await?;
        Ok(())
    }

    pub(crate) async fn reconcile_publications(&self) -> Result<()> {
        let Ok(mut cursor) = self.publication.try_lock() else {
            return Ok(());
        };
        let mut ids = self.publication_recovery_ids(cursor.as_deref()).await?;
        if ids.is_empty() && cursor.is_some() {
            *cursor = None;
            ids = self.publication_recovery_ids(None).await?;
        }
        for id in ids {
            let id = id.ok_or_else(HubError::unavailable)?;
            canonical_id(&id)?;
            // Progress even when this signature is valid but cannot be made public.
            // The next maintenance pass must reach later original operations.
            *cursor = Some(id.clone());
            if self.drive_operation(&id, false).await.is_err() {
                self.operation_state(&id, "unknown", Some("publication_reconciliation_failed"))
                    .await?;
            }
        }
        Ok(())
    }

    async fn publication_recovery_ids(&self, cursor: Option<&str>) -> Result<Vec<Option<String>>> {
        Ok(sqlx::query_scalar("SELECT CASE WHEN length(CAST(operation_id AS BLOB))=36 THEN operation_id ELSE NULL END FROM publication_operations WHERE state IN ('requested','unknown','signed') AND (? IS NULL OR operation_id>?) ORDER BY operation_id LIMIT 4")
            .bind(cursor).bind(cursor).fetch_all(&self.pool).await?)
    }
}

pub(crate) async fn insert_operation(
    tx: &mut Transaction<'_, Sqlite>,
    actor: &Actor,
    object: &str,
    request_digest: &str,
    approval: &Approval,
) -> Result<()> {
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM publication_operations")
        .fetch_one(&mut **tx)
        .await?;
    if count >= signer::MAX_OPERATIONS {
        return Err(HubError::limited("发布操作账本达到容量上限"));
    }
    sqlx::query("INSERT INTO publication_operations(operation_id,actor_id,kind,object_id,request_digest,body_json,body_digest,evidence_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'prepared',?,?)")
        .bind(&approval.operation_id).bind(&actor.id).bind(approval.document.kind()).bind(object).bind(request_digest)
        .bind(encode(&approval.document)?).bind(approval.document.digest().map_err(|_| HubError::invalid("签名正文无效"))?)
        .bind(encode(&approval.evidence)?).bind(now()).bind(now()).execute(&mut **tx).await?;
    Ok(())
}
