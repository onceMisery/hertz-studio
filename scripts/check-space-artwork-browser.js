// SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'output/playwright/space-artwork');

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [], evidence = [];
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
      window.host = SpaceStagePure.create(canvas, { qualityMode: 'high', deviceTier: 2 });
      window.covers = ['#e83d52', '#30bbce'].map(color => {
        const c = document.createElement('canvas'); c.width = c.height = 768; const ctx = c.getContext('2d');
        ctx.fillStyle = color; ctx.fillRect(0, 0, 768, 768);
        ctx.fillStyle = '#1c2630'; ctx.fillRect(0, 540, 768, 228);
        ctx.fillStyle = '#f6f6ed'; ctx.beginPath(); ctx.arc(535, 230, 105, 0, Math.PI * 2); ctx.fill();
        ctx.font = 'bold 82px sans-serif'; ctx.fillText('HERTZ', 48, 135);
        ctx.font = '30px sans-serif'; ctx.fillText('SPATIAL RECORDS', 48, 610);
        return c.toDataURL();
      });
      window.current = 'proxy:0'; window.requests = []; window.pending = null;
      host.setServices({ coverUrl: () => current, coverItems: () => [], resolveCover: key => {
        requests.push(key); if (key === 'proxy:late') return new Promise(resolve => { window.pending = resolve; });
        return Promise.resolve(covers[Number(key.split(':')[1])]);
      } });
      window.frame = (time = 0, reduced = false) => {
        host.frame({ now: performance.now(), time, sceneTime: reduced ? 0 : time, dynamicDt: reduced ? 0 : .016, dt: .016, playing: !reduced, reduced, bands: {}, level: 0 });
        const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, bytes = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        let red = 0, cyan = 0, lit = 0, hash = 2166136261;
        for (let i = 0; i < bytes.length; i += 16) {
          const r = bytes[i], g = bytes[i + 1], b = bytes[i + 2];
          if (r > g * 1.5 && r > 80) red++;
          if (g > r * 1.5 && b > r * 1.5 && g > 80) cyan++;
          if (r + g + b > 80) lit++;
          hash = Math.imul(hash ^ (r + g + b), 16777619);
        }
        return { red, cyan, lit, hash: hash >>> 0, stats: host.stats() };
      };
    });
    for (const id of ['cover-sphere', 'cover-wall']) {
      await page.evaluate(async id => { current = 'proxy:0'; host.setRig(null); await host.select(id); host.resize(innerWidth, innerHeight); frame(); }, id);
      await page.waitForFunction(() => host.stats().coverTextures > 0);
      await page.waitForTimeout(150);
      const first = await page.evaluate(() => frame());
      assert.ok(first.red > 1000, id + ' displays current artwork with an empty queue through proxy resolution');
      await page.screenshot({ path: path.join(output, id + '-desktop.png') });
      const moved = await page.evaluate(() => frame(9)); assert.notEqual(first.hash, moved.hash, id + ' moves');
      const rotated = await page.evaluate(id => {
        const baseline = SpaceStagePure.catalog().find(d => d.id === id).camera;
        host.setRig({ ...baseline, theta: .45, phi: .16 }); return frame(0);
      }, id);
      assert.notEqual(first.hash, rotated.hash, id + ' has real camera depth'); assert.ok(rotated.red > 500);
      await page.evaluate(() => { current = 'proxy:1'; host.setRig(null); frame(); }); await page.waitForTimeout(150);
      const changed = await page.evaluate(() => frame()); assert.ok(changed.cyan > 1000 && changed.red < first.red * .15, id + ' replaces artwork');
      const frozen = await page.evaluate(() => [frame(1, true), frame(30, true)]); assert.equal(frozen[0].hash, frozen[1].hash, id + ' reduced motion freezes');
      await page.setViewportSize({ width: 390, height: 844 });
      const mobile = await page.evaluate(() => { host.resize(innerWidth, innerHeight); return frame(); });
      assert.ok(mobile.cyan > 500, id + ' mobile artwork remains visible');
      await page.screenshot({ path: path.join(output, id + '-mobile.png') });
      await page.setViewportSize({ width: 1440, height: 900 });
      evidence.push({ id, first, changed, mobile });
    }
    const canceled = await page.evaluate(async () => {
      current = 'proxy:late'; await host.select('cover-sphere'); frame(); await Promise.resolve(); await Promise.resolve();
      await host.select('gravity-sphere'); current = ''; pending(covers[0]); await new Promise(resolve => setTimeout(resolve, 50)); frame();
      return host.stats();
    });
    assert.equal(canceled.coverTextures, 0, 'late resolver cannot retain a canceled cover');
    const disposed = await page.evaluate(() => { host.dispose(); return host.stats(); });
    assert.equal(disposed.resources, 0); assert.equal(disposed.coverTextures, 0); assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log('Artwork: proxy resolution, current cover without queue, replacement, motion/camera, reduced motion, desktop/mobile pixels and cleanup passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
