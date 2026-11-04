// SPDX-License-Identifier: MIT
// Native feed and preview handoffs in an owned test profile with a narrow HTTP source.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
exports.prepare=async output=>{
 const source=path.join(output,'follow-source');fs.mkdirSync(source);
 const key=crypto.randomBytes(32).toString('hex');let scene=null,params={},seq=0,online=true,requests=0;
 const server=http.createServer((req,res)=>{
  if(req.url!=='/v1/wallpaper/snapshot'){res.writeHead(404);res.end();return;}
  if(req.headers.authorization!=='Wallpaper '+key){res.writeHead(401);res.end();return;}
  requests++;
  if(!online){res.writeHead(503);res.end();return;}
  const snapshot={protocol:2,seq:++seq,spectrumSeq:seq,server:{session:'owned-follow-source',edition:'full',version:'1'},valid:true,playing:false,positionMs:0,durationMs:null,generation:'1',spectrum:{bands:Array(64).fill(0),energy:0,ageMs:0},space:scene?{scene,params}:null,timing:'presentation_applied'};
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(snapshot));
 });
 server.on('upgrade',(_req,socket)=>socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 fs.writeFileSync(path.join(source,'wallpaper-key'),key);
 fs.writeFileSync(path.join(source,'vmusicd.json'),JSON.stringify({pid:process.pid,port:server.address().port,version:'1',protocol_version:1,edition:'full',server_instance_id:'owned-follow-source',wallpaper_protocol:2}));
 const file=path.join(output,'config.json'),config=JSON.parse(fs.readFileSync(file));
 const domain=config.activeProfile?config.profiles.find(entry=>JSON.stringify(entry.profile)===JSON.stringify(config.activeProfile)):config.unboundDomain;
 const profile={kind:'standalone',edition:'full',dataDir:source};config.activeProfile=profile;config.profiles=[{...domain,profile}];
 fs.writeFileSync(file,JSON.stringify(config,null,2));
 return {set:(id,values={})=>{scene=id;params=values;online=true;},offline:()=>{online=false;},requests:()=>requests,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
};

exports.verify=async({output,settings,baseline,fixture,checks,pages,until,envelope,inPage,formal,nativeRequest,applyWallpaper,source})=>{
 const state=async()=>(await formal('status')).wallpaper;
 const saved=()=>fs.readFileSync(path.join(output,'config.json'),'utf8');
 const checked=async(command,payload)=>{const reply=await inPage(envelope(command,payload));assert.equal(reply.ok,true,JSON.stringify(reply));return reply.result;};
 const pageFor=id=>until(async()=>{for(const page of pages().filter(page=>page.url().includes('/wallpaper.html'))){try{if(await page.evaluate(id=>hertzWallpaper.debug().session.sessionId===id,id))return page;}catch{}}return null;},'native page '+id);
 const desktop=scene=>until(async()=>{const value=await state();return value.firstFrameReady&&!value.handoff&&!value.candidateLoading&&value.retiringControllers===0&&value.runtimeBuiltin?.sceneId===scene?value:null;},'desktop follows '+scene,30000);
 const preview=scene=>until(async()=>{const value=await state();const p=value.mediaPreview;return p?.firstFrameReady&&!p.handoff&&!p.error&&value.retiringControllers===0&&(!scene||p.runtimeBuiltin?.sceneId===scene)?p:null;},'preview follows '+scene,30000);
 const mode=value=>settings.evaluate(value=>value?localStorage.setItem('follow-acceptance',value):localStorage.removeItem('follow-acceptance'),value);
 await settings.context().addInitScript(()=>{
  if(location.pathname!=='/wallpaper.html')return;
  const mode=localStorage.getItem('follow-acceptance');
  if(mode==='fail'){
   const original=HTMLCanvasElement.prototype.getContext;
   HTMLCanvasElement.prototype.getContext=function(type,...args){return /^webgl|^experimental-webgl/.test(type)?null:original.call(this,type,...args);};
  }
  if(mode==='hold-preview')document.addEventListener('DOMContentLoaded',()=>{
   if(window.__hertzWallpaperNativePointer)return;
   const post=window.chrome.webview.postMessage.bind(window.chrome.webview);window.followNativePost=post;
   window.chrome.webview.postMessage=message=>{
    if(message.startsWith('wallpaper_session ')){
     const event=JSON.parse(message.slice(18)).event;
     if(event==='firstFrame'){window.followHeldFrame=message;return;}
     if(event==='revealed'){window.followHeldReveal=message;return;}
    }post(message);
   };
  },{once:true});
 });
 const follow=structuredClone(baseline);follow.groups[0].selection={kind:'followHertz',idleBuiltin:{sceneId:'zodiac',stateVersion:1,params:{}}};
 source.set('coast');assert.equal((await applyWallpaper(follow,'follow-native-owner')).receipt.ok,true);
 let current=await desktop('coast');const intent=saved();let oldPage=await pageFor(current.session.binding.sessionId);
 assert.equal(await oldPage.evaluate(()=>hertzWallpaper.debug().source),'fixed');
 await oldPage.evaluate(()=>{window.captureOriginal=hertzWallpaper.requestCapture;hertzWallpaper.requestCapture=request=>{window.captureHeld=request;return true;};});
 source.set('reactor');
 const pending=await until(async()=>{const value=await state();return value.handoff&&!value.handoff.captured?value:null;},'feed requests native capture');
 assert.equal(oldPage.isClosed(),false);assert.equal(pending.runtimeBuiltin.sceneId,'coast');
 source.set('prism-galaxy');await delay(650);
 await oldPage.evaluate(()=>captureOriginal(captureHeld));
 current=await desktop('prism-galaxy');assert.equal(oldPage.isClosed(),true);assert.equal(saved(),intent);assert.equal(current.budget.contexts,1);
 checks.push({name:'authenticated feed changes coalesce behind the native source capture; latest scene gets a new controller without saving intent',pending,current,requests:source.requests()});
 source.offline();const idle=await desktop('zodiac');assert.equal(saved(),intent);
 source.set('coast',{invented:true});await delay(800);assert.equal((await state()).runtimeBuiltin.sceneId,'zodiac');
 source.set('coast');current=await desktop('coast');
 checks.push({name:'source disconnect and invalid scene parameters use the configured idle through native handoff, then recover on a fresh valid projection',idle,current});
 const same=current.session.binding.sessionId;source.set('coast',{tod:0});await delay(800);assert.equal((await state()).session.binding.sessionId,same,'normalized equal parameters do not restart');
 source.set('coast',{tod:.5});
 const parameterChange=await until(async()=>{const value=await state();return value.runtimeBuiltin?.params.tod===.5&&!value.handoff&&!value.candidateLoading?value:null;},'same-scene parameters cross native handoff');
 assert.notEqual(parameterChange.session.binding.sessionId,same);assert.equal(saved(),intent);
 checks.push({name:'normalized duplicate feed parameters keep the controller; a real parameter change gets a new generation without altering saved intent',parameterChange});
 await mode('fail');source.set('reactor');
 const failed=await until(async()=>{const value=await state();return value.applyError&&value.handoff?.visible&&value.handoff.workspaceReleased&&!value.session&&value.retiringControllers===0?value:null;},'failed follow candidate retains old bitmap after workspace exit');
 assert.equal(failed.runtimeBuiltin.sceneId,'coast');assert.equal(failed.budget.contexts,0);assert.equal(saved(),intent);
 assert.equal(failed.budget.prepareCpuBytes,0);assert.equal(failed.budget.resourceAllocations,1);
 assert.equal(failed.budget.gpuBytes,failed.handoff.targetWidth*failed.handoff.targetHeight*8);
 await mode(null);await nativeRequest({command:'wallpaper-retry'});current=await desktop('reactor');
 checks.push({name:'failed followed scene retains old bitmap with saved follow intent; explicit retry resolves the latest native feed',failed,current});

 let draft=await checked('wallpaper.draft.create',{kind:'settings'});
 const update=async wallpaper=>{draft=await checked('wallpaper.draft.update',{draftId:draft.draftId,draftRevision:draft.draftRevision,operations:[{kind:'replaceWallpaper',wallpaper}]});return {draftId:draft.draftId,draftRevision:draft.draftRevision};};
 let reference=await update(follow),lease=await checked('wallpaper.preview.acquire',reference);
 let firstPreview=await preview('reactor');oldPage=await pageFor(firstPreview.binding.sessionId);
 await mode('hold-preview');source.set('coast');
 const frozen=await until(async()=>{const value=await state();return value.mediaPreview?.handoff?.sourceClosed&&value.mediaPreview.handoff.workspaceReleased&&value.mediaPreview.handoff.visible&&value.mediaPreview.binding?value:null;},'native preview bitmap after capture workspace exit and before first frame');
 assert.equal(oldPage.isClosed(),true);assert.ok(frozen.mediaPreview.handoff.presentations>0);
 const candidate=await pageFor(frozen.mediaPreview.binding.sessionId);await candidate.waitForFunction(()=>!!window.followHeldFrame);
 assert.equal((await state()).mediaPreview.firstFrameReady,false);assert.equal(frozen.budget.previewInstances,1);
 await candidate.evaluate(()=>followNativePost(followHeldFrame));await candidate.waitForFunction(()=>!!window.followHeldReveal);
 const beforeReveal=await until(async()=>{const value=await state();return value.mediaPreview?.handoff?.visible&&!value.handoff&&!value.retiringHandoffs&&value.retiringControllers===0?value:null;},'only preview bitmap remains before reveal');
 assert.equal(beforeReveal.mediaPreview.runtimeBuiltin.sceneId,'reactor');assert.ok(beforeReveal.mediaPreview.handoff.visible);
 assert.equal(beforeReveal.budget.prepareCpuBytes,0);assert.equal(beforeReveal.budget.resourceAllocations,5,'桌面与新预览 GL 各两个子额度加保留位图');
 assert.equal(beforeReveal.budget.gpuBytes,beforeReveal.glLimits.gpuBytes+beforeReveal.mediaPreview.glLimits.gpuBytes+beforeReveal.mediaPreview.handoff.targetWidth*beforeReveal.mediaPreview.handoff.targetHeight*8);
 await candidate.evaluate(()=>{const receipt=JSON.parse(followHeldReveal.slice(18));followNativePost('wallpaper_session '+JSON.stringify({...receipt,generation:receipt.generation+1}));});
 assert.ok((await state()).mediaPreview.handoff,'wrong reveal generation cannot retire preview bitmap');
 await candidate.evaluate(()=>followNativePost(followHeldReveal));await mode(null);current=await desktop('coast');const revealed=await preview('coast');
 assert.equal(revealed.leaseId,lease.leaseId);assert.equal(saved(),intent);
 checks.push({name:'followed desktop and independent preview use separate captured frames and real Close gates; preview keeps its lease and waits for reveal',frozen,beforeReveal,revealed,current});

 const transitions=[];
 for(const kind of ['image','video','gl']){
  const old=await preview(),page=await pageFor(old.binding.sessionId),next=structuredClone(baseline);
  next.groups[0].selection=kind==='gl'?{kind:'builtin',sceneId:'zodiac',stateVersion:1,params:{}}:{kind:'package',...fixture[kind]};
  reference=await update(next);await checked('wallpaper.preview.update',{...reference,leaseId:lease.leaseId});
  const after=await preview();assert.equal(page.isClosed(),true);assert.notEqual(after.binding.sessionId,old.binding.sessionId);assert.equal(after.leaseId,lease.leaseId);
  assert.equal((await pageFor(after.binding.sessionId)).isClosed(),false);assert.equal(saved(),intent);transitions.push({kind,after});
 }
 checks.push({name:'preview draft GL/image/video switches retain the last frame and retire each old controller without changing saved settings',transitions});

 await mode('hold-preview');const superseding=structuredClone(baseline);superseding.groups[0].selection={kind:'builtin',sceneId:'coast',stateVersion:1,params:{}};
 reference=await update(superseding);await checked('wallpaper.preview.update',{...reference,leaseId:lease.leaseId});
 const held=await until(async()=>{for(const page of pages().filter(page=>page.url().includes('/wallpaper.html'))){try{if(await page.evaluate(()=>!!window.followHeldFrame&&!window.__hertzWallpaperNativePointer))return page;}catch{}}return null;},'held preview before superseding update');
 await held.evaluate(()=>followNativePost(followHeldFrame));await held.waitForFunction(()=>!!window.followHeldReveal);
 const superseded=(await state()).mediaPreview;
 superseding.groups[0].selection={kind:'builtin',sceneId:'reactor',stateVersion:1,params:{}};
 reference=await update(superseding);await checked('wallpaper.preview.update',{...reference,leaseId:lease.leaseId});
 await held.evaluate(()=>followNativePost(followHeldReveal)).catch(()=>{});
 const replacement=await until(async()=>{for(const page of pages().filter(page=>page!==held&&page.url().includes('/wallpaper.html'))){try{if(await page.evaluate(()=>!!window.followHeldFrame&&!window.__hertzWallpaperNativePointer))return page;}catch{}}return null;},'replacement held preview');
 const replaced=(await state()).mediaPreview;assert.equal(held.isClosed(),true);assert.equal(replaced.handoff.hwnd,superseded.handoff.hwnd);assert.equal(replaced.handoff.bgraSha256,superseded.handoff.bgraSha256);
 await replacement.evaluate(()=>followNativePost(followHeldFrame));await replacement.waitForFunction(()=>!!window.followHeldReveal);await replacement.evaluate(()=>followNativePost(followHeldReveal));await mode(null);await preview('reactor');
 checks.push({name:'a newer preview draft invalidates the previous reveal and reuses the original static frame until the latest generation reveals',superseded,replaced});

 await mode('fail');const next=structuredClone(baseline);next.groups[0].selection={kind:'builtin',sceneId:'coast',stateVersion:1,params:{}};
 reference=await update(next);await checked('wallpaper.preview.update',{...reference,leaseId:lease.leaseId});
 const previewFailed=await until(async()=>{const value=await state();return value.mediaPreview?.error&&value.mediaPreview.handoff?.visible&&value.mediaPreview.handoff.workspaceReleased&&value.retiringControllers===0?value:null;},'failed preview retains static image after workspace exit');
 assert.equal(previewFailed.budget.contexts,1);assert.equal(previewFailed.budget.previewInstances,0);assert.equal(saved(),intent);
 assert.equal(previewFailed.budget.prepareCpuBytes,0);assert.equal(previewFailed.budget.resourceAllocations,3,'桌面 GL 两个子额度加保留位图');
 assert.equal(previewFailed.budget.gpuBytes,previewFailed.glLimits.gpuBytes+previewFailed.mediaPreview.handoff.targetWidth*previewFailed.mediaPreview.handoff.targetHeight*8);
 await mode(null);await checked('wallpaper.preview.update',{...reference,leaseId:lease.leaseId});const retry=await preview('coast');assert.equal(retry.leaseId,lease.leaseId);
 const retryPage=await pageFor(retry.binding.sessionId);
 await retryPage.evaluate(()=>{window.restoreCapture=hertzWallpaper.requestCapture;hertzWallpaper.requestCapture=()=>true;});
 next.groups[0].selection={kind:'builtin',sceneId:'reactor',stateVersion:1,params:{}};
 reference=await update(next);await checked('wallpaper.preview.update',{...reference,leaseId:lease.leaseId});
 const captureTimeout=await until(async()=>{const value=await state();return value.mediaPreview?.error&&!value.mediaPreview.handoff&&value.retiringHandoffs===1?value:null;},'unconfirmed preview capture retains old renderer and budget');
 assert.equal(retryPage.isClosed(),false);assert.equal(captureTimeout.budget.previewInstances,1);assert.equal(captureTimeout.budget.releasePending,1);assert.equal(saved(),intent);
 assert.ok(captureTimeout.budget.prepareCpuBytes>=64*1048576,'unconfirmed preview capture remains charged');
 await retryPage.evaluate(()=>{hertzWallpaper.requestCapture=window.restoreCapture;});
 await checked('wallpaper.preview.update',{...reference,leaseId:lease.leaseId});await preview('reactor');assert.equal(retryPage.isClosed(),true);
 checks.push({name:'unconfirmed preview capture preserves its live source and outstanding workspace until an explicit update closes it',captureTimeout});

 const finalPreview=await preview('reactor'),finalPage=await pageFor(finalPreview.binding.sessionId);
 await finalPage.evaluate(()=>{hertzWallpaper.requestCapture=()=>true;});
 next.groups[0].selection={kind:'builtin',sceneId:'coast',stateVersion:1,params:{}};
 reference=await update(next);await checked('wallpaper.preview.update',{...reference,leaseId:lease.leaseId});
 await until(async()=>(await state()).mediaPreview?.handoff&&!((await state()).mediaPreview.handoff.captured),'preview capture pending at release');
 await checked('wallpaper.preview.release',{leaseId:lease.leaseId});await checked('wallpaper.draft.discard',reference);
 const drained=await until(async()=>{const value=await state();return !value.previewActive&&!value.retiringHandoffs&&value.retiringControllers===0?value:null;},'preview frame and source fully exit');
 assert.equal(drained.budget.sessionReservations,1);assert.equal(drained.budget.resourceAllocations,2);assert.equal(drained.budget.prepareCpuBytes,0);
 assert.equal(finalPage.isClosed(),true);
 checks.push({name:'failed updated preview keeps its bitmap and lease; updating again retries, release drains every snapshot and controller resource',previewFailed,retry,drained});
 assert.equal((await applyWallpaper(baseline,'follow-restore-baseline')).receipt.ok,true);await desktop('zodiac');
};
