#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { readAssets } = require('./ui-assets');
const root = path.resolve(__dirname, '..'), web = path.join(root, 'plugin/ui');
const output = process.env.PHOENIX_TEST_OUTPUT ? path.resolve(process.env.PHOENIX_TEST_OUTPUT) : path.join(root, 'output/playwright/phoenix');

async function previewContract(browser) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } }), errors = [];
  page.setDefaultTimeout(60000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const paths = new Set(['/tools/space-stage/phoenix-preview.html', '/tools/space-stage/phoenix-preview.js',
    '/plugin/ui/vendor/stage-runtime.js', '/plugin/ui/vendor/space-stage.js', '/plugin/ui/space-camera.js']);
  await page.route('http://phoenix-preview.test/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (!paths.has(pathname)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: pathname.endsWith('.html') ? 'text/html' : 'application/javascript', body: fs.readFileSync(path.join(root, pathname)) });
  });
  try {
    await page.goto('http://phoenix-preview.test/tools/space-stage/phoenix-preview.html');
    await page.waitForFunction(() => window.phoenixPreview?.stats().state === 'ready' && document.querySelector('#error').textContent === '');
    await page.locator('#play').click();
    const before = await page.evaluate(() => ({ camera: SpaceCamera.pose(), scene: phoenixPreview.stats().sceneStats.primary }));
    // Full-viewport captures avoid an element-stability wait competing with
    // continuous software WebGL rendering. The controls stay fixed here.
    const pixels = await page.screenshot({ timeout: 60000 });
    await page.mouse.move(430, 380); await page.mouse.down(); await page.mouse.move(610, 440, { steps: 12 }); await page.mouse.up();
    await page.waitForFunction(() => Math.abs(SpaceCamera.pose().world.y) > .1);
    const dragged = await page.evaluate(() => ({ camera: SpaceCamera.pose(), scene: phoenixPreview.stats().sceneStats.primary }));
    assert.notDeepEqual(dragged.camera.world, before.camera.world, 'preview drag changes the camera');
    assert.equal(dragged.scene.elapsed, before.scene.elapsed, 'paused preview remains paused while orbiting');
    assert.equal(dragged.scene.bursts, before.scene.bursts, 'a camera drag cannot trigger a ritual click');
    assert.notDeepEqual(await page.screenshot({ timeout: 60000 }), pixels, 'camera drag changes actual preview pixels');
    await page.mouse.wheel(0, -500);
    await page.waitForFunction(radius => SpaceCamera.pose().radius < radius - .5, before.camera.radius);
    await page.locator('#reset-camera').click();
    await page.waitForFunction(() => Math.abs(SpaceCamera.pose().world.x) + Math.abs(SpaceCamera.pose().world.y) < .015);
    await page.mouse.move(420, 400); await page.mouse.down(); await page.mouse.move(560, 350, { steps: 10 }); await page.mouse.up();
    await page.waitForFunction(() => Math.abs(SpaceCamera.pose().world.y) > .08);
    await page.mouse.dblclick(430, 400, { delay: 70 });
    await page.waitForFunction(() => Math.abs(SpaceCamera.pose().world.x) + Math.abs(SpaceCamera.pose().world.y) < .015);
    const resetScene = await page.evaluate(() => phoenixPreview.stats().sceneStats.primary);
    assert.equal(resetScene.bursts, before.scene.bursts, 'double-click reset cannot trigger a ritual click');
    assert.equal(resetScene.timeline, before.scene.timeline, 'double-click reset preserves the paused performance');
    await page.locator('#restart').click();
    await page.waitForFunction(() => phoenixPreview.stats().sceneStats.primary.timeline < .1);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'preview controls fit a portrait viewport');
    await page.locator('#play').click();
    await page.waitForFunction(() => phoenixPreview.stats().sceneStats.primary.timeline > .3);
    assert.deepEqual(errors, [], 'preview camera wiring has no runtime or shader errors');
    return { drag: true, zoom: true, reset: true, doubleClick: true, pausedOrbit: true, noDragClick: true, portrait: true };
  } finally { await page.close(); }
}

