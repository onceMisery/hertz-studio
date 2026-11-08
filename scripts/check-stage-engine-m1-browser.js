'use strict';
// Real production Stage/particle owners. Virtual time below verifies contracts, not hardware speed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), ui = path.join(root, 'plugin/ui');
const sources = ['perf-probe.js', 'onset.js', 'stage-resource-budget.js', 'stage-resource-policy.js',
  'stage.js', 'stage-particles-gl.js', 'stage-particles.js'];
const digest = () => Object.fromEntries(sources.map(name => [name,
  crypto.createHash('sha256').update(fs.readFileSync(path.join(ui, name))).digest('hex')]));
const output = path.join(root, 'output/a09-m1-20261108/browser-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(output, { recursive: true });
const report = { scope: 'Particle owner vertical slice, real Chrome/production modules. Controlled contract time only; other M1 owners and physical qualification remain open.',
  startedAt: new Date().toISOString(), sourceSha256: digest(), checks: [], errors: [] };
let browser;
async function check(name, fn) {
  try { const evidence = await fn(); report.checks.push({ name, passed: true, evidence }); console.log('PASS ' + name); }
  catch (e) { report.checks.push({ name, passed: false, error: e.stack }); console.error('FAIL ' + name + ': ' + e.message); }
}
async function pageFor(caps = {}) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.setContent('<style>body{margin:0;background:#191b1c}#stage{position:relative;width:320px;height:240px;overflow:hidden}.stage-particles{position:absolute;left:0;top:0}.stage-lyrics{height:32px;position:absolute;top:140px}</style><div id="stage"><div class="stage-lyrics" id="lyrics"></div></div>');
  await page.evaluate(() => {
    const h = window.harness = { time: 100, hidden: false, next: 0, callbacks: new Map(), contexts: [] };
    performance.now = () => h.time;
    requestAnimationFrame = callback => { h.callbacks.set(++h.next, callback); return h.next; };
    cancelAnimationFrame = id => h.callbacks.delete(id);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h.hidden });
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args) { h.contexts.push(args[0]); return original.apply(this, args); };
    h.advance = async (count, dt = 1000 / 60) => {
      for (let i = 0; i < count; i++) {
        h.time += dt; const work = [...h.callbacks.values()]; h.callbacks.clear();
        work.forEach(callback => callback(h.time)); await Promise.resolve();
      }
    };
    h.hide = hidden => { h.hidden = hidden; document.dispatchEvent(new Event('visibilitychange')); };
  });
  for (const source of sources) {
    await page.addScriptTag({ path: path.join(ui, source) });
    if (source === 'stage-resource-policy.js') await page.evaluate(overrides => {
      StageResourcePolicy = Object.freeze({ ...StageResourcePolicy, qualification: 'contract-test-only',
        caps: Object.freeze({ ...StageResourcePolicy.caps, ...overrides }) });
    }, caps);
  }
  await page.evaluate(() => {
    Stage.init(); Stage.setTrack({ id: 'm1-fixture', duration_ms: 240000 });
    harness.snapshot = (playing, position = Stage.position(), seek = false) =>
      Stage.setSnapshot({ playing, position_ms: position, duration_ms: 240000, track_id: 'm1-fixture' }, { seek });
    harness.snapshot(false);
  });
  await page.waitForTimeout(25);
  return page;
}
async function clean(page) {
  await page.evaluate(() => { StageParticles.destroy(); Stage.destroy(); });
  await page.close();
}
async function mount(page, mode = 'standard') {
  await page.evaluate(mode => { StageParticles.init(); StageParticles.attach(mode); }, mode);
  await page.waitForTimeout(25); await page.evaluate(() => harness.advance(20));
}
const sameVector = (a, b) => assert.deepEqual(a, b);

