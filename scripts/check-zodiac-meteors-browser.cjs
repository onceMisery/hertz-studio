// SPDX-License-Identifier: MIT
// Actual WebGL pixels for the camera-facing meteor layer: cycle showers,
// ambient cadence, density, portrait, pause/seek and resource lifetime.
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
    stdin: { contents: "import * as THREE from 'three'; import {createWorld} from './src/world.js'; import {CYCLE_SECONDS} from './src/zodiac.js'; window.meteorTest={THREE,createWorld,CYCLE_SECONDS};",
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
      window.drawMeteor = (time, { reduced = false, translate = 0, width = 800, height = 500 } = {}) => {
        const { scene, camera, world, meteor } = fixture;
        camera.position.set(translate, 0, 12);
        camera.lookAt(translate, 0, 0);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
        world.update(time, { state: 'hold', k: 1, reduced, cameraPos: camera.position, camera,
          width, height, now: time * 1000, uiDt: .016 });
        const visibility = [];
        scene.traverse(o => {
          if (o.isMesh || o.isPoints) { visibility.push([o, o.visible]); if (o !== meteor) o.visible = false; }
        });
        renderer.setSize(width, height);
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
    const showerTime = 2.0, ambientTime = 5.0;
    for (const quality of ['low', 'medium', 'high']) {
      const result = await page.evaluate(({ quality, showerTime, ambientTime }) => {
        mount(quality);
        const { world, meteor, renderer } = fixture;
        const shower = energy(drawMeteor(showerTime));
        const ambient = energy(drawMeteor(ambientTime));
        const moved = delta(drawMeteor(ambientTime), drawMeteor(ambientTime + .22));
        const frozen = delta(drawMeteor(ambientTime + .22), drawMeteor(ambientTime + .22));
        const seek = delta(drawMeteor(ambientTime), drawMeteor(ambientTime));
        const repeated = energy(drawMeteor(meteorTest.CYCLE_SECONDS + showerTime));
        const translated = delta(drawMeteor(ambientTime), drawMeteor(ambientTime, { translate: 1000 }));
        const reduced = energy(drawMeteor(showerTime, { reduced: true }));
        world.setMeteors(0);
        const densityOff = energy(drawMeteor(showerTime));
        world.setMeteors(1);
        world.setFieldVisible(false);
        const fieldOff = energy(drawMeteor(showerTime));
        world.setFieldVisible(true);
        const portrait = energy(drawMeteor(showerTime, { width: 390, height: 720 }));
        const geometry = meteor.geometry, material = meteor.material;
        const resident = renderer.info.memory.geometries, counts = [];
        for (const mode of ['low', 'medium', 'high']) {
          world.setQuality(mode);
          drawMeteor(showerTime, { width: 800, height: 500 });
          counts.push(meteor.geometry.drawRange.count / 6);
        }
        const stableResources = meteor.geometry === geometry && meteor.material === material
          && renderer.info.memory.geometries === resident;
        let disposed = 0;
        geometry.addEventListener('dispose', () => disposed++);
        material.addEventListener('dispose', () => disposed++);
        drawMeteor(showerTime);
        const png = renderer.domElement.toDataURL();
        world.dispose();
        return { quality, shower, ambient, moved, frozen, seek, repeated, translated, reduced, densityOff, fieldOff,
          portrait, counts, stableResources, disposed, remaining: fixture.scene.children.length, png };
      }, { quality, showerTime, ambientTime });
      const { png, ...metrics } = result;
      report.push(metrics);
      fs.writeFileSync(path.join(output, quality + '.png'), Buffer.from(png.split(',')[1], 'base64'));
      console.log(metrics);
      assert.ok(result.shower.lit > 3, quality + ': cycle shower is visible');
      assert.ok(result.ambient.lit > 3, quality + ': ambient meteor is visible');
      assert.ok(result.moved > 30, quality + ': playback moves the meteor');
      assert.equal(result.frozen, 0, 'Pause freezes meteors');
      assert.equal(result.seek, 0, 'Seek reproduces the same pixels');
      assert.ok(result.repeated.lit > 3, quality + ': shower repeats at the next sign cycle');
      assert.ok(result.translated < result.shower.sum * .03, 'Camera translation preserves meteor appearance');
      assert.equal(result.reduced.sum, 0, 'Reduced motion suppresses streaks');
      assert.equal(result.densityOff.sum, 0, 'Density zero removes meteors');
      assert.ok(result.fieldOff.lit > 3, quality + ': star-field toggle leaves the meteor layer visible');
      assert.ok(result.portrait.lit > 3, quality + ': portrait view contains a meteor');
      assert.deepEqual(result.counts, quality === 'low' ? [5, 5, 5] : quality === 'medium' ? [5, 10, 10] : [5, 10, 18],
        quality + ': live quality updates use accumulated draw ranges');
      assert.equal(result.stableResources, true, 'Seeking and quality changes reuse GPU resources');
      assert.equal(result.disposed, 2, 'Unmount releases meteor geometry and material');
      assert.equal(result.remaining, 0, 'Unmount removes scene objects');
    }
    assert.deepEqual(errors, [], 'No WebGL or shader errors');
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ report, errors }, null, 2));
    console.log('PASS meteor pixels, cycles, density, portrait, pause and disposal');
  } finally { await browser.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
