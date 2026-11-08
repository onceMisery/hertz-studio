#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Isolated real WebView2 Mirror acceptance. Never changes Windows display topology.
// Build hertz-desktop with --features wallpaper-media-probe for the real ImportJobs harness.
// All Mirror selections use settings drafts/Apply; no package receipts or library rows are seeded.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { buildZip } = require('./check-wallpaper-media-native');
const requestManagement = require('./desktop-native-management-client');

const root = path.resolve(__dirname, '..');
const binary = path.resolve(process.env.HERTZ_DESKTOP_BIN || path.join(root, 'target/debug/hertz-desktop.exe'));
const output = path.join(root, 'output/playwright/wallpaper-mirror-native-' + Date.now());
const configFile = path.join(output, 'config.json');
const pipe = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
const port = Number(process.env.DESKTOP_CDP_PORT || 19568);
const runId = 'mirror-' + Date.now() + '-';
const groupId = 'native-mirror';
const offlineDisplayId = 'native-mirror-offline-' + crypto.randomUUID();
const checks = [], skipped = [], receipts = [], evidence = [], pageErrors = [];
const hardware = { monitorCount: null, monitors: [], exercisedDisplayIds: [], configuredMembers: 2,
  simultaneousImageFrames: 'not-run', simultaneousPlaylistSwitch: 'not-run', simultaneousPlaylistRevision: 'not-run',
  simultaneousPresentationApply: 'not-run', simultaneousVideoFrames: 'not-run', crossMonitorVideoClock: 'not-run',
  simultaneousVideoResume: 'not-run', simultaneousFailureRetention: 'not-run' };
const fixture = { importer: 'wallpaper-media-probe / real ImportJobs and native decode probe', images: [], video: null, builtin: null };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stored = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
const domain = config => config.activeProfile
  ? config.profiles.find(entry => JSON.stringify(entry.profile) === JSON.stringify(config.activeProfile))
  : config.unboundDomain;
const reference = draft => ({ draftId: draft.draftId, draftRevision: draft.draftRevision });
const fixed = selection => ({ workKey: selection.workKey, packageHash: selection.packageHash });
let child, browser, settings, spawnError, activeDraft = null, sequence = 0, importNonce = 0, cleanupDone = false;

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
    try { return await window.hertzWallpaperSettings.requestManagement(request.command, request.payload, request.requestId, request.expectedRevision); }
    catch (error) { return error.receipt || { ok: false, error: { code: error.code, message: error.message } }; }
  }, request);
}
const api = (command, payload, expectedRevision) => inPage(envelope(command, payload, expectedRevision));
// Retry only before a connection exists; uncertain connected mutations are queried, never replayed.
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
function skip(name, reason) { skipped.push({ name, reason }); console.log('SKIP ' + name + ': ' + reason); }
function snapshot(name, value) {
  fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(value, null, 2));
  evidence.push(name + '.json');
}
async function capture(page, name) {
  await page.screenshot({ path: path.join(output, name + '.png'), timeout: 15000 });
  evidence.push(name + '.png');
}

async function start() {
  let occupied = false;
  try { occupied = (await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1000) })).ok; }
  catch { /* no debug browser should own this port */ }
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
  for (const context of browser.contexts()) { context.on('page', watch); context.pages().forEach(watch); }
  settings = await until(() => pages().find(page => page.url().includes('/settings.html')), 'settings page');
  await settings.waitForSelector('#enabled:enabled');
  await settings.evaluate(() => {
    const original = window.hertzWallpaperSettings.applyStatus;
    window.hertzWallpaperSettings.applyStatus = function (payload) {
      window.__mirrorNativeStatus = payload;
      return original.apply(this, arguments);
    };
  });
}
async function stop() {
  // Only the PID created above is terminated. Never send a global pipe quit.
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
  await settings.evaluate(() => { window.__mirrorNativeStatus = null; window.ipc.postMessage(JSON.stringify({ cmd: 'status' })); });
  await settings.waitForFunction(() => !!window.__mirrorNativeStatus, null, { timeout: 10000 });
  return settings.evaluate(() => window.__mirrorNativeStatus);
}

