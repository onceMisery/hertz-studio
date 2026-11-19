// SPDX-License-Identifier: MIT
//! Reports bind the confirmed signed release and current native identity.
use super::*;

pub(crate) async fn prepare_report(
    jobs: &ImportJobs,
    auth: &Auth,
    source: &str,
    work: &str,
    cancel: Arc<AtomicBool>,
) -> Result<ReportDraft, JobError> {
    network::canonical_uuid(work)?;
    let profile = jobs.library().trust().profile(source).await?;
    let session = auth.request_session(jobs.library(), source).await?;
    let (chain, revocations) = network::safety(&profile).await?;
    jobs.library()
        .trust()
        .accept(source, &chain, &revocations, None)
        .await?;
    net::check(auth, &session, &cancel)?;
    let bytes = network::latest(&profile, work).await?;
    let release = jobs
        .library()
        .trust()
        .accept(source, &chain, &revocations, Some((&bytes, work)))
        .await?
        .ok_or_else(|| error("release_missing", "没有可核对的已签名发布"))?;
    net::check(auth, &session, &cancel)?;
    let body = release.body();
    Ok(ReportDraft {
        display: json!({"sourceId":source,"sourceOrigin":profile.origin,"workId":work,
        "releaseId":body.release_id,"version":body.version,"packageHash":body.package_hash,
        "subject":session.account.subject}),
        profile,
        session,
        release_id: body.release_id.clone(),
        cancel,
    })
}

pub(crate) async fn report(
    jobs: &ImportJobs,
    auth: &Auth,
    draft: ReportDraft,
    operation: &str,
    reason: &str,
    description: &str,
) -> Result<Value, JobError> {
    network::canonical_uuid(operation)?;
    dto::text(description, 4000)?;
    if !matches!(reason, "security" | "copyright" | "other") {
        return Err(error("invalid_reason", "请选择安全、版权或其它原因"));
    }
    let session =
        confirmed_session(jobs, auth, &draft.profile, &draft.session, &draft.cancel).await?;
    let input = dto::SubmitReport {
        operation_id: operation,
        release_id: &draft.release_id,
        reason,
        description,
    };
    let result: Value = net::post(
        &draft.profile,
        auth,
        &session,
        &draft.cancel,
        "/v1/reports",
        Some(&input),
    )
    .await?;
    let id = result["id"].as_str().ok_or_else(|| {
        error(
            "author_result_unknown",
            "举报已发送但回执无效，请查询原编号",
        )
    })?;
    network::canonical_uuid(id)
        .map_err(|_| error("author_result_unknown", "举报回执编号无效，请查询原请求"))?;
    Ok(json!({"reportId":id,"releaseId":draft.release_id,"submitted":true}))
}

pub(crate) async fn report_detail(
    jobs: &ImportJobs,
    auth: &Auth,
    source: &str,
    id: &str,
    cancel: &AtomicBool,
) -> Result<Value, JobError> {
    network::canonical_uuid(id)?;
    let profile = jobs.library().trust().profile(source).await?;
    let session = auth.request_session(jobs.library(), source).await?;
    let report: dto::Report = net::get(
        &profile,
        auth,
        &session,
        cancel,
        &format!("/v1/reports/{id}"),
        65536,
    )
    .await?;
    report.validate()?;
    if report.id != id {
        return Err(error("community_response", "举报查询编号不匹配"));
    }
    Ok(json!({"report":report}))
}
