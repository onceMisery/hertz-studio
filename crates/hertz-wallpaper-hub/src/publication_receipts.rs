// SPDX-License-Identifier: MIT
//! Exact Signer receipts over its authenticated OS channel. This module checks
//! public authorization and witnesses; publication.rs owns durable transitions.
use hertz_wallpaper::release::{KeyPurpose, SignedRelease, SignedRevocations};
use hertz_wallpaper_signer::protocol::{self as signer, Approval, Document, Response};

use crate::{
    config::canonical_id,
    error::{HubError, Result},
    model::encode,
    publication::Operation,
    store::Hub,
};

impl Hub {
    pub(crate) async fn verify_public_candidate(
        &self,
        candidate: &crate::model::Candidate,
    ) -> Result<()> {
        for id in [
            &candidate.id,
            &candidate.work_id,
            &candidate.owner_id,
            &candidate.upload_id,
        ] {
            canonical_id(id).map_err(|_| HubError::unavailable())?;
        }
        if candidate.state != "published" || candidate.signed_release.is_none() {
            return Err(HubError::missing());
        }
        let document = self.release_document(candidate)?;
        let linked: Option<Option<String>> = sqlx::query_scalar(
            "SELECT CASE WHEN length(CAST(operation_id AS BLOB))=36 THEN operation_id ELSE NULL END FROM publication_operations WHERE kind='release' AND object_id=? AND state='published' AND body_digest=?",
        )
        .bind(&candidate.id)
        .bind(&candidate.body_digest)
        .fetch_optional(&self.pool)
        .await?;
        let id = linked
            .flatten()
            .ok_or_else(|| HubError::conflict("公开候选缺少确切已发布操作回执"))?;
        let operation = self.operation(&id).await?;
        if operation.state != "published"
            || operation.kind != "release"
            || operation.object_id != candidate.id
            || operation.body_digest != document.digest().map_err(|_| HubError::unavailable())?
        {
            return Err(HubError::conflict("公开候选与原发布操作不一致"));
        }
        let response: Response = signer::parse(
            operation
                .receipt_json
                .as_deref()
                .ok_or_else(|| HubError::conflict("公开候选没有保存已签名回执"))?
                .as_bytes(),
        )
        .map_err(|_| HubError::unavailable())?;
        // Reuse the same purpose/generation, independent approval, checkpoint
        // and full signature checks that admitted the original receipt. Public
        // reads need no live Signer and continue accepting historical work keys.
        let envelope = self.verified_envelope(&operation, &response)?;
        if candidate.signed_release.as_deref() != Some(envelope.as_str()) {
            return Err(HubError::conflict("公开签名信封与原确切回执不一致"));
        }
        Ok(())
    }

    pub(crate) fn verify_approval(&self, operation: &Operation, response: &Response) -> Result<()> {
        if response.operation_id.as_deref() != Some(operation.operation_id.as_str())
            || response.body_digest.as_deref() != Some(operation.body_digest.as_str())
        {
            return Err(HubError::conflict("Signer回执未绑定原操作与正文"));
        }
        let evidence = response
            .approval_evidence
            .clone()
            .ok_or_else(HubError::unavailable)?;
        let approved = Approval {
            operation_id: operation.operation_id.clone(),
            document: operation.approval()?.document,
            evidence,
        };
        approved
            .validate()
            .map_err(|_| HubError::conflict("独立审批材料无效"))?;
        let digest = signer::hash(encode(&approved)?.as_bytes());
        if response.approval_digest.as_deref() != Some(digest.as_str()) {
            return Err(HubError::conflict("独立审批正文与证据摘要不一致"));
        }
        let approver = response
            .approver_identity
            .as_deref()
            .ok_or_else(HubError::unavailable)?;
        hertz_wallpaper_signer::platform::validate_identity(approver)
            .map_err(|_| HubError::conflict("独立审批OS主体无效"))?;
        if approver == self.config.signer_service_identity {
            return Err(HubError::conflict("Signer服务身份不能替代独立审批主体"));
        }
        Ok(())
    }