function group(selection, displays, mode = 'mirror', id = groupId) {
  return { id, mode, displays, selection,
    presentation: { fps: 15, quality: 'low', brightness: 1, motion: 1, fit: 'cover', pointer: false }, properties: {} };
}
async function draftFor(wallpaper) {
  const before = fs.readFileSync(configFile, 'utf8');
  activeDraft = ok(await api('wallpaper.draft.create', { kind: 'settings' }), 'create settings draft');
  assert.equal(activeDraft.baseRevision, stored().revision);
  activeDraft = ok(await api('wallpaper.draft.update', { ...reference(activeDraft), operations: [{ kind: 'replaceWallpaper', wallpaper }] }), 'update settings draft');
  assert.equal(fs.readFileSync(configFile, 'utf8'), before, 'editing settings draft does not save configuration');
  return activeDraft;
}
function recoveredReceipt(receipt) {
  return receipt.ok && receipt.result?.protocol === 2 ? receipt.result : receipt;
}
async function applyDraft(draft, label) {
  const request = envelope('wallpaper.apply', reference(draft), draft.baseRevision);
  let receipt = await inPage(request);
  if (!receipt.ok && ['receipt_timeout', 'operation_pending', 'query_timeout'].includes(receipt.error.code)) {
    receipt = await until(async () => {
      const queried = await native(envelope('wallpaper.operations.get', { requestId: request.requestId, command: request.command }));
      if (!queried.ok && ['operation_pending', 'query_timeout', 'config_busy', 'budget_busy'].includes(queried.error.code)) return null;
      const recovered = recoveredReceipt(queried);
      return recovered.ok && recovered.result?.state === 'pending' ? null : recovered;
    }, 'terminal receipt for original ' + label + ' request', 65000);
  }
  receipts.push({ label, request, receipt });
  if (receipt.ok && receipt.result?.saved) activeDraft = null;
  return receipt;
}
async function commit(wallpaper, label) {
  const baseRevision = stored().revision;
  const operation = ok(await applyDraft(await draftFor(wallpaper), label), label);
  assert.equal(operation.saved, true);
  assert.equal(operation.state, 'committed');
  assert.equal(operation.baseRevision, baseRevision);
  assert.equal(operation.configRevision, baseRevision + 1, 'complete group intent commits exactly one revision');
  assert.equal(stored().revision, baseRevision + 1);
  return operation;
}
function targets(state) { assert.ok(Array.isArray(state.wallpaper?.targets), 'native status exposes wallpaper.targets'); return state.wallpaper.targets; }
function binding(target) {
  assert.ok(target.session?.binding?.sessionId && Number.isSafeInteger(target.session.binding.generation), 'target has a native session binding');
  return target.session.binding;
}
function drained(state) {
  return state.wallpaper.retiringControllers === 0 && state.wallpaper.retiringHandoffs === 0
    && Array.isArray(state.wallpaper.retirements) && state.wallpaper.retirements.length === 0;
}
function runtimeIdentity(state) {
  return targets(state).map(target => ({ targetId: target.targetId, groupId: target.groupId, binding: binding(target),
    desiredRevision: target.desiredRevision, appliedRevision: target.appliedRevision,
    desiredSelection: target.desiredSelection, appliedSelection: target.appliedSelection,
    token: target.mirror?.token, memberGeneration: target.mirror?.memberGeneration,
    currentIndex: target.mirror?.currentIndex })).sort((a, b) => a.targetId.localeCompare(b.targetId));
}
async function renderer(nativeBinding) {
  return until(async () => {
    for (const page of pages().filter(page => page.url().includes('/wallpaper.html'))) {
      try { if (await page.evaluate(id => window.hertzWallpaper?.debug().session?.sessionId === id, nativeBinding.sessionId)) return page; }
      catch (error) {
        if (!page.isClosed() && !/Execution context was destroyed|Cannot find context|has been closed/i.test(error.message)) throw error;
      }
    }
    return null;
  }, 'native renderer ' + nativeBinding.generation);
}
async function mirrorRunning(selection, kind, index, label, playlistRevision = null) {
  const current = await until(async () => {
    const current = await status(), active = targets(current);
    if (active.length !== hardware.exercisedDisplayIds.length || !drained(current)) return null;
    for (const target of active) {
      if (target.applyError) throw new Error(label + ': ' + target.targetId + ': ' + target.applyError);
      if (target.groupId !== groupId || !target.firstFrameReady || !target.pageReady || !target.visible || target.handoff
        || target.candidateLoading || target.selectionPreparing || target.session?.frameKind !== kind
        || target.appliedRevision !== target.desiredRevision || target.appliedRevision !== stored().revision
        || !isDeepStrictEqual(target.appliedSelection, selection)
        || (playlistRevision != null && target.playlist?.playlistRevision !== playlistRevision)
        || !target.mirror?.sharedGroupClock || target.mirror.currentIndex !== index || target.mirror.switching
        || target.mirror.failed || !target.mirror.released || target.mirror.presentedGeneration !== target.session.binding.generation) return null;
    }
    return current;
  }, label, 45000);
  const active = targets(current);
  assert.deepEqual(active.map(target => target.displayId).sort(), [...hardware.exercisedDisplayIds].sort(), 'only selected connected monitors own native targets');
  assert.equal(new Set(active.map(target => target.targetId)).size, active.length, 'each member has a stable independent target key');
  assert.equal(new Set(active.map(target => binding(target).sessionId)).size, active.length, 'each connected member owns its actual native controller');
  assert.equal(new Set(active.map(target => target.mirror.memberGeneration)).size, active.length, 'member tickets are distinct');
  assert.equal(new Set(active.map(target => target.mirror.token)).size, 1, 'members share one switch token');
  assert.equal(new Set(active.map(target => target.mirror.epoch)).size, 1, 'members share one source epoch');
  for (const target of active) {
    assert.ok(Number.isSafeInteger(target.mirror.token) && target.mirror.token > 0);
    assert.ok(Number.isSafeInteger(target.mirror.memberGeneration) && target.mirror.memberGeneration > 0);
    const monitor = hardware.monitors.find(monitor => monitor.displayId === target.displayId);
    for (const key of ['left', 'top', 'width', 'height']) assert.equal(target.diagnostics.monitor[key], monitor[key], 'Mirror keeps the member physical ' + key);
    assert.equal(target.mediaAllocation.active, 2, 'decode and presentation hold separate native child allocations');
    assert.equal(target.mediaAllocation.releasePending, 0);
  }
  assert.equal(current.wallpaper.budget.targets, active.length);
  assert.equal(current.wallpaper.budget.contexts, 0, 'image/video Mirror uses the media backend');
  assert.equal(current.wallpaper.budget.decoderSlots, kind === 'video' ? active.length : 0);
  return current;
}
async function captureMembers(current, name, kind, expected) {
  const captures = [];
  for (const [index, target] of targets(current).entries()) {
    const page = await renderer(binding(target));
    const debug = await page.evaluate(() => window.hertzWallpaper.debug());
    assert.equal(debug.backend, 'media'); assert.equal(debug.media.kind, kind); assert.equal(debug.media.state, 'ready');
    assert.equal(debug.media.error, null); assert.equal(debug.session.frameKind, kind); assert.equal(debug.session.revealed, true);
    assert.equal(await page.locator('canvas').count(), 0, 'media Mirror creates no GL canvas');
    assert.ok(debug.media.url.startsWith(packageOrigin(expected.packageHash) + '/files/'), 'renderer uses the exact immutable version');
    if (kind === 'image') {
      const decoded = await page.evaluate(() => {
        const image = document.querySelector('img[data-wallpaper-media="image"]');
        return image && { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight };
      });
      assert.deepEqual(decoded, { complete: true, width: 320, height: 180 });
    }
    if (kind === 'video') {
      assert.equal(debug.media.muted, true); assert.equal(debug.media.paused, false);
      assert.equal(debug.media.clock.firstFrameHeld, true, 'the actual first video frame was paused behind the hidden host');
      assert.equal(debug.media.clock.held, false); assert.equal(debug.media.clock.aligning, false);
      assert.ok(debug.media.clock.releases >= 1, 'a real group clock release completed');
      assert.ok(Number.isSafeInteger(target.mirror.clockToken) && target.mirror.clockToken > 0);
      assert.equal(debug.media.clock.token, target.mirror.clockToken, 'page clock release is bound to its native member clock token');
    }
    await capture(page, name + '-member-' + index);
    captures.push({ target, debug });
  }
  snapshot(name, { status: current, members: captures });
  return captures;
}
function packageOrigin(packageHash) { return 'https://' + packageHash.slice(0, 32) + '.' + packageHash.slice(32) + '.wallpaper.invalid'; }

