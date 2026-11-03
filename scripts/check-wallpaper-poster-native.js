// SPDX-License-Identifier: MIT
// Ordinary WebView2: bounded static poster reads, corruption, preparation and restart.
// Input is a presentation --seed fixture; all mutations happen in a private copy.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn, execFileSync} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const requestManagement = require('./desktop-native-management-client');
const root = path.resolve(__dirname,'..');
const output = path.join(root,'output/playwright/wallpaper-poster-native-'+Date.now());
const binary = path.join(root,'target/debug/hertz-desktop.exe');
const pipe = '\\\\.\\pipe\\hertz-desktop-control-'+(process.env.USERNAME||'').replace(/[^a-z0-9_-]/gi,'').slice(0,32);
const port = Number(process.env.DESKTOP_CDP_PORT || 19438);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
const checks = [], errors = [];
let child, browser, settings, fixture, sequence=0, launches=0;
const pages = ()=>browser.contexts().flatMap(context=>context.pages()).filter(page=>!page.isClosed());
async function until(check,label,timeout=30000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) {const result=await check();if(result)return result;await delay(80);}
  throw new Error(label);
}
async function formal(command,payload={}) {
  const request={protocol:2,requestId:'poster-'+(++sequence),command,payload};
  return nativeRequest(request);
}
async function nativeRequest(request) {
  const deadline=Date.now()+5000;
  for(;;) {
    try{return await requestManagement(pipe,request);}catch(error){
      // Only these connect failures prove no request bytes were sent; never replay a sent mutation.
      if(!['ENOENT','ECONNREFUSED'].includes(error.code)||Date.now()>=deadline)throw error;
      await delay(60);
    }
  }
}
const resources=async()=>{const result=await formal('wallpaper.status');assert.equal(result.ok,true,JSON.stringify(result));return result.result;};
async function poster(reference=fixture.video) {
  const response=await until(async()=>{
    const reply=await formal('wallpaper.library.poster',reference);
    return reply.error?.code==='budget_busy'?null:reply;
  },'bounded poster reader available');
  assert.equal(response.ok,true,JSON.stringify(response));
  assert.ok(Buffer.byteLength(JSON.stringify(response))<65536);
  return response.result.poster;
}
const status=()=>nativeRequest({command:'status'});
async function wallpaperPage(kind) {
  return until(async()=>{
    for(const page of pages().filter(page=>page.url().includes('/wallpaper.html'))) {
      try {if(await page.locator('[data-wallpaper-media="'+kind+'"]').count())return page;}catch{}
    }
    return null;
  }, 'wallpaper '+kind+' page');
}
async function playing() {
  return until(async()=>{
    const state=(await status()).wallpaper;
    return state.visible&&state.firstFrameReady&&!state.staticPoster&&state.media?.kind==='video'&&!state.applyError ? state : null;
  },'video playing');
}
async function staticPoster() {
  return until(async()=>{
    const state=(await status()).wallpaper;
    return state.visible&&state.firstFrameReady&&state.staticPoster&&state.retiringControllers===0 ? state : null;
  },'static poster presented after decoder exit');
}
async function verifyPauseDeadline(saved) {
  const live=await playing(), page=await wallpaperPage('video');
  await nativeRequest({command:'wallpaper-hide'});
  const confirmed=await until(async()=>{
    const state=(await status()).wallpaper;
    return state.mediaPauseConfirmed===true?state:null;
  },'normal video pause confirmed',4000);
  assert.equal(confirmed.session.binding.sessionId,live.session.binding.sessionId);
  assert.equal((await resources()).decoderSlots,1,'short pause retains its decoder');
  const clock=await page.evaluate(()=>document.querySelector('video').currentTime);
  await delay(300);
  assert.equal(await page.evaluate(()=>document.querySelector('video').currentTime),clock);
  await nativeRequest({command:'wallpaper-show'});
  const resumed=await playing();
  assert.equal(resumed.session.binding.sessionId,live.session.binding.sessionId);
  assert.equal(resumed.mediaPauseConfirmed,null);
  checks.push({case:'normal-pause-confirms-frozen-clock-keeps-decoder-and-resumes-same-session',state:confirmed});

  for(const mode of ['pause-ignored','receipt-missing']) {
    const videoPage=await wallpaperPage('video'), before=await playing();
    await videoPage.evaluate(mode=>{
      if(mode==='pause-ignored')document.querySelector('video').pause=()=>{};
      else {
        const stop=window.hertzWallpaper.stop;
        window.hertzWallpaper.stop=()=>stop();
      }
    },mode);
    const requestedAt=performance.now();
    await nativeRequest({command:'wallpaper-hide'});
    const pending=(await status()).wallpaper;
    assert.equal(pending.session.binding.sessionId,before.session.binding.sessionId);
    assert.equal(pending.mediaPauseConfirmed,false);
    assert.equal((await resources()).decoderSlots,1,'pending pause proof is not physical decoder exit');
    const media=await videoPage.evaluate(()=>({paused:document.querySelector('video').paused,time:document.querySelector('video').currentTime}));
    assert.equal(media.paused,mode==='receipt-missing');
    if(mode==='pause-ignored') {
      await delay(250);
      const stillPlaying=await videoPage.evaluate(()=>document.querySelector('video').currentTime);
      assert.ok(Math.abs(stillPlaying-media.time)>.02,'injected pause failure actually advances video');
    }
    let reportedMs=null;
    const closed=await until(async()=>{
      const state=(await status()).wallpaper;
      const failed=state.applyError?.includes('media_pause_unconfirmed');
      if(failed&&reportedMs===null)reportedMs=performance.now()-requestedAt;
      return failed&&!state.session&&state.retiringControllers===0?state:null;
    },mode+' forces controller exit',6000);
    const elapsedMs=performance.now()-requestedAt;
    // Polling and asynchronous controller Close may finish after the 2-second decision.
    assert.ok(elapsedMs>=1700&&elapsedMs<5000,'bounded pause deadline and native close: '+elapsedMs);
    assert.equal(videoPage.isClosed(),true);
    const drained=await resources();
    assert.equal(drained.decoderSlots,0);assert.equal(drained.prepareTasks,0);
    assert.equal(hash(fs.readFileSync(path.join(output,'config.json'))),saved);
    await nativeRequest({command:'wallpaper-show'});
    const cover=await staticPoster();
    assert.match(cover.applyError,/media_pause_unconfirmed/);
    assert.equal((await resources()).decoderSlots,0);
    checks.push({case:mode+'-forces-video-exit-and-preserves-choice-for-static-cover',reportedMs,elapsedMs,state:closed,resources:drained});
    await nativeRequest({command:'wallpaper-retry'});await playing();
  }
}
async function verifyCandidatePause() {
  await settings.locator('#enabled').uncheck();await settings.locator('#apply').click();
  await until(async()=>{
    const state=(await status()).wallpaper;
    return !state.enabled&&!state.session&&state.retiringControllers===0;
  },'disable before candidate pause');
  await settings.context().addInitScript(()=>{
    const request=HTMLVideoElement.prototype.requestVideoFrameCallback;
    HTMLVideoElement.prototype.requestVideoFrameCallback=function(callback) {
      return location.pathname==='/wallpaper.html'&&localStorage.getItem('pause-before-frame')==='1'
        ? 0 : request.call(this,callback);
    };
  });
  await settings.evaluate(()=>localStorage.setItem('pause-before-frame','1'));
  await settings.locator('#enabled').check();await settings.locator('#apply').click();
  await until(async()=>(await status()).wallpaper.candidateLoading,'candidate created');
  const page=await wallpaperPage('video');
  await page.waitForFunction(()=>document.querySelector('video').currentTime>.1,null,{polling:50});
  assert.equal(await page.evaluate(()=>window.hertzWallpaper.debug().media.state),'loading');
  assert.equal((await resources()).decoderSlots,1,'candidate is really decoding before its frame receipt');
  const saved=hash(fs.readFileSync(path.join(output,'config.json'))), requestedAt=performance.now();
  await nativeRequest({command:'wallpaper-hide'});
  const closed=await until(async()=>{
    const state=(await status()).wallpaper;
    return !state.candidateLoading&&!state.session&&state.retiringControllers===0?state:null;
  },'pause closes the unpublished video candidate',4000);
  const elapsedMs=performance.now()-requestedAt;
  assert.equal(page.isClosed(),true);assert.equal(closed.applyError,null);
  assert.equal((await resources()).decoderSlots,0);
  await delay(1200);
  assert.equal((await status()).wallpaper.candidateLoading,false,'hidden candidate is not recreated');
  await settings.evaluate(()=>localStorage.removeItem('pause-before-frame'));
  await nativeRequest({command:'wallpaper-show'});const recovered=await playing();
  assert.equal(hash(fs.readFileSync(path.join(output,'config.json'))),saved);
  checks.push({case:'pause-before-first-frame-closes-candidate-and-requalifies-on-resume',elapsedMs,state:closed,resumed:recovered});
}
async function start() {
  const currentPort=port+launches++;
  child=spawn(binary,['--settings'],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,HERTZ_DESKTOP_CONFIG_DIR:output,WEBVIEW2_USER_DATA_FOLDER:path.join(output,'webview2'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+currentPort}});
  await until(async()=>{if(child.exitCode!==null)throw new Error('owned host exited');try{return(await fetch('http://127.0.0.1:'+currentPort+'/json/version')).ok;}catch{return false;}},'CDP startup');
  browser=await chromium.connectOverCDP('http://127.0.0.1:'+currentPort);
  settings=await until(()=>pages().find(page=>page.url().includes('/settings.html')),'settings page');
  settings.on('pageerror',error=>errors.push(error.message));
  await settings.waitForSelector('#enabled:enabled');
}
async function stop() {
  if(child&&child.exitCode===null){child.kill();await until(()=>child.exitCode!==null||child.signalCode!==null,'owned host exit',5000);}
  if(browser)await browser.close().catch(()=>{});
  child=browser=settings=null;
}
function receipts() {
  const found=[];
  function walk(directory) {
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
      const file=path.join(directory,entry.name);
      if(entry.isDirectory())walk(file);
      else if(entry.name==='receipt.json') {const receipt=JSON.parse(fs.readFileSync(file));if(receipt.pipeline==='video-poster-v1')found.push({file,...receipt});}
    }
  }
  walk(path.join(output,'derived'));return found;
}
function seed() {
  const source=path.resolve(process.argv[2]||'');
  assert.ok(source.startsWith(path.join(root,'output')+path.sep),'use an existing test fixture');
  fixture=JSON.parse(fs.readFileSync(path.join(source,'fixture.json')));
  fs.mkdirSync(output,{recursive:true});
  for(const name of ['packages','derived'])fs.cpSync(path.join(source,name),path.join(output,name),{recursive:true});
  execFileSync(process.env.PYTHON||'python',['-c','import sqlite3,sys; src=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); dst=sqlite3.connect(sys.argv[2]); src.backup(dst); dst.close(); src.close()',path.join(source,'wallpaper.db'),path.join(output,'wallpaper.db')],{windowsHide:true});
  const config=JSON.parse(fs.readFileSync(path.join(source,'config.json')));
  config.activeProfile=null;config.profiles=[];config.launchAtLogin=false;
  config.unboundDomain.lyrics.enabled=false;
  config.unboundDomain.mini={...(config.unboundDomain.mini||{}),reopen:false};
  config.unboundDomain.wallpaper.enabled=false;
  config.unboundDomain.wallpaper.audioInput={kind:'none'};
  fs.writeFileSync(path.join(output,'config.json'),JSON.stringify(config));
  fs.writeFileSync(path.join(output,'fixture-origin.json'),JSON.stringify({source,fixture},null,2));
}
async function startupRecovery() {
  const packageDir=path.join(output,'packages',fixture.video.packageHash);
  const heldDir=path.join(output,'held-video-package');
  for(const item of [packageDir,heldDir]) assert.ok(path.resolve(item).startsWith(path.resolve(output)+path.sep));
  const originalFile=path.join(packageDir,'original.hwpkg'), original=fs.readFileSync(originalFile);
  const configFile=path.join(output,'config.json'), saved=hash(fs.readFileSync(configFile));
  await stop();
  fs.renameSync(packageDir,heldDir);
  try {
    await start();
    const missing=await staticPoster();
    assert.match(missing.applyError,/asset_unavailable/);
    assert.equal((await resources()).decoderSlots,0);assert.equal((await resources()).prepareTasks,0);
    assert.equal(hash(fs.readFileSync(configFile)),saved);
    assert.ok(await poster(),'known unavailable version still has a cached cover');
    const detail=await formal('wallpaper.library.get',{workKey:fixture.video.workKey});
    assert.equal(detail.result.versions[0].state,'unavailable');
    await settings.locator('#local-library > summary').click();
    const row=settings.locator('#library-works > li').filter({has:settings.getByText('Presentation video',{exact:true})});
    await row.getByRole('button',{name:'查看版本',exact:true}).click();
    await row.locator('.library-poster').scrollIntoViewIfNeeded();await row.locator('.library-poster img').waitFor();
    assert.equal(await row.getByRole('button',{name:'选择此版本',exact:true}).count(),0,'cover never enables selection of unavailable bytes');
    await (await wallpaperPage('image')).screenshot({path:path.join(output,'missing-package-poster.png')});
    checks.push({case:'cold-start-missing-package-keeps-selection-and-shows-verified-cover',state:missing,resources:await resources()});
    await nativeRequest({command:'wallpaper-retry'});
    await until(async()=>{const state=(await status()).wallpaper;return !state.selectionPreparing&&!state.candidateLoading&&state.applyError;},'missing retry finishes');
    assert.equal((await status()).wallpaper.session.binding.sessionId,missing.session.binding.sessionId);
    assert.equal((await resources()).decoderSlots,0);
    checks.push({case:'retry-with-missing-bytes-retains-static-session'});
    fs.renameSync(heldDir,packageDir);
    await nativeRequest({command:'wallpaper-retry'});const repaired=await playing();
    assert.equal(hash(fs.readFileSync(configFile)),saved);
    assert.equal((await formal('wallpaper.library.get',{workKey:fixture.video.workKey})).result.versions[0].state,'installed');
    checks.push({case:'restored-package-retries-in-place-and-becomes-installed',state:repaired});
  } finally {
    if(fs.existsSync(heldDir)) {await stop();fs.renameSync(heldDir,packageDir);}
  }
  await stop();
  fs.writeFileSync(originalFile,Buffer.from('damaged original archive'));
  try {
    await start();const damaged=await staticPoster();
    assert.match(damaged.applyError,/asset_unavailable/);assert.equal((await resources()).decoderSlots,0);
    assert.equal(hash(fs.readFileSync(configFile)),saved);
    checks.push({case:'cold-start-corrupt-package-shows-cache-without-trusting-video',state:damaged});
    fs.writeFileSync(originalFile,original);
    await nativeRequest({command:'wallpaper-retry'});await playing();
  } finally {if(hash(fs.readFileSync(originalFile))!==hash(original)){await stop();fs.writeFileSync(originalFile,original);}}
  // Saved-selection retry with a genuine probe play rejection, after the old decoder exits.
  await (await wallpaperPage('video')).evaluate(()=>document.querySelector('video').dispatchEvent(new Event('error')));
  await staticPoster();
  await (await wallpaperPage('image')).evaluate(()=>document.querySelector('img[data-wallpaper-media]').dispatchEvent(new Event('error')));
  await until(async()=>{const state=(await status()).wallpaper;return !state.session&&!state.candidateLoading&&state.retiringControllers===0;},'no presentation before prepare failure');
  execFileSync(process.env.PYTHON||'python',['-c','import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("DELETE FROM media_qualifications"); db.commit(); db.close()',path.join(output,'wallpaper.db')],{windowsHide:true});
  await settings.context().addInitScript(()=>{
    const play=HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play=function(){return location.pathname==='/wallpaper-probe.html'&&localStorage.getItem('poster-reject-probe')==='1'?Promise.reject(new DOMException('probe play rejected','NotAllowedError')):play.call(this);};
  });
  await settings.evaluate(()=>localStorage.setItem('poster-reject-probe','1'));
  await nativeRequest({command:'wallpaper-retry'});const refused=await staticPoster();
  assert.match(refused.applyError,/prepare_failed/);
  assert.equal((await resources()).decoderSlots,0);assert.equal((await resources()).prepareTasks,0);
  assert.equal(hash(fs.readFileSync(configFile)),saved);
  checks.push({case:'preparation-failure-remains-an-error-with-static-cover',state:refused,resources:await resources()});
  // A new Apply is still rejected even when a poster is available.
  await settings.locator('#media-fit').selectOption('contain');await settings.locator('#apply').click();
  await settings.waitForFunction(()=>document.getElementById('apply').disabled===false&&document.body.textContent.includes('prepare_failed'));
  assert.equal(hash(fs.readFileSync(configFile)),saved,'failed preflight must not save a new selection');
  assert.equal((await status()).wallpaper.session.binding.sessionId,refused.session.binding.sessionId);
  checks.push({case:'available-cover-cannot-turn-failed-apply-into-success'});
  await settings.locator('#discard').click();
  await settings.evaluate(()=>localStorage.removeItem('poster-reject-probe'));
  await nativeRequest({command:'wallpaper-retry'});await playing();
  // With neither usable original nor valid cover, keep the error and system wallpaper.
  await stop();fs.renameSync(packageDir,heldDir);
  const receipt=receipts()[0], coverFile=path.join(path.dirname(receipt.file),'poster.jpg');
  const coverBytes=fs.readFileSync(coverFile);fs.writeFileSync(coverFile,Buffer.from('damaged cover'));
  try {
    await start();
    await until(async()=>{const state=(await status()).wallpaper;return state.applyError&&!state.selectionPreparing&&!state.candidateLoading&&!state.session;},'both original and cover unavailable');
    assert.equal(await poster(),null);assert.equal((await resources()).decoderSlots,0);
    assert.equal(hash(fs.readFileSync(configFile)),saved);
    await delay(650);
    const terminal=(await status()).wallpaper;assert.equal(terminal.session,null);assert.equal(terminal.selectionPreparing,false);
    checks.push({case:'missing-original-and-corrupt-cover-do-not-loop',state:terminal});
  } finally {await stop();fs.writeFileSync(coverFile,coverBytes);fs.renameSync(heldDir,packageDir);}
  await start();await playing();
}
async function run() {
  seed();await start();
  const original=hash(fs.readFileSync(path.join(output,'packages',fixture.video.packageHash,'original.hwpkg')));
  const first=await poster();assert.ok(first,'seed import generated a cover');
  assert.deepEqual([first.width,first.height],[64,48]);assert.ok(Buffer.from(first.data,'base64').length<=24576);
  assert.equal(await poster(fixture.image),null);
  const foreign=await formal('wallpaper.library.poster',{workKey:fixture.image.workKey,packageHash:fixture.video.packageHash});
  assert.equal(foreign.error.code,'version_not_found');
  assert.equal((await formal('wallpaper.library.poster',{...fixture.video,path:'C:/secret'})).error.code,'invalid_input');
  const idle=await resources();assert.equal(idle.decoderSlots,0);assert.equal(idle.prepareTasks,0);
  checks.push({case:'bounded-static-read-and-version-ownership',width:first.width,height:first.height,bytes:Buffer.from(first.data,'base64').length,resources:idle});
  const originalFile=path.join(output,'packages',fixture.video.packageHash,'original.hwpkg'), held=originalFile+'.held';
  assert.ok(path.resolve(originalFile).startsWith(path.resolve(output)+path.sep));
  assert.ok(path.resolve(held).startsWith(path.resolve(output)+path.sep));
  fs.renameSync(originalFile,held);
  try{assert.deepEqual(await poster(),first,'static cover reads must not reopen or hash the video archive');}finally{fs.renameSync(held,originalFile);}
  checks.push({case:'cover-read-does-not-touch-source-video'});
  await settings.locator('#local-library > summary').click();
  const row=settings.locator('#library-works > li').filter({has:settings.getByText('Presentation video',{exact:true})});
  await row.getByRole('button',{name:'查看版本',exact:true}).click();
  await row.locator('.library-poster img').waitFor();
  await row.getByRole('button',{name:'选择此版本',exact:true}).click();
  await settings.waitForFunction(()=>document.querySelector('#scene-static').naturalWidth===64 && !document.querySelector('#scene-static').hidden);
  await settings.locator('#scene-heading').scrollIntoViewIfNeeded();
  await settings.screenshot({path:path.join(output,'selected-video-poster.png')});
  assert.equal((await resources()).decoderSlots,0);
  assert.equal(await settings.locator('video,#preview-renderer').count(),0);
  checks.push({case:'library-and-selected-cover-use-no-decoder',resources:await resources()});
  const before=receipts();assert.equal(before.length,1);
  const damaged=path.join(path.dirname(before[0].file),'poster.jpg');
  assert.ok(path.resolve(damaged).startsWith(path.resolve(output)+path.sep));
  fs.writeFileSync(damaged,Buffer.from('corrupted test poster'));
  assert.equal(await poster(),null);
  await settings.evaluate(()=>hertzWallpaperSettings.invalidatePosters());
  await settings.waitForFunction(()=>document.querySelector('#scene-static').hidden && !document.querySelector('#preview-placeholder').hidden);
  assert.equal(await row.locator('.library-poster img').count(),0,'refresh clears the stale library cover too');
  assert.equal((await resources()).decoderSlots,0);
  checks.push({case:'corrupt-cover-is-a-placeholder-without-background-video-work'});
  await settings.locator('#preview').click();
  await until(async()=>{const response=await requestManagement(pipe,{command:'status'});return response.wallpaper.mediaPreview?.firstFrameReady;},'video preview ready');
  const rebuilt=await poster();assert.ok(rebuilt);assert.deepEqual([rebuilt.width,rebuilt.height],[64,48]);
  const after=receipts();assert.equal(after.length,1);assert.notEqual(after[0].file,before[0].file);
  await settings.locator('#preview').click();
  await until(async()=>{const state=await resources();return state.decoderSlots===0&&state.prepareTasks===0;},'preview physical exit');
  await settings.waitForFunction(()=>!document.querySelector('#scene-static').hidden && document.querySelector('#scene-static').naturalWidth===64);
  await row.locator('.library-poster').scrollIntoViewIfNeeded();
  await row.locator('.library-poster img').waitFor();
  assert.equal(hash(fs.readFileSync(path.join(output,'packages',fixture.video.packageHash,'original.hwpkg'))),original);
  checks.push({case:'explicit-preparation-rebuilds-cover-and-preserves-original',generation:after[0].file,resources:await resources()});
  await stop();await start();
  assert.deepEqual(await poster(),rebuilt);
  assert.equal((await resources()).decoderSlots,0);
  checks.push({case:'poster-survives-ordinary-host-restart',resources:await resources()});
  await settings.locator('#local-library > summary').click();
  const restartedRow=settings.locator('#library-works > li').filter({has:settings.getByText('Presentation video',{exact:true})});
  await restartedRow.getByRole('button',{name:'查看版本',exact:true}).click();
  await restartedRow.getByRole('button',{name:'选择此版本',exact:true}).click();
  await settings.locator('#enabled').check();
  await settings.locator('#apply').click();
  const live=await playing(), videoPage=await wallpaperPage('video');
  const oldVideoUrl=await videoPage.locator('video').getAttribute('src');
  const saved=hash(fs.readFileSync(path.join(output,'config.json')));
  await videoPage.evaluate(()=>document.querySelector('video').dispatchEvent(new Event('error')));
  const frozen=await staticPoster(), frozenPage=await wallpaperPage('image');
  assert.equal(videoPage.isClosed(),true,'video controller actually exits before the static controller is ready');
  assert.equal(frozen.media.kind,'image');assert.equal(frozen.session.frameKind,'image');assert.ok(frozen.applyError);
  assert.notEqual(frozen.session.binding.sessionId,live.session.binding.sessionId);
  assert.equal((await resources()).decoderSlots,0);assert.equal((await resources()).prepareTasks,0);
  assert.equal(hash(fs.readFileSync(path.join(output,'config.json'))),saved,'runtime failure does not rewrite the video choice');
  assert.equal(await frozenPage.locator('video,canvas').count(),0);
  const oldVideoAccess=await frozenPage.evaluate(url=>fetch(url).then(response=>response.status).catch(()=>0),oldVideoUrl);
  assert.ok([0,403,404].includes(oldVideoAccess),'poster controller cannot reuse the old video file scope');
  await frozenPage.waitForFunction(()=>document.querySelector('img[data-wallpaper-media]').naturalWidth===64);
  await frozenPage.screenshot({path:path.join(output,'desktop-failure-poster.png')});
  await settings.waitForFunction(()=>document.getElementById('wallpaper-state').textContent.includes('显示静态封面'));
  assert.equal(await settings.locator('#wallpaper-retry').isVisible(),true);
  checks.push({case:'runtime-video-error-shows-image-after-decoder-exit-without-saving',state:frozen,resources:await resources()});
  if(process.env.WALLPAPER_LONG_PAUSE==='1') {
    const pausedAt=Date.now();
    await nativeRequest({command:'wallpaper-hide'});
    await until(async()=>{
      const state=(await status()).wallpaper;
      return state.hidden&&!state.session&&state.retiringControllers===0;
    },'real five-minute poster unload',330000);
    const pausedMs=Date.now()-pausedAt;
    assert.ok(pausedMs>=299500,'exercise the real five-minute timeout');
    assert.equal(frozenPage.isClosed(),true);assert.equal((await resources()).decoderSlots,0);
    await nativeRequest({command:'wallpaper-show'});
    const resumedPoster=await staticPoster();
    assert.notEqual(resumedPoster.session.binding.sessionId,frozen.session.binding.sessionId);
    assert.ok(resumedPoster.applyError);assert.equal((await resources()).decoderSlots,0);
    assert.equal(hash(fs.readFileSync(path.join(output,'config.json'))),saved);
    checks.push({case:'real-five-minute-poster-unload-and-static-resume',pausedMs,state:resumedPoster,resources:await resources()});
  }
  await nativeRequest({command:'wallpaper-retry'});
  const recovered=await playing();
  assert.notEqual(recovered.session.binding.sessionId,frozen.session.binding.sessionId);
  await until(()=>frozenPage.isClosed(),'old poster controller exits after retry');
  assert.equal(hash(fs.readFileSync(path.join(output,'config.json'))),saved);
  checks.push({case:'explicit-retry-replaces-poster-with-video',state:recovered,resources:await resources()});
  await verifyPauseDeadline(saved);
  await nativeRequest({command:'wallpaper-hide'});
  const pausedPage=await wallpaperPage('video');
  await pausedPage.waitForFunction(()=>document.querySelector('video').paused);
  await pausedPage.evaluate(()=>{document.querySelector('video').play=()=>Promise.reject(new DOMException('injected resume rejection','NotAllowedError'));});
  await nativeRequest({command:'wallpaper-show'});
  const resumeRejected=await staticPoster();
  assert.match(resumeRejected.applyError,/media_play_rejected/);assert.equal((await resources()).decoderSlots,0);
  assert.equal(hash(fs.readFileSync(path.join(output,'config.json'))),saved);
  checks.push({case:'rejected-resume-enters-poster-state',state:resumeRejected,resources:await resources()});
  await nativeRequest({command:'wallpaper-retry'});await playing();
  // Reject actual play only in presentation controllers, leaving the qualification probe intact.
  await settings.context().addInitScript(()=>{
    const play=HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play=function(){
      return location.pathname==='/wallpaper.html'&&localStorage.getItem('poster-reject-play')==='1'
        ? Promise.reject(new DOMException('injected play rejection','NotAllowedError')) : play.call(this);
    };
  });
  await settings.locator('#enabled').uncheck();await settings.locator('#apply').click();
  await until(async()=>{const state=(await status()).wallpaper;return !state.enabled&&!state.session&&state.retiringControllers===0;},'disable before first-frame failure');
  await settings.evaluate(()=>localStorage.setItem('poster-reject-play','1'));
  await settings.locator('#enabled').check();await settings.locator('#apply').click();
  const rejected=await staticPoster();
  const startupSaved=hash(fs.readFileSync(path.join(output,'config.json')));
  assert.match(rejected.applyError,/media_play_rejected/);assert.equal((await resources()).decoderSlots,0);
  assert.equal(hash(fs.readFileSync(path.join(output,'config.json'))),startupSaved);
  checks.push({case:'first-frame-play-rejection-shows-poster-with-no-prior-desktop',state:rejected,resources:await resources()});
  const brokenPoster=await wallpaperPage('image');
  await brokenPoster.evaluate(()=>document.querySelector('img[data-wallpaper-media]').dispatchEvent(new Event('error')));
  await until(async()=>{const state=(await status()).wallpaper;return !state.session&&!state.candidateLoading&&state.retiringControllers===0;},'failed poster returns to system desktop');
  await delay(700);
  const terminal=(await status()).wallpaper;
  assert.equal(terminal.session,null);assert.equal(terminal.selectionPreparing,false);assert.equal(terminal.candidateLoading,false);
  assert.equal((await resources()).decoderSlots,0);assert.ok(terminal.applyError);
  assert.equal(hash(fs.readFileSync(path.join(output,'config.json'))),startupSaved);
  checks.push({case:'poster-decode-failure-is-terminal-with-no-fallback-loop',state:terminal,resources:await resources()});
  await settings.evaluate(()=>localStorage.removeItem('poster-reject-play'));
  await nativeRequest({command:'wallpaper-retry'});await playing();
  await startupRecovery();
  await verifyCandidatePause();
  await settings.locator('#enabled').uncheck();await settings.locator('#apply').click();
  await until(async()=>{const state=(await status()).wallpaper;return !state.enabled&&!state.session&&state.retiringControllers===0;},'final disable');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'poster-report.json'),JSON.stringify({ordinaryBuild:true,binarySha256:hash(fs.readFileSync(binary)),checks,errors},null,2));
  console.log('wallpaper poster native checks passed: '+output);
}
(async()=>{
  assert.equal(execFileSync('powershell.exe',['-NoProfile','-Command','@(Get-Process hertz-desktop -ErrorAction SilentlyContinue).Count'],{encoding:'utf8',windowsHide:true}).trim(),'0','protect existing desktop host');
  try{await run();}catch(error){if(fs.existsSync(output))fs.writeFileSync(path.join(output,'poster-failure.json'),JSON.stringify({error:error.stack,checks,errors},null,2));throw error;}finally{await stop();}
})().catch(error=>{console.error(error);process.exitCode=1;});
