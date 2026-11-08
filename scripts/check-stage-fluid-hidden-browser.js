'use strict';
// Post-implementation regression: production Stage/StageControl/fluid in Chrome.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { fixtureHtml } = require('./check-stage-fluid-browser');
const root = path.resolve(__dirname, '..'), web = path.join(root, 'plugin/ui');
const out = path.join(root, 'output/playwright/stage-fluid-hidden-' + Date.now()); fs.mkdirSync(out, { recursive: true });
const report = { output: out, passed: false, observations: [], errors: [],
  scope: 'Real Chrome and production modules; controlled spectrum and track input; no native tray, OS DPI, physical GPU matrix or complete M1 qualification.' };
report.sources = Object.fromEntries(['stage.js', 'stage-control.js', 'stage-fluid.js', 'vendor/stage-fluid.js', 'design/design-themes.js'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(web, file))).digest('hex')]));
report.harnessSha256 = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  if (name === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixtureHtml(false)); return; }
  const file = path.resolve(web, '.' + name);
  if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
let browser;
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', error => report.errors.push(error.stack));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'hardwareConcurrency', { value: 12 });
      Object.defineProperty(navigator, 'deviceMemory', { value: 16 });
      const counts = window.fluidProbe = { drawArrays: 0, clear: 0, texImage2D: 0, canvasWidth: 0, canvasHeight: 0 };
      const get = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        const gl = get.call(this, type, ...args);
        if (type === 'webgl2' && this.classList.contains('stage-fluid-canvas') && gl && !gl.fluidObserved) {
          gl.fluidObserved = true;
          for (const name of ['drawArrays', 'clear', 'texImage2D']) {
            const original = gl[name]; gl[name] = function (...values) { counts[name]++; return original.apply(this, values); };
          }
        }
        return gl;
      };
      for (const name of ['width', 'height']) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, name);
        Object.defineProperty(HTMLCanvasElement.prototype, name, { ...descriptor, set(value) {
          if (this.classList.contains('stage-fluid-canvas')) counts[name === 'width' ? 'canvasWidth' : 'canvasHeight']++;
          return descriptor.set.call(this, value);
        } });
      }
    });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => window.fixtureReady);
    await page.evaluate(() => StageControl.set({ fluidEnabled: true }));
    await page.waitForFunction(() => StageFluid.status().state === 'active');
    await page.waitForTimeout(250);
    async function observe(label, action) {
      const before = await page.evaluate(() => ({ counts: { ...fluidProbe }, fluid: StageFluid.stats(), visible: Stage.isStageVisible() }));
      if (action) await page.evaluate(action);
      await page.waitForTimeout(200);
      const after = await page.evaluate(() => ({ counts: { ...fluidProbe }, fluid: StageFluid.stats(), visible: Stage.isStageVisible() }));
      const delta = Object.fromEntries(Object.keys(before.counts).map(key => [key, after.counts[key] - before.counts[key]]));
      report.observations.push({ label, before, after, delta });
    }
    await observe('visible-playing');
    // The responsive drawer is the existing ordinary hidden state. CSS-only
    // zero-size host admission remains a separate M1 qualification.
    await page.setViewportSize({ width: 390, height: 900 });
    await page.evaluate(() => document.body.classList.remove('stage-open'));
    await page.waitForTimeout(250);
    await observe('hidden-idle');
    await observe('hidden-resize', () => window.dispatchEvent(new Event('resize')));
    await observe('hidden-retint', () => document.dispatchEvent(new CustomEvent('stage:retint')));
    await observe('hidden-track-change', () => Stage.setTrack({ id: 'fluid-next', title: '下一段录音', duration_ms: 180000 }, fixtureCover));
    await observe('hidden-controls', () => StageControl.set({ fluidStrength: 47 }));
    await page.evaluate(() => document.body.classList.add('stage-open'));
    await page.waitForFunction(() => StageFluid.status().state === 'active');
    await observe('visible-resume');
    await page.evaluate(() => { clearInterval(fixtureTimer); Stage.setSnapshot({ track_id: 'fluid-next', playing: false, duration_ms: 180000, position_ms: 1000 }); });
    await page.waitForTimeout(300);
    await observe('paused-idle');
    await observe('paused-track-change', () => Stage.setTrack({ id: 'fluid-paused', title: '暂停时换曲', duration_ms: 180000 }, fixtureCover));
    await observe('paused-controls', () => StageControl.set({ fluidStrength: 59 }));
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(200);
    await observe('document-hidden-resize', () => window.dispatchEvent(new Event('resize')));
    await observe('document-hidden-controls', () => StageControl.set({ fluidStrength: 63 }));
    await observe('document-hidden-retint', () => document.dispatchEvent(new CustomEvent('stage:retint')));
    await observe('document-hidden-track-change', () => Stage.setTrack({ id: 'fluid-paused-next', title: '隐藏时换曲', duration_ms: 180000 }, fixtureCover));
    await observe('document-visible-paused', () => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await observe('exclusive-handoff', () => document.body.classList.add('s3d-open'));
    await observe('off', () => StageControl.set({ fluidEnabled: false }));
    await page.evaluate(() => { document.body.classList.remove('s3d-open'); document.getElementById('stage').style.display = 'none'; });
    await page.waitForTimeout(200);
    await observe('css-hidden-enable', () => StageControl.set({ fluidEnabled: true }));
    await observe('css-hidden-resize', () => window.dispatchEvent(new Event('resize')));
    await observe('css-hidden-controls', () => StageControl.set({ fluidStrength: 54 }));
    await observe('css-visible-paused', () => document.getElementById('stage').style.removeProperty('display'));
    await page.waitForFunction(() => StageFluid.stats().contexts === 1);
    await page.evaluate(() => document.getElementById('stage').style.display = 'none');
    await page.waitForTimeout(200);
    await observe('css-hidden-retained-idle');
    await observe('css-hidden-retained-track', () => Stage.setTrack({ id: 'fluid-css-next', title: '零尺寸时换曲', duration_ms: 180000 }, fixtureCover));
    await observe('css-hidden-retained-resize', () => window.dispatchEvent(new Event('resize')));
    await observe('css-visible-paused-resume', () => document.getElementById('stage').style.removeProperty('display'));
    await observe('css-off', () => StageControl.set({ fluidEnabled: false }));
    const observation = label => report.observations.find(item => item.label === label);
    for (const label of ['hidden-idle', 'hidden-resize', 'hidden-retint', 'hidden-track-change', 'hidden-controls',
      'document-hidden-resize', 'document-hidden-controls', 'document-hidden-retint', 'document-hidden-track-change']) {
      const item = observation(label);
      assert.equal(item.after.visible, false, label + ' retains original hidden state');
      for (const value of Object.values(item.delta)) assert.equal(value, 0, label + ' performs no GPU/surface writes');
      assert.equal(item.after.fluid.frames, item.before.fluid.frames, label + ' does not draw');
      assert.equal(item.after.fluid.steps, item.before.fluid.steps, label + ' does not simulate');
      assert.equal(item.after.fluid.pendingInputs, 0, label + ' drains old input');
      assert.equal(item.after.fluid.created, item.before.fluid.created, label + ' retains one instance');
    }
    for (const label of ['visible-playing', 'visible-resume']) {
      const item = observation(label);
      assert.ok(item.after.fluid.frames > item.before.fluid.frames, label + ' draws');
      assert.ok(item.after.fluid.outputPixels > 1, label + ' restores output dimensions');
    }
    for (const label of ['paused-track-change', 'paused-controls', 'document-visible-paused']) {
      const item = observation(label);
      assert.equal(item.after.fluid.steps, item.before.fluid.steps, label + ' remains frozen');
      assert.equal(item.after.fluid.frames - item.before.fluid.frames, 1, label + ' submits one static frame');
    }
    assert.equal(observation('paused-idle').delta.drawArrays, 0);
    for (const label of ['css-hidden-enable', 'css-hidden-resize', 'css-hidden-controls', 'css-hidden-retained-idle', 'css-hidden-retained-track', 'css-hidden-retained-resize']) {
      const item = observation(label);
      assert.equal(item.after.visible, true, label + ' preserves shared Stage visibility meaning');
      assert.equal(item.after.fluid.state, 'suspended', label + ' suspends only its own host');
      for (const value of Object.values(item.delta)) assert.equal(value, 0, label + ' performs no GPU/surface writes');
      assert.equal(item.after.fluid.steps, item.before.fluid.steps, label + ' does not simulate');
    }
    assert.equal(observation('css-hidden-enable').after.fluid.contexts, 0, 'initially CSS-hidden host allocates no context');
    assert.equal(observation('css-visible-paused').after.fluid.contexts, 1, 'layout restore prepares one instance');
    assert.ok(observation('css-visible-paused').after.fluid.outputPixels > 1);
    assert.equal(observation('css-visible-paused-resume').after.fluid.frames - observation('css-visible-paused-resume').before.fluid.frames, 1);
    assert.equal(observation('css-visible-paused-resume').delta.clear, 9);
    // Eight retained solver FBOs plus the default surface are cleared once.
    for (const label of ['paused-track-change', 'document-visible-paused']) assert.equal(observation(label).delta.clear, 9, label + ' resets once');
    for (const label of ['exclusive-handoff', 'off', 'css-off']) {
      const fluid = observation(label).after.fluid;
      for (const key of ['contexts', 'textures', 'framebuffers', 'programs', 'buffers', 'inputListeners', 'resizeObservers']) assert.equal(fluid[key], 0, label + ' releases ' + key);
      assert.equal(fluid.created, fluid.disposed, label + ' retires its instance');
    }
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output: out, passed: report.passed, observations: report.observations.length, errors: report.errors }));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
