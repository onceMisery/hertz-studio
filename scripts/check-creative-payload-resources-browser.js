// SPDX-License-Identifier: MIT
// Resource lifetimes in the shipped document and real Chrome stream/Blob APIs.
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),web=path.join(root,'plugin/ui');
const out=path.join(root,'output/offline-design-completion/creative-payload');
const files=['stage-json-source.js','creative-share-code.js','creative-project.js','creative-stage.js','creative-draft.js','creative-templates.js','creative-arrangement.js','backgrounds.js','workshop.js'];
const hashes=()=>Object.fromEntries(files.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(web,file))).digest('hex')]));
const report={sourceSha256:hashes(),checks:[],errors:[],scope:'Real Chrome with the shipped document, original resource ledger and original Workshop handlers; controlled async settlement and revocation deadlines test logical ownership, not physical heap/device qualification.'};
let server,browser;
async function pageFor(){
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('pageerror',e=>report.errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.waitForFunction(()=>window.Workshop&&window.CreativeProject);
 await page.evaluate(()=>{HertzStartup.disable();Stage.init();CreativeStage.init();Stage3D.init();Workshop.init();PlayerTransitions.init();});
 return page;
}
async function check(name,fn){
 const page=await pageFor();
 try {const evidence=await fn(page); report.checks.push({name,passed:true,evidence}); console.log('PASS '+name);}
 catch(e){report.checks.push({name,passed:false,error:e.stack});console.error('FAIL '+name+': '+e.message);}
 finally {await page.close();}
}
async function main(){
 fs.mkdirSync(out,{recursive:true});
 server=http.createServer((req,res)=>{
  const rel=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/+/, '')||'index.html';
  const file=path.resolve(web,rel);
  if(!file.startsWith(web+path.sep)){res.writeHead(403);res.end();return;}
  try {let body=fs.readFileSync(file);if(rel==='index.html')body=Buffer.from(body.toString().replace(/<script\b[^>]*src="app\.js"[^>]*><\/script>/,''));
   res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(body);
  }catch(_){res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({channel:'chrome',headless:true});
 try {
 await check('share/project/JSON refusal precedes serialization/encoding/parsing and preserves preset',async page=>{
  const result=await page.evaluate(async()=>{
   const ledger=Stage.resources(),input=CreativeStage.shareSnapshot(),original=JSON.stringify(CreativeStage.preset());
   const project={projectVersion:1,timelineVersion:1,schemaVersion:CreativeStageContract.schemaVersion,schemaHash:CreativeStageContract.schemaHash,preset:input,media:null};
   const code=await CreativeShareCode.encode(input,{compress:false}),wire=JSON.stringify(project);
   const snapshot=ledger.snapshot(),hold=ledger.port('test-block').require({ownedCpuBytes:snapshot.caps.ownedCpuBytes-snapshot.held.ownedCpuBytes},'test occupies remaining CPU',0);
   const oldStringify=JSON.stringify,oldParse=JSON.parse,oldEncode=TextEncoder.prototype.encode;
   let serializations=0,parses=0,encodes=0,errors=[];
   JSON.stringify=function(...args){serializations++;return oldStringify(...args);};
   JSON.parse=function(...args){parses++;return oldParse(...args);};
   TextEncoder.prototype.encode=function(...args){encodes++;return oldEncode.apply(this,args);};
   for(const run of [()=>CreativeShareCode.encodeLease(input,{compress:false}),()=>CreativeShareCode.decodeLease(code),()=>CreativeProject.prepareLease(wire),()=>CreativeStage.exportJSONLease()]){
    try {await run(); errors.push('unexpected success');}catch(e){errors.push(e.message);}
   }
   JSON.stringify=oldStringify;JSON.parse=oldParse;TextEncoder.prototype.encode=oldEncode;
   hold.release({apiReleased:true,allocationEnded:true});
   return {serializations,parses,encodes,errors,preserved:original===JSON.stringify(CreativeStage.preset()),violations:ledger.snapshot().violations};
  });
  assert.deepEqual(result.errors,['aggregate-budget','aggregate-budget','aggregate-budget','aggregate-budget']);
  assert.equal(result.serializations,0);assert.equal(result.parses,0);assert.equal(result.encodes,0);assert.equal(result.preserved,true);assert.deepEqual(result.violations,[]);return result;
 });
 await check('payload leases retain final output; 100 round trips release to baseline and metadata stays ignorable',async page=>{
  const result=await page.evaluate(async()=>{
   const ledger=Stage.resources(),baseline=ledger.snapshot().held.ownedCpuBytes;
   const preset=CreativeStage.shareSnapshot();preset.thumb='x'.repeat(1024*1024);preset.bg={type:'media',url:'data:'+preset.thumb};
   const code=await CreativeShareCode.encodeLease(preset,{compress:false});
   const encodedHeld=ledger.snapshot().held.ownedCpuBytes-baseline,chars=code.value.length;
   const decoded=await CreativeShareCode.decodeLease(code.value);const normalized=decoded.value.bg.type;
   const decodedHeld=ledger.snapshot().held.ownedCpuBytes-baseline;
   decoded.release();code.release();
   for(let i=0;i<100;i++){
    const encoded=await CreativeShareCode.encodeLease(undefined,{compress:false});const decoded=await CreativeShareCode.decodeLease(encoded.value);
    decoded.release();encoded.release();
   }
   return {baseline,encodedHeld,chars,decodedHeld,normalized,after:ledger.snapshot().held.ownedCpuBytes,violations:ledger.snapshot().violations};
  });
  assert.equal(result.encodedHeld,result.chars*2);assert.ok(result.decodedHeld>result.encodedHeld);assert.equal(result.normalized,'theme');assert.equal(result.after,result.baseline);assert.deepEqual(result.violations,[]);return result;
 });
 await check('bounded UTF8 strings refuse before TextEncoder allocates',async page=>{
  const result=await page.evaluate(()=>{
   let calls=0;const encode=TextEncoder.prototype.encode;TextEncoder.prototype.encode=function(...args){calls++;return encode.apply(this,args);};
   const errors=[];
   for(const run of [()=>CreativeProject.prepareLease('🎵'.repeat(70000)),()=>StageJsonSource.parse('🎵'.repeat(4097),{limit:16384})])try{run();}catch(e){errors.push(e.message);}
   TextEncoder.prototype.encode=encode;return {calls,errors};
  });assert.equal(result.calls,0);assert.match(result.errors[0],/256 KiB/);assert.equal(result.errors.length,2);return result;
 });
 await check('setPreset reserves normalized representation before allocating and retires replaced copies independently of source aliases',async page=>{
  const result=await page.evaluate(()=>{
   const ledger=Stage.resources(),original=JSON.stringify(CreativeStage.preset()),candidate=CreativeStage.shareSnapshot();
   candidate.cues=[{at:0,len:500,ease:'linear',set:{'look.bloom':.7}}];
   const source=CreativeStage.normalizeShareLease(candidate);
   const snap=ledger.snapshot(),block=ledger.port('test-normalize-block').require({ownedCpuBytes:snap.caps.ownedCpuBytes-snap.held.ownedCpuBytes},'test full CPU capacity',0);
   const stringify=JSON.stringify,parse=JSON.parse;let stringifies=0,parses=0,error;
   JSON.stringify=function(...args){stringifies++;return stringify(...args);};JSON.parse=function(...args){parses++;return parse(...args);};
   try{CreativeStage.setPreset(source.value,{payloadSource:source,returnPreset:false});}catch(e){error=e.message;}
   JSON.stringify=stringify;JSON.parse=parse;
   const preserved=JSON.stringify(CreativeStage.preset())===original;block.release({apiReleased:true,allocationEnded:true});
   CreativeStage.setPreset(source.value,{payloadSource:source,returnPreset:false});source.release();
   const held=ledger.snapshot(true).entries.filter(e=>e.owner==='creative-preset'),aliases=ledger.snapshot(true).entries.filter(e=>e.owner==='creative-share-preset');
   const replacement=CreativeStage.canonicalBaseline('orb');let previousBytes=null,stable=true;
   for(let i=0;i<20;i++){CreativeStage.setPreset(replacement,{returnPreset:false});const entries=ledger.snapshot(true).entries.filter(e=>e.owner==='creative-preset');const total=entries.reduce((n,e)=>n+e.live.ownedCpuBytes+e.pending.ownedCpuBytes,0);if(entries.length!==1||(previousBytes!==null&&previousBytes!==total))stable=false;previousBytes=total;}
   const afterAliases=ledger.snapshot(true).entries.filter(e=>e.owner==='creative-share-preset');
   CreativeStage.destroy();const after=ledger.snapshot(true).entries.filter(e=>e.owner==='creative-preset');
   return {error,stringifies,parses,preserved,held,aliases,afterAliases,stable,after,violations:ledger.snapshot().violations};
  });
  assert.equal(result.error,'aggregate-budget');assert.equal(result.stringifies,0);assert.equal(result.parses,0);assert.equal(result.preserved,true);
  assert.equal(result.held.length,1);assert.ok(result.held[0].live.ownedCpuBytes>0);assert.equal(result.aliases.length,1);assert.equal(result.aliases[0].leases,1);
  assert.equal(result.afterAliases.length,0);assert.equal(result.stable,true);assert.equal(result.after.length,0);assert.deepEqual(result.violations,[]);return result;
 });
 await check('project object and text accept byte-bounded ignored media metadata with large arrays and maps',async page=>{
  const result=await page.evaluate(()=>{
   const preset=CreativeStage.shareSnapshot();preset.bg={type:'media',ignored:Array(4500).fill(''),extra:Object.fromEntries(Array.from({length:600},(_,i)=>['key'+i,'']))};
   const input={projectVersion:1,timelineVersion:1,schemaVersion:CreativeStageContract.schemaVersion,schemaHash:CreativeStageContract.schemaHash,preset,media:null};
   const wire=JSON.stringify(input),object=CreativeProject.prepareLease(input),text=CreativeProject.prepareLease(wire);
   const same=JSON.stringify(object.value)===JSON.stringify(text.value),bg=object.value.project.preset.bg.type;
   object.release();text.release();preset.bg.ignored='x'.repeat(256*1024);const oversized=JSON.stringify(input),errors=[];
   for(const value of [input,oversized])try{const source=CreativeProject.prepareLease(value);source.release();errors.push('unexpected success');}catch(e){errors.push(e.message);}
   return {bytes:new TextEncoder().encode(wire).length,same,bg,errors};
  });assert.ok(result.bytes<256*1024);assert.equal(result.same,true);assert.equal(result.bg,'theme');assert.equal(result.errors.length,2);result.errors.forEach(error=>assert.match(error,/256 KiB/));return result;
 });
 await check('refused preview apply preserves cancel authority and close restores committed artwork/motion before valid retry',async page=>{
  const result=await page.evaluate(()=>{
   Workshop.open();Workshop.setTab('io');
   const ledger=Stage.resources(),base=CreativeStage.canonicalBaseline('orb');base.director=false;base.bg={type:'theme'};base.hand.on=false;
   CreativeStage.setPreset(base,{returnPreset:false});
   CreativeStage.fire({every:1,set:{'look.bloom':.8},len:5000,ease:'linear'});
   const original=JSON.stringify(CreativeStage.preset()),hand=HandDrawn.values(),motion=CreativeStage.stats().animations;
   const candidate=CreativeStage.shareSnapshot();candidate.name='Budget preview';
   candidate.bg={type:'mesh',opacity:60,blur:5,blend:'screen',depthMode:'flat',hue:120};
   candidate.hand.on=true;candidate.hand.frame=true;candidate.hand.paper=false;
   function full(){const snap=ledger.snapshot();return ledger.port('test-preview-full').require({ownedCpuBytes:snap.caps.ownedCpuBytes-snap.held.ownedCpuBytes},'test preview refusal',0);}
   function attempt(token){try{CreativeStage.applyPreview(token.previewId,token.proposalHash,{returnPreset:false});return 'unexpected success';}catch(e){return e.message;}}
   const first=CreativeStage.beginPreview(candidate,'cancel-refusal'),block=full(),firstError=attempt(first);
   const held=ledger.snapshot(true).entries.filter(e=>e.owner==='creative-share-preset');
   const kept=CreativeStage.preview(),cancelled=CreativeStage.cancelPreview(first.previewId);
   const cancelState={preset:JSON.stringify(CreativeStage.preset()),bg:Backgrounds.values(),hand:HandDrawn.values(),motion:CreativeStage.stats().animations,
    sources:ledger.snapshot(true).entries.filter(e=>e.owner==='creative-share-preset').length};
   block.release({apiReleased:true,allocationEnded:true});
   const second=CreativeStage.beginPreview(candidate,'close-refusal'),block2=full(),secondError=attempt(second);
   Workshop.close();const closed={preview:CreativeStage.preview(),preset:JSON.stringify(CreativeStage.preset()),bg:Backgrounds.values(),hand:HandDrawn.values(),motion:CreativeStage.stats().animations,
    sources:ledger.snapshot(true).entries.filter(e=>e.owner==='creative-share-preset').length};
   block2.release({apiReleased:true,allocationEnded:true});
   const third=CreativeStage.beginPreview(candidate,'valid-retry'),applied=CreativeStage.applyPreview(third.previewId,third.proposalHash,{returnPreset:false});
   const valid={applied,preview:CreativeStage.preview(),preset:CreativeStage.preset(),bg:Backgrounds.values(),hand:HandDrawn.values()};
   return {original,hand,motion,firstError,secondError,held,kept,cancelled,cancelState,closed,valid,violations:ledger.snapshot().violations};
  });
  assert.equal(result.firstError,'aggregate-budget');assert.equal(result.secondError,'aggregate-budget');assert.ok(result.kept);assert.equal(result.cancelled,true);assert.ok(result.held.length>0);
  for(const state of [result.cancelState,result.closed]){assert.equal(state.preset,result.original);assert.equal(state.bg.type,'theme');assert.deepEqual(state.hand,result.hand);assert.equal(state.motion,result.motion);assert.equal(state.sources,0);}
  assert.equal(result.closed.preview,null);assert.equal(result.valid.applied.ok,true);assert.equal(result.valid.preview,null);assert.equal(result.valid.preset.name,'Budget preview');assert.equal(result.valid.bg.type,'mesh');assert.equal(result.valid.hand.on,true);assert.deepEqual(result.violations,[]);return result;
 });
 await check('successful gzip keeps its complete workspace through delayed reader cancellation settlement',async page=>{
  const result=await page.evaluate(async()=>{
   const ledger=Stage.resources(),baseline=ledger.snapshot().held.ownedCpuBytes,Original=CompressionStream;
   window.CompressionStream=class{constructor(format){const stream=new Original(format),get=stream.readable.getReader.bind(stream.readable);stream.readable.getReader=function(){const reader=get(),cancel=reader.cancel.bind(reader);reader.cancel=function(...args){return cancel(...args).then(()=>new Promise(resolve=>window.__successCancelResolve=resolve));};return reader;};return stream;}};
   let done=false;const pending=CreativeShareCode.encodeLease().then(source=>{done=true;return source;});
   while(!window.__successCancelResolve)await new Promise(resolve=>setTimeout(resolve,0));
   const during=ledger.snapshot(true).entries.filter(e=>e.owner==='creative-share-stream'),settledEarly=done;
   window.__successCancelResolve();const source=await pending;const compressed=source.value.startsWith('HSCP1.G.');source.release();
   return {baseline,during,settledEarly,compressed,after:ledger.snapshot().held.ownedCpuBytes,violations:ledger.snapshot().violations};
  });assert.equal(result.settledEarly,false);assert.equal(result.during.length,1);assert.ok(result.during[0].pending.ownedCpuBytes>=3*128*1024);assert.equal(result.compressed,true);assert.equal(result.after,result.baseline);assert.deepEqual(result.violations,[]);return result;
 });
 await check('Workshop close during compression holds pending resources until stream settles and suppresses stale result',async page=>{
  await page.evaluate(()=>{
   Workshop.open();Workshop.setTab('io');
   const Original=CompressionStream;window.__releaseCompression=null;
   window.CompressionStream=class {constructor(format){
    let release;const wait=new Promise(resolve=>release=resolve);window.__releaseCompression=release;
    const gate=new TransformStream({async transform(chunk,controller){await wait;controller.enqueue(chunk);}});
    return {writable:gate.writable,readable:gate.readable.pipeThrough(new Original(format))};
   }};
  });
  await page.locator('#ws-share-copy').click();await page.waitForFunction(()=>!!window.__releaseCompression);
  const during=await page.evaluate(()=>{Workshop.close();return Stage.resources().snapshot(true).entries.filter(e=>e.owner==='creative-share-stream');});
  assert.ok(during.length>0);assert.ok(during.some(e=>e.pending.ownedCpuBytes+e.live.ownedCpuBytes>0));
  await page.evaluate(()=>window.__releaseCompression());
  await page.waitForFunction(()=>!Stage.resources().snapshot(true).entries.some(e=>e.owner==='creative-share-stream'));
  const after=await page.evaluate(()=>({open:Workshop.isOpen(),text:document.getElementById('ws-share-code').value,entries:Stage.resources().snapshot(true).entries.filter(e=>/^creative-share/.test(e.owner))}));
  assert.equal(after.open,false);assert.equal(after.text,'');assert.equal(after.entries.length,0);return {during,after};
 });
 await check('oversized decompression retains its ticket through delayed cancel settlement',async page=>{
  const result=await page.evaluate(async()=>{
   const code=await CreativeShareCode.encode(undefined),ledger=Stage.resources(),baseline=ledger.snapshot().held.ownedCpuBytes;
   window.__cancelRelease=null;
   window.DecompressionStream=class{constructor(){return {writable:new WritableStream(),readable:new ReadableStream({start(c){c.enqueue(new Uint8Array(131073));},cancel(){return new Promise(resolve=>window.__cancelRelease=resolve);}})};}};
   const pending=CreativeShareCode.decodeLease(code).then(s=>{s.release();return 'unexpected success';},e=>e.message);
   while(!window.__cancelRelease)await new Promise(resolve=>setTimeout(resolve,0));
   const during=ledger.snapshot().held.ownedCpuBytes;window.__cancelRelease();const error=await pending;
   return {baseline,during,after:ledger.snapshot().held.ownedCpuBytes,error,violations:ledger.snapshot().violations};
  });assert.ok(result.during>result.baseline);assert.equal(result.after,result.baseline);assert.match(result.error,/解压后过大/);assert.deepEqual(result.violations,[]);return result;
 });
 await check('project media await holds snapshot and stale selection cannot commit',async page=>{
  const result=await page.evaluate(async()=>{
   const original=CreativeStage.preset(),ledger=Stage.resources();
   Stage.presentation=()=>({track:{id:'payload-track'},mediaTrackId:'payload-track',mediaEpoch:1});
   window.VMusicTransport={post:()=>new Promise(resolve=>window.__projectResolve=resolve)};
   const baseline=ledger.snapshot().held.ownedCpuBytes;
   let valid=true;const pending=CreativeProject.captureLease(true,()=>valid).then(s=>{s.release();return 'unexpected success';},e=>e.message);
   const during=ledger.snapshot().held.ownedCpuBytes;valid=false;
   window.__projectResolve({kind:'local-file-sha256-v1',sha256:'a'.repeat(64),byteLength:'3'});
   const error=await pending;
   return {baseline,during,after:ledger.snapshot().held.ownedCpuBytes,error,preserved:JSON.stringify(original)===JSON.stringify(CreativeStage.preset())};
  });assert.ok(result.during>result.baseline);assert.equal(result.after,result.baseline);assert.equal(result.preserved,true);assert.match(result.error,/已改变/);return result;
 });
 await check('generated textarea and clipboard have separate lifetimes; close does not release unsettled copy',async page=>{
  await page.evaluate(()=>{
   Workshop.open();Workshop.setTab('io');document.execCommand=()=>false;
   Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>new Promise(resolve=>window.__clipboardResolve=resolve)}});
  });
  await page.locator('#ws-share-compatible').check();await page.locator('#ws-share-copy').click();await page.waitForFunction(()=>!!window.__clipboardResolve);
  const during=await page.evaluate(()=>{const view=Stage.resources().snapshot(true).entries.filter(e=>e.owner==='workshop-payload-view');Workshop.close();return {view,closed:Stage.resources().snapshot(true).entries.filter(e=>/^workshop-payload/.test(e.owner))};});
  assert.ok(during.view.length>0);assert.ok(during.closed.some(e=>e.owner==='workshop-payload-input'));assert.ok(!during.closed.some(e=>e.owner==='workshop-payload-view'));
  await page.evaluate(()=>window.__clipboardResolve());
  await page.waitForFunction(()=>!Stage.resources().snapshot(true).entries.some(e=>e.owner==='workshop-payload-input'));
  return during;
 });
 await check('download Blob remains charged after close until object URL revocation',async page=>{
  await page.evaluate(()=>{
   Workshop.open();Workshop.setTab('io');window.__revocations=[];
   const timer=setTimeout;window.setTimeout=(callback,delay,...args)=>delay===30000?(window.__revocations.push(()=>callback(...args)),0):timer(callback,delay,...args);
  });
  await page.getByRole('button',{name:'下载 .json',exact:true}).click();
  const result=await page.evaluate(()=>{
   Workshop.close();const during=Stage.resources().snapshot(true).entries.filter(e=>e.owner==='workshop-download');
   window.__revocations.forEach(fn=>fn());return {during,after:Stage.resources().snapshot(true).entries.filter(e=>e.owner==='workshop-download')};
  });assert.equal(result.during.length,1);assert.ok(result.during[0].live.ownedCpuBytes>0);assert.equal(result.after.length,0);return result;
 });
 await check('checked project persists while hidden; subsequent check replaces its lease without growth',async page=>{
  const wire=await page.evaluate(async()=>{
   const source=await CreativeProject.captureLease(false);const wire=JSON.stringify(source.value.project);source.release();Workshop.open();Workshop.setTab('io');return wire;
  });
  await page.locator('#ws-project-json').fill(wire);await page.locator('[data-project="check"]').click();
  const before=await page.evaluate(()=>Stage.resources().snapshot(true).entries.filter(e=>e.owner==='creative-project').reduce((n,e)=>n+e.live.ownedCpuBytes+e.pending.ownedCpuBytes,0));
  for(let i=0;i<20;i++)await page.locator('[data-project="check"]').click();
  const after=await page.evaluate(()=>{Workshop.close();return Stage.resources().snapshot(true).entries.filter(e=>e.owner==='creative-project').reduce((n,e)=>n+e.live.ownedCpuBytes+e.pending.ownedCpuBytes,0);});
  assert.ok(before>0);assert.equal(after,before);return {before,after};
 });
 await check('delayed File.text keeps allocation authority after close and cannot replace retained input',async page=>{
  const wire=await page.evaluate(async()=>{
   const source=await CreativeProject.captureLease(false);const wire=JSON.stringify(source.value.project);source.release();
   Workshop.open();Workshop.setTab('io');
   File.prototype.text=function(){return new Promise(resolve=>window.__fileResolve=resolve);};return wire;
  });
  await page.getByLabel('打开舞台工程文件').setInputFiles({name:'late.hertz-stage.json',mimeType:'application/json',buffer:Buffer.from(wire)});
  await page.waitForFunction(()=>!!window.__fileResolve);
  const during=await page.evaluate(()=>{Workshop.close();return Stage.resources().snapshot(true).entries.filter(e=>e.owner==='workshop-project-file');});
  assert.equal(during.length,1);assert.ok(during[0].pending.ownedCpuBytes>0);
  await page.evaluate(wire=>window.__fileResolve(wire),wire);
  await page.waitForFunction(()=>!Stage.resources().snapshot(true).entries.some(e=>e.owner==='workshop-project-file'));
  await page.evaluate(()=>{Workshop.open();Workshop.setTab('io');});
  assert.equal(await page.locator('#ws-project-json').inputValue(),'');return {during};
 });
 await check('draft and template leases retain results; preview cancellation retires data and repeated close is stable',async page=>{
  const result=await page.evaluate(async()=>{
   const ledger=Stage.resources(),baseline=ledger.snapshot().held.ownedCpuBytes;
   const artifact=CreativeDraft.artifact({version:1,scene:'orb',patch:{'sc.radius':2},director:false,hand:{on:false}});
   const largeArtifact=CreativeDraft.artifact({version:1,scene:'orb',patch:{},ruleIds:Array(4500).fill('')});
   const largeSource=await CreativeDraft.prepareLease(largeArtifact);const ruleCount=largeSource.value.artifact.intent.ruleIds.length;largeSource.release();
   const source=await CreativeDraft.prepareLease(artifact),during=ledger.snapshot().held.ownedCpuBytes;
   source.release();
   const template=await CreativeTemplates.prepareLease('quiet-orb'),templateHeld=ledger.snapshot().held.ownedCpuBytes;
   CreativeStage.beginPreview(template.value.preset,template.value.proposalHash);template.release();
   const previewHeld=ledger.snapshot().held.ownedCpuBytes;CreativeStage.cancelPreview();
   return {baseline,during,templateHeld,previewHeld,after:ledger.snapshot().held.ownedCpuBytes,artifact,ruleCount};
  });
  assert.ok(result.during>result.baseline);assert.ok(result.templateHeld>result.baseline);assert.ok(result.previewHeld>result.baseline);assert.equal(result.after,result.baseline);assert.equal(result.ruleCount,4500);
  await page.evaluate(()=>{Workshop.open();Workshop.setTab('io');});
  await page.locator('#ws-draft-json').fill(JSON.stringify(result.artifact));
  const totals=[];
  for(let i=0;i<3;i++){
   await page.locator('#ws-draft-preview').click();await page.waitForFunction(()=>!!CreativeStage.preview());
   await page.evaluate(()=>Workshop.close());
   totals.push(await page.evaluate(()=>Stage.resources().snapshot(true).entries.filter(e=>/creative-draft|creative-template|creative-share|workshop-draft/.test(e.owner)).reduce((n,e)=>n+e.live.ownedCpuBytes+e.pending.ownedCpuBytes,0)));
   await page.evaluate(()=>{Workshop.open();Workshop.setTab('io');});
  }
  assert.deepEqual(totals,[0,0,0]);return {...result,totals};
 });
 await check('Workshop template receipt after close is discarded and apply/undo uses retained payload sources',async page=>{
  await page.evaluate(()=>{
   Workshop.open();Workshop.setTab('scene');
   window.__realTemplate=CreativeTemplates.prepareLease;
   CreativeTemplates.prepareLease=async function(id){const source=await __realTemplate(id);await new Promise(resolve=>window.__templateResolve=resolve);return source;};
  });
  await page.locator('[data-template="quiet-orb"]').click();await page.waitForFunction(()=>!!window.__templateResolve);
  const during=await page.evaluate(()=>{Workshop.close();return Stage.resources().snapshot(true).entries.filter(e=>e.owner==='creative-template');});
  assert.equal(during.length,1);
  await page.evaluate(()=>{__templateResolve();CreativeTemplates.prepareLease=__realTemplate;});
  await page.waitForFunction(()=>!Stage.resources().snapshot(true).entries.some(e=>e.owner==='creative-template'));
  assert.equal(await page.evaluate(()=>CreativeStage.preview()),null);
  await page.evaluate(()=>{Workshop.open();Workshop.setTab('scene');});
  const previous=await page.evaluate(()=>CreativeStage.shareSnapshot());
  await page.locator('[data-template="quiet-orb"]').click();await page.waitForFunction(()=>!!CreativeStage.preview());
  await page.getByRole('button',{name:'应用到当前舞台',exact:true}).click();await page.waitForFunction(()=>!CreativeStage.preview()&&CreativeStage.preset().name==='静夜星球');
  await page.getByRole('button',{name:'撤销本次应用',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>CreativeStage.shareSnapshot()),previous);return {during};
 });
 }finally{
  await browser.close();await new Promise(resolve=>server.close(resolve));
  report.sourceSha256After=hashes();report.sourceUnchanged=JSON.stringify(report.sourceSha256)===JSON.stringify(report.sourceSha256After);
  report.passed=report.sourceUnchanged&&!report.errors.length&&report.checks.every(c=>c.passed);report.finishedAt=new Date().toISOString();
  fs.writeFileSync(path.join(out,'browser-report.json'),JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
