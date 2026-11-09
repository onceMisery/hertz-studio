// SPDX-License-Identifier: MIT
// Real Windows P2 core acceptance; author document/target facts come from native.
// Requires a copied debug candidate with wallpaper-media-probe and its receipt.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { buildZip } = require('./check-wallpaper-media-native');
const nativeRequest = require('./desktop-native-management-client');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.HERTZ_COMPOSITION_OUTPUT || path.join(root, 'output/playwright/composition-native-' + Date.now()));
const binary = path.resolve(process.env.HERTZ_DESKTOP_BIN || '');
const configFile = path.join(output, 'config.json');
const pipe = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
const port = Number(process.env.DESKTOP_CDP_PORT || 19738);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], errors = [], evidence = {};
let child, browser, settings, seq = 0, spawnError;
const stored = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
const pages = () => browser.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed());
const status = () => nativeRequest(pipe, { command: 'status' });
const draftRef = draft => ({ draftId: draft.draftId, draftRevision: draft.draftRevision });
const mark = label => { checks.push(label); console.log('PASS ' + label); };
async function until(read, label, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (spawnError) throw spawnError;
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error('Owned host exited: ' + label);
    const value = await read(); if (value) return value;
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
}
async function api(command, payload = {}, expectedRevision) {
  const receipt = await settings.evaluate(async input => {
    try { return await hertzWallpaperSettings.requestManagement(input.command, input.payload, input.requestId, input.expectedRevision); }
    catch (error) { return error.receipt || { ok: false, error: { code: error.code, message: error.message } }; }
  }, { command, payload, expectedRevision, requestId: 'composition-native-' + (++seq) });
  assert.equal(receipt.ok, true, command + ': ' + JSON.stringify(receipt));
  return receipt.result;
}
async function commit(wallpaper) {
  const baseRevision = stored().revision;
  let draft = await api('wallpaper.draft.create', { kind: 'settings' });
  draft = await api('wallpaper.draft.update', { ...draftRef(draft), operations: [{ kind: 'replaceWallpaper', wallpaper }] });
  const operation = await api('wallpaper.apply', draftRef(draft), draft.baseRevision);
  assert.equal(operation.saved, true); assert.equal(operation.state, 'committed');
  assert.equal(operation.configRevision, baseRevision + 1); assert.equal(stored().revision, baseRevision + 1);
  return operation;
}
async function running(selection, expectedRevision = stored().revision) {
  return until(async () => {
    const state = await status(), targets = state.wallpaper.targets;
    evidence.lastNativeState = state.wallpaper;
    assert.ok(Array.isArray(targets));
    if (targets.some(target => target.applyError)) throw new Error(JSON.stringify(targets));
    const target = targets.find(target => target.groupId === 'native-composition');
    return target?.firstFrameReady && target.visible && target.session?.frameKind === 'gl'
      && isDeepStrictEqual(target.appliedSelection, selection)
      && target.appliedRevision === expectedRevision && target.desiredRevision === expectedRevision
      && !target.handoff && !target.candidateLoading && !target.selectionPreparing
      && state.wallpaper.retiringControllers === 0 && state.wallpaper.retirements.length === 0 && state;
  }, 'real native composition first frame');
}
async function renderer(state) {
  const id = state.wallpaper.targets.find(target => target.groupId === 'native-composition').session.binding.sessionId;
  return until(async () => {
    for (const page of pages().filter(page => page.url().includes('/wallpaper.html'))) {
      if (await page.evaluate(id => window.hertzWallpaper?.debug().session?.sessionId === id, id).catch(() => false)) return page;
    }
    return null;
  }, 'owned renderer bound to native session');
}
function inspectWindows() {
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(output, 'windows.ps1'), '-OwnerPid', String(child.pid)],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 }));
}
async function start() {
  assert.equal(process.platform, 'win32');
  assert.ok(process.env.HERTZ_DESKTOP_BIN && fs.existsSync(binary), 'Set a copied candidate HERTZ_DESKTOP_BIN');
  assert.ok(process.env.HERTZ_DESKTOP_BUILD_RECEIPT, 'Set its HERTZ_DESKTOP_BUILD_RECEIPT');
  const receipt = JSON.parse(fs.readFileSync(process.env.HERTZ_DESKTOP_BUILD_RECEIPT, 'utf8'));
  assert.equal(receipt.sourceBuildBinding, true);
  assert.equal(hash(fs.readFileSync(binary)), receipt.binarySha256);
  const inputs = receipt.sourceHashes || receipt.buildInputs;
  assert.ok(inputs && Object.keys(inputs).length > 0);
  for (const [file, sha] of Object.entries(inputs)) assert.equal(hash(fs.readFileSync(path.join(root, file))), sha, 'build input changed: ' + file);
  evidence.binary = { path: binary, sha256: receipt.binarySha256, sourceCount: Object.keys(inputs).length };
  try { await nativeRequest(pipe, { command: 'status' }); throw new Error('Existing desktop host; leave it untouched.'); }
  catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  try { const response = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1000) }); assert.equal(response.ok, false, 'CDP port belongs to another browser'); }
  catch (error) { if (error.code === 'ERR_ASSERTION') throw error; }
  fs.mkdirSync(path.join(output, 'probe-inputs'), { recursive: true });
  // Fixtures use the published canonical defaults, as native Config does.
  // Exact selection comparison still rejects a different work or revision.
  const coast = require('../crates/hertz-wallpaper/contracts/catalog.json').scenes.find(scene => scene.id === 'coast');
  assert.ok(coast);
  const coastParams = Object.fromEntries(Object.entries(coast.params).map(([key, definition]) => [key, definition.default]));
  const wallpaper = { enabled: true, audioInput: { kind: 'none' }, batteryPolicy: 'pause', pauseOnFullscreen: false,
    pauseOnMaximized: false, applicationRules: [], groups: [{ id: 'native-composition', mode: 'single', displays: [{ kind: 'primary' }],
      selection: { kind: 'builtin', sceneId: 'coast', stateVersion: coast.stateVersion, params: coastParams },
      presentation: { fps: 15, quality: 'low', brightness: 1, motion: 1, fit: 'contain', pointer: false }, properties: {} }] };
  const lyrics = { enabled: false, locked: true, layout: 'double', secondary: 'next', fontFamily: 'Segoe UI', fontSize: 32,
    fontWeight: 600, sungColor: '#ffffff', unsungColor: '#ffffff', outlineColor: '#000000', outlineWidth: 1,
    opacity: 1, width: 550, anchorX: .5, anchorY: .5, monitor: null };
  fs.writeFileSync(configFile, JSON.stringify({ schemaVersion: 5, revision: 1, launchAtLogin: false, activeProfile: null,
    profiles: [], unboundDomain: { wallpaper, lyrics }, lastCommit: null }));
  fs.writeFileSync(path.join(output, 'windows.ps1'), `param([uint32]$OwnerPid)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type @'
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public static class CompositionWindows {
 public delegate bool Callback(IntPtr h,IntPtr p);
 [DllImport("user32.dll")]static extern bool EnumWindows(Callback c,IntPtr p);
 [DllImport("user32.dll")]static extern bool EnumChildWindows(IntPtr h,Callback c,IntPtr p);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")]static extern IntPtr GetParent(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr h,out RECT r);
 [StructLayout(LayoutKind.Sequential)]public struct RECT{public int left,top,right,bottom;}
 public class State{public long hwnd,parent;public uint pid;public string parentClass;public bool visible;public RECT rect;}
 public static State[] Read(uint owner){var found=new Dictionary<long,State>();Callback scan=(h,p)=>{
  uint pid;GetWindowThreadProcessId(h,out pid);var title=new StringBuilder(128);GetWindowText(h,title,128);
  if(pid==owner&&title.ToString()=="Hertz wallpaper"){
   var parent=GetParent(h);var name=new StringBuilder(128);GetClassName(parent,name,128);RECT rect;GetWindowRect(h,out rect);
   found[h.ToInt64()]=new State{hwnd=h.ToInt64(),parent=parent.ToInt64(),pid=pid,parentClass=name.ToString(),visible=IsWindowVisible(h),rect=rect};}
  return true;};EnumWindows((h,p)=>{scan(h,p);EnumChildWindows(h,scan,p);return true;},IntPtr.Zero);
  var result=new State[found.Count];found.Values.CopyTo(result,0);return result;}
}
'@
ConvertTo-Json -Compress -Depth 5 -InputObject @([CompositionWindows]::Read($OwnerPid))
`, 'utf8');
  const log = fs.openSync(path.join(output, 'host.log'), 'a');
  child = spawn(binary, ['--settings'], { cwd: root, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env,
    HERTZ_DESKTOP_CONFIG_DIR: output, WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview2'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port } });
  fs.closeSync(log); child.on('error', error => { spawnError = error; }); evidence.pid = child.pid;
  await until(async () => { try { return (await fetch('http://127.0.0.1:' + port + '/json/version')).ok; } catch { return false; } }, 'owned WebView2 startup');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  for (const context of browser.contexts()) { const watch = page => page.on('pageerror', error => errors.push({ url: page.url(), message: error.message })); context.on('page', watch); context.pages().forEach(watch); }
  settings = await until(() => pages().find(page => page.url().includes('/settings.html')), 'owned settings');
  await settings.waitForSelector('#enabled:enabled');
  return wallpaper;
}
async function main() {
  const wallpaper = await start();
  let state = await running(wallpaper.groups[0].selection);
  const initialPage = await renderer(state);
  const png = Buffer.from(await settings.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d'); context.fillStyle = '#7d3d25'; context.fillRect(0, 0, 320, 180);
    context.fillStyle = '#dbae5c'; context.fillRect(20, 20, 80, 80); return canvas.toDataURL().split(',')[1];
  }), 'base64');
  const movie = fs.readFileSync(path.join(root, 'scripts/fixtures/wallpaper-vp8.webm'));
  const node = (id, type, assets, properties) => ({ id, type, stateVersion: 1, assets, properties });
  const document = { documentVersion: 1, canvas: { width: 320, height: 180, colorSpace: 'srgb', background: '#000000' },
    nodes: [node('background', 'image', { asset: 'background' }, { x: 160, y: 90, width: 320, height: 180 }),
      node('movie-left', 'video', { asset: 'movie' }, { x: 112, y: 90, width: 96, height: 72, loopStartMs: 0, loopEndMs: 1000 }),
      node('movie-right', 'video', { asset: 'movie' }, { x: 224, y: 90, width: 96, height: 72, loopStartMs: 0, loopEndMs: 1000 })],
    timeline: { durationSeconds: 4, loop: true, tracks: [] }, bindings: [], effects: [] };
  const workId = crypto.randomUUID(), entries = [['composition.json', Buffer.from(JSON.stringify(document)), 'application/json'],
    ['assets/background.png', png, 'image/png'], ['assets/movie.webm', movie, 'video/webm']];
  const manifest = { formatVersion: 1, workId, version: 1, title: 'Windows composition fixture', description: 'Same-domain media, fitting and native retirement',
    content: { kind: 'composition', document: 'composition.json' },
    assets: [{ id: 'background', kind: 'image', source: 'assets/background.png', variants: [] }, { id: 'movie', kind: 'video', source: 'assets/movie.webm', variants: [] }],
    files: entries.map(([path, bytes, mime]) => ({ path, bytes: bytes.length, sha256: hash(bytes), mime })), properties: [],
    permissions: { audioSpectrum: false, pointer: false }, license: { code: 'none', assets: 'CC0-1.0', attribution: '' } };
  const bytes = buildZip([['manifest.json', Buffer.from(JSON.stringify(manifest))], ...entries.map(([file, bytes]) => [file, bytes])]);
  const input = path.join(output, 'probe-inputs/composition.hwpkg'); fs.writeFileSync(input, bytes);
  await initialPage.evaluate(() => window.ipc.postMessage('wallpaper_probe_import ' + JSON.stringify({ nonce: 1, action: 'begin', name: 'composition' })));
  await initialPage.waitForFunction(() => !!window.__nativeImportProbes?.[1], null, { timeout: 60000 });
  const imported = await initialPage.evaluate(() => window.__nativeImportProbes[1]); evidence.import = imported;
  assert.equal(imported.state, 'done', JSON.stringify(imported)); assert.equal(imported.packageHash, hash(bytes));
  assert.equal(imported.prepareTasks, 0); assert.equal(imported.prepareCpuBytes, 0);
  const selection = { kind: 'package', workKey: 'local-' + workId, packageHash: imported.packageHash };
  const detail = await api('wallpaper.library.get', { workKey: selection.workKey });
  assert.ok(detail.versions.some(version => version.packageHash === selection.packageHash)); fs.unlinkSync(input);
  mark('actual composition package imports through native preparation and original installed library');
  wallpaper.groups[0].selection = selection;
  let previousSession = state.wallpaper.targets.find(target => target.groupId === 'native-composition').session.binding.sessionId;
  for (const fit of ['contain', 'cover', 'stretch']) {
    wallpaper.groups[0].presentation.fit = fit; const operation = await commit(wallpaper);
    state = await running(selection, operation.configRevision); const page = await renderer(state);
    await page.waitForFunction(() => hertzWallpaper.debug().draws >= 3 && hertzWallpaper.debug().stats?.sceneStats?.ready);
    const debug = await page.evaluate(() => hertzWallpaper.debug());
    assert.equal(debug.backend, 'space'); assert.equal(debug.scene, 'composition'); assert.equal(debug.error, null);
    assert.equal(debug.glBudget.contexts, 1); assert.equal(debug.glBudget.error, null);
    assert.notEqual(debug.session.sessionId, previousSession, 'changed target plan must not borrow the old session first frame');
    previousSession = debug.session.sessionId;
    const projection = await page.evaluate(async () => {
      const response = await fetch(window.__hertzWallpaperGlAllocation.compositionUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error('Current native projection unavailable');
      return response.json();
    });
    assert.equal(projection.sessionId, debug.session.sessionId); assert.equal(projection.generation, debug.session.generation);
    assert.equal(projection.target.fit, fit, 'exact current native target must use the just-committed fit');
    assert.equal(debug.stats.sceneStats.nodes, 3); assert.equal(debug.stats.sceneStats.videoClocks.length, 1, 'same media domain shares one decoder');
    assert.equal(debug.stats.sceneStats.linearOutputPasses, 1); assert.equal(state.wallpaper.budget.decoderSlots, 1);
    const windows = inspectWindows(); assert.equal(windows.length, 1);
    assert.equal(windows[0].pid, child.pid); assert.equal(windows[0].parentClass, 'WorkerW'); assert.equal(windows[0].visible, true);
    await page.screenshot({ path: path.join(output, 'native-' + fit + '.png') });
    evidence[fit] = { operation, status: state, debug, projection, windows };
    mark(fit + ': real native first frame, one WorkerW surface/context and one shared video clock');
  }
  const page = await renderer(state);
  await page.evaluate(() => hertzWallpaper.stop());
  await delay(200); const paused = await page.evaluate(() => hertzWallpaper.debug()); await delay(350);
  const still = await page.evaluate(() => hertzWallpaper.debug());
  assert.equal(paused.stats.sceneStats.videoClocks.length, 1);
  assert(paused.stats.sceneStats.videoClocks.every(video => video.paused && !video.seeking && video.seekReady));
  assert.equal(still.draws, paused.draws); assert.equal(still.sceneTime, paused.sceneTime);
  assert.deepEqual(still.stats.sceneStats.videoClocks, paused.stats.sceneStats.videoClocks);
  await page.evaluate(() => hertzWallpaper.start(15));
  await page.waitForFunction(draws => hertzWallpaper.debug().draws > draws, paused.draws);
  evidence.pause = { paused, still, resumed: await page.evaluate(() => hertzWallpaper.debug()) };
  mark('original page stop freezes draws, canonical time and shared media; restart resumes');
  wallpaper.enabled = false; await commit(wallpaper);
  evidence.retired = await until(async () => {
    const current = await status(), budget = current.wallpaper.budget;
    const keys = ['targets', 'contexts', 'decoderSlots', 'cpuBytes', 'gpuBytes', 'prepareTasks', 'prepareCpuBytes', 'releasePending',
      'sessionReservations', 'resourceAllocations', 'resourceReleasePending', 'textureUploadBytesPerSecond'];
    return current.wallpaper.retiringControllers === 0 && current.wallpaper.retirements.length === 0 && keys.every(key => budget[key] === 0) && current;
  }, 'all native composition resources drain');
  await until(() => !pages().some(page => page.url().includes('/wallpaper.html')), 'owned composition WebView closes');
  assert.deepEqual(inspectWindows(), []); assert.deepEqual(errors, []);
  mark('disable closes real composition HWND/WebView and drains native decoder, CPU/GPU and upload-rate allocations');
}
main().catch(async error => {
  errors.push(error.stack); process.exitCode = 1;
  if (browser) evidence.pageDiagnostics = await Promise.all(pages().map(async page => ({ url: page.url(),
    state: await page.evaluate(() => window.hertzWallpaper?.debug()).catch(error => ({ error: error.message })) })));
  if (settings) await settings.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
}).finally(async () => {
  if (browser) await browser.close().catch(() => {});
  if (child && child.exitCode === null && child.signalCode === null) {
    try { child.kill(); } catch (error) { errors.push('Owned host termination failed: ' + error.message); }
    const end = Date.now() + 5000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < end) await delay(100);
    if (child.exitCode === null && child.signalCode === null) errors.push('Owned host exit was not confirmed within five seconds');
  }
  if (errors.length) process.exitCode = 1;
  evidence.exit = child ? { code: child.exitCode, signal: child.signalCode, cleanup: 'owned host termination after resource verification' } : null;
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: errors.length === 0, checks, errors, evidence,
    limits: ['Current Windows debug core only', 'Controlled original page stop; OS policy, pressure and long-duration qualification separate',
      'Font/SVG/GLB/KTX2/effects/timeline/binding/editor and additional devices remain open'] }, null, 2));
  console.log(JSON.stringify({ output, checks: checks.length, errors }));
});
