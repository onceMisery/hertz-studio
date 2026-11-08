#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// One owned native main window and its independent read-only OBS preview. Run GUI journeys sequentially.
// Pin HERTZ_BIN to the final Full/native candidate; PLAYWRIGHT_MODULE/HERTZ_PYTHON may select bundled runtimes.
// HERTZ_OBS_DIAGNOSIS_ONLY=1 runs only the first three groups without OS foreground admission; it is not native OBS qualification.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const binary = path.resolve(process.env.HERTZ_BIN || path.join(root, 'target/debug/hertz-studio.exe'));
const output = path.join(root, 'output/playwright/native-obs-preview-' + Date.now()), data = path.join(output, 'data');
const nativeFixture = path.join(output, 'owned-preview.ps1');
const geometryFixture = path.join(__dirname, 'main-window-geometry-fixture.ps1');
const pointerFixture = path.join(__dirname, 'native-main-window-pointer-fixture.ps1');
const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const python = process.env.HERTZ_PYTHON || 'python';
const previewTitle = 'Hertz Studio · OBS 歌词预览';
const diagnosisOnly = process.env.HERTZ_OBS_DIAGNOSIS_ONLY === '1';
const qualificationScope = diagnosisOnly
  ? 'diagnostic only: first three groups, skips OS foreground admission; cannot replace formal nine-group native OBS qualification'
  : 'formal nine-group native OBS qualification with OS foreground admission and preview focus assertions';
