#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const stage = path.resolve(__dirname, '../tools/space-stage');
const load = relative => import(pathToFileURL(path.join(stage, relative)).href);
const ID = 'butterfly-vortex';
const FPS = 60, DT = 1 / FPS, EPS = 1e-8;
const states = {
  butterfly: { scatter: 0, vortex: 0 },
  swarm: { scatter: 1, vortex: 0 },
  vortex: { scatter: 1, vortex: 1 }
};
const checkpoints = new Map([[0, 'butterfly'], [5, 'butterfly'], [12, 'swarm'], [23, 'vortex'], [36, 'butterfly']]);

function near(actual, expected, message, tolerance = EPS) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected} +/- ${tolerance}, got ${actual}`);
}
function phase(value, message) {
  assert.ok(value && typeof value === 'object', `${message}: missing state`);
  for (const key of ['scatter', 'vortex']) {
    assert.ok(Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1,
      `${message}: ${key} must be finite and inside [0, 1], got ${value[key]}`);
  }
  return { scatter: value.scatter, vortex: value.vortex };
}
function expectPhase(value, expected, message, tolerance = EPS) {
  phase(value, message);
  for (const key of ['scatter', 'vortex']) near(value[key], expected[key], `${message}: ${key}`, tolerance);
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
  assert.equal(typeof timeline, 'function', 'butterflyTimeline is exported');
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
  const [THREE, { createRegistry }, { createScope }, { PROFILES }, { registerScenes }, { butterflyTimeline }] = await Promise.all([
    load('node_modules/three/build/three.module.js'), load('src/registry.js'), load('src/scope.js'),
    load('src/quality.js'), load('src/scenes/index.js'), load('src/scenes/butterfly-vortex.js')
  ]);
  const registry = createRegistry();
  registerScenes(registry);
  assert.equal(registry.resolve(ID), ID, 'scene is registered under its public id');
  const definition = registry.get(ID), defaults = registry.normalizeState(ID).params;
  assert.equal(definition.label, '蝶舞星涡');
  assert.equal(definition.params.performance?.type, 'select', 'performance is an editable scene selection');
  assert.equal(defaults.performance, 'auto', 'performance defaults to auto');
  for (const performance of ['auto', ...Object.keys(states)]) {
    assert.equal(registry.validateParams(ID, { performance }).performance, performance);
  }
  timelineContract(butterflyTimeline);

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
        const primary = instance.stats().primary;
        phase(primary, 'stats.primary');
        for (const key of ['butterflies', 'dust']) {
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
        if (counts[quality]) {
          for (const key of ['butterflies', 'dust']) assert.equal(current[key], counts[quality][key], `${quality} ${key} count is repeatable`);
        }
        counts[quality] = current;
        expectSamePool(f.scene, pool);
        assert.deepEqual(f.scope.stats(), owned, 'quality changes do not allocate new scoped resources');
      }
      for (const key of ['butterflies', 'dust']) {
        assert.ok(counts.low[key] < counts.medium[key] && counts.medium[key] < counts.high[key], `${key}: low < medium < high`);
        assert.equal(initialCounts[initial][key], counts[initial][key], `${initial} factory and setQuality agree on ${key}`);
      }
      f.update(1); snapshot(f.scene);
    } finally { f.close(initial === 'high'); }
  }
  for (const key of ['butterflies', 'dust']) {
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

  for (const [mode, expected] of Object.entries(states)) {
    const f = fixture('low', { performance: mode });
    try {
      for (let i = 0; i <= 240; i++) f.update(i, { sceneTime: 23 + i / FPS, time: 100 + i / FPS });
      expectPhase(f.stats(), expected, `factory performance=${mode} locks the selected phase`, .05);
      const next = mode === 'vortex' ? 'butterfly' : 'vortex';
      f.setParams({ performance: next });
      for (let i = 241; i <= 480; i++) f.update(i);
      expectPhase(f.stats(), states[next], `setParams switches ${mode} to ${next}`, .05);
    } finally { f.close(); }
  }

  const staticScene = fixture();
  try {
    staticScene.update(0, { reduced: true });
    let body;
    staticScene.scene.traverse(object => { if (object.children.some(child => child.isInstancedMesh && child.count === 3)) body = object; });
    assert.ok(body, 'butterfly has an attached body');
    assert.deepEqual(body.position.toArray(), [-.55, .8, .8], 'first reduced frame aligns the body with the wing shader origin');
    near(body.rotation.y, .22, 'body yaw matches the wing shader transform');
    near(body.rotation.z, .24, 'body roll matches the wing shader transform');
    const frozen = snapshot(staticScene.scene);
    staticScene.update(1, { reduced: true, sceneTime: 0, dynamicDt: 0 });
    assert.deepEqual(snapshot(staticScene.scene), frozen, 'initial reduced pose remains frozen');
    staticScene.setParams({ performance: 'vortex', pointSize: 1.7 });
    staticScene.update(2, { reduced: true, sceneTime: 0, dynamicDt: 0 });
    expectPhase(staticScene.stats(), states.vortex, 'explicit reduced-mode selection is immediately visible');
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

  console.log(`Butterfly stage checks passed: timeline, 36s/60fps dt clock, fixed modes, quality pools, pointer/audio, click envelope, reduced motion, ${lifecycles} lifecycles.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
