#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// Real Space3D entries, scene pixels, preferences, camera/lyrics, frame gates
// and resource lifetime. Backend writes are held in this browser's fixture.
// node scripts/check-space3d-browser.js [--source]
// --source routes local HTML and registered JS/CSS after server authentication.
// Final packaged verification must omit it. SPACE_BASE defaults to port 18783;
// VMUSIC_DATA_DIR supplies the token. SPACE_OUT / PLAYWRIGHT_MODULE are optional.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { uiUrl, uiToken } = require('./ui-token');
const root = path.join(__dirname, '..'), web = path.join(root, 'plugin', 'ui');
const base = process.env.SPACE_BASE || 'http://127.0.0.1:18783';
const output = process.env.SPACE_OUT || path.join(root, 'output', 'playwright', 'space3d');
const sourceMode = process.argv.includes('--source');
const viewport = { width: 1707, height: 898 };
const assets = ['app.js', 'space3d.js', 'space3d.css', 'space-camera.js', 'space-fields.js', 'space-post.js',
  'space-layers.js', 'space-layers.css', 'creative-gl.js', 'creative-stage.js', 'backgrounds.js',
  'vendor/stage-runtime.js', 'stage.js', 'handdrawn.js', 'stage-coast.js', 'vendor/coast-stage.js', 'stage-zodiac.js', 'vendor/zodiac-stage.js', 'skins/skin-settings-sheet.js'];
const normalize = text => text.replace(/\r\n/g, '\n').trim();

function registeredAssets() {
  const registry = fs.readFileSync(path.join(root, 'crates/hertz-studio/src/assets.rs'), 'utf8'), map = new Map();
  const re = /"(\/[^"\s]+)",\s*(JS|CSS)\s*=>[^;]+include_str!\("([^"]+)"\)/g;
  for (const match of registry.matchAll(re)) {
    const file = path.resolve(root, 'crates/hertz-studio/src', match[3]);
    assert.ok(file.startsWith(path.resolve(web) + path.sep), 'registered source stays in plugin/ui');
    map.set(match[1], { file, contentType: match[2] === 'JS' ? 'application/javascript' : 'text/css' });
  }
  for (const asset of assets) assert.ok(map.has('/' + asset), 'asset is registered: ' + asset);
  return map;
}

// Observe real GL lifetime and draw arguments without adding a renderer/clock.
function installProbe() {
  const listeners = [], contexts = [], contextMap = new WeakMap();
  const settingsKeepalive = [], fetch = window.fetch;
  window.fetch = function (input, options) {
    const method = options && options.method || input && input.method || 'GET';
    if (new URL(typeof input === 'string' ? input : input.url, location.href).pathname === '/v1/settings' && method === 'PUT') {
      settingsKeepalive.push(!!(options && options.keepalive || input && input.keepalive));
      if (settingsKeepalive.length > 12) settingsKeepalive.shift();
    }
    return fetch.apply(this, arguments);
  };
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  const capture = options => typeof options === 'boolean' ? options : !!(options && options.capture);
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if ((this === window || this === document) && listener && !listeners.some(item =>
      item.target === this && item.type === type && item.listener === listener && item.capture === capture(options))) {
      listeners.push({ target: this, type, listener, capture: capture(options) });
    }
    return add.apply(this, arguments);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    const index = listeners.findIndex(item => item.target === this && item.type === type &&
      item.listener === listener && item.capture === capture(options));
    if (index >= 0) listeners.splice(index, 1);
    return remove.apply(this, arguments);
  };
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type) {
    const ours = this.classList.contains('sp-fields-canvas');
    if (ours && window.__spaceBlockGL && /^webgl/.test(type)) return null;
    const gl = getContext.apply(this, arguments);
    if (ours && gl && /^webgl/.test(type) && !contextMap.has(gl)) {
      const state = { gl, textures: new Set(), lost: false };
      contexts.push(state); contextMap.set(gl, state);
      // The browser destroys this generation's GPU objects on loss. Restored
      // textures must be counted as a new generation, even when the JS GL
      // context object itself is reused.
      add.call(this, 'webglcontextlost', () => { state.lost = true; state.textures.clear(); });
      add.call(this, 'webglcontextrestored', () => { state.lost = false; });
    }
    return gl;
  };
  const proto = WebGL2RenderingContext.prototype;
  const createTexture = proto.createTexture, deleteTexture = proto.deleteTexture, getExtension = proto.getExtension;
  proto.createTexture = function () {
    const texture = createTexture.apply(this, arguments), state = contextMap.get(this);
    if (state && texture) state.textures.add(texture);
    return texture;
  };
  proto.deleteTexture = function (texture) {
    const state = contextMap.get(this);
    if (state) state.textures.delete(texture);
    return deleteTexture.apply(this, arguments);
  };
  proto.getExtension = function (name) {
    const extension = getExtension.apply(this, arguments), state = contextMap.get(this);
    if (state && extension && name === 'WEBGL_lose_context' && !extension.__spaceWrapped) {
      const lose = extension.loseContext.bind(extension);
      extension.loseContext = function () { state.lost = true; return lose(); };
      extension.__spaceWrapped = true;
    }
    return extension;
  };
  const badModes = [], sceneModes = [];
  for (const name of ['drawArrays', 'drawArraysInstanced']) {
    const original = proto[name];
    proto[name] = function (mode, first, count, instances) {
      if (contextMap.has(this)) {
        if (typeof mode !== 'number') badModes.push(name + ': ' + String(mode));
        if (count !== 3) {
          sceneModes.push({ mode, count, instances });
          if (sceneModes.length > 8) sceneModes.shift();
        }
      }
      return original.apply(this, arguments);
    };
  }
  window.__spaceProbe = {
    resources: () => ({ contexts: contexts.filter(item => !item.lost && !item.gl.isContextLost()).length,
      textures: contexts.reduce((sum, item) => sum + item.textures.size, 0), listeners: listeners.length,
      nodes: document.querySelectorAll('*').length, canvases: document.querySelectorAll('canvas.sp-fields-canvas').length }),
    badModes, sceneModes, settingsKeepalive
  };
}

