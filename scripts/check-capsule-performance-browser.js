// SPDX-License-Identifier: MIT
// Full shipped page + DBX bridge fixture; playback uses an isolated real service.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const web = path.resolve(__dirname, '../plugin/ui');
const output = path.resolve(__dirname, '../output/playwright/capsule-performance');
const baseline = process.env.CAPSULE_AUDIT_BASELINE === '1';
const engine = process.env.CAPSULE_BROWSER || 'chromium';

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const fixture = await startFixture();
  let browser;
  try {
    const track = await fixture.seed();
    const launchOptions = { headless: true };
    if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) launchOptions.executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
    browser = await playwright[engine].launch(launchOptions);
    const page = await browser.newPage({ viewport: { width: 268, height: 55 }, deviceScaleFactor: 2 });
    const errors = [], requests = [];
    let failCommand = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeBinding('bridgeRequest', async (_, method, params) => {
      requests.push({ method, op: params.op || 'GET' });
      if (failCommand && method === 'v1/player/play') {
        failCommand = false;
        return { status: 500, body: { error: { code: 'test_failure', message: '测试命令失败' } } };
      }
      if (method === 'studio/events/subscribe') return { status: 200, body: { ok: true } };
      if (method.startsWith('v1/online/account')) return { status: 401, body: { error: { code: 'auth_required' } } };
      if (method === 'v1/online/sources') return { status: 200, body: { sources: [] } };
      if (method.startsWith('v1/recommend') || method.startsWith('v1/online/search')) return { status: 200, body: { tracks: [], total: 0, sources: [] } };
      if (method === 'v1/home/quote') return { status: 200, body: { hitokoto: '测试' } };
      const query = new URLSearchParams(params.query || {}).toString();
      try {
        return { status: 200, body: await fixture.api('/' + method + (query ? '?' + query : ''), params.op || 'GET', params.body) };
      } catch (error) {
        return { status: 404, body: { error: { code: 'not_found', message: error.message } } };
      }
    });
    await page.addInitScript(() => {
      window.audit = { raf: 0, ticks: 0, measures: 0, hiddenMutations: 0, sizes: [], actions: [] };
      localStorage.setItem('vmusic.skin', 'orbit');
      if (!localStorage.getItem('vmusic.theme.v2')) localStorage.setItem('vmusic.theme.v2', 'mineral');
      const nativeRaf = window.requestAnimationFrame;
      window.requestAnimationFrame = function (fn) {
        return nativeRaf.call(window, time => { if (fn.name === 'tickCapsuleMarquee') audit.raf++; fn(time); });
      };
      const nativeTimeout = window.setTimeout;
      window.setTimeout = function (fn, ms, ...args) {
        return nativeTimeout.call(window, typeof fn === 'function' ? function () {
          if (fn.name === 'tickCapsuleMarquee') audit.ticks++;
          fn(...args);
        } : fn, ms);
      };
      for (const [prototype, property] of [[HTMLElement.prototype, 'offsetWidth'], [Element.prototype, 'clientWidth']]) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
        Object.defineProperty(prototype, property, { ...descriptor, get() {
          if (this.matches('.capsule-title,.capsule-artist,.capsule-line')) audit.measures++;
          return descriptor.get.call(this);
        } });
      }
      const listeners = new Set();
      window.emit = params => listeners.forEach(listener => listener({ method: 'studio/event', params }));
      window.dbxPlugin = {
        context: { surface: 'window' }, capabilities: { floating: true },
        ready: new Promise(resolve => nativeTimeout(resolve, 50)),
        invoke: (method, params) => bridgeRequest(method, params),
        onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        assetUrl: file => new URL(file, location.href).href,
        openWorkbench: async () => { audit.actions.push('open'); },
        floating: {
          setSize: async (width, height) => { audit.sizes.push({ width, height }); },
          close: async () => { audit.actions.push('close'); },
          beginDrag: async () => {}, endDrag: async () => {},
        },
      };
      document.addEventListener('DOMContentLoaded', () => {
        const app = document.querySelector('.app');
        new MutationObserver(records => { audit.hiddenMutations += records.length; })
          .observe(app, { subtree: true, attributes: true, characterData: true, childList: true });
      });
    });
    await page.route('http://capsule.test/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      const file = path.resolve(web, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(web + path.sep) || !fs.existsSync(file)) return route.abort();
      return route.fulfill({ path: file });
    });
    await page.goto('http://capsule.test/?dbxPluginWindow=audit');
    await page.waitForFunction(() => document.getElementById('conn').textContent === '服务已连接');
    await page.waitForFunction(() => document.getElementById('capsule-title').textContent === 'Layout Audit Fixture');
    await page.waitForTimeout(500);
    const startup = requests.slice();
    const snap = await fixture.api('/v1/state');
    await page.evaluate(() => {
      document.getElementById('capsule-title').textContent = '短';
      document.getElementById('capsule-artist').textContent = '短';
      if (typeof refreshCapsuleMarquee === 'function') refreshCapsuleMarquee();
    });
    async function sample() {
      // Content edits legitimately trigger ResizeObserver on the next layout.
      // Start the steady-state sample after that delivery has completed.
      await page.waitForTimeout(200);
      await page.evaluate(() => { audit.raf = audit.ticks = audit.measures = audit.hiddenMutations = 0; });
      for (let i = 0; i < 10; i++) {
        await page.evaluate(snap => {
          for (let n = 0; n < 50; n++) emit({ ...snap, type: 'state', position_ms: n * 20 });
          for (let n = 0; n < 30; n++) emit({ type: 'spectrum', bands: new Array(64).fill(.5) });
        }, snap);
        await page.waitForTimeout(1000);
      }
      return page.evaluate(() => ({ ...audit }));
    }
    const short = await sample();
    await page.evaluate(() => {
      syncCapsule({ title: '完整显示的很长歌曲标题用于滚动测试', artist: 'Long Artist Name', album: 'Audit' }, null);
    });
    const long = await sample();
    const report = { startup, short, long, errors };
    const reportPath = path.join(output, `${engine}-${baseline ? 'before' : 'after'}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ engine, baseline, startupRequests: startup.length, short, long, errors }, null, 2));
    if (!baseline) {
      assert.equal(short.raf + short.ticks, 0, 'short text has no recurring marquee callbacks');
      assert.ok(long.ticks <= 27 && long.ticks >= 20 && long.raf === 0, 'long text ticks at 2.5Hz without rAF');
      assert.equal(short.measures + long.measures, 0, 'steady text never remeasures layout');
      assert.equal(short.hiddenMutations + long.hiddenMutations, 0, 'state/spectrum bursts never update hidden app');
      assert.ok(!startup.some(call => /tracks$|account|sources|recommend|lyrics|beatmap|devices|overlay|diagnostics|library/.test(call.method)), 'startup requests only capsule dependencies');
      assert.equal(long.sizes.length, 1, 'unchanged native window size is sent once');

      // Test browser motion preference and visibility independently of playback events.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.waitForTimeout(200);
      await page.evaluate(() => { audit.ticks = 0; });
      await page.waitForTimeout(1000);
      assert.equal(await page.evaluate(() => audit.ticks), 0, 'reduced motion stops marquee');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.waitForTimeout(900);
      assert.ok(await page.evaluate(() => audit.ticks > 0), 'motion preference restoration resumes');
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
        audit.ticks = 0;
      });
      await page.waitForTimeout(1000);
      assert.equal(await page.evaluate(() => audit.ticks), 0, 'hidden document stops');
      await page.evaluate(() => {
        delete document.hidden;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForTimeout(900);
      assert.ok(await page.evaluate(() => audit.ticks > 0), 'visibility restoration resumes');

      await page.evaluate(() => {
        const lines = document.querySelectorAll('.capsule-line');
        lines.forEach(line => { line.style.width = '800px'; });
      });
      await page.waitForTimeout(200);
      await page.evaluate(() => { audit.ticks = 0; });
      await page.waitForTimeout(900);
      assert.equal(await page.evaluate(() => audit.ticks), 0, 'ResizeObserver stops text that now fits');
      await page.evaluate(() => {
        document.querySelectorAll('.capsule-line').forEach(line => line.style.removeProperty('width'));
        document.getElementById('capsule-title').style.fontSize = '18px';
      });
      await page.waitForTimeout(900);
      assert.ok(await page.evaluate(() => audit.ticks > 0 && audit.measures > 0), 'font/width changes remeasure and resume');
      await page.evaluate(() => document.getElementById('capsule-title').style.removeProperty('font-size'));
    }
    if (!baseline) {
      failCommand = true;
      await page.locator('#capsule-play').click();
      await page.waitForFunction(() => document.getElementById('capsule-title').textContent.includes('测试命令失败'));
      assert.equal((await fixture.api('/v1/state')).playing, false, 'failed play preserves backend state');
      assert.equal(await page.locator('body').evaluate(el => el.classList.contains('is-playing')), false, 'failed play rolls back visible state');
      await page.evaluate(() => clearCapsuleNotice());
    }
    await page.locator('#capsule-play').click();
    assert.equal((await fixture.api('/v1/state')).playing, true);
    await page.locator('#capsule-play').click();
    assert.equal((await fixture.api('/v1/state')).playing, false);
    await page.locator('#capsule-next').click();
    await page.locator('#capsule-prev').click();
    assert.ok(requests.some(call => call.method === 'v1/player/next') && requests.some(call => call.method === 'v1/player/previous'));
    await page.evaluate(() => emit({ type: 'error', source: 'qq', message: '测试播放错误' }));
    await page.waitForFunction(() => document.getElementById('capsule-title').textContent.includes('测试播放错误'));
    await page.locator('#capsule-expand').click();
    await page.waitForFunction(() => audit.actions.includes('close'));
    assert.deepEqual(await page.evaluate(() => audit.actions), ['open', 'close']);
    assert.deepEqual(errors, []);
    if (!baseline) {
      // Reload the entire shipped page to prove palette restoration uses minimal boot.
      for (const theme of ['mineral', 'orbit-fog', 'custom-studio', 'anime-sakura']) {
        await page.evaluate(theme => {
          localStorage.setItem('vmusic.theme.v2', theme);
          localStorage.setItem('vmusic.theme.custom.v1', JSON.stringify({ bg: '#e4e2dc', accent: '#395675', accent2: '#76594b' }));
        }, theme);
        const before = requests.length;
        await page.reload();
        await page.waitForFunction(() => document.getElementById('conn').textContent === '服务已连接');
        await page.waitForFunction(() => document.getElementById('capsule-title').textContent === 'Layout Audit Fixture');
        const restored = await page.evaluate(() => Theme.current().id);
        assert.equal(restored, theme, 'saved theme restores: ' + theme);
        assert.ok(!requests.slice(before).some(call => /account|sources|recommend|lyrics|beatmap|devices|overlay/.test(call.method)));
      }
      assert.deepEqual(errors, []);
      report.verified = ['motion', 'visibility', 'font/resize', 'play failure rollback', 'play/pause', 'previous/next', 'error notice', 'ordered expansion', 'dark/light/custom/anime palette restore'];
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log('PASS capsule startup, steady workload, motion/visibility/resize, playback/rollback, errors, ordered expansion and saved palettes');
  } finally { if (browser) await browser.close(); await fixture.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
