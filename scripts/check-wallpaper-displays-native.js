// SPDX-License-Identifier: MIT
// Isolated WebView2/WorkerW display-group acceptance; never changes OS monitor topology.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const requestManagement = require('./desktop-native-management-client');

const root = path.resolve(__dirname, '..');
const binary = path.resolve(process.env.HERTZ_DESKTOP_BIN || path.join(root, 'target/debug/hertz-desktop.exe'));
const output = path.join(root, 'output/playwright/wallpaper-displays-native-' + Date.now());
const configFile = path.join(output, 'config.json');
const pipe = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
const port = Number(process.env.DESKTOP_CDP_PORT || 19558);
const runId = 'displays-' + Date.now() + '-';
const primaryGroup = 'native-primary', secondaryGroup = 'native-secondary';
const offlineDisplayId = 'native-check-offline-' + crypto.randomUUID();
const checks = [], pageErrors = [], receipts = [], evidence = [];
const hardware = { monitorCount: null, monitors: [], simultaneousFirstFrames: 'not-run', spanUnion: 'not-run' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stored = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
const domain = config => config.activeProfile
  ? config.profiles.find(entry => JSON.stringify(entry.profile) === JSON.stringify(config.activeProfile))
  : config.unboundDomain;
const reference = draft => ({ draftId: draft.draftId, draftRevision: draft.draftRevision });
let child, browser, settings, spawnError, sequence = 0;

async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error('Owned desktop exited during ' + label);
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
}

function envelope(command, payload = {}, expectedRevision, requestId = runId + (++sequence)) {
  return { protocol: 2, requestId, command, payload, ...(expectedRevision == null ? {} : { expectedRevision }) };
}

async function inPage(request) {
  return settings.evaluate(async request => {
    try {
      return await window.hertzWallpaperSettings.requestManagement(request.command, request.payload, request.requestId, request.expectedRevision);
    } catch (error) {
      return error.receipt || { ok: false, error: { code: error.code, message: error.message } };
    }
  }, request);
}

const api = (command, payload, expectedRevision) => inPage(envelope(command, payload, expectedRevision));
// Only failed connections are retried: a connected request with an uncertain result is never replayed here.
async function native(request) {
  for (let attempt = 0; ; attempt++) {
    try { return await requestManagement(pipe, request); }
    catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code) || attempt >= 20) throw error;
      await delay(50);
    }
  }
}
const status = () => native({ command: 'status' });
const pages = () => browser.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed());
function ok(receipt, label) {
  assert.equal(receipt.ok, true, label + ': ' + JSON.stringify(receipt));
  return receipt.result;
}
function mark(message) { checks.push(message); console.log('PASS ' + message); }
function snapshot(name, value) {
  fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(value, null, 2));
  evidence.push(name + '.json');
}

async function start() {
  let occupied = false;
  try { occupied = (await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1000) })).ok; }
  catch { /* an unused CDP port is expected */ }
  assert.equal(occupied, false, 'DESKTOP_CDP_PORT must not belong to an existing browser');
  const log = fs.openSync(path.join(output, 'host.log'), 'a');
  try {
    child = spawn(binary, ['--settings'], { cwd: root, windowsHide: true, stdio: ['ignore', log, log], env: {
      ...process.env, HERTZ_DESKTOP_CONFIG_DIR: output,
      WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview2'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
    } });
    child.once('error', error => { spawnError = error; });
  } finally { fs.closeSync(log); }
  await until(async () => {
    try { return (await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(2000) })).ok; }
    catch { return false; }
  }, 'native CDP startup');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  const watch = page => page.on('pageerror', error => pageErrors.push({ url: page.url(), message: error.message }));
  for (const context of browser.contexts()) {
    context.on('page', watch);
    context.pages().forEach(watch);
  }
  settings = await until(() => pages().find(page => page.url().includes('/settings.html')), 'settings page');
  await settings.waitForSelector('#enabled:enabled');
  await settings.evaluate(() => {
    const original = window.hertzWallpaperSettings.applyStatus;
    window.hertzWallpaperSettings.applyStatus = function (payload) {
      window.__displayNativeSnapshot = payload;
      return original.apply(this, arguments);
    };
  });
}

