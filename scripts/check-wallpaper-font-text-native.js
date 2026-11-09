#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Frozen Windows TTF/text journey through the original import, preview and Apply
// owners. Passive CDP observations never replace native qualification or limits.
// Does not build a candidate or generate a source/build receipt.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn, execFileSync} = require('node:child_process');
const {performance} = require('node:perf_hooks');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {buildZip, FIXTURE_PNG} = require('./check-wallpaper-media-native');
const {loadCompositionFontFixture} = require('./composition-font-fixture');
const nativeRequest = require('./desktop-native-management-client');

const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.HERTZ_FONT_TEXT_NATIVE_OUTPUT ||
  path.join(root, 'output/a04-p2-20261108/font-text/native-journey-' + Date.now()));
const configDir = path.join(output, 'state'), configFile = path.join(configDir, 'config.json');
const binary = process.env.HERTZ_DESKTOP_BIN && path.resolve(process.env.HERTZ_DESKTOP_BIN);
const receiptFile = process.env.HERTZ_DESKTOP_BUILD_RECEIPT && path.resolve(process.env.HERTZ_DESKTOP_BUILD_RECEIPT);
const port = Number(process.env.DESKTOP_CDP_PORT || 19758);
const cycles = Number(process.env.HERTZ_FONT_TEXT_NATIVE_CYCLES || 50);
// Respect the original service's real request-history retention. These are not
// test-speed controls: an accepted Windows hold cannot shorten the 600s TTL.
const HISTORY_CAP = 256, HISTORY_TTL_SECONDS = 600;
const HISTORY_HOLD_MINIMUM_MS = (HISTORY_TTL_SECONDS + 1) * 1000, HISTORY_CYCLES_PER_WINDOW = 20;
const groupId = 'native-font-text';
const pipe = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const zeroBudgetKeys = ['targets', 'desktopFrames', 'contexts', 'decoderSlots', 'previewInstances', 'decodePixelRate',
  'outputPixelRate', 'cpuBytes', 'assetCpuBytes', 'gpuBytes', 'prepareTasks', 'prepareCpuBytes',
  'releasePending', 'sessionReservations', 'reservationRecords', 'resourceAllocations', 'resourceRecords',
  'resourceReleasePending', 'textureUploadBytesPerSecond'];
const requiredSources = ['Cargo.toml', 'Cargo.lock', 'crates/hertz-desktop/Cargo.toml',
  'crates/hertz-desktop/src/app.rs', 'crates/hertz-desktop/src/wallpaper_apply.rs', 'crates/hertz-desktop/src/wallpaper_preview.rs',
  'crates/hertz-desktop/src/wallpaper/font_prepare.rs', 'crates/hertz-desktop/src/wallpaper/decode_probe.rs',
  'crates/hertz-desktop/src/wallpaper/decode_probe_harness.rs', 'crates/hertz-desktop/src/wallpaper/qualification.rs',
  'crates/hertz-desktop/src/wallpaper/jobs.rs', 'crates/hertz-desktop/src/wallpaper/assets.rs',
  'crates/hertz-desktop/src/wallpaper/service.rs',
  'crates/hertz-desktop/src/wallpaper/composition_plan.rs', 'crates/hertz-desktop/src/wallpaper/text_raster.rs',
  'crates/hertz-desktop/src/wallpaper/access.rs', 'crates/hertz-desktop/src/wallpaper/gl_plan.rs',
  'crates/hertz-desktop/src/wallpaper/webresource.rs', 'crates/hertz-desktop/assets/wallpaper-font-probe.js',
  'crates/hertz-desktop/assets/wallpaper-scene.html', 'crates/hertz-desktop/assets/wallpaper-scene.js',
  'crates/hertz-desktop/assets/wallpaper-gl-budget.js', 'plugin/ui/stage-resource-budget.js', 'plugin/ui/vendor/stage-runtime.js',
  'tools/space-stage/src/main.js', 'tools/space-stage/src/render-context.js', 'tools/space-stage/src/scope.js',
  'tools/space-stage/src/composition/plan.js', 'tools/space-stage/src/composition/runtime.js',
  'tools/space-stage/src/composition/nodes.js', 'tools/space-stage/src/resources/pool.js',
  'plugin/ui/fonts/brand.css', 'plugin/ui/fonts/InstrumentSerif-OFL.txt', 'scripts/composition-font-fixture.js',
  'scripts/check-wallpaper-font-text-native.js', 'scripts/check-wallpaper-media-native.js', 'scripts/desktop-native-management-client.js'];