function makePackage(kind, bytes, workId, version) {
  const file = 'assets/background.' + (kind === 'image' ? 'png' : 'webm');
  const manifest = { formatVersion: 1, workId, version, title: 'Native Mirror ' + kind, description: 'Isolated native regression fixture',
    content: { kind, asset: 'background' }, assets: [{ id: 'background', kind, source: file, variants: [] }],
    files: [{ path: file, bytes: bytes.length, sha256: hash(bytes), mime: kind === 'image' ? 'image/png' : 'video/webm' }],
    properties: [], permissions: { audioSpectrum: false, pointer: false }, license: { code: 'none', assets: 'CC0-1.0', attribution: '' } };
  return { bytes: buildZip([['manifest.json', Buffer.from(JSON.stringify(manifest))], [file, bytes]]), manifest };
}
async function importPackage(page, name, input) {
  const source = path.join(output, 'probe-inputs', name + '.hwpkg');
  fs.writeFileSync(source, input.bytes);
  const nonce = ++importNonce, before = fs.readFileSync(configFile, 'utf8');
  await page.evaluate(request => window.ipc.postMessage('wallpaper_probe_import ' + JSON.stringify(request)), { nonce, action: 'begin', name });
  await page.waitForFunction(nonce => !!window.__nativeImportProbes?.[nonce], nonce, { timeout: 60000 })
    .catch(() => { throw new Error('Real import did not finish; build hertz-desktop --features wallpaper-media-probe (debug) and inspect host.log.'); });
  const imported = await page.evaluate(nonce => window.__nativeImportProbes[nonce], nonce);
  receipts.push({ label: 'real-import-' + name, receipt: imported });
  assert.equal(imported.state, 'done', JSON.stringify(imported));
  assert.equal(imported.packageHash, hash(input.bytes));
  assert.equal(imported.prepareTasks, 0); assert.equal(imported.prepareCpuBytes, 0); assert.equal(imported.activeStreams, 0); assert.equal(imported.decoderSlots, 0);
  assert.equal(imported.probeRuns, 1, 'new fixture qualifies through a real native decode probe');
  assert.equal(pages().some(page => page.url().includes('/wallpaper-probe.html')), false, 'probe controller closes before publication receipt');
  const selection = { kind: 'package', workKey: 'local-' + input.manifest.workId, packageHash: imported.packageHash };
  const detail = ok(await api('wallpaper.library.get', { workKey: selection.workKey }), 'read actual installed work');
  assert.ok(detail.versions.some(version => version.packageHash === selection.packageHash && version.version === input.manifest.version));
  assert.equal(hash(fs.readFileSync(path.join(output, 'packages', selection.packageHash, 'original.hwpkg'))), selection.packageHash);
  assert.equal(fs.readFileSync(configFile, 'utf8'), before, 'real import does not save desktop configuration');
  fs.unlinkSync(source); // A later Apply must use the installed bytes, not the import source.
  return selection;
}
async function seedFixtures() {
  const initial = await until(async () => {
    const state = await status(), target = targets(state)[0];
    return target?.firstFrameReady && target.visible && target.session?.frameKind === 'gl' && drained(state) ? target : null;
  }, 'bootstrap renderer for existing native import harness', 45000);
  const page = await renderer(binding(initial));
  // Canvas generates real, visibly different PNG bytes; native import still owns validation and preparation.
  const encoded = await settings.evaluate(() => [0, 1].map(version => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d');
    context.fillStyle = version ? '#153f6b' : '#723b20'; context.fillRect(0, 0, 320, 180);
    context.fillStyle = version ? '#68d6ca' : '#f7ba63'; context.fillRect(version ? 170 : 30, 30, 120, 120);
    context.fillStyle = '#ffffff'; context.font = 'bold 20px sans-serif'; context.fillText('MIRROR ' + (version + 1), 24, 168);
    return canvas.toDataURL('image/png').split(',')[1];
  }));
  fs.mkdirSync(path.join(output, 'probe-inputs'), { recursive: true });
  const imageWorkId = crypto.randomUUID();
  for (let index = 0; index < 2; index++) fixture.images.push(await importPackage(page, 'image-' + index,
    makePackage('image', Buffer.from(encoded[index], 'base64'), imageWorkId, index + 1)));
  const videoFile = path.resolve(process.env.WALLPAPER_MIRROR_VIDEO || path.join(root, 'scripts/fixtures/wallpaper-vp8.webm'));
  if (fs.existsSync(videoFile)) {
    const bytes = fs.readFileSync(videoFile);
    fixture.video = await importPackage(page, 'video', makePackage('video', bytes, crypto.randomUUID(), 1));
    fixture.videoSource = { file: videoFile, sha256: hash(bytes), bytes: bytes.length };
  } else {
    const reason = 'Video fixture is absent: ' + videoFile;
    for (const name of ['real-video-first-frame-reveal-and-drift-correction', 'real-video-pause-resume',
      'real-video-error-poster-retry', 'active-image-video-resume-layout-rejection']) skip(name, reason);
    for (const key of ['simultaneousVideoFrames', 'crossMonitorVideoClock', 'simultaneousVideoResume', 'simultaneousFailureRetention']) {
      hardware[key] = 'skipped';
      if (!skipped.some(entry => entry.name === key)) skip(key, reason);
    }
  }
  const work = ok(await api('wallpaper.draft.create', { kind: 'work', document: {
    title: 'Mirror must reject this builtin package', sceneId: 'coast', stateVersion: 1, params: { tod: 0.25 },
  } }), 'create actual builtin work');
  const saved = ok(await api('wallpaper.draft.save', reference(work)), 'save builtin work');
  const published = ok(await api('wallpaper.draft.publish', reference(saved)), 'publish actual builtin package');
  fixture.builtin = { kind: 'package', ...fixed(published) };
  assert.equal(hash(fs.readFileSync(path.join(output, 'packages', published.packageHash, 'original.hwpkg'))), published.packageHash);
  const imageVersions = ok(await api('wallpaper.library.get', { workKey: fixture.images[0].workKey }), 'image versions');
  assert.equal(imageVersions.versions.length, 2, 'two fixed image versions belong to one installed work');
  snapshot('fixtures', fixture);
  mark('two real image versions and available video import through native decode probes; published builtin package comes from the work API');
}

async function inspect(selection, members, expectedEligible, expectedMax, label) {
  const before = fs.readFileSync(configFile, 'utf8');
  const result = await until(async () => {
    const receipt = await api('wallpaper.layout.inspect', { selection, members });
    if (!receipt.ok && ['budget_busy', 'service_starting'].includes(receipt.error.code)) return null;
    const inspected = ok(receipt, label);
    return inspected.pending === true ? null : inspected;
  }, label + ' finishes its background inspection', 65000);
  assert.equal(result.mirrorEligible, expectedEligible, label);
  assert.equal(result.maxMembers, expectedMax, label);
  assert.equal(result.layouts.includes('mirror'), expectedEligible);
  assert.ok(result.layouts.includes('single') && result.layouts.includes('span'));
  if (!expectedEligible) assert.ok(typeof result.reason === 'string' && result.reason.trim(), 'ineligible inspection explains the actual content restriction');
  assert.equal(fs.readFileSync(configFile, 'utf8'), before, 'layout inspection is read-only');
  receipts.push({ label, result });
  return result;
}
async function rejectBeforeCommit(selection, displays, label, enabled = true) {
  const before = fs.readFileSync(configFile, 'utf8'), identity = runtimeIdentity(await status());
  const wallpaper = structuredClone(domain(stored()).wallpaper);
  wallpaper.enabled = enabled;
  wallpaper.groups = [group(selection, displays)];
  const draft = await draftFor(wallpaper);
  try {
    const rejected = await applyDraft(draft, label);
    assert.equal(rejected.ok, false, label + ': ' + JSON.stringify(rejected));
    assert.equal(rejected.error.code, 'unsupported_layout', 'actual installed content rejects before configuration commit');
    assert.equal(fs.readFileSync(configFile, 'utf8'), before);
    const after = await status();
    assert.deepEqual(runtimeIdentity(after), identity, 'rejected candidate leaves all running targets and member tickets intact');
    assert.ok(targets(after).every(target => target.visible && target.firstFrameReady && !target.candidateLoading && !target.selectionPreparing));
    assert.ok(drained(after));
    snapshot(label, { rejected, status: after });
  } finally {
    ok(await api('wallpaper.draft.discard', reference(draft)), 'discard rejected Mirror draft');
    activeDraft = null;
  }
}
async function savePlaylist(title, selections, intervalSeconds = 10) {
  const playlist = ok(await api('wallpaper.playlist.save', { title, mode: 'sequential', intervalSeconds, items: selections.map(fixed) }), 'save ' + title);
  receipts.push({ label: title, result: playlist });
  return { kind: 'playlist', playlistId: playlist.playlistId };
}

