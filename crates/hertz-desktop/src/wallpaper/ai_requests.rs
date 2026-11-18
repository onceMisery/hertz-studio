// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Library owns bounded durable receipts; pending input belongs only to memory.

use hertz_wallpaper::external_requests::{Receipt, Request, RequestState};
use hertz_wallpaper::generation::WallpaperGenerationKind;
use sqlx::{FromRow, SqliteConnection};

use super::{jobs::JobError, library::Library};

type Result<T> = std::result::Result<T, JobError>;

pub(crate) const MAX_ACTIVE_REQUESTS: i64 = 4;
pub(crate) const MAX_FREQUENCY_EVENTS: i64 = 1024;
pub(crate) const REQUEST_TTL_SECS: i64 = 120;
pub(crate) const RECEIPT_RETENTION_SECS: i64 = 600;

/// Constructed only after native/service authentication. Subject is the
/// service owner's digest of owner/grant. The binding covers native facts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Origin {
    pub(crate) subject_digest: String,
    pub(crate) credential_revision: String,
    pub(crate) binding_digest: String,
    pub(crate) label: String,
}

impl Origin {
    pub(crate) fn new(
        subject: &str,
        credential_revision: &str,
        binding_digest: &str,
        label: &str,
    ) -> Result<Self> {
        if !hertz_wallpaper::valid_sha256_hex(subject)
            || !hertz_wallpaper::valid_sha256_hex(credential_revision)
            || !hertz_wallpaper::valid_sha256_hex(binding_digest)
            || label.is_empty()
            || label.len() > 128
            || label.chars().any(char::is_control)
        {
            return Err(JobError::new("ai_request_origin_invalid", "申请来源无效"));
        }
        Ok(Self {
            subject_digest: subject.into(),
            credential_revision: credential_revision.into(),
            binding_digest: binding_digest.into(),
            label: label.into(),
        })
    }
}

#[derive(Clone)]
pub(crate) struct PendingRequest {
    pub(crate) request_id: String,
    pub(crate) origin: Origin,
    pub(crate) request: Request,
    pub(crate) digest: String,
    pub(crate) expires_at: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct Outcome {
    pub(crate) state: RequestState,
    pub(crate) job_id: Option<String>,
    pub(crate) native_operation_id: Option<String>,
    pub(crate) error_code: Option<String>,
}

pub(crate) struct AiRequests<'a>(&'a Library);

#[cfg(test)]
#[derive(Default)]
pub(crate) struct AdmitCommitHook {
    pub(crate) committed: tokio::sync::Notify,
    pub(crate) release: tokio::sync::Notify,
}

impl<'a> AiRequests<'a> {
    pub(crate) fn new(library: &'a Library) -> Self {
        Self(library)
    }

    pub(crate) async fn replay(
        &self,
        origin: &Origin,
        request: &Request,
        now: i64,
    ) -> Result<Option<Receipt>> {
        validate_origin(origin)?;
        validate_time(now)?;
        let request = normalized_request(request)?;
        let _writer = self.0.ai_requests_writer.lock().await;
        self.maintenance_locked(now).await?;
        let existing: Option<Row> =
            sqlx::query_as("SELECT * FROM ai_requests WHERE subject_digest=? AND operation_id=?")
                .bind(&origin.subject_digest)
                .bind(request.operation_id())
                .fetch_optional(self.0.pool())
                .await
                .map_err(database)?;
        existing
            .map(|row| {
                if row.payload_digest != request.digest() {
                    return Err(conflict());
                }
                if row.credential_revision != origin.credential_revision {
                    return Err(origin_changed());
                }
                row.receipt()
            })
            .transpose()
    }

