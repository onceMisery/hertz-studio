#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Real Wry/WebView2 downloads and owned Win32 save dialogs; fresh native-window build required.
// HERTZ_BIN pins the candidate. PLAYWRIGHT_MODULE can point at the bundled Playwright package.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const binary = path.resolve(process.env.HERTZ_BIN || path.join(root, 'target/debug/hertz-studio.exe'));
const output = path.join(root, 'output/playwright/main-window-files-native-' + Date.now());
const dataA = path.join(output, 'data-a'), dataB = path.join(output, 'data-b');
const scope = process.env.HERTZ_FILES_SCOPE || 'all';
let data = dataA;
const exportsDirectory = path.join(output, 'exports');
const dialogFixture = path.join(__dirname, 'main-window-files-dialog-fixture.ps1');
const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const checks = [], errors = [], holders = new Set(), launches = [];
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const mark = message => { checks.push(message); console.log('PASS ' + message); };
let child, browser, page, discovery, spawnError, foreignServer, foreignOrigin, trackId;
const foreignRequests = [];
function snapshot(name, value) { fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(value, null, 2)); }
async function until(read, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function api(endpoint, method = 'GET', body, expected = 200) {
  const response = await fetch('http://127.0.0.1:' + discovery.port + endpoint, { method,
    headers: { Authorization: 'Bearer ' + discovery.token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const value = await response.json();
  assert.equal(response.status, expected, endpoint + ': ' + JSON.stringify(value));
  return value;
}
function native(action = 'read', handle = 0, savePath) {
  assert.ok(child?.pid, 'Native actions require the owned test process');
  return JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', dialogFixture,
    '-OwnerPid', String(child.pid), '-Action', action, ...(handle ? ['-Handle', String(handle)] : []),
    ...(savePath === undefined ? [] : ['-SavePath', savePath])], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  }).trim());
}
const saveDialog = windows => windows.find(window => window.visible && window.kind === '#32770' && window.title === '保存导出文件'
  && window.controls.some(control => control.kind === 'Edit' && control.id === 1001));
const buttonNamed = (window, pattern) => window.controls.some(control => control.visible && control.kind === 'Button' && pattern.test(control.title.replaceAll('&', '')));
const confirmation = windows => windows.find(window => window.visible && window.kind === '#32770'
  && buttonNamed(window, /^(Yes|是)/i) && buttonNamed(window, /^(No|否)/i));
const errorDialog = windows => windows.find(window => window.visible && window.kind === '#32770' && window !== saveDialog(windows)
  && !buttonNamed(window, /^(Yes|是)/i) && buttonNamed(window, /^(OK|确定)/i));
