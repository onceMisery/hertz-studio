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
    /// 在线代理错误所属的音源 id（spec §1.2）。本地接口的错误不带这个字段。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub request_id: String,
    pub source: Option<String>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            request_id: uuid::Uuid::new_v4().to_string(),
            source: None,
        }
    }

    /// 标注是哪个音源的代理调用失败（spec §1.2：错误体带 source）。
    /// 聚合搜索的单项失败另有 `FailedSource.source`，不走这里。
    pub fn with_source(mut self, source: impl Into<String>) -> Self {
        self.source = Some(source.into());
        self
    }

    /// 服务端自身或上游的问题。message 会原样回给前端——在线曲库这类代理
    /// 接口的报错对用户是可操作的（"受版权限制"、"稍后重试"），藏起来反而
    /// 让人不知道该怎么办。
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, "upstream_error", message.into())
    }

    /// 需要登录（401）。前端据此打开对应平台的登录弹窗。
    pub fn auth_required(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "auth_required", message.into())
    }

    /// 登录了但权益不足（403），如 VIP 曲。
    pub fn vip_required(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "vip_required", message.into())
    }

    /// 该音源未声明此能力（404），前端隐藏入口而非报错。
    pub fn capability_unsupported(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "capability_unsupported",
            message.into(),
        )
    }

    /// 上游明确拒收（502）。区别于 internal() 的通用 502：code 稳定可分支。
    pub fn upstream_rejected(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, "upstream_rejected", message.into())
    }

    /// 上游超时（504），前端给行内重试。
    pub fn upstream_timeout(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::GATEWAY_TIMEOUT,
            "upstream_timeout",
            message.into(),
        )
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
                    source: self.source,
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

pub fn internal(message: impl Into<String>) -> ApiError {
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        message.into(),
    )
}

pub fn unauthorized() -> ApiError {
    ApiError::new(
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        "missing or bad token",
    )
}

pub type ApiResult<T> = Result<T, ApiError>;

#[cfg(test)]
mod tests {
    use super::*;

    fn detail(source: Option<String>) -> ErrorDetail {
        ErrorDetail {
            code: "upstream_rejected",
            message: "boom".into(),
            request_id: "req-1".into(),
            source,
        }
    }

    #[test]
    fn source_is_omitted_unless_tagged() {
        // 本地接口错误不带 source：字段必须整个缺省而不是序列化成 null，
        // 前端契约里没有 source 的旧消费者才不会被噪音干扰。
        let v = serde_json::to_value(ErrorBody {
            error: detail(None),
        })
        .unwrap();
        assert!(v["error"].get("source").is_none());

        let v = serde_json::to_value(ErrorBody {
            error: detail(Some("qq".into())),
        })
        .unwrap();
        assert_eq!(v["error"]["source"], "qq");
    }

    #[test]
    fn with_source_tags_the_error_once() {
        let e = ApiError::upstream_rejected("x").with_source("netease");
        assert_eq!(e.source.as_deref(), Some("netease"));
        // 默认构造不带 source。
        assert!(ApiError::internal("x").source.is_none());
    }
}
