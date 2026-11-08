// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 壁纸库（wallpaper.db）内核：P1 子集（设计 docs/desktop-wallpaper.md §4.2、§7.2）。
//!
//! 库只由桌面宿主写：WAL、外键开启、`BEGIN IMMEDIATE` 短事务（与 vmusic-store
//! 同一约定）。查询为 runtime-checked（sqlx::query_as），不带 `.sqlx` 元数据。
//! 安装事务固定顺序：packages（原包不可变）→ works（(source,remote) 幂等映射）
//! → versions（同 work+version 幂等 / 同版本异 hash 拒绝）。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use sqlx::{FromRow, SqlitePool};

use crate::wallpaper::jobs::JobError;

/// 模块内 Result 别名：错误固定为 JobError（遮蔽 prelude 双参 Result）。
type Result<T> = std::result::Result<T, JobError>;

/// 本机作品的固定来源 id（§4.2：本机新作品属于固定 local 来源）。
pub const LOCAL_SOURCE: &str = "local";

#[derive(Debug, Clone, serde::Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct WorkRow {
    pub work_key: String,
    pub source_id: String,
    pub remote_work_id: Option<String>,
    pub title: String,
    pub description: String,
    pub kind: String,
    pub favorite: i64,
    pub archived: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, FromRow)]
pub(crate) struct PackageRow {
    pub(crate) package_hash: String,
    #[allow(dead_code)]
    pub(crate) bytes: i64,
    #[allow(dead_code)]
    pub(crate) state: String,
}

/// 安装一条「作品+版本+不可变包」记录。目录发布已由 AssetStore 完成；
/// 本函数只负责 DB 侧短事务（§7.2 最后一步）。
#[derive(Debug, Clone)]
pub struct InstallWork {
    /// 作者写入包的逻辑 UUID（manifest.workId）；来源内幂等映射。
    pub remote_work_id: String,
    pub work_key: String,
    pub title: String,
    pub description: String,
    pub kind: String,
    pub package_hash: String,
    pub manifest_json: String,
    pub package_bytes: u64,
    pub version: u32,
    pub source_id: String,
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VersionRow {
    pub version_key: String,
    pub version: i64,
    pub package_hash: String,
    pub state: String,
}

#[derive(sqlx::FromRow)]
pub(crate) struct ImportOperation {
    pub job_id: String,
    pub payload_digest: String,
}

/// 已校验的删除计划：先移除不再被任何版本引用的包目录，再删除库行。
#[derive(Debug, Clone)]
pub(crate) struct Deletion {
    pub(crate) work_key: String,
    pub(crate) delete_work: bool,
    pub(crate) versions: Vec<VersionRow>,
    /// 删除这些版本后不再被任何版本引用的包 hash；共享包保留。
    pub(crate) package_hashes: Vec<String>,
}

pub struct Library {
    pool: SqlitePool,
    #[allow(dead_code)]
    path: PathBuf,
}

impl Library {
    /// 打开（或创建）wallpaper.db 并执行独立迁移。
    pub async fn open(dir: &Path) -> Result<Self> {
        let path = dir.join("wallpaper.db");
        let pool = crate::wallpaper_upgrade::open_library(dir)
            .await
            .map_err(|error| JobError::database(format!("{error:#}")))?;
        Ok(Self { pool, path })
    }

