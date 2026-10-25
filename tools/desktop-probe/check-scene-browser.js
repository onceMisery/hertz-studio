'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const source = fs.readFileSync(path.join(__dirname, 'src/bin/wallpaper.rs'), 'utf8');
  let html = source.match(/const SCENE_PAGE_TEMPLATE: &str = r#"([\s\S]*?)"#;/)[1];
  for (const [marker, value] of Object.entries({
    __RUNTIME__: fs.readFileSync(path.join(root, 'plugin/ui/vendor/stage-runtime.js'), 'utf8'),
    __SHIM__: fs.readFileSync(path.join(root, 'plugin/ui/vendor/zodiac-stage.js'), 'utf8'),
    __REPORT_MS__: '60000', __SAMPLE_PIXELS__: 'true', __CHECK_CLOCK__: 'true', __DURATION_SECONDS__: '28800',
  })) html = html.replace(marker, () => value);
  const server = http.createServer((req, res) => {
    if (req.url !== '/') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const errors = [];
  try {
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const callbacks = new Map();
      let next = 0, now = 1000;
      window.requestAnimationFrame = fn => { callbacks.set(++next, fn); return next; };
      window.cancelAnimationFrame = id => callbacks.delete(id);
      window.__messages = [];
      window.ipc = { postMessage(raw) {
        try { window.__messages.push(JSON.parse(raw)); } catch (_) { window.__messages.push(raw); }
        if (raw === 'page_ready') queueMicrotask(() => window.startMotion(30));
      } };
      window.__advance = (frames, renderer = true) => {
        for (let i = 0; i < frames; i++) {
          now += 1000 / 60;
          const pending = [...callbacks.values()];
          callbacks.clear();
          for (const fn of pending) if (renderer || fn.name === 'loop') fn(now);
        }
      };
      window.__sample = tag => { window.sceneSample(tag); return window.__messages.at(-1); };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const counters = await page.evaluate(() => {
      __advance(120);
      const active = __sample('active');
      const captures = [__sample('capture-1'), __sample('capture-2')];
      __advance(120, false);
      const stalled = __sample('renderer-stalled');
      return { active, captures, stalled, clock: __messages.find(message => message.kind === 'scene_clock_check') };
    });
    assert.equal(counters.clock.actual, 28800);
    const camera = await page.evaluate(() => window.ZodiacStagePure.debug());
    assert.equal(camera.controlled, true, 'wallpaper must own the scene camera');
    const expectedDistance = await page.evaluate(() => {
      const def = window.HertzStageRuntime.SpaceStagePure.catalog().find(scene => scene.id === 'zodiac');
      const cam = def.camera, tan = Math.tan(cam.fov * Math.PI / 360), aspect = innerWidth / innerHeight;
      return Math.max(cam.radius, Math.max(cam.fit.halfWidth / tan / aspect, cam.fit.halfHeight / tan));
    });
    assert.ok(Math.abs(camera.camera.position[2] - expectedDistance) < 0.2,
      'wallpaper camera must match the SpaceStage registry baseline');
    assert.ok(counters.active.renderDraws > 0);
    for (const sample of counters.captures) assert.equal(sample.renderDraws, counters.active.renderDraws, 'capture must not count as runtime drawing');
    assert.ok(counters.stalled.frames > counters.active.frames);
    assert.ok(counters.stalled.stats.time > counters.active.stats.time);
    assert.ok(counters.stalled.pixels.bright > 0);
    assert.equal(counters.stalled.renderDraws, counters.active.renderDraws, 'renderer stall is visible despite driver/capture progress');
    await page.evaluate(() => { sceneCycle(1); __advance(120); sceneLoseContext(); });
    await page.waitForFunction(() => __messages.some(message => message.tag === 'context-restored'), null, { polling: 50, timeout: 10000 });
    const restored = await page.evaluate(() => {
      const beforeFrame = __sample('restored-before-frame');
      __advance(120);
      const afterFrame = __sample('restored-after-frame');
      sceneFinish();
      return { beforeFrame, afterFrame, end: __messages.at(-1) };
    });
    assert.equal(restored.beforeFrame.stats.geometries, 0, 'restore callback precedes renderer upload');
    assert.equal(restored.beforeFrame.stats.drawCalls, 0);
    assert.ok(restored.afterFrame.renderDraws > restored.beforeFrame.renderDraws);
    assert.ok(restored.afterFrame.stats.geometries > 0);
    assert.ok(restored.afterFrame.pixels.bright > 0);
    assert.equal(restored.end, 'scene_done');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status: 'pass', clock: counters.clock, activeDraws: counters.active.renderDraws,
      stalledDraws: counters.stalled.renderDraws, restoredDraws: restored.afterFrame.renderDraws,
      checks: ['real draw counter', 'capture excluded', 'renderer stall mutation', 'restore before first draw', 'eight-hour clock preflight'] }));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
