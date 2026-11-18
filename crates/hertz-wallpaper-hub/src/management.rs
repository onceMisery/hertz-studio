// SPDX-License-Identifier: MIT
//! Database roles and atomic management receipts; no Signer approval authority.
use crate::{
    config::{canonical_id, text},
    error::{HubError, Result},
    model::{encode, now, Actor},
    store::Hub,
};
use serde::{Deserialize, Serialize};
use sqlx::{Sqlite, Transaction};

pub(crate) const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_RECEIPT_BYTES: usize = 32_768;
const MAX_OPERATIONS: i64 = 100_000;

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Role {
    Author,
    Moderator,
    Admin,
}
impl Role {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Author => "author",
            Self::Moderator => "moderator",
            Self::Admin => "admin",
        }
    }
    pub(crate) fn from_text(value: &str) -> Result<Self> {
        match value {
            "author" => Ok(Self::Author),
            "moderator" => Ok(Self::Moderator),
            "admin" => Ok(Self::Admin),
            _ => Err(HubError::unavailable()),
        }
    }
}

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ReportStatus {
    #[default]
    Open,
    Dismissed,
    Escalated,
}
impl ReportStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Dismissed => "dismissed",
            Self::Escalated => "escalated",
        }
    }
    pub(crate) fn from_text(value: &str) -> Result<Self> {
        match value {
            "open" => Ok(Self::Open),
            "dismissed" => Ok(Self::Dismissed),
            "escalated" => Ok(Self::Escalated),
            _ => Err(HubError::unavailable()),
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ManagementResult {
    RoleChange {
        user_id: String,
        previous_role: Role,
        role: Role,
        reason: String,
    },
    ReportResolution {
        report_id: String,
        release_id: String,
        reporter_id: String,
        report_digest: String,
        status: ReportStatus,
        reason: String,
    },
}
impl ManagementResult {
    fn kind(&self) -> &'static str {
        match self {
            Self::RoleChange { .. } => "role_change",
            Self::ReportResolution { .. } => "report_resolution",
        }
    }
    fn object_id(&self) -> &str {
        match self {
            Self::RoleChange { user_id, .. } => user_id,
            Self::ReportResolution { report_id, .. } => report_id,
        }
    }
    fn validate(&self) -> Result<()> {
        canonical_id(self.object_id()).map_err(|_| HubError::unavailable())?;
        let reason = match self {
            Self::RoleChange {
                previous_role,
                role,
                reason,
                ..
            } => {
                if previous_role == role {
                    return Err(HubError::unavailable());
                }
                reason
            }
            Self::ReportResolution {
                release_id,
                reporter_id,
                report_digest,
                status,
                reason,
                ..
            } => {
                canonical_id(release_id).map_err(|_| HubError::unavailable())?;
                canonical_id(reporter_id).map_err(|_| HubError::unavailable())?;
                if !hertz_wallpaper::valid_sha256_hex(report_digest)
                    || *status == ReportStatus::Open
                {
                    return Err(HubError::unavailable());
                }
                reason
            }
        };
        text(reason, 4000).map_err(|_| HubError::unavailable())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagementReceipt {
    pub operation_id: String,
    pub actor_id: String,
    pub object_id: String,
    pub request_digest: String,
    pub committed_at: i64,
    pub audit_event_id: i64,
    pub result: ManagementResult,
}

#[derive(sqlx::FromRow)]
struct StoredOperation {
    operation_id: String,
    actor_id: String,
    kind: String,
    object_id: String,
    request_digest: String,
    result_json: String,
    created_at: i64,
    audit_event_id: i64,
}

pub(crate) fn check_page(offset: i64, limit: i64) -> Result<()> {
    if !(0..=1_000_000).contains(&offset) || !(1..=50).contains(&limit) {
        return Err(HubError::invalid("分页offset须为0–1000000，每页1–50项"));
    }
    Ok(())
}

pub(crate) async fn current_role(tx: &mut Transaction<'_, Sqlite>, actor: &Actor) -> Result<Role> {
    canonical_id(&actor.id)?;
    let role: Option<Option<String>> = sqlx::query_scalar("SELECT CASE WHEN role IN ('author','moderator','admin') THEN role ELSE NULL END FROM users WHERE id=?")
        .bind(&actor.id).fetch_optional(&mut **tx).await?;
    match role {
        None => Err(HubError::denied()),
        Some(None) => Err(HubError::unavailable()),
        Some(Some(role)) => Role::from_text(&role),
    }
}
pub(crate) async fn require_administrator(
    tx: &mut Transaction<'_, Sqlite>,
    actor: &Actor,
) -> Result<()> {
    if current_role(tx, actor).await? != Role::Admin {
        return Err(HubError::denied());
    }
    Ok(())
}
pub(crate) async fn require_reviewer(
    tx: &mut Transaction<'_, Sqlite>,
    actor: &Actor,
) -> Result<Role> {
    let role = current_role(tx, actor).await?;
    if role == Role::Author {
        return Err(HubError::denied());
    }
    Ok(role)
}

async fn read_operation(
    tx: &mut Transaction<'_, Sqlite>,
    id: &str,
) -> Result<Option<ManagementReceipt>> {
    let row: Option<StoredOperation> = sqlx::query_as(concat!(
        "SELECT CASE WHEN length(CAST(operation_id AS BLOB))=36 THEN operation_id ELSE NULL END AS operation_id,",
        "CASE WHEN length(CAST(actor_id AS BLOB))=36 THEN actor_id ELSE NULL END AS actor_id,",
        "CASE WHEN kind IN ('role_change','report_resolution') THEN kind ELSE NULL END AS kind,",
        "CASE WHEN length(CAST(object_id AS BLOB))=36 THEN object_id ELSE NULL END AS object_id,",
        "CASE WHEN length(CAST(request_digest AS BLOB))=64 THEN request_digest ELSE NULL END AS request_digest,",
        "CASE WHEN length(CAST(result_json AS BLOB)) BETWEEN 2 AND 32768 THEN result_json ELSE NULL END AS result_json,",
        "CASE WHEN typeof(created_at)='integer' AND created_at BETWEEN 1 AND 9007199254740991 THEN created_at ELSE NULL END AS created_at,",
        "CASE WHEN typeof(audit_event_id)='integer' AND audit_event_id BETWEEN 1 AND 9007199254740991 THEN audit_event_id ELSE NULL END AS audit_event_id ",
        "FROM management_operations WHERE operation_id=?"
    )).bind(id).fetch_optional(&mut **tx).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    for id in [&row.operation_id, &row.actor_id, &row.object_id] {
        canonical_id(id).map_err(|_| HubError::unavailable())?;
    }
    if !hertz_wallpaper::valid_sha256_hex(&row.request_digest) {
        return Err(HubError::unavailable());
    }
    hertz_wallpaper::json::check_bounded_json(row.result_json.as_bytes(), 16)
        .map_err(|_| HubError::unavailable())?;
    let result: ManagementResult =
        serde_json::from_str(&row.result_json).map_err(|_| HubError::unavailable())?;
    result.validate()?;
    if result.kind() != row.kind || result.object_id() != row.object_id {
        return Err(HubError::conflict("管理收据与原目标不一致"));
    }
    Ok(Some(ManagementReceipt {
        operation_id: row.operation_id,
        actor_id: row.actor_id,
        object_id: row.object_id,
        request_digest: row.request_digest,
        committed_at: row.created_at,
        audit_event_id: row.audit_event_id,
        result,
    }))
}

pub(crate) async fn matching_operation(
    tx: &mut Transaction<'_, Sqlite>,
    actor: &Actor,
    id: &str,
    kind: &str,
    object: &str,
    request_digest: &str,
) -> Result<Option<ManagementReceipt>> {
    let receipt = read_operation(tx, id).await?;
    if receipt.as_ref().is_some_and(|receipt| {
        receipt.actor_id != actor.id
            || receipt.object_id != object
            || receipt.result.kind() != kind
            || receipt.request_digest != request_digest
    }) {
        return Err(HubError::conflict(
            "原管理操作不能更换操作者、目标或内容，请查询原UUID",
        ));
    }
    Ok(receipt)
}

pub(crate) async fn record_operation(
    tx: &mut Transaction<'_, Sqlite>,
    actor: &Actor,
    id: &str,
    request_digest: &str,
    result: ManagementResult,
) -> Result<ManagementReceipt> {
    result.validate()?;
    let result_json = encode(&result)?;
    if result_json.len() > MAX_RECEIPT_BYTES {
        return Err(HubError::invalid("管理收据超过32KiB"));
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM management_operations")
        .fetch_one(&mut **tx)
        .await?;
    if count >= MAX_OPERATIONS {
        return Err(HubError::limited("管理操作账本达到容量上限"));
    }
    let time = now();
    if !(1..=MAX_SAFE_INTEGER).contains(&time) {
        return Err(HubError::unavailable());
    }
    let action = match &result {
        ManagementResult::RoleChange { .. } => "user_role_changed",
        ManagementResult::ReportResolution { .. } => "report_resolved",
    };
    let audit = sqlx::query(
        "INSERT INTO audit_events(actor_id,action,object_id,created_at) VALUES(?,?,?,?)",
    )
    .bind(&actor.id)
    .bind(action)
    .bind(result.object_id())
    .bind(time)
    .execute(&mut **tx)
    .await?;
    let audit_event_id = audit.last_insert_rowid();
    if !(1..=MAX_SAFE_INTEGER).contains(&audit_event_id) {
        return Err(HubError::unavailable());
    }
    sqlx::query("INSERT INTO management_operations(operation_id,actor_id,kind,object_id,request_digest,result_json,created_at,audit_event_id) VALUES(?,?,?,?,?,?,?,?)")
        .bind(id).bind(&actor.id).bind(result.kind()).bind(result.object_id()).bind(request_digest)
        .bind(result_json).bind(time).bind(audit_event_id).execute(&mut **tx).await?;
    Ok(ManagementReceipt {
        operation_id: id.to_owned(),
        actor_id: actor.id.clone(),
        object_id: result.object_id().to_owned(),
        request_digest: request_digest.to_owned(),
        committed_at: time,
        audit_event_id,
        result,
    })
}

impl Hub {
    pub(crate) async fn management_operation(
        &self,
        actor: &Actor,
        id: &str,
    ) -> Result<ManagementReceipt> {
        canonical_id(id)?;
        let mut tx = self.pool.begin().await?;
        let role = require_reviewer(&mut tx, actor).await?;
        let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM management_operations WHERE operation_id=? AND (? OR kind='report_resolution')")
            .bind(id).bind(role == Role::Admin).fetch_one(&mut *tx).await?;
        if visible != 1 {
            return Err(HubError::missing());
        }
        let receipt = read_operation(&mut tx, id)
            .await?
            .ok_or_else(HubError::missing)?;
        tx.commit().await?;
        Ok(receipt)
    }
}
