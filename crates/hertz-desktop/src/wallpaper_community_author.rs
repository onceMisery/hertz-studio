// SPDX-License-Identifier: MIT
//! Current settings-window confirmation and cancellation, using the original bridge.
use super::*;
use crate::wallpaper::{
    api,
    community::{self, author},
    jobs::{ImportJobs, JobError},
};
use std::sync::atomic::{AtomicBool, Ordering};

struct Confirmation<T> {
    owner: u64,
    nonce: String,
    created: Instant,
    draft: T,
}
#[derive(Default)]
pub(super) struct State {
    package: Option<Confirmation<Arc<author::PackageDraft>>>,
    report: Option<Confirmation<Box<author::ReportDraft>>>,
    active: Option<(String, Arc<AtomicBool>)>,
}
impl State {
    pub(super) fn clear(&mut self) {
        self.package = None;
        self.report = None;
        if let Some((_, cancel)) = &self.active {
            cancel.store(true, Ordering::Release);
        }
    }
    pub(super) fn expire(&mut self) {
        if self
            .package
            .as_ref()
            .is_some_and(|v| v.created.elapsed() > Duration::from_secs(300))
        {
            self.package = None;
        }
        if self
            .report
            .as_ref()
            .is_some_and(|v| v.created.elapsed() > Duration::from_secs(300))
        {
            self.report = None;
        }
    }
    pub(super) fn finish(&mut self, id: &str) {
        if self.active.as_ref().is_some_and(|v| v.0 == id) {
            self.active = None;
        }
    }
}

fn consent(payload: &serde_json::Value) -> Result<(), JobError> {
    if payload["consent"].as_bool() != Some(true) {
        return Err(community::error(
            "confirmation_required",
            "请核对确切内容并明确确认",
        ));
    }
    Ok(())
}
fn valid<T>(ticket: &Confirmation<T>, owner: u64, nonce: &str) -> Result<(), JobError> {
    if ticket.owner != owner
        || ticket.nonce != nonce
        || ticket.created.elapsed() > Duration::from_secs(300)
    {
        return Err(community::error(
            "confirmation_expired",
            "作者或举报确认已过期，请重新核对",
        ));
    }
    Ok(())
}
fn offset(payload: &serde_json::Value) -> Result<u32, JobError> {
    let offset = payload
        .get("offset")
        .map_or(Some(0), serde_json::Value::as_u64)
        .filter(|v| *v <= 1_000_000)
        .ok_or_else(|| community::error("invalid_page", "作者分页超出界限"))?;
    Ok(offset as u32)
}