    /// Pool 句柄仅供同类内部的库间操作（崩溃恢复）使用。
    pub(crate) fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// 安装事务（§7.2：BEGIN IMMEDIATE 插入作品/版本/包）。幂等规则：
    /// 相同 hash 再导入返回既有事实；同 work+version 不同 hash 拒绝；
    /// 来源内相同 workId 复用既有 work_key，不建立第二份作品。
    pub async fn install(&self, work: &InstallWork) -> Result<()> {
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|error| JobError::database(error.to_string()))?;
        let now = now_secs();
        // 包行：原包不可变——同 hash 幂等，绝不改写既有行。
        let existing: Option<PackageRow> = sqlx::query_as(
            "SELECT package_hash, bytes, state FROM packages WHERE package_hash = ?1",
        )
        .bind(&work.package_hash)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|error| JobError::database(error.to_string()))?;
        match existing {
            None => {
                sqlx::query(
                    "INSERT INTO packages (package_hash, manifest_json, installed_at, bytes, state)
                     VALUES (?1, ?2, ?3, ?4, 'installed')",
                )
                .bind(&work.package_hash)
                .bind(&work.manifest_json)
                .bind(now)
                .bind(work.package_bytes as i64)
                .execute(&mut *tx)
                .await
                .map_err(|error| JobError::database(error.to_string()))?;
            }
            Some(row) => {
                if row.bytes != work.package_bytes as i64 {
                    return Err(JobError::hash_conflict(format!(
                        "packageHash {} 已存在但字节数不符（{} ≠ {}）",
                        work.package_hash, row.bytes, work.package_bytes
                    )));
                }
                if row.state == "unavailable" {
                    sqlx::query("UPDATE packages SET state = 'installed' WHERE package_hash = ?1")
                        .bind(&work.package_hash)
                        .execute(&mut *tx)
                        .await
                        .map_err(|error| JobError::database(error.to_string()))?;
                }
            }
        }
        // 作品行：(source, remote) 幂等映射到既有 work_key。
        let existing_key: Option<String> = sqlx::query_scalar(
            "SELECT work_key FROM works WHERE source_id = ?1 AND remote_work_id = ?2",
        )
        .bind(&work.source_id)
        .bind(&work.remote_work_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|error| JobError::database(error.to_string()))?;
        let work_key = match existing_key {
            Some(key) => key,
            None => {
                sqlx::query(
                    "INSERT INTO works (work_key, source_id, remote_work_id, title, description, kind, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                )
                .bind(&work.work_key)
                .bind(&work.source_id)
                .bind(&work.remote_work_id)
                .bind(&work.title)
                .bind(&work.description)
                .bind(&work.kind)
                .bind(now)
                .execute(&mut *tx)
                .await
                .map_err(|error| JobError::database(error.to_string()))?;
                work.work_key.clone()
            }
        };
        // 版本行：同 work+version 幂等；同版本异 hash 拒绝（§4.2）。
        let existing_hash: Option<String> = sqlx::query_scalar(
            "SELECT package_hash FROM versions WHERE work_key = ?1 AND version = ?2",
        )
        .bind(&work_key)
        .bind(work.version as i64)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|error| JobError::database(error.to_string()))?;
        match existing_hash {
            Some(hash) if hash == work.package_hash => {}
            Some(hash) => {
                return Err(JobError::hash_conflict(format!(
                    "作品 {} 的版本 {} 已绑定其它包 {}（新包 {}）",
                    work_key, work.version, hash, work.package_hash
                )));
            }
            None => {
                sqlx::query(
                    "INSERT INTO versions (version_key, work_key, version, package_hash, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                )
                .bind(format!("{work_key}@{}", work.version))
                .bind(&work_key)
                .bind(work.version as i64)
                .bind(&work.package_hash)
                .bind(now)
                .execute(&mut *tx)
                .await
                .map_err(|error| JobError::database(error.to_string()))?;
            }
        }
        tx.commit()
            .await
            .map_err(|error| JobError::database(error.to_string()))?;
        Ok(())
    }

    /// 裸媒体按固定字节身份复用最初生成的 manifest，改名后再次导入仍幂等。
    pub(crate) async fn local_manifest(&self, remote_work_id: &str) -> Result<Option<String>> {
        sqlx::query_scalar("SELECT p.manifest_json FROM works w JOIN versions v ON v.work_key = w.work_key JOIN packages p ON p.package_hash = v.package_hash WHERE w.source_id = 'local' AND w.remote_work_id = ?1 AND v.version = 1 LIMIT 1")
            .bind(remote_work_id).fetch_optional(&self.pool).await.map_err(|error| JobError::database(error.to_string()))
    }

