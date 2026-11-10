// SPDX-License-Identifier: MIT
// Real owned Windows import/preview/Apply journey; this never builds a candidate.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {spawn, execFileSync} = require('node:child_process');
const {isDeepStrictEqual} = require('node:util');
const {performance} = require('node:perf_hooks');
const request = require('./desktop-native-management-client');
const {sources, makePackage, hash, projectionIdentity} = require('./composition-svg-fixture');

const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.HERTZ_SVG_NATIVE_OUTPUT || path.join(root, 'output/svg-native-' + Date.now()));
const binary = process.env.HERTZ_DESKTOP_BIN && path.resolve(process.env.HERTZ_DESKTOP_BIN);
const receiptFile = process.env.HERTZ_DESKTOP_BUILD_RECEIPT && path.resolve(process.env.HERTZ_DESKTOP_BUILD_RECEIPT);
const configDir = path.join(output, 'state'), configFile = path.join(configDir, 'config.json');
const port = Number(process.env.DESKTOP_CDP_PORT || 19768);
const pipe = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
const groupId = 'native-svg';
// Pace the acceptance journey against the unchanged product receipt ledger.
const HISTORY_SOURCE = 'crates/hertz-desktop/src/wallpaper/service.rs';
const HISTORY_CAP = 256, HISTORY_TTL_SECONDS = 600, HISTORY_REQUESTS_PER_WINDOW = 120;
const HISTORY_HOLD_MINIMUM_MS = (HISTORY_TTL_SECONDS + 1) * 1000;
const MEMORY_INTERVAL_MS = 500, MEMORY_MAX_DURATION_SECONDS = 1800;
const zeroKeys = ['targets', 'contexts', 'decoderSlots', 'cpuBytes', 'assetCpuBytes', 'gpuBytes', 'prepareTasks', 'prepareCpuBytes',
  'releasePending', 'sessionReservations', 'reservationRecords', 'resourceAllocations', 'resourceRecords', 'resourceReleasePending'];
const evidence = {schemaVersion: 1, startedAt: new Date().toISOString(), nativeRun: true, checks: [], imports: [], frames: [], errors: [],
  historyCadence: {source: HISTORY_SOURCE, cap: HISTORY_CAP, ttlSeconds: HISTORY_TTL_SECONDS,
    requestThreshold: HISTORY_REQUESTS_PER_WINDOW, minimumHoldMs: HISTORY_HOLD_MINIMUM_MS, holds: []},
  limits: ['Current Windows device and candidate only; other devices and the complete editor remain separate',
    'Controlled page stop; physical OS policy, long duration and weak hardware qualification remain separate']};
let receipt, receiptSha256, child, sampler, samplerExit, samplerStartedMonotonicMs, hostExitedMonotonicMs;
let browser, settings, sequence = 0, historyEpoch = 0, nonce = 0, writable = false, spawnError;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const pages = () => browser?.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed()) || [];
const status = () => request(pipe, {command: 'status'});
const stored = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
const draftRef = draft => ({draftId: draft.draftId, draftRevision: draft.draftRevision});
const targetOf = state => state.wallpaper.targets.find(target => target.groupId === groupId);
const mark = label => {evidence.checks.push(label); console.log('PASS ' + label);};
const p95 = values => {assert(values.length > 0); return values.toSorted((a, b) => a - b)[Math.ceil(values.length * .95) - 1];};

function historyHoldRequired(requestSequence, epoch) {
  assert(Number.isSafeInteger(requestSequence) && Number.isSafeInteger(epoch) && epoch >= 0 && requestSequence >= epoch);
  return requestSequence - epoch >= HISTORY_REQUESTS_PER_WINDOW;
}
async function waitForHistoryExpiry({now, sleep, alive, observe}) {
  const startedMonotonicMs = now(); let elapsedMs = 0, slices = 0, nextObservationMs = 30000;
  while (elapsedMs < HISTORY_HOLD_MINIMUM_MS) {
    assert(alive(), 'owned history-hold child exited; no further cycle may start');
    await sleep(Math.min(1000, HISTORY_HOLD_MINIMUM_MS - elapsedMs)); slices++;
    assert(alive(), 'owned history-hold child exited; no further cycle may start');
    const nextElapsed = now() - startedMonotonicMs;
    assert(Number.isFinite(nextElapsed) && nextElapsed >= elapsedMs, 'history-hold clock must be monotonic');
    elapsedMs = nextElapsed;
    if (elapsedMs >= nextObservationMs) {
      await observe({elapsedMs, remainingMs: Math.max(0, HISTORY_HOLD_MINIMUM_MS - elapsedMs)});
      nextObservationMs = Math.floor(elapsedMs / 30000 + 1) * 30000;
    }
  }
  assert(alive(), 'owned history-hold child exited before the expiry window completed');
  return {startedMonotonicMs, finishedMonotonicMs: startedMonotonicMs + elapsedMs, elapsedMs,
    minimumDurationMs: HISTORY_HOLD_MINIMUM_MS, slices};
}
function waitOwnedChildSlice(ownedChild, durationMs) {
  assert(Number.isFinite(durationMs) && durationMs > 0 && durationMs <= 1000, 'history wait slices are at most 1000ms');
  return new Promise((resolve, reject) => {
    let timer, settled = false;
    const finish = error => {
      if (settled) return; settled = true; clearTimeout(timer);
      ownedChild.removeListener('exit', onExit); ownedChild.removeListener('error', onError);
      if (error) reject(error); else resolve();
    };
    const onExit = () => finish(new Error('Owned host exited during the history hold'));
    const onError = error => finish(error);
    if (ownedChild.exitCode !== null || ownedChild.signalCode !== null) {finish(new Error('Owned history-hold child is already dead')); return;}
    ownedChild.once('exit', onExit); ownedChild.once('error', onError);
    timer = setTimeout(() => finish(), durationMs);
  });
}

