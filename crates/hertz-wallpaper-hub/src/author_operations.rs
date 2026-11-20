// SPDX-License-Identifier: MIT
//! Read-only recovery of the author's original request in its existing ledger.
use crate::{
    config::canonical_id,
    error::{HubError, Result},
    management,
    model::{Actor, Upload, Work, UPLOAD_SELECT, WORK_SELECT},
    store::Hub,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OperationKind {
    Work,
    Upload,
    Report,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthorOperation {
    operation_id: String,
    kind: OperationKind,
    found: bool,
    request_digest: Option<String>,
    result: Option<serde_json::Value>,
}

impl Hub {
    pub(crate) async fn author_uploads(
        &self,
        actor: &Actor,
        offset: i64,
        limit: i64,
    ) -> Result<Vec<Upload>> {
        if !(0..=1_000_000).contains(&offset) || !(1..=50).contains(&limit) {
            return Err(HubError::invalid("分页offset须在0–1000000，每页1–50项"));
        }
        let mut tx = self.pool.begin().await?;
        management::current_role(&mut tx, actor).await?;
        // The upload ledger is the only recovery authority, including ready
        // packages whose original successful receipt is no longer in a WebView.
        let uploads: Vec<Upload> = sqlx::query_as(&format!(
            "{UPLOAD_SELECT} WHERE owner_id=? AND state IN ('reserved','receiving','ready','validating') \
             ORDER BY uploads.created_at DESC,uploads.id LIMIT ? OFFSET ?"
        ))
        .bind(&actor.id)
        .bind(limit)
        .bind(offset)
        .fetch_all(&mut *tx)
        .await?;
        for upload in &uploads {
            upload.validate_read()?;
        }
        tx.commit().await?;
        Ok(uploads)
    }

    pub(crate) async fn author_account(&self, actor: &Actor) -> Result<serde_json::Value> {
        let mut tx = self.pool.begin().await?;
        let role = management::current_role(&mut tx, actor).await?;
        let (issuer, subject): (String, String) = sqlx::query_as(
            "SELECT CASE WHEN length(CAST(issuer AS BLOB)) BETWEEN 1 AND 2048 THEN issuer ELSE NULL END, \
             CASE WHEN length(CAST(subject AS BLOB)) BETWEEN 1 AND 255 THEN subject ELSE NULL END \
             FROM users WHERE id=?",
        )
        .bind(&actor.id)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        if issuer != self.config.issuer || crate::config::text(&subject, 255).is_err() {
            return Err(HubError::unavailable());
        }
        Ok(serde_json::json!({"id":actor.id,"issuer":issuer,"subject":subject,"role":role}))
    }

    pub(crate) async fn author_operation(
        &self,
        actor: &Actor,
        kind: OperationKind,
        operation: &str,
    ) -> Result<AuthorOperation> {
        canonical_id(operation)?;
        // A stale Actor cannot turn a deleted or malformed database identity into access.
        let mut tx = self.pool.begin().await?;
        management::current_role(&mut tx, actor).await?;
        let (table, owner) = match kind {
            OperationKind::Work => ("works", "owner_id"),
            OperationKind::Upload => ("uploads", "owner_id"),
            OperationKind::Report => ("reports", "author_id"),
        };
        let row: Option<(String, String)> = sqlx::query_as(&format!(
            "SELECT CASE WHEN length(CAST(id AS BLOB))=36 THEN id ELSE NULL END, \
             CASE WHEN length(CAST(operation_digest AS BLOB))=64 THEN operation_digest ELSE NULL END \
             FROM {table} WHERE {owner}=? AND operation_id=?"
        ))
        .bind(&actor.id)
        .bind(operation)
        .fetch_optional(&mut *tx)
        .await?;
        tx.commit().await?;
        let (request_digest, result) = if let Some((id, digest)) = row {
            canonical_id(&id).map_err(|_| HubError::unavailable())?;
            if !hertz_wallpaper::valid_sha256_hex(&digest) {
                return Err(HubError::unavailable());
            }
            let value = match kind {
                OperationKind::Work => {
                    let work: Work =
                        sqlx::query_as(&format!("{WORK_SELECT} WHERE id=? AND owner_id=?"))
                            .bind(id)
                            .bind(&actor.id)
                            .fetch_one(&self.pool)
                            .await?;
                    work.validate_read()?;
                    serde_json::to_value(work)
                }
                OperationKind::Upload => serde_json::to_value(self.upload(actor, &id).await?),
                OperationKind::Report => {
                    serde_json::to_value(self.report_detail(actor, &id).await?)
                }
            }
            .map_err(|_| HubError::unavailable())?;
            (Some(digest), Some(value))
        } else {
            (None, None)
        };
        Ok(AuthorOperation {
            operation_id: operation.to_owned(),
            kind,
            found: result.is_some(),
            request_digest,
            result,
        })
    }
}
