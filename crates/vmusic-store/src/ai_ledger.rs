// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Read-only ledger projection. Kept entries survive task retention; active
//! reservations come from jobs and disappear from this arm after settlement.
use vmusic_core::StoreError;

#[derive(Debug, sqlx::FromRow)]
pub struct LedgerRow {
    pub job_id: String,
    pub principal: Option<String>,
    pub task_state: Option<String>,
    pub task_retained: bool,
    pub accepted_at: Option<i64>,
    pub sort_at: i64,
    pub recorded_at: i64,
    pub attempt_id: Option<String>,
    pub reservation_micro_usd: i64,
    pub accounted_micro_usd: Option<i64>,
    pub usage_state: String,
    pub revision: i64,
    pub pricing_snapshot: String,
    pub reported_usage: Option<String>,
}

const PROJECTION: &str = "WITH ledger AS (
    SELECT e.job_id, e.principal, e.task_state, j.job_id IS NOT NULL AS task_retained,
        e.accepted_at, COALESCE(e.accepted_at, e.created_at) AS sort_at,
        e.created_at AS recorded_at, e.attempt_id, e.reservation_micro_usd,
        e.accounted_micro_usd, e.usage_state, e.revision, e.pricing_snapshot,
        e.reported_usage, e.accepted_month, e.owner_instance_id
    FROM ai_usage_entries e LEFT JOIN ai_jobs j ON j.job_id = e.job_id
    UNION ALL
    SELECT j.job_id, j.principal, j.state, 1, j.created_at, j.created_at,
        j.created_at, j.attempt_id, j.reservation_micro_usd, NULL, 'reserved', 0,
        j.pricing_snapshot, NULL, strftime('%Y-%m', j.created_at/1000, 'unixepoch'), j.owner_instance_id
    FROM ai_jobs j WHERE j.state IN ('accepted','running')
        AND NOT EXISTS (SELECT 1 FROM ai_usage_entries e WHERE e.job_id = j.job_id)
)";

pub struct LedgerFilter<'a> {
    pub owner: &'a str,
    pub month: &'a str,
    pub usage_state: Option<&'a str>,
    pub before: Option<(i64, &'a str)>,
    pub limit: i64,
}

pub async fn list(
    conn: &mut sqlx::SqliteConnection,
    filter: LedgerFilter<'_>,
) -> Result<Vec<LedgerRow>, StoreError> {
    let sql = format!(
        "{PROJECTION} SELECT job_id, principal, task_state, task_retained,
        accepted_at, sort_at, recorded_at, attempt_id, reservation_micro_usd,
        accounted_micro_usd, usage_state, revision, pricing_snapshot, reported_usage
        FROM ledger WHERE (owner_instance_id = ?1 OR owner_instance_id IS NULL)
            AND accepted_month = ?2 AND (?3 IS NULL OR usage_state = ?3)
            AND (?4 IS NULL OR sort_at < ?4 OR (sort_at = ?4 AND job_id < ?5))
        ORDER BY sort_at DESC, job_id DESC LIMIT ?6"
    );
    sqlx::query_as(&sql)
        .bind(filter.owner)
        .bind(filter.month)
        .bind(filter.usage_state)
        .bind(filter.before.map(|value| value.0))
        .bind(filter.before.map(|value| value.1))
        .bind(filter.limit.clamp(1, 51))
        .fetch_all(conn)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))
}

