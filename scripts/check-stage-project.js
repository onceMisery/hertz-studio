// SPDX-License-Identifier: MIT
// Post-implementation checks of the real project envelope and preset owner.
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function harness(saved) {
  const listeners=new Map(),storage=new Map(saved || []);
  const selection={track:{id:'local-a'},mediaEpoch:1,mediaTrackId:'local-a'};
  const identity={kind:'local-file-sha256-v1',sha256:'a'.repeat(64),byteLength:'1234'};
  let position=0,requests=0,onset;
  const sandbox={window:{},console,TextEncoder,TextDecoder,Blob,CompressionStream,DecompressionStream,
    btoa:s=>Buffer.from(s,'binary').toString('base64'),atob:s=>Buffer.from(s,'base64').toString('binary'),
    setTimeout:()=>1,clearTimeout(){},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
    document:{hidden:false,addEventListener(k,f){let list=listeners.get(k)||[];list.push(f);listeners.set(k,list);},
      dispatchEvent(e){for(const fn of listeners.get(e.type)||[])fn(e);},getElementById:()=>null,
      body:{classList:{contains:()=>false}},documentElement:{classList:{toggle(){}}}},
    Stage:{presentation:()=>selection,position:()=>position,kick(){},gate(){},tier:()=>1},
    VMusicTransport:{async post(){requests++;return identity;}}
  };
  sandbox.window.Stage=sandbox.Stage;sandbox.window.VMusicTransport=sandbox.VMusicTransport;
  vm.createContext(sandbox);
  for(const file of ['onset.js','creative-gl.js','backgrounds.js','handdrawn.js','creative-anime.js','creative-share-code.js','creative-stage.js','creative-contract.js','creative-project.js']){
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../plugin/ui',file),'utf8'),sandbox,{filename:file});
    Object.assign(sandbox,sandbox.window);
    if(file==='onset.js') {const create=sandbox.Onset.create;sandbox.Onset.create=function(...args){onset=create(...args);return onset;};}
  }
  sandbox.Backgrounds.apply=()=>{};sandbox.HandDrawn.apply=()=>{};
  const CS=sandbox.CreativeStage,P=sandbox.CreativeProject;
  return {CS,P,selection,identity,sandbox,storage,onset,requests:()=>requests,
    position(ms){position=ms;CS.patch({});},
    changed(){selection.mediaEpoch++;sandbox.document.dispatchEvent({type:'stage:track-changed'});},
    file(){return {projectVersion:1,timelineVersion:1,schemaVersion:sandbox.CreativeStageContract.schemaVersion,
      schemaHash:sandbox.CreativeStageContract.schemaHash,preset:CS.shareSnapshot(),media:identity};}};
}
async function main(){
  let h=harness(),{CS,P}=h;
  const base=CS.canonicalBaseline('orb');base.director=false;base.look.bloom=0;
  base.cues=[{at:1,len:2000,ease:'linear',set:{'look.bloom':1}},
    {at:2,len:1000,ease:'linear',set:{'look.bloom':0}}];CS.setPreset(base);
  const original=JSON.stringify(CS.preset()),file=h.file();
  const prepared=P.prepare(JSON.stringify(file));assert.equal(JSON.stringify(CS.preset()),original);
  assert.equal(h.requests(),0,'Checking files never reads audio or calls a provider');
  assert.deepEqual(Object.keys(prepared.project).sort(),['projectVersion','timelineVersion','schemaVersion','schemaHash','preset','media'].sort());
  for(const key of ['projectVersion','timelineVersion','schemaHash']){
    const bad=structuredClone(file);bad[key]=key==='schemaHash'?'0'.repeat(64):99;assert.throws(()=>P.prepare(bad),/不支持|不兼容/);
  }
  assert.throws(()=>P.prepare(JSON.stringify(file).replace('"projectVersion":1','"projectVersion":9,"projectVersion":1')),/重复/);
  assert.throws(()=>P.prepare('{"ignored":'+ '['.repeat(14)+'0'+']'.repeat(14)+',"ignored":0}'),/12 层/);
  assert.throws(()=>P.prepare('{"__proto__":{}}'),/危险/);
  assert.throws(()=>P.prepare(' '.repeat(262145)),/256 KiB/);
  let bad=structuredClone(file);bad.media.sha256=['a'.repeat(64)];assert.throws(()=>P.prepare(bad),/身份/);
  bad=structuredClone(file);delete bad.preset.cam.yaw;assert.throws(()=>P.prepare(bad),/预置不完整/);
  P.apply(prepared,CS.revision());h.position(2500);assert.equal(CS.runtime()['look.bloom'],0,'Imported cue track stays off before media confirmation');
  await P.bindCurrent();assert.match(P.status(),/已启用/);
  for(const [ms,want]of [[0,0],[1500,.25],[2000,.5],[2500,.25],[4000,0],[1500,.25]]){
    h.position(ms);assert.ok(Math.abs(CS.runtime()['look.bloom']-want)<1e-9,'Reversible overlapping timeline at '+ms);
  }
  // Values from real audio bindings cannot become the absolute track baseline.
  const withBinding=CS.preset();withBinding.bindings=[{target:'look.bloom',source:'energy',gain:10}];
  h.onset.energy=.8;
  CS.setPreset(withBinding);h.position(1500);assert.equal(CS.runtime()['look.bloom'],.25);
  const sameAt=CS.preset();sameAt.cues=[{at:1,len:1000,ease:'linear',set:{'look.bloom':1}},
    {at:1,len:1000,ease:'linear',set:{'look.bloom':.4}}];CS.setPreset(sameAt);
  h.position(1500);assert.ok(Math.abs(CS.runtime()['look.bloom']-.2)<1e-9,'Same-time cues keep file order');
  h.onset.energy=0;
  h.changed();h.position(1500);assert.equal(CS.runtime()['look.bloom'],0);
  assert.match(P.status(),/等待/);await P.bindCurrent();assert.match(P.status(),/已启用/);
  const restored=harness();restored.CS.setPreset(CS.preset());
  assert.match(restored.P.status(),/等待/,'Reloaded metadata never restores a verified binding');
  await P.bindCurrent();
  h.identity.sha256='b'.repeat(64);await assert.rejects(()=>P.bindCurrent(),/不匹配/);assert.match(P.status(),/等待/);
  h.identity.sha256='a'.repeat(64);
  h.identity.kind='file-sha256-v1';await P.bindCurrent();
  assert.match(P.status(),/已启用/,'Legacy local identities match identical complete remote/cache bytes');
  const generic=await P.capture(true);assert.equal(generic.project.media.kind,'file-sha256-v1');
  bad=structuredClone(file);bad.media.kind='url-hash-v1';assert.throws(()=>P.prepare(bad),/身份/);
  let sent,explicitReads=0;
  h.sandbox.VMusicTransport.post=async(route,body)=>{sent=body;explicitReads++;return h.identity;};
  await P.bindCurrent();assert.equal(sent.allow_remote_read,false);
  await P.bindCurrent(undefined,true);assert.equal(sent.allow_remote_read,true);
  const readsBefore=explicitReads;await P.capture(false,undefined,true);
  assert.equal(explicitReads,readsBefore,'No-media export does not request remote content');
  h.identity.kind='local-file-sha256-v1';
  let release;h.sandbox.VMusicTransport.post=()=>new Promise(r=>{release=r;});
  const pending=P.bindCurrent();h.changed();release(h.identity);await assert.rejects(()=>pending,/已改变/);
  assert.match(P.status(),/等待/);
  h.sandbox.VMusicTransport.post=async()=>h.identity;
  const exported=await P.capture(true);assert.equal(exported.project.media.sha256,'a'.repeat(64));
  assert.equal(exported.project.preset.project,undefined,'Project metadata does not leak into the complete preset contract');
  const unbound=await P.capture(false);assert.equal(unbound.project.media,null);
  const candidate=CS.canonicalBaseline('nebula');
  CS.beginPreview(candidate,'temporary-candidate');
  const committedExport=await P.capture(false);
  assert.equal(committedExport.project.preset.scene,'orb','A temporary preview never enters exported projects');
  CS.cancelPreview();
  const before=CS.revision();CS.setParam('look.bloom',.2);assert.throws(()=>P.apply(prepared,before),/已修改/);
  for(let i=CS.preset().cues.length;i<64;i++)assert.equal(CS.addCue({at:i,len:100,set:{'look.bloom':.2}}),true);
  assert.equal(CS.addCue({at:65,set:{'look.bloom':.2}}),false);
  assert.equal(CS.setBindings(Array(33).fill({target:'look.bloom',source:'energy',gain:1})),false);
  bad=structuredClone(file);bad.preset.cues[0].every=4;assert.throws(()=>P.prepare(bad),/明确选择/);
  CS.setBackground({type:'media',url:'file:///private/image.png'});
  const safeExport=await P.capture(false);assert.equal(safeExport.project.preset.bg.type,'theme');
  assert.ok(safeExport.warnings.some(s=>s.includes('另选素材')));
  assert.equal(CS.addCue({at:Infinity,set:{'look.bloom':1}}),false);
  assert.equal(CS.addCue({every:1,set:{'look.bloom':'not a number'}}),false);
  CS.setBindings([{target:'__proto__.polluted',source:'energy',gain:1},{target:'look.bloom',source:'constructor'}]);
  CS.fire({set:{'__proto__.polluted':1,'look.bloom':'not a number'}});h.position(1200);
  assert.equal(vm.runInContext('Object.prototype.polluted',h.sandbox),undefined);
  assert.ok(Object.values(CS.runtime()).every(Number.isFinite));
  console.log('Stage projects: strict envelope, pure import, media confirmation/races, persistent metadata, refresh/switch invalidation, ordered overlapping cues and reversible seeks passed');
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={harness};
