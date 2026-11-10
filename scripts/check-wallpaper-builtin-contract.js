// SPDX-License-Identifier: MIT
'use strict';
// Source functions and real Three constructors; no renderer, network or media loader.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const plain = value => JSON.parse(JSON.stringify(value));
const source = file => import(pathToFileURL(path.resolve(__dirname, '../tools/space-stage', file)).href);
let checks = 0;
function check(label, run) { run(); checks++; console.log('PASS ' + label); }

async function main() {
  const [{ createRegistry }, { sceneDefinitions, registerScenes }, { PROFILES }, { createScope }, THREE] = await Promise.all([
    source('src/registry.js'), source('src/scenes/index.js'), source('src/quality.js'), source('src/scope.js'), source('node_modules/three/build/three.module.js')
  ]);
  const registry = createRegistry(); registerScenes(registry);
  const definition = sceneDefinitions.find(def => def.id === 'spectrum-towers');
  const metadata = registry.get(definition.id).metadata;
  const resources = metadata.composition.qualities.low.sourceResources;
  const register = patch => createRegistry().register({ ...definition, ...patch });
  check('legacy source planner request reaches the production ledger without metadata dimensions', () => {
    const budget = require('../plugin/ui/stage-resource-budget.js');
    const ledger = budget.create({ contractVersion: 1, policyVersion: 'builtin-contract-test', qualification: 'test-only',
      caps: Object.fromEntries(budget.dimensions.map(key => [key, 64 * 1048576])) });
    const declared = definition.resourcePlan({ quality: PROFILES.low, params: registry.normalizeState('towers').params });
    assert.equal(ledger.port('renderer', 'builtin-contract-test').preflight(declared, []).ok, true);
    assert.deepEqual(Object.keys(declared).sort(), ['bufferDeclaredBytes', 'ownedCpuBytes', 'programs']);
    assert.deepEqual(definition.compositionResourcePlan({ quality: PROFILES.low }).primitives,
      { drawCalls: 3, points: 480, triangles: 1608 });
  });
  check('only the source towers definition publishes an inert frozen composition contract', () => {
    assert.equal(registry.catalog().filter(def => def.composition).length, 1);
    assert(Object.isFrozen(metadata.composition.qualities.low.sourceResources.buffers));
    assert.equal(metadata.composition.adapterId, 'builtin-scene');
    assert.equal(metadata.composition.clock.inputBytes, 1200);
    for (const [key, value] of Object.entries(PROFILES.low)) assert.equal(metadata.composition.qualities.low[key], value);
    assert.equal(JSON.stringify(metadata).includes('function'), false);
    let factoryCalls = 0;
    register({ create() { factoryCalls++; throw new Error('factory must stay inert'); } });
    assert.equal(factoryCalls, 0);
  });
  check('all four independent source plans include hidden ripple CPU state and constructor peak', () => {
    assert.deepEqual(resources.buffers, [
      { id: 'towers', cpuPeakBytes: 22120, cpuRetainedBytes: 20296, bufferBytes: 20296 },
      { id: 'dust', cpuPeakBytes: 14400, cpuRetainedBytes: 14400, bufferBytes: 14400 },
      { id: 'orbit', cpuPeakBytes: 6760, cpuRetainedBytes: 4936, bufferBytes: 4936 },
      { id: 'ripple', cpuPeakBytes: 46968, cpuRetainedBytes: 13880, bufferBytes: 13856 }
    ]);
    assert.equal(resources.cpuPeakBytes, 90248); assert.equal(resources.cpuRetainedBytes, 53512);
    assert.equal(resources.bufferBytes, 53488); assert.equal(resources.programs, 4);
    assert.deepEqual(metadata.composition.qualities.low.sourcePrimitives, { drawCalls: 3, points: 480, triangles: 1608 });
  });
  check('real original factory claims exact IDs, independently commits CPU and constructs low primitives', () => {
    const state = registry.compositionState('towers', { params: { dust: 1, discRing: true, cue: 'bridge', director: true } });
    const scope = createScope(), calls = [], scene = new THREE.Scene();
    scope.bufferPlan = (peak, bytes, diagnostic, id) => {
      const call = { id, peak, bytes, retained: null, arrays: new Set() }; calls.push(call);
      return { cpuReady(value) { call.retained = value; }, upload(attribute) { call.arrays.add(attribute.array); return attribute; } };
    };
    const instance = definition.create({ THREE, scene, scope, params: state.params, quality: PROFILES.low });
    instance.setQuality(PROFILES.low); instance.update({ sceneTime: 1, time: 1, level: .5, playing: true, bands: { bass: .5, mid: .3, treble: .2 } });
    assert.deepEqual(calls.map(call => ({ id: call.id, cpuPeakBytes: call.peak, cpuRetainedBytes: call.retained, bufferBytes: [...call.arrays].reduce((sum, array) => sum + array.byteLength, 0) })), resources.buffers);
    const primitives = { drawCalls: 0, points: 0, triangles: 0 };
    scene.traverseVisible(object => {
      if (object.isPoints) { primitives.drawCalls++; primitives.points += object.geometry.drawRange.count; }
      if (object.isInstancedMesh) { primitives.drawCalls++; primitives.triangles += object.count * object.geometry.index.count / 3; }
    });
    assert.deepEqual(primitives, metadata.composition.qualities.low.sourcePrimitives);
    instance.dispose(); scope.dispose(); assert.equal(scene.children.length, 0); assert.equal(scope.stats().resources, 0);
  });
  const preparedScope = (caps = {}) => {
    const budget = require('../plugin/ui/stage-resource-budget.js');
    const ledger = budget.create({ contractVersion: 1, policyVersion: 'builtin-prepared-test', qualification: 'test-only',
      caps: { ...Object.fromEntries(budget.dimensions.map(key => [key, 64 * 1048576])), ...caps } });
    const port = ledger.port('renderer', 'builtin-prepared-test'); let reservations = 0;
    const scope = createScope({ resources: { ...port, require(...args) { reservations++; return port.require(...args); } },
      generation: 7, preparedBuffersRequired: true });
    return { scope, ledger, reservations: () => reservations };
  };
  const prepare = scope => resources.buffers.forEach(buffer => scope.prepareBufferPlan(buffer.id, buffer.cpuPeakBytes, buffer.bufferBytes));
  check('eight original tickets precede the factory; claims reserve nothing and commit four distinct retained amounts', () => {
    const { scope, ledger, reservations } = preparedScope(); prepare(scope);
    assert.equal(reservations(), 8); assert.equal(scope.stats().unclaimedPreparedBuffers, 4);
    assert.equal(ledger.snapshot().held.ownedCpuBytes, resources.cpuPeakBytes);
    assert.equal(ledger.snapshot().held.bufferDeclaredBytes, resources.bufferBytes);
    const scene = new THREE.Scene(), state = registry.compositionState('towers', { params: { dust: 1, discRing: true } });
    scope.beginAllocation();
    const instance = definition.create({ THREE, scene, scope, params: state.params, quality: PROFILES.low });
    instance.setQuality(PROFILES.low); instance.update({ sceneTime: 1, time: 1, playing: true });
    assert.equal(reservations(), 8); assert.equal(scope.stats().unclaimedPreparedBuffers, 0);
    assert.equal(ledger.snapshot().live.ownedCpuBytes, resources.cpuRetainedBytes);
    const uploaded = new Set();
    scene.traverse(object => {
      const attributes = object.geometry ? [...Object.values(object.geometry.attributes), object.geometry.index] : [];
      if (object.isInstancedMesh) attributes.push(object.instanceMatrix, object.instanceColor);
      for (const attribute of attributes.filter(Boolean)) if (!uploaded.has(attribute)) {
        uploaded.add(attribute); attribute.onUploadCallback();
      }
    });
    assert.equal(ledger.snapshot().live.bufferDeclaredBytes, resources.bufferBytes);
    scope.defer(() => instance.dispose()); scope.dispose();
    assert.equal(ledger.snapshot().resources, 8, 'allocation barrier keeps ticket charges until endAllocation');
    scope.endAllocation(); assert.equal(ledger.snapshot().resources, 0); assert.equal(scene.children.length, 0);
  });
  check('missing, duplicate, mismatched and foreign-scope claims cannot allocate a fallback plan', () => {
    const { scope, ledger, reservations } = preparedScope(); const buffer = resources.buffers[0];
    assert.throws(() => scope.bufferPlan(buffer.cpuPeakBytes, buffer.bufferBytes, 'missing', buffer.id), /claim-mismatch/);
    assert.equal(reservations(), 0);
    scope.prepareBufferPlan(buffer.id, buffer.cpuPeakBytes, buffer.bufferBytes);
    assert.throws(() => scope.prepareBufferPlan(buffer.id, buffer.cpuPeakBytes, buffer.bufferBytes), /id-invalid/);
    assert.throws(() => scope.bufferPlan(buffer.cpuPeakBytes - 1, buffer.bufferBytes, 'mismatch', buffer.id), /claim-mismatch/);
    const foreign = preparedScope();
    assert.throws(() => foreign.scope.bufferPlan(buffer.cpuPeakBytes, buffer.bufferBytes, 'foreign', buffer.id), /claim-mismatch/);
    assert.equal(foreign.reservations(), 0); foreign.scope.dispose();
    scope.bufferPlan(buffer.cpuPeakBytes, buffer.bufferBytes, 'exact', buffer.id);
    assert.throws(() => scope.bufferPlan(buffer.cpuPeakBytes, buffer.bufferBytes, 'twice', buffer.id), /claim-mismatch/);
    assert.equal(reservations(), 2); scope.dispose(); assert.equal(ledger.snapshot().resources, 0);
  });
  check('last reservation refusal releases earlier unclaimed tickets without constructing resources', () => {
    const { scope, ledger } = preparedScope({ bufferDeclaredBytes: resources.bufferBytes - 1 }); let constructed = false;
    assert.throws(() => { prepare(scope); constructed = true; });
    assert.equal(constructed, false); scope.dispose(); assert.equal(ledger.snapshot().resources, 0);
  });
  check('constructor failures and cleanup failure retain the original allocation-release barrier', () => {
    for (const name of ['ShaderMaterial', 'PointsMaterial', 'MeshBasicMaterial', 'TorusGeometry']) {
      const { scope, ledger } = preparedScope(); prepare(scope); scope.beginAllocation(); const scene = new THREE.Scene();
      let calls = 0;
      const failing = { ...THREE, [name]: class { constructor() { calls++; throw new Error('controlled constructor failure'); } } };
      assert.throws(() => definition.create({ THREE: failing, scene, scope, params: registry.normalizeState('towers').params, quality: PROFILES.low }), /controlled constructor/);
      assert(calls > 0); scope.dispose(); assert.equal(ledger.snapshot().resources, 8);
      scope.endAllocation(); assert.equal(ledger.snapshot().resources, 0); assert.equal(scene.children.length, 0);
    }
    const { scope, ledger } = preparedScope(); prepare(scope); scope.defer(() => { throw new Error('controlled cleanup failure'); });
    scope.dispose(); assert.equal(scope.stats().cleanupFailed, true); assert.equal(ledger.snapshot().resources, 8);
    scope.endAllocation(); assert.equal(ledger.snapshot().resources, 8, 'failed release proof cannot erase budget charges');
    assert.throws(() => createScope({ preparedBuffersRequired: true }), /resource-policy-required/);
  });
  check('normalized non-default parameters survive while every non-zero unsupported effect is refused', () => {
    const value = registry.compositionState('towers', { params: { speed: 1.2, director: true, reduced: true, cue: 'chorus', density: .2 } });
    assert.equal(value.id, 'spectrum-towers'); assert.equal(value.params.speed, 1.2); assert.equal(value.params.cue, 'chorus');
    assert.equal(value.params.director, true); assert.equal(value.params.reduced, true); assert.equal(value.params.density, .2);
    for (const key of Object.keys(metadata.composition.parameterEquals)) assert.throws(() => registry.compositionState('towers', { params: { [key]: 1 } }), new RegExp(key));
    assert.throws(() => registry.compositionState('reactor', {}), /adapter unavailable/);
    assert.throws(() => registry.compositionState('towers', { stateVersion: 2 }), /version/);
    assert.throws(() => registry.compositionState('towers', {}, 'medium'), /quality unavailable/);
    assert.throws(() => registry.compositionState('towers', { params: { unknown: 0 } }), /Unknown parameter/);
  });
  check('malformed versions, clocks, profiles, predicates and source costs fail registration', () => {
    const mutate = fn => { const composition = plain(metadata.composition); fn(composition); assert.throws(() => register({ composition })); };
    mutate(value => { value.contractVersion = 2; }); mutate(value => { value.adapterVersion = 0; });
    mutate(value => { value.supportedStateVersions = [2]; }); mutate(value => { value.rootOnly = false; });
    mutate(value => { value.parameterEquals.unknown = 0; }); mutate(value => { value.parameterEquals.ripples = '0'; });
    mutate(value => { value.clock.inputBytes--; }); mutate(value => { value.clock.spectrumCapacity++; });
    mutate(value => { value.qualities.low.dprCap = 1; }); mutate(value => { value.qualities.high = value.qualities.low; });
    mutate(value => { value.qualities.low.sourceResources.buffers[1].id = 'towers'; });
    mutate(value => { value.qualities.low.sourceResources.cpuPeakBytes--; });
    mutate(value => { const r = value.qualities.low.sourceResources; r.buffers[0].cpuPeakBytes--; r.cpuPeakBytes--; });
    mutate(value => { value.qualities.low.sourceResources.programs--; });
    mutate(value => { value.qualities.low.sourcePrimitives.points--; });
    mutate(value => { value.qualities.low.sourceResources.buffers[0].bufferBytes = NaN; });
    mutate(value => { value.extra = true; });
  });
  console.log('wallpaper builtin source contract: ' + checks + ' checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
