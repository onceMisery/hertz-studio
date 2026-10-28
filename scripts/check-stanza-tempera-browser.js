'use strict';
// Production Pixi coverage for neutral themes, finite screen geometry and renderer lifetime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const web = path.join(__dirname, '../plugin/ui');
const output = path.join(__dirname, '../output/playwright/tempera');

function assertSpatial(sample, label) {
  const debug = sample.debug;
  assert.equal(debug.panels, 0, label + ': no panel allocation');
  assert.equal(debug.screens, 0, label + ': no screen layers');
  assert.equal(debug.screenPatterns, 0, label + ': no cached print geometry');
  assert.equal(debug.paperGrain, false, label + ': no paper grain');
  assert.equal(debug.seams, 0, label + ': no seam geometry');
  assert.equal(debug.seamsVisible, false, label + ': no visible seams');
  assert.equal(sample.printLabels, 0, label + ': print decor is absent even from hidden subtrees');
  assert.equal(debug.halation, false, label + ': halation pass disabled');
  assert.equal(sample.filters, 0, label + ': no optical filters attached to the display tree');
  assert.ok(debug.glyphs > 0 && sample.visiblePixels > 100, label + ': actual lyric/title pixels remain');
  assert.ok(sample.transparentRatio > 0.7, label + ': most pixels are exactly transparent, ratio=' + sample.transparentRatio);
  assert.ok(sample.meanAlpha > 0 && sample.meanAlpha < 0.3, label + ': local coverage without a full-screen veil, alpha=' + sample.meanAlpha);
}

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
      const render = PIXI.Application.prototype.render;
      PIXI.Application.prototype.render = function (...args) {
        f.app = this;
        return render.apply(this, args);
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
        spectrum: () => f.spectrum || [], kick() {}
      };
      f.renderer = StanzaTempera.init(document.getElementById('host'));
      f.renderer.setTheme(StanzaTheme.resolveTempera(1.35));
      f.renderer.setVisible(true);
      f.sample = (time, pixels = false) => {
        f.time = time; f.circles = 0;
        const start = performance.now();
        f.renderer.frame();
        const result = { ms: performance.now() - start, circles: f.circles, debug: f.renderer.getDebugSnapshot() };
        // Inspect the real display tree, including hidden children: suppressing
        // alpha alone must not masquerade as removing print allocations.
        result.printLabels = 0; result.filters = 0; result.waitingAlphas = [];
        const visit = node => {
          if (node instanceof PIXI.Text && /^No\.\d/.test(node.text)) result.printLabels += 1;
          if (node instanceof PIXI.Text && node.dataset && node.text.trim()
            && node.dataset.startTime > time / 1000) result.waitingAlphas.push(node.alpha);
          result.filters += node.filters ? node.filters.length : 0;
          if (node.children) node.children.forEach(visit);
        };
        visit(f.app.stage);
        if (pixels) {
          const canvas = document.querySelector('canvas'), copy = document.createElement('canvas');
          copy.width = canvas.width; copy.height = canvas.height;
          const ctx = copy.getContext('2d'); ctx.drawImage(canvas, 0, 0);
          const data = ctx.getImageData(0, 0, copy.width, copy.height).data;
          let chromatic = 0, residualHue = 0, hash = 2166136261, alpha = 0, transparent = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] > 8 && Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 30) chromatic += 1;
            if (data[i + 3] > 8 && Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 5) residualHue += 1;
            alpha += data[i + 3];
            if (data[i + 3] === 0) transparent += 1;
            hash = Math.imul(hash ^ (data[i] | data[i + 1] << 8 | data[i + 2] << 16 | data[i + 3] << 24), 16777619);
          }
          result.colorRatio = chromatic / (data.length / 4);
          result.residualHue = residualHue / (data.length / 4);
          result.pixelHash = hash >>> 0;
          result.meanAlpha = alpha / (data.length / 4) / 255;
          result.transparentRatio = transparent / (data.length / 4);
          result.visiblePixels = data.length / 4 - transparent;
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
    const spatial = await page.evaluate(() => {
      const f = fixture;
      const setting = { composition: 'fan-burst', colorMode: 'vivid', screens: true,
        inversion: true, halation: 0.9, seams: true };
      f.renderer.setTuning(setting); f.renderer.setBgMode('stage');
      const stage = f.sample(1500, true);
      const stageContexts = [...f.contexts].filter(([, count]) => count > 100).map(([context]) => context);
      f.renderer.setBgMode('spatial');
      const local = f.sample(1500, true);
      const releasedPrint = stageContexts.every(context => context.destroyed);
      // Pixel alpha measures coverage only; geometry counters, not color ratios
      // or screenshot differences, are the allocation/performance evidence.
      f.playing = true;
      const changes = [2800, 2950, 3000, 3120, 3400, 4500].map(time => {
        // A real spectrum onset exercises the full-screen flash guard, rather
        // than assuming the debug onset detector includes phrase accents.
        f.spectrum = new Float32Array(64).fill(time >= 3120 ? 0.8 : 0);
        return { time, ...f.sample(time, true) };
      });
      f.playing = false;
      const paused = f.sample(4500, true), pausedAgain = f.sample(4500, true);
      f.spectrum = [];
      const lines = f.lines;
      f.lines = [];
      const empty = f.sample(1500, true);
      const emptyNote = document.querySelector('.fl-tempera-note').textContent;
      f.lines = lines;
      const lyricsBack = f.sample(1500, true);
      f.renderer.setBgMode('stage');
      const restored = f.sample(1500, true);
      return { stage, local, releasedPrint, changes, paused, pausedAgain, empty, emptyNote, lyricsBack, restored };
    });
    assertSpatial(spatial.local, 'stage to spatial');
    assert.ok(spatial.local.meanAlpha < spatial.stage.meanAlpha * 0.45,
      'spatial alpha coverage is substantially below ordinary stage: ' + JSON.stringify([spatial.local.meanAlpha, spatial.stage.meanAlpha]));
    assert.ok(spatial.releasedPrint, 'entering spatial releases existing shared screens and paper contexts');
    assert.ok(spatial.local.waitingAlphas.length > 0 && spatial.local.waitingAlphas.every(alpha => alpha >= 0.74),
      'real Tempera tuning keeps every waiting glyph readable');
    for (const sample of spatial.changes) assertSpatial(sample, 'spatial line change at ' + sample.time);
    assert.ok(spatial.changes.some(sample => sample.debug.performance.impact > 0.02),
      'line-change fixture actually exercises a flash-triggering impulse: ' + JSON.stringify(spatial.changes.map(sample => [sample.time, sample.debug.performance.impact])));
    const stars = spatial.changes.find(sample => sample.time === 3120).debug.accents;
    assert.ok(stars && stars.visible && stars.particles > 0 && stars.particles <= 18, 'spatial retains a bounded local star accent at the line boundary');
    assert.equal(spatial.changes.at(-1).debug.accents.visible, false, 'line stars settle instead of becoming a persistent overlay');
    assert.notEqual(spatial.changes[0].pixelHash, spatial.changes.at(-1).pixelHash, 'changing lyrics changes rendered spatial pixels');
    assert.equal(spatial.paused.pixelHash, spatial.pausedAgain.pixelHash, 'spatial pixels remain identical while paused');
    assertSpatial(spatial.empty, 'spatial without lyrics');
    assert.ok(spatial.emptyNote.includes('暂无歌词'), 'no-lyrics title card keeps its existing empty-state message');
    assertSpatial(spatial.lyricsBack, 'spatial lyrics restored');
    assert.notEqual(spatial.empty.pixelHash, spatial.lyricsBack.pixelHash, 'restoring lyrics replaces the title-card pixels');
    assert.ok(spatial.restored.debug.panels > 0 && spatial.restored.debug.screens > 0, 'switching back to stage restores panel/screen allocations');
    assert.equal(spatial.restored.debug.paperGrain, true, 'switching back to stage restores paper grain');
    assert.equal(spatial.restored.debug.seamsVisible, true, 'switching back to stage restores seams');
    assert.equal(spatial.restored.debug.halation, true, 'spatial does not overwrite the saved halation setting');
    assert.ok(spatial.restored.filters > 0 && spatial.restored.printLabels > 0, 'switching back restores optical and print decor');
    assert.ok(Math.abs(spatial.restored.meanAlpha - spatial.stage.meanAlpha) < 0.01, 'restored stage recovers its original alpha coverage');
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

    // Cold spatial startup must skip construction, not build then hide an opaque stage.
    await page.evaluate(() => {
      const f = fixture;
      f.contexts.clear(); f.time = 1500;
      f.renderer = StanzaTempera.init(document.getElementById('host'));
      f.renderer.setTheme(StanzaTheme.resolveTempera(1.35));
      f.renderer.setBgMode('spatial');
      f.renderer.setVisible(true);
    });
    await page.waitForFunction(() => fixture.renderer.getDebugSnapshot().initialized);
    const cold = await page.evaluate(() => {
      const f = fixture, first = f.sample(1500, true);
      return { first, circlesBuilt: [...f.contexts.values()].reduce((sum, count) => sum + count, 0),
        printContextsBuilt: [...f.contexts.values()].filter(count => count > 100).length };
    });
    assertSpatial(cold.first, 'cold spatial startup');
    assert.equal(cold.printContextsBuilt, 0, 'cold spatial never builds paper or dot-screen contexts, including destroyed ones');
    assert.ok(cold.circlesBuilt < 350, 'cold spatial omits thousands of print circles, actual=' + cold.circlesBuilt);
    await page.setViewportSize(viewport);
    const coldLifetime = await page.evaluate(() => {
      const f = fixture;
      f.renderer.resize(); const resized = f.sample(1500, true);
      f.renderer.setVisible(false);
      const hidden = f.renderer.rootEl().hidden;
      f.renderer.setVisible(true); const reopened = f.sample(4500, true);
      f.renderer.destroy(); f.renderer.destroy();
      return { resized, hidden, reopened, readyAfterDestroy: f.renderer.isReady(),
        allFreed: [...f.contexts.keys()].every(context => context.destroyed) };
    });
    assertSpatial(coldLifetime.resized, 'spatial after resize');
    assert.equal(coldLifetime.hidden, true, 'spatial visibility toggle still hides the renderer');
    assertSpatial(coldLifetime.reopened, 'spatial after reopening');
    assert.equal(coldLifetime.readyAfterDestroy, false, 'destroyed spatial renderer is not ready');
    assert.ok(coldLifetime.allFreed, 'destroying spatial releases all of its local graphics contexts');
    assert.equal(await page.locator('#host > *').count(), 0, 'spatial destruction removes the whole renderer root');
    assert.deepEqual(errors, [], 'no shader, resource or page errors');
    console.log('PASS tempera ' + viewport.width + 'x' + viewport.height + ': palette, spatial coverage/allocation, restore, toggles, resize, destroy',
      JSON.stringify({ warmMs: metrics.slice(1).map(sample => +sample.ms.toFixed(1)), circles: metrics[1].circles,
        spatialAlpha: +spatial.local.meanAlpha.toFixed(4), stageAlpha: +spatial.stage.meanAlpha.toFixed(4),
        transparentRatio: +spatial.local.transparentRatio.toFixed(4), coldSpatialCircles: cold.circlesBuilt,
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