    pub(crate) async fn admit(
        &self,
        origin: &Origin,
        request: &Request,
        now: i64,
    ) -> Result<Receipt> {
        validate_origin(origin)?;
        validate_time(now)?;
        // Revalidate even crate-internal callers constructing DTOs directly.
        let request = normalized_request(request)?;
        let operation_id = request
            .operation_id()
            .ok_or_else(|| JobError::invalid_input("此操作不能创建申请"))?;
        let digest = request.digest();
        let _writer = self.0.ai_requests_writer.lock().await;
        let mut tx = self
            .0
            .pool()
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database)?;
        maintenance_in(&mut tx, now).await?;
        let existing: Option<Row> =
            sqlx::query_as("SELECT * FROM ai_requests WHERE subject_digest=? AND operation_id=?")
                .bind(&origin.subject_digest)
                .bind(operation_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(database)?;
        if let Some(row) = existing {
            if row.payload_digest != digest {
                return Err(conflict());
            }
            if row.credential_revision != origin.credential_revision {
                return Err(origin_changed());
            }
            let receipt = row.receipt()?;
            tx.commit().await.map_err(database)?;
            self.prune_input(now)?;
            return Ok(receipt);
        }
        let active: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM ai_requests WHERE state IN ('pending_confirmation','accepted')",
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(database)?;
        if active >= MAX_ACTIVE_REQUESTS {
            return Err(JobError::new(
                "ai_request_capacity_exceeded",
                "已有四个活动申请，请稍后重试",
            ));
        }
        let attempts: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM ai_request_frequency WHERE subject_digest=? AND admitted_at>?",
        )
        .bind(&origin.subject_digest)
        .bind(now.saturating_sub(60))
        .fetch_one(&mut *tx)
        .await
        .map_err(database)?;
        if attempts >= 4 {
            return Err(JobError::new(
                "ai_request_rate_limited",
                "每分钟最多提出四次申请",
            ));
        }
        let events: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_request_frequency")
            .fetch_one(&mut *tx)
            .await
            .map_err(database)?;
        if events >= MAX_FREQUENCY_EVENTS {
            return Err(JobError::new(
                "ai_request_frequency_capacity_exceeded",
                "申请频率记录已满，请稍后重试",
            ));
        }
        super::ai_receipt_budget::ensure_room(
            &mut tx,
            super::ai_receipt_budget::Reservation::ExternalRequest,
        )
        .await?;
        let request_id = uuid::Uuid::new_v4().to_string();
        let output_kind = match &request {
            Request::Generate(input) => Some(input.output_kind),
            _ => None,
        };
        sqlx::query("INSERT INTO ai_requests(request_id,subject_digest,credential_revision,binding_digest,operation_id,payload_digest,operation,output_kind,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,'pending_confirmation',?,?)")
            .bind(&request_id).bind(&origin.subject_digest).bind(&origin.credential_revision).bind(&origin.binding_digest)
            .bind(operation_id).bind(&digest).bind(request.operation().as_str()).bind(output_kind.map(kind_str)).bind(now).bind(now+REQUEST_TTL_SECS)
            .execute(&mut *tx).await.map_err(database)?;
        sqlx::query("INSERT INTO ai_request_frequency(admission_id,subject_digest,admitted_at) VALUES(?,?,?)")
            .bind(&request_id).bind(&origin.subject_digest).bind(now).execute(&mut *tx).await.map_err(database)?;
        let row = row_in(&mut tx, origin, &request_id).await?;
        tx.commit().await.map_err(database)?;
        #[cfg(test)]
        {
            let hook = self
                .0
                .ai_request_commit_hook
                .lock()
                .map_err(|_| memory_error())?
                .clone();
            if let Some(hook) = hook {
                hook.committed.notify_one();
                hook.release.notified().await;
            }
        }
        // The async writer owns the whole handoff; no synchronous input-map
        // lock spans SQLite. Native confirmation can use input only after this.
        self.prune_input(now)?;
        let mut inputs = self
            .0
            .ai_request_inputs
            .lock()
            .map_err(|_| memory_error())?;
        debug_assert!(inputs.len() < MAX_ACTIVE_REQUESTS as usize);
        inputs.insert(
            request_id.clone(),
            PendingRequest {
                request_id,
                origin: origin.clone(),
                request,
                digest,
                expires_at: now + REQUEST_TTL_SECS,
            },
        );
        row.receipt()
    }

    /// Same grant/revision may read a receipt after UI/native binding changes.
    pub(crate) async fn get(&self, origin: &Origin, request_id: &str, now: i64) -> Result<Receipt> {
        validate_origin(origin)?;
        let _writer = self.0.ai_requests_writer.lock().await;
        self.maintenance_locked(now).await?;
        let mut connection = self.0.pool().acquire().await.map_err(database)?;
        row_in(&mut connection, origin, request_id).await?.receipt()
    }

    /// This projection is native-only; the external receipt excludes input.
    pub(crate) async fn pending(&self, now: i64) -> Result<Vec<PendingRequest>> {
        let _writer = self.0.ai_requests_writer.lock().await;
        self.maintenance_locked(now).await?;
        let ids: Vec<String> = sqlx::query_scalar("SELECT request_id FROM ai_requests WHERE state='pending_confirmation' ORDER BY created_at,request_id LIMIT 4")
            .fetch_all(self.0.pool()).await.map_err(database)?;
        let inputs = self
            .0
            .ai_request_inputs
            .lock()
            .map_err(|_| memory_error())?;
        Ok(ids
            .iter()
            .filter_map(|id| inputs.get(id).cloned())
            .collect())
    }

    pub(crate) async fn reject(
        &self,
        origin: &Origin,
        request_id: &str,
        now: i64,
    ) -> Result<Receipt> {
        self.finish_pending(origin, request_id, RequestState::Rejected, now)
            .await
    }

    async fn finish_pending(
        &self,
        origin: &Origin,
        request_id: &str,
        state: RequestState,
        now: i64,
    ) -> Result<Receipt> {
        validate_origin(origin)?;
        validate_time(now)?;
        let _writer = self.0.ai_requests_writer.lock().await;
        let mut tx = self
            .0
            .pool()
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database)?;
        maintenance_in(&mut tx, now).await?;
        let row = row_in(&mut tx, origin, request_id).await?;
        require_binding(&row, origin)?;
        if row.state == state.as_str() {
            let receipt = row.receipt()?;
            tx.commit().await.map_err(database)?;
            self.remove_input(request_id)?;
            return Ok(receipt);
        }
        if row.state != "pending_confirmation" {
            return Err(state_changed());
        }
        sqlx::query("UPDATE ai_requests SET state=?,terminal_at=? WHERE request_id=? AND state='pending_confirmation'")
            .bind(state.as_str()).bind(now).bind(request_id).execute(&mut *tx).await.map_err(database)?;
        let receipt = row_in(&mut tx, origin, request_id).await?.receipt()?;
        tx.commit().await.map_err(database)?;
        self.remove_input(request_id)?;
        Ok(receipt)
    }

    /// A non-secret service acceptance ID records one authority handoff. This
    /// performs no action, provider call, configuration write or job creation.
    pub(crate) async fn accept(
        &self,
        origin: &Origin,
        request_id: &str,
        digest: &str,
        acceptance_id: &str,
        now: i64,
    ) -> Result<Receipt> {
        validate_origin(origin)?;
        validate_time(now)?;
        let _writer = self.0.ai_requests_writer.lock().await;
        if !hertz_wallpaper::valid_sha256_hex(digest)
            || !hertz_wallpaper::external_requests::valid_operation_id(acceptance_id)
        {
            return Err(JobError::invalid_input("申请受理身份无效"));
        }
        let mut tx = self
            .0
            .pool()
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database)?;
        maintenance_in(&mut tx, now).await?;
        let row = row_in(&mut tx, origin, request_id).await?;
        require_binding(&row, origin)?;
        if row.payload_digest != digest {
            return Err(conflict());
        }
        if let Some(existing) = &row.acceptance_id {
            if existing != acceptance_id {
                return Err(conflict());
            }
            let receipt = row.receipt()?;
            tx.commit().await.map_err(database)?;
            return Ok(receipt);
        }
        if row.state != "pending_confirmation" {
            return Err(state_changed());
        }
        sqlx::query("UPDATE ai_requests SET state='accepted',acceptance_id=? WHERE request_id=? AND state='pending_confirmation'")
            .bind(acceptance_id).bind(request_id).execute(&mut *tx).await.map_err(database)?;
        let receipt = row_in(&mut tx, origin, request_id).await?.receipt()?;
        tx.commit().await.map_err(database)?;
        self.remove_input(request_id)?;
        Ok(receipt)
    }

    /// Attach facts returned by NativeAi/NativeGeneration. Accepted can attach
    /// a running job; terminal completion releases the request admission slot.
    pub(crate) async fn complete(
        &self,
        origin: &Origin,
        request_id: &str,
        outcome: Outcome,
        now: i64,
    ) -> Result<Receipt> {
        validate_origin(origin)?;
        validate_time(now)?;
        validate_outcome(&outcome)?;
        let _writer = self.0.ai_requests_writer.lock().await;
        let mut tx = self
            .0
            .pool()
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database)?;
        let row = row_in(&mut tx, origin, request_id).await?;
        require_binding(&row, origin)?;
        if row
            .job_id
            .as_ref()
            .zip(outcome.job_id.as_ref())
            .is_some_and(|(a, b)| a != b)
            || row
                .native_operation_id
                .as_ref()
                .zip(outcome.native_operation_id.as_ref())
                .is_some_and(|(a, b)| a != b)
        {
            return Err(conflict());
        }
        let job_id = outcome.job_id.or(row.job_id.clone());
        let native_operation_id = outcome
            .native_operation_id
            .or(row.native_operation_id.clone());
        if row.state != "accepted" {
            if row.state == outcome.state.as_str()
                && row.job_id == job_id
                && row.native_operation_id == native_operation_id
                && row.error_code == outcome.error_code
            {
                let receipt = row.receipt()?;
                tx.commit().await.map_err(database)?;
                return Ok(receipt);
            }
            return Err(state_changed());
        }
        sqlx::query("UPDATE ai_requests SET state=?,job_id=?,native_operation_id=?,error_code=?,terminal_at=? WHERE request_id=? AND state='accepted'")
            .bind(outcome.state.as_str()).bind(job_id).bind(native_operation_id).bind(outcome.error_code)
            .bind((outcome.state != RequestState::Accepted).then_some(now)).bind(request_id).execute(&mut *tx).await.map_err(database)?;
        let receipt = row_in(&mut tx, origin, request_id).await?.receipt()?;
        tx.commit().await.map_err(database)?;
        Ok(receipt)
    }

    async fn maintenance_locked(&self, now: i64) -> Result<()> {
        validate_time(now)?;
        let mut tx = self
            .0
            .pool()
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(database)?;
        maintenance_in(&mut tx, now).await?;
        tx.commit().await.map_err(database)?;
        self.prune_input(now)
    }

    pub(crate) async fn recover_pending(&self, now: i64) -> Result<()> {
        validate_time(now)?;
        let _writer = self.0.ai_requests_writer.lock().await;
        sqlx::query("UPDATE ai_requests SET state=CASE WHEN state='pending_confirmation' AND expires_at<=? THEN 'expired' ELSE 'interrupted' END,terminal_at=?,error_code='desktop_restarted' WHERE state IN ('pending_confirmation','accepted')")
            .bind(now).bind(now).execute(self.0.pool()).await.map_err(database)?;
        self.0
            .ai_request_inputs
            .lock()
            .map_err(|_| memory_error())?
            .clear();
        self.maintenance_locked(now).await
    }

    fn prune_input(&self, now: i64) -> Result<()> {
        self.0
            .ai_request_inputs
            .lock()
            .map_err(|_| memory_error())?
            .retain(|_, input| input.expires_at > now);
        Ok(())
    }

    fn remove_input(&self, request_id: &str) -> Result<()> {
        self.0
            .ai_request_inputs
            .lock()
            .map_err(|_| memory_error())?
            .remove(request_id);
        Ok(())
    }
}

