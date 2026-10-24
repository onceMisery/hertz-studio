// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! RSS 图文阅读：博客、新闻等源的订阅、应用内阅读与阅读状态。
//!
//! 与播客领域完全独立（方案 B）：这里没有音频语义，播客也不承担文章字段。
//! 公网准入与有界读取走 `public_net`，XML 预检与解析走 `feed_xml`，HTML 清洗
//! 是本领域唯一放行点。所有预算在下方常量中唯一声明，对应 spec 第 8 节。

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{bad_request, not_found, ApiError, ApiResult};
use crate::online;

mod network;
mod parse;
mod sanitize;
mod store;

use network::public_url;
use parse::feed_id;

// --- 首期候选预算（spec §8 / §11）---

const MAX_FEED_BYTES: usize = 16 * 1024 * 1024;
const MAX_XML_NODES: u32 = 200_000;
/// 单次条目扫描上限；达到即标明截断，不宣称源已完整同步。
const MAX_ENTRIES_SCAN: usize = 2_000;
/// 清洗后单篇正文上限；超限在标签边界截断并补齐闭合。
pub(crate) const MAX_CONTENT_BYTES: usize = 64 * 1024;
/// 单源一次刷新收录的正文合计上限；余项只保留元数据与原文链接。
const MAX_FEED_CONTENT_BYTES: usize = 8 * 1024 * 1024;
/// 每篇文章最多登记的图片引用；超限的图片 `src` 置空且不发起请求。
pub(crate) const MAX_IMAGES_PER_ENTRY: usize = 32;
/// 单篇详情响应的 JSON 编码上限；超限缩减正文并显式标记。
const MAX_DETAIL_BYTES: usize = 256 * 1024;
const LIST_DEFAULT_LIMIT: usize = 30;
const LIST_MAX_LIMIT: usize = 100;
const LIST_SUMMARY_CHARS: usize = 280;
const MAX_SUMMARY_CHARS: usize = 4_000;
const MAX_TITLE_CHARS: usize = 512;
const MAX_AUTHOR_CHARS: usize = 256;
/// preview 与刷新共享的全进程并发槽；额外任务立即 `reader_busy`，不排队。
const MAX_REFRESH_TASKS: usize = 2;
/// 缓存有效期；手动刷新可绕过 TTL，但不绕过并发槽与总期限。
const REFRESH_TTL_SECS: u64 = 15 * 60;
/// 网络、解析与落盘共同的总期限。
const REFRESH_TOTAL_TIMEOUT: Duration = Duration::from_secs(20);
/// 保留源上限（含已取消订阅）。
const MAX_FEEDS: usize = 200;
const MAX_ENTRIES: i64 = 50_000;
/// 阅读内容逻辑字节预算；不代表 SQLite 文件/WAL 物理体积或进程内存上界。
const MAX_STORAGE_BYTES: i64 = 256 * 1024 * 1024;

pub(super) fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .min(i64::MAX as u64) as i64
}

pub(super) fn storage_full() -> ApiError {
    network::storage_full()
}

/// 订阅源身份：原始订阅 URL 决定身份与 `feed_id`，最终响应地址（重定向后）
/// 单独保存，供相对地址与 `xml:base` 解析使用。
pub(super) struct FeedIdentity<'a> {
    pub feed_id: &'a str,
    pub feed_url: &'a str,
    pub final_url: &'a str,
}

/// 清洗完成、可直接入库的条目。
pub(super) struct CleanEntry {
    pub id: String,
    pub identity: String,
    pub weak: bool,
    pub title: String,
    pub author: String,
    pub published_at: Option<i64>,
    pub original_url: Option<String>,
    pub summary: String,
    pub content_html: Option<String>,
    pub content_status: &'static str,
    pub document_key: String,
    pub images: Vec<(String, String)>,
}

// --- DTO（HTTP 与 RPC 共用）---

