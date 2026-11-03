// SPDX-License-Identifier: MIT
// Exercise real Win32 cursor/button sampling behind the Explorer icon layer.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const requestManagement = require('./desktop-native-management-client');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/wallpaper-pointer-native-' + Date.now());
const configFile = path.join(output, 'config.json');
const pipe = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
const port = Number(process.env.DESKTOP_CDP_PORT || 19439);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], errors = [];
let child, browser, settings, desktop, minimized = false, savedCursor;
function ps(script) { return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim(); }
const mouseApi = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WallpaperMouse {
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x,y; }
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left,top,right,bottom; }
 public delegate bool WindowCallback(IntPtr window,IntPtr data);
 [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window,uint flags);
 [DllImport("user32.dll")] public static extern bool EnumWindows(WindowCallback callback,IntPtr data);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window,out RECT rect);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window,int command);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window,StringBuilder text,int length);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window,StringBuilder text,int length);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
 public static string RootClass(int x,int y) { var text=new StringBuilder(256); GetClassName(GetAncestor(WindowFromPoint(new POINT{x=x,y=y}),2),text,256); return text.ToString(); }
 public static IntPtr OwnedWindow(uint pid) { IntPtr found=IntPtr.Zero; EnumWindows((h,l)=>{uint owner;GetWindowThreadProcessId(h,out owner);var text=new StringBuilder(256);GetWindowText(h,text,256);if(owner==pid&&text.ToString()=="桌面歌词与壁纸"){found=h;return false;}return true;},IntPtr.Zero);return found; }
}
'@
[void][WallpaperMouse]::SetProcessDpiAwarenessContext([IntPtr](-4))
`;
async function until(check, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(80); }
  throw new Error(label);
}
async function status() { return requestManagement(pipe, { command: 'status' }); }
async function main() {
  assert.equal(process.platform, 'win32');
  assert.equal(ps('@(Get-Process hertz-desktop -ErrorAction SilentlyContinue).Count'), '0', 'another host owns the control pipe');
  fs.mkdirSync(output, { recursive: true });
  const lyrics = { enabled: false, locked: false, layout: 'double', secondary: 'next', fontFamily: 'Segoe UI', fontSize: 32, fontWeight: 600, sungColor: '#ffffff', unsungColor: '#ffffff', outlineColor: '#000000', outlineWidth: 1, opacity: 1, width: 550, anchorX: .5, anchorY: .5, monitor: null };
  fs.writeFileSync(configFile, JSON.stringify({ schemaVersion: 4, revision: 1, launchAtLogin: false, activeProfile: null, profiles: [], unboundDomain: { lyrics, wallpaper: { enabled: true, fps: 30, musicResponse: false, monitor: null, source: 'fixed', scene: 'zodiac' } }, lastCommit: null }));
  child = spawn(path.join(root, 'target/debug/hertz-desktop.exe'), ['--settings'], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, HERTZ_DESKTOP_CONFIG_DIR: output, WEBVIEW2_USER_DATA_FOLDER: path.join(output, 'webview2'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port } });
  await until(async () => { if (child.exitCode !== null) throw new Error('host exited ' + child.exitCode); try { return (await fetch('http://127.0.0.1:' + port + '/json/version')).ok; } catch { return false; } }, 'CDP startup');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  const pages = () => browser.contexts().flatMap(context => context.pages());
  settings = await until(() => pages().find(page => page.url().includes('/settings.html')), 'settings');
  desktop = await until(() => pages().find(page => page.url().includes('/wallpaper.html')), 'wallpaper');
  settings.on('pageerror', error => errors.push(error.message)); desktop.on('pageerror', error => errors.push(error.message));
  await settings.waitForSelector('#pointer:enabled');
  await until(async () => (await status()).wallpaper.firstFrameReady, 'first frame');
  assert.equal(await desktop.evaluate(() => window.__hertzWallpaperNativePointer), true);
  await settings.locator('#pointer').check();
  await settings.locator('#apply').click();
  await until(() => JSON.parse(fs.readFileSync(configFile)).unboundDomain.wallpaper.groups[0].presentation.pointer, 'saved pointer preference');
  await until(async () => (await desktop.evaluate(() => hertzWallpaper.debug())).pointer.enabled, 'applied pointer preference');
  checks.push({ case: 'formal-settings-apply', saved: true });
  // A DOM click in the desktop renderer must not duplicate the native desktop click.
  const initialClicks = await desktop.evaluate(() => hertzWallpaper.debug().pointer.clicks);
  await desktop.evaluate(() => dispatchEvent(new PointerEvent('pointerdown', { clientX: 200, clientY: 200, button: 0 })));
  assert.equal(await desktop.evaluate(() => hertzWallpaper.debug().pointer.clicks), initialClicks);
  savedCursor = JSON.parse(ps(mouseApi + '$point=New-Object WallpaperMouse+POINT; [void][WallpaperMouse]::GetCursorPos([ref]$point); $point|ConvertTo-Json -Compress'));
  minimized = true;
  ps('(New-Object -ComObject Shell.Application).MinimizeAll()');
  await delay(600);
  await until(async () => (await status()).wallpaper.visible, 'visible desktop');
  const baseline = await desktop.evaluate(() => hertzWallpaper.debug().pointer);
  const position = JSON.parse(ps(mouseApi + `
