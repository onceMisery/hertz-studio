// SPDX-License-Identifier: MIT
// Pure regression checks for the actual SVG native acceptance helpers; no browser or process launch.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {createHash} = require('node:crypto');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const playwrightModule = process.env.PLAYWRIGHT_MODULE || 'playwright';
let forbiddenBrowserCalls = 0;
const originalLoad = Module._load;
let forbiddenProcessCalls = 0;
Module._load = function (id, ...rest) {
  if (id === playwrightModule) return {chromium: {launch: () => {forbiddenBrowserCalls++; throw new Error('Pure check forbids browser launch');}, connectOverCDP: () => {forbiddenBrowserCalls++; throw new Error('Pure check forbids CDP');}}};
  if (id === 'node:child_process') return {
    ...originalLoad.call(this, id, ...rest),
    spawn: () => { forbiddenProcessCalls++; throw new Error('Pure reviewer forbids spawn'); },
    execFile: () => { forbiddenProcessCalls++; throw new Error('Pure reviewer forbids process execution'); },
    execFileSync: () => { forbiddenProcessCalls++; throw new Error('Pure reviewer forbids process execution'); },
  };
  return originalLoad.call(this, id, ...rest);
};
let helpers;
try { helpers = require(path.join(root, 'scripts/check-wallpaper-svg-native.js')); }
finally { Module._load = originalLoad; }
const {historyHoldRequired, waitForHistoryExpiry, waitOwnedChildSlice,
  historyHoldFingerprint, assertHistoryHoldUnchanged, validateOwnedMemoryCoverage} = helpers;