    pub(crate) fn verify_intent_proof(
        &self,
        operation: &Operation,
        response: &Response,
    ) -> Result<u64> {
        self.verify_approval(operation, response)?;
        if response.error.is_some() {
            return Err(HubError::conflict("Signer意图回执包含失败状态"));
        }
        let generation = response.key_generation.ok_or_else(HubError::unavailable)?;
        let authorization = self
            .authorization
            .generation(generation)
            .map_err(|_| HubError::conflict("Signer密钥代际尚未由部署根链授权"))?;
        let authorization_digest = authorization
            .canonical_digest()
            .map_err(|_| HubError::unavailable())?;
        if response.authorization_digest.as_deref() != Some(authorization_digest.as_str()) {
            return Err(HubError::conflict("Signer授权代际正文摘要不一致"));
        }
        let document = operation.approval()?.document;
        let purpose = match document {
            Document::Release(_) => KeyPurpose::Release,
            Document::Revocations(_) => KeyPurpose::Revocations,
        };
        if authorization
            .key(purpose)
            .map_err(|_| HubError::unavailable())?
            .key_id
            != document.key_id()
        {
            return Err(HubError::conflict("Signer意图工作密钥与原正文不一致"));
        }
        let checkpoint = response
            .checkpoint
            .as_ref()
            .ok_or_else(HubError::unavailable)?;
        if checkpoint.format_version != 1
            || checkpoint.ledger_id != self.config.signer_ledger_id
            || checkpoint.hub_id != self.config.hub_id
            || checkpoint.position == 0
            || checkpoint.position > signer::MAX_OPERATIONS as u64
            || checkpoint.key_generation < generation
            || !hertz_wallpaper::valid_sha256_hex(&checkpoint.identity_digest)
            || !hertz_wallpaper::valid_sha256_hex(&checkpoint.checkpoint_hash)
        {
            return Err(HubError::conflict("签名回执来自其它账本、来源或密钥水位"));
        }
        let checkpoint_generation = self
            .authorization
            .generation(checkpoint.key_generation)
            .map_err(|_| HubError::conflict("须先更新本机受信根授权链"))?;
        if checkpoint_generation
            .canonical_digest()
            .map_err(|_| HubError::unavailable())?
            != checkpoint.authorization_digest
        {
            return Err(HubError::conflict("签名检查点与本机根授权不一致"));
        }
        Ok(generation)
    }

    pub(crate) fn verified_envelope(
        &self,
        operation: &Operation,
        response: &Response,
    ) -> Result<String> {
        if response.state != "signed" {
            return Err(HubError::conflict("未取得已签名回执"));
        }
        let generation = self.verify_intent_proof(operation, response)?;
        let bytes = serde_json::to_vec(
            response
                .envelope
                .as_ref()
                .ok_or_else(HubError::unavailable)?,
        )
        .map_err(|_| HubError::unavailable())?;
        let actual = if operation.kind == "release" {
            let key = self
                .authorization
                .key_at(generation, KeyPurpose::Release)
                .map_err(|_| HubError::unavailable())?;
            SignedRelease::parse(&bytes)
                .and_then(|signed| signed.verify(&key))
                .map_err(|_| HubError::conflict("发布签名或完整正文验证失败"))?
                .canonical_digest()
                .to_owned()
        } else {
            let key = self
                .authorization
                .key_at(generation, KeyPurpose::Revocations)
                .map_err(|_| HubError::unavailable())?;
            SignedRevocations::parse(&bytes)
                .and_then(|signed| signed.verify(&key))
                .map_err(|_| HubError::conflict("撤销签名或完整正文验证失败"))?
                .canonical_digest()
                .to_owned()
        };
        if actual != operation.body_digest {
            return Err(HubError::conflict("Signer签名正文与原不可变审批操作不同"));
        }
        String::from_utf8(bytes).map_err(|_| HubError::unavailable())
    }
}
