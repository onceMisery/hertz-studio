// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Lyric emotion persistence (P2b).
//!
//! Model cues are a bounded LRU; eviction is allowed because losing a cue only
//! costs a future classification. Manual overrides are user edits: when their
//! separate budget is exceeded the write is rejected instead of silently
//! deleting someone else's edits.

use sqlx::SqlitePool;
use vmusic_core::StoreError;

use crate::now_ms;

#[derive(Debug, Clone)]
pub struct CueRecord {
    pub doc_json: String,
}

#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize, serde::Deserialize)]
pub struct EmotionLockRow {
    #[sqlx(rename = "line_from")]
    pub from: i64,
    #[sqlx(rename = "line_to")]
    pub to: i64,
    pub emotion: String,
    pub intensity: f64,
    pub confidence: f64,
}

fn database(error: sqlx::Error) -> StoreError {
    StoreError::Database(error.to_string())
}

pub async fn get_cue(pool: &SqlitePool, key: &str) -> Result<Option<CueRecord>, StoreError> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT doc_json FROM lyric_emotion_cues WHERE cache_key = ?1")
            .bind(key)
            .fetch_optional(pool)
            .await
            .map_err(database)?;
    if row.is_some() {
        // Touch the LRU position; a failed touch only affects future eviction.
        let _ = sqlx::query("UPDATE lyric_emotion_cues SET updated_at = ?2 WHERE cache_key = ?1")
            .bind(key)
            .bind(now_ms())
            .execute(pool)
            .await;
    }
    Ok(row.map(|(doc_json,)| CueRecord { doc_json }))
}

/// Insert or replace one cue and evict the oldest entries until the byte bound
/// holds. A single oversized document is rejected up front.
pub async fn put_cue(
    pool: &SqlitePool,
    key: &str,
    lyrics_hash: &str,
    doc_json: &str,
    max_bytes: i64,
) -> Result<(), StoreError> {
    let bytes = i64::try_from(doc_json.len())
        .map_err(|_| StoreError::Database("emotion_cue_too_large".into()))?;
    if max_bytes <= 0 || bytes > max_bytes {
        return Err(StoreError::Database("emotion_cue_too_large".into()));
    }
    let now = now_ms();
    let mut tx = pool.begin().await.map_err(database)?;
    sqlx::query(
        "INSERT INTO lyric_emotion_cues
           (cache_key, lyrics_hash, doc_json, byte_size, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(cache_key) DO UPDATE SET
           lyrics_hash = excluded.lyrics_hash,
           doc_json = excluded.doc_json,
           byte_size = excluded.byte_size,
           updated_at = excluded.updated_at",
    )
    .bind(key)
    .bind(lyrics_hash)
    .bind(doc_json)
    .bind(bytes)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(database)?;

    loop {
        let total: i64 =
            sqlx::query_scalar("SELECT COALESCE(SUM(byte_size), 0) FROM lyric_emotion_cues")
                .fetch_one(&mut *tx)
                .await
                .map_err(database)?;
        if total <= max_bytes {
            break;
        }
        let oldest: Option<String> = sqlx::query_scalar(
            "SELECT cache_key FROM lyric_emotion_cues
             WHERE cache_key <> ?1 ORDER BY updated_at, cache_key LIMIT 1",
        )
        .bind(key)
        .fetch_optional(&mut *tx)
        .await
        .map_err(database)?;
        let Some(oldest) = oldest else {
            return Err(StoreError::Database("emotion_cue_too_large".into()));
        };
        sqlx::query("DELETE FROM lyric_emotion_cues WHERE cache_key = ?1")
            .bind(oldest)
            .execute(&mut *tx)
            .await
            .map_err(database)?;
    }
    tx.commit().await.map_err(database)
}

pub async fn delete_cue(pool: &SqlitePool, key: &str) -> Result<(), StoreError> {
    sqlx::query("DELETE FROM lyric_emotion_cues WHERE cache_key = ?1")
        .bind(key)
        .execute(pool)
        .await
        .map_err(database)?;
    Ok(())
}

pub async fn list_locks(
    pool: &SqlitePool,
    lyrics_hash: &str,
) -> Result<Vec<EmotionLockRow>, StoreError> {
    sqlx::query_as(
        "SELECT line_from, line_to, emotion, intensity, confidence
         FROM lyric_emotion_locks WHERE lyrics_hash = ?1
         ORDER BY line_from, line_to",
    )
    .bind(lyrics_hash)
    .fetch_all(pool)
    .await
    .map_err(database)
}

/// Replace every lock for one lyrics hash. The whole manual-override store has
/// its own byte budget, independent from the model cue LRU.
pub async fn replace_locks(
    pool: &SqlitePool,
    lyrics_hash: &str,
    locks: &[EmotionLockRow],
    max_bytes: i64,
) -> Result<(), StoreError> {
    let mut encoded = Vec::with_capacity(locks.len());
    let mut bytes = 0i64;
    for lock in locks {
        let row =
            serde_json::to_vec(lock).map_err(|error| StoreError::Database(error.to_string()))?;
        bytes = bytes
            .checked_add(i64::try_from(row.len()).unwrap_or(i64::MAX))
            .ok_or_else(|| StoreError::Database("emotion_locks_too_large".into()))?;
        encoded.push(row);
    }
    if max_bytes <= 0 || bytes > max_bytes {
        return Err(StoreError::Database("emotion_locks_too_large".into()));
    }

    let now = now_ms();
    let mut tx = pool.begin().await.map_err(database)?;
    let other: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(byte_size), 0) FROM lyric_emotion_locks WHERE lyrics_hash <> ?1",
    )
    .bind(lyrics_hash)
    .fetch_one(&mut *tx)
    .await
    .map_err(database)?;
    if other.saturating_add(bytes) > max_bytes {
        return Err(StoreError::Database(
            "emotion_locks_capacity_exceeded".into(),
        ));
    }
    sqlx::query("DELETE FROM lyric_emotion_locks WHERE lyrics_hash = ?1")
        .bind(lyrics_hash)
        .execute(&mut *tx)
        .await
        .map_err(database)?;
    for (lock, row) in locks.iter().zip(encoded) {
        sqlx::query(
            "INSERT INTO lyric_emotion_locks
               (lyrics_hash, line_from, line_to, emotion, intensity, confidence, byte_size, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )
        .bind(lyrics_hash)
        .bind(lock.from)
        .bind(lock.to)
        .bind(&lock.emotion)
        .bind(lock.intensity)
        .bind(lock.confidence)
        .bind(i64::try_from(row.len()).unwrap_or(i64::MAX))
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(database)?;
    }
    tx.commit().await.map_err(database)
}

