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
    await page.route('https://fixture.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await page.goto('https://fixture.test');
    await page.setContent(html.slice(start, end));
    for (const file of ['style.css', 'podcasts.css']) await page.addStyleTag({ content: read(file) });
    await page.addStyleTag({ content: 'body{padding:20px;overflow:auto}#view-podcasts{height:780px;width:100%;max-width:1000px;margin:auto}' });
    await page.evaluate(() => {
      const episodeId = (showId, number) => String(number).padStart(2, '0') + (showId === 'a' ? 'a' : 'b').repeat(38);
      window.makeEpisodeId = episodeId;
      const makeShow = (id, title) => ({ id, title, author: '中文播客作者', cover: null,
        feed_url: 'https://feeds.example.com/' + id, description: '节目简介', episode_count: 3, subscribed: false });
      const a = makeShow('a', '故事FM'); a.subscribed = true;
      const b = makeShow('b', '声东击西');
      window.plays = []; window.seeks = []; window.calls = []; window.subscribed = [a];
      window.holdPlay = false;
      window.progresses = {
        [episodeId('b', 1)]: { progress_ms: 3723000, completed: true },
        [episodeId('b', 2)]: { progress_ms: 1_234_000, completed: false },
      };
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
            if (u.searchParams.get('q') === 'regional') {
              const country = u.searchParams.get('country');
              const result = { query: 'regional', shows: [makeShow(country, country + ' catalog')] };
              if (country === 'CN') return new Promise(resolve => { window.resolveRegion = () => resolve(result); });
              return result;
            }
            if (u.searchParams.get('q') === 'old') return new Promise(resolve => { window.resolveOld = () => resolve({ query: 'old', shows: [a] }); });
            if (u.searchParams.get('q') === 'failure') throw new Error('fixture search unavailable');
            return { query: u.searchParams.get('q'), shows: [b] };
          }
          if (u.pathname.endsWith('/feed')) {
            if (window.failFeed) throw new Error('fixture feed unavailable');
            const show = u.searchParams.get('url').endsWith('/a') ? a : b;
            const offset = Number(u.searchParams.get('offset') || 0);
            const result = { show: { ...show, subscribed: subscribed.some(s => s.id === show.id) }, total: 3, episode_limit: 3,
              episodes: Array.from({ length: offset ? 1 : 2 }, (_, i) => {
                const number = i + offset + 1, id = episodeId(show.id, number);
                return { source: 'podcast', id, title: '第' + number + '期：长节目也能听',
                  artist: show.author, album: show.title, duration_ms: 3723000, cover: null,
                  playable: true, vip_only: false, ref: {}, published_at: 'Fri, 02 Oct 2026 09:11:35 GMT',
                  description: '<img src=x onerror="throw new Error(1)">只按文字显示',
                  progress_ms: (window.progresses[id] || {}).progress_ms || 0,
                  completed: !!(window.progresses[id] || {}).completed };
              }) };
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
          if (url.endsWith('/progress')) {
            const progress = { progress_ms: body.position_ms, completed: !!body.completed };
            if (progress.progress_ms < 5000 && !progress.completed) progress.progress_ms = 0;
            progresses[body.episode_id] = progress;
            return progress;
          }
          const show = body.feed_url.endsWith('/a') ? a : b;
          if (!subscribed.some(s => s.id === show.id)) subscribed.push(show);
          return { show: { ...show, subscribed: true } };
        },
        async del(url) { calls.push(['DELETE', url]); subscribed = subscribed.filter(s => !url.endsWith('/' + s.id)); return { ok: true }; },
      };
    });
    await page.addScriptTag({ content: read('host.js') });
    await page.addScriptTag({ content: read('podcasts.js') });
    await page.evaluate(() => {
      document.getElementById('view-podcasts').hidden = false;
      Podcasts.bind({
        play: async (tracks, index) => {
          plays.push({ ids: tracks.map(t => t.id), index });
          if (window.holdPlay) {
            window.holdPlay = false;
            document.dispatchEvent(new CustomEvent('playback:snapshot', { detail: {
              track_id: 'online:podcast:' + tracks[index].id,
              playing: true, position_ms: 90_000, duration_ms: 3723000,
            } }));
            return new Promise(resolve => { window.resolvePlay = resolve; });
          }
          document.dispatchEvent(new CustomEvent('playback:snapshot', { detail: {
            track_id: 'online:podcast:' + tracks[index].id, playing: true, position_ms: 0, duration_ms: 3723000,
          } }));
        },
        seek: async position => seeks.push(position), toast() {},
      });
      return Podcasts.onViewEnter();
    });
    assert.equal(await page.locator('#podcast-country').count(), 1, 'search has a region selector');
    assert.equal(await page.locator('#podcast-country').inputValue(), 'CN', 'existing Chinese catalog is the default');
    const savedEpisodeId = await page.evaluate(() => window.makeEpisodeId('b', 2));
    await page.evaluate(id => document.dispatchEvent(new CustomEvent('playback:snapshot', { detail: {
      track_id: 'online:podcast:' + id, playing: false, position_ms: 0, duration_ms: 3723000,
    } })), savedEpisodeId);
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(id => window.progresses[id].progress_ms, savedEpisodeId), 1_234_000,
      'an initial paused zero-position snapshot must preserve the saved resume point');
    assert.equal(await page.evaluate(() => calls.filter(c => c[0] === 'POST' && c[1].endsWith('/progress')).length), 0,
      'initial player state must not be persisted as a user reset');
    await page.locator('#podcast-query').fill('regional');
    await page.locator('#podcast-search').evaluate(form => form.requestSubmit());
    await page.waitForFunction(() => typeof resolveRegion === 'function');
    await page.locator('#podcast-country').selectOption('US');
    await page.locator('.podcast-show').filter({ hasText: 'US catalog' }).waitFor();
    await page.evaluate(() => resolveRegion());
    assert.match(await page.locator('.podcast-show').textContent(), /US catalog/, 'late CN search cannot replace US results');
    assert.ok(await page.evaluate(() => calls.some(c => c[1].includes('country=US'))), 'request carries selected region');
    await page.locator('#podcast-country').selectOption('GB');
    await page.locator('.podcast-show').filter({ hasText: 'GB catalog' }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'regional form fits mobile');
    for (const selector of ['#podcast-country', '#podcast-query', '#podcast-search button']) {
      const box = await page.locator(selector).boundingBox();
      assert.ok(box.width >= 70 && box.x >= 0 && box.x + box.width <= 390, selector + ' stays usable');
    }
    const regionalOutput = path.join(root, 'output', 'podcasts-browser'); fs.mkdirSync(regionalOutput, { recursive: true });
    await page.screenshot({ path: path.join(regionalOutput, 'regions-mobile.png') });
    await page.setViewportSize({ width: 1040, height: 850 });
    await page.screenshot({ path: path.join(regionalOutput, 'regions-desktop.png') });
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
    const expectedEpisodeIds = await page.evaluate(() => [1, 2, 3].map(n => window.makeEpisodeId('b', n)));
    assert.deepEqual(await page.evaluate(() => plays), [{ ids: expectedEpisodeIds, index: 1 }]);
    await page.waitForFunction(() => seeks.includes(1_234_000));
    const seekCount = await page.evaluate(() => seeks.length);
    await page.evaluate(() => { window.holdPlay = true; });
    await page.locator('.podcast-episode-play').nth(1).click();
    await page.waitForFunction(() => typeof window.resolvePlay === 'function');
    await page.waitForTimeout(25);
    assert.equal(await page.evaluate(() => seeks.length), seekCount,
      'a same-episode snapshot before the new play request completes cannot seek');
    await page.evaluate(() => window.resolvePlay());
    await page.waitForFunction(count => seeks.length === count + 1, seekCount);
    assert.equal(await page.evaluate(() => seeks.at(-1)), 1_234_000,
      'saved position is restored after the same-episode play request completes');
    await page.evaluate(id => document.dispatchEvent(new CustomEvent('playback:snapshot', { detail: {
      track_id: 'online:podcast:' + id, playing: false, position_ms: 1_240_000, duration_ms: 3723000,
    } })), expectedEpisodeIds[1]);
    await page.waitForFunction(() => calls.some(c => c[1].endsWith('/progress') && c[2].position_ms === 1_240_000));
    await page.evaluate(id => document.dispatchEvent(new CustomEvent('playback:snapshot', { detail: {
      track_id: 'online:podcast:' + id, playing: true, position_ms: 60_000, duration_ms: 3723000,
    } })), expectedEpisodeIds[2]);
    await page.waitForFunction(() => calls.filter(c => c[1].endsWith('/progress')
      && c[2].episode_id === window.makeEpisodeId('b', 2) && c[2].position_ms === 1_240_000).length >= 2);
    const episodeRow = page.locator('.podcast-episode').nth(2);
    await episodeRow.evaluate(el => {
      window.r1EpisodeRow = el;
      window.r1EpisodeSummary = el.querySelector('summary');
      el.querySelector('details').open = true;
      window.r1EpisodeSummary.focus();
    });
    await page.evaluate(() => {
      const realNow = Date.now;
      const fixtureNow = realNow() + 10_001;
      Date.now = () => fixtureNow;
      document.dispatchEvent(new CustomEvent('playback:snapshot', { detail: {
        track_id: 'online:podcast:' + window.makeEpisodeId('b', 3),
        playing: true, position_ms: 90_000, duration_ms: 3723000,
      } }));
      Date.now = realNow;
    });
    await page.waitForFunction(() => calls.some(c => c[1].endsWith('/progress')
      && c[2].episode_id === window.makeEpisodeId('b', 3) && c[2].position_ms === 90_000));
    assert.deepEqual(await page.evaluate(() => ({
      connected: window.r1EpisodeRow.isConnected,
      detailsOpen: window.r1EpisodeRow.querySelector('details').open,
      focusPreserved: document.activeElement === window.r1EpisodeSummary,
    })), { connected: true, detailsOpen: true, focusPreserved: true },
    'a periodic progress write updates its badge without replacing the episode list');
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('playback:ended', { detail: { position_ms: 0 } })));
    await page.waitForFunction(() => calls.some(c => c[1].endsWith('/progress')
      && c[2].episode_id === window.makeEpisodeId('b', 3) && c[2].completed));
    await page.waitForFunction(() => document.querySelectorAll('.podcast-episode')[2].textContent.includes('已听完'));
    await page.locator('.podcast-episode-play').first().click();
    await page.waitForFunction(() => calls.some(c => c[1].endsWith('/progress')
      && c[2].episode_id === window.makeEpisodeId('b', 1)
      && c[2].position_ms === 0 && !c[2].completed));
    await page.waitForFunction(() => !document.querySelectorAll('.podcast-episode')[0].textContent.includes('已听完'));
    assert.deepEqual(await page.evaluate(id => progresses[id], expectedEpisodeIds[0]),
      { progress_ms: 0, completed: false }, 'replaying a completed episode clears completion at its initial zero-position snapshot');
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
    assert.equal(await page.locator('#podcast-country').inputValue(), 'GB', 'search failure preserves selected region');
    await page.reload();
    await page.setContent(html.slice(start, end));
    await page.addScriptTag({ content: read('host.js') });
    await page.addScriptTag({ content: read('podcasts.js') });
    await page.evaluate(() => Podcasts.bind({ play() {} }));
    assert.equal(await page.locator('#podcast-country').inputValue(), 'GB', 'region survives a page reload');
    await page.evaluate(() => localStorage.setItem('hertz.podcasts.country', 'ZZ'));
    await page.reload();
    await page.setContent(html.slice(start, end));
    await page.addScriptTag({ content: read('host.js') });
    await page.addScriptTag({ content: read('podcasts.js') });
    await page.evaluate(() => Podcasts.bind({ play() {} }));
    assert.equal(await page.locator('#podcast-country').inputValue(), 'CN', 'obsolete saved region uses default');
    assert.deepEqual(errors, []);
    console.log('Podcasts Chrome: regions, persistence, stale regional searches, subscriptions, inert feed text, pagination, playback resume/progress/completion, RSS import, errors and narrow layout passed.');
  } finally { await browser.close(); }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
