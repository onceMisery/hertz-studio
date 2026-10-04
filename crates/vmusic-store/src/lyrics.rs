// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 手动导入的歌词与每曲偏移。
//!
//! 一行 = 一首本地曲目：`content` 是导入的 LRC 原文（空串表示未导入），
//! `offset_ms` 是用户偏移，两者独立写入。导入的原文按原样保存——解析和
//! 偏移应用都发生在读取端，写入端不对内容做任何有损加工。

use sqlx::SqlitePool;
use vmusic_core::StoreError;

use crate::now_ms;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackLyrics {
    pub content: String,
    pub offset_ms: i64,
}

pub async fn get(pool: &SqlitePool, track_id: &str) -> Result<Option<TrackLyrics>, StoreError> {
    let row: Option<(String, i64)> =
        sqlx::query_as("SELECT content, offset_ms FROM track_lyrics WHERE track_id = ?1")
            .bind(track_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(row.map(|(content, offset_ms)| TrackLyrics { content, offset_ms }))
}

/// 写入手动导入的 LRC 原文；偏移保持原值（无行则 0）。
pub async fn import(pool: &SqlitePool, track_id: &str, content: &str) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT INTO track_lyrics (track_id, content, offset_ms, updated_at) VALUES (?1, ?2, 0, ?3)
         ON CONFLICT(track_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
    )
    .bind(track_id)
    .bind(content)
    .bind(now_ms())
    .execute(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

/// 写入每曲偏移；导入内容保持原值（无行则空串）。
pub async fn set_offset(
    pool: &SqlitePool,
    track_id: &str,
    offset_ms: i64,
) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT INTO track_lyrics (track_id, content, offset_ms, updated_at) VALUES (?1, '', ?2, ?3)
         ON CONFLICT(track_id) DO UPDATE SET offset_ms = excluded.offset_ms, updated_at = excluded.updated_at",
    )
    .bind(track_id)
    .bind(offset_ms)
    .bind(now_ms())
    .execute(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

/// 删除覆盖行（导入内容与偏移一并清除），读取端回退到内嵌/sidecar。
pub async fn remove(pool: &SqlitePool, track_id: &str) -> Result<bool, StoreError> {
    let result = sqlx::query("DELETE FROM track_lyrics WHERE track_id = ?1")
        .bind(track_id)
        .execute(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(result.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> SqlitePool {
        let dir = std::env::temp_dir().join(format!("vmusic-lyr-test-{}", uuid::Uuid::new_v4()));
        crate::open(&dir).await.expect("open db")
    }

    #[tokio::test]
    async fn import_and_offset_are_independent() {
        let db = pool().await;
        // 只调偏移：没有导入内容也建行。
        set_offset(&db, "t1", -500).await.unwrap();
        let row = get(&db, "t1").await.unwrap().unwrap();
        assert_eq!(row.content, "");
        assert_eq!(row.offset_ms, -500);

        // 导入不改偏移。
        import(&db, "t1", "[00:01.00]x").await.unwrap();
        let row = get(&db, "t1").await.unwrap().unwrap();
        assert_eq!(row.content, "[00:01.00]x");
        assert_eq!(row.offset_ms, -500);

        // 再调偏移不改导入内容。
        set_offset(&db, "t1", 250).await.unwrap();
        let row = get(&db, "t1").await.unwrap().unwrap();
        assert_eq!(row.content, "[00:01.00]x");
        assert_eq!(row.offset_ms, 250);
        db.close().await;
    }

    #[tokio::test]
    async fn remove_drops_the_whole_override_row() {
        let db = pool().await;
        import(&db, "t2", "[00:01.00]x").await.unwrap();
        set_offset(&db, "t2", 100).await.unwrap();
        assert!(remove(&db, "t2").await.unwrap());
        assert!(get(&db, "t2").await.unwrap().is_none());
        assert!(!remove(&db, "t2").await.unwrap(), "重复删除返回 false");
        db.close().await;
    }

    #[tokio::test]
    async fn rows_survive_reopen() {
        let dir = std::env::temp_dir().join(format!("vmusic-lyr-reopen-{}", uuid::Uuid::new_v4()));
        let db = crate::open(&dir).await.unwrap();
        import(&db, "t3", "[00:02.00]y").await.unwrap();
        set_offset(&db, "t3", -1200).await.unwrap();
        db.close().await;
        let db = crate::open(&dir).await.unwrap();
        let row = get(&db, "t3").await.unwrap().unwrap();
        assert_eq!(row.content, "[00:02.00]y");
        assert_eq!(row.offset_ms, -1200);
        db.close().await;
        crate::cleanup_dir(&dir);
    }
}
