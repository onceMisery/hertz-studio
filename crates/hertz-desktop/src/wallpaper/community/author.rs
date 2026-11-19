// SPDX-License-Identifier: MIT
//! Author requests extend the original native owner, never its signing authority.
use super::{
    auth::{Auth, RequestSession},
    author_model as dto, author_transport as net, contract, error,
    model::SourceProfile,
    network,
};
use crate::wallpaper::{
    budget::{self, ControlCharge},
    jobs::{ImportJobs, JobError},
};
use serde_json::{json, Value};
use std::{
    io::{Seek, SeekFrom},
    sync::{atomic::AtomicBool, Arc},
};

#[path = "author_queries.rs"]
mod queries;
#[path = "author_reports.rs"]
mod reports;
pub(crate) use queries::{list, operation};
pub(crate) use reports::{prepare_report, report, report_detail};

pub(crate) struct PackageDraft {
    pub profile: SourceProfile,
    pub session: RequestSession,
    pub manifest: hertz_wallpaper::Manifest,
    pub hash: String,
    pub bytes: u64,
    pub file: std::fs::File,
    pub cancel: Arc<AtomicBool>,
    _charge: ControlCharge,
}
impl PackageDraft {
    pub(crate) fn display(&self) -> Value {
        json!({"sourceId":self.profile.source_id,"sourceOrigin":self.profile.origin,
            "subject":self.session.account.subject,"workId":self.manifest.work_id,
            "title":self.manifest.title,"version":self.manifest.version,"kind":kind(&self.manifest.content),
            "packageHash":self.hash,"bytes":self.bytes,"license":self.manifest.license,
            "permissions":self.manifest.permissions})
    }
}
pub(crate) struct ReportDraft {
    pub profile: SourceProfile,
    pub session: RequestSession,
    pub release_id: String,
    pub display: Value,
    pub cancel: Arc<AtomicBool>,
}

pub(super) fn kind(content: &hertz_wallpaper::Content) -> &'static str {
    match content {
        hertz_wallpaper::Content::Builtin { .. } => "builtin",
        hertz_wallpaper::Content::Composition { .. } => "composition",
        hertz_wallpaper::Content::Image { .. } => "image",
        hertz_wallpaper::Content::Video { .. } => "video",
        hertz_wallpaper::Content::Web { .. } => "web",
    }
}

pub(crate) async fn local_packages(
    jobs: &ImportJobs,
    cursor: Option<&str>,
) -> Result<Value, JobError> {
    let (works, next_cursor) = jobs.library().list_works(20, cursor).await?;
    let mut items = Vec::new();
    for work in works {
        if work.source_id != "local" || work.kind == "web" {
            continue;
        }
        if let Some(version) = jobs
            .library()
            .versions(&work.work_key)
            .await?
            .into_iter()
            .find(|v| v.state == "installed")
        {
            items.push(json!({"workKey":work.work_key,"title":work.title,"version":version.version,"packageHash":version.package_hash}));
        }
    }
    Ok(json!({"items":items,"nextCursor":next_cursor}))
}

pub(crate) async fn prepare(
    jobs: &ImportJobs,
    auth: &Auth,
    source: &str,
    work: &str,
    hash: &str,
    cancel: Arc<AtomicBool>,
) -> Result<PackageDraft, JobError> {
    let profile = jobs.library().trust().profile(source).await?;
    let session = auth.request_session(jobs.library(), source).await?;
    net::check(auth, &session, &cancel)?;
    let row = jobs
        .library()
        .get_work(work)
        .await?
        .ok_or_else(|| error("work_not_found", "本地作品不存在"))?;
    if row.source_id != "local" || !jobs.library().contains_version(work, hash).await? {
        return Err(error("author_local_required", "请从本地已发布版本选择作品"));
    }
    jobs.assets().security_check(hash)?;
    let mut file = jobs.assets().open_installed_original(hash)?;
    let expected = hash.to_owned();
    let read_cancel = Arc::clone(&cancel);
    let charge = budget::global()
        .admit_working_bytes(8 * 1024 * 1024)
        .map_err(|e| error("budget_busy", e.message.to_string()))?;
    let (file, manifest, bytes) = tokio::task::spawn_blocking(move || {
        let (bytes, actual) =
            crate::wallpaper::assets::read_source_sha256(&mut file, &read_cancel)?;
        if actual != expected {
            return Err(error(
                "package_hash_mismatch",
                "原包与选定版本的完整哈希不一致",
            ));
        }
        file.seek(SeekFrom::Start(0))
            .map_err(|_| JobError::io("无法回读固定包句柄"))?;
        let package = hertz_wallpaper::validate_package(&mut file).map_err(contract)?;
        if matches!(
            package.manifest.content,
            hertz_wallpaper::Content::Web { .. }
        ) {
            return Err(error("web_unqualified", "作者网页尚未开放上传"));
        }
        file.seek(SeekFrom::Start(0))
            .map_err(|_| JobError::io("无法重置固定包句柄"))?;
        Ok((file, package.manifest, bytes))
    })
    .await
    .map_err(|_| error("package_read_failed", "固定版本读取任务未完成"))??;
    net::check(auth, &session, &cancel)?;
    if row.remote_work_id.as_deref() != Some(manifest.work_id.as_str()) {
        return Err(error(
            "package_identity_mismatch",
            "库中的作品身份与固定包不一致",
        ));
    }
    Ok(PackageDraft {
        profile,
        session,
        manifest,
        hash: hash.to_owned(),
        bytes,
        file,
        cancel,
        _charge: charge,
    })
}

