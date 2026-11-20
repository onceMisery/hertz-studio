// SPDX-License-Identifier: MIT
//! Uses the original pinned HTTPS client and Auth owner, with bounded cancellation.
use super::{
    auth::{Auth, RequestSession},
    error,
    model::SourceProfile,
    network,
};
use crate::wallpaper::jobs::JobError;
use serde::{de::DeserializeOwned, Serialize};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

pub(super) fn check(
    auth: &Auth,
    session: &RequestSession,
    cancel: &AtomicBool,
) -> Result<(), JobError> {
    if cancel.load(Ordering::Acquire) {
        return Err(error("cancelled", "此社区操作已取消"));
    }
    auth.check_request(session)
}

pub(super) fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, JobError> {
    serde_json::from_slice(bytes).map_err(|_| error("community_response", "社区响应字段无效"))
}

pub(super) fn unconfirmed_receipt(_failure: JobError) -> JobError {
    error(
        "author_result_unknown",
        "请求已发送但回执未通过完整核对，请查询原操作",
    )
}

pub(super) async fn get<T: DeserializeOwned>(
    profile: &SourceProfile,
    auth: &Auth,
    session: &RequestSession,
    cancel: &AtomicBool,
    path: &str,
    maximum: usize,
) -> Result<T, JobError> {
    check(auth, session, cancel)?;
    let destination = format!("{}{path}", profile.origin);
    let future = network::authenticated_get(&destination, session.token(), maximum);
    tokio::pin!(future);
    let bytes = loop {
        tokio::select! {
            result = &mut future => break result?,
            _ = tokio::time::sleep(Duration::from_millis(50)) => check(auth, session, cancel)?,
        }
    };
    check(auth, session, cancel)?;
    decode(&bytes)
}

pub(super) async fn post<T: DeserializeOwned>(
    profile: &SourceProfile,
    auth: &Auth,
    session: &RequestSession,
    cancel: &AtomicBool,
    path: &str,
    value: Option<&impl Serialize>,
) -> Result<T, JobError> {
    check(auth, session, cancel)?;
    let body = value
        .map(serde_json::to_vec)
        .transpose()
        .map_err(|_| error("invalid_request", "作者请求编码失败"))?;
    if body.as_ref().is_some_and(|bytes| bytes.len() > 16384) {
        return Err(error("request_limit", "作者请求超过 16 KiB"));
    }
    let (client, url) = network::client(
        &format!("{}{path}", profile.origin),
        Duration::from_secs(30),
    )
    .await?;
    check(auth, session, cancel)?;
    let mut request = client
        .post(url)
        .bearer_auth(session.token())
        .header("Accept", "application/json")
        .header("Accept-Encoding", "identity");
    if let Some(bytes) = body {
        request = request
            .header("Content-Type", "application/json")
            .body(bytes);
    }
    let bytes = send(request, auth, session, cancel).await?;
    decode(&bytes).map_err(unconfirmed_receipt)
}

pub(super) async fn upload(
    profile: &SourceProfile,
    auth: &Auth,
    session: &RequestSession,
    cancel: &AtomicBool,
    upload: &super::author_model::Upload,
    file: std::fs::File,
    bytes: u64,
) -> Result<(), JobError> {
    let id = &upload.id;
    network::canonical_uuid(id)?;
    check(auth, session, cancel)?;
    let remaining = upload.expires_at.saturating_sub(super::now()).min(1800);
    if remaining == 0 {
        return Err(error("upload_expired", "原上传已到期，请核对原记录"));
    }
    let (client, url) = network::client(
        &format!("{}/v1/uploads/{id}/content", profile.origin),
        Duration::from_secs(remaining),
    )
    .await?;
    check(auth, session, cancel)?;
    let request = upload_request(&client, url, session, file, bytes);
    send(request, auth, session, cancel).await?;
    Ok(())
}

fn upload_request(
    client: &reqwest::Client,
    url: reqwest::Url,
    session: &RequestSession,
    file: std::fs::File,
    bytes: u64,
) -> reqwest::RequestBuilder {
    // reqwest's File adapter reads through a bounded ReaderStream. The native
    // fixed handle forbids writers/deletion and remains owned until send settles.
    client
        .put(url)
        .bearer_auth(session.token())
        .header("Content-Type", "application/octet-stream")
        .header("Content-Length", bytes)
        .header("Accept-Encoding", "identity")
        .body(reqwest::Body::from(tokio::fs::File::from_std(file)))
}

async fn send(
    request: reqwest::RequestBuilder,
    auth: &Auth,
    session: &RequestSession,
    cancel: &AtomicBool,
) -> Result<Vec<u8>, JobError> {
    check(auth, session, cancel)?;
    let future = async {
        let response = request
            .send()
            .await
            .map_err(|_| error("author_result_unknown", "连接中断，需查询原请求的结果"))?;
        let accepted = matches!(
            response.status(),
            reqwest::StatusCode::OK | reqwest::StatusCode::CREATED
        );
        network::bounded_write(response, 1024 * 1024)
            .await
            .map_err(|failure| {
                if accepted {
                    unconfirmed_receipt(failure)
                } else {
                    failure
                }
            })
    };
    tokio::pin!(future);
    loop {
        tokio::select! {
            result = &mut future => {
                if check(auth, session, cancel).is_err() {
                    return Err(error("author_result_unknown", "原账号或操作已变化，远端结果需按原编号查询"));
                }
                return result;
            },
            _ = tokio::time::sleep(Duration::from_millis(50)) => {
                if check(auth, session, cancel).is_err() {
                    return Err(error("author_result_unknown", "请求已停止，远端结果需按原编号查询"));
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "author_transport_tests.rs"]
mod tests;
