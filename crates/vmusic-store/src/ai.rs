// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! AI 受限授权的仓储：DataDir 实例身份与 grants 表（技术路线 R2-G）。
//!
//! 只存凭据的 SHA-256 摘要——明文凭据由服务层写入 DataDir 下受保护的
//! 凭据文件，本层永远接触不到，也就不可能落进备份或日志。grants 的
//! 写入路径都很短：单条 INSERT/UPDATE，不与曲库表交叉。

use sqlx::SqlitePool;
use vmusic_core::StoreError;

use crate::now_ms;

/// `ai_instance` 的单行。`owner_instance_id` 每 DataDir 首次创建后持久不变，
/// 是任务/授权/预算的归属身份；`serverInstanceId`（每次启动随机）不属于
/// 本表，它存活在服务进程内存里。
#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct InstanceRow {
    pub owner_instance_id: String,
    pub policy_revision: i64,
    pub schema_version: i64,
}

#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct GrantRow {
    pub grant_id: String,
    pub label: String,
    pub credential_digest: String,
    /// JSON 字符串数组。授权集合很小且必须逐项走白名单校验，
    /// 反序列化交给服务层，本层不做 JSON 解释。
    pub scopes: String,
    pub revoked: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 取实例身份行；没有就生成 `owner_instance_id` 并落一行。
/// 并发首启时 `INSERT OR IGNORE` 保证两方拿到同一个 id。
pub async fn get_or_create_instance(pool: &SqlitePool) -> Result<InstanceRow, StoreError> {
    let existing: Option<InstanceRow> = sqlx::query_as(
        "SELECT owner_instance_id, policy_revision, schema_version FROM ai_instance WHERE id = 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    if let Some(row) = existing {
        return Ok(row);
    }
    let owner = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT OR IGNORE INTO ai_instance (id, owner_instance_id, policy_revision, schema_version)
         VALUES (1, ?1, 0, 1)",
    )
    .bind(&owner)
    .execute(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    sqlx::query_as(
        "SELECT owner_instance_id, policy_revision, schema_version FROM ai_instance WHERE id = 1",
    )
    .fetch_one(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))
}

/// 授权策略变更：全局水位 +1，返回新值。受限门面在 context 里上报它，
/// 适配器看到变化就重新拉取 context，旧上下文不再被信任。
pub async fn bump_policy_revision(pool: &SqlitePool) -> Result<i64, StoreError> {
    get_or_create_instance(pool).await?;
    let revision: i64 = sqlx::query_scalar(
        "UPDATE ai_instance SET policy_revision = policy_revision + 1
         WHERE id = 1 RETURNING policy_revision",
    )
    .fetch_one(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(revision)
}

/// 新建 grant。凭据摘要由服务层算好传入；本层不生成凭据。
pub async fn insert_grant(
    pool: &SqlitePool,
    grant_id: &str,
    label: &str,
    credential_digest: &str,
    scopes: &str,
) -> Result<(), StoreError> {
    let now = now_ms();
    sqlx::query(
        "INSERT INTO ai_grants (grant_id, label, credential_digest, scopes, revoked, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)",
    )
    .bind(grant_id)
    .bind(label)
    .bind(credential_digest)
    .bind(scopes)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

pub async fn list_grants(pool: &SqlitePool) -> Result<Vec<GrantRow>, StoreError> {
    sqlx::query_as(
        "SELECT grant_id, label, credential_digest, scopes, revoked, created_at, updated_at
         FROM ai_grants ORDER BY created_at, grant_id",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))
}

/// 按凭据摘要查 grant。**不过滤 revoked**：门面需要区分「查无此凭据」（401）
/// 与「凭据已被撤销」（403），撤权检查在读任何缓存之前就在这里生效。
pub async fn find_grant_by_digest(
    pool: &SqlitePool,
    credential_digest: &str,
) -> Result<Option<GrantRow>, StoreError> {
    sqlx::query_as(
        "SELECT grant_id, label, credential_digest, scopes, revoked, created_at, updated_at
         FROM ai_grants WHERE credential_digest = ?1",
    )
    .bind(credential_digest)
    .fetch_optional(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))
}

pub async fn find_grant_by_id(
    pool: &SqlitePool,
    grant_id: &str,
) -> Result<Option<GrantRow>, StoreError> {
    sqlx::query_as(
        "SELECT grant_id, label, credential_digest, scopes, revoked, created_at, updated_at
         FROM ai_grants WHERE grant_id = ?1",
    )
    .bind(grant_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))
}

/// 轮换凭据：替换摘要。返回是否存在该 grant。
pub async fn update_grant_credential(
    pool: &SqlitePool,
    grant_id: &str,
    credential_digest: &str,
) -> Result<bool, StoreError> {
    let result = sqlx::query(
        "UPDATE ai_grants SET credential_digest = ?2, updated_at = ?3 WHERE grant_id = ?1",
    )
    .bind(grant_id)
    .bind(credential_digest)
    .bind(now_ms())
    .execute(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(result.rows_affected() > 0)
}

/// 撤销 grant：即时失去新调用权限（不删除行，历史可查）。返回是否存在。
pub async fn revoke_grant(pool: &SqlitePool, grant_id: &str) -> Result<bool, StoreError> {
    let result = sqlx::query(
        "UPDATE ai_grants SET revoked = 1, updated_at = ?2 WHERE grant_id = ?1 AND revoked = 0",
    )
    .bind(grant_id)
    .bind(now_ms())
    .execute(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(result.rows_affected() > 0)
}