    /// 包是否已索引（崩溃恢复与重复导入的判据）。
    pub async fn is_installed(&self, package_hash: &str) -> Result<bool> {
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM packages WHERE package_hash = ?1")
                .bind(package_hash)
                .fetch_one(&self.pool)
                .await
                .map_err(|error| JobError::database(error.to_string()))?;
        Ok(count > 0)
    }

    /// 已索引包的 hash 集合（启动恢复只对这些目录信任）。
    pub async fn installed_hashes(&self) -> Result<Vec<String>> {
        sqlx::query_scalar("SELECT package_hash FROM packages ORDER BY installed_at")
            .fetch_all(&self.pool)
            .await
            .map_err(|error| JobError::database(error.to_string()))
    }

    /// 已索引包的（hash → bytes, state）映射，恢复核对用。
    pub(crate) async fn installed_packages(&self) -> Result<Vec<PackageRow>> {
        sqlx::query_as("SELECT package_hash, bytes, state FROM packages")
            .fetch_all(&self.pool)
            .await
            .map_err(|error| JobError::database(error.to_string()))
    }

    /// 目录缺失的包标记 unavailable（§7.2：布局保留引用并报告）。
    pub async fn mark_unavailable(&self, package_hash: &str) -> Result<()> {
        sqlx::query("UPDATE packages SET state = 'unavailable' WHERE package_hash = ?1")
            .bind(package_hash)
            .execute(&self.pool)
            .await
            .map_err(|error| JobError::database(error.to_string()))?;
        Ok(())
    }

    pub(crate) async fn mark_available(&self, package_hash: &str) -> Result<()> {
        sqlx::query("UPDATE packages SET state = 'installed' WHERE package_hash = ?1 AND state = 'unavailable'")
            .bind(package_hash).execute(&self.pool).await
            .map_err(|error| JobError::database(error.to_string()))?;
        Ok(())
    }

    /// 作品分页（cursor = 上一页末尾的 created_at|work_key；单页 ≤50，§14.2）。
    pub async fn list_works(
        &self,
        limit: u32,
        cursor: Option<&str>,
    ) -> Result<(Vec<WorkRow>, Option<String>)> {
        self.list_works_filtered(limit, cursor, false).await
    }

    /// 收藏筛选与普通分页共用同一游标；收藏状态变化后由设置页重新读取。
    pub(crate) async fn list_works_filtered(
        &self,
        limit: u32,
        cursor: Option<&str>,
        favorites_only: bool,
    ) -> Result<(Vec<WorkRow>, Option<String>)> {
        let limit = limit.clamp(1, 50) as i64;
        let rows: Vec<WorkRow> = match (cursor, favorites_only) {
            (None, false) => sqlx::query_as(
                "SELECT * FROM works ORDER BY created_at DESC, work_key DESC LIMIT ?1",
            )
            .bind(limit + 1)
            .fetch_all(&self.pool)
            .await
            .map_err(|error| JobError::database(error.to_string()))?,
            (None, true) => sqlx::query_as(
                "SELECT * FROM works WHERE favorite = 1 ORDER BY created_at DESC, work_key DESC LIMIT ?1",
            )
            .bind(limit + 1)
            .fetch_all(&self.pool)
            .await
            .map_err(|error| JobError::database(error.to_string()))?,
            (Some(cursor), false) => {
                let (created_at, key) = parse_cursor(cursor)?;
                sqlx::query_as(
                    "SELECT * FROM works WHERE (created_at < ?1) OR (created_at = ?1 AND work_key < ?2)
                     ORDER BY created_at DESC, work_key DESC LIMIT ?3",
                )
                .bind(created_at)
                .bind(key)
                .bind(limit + 1)
                .fetch_all(&self.pool)
                .await
                .map_err(|error| JobError::database(error.to_string()))?
            }
            (Some(cursor), true) => {
                let (created_at, key) = parse_cursor(cursor)?;
                sqlx::query_as(
                    "SELECT * FROM works WHERE favorite = 1 AND ((created_at < ?1) OR (created_at = ?1 AND work_key < ?2))
                     ORDER BY created_at DESC, work_key DESC LIMIT ?3",
                )
                .bind(created_at)
                .bind(key)
                .bind(limit + 1)
                .fetch_all(&self.pool)
                .await
                .map_err(|error| JobError::database(error.to_string()))?
            }
        };
        let mut next = None;
        if rows.len() as i64 > limit {
            let last = rows[limit as usize - 1].clone();
            next = Some(format!("{}|{}", last.created_at, last.work_key));
        }
        Ok((rows.into_iter().take(limit as usize).collect(), next))
    }

