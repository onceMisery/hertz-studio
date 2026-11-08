'use strict';
// Production Space navigation, Stage gates and shared renderer in real Chrome.
// Controlled time proves contracts; it does not qualify hardware or embedded assets.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), web = path.join(root, 'plugin/ui');
const sources = ['stage-resource-budget.js', 'stage-resource-policy.js', 'stage-image-source.js', 'stage.js', 'onset.js',
  'vendor/stage-runtime.js', 'vendor/space-stage.js', 'space-camera.js', 'space3d.js'];
const out = path.join(root, 'output/a09-m1-20261108/space-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), checks: [], errors: [],
  sourceSha256: Object.fromEntries([...sources, 'index.html', 'space3d.css', 'design/design-base.css', 'style.css'].map(file => [file,
    crypto.createHash('sha256').update(fs.readFileSync(path.join(web, file))).digest('hex')])),
  scope: 'Production Space host phase/input/navigation, renderer context/surface, post/text pool and original scope buffer admission. Complete scene/program/cover-pool coverage and hardware qualification remain open.' };
let browser;
async function pageFor(caps = {}) {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  page.on('pageerror', error => report.errors.push(error.stack));
  await page.route('**/*', route => route.abort());
  const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
  await page.setContent(html);
  await page.addStyleTag({ path: path.join(web, 'space3d.css') });
  await page.evaluate(() => {
    const h = window.harness = { time: 100, hidden: false, next: 0, callbacks: new Map(), contexts: 0,
      attempts: 0, programCreates: 0, frames: [], lyricPositions: [], engines: [], created: 0, disposed: 0 };
    performance.now = () => h.time;
    requestAnimationFrame = fn => { h.callbacks.set(++h.next, fn); return h.next; };
    cancelAnimationFrame = id => h.callbacks.delete(id);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h.hidden });
    const get = HTMLCanvasElement.prototype.getContext, seen = new WeakSet();
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (/webgl/.test(type)) h.attempts++;
      const value = get.call(this, type, ...args);
      if (value && /webgl/.test(type) && !seen.has(value)) {
        h.contexts++; seen.add(value); h.gl = value;
        const createProgram = value.createProgram.bind(value);
        value.createProgram = () => { h.programCreates++; return createProgram(); };
      }
      return value;
    };
    h.advance = async (count, delta = 1000 / 60) => {
      for (let i = 0; i < count; i++) {
        h.time += delta; const callbacks = [...h.callbacks.values()]; h.callbacks.clear();
        callbacks.forEach(fn => fn(h.time)); await Promise.resolve();
      }
    };
    h.hide = value => { h.hidden = value; document.dispatchEvent(new Event('visibilitychange')); };
  });
  for (const source of sources) {
    if (source === 'space3d.js') await page.evaluate(() => {
      SpaceStagePure.register({ apiVersion: 1, id: 'm1-space-contract', stateVersion: 1,
        label: 'Space contract', category: 'world', preview: '/contract.webp', aliases: [],
        params: { scale: { type: 'number', min: .5, max: 2, default: 1, step: .1 } },
        camera: { radius: 6 }, capabilities: { interaction: true, threejs: true }, quality: {},
        create(ctx) {
          harness.created++;
          const geometry = ctx.scope.track(new ctx.THREE.BoxGeometry(2, 2, 2));
          const material = ctx.scope.track(new ctx.THREE.MeshNormalMaterial());
          const mesh = new ctx.THREE.Mesh(geometry, material); ctx.scene.add(mesh);
          return { update(frame) { mesh.rotation.y = frame.sceneTime || 0; },
            setParams(params) { mesh.scale.setScalar(params.scale); }, dispose() { harness.disposed++; } };
        } });
      const create = SpaceStagePure.create;
      SpaceStagePure = { ...SpaceStagePure, create: (canvas, options) => {
        const engine = create(canvas, options), submit = engine.frame;
        engine.frame = frame => {
          const copy = { now: frame.now, dt: frame.dt, time: frame.time, position: frame.position,
            sceneTime: frame.sceneTime, energy: frame.level, onset: frame.onset,
            spectrum: Array.from(frame.bands || []), stageVisible: Stage.frameState().stageVisible };
          const ok = submit(frame); harness.frames.push({ ...copy, ok }); return ok;
        };
        harness.engines.push(engine); return engine;
      } };
    });
    await page.addScriptTag({ path: path.join(web, source) });
    if (source === 'stage-resource-policy.js') await page.evaluate(caps => {
      StageResourcePolicy = Object.freeze({ ...StageResourcePolicy, qualification: 'contract-test-only',
        caps: Object.freeze({ ...StageResourcePolicy.caps, ...caps }) });
    }, caps);
  }
  await page.evaluate(() => {
    Stage.init(); Stage.setTrack({ id: 'm1-space', duration_ms: 200000, title: 'Space contract' });
    const lyrics = Stage.lyrics;
    Stage.lyrics = position => { harness.lyricPositions.push(position); return lyrics(position); };
    harness.snapshot = (playing, position = Stage.position(), seek = false) => {
      document.body.classList.toggle('is-playing', playing);
      Stage.setSnapshot({ playing, track_id: 'm1-space', duration_ms: 200000, position_ms: position }, { seek });
    };
    harness.snapshot(false, 0); Space3D.init();
    Space3D.configure({ sceneSource: 'm1-space-contract', qualityMode: 'low', cinema: false,
      playerAutoHide: false, immersiveFx: 'none' });
  });
  return page;
}
async function mount(page) {
  await page.evaluate(async () => {
    Space3D.open('m1-space-contract'); await harness.advance(12);
    await Space3D.enterStage('m1-space-contract'); await harness.advance(12);
  });
  assert.equal(await page.evaluate(() => Space3D.stats().renderer?.id), 'm1-space-contract');
  const diagnostic = await page.evaluate(() => ({ frames: harness.frames, state: Space3D.stats(), gates: Stage.gateRates(),
    layout: { width: document.getElementById('space3d').clientWidth, height: document.getElementById('space3d').clientHeight }, callbacks: harness.callbacks.size }));
  assert.ok(diagnostic.frames.some(frame => frame.ok), JSON.stringify(diagnostic));
}
async function close(page) { await page.evaluate(() => { Space3D.close(); Stage.destroy(); }); await page.close(); }
async function check(name, fn) {
  try { const evidence = await fn(); report.checks.push({ name, passed: true, evidence }); console.log('PASS ' + name); }
  catch (error) { report.checks.push({ name, passed: false, error: error.stack }); console.error('FAIL ' + name + ': ' + error.message); }
}
async function main() {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    await check('context refusal precedes getContext and clears caller CPU/canvas resources', async () => {
      const page = await pageFor({ gpuContexts: 0 });
      try {
        const result = await page.evaluate(async () => {
          const baseline = Stage.resources().snapshot(); Space3D.open('m1-space-contract'); await Space3D.enterStage('m1-space-contract'); await harness.advance(18);
          return { baseline, after: Stage.resources().snapshot(), attempts: harness.attempts,
            state: Space3D.stats().state, text: document.getElementById('sp-error-message').textContent,
            canvases: document.querySelectorAll('#sp-canvas canvas').length };
        });
        assert.equal(result.attempts, 0); assert.equal(result.canvases, 0); assert.ok(result.text.includes('aggregate-budget'), JSON.stringify(result));
        assert.deepEqual(result.after.held, result.baseline.held); return result;
      } finally { await close(page); }
    });
    await check('twenty home/stage handoffs preserve renderer, instance and continuously advancing phase', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(async () => {
          harness.snapshot(true); await harness.advance(12);
          const canvas = document.querySelector('#sp-canvas canvas'), engine = harness.engines[0], samples = [];
          const created = harness.created, contexts = harness.contexts;
          for (let i = 0; i < 20; i++) {
            const before = Space3D.stats().sceneTimeMs; Space3D.goHome(); await harness.advance(6);
            const home = Space3D.stats().sceneTimeMs; await Space3D.enterStage('m1-space-contract'); await harness.advance(6);
            samples.push({ before, home, stage: Space3D.stats().sceneTimeMs,
              sameCanvas: canvas === document.querySelector('#sp-canvas canvas'), sameEngine: engine === harness.engines.at(-1) });
          }
          return { samples, created, afterCreated: harness.created, contexts, afterContexts: harness.contexts,
            stageVisible: Stage.frameState().stageVisible, renders: harness.frames.filter(frame => frame.ok).length };
        });
        for (const item of result.samples) { assert.ok(item.sameCanvas && item.sameEngine); assert.ok(item.home > item.before && item.stage > item.home); }
        assert.equal(result.created, result.afterCreated); assert.equal(result.contexts, result.afterContexts);
        assert.equal(result.stageVisible, false); assert.ok(result.renders > 20); return result;
      } finally { await close(page); }
    });
    await check('pause, hidden sixty seconds, seek, reduced motion and zero layout freeze geometry with resume delta zero', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(async () => {
          const phase = () => Space3D.stats().sceneTimeMs, firstResume = async () => {
            const start = harness.frames.length; await harness.advance(6); return harness.frames.slice(start)[0]?.dt;
          };
          harness.snapshot(true); await harness.advance(20); const moving = phase();
          harness.snapshot(false); await harness.advance(12); const paused = phase();
          harness.hide(true); harness.time += 60000; await harness.advance(6); const hidden = phase();
          harness.snapshot(false, 90000, true); harness.hide(false); await harness.advance(6); const sought = phase();
          const media = harness.frames.at(-1), lyricPosition = harness.lyricPositions.at(-1);
          harness.snapshot(true); const resumedDt = await firstResume(); const resumed = phase();
          Stage.setReducedMotion(true); await harness.advance(12); const reduced = phase();
          await harness.advance(24); const reducedEnd = phase();
          Stage.setReducedMotion(false); const reducedResumeDt = await firstResume();
          const root = document.getElementById('space3d'), beforeZero = phase(); root.style.display = 'none';
          window.dispatchEvent(new Event('resize')); await harness.advance(18); const zero = phase();
          root.style.display = ''; window.dispatchEvent(new Event('resize')); const zeroResumeDt = await firstResume();
          return { moving, paused, hidden, sought, media, lyricPosition, resumedDt, resumed, reduced, reducedEnd,
            reducedResumeDt, beforeZero, zero, zeroResumeDt };
        });
        assert.ok(result.moving > 0); assert.equal(result.paused, result.moving); assert.equal(result.hidden, result.paused);
        assert.equal(result.sought, result.hidden); assert.equal(result.media.position, 90000); assert.equal(result.lyricPosition, 90000);
        assert.equal(result.resumedDt, 0); assert.ok(result.resumed > result.sought); assert.equal(result.reduced, result.reducedEnd);
        assert.equal(result.reducedResumeDt, 0); assert.equal(result.beforeZero, result.zero); assert.equal(result.zeroResumeDt, 0); return result;
      } finally { await close(page); }
    });
    await check('stale spectra are neutral and resume waits for a post-suspension revision while media still relocates', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(async () => {
          const signal = () => Stage.setSpectrum(new Float32Array(64).fill(.65));
          harness.snapshot(true); signal(); await harness.advance(6); const fresh = harness.frames.at(-1);
          harness.snapshot(false); await harness.advance(6); harness.hide(true); signal(); harness.time += 60000;
          harness.hide(false); harness.snapshot(true, 120000, true); await harness.advance(6); const restored = harness.frames.at(-1);
          signal(); await harness.advance(6); const newSignal = harness.frames.at(-1);
          await harness.advance(42); const expired = harness.frames.at(-1);
          const container = document.getElementById('space3d'); container.style.display = 'none'; dispatchEvent(new Event('resize'));
          signal(); await harness.advance(3); container.style.display = ''; dispatchEvent(new Event('resize')); await harness.advance(6);
          const zeroResume = harness.frames.at(-1); signal(); await harness.advance(6); const zeroNewSignal = harness.frames.at(-1);
          return { fresh, restored, newSignal, expired, zeroResume, zeroNewSignal };
        });
        assert.ok(result.fresh.energy > .6); assert.equal(result.restored.energy, 0); assert.equal(result.restored.onset, 0);
        assert.ok(result.restored.position >= 120000); assert.ok(result.newSignal.energy > .6);
        assert.equal(result.expired.energy, 0); assert.equal(result.expired.onset, 0);
        assert.equal(result.zeroResume.energy, 0, JSON.stringify(result.zeroResume)); assert.equal(result.zeroResume.onset, 0); assert.ok(result.zeroNewSignal.energy > .6); return result;
      } finally { await close(page); }
    });
    await check('surface replacement reserves old plus new and refused shrink retains its current surface', async () => {
      const page = await pageFor();
      try {
        const result = await page.evaluate(() => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 0;
          canvas.style.cssText = 'width:200px;height:100px'; document.body.appendChild(canvas);
          const ledger = Stage.resources(), port = ledger.port('space-surface-test'), reservations = [], require = port.require;
          const observed = Object.assign({}, port, { require(vector, ...args) {
            reservations.push({ vector, held: ledger.snapshot().held }); return require.call(port, vector, ...args);
          } });
          const engine = SpaceStagePure.create(canvas, { resources: observed, qualityMode: 'low', deviceTier: 2 });
          engine.resize(400, 200); const before = { width: canvas.width, height: canvas.height, resources: ledger.snapshot() };
          const blocker = ledger.port('surface-competitor').require({ drawingBufferPixels:
            ledger.snapshot().caps.drawingBufferPixels - before.resources.held.drawingBufferPixels - 1 }, 'competitor', 0);
          blocker.commit(); const accepted = engine.resize(100, 50), after = { width: canvas.width, height: canvas.height, stats: engine.stats() };
          blocker.release({ apiReleased: true, allocationEnded: true }); engine.dispose(); canvas.remove();
          return { reservations, before, accepted, after, final: ledger.snapshot() };
        });
        assert.equal(result.accepted, false); assert.equal(result.after.width, result.before.width); assert.equal(result.after.height, result.before.height);
        assert.ok(result.reservations.some(item => item.vector.drawingBufferPixels > 0 && item.held.drawingBufferPixels > 0));
        assert.equal(result.final.held.gpuContexts, 0); assert.equal(result.final.held.drawingBufferPixels, 0); return result;
      } finally { await close(page); }
    });
    await check('serial target preflight preserves the old scene and phase on refusal, then explicit retry retires it before allocation', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        await page.evaluate(async () => {
          const def = SpaceStagePure.catalog().find(item => item.id === 'm1-space-contract');
          harness.serialCreates = []; harness.serialDisposals = [];
          for (const [id, bytes] of [['m1-serial-small', 319992], ['m1-serial-large', 999996]]) SpaceStagePure.register({
            ...def, id, resourcePlan: () => ({ ownedCpuBytes: bytes, bufferDeclaredBytes: bytes }),
            create(ctx) {
              harness.serialCreates.push({ id, priorDisposals: harness.serialDisposals.slice() });
              const plan = ctx.scope.bufferPlan(bytes, bytes, 'serial fixture position arrays');
              const array = new Float32Array(bytes / 4); plan.cpuReady(bytes);
              const geometry = ctx.scope.track(new ctx.THREE.BufferGeometry()); geometry.setAttribute('position', plan.upload(new ctx.THREE.BufferAttribute(array, 3)));
              const material = ctx.scope.track(new ctx.THREE.PointsMaterial()); ctx.scene.add(new ctx.THREE.Points(geometry, material));
              return { update() {}, dispose() { harness.serialDisposals.push(id); } };
            }
          });
          await Space3D.setSource('m1-serial-small'); harness.snapshot(true); await harness.advance(12);
          const ledger = Stage.resources(), before = ledger.snapshot(); harness.serialBefore = { ledger: ledger.snapshot(true), stats: Space3D.stats(), contexts: harness.contexts };
          harness.serialBlocker = ledger.port('serial-competition').require({ ownedCpuBytes: before.caps.ownedCpuBytes - before.held.ownedCpuBytes - 100000 }, 'competing CPU capacity', 0);
          await Space3D.setSource('m1-serial-large'); await harness.advance(12);
        });
        const refused = await page.evaluate(() => ({ before: harness.serialBefore, stats: Space3D.stats(), creates: harness.serialCreates, disposals: harness.serialDisposals, contexts: harness.contexts,
          notice: !document.getElementById('sp-resource-status').hidden }));
        assert.equal(refused.stats.renderer?.id, 'm1-serial-small', JSON.stringify(refused.stats)); assert.equal(refused.stats.renderer.state, 'ready');
        assert.equal(refused.creates.length, 1); assert.deepEqual(refused.disposals, []); assert.equal(refused.contexts, refused.before.contexts);
        assert.ok(refused.stats.sceneTimeMs > refused.before.stats.sceneTimeMs); assert.equal(refused.stats.source, 'm1-serial-large'); assert.equal(refused.notice, true);
        const authored = await page.evaluate(async () => {
          await Space3D.setSource('cover-particles'); await harness.advance(12);
          return { stats: Space3D.stats(), contexts: harness.contexts, disposals: harness.serialDisposals.slice() };
        });
        assert.equal(authored.stats.renderer?.id, 'm1-serial-small', JSON.stringify(authored.stats));
        assert.deepEqual(authored.disposals, []); assert.equal(authored.contexts, refused.contexts);
        const retried = await page.evaluate(async () => {
          await Space3D.setSource('m1-serial-large'); harness.serialBlocker.release({ apiReleased: true, allocationEnded: true }); document.querySelector('#sp-resource-status button').click();
          await harness.advance(12); return { stats: Space3D.stats(), creates: harness.serialCreates, disposals: harness.serialDisposals, contexts: harness.contexts };
        });
        assert.equal(retried.stats.renderer?.id, 'm1-serial-large'); assert.equal(retried.creates.length, 2);
        assert.deepEqual(retried.creates[1].priorDisposals, ['m1-serial-small']); assert.equal(retried.contexts, refused.contexts); return { refused, authored, retried };
      } finally { await close(page); }
    });
    await check('post RTs are admitted before first render, preserve old replacement peaks and do not retry rejection each frame', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(async () => {
          const engine = harness.engines.at(-1), ledger = Stage.resources(), baseline = ledger.snapshot(true);
          harness.snapshot(true);
          engine.setServices({ post: { grain: 10 } }); engine.setParams({ scale: 1 });
          const block = () => {
            const snap = ledger.snapshot(); const ticket = ledger.port('post-competitor').require({ renderTargetDeclaredBytes:
              snap.caps.renderTargetDeclaredBytes - snap.held.renderTargetDeclaredBytes - 1 }, 'post competitor', 0);
            ticket.commit(); return ticket;
          };
          let blocker = block(); await harness.advance(12); const refused = { stats: engine.stats(), resources: ledger.snapshot() };
          await harness.advance(30); const noRetry = ledger.snapshot().rejections;
          blocker.release({ apiReleased: true, allocationEnded: true });
          engine.setParams({ scale: 1 }); await harness.advance(12); const active = ledger.snapshot(true), activeStats = engine.stats();
          engine.resize(200, 100); blocker = block(); await harness.advance(12);
          const refusedShrink = { stats: engine.stats(), resources: ledger.snapshot(true) };
          blocker.release({ apiReleased: true, allocationEnded: true });
          engine.setParams({ scale: 1 }); await harness.advance(12); const resized = ledger.snapshot(true);
          Space3D.close(); return { baseline, refused, noRetry, active, activeStats, refusedShrink, resized, closed: ledger.snapshot() };
        });
        const targets = snap => snap.entries.filter(entry => /Space post RGBA8/.test(entry.basis.source));
        assert.equal(targets(result.baseline).length, 0); assert.equal(result.refused.stats.postResourceFailure, 'aggregate-budget');
        assert.equal(result.refused.stats.state, 'ready'); assert.equal(result.refused.resources.rejections, result.noRetry);
        assert.equal(targets(result.active).length, 1, JSON.stringify(result)); assert.equal(result.activeStats.postResourceFailure, '');
        assert.deepEqual(targets(result.refusedShrink.resources).map(entry => entry.live), targets(result.active).map(entry => entry.live));
        assert.ok(targets(result.resized)[0].live.renderTargetDeclaredBytes < targets(result.active)[0].live.renderTargetDeclaredBytes);
        assert.equal(result.closed.held.gpuContexts, 0); assert.equal(result.closed.held.renderTargetDeclaredBytes, 0);
        return result;
      } finally { await close(page); }
    });
    await check('text pool consumers share an admitted source and context upload until the final scope releases its lease', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(async () => {
          const def = SpaceStagePure.catalog().find(item => item.id === 'm1-space-contract'), engine = harness.engines.at(-1);
          harness.textLeases = [];
          const create = ctx => {
            const pool = ctx.services.spatialResources, lease = pool.text.acquire('共享文字源与独立上传', 'sans-serif', 1792);
            harness.textLeases.push(lease); ctx.scope.lease({ release() { pool.text.release(lease); } });
            const geometry = ctx.scope.track(new ctx.THREE.PlaneGeometry(4, 2));
            const material = ctx.scope.track(new ctx.THREE.MeshBasicMaterial({ transparent: true }));
            ctx.scene.add(new ctx.THREE.Mesh(geometry, material));
            return { update() { if (lease.texture && material.map !== lease.texture) { material.map = lease.texture; material.needsUpdate = true; } }, dispose() {} };
          };
          SpaceStagePure.register({ ...def, id: 'm1-space-text-world', create });
          SpaceStagePure.register({ ...def, id: 'm1-space-text-lyric', capabilities: { ...def.capabilities, ownsLyrics: true }, create });
          await engine.select('m1-space-text-world'); await engine.selectLyrics('m1-space-text-lyric');
          const pending = Stage.resources().snapshot(true); harness.snapshot(true); await harness.advance(12);
          const active = Stage.resources().snapshot(true), sameTexture = harness.textLeases[0].texture === harness.textLeases[1].texture;
          await engine.select('m1-space-contract'); await harness.advance(6);
          const one = Stage.resources().snapshot(true), surviving = !!harness.textLeases[1].texture;
          await engine.selectLyrics(null); const none = Stage.resources().snapshot(true);
          Space3D.close(); return { pending, active, sameTexture, one, surviving, none, closed: Stage.resources().snapshot() };
        });
        const text = snap => snap.entries.filter(entry => /Space text pool/.test(entry.basis.source));
        assert.equal(text(result.pending).length, 1); assert.ok(text(result.pending)[0].pending.canvases === 1);
        assert.equal(text(result.active).length, 2); assert.ok(result.sameTexture);
        assert.ok(text(result.active).some(entry => entry.live.textureDeclaredBytes > 0));
        assert.equal(text(result.one).length, 2); assert.ok(result.surviving); assert.equal(text(result.none).length, 0);
        assert.equal(result.closed.held.textureDeclaredBytes, 0); assert.equal(result.closed.pending.ownedCpuBytes, 0); return result;
      } finally { await close(page); }
    });
    await check('cover pool shares one admitted crop and real mip upload across scene and lyric consumers', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        await page.evaluate(async () => {
          const source = document.createElement('canvas'); source.width = 96; source.height = 64;
          source.getContext('2d').fillRect(0, 0, 96, 64); harness.coverUrl = source.toDataURL(); source.width = source.height = 0;
          const def = SpaceStagePure.catalog().find(item => item.id === 'm1-space-contract'), engine = harness.engines.at(-1);
          harness.coverLeases = [];
          const create = ctx => {
            const pool = harness.coverPool = ctx.services.spatialResources, lease = pool.cover.acquire(harness.coverUrl);
            harness.coverLeases.push(lease); ctx.scope.lease({ release() { pool.cover.release(lease); } });
            const material = ctx.scope.track(new ctx.THREE.MeshBasicMaterial());
            const geometry = ctx.scope.track(new ctx.THREE.PlaneGeometry(4, 2)); ctx.scene.add(new ctx.THREE.Mesh(geometry, material));
            return { update() { if (lease.texture && material.map !== lease.texture) { material.map = lease.texture; material.needsUpdate = true; } }, dispose() {} };
          };
          SpaceStagePure.register({ ...def, id: 'm1-cover-world', create });
          SpaceStagePure.register({ ...def, id: 'm1-cover-lyric', capabilities: { ...def.capabilities, ownsLyrics: true }, create });
          await engine.select('m1-cover-world'); await engine.selectLyrics('m1-cover-lyric');
        });
        await page.waitForFunction(() => harness.coverLeases.every(lease => lease.texture));
        const result = await page.evaluate(async () => {
          const ledger = Stage.resources(), pending = ledger.snapshot(true), engine = harness.engines.at(-1);
          const same = harness.coverLeases[0].texture === harness.coverLeases[1].texture;
          harness.snapshot(true); await harness.advance(12); const active = ledger.snapshot(true);
          await engine.select('m1-space-contract'); await harness.advance(6); const one = ledger.snapshot(true);
          const surviving = !!harness.coverLeases[1].texture; await engine.selectLyrics(null); const none = ledger.snapshot(true);
          Space3D.close(); return { pending, active, same, one, surviving, none, closed: ledger.snapshot() };
        });
        const covers = snapshot => snapshot.entries.filter(entry => /Space cover pool/.test(entry.basis.source));
        assert.equal(covers(result.pending).length, 2); assert.equal(result.pending.held.decoderLeases, 0);
        assert.equal(covers(result.pending).reduce((sum, entry) => sum + entry.live.ownedCpuBytes, 0), 768 * 768 * 4);
        // 768,384,192,96,48,24,12,6,3,1: the odd3 level rounds down to1.
        assert.equal(covers(result.pending).reduce((sum, entry) => sum + entry.pending.textureDeclaredBytes, 0), 3145720);
        assert.equal(covers(result.active).reduce((sum, entry) => sum + entry.live.textureDeclaredBytes, 0), 3145720);
        assert.equal(result.same, true); assert.equal(result.surviving, true); assert.equal(covers(result.one).length, 2);
        assert.equal(covers(result.none).length, 0); assert.equal(result.closed.resources, 0); return result;
      } finally { await close(page); }
    });
    await check('cover texture refusal leaves no crop, does not retry every frame and succeeds after explicit retry', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        await page.evaluate(async () => {
          const ledger = Stage.resources(), held = ledger.snapshot();
          harness.coverBlocker = ledger.port('cover-competitor').require({ textureDeclaredBytes: held.caps.textureDeclaredBytes - held.held.textureDeclaredBytes }, 'cover competitor', 0);
          const source = document.createElement('canvas'); source.width = source.height = 64; harness.coverUrl = source.toDataURL(); source.width = source.height = 0;
          const def = SpaceStagePure.catalog().find(item => item.id === 'm1-space-contract');
          SpaceStagePure.register({ ...def, id: 'm1-refused-cover', create(ctx) {
            const pool = harness.coverPool = ctx.services.spatialResources, lease = harness.coverLease = pool.cover.acquire(harness.coverUrl);
            ctx.scope.lease({ release() { pool.cover.release(lease); } }); return { update() {}, dispose() {} };
          } });
          await harness.engines.at(-1).select('m1-refused-cover');
        });
        await page.waitForFunction(() => harness.coverLease.failed);
        const refused = await page.evaluate(async () => {
          const before = Stage.resources().snapshot(true); harness.snapshot(true); await harness.advance(100);
          const after = Stage.resources().snapshot(), stats = harness.coverPool.stats();
          harness.coverBlocker.release({ apiReleased: true, allocationEnded: true }); harness.coverPool.retryResources();
          return { before, after, stats };
        });
        await page.waitForFunction(() => !!harness.coverLease.texture);
        const retried = await page.evaluate(() => { const ready = !harness.coverLease.failed; Space3D.close(); return { ready, after: Stage.resources().snapshot() }; });
        assert.equal(refused.before.entries.filter(entry => /Space cover pool/.test(entry.basis.source)).length, 0);
        assert.equal(refused.stats.resourceFailure, 'aggregate-budget'); assert.equal(refused.before.rejections, refused.after.rejections);
        assert.equal(retried.ready, true); assert.equal(retried.after.resources, 0); return { refused, retried };
      } finally { await close(page); }
    });
    await check('retired cover lease holds unresolved decode after full Space exit until its late result settles', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        await page.evaluate(async () => {
          const source = document.createElement('canvas'); source.width = source.height = 64;
          harness.coverUrl = source.toDataURL(); source.width = source.height = 0;
          const decode = HTMLImageElement.prototype.decode;
          HTMLImageElement.prototype.decode = async function () { await decode.call(this); return new Promise(resolve => { harness.endCoverDecode = resolve; }); };
          const def = SpaceStagePure.catalog().find(item => item.id === 'm1-space-contract');
          SpaceStagePure.register({ ...def, id: 'm1-late-cover', create(ctx) {
            const pool = ctx.services.spatialResources, lease = pool.cover.acquire(harness.coverUrl);
            ctx.scope.lease({ release() { pool.cover.release(lease); } }); return { update() {}, dispose() {} };
          } }); await harness.engines.at(-1).select('m1-late-cover');
        });
        await page.waitForFunction(() => !!harness.endCoverDecode);
        const result = await page.evaluate(async () => {
          const ledger = Stage.resources(), pending = ledger.snapshot(); Space3D.close(); const retired = ledger.snapshot(true);
          harness.endCoverDecode(); for (let i = 0; i < 24; i++) await Promise.resolve();
          return { pending, retired, after: ledger.snapshot() };
        });
        assert.equal(result.pending.held.decoderLeases, 1); assert.equal(result.retired.held.decoderLeases, 1);
        assert.equal(result.retired.resources, 2); assert.ok(result.retired.entries.every(entry => entry.cancelled));
        assert.equal(result.after.resources, 0); return result;
      } finally { await close(page); }
    });
    await check('authored cover scenes keep their last uploaded artwork across failed and reduced-motion candidates', async () => {
      const samples = [];
      for (const id of ['cover-particles', 'cover-sphere']) {
        const page = await pageFor();
        try {
          await mount(page);
          await page.evaluate(async id => {
            const source = document.createElement('canvas'); source.width = source.height = 64;
            const ctx = source.getContext('2d'); ctx.fillStyle = '#b46035'; ctx.fillRect(0, 0, 64, 64);
            harness.coverInput = source.toDataURL(); ctx.fillStyle = '#307c61'; ctx.fillRect(0, 0, 64, 64);
            harness.coverNext = source.toDataURL(); source.width = source.height = 0;
            const engine = harness.engines.at(-1);
            engine.setServices({ coverUrl: () => harness.coverInput, decodeImage: (url, options) => StageImageSource.decode(url, options) });
            await engine.select(id); await harness.advance(10);
          }, id);
          await page.waitForFunction(() => Stage.resources().snapshot(true).entries.some(entry => /Space cover pool shared/.test(entry.basis.source)));
          await page.evaluate(async () => {
            const engine = harness.engines.at(-1), ledger = Stage.resources(); await harness.advance(10);
            const snap = ledger.snapshot(); harness.beforeCover = ledger.snapshot(true);
            harness.coverBlocker = ledger.port('artwork-coexistence-refusal').require({ textureDeclaredBytes: snap.caps.textureDeclaredBytes - snap.held.textureDeclaredBytes }, 'artwork competing upload', 0);
            harness.coverInput = harness.coverNext; engine.setParams({}); await harness.advance(10);
          });
          await page.waitForFunction(() => harness.engines.at(-1).stats().poolResourceFailure === 'aggregate-budget');
          const result = await page.evaluate(async () => {
            const engine = harness.engines.at(-1), ledger = Stage.resources();
            Stage.setReducedMotion(true); await harness.advance(12);
            const after = ledger.snapshot(true), stats = engine.stats();
            harness.coverBlocker.release({ apiReleased: true, allocationEnded: true });
            Space3D.close(); return { before: harness.beforeCover, after, stats, closed: ledger.snapshot() };
          });
          const covers = snapshot => snapshot.entries.filter(entry => /Space cover pool/.test(entry.basis.source));
          assert.deepEqual(covers(result.after), covers(result.before)); assert.equal(result.stats.sceneStats.primary.covers, 1);
          assert.equal(result.closed.resources, 0); samples.push({ id, ...result });
        } finally { await close(page); }
      } return samples;
    });
    await check('authored cover array plans admit original buffers and settle over twenty complete scene exits', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(async () => {
          const ledger = Stage.resources(), engine = harness.engines.at(-1), samples = [];
          for (let i = 0; i < 20; i++) {
            const id = i % 2 ? 'cover-sphere' : 'cover-particles'; await engine.select(id); await harness.advance(8);
            const arrays = ledger.snapshot(true).entries.filter(entry => /authored cover .*arrays|authored cover sphere grain|shared stellar|shared shock/.test(entry.basis.source));
            samples.push({ id, arrays }); await engine.select('m1-space-contract'); await harness.advance(8);
            if (ledger.snapshot(true).entries.some(entry => /authored cover .*arrays|authored cover sphere grain|shared stellar|shared shock/.test(entry.basis.source))) throw Error('array quota survived scene retirement');
          }
          Space3D.close(); return { samples, closed: ledger.snapshot() };
        });
        for (const sample of result.samples) {
          const expected = sample.id === 'cover-particles' ? 737280 : 157020;
          assert.equal(sample.arrays.reduce((sum, entry) => sum + entry.live.ownedCpuBytes, 0), expected);
          assert.equal(sample.arrays.reduce((sum, entry) => sum + entry.live.bufferDeclaredBytes + entry.pending.bufferDeclaredBytes, 0), expected);
        }
        assert.equal(result.closed.resources, 0); return result;
      } finally { await close(page); }
    });
    await check('text upload refusal cleans measurement resources and stays settled without per-frame retries', async () => {
      const page = await pageFor({ textureDeclaredBytes: 0 });
      try {
        await mount(page);
        const result = await page.evaluate(async () => {
          const def = SpaceStagePure.catalog().find(item => item.id === 'm1-space-contract'), engine = harness.engines.at(-1);
          let pool, lease;
          SpaceStagePure.register({ ...def, id: 'm1-space-refused-text', create(ctx) {
            pool = ctx.services.spatialResources; lease = pool.text.acquire('预算拒绝的文字源');
            ctx.scope.lease({ release() { pool.text.release(lease); } });
            return { update() {}, dispose() {} };
          } });
          await engine.select('m1-space-refused-text'); harness.snapshot(true); await harness.advance(12);
          const refused = Stage.resources().snapshot(true), failed = lease.failed, stats = pool.stats();
          await harness.advance(90); const settled = Stage.resources().snapshot(true);
          Space3D.close(); return { refused, failed, stats, settled, closed: Stage.resources().snapshot() };
        });
        assert.ok(result.failed); assert.equal(result.stats.resourceFailure, 'aggregate-budget');
        assert.equal(result.refused.rejections, result.settled.rejections);
        assert.equal(result.refused.entries.filter(entry => /Space text pool/.test(entry.basis.source)).length, 0);
        assert.equal(result.closed.held.canvases, 0); assert.equal(result.closed.pending.ownedCpuBytes, 0); return result;
      } finally { await close(page); }
    });
    await check('budget status is reachable on a narrow screen and explicit retry retains the saved quality request', async () => {
      const page = await pageFor();
      try {
        await page.addStyleTag({ path: path.join(web, 'design/design-base.css') });
        await page.addStyleTag({ path: path.join(web, 'style.css') });
        await page.setViewportSize({ width: 390, height: 844 }); await mount(page);
        await page.waitForFunction(() => document.getElementById('sp-warp').hidden);
        const before = await page.evaluate(async () => {
          const engine = harness.engines.at(-1), ledger = Stage.resources();
          engine.setServices({ post: { grain: 10 } }); engine.setParams({ scale: 1 });
          const snap = ledger.snapshot(); harness.uiBlocker = ledger.port('ui-post-competitor').require({ renderTargetDeclaredBytes:
            snap.caps.renderTargetDeclaredBytes - snap.held.renderTargetDeclaredBytes - 1 }, 'UI competitor', 0);
          harness.uiBlocker.commit(); harness.snapshot(true); await harness.advance(12);
          const node = document.getElementById('sp-resource-status'), bounds = node.getBoundingClientRect();
          return { preference: Space3D.preferences(), stats: engine.stats(), bounds: { left: bounds.left, right: bounds.right },
            hidden: node.hidden, role: node.getAttribute('role'), text: node.textContent, resources: ledger.snapshot(true) };
        });
        assert.equal(before.hidden, false); assert.equal(before.role, 'status'); assert.ok(before.text.includes('重试效果'));
        assert.ok(before.bounds.left >= 0 && before.bounds.right <= 390);
        assert.ok(await page.evaluate(() => {
          return [...document.querySelectorAll('#sp-resource-status span, #sp-resource-status button')].every(node => {
            const rect = node.getBoundingClientRect();
            return node.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
          });
        }), 'budget feedback is visually exposed after entry transition');
        await page.locator('#sp-resource-status button').focus();
        assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#sp-resource-status button')), true);
        await page.screenshot({ path: path.join(out, 'space-resource-status-390x844.png') });
        await page.evaluate(() => harness.uiBlocker.release({ apiReleased: true, allocationEnded: true }));
        await page.keyboard.press('Enter'); await page.evaluate(() => harness.advance(12));
        const after = await page.evaluate(() => ({ preference: Space3D.preferences(), stats: harness.engines.at(-1).stats(),
          hidden: document.getElementById('sp-resource-status').hidden, resources: Stage.resources().snapshot(true) }));
        assert.deepEqual(after.preference, before.preference); assert.equal(after.hidden, true);
        const host = after.resources.hosts.find(item => item.owner === 'space-renderer');
        assert.equal(host.requestedQuality, 'low'); assert.equal(host.actualQuality, 'low');
        assert.equal(host.requestId, after.stats.requestId); assert.equal(host.actualScene, 'm1-space-contract');
        return { before, after };
      } finally { await close(page); }
    });
    await check('zero program capacity refuses the actual Three cache miss before native createProgram', async () => {
      const page = await pageFor({ programs: 0 });
      try {
        const result = await page.evaluate(async () => {
          const port = Stage.resources().port('direct-cache-refusal'), ticket = port.require({ canvases: 1 }, 'Direct original renderer fixture', 0);
          const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
          ticket.commit();
          const engine = SpaceStagePure.create(canvas, { resources: port, qualityMode: 'low' });
          await engine.select('m1-space-contract');
          engine.frame({ width: 640, height: 360, dt: 0, time: 0, sceneTime: 0, position: 0, level: 0 });
          const failed = { creates: harness.programCreates, engine: engine.stats(), ledger: Stage.resources().snapshot(true) };
          for (let i = 0; i < 120; i++) engine.frame({ dt: .016, time: 1, sceneTime: 1, position: 0, level: 0 });
          const stable = Stage.resources().snapshot();
          engine.dispose(); canvas.width = canvas.height = 0; ticket.release({ apiReleased: true, allocationEnded: true });
          return { failed, stable, closed: Stage.resources().snapshot() };
        });
        assert.equal(result.failed.creates, 0); assert.equal(result.failed.ledger.held.programs, 0);
        assert.equal(result.failed.engine.state, 'failed');
        assert.equal(result.failed.ledger.rejections, result.stable.rejections); return result;
      } finally { await close(page); }
    });
    await check('Three cache aliases charge once and serial preflight only forecasts the last material use', async () => {
      const page = await pageFor({ programs: 1 });
      try {
        await mount(page);
        const result = await page.evaluate(async () => {
          for (const [id, twin] of [['m1-program-twins', true], ['m1-program-single', false]]) {
            SpaceStagePure.register({ apiVersion: 1, id, stateVersion: 1, label: id, category: 'world', preview: '/test',
              params: {}, camera: { radius: 6 }, capabilities: { threejs: true }, quality: {}, resourcePlan: () => ({ programs: 1 }),
              create(ctx) {
                const T = ctx.THREE, geometry = ctx.scope.track(new T.BoxGeometry(1, 1, 1));
                const materials = twin ? [new T.MeshNormalMaterial(), new T.MeshNormalMaterial()] : [new T.MeshBasicMaterial({ color: 0x778899 })];
                const meshes = materials.map((material, index) => {
                  ctx.scope.track(material); const mesh = new T.Mesh(geometry, material); mesh.position.x = index; ctx.scene.add(mesh); return mesh;
                });
                harness.programScope = ctx.scope; harness.programRenderer = ctx.renderer; harness.programMeshes = meshes; harness.programMaterials = materials;
                return { update() {}, dispose() {} };
              } });
          }
          await Space3D.setSource('m1-program-twins'); await harness.advance(12);
          const snap = () => Stage.resources().snapshot(true), count = () => harness.programRenderer.info.programs.length;
          const first = { ledger: snap(), native: count(), ids: harness.programScope.retirementCandidates(harness.programRenderer) };
          harness.programMeshes[0].removeFromParent(); harness.programScope.release(harness.programMaterials[0]);
          const one = { ledger: snap(), native: count(), ids: harness.programScope.retirementCandidates(harness.programRenderer) };
          await Space3D.setSource('cover-particles'); await harness.advance(12);
          const refused = { ledger: snap(), stats: Space3D.stats() };
          await Space3D.setSource('m1-program-single'); await harness.advance(12);
          const serial = { ledger: snap(), native: count(), stats: Space3D.stats() };
          Space3D.close(); return { first, one, refused, serial, closed: snap() };
        });
        assert.equal(result.first.native, 1); assert.equal(result.first.ledger.held.programs, 1);
        assert.equal(result.one.native, 1); assert.equal(result.one.ledger.held.programs, 1);
        const programId = result.one.ledger.entries.find(entry => entry.live.programs === 1).resourceId;
        assert.ok(result.first.ids.includes(programId)); assert.ok(result.one.ids.includes(programId));
        assert.equal(result.refused.stats.renderer.id, 'm1-program-twins');
        assert.equal(result.serial.stats.renderer.id, 'm1-program-single'); assert.equal(result.serial.native, 1);
        assert.equal(result.serial.ledger.peak.programs, 1); assert.equal(result.closed.held.programs, 0); return result;
      } finally { await close(page); }
    });
    await check('partial Three shader-source failures retire both shader and cache-miss program before releasing quota', async () => {
      const samples = [];
      for (const failAt of [1, 2]) {
        const page = await pageFor();
        try {
          await mount(page);
          const result = await page.evaluate(async failAt => {
            const gl = harness.gl, programs = new Set(), shaders = new Set();
            for (const [kind, live] of [['Program', programs], ['Shader', shaders]]) {
              const create = gl['create' + kind].bind(gl), remove = gl['delete' + kind].bind(gl);
              gl['create' + kind] = (...args) => { const value = create(...args); live.add(value); return value; };
              gl['delete' + kind] = value => { const result = remove(value); live.delete(value); return result; };
            }
            const source = gl.shaderSource.bind(gl); let count = 0;
            gl.shaderSource = (...args) => { if (++count === failAt) throw new Error('Injected partial shader-source failure'); return source(...args); };
            await Space3D.setSource('cover-particles'); await harness.advance(12);
            return { programs: programs.size, shaders: shaders.size, ledger: Stage.resources().snapshot(true), stats: harness.engines.at(-1).stats() };
          }, failAt);
          assert.equal(result.programs, 0); assert.equal(result.shaders, 0); assert.equal(result.ledger.held.programs, 0);
          assert.equal(result.stats.state, 'disposed'); samples.push({ failAt, ...result });
        } finally { await close(page); }
      }
      return samples;
    });
    await check('unknown Three program cleanup retains canceled quota instead of reporting release', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(async () => {
          const gl = harness.gl, source = gl.shaderSource.bind(gl), remove = gl.deleteProgram.bind(gl), create = gl.createProgram.bind(gl), candidates = new Set();
          gl.createProgram = () => { const value = create(); candidates.add(value); return value; };
          let once = true;
          gl.shaderSource = (...args) => { if (once) { once = false; throw new Error('Injected partial preparation'); } return source(...args); };
          gl.deleteProgram = value => { if (candidates.has(value)) throw new Error('Injected cleanup failure'); return remove(value); };
          await Space3D.setSource('cover-particles'); await harness.advance(12);
          gl.deleteProgram = remove;
          const failed = Stage.resources().snapshot(true); Space3D.close(); return { failed, closed: Stage.resources().snapshot(true) };
        });
        assert.equal(result.failed.held.programs, 1); assert.equal(result.closed.held.programs, 1);
        assert.ok(result.closed.entries.some(entry => entry.cancelled && entry.live.programs === 1)); return result;
      } finally { await close(page); }
    });
    await check('twenty authored particle exits charge actual primary, effect and post programs and return them to baseline', async () => {
      const page = await pageFor();
      try {
        const samples = await page.evaluate(async () => {
          const rows = [];
          for (let i = 0; i < 20; i++) {
            const source = ['cover-particles', 'spectrum-sphere', 'spectrum-towers', 'background-flow'][i % 4];
            Space3D.open(source); await Space3D.enterStage(source); await harness.advance(12);
            const engine = harness.engines.at(-1);
            engine.setParams({ dust: 1, discRing: true, ripples: 1, grain: 10 }); await harness.advance(12);
            const held = Stage.resources().snapshot(), actual = engine.stats().programs;
            Space3D.close(); rows.push({ source, actual, held, closed: Stage.resources().snapshot() });
          }
          return rows;
        });
        samples.forEach(row => { assert.ok(row.actual >= 2); assert.equal(row.held.held.programs, row.actual); assert.equal(row.closed.held.programs, 0); });
        return samples;
      } finally { await close(page); }
    });
    await check('zero available buffer capacity refuses implicit geometry before native createBuffer', async () => {
      const page = await pageFor({ bufferDeclaredBytes: 140 });
      try {
        const result = await page.evaluate(async () => {
          const port = Stage.resources().port('direct-buffer-refusal'), ticket = port.require({ canvases: 1 }, 'Direct original buffer fixture', 0), canvas = document.createElement('canvas');
          canvas.width = 640; canvas.height = 360;
          ticket.commit();
          const engine = SpaceStagePure.create(canvas, { resources: port, qualityMode: 'low' });
          const gl = harness.gl, create = gl.createBuffer.bind(gl); let creates = 0;
          gl.createBuffer = () => { creates++; return create(); };
          // The original post plane holds all140 bytes pending; the primary
          // implicit geometry therefore has no remaining upload capacity.
          await engine.select('m1-space-contract');
          engine.frame({ dt: 0, time: 0, sceneTime: 0, position: 0, level: 0 });
          const failed = { creates, engine: engine.stats(), ledger: Stage.resources().snapshot() };
          engine.dispose(); canvas.width = canvas.height = 0; ticket.release({ apiReleased: true, allocationEnded: true });
          return { failed, closed: Stage.resources().snapshot() };
        });
        assert.equal(result.failed.creates, 0); assert.equal(result.failed.engine.state, 'failed');
        assert.equal(result.closed.held.bufferDeclaredBytes, 0); return result;
      } finally { await close(page); }
    });
    await check('implicit interleaved buffer aliases charge once and repeated uploads do not accumulate capacity', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(async () => {
          SpaceStagePure.register({ apiVersion: 1, id: 'm1-interleaved', stateVersion: 1, label: 'Interleaved', category: 'world', preview: '/test',
            params: {}, camera: { radius: 6 }, capabilities: { threejs: true }, quality: {},
            create(ctx) {
              const T = ctx.THREE, data = new T.InterleavedBuffer(new Float32Array([-1, -1, 0, 1, 0, 0, 1, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1]), 6);
              const geometry = ctx.scope.track(new T.BufferGeometry());
              geometry.setAttribute('position', new T.InterleavedBufferAttribute(data, 3, 0)); geometry.setAttribute('color', new T.InterleavedBufferAttribute(data, 3, 3));
              const material = ctx.scope.track(new T.MeshBasicMaterial({ vertexColors: true })); ctx.scene.add(new T.Mesh(geometry, material));
              harness.interleaved = data; harness.interleavedScope = ctx.scope; harness.interleavedRenderer = ctx.renderer;
              return { update() { data.needsUpdate = true; }, dispose() {} };
            } });
          const gl = harness.gl, create = gl.createBuffer.bind(gl); let creates = 0;
          gl.createBuffer = () => { creates++; return create(); };
          await Space3D.setSource('m1-interleaved'); await harness.advance(12);
          const first = Stage.resources().snapshot(true), ids = harness.interleavedScope.retirementCandidates(harness.interleavedRenderer);
          await harness.advance(120); const repeated = Stage.resources().snapshot(true);
          Space3D.close(); return { first, repeated, ids, creates, closed: Stage.resources().snapshot(true) };
        });
        const nativeBuffers = value => value.entries.filter(entry => /Three original attribute-cache/.test(entry.basis.source));
        assert.equal(result.creates, 1); assert.equal(nativeBuffers(result.first).length, 1);
        assert.equal(nativeBuffers(result.first)[0].live.bufferDeclaredBytes, 72);
        assert.deepEqual(nativeBuffers(result.repeated).map(entry => entry.live), nativeBuffers(result.first).map(entry => entry.live));
        assert.ok(result.ids.includes(nativeBuffers(result.first)[0].resourceId));
        assert.equal(result.closed.held.bufferDeclaredBytes, 0); return result;
      } finally { await close(page); }
    });
    await check('retired explicit buffer plans cannot lend released quota to a late old-scene upload', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(async () => {
          SpaceStagePure.register({ apiVersion: 1, id: 'm1-retired-buffer', stateVersion: 1, label: 'Retired buffer', category: 'world', preview: '/test',
            params: {}, camera: { radius: 6 }, capabilities: { threejs: true }, quality: {}, resourcePlan: () => ({ ownedCpuBytes: 36, bufferDeclaredBytes: 36, programs: 1 }),
            create(ctx) {
              const T = ctx.THREE, plan = ctx.scope.bufferPlan(36, 36, 'Retired source-owned buffer'), positions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
              plan.cpuReady(36);
              const geometry = ctx.scope.track(new T.BufferGeometry()); geometry.setAttribute('position', plan.upload(new T.BufferAttribute(positions, 3)));
              const material = ctx.scope.track(new T.MeshBasicMaterial()), mesh = new T.Mesh(geometry, material); ctx.scene.add(mesh);
              harness.expiredBufferScene = { ctx, mesh }; return { update() {}, dispose() {} };
            } });
          await Space3D.setSource('m1-retired-buffer'); await harness.advance(12);
          await Space3D.setSource('cover-particles'); await harness.advance(12);
          const before = Stage.resources().snapshot(), gl = harness.gl, create = gl.createBuffer.bind(gl); let creates = 0, error = '';
          gl.createBuffer = () => { creates++; return create(); };
          const { ctx, mesh } = harness.expiredBufferScene; ctx.scene.add(mesh);
          try { ctx.renderer.render(ctx.scene, ctx.camera); } catch (reason) { error = reason.message; }
          ctx.scene.clear(); return { before, after: Stage.resources().snapshot(), creates, error, actual: Space3D.stats().renderer.id };
        });
        assert.match(result.error, /buffer-plan-retired/); assert.equal(result.creates, 0);
        assert.deepEqual(result.after.held, result.before.held); assert.equal(result.actual, 'cover-particles'); return result;
      } finally { await close(page); }
    });
    await check('partial implicit bufferData failure retires allocated buffers before returning quota', async () => {
      const samples = [];
      for (const failAt of [1, 2]) {
        const page = await pageFor();
        try {
          await mount(page);
          const result = await page.evaluate(async failAt => {
            const gl = harness.gl, data = gl.bufferData.bind(gl), create = gl.createBuffer.bind(gl), remove = gl.deleteBuffer.bind(gl), buffers = new Set();
            gl.createBuffer = () => { const buffer = create(); buffers.add(buffer); return buffer; };
            gl.deleteBuffer = value => { const result = remove(value); buffers.delete(value); return result; };
            let calls = 0;
            gl.bufferData = (...args) => { if (++calls === failAt) throw new Error('Injected partial implicit bufferData failure'); return data(...args); };
            const def = SpaceStagePure.catalog().find(item => item.id === 'm1-space-contract');
            SpaceStagePure.register({ ...def, id: 'm1-space-buffer-fail', create(ctx) {
              const geometry = ctx.scope.track(new ctx.THREE.BoxGeometry(2, 2, 2)), material = ctx.scope.track(new ctx.THREE.MeshNormalMaterial());
              ctx.scene.add(new ctx.THREE.Mesh(geometry, material)); return { update() {}, dispose() {} };
            } });
            await Space3D.setSource('m1-space-buffer-fail'); await harness.advance(12);
            return { buffers: buffers.size, ledger: Stage.resources().snapshot(true), stats: harness.engines.at(-1).stats() };
          }, failAt);
          assert.equal(result.buffers, 0); assert.equal(result.ledger.held.bufferDeclaredBytes, 0); assert.equal(result.stats.state, 'disposed');
          samples.push({ failAt, ...result });
        } finally { await close(page); }
      }
      return samples;
    });
    await check('an actual Three shader failure cannot claim first-submit readiness and cleans its renderer lifetime', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(async () => {
          const def = SpaceStagePure.catalog().find(item => item.id === 'm1-space-contract'), engine = harness.engines.at(-1);
          SpaceStagePure.register({ ...def, id: 'm1-space-shader-fail', create(ctx) {
            const geometry = ctx.scope.track(new ctx.THREE.PlaneGeometry(2, 2));
            const material = ctx.scope.track(new ctx.THREE.ShaderMaterial({
              vertexShader: 'this is deliberately invalid GLSL', fragmentShader: 'void main(){gl_FragColor=vec4(1.0);}'
            })); ctx.scene.add(new ctx.THREE.Mesh(geometry, material));
            return { update() {}, dispose() {} };
          } });
          await Space3D.setSource('m1-space-shader-fail'); const prepared = engine.stats();
          harness.snapshot(true); await harness.advance(12);
          return { prepared, retired: engine.stats(), host: Space3D.stats(), resources: Stage.resources().snapshot(true),
            text: document.getElementById('sp-error-message').textContent };
        });
        assert.equal(result.prepared.firstSubmit, false); assert.equal(result.retired.state, 'disposed');
        assert.equal(result.host.renderer, null); assert.ok(result.text.includes('shader program failed'));
        assert.equal(result.resources.held.gpuContexts, 0); assert.equal(result.resources.held.programs, 0);
        assert.equal(result.resources.hosts.filter(item => item.owner === 'space-renderer').length, 0); return result;
      } finally { await close(page); }
    });
    await check('hidden and zero-layout selections retain only the final request without preparing resources until visible', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(async () => {
          const def = SpaceStagePure.catalog().find(item => item.id === 'm1-space-contract'); harness.deferredCreates = [];
          for (const id of ['m1-space-deferred-a', 'm1-space-deferred-b']) SpaceStagePure.register({ ...def, id, create() {
            harness.deferredCreates.push(id); return { update() {}, dispose() {} };
          } });
          const before = Stage.resources().snapshot(); harness.hide(true);
          for (let i = 0; i < 100; i++) await Space3D.setSource(i % 2 ? 'm1-space-deferred-b' : 'm1-space-deferred-a');
          await harness.advance(12); const hidden = { creates: harness.deferredCreates.slice(), resources: Stage.resources().snapshot(),
            actual: Space3D.stats().renderer.id, requested: Space3D.sourceId() };
          harness.hide(false); await harness.advance(18); const visible = { creates: harness.deferredCreates.slice(), stats: Space3D.stats() };
          const root = document.getElementById('space3d'); root.style.display = 'none'; window.dispatchEvent(new Event('resize'));
          const zeroBefore = Stage.resources().snapshot(); await Space3D.setSource('m1-space-deferred-a'); await harness.advance(12);
          const zero = { creates: harness.deferredCreates.slice(), resources: Stage.resources().snapshot() };
          root.style.display = ''; window.dispatchEvent(new Event('resize')); await harness.advance(18);
          return { before, hidden, visible, zeroBefore, zero, restored: Space3D.stats(), creates: harness.deferredCreates.slice() };
        });
        assert.deepEqual(result.hidden.creates, []); assert.deepEqual(result.hidden.resources.held, result.before.held);
        assert.equal(result.hidden.actual, 'm1-space-contract'); assert.equal(result.hidden.requested, 'm1-space-deferred-b');
        assert.deepEqual(result.visible.creates, ['m1-space-deferred-b']); assert.equal(result.visible.stats.renderer.id, 'm1-space-deferred-b');
        assert.deepEqual(result.zero.creates, ['m1-space-deferred-b']); assert.deepEqual(result.zero.resources.held, result.zeroBefore.held);
        assert.deepEqual(result.creates, ['m1-space-deferred-b', 'm1-space-deferred-a']); assert.equal(result.restored.renderer.id, 'm1-space-deferred-a'); return result;
      } finally { await close(page); }
    });
    await check('a factory completing while hidden retains preparation without post allocation or first-submit readiness', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(async () => {
          const def = SpaceStagePure.catalog().find(item => item.id === 'm1-space-contract'), engine = harness.engines.at(-1), ledger = Stage.resources();
          SpaceStagePure.register({ ...def, id: 'm1-space-late-hidden', create() {
            return new Promise(resolve => harness.resolveHidden = () => resolve({ update() {}, dispose() {} }));
          } });
          const operation = Space3D.setSource('m1-space-late-hidden');
          harness.hide(true); const waiting = ledger.snapshot(true); harness.resolveHidden(); await operation; await harness.advance(12);
          const hidden = { resources: ledger.snapshot(true), stats: engine.stats() };
          harness.hide(false); await harness.advance(18);
          return { waiting, hidden, visible: { resources: ledger.snapshot(true), stats: engine.stats() } };
        });
        assert.equal(result.hidden.stats.state, 'preparing'); assert.equal(result.hidden.stats.firstSubmit, false);
        assert.deepEqual(result.hidden.resources.held, result.waiting.held);
        assert.equal(result.hidden.resources.entries.filter(entry => /Space post original/.test(entry.basis.source)).length, 0);
        assert.equal(result.visible.stats.state, 'ready'); assert.equal(result.visible.stats.firstSubmit, true);
        assert.equal(result.visible.resources.entries.filter(entry => /Space post original/.test(entry.basis.source)).length, 1); return result;
      } finally { await close(page); }
    });
    await check('authored coast effects use their source array plans and return them over twenty whole exits', async () => {
      const page = await pageFor();
      try {
        const result = await page.evaluate(async () => {
          Space3D.open('coast'); await Space3D.enterStage('coast');
          const before = Stage.resources().snapshot(true);
          harness.engines.at(-1).setParams({ dust: 1, discRing: true, ripples: 1 });
          harness.snapshot(true); Stage.setSpectrum(new Float32Array(64).fill(.8)); await harness.advance(6);
          Stage.setSpectrum(new Float32Array(64).fill(.8)); await harness.advance(6);
          const active = Stage.resources().snapshot(true), rendered = harness.engines.at(-1).stats();
          Space3D.close(); const baseline = Stage.resources().snapshot(), cycles = [];
          for (let i = 0; i < 20; i++) {
            Space3D.open('coast'); await Space3D.enterStage('coast');
            harness.engines.at(-1).setParams({ dust: 1, discRing: true, ripples: 1 });
            Stage.setSpectrum(new Float32Array(64).fill(.8)); await harness.advance(4);
            Stage.setSpectrum(new Float32Array(64).fill(.8)); await harness.advance(4);
            const shown = harness.engines.at(-1).stats(); Space3D.close();
            cycles.push({ shown, closed: Stage.resources().snapshot() });
          }
          return { before, active, rendered, baseline, cycles };
        });
        const effects = snap => snap.entries.filter(entry => /Space (dust position|spectrum orbit|ripple Torus)/.test(entry.basis.source));
        assert.equal(effects(result.before).length, 6);
        assert.equal(effects(result.before).reduce((sum, entry) => sum + entry.pending.bufferDeclaredBytes, 0), 33192);
        assert.equal(effects(result.active).reduce((sum, entry) => sum + entry.live.ownedCpuBytes, 0), 33216);
        // A coast camera can cull the ripple mesh; its unsubmitted buffer plan
        // remains pending instead of inventing a live GPU allocation.
        assert.equal(effects(result.active).reduce((sum, entry) => sum + entry.live.bufferDeclaredBytes + entry.pending.bufferDeclaredBytes, 0), 33192);
        assert.ok(effects(result.active).reduce((sum, entry) => sum + entry.live.bufferDeclaredBytes, 0) >= 14400);
        assert.equal(result.active.violations.length, 0); assert.ok(result.rendered.firstSubmit && result.rendered.drawCalls > 0);
        for (const cycle of result.cycles) { assert.ok(cycle.shown.firstSubmit); assert.deepEqual(cycle.closed.held, result.baseline.held); }
        return result;
      } finally { await close(page); }
    });
    await check('scope buffers reserve before CPU allocation and move to live only at the original Three upload', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(async () => {
          const def = SpaceStagePure.catalog().find(item => item.id === 'm1-space-contract'), ledger = Stage.resources();
          SpaceStagePure.register({ ...def, id: 'm1-space-scoped-buffer', create(ctx) {
            const plan = ctx.scope.bufferPlan(36, 36, 'Scope contract triangle9');
            const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
            const geometry = ctx.scope.track(new ctx.THREE.BufferGeometry());
            harness.scopeAttribute = plan.upload(new ctx.THREE.BufferAttribute(positions, 3));
            geometry.setAttribute('position', harness.scopeAttribute); plan.cpuReady(36);
            const material = ctx.scope.track(new ctx.THREE.MeshBasicMaterial()); ctx.scene.add(new ctx.THREE.Mesh(geometry, material));
            return { update() {}, dispose() {} };
          } });
          await Space3D.setSource('m1-space-scoped-buffer'); const before = ledger.snapshot(true);
          harness.snapshot(true); await harness.advance(12); const after = ledger.snapshot(true);
          harness.scopeAttribute.needsUpdate = true; await harness.advance(12); const repeat = ledger.snapshot(true);
          Space3D.close(); return { before, after, repeat, closed: ledger.snapshot() };
        });
        const scoped = snap => snap.entries.filter(entry => /Scope contract triangle9/.test(entry.basis.source));
        assert.equal(scoped(result.before).length, 2);
        assert.ok(scoped(result.before).some(entry => entry.live.ownedCpuBytes === 36));
        assert.ok(scoped(result.before).some(entry => entry.pending.bufferDeclaredBytes === 36 && !entry.live.bufferDeclaredBytes));
        assert.ok(scoped(result.after).some(entry => entry.live.bufferDeclaredBytes === 36 && !entry.pending.bufferDeclaredBytes));
        assert.deepEqual(scoped(result.repeat).map(entry => entry.live), scoped(result.after).map(entry => entry.live));
        assert.equal(result.closed.held.ownedCpuBytes, 0); assert.equal(result.closed.held.bufferDeclaredBytes, 0); return result;
      } finally { await close(page); }
    });
    await check('one hundred admitted async scopes retain canceled quota until late allocation and cleanup have both settled', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(async () => {
          const def = SpaceStagePure.catalog().find(item => item.id === 'm1-space-contract'), engine = harness.engines.at(-1), ledger = Stage.resources();
          harness.scopeResolvers = []; harness.scopeDisposals = 0;
          SpaceStagePure.register({ ...def, id: 'm1-space-pending-buffer', create(ctx) {
            const plan = ctx.scope.bufferPlan(64, 64, 'Scope contract pending array16');
            return new Promise(resolve => harness.scopeResolvers.push(() => {
              let array = new Float32Array(16); plan.cpuReady(array.byteLength);
              resolve({ update() {}, dispose() { array = null; harness.scopeDisposals++; } });
            }));
          } });
          const operations = [];
          for (let i = 0; i < 100; i++) operations.push(engine.select('m1-space-pending-buffer'));
          Space3D.close(); const canceled = ledger.snapshot(true);
          harness.scopeResolvers.forEach(resolve => resolve()); await Promise.all(operations);
          return { canceled, final: ledger.snapshot(true), disposals: harness.scopeDisposals, retired: engine.stats() };
        });
        const pending = result.canceled.entries.filter(entry => /Scope contract pending array16/.test(entry.basis.source));
        assert.equal(pending.length, 200); assert.ok(pending.every(entry => entry.cancelled));
        assert.equal(pending.reduce((sum, entry) => sum + entry.pending.ownedCpuBytes, 0), 6400);
        assert.equal(pending.reduce((sum, entry) => sum + entry.pending.bufferDeclaredBytes, 0), 6400);
        assert.equal(result.disposals, 100); assert.equal(result.retired.state, 'disposed');
        assert.equal(result.final.entries.filter(entry => /Scope contract pending array16/.test(entry.basis.source)).length, 0);
        assert.equal(result.final.held.ownedCpuBytes, 0); assert.equal(result.final.held.bufferDeclaredBytes, 0); return result;
      } finally { await close(page); }
    });
    await check('preparation is not ready before a visible submit and one hundred stale factory results cannot revive closed scopes', async () => {
      const page = await pageFor();
      try {
        const prepared = await page.evaluate(async () => {
          const original = SpaceStagePure.catalog().find(def => def.id === 'm1-space-contract');
          harness.releases = []; harness.lateDisposed = 0;
          SpaceStagePure.register({ ...original, id: 'm1-space-delayed', create(ctx) {
            return new Promise(resolve => harness.releases.push(() => resolve({
              update() {}, dispose() { harness.lateDisposed++; }
            })));
          } });
          Space3D.open('m1-space-contract'); await Space3D.enterStage('m1-space-contract');
          const engine = harness.engines.at(-1), pending = engine.stats();
          harness.hide(true); const hiddenSubmit = engine.frame({ now: harness.time, dt: 0 });
          const hidden = engine.stats(); harness.hide(false); await harness.advance(12); const shown = engine.stats();
          const baseline = Stage.resources().snapshot(), operations = [];
          for (let i = 0; i < 100; i++) operations.push(engine.select('m1-space-delayed'));
          Space3D.close(); harness.releases.forEach(release => release()); await Promise.all(operations);
          await harness.advance(12);
          return { pending, hiddenSubmit, hidden, shown, baseline, closed: Stage.resources().snapshot(),
            engine: engine.stats(), lateDisposed: harness.lateDisposed, creates: harness.releases.length, host: Space3D.stats() };
        });
        assert.equal(prepared.pending.state, 'preparing'); assert.equal(prepared.pending.firstSubmit, false);
        assert.equal(prepared.hiddenSubmit, false); assert.equal(prepared.hidden.frameCount, 0);
        assert.equal(prepared.shown.state, 'ready'); assert.equal(prepared.shown.firstSubmit, true);
        assert.equal(prepared.lateDisposed, 100); assert.equal(prepared.creates, 100);
        assert.equal(prepared.engine.state, 'disposed'); assert.equal(prepared.host.renderer, null);
        assert.equal(prepared.closed.held.gpuContexts, 0); assert.equal(prepared.closed.pending.gpuContexts, 0); return prepared;
      } finally { await close(page); }
    });
    await check('twenty whole exits return resources to baseline and real context loss cannot revive the retired generation', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const cycles = await page.evaluate(async () => {
          Space3D.close(); const baseline = Stage.resources().snapshot(), samples = [];
          for (let i = 0; i < 20; i++) {
            Space3D.open('m1-space-contract'); await Space3D.enterStage('m1-space-contract'); await harness.advance(12); samples.push({ active: Stage.resources().snapshot() });
            Space3D.close(); samples.at(-1).closed = Stage.resources().snapshot();
          }
          Space3D.open('m1-space-contract'); await Space3D.enterStage('m1-space-contract'); await harness.advance(12); harness.lostEngine = harness.engines.at(-1);
          harness.gl.getExtension('WEBGL_lose_context').loseContext(); return { baseline, samples };
        });
        await page.waitForFunction(() => Space3D.stats().renderer === null);
        const contextsAfterLoss = await page.evaluate(() => harness.contexts);
        await page.waitForTimeout(1750);
        const lost = await page.evaluate(async () => {
          document.getElementById('sp-canvas').dispatchEvent(new Event('webglcontextrestored')); await harness.advance(12);
          return { stats: Space3D.stats(), resources: Stage.resources().snapshot(), retired: harness.lostEngine.stats(),
            contexts: harness.contexts, canvases: document.querySelectorAll('#sp-canvas canvas').length };
        });
        for (const sample of cycles.samples) { assert.equal(sample.active.held.gpuContexts, 1); assert.deepEqual(sample.closed.held, cycles.baseline.held); }
        assert.equal(lost.contexts, contextsAfterLoss, 'context loss must wait for an explicit retry');
        assert.equal(lost.resources.held.gpuContexts, 0); assert.equal(lost.canvases, 0); assert.equal(lost.retired.state, 'disposed');
        const retried = await page.evaluate(async () => {
          document.getElementById('sp-retry').click(); await harness.advance(12);
          return { contexts: harness.contexts, resources: Stage.resources().snapshot(), stats: Space3D.stats() };
        });
        assert.equal(retried.contexts, contextsAfterLoss + 1); assert.equal(retried.resources.held.gpuContexts, 1); assert.equal(retried.stats.renderer.state, 'ready');
        return { ...cycles, lost, retried };
      } finally { await close(page); }
    });
  } finally { await browser.close(); }
  report.passed = report.checks.every(check => check.passed) && report.errors.length === 0;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(path.join(out, 'report.json')); assert.ok(report.passed, 'Space M1 checks and page errors');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
