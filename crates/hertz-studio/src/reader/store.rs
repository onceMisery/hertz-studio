// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 阅读领域的 SQLite 持久化：订阅源、文章、图片引用与阅读状态。
//!
//! 刷新在单个事务内合并；失败时旧内容与用户状态原样保留。源删除文章不删除
//! 本地条目（`last_seen_at` 停留即可）；取消订阅只改标记，显式删除才清数据。

use sqlx::{FromRow, SqlitePool};

use super::{unix_now, CleanEntry, FeedIdentity, MAX_ENTRIES, MAX_STORAGE_BYTES};
use crate::error::{not_found, ApiError, ApiResult};

#[derive(FromRow)]
pub(super) struct FeedRow {
    pub id: String,
    pub feed_url: String,
    pub fetched_at: Option<i64>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

#[derive(FromRow)]
pub(super) struct FeedSummaryRow {
    pub id: String,
    pub feed_url: String,
    pub title: String,
    pub site_url: String,
    pub subscribed: bool,
    pub fetched_at: Option<i64>,
    pub last_error: Option<String>,
    pub unread: i64,
    pub latest_at: Option<i64>,
}

#[derive(FromRow)]
pub(super) struct EntryRow {
    pub id: String,
    pub feed_id: String,
    pub title: String,
    pub author: String,
    pub published_at: Option<i64>,
    pub original_url: Option<String>,
    pub summary: String,
    pub content_status: String,
    pub is_read: bool,
    pub starred: bool,
    pub sort_at: i64,
}

#[derive(FromRow)]
pub(super) struct EntryDetailRow {
    pub id: String,
    pub feed_id: String,
    pub title: String,
    pub author: String,
    pub published_at: Option<i64>,
    pub original_url: Option<String>,
    pub summary: String,
    pub content_html: Option<String>,
    pub content_status: String,
    pub document_key: String,
    pub is_read: bool,
    pub starred: bool,
}

#[derive(FromRow)]
struct UsageRow {
    entries: i64,
    bytes: i64,
}

pub(super) fn db_error(error: sqlx::Error) -> ApiError {
    let api =
        crate::error::internal("阅读数据库操作失败（详情见服务端日志）").with_source("reader");
    tracing::error!(request_id = %api.request_id, detail = %error, "reader database error");
    api
}

fn reader_not_found() -> ApiError {
    not_found("未找到此订阅源或文章，请刷新列表").with_source("reader")
}

pub(super) async fn find_feed_by_id(
    ctx: &crate::online::Ctx,
    id: &str,
) -> ApiResult<Option<FeedRow>> {
    sqlx::query_as::<_, FeedRow>("SELECT * FROM reader_feeds WHERE id = ?")
        .bind(id)
        .fetch_optional(&ctx.db)
        .await
        .map_err(db_error)
}

pub(super) async fn feed_summaries(ctx: &crate::online::Ctx) -> ApiResult<Vec<FeedSummaryRow>> {
    sqlx::query_as::<_, FeedSummaryRow>(
        r#"SELECT f.id, f.feed_url, f.title, f.site_url, f.subscribed, f.fetched_at, f.last_error,
            (SELECT COUNT(*) FROM reader_entries e LEFT JOIN reader_entry_state s ON s.entry_id = e.id
              WHERE e.feed_id = f.id AND COALESCE(s.is_read, 0) = 0) AS unread,
            (SELECT MAX(COALESCE(e.published_at, e.first_seen_at)) FROM reader_entries e
              WHERE e.feed_id = f.id) AS latest_at
           FROM reader_feeds f
           ORDER BY f.subscribed DESC, latest_at DESC, f.title COLLATE NOCASE, f.id"#,
    )
    .fetch_all(&ctx.db)
    .await
    .map_err(db_error)
}

/// 一次合并所需的订阅源身份数据。
pub(super) struct SyncInput<'a> {
    pub identity: &'a FeedIdentity<'a>,
    pub title: &'a str,
    pub site_url: &'a str,
    pub etag: Option<&'a str>,
    pub last_modified: Option<&'a str>,
    pub ensure_subscribed: bool,
}

