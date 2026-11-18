// SPDX-License-Identifier: MIT
//! Immutable report submissions and exact, independently recorded moderation.
use crate::{
    config::{canonical_id, text},
    error::{HubError, Result},
    management::{self, ManagementReceipt, ManagementResult, ReportStatus, Role, MAX_SAFE_INTEGER},
    model::{digest, now, Actor},
    store::Hub,
};
use serde::{Deserialize, Serialize};
use sqlx::Row;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ReportInput {
    pub operation_id: String,
    pub release_id: String,
    pub reason: String,
    pub description: String,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ReportDecision {
    Dismiss,
    Escalate,
}
impl ReportDecision {
    fn status(self) -> ReportStatus {
        match self {
            Self::Dismiss => ReportStatus::Dismissed,
            Self::Escalate => ReportStatus::Escalated,
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ResolveInput {
    pub operation_id: String,
    pub report_digest: String,
    pub decision: ReportDecision,
    pub reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReportResolution {
    pub operation_id: String,
    pub reason: String,
    pub resolved_by: String,
    pub resolved_at: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Report {
    pub id: String,
    pub reporter_id: String,
    pub release_id: String,
    pub reason: String,
    pub description: String,
    pub created_at: i64,
    pub report_digest: String,
    pub status: ReportStatus,
    pub resolution: Option<ReportResolution>,
}

#[derive(sqlx::FromRow)]
struct ReportRow {
    id: String,
    author_id: String,
    release_id: String,
    reason: String,
    description: String,
    created_at: i64,
    status: String,
    resolution_operation: Option<String>,
    resolution_reason: Option<String>,
    resolved_by: Option<String>,
    resolved_at: Option<i64>,
}
const REPORT_SELECT: &str = concat!(
    "SELECT CASE WHEN length(CAST(r.id AS BLOB))=36 THEN r.id ELSE NULL END AS id,",
    "CASE WHEN length(CAST(r.author_id AS BLOB))=36 THEN r.author_id ELSE NULL END AS author_id,",
    "CASE WHEN length(CAST(r.release_id AS BLOB))=36 THEN r.release_id ELSE NULL END AS release_id,",
    "CASE WHEN r.reason IN ('security','copyright','other') THEN r.reason ELSE NULL END AS reason,",
    "CASE WHEN length(CAST(r.description AS BLOB)) BETWEEN 1 AND 16000 AND length(r.description)<=4000 THEN r.description ELSE NULL END AS description,",
    "CASE WHEN typeof(r.created_at)='integer' AND r.created_at BETWEEN 1 AND 9007199254740991 THEN r.created_at ELSE NULL END AS created_at,",
    "CASE WHEN rr.report_id IS NULL THEN 'open' WHEN rr.status IN ('dismissed','escalated') THEN rr.status ELSE NULL END AS status,",
    "CASE WHEN length(CAST(rr.operation_id AS BLOB))=36 THEN rr.operation_id ELSE NULL END AS resolution_operation,",
    "CASE WHEN length(CAST(rr.reason AS BLOB)) BETWEEN 1 AND 16000 AND length(rr.reason)<=4000 THEN rr.reason ELSE NULL END AS resolution_reason,",
    "CASE WHEN length(CAST(rr.resolved_by AS BLOB))=36 THEN rr.resolved_by ELSE NULL END AS resolved_by,",
    "CASE WHEN typeof(rr.resolved_at)='integer' AND rr.resolved_at BETWEEN 1 AND 9007199254740991 THEN rr.resolved_at ELSE NULL END AS resolved_at ",
    "FROM reports r LEFT JOIN report_resolutions rr ON rr.report_id=r.id"
);
impl ReportRow {
    fn into_report(self) -> Result<Report> {
        for id in [&self.id, &self.author_id, &self.release_id] {
            canonical_id(id).map_err(|_| HubError::unavailable())?;
        }
        text(&self.description, 4000).map_err(|_| HubError::unavailable())?;
        let status = ReportStatus::from_text(&self.status)?;
        let resolution = if status == ReportStatus::Open {
            if self.resolution_operation.is_some()
                || self.resolution_reason.is_some()
                || self.resolved_by.is_some()
                || self.resolved_at.is_some()
            {
                return Err(HubError::unavailable());
            }
            None
        } else {
            let operation_id = self
                .resolution_operation
                .ok_or_else(HubError::unavailable)?;
            let reason = self.resolution_reason.ok_or_else(HubError::unavailable)?;
            let resolved_by = self.resolved_by.ok_or_else(HubError::unavailable)?;
            let resolved_at = self.resolved_at.ok_or_else(HubError::unavailable)?;
            canonical_id(&operation_id).map_err(|_| HubError::unavailable())?;
            canonical_id(&resolved_by).map_err(|_| HubError::unavailable())?;
            text(&reason, 4000).map_err(|_| HubError::unavailable())?;
            Some(ReportResolution {
                operation_id,
                reason,
                resolved_by,
                resolved_at,
            })
        };
        let report_digest = digest(&(
            &self.id,
            &self.author_id,
            &self.release_id,
            &self.reason,
            &self.description,
            self.created_at,
        ))?;
        Ok(Report {
            id: self.id,
            reporter_id: self.author_id,
            release_id: self.release_id,
            reason: self.reason,
            description: self.description,
            created_at: self.created_at,
            report_digest,
            status,
            resolution,
        })
    }
}

impl Hub {
    pub(crate) async fn report(&self, actor: &Actor, input: ReportInput) -> Result<String> {
        canonical_id(&input.release_id)?;
        text(&input.operation_id, 128)?;
        text(&input.description, 4000)?;
        if !matches!(input.reason.as_str(), "security" | "copyright" | "other") {
            return Err(HubError::invalid("举报原因须为security、copyright或other"));
        }
        let expected = digest(&input)?;
        let mut tx = self.pool.begin().await?;
        if let Some(existing) = sqlx::query(
            "SELECT id,operation_digest FROM reports WHERE author_id=? AND operation_id=?",
        )
        .bind(&actor.id)
        .bind(&input.operation_id)
        .fetch_optional(&mut *tx)
        .await?
        {
            if existing.try_get::<String, _>("operation_digest")? != expected {
                return Err(HubError::conflict("同一举报请求不能更换内容"));
            }
            let id = existing.try_get("id")?;
            tx.commit().await?;
            return Ok(id);
        }
        let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM releases WHERE id=? AND ((state='published' AND signed_release IS NOT NULL) OR owner_id=?)")
            .bind(&input.release_id).bind(&actor.id).fetch_one(&mut *tx).await?;
        if visible != 1 {
            return Err(HubError::missing());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let time = now();
        if !(1..=MAX_SAFE_INTEGER).contains(&time) {
            return Err(HubError::unavailable());
        }
        sqlx::query("INSERT INTO reports(id,author_id,release_id,operation_id,operation_digest,reason,description,created_at) VALUES(?,?,?,?,?,?,?,?)")
            .bind(&id).bind(&actor.id).bind(input.release_id).bind(input.operation_id).bind(expected)
            .bind(input.reason).bind(input.description).bind(time).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO audit_events(actor_id,action,object_id,created_at) VALUES(?,'report_submitted',?,?)")
            .bind(&actor.id).bind(&id).bind(time).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(id)
    }

    pub(crate) async fn report_detail(&self, actor: &Actor, id: &str) -> Result<Report> {
        canonical_id(id)?;
        let mut tx = self.pool.begin().await?;
        let role = management::current_role(&mut tx, actor).await?;
        let row: ReportRow = sqlx::query_as(&format!(
            "{REPORT_SELECT} WHERE r.id=? AND (r.author_id=? OR ?)"
        ))
        .bind(id)
        .bind(&actor.id)
        .bind(role != Role::Author)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(HubError::missing)?;
        let report = row.into_report()?;
        tx.commit().await?;
        Ok(report)
    }

    pub(crate) async fn report_queue(
        &self,
        actor: &Actor,
        status: ReportStatus,
        offset: i64,
        limit: i64,
    ) -> Result<Vec<Report>> {
        management::check_page(offset, limit)?;
        let mut tx = self.pool.begin().await?;
        management::require_reviewer(&mut tx, actor).await?;
        let rows: Vec<ReportRow> = sqlx::query_as(&format!("{REPORT_SELECT} WHERE coalesce(rr.status,'open')=? ORDER BY r.created_at,r.id LIMIT ? OFFSET ?"))
            .bind(status.as_str()).bind(limit).bind(offset).fetch_all(&mut *tx).await?;
        let reports = rows
            .into_iter()
            .map(ReportRow::into_report)
            .collect::<Result<Vec<_>>>()?;
        tx.commit().await?;
        Ok(reports)
    }

    pub(crate) async fn resolve_report(
        &self,
        actor: &Actor,
        id: &str,
        input: ResolveInput,
    ) -> Result<ManagementReceipt> {
        canonical_id(id)?;
        canonical_id(&input.operation_id)?;
        text(&input.reason, 4000)?;
        if !hertz_wallpaper::valid_sha256_hex(&input.report_digest) {
            return Err(HubError::invalid("处理举报须绑定完整举报摘要"));
        }
        let expected = digest(&(id, &input))?;
        let mut tx = self.pool.begin().await?;
        management::require_reviewer(&mut tx, actor).await?;
        if let Some(receipt) = management::matching_operation(
            &mut tx,
            actor,
            &input.operation_id,
            "report_resolution",
            id,
            &expected,
        )
        .await?
        {
            tx.commit().await?;
            return Ok(receipt);
        }
        let row: ReportRow = sqlx::query_as(&format!("{REPORT_SELECT} WHERE r.id=?"))
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(HubError::missing)?;
        let report = row.into_report()?;
        if report.status != ReportStatus::Open || report.report_digest != input.report_digest {
            return Err(HubError::conflict(
                "举报已处理或正文已变化，请重新读取确切举报",
            ));
        }
        let status = input.decision.status();
        // Escalation is a report disposition. Release revocation still requires
        // the original separately approved Signer operation and exact receipt.
        let receipt = management::record_operation(
            &mut tx,
            actor,
            &input.operation_id,
            &expected,
            ManagementResult::ReportResolution {
                report_id: id.to_owned(),
                release_id: report.release_id,
                reporter_id: report.reporter_id,
                report_digest: report.report_digest,
                status,
                reason: input.reason.clone(),
            },
        )
        .await?;
        sqlx::query("INSERT INTO report_resolutions(report_id,operation_id,status,reason,resolved_by,resolved_at) VALUES(?,?,?,?,?,?)")
            .bind(id).bind(&input.operation_id).bind(status.as_str()).bind(input.reason)
            .bind(&actor.id).bind(receipt.committed_at).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(receipt)
    }
}
