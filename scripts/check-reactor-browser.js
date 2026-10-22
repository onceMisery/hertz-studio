#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { readAssets } = require('./ui-assets');
const root = path.resolve(__dirname, '..'), web = path.join(root, 'plugin/ui');
const output = path.join(root, 'output/playwright/reactor');

async function until(probe, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await probe()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
}
function wav() {
  const samples = 8000 * 120, buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}
async function main() {
  fs.mkdirSync(output, { recursive: true });
  console.log('Reactor check: starting isolated service');
  const fixture = await startFixture();
  console.log('Reactor check: isolated service ready');
  let browser;
  try {
    const music = path.join(fixture.dataDir, 'reactor-music'); fs.mkdirSync(music);
    const names = ['霓虹记忆', '零号脉冲', '深空回声', '数字雨'];
    const audio = wav(); names.forEach(name => fs.writeFileSync(path.join(music, name + '.wav'), audio));
    await fixture.api('/v1/library/scan', 'POST', { root: music });
    let tracks;
    await until(async () => { tracks = (await fixture.api('/v1/tracks?limit=50')).tracks; return tracks.length === names.length; }, 'isolated library');
    await fixture.api('/v1/settings', 'PUT', { reduce_motion: false, space3d: { sceneSource: 'coast', qualityMode: 'low', cinema: false, lyrics: false, playerAutoHide: false, shelfMode: 'side' } });
    await fixture.api('/v1/player/volume', 'POST', { volume: 0 });
    await fixture.api('/v1/player/load', 'POST', { track_id: tracks[0].id, queue: tracks.map(t => t.id) });
    console.log('Reactor check: starting browser');
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await fixture.connect(context);
    const token = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'vmusicd.json'), 'utf8')).token;
    const assets = new Map(readAssets().map(a => [a.path, a]));
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== fixture.base) return route.continue();
      if (url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(web, 'index.html'), 'utf8').replace('__VMUSIC_TOKEN_VALUE__', token) });
      if (assets.has(url.pathname)) {
        const asset = assets.get(url.pathname); return route.fulfill({ status: 200, contentType: asset.mime === 'JS' ? 'application/javascript' : 'text/css', body: fs.readFileSync(asset.file) });
      }
      if (url.pathname.startsWith('/space-scene-preview/')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: fs.readFileSync(path.join(web, url.pathname)) });
      return route.continue();
    });
    const page = await context.newPage(), errors = [], gpuErrors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && /THREE|shader|WebGL|reactor/i.test(message.text())) gpuErrors.push(message.text()); });
    page.setDefaultTimeout(20000);
    await page.goto(fixture.base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.Space3D && document.getElementById('conn').textContent === '服务已连接');
    await page.locator('#space3d-entry').click();
    await page.waitForFunction(() => Space3D.stats().renderer?.frameCount > 0);
    assert.equal(await page.evaluate(() => Space3D.stats().page), 'home');
    await page.locator('.sh-action-library').click();
    await page.waitForFunction(() => document.querySelectorAll('.sh-panel-body .sh-track-main').length > 0);
    assert.equal(await page.locator('.sh-panel-body .sh-track-main').count(), tracks.length, 'home library uses the real isolated library');
    await page.keyboard.press('Escape');
    await page.locator('#sh-query').focus();
    await page.locator('.sh-search-modes [data-source="local"]').click();
    await page.locator('#sh-query').fill(tracks[0].title); await page.locator('#sh-query').press('Enter');
    await page.waitForFunction(title => Array.from(document.querySelectorAll('.sh-panel-body .sh-song-title')).some(node => node.textContent.includes(title)), tracks[0].title);
    assert.equal(await page.evaluate(() => Space3D.stats().page), 'home', 'search stays in the space homepage');
    await page.keyboard.press('Escape');
    const card = page.locator('.sh-action-library'), cardBox = await card.boundingBox();
    await page.mouse.move(cardBox.x + cardBox.width * .25, cardBox.y + cardBox.height * .25);
    assert.ok(await card.evaluate(el => parseFloat(el.style.getPropertyValue('--sp-tilt-x')) >= 3), 'home card follows the prototype tilt range');
    assert.ok(await card.evaluate(el => !!el.style.getPropertyValue('--sp-glare-x')), 'home card glare follows pointer position');
    await page.mouse.move(700, 150);
    const accents = await page.locator('.sh-action .sh-eyebrow').evaluateAll(nodes => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d');
      return nodes.map(node => { ctx.fillStyle = getComputedStyle(node).color; ctx.fillRect(0, 0, 1, 1); return Array.from(ctx.getImageData(0, 0, 1, 1).data).join(','); });
    });
    assert.ok(new Set(accents).size >= 4, 'home keeps distinct card accents even when the theme accent is neutral');
    const exit = await page.locator('#sp-return-2d').boundingBox(), recent = await page.locator('.sh-recent').boundingBox();
    assert.ok(exit.x + exit.width <= recent.x || exit.x >= recent.x + recent.width || exit.y + exit.height <= recent.y || exit.y >= recent.y + recent.height, 'home exit never covers a recent track control');
    await page.screenshot({ path: path.join(output, 'home-desktop.png') });
    for (const [width, height] of [[1024,768], [1087,897], [1280,720], [1440,900], [1920,1080]]) {
      await page.setViewportSize({ width, height });
      const layout = await page.locator('#sp-home').evaluate(home => ({ width: home.clientWidth, scrollWidth: home.scrollWidth, height: home.clientHeight, scrollHeight: home.scrollHeight,
        recent: home.querySelector('.sh-recent').getBoundingClientRect().toJSON(), review: home.querySelector('.sh-daily-review').getBoundingClientRect().toJSON(), discovery: home.querySelector('.sh-discovery').getBoundingClientRect().toJSON() }));
      assert.ok(layout.scrollHeight <= layout.height + 1 && layout.scrollWidth <= layout.width, 'desktop homepage fits at ' + width + 'x' + height + ': ' + JSON.stringify(layout));
      assert.equal(layout.recent.x, layout.review.x, 'recent listening stays in the left column');
      assert.ok(Math.max(layout.recent.bottom, layout.discovery.bottom) <= height - 110, 'home content stays above the player at ' + width);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#sp-page-toggle').click();
    await page.locator('#sp-console-toggle').click();
    await page.locator('#sp-source').selectOption('reactor');
    await page.waitForFunction(() => Space3D.stats().renderer?.id === 'reactor' && Space3D.stats().renderer.state === 'ready');
    await page.keyboard.press('Escape');
    await page.mouse.move(700, 150);
    await page.screenshot({ path: path.join(output, 'reactor-desktop.png') });
    assert.equal(await page.locator('#sp-canvas canvas').count(), 1, 'one renderer for home and reactor');
    assert.equal(await page.locator('#sp-reactor-telemetry').isVisible(), true, 'reactor exposes live feedback and gesture hints');
    await page.waitForFunction(() => Number.parseFloat(document.querySelector('[data-reactor-energy]').textContent) > 0);
    assert.match(await page.locator('#sp-reactor-telemetry').textContent(), /粒子反应堆/);
    const burstsBefore = await page.evaluate(() => Space3D.stats().renderer.sceneStats.primary.bursts);
    await page.mouse.dblclick(300, 500, { delay: 60 });
    await page.waitForTimeout(300);
    const burstsAfter = await page.evaluate(() => Space3D.stats().renderer.sceneStats.primary.bursts);
    assert.equal(burstsAfter - burstsBefore, 1, 'double-click reset releases one burst, not two');

    await page.locator('#sp-playlist-toggle').click();
    await page.locator('.sp-queue-row').first().hover();
    await page.waitForTimeout(320);
    assert.notEqual(await page.locator('#sp-scene-hud').getAttribute('data-mode'), 'preview', 'hovering the current row is not a preview');
    const row = page.locator('.sp-queue-item').nth(1);
    await row.hover();
    await until(async () => (await page.locator('#sp-scene-hud .sp-scene-hud-tag').textContent()) === '预览', 'queue hover preview');
    assert.equal(await page.locator('#sp-scene-hud strong').textContent(), tracks[1].title);
    assert.equal((await fixture.api('/v1/state')).track_id, tracks[0].id, 'preview never changes playback');
    await page.screenshot({ path: path.join(output, 'queue-preview.png') });
    await row.click();
    await until(async () => (await fixture.api('/v1/state')).track_id === tracks[1].id, 'real queue playback');
    await row.hover();
    await until(async () => ['正在播放', '当前曲目'].includes(await page.locator('#sp-scene-hud .sp-scene-hud-tag').textContent()), 'current-row HUD');
    assert.equal(await page.locator('#sp-scene-hud').getAttribute('data-mode'), 'current');
    assert.doesNotMatch(await page.locator('#sp-scene-hud small').textContent(), /点击播放/, 'hovering the current row is not a preview');
    await page.keyboard.press('Escape');
    await page.mouse.move(700, 150);
    await page.waitForFunction(() => document.querySelector('#sp-scene-hud').dataset.mode !== 'preview');

    await page.locator('#sp-playlist-toggle').click();
    await page.locator('.sp-queue-item').nth(2).hover();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    assert.notEqual(await page.locator('#sp-scene-hud').getAttribute('data-mode'), 'preview', 'closing queue cancels pending hover dwell');
    const shelf = page.locator('#sp-shelf .s3d-sc[data-id="' + tracks[2].id + '"]');
    async function hoverShelf() {
      await shelf.waitFor({ state: 'visible' });
      const box = await shelf.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    }
    await hoverShelf();
    await page.waitForFunction(() => document.querySelector('#sp-scene-hud').dataset.mode === 'preview');
    assert.equal(await page.locator('#sp-scene-hud strong').textContent(), tracks[2].title, 'shelf uses the same preview recipe');
    await page.evaluate(() => Space3D.configure({ ...Space3D.preferences(), shelfMode: 'off' }));
    await page.waitForTimeout(250);
    assert.notEqual(await page.locator('#sp-scene-hud').getAttribute('data-mode'), 'preview', 'disabling the hovered shelf ends its external preview');
    await page.evaluate(() => Space3D.configure({ ...Space3D.preferences(), shelfMode: 'side' }));
    await page.mouse.move(700, 150);
    await page.waitForFunction(() => document.querySelector('#sp-scene-hud').dataset.mode !== 'preview');

    await page.locator('#sp-console-toggle').click();
    await page.locator('#sp-param-queuePreview').uncheck();
    await page.keyboard.press('Escape');
    await hoverShelf();
    await page.waitForTimeout(250);
    assert.notEqual(await page.locator('#sp-scene-hud').getAttribute('data-mode'), 'preview', 'disabled previews suppress preview feedback');
    await page.mouse.move(700, 150);
    await page.locator('#sp-console-toggle').click();
    await page.locator('#sp-param-queuePreview').check();
    await page.keyboard.press('Escape');
    await page.mouse.move(650, 500); await page.mouse.down();
    await page.waitForFunction(() => document.querySelector('#sp-scene-hud').dataset.mode === 'charge');
    await page.screenshot({ path: path.join(output, 'charge.png') });
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('#sp-scene-hud').dataset.mode !== 'charge');
    const beforeDrag = await page.evaluate(() => Space3D.stats().camera.world);
    await page.mouse.move(650, 500); await page.mouse.down(); await page.mouse.move(780, 540, { steps: 12 }); await page.mouse.up();
    assert.notDeepEqual(await page.evaluate(() => Space3D.stats().camera.world), beforeDrag, 'drag drives the turntable');
    await page.mouse.wheel(0, 300);
    await page.locator('#sp-next').click();
    await until(async () => (await fixture.api('/v1/state')).track_id === tracks[2].id, 'next button switches track');
    await page.waitForFunction(() => document.querySelector('#sp-scene-hud').dataset.mode === 'recipe');
    await page.locator('#sp-prev').click();
    await until(async () => (await fixture.api('/v1/state')).track_id === tracks[1].id, 'previous button switches track');
    await page.locator('#sp-play').click();
    await until(async () => !(await fixture.api('/v1/state')).playing, 'pause');
    await page.mouse.move(20, 150); await page.waitForTimeout(3200);
    const paused = await page.evaluate(() => Space3D.stats().renderer.frameCount);
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => Space3D.stats().renderer.frameCount), paused, 'paused reactor settles and sleeps');
    await page.evaluate(tracks => Space3D.setQueue([...tracks.map(track => ({ ...track, playing: track.id === Stage.presentation().track.id })), { id: 'paused-addition', title: '暂停时加入的曲目' }]), tracks);
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => Space3D.stats().renderer.sceneStats.primary.nodes), tracks.length + 1, 'paused queue additions invalidate the scene without pointer input');
    await page.evaluate(() => {
      const cover = document.createElement('canvas'); cover.width = cover.height = 24;
      const ctx = cover.getContext('2d'); ctx.fillStyle = 'rgb(220,30,40)'; ctx.fillRect(0, 0, 24, 24);
      Stage.setTrack(Stage.presentation().track, cover.toDataURL());
    });
    await page.waitForTimeout(650);
    assert.ok(await page.evaluate(() => { const hue = Space3D.stats().renderer.sceneStats.primary.recipe.hue; return hue < 10 || hue > 350; }), 'same-track cover updates wake hue sampling while paused');
    await page.locator('#sp-page-toggle').click();
    assert.equal(await page.evaluate(() => Space3D.stats().page), 'home');
    assert.equal(await page.locator('#sp-canvas canvas').count(), 1, 'return home preserves renderer');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'home-mobile.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no mobile horizontal overflow');
    await page.locator('#sp-page-toggle').click();
    await page.screenshot({ path: path.join(output, 'reactor-mobile.png') });
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => Space3D.isActive()), false);
    assert.deepEqual(errors, [], 'no page errors'); assert.deepEqual(gpuErrors, [], 'no shader errors');
    console.log('Reactor full app: real library/queue playback, both previews, dwell cancellation, preview settings, gestures, pause and mobile passed; audible output and hardware FPS unmeasured.');
  } catch (error) { console.error(error); throw error; }
  finally { if (browser) await browser.close(); await fixture.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
