'use strict';
// Real Pixi regression checks for transition ownership and bounded editorial-window work.
// No frame-time threshold: constructor/identity checks are stable across GPU and host load.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const web = path.join(__dirname, '../plugin/ui');

async function boot(browser, mode, layout) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => { if (/shader.*error|GL_INVALID|failed to compile/i.test(message.text())) errors.push(message.text()); });
  await page.setContent('<style>html,body,#host,.fl-sonnet,.fl-tempera{margin:0;position:absolute;inset:0;overflow:hidden}</style><div id="host"></div>');
  await page.addScriptTag({ path: path.join(web, 'vendor/pixi.min.js') });
  await page.evaluate(() => {
    window.probe = { texts: [], contexts: [], time: 0, playing: true, reduced: false, ordinaryBuilds: 0 };
    window.ProbedText = class extends PIXI.Text {
      constructor(options) { super(options); this.probeId = probe.texts.length; probe.texts.push(this); }
    };
    window.ProbedGraphics = class extends PIXI.Graphics {
      constructor(options) { super(options); if (!options || !options.context) probe.contexts.push(this.context); }
    };
  });
  for (const file of ['stanza-util.js', 'stanza-theme.js', 'stanza-sonnet-fx.js', 'stanza-sonnet.js', 'stanza-tempera.js']) {
    // Instrument construction only; ProbedText remains a real Pixi Text with its real GPU lifecycle.
    await page.addScriptTag({ content: fs.readFileSync(path.join(web, 'stanza', file), 'utf8')
      .replaceAll('new PIXI.Text(', 'new window.ProbedText(')
      .replaceAll('new PIXI.Graphics(', 'new window.ProbedGraphics(') });
  }
  await page.evaluate(({ mode, layout }) => {
    probe.lines = Array.from({ length: 100 }, (_, i) => ({ start_ms: i * 3000, end_ms: (i + 1) * 3000,
      text: '晚风送来一句轻轻的问候' + i }));
    probe.track = { id: 'transitions', path: 'transitions', title: 'transitions' };
    window.Stage = { presentation: () => ({ playing: probe.playing, reduced: probe.reduced, track: probe.track }),
      position: () => probe.time, lyrics: () => ({ lines: probe.lines }),
      lyricTokens: l => [{ text: l.text, start_ms: l.start_ms, end_ms: l.end_ms }], spectrum: () => [], kick() {} };
    const build = StanzaSonnetFx.buildLyrics;
    StanzaSonnetFx.buildLyrics = (...args) => { probe.ordinaryBuilds++; probe.words = build(...args); return probe.words; };
    const quality = StanzaSonnetFx.applyQuality;
    StanzaSonnetFx.applyQuality = (app, ...args) => { probe.app = app; return quality(app, ...args); };
    probe.renderer = (mode === 'sonnet' ? StanzaSonnet : StanzaTempera).init(document.getElementById('host'));
    probe.renderer.setTuning({ lyricLayout: layout });
    probe.renderer.setVisible(true);
    probe.sample = time => {
      const before = probe.texts.length, start = performance.now();
      probe.time = time; probe.renderer.frame();
      return { made: probe.texts.length - before, ms: +(performance.now() - start).toFixed(2),
        debug: probe.renderer.getDebugSnapshot(), ordinaryBuilds: probe.ordinaryBuilds };
    };
    probe.liveGlyphs = () => probe.texts.filter(n => !n.destroyed && n.dataset && Number.isFinite(n.dataset.startTime));
    probe.pose = () => probe.liveGlyphs().map(n => ({ text: n.text, start: n.dataset.startTime,
      x: n.x, y: n.y, alpha: n.alpha, tint: n.tint, sx: n.scale.x, sy: n.scale.y, rotation: n.rotation }));
  }, { mode, layout });
  await page.waitForFunction(() => probe.renderer.getDebugSnapshot().initialized);
  return { page, errors };
}

