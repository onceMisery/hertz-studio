// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// Real native observer + extracted app controls against a controlled service.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const ui = path.join(root, 'plugin/ui');
const app = fs.readFileSync(path.join(ui, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const sleepSource = app.slice(app.indexOf("const SLEEP_TIMER_KEY ="), app.indexOf('\n// ---------------------------------------------------------------------------\n// 命令面板'));
const surfaceSource = app.slice(app.indexOf("  P.registerSurface({\n    id: 'sleep',"), app.indexOf('\n  const cmds ='));
assert(sleepSource.includes('function initSleepTimer()'));
assert(surfaceSource.includes('ps-refresh'));
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${['design/design-base.css', 'components/button.css', 'components/form.css', 'style.css', 'skins/skin.hertz.css', 'palette.css'].map(file => `<link rel="stylesheet" href="/ui/${file}">`).join('')}
<style>body{display:block;padding:24px;min-width:0;background:var(--bg);color:var(--text)}main{max-width:600px;margin:0 auto}#surface{margin-top:24px;border:1px solid var(--border);padding:20px;border-radius:12px}#menu{display:none}</style></head>
<body><main><button id="sleep-timer" class="btn-pill st-pill" aria-label="睡眠定时器"><span id="sleep-timer-label" hidden></span></button><section id="surface"></section><div id="menu"></div></main>
<script src="/ui/window-sleep.js"></script></body></html>`;

async function main() {
  const server = http.createServer((request, response) => {
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return; }
    const file = path.resolve(ui, decodeURIComponent(request.url.replace(/^\/ui\//, '').split('?')[0]));
    if (!file.startsWith(ui + path.sep) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/css');
    response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 650 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const output = path.resolve(process.env.NATIVE_SLEEP_SCREENSHOTS || path.join(root, 'output/native-sleep'));
  const calls = type => page.evaluate(type => test.calls.filter(call => call[0] === type), type);
  const state = () => page.evaluate(() => HertzWindowSleep.snapshot());
  async function fixture(options = {}) {
    await page.goto(origin);
    await page.clock.install({ time: new Date('2026-11-06T12:00:00Z') });
    await page.clock.pauseAt(new Date('2026-11-06T12:00:01Z'));
    await page.evaluate(({ options, sleepSource, surfaceSource }) => {
      const t = window.test = { calls: [], notices: [], reads: [], writes: [], failRead: false, failWrite: '', blockRead: !!options.blockRead,
        blockWrite: false, room: false, intervals: new Set(), server: options.server || { available: true, revision: 0, phase: 'idle', remainingMs: 0 } };
      t.deadline = performance.now() + t.server.remainingMs;
      t.read = () => ({ ...t.server, remainingMs: t.server.phase === 'armed' ? Math.max(0, t.deadline - performance.now()) : 0,
        serverNowMs: Date.now(), deadlineUnixMs: Date.now() + Math.max(0, t.deadline - performance.now()) });
      t.setServer = value => { t.server = { ...t.server, ...value }; t.deadline = performance.now() + t.server.remainingMs; };
      const nativeInterval = window.setInterval, nativeClear = window.clearInterval;
      window.setInterval = (...args) => { const id = nativeInterval(...args); t.intervals.add(id); return id; };
      window.clearInterval = id => { t.intervals.delete(id); nativeClear(id); };
      window.hertzHost = { isDbx: !!options.dbx };
      if (options.native !== false && !options.delayedHost) window.__hertzWindowHost = { lifecycleVersion: 1 };
      window.HertzRoom = { active: () => t.room };
      window.transport = {
        kind: options.dbxTransport ? 'dbx' : 'server',
        async get(url) {
          t.calls.push(['get', url]);
          if (t.failRead) throw new Error('连接中断');
          const value = t.read();
          if (t.blockRead) return new Promise((resolve, reject) => t.reads.push({ resolve, reject, value }));
          return value;
        },
        async put(url, payload) {
          t.calls.push(['put', url, payload]);
          if (t.blockWrite) await new Promise((resolve, reject) => t.writes.push({ resolve, reject }));
          if (t.failWrite) throw Object.assign(new Error('操作未完成'), { code: t.failWrite });
          if (payload.expectedRevision !== t.server.revision) throw Object.assign(new Error('版本冲突'), { code: 'sleep_timer_revision_conflict', status: 409 });
          t.setServer({ revision: t.server.revision + 1, phase: payload.seconds === null ? 'cancelled' : 'armed', remainingMs: (payload.seconds || 0) * 1000, error: null });
          return t.read();
        },
      };
      window.ui = { sleepTimer: document.querySelector('#sleep-timer'), sleepTimerLabel: document.querySelector('#sleep-timer-label'), menu: document.querySelector('#menu') };
      window.toast = (text, kind) => t.notices.push([text, kind]);
      window.post = url => t.calls.push(['post', url]);
      window.errText = (prefix, error) => prefix + '：' + error.message;
      window.modal = () => ({ prompt: async () => '5' });
      window.buildMenu = (host, items) => { t.menu = items; };
      window.showMenu = () => {};
      window.P = { registerSurface: value => { t.surface = value; } };
      new Function(sleepSource + '\n' + surfaceSource + '\nwindow.sleep = { initSleepTimer, armSleepTimer, clearSleepTimer, sleepRemainingMs, sleepPresentation, openSleepTimerMenu, sleepState };')();
      sleep.initSleepTimer();
    }, { options, sleepSource, surfaceSource });
    if (options.native !== false && !options.dbx && !options.dbxTransport && !options.delayedHost && !options.blockRead) {
      await page.waitForFunction(() => !HertzWindowSleep.snapshot().loading);
    }
  }
  async function mountSurface() { await page.evaluate(() => { test.surfaceCleanup = test.surface.render(document.querySelector('#surface')); }); }
  try {
    for (const options of [{ native: false }, { dbx: true }, { dbxTransport: true }]) {
      await fixture(options);
      assert.deepEqual(await calls('get'), []);
      await page.evaluate(() => { sleep.armSleepTimer(1); sleep.armSleepTimer(1); sleep.initSleepTimer(); });
      assert.equal(await page.evaluate(() => test.intervals.size), 1, 'legacy only has one page countdown');
      await page.clock.fastForward(60000);
      assert.deepEqual(await calls('post'), [['post', '/v1/player/pause']]);
      assert.deepEqual(await calls('put'), []);
      assert.equal(await page.evaluate(() => sleep.sleepState.timer), 0);
    }

    await fixture({ blockRead: true });
    assert.equal(await page.locator('#sleep-timer').isDisabled(), true);
    await page.evaluate(() => { HertzWindowSleep.refresh(); HertzWindowSleep.refresh(); sleep.initSleepTimer(); });
    assert.equal((await calls('get')).length, 1, 'initial GET is single flight');
    await page.evaluate(() => { test.blockRead = false; test.reads[0].resolve(test.reads[0].value); });
    await page.waitForFunction(() => !HertzWindowSleep.snapshot().loading);
    assert.equal(await page.evaluate(() => test.intervals.size), 1, 'repeated init never duplicates native render ticker');
    await page.evaluate(() => sleep.armSleepTimer(1));
    assert.deepEqual((await calls('put'))[0][2], { seconds: 60, expectedRevision: 0 });
    assert.equal(await page.evaluate(() => sleep.sleepState.timer), 0);
    await page.clock.fastForward(60000);
    await page.evaluate(() => HertzWindowSleep.refresh());
    assert.equal((await state()).phase, 'armed');
    assert.equal((await state()).remainingMs, 0);
    assert.match(await page.locator('#sleep-timer').getAttribute('title'), /等待服务确认/);
    assert.deepEqual(await calls('post'), [], 'native zero is never a page pause');
    assert.equal(await page.evaluate(() => test.notices.some(([text]) => text.includes('已暂停'))), false);
    await page.evaluate(async () => { test.setServer({ revision: 2, phase: 'expired', remainingMs: 0 }); await HertzWindowSleep.refresh(); });
    assert.equal(await page.evaluate(() => test.notices.some(([text]) => text.includes('已暂停'))), true);

    await fixture({ server: { available: true, revision: 12, phase: 'armed', remainingMs: 45000 } });
    assert.equal((await state()).revision, 12, 'reload restores the service revision');
    await page.clock.fastForward(15000);
    assert.equal(Math.round((await state()).remainingMs), 30000);
    await page.clock.setSystemTime(new Date('2035-01-01T00:00:00Z'));
    assert.equal(Math.round((await state()).remainingMs), 30000, 'wall clock changes do not move the display deadline');
    await page.clock.setSystemTime(new Date('2001-01-01T00:00:00Z'));
    assert.equal(Math.round((await state()).remainingMs), 30000);
    await fixture({ server: { available: true, revision: 12, phase: 'armed', remainingMs: 29000 } });
    assert.equal(Math.round((await state()).remainingMs), 29000, 'a new page uses remainingMs from service, not stored UI deadline');

    await page.evaluate(async () => { test.blockRead = true; test.oldRead = HertzWindowSleep.refresh(); });
    await page.evaluate(() => sleep.armSleepTimer(2));
    await page.evaluate(async () => { test.blockRead = false; test.reads[0].resolve(test.reads[0].value); await test.oldRead; });
    assert.equal((await state()).revision, 13, 'pre-write stale GET cannot replace PUT state');
    assert.equal(Math.round((await state()).remainingMs), 120000);
    await page.evaluate(async () => {
      test.setServer({ revision: 14, phase: 'armed', remainingMs: 900000 });
      await sleep.armSleepTimer(3);
    });
    assert.equal((await state()).revision, 14, 'conflict refreshes the newer service state');
    assert.equal(Math.round((await state()).remainingMs), 900000);
    assert.equal((await calls('put')).length, 2, 'conflicting mutation is not replayed');
    await page.evaluate(async () => {
      test.setServer({ revision: 15, phase: 'expired', remainingMs: 0 });
      await sleep.clearSleepTimer();
    });
    assert.equal((await state()).phase, 'expired', 'expiry winning cancel race stays expired');
    assert.equal((await calls('put')).length, 3);

    await fixture();
    await page.evaluate(() => { test.blockWrite = true; test.firstWrite = sleep.armSleepTimer(1); });
    await page.evaluate(() => sleep.clearSleepTimer());
    assert.equal((await calls('put')).length, 1, 'concurrent cancel cannot overwrite an unconfirmed arm');
    assert.equal(await page.locator('#sleep-timer').isDisabled(), true);
    await page.evaluate(async () => { test.blockWrite = false; test.writes[0].resolve(); await test.firstWrite; });
    assert.equal((await state()).phase, 'armed');
    await page.evaluate(() => sleep.clearSleepTimer());
    assert.deepEqual((await calls('put'))[1][2], { seconds: null, expectedRevision: 1 });
    assert.equal((await state()).phase, 'cancelled');

    await page.evaluate(async () => { await sleep.armSleepTimer(1); test.failRead = true; await HertzWindowSleep.refresh(); });
    assert.equal((await state()).unknown, true);
    assert.equal((await state()).phase, 'armed', 'network failure preserves last known service state');
    await page.clock.fastForward(120000);
    assert.match(await page.locator('#sleep-timer').getAttribute('title'), /状态未确认/);
    assert.deepEqual(await calls('post'), []);
    await page.evaluate(async () => { test.failRead = false; await HertzWindowSleep.refresh(); test.failWrite = 'network_error'; await sleep.armSleepTimer(2); });
    assert.equal((await state()).unknown, true);
    assert.equal((await state()).phase, 'armed');
    assert.equal(await page.evaluate(() => sleep.sleepState.timer), 0);
    await page.evaluate(async () => {
      test.failWrite = ''; test.setServer({ revision: 5, phase: 'failed', remainingMs: 0, error: 'sleep_timer_pause_failed' });
      await HertzWindowSleep.refresh();
    });
    await mountSurface();
    assert.match(await page.locator('.ps-note').innerText(), /暂停播放失败/);
    assert.equal(await page.locator('.ps-cancel').isEnabled(), true);
    assert.equal(await page.locator('.ps-arm').isEnabled(), true);
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'native-failed.png'), fullPage: true });
    await page.evaluate(async () => { test.failWrite = 'sleep_timer_room_active'; await sleep.armSleepTimer(3); });
    assert.match((await state()).error, /房间的睡眠定时/);
    await page.evaluate(() => { test.room = true; sleep.openSleepTimerMenu(ui.sleepTimer); });
    assert.equal(await page.evaluate(() => test.menu.filter(item => /\d+ 分钟/.test(item.label || '')).every(item => item.disabled)), true);
    const countBeforeRoom = (await calls('put')).length;
    await page.evaluate(() => sleep.armSleepTimer(1));
    assert.equal((await calls('put')).length, countBeforeRoom, 'room action never arms local/native timer');
    await page.evaluate(async () => { test.room = false; test.failWrite = ''; await HertzWindowSleep.refresh(); await sleep.armSleepTimer(30); });
    await page.clock.fastForward(500);
    assert.match(await page.locator('.ps-note').innerText(), /重载页面后仍继续/);
    await page.setViewportSize({ width: 390, height: 720 });
    await page.screenshot({ path: path.join(output, 'native-countdown-mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'sleep surface fits mobile');
    await page.evaluate(() => test.surfaceCleanup());
    assert.equal(await page.evaluate(() => test.intervals.size), 1, 'palette cleanup leaves only native render ticker');

    await fixture();
    await page.evaluate(() => {
      test.hidden = true;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => test.hidden });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const beforeHidden = (await calls('get')).length;
    await page.clock.fastForward(4000);
    assert.equal((await calls('get')).length, beforeHidden, 'hidden polling waits five seconds');
    await page.clock.fastForward(1000);
    assert.equal((await calls('get')).length, beforeHidden + 1);
    await page.evaluate(() => {
      test.hidden = false; test.blockRead = true;
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal((await calls('get')).length, beforeHidden + 2, 'visible refresh is immediate and single flight');
    await page.evaluate(() => { test.blockRead = false; test.reads[0].resolve(test.reads[0].value); });

    await fixture({ server: { available: false } });
    assert.equal((await state()).managed, true);
    await page.evaluate(() => sleep.armSleepTimer(1));
    assert.deepEqual(await calls('put'), []);
    assert.equal(await page.evaluate(() => sleep.sleepState.timer), 0, 'unavailable native service has no legacy fallback');
    await page.clock.fastForward(60000);
    await page.clock.fastForward(60000);
    assert((await calls('get')).length <= 3, 'unavailable capability probing is bounded');
    await page.evaluate(async () => { test.setServer({ available: true, revision: 0, phase: 'idle', remainingMs: 0 }); await HertzWindowSleep.refresh(); });
    assert.equal((await state()).available, true, 'manual refresh recovers availability');

    await fixture({ delayedHost: true });
    assert.deepEqual(await calls('get'), []);
    await page.evaluate(() => { sleep.armSleepTimer(1); window.__hertzWindowHost = { lifecycleVersion: 1 }; dispatchEvent(new Event('hertz-native-host-ready')); });
    await page.waitForFunction(() => HertzWindowSleep.snapshot().available);
    assert.equal(await page.evaluate(() => sleep.sleepState.timer), 0, 'late native host removes legacy ticker');
    assert.equal(await page.evaluate(() => test.intervals.size), 1);
    assert.deepEqual(await calls('post'), []);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, errors,
      verified: ['ordinary browser and DBX legacy timers', 'single-flight initialization and repeated init', 'native zero waits for service confirmation',
        'restore and wall-clock-independent countdown', 'stale GET fencing', 'CAS conflict without replay', 'cancel versus arm and expiry races',
        'network failure without fallback', 'service failure retry and cancellation', 'room timer isolation', 'visibility refresh', 'bounded unavailable retry and delayed host', 'mobile surface'],
      scope: 'Actual window-sleep module and extracted app sleep controls/palette, Chrome with controlled clock/service.' }, null, 2));
    console.log('Native sleep browser checks passed: native observer, restore, CAS and races, clock jumps, errors, room isolation, legacy preservation, responsive screenshots.');
    console.log('Screenshots: ' + output);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
