// SPDX-License-Identifier: MIT
// Isolated Windows WebView2 integration: actual IPC, resizing, saved settings, narrow playback.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const {spawn,execFile,execFileSync} = require('node:child_process');
const execFileAsync = require('node:util').promisify(execFile);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {config,lines} = require('./check-desktop-lyrics-browser');
const root = path.resolve(__dirname,'..');
const output = path.join(root,'output/playwright/desktop-lyrics-native-'+Date.now());
const profileDir = path.join(output,'profile');
const profile = {dataDir:profileDir,edition:'full'};
const session='desktop-lyrics-native';
const key='a'.repeat(64);
const snapshot={protocol:1,seq:0,server:{session,edition:'full',version:'0.3.0'},generation:'1',positionMs:17000,durationMs:35000,playing:false,buffering:false,track:{id:'fixture-track',title:'原生歌词测试'},lyrics:{status:'ready',documentKey:'fixture'},timing:'presentation_applied'};
const document={protocol:1,documentKey:'fixture',timing:'presentation_applied',lines:lines.map(line=>({...line,words:line.words.map(word=>({...word,startMs:Math.round(word.startMs),endMs:Math.round(word.endMs)}))}))};
let actions=[];
const server=http.createServer((request,response)=>{
  response.setHeader('Content-Type','application/json');
  if(request.headers.authorization!=='Desktop '+key){response.statusCode=401;response.end('{}');return;}
  if(request.url.startsWith('/v1/desktop-lyrics/snapshot')){snapshot.seq++;response.end(JSON.stringify(snapshot));return;}
  if(request.url.startsWith('/v1/desktop-lyrics/document')){response.end(JSON.stringify(document));return;}
  if(request.url==='/v1/desktop-lyrics/control'&&request.method==='POST'){
    let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{
      const action=JSON.parse(body);actions.push(action);
      if(action.action==='seek')snapshot.positionMs=action.positionMs;
      else snapshot.playing=action.action==='play';
      snapshot.generation=String(Number(snapshot.generation)+1);
      response.end('{"ok":true}');
    });return;
  }
  response.statusCode=404;response.end('{}');
});
const pipePath='\\\\.\\pipe\\hertz-desktop-control-'+(process.env.USERNAME||'').replace(/[^a-z0-9_-]/gi,'').slice(0,32);
function command(command,value){return new Promise((resolve,reject)=>{const socket=net.connect(pipePath);let body='';socket.setTimeout(4000);socket.on('connect',()=>socket.write(JSON.stringify({command,value})));socket.on('data',chunk=>{body+=chunk;try{const result=JSON.parse(body);socket.destroy();resolve(result);}catch{}});socket.on('error',reject);socket.on('timeout',()=>{socket.destroy();reject(new Error('pipe timeout'));});});}
async function assertBorderless(stage,refreshStyle=false){
  const title=Buffer.from('Hertz 桌面歌词','utf16le').toString('base64');
  const script=`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class LyricsFrame {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c,string t);
  [DllImport("user32.dll",EntryPoint="GetWindowLongW")] public static extern uint GetWindowLong(IntPtr h,int i);
  [DllImport("user32.dll",EntryPoint="SetWindowLongW")] public static extern int SetWindowLong(IntPtr h,int i,uint v);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr z,int x,int y,int w,int ht,uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h,out Rect r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h,ref Point p);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
  [DllImport("user32.dll")] public static extern bool RedrawWindow(IntPtr h,IntPtr r,IntPtr region,uint flags);
  public struct Rect { public int left,top,right,bottom; }
  public struct Point { public int x,y; }
}
'@
[void][LyricsFrame]::SetProcessDpiAwarenessContext([IntPtr](-4))
$hwnd=[LyricsFrame]::FindWindow([NullString]::Value,[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${title}')))
if($hwnd -eq [IntPtr]::Zero){throw 'Lyrics window not found'}
${refreshStyle ? `
[void][LyricsFrame]::SetWindowLong($hwnd,-16,([LyricsFrame]::GetWindowLong($hwnd,-16) -bor 0x00cf0000))
[void][LyricsFrame]::SetWindowPos($hwnd,[IntPtr]::Zero,0,0,0,0,55)
` : ''}
[void][LyricsFrame]::SendMessage($hwnd,134,[IntPtr]1,[IntPtr]::Zero)
[void][LyricsFrame]::RedrawWindow($hwnd,[IntPtr]::Zero,[IntPtr]::Zero,1153)
[void][LyricsFrame]::SendMessage($hwnd,134,[IntPtr]::Zero,[IntPtr]::Zero)
$window=New-Object LyricsFrame+Rect
$client=New-Object LyricsFrame+Rect
$origin=New-Object LyricsFrame+Point
[void][LyricsFrame]::GetWindowRect($hwnd,[ref]$window)
[void][LyricsFrame]::GetClientRect($hwnd,[ref]$client)
[void][LyricsFrame]::ClientToScreen($hwnd,[ref]$origin)
@{style=[LyricsFrame]::GetWindowLong($hwnd,-16);window=$window;client=$client;origin=$origin}|ConvertTo-Json -Compress
`;
  // Keep the fixture server responsive while PowerShell reads the real Win32 frame.
  const {stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true});
  const frame=JSON.parse(stdout);
  fs.appendFileSync(path.join(output,'native-frame-observations.jsonl'),JSON.stringify({stage,refreshStyle,...frame})+'\n');
  assert.equal(frame.style&0x00cf0000,0,stage+': native caption and frame stay removed');
  assert.equal(frame.origin.x,frame.window.left,stage+': no left frame');
  assert.equal(frame.origin.y,frame.window.top,stage+': no title bar');
  assert.equal(frame.client.right,frame.window.right-frame.window.left,stage+': full client width');
  assert.equal(frame.client.bottom,frame.window.bottom-frame.window.top,stage+': full client height');
}
async function main(){
  assert.equal(execFileSync('powershell.exe',['-NoProfile','-Command','@(Get-Process hertz-desktop -ErrorAction SilentlyContinue).Count'],{encoding:'utf8',windowsHide:true}).trim(),'0','Native checks require no existing desktop instance');
  fs.mkdirSync(profileDir,{recursive:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  fs.writeFileSync(path.join(profileDir,'vmusicd.json'),JSON.stringify({pid:process.pid,port:server.address().port,version:'0.3.0',protocol_version:1,edition:'full',server_instance_id:session,desktop_lyrics_protocol:1}));
  fs.writeFileSync(path.join(profileDir,'desktop-lyrics-key'),key);
  fs.writeFileSync(path.join(output,'config.json'),JSON.stringify({schemaVersion:2,revision:1,launchAtLogin:false,activeProfile:profile,profiles:[{profile,lyrics:{...config,width:550,anchorX:.5,anchorY:.3,monitor:null},wallpaper:{enabled:false,fps:30,musicResponse:true,monitor:null,source:'fixed',scene:'coast'}}]}).replace(',"frameCap":30','').replace(',"panelMaxHeight":360',''));
  const port=Number(process.env.DESKTOP_CDP_PORT||19427);
  const binary=process.env.HERTZ_DESKTOP_BIN||path.join(root,'target/debug/hertz-desktop.exe');
  const child=spawn(binary,[],{cwd:root,windowsHide:true,env:{...process.env,HERTZ_DESKTOP_CONFIG_DIR:output,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port},stdio:'ignore'});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  let browser,verificationPassed=false;
  try{
    for(let i=0;i<60;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);break;}catch{}if(child.exitCode!==null)throw new Error('Host exited '+child.exitCode);await new Promise(r=>setTimeout(r,200));}
    assert.ok(browser);
    const page=browser.contexts().flatMap(c=>c.pages())[0];
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.waitForSelector('.lyric-group[data-distance="0"] .word');
    await assertBorderless('shown');
    // Tao rebuilds GWL_STYLE from its own flags when window state changes.
    await assertBorderless('framework style refresh',true);
    assert.equal(await page.evaluate(()=>document.body.dataset.layout),'triple');
    const baseSize=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
    await page.locator('#stage').hover();await page.locator('#style-open').click();
    await page.waitForFunction(()=>innerHeight>500);
    const expanded=await page.evaluate(()=>({stage:document.getElementById('stage').clientHeight,height:innerHeight,panel:document.getElementById('options-panel').getBoundingClientRect().toJSON()}));
    console.log('Native lyrics expanded geometry', JSON.stringify({baseSize,expanded}));
    assert.ok(expanded.panel.bottom<=expanded.height);
    assert.ok(Math.abs(expanded.stage-(baseSize.height-84))<3,'Opening settings preserves lyric height');
    await assertBorderless('settings expanded');
    // Exercise the actual expand/collapse path, including native activation/frame
    // redraws. A single launch check misses captions that return after interaction.
    for(let cycle=0;cycle<6;cycle++){
      await page.locator('#options-done').click();
      await page.waitForFunction(h=>Math.abs(innerHeight-h)<3,baseSize.height);
      await assertBorderless('settings collapsed '+cycle);
      await page.locator('#stage').hover();await page.locator('#style-open').click();
      await page.waitForFunction(()=>innerHeight>500);
      await assertBorderless('settings reopened '+cycle,cycle===3);
    }
    await page.locator('[data-cmd="width-up"]').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#options-panel').evaluate(e=>e.scrollWidth<=e.clientWidth),true,'Settings do not overflow horizontally');
    assert.equal(await page.locator('#options-done').evaluate(e=>{
      const button=e.getBoundingClientRect(),panel=document.getElementById('options-panel').getBoundingClientRect();
      return button.top>=panel.top && button.bottom<=panel.bottom;
    }),true,'Done stays visible when scrolled to the last controls');
    await page.locator('#options-panel').screenshot({path:path.join(output,'settings-scrollbar-dark.png')});
    await page.locator('[data-setting="theme"][data-value="light"]').click();
    await page.waitForFunction(()=>document.body.dataset.theme==='light');
    await page.locator('[data-setting="surface"][data-value="bare"]').click();
    await page.waitForFunction(()=>document.body.dataset.surface==='bare');
    await page.locator('[data-toggle="karaoke"]').click();
    await page.waitForFunction(()=>document.querySelectorAll('.word').length===0);
    await page.locator('#options-done').click();
    await page.waitForFunction(h=>Math.abs(innerHeight-h)<3,baseSize.height);
    await page.locator('#stage').hover();await page.locator('#next').click();
    await page.waitForFunction(()=>document.querySelector('.lyric-group[data-distance="0"] .main').textContent.includes('想养一只猫'));
    assert.equal(actions.at(-1).action,'seek');assert.equal(actions.at(-1).positionMs,20000);
    assert.equal(actions.at(-1).session,session);assert.equal(actions.at(-1).trackId,'fixture-track');
    await page.locator('#play').click();await page.waitForFunction(()=>document.body.classList.contains('playing'));
    await page.locator('#play').click();await page.waitForFunction(()=>!document.body.classList.contains('playing'));
    await page.locator('#lock').click();
    await page.waitForFunction(()=>document.body.classList.contains('locked'));
    assert.equal((await command('status')).locked,true);
    await assertBorderless('locked');
    await command('locate');await page.waitForFunction(()=>!document.body.classList.contains('locked'));
    await assertBorderless('unlocked');
    await page.waitForTimeout(600);
    const saved=JSON.parse(fs.readFileSync(path.join(output,'config.json'),'utf8')).profiles[0].lyrics;
    assert.equal(saved.theme,'light');assert.equal(saved.surface,'bare');assert.equal(saved.karaoke,false);
    await page.locator('#stage').hover();await page.locator('#style-open').click();
    await page.locator('[data-setting="layout"][data-value="single"]').click();
    await page.locator('[data-toggle="bilingual"]').click();
    await page.waitForFunction(()=>document.body.dataset.layout==='single'&&document.body.dataset.bilingual==='false');
    await page.locator('#options-done').click();
    await page.waitForFunction(()=>innerHeight<200);
    const singleHeight=await page.evaluate(()=>innerHeight);
    for(let cycle=0;cycle<6;cycle++){
      await page.locator('#stage').hover();await page.locator('#style-open').click();
      await page.waitForFunction(()=>innerHeight>500);
      await assertBorderless('single bare settings expanded '+cycle);
      if(cycle===0)await page.screenshot({path:path.join(output,'single-bare-settings.png')});
      await page.locator('#options-done').click();
      await page.waitForFunction(h=>Math.abs(innerHeight-h)<3,singleHeight);
      await assertBorderless('single bare settings collapsed '+cycle);
    }
    assert.deepEqual(errors,[]);
    await page.screenshot({path:path.join(output,'native.png')});
    verificationPassed=true;
    console.log('Native lyrics checks passed: borderless Win32 frame and style refresh, IPC, stable expansion, persisted appearance, phrase seek, play/pause, lock and tray recovery. Evidence: '+output);
  }finally{
    // Cleanup stays on the WebView connection created by this run. A child that
    // exits at the singleton gate must never send quit to the shared control pipe.
    let quitRequested=false,forced=false;
    if(browser&&child.exitCode===null&&child.signalCode===null){
      try{const page=browser.contexts().flatMap(context=>context.pages())[0];if(page){quitRequested=true;await page.evaluate(()=>window.ipc.postMessage(JSON.stringify({cmd:'quit'})));}}catch{}
    }
    if(browser)await browser.close();
    if(child.exitCode===null&&child.signalCode===null){
      let timer;try{await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(resolve,2000);})]);}finally{clearTimeout(timer);}
    }
    if(child.exitCode===null&&child.signalCode===null){forced=true;child.kill();}
    server.close();
    fs.writeFileSync(path.join(output,'cleanup.json'),JSON.stringify({binary,binarySha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),pid:child.pid,verificationPassed,quitRequested,forced,exitCode:child.exitCode,signal:child.signalCode},null,2));
    if(verificationPassed){assert.equal(quitRequested,true,'owned WebView requests normal quit');assert.equal(forced,false,'successful native checks exit without force');assert.equal(child.exitCode,0,'owned component exits normally');}
  }
}
main().catch(e=>{console.error(e);server.close();process.exitCode=1;});