#[derive(FromRow)]
struct Row {
    request_id: String,
    subject_digest: String,
    credential_revision: String,
    binding_digest: String,
    operation_id: String,
    payload_digest: String,
    output_kind: Option<String>,
    state: String,
    created_at: i64,
    expires_at: i64,
    acceptance_id: Option<String>,
    job_id: Option<String>,
    native_operation_id: Option<String>,
    error_code: Option<String>,
}

impl Row {
    fn receipt(&self) -> Result<Receipt> {
        let state = match self.state.as_str() {
            "pending_confirmation" => RequestState::PendingConfirmation,
            "accepted" => RequestState::Accepted,
            "succeeded" => RequestState::Succeeded,
            "failed" => RequestState::Failed,
            "rejected" => RequestState::Rejected,
            "cancelled" => RequestState::Cancelled,
            "expired" => RequestState::Expired,
            "interrupted" => RequestState::Interrupted,
            _ => {
                return Err(JobError::new(
                    "ai_request_store_invalid",
                    "申请记录状态无效",
                ))
            }
        };
        let output_kind = match self.output_kind.as_deref() {
            None => None,
            Some("builtin") => Some(WallpaperGenerationKind::Builtin),
            Some("composition") => Some(WallpaperGenerationKind::Composition),
            Some("image") => Some(WallpaperGenerationKind::Image),
            _ => {
                return Err(JobError::new(
                    "ai_request_store_invalid",
                    "申请输出类别无效",
                ))
            }
        };
        Ok(Receipt {
            request_id: self.request_id.clone(),
            operation_id: self.operation_id.clone(),
            state,
            output_kind,
            job_id: self.job_id.clone(),
            native_operation_id: self.native_operation_id.clone(),
            created_at: self.created_at,
            expires_at: self.expires_at,
            error_code: self.error_code.clone(),
        })
    }
}

