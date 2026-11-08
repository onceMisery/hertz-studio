// SPDX-License-Identifier: MIT
// Windows main-window lyrics settings, real embedded host and private disk configuration.
// Requires a fresh full,native-window hertz-studio build, Playwright and WebView2.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/desktop-lyrics-settings-native-' + Date.now());
const data = path.join(output, 'data'), desktop = path.join(output, 'desktop');
const binary = path.resolve(process.env.HERTZ_BIN || path.join(root, 'target/debug/hertz-studio.exe'));
const configPath = path.join(desktop, 'config.json'), failedWritePath = path.join(desktop, 'config.json.tmp');
const checks = [], errors = [], launches = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, browser, page, discovery, spawnError;
const mark = message => { checks.push(message); console.log('PASS ' + message); };
function writeJson(name, value) { fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(value, null, 2)); }
async function until(read, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    const value = await read(); if (value) return value;
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
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(55000) });
  const reply = await response.json();
  assert.equal(response.status, expected, endpoint + ': ' + JSON.stringify(reply));
  return reply;
}
const command = (command, value) => api('/v1/desktop/control', 'POST', { command, ...(value === undefined ? {} : { value }) });
const read = owner => command('lyrics-settings', owner ? { owner } : {});
const windows = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(output, 'windows.ps1'),
  '-TargetPid', String(child.pid)], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim());