pub(crate) async fn create_work(
    jobs: &ImportJobs,
    auth: &Auth,
    draft: &PackageDraft,
    operation: &str,
) -> Result<Value, JobError> {
    network::canonical_uuid(operation)?;
    let session = check_draft(jobs, auth, draft).await?;
    let input = dto::CreateWork {
        operation_id: operation,
        work_id: &draft.manifest.work_id,
        title: &draft.manifest.title,
        license: &draft.manifest.license,
    };
    let work: dto::Work = net::post(
        &draft.profile,
        auth,
        &session,
        &draft.cancel,
        "/v1/works",
        Some(&input),
    )
    .await?;
    work.validate().map_err(net::unconfirmed_receipt)?;
    if work.id != draft.manifest.work_id {
        return Err(error(
            "author_result_unknown",
            "社区回执作品身份不一致，请查询原操作",
        ));
    }
    Ok(json!({"work":work}))
}

async fn confirmed_session(
    jobs: &ImportJobs,
    auth: &Auth,
    original_profile: &SourceProfile,
    original_session: &RequestSession,
    cancel: &AtomicBool,
) -> Result<RequestSession, JobError> {
    net::check(auth, original_session, cancel)?;
    let profile = jobs
        .library()
        .trust()
        .profile(&original_profile.source_id)
        .await?;
    if !same_source(&profile, original_profile) {
        return Err(error("source_changed", "社区来源身份已变化，请重新核对"));
    }
    let session = auth
        .request_session(jobs.library(), &profile.source_id)
        .await?;
    if !original_session.same_identity(&session) {
        return Err(error("account_changed", "账号已变化，请重新核对操作"));
    }
    net::check(auth, &session, cancel)?;
    Ok(session)
}

fn same_source(current: &SourceProfile, original: &SourceProfile) -> bool {
    current.source_id == original.source_id
        && current.origin == original.origin
        && current.hub_id == original.hub_id
        && current.root_fingerprint == original.root_fingerprint
        && current.auth.issuer == original.auth.issuer
        && current.auth.client_id == original.auth.client_id
        && current.auth.audience == original.auth.audience
        && current.auth.scopes == original.auth.scopes
        && current.auth.algorithms == original.auth.algorithms
}

async fn check_draft(
    jobs: &ImportJobs,
    auth: &Auth,
    draft: &PackageDraft,
) -> Result<RequestSession, JobError> {
    let session =
        confirmed_session(jobs, auth, &draft.profile, &draft.session, &draft.cancel).await?;
    jobs.assets().security_check(&draft.hash)?;
    Ok(session)
}

