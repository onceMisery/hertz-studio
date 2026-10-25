// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

use super::*;
use crate::online;
use parse::parse_feed;
use reqwest::Url;

const FEED_URL: &str = "https://blog.example.com/feed.xml";

const RSS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"
 xmlns:dc="http://purl.org/dc/elements/1.1/">
 <channel><title><![CDATA[技术快报 <b>中文</b>]]></title>
 <link>https://blog.example.com/</link>
 <description>站内公告</description>
 <item><title>第一篇：图文正文</title><guid>tag:blog.example.com,2026:1</guid>
   <pubDate>Fri, 02 Oct 2026 09:11:35 GMT</pubDate>
   <dc:creator>作者甲</dc:creator>
   <link>https://blog.example.com/posts/1</link>
   <content:encoded><![CDATA[<p onclick="evil()">第一段<script>alert(1)</script><img src="/img/one.png" alt="图一"></p>]]></content:encoded>
 </item>
 <item><title>第一篇：图文正文</title><guid>tag:blog.example.com,2026:1</guid>
   <link>https://blog.example.com/posts/1?from=rss</link></item>
 <item><title>第二篇：仅摘要</title><guid>tag:blog.example.com,2026:2</guid>
   <pubDate>不是日期</pubDate>
   <link>https://blog.example.com/posts/2</link>
   <description><![CDATA[<p>只有摘要内容</p>]]></description></item>
 <item><guid>tag:blog.example.com,2026:3</guid>
   <link>https://blog.example.com/posts/3</link></item>
 <item><enclosure url="https://blog.example.com/e.mp3" type="audio/mpeg" length="1"/></item>
 <item><title>无身份条目</title><pubDate>Fri, 02 Oct 2026 08:00:00 GMT</pubDate>
   <description>既无 guid 也无链接</description></item>
 </channel></rss>"#;

const ATOM: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
 <title>Atom 快报</title><link rel="alternate" href="https://atom.example.com/"/>
 <entry><id>tag:atom.example.com,2026:1</id><title>XHTML 正文</title>
  <updated>2026-10-02T09:11:35Z</updated>
  <link rel="alternate" href="https://atom.example.com/a"/>
  <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>第一段</p><img src="/x.png"/></div></content>
 </entry>
 <entry><id>tag:atom.example.com,2026:2</id><title>HTML 正文</title>
  <published>2026-10-02T08:00:00+08:00</published>
  <link rel="alternate" href="https://atom.example.com/b"/>
  <content type="html">&lt;p&gt;转义正文&lt;img src="/y.png"&gt;&lt;/p&gt;</content>
 </entry>
 <entry><id>tag:atom.example.com,2026:3</id><title>仅摘要</title>
  <link rel="alternate" href="https://atom.example.com/c"/>
  <summary>摘要文本</summary>
 </entry>
 <entry><id>tag:atom.example.com,2026:4</id><title>纯文本正文</title>
  <link rel="alternate" href="https://atom.example.com/d"/>
  <content type="text">普通文本</content>
 </entry>
</feed>"#;

fn urls() -> (Url, Url) {
    let url = Url::parse(FEED_URL).unwrap();
    (url.clone(), url)
}

fn parsed(xml: &str) -> parse::ParsedFeedData {
    let (feed_url, document_url) = urls();
    parse_feed(&feed_url, &document_url, xml.as_bytes()).expect("valid public feed")
}

fn cleaned(xml: &str) -> SyncedFeed {
    let (feed_url, document_url) = urls();
    parse_and_clean(&feed_url, &document_url, xml.as_bytes()).expect("clean pipeline")
}

async fn context() -> (online::Ctx, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("hertz-reader-{}", uuid::Uuid::new_v4()));
    let db = vmusic_store::open(&dir).await.unwrap();
    (online::Ctx::new(db), dir)
}

async fn cleanup(ctx: online::Ctx, dir: std::path::PathBuf) {
    ctx.db.close().await;
    drop(ctx);
    // Windows 的 SQLite worker 可能稍后才释放 WAL 句柄；清理不属于业务断言。
    let _ = tokio::fs::remove_dir_all(dir).await;
}

fn identity_for<'a>(feed_url: &'a Url, final_url: &'a str, feed_id: &'a str) -> FeedIdentity<'a> {
    FeedIdentity {
        feed_id,
        feed_url: feed_url.as_str(),
        final_url,
    }
}

async fn sync_fixture(ctx: &online::Ctx) -> Vec<String> {
    let (feed_url, _) = urls();
    let data = cleaned(RSS);
    let feed_id = parse::feed_id(&feed_url);
    let input = store::SyncInput {
        identity: &identity_for(&feed_url, FEED_URL, &feed_id),
        title: &data.title,
        site_url: data.site_url.as_deref().unwrap_or(""),
        etag: None,
        last_modified: None,
        ensure_subscribed: true,
    };
    store::sync_feed(ctx, &input, &data.entries).await.unwrap();
    data.entries.iter().map(|entry| entry.id.clone()).collect()
}

