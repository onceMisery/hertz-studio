// SPDX-License-Identifier: MIT
// Focused Windows/WebView2 persistence recovery. Uses isolated profiles and config only.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const requestManagement = require('./desktop-native-management-client');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/desktop-persistence-native-' + Date.now());
const pipe = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const lyrics = { enabled:true, locked:false, layout:'triple', secondary:'next', theme:'light', surface:'glass', align:'center', bilingual:true, karaoke:true, readabilityBoost:false, fontFamily:'Segoe UI', fontSize:30, fontWeight:600, sungColor:'#ffffff', unsungColor:'#ffffff', outlineColor:'#000000', outlineWidth:0, opacity:1, width:550, anchorX:.5, anchorY:.5, monitor:null };
const wallpaper = { enabled:false, fps:30, musicResponse:true, monitor:null, source:'fixed', scene:'coast' };
function command(command, value) { return requestManagement(pipe, {command, value}); }
async function windowState(move) {
  const title = Buffer.from('Hertz 桌面歌词', 'utf16le').toString('base64');
  const script = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class HertzPersistence{[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr FindWindow(string c,string t);[DllImport("user32.dll",EntryPoint="GetWindowLongW")]public static extern uint GetWindowLong(IntPtr h,int i);[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out Rect r);[DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr h,IntPtr z,int x,int y,int w,int ht,uint f);public struct Rect{public int left,top,right,bottom;}}';$hwnd=[HertzPersistence]::FindWindow([NullString]::Value,[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${title}')));if($hwnd -eq [IntPtr]::Zero){throw 'Fixture window missing'};$rect=New-Object HertzPersistence+Rect;[void][HertzPersistence]::GetWindowRect($hwnd,[ref]$rect);${move ? '[void][HertzPersistence]::SetWindowPos($hwnd,[IntPtr]::Zero,($rect.left+70),($rect.top-55),0,0,21);[void][HertzPersistence]::GetWindowRect($hwnd,[ref]$rect);' : ''}@{locked=([HertzPersistence]::GetWindowLong($hwnd,-20)-band 32)-ne 0;rect=$rect}|ConvertTo-Json -Compress`;
  const {stdout} = await exec('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], {encoding:'utf8', windowsHide:true});
  return JSON.parse(stdout);
}
async function withHost(name, initial, body) {
  const directory = path.join(output, name); fs.mkdirSync(directory, {recursive:true});
  const profileDir = path.join(directory, 'source'); fs.mkdirSync(profileDir);
  const profile = {kind:'standalone',edition:'full',dataDir:profileDir};
  const configFile = path.join(directory, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(initial(profile)));
  const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(path.join(root, 'target/debug/hertz-desktop.exe'), ['--settings'], {cwd:root, windowsHide:true, stdio:'ignore', env:{...process.env,HERTZ_DESKTOP_CONFIG_DIR:directory,WEBVIEW2_USER_DATA_FOLDER:path.join(directory,'webview2'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port}});
  let browser;
  try {
    for (let i=0;i<75;i++) { try { const response=await fetch('http://127.0.0.1:'+port+'/json/version'); if(response.ok){ browser=await chromium.connectOverCDP('http://127.0.0.1:'+port); break; } } catch(_) {} if(child.exitCode!==null)throw new Error('native exited '+child.exitCode);await delay(200); }
    assert.ok(browser, 'isolated WebView2 must start');
    let settings, lyricPage;
    for (let i=0;i<50;i++) { const pages=browser.contexts().flatMap(context=>context.pages()); settings=pages.find(page=>page.url().includes('/settings.html')); for(const page of pages){if(await page.evaluate(()=>!!window.hertzLyrics).catch(()=>false))lyricPage=page;}if(settings&&lyricPage)break;await delay(100); }
    assert.ok(settings&&lyricPage,'both fixture pages must exist');
    await settings.waitForFunction(()=>document.getElementById('settings-state').textContent==='设置已保存');
    await body({directory,profile,configFile,settings,lyricPage});
  } finally {
    try{await command('quit');}catch(_){}
    if(browser)await browser.close().catch(()=>{});
    for(let i=0;i<25&&child.exitCode===null;i++)await delay(100);
    if(child.exitCode===null)child.kill();
    await delay(200);
  }
}
async function main() {
  if(process.platform!=='win32')throw new Error('Windows required');
  const {stdout}=await exec('powershell.exe',['-NoProfile','-Command','@(Get-Process hertz-desktop -ErrorAction SilentlyContinue).Count'],{encoding:'utf8',windowsHide:true});
  assert.equal(stdout.trim(),'0','existing user native instance must be stopped before an isolated fixture');
  await withHost('rollback', profile=>({schemaVersion:3,revision:1,launchAtLogin:false,activeProfile:profile,profiles:[{profile,lyrics,wallpaper}]}),async({directory,configFile,settings,lyricPage})=>{
    const original=fs.readFileSync(configFile,'utf8');const originalWindow=await windowState(false);
    fs.mkdirSync(path.join(directory,'config.json.tmp'));
    assert.equal((await command('lock')).locked,true);
    await lyricPage.waitForFunction(()=>document.body.classList.contains('locked'));
    await delay(1200);
    assert.equal(await settings.locator('#status').textContent(),'未保存，已恢复上次设置','failed save remains visibly unsaved');
    assert.equal(await settings.locator('#status').getAttribute('class'),'error');
    assert.equal((await command('status')).locked,false,'failed lock save restores committed intent');
    assert.equal(await lyricPage.evaluate(()=>document.body.classList.contains('locked')),false,'failed lock save restores page lock');
    assert.equal((await windowState(false)).locked,false,'failed lock save restores Win32 hit testing');
    assert.equal(fs.readFileSync(configFile,'utf8'),original,'failed lock save leaves disk/revision untouched');
    await lyricPage.evaluate(()=>{for(const payload of [{cmd:'appearance',target:'fontSize',value:48},{cmd:'appearance',target:'theme',text:'dark'},{cmd:'width',value:-100}])window.ipc.postMessage(JSON.stringify(payload));});
    await delay(1200);
    assert.equal(await lyricPage.evaluate(()=>document.documentElement.style.getPropertyValue('--font-size')),'30px','appearance rollback reapplies committed page config');
    assert.equal(await lyricPage.evaluate(()=>document.body.dataset.theme),'light');
    assert.deepEqual((await windowState(false)).rect,originalWindow.rect,'appearance rollback restores native dimensions and anchor');
    const moved=await windowState(true);assert.notDeepEqual(moved.rect,originalWindow.rect);
    await delay(1200);
    assert.deepEqual((await windowState(false)).rect,originalWindow.rect,'ordinary drag rollback restores committed placement');
    assert.equal(fs.readFileSync(configFile,'utf8'),original);
    fs.rmdirSync(path.join(directory,'config.json.tmp'));
    await command('locate');
    await lyricPage.waitForFunction(()=>!document.body.classList.contains('locked'));
  });
  const legacyLyrics={...lyrics,fontSize:44,locked:true,enabled:true};
  const legacyWallpaper={...wallpaper,fps:60};
  await withHost('unbound',()=>({schemaVersion:1,revision:9,launchAtLogin:false,activeProfile:null,lyrics:legacyLyrics,wallpaper:legacyWallpaper}),async({profile,configFile,settings})=>{
    assert.equal((await command('status')).profile,null,'unbound migration has no active source');
    const migrated=JSON.parse(fs.readFileSync(configFile));assert.equal(migrated.schemaVersion,3);assert.equal(migrated.revision,10);assert.ok(migrated.unboundStandalone);
    await command('wallpaper-settings',{profile});
    await settings.locator('#tab-runtime').click();
    await settings.waitForFunction(()=>!document.getElementById('profile').disabled);
    const profileKey = ['standalone','','full',profile.dataDir.toLowerCase()].join('|');
    await settings.locator('#profile').selectOption(profileKey);
    assert.equal(await settings.locator('#switch-source').isEnabled(),true,'unbound candidate remains bindable');
    fs.mkdirSync(path.join(path.dirname(configFile),'config.json.tmp'));
    await settings.locator('#switch-source').click();
    await settings.waitForFunction(()=>document.getElementById('status').classList.contains('error'));
    assert.equal((await command('status')).profile,null,'failed first binding does not activate a candidate');
    assert.ok(JSON.parse(fs.readFileSync(configFile)).unboundStandalone,'failed first binding keeps old preferences');
    fs.rmdirSync(path.join(path.dirname(configFile),'config.json.tmp'));
    await settings.locator('#switch-source').click();
    await settings.waitForFunction(()=>document.getElementById('status').textContent==='已切换来源');
    const stored=JSON.parse(fs.readFileSync(configFile));assert.equal(stored.revision,11);assert.equal(stored.activeProfile.kind,'standalone');assert.equal(stored.profiles.length,1);assert.equal(stored.profiles[0].lyrics.fontSize,44);assert.equal(stored.profiles[0].lyrics.locked,true);assert.equal(stored.profiles[0].wallpaper.fps,60);assert.equal(stored.unboundStandalone,undefined);
    assert.equal((await command('status')).profile.kind,'standalone');
  });
  console.log('Native persistence checks passed: lock/page/Win32, appearance and drag rollback, unbound first binding atomic failure/retry. Evidence: '+output);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