async function renderContract(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setContent('<body style="margin:0;background:#020304"><canvas style="width:100vw;height:100vh"></canvas></body>');
  for (const name of ['stage-runtime', 'space-stage']) await page.addScriptTag({ path: path.join(web, 'vendor', name + '.js') });
  await page.evaluate(async () => {
    const canvas = document.querySelector('canvas'), original = canvas.getContext.bind(canvas);
    canvas.getContext = (type, ...args) => { const value = original(type, ...args); if (/webgl/.test(type)) window.gl = value; return value; };
    window.host = SpaceStagePure.create(canvas, { qualityMode: 'medium', deviceTier: 'high' });
    await host.select('phoenix-vortex'); host.resize(innerWidth, innerHeight);
    window.clock = 0; window.pointerSerial = 0;
    window.draw = (extra = {}) => {
      clock += 100;
      host.frame({ now: clock, sceneTime: clock / 1000, time: clock / 1000, dt: 0, dynamicDt: 0, playing: true,
        bands: { bass: 0, mid: 0, treble: 0 }, pointer: { active: false, click: { serial: pointerSerial, x: 0, y: 0 } }, ...extra });
      const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let hash = 2166136261, lit = 0;
      for (let i = 0; i < pixels.length; i += 16) {
        const value = pixels[i] + pixels[i + 1] + pixels[i + 2]; hash = Math.imul(hash ^ value, 16777619); if (value > 60) lit++;
      }
      return { hash: hash >>> 0, lit };
    };
    window.tick = (count, pointer) => {
      for (let i = 0; i < count; i++) {
        clock += 16;
        host.frame({ now: clock, sceneTime: clock / 1000, time: clock / 1000, dt: .016, dynamicDt: .016, playing: true,
          bands: { bass: .35, mid: .22, treble: .15 }, pointer });
      }
    };
  });
  const signals = await page.evaluate(() => {
    const quiet = draw(), loud = draw({ bands: { bass: .9, mid: .8, treble: .7 } });
    host.setParams({ reactivity: 0 }); const disabledQuiet = draw(), disabledLoud = draw({ bands: { bass: .9, mid: .8, treble: .7 } });
    host.setParams({ reactivity: .7 });
    const beforePointer = draw();
    const pointer = { active: true, x: .65, y: .2, click: { serial: 0, x: .65, y: .2 } };
    const hovered = draw({ pointer });
    host.setParams({ pointerStrength: 0 }); for (let i = 0; i < 30; i++) draw();
    const disabledPointer = draw(), disabledHover = draw({ pointer });
    host.setParams({ pointerStrength: 1 });
    return { quiet, loud, disabledQuiet, disabledLoud, beforePointer, hovered, disabledPointer, disabledHover };
  });
  assert.ok(signals.quiet.lit > 100, 'phoenix draws a visible silhouette');
  assert.notEqual(signals.quiet.hash, signals.loud.hash, 'audio changes actual wing pixels at a fixed animation time');
  assert.equal(signals.disabledQuiet.hash, signals.disabledLoud.hash, 'reactivity zero disables actual audio modulation');
  assert.notEqual(signals.beforePointer.hash, signals.hovered.hash, 'pointer changes actual rendered pixels');
  assert.equal(signals.disabledPointer.hash, signals.disabledHover.hash, 'pointer strength zero disables the field');
  const phases = {};
  for (const mode of ['flight', 'swarm', 'egg', 'rebirth']) {
    phases[mode] = await page.evaluate(async mode => {
      await host.select('phoenix-vortex', { params: { performance: mode } });
      for (let i = 0; i < 65; i++) host.frame({ now: clock += 100, time: clock / 1000, sceneTime: clock / 1000, dt: .1, dynamicDt: .1, playing: true, bands: { bass: .3, mid: .2, treble: .15 } });
      return { pixels: draw(), stats: host.stats() };
    }, mode);
    assert.ok(phases[mode].pixels.lit > 100, mode + ' remains visible');
    await page.screenshot({ path: path.join(output, mode + '.png') });
  }
  assert.equal(new Set(Object.values(phases).map(p => p.pixels.hash)).size, 4, 'four performance modes render distinct compositions');
  await page.evaluate(() => host.select('phoenix-vortex', { params: { performance: 'auto' } }));
  await page.evaluate(() => {
    for (let i = 0; i < 130; i++) host.frame({ now: clock += 100, time: clock / 1000, sceneTime: clock / 1000, dt: .1, dynamicDt: .1, playing: true, bands: { bass: .3, mid: .2, treble: .15 } });
  });
  const autoPixels = await page.evaluate(() => draw());
  assert.ok(autoPixels.lit > 100, 'auto performance stays visible mid-flight');
  await page.evaluate(() => host.select('phoenix-vortex', { params: { performance: 'swarm' } }));
  await page.evaluate(() => {
    for (let i = 0; i < 40; i++) host.frame({ now: clock += 100, time: clock / 1000, sceneTime: clock / 1000, dt: .1, dynamicDt: .1, playing: true, bands: { bass: .3, mid: .2, treble: .15 } });
  });
  const hand = await page.evaluate(() => {
    const idle = draw();
    tick(90, { active: true, down: true, dragging: false, x: .16, y: .1, click: { serial: 0, x: .16, y: .1 } });
    const held = { pixels: draw(), stats: host.stats().sceneStats.primary };
    for (let i = 0; i < 90; i++) {
      const angle = i * .16;
      tick(1, { active: true, down: false, dragging: true, x: Math.cos(angle) * .3, y: Math.sin(angle) * .3, click: { serial: 0, x: 0, y: 0 } });
    }
    const dragged = { pixels: draw(), stats: host.stats().sceneStats.primary };
    tick(1, { active: true, down: false, dragging: false, x: .2, y: .08, click: { serial: 1, x: .2, y: .08 } });
    tick(6, { active: true, down: false, dragging: false, x: .2, y: .08, click: { serial: 1, x: .2, y: .08 } });
    pointerSerial = 1;
    const clicked = { pixels: draw(), stats: host.stats().sceneStats.primary };
    return { idle, held, dragged, clicked };
  });
  assert.ok(hand.held.stats.charge > .8, 'holding the pointer charges the ritual');
  assert.ok(Math.abs(hand.dragged.stats.stir) > .3, 'dragging around the center stirs the flock');
  assert.equal(hand.clicked.stats.bursts, hand.dragged.stats.bursts + 1, 'clicking in the flock releases one shockwave');
  assert.notEqual(hand.held.pixels.hash, hand.idle.hash, 'charging changes actual ritual pixels');
  assert.notEqual(hand.clicked.pixels.hash, hand.dragged.pixels.hash, 'click feedback changes actual ritual pixels');
  await page.screenshot({ path: path.join(output, 'hand-swarm.png') });
  const reduced = await page.evaluate(() => {
    const first = draw({ reduced: true, dynamicDt: 0 });
    const second = draw({ reduced: true, dynamicDt: 0, time: 300, sceneTime: 300, bands: { bass: .9, mid: .7, treble: .8 }, pointer: { active: true, x: -.8, y: .9, click: { serial: 99, x: -.8, y: .9 } } });
    return { first, second };
  });
  assert.deepEqual(reduced.first, reduced.second, 'reduced motion freezes pixels despite clock, pointer and audio changes');
  const lowSwarm = await page.evaluate(() => { host.setQualityMode('low'); return { pixels: draw({ reduced: true }), stats: host.stats() }; });
  assert.ok(lowSwarm.pixels.lit > 800, 'low quality retains the burning flock, not just a sparse point field');
  assert.ok(lowSwarm.stats.drawCalls <= 40 && lowSwarm.stats.points <= 12000 && lowSwarm.stats.triangles <= 80000, 'low flock respects its resource budget');
  const changedWhileFrozen = await page.evaluate(() => {
    host.setParams({ performance: 'egg', pointSize: 1.7 });
    const pixels = draw({ reduced: true }); return { pixels, scene: host.stats().sceneStats.primary };
  });
  assert.equal(changedWhileFrozen.scene.flight, 0); assert.equal(changedWhileFrozen.scene.egg, 1);
  assert.notEqual(changedWhileFrozen.pixels.hash, lowSwarm.pixels.hash, 'explicit mode edits redraw the frozen scene');
  await page.setViewportSize({ width: 390, height: 844 });
  const portrait = await page.evaluate(() => { host.resize(innerWidth, innerHeight); return draw(); });
  assert.ok(portrait.lit > 50, 'portrait frames the scene');
  await page.screenshot({ path: path.join(output, 'portrait.png') });
  const disposed = await page.evaluate(() => { host.dispose(); return host.stats(); });
  assert.equal(disposed.resources, 0); assert.equal(disposed.tasks, 0);
  assert.deepEqual(errors, [], 'no shader or runtime errors');
  await page.close();
  return { signals, phases, reduced, portrait };
}