#[test]
fn rss_blog_fixture_keeps_articles_and_skips_audio() {
    let data = parsed(RSS);
    assert_eq!(data.title, "技术快报 中文");
    assert_eq!(data.site_url.as_deref(), Some("https://blog.example.com/"));
    // 重复 guid 去重；仅有 enclosure 的条目跳过；空内容+链接的条目按规则收录。
    assert_eq!(data.entries.len(), 4);
    let first = &data.entries[0];
    assert!(first.identity.starts_with("guid:"));
    assert!(first.raw_html.is_some());
    assert_eq!(first.published_at, Some(ts("2026-10-02T09:11:35Z")));
    assert_eq!(first.author, "作者甲");
    assert_eq!(
        first.original_url.as_deref(),
        Some("https://blog.example.com/posts/1")
    );
    let summary_only = &data.entries[1];
    assert!(summary_only.raw_html.is_none() && summary_only.content_present);
    assert_eq!(summary_only.published_at, None);
    assert_eq!(summary_only.summary, "只有摘要内容");
    let link_only = &data.entries[2];
    assert!(link_only.title.starts_with("未命名"));
    let weak = &data.entries[3];
    assert!(weak.weak);
    assert!(weak.identity.starts_with("weak:"));
    assert!(weak.original_url.is_none());
}

#[test]
fn sanitized_content_registers_images_and_strips_scripts() {
    let data = cleaned(RSS);
    let first = &data.entries[0];
    assert_eq!(first.content_status, "cached");
    let html = first.content_html.as_deref().unwrap();
    assert!(html.contains("第一段"));
    assert!(!html.contains("script"));
    assert!(!html.contains("onclick"));
    assert_eq!(first.images.len(), 1);
    assert_eq!(first.images[0].1, "https://blog.example.com/img/one.png");
    assert!(html.contains(&first.images[0].0));
    assert!(!html.contains("/img/one.png"));
    // document_key 随内容变化，供前端判断正文是否需要重新拉取。
    assert!(!first.document_key.is_empty());
    let link_only = &data.entries[2];
    assert_eq!(link_only.content_status, "none");
    assert!(link_only.content_html.is_none());
}

#[test]
fn atom_xhtml_and_html_content_both_parse() {
    let data = parsed(ATOM);
    assert_eq!(data.entries.len(), 4);
    let xhtml = &data.entries[0];
    assert!(xhtml.raw_html.is_some());
    assert_eq!(xhtml.published_at, Some(ts("2026-10-02T09:11:35Z")));
    let html = &data.entries[1];
    assert!(html.raw_html.is_some());
    // +08:00 时区折算成 UTC 时间戳。
    assert_eq!(html.published_at, Some(ts("2026-10-02T00:00:00Z")));
    let summary_only = &data.entries[2];
    assert!(summary_only.raw_html.is_none() && summary_only.content_present);
    let text_content = &data.entries[3];
    // type="text"（含缺省）按摘要语义展示，不冒充富文本正文。
    assert!(text_content.raw_html.is_none() && text_content.content_present);
    assert_eq!(text_content.summary, "普通文本");

    let cleaned = cleaned(ATOM);
    let xhtml = &cleaned.entries[0];
    assert_eq!(xhtml.content_status, "cached");
    assert!(xhtml.content_html.as_deref().unwrap().contains("第一段"));
    assert_eq!(xhtml.images.len(), 1);
    assert_eq!(xhtml.images[0].1, "https://blog.example.com/x.png");
}

#[test]
fn guid_identity_ignores_link_changes_and_weak_ids_dedup() {
    let (feed_url, document_url) = urls();
    let first = parse_feed(&feed_url, &document_url, RSS.as_bytes()).unwrap();
    // 同 guid 不同原文 URL：身份不变。
    let mutated = RSS.replace("posts/1</link>", "posts/1?from=web</link>");
    let second = parse_feed(&feed_url, &document_url, mutated.as_bytes()).unwrap();
    assert_eq!(first.entries[0].identity, second.entries[0].identity);
    // 两个无身份条目同键：完全同键去重（弱身份已知限制）。
    let weak_pair = r#"<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
        <item><title>同名</title><pubDate>Fri, 02 Oct 2026 08:00:00 GMT</pubDate></item>
        <item><title>同名</title><pubDate>Fri, 02 Oct 2026 08:00:00 GMT</pubDate></item>
        </channel></rss>"#;
    let data = parse_feed(&feed_url, &document_url, weak_pair.as_bytes()).unwrap();
    assert_eq!(data.entries.len(), 1);
    assert!(data.entries[0].weak);
}

