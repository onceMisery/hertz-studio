// SPDX-License-Identifier: MIT
// Isolated UI with controlled search/play responses; no external music requests.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { uiUrl } = require('./ui-token');

async function main() {
  const fixture = await startFixture();
  process.env.VMUSIC_DATA_DIR = fixture.dataDir;
  let browser, context;
  const errors = [], plays = [];
  let failNext = false;
  try {
    const local = await fixture.seed();
    let expected = [local.id, 'kept-queue-item'];
    await fixture.api('/v1/player/queue', 'PUT', { queue: expected, index: 0, resume: true });
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await fixture.connect(context);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    for (const file of ['app.js', 'online.js', 'topsearch.js', 'space-home.js']) {
      await page.route('**/' + file + '*', route => route.fulfill({
        contentType: 'application/javascript',
        body: fs.readFileSync(path.resolve(__dirname, '../plugin/ui', file), 'utf8'),
      }));
    }
    await page.route('**/v1/online/sources', route => route.fulfill({ json: { sources:
      [['netease', '网易云音乐'], ['qq', 'QQ音乐']].map(([id, label]) => ({ id, label, kind: 'music', caps: [], cats: [] })),
    } }));
    await page.route('**/v1/online/search?**', route => {
      const url = new URL(route.request().url()), source = url.searchParams.get('source');
      const q = url.searchParams.get('q');
      return route.fulfill({ json: { total: 3, tracks: [0, 1, 2].map(i => ({
        source, id: q + '-' + i, title: q + ' song ' + i, artist: 'Fixture', album: 'Search',
        duration_ms: 180000, playable: true, ref: { id: q + '-' + i },
      })) } });
    });
    await page.route('**/v1/online/lyric?**', route => route.fulfill({ json: { lines: [] } }));
    await page.route('**/v1/online/detail?**', route => route.fulfill({ json: {} }));
    await page.route('**/v1/online/play', async route => {
      const body = route.request().postDataJSON();
      plays.push(body);
      assert.equal(body.enqueue, true, 'search single-track action preserves the queue');
      assert.equal(body.tracks.length, 1, 'search single-track action submits one song');
      if (failNext) {
        failNext = false;
        return route.fulfill({ status: 403, json: { error: { message: 'Fixture playback unavailable' } } });
      }
      const ids = body.tracks.map(track => 'online:' + body.source + ':' + track.id);
      if (!expected.includes(ids[0])) expected = expected.concat(ids[0]);
      await fixture.api('/v1/player/queue', 'PUT', { queue: expected, index: expected.indexOf(ids[0]), resume: true });
      return route.fulfill({ json: { track_ids: ids, index: 0, queue: expected } });
    });
    async function queueIsCurrent() {
      await page.waitForFunction(ids => JSON.stringify(state.queue) === JSON.stringify(ids), expected);
      assert.deepEqual((await fixture.api('/v1/player/queue')).queue, expected);
      assert.equal(await page.locator('.q-row').count(), expected.length);
    }
    async function clickPlay(control) {
      const response = page.waitForResponse(reply => new URL(reply.url()).pathname === '/v1/online/play');
      await control.click();
      await response;
      await queueIsCurrent();
    }
    await page.goto(uiUrl(fixture.base), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Online.sources().length === 2 && document.getElementById('conn').textContent === '服务已连接');
    await queueIsCurrent();
    await page.getByRole('button', { name: '在线曲库', exact: true }).click();
    await page.getByRole('combobox', { name: '音源', exact: true }).selectOption('netease');
    await page.locator('#online-q').fill('single');
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await page.waitForFunction(() => !Online.state.loading && Online.state.tracks.length === 3);
    const picked = page.locator('.online-row').nth(1).getByRole('button', { name: '在线试听', exact: true });
    await clickPlay(picked);
    assert.deepEqual(expected.slice(2), ['online:netease:single-1']);
    await clickPlay(picked);
    await page.waitForFunction(() => !document.querySelector('.online-row.is-loading'));
    await queueIsCurrent();
    assert.equal(expected.length, 3, 'repeat selection does not duplicate the queue entry');

    failNext = true;
    await clickPlay(page.locator('.online-row').nth(2).getByRole('button', { name: '在线试听', exact: true }));
    await page.locator('.online-row.has-play-error').waitFor();
    await queueIsCurrent();
    await clickPlay(page.getByRole('button', { name: '播放失败，点击重试' }));
    await page.waitForFunction(() => !document.querySelector('.online-row.has-play-error, .online-row.is-loading'));
    await queueIsCurrent();

    await page.getByRole('combobox', { name: '音源', exact: true }).selectOption('all');
    await page.locator('#online-q').fill('aggregate');
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await page.waitForFunction(() => !Online.state.loading && Online.state.tracks.length === 6);
    await clickPlay(page.locator('.online-row[data-online-id="online:qq:aggregate-1"]').getByRole('button', { name: '在线试听', exact: true }));

    await page.locator('#search').fill('top');
    await clickPlay(page.locator('.ts-row[data-online-id="online:netease:top-2"]').getByRole('button', { name: '在线试听', exact: true }));
    assert.equal(expected.at(-1), 'online:netease:top-2');

    await page.locator('#space3d-entry').click();
    await page.locator('#sh-query').fill('space');
    await clickPlay(page.locator('.sh-track[data-track-id="online:qq:space-1"] .sh-track-main'));
    assert.equal(expected.at(-1), 'online:qq:space-1');
    assert.deepEqual(errors, []);
    console.log('PASS search single-track playback: single source, aggregate, top search, space search, queue preservation, duplicate selection, failure/retry; ' + plays.length + ' controlled requests');
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