async function fireContract(browser) {
  const { buildSync } = require(path.join(root, 'tools/space-stage/node_modules/esbuild'));
  const bundled = buildSync({ stdin: { contents: `
    import * as THREE from 'three';
    import { createScope } from './src/scope.js';
    import { createPhoenixVortex } from './src/scenes/phoenix-vortex.js';
    window.fireModules = { THREE, createScope, createPhoenixVortex };
  `, resolveDir: path.join(root, 'tools/space-stage') }, bundle: true, format: 'iife', write: false });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  try {
    await page.setContent('<body style="margin:0"><canvas></canvas></body>');
    await page.addScriptTag({ content: bundled.outputFiles[0].text });
    const evidence = await page.evaluate(() => {
      const { THREE, createScope, createPhoenixVortex } = fireModules;
      const renderer = new THREE.WebGLRenderer({ canvas: document.querySelector('canvas') });
      renderer.setSize(1280, 720);
      const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(48, 1280 / 720, .05, 900), scope = createScope();
      camera.position.set(0, .6, 16.5); camera.lookAt(0, .6, 0);
      const instance = createPhoenixVortex({ THREE, scene, camera, renderer, scope,
        params: { performance: 'swarm', density: 1 }, quality: { mode: 'low', density: .4 }, services: {} });
      instance.resize(1280, 720);
      const flames = scene.getObjectByName('phoenix-flames'), embers = scene.getObjectByName('phoenix-embers');
      const uniforms = flames.material.uniforms, gl = renderer.getContext();
      const pixels = (drawScene = scene) => {
        renderer.render(drawScene, camera);
        const data = new Uint8Array(1280 * 720 * 4);
        gl.readPixels(0, 0, 1280, 720, gl.RGBA, gl.UNSIGNED_BYTE, data);
        return data;
      };
      const difference = (a, b) => { let changed = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 12) changed++; return changed; };
      const frame = { dt: .1, bands: { bass: 0, mid: 0, treble: 0 } };
      for (let i = 0; i < 65; i++) instance.update(frame);
      const burning = pixels(), counts = { ...renderer.info.render };
      uniforms.uFire.value = 0;
      const unlit = pixels();
      uniforms.uFire.value = 1; flames.visible = false;
      const noFlames = pixels();
      flames.visible = true; embers.visible = false;
      const noEmbers = pixels();
      embers.visible = true;
      const frozen = pixels();
      instance.update({ ...frame, reduced: true, time: 999 });
      const freezeDifference = difference(frozen, pixels());
      uniforms.uTime.value += .35;
      const motionDifference = difference(frozen, pixels());
      const flock = { firePixels: difference(burning, unlit), flamePixels: difference(burning, noFlames),
        emberPixels: difference(burning, noEmbers), freezeDifference, motionDifference };
      // The egg: converge, then verify shell and rebirth flash actually light pixels.
      instance.setParams({ performance: 'egg' });
      for (let i = 0; i < 120; i++) instance.update(frame);
      const eggUniforms = scene.getObjectByName('phoenix-egg').material.uniforms;
      const glowing = pixels();
      eggUniforms.uEgg.value = 0;
      const noEgg = pixels();
      eggUniforms.uEgg.value = 1;
      const dim = pixels();
      eggUniforms.uFlash.value = 1;
      const flashed = pixels();
      const egg = { eggPixels: difference(glowing, noEgg), flashPixels: difference(flashed, dim), counts };
      const nearEmbers = scene.getObjectByName('phoenix-near-embers');
      const depthScene = new THREE.Scene(), shell = scene.getObjectByName('phoenix-egg');
      const depthShell = new THREE.Mesh(shell.geometry, shell.material);
      depthShell.position.copy(shell.position); depthShell.quaternion.copy(shell.quaternion); depthShell.scale.copy(shell.scale);
      depthShell.renderOrder = shell.renderOrder; depthScene.add(depthShell);
      const sampleGeometry = nearEmbers.geometry.clone(); sampleGeometry.setDrawRange(0, 1);
      const depthEmber = new THREE.Points(sampleGeometry, nearEmbers.material);
      depthEmber.renderOrder = nearEmbers.renderOrder; depthEmber.frustumCulled = false; depthScene.add(depthEmber);
      const saved = Object.fromEntries(['uTime', 'uEgg', 'uFlash', 'uHatch'].map(name => [name, uniforms[name].value]));
      const depthTest = depthEmber.material.depthTest;
      let occlusion;
      try {
        for (const [name, value] of Object.entries({ uTime: 0, uEgg: 1, uFlash: 0, uHatch: 0 })) uniforms[name].value = value;
        depthEmber.visible = false; const shellOnly = pixels(depthScene); depthEmber.visible = true;
        const life = (.9 + 5.6) / 12, seeds = sampleGeometry.getAttribute('aEmber');
        const sample = angle => {
          seeds.setXYZW(0, life, (angle - life * .8) / (Math.PI * 2), 0, 1); seeds.needsUpdate = true;
          return difference(shellOnly, pixels(depthScene));
        };
        occlusion = { foreground: sample(Math.PI / 2), background: sample(-Math.PI / 2) };
        depthEmber.material.depthTest = false;
        occlusion.backgroundUnoccluded = sample(-Math.PI / 2);
      } finally {
        depthEmber.material.depthTest = depthTest;
        for (const [name, value] of Object.entries(saved)) uniforms[name].value = value;
        sampleGeometry.dispose();
      }
      // Measure the actual auto performance: both generations must coexist for
      // several seconds, and the hero must finish dissolving before gathering.
      instance.setParams({ performance: 'auto' });
      const morphHero = scene.getObjectByName('phoenix-hero'), flockMesh = scene.getObjectByName('phoenix-swarm');
      const transition = {};
      for (let i = 1; i <= 180; i++) {
        instance.update(frame);
        if (![60, 100, 120, 140, 180].includes(i)) continue;
        const combined = pixels();
        const heroOn = morphHero.visible;
        morphHero.visible = false;
        const noHero = pixels(); morphHero.visible = heroOn;
        const flockParts = [flockMesh, flames, embers], visible = flockParts.map(mesh => mesh.visible);
        flockParts.forEach(mesh => { mesh.visible = false; });
        const noFlock = pixels();
        flockParts.forEach((mesh, index) => { mesh.visible = visible[index]; });
        transition[i / 10] = { heroPixels: difference(combined, noHero), flockPixels: difference(combined, noFlock),
          position: morphHero.position.toArray(), heading: morphHero.quaternion.toArray() };
      }
      // Isolate the bird so background stars cannot make an edge-on billboard
      // pass the test. The same mesh must draw front, side and back silhouettes.
      const hero = scene.getObjectByName('phoenix-hero'), parent = hero.parent;
      const isolated = new THREE.Scene(); isolated.background = new THREE.Color(0x000000);
      isolated.add(hero); hero.visible = true; hero.position.set(0, .9, 0); hero.quaternion.identity(); hero.scale.setScalar(1);
      for (const [name, value] of Object.entries({ uHero: 1, uDissolve: 0, uTime: 0, uFlap: 0, uSweep: 0,
        uWingLift: 0, uFlash: 0, uPointerAmount: 0 })) uniforms[name].value = value;
      const orientation = {};
      for (const [view, angle] of [['front', 0], ['quarter', Math.PI / 4], ['side', Math.PI / 2], ['back', Math.PI], ['downstroke', Math.PI / 3]]) {
        if (view === 'downstroke') { uniforms.uFlap.value = .47; uniforms.uSweep.value = .15; uniforms.uTime.value = .7; }
        camera.position.set(Math.sin(angle) * 16.5, 1.2, Math.cos(angle) * 16.5); camera.lookAt(0, .9, 0);
        const data = pixels(isolated);
        let lit = 0, hash = 2166136261;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] + data[i + 1] + data[i + 2] > 60) lit++;
          hash = Math.imul(hash ^ data[i], 16777619);
        }
        orientation[view] = { lit, hash: hash >>> 0, image: renderer.domElement.toDataURL('image/png').split(',')[1] };
      }
      // Render a real wingbeat using the scene clock, with the camera and root
      // fixed. Shader motion must visibly lift BOTH wings without moving the head.
      instance.setParams({ performance: 'flight' });
      for (let i = 0; i < 60; i++) instance.update(frame);
      camera.position.set(0, .9, 16.5); camera.lookAt(0, .9, 0);
      const beats = [];
      for (let i = 0; i < 26; i++) {
        instance.update(frame);
        hero.position.set(0, .9, 0); hero.quaternion.identity(); hero.scale.setScalar(1);
        const data = pixels(isolated), sides = [{ count: 0, y: 0 }, { count: 0, y: 0 }], head = [];
        for (let y = 280; y < 720; y++) for (let x = 0; x < 1280; x++) {
          const at = (y * 1280 + x) * 4, lit = data[at] + data[at + 1] + data[at + 2] > 100;
          if (lit && y > 360 && (x < 560 || x > 720)) {
            const side = sides[x < 560 ? 0 : 1]; side.count++; side.y += y;
          }
          if (x >= 610 && x <= 681 && y >= 460 && y <= 580) head.push(lit);
        }
        beats.push({ left: sides[0].y / sides[0].count, right: sides[1].y / sides[1].count, head,
          image: renderer.domElement.toDataURL('image/png').split(',')[1] });
      }
      beats.sort((a, b) => a.left + a.right - b.left - b.right);
      const down = beats[0], up = beats[beats.length - 1];
      let headIntersection = 0, headUnion = 0;
      up.head.forEach((lit, i) => { if (lit && down.head[i]) headIntersection++; if (lit || down.head[i]) headUnion++; });
      const wingbeat = { leftTravel: up.left - down.left, rightTravel: up.right - down.right,
        headOverlap: headIntersection / headUnion, upImage: up.image, downImage: down.image };
      const skin = hero.getObjectByName('phoenix-reference-skin'), geometry = skin.geometry;
      const positions = geometry.getAttribute('position'), surfaces = geometry.getAttribute('aSurface'), tailIndices = [];
      for (let i = 0; i < geometry.index.count; i += 3) {
        const triangle = [0, 1, 2].map(j => geometry.index.getX(i + j));
        if (triangle.every(index => positions.getY(index) < -2.15)) tailIndices.push(...triangle);
      }
      const tailGeometry = geometry.clone(); tailGeometry.setIndex(tailIndices);
      const tailScene = new THREE.Scene(); tailScene.background = new THREE.Color(0x000000);
      const tailMesh = new THREE.Mesh(tailGeometry, skin.material); tailMesh.position.set(0, .9, 0); tailMesh.frustumCulled = false;
      tailScene.add(tailMesh);
      const range = values => Math.max(...values) - Math.min(...values);
      const thresholds = [60, 140], tailFrames = [], poses = [];
      let lastTail;
      for (let i = 0; i < 64; i++) {
        instance.update(frame);
        lastTail = pixels(tailScene);
        poses.push(Object.fromEntries(['uTime', 'uFlap', 'uSweep', 'uWingLift'].map(name => [name, uniforms[name].value])));
        tailFrames.push(thresholds.map(threshold => {
          const columns = new Uint32Array(1280);
          let count = 0, sumX = 0, edgePixels = 0;
          for (let y = 0; y < 720; y++) for (let x = 0; x < 1280; x++) {
            const at = (y * 1280 + x) * 4;
            if (lastTail[at] + lastTail[at + 1] + lastTail[at + 2] <= threshold) continue;
            columns[x]++; count++; sumX += x;
            if (x < 2 || x > 1277 || y < 2 || y > 717) edgePixels++;
          }
          let cumulative = 0, low = -1, high = -1;
          for (let x = 0; x < 1280; x++) {
            cumulative += columns[x];
            if (low < 0 && cumulative >= count * .05) low = x;
            if (high < 0 && cumulative >= count * .95) high = x;
          }
          return { count, centroid: sumX / count, boundsCenter: (low + high) / 2, edgePixels };
        }));
      }
      instance.update({ ...frame, reduced: true, time: 999 });
      const tail = { samples: poses.length, duration: poses[poses.length - 1].uTime - poses[0].uTime,
        freezeDifference: difference(lastTail, pixels(tailScene)), thresholds: thresholds.map((threshold, i) => ({ threshold,
          minLit: Math.min(...tailFrames.map(frame => frame[i].count)),
          edgePixels: Math.max(...tailFrames.map(frame => frame[i].edgePixels)),
          centroidTravel: range(tailFrames.map(frame => frame[i].centroid)),
          boundsTravel: range(tailFrames.map(frame => frame[i].boundsCenter)) })) };
      tailGeometry.dispose();
      const targets = [[-1.8, 1.55], [-3.3, 2.45], [-5, 3.8], [1.8, 1.55], [3.3, 2.45], [5, 3.8],
        [.1, .8], [.1, 3.1], [.1, 4], [-1.5, -3], [0, -4.3], [1.3, -4.3]];
      const landmarks = targets.map(([x, y]) => {
        let nearest = -1, distance = Infinity;
        for (let i = 0; i < positions.count; i++) {
          if (surfaces.getX(i) < .5) continue;
          const d = (positions.getX(i) - x) ** 2 + (positions.getY(i) - y) ** 2;
          if (d < distance) { distance = d; nearest = i; }
        }
        if (nearest < 0 || distance > .75 ** 2) throw new Error('Missing painted motion landmark: ' + [x, y]);
        return nearest;
      });
      const program = gl.createProgram(), shaders = [], buffers = [], vao = gl.createVertexArray(), feedback = gl.createTransformFeedback();
      const compile = (type, source) => {
        const shader = gl.createShader(type); shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
        gl.attachShader(program, shader);
      };
      let articulation;
      try {
        const renderedProgram = renderer.properties.get(skin.material).currentProgram;
        compile(gl.VERTEX_SHADER, gl.getShaderSource(renderedProgram.vertexShader));
        compile(gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(1.0);}');
        gl.transformFeedbackVaryings(program, ['vViewPosition'], gl.INTERLEAVED_ATTRIBS); gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
        gl.useProgram(program); gl.bindVertexArray(vao);
        for (const name of ['position', 'uv', 'aSurface']) {
          const location = gl.getAttribLocation(program, name);
          if (location < 0) continue;
          const attribute = geometry.getAttribute(name), buffer = gl.createBuffer(); buffers.push(buffer);
          const data = new Float32Array(landmarks.length * attribute.itemSize);
          landmarks.forEach((index, i) => {
            for (let j = 0; j < attribute.itemSize; j++) data[i * attribute.itemSize + j] = attribute.array[index * attribute.itemSize + j];
          });
          gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
          gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, attribute.itemSize, gl.FLOAT, false, 0, 0);
        }
        const identity = new THREE.Matrix4().elements;
        for (const name of ['modelViewMatrix', 'projectionMatrix']) gl.uniformMatrix4fv(gl.getUniformLocation(program, name), false, identity);
        gl.uniform1f(gl.getUniformLocation(program, 'uPointerAmount'), 0);
        gl.uniform3f(gl.getUniformLocation(program, 'uPointer'), 0, 0, 0);
        const buffer = gl.createBuffer(); buffers.push(buffer);
        gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, buffer);
        gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, landmarks.length * 3 * 4, gl.STREAM_READ);
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback); gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffer);
        gl.enable(gl.RASTERIZER_DISCARD);
        const samples = poses.map(pose => {
          for (const [name, value] of Object.entries(pose)) gl.uniform1f(gl.getUniformLocation(program, name), value);
          gl.beginTransformFeedback(gl.POINTS); gl.drawArrays(gl.POINTS, 0, landmarks.length); gl.endTransformFeedback();
          const data = new Float32Array(landmarks.length * 3); gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, data);
          if (!data.every(Number.isFinite)) throw new Error('Non-finite phoenix transform feedback');
          return landmarks.map((_, i) => new THREE.Vector3().fromArray(data, i * 3));
        });
        const angle = (sample, start) => sample[start + 1].clone().sub(sample[start]).angleTo(sample[start + 2].clone().sub(sample[start + 1]));
        articulation = {
          leftAngleTravel: range(samples.map(sample => angle(sample, 0))), rightAngleTravel: range(samples.map(sample => angle(sample, 3))),
          anchorTravel: Math.max(...samples.flatMap(sample => [6, 7, 8].map(i => sample[i].distanceTo(new THREE.Vector3().fromBufferAttribute(positions, landmarks[i]))))),
          tailTravel: [9, 10, 11].map(i => range(samples.map(sample => sample[i].x))),
          shoulderWristSpan: [0, 3].map(i => Math.min(...samples.map(sample => sample[i].distanceTo(sample[i + 1])))),
          wristTipSpan: [0, 3].map(i => Math.min(...samples.map(sample => sample[i + 1].distanceTo(sample[i + 2])))),
          glError: gl.getError() };
      } finally {
        gl.disable(gl.RASTERIZER_DISCARD); gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
        gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, null); gl.bindVertexArray(null); gl.useProgram(null);
        gl.deleteTransformFeedback(feedback); gl.deleteVertexArray(vao); buffers.forEach(buffer => gl.deleteBuffer(buffer));
        gl.deleteProgram(program); shaders.forEach(shader => gl.deleteShader(shader)); renderer.resetState();
      }
      parent.add(hero);
      instance.dispose(); scope.dispose(); renderer.dispose();
      return { flock, egg, occlusion, orientation, transition, wingbeat, tail, articulation };
    });
    assert.ok(evidence.occlusion.foreground > 10, 'foreground embers remain visible in front of the egg: ' + evidence.occlusion.foreground);
    assert.ok(evidence.occlusion.backgroundUnoccluded > 3, 'the background ember projects inside the visible shell');
    assert.equal(evidence.occlusion.background, 0, 'the egg occludes embers behind its shell');
    assert.ok(evidence.flock.firePixels > 500, 'burning changes actual fledgling pixels');
    assert.ok(evidence.flock.flamePixels > 100, 'the outer flame layer contributes visible pixels');
    assert.ok(evidence.flock.emberPixels > 20, 'attached ember trails contribute visible pixels: ' + evidence.flock.emberPixels);
    assert.equal(evidence.flock.freezeDifference, 0, 'burning freezes in reduced motion');
    assert.ok(evidence.flock.motionDifference > 100, 'fire and fledglings animate when the clock advances');
    assert.ok(evidence.egg.eggPixels > 300, 'the egg shell contributes visible pixels');
    assert.ok(evidence.egg.flashPixels > 300, 'the rebirth flash visibly brightens the egg');
    assert.ok(evidence.egg.counts.calls <= 40 && evidence.egg.counts.points <= 12000 && evidence.egg.counts.triangles <= 80000, 'burning respects low-quality GPU budgets');
    const morph = evidence.transition;
    assert.ok(morph[6].heroPixels > 10000 && morph[6].flockPixels === 0, 'the presentation starts with one complete large phoenix');
    for (const time of [10, 12]) assert.ok(morph[time].heroPixels > 500 && morph[time].flockPixels > 100,
      `the hero and feather-born fledglings both visibly contribute at ${time}s`);
    assert.ok(morph[14].heroPixels < morph[10].heroPixels * .5, 'the large phoenix progressively dissolves');
    assert.ok(morph[18].heroPixels === 0 && morph[18].flockPixels > 1000, 'the release ends with only the small phoenixes');
    for (const pose of Object.values(morph)) {
      assert.deepEqual(pose.heading, morph[6].heading, 'dissolving cannot turn the phoenix edge-on');
      assert.equal(pose.position[0], morph[6].position[0]);
      assert.equal(pose.position[2], morph[6].position[2]);
    }
    const views = evidence.orientation;
    assert.ok(views.front.lit > 10000 && views.side.lit > views.front.lit * .05, 'the side view retains a visible body volume');
    assert.ok(views.side.lit < views.front.lit * .75, 'turning sideways visibly changes the silhouette instead of facing the camera');
    assert.ok(views.back.lit > views.front.lit * .5 && views.back.hash !== views.front.hash, 'the back has its own visible shading');
    assert.ok(views.quarter.lit > views.front.lit * .4 && views.downstroke.lit > views.front.lit * .25,
      'banked and downstroke poses retain a readable phoenix silhouette');
    for (const [name, view] of Object.entries(views)) {
      fs.writeFileSync(path.join(output, `body-${name}.png`), Buffer.from(view.image, 'base64'));
      delete view.image;
    }
    const beat = evidence.wingbeat;
    assert.ok(beat.leftTravel > 50 && beat.rightTravel > 50, 'both wings visibly rise and fall by at least 50 pixels: ' + JSON.stringify({ left: beat.leftTravel, right: beat.rightTravel }));
    assert.ok(beat.headOverlap > .93, 'the crown and neck keep their shape throughout the wingbeat: ' + beat.headOverlap);
    for (const pose of ['up', 'down']) {
      fs.writeFileSync(path.join(output, `wingbeat-${pose}.png`), Buffer.from(beat[pose + 'Image'], 'base64'));
      delete beat[pose + 'Image'];
    }
    const tail = evidence.tail, joints = evidence.articulation;
    assert.ok(tail.duration > 6, 'tail sampling covers full wingbeats and the slower trailing motion');
    assert.equal(tail.freezeDifference, 0, 'the actual isolated tail freezes in reduced motion');
    for (const sample of tail.thresholds) {
      assert.ok(sample.minLit > 2000 && sample.edgePixels === 0, 'the isolated painted tail stays visible and unclipped: ' + JSON.stringify(sample));
      assert.ok(sample.centroidTravel > 18 && sample.boundsTravel > 18,
        'the painted tail visibly sways beyond the old near-static motion at both brightness thresholds: ' + JSON.stringify(sample));
    }
    assert.equal(joints.glError, 0, 'actual hero vertex shader transform feedback has no WebGL errors');
    assert.ok(joints.shoulderWristSpan.every(span => span > .5) && joints.wristTipSpan.every(span => span > .5), 'wing landmarks do not collapse');
    assert.ok(joints.leftAngleTravel > .18 && joints.rightAngleTravel > .18,
      'both shoulder-wrist-tip angles flex by at least .18 radians, not just a rigid wing rotation: ' + JSON.stringify(joints));
    assert.ok(joints.anchorTravel < .00001, 'the breast, neck and crown remain fixed in the actual vertex shader: ' + joints.anchorTravel);
    assert.ok(joints.tailTravel.every(travel => travel > .45), 'tail sway moves actual vertices, not just flame shading: ' + JSON.stringify(joints.tailTravel));
    assert.deepEqual(errors, [], 'fire and egg layers compile and render without WebGL errors');
    return evidence;
  } finally { await page.close(); }
}

