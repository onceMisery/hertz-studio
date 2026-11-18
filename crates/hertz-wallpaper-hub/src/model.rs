// SPDX-License-Identifier: MIT
use crate::{
    config::{canonical_id, text},
    error::{HubError, Result},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct CreateWork {
    pub operation_id: String,
    pub work_id: String,
    pub title: String,
    pub license: hertz_wallpaper::License,
}
impl CreateWork {
    pub fn validate(&self) -> Result<()> {
        text(&self.operation_id, 128)?;
        canonical_id(&self.work_id)?;
        text(&self.title, 120)?;
        text(&self.license.code, 128)?;
        text(&self.license.assets, 4000)?;
        if self.license.attribution.chars().count() > 4000 {
            return Err(HubError::invalid("署名说明过长"));
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct UploadInput {
    pub operation_id: String,
    pub package_hash: String,
    pub bytes: u64,
    pub min_engine_protocol: u32,
}
impl UploadInput {
    pub fn validate(&self) -> Result<()> {
        text(&self.operation_id, 128)?;
        if !hertz_wallpaper::valid_sha256_hex(&self.package_hash)
            || !(1..=hertz_wallpaper::MAX_PACKAGE_BYTES).contains(&self.bytes)
            || self.min_engine_protocol == 0
        {
            return Err(HubError::invalid("需声明完整小写SHA-256与1–512MiB包长度"));
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Upload {
    pub id: String,
    #[serde(skip)]
    pub owner_id: String,
    pub work_id: String,
    #[serde(skip)]
    pub operation_id: String,
    #[serde(skip)]
    pub operation_digest: String,
    pub package_hash: String,
    pub expected_bytes: i64,
    pub min_engine_protocol: i64,
    pub state: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub release_id: Option<String>,
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Work {
    pub id: String,
    pub title: String,
    pub license_json: String,
    pub created_at: i64,
}

#[derive(Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Candidate {
    pub id: String,
    pub work_id: String,
    #[serde(skip)]
    pub owner_id: String,
    #[serde(skip)]
    pub upload_id: String,
    pub version: i64,
    pub package_hash: String,
    pub bytes: i64,
    pub title: String,
    pub description: String,
    pub kind: String,
    pub license_json: String,
    pub permissions_json: String,
    pub permissions_digest: String,
    pub body_json: String,
    pub body_digest: String,
    pub state: String,
    pub signed_release: Option<String>,
    pub created_at: i64,
}

// Materialize only bounded fields, including when a restored DB bypassed schema
// checks. These limits cover the original HWPK1 producer: 120/4000 text chars,
// bounded license strings, two permission flags and the 64KiB release envelope.
// Invalid required fields become NULL so FromRow rejects the candidate rather
// than quietly selecting an older public version or allocating unbounded text.
pub(crate) const CANDIDATE_SELECT: &str = concat!(
    "SELECT CASE WHEN length(CAST(id AS BLOB))=36 THEN id ELSE NULL END AS id,",
    "CASE WHEN length(CAST(work_id AS BLOB))=36 THEN work_id ELSE NULL END AS work_id,",
    "CASE WHEN length(CAST(owner_id AS BLOB))=36 THEN owner_id ELSE NULL END AS owner_id,",
    "CASE WHEN length(CAST(upload_id AS BLOB))=36 THEN upload_id ELSE NULL END AS upload_id,",
    "CASE WHEN typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991 ",
    "THEN version ELSE NULL END AS version,",
    "CASE WHEN length(CAST(package_hash AS BLOB))=64 THEN package_hash ELSE NULL END AS package_hash,",
    "CASE WHEN typeof(bytes)='integer' AND bytes BETWEEN 1 AND 536870912 THEN bytes ELSE NULL END AS bytes,",
    "CASE WHEN length(CAST(title AS BLOB)) BETWEEN 1 AND 480 AND length(title)<=120 ",
    "THEN title ELSE NULL END AS title,",
    "CASE WHEN length(CAST(description AS BLOB))<=16000 AND length(description)<=4000 ",
    "THEN description ELSE NULL END AS description,",
    "CASE WHEN kind IN ('builtin','composition','image','video','web') THEN kind ELSE NULL END AS kind,",
    "CASE WHEN length(CAST(license_json AS BLOB)) BETWEEN 2 AND 4096 ",
    "THEN license_json ELSE NULL END AS license_json,",
    "CASE WHEN length(CAST(permissions_json AS BLOB)) BETWEEN 2 AND 256 ",
    "THEN permissions_json ELSE NULL END AS permissions_json,",
    "CASE WHEN length(CAST(permissions_digest AS BLOB))=64 ",
    "THEN permissions_digest ELSE NULL END AS permissions_digest,",
    "CASE WHEN length(CAST(body_json AS BLOB)) BETWEEN 2 AND 65536 ",
    "THEN body_json ELSE NULL END AS body_json,",
    "CASE WHEN length(CAST(body_digest AS BLOB))=64 THEN body_digest ELSE NULL END AS body_digest,",
    "CASE WHEN state IN ('pending_review','approved_pending_signature','signed_pending_public',",
    "'published','rejected','withdrawn','security_revoked','copyright_revoked') ",
    "THEN state ELSE NULL END AS state,",
    "CASE WHEN coalesce(length(CAST(signed_release AS BLOB)),0)<=65536 ",
    "THEN signed_release ELSE NULL END AS signed_release,",
    "CASE WHEN typeof(created_at)='integer' AND created_at BETWEEN 1 AND 9007199254740991 ",
    "THEN created_at ELSE NULL END AS created_at FROM releases"
);

#[derive(Clone)]
pub(crate) struct Actor {
    pub id: String,
    pub role: String,
}
impl Actor {
    pub fn reviewer(&self) -> bool {
        matches!(self.role.as_str(), "moderator" | "admin")
    }
}
pub(crate) fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|time| time.as_secs() as i64)
        .unwrap_or(0)
}
pub(crate) fn digest<T: Serialize>(value: &T) -> Result<String> {
    let bytes = serde_json::to_vec(value).map_err(|_| HubError::invalid("请求无法编码"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
pub(crate) fn encode<T: Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(|_| HubError::invalid("请求无法编码"))
}