#[derive(Debug, Clone, Serialize)]
pub struct FeedSummary {
    pub id: String,
    pub feed_url: String,
    pub title: String,
    pub site_url: String,
    pub subscribed: bool,
    pub unread: i64,
    pub latest_at: Option<i64>,
    pub fetched_at: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReaderPreviewEntry {
    pub title: String,
    pub author: String,
    pub published_at: Option<i64>,
    pub original_url: Option<String>,
    pub summary: String,
    pub has_content: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReaderPreview {
    pub title: String,
    pub site_url: Option<String>,
    pub feed_url: String,
    pub entries: Vec<ReaderPreviewEntry>,
    pub scan_truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct EntryListItem {
    pub id: String,
    pub feed_id: String,
    pub title: String,
    pub author: String,
    pub published_at: Option<i64>,
    pub original_url: Option<String>,
    pub summary: String,
    pub has_content: bool,
    pub is_read: bool,
    pub starred: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct EntryPage {
    pub items: Vec<EntryListItem>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReaderImage {
    pub key: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct EntryDetail {
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
    pub images: Vec<ReaderImage>,
    pub is_read: bool,
    pub starred: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RefreshResult {
    pub synced: usize,
    pub not_modified: bool,
    pub fetched_at: i64,
}

#[derive(Debug, Deserialize)]
pub struct ReaderPreviewRequest {
    pub feed_url: String,
}

#[derive(Debug, Deserialize)]
pub struct ReaderSubscribeRequest {
    pub feed_url: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct ReaderRefreshRequest {
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Deserialize)]
pub struct ReaderEntriesQuery {
    pub feed_id: Option<String>,
    pub unread: Option<bool>,
    pub starred: Option<bool>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct ReaderEntryStateRequest {
    pub is_read: bool,
    pub starred: bool,
}

// --- 并发与写锁 ---

fn slots() -> &'static Arc<tokio::sync::Semaphore> {
    static SLOTS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    SLOTS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(MAX_REFRESH_TASKS)))
}

fn acquire_slot() -> ApiResult<tokio::sync::OwnedSemaphorePermit> {
    Arc::clone(slots())
        .try_acquire_owned()
        .map_err(|_| network::reader_busy())
}

/// 按 feed_id 的单飞锁：同源刷新串行，后来者通过 TTL 复查合并进已完成结果。
fn feed_lock(feed_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let map = LOCKS.get_or_init(Default::default);
    let mut guard = map
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    guard.entry(feed_id.to_string()).or_default().clone()
}

/// 阅读状态写入锁（spec §11 #7）：写少读稀疏，领域级串行即满足同条目串行。
async fn state_guard() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

/// 在独立任务中运行整个网络/解析/落盘管线：调用方中途放弃（连接断开、
/// 请求取消）不会提前归还并发槽——任务持有许可直到实际工作退出。
/// 20 秒总期限在任务内部生效，超时同样以任务结束为准。
async fn run_bounded<T: Send + 'static>(
    task: impl Future<Output = ApiResult<T>> + Send + 'static,
) -> ApiResult<T> {
    match tokio::spawn(task).await {
        Ok(result) => result,
        Err(_) => Err(ApiError::internal("阅读任务异常退出").with_source("reader")),
    }
}

fn reader_timeout() -> ApiError {
    ApiError::upstream_timeout("阅读源刷新超过 20 秒总期限，请稍后重试").with_source("reader")
}

fn reader_not_found() -> ApiError {
    not_found("未找到此订阅源或文章，请刷新列表").with_source("reader")
}

fn invalid_entry_id() -> ApiError {
    bad_request("无效的文章编号").with_source("reader")
}

fn is_entry_id(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

// --- 抓取与清洗管线 ---

enum Fetched {
    NotModified,
    Body {
        bytes: Vec<u8>,
        document_url: reqwest::Url,
        etag: Option<String>,
        last_modified: Option<String>,
    },
}

async fn fetch_feed(
    url: &reqwest::Url,
    etag: Option<&str>,
    last_modified: Option<&str>,
) -> ApiResult<Fetched> {
    use reqwest::header::{ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED};
    let client = network::public_client()?;
    let mut request = client
        .get(url.clone())
        .header(
            reqwest::header::ACCEPT,
            "application/rss+xml, application/atom+xml, application/xml, text/xml",
        )
        .timeout(REFRESH_TOTAL_TIMEOUT);
    if let Some(tag) = etag {
        request = request.header(IF_NONE_MATCH, tag);
    }
    if let Some(since) = last_modified {
        request = request.header(IF_MODIFIED_SINCE, since);
    }
    let response = request.send().await.map_err(network::request_error)?;
    if response.status() == axum::http::StatusCode::NOT_MODIFIED {
        return Ok(Fetched::NotModified);
    }
    let document_url = response.url().clone();
    let response_etag = response
        .headers()
        .get(ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let response_lm = response
        .headers()
        .get(LAST_MODIFIED)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let bytes = network::read_bounded(response, MAX_FEED_BYTES, network::feed_too_large).await?;
    Ok(Fetched::Body {
        bytes,
        document_url,
        etag: response_etag,
        last_modified: response_lm,
    })
}

struct SyncedFeed {
    title: String,
    site_url: Option<String>,
    entries: Vec<CleanEntry>,
    /// 条目扫描触及扫描上限，源可能还有未扫的条目。
    scan_truncated: bool,
}

/// 解析 + 清洗：产出可直接入库的条目；图片登记与正文预算都在此一次性完成。
/// 同步执行（无 await 点），因此超时取消只会发生在网络/落盘阶段之间。
fn parse_and_clean(
    feed_url: &reqwest::Url,
    document_url: &reqwest::Url,
    bytes: &[u8],
) -> ApiResult<SyncedFeed> {
    if std::str::from_utf8(bytes).is_err() {
        return Err(network::unsupported_encoding());
    }
    let parsed =
        parse::parse_feed(feed_url, document_url, bytes).map_err(|_| network::invalid_feed())?;
    let mut entries = Vec::with_capacity(parsed.entries.len());
    let mut total_bytes = 0usize;
    for entry in parsed.entries {
        let (content_html, content_status, images) = match entry.raw_html.as_deref() {
            Some(raw) => {
                let base = entry
                    .content_base
                    .as_deref()
                    .and_then(|base| document_url.join(base).ok())
                    .unwrap_or_else(|| document_url.clone());
                let mut registry = sanitize::ImageRegistry::new();
                let cleaned = sanitize::clean(raw, &base, &mut registry);
                if total_bytes + cleaned.html.len() > MAX_FEED_CONTENT_BYTES {
                    // 余项保留有界元数据与原文链接，标记正文因预算未缓存。
                    (None, "over_budget", Vec::new())
                } else {
                    total_bytes += cleaned.html.len();
                    let status = match cleaned.status {
                        sanitize::CleanStatus::Cached => "cached",
                        sanitize::CleanStatus::Truncated => "truncated",
                    };
                    (Some(cleaned.html), status, registry.items)
                }
            }
            None => (
                None,
                if entry.content_present {
                    "summary_only"
                } else {
                    "none"
                },
                Vec::new(),
            ),
        };
        let document_key = parse::digest(&[
            &entry.identity,
            content_html.as_deref().unwrap_or(""),
            &entry.summary,
        ]);
        entries.push(CleanEntry {
            id: parse::digest(&["reader-entry-v1", feed_url.as_str(), &entry.identity]),
            identity: entry.identity,
            weak: entry.weak,
            title: entry.title,
            author: entry.author,
            published_at: entry.published_at,
            original_url: entry.original_url,
            summary: entry.summary,
            content_html,
            content_status,
            document_key,
            images,
        });
    }
    Ok(SyncedFeed {
        title: parsed.title,
        site_url: parsed.site_url,
        entries,
        scan_truncated: parsed.scan_truncated,
    })
}

// --- 服务函数 ---

const PREVIEW_ENTRY_COUNT: usize = 10;

pub async fn preview(_ctx: &online::Ctx, feed_url: &str) -> ApiResult<ReaderPreview> {
    let url = public_url(feed_url)?;
    let permit = acquire_slot()?;
    let task_url = url.clone();
    let fetched = run_bounded(async move {
        let _permit = permit;
        tokio::time::timeout(REFRESH_TOTAL_TIMEOUT, async {
            match fetch_feed(&task_url, None, None).await? {
                Fetched::NotModified => Err(network::invalid_feed()),
                Fetched::Body {
                    bytes,
                    document_url,
                    ..
                } => Ok(parse_and_clean(&task_url, &document_url, &bytes)?),
            }
        })
        .await
        .map_err(|_| reader_timeout())?
    })
    .await?;
    Ok(ReaderPreview {
        title: fetched.title,
        site_url: fetched.site_url.clone(),
        feed_url: url.to_string(),
        entries: fetched
            .entries
            .iter()
            .take(PREVIEW_ENTRY_COUNT)
            .map(|entry| ReaderPreviewEntry {
                title: entry.title.clone(),
                author: entry.author.clone(),
                published_at: entry.published_at,
                original_url: entry.original_url.clone(),
                summary: truncate_chars(&entry.summary, LIST_SUMMARY_CHARS),
                has_content: entry.content_html.is_some(),
            })
            .collect(),
        scan_truncated: fetched.scan_truncated,
    })
}

pub async fn subscriptions(ctx: &online::Ctx) -> ApiResult<Vec<FeedSummary>> {
    Ok(store::feed_summaries(ctx)
        .await?
        .into_iter()
        .map(|row| FeedSummary {
            id: row.id,
            feed_url: row.feed_url,
            title: row.title,
            site_url: row.site_url,
            subscribed: row.subscribed,
            unread: row.unread.max(0),
            latest_at: row.latest_at,
            fetched_at: row.fetched_at,
            last_error: row.last_error,
        })
        .collect())
}

pub async fn subscribe(ctx: &online::Ctx, feed_url: &str) -> ApiResult<FeedSummary> {
    let url = public_url(feed_url)?;
    let feed_id = feed_id(&url);
    let existing = store::find_feed_by_id(ctx, &feed_id).await?;
    let permit = acquire_slot()?;
    let lock = feed_lock(&feed_id);
    let task_ctx = ctx.clone();
    let task_url = url.clone();
    let task_id = feed_id.clone();
    run_bounded(async move {
        let _permit = permit;
        let _guard = lock.lock().await;
        tokio::time::timeout(REFRESH_TOTAL_TIMEOUT, async {
            let fetched = fetch_feed(
                &task_url,
                existing.as_ref().and_then(|f| f.etag.as_deref()),
                existing.as_ref().and_then(|f| f.last_modified.as_deref()),
            )
            .await?;
            match fetched {
                Fetched::NotModified => {
                    store::touch_fetched(&task_ctx, &task_id).await?;
                }
                Fetched::Body {
                    bytes,
                    document_url,
                    etag,
                    last_modified,
                } => {
                    let data = parse_and_clean(&task_url, &document_url, &bytes)?;
                    let input = store::SyncInput {
                        identity: &FeedIdentity {
                            feed_id: &task_id,
                            feed_url: task_url.as_str(),
                            final_url: document_url.as_str(),
                        },
                        title: &data.title,
                        site_url: data.site_url.as_deref().unwrap_or(""),
                        etag: etag.as_deref(),
                        last_modified: last_modified.as_deref(),
                        ensure_subscribed: true,
                    };
                    store::sync_feed(&task_ctx, &input, &data.entries).await?;
                }
            }
            store::set_subscribed(&task_ctx, &task_id, true).await
        })
        .await
        .map_err(|_| reader_timeout())?
    })
    .await?;
    subscriptions(ctx)
        .await?
        .into_iter()
        .find(|summary| summary.id == feed_id)
        .ok_or_else(reader_not_found)
}

pub async fn unsubscribe(ctx: &online::Ctx, feed_id: &str) -> ApiResult<()> {
    if !is_entry_id(feed_id) {
        return Err(reader_not_found());
    }
    store::set_subscribed(ctx, feed_id, false).await
}

pub async fn delete_feed(ctx: &online::Ctx, feed_id: &str) -> ApiResult<()> {
    if !is_entry_id(feed_id) {
        return Err(reader_not_found());
    }
    store::delete_feed(ctx, feed_id).await
}

pub async fn refresh(ctx: &online::Ctx, feed_id: &str, force: bool) -> ApiResult<RefreshResult> {
    if !is_entry_id(feed_id) {
        return Err(reader_not_found());
    }
    let feed = store::find_feed_by_id(ctx, feed_id)
        .await?
        .ok_or_else(reader_not_found)?;
    let permit = acquire_slot()?;
    let lock = feed_lock(&feed.id);
    let task_ctx = ctx.clone();
    let task_id = feed.id.clone();
    let error_target = feed.id.clone();
    // 首跳准入放在任务内：任何阶段（含地址准入）的失败都要记录 last_error。
    let result = run_bounded(async move {
        let _permit = permit;
        let _guard = lock.lock().await;
        let url = match public_url(&feed.feed_url) {
            Ok(url) => url,
            Err(error) => return Err(error),
        };
        tokio::time::timeout(REFRESH_TOTAL_TIMEOUT, async {
            if !force
                && feed
                    .fetched_at
                    .is_some_and(|at| unix_now().saturating_sub(at) < REFRESH_TTL_SECS as i64)
            {
                // 同源请求合并：TTL 内的刷新直接复用已落库内容。
                return Ok(RefreshResult {
                    synced: 0,
                    not_modified: false,
                    fetched_at: feed.fetched_at.unwrap_or_default(),
                });
            }
            let fetched =
                fetch_feed(&url, feed.etag.as_deref(), feed.last_modified.as_deref()).await?;
            match fetched {
                Fetched::NotModified => {
                    store::touch_fetched(&task_ctx, &task_id).await?;
                    Ok(RefreshResult {
                        synced: 0,
                        not_modified: true,
                        fetched_at: unix_now(),
                    })
                }
                Fetched::Body {
                    bytes,
                    document_url,
                    etag,
                    last_modified,
                } => {
                    let data = parse_and_clean(&url, &document_url, &bytes)?;
                    let input = store::SyncInput {
                        identity: &FeedIdentity {
                            feed_id: &task_id,
                            feed_url: url.as_str(),
                            final_url: document_url.as_str(),
                        },
                        title: &data.title,
                        site_url: data.site_url.as_deref().unwrap_or(""),
                        etag: etag.as_deref(),
                        last_modified: last_modified.as_deref(),
                        ensure_subscribed: false,
                    };
                    store::sync_feed(&task_ctx, &input, &data.entries).await?;
                    Ok(RefreshResult {
                        synced: data.entries.len(),
                        not_modified: false,
                        fetched_at: unix_now(),
                    })
                }
            }
        })
        .await
        .map_err(|_| reader_timeout())?
    })
    .await;
    if let Err(error) = &result {
        let message: String = error.message.chars().take(200).collect();
        store::set_feed_error(ctx, &error_target, &message).await;
    }
    result
}

pub async fn entries(ctx: &online::Ctx, query: &ReaderEntriesQuery) -> ApiResult<EntryPage> {
    let limit = query
        .limit
        .unwrap_or(LIST_DEFAULT_LIMIT)
        .clamp(1, LIST_MAX_LIMIT);
    let cursor = match query.cursor.as_deref() {
        Some(raw) => Some(parse_cursor(raw)?),
        None => None,
    };
    if query.feed_id.as_deref().is_some_and(|id| !is_entry_id(id)) {
        return Err(reader_not_found());
    }
    let page = store::entries_page(
        ctx,
        query.feed_id.as_deref(),
        query.unread.unwrap_or(false),
        query.starred.unwrap_or(false),
        cursor,
        limit,
    )
    .await?;
    Ok(EntryPage {
        items: page
            .rows
            .into_iter()
            .map(|row| EntryListItem {
                id: row.id,
                feed_id: row.feed_id,
                title: row.title,
                author: row.author,
                published_at: row.published_at,
                original_url: row.original_url,
                summary: truncate_chars(&row.summary, LIST_SUMMARY_CHARS),
                has_content: matches!(row.content_status.as_str(), "cached" | "truncated"),
                is_read: row.is_read,
                starred: row.starred,
            })
            .collect(),
        next_cursor: page.next_cursor,
    })
}

fn parse_cursor(raw: &str) -> ApiResult<(i64, String)> {
    let invalid = || bad_request("无效的分页标记").with_source("reader");
    let (at, id) = raw.rsplit_once(':').ok_or_else(invalid)?;
    let at: i64 = at.parse().map_err(|_| invalid())?;
    if !(0..=64).contains(&id.len()) || id.bytes().any(|b| !b.is_ascii_hexdigit()) {
        return Err(invalid());
    }
    Ok((at, id.to_string()))
}

fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

pub async fn entry_detail(ctx: &online::Ctx, entry_id: &str) -> ApiResult<EntryDetail> {
    if !is_entry_id(entry_id) {
        return Err(invalid_entry_id());
    }
    let (row, images) = store::entry_detail(ctx, entry_id)
        .await?
        .ok_or_else(reader_not_found)?;
    let mut detail = EntryDetail {
        id: row.id,
        feed_id: row.feed_id,
        title: row.title,
        author: row.author,
        published_at: row.published_at,
        original_url: row.original_url,
        summary: row.summary,
        content_html: row.content_html,
        content_status: row.content_status,
        document_key: row.document_key,
        images: images
            .into_iter()
            .map(|(key, _)| ReaderImage { key })
            .collect(),
        is_read: row.is_read,
        starred: row.starred,
    };
    if serde_json::to_vec(&detail)
        .map(|bytes| bytes.len() > MAX_DETAIL_BYTES)
        .unwrap_or(true)
    {
        detail.content_html = None;
        detail.content_status = "over_limit".into();
    }
    Ok(detail)
}

pub async fn set_state(
    ctx: &online::Ctx,
    entry_id: &str,
    is_read: bool,
    starred: bool,
) -> ApiResult<()> {
    if !is_entry_id(entry_id) {
        return Err(invalid_entry_id());
    }
    let guard = state_guard().await;
    let result = store::set_state(&ctx.db, entry_id, is_read, starred).await;
    drop(guard);
    result
}

/// 图片代理仅放行「该文章清洗时登记过」的键；返回源地址，由 HTTP 层代理抓取。
pub async fn image_target(ctx: &online::Ctx, entry_id: &str, key: &str) -> ApiResult<String> {
    if !is_entry_id(entry_id) || key.len() != 32 || key.bytes().any(|b| !b.is_ascii_hexdigit()) {
        return Err(invalid_entry_id());
    }
    store::image_source(ctx, entry_id, key)
        .await?
        .ok_or_else(|| not_found("未找到此文章图片，请重新加载正文").with_source("reader"))
}

#[cfg(test)]
mod tests;
