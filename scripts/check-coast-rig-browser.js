// SPDX-License-Identifier: MIT
// Real Three camera, pixels and the existing rAF: Space3D camera handoff to Coast.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');

async function main() {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.setContent('<style>body{margin:0}canvas{width:640px;height:360px}</style><canvas></canvas>');
    await page.evaluate(() => {
      let serial = 0, now = 1000;
      const callbacks = new Map();
      window.requestAnimationFrame = fn => { callbacks.set(++serial, fn); return serial; };
      window.cancelAnimationFrame = id => callbacks.delete(id);
      window.__step = (dt = 1 / 60) => {
        now += dt * 1000;
        const pending = [...callbacks.values()]; callbacks.clear();
        pending.forEach(fn => fn(now));
      };
      window.__pending = () => callbacks.size;
      window.__camera = () => {
        const d = CoastStagePure.debug();
        const camera = d.scene.children.find(o => o.isPerspectiveCamera);
        camera.updateMatrixWorld();
        const m = camera.matrixWorld.elements;
        return { position: camera.position.toArray(), direction: [-m[8], -m[9], -m[10]], quaternion: camera.quaternion.toArray(),
          fov: camera.fov, projection: camera.projectionMatrix.toArray(),
          rig: d.rig, distance: d.distance };
      };
    });
    await page.addScriptTag({ path: path.join(root, 'plugin/ui/vendor/stage-runtime.js') });
    await page.addScriptTag({ path: path.join(root, 'plugin/ui/vendor/coast-stage.js') });
    const result = await page.evaluate(() => {
      CoastStagePure.mount(document.querySelector('canvas'), { quality: 'low' });
      __step(); __step();
      const native = __camera();
      CoastStagePure.setInteraction(false);
      CoastStagePure.setRig({ yaw: Math.PI / 2, pitch: 0, dist: 12, tx: 2, ty: 10, tz: 4, fov: 40 }, { external: true });
      __step();
      const orbit = __camera();
      CoastStagePure.capture();
      const orbitPixels = document.querySelector('canvas').toDataURL();
      CoastStagePure.setRig({ position: [1, 12, 3], yaw: Math.PI / 2, pitch: 0.2, roll: 0.2, fov: 64, external: true });
      __step();
      const free = __camera();
      CoastStagePure.capture();
      const freePixels = document.querySelector('canvas').toDataURL();
      for (let i = 0; i < 50; i++) __step(0.1);
      const held = __camera();
      CoastStagePure.setRig({ position: [NaN, 1, 2], yaw: NaN });
      __step();
      const invalid = __camera();
      CoastStagePure.setRig({ yaw: 0, pitch: 0, dist: 9, tx: 0, ty: 10, tz: 0, fov: 56 });
      __step();
      const first = __camera();
      for (let i = 0; i < 180; i++) __step();
      const settled = __camera();
      CoastStagePure.setRig({ position: [0, -100, 0], yaw: 0, pitch: 0, external: true });
      __step();
      const ground = __camera();
      CoastStagePure.setRig(null);
      CoastStagePure.setInteraction(true);
      __step();
      const released = __camera();
      const loops = __pending();
      CoastStagePure.unmount();
      return { native, orbit, free, held, invalid, first, settled, ground, released, loops,
        pendingAfterUnmount: __pending(), pixelsChanged: orbitPixels !== freePixels };
    });
    const near = (actual, expected, label) => actual.forEach((v, i) =>
      assert.ok(Math.abs(v - expected[i]) < 0.002, label + ': ' + actual + ' vs ' + expected));
    near(result.orbit.position, [14, 10, 4], 'orbit includes target');
    near(result.orbit.direction, [-1, 0, 0], 'orbit looks at target');
    assert.equal(result.orbit.fov, 40, 'FOV reaches actual camera');
    assert.ok(Math.abs(result.orbit.projection[5] - 1 / Math.tan(40 * Math.PI / 360)) < 1e-9,
      'FOV reaches projection matrix');
    near(result.free.position, [1, 12, 3], 'free position reaches camera');
    near(result.free.direction, [-Math.cos(0.2), Math.sin(0.2), 0], 'free yaw/pitch preserve direction');
    near(result.free.quaternion, [Math.SQRT1_2 * Math.sin(0.2), Math.SQRT1_2 * Math.cos(0.2), 0, Math.SQRT1_2],
      'free roll reaches actual orientation');
    near(result.held.position, [1, 12, 3], 'idle does not steal supplied camera');
    near(result.invalid.position, [1, 12, 3], 'invalid input preserves camera');
    assert.ok(result.first.position[2] > 3 && result.first.position[2] < 9, 'default update is damped');
    near(result.settled.position, [0, 10, 9], 'default damping settles');
    assert.ok(result.ground.position[1] >= 0.32, 'free camera keeps terrain safety');
    assert.equal(result.released.rig.yaw, result.native.rig.yaw, 'release restores native rig');
    assert.equal(result.released.fov, 44, 'release restores native FOV');
    assert.ok(result.released.distance > result.native.distance, 'native road motion continues');
    assert.ok(result.pixelsChanged, 'free pose changes actual rendered pixels');
    assert.equal(result.loops, 1, 'camera control does not add a loop');
    assert.equal(result.pendingAfterUnmount, 0, 'unmount cancels scene loop');

    // Real adapters share this lifecycle contract. Exercise an actual lost
    // context through the bounded rebuild path, then quality downgrade/remount.
    await page.addScriptTag({ path: path.join(root, 'plugin/ui/stage-coast.js') });
    await page.addScriptTag({ path: path.join(root, 'plugin/ui/vendor/zodiac-stage.js') });
    await page.addScriptTag({ path: path.join(root, 'plugin/ui/stage-zodiac.js') });
    result.adapters = {};
    for (const name of ['Coast', 'Zodiac']) {
      const before = await page.evaluate(name => {
        const adapter = window['Stage' + name];
        document.body.innerHTML = '<div id="rig-host" style="width:640px;height:360px"></div>';
        adapter.setHost(document.getElementById('rig-host'));
        adapter.setInteraction(false);
        adapter.setRig({ position: [1, 12, 3], yaw: Math.PI / 2, pitch: 0, fov: 48, external: true });
        __step(); __step();
        const engine = window[name + 'StagePure'];
        const snapshot = engine.debug().camera;
        const gl = document.querySelector('canvas').getContext('webgl2');
        gl.getExtension('WEBGL_lose_context').loseContext();
        return snapshot;
      }, name);
      await page.waitForFunction(name => !!window['Stage' + name].degradedBecause(), name, { polling: 20 });
      await page.waitForFunction(name => !window['Stage' + name].degradedBecause(), name, { polling: 20, timeout: 6000 });
      const restored = await page.evaluate(name => {
        __step(); __step();
        const engine = window[name + 'StagePure'];
        const restored = engine.debug();
        document.dispatchEvent(new CustomEvent('stage:fps', { detail: { lowfx: true } }));
        __step(); __step();
        const downgraded = engine.debug();
        const adapter = window['Stage' + name];
        const host = document.getElementById('rig-host');
        const count = host.querySelectorAll('canvas').length;
        const loops = __pending();
        adapter.setHost(null);
        adapter.setPrefs({ interact: true });
        adapter.setHost(host);
        __step(); __step();
        const fresh = engine.debug();
        adapter.setHost(null);
        return { restored: restored.camera, downgraded: downgraded.camera, count, loops,
          freshControlled: fresh.controlled, freshInteractive: name === 'Coast' ? fresh.interactive : fresh.prefs.interactive,
          pendingAfterUnmount: __pending() };
      }, name);
      near(restored.restored.position, before.position, name + ' actual context rebuild preserves position');
      near(restored.restored.direction, before.direction, name + ' actual context rebuild preserves heading');
      near(restored.downgraded.position, before.position, name + ' quality rebuild preserves position');
      assert.equal(restored.downgraded.fov, 48, name + ' quality rebuild preserves FOV');
      assert.equal(restored.count, 1, name + ' rebuild leaves one canvas');
      assert.equal(restored.loops, 2, name + ' retains only the existing engine and adapter loops');
      assert.equal(restored.freshControlled, false, name + ' fresh Stage3D mount releases camera');
      assert.equal(restored.freshInteractive, true, name + ' Stage3D can restore pointer preference');
      assert.equal(restored.pendingAfterUnmount, 0, name + ' unmount cancels both loops');
      result.adapters[name] = restored;
    }
    assert.deepEqual(errors, [], 'no browser errors');
    const output = path.join(root, 'output/playwright/coast-rig');
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log('Coast rig: orbit/free camera, FOV, pixels, damping, terrain and release passed; Coast/Zodiac context and quality rebuilds preserve camera');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
