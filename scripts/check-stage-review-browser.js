// SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { runtimePage } = require('./stage-runtime-fixture');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('crates/hertz-desktop/assets/wallpaper-scene.html')
  .replace('__GL_BUDGET__', () => read('crates/hertz-desktop/assets/wallpaper-gl-budget.js'))
  .replace('__SCENE__', () => read('crates/hertz-desktop/assets/wallpaper-scene.js'));
const imageUrl = `https://${'a'.repeat(32)}.${'b'.repeat(32)}.wallpaper.invalid/files/still.png`;
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=', 'base64');
const output = path.join(root, 'output/playwright/stage-review');

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const results = [], errors = [];
  async function pageFor() {
    const page = await runtimePage(browser, { viewport: { width: 640, height: 360 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.events = []; window.ipc = { postMessage: text => events.push(text) }; });
    await page.route(imageUrl, route => route.fulfill({ contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: imageBytes }));
    await page.route('http://stage.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://stage.test/');
    return page;
  }
  const stats = page => page.evaluate(() => hertzWallpaper.debug());
  async function settled(page, label) {
    await page.waitForTimeout(250);
    const before = await stats(page);
    await page.waitForFunction(ticks => hertzWallpaper.debug().ticks > ticks + 5, before.ticks, { timeout: 15000 });
    await page.waitForTimeout(350);
    const after = await stats(page);
    assert.equal(after.draws, before.draws, label);
    assert(after.ticks > before.ticks, 'heartbeat/feed clock continues while GPU submissions stop: ' + JSON.stringify({ label, before, after }));
    results.push({ label, draws: after.draws, idleTicks: after.ticks - before.ticks });
    return after;
  }
  try {
    const page = await pageFor(), requests = [];
    page.on('request', request => { if (request.url().includes('/vendor/')) requests.push(request.url()); });
    await page.evaluate(url => {
      hertzWallpaper.applyConfig({ source: 'fixed', scene: 'reactor', motion: 0, musicResponse: false, quality: 'high' });
      hertzWallpaper.applyMedia({ kind: 'image', url }); hertzWallpaper.start(30);
    }, imageUrl);
    await page.waitForFunction(() => hertzWallpaper.debug().media?.state === 'ready');
    assert.equal(await page.evaluate(() => typeof HertzStageRuntime), 'undefined');
    assert.equal(requests.length, 0, 'static image loads no runtime or scene assets');
    results.push({ label: 'static image', runtimeRequests: requests.length, pageBytes: Buffer.byteLength(html) });
    await page.evaluate(() => hertzWallpaper.applyMedia(null));
    await page.waitForFunction(() => hertzWallpaper.debug().draws > 0);
    let before = await settled(page, 'frozen builtin submits only its first frame');
    assert.equal(before.stats.effectiveQuality, 'high');
    assert.equal(requests.length, 1, 'ordinary scene loads runtime without Phoenix or Basis');
    await page.setViewportSize({ width: 700, height: 400 });
    await page.waitForFunction(draws => hertzWallpaper.debug().draws > draws, before.draws);
    before = await settled(page, 'resize redraws once then rests');
    await page.evaluate(() => hertzWallpaper.applyConfig({ source: 'fixed', params: { density: .4 } }));
    await page.waitForFunction(draws => hertzWallpaper.debug().draws > draws, before.draws);
    before = await settled(page, 'parameter edit redraws then rests');
    await page.evaluate(() => {
      hertzWallpaper.applyConfig({ source: 'fixed', musicResponse: true });
      hertzWallpaper.applyFeed({ valid: true, playing: true, positionMs: 5000,
        spectrum: { bands: Array(64).fill(.6), energy: .6, ageMs: 0 } });
    });
    await page.waitForFunction(draws => hertzWallpaper.debug().draws > draws + 2, before.draws);
    await page.evaluate(() => hertzWallpaper.applyConfig({ source: 'fixed', musicResponse: false }));
    before = await settled(page, 'disabling audio returns to rest');
    await page.evaluate(() => hertzWallpaper.applyConfig({ source: 'fixed', motion: 1 }));
    await page.waitForFunction(draws => hertzWallpaper.debug().draws > draws + 2, before.draws);
    await page.evaluate(() => hertzWallpaper.applyConfig({ source: 'fixed', motion: 0, scene: 'zodiac' }));
    await page.waitForFunction(() => hertzWallpaper.debug().scene === 'zodiac' && hertzWallpaper.debug().mounted);
    before = await settled(page, 'frozen zodiac rests');
    await page.evaluate(() => { hertzWallpaper.stop(); hertzWallpaper.start(30); });
    await page.waitForFunction(draws => hertzWallpaper.debug().draws > draws, before.draws);
    await settled(page, 'resume restores a frozen frame');
    await page.evaluate(() => hertzWallpaper.applyConfig({ source: 'fixed', scene: 'phoenix-vortex' }));
    await page.waitForFunction(() => hertzWallpaper.debug().scene === 'phoenix-vortex' && hertzWallpaper.debug().draws > 0);
    await settled(page, 'Phoenix prepares artwork before its frozen first frame');
    assert.equal(requests.filter(url => url.endsWith('phoenix-reference-data.json')).length, 1);
    assert.equal(requests.filter(url => url.includes('basis_transcoder')).length, 0);
    await page.close();

    // Hold the actual runtime response while media replaces the scene request.
    const racing = await pageFor(); let release, arrived;
    const requested = new Promise(resolve => { arrived = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    await racing.route('**/vendor/stage-runtime.js', async route => { arrived(); await held; await route.fallback(); });
    await racing.evaluate(() => { hertzWallpaper.start(30); hertzWallpaper.start(30); });
    await requested;
    await racing.evaluate(url => hertzWallpaper.applyMedia({ kind: 'image', url }), imageUrl);
    release();
    await racing.waitForFunction(() => !!window.HertzStageRuntime && hertzWallpaper.debug().media?.state === 'ready');
    assert.equal((await stats(racing)).backend, 'media', 'late runtime cannot replace selected media');
    assert.equal(await racing.locator('#host canvas').count(), 0);
    assert.equal(await racing.evaluate(() => events.includes('wallpaper_mount_failed')), false, 'cancelled load does not report a false mount failure');
    await racing.close(); results.push({ label: 'runtime cancellation keeps the newer media selection' });

    const retrying = await pageFor();
    await retrying.route('**/vendor/stage-runtime.js', route => route.abort(), { times: 1 });
    await retrying.evaluate(() => hertzWallpaper.start(30));
    await retrying.waitForFunction(() => events.includes('wallpaper_mount_failed'));
    await retrying.evaluate(() => {
      hertzWallpaper.applyConfig({ source: 'fixed', scene: 'reactor', motion: 0, musicResponse: false });
      hertzWallpaper.start(30);
    });
    await retrying.waitForFunction(() => hertzWallpaper.debug().draws > 0);
    assert.equal((await stats(retrying)).scene, 'reactor');
    await retrying.close(); results.push({ label: 'failed runtime load can retry without stale loading state' });

    const followed = await pageFor(); let deliverRuntime, runtimeRequested;
    const runtimeArrived = new Promise(resolve => { runtimeRequested = resolve; });
    const runtimeHeld = new Promise(resolve => { deliverRuntime = resolve; });
    await followed.route('**/vendor/stage-runtime.js', async route => { runtimeRequested(); await runtimeHeld; await route.fallback(); });
    await followed.evaluate(() => hertzWallpaper.start(30));
    await runtimeArrived;
    await followed.evaluate(() => {
      hertzWallpaper.applyConfig({ source: 'follow', motion: 0, musicResponse: false });
      hertzWallpaper.applyFeed({ valid: true, playing: false, positionMs: 0,
        spectrum: { bands: Array(64).fill(0), energy: 0, ageMs: 0 }, space: { scene: 'reactor', params: {} } });
    });
    deliverRuntime();
    await followed.waitForFunction(() => hertzWallpaper.debug().draws > 0);
    assert.equal((await stats(followed)).scene, 'reactor', 'latest followed selection wins during runtime loading');
    await followed.close(); results.push({ label: 'configuration and followed scene changes during loading' });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ results, errors }, null, 2));
    console.log(`Stage review browser checks passed: ${results.length} cases`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
