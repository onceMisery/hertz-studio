// SPDX-License-Identifier: MIT
// Isolated Windows WebView2 integration: actual IPC, resizing, saved settings, narrow playback.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const {spawn,execFileSync} = require('node:child_process');
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
async function main(){
  assert.equal(execFileSync('powershell.exe',['-NoProfile','-Command','@(Get-Process hertz-desktop -ErrorAction SilentlyContinue).Count'],{encoding:'utf8',windowsHide:true}).trim(),'0','Native checks require no existing desktop instance');
  fs.mkdirSync(profileDir,{recursive:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  fs.writeFileSync(path.join(profileDir,'vmusicd.json'),JSON.stringify({pid:process.pid,port:server.address().port,version:'0.3.0',protocol_version:1,edition:'full',server_instance_id:session,desktop_lyrics_protocol:1}));
  fs.writeFileSync(path.join(profileDir,'desktop-lyrics-key'),key);
  fs.writeFileSync(path.join(output,'config.json'),JSON.stringify({schemaVersion:2,revision:1,launchAtLogin:false,activeProfile:profile,profiles:[{profile,lyrics:{...config,width:550,anchorX:.5,anchorY:.3,monitor:null},wallpaper:{enabled:false,fps:30,musicResponse:true,monitor:null,source:'fixed',scene:'coast'}}]}).replace(',"frameCap":30','').replace(',"panelMaxHeight":360',''));
  const port=Number(process.env.DESKTOP_CDP_PORT||19427);
  const child=spawn(path.join(root,'target/debug/hertz-desktop.exe'),[],{cwd:root,windowsHide:true,env:{...process.env,HERTZ_DESKTOP_CONFIG_DIR:output,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port},stdio:'ignore'});
  let browser;
  try{
    for(let i=0;i<60;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);break;}catch{}if(child.exitCode!==null)throw new Error('Host exited '+child.exitCode);await new Promise(r=>setTimeout(r,200));}
    assert.ok(browser);
    const page=browser.contexts().flatMap(c=>c.pages())[0];
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.waitForSelector('.lyric-group[data-distance="0"] .word');
    assert.equal(await page.evaluate(()=>document.body.dataset.layout),'triple');
    const baseSize=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
    await page.locator('#stage').hover();await page.locator('#style-open').click();
    await page.waitForFunction(()=>innerHeight>500);
    const expanded=await page.evaluate(()=>({stage:document.getElementById('stage').clientHeight,height:innerHeight,panel:document.getElementById('options-panel').getBoundingClientRect().toJSON()}));
    console.log('Native lyrics expanded geometry', JSON.stringify({baseSize,expanded}));
    assert.ok(expanded.panel.bottom<=expanded.height);
    assert.ok(Math.abs(expanded.stage-(baseSize.height-84))<3,'Opening settings preserves lyric height');
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
    await command('locate');await page.waitForFunction(()=>!document.body.classList.contains('locked'));
    await page.waitForTimeout(600);
    const saved=JSON.parse(fs.readFileSync(path.join(output,'config.json'),'utf8')).profiles[0].lyrics;
    assert.equal(saved.theme,'light');assert.equal(saved.surface,'bare');assert.equal(saved.karaoke,false);
    assert.deepEqual(errors,[]);
    await page.screenshot({path:path.join(output,'native.png')});
    console.log('Native lyrics checks passed: IPC, stable expansion, persisted appearance, phrase seek, play/pause, lock and tray recovery. Evidence: '+output);
  }finally{
    try{await command('quit');}catch{}
    if(browser)await browser.close();
    if(child.exitCode===null)child.kill();
    server.close();
  }
}
main().catch(e=>{console.error(e);server.close();process.exitCode=1;});