async function stop() {
  // Terminate only the process launched by this script. Never send a global pipe quit.
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    const deadline = Date.now() + 5000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(100);
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'owned desktop process exits');
  }
  if (browser) await browser.close().catch(() => {});
  browser = settings = child = null;
}

async function settingsSnapshot() {
  await settings.evaluate(() => {
    window.__displayNativeSnapshot = null;
    window.ipc.postMessage(JSON.stringify({ cmd: 'status' }));
  });
  await settings.waitForFunction(() => !!window.__displayNativeSnapshot);
  return settings.evaluate(() => window.__displayNativeSnapshot);
}

function group(id, display, sceneId, params = {}) {
  return { id, mode: 'single', displays: [display], selection: { kind: 'builtin', sceneId, stateVersion: 1, params },
    presentation: { fps: 15, quality: 'low', brightness: 1, motion: 1, fit: 'cover', pointer: false }, properties: {} };
}

async function draftFor(wallpaper, lyrics) {
  const before = fs.readFileSync(configFile, 'utf8');
  const created = ok(await api('wallpaper.draft.create', { kind: 'settings' }), 'create settings draft');
  assert.equal(created.baseRevision, stored().revision);
  const operations = [];
  if (wallpaper) operations.push({ kind: 'replaceWallpaper', wallpaper });
  if (lyrics) operations.push({ kind: 'replaceLyrics', lyrics });
  const draft = ok(await api('wallpaper.draft.update', { ...reference(created), operations }), 'update complete settings draft');
  assert.equal(fs.readFileSync(configFile, 'utf8'), before, 'draft editing leaves saved configuration unchanged');
  return draft;
}

function operationReceipt(receipt, requestId) {
  if (!receipt.ok) return receipt;
  const result = receipt.result;
  return result && result.protocol === 2 ? result : { ...receipt, requestId };
}

async function applyDraft(draft, label) {
  const request = envelope('wallpaper.apply', reference(draft), draft.baseRevision);
  let receipt = await inPage(request);
  if (!receipt.ok && ['receipt_timeout', 'operation_pending', 'query_timeout'].includes(receipt.error.code)) {
    receipt = await until(async () => {
      const queried = await native(envelope('wallpaper.operations.get', { requestId: request.requestId, command: 'wallpaper.apply' }));
      if (!queried.ok && ['operation_pending', 'query_timeout', 'config_busy', 'budget_busy'].includes(queried.error.code)) return null;
      const recovered = operationReceipt(queried, request.requestId);
      return recovered.ok && recovered.result?.state === 'pending' ? null : recovered;
    }, 'terminal receipt for original ' + label + ' request', 65000);
  }
  receipts.push({ label, request, receipt });
  return { request, receipt };
}

async function commit(wallpaper, lyrics, label) {
  const baseRevision = stored().revision;
  const draft = await draftFor(wallpaper, lyrics);
  const applied = await applyDraft(draft, label);
  const operation = ok(applied.receipt, label);
  assert.equal(operation.saved, true, label + ' saved');
  assert.equal(operation.state, 'committed');
  assert.equal(operation.baseRevision, baseRevision);
  assert.equal(operation.configRevision, baseRevision + 1, label + ' commits one revision for the complete intent');
  assert.equal(stored().revision, baseRevision + 1);
  return applied;
}

function targets(state) {
  assert.ok(Array.isArray(state.wallpaper?.targets), 'native status exposes wallpaper.targets');
  return state.wallpaper.targets;
}
function binding(target) {
  assert.ok(target.session?.binding?.sessionId && Number.isSafeInteger(target.session.binding.generation), 'target has a native session binding');
  return target.session.binding;
}
function identity(target) {
  return { targetId: target.targetId, groupId: target.groupId, desiredRevision: target.desiredRevision,
    appliedRevision: target.appliedRevision, binding: binding(target), selection: target.appliedSelection };
}
function drained(state) {
  return state.wallpaper.retiringControllers === 0 && state.wallpaper.retiringHandoffs === 0
    && Array.isArray(state.wallpaper.retirements) && state.wallpaper.retirements.length === 0;
}
async function running(expected, label) {
  return until(async () => {
    const current = await status(), active = targets(current);
    if (active.length !== expected.length || !drained(current)) return null;
    for (const item of expected) {
      const target = active.find(target => target.groupId === item.groupId);
      if (!target || !target.firstFrameReady || !target.pageReady || !target.visible || target.handoff
        || target.candidateLoading || target.selectionPreparing || target.session?.frameKind !== 'gl'
        || target.desiredSelection?.sceneId !== item.sceneId || target.appliedSelection?.sceneId !== item.sceneId
        || target.appliedRevision !== target.desiredRevision) return null;
    }
    return current;
  }, label, 45000);
}

