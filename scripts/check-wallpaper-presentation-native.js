// SPDX-License-Identifier: MIT
// Native single-media apply and restore. Seed with the explicit debug importer, then run an ordinary build.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { buildZip, FIXTURE_PNG } = require('./check-wallpaper-media-native');
const requestManagement = require('./desktop-native-management-client');
const root = path.resolve(__dirname, '..');
const setup = process.argv[2] === '--seed';
const output = setup ? path.join(root, 'output/playwright/wallpaper-presentation-native-' + Date.now()) : path.resolve(process.argv[2] || '');
const binary = path.join(root, 'target/debug/hertz-desktop.exe');
const pipe = '\\\\.\\pipe\\hertz-desktop-control-' + (process.env.USERNAME || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
const port = Number(process.env.DESKTOP_CDP_PORT || 19438);
const configFile = path.join(output, 'config.json');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stored = () => JSON.parse(fs.readFileSync(configFile));
const domain = config => config.activeProfile ? config.profiles.find(entry => JSON.stringify(entry.profile) === JSON.stringify(config.activeProfile)) : config.unboundDomain;
const checks = [], runId = 'run-'+Date.now()+'-';
let child, browser, settings, sequence = 0;
async function until(check, label, timeout = 20000) {
  const deadline = Date.now()+timeout;
  while(Date.now()<deadline) {const result=await check();if(result)return result;await delay(100);}
  throw new Error(label);
}
function envelope(command,payload={},expectedRevision,requestId='presentation-'+(++sequence)) {return {protocol:2,requestId,command,payload,...(expectedRevision==null?{}:{expectedRevision})};}
// These two errors mean the pipe connection never existed; no operation bytes were sent.
// A connected request, reset or timeout is never replayed by this helper.
async function nativeRequest(request) {
  for(let attempt=0;;attempt++) {
    try { return await requestManagement(pipe,request); }
    catch(error) { if(!['ENOENT','ECONNREFUSED'].includes(error.code)||attempt>=20)throw error;await delay(50); }
  }
}
async function formal(command,payload={},expectedRevision,requestId) {
  const request=command==='status'?{command:'status'}:envelope(command,payload,expectedRevision,requestId);
  return nativeRequest(request);
}
async function inPage(request) {
  return settings.evaluate(async request=>{try{return await window.hertzWallpaperSettings.requestManagement(request.command,request.payload,request.requestId,request.expectedRevision);}catch(error){return error.receipt||{ok:false,error:{code:error.code,message:error.message}};}},request);
}
const pages=()=>browser.contexts().flatMap(context=>context.pages()).filter(page=>!page.isClosed());
async function start() {
  child=spawn(binary,['--settings'],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,HERTZ_DESKTOP_CONFIG_DIR:output,WEBVIEW2_USER_DATA_FOLDER:path.join(output,'webview2'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port}});
  await until(async()=>{if(child.exitCode!==null)throw new Error('owned host exited '+child.exitCode);try{return(await fetch('http://127.0.0.1:'+port+'/json/version')).ok;}catch{return false;}},'CDP startup');
  browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);
  settings=await until(()=>pages().find(page=>page.url().includes('/settings.html')),'settings page');
  await settings.waitForSelector('#enabled:enabled');
}
async function stop() {
  if(child&&child.exitCode===null) {
    // A raw close has no configuration side effects; only this test-owned process is terminated.
    child.kill(); await until(()=>child.exitCode!==null||child.signalCode!==null,'owned host exit',5000);
  }
  if(browser)await browser.close().catch(()=>{});
  browser=null;child=null;settings=null;
}
function packageBytes(kind,bytes,ordinal) {
  const file='assets/background.'+(kind==='image'?'png':'webm');
  const manifest={formatVersion:1,workId:'c17ed10a-5c55-4a52-85dc-'+String(ordinal).padStart(12,'0'),version:1,title:'Presentation '+kind,description:'',content:{kind,asset:'background'},assets:[{id:'background',kind,source:file,variants:[]}],files:[{path:file,bytes:bytes.length,sha256:hash(bytes),mime:kind==='image'?'image/png':'video/webm'}],properties:[],permissions:{audioSpectrum:false,pointer:false},license:{code:'none',assets:'CC0-1.0',attribution:''}};
  return buildZip([['manifest.json',Buffer.from(JSON.stringify(manifest))],[file,bytes]]);
}
async function seed() {
  fs.mkdirSync(path.join(output,'probe-inputs'),{recursive:true});
  const lyrics={enabled:false,locked:false,layout:'double',secondary:'next',fontFamily:'Segoe UI',fontSize:32,fontWeight:600,sungColor:'#ffffff',unsungColor:'#ffffff',outlineColor:'#000000',outlineWidth:1,opacity:1,width:550,anchorX:.5,anchorY:.5,monitor:null};
  const wallpaper={enabled:true,fps:15,musicResponse:false,monitor:null,source:'fixed',scene:'coast'};
  fs.writeFileSync(configFile,JSON.stringify({schemaVersion:4,revision:1,launchAtLogin:false,activeProfile:null,profiles:[],unboundDomain:{lyrics,wallpaper},lastCommit:null}));
  fs.writeFileSync(path.join(output,'probe-inputs/image.hwpkg'),packageBytes('image',FIXTURE_PNG,101));
  fs.writeFileSync(path.join(output,'probe-inputs/video.hwpkg'),packageBytes('video',fs.readFileSync(path.join(root,'scripts/fixtures/wallpaper-vp8.webm')),102));
  await start();
  const wallpaperPage=await until(()=>pages().find(page=>page.url().includes('/wallpaper.html')),'seed wallpaper');
  await wallpaperPage.waitForFunction(()=>!!window.hertzWallpaper);
  for(const [index,name]of ['image','video'].entries()) {
    const nonce=index+1;
    await wallpaperPage.evaluate(({nonce,name})=>window.ipc.postMessage('wallpaper_probe_import '+JSON.stringify({nonce,action:'begin',name})),{nonce,name});
    await wallpaperPage.waitForFunction(nonce=>!!window.__nativeImportProbes?.[nonce],nonce,{timeout:30000});
    const result=await wallpaperPage.evaluate(nonce=>window.__nativeImportProbes[nonce],nonce);
    assert.equal(result.state,'done',JSON.stringify(result));
    fs.unlinkSync(path.join(output,'probe-inputs',name+'.hwpkg'));
  }
  const list=await formal('wallpaper.library.list');assert.equal(list.ok,true,JSON.stringify(list));
  const fixture={};
  for(const work of list.result.works) {
    const detail=await formal('wallpaper.library.get',{workKey:work.workKey});
    fixture[work.kind]={workKey:work.workKey,packageHash:detail.result.versions[0].packageHash};
  }
  assert.ok(fixture.image&&fixture.video);
  fs.writeFileSync(path.join(output,'fixture.json'),JSON.stringify(fixture,null,2));
  await stop();
  console.log(output);
}
async function applyWallpaper(wallpaper,requestId) {
  const base=stored();
  const create=await inPage(envelope('wallpaper.draft.create',{kind:'settings'}));assert.equal(create.ok,true,JSON.stringify(create));
  const draft=create.result;
  const update=await inPage(envelope('wallpaper.draft.update',{draftId:draft.draftId,draftRevision:draft.draftRevision,operations:[{kind:'replaceWallpaper',wallpaper}]}));assert.equal(update.ok,true,JSON.stringify(update));
  const request=envelope('wallpaper.apply',{draftId:update.result.draftId,draftRevision:update.result.draftRevision},base.revision,runId+requestId);
  let receipt=await inPage(request);
  if(!receipt.ok&&['receipt_timeout','operation_pending'].includes(receipt.error.code)) {
    receipt=await until(async()=>{const operation=await formal('wallpaper.operations.get',{requestId:request.requestId,command:'wallpaper.apply'});return operation.ok&&operation.result.saved?{...operation,result:operation.result}:null;},'original apply receipt',30000);
  }
  return {request,receipt};
}
async function running(selection,kind) {
  return until(async()=>{const status=await formal('status');return status.wallpaper?.firstFrameReady&&status.wallpaper.visible&&status.wallpaper.session?.frameKind===kind&&status.wallpaper.appliedRevision===stored().revision&&status.wallpaper.appliedSelection?.kind===selection.kind&&status.wallpaper.appliedSelection?.workKey===selection.workKey&&status.wallpaper.appliedSelection?.packageHash===selection.packageHash?status:null;},'native applied '+kind,30000);
}
async function mediaPreview(kind) {
  const status=await until(async()=>{const value=await formal('status');return value.wallpaper.mediaPreview?.firstFrameReady?value:null;},'native '+kind+' preview first frame',30000);
  const binding=status.wallpaper.mediaPreview.binding;
  const page=await until(async()=>{for(const page of pages().filter(page=>page.url().includes('/wallpaper.html'))){try{if(await page.evaluate(id=>window.hertzWallpaper?.debug().session?.sessionId===id,binding.sessionId))return page;}catch{}}return null;},'independent preview controller');
  assert.equal((await page.evaluate(()=>window.hertzWallpaper.debug())).media.kind,kind);
  assert.equal(await page.locator('canvas').count(),0,'media preview has no GL context');
  return {status,page};
}
async function run() {
  const fixture=JSON.parse(fs.readFileSync(path.join(output,'fixture.json')));
  await start();
  // Reusable fixtures can end with media disabled. Start each run from an applied builtin.
  const baseline=structuredClone(domain(stored()).wallpaper);
  baseline.enabled=true;baseline.audioInput={kind:'none'};
  baseline.groups[0].selection={kind:'builtin',sceneId:'zodiac',stateVersion:1,params:{}};
  const baselineApply=await applyWallpaper(baseline,'baseline');assert.equal(baselineApply.receipt.ok,true,JSON.stringify(baselineApply.receipt));
  const original=await until(async()=>{const status=await formal('status');return status.wallpaper?.visible&&status.wallpaper.firstFrameReady&&status.wallpaper.session?.frameKind==='gl'?status:null;},'initial presentation');
  const image=structuredClone(domain(stored()).wallpaper);
  image.enabled=true;image.audioInput={kind:'none'};image.groups[0].selection={kind:'package',...fixture.image};image.groups[0].presentation.fit='contain';
  // Exercise the actual library selection and Apply controls through the native settings page.
  await settings.evaluate(()=>{
    window.presentationReceipts=[];
    const receive=window.hertzWallpaperSettings.applyManagement;
    window.hertzWallpaperSettings.applyManagement=receipt=>{window.presentationReceipts.push(structuredClone(receipt));return receive(receipt);};
  });
  const beforeChoose=fs.readFileSync(configFile,'utf8');
  await settings.locator('#local-library > summary').click();
  const imageWork=settings.locator('#library-works > li').filter({has:settings.getByText('Presentation image',{exact:true})});
  await imageWork.getByRole('button',{name:'查看版本',exact:true}).click();
  await imageWork.getByRole('button',{name:'选择此版本',exact:true}).click();
  await settings.locator('#media-fit').selectOption('contain');
  assert.equal(await settings.locator('#scene-source').inputValue(),'library');
  assert.equal(fs.readFileSync(configFile,'utf8'),beforeChoose,'version selection edits the draft only');
  assert.equal(await settings.locator('#preview').isEnabled(),true,'native media preview is available');
  await settings.locator('#preview').click();
  const imagePreview=await mediaPreview('image');
  await settings.screenshot({path:path.join(output,'library-selection.png')});
  await imagePreview.page.screenshot({path:path.join(output,'image-preview.png')});
  assert.deepEqual(imagePreview.status.wallpaper.session.binding,original.wallpaper.session.binding,'preview leaves desktop controller alone');
  assert.equal(fs.readFileSync(configFile,'utf8'),beforeChoose,'preview does not save the draft');
  assert.equal(await settings.locator('#preview-renderer').count(),0,'media has its own native container');
  assert.equal((await formal('wallpaper.status')).result.decoderSlots,0,'static preview has no decoder');
  checks.push({name:'real library image preview in an independent native container, no persistence',status:imagePreview.status.wallpaper.mediaPreview});
  await settings.locator('#apply').click();
  await settings.waitForFunction(()=>document.querySelector('#settings-state').textContent==='设置已保存',null,{timeout:45000});
  const uiReceipts=await settings.evaluate(()=>window.presentationReceipts);
  const savedReceipt=uiReceipts.find(receipt=>receipt.result?.command==='wallpaper.apply'&&receipt.result.saved);
  const uiDraft=uiReceipts.filter(receipt=>receipt.result?.draftId).at(-1)?.result;
  assert.ok(savedReceipt&&uiDraft,'real Apply completed the native draft');
  const applyRequest=envelope('wallpaper.apply',{draftId:uiDraft.draftId,draftRevision:uiDraft.draftRevision},JSON.parse(beforeChoose).revision,savedReceipt.requestId);
  const applied={request:applyRequest,receipt:savedReceipt};
  assert.equal(applied.receipt.ok,true,JSON.stringify(applied.receipt));assert.equal(applied.receipt.result.saved,true);
  assert.deepEqual(domain(stored()).wallpaper.groups[0].selection,image.groups[0].selection);
  const imageStatus=await running(image.groups[0].selection,'image');
  await until(()=>imagePreview.page.isClosed(),'applying closes only the preview controller');
  assert.equal((await formal('status')).wallpaper.previewActive,false);
  const imagePage=await until(async()=>{for(const page of pages().filter(page=>page.url().includes('/wallpaper.html'))){try{if(await page.locator('img[data-wallpaper-media="image"]').count())return page;}catch{}}return null;},'actual image controller');
  const imageState=await imagePage.evaluate(()=>({debug:window.hertzWallpaper.debug(),canvas:!!document.querySelector('canvas'),fit:getComputedStyle(document.querySelector('img')).objectFit,source:document.querySelector('img').src}));
  assert.equal(imageState.debug.media.state,'ready');assert.equal(imageState.debug.session.revealed,true);assert.equal(imageState.canvas,false);assert.equal(imageState.fit,'contain');assert.match(imageState.source,/wallpaper\.invalid\/files\//);
  assert.notEqual(imageStatus.wallpaper.session.binding.sessionId,original.wallpaper.session.binding.sessionId);
  const replay=await nativeRequest(applied.request);assert.deepEqual(replay.result,applied.receipt.result);
  assert.deepEqual((await formal('status')).wallpaper.session.binding,imageStatus.wallpaper.session.binding,'committed replay never creates another controller');
  checks.push({name:'image apply, original source absent, exact native grant, replay',status:imageStatus.wallpaper,state:imageState});
  // An invalid work/version pairing fails before persistence and cannot displace the active image.
  const beforeInvalid=fs.readFileSync(configFile,'utf8');
  const wrong=structuredClone(image);wrong.groups[0].selection={kind:'package',workKey:fixture.video.workKey,packageHash:fixture.image.packageHash};
  const rejected=await applyWallpaper(wrong,'reject-mispaired');assert.equal(rejected.receipt.ok,false);assert.equal(rejected.receipt.error.code,'version_not_found');
  assert.equal(fs.readFileSync(configFile,'utf8'),beforeInvalid);assert.deepEqual((await formal('status')).wallpaper.session.binding,imageStatus.wallpaper.session.binding);
  checks.push({name:'invalid pairing preserves config and active controller',receipt:rejected.receipt});
  await inPage(envelope('wallpaper.draft.discard',{draftId:rejected.request.payload.draftId,draftRevision:rejected.request.payload.draftRevision}));
  // Restart with only the saved stable reference and installed bytes.
  await stop();await start();
  const restoredImage=await running(image.groups[0].selection,'image');
  checks.push({name:'ordinary build restores image without source',status:restoredImage.wallpaper});
  // Make a future candidate's real image decode reject; the already active page is untouched.
  for(const context of browser.contexts()) await context.addInitScript(()=>{
    if(location.pathname!=='/wallpaper.html')return;
    const decode=HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode=function(){
      return localStorage.getItem('presentation-fail-decode')==='1'?Promise.reject(new Error('acceptance decode failure')):decode.call(this);
    };
  });
  const retainedImage=await until(()=>pages().find(page=>page.url().includes('/wallpaper.html')),'restored image page');
  await retainedImage.evaluate(()=>localStorage.setItem('presentation-fail-decode','1'));
  const failedImage=structuredClone(image);failedImage.groups[0].presentation.fit='stretch';
  const failedApply=await applyWallpaper(failedImage,'candidate-decode-failure');assert.equal(failedApply.receipt.ok,true,JSON.stringify(failedApply.receipt));
  const failedStatus=await until(async()=>{const status=await formal('status');return status.wallpaper.applyError&& !status.wallpaper.candidateLoading?status:null;},'candidate fails without displacing active image');
  assert.deepEqual(failedStatus.wallpaper.session.binding,restoredImage.wallpaper.session.binding);
  assert.equal(failedStatus.wallpaper.visible,true);assert.equal(failedStatus.wallpaper.appliedRevision,restoredImage.wallpaper.appliedRevision);
  assert.equal(failedStatus.wallpaper.desiredRevision,stored().revision);
  assert.equal(domain(stored()).wallpaper.groups[0].presentation.fit,'stretch','saved intent survives runtime failure');
  checks.push({name:'saved candidate decode failure preserves previous actual presentation',status:failedStatus.wallpaper});
  await retainedImage.evaluate(()=>localStorage.removeItem('presentation-fail-decode'));
  await nativeRequest({command:'wallpaper-retry'});
  const retriedImage=await running(image.groups[0].selection,'image');
  assert.notEqual(retriedImage.wallpaper.session.binding.sessionId,restoredImage.wallpaper.session.binding.sessionId);
  checks.push({name:'explicit retry creates fresh ready candidate',status:retriedImage.wallpaper});
  const video=structuredClone(image);video.groups[0].selection={kind:'package',...fixture.video};video.groups[0].presentation.fit='cover';
  const videoApplied=await applyWallpaper(video,'apply-video');assert.equal(videoApplied.receipt.ok,true,JSON.stringify(videoApplied.receipt));
  const videoStatus=await running(video.groups[0].selection,'video');
  const videoPage=await until(async()=>{for(const page of pages().filter(page=>page.url().includes('/wallpaper.html'))){try{if(await page.locator('video[data-wallpaper-media="video"]').count())return page;}catch{}}return null;},'actual video controller');
  const firstTime=await videoPage.evaluate(()=>document.querySelector('video').currentTime);await delay(700);const secondTime=await videoPage.evaluate(()=>document.querySelector('video').currentTime);
  assert.notEqual(firstTime,secondTime,'real video clock advances');
  assert.equal((await videoPage.evaluate(()=>document.querySelector('video').muted)),true);
  const resources=await formal('wallpaper.status');assert.equal(resources.result.decoderSlots,1);assert.equal(resources.result.prepareTasks,0);
  checks.push({name:'ordinary build media video, one charged decoder',status:videoStatus.wallpaper,resources:resources.result,firstTime,secondTime});
  // Video preview competes for the same two decoder slots while the desktop stays live.
  const previewConfig=structuredClone(video);previewConfig.groups[0].presentation.fit='contain';
  const previewCreate=await inPage(envelope('wallpaper.draft.create',{kind:'settings'}));assert.equal(previewCreate.ok,true,JSON.stringify(previewCreate));
  const previewUpdate=await inPage(envelope('wallpaper.draft.update',{draftId:previewCreate.result.draftId,draftRevision:previewCreate.result.draftRevision,operations:[{kind:'replaceWallpaper',wallpaper:previewConfig}]}));assert.equal(previewUpdate.ok,true,JSON.stringify(previewUpdate));
  const previewRef={draftId:previewUpdate.result.draftId,draftRevision:previewUpdate.result.draftRevision};
  const previewLease=await inPage(envelope('wallpaper.preview.acquire',previewRef));assert.equal(previewLease.ok,true,JSON.stringify(previewLease));
  const livePreview=await mediaPreview('video');
  await livePreview.page.screenshot({path:path.join(output,'video-preview.png')});
  const two=await formal('wallpaper.status');assert.equal(two.result.decoderSlots,2);assert.equal(two.result.prepareTasks,0);
  assert.equal(await livePreview.page.evaluate(()=>document.querySelector('video').muted),true);
  const wrongLease=await inPage(envelope('wallpaper.preview.release',{leaseId:'0'.repeat(32)}));assert.equal(wrongLease.ok,false);assert.equal(wrongLease.error.code,'preview_lease_invalid');
  assert.equal((await formal('wallpaper.status')).result.decoderSlots,2,'wrong lease cannot release either decoder');
  await nativeRequest({command:'wallpaper-hide'});
  const previewClock=await livePreview.page.evaluate(()=>document.querySelector('video').currentTime);
  await delay(700);assert.notEqual(await livePreview.page.evaluate(()=>document.querySelector('video').currentTime),previewClock,'desktop manual pause does not pause preview');
  const paused=await formal('status');assert.equal(paused.wallpaper.session.state,'paused');assert.deepEqual(paused.wallpaper.session.binding,videoStatus.wallpaper.session.binding);
  await delay(300);const pausedAt=await videoPage.evaluate(()=>document.querySelector('video').currentTime);await delay(700);
  assert.ok(Math.abs((await videoPage.evaluate(()=>document.querySelector('video').currentTime))-pausedAt)<.12,'paused decoder clock stays frozen');
  assert.equal((await formal('wallpaper.status')).result.decoderSlots,2,'soft pause keeps both decoders charged');
  await nativeRequest({command:'wallpaper-show'});
  const resumed=await running(video.groups[0].selection,'video');assert.deepEqual(resumed.wallpaper.session.binding,videoStatus.wallpaper.session.binding);
  await until(async()=>Math.abs((await videoPage.evaluate(()=>document.querySelector('video').currentTime))-pausedAt)>.12,'same video clock resumes');
  checks.push({name:'soft pause freezes video and retains charged decoder; same session resumes',status:resumed.wallpaper});
  const transferRequest=envelope('wallpaper.apply',previewRef,stored().revision,runId+'preview-to-apply');
  const transfer=await inPage(transferRequest);assert.equal(transfer.ok,true,JSON.stringify(transfer));
  await until(()=>livePreview.page.isClosed(),'preview exits before desktop candidate promotion');
  const transferred=await running(video.groups[0].selection,'video');
  await until(async()=> (await formal('wallpaper.status')).result.decoderSlots===1,'old desktop exits after preview to apply');
  assert.equal(domain(stored()).wallpaper.groups[0].presentation.fit,'contain');
  checks.push({name:'live desktop and video preview charge two decoders; preview to apply independently exits then hands over',resources:two.result,status:transferred.wallpaper});
  // Losing renewals expires only the preview, leaving settings and the active desktop intact.
  const expiryCreate=await inPage(envelope('wallpaper.draft.create',{kind:'settings'}));assert.equal(expiryCreate.ok,true,JSON.stringify(expiryCreate));
  const expiryRef={draftId:expiryCreate.result.draftId,draftRevision:expiryCreate.result.draftRevision};
  const expiryLease=await inPage(envelope('wallpaper.preview.acquire',expiryRef));assert.equal(expiryLease.ok,true,JSON.stringify(expiryLease));
  const expiring=await mediaPreview('video');
  await settings.evaluate(()=>Object.defineProperty(document,'hidden',{configurable:true,get:()=>true}));
  await until(()=>expiring.page.isClosed(),'native preview lease expires without renewal',22000);
  await settings.evaluate(()=>delete document.hidden);
  const afterExpiry=await formal('status');assert.equal(afterExpiry.wallpaper.previewActive,false);assert.equal(settings.isClosed(),false);
  assert.deepEqual(afterExpiry.wallpaper.session.binding,transferred.wallpaper.session.binding);
  await until(async()=>{const status=await formal('status');const resources=await formal('wallpaper.status');return status.wallpaper.retiringControllers===0&&resources.result.decoderSlots===1;},'preview file drain and controller exit return decoder');
  await inPage(envelope('wallpaper.draft.discard',expiryRef));
  checks.push({name:'lost renewal closes only independent preview and returns its decoder',status:afterExpiry.wallpaper});
  const beforePreviewFailure=fs.readFileSync(configFile,'utf8');
  const failureDraft=await inPage(envelope('wallpaper.draft.create',{kind:'settings'}));assert.equal(failureDraft.ok,true,JSON.stringify(failureDraft));
  const failureUpdate=await inPage(envelope('wallpaper.draft.update',{draftId:failureDraft.result.draftId,draftRevision:failureDraft.result.draftRevision,operations:[{kind:'replaceWallpaper',wallpaper:image}]}));assert.equal(failureUpdate.ok,true,JSON.stringify(failureUpdate));
  const failureRef={draftId:failureUpdate.result.draftId,draftRevision:failureUpdate.result.draftRevision};
  const activeVideo=await until(async()=>{for(const page of pages().filter(page=>page.url().includes('/wallpaper.html'))){try{if(await page.evaluate(id=>window.hertzWallpaper?.debug().session?.sessionId===id,transferred.wallpaper.session.binding.sessionId))return page;}catch{}}return null;},'retained video page');
  await activeVideo.evaluate(()=>localStorage.setItem('presentation-fail-decode','1'));
  const failedPreviewLease=await inPage(envelope('wallpaper.preview.acquire',failureRef));assert.equal(failedPreviewLease.ok,true,JSON.stringify(failedPreviewLease));
  await until(async()=>{const status=await formal('status');const resources=await formal('wallpaper.status');return !status.wallpaper.previewActive&&status.wallpaper.retiringControllers===0&&resources.result.prepareTasks===0&&resources.result.decoderSlots===1;},'failed preview independently exits');
  assert.equal(settings.isClosed(),false);assert.equal(fs.readFileSync(configFile,'utf8'),beforePreviewFailure);
  assert.match(await settings.locator('#status').innerText(),/媒体预览.*失败/);
  assert.deepEqual((await formal('status')).wallpaper.session.binding,transferred.wallpaper.session.binding);
  await activeVideo.evaluate(()=>localStorage.removeItem('presentation-fail-decode'));
  await inPage(envelope('wallpaper.draft.discard',failureRef));
  checks.push({name:'preview decode failure leaves settings and desktop alive without saving draft',status:(await formal('status')).wallpaper});
  await stop();await start();const restoredVideo=await running(video.groups[0].selection,'video');
  assert.equal((await formal('wallpaper.status')).result.decoderSlots,1);
  checks.push({name:'ordinary build restores video',status:restoredVideo.wallpaper});
  const disabled=structuredClone(video);disabled.enabled=false;
  const stopped=await applyWallpaper(disabled,'disable-media');assert.equal(stopped.receipt.ok,true,JSON.stringify(stopped.receipt));
  await until(async()=>{const status=await formal('status');const resources=await formal('wallpaper.status');return !status.wallpaper.enabled&&status.wallpaper.retiringControllers===0&&resources.result.decoderSlots===0;},'media physical exit');
  checks.push({name:'stop closes controller and returns decoder only after exit',status:(await formal('status')).wallpaper,resources:(await formal('wallpaper.status')).result});
  fs.writeFileSync(path.join(output,'presentation-report.json'),JSON.stringify({ordinaryBuild:true,checks},null,2));
  console.log('wallpaper presentation native checks passed: '+output);
}
(async()=>{
  assert.equal(process.platform,'win32');assert.equal(execFileSync('powershell.exe',['-NoProfile','-Command','@(Get-Process hertz-desktop -ErrorAction SilentlyContinue).Count'],{encoding:'utf8',windowsHide:true}).trim(),'0','protect existing native instance');
  try{if(setup)await seed();else await run();}catch(error){
    if(browser){
      const state=await formal('status').catch(failure=>({failure:String(failure)}));
      const renderers=[];
      for(const page of pages().filter(page=>page.url().includes('/wallpaper.html'))){renderers.push(await page.evaluate(()=>({url:location.href,state:window.hertzWallpaper?.debug()})).catch(failure=>({failure:String(failure)})));}
      fs.writeFileSync(path.join(output,'presentation-failure.json'),JSON.stringify({error:String(error),state,renderers},null,2));
    }
    throw error;
  }finally{await stop();}
})().catch(error=>{console.error(error);process.exitCode=1;});