async function until(read, label, timeout = 60000, allowExit = false) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (spawnError) throw spawnError;
    if (!allowExit && child && (child.exitCode !== null || child.signalCode !== null)) throw new Error('Owned host exited: ' + label);
    const result = await read(); if (result) return result;
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
}
function verifySources() {
  assert.equal(hash(fs.readFileSync(receiptFile)), receiptSha256, 'actual build receipt changed through native cleanup');
  assert.equal(hash(fs.readFileSync(binary)), receipt.binarySha256, 'candidate changed');
  for (const [file, digest] of Object.entries(receipt.sourceHashes)) {
    const absolute = path.resolve(root, file), relative = path.relative(root, absolute);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'receipt input must stay inside source root');
    assert.equal(hash(fs.readFileSync(absolute)), digest, 'candidate source changed: ' + file);
  }
}
async function preflight() {
  assert.equal(process.platform, 'win32');
  assert(binary && receiptFile, 'Set copied candidate and actual source/build receipt');
  assert(!fs.existsSync(output) || fs.readdirSync(output).length === 0, 'Use a fresh independent output directory');
  assert(Number.isSafeInteger(port) && port >= 1024 && port <= 65535);
  const relative = path.relative(path.join(root, 'target'), binary);
  assert(relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'candidate must be copied outside target');
  const receiptBytes = fs.readFileSync(receiptFile);
  receiptSha256 = hash(receiptBytes); receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.buildSucceeded, true); assert.equal(receipt.sourceBuildBinding, true);
  assert(receipt.features.includes('wallpaper-media-probe'));
  for (const file of ['Cargo.lock', HISTORY_SOURCE, 'crates/hertz-desktop/src/wallpaper/svg_prepare.rs', 'tools/space-stage/src/composition/plan.js',
    'plugin/ui/vendor/stage-runtime.js'])
    assert(receipt.sourceHashes[file], 'Missing required compile/verification input: ' + file);
  verifySources();
  const historySource = fs.readFileSync(path.join(root, HISTORY_SOURCE), 'utf8');
  assert.equal(Number(/const HISTORY_CAP: usize = (\d+);/.exec(historySource)?.[1]), HISTORY_CAP,
    'pacing respects the original bounded history, not an enlarged product cap');
  assert.equal(Number(/const HISTORY_TTL: Duration = Duration::from_secs\((\d+)\);/.exec(historySource)?.[1]), HISTORY_TTL_SECONDS,
    'frozen source retains the original 600-second history contract');
  evidence.historyCadence.sourceSha256 = hash(fs.readFileSync(path.join(root, HISTORY_SOURCE)));
  try {await status(); throw new Error('Existing desktop host; leave it untouched');}
  catch (error) {if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;}
  await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen({host: '127.0.0.1', port, exclusive: true}, () => server.close(error => error ? reject(error) : resolve()));
  });
  fs.mkdirSync(path.join(configDir, 'probe-inputs'), {recursive: true}); writable = true;
  // Reuse the original bounded PID-verified Win32 observer/quit helper verbatim.
  const original = fs.readFileSync(path.join(root, 'scripts/check-wallpaper-font-text-native.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = original.indexOf('const windowInspector = `');
  const end = original.indexOf('\n`;\n', start);
  assert(start >= 0 && end > start, 'Original helper has exactly one supported text boundary');
  fs.writeFileSync(path.join(output, 'windows.ps1'), original.slice(start + 'const windowInspector = `'.length, end)
    .replace(/\\\\/g, '\\'));
  evidence.candidate = {binary, binarySha256: receipt.binarySha256, receiptSha256,
    sourceCount: Object.keys(receipt.sourceHashes).length};
  evidence.runArtifacts = Object.fromEntries(['scripts/check-wallpaper-svg-native.js', 'scripts/check-wallpaper-svg-browser.js',
    'scripts/composition-svg-fixture.js', 'scripts/check-wallpaper-font-text-native.js', 'scripts/desktop-native-management-client.js',
    'scripts/sample-process-memory.ps1', 'scripts/composition-font-fixture.js', 'scripts/check-wallpaper-media-native.js',
    'scripts/main-window-files-dialog-fixture.ps1',
    'plugin/ui/fonts/brand.css', 'plugin/ui/fonts/InstrumentSerif-OFL.txt'].map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
  evidence.runArtifactHash = hash(Buffer.from(JSON.stringify(evidence.runArtifacts)));
}
function windows(mode = 'Read') {
  const args = ['-NoProfile', '-NonInteractive', '-File', path.join(output, 'windows.ps1'), '-OwnerPid', String(child.pid)];
  if (mode === 'Quit') args.push('-Mode', 'Quit', '-PipeName', pipe.split('\\').at(-1));
  return JSON.parse(execFileSync('powershell.exe', args, {encoding: 'utf8', windowsHide: true, timeout: 15000}));
}
async function start() {
  const coast = require('../crates/hertz-wallpaper/contracts/catalog.json').scenes.find(scene => scene.id === 'coast');
  const wallpaper = {enabled: true, audioInput: {kind: 'none'}, batteryPolicy: 'pause', pauseOnFullscreen: false,
    pauseOnMaximized: false, applicationRules: [], groups: [{id: groupId, mode: 'single', displays: [{kind: 'primary'}],
      selection: {kind: 'builtin', sceneId: coast.id, stateVersion: coast.stateVersion,
        params: Object.fromEntries(Object.entries(coast.params).map(([key, definition]) => [key, definition.default]))},
      presentation: {fps: 15, quality: 'low', brightness: 1, motion: 1, fit: 'contain', pointer: false}, properties: {}}]};
  const lyrics = {enabled: false, locked: true, layout: 'double', secondary: 'next', fontFamily: 'Segoe UI', fontSize: 32,
    fontWeight: 600, sungColor: '#ffffff', unsungColor: '#ffffff', outlineColor: '#000000', outlineWidth: 1,
    opacity: 1, width: 550, anchorX: .5, anchorY: .5, monitor: null};
  fs.writeFileSync(configFile, JSON.stringify({schemaVersion: 5, revision: 1, launchAtLogin: false, activeProfile: null,
    profiles: [], unboundDomain: {wallpaper, lyrics}, lastCommit: null}));
  const log = fs.openSync(path.join(output, 'host.log'), 'wx');
  child = spawn(binary, ['--settings'], {cwd: root, windowsHide: true, stdio: ['ignore', log, log], env: {...process.env,
    HERTZ_DESKTOP_CONFIG_DIR: configDir, WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview2'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port}});
  fs.closeSync(log); child.on('error', error => {spawnError = error;}); evidence.pid = child.pid;
  child.once('exit', () => {hostExitedMonotonicMs = performance.now();});
  const samples = fs.openSync(path.join(output, 'owned-host-memory.jsonl'), 'wx');
  sampler = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts/sample-process-memory.ps1'),
    '-TargetProcessId', String(child.pid), '-IntervalMs', String(MEMORY_INTERVAL_MS), '-MaxDurationSeconds', String(MEMORY_MAX_DURATION_SECONDS)],
  {windowsHide: true, stdio: ['ignore', samples, samples]}); fs.closeSync(samples);
  samplerStartedMonotonicMs = performance.now();
  samplerExit = new Promise(resolve => {sampler.once('exit', (code, signal) => resolve({code, signal}));
    sampler.once('error', error => resolve({error: error.message}));});
  await until(async () => {try {return (await fetch('http://127.0.0.1:' + port + '/json/version', {signal: AbortSignal.timeout(1000)})).ok;} catch {return false;}}, 'owned WebView2');
  const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  for (const context of browser.contexts()) {
    const watch = page => page.on('pageerror', error => evidence.errors.push({url: page.url(), message: error.message}));
    context.on('page', watch); context.pages().forEach(watch);
  }
  settings = await until(() => pages().find(page => new URL(page.url()).pathname === '/settings.html'), 'owned settings');
  await settings.waitForSelector('#enabled:enabled');
  return wallpaper;
}
async function api(command, payload = {}, expectedRevision, allowFailure = false) {
  const input = {command, payload, expectedRevision, requestId: 'svg-native-' + (++sequence)};
  const response = await settings.evaluate(async input => {
    try {return await hertzWallpaperSettings.requestManagement(input.command, input.payload, input.requestId, input.expectedRevision);}
    catch (error) {return error.receipt || {ok: false, error: {code: error.code, message: error.message}};}
  }, input);
  fs.appendFileSync(path.join(output, 'requests.jsonl'), JSON.stringify({input, response}) + '\n');
  if (!allowFailure) assert.equal(response.ok, true, command + ': ' + JSON.stringify(response));
  return allowFailure ? response : response.result;
}
async function createDraft(wallpaper) {
  let draft = await api('wallpaper.draft.create', {kind: 'settings'});
  draft = await api('wallpaper.draft.update', {...draftRef(draft), operations: [{kind: 'replaceWallpaper', wallpaper}]});
  return draft;
}
async function applyDraft(draft) {
  const result = await api('wallpaper.apply', draftRef(draft), draft.baseRevision);
  assert.equal(result.saved, true); assert.equal(result.state, 'committed'); assert.equal(stored().revision, result.configRevision);
  return result;
}
async function commit(wallpaper) {return applyDraft(await createDraft(wallpaper));}
async function running(wallpaper) {
  return until(async () => {
    const state = await status(), target = targetOf(state);
    if (target?.applyError) throw new Error(JSON.stringify(target.applyError));
    return target?.firstFrameReady && target.visible && target.session?.frameKind === 'gl'
      && isDeepStrictEqual(target.appliedSelection, wallpaper.groups[0].selection)
      && target.appliedRevision === stored().revision && !target.handoff && !target.candidateLoading && !target.selectionPreparing
      && state.wallpaper.retiringControllers === 0 && state.wallpaper.retirements.length === 0 && state;
  }, 'current native SVG first frame');
}
async function renderer(state, binding = targetOf(state)?.session?.binding) {
  const session = binding.sessionId;
  return until(async () => {
    for (const page of pages().filter(page => new URL(page.url()).pathname === '/wallpaper.html'))
      if (await page.evaluate(id => window.hertzWallpaper?.debug().session?.sessionId === id, session)) return page;
  }, 'current SVG renderer');
}
async function importBytes(name, bytes, page, expectedFailure = false) {
  const input = path.join(configDir, 'probe-inputs', name + '.hwpkg'); fs.writeFileSync(input, bytes, {flag: 'wx'});
  const token = ++nonce, started = performance.now();
  await page.evaluate(({name, nonce}) => window.ipc.postMessage('wallpaper_probe_import ' + JSON.stringify({nonce, action: 'begin', name})), {name, nonce: token});
  await page.waitForFunction(token => !!window.__nativeImportProbes?.[token], token, {timeout: 60000});
  const result = await page.evaluate(token => window.__nativeImportProbes[token], token);
  evidence.imports.push({name, inputSha256: hash(bytes), elapsedMs: performance.now() - started, result});
  assert.equal(result.state, expectedFailure ? 'failed' : 'done', JSON.stringify(result));
  assert.equal(result.prepareTasks, 0); assert.equal(result.prepareCpuBytes, 0);
  const fixtures = path.join(output, 'source-fixtures'); fs.mkdirSync(fixtures, {recursive: true});
  fs.copyFileSync(input, path.join(fixtures, name + '.hwpkg'));
  if (!expectedFailure) {fs.unlinkSync(input); assert.equal(fs.existsSync(input), false);}
  return result;
}
function fileDialog(action = 'read', handle = 0, savePath) {
  const args = ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'scripts/main-window-files-dialog-fixture.ps1'),
    '-OwnerPid', String(child.pid), '-Action', action];
  if (handle) args.push('-Handle', String(handle));
  if (savePath) args.push('-SavePath', savePath);
  return JSON.parse(execFileSync('powershell.exe', args, {encoding: 'utf8', windowsHide: true, timeout: 15000}));
}
async function exportAndReimport(name, packageHash, page) {
  const destination = path.join(output, name + '-export.hwpkg'); assert.equal(fs.existsSync(destination), false);
  const pending = api('wallpaper.export.pick', {packageHash});
  // Attach a rejection handler immediately; an unknown pick is never retried.
  pending.catch(() => {});
  let dialog;
  try {
    dialog = await until(() => fileDialog().find(window => window.visible && window.kind === '#32770'
      && window.controls.some(control => control.kind === 'Edit')), 'owned native export destination', 15000);
    fileDialog('fill', dialog.handle, destination); fileDialog('save', dialog.handle);
    const selected = await pending; assert.match(selected.outputToken, /^[0-9a-f]{32}$/);
    assert.equal(fs.existsSync(destination), false, 'native destination selection does not create a file');
    const started = await api('wallpaper.export.begin', {packageHash, outputToken: selected.outputToken});
    const completed = await until(async () => {
      const job = await api('wallpaper.jobs.get', {jobId: started.jobId});
      if (job.state === 'failed' || job.state === 'cancelled') throw new Error('Export did not commit: ' + JSON.stringify(job));
      return job.state === 'done' && job;
    }, 'original immutable package export');
    const bytes = fs.readFileSync(destination); assert.equal(hash(bytes), packageHash, 'export preserves original full package bytes');
    const reimported = await importBytes(name + '-reimport', bytes, page); assert.equal(reimported.packageHash, packageHash);
    evidence.exports ||= []; evidence.exports.push({name, packageHash, destination, completed, reimported, exportedSha256: hash(bytes)});
  } catch (error) {
    if (dialog) {
      try {if (fileDialog().some(window => window.handle === dialog.handle && window.kind === '#32770')) fileDialog('cancel', dialog.handle);}
      catch (cleanupError) {evidence.errors.push('Owned export dialog cleanup: ' + cleanupError.message);}
    }
    throw error;
  }
}
async function capture(name, state) {
  const page = await renderer(state);
  await page.waitForFunction(() => hertzWallpaper.debug().draws >= 3 && hertzWallpaper.debug().stats?.sceneStats?.ready);
  const data = await page.evaluate(async () => {
    const allocation = window.__hertzWallpaperGlAllocation, projection = await (await fetch(allocation.compositionUrl)).json();
    const files = [];
    for (const asset of projection.resolvedAssets) {
      const bytes = new Uint8Array(await (await fetch(asset.url)).arrayBuffer());
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
      files.push({url: asset.url, bytes: btoa(binary), mime: asset.mime});
    }
    return {projection, allocation, binding: window.__hertzWallpaperBinding, debug: hertzWallpaper.debug(), files};
  });
  assert.equal(data.projection.sessionId, data.debug.session.sessionId); assert.equal(data.projection.generation, data.debug.session.generation);
  assert.equal(data.debug.glBudget.contexts, 1); assert.equal(data.debug.glBudget.error, null); assert.equal(data.debug.error, null);
  for (const asset of data.projection.resolvedAssets.filter(asset => asset.logicalKind === 'vector')) {
    assert.equal(asset.kind, 'image'); assert.equal(asset.representationKind, 'image'); assert.equal(asset.mime, 'image/png');
    assert.equal(asset.adapterId, 'prepared-svg-png'); assert.match(asset.sourceHash, /^[0-9a-f]{64}$/);
    assert.equal(hash(Buffer.from(data.files.find(file => file.url === asset.url).bytes, 'base64')), asset.contentKey.split(':')[1]);
  }
  const directory = path.join(output, 'frames', name); fs.mkdirSync(directory, {recursive: true});
  const closure = data.files.map((file, index) => {
    const bytes = Buffer.from(file.bytes, 'base64'), filename = 'asset-' + index + '.png';
    fs.writeFileSync(path.join(directory, filename), bytes); return {file: filename, url: file.url, mime: file.mime, sha256: hash(bytes), bytes: bytes.length};
  });
  fs.writeFileSync(path.join(directory, 'projection.json'), JSON.stringify(data.projection, null, 2));
  fs.writeFileSync(path.join(directory, 'closure.json'), JSON.stringify(closure, null, 2));
  fs.writeFileSync(path.join(directory, 'uri.txt'), data.allocation.compositionUrl);
  fs.writeFileSync(path.join(directory, 'native-init.js'), 'window.__hertzWallpaperBinding=' + JSON.stringify(data.binding) + ';\nwindow.__hertzWallpaperGlAllocation=' + JSON.stringify(data.allocation) + ';');
  await page.screenshot({path: path.join(directory, 'native.png')});
  const windowStates = windows(); assert(windowStates.some(window => window.pid === child.pid && window.visible));
  const savedArtifacts = Object.fromEntries(['projection.json', 'closure.json', 'native-init.js', 'uri.txt']
    .map(file => [file, hash(fs.readFileSync(path.join(directory, file)))]));
  evidence.frames.push({name, session: data.debug.session, ...projectionIdentity(data.projection), savedArtifacts, debug: data.debug, native: state.wallpaper, windows: windowStates});
  return page;
}
async function framePerformance(page, projection) {
  const sample = await page.evaluate(() => new Promise((resolve, reject) => {
    const values = []; let last = -1;
    const timeout = setTimeout(() => reject(new Error('SVG frame sample did not reach 90 real engine submissions')), 15000);
    const observe = () => {
      const debug = hertzWallpaper.debug(), stats = debug.stats;
      if (debug.error || stats?.error) {clearTimeout(timeout); reject(new Error(debug.error || stats.error)); return;}
      if (stats?.frameCount > last) {
        last = stats.frameCount;
        values.push({at: performance.now(), frameCount: last, cpuUpdateRenderMs: stats.cpuUpdateRenderMs,
          frameIntervalP95: stats.frameIntervalP95, actualFps: stats.actualFps, gpuMs: stats.gpuMs,
          gpuTimingSource: stats.gpuTimingSource, memorySource: stats.memorySource, estimatedBytes: stats.estimatedBytes});
      }
      if (values.length >= 90) {clearTimeout(timeout); resolve({values, final: debug});}
      else requestAnimationFrame(observe);
    };
    requestAnimationFrame(observe);
  }));
  for (const [index, row] of sample.values.entries()) {
    assert(Number.isFinite(row.cpuUpdateRenderMs) && row.cpuUpdateRenderMs >= 0);
    if (index) assert.equal(row.frameCount, sample.values[index - 1].frameCount + 1, 'each sampled CPU duration must correspond to the next consecutive real engine submission');
  }
  const cpuP95Ms = p95(sample.values.map(row => row.cpuUpdateRenderMs));
  const final = sample.final.stats, budgetFps = projection.target.budgetFps;
  assert(Number.isFinite(final.actualFps) && Number.isFinite(final.frameIntervalP95) && budgetFps > 0);
  const result = {...projectionIdentity(projection), target: projection.target,
    session: sample.final.session, values: sample.values, cpuP95Ms, final,
    thresholds: {cpuP95Ms: 4, minimumFps: budgetFps * .9, frameIntervalP95Ms: 1000 / budgetFps * 1.5},
    qualification: '90 observed real engine submissions on the recorded current target; CPU update plus submission, excluding asynchronous GPU completion',
    gaps: ['GPU timing and GPU process RSS are unavailable in the original runtime; absolute CPU/GPU/RSS and cross-device thresholds require the separately frozen P0-06 device baseline']};
  evidence.framePerformance = result;
  assert(cpuP95Ms <= result.thresholds.cpuP95Ms, 'SVG engine update plus submit P95 exceeds the original 4ms threshold');
  assert(final.actualFps >= result.thresholds.minimumFps, 'SVG effective frame rate is below 90% of its recorded scheduling budget');
  assert(final.frameIntervalP95 <= result.thresholds.frameIntervalP95Ms, 'SVG frame interval P95 exceeds 1.5 times its recorded budget interval');
  mark('real SVG engine submission P95 and cadence meet the original thresholds on the recorded target');
}
async function historySnapshot(page) {
  return page.evaluate(async () => {
    const allocation = window.__hertzWallpaperGlAllocation;
    const response = await fetch(allocation.compositionUrl, {cache: 'no-store'});
    if (!response.ok) throw new Error('Original native SVG projection unavailable: ' + response.status);
    return {allocation, projection: await response.json(), binding: window.__hertzWallpaperBinding, debug: hertzWallpaper.debug()};
  });
}
function historyHoldFingerprint(state, sample, config, owner) {
  const target = targetOf(state), debug = sample.debug, stats = debug.stats;
  assert(target?.firstFrameReady && target.visible && target.session?.frameKind === 'gl', 'history hold retains the current successful SVG surface');
  assert(!target.handoff && !target.candidateLoading && !target.selectionPreparing && !target.applyError);
  assert.equal(state.wallpaper.retiringControllers, 0); assert.deepEqual(state.wallpaper.retirements, []);
  assert(Number.isSafeInteger(config.revision)); assert.equal(state.revision, config.revision);
  assert.equal(state.wallpaper.revision, config.revision); assert.equal(target.appliedRevision, config.revision);
  assert.equal(target.desiredRevision, config.revision);
  assert.deepEqual(target.appliedSelection, config.unboundDomain.wallpaper.groups[0].selection);
  assert.deepEqual(target.desiredSelection, target.appliedSelection);
  assert.equal(debug.mounted, true); assert.equal(debug.error, null); assert.equal(debug.scene, 'composition'); assert.equal(debug.backend, 'space');
  assert.equal(stats.state, 'ready'); assert(!stats.error && !stats.retired && !stats.contextLost);
  assert.equal(stats.sceneStats.ready, true); assert.equal(stats.poolPending, 0); assert.equal(stats.tasks, 0);
  assert.equal(debug.session.sessionId, target.session.binding.sessionId); assert.equal(debug.session.generation, target.session.binding.generation);
  assert.equal(sample.projection.sessionId, debug.session.sessionId); assert.equal(sample.projection.generation, debug.session.generation);
  assert.equal(sample.projection.semanticKey, stats.sceneStats.semanticKey); assert.equal(stats.contextId, stats.sceneStats.contextId);
  assert.equal(debug.glBudget.contexts, 1); assert.equal(debug.glBudget.error, null); assert.equal(debug.glBudget.pendingBytes, 0);
  assert.equal(state.wallpaper.budget.contexts, 1);
  assert(Object.values(state.wallpaper.budget).every(value => Number.isSafeInteger(value) && value >= 0), 'history hold has exact native budget facts');
  assert(sample.projection.resolvedAssets.length > 0 && sample.projection.resolvedAssets.every(asset => asset.logicalKind === 'vector'
    && asset.kind === 'image' && asset.adapterId === 'prepared-svg-png'), 'history hold retains the installed prepared SVG assets');
  return {owner, configRevision: config.revision, configWallpaper: config.unboundDomain.wallpaper,
    nativeBinding: target.session.binding, appliedSelection: target.appliedSelection, desiredSelection: target.desiredSelection,
    appliedRevision: target.appliedRevision, desiredRevision: target.desiredRevision, pageBinding: sample.binding,
    pageSession: debug.session, contextId: stats.contextId, allocation: sample.allocation,
    ...projectionIdentity(sample.projection), target: sample.projection.target, resolvedAssets: sample.projection.resolvedAssets,
    nativeBudget: state.wallpaper.budget, glAllocation: target.glAllocation, glBudget: debug.glBudget,
    pool: {entries: stats.poolEntries, pending: stats.poolPending, leases: stats.poolLeases},
    resources: {resources: stats.resources, tasks: stats.tasks, cleanups: stats.cleanups, leases: stats.leases,
      admissionTickets: stats.admissionTickets, allocationTasks: stats.allocationTasks, estimatedBytes: stats.estimatedBytes}};
}
function assertHistoryHoldUnchanged(before, after) {
  assert.deepEqual(after, before, 'history expiry wait preserves exact owned SVG session/config/asset/context/budget identity');
}
function validateOwnedMemoryCoverage(memory, ownedPid, requiredCoverageMs) {
  assert(memory.length > 0 && memory.length <= MEMORY_MAX_DURATION_SECONDS * 1000 / MEMORY_INTERVAL_MS + 1 && memory.every(row => row.pid === ownedPid));
  assert(memory.every((row, index) => Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0
    && (!index || row.elapsedMs > memory[index - 1].elapsedMs)), 'owned memory samples retain their monotonic process clock');
  assert(Number.isFinite(requiredCoverageMs) && requiredCoverageMs > 0);
  assert(memory.at(-1).elapsedMs + 5000 >= requiredCoverageMs, 'owned memory sampler covers the whole journey including both real history expiry holds');
}
async function holdHistoryCadence(wallpaper, completedCycles) {
  const ownedChild = child, ownedSettings = settings, initialSequence = sequence, initialEpoch = historyEpoch;
  const state = await running(wallpaper), page = await renderer(state);
  const alive = () => child === ownedChild && !spawnError && ownedChild.exitCode === null && ownedChild.signalCode === null;
  const requireContinuation = () => {
    assert(alive(), 'original owned host must remain alive throughout history expiry; no restart or mutation is allowed');
    assert.equal(settings, ownedSettings); assert.equal(ownedSettings.isClosed(), false); assert.equal(page.isClosed(), false);
    assert.equal(sequence, initialSequence, 'history hold emits no harness management requests or unknown mutation replay');
    assert.equal(historyEpoch, initialEpoch, 'history epoch advances only after the entire hold is verified');
    assert.equal(evidence.switchCycles.length, completedCycles, 'history hold creates no completed switch cycle');
  };
  const owner = () => ({pid: child.pid, settingsUrl: settings.url(), rendererUrl: page.url()});
  requireContinuation();
  const nativeBefore = await status(); requireContinuation();
  const pageBefore = await historySnapshot(page); requireContinuation();
  const before = historyHoldFingerprint(nativeBefore, pageBefore, stored(), owner());
  assert.deepEqual(before.nativeBinding, targetOf(state).session.binding);
  const record = {afterCompletedCycle: completedCycles, startedAt: new Date().toISOString(), initialSequence, initialEpoch,
    minimumDurationMs: HISTORY_HOLD_MINIMUM_MS, before, observations: []};
  evidence.historyCadence.holds.push(record);
  let previousFrame = {draws: pageBefore.debug.draws, frameCount: pageBefore.debug.stats.frameCount, sceneTime: pageBefore.debug.sceneTime};
  record.beforeFrame = previousFrame;
  const observe = async ({elapsedMs}) => {
    requireContinuation(); const native = await status(); requireContinuation();
    const sample = await historySnapshot(page); requireContinuation();
    const fingerprint = historyHoldFingerprint(native, sample, stored(), owner()); assertHistoryHoldUnchanged(before, fingerprint);
    const frame = {draws: sample.debug.draws, frameCount: sample.debug.stats.frameCount, sceneTime: sample.debug.sceneTime};
    assert(frame.draws > previousFrame.draws && frame.frameCount > previousFrame.frameCount,
      'the same original SVG page and engine must keep submitting frames throughout the hold');
    assert(frame.sceneTime >= previousFrame.sceneTime, 'the original SVG clock must not restart during history expiry');
    record.observations.push({elapsedMs, fingerprint, frame}); previousFrame = frame; requireContinuation();
    console.log('SVG original history TTL hold after cycle ' + completedCycles + ': ' + Math.floor(elapsedMs / 1000) + '/601 seconds; same owned pid ' + ownedChild.pid);
  };
  console.log('SVG original history TTL hold after cycle ' + completedCycles + ': 0/601 seconds; same owned pid ' + ownedChild.pid);
  record.timing = await waitForHistoryExpiry({now: () => performance.now(), sleep: duration => waitOwnedChildSlice(ownedChild, duration), alive, observe});
  await page.waitForFunction(frame => hertzWallpaper.debug().draws > frame.draws && hertzWallpaper.debug().stats?.frameCount > frame.frameCount, previousFrame);
  await observe({elapsedMs: record.timing.elapsedMs}); requireContinuation();
  record.finishedAt = new Date().toISOString(); record.completed = true;
  historyEpoch = sequence; record.nextEpoch = historyEpoch;
}
async function switchAndDrain(wallpaper) {
  const samples = []; evidence.switchCycles = samples;
  for (let cycle = 0; cycle < 50; cycle++) {
    if (historyHoldRequired(sequence, historyEpoch)) await holdHistoryCadence(wallpaper, cycle);
    const cycleSequence = sequence;
    wallpaper.enabled = false; await commit(wallpaper);
    const drained = await until(async () => {const current = await status(); return current.wallpaper.retiringControllers === 0
      && current.wallpaper.retirements.length === 0 && zeroKeys.every(key => current.wallpaper.budget[key] === 0) && current;}, 'SVG switch resources drain');
    await until(() => !pages().some(page => new URL(page.url()).pathname === '/wallpaper.html'), 'SVG switch retired WebView');
    assert.deepEqual(windows(), []);
    const started = performance.now(); wallpaper.enabled = true; const commitResult = await commit(wallpaper), ready = await running(wallpaper);
    const firstFrameMs = performance.now() - started, page = await renderer(ready);
    const observed = await page.evaluate(async () => ({debug: hertzWallpaper.debug(),
      projection: await (await fetch(window.__hertzWallpaperGlAllocation.compositionUrl)).json()}));
    const debug = observed.debug;
    assert.equal(sequence - cycleSequence, 6, 'every actual switch cycle retains all six original management writes');
    assert.equal(debug.session.sessionId, targetOf(ready).session.binding.sessionId);
    assert.equal(debug.glBudget.contexts, 1); assert.equal(debug.glBudget.error, null);
    samples.push({cycle, firstFrameMs, commitResult, session: debug.session, ...projectionIdentity(observed.projection), target: observed.projection.target,
      native: ready.wallpaper.budget, page: debug.glBudget, drained: drained.wallpaper.budget});
    if ((cycle + 1) % 10 === 0) console.log('SVG current native session switch/drain ' + (cycle + 1) + '/50');
  }
  evidence.installedOpen = {samples: samples.map(row => row.firstFrameMs), p95Ms: p95(samples.map(row => row.firstFrameMs)),
    thresholdMs: 3000, qualification: '50 fresh native sessions of the same installed SVG/font package; cached immutable PNG derivatives; includes confirmed Apply and current native first frame; history expiry holds finish before disable and open timing begins'};
  assert(evidence.installedOpen.p95Ms <= evidence.installedOpen.thresholdMs, 'installed SVG composition open-to-first-frame P95 exceeds the original 3s threshold');
  wallpaper.enabled = false; await commit(wallpaper);
  evidence.finalSwitchDrain = await until(async () => {const current = await status(); return current.wallpaper.retiringControllers === 0
    && current.wallpaper.retirements.length === 0 && zeroKeys.every(key => current.wallpaper.budget[key] === 0) && current;}, 'final SVG switch resources drain');
  mark('50 fresh installed SVG sessions meet first-frame P95 and each close returns all native allocations to zero');
}
async function main() {
  await preflight(); const wallpaper = await start(); let state = await running(wallpaper), page = await renderer(state);
  for (const name of ['external', 'animation', 'missingFont']) await importBytes(name, sources[name], page, true);
  mark('invalid/external/animated/missing-font SVG inputs fail through the real import owner');
  const raw = await importBytes('raw-red', sources.red, page);
  const rawWorks = await api('wallpaper.library.list');
  assert.equal(rawWorks.works.length, 1, 'only the valid raw input installs a work');
  const rawWorkKey = rawWorks.works[0].workKey;
  const rawDetail = await api('wallpaper.library.get', {workKey: rawWorkKey});
  const rawSelection = {kind: 'package', workKey: rawWorkKey, packageHash: raw.packageHash};
  assert(rawDetail.versions.some(version => version.packageHash === raw.packageHash));
  wallpaper.groups[0].selection = rawSelection; await commit(wallpaper); state = await running(wallpaper); page = await capture('raw-red', state);
  const rawProjection = JSON.parse(fs.readFileSync(path.join(output, 'frames/raw-red/projection.json')));
  assert(rawProjection.resolvedAssets.some(asset => asset.sourceHash === hash(sources.red)), 'raw original SVG bytes are the fixed source');
  await exportAndReimport('raw', raw.packageHash, page);
  mark('raw SVG retains its installed work and reaches the current native GL first frame');
  const pack = makePackage(), imported = await importBytes('vector-layers', pack.bytes, page);
  assert.equal(imported.packageHash, pack.packageHash); wallpaper.groups[0].selection = pack.selection;
  wallpaper.groups[0].properties = {picture: 'red'};
  const draft = await createDraft(wallpaper), configHash = hash(fs.readFileSync(configFile));
  const lease = await api('wallpaper.preview.acquire', {...draftRef(draft), groupId});
  const preview = await until(async () => {const value = (await status()).wallpaper.mediaPreview;
    if (value?.error) throw new Error('SVG preview failed: ' + JSON.stringify(value));
    return value?.leaseId === lease.leaseId && value.firstFrameReady && !value.preparing && value;}, 'native SVG preview first frame');
  const previewPage = await renderer(state, preview.binding);
  evidence.preview = {native: preview, debug: await previewPage.evaluate(() => hertzWallpaper.debug())};
  assert.equal(hash(fs.readFileSync(configFile)), configHash, 'preview does not save the settings draft');
  await api('wallpaper.preview.release', {leaseId: lease.leaseId});
  await until(async () => {const value = (await status()).wallpaper;
    return !value.previewActive && !value.mediaPreview && !value.retiringControllers && !value.retirements.length && previewPage.isClosed();}, 'native preview release');
  await applyDraft(draft); state = await running(wallpaper); page = await capture('preview-applied', state);
  await capture('pack-red', state);
  mark('original preview lease reaches its own SVG first frame and releases before the same draft is applied');
  for (const [name, picture, fit] of [['pack-blue', 'blue', 'cover'], ['pack-alias', 'red-alias', 'stretch']]) {
    wallpaper.groups[0].properties = {picture}; wallpaper.groups[0].presentation.fit = fit;
    await commit(wallpaper); state = await running(wallpaper); page = await capture(name, state);
  }
  mark('final public vector slots, aliases and consumer sizes use fixed PNGs in each current native session');
  const text = makePackage({text: true}), textImport = await importBytes('font-vector', text.bytes, page);
  assert.equal(textImport.packageHash, text.packageHash); wallpaper.groups[0].selection = text.selection; wallpaper.groups[0].properties = {};
  await commit(wallpaper); state = await running(wallpaper); page = await capture('author-font', state);
  evidence.fontDependencies = (await page.evaluate(async () => (await (await fetch(window.__hertzWallpaperGlAllocation.compositionUrl)).json()).resolvedAssets))
    .flatMap(asset => asset.decodeOptions.svgFontDependencies || []);
  assert(evidence.fontDependencies.length > 0, 'SVG text must bind its exact package font dependency');
  assert.equal(await page.evaluate(() => [...document.fonts].length), 0, 'CPU SVG text uses PNG without a page FontFace');
  mark('exact same-package author TTF is rendered into the fixed SVG PNG and remains in its identity');
  await exportAndReimport('author-font', text.packageHash, page);
  mark('real native destination tokens export raw and same-package SVG/font archives byte-for-byte; both reimport unchanged');
  await page.evaluate(() => hertzWallpaper.stop()); const paused = await page.evaluate(() => hertzWallpaper.debug()); await delay(250);
  const stopped = await page.evaluate(() => hertzWallpaper.debug()); assert.equal(stopped.draws, paused.draws); assert.equal(stopped.sceneTime, paused.sceneTime);
  await page.evaluate(() => hertzWallpaper.start(15)); await page.waitForFunction(draws => hertzWallpaper.debug().draws > draws, paused.draws);
  evidence.pause = {paused, stopped}; mark('original renderer stop/resume preserves the canonical clock');
  wallpaper.enabled = false; await commit(wallpaper);
  evidence.drained = await until(async () => {const current = await status(); return current.wallpaper.retiringControllers === 0
    && current.wallpaper.retirements.length === 0 && zeroKeys.every(key => current.wallpaper.budget[key] === 0) && current;}, 'native resource drain');
  await until(() => !pages().some(page => new URL(page.url()).pathname === '/wallpaper.html'), 'retired SVG WebView'); assert.deepEqual(windows(), []);
  const fontProjection = JSON.parse(fs.readFileSync(path.join(output, 'frames/author-font/projection.json')));
  const chosen = fontProjection.resolvedAssets.find(asset => asset.logicalKind === 'vector' && asset.decodeOptions.svgFontDependencies.length > 0);
  assert(chosen, 'the real text representation has a fixed derived cache');
  const cacheKey = chosen.contentKey.split(':')[0];
  const cacheRoot = path.join(configDir, 'derived', chosen.sourceHash, chosen.decodeOptions.svgAdapterVersion, cacheKey);
  assert(fs.lstatSync(cacheRoot).isDirectory() && !fs.lstatSync(cacheRoot).isSymbolicLink());
  const generations = fs.readdirSync(cacheRoot); assert(generations.length <= 64, 'bounded owned cache fixture');
  const generation = generations.find(name => {
    assert(/^gen-[a-zA-Z0-9-]{1,60}$/.test(name), 'canonical generation path');
    const dir = path.join(cacheRoot, name); assert(fs.lstatSync(dir).isDirectory() && !fs.lstatSync(dir).isSymbolicLink());
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'receipt.json')));
    return receipt.cacheKey === cacheKey && receipt.render.sha256 === chosen.contentKey.split(':')[1];
  });
  assert(generation, 'find the exact currently used and now released PNG generation');
  const damaged = path.join(cacheRoot, generation, 'render.png');
  assert.equal(hash(fs.readFileSync(damaged)), chosen.contentKey.split(':')[1]);
  fs.copyFileSync(damaged, path.join(output, 'original-derived-before-corruption.png'));
  fs.writeFileSync(damaged, Buffer.from('corrupt-owned-derived-verification-fixture'));
  evidence.cacheCorruption = {file: damaged, originalSha256: chosen.contentKey.split(':')[1], corruptedSha256: hash(fs.readFileSync(damaged)), afterNativeDrain: true};
  wallpaper.enabled = true; await commit(wallpaper); state = await running(wallpaper); await capture('reopened', state);
  const rebuilt = JSON.parse(fs.readFileSync(path.join(output, 'frames/reopened/projection.json')));
  assert(rebuilt.resolvedAssets.some(asset => asset.contentKey === chosen.contentKey), 'deterministic PNG rebuilt from the fixed installed package');
  mark('all original allocations drain; a corrupted derived PNG rebuilds from the installed package without the input path');
  const performancePage = await renderer(state);
  await framePerformance(performancePage, rebuilt);
  await switchAndDrain(wallpaper);
}
module.exports = {historyHoldRequired, waitForHistoryExpiry, waitOwnedChildSlice, historyHoldFingerprint, assertHistoryHoldUnchanged, validateOwnedMemoryCoverage};
if (require.main === module) main().catch(error => {evidence.errors.push(error.stack); process.stderr.write(error.stack + '\n'); process.exitCode = 1;}).finally(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    try {evidence.quit = windows('Quit'); await until(() => child.exitCode !== null || child.signalCode !== null, 'owned natural exit', 8000, true);}
    catch (error) {evidence.errors.push('Owned natural cleanup: ' + error.message);}
  }
  if (browser) await browser.close().catch(error => evidence.errors.push('CDP disconnect: ' + error.message));
  if (samplerExit) {
    evidence.memorySamplerExit = await Promise.race([samplerExit, delay(5000).then(() => ({error: 'owned memory sampler did not finish'}))]);
    if (evidence.memorySamplerExit.error || evidence.memorySamplerExit.code !== 0) {
      evidence.errors.push('Owned memory sample: ' + JSON.stringify(evidence.memorySamplerExit));
      if (sampler?.pid && sampler.exitCode === null && sampler.signalCode === null) {
        sampler.kill(); evidence.memorySamplerCleanup = await Promise.race([samplerExit, delay(5000).then(() => ({error: 'owned memory sampler remained alive after cleanup'}))]);
      }
    }
    else {
      try {
        const memory = fs.readFileSync(path.join(output, 'owned-host-memory.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
        const requiredCoverageMs = hostExitedMonotonicMs - samplerStartedMonotonicMs;
        validateOwnedMemoryCoverage(memory, child.pid, requiredCoverageMs);
        evidence.hostMemory = {pid: child.pid, count: memory.length, intervalMs: MEMORY_INTERVAL_MS,
          maxDurationSeconds: MEMORY_MAX_DURATION_SECONDS, requiredCoverageMs, coverageStartupAndExitAllowanceMs: 5000,
          source: 'System.Diagnostics.Process for the owned native host',
          peakWorkingSetBytes: Math.max(...memory.map(row => row.workingSetBytes)), peakPrivateBytes: Math.max(...memory.map(row => row.privateBytes)),
          peakHandles: Math.max(...memory.map(row => row.handles)), first: memory[0], last: memory.at(-1),
          qualification: 'Observed owned-host RSS/private-memory peak during this journey; WebView2/GPU descendants and absolute device thresholds are separate'};
      } catch (error) {evidence.errors.push('Owned memory evidence: ' + error.message);}
    }
    evidence.memorySamplerStopped = !sampler?.pid || sampler.exitCode !== null || sampler.signalCode !== null;
    if (!evidence.memorySamplerStopped) evidence.errors.push('Owned memory sampler helper is still alive');
  }
  if (writable && child) {
    try {
      verifySources();
      for (const [file, sha] of Object.entries(evidence.runArtifacts)) assert.equal(hash(fs.readFileSync(path.join(root, file))), sha, 'run artifact changed through cleanup: ' + file);
      evidence.sourceAfter = true; evidence.runArtifactsAfter = true;
    } catch (error) {evidence.errors.push('Final native binding: ' + error.stack); evidence.sourceAfter = false;}
  }
  evidence.exit = child ? {code: child.exitCode, signal: child.signalCode} : null;
  evidence.finishedAt = new Date().toISOString(); evidence.passed = evidence.sourceAfter === true && evidence.errors.length === 0
    && evidence.exit?.code === 0 && evidence.exit?.signal === null;
  if (!evidence.passed) process.exitCode = 1;
  if (writable) fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({output: writable ? output : null, passed: evidence.passed, checks: evidence.checks.length, errors: evidence.errors}));
});