async function imageAndPlaylistChecks(displays) {
  let wallpaper = structuredClone(domain(stored()).wallpaper);
  wallpaper.groups = [group(fixture.images[0], displays)];
  await commit(wallpaper, 'apply-real-image-mirror');
  let current = await mirrorRunning(fixture.images[0], 'image', 0, 'all connected image members first frame and release');
  assert.deepEqual(domain(stored()).wallpaper.groups[0].displays, displays, 'offline Fixed intent is preserved without creating a fallback target');
  await captureMembers(current, 'image-mirror', 'image', fixture.images[0]);
  if (hardware.monitorCount >= 2) hardware.simultaneousImageFrames = 'passed';
  mark('real image Mirror has exact per-monitor sessions, native member tickets, one shared selection and completed release receipts');

  await inspect(fixture.images[0], 4, true, 4, 'image-four-member-eligibility');
  await inspect(fixture.builtin, 2, false, 4, 'installed-builtin-package-ineligible');
  await rejectBeforeCommit(fixture.builtin, displays, 'reject-installed-builtin-package');
  const mixed = await savePlaylist('Image then builtin must reject', [fixture.images[0], fixture.builtin]);
  await inspect(mixed, 2, false, 4, 'later-builtin-playlist-ineligible');
  await rejectBeforeCommit(mixed, displays, 'reject-later-builtin-playlist');
  const absent = [0, 1].map(index => ({ kind: 'fixed', displayId: 'native-unplugged-' + index + '-' + crypto.randomUUID() }));
  await rejectBeforeCommit(mixed, absent, 'reject-all-offline-later-builtin');
  await rejectBeforeCommit(mixed, absent, 'reject-disabled-new-later-builtin', false);
  if (fixture.video) {
    await inspect(fixture.video, 2, true, 2, 'video-two-member-eligibility');
    await inspect(fixture.video, 3, false, 2, 'video-three-member-ineligible');
    const three = [...displays, { kind: 'fixed', displayId: 'native-third-offline-' + crypto.randomUUID() }];
    await rejectBeforeCommit(fixture.video, three, 'reject-three-member-video');
    const absentThree = [...absent, { kind: 'fixed', displayId: 'native-unplugged-third-' + crypto.randomUUID() }];
    await rejectBeforeCommit(fixture.video, absentThree, 'reject-all-offline-three-member-video');
    await rejectBeforeCommit(fixture.video, absentThree, 'reject-disabled-new-three-member-video', false);
  }
  mark('whole-playlist content and video member limits reject before commit, including all-offline or newly disabled mirror intents');

  const playlist = await savePlaylist('Two real image versions', fixture.images);
  await inspect(playlist, 4, true, 4, 'all-image-playlist-eligibility');
  wallpaper = structuredClone(domain(stored()).wallpaper); wallpaper.groups = [group(playlist, displays)];
  await commit(wallpaper, 'apply-shared-image-playlist');
  current = await mirrorRunning(playlist, 'image', 0, 'shared playlist initial item');
  await captureMembers(current, 'playlist-initial', 'image', fixture.images[0]);
  const revision = stored().revision, configurationBytes = fs.readFileSync(configFile, 'utf8');
  const token = targets(current)[0].mirror.token;
  // groupId selects one playback owner even when it has two real presentation keys.
  const next = ok(await api('wallpaper.playlist.next', { playlistId: playlist.playlistId, groupId }), 'next shared group');
  assert.equal(next.pendingIndex, 1);
  current = await mirrorRunning(playlist, 'image', 1, 'one next request reveals image version two on every runnable member');
  assert.notEqual(targets(current)[0].mirror.token, token);
  for (const target of targets(current)) {
    assert.equal(target.playlist.currentIndex, 1); assert.equal(target.playlist.sharedGroupClock, true);
    assert.deepEqual(target.playlist.current, fixed(fixture.images[1]));
  }
  await captureMembers(current, 'playlist-next', 'image', fixture.images[1]);
  assert.equal(stored().revision, revision); assert.equal(fs.readFileSync(configFile, 'utf8'), configurationBytes);
  if (hardware.monitorCount >= 2) hardware.simultaneousPlaylistSwitch = 'passed';
  mark('playlist.next with groupId advances one shared index and fixed version across every connected target without a configuration write');

  await native({ command: 'wallpaper-hide' });
  await until(async () => targets(await status()).every(target => target.hidden && !target.visible), 'all Mirror members manually paused');
  const pausedAt = Date.now(), pauseSamples = [];
  while (Date.now() - pausedAt < 12000) {
    const state = await status();
    assert.ok(targets(state).every(target => target.mirror.currentIndex === 1 && target.playlist.currentIndex === 1 && !target.visible));
    assert.equal(fs.readFileSync(configFile, 'utf8'), configurationBytes);
    pauseSamples.push({ elapsedMs: Date.now() - pausedAt, index: state.wallpaper.playlist.currentIndex });
    await delay(500);
  }
  await native({ command: 'wallpaper-show' });
  current = await mirrorRunning(playlist, 'image', 1, 'resume keeps shared playlist item');
  await delay(900);
  assert.ok(targets(await status()).every(target => target.mirror.currentIndex === 1), 'resume does not catch up the paused interval');
  assert.equal(fs.readFileSync(configFile, 'utf8'), configurationBytes);
  snapshot('playlist-pause-resume', { pausedMs: Date.now() - pausedAt, samples: pauseSamples, resumed: current, configRevision: revision });
  mark('a pause longer than the 10-second playlist interval freezes the group index; resume keeps that item and saved revision');
  await playlistRevisionAndApplyChecks(playlist, displays);
}

async function playlistRevisionAndApplyChecks(playlist, displays) {
  const configurationBytes = fs.readFileSync(configFile, 'utf8');
  // Start on item zero so the saved revision keeps the same currently displayed
  // bytes. A stale first-item receipt must not complete the new source generation.
  assert.equal(ok(await api('wallpaper.playlist.next', { playlistId: playlist.playlistId, groupId }), 'return to first image before playlist edit').pendingIndex, 0);
  const before = await mirrorRunning(playlist, 'image', 0, 'first image before same-first-item playlist revision');
  const previous = ok(await api('wallpaper.playlist.get', { playlistId: playlist.playlistId }), 'read playlist for revision CAS');
  const revised = ok(await api('wallpaper.playlist.save', {
    playlistId: playlist.playlistId, expectedPlaylistRevision: previous.revision,
    title: 'Same first image, revised playlist', mode: previous.mode, intervalSeconds: 60, items: previous.items,
  }), 'save active playlist revision with the same first image');
  receipts.push({ label: 'revise-active-playlist-same-first-image', previous, result: revised });
  assert.equal(revised.revision, previous.revision + 1);
  assert.deepEqual(revised.items[0], fixed(fixture.images[0]));
  let current = await mirrorRunning(playlist, 'image', 0, 'new playlist revision actually presented by every member', revised.revision);
  for (const target of targets(current)) {
    assert.equal(target.playlist.title, revised.title); assert.equal(target.playlist.intervalSeconds, 60);
    assert.deepEqual(target.playlist.current, fixed(fixture.images[0]));
    const old = targets(before).find(item => item.targetId === target.targetId);
    assert.notEqual(binding(target).sessionId, binding(old).sessionId, 'same bytes in a new playlist source use a freshly acknowledged native controller');
    assert.ok(target.mirror.clockToken > old.mirror.clockToken);
  }
  await captureMembers(current, 'playlist-revision-same-first', 'image', fixture.images[0]);
  assert.equal(fs.readFileSync(configFile, 'utf8'), configurationBytes, 'saving and presenting a playlist revision does not rewrite settings');
  assert.equal(ok(await api('wallpaper.playlist.next', { playlistId: playlist.playlistId, groupId }), 'next after same-first playlist revision').pendingIndex, 1);
  current = await mirrorRunning(playlist, 'image', 1, 'group next succeeds after revised first image', revised.revision);
  await captureMembers(current, 'playlist-revision-next', 'image', fixture.images[1]);
  assert.equal(fs.readFileSync(configFile, 'utf8'), configurationBytes);
  if (hardware.monitorCount >= 2) hardware.simultaneousPlaylistRevision = 'passed';
  mark('an active playlist revision with unchanged first-image bytes finishes fresh member acknowledgements, then groupId next succeeds');

  const retained = current, wallpaper = structuredClone(domain(stored()).wallpaper);
  wallpaper.groups[0].presentation.brightness = 0.72;
  const revision = stored().revision;
  await commit(wallpaper, 'apply-brightness-at-playlist-index-one');
  current = await mirrorRunning(playlist, 'image', 1, 'presentation Apply retains the current second image and finishes member tickets', revised.revision);
  for (const target of targets(current)) {
    assert.deepEqual(target.playlist.current, fixed(fixture.images[1]));
    assert.equal(target.mirror.token, targets(retained).find(item => item.targetId === target.targetId).mirror.token, 'presentation-only Apply keeps the current shared switch');
    assert.equal(target.brightness, 0.72);
    const page = await renderer(binding(target));
    assert.equal(await page.evaluate(() => window.hertzWallpaper.debug().brightness), 0.72);
  }
  assert.equal(stored().revision, revision + 1);
  await captureMembers(current, 'playlist-current-item-presentation-apply', 'image', fixture.images[1]);
  snapshot('playlist-current-item-apply-status', { before: retained, after: current });
  if (hardware.monitorCount >= 2) hardware.simultaneousPresentationApply = 'passed';
  mark('brightness Apply at playlist index one retains the exact second version and completes every native member ticket');

  if (fixture.video) {
    const mixed = await savePlaylist('Active image then video, whole-list admission', [fixture.images[0], fixture.video], 60);
    const nextWallpaper = structuredClone(domain(stored()).wallpaper); nextWallpaper.groups = [group(mixed, displays)];
    await commit(nextWallpaper, 'apply-image-video-playlist-two-members');
    const active = await mirrorRunning(mixed, 'image', 0, 'image-video playlist first image active with two configured members');
    assert.ok(targets(active).every(target => target.playlist.itemCount === 2 && target.playlist.currentIndex === 0));
    const three = [...displays, { kind: 'fixed', displayId: 'native-resume-third-offline-' + crypto.randomUUID() }];
    await inspect(mixed, 3, false, 2, 'active-image-video-playlist-three-member-inspection');
    await rejectBeforeCommit(mixed, three, 'reject-three-member-active-image-video-playlist');
    const unchanged = await mirrorRunning(mixed, 'image', 0, 'rejected resize preserves the active image-video playlist');
    assert.deepEqual(runtimeIdentity(unchanged), runtimeIdentity(active));
    assert.equal(domain(stored()).wallpaper.groups[0].displays.length, 2);
    mark('expanding an active image-first/video-later playlist from two to three configured members rejects before commit even when resuming its image');
  }
}

