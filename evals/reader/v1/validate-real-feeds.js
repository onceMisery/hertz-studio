#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Real-network validation for the reader domain: isolated service, real public
// feeds curated by https://jackyst0.github.io/awesome-rsshub-routes/ (feeds.opml).
// No API keys, no accounts; feeds are fetched by the service's public_net path.
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..', '..');

// 全部来自 awesome-rsshub-routes 的 feeds.opml；expect: error = 本机环境不可达，
// 用来验证失败语义（错误上抛、last_error、不产生半截数据）。
const FEEDS = [
  { name: 'OpenAI News', url: 'https://openai.com/news/rss.xml', expect: 'feed' },
  { name: 'arXiv cs.AI', url: 'https://rss.arxiv.org/rss/cs.AI', expect: 'feed', allowEmpty: true },
  { name: 'Hacker News AI', url: 'https://hnrss.org/newest?q=AI', expect: 'feed' },
  { name: 'A List Apart', url: 'https://alistapart.com/main/feed/', expect: 'feed' },
  { name: 'Claude Code Releases', url: 'https://github.com/anthropics/claude-code/releases.atom', expect: 'feed' },
  { name: '少数派', url: 'https://sspai.com/feed', expect: 'feed' },
  { name: 'IT之家', url: 'https://www.ithome.com/rss/', expect: 'feed' },
  { name: 'FreeBuf', url: 'https://www.freebuf.com/feed', expect: 'feed' },
  { name: 'DeepMind Blog', url: 'https://deepmind.google/blog/rss.xml', expect: 'feed' },
  { name: 'This Week in Rust', url: 'https://this-week-in-rust.org/atom.xml', expect: 'feed' },
  { name: 'V2EX', url: 'https://www.v2ex.com/index.xml', expect: 'error' },
  { name: 'LinuxDo', url: 'https://linux.do/latest.rss', expect: 'error' },
  { name: '非 RSS 地址', url: 'https://example.com/feed', expect: 'error' },
];

