// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Official plugin UI uses the same job service and principal as HTTP.
use super::{body_as, query_as, Reply, RpcResult};
use crate::{ai::jobs, idempotency::LOCAL_OWNER, routes, state::AppState};
use serde_json::{json, Value};
use std::sync::Arc;

pub(super) async fn status(state: &Arc<AppState>) -> RpcResult {
    let owner = jobs::instance_owner(state).await?;
    Ok(Reply::ok(jobs::status(state, &owner).await?))
}

pub(super) async fn emotion_status(state: &Arc<AppState>) -> RpcResult {
    Reply::json(&crate::ai::emotion::status(state).await?)
}

pub(super) async fn emotion_classify(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: crate::ai::emotion::ClassifyRequest = body_as(body)?;
    Reply::json(&crate::ai::emotion::classify(state, request).await?)
}

pub(super) async fn emotion_locks(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let query: crate::ai::emotion::LocksQuery = query_as(query)?;
    Reply::json(&crate::ai::emotion::read_locks(state, query).await?)
}

pub(super) async fn put_emotion_locks(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: crate::ai::emotion::LocksRequest = body_as(body)?;
    Reply::json(&crate::ai::emotion::write_locks(state, request).await?)
}

pub(super) async fn delete_emotion_locks(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let query: crate::ai::emotion::LocksQuery = query_as(query)?;
    Reply::json(&crate::ai::emotion::clear_locks(state, query).await?)
}

pub(super) async fn credential_status(state: &Arc<AppState>) -> RpcResult {
    Reply::json(&crate::ai::credential::status(state).await?)
}

pub(super) async fn put_credential(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request = crate::ai::credential::CredentialRequest::from_value(body)?;
    Reply::json(&crate::ai::credential::put(state, request).await?)
}

pub(super) async fn delete_credential(state: &Arc<AppState>) -> RpcResult {
    Reply::json(&crate::ai::credential::delete(state).await?)
}

pub(super) async fn ledger(state: &Arc<AppState>, query: &Value) -> RpcResult {
    Reply::json(&crate::ai::ledger::read(state, query_as(query)?).await?)
}

pub(super) async fn create(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let body: routes::AiCreateJobRequest = body_as(body)?;
    Reply::json(
        &jobs::submit(
            state,
            LOCAL_OWNER,
            &body.brief,
            body.idempotency_key.as_deref(),
        )
        .await?,
    )
}

pub(super) async fn list(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let query: routes::AiJobsQuery = query_as(query)?;
    let owner = jobs::instance_owner(state).await?;
    let rows = jobs::list_jobs(
        state,
        LOCAL_OWNER,
        &owner,
        query.before_created_at,
        query.before_job_id.as_deref(),
        query.limit.unwrap_or(20),
    )
    .await?;
    Ok(Reply::ok(json!({ "jobs": rows })))
}

pub(super) async fn get(state: &Arc<AppState>, id: &str) -> RpcResult {
    Reply::json(&jobs::get_job(state, LOCAL_OWNER, id).await?)
}

pub(super) async fn cancel(state: &Arc<AppState>, id: &str, body: &Value) -> RpcResult {
    let body: routes::AiCancelRequest = body_as(body)?;
    Reply::json(&jobs::cancel(state, LOCAL_OWNER, id, body.expected_state_revision).await?)
}

pub(super) async fn proposal(state: &Arc<AppState>, id: &str) -> RpcResult {
    Reply::json(&jobs::get_proposal(state, LOCAL_OWNER, id).await?)
}

pub(super) async fn reject(state: &Arc<AppState>, id: &str, body: &Value) -> RpcResult {
    let body: routes::AiRejectRequest = body_as(body)?;
    Reply::json(&jobs::reject_proposal(state, LOCAL_OWNER, id, body.expected_revision).await?)
}

pub(super) async fn reset(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let body: routes::AiGuardResetRequest = body_as(body)?;
    Ok(Reply::ok(
        jobs::budget_guard_reset(state, body.expected_revision, &body.config_fingerprint).await?,
    ))
}
