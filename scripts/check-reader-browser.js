#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Shipped reader UI, real DOM, deterministic transport; no public services.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, 'plugin/ui', name), 'utf8');
const html = read('index.html');
const start = html.indexOf('<!-- 阅读 -->');
const end = html.indexOf('<!-- /阅读 -->', start);
assert.ok(start >= 0 && end > start, 'reader view must be shipped');

const ENTRY_CONTENT = '<p onclick="evil()">第一段正文<script>alert(1)</script>'
  + '<a href="https://ok.example.com/src">来源</a><a href="javascript:alert(2)">坏链接</a>'
  + '<img src="__KEY__" alt="图一"><iframe src="https://evil.example.com"></iframe></p>';

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 860 } });
    const errors = [];
    const requests = [];
    page.on('pageerror', err => errors.push(err.message));
    page.on('request', request => requests.push(request.url()));
    await page.route('https://fixture.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await page.goto('https://fixture.test');
    await page.setContent(html.slice(start, end));
    for (const file of ['style.css', 'reader.css']) await page.addStyleTag({ content: read(file) });
    await page.addStyleTag({ content: 'body{padding:20px;overflow:auto}#view-reader{height:780px;width:100%;max-width:1140px;margin:auto}' });
    const imageKey = 'ab'.repeat(16);
    await page.evaluate(key => {
      const feed = (id, title, unread) => ({
        id, title, site_url: 'https://blog.example.com/', feed_url: 'https://blog.example.com/feed.xml',
        subscribed: true, unread, latest_at: 1_792_000_000, fetched_at: 1_792_000_000, last_error: null,
      });
      const entryId = seed => seed.repeat(40).slice(0, 40);
      window.entryId = entryId;
      window.feeds = [feed('a'.repeat(40), '技术快报', 2), feed('b'.repeat(40), '长列表源', 35)];
      window.states = {};
      window.calls = [];
      const baseEntries = [
        { id: entryId('1'), feed_id: 'a'.repeat(40), title: '图文正文一篇', author: '作者甲',
          published_at: 1_791_930_000, original_url: 'https://blog.example.com/posts/1',
          summary: '第一段正文摘要', has_content: true, is_read: false, starred: false },
        { id: entryId('2'), feed_id: 'a'.repeat(40), title: '仅摘要条目', author: '作者乙',
          published_at: null, original_url: 'https://blog.example.com/posts/2',
          summary: '只有摘要内容', has_content: false, is_read: false, starred: false },
      ];
      const longList = Array.from({ length: 35 }, (_, i) => ({
        id: entryId(String(i + 10)), feed_id: 'b'.repeat(40), title: '长列表条目 ' + (i + 1),
        author: '', published_at: 1_791_000_000 + i, original_url: null,
        summary: '摘要 ' + (i + 1), has_content: false, is_read: true, starred: false,
      })).sort((x, y) => y.published_at - x.published_at);
      const listEntries = baseEntries.concat(longList);
      const listItems = query => {
        const u = new URL('https://fixture.test/?' + query);
        let items = listEntries.map(e => {
          const saved = states[e.id] || {};
          return {
            ...e,
            is_read: saved.is_read === undefined ? e.is_read : saved.is_read,
            starred: saved.starred === undefined ? e.starred : saved.starred,
          };
        });
        if (u.searchParams.get('feed_id')) items = items.filter(e => e.feed_id === u.searchParams.get('feed_id'));
        if (u.searchParams.get('unread') === 'true') items = items.filter(e => !e.is_read);
        if (u.searchParams.get('starred') === 'true') items = items.filter(e => e.starred);
        const limit = Number(u.searchParams.get('limit') || 30);
        const cursor = u.searchParams.get('cursor');
        if (cursor) {
          const [at, id] = cursor.split(':');
          items = items.filter(e => (e.published_at || 0) < Number(at) || ((e.published_at || 0) === Number(at) && e.id < id));
        }
        const page_ = items.slice(0, limit);
        return { items: page_, next_cursor: items.length > limit ? (page_[page_.length - 1].published_at || 0) + ':' + page_[page_.length - 1].id : null };
      };
      window.VMusicTransport = {
        async get(url) {
          calls.push(['GET', url]);
          const path = new URL(url, 'https://fixture.test').pathname + new URL(url, 'https://fixture.test').search;
          if (path.startsWith('/v1/reader/subscriptions')) return { feeds: feeds.map(f => ({ ...f })) };
          if (path.startsWith('/v1/reader/entries/')) {
            const parts = path.split('/');
            const id = parts[4], tail = parts[5] || '';
            if (tail === 'images') {
              return { data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', content_type: 'image/gif' };
            }
            if (id === entryId('1')) {
              return { entry: { id, feed_id: 'a'.repeat(40), title: '图文正文一篇', author: '作者甲',
                published_at: 1_791_930_000, original_url: 'https://blog.example.com/posts/1',
                summary: '第一段正文摘要',
                content_html: ENTRY_CONTENT_PLACEHOLDER.replace('__KEY__', key),
                content_status: 'cached', document_key: 'k1',
                images: [{ key }], is_read: false, starred: false } };
            }
            if (id === entryId('2')) {
              return { entry: { id, feed_id: 'a'.repeat(40), title: '仅摘要条目', author: '作者乙',
                published_at: null, original_url: 'https://blog.example.com/posts/2',
                summary: '只有摘要内容', content_html: null, content_status: 'summary_only', document_key: 'k2',
                images: [], is_read: false, starred: false } };
            }
            return { entry: { id, feed_id: 'a'.repeat(40), title: '兜底条目', author: '',
              published_at: null, original_url: null, summary: '', content_html: null,
              content_status: 'none', document_key: 'k9', images: [], is_read: true, starred: false } };
          }
          return listItems(path.split('?')[1] || '');
        },
        async put(url, body) {
          calls.push(['PUT', url, body]);
          const id = url.split('/')[4];
          states[id] = { ...(states[id] || { is_read: false, starred: false }), ...body };
          return { ok: true };
        },
        async post(url, body) {
          calls.push(['POST', url, body]);
          if (url.endsWith('/refresh')) return { result: { synced: 0, not_modified: false, fetched_at: 1_792_000_001 } };
          const created = feed('c'.repeat(40), '新订阅的源', 0);
          created.feed_url = body.feed_url;
          feeds.push(created);
          return { feed: { ...created } };
        },
        async del(url) {
          calls.push(['DELETE', url]);
          const id = url.split('/').pop();
          const target = feeds.find(f => f.id === id);
          if (url.includes('/reader/feeds/')) {
            feeds = feeds.filter(f => f.id !== id);
          } else if (target) {
            target.subscribed = false;
          }
          return { ok: true };
        },
      };
      window.ENTRY_CONTENT_PLACEHOLDER = '';
    }, imageKey);
    // fixture 常量要在 transport 闭包外可见：注入为全局字符串。
    await page.evaluate(text => { window.ENTRY_CONTENT_PLACEHOLDER = text; }, ENTRY_CONTENT);
    // 上面 transport 定义时引用了 const，重新求值一次确保占位符已就绪：
    await page.addScriptTag({ content: read('reader.js') });
    await page.evaluate(() => {
      document.getElementById('view-reader').hidden = false;
      window.confirmQuestion = null;
      window.confirm = question => { window.confirmQuestion = question; return true; };
      Reader.bind({ toast() {} });
      return Reader.onViewEnter();
    });
    await page.locator('.reader-feed').filter({ hasText: '技术快报' }).waitFor();
    assert.match(await page.locator('.reader-feed').filter({ hasText: '技术快报' }).textContent(), /2/,
      'unread badge shows the fixture unread count');
    // 推荐入口：公开 RSS 源列表，外链新窗口打开。
    const pick = page.locator('.reader-pick');
    assert.equal(await pick.getAttribute('href'), 'https://jackyst0.github.io/awesome-rsshub-routes/',
      'recommended RSS source list stays linked');
    assert.equal(await pick.getAttribute('target'), '_blank', 'recommendation opens outside the app');
    assert.equal(await pick.getAttribute('rel'), 'noopener noreferrer', 'recommendation drops opener');
    // 网页全屏：阅读区固定到视口、隐藏订阅与列表，Esc 还原。
    await page.locator('#reader-fullscreen').click();
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('view-reader')).position), 'fixed',
      'fullscreen pins the reader to the viewport');
    assert.equal(await page.locator('.reader-feeds').isVisible(), false, 'fullscreen hides the feed column');
    assert.equal(await page.locator('.reader-list-pane').isVisible(), false, 'fullscreen hides the entry list');
    assert.equal(await page.locator('#reader-fullscreen').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => document.querySelector('#reader-fullscreen use').getAttribute('href')), '#i-compress',
      'fullscreen button advertises the exit affordance');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#reader-fullscreen').getAttribute('aria-pressed'), 'false', 'Escape exits fullscreen');
    assert.equal(await page.locator('.reader-feeds').isVisible(), true, 'feed column returns after exit');
    await page.locator('.reader-feed-main').filter({ hasText: '技术快报' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.reader-entry').length === 2);
    // 打开图文条目：客户端兜底清洗 + 已读标记 + 图片默认不加载。
    await page.locator('.reader-entry-main').filter({ hasText: '图文正文一篇' }).first().click();
    await page.waitForFunction(() => document.querySelector('#reader-content') && !document.querySelector('#reader-content').hidden);
    const contentAudit = await page.evaluate(() => {
      const box = document.getElementById('reader-content');
      return {
        scripts: box.querySelectorAll('script, iframe').length,
        onclick: box.querySelectorAll('[onclick]').length,
        javascriptLinks: Array.from(box.querySelectorAll('a')).filter(a => (a.getAttribute('href') || '').startsWith('javascript')).length,
        safeLink: Array.from(box.querySelectorAll('a')).some(a => a.getAttribute('href') === 'https://ok.example.com/src'
          && a.getAttribute('rel') === 'noopener noreferrer' && a.getAttribute('target') === '_blank'),
        imageSrc: (box.querySelector('img') || {}).getAttribute ? box.querySelector('img').getAttribute('src') : null,
        imageKey: box.querySelector('img').dataset.readerImageKey,
      };
    });
    assert.deepEqual(contentAudit, {
      scripts: 0, onclick: 0, javascriptLinks: 0, safeLink: true, imageSrc: null, imageKey: 'ab'.repeat(16),
    }, 'client sanitizer strips unsafe content; deferred image keys stay outside src');
    assert.equal(requests.some(url => url.includes(imageKey)), false, 'unloaded image keys never become browser requests');
    assert.equal(await page.locator('.reader-entry.active [aria-current="true"]').count(), 1, 'current article remains identifiable in the list');
    await page.waitForFunction(() => (window.states[window.entryId('1')] || {}).is_read === true);
    await page.waitForFunction(() => {
      const badge = document.querySelector('.reader-feed .reader-unread');
      return badge && badge.textContent === '1';
    }, null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => calls.some(c => c[0] === 'GET' && c[1].includes('/images/'))), false,
      'images stay unloaded until the user asks');
    await page.evaluate(() => {
      const get = VMusicTransport.get;
      let fail = 2;
      VMusicTransport.get = async function (url, ...args) {
        if (url.includes('/images/') && fail) {
          fail -= 1;
          if (fail) throw new Error('测试：图片暂时不可用');
          return { data: 'not-an-image', content_type: 'image/png' };
        }
        return get.call(this, url, ...args);
      };
    });
    await page.locator('#reader-load-images').click();
    await page.waitForFunction(() => document.querySelector('#reader-load-images').textContent.includes('点击重试'));
    assert.equal(await page.locator('#reader-content img').isVisible(), false, 'failed image retains the readable placeholder');
    await page.locator('#reader-load-images').click();
    await page.waitForFunction(() => document.querySelector('#reader-load-images').textContent.includes('点击重试'));
    assert.equal(await page.locator('#reader-content img').isVisible(), false, 'decode failures stay retryable without showing a broken image');
    await page.locator('#reader-load-images').click();
    await page.waitForFunction(() => (document.querySelector('#reader-content img') || {}).src
      && document.querySelector('#reader-content img').src.startsWith('data:image/gif'));
    await page.waitForFunction(() => document.querySelector('#reader-load-images').textContent === '图片已加载');
    assert.equal(await page.locator('#reader-content img').isVisible(), true);
    assert.equal(await page.locator('.reader-image-placeholder').count(), 0);
    // 仅摘要条目：展示摘要说明与原文入口。
    await page.locator('.reader-entry-main').filter({ hasText: '仅摘要条目' }).first().click();
    await page.waitForFunction(() => document.querySelector('#reader-content').textContent.includes('只有摘要内容'));
    assert.equal(await page.locator('#reader-open-original').isVisible(), true, 'summary-only entries expose the original link');
    assert.equal(await page.locator('#reader-open-original').getAttribute('href'), 'https://blog.example.com/posts/2');
    // 收藏走显式 PUT，不是 toggle。
    await page.locator('#reader-star').click();
    await page.waitForFunction(() => (window.states[window.entryId('2')] || {}).starred === true);
    await page.locator('[data-reader-filter="starred"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.reader-entry').length === 1);
    await page.locator('[data-reader-filter="unread"]').click();
    // 两条都已读过（打开即标已读），未读视图只剩空态。
    await page.waitForFunction(() => document.querySelectorAll('.reader-entry').length === 0);
    // 长列表分页。
    await page.locator('.reader-feed-main').filter({ hasText: '长列表源' }).click();
    await page.locator('[data-reader-filter="all"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.reader-entry').length === 30);
    await page.locator('#reader-more').click();
    await page.waitForFunction(() => document.querySelectorAll('.reader-entry').length === 35);
    assert.equal(await page.locator('#reader-more').isVisible(), false, 'cursor exhausted hides the more button');
    // 订阅、退订与显式删除。
    await page.locator('#reader-add-url').fill('https://example.org/feed.xml');
    await page.locator('#reader-add').evaluate(form => form.requestSubmit());
    await page.locator('.reader-feed').filter({ hasText: '新订阅的源' }).waitFor();
    assert.ok(await page.evaluate(() => calls.some(c => c[0] === 'POST' && c[1] === '/v1/reader/subscriptions'
      && c[2].feed_url === 'https://example.org/feed.xml')));
    const longRow = page.locator('.reader-feed').filter({ hasText: '长列表源' });
    await longRow.hover();
    await longRow.locator('.reader-feed-action').filter({ hasText: '退订' }).click();
    await page.locator('.reader-feed-group').waitFor();
    assert.match(await page.locator('.reader-feed-group').textContent(), /已取消订阅/);
    await longRow.hover();
    await longRow.locator('.reader-feed-action').filter({ hasText: '删除数据' }).click();
    await page.waitForFunction(() => !document.body.textContent.includes('长列表源'));
    assert.ok(await page.evaluate(() => window.confirmQuestion && window.confirmQuestion.includes('长列表源')),
      'local data deletion asks for confirmation');
    const out = path.join(root, 'output', 'reader-browser');
    fs.mkdirSync(out, { recursive: true });
    await page.locator('.reader-feed-main').filter({ hasText: '技术快报' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.reader-entry').length === 2);
    await page.locator('.reader-entry-main').filter({ hasText: '图文正文一篇' }).click();
    await page.waitForFunction(() => !document.querySelector('#reader-content').hidden);
    await page.screenshot({ path: path.join(out, 'desktop.png') });
    await page.locator('#reader-fullscreen').click();
    await page.screenshot({ path: path.join(out, 'desktop-fullscreen.png') });
    await page.locator('#reader-fullscreen').click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('.reader-entry-list').isVisible(), false, 'compact reading gives the article the available width');
    assert.equal(await page.locator('#reader-back').isVisible(), true, 'compact reader offers a visible return action');
    assert.equal(await page.locator('#reader-entry-title').isVisible(), true);
    await page.screenshot({ path: path.join(out, 'mobile.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal overflow on narrow screens');
    await page.locator('#reader-fullscreen').click();
    assert.equal(await page.locator('.reader-article').isVisible(), true, 'compact fullscreen keeps the article visible');
    assert.equal(await page.locator('.reader-feeds').isVisible(), false, 'compact fullscreen hides the feed column');
    await page.locator('#reader-back').click();
    assert.equal(await page.locator('.reader-feeds').isVisible(), true, 'compact back exits fullscreen');
    assert.equal(await page.locator('.reader-entry-list').isVisible(), true);
    assert.equal(await page.locator('.reader-pick').isVisible(), true, 'recommended source list stays reachable on narrow screens');
    assert.equal(await page.locator('.reader-entry.active .reader-entry-main').evaluate(el => el === document.activeElement), true,
      'return restores keyboard focus to the selected article');
    await page.screenshot({ path: path.join(out, 'mobile-list.png') });
    // A failed detail request must hide the previous article and remain recoverable.
    await page.evaluate(() => {
      const get = VMusicTransport.get;
      let fail = true;
      VMusicTransport.get = async function (url, ...args) {
        if (url === '/v1/reader/entries/' + entryId('2') && fail) { fail = false; throw new Error('测试：正文暂时不可用'); }
        return get.call(this, url, ...args);
      };
    });
    await page.locator('.reader-entry-main').filter({ hasText: '仅摘要条目' }).click();
    await page.locator('#reader-retry').waitFor();
    assert.equal(await page.locator('#reader-content').isVisible(), false, 'failed selection cannot display the previous article');
    await page.locator('#reader-retry').click();
    await page.waitForFunction(() => !document.querySelector('#reader-content').hidden);
    assert.match(await page.locator('#reader-content').textContent(), /只有摘要内容/);
    await page.setViewportSize({ width: 1180, height: 860 });
    await page.addScriptTag({ content: read('themes.js') });
    await page.evaluate(() => Theme.apply('chaoxi-day'));
    // Capture the settled theme, after the shared controls' color transitions.
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, 'desktop-light.png') });
    assert.deepEqual(errors, []);
    console.log('Reader Chrome: unread badges, entry reading, client-side XSS hardening, deferred image proxy, '
      + 'read/star persistence, filters, cursor pagination, subscribe/unsubscribe/delete, recommended source link, '
      + 'web fullscreen and narrow layout passed.');
  } finally { await browser.close(); }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