async function installPlayback(page) {
  await page.evaluate(() => {
    if (window.__spacePlayback) return;
    const original = Object.fromEntries(['presentation', 'spectrum', 'energy', 'tier', 'isLowFx', 'position'].map(key => [key, Stage[key]]));
    const oldLyrics = Stage.lyrics(), sample = new Float32Array(64).fill(0.6);
    const fixture = { playing: true, reduced: false, tier: 2, position: 2500 };
    window.__spacePlayback = { original, oldLyrics, fixture };
    Stage.presentation = () => Object.assign({}, original.presentation.call(Stage), {
      playing: fixture.playing, reduced: fixture.reduced, position: fixture.position, duration: 120000,
      track: { id: 'space-browser-fixture', title: '空间回归', artist: '测试', duration_ms: 120000 }
    });
    Stage.spectrum = () => sample; Stage.energy = () => 0.6;
    Stage.tier = () => fixture.tier; Stage.isLowFx = () => false; Stage.position = () => fixture.position;
    Stage.setLyrics({ lines: [
      { start_ms: 0, end_ms: 6000, text: '光沿着声音流动', words: [
        { start_ms: 0, end_ms: 1500, text: '光' }, { start_ms: 1500, end_ms: 3000, text: '沿着' },
        { start_ms: 3000, end_ms: 4500, text: '声音' }, { start_ms: 4500, end_ms: 6000, text: '流动' }] },
      { start_ms: 6000, end_ms: 12000, text: '我们听见同一片星空' },
      { start_ms: 12000, end_ms: 18000, text: '让每一句歌都有自己的空间' }
    ] });
    Stage.kick();
  });
}
async function restorePlayback(page) {
  await page.evaluate(() => {
    const saved = window.__spacePlayback;
    if (!saved) return;
    Object.assign(Stage, saved.original); Stage.setLyrics(saved.oldLyrics); delete window.__spacePlayback;
    delete document.hidden; delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange')); Stage.kick();
  });
}

async function reviewChecks(page, context, pass) {
  const evidence = {};
  evidence.occlusion = await page.evaluate(() => ({ visible: Stage.isStageVisible(), hidden: Stage.isHidden(),
    rates: Stage.gateRates().filter(g => ['lyrics', 'particles', 'energy'].includes(g.name)) }));
  await page.evaluate(() => {
    __spacePlayback.fixture.playing = false;
    document.body.classList.remove('is-playing');
    Space3D.configure({ cinema: false, freeCam: { locked: false }, lyrics: false });
    CreativeStage.setPreset({ scene: 'towers', director: false, bindings: [], cues: [] });
    Space3D.setSource('creative');
  });
  await page.waitForTimeout(1600);
  const before = await page.evaluate(() => SpaceCamera.pose().radius);
  await page.evaluate(() => {
    window.__reviewDraws = 0;
    window.__reviewDraw = WebGL2RenderingContext.prototype.drawArrays;
    WebGL2RenderingContext.prototype.drawArrays = function () {
      if (this.canvas.closest('#sp-host-creative')) __reviewDraws++;
      return __reviewDraw.apply(this, arguments);
    };
    document.getElementById('space3d').dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(1100);
  evidence.creative = await page.evaluate(() => {
    WebGL2RenderingContext.prototype.drawArrays = __reviewDraw;
    return { draws: __reviewDraws, radius: SpaceCamera.pose().radius };
  });
  await page.waitForTimeout(1800);
  evidence.creative.settledGate = await page.evaluate(() => Stage.gateRates().find(g => g.name === 'creative').target);
  await page.evaluate(() => {
    SpaceCamera.freeLoad({ locked: true, position: { x: 0, y: 2, z: 12 }, yaw: 0, pitch: 0, fov: SpaceCamera.pose().fov });
    Stage.kick();
  });
  await page.waitForTimeout(1000);
  const beforeMove = await page.evaluate(() => SpaceCamera.pose().position);
  await page.evaluate(() => {
    __reviewDraws = 0;
    WebGL2RenderingContext.prototype.drawArrays = function () {
      if (this.canvas.closest('#sp-host-creative')) __reviewDraws++;
      return __reviewDraw.apply(this, arguments);
    };
    SpaceCamera.freeToggle();
    document.getElementById('space3d').dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
  });
  await page.waitForTimeout(250);
  evidence.creative.translation = await page.evaluate(() => {
    document.getElementById('space3d').dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));
    SpaceCamera.freeToggle();
    WebGL2RenderingContext.prototype.drawArrays = __reviewDraw;
    return { draws: __reviewDraws, position: SpaceCamera.pose().position };
  });

  evidence.rejections = await page.evaluate(async () => {
    const root = document.getElementById('space3d'), lock = root.requestPointerLock,
      full = root.requestFullscreen, exit = document.exitFullscreen;
    const errors = [], listener = e => { errors.push(String(e.reason)); e.preventDefault(); };
    window.addEventListener('unhandledrejection', listener);
    root.requestPointerLock = () => Promise.reject(new DOMException('Lock denied', 'NotAllowedError'));
    root.requestFullscreen = () => Promise.reject(new DOMException('Fullscreen denied', 'NotAllowedError'));
    root.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', bubbles: true }));
    root.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', bubbles: true }));
    await new Promise(r => setTimeout(r, 80));
    const active = SpaceCamera.isFreeActive();
    if (active) root.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', bubbles: true }));
    root.requestPointerLock = lock; root.requestFullscreen = full; document.exitFullscreen = exit;
    window.removeEventListener('unhandledrejection', listener);
    return { errors, active };
  });

  await page.evaluate(() => { Space3D.setSource('immersive'); Space3D.setField('silk'); });
  await page.setViewportSize({ width: 420, height: 800 });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await page.evaluate(() => {
    window.__reviewTouch = [];
    window.__reviewTouchListener = e => __reviewTouch.push(e.type);
    for (const type of ['pointermove', 'pointercancel']) document.getElementById('space3d').addEventListener(type, __reviewTouchListener);
    window.__reviewWorld = SpaceCamera.worldPose();
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 250 }] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200 + i * 5, y: 250 + i * 20 }] });
    await page.waitForTimeout(20);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  evidence.touch = await page.evaluate(() => {
    for (const type of ['pointermove', 'pointercancel']) document.getElementById('space3d').removeEventListener(type, __reviewTouchListener);
    return { events: __reviewTouch, before: __reviewWorld, after: SpaceCamera.worldPose(),
      sheetAction: getComputedStyle(document.getElementById('sp-sheet')).touchAction };
  });
  await page.screenshot({ path: path.join(output, 'space-touch-420x800.png') });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }); await cdp.detach();
  await page.setViewportSize(viewport);

  await page.evaluate(() => {
    window.__reviewPostFragment = SpacePost.fragment;
    SpacePost.fragment = '#version 300 es\n invalid shader';
    Space3D.setSource('coast'); Space3D.setSource('immersive');
  });
  await page.waitForTimeout(200);
  evidence.post = await page.evaluate(() => ({ disabled: document.getElementById('sp-post-grain').disabled,
    title: document.getElementById('sp-controls-post').title, status: document.getElementById('sp-post-status').textContent,
    scene: SpaceFields.capture(), fallbackHidden: document.getElementById('sp-fallback').hidden }));
  await page.evaluate(() => {
    SpacePost.fragment = __reviewPostFragment;
    Space3D.setSource('coast'); Space3D.setSource('immersive');
  });
  evidence.post.recovered = await page.evaluate(() => !document.getElementById('sp-post-grain').disabled);
  await page.evaluate(() => { Space3D.configure({ lyrics: true, visual: 'stage' }); });
  await page.waitForSelector('#sp-reading .sl-line.is-active');
  evidence.layouts = await page.evaluate(() => ['venue', 'diorama', 'tempo', 'still'].map(theme => {
    Space3D.configure({ layers: { stagePreset: theme } });
    const rect = document.getElementById('sp-reading').getBoundingClientRect();
    return { theme, center: rect.left + rect.width / 2, width: rect.width };
  }));
  await page.setViewportSize({ width: 640, height: 800 });
  await page.evaluate(() => { HandDrawn.apply({ on: true, annot: true, style: 'manga', paper: false }); });
  await page.waitForFunction(() => !!document.querySelector('#sp-art .hd-annot')?.getAttribute('d'));
  await page.screenshot({ path: path.join(output, 'space-hand-640x800.png') });
  evidence.hand = await page.evaluate(() => {
    const old = document.querySelector('#sp-art .hd-frame').getAttribute('d');
    HandDrawn.apply({ style: 'anime' });
    const changed = old !== document.querySelector('#sp-art .hd-frame').getAttribute('d');
    Space3D.configure({ lyrics: false });
    const cleared = document.querySelector('#sp-art .hd-annot').getAttribute('d') === '';
    HandDrawn.apply({ on: false });
    return { changed, cleared, host: HandDrawn.stats().host };
  });
  await page.setViewportSize(viewport);
  await page.evaluate(() => { Space3D.configure({ freeCam: { locked: false } }); __spacePlayback.fixture.playing = true; Stage.kick(); });
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'review-evidence.json'), JSON.stringify(evidence, null, 2));

  const failures = [];
  function check(label, run) { try { run(); pass(label); } catch (error) { failures.push(label + ': ' + error.message); } }
  check('Space3D occludes 2D visual gates while the energy clock remains available', () => {
    assert.equal(evidence.occlusion.visible, false); assert.equal(evidence.occlusion.hidden, true);
    for (const gate of evidence.occlusion.rates.filter(g => ['lyrics', 'particles'].includes(g.name))) assert.equal(gate.target, 0);
    assert.ok(evidence.occlusion.rates.find(g => g.name === 'energy').target > 0);
  });
  check('paused creative camera draws manual input and returns to sleep', () => {
    assert.ok(Math.abs(evidence.creative.radius - before) > 0.1); assert.ok(evidence.creative.draws > 0);
    assert.equal(evidence.creative.settledGate, 0);
  });
  check('paused creative free-camera translation draws its changed position', () => {
    assert.notDeepEqual(evidence.creative.translation.position, beforeMove);
    assert.ok(evidence.creative.translation.draws > 0);
  });
  check('denied pointer lock and fullscreen have handled rejections and exit free input', () => {
    assert.deepEqual(evidence.rejections.errors, []); assert.equal(evidence.rejections.active, false);
  });
  check('touch drag keeps all moves and leaves settings scrolling available', () => {
    assert.ok(!evidence.touch.events.includes('pointercancel')); assert.ok(evidence.touch.events.length >= 7);
    assert.notDeepEqual(evidence.touch.after, evidence.touch.before); assert.notEqual(evidence.touch.sheetAction, 'none');
  });
  check('optional filter failure disables its controls and reopening recovers them', () => {
    assert.equal(evidence.post.disabled, true); assert.ok(evidence.post.title); assert.equal(evidence.post.recovered, true);
    assert.ok(evidence.post.status && evidence.post.scene.lit > 0 && evidence.post.scene.err === 0 && evidence.post.fallbackHidden);
  });
  check('all four actual Space3D lyric layouts use both insets', () => {
    for (const item of evidence.layouts) assert.ok(Math.abs(item.center - viewport.width / 2) < 1);
    assert.equal(new Set(evidence.layouts.map(item => Math.round(item.width))).size, 4);
  });
  check('paused narrow Space3D hand host annotates lyrics and refreshes style and visibility', () => {
    assert.equal(evidence.hand.host, 'sp-art'); assert.ok(evidence.hand.changed && evidence.hand.cleared);
  });
  assert.deepEqual(failures, [], 'second-review integration regressions');
}

