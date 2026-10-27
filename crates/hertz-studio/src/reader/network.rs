// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 阅读领域的网络错误与响应读取；公网准入由 public_net 统一持有。

use reqwest::{Client, Url};

use crate::error::{bad_request, ApiError, ApiResult};
use crate::public_net::{self, BoundedReadError, SchemePolicy};

pub(crate) fn public_url(input: &str) -> ApiResult<Url> {
    public_net::public_url(input, SchemePolicy::HttpOrHttps)
        .map_err(|_| bad_request("仅支持不含账号密码的公开 HTTP(S) 订阅地址").with_source("reader"))
}

pub(crate) fn public_client() -> ApiResult<Client> {
    public_net::client(SchemePolicy::HttpOrHttps)
        .map_err(|_| ApiError::internal("创建阅读网络客户端失败").with_source("reader"))
}

pub(super) fn request_error(err: reqwest::Error) -> ApiError {
    if err.is_timeout() {
        ApiError::upstream_timeout("阅读源请求超时，请稍后重试")
    } else {
        ApiError::upstream_rejected(format!("阅读源连接失败: {}", err.without_url()))
    }
    .with_source("reader")
}

pub(super) fn feed_too_large() -> ApiError {
    ApiError::new(
        axum::http::StatusCode::BAD_GATEWAY,
        "reader_feed_too_large",
        "订阅源超过 16 MiB 读取上限",
    )
    .with_source("reader")
}

pub(super) fn invalid_feed() -> ApiError {
    ApiError::new(
        axum::http::StatusCode::BAD_GATEWAY,
        "reader_invalid_feed",
        "地址未返回有效的 UTF-8 RSS/Atom 源，或 XML 超出解析预算",
    )
    .with_source("reader")
}

pub(super) fn unsupported_encoding() -> ApiError {
    ApiError::new(
        axum::http::StatusCode::BAD_GATEWAY,
        "reader_unsupported_encoding",
        "订阅源不是有效的 UTF-8 文本",
    )
    .with_source("reader")
}

pub(super) fn reader_busy() -> ApiError {
    ApiError::new(
        axum::http::StatusCode::TOO_MANY_REQUESTS,
        "reader_busy",
        "已有两个阅读源任务在进行，请稍后重试",
    )
    .with_source("reader")
}

pub(super) fn storage_full() -> ApiError {
    ApiError::new(
        axum::http::StatusCode::INSUFFICIENT_STORAGE,
        "reader_storage_full",
        "阅读内容已达本地容量上限，请清理不需要的订阅源",
    )
    .with_source("reader")
}

pub(super) async fn read_bounded(
    response: reqwest::Response,
    limit: usize,
    too_large: fn() -> ApiError,
) -> ApiResult<Vec<u8>> {
    match public_net::read_bounded(response, limit).await {
        Ok(bytes) => Ok(bytes),
        Err(BoundedReadError::Status(status)) => Err(ApiError::upstream_rejected(format!(
            "阅读源返回 HTTP {}",
            status
        ))
        .with_source("reader")),
        Err(BoundedReadError::TooLarge) => Err(too_large()),
        Err(BoundedReadError::Transport(err)) => Err(request_error(err)),
    }
}
