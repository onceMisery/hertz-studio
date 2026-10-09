#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Shipped podcast UI, real DOM, deterministic transport; no public services.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, 'plugin/ui', name), 'utf8');
const html = read('index.html');
const start = html.indexOf('<!-- 播客 -->');
const end = html.indexOf('<!-- /播客 -->', start);
assert.ok(start >= 0 && end > start, 'podcast view must be shipped');

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1040, height: 850 } });
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.setContent(html.slice(start, end));
    for (const file of ['style.css', 'podcasts.css']) await page.addStyleTag({ content: read(file) });
    await page.addStyleTag({ content: 'body{padding:20px;overflow:auto}#view-podcasts{height:780px;width:100%;max-width:1000px;margin:auto}' });
    await page.evaluate(() => {
      const makeShow = (id, title) => ({ id, title, author: '中文播客作者', cover: null,
        feed_url: 'https://feeds.example.com/' + id, description: '节目简介', episode_count: 3, subscribed: false });
      const a = makeShow('a', '故事FM'); a.subscribed = true;
      const b = makeShow('b', '声东击西');
      window.plays = []; window.calls = []; window.subscribed = [a];
      window.VMusicTransport = {
        async get(url) {
          calls.push(['GET', url]);
          const u = new URL(url, 'https://fixture.test');
          if (u.pathname.endsWith('/subscriptions')) {
            const result = { shows: subscribed.map(s => ({ ...s })) };
            if (window.holdSubscriptions) {
              window.holdSubscriptions = false;
              return new Promise(resolve => { window.resolveSubscriptions = () => resolve(result); });
            }
            return result;
          }
          if (u.pathname.endsWith('/search')) {
            if (u.searchParams.get('q') === 'old') return new Promise(resolve => { window.resolveOld = () => resolve({ query: 'old', shows: [a] }); });
            if (u.searchParams.get('q') === 'failure') throw new Error('fixture search unavailable');
            return { query: u.searchParams.get('q'), shows: [b] };
          }
          if (u.pathname.endsWith('/feed')) {
            if (window.failFeed) throw new Error('fixture feed unavailable');
            const show = u.searchParams.get('url').endsWith('/a') ? a : b;
            const offset = Number(u.searchParams.get('offset') || 0);
            const result = { show: { ...show, subscribed: subscribed.some(s => s.id === show.id) }, total: 3, episode_limit: 3,
              episodes: Array.from({ length: offset ? 1 : 2 }, (_, i) => ({ source: 'podcast',
                id: show.id + (i + offset + 1), title: '第' + (i + offset + 1) + '期：长节目也能听',
                artist: show.author, album: show.title, duration_ms: 3723000, cover: null,
                playable: true, vip_only: false, ref: {}, published_at: 'Fri, 02 Oct 2026 09:11:35 GMT',
                description: '<img src=x onerror="throw new Error(1)">只按文字显示',
              })) };
            if (window.holdFeed) {
              window.holdFeed = false;
              return new Promise(resolve => { window.resolveFeed = () => resolve(result); });
            }
            return result;
          }
          throw new Error('Unexpected request ' + url);
        },
        async post(url, body) {
          calls.push(['POST', url, body]);
          const show = body.feed_url.endsWith('/a') ? a : b;
          if (!subscribed.some(s => s.id === show.id)) subscribed.push(show);
          return { show: { ...show, subscribed: true } };
        },
        async del(url) { calls.push(['DELETE', url]); subscribed = subscribed.filter(s => !url.endsWith('/' + s.id)); return { ok: true }; },
      };
    });
    await page.addScriptTag({ content: read('podcasts.js') });
    await page.evaluate(() => {
      document.getElementById('view-podcasts').hidden = false;
      Podcasts.bind({ play: async (tracks, index) => plays.push({ ids: tracks.map(t => t.id), index }), toast() {} });
      return Podcasts.onViewEnter();
    });
    await page.getByRole('button', { name: '我的订阅', exact: true }).click();
    await page.locator('.podcast-show').filter({ hasText: '故事FM' }).waitFor();
    await page.locator('#podcast-query').fill('old');
    await page.locator('#podcast-search').evaluate(form => form.requestSubmit());
    await page.waitForFunction(() => typeof resolveOld === 'function');
    await page.locator('#podcast-query').fill('new');
    await page.locator('#podcast-search').evaluate(form => form.requestSubmit());
    await page.locator('.podcast-show').filter({ hasText: '声东击西' }).waitFor();
    await page.evaluate(() => resolveOld());
    assert.equal(await page.locator('.podcast-show').count(), 1);
    assert.match(await page.locator('.podcast-show').textContent(), /声东击西/);
    await page.locator('.podcast-show').click();
    await page.locator('.podcast-episode').first().waitFor();
    assert.equal(await page.locator('.podcast-episode').count(), 2);
    assert.match(await page.locator('#podcast-episode-count').textContent(), /已收录 3 期/);
    assert.match(await page.locator('#podcast-capacity').textContent(), /最多收录 3 期/);
    assert.equal(await page.locator('#podcast-detail img[src="x"]').count(), 0, 'feed markup is inert text');
    assert.match(await page.locator('.podcast-episode').first().textContent(), /1:02:03/);
    await page.locator('#podcast-more').click();
    await page.waitForFunction(() => document.querySelectorAll('.podcast-episode').length === 3);
    assert.equal(await page.locator('#podcast-more').isVisible(), false);
    await page.locator('.podcast-episode-play').nth(1).click();
    assert.deepEqual(await page.evaluate(() => plays), [{ ids: ['b1', 'b2', 'b3'], index: 1 }]);
    await page.evaluate(() => { window.holdFeed = true; });
    await page.locator('#podcast-feed-refresh').click();
    await page.waitForFunction(() => typeof resolveFeed === 'function');
    await page.locator('#podcast-subscribe').click();
    await page.waitForFunction(() => subscribed.some(s => s.id === 'b'));
    await page.waitForFunction(() => !document.querySelector('#podcast-subscribe').disabled);
    assert.equal(await page.locator('#podcast-subscribe').textContent(), '取消订阅');
    await page.evaluate(() => { resolveFeed(); delete window.resolveFeed; });
    await page.waitForFunction(() => !document.querySelector('#podcast-feed-refresh').disabled);
    assert.equal(await page.locator('#podcast-subscribe').textContent(), '取消订阅', 'an older feed must preserve a confirmed subscription');
    await page.evaluate(() => { window.holdFeed = true; });
    await page.locator('#podcast-feed-refresh').click();
    await page.waitForFunction(() => typeof resolveFeed === 'function');
    await page.locator('#podcast-subscribe').click();
    await page.waitForFunction(() => !subscribed.some(s => s.id === 'b'));
    await page.waitForFunction(() => !document.querySelector('#podcast-subscribe').disabled);
    await page.evaluate(() => { resolveFeed(); delete window.resolveFeed; });
    await page.waitForFunction(() => !document.querySelector('#podcast-feed-refresh').disabled);
    assert.equal(await page.locator('#podcast-subscribe').textContent(), '订阅节目', 'an older feed must preserve a confirmed unsubscribe');
    await page.locator('#podcast-more').click();
    await page.waitForFunction(() => document.querySelectorAll('.podcast-episode').length === 3);
    await page.evaluate(() => { window.failFeed = true; });
    await page.locator('#podcast-feed-refresh').click();
    await page.waitForFunction(() => document.querySelector('#podcast-status').textContent.includes('fixture feed unavailable'));
    assert.equal(await page.locator('.podcast-episode').count(), 3, 'failed refresh preserves playable episodes');
    await page.evaluate(() => { window.holdSubscriptions = true; window.oldSubscriptions = Podcasts.onViewEnter(); });
    await page.waitForFunction(() => typeof resolveSubscriptions === 'function');
    await page.locator('#podcast-subscribe').click();
    await page.waitForFunction(() => !document.querySelector('#podcast-subscribe').disabled);
    await page.evaluate(async () => { resolveSubscriptions(); await oldSubscriptions; });
    await page.evaluate(() => { window.failFeed = false; window.holdFeed = true; });
    await page.locator('#podcast-feed-refresh').click();
    await page.waitForFunction(() => typeof resolveFeed === 'function');
    await page.locator('#podcast-back').click();
    await page.evaluate(() => { window.holdSubscriptions = true; });
    await page.locator('[data-podcast-tab="subscriptions"]').click();
    assert.equal(await page.locator('.podcast-show').filter({ hasText: '声东击西' }).count(), 1, 'an older subscription read must not erase a confirmed subscription');
    await page.evaluate(() => resolveSubscriptions());
    await page.locator('.podcast-show').filter({ hasText: '故事FM' }).click();
    await page.locator('.podcast-episode').first().waitFor();
    await page.evaluate(() => resolveFeed());
    assert.equal(await page.locator('#podcast-show-title').textContent(), '故事FM', 'late feed cannot replace the current show');
    const out = path.join(root, 'output', 'podcasts-browser'); fs.mkdirSync(out, { recursive: true });
    await page.screenshot({ path: path.join(out, 'desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'mobile.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal overflow');
    await page.locator('#podcast-back').click();
    await page.locator('#podcast-import-details > summary').click();
    await page.locator('#podcast-feed-url').fill('https://feeds.example.com/b');
    await page.locator('#podcast-import').evaluate(form => form.requestSubmit());
    await page.locator('#podcast-show-title').filter({ hasText: '声东击西' }).waitFor();
    assert.equal(await page.evaluate(() => subscribed.filter(s => s.id === 'b').length), 1);
    await page.locator('#podcast-back').click();
    await page.locator('#podcast-query').fill('failure');
    await page.locator('#podcast-search').evaluate(form => form.requestSubmit());
    await page.waitForFunction(() => document.getElementById('podcast-status').textContent.includes('fixture search unavailable'));
    assert.deepEqual(errors, []);
    console.log('Podcasts Chrome: subscriptions, stale searches, inert feed text, pagination, playback, RSS import, errors and narrow layout passed.');
  } finally { await browser.close(); }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
