// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Custom playlist CRUD. Positions are dense integers maintained on write, so
//! the UI can render a playlist with a single ordered query.

use sqlx::SqlitePool;
use vmusic_core::{Playlist, PlaylistId, StoreError, TrackId};

use crate::now_ms;

/// 在线曲目入单时的元数据快照。
///
/// 本地曲目不写快照（读取端永远以 tracks 表实时字段为准）；在线曲目重启后
/// 无法从本地库解析，读取端回退到这份快照来渲染标题/歌手/封面。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackMeta {
    pub source: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: Option<i64>,
    pub cover: Option<String>,
}

/// 歌单内容行：身份 + 可选快照。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub track_id: TrackId,
    pub meta: Option<TrackMeta>,
}

pub async fn create(pool: &SqlitePool, name: &str) -> Result<Playlist, StoreError> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    sqlx::query("INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)")
        .bind(&id)
        .bind(name)
        .bind(now)
        .execute(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;

    Ok(Playlist {
        id,
        name: name.to_string(),
        created_at: now,
        updated_at: now,
        track_count: 0,
    })
}

pub async fn rename(pool: &SqlitePool, id: &PlaylistId, name: &str) -> Result<(), StoreError> {
    sqlx::query("UPDATE playlists SET name = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(name)
        .bind(now_ms())
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

pub async fn delete(pool: &SqlitePool, id: &PlaylistId) -> Result<(), StoreError> {
    sqlx::query("DELETE FROM playlist_tracks WHERE playlist_id = ?1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    sqlx::query("DELETE FROM playlists WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

/// Appends the given tracks, skipping ids already present.
pub async fn add_tracks(
    pool: &SqlitePool,
    id: &PlaylistId,
    track_ids: &[TrackId],
) -> Result<(), StoreError> {
    let entries: Vec<(TrackId, Option<TrackMeta>)> =
        track_ids.iter().map(|tid| (tid.clone(), None)).collect();
    add_entries(pool, id, &entries).await
}

/// Appends entries (id + optional online snapshot), skipping ids already present.
///
/// 跳过已存在的 id 是既有契约：歌单是集合语义，重复「加入歌单」不产生重复行，
/// 快照也不因重复入单而改写。
pub async fn add_entries(
    pool: &SqlitePool,
    id: &PlaylistId,
    entries: &[(TrackId, Option<TrackMeta>)],
) -> Result<(), StoreError> {
    // 批量入单的载荷同样来自外部（整盘「加入歌单」是前端一次性提交的数组）。
    // 闸门放在任何写入之前：越界的一行都不进库，而不是回滚一个写了一半的歌单。
    crate::limits::check_count(
        "一次入单的曲目数",
        entries.len(),
        crate::limits::MAX_ENTRIES_PER_BATCH,
        "单次批量",
    )?;
    for (track_id, meta) in entries {
        crate::limits::check_len(
            "曲目 id",
            Some(track_id),
            crate::limits::MAX_ID_CHARS,
            "入单条目",
        )?;
        if let Some(m) = meta {
            crate::limits::check_len(
                "曲目来源",
                Some(&m.source),
                crate::limits::MAX_ID_CHARS,
                "入单快照",
            )?;
            crate::limits::check_len(
                "曲目标题",
                Some(&m.title),
                crate::limits::MAX_TEXT_CHARS,
                "入单快照",
            )?;
            crate::limits::check_len(
                "曲目歌手",
                m.artist.as_deref(),
                crate::limits::MAX_TEXT_CHARS,
                "入单快照",
            )?;
            crate::limits::check_len(
                "曲目专辑",
                m.album.as_deref(),
                crate::limits::MAX_TEXT_CHARS,
                "入单快照",
            )?;
            // 快照里的封面只放 URL：整条链路的封面图都在缓存目录，不在数据库。
            crate::limits::check_len(
                "曲目封面",
                m.cover.as_deref(),
                crate::limits::MAX_URL_CHARS,
                "入单快照",
            )?;
        }
    }
    let existing = crate::get_playlist_track_ids(pool, id).await?;
    let mut position = existing.len() as i64;

    for (track_id, meta) in entries {
        if existing.contains(track_id) {
            continue;
        }
        match meta {
            Some(m) => {
                sqlx::query(
                    "INSERT OR IGNORE INTO playlist_tracks
                       (playlist_id, track_id, position, source, title, artist, album, duration_ms, cover)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                )
                .bind(id)
                .bind(track_id)
                .bind(position)
                .bind(&m.source)
                .bind(&m.title)
                .bind(&m.artist)
                .bind(&m.album)
                .bind(m.duration_ms)
                .bind(&m.cover)
                .execute(pool)
                .await
                .map_err(|e| StoreError::Database(e.to_string()))?;
            }
            None => {
                sqlx::query(
                    "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?1, ?2, ?3)",
                )
                .bind(id)
                .bind(track_id)
                .bind(position)
                .execute(pool)
                .await
                .map_err(|e| StoreError::Database(e.to_string()))?;
            }
        }
        position += 1;
    }

    sqlx::query("UPDATE playlists SET updated_at = ?1 WHERE id = ?2")
        .bind(now_ms())
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

/// Reads a playlist's contents in order: ids plus any online snapshot rows.
type SnapshotRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<String>,
);

pub async fn list_entries(pool: &SqlitePool, id: &PlaylistId) -> Result<Vec<Entry>, StoreError> {
    let rows: Vec<SnapshotRow> = sqlx::query_as(
        "SELECT track_id, source, title, artist, album, duration_ms, cover
             FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position",
    )
    .bind(id)
    .fetch_all(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(rows
        .into_iter()
        .map(
            |(track_id, source, title, artist, album, duration_ms, cover)| {
                let meta = match (source, title) {
                    (Some(source), Some(title)) => Some(TrackMeta {
                        source,
                        title,
                        artist,
                        album,
                        duration_ms,
                        cover,
                    }),
                    // 有列没标题的行只可能来自外部改库：按无快照处理，读取端走
                    // 占位渲染，而不是拿半份快照拼出一行假数据。
                    _ => None,
                };
                Entry { track_id, meta }
            },
        )
        .collect())
}

pub async fn remove_track(
    pool: &SqlitePool,
    id: &PlaylistId,
    track_id: &TrackId,
) -> Result<(), StoreError> {
    sqlx::query("DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2")
        .bind(id)
        .bind(track_id)
        .execute(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;

    // Re-pack positions so ordering stays dense.
    let remaining = crate::get_playlist_track_ids(pool, id).await?;
    for (index, tid) in remaining.iter().enumerate() {
        sqlx::query(
            "UPDATE playlist_tracks SET position = ?1 WHERE playlist_id = ?2 AND track_id = ?3",
        )
        .bind(index as i64)
        .bind(id)
        .bind(tid)
        .execute(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    }
    Ok(())
}

/// Replaces the whole track order in one transaction.
///
/// The submitted list must contain exactly the playlist's current membership
/// (same set, any permutation): accepting arbitrary ids here would let the UI
/// silently add or drop tracks through an endpoint whose only job is ordering.
/// All position updates run in one transaction so a failure halfway can't leave
/// gaps or duplicated positions.
pub async fn reorder(
    pool: &SqlitePool,
    id: &PlaylistId,
    track_ids: &[TrackId],
) -> Result<(), StoreError> {
    let existing = crate::get_playlist_track_ids(pool, id).await?;
    if existing.len() != track_ids.len() {
        return Err(StoreError::Database(
            "submitted order does not match playlist contents".to_string(),
        ));
    }
    let mut have = existing.clone();
    have.sort();
    let mut want = track_ids.to_vec();
    want.sort();
    if have != want {
        return Err(StoreError::Database(
            "submitted order does not match playlist contents".to_string(),
        ));
    }

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    for (position, tid) in track_ids.iter().enumerate() {
        sqlx::query(
            "UPDATE playlist_tracks SET position = ?1 WHERE playlist_id = ?2 AND track_id = ?3",
        )
        .bind(position as i64)
        .bind(id)
        .bind(tid)
        .execute(&mut *tx)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    }
    tx.commit()
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> SqlitePool {
        let dir = std::env::temp_dir().join(format!("vmusic-pl-test-{}", uuid::Uuid::new_v4()));
        crate::open(&dir).await.expect("open db")
    }

    fn online_meta(source: &str, title: &str) -> Option<TrackMeta> {
        Some(TrackMeta {
            source: source.to_string(),
            title: title.to_string(),
            artist: Some("在线歌手".into()),
            album: None,
            duration_ms: Some(180_000),
            cover: Some("https://example.invalid/cover.jpg".into()),
        })
    }

    /// 批量入单的闸门也必须前置：越界的那一批一条都不进，而不是靠回滚收拾一个
    /// 写了一半的歌单。
    #[tokio::test]
    async fn add_entries_rejects_oversize_batch_before_writing() {
        let db = pool().await;
        let pl = create(&db, "闸门").await.unwrap();
        let mut entries: Vec<(TrackId, Option<TrackMeta>)> = (0..2)
            .map(|i| {
                (
                    format!("online:netease:{i}"),
                    online_meta("netease", "正常"),
                )
            })
            .collect();
        // 最后一条把封面换成一张 base64 图：前面几条完全合法，闸门若写在写入循环
        // 里就会先把它们入库。
        let big = format!(
            "data:image/png;base64,{}",
            "A".repeat(crate::limits::MAX_URL_CHARS + 1)
        );
        entries.push((
            "online:netease:bad".into(),
            Some(TrackMeta {
                source: "netease".into(),
                title: "坏条目".into(),
                artist: None,
                album: None,
                duration_ms: None,
                cover: Some(big),
            }),
        ));
        assert!(
            add_entries(&db, &pl.id, &entries).await.is_err(),
            "越界快照要拒绝"
        );
        assert!(
            crate::get_playlist_track_ids(&db, &pl.id)
                .await
                .unwrap()
                .is_empty(),
            "被拒的那一批一条都不该进"
        );
        db.close().await;
    }

    #[tokio::test]
    async fn mixed_entries_keep_identity_snapshot_and_order() {
        let db = pool().await;
        let pl = create(&db, "混合歌单").await.unwrap();
        add_entries(
            &db,
            &pl.id,
            &[
                ("local-uuid-1".into(), None),
                ("online:netease:42".into(), online_meta("netease", "网歌")),
                ("online:qq:7".into(), online_meta("qq", "Q歌")),
            ],
        )
        .await
        .unwrap();

        let ids = crate::get_playlist_track_ids(&db, &pl.id).await.unwrap();
        assert_eq!(
            ids,
            vec!["local-uuid-1", "online:netease:42", "online:qq:7"]
        );

        let entries = list_entries(&db, &pl.id).await.unwrap();
        assert_eq!(entries.len(), 3);
        assert!(entries[0].meta.is_none(), "本地行不写快照");
        let snap = entries[1].meta.as_ref().unwrap();
        assert_eq!(snap.source, "netease");
        assert_eq!(snap.title, "网歌");
        assert_eq!(snap.duration_ms, Some(180_000));
        assert_eq!(
            entries[2].meta.as_ref().unwrap().source,
            "qq",
            "快照按行对齐，不串位"
        );
        db.close().await;
    }

    #[tokio::test]
    async fn readd_is_idempotent_and_does_not_rewrite_snapshot() {
        let db = pool().await;
        let pl = create(&db, "幂等").await.unwrap();
        add_entries(
            &db,
            &pl.id,
            &[("online:netease:1".into(), online_meta("netease", "旧名"))],
        )
        .await
        .unwrap();
        // 同一 id 再次入单：跳过，不产生重复行，也不改写已存快照。
        add_entries(
            &db,
            &pl.id,
            &[("online:netease:1".into(), online_meta("netease", "新名"))],
        )
        .await
        .unwrap();
        assert_eq!(
            crate::get_playlist_track_ids(&db, &pl.id)
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            list_entries(&db, &pl.id).await.unwrap()[0]
                .meta
                .as_ref()
                .unwrap()
                .title,
            "旧名"
        );
        db.close().await;
    }

    #[tokio::test]
    async fn remove_repacks_positions_and_keeps_surviving_snapshots() {
        let db = pool().await;
        let pl = create(&db, "重排").await.unwrap();
        add_entries(
            &db,
            &pl.id,
            &[
                ("a".into(), None),
                ("online:netease:1".into(), online_meta("netease", "网歌")),
                ("c".into(), None),
            ],
        )
        .await
        .unwrap();
        remove_track(&db, &pl.id, &"a".to_string()).await.unwrap();
        let entries = list_entries(&db, &pl.id).await.unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|e| e.track_id.as_str())
                .collect::<Vec<_>>(),
            vec!["online:netease:1", "c"]
        );
        assert!(entries[0].meta.is_some(), "移除中间行后快照不丢");
        // 重排以现有成员为全集：快照行与本地行一视同仁。
        reorder(
            &db,
            &pl.id,
            &["c".to_string(), "online:netease:1".to_string()],
        )
        .await
        .unwrap();
        let reordered = list_entries(&db, &pl.id).await.unwrap();
        assert_eq!(reordered[0].track_id, "c".to_string());
        assert!(reordered[1].meta.is_some(), "重排不清洗快照列");
        db.close().await;
    }

    #[tokio::test]
    async fn snapshot_rows_survive_reopen() {
        let dir = std::env::temp_dir().join(format!("vmusic-pl-reopen-{}", uuid::Uuid::new_v4()));
        let db = crate::open(&dir).await.unwrap();
        let pl = create(&db, "重启").await.unwrap();
        add_entries(
            &db,
            &pl.id,
            &[("online:netease:9".into(), online_meta("netease", "网歌"))],
        )
        .await
        .unwrap();
        db.close().await;
        let db = crate::open(&dir).await.unwrap();
        let entries = list_entries(&db, &pl.id).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].meta.as_ref().unwrap().title, "网歌");
        db.close().await;
        crate::cleanup_dir(&dir);
    }
}