async function editorial(browser) {
  const { page, errors } = await boot(browser, 'sonnet', 'editorial-track');
  try {
    const result = await page.evaluate(() => {
      const readyBeforeFrame = probe.renderer.isReady();
      probe.sample(14990);
      const readyAfterFrame = probe.renderer.isReady();
      const old = probe.liveGlyphs();
      const boundary = probe.sample(15000);
      const live = probe.liveGlyphs();
      const kept = old.filter(n => live.includes(n)).length;
      const stable = probe.sample(15100);
      const pose = probe.pose();
      probe.playing = false; probe.sample(15100);
      const paused = probe.pose();
      probe.sample(100); probe.sample(15100);
      const sought = probe.pose();
      probe.renderer.setFontScale(1.2); probe.sample(15100);
      const resizedOld = live.every(n => n.destroyed);
      probe.renderer.setEco(true); const eco = probe.sample(15100);
      probe.reduced = true; const reduced = probe.sample(15100);
      const all = probe.texts.slice(); probe.renderer.destroy();
      return { boundary, stable, kept, oldCount: old.length, pose, paused, sought, resizedOld, eco, reduced,
        readyBeforeFrame, readyAfterFrame, readyAfterDestroy: probe.renderer.isReady(),
        allDestroyed: all.every(n => n.destroyed), contextsDestroyed: probe.contexts.every(c => c.destroyed),
        canvases: document.querySelectorAll('canvas').length };
    });
    assert.equal(result.boundary.ordinaryBuilds, 0, 'editorial does not build hidden ordinary lyrics');
    assert.equal(result.readyBeforeFrame, false, 'initialized renderer is not ready until it has submitted a frame');
    assert.equal(result.readyAfterFrame, true, 'public readiness opens after the first frame');
    assert.equal(result.readyAfterDestroy, false, 'destroyed renderer is not ready');
    assert.equal(result.boundary.debug.editorial.trackEntries, 7, 'editorial window remains bounded to seven entries');
    assert.ok(result.kept >= result.oldCount * 0.8, 'adjacent editorial windows retain their overlapping glyph identities');
    assert.ok(result.boundary.made <= 16, 'boundary builds only one new lyric entry, its marker and background word');
    assert.equal(result.stable.made, 0, 'steady playback allocates no text');
    assert.deepEqual(result.paused, result.pose, 'pause preserves the typography pose');
    assert.deepEqual(result.sought, result.pose, 'seek reconstructs the same typography pose');
    assert.ok(result.resizedOld, 'font-scale change invalidates retained entries');
    assert.equal(result.eco.debug.editorial.trackEntries, 4, 'eco uses the smaller entry window');
    assert.equal(result.reduced.debug.retirement.outgoingGlyphs, 0, 'reduced motion clears retirement');
    assert.ok(result.allDestroyed, 'destroy releases every allocated Text including window retirees');
    assert.ok(result.contextsDestroyed, 'destroy releases private GraphicsContext objects across every retained and retired entry');
    assert.equal(result.canvases, 0);
    assert.deepEqual(errors, []);
    console.log('PASS editorial: seven-entry window, retained identities, one-entry allocation, pause/seek/font/eco/reduced/destroy; boundary ' + result.boundary.ms + 'ms');
  } finally { await page.close(); }
}

async function retirement(browser, mode) {
  const { page, errors } = await boot(browser, mode, 'phrases');
  try {
    const result = await page.evaluate(() => {
      probe.sample(2990);
      const old = probe.words.slice(), made = probe.texts.length;
      const handoff = probe.sample(3000);
      const allNewHaveCurrentTime = probe.texts.slice(made).filter(n => n.dataset)
        .every(n => n.dataset.startTime >= 3);
      const retained = old.filter(n => !n.destroyed).length;
      probe.sample(3060);
      probe.playing = false; const pause = probe.sample(3060);
      probe.playing = true; const settled = probe.sample(3260);
      const released = old.every(n => n.destroyed);
      probe.sample(5990); probe.sample(6000); const seek = probe.sample(15000);
      probe.renderer.destroy();
      return { handoff, pause, settled, seek, retained, released, allNewHaveCurrentTime,
        allDestroyed: probe.texts.every(n => n.destroyed), contextsDestroyed: probe.contexts.every(c => c.destroyed) };
    });
    assert.ok(result.retained > 0, mode + ': outgoing Text objects survive handoff');
    assert.equal(result.handoff.debug.retirement.outgoingGlyphs, result.retained);
    assert.ok(result.allNewHaveCurrentTime, mode + ': retirement creates no duplicate old lyric Text');
    assert.ok(result.pause.debug.retirement.outgoingGlyphs > 0, mode + ': pause retains the handoff pose');
    assert.equal(result.settled.debug.retirement.outgoingGlyphs, 0);
    assert.ok(result.released, mode + ': retirement owns and releases outgoing glyphs');
    assert.equal(result.seek.debug.retirement.outgoingGlyphs, 0);
    assert.ok(result.allDestroyed, mode + ': destroy releases all Text');
    assert.ok(result.contextsDestroyed, mode + ': destroy releases all private GraphicsContext objects');
    assert.deepEqual(errors, []);
    console.log('PASS ' + mode + ': outgoing ownership transfer, no duplicate Text, pause/retire/seek/destroy');
  } finally { await page.close(); }
}

