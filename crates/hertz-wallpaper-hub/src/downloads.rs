// SPDX-License-Identifier: MIT
//! Downloads always resolve a DB-authorized candidate, never a caller path.
use crate::{
    error::{HubError, Result},
    http::one,
    model::Candidate,
    store::Hub,
};
use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
};
use std::{io, net::IpAddr};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

impl Hub {
    pub(crate) async fn download(
        &self,
        candidate: Candidate,
        ip: IpAddr,
        headers: &HeaderMap,
        method: &Method,
    ) -> Result<Response> {
        if matches!(
            candidate.state.as_str(),
            "security_revoked" | "copyright_revoked" | "withdrawn"
        ) {
            return Err(HubError::missing());
        }
        let revoked: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM revocations WHERE package_hash=? AND effective_at<=?",
        )
        .bind(&candidate.package_hash)
        .bind(crate::model::now())
        .fetch_one(&self.pool)
        .await?;
        if revoked != 0 {
            return Err(HubError::missing());
        }
        let etag = format!("\"{}\"", candidate.package_hash);
        if one(headers, "if-none-match")?.is_some_and(|value| {
            value.split(',').any(|tag| {
                let tag = tag.trim();
                tag == "*" || tag.strip_prefix("W/").unwrap_or(tag) == etag
            })
        }) {
            let mut response = StatusCode::NOT_MODIFIED.into_response();
            response.headers_mut().insert(header::ETAG, value(&etag)?);
            return Ok(response);
        }
        let ip_permit = self.limits.download(ip)?;
        let total_permit = self
            .downloads
            .clone()
            .try_acquire_owned()
            .map_err(|_| HubError::limited("服务下载槽暂满"))?;
        let mut file = tokio::fs::File::open(self.object(&candidate.upload_id, false)?).await?;
        let metadata = file.metadata().await?;
        let length = u64::try_from(candidate.bytes).map_err(|_| HubError::unavailable())?;
        if !metadata.is_file() || length == 0 || metadata.len() != length {
            return Err(HubError::unavailable());
        }
        // Range is defined for GET. A failed If-Range returns the complete file.
        let range =
            if method == Method::GET && one(headers, "if-range")?.is_none_or(|tag| tag == etag) {
                one(headers, "range")?
            } else {
                None
            };
        let (start, end, status) = match range {
            Some(range) => match single_range(range, length) {
                Some((start, end)) => (start, end, StatusCode::PARTIAL_CONTENT),
                None => {
                    let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
                    response
                        .headers_mut()
                        .insert(header::CONTENT_RANGE, value(&format!("bytes */{length}"))?);
                    response.headers_mut().insert(header::ETAG, value(&etag)?);
                    return Ok(response);
                }
            },
            None => (0, length - 1, StatusCode::OK),
        };
        let count = end - start + 1;
        file.seek(std::io::SeekFrom::Start(start)).await?;
        let body = if method == Method::HEAD {
            Body::empty()
        } else {
            // One 64KiB chunk is produced per poll. Both leases stay with the
            // response body through backpressure, disconnect and read errors.
            let stream = futures::stream::try_unfold(
                (file, count, ip_permit, total_permit),
                |(mut file, remaining, ip_permit, total_permit)| async move {
                    if remaining == 0 {
                        return Ok::<_, io::Error>(None);
                    }
                    let mut chunk = vec![0_u8; remaining.min(65_536) as usize];
                    let read = file.read(&mut chunk).await?;
                    if read == 0 {
                        return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
                    }
                    chunk.truncate(read);
                    Ok(Some((
                        Bytes::from(chunk),
                        (file, remaining - read as u64, ip_permit, total_permit),
                    )))
                },
            );
            Body::from_stream(stream)
        };
        let mut response = body.into_response();
        *response.status_mut() = status;
        let headers = response.headers_mut();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/octet-stream"),
        );
        headers.insert(header::CONTENT_LENGTH, value(&count.to_string())?);
        headers.insert(header::ETAG, value(&etag)?);
        headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        headers.insert(
            header::CONTENT_DISPOSITION,
            value(&format!("attachment; filename=\"{}.hwpk\"", candidate.id))?,
        );
        if status == StatusCode::PARTIAL_CONTENT {
            headers.insert(
                header::CONTENT_RANGE,
                value(&format!("bytes {start}-{end}/{length}"))?,
            );
        }
        Ok(response)
    }
}
fn value(value: &str) -> Result<HeaderValue> {
    HeaderValue::from_str(value).map_err(|_| HubError::unavailable())
}
fn single_range(value: &str, length: u64) -> Option<(u64, u64)> {
    let range = value.strip_prefix("bytes=")?;
    if range.contains(',') || range.contains(char::is_whitespace) {
        return None;
    }
    let (start, end) = range.split_once('-')?;
    let number = |s: &str| -> Option<u64> {
        if s.is_empty() || !s.bytes().all(|byte| byte.is_ascii_digit()) {
            None
        } else {
            s.parse().ok()
        }
    };
    if start.is_empty() {
        let suffix = number(end)?;
        return (suffix > 0).then_some((length.saturating_sub(suffix), length - 1));
    }
    let start = number(start)?;
    let end = if end.is_empty() {
        length - 1
    } else {
        number(end)?.min(length - 1)
    };
    (start < length && start <= end).then_some((start, end))
}