async function openSave(label) {
  const windows = await until(() => { const current = native(); return saveDialog(current) && current; }, label + ' native save dialog');
  const mainWindow = windows.find(window => window.title === 'HertzStudio Music Player');
  const dialog = saveDialog(windows);
  assert.ok(mainWindow?.visible, 'Owned main window remains visible');
  assert.equal(mainWindow.enabled, false, 'Save dialog disables its parent');
  assert.equal(dialog.owner, mainWindow.handle, 'Save dialog belongs to the same native main window');
  const pending = await readRequest(label);
  const fileNameEdit = dialog.controls.find(control => control.kind === 'Edit' && control.id === 1001);
  assert.equal(fileNameEdit.title, pending.name, 'Native picker preserves the requested suggested filename');
  assert.equal((await api('/v1/health')).backend, 'null', 'Service responds while the native modal dialog is open');
  if (trackId) assert.equal((await api('/v1/state')).playing, true, 'Real null-output audio actor keeps playing while the modal dialog is open');
  snapshot(label + '-dialog', windows);
  return dialog;
}
async function instrumentation() {
  await page.evaluate(() => {
    const state = window.__nativeFileChecks = { requests: {}, events: [], clicks: [], nextId: null, trigger: null };
    window.addEventListener('hertz-native-download-result', event => state.events.push({ ...event.detail }));
    const host = window.__hertzWindowHost;
    const save = host.saveTextFile;
    const createObjectURL = URL.createObjectURL.bind(URL);
    let current = null;
    URL.createObjectURL = blob => {
      const url = createObjectURL(blob);
      if (current) current.url = url;
      return url;
    };
    host.saveTextFile = (name, type, text) => {
      const id = state.nextId || 'request-' + Object.keys(state.requests).length;
      state.nextId = null;
      const request = state.requests[id] = { name, type, text, status: 'pending', settlements: 0 };
      current = request;
      let result;
      try { result = save(name, type, text); } finally { current = null; }
      return result.then(receipt => {
        request.status = receipt.status; request.settlements += 1; return receipt;
      }, error => {
        request.status = 'failed'; request.error = String(error.message || error); request.settlements += 1; throw error;
      });
    };
    const button = document.createElement('button');
    button.id = 'native-file-fixture-save'; button.textContent = 'Native file fixture save';
    Object.assign(button.style, { position: 'fixed', right: '16px', top: '16px', zIndex: '2147483647', padding: '12px' });
    button.onclick = event => {
      const payload = state.trigger; state.trigger = null;
      if (!payload) return;
      state.clicks.push({ id: payload.id, trusted: event.isTrusted, active: navigator.userActivation.isActive });
      state.nextId = payload.id;
      void window.hertzHost.saveTextFile(payload.name, payload.type, payload.text).catch(() => {});
    };
    document.body.appendChild(button);
  });
}
async function request(id, name, text, type = 'application/json') {
  await page.evaluate(payload => { __nativeFileChecks.trigger = payload; }, { id, name, text, type });
  // A real pointer gesture retains WebView2's normal per-user download policy.
  await page.locator('#native-file-fixture-save').click();
  const click = await page.evaluate(id => __nativeFileChecks.clicks.find(click => click.id === id), id);
  assert.equal(click?.trusted, true, 'Native fixture save starts with a real trusted pointer click');
}
const readRequest = id => page.evaluate(id => __nativeFileChecks.requests[id], id);
async function settled(id, status = 'saved') {
  const value = await until(async () => { const request = await readRequest(id); return request?.status !== 'pending' && request; }, id + ' receipt');
  assert.equal(value.status, status, JSON.stringify(value));
  assert.equal(value.settlements, 1, 'Promise resolves once');
  snapshot(id + '-receipt', value);
  return value;
}
async function saveTo(id, destination, dialog) {
  const current = dialog || await openSave(id);
  native('fill', current.handle, destination);
  native('save', current.handle);
  await until(() => !saveDialog(native()), id + ' dialog closes');
  return settled(id);
}
async function live(label) {
  assert.equal(child.exitCode, null, 'Owned process remains running');
  assert.equal((await api('/v1/health')).backend, 'null');
  const audio = await api('/v1/state');
  if (trackId) {
    assert.equal(audio.playing, true, 'Real null-output actor remains playing');
    assert.equal(audio.track_id, trackId, 'Save operations retain the loaded track');
  }
  const windows = native();
  assert.ok(windows.some(window => window.title === 'HertzStudio Music Player' && window.visible && window.enabled));
  assert.equal((await api('/v1/window/state')).phase, 'idle');
  assert.equal(await page.evaluate(() => __hertzWindowHost.downloadVersion), 1);
  snapshot(label + '-alive', { pid: child.pid, port: discovery.port, audio, windows });
}
async function start(profileData = dataA, servicePort = 0) {
  data = profileData; spawnError = null; trackId = null;
  const cdpPort = await freePort();
  const launch = { profile: path.basename(data), servicePort, cdpPort }; launches.push(launch);
  const log = fs.openSync(path.join(output, 'host-' + launches.length + '.log'), 'a');
  child = spawn(binary, ['--window', '--bind', '127.0.0.1', '--port', String(servicePort), '--data-dir', data], {
    cwd: root, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env,
      VMUSIC_BACKEND: 'null', VMUSIC_SECRETS: 'memory', HERTZ_DESKTOP_CONFIG_DIR: path.join(output, 'desktop'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + cdpPort,
    },
  });
  launch.pid = child.pid;
  fs.closeSync(log);
  child.on('error', error => { spawnError = error; });
  discovery = await until(() => {
    if (child.exitCode !== null) throw new Error('Owned native process exited ' + child.exitCode);
    try { const value = JSON.parse(fs.readFileSync(path.join(data, 'vmusicd.json'), 'utf8')); return value.pid === child.pid && value; } catch { return null; }
  }, 'owned service startup', 60000);
  await until(async () => { try { return (await fetch('http://127.0.0.1:' + cdpPort + '/json/version')).ok; } catch { return false; } }, 'native WebView2 CDP');
  // Preserve WebView2's own download manager so CDP cannot bypass Wry's dialog/receipts.
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + cdpPort, { noDefaults: true });
  page = await until(() => browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('http://127.0.0.1:' + discovery.port)), 'native main page');
  page.setDefaultTimeout(18000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.__hertzWindowHost?.downloadVersion === 1 && typeof window.hertzHost?.saveTextFile === 'function'
    && document.getElementById('conn').textContent === '服务已连接', null, { timeout: 45000 });
  await instrumentation();
  launch.actualServicePort = discovery.port;
  snapshot('candidate', { binary, binarySha256: hash(binary), launches });
}
async function stopCurrent() {
  if (child && child.exitCode === null && child.signalCode === null) {
    await api('/v1/player/pause', 'POST', {});
    await until(async () => (await api('/v1/state')).playing === false, 'owned audio actor pauses before graceful exit');
    await api('/v1/system/shutdown', 'POST', {}, 202);
    await until(() => child.exitCode !== null || child.signalCode !== null, 'owned native graceful exit', 30000);
    assert.equal(fs.existsSync(path.join(data, 'vmusicd.json')), false, 'Graceful shutdown removes its discovery');
  }
  if (browser) await browser.close().catch(() => {});
  child = browser = page = discovery = null; trackId = null;
}
async function preferencesReady() {
  await page.waitForFunction(() => !!window.UiPreferences && !!window.UiPreferenceSettings && !!window.StagePersistence
    && typeof window.CreativeStage?.hydrated === 'function' && typeof document.getElementById('ui-preferences-export')?.onclick === 'function', null, { timeout: 45000 });
  await page.evaluate(async () => {
    await CreativeStage.hydrated();
    if (StagePersistence.status().hydrated !== true) throw new Error('Real stage persistence did not hydrate');
    await Promise.all([CreativeStage.flushPersistence(), CreativeStage.flushLibrary()]);
  });
}
const preferenceKeys = ['vmusic.theme.v2', 'vmusic.theme.mineral-default', 'vmusic.playlists.mode', 'vmusic.playlists.viewV2',
  'vmusic.stage.control', 'vmusic.stage.control.v'];