async function renderer(nativeBinding) {
  return until(async () => {
    for (const page of pages().filter(page => page.url().includes('/wallpaper.html'))) {
      try {
        if (await page.evaluate(id => window.hertzWallpaper?.debug().session?.sessionId === id, nativeBinding.sessionId)) return page;
      } catch (error) {
        if (!page.isClosed() && !/Execution context was destroyed|Cannot find context|has been closed/i.test(error.message)) throw error;
      }
    }
    return null;
  }, 'native renderer ' + nativeBinding.generation);
}

async function captureRenderer(target, name, expectedScene) {
  const page = await renderer(binding(target));
  const debug = await page.evaluate(() => window.hertzWallpaper.debug());
  assert.equal(debug.scene, expectedScene);
  assert.equal(debug.mounted, true);
  assert.equal(debug.error, null, 'renderer has no scene error');
  assert.equal(debug.session.frameKind, 'gl');
  assert.equal(debug.session.revealed, true);
  snapshot(name, { target, debug });
  await page.screenshot({ path: path.join(output, name + '.png'), timeout: 15000 });
  evidence.push(name + '.png');
  return page;
}

async function unchanged(expected, label, milliseconds = 1200) {
  const end = Date.now() + milliseconds;
  do {
    const current = await status(), active = targets(current);
    assert.equal(active.length, 1, label + ' cannot create a fallback target');
    assert.deepEqual(identity(active[0]), expected, label + ' preserves the existing target revision and generation');
    assert.equal(active[0].firstFrameReady, true);
    assert.equal(active[0].visible, true);
    assert.ok(drained(current), label + ' cannot retire the existing controller');
    await delay(150);
  } while (Date.now() < end);
}

async function previewGroup(draft, groupId, sceneId) {
  const diskBefore = fs.readFileSync(configFile, 'utf8');
  const unknown = await api('wallpaper.preview.acquire', { ...reference(draft), groupId: 'unknown-display-group' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'group_not_found');
  assert.equal((await status()).wallpaper.mediaPreview, null, 'unknown group acquire has no first-group fallback');
  const acquired = ok(await api('wallpaper.preview.acquire', { ...reference(draft), groupId }), 'acquire second-group preview');
  const leaseId = acquired.leaseId;
  try {
    // The UI does not own this API-created lease, so renew it while waiting for real WebView2 frames.
    let renewAt = Date.now() + 5000;
    const readyPreview = async () => until(async () => {
      if (Date.now() >= renewAt) {
        ok(await api('wallpaper.preview.renew', { leaseId }), 'renew selected-group preview');
        renewAt = Date.now() + 5000;
      }
      const current = await status(), preview = current.wallpaper.mediaPreview;
      return preview?.firstFrameReady && !preview.handoff && drained(current) ? preview : null;
    }, 'second-group native preview first frame', 45000);
    let preview = await readyPreview();
    assert.equal(preview.selection.sceneId, sceneId);
    assert.equal(preview.runtimeBuiltin.sceneId, sceneId);
    const page = await renderer(preview.binding);
    const debug = await page.evaluate(() => window.hertzWallpaper.debug());
    assert.equal(debug.scene, sceneId, 'preview renders the explicitly selected second group');
    assert.equal(debug.session.frameKind, 'gl');
    ok(await api('wallpaper.preview.renew', { leaseId }), 'renew preview before capture');
    await page.screenshot({ path: path.join(output, 'secondary-group-preview.png'), timeout: 15000 });
    evidence.push('secondary-group-preview.png');
    snapshot('secondary-group-preview', { preview, debug });
    const generation = preview.generation;
    const rejected = await api('wallpaper.preview.update', { leaseId, ...reference(draft), groupId: 'unknown-display-group' });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'group_not_found');
    preview = (await status()).wallpaper.mediaPreview;
    assert.equal(preview.generation, generation, 'unknown group update preserves the selected preview');
    assert.equal(preview.selection.sceneId, sceneId);
    ok(await api('wallpaper.preview.update', { leaseId, ...reference(draft), groupId }), 'update explicit second-group preview');
    preview = await readyPreview();
    assert.equal(preview.selection.sceneId, sceneId);
    assert.equal(preview.runtimeBuiltin.sceneId, sceneId);
  } finally {
    ok(await api('wallpaper.preview.release', { leaseId }), 'release selected-group preview');
    await until(async () => { const current = await status(); return !current.wallpaper.mediaPreview && drained(current); }, 'preview native exit');
  }
  assert.equal(fs.readFileSync(configFile, 'utf8'), diskBefore, 'preview preserves all saved group intent');
  mark('explicit second-group preview renders its builtin; unknown acquire/update reject without fallback or revision changes');
}

