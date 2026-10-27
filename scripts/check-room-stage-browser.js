// SPDX-License-Identifier: MIT
// Real isolated room writes + full application/stage. Media presentation and
// online search are fixtures; this check does not open an audio device.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { uiUrl, uiToken } = require('./ui-token');
const ui = path.resolve(__dirname, '../plugin/ui');
async function main() {
  const fixture = await startFixture();
  let browser;
  try {
    process.env.VMUSIC_DATA_DIR = fixture.dataDir;
    const local = await fixture.seed();
    const room = body => fixture.api('/v1/room', 'POST', body);
    await room({ action: 'create', name: '夜航一起听', address: '127.0.0.1:0', sample_rate: 48000, local_output: false });
    await room({ action: 'share', track_ids: [local.id] });
    const peer = request => room({ action: 'peer', request });
    const resource = (await peer({ action: 'library', offset: 0, limit: 32 })).tracks[0];
    let snapshot = await fixture.api('/v1/room');
    await peer({ action: 'queue', operation_id: snapshot.next_operation_id, expected_revision: snapshot.revision, items: [{ instance_id: null, resource_id: resource.resource_id }] });
    const queue = await peer({ action: 'queue_page', offset: 0, limit: 32 });
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await fixture.connect(context);
    const errors = [], calls = [], searches = [];
    let holdSearch = false, releaseSearch, failSearch = false, restrictTransport = false;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== fixture.base) return route.abort();
      if (request.method() === 'POST' && url.pathname === '/v1/room') calls.push(request.postDataJSON());
      if (request.method() === 'GET' && url.pathname === '/v1/room') {
        const response = await route.fetch(), projection = await response.json();
        if (projection.mode !== 'local') Object.assign(projection, { current_track: resource, track_instance_id: queue.queue[0].instance_id, position_ms: '12000', playing: false, permissions: { ...projection.permissions, transport: !restrictTransport } });
        return route.fulfill({ response, json: projection });
      }
      if (url.pathname === '/v1/online/sources') return route.fulfill({ json: { sources: [{ id: 'ccmixter', label: '测试音源', kind: 'music', caps: ['search'] }] } });
      if (url.pathname === '/v1/online/search') {
        searches.push(url.searchParams.get('q'));
        if (holdSearch) await new Promise(resolve => { releaseSearch = resolve; });
        if (failSearch) return route.fulfill({ status: 504, json: { error: { code: 'timeout', message: 'fixture timeout' } } });
        return route.fulfill({ json: { tracks: [{ source: 'ccmixter', id: '60000', title: url.searchParams.get('q') + ' · 在线版本', artist: '在线歌手', playable: true, duration_ms: 30000 }, { source: 'ccmixter', id: '60001', title: '暂无可播版本', playable: false }], total: 2 } });
      }
      // The executable provides real APIs; all UI bytes come from this checkout.
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(ui, relative);
      if (file.startsWith(ui + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const type = file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : null;
        if (type) return route.fulfill({ contentType: type, body: file.endsWith('.html') ? fs.readFileSync(file, 'utf8').replace('__VMUSIC_TOKEN_VALUE__', uiToken()) : fs.readFileSync(file) });
      }
      return route.continue();
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(uiUrl(fixture.base));
    await page.waitForFunction(() => window.HertzRoom && HertzRoom.snapshot().mode === 'host' && window.Stage3D);
    await page.locator('[data-view="room"]').first().click();
    await page.getByRole('button', { name: '打开我的舞台', exact: true }).waitFor();
    const composer = page.getByRole('textbox', { name: '说点什么（最多 200 字）', exact: true });
    await composer.fill('切换舞台保留的草稿');
    await page.getByRole('button', { name: '打开我的舞台', exact: true }).click();
    await page.waitForFunction(() => Stage3D.isActive() && Stage.presentation().track?.id.startsWith('room:'));
    assert.equal(await page.locator('#s3d-title').textContent(), local.title);
    assert.equal(await page.locator('#s3d-elapsed').textContent(), '0:12');
    await page.locator('.room-stage-chat-popover > summary').click();
    assert.equal(await composer.inputValue(), '切换舞台保留的草稿');
    assert.equal(await page.locator('textarea[maxlength="400"]').count(), 1, 'one composer across stage and room');
    await composer.fill('从自己的舞台发送');
    await page.getByRole('button', { name: '发送弹幕', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.room-stage-overlay .room-danmaku').childElementCount > 0);
    assert.equal(calls.filter(call => call.request?.action === 'chat_send').length, 1);
    const preferences = await page.evaluate(() => JSON.stringify(Stage3D.preferences()));
    await page.getByRole('checkbox', { name: '显示实时弹幕', exact: true }).uncheck();
    assert.equal(await page.locator('.room-stage-overlay .room-danmaku').isVisible(), false);
    await composer.fill('返回房间仍保留');
    await page.getByRole('button', { name: '返回一起听', exact: true }).click();
    assert.equal(await composer.inputValue(), '返回房间仍保留');
    assert.equal(await page.locator('.room-stage-overlay').count(), 0);
    await page.getByRole('button', { name: '＋ 点歌', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '添加歌曲', exact: true });
    assert.equal(await picker.getByRole('tab', { name: '在线歌曲', exact: true }).getAttribute('aria-selected'), 'true');
    const query = picker.getByRole('searchbox', { name: '搜索在线歌曲', exact: true });
    await query.fill('夜航'); await query.press('Enter');
    await picker.getByText('夜航 · 在线版本', { exact: true }).waitFor();
    assert.equal(await picker.getByRole('button', { name: '暂不可播', exact: true }).isDisabled(), true);
    await picker.getByRole('button', { name: '加入共同队列', exact: true }).click();
    await picker.getByRole('button', { name: '已加入 · 再点一次', exact: true }).waitFor();
    assert.equal(calls.filter(call => call.action === 'share_online').length, 1);
    assert.equal((await peer({ action: 'queue_page', offset: 0, limit: 32 })).queue.length, 2);
    assert.ok(!calls.some(call => call.action === 'play' || call.request?.command?.action === 'pick'), 'adding does not change current song');
    assert.equal(await page.evaluate(() => JSON.stringify(Stage3D.preferences())), preferences, 'navigation and song choice leave local scene settings intact');
    const output = path.resolve(__dirname, '../output/ui-productization'); fs.mkdirSync(output, { recursive: true });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.screenshot({ path: path.join(output, 'room-online-picker-' + width + '.png') });
      const contained = await picker.evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && node.scrollWidth <= node.clientWidth + 1; });
      assert.ok(contained, 'picker fits ' + width);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    assert.ok(await picker.evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && node.scrollWidth <= node.clientWidth + 1; }), 'online picker fits at 200% zoom');
    await page.evaluate(() => { document.documentElement.style.zoom = ''; });
    await page.setViewportSize({ width: 390, height: 800 });
    failSearch = true; await query.fill('失败'); await query.press('Enter');
    await picker.getByText(/搜索超时/).waitFor();
    failSearch = false; holdSearch = true; await query.fill('迟到'); await query.press('Enter');
    await page.waitForFunction(() => document.querySelector('.room-online-search button').disabled);
    await picker.getByRole('button', { name: '关闭添加歌曲', exact: true }).click();
    if (releaseSearch) releaseSearch(); holdSearch = false;
    await page.getByRole('button', { name: '打开我的舞台', exact: true }).click();
    await page.waitForFunction(() => Stage3D.isActive());
    restrictTransport = true; await page.evaluate(() => HertzRoom.onViewEnter());
    await page.waitForFunction(() => document.getElementById('s3d-play').disabled && document.getElementById('s3d-seek').disabled);
    assert.equal(await page.locator('.room-stage-chat-popover > summary').isVisible(), true, 'chat remains available without playback permission');
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(output, 'room-personal-stage-390.png') });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator('.room-stage-chat-popover > summary').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(output, 'room-personal-stage-1280.png') });
    assert.equal(await page.locator('.room-online-results').getByText('迟到 · 在线版本', { exact: true }).count(), 0, 'closed search cannot commit late results');
    await page.keyboard.press('q');
    assert.equal(await page.evaluate(() => Stage3D.isActive()), true, 'typing in chat does not trigger stage shortcuts');
    await page.locator('.room-stage-chat-popover > summary').click();
    await page.keyboard.press('q');
    await page.waitForFunction(() => !Stage3D.isActive());
    assert.equal(await page.locator('#view-room').getAttribute('data-room-aside'), 'queue');
    assert.deepEqual(errors, []);
    await room({ action: 'leave' });
    await page.waitForFunction(() => !HertzRoom.active() && !Stage.presentation().track?.id.startsWith('room:'));
    console.log('PASS real room/stage metadata, shared composer/draft, live danmaku, local preferences, online-first picker, real share+queue/no playback, disabled songs, errors, cancellation, narrow layouts and Q return');
  } finally { if (browser) await browser.close(); await fixture.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