async function main() {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    await check('zero budget prevents particle-owned startup arrays and renderers', async () => {
      const page = await pageFor({ ownedCpuBytes: 0 });
      try {
        const result = await page.evaluate(() => ({ init: StageParticles.init(), resources: Stage.resources().snapshot(),
          contexts: harness.contexts, featureLength: StageParticles.audioFeatures().agg.length }));
        assert.equal(result.init, null); assert.equal(result.resources.resources, 0);
        assert.equal(result.featureLength, 0); assert.equal(result.contexts.length, 0); return result;
      } finally { await clean(page); }
    });
    await check('GPU rejection precedes getContext and preserves enhanced request during Canvas fallback', async () => {
      const page = await pageFor({ gpuContexts: 0 });
      try {
        await page.evaluate(() => HertzPerf.setEnabled(false)); await mount(page, 'enhanced');
        const result = await page.evaluate(() => ({ mode: StageParticles.mode(), backend: StageParticles.renderer(),
          contexts: harness.contexts, resources: Stage.resources().snapshot(true), perfEnabled: HertzPerf.state.enabled }));
        assert.equal(result.mode, 'enhanced'); assert.equal(result.backend, 'canvas2d');
        assert.equal(result.contexts.filter(type => type === 'webgl2').length, 0);
        assert.equal(result.resources.live.gpuContexts, 0); assert.equal(result.perfEnabled, false);
        assert.equal(result.resources.hosts[0].requestedQuality, 'enhanced');
        assert.ok(result.resources.hosts[0].reasons.includes('aggregate-budget'));
        assert.equal(result.resources.pending.ownedCpuBytes, 0); return result;
      } finally { await clean(page); }
    });
    await check('hidden attach defers context allocation to the restored effective Stage gate', async () => {
      const page = await pageFor();
      try {
        const result = await page.evaluate(async () => {
          harness.hide(true); StageParticles.init(); StageParticles.attach('enhanced');
          const hidden = { contexts: harness.contexts.slice(), stats: StageParticles.stats(), resources: Stage.resources().snapshot(true) };
          harness.time += 60000; harness.hide(false); await harness.advance(20);
          return { hidden, restored: { contexts: harness.contexts, stats: StageParticles.stats(), resources: Stage.resources().snapshot(true) } };
        });
        assert.equal(result.hidden.contexts.length, 0); assert.equal(result.hidden.stats.renderer, 'none');
        assert.equal(result.hidden.resources.live.gpuContexts, 0);
        assert.equal(result.restored.stats.renderer, 'webgl');
        assert.equal(result.restored.stats.frame.sceneTimeMs, 0);
        assert.equal(result.restored.resources.hosts[0].actualBackend, 'webgl'); return result;
      } finally { await clean(page); }
    });
    await check('hidden retained surfaces stay charged; diagnostics do not change held resources', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(async () => {
          const before = Stage.resources().snapshot(); harness.hide(true); harness.time += 60000;
          await harness.advance(30);
          const hidden = Stage.resources().snapshot(true); HertzPerf.snapshot(); HertzPerf.snapshot();
          const observed = Stage.resources().snapshot(); harness.hide(false); await harness.advance(20);
          return { before, hidden, observed, restored: Stage.resources().snapshot(true) };
        });
        sameVector(result.before.held, result.hidden.held); sameVector(result.hidden.held, result.observed.held);
        assert.equal(result.hidden.hosts[0].presentation, 'hidden'); assert.equal(result.hidden.hosts[0].visibleUses, 0);
        assert.equal(result.restored.hosts[0].presentation, 'paused'); return result;
      } finally { await clean(page); }
    });
    await check('real GL resize accounts intermediate width/height peak before the first growth setter', async () => {
      const page = await pageFor({ drawingBufferPixels: 50000 });
      try {
        const result = await page.evaluate(() => {
          const baseline = Stage.resources().snapshot(), canvas = document.createElement('canvas'); canvas.width = canvas.height = 0;
          const renderer = ParticleGL.create({ resources: Stage.resources().port('adversarial-resize') });
          const view = { canvas, w: 100, h: 100, cx: 50, cy: 50, fade0: -1, fade1: -1 };
          const mounted = renderer.mount(view), initial = renderer.resize(view, { tier: 0, dpr: 1 });
          const writes = [], descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
          Object.defineProperty(canvas, 'width', { configurable: true, get() { return descriptor.get.call(this); },
            set(value) { writes.push(value); descriptor.set.call(this, value); } });
          view.w = 1000; view.h = 1;
          const accepted = renderer.resize(view, { tier: 0, dpr: 1 }), failed = renderer.resources(); renderer.dispose();
          return { baseline, mounted, initial, accepted, writes, failed, after: Stage.resources().snapshot() };
        });
        assert.equal(result.mounted, true); assert.equal(result.initial, true); assert.equal(result.accepted, false);
        assert.ok(!result.writes.includes(1000)); assert.ok(result.failed.mount.reason.includes('aggregate-budget'));
        sameVector(result.baseline.held, result.after.held); assert.equal(result.after.pending.drawingBufferPixels, 0); return result;
      } finally { await clean(page); }
    });
    await check('partial Canvas sprite failure returns every renderer ticket to its declared baseline', async () => {
      const page = await pageFor();
      try {
        const result = await page.evaluate(() => {
          const baseline = Stage.resources().snapshot(), getContext = HTMLCanvasElement.prototype.getContext;
          let calls = 0; StageParticles.init();
          HTMLCanvasElement.prototype.getContext = function (...args) {
            if (this.width === 32 && this.height === 32 && ++calls === 2) return null;
            return getContext.apply(this, args);
          };
          try { StageParticles.attach('standard'); }
          finally { HTMLCanvasElement.prototype.getContext = getContext; }
          const failed = StageParticles.stats(); StageParticles.destroy();
          return { baseline, failed, after: Stage.resources().snapshot(true) };
        });
        assert.equal(result.failed.renderer, 'none'); sameVector(result.baseline.held, result.after.held);
        assert.equal(result.after.resources, result.baseline.resources); assert.equal(result.after.pending.canvases, 0);
        assert.equal(result.after.hosts.length, 0); return result;
      } finally { await clean(page); }
    });
    await check('partial Canvas resize clears its not-yet-settled surface reservation', async () => {
      const page = await pageFor();
      try {
        await mount(page);
        const result = await page.evaluate(async () => {
          const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height'); let fired = false;
          Object.defineProperty(HTMLCanvasElement.prototype, 'height', { configurable: true, get: descriptor.get,
            set(value) { if (!fired && value === 77 && this.classList.contains('stage-particles')) { fired = true; throw new Error('injected height resize'); } descriptor.set.call(this, value); } });
          document.querySelector('#stage').style.width = '111px'; document.querySelector('#stage').style.height = '77px';
          await new Promise(resolve => setTimeout(resolve, 50)); await harness.advance(20);
          Object.defineProperty(HTMLCanvasElement.prototype, 'height', descriptor);
          const failed = StageParticles.stats(); StageParticles.destroy();
          return { fired, failed, after: Stage.resources().snapshot(true) };
        });
        assert.ok(result.fired); assert.equal(result.failed.renderer, 'none'); assert.equal(result.after.resources, 1);
        assert.equal(result.after.live.ownedCpuBytes, 96); assert.ok(Object.values(result.after.pending).every(value => value === 0)); return result;
      } finally { await clean(page); }
    });
    await check('twenty owner cycles and one hundred fast capacity changes have no monotonic ticket growth', async () => {
      const page = await pageFor();
      try {
        const result = await page.evaluate(async () => {
          const baseline = Stage.resources().snapshot(), cycles = [];
          for (let i = 0; i < 20; i++) {
            StageParticles.init(); StageParticles.attach(i % 2 ? 'enhanced' : 'standard'); await harness.advance(12);
            if (i === 0) for (let change = 0; change < 100; change++) StageParticles.set({ density: 20 + change % 80 });
            StageParticles.destroy(); cycles.push(Stage.resources().snapshot());
          }
          return { baseline, cycles };
        });
        for (const cycle of result.cycles) {
          sameVector(cycle.held, result.baseline.held); assert.equal(cycle.resources, result.baseline.resources);
          assert.ok(Object.values(cycle.pending).every(value => value === 0)); assert.equal(cycle.violations.length, 0);
        }
        return result;
      } finally { await clean(page); }
    });
    await check('production policy remains explicitly candidate and all independent guards use finite vectors', async () => {
      const page = await pageFor();
      try {
        const result = await page.evaluate(() => ({ policy: StageResourcePolicy, ledger: Stage.resources().snapshot() }));
        assert.equal(result.policy.contractVersion, 1); assert.ok(Object.values(result.policy.caps).every(Number.isSafeInteger));
        assert.equal(result.ledger.qualification, 'contract-test-only'); return result;
      } finally { await clean(page); }
    });
    assert.deepEqual(report.errors, []);
  } finally {
    await browser.close(); report.finishedAt = new Date().toISOString(); report.sourceSha256After = digest();
    report.sourceUnchanged = JSON.stringify(report.sourceSha256) === JSON.stringify(report.sourceSha256After);
    report.passed = report.sourceUnchanged && report.errors.length === 0 && report.checks.every(check => check.passed);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log('Evidence: ' + output); if (!report.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); report.fatal = error.stack; fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); process.exitCode = 1; });
