// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 用户元数据覆盖层：标签编辑与封面替换。
//!
//! 覆盖层按曲目一行存储，字段为 `Option`：只有用户真正改过的字段才有值，
//! 未改的字段保持 NULL，读取端 COALESCE 回扫描值。批量编辑只写传入的字段，
//! 绝不把未提供的字段清成空。读取端会把纯空白的覆盖值归一成「没改过」——
//! 也就是回退到扫描值；要把字段恢复成文件标签，直接删除覆盖行。

use sqlx::SqlitePool;
use vmusic_core::StoreError;

use crate::now_ms;

type OverlayRow = (Option<String>, Option<String>, Option<String>, i64);

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct TrackEdit {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub cover_edited: bool,
}

/// 一次编辑要落库的字段；`None` 表示「不动这个字段」。
#[derive(Debug, Clone, Default)]
pub struct EditInput {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
}

pub async fn get(pool: &SqlitePool, track_id: &str) -> Result<Option<TrackEdit>, StoreError> {
    let row: Option<OverlayRow> = sqlx::query_as(
        "SELECT title, artist, album, cover_edited FROM track_edits WHERE track_id = ?1",
    )
    .bind(track_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(row.map(|(title, artist, album, cover_edited)| TrackEdit {
        title,
        artist,
        album,
        cover_edited: cover_edited != 0,
    }))
}

/// 列名只来自本文件的常量调用点，不存在注入面；值全部走绑定参数。
/// `executor` 泛型承载单连接与事务两种调用形态。
async fn upsert_field<'a, E>(
    executor: E,
    track_id: &str,
    column: &str,
    value: Option<&str>,
) -> Result<(), StoreError>
where
    E: sqlx::Executor<'a, Database = sqlx::Sqlite>,
{
    let sql = format!(
        "INSERT INTO track_edits (track_id, {column}, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(track_id) DO UPDATE SET {column} = excluded.{column}, updated_at = excluded.updated_at"
    );
    sqlx::query(&sql)
        .bind(track_id)
        .bind(value)
        .bind(now_ms())
        .execute(executor)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

/// 应用一次编辑：只写 `input` 里出现的字段。
pub async fn apply(pool: &SqlitePool, track_id: &str, input: &EditInput) -> Result<(), StoreError> {
    if input.title.is_none() && input.artist.is_none() && input.album.is_none() {
        return Ok(());
    }
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    for (column, value) in [
        ("title", input.title.as_deref()),
        ("artist", input.artist.as_deref()),
        ("album", input.album.as_deref()),
    ] {
        if let Some(value) = value {
            upsert_field(&mut *tx, track_id, column, Some(value)).await?;
        }
    }
    tx.commit()
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

/// 批量编辑：同一组字段应用到多条曲目。
pub async fn apply_batch(
    pool: &SqlitePool,
    track_ids: &[String],
    input: &EditInput,
) -> Result<u64, StoreError> {
    let mut changed = 0u64;
    for id in track_ids {
        apply(pool, id, input).await?;
        changed += 1;
    }
    Ok(changed)
}

/// 封面替换标记：增量扫描据此跳过内嵌封面的重新落盘。
pub async fn set_cover_edited(
    pool: &SqlitePool,
    track_id: &str,
    edited: bool,
) -> Result<(), StoreError> {
    let sql = "INSERT INTO track_edits (track_id, cover_edited, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(track_id) DO UPDATE SET cover_edited = excluded.cover_edited, updated_at = excluded.updated_at";
    sqlx::query(sql)
        .bind(track_id)
        .bind(edited as i64)
        .bind(now_ms())
        .execute(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

pub async fn is_cover_edited(pool: &SqlitePool, track_id: &str) -> Result<bool, StoreError> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT cover_edited FROM track_edits WHERE track_id = ?1")
            .bind(track_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(row.map(|(v,)| v != 0).unwrap_or(false))
}

/// 重置编辑：删掉覆盖行，曲目回到文件标签与扫描封面语义。
pub async fn remove(pool: &SqlitePool, track_id: &str) -> Result<bool, StoreError> {
    let result = sqlx::query("DELETE FROM track_edits WHERE track_id = ?1")
        .bind(track_id)
        .execute(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(result.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{get_track, upsert_track};
    use vmusic_core::{Track, TrackSource};

    async fn pool() -> SqlitePool {
        let dir = std::env::temp_dir().join(format!("vmusic-edit-test-{}", uuid::Uuid::new_v4()));
        crate::open(&dir).await.expect("open db")
    }

    fn track(id: &str, title: &str, artist: Option<&str>) -> Track {
        Track {
            id: id.into(),
            path: format!("/m/{id}.mp3"),
            source: TrackSource::Local,
            title: title.into(),
            artist: artist.map(Into::into),
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
    async fn apply_only_writes_provided_fields_and_overlay_wins_in_reads() {
        let db = pool().await;
        upsert_track(&db, &track("t1", "扫描名", Some("扫描歌手")))
            .await
            .unwrap();

        // 只改专辑：title/artist 覆盖行保持 NULL，读取端回到扫描值。
        apply(
            &db,
            "t1",
            &EditInput {
                album: Some("我的专辑".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let edit = get(&db, "t1").await.unwrap().unwrap();
        assert_eq!(edit.album.as_deref(), Some("我的专辑"));
        assert!(edit.title.is_none() && edit.artist.is_none());

        let read = get_track(&db, &"t1".to_string()).await.unwrap().unwrap();
        assert_eq!(read.title, "扫描名");
        assert_eq!(read.artist.as_deref(), Some("扫描歌手"));
        assert_eq!(read.album.as_deref(), Some("我的专辑"));

        // 再改歌手为空白：读取端归一成「没改过」，回退扫描值；专辑不动。
        apply(
            &db,
            "t1",
            &EditInput {
                artist: Some("  ".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let read = get_track(&db, &"t1".to_string()).await.unwrap().unwrap();
        assert_eq!(
            read.artist.as_deref(),
            Some("扫描歌手"),
            "空白覆盖归一为没改过，回退扫描值"
        );
        assert_eq!(read.album.as_deref(), Some("我的专辑"));
        db.close().await;
    }

    #[tokio::test]
    async fn rescan_does_not_wipe_user_edits() {
        let db = pool().await;
        upsert_track(&db, &track("t2", "旧名", Some("旧歌手")))
            .await
            .unwrap();
        apply(
            &db,
            "t2",
            &EditInput {
                title: Some("用户名".into()),
                artist: Some("用户歌手".into()),
                album: None,
            },
        )
        .await
        .unwrap();
        // 重扫：同一 id 重新写入文件标签。
        upsert_track(&db, &track("t2", "文件新名", Some("文件歌手")))
            .await
            .unwrap();
        let read = get_track(&db, &"t2".to_string()).await.unwrap().unwrap();
        assert_eq!(read.title, "用户名", "重扫后用户编辑必须保留");
        assert_eq!(read.artist.as_deref(), Some("用户歌手"));
        // 重置编辑回到文件标签。
        assert!(remove(&db, "t2").await.unwrap());
        let read = get_track(&db, &"t2".to_string()).await.unwrap().unwrap();
        assert_eq!(read.title, "文件新名");
        db.close().await;
    }

    #[tokio::test]
    async fn cover_edit_flag_round_trips_and_batch_edits_many() {
        let db = pool().await;
        upsert_track(&db, &track("a", "A", None)).await.unwrap();
        upsert_track(&db, &track("b", "B", None)).await.unwrap();
        assert!(!is_cover_edited(&db, "a").await.unwrap());
        set_cover_edited(&db, "a", true).await.unwrap();
        assert!(is_cover_edited(&db, "a").await.unwrap());

        apply_batch(
            &db,
            &["a".into(), "b".into()],
            &EditInput {
                artist: Some("合辑歌手".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        for id in ["a", "b"] {
            let read = get_track(&db, &id.to_string()).await.unwrap().unwrap();
            assert_eq!(read.artist.as_deref(), Some("合辑歌手"));
        }
        db.close().await;
    }
}
