// SPDX-License-Identifier: MIT
use serde_json::Value;
use std::{fs::File, io::Read};

use crate::{
    checkpoint::{Identity, Record},
    config::Config,
    keys::Keys,
    protocol::{self, Approval, Error, Result, MAX_FRAME},
};

pub(super) fn check_database_header(file: &mut File) -> Result<()> {
    let mut header = [0u8; 100];
    file.read_exact(&mut header)
        .map_err(|_| Error("not_a_signer_database"))?;
    let application_id = u32::from_be_bytes([header[68], header[69], header[70], header[71]]);
    let version = u32::from_be_bytes([header[60], header[61], header[62], header[63]]);
    if &header[..16] != b"SQLite format 3\0" || application_id != 0x4857_5331 || version != 2 {
        return Err(Error("not_a_signer_database"));
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
pub(super) struct ApprovalRow {
    pub operation_id: String,
    pub kind: String,
    pub body_digest: String,
    pub canonical_body: String,
    pub approval_json: String,
    pub approval_digest: String,
    pub approver_identity: String,
    pub state: String,
    pub approved_at: i64,
    pub revoked_at: Option<i64>,
}

impl ApprovalRow {
    pub fn validated(&self, config: &Config) -> Result<Approval> {
        let approval: Approval = protocol::parse(self.approval_json.as_bytes())?;
        approval.validate()?;
        config.check_document(&approval.document)?;
        Keys::check_envelope_size(&approval.document)?;
        if approval.operation_id != self.operation_id
            || approval.document.kind() != self.kind
            || approval.document.digest()? != self.body_digest
            || approval.document.canonical()? != self.canonical_body.as_bytes()
            || protocol::encode(&approval)? != self.approval_json
            || protocol::hash(self.approval_json.as_bytes()) != self.approval_digest
            || !config.is_approver(&self.approver_identity)
        {
            return Err(Error("stored_approval_mismatch"));
        }
        if self.approved_at <= 0
            || self.approved_at as u64 > hertz_wallpaper::release::MAX_SAFE_INTEGER
            || !matches!(self.state.as_str(), "approved" | "revoked")
            || (self.state == "approved") != self.revoked_at.is_none()
            || self.revoked_at.is_some_and(|at| {
                at < self.approved_at || at as u64 > hertz_wallpaper::release::MAX_SAFE_INTEGER
            })
        {
            return Err(Error("stored_approval_state_invalid"));
        }
        Ok(approval)
    }
}

#[derive(sqlx::FromRow)]
pub(super) struct Intent {
    pub position: i64,
    pub operation_id: String,
    pub body_digest: String,
    pub checkpoint_hash: String,
    pub record_json: String,
    pub envelope_json: Option<String>,
    pub signed_at: Option<i64>,
}

impl Intent {
    pub fn validated(
        &self,
        approval: &ApprovalRow,
        config: &Config,
        identity: &Identity,
        keys: &Keys,
    ) -> Result<Record> {
        let reviewed = approval.validated(config)?;
        let record: Record = protocol::parse(self.record_json.as_bytes())?;
        record.validate(identity)?;
        keys.check_record(&record)?;
        if self.position <= 0
            || record.position != self.position as u64
            || record.operation_id != self.operation_id
            || record.body_digest != self.body_digest
            || record.digest()? != self.checkpoint_hash
            || record.encoded()? != self.record_json
            || approval.operation_id != self.operation_id
            || approval.state != "approved"
            || record.approval_digest != approval.approval_digest
            || record.approver_identity != approval.approver_identity
            || record.document.canonical()? != reviewed.document.canonical()?
            || record.registered_at < approval.approved_at as u64
        {
            return Err(Error("stored_intent_mismatch"));
        }
        if self.envelope_json.is_some() != self.signed_at.is_some()
            || self.signed_at.is_some_and(|at| {
                at <= 0
                    || at as u64 > hertz_wallpaper::release::MAX_SAFE_INTEGER
                    || at < record.registered_at as i64
            })
        {
            return Err(Error("stored_signature_state_invalid"));
        }
        if let Some(envelope) = &self.envelope_json {
            if envelope.len() > MAX_FRAME {
                return Err(Error("stored_signature_too_large"));
            }
            keys.verify(&record.document, envelope.as_bytes())?;
        }
        Ok(record)
    }

    pub fn envelope(&self) -> Result<Option<Value>> {
        self.envelope_json
            .as_ref()
            .map(|value| protocol::parse(value.as_bytes()))
            .transpose()
    }
}
