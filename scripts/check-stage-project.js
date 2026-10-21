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
    VMusicTransport:{async get(){return {};},async put(){},async post(){requests++;return identity;}}
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
  const originalCue=CS.preset().cues[0];
  assert.equal(CS.updateCue(0,{...originalCue,set:{'look.bloom':999}}),false,'Cue targets outside the parameter contract are rejected');
  assert.equal(CS.addCue({at:3,set:{'look.bloom':-1}}),false,'New cues reject out-of-range parameter targets');
  assert.equal(CS.addCue({every:1.5,set:{'look.bloom':.5}}),false,'Beat intervals must be whole numbers');
  assert.equal(CS.addCue({at:3,set:{'look.grade':.5}}),false,'Enum parameters reject values outside their options');
  assert.equal(CS.addCue({at:3,every:2,set:{'look.bloom':.5}}),false,'A cue must choose exactly one trigger');
  assert.equal(JSON.stringify(CS.preset().cues[0]),JSON.stringify(originalCue),'Rejected edits leave the stored cue untouched');
  assert.equal((await P.capture(false)).project.preset.cues[0].set['look.bloom'],1,'Export preserves the accepted cue target exactly');
  const detachedCue={at:5,set:{'look.bloom':.5}};
  assert.equal(CS.addCue(detachedCue),true);
  detachedCue.set['look.bloom']=999;
  assert.equal(CS.preset().cues[2].set['look.bloom'],.5,'Accepted cue data is copied into the stage owner');
  assert.equal(CS.removeCue(2),true);
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
  bad=structuredClone(file);bad.preset.look.bloom=8;assert.throws(()=>P.prepare(bad),/参数超出可用范围/);
  bad=structuredClone(file);bad.preset.look.unknown=.5;assert.throws(()=>P.prepare(bad),/未知工程字段/);
  P.apply(prepared,CS.revision());h.position(2500);assert.equal(CS.runtime()['look.bloom'],0,'Imported cue track stays off before media confirmation');
  const shareSnapshot=CS.shareSnapshot({includeProjectContext:true});
  assert.deepEqual(JSON.parse(JSON.stringify(shareSnapshot.project)),{
    version:1,timelineVersion:1,schemaVersion:h.sandbox.CreativeStageContract.schemaVersion,
    schemaHash:h.sandbox.CreativeStageContract.schemaHash,media:null,
  },'Engineering share retains only the current schema/timeline marker, never the media fingerprint');
  const shareCode=await h.sandbox.CreativeShareCode.encode(shareSnapshot,{compress:false});
  const sharedPreset=await h.sandbox.CreativeShareCode.decode(shareCode);
  const receiver=harness();receiver.CS.setPreset(sharedPreset);receiver.position(1500);
  assert.equal(receiver.CS.runtime()['look.bloom'],0,'Shared engineering cues remain inactive before recipient confirmation');
  assert.match(receiver.P.status(),/未绑定媒体.*cue 轨停用/);
  await receiver.P.bindCurrent();receiver.position(1500);
  assert.ok(Math.abs(receiver.CS.runtime()['look.bloom']-.25)<1e-9,
    'Recipient must explicitly confirm the selected media before shared cues execute');
  assert.equal(CS.shareSnapshot().project,undefined,'Ordinary preset snapshots remain free of project metadata');
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
  bad=structuredClone(file);bad.preset.cues[0].every=4;assert.throws(()=>P.prepare(bad),/cue 列表无效/);
  const beforeInvalidCue=JSON.stringify(CS.preset());
  bad=structuredClone(file);bad.preset.cues[0].ease='linear-ish';assert.throws(()=>P.prepare(bad),/缓动无效/);
  bad=structuredClone(file);bad.preset.cues[0].set['look.bloomTypo']=.9;assert.throws(()=>P.prepare(bad),/参数未知/);
  bad=structuredClone(file);bad.preset.cues[0].set['look.bloom']=8;assert.throws(()=>P.prepare(bad),/参数超出可用范围/);
  bad=structuredClone(file);delete bad.preset.cues[0].at;bad.preset.cues[0].every=1.4;
  assert.throws(()=>P.prepare(bad),/cue 列表无效/);
  bad=structuredClone(file);bad.preset.cues[0].comment='ignored before';assert.throws(()=>P.prepare(bad),/未知工程字段/);
  assert.equal(JSON.stringify(CS.preset()),beforeInvalidCue,'Rejected cue data never mutates the current preset');
  CS.setBackground({type:'media',url:'file:///private/image.png'});
  const safeExport=await P.capture(false);assert.equal(safeExport.project.preset.bg.type,'theme');
  assert.ok(safeExport.warnings.some(s=>s.includes('另选素材')));
  assert.equal(CS.addCue({at:Infinity,set:{'look.bloom':1}}),false);
  assert.equal(CS.addCue({every:1,set:{'look.bloom':'not a number'}}),false);
  CS.setBindings([{target:'__proto__.polluted',source:'energy',gain:1},{target:'look.bloom',source:'constructor'}]);
  CS.fire({set:{'__proto__.polluted':1,'look.bloom':'not a number'}});h.position(1200);
  assert.equal(vm.runInContext('Object.prototype.polluted',h.sandbox),undefined);
  assert.ok(Object.values(CS.runtime()).every(Number.isFinite));

  const sceneEdit=harness(), scenePreset=sceneEdit.CS.canonicalBaseline('orb');
  scenePreset.cues=[
    {at:1,len:1000,set:{'sc.radius':4,'look.bloom':.7}},
    {at:2,len:1000,set:{'sc.amp':.4}}
  ];
  scenePreset.bindings=[
    {target:'sc.radius',source:'energy',gain:1},
    {target:'look.bloom',source:'pulse',gain:.5}
  ];
  sceneEdit.CS.setPreset(scenePreset);
  assert.equal(sceneEdit.CS.setScene('lyric'),true);
  const switched=sceneEdit.CS.preset();
  assert.equal(switched.cues.length,1,'Scene switch removes cues that only target old-scene parameters');
  assert.equal(Object.keys(switched.cues[0].set).length,1,'Scene switch removes incompatible cue targets');
  assert.equal(switched.cues[0].set['look.bloom'],.7,'Scene switch retains shared cue targets');
  assert.equal(switched.bindings.length,1,'Scene switch removes incompatible bindings');
  assert.equal(switched.bindings[0].target,'look.bloom');
  const sceneExport=await sceneEdit.P.capture(false);
  assert.equal(sceneExport.project.preset.scene,'lyric','Scene edits remain exportable');
  const reopened=harness(), reopenedProject=reopened.P.prepare(sceneExport.project);
  reopened.P.apply(reopenedProject,reopened.CS.revision());
  assert.equal(reopened.CS.preset().scene,'lyric','Switched scene project can be reopened');
  assert.equal(reopened.CS.preset().cues.length,1);

  const seeded=harness(), oldContext={version:1,timelineVersion:1,schemaVersion:'0',
    schemaHash:'0'.repeat(64),media:seeded.identity};
  const oldPreset=seeded.CS.shareSnapshot();
  oldPreset.name='旧版本舞台';oldPreset.cam.dist=23;
  oldPreset.cues=[{at:2,len:1200,ease:'linear',set:{'look.bloom':.9}},
    {every:1,len:500,ease:'in',set:{'cam.dist':18}}];
  oldPreset.project=oldContext;
  const storage=new Map([['vmusic.creative.preset',JSON.stringify(oldPreset)]]);
  const recovered=harness(storage);recovered.CS.init();
  assert.equal(recovered.CS.preset().scene,oldPreset.scene,'A stale but structurally valid project restores its static scene');
  assert.equal(recovered.CS.preset().name,'旧版本舞台');
  assert.equal(recovered.CS.preset().cam.dist,23);
  assert.deepEqual(JSON.parse(JSON.stringify(recovered.CS.preset().cues)),[],'Stale cues are never retained on the active timeline');
  assert.deepEqual(JSON.parse(JSON.stringify(recovered.CS.preset().legacyCues)),oldPreset.cues,
    'Recovery moves old cue entries into a separate archive');
  assert.equal(recovered.P.timelineAllowed(recovered.CS.preset().project),false,
    'Stale project cues never become executable');
  assert.match(recovered.P.status(),/2 条旧 cue 已隔离保存并停用/);
  assert.match(recovered.P.recoveryNotice(),/2 条旧 cue 已隔离保存并停用/);
  assert.throws(()=>recovered.CS.shareSnapshot(),/2 条旧 cue 已隔离保存并停用/,
    'Stale projects cannot be exported through a share snapshot');
  await assert.rejects(()=>recovered.sandbox.CreativeShareCode.encode(recovered.CS.preset(),{compress:false}),
    /2 条旧 cue 已隔离保存并停用/,'Explicit share encoding preserves the recovery explanation');
  await assert.rejects(()=>recovered.P.capture(false),/2 条旧 cue 已隔离保存并停用/,
    'Project capture is rejected before any media request');
  assert.throws(()=>recovered.CS.exportJSON(),/预置 JSON 与工程导出已暂停/,
    'Ordinary JSON export is also blocked while the old project context is active');

  const archived=JSON.parse(JSON.stringify(recovered.CS.preset().legacyCues));
  const staticBloom=recovered.CS.preset().look.bloom;
  assert.equal(recovered.CS.addCue({at:3,set:{'look.bloom':.4}}),false,
    'New cues require explicitly leaving stale project mode first');
  assert.equal(recovered.CS.updateCue(0,{at:3,set:{'look.bloom':.4}}),false);
  assert.equal(recovered.CS.removeCue(0),false);
  assert.equal(recovered.CS.fire(recovered.CS.preset().legacyCues[0]),false,
    'The manual trial entry rejects an archived legacy cue');
  recovered.position(3000);
  assert.equal(recovered.CS.runtime()['look.bloom'],staticBloom,
    'Song-time timeline leaves the static baseline unchanged');
  recovered.onset.step(50,new Float64Array(64).fill(1),300);
  assert.equal(recovered.CS.stats().beats,1,'The beat fixture reaches the onBeat callback');
  assert.equal(recovered.CS.stats().animations,0,'Beat-triggered legacy cues remain inactive');
  recovered.CS.setScene('orb');
  assert.deepEqual(JSON.parse(JSON.stringify(recovered.CS.preset().legacyCues)),archived,
    'Scene changes do not filter or rewrite archived cue data');
  assert.deepEqual(JSON.parse(JSON.stringify(recovered.CS.preset().cues)),[],'Scene changes never promote archived cues');
  assert.equal(recovered.CS.beginNewCueTrack(),true,'The user can explicitly start a current-version cue track');
  assert.equal(recovered.CS.preset().project,undefined,'Starting a new track removes the stale media binding');
  assert.deepEqual(JSON.parse(JSON.stringify(recovered.CS.preset().legacyCues)),archived,
    'Starting a new track retains the old cues in the local archive');
  assert.match(recovered.P.status(),/2 条旧 cue.*仅保留在本机.*不包含在分享码、预置 JSON 或工程导出/);
  assert.equal(recovered.CS.addCue({at:1,len:1000,ease:'linear',set:{'look.bloom':1}}),true,
    'A fresh track accepts newly authored current-version cues');
  recovered.position(1500);
  assert.ok(recovered.CS.runtime()['look.bloom']>staticBloom,
    'New song-time cues execute after the explicit fresh-track action');
  const freshSnapshot=recovered.CS.shareSnapshot();
  assert.equal(freshSnapshot.legacyCues,undefined,'Share output excludes local archived cues');
  const freshProject=await recovered.P.capture(false);
  assert.equal(freshProject.project.preset.cues.length,1,'Project capture resumes for the fresh track');
  assert.equal(freshProject.project.preset.legacyCues,undefined);
  const freshJson=JSON.parse(recovered.CS.exportJSON());
  assert.equal(freshJson.legacyCues,undefined,'Preset JSON export excludes local archived cues');

  recovered.sandbox.document.hidden=true;
  recovered.sandbox.document.dispatchEvent({type:'visibilitychange'});
  const reopenedFresh=harness(recovered.storage);reopenedFresh.CS.init();
  assert.deepEqual(JSON.parse(JSON.stringify(reopenedFresh.CS.preset().legacyCues)),archived,
    'Archived cues persist locally after leaving stale project mode');
  assert.equal(reopenedFresh.CS.preset().cues.length,1,'The active fresh track also persists locally');

  const resetStorage=new Map([['vmusic.creative.preset',JSON.stringify(oldPreset)]]);
  const resetRecovery=harness(resetStorage);resetRecovery.CS.init();resetRecovery.CS.resetSettings();
  assert.equal(resetRecovery.CS.preset().project,undefined,'Reset clears stale project context');
  assert.equal(resetRecovery.CS.preset().legacyCues,undefined,'Explicit reset discards the old cue archive');
  assert.deepEqual(JSON.parse(JSON.stringify(resetRecovery.CS.preset().cues)),[]);
  const draftRecovery=harness(new Map([['vmusic.creative.preset',JSON.stringify(oldPreset)]]));
  draftRecovery.CS.init();draftRecovery.CS.setPreset(draftRecovery.CS.canonicalBaseline('orb'));
  assert.equal(draftRecovery.CS.preset().project,undefined,'Applying a whole new draft replaces stale context');
  assert.equal(draftRecovery.CS.preset().legacyCues,undefined,'A whole new draft clears the prior local archive');

  const strictOld={projectVersion:1,timelineVersion:1,schemaVersion:'0',schemaHash:'0'.repeat(64),
    preset:seeded.CS.shareSnapshot(),media:null};
  assert.throws(()=>recovered.P.prepare(strictOld),/不兼容/,'Imported project files still require the current schema');

  const currentPreset=seeded.CS.shareSnapshot();currentPreset.project={version:1,timelineVersion:1,
    schemaVersion:seeded.sandbox.CreativeStageContract.schemaVersion,
    schemaHash:seeded.sandbox.CreativeStageContract.schemaHash,media:seeded.identity};
  const currentStorage=new Map([['vmusic.creative.preset',JSON.stringify(currentPreset)]]);
  const currentRestore=harness(currentStorage);currentRestore.CS.init();
  assert.equal(currentRestore.CS.preset().project.schemaHash,seeded.sandbox.CreativeStageContract.schemaHash,
    'Current contexts keep the ordinary restore path');
  assert.match(currentRestore.P.status(),/等待媒体内容确认/);

  const unsupported=JSON.parse(JSON.stringify(oldPreset));unsupported.project.version=99;
  const unsupportedStorage=new Map([['vmusic.creative.preset',JSON.stringify(unsupported)]]);
  const unsupportedRestore=harness(unsupportedStorage);unsupportedRestore.CS.init();
  assert.equal(unsupportedRestore.CS.preset().project,undefined,
    'Unsupported project envelope versions still fail closed to the default preset');
  console.log('Stage projects: strict envelope/import, current and stale restore, isolated legacy cues, media confirmation/races and reversible timelines passed');
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={harness};