const evidence = {startedAt: new Date().toISOString(), checks: [], launches: [], cycles: [], coverage: {},
  historyCadence: {source: 'crates/hertz-desktop/src/wallpaper/service.rs', cap: HISTORY_CAP, ttlSeconds: HISTORY_TTL_SECONDS,
    maximumCyclesBetweenHolds: HISTORY_CYCLES_PER_WINDOW, minimumHoldMs: HISTORY_HOLD_MINIMUM_MS, holds: []}, limits: [
  'One current Windows/WebView2/GPU device, static licensed TTF subset and original native capabilities only.',
  'Import uses the existing debug wallpaper-media-probe file entry; native file picker and Explorer drag are not covered.',
  'The 100 same-value calls exercise the original page applyComposition(current native URL) entry; native plan diff is covered separately.',
  'Controlled page unmount proves page retirement; completed text/image cycles prove native retirement, not pending FontFace cancellation.',
  'Pending FontFace/stream cancellation, held Close failure, budget rejection before any probe, and long-text P95 are separate required evidence.',
  'OTF, WOFF2, complex shaping/color glyphs, default Chinese/emoji fonts, other devices and long-duration pressure remain unqualified.'
]};
let child, browser, settings, spawnError, sequence = 0, nonce = 0, launchCount = 0, buildReceipt, ownsHost = false;
let reportAllowed = false;
const pageErrors = [], failures = [];
const stored = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
const pages = () => browser ? browser.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed()) : [];
const wallpaperPages = () => pages().filter(page => new URL(page.url()).pathname === '/wallpaper.html');
const status = () => nativeRequest(pipe, {command: 'status'});
const draftRef = draft => ({draftId: draft.draftId, draftRevision: draft.draftRevision});
const mark = label => { evidence.checks.push(label); process.stdout.write('PASS ' + label + '\n'); };
function historyHoldRequired(completedCycles, totalCycles) {
  assert(Number.isSafeInteger(completedCycles) && Number.isSafeInteger(totalCycles)
    && completedCycles >= 0 && totalCycles >= 1 && completedCycles <= totalCycles);
  return completedCycles > 0 && completedCycles < totalCycles && completedCycles % HISTORY_CYCLES_PER_WINDOW === 0;
}
async function waitForHistoryExpiry({now, sleep, alive, progress}) {
  const startedMonotonicMs = now(); let elapsedMs = 0, slices = 0, nextProgressMs = 30000;
  while (elapsedMs < HISTORY_HOLD_MINIMUM_MS) {
    assert(alive(), 'owned history-hold child exited; no further cycle may start');
    const sliceMs = Math.min(1000, HISTORY_HOLD_MINIMUM_MS - elapsedMs);
    await sleep(sliceMs); slices++;
    assert(alive(), 'owned history-hold child exited; no further cycle may start');
    const nextElapsed = now() - startedMonotonicMs;
    assert(Number.isFinite(nextElapsed) && nextElapsed >= elapsedMs, 'history-hold clock must be monotonic');
    elapsedMs = nextElapsed;
    if (elapsedMs >= nextProgressMs) {
      progress({elapsedMs, remainingMs: Math.max(0, HISTORY_HOLD_MINIMUM_MS - elapsedMs)});
      nextProgressMs = Math.floor(elapsedMs / 30000 + 1) * 30000;
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
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (spawnError) throw spawnError;
    if (!allowExit && child && (child.exitCode !== null || child.signalCode !== null)) throw new Error('Owned host exited: ' + label);
    const value = await read(); if (value) return value;
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
}
function sourcePath(file) {
  assert.equal(typeof file, 'string');
  assert(!path.isAbsolute(file) && !file.split(/[\\/]/).includes('..'), 'receipt input must stay in the repository: ' + file);
  const absolute = path.resolve(root, file), relative = path.relative(root, absolute);
  assert(relative && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'receipt input outside root');
  return absolute;
}
function verifyBinding() {
  assert.equal(hash(fs.readFileSync(binary)), buildReceipt.binarySha256, 'frozen candidate binary');
  for (const [file, sha] of Object.entries(buildReceipt.sourceHashes)) {
    assert.match(sha, /^[a-f0-9]{64}$/, 'receipt SHA-256: ' + file);
    assert.equal(hash(fs.readFileSync(sourcePath(file))), sha, 'frozen build input: ' + file);
  }
}
async function preflight() {
  assert.equal(process.platform, 'win32', 'this acceptance requires Windows');
  assert(binary && receiptFile, 'Set copied HERTZ_DESKTOP_BIN and HERTZ_DESKTOP_BUILD_RECEIPT');
  assert(Number.isSafeInteger(port) && port >= 1024 && port <= 65534, 'CDP base port');
  assert(Number.isSafeInteger(cycles) && cycles >= 1 && cycles <= 500, 'HERTZ_FONT_TEXT_NATIVE_CYCLES must be 1..500');
  const targetRelative = path.relative(path.join(root, 'target'), binary);
  assert(targetRelative.startsWith('..' + path.sep) || path.isAbsolute(targetRelative), 'use a copied frozen binary outside target');
  assert(!fs.existsSync(output) || fs.readdirSync(output).length === 0, 'use a new, empty independent output directory');
  buildReceipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  assert.equal(buildReceipt.schemaVersion, 1); assert.equal(buildReceipt.buildSucceeded, true);
  assert.equal(buildReceipt.sourceBuildBinding, true);
  assert(Array.isArray(buildReceipt.features) && buildReceipt.features.includes('wallpaper-media-probe'), 'actual import requires the existing probe feature');
  assert(buildReceipt.sourceHashes && typeof buildReceipt.sourceHashes === 'object' && !Array.isArray(buildReceipt.sourceHashes));
  for (const file of requiredSources) assert(buildReceipt.sourceHashes[file], 'build receipt omits required input: ' + file);
  verifyBinding();
  const historySource = fs.readFileSync(sourcePath(evidence.historyCadence.source), 'utf8');
  assert.equal(Number(/const HISTORY_TTL: Duration = Duration::from_secs\((\d+)\);/.exec(historySource)?.[1]), HISTORY_TTL_SECONDS,
    'frozen source must retain the original 600-second history contract');
  assert.equal(Number(/const HISTORY_CAP: usize = (\d+);/.exec(historySource)?.[1]), HISTORY_CAP,
    'pacing must respect the original bounded history, not an enlarged product cap');
  await protectHostAndPort(port);
  fs.mkdirSync(path.join(configDir, 'probe-inputs'), {recursive: true}); reportAllowed = true;
  fs.copyFileSync(receiptFile, path.join(output, 'build-receipt.json'));
  evidence.binary = {path: binary, sha256: buildReceipt.binarySha256, receiptSha256: hash(fs.readFileSync(receiptFile)),
    sourceCount: Object.keys(buildReceipt.sourceHashes).length, harnessSha256: hash(fs.readFileSync(__filename))};
  fs.writeFileSync(path.join(output, 'windows.ps1'), windowInspector, 'utf8');
}
async function protectHostAndPort(currentPort) {
  try { await status(); throw new Error('Existing desktop host; it remains untouched.'); }
  catch (error) { if (error.beforeConnect !== true || !['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  try {
    const server = await fetch('http://127.0.0.1:' + currentPort + '/json/version', {signal: AbortSignal.timeout(1000)});
    throw new Error('CDP port already has an HTTP listener: ' + server.status);
  } catch (error) {
    if (!(error instanceof TypeError) && error.name !== 'TimeoutError') throw error;
    // A silent listener is also occupied. A timeout cannot authorize attaching.
    if (error.name === 'TimeoutError') throw new Error('CDP port availability was not established');
    if (error.cause?.code !== 'ECONNREFUSED') throw error;
  }
}

// Observe the original objects. Wrappers call exactly the original implementation
// with the original arguments and return its result; no IPC, source or caps change.
function installObservations() {
  const o = window.__fontTextObservation = {canvases: [], fontLoads: 0, fontAdds: 0, fontDeletes: 0,
    measurements: 0, fillTexts: 0, textureUploads: 0, host: null, ledger: null, pixels: null, captureRequested: false};
  const create = document.createElement;
  document.createElement = function(tag, ...args) {
    const value = create.call(this, tag, ...args); if (String(tag).toLowerCase() === 'canvas') o.canvases.push(value); return value;
  };
  for (const [prototype, method, counter] of [[FontFace.prototype, 'load', 'fontLoads'],
    [FontFaceSet.prototype, 'add', 'fontAdds'], [FontFaceSet.prototype, 'delete', 'fontDeletes'],
    [CanvasRenderingContext2D.prototype, 'measureText', 'measurements'], [CanvasRenderingContext2D.prototype, 'fillText', 'fillTexts']]) {
    const original = prototype[method]; prototype[method] = function(...args) { o[counter]++; return original.apply(this, args); };
  }
  function observeGlobal(name, factory, saved) {
    let wrapped;
    Object.defineProperty(window, name, {configurable: true, get: () => wrapped, set: api => {
      wrapped = Object.freeze({...api, [factory]: function(...args) { const result = api[factory](...args); o[saved] = result; return result; }});
    }});
  }
  observeGlobal('StageResourceBudget', 'create', 'ledger');
  let runtime;
  Object.defineProperty(window, 'HertzStageRuntime', {configurable: true, get: () => runtime, set: api => {
    const space = api.SpaceStagePure;
    runtime = Object.freeze({...api, SpaceStagePure: Object.freeze({...space, create: function(...args) {
      const result = space.create(...args); o.host = result; return result;
    }})});
  }});
  const glp = WebGL2RenderingContext.prototype, nativeRead = glp.readPixels, nativeParameter = glp.getParameter;
  for (const method of ['texImage2D', 'texSubImage2D']) {
    const original = glp[method]; glp[method] = function(...args) { o.textureUploads++; return original.apply(this, args); };
  }
  for (const method of ['drawArrays', 'drawElements']) {
    const original = glp[method];
    glp[method] = function(...args) {
      const result = original.apply(this, args);
      if ((o.pixels === null || o.captureRequested) && this.canvas.matches('#host canvas')
          && nativeParameter.call(this, this.FRAMEBUFFER_BINDING) === null) {
        const width = this.drawingBufferWidth, height = this.drawingBufferHeight;
        if (width > 0 && height > 0 && width * height <= 8294400) {
          const pixels = new Uint8Array(width * height * 4); nativeRead.call(this, 0, 0, width, height, this.RGBA, this.UNSIGNED_BYTE, pixels);
          let checksum = 2166136261, brightLeft = 0, brightRight = 0;
          for (let index = 0; index < pixels.length; index++) checksum = Math.imul(checksum ^ pixels[index], 16777619);
          for (let index = 0; index < pixels.length; index += 4) if (pixels[index] > 200 && pixels[index + 1] > 200 && pixels[index + 2] > 200) {
            if ((index / 4) % width < width / 2) brightLeft++; else brightRight++;
          }
          o.pixels = {width, height, rgbaBytes: pixels.length, checksum: checksum >>> 0, brightLeft, brightRight,
            source: 'readPixels after original default-framebuffer draw', capturedAt: performance.now()}; o.captureRequested = false;
        }
      }
      return result;
    };
  }
}
async function start() {
  const currentPort = port + launchCount++;
  assert(currentPort <= 65535); await protectHostAndPort(currentPort); verifyBinding();
  spawnError = null; ownsHost = false;
  const log = fs.openSync(path.join(output, 'host-' + launchCount + '.log'), 'w');
  child = spawn(binary, ['--settings'], {cwd: root, windowsHide: true, stdio: ['ignore', log, log], env: {...process.env,
    HERTZ_DESKTOP_CONFIG_DIR: configDir, WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview2'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + currentPort}});
  fs.closeSync(log); child.on('error', error => {spawnError = error;});
  evidence.launches.push({pid: child.pid, port: currentPort});
  await until(async () => {try {return (await fetch('http://127.0.0.1:' + currentPort + '/json/version', {signal: AbortSignal.timeout(1000)})).ok;} catch {return false;}}, 'owned WebView2 CDP');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + currentPort);
  for (const context of browser.contexts()) {
    await context.addInitScript(installObservations);
    const watch = page => page.on('pageerror', error => pageErrors.push({url: page.url(), message: error.message}));
    context.on('page', watch); context.pages().forEach(watch);
  }
  settings = await until(() => pages().find(page => new URL(page.url()).pathname === '/settings.html'), 'owned settings');
  await settings.waitForSelector('#enabled:enabled');
  evidence.launches.at(-1).browser = browser.version();
}
async function api(command, payload = {}, expectedRevision, allowFailure = false) {
  const input = {command, payload, expectedRevision, requestId: 'font-text-native-' + (++sequence)};
  assert(Buffer.byteLength(JSON.stringify({protocol: 2, ...input}), 'utf8') <= 16384, 'original management request bound');
  const receipt = await settings.evaluate(async input => {
    try {return await hertzWallpaperSettings.requestManagement(input.command, input.payload, input.requestId, input.expectedRevision);}
    catch (error) {return error.receipt || {ok: false, error: {code: error.code, message: error.message}};}
  }, input);
  if (!allowFailure) assert.equal(receipt.ok, true, command + ': ' + JSON.stringify(receipt));
  return allowFailure ? receipt : receipt.result;
}
async function draft(wallpaper) {
  const before = hash(fs.readFileSync(configFile));
  let value = await api('wallpaper.draft.create', {kind: 'settings'});
  value = await api('wallpaper.draft.update', {...draftRef(value), operations: [{kind: 'replaceWallpaper', wallpaper}]});
  assert.equal(hash(fs.readFileSync(configFile)), before, 'draft leaves committed intent unchanged'); return value;
}
async function applyDraft(value) {
  const revision = stored().revision, result = await api('wallpaper.apply', draftRef(value), value.baseRevision);
  assert.equal(result.saved, true); assert.equal(result.state, 'committed');
  assert.equal(result.configRevision, revision + 1); assert.equal(stored().revision, revision + 1); return result;
}
const commit = async wallpaper => applyDraft(await draft(wallpaper));
async function running(selection, revision = stored().revision, frameKind = 'gl') {
  return until(async () => {
    const state = await status(), value = state.wallpaper;
    evidence.lastNativeState = value;
    assert(Array.isArray(value.targets)); const target = value.targets.find(target => target.groupId === groupId);
    if (target?.applyError) throw new Error('Native Apply failed: ' + JSON.stringify(target));
    if (!target?.firstFrameReady || !target.visible || target.session?.frameKind !== frameKind || target.handoff
        || target.candidateLoading || target.selectionPreparing || value.retiringControllers || value.retirements.length) return null;
    assert.deepEqual(target.appliedSelection, selection); assert.equal(target.appliedRevision, revision); assert.equal(target.desiredRevision, revision);
    assert(target.session.binding.sessionId && Number.isSafeInteger(target.session.binding.generation));
    return state;
  }, 'exact current native selection/revision/session first frame');
}
const targetOf = state => state.wallpaper.targets.find(target => target.groupId === groupId);
async function renderer(binding) {
  return until(async () => {
    for (const page of wallpaperPages()) {
      if (await page.evaluate(binding => {
        const session = window.hertzWallpaper?.debug().session;
        return session?.sessionId === binding.sessionId && session.generation === binding.generation;
      }, binding).catch(() => false)) return page;
    }
    return null;
  }, 'owned page bound to exact native session/generation');
}
function windows() {
  assert(ownsHost, 'establish owned process before HWND inspection');
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(output, 'windows.ps1'),
    '-OwnerPid', String(child.pid)], {encoding: 'utf8', windowsHide: true, timeout: 15000}));
}
async function snapshot(page) {
  return page.evaluate(() => {
    const o = window.__fontTextObservation;
    if (!o) throw new Error('Passive observations were not installed before this page');
    return {debug: hertzWallpaper.debug(), host: o.host?.stats(), gl: HertzGlBudget.stats(), ledger: o.ledger?.snapshot(true),
      fonts: Array.from(document.fonts, face => ({family: face.family, status: face.status})),
      canvases: o.canvases.map(canvas => ({width: canvas.width, height: canvas.height, output: canvas.matches('#host canvas')})),
      counters: {fontLoads: o.fontLoads, fontAdds: o.fontAdds, fontDeletes: o.fontDeletes, measurements: o.measurements,
        fillTexts: o.fillTexts, textureUploads: o.textureUploads}, pixels: o.pixels};
  });
}
async function freshOutput(page) {
  const before = await page.evaluate(() => {
    const o = window.__fontTextObservation, pageState = hertzWallpaper.debug();
    if (!o?.host || !pageState.mounted) throw new Error('Current original host is not mounted');
    const host = o.host.stats();
    if (host.state !== 'ready' || !Number.isSafeInteger(host.frameCount)) throw new Error('Original host has no successful ready frame');
    const previous = {capturedAt: o.pixels?.capturedAt ?? -1, frameCount: host.frameCount,
      contextId: host.contextId, pageDraws: pageState.draws};
    o.captureRequested = true;
    // The original same-target resize marks its existing output dirty. Only a
    // subsequent real default-framebuffer draw can satisfy this observation.
    if (o.host.resize(innerWidth, innerHeight) !== true) throw new Error('Original same-target resize failed');
    return previous;
  });
  await page.waitForFunction(previous => {
    const o = window.__fontTextObservation, host = o.host.stats();
    return o.pixels?.capturedAt > previous.capturedAt && host.state === 'ready'
      && host.contextId === previous.contextId && host.frameCount > previous.frameCount
      && hertzWallpaper.debug().draws > previous.pageDraws;
  }, before, {timeout: 10000});
  const sample = await snapshot(page);
  assert(sample.pixels.capturedAt > before.capturedAt, 'current output must have a newly submitted GL pixel observation');
  assert.equal(sample.host.state, 'ready'); assert.equal(sample.host.contextId, before.contextId);
  assert(sample.host.frameCount > before.frameCount, 'the original host must confirm a new successful frame');
  assert(sample.debug.draws > before.pageDraws, 'the original page must confirm the complete frame submission');
  sample.previousCaptureAt = before.capturedAt; sample.previousFrameCount = before.frameCount;
  return sample;
}
async function projected(page) {
  return page.evaluate(async () => {
    const allocation = window.__hertzWallpaperGlAllocation;
    if (!allocation?.composition || !allocation.compositionUrl) throw new Error('No native composition grant');
    const response = await fetch(allocation.compositionUrl, {cache: 'no-store'});
    if (!response.ok) throw new Error('Native projection unavailable: ' + response.status);
    return {allocation, projection: await response.json()};
  });
}
function poolStats(sample) {
  const sources = [sample.host, sample.debug?.stats, sample.debug?.stats?.sceneStats];
  return sources.find(value => ['poolEntries', 'poolPending', 'poolLeases'].every(key => Number.isSafeInteger(value?.[key]))) || null;
}
function historyHoldFingerprint(state, sample, owner) {
  const target = targetOf(state), pool = poolStats(sample);
  assert(target && target.firstFrameReady && target.visible && target.session?.frameKind === 'gl', 'history hold retains the real current text surface');
  assert(!target.handoff && !target.candidateLoading && !target.selectionPreparing && !target.applyError);
  assert.equal(state.wallpaper.retiringControllers, 0); assert.deepEqual(state.wallpaper.retirements, []);
  assert.equal(sample.host.state, 'ready'); assert.equal(sample.debug.error, null); assert.equal(sample.gl.error, null);
  assert.equal(sample.debug.scene, 'composition'); assert.equal(sample.debug.backend, 'space');
  assert.equal(sample.debug.session.sessionId, target.session.binding.sessionId);
  assert.equal(sample.debug.session.generation, target.session.binding.generation);
  assert(pool, 'history hold observes the original pool'); assert.equal(pool.poolPending, 0);
  assert.equal(sample.fonts.length, 1); assert.equal(sample.fonts[0].status, 'loaded');
  assert.deepEqual(sample.ledger.violations, []);
  const nativeBudget = Object.fromEntries(zeroBudgetKeys.map(key => {
    assert(Number.isSafeInteger(state.wallpaper.budget[key]), 'history hold has an exact native budget fact: ' + key);
    return [key, state.wallpaper.budget[key]];
  }));
  return {owner, nativeBinding: target.session.binding, appliedSelection: target.appliedSelection,
    appliedRevision: target.appliedRevision, desiredRevision: target.desiredRevision, contextId: sample.host.contextId,
    fonts: sample.fonts, canvases: sample.canvases, pool: {entries: pool.poolEntries, pending: pool.poolPending, leases: pool.poolLeases},
    pageHeld: sample.ledger.held, nativeBudget, pageCounters: sample.counters,
    gl: {contexts: sample.gl.contexts, bytes: sample.gl.bytes, objects: sample.gl.objects}};
}
function assertHistoryHoldUnchanged(before, after) {
  assert.deepEqual(after, before, 'history expiry wait must preserve exact host/session/font/pool/native budget ownership');
}
function assertOwnedHistoryContinuation(ownedChild, ownedSettings, page) {
  assert.equal(child, ownedChild, 'history continuation retains the same owned process');
  assert(!spawnError, 'owned history process emitted an error');
  assert.equal(ownedChild.exitCode, null, 'owned history process exited; no completion or next mutation is allowed');
  assert.equal(ownedChild.signalCode, null, 'owned history process signaled; no completion or next mutation is allowed');
  assert.equal(settings, ownedSettings, 'history continuation retains the same settings owner');
  assert.equal(ownedSettings.isClosed(), false, 'owned history settings page closed');
  assert.equal(page.isClosed(), false, 'owned history renderer page closed');
}
async function holdHistoryCadence(state, page, completedCycles) {
  const ownedChild = child, ownedSettings = settings, initialSequence = sequence;
  assert.equal(evidence.cycles.length, completedCycles);
  const alive = () => child === ownedChild && !spawnError && ownedChild.exitCode === null && ownedChild.signalCode === null;
  const requireContinuation = () => {
    assertOwnedHistoryContinuation(ownedChild, ownedSettings, page);
    assert.equal(sequence, initialSequence, 'history hold emits no harness management mutations');
    assert.equal(evidence.cycles.length, completedCycles, 'history hold creates no completed replacement cycle');
  };
  requireContinuation();
  const owner = {pid: ownedChild.pid, launch: launchCount, settingsUrl: ownedSettings.url(), rendererUrl: page.url()};
  const nativeBefore = await status(); requireContinuation();
  const pageBefore = await snapshot(page); requireContinuation();
  assert.deepEqual(targetOf(nativeBefore).session.binding, targetOf(state).session.binding);
  const before = historyHoldFingerprint(nativeBefore, pageBefore, owner);
  const record = {afterCompletedCycle: completedCycles, startedAt: new Date().toISOString(), minimumDurationMs: HISTORY_HOLD_MINIMUM_MS,
    before, beforeFrame: {pageDraws: pageBefore.debug.draws, hostFrameCount: pageBefore.host.frameCount, sceneTime: pageBefore.debug.sceneTime}};
  evidence.historyCadence.holds.push(record);
  process.stdout.write('PROGRESS original history TTL hold after cycle ' + completedCycles + ': 0/601 seconds\n');
  record.timing = await waitForHistoryExpiry({now: () => performance.now(), sleep: duration => waitOwnedChildSlice(ownedChild, duration), alive,
    progress: ({elapsedMs}) => process.stdout.write('PROGRESS original history TTL hold after cycle ' + completedCycles + ': '
      + Math.floor(elapsedMs / 1000) + '/601 seconds; same owned pid ' + ownedChild.pid + '\n')});
  requireContinuation();
  const nativeAfter = await status(); requireContinuation();
  const pageAfter = await snapshot(page); requireContinuation();
  const after = historyHoldFingerprint(nativeAfter, pageAfter,
    {pid: child.pid, launch: launchCount, settingsUrl: settings.url(), rendererUrl: page.url()});
  assertHistoryHoldUnchanged(before, after);
  assert(pageAfter.debug.draws >= pageBefore.debug.draws && pageAfter.host.frameCount >= pageBefore.host.frameCount,
    'the original successful frame counters never restart during a history hold');
  record.after = after; record.afterFrame = {pageDraws: pageAfter.debug.draws, hostFrameCount: pageAfter.host.frameCount, sceneTime: pageAfter.debug.sceneTime};
  requireContinuation();
  record.finishedAt = new Date().toISOString(); record.completed = true;
  process.stdout.write('PROGRESS original history TTL hold after cycle ' + completedCycles + ' completed: '
    + record.timing.elapsedMs.toFixed(1) + 'ms; original identity and budgets retained\n');
}
function assertFinalPublicTextOverrides(projection, expectedValues) {
  const final = projection.finalPublicValues;
  assert.equal(final.semanticKey, projection.semanticKey, 'final public facts belong to the exact compiled IR');
  assert.deepEqual(final.values, expectedValues, 'native final text/font public values match every requested override');
  const expectedUses = ['left', 'right'].map(id => {
    const nodeIndex = projection.ir.nodes.findIndex(node => node.id === id);
    assert(nodeIndex >= 0, 'the exact authored text node exists: ' + id);
    return {nodeIndex, effectIndex: null, field: 'fontAsset', usage: 'font', assetId: expectedValues['face-' + id]};
  }).sort((a, b) => a.nodeIndex - b.nodeIndex);
  const actualUses = final.resourceUses.map(value => ({nodeIndex: value.nodeIndex, effectIndex: value.effectIndex,
    field: value.field, usage: value.usage, assetId: value.assetId})).sort((a, b) => a.nodeIndex - b.nodeIndex);
  assert.deepEqual(actualUses, expectedUses, 'native final node/field/asset identities follow the requested aliases');
}
async function textState(page, nativeBinding, fixture, label, saveScreenshot = true) {
  await page.waitForFunction(() => hertzWallpaper.debug().stats?.sceneStats?.ready && hertzWallpaper.debug().draws >= 2);
  const facts = await projected(page), {projection, allocation} = facts;
  assert.equal(projection.sessionId, nativeBinding.sessionId); assert.equal(projection.generation, nativeBinding.generation);
  assert.equal(projection.target.width * projection.target.height, allocation.pixelBudget);
  assert.equal(projection.generation, allocation.generation);
  assert.equal(projection.target.fit, 'contain'); assert.equal(projection.textRasters.length, 1);
  const raster = projection.textRasters[0], fonts = projection.resolvedAssets.filter(asset => asset.kind === 'font');
  assert.equal(fonts.length, 2, 'two exact font aliases remain in the native closure');
  assert.equal(new Set(fonts.map(font => font.contentKey)).size, 1, 'verified byte aliases share font identity');
  for (const font of fonts) {
    assert.equal(font.byteLength, fixture.byteLength); assert.equal(font.fontMetadata.format, 'ttf');
    assert.equal(font.fontMetadata.sfntBytes, fixture.byteLength); assert.equal(font.adapterId, 'prepared-sfnt-font');
    assert.match(font.contentKey, /^[a-f0-9]{64}$/);
    const bytes = await page.evaluate(async url => {const response = await fetch(url); if (!response.ok) throw new Error('Font grant unavailable');
      return Array.from(new Uint8Array(await response.arrayBuffer()));}, font.url);
    assert.equal(hash(Buffer.from(bytes)), fixture.sha256, 'actual authorized font bytes');
  }
  assert.equal(raster.fontContentKey, fonts[0].contentKey); assert.equal(raster.nodeIndices.length, 2);
  assert.match(raster.rasterKey, /^[a-f0-9]{64}$/); assert.equal(raster.adapterId, 'prepared-text-raster');
  assert(raster.adapterVersion, 'use the actual native raster version');
  assert.equal(projection.pageLimits.canvases, 1); assert.deepEqual(allocation.pageLimits, projection.pageLimits);
  const sample = await freshOutput(page);
  assert.equal(sample.debug.backend, 'space'); assert.equal(sample.debug.scene, 'composition'); assert.equal(sample.debug.error, null);
  assert.equal(sample.debug.stats.sceneStats.linearOutputPasses, 1);
  assert.equal(sample.gl.contexts, 1); assert.equal(sample.gl.error, null);
  assert.equal(sample.fonts.length, 1); assert.equal(sample.fonts[0].status, 'loaded');
  assert.equal(sample.counters.fontLoads, 1); assert.equal(sample.ledger.held.canvases, 1);
  assert.equal(sample.ledger.held.gpuContexts, 1); assert.deepEqual(sample.ledger.violations, []);
  const canvases = sample.canvases.filter(canvas => !canvas.output && canvas.width && canvas.height);
  assert.deepEqual(canvases, [{width: raster.widthPx, height: raster.heightPx, output: false}], 'one native-sized shared text canvas');
  assert.equal(sample.pixels.width, projection.target.width); assert.equal(sample.pixels.height, projection.target.height);
  assert(sample.pixels.brightLeft > 20 && sample.pixels.brightRight > 20, 'actual GL output contains both white text nodes');
  const pool = poolStats(sample);
  evidence.coverage.poolObservable = !!pool;
  assert(pool, 'candidate must expose its original RenderContext pool counters');
  assert.equal(pool.poolPending, 0); assert.equal(pool.poolEntries, 2); assert(pool.poolLeases >= 3);
  if (saveScreenshot) await page.screenshot({path: path.join(output, label + '.png')});
  return {facts, sample};
}
async function retirePage(page, label) {
  await page.evaluate(() => hertzWallpaper.unmount());
  const sample = await until(async () => {
    const value = await snapshot(page);
    return value.gl.contexts === 0 && value.gl.objects === 0 && value.gl.pendingBytes === 0
      && value.fonts.length === 0 && value.canvases.every(canvas => canvas.width === 0 && canvas.height === 0)
      && value.ledger.resources === 0 && Object.values(value.ledger.held).every(amount => amount === 0) && value;
  }, 'controlled original page unmount retires font/canvas/GL/ledger');
  assert.equal(sample.gl.error, null); assert.deepEqual(sample.ledger.violations, []);
  const pool = poolStats(sample);
  evidence.coverage.poolObservable = !!pool;
  assert(pool, 'retirement must expose the same original pool counters');
  assert.equal(pool.poolEntries, 0); assert.equal(pool.poolPending, 0); assert.equal(pool.poolLeases, 0);
  evidence[label] = sample; return sample;
}
async function importPackage(page, fixture) {
  const id = ++nonce;
  await page.evaluate(command => window.ipc.postMessage('wallpaper_probe_import ' + JSON.stringify(command)), {nonce: id, action: 'begin', name: fixture.name});
  await page.waitForFunction(id => !!window.__nativeImportProbes?.[id], id, {timeout: 60000});
  const imported = await page.evaluate(id => window.__nativeImportProbes[id], id);
  assert.equal(imported.state, 'done', JSON.stringify(imported)); assert.equal(imported.packageHash, fixture.packageHash);
  for (const field of ['prepareTasks', 'prepareCpuBytes', 'activeStreams']) assert.equal(imported[field], 0, 'import drain: ' + field);
  const detail = await api('wallpaper.library.get', {workKey: fixture.selection.workKey});
  assert(detail.versions.some(version => version.packageHash === fixture.packageHash));
  fs.unlinkSync(fixture.input); assert.equal(fs.existsSync(fixture.input), false);
  return {imported, detail};
}
function createFixtures(font) {
  const text = id => ({id, type: 'text', stateVersion: 1, assets: {fontAsset: id === 'left' ? 'font-a' : 'font-b'},
    properties: {text: 'Hertz', x: id === 'left' ? 80 : 240, y: 90, width: 112, height: 48,
      fontSize: 28, color: '#ffffff', align: 'center', lineHeight: 1.2}});
  const property = (id, nodeId, type, defaultValue, constraints, field) => ({id, type, label: id, default: defaultValue,
    constraints, target: {kind: 'node', nodeId, property: field, component: null}});
  const document = {documentVersion: 1, canvas: {width: 320, height: 180, colorSpace: 'srgb', background: '#151719'},
    nodes: [text('left'), text('right')], timeline: {durationSeconds: 4, loop: true, tracks: []}, bindings: [], effects: []};
  const properties = ['left', 'right'].flatMap(id => [property('caption-' + id, id, 'text', 'Hertz', {maxLength: 4096}, 'text'),
    property('face-' + id, id, 'asset', id === 'left' ? 'font-a' : 'font-b', {kind: 'font', options: ['font-a', 'font-b']}, 'fontAsset')]);
  function pack(name, content, entries, assets, publicProperties, license) {
    const workId = crypto.randomUUID(), manifest = {formatVersion: 1, workId, version: 1, title: name, description: 'Controlled Windows native acceptance fixture',
      content, assets, files: entries.map(([file, bytes, mime]) => ({path: file, bytes: bytes.length, sha256: hash(bytes), mime})),
      properties: publicProperties, permissions: {audioSpectrum: false, pointer: false}, license: {code: 'none', ...license}};
    const archive = buildZip([['manifest.json', Buffer.from(JSON.stringify(manifest))], ...entries.map(([file, bytes]) => [file, bytes])]);
    const input = path.join(configDir, 'probe-inputs', name + '.hwpkg'); fs.writeFileSync(input, archive);
    // Keep the manifest/provenance as evidence, not an external copy of the removed source package.
    fs.writeFileSync(path.join(output, name + '-manifest.json'), JSON.stringify(manifest, null, 2));
    return {name, input, packageHash: hash(archive), selection: {kind: 'package', workKey: 'local-' + workId, packageHash: hash(archive)}};
  }
  return {text: pack('font-text-fixture', {kind: 'composition', document: 'composition.json'},
    [['composition.json', Buffer.from(JSON.stringify(document)), 'application/json'], ['assets/font-a.ttf', font.bytes, font.mime],
      ['assets/font-b.ttf', font.bytes, font.mime], ...font.packageFiles.map(file => [file.file, file.bytes, file.mime])],
    [{id: 'font-a', kind: 'font', source: 'assets/font-a.ttf', variants: []}, {id: 'font-b', kind: 'font', source: 'assets/font-b.ttf', variants: []}],
    properties, font.manifestLicense), image: pack('image-replacement', {kind: 'image', asset: 'background'},
    [['assets/background.png', Buffer.from(FIXTURE_PNG), 'image/png']],
    [{id: 'background', kind: 'image', source: 'assets/background.png', variants: []}], [], {assets: 'CC0-1.0', attribution: ''})};
}
function initialConfig() {
  const coast = require('../crates/hertz-wallpaper/contracts/catalog.json').scenes.find(scene => scene.id === 'coast'); assert(coast);
  const wallpaper = {enabled: true, audioInput: {kind: 'none'}, batteryPolicy: 'pause', pauseOnFullscreen: false,
    pauseOnMaximized: false, applicationRules: [], groups: [{id: groupId, mode: 'single', displays: [{kind: 'primary'}],
      selection: {kind: 'builtin', sceneId: 'coast', stateVersion: coast.stateVersion,
        params: Object.fromEntries(Object.entries(coast.params).map(([key, value]) => [key, value.default]))},
      presentation: {fps: 15, quality: 'low', brightness: 1, motion: 1, fit: 'contain', pointer: false}, properties: {}}]};
  const lyrics = {enabled: false, locked: true, layout: 'double', secondary: 'next', fontFamily: 'Segoe UI', fontSize: 32,
    fontWeight: 600, sungColor: '#ffffff', unsungColor: '#ffffff', outlineColor: '#151719', outlineWidth: 1, opacity: 1,
    width: 550, anchorX: .5, anchorY: .5, monitor: null};
  fs.writeFileSync(configFile, JSON.stringify({schemaVersion: 5, revision: 1, launchAtLogin: false, activeProfile: null,
    profiles: [], unboundDomain: {wallpaper, lyrics}, lastCommit: null})); return wallpaper;
}
async function naturalExit(label) {
  assert(ownsHost, 'never send quit to an unowned host');
  assert(child && Number.isSafeInteger(child.pid) && child.pid > 0 && child.exitCode === null && child.signalCode === null,
    'owned child must still be alive before any quit connection');
  const quitReceipt = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(output, 'windows.ps1'),
    '-OwnerPid', String(child.pid), '-Mode', 'Quit', '-PipeName', pipe.slice('\\\\.\\pipe\\'.length)],
  {encoding: 'utf8', windowsHide: true, timeout: 15000}));
  assert.equal(quitReceipt.serverPid, child.pid, 'quit was written only on the connection to the owned native server');
  await until(() => child.exitCode !== null || child.signalCode !== null, 'owned host natural exit', 20000, true);
  assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null);
  evidence.launches.at(-1).exit = {code: child.exitCode, signal: child.signalCode, kind: label, quitReceipt};
  await browser.close().catch(() => {}); browser = settings = null; ownsHost = false;
}
async function imageBaseline(selection, revision) {
  const state = await running(selection, revision, 'image');
  const page = await renderer(targetOf(state).session.binding);
  assert.equal(await page.evaluate(() => Array.from(document.fonts).filter(face => face.family.startsWith('hertz-')).length), 0);
  const budget = state.wallpaper.budget;
  for (const field of ['contexts', 'decoderSlots', 'prepareTasks', 'prepareCpuBytes', 'releasePending', 'resourceReleasePending'])
    assert.equal(budget[field], 0, 'image baseline: ' + field);
  assert.equal(state.wallpaper.decodeProbe, null);
  return {state, page, budget: Object.fromEntries(zeroBudgetKeys.map(key => [key, budget[key]]))};
}
async function main() {
  await preflight();
  const font = loadCompositionFontFixture();
  assert.throws(() => loadCompositionFontFixture({text: 'Hertz 中'}), /No published .* subset covers/);
  evidence.fixture = {fontSha256: font.sha256, fontBytes: font.byteLength, provenance: font.provenance};
  const fixtures = createFixtures(font); evidence.fixture.packages = fixtures;
  const wallpaper = initialConfig(); await start();
  let state = await running(wallpaper.groups[0].selection), livePage = await renderer(targetOf(state).session.binding);
  ownsHost = true;
  const initialWindows = windows(); assert.equal(initialWindows.length, 1); assert.equal(initialWindows[0].pid, child.pid);
  evidence.initial = {state, windows: initialWindows};
  evidence.imports = {text: await importPackage(livePage, fixtures.text), image: await importPackage(livePage, fixtures.image)};
  const propertyPage = await api('wallpaper.properties.inspect', {selection: fixtures.text.selection, limit: 32, cursor: null});
  assert.equal(propertyPage.nextCursor, null); assert.equal(propertyPage.properties.length, 4);
  for (const id of ['caption-left', 'caption-right']) assert.equal(propertyPage.properties.find(property => property.id === id)?.type, 'text');
  for (const id of ['face-left', 'face-right']) assert.equal(propertyPage.properties.find(property => property.id === id)?.constraints.kind, 'font');
  evidence.properties = propertyPage;
  mark('true licensed TTF/HWPK imports, exact library/public descriptors and removal of both external source packages');

  wallpaper.groups[0].selection = fixtures.text.selection;
  const textDraft = await draft(wallpaper), configHash = hash(fs.readFileSync(configFile));
  const lease = await api('wallpaper.preview.acquire', {...draftRef(textDraft), groupId});
  const preview = await until(async () => {
    const value = (await status()).wallpaper.mediaPreview;
    if (value?.error) throw new Error('Native preview rejected: ' + JSON.stringify(value));
    return value?.leaseId === lease.leaseId && value.firstFrameReady && !value.preparing && value;
  }, 'independent budgeted native preview first frame');
  assert.deepEqual(preview.selection, fixtures.text.selection);
  assert.notEqual(preview.binding.sessionId, targetOf(state).session.binding.sessionId);
  const previewPage = await renderer(preview.binding);
  evidence.preview = {native: preview, ...(await textState(previewPage, preview.binding, font, 'preview'))};
  assert.equal(hash(fs.readFileSync(configFile)), configHash);
  assert.deepEqual(targetOf(await status()).appliedSelection, targetOf(evidence.initial.state).appliedSelection);
  await retirePage(previewPage, 'previewPageRetired');
  await api('wallpaper.preview.release', {leaseId: lease.leaseId});
  await until(async () => {const value = (await status()).wallpaper; return !value.previewActive && !value.mediaPreview
    && !value.retiringControllers && !value.retirements.length && previewPage.isClosed();}, 'preview controller/reader exit');
  assert.equal(hash(fs.readFileSync(configFile)), configHash);
  const applied = await applyDraft(textDraft); state = await running(fixtures.text.selection, applied.configRevision);
  livePage = await renderer(targetOf(state).session.binding);
  const committed = await textState(livePage, targetOf(state).session.binding, font, 'applied');
  assert.notEqual(targetOf(state).session.binding.sessionId, preview.binding.sessionId);
  const physical = windows(); assert.equal(physical.length, 1); assert.equal(physical[0].parentClass, 'WorkerW'); assert.equal(physical[0].visible, true);
  const monitor = targetOf(state).diagnostics.monitor;
  assert.deepEqual(physical[0].rect, {left: monitor.left, top: monitor.top, right: monitor.left + monitor.width, bottom: monitor.top + monitor.height},
    'owned HWND physical bounds match the exact native target monitor');
  evidence.applied = {operation: applied, state, physical, ...committed};
  mark('independent original preview and explicit original draft Apply produce two text nodes on the sole native WorkerW GL surface');

  const sameBefore = await snapshot(livePage);
  assert.equal(await livePage.evaluate(async () => {
    const url = window.__hertzWallpaperGlAllocation.compositionUrl;
    for (let count = 0; count < 100; count++) if (await hertzWallpaper.applyComposition(url) !== true) return false; return true;
  }), true);
  await delay(300); const sameAfter = await snapshot(livePage);
  for (const key of ['fontLoads', 'measurements', 'fillTexts', 'textureUploads']) assert.equal(sameAfter.counters[key], sameBefore.counters[key], 'same-value does no work: ' + key);
  assert.deepEqual(sameAfter.ledger.held, sameBefore.ledger.held); evidence.sameValue = {before: sameBefore, after: sameAfter};
  mark('100 original page same-value requests perform no FontFace load, measurement, fill or texture upload');

  wallpaper.groups[0].properties = {'caption-left': 'Studio', 'caption-right': 'Studio', 'face-left': 'font-b', 'face-right': 'font-a'};
  const changed = await commit(wallpaper); state = await running(fixtures.text.selection, changed.configRevision);
  livePage = await renderer(targetOf(state).session.binding);
  const override = await textState(livePage, targetOf(state).session.binding, font, 'public-overrides');
  assertFinalPublicTextOverrides(override.facts.projection, wallpaper.groups[0].properties);
  assert.equal(override.facts.projection.textRasters[0].fontContentKey, committed.facts.projection.textRasters[0].fontContentKey);
  assert.notEqual(override.facts.projection.textRasters[0].rasterKey, committed.facts.projection.textRasters[0].rasterKey);
  assert.notEqual(override.sample.pixels.checksum, committed.sample.pixels.checksum, 'actual submitted text pixels change');
  evidence.overrides = {operation: changed, state, ...override};
  mark('native final text/font public overrides select exact same-byte aliases and a new shared Studio raster');

  const beforeFailure = hash(fs.readFileSync(configFile)), failedRevision = stored().revision, previousBinding = targetOf(state).session.binding;
  const invalid = structuredClone(wallpaper); invalid.groups[0].properties['caption-left'] = 'Hertz 中';
  const failedDraft = await draft(invalid), failedApply = await api('wallpaper.apply', draftRef(failedDraft), failedDraft.baseRevision, true);
  assert.equal(failedApply.ok, false); assert.equal(failedApply.error.code, 'font_glyph_unavailable', JSON.stringify(failedApply));
  assert.equal(failedApply.error.details?.nodeId, 'left'); assert.equal(hash(fs.readFileSync(configFile)), beforeFailure);
  const kept = await running(fixtures.text.selection, failedRevision);
  assert.deepEqual(targetOf(kept).session.binding, previousBinding, 'rejected glyph does not replace the committed session');
  assert.equal(livePage.isClosed(), false, 'committed GL page survives rejected glyph');
  const afterFailure = await freshOutput(livePage); assert.equal(afterFailure.pixels.checksum, override.sample.pixels.checksum);
  evidence.missingGlyph = {receipt: failedApply, state: kept, before: override.sample.pixels, after: afterFailure.pixels};
  mark('missing final glyph rejects Apply with nodeId, preserves committed config/revision/session and identical fresh GL output');

  await nativeRequest(pipe, {command: 'wallpaper-hide'});
  const hidden = await until(async () => {const value = await status(); return !targetOf(value).visible && value;}, 'native hide');
  await delay(200); const hiddenBefore = await snapshot(livePage); await delay(350); const hiddenAfter = await snapshot(livePage);
  assert.equal(hiddenAfter.debug.draws, hiddenBefore.debug.draws); assert.equal(hiddenAfter.debug.sceneTime, hiddenBefore.debug.sceneTime);
  assert.deepEqual(hiddenAfter.counters, hiddenBefore.counters);
  await nativeRequest(pipe, {command: 'wallpaper-show'}); state = await running(fixtures.text.selection, failedRevision);
  assert.deepEqual(targetOf(state).session.binding, previousBinding);
  await livePage.waitForFunction(previous => hertzWallpaper.debug().draws > previous, hiddenAfter.debug.draws);
  const restoredOutput = await freshOutput(livePage);
  assert.equal(restoredOutput.pixels.checksum, afterFailure.pixels.checksum, 'native show restores the same committed GL output');
  evidence.visibility = {hidden, before: hiddenBefore, after: hiddenAfter, restored: state, restoredOutput};
  mark('actual native hide/show retains the same committed session and hidden time creates no text or GL work');

  const restartConfig = hash(fs.readFileSync(configFile)); await naturalExit('natural quit with installed text selected');
  assert.equal(hash(fs.readFileSync(configFile)), restartConfig); await start();
  state = await running(fixtures.text.selection, failedRevision); livePage = await renderer(targetOf(state).session.binding); ownsHost = true;
  // A restored surface can finish before CDP attaches. Recreate only that owned
  // surface through a real image->text Apply so observations precede its load.
  wallpaper.groups[0].selection = fixtures.image.selection; wallpaper.groups[0].properties = {};
  const toImage = await commit(wallpaper); const baseline = await imageBaseline(fixtures.image.selection, toImage.configRevision);
  wallpaper.groups[0].selection = fixtures.text.selection;
  wallpaper.groups[0].properties = {'caption-left': 'Studio', 'caption-right': 'Studio', 'face-left': 'font-b', 'face-right': 'font-a'};
  const restoredApply = await commit(wallpaper); state = await running(fixtures.text.selection, restoredApply.configRevision);
  livePage = await renderer(targetOf(state).session.binding);
  const reopened = await textState(livePage, targetOf(state).session.binding, font, 'restart-installed-text');
  assert.equal(reopened.facts.projection.textRasters[0].fontContentKey, override.facts.projection.textRasters[0].fontContentKey);
  evidence.restart = {restoredNativeFirstFrame: true, restartConfigSha256: restartConfig, imageBaseline: baseline.state, text: reopened};
  mark('natural host restart restores the installed text selection with both external source HWPK files removed');

  const cycleHost = child, cycleSettings = settings;
  for (let index = 0; index < cycles; index++) {
    assert.equal(child, cycleHost, 'all replacement cycles retain the same second owned process');
    assert.equal(settings, cycleSettings, 'all replacement cycles retain the same settings owner');
    assert.equal(evidence.cycles.length, index, 'only complete real replacement cycles advance the counter');
    if (historyHoldRequired(index, cycles)) await holdHistoryCadence(state, livePage, index);
    const binding = targetOf(state).session.binding, oldPage = livePage;
    wallpaper.groups[0].selection = fixtures.image.selection; wallpaper.groups[0].properties = {};
    assertOwnedHistoryContinuation(cycleHost, cycleSettings, livePage);
    const imageOperation = await commit(wallpaper), image = await imageBaseline(fixtures.image.selection, imageOperation.configRevision);
    await until(() => oldPage.isClosed(), 'replaced text controller closes');
    assert.deepEqual(image.budget, baseline.budget, 'complete native text retirement returns to original image baseline');
    assert.equal(wallpaperPages().length, 1);
    const physicalImage = windows(); assert.equal(physicalImage.length, 1); assert.equal(physicalImage[0].visible, true);
    const item = {index: index + 1, retiredTextBinding: binding, imageBinding: targetOf(image.state).session.binding,
      imageRevision: imageOperation.configRevision, retiredBudget: image.budget};
    evidence.currentCycle = item;
    wallpaper.groups[0].selection = fixtures.text.selection;
    wallpaper.groups[0].properties = {'caption-left': 'Studio', 'caption-right': 'Studio', 'face-left': 'font-b', 'face-right': 'font-a'};
    const operation = await commit(wallpaper); state = await running(fixtures.text.selection, operation.configRevision);
    livePage = await renderer(targetOf(state).session.binding);
    const sample = await textState(livePage, targetOf(state).session.binding, font, 'cycle-' + (index + 1), false);
    assert.equal(sample.facts.projection.textRasters[0].fontContentKey, override.facts.projection.textRasters[0].fontContentKey);
    item.nextTextBinding = targetOf(state).session.binding; item.nextTextRevision = operation.configRevision;
    item.page = {fonts: sample.sample.fonts, counters: sample.sample.counters, ledger: sample.sample.ledger.held,
      pool: poolStats(sample.sample), pixels: sample.sample.pixels};
    assert.notEqual(item.nextTextBinding.sessionId, binding.sessionId);
    evidence.cycles.push(item); evidence.currentCycle = null;
    if ((index + 1) % 5 === 0) process.stdout.write('PROGRESS native text/image retirement ' + (index + 1) + '/' + cycles + '\n');
  }
  evidence.coverage.completedNativeReplacementCycles = cycles;
  mark(cycles + ' real text/image replacement cycles close the old page and restore exact native resource baseline');
  await retirePage(livePage, 'finalPageRetired');
  wallpaper.enabled = false; const disabled = await commit(wallpaper);
  evidence.finalNative = await until(async () => {
    const value = await status(), wall = value.wallpaper;
    return !wall.retiringControllers && !wall.retirements.length && zeroBudgetKeys.every(key => wall.budget[key] === 0) && value;
  }, 'all original native controller/reader/resource reservations drain');
  await until(() => wallpaperPages().length === 0, 'all owned wallpaper pages close'); assert.deepEqual(windows(), []);
  evidence.finalNative.operation = disabled;
  mark('original page unmount and disabled native owner end every font/canvas/pool/GL and native budget allocation');
  await naturalExit('natural quit after all resource drains'); verifyBinding(); assert.deepEqual(pageErrors, []);
  evidence.coverage.sourceBindingVerifiedAfterRun = true;
  if (evidence.coverage.poolObservable !== false) evidence.coverage.poolObservable = true;
  evidence.coverage.fullA04Slice = false;
  evidence.journeyPassed = true;
}