#[test]
fn scan_budget_marks_truncation() {
    let mut xml =
        String::from(r#"<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>"#);
    for index in 0..(MAX_ENTRIES_SCAN + 5) {
        xml.push_str(&format!(
            "<item><title>条目{index}</title><guid>g{index}</guid></item>"
        ));
    }
    xml.push_str("</channel></rss>");
    let data = parsed(&xml);
    assert_eq!(data.entries.len(), MAX_ENTRIES_SCAN);
    assert!(data.scan_truncated);
}

#[test]
fn timestamps_accept_rss_and_atom_formats() {
    let (feed_url, document_url) = urls();
    let xml = r#"<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
        <item><guid>a</guid><pubDate>Thu, 22 Oct 2026 08:00:00 GMT</pubDate><description>x</description></item>
        <item><guid>b</guid><pubDate>Thu, 22 Oct 2026 16:00:00 +0800</pubDate><description>x</description></item>
        <item><guid>c</guid><pubDate>完全无效</pubDate><description>x</description></item>
        </channel></rss>"#;
    let data = parse_feed(&feed_url, &document_url, xml.as_bytes()).unwrap();
    // +0800 的 16:00 与 GMT 的 08:00 是同一时刻；期望值用另一种格式交叉核对。
    let expected = ts("2026-10-22T08:00:00Z");
    assert_eq!(data.entries[0].published_at, Some(expected));
    assert_eq!(data.entries[1].published_at, Some(expected));
    assert_eq!(data.entries[2].published_at, None);
}

fn ts(value: &str) -> i64 {
    use time::format_description::well_known::Rfc3339;
    time::OffsetDateTime::parse(value, &Rfc3339)
        .unwrap()
        .unix_timestamp()
}

#[tokio::test]
async fn sync_entry_state_pagination_and_image_target() {
    let (ctx, dir) = context().await;
    let (feed_url, _) = urls();
    let ids = sync_fixture(&ctx).await;
    let feed_id = parse::feed_id(&feed_url);

    let summaries = store::feed_summaries(&ctx).await.unwrap();
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].id, feed_id);
    assert_eq!(summaries[0].unread, ids.len() as i64);
    assert!(summaries[0].subscribed);

    let page = store::entries_page(&ctx, Some(&feed_id), false, false, None, 2)
        .await
        .unwrap();
    assert_eq!(page.rows.len(), 2);
    let cursor = page.next_cursor.clone().unwrap();
    let next = store::entries_page(
        &ctx,
        Some(&feed_id),
        false,
        false,
        parse_cursor(&cursor).ok(),
        2,
    )
    .await
    .unwrap();
    assert_eq!(next.rows.len(), 2);
    assert_ne!(page.rows[0].id, next.rows[0].id);

    store::set_state(&ctx.db, &ids[0], true, true)
        .await
        .unwrap();
    let unread = store::entries_page(&ctx, Some(&feed_id), true, false, None, 100)
        .await
        .unwrap();
    assert_eq!(unread.rows.len() as i64, ids.len() as i64 - 1);
    let starred = store::entries_page(&ctx, Some(&feed_id), false, true, None, 100)
        .await
        .unwrap();
    assert_eq!(starred.rows.len(), 1);
    let summaries = store::feed_summaries(&ctx).await.unwrap();
    assert_eq!(summaries[0].unread, ids.len() as i64 - 1);

    let (detail, images) = store::entry_detail(&ctx, &ids[0]).await.unwrap().unwrap();
    assert!(detail.is_read && detail.starred);
    assert_eq!(detail.content_status, "cached");
    assert!(detail.content_html.as_deref().unwrap().contains("第一段"));
    assert_eq!(images.len(), 1);
    let target = store::image_source(&ctx, &ids[0], &images[0].0)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(target, "https://blog.example.com/img/one.png");
    assert!(
        store::image_source(&ctx, &ids[0], "ffffffffffffffffffffffffffffffff")
            .await
            .unwrap()
            .is_none()
    );
    cleanup(ctx, dir).await;
}