async function main() {
  const registered = registeredAssets();
  if (!sourceMode) await Promise.all(assets.map(async file => {
    const response = await fetch(new URL(file, base), { signal: AbortSignal.timeout(10000) });
    assert.ok(response.ok, 'Cannot fetch ' + file);
    assert.equal(normalize(await response.text()), normalize(fs.readFileSync(path.join(web, file), 'utf8')),
      'Stale embedded asset: ' + file + ' — rebuild the binary or use --source for iteration');
  }));
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: process.env.SPACE_HEADED !== '1' });
  const context = await browser.newContext({ viewport }), page = await context.newPage();
  const errors = [], checks = [], captures = [];
  const pass = label => { checks.push(label); console.log('PASS ' + label); };
  let memorySettings = null, savedSpace = null;
  page.on('pageerror', error => errors.push(error.message));
  await context.addInitScript(installProbe);
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== new URL(base).origin) return route.continue();
    if (url.pathname === '/v1/settings') {
      if (request.method() === 'GET') {
        if (!memorySettings) {
          const response = await route.fetch(); memorySettings = await response.json();
          delete memorySettings.space3d; // fresh Space3D preferences in this isolated fixture
        }
        return route.fulfill({ status: 200, json: memorySettings });
      }
      const patch = request.postDataJSON() || {};
      memorySettings = Object.assign({}, memorySettings, patch);
      if (patch.space3d) savedSpace = patch.space3d;
      return route.fulfill({ status: 200, json: {} });
    }
    if (url.pathname.startsWith('/v1/') && !['GET', 'HEAD'].includes(request.method()) && url.pathname !== '/v1/auth/ticket') {
      return route.fulfill({ status: 200, json: {} });
    }
    if (sourceMode && registered.has(url.pathname)) {
      const asset = registered.get(url.pathname);
      return route.fulfill({ status: 200, contentType: asset.contentType, body: fs.readFileSync(asset.file), headers: { 'cache-control': 'no-store' } });
    }
    if (sourceMode && request.isNavigationRequest() && url.pathname === '/') {
      const response = await route.fetch();
      assert.ok(response.ok(), 'source HTML still requires valid server authentication');
      const body = fs.readFileSync(path.join(web, 'index.html'), 'utf8').replace('__VMUSIC_TOKEN_VALUE__', uiToken());
      return route.fulfill({ response, body, headers: Object.assign({}, response.headers(), { 'cache-control': 'no-store' }) });
    }
    return route.continue();
  });
  async function ready() {
    await page.waitForFunction(() => window.Space3D && window.SpaceFields && window.SpacePost && window.SpaceLayers && window.Stage, null, { timeout: 30000 });
    await page.waitForTimeout(250); // startup settings response must reach configure()
  }
  async function wake() { await page.mouse.move(850, 750); }
  async function openSheet() {
    await wake();
    if (!await page.locator('#sp-sheet').evaluate(el => el.classList.contains('sp-show'))) await page.click('#sp-fab');
    await page.waitForFunction(() => document.getElementById('sp-sheet').classList.contains('sp-show'));
  }
  async function closeSheet() {
    if (await page.locator('#sp-sheet').evaluate(el => el.classList.contains('sp-show'))) await page.click('#sp-sheet-close');
    await page.locator('#sp-sheet').waitFor({ state: 'hidden' });
  }
  async function setRange(selector, value) {
    await page.locator(selector).evaluate((el, next) => {
      el.value = String(next); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  }
  async function drawField(id, settle = 480) {
    const before = await page.evaluate(() => SpaceFields.stats().frames);
    await page.evaluate(value => { __spaceProbe.sceneModes.length = 0; Space3D.setField(value); }, id);
    await page.waitForFunction(({ id, before }) => SpaceFields.stats().stage === id && SpaceFields.stats().frames > before + 1,
      { id, before }, { timeout: 10000 });
    await page.waitForTimeout(settle);
    const image = await page.evaluate(() => SpaceFields.capture());
    assert.ok(image, id + ' has a real rendered frame'); assert.equal(image.err, 0, id + ' has no GL error');
    captures.push({ id, tier: await page.evaluate(() => Stage.tier()), ...image }); return image;
  }
  async function signature() {
    return page.evaluate(async () => {
      await SpaceFields.capture();
      const image = document.querySelector('canvas.sp-fields-canvas');
      const small = document.createElement('canvas'); small.width = 48; small.height = 32;
      const ctx = small.getContext('2d'); ctx.drawImage(image, 0, 0, 48, 32);
      return Array.from(ctx.getImageData(0, 0, 48, 32).data);
    });
  }
  const difference = (a, b) => a.reduce((sum, value, i) => sum + (i % 4 === 3 ? 0 : Math.abs(value - b[i])), 0) / (a.length / 4 * 3);
  try {
    await page.goto(uiUrl(base), { waitUntil: 'domcontentloaded' }); await ready();
    for (const file of assets) {
      const served = await page.evaluate(async file => { const response = await fetch(file); return { ok: response.ok, text: await response.text() }; }, file);
      assert.ok(served.ok, 'browser can load ' + file);
      assert.equal(normalize(served.text), normalize(fs.readFileSync(path.join(web, file), 'utf8')), 'browser source freshness: ' + file);
    }
    pass(sourceMode ? 'registered local source routing and browser freshness' : 'embedded assets and browser freshness');
    await page.keyboard.press('x'); await page.waitForFunction(() => Space3D.isActive());
    assert.equal(await page.evaluate(() => Space3D.sourceId()), 'coast', 'first entry uses the coast default');
    await page.waitForSelector('#sp-host-coast canvas.coast-canvas', { state: 'visible', timeout: 20000 });
    assert.equal(await page.evaluate(() => Stage3D.isActive()), false);
    assert.ok(await page.evaluate(() => Array.from(document.body.children).every(node =>
      node.id === 'space3d' || /^(SCRIPT|STYLE|SVG)$/.test(node.tagName) || node.inert)), 'other layers are inert');
    await page.screenshot({ path: path.join(output, 'coast-1707x898.png') });
    pass('X entry: coast canvas, mode exclusion and inert ownership');
    await wake(); const radius = await page.evaluate(() => Space3D.stats().camera.radius);
    await page.mouse.wheel(0, -600);
    await page.waitForFunction(before => Math.abs(Space3D.stats().camera.radius - before) > 0.05, radius);
    await page.click('#sp-return-2d'); await page.waitForFunction(() => !Space3D.isActive());
    await page.click('#space3d-entry'); await page.waitForFunction(() => Space3D.isActive());
    await page.click('#sp-return-2d'); await page.click('[data-view="settings"]');
    await page.locator('.skset-nav button').filter({ hasText: '窗口与舞台' }).click();
    await page.locator('#set-space3d-btn').scrollIntoViewIfNeeded(); await page.click('#set-space3d-btn');
    await page.waitForFunction(() => Space3D.isActive());
    await page.waitForFunction(() => {
      const modal = document.querySelector('.skset-modal');
      if (!modal) return true;
      const style = getComputedStyle(modal);
      return style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0;
    }, null, { timeout: 2000 });
    pass('top bar and settings entries open the same mode; wheel changes its camera');

    await installPlayback(page);
    await reviewChecks(page, context, pass);
    if (process.argv.includes('--review-only')) {
      assert.deepEqual(errors, [], 'no page errors');
      console.log('Space3D second review: ' + checks.length + ' checks passed');
      return;
    }
    await page.evaluate(() => Space3D.configure({ cinema: false, sceneSource: 'immersive', space3dDefaultMigrated: 1,
      lyrics: true, visual: 'stage', post: SpacePost.defaults(), layers: SpaceLayers.defaults() }));
    await page.waitForSelector('canvas.sp-fields-canvas', { state: 'visible' });
    await wake(); await page.click('#sp-fx-toggle'); const grid = await page.locator('#sp-fx-grid').innerText();
    for (const label of ['海岸公路', '星座', '创意编排', '频谱塔林', '星云', '三维歌词']) assert.ok(grid.includes(label), 'effect entry: ' + label);
    assert.ok(!grid.includes('待 3D 化'), 'no completed effect remains a placeholder'); await page.click('#sp-fx-toggle');
    const native = await page.evaluate(() => Stage3D.effectCatalog().map(item => ({ id: item.id, blank: !!item.blank, counts: item.counts })));
    assert.equal(native.length, 8, 'native field catalog remains complete');
    for (const tier of [0, 1, 2]) {
      await page.evaluate(tier => { Space3D.close(); __spacePlayback.fixture.tier = tier; Space3D.open('immersive'); }, tier);
      for (const item of native) {
        const image = await drawField(item.id);
        if (item.id === 'off' || item.blank) assert.equal(image.lit, 0, 'off leaves only the background');
        else {
          assert.ok(image.lit > 0, item.id + ' has visible geometry at tier ' + tier + ': ' + JSON.stringify(image));
          assert.ok(image.count <= item.counts[tier] && image.count >= item.counts[tier] * 0.85,
            item.id + ' actually uses tier ' + tier + ' geometry density');
        }
      }
      for (const id of ['scene:towers', 'scene:nebula', 'scene:lyric']) {
        const image = await drawField(id); assert.ok(image.lit > 0, id + ' draws geometry at tier ' + tier + ': ' + JSON.stringify(image));
        assert.ok(await page.evaluate(({ id, tier }) => {
          const geometry = CreativeGL.sceneRig(id.slice(6)).geometry(tier);
          const gl = document.querySelector('canvas.sp-fields-canvas').getContext('webgl2');
          return __spaceProbe.sceneModes.some(draw => draw.mode === gl[geometry.mode] && draw.count === geometry.verts &&
            (draw.instances || 1) === geometry.instances);
        }, { id, tier }), id + ' actually draws the expected primitive and quality density');
      }
      pass('tier ' + tier + ': all eight native choices and three scene renderers draw without GL errors');
    }
    assert.deepEqual(await page.evaluate(() => __spaceProbe.badModes), [], 'every scene draw has an explicit primitive mode');
    await drawField('scene:towers'); const towerPose = await page.evaluate(() => Space3D.stats().camera);
    assert.ok(Math.abs(towerPose.radius - 23) < 0.2 && Math.abs(towerPose.fov - 54) < 0.2, 'tower camera retains 23-unit distance and 54-degree FOV');
    pass('tower geometry keeps its primitive mode and camera baseline');

    await wake(); await page.mouse.wheel(0, -600);
    await page.waitForFunction(() => Space3D.stats().camera.radius < 21);
    const zoomed = await page.evaluate(() => SpaceCamera.internals().orbit.user);
    await page.evaluate(() => Space3D.configure({ post: { grain: 3 } }));
    assert.deepEqual(await page.evaluate(() => SpaceCamera.internals().orbit.user), zoomed, 'unrelated configure retains the user camera target');
    await page.waitForTimeout(200);
    assert.ok(await page.evaluate(() => Space3D.stats().camera.radius < 21), 'unrelated configure retains visible zoom');
    await page.evaluate(() => Space3D.configure({ post: SpacePost.defaults(), field: 'silk' }));
    await drawField('scene:towers');
    pass('unrelated live settings changes preserve the camera zoom');

    await openSheet(); await page.click('#sp-focus');
    await page.waitForFunction(radius => Space3D.stats().camera.radius < radius * 0.95, towerPose.radius);
    await page.evaluate(() => SpaceCamera.clearFocus());
    await page.selectOption('#sp-visual', 'classic');
    await page.waitForFunction(() => !document.getElementById('sp-stanza').hidden); await drawField('scene:lyric');
    assert.ok(await page.evaluate(() => document.getElementById('sp-reading').hidden && document.getElementById('sp-stanza').hidden),
      'a scene that draws lyrics hides both DOM lyric hosts');
    const withLyrics = await page.evaluate(() => SpaceFields.capture());
    await page.uncheck('#sp-lyrics-toggle'); await page.waitForTimeout(180);
    const withoutLyrics = await page.evaluate(() => SpaceFields.capture());
    assert.ok(withoutLyrics.lit < withLyrics.lit * 0.1, 'global lyrics off removes the scene glyphs');
    await page.check('#sp-lyrics-toggle'); await drawField('silk');
    await page.waitForFunction(() => !document.getElementById('sp-stanza').hidden); await page.selectOption('#sp-visual', 'stage');
    await page.waitForFunction(() => !document.getElementById('sp-reading').hidden && document.getElementById('sp-stanza').hidden);
    await page.waitForSelector('#sp-reading .sl-word');
    pass('global lyrics applies to scene glyphs and restores the chosen DOM visual');

    await page.locator('#sp-controls-post').evaluate(el => { el.open = true; });
    await page.locator('#sp-controls-layer').evaluate(el => { el.open = true; });
    await setRange('#sp-post-grain', 16); await setRange('#sp-post-vignette', 25);
    await page.check('#sp-layer-discRing'); await page.check('#sp-layer-karaoke');
    await setRange('#sp-layer-dust', 35); await page.selectOption('#sp-layer-stagePreset', 'tempo');
    await page.waitForFunction(() => Space3D.stats().layers && Space3D.stats().layers.discBars === 64 && Space3D.stats().layers.dust > 0);
    const wordBefore = await page.locator('#sp-reading .sl-line.is-active .sl-word').evaluateAll(nodes => nodes.map(node => node.style.getPropertyValue('--sl-fill')));
    await page.evaluate(() => { __spacePlayback.fixture.position = 4200; Stage.kick(); });
    await page.waitForTimeout(160);
    const wordAfter = await page.locator('#sp-reading .sl-line.is-active .sl-word').evaluateAll(nodes => nodes.map(node => node.style.getPropertyValue('--sl-fill')));
    assert.notDeepEqual(wordAfter, wordBefore, 'karaoke follows the shared lyric timing');
    assert.ok(await page.locator('#sp-reading .sl-line.is-active .sl-word').first().evaluate(node => getComputedStyle(node).maskImage !== 'none'),
      'karaoke applies its wipe mask to the timed words');
    await page.locator('#sp-controls-background').evaluate(el => { el.open = true; });
    await page.selectOption('#sp-background-type', 'mesh'); await page.selectOption('#sp-background-blend', 'screen');
    await page.check('#sp-layer-bgwall');
    await page.waitForFunction(() => Backgrounds.values().type === 'mesh' && Backgrounds.values().blend === 'screen' && Space3D.stats().layers.wallReady);
    assert.ok(await page.evaluate(() => document.getElementById('sp-bg').contains(document.getElementById('creative-bg'))),
      'the existing background owner renders below Space3D');
    assert.equal(await page.locator('#sp-bg canvas.sp-wall-panel').count(), 16, 'curved wall has a bounded panel count');
    pass('focus, timed karaoke, shared background controls and the curved wall work in the live mode');
    await drawField('scene:towers'); await page.waitForTimeout(350);
    assert.ok(savedSpace && savedSpace.post.grain === 16 && savedSpace.layers.discRing && savedSpace.field === 'scene:towers',
      'real controls save fields, post and layers through the app settings endpoint');
    const persisted = JSON.parse(JSON.stringify(savedSpace));
    await page.screenshot({ path: path.join(output, 'space-controls-1707x898.png') });
    await closeSheet();
    await page.screenshot({ path: path.join(output, 'space-effects-1707x898.png') });
    await restorePlayback(page); await page.reload({ waitUntil: 'domcontentloaded' }); await ready();
    assert.equal(await page.evaluate(() => Space3D.preferences().field), persisted.field, 'field survives reload');
    assert.deepEqual(await page.evaluate(() => Space3D.preferences().post), persisted.post, 'post survives reload');
    assert.deepEqual(await page.evaluate(() => Space3D.preferences().layers), persisted.layers, 'layers survive reload');
    await installPlayback(page); await page.click('#space3d-entry'); await page.waitForSelector('canvas.sp-fields-canvas', { state: 'visible' });
    await page.evaluate(() => Space3D.configure({ post: SpacePost.defaults(), layers: SpaceLayers.defaults(), cinema: false, field: 'silk' }));
    await drawField('silk'); const stablePrefs = await page.evaluate(() => Space3D.preferences());
    await page.evaluate(() => Space3D.configure({ sceneSource: 'invalid-source', field: 'invalid-field', post: { grain: Infinity }, layers: { dust: -100, stagePreset: 'invalid-theme' } }));
    assert.equal(await page.evaluate(() => Space3D.sourceId()), 'immersive', 'invalid source cannot replace the live source');
    assert.equal(await page.evaluate(() => Space3D.preferences().post.grain), 0, 'invalid post value sanitizes');
    await page.evaluate(value => Space3D.configure(value), stablePrefs);
    pass('settings roundtrip survives reload and malformed live configure remains usable');

    await page.waitForFunction(() => Number(document.getElementById('sp-seek').max) === 120000);
    await page.evaluate(() => {
      window.__spaceSeekEvents = [];
      window.__spaceSeekListener = e => { if (e.detail.action === 'seek') __spaceSeekEvents.push(e.detail.value); };
      document.addEventListener('stage:control', __spaceSeekListener);
    });
    await setRange('#sp-seek', 45000);
    assert.deepEqual(await page.evaluate(() => __spaceSeekEvents), [45000], 'progress control requests the selected millisecond position');
    assert.equal(await page.locator('#sp-track-title').innerText(), '空间回归');
    assert.equal(await page.locator('#sp-seek-particles i').count(), 8, 'seek particles have a fixed eight-node budget');
    await page.evaluate(() => {
      document.removeEventListener('stage:control', __spaceSeekListener);
      delete window.__spaceSeekListener; delete window.__spaceSeekEvents;
      Space3D.setSource('coast');
      SpaceCamera.freeLoad({ locked: false, position: { x: 0, y: 0, z: 8.4 }, fov: 45 });
    });
    await page.waitForTimeout(350); savedSpace = null;
    await page.locator('#space3d').focus(); await page.keyboard.press('r');
    await page.waitForFunction(() => SpaceCamera.isFreeActive());
    const poseBeforeMove = await page.evaluate(() => SpaceCamera.freeSnapshot());
    await page.keyboard.down('w'); await page.waitForTimeout(180); await page.keyboard.up('w');
    await page.keyboard.press('r');
    await page.waitForFunction(() => !SpaceCamera.isFreeActive() && !document.pointerLockElement);
    const savedPose = await page.evaluate(() => SpaceCamera.freeSnapshot());
    assert.notDeepEqual(savedPose.position, poseBeforeMove.position, 'the real movement shortcut changes the free pose');
    assert.equal(savedPose.locked, true);
    await page.evaluate(() => document.getElementById('space3d').classList.add('sp-idle'));
    await page.locator('#sp-seek').focus();
    assert.ok(await page.evaluate(() => !document.getElementById('space3d').classList.contains('sp-idle')), 'keyboard focus wakes controls');
    await page.waitForTimeout(2750);
    assert.ok(await page.evaluate(() => !document.getElementById('space3d').classList.contains('sp-idle')), 'focused controls stay visible after the idle interval');
    const coastRates = await page.evaluate(() => Stage.gateRates().filter(item => item.name.startsWith('space3d')));
    assert.equal(coastRates.find(item => item.name === 'space3d').target, 0, 'locked inactive free pose lets the self-spinning camera gate sleep');
    assert.equal(coastRates.find(item => item.name === 'space3d-signal').target, 30, 'self-spinning playback keeps beat detection alive');
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !Space3D.isActive());
    await page.waitForTimeout(100);
    assert.ok(savedSpace, 'free-camera-only interaction saves through the settings endpoint');
    assert.deepEqual(savedSpace.freeCam, savedPose, 'closing from a focused input flushes the current free pose');
    await restorePlayback(page); await page.reload({ waitUntil: 'domcontentloaded' }); await ready();
    assert.deepEqual(await page.evaluate(() => Space3D.preferences().freeCam), savedPose, 'the locked free pose survives a real reload');
    await installPlayback(page); await page.click('#space3d-entry');
    await page.waitForFunction(() => Space3D.isActive() && Space3D.sourceId() === 'coast');
    assert.deepEqual(await page.evaluate(() => SpaceCamera.freeSnapshot()), savedPose, 're-entry restores the saved free pose without activation');
    pass('seek, focused controls, free-pose persistence and idle self-spinning budgets');

    const closedPose = await page.evaluate(() => {
      Space3D.close();
      const replacement = SpaceCamera.freeSnapshot();
      replacement.position.x += 1; replacement.yaw += 0.1;
      Space3D.configure({ freeCam: replacement });
      const configured = SpaceCamera.freeSnapshot();
      Space3D.open('coast');
      return { configured, reopened: SpaceCamera.freeSnapshot() };
    });
    assert.deepEqual(closedPose.reopened, closedPose.configured, 'closed configure replaces the pose restored by the next entry');
    assert.equal(closedPose.reopened.active, false, 'configured free pose remains fixed on re-entry');
    pass('closed configuration restores its new free pose on the next entry');

    async function contextStatus(source, state) {
      await page.evaluate(detail => document.dispatchEvent(new CustomEvent('stage:scene-context', { detail })), { source, state });
    }
    await contextStatus('zodiac', 'lost');
    assert.ok(await page.locator('#sp-fallback').evaluate(el => el.hidden), 'inactive-source context loss does not affect the active scene');
    await contextStatus('coast', 'lost');
    assert.ok(await page.locator('#sp-fallback').isVisible(), 'active-source loss shows its recovery message');
    await contextStatus('zodiac', 'recovered');
    assert.ok(await page.locator('#sp-fallback').isVisible(), 'inactive-source recovery cannot clear the active failure');
    await contextStatus('coast', 'failed');
    assert.ok(await page.locator('#sp-fx-grid button').filter({ hasText: '海岸公路' }).isDisabled(), 'active-source failure disables its unavailable entry');
    await contextStatus('coast', 'recovered');
    assert.ok(await page.locator('#sp-fallback').evaluate(el => el.hidden), 'active-source recovery clears its failure message');
    assert.ok(await page.locator('#sp-fx-grid button').filter({ hasText: '海岸公路' }).isEnabled(), 'recovery makes its entry available again');
    await page.evaluate(() => Space3D.configure({ sceneSource: 'immersive', space3dDefaultMigrated: 1, field: 'silk',
      freeCam: { locked: false, position: { x: 0, y: 0, z: 8.4 }, fov: 45 } }));
    await drawField('silk');
    pass('scene context status is scoped to the active source and recovery restores availability');

    await page.evaluate(() => {
      __spacePlayback.fixture.reduced = true;
      SpaceCamera.freeLoad({ locked: true, position: { x: 0, y: 0, z: 8.4 }, yaw: 0, pitch: 0, roll: 0, fov: 45 }); Stage.kick();
    });
    await page.waitForTimeout(400); const forward = await signature();
    await page.evaluate(() => { const pose = SpaceCamera.freeSnapshot(); pose.yaw = 0.45; SpaceCamera.freeLoad(pose); Stage.kick(); });
    await page.waitForTimeout(180); const turned = await signature(); const freeDifference = difference(forward, turned);
    assert.ok(freeDifference > 1, 'free yaw changes pixels at fixed position and scene time: ' + freeDifference);
    await page.evaluate(() => { SpaceCamera.freeLoad({ locked: false, position: { x: 0, y: 0, z: 8.4 }, fov: 45 }); Stage.kick(); });
    const frozen = await page.evaluate(() => Space3D.stats().timeSec); await page.waitForTimeout(280);
    assert.equal(await page.evaluate(() => Space3D.stats().timeSec), frozen, 'application reduced motion freezes scene time');
    const rates = await page.evaluate(() => Stage.gateRates().filter(item => item.name.startsWith('space3d')));
    assert.ok(rates.every(item => item.target <= 30) && rates.find(item => item.name === 'space3d').target <= 15, 'reduced frame budgets stay bounded');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const hiddenFrames = await page.evaluate(() => SpaceFields.stats().frames); await page.waitForTimeout(220);
    assert.equal(await page.evaluate(() => SpaceFields.stats().frames), hiddenFrames, 'hidden page performs no scene draws');
    assert.ok(await page.evaluate(() => Stage.gateRates().filter(item => item.name.startsWith('space3d')).every(item => item.target === 0)), 'all hidden gates request zero frames');
    await page.evaluate(() => { delete document.hidden; delete document.visibilityState; __spacePlayback.fixture.reduced = false;
      document.dispatchEvent(new Event('visibilitychange')); Stage.kick(); });
    pass('free look changes pixels; reduced motion freezes time; hidden gates stop drawing');

    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 640, deviceScaleFactor: 2, mobile: false });
    await page.waitForTimeout(250); await drawField('scene:towers');
    const resized = await page.evaluate(() => {
      const canvas = document.querySelector('canvas.sp-fields-canvas');
      return { w: canvas.width, h: canvas.height, cssW: canvas.clientWidth, cssH: canvas.clientHeight, dpr: devicePixelRatio };
    });
    assert.equal(resized.dpr, 2);
    assert.ok(resized.w > resized.cssW && resized.w <= resized.cssW * 2 && resized.h > 0, 'DPR applies within the rendering budget');
    await cdp.send('Emulation.clearDeviceMetricsOverride'); await page.setViewportSize(viewport); await page.waitForTimeout(200);
    pass('resize and DPR update the drawing buffer without losing the scene');

    for (const id of ['silk', 'scene:lyric']) {
      await drawField(id);
      const frameBeforeLoss = await page.evaluate(() => SpaceFields.stats().frames);
      await page.evaluate(() => {
        const gl = document.querySelector('canvas.sp-fields-canvas').getContext('webgl2');
        window.__spaceLostGL = gl;
        window.__spaceRestoreExtension = gl.getExtension('WEBGL_lose_context');
        if (!__spaceRestoreExtension) throw new Error('WEBGL_lose_context is required by this regression');
        __spaceRestoreExtension.loseContext();
      });
      await page.waitForFunction(() => __spaceLostGL.isContextLost() && !document.getElementById('sp-fallback').hidden);
      const capturedWhileLost = await page.evaluate(() => SpaceFields.capture());
      await page.evaluate(() => __spaceRestoreExtension.restoreContext());
      await page.waitForFunction(({ id, frameBeforeLoss }) => {
        const canvas = document.querySelector('canvas.sp-fields-canvas');
        return canvas && !canvas.getContext('webgl2').isContextLost() && SpaceFields.stats().stage === id &&
          SpaceFields.stats().frames > frameBeforeLoss + 1 && document.getElementById('sp-fallback').hidden;
      }, { id, frameBeforeLoss }, { timeout: 15000 });
      const restored = await page.evaluate(() => SpaceFields.capture());
      assert.ok(restored && restored.stage === id && restored.lit > 0 && restored.err === 0,
        id + ' rebuilds its programs, targets and textures after real context restoration: ' + JSON.stringify(restored));
      captures.push({ id, restored: true, ...restored });
      await page.evaluate(() => { delete window.__spaceLostGL; delete window.__spaceRestoreExtension; });
      assert.equal(capturedWhileLost, null, id + ' has no capturable frame while context is lost');
    }
    pass('real WebGL context loss/restoration rebuilds native and lyric scenes without reselection');

    await drawField('scene:towers');
    await page.evaluate(() => {
      const gl = document.querySelector('canvas.sp-fields-canvas').getContext('webgl2');
      const original = gl.drawArraysInstanced;
      window.__spaceDrawFailures = 0;
      gl.drawArraysInstanced = function () {
        gl.drawArraysInstanced = original;
        __spaceDrawFailures += 1;
        throw new Error('intentional Space3D scene draw failure');
      };
      Stage.kick();
    });
    await page.waitForFunction(() => __spaceDrawFailures === 1 && !document.getElementById('sp-fallback').hidden);
    const failedFrames = await page.evaluate(() => SpaceFields.stats().frames);
    await page.waitForTimeout(180);
    assert.equal(await page.evaluate(() => SpaceFields.stats().frames), failedFrames, 'failed geometry stops completed-frame accounting');
    assert.equal(await page.evaluate(() => SpaceFields.capture()), null, 'a failed scene cannot report a captured frame');
    await page.evaluate(() => { delete window.__spaceDrawFailures; });
    await drawField('silk');
    assert.ok(await page.locator('#sp-fallback').evaluate(el => el.hidden), 'choosing a healthy scene clears the draw failure');
    pass('scene draw failure is visible, stops frames and rejects capture until a healthy scene is selected');

    const navigationPose = await page.evaluate(() => {
      const root = document.getElementById('space3d');
      // Browsers can decline pointer lock. Reload still has to save the latest
      // pose without relying on pointerlockchange or the debounce expiring.
      root.requestPointerLock = undefined; root.focus();
      root.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', key: 'r', bubbles: true }));
      root.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR', key: 'r', bubbles: true }));
      root.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true, cancelable: true }));
      return JSON.parse(JSON.stringify(SpaceCamera.freeSnapshot()));
    });
    assert.equal(navigationPose.active, true, 'free camera works when pointer lock is unavailable');
    assert.notEqual(savedSpace.freeCam.fov, navigationPose.fov, 'navigation starts while the latest pose save is still pending');
    await page.reload({ waitUntil: 'domcontentloaded' }); await ready();
    navigationPose.active = false;
    assert.deepEqual(await page.evaluate(() => Space3D.preferences().freeCam), navigationPose, 'direct reload persists the latest pose without closing');
    await installPlayback(page); await page.click('#space3d-entry');
    await page.evaluate(() => Space3D.configure({ freeCam: { locked: false, position: { x: 0, y: 0, z: 8.4 }, fov: 45 } }));
    await drawField('silk');
    assert.ok(await page.evaluate(() => __spaceProbe.settingsKeepalive.length > 0 && __spaceProbe.settingsKeepalive.at(-1)),
      'Space3D saves use keepalive on the existing settings writer');
    pass('direct reload flushes pending free-pose changes without pointer lock or mode close');

    await page.evaluate(() => { Space3D.close(); window.__spaceBlockGL = true; Space3D.open('immersive'); });
    await page.waitForSelector('#sp-fallback:not([hidden])'); assert.ok(await page.locator('#sp-fallback').innerText(), 'context failure is visible');
    await wake(); await page.click('#sp-return-2d'); assert.equal(await page.evaluate(() => Space3D.isActive()), false, 'failure retains a working exit');
    await page.evaluate(() => { window.__spaceBlockGL = false; Space3D.open('immersive'); }); await drawField('silk');
    assert.ok(await page.locator('#sp-fallback').evaluate(el => el.hidden), 'reopening recovers after a context allocation failure');
    await page.evaluate(() => { window.__spaceZodiacAvailable = StageZodiac.available; StageZodiac.available = () => false; Space3D.configure({ cinema: false }); });
    assert.ok(await page.locator('#sp-fx-grid button').filter({ hasText: '星座' }).isDisabled(), 'unavailable adapter retains a disabled entry');
    await page.evaluate(() => { StageZodiac.available = __spaceZodiacAvailable; delete window.__spaceZodiacAvailable; Space3D.configure({ cinema: false }); });
    pass('failed and unavailable sources remain visible, recoverable and escapable');

    await page.evaluate(() => Space3D.configure({ lyrics: false, visual: 'stage', post: { grain: 5 }, layers: { dust: 20, discRing: true } }));
    await drawField('scene:towers'); const live = await page.evaluate(() => __spaceProbe.resources());
    assert.equal(live.contexts, 1, 'one live SpaceFields context'); const samples = [];
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => Space3D.close()); const closed = await page.evaluate(() => __spaceProbe.resources());
      assert.equal(closed.contexts, 0, 'close ' + i + ' releases its context');
      assert.equal(closed.textures, 0, 'close ' + i + ' deletes its textures'); assert.equal(closed.canvases, 0, 'close ' + i + ' removes its canvas');
      await page.evaluate(() => Space3D.open('immersive')); await page.waitForFunction(() => !!document.querySelector('canvas.sp-fields-canvas'));
      await page.waitForTimeout(60); samples.push(await page.evaluate(() => __spaceProbe.resources()));
    }
    const end = samples[samples.length - 1]; assert.equal(end.contexts, 1);
    assert.ok(end.textures <= live.textures, 'no accumulated textures'); assert.ok(end.listeners <= live.listeners, 'no accumulated global listeners');
    assert.ok(end.nodes <= live.nodes, 'no accumulated DOM nodes');
    pass('ten close/open cycles release contexts/textures and keep listeners/DOM bounded');

    await restorePlayback(page); await page.evaluate(() => { Space3D.close(); Stage3D.open(); }); await page.waitForFunction(() => Stage3D.isActive());
    await page.keyboard.press('x'); await page.waitForFunction(() => Space3D.isActive() && !Stage3D.isActive());
    await page.keyboard.press('v'); await page.waitForFunction(() => Stage3D.isActive() && !Space3D.isActive()); await page.evaluate(() => Stage3D.close());
    assert.ok(await page.evaluate(() => Array.from(document.body.children).every(node => !node.inert || node.id === 'stage-ctl')), 'closing restores the 2D page');
    pass('X/V handoff is exclusive in both directions and restores 2D interaction');
    assert.deepEqual(errors, [], 'no page errors');
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ passed: true, sourceMode, checks, captures, freeDifference,
      resize: resized, resources: { before: live, after: end, samples } }, null, 2));
    console.log('\nSpace3D: ' + checks.length + ' journeys passed (' + (sourceMode ? 'local source' : 'embedded assets') + ')');
  } catch (error) {
    try { await page.screenshot({ path: path.join(output, 'fail.png') }); } catch (_) { /* preserve original error */ }
    try {
      fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ passed: false, sourceMode, checks, captures,
        failure: String(error && error.message || error), pageErrors: errors }, null, 2));
    } catch (_) { /* artifact failure must not replace the original browser failure */ }
    if (errors.length) console.error('Page errors: ' + JSON.stringify(errors)); throw error;
  } finally {
    try { await restorePlayback(page); } catch (_) { /* page may already be unavailable */ }
    await browser.close();
  }
}
main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