async function appContract(browser) {
  const fixture = await startFixture();
  let context;
  try {
    await fixture.seed();
    await fixture.api('/v1/settings', 'PUT', { reduce_motion: false, space3d: { sceneSource: 'coast', qualityMode: 'low', lyrics: false, cinema: false, playerAutoHide: false } });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true });
    await fixture.connect(context);
    const token = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'vmusicd.json'), 'utf8')).token;
    const assets = new Map(readAssets().map(a => [a.path, a]));
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== fixture.base) return route.continue();
      if (url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(web, 'index.html'), 'utf8').replace('__VMUSIC_TOKEN_VALUE__', token) });
      const asset = assets.get(url.pathname);
      if (asset) return route.fulfill({ status: 200, contentType: asset.mime === 'JS' ? 'application/javascript' : 'text/css', body: fs.readFileSync(asset.file) });
      if (/^\/space-scene-preview\/[a-z0-9-]+\.jpg$/.test(url.pathname)) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: fs.readFileSync(path.join(web, url.pathname)) });
      return route.continue();
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && /THREE|shader|WebGL/i.test(m.text())) errors.push(m.text()); });
    await page.goto(fixture.base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.Space3D && document.getElementById('space3d').dataset.spReady === '1');
    await page.locator('#space3d-entry').click();
    await page.waitForFunction(() => Space3D.stats().renderer?.state === 'ready');
    await page.evaluate(() => {
      const original = Stage.presentation;
      Stage.presentation = () => ({ ...original(), playing: true, reduced: false }); Stage.kick();
    });
    await page.locator('#sp-page-toggle').click();
    await page.locator('#sp-console-toggle').click();
    await page.locator('#sp-source').selectOption('phoenix-vortex');
    await page.waitForFunction(() => Space3D.stats().renderer?.id === 'phoenix-vortex' && Space3D.stats().renderer.state === 'ready');
    await page.locator('#sp-param-performance').selectOption('egg');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => {
      const primary = Space3D.stats().renderer.sceneStats.primary;
      return primary.egg > .7 && primary.flight < .05;
    }, null, { timeout: 30000 });
    await page.screenshot({ path: path.join(output, 'app-egg.png') });
    const before = await page.evaluate(() => Space3D.stats().renderer.sceneStats.primary.flash);
    await page.mouse.click(610, 380);
    await page.waitForFunction(previous => Space3D.stats().renderer.sceneStats.primary.flash > previous + .1, before, { timeout: 10000 });
    // The host coalesces clicks closer than 250ms; three deliberate strikes must
    // still crack the shell through.
    await page.waitForTimeout(340);
    await page.mouse.click(610, 380);
    await page.waitForTimeout(340);
    await page.mouse.click(610, 380);
    await page.waitForFunction(() => {
      const primary = Space3D.stats().renderer.sceneStats.primary;
      return primary.hatch > .35 || primary.strikes >= 3;
    }, null, { timeout: 10000 });
    await page.screenshot({ path: path.join(output, 'app-hatch.png') });
    const camera = await page.evaluate(() => Space3D.stats().camera.world);
    await page.mouse.move(630, 450); await page.mouse.down(); await page.mouse.move(780, 490, { steps: 10 }); await page.mouse.up();
    assert.notDeepEqual(await page.evaluate(() => Space3D.stats().camera.world), camera, 'real drag controls the existing camera');
    await page.mouse.dblclick(630, 450, { delay: 60 });
    await page.locator('#sp-console-toggle').click();
    await page.locator('#sp-param-performance').selectOption('rebirth');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => Space3D.stats().renderer.sceneStats.primary.flight > .7, null, { timeout: 30000 });
    await page.locator('#sp-console-toggle').click(); await page.locator('#sp-param-reduced').check(); await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
    const frozen = await page.evaluate(() => Space3D.stats().renderer.sceneStats.primary.elapsed);
    await page.touchscreen.tap(550, 350); await page.waitForTimeout(450);
    assert.equal(await page.evaluate(() => Space3D.stats().renderer.sceneStats.primary.elapsed), frozen, 'real touch respects reduced motion');
    await page.locator('#sp-console-toggle').click();
    await page.locator('#sp-param-performance').selectOption('flight');
    await page.waitForFunction(() => Space3D.stats().renderer.sceneStats.primary.flight === 1 && Space3D.stats().renderer.sceneStats.primary.egg === 0);
    assert.equal(await page.evaluate(() => Space3D.stats().renderer.sceneStats.primary.elapsed), frozen, 'editing a reduced scene does not advance the clock');
    await page.locator('#sp-param-reduced').uncheck(); await page.keyboard.press('Escape');
    await page.waitForFunction(previous => Space3D.stats().renderer.sceneStats.primary.elapsed > previous, frozen);
    await page.locator('#sp-page-toggle').click();
    assert.equal(await page.locator('#sp-canvas canvas').count(), 1, 'returning home keeps one shared renderer');
    await page.locator('#sp-page-toggle').click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'app-portrait.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no portrait overflow');
    await page.evaluate(() => Space3D.close());
    assert.equal(await page.locator('#sp-canvas canvas').count(), 0, 'exiting disposes the canvas');
    assert.deepEqual(errors, [], 'no full-app runtime or shader errors');
    return { fullApp: true, mouse: true, touchReduced: true, camera: true, modeControls: true, portrait: true };
  } finally { if (context) await context.close(); await fixture.close(); }
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
  try {
    if (process.argv.includes('--shape-only')) {
      console.log('Phoenix body, flame and egg checks passed:', JSON.stringify(await fireContract(browser)));
      return;
    }
    const preview = await previewContract(browser);
    if (process.argv.includes('--preview-only')) {
      console.log('Phoenix preview checks passed:', JSON.stringify(preview));
      return;
    }
    const rendered = await renderContract(browser);
    const fire = await fireContract(browser);
    const app = await appContract(browser);
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ renderer: 'software WebGL2', hardwareFps: 'unmeasured', preview, rendered, fire, app }, null, 2));
    console.log('Phoenix browser checks passed: four compositions, attached flame/ember/egg/flash pixels, low-quality flock budget, actual audio/pointer pixels, disabled controls, frozen pixels, real app mouse/touch/camera, portrait and cleanup. Hardware FPS unmeasured.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
