#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');

const stage = path.resolve(__dirname, '../tools/space-stage');
const load = relative => import(pathToFileURL(path.join(stage, relative)).href);
const ID = 'phoenix-vortex';
const FPS = 60, DT = 1 / FPS, EPS = 1e-8;
const KEYS = ['flight', 'swarm', 'gather', 'egg', 'flash'];
const states = {
  flight: { flight: 1, swarm: 0, gather: 0, egg: 0, flash: 0 },
  swarm: { flight: 0, swarm: 1, gather: 0, egg: 0, flash: 0 },
  egg: { flight: 0, swarm: 0, gather: 1, egg: 1, flash: 0 },
  rebirth: { flight: 1, swarm: 0, gather: 0, egg: 0, flash: 1 }
};
const checkpoints = new Map([[0, 'flight'], [5, 'flight'], [17, 'swarm'], [28, 'egg'], [36, 'flight']]);

function near(actual, expected, message, tolerance = EPS) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected} +/- ${tolerance}, got ${actual}`);
}
function phase(value, message) {
  assert.ok(value && typeof value === 'object', `${message}: missing state`);
  for (const key of KEYS) {
    assert.ok(Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1,
      `${message}: ${key} must be finite and inside [0, 1], got ${value[key]}`);
  }
  return Object.fromEntries(KEYS.map(key => [key, value[key]]));
}
function expectPhase(value, expected, message, tolerance = EPS) {
  phase(value, message);
  for (const key of KEYS) near(value[key], expected[key], `${message}: ${key}`, tolerance);
}
function frame(index, extra = {}) {
  const time = index / FPS, dt = index === 0 ? 0 : DT;
  return {
    now: time * 1000, sceneTime: time, time, dt, dynamicDt: dt, playing: true,
    bands: { bass: 0, mid: 0, treble: 0 },
    pointer: { active: false, down: false, x: 0, y: 0, click: { x: 0, y: 0, serial: 0 } },
    ...extra
  };
}
function materials(object) {
  return Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
}
function uniformGroups(scene) {
  const groups = new Set();
  scene.traverse(object => materials(object).forEach(material => {
    if (material.uniforms) groups.add(material.uniforms);
  }));
  return [...groups];
}
function uniformValue(value) {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), 'uniform values must remain finite');
    return value;
  }
  if (value == null || typeof value !== 'object') return value;
  if (value.isTexture) return { texture: value.uuid, version: value.version };
  if (ArrayBuffer.isView(value)) return Array.from(value, uniformValue);
  if (Array.isArray(value)) return value.map(uniformValue);
  if (typeof value.toArray === 'function') return value.toArray().map(uniformValue);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, uniformValue(entry)]));
}
function snapshot(scene) {
  scene.updateMatrixWorld(true);
  const result = [];
  scene.traverse(object => {
    assert.ok(object.matrixWorld.elements.every(Number.isFinite), 'finite world matrices');
    if (object.instanceMatrix) assert.ok(object.instanceMatrix.array.every(Number.isFinite), 'finite instance matrices');
    result.push({
      id: object.uuid, matrix: object.matrix.elements.slice(), world: object.matrixWorld.elements.slice(),
      instances: object.instanceMatrix ? Array.from(object.instanceMatrix.array) : null,
      uniforms: materials(object).map(material => Object.fromEntries(Object.entries(material.uniforms || {})
        .map(([key, uniform]) => [key, uniformValue(uniform.value)])))
    });
  });
  return result;
}
function geometryPool(scene) {
  const pool = new Map();
  scene.traverse(object => {
    if (object.geometry) pool.set(object.uuid, {
      geometry: object.geometry,
      index: object.geometry.index,
      attributes: { ...object.geometry.attributes },
      arrays: Object.fromEntries(Object.entries(object.geometry.attributes).map(([key, attribute]) => [key, attribute.array])),
      instances: object.instanceMatrix?.array
    });
  });
  return pool;
}
function expectSamePool(scene, before) {
  const after = geometryPool(scene);
  assert.deepEqual([...after.keys()], [...before.keys()], 'quality changes preserve scene geometry objects');
  for (const [id, old] of before) {
    const next = after.get(id);
    assert.equal(next.geometry, old.geometry, 'quality reuses geometry identity');
    assert.equal(next.index, old.index, 'quality reuses index buffers');
    assert.equal(next.instances, old.instances, 'quality reuses instance matrix buffers');
    assert.deepEqual(Object.keys(next.attributes), Object.keys(old.attributes), 'quality preserves attributes');
    for (const key of Object.keys(old.attributes)) {
      assert.equal(next.attributes[key], old.attributes[key], `quality reuses ${key} attribute`);
      assert.equal(next.arrays[key], old.arrays[key], `quality reuses ${key} storage`);
    }
  }
}

function timelineContract(timeline) {
  assert.equal(typeof timeline, 'function', 'phoenixTimeline is exported');
  for (const [time, mode] of checkpoints) {
    expectPhase(timeline(time), states[mode], `default auto timeline at ${time}s`);
    expectPhase(timeline(time, 'auto'), states[mode], `explicit auto timeline at ${time}s`);
  }
  for (let i = 0; i <= 36 * FPS; i++) {
    const time = i / FPS, current = phase(timeline(time), `timeline at frame ${i}`);
    expectPhase(timeline(time + 36), current, `36-second period at frame ${i}`);
    for (const [mode, expected] of Object.entries(states)) {
      expectPhase(timeline(time, mode), expected, `fixed ${mode} timeline at frame ${i}`);
    }
  }
}

(async () => {
  // File URLs also work when this script is launched outside the repository on Windows.
  const [THREE, { createRegistry }, { createScope }, { PROFILES }, { registerScenes }, { phoenixTimeline }] = await Promise.all([
    load('node_modules/three/build/three.module.js'), load('src/registry.js'), load('src/scope.js'),
    load('src/quality.js'), load('src/scenes/index.js'), load('src/scenes/phoenix-vortex.js')
  ]);
  const registry = createRegistry();
  registerScenes(registry);
  assert.equal(registry.resolve(ID), ID, 'scene is registered under its public id');
  assert.equal(registry.resolve('phoenix'), ID, 'scene resolves its short alias');
  const definition = registry.get(ID), defaults = registry.normalizeState(ID).params;
  assert.equal(definition.label, '凤凰涅槃');
  assert.equal(definition.params.performance?.type, 'select', 'performance is an editable scene selection');
  assert.equal(defaults.performance, 'auto', 'performance defaults to auto');
  for (const performance of ['auto', ...Object.keys(states)]) {
    assert.equal(registry.validateParams(ID, { performance }).performance, performance);
  }
  timelineContract(phoenixTimeline);
  const { phoenixArt } = await load('src/scenes/assets/phoenix-reference-data.js');
  const sourceHash = createHash('sha256').update(readFileSync(path.join(stage, 'src/scenes/assets/phoenix-reference.png'))).digest('hex');
  assert.equal(phoenixArt.sourceSha256, sourceHash, 'repack changed artwork with python tools/space-stage/build-phoenix-art.py');

  let lifecycles = 0;
  function fixture(quality = 'low', patch = {}) {
    const scope = createScope(), scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(58, 16 / 9, .05, 900);
    camera.position.set(0, 0, 16); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    // Keep the registered default speed: it defines the normal 36-second performance.
    let params = registry.validateParams(ID, patch, defaults), instance;
    try {
      instance = definition.create({ THREE, scene, camera, scope, signal: scope.signal,
        params, quality: PROFILES[quality], services: {} });
      for (const method of ['update', 'resize', 'setParams', 'setQuality', 'stats', 'dispose']) {
        assert.equal(typeof instance[method], 'function', `scene implements ${method}`);
      }
      instance.resize(1280, 720);
      assert.ok(scene.children.length > 0, 'factory attaches real Three.js objects');
      assert.ok(scope.stats().resources > 0, 'factory owns resources through its scope');
    } catch (error) { instance?.dispose(); scope.dispose(); throw error; }
    const disposals = new Map();
    scene.traverse(object => {
      for (const resource of [object.geometry, ...materials(object), object.isInstancedMesh ? object : null]) {
        if (!resource || disposals.has(resource)) continue;
        disposals.set(resource, 0);
        resource.addEventListener('dispose', () => disposals.set(resource, disposals.get(resource) + 1));
      }
    });
    return {
      scene, scope, instance,
      stats() {
        const primary = instance.stats().primary ?? instance.stats();
        phase(primary, 'stats.primary');
        for (const key of ['phoenixes', 'dust']) {
          assert.ok(Number.isInteger(primary[key]) && primary[key] > 0, `stats.primary.${key} is a positive count`);
        }
        assert.ok(Number.isFinite(primary.interactionBoost) && primary.interactionBoost >= 0, 'finite nonnegative interactionBoost');
        return { ...primary };
      },
      update(index, extra) { instance.update(frame(index, extra)); return this.stats(); },
      setParams(patch) { params = registry.validateParams(ID, patch, params); instance.setParams(params); },
      close(scopeFirst = false) {
        // Do not trackTree here: doing so would hide missing ownership in the factory.
        if (scopeFirst) { scope.dispose(); instance.dispose(); }
        else { instance.dispose(); scope.dispose(); }
        assert.equal(scene.children.length, 0, 'disposing removes the complete registered scene');
        assert.equal(scope.signal.aborted, true, 'scope aborts its signal');
        assert.deepEqual(scope.stats(), { resources: 0, tasks: 0, cleanups: 0, estimatedBytes: 0 }, 'scope releases all ownership');
        for (const [resource, count] of disposals) assert.ok(count > 0, `resource ${resource.type || resource.uuid} was disposed`);
        const counts = [...disposals.values()];
        instance.dispose(); scope.dispose();
        assert.deepEqual([...disposals.values()], counts, 'repeated disposal is idempotent');
        lifecycles++;
      }
    };
  }

  // Start at each profile, including low -> high, to expose undersized initial pools.
  const initialCounts = {};
  for (const initial of ['low', 'medium', 'high']) {
    const f = fixture(initial);
    try {
      initialCounts[initial] = f.update(0);
      const pool = geometryPool(f.scene), owned = f.scope.stats();
      assert.ok(pool.size > 0, 'scene contains geometry');
      for (const { geometry } of pool.values()) {
        assert.ok(geometry.attributes.position?.array.every(Number.isFinite), 'geometry has finite positions');
      }
      const counts = {};
      for (const quality of ['low', 'medium', 'high', 'medium', 'low', 'high']) {
        f.instance.setQuality(PROFILES[quality]);
        const current = f.stats();
        assert.ok(current.phoenixes <= 16, 'the flock stays intimate at every quality level');
        if (counts[quality]) {
          for (const key of ['phoenixes', 'dust']) assert.equal(current[key], counts[quality][key], `${quality} ${key} count is repeatable`);
        }
        counts[quality] = current;
        expectSamePool(f.scene, pool);
        assert.deepEqual(f.scope.stats(), owned, 'quality changes do not allocate new scoped resources');
      }
      for (const key of ['phoenixes', 'dust']) {
        assert.ok(counts.low[key] < counts.medium[key] && counts.medium[key] < counts.high[key], `${key}: low < medium < high`);
        assert.equal(initialCounts[initial][key], counts[initial][key], `${initial} factory and setQuality agree on ${key}`);
      }
      f.update(1); snapshot(f.scene);
    } finally { f.close(initial === 'high'); }
  }
  for (const key of ['phoenixes', 'dust']) {
    assert.ok(initialCounts.low[key] < initialCounts.medium[key] && initialCounts.medium[key] < initialCounts.high[key], `initial ${key} counts scale with quality`);
  }

  const timed = fixture(), shifted = fixture();
  try {
    for (let i = 0; i <= 36 * FPS; i++) {
      const ordinary = timed.update(i);
      const other = shifted.update(i, { sceneTime: 1000 + (i * 17) % 36, time: 9000 + i * .71 });
      expectPhase(other, ordinary, `performance advances by dt, not absolute clocks, at frame ${i}`);
      if (checkpoints.has(i / FPS)) {
        // The pure timeline is exact; rendered phase weights may ease toward its targets.
        expectPhase(ordinary, states[checkpoints.get(i / FPS)], `real scene after ${i / FPS}s at 60fps`, .1);
        snapshot(timed.scene);
      }
      if (i === 12 * FPS) {
        const paused = shifted.update(i, { sceneTime: 23, time: 3600, dt: 0, dynamicDt: 0 });
        expectPhase(paused, other, 'zero dt cannot seek the performance to the host clock');
      }
    }
  } finally { timed.close(); shifted.close(); }

  // Watch the actual rig through two cycles: departures share its transform,
  // the flock is consumed by the shell, and the same bird grows out of the egg.
  const continuous = fixture();
  try {
    const hero = continuous.scene.getObjectByName('phoenix-hero');
    const flock = continuous.scene.getObjectByName('phoenix-swarm');
    const shell = continuous.scene.getObjectByName('phoenix-egg');
    const uniforms = flock.material.uniforms;
    const skin = continuous.scene.getObjectByName('phoenix-reference-skin');
    const shellPositions = shell.geometry.attributes.position;
    let lowerWidth = 0, upperWidth = 0;
    for (let i = 0; i < shellPositions.count; i++) {
      const y = shellPositions.getY(i), x = Math.abs(shellPositions.getX(i));
      if (y < -.9 && y > -1.5) lowerWidth = Math.max(lowerWidth, x);
      if (y > .9 && y < 1.5) upperWidth = Math.max(upperWidth, x);
    }
    assert.ok(lowerWidth > upperWidth * 1.15, 'the egg has a round broad base and a narrower crown');
    assert.ok(continuous.scene.getObjectByName('phoenix-deep-space'), 'the performance has its own deep-space atmosphere');
    assert.ok(continuous.scene.getObjectByName('phoenix-star-streaks')?.isLineSegments, 'flight uses real perspective star trails');
    const artwork = uniforms.uArtwork.value;
    assert.equal(skin.material.uniforms.uArtwork.value, artwork, 'hero and fledglings share the same reference artwork');
    assert.ok(artwork.isDataTexture && artwork.image.width >= 900, 'the first frame has a decoded detailed phoenix without network loading');
    const alphaAt = (x, y) => artwork.image.data[(y * artwork.image.width + x) * 4 + 3];
    assert.equal(alphaAt(0, 0), 0, 'the artwork has no rectangular image background');
    assert.equal(alphaAt(900, 940), 0, 'the reference watermark area is outside the subject cutout');
    assert.ok(alphaAt(485, 440) > 180, 'the phoenix breast retains its painted plumage');
    const bodyPositions = skin.geometry.attributes.position;
    const bodyUvs = skin.geometry.attributes.uv;
    const surfaces = new Set(skin.geometry.attributes.aSurface.array);
    let frontDepth = -Infinity, backDepth = Infinity;
    // Preserve the approved image as one complete composition. Repeated feather
    // tiles or altered body proportions must not replace the reference again.
    for (let i = 0; i < bodyPositions.count; i++) {
      near(bodyPositions.getX(i), (bodyUvs.getX(i) - .5) * 12.5, 'reference x proportions remain intact', .000002);
      near(bodyPositions.getY(i), (.55 - bodyUvs.getY(i)) * 12.5 * artwork.image.height / artwork.image.width,
        'reference y proportions remain intact', .000002);
      frontDepth = Math.max(frontDepth, bodyPositions.getZ(i));
      backDepth = Math.min(backDepth, bodyPositions.getZ(i));
    }
    assert.ok(frontDepth - backDepth > 1.2 && surfaces.has(-1) && surfaces.has(0) && surfaces.has(1),
      'the original relief retains its front, back and feather edges');
    const homes = flock.geometry.attributes.aHome;
    for (let i = 0; i < homes.count; i++) {
      const u = homes.getX(i) / 12.5 + .5;
      const v = .55 - homes.getY(i) / (12.5 * artwork.image.height / artwork.image.width);
      assert.ok(alphaAt(Math.round(u * artwork.image.width), Math.round(v * artwork.image.height)) > 200,
        'a fledgling departs from a painted part of the approved phoenix');
    }
    assert.equal(skin.material.depthWrite, true, 'the near wing can occlude the body and far wing');
    const parts = new Set(flock.geometry.getAttribute('aPart').array);
    assert.ok(parts.has(0) && parts.has(1) && parts.has(2), 'each small bird includes feather wings, a tail, and a head/neck/crown');
    assert.equal(continuous.scene.getObjectByName('phoenix-ghost'), undefined, 'rebirth uses the original phoenix rig');
    let previous = null, births = 0, growing = false, smallest = 1, largest = 0;
    let minFlap = Infinity, maxFlap = -Infinity, minHeight = Infinity, maxHeight = -Infinity;
    let previousTravel = 0, previousDissolve = 0, sharedFrames = 0;
    const facing = hero.quaternion.clone();
    for (let i = 0; i <= 73 * FPS; i++) {
      const current = continuous.update(i), scale = hero.scale.x;
      assert.ok(current.travel >= previousTravel, 'star travel remains continuous when performance phases change');
      previousTravel = current.travel;
      if (i <= 17 * FPS) {
        minFlap = Math.min(minFlap, uniforms.uFlap.value); maxFlap = Math.max(maxFlap, uniforms.uFlap.value);
        minHeight = Math.min(minHeight, hero.position.y); maxHeight = Math.max(maxHeight, hero.position.y);
        near(hero.position.x, -.18, 'the hero remains horizontally centered');
        near(hero.position.z, .3, 'the hero stays at the same depth');
        near(hero.quaternion.angleTo(facing), 0, 'the hero never banks or turns away', .000001);
        assert.ok(current.speed < .3, 'the stars drift calmly behind the centered phoenix');
        assert.ok(uniforms.uDissolve.value >= previousDissolve, 'the hero disappears progressively');
        assert.ok(uniforms.uDissolve.value - previousDissolve < .004, 'the feather release has no abrupt jump');
        previousDissolve = uniforms.uDissolve.value;
        near(uniforms.uScatter.value, uniforms.uDissolve.value, 'fledglings follow the same release clock');
        if (current.flight > .15 && current.swarm > .15) sharedFrames++;
      }
      if (i === 28 * FPS) assert.ok(current.speed < .01, 'star streaks subside while the egg forms');
      assert.deepEqual(uniforms.uHeroMatrix.value.elements, hero.matrix.elements, 'flock departure coordinates follow the moving phoenix');
      if (hero.visible && previous?.visible) {
        assert.ok(Math.abs(scale - previous.scale) < .045, 'the visible phoenix unfolds continuously without a scale cut');
        assert.ok(hero.position.distanceTo(previous.position) < .32, 'the centered hero and hatch move continuously');
        assert.ok(hero.quaternion.angleTo(previous.quaternion) < .18, 'the presentation keeps its heading');
      }
      if (current.phase === 'rebirth' && !growing) { growing = true; births++; smallest = 1; largest = 0; }
      if (growing && hero.visible) { smallest = Math.min(smallest, scale); largest = Math.max(largest, scale); }
      if (growing && current.phase === 'flight') {
        assert.ok(smallest < .3 && largest > .95, 'each hatch expands from inside the egg to the full phoenix');
        growing = false;
      }
      if (current.egg > .999) assert.equal(flock.visible, false, 'a completed egg has consumed the flock');
      if (current.egg > .05 && current.phase !== 'rebirth') near(shell.scale.x, 1.16, 'shell forms on the flock arrival surface', .001);
      if (i === 32 * FPS) {
        const hatchPosition = hero.position.clone();
        continuous.update(i, { reduced: true, time: 999, sceneTime: 32, dynamicDt: 0 });
        near(hero.scale.x, scale, 'reduced motion preserves the half-unfolded hatch', .001);
        assert.ok(hero.position.distanceTo(hatchPosition) < .001, 'freezing rebirth keeps the bird inside the egg');
        const frozen = snapshot(continuous.scene);
        continuous.update(i, { reduced: true, time: 1999, sceneTime: 32, dynamicDt: 0 });
        assert.deepEqual(snapshot(continuous.scene), frozen, 'the half-unfolded bird stays frozen');
      }
      previous = { visible: hero.visible, scale, position: hero.position.clone(), quaternion: hero.quaternion.clone() };
    }
    assert.equal(births, 2, 'the complete continuous choreography repeats twice');
    assert.ok(maxFlap - minFlap > .6 && maxFlap - minFlap < .8, 'the hero has a clear, bounded wing stroke');
    assert.ok(maxHeight - minHeight < .2, 'hovering cannot turn into a flight path');
    assert.ok(sharedFrames > 5 * FPS, 'the large phoenix and fledglings overlap for at least five seconds');
    assert.equal(continuous.scene.getObjectByName('phoenix-flight-wake'), undefined, 'no abandoned orbit trail remains');
  } finally { continuous.close(); }

  for (const [mode, expected] of Object.entries(states)) {
    const f = fixture('low', { performance: mode });
    try {
      for (let i = 0; i <= 240; i++) f.update(i, { sceneTime: 23 + i / FPS, time: 100 + i / FPS });
      expectPhase(f.stats(), expected, `factory performance=${mode} locks the selected phase`, .05);
      const order = ['flight', 'swarm', 'egg', 'rebirth'];
      const next = order[(order.indexOf(mode) + 1) % order.length];
      f.setParams({ performance: next });
      for (let i = 241; i <= 480; i++) f.update(i);
      expectPhase(f.stats(), states[next], `setParams switches ${mode} to ${next}`, .05);
    } finally { f.close(); }
  }

  const visibility = {
    flight: { flames: false, embers: false, egg: false, ring: false, runes: false },
    swarm: { flames: true, embers: true, egg: false, ring: false, runes: false },
    egg: { flames: false, embers: false, egg: true, ring: true, runes: true },
    rebirth: { flames: false, embers: false, egg: false, ring: true, runes: true }
  };
  for (const mode of Object.keys(states)) {
    const f = fixture('low', { performance: mode });
    try {
      f.update(0);
      const flames = f.scene.getObjectByName('phoenix-flames'), embers = f.scene.getObjectByName('phoenix-embers');
      const shell = f.scene.getObjectByName('phoenix-egg'), ring = f.scene.getObjectByName('phoenix-ring'), runes = f.scene.getObjectByName('phoenix-runes');
      assert.ok(flames?.isInstancedMesh && embers?.isPoints, 'fledglings own attached flames and embers');
      assert.ok(shell?.isMesh && ring?.isMesh && runes?.isMesh, 'the egg, eclipse ring and rune circle are real meshes');
      const expected = visibility[mode];
      assert.equal(flames.visible, expected.flames, `${mode}: flames visibility`);
      assert.equal(embers.visible, expected.embers, `${mode}: embers visibility`);
      assert.equal(shell.visible, expected.egg, `${mode}: egg visibility`);
      assert.equal(ring.visible, expected.ring, `${mode}: eclipse ring visibility`);
      assert.equal(runes.visible, expected.runes, `${mode}: rune circle visibility`);
      if (expected.flames) {
        near(flames.material.uniforms.uFire.value, 1, `${mode}: fledgling fire follows the performance`, .01);
        assert.equal(flames.material.uniforms, embers.material.uniforms, 'fire layers share the frozen scene clock and interaction field');
      }
      if (expected.egg) near(shell.material.uniforms.uEgg.value, 1, `${mode}: egg opacity follows the performance`, .05);
      const pool = geometryPool(f.scene);
      for (const quality of ['low', 'medium', 'high', 'low']) {
        f.instance.setQuality(PROFILES[quality]);
        assert.equal(flames.count, f.stats().phoenixes, 'flames follow the active phoenix count');
        assert.equal(embers.geometry.instanceCount, f.stats().phoenixes, 'embers follow the active phoenix count');
        expectSamePool(f.scene, pool);
      }
      f.update(1, { reduced: true, sceneTime: 0, dynamicDt: 0 });
      const frozen = snapshot(f.scene);
      f.update(2, { reduced: true, sceneTime: 0, dynamicDt: 0, time: 999, bands: { bass: 1, mid: 1, treble: 1 } });
      assert.deepEqual(snapshot(f.scene), frozen, `${mode}: fire stays frozen in reduced motion`);
    } finally { f.close(); }
  }

  const interactive = fixture('low', { performance: 'swarm' });
  try {
    for (let i = 0; i <= 240; i++) interactive.update(i);
    expectPhase(interactive.stats(), states.swarm, 'interaction fixture settles in the flock', .05);
    const still = interactive.stats();
    near(still.stir, 0, 'flock starts without a hand-driven twist');
    for (let i = 241; i <= 360; i++) interactive.update(i, { pointer: { active: true, down: false, dragging: false, x: Math.sin(i * .15) * .4, y: Math.cos(i * .12) * .3 } });
    near(interactive.stats().stir, 0, 'hovering across the flock does not spin it');
    for (let i = 361; i <= 480; i++) interactive.update(i, { pointer: { active: true, down: true, dragging: false, x: .18, y: .12 } });
    assert.ok(interactive.stats().charge > .8, 'holding without dragging charges the ritual: ' + interactive.stats().charge);
    near(interactive.stats().stir, 0, 'holding still never adds stir');
    for (let i = 481; i <= 570; i++) {
      const angle = (i - 481) * .16, radius = .24 + (i - 481) * .001;
      interactive.update(i, { pointer: { active: true, down: false, dragging: true, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius } });
    }
    assert.ok(Math.abs(interactive.stats().stir) > .3, 'dragging around the center stirs the flock: ' + interactive.stats().stir);
    const beforeClick = interactive.stats().bursts;
    interactive.update(571, { pointer: { active: true, down: false, dragging: false, x: .2, y: .08, click: { serial: 1, x: .2, y: .08 } } });
    assert.equal(interactive.stats().bursts, beforeClick + 1, 'a new click releases one shockwave in the flock');
    for (let i = 572; i < 600; i++) interactive.update(i, { pointer: { active: true, down: false, dragging: false, x: .2, y: .08, click: { serial: 1, x: .2, y: .08 } } });
    assert.equal(interactive.stats().bursts, beforeClick + 1, 'repeating the click serial cannot release another shockwave');
  } finally { interactive.close(); }

  const hatching = fixture('low', { performance: 'egg' });
  try {
    for (let i = 0; i <= 240; i++) hatching.update(i);
    expectPhase(hatching.stats(), states.egg, 'hatching fixture settles on the egg', .05);
    near(hatching.stats().flash, 0, 'the egg rests without a rebirth flash');
    hatching.update(241, { pointer: { active: true, down: false, x: .1, y: .1, click: { serial: 1, x: .1, y: .1 } } });
    assert.ok(hatching.stats().flash > .3, 'clicking the egg sparks an early rebirth flash: ' + hatching.stats().flash);
    const surged = hatching.stats().bursts;
    assert.ok(surged > 0, 'the hatch click counts as a ritual burst');
    for (let i = 242; i <= 480; i++) hatching.update(i, { pointer: { active: false, down: false, x: .1, y: .1, click: { serial: 1, x: .1, y: .1 } } });
    near(hatching.stats().flash, 0, 'the surge decays back to the resting egg', .03);
  } finally { hatching.close(); }

  const breaking = fixture('low', { performance: 'egg' });
  try {
    for (let i = 0; i <= 240; i++) breaking.update(i);
    let index = 300;
    for (let serial = 1; serial <= 3; serial++) {
      breaking.update(index++, { pointer: { active: true, down: false, x: .1, y: .1, click: { serial, x: .1, y: .1 } } });
      for (let i = 0; i < 6; i++) breaking.update(index++, { pointer: { active: true, down: false, x: .1, y: .1, click: { serial, x: .1, y: .1 } } });
    }
    const burst = breaking.stats();
    assert.ok(burst.crack > .95, 'three strikes cook the shell through: ' + burst.crack);
    assert.ok(burst.hatch > .4, 'the third strike starts a white-hot hatch: ' + burst.hatch);
    assert.ok(burst.shards > 0, 'the hatch throws shell shards');
    for (let i = 0; i < 230; i++) breaking.update(index++);
    const settled = breaking.stats();
    near(settled.hatch, 0, 'the hatch spirit fades after the burst', .02);
    near(settled.crack, .12, 'the shell reforms with only its resting seams', .05);
    assert.equal(settled.strikes, 0, 'a finished hatch clears the strike count');
    assert.equal(settled.shards, 0, 'shell shards retire after the burst');
  } finally { breaking.close(); }

  const staticScene = fixture();
  try {
    staticScene.update(0, { reduced: true });
    const body = staticScene.scene.getObjectByName('phoenix-hero');
    assert.ok(body, 'phoenix exposes its rig group');
    near(body.position.x, -.18, 'first reduced frame places the rig on its cruise anchor');
    near(body.position.y, .55, 'rig height matches the cruise pose');
    near(body.position.z, .3, 'rig depth matches the cruise pose');
    near(body.rotation.y, .14, 'rig yaw matches the cruise pose');
    near(body.rotation.z, 0, 'the reference stays upright');
    const frozen = snapshot(staticScene.scene);
    staticScene.update(1, { reduced: true, sceneTime: 0, dynamicDt: 0 });
    assert.deepEqual(snapshot(staticScene.scene), frozen, 'initial reduced pose remains frozen');
    staticScene.setParams({ performance: 'egg', pointSize: 1.7 });
    staticScene.update(2, { reduced: true, sceneTime: 0, dynamicDt: 0 });
    expectPhase(staticScene.stats(), states.egg, 'explicit reduced-mode selection is immediately visible');
    assert.ok(uniformGroups(staticScene.scene).some(group => group.uSize?.value === 1.7), 'particle size remains editable in reduced mode');
    staticScene.setParams({ performance: 'swarm' });
    staticScene.update(3, { playing: false, dynamicDt: 0 });
    expectPhase(staticScene.stats(), states.swarm, 'paused mode selection is immediately visible');
    near(staticScene.stats().elapsed, 0, 'editing frozen parameters does not advance the performance clock');
  } finally { staticScene.close(); }

  const wired = fixture();
  try {
    wired.update(0);
    const groups = uniformGroups(wired.scene).filter(uniforms => uniforms.uPointerAmount && uniforms.uBass);
    assert.ok(groups.length > 0, 'rendered scene materials expose pointer and audio uniforms together');
    const silent = groups.map(uniforms => Object.fromEntries(['uBass', 'uMid', 'uTreble'].map(key => {
      assert.ok(uniforms[key], `rendered material exposes ${key}`);
      return [key, uniformValue(uniforms[key].value)];
    })));
    const hover = { active: true, down: false, x: .3, y: -.2, click: { serial: 0, x: .3, y: -.2 } };
    for (let i = 1; i <= 60; i++) wired.update(i, { pointer: hover, bands: { bass: .9, mid: .6, treble: .8 } });
    assert.ok(groups.some(uniforms => uniforms.uPointerAmount.value > 0), 'hover drives actual uPointerAmount above zero');
    const pointers = groups.map(uniforms => {
      assert.ok(uniforms.uPointer?.value?.isVector3, 'rendered material receives a local-space pointer');
      return uniforms.uPointer.value.clone();
    });
    for (const key of ['uBass', 'uMid', 'uTreble']) {
      assert.ok(groups.some((uniforms, index) => Number.isFinite(uniforms[key].value) && uniforms[key].value > silent[index][key] + EPS), `${key} responds to its input band`);
    }
    const loud = groups.map(uniforms => Object.fromEntries(['uBass', 'uMid', 'uTreble'].map(key => [key, uniforms[key].value])));
    for (let i = 61; i <= 120; i++) wired.update(i, { pointer: { ...hover, x: -.3, y: .2 } });
    assert.ok(groups.some((uniforms, index) => uniforms.uPointer.value.distanceTo(pointers[index]) > .01), 'changing pointer coordinates reaches the rendered field');
    for (const key of ['uBass', 'uMid', 'uTreble']) {
      assert.ok(groups.some((uniforms, index) => uniforms[key].value < loud[index][key] - EPS), `${key} responds to silence instead of remaining latched`);
    }
  } finally { wired.close(); }

  const repeated = fixture(), single = fixture();
  try {
    near(repeated.update(0).interactionBoost, 0, 'serial zero establishes the click baseline');
    near(single.update(0).interactionBoost, 0, 'control establishes the same click baseline');
    const pointer = { active: true, down: false, x: .2, y: -.1 };
    const click = { serial: 1, x: pointer.x, y: pointer.y };
    const boosts = [];
    for (let i = 1; i <= 300; i++) {
      const a = repeated.update(i, { pointer: { ...pointer, click } }).interactionBoost;
      const b = single.update(i, { pointer: { ...pointer, ...(i === 1 ? { click } : {}) } }).interactionBoost;
      near(a, b, `repeating serial 1 cannot retrigger the click at frame ${i}`);
      boosts.push(a);
    }
    const peak = Math.max(...boosts), first = boosts[0];
    assert.ok(peak > EPS, 'a new click increases interactionBoost');
    assert.ok(first < peak - EPS, 'interactionBoost rises over multiple frames instead of jumping to its peak');
    let rises = 0, previous = 0;
    for (const boost of boosts) {
      if (boost > previous + EPS) rises++;
      assert.ok(Math.abs(boost - previous) < peak * .5, 'click envelope has no single-frame jump of half its peak');
      previous = boost;
    }
    assert.ok(rises >= 3, 'click attack is gradual across at least three 60fps frames');
    for (let i = 301; i <= 330; i++) {
      near(single.update(i, { pointer: { ...pointer, click } }).interactionBoost,
        repeated.update(i, { pointer: { ...pointer, click } }).interactionBoost,
        'the old serial still cannot retrigger after click data was absent');
    }
    let newClickResponse = false;
    for (let i = 331; i <= 390; i++) {
      const old = repeated.update(i, { pointer: { ...pointer, click } }).interactionBoost;
      const fresh = single.update(i, { pointer: { ...pointer, click: { ...click, serial: 2 } } }).interactionBoost;
      newClickResponse ||= fresh > old + EPS;
    }
    assert.ok(newClickResponse, 'a genuinely new serial can trigger another response');
    assert.ok(single.stats().bursts > 0, 'clicking the cruising hero wakes the nirvana rite and its shockwave');
    assert.equal(single.stats().manual, true, 'the flight click transitions into the manual ritual');

    // The host freezes sceneTime/dynamicDt, but its wall clock and live inputs continue.
    // One reduced frame may zero interaction uniforms; every subsequent frame must be stable.
    single.update(391, { sceneTime: 6.5, reduced: true, dynamicDt: 0 });
    const frozen = snapshot(single.scene), frozenStats = single.stats();
    for (let i = 392; i <= 451; i++) {
      single.update(i, {
        sceneTime: 6.5, time: 1000 + i * 23, now: 100000 + i * 137, reduced: true, dynamicDt: 0,
        bands: { bass: i % 2, mid: (i % 3) / 2, treble: (i % 5) / 4 },
        pointer: { active: i % 3 !== 0, down: i % 2 === 0, x: Math.sin(i), y: Math.cos(i),
          click: { serial: i, x: Math.sin(i), y: Math.cos(i) } }
      });
      assert.deepEqual(snapshot(single.scene), frozen, `reduced motion freezes every matrix and uniform at frame ${i}`);
      expectPhase(single.stats(), frozenStats, 'reduced motion freezes performance phase');
      near(single.stats().interactionBoost, frozenStats.interactionBoost, 'reduced motion freezes the click response');
    }
    single.update(452);
    assert.notDeepEqual(snapshot(single.scene), frozen, 'normal motion resumes after reduced mode is released');
  } finally { repeated.close(); single.close(); }

  console.log(`Phoenix stage checks passed: timeline, 36s/60fps dt clock, fixed modes, quality pools, egg/ring/runes visibility, hatch surge, pointer/audio, click envelope, hands-on stirring/charge/shock, reduced motion, ${lifecycles} lifecycles.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
