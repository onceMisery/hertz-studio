// SPDX-License-Identifier: MIT
// Ordinary native acceptance; run through --handoff on a private fixture copy.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
module.exports=async function({output,settings,baseline,checks,pages,until,formal,nativeRequest,applyWallpaper,ownedPid}){
 const state=async()=>(await formal('status')).wallpaper;
 const saved=()=>JSON.parse(fs.readFileSync(path.join(output,'config.json'),'utf8'));
 const steady=()=>until(async()=>{const value=await state();return value.visible&&value.firstFrameReady&&!value.handoff&&!value.retiringHandoffs&&value.retiringControllers===0&&value.appliedRevision===saved().revision?value:null;},'steady native presentation after bitmap exit',30000);
 const findPage=async id=>until(async()=>{for(const page of pages().filter(page=>page.url().includes('/wallpaper.html'))){try{if(await page.evaluate(id=>hertzWallpaper.debug().session.sessionId===id,id))return page;}catch{}}return null;},'owned renderer '+id);
 const apply=async(config,label)=>{const reply=await applyWallpaper(config,label);assert.equal(reply.receipt.ok,true,JSON.stringify(reply));return reply;};
 const mode=value=>settings.evaluate(value=>value?localStorage.setItem('handoff-acceptance',value):localStorage.removeItem('handoff-acceptance'),value);
 await settings.context().addInitScript(()=>{
  if(location.pathname!=='/wallpaper.html')return;
  const mode=localStorage.getItem('handoff-acceptance');
  if(mode==='fail-gl'){
   const original=HTMLCanvasElement.prototype.getContext;
   HTMLCanvasElement.prototype.getContext=function(type,...args){return /^webgl|^experimental-webgl/.test(type)?null:original.call(this,type,...args);};
  }
  if(mode==='hold-receipts')document.addEventListener('DOMContentLoaded',()=>{
   const post=window.chrome.webview.postMessage.bind(window.chrome.webview);window.handoffNativePost=post;
   window.chrome.webview.postMessage=message=>{
    if(message.startsWith('wallpaper_session ')){
     const receipt=JSON.parse(message.slice(18));
     if(receipt.event==='firstFrame'){window.handoffHeldFrame=message;return;}
     if(receipt.event==='revealed'){window.handoffHeldReveal=message;return;}
    }
    post(message);
   };
  },{once:true});
 });
 const high=structuredClone(baseline);high.groups[0].presentation.quality='high';high.groups[0].presentation.fps=60;
 await apply(high,'handoff-high-source');let original=await steady(),oldPage=await findPage(original.session.binding.sessionId);
 assert.equal(original.glLimits.quality,'high');assert.equal(original.budget.gpuBytes,192*1048576);
 await mode('hold-receipts');
 const next=structuredClone(high);next.groups[0].selection={kind:'builtin',sceneId:'coast',stateVersion:1,params:{}};
 await apply(next,'handoff-full-envelope');
 const frozen=await until(async()=>{const value=await state();return value.handoff?.visible&&value.handoff.sourceClosed&&value.handoff.workspaceReleased&&value.candidateLoading?value:null;},'old controller and capture workspace exit behind painted native bitmap');
 assert.equal(oldPage.isClosed(),true);assert.ok(frozen.handoff.presentations>0);assert.match(frozen.handoff.bgraSha256,/^[0-9a-f]{64}$/);
 const candidate=await until(()=>pages().find(page=>page.url().includes('/wallpaper.html')),'new GL candidate');
 await candidate.waitForFunction(()=>!!window.handoffHeldFrame);
 const pending=await state();assert.equal(pending.firstFrameReady,false);assert.equal(pending.budget.contexts,1);
 assert.equal(pending.budget.sessionReservations,2);assert.equal(pending.budget.resourceAllocations,2);
 assert.equal(pending.budget.prepareCpuBytes,0,'exited capture workspace returns before the retained bitmap reveals');
 assert.equal(pending.budget.cpuBytes,pending.handoff.width*pending.handoff.height*4);
 assert.equal(pending.budget.resourceRecords,3,'workspace tombstone stays bounded under the still-live frame parent');
 assert.equal(pending.budget.targets,2);assert.equal(pending.budget.decoderSlots,0);
 const limits=await candidate.evaluate(()=>HertzGlBudget.limits);
 assert.equal(limits.quality,'high');assert.equal(limits.gpuBytes,192*1048576);
 assert.equal(pending.budget.gpuBytes,limits.gpuBytes+pending.handoff.targetWidth*pending.handoff.targetHeight*8);
 assert.equal(pending.budget.outputPixelRate,original.budget.outputPixelRate,'closing the old scene leaves the full same target rate available');
 // Print only the verified test-owned frame HWND; never capture another app/window.
 const capturePath=path.join(output,'native-handoff-frame.png');
 const script=`Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;using System.Runtime.InteropServices;
public class HertzFrameCapture {
 [StructLayout(LayoutKind.Sequential)]public struct R{public int L,T,Rt,B;}
 [DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out R r);
 [DllImport("user32.dll")]public static extern bool PrintWindow(IntPtr h,IntPtr d,uint f);
}
'@
$frameHwnd=[IntPtr]${frozen.handoff.hwnd};$framePid=0;[void][HertzFrameCapture]::GetWindowThreadProcessId($frameHwnd,[ref]$framePid)
if($framePid -ne ${ownedPid}){throw 'Frame owner mismatch'}
$rect=New-Object HertzFrameCapture+R;if(-not [HertzFrameCapture]::GetWindowRect($frameHwnd,[ref]$rect)){throw 'Frame rect failed'}
$width=$rect.Rt-$rect.L;$height=$rect.B-$rect.T;if($width -le 0 -or $height -le 0 -or [long]$width*$height -gt 16777216){throw 'Capture dimensions exceed bound'}
$bitmap=New-Object System.Drawing.Bitmap($width,$height);$graphics=[System.Drawing.Graphics]::FromImage($bitmap);$dc=$graphics.GetHdc()
try{if(-not [HertzFrameCapture]::PrintWindow($frameHwnd,$dc,1)){throw 'Owned frame print failed'}}finally{$graphics.ReleaseHdc($dc)}
$bitmap.Save('${capturePath.replace(/'/g,"''")}',[System.Drawing.Imaging.ImageFormat]::Png);$graphics.Dispose();$bitmap.Dispose()`;
 execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:'pipe'});
 const sharp=require(process.env.SHARP_MODULE||'C:/Users/miracle/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
 const pixels=await sharp(capturePath).stats();assert.ok(pixels.channels.some(channel=>channel.stdev>1),'native bitmap contains rendered image detail');
 await candidate.evaluate(()=>{
  const receipt=JSON.parse(handoffHeldFrame.slice(18));
  handoffNativePost('wallpaper_session '+JSON.stringify({...receipt,generation:receipt.generation+1}));
 });
 assert.equal((await state()).firstFrameReady,false);
 await candidate.evaluate(()=>handoffNativePost(handoffHeldFrame));
 await candidate.waitForFunction(()=>!!window.handoffHeldReveal);
 const beforeReveal=await state();assert.equal(beforeReveal.handoff.bgraSha256,frozen.handoff.bgraSha256);assert.ok(beforeReveal.handoff.visible);
 assert.equal(beforeReveal.appliedRevision,original.appliedRevision);assert.deepEqual(beforeReveal.appliedSelection,original.appliedSelection);
 await candidate.evaluate(()=>handoffNativePost(handoffHeldReveal));
 let current=await steady();assert.equal(current.budget.contexts,1);assert.equal(current.budget.resourceAllocations,1);assert.equal(current.budget.prepareCpuBytes,0);
 checks.push({name:'full GL envelope switches through a painted native bitmap; old controller exits before new admission and bitmap stays until typed reveal',original,frozen,pending,beforeReveal,current,capturePath});

 await mode('fail-gl');oldPage=await findPage(current.session.binding.sessionId);
 await apply(high,'handoff-candidate-failure');
 const failed=await until(async()=>{const value=await state();return value.applyError&&!value.candidateLoading&&!value.session&&value.handoff?.visible&&value.handoff.workspaceReleased&&value.retiringControllers===0?value:null;},'failed new GL keeps native old frame after workspace exit');
 assert.equal(oldPage.isClosed(),true);assert.equal(failed.budget.contexts,0);assert.equal(failed.budget.decoderSlots,0);
 assert.equal(failed.budget.sessionReservations,1);assert.equal(failed.budget.resourceAllocations,1);
 assert.equal(failed.budget.prepareCpuBytes,0);
 assert.equal(failed.budget.gpuBytes,failed.handoff.targetWidth*failed.handoff.targetHeight*8);
 const intent=fs.readFileSync(path.join(output,'config.json'),'utf8');
 await nativeRequest({command:'wallpaper-hide'});
 const hidden=await state();assert.equal(hidden.handoff.visible,false);assert.equal(hidden.budget.contexts,0);
 await nativeRequest({command:'wallpaper-show'});
 const shown=await until(async()=>{const value=await state();return value.handoff?.visible?value:null;},'retained bitmap follows manual pause');
 assert.equal(shown.handoff.hwnd,failed.handoff.hwnd);assert.equal(shown.handoff.bgraSha256,failed.handoff.bgraSha256);
 const destroyScript=`Add-Type @'
using System;using System.Runtime.InteropServices;
public class HertzOwnedFrameClose {
 [DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")]public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,IntPtr w,IntPtr l,uint f,uint t,out UIntPtr r);
}
'@
$frameHwnd=[IntPtr]${failed.handoff.hwnd};$framePid=0;[void][HertzOwnedFrameClose]::GetWindowThreadProcessId($frameHwnd,[ref]$framePid)
if($framePid -ne ${ownedPid}){throw 'Frame owner mismatch'}
$reply=[UIntPtr]::Zero;if([HertzOwnedFrameClose]::SendMessageTimeout($frameHwnd,16,[IntPtr]::Zero,[IntPtr]::Zero,2,3000,[ref]$reply) -eq [IntPtr]::Zero){throw 'Frame close failed'}`;
 execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',destroyScript],{windowsHide:true,stdio:'pipe'});
 const lostFrame=await until(async()=>{const value=await state();return value.applyError&&!value.handoff&&!value.retiringHandoffs&&!value.session?value:null;},'destroyed native bitmap releases its owner');
 assert.ok(Object.values(lostFrame.budget).every(value=>value===0));
 await new Promise(resolve=>setTimeout(resolve,1200));assert.equal((await state()).session,null,'lost failure frame waits for explicit retry');
 await mode(null);await nativeRequest({command:'wallpaper-retry'});current=await steady();
 assert.equal(fs.readFileSync(path.join(output,'config.json'),'utf8'),intent);assert.equal(current.budget.prepareCpuBytes,0);
 checks.push({name:'candidate failure retains only the native bitmap and saved intent; manual pause and owned-HWND loss are tracked, explicit retry succeeds',failed,hidden,shown,lostFrame,current});

 oldPage=await findPage(current.session.binding.sessionId);
 await oldPage.evaluate(()=>{window.originalCapture=hertzWallpaper.requestCapture;hertzWallpaper.requestCapture=request=>{window.delayedCapture=request;return true;};});
 await apply(next,'handoff-capture-timeout');
 const timedOut=await until(async()=>{const value=await state();return value.applyError&&!value.candidateLoading&&!value.handoff&&value.retiringHandoffs===1?value:null;},'capture timeout preserves live old controller and reserves outstanding workspace');
 assert.equal(oldPage.isClosed(),false);assert.equal(timedOut.budget.contexts,1);assert.equal(timedOut.budget.releasePending,1);assert.equal(timedOut.budget.resourceReleasePending,2);
 assert.ok(timedOut.budget.prepareCpuBytes>=64*1048576,'unconfirmed timeout does not use the early workspace release path');
 await oldPage.evaluate(()=>{hertzWallpaper.requestCapture=window.originalCapture;});
 await nativeRequest({command:'wallpaper-retry'});current=await steady();
 assert.equal(oldPage.isClosed(),true);assert.equal(current.budget.releasePending,0);assert.equal(current.budget.prepareCpuBytes,0);
 checks.push({name:'unconfirmed capture keeps its workspace charged until the real source controller exits on retry',timedOut,current});

 await mode('hold-receipts');await apply(high,'handoff-paused-reveal');
 let heldPage=await until(async()=>{for(const page of pages().filter(page=>page.url().includes('/wallpaper.html'))){try{if(await page.evaluate(()=>!!window.handoffHeldFrame))return page;}catch{}}return null;},'held first frame before pause');
 await heldPage.evaluate(()=>handoffNativePost(handoffHeldFrame));
 await heldPage.waitForFunction(()=>!!window.handoffHeldReveal);
 const revealPending=await state();await nativeRequest({command:'wallpaper-hide'});
 await new Promise(resolve=>setTimeout(resolve,3500));
 const pausedReveal=await state();assert.equal(pausedReveal.session.binding.sessionId,revealPending.session.binding.sessionId);
 assert.equal(pausedReveal.handoff.hwnd,revealPending.handoff.hwnd);assert.equal(pausedReveal.handoff.visible,false);assert.equal(pausedReveal.applyError,null);
 await nativeRequest({command:'wallpaper-show'});
 const revealTimeout=await until(async()=>{const value=await state();return value.applyError&&!value.session&&value.handoff?.visible&&value.retiringControllers===0?value:null;},'missing reveal times out only after resume',7000);
 assert.equal(heldPage.isClosed(),true);assert.equal(revealTimeout.budget.contexts,0);assert.equal(revealTimeout.handoff.bgraSha256,revealPending.handoff.bgraSha256);
 await mode(null);await nativeRequest({command:'wallpaper-retry'});current=await steady();
 checks.push({name:'manual pause preserves the bitmap and reveal deadline; missing reveal after resume closes new controller and explicit retry succeeds',revealPending,pausedReveal,revealTimeout,current});

 await mode('hold-receipts');await apply(next,'handoff-superseded-reveal');
 heldPage=await until(async()=>{for(const page of pages().filter(page=>page.url().includes('/wallpaper.html'))){try{if(await page.evaluate(()=>!!window.handoffHeldFrame))return page;}catch{}}return null;},'first superseded renderer');
 await heldPage.evaluate(()=>handoffNativePost(handoffHeldFrame));await heldPage.waitForFunction(()=>!!window.handoffHeldReveal);
 const superseded=await state();await apply(high,'handoff-latest-intent');
 const latestPage=await until(async()=>{for(const page of pages().filter(page=>page!==heldPage&&page.url().includes('/wallpaper.html'))){try{if(await page.evaluate(()=>!!window.handoffHeldFrame))return page;}catch{}}return null;},'latest renderer after old promotion was superseded');
 const latestPending=await state();assert.equal(heldPage.isClosed(),true);assert.equal(latestPending.handoff.hwnd,superseded.handoff.hwnd);assert.equal(latestPending.handoff.bgraSha256,superseded.handoff.bgraSha256);
 assert.equal(latestPending.budget.contexts,1);assert.equal(latestPending.budget.sessionReservations,2);
 assert.equal(latestPending.handoff.workspaceReleased,true);assert.equal(latestPending.budget.prepareCpuBytes,0,'superseding a candidate cannot reacquire a sealed capture workspace');
 await latestPage.evaluate(()=>handoffNativePost(handoffHeldFrame));await latestPage.waitForFunction(()=>!!window.handoffHeldReveal);
 await latestPage.evaluate(()=>handoffNativePost(handoffHeldReveal));await mode(null);current=await steady();
 checks.push({name:'a newer intent supersedes a promoted renderer while reusing one retained frame and keeping a single GL context',superseded,latestPending,current});

 oldPage=await findPage(current.session.binding.sessionId);
 await oldPage.evaluate(()=>{hertzWallpaper.requestCapture=()=>true;});
 await apply(next,'handoff-pending-disable');
 await until(async()=>(await state()).handoff&&!((await state()).handoff?.captured),'capture pending before disable');
 const disabled=structuredClone(high);disabled.enabled=false;await apply(disabled,'handoff-disable');
 const empty=await until(async()=>{const value=await state();return !value.enabled&&!value.handoff&&!value.retiringHandoffs&&value.retiringControllers===0?value:null;},'disable drains pending capture and source');
 assert.equal(oldPage.isClosed(),true);assert.ok(Object.values(empty.budget).every(value=>value===0));
 checks.push({name:'disable during capture drains the source and every bitmap/workspace reservation without a late frame',empty});
 await apply(baseline,'handoff-restore-baseline');await steady();
};
