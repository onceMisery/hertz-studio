// SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const sharp = require(process.env.SHARP_MODULE || 'sharp');
const { uiUrl } = require('./ui-token');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'output/playwright/space-particles');
const base = process.env.SPACE_BASE || 'http://127.0.0.1:18815';

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [], evidence = { scenes: [], layouts: [] };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setContent('<body style="margin:0;background:#030405"><canvas style="display:block;width:100vw;height:100vh"></canvas>');
    await page.addScriptTag({ path: path.join(root, 'plugin/ui/vendor/stage-runtime.js') });
    await page.addScriptTag({ path: path.join(root, 'plugin/ui/vendor/space-stage.js') });
    await page.evaluate(() => {
      const canvas = document.querySelector('canvas'), original = canvas.getContext.bind(canvas);
      canvas.getContext = (type, ...args) => { const result = original(type, ...args); if (/webgl/.test(type)) window.gl = result; return result; };
      window.invalidations = 0;
      window.host = SpaceStagePure.create(canvas, { qualityMode: 'high', deviceTier: 2, onInvalidate: () => invalidations++ });
      window.covers = ['#df374e', '#21bfd2'].map(color => {
        const c = document.createElement('canvas'); c.width = c.height = 768; const ctx = c.getContext('2d');
        ctx.fillStyle = color; ctx.fillRect(0, 0, 768, 768);
        ctx.fillStyle = '#f0ede4'; ctx.fillRect(68, 160, 250, 390);
        ctx.fillStyle = '#20292b'; ctx.beginPath(); ctx.arc(490, 355, 160, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#f0ede4'; ctx.font = 'bold 70px sans-serif'; ctx.fillText('HERTZ', 55, 105);
        ctx.font = '25px sans-serif'; ctx.fillText('PARTICLE RECORDS', 55, 675);
        return c.toDataURL();
      });
      window.current = 'art:0'; window.resolvers = [];
      host.setServices({ coverUrl: () => current, resolveCover: key => {
        if (key.startsWith('late:')) return new Promise(resolve => resolvers.push(resolve));
        if (key === 'broken') return '';
        return covers[Number(key.split(':')[1])];
      } });
      window.pointer = { active: false, x: 0, y: 0 }; window.now = 0;
      window.draw = (options = {}) => {
        now += 16;
        host.frame({ now, time: 0, sceneTime: 0, dt: .016, dynamicDt: options.playing ? options.dt ?? .016 : 0, playing: false, reduced: false, bands: {}, level: 0, pointer, ...options });
      };
      window.pixels = () => {
        const bytes = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
        gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        return bytes;
      };
      window.summary = () => {
        const bytes = pixels(); let red = 0, cyan = 0, lit = 0;
        for (let i = 0; i < bytes.length; i += 4) {
          const [r, g, b] = bytes.subarray(i, i + 3);
          if (r > 80 && r > g * 1.5) red++;
          if (g > 80 && g > r * 1.5 && b > r * 1.5) cyan++;
          if (r + g + b > 100) lit++;
        }
        return { red, cyan, lit, stats: host.stats() };
      };
      window.difference = before => {
        const after = pixels(), width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
        let count = 0, xSum = 0, ySum = 0;
        for (let i = 0; i < after.length; i += 4) {
          if (Math.abs(after[i] - before[i]) + Math.abs(after[i + 1] - before[i + 1]) + Math.abs(after[i + 2] - before[i + 2]) > 12) {
            count++; xSum += (i / 4) % width; ySum += Math.floor(i / 4 / width);
          }
        }
        return { count, center: [xSum / Math.max(1, count), height - ySum / Math.max(1, count)], width, height };
      };
    });
    await page.evaluate(async () => {
      await host.select('cover-particles'); host.resize(innerWidth, innerHeight);
      host.setParams({ speed: 0, relief: 0 }); draw();
    });
    await page.waitForFunction(() => host.stats().textures > 0 || host.stats().coverTextures > 0);
    await page.waitForTimeout(150);
    const cover = await page.evaluate(() => { draw(); window.baseline = pixels(); return summary(); });
    assert.ok(cover.red > 15000 && cover.lit > 40000, 'cover is rendered as a readable full-color particle grid');
    assert.equal(cover.stats.points, 192 * 192);
    await page.screenshot({ path: path.join(output, 'cover-desktop.png') });
    for (const rotated of [false, true]) {
      const dent = await page.evaluate(rotated => {
        if (rotated) {
          const baseline = SpaceStagePure.catalog().find(d => d.id === 'cover-particles').camera;
          host.setRig({ ...baseline, theta: .32, phi: .16 });
        }
        pointer.active = false; for (let i = 0; i < 80; i++) draw(); window.beforeDent = pixels();
        pointer = { active: true, x: .22, y: -.16 };
        for (let i = 0; i < 50; i++) draw();
        return difference(beforeDent);
      }, rotated);
      assert.ok(dent.count > 200, 'hover deforms actual pixels with ' + (rotated ? 'rotated' : 'default') + ' camera');
      const expected = [dent.width * .61, dent.height * .58];
      assert.ok(Math.hypot(dent.center[0] - expected[0], dent.center[1] - expected[1]) < 65, 'indentation is centered under the pointer: ' + JSON.stringify(dent));
      await page.screenshot({ path: path.join(output, rotated ? 'cover-hover-rotated.png' : 'cover-hover.png') });
      const recovered = await page.evaluate(() => { pointer.active = false; for (let i = 0; i < 100; i++) draw(); return difference(beforeDent); });
      assert.equal(recovered.count, 0, 'paused pointer departure restores exact original pixels');
      const reduced = await page.evaluate(() => { pointer.active = true; for (let i = 0; i < 40; i++) draw({ reduced: true }); return difference(beforeDent); });
      assert.equal(reduced.count, 0, 'reduced motion suppresses pointer deformation');
      evidence.scenes.push({ id: 'cover-particles', rotated, dent, recovered });
    }
    await page.evaluate(() => { pointer.active = false; current = 'art:1'; host.setRig(null); draw(); });
    await page.waitForTimeout(150);
    const replacement = await page.evaluate(() => { draw(); window.cyanPixels = pixels(); return summary(); });
    assert.ok(replacement.cyan > 15000 && replacement.red < cover.red * .05, 'track replacement changes the sampled particle colors');
    assert.equal(replacement.stats.coverTextures, 1, 'completed transition releases previous artwork');
    await page.evaluate(() => { current = 'art:0'; draw({ playing: true, dt: 0 }); });
    await page.waitForTimeout(150);
    const crossfade = await page.evaluate(() => {
      draw({ playing: true, dt: .16 }); const mixed = summary(), fromCyan = difference(cyanPixels), mixedPixels = pixels();
      for (let i = 0; i < 30; i++) draw({ playing: true, dt: .016 });
      return { mixed, completed: summary(), fromCyan, toRed: difference(mixedPixels) };
    });
    assert.equal(crossfade.mixed.stats.coverTextures, 2, 'playing transition keeps at most current and previous covers');
    assert.ok(crossfade.fromCyan.count > 15000 && crossfade.toRed.count > 15000, 'intermediate cover pixels differ from both endpoints');
    assert.equal(crossfade.completed.stats.coverTextures, 1, 'finished crossfade releases old texture');
    assert.ok(crossfade.completed.red > 15000);
    await page.evaluate(() => { window.beforeFailure = invalidations; current = 'broken'; draw(); });
    await page.waitForFunction(() => invalidations > beforeFailure);
    const failure = await page.evaluate(() => { draw(); return summary(); });
    assert.ok(failure.lit > 40000 && failure.red < cover.red * .3, 'failed artwork invalidates paused rendering and replaces old image with visible fallback');
    assert.equal(failure.stats.coverTextures, 1, 'failed cover cannot retain the previous image');
    await page.evaluate(() => { current = 'art:1'; draw(); }); await page.waitForTimeout(150);
    for (const [width, height] of [[715,897], [390,844], [320,844]]) {
      await page.setViewportSize({ width, height });
      const mobile = await page.evaluate(() => { host.resize(innerWidth, innerHeight); draw(); return summary(); });
      assert.ok(mobile.cyan > 1000, 'readable portrait cover at ' + width);
      const bounds = await page.evaluate(() => {
        const bytes = pixels(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight; let left = w, right = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (bytes[i] + bytes[i + 1] + bytes[i + 2] > 100) { left = Math.min(left, x); right = Math.max(right, x); }
        }
        return { left, right, width: w };
      });
      assert.ok(bounds.left > 3 && bounds.right < bounds.width - 3, 'complete cover fits portrait width');
      await page.screenshot({ path: path.join(output, 'cover-' + width + '.png') });
      evidence.layouts.push({ width, ...mobile, bounds });
    }
    await page.evaluate(() => { current = ''; draw(); });
    const empty = await page.evaluate(() => { draw(); return summary(); });
    assert.ok(empty.lit > 1000); assert.equal(empty.stats.coverTextures, 0, 'missing artwork uses visible particles without retained textures');
    for (const id of ['particle-silk', 'gravity-sphere', 'warp-tunnel', 'prism-galaxy']) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(async id => { pointer.active = false; await host.select(id); host.resize(innerWidth, innerHeight); host.setParams({ speed: 0 }); draw(); }, id);
      const result = await page.evaluate(id => {
        window.stars = pixels(); pointer = { active: true, x: id === 'warp-tunnel' ? .4 : .15, y: .05 };
        for (let i = 0; i < 50; i++) draw(); return { diff: difference(stars), pixels: summary() };
      }, id);
      assert.ok(result.diff.count > 10, id + ' has real pointer deformation');
      assert.ok(result.pixels.lit > 500, id + ' has visible, defined particles');
      await page.screenshot({ path: path.join(output, id + '-desktop.png') });
      evidence.scenes.push({ id, ...result });
    }
    const canceled = await page.evaluate(async () => {
      await host.select('cover-particles');
      for (let i = 0; i < 16; i++) { current = 'late:' + i; draw(); await Promise.resolve(); await Promise.resolve(); }
      const retained = host.stats().coverTextures;
      await host.select('gravity-sphere'); current = ''; resolvers.forEach(resolve => resolve(covers[0]));
      await new Promise(resolve => setTimeout(resolve, 50)); draw();
      return { retained, stats: host.stats() };
    });
    assert.equal(canceled.retained, 1, 'rapid cover replacement retains only the live request');
    assert.equal(canceled.stats.coverTextures, 0, 'late cover completions cannot revive disposed scenes');
    const disposed = await page.evaluate(() => { host.dispose(); return host.stats(); });
    assert.equal(disposed.resources, 0); assert.equal(disposed.coverTextures, 0);
    await page.close();

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    let settings;
    await context.route('**/v1/settings', async route => {
      if (!settings) { settings = await (await route.fetch()).json(); settings.space3d = { sceneSource: 'cover-particles', cinema: false, qualityMode: 'high', lyrics: false, shelfMode: 'off', playerAutoHide: false }; }
      if (route.request().method() !== 'GET') Object.assign(settings, route.request().postDataJSON());
      await route.fulfill({ json: settings });
    });
    const app = await context.newPage(); app.on('pageerror', error => errors.push(error.message));
    await app.goto(uiUrl(base), { waitUntil: 'load' });
    await app.locator('#space3d-entry').click();
    await app.waitForFunction(() => Space3D.stats().renderer?.id === 'cover-particles' && Space3D.stats().renderer.state === 'ready');
    await app.locator('#sp-page-toggle').click();
    await app.evaluate(() => {
      const original = Stage.presentation;
      Stage.presentation = () => ({ ...original(), playing: false, position: 0 });
      const saved = Space3D.preferences();
      Space3D.configure({ ...saved, sceneStates: { ...saved.sceneStates, 'cover-particles': SpaceStagePure.normalizeState('cover-particles', { params: { speed: 0, relief: 0 } }) } });
      window.originalCanvas = document.querySelector('#sp-canvas canvas');
    });
    await app.mouse.move(700, 50); await app.waitForTimeout(1200);
    const canvas = app.locator('#sp-canvas canvas'), originalImage = await canvas.screenshot();
    const before = await app.evaluate(() => Space3D.stats().renderer.frameCount);
    await app.mouse.move(860, 440); await app.waitForTimeout(500);
    assert.ok(await app.evaluate(() => Space3D.stats().renderer.frameCount) > before, 'paused app pointer move wakes existing Stage frame gate');
    assert.notDeepEqual(await canvas.screenshot(), originalImage, 'real DOM pointer deforms the paused scene');
    await app.screenshot({ path: path.join(output, 'app-hover.png') });
    await app.mouse.move(700, 50); await app.waitForTimeout(1300);
    const paused = await app.evaluate(() => Space3D.stats().renderer.frameCount); await app.waitForTimeout(400);
    assert.equal(await app.evaluate(() => Space3D.stats().renderer.frameCount), paused, 'paused frame gate sleeps after recovery');
    await app.locator('#sp-console-toggle').click();
    const card = app.locator('#sp-fx-grid [data-scene="cover-particles"]');
    await card.scrollIntoViewIfNeeded();
    assert.equal(await card.locator('img').evaluate(img => img.complete && img.naturalWidth > 0), true, 'actual new preview loads');
    assert.equal(await app.locator('#sp-source option[value="cover-particles"]').count(), 1);
    await app.screenshot({ path: path.join(output, 'app-console.png') });
    await app.keyboard.press('Escape');
    for (const [width, height] of [[715,897], [390,844], [320,844]]) {
      await app.setViewportSize({ width, height }); await app.waitForTimeout(500);
      const stats = await sharp(await canvas.screenshot()).stats();
      assert.ok(stats.channels.slice(0,3).some(channel => channel.stdev > 4), 'actual app canvas nonblank at ' + width);
      assert.equal(await app.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await app.screenshot({ path: path.join(output, 'app-' + width + '.png') });
    }
    await app.locator('#sp-page-toggle').click();
    assert.equal(await app.evaluate(() => originalCanvas === document.querySelector('#sp-canvas canvas')), true);
    assert.equal(await app.evaluate(() => Space3D.sourceId()), 'cover-particles');
    assert.deepEqual(errors, [], 'no shader or runtime errors');
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log('Space particles: artwork grid, localized indentation/rotated camera/recovery, paused gate, reduced motion, replacement/cancellation, four starfields, previews and desktop/mobile passed');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
