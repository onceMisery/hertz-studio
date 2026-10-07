'use strict';
// Small production WebGL probes: lyric clearance, quality caps and complete subsystem lifetime.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const web = path.join(__dirname, '../plugin/ui');

async function main() {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setContent('<style>#stage{width:640px;height:480px;position:relative}.stage-lyrics{height:80px;position:absolute;top:200px}</style><div id="stage"><div class="stage-lyrics"></div></div>');
    await page.evaluate(() => {
      const f = window.fixture = { tier: 0, hidden: false, observers: 0, disconnects: 0, gateAdds: 0, gateRemoves: 0, rafCancels: 0 };
      const Observer = window.ResizeObserver;
      window.ResizeObserver = class extends Observer {
        constructor(callback) { super(callback); f.observers += 1; }
        disconnect() { f.disconnects += 1; super.disconnect(); }
      };
      const cancel = window.cancelAnimationFrame.bind(window);
      window.cancelAnimationFrame = id => { f.rafCancels += 1; return cancel(id); };
      window.Stage = {
        tier: () => f.tier, isHidden: () => f.hidden, isStageVisible: () => !f.hidden && !f.drawerClosed,
        presentation: () => ({ reduced: !!f.reduced }), spectrum: () => [], kick() {},
        gate(name, fps, tick) { f.gateAdds += 1; f.gate = { fps, tick }; },
        removeGate() { f.gateRemoves += 1; }
      };
    });
    for (const file of ['onset.js', 'stage-particles-gl.js', 'stage-particles.js']) {
      if (file === 'stage-particles.js') await page.evaluate(() => {
        const create = Onset.create;
        Onset.create = (...args) => {
          const detector = create(...args), onBeat = detector.onBeat;
          detector.onBeat = callback => { fixture.beat = callback; return onBeat.call(detector, callback); };
          return detector;
        };
      });
      await page.addScriptTag({ path: path.join(web, file) });
    }
    const shading = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); document.body.append(canvas);
      const view = { canvas, w: 640, h: 480, cx: 320, cy: 240, fade0: 200, fade1: 280 };
      const renderer = ParticleGL.create(); renderer.mount(view); renderer.resize(view);
      renderer.setColors('255,255,255', '255,255,255');
      const random = Math.random; let index = 0;
      const values = [0.15, 0.5, 0.85].flatMap(y => [(1.06 - y) / 1.12, 1, 0, 1, 0.5]);
      try { Math.random = () => values[index++]; renderer.setCount(3); } finally { Math.random = random; }
      const frame = { t: 0, dt: 16, bands: [0, 0, 0, 0], pulse: 0, energy: 0, strength: 1, drift: 0 };
      function read() {
        renderer.draw(view, frame);
        const gl = canvas.getContext('webgl2'), pixels = new Uint8Array(640 * 480 * 4), sums = [0, 0, 0];
        gl.readPixels(0, 0, 640, 480, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        for (let y = 0; y < 480; y += 1) for (let x = 0; x < 640; x += 1) {
          const region = Math.round((1 - y / 480 - 0.15) / 0.35);
          if (region >= 0 && region < 3) sums[region] += pixels[(y * 640 + x) * 4 + 3];
        }
        return sums;
      }
      const dimmed = read();
      frame.t = 500; frame.bands[3] = 1;
      const air = read();
      frame.t = 0; frame.bands[3] = 0;
      view.fade1 = -1; const uniform = read();
      fixture.tier = 2; renderer.resize(view);
      const size = [canvas.width, canvas.height];
      renderer.dispose(); canvas.remove(); fixture.tier = 0;
      return { dimmed, air, uniform, size };
    });
    assert.ok(shading.dimmed[1] < shading.dimmed[0] * 0.4, 'GL dims particles in the lyric band');
    assert.equal(shading.dimmed[0], shading.dimmed[2], 'equal particles remain balanced outside lyrics');
    assert.equal(shading.uniform[0], shading.uniform[1], 'disabling the lyric band restores uniform exposure');
    assert.deepEqual(shading.size, [864, 648], 'DPR 2 remains capped to the high-tier 1.35 budget');
    assert.ok(shading.air[1] < Math.min(shading.air[0], shading.air[2]) * 0.4,
      'high-frequency shimmer respects lyric clearance');

    const continuity = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); document.body.append(canvas);
      const view = { canvas, w: 640, h: 480, cx: 320, cy: 240, fade0: -1, fade1: -1 };
      const renderer = ParticleGL.create(); renderer.mount(view); renderer.resize(view);
      renderer.setColors('255,255,255', '255,255,255');
      const random = Math.random;
      try { Math.random = () => 0.5; renderer.setCount(1); } finally { Math.random = random; }
      const frame = { t: 180000, dt: 0, bands: [0, 0, 0, 0], pulse: 0, energy: 0, strength: 1, drift: 1 };
      function center() {
        renderer.draw(view, frame);
        const gl = canvas.getContext('webgl2'), pixels = new Uint8Array(640 * 480 * 4);
        gl.readPixels(0, 0, 640, 480, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let mass = 0, x = 0, y = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const alpha = pixels[i + 3]; mass += alpha;
          x += (i / 4 % 640) * alpha; y += Math.floor(i / 4 / 640) * alpha;
        }
        if (!mass) throw new Error('continuity probe must draw a visible particle');
        return { x: x / mass, y: y / mass };
      }
      const before = center(); frame.t += 16; frame.dt = 16; frame.bands[2] = 1;
      const after = center(); frame.drift = 2; const adjusted = center();
      renderer.dispose(); canvas.remove();
      return { jump: Math.hypot(after.x - before.x, after.y - before.y),
        adjusted: Math.hypot(adjusted.x - after.x, adjusted.y - after.y) };
    });
    assert.ok(continuity.jump < 2, 'audio changes must not teleport particles after long playback: ' + continuity.jump);
    assert.ok(continuity.adjusted < 2, 'changing drift speed must not teleport particles: ' + continuity.adjusted);

    const drift = await page.evaluate(() => {
      const random = Math.random, now = performance.now, draw = CanvasRenderingContext2D.prototype.drawImage;
      let position, time;
      Math.random = () => 0.5; performance.now = () => time;
      CanvasRenderingContext2D.prototype.drawImage = function (sprite, x, y, w, h) {
        position = { x: x + w / 2, y: y + h / 2 };
        return draw.call(this, sprite, x, y, w, h);
      };
      try {
        return [15, 30].map(fps => {
          time = 100; StageParticles.init(); StageParticles.attach('standard');
          fixture.gate.tick(0); const start = position.y;
          for (let i = 0; i < fps; i++) { time += 1000 / fps; fixture.gate.tick(1000 / fps); }
          const distance = start - position.y; StageParticles.destroy(); return distance;
        });
      } finally {
        Math.random = random; performance.now = now; CanvasRenderingContext2D.prototype.drawImage = draw;
      }
    });
    assert.ok(Math.abs(drift[0] - drift[1]) < 0.001, '2D drift depends on elapsed time, not frame count: ' + drift);
    // The extra lifecycle probes above intentionally create and release two observers.
    await page.evaluate(() => { fixture.observers = fixture.disconnects = fixture.gateAdds = fixture.gateRemoves = 0; });

    const lifetime = await page.evaluate(() => {
      const f = fixture;
      StageParticles.init(); StageParticles.init(); StageParticles.attach('enhanced');
      const gl = document.querySelector('#stage canvas').getContext('webgl2');
      let deleted = 0; const remove = gl.deleteBuffer.bind(gl);
      gl.deleteBuffer = (...args) => { deleted += 1; return remove(...args); };
      const idle = f.gate.fps(); f.hidden = true; const hidden = f.gate.fps(); f.hidden = false;
      document.body.classList.add('is-playing'); const playing = f.gate.fps();
      f.reduced = true; const reduced = f.gate.fps(); f.reduced = false;
      f.drawerClosed = true; const drawerClosed = f.gate.fps(); f.drawerClosed = false;
      f.gate.tick(16); // Starts the short A/B probe; destroy must cancel it before either measurement.
      StageParticles.destroy();
      const after = { deleted, attached: StageParticles.attached(), renderer: StageParticles.renderer(),
        canvases: document.querySelectorAll('#stage canvas').length, disconnects: f.disconnects,
        gateAdds: f.gateAdds, rafCancels: f.rafCancels, idle, hidden, playing, reduced, drawerClosed };
      document.body.classList.remove('is-playing');
      StageParticles.init(); StageParticles.attach('enhanced');
      after.restoredGL = !!document.querySelector('#stage canvas').getContext('webgl2');
      return after;
    });
    assert.equal(lifetime.deleted, 1, 'destroy releases the GPU buffer');
    assert.equal(lifetime.attached, false, 'destroy clears attachment state');
    assert.equal(lifetime.renderer, 'none', 'destroy reports no active renderer');
    assert.equal(lifetime.canvases, 0, 'destroy removes the canvas');
    assert.equal(lifetime.disconnects, 1, 'destroy disconnects geometry observation');
    assert.equal(lifetime.gateAdds, 1, 'repeated init does not duplicate observers or gates');
    assert.equal(lifetime.rafCancels, 1, 'destroy cancels the in-flight probe frame');
    assert.equal(lifetime.idle, 0, 'paused clean state has no particle frames');
    assert.equal(lifetime.hidden, 0, 'hidden stage has no particle frames');
    assert.ok(lifetime.playing > 0, 'visible playback requests frames');
    assert.equal(lifetime.reduced, 0, 'reduced motion stops particle rendering');
    assert.equal(lifetime.drawerClosed, 0, 'closed mobile drawer stops particle rendering');
    assert.ok(lifetime.restoredGL, 'reattach creates a real WebGL renderer');
    await page.evaluate(async () => {
      const canvas = document.querySelector('#stage canvas'), gl = canvas.getContext('webgl2');
      await new Promise(resolve => {
        canvas.addEventListener('webglcontextlost', resolve, { once: true });
        gl.getExtension('WEBGL_lose_context').loseContext();
      });
      fixture.gate.tick(16);
    });
    const fallback = await page.evaluate(() => {
      const f = fixture, result = { renderer: StageParticles.renderer(), reason: StageParticles.degradedBecause(),
        context2D: !!document.querySelector('#stage canvas').getContext('2d') };
      StageParticles.destroy(); const density = StageParticles.values().density;
      document.dispatchEvent(new CustomEvent('stagecontrol:change', { detail: { density: density + 1 } }));
      result.detachedListeners = density === StageParticles.values().density;
      result.observersBalanced = f.observers === f.disconnects;
      return result;
    });
    assert.equal(fallback.renderer, 'canvas2d', 'context loss degrades to the existing 2D renderer');
    assert.ok(fallback.context2D && fallback.reason, 'fallback provides a usable context and visible reason');
    assert.ok(fallback.detachedListeners, 'destroy removes settings listeners');
    assert.ok(fallback.observersBalanced, 'every observer is disconnected');
    const cancelled = await page.evaluate(async () => {
      const f = fixture, pending = new Map(); let id = 0; f.time = 100;
      const raf = window.requestAnimationFrame, cancel = window.cancelAnimationFrame;
      const now = performance.now, random = Math.random, draw = CanvasRenderingContext2D.prototype.drawImage;
      window.requestAnimationFrame = callback => { pending.set(++id, callback); return id; };
      window.cancelAnimationFrame = key => pending.delete(key);
      performance.now = () => f.time; Math.random = () => 0.5;
      let draws = 0;
      CanvasRenderingContext2D.prototype.drawImage = function (...args) { draws += 1; return draw.apply(this, args); };
      async function advance(count, delta) {
        for (let i = 0; i < count; i += 1) {
          f.time += delta;
          const callbacks = [...pending.values()]; pending.clear();
          callbacks.forEach(callback => callback(f.time));
          await Promise.resolve(); await Promise.resolve();
        }
      }
      const results = [];
      try {
        for (const phase of ['baseline', 'webgl']) {
          StageParticles.init(); StageParticles.attach('enhanced');
          document.body.classList.add('is-playing'); f.gate.tick(16);
          if (phase === 'webgl') await advance(30, 17);
          StageParticles.handleContextLost();
          draws = 0; f.gate.tick(16); const before = draws;
          await advance(24, 21);
          draws = 0; f.gate.tick(16);
          results.push({ phase, before, after: draws, pending: pending.size });
          StageParticles.destroy();
        }
      } finally {
        window.requestAnimationFrame = raf; window.cancelAnimationFrame = cancel;
        performance.now = now; Math.random = random; CanvasRenderingContext2D.prototype.drawImage = draw;
        document.body.classList.remove('is-playing');
      }
      return results;
    });
    for (const result of cancelled) {
      assert.ok(result.before > 0, result.phase + ': standard renderer is drawing after fallback');
      assert.equal(result.after, result.before, result.phase + ': old GL probe cannot reduce the new 2D budget');
      assert.equal(result.pending, 0, result.phase + ': renderer replacement cancels pending probe callbacks');
    }
    const initialRipple = await page.evaluate(() => {
      StageParticles.init(); StageParticles.attach('standard'); fixture.beat();
      document.querySelector('.stage-ripple.is-live').getAnimations()[0].finish();
      StageParticles.destroy(); StageParticles.init(); StageParticles.attach('standard'); fixture.beat();
      return StageParticles.stats().ripples;
    });
    await page.waitForTimeout(60); // Let the already queued old WAAPI finish event be dispatched.
    const currentRipple = await page.evaluate(() => { const count = StageParticles.stats().ripples; StageParticles.destroy(); return count; });
    assert.equal(initialRipple, 1, 'new lifetime starts its own ripple');
    assert.equal(currentRipple, 1, 'queued finish from the old lifetime cannot consume the new ripple');
    await page.addStyleTag({ path: path.join(web, 'stage.css') });
    await page.evaluate(() => { StageParticles.init(); StageParticles.attach('standard'); });
    for (const preference of ['reduce', 'no-preference']) {
      await page.emulateMedia({ reducedMotion: preference });
      assert.equal(await page.locator('.stage-particles').evaluate(el => getComputedStyle(el).display),
        preference === 'reduce' ? 'none' : 'block', 'system motion preference controls the visible layer');
    }
    await page.evaluate(() => document.body.classList.add('reduce-motion'));
    assert.equal(await page.locator('.stage-particles').evaluate(el => getComputedStyle(el).display), 'none',
      'application motion preference hides the layer');
    await page.evaluate(() => { document.body.classList.remove('reduce-motion'); StageParticles.destroy(); });
    assert.deepEqual(errors, [], 'no page errors');
    console.log('PASS particles: lyric clearance, DPR budget, idle/hidden gates, probe cancellation, destroy/reattach and GL loss',
      JSON.stringify({ shading, continuity, drift, lifetime, fallback, cancelled, currentRipple }));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
