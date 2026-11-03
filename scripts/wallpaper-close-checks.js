// SPDX-License-Identifier: MIT
// Real native desktop/preview lifetimes; only Close failure injection requires the debug feature.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

module.exports=async function({output,settings,baseline,fixture,checks,pages,until,envelope,inPage,formal,applyWallpaper}) {
 const state=async()=>(await formal('status')).wallpaper;
 const saved=()=>fs.readFileSync(path.join(output,'config.json'),'utf8');
 const pageFor=id=>until(async()=>{for(const page of pages().filter(page=>page.url().includes('/wallpaper.html'))){try{if(await page.evaluate(id=>hertzWallpaper.debug().session.sessionId===id,id))return page;}catch{}}return null;},'owned native page '+id);
 const steady=()=>until(async()=>{const value=await state();return value.firstFrameReady&&!value.handoff&&!value.candidateLoading&&!value.retiringHandoffs&&value.retiringControllers===0?value:null;},'successor reveals after real Close',30000);
 const apply=async(wallpaper,label)=>{const reply=await applyWallpaper(wallpaper,label);assert.equal(reply.receipt.ok,true,JSON.stringify(reply));return reply;};
 const checked=async(command,payload)=>{const reply=await inPage(envelope(command,payload));assert.equal(reply.ok,true,JSON.stringify(reply));return reply.result;};
 const retirement=(value,binding)=>value.retirements.find(entry=>entry.generation===binding.generation&&entry.sessionId===binding.sessionId);
 function assertBlocked(value,binding) {
  const entry=retirement(value,binding);assert.ok(entry,'the exact old controller still has an exit owner');
  assert.equal(entry.controllerClosed,false);assert.equal(entry.closeError,'0x80004005');assert.ok(entry.closeAttempts>0);assert.ok(entry.closeFailedAgeMs>=0);
  assert.ok(value.budget.releasePending>0);return entry;
 }
 let nonce=90000;
 async function probe(page,binding,blocked,ack=true) {
  const request={nonce:++nonce,sessionId:binding.sessionId,generation:binding.generation,blocked};
  await page.evaluate(request=>window.ipc.postMessage('wallpaper_probe_close '+JSON.stringify(request)),request);
  if(!ack)return;
  await page.waitForFunction(nonce=>window.__nativeCloseProbe?.nonce===nonce,request.nonce,{timeout:5000});
  return page.evaluate(()=>window.__nativeCloseProbe);
 }
 let current=await steady(),oldBinding=current.session.binding,oldPage=await pageFor(oldBinding.sessionId);
 assert.equal((await probe(oldPage,oldBinding,true)).accepted,true,'requires wallpaper-media-probe debug build');
 const next=structuredClone(baseline);next.groups[0].selection={kind:'builtin',sceneId:'coast',stateVersion:1,params:{}};
 await apply(next,'close-failed-desktop');const intent=saved();
 const blocked=await until(async()=>{const value=await state();return value.handoff?.captured&&value.handoff.visible&&retirement(value,oldBinding)?.closeError?value:null;},'Close failure keeps the captured frame and original controller');
 assertBlocked(blocked,oldBinding);assert.equal(blocked.handoff.sourceClosed,false);assert.equal(blocked.handoff.workspaceReleased,false);
 assert.equal(blocked.budget.contexts,1);assert.equal(blocked.budget.resourceAllocations,3);assert.ok(blocked.budget.prepareCpuBytes>0);
 assert.equal(blocked.firstFrameReady,false);assert.equal(oldPage.isClosed(),false);assert.equal(pages().filter(page=>page.url().includes('/wallpaper.html')).length,1);
 const wrong=await probe(oldPage,{...oldBinding,generation:oldBinding.generation+1},false);assert.equal(wrong.accepted,false);assert.equal(wrong.blocked,true);
 await delay(3200);const stillBlocked=await state();assertBlocked(stillBlocked,oldBinding);
 assert.equal(stillBlocked.handoff.hwnd,blocked.handoff.hwnd);assert.equal(stillBlocked.handoff.sourceClosed,false);assert.equal(stillBlocked.handoff.workspaceReleased,false);
 assert.equal(stillBlocked.budget.prepareCpuBytes,blocked.budget.prepareCpuBytes);assert.equal(saved(),intent);assert.equal(settings.isClosed(),false);
 await probe(oldPage,oldBinding,false,false);current=await steady();assert.equal(oldPage.isClosed(),true);assert.equal(current.budget.contexts,1);assert.equal(current.budget.prepareCpuBytes,0);assert.equal(current.budget.resourceAllocations,1);
 checks.push({name:'failed native desktop Close retains source, captured frame and all budgets past the timeout; matching source release permits a real successor',blocked,stillBlocked,current});

 let draft=await checked('wallpaper.draft.create',{kind:'settings'});
 const update=async config=>{draft=await checked('wallpaper.draft.update',{draftId:draft.draftId,draftRevision:draft.draftRevision,operations:[{kind:'replaceWallpaper',wallpaper:config}]});return {draftId:draft.draftId,draftRevision:draft.draftRevision};};
 let reference=await update(baseline),lease=await checked('wallpaper.preview.acquire',reference);
 const preview=()=>until(async()=>{const value=await state();return value.mediaPreview?.firstFrameReady&&!value.mediaPreview.handoff&&!value.mediaPreview.error&&value.retiringControllers===0?value.mediaPreview:null;},'preview successor revealed',30000);
 const first=await preview();oldBinding=first.binding;oldPage=await pageFor(oldBinding.sessionId);
 assert.equal((await probe(oldPage,oldBinding,true)).accepted,true);
 reference=await update(next);await checked('wallpaper.preview.update',{...reference,leaseId:lease.leaseId});
 const previewBlocked=await until(async()=>{const value=await state();return value.mediaPreview?.handoff?.captured&&retirement(value,oldBinding)?.closeError?value:null;},'preview update waits for failed Close');
 assertBlocked(previewBlocked,oldBinding);assert.equal(previewBlocked.mediaPreview.handoff.sourceClosed,false);assert.equal(previewBlocked.mediaPreview.handoff.workspaceReleased,false);
 assert.equal(previewBlocked.budget.contexts,2);assert.equal(previewBlocked.budget.previewInstances,1);assert.equal(previewBlocked.budget.resourceAllocations,4);
 const desktopPage=await pageFor(current.session.binding.sessionId);
 assert.equal((await probe(desktopPage,oldBinding,false)).accepted,false,'one native controller cannot release another controller gate');
 const newest=structuredClone(next);newest.groups[0].selection={kind:'builtin',sceneId:'reactor',stateVersion:1,params:{}};
 reference=await update(newest);await checked('wallpaper.preview.update',{...reference,leaseId:lease.leaseId});
 await delay(3200);const previewLatest=await state();assertBlocked(previewLatest,oldBinding);
 assert.equal(previewLatest.mediaPreview.handoff.hwnd,previewBlocked.mediaPreview.handoff.hwnd);assert.equal(previewLatest.mediaPreview.leaseId,lease.leaseId);
 assert.equal(previewLatest.budget.contexts,2);assert.equal(previewLatest.budget.prepareCpuBytes,previewBlocked.budget.prepareCpuBytes);assert.equal(saved(),intent);
 await probe(oldPage,oldBinding,false,false);const recoveredPreview=await preview();assert.equal(oldPage.isClosed(),true);
 assert.equal(recoveredPreview.runtimeBuiltin.sceneId,'reactor');assert.equal(recoveredPreview.leaseId,lease.leaseId);assert.equal((await state()).budget.prepareCpuBytes,0);
 checks.push({name:'failed preview Close retains the lease and storage; cross-controller release is refused and latest draft reveals only after actual Close',previewBlocked,previewLatest,recoveredPreview});

 oldBinding=recoveredPreview.binding;oldPage=await pageFor(oldBinding.sessionId);assert.equal((await probe(oldPage,oldBinding,true)).accepted,true);
 reference=await update(next);await checked('wallpaper.preview.update',{...reference,leaseId:lease.leaseId});
 await until(async()=>{const value=await state();return value.mediaPreview?.handoff?.captured&&retirement(value,oldBinding)?.closeError;},'preview source retained at lease release');
 await checked('wallpaper.preview.release',{leaseId:lease.leaseId});await checked('wallpaper.draft.discard',reference);
 await delay(1200);const released=await state();assertBlocked(released,oldBinding);
 assert.equal(released.previewActive,false);assert.equal(released.budget.previewInstances,1,'ending the consumer does not free its failed native exit');
 assert.equal(released.budget.contexts,2);assert.ok(released.budget.prepareCpuBytes>0);assert.equal(oldPage.isClosed(),false);
 await probe(oldPage,oldBinding,false,false);
 const drained=await until(async()=>{const value=await state();return !value.previewActive&&!value.retiringHandoffs&&value.retiringControllers===0?value:null;},'released preview eventually drains real native and bitmap exits');
 assert.equal(oldPage.isClosed(),true);assert.equal(drained.budget.previewInstances,0);assert.equal(drained.budget.contexts,1);assert.equal(drained.budget.prepareCpuBytes,0);assert.equal(drained.budget.resourceAllocations,1);assert.equal(saved(),intent);
 checks.push({name:'preview release while Close fails ends the lease but retains all exit ownership and budgets until its real source closes',released,drained});

 const video=structuredClone(baseline);video.groups[0].selection={kind:'package',...fixture.video};
 await apply(video,'close-video-source');current=await steady();oldBinding=current.session.binding;oldPage=await pageFor(oldBinding.sessionId);
 assert.equal((await probe(oldPage,oldBinding,true)).accepted,true);await apply(next,'close-video-to-gl');
 const videoBlocked=await until(async()=>{const value=await state();const entry=retirement(value,oldBinding);return value.handoff?.captured&&entry?.closeError&&entry.fileReadersDrained?value:null;},'file readers exit while video controller Close still fails');
 assertBlocked(videoBlocked,oldBinding);assert.equal(videoBlocked.budget.decoderSlots,1);assert.equal(videoBlocked.budget.contexts,0);
 assert.equal(videoBlocked.budget.resourceAllocations,4);assert.equal(videoBlocked.handoff.sourceClosed,false);assert.ok(videoBlocked.budget.prepareCpuBytes>0);
 await delay(350);const time=await oldPage.evaluate(()=>document.querySelector('video').currentTime);await delay(700);
 assert.ok(Math.abs(await oldPage.evaluate(()=>document.querySelector('video').currentTime)-time)<.12,'the retained failed-close decoder stays stopped');
 await probe(oldPage,oldBinding,false,false);current=await steady();assert.equal(oldPage.isClosed(),true);assert.equal(current.budget.decoderSlots,0);assert.equal(current.budget.contexts,1);
 checks.push({name:'video file-reader drain cannot release decoder or capture workspace while native Close fails; successful Close allows GL admission',videoBlocked,current});

 await apply(video,'close-disable-video');current=await steady();oldBinding=current.session.binding;oldPage=await pageFor(oldBinding.sessionId);
 assert.equal((await probe(oldPage,oldBinding,true)).accepted,true);
 const disabled=structuredClone(video);disabled.enabled=false;await apply(disabled,'close-disabled-owner');
 const disabledBlocked=await until(async()=>{const value=await state();return !value.enabled&&retirement(value,oldBinding)?.closeError?value:null;},'disabled desktop retains its failed exit');
 assertBlocked(disabledBlocked,oldBinding);assert.equal(disabledBlocked.budget.decoderSlots,1);assert.equal(disabledBlocked.budget.resourceReleasePending,2);
 assert.equal(disabledBlocked.handoff,null);assert.equal(oldPage.isClosed(),false);
 await probe(oldPage,oldBinding,false,false);
 const empty=await until(async()=>{const value=await state();return !value.enabled&&value.retiringControllers===0?value:null;},'disabled owner fully exits');
 assert.equal(oldPage.isClosed(),true);assert.ok(Object.values(empty.budget).every(value=>value===0));assert.deepEqual(empty.retirements,[]);
 checks.push({name:'disabled media does not recreate a controller or return its decoder after failed Close; actual Close drains every budget and record',disabledBlocked,empty});
 await apply(baseline,'close-restore-baseline');await steady();
};
