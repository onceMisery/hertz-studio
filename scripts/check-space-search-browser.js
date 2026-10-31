// SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { uiUrl, uiToken } = require('./ui-token');
const base = process.env.SPACE_BASE || 'http://127.0.0.1:18815', output = path.resolve(__dirname, '../output/playwright/space-search');
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const headers = { Authorization: 'Bearer ' + uiToken() };
  const health = await (await fetch(base + '/v1/health', { headers })).json();
  assert.equal(health.backend, 'null', 'real playback check uses the isolated null backend');
  const library = await (await fetch(base + '/v1/tracks?q=Space%20Playback&limit=10', { headers })).json();
  assert.ok(library.tracks.length, 'existing local playback fixtures are required');
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors = [], onlinePlays = [];
    page.on('pageerror', error => errors.push(error.message));
    let settings;
    await page.route('**/v1/settings', async route => {
      if (!settings) { settings = await (await route.fetch()).json(); settings.space3d = { sceneSource: 'cover-sphere', qualityMode: 'low', shelfMode: 'off' }; }
      if (route.request().method() !== 'GET') Object.assign(settings, route.request().postDataJSON());
      await route.fulfill({ json: settings });
    });
    await page.route('**/v1/online/search?**', async route => {
      const source = new URL(route.request().url()).searchParams.get('source');
      const tracks = Array.from({ length: 16 }, (_, i) => ({ id: 'search-' + i, source, title: i === 0 ? '三维空间里的音乐' : '在远方聆听世界的回声 ' + i,
        artist: '空间音乐人', album: '声音与星球', duration_ms: 180000 }));
      await route.fulfill({ json: { tracks, total: tracks.length } });
    });
    await page.route('**/v1/online/play', async route => {
      onlinePlays.push(route.request().postDataJSON());
      await new Promise(resolve => setTimeout(resolve, 900));
      return route.fulfill({ status: 503, json: { error: '试听暂不可用' } });
    });
    await page.goto(uiUrl(base), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('conn').textContent === '服务已连接');
    await page.locator('#space3d-entry').click(); await page.locator('#sh-query').fill('Space Playback');
    await page.getByRole('tab', { name: '本地', exact: true }).click();
    const track = library.tracks[0];
    await page.locator('.sh-panel-body .sh-track[data-track-id="' + track.id + '"] .sh-track-main').click();
    await page.waitForFunction(id => Stage.presentation().track?.id === id && Stage.presentation().playing, track.id);
    assert.ok(await page.locator('.sh-panel-body .sh-track.is-current.is-playing').count(), 'real API + websocket update the selected row');
    assert.equal(await page.getByRole('button', { name: '固定面板', exact: true }).count(), 0);
    await page.locator('#sh-query').fill('空间音乐');
    const onlineTab = page.getByRole('tab').filter({ hasText: '网易云' }); await onlineTab.click();
    const row = page.locator('.sh-panel-body .sh-track').first(); await row.locator('strong').filter({ hasText: '三维空间里的音乐' }).waitFor();
    await row.locator('.sh-track-main').click();
    assert.equal(await row.locator('.sh-track-main').getAttribute('aria-busy'), 'true');
    assert.equal(await row.locator('.sh-track-status').textContent(), '正在载入…');
    await page.waitForFunction(() => !!document.querySelector('.sh-panel-body .sh-track.has-error'));
    assert.match(await row.locator('.sh-track-status').textContent(), /无法播放/);
    const failed = onlinePlays.at(-1);
    assert.equal(failed.source, 'netease'); assert.equal(failed.tracks[0].id, 'search-0');
    assert.equal(failed.tracks.length, 1); assert.equal(failed.enqueue, true);
    await row.locator('.sh-track-main').click();
    await page.evaluate(() => handleEvent({type:'error',source:'netease',message:'音源暂时无法提供播放地址',index:0}));
    assert.equal(await row.locator('.sh-track-status').textContent(), '音源暂时无法提供播放地址', 'websocket errors appear in the active result row');
    assert.ok(await page.locator('#toast').evaluate(node => Number(getComputedStyle(node).zIndex) > Number(getComputedStyle(document.getElementById('space3d')).zIndex)), 'space errors are above the world');
    for (const width of [1440, 1087, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(400);
      const layout = await page.locator('.sh-panel').evaluate(panel => {
        const r = panel.getBoundingClientRect(), body = panel.querySelector('.sh-panel-body'), header = panel.querySelector('.sh-panel-head');
        return { left: r.left, right: r.right, overflow: panel.scrollWidth > panel.clientWidth, body: body.getBoundingClientRect().top, header: header.getBoundingClientRect().bottom,
          shadow: getComputedStyle(panel).boxShadow, scrim: getComputedStyle(document.querySelector('.sh-scrim')).backdropFilter };
      });
      assert.ok(layout.left >= 0 && layout.right <= width && !layout.overflow); assert.ok(layout.body >= layout.header - 1);
      assert.notEqual(layout.shadow, 'none'); assert.notEqual(layout.scrim, 'none');
      await page.screenshot({ path: path.join(output, 'search-' + width + '.png') });
    }
    await page.keyboard.press('Escape'); await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('.sh-action-library').click(); assert.equal(await page.getByRole('button', { name: '固定面板', exact: true }).count(), 0);
    await page.screenshot({ path: path.join(output, 'library.png') });
    await page.keyboard.press('Escape'); assert.equal(await page.locator('.sh-panel-layer').isVisible(), false);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ connected: true, realLocalPlayback: true, loading: true, inlineFailure: true, layouts: [1440,1087,390,320], removedPin: true }, null, 2));
    console.log('Space search: real websocket/playback, loading/error/retry, metadata, removed pin, layered desktop/mobile panels and keyboard dismissal passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
