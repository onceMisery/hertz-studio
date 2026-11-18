// SPDX-License-Identifier: MIT
use hertz_wallpaper::release::{Release, Revocations};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs::File, io::Read, path::Path};

pub const MAX_FRAME: usize = 1_100_000;
pub const MAX_OPERATIONS: i64 = 100_000;
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug)]
pub struct Error(pub &'static str);
impl From<std::io::Error> for Error {
    fn from(_: std::io::Error) -> Self {
        Self("storage_or_transport_unavailable")
    }
}
impl From<sqlx::Error> for Error {
    fn from(_: sqlx::Error) -> Self {
        Self("ledger_unavailable")
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "body",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum Document {
    Release(Release),
    Revocations(Revocations),
}
impl Document {
    pub fn canonical(&self) -> Result<Vec<u8>> {
        match self {
            Self::Release(body) => body.canonical_bytes(),
            Self::Revocations(body) => body.canonical_bytes(),
        }
        .map_err(|_| Error("invalid_document"))
    }
    pub fn digest(&self) -> Result<String> {
        Ok(hash(&self.canonical()?))
    }
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Release(_) => "release",
            Self::Revocations(_) => "revocations",
        }
    }
    pub fn hub_id(&self) -> &str {
        match self {
            Self::Release(body) => &body.hub_id,
            Self::Revocations(body) => &body.hub_id,
        }
    }
    pub fn key_id(&self) -> &str {
        match self {
            Self::Release(body) => &body.key_id,
            Self::Revocations(body) => &body.key_id,
        }
    }
    pub fn signing_bytes(&self) -> Result<Vec<u8>> {
        match self {
            Self::Release(body) => body.signing_bytes(),
            Self::Revocations(body) => body.signing_bytes(),
        }
        .map_err(|_| Error("invalid_document"))
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Evidence {
    pub license_checked: bool,
    pub sources_checked: bool,
    pub static_scan_passed: bool,
    pub preview_evidence: String,
    pub reason: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Approval {
    pub operation_id: String,
    pub document: Document,
    pub evidence: Evidence,
}
impl Approval {
    pub fn validate(&self) -> Result<()> {
        id(&self.operation_id)?;
        self.document.canonical()?;
        text(&self.evidence.reason, 4000)?;
        if self.evidence.preview_evidence.len() > 4096 {
            return Err(Error("evidence_too_large"));
        }
        if !self.evidence.preview_evidence.is_empty() {
            text(&self.evidence.preview_evidence, 4096)?;
        }
        if matches!(self.document, Document::Release(_)) {
            text(&self.evidence.preview_evidence, 1024)?;
            if !self.evidence.license_checked
                || !self.evidence.sources_checked
                || !self.evidence.static_scan_passed
            {
                return Err(Error("review_evidence_required"));
            }
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Approve {
        approval: Box<Approval>,
        confirmed_digest: String,
    },
    RevokeApproval {
        operation_id: String,
        body_digest: String,
    },
    SignRelease {
        operation_id: String,
        body_digest: String,
    },
    SignRevocations {
        operation_id: String,
        body_digest: String,
    },
    Query {
        operation_id: String,
        body_digest: String,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Response {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub envelope: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval: Option<Approval>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approver_identity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<crate::checkpoint::TailProof>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_generation: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorization_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_evidence: Option<Evidence>,
}
impl Response {
    pub fn state(state: &str) -> Self {
        Self {
            state: state.into(),
            envelope: None,
            error: None,
            approval: None,
            approver_identity: None,
            checkpoint: None,
            operation_id: None,
            body_digest: None,
            key_generation: None,
            authorization_digest: None,
            approval_digest: None,
            approval_evidence: None,
        }
    }
    pub fn error(error: Error) -> Self {
        let mut response = Self::state("rejected");
        response.error = Some(error.0.into());
        response
    }
}
pub fn parse<T: DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    if bytes.is_empty() || bytes.len() > MAX_FRAME {
        return Err(Error("frame_too_large"));
    }
    hertz_wallpaper::json::check_bounded_json(bytes, 16)
        .map_err(|_| Error("invalid_json_structure"))?;
    hertz_wallpaper::json::check_finite_json_values(bytes)
        .map_err(|_| Error("invalid_json_number"))?;
    serde_json::from_slice(bytes).map_err(|_| Error("invalid_request_fields"))
}
pub fn read_file(path: &Path, limit: usize) -> Result<Vec<u8>> {
    read_from(File::open(path)?, limit)
}
pub fn read_from(file: File, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(Error("file_too_large"));
    }
    Ok(bytes)
}
pub fn id(value: &str) -> Result<()> {
    if !uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value) {
        return Err(Error("invalid_uuid"));
    }
    Ok(())
}
pub fn text(value: &str, max: usize) -> Result<()> {
    if value.trim().is_empty()
        || value.len() > max
        || value.chars().any(|c| {
            c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
    {
        return Err(Error("invalid_text"));
    }
    Ok(())
}
pub fn body_identity(operation_id: &str, body_digest: &str) -> Result<()> {
    id(operation_id)?;
    if !hertz_wallpaper::valid_sha256_hex(body_digest) {
        return Err(Error("invalid_body_digest"));
    }
    Ok(())
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn encode<T: Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(|_| Error("encoding_failed"))
}
pub fn now() -> Result<i64> {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| Error("clock_invalid"))?
        .as_secs();
    if seconds == 0 || seconds > hertz_wallpaper::release::MAX_SAFE_INTEGER {
        return Err(Error("clock_invalid"));
    }
    Ok(seconds as i64)
}