async function main() {
  const binary = process.env.HERTZ_BIN || path.join(root, 'target', 'release',
    process.platform === 'win32' ? 'hertz-studio.exe' : 'hertz-studio');
  assert.ok(fs.existsSync(binary), 'service binary must exist: ' + binary);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hertz-reader-real-'));
  const child = spawn(binary, ['--bind', '127.0.0.1', '--port', '0', '--data-dir', dataDir], {
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, VMUSIC_BACKEND: 'null', VMUSIC_SECRETS: 'memory', VMUSIC_LOG: 'error' },
  });
  let base = null;
  let token = null;
  try {
    const discoveryPath = path.join(dataDir, 'vmusicd.json');
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) throw new Error('service exited: ' + child.exitCode);
      try {
        const value = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
        const health = await fetch('http://127.0.0.1:' + value.port + '/v1/health', { signal: AbortSignal.timeout(500) });
        if (health.ok) { base = 'http://127.0.0.1:' + value.port; token = value.token; break; }
      } catch {}
      await delay(150);
    }
    assert.ok(base, 'service must become healthy');

    const call = async (route, method = 'GET', body) => {
      const started = Date.now();
      const response = await fetch(base + route, {
        method,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
      let payload = null;
      const text = await response.text();
      try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text.slice(0, 400) }; }
      return { status: response.status, payload, ms: Date.now() - started };
    };

    const report = { startedAt: new Date().toISOString(),
      binary: { path: binary, sha256: sha256(binary) },
      service: { dataDir, base }, feeds: [], checks: {} };

    for (const feed of FEEDS) {
      const result = { name: feed.name, url: feed.url, expect: feed.expect };
      report.feeds.push(result);
      // 产品对瞬时网络故障不自动重试（如实上抛）；测试侧重试一次，
      // 用于区分产品缺陷与网络抖动。
      let preview = await call('/v1/reader/preview', 'POST', { feed_url: feed.url });
      if (preview.status !== 200 && preview.payload && preview.payload.error
        && preview.payload.error.code === 'upstream_timeout') {
        await delay(2000);
        preview = await call('/v1/reader/preview', 'POST', { feed_url: feed.url });
        result.previewRetried = true;
      }
      result.preview = { status: preview.status, ms: preview.ms };
      if (feed.expect === 'error') {
        assert.notEqual(preview.status, 200, feed.name + ': unreachable feed must not preview as 200');
        result.errorCode = preview.payload && preview.payload.error && preview.payload.error.code;
        result.errorMessage = preview.payload && preview.payload.error && preview.payload.error.message;
        continue;
      }
      assert.equal(preview.status, 200, feed.name + ': preview status '
        + JSON.stringify(preview.payload && preview.payload.error));
      const body = preview.payload.preview;
      result.title = body.title;
      result.previewEntries = body.entries.length;
      result.scanTruncated = body.scan_truncated;
      assert.ok(body.title, feed.name + ': preview title');
      // arXiv 周末 skipDays 时就是空源；空源订阅/刷新仍须成功。
      if (feed.allowEmpty && body.entries.length === 0) {
        result.emptySource = true;
        const emptySub = await call('/v1/reader/subscriptions', 'POST', { feed_url: feed.url });
        assert.equal(emptySub.status, 200, feed.name + ': empty source subscribes');
        result.ok = true;
        continue;
      }
      assert.ok(body.entries.length >= 1, feed.name + ': preview entries');

      const subscribed = await call('/v1/reader/subscriptions', 'POST', { feed_url: feed.url });
      assert.equal(subscribed.status, 200, feed.name + ': subscribe status');
      result.subscribeMs = subscribed.ms;
      const feedId = subscribed.payload.feed.id;
      assert.match(feedId, /^[0-9a-f]{40}$/, feed.name + ': feed id shape');

      const entries = await call('/v1/reader/entries?feed_id=' + feedId + '&limit=30');
      assert.equal(entries.status, 200, feed.name + ': entries status');
      result.entryCount = entries.payload.items.length;
      result.hasCursor = Boolean(entries.payload.next_cursor);
      assert.ok(result.entryCount >= 1, feed.name + ': entries');
      for (const item of entries.payload.items) {
        assert.equal(item.content_html, undefined, feed.name + ': list must not carry full content');
        assert.ok(item.summary.length <= 280 + 8, feed.name + ': list summary bound');
      }

      const withContent = entries.payload.items.filter(item => item.has_content);
      result.entriesWithContent = withContent.length;
      if (withContent.length) {
        const detail = await call('/v1/reader/entries/' + withContent[0].id);
        assert.equal(detail.status, 200, feed.name + ': detail status');
        const entry = detail.payload.entry;
        result.detailMs = detail.ms;
        result.contentStatus = entry.content_status;
        const html = entry.content_html || '';
        result.contentBytes = html.length;
        assert.ok(!/<script[\s>]/i.test(html), feed.name + ': sanitized, no <script>');
        assert.ok(!/<iframe[\s>]/i.test(html), feed.name + ': sanitized, no <iframe>');
        assert.ok(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(html), feed.name + ': sanitized, no event handlers');
        const sources = [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/gi)].map(match => match[1]);
        result.imgTags = sources.length;
        assert.ok(sources.every(src => /^[0-9a-f]{32}$/.test(src)), feed.name + ': every img src is a registered key');
        const hrefs = [...html.matchAll(/<a[^>]*\shref="([^"]*)"/gi)].map(match => match[1]);
        result.links = hrefs.length;
        assert.ok(hrefs.every(href => /^https?:\/\//i.test(href)), feed.name + ': every href is absolute http(s)');
        result.imageKeys = (entry.images || []).length;
        if (result.imageKeys > 0) {
          const key = entry.images[0].key;
          const image = await call('/v1/reader/entries/' + entry.id + '/images/' + key);
          result.imageProxy = { status: image.status, ms: image.ms };
          if (image.status === 200) {
            result.imageProxy.contentType = image.payload.content_type;
            result.imageProxy.bytes = Math.floor((image.payload.data || '').length * 3 / 4);
            assert.ok(image.payload.content_type.startsWith('image/'), feed.name + ': proxied content type');
            assert.ok(result.imageProxy.bytes > 0 && result.imageProxy.bytes <= 6 * 1024 * 1024,
              feed.name + ': proxied image bound');
          }
        }
      }

      const merged = await call('/v1/reader/feeds/' + feedId + '/refresh', 'POST', { force: false });
      assert.equal(merged.status, 200, feed.name + ': ttl refresh status');
      result.ttlMerged = merged.payload.result;

      const refreshed = await call('/v1/reader/feeds/' + feedId + '/refresh', 'POST', { force: true });
      assert.equal(refreshed.status, 200, feed.name + ': forced refresh status '
        + JSON.stringify(refreshed.payload && refreshed.payload.error) + ' ms=' + refreshed.ms);
      result.forcedRefresh = refreshed.payload.result;

      const first = entries.payload.items[0];
      const unreadBefore = (await call('/v1/reader/subscriptions')).payload.feeds
        .find(row => row.id === feedId).unread;
      const state = await call('/v1/reader/entries/' + first.id + '/state', 'PUT', { is_read: true, starred: true });
      assert.equal(state.status, 200, feed.name + ': state status');
      const unreadAfter = (await call('/v1/reader/subscriptions')).payload.feeds
        .find(row => row.id === feedId).unread;
      result.unreadBefore = unreadBefore;
      result.unreadAfterRead = unreadAfter;
      // 大源（如 OpenAI 全存档 1300+ 条）的未读页会被 limit 截断，按真值总数对差。
      assert.equal(unreadAfter, unreadBefore - 1,
        feed.name + ': unread decrements (before=' + unreadBefore + ', after=' + unreadAfter + ')');
      const unreadPage = await call('/v1/reader/entries?feed_id=' + feedId + '&unread=true&limit=100');
      assert.equal(unreadPage.status, 200, feed.name + ': unread query status');
      assert.ok(unreadPage.payload.items.every(item => !item.is_read), feed.name + ': unread page holds only unread');
      result.ok = true;
    }

    const subscriptions = await call('/v1/reader/subscriptions');
    report.checks.subscriptions = subscriptions.payload.feeds.length;
    report.checks.allStored = FEEDS.filter(f => f.expect === 'feed').length === subscriptions.payload.feeds.length;
    assert.equal(report.checks.subscriptions, FEEDS.filter(f => f.expect === 'feed').length,
      'only reachable feeds persist');
    for (const feed of FEEDS.filter(f => f.expect === 'error')) {
      const stored = subscriptions.payload.feeds.find(row => row.feed_url === feed.url);
      assert.equal(stored, undefined, feed.name + ': failed subscribe leaves no feed row');
    }

    report.finishedAt = new Date().toISOString();
    report.result = 'passed';
    fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('Reader real-feed validation passed across ' +
      report.feeds.filter(f => f.ok).length + ' reachable feeds and ' +
      report.feeds.filter(f => f.expect === 'error').length + ' error paths.');
  } finally {
    child.kill();
    if (base && child.exitCode === null) {
      await delay(300);
      try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch {}
    }
  }
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
