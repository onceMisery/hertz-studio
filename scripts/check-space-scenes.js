#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const base = path.resolve(__dirname, '..'), stage = path.join(base, 'tools/space-stage');
const read = relative => fs.readFileSync(path.join(base, relative), 'utf8');
const load = relative => import(pathToFileURL(path.join(stage, relative)).href);

async function reactorArtworkContract(THREE, registry, createScope, PROFILES) {
  const documentBefore = global.document, imageBefore = global.Image, requested = [], delayed = [];
  const pixels = color => new Uint8ClampedArray(Array.from({ length: 24 * 24 }, () => [...color, 255]).flat());
  global.document = { createElement: () => ({ getContext: () => {
    let image; return { drawImage(img) { image = img; }, getImageData() { return { data: pixels(image.src.includes('red') ? [220, 30, 40] : [20, 70, 230]) }; } };
  } }) };
  global.Image = class {
    set src(value) { this.url = value; requested.push(value); queueMicrotask(() => { if (value.includes('pending')) delayed.push(this); else if (value.includes('missing')) this.onerror?.(); else this.onload?.(); }); }
    get src() { return this.url; }
  };
  const scope = createScope(), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const instance = registry.get('reactor').create({ THREE, scene, camera, scope, signal: scope.signal, params: registry.normalizeState('reactor').params, quality: PROFILES.low, services: {} });
  let now = 0;
  const step = (id, cover) => instance.update({ now: now += 100, sceneTime: 1, playing: false, track: { id, cover } });
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  try {
    step('art-failure', 'cover:missing'); await settle();
    step('art-failure', 'cover:red'); await settle(); step('art-failure', 'cover:red');
    assert.ok(requested.includes('cover:red'), 'a corrected artwork URL is sampled after an earlier failure');
    assert.ok(instance.stats().primary.recipe.hue < 10 || instance.stats().primary.recipe.hue > 350, 'corrected red artwork replaces the fallback hue');
    step('art-race', 'cover:pending-red'); await settle();
    step('art-race', 'cover:blue'); await settle();
    delayed.forEach(image => image.onload?.()); await settle(); step('art-race', 'cover:blue');
    assert.ok(Math.abs(instance.stats().primary.recipe.hue - 226) < 12, 'late old artwork cannot replace the latest blue URL');
  } finally { instance.dispose(); scope.trackTree(scene); scope.dispose(); global.document = documentBefore; global.Image = imageBefore; }
}

