#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'output/playwright/space-scenes');
const previews = process.argv.includes('--previews');
const selected = process.argv.find(arg => arg.startsWith('--scenes='))?.slice(9).split(',');
const sharp = previews ? require(process.env.SHARP_MODULE || 'sharp') : null;

(async () => {
  fs.mkdirSync(output, { recursive: true });
  if (previews) fs.mkdirSync(path.join(root, 'plugin/ui/space-scene-preview'), { recursive: true });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const evidence = { renderer: 'Chrome ANGLE SwiftShader software WebGL2', ordinaryPc: 'unmeasured', dbx: 'unmeasured', scenes: [] }, errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setContent('<html><body style="margin:0;background:#030405"><canvas style="width:100vw;height:100vh;display:block"></canvas></body></html>');
    await page.addScriptTag({ path: path.join(root, 'plugin/ui/vendor/stage-runtime.js') });
    await page.addScriptTag({ path: path.join(root, 'plugin/ui/vendor/space-stage.js') });
    const ids = await page.evaluate(() => {
      const canvas = document.querySelector('canvas'), original = canvas.getContext.bind(canvas);
      canvas.getContext = (type, ...args) => { const result = original(type, ...args); if (/webgl/.test(type)) window.testGl = result; return result; };
      const cover = document.createElement('canvas'); cover.width = cover.height = 256;
      const ctx = cover.getContext('2d');
      ctx.fillStyle = '#e84878'; ctx.fillRect(0, 0, 128, 256); ctx.fillStyle = '#3dd2bd'; ctx.fillRect(128, 0, 128, 256);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 40px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('HERTZ', 128, 115); ctx.fillText('STUDIO', 128, 166);
      const coverUrl = cover.toDataURL('image/png'); window.testHost = SpaceStagePure.create(canvas, { qualityMode: 'medium', deviceTier: 'high' });
      testHost.setServices({ coverUrl: () => coverUrl, coverItems: Array(12).fill(coverUrl) });
      window.testFrame = (time, now = time * 1000) => ({ now, time, sceneTime: time, dt: .016, playing: true, level: .6, bands: { bass: .65, mid: .4, treble: .3 },
        spectrum: new Float32Array(64).fill(.5), onset: .8, lyrics: { index: 1, progress: .45, lines: [
          { text: '听见世界的回声', start: 0, end: 4 },
          { text: '音乐在星光中流动', start: 4, end: 12, tokens: [{ text: '音乐', start: 4, end: 6 }, { text: '在星光中', start: 6, end: 9 }, { text: '流动', start: 9, end: 12 }] },
          { text: '下一刻仍在远方', start: 12, end: 16 }] } });
      window.testPixels = () => {
        const gl = testGl, w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, pixels = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let lit = 0, centerLit = 0, hash = 2166136261, minX = w, maxX = 0, minY = h, maxY = 0;
        for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) {
          const i = (y * w + x) * 4, brightness = pixels[i] + pixels[i + 1] + pixels[i + 2];
          hash = Math.imul(hash ^ brightness, 16777619);
          if (brightness > 35) { lit++; if (x > w * .2 && x < w * .8 && y > h * .2 && y < h * .8) centerLit++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
        }
        return { lit, centerLit, hash: hash >>> 0, bounds: [minX, minY, maxX, maxY], width: w, height: h };
      };
      return SpaceStagePure.catalog().map(d => d.id);
    });
    const checkedIds = selected ? ids.filter(id => selected.includes(id)) : ids;
    assert.ok(checkedIds.length, 'requested scenes are registered');
    for (const id of checkedIds) {
      const entry = { id, profiles: [] };
      for (const mode of ['medium', 'low', 'high']) {
        const first = await page.evaluate(async ({ id, mode }) => {
          testHost.setRig(null); testHost.setQualityMode(mode); await testHost.select(id); testHost.resize(1280, 720);
          for (let i = 0; i < 5; i++) testHost.frame(testFrame(6, 1000 + i * 16));
          await new Promise(resolve => setTimeout(resolve, 30)); testHost.frame(testFrame(6, 1100));
          return { pixels: testPixels(), stats: testHost.stats() };
        }, { id, mode });
        const moved = await page.evaluate(() => { testHost.frame(testFrame(8, 1200)); return testPixels(); });
        assert.equal(first.stats.effectiveQuality, mode, id + ' actual profile matches requested validation profile');
        assert.ok(first.pixels.lit > 50 && first.pixels.centerLit > 10, id + ' ' + mode + ' nonblank/framed');
        assert.notEqual(first.pixels.hash, moved.hash, id + ' ' + mode + ' movement');
        const budget = { low: [40, 12000, 80000], medium: [80, 30000, 200000], high: [120, 50000, 400000] }[mode];
        assert.ok(first.stats.drawCalls <= budget[0], id + ' measured draw budget');
        assert.ok(first.stats.points <= budget[1], id + ' measured point budget');
        assert.ok(first.stats.triangles <= budget[2], id + ' measured triangle budget');
        entry.profiles.push({ mode, ...first, movedHash: moved.hash });
        if (mode === 'medium') {
          const screenshot = await page.screenshot({ type: 'png' });
          if (previews) await sharp(screenshot).resize(480, 270).jpeg({ quality: 84 }).toFile(path.join(root, 'plugin/ui/space-scene-preview', id + '.jpg'));
          if (id.startsWith('lyric-') || id.startsWith('handdrawn-')) fs.writeFileSync(path.join(output, id + '-desktop.png'), screenshot);
        }
      }
      const camera = await page.evaluate(id => {
        const baseline = SpaceStagePure.catalog().find(d => d.id === id).camera;
        const frame = { ...testFrame(9, 1250), playing: false, reduced: true, dynamicDt: 0 };
        testHost.setRig(baseline); testHost.frame(frame); const original = testPixels();
        testHost.setRig({ ...baseline, theta: (baseline.theta || 0) + .25, phi: (baseline.phi || 0) + .08 });
        testHost.frame(frame); const rotated = testPixels();
        testHost.setRig(baseline);
        return { original, rotated };
      }, id);
      assert.ok(camera.rotated.lit > 50 && camera.rotated.centerLit > 10, id + ' camera remains framed');
      assert.notEqual(camera.original.hash, camera.rotated.hash, id + ' spatial camera changes frozen pixels');
      entry.camera = camera;
      if (!await page.evaluate(id => SpaceStagePure.catalog().find(d => d.id === id).capabilities.ownsLyrics, id)) {
        const response = await page.evaluate(() => {
          const frame = { ...testFrame(9, 1270), sceneTime: 3, reduced: false };
          frame.bands = { bass: 0, mid: 0, treble: 0 }; frame.level = 0; frame.spectrum.fill(0);
          testHost.frame(frame); const quiet = testPixels();
          frame.now += 16; frame.bands = { bass: .9, mid: .8, treble: .7 }; frame.level = .9; frame.spectrum.fill(.9);
          testHost.frame(frame); return { quiet, loud: testPixels() };
        });
        assert.notEqual(response.quiet.hash, response.loud.hash, id + ' audio changes real pixels at the same scene time');
        entry.audio = response;
      }
      await page.setViewportSize({ width: 390, height: 844 });
      const portrait = await page.evaluate(() => { testHost.resize(390, 844); testHost.frame(testFrame(9, 1300)); return { pixels: testPixels(), stats: testHost.stats() }; });
      assert.ok(portrait.pixels.lit > 50 && portrait.pixels.centerLit > 10, id + ' portrait nonblank/framed'); entry.portrait = portrait;
      if (id.startsWith('lyric-') || id === 'cover-sphere' || id === 'cover-wall') await page.screenshot({ path: path.join(output, id + '-portrait.png') });
      await page.setViewportSize({ width: 1280, height: 720 }); evidence.scenes.push(entry);
      console.log(id + ': medium/low/high/portrait pixels, motion, camera and geometry budgets passed');
    }
    const reduced = await page.evaluate(async () => {
      await testHost.select('spectrum-towers'); testHost.resize(1280, 720);
      const first = testFrame(6, 1700); first.sceneTime = 3; first.reduced = true; first.dynamicDt = 0;
      testHost.frame(first); const a = testPixels();
      const second = testFrame(10, 1900); second.sceneTime = 3; second.reduced = true; second.dynamicDt = 0; second.bands = { bass: .1, mid: .9, treble: .8 }; second.spectrum.fill(.9);
      testHost.frame(second); const b = testPixels(); return { a, b };
    });
    assert.equal(reduced.a.hash, reduced.b.hash, 'reduced-motion freezes spatial spectrum pixels while playback time advances'); evidence.reduced = reduced;
    const post = await page.evaluate(async () => {
      testHost.setQualityMode('medium'); await testHost.select('gravity-sphere'); testHost.resize(1280, 720); testHost.frame(testFrame(6, 2000)); const baseline = testPixels();
      testHost.setParams({ grain: 10, halftone: 20, vignette: 25, softness: 3, bokeh: 3, chroma: 2, aberration: 2, distort: 1, bloom: 2, dust: .5, discRing: true, ripples: .6 });
      testHost.frame(testFrame(6, 2016)); const enabled = testPixels(), stats = testHost.stats();
      testHost.setQualityMode('low'); testHost.frame(testFrame(6, 2032)); const low = testPixels();
      testHost.dispose(); return { baseline, enabled, low, stats, disposed: testHost.stats() };
    });
    assert.notEqual(post.baseline.hash, post.enabled.hash, 'composable effects change real pixels'); assert.ok(post.enabled.lit > 50 && post.low.lit > 50);
    assert.equal(post.disposed.resources, 0); assert.equal(post.disposed.tasks, 0); evidence.post = post;
    assert.deepEqual(errors, [], 'no shader/context/runtime errors');
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log('All ' + checkedIds.length + ' scene previews verified. Software GL is not ordinary-PC FPS evidence.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
