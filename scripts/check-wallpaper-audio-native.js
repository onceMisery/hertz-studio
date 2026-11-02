// SPDX-License-Identifier: MIT
// Actual WASAPI loopback + ordinary WebView2 host. Uses only an isolated config and a quiet test tone.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn, execFileSync} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const requestManagement = require('./desktop-native-management-client');
const root = path.resolve(__dirname,'..');
const output = path.join(root,'output/playwright/wallpaper-audio-native-'+Date.now());
const configFile = path.join(output,'config.json');
const pipe = '\\\\.\\pipe\\hertz-desktop-control-'+(process.env.USERNAME||'').replace(/[^a-z0-9_-]/gi,'').slice(0,32);
const port = Number(process.env.DESKTOP_CDP_PORT || 19438);
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
const checks = [], errors = [];
let child, browser, settings, desktop, sequence=0;
const stored = ()=>JSON.parse(fs.readFileSync(configFile));
const config = ()=>stored().unboundDomain.wallpaper;
const pages = ()=>browser.contexts().flatMap(context=>context.pages()).filter(page=>!page.isClosed());
async function until(check,label,timeout=20000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) { const value=await check();if(value)return value;await delay(80); }
  throw new Error(label);
}
async function request(value) {
  for(let attempt=0;;attempt++) {
    try {return await requestManagement(pipe,value);}
    catch(error) {if(!['ENOENT','ECONNREFUSED'].includes(error.code)||attempt>=20)throw error;await delay(50);}
  }
}
const status = ()=>request({command:'status'});
const envelope = (command,payload={},expectedRevision)=>({protocol:2,requestId:'audio-'+(++sequence),command,payload,...(expectedRevision==null?{}:{expectedRevision})});
async function formal(command,payload={},expectedRevision) {
  return settings.evaluate(async value=>{
    try{return await hertzWallpaperSettings.requestManagement(value.command,value.payload,value.requestId,value.expectedRevision);}
    catch(error){return error.receipt||{ok:false,error:{code:error.code,message:error.message}};}
  },envelope(command,payload,expectedRevision));
}
async function draft(wallpaper) {
  const created=await formal('wallpaper.draft.create',{kind:'settings'});assert.equal(created.ok,true,JSON.stringify(created));
  const updated=await formal('wallpaper.draft.update',{draftId:created.result.draftId,draftRevision:created.result.draftRevision,operations:[{kind:'replaceWallpaper',wallpaper}]});assert.equal(updated.ok,true,JSON.stringify(updated));
  return {draftId:updated.result.draftId,draftRevision:updated.result.draftRevision};
}
async function applyInput(audioInput) {
  const wallpaper=structuredClone(config());wallpaper.audioInput=audioInput;
  const reference=await draft(wallpaper);
  const applied=await formal('wallpaper.apply',reference,stored().revision);assert.equal(applied.ok,true,JSON.stringify(applied));
  await until(async()=>JSON.stringify(config().audioInput)===JSON.stringify(audioInput),'saved audio input');
  return applied;
}
async function audioPhase(check,label) {return until(async()=>{const state=await status();return check(state.wallpaper.audio,state)?state:null;},label);}
async function tone() {
  await settings.evaluate(()=>{
    const button=document.createElement('button');button.id='native-audio-tone';button.textContent='测试播放声音';
    button.onclick=()=>{
      const context=new AudioContext(),gain=context.createGain(),oscillator=context.createOscillator();
      gain.gain.value=.01;oscillator.frequency.value=440;oscillator.connect(gain);gain.connect(context.destination);
      oscillator.start();oscillator.stop(context.currentTime+30);context.resume();
      window.nativeAudioTone={context,oscillator};oscillator.onended=()=>context.close();button.remove();
    };
    document.body.appendChild(button);
  });
  await settings.locator('#native-audio-tone').click();
}
async function previewReady() {
  await until(async()=>(await status()).wallpaper.previewActive,'preview lease');
  return until(async()=>{const state=await settings.locator('#preview-renderer').evaluate(frame=>frame.contentWindow.hertzWallpaper?.debug()).catch(()=>null);return state?.audioSource==='system'&&state.audioSequence>0?state:null;},'system preview received audio');
}
async function main() {
  assert.equal(process.platform,'win32');
  const existing=execFileSync('powershell.exe',['-NoProfile','-Command','@(Get-Process hertz-desktop -ErrorAction SilentlyContinue).Count'],{encoding:'utf8',windowsHide:true}).trim();
  assert.equal(existing,'0','another native desktop instance owns the control pipe');
  fs.mkdirSync(output,{recursive:true});
  const lyrics={enabled:false,locked:false,layout:'double',secondary:'next',fontFamily:'Segoe UI',fontSize:32,fontWeight:600,sungColor:'#ffffff',unsungColor:'#ffffff',outlineColor:'#000000',outlineWidth:1,opacity:1,width:550,anchorX:.5,anchorY:.5,monitor:null};
  fs.writeFileSync(configFile,JSON.stringify({schemaVersion:4,revision:1,launchAtLogin:false,activeProfile:null,profiles:[],unboundDomain:{lyrics,wallpaper:{enabled:true,fps:15,musicResponse:false,monitor:null,source:'fixed',scene:'coast'}},lastCommit:null}));
  child=spawn(path.join(root,'target/debug/hertz-desktop.exe'),['--settings'],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,HERTZ_DESKTOP_CONFIG_DIR:output,WEBVIEW2_USER_DATA_FOLDER:path.join(output,'webview2'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port}});
  await until(async()=>{if(child.exitCode!==null)throw new Error('owned host exited '+child.exitCode);try{return(await fetch('http://127.0.0.1:'+port+'/json/version')).ok;}catch{return false;}},'CDP startup');
  browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);
  settings=await until(()=>pages().find(page=>page.url().includes('/settings.html')),'settings page');
  await settings.waitForSelector('#enabled:enabled');settings.on('pageerror',error=>errors.push(error.message));
  desktop=await until(()=>pages().find(page=>page.url().includes('/wallpaper.html')),'desktop page');
  desktop.on('pageerror',error=>errors.push(error.message));
  let state=await until(async()=>{const state=await status();return state.wallpaper.visible&&state.wallpaper.firstFrameReady&&state.wallpaper.audio.endpoints.length?state:null;},'native builtin and render endpoints');
  assert.equal(state.wallpaper.audio.captureActive,false);assert.equal(state.wallpaper.audio.requested,null);
  const defaultEndpoint=state.wallpaper.audio.endpoints.find(endpoint=>endpoint.isDefault);assert.ok(defaultEndpoint,'hardware must have a default render endpoint');
  checks.push({case:'no-system-consumer-no-capture',audio:state.wallpaper.audio});
  const beforeDraft=fs.readFileSync(configFile,'utf8');
  await settings.locator('#music').selectOption('system');
  assert.equal(fs.readFileSync(configFile,'utf8'),beforeDraft);
  assert.equal((await status()).wallpaper.audio.captureActive,false,'draft alone never allocates loopback');
  await tone();
  await settings.locator('#preview').click();
  await previewReady();
  state=await audioPhase(audio=>audio.phase==='running'&&audio.previewConsumer&&!audio.desktopConsumer&&audio.peak>0,'real preview loopback spectrum');
  assert.equal(state.wallpaper.audio.info.deviceId,defaultEndpoint.id);
  assert.ok(state.wallpaper.audio.info.sampleRate>0);
  const generation=state.wallpaper.audio.generation;
  const previewState=await settings.locator('#preview-renderer').evaluate(frame=>frame.contentWindow.hertzWallpaper.debug());
  assert.equal(previewState.positionMs,0);assert.equal(previewState.playing,false,'system audio never forges player state');assert.ok(previewState.feedPeak>0);
  checks.push({case:'preview-system-loopback-real-tone',audio:state.wallpaper.audio,renderer:previewState});
  await settings.screenshot({path:path.join(output,'system-preview.png')});
  const revision=stored().revision;await settings.locator('#apply').click();
  await until(()=>stored().revision>revision&&config().audioInput.kind==='system','UI formally applied system input');
  state=await audioPhase(audio=>audio.desktopConsumer&&!audio.previewConsumer&&audio.phase==='running','applied desktop audio');
  assert.equal(state.wallpaper.previewActive,false);assert.equal(state.wallpaper.audio.generation,generation,'preview to desktop reuses the live endpoint');
  await desktop.waitForFunction(()=>hertzWallpaper.debug().audioSource==='system'&&hertzWallpaper.debug().feedPeak>0);
  checks.push({case:'preview-to-desktop-reuses-owner',audio:state.wallpaper.audio});
  await settings.locator('#preview').click();await previewReady();
  state=await audioPhase(audio=>audio.desktopConsumer&&audio.previewConsumer&&audio.phase==='running','desktop and preview share capture');
  assert.equal(state.wallpaper.audio.generation,generation);
  checks.push({case:'desktop-and-preview-share-one-generation',audio:state.wallpaper.audio});
  await settings.locator('#music').scrollIntoViewIfNeeded();await settings.screenshot({path:path.join(output,'system-audio.png')});
  await request({command:'wallpaper-hide'});
  state=await audioPhase(audio=>!audio.desktopConsumer&&audio.previewConsumer,'desktop-only pause leaves preview audio');
  assert.equal(state.wallpaper.audio.generation,generation);assert.equal(state.wallpaper.audio.captureActive,true);
  checks.push({case:'desktop-pause-preserves-preview',audio:state.wallpaper.audio});
  const releaseStarted=Date.now();await settings.locator('#preview').click();
  state=await audioPhase(audio=>audio.requested===null&&!audio.captureActive,'last consumer closed native capture');
  assert.equal(state.wallpaper.audio.info,null);assert.equal(state.wallpaper.audio.sequence,null);
  checks.push({case:'last-consumer-stops-and-joins',elapsedMs:Date.now()-releaseStarted,audio:state.wallpaper.audio});
  await request({command:'wallpaper-show'});
  state=await audioPhase(audio=>audio.captureActive&&audio.desktopConsumer&&audio.info,'resumed desktop opens capture');
  assert.ok(state.wallpaper.audio.generation>generation);const resumed=state.wallpaper.audio.generation;
  const previousSettings=settings;
  await settings.evaluate(()=>ipc.postMessage(JSON.stringify({cmd:'close'})));
  state=await until(async()=>{const state=await status();return !state.wallpaper.settingsOpen?state:null;},'settings close');
  assert.equal(state.wallpaper.audio.captureActive,true);assert.equal(state.wallpaper.audio.generation,resumed,'settings close preserves desktop audio');
  checks.push({case:'settings-close-preserves-desktop-owner',audio:state.wallpaper.audio});
  await request({command:'wallpaper-settings'});
  settings=await until(()=>pages().find(page=>page!==previousSettings&&page.url().includes('/settings.html')),'reopened settings');
  await settings.waitForSelector('#enabled:enabled');settings.on('pageerror',error=>errors.push(error.message));
  await tone();
  const missing={kind:'system',device:{kind:'fixed',id:'hertz-test-missing-render-endpoint'},gain:1,attackMs:40,releaseMs:250};
  let reference=await draft({...config(),audioInput:missing});
  const conflict=await formal('wallpaper.preview.acquire',reference);assert.equal(conflict.ok,false);assert.equal(conflict.error.code,'audio_busy');
  assert.equal((await status()).wallpaper.audio.generation,resumed);assert.equal(config().audioInput.device.kind,'default');
  await formal('wallpaper.draft.discard',reference);
  checks.push({case:'conflicting-preview-cannot-switch-desktop',error:conflict.error});
  const fixed={kind:'system',device:{kind:'fixed',id:defaultEndpoint.id},gain:1,attackMs:40,releaseMs:250};
  reference=await draft({...config(),audioInput:fixed});
  const shared=await formal('wallpaper.preview.acquire',reference);assert.equal(shared.ok,true,JSON.stringify(shared));
  await previewReady();state=await audioPhase(audio=>audio.desktopConsumer&&audio.previewConsumer,'fixed alias shares actual default endpoint');
  assert.equal(state.wallpaper.audio.generation,resumed);
  await formal('wallpaper.preview.release',{leaseId:shared.result.leaseId});await formal('wallpaper.draft.discard',reference);
  checks.push({case:'fixed-alias-and-default-share-endpoint',audio:state.wallpaper.audio});
  await applyInput(missing);
  state=await audioPhase(audio=>audio.phase==='failed'&&!audio.captureActive,'missing fixed endpoint fails without fallback');
  assert.deepEqual(state.wallpaper.audio.requested,missing.device);assert.equal(state.wallpaper.audio.info,null);assert.equal(state.wallpaper.visible,true);assert.equal(state.wallpaper.applyError,null);
  await desktop.waitForFunction(()=>hertzWallpaper.debug().feedPeak===0);
  const failedGeneration=state.wallpaper.audio.generation;await delay(700);assert.equal((await status()).wallpaper.audio.generation,failedGeneration);
  await settings.locator('#audio-retry').waitFor({state:'visible'});await settings.locator('#audio-retry').click();
  state=await audioPhase(audio=>audio.generation>failedGeneration&&audio.phase==='failed'&&!audio.captureActive,'explicit missing endpoint retry');
  assert.equal(config().audioInput.device.id,missing.device.id);assert.equal(await settings.locator('#audio-device').inputValue(),missing.device.id);
  checks.push({case:'fixed-endpoint-failure-and-explicit-retry',audio:state.wallpaper.audio});
  await applyInput(fixed);
  state=await audioPhase(audio=>audio.captureActive&&audio.info?.deviceId===defaultEndpoint.id,'real fixed endpoint capture');
  checks.push({case:'fixed-endpoint-opens-exact-id',audio:state.wallpaper.audio});
  await applyInput({kind:'hertz',gain:1,attackMs:40,releaseMs:250});
  state=await audioPhase(audio=>audio.requested===null&&!audio.captureActive,'Hertz releases system loopback');
  await desktop.waitForFunction(()=>hertzWallpaper.debug().audioSource==='hertz'&&hertzWallpaper.debug().feedPeak===0);
  checks.push({case:'Hertz-switch-clears-system-spectrum',audio:state.wallpaper.audio});
  await applyInput({kind:'none'});await desktop.waitForFunction(()=>hertzWallpaper.debug().audioSource==='none'&&hertzWallpaper.debug().feedPeak===0);
  assert.equal((await status()).wallpaper.audio.captureActive,false);
  checks.push({case:'none-keeps-native-capture-stopped'});
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'audio-report.json'),JSON.stringify({checks,errors,limitations:['Only the current default physical render endpoint was exercised. Device removal/default-switch/format-change ordering also has deterministic fake-backend coverage; no OS default or volume setting was changed.']},null,2));
  console.log('native system audio checks passed: '+checks.length+' groups\n'+output);
}
main().catch(async error=>{
  console.error(error);
  const diagnostic={status:await status().catch(()=>null),desktop:await desktop?.evaluate(()=>window.hertzWallpaper?.debug()).catch(()=>null),preview:await settings?.locator('#preview-renderer').evaluate(frame=>frame.contentWindow.hertzWallpaper?.debug()).catch(()=>null)};
  if(fs.existsSync(output))fs.writeFileSync(path.join(output,'audio-failure.json'),JSON.stringify({error:error.stack,checks,errors,diagnostic},null,2));process.exitCode=1;
}).finally(async()=>{
  if(settings&&!settings.isClosed())await settings.evaluate(()=>window.nativeAudioTone?.context.close()).catch(()=>{});
  if(child&&child.exitCode===null){child.kill();await until(()=>child.exitCode!==null||child.signalCode!==null,'owned host exit',5000).catch(()=>{});}
  if(browser)await browser.close().catch(()=>{});
});