$x=[int]([WallpaperMouse]::GetSystemMetrics(0)*0.62)
$y=[int]([WallpaperMouse]::GetSystemMetrics(1)*0.55)
$class=[WallpaperMouse]::RootClass($x,$y)
if($class -ne 'Progman' -and $class -ne 'WorkerW'){throw 'Mouse test requires the actual Explorer desktop'}
for($step=0;$step -lt 5;$step++) {
 $moveX=$x-120+$step*30
 if([WallpaperMouse]::RootClass($moveX,$y) -notin @('Progman','WorkerW')){throw 'Move left the desktop'}
 [void][WallpaperMouse]::SetCursorPos($moveX,$y)
 Start-Sleep -Milliseconds 80
}
try { [WallpaperMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 120 }
finally { [WallpaperMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero) }
@{x=$x;y=$y;rootClass=$class}|ConvertTo-Json -Compress
`));
  const actual = await desktop.evaluate(() => hertzWallpaper.debug());
  assert.ok(actual.pointer.moves > baseline.moves, 'physical movement reaches desktop effects');
  assert.equal(actual.pointer.clicks, baseline.clicks + 1, 'one physical press triggers one ripple');
  assert.ok(actual.pointer.waves > 0);
  assert.equal(actual.error, null);
  await desktop.screenshot({ path: path.join(output, 'desktop-ripple.png') });
  checks.push({ case: 'physical-desktop-input', position, before: baseline, after: actual.pointer, scene: actual.scene, draws: actual.draws });
  // A real click on the foreground settings page must not trigger the wallpaper beneath it.
  const beforeSettings = await desktop.evaluate(() => hertzWallpaper.debug().pointer.clicks);
  await settings.locator('#tab-wallpaper').click();
  ps(mouseApi + `
$owned=[WallpaperMouse]::OwnedWindow(${child.pid})
if($owned -eq [IntPtr]::Zero){throw 'Owned settings window not found'}
[void][WallpaperMouse]::ShowWindow($owned,9)
[void][WallpaperMouse]::SetForegroundWindow($owned)
[void][WallpaperMouse]::SetWindowPos($owned,[IntPtr](-1),0,0,0,0,0x43)
Start-Sleep -Milliseconds 250
$rect=New-Object WallpaperMouse+RECT
[void][WallpaperMouse]::GetWindowRect($owned,[ref]$rect)
$x=[int](($rect.left+$rect.right)/2); $y=$rect.top+100
$point=New-Object WallpaperMouse+POINT; $point.x=$x; $point.y=$y
$hit=[WallpaperMouse]::GetAncestor([WallpaperMouse]::WindowFromPoint($point),2)
# WebView2 may expose a separate Chromium root HWND belonging to our child process.
$hitProcess=0; [void][WallpaperMouse]::GetWindowThreadProcessId($hit,[ref]$hitProcess)
$lineage=@(); $ownedHit=($hit -eq $owned); $cursorProcess=$hitProcess
for($depth=0;$depth -lt 8 -and $cursorProcess -gt 0 -and -not $ownedHit;$depth++) {
 if($cursorProcess -eq ${child.pid}){$ownedHit=$true;break}
 $item=Get-CimInstance Win32_Process -Filter "ProcessId = $cursorProcess"
 if(-not $item){break}
 $lineage+=($item.Name+':'+$item.ProcessId)
 $cursorProcess=$item.ParentProcessId
}
if(-not $ownedHit){throw ('Owned header is covered by '+($lineage -join ' -> '))}
[void][WallpaperMouse]::SetCursorPos($x,$y)
Start-Sleep -Milliseconds 100
try { [WallpaperMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 100 }
finally { [WallpaperMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero); [void][WallpaperMouse]::SetWindowPos($owned,[IntPtr](-2),0,0,0,0,0x13) }
`);
  await delay(150);
  assert.equal(await desktop.evaluate(() => hertzWallpaper.debug().pointer.clicks), beforeSettings);
  assert.equal(await desktop.evaluate(() => hertzWallpaper.debug().pointer.active), false);
  checks.push({ case: 'foreground-settings-click-excluded' });
  ps('(New-Object -ComObject Shell.Application).UndoMinimizeAll()'); minimized = false;
  await settings.locator('#pointer').uncheck(); await settings.locator('#apply').click();
  await until(async () => !(await desktop.evaluate(() => hertzWallpaper.debug())).pointer.enabled, 'disabled effects');
  assert.equal(await desktop.locator('#wallpaper-pointer-effects').count(), 0);
  checks.push({ case: 'disable-clears-surface' });
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log('wallpaper pointer native checks passed: settings persistence, real desktop movement/click, DOM deduplication, foreground exclusion and cleanup\n' + output);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (minimized) { try { ps('(New-Object -ComObject Shell.Application).UndoMinimizeAll()'); } catch {} }
  if (savedCursor) { try { ps(mouseApi + `[void][WallpaperMouse]::SetCursorPos(${savedCursor.x},${savedCursor.y})`); } catch {} }
  if (child && child.exitCode === null) { try { await requestManagement(pipe, { command: 'quit' }); } catch {} }
  if (browser) await browser.close().catch(() => {});
  if (child && child.exitCode === null) { await delay(1000); if (child.exitCode === null) child.kill(); }
});
