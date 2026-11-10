#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Owned Windows SVG cancellation/Read/Close evidence. This never builds a candidate.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {spawn, execFileSync} = require('node:child_process');
const {performance} = require('node:perf_hooks');
const request = require('./desktop-native-management-client');
const {hash} = require('./composition-svg-fixture');

const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.HERTZ_SVG_LIFECYCLE_NATIVE_OUTPUT || path.join(root, 'output/svg-lifecycle-native-' + Date.now()));
const binary = process.env.HERTZ_DESKTOP_BIN && path.resolve(process.env.HERTZ_DESKTOP_BIN);
const receiptFile = process.env.HERTZ_DESKTOP_BUILD_RECEIPT && path.resolve(process.env.HERTZ_DESKTOP_BUILD_RECEIPT);
const port = Number(process.env.DESKTOP_CDP_PORT || 19769);
const configDir = path.join(output, 'state');
const pipe = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const source = (name, body = '<rect width="320" height="180" fill="red"/>') =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><!-- CC0-1.0 original fixture ${name} -->${body}</svg>`);
const fixtures = () => ({before: source('cancel-before'), after: source('cancel-after'),
  held: source('held-native-read-close'), budget: source('workspace-rejection', '<path d="M0 0' + 'L1 1'.repeat(40000) + '"/>')});
const phases = observation => observation.records.map(record => record.phase);
function checkCancelObservation(observation, boundary, calls) {
  assert.equal(observation.boundary, boundary); assert.equal(observation.expired, false);
  assert.equal(observation.released, true); assert.equal(observation.paused, false);
  assert.equal(observation.resvgCalls, calls); assert.equal(observation.resvgReturns, calls);
  assert.equal(observation.pixmapAllocations, calls);
  const order = phases(observation), at = phase => {const index = order.indexOf(phase); assert(index >= 0, phase); return index;};
  assert(at('cancel_requested') < at('raster_test_barrier_release'));
  assert(at('raster_test_barrier_exit') < at('raster_exit'));
  assert(at('raster_exit') < at('workspace_finished')); assert(at('workspace_finished') < at('job_terminal'));
  if (calls) {assert(at('raster_test_barrier_exit') < at('resvg_enter')); assert(at('resvg_enter') < at('resvg_exit'));
    assert(at('resvg_exit') < at('raster_exit'));}
  else assert(!order.includes('resvg_enter'));
  for (const record of observation.records.filter(record => ['cancel_requested', 'resvg_enter', 'resvg_exit', 'raster_exit'].includes(record.phase))) {
    assert.equal(record.prepareTasks, 1); assert.equal(record.prepareCpuBytes, 320 * 1024 * 1024);
  }
  assert.equal(observation.records.find(record => record.phase === 'workspace_finished').prepareCpuBytes, 0);
}
function selfCheck() {
  const inputs = fixtures();
  for (const bytes of Object.values(inputs)) {assert(bytes.length <= 4 * 1024 * 1024); assert.match(hash(bytes), /^[a-f0-9]{64}$/);}
  assert.equal(new Set(Object.values(inputs).map(hash)).size, 4); assert.equal((inputs.budget.toString().match(/L1 1/g) || []).length, 40000);
  // The checker rejects a falsely relabelled PNG qualification delay and missing real call exit.
  const observation = calls => ({boundary: calls ? 'afterCancelCheckBeforeResvg' : 'beforeCancelCheck', expired: false,
    released: true, paused: false, resvgCalls: calls, resvgReturns: calls, pixmapAllocations: calls,
    records: ['raster_test_barrier_enter', 'cancel_requested', 'raster_test_barrier_release', 'raster_test_barrier_exit',
      ...(calls ? ['resvg_enter', 'resvg_exit'] : []), 'raster_exit', 'workspace_finished', 'job_terminal']
      .map(phase => ({phase, prepareTasks: phase === 'job_terminal' ? 0 : 1,
        prepareCpuBytes: ['workspace_finished', 'job_terminal'].includes(phase) ? 0 : 320 * 1024 * 1024}))});
  for (const calls of [0, 1]) checkCancelObservation(observation(calls), observation(calls).boundary, calls);
  const missing = observation(1); missing.records = missing.records.filter(record => record.phase !== 'resvg_exit');
  assert.throws(() => checkCancelObservation(missing, missing.boundary, 1));
  const late = observation(1); late.records.find(record => record.phase === 'cancel_requested').prepareCpuBytes = 0;
  assert.throws(() => checkCancelObservation(late, late.boundary, 1));
  console.log('SVG lifecycle pure fixture/evidence checks passed; no native or browser execution');
}

const evidence = {schemaVersion: 1, nativeRun: true, startedAt: new Date().toISOString(), checks: [], results: [], observations: [], errors: [],
  scope: ['Two exact native raster checkpoint boundaries with explicitly labelled bounded test barriers',
    'Real resvg enter/exit is separately recorded; this does not measure cancellation inside the uninstrumented resvg library',
    'Original PNG qualification held file Read/Close recovery and source preflight with zero raster/probe calls',
    'Current copied Windows debug candidate only; full SVG journey, performance and other devices are separate gates']};
let receipt, receiptSha256, child, browser, wallpaper, settings, baseline, targetBaseline, spawnError, nonce = 0, writable = false;
const pages = () => browser?.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed()) || [];
const status = () => request(pipe, {command: 'status'});
async function until(read, label, timeout = 60000, allowExit = false) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    if (spawnError) throw spawnError;
    if (!allowExit && child && (child.exitCode !== null || child.signalCode !== null)) throw new Error('Owned host exited: ' + label);
    const result = await read(); if (result) return result; await delay(40);
  }
  throw new Error('Timed out: ' + label);
}
function verifySources() {
  assert.equal(hash(fs.readFileSync(receiptFile)), receiptSha256, 'actual build receipt changed through lifecycle cleanup');
  assert.equal(hash(fs.readFileSync(binary)), receipt.binarySha256);
  for (const [file, sha] of Object.entries(receipt.sourceHashes)) {
    const absolute = path.resolve(root, file), relative = path.relative(root, absolute);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'receipt source stays in worktree');
    assert.equal(hash(fs.readFileSync(absolute)), sha, 'candidate source changed: ' + file);
  }
}
async function preflight() {
  assert.equal(process.platform, 'win32');
  assert(binary && receiptFile, 'Set copied candidate and successful actual source/build receipt');
  assert(!fs.existsSync(output) || fs.readdirSync(output).length === 0, 'Use a fresh independent output directory');
  assert(Number.isSafeInteger(port) && port >= 1024 && port <= 65535);
  const targetRelative = path.relative(path.join(root, 'target'), binary);
  assert(targetRelative.startsWith('..' + path.sep) || path.isAbsolute(targetRelative), 'copy the candidate outside target');
  const receiptBytes = fs.readFileSync(receiptFile);
  receiptSha256 = hash(receiptBytes); receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.buildSucceeded, true); assert.equal(receipt.sourceBuildBinding, true);
  assert.equal(receipt.debugAssertions, true); assert.equal(receipt.profile, 'dev'); assert(receipt.features.includes('wallpaper-media-probe'));
  const required = ['Cargo.lock', 'crates/hertz-desktop/src/wallpaper/decode_probe.rs',
    'crates/hertz-desktop/src/wallpaper/decode_probe_harness.rs', 'crates/hertz-desktop/src/wallpaper/svg_prepare.rs',
    'crates/hertz-desktop/src/wallpaper/svg_prepare/render.rs', 'crates/hertz-desktop/assets/wallpaper-probe.js',
    'plugin/ui/vendor/stage-runtime.js'];
  required.forEach(file => assert(receipt.sourceHashes[file], 'missing candidate hook/source binding: ' + file));
  verifySources();
  try {await status(); throw new Error('Existing desktop host; leave it untouched');}
  catch (error) {if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;}
  await new Promise((resolve, reject) => {const server = net.createServer(); server.once('error', reject);
    server.listen({host: '127.0.0.1', port, exclusive: true}, () => server.close(error => error ? reject(error) : resolve()));});
  fs.mkdirSync(path.join(configDir, 'probe-inputs'), {recursive: true}); writable = true;
  // Exact producer from the original accepted harness: bounded observer and PID-verified natural quit.
  const original = fs.readFileSync(path.join(root, 'scripts/check-wallpaper-font-text-native.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = original.indexOf('const windowInspector = `'), end = original.indexOf('\n`;\n', start);
  assert(start >= 0 && end > start); fs.writeFileSync(path.join(output, 'windows.ps1'),
    original.slice(start + 'const windowInspector = `'.length, end).replace(/\\\\/g, '\\'));
  evidence.candidate = {binary, binarySha256: receipt.binarySha256,
    receiptSha256, sourceCount: Object.keys(receipt.sourceHashes).length};
  evidence.runArtifacts = Object.fromEntries(['scripts/check-wallpaper-svg-lifecycle-native.js', 'scripts/composition-svg-fixture.js',
    'scripts/desktop-native-management-client.js', 'scripts/check-wallpaper-font-text-native.js', 'scripts/check-wallpaper-media-native.js',
    'scripts/composition-font-fixture.js'].map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
  evidence.runArtifactHash = hash(Buffer.from(JSON.stringify(evidence.runArtifacts)));
}
function windows(mode = 'Read') {
  const args = ['-NoProfile', '-NonInteractive', '-File', path.join(output, 'windows.ps1'), '-OwnerPid', String(child.pid)];
  if (mode === 'Quit') args.push('-Mode', 'Quit', '-PipeName', pipe.split('\\').at(-1));
  return JSON.parse(execFileSync('powershell.exe', args, {encoding: 'utf8', windowsHide: true, timeout: 15000}));
}
async function start() {
  const coast = require('../crates/hertz-wallpaper/contracts/catalog.json').scenes.find(scene => scene.id === 'coast');
  const config = {schemaVersion: 5, revision: 1, launchAtLogin: false, activeProfile: null, profiles: [], lastCommit: null,
    unboundDomain: {lyrics: {enabled: false, locked: true, layout: 'double', secondary: 'next', fontFamily: 'Segoe UI', fontSize: 32,
      fontWeight: 600, sungColor: '#ffffff', unsungColor: '#ffffff', outlineColor: '#000000', outlineWidth: 1,
      opacity: 1, width: 550, anchorX: .5, anchorY: .5, monitor: null},
    wallpaper: {enabled: true, audioInput: {kind: 'none'}, batteryPolicy: 'pause', pauseOnFullscreen: false, pauseOnMaximized: false,
      applicationRules: [], groups: [{id: 'svg-lifecycle', mode: 'single', displays: [{kind: 'primary'}],
        selection: {kind: 'builtin', sceneId: coast.id, stateVersion: coast.stateVersion,
          params: Object.fromEntries(Object.entries(coast.params).map(([key, definition]) => [key, definition.default]))},
        presentation: {fps: 15, quality: 'low', brightness: 1, motion: 1, fit: 'contain', pointer: false}, properties: {}}]}}};
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config));
  for (const [name, bytes] of Object.entries(fixtures())) {
    fs.writeFileSync(path.join(configDir, 'probe-inputs', name + '.hwpkg'), bytes, {flag: 'wx'});
    (evidence.fixtures ||= {})[name] = {inputHash: hash(bytes), bytes: bytes.length, license: 'CC0-1.0 original geometry'};
  }
  const log = fs.openSync(path.join(output, 'host.log'), 'wx');
  child = spawn(binary, ['--settings'], {cwd: root, windowsHide: true, stdio: ['ignore', log, log], env: {...process.env,
    HERTZ_DESKTOP_CONFIG_DIR: configDir, WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview2'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port}});
  fs.closeSync(log); child.on('error', error => {spawnError = error;}); evidence.pid = child.pid;
  await until(async () => {try {return (await fetch('http://127.0.0.1:' + port + '/json/version', {signal: AbortSignal.timeout(1000)})).ok;} catch {return false;}}, 'owned WebView2');
  const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  settings = await until(() => pages().find(page => new URL(page.url()).pathname === '/settings.html'), 'owned settings');
  await settings.waitForSelector('#enabled:enabled');
  targetBaseline = await until(async () => {const state = await status(), target = state.wallpaper.targets.find(target => target.groupId === 'svg-lifecycle');
    if (target?.applyError) throw new Error(JSON.stringify(target));
    return target?.firstFrameReady && target.visible && !target.handoff && !target.candidateLoading && !target.selectionPreparing
      && state.wallpaper.retiringControllers === 0 && !state.wallpaper.retirements.length && target;}, 'native original first frame');
  wallpaper = await until(async () => {for (const page of pages().filter(page => new URL(page.url()).pathname === '/wallpaper.html'))
    if (await page.evaluate(id => window.hertzWallpaper?.debug().session?.sessionId === id, targetBaseline.session.binding.sessionId)) return page;
    return null;}, 'original renderer matches committed native session');
  await wallpaper.waitForFunction(() => window.hertzWallpaper.debug().draws > 0);
  baseline = (await status()).wallpaper.budget;
  assert.equal(baseline.prepareTasks, 0); assert.equal(baseline.prepareCpuBytes, 0);
  evidence.initial = {target: targetBaseline, budget: baseline, page: await wallpaper.evaluate(() => window.hertzWallpaper.debug()), windows: windows()};
}
async function send(command) {const id = ++nonce;
  await wallpaper.evaluate(command => window.ipc.postMessage('wallpaper_probe_import ' + JSON.stringify(command)), {nonce: id, ...command}); return id;}
async function receive(id) {await wallpaper.waitForFunction(id => !!window.__nativeImportProbes?.[id], id, {timeout: 60000});
  const value = await wallpaper.evaluate(id => window.__nativeImportProbes[id], id); evidence.results.push({nonce: id, value}); return value;}
const run = async command => receive(await send(command));
const pending = id => wallpaper.evaluate(id => !window.__nativeImportProbes?.[id], id);
async function observe(name) {const value = await run({action: 'svg-observe', name}); assert.equal(value.accepted, true);
  assert.equal(value.svgRender.pid, child.pid); assert.equal(value.svgRender.jobId, name); return value;}
async function rejectNext(activeName) {
  const value = await run({action: 'try-begin', name: 'budget'});
  assert.equal(value.error, 'budget_busy'); assert.equal(value.submitted, false);
  assert.equal(value.owner, 'ImportJobs.reserve'); assert.equal(value.activeJob.jobId, activeName);
  return value;
}
async function originalFrame() {
  const state = (await status()).wallpaper, target = state.targets.find(target => target.groupId === 'svg-lifecycle');
  assert.equal(target.session.binding.sessionId, targetBaseline.session.binding.sessionId); assert.equal(target.appliedRevision, targetBaseline.appliedRevision);
  assert.deepEqual(target.appliedSelection, targetBaseline.appliedSelection); assert(target.visible && target.firstFrameReady);
  assert(!target.candidateLoading && !target.selectionPreparing && !target.handoff); assert.equal(state.retiringControllers, 0);
  const page = await wallpaper.evaluate(() => window.hertzWallpaper.debug()); assert.equal(page.session.sessionId, target.session.binding.sessionId);
  assert(page.draws >= evidence.initial.page.draws); return {target, page, budget: state.budget};
}
async function retired(value, expected) {assert.equal(value.state, expected, JSON.stringify(value));
  assert.equal(value.prepareTasks, 0); assert.equal(value.prepareCpuBytes, 0); assert.equal(value.activeStreams, 0);
  assert.equal(value.decoderSlots, baseline.decoderSlots);
  const state = (await status()).wallpaper; assert.equal(state.decodeProbe, null); assert.deepEqual(state.budget, baseline);
  assert.equal(settings.isClosed(), false); assert.equal(child.exitCode, null);}
async function nextSuccess(name, fixture) {
  const bytes = Buffer.from(fixtures()[fixture].toString().replace('</svg>', '<!-- next valid input ' + name + ' --></svg>'));
  const file = path.join(configDir, 'probe-inputs', name + '.hwpkg'); fs.writeFileSync(file, bytes, {flag: 'wx'});
  const value = await run({action: 'begin', name, observeSvg: true}); await retired(value, 'done');
  assert(value.packageHash); assert.equal(value.svgRender.inputHash, hash(bytes));
  assert.equal(value.svgRender.resvgCalls, value.svgRender.resvgReturns); assert(value.svgRender.resvgCalls > 0);
  return {inputHash: hash(bytes), value, frame: await originalFrame()};
}
async function cancellation(name, boundary, calls) {
  const id = await send({action: 'begin', name, observeSvg: true, svgRenderBarrier: boundary});
  const held = await until(async () => {const value = await observe(name); return value.svgRender.paused && value;}, 'exact native raster barrier', 8000);
  assert.equal(held.svgRender.boundary, boundary); assert.equal(held.svgRender.inputHash, evidence.fixtures[name].inputHash);
  assert.equal(held.svgRender.resvgCalls, 0); assert.equal(held.svgRender.pixmapAllocations, calls);
  assert.equal(held.prepareTasks, 1); assert.equal(held.prepareCpuBytes, 320 * 1024 * 1024); assert.equal(held.probeRuns, 0);
  assert.equal((await run({action: 'cancel', name})).cancelRequested, true); assert.equal(await pending(id), true);
  const busy = await rejectNext(name);
  const wrong = await run({action: 'svg-release', name, svgBarrierToken: 'wrong-token'}); assert.equal(wrong.accepted, false);
  const cancelledHeld = await observe(name); assert.equal(cancelledHeld.svgRender.paused, true); assert.equal(cancelledHeld.svgRender.expired, false);
  assert.equal(cancelledHeld.prepareTasks, 1); assert.equal(cancelledHeld.prepareCpuBytes, 320 * 1024 * 1024);
  const frame = await originalFrame();
  assert.equal((await run({action: 'svg-release', name, svgBarrierToken: held.svgRender.barrierToken})).accepted, true);
  const result = await receive(id); await retired(result, 'cancelled'); assert.equal(result.probeRuns, 0);
  checkCancelObservation(result.svgRender, boundary, calls);
  evidence.observations.push({case: name, held, cancelledHeld, busy, frame, result, next: await nextSuccess(name + '-recovered', name)});
  evidence.checks.push('Native ' + boundary + ' cancellation holds the original slot/workspace until exact raster exit and accepts the next input');
}
async function control(page, prefix, command, wait = true) {const id = ++nonce; await page.evaluate(({prefix, command}) =>
  window.ipc.postMessage(prefix + ' ' + JSON.stringify(command)), {prefix, command: {nonce: id, ...command}});
  // Successful Close can destroy its WebView before a JS callback is observable.
  // The native terminal result and closed page are the completion evidence.
  if (!wait) return {nonce: id, ...command, sentFromOwnedProbe: true};
  const property = prefix === 'decode_probe_read' ? '__nativeDecodeReadProbe' : '__nativeDecodeCloseProbe';
  await page.waitForFunction(({property, id}) => window[property]?.nonce === id, {property, id}, {timeout: 3000});
  return page.evaluate(property => window[property], property);}
function readRelease(snapshot) {return {action: 'release', probeId: snapshot.probeId, generation: snapshot.generation, session: snapshot.session,
  nativeRequestId: snapshot.nativeRequestId, nativeControllerId: snapshot.nativeControllerId, streamId: snapshot.streamId, holdToken: snapshot.holdToken};}
async function heldReadClose() {
  const id = await send({action: 'begin', name: 'held', observeSvg: true, forceProbe: true, blockClose: true,
    holdMediaReady: true, holdMediaReadMs: 8000});
  const page = await until(async () => {for (const page of pages().filter(page => new URL(page.url()).pathname === '/wallpaper-probe.html'))
    if (await page.evaluate(() => window.__hertzMediaProbeReadyHeld === true).catch(() => false)) return page; return null;}, 'owned PNG qualifier ready barrier');
  const qualified = await observe('held'); assert.equal(qualified.svgRender.resvgCalls, 2); assert.equal(qualified.svgRender.resvgReturns, 2);
  assert.equal(qualified.prepareCpuBytes, 0, 'render workspace has actually exited before the separate PNG qualifier');
  await page.evaluate(() => window.ipc.postMessage('ready'));
  const readHeld = await until(async () => {const state = (await status()).wallpaper, read = state.decodeProbe?.heldIstreamRead;
    return read?.readInFlight && read.responseAssigned && read.fileHeld && read.readPermitHeld && read.streamSlotHeld && state;}, 'actual original COM file Read entered', 8000);
  const owner = readHeld.decodeProbe.heldIstreamRead; assert.equal(owner.onUiThread, false); assert(owner.nativeRequestId && owner.nativeControllerId && owner.streamId);
  // The original COM hook holds after a positive physical file read, before
  // returning to the assigned reader; it never represents a zero-byte read.
  assert(Number.isSafeInteger(owner.physicalReadBytes) && owner.physicalReadBytes > 0);
  assert(Number.isSafeInteger(owner.requestedBytes) && owner.physicalReadBytes <= owner.requestedBytes);
  assert(Number.isSafeInteger(owner.readOffset) && Number.isSafeInteger(owner.windowBase) && Number.isSafeInteger(owner.windowLen));
  assert(owner.readOffset >= owner.windowBase && owner.readOffset + owner.physicalReadBytes <= owner.windowBase + owner.windowLen);
  assert.equal(owner.holdMs, 8000); assert.notEqual(owner.phase, 'expired');
  assert.equal((await run({action: 'cancel', name: 'held'})).cancelRequested, true);
  const failedClose = await until(async () => {const state = (await status()).wallpaper, probe = state.decodeProbe;
    return probe?.outcome === 'cancelled' && probe.closeError === '0x80004005' && probe.closeAttempts > 1
      && !probe.fileReadersDrained && probe.heldIstreamRead?.readInFlight && state;}, 'Close failure retains the actual active reader', 5000);
  assert.equal(failedClose.budget.prepareTasks, 1); assert.equal(failedClose.decodeProbe.controllerClosed, false);
  assert(failedClose.budget.cpuBytes > baseline.cpuBytes); assert(failedClose.budget.gpuBytes > baseline.gpuBytes);
  assert.equal(failedClose.budget.cpuBytes, readHeld.budget.cpuBytes); assert.equal(failedClose.budget.gpuBytes, readHeld.budget.gpuBytes);
  assert(failedClose.budget.releasePending > baseline.releasePending); assert.equal(await pending(id), true);
  assert.equal(fs.existsSync(path.join(configDir, 'staging/held')), true, 'the original unpublished job retains staging');
  const busy = await rejectNext('held');
  const wrong = await control(page, 'decode_probe_read', {...readRelease(owner), session: 'wrong-session'}); assert.equal(wrong.accepted, false);
  const wrongClose = await control(page, 'decode_probe_close', {probeId: owner.probeId + 1, blocked: false}); assert.equal(wrongClose.accepted, false); assert.equal(wrongClose.blocked, true);
  await wallpaper.evaluate(probeId => window.ipc.postMessage('decode_probe_close ' + JSON.stringify({nonce: 1, probeId, blocked: false})), owner.probeId);
  assert.equal(await wallpaper.evaluate(() => window.__nativeDecodeCloseProbe), undefined, 'the renderer has no other controller authority');
  const frame = await originalFrame();
  assert.equal((await control(page, 'decode_probe_read', readRelease(owner))).accepted, true);
  const drainedCloseHeld = await until(async () => {const state = (await status()).wallpaper, probe = state.decodeProbe;
    return probe?.fileReadersDrained && probe.closeError === '0x80004005' && probe.heldIstreamRead?.readExitedAtMs != null && state;}, 'reader exits while failed Close still owns the slot', 5000);
  assert.equal(drainedCloseHeld.budget.prepareTasks, 1); assert.equal(await pending(id), true);
  assert.equal(drainedCloseHeld.budget.cpuBytes, failedClose.budget.cpuBytes);
  assert.equal(drainedCloseHeld.budget.gpuBytes, failedClose.budget.gpuBytes);
  assert.equal(drainedCloseHeld.decodeProbe.heldIstreamRead.releaseReason, 'Explicit'); assert.equal(page.isClosed(), false);
  const closeRelease = await control(page, 'decode_probe_close', {probeId: owner.probeId, blocked: false}, false);
  const result = await receive(id); await retired(result, 'cancelled'); assert.equal(page.isClosed(), true);
  assert.equal(result.heldIstreamRead.releaseReason, 'Explicit'); assert.equal(result.heldIstreamRead.readInFlight, false);
  assert.equal(result.heldIstreamRead.resourcesReclaimed, true); assert.equal(result.heldIstreamRead.onUiThread, false);
  assert.equal(result.svgRender.resvgCalls, 2); assert.equal(result.svgRender.resvgReturns, 2);
  const log = fs.readFileSync(path.join(configDir, 'desktop.log'), 'utf8').split(/\r?\n/)
    .filter(line => line.includes('probe controller close pending id=' + owner.probeId + ' HRESULT=0x80004005'));
  assert.equal(log.length, 1);
  evidence.observations.push({case: 'held', qualified, readHeld, failedClose, drainedCloseHeld, busy, closeRelease, frame, result, closeLog: log[0], next: await nextSuccess('held-recovered', 'held')});
  evidence.checks.push('Original SVG PNG Read and failed Close retain the reader/slot until explicit native Read and Close recovery, then cancellation exits and the next job succeeds');
}
async function overWorkspace() {
  // Count forwarded calls on the existing owned renderer; no alternate GL or loader is created.
  await wallpaper.evaluate(() => {
    if (window.__svgLifecycleAllocations) throw new Error('allocation observer already armed');
    const counts = {}, restore = [], wrap = (owner, key, label) => {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (!descriptor || typeof descriptor.value !== 'function') return;
      const original = descriptor.value;
      Object.defineProperty(owner, key, {...descriptor, value: function(...args) {
        counts[label] = (counts[label] || 0) + 1; return Reflect.apply(original, this, args);
      }});
      counts[label] = 0; restore.push(() => Object.defineProperty(owner, key, descriptor));
    };
    for (const Constructor of [window.WebGLRenderingContext, window.WebGL2RenderingContext].filter(Boolean))
      for (const key of ['createTexture', 'createBuffer', 'createRenderbuffer', 'createFramebuffer', 'texImage2D', 'texImage3D',
        'texStorage2D', 'texStorage3D', 'bufferData', 'renderbufferStorage', 'renderbufferStorageMultisample'])
        wrap(Constructor.prototype, key, Constructor.name + '.' + key);
    wrap(window, 'createImageBitmap', 'createImageBitmap');
    const image = Object.getOwnPropertyDescriptor(window, 'Image');
    if (image?.value) {
      counts.Image = 0; Object.defineProperty(window, 'Image', {...image, value: new Proxy(image.value, {
        construct(target, args, next) {counts.Image++; return Reflect.construct(target, args, next);},
        apply(target, self, args) {counts.Image++; return Reflect.apply(target, self, args);},
      })}); restore.push(() => Object.defineProperty(window, 'Image', image));
    }
    window.__svgLifecycleAllocations = {take() {restore.reverse().forEach(fn => fn()); delete window.__svgLifecycleAllocations;
      return {calls: {...counts}, observer: 'forwarded allocation calls on the existing owned native renderer'};}};
  });
  let value, pageAllocations;
  try {value = await run({action: 'begin', name: 'budget', observeSvg: true});}
  finally {pageAllocations = await wallpaper.evaluate(() => window.__svgLifecycleAllocations.take());}
  await retired(value, 'failed');
  assert.match(value.error, /probe_budget_exceeded/); assert.match(value.error, /转路径\/曲线工作区/);
  assert.equal(value.probeRuns, 0); assert.equal(value.svgRender.resvgCalls, 0); assert.equal(value.svgRender.resvgReturns, 0);
  assert.equal(value.svgRender.pixmapAllocations, 0); assert(!phases(value.svgRender).includes('raster_exit'));
  assert(Object.keys(pageAllocations.calls).length >= 10, 'real allocation methods were observed');
  for (const [method, calls] of Object.entries(pageAllocations.calls)) assert.equal(calls, 0, 'over-budget input made no page allocation call: ' + method);
  assert(!pages().some(page => new URL(page.url()).pathname === '/wallpaper-probe.html'));
  assert.equal(hash(fs.readFileSync(path.join(configDir, 'probe-inputs/budget.hwpkg'))), evidence.fixtures.budget.inputHash);
  const frame = await originalFrame(); assert.deepEqual(frame.budget, baseline);
  // Original page allocation records stay unchanged, and no native qualifier/raster allocation call occurred.
  for (const key of ['contexts', 'resourceAllocations', 'resourceRecords', 'cpuBytes', 'gpuBytes']) assert.equal(frame.budget[key], baseline[key]);
  evidence.observations.push({case: 'budget', value, pageAllocations,
    nativeAllocationCalls: {rasterPixmap: value.svgRender.pixmapAllocations, resvg: value.svgRender.resvgCalls, pngQualifier: value.probeRuns},
    frame, next: await nextSuccess('budget-recovered', 'before')});
  evidence.checks.push('Accepted bounded source exceeds workspace before any pixmap/resvg/native qualifier call, preserves the current target/frame and accepts the next valid input');
}
async function main() {await preflight(); await start();
  await cancellation('before', 'beforeCancelCheck', 0); await cancellation('after', 'afterCancelCheckBeforeResvg', 1);
  await heldReadClose(); await overWorkspace(); evidence.final = {frame: await originalFrame(), windows: windows()};
}
async function cleanup() {
  // Release only gates belonging to this isolated host. Natural exit remains mandatory.
  if (child && child.exitCode === null && child.signalCode === null && wallpaper && !wallpaper.isClosed()) {
    for (const name of ['before', 'after', 'held']) {
      try {const observed = await observe(name); if (observed.svgRender?.paused)
        await run({action: 'svg-release', name, svgBarrierToken: observed.svgRender.barrierToken});} catch {}
    }
    for (const page of pages().filter(page => new URL(page.url()).pathname === '/wallpaper-probe.html')) {
      try {const probe = (await status()).wallpaper.decodeProbe;
        if (probe?.heldIstreamRead?.readInFlight) await control(page, 'decode_probe_read', readRelease(probe.heldIstreamRead));
        if (probe) await control(page, 'decode_probe_close', {probeId: probe.probeId, blocked: false}, false);} catch {}
    }
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    try {evidence.quit = windows('Quit'); await until(() => child.exitCode !== null || child.signalCode !== null, 'owned natural exit', 8000, true);}
    catch (error) {evidence.errors.push('Owned natural cleanup: ' + error.message);}
  }
  if (browser) await browser.close().catch(error => evidence.errors.push('CDP disconnect: ' + error.message));
  if (writable && child) {
    try {
      verifySources();
      for (const [file, sha] of Object.entries(evidence.runArtifacts)) assert.equal(hash(fs.readFileSync(path.join(root, file))), sha, 'run artifact changed through cleanup: ' + file);
      evidence.sourceAfter = true; evidence.runArtifactsAfter = true;
    } catch (error) {evidence.errors.push('Final lifecycle binding: ' + error.stack); evidence.sourceAfter = false;}
  }
  evidence.exit = child ? {code: child.exitCode, signal: child.signalCode} : null; evidence.finishedAt = new Date().toISOString();
  evidence.passed = evidence.sourceAfter === true && evidence.runArtifactsAfter === true && evidence.errors.length === 0
    && evidence.exit?.code === 0 && evidence.exit?.signal === null;
  if (!evidence.passed) process.exitCode = 1;
  if (writable) fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({output: writable ? output : null, passed: evidence.passed, checks: evidence.checks.length, errors: evidence.errors}));
}
if (process.argv.includes('--check')) selfCheck();
else main().catch(error => {evidence.errors.push(error.stack); process.stderr.write(error.stack + '\n'); process.exitCode = 1;}).finally(cleanup);
