'use strict';
// Production Pixi coverage for neutral themes, finite screen geometry and renderer lifetime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const web = path.join(__dirname, '../plugin/ui');
const output = path.join(__dirname, '../output/playwright/tempera');

async function run(browser, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (/error|warning/.test(message.type()) && /shader|WebGL|destroy|TypeError/i.test(message.text())) errors.push(message.text());
  });
  try {
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      :root{--music-highlight:#f4f4f5;--music-highlight-rgb:244,244,245}
      html,body{margin:0;width:100%;height:100%;background:#09090b;overflow:hidden}
      #host,.fl-tempera{position:absolute;inset:0}
      .fl-tempera-eyebrow,.fl-tempera-note,.fl-tempera-hot{display:none}
      </style><div id="host"></div>`);
    for (const file of ['vendor/pixi.min.js', 'stanza/stanza-util.js', 'stanza/stanza-theme.js',
      'stanza/stanza-sonnet-fx.js', 'stanza/stanza-sonnet.js', 'stanza/stanza-tempera.js']) {
      await page.addScriptTag({ path: path.join(web, file) });
    }
    await page.evaluate(() => {
      const f = window.fixture = { time: 1500, circles: 0, contexts: new Map(), playing: false };
      const circle = PIXI.GraphicsContext.prototype.circle;
      PIXI.GraphicsContext.prototype.circle = function (...args) {
        f.circles += 1;
        f.contexts.set(this, (f.contexts.get(this) || 0) + 1);
        return circle.apply(this, args);
      };
      f.lines = Array.from({ length: 15 }, (_, index) => ({
        start_ms: index * 3000, end_ms: (index + 1) * 3000,
        text: ['晚风轻轻吹过海面', '让每一颗星拥有自己的颜色', 'Hello 世界，听见 wind and light'][index % 3]
      }));
      f.track = { id: 'tempera-regression', title: '凝彩色彩与切句' };
      window.Stage = {
        presentation: () => ({ playing: f.playing, track: f.track }), position: () => f.time,
        lyrics: () => ({ lines: f.lines }),
        lyricTokens: line => [{ text: line.text, start_ms: line.start_ms, end_ms: line.end_ms }],
        spectrum: () => [], kick() {}
      };
      f.renderer = StanzaTempera.init(document.getElementById('host'));
      f.renderer.setTheme(StanzaTheme.resolveTempera(1.35));
      f.renderer.setVisible(true);
      f.sample = (time, pixels = false) => {
        f.time = time; f.circles = 0;
        const start = performance.now();
        f.renderer.frame();
        const result = { ms: performance.now() - start, circles: f.circles, debug: f.renderer.getDebugSnapshot() };
        if (pixels) {
          const canvas = document.querySelector('canvas'), copy = document.createElement('canvas');
          copy.width = canvas.width; copy.height = canvas.height;
          const ctx = copy.getContext('2d'); ctx.drawImage(canvas, 0, 0);
          const data = ctx.getImageData(0, 0, copy.width, copy.height).data;
          let chromatic = 0, residualHue = 0, hash = 2166136261, alpha = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] > 8 && Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 30) chromatic += 1;
            if (data[i + 3] > 8 && Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 5) residualHue += 1;
            alpha += data[i + 3];
            hash = Math.imul(hash ^ (data[i] | data[i + 1] << 8 | data[i + 2] << 16 | data[i + 3] << 24), 16777619);
          }
          result.colorRatio = chromatic / (data.length / 4);
          result.residualHue = residualHue / (data.length / 4);
          result.pixelHash = hash >>> 0;
          result.meanAlpha = alpha / (data.length / 4) / 255;
        }
        return result;
      };
    });
    await page.waitForFunction(() => fixture.renderer.getDebugSnapshot().initialized);
    assert.equal(await page.evaluate(() => fixture.renderer.isReady()), false, 'initialized canvas waits for its first frame');
    const metrics = await page.evaluate(() => {
      const f = fixture, samples = [];
      for (let i = 0; i < 12; i += 1) samples.push(f.sample(i * 3000 + 1500));
      return samples;
    });
    assert.ok(metrics[0].circles > 1500, 'initial frame builds the print surfaces');
    assert.ok(metrics.slice(1).every(sample => sample.circles < 350), 'line changes reuse dot/grain geometry');
    assert.ok(metrics.every(sample => sample.debug.screenPatterns <= 13), 'screen cache has a finite geometry budget');
    assert.equal(await page.evaluate(() => fixture.renderer.isReady()), true, 'first submitted frame makes the renderer ready');

    const colors = await page.evaluate(() => {
      const f = fixture, result = [];
      for (const bg of ['stage', 'image', 'atmosphere']) {
        for (const mode of ['duo', 'vivid', 'mono']) {
          f.renderer.setBgMode(bg); f.renderer.setTuning({ colorMode: mode });
          result.push({ bg, mode, ...f.sample(1500, true) });
        }
      }
      f.renderer.setTuning({ colorMode: 'vivid' }); f.sample(4500);
      return result;
    });
    for (const color of colors) {
      assert.ok(color.mode === 'mono' ? color.residualHue === 0 : color.colorRatio > 0.2,
        color.bg + '/' + color.mode + ': visible palette, ratio=' + color.colorRatio);
    }
    await page.screenshot({ path: path.join(output, 'tempera-' + viewport.width + 'x' + viewport.height + '.png') });
    const toggles = await page.evaluate(() => {
      const f = fixture;
      const setting = { composition: 'fan-burst', colorMode: 'vivid', screens: false, inversion: false, halation: 0, seams: false };
      f.renderer.setTuning(setting); const plain = f.sample(4500, true);
      f.renderer.setTuning({ ...setting, seams: true }); const seams = f.sample(4500, true);
      f.renderer.setTuning({ ...setting, screens: true }); const screens = f.sample(4500, true);
      f.renderer.setTuning(setting); const noGlow = f.sample(4500, true);
      f.renderer.setTuning({ ...setting, halation: 0.9 }); const glow = f.sample(4500, true);
      f.renderer.setTuning(setting); const glowOff = f.sample(4500, true);
      f.renderer.setTuning({ inversion: false }); const off = f.sample(4500);
      f.renderer.setTuning({ inversion: true }); const on = f.sample(4500);
      f.renderer.setEco(true); const eco = f.sample(4500);
      f.renderer.setEco(false); const restored = f.sample(4500);
      f.oldSurfaces = [...f.contexts].filter(([, count]) => count > 100).map(([context]) => context);
      return { plain, seams, screens, noGlow, glow, glowOff, off, on, eco, restored };
    });
    assert.equal(toggles.plain.debug.seams, 0, 'seam setting removes panel strokes');
    assert.ok(toggles.seams.debug.seams > 0, 'seam setting restores panel strokes');
    assert.notEqual(toggles.seams.pixelHash, toggles.plain.pixelHash, 'seam setting changes rendered pixels');
    assert.equal(toggles.plain.debug.screens, 0, 'screen setting removes screen layers');
    assert.equal(toggles.plain.debug.paperGrain, false, 'screen setting hides persistent paper grain');
    assert.equal(toggles.screens.debug.paperGrain, true, 'screen setting restores persistent paper grain');
    assert.notEqual(toggles.screens.pixelHash, toggles.plain.pixelHash, 'screen setting changes rendered pixels');
    assert.equal(toggles.noGlow.debug.halation, false, 'zero halation disables the optical pass');
    assert.equal(toggles.glow.debug.halation, true, 'positive halation enables the optical pass');
    assert.notEqual(toggles.glow.pixelHash, toggles.noGlow.pixelHash, 'halation changes rendered pixels');
    assert.equal(toggles.glow.circles, 0, 'halation slider changes no geometry');
    assert.equal(toggles.glowOff.circles, 0, 'disabling halation changes no geometry');
    assert.equal(toggles.glowOff.pixelHash, toggles.noGlow.pixelHash, 'disabling halation restores the exact prior frame');
    assert.equal(toggles.off.debug.clones, 0, 'disabled inversion allocates no duplicate text');
    assert.equal(toggles.on.debug.clones, toggles.on.debug.glyphs, 'inversion restores every glyph');
    assert.equal(toggles.eco.debug.screens, 0, 'eco removes print screens');
    assert.ok(toggles.restored.debug.screens > 0, 'leaving eco restores print screens');
    await page.setViewportSize({ width: viewport.width + 20, height: viewport.height + 12 });
    const lifetime = await page.evaluate(() => {
      const f = fixture; f.renderer.resize(); f.sample(4500);
      const oldFreed = f.oldSurfaces.every(context => context.destroyed);
      f.renderer.destroy(); f.renderer.destroy();
      return { oldFreed, allFreed: [...f.contexts.keys()].every(context => context.destroyed),
        remaining: f.oldSurfaces.filter(context => !context.destroyed).map(context => ({
          keys: Object.keys(context), instructions: context.instructions && context.instructions.length,
          destroyed: context.destroyed
        })) };
    });
    assert.ok(lifetime.oldFreed, 'resizing releases old shared print contexts: ' + JSON.stringify(lifetime));
    assert.ok(lifetime.allFreed, 'destroy releases shared and private graphics contexts');
    assert.equal(await page.locator('canvas').count(), 0, 'destroy removes the canvas');
    assert.deepEqual(errors, [], 'no shader, resource or page errors');
    console.log('PASS tempera ' + viewport.width + 'x' + viewport.height + ': palette, print reuse, toggles, resize, destroy',
      JSON.stringify({ warmMs: metrics.slice(1).map(sample => +sample.ms.toFixed(1)), circles: metrics[1].circles,
        colors: colors.map(color => [color.bg, color.mode, +color.colorRatio.toFixed(3)]) }));
  } finally { await page.close(); }
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await run(browser, viewport);
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
