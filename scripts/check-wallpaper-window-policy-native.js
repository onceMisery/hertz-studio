// SPDX-License-Identifier: MIT
// Real foreground Win32 window + isolated WebView2 policy and lifecycle regression.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const requestManagement = require('./desktop-native-management-client');
const { buildZip } = require('./check-wallpaper-media-native');
const root = path.resolve(__dirname, '..');
const binary = path.resolve(process.env.HERTZ_DESKTOP_BIN || path.join(root, 'target/debug/hertz-desktop.exe'));
const output = path.join(root, 'output/playwright/wallpaper-window-policy-native-' + Date.now());
const configFile = path.join(output, 'config.json');
const port = Number(process.env.DESKTOP_CDP_PORT || 19578);
const pipe = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
const checks = [], errors = [], evidence = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const ref = draft => ({ draftId: draft.draftId, draftRevision: draft.draftRevision });
const saved = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
const wallpaper = () => structuredClone(saved().unboundDomain.wallpaper);
let host, fixture, browser, settings, sequence = 0, windowSequence = 0, spawnError;
async function nativeRequest(pipeName, request) {
  for (let attempt = 0; ; attempt++) {
    try { return await requestManagement(pipeName, request); }
    catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code) || attempt >= 20) throw error;
      await delay(50);
    }
  }
}
async function until(read, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    for (const child of [host, fixture]) if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error('Owned process exited: ' + label);
    const result = await read(); if (result) return result;
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
}
const status = () => nativeRequest(pipe, { command: 'status' });
const target = state => state.wallpaper.targets[0];
const reasons = state => target(state)?.diagnostics.pauseReasons || [];
const binding = state => target(state)?.session?.binding;
const pages = () => browser.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed());
async function renderer(nativeBinding) {
  return until(async () => {
    for (const page of pages().filter(page => page.url().includes('/wallpaper.html'))) {
      try { if (await page.evaluate(identity => window.hertzWallpaper?.debug().session?.sessionId === identity, nativeBinding.sessionId)) return page; }
      catch (error) { if (!page.isClosed() && !/Execution context was destroyed|Cannot find context|has been closed/i.test(error.message)) throw error; }
    }
    return null;
  }, 'renderer for native session');
}
const mark = text => { checks.push(text); console.log('PASS ' + text); };
function snapshot(name, value) {
  fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(value, null, 2)); evidence.push(name + '.json');
}
function ok(receipt) { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt.result; }
async function api(command, payload = {}, expectedRevision) {
  return settings.evaluate(async request => {
    try { return await hertzWallpaperSettings.requestManagement(request.command, request.payload, request.requestId, request.expectedRevision); }
    catch (error) { return error.receipt || { ok: false, error: { code: error.code, message: error.message } }; }
  }, { command, payload, expectedRevision, requestId: 'window-policy-' + Date.now() + '-' + (++sequence) });
}
async function commit(next) {
  const draft = ok(await api('wallpaper.draft.create', { kind: 'settings' }));
  const updated = ok(await api('wallpaper.draft.update', { ...ref(draft), operations: [{ kind: 'replaceWallpaper', wallpaper: next }] }));
  const result = ok(await api('wallpaper.apply', ref(updated), draft.baseRevision));
  assert.equal(result.saved, true); assert.equal(saved().revision, draft.baseRevision + 1);
}
async function windowMode(mode, title) {
  const sequence = ++windowSequence;
  fs.writeFileSync(path.join(output, 'window-command.json'), JSON.stringify({ sequence, mode, title }));
  const state = await until(() => {
    try { const state = JSON.parse(fs.readFileSync(path.join(output, 'window-state.json'), 'utf8')); return state.sequence === sequence && state; } catch { return false; }
  }, 'actual fixture ' + mode);
  assert.equal(state.pid, fixture.pid);
  if (mode !== 'minimized') assert.equal(state.foreground, true, 'real fixture must own foreground');
  assert.equal(state.maximized, mode === 'maximized');
  assert.equal(state.minimized, mode === 'minimized');
  return state;
}
async function running(label) {
  return until(async () => {
    const state = await status(), current = target(state);
    return current?.visible && current.firstFrameReady && !current.candidateLoading && !current.selectionPreparing
      && !state.wallpaper.retiringControllers && !state.wallpaper.retiringHandoffs && !current.handoff && state;
  }, label);
}
async function paused(reason) {
  return until(async () => { const state = await status(); return reasons(state).includes(reason) && !target(state).visible && state; }, reason);
}
async function released() {
  return until(async () => {
    const state = await status(), current = target(state), budget = state.wallpaper.budget;
    return current?.applicationRule === 'stop' && !current.session && !current.handoff && !current.candidateLoading && !current.selectionPreparing
      && !state.wallpaper.retiringControllers && !state.wallpaper.retiringHandoffs
      && budget.targets === 0 && budget.contexts === 0 && budget.decoderSlots === 0
      && budget.releasePending === 0 && budget.resourceReleasePending === 0 && state;
  }, 'Stop releases real renderer and budget');
}
async function importVideo() {
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/wallpaper-vp8.webm'));
  const assetPath = 'assets/background.webm', workId = crypto.randomUUID();
  const manifest = { formatVersion: 1, workId, version: 1, title: 'Window policy video', description: '',
    content: { kind: 'video', asset: 'background' }, assets: [{ id: 'background', kind: 'video', source: assetPath, variants: [] }],
    files: [{ path: assetPath, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), mime: 'video/webm' }],
    properties: [], permissions: { audioSpectrum: false, pointer: false }, license: { code: 'none', assets: 'CC0-1.0', attribution: '' } };
  const packageBytes = buildZip([['manifest.json', Buffer.from(JSON.stringify(manifest))], [assetPath, bytes]]);
  fs.mkdirSync(path.join(output, 'probe-inputs'), { recursive: true });
  fs.writeFileSync(path.join(output, 'probe-inputs/policy-video.hwpkg'), packageBytes);
  const page = await renderer(binding(await status()));
  await page.evaluate(() => window.ipc.postMessage('wallpaper_probe_import ' + JSON.stringify({ nonce: 1, action: 'begin', name: 'policy-video' })));
  await page.waitForFunction(() => !!window.__nativeImportProbes?.[1], null, { timeout: 60000 });
  const imported = await page.evaluate(() => window.__nativeImportProbes[1]);
  assert.equal(imported.state, 'done', JSON.stringify(imported));
  assert.equal(imported.decoderSlots, 0); assert.equal(imported.activeStreams, 0);
  snapshot('video-import', imported);
  return { kind: 'package', workKey: 'local-' + workId, packageHash: imported.packageHash };
}
async function main() {
  assert.equal(process.platform, 'win32');
  try { await status(); throw new Error('An existing desktop host owns the pipe; this check requires no running host.'); }
  catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  let occupied = false;
  try { occupied = (await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1000) })).ok; } catch {}
  assert.equal(occupied, false, 'CDP port must be unused');
  fs.mkdirSync(output, { recursive: true });
  const lyrics = { enabled: false, locked: false, layout: 'double', secondary: 'next', fontFamily: 'Segoe UI', fontSize: 32,
    fontWeight: 600, sungColor: '#ffffff', unsungColor: '#ffffff', outlineColor: '#000000', outlineWidth: 1,
    opacity: 1, width: 550, anchorX: 0.5, anchorY: 0.5, monitor: null };
  const initialWallpaper = { enabled: false, audioInput: { kind: 'none' }, batteryPolicy: 'pause', pauseOnFullscreen: true,
    pauseOnMaximized: false, applicationRules: [], groups: [{ id: 'main', mode: 'single', displays: [{ kind: 'primary' }],
      selection: { kind: 'builtin', sceneId: 'coast', stateVersion: 1, params: {} },
      presentation: { fps: 15, quality: 'low', brightness: 1, motion: 1, fit: 'cover', pointer: false }, properties: {} }] };
  fs.writeFileSync(configFile, JSON.stringify({ schemaVersion: 5, revision: 1, launchAtLogin: false,
    activeProfile: null, profiles: [], unboundDomain: { wallpaper: initialWallpaper, lyrics }, lastCommit: null }, null, 2));
  const log = fs.openSync(path.join(output, 'host.log'), 'a');
  host = spawn(binary, ['--settings'], { cwd: root, windowsHide: true, stdio: ['ignore', log, log], env: {
    ...process.env, HERTZ_DESKTOP_CONFIG_DIR: output, WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview2'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
  } });
  fs.closeSync(log); host.on('error', error => { spawnError = error; });
  await until(async () => { try { return (await fetch('http://127.0.0.1:' + port + '/json/version')).ok; } catch { return false; } }, 'CDP startup');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  for (const context of browser.contexts()) {
    const watch = page => page.on('pageerror', error => errors.push(error.message));
    context.on('page', watch); context.pages().forEach(watch);
  }
  settings = await until(() => browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('/settings.html')), 'settings');
  await settings.waitForSelector('#enabled:enabled');
  // The fixture is our own visible test surface; its PowerShell console remains hidden.
  const fixtureLog = fs.openSync(path.join(output, 'fixture.log'), 'a');
  fixture = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'wallpaper-window-policy-fixture.ps1'), '-OutputDirectory', output],
  { windowsHide: true, stdio: ['ignore', fixtureLog, fixtureLog] });
  fs.closeSync(fixtureLog); fixture.on('error', error => { spawnError = error; });
  const nativeWindow = await windowMode('normal'); snapshot('actual-window', nativeWindow);
  let next = wallpaper(); next.enabled = true; next.audioInput = { kind: 'none' }; next.pauseOnMaximized = true;
  next.groups[0].selection = { kind: 'builtin', sceneId: 'coast', stateVersion: 1, params: {} };
  await commit(next);
  const first = await running('initial real builtin frame'), firstBinding = binding(first);
  await windowMode('maximized'); let state = await paused('maximized');
  assert.ok(!reasons(state).includes('fullscreen'), 'ordinary maximized is independent from fullscreen');
  assert.deepEqual(binding(state), firstBinding);
  const draws = target(state).pageTicks; await delay(1100);
  state = await status(); assert.equal(target(state).pageTicks, draws, 'paused page animation stops');
  await windowMode('normal'); assert.deepEqual(binding(await running('maximize recovery')), firstBinding);
  mark('real maximized window pauses and restores the same renderer without becoming fullscreen');
  await windowMode('fullscreen'); await paused('fullscreen');
  await windowMode('normal'); assert.deepEqual(binding(await running('fullscreen recovery')), firstBinding);
  mark('real borderless fullscreen triggers its independent policy and resumes');
  next = wallpaper(); next.applicationRules = [{ executable: nativeWindow.executable.replaceAll('\\', '/').toUpperCase(), action: 'pause' }];
  await commit(next); state = await paused('applicationRule');
  assert.deepEqual(binding(state), firstBinding, 'policy Apply preserves current renderer');
  assert.equal(wallpaper().applicationRules[0].executable, nativeWindow.executable.toLowerCase());
  await windowMode('normal', 'An unrelated changing window title'); await delay(1000);
  assert.ok(reasons(await status()).includes('applicationRule'));
  await windowMode('minimized'); assert.deepEqual(binding(await running('foreground rule recovery')), firstBinding);
  mark('normalized executable path matches independently of title; background process does not trigger the rule; Apply preserves session');
  await windowMode('maximized'); state = await paused('applicationRule');
  await until(async () => reasons(await status()).includes('maximized'), 'stacked maximized cause');
  await nativeRequest(pipe, { command: 'wallpaper-hide' }); await windowMode('minimized'); await delay(800);
  state = await status(); assert.deepEqual(reasons(state).filter(reason => ['manualPause', 'applicationRule', 'maximized'].includes(reason)), ['manualPause']);
  assert.equal(target(state).visible, false); await nativeRequest(pipe, { command: 'wallpaper-show' }); await running('manual show');
  mark('clearing window rules preserves an independent manual pause');
  // Published immutable packages exercise the actual playlist resolver, including the second item.
  const items = [];
  for (const sceneId of ['coast', 'zodiac']) {
    const work = ok(await api('wallpaper.draft.create', { kind: 'work', document: { title: 'Window policy ' + sceneId, sceneId, stateVersion: 1, params: {} } }));
    const workSaved = ok(await api('wallpaper.draft.save', ref(work)));
    const published = ok(await api('wallpaper.draft.publish', ref(workSaved)));
    items.push({ workKey: published.workKey, packageHash: published.packageHash });
  }
  const playlist = ok(await api('wallpaper.playlist.save', { title: 'Window policy recovery', mode: 'sequential', intervalSeconds: 86400, items }));
  next = wallpaper(); next.groups[0].selection = { kind: 'playlist', playlistId: playlist.playlistId }; await commit(next); await running('playlist first item');
  ok(await api('wallpaper.playlist.next', { playlistId: playlist.playlistId, groupId: next.groups[0].id }));
  await until(async () => { const state = await running('second item frame'); return target(state).playlist.currentIndex === 1; }, 'second item');
  const beforeRule = binding(await status()); next = wallpaper(); next.applicationRules[0].action = 'stop'; await commit(next);
  assert.deepEqual(binding(await running('Stop policy saved with fixture minimized')), beforeRule);
  assert.equal(target(await status()).playlist.currentIndex, 1);
  mark('policy-only Apply preserves the second playlist item and its existing renderer');
  const persisted = fs.readFileSync(configFile, 'utf8');
  for (let cycle = 0; cycle < 4; cycle++) {
    const before = binding(await status()); await windowMode('normal'); state = await released();
    assert.equal(target(state).playlist.currentIndex, 1); snapshot('stop-' + cycle, state);
    await delay(400); assert.equal(target(await status()).session, null, 'no rebuild while stopped');
    await windowMode('minimized'); state = await running('Stop recovery cycle ' + cycle);
    assert.notEqual(binding(state).generation, before.generation);
    assert.equal(target(state).playlist.currentIndex, 1); assert.equal(target(state).diagnostics.recovery.terminal, false);
    assert.equal(fs.readFileSync(configFile, 'utf8'), persisted, 'environment transitions never change saved intent');
  }
  mark('four Stop/resume cycles release all native GL/controller budgets and restore the same playlist item without exhausting recovery');
  next = wallpaper(); next.applicationRules[0].executable = path.join(path.dirname(nativeWindow.executable), 'different', path.basename(nativeWindow.executable)); await commit(next);
  await windowMode('normal'); await delay(1250); state = await running('different executable directory');
  assert.ok(!reasons(state).includes('applicationRule'));
  mark('same executable basename in another directory does not match');
  await windowMode('minimized');
  const video = await importVideo();
  next = wallpaper(); next.groups[0].selection = video;
  next.applicationRules = [{ executable: nativeWindow.executable, action: 'pause' }];
  await commit(next); state = await running('real video');
  let videoPage = await renderer(binding(state));
  await videoPage.waitForFunction(() => document.querySelector('video')?.currentTime > 0.7);
  await windowMode('normal'); state = await paused('applicationRule');
  await until(async () => target(await status()).mediaPauseConfirmed === true, 'actual video pause confirmation');
  const pauseTime = await videoPage.evaluate(() => document.querySelector('video').currentTime);
  await delay(1000); assert.equal(await videoPage.evaluate(() => document.querySelector('video').currentTime), pauseTime);
  assert.equal(state.wallpaper.budget.decoderSlots, 1);
  next = wallpaper(); next.applicationRules[0].action = 'stop'; await commit(next); state = await released();
  const resumePosition = target(state).resumePositionMs;
  assert.ok(resumePosition > 0, 'Stop keeps nonzero actual video position');
  await windowMode('minimized'); state = await running('video Stop recovery');
  videoPage = await renderer(binding(state));
  const firstVideoFrame = await videoPage.evaluate(() => window.hertzWallpaper.debug().media.firstFrameTimeMs);
  assert.ok(Math.abs(firstVideoFrame - resumePosition) < 160, JSON.stringify({ firstVideoFrame, resumePosition }));
  snapshot('video-recovery', { state, firstVideoFrame, resumePosition });
  mark('real video Pause freezes decoding; Stop releases decoder and resumes the retained media position');
  if (process.argv.includes('--long-pause')) {
    next = wallpaper(); next.applicationRules[0].action = 'pause'; await commit(next);
    await windowMode('normal'); await paused('applicationRule');
    const began = Date.now();
    state = await until(async () => {
      const state = await status(), current = target(state);
      return current?.handoff?.pauseRetained && current.handoff.visible && current.handoff.sourceClosed
        && !current.session && current.staticFrameRetained && !state.wallpaper.budget.decoderSlots
        && !state.wallpaper.budget.targets && !state.wallpaper.retiringControllers && state;
    }, 'production long pause retains native bitmap and releases video', 310000);
    const elapsedMs = Date.now() - began;
    assert.ok(elapsedMs >= 280000 && elapsedMs < 305000, 'production timing unchanged');
    snapshot('long-pause-retained-frame', { elapsedMs, state });
    await windowMode('minimized'); await running('long-pause video recovery');
    mark('production five-minute pause cap releases video resources while retaining a real native frame, then restores video');
  }
  const failedPlaylist = ok(await api('wallpaper.playlist.save', { title: 'Failed item policy protection', mode: 'sequential', intervalSeconds: 86400,
    items: [items[0], { workKey: video.workKey, packageHash: video.packageHash }] }));
  next = wallpaper(); next.groups[0].selection = { kind: 'playlist', playlistId: failedPlaylist.playlistId }; await commit(next); await running('failure list first');
  ok(await api('wallpaper.playlist.next', { playlistId: failedPlaylist.playlistId, groupId: next.groups[0].id }));
  state = await until(async () => { const state = await running('failure list second'); return target(state).playlist.currentIndex === 1 && state; }, 'video is second item');
  videoPage = await renderer(binding(state));
  await videoPage.evaluate(() => { const video = document.querySelector('video'); video.src = new URL('/files/does-not-exist.webm', video.src).href; video.load(); });
  state = await until(async () => { const state = await status(); return target(state).playlist.failed && target(state).staticPoster && target(state).firstFrameReady && state; }, 'real video error produces failure poster');
  const failedIdentity = binding(state), failedCurrent = target(state).playlist.current;
  next = wallpaper(); next.pauseOnMaximized = !next.pauseOnMaximized; await commit(next); await delay(1000);
  state = await status(); assert.deepEqual(binding(state), failedIdentity);
  assert.equal(target(state).playlist.currentIndex, 1); assert.equal(target(state).playlist.failed, true);
  assert.deepEqual(target(state).playlist.current, failedCurrent);
  assert.equal(target(state).selectionPreparing, false); assert.equal(target(state).candidateLoading, false);
  snapshot('failed-item-policy-apply', state);
  mark('policy-only Apply preserves a real failed second video item and its poster without retry or restart');
  next = wallpaper(); next.applicationRules[0].action = 'stop'; await commit(next);
  await windowMode('normal'); await released(); await windowMode('minimized');
  state = await until(async () => {
    const state = await status(), current = target(state);
    return current.staticPoster && current.firstFrameReady && current.playlist.failed && !current.handoff && state;
  }, 'failed poster restores after Stop');
  assert.equal(target(state).playlist.currentIndex, 1);
  assert.deepEqual(target(state).playlist.current, failedCurrent);
  assert.equal(state.wallpaper.budget.decoderSlots, 0);
  mark('Stop releases a failed video poster and restores it without retrying or changing its failed item');
  snapshot('final-status', state); assert.deepEqual(errors, []);
}
async function cleanup() {
  // Only handles created above are terminated; never issue a global pipe quit.
  for (const child of [fixture, host]) if (child && child.exitCode === null && child.signalCode === null) {
    child.kill(); const deadline = Date.now() + 5000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(50);
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'owned process exited');
  }
  if (browser) await browser.close().catch(() => {});
}
main().then(async () => {
  await cleanup(); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, cleanupDone: true,
    binary, binarySha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), checks, errors, evidence,
    scope: 'Real single-monitor foreground/maximize/fullscreen and application lifecycle. Multi-monitor scope has unit coverage only.' }, null, 2));
  console.log(JSON.stringify({ passed: true, output, checks }, null, 2));
}).catch(async error => {
  fs.mkdirSync(output, { recursive: true });
  try { snapshot('failure-status', await status()); } catch {}
  let cleanupError; try { await cleanup(); } catch (failure) { cleanupError = failure.stack; }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: false, error: error.stack, cleanupError, checks, errors, evidence }, null, 2));
  console.error(error); console.error(output); process.exitCode = 1;
});
