// SPDX-License-Identifier: MIT
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

pub type Result<T> = std::result::Result<T, HubError>;

#[derive(Debug)]
pub struct HubError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: &'static str,
}

impl HubError {
    pub fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
        }
    }
    pub fn invalid(message: &'static str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_request", message)
    }
    pub fn denied() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "permission_denied",
            "当前账号没有此操作权限",
        )
    }
    pub fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "invalid_access_token",
            "请重新登录社区",
        )
    }
    pub fn missing() -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "内容不存在或当前账号无权查看",
        )
    }
    pub fn conflict(message: &'static str) -> Self {
        Self::new(StatusCode::CONFLICT, "state_conflict", message)
    }
    pub fn limited(message: &'static str) -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, "capacity_exceeded", message)
    }
    pub fn unavailable() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "service_unavailable",
            "服务暂时不可用，请稍后查询原操作",
        )
    }
}

impl std::fmt::Display for HubError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.code)
    }
}
impl std::error::Error for HubError {}
impl From<sqlx::Error> for HubError {
    fn from(_: sqlx::Error) -> Self {
        Self::unavailable()
    }
}
impl From<std::io::Error> for HubError {
    fn from(_: std::io::Error) -> Self {
        Self::unavailable()
    }
}
impl IntoResponse for HubError {
    fn into_response(self) -> Response {
        #[derive(Serialize)]
        struct ErrorBody {
            code: &'static str,
            message: &'static str,
        }
        let mut response = (
            self.status,
            Json(ErrorBody {
                code: self.code,
                message: self.message,
            }),
        )
            .into_response();
        response.headers_mut().insert(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("no-store"),
        );
        response
    }
}