async function videoSample(page) {
  return page.evaluate(() => {
    const debug = window.hertzWallpaper.debug(), video = document.querySelector('video[data-wallpaper-media="video"]');
    return { at: performance.now(), debug, timeMs: video ? video.currentTime * 1000 : null,
      durationMs: video ? video.duration * 1000 : null, seeking: video?.seeking,
      frames: video?.getVideoPlaybackQuality().totalVideoFrames };
  });
}
function circularDrift(position, target, duration) {
  const positive = ((position - target) % duration + duration) % duration;
  return positive > duration / 2 ? positive - duration : positive;
}
async function videoChecks(displays) {
  if (!fixture.video) return;
  const wallpaper = structuredClone(domain(stored()).wallpaper); wallpaper.groups = [group(fixture.video, displays)];
  await commit(wallpaper, 'apply-real-video-mirror');
  const current = await mirrorRunning(fixture.video, 'video', 0, 'video held first frames released by native group clock');
  await captureMembers(current, 'video-mirror', 'video', fixture.video);
  const videoPages = await Promise.all(targets(current).map(target => renderer(binding(target))));
  const configurationBytes = fs.readFileSync(configFile, 'utf8');
  const identity = runtimeIdentity(current), samples = [];
  for (let index = 0; index < videoPages.length; index++) {
    const page = videoPages[index], start = await videoSample(page);
    const priorSyncs = start.debug.media.clock.syncs;
    const first = await until(async () => {
      const sample = await videoSample(page);
      return sample.debug.media.clock.syncs > priorSyncs && !sample.debug.media.clock.aligning ? sample : null;
    }, 'first observed native periodic video sync', 7000);
    const second = await until(async () => {
      const sample = await videoSample(page);
      return sample.debug.media.clock.syncs > first.debug.media.clock.syncs && !sample.debug.media.clock.aligning ? sample : null;
    }, 'second native periodic video sync', 7000);
    const accepted = second.debug.media.clock.syncs - first.debug.media.clock.syncs;
    const interval = second.debug.media.clock.lastSyncAtMs - first.debug.media.clock.lastSyncAtMs;
    assert.ok(interval >= 1990 * accepted, 'native group does not synchronize faster than every two seconds: ' + interval);
    assert.ok(interval <= 4500 * accepted, 'native group keeps its two-second cadence within a bounded scheduling window: ' + interval);
    const perturbed = await page.evaluate(() => {
      const video = document.querySelector('video[data-wallpaper-media="video"]'), debug = window.hertzWallpaper.debug();
      const before = video.currentTime * 1000, duration = video.duration * 1000, offset = Math.min(600, duration / 3);
      if (!(duration > 600)) throw new Error('Video fixture must be longer than 600ms to inject a measurable >100ms drift');
      video.currentTime = ((before + offset) % duration) / 1000;
      return { beforeMs: before, requestedMs: (before + offset) % duration, offsetMs: offset,
        clock: debug.media.clock, at: performance.now() };
    });
    assert.ok(perturbed.offsetMs > 100, 'the actual media element receives more than 100ms drift');
    const corrected = await until(async () => {
      const sample = await videoSample(page), clock = sample.debug.media?.clock;
      assert.equal(sample.debug.media?.state, 'ready', 'video stays healthy while correcting injected drift');
      if (!clock || clock.corrections <= perturbed.clock.corrections || clock.syncs <= perturbed.clock.syncs
        || clock.aligning || sample.seeking || clock.held || sample.debug.media.paused) return null;
      assert.ok(Number.isFinite(clock.driftMs) && Math.abs(clock.driftMs) <= 100, 'real aligned video frame lands within 100ms of group time');
      assert.ok(sample.frames > second.frames, 'real video frames continue after correction');
      return sample;
    }, 'native periodic sync corrects actual >100ms video drift on member ' + index, 8500);
    samples.push({ targetId: targets(current)[index].targetId, start, first, second, intervalMs: interval, perturbed, corrected });
  }
  assert.deepEqual(runtimeIdentity(await status()), identity, 'clock correction keeps current native sessions, tickets and group selection');
  assert.equal(fs.readFileSync(configFile, 'utf8'), configurationBytes);
  if (hardware.monitorCount >= 2) {
    hardware.simultaneousVideoFrames = 'passed';
    // Read each independent page against its wall clock and project to one instant.
    // This is measured display playback evidence; it never fabricates native readiness receipts.
    const pair = await until(async () => {
      const values = await Promise.all(videoPages.map(page => page.evaluate(() => {
        const debug = window.hertzWallpaper.debug(), video = document.querySelector('video[data-wallpaper-media="video"]');
        return { wallMs: Date.now(), timeMs: video.currentTime * 1000, durationMs: video.duration * 1000,
          paused: video.paused, seeking: video.seeking, clock: debug.media.clock };
      })));
      if (values.some(value => value.paused || value.seeking || value.clock.aligning || value.clock.held)) return null;
      const at = Math.max(...values.map(value => value.wallMs));
      const projected = values.map(value => (value.timeMs + at - value.wallMs) % value.durationMs);
      const deviationMs = Math.abs(circularDrift(projected[0], projected[1], values[0].durationMs));
      return deviationMs <= 200 ? { values, projected, at, deviationMs } : null;
    }, 'two real monitors reconstruct one video clock within the two 100ms member tolerances', 7000);
    hardware.crossMonitorVideoClock = 'passed'; snapshot('video-cross-monitor-clock', pair);
  }
  snapshot('video-clock-corrections', samples);
  mark('real video first frames remain held until native release; native two-second syncs correct injected >100ms drift using decoded frames');
  await videoPauseResumeChecks();
  await videoFailureRetryChecks();
  await videoFailureRetryChecks('apply');
  await videoPlaylistReloadChecks(displays);
}

