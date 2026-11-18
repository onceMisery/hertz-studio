// SPDX-License-Identifier: MIT
//! Community wire documents. Signature verification does not establish root trust,
//! review approval, device qualification or revocation freshness by itself.

pub mod authorization;
pub mod watermarks;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

use crate::{json, valid_sha256_hex, PackageError, Permissions, Result, MAX_PACKAGE_BYTES};

pub const MAX_RELEASE_BYTES: usize = 64 * 1024;
pub const MAX_REVOCATIONS_BYTES: usize = 1024 * 1024;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const MAX_REVOCATION_LIFETIME_SECS: u64 = 24 * 60 * 60;
const MAX_DEPTH: usize = 8;
const RELEASE_DOMAIN: &[u8] = b"HERTZ-WALLPAPER-RELEASE-V1\n";
const REVOCATIONS_DOMAIN: &[u8] = b"HERTZ-WALLPAPER-REVOCATIONS-V1\n";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Release {
    pub hub_id: String,
    pub work_id: String,
    pub release_id: String,
    pub version: u64,
    pub package_hash: String,
    pub bytes: u64,
    #[serde(deserialize_with = "deserialize_permissions")]
    pub permissions: Permissions,
    pub min_engine_protocol: u32,
    pub published_at: u64,
    pub key_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedRelease {
    pub release: Release,
    pub signature: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RevocationReason {
    Security,
    Copyright,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevocationEntry {
    pub package_hash: String,
    pub reason: RevocationReason,
    pub effective_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Revocations {
    pub hub_id: String,
    pub sequence: u64,
    pub issued_at: u64,
    pub expires_at: u64,
    pub entries: Vec<RevocationEntry>,
    pub key_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedRevocations {
    pub revocations: Revocations,
    pub signature: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyPurpose {
    Release,
    Revocations,
}

/// Construct only from a caller's already validated root authorization. This
/// object deliberately cannot deserialize a key supplied by a download response.
pub struct VerificationKey {
    key_id: String,
    purpose: KeyPurpose,
    key: VerifyingKey,
}

impl VerificationKey {
    pub fn from_authorized_key(
        key_id: String,
        purpose: KeyPurpose,
        public_key: &[u8; 32],
    ) -> Result<Self> {
        validate_key_id(&key_id)?;
        let key = VerifyingKey::from_bytes(public_key)
            .map_err(|_| invalid("invalid_release_key", "发布公钥无效"))?;
        if key.is_weak() {
            return Err(invalid("invalid_release_key", "发布公钥强度无效"));
        }
        Ok(Self {
            key_id,
            purpose,
            key,
        })
    }

    fn verify(
        &self,
        key_id: &str,
        purpose: KeyPurpose,
        message: &[u8],
        signature: &str,
    ) -> Result<()> {
        if self.key_id != key_id || self.purpose != purpose {
            return Err(invalid("release_key_mismatch", "签名密钥身份或用途不匹配"));
        }
        if signature.len() != 86 {
            return Err(invalid("invalid_release_signature", "签名编码长度无效"));
        }
        let bytes = URL_SAFE_NO_PAD.decode(signature).map_err(|_| {
            invalid(
                "invalid_release_signature",
                "签名须为无 padding 的 base64url",
            )
        })?;
        if bytes.len() != 64 || URL_SAFE_NO_PAD.encode(&bytes) != signature {
            return Err(invalid("invalid_release_signature", "签名编码不规范"));
        }
        let signature = Signature::from_slice(&bytes)
            .map_err(|_| invalid("invalid_release_signature", "Ed25519 签名无效"))?;
        self.key
            .verify_strict(message, &signature)
            .map_err(|_| invalid("release_signature_rejected", "发布签名验证失败"))
    }
}

pub struct VerifiedRelease {
    body: Release,
    digest: String,
}

impl VerifiedRelease {
    pub fn body(&self) -> &Release {
        &self.body
    }
    pub fn canonical_digest(&self) -> &str {
        &self.digest
    }
}

pub struct VerifiedRevocations {
    body: Revocations,
    digest: String,
}

impl VerifiedRevocations {
    pub fn body(&self) -> &Revocations {
        &self.body
    }
    pub fn canonical_digest(&self) -> &str {
        &self.digest
    }

    /// A clock behind a previously persisted issue time cannot establish freshness.
    pub fn is_fresh(&self, now: u64, trusted_issued_at: u64) -> bool {
        now <= MAX_SAFE_INTEGER
            && now >= trusted_issued_at
            && now >= self.body.issued_at
            && now < self.body.expires_at
    }
}

impl Release {
    pub fn validate(&self) -> Result<()> {
        validate_uuid(&self.hub_id)?;
        validate_uuid(&self.work_id)?;
        validate_uuid(&self.release_id)?;
        validate_positive_integer(self.version)?;
        validate_hash(&self.package_hash)?;
        if self.bytes == 0 || self.bytes > MAX_PACKAGE_BYTES || self.min_engine_protocol == 0 {
            return Err(invalid("invalid_release", "发布包字节数或最低协议无效"));
        }
        validate_positive_integer(self.published_at)?;
        validate_key_id(&self.key_id)
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>> {
        self.validate()?;
        canonical(self, MAX_RELEASE_BYTES)
    }

    pub fn signing_bytes(&self) -> Result<Vec<u8>> {
        Ok(domain_message(RELEASE_DOMAIN, self.canonical_bytes()?))
    }
}

impl Revocations {
    pub fn validate(&self) -> Result<()> {
        validate_uuid(&self.hub_id)?;
        validate_positive_integer(self.sequence)?;
        validate_positive_integer(self.issued_at)?;
        validate_positive_integer(self.expires_at)?;
        validate_key_id(&self.key_id)?;
        if self.expires_at <= self.issued_at
            || self.expires_at - self.issued_at > MAX_REVOCATION_LIFETIME_SECS
        {
            return Err(invalid(
                "invalid_revocations",
                "撤销清单有效期须在 24 小时以内",
            ));
        }
        // Every valid wire entry needs at least its 64-byte hash. Bound typed
        // documents too, before allocating the validation index or JCS output.
        if self.entries.len() > MAX_REVOCATIONS_BYTES / 64 {
            return Err(invalid("revocations_too_large", "撤销清单超出协议上限"));
        }
        let mut hashes = BTreeSet::new();
        for entry in &self.entries {
            validate_hash(&entry.package_hash)?;
            validate_positive_integer(entry.effective_at)?;
            if !hashes.insert(&entry.package_hash) {
                return Err(invalid(
                    "invalid_revocations",
                    "撤销清单不能重复或混淆同一包哈希",
                ));
            }
        }
        Ok(())
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>> {
        self.validate()?;
        canonical(self, MAX_REVOCATIONS_BYTES)
    }

    pub fn signing_bytes(&self) -> Result<Vec<u8>> {
        Ok(domain_message(REVOCATIONS_DOMAIN, self.canonical_bytes()?))
    }
}

impl SignedRelease {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        validate_wire(bytes, MAX_RELEASE_BYTES)?;
        let document: Self = serde_json::from_slice(bytes)
            .map_err(|_| invalid("invalid_release", "发布信封字段无效"))?;
        document.release.validate()?;
        Ok(document)
    }

    pub fn verify(self, key: &VerificationKey) -> Result<VerifiedRelease> {
        let bytes = self.release.canonical_bytes()?;
        // The entire signed wire document, including its envelope, is bounded.
        canonical(&self, MAX_RELEASE_BYTES)?;
        let digest = digest(&bytes);
        let message = domain_message(RELEASE_DOMAIN, bytes);
        key.verify(
            &self.release.key_id,
            KeyPurpose::Release,
            &message,
            &self.signature,
        )?;
        Ok(VerifiedRelease {
            body: self.release,
            digest,
        })
    }
}

impl SignedRevocations {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        validate_wire(bytes, MAX_REVOCATIONS_BYTES)?;
        let document: Self = serde_json::from_slice(bytes)
            .map_err(|_| invalid("invalid_revocations", "撤销信封字段无效"))?;
        document.revocations.validate()?;
        Ok(document)
    }

    pub fn verify(self, key: &VerificationKey) -> Result<VerifiedRevocations> {
        let bytes = self.revocations.canonical_bytes()?;
        canonical(&self, MAX_REVOCATIONS_BYTES)?;
        let digest = digest(&bytes);
        let message = domain_message(REVOCATIONS_DOMAIN, bytes);
        key.verify(
            &self.revocations.key_id,
            KeyPurpose::Revocations,
            &message,
            &self.signature,
        )?;
        Ok(VerifiedRevocations {
            body: self.revocations,
            digest,
        })
    }
}

fn canonical<T: Serialize>(document: &T, limit: usize) -> Result<Vec<u8>> {
    let bytes = serde_jcs::to_vec(document)
        .map_err(|_| invalid("invalid_release", "发布正文无法规范编码"))?;
    if bytes.len() > limit {
        return Err(invalid(
            "release_document_too_large",
            "完整发布文档超出协议上限",
        ));
    }
    Ok(bytes)
}

fn validate_wire(bytes: &[u8], limit: usize) -> Result<()> {
    if bytes.is_empty() || bytes.len() > limit {
        return Err(invalid(
            "release_document_too_large",
            "完整发布文档超出协议上限",
        ));
    }
    json::check_bounded_json(bytes, MAX_DEPTH)?;
    json::check_finite_json_values(bytes)
}

fn domain_message(domain: &[u8], canonical: Vec<u8>) -> Vec<u8> {
    let mut message = Vec::with_capacity(domain.len() + canonical.len());
    message.extend_from_slice(domain);
    message.extend_from_slice(&canonical);
    message
}

fn validate_uuid(value: &str) -> Result<()> {
    let parsed = uuid::Uuid::parse_str(value)
        .map_err(|_| invalid("invalid_release_identity", "社区身份须为规范 UUID"))?;
    if value.len() != 36 || parsed.to_string() != value {
        return Err(invalid("invalid_release_identity", "社区身份须为规范 UUID"));
    }
    Ok(())
}

fn deserialize_permissions<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Permissions, D::Error> {
    // Manifest defaults are useful for local packages. Signed community bodies
    // require every field explicitly, so verification never signs added defaults.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct RequiredPermissions {
        audio_spectrum: bool,
        pointer: bool,
    }
    let permissions = RequiredPermissions::deserialize(deserializer)?;
    Ok(Permissions {
        audio_spectrum: permissions.audio_spectrum,
        pointer: permissions.pointer,
    })
}

fn validate_key_id(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(invalid("invalid_release_key", "签名密钥标识无效"));
    }
    Ok(())
}

fn validate_positive_integer(value: u64) -> Result<()> {
    if value == 0 || value > MAX_SAFE_INTEGER {
        return Err(invalid("invalid_release_integer", "发布数值须为正安全整数"));
    }
    Ok(())
}

fn validate_hash(value: &str) -> Result<()> {
    if !valid_sha256_hex(value) {
        return Err(invalid(
            "invalid_release_hash",
            "发布须使用完整小写 SHA-256",
        ));
    }
    Ok(())
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn invalid(code: &'static str, message: &str) -> PackageError {
    PackageError::new(code, message)
}
