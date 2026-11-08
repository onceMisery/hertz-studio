// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// Real lifecycle module + controlled native handshake, persistence and recorder.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const ui = path.join(root, 'plugin/ui');
const source = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
const setting = source.match(/<div class="set-row" id="window-lifecycle-setting"[\s\S]*?<\/div>/)[0];
const dialog = source.match(/<dialog id="window-lifecycle-dialog"[\s\S]*?<\/dialog>/)[0];
const app = fs.readFileSync(path.join(ui, 'app.js'), 'utf8');
const exitService = app.slice(app.indexOf('async function exitService() {'), app.indexOf('\nfunction showServiceExit('));
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${['design/design-base.css', 'components/button.css', 'components/form.css', 'style.css', 'skins/skin.hertz.css', 'window-lifecycle.css'].map(file => `<link rel="stylesheet" href="/ui/${file}">`).join('')}
<style>body{display:block;margin:0;padding:24px;min-width:0;background:var(--bg);color:var(--text)}main{max-width:720px;margin:0 auto}.set-group{padding:24px}#service-exit{margin:24px}</style>
</head><body><main><section class="set-group"><h2 class="set-title">窗口与舞台</h2>${setting}</section><button class="btn" id="service-exit">退出播放器</button></main>${dialog}<script src="/ui/window-lifecycle.js"></script></body></html>`;

async function main() {
  const server = http.createServer((request, response) => {
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return; }
    const file = path.resolve(ui, decodeURIComponent(request.url.replace(/^\/ui\//, '').split('?')[0]));
    if (!file.startsWith(ui + path.sep) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
    response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1120, height: 760 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const output = path.resolve(process.env.WINDOW_LIFECYCLE_SCREENSHOTS || path.join(root, 'output/main-window-lifecycle'));

  async function fixture(options = {}) {
    await page.goto(origin);
    await page.evaluate(({ options, exitService }) => {
      window.test = { calls: [], held: {}, recording: !!options.recording, phase: options.phase || 'recording', failPut: false,
        pendingDebounce: true, toasts: [], closed: false, exited: false, ordinaryConfirm: 0 };
      const t = window.test;
      t.hold = key => new Promise((resolve, reject) => { t.held[key] = { resolve, reject }; });
      t.bridge = () => ({ lifecycleVersion: 1,
        lifecycleReady() { t.calls.push(['ready']); },
        acknowledgeQuit(id, token) { t.calls.push(['ack', id, token, document.querySelector('#window-lifecycle-dialog').open]); },
        confirmQuit(id, token, approve, explicit) { t.calls.push(['confirm', id, token, approve, !!explicit]); },
        requestQuit() { t.calls.push(['request']); }
      });
      window.hertzHost = { isDbx: !!options.dbx };
      if (options.native !== false && !options.delayedHost) window.__hertzWindowHost = t.bridge();
      window.transport = {
        async get(url) { t.calls.push(['get', url]); return t.state || { available: true, closeBehavior: options.behavior || 'hide', phase: 'idle' }; },
        async put(url, payload) { t.calls.push(['put', url, payload]); if (t.failPut) throw new Error('磁盘写入失败'); return payload; },
        async post(url) { t.calls.push(['post', url]); return t.shutdown || { ok: true }; }
      };
      window.CreativeStage = {
        hydrated() { return options.deferHydration ? t.hold('hydration') : Promise.resolve(); },
        flushPersistence() { t.calls.push(['flush', 'current']); t.pendingDebounce = false; return options.deferSave ? t.hold('current') : Promise.resolve(); },
        flushLibrary() { t.calls.push(['flush', 'library']); return options.deferSave ? t.hold('library') : Promise.resolve(); }
      };
      window.StagePersistence = { status: () => ({ hydrated: true }) };
      window.VideoExport = {
        isRecording: () => t.recording,
        status: () => ({ phase: t.recording ? t.phase : 'idle', ...(t.lastResult || {}) }),
        stop(reason) { t.calls.push(['stop', reason]); return t.hold('video').then(result => { t.recording = false; t.lastResult = result; return result; }); }
      };
      window.toast = (text, kind) => t.toasts.push([text, kind]);
      window.modal = () => ({ confirm: async () => { t.ordinaryConfirm++; return true; } });
      window.ui = { serviceExit: document.querySelector('#service-exit') };
      window.close = () => { t.closed = true; };
      window.showServiceExit = () => { t.exited = true; };
      window.exitServiceUnderTest = new Function('return (' + exitService + ')')();
      t.emit = (id = 1, token = 'a', activity = {}, needsConfirmation = true) => window.dispatchEvent(new CustomEvent('hertz-native-exit-request', { detail: {
        snapshot: { available: true, closeBehavior: 'hide', phase: 'pending', requestId: id, activity, needsConfirmation }, presentation: token
      } }));
      t.stateEvent = (id, phase) => window.dispatchEvent(new CustomEvent('hertz-native-exit-state', { detail: { available: true, requestId: id, phase } }));
      WindowLifecycle.init(transport);
    }, { options, exitService });
    if (options.native !== false && !options.dbx && !options.delayedHost) await page.waitForFunction(() => !document.querySelector('#window-lifecycle-behavior').disabled);
  }
  const calls = type => page.evaluate(type => test.calls.filter(call => call[0] === type), type);
  const emit = args => page.evaluate(args => test.emit(...args), args);
  const settle = () => page.waitForFunction(() => !document.querySelector('#window-lifecycle-approve').disabled);
  const resolveSave = async () => page.evaluate(() => { test.held.current.resolve(); test.held.library.resolve(); });
  try {
    for (const options of [{ native: false }, { dbx: true }]) {
      await fixture(options);
      assert.equal(await page.locator('#window-lifecycle-setting').isVisible(), false);
      await emit([1, 'a', { playing: true }]);
      assert.deepEqual(await page.evaluate(() => test.calls), []);
      assert.equal(await page.locator('#window-lifecycle-dialog').isVisible(), false);
    }
    await fixture({ delayedHost: true });
    assert.deepEqual(await calls('get'), []);
    await page.evaluate(() => { window.__hertzWindowHost = test.bridge(); dispatchEvent(new Event('hertz-native-host-ready')); });
    await page.waitForFunction(() => test.calls.some(call => call[0] === 'ready'));
    assert.equal(await page.locator('#window-lifecycle-setting').isVisible(), true);

    await fixture();
    assert.equal(await page.locator('#window-lifecycle-behavior').inputValue(), 'hide');
    assert.match(await page.locator('#window-lifecycle-setting').innerText(), /隐藏到托盘（默认）/);
    await page.locator('#window-lifecycle-behavior').selectOption('quit');
    await page.waitForFunction(() => document.querySelector('#window-lifecycle-setting-status').textContent.includes('已保存'));
    await page.evaluate(() => { test.failPut = true; });
    await page.locator('#window-lifecycle-behavior').selectOption('hide');
    await page.waitForFunction(() => document.querySelector('#window-lifecycle-setting-status').textContent.includes('保存失败'));
    assert.equal(await page.locator('#window-lifecycle-behavior').inputValue(), 'quit');
    assert.deepEqual((await calls('put')).map(call => call[2]), [{ closeBehavior: 'quit' }, { closeBehavior: 'hide' }]);

    await fixture({ behavior: 'quit' });
    assert.match(await page.locator('#window-lifecycle-setting-status').innerText(), /关闭主窗口时将退出播放器/);

    await fixture({ deferSave: true });
    await emit([1, 'a', {}, false]);
    assert.deepEqual(await calls('ack'), [['ack', 1, 'a', true]]);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'window-lifecycle-cancel');
    assert.equal(await page.evaluate(() => test.pendingDebounce), false, 'flush must drain CreativeStage debounce');
    assert.equal(await page.locator('#window-lifecycle-approve').isEnabled(), false);
    assert.deepEqual(await calls('confirm'), []);
    await page.evaluate(() => test.held.current.resolve());
    assert.deepEqual(await calls('confirm'), [], 'library persistence must finish too');
    await page.evaluate(() => test.held.library.resolve());
    await page.waitForFunction(() => test.calls.some(call => call[0] === 'confirm'));
    assert.deepEqual(await calls('confirm'), [['confirm', 1, 'a', true, false]], 'idle approval is explicitly identified to the host');

    await fixture();
    await page.evaluate(async () => { await exitServiceUnderTest(); await exitServiceUnderTest(); });
    assert.equal((await calls('request')).length, 1);
    assert.equal(await page.evaluate(() => test.ordinaryConfirm), 0, 'native path bypasses old modal');
    assert.deepEqual(await calls('post'), []);
    assert.equal(await page.evaluate(() => test.closed), false);
    await emit([2, 'b', { playing: true, roomActive: true }]);
    await emit([2, 'b', { playing: true, roomActive: true }]);
    await settle();
    assert.equal((await calls('ack')).length, 1);
    assert.match(await page.locator('#window-lifecycle-activity').innerText(), /音乐将停止，一起听房间将结束/);
    await page.clock.install();
    await page.clock.fastForward(15000);
    assert.deepEqual(await calls('confirm'), [], 'timeout never counts as approval');
    await page.keyboard.press('Escape');
    assert.deepEqual(await calls('confirm'), [['confirm', 2, 'b', false, false]]);
    assert.equal(await page.locator('#window-lifecycle-dialog').isVisible(), false);
    await page.clock.resume();

    await fixture({ deferSave: true });
    await emit([21, 'cancel-saving', {}, false]);
    await page.evaluate(() => {
      test.stageEscape = 0;
      document.addEventListener('keydown', event => { if (event.key === 'Escape') test.stageEscape++; }, true);
    });
    await page.keyboard.press('Escape');
    await resolveSave();
    assert.deepEqual(await calls('confirm'), [['confirm', 21, 'cancel-saving', false, false]], 'cancel fences pending flush completion');
    assert.equal(await page.evaluate(() => test.stageEscape), 0, 'dialog owns Escape before stage shortcuts');

    await fixture({ deferSave: true });
    await emit([3, 'old', {}, false]);
    await page.evaluate(() => { test.oldSave = { ...test.held }; });
    await emit([3, 'new', { playing: true }]);
    await page.evaluate(() => { test.oldSave.current.resolve(); test.oldSave.library.resolve(); });
    assert.deepEqual(await calls('confirm'), [], 'older presentation cannot approve after re-presentation');
    await page.evaluate(() => test.stateEvent(2, 'cancelled'));
    assert.equal(await page.locator('#window-lifecycle-dialog').isVisible(), true);
    await resolveSave();
    await settle();
    await page.evaluate(() => test.stateEvent(3, 'cancelled'));
    assert.equal(await page.locator('#window-lifecycle-dialog').isVisible(), false);

    await fixture({ deferSave: true });
    await emit([4, 'save-error', {}, false]);
    await page.evaluate(() => { test.held.current.reject(new Error('预置写入冲突')); test.held.library.resolve(); });
    await settle();
    assert.match(await page.locator('#window-lifecycle-status').innerText(), /尚未保存.*丢失未保存的更改/);
    assert.equal(await page.locator('#window-lifecycle-approve').innerText(), '仍然退出');
    assert.deepEqual(await calls('confirm'), []);
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'save-error-desktop.png') });
    await page.locator('#window-lifecycle-approve').click();
    assert.deepEqual(await calls('confirm'), [['confirm', 4, 'save-error', true, true]]);

    await fixture();
    await page.evaluate(() => { delete window.CreativeStage; });
    await emit([41, 'unknown-save', {}, false]);
    await settle();
    assert.match(await page.locator('#window-lifecycle-status').innerText(), /无法确认舞台保存状态/);
    assert.deepEqual(await calls('confirm'), [], 'missing persistence owner never claims saved or autoapproves');
    await page.locator('#window-lifecycle-cancel').click();

    await fixture();
    await page.evaluate(() => { delete window.StagePersistence; });
    await emit([43, 'missing-persistence-owner', {}, false]);
    await settle();
    assert.deepEqual(await calls('confirm'), []);
    assert.match(await page.locator('#window-lifecycle-status').innerText(), /无法确认舞台保存状态/);
    await page.locator('#window-lifecycle-cancel').click();
    await fixture({ deferHydration: true });
    await emit([42, 'hydrating', {}, false]);
    await page.waitForFunction(() => !!test.held.hydration);
    assert.deepEqual(await calls('flush'), [], 'initial persistence read must settle before flushing');
    assert.deepEqual(await calls('confirm'), []);
    await page.evaluate(() => test.held.hydration.reject(new Error('初始读取失败')));
    await settle();
    assert.match(await page.locator('#window-lifecycle-status').innerText(), /尚未保存/);
    assert.deepEqual(await calls('confirm'), []);

    await fixture({ recording: true, phase: 'stopping' });
    await emit([5, 'video', {}, false]);
    await settle();
    assert.equal(await page.locator('#window-lifecycle-recording').isVisible(), true);
    assert.deepEqual(await calls('stop'), [], 'recording always requires explicit approval');
    await page.setViewportSize({ width: 360, height: 740 });
    await page.screenshot({ path: path.join(output, 'recording-mobile.png') });
    const bounds = await page.locator('#window-lifecycle-dialog').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 360);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('#window-lifecycle-approve').click();
    assert.equal(await page.locator('#window-lifecycle-cancel').isEnabled(), false);
    await page.keyboard.press('Escape');
    await emit([5, 'video', {}, false]);
    assert.equal((await calls('stop')).length, 1);
    assert.deepEqual(await calls('confirm'), []);
    await page.evaluate(() => test.held.video.resolve({ bytes: 3821, downloadRequested: true }));
    await page.waitForFunction(() => document.querySelector('#window-lifecycle-approve').textContent === '确认视频已保存并退出');
    assert.deepEqual(await calls('confirm'), [], 'download initiation is not proof the video is saved');
    await page.locator('#window-lifecycle-approve').click();
    assert.deepEqual(await calls('confirm'), [['confirm', 5, 'video', true, true]]);
    await page.setViewportSize({ width: 1120, height: 760 });

    await fixture({ recording: true });
    await emit([6, 'video-error', {}, false]);
    await settle();
    await page.locator('#window-lifecycle-approve').click();
    await page.evaluate(() => test.held.video.reject(new Error('编码器未响应')));
    await settle();
    assert.match(await page.locator('#window-lifecycle-status').innerText(), /录制收尾失败/);
    assert.deepEqual(await calls('confirm'), []);
    await page.locator('#window-lifecycle-approve').click();
    assert.equal((await calls('stop')).length, 2);
    await page.evaluate(() => test.held.video.resolve({ bytes: 0, downloadRequested: false, message: '未生成视频' }));
    await settle();
    assert.deepEqual(await calls('confirm'), [], 'fulfilled failed export must not approve exit');
    await page.locator('#window-lifecycle-cancel').click();
    assert.deepEqual(await calls('confirm'), [['confirm', 6, 'video-error', false, false]]);
    await fixture({ recording: true });
    await emit([61, 'video-retry-file-check', {}, false]);
    await settle();
    await page.locator('#window-lifecycle-approve').click();
    await page.evaluate(() => test.held.video.reject(new Error('暂未完成')));
    await settle();
    await page.locator('#window-lifecycle-approve').click();
    await page.evaluate(() => test.held.video.resolve({ bytes: 4912, downloadRequested: true, failed: false }));
    await settle();
    assert.equal(await page.locator('#window-lifecycle-approve').innerText(), '确认视频已保存并退出');
    assert.deepEqual(await calls('confirm'), []);
    await page.locator('#window-lifecycle-approve').click();
    assert.deepEqual(await calls('confirm'), [['confirm', 61, 'video-retry-file-check', true, true]]);

    await fixture({ recording: true, phase: 'starting' });
    await emit([7, 'starting', {}, false]);
    await settle();
    await page.locator('#window-lifecycle-approve').click();
    await page.evaluate(() => test.held.video.resolve({ bytes: 0, downloadRequested: false }));
    await page.waitForFunction(() => test.calls.some(call => call[0] === 'confirm'));
    assert.deepEqual(await calls('confirm'), [['confirm', 7, 'starting', true, true]]);

    await fixture({ recording: true });
    await emit([8, 'stale-video', {}, false]);
    await settle();
    await page.locator('#window-lifecycle-approve').click();
    await page.evaluate(() => test.stateEvent(8, 'cancelled'));
    await page.evaluate(() => test.held.video.resolve({ bytes: 3832, downloadRequested: true }));
    assert.deepEqual(await calls('confirm'), [], 'cancelled recording completion cannot approve');

    await fixture({ recording: true });
    await emit([81, 'finished-video', {}, false]);
    await settle();
    await page.evaluate(() => { test.recording = false; test.lastResult = { bytes: 4127, downloadRequested: true }; });
    await page.locator('#window-lifecycle-approve').click();
    assert.deepEqual(await calls('stop'), [], 'naturally completed export is not stopped again');
    assert.deepEqual(await calls('confirm'), []);
    await page.locator('#window-lifecycle-approve').click();
    assert.deepEqual(await calls('confirm'), [['confirm', 81, 'finished-video', true, true]]);
    await fixture({ recording: true });
    await emit([82, 'finished-failed-video', {}, false]);
    await settle();
    await page.evaluate(() => { test.recording = false; test.lastResult = { bytes: 4127, downloadRequested: true, failed: true, message: '录制器发生异常' }; });
    await page.locator('#window-lifecycle-approve').click();
    assert.match(await page.locator('#window-lifecycle-status').innerText(), /录制收尾失败/);
    assert.deepEqual(await calls('confirm'), []);

    await fixture({ native: false });
    await page.clock.install();
    await page.evaluate(() => {
      test.shutdown = { phase: 'pending', requestId: 9 };
      test.state = { available: true, phase: 'cancelled', requestId: 9 };
      test.exitPending = exitServiceUnderTest();
    });
    await page.clock.fastForward(1100);
    await page.evaluate(() => test.exitPending);
    assert.equal(await page.evaluate(() => test.closed), false, 'HTTP pending cannot close the observer page');
    assert.equal(await page.locator('#service-exit').isEnabled(), true);
    assert.match(await page.evaluate(() => test.toasts[0][0]), /请在原生主窗口确认退出/);
    assert.equal((await calls('get')).length, 1, 'browser reads window state only after pending response');
    await page.clock.resume();

    await fixture({ native: false });
    await page.clock.install();
    await page.evaluate(() => {
      test.shutdown = { phase: 'pending', requestId: 10 };
      test.state = { available: true, phase: 'exiting', requestId: 10 };
      window.fetch = () => test.hold('health');
      test.exitPending = exitServiceUnderTest();
    });
    await page.clock.fastForward(1100);
    await page.clock.fastForward(300);
    assert.equal(await page.evaluate(() => test.exited), false, 'accepted shutdown does not claim the service has exited');
    assert.equal(await page.evaluate(() => test.closed), false);
    await page.evaluate(() => test.held.health.resolve({ ok: false }));
    await page.evaluate(() => test.exitPending);
    assert.equal(await page.evaluate(() => test.exited), true, 'observer declares exit only after the service is unreachable');
    await page.clock.resume();

    await fixture({ native: false });
    await page.clock.install();
    await page.evaluate(() => { window.fetch = async () => ({ ok: false }); test.exitPending = exitServiceUnderTest(); });
    await page.clock.fastForward(300);
    await page.evaluate(() => test.exitPending);
    assert.equal(await page.evaluate(() => test.closed), true, 'ordinary shutdown preserves its existing close path');
    assert.deepEqual(await calls('get'), [], 'ordinary shutdown never probes native capabilities');
    await page.clock.resume();
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, errors,
      verified: ['native-only initialization', 'persisted preference and rollback', 'single cancellable request with stale async fencing',
        'stage debounce flush and explicit discard', 'recording completion, failed partial outcome and natural completion',
        'automatic versus explicit confirmation', 'HTTP pending observer and actual health disconnect', 'responsive dialog layouts'],
      scope: 'Actual UI module and exitService source with controlled native/service/recording interfaces in Chrome.' }, null, 2));
    console.log('Main window lifecycle browser checks passed: native gating, preferences, request fencing, persistence, recording, HTTP observer, responsive screenshots.');
    console.log('Screenshots: ' + output);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
