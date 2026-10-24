#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { readAssets } = require('./ui-assets');
const root = path.resolve(__dirname, '..'), web = path.join(root, 'plugin/ui'), output = path.join(root, 'output/playwright/butterfly');

async function renderContract(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setContent('<body style="margin:0;background:#020304"><canvas style="width:100vw;height:100vh"></canvas></body>');
  for (const name of ['stage-runtime', 'space-stage']) await page.addScriptTag({ path: path.join(web, 'vendor', name + '.js') });
  await page.evaluate(async () => {
    const canvas = document.querySelector('canvas'), original = canvas.getContext.bind(canvas);
    canvas.getContext = (type, ...args) => { const value = original(type, ...args); if (/webgl/.test(type)) window.gl = value; return value; };
    window.host = SpaceStagePure.create(canvas, { qualityMode: 'medium', deviceTier: 'high' });
    await host.select('butterfly-vortex'); host.resize(innerWidth, innerHeight);
    window.clock = 0;
    window.draw = (extra = {}) => {
      clock += 100;
      host.frame({ now: clock, sceneTime: clock / 1000, time: clock / 1000, dt: 0, dynamicDt: 0, playing: true,
        bands: { bass: 0, mid: 0, treble: 0 }, pointer: { active: false, click: { serial: 0, x: 0, y: 0 } }, ...extra });
      const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let hash = 2166136261, lit = 0;
      for (let i = 0; i < pixels.length; i += 16) {
        const value = pixels[i] + pixels[i + 1] + pixels[i + 2]; hash = Math.imul(hash ^ value, 16777619); if (value > 60) lit++;
      }
      return { hash: hash >>> 0, lit };
    };
  });
  const signals = await page.evaluate(() => {
    const quiet = draw(), loud = draw({ bands: { bass: .9, mid: .8, treble: .7 } });
    host.setParams({ reactivity: 0 }); const disabledQuiet = draw(), disabledLoud = draw({ bands: { bass: .9, mid: .8, treble: .7 } });
    host.setParams({ reactivity: .7 });
    const beforePointer = draw();
    const pointer = { active: true, x: .65, y: .2, click: { serial: 0, x: .65, y: .2 } };
    const hovered = draw({ pointer });
    host.setParams({ pointerStrength: 0 }); for (let i = 0; i < 30; i++) draw();
    const disabledPointer = draw(), disabledHover = draw({ pointer });
    host.setParams({ pointerStrength: 1 });
    return { quiet, loud, disabledQuiet, disabledLoud, beforePointer, hovered, disabledPointer, disabledHover };
  });
  assert.ok(signals.quiet.lit > 100, 'butterfly draws a visible silhouette');
  assert.notEqual(signals.quiet.hash, signals.loud.hash, 'audio changes actual wing pixels at a fixed animation time');
  assert.equal(signals.disabledQuiet.hash, signals.disabledLoud.hash, 'reactivity zero disables actual audio modulation');
  assert.notEqual(signals.beforePointer.hash, signals.hovered.hash, 'pointer changes actual rendered pixels');
  assert.equal(signals.disabledPointer.hash, signals.disabledHover.hash, 'pointer strength zero disables the field');
  const phases = {};
  for (const mode of ['butterfly', 'swarm', 'vortex']) {
    phases[mode] = await page.evaluate(async mode => {
      await host.select('butterfly-vortex', { params: { performance: mode } });
      for (let i = 0; i < 65; i++) host.frame({ now: clock += 100, time: clock / 1000, sceneTime: clock / 1000, dt: .1, dynamicDt: .1, playing: true, bands: { bass: .3, mid: .2, treble: .15 } });
      return { pixels: draw(), stats: host.stats() };
    }, mode);
    assert.ok(phases[mode].pixels.lit > 100, mode + ' remains visible');
    await page.screenshot({ path: path.join(output, mode + '.png') });
  }
  assert.equal(new Set(Object.values(phases).map(p => p.pixels.hash)).size, 3, 'three performance modes render distinct compositions');
  const reduced = await page.evaluate(() => {
    const first = draw({ reduced: true, dynamicDt: 0 });
    const second = draw({ reduced: true, dynamicDt: 0, time: 300, sceneTime: 300, bands: { bass: .9, mid: .7, treble: .8 }, pointer: { active: true, x: -.8, y: .9, click: { serial: 99, x: -.8, y: .9 } } });
    return { first, second };
  });
  assert.deepEqual(reduced.first, reduced.second, 'reduced motion freezes pixels despite clock, pointer and audio changes');
  const lowVortex = await page.evaluate(() => { host.setQualityMode('low'); return { pixels: draw({ reduced: true }), stats: host.stats() }; });
  assert.ok(lowVortex.pixels.lit > 1000, 'low quality retains luminous vortex arms, not just a sparse point field');
  assert.ok(lowVortex.stats.drawCalls <= 40 && lowVortex.stats.points <= 12000 && lowVortex.stats.triangles <= 80000, 'low vortex respects its resource budget');
  const changedWhileFrozen = await page.evaluate(() => {
    host.setParams({ performance: 'butterfly', pointSize: 1.7 });
    const pixels = draw({ reduced: true }); return { pixels, scene: host.stats().sceneStats.primary };
  });
  assert.equal(changedWhileFrozen.scene.scatter, 0); assert.equal(changedWhileFrozen.scene.vortex, 0);
  assert.notEqual(changedWhileFrozen.pixels.hash, lowVortex.pixels.hash, 'explicit mode edits redraw the frozen scene');
  await page.setViewportSize({ width: 390, height: 844 });
  const portrait = await page.evaluate(() => { host.resize(innerWidth, innerHeight); return draw(); });
  assert.ok(portrait.lit > 50, 'portrait frames the scene');
  await page.screenshot({ path: path.join(output, 'portrait.png') });
  const disposed = await page.evaluate(() => { host.dispose(); return host.stats(); });
  assert.equal(disposed.resources, 0); assert.equal(disposed.tasks, 0);
  assert.deepEqual(errors, [], 'no shader or runtime errors');
  await page.close();
  return { signals, phases, reduced, portrait };
}