#[tokio::test]
async fn refresh_merge_replaces_content_but_preserves_user_state() {
    let (ctx, dir) = context().await;
    let (feed_url, _) = urls();
    let ids = sync_fixture(&ctx).await;
    store::set_state(&ctx.db, &ids[0], true, false)
        .await
        .unwrap();

    // 内容更新：同 guid，正文变化 → document_key 更新、旧状态保留。
    let mutated = RSS.replace("第一段", "更新后的第一段");
    let data = cleaned(&mutated);
    let feed_id = parse::feed_id(&feed_url);
    let input = store::SyncInput {
        identity: &identity_for(&feed_url, FEED_URL, &feed_id),
        title: &data.title,
        site_url: data.site_url.as_deref().unwrap_or(""),
        etag: Some("\"v2\""),
        last_modified: None,
        ensure_subscribed: false,
    };
    store::sync_feed(&ctx, &input, &data.entries).await.unwrap();
    let (detail, _) = store::entry_detail(&ctx, &ids[0]).await.unwrap().unwrap();
    assert!(detail
        .content_html
        .as_deref()
        .unwrap()
        .contains("更新后的第一段"));
    assert!(detail.is_read);
    let row = store::find_feed_by_id(&ctx, &feed_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.etag.as_deref(), Some("\"v2\""));

    // 取消订阅保留内容与状态；重新订阅原位恢复。
    store::set_subscribed(&ctx, &feed_id, false).await.unwrap();
    let summaries = store::feed_summaries(&ctx).await.unwrap();
    assert!(!summaries[0].subscribed);
    let (detail, _) = store::entry_detail(&ctx, &ids[0]).await.unwrap().unwrap();
    assert!(detail.content_html.is_some());
    store::set_subscribed(&ctx, &feed_id, true).await.unwrap();

    // 显式删除清除全部数据。
    store::delete_feed(&ctx, &feed_id).await.unwrap();
    assert!(store::feed_summaries(&ctx).await.unwrap().is_empty());
    assert!(store::entry_detail(&ctx, &ids[0]).await.unwrap().is_none());
    cleanup(ctx, dir).await;
}

#[tokio::test]
async fn feed_cap_rejects_the_two_hundred_first_source() {
    let (ctx, dir) = context().await;
    let empty: Vec<CleanEntry> = Vec::new();
    for index in 0..super::MAX_FEEDS {
        let url = Url::parse(&format!("https://cap.example.com/{index}/feed.xml")).unwrap();
        let feed_id = parse::feed_id(&url);
        let input = store::SyncInput {
            identity: &identity_for(&url, url.as_str(), &feed_id),
            title: "cap",
            site_url: "",
            etag: None,
            last_modified: None,
            ensure_subscribed: true,
        };
        store::sync_feed(&ctx, &input, &empty).await.unwrap();
    }
    let over = Url::parse("https://cap.example.com/over/feed.xml").unwrap();
    let feed_id = parse::feed_id(&over);
    let input = store::SyncInput {
        identity: &identity_for(&over, over.as_str(), &feed_id),
        title: "over",
        site_url: "",
        etag: None,
        last_modified: None,
        ensure_subscribed: true,
    };
    let error = store::sync_feed(&ctx, &input, &empty).await.unwrap_err();
    assert_eq!(error.code, "reader_storage_full");
    cleanup(ctx, dir).await;
}

#[tokio::test]
async fn refresh_error_records_last_error_and_ttl_merges_requests() {
    let (ctx, dir) = context().await;
    let ids = sync_fixture(&ctx).await;
    let (feed_url, _) = urls();
    let feed_id = parse::feed_id(&feed_url);

    // TTL 内的合并刷新：不发网络请求，直接复用已落库内容。
    let fresh = refresh(&ctx, &feed_id, false).await.unwrap();
    assert_eq!(fresh.synced, 0);
    assert!(!fresh.not_modified);
    assert!(fresh.fetched_at > 0);

    // 强制刷新打到必然被拒绝的地址：错误原样返回并记录 last_error。
    sqlx::query(
        "UPDATE reader_feeds SET feed_url = 'http://localhost/unavailable', fetched_at = 0",
    )
    .execute(&ctx.db)
    .await
    .unwrap();
    let error = refresh(&ctx, &feed_id, true).await.unwrap_err();
    assert_eq!(error.code, "bad_request");
    let summaries = store::feed_summaries(&ctx).await.unwrap();
    assert!(summaries[0].last_error.is_some());
    // 旧内容与状态不受刷新失败影响。
    let (detail, _) = store::entry_detail(&ctx, &ids[0]).await.unwrap().unwrap();
    assert!(detail.content_html.is_some());
    cleanup(ctx, dir).await;
}

#[tokio::test]
async fn state_and_detail_guards_reject_bad_ids() {
    let (ctx, dir) = context().await;
    assert!(set_state(&ctx, "短id", true, false).await.is_err());
    assert!(entry_detail(&ctx, "zz").await.is_err());
    assert!(image_target(&ctx, &"a".repeat(40), "短键").await.is_err());
    assert_eq!(
        parse_cursor("not-a-cursor").unwrap_err().code,
        "bad_request"
    );
    cleanup(ctx, dir).await;
}
