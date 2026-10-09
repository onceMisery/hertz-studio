// SPDX-License-Identifier: MIT

//! 播客网络错误与响应读取；公网准入由 public_net 统一持有。

use reqwest::{Client, Url};

use crate::error::{bad_request, ApiError, ApiResult};
use crate::public_net::{self, SchemePolicy};

pub(crate) fn public_url(input: &str) -> ApiResult<Url> {
    public_net::public_url(input, SchemePolicy::HttpOrHttps).map_err(|_| {
        bad_request("仅支持不含账号密码的公开 HTTP(S) 播客地址").with_source("podcast")
    })
}

/// 供播客 RSS、目录与既有音频下载器共用。音频无整体超时，下载器继续持有大小预算。
/// 首跳必须先经 `public_url`；IP 字面量不会经过 reqwest 的 DNS 解析器。
pub fn public_client() -> ApiResult<Client> {
    public_net::client(SchemePolicy::HttpOrHttps)
        .map_err(|_| ApiError::internal("创建播客网络客户端失败").with_source("podcast"))
}

pub(super) fn request_error(err: reqwest::Error) -> ApiError {
    if err.is_timeout() {
        ApiError::upstream_timeout("播客服务请求超时，请稍后重试")
    } else {
        ApiError::upstream_rejected(format!("播客服务连接失败: {}", err.without_url()))
    }
    .with_source("podcast")
}

pub(super) async fn read_bounded(
    mut response: reqwest::Response,
    limit: usize,
    too_large: fn() -> ApiError,
) -> ApiResult<Vec<u8>> {
    if !response.status().is_success() {
        return Err(ApiError::upstream_rejected(format!(
            "播客服务返回 HTTP {}",
            response.status().as_u16()
        ))
        .with_source("podcast"));
    }
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(request_error)? {
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
