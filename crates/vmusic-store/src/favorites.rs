// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! 收藏的读写。
//!
//! 主键是 `(kind, source, ref_id)` 折出来的稳定串，而不是随机 uuid：收藏是
//! 一个可以被反复点击的开关，用稳定键才能把「重复收藏」交给数据库的
//! UNIQUE 约束挡掉（`INSERT OR IGNORE`），而不是靠「先查一次再决定插不插」
//! —— 后者在多标签页/连点下必然有窗口期，会撞唯一索引而报 500。

use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqlitePool};
use vmusic_core::{Favorite, FavoriteKind, StoreError};

use crate::now_ms;

/// 收藏项的主键。
///
/// 三段都写进主键里，所以这里不做字符清洗：它只用于数据库比较和前端回传，
/// 不会拼进文件路径（在线缓存文件名是另一套 `online::cache_name`）。
pub fn identity(kind: FavoriteKind, source: &str, ref_id: &str) -> String {
    format!("{}:{}:{}", kind.as_str(), source, ref_id)
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct FavoriteRow {
    pub id: String,
    pub kind: String,
    pub source: String,
    pub ref_id: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: Option<i64>,
    pub cover: Option<String>,
    pub added_at: i64,
}

impl TryFrom<FavoriteRow> for Favorite {
    type Error = StoreError;

    fn try_from(r: FavoriteRow) -> Result<Self, Self::Error> {
        let kind = FavoriteKind::parse(&r.kind)
            .ok_or_else(|| StoreError::Database(format!("未知收藏类型: {}", r.kind)))?;
        Ok(Favorite {
            id: r.id,
            kind,
            source: r.source,
            ref_id: r.ref_id,
            title: r.title,
            artist: r.artist,
            album: r.album,
            duration_ms: r.duration_ms.map(|v| v.max(0) as u64),
            cover: r.cover,
            added_at: r.added_at,
        })
    }
}

/// 新增一条收藏；已存在则原样返回既有行（幂等）。
pub async fn add(
    pool: &SqlitePool,
    kind: FavoriteKind,
    source: &str,
    ref_id: &str,
    meta: &FavoriteMeta,
) -> Result<Favorite, StoreError> {
    let id = identity(kind, source, ref_id);
    let now = now_ms();
    sqlx::query(
        r#"INSERT INTO favorites
             (id, kind, source, ref_id, title, artist, album, duration_ms, cover,
              added_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
           ON CONFLICT(kind, source, ref_id) DO NOTHING"#,
    )
    .bind(&id)
    .bind(kind.as_str())
    .bind(source)
    .bind(ref_id)
    .bind(&meta.title)
    .bind(&meta.artist)
    .bind(&meta.album)
    .bind(meta.duration_ms.map(|v| v as i64))
    .bind(&meta.cover)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;

    get(pool, &id)
        .await?
        .ok_or_else(|| StoreError::Database("收藏写入后读不回来".to_string()))
}

/// 写收藏时带的元数据快照。
///
/// 本地曲目这些字段能从 tracks 表 JOIN 出来，在线曲目不能；统一由调用方
/// 在入站时给全，存储层就不再区分两种来源。
#[derive(Debug, Clone, Default)]
pub struct FavoriteMeta {
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: Option<u64>,
    pub cover: Option<String>,
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<Favorite>, StoreError> {
    let row = sqlx::query_as::<_, FavoriteRow>("SELECT * FROM favorites WHERE id = ?1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    row.map(TryInto::try_into).transpose()
}

pub async fn remove(pool: &SqlitePool, id: &str) -> Result<bool, StoreError> {
    let result = sqlx::query("DELETE FROM favorites WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(result.rows_affected() > 0)
}

pub async fn remove_identity(
    pool: &SqlitePool,
    kind: FavoriteKind,
    source: &str,
    ref_id: &str,
) -> Result<bool, StoreError> {
    remove(pool, &identity(kind, source, ref_id)).await
}

/// 按类型分页列出收藏，最近收藏的在前。
pub async fn list(
    pool: &SqlitePool,
    kind: Option<FavoriteKind>,
    limit: i64,
    offset: i64,
) -> Result<Vec<Favorite>, StoreError> {
    let rows =
        match kind {
            Some(k) => sqlx::query_as::<_, FavoriteRow>(
                "SELECT * FROM favorites WHERE kind = ?1 ORDER BY added_at DESC LIMIT ?2 OFFSET ?3",
            )
            .bind(k.as_str())
            .bind(limit)
            .bind(offset)
            .fetch_all(pool)
            .await,
            None => {
                sqlx::query_as::<_, FavoriteRow>(
                    "SELECT * FROM favorites ORDER BY added_at DESC LIMIT ?1 OFFSET ?2",
                )
                .bind(limit)
                .bind(offset)
                .fetch_all(pool)
                .await
            }
        }
        .map_err(|e| StoreError::Database(e.to_string()))?;

    rows.into_iter().map(TryInto::try_into).collect()
}

pub async fn count(pool: &SqlitePool, kind: Option<FavoriteKind>) -> Result<i64, StoreError> {
    let row: (i64,) = match kind {
        Some(k) => {
            sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM favorites WHERE kind = ?1")
                .bind(k.as_str())
                .fetch_one(pool)
                .await
        }
        None => {
            sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM favorites")
                .fetch_one(pool)
                .await
        }
    }
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(row.0)
}

/// 一批对象是否已收藏。
///
/// 曲库一屏 200 行，逐行问一次是 200 次往返。这里改成「把整屏的键一次捞回来」，
/// 前端拿到的是集合而不是布尔数组，也就不需要维护「第 N 行对应第 N 个结果」
/// 这种隐式契约。
pub async fn is_favorited(
    pool: &SqlitePool,
    kind: FavoriteKind,
    source: &str,
    ref_ids: &[String],
) -> Result<Vec<String>, StoreError> {
    if ref_ids.is_empty() {
        return Ok(Vec::new());
    }
    // 占位符统一编号。混用 `?1 ?2` 这样的显式编号与裸 `?` 是 SQLite 的未明确
    // 行为（裸 ? 的编号取决于出现位置与已用过的最大编号），曾经让 IN 列表里
    // 的第二个 id 绑到了 kind 上，表现为「批量判红只命中第一条」。
    let placeholders = (0..ref_ids.len())
        .map(|i| format!("?{}", i + 3))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT ref_id FROM favorites WHERE kind = ?1 AND source = ?2 AND ref_id IN ({placeholders})"
    );
    let mut query = sqlx::query_scalar::<_, String>(&sql)
        .bind(kind.as_str())
        .bind(source);
    for id in ref_ids {
        query = query.bind(id);
    }
    query
        .fetch_all(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))
}

/// 已收藏曲目在本地库里的 id（供每日推荐取候选与打分）。
///
/// 只看 `local` 源：在线收藏的曲目不在本地库里，拿不到可用于播放的本地路径。
pub async fn local_track_ids(pool: &SqlitePool, limit: i64) -> Result<Vec<String>, StoreError> {
    sqlx::query_scalar::<_, String>(
        "SELECT ref_id FROM favorites WHERE kind = 'track' AND source = 'local'
         ORDER BY added_at DESC LIMIT ?1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))
}

/// 收藏里出现过的艺术家（每日推荐的 affinity 源）。
///
/// 去重后按收藏时间倒序返回，调用方取前若干个作为「常听艺术家」。
pub async fn top_artists(pool: &SqlitePool, limit: i64) -> Result<Vec<String>, StoreError> {
    let rows = sqlx::query(
        "SELECT artist, MAX(added_at) AS latest FROM favorites
         WHERE artist IS NOT NULL AND TRIM(artist) <> ''
         GROUP BY artist ORDER BY latest DESC LIMIT ?1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(rows
        .iter()
        .filter_map(|r: &SqliteRow| {
            r.get::<Option<String>, _>("artist")
                .map(|a| a.trim().to_string())
                .filter(|a| !a.is_empty())
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> SqlitePool {
        let dir = std::env::temp_dir().join(format!("vmusic-fav-test-{}", uuid::Uuid::new_v4()));
        crate::open(&dir).await.expect("open db")
    }

    fn meta(title: &str, artist: Option<&str>) -> FavoriteMeta {
        FavoriteMeta {
            title: title.to_string(),
            artist: artist.map(|s| s.to_string()),
            album: None,
            duration_ms: Some(210_000),
            cover: None,
        }
    }

    #[tokio::test]
    async fn add_is_idempotent_on_identity() {
        let db = pool().await;
        let a = add(
            &db,
            FavoriteKind::Track,
            "local",
            "t1",
            &meta("A", Some("X")),
        )
        .await
        .unwrap();
        let b = add(
            &db,
            FavoriteKind::Track,
            "local",
            "t1",
            &meta("A (remaster)", None),
        )
        .await
        .unwrap();
        assert_eq!(a.id, b.id, "重复收藏必须落在同一行上");
        // 已存在时不覆盖：收藏是开关，重复点击不该悄悄改写快照。
        assert_eq!(b.title, "A");
        assert_eq!(count(&db, None).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn kinds_are_independent() {
        let db = pool().await;
        add(&db, FavoriteKind::Track, "local", "x", &meta("T", None))
            .await
            .unwrap();
        add(&db, FavoriteKind::Radio, "netease", "x", &meta("R", None))
            .await
            .unwrap();
        assert_eq!(count(&db, Some(FavoriteKind::Track)).await.unwrap(), 1);
        assert_eq!(count(&db, Some(FavoriteKind::Radio)).await.unwrap(), 1);
        assert_eq!(count(&db, None).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn list_is_ordered_by_most_recent_first() {
        let db = pool().await;
        add(
            &db,
            FavoriteKind::Track,
            "local",
            "1",
            &meta("one", Some("A")),
        )
        .await
        .unwrap();
        add(
            &db,
            FavoriteKind::Track,
            "local",
            "2",
            &meta("two", Some("B")),
        )
        .await
        .unwrap();
        let all = list(&db, None, 10, 0).await.unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].ref_id, "2");
        assert_eq!(list(&db, None, 1, 0).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn remove_by_identity_and_membership_check() {
        let db = pool().await;
        add(
            &db,
            FavoriteKind::Track,
            "local",
            "1",
            &meta("one", Some("A")),
        )
        .await
        .unwrap();
        add(
            &db,
            FavoriteKind::Track,
            "local",
            "2",
            &meta("two", Some("B")),
        )
        .await
        .unwrap();
        let hit = is_favorited(
            &db,
            FavoriteKind::Track,
            "local",
            &["1".into(), "2".into(), "9".into()],
        )
        .await
        .unwrap();
        assert_eq!(hit.len(), 2);
        assert!(remove_identity(&db, FavoriteKind::Track, "local", "1")
            .await
            .unwrap());
        assert!(!remove_identity(&db, FavoriteKind::Track, "local", "1")
            .await
            .unwrap());
        assert_eq!(count(&db, None).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn local_ids_and_top_artists_only_see_local_favorites() {
        let db = pool().await;
        add(
            &db,
            FavoriteKind::Track,
            "local",
            "L1",
            &meta("a", Some("Artist A")),
        )
        .await
        .unwrap();
        add(
            &db,
            FavoriteKind::Track,
            "netease",
            "N1",
            &meta("b", Some("Artist B")),
        )
        .await
        .unwrap();
        // 在线收藏没有本地路径，不能进每日推荐的候选池。
        assert_eq!(
            local_track_ids(&db, 50).await.unwrap(),
            vec!["L1".to_string()]
        );
        // 但艺术家偏好两种来源都算：它是口味，不是可播放性。
        assert_eq!(top_artists(&db, 10).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn empty_membership_query_hits_no_sql() {
        let db = pool().await;
        assert!(is_favorited(&db, FavoriteKind::Track, "local", &[])
            .await
            .unwrap()
            .is_empty());
    }
}