/// 订阅与刷新共用的单事务合并：容量核对 → 订阅源行 upsert → 条目与图片引用
/// upsert。`ensure_subscribed` 用于订阅路径（含取消后重新订阅的原位恢复）；
/// 常规刷新不改变订阅标记。任一步失败整体回滚，旧内容与用户状态保持原样。
pub(super) async fn sync_feed(
    ctx: &crate::online::Ctx,
    input: &SyncInput<'_>,
    entries: &[CleanEntry],
) -> ApiResult<()> {
    let SyncInput {
        identity,
        title,
        site_url,
        etag,
        last_modified,
        ensure_subscribed,
    } = input;
    let now = unix_now();
    let mut tx = ctx.db.begin().await.map_err(db_error)?;
    let existing: Option<String> =
        sqlx::query_scalar("SELECT id FROM reader_feeds WHERE feed_url = ?")
            .bind(identity.feed_url)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_error)?;
    if existing.is_none() {
        let feeds: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM reader_feeds")
            .fetch_one(&mut *tx)
            .await
            .map_err(db_error)?;
        if feeds >= super::MAX_FEEDS as i64 {
            return Err(super::storage_full());
        }
    }
    sqlx::query(
        r#"INSERT INTO reader_feeds
            (id, feed_url, final_url, title, site_url, subscribed, fetched_at, etag, last_modified, last_error, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
            ON CONFLICT(feed_url) DO UPDATE SET final_url = excluded.final_url,
              title = excluded.title, site_url = excluded.site_url, fetched_at = excluded.fetched_at,
              etag = excluded.etag, last_modified = excluded.last_modified, last_error = NULL"#,
    )
    .bind(identity.feed_id)
    .bind(identity.feed_url)
    .bind(identity.final_url)
    .bind(*title)
    .bind(*site_url)
    .bind(if existing.is_some() && !*ensure_subscribed {
        sqlx::query_scalar::<_, bool>("SELECT subscribed FROM reader_feeds WHERE feed_url = ?")
            .bind(identity.feed_url)
            .fetch_one(&mut *tx)
            .await
            .map_err(db_error)?
    } else {
        true
    })
    .bind(now)
    .bind(*etag)
    .bind(*last_modified)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(db_error)?;
    let usage: UsageRow = sqlx::query_as::<_, UsageRow>(
        r#"SELECT (SELECT COUNT(*) FROM reader_entries) AS entries,
            (SELECT COALESCE(SUM(COALESCE(LENGTH(content_html), 0) + LENGTH(summary) + LENGTH(title)), 0)
              FROM reader_entries) AS bytes"#,
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(db_error)?;
    let incoming_bytes: i64 = entries
        .iter()
        .map(|entry| {
            entry
                .content_html
                .as_ref()
                .map_or(0, |html| html.len() as i64)
                + entry.summary.len() as i64
                + entry.title.len() as i64
        })
        .sum();
    if usage.bytes + incoming_bytes > MAX_STORAGE_BYTES || usage.entries >= MAX_ENTRIES {
        return Err(super::storage_full());
    }
    for entry in entries {
        sqlx::query(
            r#"INSERT INTO reader_entries
                (id, feed_id, identity, weak_identity, title, author, published_at, original_url,
                 summary, content_html, content_status, document_key, image_count, first_seen_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(feed_id, identity) DO UPDATE SET
                  title = excluded.title, author = excluded.author,
                  published_at = excluded.published_at, original_url = excluded.original_url,
                  summary = excluded.summary, content_html = excluded.content_html,
                  content_status = excluded.content_status, document_key = excluded.document_key,
                  image_count = excluded.image_count, last_seen_at = excluded.last_seen_at"#,
        )
        .bind(&entry.id)
        .bind(identity.feed_id)
        .bind(&entry.identity)
        .bind(entry.weak)
        .bind(&entry.title)
        .bind(&entry.author)
        .bind(entry.published_at)
        .bind(&entry.original_url)
        .bind(&entry.summary)
        .bind(&entry.content_html)
        .bind(entry.content_status)
        .bind(&entry.document_key)
        .bind(entry.images.len() as i64)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
        sqlx::query("DELETE FROM reader_entry_images WHERE entry_id = ?")
            .bind(&entry.id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
        for (key, source_url) in &entry.images {
            sqlx::query(
                "INSERT OR IGNORE INTO reader_entry_images (entry_id, image_key, source_url) VALUES (?, ?, ?)",
            )
            .bind(&entry.id)
            .bind(key)
            .bind(source_url)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
        }
    }
    tx.commit().await.map_err(db_error)
}

pub(super) async fn set_subscribed(
    ctx: &crate::online::Ctx,
    feed_id: &str,
    value: bool,
) -> ApiResult<()> {
    let result = sqlx::query("UPDATE reader_feeds SET subscribed = ? WHERE id = ?")
        .bind(value)
        .bind(feed_id)
        .execute(&ctx.db)
        .await
        .map_err(db_error)?;
    if result.rows_affected() == 0 {
        return Err(reader_not_found());
    }
    Ok(())
}

/// 显式删除：源、条目、图片引用与阅读状态一起清除；不涉及播客数据。
pub(super) async fn delete_feed(ctx: &crate::online::Ctx, feed_id: &str) -> ApiResult<()> {
    let mut tx = ctx.db.begin().await.map_err(db_error)?;
    sqlx::query(
        "DELETE FROM reader_entry_images WHERE entry_id IN (SELECT id FROM reader_entries WHERE feed_id = ?)",
    )
    .bind(feed_id)
    .execute(&mut *tx)
    .await
    .map_err(db_error)?;
    sqlx::query(
        "DELETE FROM reader_entry_state WHERE entry_id IN (SELECT id FROM reader_entries WHERE feed_id = ?)",
    )
    .bind(feed_id)
    .execute(&mut *tx)
    .await
    .map_err(db_error)?;
    sqlx::query("DELETE FROM reader_entries WHERE feed_id = ?")
        .bind(feed_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    let result = sqlx::query("DELETE FROM reader_feeds WHERE id = ?")
        .bind(feed_id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    if result.rows_affected() == 0 {
        return Err(reader_not_found());
    }
    Ok(())
}

/// 刷新失败时记录最近错误；本身失败不覆盖刷新结果。
pub(super) async fn set_feed_error(ctx: &crate::online::Ctx, feed_id: &str, message: &str) {
    let _ = sqlx::query("UPDATE reader_feeds SET last_error = ? WHERE id = ?")
        .bind(message)
        .bind(feed_id)
        .execute(&ctx.db)
        .await;
}

/// 304 路径：只推进刷新时间并清除上次错误，不触碰内容与用户状态。
pub(super) async fn touch_fetched(ctx: &crate::online::Ctx, feed_id: &str) -> ApiResult<()> {
    sqlx::query("UPDATE reader_feeds SET fetched_at = ?, last_error = NULL WHERE id = ?")
        .bind(unix_now())
        .bind(feed_id)
        .execute(&ctx.db)
        .await
        .map_err(db_error)?;
    Ok(())
}

const ENTRY_SELECT: &str = r#"SELECT e.id, e.feed_id, e.title, e.author, e.published_at,
    e.original_url, e.summary, e.content_status,
    COALESCE(s.is_read, 0) AS is_read, COALESCE(s.starred, 0) AS starred,
    COALESCE(e.published_at, e.first_seen_at) AS sort_at
    FROM reader_entries e LEFT JOIN reader_entry_state s ON s.entry_id = e.id"#;

pub(super) struct EntriesPage {
    pub rows: Vec<EntryRow>,
    pub next_cursor: Option<String>,
}

pub(super) async fn entries_page(
    ctx: &crate::online::Ctx,
    feed_id: Option<&str>,
    unread_only: bool,
    starred_only: bool,
    cursor: Option<(i64, String)>,
    limit: usize,
) -> ApiResult<EntriesPage> {
    let fetch_limit = (limit + 1).min(super::LIST_MAX_LIMIT + 1) as i64;
    let cursor_at = cursor.as_ref().map(|(at, _)| *at);
    let cursor_id = cursor.as_ref().map(|(_, id)| id.clone());
    let mut rows = sqlx::query_as::<_, EntryRow>(&format!(
        "{ENTRY_SELECT}
         WHERE (?1 IS NULL OR e.feed_id = ?1)
           AND (?2 = 0 OR COALESCE(s.is_read, 0) = 0)
           AND (?3 = 0 OR COALESCE(s.starred, 0) = 1)
           AND (?4 IS NULL OR COALESCE(e.published_at, e.first_seen_at) < ?4
                OR (COALESCE(e.published_at, e.first_seen_at) = ?4 AND e.id < ?5))
         ORDER BY sort_at DESC, e.id DESC
         LIMIT ?6"
    ))
    .bind(feed_id)
    .bind(unread_only)
    .bind(starred_only)
    .bind(cursor_at)
    .bind(cursor_id)
    .bind(fetch_limit)
    .fetch_all(&ctx.db)
    .await
    .map_err(db_error)?;
    let next_cursor = if rows.len() > limit {
        rows.truncate(limit);
        rows.last()
            .map(|last| format!("{}:{}", last.sort_at, last.id))
    } else {
        None
    };
    Ok(EntriesPage { rows, next_cursor })
}

pub(super) async fn entry_detail(
    ctx: &crate::online::Ctx,
    entry_id: &str,
) -> ApiResult<Option<(EntryDetailRow, Vec<(String, String)>)>> {
    let detail = sqlx::query_as::<_, EntryDetailRow>(
        r#"SELECT e.id, e.feed_id, e.title, e.author, e.published_at, e.original_url,
            e.summary, e.content_html, e.content_status, e.document_key,
            COALESCE(s.is_read, 0) AS is_read, COALESCE(s.starred, 0) AS starred
           FROM reader_entries e LEFT JOIN reader_entry_state s ON s.entry_id = e.id
           WHERE e.id = ?"#,
    )
    .bind(entry_id)
    .fetch_optional(&ctx.db)
    .await
    .map_err(db_error)?;
    let Some(detail) = detail else {
        return Ok(None);
    };
    let images = sqlx::query_as::<_, ImageRow>(
        "SELECT image_key, source_url FROM reader_entry_images WHERE entry_id = ? ORDER BY image_key",
    )
    .bind(entry_id)
    .fetch_all(&ctx.db)
    .await
    .map_err(db_error)?
    .into_iter()
    .map(|row| (row.image_key, row.source_url))
    .collect();
    Ok(Some((detail, images)))
}

#[derive(FromRow)]
struct ImageRow {
    image_key: String,
    source_url: String,
}

pub(super) async fn image_source(
    ctx: &crate::online::Ctx,
    entry_id: &str,
    key: &str,
) -> ApiResult<Option<String>> {
    sqlx::query_scalar(
        "SELECT source_url FROM reader_entry_images WHERE entry_id = ? AND image_key = ?",
    )
    .bind(entry_id)
    .bind(key)
    .fetch_optional(&ctx.db)
    .await
    .map_err(db_error)
}

/// 阅读状态写入是显式赋值而非 toggle；由调用方持有的领域写锁保证同条目串行。
pub(super) async fn set_state(
    pool: &SqlitePool,
    entry_id: &str,
    is_read: bool,
    starred: bool,
) -> ApiResult<()> {
    let result = sqlx::query(
        r#"INSERT INTO reader_entry_state (entry_id, is_read, starred, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(entry_id) DO UPDATE SET is_read = excluded.is_read,
             starred = excluded.starred, updated_at = excluded.updated_at"#,
    )
    .bind(entry_id)
    .bind(is_read)
    .bind(starred)
    .bind(unix_now())
    .execute(pool)
    .await
    .map_err(db_error)?;
    if result.rows_affected() == 0 {
        return Err(reader_not_found());
    }
    Ok(())
}
