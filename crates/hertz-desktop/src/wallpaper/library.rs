// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 壁纸库（wallpaper.db）内核：P1 子集（设计 docs/desktop-wallpaper.md §4.2、§7.2）。
//!
//! 库只由桌面宿主写：WAL、外键开启、`BEGIN IMMEDIATE` 短事务（与 vmusic-store
//! 同一约定）。查询为 runtime-checked（sqlx::query_as），不带 `.sqlx` 元数据。
//! 安装事务固定顺序：packages（原包不可变）→ works（(source,remote) 幂等映射）
//! → versions（同 work+version 幂等 / 同版本异 hash 拒绝）。

use std::path::{Path, PathBuf};

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{FromRow, SqlitePool};

use crate::wallpaper::jobs::JobError;

/// 模块内 Result 别名：错误固定为 JobError（遮蔽 prelude 双参 Result）。
type Result<T> = std::result::Result<T, JobError>;

/// 本机作品的固定来源 id（§4.2：本机新作品属于固定 local 来源）。
pub const LOCAL_SOURCE: &str = "local";

#[derive(Debug, Clone, FromRow)]
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

pub struct Library {
    pool: SqlitePool,
    #[allow(dead_code)]
    path: PathBuf,
}

impl Library {
    /// 打开（或创建）wallpaper.db 并执行独立迁移。
    pub async fn open(dir: &Path) -> Result<Self> {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|error| JobError::io(format!("创建壁纸库目录失败：{error}")))?;
        let path = dir.join("wallpaper.db");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true)
            .busy_timeout(std::time::Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(options)
            .await
            .map_err(|error| JobError::database(error.to_string()))?;
        sqlx::migrate!("migrations/wallpaper")
            .run(&pool)
            .await
            .map_err(|error| JobError::database(format!("壁纸库迁移失败：{error}")))?;
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

    /// 包是否已索引（崩溃恢复与重复导入的判据）。
    pub async fn is_installed(&self, package_hash: &str) -> Result<bool> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM packages WHERE package_hash = ?1")
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

    /// 作品分页（cursor = 上一页末尾的 created_at|work_key；单页 ≤50，§14.2）。
    pub async fn list_works(
        &self,
        limit: u32,
        cursor: Option<&str>,
    ) -> Result<(Vec<WorkRow>, Option<String>)> {
        let limit = limit.clamp(1, 50) as i64;
        let rows: Vec<WorkRow> = match cursor {
            None => sqlx::query_as(
                "SELECT * FROM works ORDER BY created_at DESC, work_key DESC LIMIT ?1",
            )
            .bind(limit + 1)
            .fetch_all(&self.pool)
            .await
            .map_err(|error| JobError::database(error.to_string()))?,
            Some(cursor) => {
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
        assert_eq!(seen.iter().collect::<std::collections::BTreeSet<_>>().len(), 7);
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
