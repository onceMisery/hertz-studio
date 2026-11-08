'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/main-window-lifecycle-native-' + Date.now());
const data = path.join(output, 'data');
const binary = process.env.HERTZ_BIN || path.join(root, 'target/debug/hertz-studio.exe');
const checks = [], errors = [];
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let child, browser, page, discovery, launches = 0, spawnError;
async function until(read, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    const value = await read(); if (value) return value;
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
}
const mark = text => { checks.push(text); console.log('PASS ' + text); };
function snapshot(name, value) { fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(value, null, 2)); }
async function api(endpoint, method = 'GET', body, expected = 200) {
  const response = await fetch('http://127.0.0.1:' + discovery.port + endpoint, { method,
    headers: { Authorization: 'Bearer ' + discovery.token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const value = await response.json(); assert.equal(response.status, expected, endpoint + ': ' + JSON.stringify(value)); return value;
}
const lifecycle = () => api('/v1/window/state');
const native = action => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(output, 'window.ps1'),
  '-OwnerPid', String(child.pid), '-Action', action], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim());
async function focus() {
  await api('/v1/window/focus', 'POST', { serverInstanceId: discovery.server_instance_id });
  await until(() => native('read').visible, 'main window restored');
}
async function start() {
  const cdp = 19748 + launches++;
  const log = fs.openSync(path.join(output, 'host-' + launches + '.log'), 'a');
  child = spawn(binary, ['--window', '--bind', '127.0.0.1', '--port', '0', '--data-dir', data], {
    cwd: root, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env,
      VMUSIC_BACKEND: 'null', VMUSIC_SECRETS: 'memory', HERTZ_DESKTOP_CONFIG_DIR: path.join(output, 'desktop'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + cdp,
    },
  });
  fs.closeSync(log); child.on('error', error => { spawnError = error; });
  discovery = await until(() => {
    if (child.exitCode !== null) throw new Error('owned main window exited ' + child.exitCode);
    try { const value = JSON.parse(fs.readFileSync(path.join(data, 'vmusicd.json'), 'utf8')); return value.pid === child.pid && value; } catch { return null; }
  }, 'owned service startup', 60000);
  await until(async () => { try { return (await fetch('http://127.0.0.1:' + cdp + '/json/version')).ok; } catch { return false; } }, 'native CDP');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + cdp);
  page = await until(() => browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('http://127.0.0.1:' + discovery.port)), 'native main page');
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.WindowLifecycle?.isNative() && window.__hertzWindowHost?.lifecycleVersion === 1);
  await page.waitForFunction(() => !document.querySelector('#window-lifecycle-behavior').disabled, null, { timeout: 45000 });
  await page.evaluate(() => { window.__exitRequests = []; window.addEventListener('hertz-native-exit-request', event => __exitRequests.push(event.detail)); });
}
async function cancel() {
  await page.locator('#window-lifecycle-dialog').waitFor({ state: 'visible' });
  await page.locator('#window-lifecycle-cancel').click();
  await until(async () => (await lifecycle()).phase === 'cancelled', 'native cancellation');
}
async function stopOwned() {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await until(() => child.exitCode !== null || child.signalCode !== null, 'owned process cleanup', 5000); }
  if (browser) await browser.close().catch(() => {});
  browser = page = child = null;
}
async function main() {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'window.ps1'), `param([int]$OwnerPid,[string]$Action)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class LifecycleWindows {
 public delegate bool Callback(IntPtr hwnd,IntPtr parameter);
 [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback,IntPtr parameter);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int size);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd,uint msg,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hwnd,int id);
 public static IntPtr Find(uint owner,string title) { IntPtr found=IntPtr.Zero; EnumWindows((h,p)=> {uint pid; GetWindowThreadProcessId(h,out pid); var text=new StringBuilder(256);GetWindowText(h,text,text.Capacity);if(pid==owner&&text.ToString()==title){found=h;return false;}return true;},IntPtr.Zero);return found; }
}
'@
$main=[LifecycleWindows]::Find([uint32]$OwnerPid,'HertzStudio Music Player')
$dialog=[LifecycleWindows]::Find([uint32]$OwnerPid,[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from('退出 Hertz Studio', 'utf16le').toString('base64')}')))
if($Action -eq 'close'){if($main -eq [IntPtr]::Zero){throw 'Owned main missing'};[void][LifecycleWindows]::PostMessage($main,16,[IntPtr]::Zero,[IntPtr]::Zero)}
if($Action -eq 'cancel-fallback'){if($dialog -eq [IntPtr]::Zero){throw 'Owned fallback missing'};$button=[LifecycleWindows]::GetDlgItem($dialog,7);if($button -eq [IntPtr]::Zero){throw 'Cancel button missing'};[void][LifecycleWindows]::PostMessage($button,245,[IntPtr]::Zero,[IntPtr]::Zero)}
@{visible=($main -ne [IntPtr]::Zero -and [LifecycleWindows]::IsWindowVisible($main));fallback=($dialog -ne [IntPtr]::Zero);main=$main.ToInt64()}|ConvertTo-Json -Compress
`, 'utf8');
  await start(); assert.equal((await lifecycle()).closeBehavior, 'hide');
  const music = path.join(output, 'music'); fs.mkdirSync(music);
  const wav = Buffer.alloc(44 + 8000 * 600 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  fs.writeFileSync(path.join(music, 'lifecycle.wav'), wav);
  await api('/v1/library/scan', 'POST', { root: music });
  const track = await until(async () => (await api('/v1/tracks?limit=20')).tracks[0], 'real local WAV scan');
  await api('/v1/player/load', 'POST', { track_id: track.id });
  await until(async () => (await api('/v1/state')).playing, 'null output real audio actor playing');
  native('close'); await until(() => !native('read').visible, 'native CloseRequested hides');
  const hidden = await api('/v1/state'); assert.equal(hidden.playing, true); assert.equal(hidden.track_id, track.id);
  assert.equal((await lifecycle()).phase, 'idle'); await focus();
  mark('actual WM_CLOSE hides by default and preserves the active audio actor; authenticated focus restores the same native window');
  await require('./native-sleep-checks')({ api, page, base: 'http://127.0.0.1:' + discovery.port, until, mark, snapshot });
  await page.evaluate(() => { window.__exitRequests = []; window.addEventListener('hertz-native-exit-request', event => __exitRequests.push(event.detail)); });
  await api('/v1/player/load', 'POST', { track_id: track.id });
  const pending = await api('/v1/system/shutdown', 'POST', {}, 202);
  await page.locator('#window-lifecycle-dialog').waitFor({ state: 'visible' });
  assert.equal((await lifecycle()).phase, 'pending');
  const duplicate = await api('/v1/system/shutdown', 'POST', {}, 202); assert.equal(duplicate.requestId, pending.requestId);
  await page.evaluate(() => __hertzWindowHost.requestQuit());
  assert.equal((await lifecycle()).requestId, pending.requestId);
  assert.equal(await page.locator('#window-lifecycle-dialog[open]').count(), 1);
  await cancel(); assert.equal((await api('/v1/state')).playing, true);
  const stale = await page.evaluate(() => __exitRequests.at(-1));
  await page.evaluate(detail => __hertzWindowHost.confirmQuit(detail.snapshot.requestId, detail.presentation, true, true), stale);
  assert.equal((await lifecycle()).phase, 'cancelled');
  mark('HTTP and host quit share one actual confirmation; Cancel retains playback and stale approval cannot exit');
  await api('/v1/window/settings', 'PUT', { closeBehavior: 'quit' });
  native('close'); await cancel(); assert.equal((await api('/v1/state')).playing, true);
  await api('/v1/player/pause', 'POST', {});
  await api('/v1/room', 'POST', { action: 'create', name: '退出守卫验证', address: '127.0.0.1:0', sample_rate: 48000, local_output: false, discoverable: false });
  await api('/v1/system/shutdown', 'POST', {}, 202); await page.locator('#window-lifecycle-dialog').waitFor({ state: 'visible' });
  assert.equal((await lifecycle()).activity.roomActive, true); await cancel();
  assert.notEqual((await api('/v1/room')).mode, 'idle'); await api('/v1/room', 'POST', { action: 'leave' });
  mark('saved close-to-quit uses the same cancellable guard; a real LAN host requests confirmation even without local playback');
  await api('/v1/player/play', 'POST', {});
  await api('/v1/system/shutdown', 'POST', {}, 202); await page.locator('#window-lifecycle-dialog').waitFor({ state: 'visible' });
  const oldPresentation = await page.evaluate(() => __exitRequests.at(-1));
  await page.reload(); await page.locator('#window-lifecycle-dialog').waitFor({ state: 'visible' });
  await page.evaluate(detail => __hertzWindowHost.confirmQuit(detail.snapshot.requestId, detail.presentation, true, true), oldPresentation);
  assert.equal((await lifecycle()).phase, 'pending'); await cancel();
  mark('renderer reload re-presents pending exit and rejects the previous document presentation token');
  await page.route('**/window-lifecycle.js*', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.reload(); await page.waitForFunction(() => !!window.__hertzWindowHost && document.readyState === 'complete');
  assert.equal(await page.evaluate(() => typeof window.WindowLifecycle), 'undefined', 'fixture removes the renderer lifecycle handler');
  await api('/v1/player/play', 'POST', {});
  await until(async () => (await api('/v1/state')).playing, 'playback before missing-handler exit');
  await api('/v1/system/shutdown', 'POST', {}, 202);
  await until(() => native('read').fallback, 'actual owner-bound native fallback', 16000);
  native('cancel-fallback'); await until(async () => (await lifecycle()).phase === 'cancelled', 'native fallback cancels');
  assert.equal((await api('/v1/state')).playing, true);
  await page.unroute('**/window-lifecycle.js*'); await page.reload(); await page.waitForFunction(() => window.WindowLifecycle?.isNative());
  mark('missing renderer lifecycle handler falls back to a real native confirmation; cancellation keeps service and music alive');
  await api('/v1/player/pause', 'POST', {});
  const retiringTimer = await api('/v1/window/sleep-timer');
  await api('/v1/window/sleep-timer', 'PUT', { seconds: 120, expectedRevision: retiringTimer.revision });
  await api('/v1/system/shutdown', 'POST', {}, 202);
  await until(() => child.exitCode !== null || child.signalCode !== null, 'idle graceful exit', 20000);
  await browser.close().catch(() => {}); browser = null; child = null;
  await start(); assert.equal((await lifecycle()).closeBehavior, 'quit');
  assert.equal((await api('/v1/window/sleep-timer')).phase, 'idle', 'process restart never rearms runtime deadline');
  native('close'); await until(() => child.exitCode !== null || child.signalCode !== null, 'persisted close-to-quit graceful exit', 20000);
  assert.equal(fs.existsSync(path.join(data, 'vmusicd.json')), false);
  assert.deepEqual(errors, []);
  mark('idle exit waits for native preparation, removes discovery and releases process; close preference survives restart');
}
main().then(async () => {
  await stopOwned(); snapshot('report', { passed: true, cleanupDone: true, binarySha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), checks, errors,
    scope: 'Real Wry/WebView2 and Win32 close/fallback, real service/null audio actor/local WAV and LAN host; no physical audio or mixed-DPI qualification.' });
  console.log(JSON.stringify({ output, checks }, null, 2));
}).catch(async error => {
  fs.mkdirSync(output, { recursive: true });
  try { snapshot('failure-lifecycle', await lifecycle()); } catch {}
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 5000 }).catch(() => {});
  await stopOwned().catch(() => {}); snapshot('report', { passed: false, error: error.stack, checks, errors });
  console.error(error); console.error(output); process.exitCode = 1;
});
