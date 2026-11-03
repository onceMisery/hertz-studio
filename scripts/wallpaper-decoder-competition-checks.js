// SPDX-License-Identifier: MIT
// Invoked by check-wallpaper-presentation-native.js --decoder-competition.
// Real desktop/preview controllers compete with ImportJobs; only source injection uses
// the explicit wallpaper-media-probe debug harness. Never synthetic decoder reservations.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {buildZip} = require('./check-wallpaper-media-native');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));

module.exports = async function verify({output,settings,video,checks,pages,until,envelope,inPage,formal,mediaPreview}) {
  const configFile=path.join(output,'config.json'), saved=hash(fs.readFileSync(configFile));
  const originalFile=path.join(output,'packages',video.groups[0].selection.packageHash,'original.hwpkg');
  const originalHash=hash(fs.readFileSync(originalFile));
  const desktop=(await formal('status')).wallpaper, binding=desktop.session.binding;
  const desktopPage=await until(async()=>{
    for(const page of pages().filter(item=>item.url().includes('/wallpaper.html'))) {
      try{if(await page.evaluate(id=>window.hertzWallpaper?.debug().session?.sessionId===id,binding.sessionId))return page;}catch{}
    }
    return null;
  },'desktop for decoder competition');
  const resources=async()=>{const reply=await formal('wallpaper.status');assert.equal(reply.ok,true);return reply.result;};
  const checked=async request=>{const reply=await inPage(request);assert.equal(reply.ok,true,JSON.stringify(reply));return reply.result;};
  const config=structuredClone(video);config.groups[0].presentation.fit='contain';
  async function previewDraft() {
    const draft=await checked(envelope('wallpaper.draft.create',{kind:'settings'}));
    const updated=await checked(envelope('wallpaper.draft.update',{draftId:draft.draftId,draftRevision:draft.draftRevision,operations:[{kind:'replaceWallpaper',wallpaper:config}]}));
    return {draftId:updated.draftId,draftRevision:updated.draftRevision};
  }
  async function unchanged() {
    assert.equal(hash(fs.readFileSync(configFile)),saved);
    assert.equal(hash(fs.readFileSync(originalFile)),originalHash);
    assert.deepEqual((await formal('status')).wallpaper.session.binding,binding);
    assert.equal(settings.isClosed(),false);assert.equal(desktopPage.isClosed(),false);
    const time=await desktopPage.evaluate(()=>document.querySelector('video').currentTime);
    await until(async()=>Math.abs((await desktopPage.evaluate(()=>document.querySelector('video').currentTime))-time)>.12,'desktop keeps playing through competing work');
  }
  const bytes=fs.readFileSync(path.join(__dirname,'fixtures/wallpaper-vp8.webm')), packageHashes={};
  fs.mkdirSync(path.join(output,'probe-inputs'),{recursive:true});
  for(const [index,name] of ['competition-blocked','competition-cancel','competition-complete'].entries()) {
    const file='assets/background.webm';
    const manifest={formatVersion:1,workId:'c17ed10a-5c55-4a52-85dc-'+String(201+index).padStart(12,'0'),version:1,title:name,description:'',content:{kind:'video',asset:'background'},assets:[{id:'background',kind:'video',source:file,variants:[]}],files:[{path:file,bytes:bytes.length,sha256:hash(bytes),mime:'video/webm'}],properties:[],permissions:{audioSpectrum:false,pointer:false},license:{code:'none',assets:'CC0-1.0',attribution:''}};
    const archive=buildZip([['manifest.json',Buffer.from(JSON.stringify(manifest))],[file,bytes]]);
    packageHashes[name]=hash(archive);fs.writeFileSync(path.join(output,'probe-inputs',name+'.hwpkg'),archive);
  }
  let nonce=70000;
  async function send(action,name,suppressFrames=false) {
    const id=++nonce;
    await desktopPage.evaluate(command=>window.ipc.postMessage('wallpaper_probe_import '+JSON.stringify(command)),{nonce:id,action,name,suppressFrames,forceProbe:true});
    return id;
  }
  async function result(id) {
    await desktopPage.waitForFunction(id=>!!window.__nativeImportProbes?.[id],id,{timeout:25000});
    return desktopPage.evaluate(id=>window.__nativeImportProbes[id],id);
  }
  function terminal(name,value,state) {
    assert.equal(value.state,state,JSON.stringify(value));
    assert.equal(value.prepareTasks,0);assert.equal(value.prepareCpuBytes,0);
    assert.equal(value.decoderSlots,state==='failed'?2:1,'other owners keep their real decoders');
    assert.equal(pages().some(page=>page.url().includes('/wallpaper-probe.html')),false,'probe controller must exit before terminal receipt');
    assert.equal(fs.existsSync(path.join(output,'staging',name)),false);
    assert.equal(fs.existsSync(path.join(output,'packages',packageHashes[name])),state==='done');
  }
  // Both decoder owners are actual playing surfaces, not test ledger reservations.
  const ref=await previewDraft(), lease=await checked(envelope('wallpaper.preview.acquire',ref));
  const preview=await mediaPreview('video');assert.equal((await resources()).decoderSlots,2);
  const opened=[], onPage=page=>opened.push(page);
  settings.context().on('page',onPage);
  let blocked;
  try {blocked=await result(await send('begin','competition-blocked'));}
  finally {settings.context().off('page',onPage);}
  terminal('competition-blocked',blocked,'failed');assert.match(blocked.error,/^budget_busy: decoder_slots:/);
  assert.equal(opened.length,0,'third decoder rejection must occur before a new controller is created');
  assert.equal(preview.page.isClosed(),false);await unchanged();
  checks.push({name:'real desktop and preview deny third import decoder before controller creation',result:blocked});
  await checked(envelope('wallpaper.preview.release',{leaseId:lease.leaseId}));
  await until(async()=>preview.page.isClosed()&&(await resources()).decoderSlots===1,'preview frees only its decoder after physical exit');
  await checked(envelope('wallpaper.draft.discard',ref));

  // Import owns the remaining decoder. Its cancellation must leave the desktop alone.
  const pending=await send('begin','competition-cancel',true);
  const probe=await until(()=>pages().find(page=>page.url().includes('/wallpaper-probe.html')),'import owns the last decoder');
  await probe.waitForSelector('video');
  const occupied=await resources();assert.equal(occupied.decoderSlots,2);assert.equal(occupied.prepareTasks,1);
  assert.equal(await desktopPage.evaluate(id=>!!window.__nativeImportProbes?.[id],pending),false);
  const blockedPreviewRef=await previewDraft();
  const blockedPreview=await inPage(envelope('wallpaper.preview.acquire',blockedPreviewRef));
  if(blockedPreview.ok) {
    await until(async()=>!(await formal('status')).wallpaper.previewActive,'preview preparation reports busy without opening third decoder');
    await settings.waitForFunction(()=>document.getElementById('status').textContent.includes('budget_busy'));
  } else assert.equal(blockedPreview.error.code,'budget_busy');
  assert.equal((await resources()).decoderSlots,2);assert.equal(probe.isClosed(),false);
  assert.equal(pages().filter(page=>page.url().includes('/wallpaper.html')).length,1);
  await result(await send('cancel','competition-cancel'));
  const cancelled=await result(pending);terminal('competition-cancel',cancelled,'cancelled');
  assert.equal(probe.isClosed(),true);await checked(envelope('wallpaper.draft.discard',blockedPreviewRef));
  await unchanged();
  checks.push({name:'import owns last decoder, preview cannot steal it, cancellation exits without releasing desktop',occupied,result:cancelled});
  const completed=await result(await send('begin','competition-complete'));
  terminal('competition-complete',completed,'done');assert.equal(completed.probeRuns,1);await unchanged();
  checks.push({name:'after cancelled import physically exits another real import can use the last decoder',result:completed});

  // Drop the sole preview consumer while its real qualification controller is waiting
  // for a first frame. No mock timer/close receipt and no decoder slot is pre-returned.
  execFileSync(process.env.PYTHON||'python',['-c','import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("DELETE FROM media_qualifications"); db.commit(); db.close()',path.join(output,'wallpaper.db')],{windowsHide:true});
  await settings.context().addInitScript(()=>{
    if(location.pathname==='/wallpaper-probe.html'&&localStorage.getItem('competition-hold-frame')==='1')HTMLVideoElement.prototype.requestVideoFrameCallback=()=>1;
  });
  await desktopPage.evaluate(()=>localStorage.setItem('competition-hold-frame','1'));
  const waitingRef=await previewDraft(), waitingLease=await checked(envelope('wallpaper.preview.acquire',waitingRef));
  const waitingProbe=await until(()=>pages().find(page=>page.url().includes('/wallpaper-probe.html')),'preview qualification holds last decoder');
  await waitingProbe.waitForSelector('video');
  const waiting=await resources();assert.equal(waiting.decoderSlots,2);assert.equal(waiting.prepareTasks,1);
  assert.equal((await formal('status')).wallpaper.mediaPreview.firstFrameReady,false);
  const released=await checked(envelope('wallpaper.preview.release',{leaseId:waitingLease.leaseId}));
  await until(async()=>{
    const state=(await formal('status')).wallpaper, usage=await resources();
    return !state.previewActive&&waitingProbe.isClosed()&&state.retiringControllers===0&&usage.decoderSlots===1&&usage.prepareTasks===0;
  },'last preview consumer cancellation completes physical exit');
  await desktopPage.evaluate(()=>localStorage.removeItem('competition-hold-frame'));
  await checked(envelope('wallpaper.draft.discard',waitingRef));await unchanged();
  await delay(400);
  assert.equal(pages().filter(page=>page.url().includes('/wallpaper.html')).length,1,'cancelled preparation never creates a late preview');
  checks.push({name:'cancelling sole preview consumer during real qualification closes probe and drops late completion',waiting,released,resources:await resources()});
  const retryRef=await previewDraft(), retryLease=await checked(envelope('wallpaper.preview.acquire',retryRef));
  const retried=await mediaPreview('video');assert.equal((await resources()).decoderSlots,2);
  await checked(envelope('wallpaper.preview.release',{leaseId:retryLease.leaseId}));
  await until(async()=>retried.page.isClosed()&&(await resources()).decoderSlots===1,'fresh preview can acquire and return freed decoder');
  await checked(envelope('wallpaper.draft.discard',retryRef));await unchanged();
  checks.push({name:'fresh preview works after last consumer cancellation',resources:await resources()});
};
