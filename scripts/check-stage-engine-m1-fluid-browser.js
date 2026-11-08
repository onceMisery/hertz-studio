'use strict';
// Production StageControl/StageFluid and the rebuilt solver; headless Chrome API evidence.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { fixtureHtml } = require('./check-stage-fluid-browser');
const root = path.resolve(__dirname, '..'), web = path.join(root, 'plugin/ui');
const out = path.join(root, 'output/a09-m1-20261108/fluid-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(out, { recursive: true });
const sources = ['stage-resource-budget.js', 'stage-resource-policy.js', 'stage.js', 'stage-fluid.js', 'vendor/stage-fluid.js'];
const digest = () => Object.fromEntries(sources.map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(web, name))).digest('hex')]));
const report = { scope: 'Fluid controlled allocations/lifecycle in production modules, real Chrome API. No physical GPU or complete M1 qualification.',
  startedAt: new Date().toISOString(), sourceSha256: digest(), checks: [], errors: [] };
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  if (name === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixtureHtml()); return; }
  const file = path.resolve(web, '.' + name);
  if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
let browser, base;
async function pageFor(caps = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => report.errors.push(error.stack));
  await page.addInitScript(caps => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { value: 12 });
    Object.defineProperty(navigator, 'deviceMemory', { value: 16 });
    let policy;
    Object.defineProperty(window, 'StageResourcePolicy', { configurable: true,
      get() { return policy; }, set(value) { policy = Object.freeze({ ...value,
        qualification: 'contract-test-only', caps: Object.freeze({ ...value.caps, ...caps }) }); } });
    window.fluidContexts = 0;
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (type === 'webgl2' && this.classList.contains('stage-fluid-canvas')) fluidContexts++;
      return original.call(this, type, ...args);
    };
  }, caps);
  await page.goto(base); await page.waitForFunction(() => window.fixtureReady && window.StageFluid);
  await page.evaluate(() => { StageControl.set({ quality: 'high', fluidEnabled: false }); });
  return page;
}
async function check(name, fn) {
  try { const evidence = await fn(); report.checks.push({ name, passed: true, evidence }); console.log('PASS ' + name); }
  catch (error) { report.checks.push({ name, passed: false, error: error.stack }); console.error('FAIL ' + name + ': ' + error.message); }
}
async function enable(page) {
  await page.evaluate(() => StageControl.set({ fluidEnabled: true }));
  await page.waitForFunction(() => StageFluid.stats().frames > 0 && StageFluid.stats().contexts === 1);
}
async function close(page) {
  await page.evaluate(() => { clearInterval(fixtureTimer); StageFluid.destroy(); StageParticles.destroy(); Stage.destroy(); });
  await page.close();
}
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    for (const [dimension, cap] of [['gpuContexts', 0], ['renderTargetDeclaredBytes', 200000]]) {
      await check(dimension + ' rejection precedes fluid getContext; request remains enabled', async () => {
        const page = await pageFor({ [dimension]: cap });
        try {
          await page.evaluate(() => StageControl.set({ fluidEnabled: true }));
          await page.waitForFunction(() => StageFluid.status().state === 'error');
          const result = await page.evaluate(() => ({ contexts: fluidContexts, status: StageFluid.status(),
            values: StageControl.values(), resources: Stage.resources().snapshot(true) }));
          assert.equal(result.contexts, 0); assert.equal(result.values.fluidEnabled, true);
          assert.equal(result.resources.live.gpuContexts, 0);
          assert.ok(result.resources.hosts.find(host => host.owner === 'stage-fluid').reasons.includes('aggregate-budget'));
          assert.ok(Object.values(result.resources.pending).every(value => value === 0)); return result;
        } finally { await close(page); }
      });
    }
    await check('fluid fixed targets include their declared half-float formats and resize surfaces', async () => {
      const page = await pageFor();
      try {
        const before = await page.evaluate(() => Stage.resources().snapshot()); await enable(page);
        const result = await page.evaluate(() => ({ stats: StageFluid.stats(), resources: Stage.resources().snapshot(true) }));
        assert.equal(result.resources.live.gpuContexts - before.live.gpuContexts, 1);
        assert.equal(result.resources.live.programs - before.live.programs, 9);
        assert.equal(result.resources.live.renderTargetDeclaredBytes - before.live.renderTargetDeclaredBytes,
          327680 + result.stats.outputPixels * 4);
        assert.equal(result.resources.live.textureDeclaredBytes, before.live.textureDeclaredBytes);
        assert.equal(result.resources.live.bufferDeclaredBytes - before.live.bufferDeclaredBytes, 32);
        assert.equal(result.resources.hosts.find(host => host.owner === 'stage-fluid').actualBackend, 'webgl2');
        assert.ok(Object.values(result.resources.pending).every(value => value === 0)); return { before, ...result };
      } finally { await close(page); }
    });
    await check('twenty complete fluid lifecycles and one hundred cancelled enables return to baseline', async () => {
      const page = await pageFor();
      try {
        const result = await page.evaluate(async () => {
          StageFluid.destroy(); const baseline = Stage.resources().snapshot(), cycles = [], active = [];
          const wait = () => new Promise((resolve, reject) => {
            const start = performance.now(); const poll = () => {
              if (Stage.resources().snapshot(true).hosts.some(host => host.owner === 'stage-fluid' && host.actualBackend === 'webgl2')) resolve();
              else if (performance.now() - start > 3000) reject(Error('fluid submit timeout')); else requestAnimationFrame(poll);
            }; poll();
          });
          for (let i = 0; i < 20; i++) {
            StageControl.set({ fluidEnabled: true }); StageFluid.init(); await wait();
            active.push(Stage.resources().snapshot()); StageFluid.destroy(); cycles.push(Stage.resources().snapshot());
          }
          StageControl.set({ fluidEnabled: false }); StageFluid.init();
          for (let i = 0; i < 100; i++) StageControl.set({ fluidEnabled: i % 2 === 0 });
          await Promise.resolve(); await Promise.resolve();
          StageFluid.destroy(); return { baseline, active, cycles, final: Stage.resources().snapshot() };
        });
        for (const active of result.active) assert.equal(active.live.gpuContexts, result.baseline.live.gpuContexts + 1);
        for (const retired of [...result.cycles, result.final]) {
          assert.deepEqual(retired.held, result.baseline.held); assert.equal(retired.listeners, result.baseline.listeners);
          assert.equal(retired.resources, result.baseline.resources); assert.equal(retired.violations.length, 0);
        }
        return result;
      } finally { await close(page); }
    });
    await check('real context loss cleans fluid; restored event cannot resurrect the old instance', async () => {
      const page = await pageFor();
      try {
        const baseline = await page.evaluate(() => Stage.resources().snapshot()); await enable(page);
        await page.evaluate(() => document.querySelector('.stage-fluid-canvas').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
        await page.waitForFunction(() => StageFluid.status().state === 'error');
        const result = await page.evaluate(() => {
          const contexts = fluidContexts; document.dispatchEvent(new Event('webglcontextrestored'));
          return { contexts, afterContexts: fluidContexts, stats: StageFluid.stats(), resources: Stage.resources().snapshot(true) };
        });
        assert.equal(result.afterContexts, result.contexts); assert.equal(result.stats.contexts, 0);
        assert.deepEqual(result.resources.held, baseline.held);
        assert.ok(result.resources.hosts.find(host => host.owner === 'stage-fluid').reasons.includes('context-lost')); return result;
      } finally { await close(page); }
    });
    await check('unknown resize and old plus intermediate new surface fail before allocation', async () => {
      const page = await pageFor({ drawingBufferPixels: 50000 });
      try {
        const result = await page.evaluate(() => {
          const baseline = Stage.resources().snapshot(), canvas = document.createElement('canvas'); canvas.width = canvas.height = 0;
          const engine = HertzFluidEngine.create(canvas, 2, { resources: Stage.resources().port('fluid-resize-test') });
          engine.resize(100, 100); const before = [canvas.width, canvas.height]; let reason, invalid;
          try { engine.resize(1000, 1); } catch (error) { reason = error.message; }
          try { engine.resize(Infinity, 1); } catch (error) { invalid = error.message; }
          const after = [canvas.width, canvas.height]; engine.dispose();
          return { baseline, before, after, reason, invalid, cleaned: Stage.resources().snapshot() };
        });
        assert.equal(result.reason, 'aggregate-budget'); assert.equal(result.invalid, 'estimate-unavailable');
        assert.deepEqual(result.before, result.after); assert.deepEqual(result.cleaned.held, result.baseline.held); return result;
      } finally { await close(page); }
    });
  } finally {
    await browser.close(); await new Promise(resolve => server.close(resolve));
    report.sourceSha256After = digest(); report.sourceUnchanged = JSON.stringify(report.sourceSha256) === JSON.stringify(report.sourceSha256After);
    report.finishedAt = new Date().toISOString(); report.passed = report.sourceUnchanged && !report.errors.length && report.checks.every(check => check.passed);
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log('Evidence: ' + out);
    if (!report.passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
