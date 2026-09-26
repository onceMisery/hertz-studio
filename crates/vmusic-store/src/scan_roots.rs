// SPDX-License-Identifier: MIT
//! Saved library roots. Removing a root never removes tracks or source files.

use serde::Serialize;
use sqlx::{FromRow, SqlitePool};
use vmusic_core::StoreError;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct ScanRoot {
    pub path: String,
    pub enabled: bool,
    pub last_scanned_at: Option<i64>,
    pub last_error: Option<String>,
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<ScanRoot>, StoreError> {
    sqlx::query_as(
        "SELECT path, enabled, last_scanned_at, last_error FROM scan_roots ORDER BY path",
    )
    .fetch_all(pool)
    .await
    .map_err(db_error)
}

pub async fn upsert(pool: &SqlitePool, path: &str, enabled: bool) -> Result<(), StoreError> {
    sqlx::query("INSERT INTO scan_roots(path, enabled) VALUES (?1, ?2) ON CONFLICT(path) DO UPDATE SET enabled = excluded.enabled")
        .bind(path).bind(enabled).execute(pool).await.map_err(db_error)?;
    Ok(())
}

pub async fn set_enabled(pool: &SqlitePool, path: &str, enabled: bool) -> Result<(), StoreError> {
    sqlx::query("UPDATE scan_roots SET enabled = ?2 WHERE path = ?1")
        .bind(path)
        .bind(enabled)
        .execute(pool)
        .await
        .map_err(db_error)?;
    Ok(())
}

pub async fn remove(pool: &SqlitePool, path: &str) -> Result<(), StoreError> {
    sqlx::query("DELETE FROM scan_roots WHERE path = ?1")
        .bind(path)
        .execute(pool)
        .await
        .map_err(db_error)?;
    Ok(())
}

/// Update only existing roots: an in-flight scan must not recreate a removed root.
pub async fn record_result(
    pool: &SqlitePool,
    path: &str,
    completed: bool,
    error: Option<&str>,
) -> Result<(), StoreError> {
    sqlx::query("UPDATE scan_roots SET last_scanned_at = CASE WHEN ?2 THEN ?3 ELSE last_scanned_at END, last_error = ?4 WHERE path = ?1")
        .bind(path).bind(completed).bind(crate::now_ms()).bind(error)
        .execute(pool).await.map_err(db_error)?;
    Ok(())
}

fn db_error(error: sqlx::Error) -> StoreError {
    StoreError::Database(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn saved_roots_survive_reopen_and_late_result_does_not_recreate_removed_root() {
        let dir = std::env::temp_dir().join(format!("scan-roots-{}", uuid::Uuid::new_v4()));
        let db = crate::open(&dir).await.unwrap();
        upsert(&db, "/Music", true).await.unwrap();
        record_result(&db, "/Music", true, None).await.unwrap();
        record_result(&db, "/Music", false, Some("permission denied"))
            .await
            .unwrap();
        set_enabled(&db, "/Music", false).await.unwrap();
        db.close().await;
        let db = crate::open(&dir).await.unwrap();
        let roots = list(&db).await.unwrap();
        assert_eq!(roots.len(), 1);
        assert!(!roots[0].enabled);
        assert!(roots[0].last_scanned_at.is_some());
        assert_eq!(roots[0].last_error.as_deref(), Some("permission denied"));
        upsert(&db, "/Music", true).await.unwrap();
        assert!(list(&db).await.unwrap()[0].enabled);
        remove(&db, "/Music").await.unwrap();
        record_result(&db, "/Music", true, None).await.unwrap();
        assert!(list(&db).await.unwrap().is_empty());
        db.close().await;
        for attempt in 0..20 {
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => break,
                Err(error) if matches!(error.raw_os_error(), Some(32 | 33)) && attempt < 19 => {
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                }
                Err(error) => panic!("fixture cleanup failed: {error}"),
            }
        }
    }
}