const windowInspector = `param([uint32]$OwnerPid,[ValidateSet('Inspect','Quit')][string]$Mode='Inspect',[string]$PipeName='')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type @'
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public static class FontTextWindows {
 public delegate bool Callback(IntPtr h,IntPtr p);
 [DllImport("user32.dll")]static extern bool EnumWindows(Callback c,IntPtr p);
 [DllImport("user32.dll")]static extern bool EnumChildWindows(IntPtr h,Callback c,IntPtr p);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")]static extern IntPtr GetParent(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")]static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetNamedPipeServerProcessId(IntPtr pipe,out uint pid);
 public static uint PipeServerPid(IntPtr pipe){uint pid;if(!GetNamedPipeServerProcessId(pipe,out pid))throw new System.ComponentModel.Win32Exception();return pid;}
 [StructLayout(LayoutKind.Sequential)]public struct RECT{public int left,top,right,bottom;}
 public class State{public long hwnd,parent;public uint pid;public string parentClass;public bool visible;public RECT rect;}
 public static State[] Read(uint owner){var previousDpi=SetThreadDpiAwarenessContext(new IntPtr(-4));var found=new Dictionary<long,State>();Callback scan=(h,p)=>{
  uint pid;GetWindowThreadProcessId(h,out pid);var title=new StringBuilder(128);GetWindowText(h,title,128);
  if(pid==owner&&title.ToString()=="Hertz wallpaper"){var parent=GetParent(h);var name=new StringBuilder(128);GetClassName(parent,name,128);
   RECT rect;GetWindowRect(h,out rect);found[h.ToInt64()]=new State{hwnd=h.ToInt64(),parent=parent.ToInt64(),pid=pid,
    parentClass=name.ToString(),visible=IsWindowVisible(h),rect=rect};}return true;};
  EnumWindows((h,p)=>{scan(h,p);EnumChildWindows(h,scan,p);return true;},IntPtr.Zero);
  if(previousDpi!=IntPtr.Zero)SetThreadDpiAwarenessContext(previousDpi);
  var result=new State[found.Count];found.Values.CopyTo(result,0);return result;}
}
'@
if($Mode -eq 'Quit'){
 if($OwnerPid -eq 0 -or $PipeName -notmatch '^hertz-desktop-control-[a-zA-Z0-9_-]{0,32}$'){throw 'Invalid owned quit identity'}
 $transactionClock=[Diagnostics.Stopwatch]::StartNew();$timeoutToken=[Threading.CancellationTokenSource]::new();$timeoutToken.CancelAfter(4000)
 function Get-OwnedQuitRemaining{
  $remaining=4000-[int]$transactionClock.ElapsedMilliseconds
  if($remaining -le 0){throw 'Owned quit total transaction deadline'}
  return $remaining
 }
 function Wait-OwnedQuitTask([Threading.Tasks.Task]$operation){
  $remaining=Get-OwnedQuitRemaining
  if(-not $operation.Wait($remaining)){$timeoutToken.Cancel();throw 'Owned quit total transaction deadline'}
  $result=$operation.GetAwaiter().GetResult()
  [void](Get-OwnedQuitRemaining)
  return $result
 }
 $client=[IO.Pipes.NamedPipeClientStream]::new('.',$PipeName,[IO.Pipes.PipeDirection]::InOut,[IO.Pipes.PipeOptions]::Asynchronous)
 try{
  [void](Wait-OwnedQuitTask ($client.ConnectAsync((Get-OwnedQuitRemaining),$timeoutToken.Token)))
  $serverPid=[FontTextWindows]::PipeServerPid($client.SafePipeHandle.DangerousGetHandle())
  if($serverPid -ne $OwnerPid){throw 'Control pipe belongs to another process; no quit bytes were sent'}
  [void](Get-OwnedQuitRemaining)
  $request=[Text.Encoding]::UTF8.GetBytes('{"command":"quit"}')
  [void](Wait-OwnedQuitTask ($client.WriteAsync($request,0,$request.Length,$timeoutToken.Token)))
  [void](Wait-OwnedQuitTask ($client.FlushAsync($timeoutToken.Token)))
  $chunks=[Collections.Generic.List[byte]]::new();$buffer=[byte[]]::new(8192);$reply=$null
  while($null -eq $reply){
   $count=Wait-OwnedQuitTask ($client.ReadAsync($buffer,0,$buffer.Length,$timeoutToken.Token))
   if($count -le 0){throw 'Owned quit ended before complete response'}
   if($chunks.Count+$count -gt 65536){throw 'Owned quit response exceeds original 64 KiB limit'}
   for($index=0;$index -lt $count;$index++){$chunks.Add($buffer[$index])}
   try{$reply=ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString($chunks.ToArray())) -ErrorAction Stop}catch{$reply=$null}
  }
  $resultJson=ConvertTo-Json -Compress -Depth 10 -InputObject @{serverPid=$serverPid;response=$reply}
  [void](Get-OwnedQuitRemaining)
  Write-Output $resultJson
 }finally{$timeoutToken.Cancel();$client.Dispose();$timeoutToken.Dispose()}
}else{ConvertTo-Json -Compress -Depth 5 -InputObject @([FontTextWindows]::Read($OwnerPid))}
`;