const bounds = monitor => ({ left: monitor.left, top: monitor.top, width: monitor.width, height: monitor.height });
function union(monitors) {
  const left = Math.min(...monitors.map(monitor => monitor.left)), top = Math.min(...monitors.map(monitor => monitor.top));
  return { left, top, width: Math.max(...monitors.map(monitor => monitor.left + monitor.width)) - left,
    height: Math.max(...monitors.map(monitor => monitor.top + monitor.height)) - top };
}

async function hardwareChecks(primary) {
  if (hardware.monitorCount < 2) {
    hardware.simultaneousFirstFrames = 'skipped'; hardware.spanUnion = 'skipped';
    hardware.reason = 'Only one real monitor was enumerated. Offline/unresolved intent is not multi-monitor hardware acceptance.';
    console.log('SKIP simultaneous native displays and span union: ' + hardware.reason);
    return;
  }
  const second = hardware.monitors.find(monitor => monitor.displayId !== primary.displayId);
  const wallpaper = structuredClone(domain(stored()).wallpaper);
  wallpaper.groups = [group(primaryGroup, { kind: 'primary' }, 'coast', { tod: 0.25 }),
    group(secondaryGroup, { kind: 'fixed', displayId: second.displayId }, 'zodiac')];
  await commit(wallpaper, null, 'two-real-displays');
  const simultaneous = await running([{ groupId: primaryGroup, sceneId: 'coast' }, { groupId: secondaryGroup, sceneId: 'zodiac' }], 'two simultaneous native first frames');
  const active = targets(simultaneous);
  assert.equal(new Set(active.map(target => binding(target).sessionId)).size, 2);
  assert.equal(new Set(active.map(target => binding(target).generation)).size, 2);
  for (const [groupId, monitor, sceneId] of [[primaryGroup, primary, 'coast'], [secondaryGroup, second, 'zodiac']]) {
    const target = active.find(target => target.groupId === groupId);
    assert.equal(target.displayId, monitor.displayId);
    assert.deepEqual(bounds(target.diagnostics.monitor), bounds(monitor));
    await captureRenderer(target, 'two-displays-' + groupId, sceneId);
  }
  hardware.simultaneousFirstFrames = 'passed';
  snapshot('two-displays-status', simultaneous);
  mark('two real monitors have independent native sessions with simultaneous first frames and their enumerated physical bounds');

  const spanBounds = union([primary, second]);
  hardware.spanBounds = spanBounds;
  const span = group('native-span', { kind: 'fixed', displayId: second.displayId }, 'coast', { tod: 0.55 });
  span.mode = 'span';
  span.displays.push({ kind: 'fixed', displayId: primary.displayId });
  wallpaper.groups = [span];
  // The native handoff surface is bounded to 32768 per edge and 16 Mi physical pixels.
  if (spanBounds.width > 32768 || spanBounds.height > 32768 || spanBounds.width * spanBounds.height > 16 * 1024 * 1024) {
    const before = fs.readFileSync(configFile, 'utf8');
    const draft = await draftFor(wallpaper);
    const rejected = await applyDraft(draft, 'oversized-real-span');
    assert.equal(rejected.receipt.ok, false);
    assert.equal(rejected.receipt.error.code, 'invalid_display_layout');
    assert.equal(fs.readFileSync(configFile, 'utf8'), before);
    ok(await api('wallpaper.draft.discard', reference(draft)), 'discard oversized span draft');
    hardware.spanUnion = 'skipped';
    hardware.spanReason = 'The enumerated physical union exceeds the native canvas limit; rejection was verified without resizing monitors.';
    return;
  }
  await commit(wallpaper, null, 'real-span-union');
  const spanning = await running([{ groupId: span.id, sceneId: 'coast' }], 'native span first frame');
  const target = targets(spanning)[0];
  assert.equal(target.targetId, span.id + '/span');
  assert.deepEqual(bounds(target.diagnostics.monitor), spanBounds);
  assert.equal(target.diagnostics.monitor.dpi, 96, 'span uses one physical canvas');
  assert.deepEqual(domain(stored()).wallpaper.groups[0].displays, span.displays, 'span preserves configured member order');
  const page = await captureRenderer(target, 'span-union', 'coast');
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
  assert.ok(Math.abs(viewport.width * viewport.dpr - spanBounds.width) <= 2, 'native span viewport covers the physical union width');
  assert.ok(Math.abs(viewport.height * viewport.dpr - spanBounds.height) <= 2, 'native span viewport covers the physical union height');
  snapshot('span-union-geometry', { members: [primary, second], expected: spanBounds, viewport, target });
  hardware.spanUnion = 'passed';
  mark('native span first frame uses the real monitors physical union, including offsets and configured member order');
}

