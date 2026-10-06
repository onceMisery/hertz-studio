// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 在线补全的「不匹配」决定（`track_no_auto_match` 表）。
//!
//! 用户明确拒绝过的自动匹配会记在这里：后续补全的候选阶段直接跳过这些曲目，
//! 不给出建议、更不写库。表很小（每行只有一个 id 与时间戳），读写都是按 id
//! 主键命中或批量 IN。

use std::collections::HashSet;

use sqlx::SqlitePool;
use vmusic_core::StoreError;

use crate::now_ms;

/// 记下「这首不要再自动匹配」。重复标记是幂等的（`ON CONFLICT` 保留首次时间）。
pub async fn mark(pool: &SqlitePool, track_id: &str) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT INTO track_no_auto_match (track_id, created_at) VALUES (?1, ?2)
         ON CONFLICT(track_id) DO NOTHING",
    )
    .bind(track_id)
    .bind(now_ms())
    .execute(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

/// 撤销「不匹配」：用户后来又接受了某个候选，决定就该跟着改。
pub async fn clear(pool: &SqlitePool, track_id: &str) -> Result<(), StoreError> {
    sqlx::query("DELETE FROM track_no_auto_match WHERE track_id = ?1")
        .bind(track_id)
        .execute(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

/// 一次取出一批曲目里被标记过的那些 id（补全候选阶段按批预取）。
pub async fn marked_ids(
    pool: &SqlitePool,
    ids: &[String],
) -> Result<HashSet<String>, StoreError> {
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    let placeholders = vec!["?"; ids.len()].join(", ");
    let sql = format!("SELECT track_id FROM track_no_auto_match WHERE track_id IN ({placeholders})");
    let mut query = sqlx::query_as::<_, (String,)>(&sql);
    for id in ids {
        query = query.bind(id);
    }
    let rows = query
        .fetch_all(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use vmusic_core::{Track, TrackSource};

    async fn pool() -> SqlitePool {
        let dir = std::env::temp_dir().join(format!("vmusic-nam-test-{}", uuid::Uuid::new_v4()));
        crate::open(&dir).await.expect("open db")
    }

    fn track(id: &str) -> Track {
        Track {
            id: id.into(),
            path: format!("/m/{id}.mp3"),
            source: TrackSource::Local,
            title: id.into(),
            artist: None,
            album: None,
            duration_ms: None,
            bitrate: None,
            sample_rate: None,
            channels: None,
            has_cover: false,
            file_mtime: None,
            file_size: None,
            added_at: 0,
        }
    }

    #[tokio::test]
    async fn mark_is_idempotent_and_batch_reads_are_exact() {
        let db = pool().await;
        for id in ["a", "b"] {
            crate::upsert_track(&db, &track(id)).await.unwrap();
        }
        mark(&db, "a").await.unwrap();
        mark(&db, "a").await.unwrap(); // 幂等：不该报错、也不该重复
        let marked = marked_ids(&db, &["a".into(), "b".into(), "missing".into()])
            .await
            .unwrap();
        assert_eq!(marked.len(), 1);
        assert!(marked.contains("a"));
        assert!(marked_ids(&db, &[]).await.unwrap().is_empty());
        // 撤销后不再命中。
        clear(&db, "a").await.unwrap();
        assert!(marked_ids(&db, &["a".into()]).await.unwrap().is_empty());
        db.close().await;
    }
}