main().catch(async error => {
  failures.push(error.stack); process.stderr.write(error.stack + '\n'); process.exitCode = 1;
  if (browser) evidence.failurePages = await Promise.all(pages().map(async page => ({url: page.url(),
    debug: await page.evaluate(() => window.hertzWallpaper?.debug()).catch(error => ({error: error.message}))})));
  if (settings && reportAllowed) await settings.screenshot({path: path.join(output, 'failure.png'), fullPage: true, timeout: 5000}).catch(() => {});
}).finally(async () => {
  if (browser) await browser.close().catch(() => {});
  if (child && child.exitCode === null && child.signalCode === null) {
    try {child.kill(); evidence.failureCleanup = 'terminated only the owned spawned process after a failed journey';}
    catch (error) {failures.push('Owned host cleanup failed: ' + error.message);}
    const end = Date.now() + 5000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < end) await delay(100);
    if (child.exitCode === null && child.signalCode === null) failures.push('Owned process exit not confirmed');
  }
  evidence.finishedAt = new Date().toISOString(); evidence.errors = failures; evidence.pageErrors = pageErrors;
  evidence.passed = evidence.journeyPassed === true && failures.length === 0 && pageErrors.length === 0;
  evidence.sliceComplete = false;
  if (cycles < 50) evidence.limits.push('Only ' + cycles + ' completed replacement cycles; the required 50-cycle evidence remains open.');
  if (evidence.coverage.poolObservable === false) evidence.limits.push('Candidate debug has no original pool counters; pool baseline was not observed.');
  if (!evidence.passed) process.exitCode = 1;
  if (reportAllowed) fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(evidence, null, 2));
  process.stdout.write(JSON.stringify({output: reportAllowed ? output : null, passed: evidence.passed,
    sliceComplete: false, checks: evidence.checks.length, completedCycles: evidence.cycles.length, errors: failures}) + '\n');
});
