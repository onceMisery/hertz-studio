// SPDX-License-Identifier: MIT
// Real Windows/WebView2 source, native desktop button and original offset owner.
// A debug candidate proves development behavior; DBX/other editions/devices remain separate.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const binary = path.resolve(process.env.HERTZ_BIN || '');
const output = path.join(root, 'output/playwright/calibration-native-' + Date.now());
const data = path.join(output, 'data'), desktop = path.join(output, 'desktop');
const checks = [], errors = [], evidence = {};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, browser, mainPage, discovery, spawnError;
const mark = name => { checks.push(name); console.log('PASS ' + name); };
async function until(read, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (spawnError) throw spawnError;
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw Error('Owned candidate exited');
    const value = await read(); if (value) return value;
    await pause(100);
  }
  throw Error('Timed out: ' + label);
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
async function api(route, method = 'GET', body, expected = 200, key) {
  const response = await fetch('http://127.0.0.1:' + discovery.port + route, {
    method, headers: { Authorization: 'Bearer ' + (key || discovery.token), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000)
  });
  const value = await response.json();
  assert.equal(response.status, expected, route + ': ' + JSON.stringify(value)); return value;
}
function windows(action = 'read') {
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
    path.join(output, 'windows.ps1'), '-TaskPid', String(child.pid), '-Action', action],
  { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim());
}
function lyricsInput(action = 'inspect') {
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
    path.join(root, 'scripts/native-lyrics-calibration-pointer.ps1'), '-OwnerPid', String(child.pid), '-Action', action],
  { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim());
}
function wav() {
  const bytes = Buffer.alloc(44 + 8000 * 30 * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40); return bytes;
}
async function inlineSettings() {
  await mainPage.evaluate(() => window.dispatchEvent(new Event('hertz-open-desktop-lyrics-settings')));
  await mainPage.locator('#desktop-lyrics-settings').waitFor({ state: 'visible' });
  await mainPage.waitForFunction(() => !document.getElementById('dls-controls').disabled && !document.getElementById('dls-refresh').disabled);
}
async function closePlayerViaKeyboard() {
  // The calibration control is in the original tools drawer. Escape first
  // dismisses that drawer, then the player, through its normal back handler.
  for (let attempt = 0; attempt < 3 && await mainPage.locator('#np-modal').isVisible(); attempt++) {
    await mainPage.keyboard.press('Escape');
    await pause(100);
  }
  await mainPage.locator('#np-modal').waitFor({ state: 'hidden' });
}
async function calibrate(label) {
  const before = await api('/v1/state');
  const lyricBefore = await api('/v1/tracks/' + before.track_id + '/lyrics');
  const input = lyricsInput('calibrate');
  await mainPage.waitForFunction(() => document.hasFocus() && document.activeElement?.id === 'np-lyric-offset-down');
  const buttons = await until(() => {
    const state = lyricsInput();
    return state.calibration.some(button => button.enabled && button.name === '在播放器校准') && state;
  }, 'native calibration action completed');
  const detail = await mainPage.evaluate(() => ({
    visible: document.visibilityState, focused: document.hasFocus(),
    active: document.activeElement?.id, title: document.title,
    offset: document.getElementById('np-lyric-offset-value').textContent
  }));
  const native = windows();
  evidence[label] = { input, buttons, detail, native };
  assert.equal(detail.visible, 'visible'); assert.equal(detail.focused, true);
  assert.equal(detail.active, 'np-lyric-offset-down');
  assert.equal(native.ForegroundPid, child.pid);
  assert.equal(native.ForegroundHwnd, native.MainHwnd);
  const after = await api('/v1/state');
  assert.equal(after.track_id, before.track_id); assert.equal(after.generation, before.generation);
  assert.equal(after.playing, before.playing); assert.equal(after.position_ms, before.position_ms);
  assert.equal((await api('/v1/tracks/' + before.track_id + '/lyrics')).user_offset_ms, lyricBefore.user_offset_ms);
  mark(label + ': owned OS main window foreground and original offset control focused, no playback/offset mutation');
}
async function main() {
  assert.equal(process.platform, 'win32'); assert.ok(process.env.HERTZ_BIN, 'Set a fresh full/native-window HERTZ_BIN');
  assert.ok(fs.existsSync(binary)); fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(desktop);
  evidence.description = JSON.parse(execFileSync(binary, ['--describe'], { encoding: 'utf8', windowsHide: true }));
  assert.equal(evidence.description.edition, 'full'); assert.equal(evidence.description.capabilities.nativeWindow, true);
  evidence.binarySha256 = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  fs.writeFileSync(path.join(output, 'windows.ps1'), `param([uint32]$TaskPid,[string]$Action)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class CalibrationWindows {
 public delegate bool Callback(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumWindows(Callback c,IntPtr p);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h,uint message,IntPtr w,IntPtr l);
 public class State {public uint ForegroundPid;public long ForegroundHwnd;public long MainHwnd;public bool MainVisible;}
 public static State Read(uint target,bool hide) {
  IntPtr main=IntPtr.Zero; EnumWindows((h,p)=>{uint pid;GetWindowThreadProcessId(h,out pid);
   if(pid==target){var title=new StringBuilder(256);GetWindowText(h,title,title.Capacity);
    if(title.ToString()=="HertzStudio Music Player")main=h;}return true;},IntPtr.Zero);
  if(main==IntPtr.Zero)throw new Exception("Owned main window missing");
  uint owner;GetWindowThreadProcessId(main,out owner);if(owner!=target)throw new Exception("Owner changed");
  if(hide&&!PostMessage(main,0x0010,IntPtr.Zero,IntPtr.Zero))throw new Exception("Owned close message failed");
  var front=GetForegroundWindow();uint foreground;GetWindowThreadProcessId(front,out foreground);
  return new State{ForegroundPid=foreground,ForegroundHwnd=front.ToInt64(),MainHwnd=main.ToInt64(),MainVisible=IsWindowVisible(main)};
 }
}
'@
ConvertTo-Json -Compress -InputObject ([CalibrationWindows]::Read($TaskPid,$Action -eq 'hide'))
`, 'utf8');
  const port = await freePort(), log = fs.openSync(path.join(output, 'host.log'), 'a');
  child = spawn(binary, ['--window', '--bind', '127.0.0.1', '--port', '0', '--data-dir', data], {
    cwd: root, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env,
      VMUSIC_BACKEND: 'null', VMUSIC_SECRETS: 'memory', HERTZ_DESKTOP_CONFIG_DIR: desktop,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port + ' --force-renderer-accessibility'
    }
  }); fs.closeSync(log); child.on('error', error => { spawnError = error; }); evidence.pid = child.pid;
  discovery = await until(() => {try { const d = JSON.parse(fs.readFileSync(path.join(data, 'vmusicd.json'))); return d.pid === child.pid && d; } catch {return null;}}, 'native startup', 60000);
  await until(async () => {try {return (await fetch('http://127.0.0.1:' + port + '/json/version')).ok;} catch {return false;}}, 'owned CDP');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  mainPage = await until(() => browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('http://127.0.0.1:' + discovery.port)), 'main WebView');
  mainPage.on('pageerror', e => errors.push(e.message));
  await mainPage.waitForFunction(() => window.HertzDesktopLyricsSettings && document.getElementById('conn').textContent === '服务已连接');
  assert.equal((await api('/v1/health')).backend, 'null');
  assert.equal((await api('/v1/desktop/calibration-authorization')).authorized, false);
  const music = path.join(output, 'music'); fs.mkdirSync(music);
  fs.writeFileSync(path.join(music, '校准验收.wav'), wav());
  await api('/v1/library/scan', 'POST', { root: music });
  const track = await until(async () => (await api('/v1/tracks?limit=5')).tracks[0], 'owned WAV imported');
  await api('/v1/tracks/' + track.id + '/lyrics', 'PUT', { content: '[00:00.00]校准验收\n[00:15.00]保留原每曲偏移' });
  await api('/v1/player/load', 'POST', { track_id: track.id, queue: [track.id] });
  // Loading starts playback. Freeze the fixture's clock before asserting that
  // the UI handoff cannot seek, play or write the per-track offset.
  await api('/v1/player/pause', 'POST', {});
  await until(async () => !(await api('/v1/state')).playing, 'owned fixture paused');
  await inlineSettings();
  await mainPage.locator('#dls-enabled').check(); await mainPage.locator('#dls-locked').uncheck();
  await mainPage.locator('#dls-apply').click();
  await mainPage.waitForFunction(() => !document.getElementById('dls-refresh').disabled);
  evidence.optionsInput = lyricsInput('options');
  await until(() => lyricsInput().calibration.some(button => button.name === '在播放器校准' && !button.enabled), 'actual disabled native button');
  mark('Default consent closed; real native desktop button disabled');
  // Consent remains a real explicit action in the original full-player UI.
  await mainPage.locator('#desktop-calibration-consent').check();
  await until(async () => (await api('/v1/desktop/calibration-authorization')).authorized, 'consent persisted');
  await until(() => lyricsInput().calibration.some(button => button.name === '在播放器校准' && button.enabled), 'actual native capability enabled');
  const key = fs.readFileSync(path.join(data, 'desktop-lyrics-calibration-key'), 'utf8').trim();
  await api('/v1/tracks?limit=5', 'GET', undefined, 401, key);
  await api('/v1/desktop/calibration-ui', 'POST', { op: 'register', host: 'native', visible: true }, 401, key);
  mark('Real narrow calibration credential cannot read library or register/confirm a full-player receiver');
  await calibrate('visible main');
  await closePlayerViaKeyboard();
  await api('/v1/window/settings', 'PUT', { closeBehavior: 'hide' });
  windows('hide');
  await until(() => !windows().MainVisible, 'normal main-window close hides the owned host');
  await calibrate('hidden main recovery');
  // Only this explicit click mutates the original per-track offset.
  const before = await api('/v1/tracks/' + track.id + '/lyrics');
  await mainPage.locator('#np-lyric-offset-down').click();
  await until(async () => (await api('/v1/tracks/' + track.id + '/lyrics')).user_offset_ms === (before.user_offset_ms || 0) - 500, 'original offset saved');
  await mainPage.screenshot({ path: path.join(output, 'same-source-calibration.png') });
  mark('User action on original per-track control saves through existing offset owner');
  await closePlayerViaKeyboard();
  await inlineSettings();
  await mainPage.locator('#desktop-calibration-consent').uncheck();
  await until(async () => !(await api('/v1/desktop/calibration-authorization')).authorized, 'consent revoked');
  await until(() => lyricsInput().calibration.some(button => !button.enabled), 'actual native capability revoked');
  mark('Explicit revocation disables the actual native entry');
}
async function cleanup() {
  if (child && child.exitCode === null && child.signalCode === null) {
    await api('/v1/system/shutdown', 'POST', {}, 202).catch(() => {});
    for (let n = 0; n < 100 && child.exitCode === null && child.signalCode === null; n++) await pause(100);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    for (let n = 0; n < 50 && child.exitCode === null && child.signalCode === null; n++) await pause(100);
    evidence.exit = { code: child.exitCode, signal: child.signalCode };
  }
  await browser?.close().catch(() => {});
}
main().catch(async error => {
    errors.push(error.stack); process.exitCode = 1;
    if (mainPage) {
      await mainPage.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
      evidence.failureUi = await mainPage.evaluate(() => ['np-close', 'np-modal'].map(id => {
        const element = document.getElementById(id), rect = element?.getBoundingClientRect();
        return { id, rect: rect?.toJSON(), hit: rect && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.outerHTML.slice(0, 256) };
      })).catch(() => null);
    }
  })
  .finally(async () => {
    await cleanup(); fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ checks, errors, evidence,
      limits: ['Current Full debug development candidate only', 'DBX and Standard not exercised', 'No external TTML, physical monitor change or long-duration qualification'] }, null, 2));
    console.log(JSON.stringify({ output, checks: checks.length, errors }));
  });