async function appContract(browser) {
  const fixture = await startFixture();
  let context;
  try {
    await fixture.seed();
    await fixture.api('/v1/settings', 'PUT', { reduce_motion: false, space3d: { sceneSource: 'coast', qualityMode: 'low', lyrics: false, cinema: false, playerAutoHide: false } });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true });
    await fixture.connect(context);
    const token = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'vmusicd.json'), 'utf8')).token;
    const assets = new Map(readAssets().map(a => [a.path, a]));
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== fixture.base) return route.continue();
      if (url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(web, 'index.html'), 'utf8').replace('__VMUSIC_TOKEN_VALUE__', token) });
      const asset = assets.get(url.pathname);
      if (asset) return route.fulfill({ status: 200, contentType: asset.mime === 'JS' ? 'application/javascript' : 'text/css', body: fs.readFileSync(asset.file) });
      if (/^\/space-scene-preview\/[a-z0-9-]+\.jpg$/.test(url.pathname)) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: fs.readFileSync(path.join(web, url.pathname)) });
      return route.continue();
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && /THREE|shader|WebGL/i.test(m.text())) errors.push(m.text()); });
    await page.goto(fixture.base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.Space3D && document.getElementById('space3d').dataset.spReady === '1');
    await page.locator('#space3d-entry').click();
    await page.waitForFunction(() => Space3D.stats().renderer?.state === 'ready');
    await page.evaluate(() => {
      const original = Stage.presentation;
      Stage.presentation = () => ({ ...original(), playing: true, reduced: false }); Stage.kick();
    });
    await page.locator('#sp-page-toggle').click();
    await page.locator('#sp-console-toggle').click();
    await page.locator('#sp-source').selectOption('butterfly-vortex');
    await page.waitForFunction(() => Space3D.stats().renderer?.id === 'butterfly-vortex' && Space3D.stats().renderer.state === 'ready');
    await page.locator('#sp-param-performance').selectOption('butterfly');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => Space3D.stats().renderer.sceneStats.primary.elapsed > .3);
    const before = await page.evaluate(() => Space3D.stats().renderer.sceneStats.primary.interactionBoost);
    await page.mouse.click(610, 380);
    await page.waitForFunction(previous => Space3D.stats().renderer.sceneStats.primary.interactionBoost > previous + .1, before);
    const camera = await page.evaluate(() => Space3D.stats().camera.world);
    await page.mouse.move(630, 450); await page.mouse.down(); await page.mouse.move(780, 490, { steps: 10 }); await page.mouse.up();
    assert.notDeepEqual(await page.evaluate(() => Space3D.stats().camera.world), camera, 'real drag controls the existing camera');
    await page.mouse.dblclick(630, 450, { delay: 60 });
    await page.locator('#sp-console-toggle').click();
    await page.locator('#sp-param-performance').selectOption('vortex');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => Space3D.stats().renderer.sceneStats.primary.vortex > .7, null, { timeout: 30000 });
    await page.screenshot({ path: path.join(output, 'app-vortex.png') });
    await page.locator('#sp-console-toggle').click(); await page.locator('#sp-param-reduced').check(); await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
    const frozen = await page.evaluate(() => Space3D.stats().renderer.sceneStats.primary.elapsed);
    await page.touchscreen.tap(550, 350); await page.waitForTimeout(450);
    assert.equal(await page.evaluate(() => Space3D.stats().renderer.sceneStats.primary.elapsed), frozen, 'real touch respects reduced motion');
    await page.locator('#sp-console-toggle').click();
    await page.locator('#sp-param-performance').selectOption('butterfly');
    await page.waitForFunction(() => Space3D.stats().renderer.sceneStats.primary.scatter === 0 && Space3D.stats().renderer.sceneStats.primary.vortex === 0);
    assert.equal(await page.evaluate(() => Space3D.stats().renderer.sceneStats.primary.elapsed), frozen, 'editing a reduced scene does not advance the clock');
    await page.locator('#sp-param-performance').selectOption('vortex');
    await page.locator('#sp-param-reduced').uncheck(); await page.keyboard.press('Escape');
    await page.waitForFunction(previous => Space3D.stats().renderer.sceneStats.primary.elapsed > previous, frozen);
    await page.locator('#sp-page-toggle').click();
    assert.equal(await page.locator('#sp-canvas canvas').count(), 1, 'returning home keeps one shared renderer');
    await page.locator('#sp-page-toggle').click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'app-portrait.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no portrait overflow');
    await page.evaluate(() => Space3D.close());
    assert.equal(await page.locator('#sp-canvas canvas').count(), 0, 'exiting disposes the canvas');
    assert.deepEqual(errors, [], 'no full-app runtime or shader errors');
    return { fullApp: true, mouse: true, touchReduced: true, camera: true, modeControls: true, portrait: true };
  } finally { if (context) await context.close(); await fixture.close(); }
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
  try {
    const rendered = await renderContract(browser);
    const app = await appContract(browser);
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ renderer: 'software WebGL2', hardwareFps: 'unmeasured', rendered, app }, null, 2));
    console.log('Butterfly browser checks passed: three compositions, actual audio/pointer pixels, disabled controls, frozen pixels, real app mouse/touch/camera, portrait and cleanup. Hardware FPS unmeasured.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