async fn row_in(connection: &mut SqliteConnection, origin: &Origin, id: &str) -> Result<Row> {
    if id.len() != 36 || uuid::Uuid::parse_str(id).is_err() {
        return Err(not_found());
    }
    sqlx::query_as::<_, Row>("SELECT * FROM ai_requests WHERE request_id=? AND subject_digest=? AND credential_revision=?")
        .bind(id).bind(&origin.subject_digest).bind(&origin.credential_revision).fetch_optional(connection).await.map_err(database)?
        .ok_or_else(not_found)
}

async fn maintenance_in(connection: &mut SqliteConnection, now: i64) -> Result<()> {
    sqlx::query("UPDATE ai_requests SET state='expired',terminal_at=expires_at,error_code='ai_request_expired' WHERE state='pending_confirmation' AND expires_at<=?")
        .bind(now).execute(&mut *connection).await.map_err(database)?;
    // Retain every terminal identity for ten minutes, independently of the
    // one-minute rate window. Capacity failure never evicts valid receipts.
    sqlx::query("DELETE FROM ai_requests WHERE terminal_at IS NOT NULL AND terminal_at<=?")
        .bind(now.saturating_sub(RECEIPT_RETENTION_SECS))
        .execute(&mut *connection)
        .await
        .map_err(database)?;
    sqlx::query("DELETE FROM ai_request_frequency WHERE admitted_at<=?")
        .bind(now.saturating_sub(60))
        .execute(connection)
        .await
        .map_err(database)?;
    Ok(())
}