async function preferenceState() {
  return page.evaluate(keys => ({ storage: Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])),
    theme: Theme.current().id, themeAttribute: document.documentElement.dataset.theme, stage: StageControl.values(),
    shelfPressed: document.querySelector('#pl-views button[data-pl-view="shelf"]').getAttribute('aria-pressed'),
    shelfOn: document.getElementById('shelf').classList.contains('on'),
    filterEnabled: document.documentElement.classList.contains('fx-on'), stagePersistence: StagePersistence.status(),
  }), preferenceKeys);
}
async function openPreferenceSettings() {
  await page.locator('.rail-item[data-view="settings"]').click();
  await page.locator('#view-settings').waitFor({ state: 'visible' });
  await page.locator('#view-settings .hz-settings-nav [data-category="tools"]').click();
  await page.locator('#ui-preferences-setting').waitFor({ state: 'visible' });
}
async function checkPreferenceTransfer() {
  await preferencesReady();
  await page.evaluate(() => {
    Theme.apply('celestial');
    StageControl.set({ enabled: false, bokeh: 5 });
    document.querySelector('#pl-views button[data-pl-view="shelf"]').click();
  });
  const source = await preferenceState();
  assert.equal(source.theme, 'celestial'); assert.equal(source.stage.enabled, false); assert.equal(source.stage.bokeh, 5);
  assert.equal(source.storage['vmusic.playlists.mode'], 'shelf');
  snapshot('preferences-source-a', source);
  await openPreferenceSettings();
  await page.evaluate(() => { __nativeFileChecks.nextId = 'preferences-cancel'; });
  await page.locator('#ui-preferences-export').click();
  const cancelDialog = await openSave('preferences-cancel');
  assert.equal(await page.locator('#ui-preferences-export').isDisabled(), true);
  native('fill', cancelDialog.handle, path.join(exportsDirectory, 'preferences-cancel.json')); native('cancel', cancelDialog.handle);
  await settled('preferences-cancel', 'cancelled');
  assert.equal(await page.locator('#ui-preferences-status').innerText(), '已取消保存');
  assert.equal(await page.locator('#ui-preferences-status').evaluate(node => node.classList.contains('ui-preference-error')), false);
  await page.evaluate(() => { __nativeFileChecks.nextId = 'preferences-export'; });
  await page.locator('#ui-preferences-export').click();
  const preferencePath = path.join(exportsDirectory, 'ui-preferences-native.json');
  const receipt = await saveTo('preferences-export', preferencePath);
  assert.deepEqual(fs.readFileSync(preferencePath), Buffer.from(receipt.text, 'utf8'));
  const transferred = JSON.parse(receipt.text);
  assert.ok(!receipt.text.includes(discovery.token), 'Real service credential stays outside the UI preference file');
  assert.equal(transferred.kind, 'hertz-ui-preferences'); assert.equal(transferred.schemaVersion, 1);
  assert.equal(transferred.preferences.find(item => item.key === 'vmusic.theme.v2').value, 'celestial');
  assert.equal(transferred.preferences.find(item => item.key === 'vmusic.playlists.mode').value, 'shelf');
  const transferredStage = transferred.preferences.find(item => item.key === 'vmusic.stage.control').value;
  assert.equal(transferredStage.enabled, false); assert.equal(transferredStage.bokeh, 5);
  assert.equal(Object.hasOwn(transferredStage, 'coverSize'), false, 'Retired coverSize does not re-enter portable stage preferences');
  assert.ok(transferred.preferences.every(item => !['vmusic.theme.mineral-default', 'vmusic.playlists.viewV2', 'vmusic.stage.control.v'].includes(item.key)));
  assert.equal(await page.locator('#ui-preferences-status').innerText(), '界面偏好已保存');
  assert.deepEqual((await preferenceState()).storage, source.storage, 'Export never applies its generated migration markers to the source profile');
  const sourceOrigin = new URL(page.url()).origin;
  await page.screenshot({ path: path.join(output, 'preferences-source-exported.png') });
  await live('preferences-source');
  mark('actual full-app preference export uses the real native save dialog, records exact bytes and distinguishes Cancel while real StagePersistence is hydrated');

  await stopCurrent();
  assert.equal(fs.existsSync(dataB), false, 'Destination starts with a new isolated data directory');
  const targetPort = await freePort(); await start(dataB, targetPort); await preferencesReady();
  assert.notEqual(new URL(page.url()).origin, sourceOrigin, 'Destination uses a different service origin and a new native WebView profile');
  assert.equal(discovery.port, targetPort);
  const before = await preferenceState(); snapshot('preferences-target-b-before', before);
  assert.notEqual(before.theme, 'celestial');
  assert.equal(before.stage.enabled, true); assert.equal(before.stage.bokeh, 3);
  assert.ok([null, 'hertz-dark'].includes(before.storage['vmusic.theme.v2']));
  assert.ok([null, 'grid'].includes(before.storage['vmusic.playlists.mode']));
  assert.ok([null, '1'].includes(before.storage['vmusic.theme.mineral-default']));
  assert.ok([null, '1'].includes(before.storage['vmusic.playlists.viewV2']));
  assert.ok([null, '2'].includes(before.storage['vmusic.stage.control.v']));
  await openPreferenceSettings();
  const retired = structuredClone(transferred);
  retired.preferences.find(item => item.key === 'vmusic.stage.control').value.coverSize = 52;
  const retiredPath = path.join(exportsDirectory, 'ui-preferences-retired-cover.json');
  fs.writeFileSync(retiredPath, JSON.stringify(retired));
  await page.locator('#ui-preferences-file').setInputFiles(retiredPath);
  await page.waitForFunction(() => document.getElementById('ui-preferences-status').textContent.includes('coverSize')
    && document.getElementById('ui-preferences-status').classList.contains('ui-preference-error'));
  assert.equal(await page.locator('#ui-preferences-dialog').isVisible(), false);
  assert.deepEqual((await preferenceState()).storage, before.storage, 'Retired stage parameter rejects before any preference write');
  snapshot('preferences-retired-cover-rejected', { status: await page.locator('#ui-preferences-status').innerText(), state: await preferenceState() });
  await page.locator('#ui-preferences-file').setInputFiles(preferencePath);
  await page.locator('#ui-preferences-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#ui-preferences-rows tr').count(), transferred.preferences.length);
  assert.deepEqual((await preferenceState()).storage, before.storage, 'File preview does not write destination preferences');
  await page.screenshot({ path: path.join(output, 'preferences-target-preview.png') });
  await page.locator('#ui-preferences-cancel').click();
  await page.locator('#ui-preferences-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual((await preferenceState()).storage, before.storage, 'Preview Cancel preserves target values');
  await page.locator('#ui-preferences-file').setInputFiles(preferencePath);
  await page.locator('#ui-preferences-dialog').waitFor({ state: 'visible' });
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }), page.locator('#ui-preferences-apply').click()]);
  await preferencesReady(); await instrumentation();
  const assertTransferred = async label => {
    const value = await preferenceState(); snapshot(label, value);
    assert.equal(value.theme, 'celestial'); assert.equal(value.themeAttribute, 'celestial');
    assert.equal(value.storage['vmusic.theme.v2'], 'celestial'); assert.equal(value.storage['vmusic.theme.mineral-default'], '1');
    assert.equal(value.storage['vmusic.playlists.mode'], 'shelf'); assert.equal(value.storage['vmusic.playlists.viewV2'], '1');
    assert.equal(value.shelfPressed, 'true'); assert.equal(value.shelfOn, true);
    assert.equal(value.storage['vmusic.stage.control.v'], '2');
    assert.equal(value.storage['vmusic.stage.control'], JSON.stringify(transferredStage));
    assert.equal(value.stage.enabled, false); assert.equal(value.stage.bokeh, 5); assert.equal(value.filterEnabled, false);
    assert.equal(value.stagePersistence.hydrated, true);
    await live(label);
  };
  await assertTransferred('preferences-target-b-reloaded');
  await openPreferenceSettings();
  await page.screenshot({ path: path.join(output, 'preferences-target-applied.png') });
  mark('actual file input rejects retired coverSize, then preview and Apply reload migrate celestial, shelf and enabled=false/bokeh=5 with owner markers in a new WebView profile');
  await page.evaluate(() => hertzHost.flushStorage());
  await stopCurrent(); await start(dataB, targetPort); await preferencesReady();
  assert.equal(discovery.port, targetPort, 'Restart keeps the same origin for persistent WebView localStorage');
  await assertTransferred('preferences-target-b-restarted');
  assert.deepEqual(errors, []);
  mark('graceful restart of the isolated target profile preserves the imported choices and all migration markers on disk');
}
async function hold(file) {
  const holder = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $stream=[IO.FileStream]::new($env:HERTZ_FILES_HELD_PATH,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); Write-Output "HELD"; [Console]::ReadLine() | Out-Null; $stream.Dispose()'], {
    cwd: output, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HERTZ_FILES_HELD_PATH: file },
  });
  holders.add(holder); holder.out = ''; holder.err = '';
  holder.stdout.on('data', chunk => { holder.out += chunk; });
  holder.stderr.on('data', chunk => { holder.err += chunk; });
  holder.on('error', error => { holder.error = error; });
  await until(() => {
    if (holder.error) throw holder.error;
    assert.equal(holder.exitCode, null, holder.err);
    return holder.out.includes('HELD');
  }, 'owned exclusive file handle');
  return holder;
}
async function release(holder) {
  holder.stdin.end('\n');
  await until(() => holder.exitCode !== null, 'owned file holder exits');
  assert.equal(holder.exitCode, 0, holder.err); holders.delete(holder);
}
async function startForeignFixture() {
  foreignServer = http.createServer((request, response) => {
    foreignRequests.push(request.url);
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html><body><button id="download">Foreign blob download</button><script>'
      + 'window.__foreignMainExecuted=true;document.getElementById("download").onclick=function(){var url=URL.createObjectURL(new Blob(["foreign-content"],{type:"text/plain"}));'
      + 'parent.postMessage({fixture:"native-files-foreign",url:url},"*");var a=document.createElement("a");a.href=url;a.download="foreign-denied.txt";'
      + 'document.body.appendChild(a);a.click();a.remove();};</script></body></html>');
  });
  await new Promise(resolve => foreignServer.listen(0, '127.0.0.1', resolve));
  foreignOrigin = 'http://127.0.0.1:' + foreignServer.address().port;
}
async function main() {
  assert.equal(process.platform, 'win32', 'This check requires real Windows dialogs');
  assert.ok(['all', 'files', 'preferences'].includes(scope), 'HERTZ_FILES_SCOPE must be all, files or preferences');
  assert.ok(fs.existsSync(binary), 'Fresh HERTZ_BIN must exist');
  fs.mkdirSync(exportsDirectory, { recursive: true });
  await startForeignFixture(); await start();
  if (scope === 'preferences') { await checkPreferenceTransfer(); return; }
  const musicDirectory = path.join(output, 'music'); fs.mkdirSync(musicDirectory);
  const wav = Buffer.alloc(44 + 8000 * 600 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  fs.writeFileSync(path.join(musicDirectory, 'native-files.wav'), wav);
  await api('/v1/library/scan', 'POST', { root: musicDirectory });
  const track = await until(async () => (await api('/v1/tracks?limit=20')).tracks[0], 'owned local WAV scan');
  trackId = track.id; await api('/v1/player/load', 'POST', { track_id: trackId });
  await until(async () => (await api('/v1/state')).playing, 'real null-output audio actor starts');
  const text = JSON.stringify({ kind: 'hertz-ui-preferences-fixture', version: 1, theme: '暖灰',
    strings: ['保存后的精确字节', '🎵', 'quote " slash \\', '\u0000', 'line one\r\nline two'], number: 1.25 }, null, 2) + '\r\n';
  const exactPath = path.join(exportsDirectory, 'native-exact-字节.json');
  await request('exact-json', 'native-exact-字节.json', text);
  const exact = await saveTo('exact-json', exactPath);
  assert.ok(exact.url.startsWith('blob:http://127.0.0.1:' + discovery.port + '/'));
  assert.deepEqual(fs.readFileSync(exactPath), Buffer.from(text, 'utf8'));
  await live('exact-json');
  mark('same-service blob opens a real owner-bound save dialog and writes exact UTF-8 JSON including Unicode and CRLF');

  await request('cancelled', 'native-cancel.json', text);
  const cancelDialog = await openSave('cancelled');
  assert.equal((await readRequest('cancelled')).status, 'pending');
  native('fill', cancelDialog.handle, path.join(exportsDirectory, 'native-cancel.json'));
  native('cancel', cancelDialog.handle);
  await settled('cancelled', 'cancelled'); await delay(600);
  assert.equal((await readRequest('cancelled')).status, 'cancelled');
  assert.equal(fs.existsSync(path.join(exportsDirectory, 'native-cancel.json')), false);
  snapshot('cancel-events', await page.evaluate(() => __nativeFileChecks.events));
  await live('cancelled');
  mark('native Cancel resolves cancelled once, ignores any subsequent interrupted-download receipt and preserves the main window/service and real audio actor');

  const overwriteText = JSON.stringify({ overwritten: true, label: '覆盖确认' }, null, 2);
  await request('overwrite', path.basename(exactPath), overwriteText);
  const overwriteDialog = await openSave('overwrite');
  native('fill', overwriteDialog.handle, exactPath); native('save', overwriteDialog.handle);
  let windows = await until(() => { const current = native(); return confirmation(current) && current; }, 'native overwrite confirmation');
  snapshot('overwrite-confirmation-no', windows);
  assert.deepEqual(fs.readFileSync(exactPath), Buffer.from(text, 'utf8'));
  assert.equal((await readRequest('overwrite')).status, 'pending');
  native('no', confirmation(windows).handle);
  await until(() => { const current = native(); return !confirmation(current) && saveDialog(current); }, 'overwrite No returns to save dialog');
  assert.deepEqual(fs.readFileSync(exactPath), Buffer.from(text, 'utf8'));
  native('save', saveDialog(native()).handle);
  windows = await until(() => { const current = native(); return confirmation(current) && current; }, 'second overwrite confirmation');
  snapshot('overwrite-confirmation-yes', windows);
  native('yes', confirmation(windows).handle); await settled('overwrite');
  assert.deepEqual(fs.readFileSync(exactPath), Buffer.from(overwriteText, 'utf8')); await live('overwrite');
  mark('saving to the same path requires actual Windows overwrite confirmation; No preserves bytes and Yes replaces the selected file');

  await request('missing-directory', 'missing-directory.json', text);
  const missingDialog = await openSave('missing-directory');
  const missingPath = path.join(exportsDirectory, 'does-not-exist', 'missing-directory.json');
  native('fill', missingDialog.handle, missingPath); native('save', missingDialog.handle);
  windows = await until(() => { const current = native(); return errorDialog(current) && current; }, 'native nonexistent-directory error');
  snapshot('missing-directory-error', windows);
  assert.equal((await readRequest('missing-directory')).status, 'pending');
  assert.equal(fs.existsSync(missingPath), false);
  native('ok', errorDialog(windows).handle);
  await until(() => { const current = native(); return !errorDialog(current) && saveDialog(current); }, 'invalid-path error dismissed');
  const recoveredMissing = path.join(exportsDirectory, 'missing-directory-recovered.json');
  await saveTo('missing-directory', recoveredMissing, saveDialog(native()));
  assert.deepEqual(fs.readFileSync(recoveredMissing), Buffer.from(text, 'utf8')); await live('missing-directory');
  mark('a nonexistent destination produces a real Windows error with no success receipt; choosing an existing directory then saves successfully');

  const lockedPath = path.join(exportsDirectory, 'locked.json');
  const originalLocked = Buffer.from('{"preserved":"locked-original"}', 'utf8'); fs.writeFileSync(lockedPath, originalLocked);
  const holder = await hold(lockedPath);
  await request('locked-file', 'locked.json', text); const lockedDialog = await openSave('locked-file');
  native('fill', lockedDialog.handle, lockedPath); native('save', lockedDialog.handle);
  windows = await until(() => { const current = native(); return confirmation(current) && current; }, 'locked destination overwrite confirmation');
  snapshot('locked-file-confirmation', windows); native('yes', confirmation(windows).handle);
  const failedWrite = await settled('locked-file', 'failed');
  assert.match(failedWrite.error, /文件保存失败.*更换保存位置/);
  assert.equal(saveDialog(native()), undefined, 'Real failed download releases the native modal dialog');
  const failedEvents = await page.evaluate(url => __nativeFileChecks.events.filter(event => event.url === url), failedWrite.url);
  assert.ok(failedEvents.some(event => event.status === 'failed'));
  assert.equal(failedEvents.some(event => event.status === 'saved'), false);
  snapshot('locked-file-failed-write', { request: failedWrite, events: failedEvents });
  await live('locked-file-failed-write');
  const recoveredLocked = path.join(exportsDirectory, 'locked-file-recovered.json');
  await request('locked-file-retry', 'locked-file-recovered.json', text);
  await saveTo('locked-file-retry', recoveredLocked); await release(holder);
  assert.deepEqual(fs.readFileSync(lockedPath), originalLocked);
  assert.deepEqual(fs.readFileSync(recoveredLocked), Buffer.from(text, 'utf8')); await live('locked-file');
  mark('an exclusively held destination fails the real WebView2 write, rejects once without success, preserves original bytes and supports a fresh save to a new location');

  const backup = await api('/v1/backup');
  await openPreferenceSettings();
  await page.evaluate(() => { __nativeFileChecks.nextId = 'backup-button'; });
  await page.locator('#backup-export').click();
  const backupPath = path.join(exportsDirectory, 'backup-button.json'); const backupReceipt = await saveTo('backup-button', backupPath);
  assert.deepEqual(fs.readFileSync(backupPath), Buffer.from(backupReceipt.text, 'utf8'));
  const savedBackup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  delete savedBackup.exported_at; delete backup.exported_at;
  delete savedBackup.settings.session_snapshot; delete backup.settings.session_snapshot;
  assert.deepEqual(savedBackup, backup);
  assert.equal(await page.locator('#toast').textContent(), '备份已保存');
  await page.evaluate(() => { __nativeFileChecks.nextId = 'backup-cancel'; });
  await page.locator('#backup-export').click();
  const backupCancel = await openSave('backup-cancel');
  native('fill', backupCancel.handle, path.join(exportsDirectory, 'backup-cancel.json')); native('cancel', backupCancel.handle);
  await settled('backup-cancel', 'cancelled');
  assert.equal(await page.locator('#toast').textContent(), '已取消保存');
  assert.equal(await page.locator('#toast').evaluate(element => element.classList.contains('error')), false);
  await live('backup-button');
  mark('the actual backup button uses native text saving and reports saved/cancelled accurately without a cancellation error toast');

  await page.evaluate(origin => {
    window.addEventListener('message', event => { if (event.origin === origin && event.data?.fixture === 'native-files-foreign') window.__foreignBlobUrl = event.data.url; });
    const frame = document.createElement('iframe'); frame.id = 'native-files-foreign-frame'; frame.src = origin + '/foreign-frame';
    Object.assign(frame.style, { position: 'fixed', top: '16px', left: '16px', width: '320px', height: '160px', zIndex: '2147483647' });
    document.body.appendChild(frame);
  }, foreignOrigin);
  const foreignFrame = await until(() => page.frames().find(frame => frame.url().startsWith(foreignOrigin)), 'real foreign-origin frame');
  await foreignFrame.locator('#download').click();
  const foreignUrl = await until(() => page.evaluate(() => window.__foreignBlobUrl), 'foreign blob URL');
  await until(() => page.evaluate(url => __nativeFileChecks.events.some(event => event.url === url && event.status === 'failed'), foreignUrl), 'native rejects foreign blob');
  assert.equal(saveDialog(native()), undefined, 'Rejected foreign download never opens a save dialog');
  assert.equal(fs.existsSync(path.join(exportsDirectory, 'foreign-denied.txt')), false);
  snapshot('foreign-download-receipts', await page.evaluate(() => __nativeFileChecks.events));
  await page.evaluate(() => document.getElementById('native-files-foreign-frame').remove());
  const currentUrl = page.url();
  const documentSentinel = crypto.randomUUID();
  await page.evaluate(marker => { window.__nativeFileNavigationSentinel = marker; }, documentSentinel);
  await page.evaluate(url => { location.href = url; }, foreignOrigin + '/blocked-top-navigation');
  await delay(1000); assert.equal(page.url(), currentUrl);
  assert.equal(await page.evaluate(() => __nativeFileNavigationSentinel), documentSentinel, 'Rejected foreign navigation preserves the original document');
  assert.equal(await page.evaluate(() => window.__foreignMainExecuted), undefined, 'Foreign main-frame code never executes');
  snapshot('foreign-navigation', { attempted: foreignOrigin + '/blocked-top-navigation', documentCommitBlocked: true,
    contactedDestination: foreignRequests.includes('/blocked-top-navigation') });
  await live('foreign-origin');
  mark('a real foreign-origin iframe blob is rejected by the native download handler; foreign main-frame navigation is also denied');

  const oldUrl = exact.url;
  await page.reload();
  await page.waitForFunction(() => __hertzWindowHost?.downloadVersion === 1 && window.hertzHost?.saveTextFile);
  await instrumentation();
  await request('reload-new-task', 'reload-new-task.json', text); const reloadDialog = await openSave('reload-new-task');
  const newRequest = await readRequest('reload-new-task'); assert.notEqual(newRequest.url, oldUrl);
  await page.evaluate(url => window.dispatchEvent(new CustomEvent('hertz-native-download-result', { detail: { url, status: 'saved' } })), oldUrl);
  assert.equal((await readRequest('reload-new-task')).status, 'pending', 'Old-document receipt must not complete new-document task');
  const reloadedPath = path.join(exportsDirectory, 'reload-new-task.json');
  await saveTo('reload-new-task', reloadedPath, reloadDialog);
  assert.deepEqual(fs.readFileSync(reloadedPath), Buffer.from(text, 'utf8')); await live('reload-new-task');
  assert.deepEqual(errors, []);
  mark('renderer reload gives the new save a distinct blob URL; replaying an old-document receipt cannot settle the new native save');
  if (scope !== 'files') await checkPreferenceTransfer();
}
async function cleanup() {
  for (const holder of holders) {
    try { holder.stdin.end('\n'); } catch {}
    if (holder.exitCode === null && holder.signalCode === null) holder.kill();
  }
  holders.clear();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill(); await until(() => child.exitCode !== null || child.signalCode !== null, 'owned native process cleanup', 10000);
  }
  if (browser) await browser.close().catch(() => {});
  if (foreignServer) await new Promise(resolve => foreignServer.close(resolve));
}
main().then(async () => {
  await stopCurrent(); await cleanup();
  snapshot('report', { passed: true, cleanupDone: true, binary, binarySha256: hash(binary), scope, launches, checks, errors,
    sourceSha256: Object.fromEntries(['crates/hertz-studio/src/window.rs', 'plugin/ui/host.js', 'plugin/ui/app.js',
      'plugin/ui/ui-preferences.js', 'plugin/ui/ui-preference-settings.js', 'plugin/ui/themes.js', 'plugin/ui/stage-control.js',
      'plugin/ui/creative-stage.js', 'plugin/ui/stage-persistence.js',
      'scripts/check-main-window-files-native.js', 'scripts/main-window-files-dialog-fixture.ps1'].map(file => [file, hash(path.join(root, file))])),
    limitations: ['single Windows/WebView2 host with null audio', 'nonexistent directories reject in the common dialog; exclusive-file failure reaches actual WebView2 failed completion',
      'old receipt isolation replays an old blob URL after a real reload; it does not interrupt an in-progress network download', 'no macOS/Linux native-dialog qualification'],
  });
  console.log(JSON.stringify({ output, checks }, null, 2));
}).catch(async error => {
  fs.mkdirSync(output, { recursive: true });
  if (child) { try { snapshot('failure-native-windows', native()); } catch {} }
  if (page && !page.isClosed()) {
    try { snapshot('failure-requests', await page.evaluate(() => window.__nativeFileChecks)); } catch {}
    await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 5000 }).catch(() => {});
  }
  await cleanup().catch(() => {});
  snapshot('report', { passed: false, error: error.stack, checks, errors, binary, ...(fs.existsSync(binary) ? { binarySha256: hash(binary) } : {}) });
  console.error(error); console.error(output); process.exitCode = 1;
});
