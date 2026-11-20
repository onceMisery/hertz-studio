// SPDX-License-Identifier: MIT
//! Bounded read-only views of the existing author and upload ledgers.
use super::*;

pub(crate) async fn list(
    jobs: &ImportJobs,
    auth: &Auth,
    source: &str,
    offset: u32,
    cancel: &AtomicBool,
) -> Result<Value, JobError> {
    let profile = jobs.library().trust().profile(source).await?;
    let session = auth.request_session(jobs.library(), source).await?;
    let uploads: Vec<dto::Upload> = net::get(
        &profile,
        auth,
        &session,
        cancel,
        "/v1/me/uploads?limit=4&offset=0",
        65536,
    )
    .await?;
    let works: Vec<dto::Work> = net::get(
        &profile,
        auth,
        &session,
        cancel,
        "/v1/me/works?limit=20&offset=0",
        131072,
    )
    .await?;
    let candidates: Vec<dto::Candidate> = net::get(
        &profile,
        auth,
        &session,
        cancel,
        &format!("/v1/me/releases?limit=4&offset={offset}"),
        1024 * 1024,
    )
    .await?;
    if works.len() > 20 || candidates.len() > 4 || uploads.len() > 4 {
        return Err(error("community_response_limit", "作者分页超过上限"));
    }
    for item in &works {
        item.validate()?;
    }
    for item in &candidates {
        item.validate()?;
    }
    for item in &uploads {
        item.validate()?;
        if !matches!(
            item.state.as_str(),
            "reserved" | "receiving" | "ready" | "validating"
        ) {
            return Err(error("community_response", "待送审上传列表含有已结束操作"));
        }
    }
    Ok(
        json!({"works":works,"candidates":candidates,"uploads":uploads,"offset":offset,
        "nextOffset":if candidates.len()==4 {Some(offset+4)}else{None},"subject":session.account.subject}),
    )
}

pub(crate) async fn operation(
    jobs: &ImportJobs,
    auth: &Auth,
    source: &str,
    kind: &str,
    id: &str,
    upload_id: Option<&str>,
    cancel: &AtomicBool,
) -> Result<Value, JobError> {
    network::canonical_uuid(id)?;
    if !matches!(kind, "work" | "upload" | "report") {
        return Err(error("invalid_operation", "不支持此作者请求种类"));
    }
    let profile = jobs.library().trust().profile(source).await?;
    let session = auth.request_session(jobs.library(), source).await?;
    if let Some(upload_id) = upload_id {
        if kind != "upload" {
            return Err(error("invalid_operation", "上传编号不能代替其它操作"));
        }
        network::canonical_uuid(upload_id)?;
        let upload: dto::Upload = net::get(
            &profile,
            auth,
            &session,
            cancel,
            &format!("/v1/uploads/{upload_id}"),
            16384,
        )
        .await?;
        if upload.id != upload_id {
            return Err(error("community_response", "原上传编号不匹配"));
        }
        return upload_result(jobs, auth, &profile, &session, cancel, upload).await;
    }
    let op: dto::Operation = net::get(
        &profile,
        auth,
        &session,
        cancel,
        &format!("/v1/me/operations/{kind}/{id}"),
        65536,
    )
    .await?;
    if op.operation_id != id
        || op.kind != kind
        || op.found != op.result.is_some()
        || op.found
            != op
                .request_digest
                .as_ref()
                .is_some_and(|v| hertz_wallpaper::valid_sha256_hex(v))
    {
        return Err(error("community_response", "原请求查询身份或摘要不匹配"));
    }
    let Some(result) = op.result else {
        return Ok(json!({"found":false}));
    };
    match kind {
        "work" => {
            let work: dto::Work = serde_json::from_value(result)
                .map_err(|_| error("community_response", "作品回执无效"))?;
            work.validate()?;
            Ok(json!({"found":true,"work":work}))
        }
        "upload" => {
            let upload: dto::Upload = serde_json::from_value(result)
                .map_err(|_| error("community_response", "上传回执无效"))?;
            upload_result(jobs, auth, &profile, &session, cancel, upload).await
        }
        _ => {
            let report: dto::Report = serde_json::from_value(result)
                .map_err(|_| error("community_response", "举报回执无效"))?;
            report.validate()?;
            Ok(json!({"found":true,"report":report}))
        }
    }
}

async fn upload_result(
    _jobs: &ImportJobs,
    auth: &Auth,
    profile: &SourceProfile,
    session: &RequestSession,
    cancel: &AtomicBool,
    upload: dto::Upload,
) -> Result<Value, JobError> {
    upload.validate()?;
    let candidate = if let Some(id) = &upload.release_id {
        let candidate: dto::Candidate = net::get(
            profile,
            auth,
            session,
            cancel,
            &format!("/v1/releases/{id}"),
            262144,
        )
        .await?;
        candidate.validate()?;
        if candidate.id != *id
            || candidate.work_id != upload.work_id
            || candidate.package_hash != upload.package_hash
            || candidate.bytes != upload.expected_bytes
        {
            return Err(error("community_response", "送审对象与原上传回执不一致"));
        }
        Some(candidate)
    } else {
        None
    };
    Ok(json!({"found":true,"upload":upload,"candidate":candidate}))
}
