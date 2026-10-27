// SPDX-License-Identifier: MIT
// Real WebGL checks for zodiac color, frequency response and particle interaction.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { build } = require('../tools/space-stage/node_modules/esbuild');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/zodiac-silk');

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const bundle = await build({
    stdin: { contents: "import * as THREE from 'three'; import {createWorld} from './src/world.js'; import {createScene} from './src/main.js'; import {createScope} from '../space-stage/src/scope.js'; window.test={THREE,createWorld,createScene,createScope};",
      resolveDir: path.join(root, 'tools/zodiac-stage') },
    bundle: true, format: 'iife', write: false, minify: true,
  });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [], report = {};
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.setContent('<style>body{margin:0;background:#030405}canvas{display:block}</style><canvas></canvas>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => {
      const { THREE, createWorld } = test;
      const scene = new THREE.Scene(); scene.background = new THREE.Color('#030405');
      const renderer = new THREE.WebGLRenderer({ canvas: document.querySelector('canvas'), antialias: true, preserveDrawingBuffer: true });
      renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.setSize(1280, 800);
      const camera = new THREE.PerspectiveCamera(42, 1.6, .1, 300);
      camera.position.set(0, 0, 11); camera.lookAt(0, 0, 0);
      const world = createWorld(THREE, scene, { quality: 'high' }); world.setSign(4);
      const figure = scene.getObjectByName('zodiac-figure');
      let particles; scene.traverse(o => { if (o.renderOrder === -10) particles = o; });
      const read = () => {
        renderer.render(scene, camera);
        const gl = renderer.getContext(), pixels = new Uint8Array(1280 * 800 * 4);
        gl.readPixels(0, 0, 1280, 800, gl.RGBA, gl.UNSIGNED_BYTE, pixels); return pixels;
      };
      const draw = (context = {}, onlyParticles = true, time = 5.2, sample = true) => {
        world.update(time, { state: 'hold', k: 1, camera, cameraPos: camera.position, width: 1280, height: 800,
          uiDt: 1 / 60, dt: 0, ...context });
        if (!sample) return;
        const visible = [];
        if (onlyParticles) scene.traverse(o => {
          if (o.isMesh || o.isPoints) { visible.push([o, o.visible]); o.visible = o === particles; }
        });
        const pixels = read(); visible.forEach(([o, v]) => { o.visible = v; }); return pixels;
      };
      const compare = (a, b) => {
        let changed = 0, total = 0;
        for (let i = 0; i < a.length; i += 4) {
          const d = Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]);
          total += d; if (d > 9) changed++;
        }
        return { changed, total };
      };
      const hues = pixels => {
        const bins = Array(12).fill(0);
        for (let i = 0; i < pixels.length; i += 4) {
          const r = pixels[i], g = pixels[i+1], b = pixels[i+2], hi = Math.max(r,g,b), lo = Math.min(r,g,b), d = hi-lo;
          if (hi < 28 || d / hi < .28) continue;
          let h = hi === r ? (g-b)/d : hi === g ? (b-r)/d+2 : (r-g)/d+4;
          h = (h+6)%6; bins[Math.floor(h*2)]++;
        }
        return { bins, visible: bins.filter(n => n >= 25).length };
      };
      window.silkTest = { THREE, world, scene, renderer, camera, figure, particles, draw, read, compare, hues };
    });
    await page.evaluate(() => silkTest.draw({}, false));
    await page.screenshot({ path: path.join(output, process.argv?.includes('--baseline') ? 'before.png' : 'after.png') });
    report.visual = await page.evaluate(() => {
      const { draw, compare, hues } = silkTest;
      const base = draw();
      return { hues: hues(base), stable: compare(base, draw()), bass: compare(base, draw({ bass: .9 })),
        mid: compare(base, draw({ mid: .9 })), treble: compare(base, draw({ treble: .9 })), onset: compare(base, draw({ onset: 1 })) };
    });
    fs.writeFileSync(path.join(output, 'visual-result.json'), JSON.stringify(report.visual, null, 2));
    console.log(JSON.stringify(report.visual));
    assert.equal(report.visual.stable.changed, 0, 'same playback time is deterministic');
    assert.ok(report.visual.hues.visible >= 4, 'a single sign contains several visible color families');
    for (const band of ['bass', 'mid', 'treble', 'onset']) assert.ok(report.visual[band].changed > 200, band + ' changes actual particle pixels');

    report.pointer = await page.evaluate(() => {
      const { THREE, world, camera, particles, draw, compare } = silkTest;
      const base = draw(), coords = particles.geometry.getAttribute('aShape');
      let nearest = 0, dist = Infinity;
      for (let i = 0; i < coords.count; i++) {
        const d = coords.getX(i)**2 + coords.getY(i)**2;
        if (d < dist && coords.getZ(i) > .8) { nearest = i; dist = d; }
      }
      const point = new THREE.Vector3().fromBufferAttribute(coords, nearest).applyMatrix4(particles.matrixWorld).project(camera);
      const pointer = { active: true, x: point.x, y: point.y, dragging: false, down: false };
      for (let i = 0; i < 180; i++) draw({ pointer }, true, 5.2, false);
      const hovered = draw({ pointer }), hover = compare(base, hovered);
      pointer.click = { serial: 1, x: point.x, y: point.y };
      draw({ pointer });
      for (let i = 0; i < 14; i++) draw({ pointer }, true, 5.2, false);
      const click = compare(hovered, draw({ pointer }));
      for (let i = 0; i < 100; i++) draw({ pointer }, true, 5.2, false);
      const decay = compare(hovered, draw({ pointer }));
      const reduced = draw({ reduced: true, pointer: { active: false } });
      const reducedClick = compare(reduced, draw({ reduced: true, pointer: { ...pointer, click: { ...pointer.click, serial: 2 } } }));
      world.setSign(4);
      for (let i = 0; i < 180; i++) draw({ pointer: { active: false } }, true, 5.2, false);
      const normal = draw({ pointer: { active: false } });
      for (let i = 0; i < 40; i++) draw({ pointer: { ...pointer, dragging: true, click: null } }, true, 5.2, false);
      const dragging = compare(normal, draw({ pointer: { ...pointer, dragging: true, click: null } }));
      return { hover, click, decay, reducedClick, dragging };
    });
    console.log(JSON.stringify(report.pointer));
    assert.ok(report.pointer.hover.changed > 200, 'hover produces a local particle deformation');
    assert.ok(report.pointer.click.changed > 200, 'click moves particles, beyond the overlay ring');
    assert.ok(report.pointer.decay.changed < 10, 'click impulse decays without retriggering the same serial');
    assert.equal(report.pointer.reducedClick.changed, 0, 'reduced motion disables pointer impulses');
    assert.ok(report.pointer.dragging.changed < 10, 'camera dragging does not deform the particles');

    report.observatory = await page.evaluate(() => {
      const { world, scene, draw, read, compare, renderer } = silkTest;
      const scanner = scene.getObjectByName('zodiac-scanner');
      if (!scanner) return { exists: false };
      world.setSign(4);
      for (let i = 0; i < 90; i++) draw({ pointer: null }, false, 5.2, false);
      draw({}, false);
      const target = world.stats().stars[0];
      const pointer = { active: true, x: target.x, y: target.y, down: false, dragging: false };
      const scannerPixels = () => {
        const visible = [];
        scene.traverse(o => { if (o.isMesh || o.isPoints) { visible.push([o, o.visible]); o.visible = o === scanner && scanner.visible; } });
        const pixels = read();
        visible.forEach(([o, value]) => { o.visible = value; });
        return pixels;
      };
      const empty = scannerPixels();
      for (let i = 0; i < 90; i++) draw({ pointer }, false, 5.2, false);
      draw({ pointer }, false);
      const hovered = scannerPixels(), locked = scanner.material.uniforms.uLock.value;
      const hover = compare(empty, hovered);
      for (let i = 0; i < 60; i++) draw({ pointer: { ...pointer, down: true } }, false, 5.2, false);
      draw({ pointer: { ...pointer, down: true } }, false);
      const charge = world.stats().charge, charged = compare(hovered, scannerPixels());
      const release = draw({ pointer: { ...pointer, click: { serial: 9001, x: pointer.x, y: pointer.y } } }, false);
      const surge = world.stats().surge;
      for (let i = 0; i < 100; i++) draw({ pointer }, false, 5.2, false);
      const released = compare(release, draw({ pointer }, false));
      draw({ pointer: { ...pointer, dragging: true } }, false);
      const draggingHidden = !scanner.visible;
      draw({ reduced: true, pointer }, false);
      const reducedHidden = !scanner.visible;
      for (let i = 0; i < 90; i++) draw({ pointer: { ...pointer, down: true } }, false, 5.2, false);
      const chargedBeforeSign = scanner.visible && world.stats().charge === 1;
      world.setSign(5);
      const signReset = chargedBeforeSign && !scanner.visible && world.stats().charge === 0;
      const rings = scene.getObjectByName('zodiac-aura').children;
      const geometry = rings[0].geometry, positions = geometry.getAttribute('position');
      let minRadius = Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < positions.count; i++) {
        minRadius = Math.min(minRadius, Math.hypot(positions.getX(i), positions.getY(i)));
        minZ = Math.min(minZ, positions.getZ(i)); maxZ = Math.max(maxZ, positions.getZ(i));
      }
      for (const quality of ['low', 'medium', 'high']) world.setQuality(quality);
      const pooled = rings.every(ring => ring.geometry === geometry);
      world.setSign(4);
      for (let i = 0; i < 90; i++) draw({ pointer: null }, false, 5.2, false);
      draw({}, false);
      return { exists: true, hover, locked, charge, charged, surge, released, draggingHidden, reducedHidden,
        signReset, minRadius, thickness: maxZ - minZ, pooled, geometries: renderer.info.memory.geometries };
    });
    assert.equal(report.observatory.exists, true, 'observatory has a world-space scanner');
    assert.ok(report.observatory.hover.changed > 60, 'hover paints a visible scanner, not only an internal flag');
    assert.ok(report.observatory.locked > .9, 'scanner locks onto a projected main star');
    assert.equal(report.observatory.charge, 1, 'holding fills the charge meter');
    assert.ok(report.observatory.charged.changed > 40, 'charge progress visibly changes scanner pixels');
    assert.ok(report.observatory.surge > .9 && report.observatory.released.changed > 200, 'release produces a visible impulse that decays');
    assert.equal(report.observatory.draggingHidden, true, 'camera drag immediately removes the scanner');
    assert.equal(report.observatory.reducedHidden, true, 'reduced motion immediately removes the scanner');
    assert.equal(report.observatory.signReset, true, 'switching signs clears scanner and charge');
    assert.ok(report.observatory.minRadius > .7, 'instrument rings use annular geometry, not full-screen alpha planes');
    assert.ok(report.observatory.thickness > .01, 'instrument rings have a curved physical cross-section');
    assert.equal(report.observatory.pooled, true, 'all instrument rings reuse their geometry across quality changes');
    console.log(JSON.stringify(report.observatory));

    report.palettes = await page.evaluate(() => {
      const { world, draw, hues, renderer } = silkTest, palettes = [];
      for (let sign = 0; sign < 12; sign++) { world.setSign(sign); palettes.push(hues(draw()).visible); }
      const memory = { ...renderer.info.memory };
      for (let sign = 0; sign < 24; sign++) { world.setSign(sign); draw(); }
      return { palettes, memory, after: { ...renderer.info.memory } };
    });
    console.log(JSON.stringify(report.palettes));
    assert.ok(report.palettes.palettes.every(n => n >= 2), 'all twelve signs retain visible color variation, including silver Cancer');
    assert.ok(report.palettes.palettes.filter(n => n >= 3).length >= 10, 'most palettes contain at least three saturated color families');
    assert.deepEqual(report.palettes.memory, report.palettes.after, 'cycling signs has bounded GPU residency');

    await page.evaluate(() => { silkTest.world.setSign(4); silkTest.draw({ bass: .48, mid: .5, treble: .4 }, false); });
    await page.screenshot({ path: path.join(output, 'music.png') });
    await page.evaluate(() => {
      const { camera, draw } = silkTest;
      camera.position.set(Math.sin(.85)*11, 0, Math.cos(.85)*11); camera.lookAt(0, 0, 0);
      draw({}, false);
    });
    await page.screenshot({ path: path.join(output, 'side.png') });

    report.pipeline = await page.evaluate(() => {
      const { renderer, camera, scene, world, read, compare } = silkTest; world.dispose();
      const scope = test.createScope();
      const instance = test.createScene({ THREE: test.THREE, renderer, camera, scene, scope, quality: { mode: 'high' }, params: {}, services: {} });
      instance.resize(1280, 800); instance.setParams({ sign: 'leo', field: false, meteors: 0, glow: 1, speed: 1 });
      instance.setRig({ position: [0, 0, 11], yaw: 0, pitch: 0, roll: 0, fov: 42, external: true });
      const frame = { now: 5200, time: 5.2, playing: true, dt: 1/60, spectrum: new Float32Array(64), onset: false };
      const snap = (bands, reactivity = 1) => {
        instance.setParams({ sign: 'leo', field: false, meteors: 0, glow: 1, speed: 1, reactivity });
        frame.bands = bands; frame.spectrum = null;
        for (let i = 0; i < 80; i++) instance.update(frame);
        scene.traverse(o => { if (o.isMesh || o.isPoints) o.visible = o.renderOrder === -10; });
        return read();
      };
      const silent = snap({ bass: 0, mid: 0, treble: 0 });
      const mid = compare(silent, snap({ bass: 0, mid: .9, treble: 0 }));
      const high = compare(silent, snap({ bass: 0, mid: 0, treble: .9 }));
      snap({ bass: 0, mid: 0, treble: 0 });
      const disabledBase = snap({ bass: 0, mid: 0, treble: 0 }, 0);
      const disabled = compare(disabledBase, snap({ bass: .9, mid: .9, treble: .9 }, 0));
      instance.setParams({ sign: 'leo', field: false, meteors: 0, glow: 1, speed: 1, reactivity: 1 });
      frame.bands = null; frame.spectrum = new Float32Array(64);
      for (let i = 0; i < 100; i++) instance.update(frame);
      const quietSpectrum = read();
      frame.spectrum.fill(.9, 28);
      for (let i = 0; i < 80; i++) instance.update(frame);
      const spectrum = compare(quietSpectrum, read());
      frame.playing = false; frame.bands = { bass: 1, mid: 1, treble: 1 };
      for (let i = 0; i < 80; i++) instance.update(frame);
      const pauseFrame = read(); frame.time += 1; frame.now += 1000;
      instance.update(frame);
      const paused = compare(pauseFrame, read());
      scope.dispose(); return { mid, high, disabled, spectrum, paused, resourcesAfterDispose: scope.stats().resources };
    });
    console.log(JSON.stringify(report.pipeline));
    assert.ok(report.pipeline.mid.changed > 200, 'shared scene accepts mid-frequency band input');
    assert.ok(report.pipeline.high.changed > 200, 'shared scene accepts treble band input');
    assert.equal(report.pipeline.disabled.changed, 0, 'reactivity=0 disables music response');
    assert.ok(report.pipeline.spectrum.changed > 200, 'actual high-frequency spectrum reaches the particle shader');
    assert.equal(report.pipeline.paused.changed, 0, 'paused playback is stable');
    assert.equal(report.pipeline.resourcesAfterDispose, 0, 'shared scope releases resources');
    assert.deepEqual(errors, [], 'no WebGL shader or browser errors');
    report.errors = errors;
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    console.log('PASS zodiac multicolor, frequency response, pointer deformation, lifecycle and resource release');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