impl App {
    fn dispatch_author<F, Fut>(
        &mut self,
        request: api::Request,
        owner: u64,
        cancel: Arc<AtomicBool>,
        operation: F,
    ) -> Result<(), JobError>
    where
        F: FnOnce(Arc<ImportJobs>, Arc<community::auth::Auth>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<wallpaper_community::Outcome, JobError>>
            + Send
            + 'static,
    {
        let state = &mut self.wallpaper_community.author;
        if state.active.is_some() {
            return Err(community::error("author_busy", "请等待原作者操作退出"));
        }
        let id = request.request_id.clone();
        state.active = Some((id.clone(), cancel));
        let result = self.dispatch_community(request, owner, operation);
        if result.is_err() {
            self.wallpaper_community.author.finish(&id);
        }
        result
    }

    pub(super) fn handle_community_author(
        &mut self,
        request: api::Request,
        owner: u64,
    ) -> Result<(), JobError> {
        use wallpaper_community::{field, Outcome};
        self.wallpaper_community.author.expire();
        let payload = &request.payload;
        let cancel = Arc::new(AtomicBool::new(false));
        match request.command.as_str() {
            "wallpaper.community.authorInvalidate" => {
                self.wallpaper_community.author.clear();
                self.dispatch_community(request, owner, |_, _| async {
                    Ok(Outcome::Value(serde_json::json!({"invalidated":true})))
                })
            }
            "wallpaper.community.authorCancel" => {
                let id = field(payload, "requestId")?;
                if let Some((active, cancel)) = &self.wallpaper_community.author.active {
                    if active == &id {
                        cancel.store(true, Ordering::Release);
                    }
                }
                self.dispatch_community(request, owner, |_, _| async {
                    Ok(Outcome::Value(serde_json::json!({"cancelRequested":true})))
                })
            }
            "wallpaper.community.authorLocal" => {
                let cursor = payload["cursor"].as_str().map(str::to_owned);
                if cursor.as_ref().is_some_and(|v| v.len() > 256) {
                    return Err(community::error("invalid_page", "本地作品游标过长"));
                }
                self.dispatch_author(request, owner, cancel, move |jobs, _| async move {
                    Ok(Outcome::Value(
                        author::local_packages(&jobs, cursor.as_deref()).await?,
                    ))
                })
            }
            "wallpaper.community.authorPrepare" => {
                let source = field(payload, "sourceId")?;
                let work = field(payload, "workKey")?;
                let hash = field(payload, "packageHash")?;
                if self.wallpaper_community.author.active.is_some() {
                    return Err(community::error("author_busy", "请等待原作者操作退出"));
                }
                self.wallpaper_community.author.package = None;
                let flag = Arc::clone(&cancel);
                self.dispatch_author(request, owner, cancel, move |jobs, auth| async move {
                    Ok(Outcome::AuthorPrepared(Arc::new(
                        author::prepare(&jobs, &auth, &source, &work, &hash, flag).await?,
                    )))
                })
            }
            "wallpaper.community.authorCreate" | "wallpaper.community.authorUpload" => {
                consent(payload)?;
                let nonce = field(payload, "ticket")?;
                let operation = field(payload, "operationId")?;
                community::network::canonical_uuid(&operation)?;
                let ticket = self
                    .wallpaper_community
                    .author
                    .package
                    .as_ref()
                    .ok_or_else(|| {
                        community::error("confirmation_expired", "请重新读取本地版本")
                    })?;
                valid(ticket, owner, &nonce)?;
                if field(payload, "sourceId")? != ticket.draft.profile.source_id {
                    return Err(community::error(
                        "source_changed",
                        "社区已变化，请重新核对版本",
                    ));
                }
                self.wallpaper_community
                    .auth
                    .check_request(&ticket.draft.session)?;
                let draft = Arc::clone(&ticket.draft);
                let cancel = Arc::clone(&draft.cancel);
                if request.command.ends_with("authorCreate") {
                    self.dispatch_author(request, owner, cancel, move |jobs, auth| async move {
                        Ok(Outcome::Value(
                            author::create_work(&jobs, &auth, &draft, &operation).await?,
                        ))
                    })
                } else {
                    let existing = payload["uploadId"].as_str().map(str::to_owned);
                    if let Some(id) = &existing {
                        community::network::canonical_uuid(id)?;
                    }
                    if self.wallpaper_community.author.active.is_some() {
                        return Err(community::error("author_busy", "请等待原作者操作退出"));
                    }
                    self.wallpaper_community.author.package = None;
                    self.dispatch_author(request, owner, cancel, move |jobs, auth| async move {
                        Ok(Outcome::Value(
                            author::upload(&jobs, &auth, draft, &operation, existing.as_deref())
                                .await?,
                        ))
                    })
                }
            }
            "wallpaper.community.authorSubmit" => {
                consent(payload)?;
                let source = field(payload, "sourceId")?;
                let id = field(payload, "uploadId")?;
                let hash = field(payload, "packageHash")?;
                let flag = Arc::clone(&cancel);
                self.dispatch_author(request, owner, cancel, move |jobs, auth| async move {
                    Ok(Outcome::Value(
                        author::submit(&jobs, &auth, &source, &id, &hash, &flag).await?,
                    ))
                })
            }
            "wallpaper.community.authorList" => {
                let source = field(payload, "sourceId")?;
                let offset = offset(payload)?;
                let flag = Arc::clone(&cancel);
                self.dispatch_author(request, owner, cancel, move |jobs, auth| async move {
                    Ok(Outcome::Value(
                        author::list(&jobs, &auth, &source, offset, &flag).await?,
                    ))
                })
            }
            "wallpaper.community.authorOperation" => {
                let source = field(payload, "sourceId")?;
                let kind = field(payload, "kind")?;
                let operation = field(payload, "operationId")?;
                let upload = payload["uploadId"].as_str().map(str::to_owned);
                let local_pending = payload["originalRequestId"].as_str().is_some_and(|id| {
                    self.wallpaper_community
                        .author
                        .active
                        .as_ref()
                        .is_some_and(|active| active.0 == id)
                });
                let flag = Arc::clone(&cancel);
                self.dispatch_community(request, owner, move |jobs, auth| async move {
                    let mut value = author::operation(
                        &jobs,
                        &auth,
                        &source,
                        &kind,
                        &operation,
                        upload.as_deref(),
                        &flag,
                    )
                    .await?;
                    value["localPending"] = serde_json::json!(local_pending);
                    Ok(Outcome::Value(value))
                })
            }
            "wallpaper.community.reportPrepare" => {
                let source = field(payload, "sourceId")?;
                let work = field(payload, "remoteWorkId")?;
                self.wallpaper_community.author.report = None;
                let flag = Arc::clone(&cancel);
                self.dispatch_author(request, owner, cancel, move |jobs, auth| async move {
                    Ok(Outcome::ReportPrepared(Box::new(
                        author::prepare_report(&jobs, &auth, &source, &work, flag).await?,
                    )))
                })
            }
            "wallpaper.community.reportSubmit" => {
                consent(payload)?;
                let nonce = field(payload, "ticket")?;
                let operation = field(payload, "operationId")?;
                let reason = field(payload, "reason")?;
                let description = payload["description"]
                    .as_str()
                    .ok_or_else(|| community::error("invalid_input", "请填写举报说明"))?
                    .to_owned();
                if self.wallpaper_community.author.active.is_some() {
                    return Err(community::error("author_busy", "请等待原作者操作退出"));
                }
                let ticket = self
                    .wallpaper_community
                    .author
                    .report
                    .as_ref()
                    .ok_or_else(|| {
                        community::error("confirmation_expired", "请重新核对举报版本")
                    })?;
                valid(ticket, owner, &nonce)?;
                if field(payload, "sourceId")? != ticket.draft.profile.source_id {
                    return Err(community::error(
                        "source_changed",
                        "社区已变化，请重新核对举报版本",
                    ));
                }
                self.wallpaper_community
                    .auth
                    .check_request(&ticket.draft.session)?;
                let ticket = self
                    .wallpaper_community
                    .author
                    .report
                    .take()
                    .expect("checked report ticket");
                let cancel = Arc::clone(&ticket.draft.cancel);
                self.dispatch_author(request, owner, cancel, move |jobs, auth| async move {
                    Ok(Outcome::Value(
                        author::report(
                            &jobs,
                            &auth,
                            *ticket.draft,
                            &operation,
                            &reason,
                            &description,
                        )
                        .await?,
                    ))
                })
            }
            "wallpaper.community.reportDetail" => {
                let source = field(payload, "sourceId")?;
                let id = field(payload, "reportId")?;
                let flag = Arc::clone(&cancel);
                self.dispatch_author(request, owner, cancel, move |jobs, auth| async move {
                    Ok(Outcome::Value(
                        author::report_detail(&jobs, &auth, &source, &id, &flag).await?,
                    ))
                })
            }
            _ => Err(community::error("unknown_command", "不支持此作者命令")),
        }
    }

    pub(super) fn finish_author_prepare(
        &mut self,
        owner: u64,
        draft: Arc<author::PackageDraft>,
    ) -> Result<serde_json::Value, JobError> {
        self.wallpaper_community
            .auth
            .check_request(&draft.session)?;
        if draft.cancel.load(Ordering::Acquire) {
            return Err(community::error("cancelled", "本次读取已取消"));
        }
        let nonce = crate::wallpaper::file_tokens::random_token()?;
        let value =
            serde_json::json!({"ticket":nonce,"review":draft.display(),"expiresInSeconds":300});
        self.wallpaper_community.author.package = Some(Confirmation {
            owner,
            nonce,
            created: Instant::now(),
            draft,
        });
        Ok(value)
    }
    pub(super) fn finish_report_prepare(
        &mut self,
        owner: u64,
        draft: Box<author::ReportDraft>,
    ) -> Result<serde_json::Value, JobError> {
        self.wallpaper_community
            .auth
            .check_request(&draft.session)?;
        if draft.cancel.load(Ordering::Acquire) {
            return Err(community::error("cancelled", "本次举报核对已取消"));
        }
        let nonce = crate::wallpaper::file_tokens::random_token()?;
        let value =
            serde_json::json!({"ticket":nonce,"review":draft.display,"expiresInSeconds":300});
        self.wallpaper_community.author.report = Some(Confirmation {
            owner,
            nonce,
            created: Instant::now(),
            draft,
        });
        Ok(value)
    }
}

#[cfg(test)]
#[path = "wallpaper_community_author_tests.rs"]
mod tests;