async function videoPlaylistReloadChecks(displays) {
  const playlist = await savePlaylist('Mirror video revision', [fixture.video, fixture.video], 86400);
  const wallpaper = structuredClone(domain(stored()).wallpaper); wallpaper.groups = [group(playlist, displays)];
  await commit(wallpaper, 'apply-video-playlist');
  const initial = await mirrorRunning(playlist, 'video', 0, 'video playlist initial shared release');
  const snapshotBefore = ok(await api('wallpaper.playlist.get', { playlistId: playlist.playlistId }), 'read video playlist revision');
  const revised = ok(await api('wallpaper.playlist.save', { playlistId: playlist.playlistId,
    expectedPlaylistRevision: snapshotBefore.revision, title: snapshotBefore.title + ' revised',
    mode: snapshotBefore.mode, intervalSeconds: snapshotBefore.intervalSeconds, items: snapshotBefore.items }), 'save live video playlist revision');
  const reloaded = await until(async () => {
    const state = await status();
    if (!targets(state).every(target => target.playlist?.playlistRevision === revised.revision)) return null;
    return state;
  }, 'revised video playlist snapshot installed', 45000);
  const playing = await mirrorRunning(playlist, 'video', 0, 'video revision releases old decoder before requalification');
  assert.ok(targets(playing).every(target => !target.applyError && target.visible));
  for (const target of targets(playing)) {
    assert.notEqual(binding(target).sessionId, binding(targets(initial).find(old => old.targetId === target.targetId)).sessionId);
  }
  ok(await api('wallpaper.playlist.next', { playlistId: playlist.playlistId, groupId }), 'video playlist next after revision');
  const next = await mirrorRunning(playlist, 'video', 1, 'next video finishes old-controller exit before qualification');
  snapshot('video-playlist-revision', { initial, reloaded, playing, next });
  mark('a live video playlist revision and subsequent next both finish fresh native member releases after old controllers retire');
}

async function videoPauseResumeChecks() {
  const before = await mirrorRunning(fixture.video, 'video', 0, 'video before short native pause');
  const active = targets(before), videoPages = await Promise.all(active.map(target => renderer(binding(target))));
  const configurationBytes = fs.readFileSync(configFile, 'utf8');
  try {
    for (const page of videoPages) await page.evaluate(() => {
      // Observe only calls made by native. Forward the unmodified request and
      // return value; this audit never calls a clock method or sends a receipt.
      const api = window.hertzWallpaper;
      const audit = window.__mirrorClockAudit = { calls: [], originals: {} };
      for (const method of ['revealMediaClock', 'syncMediaClock']) {
        const original = audit.originals[method] = api[method];
        api[method] = function (request) {
          const entry = { method, wallMs: Date.now(), atMs: performance.now(), request: { ...request } };
          entry.accepted = original.apply(this, arguments);
          audit.calls.push(entry); if (audit.calls.length > 32) audit.calls.shift();
          return entry.accepted;
        };
      }
    });
    const auditCalls = () => Promise.all(videoPages.map(page => page.evaluate(() => window.__mirrorClockAudit.calls)));
    await until(async () => (await auditCalls()).every(calls => calls.some(call => call.method === 'syncMediaClock' && call.accepted)), 'native clock sample on every video before pause', 7000);
    const running = await Promise.all(videoPages.map(videoSample));
    const hideAt = Date.now();
    await native({ command: 'wallpaper-hide' });
    const paused = await until(async () => {
      const state = await status();
      return targets(state).length === active.length && targets(state).every(target => target.hidden && !target.visible
        && target.mediaPauseConfirmed === true && target.mirror.currentIndex === 0) ? state : null;
    }, 'native confirms every video clock and decoded-frame counter stopped', 7000);
    const frozen = await Promise.all(videoPages.map(videoSample)), frozenAt = Date.now();
    const pauseSamples = [];
    while (Date.now() - frozenAt < 2600) {
      const samples = await Promise.all(videoPages.map(videoSample));
      for (const [index, sample] of samples.entries()) {
        assert.equal(sample.debug.media.state, 'ready'); assert.equal(sample.debug.media.paused, true);
        assert.equal(sample.debug.media.clock.held, true);
        assert.ok(Math.abs(sample.timeMs - frozen[index].timeMs) <= 1, 'the real paused video position stays frozen');
        assert.equal(sample.frames, frozen[index].frames, 'the real decoded-frame counter stays frozen');
      }
      assert.equal(fs.readFileSync(configFile, 'utf8'), configurationBytes);
      pauseSamples.push({ elapsedMs: Date.now() - frozenAt, members: samples.map(sample => ({ timeMs: sample.timeMs, frames: sample.frames })) });
      await delay(200);
    }
    const lastBeforeResume = (await auditCalls()).map(calls => calls.filter(call => call.accepted).at(-1));
    const showAt = Date.now();
    await native({ command: 'wallpaper-show' });
    const resumed = await mirrorRunning(fixture.video, 'video', 0, 'video resume completes fresh typed native clock releases');
    const sampled = await Promise.all(videoPages.map(videoSample)), calls = await auditCalls();
    const continuity = [];
    for (const [index, old] of active.entries()) {
      const target = targets(resumed).find(target => target.targetId === old.targetId), sample = sampled[index];
      assert.deepEqual(binding(target), binding(old), 'short pause resumes the existing native video controller');
      assert.equal(target.mirror.token, old.mirror.token, 'short pause preserves the current group item');
      assert.ok(target.mirror.memberGeneration > old.mirror.memberGeneration, 'resume issues a fresh member ticket');
      assert.ok(target.mirror.clockToken > old.mirror.clockToken, 'resume renews its typed clock token');
      assert.equal(sample.debug.media.clock.token, target.mirror.clockToken);
      assert.ok(sample.debug.media.clock.releases > running[index].debug.media.clock.releases, 'the new token completed an actual decoded-frame release');
      assert.equal(sample.debug.media.paused, false); assert.equal(sample.debug.media.clock.held, false);
      const release = calls[index].find(call => call.method === 'revealMediaClock' && call.accepted
        && call.wallMs >= showAt && call.request.token === target.mirror.clockToken);
      assert.ok(release, 'native sent the fresh token through the trusted reveal method');
      const previous = lastBeforeResume[index];
      assert.ok(previous?.accepted);
      const groupAdvanceMs = release.request.timeMs - previous.request.timeMs;
      const wallAdvanceMs = release.wallMs - previous.wallMs;
      const excludedPauseMs = wallAdvanceMs - groupAdvanceMs;
      assert.ok(groupAdvanceMs >= 0, 'unwrapped group content time never resets during pause/resume');
      assert.ok(excludedPauseMs >= showAt - frozenAt - 250, 'group time excludes the measured frozen interval');
      assert.ok(excludedPauseMs <= showAt - hideAt + 750, 'group time excludes the pause without discarding an unrelated active interval');
      const expectedPhaseMs = (release.request.timeMs + Math.max(0, sample.at - release.request.pageDispatchMs)) % sample.durationMs;
      const phaseErrorMs = Math.abs(circularDrift(sample.timeMs, expectedPhaseMs, sample.durationMs));
      assert.ok(phaseErrorMs <= 200, 'the resumed real video follows the retained native content phase');
      continuity.push({ targetId: target.targetId, oldClockToken: old.mirror.clockToken, clockToken: target.mirror.clockToken,
        previous, release, groupAdvanceMs, wallAdvanceMs, excludedPauseMs, expectedPhaseMs, phaseErrorMs });
    }
    await delay(450);
    const progressed = await Promise.all(videoPages.map(videoSample));
    for (const [index, sample] of progressed.entries()) {
      assert.equal(sample.debug.media.paused, false);
      assert.ok(sample.frames > sampled[index].frames, 'real frames advance after the typed resume release');
      const activeElapsedMs = sample.at - sampled[index].at;
      assert.ok(Math.abs(circularDrift(sample.timeMs, sampled[index].timeMs + activeElapsedMs, sample.durationMs)) <= 200,
        'resumed video dt follows active elapsed time without adding the hidden interval');
    }
    assert.equal(fs.readFileSync(configFile, 'utf8'), configurationBytes);
    snapshot('video-pause-resume-continuity', { before, paused, resumed, hideAt, frozenAt, showAt, frozen,
      pauseSamples, continuity, resumedSamples: sampled, progressed });
    if (hardware.monitorCount >= 2) hardware.simultaneousVideoResume = 'passed';
    mark('real video pause freezes positions and frames; show renews typed member tokens and resumes the retained group phase without hidden-time catch-up or configuration writes');
  } finally {
    const observed = [];
    for (const [index, page] of videoPages.entries()) if (!page.isClosed()) {
      try { observed.push({ targetId: active[index].targetId, calls: await page.evaluate(() => window.__mirrorClockAudit?.calls || []) }); }
      catch { /* a failed controller can close before diagnostics are sampled */ }
    }
    snapshot('video-pause-native-clock-calls', observed);
    for (const page of videoPages) if (!page.isClosed()) await page.evaluate(() => {
      const audit = window.__mirrorClockAudit;
      if (audit) for (const [method, original] of Object.entries(audit.originals)) window.hertzWallpaper[method] = original;
      delete window.__mirrorClockAudit;
    }).catch(() => {});
  }
}

