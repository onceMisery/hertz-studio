'use strict';
// Production Stage/CreativeStage/CreativeGL, real Chrome graphics and controlled contract time.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), web = path.join(root, 'plugin/ui');
const sources = ['stage-resource-budget.js', 'stage-resource-policy.js','stage-json-source.js', 'stage-image-source.js', 'stage.js', 'onset.js',
  'lyric3d.js', 'creative-gl.js', 'creative-anime.js', 'stage-media.js', 'bgwall.js', 'backgrounds.js', 'handdrawn.js', 'creative-stage.js'];
const digest = () => Object.fromEntries([...sources, 'stage-persistence.js', 'workshop.js'].map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(web, name))).digest('hex')]));
const out = path.join(root, 'output/a09-m1-20261108/creative-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), sourceSha256: digest(), checks: [], errors: [],
  scope: 'Creative owners in real Chrome; virtual time verifies contracts only. Other M1 owners and physical qualification remain open.' };
let browser;
async function pageFor(caps = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => report.errors.push(error.stack));
  await page.setContent('<style>body{margin:0;background:#191b1c}#stage{width:320px;height:240px}#creative{position:relative;width:640px;height:400px}.creative-canvas{position:absolute;inset:0}</style><div id="stage"></div><div id="creative"></div>');
  await page.evaluate(() => {
    const h = window.harness = { time: 100, hidden: false, next: 0, callbacks: new Map(), contexts: 0, renders: [] };
    performance.now = () => h.time;
    requestAnimationFrame = fn => { h.callbacks.set(++h.next, fn); return h.next; };
    cancelAnimationFrame = id => h.callbacks.delete(id);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h.hidden });
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (type === 'webgl2') h.contexts++; return getContext.call(this, type, ...args);
    };
    h.advance = async (count, delta = 1000 / 60) => {
      for (let i = 0; i < count; i++) {
        h.time += delta; const work = [...h.callbacks.values()]; h.callbacks.clear();
        work.forEach(fn => fn(h.time)); await Promise.resolve();
      }
    };
    h.hide = hidden => { h.hidden = hidden; document.dispatchEvent(new Event('visibilitychange')); };
    document.body.classList.add('stage-open');
  });
  for (const source of sources) {
    await page.addScriptTag({ path: path.join(web, source) });
    if (source === 'stage-resource-policy.js') await page.evaluate(caps => {
      StageResourcePolicy = Object.freeze({ ...StageResourcePolicy, qualification: 'contract-test-only',
        caps: Object.freeze({ ...StageResourcePolicy.caps, ...caps }) });
    }, caps);
  }
  await page.evaluate(() => {
    const create = CreativeGL.create;
    CreativeGL.create = (canvas, options) => {
      const engine = create(canvas, options); if (!engine) return engine;
      const render = engine.render;
      engine.render = state => {
        const result = render(state); harness.renders.push({ t: state.t, dt: state.dt, scene: state.scene,
          index: state.lyric && state.lyric.index, energy: state.energy, ok: result.ok, reason: result.reason }); return result;
      }; harness.lastEngine = engine; return engine;
    };
    Stage.init(); Stage.setTrack({ id: 'm1-creative', duration_ms: 200000 });
    harness.snapshot = (playing, position = Stage.position(), seek = false) => {
      document.body.classList.toggle('is-playing', playing);
      Stage.setSnapshot({ playing, track_id: 'm1-creative', duration_ms: 200000, position_ms: position }, { seek });
    };
    harness.snapshot(false, 0); CreativeStage.init();
  });
  return page;
}
async function mount(page) {
  await page.evaluate(() => { document.body.classList.add('s3d-open'); CreativeStage.attachStage(document.getElementById('creative')); });
  await page.evaluate(() => harness.advance(24));
  assert.equal(await page.evaluate(() => harness.renders.filter(frame => frame.ok).length > 0), true);
}
async function close(page) {
  await page.evaluate(() => { CreativeStage.destroy(); Backgrounds.destroy(); HandDrawn.destroy(); Stage.destroy(); }); await page.close();
}
async function check(name, fn) {
  try { const evidence = await fn(); report.checks.push({ name, passed: true, evidence }); console.log('PASS ' + name); }
  catch (error) { report.checks.push({ name, passed: false, error: error.stack }); console.error('FAIL ' + name + ': ' + error.message); }
}
async function main() {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    await check('native parent visibility defers real palette decoding while browser visibility stays true', async () => {
      const page = await pageFor();
      try {
        const hidden = await page.evaluate(() => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
          const context = canvas.getContext('2d'); context.fillStyle = '#347f68'; context.fillRect(0, 0, 16, 16);
          const url = canvas.toDataURL(); canvas.width = canvas.height = 0;
          window.__nativeDecodeCalls = 0;
          const decode = StageImageSource.decode;
          window.StageImageSource = { ...StageImageSource,
            decode: function (...args) { __nativeDecodeCalls++; return decode.apply(this, args); } };
          window.__hertzWindowHost = { presentationVersion: 1, presentationHidden: true };
          window.dispatchEvent(new Event('hertz-native-presentation'));
          const baseline = Stage.resources().snapshot();
          Stage.setCoverFollow(true); Stage.setTrack({ id: 'native-cover', duration_ms: 200000 }, url);
          return { browserHidden: document.hidden, stageHidden: Stage.isDocumentHidden(),
            frameHidden: Stage.frameState().documentHidden, decodeCalls: __nativeDecodeCalls,
            baseline, after: Stage.resources().snapshot() };
        });
        assert.equal(hidden.browserHidden, false); assert.equal(hidden.stageHidden, true);
        assert.equal(hidden.frameHidden, true); assert.equal(hidden.decodeCalls, 0);
        assert.deepEqual(hidden.after.held, hidden.baseline.held);
        await page.evaluate(() => {
          __hertzWindowHost.presentationHidden = false;
          window.dispatchEvent(new Event('hertz-native-presentation'));
        });
        await page.waitForFunction(() => Stage.resources().snapshot(true).hosts.some(host => host.owner === 'stage-cover-palette' && host.state === 'ready'));
        const restored = await page.evaluate(() => ({ decodeCalls: __nativeDecodeCalls,
          browserHidden: document.hidden, stageHidden: Stage.isDocumentHidden(), frameHidden: Stage.frameState().documentHidden }));
        assert.equal(restored.decodeCalls, 1); assert.equal(restored.browserHidden, false);
        assert.equal(restored.stageHidden, false); assert.equal(restored.frameHidden, false);
        return { hidden, restored };
      } finally { await close(page); }
    });
    await check('module evaluation is inert and availability queries create no contexts', async () => {
      const page = await pageFor();
      try {
        const result = await page.evaluate(() => {
          for (let i = 0; i < 100; i++) CreativeGL.isAvailable();
          return { contexts: harness.contexts, atlas: Lyric3D.canvas, resources: Stage.resources().snapshot() };
        });
        assert.equal(result.contexts, 0); assert.equal(result.atlas, null); assert.equal(result.resources.live.gpuContexts, 0);
        assert.equal(result.resources.live.ownedCpuBytes, 2832); return result;
      } finally { await close(page); }
    });
    await check('startup library refusal preserves the readable controller and retries only at explicit allocation', async () => {
      const page = await pageFor({ ownedCpuBytes: 0 });
      try {
        const result = await page.evaluate(async () => {
          const ledger = Stage.resources(), before = ledger.snapshot();
          const preset = CreativeStage.preset(), library = CreativeStage.library();
          await harness.advance(100); const idle = ledger.snapshot();
          let refused; try { CreativeStage.savePreset('refused'); } catch (error) { refused = error.message; }
          const unchanged = CreativeStage.preset(); CreativeStage.destroy();
          return { before, preset, library, idle, refused, unchanged, final: ledger.snapshot() };
        });
        assert.equal(result.preset.scene, 'towers'); assert.deepEqual(result.library, []);
        assert.equal(result.idle.rejections, result.before.rejections); assert.equal(result.refused, 'aggregate-budget');
        assert.deepEqual(result.unchanged, result.preset); assert.equal(result.final.resources, 0); return result;
      } finally { await close(page); }
    });
    await check('context rejection cleans host canvas before getContext and does not change the preset', async () => {
      const page = await pageFor({ gpuContexts: 0 });
      try {
        const result = await page.evaluate(() => {
          const baseline = Stage.resources().snapshot(), preset = CreativeStage.exportJSON();
          const accepted = CreativeStage.attachStage(document.getElementById('creative'));
          return { baseline, accepted, preset, afterPreset: CreativeStage.exportJSON(), contexts: harness.contexts,
            after: Stage.resources().snapshot(), canvases: document.querySelectorAll('.creative-canvas').length };
        });
        assert.equal(result.accepted, false); assert.equal(result.contexts, 0); assert.equal(result.canvases, 0);
        assert.equal(result.preset, result.afterPreset); assert.deepEqual(result.after.held, result.baseline.held); return result;
      } finally { await close(page); }
    });
    await check('hidden prepare is deferred; paused first submit uses the Stage gate and current programs only', async () => {
      const page = await pageFor();
      try {
        const result = await page.evaluate(async () => {
          harness.hide(true); CreativeStage.attachStage(document.getElementById('creative'));
          const hidden = { contexts: harness.contexts, renders: harness.renders.length };
          harness.time += 60000; harness.hide(false); const beforeGate = harness.renders.length;
          await harness.advance(24);
          const mounted = { stats: CreativeStage.stats(), renders: harness.renders.slice(), resources: Stage.resources().snapshot(true) };
          await harness.advance(120); return { hidden, beforeGate, mounted, afterIdle: harness.renders.length };
        });
        assert.deepEqual(result.hidden, { contexts: 0, renders: 0 }); assert.equal(result.beforeGate, 0);
        assert.equal(result.mounted.renders.length, 1); assert.equal(result.mounted.renders[0].t, 0); assert.equal(result.mounted.renders[0].dt, 0);
        assert.equal(result.afterIdle, 1); assert.equal(result.mounted.resources.live.programs, 4);
        assert.equal(result.mounted.resources.hosts[0].actualBackend, 'webgl2'); return result;
      } finally { await close(page); }
    });
    await check('geometry phase freezes and resumes at delta0 while seek and anchor only move media cues', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(async () => {
          CreativeStage.setPreset({ scene: 'towers', director: false, bindings: [], look: { bloom: .4 },
            cues: [{ at: 2, len: 1000, ease: 'linear', set: { 'look.bloom': 1.4 } }] });
          harness.snapshot(true, 0); Stage.setSpectrum(new Float32Array(64).fill(.3)); await harness.advance(30);
          const moving = CreativeStage.stats().sceneTimeMs;
          harness.snapshot(false); await harness.advance(20); const paused = CreativeStage.stats().sceneTimeMs;
          harness.hide(true); harness.time += 60000; await harness.advance(20); const hidden = CreativeStage.stats().sceneTimeMs;
          harness.snapshot(false, 3000, true); harness.hide(false); await harness.advance(20);
          const sought = { phase: CreativeStage.stats().sceneTimeMs, bloom: CreativeStage.runtime()['look.bloom'] };
          harness.snapshot(false, 3500); await harness.advance(20); const anchored = CreativeStage.stats().sceneTimeMs;
          const resumeAt = harness.renders.length; harness.snapshot(true); Stage.setSpectrum(new Float32Array(64).fill(.3)); await harness.advance(15);
          const resumed = harness.renders.slice(resumeAt); Stage.setReducedMotion(true); await harness.advance(20);
          const reduced = CreativeStage.stats().sceneTimeMs; await harness.advance(120); const reducedEnd = CreativeStage.stats().sceneTimeMs;
          return { moving, paused, hidden, sought, anchored, resumed, reduced, reducedEnd, stageVisible: Stage.frameState().stageVisible };
        });
        assert.ok(result.moving > 0); assert.equal(result.paused, result.moving); assert.equal(result.hidden, result.paused);
        assert.equal(result.sought.phase, result.paused); assert.equal(result.sought.bloom, 1.4); assert.equal(result.anchored, result.paused);
        assert.equal(result.resumed[0].dt, 0); assert.ok(result.resumed.every(frame => frame.dt <= 100));
        assert.equal(result.reduced, result.reducedEnd); assert.equal(result.stageVisible, false); return result;
      } finally { await close(page); }
    });
    await check('failed candidate keeps the committed old scene and never recompiles every frame', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(async () => {
          const gl = harness.lastEngine.gl, original = gl.getShaderParameter.bind(gl); let failures = 0;
          gl.getShaderParameter = (shader, pname) => {
            if (pname === gl.COMPILE_STATUS && gl.getShaderParameterOriginalType !== true && gl.getShaderSource(shader).includes('out vec4')) {
              failures++; return false;
            }
            return original(shader, pname);
          };
          const baseline = Stage.resources().snapshot(); harness.snapshot(true); CreativeStage.setScene('nebula');
          await harness.advance(90); const failed = { stats: CreativeStage.stats(), resources: Stage.resources().snapshot(true),
            renders: harness.renders.slice(-10), failures };
          gl.getShaderParameter = original; return { baseline, failed };
        });
        assert.equal(result.failed.failures, 1); assert.equal(result.failed.resources.live.programs, result.baseline.live.programs);
        assert.ok(result.failed.renders.every(frame => frame.ok && frame.scene === 'towers'));
        const host = result.failed.resources.hosts.find(host => host.owner === 'creative-view');
        assert.equal(host.actualScene, 'towers'); assert.ok(host.reasons.includes('shader'));
        assert.ok(host.candidateFailureRequestId); assert.equal(result.failed.stats.scene, 'nebula'); return result;
      } finally { await close(page); }
    });
    await check('shared CPU atlas leases protect one underlying source until the last release', async () => {
      const page = await pageFor();
      try {
        const result = await page.evaluate(() => {
          const baseline = Stage.resources().snapshot(), ledger = Stage.resources();
          const a = Lyric3D.acquire(ledger.port('atlas-a')), b = Lyric3D.acquire(ledger.port('atlas-b'));
          Lyric3D.frame({ index: 0, lines: [{ text: '雨停在旧街角' }] });
          const shared = ledger.snapshot(true); a.release(); const retained = ledger.snapshot(); b.release();
          return { baseline, shared, retained, after: ledger.snapshot(), atlasAfter: Lyric3D.canvas };
        });
        assert.equal(result.shared.live.canvases - result.baseline.live.canvases, 1);
        assert.equal(result.shared.entries.reduce((total, entry) => total + entry.leases, 0), 2);
        assert.deepEqual(result.shared.held, result.retained.held); assert.deepEqual(result.after.held, result.baseline.held);
        assert.equal(result.atlasAfter, null); return result;
      } finally { await close(page); }
    });
    await check('two GL contexts charge separate lyric textures and retain their shared CPU atlas', async () => {
      const page = await pageFor();
      try {
        const result = await page.evaluate(() => {
          const ledger = Stage.resources(), baseline = ledger.snapshot(), engines = [];
          const preset = CreativeStage.preset();
          const state = { scene: 'lyric', quality: 2, t: 0, dt: 0, play: false, seed: .42,
            p: CreativeGL.sceneById('lyric').defaults, bands: [], rises: [], agg: [0,0,0,0], energy: 0, pulse: 0,
            colors: [[.6,.7,.8],[.7,.8,.6]], lyric: { index: 0, lines: [{ text: '雨停在旧街角' }] }, post: preset.look,
            cam: { yaw: 0, pitch: .2, fov: 52, dist: 6, tx: 0, ty: 1, tz: 0 } };
          for (let i = 0; i < 2; i++) {
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 0;
            const engine = CreativeGL.create(canvas, { resources: ledger.port('lyric-gl-' + i), lyricResources: ledger.port('atlas-gl-' + i) });
            engine.resize(200, 120, 1); const rendered = engine.render({ ...state });
            if (!rendered.ok) throw Error(JSON.stringify(rendered)); engines.push(engine);
          }
          const shared = ledger.snapshot(true); engines[0].dispose(); const retained = ledger.snapshot(true);
          const retainedAtlas = !!Lyric3D.canvas; engines[1].dispose();
          return { baseline, shared, retained, retainedAtlas, after: ledger.snapshot(), atlasAfter: Lyric3D.canvas };
        });
        assert.equal(result.shared.live.textureDeclaredBytes, 2 * (7077888 + 128));
        assert.equal(result.retained.live.textureDeclaredBytes, 7077888 + 128);
        assert.equal(result.shared.live.ownedCpuBytes - result.retained.live.ownedCpuBytes, 576);
        assert.equal(result.retainedAtlas, true); assert.equal(result.atlasAfter, null);
        assert.deepEqual(result.after.held, result.baseline.held); return result;
      } finally { await close(page); }
    });
    await check('real hidden context loss retires the renderer and restored events cannot recreate it', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        await page.evaluate(() => { harness.hide(true); harness.lastEngine.gl.getExtension('WEBGL_lose_context').loseContext(); });
        await page.waitForFunction(() => Stage.resources().snapshot().live.gpuContexts === 0);
        const result = await page.evaluate(async () => {
          const before = harness.contexts, hidden = Stage.resources().snapshot(true);
          document.querySelector('.creative-canvas').dispatchEvent(new Event('webglcontextrestored'));
          harness.snapshot(true); harness.time += 60000; harness.hide(false); await harness.advance(24);
          const phase = CreativeStage.stats().sceneTimeMs, renders = harness.renders.length;
          await harness.advance(120);
          return { before, after: harness.contexts, hidden, resources: Stage.resources().snapshot(true),
            stats: CreativeStage.stats(), phase, renders, afterRenders: harness.renders.length };
        });
        assert.equal(result.before, result.after); assert.equal(result.resources.live.gpuContexts, 0);
        assert.equal(result.stats.fps, 0); assert.equal(result.stats.sceneTimeMs, result.phase);
        assert.equal(result.renders, result.afterRenders);
        assert.ok(result.hidden.hosts[0].reasons.includes('context-lost')); assert.equal(result.hidden.hosts[0].actualBackend, 'none'); return result;
      } finally { await close(page); }
    });
    await check('twenty complete creative exits release contexts, programs, surfaces and listeners', async () => {
      const page = await pageFor();
      try {
        const result = await page.evaluate(async () => {
          const baseline = Stage.resources().snapshot(), cycles = [], active = [];
          for (let i = 0; i < 20; i++) {
            CreativeStage.attachStage(document.getElementById('creative')); await harness.advance(24);
            active.push({ resources: Stage.resources().snapshot(), submitted: harness.renders.at(-1) });
            CreativeStage.attachStage(null); cycles.push(Stage.resources().snapshot());
          }
          CreativeStage.destroy(); return { baseline, cycles, active, final: Stage.resources().snapshot() };
        });
        for (const active of result.active) { assert.ok(active.submitted.ok); assert.equal(active.resources.live.gpuContexts, 1); }
        for (const cycle of result.cycles) { assert.deepEqual(cycle.held, result.baseline.held); assert.equal(cycle.resources, result.baseline.resources); }
        assert.equal(result.final.resources, 0); assert.equal(result.final.listeners, 0); return result;
      } finally { await close(page); }
    });
    await check('movable background surface is charged once and twenty field replacements clean to baseline', async () => {
      const page = await pageFor();
      try {
        const result = await page.evaluate(() => {
          const ledger = Stage.resources(), baseline = ledger.snapshot();
          Backgrounds.apply({ type: 'flow' }); const created = ledger.snapshot(), swaps = [];
          for (let i = 0; i < 20; i++) {
            Backgrounds.setStageHost(document.getElementById('creative')); const stage = ledger.snapshot();
            Backgrounds.setStageHost(null); Backgrounds.apply({ type: 'flow' });
            swaps.push({ stage, home: ledger.snapshot() });
          }
          Backgrounds.destroy(); return { baseline, created, swaps, after: ledger.snapshot() };
        });
        assert.equal(result.created.live.canvases - result.baseline.live.canvases, 1);
        assert.ok(result.created.live.ownedCpuBytes > result.baseline.live.ownedCpuBytes);
        for (const swap of result.swaps) { assert.deepEqual(swap.stage.held, result.created.held); assert.deepEqual(swap.home.held, result.created.held); }
        assert.deepEqual(result.after.held, result.baseline.held); return result;
      } finally { await close(page); }
    });
    await check('background phase and accumulated pixels survive paused hidden time and media seeks', async () => {
      const page = await pageFor();
      try {
        const result = await page.evaluate(async () => {
          Backgrounds.apply({ type: 'flow' }); harness.snapshot(true); await harness.advance(60);
          const moving = Backgrounds.stats().sceneTimeMs;
          harness.snapshot(false); await harness.advance(24);
          const before = document.getElementById('creative-bg-canvas').toDataURL();
          const paused = Backgrounds.stats(); harness.hide(true); harness.time += 60000;
          harness.snapshot(false, 80000, true); harness.hide(false); await harness.advance(60);
          const after = document.getElementById('creative-bg-canvas').toDataURL();
          const restored = Backgrounds.stats(); harness.snapshot(true); await harness.advance(12);
          const resumed = Backgrounds.stats(); Stage.setReducedMotion(true); await harness.advance(24);
          const reduced = Backgrounds.stats().sceneTimeMs; await harness.advance(120);
          return { moving, paused, restored, resumed, samePixels: before === after, reduced, end: Backgrounds.stats() };
        });
        assert.ok(result.moving > 0); assert.equal(result.samePixels, true);
        assert.equal(result.paused.sceneTimeMs, result.restored.sceneTimeMs); assert.equal(result.restored.fps, 0);
        assert.ok(result.resumed.sceneTimeMs > result.restored.sceneTimeMs);
        assert.equal(result.reduced, result.end.sceneTimeMs); assert.equal(result.end.fps, 0); return result;
      } finally { await close(page); }
    });
    await check('hidden paper request completes once visible and hand geometry stays independent of seek', async () => {
      const page = await pageFor();
      try {
        const result = await page.evaluate(async () => {
          harness.hide(true); HandDrawn.setStageHost(document.getElementById('creative'));
          HandDrawn.apply({ on: true, paper: true, frame: true }); const hidden = HandDrawn.stats();
          harness.hide(false); await harness.advance(24); const visible = HandDrawn.stats();
          harness.snapshot(true); await harness.advance(60); const moving = HandDrawn.stats().sceneTimeMs;
          harness.snapshot(false); await harness.advance(24); const paused = HandDrawn.stats().sceneTimeMs;
          harness.hide(true); harness.time += 60000; harness.snapshot(false, 80000, true);
          harness.hide(false); await harness.advance(60); const sought = HandDrawn.stats().sceneTimeMs;
          return { hidden, visible, moving, paused, sought, paperStyle: document.querySelector('.hd-layer').style.getPropertyValue('--hd-paper-image') };
        });
        assert.equal(result.hidden.hasPaper, false); assert.equal(result.visible.hasPaper, true);
        assert.match(result.paperStyle, /^url/); assert.ok(result.moving > 0);
        assert.equal(result.moving, result.paused); assert.equal(result.paused, result.sought); return result;
      } finally { await close(page); }
    });
    await check('paper encoding violation is recorded and failed generation is not retried each frame', async () => {
      const page = await pageFor();
      try {
        const result = await page.evaluate(async () => {
          const ledger = Stage.resources(), baseline = ledger.snapshot(); let calls = 0;
          const original = HTMLCanvasElement.prototype.toDataURL;
          HTMLCanvasElement.prototype.toDataURL = () => { calls++; return 'data:image/png;base64,' + 'a'.repeat(200000); };
          HandDrawn.setStageHost(document.getElementById('creative')); HandDrawn.apply({ on: true, paper: true });
          harness.snapshot(true); await harness.advance(120); HTMLCanvasElement.prototype.toDataURL = original;
          return { baseline, calls, stats: HandDrawn.stats(), after: ledger.snapshot() };
        });
        assert.equal(result.calls, 1); assert.equal(result.stats.hasPaper, false);
        assert.equal(result.stats.paperError, 'paper-encoding-exceeds-plan');
        assert.equal(result.after.violations.length, 1); assert.deepEqual(result.after.held, result.baseline.held); return result;
      } finally { await close(page); }
    });
    await check('BgWall admits its original GL owner and releases resize/upload resources over twenty exits', async () => {
      const page = await pageFor();
      try {
        const result = await page.evaluate(() => {
          const ledger = Stage.resources(), baseline = ledger.snapshot(), active = [], exits = [];
          const host = document.getElementById('creative'), source = document.createElement('canvas'); source.width = 400; source.height = 200;
          source.getContext('2d').fillRect(0, 0, 400, 200);
          for (let i = 0; i < 20; i++) {
            if (!BgWall.attach(host, null, { resources: ledger.port('wall-test-' + i) })) throw Error('wall not attached');
            BgWall.setSource(source); if (!BgWall.render(0, {})) throw Error('wall not rendered'); active.push(ledger.snapshot());
            BgWall.dispose(); exits.push(ledger.snapshot());
          }
          source.width = source.height = 0; return { baseline, active, exits };
        });
        for (const active of result.active) {
          assert.equal(active.live.gpuContexts, 1); assert.equal(active.live.programs, 1);
          assert.equal(active.live.canvases - result.baseline.live.canvases, 2);
          assert.equal(active.live.textureDeclaredBytes, 400 * 200 * 4);
        }
        for (const exit of result.exits) assert.deepEqual(exit.held, result.baseline.held); return result;
      } finally { await close(page); }
    });
    await check('BgWall rejection happens before context creation and partial shader failures clean everything', async () => {
      const refused = await pageFor({ gpuContexts: 0 });
      try {
        const result = await refused.evaluate(() => {
          const ledger = Stage.resources(), baseline = ledger.snapshot();
          const accepted = BgWall.attach(document.getElementById('creative'), null, { resources: ledger.port('wall-refusal') });
          return { baseline, accepted, after: ledger.snapshot(), contexts: harness.contexts };
        });
        assert.equal(result.accepted, false); assert.equal(result.contexts, 0); assert.deepEqual(result.after.held, result.baseline.held);
      } finally { await close(refused); }
      const page = await pageFor();
      try {
        const result = await page.evaluate(() => {
          const ledger = Stage.resources(), baseline = ledger.snapshot();
          const original = WebGL2RenderingContext.prototype.getShaderParameter;
          WebGL2RenderingContext.prototype.getShaderParameter = function (shader, pname) {
            if (pname === this.COMPILE_STATUS && this.getShaderSource(shader).includes('frag;')) return false;
            return original.call(this, shader, pname);
          };
          const accepted = BgWall.attach(document.getElementById('creative'), null, { resources: ledger.port('wall-shader-fail') });
          WebGL2RenderingContext.prototype.getShaderParameter = original;
          return { baseline, accepted, after: ledger.snapshot(), stats: BgWall.stats() };
        });
        assert.equal(result.accepted, false); assert.deepEqual(result.after.held, result.baseline.held);
        assert.equal(result.stats.ready, false); return result;
      } finally { await close(page); }
    });
    await check('media decoder is admitted before src and cancellation holds unresolved decode work', async () => {
      const page = await pageFor();
      try {
        await page.evaluate(() => {
          const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
          window.VMusicTransport = { post: async (url, body) => body.action === 'lease.acquire'
            ? { leaseId: 'image-fixture', url: png, media: 'image', ttlMs: 120000, length: 70 } : {} };
          HTMLImageElement.prototype.decode = function () {
            harness.decodeStarted = true; return new Promise(resolve => { harness.endDecode = resolve; });
          };
          Backgrounds.apply({ type: 'media', media: 'image', assetRef: { storeId: 'test', assetId: 'fixture' } });
          Backgrounds.ready().catch(() => {});
        });
        await page.waitForFunction(() => harness.decodeStarted === true);
        const result = await page.evaluate(async () => {
          const ledger = Stage.resources(), pending = ledger.snapshot(); Backgrounds.destroy();
          const cancelled = ledger.snapshot(); harness.endDecode(); for (let i = 0; i < 24; i++) await Promise.resolve();
          return { pending, cancelled, after: ledger.snapshot() };
        });
        assert.equal(result.pending.held.decoderLeases, 1); assert.equal(result.pending.held.decodeReservedBytes, 64000000);
        assert.equal(result.cancelled.held.decoderLeases, 1); assert.equal(result.after.held.decoderLeases, 0);
        assert.equal(result.after.held.decodeReservedBytes, 0); return result;
      } finally { await close(page); }
    });
    await check('anime artwork shares decoded source and charges separate raster/texture copies per context', async () => {
      const page = await pageFor();
      try {
        await page.evaluate(() => {
          const ledger = Stage.resources(); harness.artBaseline = ledger.snapshot(); harness.artEngines = [];
          const def = CreativeGL.sceneById('anime-sky');
          harness.artState = { scene: def.id, quality: 2, t: 0, dt: 0, play: false, seed: .42,
            p: def.defaults, bands: [], rises: [], agg: [0,0,0,0], energy: 0, pulse: 0,
            colors: [[.6,.7,.8],[.7,.8,.6]], post: CreativeStage.preset().look,
            cam: { yaw: 0, pitch: 0, fov: 55, dist: 20, tx: 0, ty: 0, tz: 0 } };
          for (let i = 0; i < 2; i++) {
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 0;
            const engine = CreativeGL.create(canvas, { resources: ledger.port('art-gl-' + i) }); engine.resize(320, 200, 1);
            const result = engine.render(harness.artState); if (!result.ok) throw Error(JSON.stringify(result)); harness.artEngines.push(engine);
          }
        });
        await page.waitForFunction(() => Stage.resources().snapshot().live.decoderLeases === 1);
        const result = await page.evaluate(() => {
          const ledger = Stage.resources();
          for (const engine of harness.artEngines) { const result = engine.render(harness.artState); if (!result.ok) throw Error(JSON.stringify(result)); }
          const shared = ledger.snapshot(true); harness.artEngines[0].dispose(); const retained = ledger.snapshot();
          harness.artEngines[1].dispose(); return { baseline: harness.artBaseline, shared, retained, after: ledger.snapshot() };
        });
        assert.equal(result.shared.live.decoderLeases, 1); assert.equal(result.retained.live.decoderLeases, 1);
        assert.equal(result.shared.live.textureDeclaredBytes, 2 * (Math.round(512 * 1.6) * 512 * 4 + 128));
        assert.equal(result.retained.live.textureDeclaredBytes, result.shared.live.textureDeclaredBytes / 2);
        assert.deepEqual(result.after.held, result.baseline.held); return result;
      } finally { await close(page); }
    });
    await check('capture lease keeps exact encoded source after temporary cleanup and renderer disposal', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(() => {
          const ledger = Stage.resources(), baseline = ledger.snapshot(), engine = harness.lastEngine;
          const source = engine.captureLease({ outputResources: ledger.port('capture-source-test') });
          if (!source || !source.url.startsWith('data:image/jpeg;base64,')) throw Error('missing real JPEG');
          const encodedBytes = source.url.length * 2, active = ledger.snapshot(true);
          CreativeStage.attachStage(null); const retired = ledger.snapshot(true), urlStillPresent = source.url.length > 0;
          source.release(); source.release();
          return { baseline, active, retired, encodedBytes, urlStillPresent, releasedUrl: source.url, after: ledger.snapshot() };
        });
        assert.equal(result.active.live.canvases, result.baseline.live.canvases);
        assert.equal(result.active.live.drawingBufferPixels, result.baseline.live.drawingBufferPixels);
        assert.equal(result.active.live.ownedCpuBytes - result.baseline.live.ownedCpuBytes, result.encodedBytes);
        assert.equal(result.retired.live.gpuContexts, 0); assert.equal(result.urlStillPresent, true);
        assert.equal(result.retired.live.ownedCpuBytes, 2832 + result.encodedBytes);
        assert.equal(result.releasedUrl, ''); assert.equal(result.after.live.ownedCpuBytes, 2832);
        assert.equal(result.after.resources, 2); return result;
      } finally { await close(page); }
    });
    await check('capture partial failure, output refusal and encoding overrun clean without losing prior source', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(() => {
          const ledger = Stage.resources(), engine = harness.lastEngine, prior = engine.capture();
          const baseline = ledger.snapshot(), failures = [];
          const getContext = HTMLCanvasElement.prototype.getContext, encode = HTMLCanvasElement.prototype.toDataURL;
          let surfaces = 0, encodingCalls = 0;
          HTMLCanvasElement.prototype.getContext = function (type, ...args) {
            if (type === '2d' && ++surfaces === 2) return null;
            return getContext.call(this, type, ...args);
          };
          try { engine.captureLease(); } catch (error) { failures.push(error.message); }
          HTMLCanvasElement.prototype.getContext = getContext;
          const afterPartial = ledger.snapshot();
          HTMLCanvasElement.prototype.toDataURL = function (...args) { encodingCalls++; return encode.apply(this, args); };
          const outputLedger = StageResourceBudget.create({ ...StageResourcePolicy, caps: { ...StageResourcePolicy.caps, ownedCpuBytes: 0 } });
          try { engine.captureLease({ outputResources: outputLedger.port('capture-output-refusal') }); } catch (error) { failures.push(error.message); }
          const afterRefusal = ledger.snapshot();
          HTMLCanvasElement.prototype.toDataURL = () => { throw Error('injected encoder failure'); };
          try { engine.capture(); } catch (error) { failures.push(error.message); }
          const afterEncoderFailure = ledger.snapshot();
          HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,' + 'x'.repeat(1000000);
          try { engine.capture(); } catch (error) { failures.push(error.message); }
          HTMLCanvasElement.prototype.toDataURL = encode;
          const afterOverrun = ledger.snapshot(true), replacement = engine.capture();
          const afterReplacement = ledger.snapshot(true);
          return { baseline, failures, afterPartial, afterRefusal, encodingCalls, afterEncoderFailure, afterOverrun,
            priorBytes: prior.length * 2, replacementBytes: replacement.length * 2, afterReplacement, output: outputLedger.snapshot() };
        });
        assert.equal(result.failures.length, 4); assert.equal(result.encodingCalls, 0);
        for (const snapshot of [result.afterPartial, result.afterRefusal, result.afterEncoderFailure, result.afterOverrun]) {
          assert.deepEqual(snapshot.held, result.baseline.held);
        }
        assert.equal(result.output.resources, 0); assert.equal(result.afterOverrun.violations.length, 1);
        assert.equal(result.afterReplacement.live.ownedCpuBytes - result.baseline.live.ownedCpuBytes,
          result.replacementBytes - result.priorBytes); return result;
      } finally { await close(page); }
    });
    await check('capture cleanup failure retains the temporary quota and reports failed retirement', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(() => {
          const ledger = Stage.resources(), baseline = ledger.snapshot(), create = document.createElement.bind(document);
          let first = true;
          document.createElement = function (tag, ...args) {
            const element = create(tag, ...args);
            if (tag === 'canvas' && first) {
              first = false;
              const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
              Object.defineProperty(element, 'width', { get() { return descriptor.get.call(this); },
                set(value) { if (value === 0) throw Error('injected surface retirement failure'); descriptor.set.call(this, value); } });
            }
            return element;
          };
          let error = null; try { harness.lastEngine.captureLease(); } catch (failure) { error = failure.message; }
          document.createElement = create;
          return { baseline, error, after: ledger.snapshot(true), engine: harness.lastEngine.resources() };
        });
        assert.equal(result.error, 'injected surface retirement failure'); assert.equal(result.engine.captureCleanupFailed, true);
        assert.equal(result.after.held.canvases - result.baseline.held.canvases, 2);
        assert.ok(result.after.held.ownedCpuBytes > result.baseline.held.ownedCpuBytes);
        assert.equal(result.after.entries.filter(entry => /JPEG UTF16/.test(entry.basis.source)).length, 0);
        return result;
      } finally { await close(page); }
    });
    await check('forty-entry thumbnail library preserves aliases across eviction, load, removal and GL close', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(() => {
          const ledger = Stage.resources(), first = CreativeStage.savePreset('protected first');
          const source = () => ledger.snapshot(true).entries.filter(entry => entry.owner === 'creative-thumbnail-sources');
          const saved = source(); CreativeStage.loadPresetById(first.id); const loaded = source();
          for (let i = 0; i < 44; i++) CreativeStage.savePreset('capture ' + i);
          const library = CreativeStage.library(), full = source();
          const expectedBytes = library.reduce((total, item) => total + item.thumb.length * 2, 0);
          CreativeStage.removePreset(first.id); const removedCurrent = source();
          CreativeStage.setPreset({ scene: 'towers' }); const replacedCurrent = source();
          CreativeStage.attachStage(null); const rendererRetired = ledger.snapshot(true);
          const retained = source();
          CreativeStage.library().forEach(item => CreativeStage.removePreset(item.id)); const empty = ledger.snapshot();
          CreativeStage.destroy(); const destroyed = ledger.snapshot();
          return { saved, loaded, libraryIds: library.map(item => item.id), firstId: first.id, full, expectedBytes,
            removedCurrent, replacedCurrent, rendererRetired, retained, empty, destroyed };
        });
        assert.equal(result.saved.length, 1); assert.deepEqual(result.saved, result.loaded);
        assert.equal(result.libraryIds.length, 40); assert.ok(result.libraryIds.includes(result.firstId));
        assert.equal(result.full.length, 40);
        assert.equal(result.full.reduce((sum, entry) => sum + entry.live.ownedCpuBytes, 0), result.expectedBytes);
        assert.equal(result.removedCurrent.length, 40); assert.equal(result.replacedCurrent.length, 39);
        assert.equal(result.rendererRetired.live.gpuContexts, 0); assert.deepEqual(result.retained, result.replacedCurrent);
        assert.equal(result.empty.live.ownedCpuBytes, 2832); assert.equal(result.destroyed.resources, 0); return result;
      } finally { await close(page); }
    });
    await check('snapshot library slots are independent and thumbnail-free metadata survives removal while current uses it', async () => {
      const page = await pageFor();
      try {
        await page.evaluate(() => {
          CreativeStage.destroy();
          harness.originalSnapshot = { current: null, library: [{ id: 'authored', name: 'author data', scene: 'towers',
            bg: { type: 'theme' }, cues: [{ at: 2, set: { 'look.bloom': 0.4 } }] }],
            state: { current: { initialized: true, revision: 0 }, library: { initialized: true, revision: 0 } } };
          VMusicTransport = { get: async () => harness.originalSnapshot, put: async () => ({ revision: 1 }) };
        });
        await page.addScriptTag({ path: path.join(web, 'stage-persistence.js') });
        const result = await page.evaluate(async () => {
          CreativeStage.init(); await CreativeStage.hydrated();
          const ledger = Stage.resources(); CreativeStage.loadPresetById('authored');
          const loaded = ledger.snapshot(true); CreativeStage.removePreset('authored'); await CreativeStage.flushLibrary();
          const removed = { snapshotIds: harness.originalSnapshot.library.map(p => p.id), current: CreativeStage.preset(), ledger: ledger.snapshot(true) };
          CreativeStage.setPreset({ scene: 'orb' }); const replaced = ledger.snapshot(true);
          CreativeStage.destroy(); await CreativeStage.flushPersistence(); StagePersistence.destroy(); return { loaded, removed, replaced, final: ledger.snapshot() };
        });
        assert.deepEqual(result.removed.snapshotIds, ['authored']); assert.equal(result.removed.current.name, 'author data');
        const wrappers = state => state.entries.filter(entry => entry.owner === 'creative-library' && /borrowing/.test(entry.basis.source));
        assert.equal(wrappers(result.loaded).length, 1); assert.equal(wrappers(result.loaded)[0].leases, 1);
        assert.equal(wrappers(result.removed.ledger).length, 1); assert.equal(wrappers(result.replaced).length, 0);
        assert.equal(result.final.resources, 0); return result;
      } finally { await close(page); }
    });
    await check('saved metadata borrows outlive eviction without charging the captured string twice', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(() => {
          const ledger = Stage.resources(), saved = CreativeStage.savePreset('metadata source');
          CreativeStage.loadPresetById(saved.id); CreativeStage.removePreset(saved.id);
          const removed = ledger.snapshot(true), current = CreativeStage.preset();
          CreativeStage.setPreset({ scene: 'orb' }); const replaced = ledger.snapshot(true);
          CreativeStage.destroy(); return { removed, current, replaced, final: ledger.snapshot() };
        });
        const metadata = result.removed.entries.filter(entry => entry.owner === 'creative-library' && /JSON clone/.test(entry.basis.source));
        assert.equal(metadata.length, 1); assert.equal(metadata[0].leases, 1);
        assert.equal(result.current.name, 'metadata source');
        assert.ok(metadata[0].live.ownedCpuBytes < result.current.thumb.length * 2);
        assert.equal(result.removed.entries.filter(entry => entry.owner === 'creative-thumbnail-sources').length, 1);
        assert.equal(result.replaced.entries.filter(entry => entry.owner === 'creative-library').length, 1);
        assert.equal(result.final.resources, 0); return result;
      } finally { await close(page); }
    });
    await check('array growth and shrink reserve coexistence before mutation and preserve the readable library on refusal', async () => {
      const page = await pageFor();
      try {
        const result = await page.evaluate(() => {
          const ledger = Stage.resources(), first = CreativeStage.savePreset('kept'), before = ledger.snapshot(true);
          const pressure = ledger.port('library-pressure').require({ ownedCpuBytes: before.caps.ownedCpuBytes - before.held.ownedCpuBytes }, 'competing owner', 0);
          pressure.commit(); const stringify = JSON.stringify; let copies = 0;
          JSON.stringify = function (...args) { copies++; return stringify.apply(this, args); };
          const failures = [];
          try { CreativeStage.savePreset('refused'); } catch (error) { failures.push(error.message); }
          try { CreativeStage.removePreset(first.id); } catch (error) { failures.push(error.message); }
          JSON.stringify = stringify;
          const refused = { copies, library: CreativeStage.library(), current: CreativeStage.preset(), held: ledger.snapshot() };
          pressure.release({ apiReleased: true, allocationEnded: true });
          CreativeStage.removePreset(first.id); const accepted = ledger.snapshot(); CreativeStage.destroy();
          return { before, failures, firstId: first.id, refused, accepted, final: ledger.snapshot() };
        });
        assert.deepEqual(result.failures, ['aggregate-budget', 'aggregate-budget']); assert.equal(result.refused.copies, 0);
        assert.deepEqual(result.refused.library.map(p => p.id), [result.firstId]);
        assert.equal(result.refused.held.held.ownedCpuBytes, result.refused.held.caps.ownedCpuBytes);
        assert.equal(result.accepted.live.ownedCpuBytes, 2832); assert.equal(result.final.resources, 0); return result;
      } finally { await close(page); }
    });
    await check('partial metadata copy and snapshot restore clean local candidates while retaining the previous library', async () => {
      const page = await pageFor();
      try {
        await page.evaluate(() => {
          CreativeStage.destroy(); harness.receipt = 0;
          VMusicTransport = { get: async () => ({ current: { scene: 'towers', name: ++harness.receipt === 1 ? 'kept' : 'refused' },
            library: [{ id: 'one', scene: 'towers' }, { id: 'two', scene: 'orb' }],
            state: { current: { initialized: true, revision: 0 }, library: { initialized: true, revision: 0 } } }),
            put: async () => ({ revision: 1 }) };
        });
        await page.addScriptTag({ path: path.join(web, 'stage-persistence.js') });
        const result = await page.evaluate(async () => {
          CreativeStage.init(); await CreativeStage.hydrated();
          const ledger = Stage.resources(), before = ledger.snapshot(true), stringify = JSON.stringify;
          JSON.stringify = function () { throw Error('injected clone failure'); };
          let cloneFailure; try { CreativeStage.savePreset('candidate'); } catch (error) { cloneFailure = error.message; }
          JSON.stringify = stringify; const afterClone = ledger.snapshot(true);
          // Fail the original borrowed-source constructor after one wrapper materializes.
          const represent = StageJsonSource.representation;
          StageJsonSource = { ...StageJsonSource, representation(value, ticket, bytes, port, cleanup) {
            if (bytes === 128 && value && value.id && ++harness.wrapperCount === 2) throw Error('injected wrapper failure');
            return represent(value, ticket, bytes, port, cleanup);
          } };
          harness.wrapperCount = 0;
          let restoreFailure; try { await CreativeStage.reloadPersistence(); } catch (error) { restoreFailure = error.message; }
          StageJsonSource = { ...StageJsonSource, representation: represent };
          const afterRestore = { current: CreativeStage.preset(), library: CreativeStage.library(), ledger: ledger.snapshot(true) };
          CreativeStage.destroy(); StagePersistence.destroy();
          return { before, cloneFailure, afterClone, restoreFailure, afterRestore, final: ledger.snapshot() };
        });
        assert.equal(result.cloneFailure, 'injected clone failure'); assert.deepEqual(result.afterClone.held, result.before.held);
        assert.equal(result.restoreFailure, 'injected wrapper failure'); assert.equal(result.afterRestore.current.name, 'kept');
        assert.deepEqual(result.afterRestore.library.map(p => p.id), ['one', 'two']);
        assert.equal(result.afterRestore.ledger.entries.filter(entry => entry.owner === 'creative-library').length, 3);
        assert.equal(result.final.resources, 0); return result;
      } finally { await close(page); }
    });
    await check('twenty recording source leases retain the real GL view through close and release it at their final consumer', async () => {
      const page = await pageFor();
      try {
        const result = await page.evaluate(async () => {
          const baseline = Stage.resources().snapshot(), samples = [];
          for (let i = 0; i < 20; i++) {
            CreativeStage.attachStage(document.getElementById('creative')); await harness.advance(16);
            const surface = CreativeStage.recordingSurface(), first = surface.acquire(), second = surface.acquire();
            const engine = harness.lastEngine, active = Stage.resources().snapshot();
            CreativeStage.attachStage(null); const closed = Stage.resources().snapshot();
            if (engine.resources().disposed || surface.canvas.width === 0 || CreativeStage.recordingSurface()) throw Error('Source retired before recording consumer');
            first.release(); const one = Stage.resources().snapshot();
            second.release(); second.release(); const released = Stage.resources().snapshot();
            samples.push({active,closed,one,released,disposed:engine.resources().disposed});
          } return {baseline,samples};
        });
        for (const sample of result.samples) {
          assert.equal(sample.active.held.gpuContexts, 1); assert.deepEqual(sample.closed.held, sample.active.held);
          assert.deepEqual(sample.one.held, sample.active.held); assert.deepEqual(sample.released.held, result.baseline.held);
          assert.equal(sample.disposed, true);
        } return result;
      } finally { await close(page); }
    });
    await check('recording source size stays fixed until its lease ends then the original measure applies the pending resize', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(() => {
          const surface = CreativeStage.recordingSurface(), lease = surface.acquire(), engine = harness.lastEngine;
          const before = engine.size(), host = document.getElementById('creative'); host.style.width = '760px';
          CreativeStage.remeasure(); const held = engine.size(); lease.release();
          return {before,held,after:engine.size()};
        });
        assert.deepEqual(result.held, result.before); assert.equal(result.after.w, 760); return result;
      } finally { await close(page); }
    });
    await check('inspection capture replaces one source and survives view closure until controller retirement', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(() => {
          const ledger = Stage.resources(); let last = '';
          for (let i = 0; i < 100; i++) last = CreativeStage.capture();
          const active = ledger.snapshot(true), encodedBytes = last.length * 2;
          CreativeStage.attachStage(null); const closed = ledger.snapshot();
          CreativeStage.destroy(); const destroyed = ledger.snapshot();
          let refused = false; try { CreativeStage.setPreset({ scene: 'towers', thumb: last }); } catch (error) { refused = error.message === 'creative-controller-disposed'; }
          const capturedAfterDestroy = CreativeStage.capture(), attachedAfterDestroy = CreativeStage.attachStage(document.getElementById('creative'));
          return { active, encodedBytes, closed, destroyed, refused, capturedAfterDestroy, attachedAfterDestroy, after: ledger.snapshot() };
        });
        assert.equal(result.active.entries.filter(entry => entry.owner === 'creative-thumbnail-sources').length, 1);
        assert.equal(result.closed.live.ownedCpuBytes, 2832 + result.encodedBytes);
        assert.equal(result.destroyed.resources, 0); assert.equal(result.refused, true);
        assert.equal(result.capturedAfterDestroy, null); assert.equal(result.attachedAfterDestroy, false);
        assert.deepEqual(result.after.held, result.destroyed.held); return result;
      } finally { await close(page); }
    });
    await check('controller retirement snapshots pending edits before canceling its save timer', async () => {
      const page = await pageFor();
      try {
        await page.evaluate(() => {
          CreativeStage.destroy(); harness.saved = [];
          VMusicTransport = { get: async () => ({ current: null, library: [], state: { current: { initialized: true, revision: 0 }, library: { initialized: true, revision: 0 } } }),
            put: async (url, request) => { harness.saved.push(JSON.parse(JSON.stringify(request))); return { revision: harness.saved.length }; } };
        });
        await page.addScriptTag({ path: path.join(web, 'stage-persistence.js') });
        const beforeTimer = await page.evaluate(async () => {
          CreativeStage.init(); await CreativeStage.hydrated(); CreativeStage.renamePreset('pending user edit');
          const revision = CreativeStage.revision(), held = Stage.resources().snapshot().held;
          CreativeStage.init(); const repeated = { revision: CreativeStage.revision(), preset: CreativeStage.preset(), held: Stage.resources().snapshot().held };
          CreativeStage.destroy(); await CreativeStage.flushPersistence(); return { revision, held, repeated, saved: harness.saved, after: Stage.resources().snapshot() };
        });
        await page.waitForTimeout(460);
        const afterTimer = await page.evaluate(() => ({ saved: harness.saved, resources: Stage.resources().snapshot() }));
        assert.equal(beforeTimer.saved.length, 1); assert.equal(beforeTimer.saved[0].payload.name, 'pending user edit');
        assert.equal(beforeTimer.repeated.preset.name, 'pending user edit'); assert.equal(beforeTimer.repeated.revision, beforeTimer.revision);
        assert.deepEqual(beforeTimer.repeated.held, beforeTimer.held); assert.equal(beforeTimer.after.resources, 1);
        assert.deepEqual(afterTimer.saved, beforeTimer.saved); assert.equal(afterTimer.resources.resources, 1);
        const documentExit = await page.evaluate(() => { StagePersistence.destroy(); return Stage.resources().snapshot(); });
        assert.equal(documentExit.resources, 0); return { beforeTimer, afterTimer, documentExit };
      } finally { await close(page); }
    });
    await check('refused JSON copy preserves editable latest intent and explicit retry re-admits it', async () => {
      const page = await pageFor();
      try {
        await page.evaluate(() => {
          CreativeStage.destroy(); harness.saved = [];
          VMusicTransport = { get: async () => ({ current: null, library: [], state: { current: { initialized: true, revision: 0 }, library: { initialized: true, revision: 0 } } }),
            put: async (url, request) => { harness.saved.push(JSON.parse(JSON.stringify(request))); return { revision: harness.saved.length }; } };
        });
        await page.addScriptTag({ path: path.join(web, 'stage-persistence.js') });
        const result = await page.evaluate(async () => {
          CreativeStage.init(); await CreativeStage.hydrated();
          const ledger = Stage.resources(), before = ledger.snapshot();
          const pressure = ledger.port('persistence-pressure-fixture').require({ ownedCpuBytes: before.caps.ownedCpuBytes - before.held.ownedCpuBytes - 2048 }, 'independent competing source', 0);
          pressure.commit(); CreativeStage.renamePreset('latest refused edit');
          let refusal = '', prematureRetry = '';
          try { await CreativeStage.flushPersistence(); } catch (error) { refusal = error.message; }
          const refused = { status: StagePersistence.status(), preset: CreativeStage.preset(), writes: harness.saved.length };
          try { await StagePersistence.retry(); } catch (error) { prematureRetry = error.message; }
          pressure.release({ apiReleased: true, allocationEnded: true }); await CreativeStage.retryPersistence();
          const accepted = { status: StagePersistence.status(), saved: harness.saved };
          CreativeStage.destroy(); StagePersistence.destroy();
          return { refusal, prematureRetry, refused, accepted, final: ledger.snapshot() };
        });
        assert.equal(result.refusal, 'aggregate-budget'); assert.match(result.prematureRetry, /最新修改/);
        assert.equal(result.refused.status.current.refused, true); assert.equal(result.refused.status.current.dirty, true);
        assert.equal(result.refused.preset.name, 'latest refused edit'); assert.equal(result.refused.writes, 0);
        assert.equal(result.accepted.saved.length, 1); assert.equal(result.accepted.saved[0].payload.name, 'latest refused edit');
        assert.equal(result.accepted.status.current.refused, false); assert.equal(result.accepted.status.current.error, null);
        assert.equal(result.final.resources, 0); return result;
      } finally { await close(page); }
    });
    await check('one hundred stale hydrate receipts and a stale reload cannot revive retired controller generations', async () => {
      const page = await pageFor();
      try {
        await page.evaluate(() => {
          CreativeStage.destroy(); harness.loads = []; harness.holds = [];
          VMusicTransport = { get: () => new Promise((resolve, reject) => harness.loads.push({ resolve, reject })),
            put: async () => ({ revision: 1 }) };
        });
        await page.addScriptTag({ path: path.join(web, 'stage-persistence.js') });
        const result = await page.evaluate(async () => {
          const ledger = Stage.resources(), receipts = [];
          const snapshot = name => ({ current: { scene: 'towers', name, thumb: 'data:image/jpeg;base64,author-source' },
            library: [{ id: name, scene: 'towers', thumb: 'data:image/jpeg;base64,library-source' }],
            state: { current: { initialized: true, revision: 0 }, library: { initialized: true, revision: 0 } } });
          const hold = StagePersistence.hold; StagePersistence.hold = message => { harness.holds.push(message); hold(message); };
          for (let i = 0; i < 100; i++) {
            CreativeStage.init(); const receipt = CreativeStage.hydrated(); CreativeStage.destroy(); receipts.push(receipt);
          }
          CreativeStage.init(); const current = CreativeStage.hydrated(), baseline = ledger.snapshot();
          const startedBeforeSettlement = harness.loads.length;
          harness.loads[0].reject(Error('late failed load'));
          await Promise.all(receipts); const afterStale = { preset: CreativeStage.preset(), resources: ledger.snapshot(), holds: harness.holds.slice() };
          for (let i = 0; i < 10; i++) await Promise.resolve();
          harness.loads[1].resolve(snapshot('current-generation')); await current;
          const adopted = { preset: CreativeStage.preset(), resources: ledger.snapshot(true) };
          const reload = CreativeStage.reloadPersistence();
          for (let i = 0; i < 10; i++) await Promise.resolve();
          CreativeStage.destroy(); harness.loads[2].resolve(snapshot('retired-reload')); await reload;
          const afterReload = ledger.snapshot(); StagePersistence.destroy();
          return { baseline, startedBeforeSettlement, totalReads: harness.loads.length, afterStale, adopted, afterReload,
            documentExit: ledger.snapshot(), presetAfterReload: CreativeStage.preset() };
        });
        assert.deepEqual(result.afterStale.resources.held, result.baseline.held); assert.equal(result.afterStale.holds.length, 0);
        assert.notEqual(result.afterStale.preset.name, 'stale-0'); assert.equal(result.adopted.preset.name, 'current-generation');
        assert.equal(result.adopted.resources.entries.filter(entry => entry.owner === 'creative-thumbnail-sources').length, 2);
        assert.equal(result.startedBeforeSettlement, 1); assert.equal(result.totalReads, 3);
        assert.equal(result.afterReload.resources, 1); assert.equal(result.documentExit.resources, 0);
        assert.equal(result.presetAfterReload, null); return result;
      } finally { await close(page); }
    });
    await check('raster headers supply dimensions and animation frame counts before decoding', async () => {
      const page = await pageFor();
      try {
        const result = await page.evaluate(() => {
          const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 32;
          const ctx = canvas.getContext('2d'); ctx.fillStyle = '#c56735'; ctx.fillRect(0, 0, 64, 32);
          const bytes = url => Uint8Array.from(atob(url.split(',')[1]), char => char.charCodeAt(0));
          const real = ['image/png', 'image/jpeg', 'image/webp'].map(type => ({ type, plan: StageImageSource.dimensions(bytes(canvas.toDataURL(type))) }));
          const gif = [71,73,70,56,57,97,1,0,1,0,128,0,0,0,0,0,255,255,255];
          const frame = [44,0,0,0,0,1,0,1,0,0,2,2,68,1,0];
          const animation = StageImageSource.dimensions(new Uint8Array([...gif, ...frame, ...frame, 59]));
          const png = bytes(canvas.toDataURL('image/png'));
          png.set([255,255,255,255,255,255,255,255], 16);
          let overflow = false; try { StageImageSource.dimensions(png); } catch (_) { overflow = true; }
          canvas.width = canvas.height = 0; return { real, animation, overflow };
        });
        for (const { plan } of result.real) { assert.equal(plan.width, 64); assert.equal(plan.height, 32); assert.equal(plan.frames, 1); }
        assert.equal(result.animation.frames, 2); assert.equal(result.animation.workBytes, 16); assert.equal(result.overflow, true);
        return result;
      } finally { await close(page); }
    });
    await check('real PNG JPEG and WebP decode reserve before src and release their separate encoded sources', async () => {
      const page = await pageFor();
      try {
        const result = await page.evaluate(async () => {
          const ledger = Stage.resources(), baseline = ledger.snapshot(), results = [], assigned = [];
          const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
          Object.defineProperty(HTMLImageElement.prototype, 'src', { ...src, set(value) { assigned.push(ledger.snapshot()); src.set.call(this, value); } });
          const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 32;
          canvas.getContext('2d').fillRect(0, 0, 64, 32);
          for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
            const url = canvas.toDataURL(type), source = await StageImageSource.decode(url, { resources: ledger.port('raster-' + type) });
            const active = ledger.snapshot(); source.release(); source.release();
            results.push({ type, encodedBytes: url.length * 2, active, after: ledger.snapshot() });
          }
          Object.defineProperty(HTMLImageElement.prototype, 'src', src); canvas.width = canvas.height = 0;
          return { baseline, assigned, results };
        });
        assert.equal(result.assigned.length, 3);
        for (const beforeSrc of result.assigned) { assert.equal(beforeSrc.held.decoderLeases, 1); assert.equal(beforeSrc.pending.decodeReservedBytes, 64 * 32 * 4 * 3); }
        for (const sample of result.results) {
          assert.equal(sample.active.live.ownedCpuBytes - result.baseline.live.ownedCpuBytes, sample.encodedBytes);
          assert.equal(sample.active.live.decodeReservedBytes, 64 * 32 * 4 * 3);
          assert.deepEqual(sample.after.held, result.baseline.held);
        } return result;
      } finally { await close(page); }
    });
    await check('canceled image decode retains its unresolved source and decoder tickets until settlement', async () => {
      const page = await pageFor();
      try {
        await page.evaluate(() => {
          const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 32;
          harness.rasterUrl = canvas.toDataURL(); canvas.width = canvas.height = 0;
          const decode = HTMLImageElement.prototype.decode;
          HTMLImageElement.prototype.decode = async function () { await decode.call(this); return new Promise(resolve => { harness.endRasterDecode = resolve; }); };
          harness.rasterBaseline = Stage.resources().snapshot(); harness.rasterAbort = new AbortController();
          harness.rasterPending = StageImageSource.decode(harness.rasterUrl, { resources: Stage.resources().port('raster-cancel'), signal: harness.rasterAbort.signal })
            .then(source => { source.release(); return 'unexpected success'; }, error => error.name);
        });
        await page.waitForFunction(() => !!harness.endRasterDecode);
        const result = await page.evaluate(async () => {
          const ledger = Stage.resources(), pending = ledger.snapshot(true); harness.rasterAbort.abort();
          const canceled = ledger.snapshot(true); harness.endRasterDecode(); const outcome = await harness.rasterPending;
          return { baseline: harness.rasterBaseline, pending, canceled, outcome, after: ledger.snapshot() };
        });
        assert.equal(result.pending.held.decoderLeases, 1); assert.deepEqual(result.pending.held, result.canceled.held);
        assert.ok(result.canceled.entries.filter(entry => entry.owner === 'raster-cancel').every(entry => entry.cancelled));
        assert.equal(result.outcome, 'AbortError'); assert.deepEqual(result.after.held, result.baseline.held); return result;
      } finally { await close(page); }
    });
    await check('palette decoder refusal and unknown raster formats assign no image source', async () => {
      const page = await pageFor({ decodeReservedBytes: 0 });
      try {
        const result = await page.evaluate(async () => {
          const ledger = Stage.resources(), baseline = ledger.snapshot(), canvas = document.createElement('canvas');
          canvas.width = 64; canvas.height = 32; const url = canvas.toDataURL(); canvas.width = canvas.height = 0;
          const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src'); let assigned = 0;
          Object.defineProperty(HTMLImageElement.prototype, 'src', { ...src, set(value) { assigned++; src.set.call(this, value); } });
          const failures = [];
          for (const value of [url, 'data:image/svg+xml;base64,PHN2Zy8+']) {
            try { await StageImageSource.decode(value, { resources: ledger.port('raster-refusal') }); } catch (error) { failures.push(error.message); }
          }
          Object.defineProperty(HTMLImageElement.prototype, 'src', src);
          return { baseline, assigned, failures, after: ledger.snapshot() };
        });
        assert.equal(result.assigned, 0); assert.deepEqual(result.failures, ['aggregate-budget', 'estimate-unavailable']);
        assert.deepEqual(result.after.held, result.baseline.held); return result;
      } finally { await close(page); }
    });
    await check('Stage theme sampling cleans all surfaces and retains the last palette when a candidate has no bound', async () => {
      const page = await pageFor();
      try {
        await page.evaluate(() => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
          const ctx = canvas.getContext('2d'); ctx.fillStyle = '#c56735'; ctx.fillRect(0, 0, 64, 64);
          harness.paletteUrl = canvas.toDataURL(); canvas.width = canvas.height = 0;
          harness.paletteBaseline = Stage.resources().snapshot(); Stage.setCoverFollow(true);
          Stage.setTrack({ id: 'palette-first' }, harness.paletteUrl);
        });
        await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--music-highlight-rgb').length > 0);
        const result = await page.evaluate(async () => {
          const ledger = Stage.resources(), active = ledger.snapshot(), prior = document.documentElement.style.getPropertyValue('--music-highlight-rgb');
          Stage.setTrack({ id: 'palette-refused' }, 'data:image/svg+xml;base64,PHN2Zy8+');
          for (let i = 0; i < 20; i++) await Promise.resolve();
          return { baseline: harness.paletteBaseline, active, prior, after: ledger.snapshot(true),
            current: document.documentElement.style.getPropertyValue('--music-highlight-rgb') };
        });
        assert.deepEqual(result.active.held, result.baseline.held); assert.deepEqual(result.after.held, result.baseline.held);
        assert.equal(result.current, result.prior);
        assert.equal(result.after.hosts.find(host => host.owner === 'stage-cover-palette').state, 'retained'); return result;
      } finally { await close(page); }
    });
    await check('Backgrounds palette uses bounded sources, defers hidden work and stops retrying failed candidates', async () => {
      const page = await pageFor();
      try {
        await page.evaluate(() => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
          const ctx = canvas.getContext('2d'); ctx.fillStyle = '#bc4b38'; ctx.fillRect(0, 0, 32, 64);
          ctx.fillStyle = '#307e59'; ctx.fillRect(32, 0, 32, 64); harness.paletteUrl = canvas.toDataURL(); canvas.width = canvas.height = 0;
          Backgrounds.apply({ type: 'cover' }); Backgrounds.setCover(harness.paletteUrl); Backgrounds.palette();
        });
        await page.waitForFunction(() => Stage.resources().snapshot().held.decoderLeases === 0);
        const result = await page.evaluate(async () => {
          const ledger = Stage.resources(), prior = Backgrounds.palette(), baseline = ledger.snapshot();
          harness.hide(true); Backgrounds.setCover('data:image/svg+xml;base64,PHN2Zy8+'); Backgrounds.palette();
          const hidden = ledger.snapshot(); harness.hide(false); Backgrounds.palette();
          for (let i = 0; i < 20; i++) await Promise.resolve();
          const failed = ledger.snapshot(true), fallback = Backgrounds.palette();
          const rejections = failed.rejections; for (let i = 0; i < 100; i++) Backgrounds.stats();
          await harness.advance(100); const afterIdle = ledger.snapshot(); Backgrounds.destroy();
          return { prior, baseline, hidden, failed, fallback, rejections, afterIdle, destroyed: ledger.snapshot() };
        });
        assert.deepEqual(result.hidden.held, result.baseline.held); assert.deepEqual(result.fallback, result.prior);
        assert.equal(result.failed.hosts.find(host => host.owner === 'backgrounds').state, 'retained');
        assert.equal(result.afterIdle.rejections, result.rejections); assert.equal(result.destroyed.live.ownedCpuBytes, 2832);
        assert.equal(result.destroyed.held.decoderLeases, 0); return result;
      } finally { await close(page); }
    });
    await check('bounded HTTP source reads materialize encoded coexistence and reject a lying length before decode', async () => {
      const page = await pageFor();
      try {
        const result = await page.evaluate(async () => {
          const ledger = Stage.resources(), baseline = ledger.snapshot(), canvas = document.createElement('canvas');
          canvas.width = 64; canvas.height = 32;
          const png = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), char => char.charCodeAt(0)); canvas.width = canvas.height = 0;
          const originalFetch = fetch;
          fetch = async () => new Response(new Blob([png], { type: 'image/png' }).stream(), { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
          const source = await StageImageSource.decode('http://source.fixture/cover', { resources: ledger.port('http-raster'), maxEncodedBytes: png.length * 2 });
          const active = ledger.snapshot(); source.release(); const after = ledger.snapshot();
          fetch = async () => new Response(new Blob([png]).stream(), { headers: { 'content-type': 'image/png', 'content-length': '1' } });
          let failure = null; try { await StageImageSource.decode('http://source.fixture/lie', { resources: ledger.port('http-raster-lie') }); } catch (error) { failure = error.message; }
          fetch = originalFetch;
          return { baseline, pngBytes: png.length, active, after, failure, afterLie: ledger.snapshot() };
        });
        assert.equal(result.active.live.ownedCpuBytes - result.baseline.live.ownedCpuBytes, result.pngBytes * 3);
        assert.deepEqual(result.after.held, result.baseline.held); assert.deepEqual(result.afterLie.held, result.baseline.held);
        assert.equal(result.failure, 'encoded raster exceeds declared source plan'); return result;
      } finally { await close(page); }
    });
    await check('background refusal allocates no canvas and hand paper retains only its encoded source', async () => {
      const refused = await pageFor({ canvases: 0 });
      try {
        const result = await refused.evaluate(() => {
          const baseline = Stage.resources().snapshot(); Backgrounds.apply({ type: 'flow' });
          return { baseline, after: Stage.resources().snapshot(), canvas: !!document.getElementById('creative-bg-canvas'), values: Backgrounds.values() };
        });
        assert.deepEqual(result.after.held, result.baseline.held); assert.equal(result.canvas, false); assert.equal(result.values.type, 'flow');
      } finally { await close(refused); }
      const page = await pageFor();
      try {
        const result = await page.evaluate(() => {
          const ledger = Stage.resources(), baseline = ledger.snapshot(); HandDrawn.setStageHost(document.getElementById('creative'));
          HandDrawn.apply({ on: true, paper: true }); const active = ledger.snapshot(), stats = HandDrawn.stats();
          HandDrawn.destroy(); return { baseline, active, stats, after: ledger.snapshot() };
        });
        assert.equal(result.stats.hasPaper, true); assert.equal(result.active.live.canvases, result.baseline.live.canvases);
        assert.ok(result.active.live.ownedCpuBytes > result.baseline.live.ownedCpuBytes);
        assert.equal(result.after.live.ownedCpuBytes, result.baseline.live.ownedCpuBytes); return result;
      } finally { await close(page); }
    });
  } finally {
    await browser.close(); report.finishedAt = new Date().toISOString(); report.sourceSha256After = digest();
    report.sourceUnchanged = JSON.stringify(report.sourceSha256) === JSON.stringify(report.sourceSha256After);
    report.passed = report.sourceUnchanged && !report.errors.length && report.checks.every(check => check.passed);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log('Evidence: ' + out);
    if (!report.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
