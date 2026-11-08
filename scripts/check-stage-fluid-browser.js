#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors.
// Real production Stage/StageControl/solver, controlled media input and real GPU.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), http = require('node:http'), path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), web = path.join(root, 'plugin/ui');
const output = process.env.HERTZ_FLUID_EVIDENCE_DIR ? path.resolve(process.env.HERTZ_FLUID_EVIDENCE_DIR)
  : path.join(root, 'output/playwright/stage-fluid');
const index = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
const panel = index.slice(index.indexOf('<div class="stage-ctl"'), index.indexOf('<div id="ctx-menu"'));
const stage = index.slice(index.indexOf('<aside class="stage"'), index.indexOf('</aside>', index.indexOf('<aside class="stage"')) + 8);
const scripts = ['design/design-themes.js', 'themes.js', 'stage.js', 'onset.js', 'stage-particles.js', 'stage-particles-gl.js',
  'stage-control.js', 'vendor/stage-fluid.js', 'stage-fluid.js'];
const cover = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#263c39"/><circle cx="200" cy="200" r="120" fill="#d6b987"/><circle cx="200" cy="200" r="68" fill="#36534c"/><circle cx="200" cy="200" r="12" fill="#ddccaa"/></svg>');

function bootstrap(initialized = false) {
  window.fixture = { phase: 0, energy: .4, fresh: true };
  if (!initialized) { Theme.init(); Stage.init(); StageParticles.init(); StageControl.init(); }
  document.body.classList.add('stage-open');
  document.getElementById('now-title').textContent = '晚风经过旧唱片店';
  document.getElementById('now-artist').textContent = '林间来信 · 现场录音';
  Stage.setTrack({ id: 'fluid-track', title: '晚风经过旧唱片店', duration_ms: 180000 }, window.fixtureCover);
  Stage.setCoverFollow(true);
  Stage.setSnapshot({ track_id: 'fluid-track', playing: true, duration_ms: 180000, position_ms: 1000 });
  Stage.setLyrics({ lines: [
    { start_ms: 0, text: '晚风穿过街角的灯' }, { start_ms: 24000, text: 'We keep the quiet moments close' },
    { start_ms: 48000, text: '让时间在唱片里停留' }
  ] });
  const sample = () => {
    if (!fixture.fresh) return;
    fixture.phase += .11;
    const bands = new Float32Array(64);
    for (let i = 0; i < bands.length; i++) bands[i] = fixture.energy * (.55 + .4 * Math.sin(fixture.phase + i * .2));
    Stage.setSpectrum(bands);
  };
  window.fixtureTimer = setInterval(sample, 33); sample();
  window.fixtureReady = true;
}
function fixtureHtml(dbx = false) {
  const prelude = dbx ? `<script>
window.fixtureStorageFails = false;
function storageCall(operation,value){return new Promise(resolve=>{
const channel=new MessageChannel();channel.port1.onmessage=event=>resolve(event.data);
parent.postMessage({fixtureStorage:operation,value},'*',[channel.port2]);});}
window.dbxPlugin = {storage:{get:()=>storageCall('get'),set:async(k,v)=>{
if(window.fixtureStorageFails)throw Error('controlled storage failure');await storageCall('set',v);}}};
</script><script src="/host.js"></script>` : '';
  const boot = dbx ? 'hertzHost.hydrate().then(function(){(' + bootstrap + ')();});' : '(' + bootstrap + ')();';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/stage.css">${prelude}
<style>body{margin:0;padding:28px;display:block;min-height:100vh;background:var(--bg)}
#stage{position:relative;transform:none;width:min(420px,100%);height:790px;display:block;margin:0 auto;padding:18px 20px;box-sizing:border-box}
#stage .disc-wrap{margin:20px auto 12px;width:230px;height:230px;flex:none}
#stage .disc{width:100%;height:100%}#stage .stage-lyrics{height:210px;overflow:hidden}
#stage-control-btn{position:fixed;left:14px;top:10px;z-index:10}#stage-ctl{z-index:20}
@media(max-width:500px){body{padding:14px 10px}#stage{height:770px}#stage .disc-wrap{width:200px;height:200px}}
</style></head><body><button type="button" id="stage-control-btn">舞台控制</button>${stage}${panel}
<script>window.fixtureCover=${JSON.stringify(cover)}</script>${scripts.map(file => '<script src="/' + file + '"></script>').join('')}
<script>${boot}</script></body></html>`;
}
let checks = 0;
function pass(label) { checks++; console.log('PASS ' + label); }
async function stats(page) { return page.evaluate(() => StageFluid.stats()); }
async function set(page, patch) { await page.evaluate(patch => StageControl.set(patch), patch); }
async function state(page, value) {
  try { await page.waitForFunction(value => StageFluid.status().state === value, value); }
  catch (error) {
    console.error('Unexpected state', await page.evaluate(() => ({ fluid: StageFluid.stats(), stageTier: Stage.tier(), values: StageControl.values(), hidden: document.hidden })));
    throw error;
  }
}
async function pixels(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('.stage-fluid-canvas'); if (!canvas) return { mass: 0, changed: 0 };
    // Draw and read in the same browser task: no preserveDrawingBuffer overhead.
    fixture.readPixels = true;
    return new Promise(resolve => {
      const gl = canvas.getContext('webgl2'), draw = gl.drawArrays.bind(gl);
      gl.drawArrays = function (...args) {
        draw(...args);
        if (gl.getParameter(gl.FRAMEBUFFER_BINDING)) return;
        gl.drawArrays = draw;
        const data = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
        let mass = 0, exposedMass = 0, peak = 0, hash = 2166136261;
        const bounds = canvas.getBoundingClientRect(), cover = document.querySelector('#stage .disc-wrap').getBoundingClientRect();
        for (let i = 3; i < data.length; i += 4) {
          const pixel = (i - 3) / 4, x = bounds.left + (pixel % canvas.width) / canvas.width * bounds.width;
          const y = bounds.bottom - Math.floor(pixel / canvas.width) / canvas.height * bounds.height;
          const covered = Math.pow((x - cover.left - cover.width / 2) / (cover.width / 2), 2)
            + Math.pow((y - cover.top - cover.height / 2) / (cover.height / 2), 2) < 1;
          mass += data[i]; if (!covered) { exposedMass += data[i]; peak = Math.max(peak, data[i]); }
          hash = Math.imul(hash ^ data[i], 16777619);
        }
        const program = gl.getParameter(gl.CURRENT_PROGRAM);
        resolve({ mass, exposedMass, peak, color: Array.from(gl.getUniform(program, gl.getUniformLocation(program, 'uColor'))),
          hash: hash >>> 0, width: canvas.width, height: canvas.height });
      };
      Stage.kick();
    });
  });
}
async function pageFor(browser, base, dbx = false, viewport = { width: 1440, height: 1000 }, fault = '') {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  context.on('page', page => page.on('pageerror', error => browser.fixtureErrors.push(error.message)));
  const page = await context.newPage();
  await page.addInitScript(fault => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { value: fault === 'eco' ? 2 : fault === 'balanced' ? 4 : 12 });
    Object.defineProperty(navigator, 'deviceMemory', { value: 16 });
  }, fault);
  await page.addInitScript(fault => {
    const counts = window.fixtureGpu = { attempts: 0, allocated: 0, deleted: 0 };
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (type !== 'webgl2' || !this.classList.contains('stage-fluid-canvas')) return original.call(this, type, ...args);
      counts.attempts++;
      if (fault === 'webgl') return null;
      const gl = original.call(this, type, ...args); if (!gl || gl.fixtureInstrumented) return gl;
      gl.fixtureInstrumented = true;
      for (const resource of ['Texture', 'Framebuffer', 'Program', 'Shader', 'Buffer']) {
        const create = gl['create' + resource].bind(gl), remove = gl['delete' + resource].bind(gl);
        gl['create' + resource] = (...args) => { const value = create(...args); if (value) counts.allocated++; return value; };
        gl['delete' + resource] = value => { if (value) counts.deleted++; return remove(value); };
      }
      if (fault === 'float') {
        const get = gl.getExtension.bind(gl);
        gl.getExtension = name => /color_buffer/.test(name) ? null : get(name);
      } else if (fault === 'shader') {
        const get = gl.getShaderParameter.bind(gl);
        gl.getShaderParameter = (shader, name) => name === gl.COMPILE_STATUS ? false : get(shader, name);
      } else if (fault === 'framebuffer') gl.checkFramebufferStatus = () => gl.FRAMEBUFFER_UNSUPPORTED;
      return gl;
    };
  }, fault);
  if (dbx) {
    await page.goto(base + '/sandbox');
    const frame = await (await page.waitForSelector('iframe')).contentFrame();
    await frame.waitForFunction(() => window.fixtureReady);
    return { context, page, view: frame };
  }
  await page.goto(base); await page.waitForFunction(() => window.fixtureReady);
  return { context, page, view: page };
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/sandbox') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<script>window.fixtureStorage={};addEventListener('message',event=>{
if(!event.data.fixtureStorage||!event.ports[0])return;
if(event.data.fixtureStorage==='set')window.fixtureStorage=event.data.value;
event.ports[0].postMessage(window.fixtureStorage);});</script>
<iframe sandbox="allow-scripts" src="/dbx" style="width:100%;height:100vh;border:0"></iframe>`); return;
    }
    if (url.pathname === '/' || url.pathname === '/dbx') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(fixtureHtml(url.pathname === '/dbx')); return;
    }
    const file = path.join(web, url.pathname);
    if (!file.startsWith(web + path.sep) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript'); response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  if (process.argv.includes('--serve')) { console.log('Fixture at ' + base); return; }
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const errors = []; browser.fixtureErrors = errors;
  const evidence = [];
  try {
    const { context, page } = await pageFor(browser, base);
    // Let the existing one-shot Stage frame-rate probe measure ordinary playback
    // before intentional shader compilation/context-loss/toggle stress begins.
    await page.waitForTimeout(3600);
    assert.equal((await stats(page)).contexts, 0);
    assert.equal(await page.evaluate(() => fixtureGpu.attempts), 0);
    assert.equal(await page.locator('.stage-fluid-canvas').count(), 0);
    assert.equal((await page.evaluate(() => StageControl.values())).fluidEnabled, false);
    pass('default off creates no fluid canvas/context/input observers');
    await page.locator('#stage-control-btn').click();
    await page.locator('#sc-fluid-fluidEnabled').click();
    await state(page, 'active');
    assert.equal(await page.locator('#sc-fluid-fluidEnabled').getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('#sc-fluid-details').isVisible(), true);
    const initial = await pixels(page);
    await page.waitForTimeout(550); const moving = await pixels(page);
    assert.ok(moving.mass > 500, 'actual GPU output is nonblank');
    assert.ok(moving.exposedMass > 5000 && moving.peak > 12, 'visible fluid extends beyond the album cover');
    assert.notEqual(initial.hash, moving.hash, 'music alone changes the GPU pixels');
    evidence.push({ mode: 'standalone', initial, moving, stats: await stats(page) });
    pass('native switch enables actual moving pixels from music without pointer input');
    await page.screenshot({ path: path.join(output, 'control-enabled.png') });
    await page.evaluate(() => StageControl.close());
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(output, 'stage-enhanced.png') });
    await set(page, { enabled: false, dust: false, ripples: false });
    assert.equal((await stats(page)).state, 'active');
    pass('fluid remains independent of the existing filter and particle switches');
    const bounds = await page.locator('.stage-fluid-canvas').boundingBox();
    const lyrics = await page.locator('#lyrics').boundingBox();
    const title = await page.locator('#now-title').boundingBox();
    assert.ok(bounds.y + bounds.height <= title.y);
    assert.ok(bounds.y + bounds.height <= lyrics.y);
    assert.equal(await page.locator('.stage-fluid-canvas').evaluate(el => getComputedStyle(el).pointerEvents), 'none');
    pass('effect pixels stay out of title/lyrics and never capture pointer hit testing');
    await page.evaluate(() => Stage.setSnapshot({ track_id: 'fluid-track', playing: false, position_ms: 3000, duration_ms: 180000 }));
    await state(page, 'suspended'); await page.waitForTimeout(150);
    const paused = await stats(page); await page.waitForTimeout(250);
    assert.equal((await stats(page)).steps, paused.steps);
    assert.equal((await stats(page)).frames, paused.frames);
    assert.equal(paused.pendingInputs, 0);
    await page.evaluate(() => Stage.setSnapshot({ track_id: 'fluid-track', playing: false, position_ms: 68000, duration_ms: 180000 }));
    await page.waitForTimeout(100); assert.equal((await stats(page)).steps, paused.steps);
    pass('pause and paused seek freeze simulation and drain pending input');
    await page.evaluate(() => Stage.setSnapshot({ track_id: 'fluid-track', playing: true, position_ms: 68000, duration_ms: 180000 }));
    await state(page, 'active');
    await page.evaluate(() => Stage.setReducedMotion(true));
    await state(page, 'suspended'); assert.equal((await stats(page)).contexts, 0);
    await page.evaluate(() => Stage.setReducedMotion(false)); await state(page, 'active');
    await set(page, { stagePreset: 'still' }); await state(page, 'suspended');
    assert.equal((await stats(page)).contexts, 0);
    await set(page, { stagePreset: 'venue' }); await state(page, 'active');
    pass('reduced motion and still theme release resources and preserve the requested setting');
    for (const token of ['s3d-open', 'space3d-open']) {
      await page.evaluate(token => document.body.classList.add(token), token);
      await state(page, 'suspended'); assert.equal((await stats(page)).contexts, 0);
      assert.equal(await page.locator('#sc-group-fluid').isVisible(), false);
      await page.evaluate(token => document.body.classList.remove(token), token); await state(page, 'active');
    }
    await page.evaluate(() => document.getElementById('stage').classList.add('creative-on'));
    await state(page, 'suspended'); assert.equal((await stats(page)).contexts, 0);
    await page.evaluate(() => document.getElementById('stage').classList.remove('creative-on')); await state(page, 'active');
    pass('3D, space and creative handoffs destroy the 2D context and correctly restore the request');
    await set(page, { fluidAudio: false, fluidPointer: false }); await state(page, 'suspended');
    assert.equal((await stats(page)).contexts, 0);
    await set(page, { fluidPointer: true }); await state(page, 'active');
    const motionArea = await page.locator('.stage-fluid-canvas').boundingBox();
    await page.mouse.move(motionArea.x + 18, motionArea.y + motionArea.height * .5);
    await page.mouse.move(motionArea.x + 80, motionArea.y + motionArea.height * .55, { steps: 8 });
    assert.ok((await pixels(page)).mass > 0);
    pass('pointer can drive fluid without music; disabling both inputs releases the effect');
    await set(page, { fluidStrength: 0 }); await state(page, 'suspended'); assert.equal((await stats(page)).contexts, 0);
    await set(page, { fluidStrength: 35, fluidAudio: true }); await state(page, 'active');
    await page.evaluate(() => {
      const canvas = document.querySelector('.stage-fluid-canvas');
      canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext();
    });
    await state(page, 'error'); const failed = await stats(page);
    await page.evaluate(() => window.dispatchEvent(new Event('resize'))); await page.waitForTimeout(160);
    assert.equal((await stats(page)).created, failed.created);
    await page.evaluate(() => StageFluid.retry()); await state(page, 'active');
    pass('context loss cleans up, remains failed across resize, and recovers only on explicit retry');
    // The production resize handler starts a fresh 3.2s frame-rate probe.
    // Complete it during normal playback before the context churn test.
    await page.waitForTimeout(3600);
    for (let i = 0; i < 20; i++) {
      await set(page, { fluidEnabled: false });
      const off = await stats(page);
      assert.equal(off.contexts + off.textures + off.framebuffers + off.inputListeners + off.resizeObservers + off.lifecycleObservers, 0);
      await set(page, { fluidEnabled: true }); await state(page, 'active');
    }
    await set(page, { fluidEnabled: false });
    const cleaned = await stats(page); assert.equal(cleaned.created, cleaned.disposed);
    assert.equal(await page.locator('.stage-fluid-canvas').count(), 0);
    assert.equal(await page.evaluate(() => Stage.gateRates().filter(gate => gate.name === 'stage-fluid').length), 1);
    pass('20 full toggle cycles return all tracked resources to baseline with one registered gate');
    await page.evaluate(() => { StageControl.set({ fluidEnabled: true }); StageControl.set({ fluidEnabled: false }); });
    await page.waitForTimeout(80); assert.equal((await stats(page)).contexts, 0);
    pass('closing before asynchronous preparation finishes never mounts a stale canvas');
    await set(page, { fluidEnabled: true, fluidStrength: 47 }); await state(page, 'active');
    await page.reload(); await page.waitForFunction(() => window.fixtureReady); await state(page, 'active');
    assert.equal((await page.evaluate(() => StageControl.values())).fluidStrength, 47);
    await set(page, { fluidEnabled: 'true', fluidStrength: Infinity, fluidPointer: 'false' });
    const valid = await page.evaluate(() => StageControl.values());
    assert.equal(valid.fluidEnabled, true); assert.equal(valid.fluidStrength, 47); assert.equal(valid.fluidPointer, true);
    pass('valid preferences survive reload and invalid field types cannot replace them');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await state(page, 'suspended');
    const hidden = await stats(page); await page.waitForTimeout(200);
    assert.equal((await stats(page)).frames, hidden.frames);
    assert.equal(hidden.pendingInputs, 0);
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await state(page, 'active');
    pass('visibility lifecycle input freezes drawing and drains queued input without catching up');
    await page.evaluate(() => { fixture.fresh = false; StageControl.set({ fluidPointer: false }); });
    await page.waitForFunction(() => Stage.gateRates().find(gate => gate.name === 'stage-fluid').target === 0, null, { timeout: 20000 });
    const idle = await stats(page); await page.waitForTimeout(200);
    assert.equal((await stats(page)).frames, idle.frames);
    await page.evaluate(() => { fixture.fresh = true; StageControl.set({ fluidPointer: true }); });
    await page.waitForFunction(before => StageFluid.stats().frames > before, idle.frames);
    pass('stale spectrum stops music injection and drawing; fresh input wakes the existing gate');
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate(() => StageControl.open());
      await page.locator('#sc-fluid-fluidEnabled').scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: path.join(output, 'control-' + width + '.png') });
    }
    pass('320px and 390px controls remain usable without horizontal overflow');
    await page.setViewportSize({ width: 390, height: 960 });
    await page.evaluate(() => StageControl.open());
    const toggle = page.locator('#sc-fluid-fluidEnabled');
    await toggle.focus(); await toggle.press(' '); await state(page, 'off');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.press(' '); await state(page, 'active');
    assert.equal(await page.evaluate(() => StageControl.values().fluidStrength), 47);
    await page.evaluate(() => {
      fixture.userIntents = [];
      document.addEventListener('stage:control', event => fixture.userIntents.push(event.detail));
      StageControl.close();
    });
    await page.waitForTimeout(400);
    await page.locator('#stage-progress').focus(); await page.locator('#stage-progress').press('ArrowRight');
    assert.ok(await page.evaluate(() => fixture.userIntents.some(intent => intent.action === 'seek')));
    pass('native keyboard toggle preserves subsettings and the underlying seek control still emits its original intent');
    for (const theme of ['mineral', 'ios-light']) {
      await page.evaluate(theme => Theme.apply(theme), theme);
      await page.waitForTimeout(250);
      assert.equal((await stats(page)).state, 'active');
      await page.screenshot({ path: path.join(output, 'stage-' + theme + '-390.png') });
    }
    await page.evaluate(() => {
      Stage.setTrack({ id: 'no-art', title: '没有封面和歌词的歌曲', duration_ms: 180000 }, null);
      Stage.setSnapshot({ track_id: 'no-art', playing: true, duration_ms: 180000, position_ms: 1000 });
      Stage.setLyrics(null);
    });
    await page.waitForTimeout(800);
    assert.ok((await pixels(page)).exposedMass > 5000);
    pass('dark/light themes and missing cover/lyrics keep real local output and usable controls');
    await context.close();

    const sandbox = await pageFor(browser, base, true);
    const frame = sandbox.view;
    assert.equal(await frame.evaluate(() => self.origin), 'null');
    assert.equal(await frame.evaluate(() => hertzHost.needsHydrate), true);
    await set(frame, { fluidEnabled: true, fluidStrength: 51 }); await state(frame, 'unavailable');
    await sandbox.page.waitForFunction(() => JSON.parse(fixtureStorage['vmusic.stage.control'] || '{}').fluidStrength === 51);
    assert.equal((await stats(frame)).contexts, 0);
    assert.equal(await frame.locator('.stage-fluid-canvas').count(), 0);
    await frame.evaluate(() => location.reload());
    await frame.waitForFunction(() => window.fixtureReady); await state(frame, 'unavailable');
    assert.equal(await frame.evaluate(() => StageControl.values().fluidStrength), 51);
    pass('DBX hydrates preferences through the real shim and explicitly admits no GPU effect before host acceptance');
    const warnings = [];
    sandbox.page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
    await frame.evaluate(() => { fixtureStorageFails = true; StageControl.set({ fluidStrength: 62 }); });
    await sandbox.page.waitForTimeout(700);
    assert.equal(await frame.evaluate(() => StageControl.values().fluidStrength), 62);
    assert.equal(await sandbox.page.evaluate(() => JSON.parse(fixtureStorage['vmusic.stage.control']).fluidStrength), 51);
    assert.ok(warnings.some(value => value.includes('持久化失败')));
    await set(frame, { fluidEnabled: false }); assert.equal((await stats(frame)).contexts, 0);
    pass('DBX asynchronous storage failure preserves session operation and never pretends the failed write persisted');
    evidence.push({ mode: 'dbx-opaque-fixture', hydration: true, failedWrite: { requested: 62, persisted: 51 }, warnings });
    await sandbox.context.close();

    for (const fault of ['webgl', 'float', 'shader', 'framebuffer']) {
      const broken = await pageFor(browser, base, false, undefined, fault);
      await set(broken.view, { fluidEnabled: true });
      await state(broken.view, fault === 'shader' ? 'error' : 'unavailable');
      const before = await broken.view.evaluate(() => ({ ...fixtureGpu }));
      assert.equal(before.allocated, before.deleted, fault + ' releases every partially allocated GPU object');
      assert.equal((await stats(broken.view)).contexts, 0);
      await broken.view.evaluate(() => window.dispatchEvent(new Event('resize')));
      await broken.page.waitForTimeout(220);
      assert.equal(await broken.view.evaluate(() => fixtureGpu.attempts), before.attempts);
      await set(broken.view, { fluidEnabled: false });
      assert.equal((await stats(broken.view)).state, 'off');
      assert.ok(await broken.view.locator('#now-title').isVisible());
      await broken.context.close();
    }
    pass('no WebGL2, no float attachment, shader failure and incomplete FBO all clean partial resources without retry storms');
    for (const tier of ['eco', 'balanced']) {
      const restricted = await pageFor(browser, base, false, undefined, tier);
      await set(restricted.view, { fluidEnabled: true }); await state(restricted.view, 'suspended');
      assert.equal((await stats(restricted.view)).contexts, 0);
      assert.equal(await restricted.view.evaluate(() => StageControl.values().fluidEnabled), true);
      await restricted.context.close();
    }
    pass('balanced/eco tiers retain the request and create no fluid GPU resources');
  } finally {
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ checks, evidence, errors }, null, 2));
    await browser.close(); await new Promise(resolve => server.close(resolve));
  }
  assert.deepEqual(errors, []); console.log(`Stage fluid browser: ${checks} scenarios passed.`);
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { bootstrap, cover, pixels, pageFor, fixtureHtml };
