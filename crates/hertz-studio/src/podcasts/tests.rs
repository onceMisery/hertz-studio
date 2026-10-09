// SPDX-License-Identifier: MIT

use super::*;
use reqwest::Url;
use std::time::Duration;

const FEED: &str = "https://example.com/podcast/feed.xml";
const RSS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:p="http://www.itunes.com/dtds/podcast-1.0.dtd"
 xmlns:content="http://purl.org/rss/1.0/modules/content/">
 <channel><title><![CDATA[中文 <b>故事</b>]]></title><p:author>主持人甲</p:author>
 <description><![CDATA[<p>第一段 &amp; 第二段</p><script>alert(1)</script>]]></description>
 <p:image href="https://example.com/show.jpg"/>
 <item><title><![CDATA[第一集：茶 & 故事]]></title><guid>任意 GUID: 第一集/一</guid>
   <p:duration>01:43:35</p:duration><pubDate>Fri, 02 Oct 2026 09:11:35 GMT</pubDate>
   <content:encoded><![CDATA[<p>中文简介<br/>下一行</p>]]></content:encoded>
   <enclosure url="https://example.com/one.m4a?token=old" type="audio/mp4" length="1"/>
 </item>
 <item><title>第二集</title><guid>https://publisher.example.org/?p=2</guid><p:duration>2589</p:duration>
   <p:author>嘉宾乙</p:author><enclosure url="../two.mp3" type="audio/mpeg" length="99999999999"/>
 </item>
 <item><title>第三集</title><p:duration>1:01:44</p:duration>
   <enclosure url="https://example.com/three.m4a" type="audio/x-m4a"/>
 </item>
 <item><title>仅文稿</title><description>没有音频</description></item>
 <item><title>图片附件</title><enclosure url="https://example.com/image.jpg" type="image/jpeg"/></item>
 </channel></rss>"#;

fn parsed(xml: &str) -> ParsedFeed {
    let url = Url::parse(FEED).unwrap();
    parse_feed(&url, &url, xml.as_bytes()).expect("valid public podcast RSS")
}

async fn context() -> (online::Ctx, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("hertz-podcasts-{}", uuid::Uuid::new_v4()));
    let db = vmusic_store::open(&dir).await.unwrap();
    (online::Ctx { db }, dir)
}

