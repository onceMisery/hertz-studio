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

impl Upload {
    pub(crate) fn validate_read(&self) -> Result<()> {
        for id in [&self.id, &self.owner_id, &self.work_id] {
            canonical_id(id).map_err(|_| HubError::unavailable())?;
        }
        text(&self.operation_id, 128).map_err(|_| HubError::unavailable())?;
        if let Some(id) = &self.release_id {
            canonical_id(id).map_err(|_| HubError::unavailable())?;
        }
        if !hertz_wallpaper::valid_sha256_hex(&self.operation_digest)
            || !hertz_wallpaper::valid_sha256_hex(&self.package_hash)
            || !(1..=hertz_wallpaper::MAX_PACKAGE_BYTES as i64).contains(&self.expected_bytes)
            || !(1..=u32::MAX as i64).contains(&self.min_engine_protocol)
            || !(1..=9_007_199_254_740_991).contains(&self.created_at)
            || !(1..=9_007_199_254_740_991).contains(&self.expires_at)
            || !matches!(
                self.state.as_str(),
                "reserved"
                    | "receiving"
                    | "ready"
                    | "validating"
                    | "submitted"
                    | "expired"
                    | "rejected"
            )
            || (self.state == "submitted") != self.release_id.is_some()
        {
            return Err(HubError::unavailable());
        }
        Ok(())
    }
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Work {
    pub id: String,
    pub title: String,
    pub license_json: String,
    pub created_at: i64,
}

impl Work {
    pub(crate) fn validate_read(&self) -> Result<()> {
        canonical_id(&self.id).map_err(|_| HubError::unavailable())?;
        text(&self.title, 120).map_err(|_| HubError::unavailable())?;
        if self.license_json.is_empty()
            || self.license_json.len() > 4096
            || !(1..=9_007_199_254_740_991).contains(&self.created_at)
        {
            return Err(HubError::unavailable());
        }
        serde_json::from_str::<hertz_wallpaper::License>(&self.license_json)
            .map_err(|_| HubError::unavailable())?;
        Ok(())
    }
}

pub(crate) const WORK_SELECT: &str = concat!(
    "SELECT CASE WHEN length(CAST(id AS BLOB))=36 THEN id ELSE NULL END AS id,",
    "CASE WHEN length(CAST(title AS BLOB)) BETWEEN 1 AND 480 AND length(title)<=120 ",
    "THEN title ELSE NULL END AS title,",
    "CASE WHEN length(CAST(license_json AS BLOB)) BETWEEN 2 AND 4096 ",
    "THEN license_json ELSE NULL END AS license_json,",
    "CASE WHEN typeof(created_at)='integer' AND created_at BETWEEN 1 AND 9007199254740991 ",
    "THEN created_at ELSE NULL END AS created_at FROM works"
);

pub(crate) const UPLOAD_SELECT: &str = concat!(
    "SELECT CASE WHEN length(CAST(id AS BLOB))=36 THEN id ELSE NULL END AS id,",
    "CASE WHEN length(CAST(owner_id AS BLOB))=36 THEN owner_id ELSE NULL END AS owner_id,",
    "CASE WHEN length(CAST(work_id AS BLOB))=36 THEN work_id ELSE NULL END AS work_id,",
    "CASE WHEN length(CAST(operation_id AS BLOB)) BETWEEN 1 AND 128 THEN operation_id ELSE NULL END AS operation_id,",
    "CASE WHEN length(CAST(operation_digest AS BLOB))=64 THEN operation_digest ELSE NULL END AS operation_digest,",
    "CASE WHEN length(CAST(package_hash AS BLOB))=64 THEN package_hash ELSE NULL END AS package_hash,",
    "CASE WHEN typeof(expected_bytes)='integer' AND expected_bytes BETWEEN 1 AND 536870912 ",
    "THEN expected_bytes ELSE NULL END AS expected_bytes,",
    "CASE WHEN typeof(min_engine_protocol)='integer' AND min_engine_protocol BETWEEN 1 AND 4294967295 ",
    "THEN min_engine_protocol ELSE NULL END AS min_engine_protocol,",
    "CASE WHEN state IN ('reserved','receiving','ready','validating','submitted','expired','rejected') ",
    "AND ((state='submitted' AND length(CAST(release_id AS BLOB))=36) OR (state!='submitted' AND release_id IS NULL)) ",
    "THEN state ELSE NULL END AS state,",
    "CASE WHEN typeof(created_at)='integer' AND created_at BETWEEN 1 AND 9007199254740991 ",
    "THEN created_at ELSE NULL END AS created_at,",
    "CASE WHEN typeof(expires_at)='integer' AND expires_at BETWEEN 1 AND 9007199254740991 ",
    "THEN expires_at ELSE NULL END AS expires_at,",
    "CASE WHEN release_id IS NULL OR length(CAST(release_id AS BLOB))=36 THEN release_id ELSE NULL END AS release_id FROM uploads"
);

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
