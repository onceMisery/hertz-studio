#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';

// Real DOM/pointer/wheel regression for the shipped shelf and queue handlers.
// Playback requests are captured in this isolated page; no user service is changed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const web = path.join(root, 'plugin/ui');
const output = path.join(root, 'output/playwright/stage-queue-playback');
const read = file => fs.readFileSync(path.join(web, file), 'utf8').replace(/\r\n/g, '\n');

function shippedFunction(file, name) {
  const source = read(file);
  const match = new RegExp('^([ \\t]*)(?:async )?function ' + name + '\\(', 'm').exec(source);
  assert.ok(match, file + ':' + name);
  const end = source.indexOf('\n' + match[1] + '}', match.index);
  assert.ok(end >= 0, name + ' closes');
  return source.slice(match.index, end + match[1].length + 2);
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const failures = [];
  let checks = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setContent(`<main id="stage3d" class="s3d s3d-open s3d-chrome" tabindex="0">
      <div class="s3d-shelf" id="s3d-shelf"><div class="s3d-shelf-plane" id="s3d-shelf-plane"></div></div>
      <aside id="s3d-queue-panel" class="s3d-queue" hidden>
        <div class="s3d-queue-head"><span>播放队列 <b id="s3d-queue-count"></b></span><button id="s3d-queue-close">关闭</button></div>
        <div id="s3d-queue-list" class="s3d-queue-list"></div>
      </aside>
      <div id="s3d-settings" hidden></div><button id="s3d-queue" style="position:absolute;left:50%;bottom:0">播放队列</button>
    </main><div id="queue-list"></div><span id="queue-count"></span><span id="queue-badge"></span><button id="playpause"></button>`);
    for (const file of ['style.css', 'stage3d.css', 'stage-themes/starfall.css', 'stage-themes/ios.css']) {
      await page.addStyleTag({ content: read(file) });
    }
    await page.addScriptTag({ content: `
      var root = document.getElementById('stage3d'), global = window, active = true;
      var queueData = [], queueOpen = false, queuePinned = false;
      var requests = [], messages = [], frames = new Map();
      var state = { queue: [], byId: new Map(), snapshot: { track_id: null } };
      function $(id) { return document.getElementById(id); }
      function text(id, value) { $(id).textContent = value; }
      function fmt(ms) { return Math.floor((ms || 0) / 60000) + ':00'; }
      function toast(message) { messages.push(message); }
      function errText(label, error) { return label + ': ' + error.message; }
      function pokeChrome() { root.classList.add('s3d-chrome'); }
      function setQueuePinned(value) { queuePinned = value; }
      function setSettings() { $('s3d-settings').hidden = true; }
      function missingQueueIds() { return []; }
      function restoreQueue() { return Promise.resolve(); }
      var ui = { playpause: $('playpause'), queueList: $('queue-list'), queueCount: $('queue-count'), queueBadge: $('queue-badge') };
      var PlaybackIntent = { generation: 0, queueRevision: 0,
        begin: function () { return ++this.generation; },
        current: function (ticket) { return ticket === this.generation; } };
      var transport = { post: function (url, body) { requests.push({ url: url, body: body }); return Promise.resolve({}); } };
      var Online = window.Online = {
        getMeta: function (id) { return state.byId.get(id); },
        safeCoverUrl: function (url) { return url; },
        badge: function (source) { var el = document.createElement('span'); el.textContent = source; return el; },
        playAll: function (tracks, index) { requests.push({ url: '/v1/online/play', body: { source: tracks[0].source, tracks: tracks, index: index } }); }
      };
      var Stage = window.Stage = {
        presentation: function () { return { track: { id: state.snapshot.track_id }, playing: false, reduced: true, position: 1000, duration: 200000 }; },
        spectrum: function () { return []; }, tier: function () { return 2; }, kick: function () {},
        gate: function (name, fps, frame) { frames.set(name, { fps: fps, frame: frame }); },
        removeGate: function (name) { frames.delete(name); }
      };
      function control(action, value) { document.dispatchEvent(new CustomEvent('stage:control', { detail: { action: action, value: value } })); }
    ` });
    await page.addScriptTag({ content: read('stage-shelf.js') });
    await page.addScriptTag({ content:
      ['onStageControl', 'playQueueIndex', 'playTrack', 'renderQueue', 'pushStageQueue'].map(name => shippedFunction('app.js', name)).join('\n') + '\n' +
      ['renderQueuePanel', 'setQueue', 'setQueuePanel'].map(name => shippedFunction('stage3d.js', name)).join('\n') + `
      var shelf = StageShelf.init(root);
      var Stage3D = window.Stage3D = { setQueue: setQueue };
      document.addEventListener('stage:control', onStageControl);
      $('s3d-queue-close').addEventListener('click', function () { setQueuePanel(false); });
      var fixture = Array.from({ length: 24 }, function (_, index) {
        var source = index % 2 ? 'qq' : 'netease';
        var id = index === 3 ? '53c3f15a-d61c-4d4e-9aa7-e1f20cb1d479' : 'online:' + source + ':fixture-' + index;
        return { id: id, source: source, onlineId: 'fixture-' + index,
          title: index === 1 ? 'ペガサス幻想 (天马座幻想)' : '队列曲目 ' + (index + 1),
          artist: index === 1 ? 'MAKE-UP' : source, album: '队列回归', duration_ms: 200000, duration: 200000, cover: null };
      });
      function tick() { frames.forEach(function (gate) { if (gate.fps()) gate.frame(50); }); }
      function installQueue(rows, currentIndex) {
        shelf.hide(); setQueuePanel(false); state.queue = rows.map(function (item) { return item.id; });
        state.snapshot.track_id = rows[currentIndex] ? rows[currentIndex].id : null;
        state.byId = new Map(rows.filter(function (_, index) { return index !== 17; }).map(function (item) { return [item.id, item]; }));
        setQueue(rows.map(function (item, index) { return Object.assign({}, item, { playing: index === currentIndex }); }));
        shelf.show(); tick(); requests.length = 0; messages.length = 0;
      }
      window.shelfTimer = setInterval(tick, 16);
      installQueue(fixture, 0);
    ` });

    async function check(label, run) {
      if (process.env.STAGE_QUEUE_CHECK && !label.includes(process.env.STAGE_QUEUE_CHECK)) return;
      try { await run(); checks++; console.log('PASS ' + label); }
      catch (error) { failures.push(label + ': ' + error.message); console.error('FAIL ' + failures.at(-1)); }
    }
    async function expectLoad(index) {
      const result = await page.evaluate(() => ({ requests, queue: state.queue, messages }));
      assert.equal(result.requests.length, 1, 'one playback request, messages=' + JSON.stringify(result.messages));
      assert.equal(result.requests[0].url, '/v1/player/load', 'all queue entries use the existing queue endpoint');
      assert.equal(result.requests[0].body.track_id, result.queue[index], 'keep the selected platform identity');
      assert.deepEqual(result.requests[0].body.queue, result.queue, 'keep every entry, including uncached metadata and local tracks');
    }
    const card = index => page.locator('.s3d-sc[data-id="online:' + (index % 2 ? 'qq' : 'netease') + ':fixture-' + index + '"]');

    await check('immersive queue click plays the QQ item in the complete mixed queue', async () => {
      await page.evaluate(() => { installQueue(fixture, 0); setQueuePanel(true); });
      await page.locator('.s3d-queue-row').nth(1).click();
      await expectLoad(1);
    });
    await check('shelf pointer click keeps QQ identity instead of using the first item platform', async () => {
      await page.evaluate(() => installQueue(fixture, 0));
      await card(1).click({ timeout: 2500 });
      await expectLoad(1);
    });
    await check('ordinary queue and skin queue use the same playable mixed queue', async () => {
      await page.evaluate(() => { installQueue(fixture, 0); renderQueue(); root.style.display = 'none'; });
      await page.locator('.q-row').nth(1).click();
      await expectLoad(1);
      await page.evaluate(() => { requests.length = 0; playQueueIndex(3); root.style.display = ''; });
      await expectLoad(3);
    });
    await page.evaluate(() => { root.style.display = ''; });

    await check('queue stays on the left across scenes and themes, with no shelf overlap on narrow screens', async () => {
      try {
        for (const viewport of [
          { width: 1440, height: 960 }, { width: 1024, height: 768 },
          { width: 844, height: 390 }, { width: 390, height: 844 }, { width: 360, height: 640 }
        ]) {
          await page.setViewportSize(viewport);
          for (const scene of ['silk', 'orb']) {
            for (const theme of ['classic', 'starfall', 'ios']) {
              await page.evaluate(({ scene, theme }) => {
                root.dataset.scene = scene; root.dataset.stageTheme = theme;
                installQueue(fixture, 0); setQueuePanel(true);
              }, { scene, theme });
              await page.waitForFunction(() => getComputedStyle($('s3d-queue-panel')).opacity === '1');
              const geometry = await page.evaluate(() => {
                const panel = $('s3d-queue-panel').getBoundingClientRect();
                const current = document.querySelector('.s3d-sc.is-current').getBoundingClientRect();
                const list = $('s3d-queue-list');
                return { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom,
                  cardLeft: current.left, shelfOpacity: Number(getComputedStyle($('s3d-shelf')).opacity),
                  listHeight: list.clientHeight, scrollHeight: list.scrollHeight };
              });
              const context = scene + '/' + theme + ' at ' + viewport.width + 'x' + viewport.height + ': ' + JSON.stringify(geometry);
              assert.ok(Math.abs(geometry.left) < 1, 'queue remains at the left edge: ' + context);
              assert.ok(geometry.right <= viewport.width && geometry.top >= 0 && geometry.bottom < viewport.height,
                'queue stays inside the viewport: ' + context);
              assert.ok(geometry.listHeight > 40 && geometry.scrollHeight > geometry.listHeight,
                'full queue remains scrollable: ' + context);
              if (viewport.width > 760) {
                assert.ok(geometry.shelfOpacity > 0 && geometry.right + 16 < geometry.cardLeft,
                  'desktop queue leaves room for the right shelf: ' + context);
              } else {
                await page.waitForFunction(() => getComputedStyle($('s3d-shelf')).opacity === '0');
              }
            }
          }
        }
        await page.locator('.s3d-queue-row').last().click();
        await expectLoad(23);
        await page.locator('#s3d-queue-close').click();
        await page.waitForFunction(() => getComputedStyle($('s3d-shelf')).opacity === '1');
        await page.evaluate(() => shelf.setBlocked(true));
        await page.waitForFunction(() => Number(getComputedStyle($('s3d-shelf')).opacity) > 0);
      } finally {
        await page.setViewportSize({ width: 1440, height: 960 });
        await page.evaluate(() => { root.removeAttribute('data-scene'); root.removeAttribute('data-stage-theme'); installQueue(fixture, 0); });
      }
    });

    await check('shelf can browse before the current song and all the way to the last of 24 songs', async () => {
      await page.evaluate(() => installQueue(fixture, 10));
      for (const direction of [-1, 1]) {
        const start = direction < 0 ? 10 : 0;
        const end = direction < 0 ? 0 : 23;
        for (let index = start; index !== end; index += direction) {
          const id = await page.evaluate(index => fixture[index].id, index);
          await page.locator('.s3d-sc[data-id="' + id + '"]').hover({ timeout: 2500 });
          await page.mouse.wheel(0, direction * 100);
          await page.waitForTimeout(195);
        }
        assert.equal(await card(end).isVisible(), true, 'queue end ' + end + ' remains reachable');
      }
      assert.equal(await page.evaluate(() => requests.length), 0, 'browsing does not start playback');
      await page.screenshot({ path: path.join(output, 'full-queue-last.png') });
      await card(23).click();
      await expectLoad(23);
    });

    await check('metadata refresh preserves the browsed position', async () => {
      await page.evaluate(() => installQueue(fixture, 0));
      for (let index = 0; index < 4; index++) {
        const id = await page.evaluate(index => fixture[index].id, index);
        await page.locator('.s3d-sc[data-id="' + id + '"]').hover();
        await page.mouse.wheel(0, 100);
        await page.waitForTimeout(195);
      }
      await page.mouse.move(700, 900);
      await page.waitForTimeout(50);
      const before = await card(4).boundingBox();
      const beforePose = await card(4).evaluate(el => el.style.transform);
      await page.evaluate(() => setQueue(queueData.map(item => ({ ...item, artist: item.artist + ' 更新' }))));
      await page.waitForTimeout(50);
      const after = await card(4).boundingBox();
      const afterPose = await card(4).evaluate(el => el.style.transform);
      assert.ok(before && after && Math.abs(after.y - before.y) < 5,
        'metadata must not snap browsing back to the playing song: ' + JSON.stringify({ before, after, beforePose, afterPose }));
    });

    await check('2000-song queue has bounded card DOM and still exposes its true size', async () => {
      await page.evaluate(() => installQueue(Array.from({ length: 2000 }, (_, index) => ({ id: 'large-' + index, title: '大队列 ' + index })), 1000));
      const result = await page.evaluate(() => ({
        count: document.querySelectorAll('.s3d-sc').length,
        current: document.querySelector('.s3d-sc.is-current')?.dataset.id,
        label: document.querySelector('.s3d-sc.is-current .s3d-sc-tag')?.textContent,
        queue: state.queue.length
      }));
      assert.ok(result.count <= 16, 'render a small window rather than 2000 DOM nodes');
      assert.equal(result.current, 'large-1000');
      assert.equal(result.queue, 2000);
      assert.match(result.label, /1001\s*\/\s*2000/, 'show the position in the complete queue');
    });
    await check('empty/hidden/destroyed shelf releases cards and its frame gate', async () => {
      const result = await page.evaluate(() => {
        installQueue([], 0);
        shelf.hide();
        const stopped = frames.get('stage3d-shelf').fps() === 0;
        shelf.destroy(); clearInterval(window.shelfTimer);
        return { count: document.querySelectorAll('.s3d-sc').length, stopped, gates: frames.size };
      });
      assert.deepEqual(result, { count: 0, stopped: true, gates: 0 });
    });
    await check('no browser script errors', async () => assert.deepEqual(errors, []));
    assert.deepEqual(failures, [], 'stage queue playback/browser regressions');
    console.log('Stage queue playback: ' + checks + ' browser groups passed.');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
