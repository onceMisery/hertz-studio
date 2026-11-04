// SPDX-License-Identifier: MIT
// Ordinary WebView2 acceptance, invoked by check-wallpaper-presentation-native.js --builtin-preview.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function verify({output,settings,baseline,fixture,checks,pages,until,envelope,inPage,formal,nativeRequest,ownedPid}) {
  const configFile=path.join(output,'config.json'), saved=fs.readFileSync(configFile,'utf8');
  const desktop=(await formal('status')).wallpaper, binding=desktop.session.binding;
  const checked=async request=>{const reply=await inPage(request);assert.equal(reply.ok,true,JSON.stringify(reply));return reply.result;};
  const resources=async()=>{const reply=await formal('wallpaper.status');assert.equal(reply.ok,true,JSON.stringify(reply));return reply.result;};
  async function pageFor(id) {
    return until(async()=>{
      for(const page of pages().filter(page=>page.url().includes('/wallpaper.html'))) {
        try {if(await page.evaluate(id=>window.hertzWallpaper?.debug().session?.sessionId===id,id))return page;}catch{}
      }
      return null;
    },'independent page for '+id);
  }
  const desktopPage=await pageFor(binding.sessionId);
  const initialResources=await resources();
  assert.equal(initialResources.budget.contexts,1);
  assert.equal(initialResources.budget.sessionReservations,1);
  assert.equal(initialResources.budget.resourceAllocations,2,'GL 会话含 gl-renderer 与 shared-assets 两个子额度');
  assert.equal(desktop.glAllocation.reserved.contexts,1);
  async function unchanged() {
    const current=(await formal('status')).wallpaper;
    assert.deepEqual(current.session.binding,binding,'preview preserves desktop generation');
    assert.equal(current.applyError,desktop.applyError);
    assert.equal(settings.isClosed(),false);assert.equal(desktopPage.isClosed(),false);
    assert.equal(fs.readFileSync(configFile,'utf8'),saved,'preview does not persist draft or its FPS cap');
    assert.equal(await settings.locator('iframe,canvas,video').count(),0,'settings has no live renderer');
  }
  async function drained() {
    await until(async()=>{const state=(await formal('status')).wallpaper;return !state.previewActive&&state.retiringControllers===0&&!state.retiringHandoffs;},'preview owner and controllers drain');
    const usage=await resources();
    assert.deepEqual(usage.budget,initialResources.budget,'all native session and resource reservations return to baseline');
    for(const field of ['decoderSlots','prepareTasks','prepareCpuBytes','gpuBytes','cpuBytes','glContexts','targets']) {
      if(field in initialResources)assert.equal(usage[field],initialResources[field],field+' returns to desktop baseline');
    }
    assert.equal(pages().filter(page=>page.url().includes('/wallpaper.html')).length,1,'only the actual desktop controller remains');
    await unchanged();
    return usage;
  }
  async function ready(kind='gl') {
    const status=await until(async()=>{const state=(await formal('status')).wallpaper;return state.mediaPreview?.firstFrameReady&&!state.mediaPreview.handoff&&!state.retiringHandoffs?state:null;},kind+' preview submits native first frame');
    const page=await pageFor(status.mediaPreview.binding.sessionId);
    await page.waitForFunction(()=>window.hertzWallpaper.debug().session.revealed);
    const debug=await page.evaluate(()=>window.hertzWallpaper.debug());
    assert.equal(debug.session.frameKind,kind);
    if(kind==='gl')assert.equal(debug.mounted,true);else assert.equal(debug.media.state,'ready');
    assert.equal(await page.locator('canvas').count(),kind==='gl'?1:0);
    assert.notEqual(debug.session.sessionId,binding.sessionId);
    await unchanged();
    return {page,status:status.mediaPreview,debug};
  }
  const config=structuredClone(baseline);config.groups[0].presentation.fps=60;
  async function createDraft(wallpaper=config) {
    const created=await checked(envelope('wallpaper.draft.create',{kind:'settings'}));
    return updateDraft(created,wallpaper);
  }
  async function updateDraft(reference,wallpaper) {
    const updated=await checked(envelope('wallpaper.draft.update',{draftId:reference.draftId,draftRevision:reference.draftRevision,operations:[{kind:'replaceWallpaper',wallpaper}]}));
    return {draftId:updated.draftId,draftRevision:updated.draftRevision};
  }
  async function release(lease,reference) {
    await checked(envelope('wallpaper.preview.release',{leaseId:lease.leaseId}));
    await drained();
    if(reference)await checked(envelope('wallpaper.draft.discard',reference));
  }
  // Fault controls apply only to future pages of this test-owned browser context.
  // The already-running desktop is not patched. Production timeouts remain unchanged.
  await settings.context().addInitScript(()=>{
    window.previewTestInit={path:location.pathname,mode:localStorage.getItem('builtin-preview-test'),ipc:typeof window.ipc};
    if(location.pathname!=='/wallpaper.html')return;
    const mode=localStorage.getItem('builtin-preview-test');
    if(mode==='mount-failure') {
      const getContext=HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext=function(type,...args){return /^webgl|^experimental-webgl/.test(type)?null:getContext.call(this,type,...args);};
    }
    if(mode==='hold-first-frame') {
      // Wry freezes window.ipc. Intercept the actual WebView2 transport after all
      // document-created scripts, before the host's mount can submit its first frame.
      document.addEventListener('DOMContentLoaded',()=>{
        window.previewTestInit.domReady=true;
        const post=window.chrome.webview.postMessage.bind(window.chrome.webview);
        window.previewNativePost=post;
        window.chrome.webview.postMessage=message=>{
          if(message.startsWith('wallpaper_session ')&&JSON.parse(message.slice(18)).event==='firstFrame') {window.previewHeldFrame=message;return;}
          post(message);
        };
      },{once:true});
    }
  });
  const mode=value=>desktopPage.evaluate(value=>value?localStorage.setItem('builtin-preview-test',value):localStorage.removeItem('builtin-preview-test'),value);

  await mode('hold-first-frame');
  await settings.locator('#fps').selectOption('60');
  await settings.locator('#preview').click();
  const pending=await until(async()=>{const state=(await formal('status')).wallpaper;return state.mediaPreview?.binding?state.mediaPreview:null;},'native preview owner');
  const held=await pageFor(pending.binding.sessionId);
  await held.waitForFunction(()=>!!window.previewHeldFrame,null,{timeout:4000}).catch(async error=>{
    fs.writeFileSync(path.join(output,'preview-injection-failure.json'),JSON.stringify(await held.evaluate(()=>({init:window.previewTestInit,mode:localStorage.getItem('builtin-preview-test'),post:window.ipc.postMessage.toString(),held:window.previewHeldFrame,state:hertzWallpaper.debug()})),null,2));
    throw error;
  });
  assert.equal((await formal('status')).wallpaper.mediaPreview.firstFrameReady,false);
  assert.equal(await held.evaluate(()=>hertzWallpaper.debug().session.revealed),false);
  assert.equal(await settings.evaluate(()=>typeof hertzWallpaperSettings.evalPreview),'undefined');
  assert.equal(await settings.evaluate(async()=>(await fetch('/wallpaper.html')).status),404,'settings protocol no longer serves the scene runtime');
  await held.evaluate(()=>{
    const receipt=JSON.parse(window.previewHeldFrame.slice(18));
    previewNativePost('wallpaper_ready');
    previewNativePost('wallpaper_session '+JSON.stringify({...receipt,sessionId:'0'.repeat(32)}));
    previewNativePost('wallpaper_session '+JSON.stringify({...receipt,generation:receipt.generation+1}));
    previewNativePost('wallpaper_session '+JSON.stringify({...receipt,frameKind:'image'}));
  });
  await delay(300);
  assert.equal((await formal('status')).wallpaper.mediaPreview.firstFrameReady,false,'legacy, wrong identity/generation/backend cannot qualify readiness');
  await held.evaluate(()=>previewNativePost(window.previewHeldFrame));
  const first=await ready();
  assert.equal(first.status.configuredFps,60);assert.equal(first.status.effectiveFps,15);assert.ok(first.debug.gate.budget<=15);
  assert.ok(first.status.width<=640&&first.status.height<=360);
  assert.match(first.status.binding.sessionId,/^[0-9a-f]{32}$/);
  assert.equal(first.status.glAllocation.reserved.contexts,1);
  assert.equal(first.debug.glBudget.contexts,1);
  assert.ok(first.debug.glBudget.peakBytes<=first.status.glLimits.gpuBytes);
  const firstResources=await resources();
  assert.equal(firstResources.budget.contexts,2);
  for(const key of ['gpuBytes','outputPixelRate'])assert.equal(firstResources.budget[key],desktop.glAllocation.reserved[key]+first.status.glAllocation.reserved[key]);
  assert.equal(await settings.locator('#fps').inputValue(),'60','draft retains requested FPS');
  await first.page.screenshot({path:path.join(output,'builtin-independent-preview.png')});
  await mode(null);
  const busy=await inPage(envelope('wallpaper.preview.acquire',{draftId:'0'.repeat(32),draftRevision:1}));
  assert.equal(busy.ok,false);assert.equal(busy.error.code,'preview_busy');
  for(const command of ['wallpaper.preview.release','wallpaper.preview.renew']) {
    const wrong=await inPage(envelope(command,{leaseId:'0'.repeat(32)}));
    assert.equal(wrong.ok,false);assert.equal(wrong.error.code,'preview_lease_invalid');
  }
  await nativeRequest({command:'wallpaper-hide'});
  await until(async()=>(await formal('status')).wallpaper.session.state==='paused','desktop pauses');
  const draws=await first.page.evaluate(()=>hertzWallpaper.debug().draws);
  await until(async()=>(await first.page.evaluate(()=>hertzWallpaper.debug().draws))>draws+2,'GL preview keeps submitting frames while desktop is paused');
  await nativeRequest({command:'wallpaper-show'});
  await until(async()=>(await formal('status')).wallpaper.visible,'desktop resumes');
  await settings.locator('#preview').click();await drained();
  await settings.locator('#discard').click();
  await until(async()=>await settings.locator('#fps').inputValue()===String(baseline.groups[0].presentation.fps),'discard resets displayed draft FPS');
  // Fence the serialized draft discard before creating a direct native test draft.
  await delay(200);
  checks.push({name:'independent native GL preview requires typed real first frame, bounds size/FPS, rejects wrong lease, and survives desktop pause',preview:first.status,debug:first.debug});

  let reference=await createDraft(), lease=await checked(envelope('wallpaper.preview.acquire',reference)), current=await ready();
  const transitions=[];
  for(const kind of ['image','video','gl']) {
    const next=structuredClone(config);
    if(kind!=='gl')next.groups[0].selection={kind:'package',...fixture[kind]};
    else next.groups[0].selection={kind:'builtin',sceneId:'coast',stateVersion:1,params:{}};
    reference=await updateDraft(reference,next);
    const old=current, began=performance.now();let closedAt=null;
    old.page.once('close',()=>{closedAt=performance.now();});
    const updated=await checked(envelope('wallpaper.preview.update',{...reference,leaseId:lease.leaseId}));
    assert.equal(updated.leaseId,lease.leaseId);assert.ok(updated.generation>lease.generation);
    current=await ready(kind);
    assert.equal(old.page.isClosed(),true,'old controller closes before successor readiness');assert.ok(closedAt!==null);
    assert.notEqual(current.status.binding.sessionId,old.status.binding.sessionId);
    const usage=await resources();assert.equal(usage.decoderSlots,kind==='video'?1:0);assert.equal(usage.prepareTasks,0);
    assert.equal(usage.budget.sessionReservations,2);
    assert.equal(usage.budget.resourceAllocations,4,'桌面与预览各持 gl-renderer+shared-assets 或 decoded+present 两个子额度');
    assert.equal(usage.budget.previewInstances,1,'all preview backends share the global preview limit');
    assert.equal(usage.budget.contexts,kind==='gl'?2:1);
    transitions.push({kind,oldClosedMs:closedAt-began,readyMs:performance.now()-began,binding:current.status.binding,resources:usage});
    lease=updated;
  }
  await release(lease,reference);
  checks.push({name:'one preview lease replaces GL, image, video and GL controllers with fresh generations and actual media drain',transitions});

  reference=await createDraft();lease=await checked(envelope('wallpaper.preview.acquire',reference));current=await ready();
  const lostAt=performance.now();
  await current.page.evaluate(()=>{
    const canvas=document.querySelector('canvas'), gl=canvas.getContext('webgl2')||canvas.getContext('webgl');
    const extension=gl.getExtension('WEBGL_lose_context');
    if(!extension)throw new Error('WEBGL_lose_context unavailable');
    extension.loseContext();
  });
  await until(()=>current.page.isClosed(),'lost preview GL context closes its native controller');
  await drained();
  assert.match(await settings.locator('#status').innerText(),/预览.*上下文.*丢失/);
  await checked(envelope('wallpaper.draft.discard',reference));
  checks.push({name:'real preview WebGL context loss closes preview and preserves desktop and draft persistence',elapsedMs:performance.now()-lostAt});

  await mode('mount-failure');reference=await createDraft();
  const failed=await inPage(envelope('wallpaper.preview.acquire',reference));assert.equal(failed.ok,true,JSON.stringify(failed));
  await until(async()=>(await formal('status')).wallpaper.previewActive===false,'GL mount failure closes preview');
  await drained();assert.match(await settings.locator('#status').innerText(),/预览.*失败/);
  await mode(null);await checked(envelope('wallpaper.draft.discard',reference));
  checks.push({name:'preview GL initialization failure independently closes without displacing desktop'});

  const rejected=[];
  for(const kind of ['buffer','texture','renderbuffer','second-context']) {
    reference=await createDraft();lease=await checked(envelope('wallpaper.preview.acquire',reference));current=await ready();
    const rejection=await current.page.evaluate(kind=>{
      const canvas=document.querySelector('canvas'),gl=canvas.getContext('webgl2');
      try {
        if(kind==='buffer'){gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());gl.bufferData(gl.ARRAY_BUFFER,HertzGlBudget.limits.gpuBytes+1,gl.STATIC_DRAW);}
        if(kind==='texture'){gl.bindTexture(gl.TEXTURE_2D,gl.createTexture());gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,16384,16384,0,gl.RGBA,gl.UNSIGNED_BYTE,null);}
        if(kind==='renderbuffer'){gl.bindRenderbuffer(gl.RENDERBUFFER,gl.createRenderbuffer());gl.renderbufferStorage(gl.RENDERBUFFER,gl.RGBA8,16384,16384);}
        if(kind==='second-context')document.createElement('canvas').getContext('webgl2');
      }catch(error){return {error:String(error),stats:HertzGlBudget.stats()};}
      return null;
    },kind);
    assert.match(rejection?.error||'',/gl_budget:/);
    await until(()=>current.page.isClosed(),'native GL budget failure retires preview');await drained();
    await checked(envelope('wallpaper.draft.discard',reference));rejected.push({kind,...rejection});
  }
  checks.push({name:'real WebView2 GL allocation excess and overlapping context fail before allocation and retire their native reservations',rejected});

  reference=await createDraft();lease=await checked(envelope('wallpaper.preview.acquire',reference));current=await ready();
  await current.page.evaluate(()=>{
    const post=window.chrome.webview.postMessage.bind(window.chrome.webview);
    window.chrome.webview.postMessage=message=>post(message.startsWith('wallpaper_heartbeat ')?'wallpaper_heartbeat 100 100 0 0':message);
  });
  const staleAt=performance.now();
  await until(()=>current.page.isClosed(),'unmounted heartbeats cannot extend native liveness',15000);
  await drained();assert.match(await settings.locator('#status').innerText(),/预览.*心跳/);
  await checked(envelope('wallpaper.draft.discard',reference));
  checks.push({name:'invalid mounted state cannot keep a native preview alive through its heartbeat deadline',elapsedMs:performance.now()-staleAt});

  // Drop only renewal messages. Rendering and valid heartbeats continue through the real lease deadline.
  reference=await createDraft();
  await settings.evaluate(()=>{
    const post=window.chrome.webview.postMessage.bind(window.chrome.webview);window.previewRestorePost=post;window.previewDroppedRenewals=0;
    window.chrome.webview.postMessage=message=>{let value;try{value=JSON.parse(message);}catch{}if(value?.command==='wallpaper.preview.renew'){window.previewDroppedRenewals++;return;}post(message);};
  });
  const acquiredAt=performance.now();lease=await checked(envelope('wallpaper.preview.acquire',reference));current=await ready();
  await delay(11000);
  assert.equal(current.page.isClosed(),false,'valid rendering remains until lease expiration');
  const ticking=await current.page.evaluate(()=>hertzWallpaper.debug());assert.ok(ticking.draws>current.debug.draws+20);
  await until(()=>current.page.isClosed(),'real 15-second native lease expires despite active renderer',10000);
  const expiredMs=performance.now()-acquiredAt;assert.ok(expiredMs>=14900&&expiredMs<22000);
  const dropped=await settings.evaluate(()=>{window.chrome.webview.postMessage=window.previewRestorePost;return window.previewDroppedRenewals;});assert.ok(dropped>=2);
  await drained();await checked(envelope('wallpaper.draft.discard',reference));
  checks.push({name:'real native lease expires while preview rendering and heartbeats remain active',expiredMs,droppedRenewals:dropped,draws:ticking.draws});

  reference=await createDraft();lease=await checked(envelope('wallpaper.preview.acquire',reference));current=await ready();
  assert.ok(Number.isSafeInteger(ownedPid)&&ownedPid>0);
  const title=Buffer.from('壁纸预览','utf16le').toString('base64');
  // Same WM_CLOSE used by the titlebar. Verify the HWND belongs to this launch
  // before posting; never close a matching window owned by another process.
  const closeScript=`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class HertzPreviewClose{[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr FindWindow(string c,string t);[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);[DllImport("user32.dll")]public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);}'; $previewHwnd=[HertzPreviewClose]::FindWindow([NullString]::Value,[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${title}')));if($previewHwnd -eq [IntPtr]::Zero){throw 'Preview not found'};[uint32]$previewPid=0;[void][HertzPreviewClose]::GetWindowThreadProcessId($previewHwnd,[ref]$previewPid);if($previewPid -ne ${ownedPid}){throw 'Preview owner mismatch'};if(-not [HertzPreviewClose]::PostMessage($previewHwnd,16,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'WM_CLOSE failed'}`;
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',closeScript],{windowsHide:true,stdio:'pipe'});
  await until(()=>current.page.isClosed(),'native preview titlebar close');await drained();
  await checked(envelope('wallpaper.draft.discard',reference));
  checks.push({name:'native WM_CLOSE on verified test-owned preview closes only its controller'});

  reference=await createDraft();lease=await checked(envelope('wallpaper.preview.acquire',reference));current=await ready();
  await settings.locator('#tab-lyrics').click();await until(()=>current.page.isClosed(),'tab switch releases preview');await drained();
  await checked(envelope('wallpaper.draft.discard',reference));await settings.locator('#tab-wallpaper').click();
  reference=await createDraft();lease=await checked(envelope('wallpaper.preview.acquire',reference));current=await ready();
  const oldSettings=settings;
  await settings.evaluate(()=>ipc.postMessage(JSON.stringify({cmd:'close'})));
  await until(async()=>{const state=(await formal('status')).wallpaper;return !state.settingsOpen&&!state.previewActive&&state.retiringControllers===0;},'settings owner closure releases independent preview');
  assert.equal(current.page.isClosed(),true);assert.equal(oldSettings.isClosed(),true);assert.equal(desktopPage.isClosed(),false);
  assert.deepEqual((await formal('status')).wallpaper.session.binding,binding);assert.equal(fs.readFileSync(configFile,'utf8'),saved);
  await nativeRequest({command:'wallpaper-settings'});
  settings=await until(()=>pages().find(page=>page!==oldSettings&&page.url().includes('/settings.html')),'fresh settings owner');
  await settings.waitForSelector('#enabled:enabled');
  await drained();
  checks.push({name:'tab and settings owner closure release only preview; fresh settings owner preserves desktop',resources:await resources()});
  return settings;
};
