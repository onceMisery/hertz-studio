// SPDX-License-Identifier: MIT
// Render actual ripples over both scene backends and the image/video presentation path.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'crates/hertz-desktop/assets');
const output = path.join(root, 'output/playwright/wallpaper-pointer-browser');
const html = fs.readFileSync(path.join(assets, 'wallpaper-scene.html'), 'utf8')
  .replace('__GL_BUDGET__', () => fs.readFileSync(path.join(assets, 'wallpaper-gl-budget.js'), 'utf8'))
  .replace('__RUNTIME__', () => fs.readFileSync(path.join(root, 'plugin/ui/vendor/stage-runtime.js'), 'utf8'))
  .replace('__SHIM__', () => fs.readFileSync(path.join(root, 'plugin/ui/vendor/zodiac-stage.js'), 'utf8'))
  .replace('__SCENE__', () => fs.readFileSync(path.join(assets, 'wallpaper-scene.js'), 'utf8'));
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((_, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-webgl'] });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 }, reducedMotion: 'no-preference' });
  const errors = [], checks = [];
  page.on('pageerror', error => errors.push(error.message));
  const state = () => page.evaluate(() => hertzWallpaper.debug());
  async function ripple(label) {
    const before = (await state()).pointer;
    await page.mouse.move(350, 240);
    await page.waitForTimeout(70);
    await page.mouse.move(410, 250);
    await page.waitForTimeout(70);
    await page.mouse.click(450, 265);
    await page.waitForTimeout(120);
    const after = (await state()).pointer;
    assert.ok(after.moves > before.moves, label + ' movement');
    assert.equal(after.clicks, before.clicks + 1, label + ' left click');
    const pixels = await page.locator('#wallpaper-pointer-effects').evaluate(canvas => {
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let visible = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 5) visible++;
      return visible;
    });
    assert.ok(pixels > 300, label + ' visible rendered waves');
    await page.screenshot({ path: path.join(output, label + '.png') });
    await page.mouse.click(450, 265, { button: 'right' });
    assert.equal((await state()).pointer.clicks, after.clicks, 'right click remains an ordinary context menu');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => hertzWallpaper.debug().pointer.waves === 0);
    checks.push({ label, pixels, pointer: after });
  }
  try {
    await page.goto('http://127.0.0.1:' + server.address().port);
    for (const scene of ['zodiac', 'coast']) {
      await page.evaluate(scene => { hertzWallpaper.applyConfig({ source: 'fixed', scene, pointer: true }); hertzWallpaper.start(30); }, scene);
      await page.waitForFunction(scene => hertzWallpaper.debug().scene === scene && hertzWallpaper.debug().mounted, scene);
      const draws = (await state()).draws;
      await page.waitForFunction(draws => hertzWallpaper.debug().draws > draws + 30, draws, { timeout: 7000 })
        .catch(async error => { console.error('scene diagnostics:', await state()); throw error; });
      assert.equal((await state()).error, null);
      await ripple(scene);
    }
    const base = 'https://' + 'a'.repeat(32) + '.' + 'b'.repeat(32) + '.wallpaper.invalid/files/assets/';
    await page.route(base + '**', route => route.fulfill({
      contentType: route.request().url().endsWith('.webm') ? 'video/webm' : 'image/jpeg',
      body: fs.readFileSync(route.request().url().endsWith('.webm') ? path.join(root, 'scripts/fixtures/wallpaper-vp8.webm') : path.join(assets, 'scene-thumbnails/coast.jpg')),
    }));
    for (const kind of ['image', 'video']) {
      await page.evaluate(({ kind, url }) => hertzWallpaper.applyMedia({ kind, url }), { kind, url: base + (kind === 'video' ? 'bg.webm' : 'bg.jpg') });
      await page.waitForFunction(() => hertzWallpaper.debug().media?.state === 'ready');
      await ripple(kind);
      assert.equal((await state()).pointer.mediaAnimating, false, 'media effects are idle after fading');
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const count = (await state()).pointer.clicks;
    await page.mouse.click(300, 300);
    assert.equal((await state()).pointer.clicks, count);
    assert.equal(await page.locator('#wallpaper-pointer-effects').count(), 0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => hertzWallpaper.applyConfig({ pointer: false }));
    await page.mouse.click(350, 300);
    assert.equal((await state()).pointer.clicks, count);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ checks, reducedMotion: true, disabled: true, errors }, null, 2));
    console.log('wallpaper pointer browser checks passed: zodiac/coast, image/video, visible pixels, left/right click, idle, reduced motion and disable');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