async function videoFailureRetryChecks(recovery = 'retry') {
  const before = await mirrorRunning(fixture.video, 'video', 0, 'healthy video before missing-resource failure');
  const affected = targets(before)[0], failedPage = await renderer(binding(affected));
  const configurationBytes = fs.readFileSync(configFile, 'utf8');
  const poster = ok(await api('wallpaper.library.poster', fixed(fixture.video)), 'read verified video poster before failure').poster;
  assert.ok(poster?.width > 0 && poster?.height > 0 && typeof poster.data === 'string', 'the actual qualified video has a verified poster');
  const posterHash = hash(Buffer.from(poster.data, 'base64'));
  const missingUrl = packageOrigin(fixture.video.packageHash) + '/files/assets/native-mirror-missing-' + crypto.randomUUID() + '.webm';
  const browserErrors = [], network = [], prefix = 'MIRROR_NATIVE_MEDIA_ERROR ';
  const recordConsole = message => {
    const text = message.text();
    if (text.startsWith(prefix)) browserErrors.push(JSON.parse(text.slice(prefix.length)));
  };
  const recordResponse = response => { if (response.url() === missingUrl) network.push({ url: response.url(), status: response.status() }); };
  failedPage.on('console', recordConsole); failedPage.on('response', recordResponse);
  let injection = null;
  try {
    injection = await failedPage.evaluate(({ url, prefix }) => {
      const video = document.querySelector('video[data-wallpaper-media="video"]');
      if (!video || video.paused || video.error) throw new Error('Fault injection requires a healthy playing native video');
      const prior = { url: video.currentSrc, timeMs: video.currentTime * 1000, frames: video.getVideoPlaybackQuality().totalVideoFrames };
      // This makes a real reserved-origin request fail. The browser creates the
      // trusted error event and the production media handler sends its own IPC.
      video.addEventListener('error', event => console.info(prefix + JSON.stringify({
        isTrusted: event.isTrusted, code: video.error?.code, source: video.currentSrc,
        requested: video.getAttribute('src'), at: performance.now(),
      })), { capture: true, once: true });
      video.src = url; video.load();
      return { prior, requested: url, mechanism: 'CDP changes only HTMLVideoElement.src; a real missing reserved resource causes the browser media error' };
    }, { url: missingUrl, prefix });
    await until(() => browserErrors.length > 0 && network.some(response => response.status === 404), 'actual missing reserved resource and trusted browser media error', 7000);
    assert.equal(browserErrors[0].isTrusted, true, 'failure is a browser-generated error, not a synthetic DOM event');
    assert.ok(Number.isInteger(browserErrors[0].code) && browserErrors[0].code > 0);
    assert.equal(browserErrors[0].requested, missingUrl);
    const failed = await until(async () => {
      const state = await status(), members = targets(state), target = members.find(target => target.targetId === affected.targetId);
      if (members.length !== targets(before).length || !drained(state) || state.wallpaper.budget.decoderSlots !== 0
        || !members.every(target => target.mirror?.failed && target.visible && !target.candidateLoading && !target.selectionPreparing)) return null;
      return target?.staticPoster && target.firstFrameReady && target.pageReady && target.session?.frameKind === 'image'
        && !target.handoff ? state : null;
    }, 'failed Mirror group retains its verified native-visible static poster and drains video decoders', 30000);
    const posterTarget = targets(failed).find(target => target.targetId === affected.targetId);
    assert.match(posterTarget.applyError, /wallpaper_media_failed media_error_[1-4]/);
    const posterPage = await renderer(binding(posterTarget));
    const rendered = await posterPage.evaluate(async () => {
      const debug = window.hertzWallpaper.debug(), image = document.querySelector('img[data-wallpaper-media="image"]');
      const response = await fetch(debug.media.url, { signal: AbortSignal.timeout(5000) });
      return { debug, decoded: image && { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight },
        status: response.status, bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
    });
    assert.equal(rendered.debug.media.kind, 'image'); assert.equal(rendered.debug.media.state, 'ready');
    assert.equal(rendered.debug.session.revealed, true); assert.equal(rendered.status, 200);
    assert.ok(rendered.debug.media.url.startsWith(packageOrigin(fixture.video.packageHash) + '/files/'));
    assert.deepEqual(rendered.decoded, { complete: true, width: poster.width, height: poster.height });
    assert.equal(hash(Buffer.from(rendered.bytes)), posterHash, 'fallback actually decodes the exact verified poster bytes');
    delete rendered.bytes;
    await capture(posterPage, 'video-failure-static-poster');
    const retainedAt = Date.now();
    while (Date.now() - retainedAt < 1200) {
      const state = await status(), target = targets(state).find(target => target.targetId === affected.targetId);
      assert.ok(targets(state).every(target => target.mirror.failed && target.visible), 'failure retains visible content on every connected member');
      assert.equal(target.staticPoster, true); assert.equal(target.firstFrameReady, true);
      assert.deepEqual(binding(target), binding(posterTarget), 'the verified poster survives later native policy ticks');
      assert.equal(fs.readFileSync(configFile, 'utf8'), configurationBytes);
      await delay(150);
    }
    snapshot('video-real-error-poster', { injection, browserErrors, network, before, failed,
      verifiedPoster: { width: poster.width, height: poster.height, sha256: posterHash }, rendered });
    if (hardware.monitorCount >= 2) hardware.simultaneousFailureRetention = 'passed';
    if (recovery === 'apply') {
      const wallpaper = structuredClone(domain(stored()).wallpaper);
      wallpaper.groups[0].presentation.brightness = 0.88;
      await commit(wallpaper, 'apply-failed-video-with-same-selection');
    } else await native({ command: 'wallpaper-retry' });
    await until(async () => targets(await status()).every(target => target.mirror?.failed === false && !target.applyError), 'explicit native retry clears failure after actual replacement', 45000);
    const retried = await mirrorRunning(fixture.video, 'video', 0, 'real video recovers after native wallpaper-retry');
    for (const target of targets(retried)) {
      const old = targets(before).find(item => item.targetId === target.targetId);
      assert.equal(target.staticPoster, false); assert.ok(target.mirror.clockToken > old.mirror.clockToken);
      assert.notEqual(binding(target).sessionId, binding(old).sessionId, 'retry loads the original video in a fresh native controller');
    }
    await until(() => failedPage.isClosed() && posterPage.isClosed(), 'failed and fallback controllers close after actual video recovery', 10000);
    await captureMembers(retried, 'video-retry-recovered', 'video', fixture.video);
    if (recovery === 'retry') assert.equal(fs.readFileSync(configFile, 'utf8'), configurationBytes);
    mark('a real reserved-resource 404 retains its verified native-visible poster; ' + recovery + ' restores video and clears the shared group failure');
  } finally {
    snapshot('video-failure-browser-events', { injection, browserErrors, network });
    failedPage.removeListener('console', recordConsole); failedPage.removeListener('response', recordResponse);
  }
}

async function disableAndDrain(label = 'disable-owned-mirror') {
  if (cleanupDone) return;
  if (activeDraft) {
    ok(await api('wallpaper.draft.discard', reference(activeDraft)), 'discard outstanding check draft for cleanup'); activeDraft = null;
  }
  const wallpaper = structuredClone(domain(stored()).wallpaper); wallpaper.enabled = false;
  await commit(wallpaper, label);
  const state = await until(async () => {
    const state = await status(), budget = state.wallpaper.budget;
    const amounts = ['targets', 'contexts', 'decoderSlots', 'previewInstances', 'decodePixelRate', 'outputPixelRate',
      'cpuBytes', 'prepareCpuBytes', 'assetCpuBytes', 'gpuBytes', 'prepareTasks', 'releasePending',
      'sessionReservations', 'resourceAllocations', 'resourceReleasePending'];
    return drained(state) && !state.wallpaper.mediaPreview
      && targets(state).every(target => !target.session && !target.handoff && !target.candidateLoading && !target.selectionPreparing)
      && amounts.every(key => budget[key] === 0) ? state : null;
  }, 'all owned Mirror controllers, decoders, allocations and exit queues drain', 30000);
  await until(() => !pages().some(page => /\/(?:wallpaper|wallpaper-probe)\.html/.test(page.url())), 'real media WebViews close after disable', 10000);
  const resources = ok(await api('wallpaper.status'), 'final resource owner status');
  assert.equal(resources.decoderSlots, 0); assert.equal(resources.prepareTasks, 0); assert.equal(resources.pendingFileSelection, false);
  assert.equal(resources.activeJob, null, 'no import or export job survives cleanup');
  const final = { status: state, resources }; snapshot(label, final); cleanupDone = true;
  mark('disable closes every owned media WebView and drains native target, decoder, CPU/GPU and pending release allocations');
}

async function main() {
  assert.equal(process.platform, 'win32', 'this check requires Windows and a built native host');
  assert.ok(fs.existsSync(binary), 'build hertz-desktop --features wallpaper-media-probe first or set HERTZ_DESKTOP_BIN');
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536, 'DESKTOP_CDP_PORT must be a TCP port');
  // Read-only refusal: never attach to, reconfigure, or close an existing host.
  try { await requestManagement(pipe, { command: 'status' }); throw new Error('A desktop host is already running; close it before this isolated native check.'); }
  catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  fs.mkdirSync(output, { recursive: true });
  const lyrics = { enabled: false, locked: false, layout: 'double', secondary: 'next', fontFamily: 'Segoe UI', fontSize: 32,
    fontWeight: 600, sungColor: '#ffffff', unsungColor: '#ffffff', outlineColor: '#000000', outlineWidth: 1,
    opacity: 1, width: 550, anchorX: 0.5, anchorY: 0.5, monitor: null };
  const wallpaper = { enabled: true, audioInput: { kind: 'none' }, batteryPolicy: 'pause', pauseOnFullscreen: false,
    pauseOnMaximized: false, applicationRules: [], groups: [group({ kind: 'builtin', sceneId: 'coast', stateVersion: 1, params: {} }, [{ kind: 'primary' }], 'single', 'native-bootstrap')] };
  fs.writeFileSync(configFile, JSON.stringify({ schemaVersion: 5, revision: 1, launchAtLogin: false,
    activeProfile: null, profiles: [], unboundDomain: { wallpaper, lyrics }, lastCommit: null }, null, 2));
  await start();
  const initial = await settingsSnapshot();
  hardware.monitors = initial.monitors; hardware.monitorCount = hardware.monitors.length;
  assert.ok(hardware.monitorCount > 0, 'at least one connected real monitor is required');
  assert.equal(hardware.monitors.filter(monitor => monitor.primary).length, 1, 'one unambiguous primary monitor');
  assert.equal(new Set(hardware.monitors.map(monitor => monitor.displayId)).size, hardware.monitorCount);
  assert.ok(!hardware.monitors.some(monitor => monitor.displayId === offlineDisplayId));
  const primary = hardware.monitors.find(monitor => monitor.primary);
  const second = hardware.monitors.find(monitor => monitor.displayId !== primary.displayId);
  hardware.exercisedDisplayIds = [primary.displayId, ...(second ? [second.displayId] : [])];
  const displays = [{ kind: 'primary' }, { kind: 'fixed', displayId: second?.displayId || offlineDisplayId }];
  if (!second) {
    const reason = 'Only one real monitor is connected. Primary plus an offline Fixed member verifies persisted Mirror intent and one real native presentation; simultaneous hardware behavior remains unverified.';
    for (const key of ['simultaneousImageFrames', 'simultaneousPlaylistSwitch', 'simultaneousPlaylistRevision',
      'simultaneousPresentationApply', 'simultaneousVideoFrames', 'crossMonitorVideoClock', 'simultaneousVideoResume', 'simultaneousFailureRetention']) {
      hardware[key] = 'skipped'; skip(key, reason);
    }
  }
  const capabilities = ok(await api('wallpaper.capabilities'), 'native capabilities');
  assert.deepEqual([...capabilities.layouts].sort(), ['mirror', 'single', 'span']);
  assert.equal(capabilities.mirrorInspection, true);
  for (const key of ['mirrorBuiltin', 'mirrorPackages', 'mirrorPlaylists']) assert.equal(capabilities[key], false, 'generic type flags do not certify actual content');
  snapshot('hardware', { ...hardware, configuredDisplays: displays, capabilities });
  console.log('Real monitor count: ' + hardware.monitorCount + '; active members: ' + hardware.exercisedDisplayIds.length + '; output: ' + output);
  await seedFixtures();
  await imageAndPlaylistChecks(displays);
  await videoChecks(displays);
  const ordered = monitors => [...monitors].sort((a, b) => a.displayId.localeCompare(b.displayId));
  assert.deepEqual(ordered((await settingsSnapshot()).monitors), ordered(hardware.monitors), 'OS monitor topology stays unchanged');
  await capture(settings, 'settings');
  await disableAndDrain();
  assert.deepEqual(pageErrors, []);
}