function stored() { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
function domain(config) {
  const found = config.profiles.find(item => path.resolve(item.profile.dataDir).toLowerCase() === path.resolve(data).toLowerCase());
  assert.ok(found, 'Owned player profile is stored separately'); return found;
}
function assertNoSettingsWindow() {
  const owned = windows();
  assert.ok(owned.some(window => window.Title === 'HertzStudio Music Player' && window.ProcessId === child.pid));
  assert.ok(!owned.some(window => window.Title === '桌面歌词与壁纸'), 'Inline lyrics settings must not create the separate settings window');
  return owned;
}
async function start() {
  const port = await freePort(); spawnError = null;
  const log = fs.openSync(path.join(output, 'host-' + (launches.length + 1) + '.log'), 'a');
  child = spawn(binary, ['--window', '--bind', '127.0.0.1', '--port', '0', '--data-dir', data], {
    cwd: root, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env,
      VMUSIC_BACKEND: 'null', VMUSIC_SECRETS: 'memory', HERTZ_DESKTOP_CONFIG_DIR: desktop,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
    },
  });
  fs.closeSync(log); child.on('error', error => { spawnError = error; });
  launches.push({ pid: child.pid, cdpPort: port });
  discovery = await until(() => {
    if (child.exitCode !== null) throw new Error('Owned player exited: ' + child.exitCode);
    try { const value = JSON.parse(fs.readFileSync(path.join(data, 'vmusicd.json'), 'utf8')); return value.pid === child.pid && value; } catch { return null; }
  }, 'owned native service startup', 60000);
  await until(async () => { try { return (await fetch('http://127.0.0.1:' + port + '/json/version')).ok; } catch { return false; } }, 'owned native CDP');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  page = await until(() => browser.contexts().flatMap(context => context.pages()).find(p => p.url().startsWith('http://127.0.0.1:' + discovery.port)), 'native main WebView');
  page.setDefaultTimeout(18000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.__hertzWindowHost && window.HertzDesktopLyricsSettings && document.getElementById('conn').textContent === '服务已连接', null, { timeout: 45000 });
  assert.equal((await api('/v1/health')).backend, 'null');
}
async function openInline() {
  await page.evaluate(() => window.dispatchEvent(new Event('hertz-open-desktop-lyrics-settings')));
  await page.locator('#desktop-lyrics-settings').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.getElementById('dls-controls').disabled && !document.getElementById('dls-refresh').disabled);
  await page.waitForFunction(() => document.querySelector('#desktop-lyrics-settings > legend').getBoundingClientRect().top
    >= document.querySelector('.hz-settings-nav').getBoundingClientRect().bottom);
}
async function settle() { await page.waitForFunction(() => !document.getElementById('dls-refresh').disabled); }
async function shutdown() {
  await api('/v1/system/shutdown', 'POST', {}, 202);
  await until(() => child.exitCode !== null || child.signalCode !== null, 'owned player graceful shutdown', 30000);
  assert.equal(child.exitCode, 0, 'Owned player exited successfully');
  if (browser) await browser.close().catch(() => {});
  browser = page = child = null;
}
async function cleanup() {
  if (fs.existsSync(failedWritePath) && fs.statSync(failedWritePath).isDirectory()) {
    assert.equal(path.dirname(path.resolve(failedWritePath)), path.resolve(desktop));
    fs.rmdirSync(failedWritePath); // Empty, explicitly named fixture fault; no recursive removal.
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    await api('/v1/system/shutdown', 'POST', {}, 202).catch(() => {});
    await delay(500);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await until(() => child.exitCode !== null || child.signalCode !== null, 'owned process cleanup', 5000);
  }
  if (browser) await browser.close().catch(() => {});
  browser = page = child = null;
}
async function main() {
  assert.equal(process.platform, 'win32', 'Requires Windows/WebView2');
  assert.ok(fs.existsSync(binary), 'Build hertz-studio with full,native-window before this check');
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(desktop);
  const profile = { dataDir: data, edition: 'full' };
  const seed = { enabled: false, locked: true, layout: 'double', secondary: 'next', theme: 'dark', surface: 'glass', align: 'center',
    bilingual: false, karaoke: true, readabilityBoost: false, fontFamily: 'Segoe UI', fontSize: 32, fontWeight: 600,
    sungColor: '#8fe3ff', unsungColor: '#ffffff', outlineColor: '#141419', outlineWidth: 2, opacity: .92,
    width: 760, anchorX: .43, anchorY: .78, monitor: null };
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 2, revision: 7, launchAtLogin: false, activeProfile: profile,
    profiles: [{ profile, lyrics: seed, wallpaper: { enabled: false, fps: 15, musicResponse: false, monitor: null,
      source: 'fixed', scene: 'coast', brightness: .75, motion: .3, batteryPolicy: 'pause', quality: 'low' } }] }));
  fs.writeFileSync(path.join(output, 'windows.ps1'), `param([int]$TargetPid)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class LyricsSettingWindows {
 public delegate bool Callback(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumWindows(Callback c,IntPtr p);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder t,int size);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 public class Info { public long Handle; public uint ProcessId; public uint ThreadId; public string Title; public bool Visible; }
 public static Info[] Read(uint target) { var list=new List<Info>(); EnumWindows((h,p)=> {uint pid; var thread=GetWindowThreadProcessId(h,out pid); if(pid==target){var t=new StringBuilder(256);GetWindowText(h,t,t.Capacity);if(t.Length>0)list.Add(new Info{Handle=h.ToInt64(),ProcessId=pid,ThreadId=thread,Title=t.ToString(),Visible=IsWindowVisible(h)});}return true;},IntPtr.Zero);return list.ToArray(); }
}
'@
ConvertTo-Json -Compress -InputObject @([LyricsSettingWindows]::Read([uint32]$TargetPid))
`, 'utf8');
  await start();
  const initial = await read(); assert.equal(initial.ok, true, JSON.stringify(initial));
  assert.equal(initial.lyricsConfig.enabled, false); assert.equal(initial.runtime.visible, false); assert.equal(initial.positionEditing, false);
  const owned = assertNoSettingsWindow();
  const lyricsWindow = owned.find(window => window.Title === 'Hertz 桌面歌词');
  assert.ok(lyricsWindow && !lyricsWindow.Visible); assert.equal(lyricsWindow.ProcessId, child.pid);
  writeJson('initial-windows', owned);
  const baselineWallpaper = structuredClone(domain(stored()).wallpaper), baselineMini = structuredClone(domain(stored()).mini);
  mark('Read starts the embedded host in the main PID without enabling lyrics or opening a separate settings window');

  await openInline();
  await page.screenshot({ path: path.join(output, 'main-inline-editor.png') });
  assert.equal(await page.locator('#dls-enabled').isChecked(), false);
  await page.locator('#dls-enabled').check(); await page.locator('#dls-locked').uncheck();
  await page.locator('#dls-font-size').fill('38'); await page.locator('#dls-layout').selectOption('triple');
  await page.locator('#dls-bilingual').check(); await page.locator('#dls-secondary').selectOption('romanization');
  await page.locator('#dls-sung-color').fill('#cfbefa'); await page.locator('#dls-unsung-color').fill('#d5dae3');
  await page.locator('#dls-opacity').fill('0.85');
  await page.locator('#dls-apply').click(); await settle();
  const applied = await read();
  assert.equal(applied.ok, true); assert.ok(applied.revision > initial.revision);
  for (const [key, value] of Object.entries({ enabled: true, locked: false, fontSize: 38, layout: 'triple', bilingual: true,
    secondary: 'romanization', sungColor: '#cfbefa', unsungColor: '#d5dae3', opacity: .85 })) assert.equal(applied.lyricsConfig[key], value, key);
  assert.deepEqual(domain(stored()).wallpaper, baselineWallpaper); assert.deepEqual(domain(stored()).mini, baselineMini);
  assertNoSettingsWindow();
  await page.screenshot({ path: path.join(output, 'main-inline-saved.png') });
  await page.reload(); await page.waitForFunction(() => window.HertzDesktopLyricsSettings && window.__hertzWindowHost);
  await openInline(); assert.equal(await page.locator('#dls-font-size').inputValue(), '38');
  assert.equal(await page.locator('#dls-bilingual').isChecked(), true);
  mark('Main-window controls save enable/lock, font, colors, layout and bilingual settings; reload retains them and wallpaper/mini preferences remain intact');

  const beforeFailure = fs.readFileSync(configPath);
  assert.equal(path.dirname(path.resolve(failedWritePath)), path.resolve(desktop));
  fs.mkdirSync(failedWritePath);
  try {
    await page.locator('#dls-font-size').fill('46'); await page.locator('#dls-apply').click(); await settle();
    assert.equal(await page.locator('#dls-font-size').inputValue(), '46');
    assert.match(await page.locator('#dls-status').innerText(), /失败|未确认|未保存/);
    assert.deepEqual(fs.readFileSync(configPath), beforeFailure);
    assert.equal((await read()).lyricsConfig.fontSize, 38);
  } finally { fs.rmdirSync(failedWritePath); }
  mark('Actual disk-write failure leaves saved bytes unchanged and keeps the main-window draft for recovery');

  const external = await command('lyrics-apply', { expectedRevision: applied.revision, lyrics: { ...applied.lyricsConfig, fontSize: 41 } });
  assert.equal(external.ok, true, JSON.stringify(external));
  await page.locator('#dls-apply').click(); await settle();
  assert.equal(await page.locator('#dls-font-size').inputValue(), '46');
  assert.equal(await page.locator('#dls-conflict').isVisible(), true);
  assert.equal((await read()).lyricsConfig.fontSize, 41);
  const rejected = await command('lyrics-apply', { expectedRevision: applied.revision, lyrics: applied.lyricsConfig });
  assert.equal(rejected.ok, false); assert.equal(rejected.error, 'revision_conflict');
  await page.locator('#dls-discard').click(); await settle();
  assert.equal(await page.locator('#dls-font-size').inputValue(), '41');
  mark('A stale page cannot overwrite external changes; HTTP conflict preserves both the latest saved settings and the local draft');

  let current = await read();
  current = await command('lyrics-apply', { expectedRevision: current.revision, lyrics: { ...current.lyricsConfig, enabled: false, locked: true } });
  assert.equal(current.ok, true);
  const owner = crypto.randomUUID(), other = crypto.randomUUID();
  const begin = await command('lyrics-position-begin', { expectedRevision: current.revision, owner });
  assert.equal(begin.ok, true); assert.equal(begin.positionEditing, true); assert.equal(begin.positionOwned, true);
  assert.equal(begin.lyricsConfig.enabled, false); assert.equal(begin.lyricsConfig.locked, true);
  assert.equal(begin.runtime.locked, false);
  assert.equal((await read(other)).positionOwned, false);
  const second = await command('lyrics-position-begin', { expectedRevision: current.revision, owner: other });
  assert.equal(second.ok, false); assert.equal(second.error, 'position_edit_active');
  for (const action of ['lyrics-position-cancel', 'lyrics-position-done']) {
    const refused = await command(action, { owner: other }); assert.equal(refused.ok, false); assert.equal(refused.error, 'position_owner_mismatch');
  }
  const blocked = await command('lyrics-apply', { expectedRevision: current.revision, lyrics: current.lyricsConfig });
  assert.equal(blocked.ok, false); assert.equal(blocked.error, 'position_edit_active');
  const cancelled = await command('lyrics-position-cancel', { owner });
  assert.equal(cancelled.ok, true); assert.equal(cancelled.positionEditing, false); assert.equal(cancelled.revision, current.revision);
  assert.deepEqual(cancelled.lyricsConfig, current.lyricsConfig);
  await command('lyrics-position-begin', { expectedRevision: current.revision, owner });
  const done = await command('lyrics-position-done', { owner });
  assert.equal(done.ok, true); assert.equal(done.positionEditing, false); assert.equal(done.lyricsConfig.enabled, false); assert.equal(done.lyricsConfig.locked, true);
  assert.deepEqual(domain(stored()).wallpaper, baselineWallpaper);
  mark('Position sessions enforce owner identity, reject concurrent saves and restore the original disabled/locked intent after Cancel and Done');

  await page.locator('#dls-refresh').click(); await settle();
  await page.locator('#dls-position-begin').click(); await settle();
  assert.equal(await page.locator('#dls-position-cancel').isVisible(), true);
  await page.evaluate(() => HertzShell.navigate('home'));
  await until(async () => !(await read()).positionEditing, 'leaving main settings cancels owned position session');
  assert.equal((await read()).lyricsConfig.enabled, false);
  mark('Leaving the main settings category releases its real native positioning session');
  const persisted = (await read()).lyricsConfig;
  await command('quit');
  await until(async () => {
    const response = await fetch('http://127.0.0.1:' + discovery.port + '/v1/desktop/control', { method: 'POST',
      headers: { Authorization: 'Bearer ' + discovery.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'status' }) });
    return response.status === 503;
  }, 'embedded host stopped');
  assert.deepEqual((await read()).lyricsConfig, persisted); assertNoSettingsWindow();
  mark('Embedded host restart keeps the saved lyrics configuration without opening the native settings window');
  await shutdown(); await start();
  assert.deepEqual((await read()).lyricsConfig, persisted); assert.deepEqual(domain(stored()).wallpaper, baselineWallpaper);
  await openInline(); assert.equal(await page.locator('#dls-font-size').inputValue(), '41');
  assertNoSettingsWindow(); assert.deepEqual(errors, []);
  mark('Full player restart restores the same lyrics and wallpaper preferences in the main-window editor');
  await shutdown();
}
main().then(async () => {
  await cleanup(); writeJson('report', { passed: true, cleanupDone: true, checks, errors, launches,
    binarySha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
    scope: 'Real Wry/WebView2 main window and embedded lyrics host, private config/data, null audio; no physical monitor drag or mixed-DPI qualification.' });
  console.log('Desktop lyrics settings native: ' + checks.length + ' groups; ' + output);
}).catch(async error => {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 5000 }).catch(() => {});
  await cleanup().catch(() => {});
  fs.mkdirSync(output, { recursive: true }); writeJson('report', { passed: false, checks, errors, launches, error: error.stack });
  console.error(error); console.error(output); process.exitCode = 1;
});