async function sharedContext(browser) {
  const { page, errors } = await boot(browser, 'sonnet', 'phrases');
  try {
    const result = await page.evaluate(() => {
      const root = new PIXI.Container(), branch = new PIXI.Container();
      const own = new PIXI.Graphics().circle(0, 0, 10).fill(0xffffff), privateContext = own.context;
      const shared = new PIXI.GraphicsContext().circle(0, 0, 10).fill(0xffffff);
      const first = new PIXI.Graphics({ context: shared }), second = new PIXI.Graphics({ context: shared });
      branch.addChild(own, first); root.addChild(branch);
      StanzaSonnetFx.destroyDisplayTree(root); StanzaSonnetFx.destroyDisplayTree(root);
      const result = { privateReleased: privateContext.destroyed, sharedLive: !shared.destroyed && !second.destroyed,
        descendantsReleased: own.destroyed && first.destroyed && branch.destroyed };
      second.destroy(); shared.destroy(); probe.renderer.destroy(); return result;
    });
    assert.ok(result.privateReleased && result.sharedLive && result.descendantsReleased,
      'recursive disposal releases private resources while another Graphics still holds its shared context');
    assert.deepEqual(errors, []);
    console.log('PASS resource ownership: nested private disposal, shared context survives, repeated disposal is safe');
  } finally { await page.close(); }
}

async function opticalTransparency(browser, mode) {
  const { page, errors } = await boot(browser, mode, 'phrases');
  try {
    const result = await page.evaluate(mode => {
      probe.renderer.setBgMode('stage');
      probe.playing = false;
      function sample() {
        const frame = probe.sample(2500), canvas = probe.app.canvas, gl = probe.app.renderer.gl;
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let transmission = 0, nonOpaque = 0, zero = 0, invalidPremult = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const alpha = pixels[i + 3];
          transmission += (255 - alpha) / 255;
          if (alpha < 250) nonOpaque++;
          if (alpha === 0) zero++;
          if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > alpha + 1) invalidPremult++;
        }
        return { frame, pixels, transmission: transmission / (pixels.length / 4),
          nonOpaque: nonOpaque / (pixels.length / 4), zero, invalidPremult };
      }
      const on = sample();
      probe.renderer.setTuning({ halation: 0 });
      const off = sample();
      probe.renderer.setTuning({ halation: 0.5 });
      const restored = sample();
      let addedLight = 0, preservedEmpty = 0;
      for (let i = 0; i < on.pixels.length; i += 4) {
        for (let c = 0; c < 3; c++) addedLight += Math.max(0, on.pixels[i + c] - off.pixels[i + c]);
        if (off.pixels[i + 3] === 0 && on.pixels[i + 3] === 0) preservedEmpty++;
      }
      const report = { on, off, restored, addedLight, preservedEmpty };
      if (mode === 'sonnet') {
        probe.renderer.setTuning({ halation: 0.5, atmosphere: false });
        report.atmosphereOff = sample().frame;
        probe.renderer.setTuning({ halation: 0.5, atmosphere: true });
        report.atmosphereOn = sample().frame;
        probe.renderer.setTuning({ halation: 0.5, atmosphere: true, decor: false });
        report.decorOff = probe.sample(2500);
        report.decorHidden = ['.fl-sonnet-eyebrow', '.fl-sonnet-hud'].every(s => document.querySelector(s).hidden);
        report.nextRetained = !document.querySelector('.fl-sonnet-next').hidden;
        probe.renderer.setTuning({ halation: 0.5, atmosphere: true, decor: true });
        report.decorOn = probe.sample(2500);
        report.decorRestored = ['.fl-sonnet-eyebrow', '.fl-sonnet-hud'].every(s => !document.querySelector(s).hidden);
        const words = probe.words;
        probe.renderer.setTuning({ halation: 0.5, accents: false });
        report.accentsOff = probe.sample(2500);
        probe.renderer.setTuning({ halation: 0.5, accents: true });
        report.accentsOn = probe.sample(2500);
        report.sameWords = words === probe.words;
      }
      for (const sample of [on, off, restored]) delete sample.pixels;
      probe.renderer.destroy(); return report;
    }, mode);
    assert.ok(result.on.frame.debug.halation, mode + ': stage default enables halation');
    assert.equal(result.off.frame.debug.halation, false, mode + ': actual setTuning(halation:0) removes the filter');
    assert.ok(result.restored.frame.debug.halation, mode + ': actual setTuning restores halation');
    for (const state of ['on', 'off', 'restored']) {
      assert.ok(result[state].transmission > 0.05 && result[state].nonOpaque > 0.1,
        mode + ': ' + state + ' leaves the underlying stage visible ' + JSON.stringify(result[state]));
      assert.equal(result[state].invalidPremult, 0, mode + ': ' + state + ' output RGB obeys premultiplied alpha');
    }
    assert.ok(result.addedLight > 0, mode + ': enabled halation adds actual light');
    if (mode === 'sonnet') {
      assert.ok(result.preservedEmpty > 100, 'halation preserves empty transparent pixels');
      assert.equal(result.atmosphereOff.debug.atmosphereVisible, false, 'actual setTuning hides atmosphere');
      assert.ok(result.atmosphereOn.debug.atmosphereVisible, 'actual setTuning restores atmosphere');
      assert.ok(result.decorOff.debug.atmosphereVisible, 'decor=false keeps independently enabled atmosphere visible');
      assert.equal(result.decorOff.debug.decorationsVisible, false, 'decor=false hides the Pixi frame, HUD and corner marks');
      assert.equal(result.decorOff.made + result.decorOn.made, 0, 'decor toggles do not rebuild text');
      assert.equal(result.accentsOff.made + result.accentsOn.made, 0, 'accent toggles do not rebuild text');
      assert.equal(result.accentsOff.debug.accents.visible, false, 'disabling accents reaches the choreography layer');
      assert.ok(result.sameWords, 'presentation toggles preserve the active glyph identities');
      assert.equal(result.atmosphereOff.made, 0, 'changing optical settings does not rebuild text');
      assert.ok(result.decorHidden && result.decorRestored, 'decor toggles the DOM title and HUD');
      assert.ok(result.nextRetained, 'decor keeps next-line lyrics available');
    }
    assert.deepEqual(errors, []);
    console.log('PASS ' + mode + ': real settings and premultiplied stage alpha; transmission on/off '
      + result.on.transmission.toFixed(3) + '/' + result.off.transmission.toFixed(3));
  } finally { await page.close(); }
}

