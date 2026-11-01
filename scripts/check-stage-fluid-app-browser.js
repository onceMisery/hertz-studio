#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Complete production UI, controlled media, real GPU. DBX uses an opaque iframe
// with a controlled SDK, not the native DBX client. --performance runs 16 x 60s.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { cover, pixels } = require('./check-stage-fluid-browser');
const root = path.resolve(__dirname, '..'), web = path.join(root, 'plugin/ui');
const output = process.env.HERTZ_FLUID_EVIDENCE_DIR ? path.resolve(process.env.HERTZ_FLUID_EVIDENCE_DIR)
  : path.join(root, 'output/playwright/stage-fluid-app');
const performance = process.argv.includes('--performance');
const visual = process.argv.includes('--visual');
const duration = Number(process.env.HERTZ_FLUID_SAMPLE_SECONDS || 60);
const caseFilter = process.env.HERTZ_FLUID_CASE;
assert.ok(Number.isFinite(duration) && duration > 0 && duration <= 120);
const snap = { type: 'state', track_id: 'fluid-track', playing: true, buffering: false,
  position_ms: 1000, duration_ms: 180000, volume: .8, mode: 'repeat' };

function dbxSdk(snapshot) {
  const storage = {};
  window.dbxPlugin = {
    ready: Promise.resolve(), context: { surface: 'tab' },
    storage: { get: async () => storage, set: async (key, value) => Object.assign(storage, value) },
    onEvent: () => () => {},
    invoke: async method => {
      const body = method === 'v1/state' ? snapshot : method === 'v1/tracks/fluid-track'
        ? { id: 'fluid-track', title: '晚风经过旧唱片店', artist: '林间来信', duration_ms: 180000 }
        : method === 'v1/tracks' ? { tracks: [], total: 0 }
        : method === 'v1/player/queue' ? { queue: [], index: -1 }
          : method === 'v1/room' ? { mode: 'local' }
            : method === 'v1/devices' ? { devices: [] }
              : method === 'v1/library/scan/roots' ? { roots: [] }
                : method === 'v1/library/scan/history' ? { runs: [] }
                  : method === 'v1/playlists' || method === 'v1/favorites' ? []
                    : method.startsWith('v1/recommend/daily') ? { tracks: [], pending: [], sources: [] }
                      : method === 'v1/health' ? { backend: 'fixture', version: 'fixture', protocol_version: 1 }
                        : method === 'v1/tracks/facets' ? { facets: [] } : {};
      return { status: 200, body };
    }
  };
}
function drive({ cover, snapshot }) {
  window.fixture = { energy: .45, phase: 0, fresh: true };
  document.body.classList.add('stage-open');
  document.getElementById('now-title').textContent = '晚风经过旧唱片店 · 一段很长的现场录音';
  document.getElementById('now-artist').textContent = '林间来信';
  Stage.setTrack({ id: snapshot.track_id, title: '晚风经过旧唱片店', duration_ms: 180000 }, cover);
  Stage.setCoverFollow(true);
  Stage.setLyrics({ lines: [{ start_ms: 0, text: '晚风穿过街角的灯' },
    { start_ms: 24000, text: 'We keep the quiet moments close' }, { start_ms: 48000, text: '让时间在唱片里停留' }] });
  window.fixtureTimer = setInterval(() => {
    fixture.phase += .12;
    const bands = new Float32Array(64);
    const pulse = fixture.profile === 'rhythm' ? .18 + .82 * Math.pow(Math.max(0, Math.sin(fixture.phase * 1.7)), 10) : 1;
    for (let i = 0; i < bands.length; i++) {
      const voice = fixture.profile === 'voice' ? .2 + .8 * Math.exp(-Math.pow(i - 26, 2) / 150) : 1;
      bands[i] = fixture.energy * (.55 + .4 * Math.sin(fixture.phase + i * .2)) * pulse * voice;
    }
    // Feed the production event path so the original spectrum/particles are
    // included. Both arms use precisely the same media input and UI.
    handleEvent({ type: 'spectrum', bands });
    Stage.setSnapshot(snapshot);
  }, 33);
  Stage.setSnapshot(snapshot);
}
async function sample(view, seconds) {
  return view.evaluate(seconds => new Promise(resolve => {
    if (window.HertzPerf) { HertzPerf.setEnabled(true); HertzPerf.reset(); }
    const intervals = [], start = performance.now(), before = StageFluid.stats();
    let last = 0;
    function frame(at) {
      if (last) intervals.push(at - last); last = at;
      if (at - start < seconds * 1000) { requestAnimationFrame(frame); return; }
      const sorted = intervals.slice().sort((a, b) => a - b), after = StageFluid.stats();
      resolve({ seconds: (at - start) / 1000, frames: intervals.length,
        median: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)],
        maximum: sorted[sorted.length - 1], intervals, stageTier: Stage.tier(),
        gate: Stage.gateRates().find(gate => gate.name === 'stage-fluid'),
        actualFluidFps: (after.frames - before.frames) * 1000 / (at - start), resources: after,
        fluidCpu: window.HertzPerf ? HertzPerf.summary().metrics['gate.stage-fluid'] || null : null });
    }
    requestAnimationFrame(frame);
  }), seconds);
}
async function run() {
  fs.mkdirSync(output, { recursive: true });
  const app = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const html = body => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(body); };
    if (url.pathname === '/host') return html('<style>body{margin:0}</style><iframe sandbox="allow-scripts" src="/app" style="width:100%;height:100vh;border:0;display:block"></iframe>');
    if (url.pathname === '/app') return html(app.replace('<head>', '<head><script>(' + dbxSdk + ')(' + JSON.stringify(snap) + ');</script>'));
    const file = path.join(web, url.pathname);
    if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { response.writeHead(404).end(); return; }
    const extension = path.extname(file), types = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
    response.setHeader('Content-Type', types[extension] || 'application/octet-stream'); response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let service, browser;
  const results = [], errors = [];
  try {
    service = await startFixture();
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    let caseIndex = -1;
    for (const host of ['standalone', 'dbx-opaque-fixture']) {
      for (const viewport of (performance ? [{ width: 1920, height: 1080 }, { width: 3840, height: 2160 }] : [visual ? { width: 520, height: 960 } : { width: 1440, height: 1000 }])) {
        for (const particles of (performance ? [false, true] : [true])) {
          caseIndex++;
          if (caseFilter !== undefined && String(caseIndex) !== caseFilter) continue;
          const context = await browser.newContext({ viewport, deviceScaleFactor: 1,
            ...(visual && host === 'standalone' ? { recordVideo: { dir: path.join(output, 'videos'), size: viewport } } : {}) });
          await context.addInitScript(() => {
            Object.defineProperty(navigator, 'hardwareConcurrency', { value: 12 });
            Object.defineProperty(navigator, 'deviceMemory', { value: 16 });
          });
          await service.connect(context);
          const page = await context.newPage(); page.on('pageerror', error => errors.push({ host, message: error.stack }));
          // A controlled media channel avoids touching the user's library or
          // relying on a real sound device. It changes no production code.
          if (host === 'standalone') await page.routeWebSocket('**/ws?*', socket => socket.send(JSON.stringify(snap)));
          await page.goto(host === 'standalone' ? service.base : 'http://127.0.0.1:' + server.address().port + '/host');
          const view = host === 'standalone' ? page : await (await page.waitForSelector('iframe')).contentFrame();
          await view.waitForFunction(() => document.getElementById('conn')?.textContent === '服务已连接');
          await view.evaluate(() => { Skins.apply('classic'); Theme.apply('mineral'); });
          await view.evaluate(drive, { cover, snapshot: snap });
          await view.evaluate(particles => StageControl.set({ fluidEnabled: false, dust: particles, ripples: particles }), particles);
          await page.waitForTimeout(4200);
          const probe = await view.evaluate(() => {
            const canvas = document.createElement('canvas'), gl = canvas.getContext('webgl2');
            const ext = gl?.getExtension('WEBGL_debug_renderer_info');
            const result = { browser: navigator.userAgent, stageTier: Stage.tier(), gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unavailable' };
            gl?.getExtension('WEBGL_lose_context')?.loseContext(); return result;
          });
          if (performance) {
            await view.evaluate(() => StageControl.set({ fluidEnabled: true }));
            await view.waitForFunction(() => ['active', 'suspended', 'unavailable'].includes(StageFluid.status().state));
            const admission = await view.evaluate(() => ({ fluid: StageFluid.stats(), gate: Stage.gateRates().find(gate => gate.name === 'stage-fluid') }));
            if (admission.fluid.state !== 'active') {
              assert.equal(admission.fluid.contexts, 0);
              assert.equal(admission.gate.target, 0);
              const record = { caseIndex, host, viewport, particles, probe, kind: 'not-admitted', admission };
              results.push(record);
              fs.writeFileSync(path.join(output, 'performance.json'), JSON.stringify(results, null, 2));
              console.log('NOT ADMITTED ' + JSON.stringify({ host, viewport, particles, reason: admission.fluid.reason }));
              await context.close(); continue;
            }
            await view.evaluate(() => StageControl.set({ fluidEnabled: false }));
            await page.waitForTimeout(1200);
            console.log('Sampling baseline: ' + JSON.stringify({ host, viewport, particles, seconds: duration }));
            const off = await sample(view, duration);
            console.log('Baseline complete: ' + JSON.stringify({ median: off.median, p95: off.p95, stageTier: off.stageTier }));
            await view.evaluate(() => StageControl.set({ fluidEnabled: true }));
            await view.waitForFunction(() => ['active', 'suspended', 'unavailable'].includes(StageFluid.status().state));
            await page.waitForTimeout(2000);
            const on = await sample(view, duration);
            const medianIncrease = on.median / off.median - 1, p95Delta = on.p95 - off.p95;
            const protectedSuspension = on.stageTier === 0 && on.resources.state === 'suspended'
              && on.resources.contexts === 0 && on.gate.target === 0;
            const record = { caseIndex, host, viewport, particles, probe, sampleSeconds: duration, off, on, medianIncrease, p95Delta,
              budgetPassed: medianIncrease <= .10 && p95Delta <= 4, effectMeasured: on.actualFluidFps > 0, protectedSuspension };
            results.push(record);
            fs.writeFileSync(path.join(output, 'performance.json'), JSON.stringify(results, null, 2));
            console.log(JSON.stringify({ host, viewport, particles, medianIncrease, p95Delta, fluidFps: on.actualFluidFps, tier: on.stageTier, passed: record.budgetPassed }));
          } else {
            await page.screenshot({ path: path.join(output, host + '-off.png') });
            await view.evaluate(() => StageControl.set({ fluidEnabled: true }));
            await view.waitForFunction(host => StageFluid.status().state === (host === 'standalone' ? 'active' : 'unavailable'), host);
            await page.waitForTimeout(3000);
            if (host === 'standalone') assert.ok((await pixels(view)).exposedMass > 5000);
            else assert.equal(await view.evaluate(() => StageFluid.stats().contexts), 0);
            await page.screenshot({ path: path.join(output, host + '-on.png') });
            if (visual && host === 'standalone') {
              for (const [profile, energy] of [['quiet', .15], ['rhythm', .8], ['voice', .45]]) {
                await view.evaluate(({ profile, energy }) => { fixture.profile = profile; fixture.energy = energy; }, { profile, energy });
                await page.waitForTimeout(2800);
                await view.locator('#stage').screenshot({ path: path.join(output, 'controlled-' + profile + '.png') });
              }
              const area = await view.locator('.stage-fluid-canvas').boundingBox();
              await page.mouse.move(area.x + 12, area.y + area.height * .4);
              await page.mouse.move(area.x + 80, area.y + area.height * .6, { steps: 30 });
              await page.waitForTimeout(1000);
              await view.evaluate(() => StageControl.open());
              await view.locator('#sc-fluid-fluidEnabled').scrollIntoViewIfNeeded();
              await page.screenshot({ path: path.join(output, 'fluid-controls.png') });
              await view.evaluate(() => StageControl.close());
            }
            for (const owner of ['Stage3D', 'Space3D']) {
              await view.evaluate(owner => window[owner].open(), owner);
              await view.waitForFunction(() => StageFluid.stats().contexts === 0);
              assert.equal(await view.evaluate(() => StageControl.values().fluidEnabled), true);
              await view.evaluate(owner => window[owner].close(), owner);
              await view.waitForFunction(host => StageFluid.status().state === (host === 'standalone' ? 'active' : 'unavailable'), host);
            }
            await page.setViewportSize({ width: 390, height: 900 });
            await view.evaluate(() => document.body.classList.remove('stage-open'));
            await view.waitForFunction(host => StageFluid.status().state === (host === 'standalone' ? 'suspended' : 'unavailable'), host);
            const frozen = await view.evaluate(() => StageFluid.stats().frames);
            await page.waitForTimeout(300);
            assert.equal(await view.evaluate(() => StageFluid.stats().frames), frozen);
            await view.evaluate(() => document.body.classList.add('stage-open'));
            await view.waitForFunction(host => StageFluid.status().state === (host === 'standalone' ? 'active' : 'unavailable'), host);
            results.push({ host, probe, handoff: ['Stage3D', 'Space3D'], mobileHiddenFreezes: true });
            console.log('PASS complete app: ' + host + ' ' + (host === 'standalone' ? 'real pixels' : 'explicit admission restriction') + ', real host handoffs, hidden mobile drawer');
          }
          const video = page.video();
          await context.close();
          if (video) await video.saveAs(path.join(output, host + '-controlled.webm'));
        }
      }
    }
    assert.deepEqual(errors, []);
    if (performance) assert.ok(results.length > 0 && results.every(result => result.kind === 'not-admitted' || result.protectedSuspension || (result.budgetPassed && result.effectMeasured)),
      'Each pair must measure a running effect within budget, or prove the existing eco protection released it; suspension is not a performance pass');
  } finally {
    fs.writeFileSync(path.join(output, performance ? 'performance-result.json' : 'result.json'), JSON.stringify({ results, errors,
      scope: 'Production UI and WebGL; controlled media/DBX SDK. Native DBX, physical GPU matrix and human visual acceptance are not covered.' }, null, 2));
    if (browser) await browser.close(); if (service) await service.close();
    await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
