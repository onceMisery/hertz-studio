// SPDX-License-Identifier: MIT
// Post-implementation acceptance using the rebuilt UI and an isolated null service.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output/playwright/workshop-looks');
const report = { checks: [], samples: {}, geometry: [], pageErrors: [], shaderErrors: [] };
const pass = label => { report.checks.push(label); console.log('PASS ' + label); };

async function until(probe, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await probe()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
}

// Observe the production render call. Reading pixels here, before browser
// compositing clears the buffer, checks the shader rather than the SVG overlay.
async function instrument(page) {
  await page.evaluate(() => {
    window.__lookSamples = {};
    window.__lookRenderErrors = [];
    window.__lookFrame = null;
    const create = CreativeGL.create;
    CreativeGL.create = (canvas, ...args) => {
      const engine = create(canvas, ...args), render = engine.render;
      engine.render = state => {
        const result = render(state);
        if (!canvas.closest('#s3d-creative')) return result;
        const frame = { scene: state.scene, t: state.t, cam: { ...state.cam }, post: { ...state.post },
          play: state.play, renderedAt: performance.now() };
        window.__lookFrame = frame;
        if (!result.ok) __lookRenderErrors.push(result);
        if (window.__readLookPixels) {
          const label = window.__readLookPixels;
          window.__readLookPixels = null;
          const gl = canvas.getContext('webgl2'), width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
          const pixels = new Uint8Array(width * height * 4);
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          const samples = [], stride = Math.max(1, Math.floor(width * height / 4096));
          let visible = 0, luma = 0, chroma = 0;
          for (let p = 0; p < width * height; p += stride) {
            const i = p * 4, r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
            samples.push(r, g, b);
            if (Math.max(r, g, b) > 18) visible++;
            luma += .2126 * r + .7152 * g + .0722 * b;
            chroma += Math.max(r, g, b) - Math.min(r, g, b);
          }
          const n = samples.length / 3;
          __lookSamples[label] = { ...frame, width, height, samples,
            visible: visible / n, luma: luma / n, chroma: chroma / n, glError: gl.getError() };
        }
        return result;
      };
      return engine;
    };
  });
}

async function sample(page, label) {
  await page.evaluate(name => { window.__readLookPixels = name; CreativeStage.kick(); }, label);
  await page.waitForFunction(name => !!window.__lookSamples[name], label);
  const value = await page.evaluate(name => __lookSamples[name], label);
  assert.equal(value.glError, 0, label + ' has no WebGL errors');
  assert.ok(value.visible > .002, label + ' has visible scene pixels');
  const { samples, ...summary } = value;
  report.samples[label] = summary;
  return value;
}

function pixelDelta(a, b) {
  assert.equal(a.samples.length, b.samples.length, 'same sized shader captures');
  return a.samples.reduce((sum, value, i) => sum + Math.abs(value - b.samples[i]), 0) / a.samples.length;
}

