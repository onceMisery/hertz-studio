// SPDX-License-Identifier: MIT
use super::error;
use crate::{
    root_owner::RootOwner,
    wallpaper::{budget, jobs::JobError},
    wallpaper_upgrade::AdmittedPool,
};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use std::{io::Read, path::Path, time::Duration};

const APPLICATION_ID: u32 = 0x48575431; // HWT1, independent of wallpaper.db
const SCHEMA: u32 = 1;

pub(super) async fn open(root: &Path) -> Result<AdmittedPool, JobError> {
    let fee = crate::wallpaper_upgrade::sqlx_pool_requested_bytes(1)
        .ok_or_else(|| error("budget_busy", "trust SQLite 费用溢出"))?;
    let charge = budget::global()
        .admit_sqlx_pool(fee)
        .map_err(|e| error("budget_busy", e.message.to_string()))?;
    let reader = RootOwner::shared(root).map_err(|e| error("trust_root", e.to_string()))?;
    let _commit = crate::config_journal::FileLock::acquire(reader.root())
        .map_err(|e| error("trust_lock", e.to_string()))?;
    let path = reader.root().join("trust.db");
    let mut sidecars = false;
    for name in ["trust.db-wal", "trust.db-shm", "trust.db-journal"] {
        match std::fs::symlink_metadata(reader.root().join(name)) {
            Ok(meta) => {
                crate::root_owner::ordinary(&meta)
                    .map_err(|_| error("trust_database_invalid", "安全库附属文件不能重定向"))?;
                if !meta.is_file() {
                    return Err(error(
                        "trust_database_invalid",
                        "安全库附属路径必须是普通文件",
                    ));
                }
                sidecars = true;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(JobError::io(e.to_string())),
        }
    }
    let fresh = match std::fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if sidecars {
                return Err(error(
                    "trust_database_invalid",
                    "安全库主文件缺失，不能复用遗留日志新建信任",
                ));
            }
            true
        }
        Err(e) => return Err(JobError::io(e.to_string())),
        Ok(meta) => {
            use std::os::windows::fs::MetadataExt;
            if !meta.is_file() || meta.file_attributes() & 0x400 != 0 {
                return Err(error("trust_database_invalid", "安全库必须是普通文件"));
            }
            let mut file = std::fs::File::open(&path).map_err(|e| JobError::io(e.to_string()))?;
            let mut header = [0u8; 100];
            file.read_exact(&mut header)
                .map_err(|_| error("trust_database_invalid", "安全库头部不完整"))?;
            if &header[..16] != b"SQLite format 3\0" {
                return Err(error("trust_database_invalid", "安全库文件头无效"));
            }
            false
        }
    };
    if !fresh {
        // Read SQLite's committed view, including a valid WAL. Creation metadata
        // need not have reached the main file when the previous process stopped.
        let inspection_charge = budget::global()
            .admit_sqlx_pool(fee)
            .map_err(|e| error("budget_busy", e.message.to_string()))?;
        let inspection_owner = reader.clone();
        let inspection = SqlitePoolOptions::new()
            .max_connections(1)
            .after_connect(move |_, _| {
                let guard = inspection_owner.clone();
                Box::pin(async move {
                    drop(guard);
                    Ok(())
                })
            })
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .read_only(true)
                    .create_if_missing(false)
                    .busy_timeout(Duration::from_secs(5))
                    .statement_cache_capacity(4)
                    .pragma("cache_size", "-2048")
                    .pragma("temp_store", "FILE"),
            )
            .await
            .map_err(|e| JobError::database(e.to_string()))?;
        let inspection = AdmittedPool::for_database(
            inspection,
            reader.root().to_path_buf(),
            "trust.db",
            inspection_charge,
        );
        let identity = async {
            let mut tx = inspection
                .begin()
                .await
                .map_err(|e| JobError::database(e.to_string()))?;
            let app: i64 = sqlx::query_scalar("PRAGMA application_id")
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| JobError::database(e.to_string()))?;
            let version: i64 = sqlx::query_scalar("PRAGMA user_version")
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| JobError::database(e.to_string()))?;
            if app != i64::from(APPLICATION_ID) || version != i64::from(SCHEMA) {
                return Err(error(
                    "trust_schema_unsupported",
                    "安全库身份或版本不受支持，不能从作品库备份替换",
                ));
            }
            tx.rollback()
                .await
                .map_err(|e| JobError::database(e.to_string()))?;
            Ok(())
        }
        .await;
        inspection
            .close_before_reopen()
            .await
            .map_err(|e| error("trust_database_close", e.to_string()))?;
        identity?;
    }
    let admission = reader.clone();
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(fresh)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .busy_timeout(Duration::from_secs(5))
        .statement_cache_capacity(32)
        .pragma("cache_size", "-2048")
        .pragma("temp_store", "FILE");
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .after_connect(move |_, _| {
            let guard = admission.clone();
            Box::pin(async move {
                drop(guard);
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .map_err(|e| JobError::database(e.to_string()))?;
    let admitted =
        AdmittedPool::for_database(pool, reader.root().to_path_buf(), "trust.db", charge);
    if fresh {
        let mut tx = admitted
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|e| JobError::database(e.to_string()))?;
        sqlx::raw_sql(include_str!("../../../migrations/trust/0001_trust.sql"))
            .execute(&mut *tx)
            .await
            .map_err(|e| JobError::database(e.to_string()))?;
        sqlx::query("PRAGMA application_id=1213682737")
            .execute(&mut *tx)
            .await
            .map_err(|e| JobError::database(e.to_string()))?;
        sqlx::query("PRAGMA user_version=1")
            .execute(&mut *tx)
            .await
            .map_err(|e| JobError::database(e.to_string()))?;
        tx.commit()
            .await
            .map_err(|e| JobError::database(e.to_string()))?;
    } else {
        // This version has exactly one schema; future migrations require an
        // explicit security migration, never the library rollback mechanism.
        let _: i64 = sqlx::query_scalar("SELECT count(*) FROM trust_sources")
            .fetch_one(&*admitted)
            .await
            .map_err(|e| JobError::database(e.to_string()))?;
    }
    Ok(admitted)
}
