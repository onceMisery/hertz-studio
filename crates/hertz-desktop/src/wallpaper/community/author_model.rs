// SPDX-License-Identifier: MIT
//! Bounded private Hub metadata. None of these DTOs carries a token or file path.
use super::{error, network};
use crate::wallpaper::jobs::JobError;
use serde::{Deserialize, Serialize};

pub(super) fn text(value: &str, maximum: usize) -> Result<(), JobError> {
    if value.trim().is_empty()
        || value.chars().count() > maximum
        || value
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
    {
        return Err(error(
            "invalid_input",
            "内容为空、过长或包含不支持的控制字符",
        ));
    }
    Ok(())
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Work {
    pub id: String,
    pub title: String,
    pub license_json: String,
}
impl Work {
    pub(super) fn validate(&self) -> Result<(), JobError> {
        network::canonical_uuid(&self.id)?;
        text(&self.title, 120)?;
        if self.license_json.len() > 4096 {
            return Err(error("community_response_limit", "作品许可超过上限"));
        }
        serde_json::from_str::<hertz_wallpaper::License>(&self.license_json)
            .map_err(|_| error("community_response", "作品许可格式无效"))?;
        Ok(())
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Upload {
    pub id: String,
    pub work_id: String,
    pub package_hash: String,
    pub expected_bytes: u64,
    pub min_engine_protocol: u32,
    pub state: String,
    pub expires_at: u64,
    pub release_id: Option<String>,
}
impl Upload {
    pub(super) fn validate(&self) -> Result<(), JobError> {
        network::canonical_uuid(&self.id)?;
        network::canonical_uuid(&self.work_id)?;
        if let Some(id) = &self.release_id {
            network::canonical_uuid(id)?;
        }
        if !hertz_wallpaper::valid_sha256_hex(&self.package_hash)
            || !(1..=hertz_wallpaper::MAX_PACKAGE_BYTES).contains(&self.expected_bytes)
            || self.min_engine_protocol == 0
            || self.expires_at > hertz_wallpaper::release::MAX_SAFE_INTEGER
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
            return Err(error(
                "community_response",
                "上传身份、长度或状态不符合合同",
            ));
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Candidate {
    pub id: String,
    pub work_id: String,
    pub version: u64,
    pub package_hash: String,
    pub bytes: u64,
    pub title: String,
    pub kind: String,
    pub state: String,
}
impl Candidate {
    pub(super) fn validate(&self) -> Result<(), JobError> {
        network::canonical_uuid(&self.id)?;
        network::canonical_uuid(&self.work_id)?;
        text(&self.title, 120)?;
        if !hertz_wallpaper::valid_sha256_hex(&self.package_hash)
            || !(1..=hertz_wallpaper::release::MAX_SAFE_INTEGER).contains(&self.version)
            || !(1..=hertz_wallpaper::MAX_PACKAGE_BYTES).contains(&self.bytes)
            || !matches!(
                self.kind.as_str(),
                "builtin" | "composition" | "image" | "video"
            )
            || !matches!(
                self.state.as_str(),
                "pending_review"
                    | "approved_pending_signature"
                    | "signed_pending_public"
                    | "published"
                    | "rejected"
                    | "withdrawn"
                    | "security_revoked"
                    | "copyright_revoked"
            )
        {
            return Err(error("community_response", "送审版本身份或状态无效"));
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Report {
    pub id: String,
    pub release_id: String,
    pub reason: String,
    pub description: String,
    pub status: String,
    pub resolution: Option<Resolution>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Resolution {
    pub reason: String,
    pub resolved_at: u64,
}
impl Report {
    pub(super) fn validate(&self) -> Result<(), JobError> {
        network::canonical_uuid(&self.id)?;
        network::canonical_uuid(&self.release_id)?;
        text(&self.description, 4000)?;
        if !matches!(self.reason.as_str(), "security" | "copyright" | "other")
            || !matches!(self.status.as_str(), "open" | "dismissed" | "escalated")
            || (self.status == "open") != self.resolution.is_none()
        {
            return Err(error("community_response", "举报结果状态无效"));
        }
        if let Some(resolution) = &self.resolution {
            text(&resolution.reason, 4000)?;
            if resolution.resolved_at > hertz_wallpaper::release::MAX_SAFE_INTEGER {
                return Err(error("community_response", "举报处理时间无效"));
            }
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Operation {
    pub operation_id: String,
    pub kind: String,
    pub found: bool,
    pub request_digest: Option<String>,
    pub result: Option<serde_json::Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CreateWork<'a> {
    pub operation_id: &'a str,
    pub work_id: &'a str,
    pub title: &'a str,
    pub license: &'a hertz_wallpaper::License,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReserveUpload<'a> {
    pub operation_id: &'a str,
    pub package_hash: &'a str,
    pub bytes: u64,
    pub min_engine_protocol: u32,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SubmitReport<'a> {
    pub operation_id: &'a str,
    pub release_id: &'a str,
    pub reason: &'a str,
    pub description: &'a str,
}
