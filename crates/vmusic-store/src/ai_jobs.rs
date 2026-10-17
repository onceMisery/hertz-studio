// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! AI 持久任务的仓储：jobs / proposals / budget（技术路线 R4-J / §7.3）。
//!
//! 事务边界在服务层：这里的函数都接受 `sqlx::Executor`，服务层用
//! `pool.begin()`（有界 BEGIN IMMEDIATE）把「任务 + 费用预留」这类多语句
//! 原子化；短事务内不等待网络与模型。brief 等原始输入不持久化——jobs
//! 表只存 `input_hash`，输入存活在服务端有界内存里。
//!
//! 状态机的合法迁移由服务层约束，本层用 CAS（from_state + state_revision
//! 匹配才前进）保证并发下只有一个赢家：终态不可复活、派发标记单向、
//! 一个 job 最多一次派发都落在 WHERE 条件里。

use vmusic_core::StoreError;

/// 一条持久任务。`state`：accepted / running / succeeded / failed /
/// cancelled / expired / interrupted；`dispatch_state`：
/// not_dispatched / may_have_been_sent。
#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct JobRow {
    pub job_id: String,
    pub owner_instance_id: String,
    pub principal: String,
    pub capability: String,
    pub key: String,
    pub input_hash: String,
    pub state: String,
    pub state_revision: i64,
    pub dispatch_state: String,
    pub attempt_id: Option<String>,
    pub provider: String,
    pub model: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub result_proposal_id: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct ProposalRow {
    pub proposal_id: String,
    pub job_id: String,
    pub validated_intent: String,
    pub schema_version: String,
    pub state: String,
    pub revision: i64,
    pub created_at: i64,
    pub expires_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct BudgetRow {
    pub month: String,
    pub reserved_micro_usd: i64,
    pub charged_micro_usd: i64,
    pub revision: i64,
}

const JOB_COLUMNS: &str =
    "job_id, owner_instance_id, principal, capability, key, input_hash, state,
        state_revision, dispatch_state, attempt_id, provider, model, created_at, updated_at,
        result_proposal_id";

pub async fn find_job_by_key<'c, E: sqlx::Executor<'c, Database = sqlx::Sqlite>>(
    conn: E,
    principal: &str,
    capability: &str,
    key: &str,
) -> Result<Option<JobRow>, StoreError> {
    sqlx::query_as(&format!(
        "SELECT {JOB_COLUMNS} FROM ai_jobs
         WHERE principal = ?1 AND capability = ?2 AND key = ?3"
    ))
    .bind(principal)
    .bind(capability)
    .bind(key)
    .fetch_optional(conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))
}

pub async fn find_job_by_id<'c, E: sqlx::Executor<'c, Database = sqlx::Sqlite>>(
    conn: E,
    job_id: &str,
) -> Result<Option<JobRow>, StoreError> {
    sqlx::query_as(&format!(
        "SELECT {JOB_COLUMNS} FROM ai_jobs WHERE job_id = ?1"
    ))
    .bind(job_id)
    .fetch_optional(conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))
}

pub async fn insert_job<'c, E: sqlx::Executor<'c, Database = sqlx::Sqlite>>(
    conn: E,
    job: &JobRow,
) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT INTO ai_jobs (job_id, owner_instance_id, principal, capability, key, input_hash,
                              state, state_revision, dispatch_state, attempt_id, provider,
                              model, created_at, updated_at, result_proposal_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13, ?14)",
    )
    .bind(&job.job_id)
    .bind(&job.owner_instance_id)
    .bind(&job.principal)
    .bind(&job.capability)
    .bind(&job.key)
    .bind(&job.input_hash)
    .bind(&job.state)
    .bind(job.state_revision)
    .bind(&job.dispatch_state)
    .bind(&job.attempt_id)
    .bind(&job.provider)
    .bind(&job.model)
    .bind(job.created_at)
    .bind(&job.result_proposal_id)
    .execute(conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

/// 未完结（accepted/running）任务数：排队容量检查用。
pub async fn count_incomplete_jobs<'c, E: sqlx::Executor<'c, Database = sqlx::Sqlite>>(
    conn: E,
    owner_instance_id: &str,
) -> Result<i64, StoreError> {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM ai_jobs
         WHERE owner_instance_id = ?1 AND state IN ('accepted', 'running')",
    )
    .bind(owner_instance_id)
    .fetch_one(conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))
}