    /// 单作品详情（§14.2：详情 ≤64 KiB——字段本身有界）。
    pub async fn get_work(&self, work_key: &str) -> Result<Option<WorkRow>> {
        sqlx::query_as("SELECT * FROM works WHERE work_key = ?1")
            .bind(work_key)
            .fetch_optional(&self.pool)
            .await
            .map_err(|error| JobError::database(error.to_string()))
    }

    /// 收藏只改变展示状态，不触碰包/版本引用。
    pub(crate) async fn set_favorite(&self, work_key: &str, favorite: bool) -> Result<WorkRow> {
        let changed =
            sqlx::query("UPDATE works SET favorite = ?1, updated_at = ?2 WHERE work_key = ?3")
                .bind(i64::from(favorite))
                .bind(now_secs())
                .bind(work_key)
                .execute(&self.pool)
                .await
                .map_err(|error| JobError::database(error.to_string()))?
                .rows_affected();
        if changed == 0 {
            return Err(JobError::new("work_not_found", "作品不存在"));
        }
        self.get_work(work_key)
            .await?
            .ok_or_else(|| JobError::new("work_not_found", "作品不存在"))
    }

    /// A fixed selection must belong to this work, including versions outside a UI page.
    pub(crate) async fn contains_version(
        &self,
        work_key: &str,
        package_hash: &str,
    ) -> Result<bool> {
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM versions v JOIN packages p ON p.package_hash=v.package_hash WHERE v.work_key=?1 AND v.package_hash=?2 AND p.state='installed')")
            .bind(work_key).bind(package_hash).fetch_one(&self.pool).await
            .map_err(|error| JobError::database(error.to_string()))
    }

    /// Bounded metadata from a completed installation, including subsequently unavailable bytes.
    /// This is not decode qualification: playback still verifies the immutable package itself.
    pub(crate) async fn cover_manifest(
        &self,
        work_key: &str,
        package_hash: &str,
    ) -> Result<hertz_wallpaper::Manifest> {
        let json: Option<String> = sqlx::query_scalar("SELECT p.manifest_json FROM versions v JOIN packages p ON p.package_hash=v.package_hash WHERE v.work_key=?1 AND v.package_hash=?2 AND p.state IN ('installed','unavailable') AND length(CAST(p.manifest_json AS BLOB))<=?3 LIMIT 1")
            .bind(work_key).bind(package_hash).bind(hertz_wallpaper::MAX_MANIFEST_BYTES as i64)
            .fetch_optional(&self.pool).await.map_err(|error| JobError::database(error.to_string()))?;
        let json = json.ok_or_else(|| {
            JobError::new("version_not_found", "作品没有这个已登记版本或其清单无效")
        })?;
        hertz_wallpaper::validate_manifest_bytes(json.as_bytes()).map_err(Into::into)
    }

    pub(crate) async fn versions(&self, work_key: &str) -> Result<Vec<VersionRow>> {
        sqlx::query_as("SELECT v.version_key, v.version, v.package_hash, p.state FROM versions v JOIN packages p ON p.package_hash = v.package_hash WHERE v.work_key = ?1 ORDER BY v.version DESC LIMIT 100")
            .bind(work_key).fetch_all(&self.pool).await.map_err(|error| JobError::database(error.to_string()))
    }

    /// 删除计划必须看到该作品的全部版本，不能受详情页最多 100 条的展示上限影响。
    async fn all_versions(&self, work_key: &str) -> Result<Vec<VersionRow>> {
        sqlx::query_as("SELECT v.version_key, v.version, v.package_hash, p.state FROM versions v JOIN packages p ON p.package_hash = v.package_hash WHERE v.work_key = ?1 ORDER BY v.version DESC")
            .bind(work_key)
            .fetch_all(&self.pool)
            .await
            .map_err(|error| JobError::database(error.to_string()))
    }

    /// 只读计划：在一个作品或单个版本上计算要删的版本行与不再被引用的包。
    /// 调用方必须在整个删除期间持有内容写门，避免并发的同 hash 安装改变引用。
    pub(crate) async fn plan_deletion(
        &self,
        work_key: &str,
        version: Option<i64>,
    ) -> Result<Deletion> {
        let work = self
            .get_work(work_key)
            .await?
            .ok_or_else(|| JobError::new("work_not_found", "作品不存在"))?;
        let versions = self.all_versions(work_key).await?;
        let targets: Vec<VersionRow> = match version {
            Some(version) => versions
                .iter()
                .filter(|row| row.version == version)
                .cloned()
                .collect(),
            None => versions.clone(),
        };
        if version.is_some() && targets.is_empty() {
            return Err(JobError::new("version_not_found", "作品版本不存在"));
        }
        let target_keys: HashSet<&str> =
            targets.iter().map(|row| row.version_key.as_str()).collect();
        let delete_work = versions
            .iter()
            .all(|row| target_keys.contains(row.version_key.as_str()));
        let mut package_hashes = Vec::new();
        let mut seen = HashSet::new();
        for target in &targets {
            if !seen.insert(target.package_hash.clone()) {
                continue;
            }
            let referenced: Vec<String> =
                sqlx::query_scalar("SELECT version_key FROM versions WHERE package_hash = ?1")
                    .bind(&target.package_hash)
                    .fetch_all(&self.pool)
                    .await
                    .map_err(|error| JobError::database(error.to_string()))?;
            if referenced
                .iter()
                .all(|key| target_keys.contains(key.as_str()))
            {
                package_hashes.push(target.package_hash.clone());
            }
        }
        Ok(Deletion {
            work_key: work.work_key,
            delete_work,
            versions: targets,
            package_hashes,
        })
    }

    /// 库行短事务。包目录已在此之前移除；若此处失败，损坏的包在下一次启动
    /// 恢复中标记 unavailable，而不会把已删除目录重新导入成作品。
    pub(crate) async fn delete_rows(&self, plan: &Deletion) -> Result<()> {
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|error| JobError::database(error.to_string()))?;
        for version in &plan.versions {
            sqlx::query("DELETE FROM versions WHERE version_key = ?1")
                .bind(&version.version_key)
                .execute(&mut *tx)
                .await
                .map_err(|error| JobError::database(error.to_string()))?;
        }
        if plan.delete_work {
            sqlx::query("DELETE FROM works WHERE work_key = ?1")
                .bind(&plan.work_key)
                .execute(&mut *tx)
                .await
                .map_err(|error| JobError::database(error.to_string()))?;
        }
        for package_hash in &plan.package_hashes {
            sqlx::query(
                "DELETE FROM packages WHERE package_hash = ?1
                 AND NOT EXISTS (SELECT 1 FROM versions WHERE package_hash = ?1)",
            )
            .bind(package_hash)
            .execute(&mut *tx)
            .await
            .map_err(|error| JobError::database(error.to_string()))?;
        }
        tx.commit()
            .await
            .map_err(|error| JobError::database(error.to_string()))?;
        Ok(())
    }

    pub(crate) async fn import_operation(
        &self,
        request_id: &str,
    ) -> Result<Option<ImportOperation>> {
        sqlx::query_as("SELECT job_id, payload_digest FROM install_jobs WHERE request_id = ?1")
            .bind(request_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|error| JobError::database(error.to_string()))
    }

    /// 请求身份与 queued 状态同一短事务落盘；不受内存历史淘汰影响。
    pub(crate) async fn accept_import(
        &self,
        status: &super::jobs::JobStatus,
        identity: &super::jobs::ImportIdentity,
    ) -> Result<String> {
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|error| JobError::database(error.to_string()))?;
        let existing: Option<ImportOperation> =
            sqlx::query_as("SELECT job_id, payload_digest FROM install_jobs WHERE request_id = ?1")
                .bind(&identity.request_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|error| JobError::database(error.to_string()))?;
        if let Some(existing) = existing {
            if existing.payload_digest != identity.payload_digest {
                return Err(JobError::new(
                    "request_id_conflict",
                    "相同请求 id 对应另一份输入",
                ));
            }
            return Ok(existing.job_id);
        }
        sqlx::query("INSERT INTO install_jobs(job_id, request_id, payload_digest, state, progress, updated_at) VALUES (?1, ?2, ?3, 'queued', ?4, ?5)")
            .bind(&status.job_id).bind(&identity.request_id).bind(&identity.payload_digest)
            .bind(serde_json::to_string(status).map_err(|error| JobError::invalid_input(error.to_string()))?)
            .bind(now_secs()).execute(&mut *tx).await.map_err(|error| JobError::database(error.to_string()))?;
        tx.commit()
            .await
            .map_err(|error| JobError::database(error.to_string()))?;
        Ok(status.job_id.clone())
    }

    pub(crate) async fn persisted_job(
        &self,
        job_id: &str,
    ) -> Result<Option<super::jobs::JobStatus>> {
        let row: Option<(String, Option<String>, Option<String>)> =
            sqlx::query_as("SELECT state, progress, error FROM install_jobs WHERE job_id = ?1")
                .bind(job_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|error| JobError::database(error.to_string()))?;
        row.map(|(state, progress, error)| {
            if let Some(status) =
                progress.and_then(|json| serde_json::from_str::<super::jobs::JobStatus>(&json).ok())
            {
                return Ok(status);
            }
            let state = serde_json::from_value(serde_json::Value::String(state))
                .map_err(|error| JobError::database(error.to_string()))?;
            Ok(super::jobs::JobStatus {
                job_id: job_id.to_string(),
                state,
                error,
                package_hash: None,
                staged_bytes: 0,
                generation: 0,
            })
        })
        .transpose()
    }

    pub(crate) async fn interrupt_imports(&self) -> Result<()> {
        sqlx::query("UPDATE install_jobs SET state = 'failed', error = 'interrupted: 宿主退出前任务未完成', progress = NULL, updated_at = ?1 WHERE state IN ('queued', 'preparing', 'publishing')")
            .bind(now_secs()).execute(&self.pool).await.map_err(|error| JobError::database(error.to_string()))?;
        Ok(())
    }

    /// 收尾任务记录（jobs.rs 在受理与终态写入）。
    pub(crate) async fn record_job(
        &self,
        job_id: &str,
        request_id: Option<&str>,
        state: &str,
        input_identity: Option<&str>,
        progress: Option<&str>,
        error: Option<&str>,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO install_jobs (job_id, request_id, payload_digest, state, input_identity, progress, error, updated_at)
             VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(job_id) DO UPDATE SET
               state = excluded.state, progress = excluded.progress,
               error = excluded.error, updated_at = excluded.updated_at",
        )
        .bind(job_id)
        .bind(request_id)
        .bind(state)
        .bind(input_identity)
        .bind(progress)
        .bind(error)
        .bind(now_secs())
        .execute(&self.pool)
        .await
        .map_err(|error| JobError::database(error.to_string()))?;
        Ok(())
    }
}

