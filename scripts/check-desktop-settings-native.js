// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// Windows-only integration smoke using isolated config + actual WebView2/Win32 host.
// Run after cargo build -p hertz-desktop, with no other desktop instance running.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/desktop-settings-native-' + Date.now());
const profileDir = path.join(output, 'profile'); fs.mkdirSync(profileDir, { recursive: true });
const lyrics = { enabled: false, locked: true, layout:'double', secondary:'next', fontFamily:'Segoe UI', fontSize:32, fontWeight:600, sungColor:'#8fe3ff', unsungColor:'#ffffff', outlineColor:'#000000', outlineWidth:2, opacity:.92, width:900, anchorX:.5, anchorY:.84, monitor:null };
const wallpaper = {enabled:false, fps:30, musicResponse:true, monitor:null, source:'fixed', scene:'coast'};
const profile = {dataDir:profileDir, edition:'full'};
const configFile = path.join(output, 'config.json');
fs.writeFileSync(configFile, JSON.stringify({schemaVersion:2, revision:1, launchAtLogin:false, activeProfile:profile, profiles:[{profile,lyrics,wallpaper}]}));
const pipePath = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi,'').slice(0,32);
function command(command, value) { return new Promise((resolve,reject) => { const socket = net.connect(pipePath); let bytes=''; socket.setTimeout(4000); socket.on('connect', () => socket.write(JSON.stringify({command,value}))); socket.on('data', chunk => {bytes += chunk; try { const response=JSON.parse(bytes); socket.destroy(); resolve(response); } catch {} }); socket.on('error',reject); socket.on('timeout',() => {socket.destroy();reject(new Error('pipe timeout'));}); }); }
function closeNativeSettings() {
 const title=Buffer.from('桌面歌词与壁纸','utf16le').toString('base64');
 const script=`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class HertzClose{[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr FindWindow(string c,string t);[DllImport("user32.dll")]public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);}'; $hwnd=[HertzClose]::FindWindow([NullString]::Value,[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${title}')));if($hwnd -eq [IntPtr]::Zero){throw 'Settings not found'};[void][HertzClose]::PostMessage($hwnd,16,[IntPtr]::Zero,[IntPtr]::Zero)`;
 execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:'ignore'});
}
function geometry(move) {
  const moveScript = move ? '[void][HertzGeometry]::SetWindowPos($hwnd,[IntPtr]::Zero,' + (move === 'edge' ? '-500,-500' : '($rect.left+50),($rect.top-65)') + ',0,0,21); [void][HertzGeometry]::GetWindowRect($hwnd,[ref]$rect);' : '';
  const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class HertzGeometry { [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c,string t); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r); [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr z,int x,int y,int w,int ht,uint f); public struct Rect {public int left,top,right,bottom;} }'; $hwnd=[HertzGeometry]::FindWindow([NullString]::Value,([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('SABlAHIAdAB6ACAATGhil0xrzYs=')))); if($hwnd -eq [IntPtr]::Zero){throw 'Lyrics window not found'}; $rect=New-Object HertzGeometry+Rect; [void][HertzGeometry]::GetWindowRect($hwnd,[ref]$rect); ${moveScript} $rect | ConvertTo-Json -Compress`;
  return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script], {encoding:'utf8', windowsHide:true}));
}
async function main() {
  if (process.platform !== 'win32') throw new Error('Native desktop smoke requires Windows');
  const processCheck = execFileSync('powershell.exe',['-NoProfile','-Command', "@(Get-Process hertz-desktop -ErrorAction SilentlyContinue).Count"], {encoding:'utf8', windowsHide:true}).trim();
  if (processCheck !== '0') throw new Error('Stop the existing desktop instance before running the isolated smoke');
  const port = Number(process.env.DESKTOP_CDP_PORT || 19426);
  const child=spawn(path.join(root,'target/debug/hertz-desktop.exe'),['--settings'],{cwd:root,windowsHide:true,env:{...process.env,HERTZ_DESKTOP_CONFIG_DIR:output,WEBVIEW2_USER_DATA_FOLDER:path.join(output,'webview2'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port},stdio:'ignore'});
  let browser;
  try {
    for (let i=0;i<75;i++) {try { const response=await fetch('http://127.0.0.1:'+port+'/json/version'); if (response.ok) {browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);break;} } catch {} if (child.exitCode !== null) throw new Error('Native host exited: '+child.exitCode); await new Promise(resolve=>setTimeout(resolve,200));}
    assert.ok(browser,'WebView2 CDP must start');
    let page;
    for (let i=0;i<50;i++) {page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes('/settings.html')); if (page) break; await new Promise(resolve=>setTimeout(resolve,200));}
    assert.ok(page,'Unified settings page exists');
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.waitForFunction(()=>document.querySelector('#settings-state').textContent==='设置已保存');
    await command('wallpaper-settings',{tab:'lyrics'});
    await page.waitForFunction(()=>document.querySelector('#tab-lyrics').getAttribute('aria-selected')==='true');
    const before=fs.readFileSync(configFile,'utf8');
    await page.locator('#lyrics-size').fill('40');
    closeNativeSettings();await page.waitForFunction(()=>!document.querySelector('#close-confirm').hidden);
    assert.equal(await page.locator('#lyrics-size').inputValue(),'40');
    assert.equal(page.isClosed(),false);
    await page.locator('#continue-editing').click();
    await page.locator('#close').click();assert.equal(await page.locator('#close-confirm').isVisible(),true);await page.locator('#continue-editing').click();
    await page.waitForTimeout(1200);
    assert.equal(fs.readFileSync(configFile,'utf8'),before,'Draft must never persist');
    await page.locator('#discard').click();
    await command('hide');
    const original=geometry(false); console.log('Original native geometry',original);
    await page.locator('#position-begin').click();
    await page.waitForFunction(()=>!document.querySelector('#position-session').hidden);
    const active=await command('status');
    assert.equal(active.positionEditing,true);assert.equal(active.locked,false);assert.equal(active.enabled,true);assert.equal(active.userHidden,false);
    geometry('edge');
    await page.waitForTimeout(500);
    const bounded=geometry(false);assert.ok(bounded.left>=16 && bounded.top>=16,'Position editing enforces the per-monitor 16 DIP safety inset');
    await page.waitForTimeout(200);
    assert.equal(fs.readFileSync(configFile,'utf8'),before,'Position edit must not persist before done');
    await page.locator('#position-cancel').click();
    await page.waitForFunction(()=>document.querySelector('#position-session').hidden);
    const cancelled=await command('status');
    assert.equal(cancelled.locked,true);assert.equal(cancelled.enabled,false);assert.equal(cancelled.userHidden,true);
    assert.deepEqual(geometry(false),original,'Cancel restores exact native window geometry');
    assert.equal(fs.readFileSync(configFile,'utf8'),before);
    await page.locator('#position-begin').click();
    await page.waitForFunction(()=>!document.querySelector('#position-session').hidden);
    console.log('Moved native geometry',geometry(true)); await page.waitForTimeout(500);
    await page.locator('#position-done').click();
    await page.waitForFunction(()=>document.querySelector('#position-session').hidden);
    const after=JSON.parse(fs.readFileSync(configFile,'utf8'));
    assert.equal(after.profiles[0].lyrics.locked,true);assert.equal(after.profiles[0].lyrics.enabled,false);
    assert.notEqual(after.profiles[0].lyrics.anchorY,lyrics.anchorY);
    const done=await command('status');assert.equal(done.userHidden,true);assert.equal(done.visible,false);
    // Closing the native settings window cancels an in-flight move too.
    const savedGeometry=geometry(false);
    await page.locator('#position-begin').click();await page.waitForFunction(()=>!document.querySelector('#position-session').hidden);
    geometry(true);await page.waitForTimeout(300);await page.locator('#close').click();
    await new Promise(resolve=>setTimeout(resolve,300));assert.deepEqual(geometry(false),savedGeometry);
    await command('wallpaper-settings',{tab:'wallpaper'});
    for (let i=0;i<30;i++){page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes('/settings.html')&&!page.isClosed());if(page)break;await new Promise(resolve=>setTimeout(resolve,100));}
    await page.waitForSelector('#preview:enabled');
    const persisted=fs.readFileSync(configFile,'utf8');
    await page.locator('#preview').click();
    await page.waitForFunction(()=>document.querySelector('#preview-renderer')?.contentDocument?.querySelector('canvas'));
    await page.waitForTimeout(1000);
    assert.equal(fs.readFileSync(configFile,'utf8'),persisted,'Real embedded preview remains readonly');
    assert.equal((await command('status')).wallpaper.previewActive,true);
    await page.screenshot({path:path.join(output,'native-wallpaper-preview.png')});
    await page.locator('#tab-lyrics').click();
    await page.waitForFunction(()=>!document.querySelector('#preview-renderer'));
    assert.equal((await command('status')).wallpaper.previewActive,false);
    await page.locator('#lyrics-size').fill('41');await page.locator('#apply').click();
    await page.waitForFunction(()=>document.querySelector('#settings-state').textContent==='设置已保存');
    assert.equal(JSON.parse(fs.readFileSync(configFile,'utf8')).profiles[0].lyrics.fontSize,41);
    // A real external writer changes the revision while the settings draft is dirty.
    await page.locator('#lyrics-size').fill('45');
    await command('font', 37);
    await page.waitForFunction(()=>!document.querySelector('#conflict').hidden);
    assert.equal(await page.locator('#lyrics-size').inputValue(),'45');
    assert.equal(await page.locator('#apply').isEnabled(),false);
    await page.locator('#discard').click();
    assert.equal(await page.locator('#lyrics-size').inputValue(),'37');
    await page.screenshot({path:path.join(output,'native-lyrics-applied.png')});
    // Exercise the actual WorkerW desktop surface, then release it again.
    await page.locator('#tab-wallpaper').click();
    await page.locator('#enabled').check();
    await page.locator('#fps').selectOption('15');
    await page.locator('#apply').click();
    await page.waitForFunction(()=>document.querySelector('#settings-state').textContent==='设置已保存');
    let mounted;
    for(let i=0;i<40;i++){ mounted=await command('status'); if(mounted.wallpaper.pageReady && mounted.wallpaper.visible && mounted.diagnostics.page.draws>0)break; await new Promise(resolve=>setTimeout(resolve,200)); }
    assert.equal(mounted.wallpaper.enabled,true);assert.equal(mounted.wallpaper.pageReady,true);assert.equal(mounted.wallpaper.visible,true);assert.ok(mounted.diagnostics.page.draws>0,'Actual desktop renderer must draw');
    assert.equal(mounted.wallpaper.fps,15);
    fs.writeFileSync(path.join(output,'native-wallpaper-running.json'),JSON.stringify(mounted,null,2));
    await page.locator('#enabled').uncheck();await page.locator('#apply').click();
    await page.waitForFunction(()=>document.querySelector('#settings-state').textContent==='设置已保存');
    assert.equal((await command('status')).wallpaper.enabled,false);
    assert.deepEqual(errors,[]);
    console.log('native desktop checks passed: tab routing, readonly draft/preview, real Win32 move cancel/commit/close restore, lock/visibility restore, revision conflicts, atomic save, actual WorkerW desktop render/release');
    console.log('evidence: '+output);
  } finally {
    try {await command('quit');}catch{}
    if (browser) await browser.close().catch(()=>{});
    if (child.exitCode===null) child.kill();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
