// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! The HTTP error surface: one shape, one place.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use vmusic_core::CoreError;

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub error: ErrorDetail,
}

#[derive(Debug, Serialize)]
pub struct ErrorDetail {
    /// Machine-readable, stable, safe to branch on.
    pub code: &'static str,
    pub message: String,
    pub request_id: String,
}

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub request_id: String,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            request_id: uuid::Uuid::new_v4().to_string(),
        }
    }

    /// 服务端自身或上游的问题。message 会原样回给前端——在线曲库这类代理
    /// 接口的报错对用户是可操作的（"受版权限制"、"稍后重试"），藏起来反而
    /// 让人不知道该怎么办。
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, "upstream_error", message.into())
    }
}

impl From<CoreError> for ApiError {
    fn from(err: CoreError) -> Self {
        let status =
            StatusCode::from_u16(err.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        Self::new(status, err.code(), err.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        tracing::warn!(
            request_id = %self.request_id,
            code = self.code,
            "request failed: {}", self.message
        );
        let status = self.status;
        (
            status,
            Json(ErrorBody {
                error: ErrorDetail {
                    code: self.code,
                    message: self.message,
                    request_id: self.request_id,
                },
            }),
        )
            .into_response()
    }
}

pub fn bad_request(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "bad_request", message.into())
}

pub fn not_found(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "not_found", message.into())
}

pub fn unauthorized() -> ApiError {
    ApiError::new(
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        "missing or bad token",
    )
}

pub type ApiResult<T> = Result<T, ApiError>;