const results = [];
const clone = value => structuredClone(value);
async function test(name, check) {
  try { await check(); results.push({name, passed: true}); console.log('PASS ' + name); }
  catch (error) { results.push({name, passed: false, error: error.stack}); console.error('FAIL ' + name + ': ' + error.message); }
}
function ownedEmitter(exitCode = null, signalCode = null) {
  return Object.assign(new EventEmitter(), {exitCode, signalCode});
}
function sampleFixture() {
  const binding = {sessionId: 'owned-svg-session', generation: 7, scope: 'owned-scope'};
  const selection = {kind: 'package', workKey: 'owned-svg-font', packageHash: 'e'.repeat(64)};
  const budget = {contexts: 1, targets: 1, cpuBytes: 8192, assetCpuBytes: 4096, gpuBytes: 4096, prepareTasks: 0, releasePending: 0};
  const state = {revision: 14, wallpaper: {revision: 14, retiringControllers: 0, retirements: [], budget,
    targets: [{groupId: 'native-svg', firstFrameReady: true, visible: true, session: {frameKind: 'gl', binding},
      appliedRevision: 14, desiredRevision: 14, appliedSelection: selection, desiredSelection: selection,
      glAllocation: {contextId: 'owned-context', allocationId: 'owned-allocation'}}]}};
  const config = {revision: 14, unboundDomain: {wallpaper: {enabled: true, groups: [{selection,
    presentation: {fps: 15, quality: 'low', fit: 'contain'}, properties: {}}]}}};
  const sample = {allocation: {compositionUrl: 'https://wallpaper.invalid/owned/composition.json'}, binding,
    projection: {sessionId: binding.sessionId, generation: binding.generation, semanticKey: 'a'.repeat(64),
      targetKey: 'b'.repeat(64), target: {width: 960, height: 540}, resolvedAssets: [{logicalKind: 'vector', kind: 'image',
        adapterId: 'prepared-svg-png', sourceHash: 'c'.repeat(64), contentKey: 'd'.repeat(64),
        decodeOptions: {svgFontDependencies: [{assetId: 'font', sha256: 'f'.repeat(64)}]}}]},
    debug: {mounted: true, error: null, scene: 'composition', backend: 'space', session: binding,
      draws: 100, sceneTime: 10, glBudget: {contexts: 1, error: null, pendingBytes: 0, textureBytes: 4096},
      stats: {state: 'ready', contextId: 'owned-context', sceneStats: {ready: true, semanticKey: 'a'.repeat(64), contextId: 'owned-context'},
        frameCount: 100, poolEntries: 1, poolPending: 0, poolLeases: 2, resources: 1, tasks: 0, cleanups: 1,
        leases: 2, admissionTickets: 1, allocationTasks: 0, estimatedBytes: 4096}}};
  return {state, sample, config, owner: {pid: 12345, settingsUrl: 'https://wallpaper.invalid/settings.html', rendererUrl: 'https://wallpaper.invalid/wallpaper.html'}};
}
function fingerprint(fixture) { return historyHoldFingerprint(fixture.state, fixture.sample, fixture.config, fixture.owner); }
function memory(elapsedMs) { return {pid: 12345, elapsedMs, workingSetBytes: 10, privateBytes: 5, handles: 2}; }
async function main() {
  await test('actual exported helpers load without starting processes or a browser', () => {
    assert.equal(forbiddenProcessCalls, 0); assert.equal(forbiddenBrowserCalls, 0); assert.equal(Object.keys(helpers).length, 6);
  });
  await test('cadence threshold is 120 original writes and validates epoch inputs', () => {
    assert.equal(historyHoldRequired(119, 0), false); assert.equal(historyHoldRequired(120, 0), true);
    assert.equal(historyHoldRequired(121, 0), true); assert.equal(historyHoldRequired(240, 121), false);
    assert.equal(historyHoldRequired(241, 121), true);
    for (const args of [[1, 2], [-1, 0], [1, -1], [NaN, 0], [Infinity, 0], [1.5, 0]])
      assert.throws(() => historyHoldRequired(...args));
  });
  await test('50 six-write cycles with initial sequence 31 require two completed expiry epochs', () => {
    let sequence = 31, epoch = 0; const holds = [];
    for (let cycle = 0; cycle < 50; cycle++) {
      if (historyHoldRequired(sequence, epoch)) { holds.push({cycle, sequence, epoch}); epoch = sequence; }
      assert(sequence - epoch < 120); sequence += 6;
    }
    assert.deepEqual(holds, [{cycle: 15, sequence: 121, epoch: 0}, {cycle: 35, sequence: 241, epoch: 121}]);
    assert.equal(sequence, 331); assert.equal(epoch, 241);
  });
  await test('history expiry takes 601000 actual monotonic milliseconds in bounded slices', async () => {
    let clock = 9374; const durations = [], observations = [];
    const timing = await waitForHistoryExpiry({now: () => clock, alive: () => true,
      sleep: async ms => {durations.push(ms); clock += ms;}, observe: async value => observations.push(value)});
    assert.equal(timing.elapsedMs, 601000); assert.equal(timing.startedMonotonicMs, 9374);
    assert.equal(timing.finishedMonotonicMs, clock); assert.equal(timing.slices, 601);
    assert(durations.every(ms => ms > 0 && ms <= 1000));
    assert.equal(observations.length, 20); assert.equal(observations[0].elapsedMs, 30000);
    assert.equal(observations.at(-1).elapsedMs, 600000);
  });
  await test('requested sleep durations cannot manufacture expiry when clock advances more slowly', async () => {
    let clock = 0, sleeps = 0;
    const timing = await waitForHistoryExpiry({now: () => clock, alive: () => true,
      sleep: async ms => {clock += ms / 2; sleeps++; if (601000 - clock < .001) clock = 601000;}, observe: async () => {}});
    assert(timing.elapsedMs >= 601000); assert(sleeps > 601);
  });
  await test('oversleep counts actual elapsed time, preserving minimum and slice cap', async () => {
    let clock = 0; const durations = [];
    const timing = await waitForHistoryExpiry({now: () => clock, alive: () => true,
      sleep: async ms => {durations.push(ms); clock += 1700;}, observe: async () => {}});
    assert(timing.elapsedMs >= 601000); assert.equal(timing.finishedMonotonicMs, clock);
    assert(durations.every(ms => ms <= 1000));
  });
  await test('dead original child before expiry emits no sleep or observation', async () => {
    let calls = 0;
    await assert.rejects(waitForHistoryExpiry({now: () => 0, alive: () => false,
      sleep: async () => calls++, observe: async () => calls++}), /child exited/);
    assert.equal(calls, 0);
  });
  await test('original child exit during a sleep aborts before observations', async () => {
    let alive = true, observations = 0;
    await assert.rejects(waitForHistoryExpiry({now: () => 0, alive: () => alive,
      sleep: async () => {alive = false;}, observe: async () => observations++}), /child exited/);
    assert.equal(observations, 0);
  });
  await test('child death during observation cannot complete an expiry epoch', async () => {
    let clock = 0, alive = true;
    await assert.rejects(waitForHistoryExpiry({now: () => clock, alive: () => alive,
      sleep: async () => {clock += 601000;}, observe: async () => {alive = false;}}), /child exited/);
  });
  await test('clock regression and observer failure abort expiry', async () => {
    let clock = 100;
    await assert.rejects(waitForHistoryExpiry({now: () => clock, alive: () => true,
      sleep: async () => {clock--;}, observe: async () => {}}), /monotonic/);
    clock = 0;
    await assert.rejects(waitForHistoryExpiry({now: () => clock, alive: () => true,
      sleep: async () => {clock += 30000;}, observe: async () => {throw new Error('identity drift');}}), /identity drift/);
  });
  await test('owned-child bounded slice completes and removes listeners', async () => {
    const child = ownedEmitter(); await waitOwnedChildSlice(child, 1);
    assert.equal(child.listenerCount('exit'), 0); assert.equal(child.listenerCount('error'), 0);
  });
  await test('already exited or signalled owned child rejects immediately', async () => {
    for (const child of [ownedEmitter(0), ownedEmitter(null, 'SIGTERM')]) {
      await assert.rejects(waitOwnedChildSlice(child, 1), /already dead/);
      assert.equal(child.listenerCount('exit'), 0); assert.equal(child.listenerCount('error'), 0);
    }
  });
  await test('owned-child exit and error events abort and clear pending listeners', async () => {
    for (const event of ['exit', 'error']) {
      const child = ownedEmitter(); const waiting = waitOwnedChildSlice(child, 1000);
      const rejected = assert.rejects(waiting, event === 'exit' ? /Owned host exited/ : /owned test error/);
      child.emit(event, event === 'exit' ? 0 : new Error('owned test error')); await rejected;
      assert.equal(child.listenerCount('exit'), 0); assert.equal(child.listenerCount('error'), 0);
    }
  });
  await test('owned-child helper rejects nonpositive, nonfinite, or unbounded slices', () => {
    for (const ms of [0, -1, 1001, Infinity, NaN]) assert.throws(() => waitOwnedChildSlice(ownedEmitter(), ms));
  });
  await test('fingerprint observes original identity without mutating inputs and ignores frame progression', () => {
    const original = sampleFixture(), saved = clone(original), before = fingerprint(original);
    assert.deepEqual(original, saved); const advanced = clone(original);
    advanced.sample.debug.draws++; advanced.sample.debug.sceneTime++; advanced.sample.debug.stats.frameCount++;
    assertHistoryHoldUnchanged(before, fingerprint(advanced));
  });
  const driftCases = {
    owned_pid: f => {f.owner.pid++;},
    settings_page: f => {f.owner.settingsUrl += '?new';},
    renderer_page: f => {f.owner.rendererUrl += '?new';},
    full_saved_wallpaper: f => {f.config.unboundDomain.wallpaper.groups[0].presentation.fit = 'cover';},
    native_budget: f => {f.state.wallpaper.budget.cpuBytes++;},
    page_budget: f => {f.sample.debug.glBudget.textureBytes++;},
    context: f => {f.sample.debug.stats.contextId = f.sample.debug.stats.sceneStats.contextId = 'new-context';},
    allocation: f => {f.sample.allocation.compositionUrl += '?new';},
    native_allocation: f => {f.state.wallpaper.targets[0].glAllocation.allocationId = 'new-allocation';},
    semantic_key: f => {f.sample.projection.semanticKey = f.sample.debug.stats.sceneStats.semanticKey = '1'.repeat(64);},
    target_key: f => {f.sample.projection.targetKey = '2'.repeat(64);},
    source_bytes: f => {f.sample.projection.resolvedAssets[0].sourceHash = '3'.repeat(64);},
    author_font_bytes: f => {f.sample.projection.resolvedAssets[0].decodeOptions.svgFontDependencies[0].sha256 = '4'.repeat(64);},
    pool_leases: f => {f.sample.debug.stats.poolLeases++;},
    resource_leases: f => {f.sample.debug.stats.leases++;},
  };
  for (const [name, mutate] of Object.entries(driftCases)) await test('hold rejects changed ' + name, () => {
    const beforeFixture = sampleFixture(), afterFixture = clone(beforeFixture); mutate(afterFixture);
    assert.throws(() => assertHistoryHoldUnchanged(fingerprint(beforeFixture), fingerprint(afterFixture)), /history expiry wait/);
  });
  await test('fingerprint rejects inconsistent ready surface, revision, session, missing producer keys and allocations', () => {
    const invalid = [f => {f.state.wallpaper.targets[0].visible = false;}, f => {f.config.revision++;},
      f => {f.sample.projection.sessionId = 'wrong';}, f => {delete f.sample.projection.targetKey;},
      f => {f.state.wallpaper.budget.contexts = 2;}, f => {f.sample.debug.stats.tasks = 1;}];
    for (const change of invalid) {const fixture = sampleFixture(); change(fixture); assert.throws(() => fingerprint(fixture));}
  });
  await test('memory samples at 500ms cover both holds and the rest of a 1300000ms journey', () => {
    const rows = Array.from({length: 2601}, (_, index) => memory(index * 500));
    validateOwnedMemoryCoverage(rows, 12345, 1300000);
  });
  await test('memory rejects old 900-second tail, wrong PID, clock disorder and nonfinite times', () => {
    assert.throws(() => validateOwnedMemoryCoverage([memory(0), memory(900000)], 12345, 1300000));
    assert.throws(() => validateOwnedMemoryCoverage([memory(0)], 33333, 1000));
    for (const times of [[0, 0], [1000, 0], [-1, 1300000], [0, Infinity], [0, NaN]])
      assert.throws(() => validateOwnedMemoryCoverage(times.map(memory), 12345, 1300000));
    assert.throws(() => validateOwnedMemoryCoverage([memory(0)], 12345, NaN));
    assert.throws(() => validateOwnedMemoryCoverage([], 12345, 1));
    assert.throws(() => validateOwnedMemoryCoverage(Array.from({length: 3602}, (_, index) => memory(index * 500)), 12345, 1300000));
  });
  await test('whole-journey memory coverage rejects a single final sample with all earlier samples missing', () => {
    assert.throws(() => validateOwnedMemoryCoverage([memory(1300000)], 12345, 1300000),
      undefined, 'tail-only memory stream cannot prove startup or either expiry hold was sampled');
  });
  await test('whole-journey memory coverage rejects a 1299500ms interior sampling gap', () => {
    assert.throws(() => validateOwnedMemoryCoverage([memory(0), memory(500), memory(1300000)], 12345, 1300000),
      undefined, 'first and final timestamps cannot prove memory coverage through both expiry holds');
  });
  await test('pure review never invoked process or browser APIs', () => { assert.equal(forbiddenProcessCalls, 0); assert.equal(forbiddenBrowserCalls, 0); });
  const raw = fs.readFileSync(path.join(root, 'scripts/check-wallpaper-svg-native.js'));
  const report = {schemaVersion: 1, pure: true, nativeRun: false, browserRun: false, processCalls: forbiddenProcessCalls,
    helperFile: 'scripts/check-wallpaper-svg-native.js', helperRawSha256: createHash('sha256').update(raw).digest('hex'),
    passed: results.every(row => row.passed), tests: results.length, failures: results.filter(row => !row.passed).length, results};
  const resultPath = process.argv[2];
  if (resultPath) {
    fs.mkdirSync(path.dirname(path.resolve(resultPath)), {recursive: true});
    fs.writeFileSync(resultPath, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  }
  console.log(JSON.stringify({tests: report.tests, failures: report.failures, passed: report.passed, helperRawSha256: report.helperRawSha256}));
  if (!report.passed) process.exitCode = 1;
}
main().catch(error => {console.error(error.stack); process.exitCode = 1;});