/// 状态 CAS：只在 from_state + expected_revision 都匹配时前进。
/// 终态不可复活由调用方只从非终态转出 + 这里的 from_state 匹配共同保证。
pub async fn cas_job_state<'c, E: sqlx::Executor<'c, Database = sqlx::Sqlite>>(
    conn: E,
    job_id: &str,
    from_state: &str,
    expected_revision: i64,
    to_state: &str,
    now_ms: i64,
) -> Result<bool, StoreError> {
    let result = sqlx::query(
        "UPDATE ai_jobs SET state = ?3, state_revision = state_revision + 1, updated_at = ?4
         WHERE job_id = ?1 AND state = ?2 AND state_revision = ?5",
    )
    .bind(job_id)
    .bind(from_state)
    .bind(to_state)
    .bind(now_ms)
    .bind(expected_revision)
    .execute(conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(result.rows_affected() > 0)
}

/// 派发标记：单向 not_dispatched → may_have_been_sent，只在 running 下成立；
/// 「一个 job 最多一次派发」由 WHERE dispatch_state 保证。
pub async fn mark_dispatched<'c, E: sqlx::Executor<'c, Database = sqlx::Sqlite>>(
    conn: E,
    job_id: &str,
    attempt_id: &str,
) -> Result<bool, StoreError> {
    let result = sqlx::query(
        "UPDATE ai_jobs SET dispatch_state = 'may_have_been_sent', attempt_id = ?2
         WHERE job_id = ?1 AND dispatch_state = 'not_dispatched' AND state = 'running'",
    )
    .bind(job_id)
    .bind(attempt_id)
    .execute(conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(result.rows_affected() > 0)
}

/// 成功收口的组成部分：写 result_proposal_id（与状态 CAS 同事务由服务层编排）。
pub async fn attach_proposal<'c, E: sqlx::Executor<'c, Database = sqlx::Sqlite>>(
    conn: E,
    job_id: &str,
    proposal_id: &str,
) -> Result<(), StoreError> {
    sqlx::query("UPDATE ai_jobs SET result_proposal_id = ?2 WHERE job_id = ?1")
        .bind(job_id)
        .bind(proposal_id)
        .execute(conn)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

/// 稳定游标列表：(created_at, job_id) keyset 倒序；owner 过滤强制在 WHERE 里。
pub async fn list_jobs<'c, E: sqlx::Executor<'c, Database = sqlx::Sqlite>>(
    conn: E,
    owner_instance_id: &str,
    before_created_at: Option<i64>,
    before_job_id: Option<&str>,
    limit: i64,
) -> Result<Vec<JobRow>, StoreError> {
    let rows = match (before_created_at, before_job_id) {
        (Some(created), Some(job_id)) => {
            sqlx::query_as(&format!(
                "SELECT {JOB_COLUMNS} FROM ai_jobs
                 WHERE owner_instance_id = ?1 AND (created_at < ?2 OR (created_at = ?2 AND job_id < ?3))
                 ORDER BY created_at DESC, job_id DESC LIMIT ?4"
            ))
            .bind(owner_instance_id)
            .bind(created)
            .bind(job_id)
            .bind(limit)
            .fetch_all(conn)
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?
        }
        _ => {
            sqlx::query_as(&format!(
                "SELECT {JOB_COLUMNS} FROM ai_jobs
                 WHERE owner_instance_id = ?1
                 ORDER BY created_at DESC, job_id DESC LIMIT ?2"
            ))
            .bind(owner_instance_id)
            .bind(limit)
            .fetch_all(conn)
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?
        }
    };
    Ok(rows)
}

/// 过期清扫候选：排队超期（accepted 按受理时间）与执行超期（running 按
/// 最后一次状态推进时间）。
pub async fn expired_candidates<'c, E: sqlx::Executor<'c, Database = sqlx::Sqlite>>(
    conn: E,
    queue_deadline_ms: i64,
    run_deadline_ms: i64,
) -> Result<Vec<JobRow>, StoreError> {
    sqlx::query_as(&format!(
        "SELECT {JOB_COLUMNS} FROM ai_jobs
         WHERE (state = 'accepted' AND created_at < ?1)
            OR (state = 'running' AND updated_at < ?2)"
    ))
    .bind(queue_deadline_ms)
    .bind(run_deadline_ms)
    .fetch_all(conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))
}

/// 重启恢复候选：非终态任务（accepted/running → interrupted）。
pub async fn recovery_candidates<'c, E: sqlx::Executor<'c, Database = sqlx::Sqlite>>(
    conn: E,
) -> Result<Vec<JobRow>, StoreError> {
    sqlx::query_as(&format!(
        "SELECT {JOB_COLUMNS} FROM ai_jobs WHERE state IN ('accepted', 'running')"
    ))
    .fetch_all(conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))
}

pub async fn insert_proposal<'c, E: sqlx::Executor<'c, Database = sqlx::Sqlite>>(
    conn: E,
    proposal: &ProposalRow,
) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT INTO ai_proposals (proposal_id, job_id, validated_intent, schema_version,
                                   state, revision, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .bind(&proposal.proposal_id)
    .bind(&proposal.job_id)
    .bind(&proposal.validated_intent)
    .bind(&proposal.schema_version)
    .bind(&proposal.state)
    .bind(proposal.revision)
    .bind(proposal.created_at)
    .bind(proposal.expires_at)
    .execute(conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

pub async fn find_proposal<'c, E: sqlx::Executor<'c, Database = sqlx::Sqlite>>(
    conn: E,
    proposal_id: &str,
) -> Result<Option<ProposalRow>, StoreError> {
    sqlx::query_as(
        "SELECT proposal_id, job_id, validated_intent, schema_version, state, revision,
                created_at, expires_at
         FROM ai_proposals WHERE proposal_id = ?1",
    )
    .bind(proposal_id)
    .fetch_optional(conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))
}

/// 提案状态 CAS：pending → rejected / expired，revision +1。
pub async fn cas_proposal_state<'c, E: sqlx::Executor<'c, Database = sqlx::Sqlite>>(
    conn: E,
    proposal_id: &str,
    expected_revision: i64,
    to_state: &str,
) -> Result<bool, StoreError> {
    let result = sqlx::query(
        "UPDATE ai_proposals SET state = ?3, revision = revision + 1
         WHERE proposal_id = ?1 AND state = 'pending' AND revision = ?2",
    )
    .bind(proposal_id)
    .bind(expected_revision)
    .bind(to_state)
    .execute(conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(result.rows_affected() > 0)
}

pub async fn get_or_create_month(
    conn: &mut sqlx::SqliteConnection,
    month: &str,
) -> Result<BudgetRow, StoreError> {
    let existing: Option<BudgetRow> = sqlx::query_as(
        "SELECT month, reserved_micro_usd, charged_micro_usd, revision
         FROM ai_budget_months WHERE month = ?1",
    )
    .bind(month)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    if let Some(row) = existing {
        return Ok(row);
    }
    sqlx::query("INSERT OR IGNORE INTO ai_budget_months (month) VALUES (?1)")
        .bind(month)
        .execute(&mut *conn)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    sqlx::query_as(
        "SELECT month, reserved_micro_usd, charged_micro_usd, revision
         FROM ai_budget_months WHERE month = ?1",
    )
    .bind(month)
    .fetch_one(conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))
}

/// 预算公式（§8.4）：`charged + reserved + new <= limit`。整数 micro-USD。
pub async fn reserve(
    conn: &mut sqlx::SqliteConnection,
    month: &str,
    amount_micro_usd: i64,
    limit_micro_usd: i64,
) -> Result<BudgetRow, StoreError> {
    let current = get_or_create_month(&mut *conn, month).await?;
    if current
        .charged_micro_usd
        .saturating_add(current.reserved_micro_usd)
        .saturating_add(amount_micro_usd)
        > limit_micro_usd
    {
        return Err(StoreError::Database(format!(
            "budget_exceeded:{limit_micro_usd}"
        )));
    }
    sqlx::query(
        "UPDATE ai_budget_months
         SET reserved_micro_usd = reserved_micro_usd + ?2, revision = revision + 1
         WHERE month = ?1",
    )
    .bind(month)
    .bind(amount_micro_usd)
    .execute(&mut *conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    get_or_create_month(&mut *conn, month).await
}

/// 结算：`release` 部分归还预留，`charge` 部分计入已用（unknown 结算时
/// 两者之和等于该任务仍占用的预留）。防负由 MAX 保护，revision 前进。
pub async fn settle(
    conn: &mut sqlx::SqliteConnection,
    month: &str,
    release_micro_usd: i64,
    charge_micro_usd: i64,
) -> Result<BudgetRow, StoreError> {
    sqlx::query(
        "UPDATE ai_budget_months
         SET reserved_micro_usd = MAX(reserved_micro_usd - ?2, 0),
             charged_micro_usd = charged_micro_usd + ?3,
             revision = revision + 1
         WHERE month = ?1",
    )
    .bind(month)
    .bind(release_micro_usd)
    .bind(charge_micro_usd)
    .execute(&mut *conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    get_or_create_month(&mut *conn, month).await
}

/// 受理时间水位（§7.2）：只增不减，返回生效后的水位。水位写入与任务
/// 受理同事务；`owner_instance_id` 由服务层从实例身份查询后传入。
pub async fn advance_watermark(
    conn: &mut sqlx::SqliteConnection,
    owner_instance_id: &str,
    now_ms: i64,
) -> Result<i64, StoreError> {
    ensure_instance_row(&mut *conn, owner_instance_id).await?;
    sqlx::query(
        "UPDATE ai_instance SET accepted_watermark = MAX(accepted_watermark, ?1) WHERE id = 1",
    )
    .bind(now_ms)
    .execute(&mut *conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    read_watermark(&mut *conn).await
}

pub async fn accepted_watermark(conn: &mut sqlx::SqliteConnection) -> Result<i64, StoreError> {
    read_watermark(conn).await
}

async fn read_watermark(conn: &mut sqlx::SqliteConnection) -> Result<i64, StoreError> {
    sqlx::query_scalar("SELECT accepted_watermark FROM ai_instance WHERE id = 1")
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))
}

async fn ensure_instance_row(
    conn: &mut sqlx::SqliteConnection,
    owner_instance_id: &str,
) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT OR IGNORE INTO ai_instance (id, owner_instance_id, policy_revision,
                                            schema_version, accepted_watermark)
         VALUES (1, ?1, 0, 1, 0)",
    )
    .bind(owner_instance_id)
    .execute(&mut *conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// usage entries 与熔断（R4-B）：每任务一条账目；熔断是持久闩锁。
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct UsageEntryRow {
    pub job_id: String,
    pub reservation_micro_usd: i64,
    pub accounted_micro_usd: i64,
    pub usage_state: String,
    pub pricing_snapshot: String,
    pub revision: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct BudgetGuardRow {
    pub owner_instance_id: String,
    pub halted: bool,
    pub reason: String,
    pub trigger_job: Option<String>,
    pub revision: i64,
}

/// 结算账目：与任务终态同事务写入。job_id 唯一——重复结算（并发赢家
/// 竞争的输家不应到达这里，这里再挡一道）以 INSERT OR IGNORE 幂等。
pub async fn insert_usage_entry<'c, E: sqlx::Executor<'c, Database = sqlx::Sqlite>>(
    conn: E,
    entry: &UsageEntryRow,
) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT OR IGNORE INTO ai_usage_entries (job_id, reservation_micro_usd,
                                                accounted_micro_usd, usage_state,
                                                pricing_snapshot, revision, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(&entry.job_id)
    .bind(entry.reservation_micro_usd)
    .bind(entry.accounted_micro_usd)
    .bind(&entry.usage_state)
    .bind(&entry.pricing_snapshot)
    .bind(entry.revision)
    .bind(entry.created_at)
    .execute(conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

pub async fn find_usage_entry<'c, E: sqlx::Executor<'c, Database = sqlx::Sqlite>>(
    conn: E,
    job_id: &str,
) -> Result<Option<UsageEntryRow>, StoreError> {
    sqlx::query_as(
        "SELECT job_id, reservation_micro_usd, accounted_micro_usd, usage_state,
                pricing_snapshot, revision, created_at
         FROM ai_usage_entries WHERE job_id = ?1",
    )
    .bind(job_id)
    .fetch_optional(conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))
}

/// 熔断闩锁行；没有就建（owner 来自服务端实例身份）。
pub async fn ensure_budget_guard(
    conn: &mut sqlx::SqliteConnection,
    owner_instance_id: &str,
) -> Result<BudgetGuardRow, StoreError> {
    let existing: Option<BudgetGuardRow> = sqlx::query_as(
        "SELECT owner_instance_id, halted, reason, trigger_job, revision
         FROM ai_budget_guard WHERE id = 1",
    )
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    if let Some(row) = existing {
        return Ok(row);
    }
    sqlx::query("INSERT OR IGNORE INTO ai_budget_guard (id, owner_instance_id) VALUES (1, ?1)")
        .bind(owner_instance_id)
        .execute(&mut *conn)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    sqlx::query_as(
        "SELECT owner_instance_id, halted, reason, trigger_job, revision
         FROM ai_budget_guard WHERE id = 1",
    )
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))
}

/// 熔断置位：幂等闩锁（已 halt 时不重复推进 revision）。`trigger_job`
/// 记录第一个触发的任务，便于事后对账。
pub async fn halt_budget_guard(
    conn: &mut sqlx::SqliteConnection,
    owner_instance_id: &str,
    reason: &str,
    trigger_job: &str,
) -> Result<BudgetGuardRow, StoreError> {
    ensure_budget_guard(&mut *conn, owner_instance_id).await?;
    sqlx::query(
        "UPDATE ai_budget_guard
         SET halted = 1, reason = ?2, trigger_job = ?3, revision = revision + 1
         WHERE id = 1 AND halted = 0",
    )
    .bind(owner_instance_id)
    .bind(reason)
    .bind(trigger_job)
    .execute(&mut *conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    sqlx::query_as(
        "SELECT owner_instance_id, halted, reason, trigger_job, revision
         FROM ai_budget_guard WHERE id = 1",
    )
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))
}

/// 熔断复位：官方管理专用，expectedRevision CAS——并发复位只有一个赢家，
/// 复位必须确认在飞调用已结清（那个判断在服务层）。
pub async fn reset_budget_guard<'c, E: sqlx::Executor<'c, Database = sqlx::Sqlite>>(
    conn: E,
    expected_revision: i64,
) -> Result<bool, StoreError> {
    let result = sqlx::query(
        "UPDATE ai_budget_guard
         SET halted = 0, reason = '', trigger_job = NULL, revision = revision + 1
         WHERE id = 1 AND halted = 1 AND revision = ?1",
    )
    .bind(expected_revision)
    .execute(conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(result.rows_affected() > 0)
}

pub async fn budget_guard<'c, E: sqlx::Executor<'c, Database = sqlx::Sqlite>>(
    conn: E,
) -> Result<Option<BudgetGuardRow>, StoreError> {
    sqlx::query_as(
        "SELECT owner_instance_id, halted, reason, trigger_job, revision
         FROM ai_budget_guard WHERE id = 1",
    )
    .fetch_optional(conn)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))
}
