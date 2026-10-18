// SPDX-License-Identifier: MIT
// Actual WebGL pixels: sparse meteors, playback, camera following and resource lifetime.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { build } = require('../tools/zodiac-stage/node_modules/esbuild');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/zodiac-meteors');

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const bundle = await build({
    stdin: { contents: "import * as THREE from 'three'; import {createWorld} from './src/world.js'; window.meteorTest={THREE,createWorld};",
      resolveDir: path.join(root, 'tools/zodiac-stage') },
    bundle: true, format: 'iife', write: false,
  });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const errors = [], report = [];
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.setContent('<style>body{margin:0;background:#030405}canvas{display:block}</style><canvas></canvas>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => {
      const { THREE, createWorld } = meteorTest;
      const renderer = new THREE.WebGLRenderer({ canvas: document.querySelector('canvas'), antialias: true, preserveDrawingBuffer: true });
      renderer.setSize(800, 500);
      window.fixture = { THREE, createWorld, renderer };
      window.mount = quality => {
        const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(52, 1.6, .1, 300);
        const world = createWorld(THREE, scene, { quality });
        world.setSign(4);
        let meteor;
        scene.traverse(o => { if (o.geometry?.getAttribute('aPeriod')) meteor = o; });
        Object.assign(fixture, { world, scene, camera, meteor });
      };
      window.drawMeteor = (time, { reduced = false, translation = 0, aim = true, composite = false } = {}) => {
        const { scene, camera, world, meteor } = fixture;
        camera.position.set(translation, 0, 10 * Math.max(1, 1.6 / camera.aspect));
        const origin = new THREE.Vector3().fromBufferAttribute(meteor.geometry.getAttribute('aOrigin'), 0);
        camera.lookAt(aim ? origin.add(camera.position) : new THREE.Vector3(translation, 0, 0));
        world.update(time, { state: 'hold', k: 1, reduced, cameraPos: camera.position });
        const visibility = [];
        scene.traverse(o => {
          if (o.isMesh || o.isPoints) { visibility.push([o, o.visible]); o.visible = composite ? o.visible : o === meteor; }
        });
        renderer.render(scene, camera);
        const gl = renderer.getContext(), size = renderer.getSize(new THREE.Vector2());
        const pixels = new Uint8Array(size.x * size.y * 4);
        gl.readPixels(0, 0, size.x, size.y, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        visibility.forEach(([o, v]) => { o.visible = v; });
        return pixels;
      };
      window.energy = pixels => {
        let sum = 0, lit = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const value = pixels[i] + pixels[i + 1] + pixels[i + 2];
          sum += value; if (value > 6) lit++;
        }
        return { sum, lit };
      };
      window.delta = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0);
    });
    for (const quality of ['low', 'medium', 'high']) {
      const result = await page.evaluate(quality => {
        mount(quality);
        const { world, meteor, renderer } = fixture;
        const phase = meteor.geometry.getAttribute('aPhase').getX(0);
        const time = phase + .65;
        const a = drawMeteor(time), b = drawMeteor(time + .22);
        const moving = delta(a, b), frozen = delta(b, drawMeteor(time + .22));
        drawMeteor(time + 40);
        const seek = delta(a, drawMeteor(time));
        const translated = delta(a, drawMeteor(time, { translation: 1000 }));
        const reduced = energy(drawMeteor(time, { reduced: true }));
        world.setFieldVisible(false);
        const hidden = energy(drawMeteor(time));
        world.setFieldVisible(true);
        const front = energy(drawMeteor(time, { aim: false }));
        // No resource growth while seeking or switching quality; geometry is reused.
        const geometry = meteor.geometry, material = meteor.material;
        const resident = renderer.info.memory.geometries;
        const qualityCounts = [];
        for (const mode of ['low', 'medium', 'high']) {
          world.setQuality(mode); drawMeteor(time);
          qualityCounts.push(meteor.geometry.drawRange.count / 6);
        }
        const stableResources = meteor.geometry === geometry && meteor.material === material
          && renderer.info.memory.geometries === resident;
        let disposed = 0;
        geometry.addEventListener('dispose', () => disposed++);
        material.addEventListener('dispose', () => disposed++);
        drawMeteor(time, { aim: false, composite: true });
        const png = renderer.domElement.toDataURL();
        world.dispose();
        return { quality, time, visible: energy(a), moving, frozen, seek, translated, reduced, hidden, front,
          qualityCounts, stableResources, disposed, remaining: fixture.scene.children.length, png };
      }, quality);
      const { png, ...metrics } = result;
      report.push(metrics);
      fs.writeFileSync(path.join(output, quality + '.png'), Buffer.from(png.split(',')[1], 'base64'));
      console.log(metrics);
      assert.ok(result.visible.lit > 3, quality + ': meteors must produce visible pixels');
      assert.ok(result.moving > 30, quality + ': playback must move the meteor');
      assert.equal(result.frozen, 0, 'Pause freezes meteors');
      assert.equal(result.seek, 0, 'Seek reproduces the same pixels');
      assert.ok(result.translated < result.visible.sum * .03, 'Camera translation preserves distant meteor appearance');
      assert.equal(result.reduced.sum, 0, 'Reduced motion suppresses streaks');
      assert.equal(result.hidden.sum, 0, 'Field toggle hides meteors');
      assert.ok(result.front.lit > 3, quality + ': default view must contain a meteor');
      const cap = { low: 3, medium: 5, high: 7 }[quality];
      assert.deepEqual(result.qualityCounts, [3, Math.min(5, cap), cap], 'Live quality updates whole meteor quads');
      assert.equal(result.stableResources, true, 'Seeking and quality changes reuse GPU resources');
      assert.equal(result.disposed, 2, 'Unmount releases meteor geometry and material');
      assert.equal(result.remaining, 0, 'Unmount removes scene objects');
    }
    const portrait = await page.evaluate(() => {
      mount('low');
      const { renderer, camera, world, meteor } = fixture;
      renderer.setSize(390, 720);
      camera.aspect = 390 / 720; camera.updateProjectionMatrix();
      const phase = meteor.geometry.getAttribute('aPhase').getX(0);
      const period = meteor.geometry.getAttribute('aPeriod').getX(0);
      meteor.geometry.setDrawRange(0, 6);
      const before = energy(drawMeteor(phase - .1));
      const after = energy(drawMeteor(phase + 1.3));
      const next = energy(drawMeteor(phase + period + .65));
      const visible = energy(drawMeteor(phase + .65, { aim: false }));
      drawMeteor(phase + .65, { aim: false, composite: true });
      const png = renderer.domElement.toDataURL();
      world.dispose();
      // A shared scope owns disposal in the integrated stage host.
      const tracked = [], scene = new fixture.THREE.Scene();
      const scoped = fixture.createWorld(fixture.THREE, scene, { quality: 'low', scope: { track: r => tracked.push(r) } });
      let meteorObject;
      scene.traverse(o => { if (o.geometry?.getAttribute('aPeriod')) meteorObject = o; });
      let disposals = 0;
      meteorObject.geometry.addEventListener('dispose', () => disposals++);
      meteorObject.material.addEventListener('dispose', () => disposals++);
      scoped.dispose();
      const beforeScopeDispose = disposals;
      tracked.forEach(r => r.dispose());
      renderer.dispose();
      return { before, after, next, visible, beforeScopeDispose, disposals, png };
    });
    assert.equal(portrait.before.sum, 0, 'No meteor before its first event');
    assert.equal(portrait.after.sum, 0, 'Meteor disappears after its short flight');
    assert.ok(portrait.next.lit > 3, 'Meteor repeats after its quiet interval');
    assert.ok(portrait.visible.lit > 3, 'Portrait default view contains a meteor');
    assert.equal(portrait.beforeScopeDispose, 0, 'World leaves scoped resources to the host');
    assert.equal(portrait.disposals, 2, 'Host scope disposes meteor resources exactly once');
    fs.writeFileSync(path.join(output, 'portrait.png'), Buffer.from(portrait.png.split(',')[1], 'base64'));
    delete portrait.png;
    assert.deepEqual(errors, [], 'No WebGL or shader errors');
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ report, portrait, errors }, null, 2));
    console.log('PASS meteor pixels, playback, camera, quality, visibility and disposal');
  } finally { await browser.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