fn parse_cursor(cursor: &str) -> Result<(i64, String)> {
    let (created, key) = cursor
        .split_once('|')
        .ok_or_else(|| JobError::invalid_input("cursor 格式非法"))?;
    let created: i64 = created
        .parse()
        .map_err(|_| JobError::invalid_input("cursor 时间戳非法"))?;
    Ok((created, key.to_string()))
}

pub(crate) fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn temp_library(tag: &str) -> (Library, tempfileish::TempDir) {
        let dir = tempfileish::temp_dir(tag);
        let library = Library::open(dir.path()).await.expect("open");
        (library, dir)
    }

    fn work(hash: &str, remote: &str, version: u32) -> InstallWork {
        InstallWork {
            remote_work_id: remote.to_string(),
            work_key: format!("key-{remote}-{version}"),
            title: "静夜".into(),
            description: String::new(),
            kind: "image".into(),
            package_hash: hash.to_string(),
            manifest_json: format!(r#"{{"hash":"{hash}"}}"#),
            package_bytes: 70,
            version,
            source_id: LOCAL_SOURCE.into(),
        }
    }

    fn hash(tag: u8) -> String {
        format!("{tag:064x}")
    }

    #[tokio::test]
    async fn install_writes_all_three_rows_and_is_idempotent() {
        let (library, _dir) = temp_library("install-idem").await;
        library.install(&work(&hash(1), "uuid-a", 1)).await.unwrap();
        // 重复导入：同 hash 幂等。
        library.install(&work(&hash(1), "uuid-a", 1)).await.unwrap();
        assert!(library.is_installed(&hash(1)).await.unwrap());
        let (rows, next) = library.list_works(50, None).await.unwrap();
        assert_eq!(rows.len(), 1, "重复导入不得建立第二份作品");
        assert!(next.is_none());
    }

    #[tokio::test]
    async fn same_work_id_maps_to_existing_work_key() {
        let (library, _dir) = temp_library("work-map").await;
        library.install(&work(&hash(1), "uuid-a", 1)).await.unwrap();
        // 相同作者 workId 的新版本：复用既有 work_key。
        let mut second = work(&hash(2), "uuid-a", 2);
        second.work_key = "key-different".into();
        library.install(&second).await.unwrap();
        let detail = library.get_work("key-uuid-a-1").await.unwrap().unwrap();
        let _ = detail;
        let (rows, _) = library.list_works(50, None).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].work_key, "key-uuid-a-1");
    }

    #[tokio::test]
    async fn same_version_with_different_hash_is_rejected() {
        let (library, _dir) = temp_library("version-conflict").await;
        library.install(&work(&hash(1), "uuid-a", 1)).await.unwrap();
        let error = library
            .install(&work(&hash(2), "uuid-a", 1))
            .await
            .unwrap_err();
        assert_eq!(error.code, "version_hash_conflict");
    }

    #[tokio::test]
    async fn favorites_update_and_filter_with_the_same_cursor() {
        let (library, _dir) = temp_library("favorites").await;
        for index in 0..3u32 {
            library
                .install(&work(&hash(index as u8 + 1), &format!("uuid-{index}"), 1))
                .await
                .unwrap();
        }
        library.set_favorite("key-uuid-1-1", true).await.unwrap();
        library.set_favorite("key-uuid-2-1", true).await.unwrap();
        assert_eq!(
            library
                .set_favorite("missing", true)
                .await
                .unwrap_err()
                .code,
            "work_not_found"
        );
        let mut seen = Vec::new();
        let mut cursor = None;
        loop {
            let (rows, next) = library
                .list_works_filtered(1, cursor.as_deref(), true)
                .await
                .unwrap();
            assert_eq!(rows.len(), 1);
            seen.extend(rows.into_iter().map(|row| row.work_key));
            match next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(seen.len(), 2);
        assert!(seen.iter().all(|key| key != "key-uuid-0-1"));
        library.set_favorite("key-uuid-1-1", false).await.unwrap();
        let (rows, _) = library.list_works_filtered(50, None, true).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].work_key, "key-uuid-2-1");
    }

    #[tokio::test]
    async fn deletion_plan_keeps_shared_packages_and_removes_last_work_row() {
        let (library, _dir) = temp_library("delete-plan").await;
        library.install(&work(&hash(1), "uuid-a", 1)).await.unwrap();
        library.install(&work(&hash(2), "uuid-a", 2)).await.unwrap();
        let key = "key-uuid-a-1";
        let plan = library.plan_deletion(key, Some(1)).await.unwrap();
        assert_eq!(plan.versions.len(), 1);
        assert!(!plan.delete_work, "删除旧版本不能删除仍存在新版本的作品");
        assert_eq!(plan.package_hashes, vec![hash(1)]);
        library.delete_rows(&plan).await.unwrap();
        assert!(library.get_work(key).await.unwrap().is_some());
        let versions = library.versions(key).await.unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].package_hash, hash(2));
        let packages: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM packages")
            .fetch_one(library.pool())
            .await
            .unwrap();
        assert_eq!(packages, 1, "只删除不再被任何版本引用的包行");

        let plan = library.plan_deletion(key, Some(2)).await.unwrap();
        assert!(plan.delete_work, "最后一个版本删除时清理作品行");
        library.delete_rows(&plan).await.unwrap();
        assert!(library.get_work(key).await.unwrap().is_none());
        let packages: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM packages")
            .fetch_one(library.pool())
            .await
            .unwrap();
        assert_eq!(packages, 0);
    }

    #[tokio::test]
    async fn deletion_plan_preserves_package_shared_with_another_work() {
        let (library, _dir) = temp_library("delete-shared").await;
        library.install(&work(&hash(7), "uuid-a", 1)).await.unwrap();
        let mut other = work(&hash(7), "uuid-b", 1);
        other.title = "共享包".into();
        library.install(&other).await.unwrap();
        let plan = library.plan_deletion("key-uuid-a-1", None).await.unwrap();
        assert!(plan.delete_work);
        assert!(
            plan.package_hashes.is_empty(),
            "另一个作品仍引用同一包时不能删除包目录"
        );
        library.delete_rows(&plan).await.unwrap();
        assert!(library.get_work("key-uuid-a-1").await.unwrap().is_none());
        assert!(library.get_work("key-uuid-b-1").await.unwrap().is_some());
        let packages: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM packages")
            .fetch_one(library.pool())
            .await
            .unwrap();
        assert_eq!(packages, 1);
    }

    #[tokio::test]
    async fn deletion_plan_rejects_missing_work_and_version() {
        let (library, _dir) = temp_library("delete-missing").await;
        library.install(&work(&hash(1), "uuid-a", 1)).await.unwrap();
        assert_eq!(
            library
                .plan_deletion("missing", None)
                .await
                .unwrap_err()
                .code,
            "work_not_found"
        );
        assert_eq!(
            library
                .plan_deletion("key-uuid-a-1", Some(9))
                .await
                .unwrap_err()
                .code,
            "version_not_found"
        );
    }

    #[tokio::test]
    async fn cursor_pagination_walks_all_works() {
        let (library, _dir) = temp_library("cursor").await;
        for index in 0..7u32 {
            library
                .install(&work(&hash(index as u8 + 1), &format!("uuid-{index}"), 1))
                .await
                .unwrap();
        }
        let mut seen = Vec::new();
        let mut cursor = None;
        loop {
            let (rows, next) = library.list_works(3, cursor.as_deref()).await.unwrap();
            assert!(rows.len() <= 3);
            seen.extend(rows.iter().map(|row| row.remote_work_id.clone().unwrap()));
            match next {
                Some(next_cursor) => cursor = Some(next_cursor),
                None => break,
            }
        }
        assert_eq!(seen.len(), 7);
        assert_eq!(
            seen.iter().collect::<std::collections::BTreeSet<_>>().len(),
            7
        );
    }
}

/// 测试专用临时目录：避免引入 tempfile 依赖，直接用系统临时目录 + 进程 id。
#[cfg(test)]
pub(crate) mod tempfileish {
    use std::path::PathBuf;

    pub struct TempDir(pub PathBuf);

    impl TempDir {
        pub fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    pub fn temp_dir(tag: &str) -> TempDir {
        let dir = std::env::temp_dir().join(format!(
            "hertz-wallpaper-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.subsec_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }
}
