'use strict';
// Post-implementation verification against an isolated null-backend service.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { uiToken, uiUrl } = require('./ui-token');
const root = path.resolve(__dirname, '..');
const base = process.env.STAGE_VISUAL_URL || 'http://127.0.0.1:18779';
const out = path.join(root, 'output/playwright/workshop-stage');
const token = uiToken();
async function api(method, endpoint, body) {
  const r = await fetch(base + endpoint, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) });
  assert.ok(r.ok, endpoint + ': ' + r.status);
  return r.status === 204 ? null : r.json();
}
async function main() {
  assert.equal((await fetch(base + '/v1/health').then(r => r.json())).backend, 'null');
  fs.mkdirSync(out, { recursive: true });
  const fixtures = path.join(out, 'fixtures'); fs.mkdirSync(fixtures, { recursive: true });
  const wav = Buffer.alloc(44 + 8000 * 60 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  fs.writeFileSync(path.join(fixtures, 'Workshop Stage Fixture.wav'), wav);
  fs.writeFileSync(path.join(fixtures, 'Workshop Stage Fixture.lrc'), '[00:00.00]晚风吹过你的眼睛\n[00:05.00]把星光画进这一页\n[00:10.00]听见远方温柔的回声\n[00:17.00]让每一颗星都有颜色\n[00:22.00]我们沿着星光继续向前走\n');
  await api('POST', '/v1/library/scan', { root: fixtures });
  let track;
  for (let i = 0; i < 60 && !track; i++) {
    track = (await api('GET', '/v1/tracks?limit=200')).tracks.find(t => t.title === 'Workshop Stage Fixture');
    if (!track) await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(track);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  // Routed working-tree documents have no network address-space classification.
  // Grant this isolated test context access to its own loopback backend.
  const browserSession = await page.context().newCDPSession(page);
  await browserSession.send('Browser.setPermission', {
    permission: { name: 'local-network-access' }, setting: 'granted', origin: base
  });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const networkErrors = [];
  page.on('response', response => {
    const pathname = new URL(response.url()).pathname;
    if (response.status() >= 400) networkErrors.push(pathname + ': ' + response.status());
  });
  page.on('websocket', socket => socket.on('socketerror', message => {
    networkErrors.push('WebSocket: ' + String(message).replace(/\?\S+/g, '?<redacted>'));
  }));
  // The backend is isolated. Serve the exact working-tree UI unless packaged verification is requested.
  if (process.env.WORKSHOP_PACKAGED !== '1') await page.route(base + '/**', async route => {
    const url = new URL(route.request().url());
    const name = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.resolve(root, 'plugin/ui', '.' + name);
    if (!file.startsWith(path.join(root, 'plugin/ui') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.continue();
    if (name === '/index.html') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(file, 'utf8').replace('__VMUSIC_TOKEN_VALUE__', token) });
    return route.fulfill({ path: file });
  });
  try {
    await page.goto(uiUrl(base));
    await page.waitForFunction(() => window.Workshop && document.getElementById('conn').textContent === '服务已连接');
    await api('POST', '/v1/player/load', { track_id: track.id, queue: [track.id] });
    await api('POST', '/v1/player/pause');
    await api('POST', '/v1/player/seek', { position_ms: 7500 });
    await page.waitForFunction(id => Stage.presentation().track?.id === id && Stage.lyrics()?.lines?.length >= 5, track.id);
    await page.evaluate(() => {
      Theme.apply('mono');
      window.__creativeFrames = [];
      const original = CreativeGL.create;
      CreativeGL.create = (...args) => {
        const engine = original(...args), render = engine.render;
        engine.render = state => {
          window.__creativeFrames.push({ scene: state.scene, t: state.t, bloom: state.post.bloom, dist: state.cam.dist, energy: state.energy, bands: Array.from(state.bands) });
          if (window.__creativeFrames.length > 80) window.__creativeFrames.shift();
          return render(state);
        }; return engine;
      };
      Stage3D.configure({ stanzaVisual: 'tempera', stanzaBg: 'solid', shelfMode: 'off' });
      Workshop.open(); Workshop.setTab('scene'); CreativeStage.setDirector(false);
    });
    await page.waitForFunction(() => CreativeStage.stageActive() && document.querySelector('.fl-tempera-canvas'));
    assert.equal(await page.locator('#ws-preview').count(), 0);
    assert.equal(await page.locator('#ws-expand').count(), 0);
    assert.equal(await page.evaluate(() => Stage3D.preferences().sceneSource), 'creative');
    const cards = page.locator('#ws-body .ws-scene-card');
    assert.ok(await cards.count() >= 4);
    const scene = await cards.nth(1).getAttribute('data-scene');
    await cards.nth(1).click();
    await page.waitForFunction(id => __creativeFrames.at(-1)?.scene === id, scene);
    await page.evaluate(() => CreativeStage.setParam('look.bloom', 0));
    await page.waitForFunction(() => __creativeFrames.at(-1)?.bloom === 0);
    const before = await page.locator('#s3d-creative').screenshot();
    await page.evaluate(() => CreativeStage.setParam('cam.dist', 6));
    await page.waitForTimeout(1100);
    const after = await page.locator('#s3d-creative').screenshot();
    assert.notDeepEqual(before, after, 'paused camera adjustment changes actual stage pixels');
    console.log('PASS real creative engine, scene selection and paused parameter pixels');
    await page.evaluate(() => {
      CreativeStage.patch({ 'look.exposure': 1, 'look.bloom': 0, 'cam.dist': 15 });
      CreativeStage.addCue({ at: 5, len: 1000, ease: 'linear', set: { 'look.exposure': 1.8 } });
      CreativeStage.addCue({ at: 10, len: 1000, ease: 'linear', set: { 'look.exposure': 0.6 } });
    });
    for (const [ms, value] of [[5500, 1.4], [7500, 1.8], [10500, 1.2], [2000, 1]]) {
      await api('POST', '/v1/player/seek', { position_ms: ms });
      await page.waitForFunction(v => Math.abs(CreativeStage.runtime()['look.exposure'] - v) < 0.015, value);
    }
    console.log('PASS timed cue interpolation, holding, overlap and backward seek');
    await api('POST', '/v1/player/seek', { position_ms: 7500 });
    await page.evaluate(() => {
      CreativeStage.setBackground({ type: 'mesh', opacity: 45, blur: 28 });
      CreativeStage.setHandDrawn({ on: true, style: 'manga', paper: true, frame: true, wave: true, jitter: 55 });
      Workshop.setTab('look');
    });
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.getElementById('creative-bg').parentElement.id), 's3d-creative');
    assert.equal(await page.evaluate(() => HandDrawn.stats().host), 's3d-art-overlay');
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('hand-on')), false);
    assert.equal(await page.evaluate(() => HandDrawn.stats().fps), 0);
    const frames = await page.locator('.s3d-art-overlay .hd-frame').getAttribute('d');
    assert.ok(frames.length > 100);
    await page.screenshot({ path: path.join(out, 'manga-editor.png') });
    await page.evaluate(() => CreativeStage.setHandDrawn({ ...CreativeStage.preset().hand, style: 'color' }));
    await page.screenshot({ path: path.join(out, 'color-editor.png') });
    await page.evaluate(() => Workshop.close());
    assert.equal(await page.evaluate(() => Stage3D.isActive() && CreativeStage.stageActive()), true);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, 'stage-performance.png') });
    console.log('PASS manga host, actual background, paused frame and continuing performance');
    for (let i = 0; i < 3; i++) await page.evaluate(() => { Stage3D.close(); Stage3D.open(); });
    assert.equal(await page.locator('#s3d-creative .creative-canvas').count(), 1);
    assert.equal(await page.locator('.hd-layer').count(), 1);
    assert.equal(await page.locator('#creative-bg').count(), 1);
    await page.evaluate(() => { Workshop.open(); Workshop.setTab('look'); });
    await page.setViewportSize({ width: 600, height: 900 });
    await page.waitForTimeout(350);
    const bounds = await page.evaluate(() => ({ stage: document.getElementById('s3d-creative').getBoundingClientRect().toJSON(), panel: document.getElementById('workshop').getBoundingClientRect().toJSON() }));
    assert.ok(bounds.stage.bottom <= bounds.panel.top + 2);
    await page.screenshot({ path: path.join(out, 'mobile-editor.png') });
    await page.evaluate(() => { Workshop.close(); Stage3D.close(); });
    assert.equal(await page.locator('#s3d-creative .creative-canvas').count(), 0);
    assert.equal(await page.evaluate(() => document.getElementById('creative-bg').parentElement.tagName), 'BODY');
    assert.equal(await page.evaluate(() => HandDrawn.stats().host), 'stage');
    assert.deepEqual(errors, []);
    console.log('PASS reopen lifecycle, mobile layout, restoration and no page errors');
  } catch (error) {
    console.error('Browser errors:', errors);
    console.error('Network errors:', networkErrors);
    console.error('Visible status:', await page.locator('body').innerText().then(s => s.slice(0, 1600)).catch(() => 'unavailable'));
    await page.screenshot({ path: path.join(out, 'failure.png') });
    throw error;
  } finally { await browser.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
