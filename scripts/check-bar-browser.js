'use strict';

// Post-change acceptance against a dedicated null backend and workspace assets.
// VMUSIC_DATA_DIR=<isolated data> BAR_UI_URL=http://127.0.0.1:18781
// PLAYWRIGHT_MODULE=<playwright module> node scripts/check-bar-browser.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { uiToken, uiUrl } = require('./ui-token');
const root = path.resolve(__dirname, '..');
const web = path.join(root, 'plugin/ui');
const output = path.join(root, 'output/playwright/bar');
const base = process.env.BAR_UI_URL || 'http://127.0.0.1:18781';
const token = uiToken();
let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; console.log('PASS ' + label); }
async function api(method, endpoint, body) {
  const response = await fetch(base + endpoint, {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(response.ok, `${method} ${endpoint}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function ready(page) {
  await page.goto(uiUrl(base));
  await page.waitForFunction(() => document.getElementById('bar-favorite').onclick && window.Skins);
  await page.waitForFunction(() => document.getElementById('conn').textContent === '服务已连接');
}
async function favoriteReady(page) { await page.waitForFunction(() => !document.getElementById('bar-favorite').disabled); }
async function workspaceAssets(route) {
  const url = new URL(route.request().url());
  const relative = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html';
  const file = path.resolve(web, relative);
  if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.continue();
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
  let body = fs.readFileSync(file);
  if (relative === 'index.html') body = body.toString().replace('__VMUSIC_TOKEN_VALUE__', token);
  return route.fulfill({ body, contentType: types[path.extname(file)] || 'application/octet-stream' });
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  check((await api('GET', '/v1/health')).backend === 'null', 'isolated silent backend');
  const fixture = path.join(output, 'fixtures');
  fs.mkdirSync(fixture, { recursive: true });
  const wav = Buffer.alloc(44 + 8000 * 300 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  fs.writeFileSync(path.join(fixture, '控制台验收 · 本地歌曲.wav'), wav);
  await api('POST', '/v1/library/scan', { root: fixture });
  let tracks = [];
  for (let i = 0; i < 100 && !tracks.length; i++) {
    tracks = (await api('GET', '/v1/tracks?limit=200')).tracks;
    if (!tracks.length) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(tracks.length);
  const track = tracks[0];
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    // Workspace routing makes Chrome request local-network permission for WS.
    await page.context().grantPermissions(['local-network-access'], { origin: base });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(base + '/**', workspaceAssets);
    await ready(page);
    await api('POST', '/v1/player/load', { track_id: track.id, queue: [track.id] });
    await favoriteReady(page);
    for (const skin of ['classic', 'sheen', 'workbench', 'liunian', 'qingfeng', 'ios']) {
      for (const width of [1440, 1024, 390, 320]) {
        await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
        await page.evaluate(value => Skins.apply(value), skin);
        const favorite = page.locator('#bar-favorite');
        await favoriteReady(page);
        const box = await favorite.boundingBox();
        const title = await page.locator('#bar-title').boundingBox();
        check(box && box.width >= 32 && box.x >= 0 && box.x + box.width <= width + 1 && title?.width >= 35,
          `${skin} ${width}: favorite and song title visible ${JSON.stringify({ box, title })}`);
        const previous = await favorite.getAttribute('aria-pressed');
        await favorite.click();
        await favoriteReady(page);
        check(await favorite.getAttribute('aria-pressed') !== previous, `${skin} ${width}: favorite toggles`);
        if (skin === 'liunian') {
          await page.locator('.ln-capsule-toggle').click();
          check(await favorite.isVisible(), `${skin} ${width}: favorite survives player-card folding`);
          await page.locator('.ln-capsule-toggle').click();
        } else {
          await page.locator('#bar-pin-toggle').click();
          check(!await page.locator('.bar').isVisible() && await page.locator('#bar-restore').isVisible(), `${skin} ${width}: collapse and visible restore`);
          await page.locator('#bar-restore').hover();
          check(!await page.locator('.bar').isVisible(), `${skin} ${width}: hover respects collapse`);
          await page.keyboard.press('Enter');
          check(await page.locator('.bar').isVisible() && !await page.locator('#bar-restore').isVisible(), `${skin} ${width}: keyboard restores`);
        }
        if (width === 1440 || width === 390) await page.screenshot({ path: path.join(output, `${skin}-${width}.png`) });
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => Skins.apply('classic'));
    // Restore remains accessible after refresh and switching to/from the inline skin.
    await page.locator('#bar-pin-toggle').click();
    await ready(page);
    check(await page.locator('#bar-restore').isVisible(), 'collapsed preference survives reload');
    await page.evaluate(() => document.body.classList.add('s3d-open'));
    check(!await page.locator('#bar-restore').isVisible(), 'immersive stage hides the restore entry');
    await page.evaluate(() => document.body.classList.remove('s3d-open'));
    await page.evaluate(() => { Skins.apply('qingfeng'); document.body.classList.add('qf-lattice-open'); });
    check(!await page.locator('#bar-restore').isVisible(), 'poster wall hides the restore entry');
    await page.evaluate(() => document.body.classList.remove('qf-lattice-open'));
    await page.evaluate(() => Skins.apply('liunian'));
    check(await page.locator('.bar').isVisible() && !await page.locator('#bar-restore').isVisible(), 'inline skin has one folding owner');
    await page.evaluate(() => Skins.apply('classic'));
    await page.locator('#bar-restore').click();
    for (let i = 0; i < 8; i++) {
      await page.locator('#bar-pin-toggle').click();
      await page.locator('#bar-restore').click();
    }
    await page.mouse.move(30, 80);
    await page.waitForTimeout(16000);
    check(await page.locator('.bar').isVisible(), 'rapid toggles and 16 seconds idle preserve explicit state');
    // Exercise online metadata rendering and the real favorite API without requesting a stream.
    const online = { id: 'online:netease:bar-check', source: 'netease', onlineId: 'bar-check', title: '控制台验收 · 在线歌曲', artist: '验收歌手', album: '验收专辑' };
    await page.evaluate(value => Online.paintNowPlaying(value, null), online);
    await favoriteReady(page);
    const previous = await page.locator('#bar-favorite').getAttribute('aria-pressed');
    await page.locator('#bar-favorite').click();
    await favoriteReady(page);
    const membership = await api('POST', '/v1/favorites/membership', { kind: 'track', source: online.source, ids: [online.onlineId] });
    check(membership.ids.includes(online.onlineId) === (previous === 'false'), 'online favorite uses provider identity');
    // An API error must roll back the heart and leave it operable.
    const beforeFailure = await page.locator('#bar-favorite').getAttribute('aria-pressed');
    await page.route('**/v1/favorites/toggle', route => route.fulfill({ status: 500, json: { error: 'acceptance failure' } }));
    await page.locator('#bar-favorite').click();
    await favoriteReady(page);
    check(await page.locator('#bar-favorite').getAttribute('aria-pressed') === beforeFailure, 'failed favorite rolls back');
    await page.unroute('**/v1/favorites/toggle');
    // A delayed write belongs to the clicked song, even if another song is shown.
    let releaseWrite;
    let receivedWrite;
    let writes = 0;
    const writeGate = new Promise(resolve => { releaseWrite = resolve; });
    const writeReceived = new Promise(resolve => { receivedWrite = resolve; });
    await page.route('**/v1/favorites/toggle', async route => {
      writes++;
      receivedWrite();
      await writeGate;
      await route.continue();
    });
    await page.locator('#bar-favorite').click();
    await writeReceived;
    await page.locator('#bar-favorite').dispatchEvent('click');
    check(writes === 1 && await page.locator('#bar-favorite').isDisabled(), 'pending favorite cannot be double-submitted');
    await page.evaluate(value => setBarFavoriteTrack(value), track);
    await favoriteReady(page);
    const localState = await page.locator('#bar-favorite').getAttribute('aria-pressed');
    releaseWrite();
    await page.waitForFunction(() => barFavoritePending.size === 0);
    check(await page.locator('#bar-favorite').getAttribute('aria-pressed') === localState, 'late write cannot repaint a different song');
    await page.unroute('**/v1/favorites/toggle');
    // A late membership response must not enable or recolor the next song.
    let releaseRead;
    let receivedRead;
    const readGate = new Promise(resolve => { releaseRead = resolve; });
    const readReceived = new Promise(resolve => { receivedRead = resolve; });
    await page.route('**/v1/favorites/membership', async route => {
      if (!route.request().postDataJSON().ids.includes('delayed-read')) return route.continue();
      receivedRead();
      await readGate;
      await route.fulfill({ json: { ids: ['delayed-read'] } });
    });
    await page.evaluate(value => Online.paintNowPlaying({ ...value, id: 'online:netease:delayed-read', onlineId: 'delayed-read' }, null), online);
    await readReceived;
    await page.evaluate(value => setBarFavoriteTrack(value), track);
    await favoriteReady(page);
    releaseRead();
    await page.waitForFunction(() => Favorites.has('track', 'netease', 'delayed-read'));
    check(await page.locator('#bar-favorite').getAttribute('aria-pressed') === localState, 'late membership cannot repaint a different song');
    await page.unroute('**/v1/favorites/membership');
    // Changes made from an existing library heart are reflected by the player.
    await page.evaluate(() => setView('library'));
    const libraryHeart = page.locator('#lib-list [data-act="fav"]').first();
    await libraryHeart.locator('..').locator('..').hover();
    await libraryHeart.click();
    await page.waitForFunction(previous => document.getElementById('bar-favorite').getAttribute('aria-pressed') !== previous, localState);
    check(true, 'library favorite updates player heart');
    const persisted = await page.locator('#bar-favorite').getAttribute('aria-pressed');
    await ready(page);
    await favoriteReady(page);
    check(await page.locator('#bar-favorite').getAttribute('aria-pressed') === persisted, 'favorite state survives reload');
    await page.evaluate(() => setBarFavoriteTrack(null));
    check(await page.locator('#bar-favorite').isDisabled(), 'empty player disables favorite');
    check(errors.length === 0, 'no browser exceptions: ' + errors.join('; '));
    console.log(`${checks} browser checks passed`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
