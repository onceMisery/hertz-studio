// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! External wallpaper tools carry data only; native confirmation owns actions.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::generation::WallpaperGenerationKind;
use crate::{PackageError, Result};

pub const MAX_REQUEST_BYTES: usize = 12 * 1024;
pub const MAX_REQUEST_DEPTH: usize = 16;
pub const MAX_BRIEF_BYTES: usize = 4096;
pub const MAX_OPERATION_ID_BYTES: usize = 128;
pub const MAX_CATALOG_CURSOR: u32 = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Catalog,
    Switch,
    Generate,
    Get,
}

impl Operation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Catalog => "catalog",
            Self::Switch => "switch",
            Self::Generate => "generate",
            Self::Get => "get",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogRequest {
    #[serde(default = "default_catalog_limit")]
    pub limit: u32,
    #[serde(default)]
    pub cursor: Option<u32>,
}

fn default_catalog_limit() -> u32 {
    32
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SwitchRequest {
    pub operation_id: String,
    pub work_key: String,
    pub package_hash: String,
    pub target_handle: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerateRequest {
    pub operation_id: String,
    pub brief: String,
    pub output_kind: WallpaperGenerationKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetRequest {
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum Request {
    Catalog(CatalogRequest),
    Switch(SwitchRequest),
    Generate(GenerateRequest),
    Get(GetRequest),
}

impl Request {
    pub fn operation(&self) -> Operation {
        match self {
            Self::Catalog(_) => Operation::Catalog,
            Self::Switch(_) => Operation::Switch,
            Self::Generate(_) => Operation::Generate,
            Self::Get(_) => Operation::Get,
        }
    }

    pub fn operation_id(&self) -> Option<&str> {
        match self {
            Self::Switch(input) => Some(&input.operation_id),
            Self::Generate(input) => Some(&input.operation_id),
            _ => None,
        }
    }

    pub fn canonical_bytes(&self) -> Vec<u8> {
        // Every variant contains only typed finite integers and strings.
        serde_json::to_vec(self).expect("typed request serialization is infallible")
    }

    pub fn digest(&self) -> String {
        format!("{:x}", Sha256::digest(self.canonical_bytes()))
    }
}

pub fn parse(operation: &str, bytes: &[u8]) -> Result<Request> {
    if bytes.len() > MAX_REQUEST_BYTES || std::str::from_utf8(bytes).is_err() {
        return Err(invalid("申请必须为 12 KiB 以内 UTF-8 JSON"));
    }
    crate::json::check_bounded_json(bytes, MAX_REQUEST_DEPTH)
        .map_err(|error| PackageError::new(error.code, "申请 JSON 结构无效"))?;
    let request = match operation {
        "catalog" => {
            let input: CatalogRequest = decode(bytes)?;
            if !(1..=32).contains(&input.limit)
                || input
                    .cursor
                    .is_some_and(|cursor| cursor > MAX_CATALOG_CURSOR)
            {
                return Err(invalid("目录分页超出上限"));
            }
            Request::Catalog(input)
        }
        "switch" => {
            let mut input: SwitchRequest = decode(bytes)?;
            if !valid_operation_id(&input.operation_id) {
                return Err(invalid("operationId 无效"));
            }
            if !valid_work_key(&input.work_key) {
                return Err(invalid("作品键必须为 128 字节以内的安全标识"));
            }
            input.package_hash = normalized_hash(&input.package_hash)?;
            input.target_handle = normalized_hash(&input.target_handle)?;
            Request::Switch(input)
        }
        "generate" => {
            let input: GenerateRequest = decode(bytes)?;
            if !valid_operation_id(&input.operation_id)
                || input.brief.len() > MAX_BRIEF_BYTES
                || input.brief.trim().is_empty()
                || input
                    .brief
                    .chars()
                    .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
            {
                return Err(invalid("生成描述或 operationId 无效"));
            }
            Request::Generate(input)
        }
        "get" => {
            let mut input: GetRequest = decode(bytes)?;
            input.request_id = normalized_uuid(&input.request_id)?;
            Request::Get(input)
        }
        _ => return Err(invalid("未知申请操作")),
    };
    Ok(request)
}

fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    serde_json::from_slice(bytes).map_err(|_| invalid("申请字段或类型无效"))
}

pub fn valid_operation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_OPERATION_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

/// Native library identity (including local/publisher namespaces), matching
/// the existing AI catalog contract. It remains case-sensitive opaque data.
pub fn valid_work_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn normalized_uuid(value: &str) -> Result<String> {
    if value.len() != 36 {
        return Err(invalid("申请身份必须为 UUID"));
    }
    uuid::Uuid::parse_str(value)
        .map(|id| id.hyphenated().to_string())
        .map_err(|_| invalid("申请身份必须为 UUID"))
}

fn normalized_hash(value: &str) -> Result<String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid("摘要或句柄必须为 64 位十六进制"));
    }
    Ok(value.to_ascii_lowercase())
}

fn invalid(message: &'static str) -> PackageError {
    PackageError::new("invalid_request", message)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestState {
    PendingConfirmation,
    Accepted,
    Succeeded,
    Failed,
    Rejected,
    Cancelled,
    Expired,
    Interrupted,
}

impl RequestState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PendingConfirmation => "pending_confirmation",
            Self::Accepted => "accepted",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Rejected => "rejected",
            Self::Cancelled => "cancelled",
            Self::Expired => "expired",
            Self::Interrupted => "interrupted",
        }
    }

    pub fn is_active(self) -> bool {
        matches!(self, Self::PendingConfirmation | Self::Accepted)
    }
}

/// Safe external projection. Internal origin, input and confirmation proofs
/// are never receipt fields. Timestamps use Unix seconds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub request_id: String,
    pub operation_id: String,
    pub state: RequestState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_kind: Option<WallpaperGenerationKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_operation_id: Option<String>,
    pub created_at: i64,
    pub expires_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[cfg(test)]
#[path = "external_requests_tests.rs"]
mod tests;