pub(crate) async fn upload(
    jobs: &ImportJobs,
    auth: &Auth,
    draft: Arc<PackageDraft>,
    operation: &str,
    existing: Option<&str>,
) -> Result<Value, JobError> {
    network::canonical_uuid(operation)?;
    let session = check_draft(jobs, auth, &draft).await?;
    let upload: dto::Upload = if let Some(id) = existing {
        network::canonical_uuid(id)?;
        net::get(
            &draft.profile,
            auth,
            &session,
            &draft.cancel,
            &format!("/v1/uploads/{id}"),
            16384,
        )
        .await?
    } else {
        let input = dto::ReserveUpload {
            operation_id: operation,
            package_hash: &draft.hash,
            bytes: draft.bytes,
            min_engine_protocol: 1,
        };
        net::post(
            &draft.profile,
            auth,
            &session,
            &draft.cancel,
            &format!("/v1/works/{}/uploads", draft.manifest.work_id),
            Some(&input),
        )
        .await?
    };
    validate_upload(&upload, &draft).map_err(|_| {
        error(
            "author_result_unknown",
            "原上传回执与确认的版本不一致，请查询原操作",
        )
    })?;
    if upload.state == "reserved" {
        let file = draft.file.try_clone().map_err(|_| {
            error(
                "author_result_unknown",
                "已申请上传但固定包暂无法读取，请查询原上传并重新核对",
            )
        })?;
        net::upload(
            &draft.profile,
            auth,
            &session,
            &draft.cancel,
            &upload.id,
            file,
            draft.bytes,
            upload.expires_at,
        )
        .await
        .map_err(|_| {
            error(
                "author_result_unknown",
                "上传未取得确定结果，请查询原上传编号",
            )
        })?;
    } else if !matches!(upload.state.as_str(), "ready" | "submitted") {
        return Ok(json!({"upload":upload}));
    }
    let session = check_draft(jobs, auth, &draft).await.map_err(|_| {
        error(
            "author_result_unknown",
            "上传后需重新登录原账号，再查询原编号",
        )
    })?;
    let current: dto::Upload = net::get(
        &draft.profile,
        auth,
        &session,
        &draft.cancel,
        &format!("/v1/uploads/{}", upload.id),
        16384,
    )
    .await
    .map_err(|_| error("author_result_unknown", "上传结果尚未读取，请查询原编号"))?;
    current.validate().map_err(net::unconfirmed_receipt)?;
    if current.id != upload.id
        || current.work_id != upload.work_id
        || current.package_hash != upload.package_hash
        || current.expected_bytes != upload.expected_bytes
        || current.min_engine_protocol != upload.min_engine_protocol
    {
        return Err(error(
            "author_result_unknown",
            "原上传回执发生变化，请查询原编号",
        ));
    }
    Ok(json!({"upload":current}))
}

pub(super) fn validate_upload(upload: &dto::Upload, draft: &PackageDraft) -> Result<(), JobError> {
    upload.validate()?;
    if upload.work_id != draft.manifest.work_id
        || upload.package_hash != draft.hash
        || upload.expected_bytes != draft.bytes
        || upload.min_engine_protocol != 1
    {
        return Err(error(
            "upload_identity_mismatch",
            "原上传与本次确认的作品、完整包和长度不一致",
        ));
    }
    Ok(())
}

pub(crate) async fn submit(
    jobs: &ImportJobs,
    auth: &Auth,
    source: &str,
    id: &str,
    hash: &str,
    cancel: &AtomicBool,
) -> Result<Value, JobError> {
    network::canonical_uuid(id)?;
    let profile = jobs.library().trust().profile(source).await?;
    let session = auth.request_session(jobs.library(), source).await?;
    let upload: dto::Upload = net::get(
        &profile,
        auth,
        &session,
        cancel,
        &format!("/v1/uploads/{id}"),
        16384,
    )
    .await?;
    upload.validate()?;
    if upload.id != id
        || upload.package_hash != hash
        || !matches!(upload.state.as_str(), "ready" | "submitted")
    {
        return Err(error(
            "upload_not_ready",
            "请先核对原上传已完整接收和确切哈希",
        ));
    }
    jobs.assets().security_check(hash)?;
    let candidate: dto::Candidate = net::post(
        &profile,
        auth,
        &session,
        cancel,
        &format!("/v1/uploads/{id}/submit"),
        None::<&Value>,
    )
    .await?;
    candidate.validate().map_err(net::unconfirmed_receipt)?;
    if candidate.work_id != upload.work_id
        || candidate.package_hash != hash
        || candidate.bytes != upload.expected_bytes
    {
        return Err(error(
            "author_result_unknown",
            "送审回执与原上传不一致，请查询原编号",
        ));
    }
    Ok(json!({"candidate":candidate}))
}

#[cfg(test)]
#[path = "author_tests.rs"]
mod tests;