pub async fn clear_locks(pool: &SqlitePool, lyrics_hash: &str) -> Result<(), StoreError> {
    sqlx::query("DELETE FROM lyric_emotion_locks WHERE lyrics_hash = ?1")
        .bind(lyrics_hash)
        .execute(pool)
        .await
        .map_err(database)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../../../migrations/0021_lyric_emotion.sql"))
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    fn lock(from: i64, to: i64, emotion: &str) -> super::EmotionLockRow {
        super::EmotionLockRow {
            from,
            to,
            emotion: emotion.into(),
            intensity: 0.8,
            confidence: 1.0,
        }
    }

    #[tokio::test]
    async fn cue_upsert_evicts_oldest_and_rejects_oversized() {
        let db = pool().await;
        super::put_cue(&db, "a", "h1", "aaaa", 10).await.unwrap();
        super::put_cue(&db, "b", "h2", "bbbbbb", 10).await.unwrap();
        super::put_cue(&db, "a", "h1", "aa", 10).await.unwrap();
        super::put_cue(&db, "c", "h3", "cccccc", 10).await.unwrap();
        assert!(super::get_cue(&db, "a").await.unwrap().is_some());
        assert!(super::get_cue(&db, "b").await.unwrap().is_none());
        assert!(super::get_cue(&db, "c").await.unwrap().is_some());
        assert!(super::put_cue(&db, "d", "h4", "12345678901", 10)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn locks_are_scoped_by_hash_and_reject_global_overflow() {
        let db = pool().await;
        super::replace_locks(&db, "h1", &[lock(0, 1, "joy")], 1_000)
            .await
            .unwrap();
        super::replace_locks(&db, "h2", &[lock(5, 5, "sorrow")], 1_000)
            .await
            .unwrap();
        assert_eq!(super::list_locks(&db, "h1").await.unwrap().len(), 1);
        assert_eq!(super::list_locks(&db, "h2").await.unwrap()[0].from, 5);
        super::replace_locks(&db, "h1", &[lock(2, 3, "anger")], 1_000)
            .await
            .unwrap();
        let rows = super::list_locks(&db, "h1").await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].to, 3);
        assert!(super::replace_locks(&db, "h3", &[lock(0, 0, "joy")], 1)
            .await
            .is_err());
        super::clear_locks(&db, "h2").await.unwrap();
        assert!(super::list_locks(&db, "h2").await.unwrap().is_empty());
    }
}