async function main() {
  assert.equal(process.platform, 'win32', 'this check requires Windows and a built native host');
  assert.ok(fs.existsSync(binary), 'build hertz-desktop first or set HERTZ_DESKTOP_BIN');
  // Read-only guard: refuse to attach to, reconfigure or stop an existing host.
  try {
    await requestManagement(pipe, { command: 'status' });
    throw new Error('A desktop host is already running; close it before running this isolated native check.');
  } catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  fs.mkdirSync(output, { recursive: true });
  const lyrics = { enabled: false, locked: false, layout: 'double', secondary: 'next', fontFamily: 'Segoe UI', fontSize: 32,
    fontWeight: 600, sungColor: '#ffffff', unsungColor: '#ffffff', outlineColor: '#000000', outlineWidth: 1,
    opacity: 1, width: 550, anchorX: 0.5, anchorY: 0.5, monitor: null };
  const wallpaper = { enabled: false, audioInput: { kind: 'none' }, batteryPolicy: 'pause', pauseOnFullscreen: false,
    pauseOnMaximized: false, applicationRules: [], groups: [group(primaryGroup, { kind: 'primary' }, 'coast', { tod: 0.25 })] };
  fs.writeFileSync(configFile, JSON.stringify({ schemaVersion: 5, revision: 1, launchAtLogin: false,
    activeProfile: null, profiles: [], unboundDomain: { wallpaper, lyrics }, lastCommit: null }, null, 2));
  await start();
  const initial = await settingsSnapshot();
  hardware.monitors = initial.monitors;
  hardware.monitorCount = hardware.monitors.length;
  assert.ok(hardware.monitorCount > 0, 'at least one connected real monitor is required');
  assert.equal(hardware.monitors.filter(monitor => monitor.primary).length, 1, 'one unambiguous real primary display');
  assert.equal(new Set(hardware.monitors.map(monitor => monitor.displayId)).size, hardware.monitorCount, 'real display identities are unique');
  const primary = hardware.monitors.find(monitor => monitor.primary);
  assert.ok(!hardware.monitors.some(monitor => monitor.displayId === offlineDisplayId));
  assert.ok(initial.scenes.some(scene => scene.id === 'coast') && initial.scenes.some(scene => scene.id === 'zodiac'), 'use registered native builtin scenes');
  snapshot('hardware', { ...hardware, capabilities: ok(await api('wallpaper.capabilities'), 'native capabilities') });
  console.log('Real monitor count: ' + hardware.monitorCount + '; output: ' + output);

  wallpaper.enabled = true;
  wallpaper.groups.push(group(secondaryGroup, { kind: 'fixed', displayId: offlineDisplayId }, 'zodiac'));
  const draft = await draftFor(wallpaper);
  await previewGroup(draft, secondaryGroup, 'zodiac');
  const baseRevision = stored().revision;
  const first = await applyDraft(draft, 'complete-two-group-intent');
  const operation = ok(first.receipt, 'complete two-group apply');
  assert.equal(operation.saved, true);
  assert.equal(operation.state, 'committed');
  assert.equal(operation.baseRevision, baseRevision);
  assert.equal(operation.configRevision, baseRevision + 1);
  assert.equal(stored().revision, baseRevision + 1, 'all group intent commits once');
  const savedGroups = domain(stored()).wallpaper.groups;
  assert.deepEqual(savedGroups.map(item => ({ id: item.id, mode: item.mode, displays: item.displays, sceneId: item.selection.sceneId })),
    wallpaper.groups.map(item => ({ id: item.id, mode: item.mode, displays: item.displays, sceneId: item.selection.sceneId })), 'both online and offline group intents are persisted');
  for (const expected of wallpaper.groups) {
    const saved = savedGroups.find(item => item.id === expected.id);
    assert.deepEqual(saved.presentation, expected.presentation);
    assert.deepEqual(saved.properties, expected.properties);
    assert.equal(saved.selection.stateVersion, expected.selection.stateVersion);
    for (const [key, value] of Object.entries(expected.selection.params)) assert.deepEqual(saved.selection.params[key], value);
  }
  const firstState = await running([{ groupId: primaryGroup, sceneId: 'coast' }], 'primary first frame without an offline fallback');
  const firstTarget = targets(firstState)[0], originalIdentity = identity(firstTarget);
  assert.equal(firstTarget.displayId, primary.displayId);
  const oldPage = await captureRenderer(firstTarget, 'primary-with-offline-group', 'coast');
  const firstBytes = fs.readFileSync(configFile, 'utf8');
  const replay = ok(await native(first.request), 'duplicate committed apply');
  assert.deepEqual(replay, operation);
  assert.equal(fs.readFileSync(configFile, 'utf8'), firstBytes, 'duplicate request cannot add a second commit');
  await unchanged(originalIdentity, 'offline fixed display');
  mark('one Apply persists both groups in one revision; offline fixed intent creates no fallback target and replay does not commit again');

  const edited = structuredClone(domain(stored()).wallpaper);
  edited.groups[1].displays = [{ kind: 'unresolved', legacyName: primary.name }];
  edited.groups[1].selection = { kind: 'builtin', sceneId: 'coast', stateVersion: 1, params: { tod: 0.75 } };
  edited.groups[1].presentation.brightness = 0.63;
  await commit(edited, null, 'edit-only-second-group');
  assert.deepEqual(domain(stored()).wallpaper.groups[1].displays, edited.groups[1].displays);
  assert.equal(domain(stored()).wallpaper.groups[1].selection.params.tod, 0.75);
  await unchanged(originalIdentity, 'second-group edit and unresolved real monitor name');
  mark('editing group two preserves group one generation/desired revision; unresolved legacy names never resolve even when matching the connected primary name');

  const editedLyrics = { ...domain(stored()).lyrics, fontSize: 43 };
  await commit(null, editedLyrics, 'lyrics-only-edit');
  assert.equal(domain(stored()).lyrics.fontSize, 43);
  await unchanged(originalIdentity, 'lyrics-only commit');
  mark('lyrics-only Apply advances the saved revision without restarting or advancing the unchanged wallpaper target');

  const moved = structuredClone(domain(stored()).wallpaper);
  moved.groups[0].displays = [{ kind: 'fixed', displayId: offlineDisplayId }];
  moved.groups[1].displays = [{ kind: 'primary' }];
  await commit(moved, null, 'move-primary-to-second-group');
  const movedState = await running([{ groupId: secondaryGroup, sceneId: 'coast' }], 'new group first frame and old target exit');
  const movedTarget = targets(movedState)[0], movedIdentity = identity(movedTarget);
  assert.notEqual(movedTarget.targetId, firstTarget.targetId);
  assert.equal(movedTarget.displayId, primary.displayId);
  assert.ok(binding(movedTarget).generation > originalIdentity.binding.generation);
  assert.notEqual(binding(movedTarget).sessionId, originalIdentity.binding.sessionId);
  assert.equal(movedTarget.desiredRevision, stored().revision);
  await until(() => oldPage.isClosed(), 'removed group native WebView closes');
  const movedPage = await captureRenderer(movedTarget, 'primary-moved-to-secondary', 'coast');
  assert.equal((await movedPage.evaluate(() => window.hertzWallpaper.debug())).sceneParams.tod, 0.75);
  // Send the old typed identity through the new owned controller; it cannot resurrect or mutate an old target.
  await movedPage.evaluate(oldBinding => {
    window.ipc.postMessage('wallpaper_session ' + JSON.stringify({ ...oldBinding, event: 'pageHandshake' }));
    window.ipc.postMessage('wallpaper_session ' + JSON.stringify({ ...oldBinding, event: 'firstFrame', frameKind: 'gl' }));
    window.ipc.postMessage('wallpaper_session ' + JSON.stringify({ ...oldBinding, event: 'revealed' }));
  }, originalIdentity.binding);
  await unchanged(movedIdentity, 'stale old-group readiness identity');
  snapshot('primary-transfer-status', movedState);
  mark('moving Primary to group two closes the old native generation, reveals the new group, drains exits and rejects old readiness identities');

  const collision = structuredClone(domain(stored()).wallpaper);
  collision.groups[0].displays = [{ kind: 'fixed', displayId: primary.displayId }];
  const beforeCollision = fs.readFileSync(configFile, 'utf8'), collisionRevision = stored().revision;
  const collisionDraft = await draftFor(collision);
  const rejected = await applyDraft(collisionDraft, 'primary-fixed-physical-collision');
  assert.equal(rejected.receipt.ok, false);
  assert.equal(rejected.receipt.error.code, 'invalid_display_layout');
  assert.equal(stored().revision, collisionRevision);
  assert.equal(fs.readFileSync(configFile, 'utf8'), beforeCollision);
  await unchanged(movedIdentity, 'rejected Primary/Fixed physical collision');
  ok(await api('wallpaper.draft.discard', reference(collisionDraft)), 'discard rejected collision draft');
  mark('Primary and Fixed claiming the same physical monitor reject atomically with saved revision and original runtime unchanged');

  const currentMonitors = (await settingsSnapshot()).monitors;
  const orderedMonitors = monitors => [...monitors].sort((a, b) => a.displayId.localeCompare(b.displayId));
  assert.deepEqual(orderedMonitors(currentMonitors), orderedMonitors(hardware.monitors), 'physical monitor topology stays stable during this acceptance run');
  await hardwareChecks(primary);
  await settings.screenshot({ path: path.join(output, 'settings.png'), fullPage: true, timeout: 15000 });
  evidence.push('settings.png');
  const disabled = structuredClone(domain(stored()).wallpaper); disabled.enabled = false;
  await commit(disabled, null, 'disable-owned-wallpaper');
  const stopped = await until(async () => {
    const current = await status();
    return drained(current) && !current.wallpaper.mediaPreview
      && targets(current).every(target => !target.session && !target.handoff && !target.candidateLoading && !target.selectionPreparing)
      && current.wallpaper.budget.targets === 0 && current.wallpaper.budget.contexts === 0
      && current.wallpaper.budget.releasePending === 0 && current.wallpaper.budget.resourceReleasePending === 0 ? current : null;
  }, 'owned wallpaper controllers, resources and exit queues drain', 30000);
  snapshot('disabled-status', stopped);
  assert.deepEqual(pageErrors, []);
  mark('disabling the isolated host drains all native controllers and GL/target resource reservations');
}

main().then(async () => {
  await stop();
  const report = { passed: true, output, binary, binarySha256: hash(fs.readFileSync(binary)), checks, hardware, receipts, evidence, pageErrors,
    scope: 'Real isolated native process, WebView2/CDP, typed settings API and management pipe. Offline/unresolved selections are intent tests; multi-monitor hardware results are explicitly conditional.' };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, output, checks, hardware }, null, 2));
}).catch(async error => {
  fs.mkdirSync(output, { recursive: true });
  if (child && child.exitCode === null && child.signalCode === null) {
    try { snapshot('failure-status', await status()); } catch { /* the owned host may already be exiting */ }
    if (settings && !settings.isClosed()) await settings.screenshot({ path: path.join(output, 'failure-settings.png'), timeout: 5000 }).catch(() => {});
  }
  let stopError = null;
  try { await stop(); } catch (failure) { stopError = failure.stack; }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: false, error: error.stack, stopError,
    output, binary, checks, hardware, receipts, evidence, pageErrors }, null, 2));
  console.error(error);
  console.error('Native display check evidence: ' + output);
  process.exitCode = 1;
});