const checks = [], errors = [], launches = [], previewHistory = [], foreignRequests = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function verifyEvidence() {
  assert.deepEqual(errors, []);
  assert.equal(hash(binary), candidateHash, 'Candidate bytes stay fixed during this run');
  for (const [file, sha] of Object.entries(sourceHashes)) assert.equal(hash(path.join(root, file)), sha, 'Source stays fixed during this run: ' + file);
}
let child = null, mainBrowser, previewBrowser, mainPage, previewPage, discovery, readKey, chromium, foreignServer, foreignOrigin;
let sourceHashes, candidateHash, heldKeyRelease;
const fixtureSource = String.raw`param([Parameter(Mandatory=$true)][int]$OwnerPid,[ValidateSet('read','close','bounds','compile-only')][string]$Action='read',[long]$Handle=0,[int]$X=0,[int]$Y=0,[int]$Width=0,[int]$Height=0)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public sealed class ObsOwnedWindow { public long handle; public uint pid; public string title; public string kind; public bool visible; public bool enabled; public bool maximized; public bool minimized; public int x,y,width,height; }
public static class ObsOwnedWindows {
 public delegate bool Callback(IntPtr window,IntPtr parameter);
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left,top,right,bottom; }
 [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback,IntPtr parameter);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window,StringBuilder text,int length);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder text,int length);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window,out RECT rectangle);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr window);
 [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr window);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window,uint message,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);
 static string Text(IntPtr window,bool kind) { var text=new StringBuilder(512); if(kind) GetClassName(window,text,text.Capacity); else GetWindowText(window,text,text.Capacity); return text.ToString(); }
 public static void Physical() { if(SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero) throw new InvalidOperationException("Physical DPI context unavailable"); }
 public static List<ObsOwnedWindow> Read(uint owner) { var windows=new List<ObsOwnedWindow>(); EnumWindows((window,parameter)=> { uint pid; GetWindowThreadProcessId(window,out pid); if(pid!=owner) return true; RECT rect; GetWindowRect(window,out rect); windows.Add(new ObsOwnedWindow {handle=window.ToInt64(),pid=pid,title=Text(window,false),kind=Text(window,true),visible=IsWindowVisible(window),enabled=IsWindowEnabled(window),maximized=IsZoomed(window),minimized=IsIconic(window),x=rect.left,y=rect.top,width=rect.right-rect.left,height=rect.bottom-rect.top}); return true; },IntPtr.Zero); return windows; }
 public static void Act(uint owner,IntPtr window,string action,int x,int y,int width,int height) { uint pid; GetWindowThreadProcessId(window,out pid); var title=Encoding.Unicode.GetString(Convert.FromBase64String("${Buffer.from(previewTitle, 'utf16le').toString('base64')}")); if(window==IntPtr.Zero||pid!=owner||Text(window,false)!=title) throw new InvalidOperationException("Refusing a handle outside the exact owned preview"); if(action=="close") {if(!PostMessage(window,16,IntPtr.Zero,IntPtr.Zero)) throw new InvalidOperationException("Owned preview WM_CLOSE failed");} else if(action=="bounds") {if(width<=0||height<=0||!SetWindowPos(window,IntPtr.Zero,x,y,width,height,4|16)) throw new InvalidOperationException("Owned preview SetWindowPos failed");} else throw new InvalidOperationException("Unknown action"); }
}
'@
if($Action -eq 'compile-only') { 'Owned OBS Win32 types compile; no window action executed'; exit 0 }
[ObsOwnedWindows]::Physical()
if($Action -ne 'read') { [ObsOwnedWindows]::Act([uint32]$OwnerPid,[IntPtr]$Handle,$Action,$X,$Y,$Width,$Height) }
@{windows=@([ObsOwnedWindows]::Read([uint32]$OwnerPid));foreground=[ObsOwnedWindows]::GetForegroundWindow().ToInt64()}|ConvertTo-Json -Depth 5 -Compress
`;
function redact(value) {
  if (typeof value === 'string') {
    for (const secret of [discovery?.token, readKey].filter(Boolean)) value = value.split(secret).join('<redacted>');
    return value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  return value;
}
function snapshot(name, value) { fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(redact(value), null, 2)); }
const mark = text => { checks.push(text); console.log('PASS ' + text); };
async function until(read, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(150); }
  throw new Error('Timed out: ' + label);
}
function native(action = 'read', window, bounds) {
  assert.ok(child?.pid, 'Win32 calls require the owned main process');
  return JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', nativeFixture,
    '-OwnerPid', String(child.pid), '-Action', action, ...(window ? ['-Handle', String(window.handle)] : []),
    ...(bounds ? ['-X', String(bounds.x), '-Y', String(bounds.y), '-Width', String(bounds.width), '-Height', String(bounds.height)] : [])], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  }));
}
const previews = () => native().windows.filter(window => window.title === previewTitle);
function mainGeometry() {
  const geometry = JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', geometryFixture,
    '-OwnerPid', String(child.pid)], { encoding: 'utf8', windowsHide: true, timeout: 15000 }));
  if (launches[0].mainHandle !== undefined) assert.equal(geometry.handle, launches[0].mainHandle, 'Main HWND remains the one discovered at launch');
  return geometry;
}
async function api(endpoint, method = 'GET', body, expected = 200, type = 'application/json') {
  const response = await fetch('http://127.0.0.1:' + discovery.port + endpoint, { method,
    headers: { Authorization: 'Bearer ' + discovery.token, 'Content-Type': type },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const text = await response.text(); assert.equal(response.status, expected, endpoint + ': ' + text); return JSON.parse(text);
}
function activePort(profileRoot) {
  for (const relative of ['DevToolsActivePort', 'EBWebView/DevToolsActivePort', 'Default/DevToolsActivePort', 'EBWebView/Default/DevToolsActivePort']) {
    try { const port = Number(fs.readFileSync(path.join(profileRoot, relative), 'utf8').split(/\r?\n/)[0]); if (port > 0 && port < 65536) return port; } catch {}
  }
  return null;
}
async function connect(profileRoot, urlPredicate) {
  const port = await until(() => activePort(profileRoot), 'isolated WebView2 DevToolsActivePort', 45000);
  await until(async () => { try { return (await fetch('http://127.0.0.1:' + port + '/json/version')).ok; } catch { return false; } }, 'isolated CDP endpoint');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { noDefaults: true });
  const page = await until(() => browser.contexts().flatMap(context => context.pages()).find(candidate => urlPredicate(candidate.url())), 'isolated CDP page');
  page.setDefaultTimeout(18000); page.on('pageerror', error => errors.push(error.message));
  return { browser, page, port };
}
async function instrument() {
  await mainPage.evaluate(() => {
    const state = window.__obsNativeChecks = { requests: {}, receipts: [], messages: [], windowOpenCalls: [], held: [], hold: false, nextId: null };
    window.addEventListener('hertz-native-obs-preview-result', event => state.receipts.push(event.detail));
    const openWindow = window.open;
    window.open = function (...args) { state.windowOpenCalls.push(args.map(String)); return openWindow.apply(window, args); };
    // Wry freezes window.ipc; its forwarding function reads this writable WebView2 method.
    const ipc = window.ipc, webview = window.chrome?.webview;
    if (!webview || typeof webview.postMessage !== 'function') throw new Error('Writable WebView2 transport is unavailable');
    const originalPost = webview.postMessage;
    const post = originalPost.bind(webview);
    state.originalPost = originalPost;
    state.release = message => post(JSON.stringify(message));
    const interceptedPost = text => {
      let message; try { message = JSON.parse(text); } catch {}
      if (message?.kind === 'obs-preview') { state.messages.push(message); if (state.hold) { state.held.push(message); return; } }
      return post(text);
    };
    webview.postMessage = interceptedPost;
    if (webview.postMessage !== interceptedPost || window.ipc !== ipc) throw new Error('WebView2 interception did not preserve the Wry bridge');
    state.hold = true;
    ipc.postMessage(JSON.stringify({ kind: 'obs-preview', requestId: 'fixture-interception-probe' }));
    if (state.messages.length !== 1 || state.held.length !== 1) throw new Error('Wry forwarding did not reach the held WebView2 interception');
    state.hold = false; state.messages.length = 0; state.held.length = 0;
    state.captureVerified = true;
    const original = window.__hertzWindowHost.openObsPreview;
    window.__hertzWindowHost.openObsPreview = url => {
      const id = state.nextId || 'request-' + Object.keys(state.requests).length; state.nextId = null;
      const request = state.requests[id] = { url, status: 'pending', settlements: 0 };
      const promise = original(url);
      return promise.then(value => { request.status = 'opened'; request.settlements++; return value; }, error => {
        request.status = 'failed'; request.settlements++; request.error = String(error.message || error); throw error;
      });
    };
  });
}
async function request(id, url) {
  await mainPage.evaluate(({ id, url }) => { __obsNativeChecks.nextId = id; void __hertzWindowHost.openObsPreview(url).catch(() => {}); }, { id, url });
}
async function settled(id, status) {
  const value = await until(() => mainPage.evaluate(id => { const request = __obsNativeChecks.requests[id]; return request?.status !== 'pending' && request; }, id), id + ' native receipt', 20000);
  assert.equal(value.status, status, JSON.stringify(redact(value))); assert.equal(value.settlements, 1); snapshot(id, value); return value;
}
async function settings() {
  await mainPage.locator('.rail-item[data-view="settings"]').click();
  await mainPage.locator('#view-settings .hz-settings-nav [data-category="lyrics"]').click();
  await mainPage.locator('#overlay-open').waitFor({ state: 'visible' });
}
async function clickPreview(id, style = 'karaoke') {
  await mainPage.locator('#overlay-style').selectOption(style);
  await mainPage.evaluate(id => { __obsNativeChecks.nextId = id; }, id);
  if (!diagnosisOnly) {
    const before = native();
    const main = JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', geometryFixture,
      '-OwnerPid', String(child.pid), '-Handle', String(launches[0].mainHandle), '-Action', 'focus'],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 }));
    assert.equal(main.handle, launches[0].mainHandle, 'Foreground preparation controls only the original owned main HWND');
    const pointer = JSON.parse(execFileSync(powershell, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',pointerFixture,
      '-OwnerPid',String(child.pid),'-Handle',String(main.handle)], { encoding:'utf8',windowsHide:true,timeout:15000 }));
    assert.equal(pointer.foreground,main.handle,'Actual owned title-bar pointer click makes the main HWND foreground');
    const foreground = await until(() => { const state = native(); return state.foreground === main.handle && state; }, 'owned main is foreground before actual preview action ' + id);
    snapshot('main-foreground-' + id, { beforeForeground: before.foreground, native: foreground });
  }
  await mainPage.locator('#overlay-open').click();
}
async function attachPreview() {
  const window = await until(() => { const windows = previews(); assert.ok(windows.length <= 1, 'At most one managed preview'); return windows[0]?.visible && windows[0]; }, 'owned visible OBS preview');
  if (!previewBrowser || !previewPage || previewPage.isClosed()) {
    if (previewBrowser) await previewBrowser.close().catch(() => {});
    const connected = await connect(path.join(data, 'webview/obs-preview'), url => { try { return new URL(url).pathname === '/overlay'; } catch { return false; } });
    previewBrowser = connected.browser; previewPage = connected.page; previewHistory.push({ handle: window.handle, cdpPort: connected.port });
  }
  await previewPage.waitForFunction(() => document.readyState === 'complete' && document.getElementById('v-karaoke'));
  return window;
}
async function live(label, mainBounds, placement) {
  assert.equal(child.exitCode, null); const audio = await api('/v1/state'); assert.equal(audio.playing, true); assert.equal(audio.track_id, launches[0].trackId);
  const geometry = mainGeometry();
  assert.equal(geometry.handle, launches[0].mainHandle, 'Live checks retain the initial owned main HWND');
  if (mainBounds) assert.deepEqual(geometry.outerBounds, mainBounds, 'Auxiliary events preserve main outer bounds');
  if (placement) assert.deepEqual((await api('/v1/settings')).native_window_placement, placement, 'Auxiliary events preserve main placement store');
  assert.ok(geometry.visible && !geometry.minimized); snapshot(label, { audio, main: geometry, windows: native() });
}
async function closePreview(label) {
  const window = previews()[0]; assert.ok(window); native('close', window);
  await until(() => previews().length === 0, 'owned preview WM_CLOSE');
  if (previewBrowser) await previewBrowser.close().catch(() => {});
  previewBrowser = previewPage = null; snapshot(label, native());
}
async function rejectedNavigation(page, url, label) {
  const previous = page.url(), marker = crypto.randomUUID();
  await page.evaluate(marker => { window.__obsNavigationMarker = marker; }, marker);
  await page.evaluate(url => { location.href = url; }, url); await delay(700);
  assert.equal(page.url(), previous, label + ': rejected navigation keeps the same URL');
  assert.equal(await page.evaluate(() => __obsNavigationMarker), marker, label + ': original document remains committed');
  assert.equal(await page.evaluate(() => window.__foreignObsExecuted), undefined);
  snapshot(label, { attempted: url, documentCommitBlocked: true });
}
async function pointerProbe(page, name, action, value) {
  await page.evaluate(({ name, action, value }) => {
    document.getElementById('obs-native-pointer-probe')?.remove();
    const button = document.createElement('button'); button.id = 'obs-native-pointer-probe'; button.textContent = name;
    Object.assign(button.style, { position: 'fixed', left: '16px', top: '16px', padding: '12px', zIndex: '2147483647' });
    button.onclick = event => {
      const result = window.__obsPointerResult = { trusted: event.isTrusted, action };
      if (action === 'popup') result.returnedNull = window.open(value, '_blank') === null;
      else {
        const url = URL.createObjectURL(new Blob(['owned-native-obs-download-denial'], { type: 'text/plain' })); result.url = url;
        const link = document.createElement('a'); link.href = url; link.download = value; document.body.appendChild(link); link.click(); link.remove();
      }
    }; document.body.appendChild(button);
  }, { name, action, value });
  await page.locator('#obs-native-pointer-probe').click();
  const result = await page.evaluate(() => __obsPointerResult); assert.equal(result.trusted, true);
  await page.evaluate(() => document.getElementById('obs-native-pointer-probe').remove()); return result;
}
function downloadHistory() {
  const file = path.join(data, 'webview/obs-preview/EBWebView/Default/History');
  if (!fs.existsSync(file)) return { available: false, rows: [] };
  const code = String.raw`import json,pathlib,sqlite3,sys
connection=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True,timeout=5)
try:
 columns=[row[1] for row in connection.execute('PRAGMA table_info(downloads)')]
 selected=[name for name in ['id','state','interrupt_reason','target_path','current_path','tab_url'] if name in columns]
 rows=connection.execute('SELECT '+','.join(selected)+' FROM downloads ORDER BY id').fetchall() if selected else []
 print(json.dumps({'available': bool(selected),'rows':[dict(zip(selected,row)) for row in rows]}))
finally: connection.close()`;
  return JSON.parse(execFileSync(python, ['-c', code, file], { encoding: 'utf8', windowsHide: true, timeout: 10000 }));
}
async function stopCurrent() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await api('/v1/player/pause', 'POST', {}); await until(async () => (await api('/v1/state')).playing === false, 'audio pauses before main quit');
  await api('/v1/system/shutdown', 'POST', {}, 202);
  await until(() => child.exitCode !== null || child.signalCode !== null, 'owned main graceful shutdown', 30000);
  assert.equal(child.exitCode, 0); assert.equal(fs.existsSync(path.join(data, 'vmusicd.json')), false);
  const remaining = native(); assert.equal(remaining.windows.length, 0, 'Main shutdown removes all owned native windows');
  launches[0].exitCode = child.exitCode; launches[0].graceful = true; launches[0].discoveryRemoved = true;
  snapshot('main-shutdown-cleanup', remaining);
}
async function cleanup() {
  if (heldKeyRelease) heldKeyRelease();
  if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await until(() => child.exitCode !== null || child.signalCode !== null, 'owned failed-test child cleanup', 10000); }
  if (previewBrowser) await previewBrowser.close().catch(() => {});
  if (mainBrowser) await mainBrowser.close().catch(() => {});
  if (foreignServer) await new Promise(resolve => foreignServer.close(resolve));
  if (child && launches[0]) {
    launches[0].exitCode = child.exitCode; launches[0].signalCode = child.signalCode;
    launches[0].graceful = launches[0].graceful === true;
    launches[0].discoveryRemoved = !fs.existsSync(path.join(data, 'vmusicd.json'));
    snapshot('owned-cleanup', { launch: launches[0], native: native() });
  }
}
async function main() {
  assert.equal(process.platform, 'win32'); assert.ok(fs.existsSync(binary), 'Final Full/native candidate must exist');
  chromium = require(process.env.PLAYWRIGHT_MODULE || 'playwright').chromium;
  fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(nativeFixture, fixtureSource, 'utf8'); candidateHash = hash(binary);
  const files = ['crates/hertz-studio/src/main.rs', 'crates/hertz-studio/src/rpc/maintenance.rs',
    'crates/hertz-studio/src/window.rs', 'crates/hertz-studio/src/window/obs_preview.rs', 'crates/hertz-studio/src/window/placement.rs',
    'crates/hertz-studio/src/window_lifecycle.rs', 'crates/hertz-studio/src/routes.rs', 'plugin/ui/app.js', 'plugin/ui/host.js',
    'plugin/ui/index.html', 'plugin/ui/overlay.html', 'crates/hertz-desktop/src/app.rs', 'crates/hertz-desktop/src/wallpaper/decode_probe.rs',
    'scripts/main-window-geometry-fixture.ps1', 'scripts/native-main-window-pointer-fixture.ps1', 'scripts/check-native-obs-preview-native.js'];
  sourceHashes = Object.fromEntries(files.map(file => [file, hash(path.join(root, file))])); snapshot('candidate', { binary, binarySha256: candidateHash, sourceSha256: sourceHashes, diagnosisOnly, qualificationScope });
  const log = fs.openSync(path.join(output, 'host.log'), 'a');
  child = spawn(binary, ['--window', '--bind', '127.0.0.1', '--port', '0', '--data-dir', data], { cwd: root, windowsHide: true, stdio: ['ignore', log, log], env: {
    ...process.env, VMUSIC_BACKEND: 'null', VMUSIC_SECRETS: 'memory', HERTZ_DESKTOP_CONFIG_DIR: path.join(output, 'desktop'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=0',
  } }); fs.closeSync(log); launches.push({ pid: child.pid, profile: data });
  let spawnError; child.on('error', error => { spawnError = error; });
  discovery = await until(() => {
    if (spawnError) throw spawnError; if (child.exitCode !== null) throw new Error('Owned main exited during startup: ' + child.exitCode);
    try { const value = JSON.parse(fs.readFileSync(path.join(data, 'vmusicd.json'))); return value.pid === child.pid && value; } catch { return null; }
  }, 'owned service startup', 60000);
  const connected = await connect(path.join(data, 'webview/main'), url => url.startsWith('http://127.0.0.1:' + discovery.port));
  mainBrowser = connected.browser; mainPage = connected.page; launches[0].mainCdpPort = connected.port;
  await mainPage.waitForFunction(() => window.__hertzWindowHost?.obsPreviewVersion === 1 && typeof window.__hertzWindowHost.openObsPreview === 'function'
    && document.getElementById('conn').textContent === '服务已连接', null, { timeout: 45000 });
  launches[0].mainHandle = mainGeometry().handle;
  readKey = (await api('/v1/auth/overlay-key')).key; assert.ok(readKey && readKey !== discovery.token);
  foreignServer = http.createServer((request, response) => { foreignRequests.push(request.url); response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><script>window.__foreignObsExecuted=true</script>'); });
  await new Promise(resolve => foreignServer.listen(0, '127.0.0.1', resolve)); foreignOrigin = 'http://127.0.0.1:' + foreignServer.address().port;
  await instrument(); await settings();
  const origin = 'http://127.0.0.1:' + discovery.port, validUrl = origin + '/overlay?key=' + encodeURIComponent(readKey);
  const invalid = [
    ['wrong-key', origin + '/overlay?key=wrong-read-only-key'], ['token-query', origin + '/overlay?token=' + discovery.token],
    ['ticket-query', origin + '/overlay?ticket=unrelated-ticket'], ['foreign-origin', foreignOrigin + '/overlay?key=' + readKey],
    ['wrong-path', origin + '/?key=' + readKey], ['nested-path', origin + '/overlay/extra?key=' + readKey],
    ['duplicate-key', validUrl + '&key=' + readKey], ['duplicate-style', validUrl + '&style=line&style=full'],
    ['unknown-query', validUrl + '&extra=1'], ['invalid-style', validUrl + '&style=other'], ['fragment', validUrl + '#fragment'],
    ['authority-credentials', origin.replace('://', '://user:pass@') + '/overlay?key=' + readKey],
    ['about-blank', 'about:blank'], ['oversized', validUrl + '&extra=' + 'x'.repeat(400)],
  ];
  for (const [id, url] of invalid) { await request('invalid-' + id, url); await settled('invalid-' + id, 'failed'); assert.equal(previews().length, 0); }
  assert.equal(fs.existsSync(path.join(data, 'webview/obs-preview')), false, 'Admission failures never create the preview profile');
  mark('invalid key, token/ticket, foreign origin, path, query, authority and malformed preview URLs reject before any native preview is created');

  await mainPage.evaluate(() => { overlayKey = 'wrong-read-only-key'; });
  await clickPreview('ui-invalid-key'); await settled('ui-invalid-key', 'failed');
  await mainPage.waitForFunction(() => document.getElementById('toast').classList.contains('error') && document.getElementById('toast').textContent.includes('打不开浮层预览'));
  assert.equal(previews().length, 0); snapshot('actual-preview-button-failure', { toast: await mainPage.locator('#toast').innerText() });
  let keyHitStatus;
  const keyGate = new Promise(resolve => { heldKeyRelease = resolve; });
  await mainPage.route('**/v1/auth/overlay-key', async route => { const response = await route.fetch(); keyHitStatus = response.status(); await keyGate; await route.fulfill({ response }); });
  await mainPage.evaluate(() => { overlayKey = ''; }); await clickPreview('ui-delayed-key');
  assert.equal(await until(() => keyHitStatus, 'real intercepted read-only key response'), 200);
  await delay(5500); assert.equal(previews().length, 0, 'Delayed key response creates no placeholder native window');
  assert.deepEqual(await mainPage.evaluate(() => __obsNativeChecks.windowOpenCalls), [], 'Native settings action never reserves about:blank through window.open');
  heldKeyRelease(); heldKeyRelease = null; await settled('ui-delayed-key', 'opened'); await mainPage.unroute('**/v1/auth/overlay-key');
  let previewWindow = await attachPreview(); assert.equal(previews().length, 1); launches[0].previewHandle = previewWindow.handle;
  assert.ok(fs.existsSync(path.join(data, 'webview/main')) && fs.existsSync(path.join(data, 'webview/obs-preview')));
  assert.notEqual(launches[0].mainCdpPort, previewHistory[0].cdpPort, 'Separate WebContexts use separate browser endpoints');
  mark('the real settings preview button waits for a delayed real read-only key, reports native failure and opens one independent preview without about:blank reservation');

  const music = path.join(output, 'music'); fs.mkdirSync(music);
  const wav = Buffer.alloc(44 + 8000 * 600 * 2); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  fs.writeFileSync(path.join(music, 'native-obs.wav'), wav); fs.writeFileSync(path.join(music, 'native-obs.lrc'), '[00:00.00]原生预览第一行\n[01:00.00]原生预览第二行\n[09:59.00]结束\n');
  await api('/v1/library/scan', 'POST', { root: music }); const track = await until(async () => (await api('/v1/tracks?limit=20')).tracks[0], 'owned WAV scan');
  launches[0].trackId = track.id;
  const cover = fs.readFileSync(path.join(root, 'plugin/ui/icons/hertz-studio.png'));
  await api('/v1/tracks/' + track.id + '/cover', 'POST', cover, 200, 'image/png');
  await api('/v1/player/load', 'POST', { track_id: track.id }); await until(async () => (await api('/v1/state')).playing, 'real null WAV playback');
  const marker = crypto.randomUUID(); await mainPage.evaluate(marker => localStorage.setItem('native.obs-main-isolation', marker), marker);
  const isolated = await previewPage.evaluate(async ({ key, token, trackId }) => {
    const fetchStatus = async (path, method = 'GET', body) => { const response = await fetch(path + '?key=' + encodeURIComponent(key), { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: response.status, text: await response.text() }; };
    const lyric = await fetchStatus('/v1/overlay/lyric'); const image = await fetch('/v1/tracks/' + trackId + '/cover?key=' + encodeURIComponent(key));
    const bytes = Array.from(new Uint8Array(await image.arrayBuffer()));
    const forbidden = [];
    for (const [path, method, body] of [['/v1/state','GET'],['/v1/settings','GET'],['/v1/settings','PUT',{native_obs_unauthorized:true}],['/v1/player/play','POST',{}]]) forbidden.push({ path, method, status: (await fetchStatus(path,method,body)).status });
    const home = await fetch('/'); const html = await home.text();
    return { host: typeof window.__hertzWindowHost, ipc: typeof window.ipc, hertzHost: typeof window.hertzHost, openerNull: window.opener === null,
      documentCookieEmpty: document.cookie === '', mainMarker: localStorage.getItem('native.obs-main-isolation'), localStorageContainsMainToken: Object.values(localStorage).some(value => value.includes(token)),
      lyric: { status: lyric.status, data: JSON.parse(lyric.text) }, cover: { status: image.status, bytes }, forbidden,
      homepage: { status: home.status, containsMainToken: html.includes(token) } };
  }, { key: readKey, token: discovery.token, trackId: track.id });
  assert.equal(isolated.host, 'undefined'); assert.equal(isolated.ipc, 'undefined'); assert.equal(isolated.hertzHost, 'undefined'); assert.equal(isolated.openerNull, true);
  assert.equal(isolated.documentCookieEmpty, true); assert.equal(isolated.mainMarker, null); assert.equal(isolated.localStorageContainsMainToken, false);
  assert.equal(isolated.lyric.status, 200); assert.equal(isolated.lyric.data.track_id, track.id); assert.ok(isolated.lyric.data.lines.length > 0);
  assert.equal(isolated.cover.status, 200); assert.deepEqual(Buffer.from(isolated.cover.bytes), cover); delete isolated.cover.bytes;
  assert.ok(isolated.forbidden.every(result => result.status === 401)); assert.equal(isolated.homepage.containsMainToken, false);
  const mainCookies = await mainPage.context().cookies(origin), previewCookies = await previewPage.context().cookies(origin);
  assert.deepEqual(previewCookies, [], 'Independent preview profile contains no service session cookies');
  snapshot('preview-authority-isolation', { ...isolated, cookies: { mainCount: mainCookies.length, previewCount: previewCookies.length }, coverSha256: crypto.createHash('sha256').update(cover).digest('hex') });
  await previewPage.waitForFunction(() => document.getElementById('karaoke-title').textContent.includes('native-obs') && document.getElementById('karaoke-cover').complete && document.getElementById('karaoke-cover').naturalWidth > 0);
  await previewPage.screenshot({ path: path.join(output, 'actual-read-only-preview.png') });
  await mainPage.screenshot({ path: path.join(output, 'actual-settings-preview-action.png') });
  mark('the independent preview has no opener, host, IPC, main token or cookies; real lyric/cover reads succeed while state/settings/playback requests reject with401');

  if (diagnosisOnly) {
    assert.equal(checks.length, 3, 'Diagnostic scope is limited to the first three existing OBS groups');
    await stopCurrent();
    assert.equal(launches[0].graceful, true, 'Diagnostic main closes normally with its managed preview');
    assert.equal(launches[0].discoveryRemoved, true, 'Diagnostic main removes its owned discovery');
    verifyEvidence();
    return;
  }

  const mainBounds = mainGeometry().outerBounds; await delay(1000); const placement = (await api('/v1/settings')).native_window_placement;
  assert.equal(placement?.schemaVersion, 1, 'Integrated native placement store is present for auxiliary isolation checks');
  for (const style of ['full', 'line', 'minimal', 'karaoke']) {
    await clickPreview('ui-reuse-' + style, style); await settled('ui-reuse-' + style, 'opened');
    previewWindow = await attachPreview(); assert.equal(previewWindow.handle, launches[0].previewHandle); assert.equal(previews().length, 1);
    await until(() => new URL(previewPage.url()).searchParams.get('style') === style, 'reused preview style');
    await until(() => native().foreground === previewWindow.handle, 'reused preview receives native focus');
  }
  native('bounds', previewWindow, { x: previewWindow.x + 20, y: previewWindow.y + 20, width: Math.max(500, previewWindow.width - 100), height: Math.max(350, previewWindow.height - 80) });
  await live('preview-reuse-and-move', mainBounds, placement);
  mark('repeated actual settings requests reuse and focus one preview for all four styles; auxiliary move/resize preserves main geometry and null playback');

  for (const [name, url] of invalid.filter(([name]) => ['wrong-key','token-query','foreign-origin','wrong-path','duplicate-key','fragment'].includes(name))) await rejectedNavigation(previewPage, url, 'preview-top-navigation-' + name);
  await live('after-preview-navigation-denials', mainBounds, placement);
  mark('later preview top-level navigation repeats the read-only admission policy and cannot commit foreign or unauthorized documents');

  const previewPagesBefore = previewBrowser.contexts().flatMap(context => context.pages()).length;
  for (const url of ['about:blank', validUrl, foreignOrigin + '/nested-popup']) {
    const result = await pointerProbe(previewPage, 'Owned preview popup probe', 'popup', url); assert.equal(result.returnedNull, true);
    await delay(500); assert.equal(previewBrowser.contexts().flatMap(context => context.pages()).length, previewPagesBefore); assert.equal(previews().length, 1);
  }
  const mainPopup = await pointerProbe(mainPage, 'Owned main popup probe', 'popup', 'about:blank'); assert.equal(mainPopup.returnedNull, true);
  const permission = await previewPage.evaluate(() => new Promise(resolve => { const timer = setTimeout(() => resolve({ timeout: true }), 8000); navigator.geolocation.getCurrentPosition(() => { clearTimeout(timer); resolve({ granted: true }); }, error => { clearTimeout(timer); resolve({ code: error.code }); }); }));
  assert.equal(permission.code, 1, 'Preview native permission request is denied'); snapshot('preview-popup-permission-denials', { mainPopup, permission });
  const download = await pointerProbe(previewPage, 'Owned preview download probe', 'download', 'native-obs-denied-' + Date.now() + '.txt');
  await delay(1800);
  assert.equal(native().windows.some(window => window.visible && window.kind === '#32770'), false, 'Preview download never opens a native save dialog');
  await live('after-preview-popup-download-permission', mainBounds, placement);
  // WebView2 can hold History exclusively while the browser is alive. Read the
  // fresh owned profile only after closing its preview/context/CDP connection.
  await closePreview('preview-closed-before-document-isolation');
  const afterHistory = await until(() => { try { return downloadHistory(); } catch (error) { if (!String(error).includes('database is locked')) throw error; return null; } }, 'closed preview History unlocks', 15000);
  const added = afterHistory.rows; // This fresh profile has exactly one attempted download.
  assert.ok(added.every(row => row.state !== 1 && (!row.target_path || !fs.existsSync(row.target_path))), 'Preview download cannot complete or write its selected target');
  snapshot('preview-download-denial', { trustedAttempt: download, historyAvailable: afterHistory.available, recordedDownloads: added,
    cancelledHistoryObserved: added.some(row => row.state === 2 || row.interrupt_reason === 40), nativeSaveDialogOpened: false });
  mark('trusted nested/main popups and preview permission requests are denied; a trusted blob download creates no picker or completed download');

  await mainPage.evaluate(() => { __obsNativeChecks.hold = true; }); await request('old-document-held', validUrl + '&style=line');
  const oldMessage = await mainPage.evaluate(() => __obsNativeChecks.held.at(-1)); assert.ok(oldMessage?.documentId && oldMessage?.requestId);
  await mainPage.reload();
  await mainPage.waitForFunction(() => __hertzWindowHost?.obsPreviewVersion === 1 && document.getElementById('conn').textContent === '服务已连接'); await instrument();
  assert.notEqual(await mainPage.evaluate(() => __hertzWindowHost.documentId), oldMessage.documentId, 'Reload creates a new read-only native document identity');
  await mainPage.evaluate(message => {
    window.ipc.postMessage(JSON.stringify({ kind: 'host-ready', documentId: message.documentId }));
    window.ipc.postMessage(JSON.stringify(message));
  }, oldMessage);
  await delay(700); assert.equal(previews().length, 0, 'Old host-ready and preview request cannot bind the new document or create a child');
  await mainPage.evaluate(() => { __obsNativeChecks.hold = true; }); await request('new-document-held', validUrl + '&style=minimal');
  await request('duplicate-pending', validUrl + '&style=full'); await settled('duplicate-pending', 'failed');
  await mainPage.evaluate(message => window.dispatchEvent(new CustomEvent('hertz-native-obs-preview-result', { detail: { documentId: message.documentId, requestId: message.requestId, status: 'opened' } })), oldMessage);
  assert.equal(await mainPage.evaluate(() => __obsNativeChecks.requests['new-document-held'].status), 'pending');
  await mainPage.evaluate(() => { const message = __obsNativeChecks.held.at(-1); __obsNativeChecks.hold = false; __obsNativeChecks.release(message); });
  await settled('new-document-held', 'opened'); await attachPreview(); assert.equal(previews().length, 1);
  mark('main reload rejects old host-ready, document requests and receipts; the new document opens normally and one pending request blocks duplicate creation');

  await closePreview('preview-native-close'); await live('after-preview-native-close', mainBounds, placement);
  await request('reopen-after-close', validUrl + '&style=karaoke'); await settled('reopen-after-close', 'opened'); await attachPreview();
  await live('reopened-preview-main-alive', mainBounds, placement);
  mark('child WM_CLOSE removes only the preview; main playback and placement survive, and a later valid request opens a managed preview again');
  await stopCurrent(); verifyEvidence();
  mark('main graceful quit closes its managed preview, releases the owned PID and removes discovery');
  assert.equal(checks.length, 9, 'Formal native OBS qualification runs all nine existing groups');
}
if (process.argv.includes('--check-fixture')) {
  fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(nativeFixture, fixtureSource, 'utf8');
  console.log(execFileSync(powershell, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',nativeFixture,'-OwnerPid','1','-Action','compile-only'], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim());
} else main().then(async () => {
  await cleanup(); snapshot('report', { passed: true, cleanupDone: true, diagnosisOnly, qualificationScope, binary, binarySha256: candidateHash, sourceSha256: sourceHashes,
    launches, previewHistory, checks, errors, foreignRequests, limitations: ['one Windows/WebView2 host with real null-output audio',
      'navigation policy blocks document commits; it is not a network sandbox', 'download cancellation history may be absent when WebView2 denies the start before recording a history row',
      'no physical audio, OBS installation, other OS or multi-monitor qualification'] });
  console.log(JSON.stringify({ output, diagnosisOnly, qualificationScope, checks }, null, 2));
}).catch(async error => {
  fs.mkdirSync(output, { recursive: true });
  if (child) { try { snapshot('failure-native', native()); } catch {} }
  if (mainPage && !mainPage.isClosed()) { try { snapshot('failure-requests', await mainPage.evaluate(() => __obsNativeChecks)); } catch {} await mainPage.screenshot({ path: path.join(output, 'failure-main.png'), timeout: 5000 }).catch(() => {}); }
  if (previewPage && !previewPage.isClosed()) await previewPage.screenshot({ path: path.join(output, 'failure-preview.png'), timeout: 5000 }).catch(() => {});
  await cleanup().catch(cleanupError => errors.push('cleanup: ' + cleanupError.message));
  snapshot('report', { passed: false, diagnosisOnly, qualificationScope, error: error.stack, binary, binarySha256: candidateHash, sourceSha256: sourceHashes, launches, previewHistory, checks, errors });
  console.error(error); console.error(output); process.exitCode = 1;
});
