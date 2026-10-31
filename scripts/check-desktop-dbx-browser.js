// SPDX-License-Identifier: MIT
// DBX renderer contract against the actual bundled pages. No player or user data.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'crates/hertz-desktop/assets');
const read = name => fs.readFileSync(path.join(assets, name), 'utf8');
const lyrics = '<!doctype html><html><meta charset="utf-8"><style>' + read('desktop-lyrics.css') + '</style><body>' + read('desktop-lyrics.html') + '<script>' + read('desktop-lyrics.js') + '</script></body></html>';
const wallpaper = read('wallpaper-scene.html')
  .replace('__RUNTIME__', fs.readFileSync(path.join(root, 'plugin/ui/vendor/stage-runtime.js'), 'utf8'))
  .replace('__SHIM__', fs.readFileSync(path.join(root, 'plugin/ui/vendor/zodiac-stage.js'), 'utf8'))
  .replace('__SCENE__', read('wallpaper-scene.js'));
async function main() {
  const server = http.createServer((request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(request.url === '/wallpaper' ? wallpaper : lyrics); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-webgl'] });
  const page = await browser.newPage({ viewport: { width: 550, height: 500 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.addInitScript(() => { window.requests = []; window.ipc = { postMessage: text => { try { requests.push(JSON.parse(text)); } catch (_) { requests.push({ event: text }); } } }; });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(() => {
      window.snapshot = { protocol: 1, seq: 1, server: { session: 'fixture' }, generation: '1', positionMs: 1100, durationMs: 10000, playing: false, buffering: false, track: { id: 'fixture' }, lyrics: { status: 'ready', documentKey: 'fixture' } };
      window.documentFixture = { protocol: 1, documentKey: 'fixture', lines: [0, 1000, 2000].map((startMs, i) => ({ startMs, endMs: startMs + 1000, text: 'line ' + i })) };
      window.loadSnapshot = (age = 0, queued = 0) => { snapshot.seq++; snapshot.snapshotAgeMs = age; snapshot.pageDispatchMs = performance.now() - queued; hertzLyrics.applySnapshot(structuredClone(snapshot)); };
      hertzLyrics.applyConfig({ enabled: true, locked: false }); hertzLyrics.setSource({ state: 'ok' }); loadSnapshot();
      window.documentDeliveries = 0; window.deliverDocument = () => { documentDeliveries++; hertzLyrics.applyDocument(structuredClone(documentFixture)); }; deliverDocument();
    });
    assert.equal(await page.locator('#play').isEnabled(), true, 'legacy standalone payload defaults to control enabled');
    await page.evaluate(() => hertzLyrics.setSource({ state: 'ok', capabilities: { lyricsControl: false } }));
    for (const id of ['play', 'previous', 'next']) { assert.equal(await page.locator('#' + id).isDisabled(), true); assert.match(await page.locator('#' + id).getAttribute('title'), /DBX/); }
    const controls = () => page.evaluate(() => requests.filter(r => ['play', 'pause', 'seek'].includes(r.cmd)).length);
    const before = await controls();
    await page.locator('#stage').click({ position: { x: 20, y: 20 } });
    await page.keyboard.press('Space'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight');
    assert.equal(await controls(), before, 'DBX keyboard paths never emit playback operations');
    await page.locator('#style-open').evaluate(button => button.click());
    assert.equal(await page.locator('#options-panel').isVisible(), true, 'DBX styles remain available');
    await page.locator('#options-done').click();
    await page.evaluate(() => { hertzLyrics.setSource({ state: 'ok', capabilities: { lyricsControl: true } }); loadSnapshot(); });
    assert.equal(await page.locator('#play').isEnabled(), true, 'switching to standalone restores playback');
    await page.locator('#play').evaluate(button => button.click());
    assert.equal(await controls(), before + 1);
    await page.evaluate(() => { snapshot.generation = '2'; loadSnapshot(); hertzLyrics.controlDone(''); const wall = Date.now; Date.now = () => wall() - 3600000; loadSnapshot(1800, 300); Date.now = wall; });
    assert.equal(await page.locator('.lyric-group').count(), 0, 'transport and native/page queue consume the existing two-second lyric budget');
    await page.evaluate(() => loadSnapshot(1700, 0));
    assert.ok(await page.locator('.lyric-group').count() > 0);
    await page.waitForTimeout(380);
    assert.equal(await page.locator('.lyric-group').count(), 0, 'delayed delivery does not start another full freshness lifetime');
    await page.evaluate(() => loadSnapshot(3100, 0));
    assert.equal(await page.locator('.lyric-group').count(), 0, 'replayed cache preserves source age');
    await page.evaluate(() => loadSnapshot());
    assert.ok(await page.locator('.lyric-group').count() > 0, 'fresh same-key snapshot restores the page cache without another document delivery');
    await page.evaluate(() => { for (let i = 0; i < 10; i++) loadSnapshot(); });
    assert.equal(await page.evaluate(() => documentDeliveries), 1, 'normal snapshots preserve native document deduplication');
    assert.ok(await page.locator('.lyric-group').count() > 0);
    // A queued expired message for another key or session must discard the old cache.
    await page.evaluate(() => { snapshot.lyrics.documentKey = 'new-key'; loadSnapshot(3100); loadSnapshot(); });
    assert.equal(await page.locator('.lyric-group').count(), 0, 'a new key never restores the preceding document');
    await page.evaluate(() => { hertzLyrics.applyDocument(documentFixture); });
    assert.equal(await page.locator('.lyric-group').count(), 0, 'late old-key document is rejected');
    await page.evaluate(() => { documentFixture.documentKey = 'new-key'; deliverDocument(); snapshot.server.session = 'new-session'; loadSnapshot(3100); loadSnapshot(); });
    assert.equal(await page.locator('.lyric-group').count(), 0, 'a new session cannot reuse even the same-key page cache');
    await page.evaluate(() => deliverDocument());
    assert.ok(await page.locator('.lyric-group').count() > 0);
    await page.evaluate(() => { loadSnapshot(3100); loadSnapshot(); });
    assert.ok(await page.locator('.lyric-group').count() > 0, 'the current session/key cache survives only a single-message freshness failure');
    assert.equal(await page.evaluate(() => documentDeliveries), 3);
    await page.waitForTimeout(1500);
    await page.evaluate(() => { snapshot.snapshotAgeMs = 0; snapshot.pageDispatchMs = performance.now(); hertzLyrics.applySnapshot(structuredClone(snapshot)); });
    await page.waitForTimeout(600);
    assert.equal(await page.locator('.lyric-group').count(), 0, 'duplicate sequence does not refresh source lifetime');

    await page.goto('http://127.0.0.1:' + server.address().port + '/wallpaper');
    await page.evaluate(() => { hertzWallpaper.applyConfig({ source: 'fixed', scene: 'zodiac' }); hertzWallpaper.mount(); hertzWallpaper.start(30); });
    await page.waitForFunction(() => hertzWallpaper.debug().mounted, null, { timeout: 10000 }).catch(async () => { throw new Error(JSON.stringify({ state: await page.evaluate(() => hertzWallpaper.debug()), errors })); });
    await page.evaluate(() => {
      window.wallpaperSnapshot = { valid: true, playing: true, positionMs: 2000, durationMs: 10000, spectrum: { bands: Array(64).fill(1), energy: 1, ageMs: 100 }, snapshotAgeMs: 650, pageDispatchMs: performance.now() - 150 };
      hertzWallpaper.applyFeed(wallpaperSnapshot);
    });
    assert.ok(await page.evaluate(() => hertzWallpaper.debug().ageMs >= 900), 'spectrum retains server age plus full request and UI queue age');
    assert.ok(await page.evaluate(() => hertzWallpaper.debug().feedPeak <= .21), 'old spectrum is decayed on its first frame');
    await page.evaluate(() => { wallpaperSnapshot.snapshotAgeMs = 2600; wallpaperSnapshot.pageDispatchMs = performance.now(); hertzWallpaper.applyFeed(wallpaperSnapshot); });
    await page.waitForFunction(() => hertzWallpaper.debug().valid === false, null, { timeout: 1000 });
    assert.equal(await page.evaluate(() => hertzWallpaper.debug().valid), false, 'wallpaper expires independently while ambient renderer stays mounted');
    assert.equal(await page.evaluate(() => hertzWallpaper.debug().mounted), true);
    await page.evaluate(() => { wallpaperSnapshot.snapshotAgeMs = 2000; wallpaperSnapshot.pageDispatchMs = performance.now() - 1100; hertzWallpaper.applyFeed(wallpaperSnapshot); });
    assert.equal(await page.evaluate(() => hertzWallpaper.debug().valid), false, 'queued stale wallpaper never gets another full lifetime');
    assert.deepEqual(errors, []);
    console.log('DBX renderer checks passed: readonly controls and recovery, conservative request/queue/cache age, duplicate seq, spectrum age, independent wallpaper TTL.');
  } finally { await browser.close(); server.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