fn normalized_request(request: &Request) -> Result<Request> {
    let bytes = match request {
        Request::Switch(input) => serde_json::to_vec(input),
        Request::Generate(input) => serde_json::to_vec(input),
        _ => return Err(JobError::invalid_input("此操作不能创建申请")),
    }
    .map_err(|_| JobError::invalid_input("申请字段无效"))?;
    hertz_wallpaper::external_requests::parse(request.operation().as_str(), &bytes)
        .map_err(|error| JobError::new(error.code, error.message))
}

fn validate_origin(origin: &Origin) -> Result<()> {
    Origin::new(
        &origin.subject_digest,
        &origin.credential_revision,
        &origin.binding_digest,
        &origin.label,
    )
    .map(|_| ())
}
fn validate_time(now: i64) -> Result<()> {
    if !(0..=i64::MAX - REQUEST_TTL_SECS).contains(&now) {
        return Err(JobError::invalid_input("申请时间无效"));
    }
    Ok(())
}
fn validate_outcome(outcome: &Outcome) -> Result<()> {
    if !matches!(
        outcome.state,
        RequestState::Accepted
            | RequestState::Succeeded
            | RequestState::Failed
            | RequestState::Cancelled
            | RequestState::Interrupted
    ) || [&outcome.job_id, &outcome.native_operation_id]
        .iter()
        .any(|id| {
            id.as_ref()
                .is_some_and(|id| !hertz_wallpaper::external_requests::valid_operation_id(id))
        })
        || outcome.error_code.as_ref().is_some_and(|code| {
            code.is_empty()
                || code.len() > 64
                || !code
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        })
    {
        return Err(JobError::invalid_input("申请结果身份或状态无效"));
    }
    Ok(())
}
fn kind_str(kind: WallpaperGenerationKind) -> &'static str {
    match kind {
        WallpaperGenerationKind::Builtin => "builtin",
        WallpaperGenerationKind::Composition => "composition",
        WallpaperGenerationKind::Image => "image",
    }
}
fn require_binding(row: &Row, origin: &Origin) -> Result<()> {
    if row.subject_digest != origin.subject_digest
        || row.credential_revision != origin.credential_revision
        || row.binding_digest != origin.binding_digest
    {
        return Err(origin_changed());
    }
    Ok(())
}
fn database(error: sqlx::Error) -> JobError {
    JobError::database(error.to_string())
}
fn memory_error() -> JobError {
    JobError::new("ai_request_store_unavailable", "申请内存状态不可用")
}
fn not_found() -> JobError {
    JobError::new("ai_request_not_found", "申请不存在或无权读取")
}
fn origin_changed() -> JobError {
    JobError::new("ai_request_origin_changed", "申请来源或原生会话已改变")
}
fn conflict() -> JobError {
    JobError::new(
        "ai_request_conflict",
        "同一申请身份已绑定不同载荷或受理事实",
    )
}
fn state_changed() -> JobError {
    JobError::new("ai_request_state_changed", "申请已到期或已处理")
}

#[cfg(test)]
#[path = "ai_requests_tests.rs"]
mod tests;