function report(passed, extra = {}) {
  fs.mkdirSync(output, { recursive: true });
  const value = { passed, output, binary, binarySha256: fs.existsSync(binary) ? hash(fs.readFileSync(binary)) : null,
    requiredFeature: 'wallpaper-media-probe (debug)', checks, skipped, hardware, fixture, receipts, evidence, pageErrors, cleanupDone,
    scope: 'Owned Windows host and real WebView2 media/native receipts; ordinary settings drafts and Apply for Mirror. Offline Fixed members are intent coverage, never multi-monitor hardware acceptance. No topology mutation or fabricated ready/reveal receipt.', ...extra };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(value, null, 2));
  return value;
}
main().then(async () => {
  await stop(); report(true);
  console.log(JSON.stringify({ passed: true, output, checks, skipped, hardware }, null, 2));
}).catch(async error => {
  fs.mkdirSync(output, { recursive: true });
  let cleanupError = null, stopError = null;
  if (child && child.exitCode === null && child.signalCode === null) {
    try { snapshot('failure-status', await status()); } catch { /* host may already be exiting */ }
    if (browser) {
      for (const [index, page] of pages().entries()) {
        try {
          if (page.url().includes('/wallpaper.html')) snapshot('failure-renderer-' + index, await page.evaluate(() => window.hertzWallpaper?.debug()));
          await capture(page, 'failure-page-' + index);
        } catch { /* retain the original failure if a controller is closing */ }
      }
    }
    if (settings && !settings.isClosed()) {
      try { await disableAndDrain('failure-cleanup-disable'); } catch (failure) { cleanupError = failure.stack; }
    }
  }
  try { await stop(); } catch (failure) { stopError = failure.stack; }
  report(false, { error: error.stack, cleanupError, stopError });
  console.error(error); console.error('Native Mirror evidence: ' + output); process.exitCode = 1;
});