async function initializationFailure(browser) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await page.route('http://stanza-fixture.test/**', route => {
      if (route.request().url().endsWith('/vendor/pixi.min.js')) return route.abort('failed');
      return route.fulfill({ contentType: 'text/html', body: '<style>html,body,#host{margin:0;position:absolute;inset:0}</style><div id="host"></div>' });
    });
    await page.goto('http://stanza-fixture.test/');
    await page.addStyleTag({ path: path.join(web, 'stanza/stanza.css') });
    for (const file of ['stanza-util.js', 'stanza-theme.js', 'stanza-sonnet-fx.js', 'stanza-sonnet.js']) {
      await page.addScriptTag({ path: path.join(web, 'stanza', file) });
    }
    const before = await page.evaluate(() => {
      const lines = [{ text: '有歌词时也必须显示加载错误', start_ms: 0, end_ms: 3000 }];
      window.Stage = { presentation: () => ({ playing: false, track: { id: 'failed-pixi' } }), position: () => 1200,
        lyrics: () => ({ lines }), lyricTokens: l => [{ text: l.text, start_ms: l.start_ms, end_ms: l.end_ms }], spectrum: () => [], kick() {} };
      window.failedRenderer = StanzaSonnet.init(document.getElementById('host'));
      failedRenderer.setTuning({ decor: false }); failedRenderer.setVisible(true);
      return failedRenderer.isReady();
    });
    assert.equal(before, false, 'loading renderer has no ready frame or error yet');
    await page.waitForFunction(() => failedRenderer.isReady());
    const message = page.locator('.fl-sonnet .fl-empty');
    assert.ok(await message.isVisible(), 'Pixi loading error is visible with decor disabled');
    assert.match(await message.textContent(), /图形引擎不可用/);
    await page.evaluate(() => { for (let i = 0; i < 4; i++) failedRenderer.frame(); failedRenderer.setTuning({ decor: true }); failedRenderer.setTuning({ decor: false }); failedRenderer.frame(); });
    assert.ok(await message.isVisible(), 'subsequent lyric frames and decor toggles keep the error visible');
    assert.match(await message.textContent(), /图形引擎不可用/);
    await page.evaluate(() => failedRenderer.destroy());
    assert.equal(await page.evaluate(() => failedRenderer.isReady()), false);
    console.log('PASS failed initialization: blocked Pixi load, decor-independent error, stable frames and public readiness');
  } finally { await page.close(); }
}

(async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    if (!process.argv.includes('--optical-only')) {
      await initializationFailure(browser);
      await sharedContext(browser); await editorial(browser);
      for (const mode of ['sonnet', 'tempera']) await retirement(browser, mode);
    }
    for (const mode of ['sonnet', 'tempera']) await opticalTransparency(browser, mode);
  }
  finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
