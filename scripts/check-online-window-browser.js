#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, 'plugin/ui', file), 'utf8');
async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.setContent('<main class="opl-detail" style="height:800px;width:100%"><input id="opl-detail-q"><div class="opl-detail-body"><aside id="opl-info"></aside><div class="opl-tracks"><div id="opl-head"></div><div id="opl-rows" class="opl-rows"></div><button id="opl-more" hidden>More</button><div id="opl-sentinel" hidden></div></div></div></main>');
    for (const file of ['style.css', 'online.css']) await page.addStyleTag({ content: read(file) });
    await page.addScriptTag({ content: 'window.__loads=0;window.__plays=[];window.VMusicTransport={get:async()=>{__loads++;return {tracks:Array.from({length:50},(_,i)=>({id:String(5000+i),source:"netease",title:"Track "+(5000+i),playable:true})),total:5050}}};' });
    for (const file of ['online.js', 'online-playlist-view.js']) await page.addScriptTag({ content: read(file) });
    await page.evaluate(() => {
      Online.bind({ fmt: () => '3:00', paintArt() {}, state: {} });
      Online.playAll = (list, index) => __plays.push({ count: list.length, index, id: list[index].id });
      OnlinePlaylistView.bind({ caps: () => [] });
    });
    for (const count of [1000, 5000]) for (const mode of ['list', 'cover']) {
      const result = await page.evaluate(({ count, mode }) => {
        const s = OnlinePlaylistView.state;
        s.tracks = Array.from({ length: count }, (_, i) => ({ id: String(i), source: 'netease', title: 'Track ' + i, artist: 'Artist', album: 'Album', duration_ms: 180000, playable: true }));
        Object.assign(s, { phase: 'ready', kind: 'playlist', total: count, source: 'netease', subject: { id: 'p', name: 'Fixture' }, trackQuery: '' });
        const t = performance.now(); OnlinePlaylistView.setMode(mode);
        const box = document.getElementById('opl-rows'); box.scrollTop = 0;
        const height = box.scrollHeight;
        return { count, mode, renderMs: +(performance.now() - t).toFixed(2), rows: box.querySelectorAll('.track,.opl-track-card').length, descendants: box.querySelectorAll('*').length, scrollHeight: height };
      }, { count, mode });
      console.log(JSON.stringify(result));
      assert.ok(result.rows < 200, 'long collection must use a bounded DOM window');
      await page.locator('#opl-rows').evaluate((box) => { box.scrollTop = box.scrollHeight; });
      await page.waitForFunction((last) => !!document.querySelector('[data-opl-index="' + last + '"]'), count - 1);
      await page.locator('[data-opl-index="' + (count - 1) + '"]').click();
      assert.deepEqual(await page.evaluate(() => __plays.at(-1)), { count, index: count - 1, id: String(count - 1) });
      const last = page.locator('[data-opl-index="' + (count - 1) + '"]'); await last.focus();
      await page.locator('#opl-rows').evaluate((box) => { box.scrollTop = 0; });
      await page.waitForTimeout(60);
      assert.equal(await page.evaluate(() => document.activeElement.dataset.oplIndex), String(count - 1), 'scrolling preserves focused DOM identity');
      assert.ok(await page.locator('#opl-rows .track,#opl-rows .opl-track-card').count() < 220);
      await page.keyboard.press('Home');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.oplIndex), '0');
      await page.keyboard.press(mode === 'cover' ? 'ArrowRight' : 'ArrowDown');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.oplIndex), '1');
      await page.keyboard.press('Tab');
      if (mode === 'list') await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.oplIndex), '2', 'Tab follows the full data order');
    }
    await page.locator('#opl-detail-q').fill('Track 49');
    await page.waitForTimeout(30);
    await page.locator('#opl-rows [data-opl-index="0"]').click();
    const filtered = await page.evaluate(() => __plays.at(-1));
    assert.equal(filtered.id, '49'); assert.equal(filtered.count, 111, 'play uses all matching loaded data');
    await page.locator('#opl-detail-q').fill('');
    await page.setViewportSize({ width: 640, height: 760 });
    await page.waitForTimeout(80);
    await page.locator('#opl-rows').evaluate((box) => { box.scrollTop = box.scrollHeight; });
    await page.waitForFunction(() => !!document.querySelector('[data-opl-index="4999"]'));
    await page.locator('[data-opl-index="4999"]').click();
    assert.equal(await page.evaluate(() => __plays.at(-1).id), '4999');
    await page.evaluate(() => { document.getElementById('opl-rows').scrollTop = 0; OnlinePlaylistView.state.total = 5050; OnlinePlaylistView.state.offset = 5000; OnlinePlaylistView.setMode('list'); });
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => __loads), 0, 'offscreen tail does not eagerly fetch every page');
    await page.evaluate(() => { document.body.dataset.density = 'compact'; });
    await page.waitForTimeout(60);
    assert.equal(await page.locator('#opl-more').isVisible(), true, 'explicit load-more remains available');
    await page.locator('#opl-rows').evaluate((box) => { box.scrollTop = box.scrollHeight; });
    await page.waitForFunction(() => OnlinePlaylistView.state.tracks.length === 5050);
    assert.equal(await page.evaluate(() => __loads), 1, 'tail sentinel loads one remaining page');
    assert.deepEqual(errors, []);
    console.log('Online window: bounded DOM, full playback indexes, focus, filtering, resize and pagination passed.');
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