pub async fn months(
    conn: &mut sqlx::SqliteConnection,
    owner: &str,
) -> Result<Vec<String>, StoreError> {
    // Retention normally leaves thirteen months; include older protected facts
    // and legacy unassigned rows. The API also accepts any explicit UTC month.
    sqlx::query_scalar(&format!("{PROJECTION} SELECT DISTINCT month FROM (
        SELECT month FROM ai_budget_months UNION
        SELECT accepted_month AS month FROM ledger WHERE owner_instance_id = ?1 OR owner_instance_id IS NULL
    ) ORDER BY month DESC LIMIT 64"))
        .bind(owner).fetch_all(conn).await.map_err(|e| StoreError::Database(e.to_string()))
}

pub async fn budget(
    conn: &mut sqlx::SqliteConnection,
    month: &str,
) -> Result<Option<crate::ai_jobs::BudgetRow>, StoreError> {
    sqlx::query_as("SELECT month, reserved_micro_usd, charged_micro_usd, revision FROM ai_budget_months WHERE month = ?1")
        .bind(month).fetch_optional(conn).await.map_err(|e| StoreError::Database(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Connection;

    async fn database() -> sqlx::SqliteConnection {
        let mut conn = sqlx::SqliteConnection::connect("sqlite::memory:")
            .await
            .unwrap();
        for sql in [
            include_str!("../../../migrations/0014_ai_grants.sql"),
            include_str!("../../../migrations/0015_ai_jobs.sql"),
            include_str!("../../../migrations/0016_ai_usage.sql"),
            include_str!("../../../migrations/0017_ai_usage_attribution.sql"),
            include_str!("../../../migrations/0018_ai_pricing_snapshot.sql"),
        ] {
            sqlx::raw_sql(sql).execute(&mut conn).await.unwrap();
        }
        conn
    }

    async fn job(conn: &mut sqlx::SqliteConnection, id: &str, state: &str) {
        sqlx::query("INSERT INTO ai_jobs (job_id,owner_instance_id,principal,capability,key,input_hash,state,state_revision,
            dispatch_state,provider,model,created_at,updated_at) VALUES (?1,'owner','grant-original','generate',?1,'private-input-hash',?2,1,'not_dispatched','fake','fake',1000,1000)")
            .bind(id).bind(state).execute(conn).await.unwrap();
    }
    fn entry(id: &str) -> crate::ai_jobs::UsageEntryRow {
        crate::ai_jobs::UsageEntryRow {
            job_id: id.into(),
            accepted_month: "1970-01".into(),
            attempt_id: None,
            reservation_micro_usd: 50000,
            accounted_micro_usd: 50000,
            usage_state: "unknown".into(),
            pricing_snapshot: "{}".into(),
            reported_usage: None,
            revision: 1,
            created_at: 2000,
        }
    }

    #[tokio::test]
    async fn migration_and_new_settlements_keep_attribution_after_task_purge() {
        let mut conn = database().await;
        job(&mut conn, "legacy", "cancelled").await;
        sqlx::query("INSERT INTO ai_usage_entries (job_id,reservation_micro_usd,accounted_micro_usd,usage_state,pricing_snapshot,created_at,accepted_month)
            VALUES ('legacy',50000,50000,'unknown','{}',2000,'1970-01'),('orphan',50000,50000,'estimated_final','{}',2000,'1970-01')")
            .execute(&mut conn).await.unwrap();
        sqlx::raw_sql(include_str!(
            "../../../migrations/0019_ai_ledger_browse.sql"
        ))
        .execute(&mut conn)
        .await
        .unwrap();
        job(&mut conn, "new", "failed").await;
        crate::ai_jobs::insert_usage_entry(&mut conn, &entry("new"))
            .await
            .unwrap();
        sqlx::query("DELETE FROM ai_jobs")
            .execute(&mut conn)
            .await
            .unwrap();
        let rows = list(
            &mut conn,
            LedgerFilter {
                owner: "owner",
                month: "1970-01",
                usage_state: None,
                before: None,
                limit: 50,
            },
        )
        .await
        .unwrap();
        assert_eq!(rows.len(), 3);
        for id in ["legacy", "new"] {
            let row = rows.iter().find(|row| row.job_id == id).unwrap();
            assert_eq!(row.principal.as_deref(), Some("grant-original"));
            assert_eq!(row.accepted_at, Some(1000));
            assert_eq!(row.sort_at, 1000);
            assert!(!row.task_retained);
            assert_eq!(row.accounted_micro_usd, Some(50000));
        }
        let orphan = rows.iter().find(|row| row.job_id == "orphan").unwrap();
        assert!(
            orphan.principal.is_none()
                && orphan.accepted_at.is_none()
                && orphan.task_state.is_none()
        );
        assert_eq!(
            orphan.sort_at, orphan.recorded_at,
            "legacy fallback remains explicit, never called acceptance time"
        );
    }

    #[tokio::test]
    async fn reservations_settlement_ties_filters_and_owner_use_one_stable_cursor() {
        let mut conn = database().await;
        sqlx::raw_sql(include_str!(
            "../../../migrations/0019_ai_ledger_browse.sql"
        ))
        .execute(&mut conn)
        .await
        .unwrap();
        for id in ["a", "b", "c", "foreign"] {
            job(&mut conn, id, "running").await;
        }
        sqlx::query("UPDATE ai_jobs SET owner_instance_id='foreign-owner' WHERE job_id='foreign'")
            .execute(&mut conn)
            .await
            .unwrap();
        let first = list(
            &mut conn,
            LedgerFilter {
                owner: "owner",
                month: "1970-01",
                usage_state: Some("reserved"),
                before: None,
                limit: 1,
            },
        )
        .await
        .unwrap();
        assert_eq!(first[0].job_id, "c");
        assert_eq!(first[0].accounted_micro_usd, None);
        sqlx::query("UPDATE ai_jobs SET state='cancelled' WHERE job_id='b'")
            .execute(&mut conn)
            .await
            .unwrap();
        crate::ai_jobs::insert_usage_entry(&mut conn, &entry("b"))
            .await
            .unwrap();
        let remaining = list(
            &mut conn,
            LedgerFilter {
                owner: "owner",
                month: "1970-01",
                usage_state: None,
                before: Some((1000, "c")),
                limit: 50,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            remaining
                .iter()
                .map(|row| row.job_id.as_str())
                .collect::<Vec<_>>(),
            vec!["b", "a"]
        );
        assert_eq!(
            remaining[0].sort_at, 1000,
            "settlement does not move acceptance cursor"
        );
        assert_eq!(remaining[0].task_state.as_deref(), Some("cancelled"));
        let filtered = list(
            &mut conn,
            LedgerFilter {
                owner: "owner",
                month: "1970-01",
                usage_state: Some("unknown"),
                before: None,
                limit: 50,
            },
        )
        .await
        .unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].job_id, "b");
        assert_eq!(months(&mut conn, "owner").await.unwrap(), vec!["1970-01"]);
        assert!(
            budget(&mut conn, "1970-01").await.unwrap().is_none(),
            "read does not create an empty budget"
        );
    }
}
