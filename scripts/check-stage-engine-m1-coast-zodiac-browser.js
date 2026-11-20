'use strict';
// Production Stage, Stage3D adapters and the pinned Three bundle; no server or network.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), ui = path.join(root, 'plugin/ui');
const sources = ['stage-resource-budget.js', 'stage-resource-policy.js', 'stage-image-source.js', 'stage.js', 'onset.js',
  'vendor/stage-runtime.js', 'vendor/coast-stage.js', 'vendor/zodiac-stage.js', 'stage-scene-host.js',
  'stage-coast.js', 'stage-zodiac.js', 'stanza/stanza-util.js', 'stanza/stanza-theme.js', 'stage-settings.js', 'stage3d.js'];
const out = path.join(root, 'output/offline-design-completion/m1-coast-zodiac'); fs.mkdirSync(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), checks: [], errors: [],
  scope: 'Production Stage/Stage3D and original Coast/Zodiac source allocations in desktop Chrome. Controlled time, software ledger and API cleanup; no physical GPU, weak-device or embedded Full/Standard qualification.',
  sourceSha256: Object.fromEntries(sources.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(ui, file))).digest('hex')])) };
let browser;
async function pageFor(caps = {}, standalone = false) {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  page.on('pageerror', error => report.errors.push(error.stack));
  await page.route('**/*', route => route.abort());
  await page.setContent(fs.readFileSync(path.join(ui, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, ''));
  await page.addStyleTag({ path: path.join(ui, 'stage3d.css') });
  await page.evaluate(() => {
    const h = window.harness = { time: 100, next: 0, callbacks: new Map(), hidden: false, contexts: 0,
      contextAttempts: 0, programs: 0, buffers: 0, textures: 0, frames: [], liveBuffers: new Set(), livePrograms: new Set(), failBuffer: 0 };
    performance.now = () => h.time;
    requestAnimationFrame = fn => { h.callbacks.set(++h.next, fn); return h.next; };
    cancelAnimationFrame = id => h.callbacks.delete(id);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h.hidden });
    const get = HTMLCanvasElement.prototype.getContext, seen = new WeakSet();
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
      if (/webgl/.test(kind)) h.contextAttempts++;
      const gl = get.call(this, kind, ...args);
      if (gl && /webgl/.test(kind) && !seen.has(gl)) {
        seen.add(gl); h.contexts++; h.gl = gl;
        for (const [kind, count, live] of [['Buffer', 'buffers', 'liveBuffers'], ['Program', 'programs', 'livePrograms'], ['Texture', 'textures']]) {
          const make = gl['create' + kind].bind(gl), remove = gl['delete' + kind].bind(gl);
          gl['create' + kind] = () => { h[count]++; if (kind === 'Buffer' && h.failBuffer && h.buffers === h.failBuffer) return null;
            const value = make(); if (live && value) h[live].add(value); return value; };
          gl['delete' + kind] = value => { if (live) h[live].delete(value); return remove(value); };
        }
      }
      return gl;
    };
    h.advance = async (count, dt = 1000 / 60) => { for (let i = 0; i < count; i++) {
      h.time += dt; const callbacks = [...h.callbacks.values()]; h.callbacks.clear(); callbacks.forEach(fn => fn(h.time)); await Promise.resolve();
    } };
    h.hide = hidden => { h.hidden = hidden; document.dispatchEvent(new Event('visibilitychange')); };
    h.native = hidden => { window.__hertzWindowHost = { presentationVersion: 1, presentationHidden: hidden }; dispatchEvent(new Event('hertz-native-presentation')); };
  });
  for (const file of sources) {
    if (standalone && file === 'stage3d.js') continue;
    await page.addScriptTag({ path: path.join(ui, file) });
    if (file === 'stage-resource-policy.js') await page.evaluate(caps => {
      StageResourcePolicy = Object.freeze({ ...StageResourcePolicy, qualification: 'contract-test-only', caps: Object.freeze({ ...StageResourcePolicy.caps, ...caps }) });
    }, caps);
  }
  await page.evaluate(() => {
    Stage.init(); Stage.tier = () => 0; document.body.classList.add('stage-lowfx');
    Stage.setTrack({ id: 'coast-zodiac-test', duration_ms: 300000 });
    harness.snapshot = (playing, position = Stage.position(), seek = false) => Stage.setSnapshot({ playing, position_ms: position,
      duration_ms: 300000, track_id: 'coast-zodiac-test' }, { seek });
    harness.snapshot(false, 0);
    for (const name of ['Coast', 'Zodiac']) {
      const key = name + 'StagePure', api = window[key], render = api.render;
      window[key] = { ...api, render: (now, dt, uiDt, phase) => {
        const ok = render(now, dt, uiDt, phase); harness.frames.push({ name, now, dt, phase, ok, stageVisible: Stage.frameState().stageVisible }); return ok;
      } };
    }
    harness.open = async name => { Stage3D.configure({ sceneSource: name.toLowerCase(), lyrics: false, layout: 'focus' }); Stage3D.open(); await harness.advance(8); };
    harness.active = name => window['Stage' + name].stats();
    harness.close = () => Stage3D.close();
  });
  return page;
}
async function close(page) { await page.evaluate(() => { window.Stage3D?.destroy(); StageCoast.setHost(null); StageZodiac.setHost(null); Stage.destroy(); }); await page.close(); }
async function check(name, fn) {
  if (process.env.M1_SCENE_FILTER && !name.includes(process.env.M1_SCENE_FILTER)) return;
  try { report.checks.push({ name, passed: true, evidence: await fn() }); console.log('PASS ' + name); }
  catch (error) { report.checks.push({ name, passed: false, error: error.stack }); console.error('FAIL ' + name + ': ' + error.message); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
}
async function main() {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  report.browser = await browser.version();
  try {
    await check('review: partial renderer construction retains cleanup ownership until real context loss', async () => {
      const samples = [];
      for (const unavailableLoss of [false, true]) {
        const page = await pageFor({}, true);
        try {
          const result = await page.evaluate(async unavailableLoss => {
            const nativeGet = HTMLCanvasElement.prototype.getContext;
            const add = HTMLCanvasElement.prototype.addEventListener, remove = HTMLCanvasElement.prototype.removeEventListener;
            const listeners = new Set(); let gl, texture, lose;
            HTMLCanvasElement.prototype.addEventListener = function (type, fn, options) {
              if (/^webglcontext/.test(type)) listeners.add(fn); return add.call(this, type, fn, options);
            };
            HTMLCanvasElement.prototype.removeEventListener = function (type, fn, options) {
              if (/^webglcontext/.test(type)) listeners.delete(fn); return remove.call(this, type, fn, options);
            };
            HTMLCanvasElement.prototype.getContext = function (type, ...args) {
              const value = nativeGet.call(this, type, ...args);
              if (/webgl/.test(type) && value && !gl) {
                gl = value; const extension = gl.getExtension.bind(gl); lose = extension('WEBGL_lose_context');
                if (unavailableLoss) gl.getExtension = name => name === 'WEBGL_lose_context' ? null : extension(name);
                const create = gl.createTexture.bind(gl); gl.createTexture = () => (texture = create());
                gl.texImage2D = () => { throw new Error('injected first default texture upload'); };
              }
              return value;
            };
            const el = document.createElement('div'); el.style.cssText = 'width:640px;height:360px'; document.body.append(el);
            StageCoast.setHost(el);
            const failed = { stats: StageCoast.stats(), snapshot: Stage.resources().snapshot(),
              contextLost: gl.isContextLost(), textureLive: gl.isTexture(texture), listeners: listeners.size };
            if (unavailableLoss) { lose.loseContext(); await new Promise(resolve => setTimeout(resolve, 25)); }
            return { failed, settled: { snapshot: Stage.resources().snapshot(), contextLost: gl.isContextLost(),
              textureLive: gl.isTexture(texture), listeners: listeners.size } };
          }, unavailableLoss);
          assert.equal(result.failed.stats.lifecycle, 'error');
          if (unavailableLoss) {
            assert.equal(result.failed.contextLost, false); assert.equal(result.failed.textureLive, true);
            assert.equal(result.failed.snapshot.held.gpuContexts, 1); assert.ok(result.failed.snapshot.held.textureDeclaredBytes > 0);
            assert.equal(result.failed.listeners, 1);
          } else { assert.equal(result.failed.contextLost, true); assert.equal(result.failed.snapshot.resources, 0); }
          assert.equal(result.settled.contextLost, true); assert.equal(result.settled.textureLive, false);
          assert.equal(result.settled.snapshot.resources, 0); assert.equal(result.settled.listeners, 0);
          samples.push({ unavailableLoss, ...result });
        } finally { await close(page); }
      }
      return samples;
    });
    await check('review: Coast and Zodiac serial plans preserve the committed scene on refusal and cover admitted construction', async () => {
      const page = await pageFor({}, true);
      try {
        await page.addScriptTag({ path: path.join(ui, 'vendor/space-stage.js') });
        const result = await page.evaluate(async () => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64; document.body.append(canvas);
          const ledger = Stage.resources(), originalPort = ledger.port('serial-review');
          let observed = null;
          const port = { ...originalPort, require(vector, ...args) {
            if (observed) for (const [key, value] of Object.entries(vector)) observed[key] = (observed[key] || 0) + value;
            return originalPort.require(vector, ...args);
          } };
          const engine = SpaceStagePure.create(canvas, { resources: port, qualityMode: 'low' }); engine.resize(64, 64);
          const frame = { now: 100, sceneTime: 1, dt: .016, dynamicDt: .016, playing: true };
          const samples = [];
          for (const id of ['coast', 'zodiac']) {
            await engine.select('spectrum-towers'); engine.frame(frame);
            const initial = ledger.snapshot(), old = engine.stats();
            const blocker = ledger.port('preflight-competitor').require({ ownedCpuBytes: initial.caps.ownedCpuBytes - initial.held.ownedCpuBytes - 256 * 1024 }, 'temporary competitor', 0);
            const before = ledger.snapshot(true); let refusal;
            try { await engine.select(id); } catch (error) { refusal = error.message; }
            const refused = engine.stats(), held = ledger.snapshot(true);
            const nextFrame = engine.frame({ ...frame, now: 200, sceneTime: 2 });
            blocker.release({ apiReleased: true, allocationEnded: true });
            const base = ledger.snapshot();
            const plan = (id === 'coast' ? CoastStagePure : ZodiacStagePure).resourcePlan();
            // Observe declared reservations, including construction scratch,
            // through the same original resource port used by this renderer.
            observed = {};
            await engine.select(id); engine.frame(frame);
            const admitted = ledger.snapshot(true), stats = engine.stats();
            samples.push({ id, old, refusal, refused, nextFrame, beforeHeld: before.held, afterHeld: held.held,
              plan, observed, base: base.held, admitted: admitted.held, stats, violations: admitted.violations });
            observed = null;
          }
          engine.dispose(); canvas.remove(); return { samples, final: ledger.snapshot() };
        });
        for (const sample of result.samples) {
          assert.equal(sample.refusal, 'aggregate-budget'); assert.equal(sample.refused.id, 'spectrum-towers');
          assert.equal(sample.refused.state, 'ready'); assert.equal(sample.refused.firstSubmit, true); assert.ok(sample.nextFrame);
          assert.deepEqual(sample.afterHeld, sample.beforeHeld); assert.equal(sample.stats.id, sample.id); assert.ok(sample.stats.firstSubmit);
          assert.deepEqual(sample.violations, []);
          for (const key of ['ownedCpuBytes', 'bufferDeclaredBytes', 'textureDeclaredBytes', 'renderTargetDeclaredBytes', 'programs']) {
            assert.ok(sample.admitted[key] <= (sample.plan[key] || 0) + sample.base[key], sample.id + ' plan ' + key);
            // The shared post is created outside the scene resourcePlan; its
            // existing preflight adds a 140-byte plane and optional program.
            const post = key === 'ownedCpuBytes' || key === 'bufferDeclaredBytes' ? 140 : 0;
            assert.ok((sample.observed[key] || 0) <= (sample.plan[key] || 0) + post,
              sample.id + ' construction ' + key + ': ' + sample.observed[key] + ' > ' + sample.plan[key]);
          }
        }
        assert.equal(result.final.resources, 0, JSON.stringify(result.final)); return result;
      } finally { await close(page); }
    });
    await check('context/cpu/texture/program/buffer refusal precedes original allocation and cleans partial work', async () => {
      const samples = [];
      for (const name of ['Coast', 'Zodiac']) for (const caps of [{ gpuContexts: 0 }, { ownedCpuBytes: 0 }, { textureDeclaredBytes: 0 }, { programs: 0 }, { bufferDeclaredBytes: 0 }]) {
        const page = await pageFor(caps, true);
        try {
          const result = await page.evaluate(async name => {
            const baseline = Stage.resources().snapshot();
            const el = document.createElement('div'); el.style.cssText = 'position:fixed;inset:0;width:640px;height:360px'; document.body.append(el);
            window['Stage' + name].setHost(el); await harness.advance(12);
            return { baseline: baseline.held, held: Stage.resources().snapshot().held, stats: harness.active(name),
              contexts: harness.contexts, attempts: harness.contextAttempts, programs: harness.programs, buffers: harness.buffers,
              notice: document.querySelector('.stage-scene-resource-status')?.textContent };
          }, name);
          if (caps.gpuContexts === 0 || caps.ownedCpuBytes === 0 || caps.textureDeclaredBytes === 0) assert.equal(result.contexts, 0);
          if (caps.programs === 0) assert.equal(result.programs, 0);
          if (caps.bufferDeclaredBytes === 0) assert.equal(result.buffers, 0);
          assert.equal(result.stats.lifecycle, 'error'); assert.match(result.notice, /重试/);
          assert.deepEqual(result.held, result.baseline); samples.push({ name, caps, ...result });
        } finally { await close(page); }
      }
      return samples;
    });
    await check('Stage3D pause/hidden/native/reduced/zero-size/seek freeze geometry and resume at delta zero', async () => {
      const results = [];
      for (const name of ['Coast', 'Zodiac']) {
        const page = await pageFor();
        try {
          const result = await page.evaluate(async name => {
            await harness.open(name); harness.snapshot(true); await harness.advance(12);
            const phase = () => harness.active(name).sceneTimeMs;
            const first = async () => { const index = harness.frames.length; await harness.advance(6); return harness.frames.slice(index).find(frame => frame.name === name); };
            const moving = phase(); harness.snapshot(false); await harness.advance(12); const paused = phase();
            harness.snapshot(false, 210000, true); await harness.advance(8); const sought = phase();
            harness.hide(true); harness.time += 60000; await harness.advance(8); const hidden = phase();
            harness.hide(false); harness.snapshot(true); const hiddenResume = await first(); await harness.advance(8);
            const beforeReduced = phase(); Stage.setReducedMotion(true); await harness.advance(12); const reduced = phase();
            Stage.setReducedMotion(false); const reducedResume = await first(); await harness.advance(8);
            const beforeNative = phase(); harness.native(true); harness.time += 60000; await harness.advance(8); const native = phase();
            harness.native(false); const nativeResume = await first(); await harness.advance(8);
            const container = document.getElementById('s3d-' + name.toLowerCase()), beforeZero = phase();
            container.style.display = 'none'; dispatchEvent(new Event('resize')); await harness.advance(8); const zero = phase();
            container.style.display = ''; dispatchEvent(new Event('resize')); const zeroResume = await first();
            const state = harness.active(name), frame = harness.frames.at(-1);
            return { moving, paused, sought, hidden, hiddenResume, beforeReduced, reduced, reducedResume,
              beforeNative, native, nativeResume, beforeZero, zero, zeroResume, state, frame, callbacks: harness.callbacks.size };
          }, name);
          assert.ok(result.moving > 0); assert.equal(result.paused, result.moving); assert.equal(result.sought, result.paused); assert.equal(result.hidden, result.paused);
          assert.equal(result.beforeReduced, result.reduced); assert.equal(result.beforeNative, result.native); assert.equal(result.beforeZero, result.zero);
          for (const key of ['hiddenResume', 'reducedResume', 'nativeResume', 'zeroResume']) assert.equal(result[key]?.dt, 0, key);
          assert.equal(result.frame.stageVisible, false); assert.ok(result.callbacks <= 1); assert.equal(result.state.lifecycle, 'ready'); results.push({ name, ...result });
        } finally { await close(page); }
      }
      return results;
    });
    await check('audio revisions reset on suspension and stale spectra cannot reactivate resumed scenes', async () => {
      const page = await pageFor();
      try { return await page.evaluate(async () => {
        const samples = [];
        for (const name of ['Coast', 'Zodiac']) {
          await harness.open(name); harness.snapshot(true); Stage.setSpectrum(new Float32Array(64).fill(.7)); await harness.advance(12);
          const active = harness.active(name).inputActive;
          harness.hide(true); Stage.setSpectrum(new Float32Array(64).fill(.7)); harness.time += 1000; harness.hide(false); await harness.advance(12);
          const stale = harness.active(name).inputActive;
          Stage.setSpectrum(new Float32Array(64).fill(.7)); await harness.advance(12); const fresh = harness.active(name).inputActive;
          await harness.advance(42); const expired = harness.active(name).inputActive;
          if (!active || stale || !fresh || expired) throw new Error('input revision failure ' + name);
          harness.close(); samples.push({ name, active, stale, fresh, expired });
        }
        return samples;
      }); } finally { await close(page); }
    });
    await check('real context loss stays retired until explicit retry; partial native buffer failure cleans scope', async () => {
      const samples = [];
      for (const name of ['Coast', 'Zodiac']) {
        const page = await pageFor();
        try {
          await page.evaluate(async name => { await harness.open(name); harness.gl.getExtension('WEBGL_lose_context').loseContext(); }, name);
          await page.waitForFunction(name => harness.active(name).lifecycle === 'error', name);
          const lost = await page.evaluate(name => ({ contexts: harness.contexts, held: Stage.resources().snapshot().held, stats: harness.active(name) }), name);
          await page.waitForTimeout(1800);
          const restored = await page.evaluate(async name => {
            await harness.advance(12); const contextsBefore = harness.contexts;
            document.querySelector('.stage-scene-resource-status button').click(); await harness.advance(12);
            return { contextsBefore, contexts: harness.contexts, stats: harness.active(name), held: Stage.resources().snapshot().held };
          }, name);
          assert.equal(lost.held.gpuContexts, 1); assert.equal(restored.contextsBefore, lost.contexts); assert.equal(restored.contexts, lost.contexts + 1);
          assert.equal(restored.stats.lifecycle, 'ready'); samples.push({ name, lost, restored });
        } finally { await close(page); }
        const failed = await pageFor({}, true);
        try {
          const result = await failed.evaluate(async name => {
            harness.failBuffer = 3;
            const el = document.createElement('div'); el.style.cssText = 'position:fixed;inset:0;width:640px;height:360px'; document.body.append(el);
            window['Stage' + name].setHost(el); await harness.advance(12);
            return { stats: harness.active(name), ledger: Stage.resources().snapshot(), buffers: harness.liveBuffers.size, programs: harness.livePrograms.size };
          }, name);
          assert.equal(result.stats.lifecycle, 'error'); assert.equal(result.ledger.held.gpuContexts, 0);
          assert.equal(result.ledger.resources, 0); assert.equal(result.buffers, 0); assert.equal(result.programs, 0); samples.push({ name, failed: result });
        } finally { await close(failed); }
      }
      return samples;
    });
    await check('all standalone quality profiles submit and source plans also apply to the shared Space factories', async () => {
      const page = await pageFor();
      try {
        await page.addScriptTag({ path: path.join(ui, 'vendor/space-stage.js') });
        const results = await page.evaluate(async () => {
          const results = [], parent = document.createElement('div'); parent.style.cssText = 'position:fixed;inset:0'; document.body.append(parent);
          for (const name of ['Coast', 'Zodiac']) for (const quality of ['low', 'medium', 'high']) {
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; parent.append(canvas);
            const api = window[name + 'StagePure'], port = Stage.resources().port('profile-' + name + quality);
            const ok = api.mount(canvas, { resources: port, admissionRequired: true, external: true, quality, width: 640, height: 360 });
            api.resize(640, 360); api.setTime?.({ time: 2, playing: true }); api.setAudio({ level: .5, bands: new Float32Array(64).fill(.5) });
            api.render(100, .016, .016, 2); const stats = api.stats(), ledger = Stage.resources().snapshot();
            if (!ok || !ledger.held.textureDeclaredBytes || !ledger.held.ownedCpuBytes || ledger.violations.length) throw new Error('profile failed');
            api.unmount(); canvas.remove(); if (Stage.resources().snapshot().resources) throw new Error('profile leak '+JSON.stringify(Stage.resources().snapshot(true)));
            results.push({ name, quality, stats, held: ledger.held });
          }
          const canvas = document.createElement('canvas'); parent.append(canvas);
          const engine = SpaceStagePure.create(canvas, { resources: Stage.resources().port('shared-coast-zodiac'), qualityMode: 'low' }); engine.resize(640, 360);
          for (const id of ['coast', 'zodiac']) {
            await engine.select(id); engine.frame({ now: 100, sceneTime: 2, dt: .016, dynamicDt: .016, playing: true });
            const stats = engine.stats(), snapshot = Stage.resources().snapshot(true);
            if (!stats.firstSubmit || snapshot.violations.length) throw new Error('shared source failed ' + JSON.stringify(stats));
            const sources = snapshot.entries.filter(entry => /Coast|Zodiac/.test(entry.basis.source)).map(entry => entry.basis.source);
            if (!sources.length) throw new Error('missing shared source plans'); results.push({ id, stats, sources });
          }
          engine.dispose(); canvas.remove(); parent.remove();
          if (Stage.resources().snapshot().resources) throw new Error('shared source leak'); return results;
        });
        return results;
      } finally { await close(page); }
    });
    await check('twenty whole exits per scene and one hundred production source switches return resources to baseline', async () => {
      const page = await pageFor();
      try {
        const baseline = await page.evaluate(async () => { await harness.open('Coast'); harness.close(); return Stage.resources().snapshot(); });
        const cycles = [];
        for (const name of ['Coast', 'Zodiac']) for (let i = 0; i < 20; i++) {
          const sample = await page.evaluate(async name => {
            await harness.open(name); const active = harness.active(name), ledger = Stage.resources().snapshot(); harness.close();
            return { active: { lifecycle: active.lifecycle, firstSubmit: active.firstSubmit }, held: ledger.held,
              after: Stage.resources().snapshot(), callbacks: harness.callbacks.size };
          }, name);
          assert.ok(sample.active.firstSubmit); assert.equal(sample.active.lifecycle, 'ready'); assert.deepEqual(sample.after.held, baseline.held); assert.equal(sample.after.violations.length, 0);
          cycles.push({ name, i, ...sample });
        }
        const switches = [];
        for (let i = 0; i < 100; i++) {
          const name = i % 2 ? 'Zodiac' : 'Coast';
          const sample = await page.evaluate(async name => {
            await harness.open(name); return { state: harness.active(name).lifecycle, snapshot: Stage.resources().snapshot(), callbacks: harness.callbacks.size,
              canvases: document.querySelectorAll('#s3d-coast canvas,#s3d-zodiac canvas').length };
          }, name);
          assert.equal(sample.state, 'ready'); assert.equal(sample.snapshot.held.gpuContexts, baseline.held.gpuContexts + 1); assert.equal(sample.canvases, 1); assert.ok(sample.callbacks <= 1);
          assert.equal(sample.snapshot.violations.length, 0); switches.push({ i, name, held: sample.snapshot.held });
          if (i % 20 === 19) console.log('  switches ' + (i + 1));
        }
        await page.evaluate(() => harness.close());
        assert.deepEqual(await page.evaluate(() => Stage.resources().snapshot().held), baseline.held); return { baseline, cycles, switches };
      } finally { await close(page); }
    });
    await check('pointer reticle, free rig, sign and paused parameter edits remain usable', async () => {
      const page = await pageFor();
      try {
        await page.evaluate(async () => { await harness.open('Coast'); StageCoast.setRig({ position: [1, 12, 3], yaw: 1, pitch: .2, fov: 48 }, { external: true }); await harness.advance(8); });
        const coast = await page.evaluate(() => CoastStagePure.debug()); assert.deepEqual(coast.camera.position, [1, 12, 3]);
        await page.evaluate(async () => { StageCoast.setRig(null); StageCoast.setPrefs({ tod: .8 }); await harness.advance(8); });
        await page.screenshot({ path: path.join(out, 'coast.png') });
        await page.evaluate(async () => { await harness.open('Zodiac'); StageZodiac.setPrefs({ sign: 'leo' }); await harness.advance(8); });
        await page.mouse.move(300, 160); await page.mouse.down(); await page.evaluate(() => harness.advance(8));
        const zodiac = await page.evaluate(() => ({ stats: ZodiacStagePure.stats(), reticle: document.querySelector('.zodiac-reticle').className, phase: StageZodiac.stats().sceneTimeMs }));
        assert.equal(zodiac.stats.sign, 'leo'); assert.match(zodiac.reticle, /is-charging/); assert.equal(zodiac.phase, 0);
        await page.mouse.up(); await page.evaluate(() => harness.advance(8)); await page.screenshot({ path: path.join(out, 'zodiac.png') });
        return { coast: { camera: coast.camera, distance: coast.distance }, zodiac };
      } finally { await close(page); }
    });
  } finally { await browser.close(); }
  report.passed = report.checks.every(item => item.passed) && !report.errors.length;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(path.join(out, 'report.json'));
  assert.ok(report.passed, 'Coast/Zodiac M1 contract checks');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