async function ready(page, trackId) {
  await page.waitForFunction(id => window.Workshop && window.CreativeStage &&
    document.querySelector('#conn.ok') && Stage.presentation().track?.id === id &&
    Stage.lyrics()?.lines?.length >= 5, trackId);
  await page.evaluate(() => document.fonts.ready);
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const fixture = await startFixture();
  let browser, page;
  try {
    const track = await fixture.seed();
    fs.writeFileSync(path.join(path.dirname(fixture.dataDir), 'music/layout.lrc'),
      '[00:00.00]晚风吹过你的眼睛\n[00:05.00]把星光画进这一页\n[00:10.00]听见远方温柔的回声\n[00:17.00]让每一颗星都有颜色\n[00:22.00]我们沿着星光继续向前走\n');
    await fixture.api('/v1/library/scan', 'POST', { root: path.join(path.dirname(fixture.dataDir), 'music') });
    await until(async () => !(await fixture.api('/v1/library/status')).running, 'sidecar lyrics scanned');
    await fixture.api('/v1/player/load', 'POST', { track_id: track.id, queue: [track.id] });
    await fixture.api('/v1/player/pause', 'POST', {});
    await fixture.api('/v1/player/seek', 'POST', { position_ms: 7500 });
    await fixture.api('/v1/settings', 'PUT', { cover_follow: false, reduce_motion: false, render_mode: 'standard' });
    for (const file of ['stage3d.js', 'stage3d.css', 'stage-freecam.js', 'creative-stage.js', 'creative-gl.js', 'creative.css', 'handdrawn.js', 'workshop.js']) {
      const response = await fetch(fixture.base + '/' + file);
      assert.equal(response.status, 200, 'served ' + file);
      assert.equal((await response.text()).replace(/\r\n/g, '\n'),
        fs.readFileSync(path.join(root, 'plugin/ui', file), 'utf8').replace(/\r\n/g, '\n'), 'current embedded asset: ' + file);
    }
    pass('isolated null backend and current embedded assets');

    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
    await fixture.connect(context);
    page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('console', message => {
      if (/shader.*(error|fail)|着色器.*失败|GL_INVALID|INVALID_OPERATION/i.test(message.text())) report.shaderErrors.push(message.text());
    });
    await page.goto(fixture.base, { waitUntil: 'domcontentloaded' });
    await ready(page, track.id);
    await instrument(page);
    const baseline = await page.evaluate(() => ({ stage: Stage3D.preferences(), creative: CreativeStage.preset() }));
    assert.deepEqual(await page.evaluate(() => Stage3D.defaults()), baseline.stage, 'defaults match a fresh installation, including every preference');
    await page.evaluate(() => { Theme.apply('emerald'); Stage.setMode('cover'); });
    const surroundings = await page.evaluate(() => ({ theme: Theme.current(), sidebarMode: document.getElementById('stage').dataset.mode,
      renderer: StageParticles.renderer(), requestedRenderer: StageParticles.mode() }));
    const queue = await fixture.api('/v1/player/queue');

    await page.locator('#stage3d-entry').click();
    await page.waitForTimeout(250);
    baseline.camera = await page.evaluate(() => Stage3D.stats().camera);
    report.initialStageCamera = baseline.camera;
    await page.evaluate(() => { Workshop.open(); Workshop.setTab('scene'); CreativeStage.setDirector(false); });
    await page.waitForFunction(() => CreativeStage.stageActive() && !!__lookFrame);
    baseline.creativeCamera = (await sample(page, 'fresh-creative-camera')).cam;
    await page.locator('.ws-scene-card[data-scene="orb"]').click();
    await page.locator('#ws-body .ws-name').fill('保留作品 · 默认与漫画验收');
    await page.getByRole('button', { name: '存进工坊', exact: true }).click();
    const saved = await page.evaluate(() => CreativeStage.library()[0]);
    assert.equal(saved.name, '保留作品 · 默认与漫画验收');
    await page.evaluate(() => Workshop.setTab('look'));
    for (const style of ['manga', 'anime']) {
      await page.locator('.ws-look-card[data-style="' + style + '"]').click();
      await page.screenshot({ path: path.join(out, style + '-preview.png') });
    }
    await page.locator('#ws-close').click();

    async function dirty(source) {
      await page.evaluate(which => {
        const otherWallpaper = ThemeStudio.wallpapers().find(item => item.id !== Stage3D.defaults().stanzaWallpaper);
        CreativeStage.setScene('orb');
        CreativeStage.setDirector(false);
        CreativeStage.patch({ 'cam.yaw': 35, 'cam.pitch': 25, 'cam.dist': 6, 'look.exposure': 1.8, 'stage.scale': 1.2 });
        CreativeStage.setBackground({ type: 'mesh', opacity: 40, blur: 25 });
        CreativeStage.setHandDrawn({ on: true, style: 'manga', paper: true, frame: true, wave: true, jitter: 80 });
        CreativeStage.addCue({ at: 2, len: 1000, set: { 'look.exposure': 1.6 } });
        CreativeStage.setBindings([{ source: 'bass', target: 'cam.kick', amount: 12 }]);
        CreativeStage.setInteract(true);
        Stage3D.configure({ scene: 'tunnel', sceneSource: which === 'creative' ? 'creative' : 'immersive',
          motion: .15, bloom: 1.4, reactivity: .4, lyrics: which === 'stanza', cruise: false, layout: 'sleeve', lyricSize: 1.4, lyricGlow: .9,
          shelfMode: 'off', stageTheme: 'ios', stanzaVisual: which === 'creative' ? 'stage' : 'tempera', stanzaBg: 'solid',
          stanzaBgOpacity: .2, stanzaVignette: false, stanzaSubtitle: false, stanzaWallpaperDim: .7,
          stanzaWallpaper: otherWallpaper && otherWallpaper.id,
          classicTuning: { rotation: false, breathing: .2, spacing: 1.3 },
          cadenzaTuning: { width: .6, motion: .2, glow: .2, beam: 1 },
          sonnetTuning: { shotFlow: 'orbit', lyricLayout: 'lines', phraseLength: 20, decor: false, accents: false, halation: .1, atmosphere: false },
          temperaTuning: { composition: StanzaTempera.COMPOSITION_KINDS[0], colorMode: 'vivid', screens: false, inversion: false, halation: .1, seams: false },
          autoLock: 8, autoAvoidRepeat: false });
      }, source);
      if (source === 'creative') {
        await page.mouse.move(300, 300);
        await page.mouse.down();
        await page.mouse.move(500, 380, { steps: 5 });
        await page.mouse.up();
      } else {
        await page.waitForFunction(() => Stage3D.visualState().effective === 'tempera' && !!document.querySelector('.fl-tempera-canvas'));
        assert.equal(await page.locator('#s3d-stanza').isVisible(), true, 'the stanza renderer actually owns the visible stage');
      }
    }

    async function assertReset(label) {
      await page.waitForTimeout(200);
      const state = await page.evaluate(() => ({ stage: Stage3D.preferences(), creative: CreativeStage.preset(),
        stats: CreativeStage.stats(), interact: CreativeStage.isInteract(), hand: HandDrawn.stats(), bg: Backgrounds.stats(),
        camera: Stage3D.stats().camera, freecam: StageFreecam.isBusy(),
        surroundings: { theme: Theme.current(), sidebarMode: document.getElementById('stage').dataset.mode,
          renderer: StageParticles.renderer(), requestedRenderer: StageParticles.mode() } }));
      assert.deepEqual(state.stage, baseline.stage, label + ' restores every stage preference');
      assert.deepEqual(state.creative, baseline.creative, label + ' restores the complete creative preset');
      assert.equal(state.stats.animations, 0, label + ' clears running cues');
      assert.equal(state.interact, false, label + ' clears interactive camera state');
      assert.equal(state.freecam, false, label + ' leaves the free camera inactive');
      (report.resetCameras || (report.resetCameras = [])).push({ label, camera: state.camera });
      // The default cruise intentionally keeps its independent clock. Its
      // small breathing offset may change between captures; authored offsets
      // and drag inertia must still return within that default camera range.
      for (const [key, tolerance] of [['theta', .05], ['phi', .05], ['radius', .5]]) {
        assert.ok(Math.abs(state.camera[key] - baseline.camera[key]) < tolerance,
          label + ' restores the default camera range ' + key + ': ' + JSON.stringify(state.camera));
      }
      assert.equal(state.hand.on, false, label + ' disables hand overlay');
      assert.equal(state.bg.type, 'theme', label + ' restores theme background');
      assert.equal(await page.evaluate(() => CreativeStage.stageActive()), false, label + ' returns visible ownership to immersive');
      assert.deepEqual(state.surroundings, surroundings, label + ' preserves app theme and sidebar renderer');
      assert.deepEqual(await fixture.api('/v1/player/queue'), queue, label + ' preserves playback queue');
      assert.deepEqual(await page.evaluate(id => CreativeStage.library().find(p => p.id === id), saved.id), saved, label + ' keeps saved work');
      assert.equal(await page.locator('#s3d-fallback').isVisible(), false, label + ' has no rendering fallback');
      pass(label);
    }

    for (const source of ['creative', 'stanza']) for (const entry of ['workshop', 'stage']) {
      await dirty(source);
      if (entry === 'workshop') {
        await page.evaluate(which => { Workshop.open(); if (which === 'creative') Workshop.setTab('look'); }, source);
        assert.equal(await page.locator('#ws-defaults').isEnabled(), true, source + ' takeover keeps reset enabled');
        await page.locator('#ws-defaults').click();
        await page.waitForFunction(() => document.getElementById('ws-defaults').getAttribute('aria-busy') !== 'true');
        await assertReset(source + ' takeover → workshop reset');
        await page.locator('#ws-close').click();
      } else {
        await page.mouse.move(500, 200);
        await page.locator('#s3d-settings-toggle').click();
        await page.locator('#s3d-defaults').click();
        await page.waitForFunction(() => !document.getElementById('s3d-defaults').disabled);
        await assertReset(source + ' takeover → stage settings reset');
        await page.locator('#s3d-settings-close').click();
      }
    }
    await page.locator('#s3d-settings-toggle').click();
    report.storageFailure = await page.evaluate(async () => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'vmusic.creative.preset') throw new DOMException('Acceptance fixture storage failure', 'QuotaExceededError');
        return setItem.call(this, key, value);
      };
      let rejected = false, message = '';
      try { await Stage3D.resetSettings(); }
      catch (error) { rejected = true; message = error.message; }
      finally { Storage.prototype.setItem = setItem; }
      return { rejected, message, note: document.getElementById('s3d-defaults-note').textContent };
    });
    assert.equal(report.storageFailure.rejected, true, 'a preset storage failure rejects the reset');
    assert.match(report.storageFailure.note, /未完成|暂未保存|重试/, 'failed reset does not claim persistence succeeded');
    assert.equal(await page.locator('#s3d-defaults').isEnabled(), true, 'failed reset allows a retry');
    await page.screenshot({ path: path.join(out, 'storage-failure.png') });
    await page.locator('#s3d-defaults').click();
    await page.waitForFunction(() => !document.getElementById('s3d-defaults').disabled);
    await assertReset('storage failure reports failure and the next reset succeeds');
    await page.locator('#s3d-settings-close').click();
    await page.evaluate(() => { Workshop.open(); Workshop.setTab('scene'); Workshop.close(); StageFreecam.setEnabled(true); });
    assert.equal(await page.evaluate(() => StageFreecam.isEnabled()), true, 'free camera can be enabled on this device');
    await fixture.api('/v1/player/play', 'POST', {});
    await page.waitForFunction(() => Stage.presentation().playing);
    await page.locator('#stage3d').focus();
    await page.keyboard.down('w');
    await page.waitForTimeout(350);
    await page.keyboard.up('w');
    await page.waitForFunction(() => Math.abs(__lookFrame.cam.tz) > .1);
    const displacedPose = await page.evaluate(() => {
      StageFreecam.setEnabled(false);
      const pose = JSON.parse(localStorage.getItem('vmusic.stage.freecam.pose'));
      StageFreecam.setEnabled(true);
      return pose;
    });
    assert.ok(Math.abs(displacedPose.tz) > .1, 'actual WASD movement creates a persisted free camera pose');
    await fixture.api('/v1/player/pause', 'POST', {});
    await fixture.api('/v1/player/seek', 'POST', { position_ms: 7500 });
    await page.waitForFunction(() => !Stage.presentation().playing && Math.abs(Stage.position() - 7500) < 1);
    await page.locator('#s3d-settings-toggle').click();
    await page.locator('#s3d-defaults').click();
    await page.waitForFunction(() => !document.getElementById('s3d-defaults').disabled);
    assert.deepEqual(await page.evaluate(() => ({ busy: StageFreecam.isBusy(), pose: localStorage.getItem('vmusic.stage.freecam.pose') })),
      { busy: false, pose: null }, 'reset clears the free camera immediately and removes its saved pose');
    await assertReset('moving free camera → stage reset');
    await page.locator('#s3d-settings-close').click();
    await page.evaluate(() => { Workshop.open(); Workshop.setTab('scene'); StageFreecam.setEnabled(true); });
    const freecamDefault = await sample(page, 'freecam-after-reset');
    const defaultView = await page.evaluate(() => CreativeStage.preset().cam);
    assert.equal(freecamDefault.cam.tx, 0, 'reenabled free camera resets horizontal translation');
    assert.equal(freecamDefault.cam.tz, 0, 'reenabled free camera resets forward translation');
    assert.ok(Math.abs(freecamDefault.cam.yaw - defaultView.yaw * Math.PI / 180) < .002, 'reenabled free camera starts at the default yaw');
    assert.ok(Math.abs(freecamDefault.cam.pitch - defaultView.pitch * Math.PI / 180) < .002, 'reenabled free camera starts at the default pitch');
    assert.ok(Math.abs(freecamDefault.cam.dist - defaultView.dist) < .002, 'reenabled free camera starts at the default distance');
    await page.locator('#ws-defaults').click();
    await page.waitForFunction(() => document.getElementById('ws-defaults').getAttribute('aria-busy') !== 'true');
    await page.locator('#ws-close').click();
    pass('free camera movement, saved pose, reset and reenable use the restored baseline');
    await page.evaluate(() => { Workshop.open(); Workshop.setTab('scene'); });
    const restoredCamera = (await sample(page, 'restored-creative-camera')).cam;
    for (const key of ['yaw', 'pitch', 'dist']) assert.ok(Math.abs(restoredCamera[key] - baseline.creativeCamera[key]) < .002,
      'reentering creative after reset has no remaining camera offset: ' + key);
    await page.locator('#ws-defaults').click();
    await page.waitForFunction(() => document.getElementById('ws-defaults').getAttribute('aria-busy') !== 'true');
    await page.locator('#ws-close').click();
    pass('reentering creative after reset clears camera offsets');
    await until(async () => {
      const settings = await fixture.api('/v1/settings');
      try { assert.deepEqual(settings.stage3d, baseline.stage); return true; } catch { return false; }
    }, 'reset stage preferences saved by the service');
    await page.waitForFunction(expected => localStorage.getItem('vmusic.creative.preset') === JSON.stringify(expected), baseline.creative);
    await page.locator('#s3d-close').click();
    await page.locator('#stage3d-entry').click();
    await assertReset('close and reopen retains default state');
    await page.screenshot({ path: path.join(out, 'default-restored.png') });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready(page, track.id);
    await instrument(page);
    assert.deepEqual(await page.evaluate(() => Stage3D.preferences()), baseline.stage, 'refresh retains saved defaults');
    assert.deepEqual(await page.evaluate(() => CreativeStage.preset()), baseline.creative, 'refresh retains clean creative state');
    await page.waitForFunction(id => CreativeStage.library().some(p => p.id === id), saved.id);
    assert.deepEqual(await page.evaluate(id => CreativeStage.library().find(p => p.id === id), saved.id), saved, 'refresh preserves saved work');
    pass('reopen and refresh retain defaults and saved work');

    await page.locator('#stage3d-entry').click();
    await page.evaluate(() => { Workshop.open(); Workshop.setTab('presets'); });
    assert.equal(await page.locator('.ws-shot-name', { hasText: saved.name }).count(), 1, 'saved work remains in the visible gallery');
    await page.evaluate(() => { Workshop.setTab('scene'); CreativeStage.setDirector(false); });
    await page.locator('.ws-scene-card[data-scene="orb"]').click();
    await page.evaluate(() => {
      CreativeStage.patch({ 'cam.drift': 0, 'cam.shake': 0, 'cam.kick': 0 });
      CreativeStage.addCue({ at: 25, len: 1000, set: { 'stage.scale': 1.1 } });
      CreativeStage.setBindings([{ source: 'bass', target: 'stage.rotY', amount: 0 }]);
      CreativeStage.setBackground({ type: 'mesh', opacity: 45, blur: 28 });
      Workshop.setTab('look');
    });
    await page.waitForTimeout(1000);
    assert.equal(await page.locator('#creative-bg').isVisible(), true, 'custom background remains visible beneath the scene');
    assert.equal(await page.evaluate(() => document.getElementById('creative-bg').parentElement.id), 's3d-creative', 'background shares the actual stage host');
    assert.deepEqual((await page.evaluate(() => CreativeStage.styles().map(s => s.id))).sort(), ['off', 'manga', 'anime', 'pencil', 'color'].sort());
    const preserved = await page.evaluate(() => {
      const p = CreativeStage.preset(); return { scene: p.scene, sc: p.sc, cam: p.cam, stage: p.stage, cues: p.cues, bindings: p.bindings, director: p.director, bg: p.bg };
    });
    const captures = {};
    for (const style of ['off', 'manga', 'anime', 'pencil', 'color', 'off']) {
      const previous = await page.evaluate(() => __lookFrame.t);
      await page.locator('.ws-look-card[data-style="' + style + '"]').click();
      assert.equal(await page.locator('.ws-look-card[data-style="' + style + '"]').getAttribute('aria-pressed'), 'true');
      const state = await page.evaluate(() => {
        const p = CreativeStage.preset(); return { look: p.look, hand: p.hand,
          preserved: { scene: p.scene, sc: p.sc, cam: p.cam, stage: p.stage, cues: p.cues, bindings: p.bindings, director: p.director, bg: p.bg } };
      });
      assert.deepEqual(state.preserved, preserved, style + ' preserves scene, camera and arrangement');
      if (style === 'off') {
        assert.deepEqual(state.look, baseline.creative.look, 'original light restores default shader values');
        assert.equal(state.hand.on, false);
      } else {
        assert.ok(state.look.toon > 0, style + ' drives the actual toon shader');
        assert.equal(state.hand.on, true);
        assert.equal(state.hand.style, style);
        assert.equal(await page.locator('#s3d-creative .creative-canvas').evaluate(el => getComputedStyle(el).mixBlendMode), 'normal', style + ' uses normal alpha blending');
      }
      const capture = await sample(page, style + '-' + report.checks.length);
      for (const key of ['toon', 'paper', 'grade']) assert.equal(capture.post[key], state.look[key],
        style + ' renders the selected ' + key + ' material');
      assert.equal(capture.t, previous, style + ' applies immediately while shader time stays paused');
      if (['off', 'manga', 'anime'].includes(style) && !captures[style]) {
        captures[style] = capture;
        await page.screenshot({ path: path.join(out, style + '-desktop.png') });
      }
      pass('paused ' + style + ' selection reaches the real shader');
    }
    report.pixelDifferences = { originalToManga: pixelDelta(captures.off, captures.manga), mangaToAnime: pixelDelta(captures.manga, captures.anime) };
    assert.ok(report.pixelDifferences.originalToManga > .5, 'manga visibly changes shader pixels');
    assert.ok(report.pixelDifferences.mangaToAnime > .5, 'anime visibly differs from manga');
    assert.ok(captures.manga.chroma < captures.anime.chroma, 'manga is visibly less chromatic than anime');
    pass('manga and anime have distinct visible WebGL output');

    await page.locator('.ws-look-card[data-style="anime"]').click();
    await fixture.api('/v1/player/play', 'POST', {});
    await page.waitForFunction(() => Stage.presentation().playing);
    await page.waitForTimeout(250);
    const running = await page.evaluate(() => __lookFrame.t);
    await page.waitForTimeout(250);
    assert.ok(await page.evaluate(t => __lookFrame.t > t, running), 'normal playback advances shader time');
    for (const source of ['app', 'system']) {
      if (source === 'app') await page.evaluate(() => Stage.setReducedMotion(true));
      else { await page.emulateMedia({ reducedMotion: 'reduce' }); await page.evaluate(() => Stage.setReducedMotion(false)); }
      await page.waitForTimeout(200);
      const before = await page.evaluate(() => __lookFrame);
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => ({ frame: __lookFrame, hand: HandDrawn.stats() }));
      assert.equal(after.frame.t, before.t, source + ' reduced motion freezes shader time');
      assert.equal(after.frame.cam.yaw, before.cam.yaw, source + ' reduced motion freezes camera drift');
      assert.equal(after.frame.cam.pitch, before.cam.pitch);
      assert.equal(after.hand.fps, 0, source + ' reduced motion stops hand animation');
      await page.locator('.ws-look-card[data-style="' + (source === 'app' ? 'manga' : 'anime') + '"]').click();
      await sample(page, source + '-reduced-style-update');
      pass(source + ' reduced motion stays still and permits style updates');
    }
    await fixture.api('/v1/player/pause', 'POST', {});
    await page.waitForFunction(() => !Stage.presentation().playing);
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    const tabs = await page.evaluate(() => Workshop.tabs());
    for (const tab of tabs) {
      await page.evaluate(id => Workshop.setTab(id), tab);
      assert.equal(await page.locator('#ws-defaults').count(), 1, tab + ' has one reset action');
      assert.equal(await page.locator('#ws-defaults').isVisible(), true, tab + ' reset is visible');
      assert.equal(await page.locator('#ws-defaults').isEnabled(), true, tab + ' reset is enabled');
    }
    await page.evaluate(() => Workshop.setTab('look'));
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(250);
      const geometry = await page.evaluate(() => {
        const panel = document.getElementById('workshop'), body = document.getElementById('ws-body');
        const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
        return { viewport: innerWidth, pageWidth: document.scrollingElement.scrollWidth,
          panel: rect(panel), stage: rect(document.getElementById('s3d-creative')),
          tabs: rect(document.getElementById('ws-tabs')), currentTab: rect(document.querySelector('#ws-tabs .ws-tab.on')),
          bodyWidth: body.clientWidth, bodyScrollWidth: body.scrollWidth, reset: rect(document.getElementById('ws-defaults')) };
      });
      report.geometry.push(geometry);
      assert.ok(geometry.pageWidth <= width + 1 && geometry.panel.x >= -1 && geometry.panel.right <= width + 1, width + ' has no page overflow');
      assert.ok(geometry.bodyScrollWidth <= geometry.bodyWidth + 1, width + ' has no editor overflow');
      assert.ok(geometry.reset.x >= 0 && geometry.reset.right <= width, width + ' reset fits');
      assert.ok(geometry.currentTab.x >= Math.max(0, geometry.tabs.x) - 1 &&
        geometry.currentTab.right <= Math.min(width, geometry.tabs.right) + 1, width + ' keeps the current tab fully visible after resizing');
      assert.ok(geometry.stage.bottom <= geometry.panel.top + 2, width + ' keeps the stage above the editor');
      await page.locator('#ws-defaults').click({ trial: true });
      await page.locator('.ws-look-card[data-style="anime"]').click();
      await page.screenshot({ path: path.join(out, 'anime-' + width + '.png') });
    }
    // Start at the panel's real entry point, then traverse with native Tab.
    await page.locator('#ws-close').focus();
    const visited = new Set();
    for (let i = 0; i < 90; i++) {
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => ({ id: document.activeElement.id, style: document.activeElement.dataset.style,
        inside: !!document.activeElement.closest('#workshop') }));
      assert.equal(focused.inside, true, 'advanced editor keeps keyboard focus inside the dialog');
      if (focused.id === 'ws-defaults') visited.add('reset');
      if (focused.style) visited.add(focused.style);
      if (visited.has('reset') && visited.has('manga') && visited.has('anime')) break;
    }
    assert.ok(visited.has('reset') && visited.has('manga') && visited.has('anime'), 'Tab reaches reset and both primary looks');
    await page.locator('.ws-look-card[data-style="manga"]').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.ws-look-card[data-style="manga"]').getAttribute('aria-pressed'), 'true', 'Enter applies manga');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.style), 'manga', 'applying a look preserves keyboard focus');
    await page.locator('#ws-defaults').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('ws-defaults').getAttribute('aria-busy') !== 'true');
    assert.deepEqual(await page.evaluate(() => Stage3D.preferences()), baseline.stage, 'Enter restores the stage');
    await page.screenshot({ path: path.join(out, 'default-320.png') });
    pass('all workshop pages expose reset; 320/390px layout and keyboard actions work');

    assert.deepEqual(await page.evaluate(() => __lookRenderErrors), [], 'production renderer reports no failures');
    assert.deepEqual(report.pageErrors, [], 'no browser runtime errors');
    assert.deepEqual(report.shaderErrors, [], 'no shader compilation or WebGL console errors');
    pass('browser runtime and shaders stay error free');
  } catch (error) {
    report.failure = error.stack || String(error);
    if (page) {
      await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
      report.visibleFailureState = await page.locator('body').innerText().then(text => text.slice(0, 2200)).catch(() => 'unavailable');
    }
    throw error;
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    if (browser) await browser.close();
    await fixture.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