async fn cleanup(ctx: online::Ctx, dir: std::path::PathBuf) {
    ctx.db.close().await;
    drop(ctx);
    // Windows 的 SQLite worker 可能稍后才释放 WAL 句柄；清理不属于业务断言。
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[test]
fn rss_preserves_chinese_cdata_and_namespaces_with_audio_only_entries() {
    let result = parsed(RSS);
    assert_eq!(result.show.title, "中文 故事");
    assert_eq!(result.show.author, "主持人甲");
    assert_eq!(result.show.description, "第一段 & 第二段");
    assert_eq!(result.show.episode_count, 3);
    assert_eq!(result.episodes.len(), 3);
    let first = &result.episodes[0].episode;
    assert_eq!(first.track.title, "第一集：茶 & 故事");
    assert_eq!(first.description, "中文简介 下一行");
    assert_eq!(first.track.album, "中文 故事");
    assert_eq!(first.track.source, "podcast");
    assert_eq!(
        first.track.cover.as_deref(),
        Some("https://example.com/show.jpg")
    );
    assert!(first.track.playable);
    assert!(!first.track.vip_only);
    assert_eq!(first.published_at, "Fri, 02 Oct 2026 09:11:35 GMT");
    assert_eq!(
        result.episodes[1].enclosure_url,
        "https://example.com/two.mp3"
    );
    assert_eq!(result.episodes[1].episode.track.artist, "嘉宾乙");
}

#[test]
fn rss_duration_supports_seconds_and_hms_without_trusting_enclosure_length() {
    let result = parsed(RSS);
    let durations: Vec<_> = result
        .episodes
        .iter()
        .map(|e| e.episode.track.duration_ms)
        .collect();
    assert_eq!(durations, [6_215_000, 2_589_000, 3_704_000]);
    assert_eq!(
        parsed(&RSS.replace("01:43:35", "43:09")).episodes[0]
            .episode
            .track
            .duration_ms,
        2_589_000
    );
    for invalid in [
        "",
        "unknown",
        "1:99:00",
        "18446744073709551615",
        "-1",
        "1:2:3:4",
    ] {
        let xml = RSS.replace("01:43:35", invalid);
        assert_eq!(
            parsed(&xml).episodes[0].episode.track.duration_ms,
            0,
            "{invalid}"
        );
    }
}

#[test]
fn feed_rejects_html_malformed_xml_and_dtd() {
    let url = Url::parse(FEED).unwrap();
    for invalid in [
        "<html><body>Forbidden</body></html>",
        "<rss><channel>",
        "<!DOCTYPE rss [<!ENTITY bomb 'boom'>]><rss><channel><title>&bomb;</title></channel></rss>",
    ] {
        let error = parse_feed(&url, &url, invalid.as_bytes()).expect_err("invalid feed");
        assert_eq!(error.code, "podcast_invalid_feed");
    }
}

#[test]
fn feed_enforces_bytes_nodes_entries_and_description_budgets() {
    let url = Url::parse(FEED).unwrap();
    let oversized = vec![b' '; MAX_FEED_BYTES + 1];
    assert_eq!(
        parse_feed(&url, &url, &oversized).unwrap_err().code,
        "podcast_feed_too_large"
    );
    let many_nodes = format!(
        "<rss><channel><title>x</title>{}</channel></rss>",
        "<a/>".repeat(MAX_XML_NODES as usize)
    );
    assert_eq!(
        parse_feed(&url, &url, many_nodes.as_bytes())
            .unwrap_err()
            .code,
        "podcast_invalid_feed"
    );
    let mut xml = String::from("<rss><channel><title>多集</title><description>");
    xml.push_str(&"中文".repeat(MAX_DESCRIPTION_CHARS));
    xml.push_str("</description>");
    for n in 0..MAX_EPISODES + 3 {
        xml.push_str(&format!("<item><title>{n}</title><enclosure type='audio/mpeg' url='https://example.com/{n}.mp3'/></item>"));
    }
    xml.push_str("</channel></rss>");
    let result = parsed(&xml);
    assert_eq!(result.episodes.len(), MAX_EPISODES);
    assert_eq!(result.show.episode_count, MAX_EPISODES);
    assert!(result.show.description.chars().count() <= MAX_DESCRIPTION_CHARS);
}

#[test]
fn atom_accepts_public_audio_enclosures_and_rejects_local_or_live_links() {
    let result = parsed(
        r#"<feed xmlns="http://www.w3.org/2005/Atom"><title>原子节目</title>
      <author><name>作者</name></author><subtitle>节目说明</subtitle>
      <entry><id>tag:example.com,2026:1</id><title>单集</title><published>2026-10-08T10:00:00Z</published>
        <summary type="html">&lt;p&gt;简介&lt;/p&gt;</summary>
        <link rel="enclosure" type="audio/mpeg" href="audio.mp3"/></entry>
      <entry><title>内网</title><link rel="enclosure" type="audio/mpeg" href="http://127.0.0.1/a.mp3"/></entry>
      <entry><title>直播</title><link rel="enclosure" type="audio/x-mpegurl" href="https://example.com/live.m3u8"/></entry>
    </feed>"#,
    );
    assert_eq!(result.show.title, "原子节目");
    assert_eq!(result.episodes.len(), 1);
    assert_eq!(
        result.episodes[0].enclosure_url,
        "https://example.com/podcast/audio.mp3"
    );
    assert_eq!(result.episodes[0].episode.description, "简介");
    assert_eq!(result.episodes[0].episode.track.duration_ms, 0);
}

#[test]
fn stable_identity_uses_canonical_feed_and_guid_not_rotating_audio_urls() {
    let first = parsed(RSS);
    let changed = parsed(&RSS.replace("token=old", "token=new"));
    assert_eq!(
        first.episodes[0].episode.track.id,
        changed.episodes[0].episode.track.id
    );
    assert_ne!(
        first.episodes[0].enclosure_url,
        changed.episodes[0].enclosure_url
    );
    let normalized = public_url(" HTTPS://EXAMPLE.COM:443/podcast/feed.xml#ignored ").unwrap();
    assert_eq!(normalized.as_str(), FEED);
    let equivalent = parse_feed(&normalized, &normalized, RSS.as_bytes()).unwrap();
    assert_eq!(first.show.id, equivalent.show.id);
    assert_eq!(
        first.episodes[0].episode.track.id,
        equivalent.episodes[0].episode.track.id
    );
    let other_url = Url::parse("https://example.com/other.xml").unwrap();
    let other = parse_feed(&other_url, &other_url, RSS.as_bytes()).unwrap();
    assert_ne!(
        first.episodes[0].episode.track.id,
        other.episodes[0].episode.track.id
    );
    let fallback_changed = parsed(&RSS.replace("three.m4a", "replacement.m4a"));
    assert_ne!(
        first.episodes[2].episode.track.id,
        fallback_changed.episodes[2].episode.track.id
    );
}

#[test]
fn directory_returns_shows_and_discards_invalid_feed_urls() {
    let shows = directory_shows(serde_json::json!({"results": [
        {"collectionName": "<b>故事FM</b>", "artistName": "主持人", "feedUrl": "https://feeds.storyfm.cn/storyfm.xml", "artworkUrl600": "https://example.com/art.jpg", "trackCount": 77},
        {"trackName": "另一个节目", "feedUrl": "https://example.com/rss"},
        {"collectionName": "内网", "feedUrl": "http://127.0.0.1/rss"},
        {"collectionName": "无RSS"}
    ]})).unwrap();
    assert_eq!(shows.len(), 2);
    assert_eq!(shows[0].title, "故事FM");
    assert_eq!(shows[0].episode_count, 77);
    assert_eq!(shows[1].title, "另一个节目");
    assert!(directory_shows(serde_json::json!({"error": "rate limited"})).is_err());
}

#[test]
fn search_cache_expires_and_stays_bounded() {
    let mut cache = SearchCache::default();
    let now = Instant::now();
    let show = parsed(RSS).show;
    cache.insert("故事:20".into(), vec![show.clone()], now);
    assert_eq!(cache.get("故事:20", now).unwrap()[0].title, show.title);
    assert!(cache
        .get("故事:20", now + Duration::from_secs(CACHE_TTL_SECS + 1))
        .is_none());
    for n in 0..SEARCH_CACHE_CAP + 1 {
        cache.insert(
            n.to_string(),
            vec![show.clone()],
            now + Duration::from_millis(n as u64),
        );
    }
    assert_eq!(cache.len(), SEARCH_CACHE_CAP);
    assert!(cache.get("0", now).is_none());
}

#[tokio::test]
async fn imported_episodes_survive_restart_unsubscribe_and_pagination() {
    let (ctx, dir) = context().await;
    let result = parsed(RSS);
    let id = result.episodes[0].episode.track.id.clone();
    persist_feed(&ctx, &result).await.unwrap();
    let page = feed(&ctx, FEED, 1, 2, false).await.unwrap();
    assert_eq!(
        serde_json::to_value(&page).unwrap().get("episode_limit"),
        Some(&serde_json::json!(MAX_EPISODES)),
        "收录上限必须由后端随分页返回，供前端准确显示容量提示"
    );
    assert_eq!(page.total, 3);
    assert_eq!(page.episodes.len(), 2);
    assert_eq!(page.episodes[0].track.title, "第二集");
    assert!(feed(&ctx, FEED, usize::MAX, 2, false)
        .await
        .unwrap()
        .episodes
        .is_empty());
    let show = subscribe(&ctx, FEED).await.unwrap();
    assert!(show.subscribed);
    assert_eq!(subscriptions(&ctx).await.unwrap().len(), 1);
    unsubscribe(&ctx, &show.id).await.unwrap();
    assert!(subscriptions(&ctx).await.unwrap().is_empty());
    ctx.db.close().await;
    let ctx = online::Ctx {
        db: vmusic_store::open(&dir).await.unwrap(),
    };
    let detail = episode_detail(&ctx, &id).await.unwrap();
    assert_eq!(detail.title, "第一集：茶 & 故事");
    assert_eq!(detail.source, "podcast");
    let stream = episode_stream(&ctx, &id).await.unwrap();
    assert_eq!(stream.url, "https://example.com/one.m4a?token=old");
    assert_eq!(stream.bitrate, None);
    assert!(stream.fallbacks.is_empty());
    cleanup(ctx, dir).await;
}

#[tokio::test]
async fn refresh_updates_signed_urls_but_preserves_old_queue_id_and_subscription() {
    let (ctx, dir) = context().await;
    let first = parsed(RSS);
    let id = first.episodes[0].episode.track.id.clone();
    let removed_id = first.episodes[1].episode.track.id.clone();
    persist_feed(&ctx, &first).await.unwrap();
    subscribe(&ctx, FEED).await.unwrap();
    let mut refreshed = parsed(&RSS.replace("token=old", "token=new"));
    refreshed.episodes.truncate(1);
    refreshed.show.episode_count = 1;
    persist_feed(&ctx, &refreshed).await.unwrap();
    let page = feed(&ctx, FEED, 0, 20, false).await.unwrap();
    assert_eq!(page.total, 1);
    assert!(page.show.subscribed);
    assert_eq!(
        episode_stream(&ctx, &id).await.unwrap().url,
        "https://example.com/one.m4a?token=new"
    );
    assert_eq!(
        episode_detail(&ctx, &removed_id).await.unwrap().title,
        "第二集"
    );
    cleanup(ctx, dir).await;
}

#[tokio::test]
async fn failed_refresh_rolls_back_show_metadata_and_episode_visibility() {
    let (ctx, dir) = context().await;
    persist_feed(&ctx, &parsed(RSS)).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_refresh BEFORE INSERT ON podcast_episodes WHEN NEW.title = 'reject' BEGIN SELECT RAISE(ABORT, 'forced'); END")
        .execute(&ctx.db).await.unwrap();
    let mut refreshed = parsed(&RSS.replace("token=old", "token=new"));
    refreshed.show.title = "失败刷新".into();
    refreshed.episodes[1].episode.track.title = "reject".into();
    assert!(persist_feed(&ctx, &refreshed).await.is_err());
    let page = feed(&ctx, FEED, 0, 20, false).await.unwrap();
    assert_eq!(page.show.title, "中文 故事");
    assert_eq!(page.total, 3);
    assert_eq!(page.episodes.len(), 3);
    assert_eq!(
        episode_stream(&ctx, &page.episodes[0].track.id)
            .await
            .unwrap()
            .url,
        "https://example.com/one.m4a?token=old"
    );
    cleanup(ctx, dir).await;
}

#[tokio::test]
async fn feed_page_keeps_one_snapshot_when_refresh_commits_between_its_reads() {
    let (ctx, dir) = context().await;
    persist_feed(&ctx, &parsed(RSS)).await.unwrap();
    // 独立连接池保证刷新提交来自另一个 SQLite 连接。
    let writer = online::Ctx {
        db: vmusic_store::open(&dir).await.unwrap(),
    };
    let page_read = store::begin_page(&ctx, FEED).await.unwrap();
    let mut refreshed = parsed(&RSS.replace("第一集：茶 & 故事", "刷新后的第一集"));
    refreshed.episodes.truncate(1);
    refreshed.show.title = "刷新后的节目".into();
    refreshed.show.episode_count = 1;
    persist_feed(&writer, &refreshed).await.unwrap();

    let page = page_read.finish(0, 20).await.unwrap();
    assert_eq!(page.episode_limit, MAX_EPISODES);
    assert_eq!(page.show.title, "中文 故事");
    assert_eq!(page.total, 3);
    assert_eq!(page.episodes.len(), 3, "总数与单集必须来自同一个数据库快照");
    assert_eq!(page.episodes[0].track.title, "第一集：茶 & 故事");

    let next_page = feed(&ctx, FEED, 0, 20, false).await.unwrap();
    assert_eq!(next_page.total, 1);
    assert_eq!(next_page.show.title, "刷新后的节目");
    assert_eq!(next_page.episodes[0].track.title, "刷新后的第一集");
    writer.db.close().await;
    cleanup(ctx, dir).await;
}

#[tokio::test]
async fn invalid_inputs_are_rejected_before_network_and_missing_ids_are_not_found() {
    let (ctx, dir) = context().await;
    assert_eq!(
        search(&ctx, "  ", 20).await.unwrap_err().code,
        "bad_request"
    );
    assert_eq!(
        search(&ctx, &"字".repeat(121), 20).await.unwrap_err().code,
        "bad_request"
    );
    assert_eq!(
        feed(&ctx, "http://127.0.0.1/rss", 0, 20, true)
            .await
            .unwrap_err()
            .code,
        "bad_request"
    );
    assert_eq!(
        episode_detail(&ctx, &"0".repeat(40))
            .await
            .unwrap_err()
            .code,
        "not_found"
    );
    assert_eq!(
        episode_stream(&ctx, &"0".repeat(40))
            .await
            .unwrap_err()
            .code,
        "not_found"
    );
    assert_eq!(
        unsubscribe(&ctx, &"0".repeat(40)).await.unwrap_err().code,
        "not_found"
    );
    cleanup(ctx, dir).await;
}

#[tokio::test]
async fn stale_refresh_failure_keeps_the_saved_episode_replayable() {
    let (ctx, dir) = context().await;
    let parsed = parsed(RSS);
    let id = parsed.episodes[0].episode.track.id.clone();
    persist_feed(&ctx, &parsed).await.unwrap();
    // 将重拉目标设成确定会被拒绝的地址，避免测试依赖公网可用性。
    sqlx::query(
        "UPDATE podcast_shows SET fetched_at = 0, feed_url = 'http://localhost/unavailable'",
    )
    .execute(&ctx.db)
    .await
    .unwrap();
    let stream = episode_stream(&ctx, &id).await.unwrap();
    assert_eq!(stream.url, "https://example.com/one.m4a?token=old");
    assert_eq!(
        episode_detail(&ctx, &id).await.unwrap().duration_ms,
        6_215_000
    );
    cleanup(ctx, dir).await;
}

fn blocked_refresh(
    dropped: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> impl std::future::Future<Output = ApiResult<FeedPage>> {
    struct OnDrop(std::sync::Arc<std::sync::atomic::AtomicBool>);
    impl Drop for OnDrop {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    async move {
        let _guard = OnDrop(dropped);
        std::future::pending().await
    }
}

#[tokio::test]
async fn optional_refresh_timeout_returns_saved_url_and_drops_the_slow_future() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let (ctx, dir) = context().await;
    let parsed = parsed(RSS);
    let id = parsed.episodes[0].episode.track.id.clone();
    persist_feed(&ctx, &parsed).await.unwrap();
    sqlx::query("UPDATE podcast_shows SET fetched_at = 0")
        .execute(&ctx.db)
        .await
        .unwrap();
    let row = store::get_episode(&ctx, &id).await.unwrap();
    let dropped = Arc::new(AtomicBool::new(false));
    let stream = tokio::time::timeout(
        Duration::from_secs(5),
        stream_from_saved(&ctx, &id, row, blocked_refresh(dropped.clone())),
    )
    .await
    .expect("可选刷新必须先超时，让保存URL在调用者总预算内返回")
    .unwrap();
    assert_eq!(stream.url, "https://example.com/one.m4a?token=old");
    assert_eq!(stream.bitrate, None);
    assert!(dropped.load(Ordering::SeqCst), "超时的刷新future必须已取消");
    cleanup(ctx, dir).await;
}

#[tokio::test]
async fn cancelling_stream_also_drops_the_optional_refresh() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let (ctx, dir) = context().await;
    let parsed = parsed(RSS);
    let id = parsed.episodes[0].episode.track.id.clone();
    persist_feed(&ctx, &parsed).await.unwrap();
    sqlx::query("UPDATE podcast_shows SET fetched_at = 0")
        .execute(&ctx.db)
        .await
        .unwrap();
    let row = store::get_episode(&ctx, &id).await.unwrap();
    let dropped = Arc::new(AtomicBool::new(false));
    let result = tokio::time::timeout(
        Duration::from_millis(20),
        stream_from_saved(&ctx, &id, row, blocked_refresh(dropped.clone())),
    )
    .await;
    assert!(result.is_err());
    assert!(dropped.load(Ordering::SeqCst), "调用者取消应传递到可选刷新");
    cleanup(ctx, dir).await;
}

#[tokio::test]
async fn response_reader_rejects_oversize_headers_and_chunked_bodies() {
    use axum::{
        body::{Body, Bytes},
        response::Response,
        routing::get,
    };
    let app = axum::Router::new()
        .route("/length", get(|| async { "x".repeat(64) }))
        .route(
            "/chunked",
            get(|| async {
                let chunks = vec![
                    Ok::<_, std::io::Error>(Bytes::from(vec![b'x'; 24])),
                    Ok(Bytes::from(vec![b'y'; 24])),
                ];
                Response::new(Body::from_stream(futures::stream::iter(chunks)))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    for path in ["length", "chunked"] {
        let response = client
            .get(format!("http://{addr}/{path}"))
            .send()
            .await
            .unwrap();
        let error = network::read_bounded(response, 32, parse::feed_too_large)
            .await
            .unwrap_err();
        assert_eq!(error.code, "podcast_feed_too_large", "{path}");
    }
    server.abort();
}

#[tokio::test]
#[ignore = "访问 Apple 目录、三份真实中文 RSS，并只读取音频的第一个 Range 块"]
async fn live_chinese_directory_feeds_and_public_audio_ranges() {
    let (ctx, dir) = context().await;
    let results = search(&ctx, "故事FM", 3).await.unwrap();
    assert!(!results.shows.is_empty());
    println!("directory: {} shows", results.shows.len());
    for url in [
        "https://feed.xyzfm.space/cv4bkgpuglwp",
        "https://feeds.storyfm.cn/storyfm.xml",
        "https://feeds.fireside.fm/shengdongjixi/rss",
    ] {
        let page = feed(&ctx, url, 0, 2, true).await.unwrap();
        assert!(!page.episodes.is_empty());
        assert!(page.episodes[0].track.duration_ms > 0);
        let stream = episode_stream(&ctx, &page.episodes[0].track.id)
            .await
            .unwrap();
        let mut response = public_client()
            .unwrap()
            .get(public_url(&stream.url).unwrap())
            .header(reqwest::header::RANGE, "bytes=0-1023")
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        let host = response.url().host_str().unwrap().to_string();
        let bytes = response.chunk().await.unwrap().unwrap();
        assert!(!bytes.is_empty());
        println!(
            "{}: {} episodes; first {} ms; audio {} from {}",
            page.show.title,
            page.total,
            page.episodes[0].track.duration_ms,
            response.status().as_u16(),
            host
        );
    }
    cleanup(ctx, dir).await;
}

#[test]
fn parser_limits_raw_allocation_markers_before_xml_tree_allocation() {
    let url = Url::parse(FEED).unwrap();
    for marker in ['=', '<'] {
        let xml = format!("<rss><channel><title>预算</title><description><![CDATA[{}]]></description></channel></rss>", marker.to_string().repeat(MAX_XML_NODES as usize + 1));
        assert_eq!(
            parse_feed(&url, &url, xml.as_bytes()).err().map(|e| e.code),
            Some("podcast_invalid_feed")
        );
    }
}

#[test]
fn parser_handles_unclosed_hidden_markup_within_a_bounded_time() {
    let xml = format!("<rss><channel><title>预算</title><description><![CDATA[<script>{}{}]]></description></channel></rss>", "<".repeat(65_536), "x".repeat(4 * 1024 * 1024));
    let start = Instant::now();
    let result = parsed(&xml);
    assert!(result.show.description.is_empty());
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "合法的4MiB恶意CDATA应在线性时间处理，实际 {:?}",
        start.elapsed()
    );
}

#[test]
fn xml_shape_budget_rejects_excess_attributes_on_a_single_element() {
    let attrs = (0..129)
        .map(|n| format!(" a{n}='value > quoted'"))
        .collect::<String>();
    let xml = format!("<rss{attrs}><channel><title>预算</title></channel></rss>");
    let url = Url::parse(FEED).unwrap();
    assert_eq!(
        parse_feed(&url, &url, xml.as_bytes()).err().map(|e| e.code),
        Some("podcast_invalid_feed")
    );
}

#[test]
fn xml_shape_budget_rejects_deep_trees_and_namespace_inheritance_expansion() {
    let deep = format!(
        "<rss><channel><title>预算</title>{}{}</channel></rss>",
        "<a>".repeat(65),
        "</a>".repeat(65)
    );
    let root_ns = (0..40)
        .map(|n| format!(" xmlns:p{n}='urn:{n}'"))
        .collect::<String>();
    let child_ns = (40..70)
        .map(|n| format!(" xmlns:p{n}='urn:{n}'"))
        .collect::<String>();
    let namespaces =
        format!("<rss{root_ns}><channel><title>预算</title><a{child_ns}/></channel></rss>");
    let url = Url::parse(FEED).unwrap();
    for xml in [deep, namespaces] {
        assert_eq!(
            parse_feed(&url, &url, xml.as_bytes()).err().map(|e| e.code),
            Some("podcast_invalid_feed")
        );
    }
}

#[test]
fn xml_shape_budget_rejects_unbounded_namespace_declarations_across_siblings() {
    let nodes = (0..4097)
        .map(|n| format!("<a xmlns:p='urn:{n}'/>"))
        .collect::<String>();
    let xml = format!("<rss><channel><title>预算</title>{nodes}</channel></rss>");
    let url = Url::parse(FEED).unwrap();
    assert_eq!(
        parse_feed(&url, &url, xml.as_bytes()).err().map(|e| e.code),
        Some("podcast_invalid_feed")
    );
}