async function reactorPrefetchContract(THREE, registry, createScope, PROFILES) {
  const documentBefore = global.document, imageBefore = global.Image, requested = [];
  global.document = { createElement: () => ({ getContext: () => ({
    drawImage() {}, getImageData() { return { data: new Uint8ClampedArray(24 * 24 * 4).fill(120) }; }
  }) }) };
  global.Image = class {
    set src(value) { this.url = value; requested.push(value); queueMicrotask(() => this.onload?.()); }
    get src() { return this.url; }
  };
  const queue = Array.from({ length: 24 }, (_, i) => ({ id: 'prefetch-' + i, cover: 'cover:' + i }));
  const scope = createScope(), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const instance = registry.get('reactor').create({ THREE, scene, camera, scope, signal: scope.signal,
    params: registry.normalizeState('reactor').params, quality: PROFILES.low, services: { queue: () => queue } });
  let now = 0;
  const step = async (extra = {}) => {
    instance.update({ now: now += 100, sceneTime: 1, playing: false, track: { id: queue[0].id, cover: queue[0].cover }, ...extra });
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  try {
    await step();
    assert.ok(requested.length <= 4, 'first frame samples only the active and next covers: ' + requested.length);
    assert.ok(requested.includes(queue[0].cover), 'current cover is sampled');
    assert.ok(requested.includes(queue[1].cover), 'next cover is sampled ahead of time');
    assert.ok(!requested.includes(queue[12].cover), 'distant queue covers keep their hash hue');
    await step({ preview: { id: queue[12].id, cover: queue[12].cover } });
    assert.ok(requested.includes(queue[12].cover), 'preview cover is sampled on demand');
    assert.ok(!requested.includes(queue[13].cover), 'preview does not fan out to its neighbours');
  } finally { instance.dispose(); scope.trackTree(scene); scope.dispose(); global.document = documentBefore; global.Image = imageBefore; }
}

async function reactorContract(THREE, registry, createScope, PROFILES) {
  const { recipeFor, dominantHue, SHELLS, SHOTS } = await load('src/scenes/reactor.js');
  const a = recipeFor('online:netease:42'), b = recipeFor('online:netease:42');
  assert.deepEqual(a, b, 'same track always binds the same recipe');
  assert.ok(a.hue >= 0 && a.hue < 1 && a.shell < SHELLS.length && a.shot < SHOTS.length, 'recipe stays inside the catalog');
  const withCover = recipeFor('online:netease:42', .5);
  assert.equal(withCover.hue, .5, 'cover hue overrides the hash hue');
  assert.equal(withCover.shell, a.shell, 'cover hue never reshuffles shell'); assert.equal(withCover.shot, a.shot, 'cover hue never reshuffles shot');
  const kinds = new Set(Array.from({ length: 64 }, (_, i) => recipeFor('track-' + i).shell + ':' + recipeFor('track-' + i).shot));
  assert.ok(kinds.size >= 10, 'hash spreads tracks across shell/shot combinations');
  const pixels = (fn) => { const data = new Uint8ClampedArray(24 * 24 * 4); for (let i = 0; i < 24 * 24; i++) data.set([...fn(i), 255], i * 4); return data; };
  const blue = dominantHue(pixels(i => i % 3 ? [128, 128, 128] : [30, 70, 230]));
  assert.ok(Math.abs(blue - 228 / 360) < .03, 'saturated blue wins over the grey background: ' + blue);
  assert.equal(dominantHue(pixels(() => [140, 140, 140])), null, 'grey artwork defers to the id hash');
  const red = dominantHue(pixels(() => [220, 30, 40]));
  assert.ok(Math.min(red, 1 - red) < .02, 'hue wraps around red: ' + red);

  const scope = createScope(), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(48, 16 / 9, .05, 900);
  const [first, second, third] = ['t1', 't4', 't6'], ra = recipeFor(first), rb = recipeFor(second);
  assert.ok(ra.shell !== rb.shell && ra.shot !== rb.shot && recipeFor(third).shell !== rb.shell, 'fixture tracks exercise both shell and shot changes');
  const queue = [first, second, third].map(id => ({ id, title: id }));
  const reports = [], previews = [], plays = [];
  const services = { queue: () => queue, onRecipe: info => reports.push(info), previewTrack: id => previews.push(id), playTrack: id => plays.push(id) };
  const params = registry.normalizeState('reactor').params;
  const instance = registry.get('reactor').create({ THREE, scene, camera, scope, signal: scope.signal, params, quality: PROFILES.medium, services });
  instance.resize(1280, 720);
  instance.setRig({ yaw: 0, pitch: .06, dist: 15, fov: 48, tx: 0, ty: 0, tz: 0, roll: 0 });
  let now = 0;
  const step = (extra = {}, frames = 1) => { for (let i = 0; i < frames; i++) { now += 16; instance.update({ now, time: now / 1000, sceneTime: now / 1000, dt: .016, playing: true, track: { id: first }, ...extra }); } };
  step();
  const stats = () => instance.stats().primary;
  assert.equal(stats().recipe.id, first); assert.equal(stats().nodes, 3, 'every queue entry becomes a satellite node');
  step({}, 120); assert.equal(stats().morph, 1, 'shell morph settles');
  step({}, 480);
  const settled = camera.position.clone();
  step({ preview: { id: second } });
  assert.equal(stats().recipe.id, second, 'hovering the queue previews that track recipe');
  assert.equal(reports.at(-1).preview, true, 'host learns the preview recipe');
  step({ preview: { id: second } }, 20); const half = stats().morph; assert.ok(half > 0 && half < 1, 'preview morph is gradual');
  let shellUniforms; scene.traverse(o => { if (o.material?.uniforms?.uMorph) shellUniforms = o.material.uniforms; });
  const weights = () => {
    if (shellUniforms.uShellWeights) return Array.from(shellUniforms.uShellWeights.value);
    const t = Math.min(1, shellUniforms.uMorph.value * 1.35), mix = t * t * (3 - 2 * t), values = [0, 0, 0, 0];
    values[shellUniforms.uFrom.value] += 1 - mix; values[shellUniforms.uTo.value] += mix; return values;
  };
  const blended = weights();
  step({ preview: { id: third } });
  const retargeted = weights();
  assert.ok(retargeted.every((v, i) => Math.abs(v - blended[i]) < .002), 'A to B to C preserves the in-flight shell blend');
  step({}, 1);
  const reversed = weights();
  assert.ok(reversed.every((v, i) => Math.abs(v - retargeted[i]) < .002), 'leaving an unfinished preview preserves its visual shape');
  step({}, 400);
  const beforePreview = camera.position.clone();
  step({ preview: { id: second } }, 6);
  assert.ok(camera.position.distanceTo(beforePreview) < .01, 'camera preset waits for the color/shell beat');
  step({ preview: { id: second } }, 24);
  assert.ok(camera.position.distanceTo(beforePreview) > .05, 'camera preset follows after the beat');
  step({ preview: { id: second } }, 300);
  assert.ok(camera.position.distanceTo(settled) > .5, 'preview moves to that track camera preset');
  step({}, 400);
  assert.ok(camera.position.distanceTo(settled) < .01, 'camera preset returns after preview');
  const satellites = []; scene.traverse(o => { if (o.isPoints && o.geometry.attributes.aSize) satellites.push(o); });
  const aim = new THREE.Vector3().fromArray(satellites[0].geometry.attributes.position.array, 3).applyMatrix4(satellites[0].matrixWorld).project(camera);
  step({ pointer: { active: true, x: aim.x, y: aim.y } });
  assert.equal(previews.at(-1), second, 'hovering a satellite node previews its track');
  const currentWorld = new THREE.Vector3().fromArray(satellites[0].geometry.attributes.position.array, 0).applyMatrix4(satellites[0].matrixWorld);
  const currentView = currentWorld.clone().applyMatrix4(camera.matrixWorldInverse);
  const currentAim = currentWorld.clone().project(camera);
  const currentRadius = Math.min(96, satellites[0].geometry.attributes.aSize.array[0] * 720
    * camera.projectionMatrix.elements[5] * .5 / -currentView.z) / 2;
  assert.ok(currentRadius > 20, 'current node draws wider than the old 18px hit radius: ' + currentRadius);
  const edge = { x: currentAim.x + currentRadius * .9 / (1280 / 2), y: currentAim.y };
  step({ pointer: { active: true, x: edge.x, y: edge.y } });
  assert.equal(previews.at(-1), first, 'hovering the visual edge of the current node still picks it');
  step({ pointer: { active: true, x: aim.x, y: aim.y, click: { x: aim.x, y: aim.y, serial: 1 } } });
  assert.deepEqual(plays, [second], 'clicking a satellite node plays its track');
  let cloudUniforms = null; scene.traverse(o => { if (o.material?.uniforms?.uMorph) cloudUniforms = o.material.uniforms; });
  assert.ok(cloudUniforms.uBurst.value > .5, 'click releases a particle burst');
  queue.splice(1, 2, { id: third }, { id: second });
  const rendered = new THREE.Vector3().fromArray(satellites[0].geometry.attributes.position.array, 3).applyMatrix4(satellites[0].matrixWorld).project(camera);
  step({ pointer: { click: { x: rendered.x, y: rendered.y, serial: 2 } } });
  assert.deepEqual(plays, [second, second], 'queue reorder cannot relabel the node that was displayed at click time');
  step({ reduced: true });
  const quietNode = new THREE.Vector3().fromArray(satellites[0].geometry.attributes.position.array, 6).applyMatrix4(satellites[0].matrixWorld).project(camera);
  step({ reduced: true, pointer: { click: { x: quietNode.x, y: quietNode.y, serial: 3 } } });
  assert.deepEqual(plays, [second, second, second], 'reduced motion preserves node playback actions');
  step({ pointer: { active: true, x: .95, y: -.9, down: true } }, 60);
  assert.ok(cloudUniforms.uEnergy.value > .95, 'holding charges the field');
  step({ track: { id: third } }); assert.equal(stats().recipe.id, third, 'track change re-targets the recipe');
  step({ track: { id: third }, reduced: true }); assert.equal(stats().morph, 1, 'reduced motion lands on the target recipe');
  instance.setParams({ ...params, trackRecipes: false }); step({ track: { id: third } });
  assert.equal(stats().recipe.id, '', 'turning recipes off returns to the neutral reactor');
  instance.setParams(params);
  step({ track: { id: first }, reduced: true });
  const fixedAccent = cloudUniforms.uColorC.value.getHexString(), firstPrimary = cloudUniforms.uColorA.value.getHexString();
  assert.ok(cloudUniforms.uColorB?.value && cloudUniforms.uColorD?.value, 'reactor exposes both supporting color channels');
  const hueOf = color => { const hsl = {}; color.getHSL(hsl); return hsl.h; };
  const hueGap = (a, b) => { const gap = Math.abs(a - b); return Math.min(gap, 1 - gap); };
  const firstHues = ['uColorA', 'uColorB', 'uColorD'].map(key => hueOf(cloudUniforms[key].value));
  assert.ok(hueGap(firstHues[0], firstHues[1]) > .15, 'secondary hue separates from the primary: ' + firstHues.join(','));
  assert.ok(hueGap(firstHues[0], firstHues[2]) > .15, 'tertiary hue separates from the primary: ' + firstHues.join(','));
  assert.ok(hueGap(firstHues[1], firstHues[2]) > .15, 'supporting hues separate from each other: ' + firstHues.join(','));
  const firstSecondary = cloudUniforms.uColorB.value.getHexString(), firstTertiary = cloudUniforms.uColorD.value.getHexString();
  step({ track: { id: third }, reduced: true });
  assert.notEqual(cloudUniforms.uColorA.value.getHexString(), firstPrimary, 'primary hue follows the track');
  assert.notEqual(cloudUniforms.uColorB.value.getHexString(), firstSecondary, 'secondary hue follows the track');
  assert.notEqual(cloudUniforms.uColorD.value.getHexString(), firstTertiary, 'tertiary hue follows the track');
  assert.equal(cloudUniforms.uColorC.value.getHexString(), fixedAccent, 'accent hue stays fixed across tracks');
  step({ playing: false, sceneTime: 1 }, 500);
  const fixedAim = new THREE.Vector3().fromArray(satellites[0].geometry.attributes.position.array, 3).applyMatrix4(satellites[0].matrixWorld).project(camera);
  let hovered = null; const hoverChanges = [];
  services.previewTrack = id => { hovered = id; hoverChanges.push(id); };
  for (let i = 0; i < 600; i++) step({ playing: false, sceneTime: 1, preview: hovered ? { id: hovered } : null, pointer: { active: true, x: fixedAim.x, y: fixedAim.y } });
  assert.ok(hoverChanges.length <= 2 && hovered, 'stationary node preview does not oscillate as its camera preset moves: ' + hoverChanges.length);
  const freePose = { position: [2, 3, 14], yaw: .3, pitch: .1, roll: .02, fov: 55 };
  instance.setRig(freePose); step({ preview: { id: second } }, 80);
  assert.deepEqual(camera.position.toArray(), freePose.position, 'recipe previews cannot move a free camera');
  assert.equal(camera.fov, freePose.fov, 'recipe previews cannot change the free camera FOV');
  instance.dispose(); scope.trackTree(scene); scope.dispose();
  assert.equal(scene.children.length, 0, 'reactor cleanup'); assert.equal(plays.length, 3, 'only node clicks switched tracks');
}

(async () => {
  const THREE = await load('node_modules/three/build/three.module.js');
  const { createRegistry } = await load('src/registry.js'), { createScope } = await load('src/scope.js');
  const { registerScenes } = await load('src/scenes/index.js'), { registerEffects, createPostChain } = await load('src/effects/index.js');
  const { createSpatialResources } = await load('src/scenes/resources.js'), { PROFILES } = await load('src/quality.js');
  const registry = createRegistry(), effects = createRegistry(); registerScenes(registry); registerEffects(effects);
  const { createParticlePointer } = await load('src/scenes/particle-pointer.js');
  const pointerCamera = new THREE.PerspectiveCamera(54, 1.6, .05, 100);
  pointerCamera.position.set(3, 2, 10); pointerCamera.lookAt(0, 0, 0); pointerCamera.updateMatrixWorld();
  const parent = new THREE.Group(), sheet = new THREE.Group(); parent.add(sheet);
  parent.rotation.set(.14, -.25, .1); parent.scale.setScalar(1.3); sheet.scale.setScalar(.7);
  parent.updateMatrixWorld(true);
  const localHit = new THREE.Vector3(.8, -.4, 0), ndc = sheet.localToWorld(localHit.clone()).project(pointerCamera);
  const pointer = createParticlePointer({ THREE, camera: pointerCamera }, sheet, { surface: true });
  for (let i = 0; i < 60; i++) pointer.update({ now: i * 16, pointer: { active: true, x: ndc.x, y: ndc.y } });
  assert.ok(pointer.uniforms.uPointer.value.distanceTo(localHit) < .0001, 'pointer follows actual rotated/scaled camera/object transforms');
  assert.equal(pointer.uniforms.uPointerAmount.value, 1, 'hover reaches configured indentation');
  for (let i = 60; i < 120; i++) pointer.update({ now: i * 16, pointer: { active: false } });
  assert.equal(pointer.uniforms.uPointerAmount.value, 0, 'leaving settles exactly with no extra clock');
  pointer.update({ now: 2000, reduced: true, pointer: { active: true, x: ndc.x, y: ndc.y } });
  assert.equal(pointer.uniforms.uPointerAmount.value, 0, 'reduced motion suppresses indentation');
  const manifest = JSON.parse(read('tools/space-stage/migration.json'));
  const checkInventory = (source, ids) => ids.forEach(oldId => assert.ok(manifest.entries.some(e => e.source === source && e.oldId === oldId), source + ':' + oldId + ' migration missing'));
  const stageSource = read('plugin/ui/stage3d.js');
  checkInventory('Stage3D.STAGES', [...stageSource.slice(stageSource.indexOf('var STAGES ='), stageSource.indexOf('// 着色器公共段')).matchAll(/id: '([^']+)'/g)].map(m => m[1]));
  checkInventory('CreativeGL', [...read('plugin/ui/creative-gl.js').matchAll(/^    id: '([^']+)'/gm)].map(m => m[1]));
  checkInventory('HandDrawn', [...read('plugin/ui/handdrawn.js').matchAll(/\{ id: '([^']+)', label:/g)].map(m => m[1]));
  checkInventory('SpacePost', [...read('plugin/ui/space-post.js').matchAll(/\{ key: '([^']+)', label:/g)].map(m => m[1]));
  checkInventory('SpaceLayers.stagePreset', ['venue', 'diorama', 'tempo', 'still']);
  checkInventory('Backgrounds', ['theme', 'mesh', 'flow', 'spectrogram', 'cover', 'media']);
  checkInventory('Stage3D.lyric', ['stage', 'classic', 'cadenza', 'sonnet', 'tempera', 'starborn']);
  const tempera = read('plugin/ui/stanza/stanza-tempera.js');
  checkInventory('Tempera.composition', [...tempera.slice(tempera.indexOf('var COMPOSITIONS ='), tempera.indexOf('var COMPOSITION_KINDS')).matchAll(/'([^']+)': function/g)].map(m => m[1]));
  checkInventory('Tempera.colorMode', ['duo', 'mono', 'vivid']);
  const sonnetFx = read('plugin/ui/stanza/stanza-sonnet-fx.js');
  for (const [source, variable] of [['Sonnet.shot', 'SHOT_KINDS'], ['Sonnet.scene', 'SCENE_KINDS']]) {
    const list = sonnetFx.match(new RegExp('var ' + variable + ' = \\[([\\s\\S]*?)\\]'))[1];
    checkInventory(source, [...list.matchAll(/'([^']+)'/g)].map(m => m[1]));
  }
  for (const entry of manifest.entries) {
    if (entry.state === 'removed') {
      assert.equal(registry.resolve(entry.plugin), undefined, 'Removed preset ' + entry.plugin);
      assert.equal(registry.resolve('immersive/' + entry.oldId), undefined, 'Removed legacy preset ' + entry.oldId);
      continue;
    }
    if (entry.plugin && !['coast', 'zodiac'].includes(entry.plugin)) {
      assert.ok(registry.resolve(entry.plugin), 'Missing new plugin ' + entry.plugin);
      if (entry.params) registry.validateParams(entry.plugin, entry.params);
    }
    if (entry.effect) assert.ok(effects.resolve(entry.effect), 'Missing effect ' + entry.effect);
    if (entry.state === 'excluded') assert.equal(registry.resolve(entry.oldId), undefined);
  }
  let uploads = 0;
  global.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ clearRect() {}, measureText: text => ({ width: text.length * 32 }), fillText() { uploads++; }, drawImage() {} }) }) };
  const shared = createSpatialResources(THREE);
  const pending = ['one', 'two', 'three'].map(s => shared.text.acquire(s));
  shared.beginFrame(1); shared.beginFrame(1); assert.equal(uploads, 1, 'at most one text upload per frame');
  shared.beginFrame(2); assert.equal(uploads, 2);
  pending.forEach(e => shared.text.release(e)); assert.equal(shared.stats().queued, 0, 'released work removed immediately');
  for (let i = 0; i < 100; i++) { const entry = shared.text.acquire('rapid ' + i); shared.text.release(entry); }
  assert.equal(shared.stats().queued, 0, 'switching without frames cannot grow task queue'); shared.dispose();
  let created = 0;
  for (const definition of registry.catalog()) {
    for (const mode of ['high', 'medium', 'low']) {
      const scope = createScope(), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(58, 16 / 9, .05, 900), resources = createSpatialResources(THREE);
      const params = registry.normalizeState(definition.id).params;
      const ctx = { THREE, scene, camera, scope, signal: scope.signal, params, quality: PROFILES[mode], services: { spatialResources: resources } };
      const instance = registry.get(definition.id).create(ctx); created++;
      const frame = { now: 1000, time: 1, dt: .016, playing: true, bands: { bass: .7, mid: .4, treble: .2 }, onset: 1,
        spectrum: new Float32Array(64).fill(.5), lyrics: { index: 1, progress: .4, lines: [{ text: 'Before', start: 0, end: 1 }, { text: 'Current spatial words', start: 1, end: 2, tokens: [{ text: 'Current', start: 1, end: 1.5 }, { text: 'words', start: 1.5, end: 2 }] }, { text: 'After', start: 2, end: 3 }] } };
      instance.update(frame); instance.update({ ...frame, now: 1016, time: 1.016 }); instance.resize(360, 740);
      let points = 0, triangles = 0, calls = 0, depth = false; const geometries = new Set();
      scene.updateMatrixWorld(true);
      scene.traverse(object => {
        assert.ok(object.matrixWorld.elements.every(Number.isFinite), definition.id + ' finite matrix');
        if (!object.geometry) return;
        geometries.add(object.geometry);
        assert.ok([...object.geometry.attributes.position.array].every(Number.isFinite), definition.id + ' finite vertices');
        const array = object.geometry.attributes.position.array;
        let minZ = Infinity, maxZ = -Infinity;
        for (let i = 2; i < array.length; i += 3) { minZ = Math.min(minZ, array[i]); maxZ = Math.max(maxZ, array[i]); }
        depth ||= maxZ - minZ > .01 || object.isInstancedMesh || Math.abs(object.position.z) > .01;
        if (!object.visible || !object.parent.visible) return;
        calls++;
        const count = Math.min(object.geometry.drawRange.count, object.geometry.index?.count ?? object.geometry.attributes.position.count);
        if (object.isPoints) points += count;
        else triangles += count / 3 * (object.isInstancedMesh ? object.count : 1);
      });
      assert.ok(depth, definition.id + ' has spatial depth'); assert.ok(points <= PROFILES[mode].particles, definition.id + ' particle budget');
      assert.ok(triangles <= PROFILES[mode].triangles, definition.id + ' triangle budget'); assert.ok(calls <= PROFILES[mode].drawCalls, definition.id + ' call budget');
      assert.ok(scope.stats().estimatedBytes + resources.stats().bytes < PROFILES[mode].memoryBytes, definition.id + ' estimated memory budget');
      instance.setQuality(PROFILES.low); instance.setQuality(PROFILES.high);
      const after = new Set(); scene.traverse(o => { if (o.geometry) after.add(o.geometry); }); assert.deepEqual(after, geometries, definition.id + ' quality reuses geometry pools');
      instance.setParams({ ...params, director: true, cue: 'chorus', dust: .5, discRing: true, ripples: .5 }); instance.update({ ...frame, now: 1032, time: 1.032 });
      const frozenFrame = { ...frame, now: 2000, time: 2, sceneTime: 1, reduced: true, dynamicDt: 0 };
      for (let i = 0; i < 8; i++) instance.update({ ...frozenFrame, now: 2000 + i * 16 });
      const snapshot = () => {
        scene.updateMatrixWorld(true); const result = [];
        scene.traverse(o => {
          const uniforms = {};
          for (const [key, uniform] of Object.entries(o.material?.uniforms || {})) {
            if (['uFill', 'uProgress'].includes(key)) continue; // Playback highlighting remains live during seeks.
            const value = uniform.value;
            if (typeof value === 'number') uniforms[key] = value;
            else if (ArrayBuffer.isView(value)) uniforms[key] = Array.from(value);
            else if (value?.toArray && !value.isTexture) uniforms[key] = value.toArray();
          }
          result.push({ matrix: o.matrixWorld.elements.slice(), instances: o.instanceMatrix ? Array.from(o.instanceMatrix.array) : null, uniforms });
        }); return result;
      };
      const frozen = snapshot();
      instance.update({ ...frozenFrame, now: 3000, time: 3, bands: { bass: .1, mid: .9, treble: .8 }, spectrum: new Float32Array(64).fill(.9), onset: 0 });
      const still = snapshot();
      assert.deepEqual(still, frozen, definition.id + ' reduced scene clock/spectrum preserve geometry');
      instance.dispose(); instance.dispose(); scope.dispose(); scope.dispose(); resources.dispose();
      assert.equal(scene.children.length, 0, definition.id + ' scene cleanup'); assert.equal(scope.stats().resources, 0);
    }
  }
  const scope = createScope(), ctx = { THREE, scope, signal: scope.signal, params: {}, camera: new THREE.PerspectiveCamera(), quality: PROFILES.low, services: {} };
  await reactorContract(THREE, registry, createScope, PROFILES);
  await reactorArtworkContract(THREE, registry, createScope, PROFILES);
  await reactorPrefetchContract(THREE, registry, createScope, PROFILES);
  const post = createPostChain(ctx); post.resize(800, 600);
  const calls = [], fakeRenderer = { autoClear: false, getRenderTarget: () => null, setRenderTarget: target => calls.push(target), render: () => calls.push('render') };
  post.render(fakeRenderer, new THREE.Scene(), ctx.camera); assert.equal(post.stats().bytes, 0, 'no post target while disabled');
  post.setParams({ grain: 10, bokeh: 10 }); post.update({ time: 1 }); post.render(fakeRenderer, new THREE.Scene(), ctx.camera);
  assert.equal(post.stats().drawCalls, 1); assert.ok(post.stats().bytes <= 800 * 600 * 8 / 4); assert.equal(fakeRenderer.autoClear, false, 'renderer state restored');
  post.setParams({ grain: 0, bokeh: 0 }); assert.equal(post.stats().bytes, 0, 'disabled chain releases target'); post.dispose(); scope.dispose();
  for (const directory of ['src/scenes', 'src/effects']) for (const name of fs.readdirSync(path.join(stage, directory))) {
    const source = fs.readFileSync(path.join(stage, directory, name), 'utf8'); assert.doesNotMatch(source, /requestAnimationFrame|new\s+\w*\.?WebGLRenderer|AudioContext|Stage3D\.|CreativeGL\./, name + ' independent host or old renderer');
  }
  console.log('Space scene checks passed: ' + registry.catalog().length + ' scenes, ' + effects.catalog().length + ' effects, ' + created + ' real Three.js lifecycles, ' + manifest.entries.length + ' migration rows. Ordinary-PC/DBX GPU qualification unmeasured.');
})().catch(error => { console.error(error); process.exitCode = 1; });
