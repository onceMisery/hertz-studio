'use strict';
// Actual pinned Pixi allocation admission and original owner retirement.
// API declarations and bounded payloads do not qualify physical GPU memory.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),web=path.join(root,'plugin/ui');
const sources=['stage-resource-budget.js','stage-resource-policy.js','vendor/pixi.min.js','stanza/stanza-util.js','stanza/stanza-theme.js','stanza/stanza-sonnet-fx.js','stanza/stanza-sonnet.js','stanza/stanza-tempera.js'];
const out=path.join(root,'output/offline-design-completion/m1-pixi/'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(out,{recursive:true});
const report={startedAt:new Date().toISOString(),scope:'Actual Pixi original context/probe/canvas, text raster/pools, GraphicsContext payload, typed batch/uniform storage, texture/renderbuffer/program API admission and retirement. Browser/driver allocation and physical device qualification remain observation.',
 sourceSha256:Object.fromEntries([...sources,'stanza/stanza.css'].map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(web,file))).digest('hex')])),checks:[],errors:[]};
let browser;
async function boot(mode,kind='application'){
 const page=await browser.newPage({viewport:{width:900,height:600}});page.on('pageerror',error=>report.errors.push(error.stack));
 await page.setContent('<style>html,body{margin:0;background:#101015}#host,.fl-sonnet,.fl-tempera{position:absolute;inset:0}</style><div id="host"></div>');
 await page.addStyleTag({path:path.join(web,'stanza/stanza.css')});
 await page.evaluate(()=>{
  const h=window.h={time:1000,contexts:[],events:[],allocations:[],apps:[],created:0,mode:null,failDestroy:false,failRendererDestroy:false,pendingResolve:null,readyResolve:null};
  const get=HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext=function(kind,...args){const value=get.call(this,kind,...args);if(value&&/webgl/.test(kind)&&!h.contexts.includes(value)){h.contexts.push(value);h.events.push({kind,width:this.width,height:this.height,held:h.ledger&&h.ledger.snapshot().held,stack:new Error().stack});}return value;};
  for(const name of ['createProgram','bufferData','texImage2D','renderbufferStorage','renderbufferStorageMultisample'])for(const proto of [WebGLRenderingContext.prototype,WebGL2RenderingContext.prototype]){
   const native=proto[name];if(!native)continue;proto[name]=function(...args){h.allocations.push({name,held:h.ledger&&h.ledger.snapshot().held});return native.apply(this,args);};
  }
 });
 for(const file of sources){
  if(file==='vendor/pixi.min.js')await page.evaluate(()=>{h.ledger=StageResourceBudget.create(StageResourcePolicy);window.Stage={resources:()=>h.ledger};});
  await page.addScriptTag({path:path.join(web,file)});
 }
 await page.evaluate(()=>{h.moduleBaseline=h.ledger.snapshot();});
 await page.evaluate(({mode,kind})=>{
  h.rendererKind=mode;h.kind=kind;h.lines=[{start_ms:0,end_ms:8000,text:'晚风送来轻轻的问候'}];
  window.Stage={resources:()=>h.ledger,isDocumentHidden:()=>!!h.hidden,presentation:()=>({playing:false,reduced:false,track:{id:'pixi-m1',title:'Pixi lifecycle'}}),position:()=>h.time,
   lyrics:()=>({lines:h.lines}),lyricTokens:line=>[{text:line.text,start_ms:line.start_ms,end_ms:line.end_ms}],spectrum:()=>[],kick(){}};
  const applicationInit=PIXI.Application.prototype.init,applicationDestroy=PIXI.Application.prototype.destroy;
  PIXI.Application.prototype.init=async function(options){h.created++;h.apps.push(this);await applicationInit.call(this,options);h.app=this;h.gl=this.renderer.gl;
   if(h.mode==='failure')throw new Error('controlled application initialization failure');
   if(h.mode==='pending'){await new Promise(resolve=>{h.pendingResolve=resolve;h.readyResolve();});}
  };
  PIXI.Application.prototype.destroy=function(...args){if(h.failDestroy){h.failDestroy=false;throw new Error('controlled application cleanup failure');}return applicationDestroy.apply(this,args);};
  const rendererInit=PIXI.WebGLRenderer.prototype.init,rendererDestroy=PIXI.WebGLRenderer.prototype.destroy;
  PIXI.WebGLRenderer.prototype.init=async function(options){await rendererInit.call(this,options);if(h.mode==='renderer-failure'){h.gl=this.gl;throw new Error('controlled renderer initialization failure');}};
  PIXI.WebGLRenderer.prototype.destroy=function(...args){if(h.failRendererDestroy){h.failRendererDestroy=false;throw new Error('controlled partial renderer cleanup failure');}return rendererDestroy.apply(this,args);};
  h.mount=phase=>{h.mode=phase;h.ready=new Promise(resolve=>{h.readyResolve=resolve;});h.renderer=(mode==='sonnet'?StanzaSonnet:StanzaTempera).init(document.getElementById('host'));h.renderer.setVisible(true);};
  h.settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
 },{mode,kind});return page;
}
async function close(page){await page.evaluate(()=>{if(h.pendingResolve)h.pendingResolve();if(h.renderer)h.renderer.destroy();});await page.close();}
async function check(name,run){try{report.checks.push({name,passed:true,evidence:await run()});console.log('PASS '+name);}catch(error){report.checks.push({name,passed:false,error:error.stack});console.error('FAIL '+name+': '+error.message);}}
async function main(){browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});report.browserVersion=browser.version();report.platform=process.platform;try{
 await check('competing context owner refuses cold WebGL probes without caching false or leaking their canvases',async()=>{
  const samples=[];for(const mode of ['sonnet','tempera']){const page=await boot(mode);try{
   await page.evaluate(()=>{const s=h.ledger.snapshot();h.competitor=h.ledger.port('other-real-context-owner').require({gpuContexts:s.caps.gpuContexts},'another admitted host owns all available contexts',1);h.competitor.commit();h.before=h.ledger.snapshot();});
   const attempts=[];for(let i=0;i<3;i++){await page.evaluate(()=>h.mount('positive'));await page.waitForFunction(()=>h.renderer.isReady());attempts.push(await page.evaluate(()=>{const failed=h.renderer.getDebugSnapshot();h.renderer.destroy();return{failed,after:h.ledger.snapshot(),nativeContexts:h.events.length}}));}
   for(const row of attempts){assert.equal(row.failed.initialized,false);assert.equal(row.failed.cleanupFailure,null);assert.equal(row.nativeContexts,0);assert.equal(row.after.held.canvases,0);assert.equal(row.after.held.ownedCpuBytes,212);assert.equal(row.after.held.gpuContexts,row.after.caps.gpuContexts);}
   await page.evaluate(()=>{h.competitor.release({apiReleased:true,allocationEnded:true});h.mount('positive')});await page.waitForFunction(()=>h.renderer.getDebugSnapshot().initialized);
   const retried=await page.evaluate(()=>{h.renderer.frame();return{debug:h.renderer.getDebugSnapshot(),webgl:!!h.app.renderer.gl,ledger:h.ledger.snapshot()}});
   assert.equal(retried.webgl,true);assert.equal(retried.debug.initialized,true);assert.equal(retried.ledger.live.gpuContexts,1);samples.push({mode,attempts,retried});
  }finally{await close(page);}}return samples;
 });
 await check('view allocation refusal before init retires constructed pipes and the original partial renderer',async()=>{
  const samples=[];for(const mode of ['sonnet','tempera']){const page=await boot(mode);try{
   await page.evaluate(()=>{const create=PIXI.HertzResourceAdmission.create;PIXI.HertzResourceAdmission.create=function(port){const owner=create(port),reserve=owner.reserve;owner.reserve=function(vector,source,...args){if(!h.competitor&&source==='canvas object'){const s=h.ledger.snapshot();h.competitor=h.ledger.port('other-real-canvas-owner').require({canvases:s.caps.canvases-s.held.canvases},'another admitted host uses canvas slots after capability probe',1);h.competitor.commit();}return reserve.call(this,vector,source,...args)};return owner};h.mount('positive');});
   await page.waitForFunction(()=>h.renderer.isReady());
   const failed=await page.evaluate(()=>{const before=h.renderer.getDebugSnapshot();h.renderer.destroy();h.competitor.release({apiReleased:true,allocationEnded:true});return{before,after:h.renderer.getDebugSnapshot(),ledger:h.ledger.snapshot(true)}});
   assert.equal(failed.before.cleanupFailure,null);assert.equal(failed.after.cleanupFailure,null);assert.equal(failed.ledger.held.gpuContexts,0);assert.equal(failed.ledger.held.canvases,0);assert.equal(failed.ledger.entries.filter(e=>e.owner==='stanza-'+mode).length,0);
   await page.evaluate(()=>h.mount('positive'));await page.waitForFunction(()=>h.renderer.getDebugSnapshot().initialized);const retry=await page.evaluate(()=>{h.renderer.frame();return{debug:h.renderer.getDebugSnapshot(),webgl:!!h.app.renderer.gl,ledger:h.ledger.snapshot()}});assert.equal(retry.webgl,true);assert.equal(retry.debug.initialized,true);samples.push({mode,failed,retry});
  }finally{await close(page);}}return samples;
 });
 await check('both unpublished program uniform metadata loops release successful allocations on later budget refusal',async()=>{
  const samples=[];for(const loop of ['description','locations']){const page=await boot('sonnet');try{
   await page.evaluate(loop=>{
    h.metadataLoop=loop;h.metadataSeen=0;
    for(const proto of [WebGLRenderingContext.prototype,WebGL2RenderingContext.prototype]){const parameter=proto.getProgramParameter,location=proto.getUniformLocation;proto.getProgramParameter=function(program,pname){const result=parameter.call(this,program,pname);if(pname===this.ACTIVE_UNIFORMS){h.metadataSeen=0;h.descriptionReads=true;}return result};proto.getUniformLocation=function(...args){if(h.descriptionReads)h.metadataSeen=0;h.descriptionReads=false;return location.apply(this,args)};}
    const port=h.ledger.port.bind(h.ledger);const pagePort=port('uniform-interrupted-competitor');
    const reserve=PIXI.HertzResourceAdmission.typed;
    PIXI.HertzResourceAdmission.typed=function(Type,value,source,...args){
      if(source==='program uniform metadata'&&h.injectMetadata&&((h.metadataLoop==='description'&&h.descriptionReads)||(h.metadataLoop==='locations'&&!h.descriptionReads))){
        h.metadataSeen++;
        if(h.metadataSeen===2){const state=h.ledger.snapshot();h.competitor=pagePort.require({ownedCpuBytes:state.caps.ownedCpuBytes-state.held.ownedCpuBytes},'competing CPU work begins after first uniform array',1);h.competitor.commit();}
      }
      return reserve.call(this,Type,value,source,...args);
    };
   },loop);
   const attempts=[];
   for(let i=0;i<3;i++){
    await page.evaluate(()=>{h.injectMetadata=false;h.mount('positive')});await page.waitForFunction(()=>h.renderer.getDebugSnapshot().initialized);
    const result=await page.evaluate(()=>{h.injectMetadata=true;h.metadataSeen=0;let error;try{h.app.hertzResources.run(()=>h.app.renderer.shader._getProgramData(h.app.renderer.renderPipes.graphics._adaptor.shader.glProgram));}catch(e){error=e.message}h.injectMetadata=false;h.renderer.destroy();if(h.competitor){h.competitor.release({apiReleased:true,allocationEnded:true});h.competitor=null;}return{error,failed:h.renderer.getDebugSnapshot(),seen:h.metadataSeen,after:h.ledger.snapshot(true)}});
    assert.equal(result.error,'aggregate-budget',loop+' budget failure reached');assert.equal(result.failed.initialized,false);assert.equal(result.failed.cleanupFailure,null);assert.equal(result.seen,2);assert.equal(result.after.held.gpuContexts,0);assert.equal(result.after.violations.length,0);attempts.push(result);
   }
   const metadataRows=attempts.map(x=>x.after.entries.filter(e=>e.basis.source.includes('program uniform metadata')));for(const rows of metadataRows)assert.equal(rows.length,0,'no unpublished Cc array is retained');
   for(const result of attempts.slice(1))assert.deepEqual(result.after.held,attempts[0].after.held,'same retained shared baseline across failures');
   await page.evaluate(()=>{h.injectMetadata=false;h.mount('positive')});await page.waitForFunction(()=>h.renderer.getDebugSnapshot().initialized);const valid=await page.evaluate(()=>{h.renderer.frame();const ready=h.renderer.getDebugSnapshot();h.renderer.destroy();return{ready,after:h.ledger.snapshot(true)}});assert.equal(valid.ready.initialized,true);assert.equal(valid.after.held.gpuContexts,0);samples.push({loop,attempts,valid});
  }finally{await close(page);}}return samples;
 });
 await check('ten thousand normalized lines reserve before mapping; sharing, unchanged frames and last borrower retirement are exact',async()=>{
  const samples=[];
  for(const cap of [0,1024*1024,16*1024*1024]){const page=await boot('sonnet');try{
   const sample=await page.evaluate(cap=>{h.ledger=StageResourceBudget.create({...StageResourcePolicy,caps:{...StageResourcePolicy.caps,ownedCpuBytes:cap}});h.lines=Array.from({length:10000},(_,i)=>({start_ms:i*1000,end_ms:i*1000+900,text:'word',words:[{text:'word',start_ms:i*1000,end_ms:i*1000+900}]}));let maps=0,tokens=0;const nativeMap=h.lines.map;h.lines.map=function(...args){maps++;return nativeMap.apply(this,args)};Stage.lyricTokens=line=>{tokens++;return line.words};const a=document.createElement('div'),b=document.createElement('div');let frame,error;
    try{frame=StanzaSonnet.buildFrame(a)}catch(e){error=e.message}
    const first={maps,tokens,count:frame&&frame.lines.length,error,ledger:h.ledger.snapshot()};
    if(!frame)return{cap,first};
    const again=StanzaSonnet.buildFrame(a),shared=StanzaSonnet.buildFrame(b),same=frame.lines===again.lines&&frame.lines===shared.lines;
    const unchanged=h.ledger.snapshot();StanzaSonnet.releaseFrame(a);const oneBorrower=h.ledger.snapshot();StanzaSonnet.releaseFrame(b);const none=h.ledger.snapshot();
    frame=StanzaSonnet.buildFrame(a);const keepOld=frame.retainLines();h.lines=h.lines.slice(0,20);const replacement=StanzaSonnet.buildFrame(a);StanzaSonnet.finishFrame(a);const retained=h.ledger.snapshot();keepOld();const afterOld=h.ledger.snapshot();StanzaSonnet.releaseFrame(a);return{cap,first,same,unchanged,oneBorrower,none,retained,afterOld,final:h.ledger.snapshot(),replacement:replacement.lines.length};
   },cap);
   if(cap<16*1024*1024){assert.equal(sample.first.maps,0);assert.equal(sample.first.tokens,0);assert.equal(sample.first.error,'aggregate-budget');assert.equal(sample.first.ledger.held.ownedCpuBytes,0);assert.equal(sample.first.ledger.rejections,1);}
   else{assert.equal(sample.first.count,10000);assert.equal(sample.first.maps,1);assert.equal(sample.same,true);assert.deepEqual(sample.unchanged.held,sample.first.ledger.held);assert.deepEqual(sample.oneBorrower.held,sample.first.ledger.held);assert.equal(sample.none.held.ownedCpuBytes,0);assert.ok(sample.retained.held.ownedCpuBytes>sample.afterOld.held.ownedCpuBytes);assert.equal(sample.replacement,20);assert.equal(sample.final.held.ownedCpuBytes,0);}
   samples.push(sample);
  }finally{await close(page);}}return samples;
 });
 await check('DefaultBatcher index and sampler refusal retire the already-created attribute backing',async()=>{
  const samples=[];for(const cap of [16,36,40]){const page=await boot('sonnet');try{
   const sample=await page.evaluate(cap=>{h.ledger=StageResourceBudget.create({...StageResourcePolicy,caps:{...StageResourcePolicy.caps,ownedCpuBytes:cap}});const owner=PIXI.HertzResourceAdmission.create(h.ledger.port('partial-batcher'));let batch,error;try{batch=owner.run(()=>new PIXI.DefaultBatcher({attributesInitialSize:4,indicesInitialSize:10,maxTextures:1}));}catch(e){error=e.message}const created=h.ledger.snapshot(true);if(batch)batch.destroy();owner.retire();return{cap,error,created,after:h.ledger.snapshot(true)}},cap);
   if(cap<40){assert.equal(sample.error,'aggregate-budget');assert.equal(sample.created.held.ownedCpuBytes,0);assert.equal(sample.after.held.ownedCpuBytes,0);assert.equal(sample.created.peak.ownedCpuBytes,cap);}
   else{assert.equal(sample.error,undefined);assert.equal(sample.created.held.ownedCpuBytes,40);assert.equal(sample.after.held.ownedCpuBytes,4);assert.equal(sample.after.entries.length,1);assert.ok(sample.after.entries[0].basis.source.includes('sampler'));}samples.push(sample);
  }finally{await close(page);}}return samples;
 });
 await check('editorial route reserves the complete new layout before compiling and releases it at destruction',async()=>{
  const samples=[];for(const refuse of [false,true]){const page=await boot('sonnet');try{
   await page.evaluate(()=>{h.lines=Array.from({length:20},(_,i)=>({start_ms:i*9000,end_ms:(i+1)*9000,text:'word'}));h.mount('positive');h.renderer.setTuning({lyricLayout:'editorial-track',accents:false});});
   await page.waitForFunction(()=>h.renderer.getDebugSnapshot().initialized);
   const result=await page.evaluate(refuse=>{h.renderer.frame();const initial=h.ledger.snapshot(true);const originalLine=h.lines[0];h.lines=Array.from({length:10000},(_,i)=>i?{start_ms:i*9000,end_ms:(i+1)*9000,text:'word'}:originalLine);const candidate=StanzaSonnet.buildFrame(h.renderer.rootEl());let ticket;if(refuse){const held=h.ledger.snapshot();ticket=h.ledger.port('layout-competition').require({ownedCpuBytes:held.caps.ownedCpuBytes-held.held.ownedCpuBytes-410000+1},'other host leaves less than complete layout capacity',1);ticket.commit();}let compiled=0;const random=StanzaSonnetFx.seededRandom;StanzaSonnetFx.seededRandom=function(seed){if(seed.startsWith('editorial-track:'))compiled++;return random(seed)};h.renderer.frame();const rendered={debug:h.renderer.getDebugSnapshot(),ledger:h.ledger.snapshot(true),compiled};h.renderer.destroy();if(ticket)ticket.release({apiReleased:true,allocationEnded:true});return{refuse,initial,rendered,after:h.ledger.snapshot(true),candidateCount:candidate.lines.length};},refuse);
   const initialRoute=result.initial.entries.find(x=>x.basis.source.includes('editorial route:'));assert.ok(initialRoute);assert.equal(initialRoute.live.ownedCpuBytes,820);assert.equal(result.candidateCount,10000);
   if(refuse){assert.equal(result.rendered.compiled,0);assert.equal(result.rendered.debug.initialized,false);assert.ok(result.rendered.ledger.rejections>0);}
   else{assert.equal(result.rendered.compiled,10000);assert.equal(result.rendered.debug.initialized,true);const routes=result.rendered.ledger.entries.filter(x=>x.basis.source.includes('editorial route:'));assert.equal(routes.length,1);assert.equal(routes[0].live.ownedCpuBytes,410000);}
   assert.equal(result.after.entries.filter(x=>x.owner==='stanza-lyrics-normalized'||x.basis.source.includes('editorial route:')).length,0);assert.equal(result.after.violations.length,0);samples.push(result);
  }finally{await close(page);}}return samples;
 });
 await check('actual text, graphics, masks and both optical passes render through admitted API resources',async()=>{
  const samples=[];for(const mode of ['sonnet','tempera']){const page=await boot(mode);try{
   await page.evaluate(()=>h.mount('positive'));await page.waitForFunction(()=>h.renderer.getDebugSnapshot().initialized);
   const result=await page.evaluate(()=>{h.renderer.frame();return{debug:h.renderer.getDebugSnapshot(),ledger:h.ledger.snapshot(true),allocations:h.allocations,events:h.events,canvas:document.querySelector('canvas')&&{width:h.app.canvas.width,height:h.app.canvas.height},fallback:document.querySelector('.fl-pixi-fallback').hidden};});
   assert.equal(result.debug.initialized,true);assert.ok(result.debug.glyphs>0);assert.equal(result.fallback,true);assert.ok(result.ledger.live.programs>0);assert.ok(result.ledger.live.textureDeclaredBytes>0);assert.ok(result.ledger.live.renderTargetDeclaredBytes>0);assert.ok(result.ledger.live.bufferDeclaredBytes>0);assert.equal(result.ledger.violations.length,0);samples.push({mode,...result});
   for(const event of result.events)assert.ok(event.held.gpuContexts>0,'native getContext is preceded by context reservation');
   for(const event of result.allocations)assert.ok(event.name==='texImage2D'?(event.held.textureDeclaredBytes+event.held.renderTargetDeclaredBytes)>0:event.held[event.name==='createProgram'?'programs':event.name==='bufferData'?'bufferDeclaredBytes':'renderTargetDeclaredBytes']>0,'native '+event.name+' allocation has prior admission');
   await page.screenshot({path:path.join(out,mode+'-positive.png')});
  }finally{await close(page);}}return samples;
 });
 await check('zero layout defers all native allocation, hidden frames keep charges and same resources',async()=>{
  const samples=[];for(const mode of ['sonnet','tempera']){const page=await boot(mode);try{
   await page.evaluate(()=>{document.getElementById('host').style.display='none';h.mount('positive');});await page.waitForTimeout(40);
   const zero=await page.evaluate(()=>({created:h.created,contexts:h.contexts.length,ledger:h.ledger.snapshot(),baseline:h.moduleBaseline}));assert.equal(zero.created,0);assert.equal(zero.contexts,0);assert.deepEqual(zero.ledger.held,zero.baseline.held);
   await page.evaluate(()=>{document.getElementById('host').style.display='';h.renderer.frame();});await page.waitForFunction(()=>h.renderer.getDebugSnapshot().initialized);
   const hidden=await page.evaluate(()=>{h.renderer.frame();h.hidden=true;const before={allocations:h.allocations.length,ledger:h.ledger.snapshot().held};for(let i=0;i<50;i++){h.time+=200;h.renderer.frame();h.renderer.resize();}return{before,after:{allocations:h.allocations.length,ledger:h.ledger.snapshot().held}};});assert.deepEqual(hidden.after,hidden.before);samples.push({mode,zero,hidden});
  }finally{await close(page);}}return samples;
 });
 await check('original seven SVG emotion glyph effects retain their Pixi geometry and readable lyrics',async()=>{
  const samples=[];for(const mode of ['sonnet','tempera']){const page=await boot(mode);try{
   await page.addScriptTag({path:path.join(web,'lyric-emotion-field.js')});
   await page.addScriptTag({path:path.join(web,'lyric-emotion.js')});
   await page.evaluate(()=>{const original=LyricEmotion;window.LyricEmotion={...original,resolveForLine:()=>({id:h.emotion||'joy',intensity:1,palette:{ink:'#fff',accent:'#fea'},type:null})};h.mount('positive');});
   await page.waitForFunction(()=>h.renderer.getDebugSnapshot().initialized);
   const rows=await page.evaluate(()=>{const rows=[];for(const [i,id]of ['joy','sorrow','anger','anxious','tender','triumph','lonely'].entries()){h.emotion=id;h.time=i*9000+1000;h.lines=[{start_ms:i*9000,end_ms:(i+1)*9000,text:'晚风送来轻轻的问候'}];h.renderer.frame();let effects=0;function visit(node){if(!node)return;if(node.label&&node.label.startsWith('emotion-fx-'))effects++;for(const child of node.children||[])visit(child);}visit(h.app.stage);rows.push({id,effects,debug:h.renderer.getDebugSnapshot(),ledger:h.ledger.snapshot()});}return rows;});
   for(const row of rows){assert.equal(row.debug.initialized,true,mode+' '+row.id);assert.ok(row.effects>0,mode+' '+row.id+' effect geometry remains');assert.equal(row.ledger.violations.length,0);}samples.push({mode,rows});
  }finally{await close(page);}}return samples;
 });
 await check('all finite resource dimensions refuse before their native allocations and preserve readable DOM lyrics',async()=>{
  const samples=[];for(const mode of ['sonnet','tempera'])for(const dimension of ['gpuContexts','canvases','drawingBufferPixels','programs','textureDeclaredBytes','renderTargetDeclaredBytes','bufferDeclaredBytes','ownedCpuBytes']){const page=await boot(mode);try{
   await page.evaluate(dimension=>{h.ledger=StageResourceBudget.create({...StageResourcePolicy,caps:{...StageResourcePolicy.caps,[dimension]:0}});h.mount('positive');},dimension);
   await page.waitForFunction(()=>{h.renderer.frame();return h.renderer.isReady();});
   const result=await page.evaluate(dimension=>({debug:h.renderer.getDebugSnapshot(),ledger:h.ledger.snapshot(),events:h.events,allocations:h.allocations,text:document.querySelector('.fl-pixi-fallback').textContent,hidden:document.querySelector('.fl-pixi-fallback').hidden}),dimension);
   assert.equal(result.debug.initialized,false,mode+' '+dimension);assert.equal(result.hidden,false);assert.equal(result.text,'晚风送来轻轻的问候');assert.equal(result.ledger.violations.length,0);assert.ok(result.ledger.rejections>0);assert.equal(result.ledger.peak[dimension],0);
   if(dimension==='gpuContexts'||dimension==='canvases')assert.equal(result.events.length,0,mode+' '+dimension);
   if(dimension==='drawingBufferPixels')assert.ok(result.events.every(x=>x.width*x.height===0),'zero-pixel capability probes only');
   const method={programs:'createProgram',bufferDeclaredBytes:'bufferData',renderTargetDeclaredBytes:'renderbufferStorageMultisample'}[dimension];if(method)assert.equal(result.allocations.filter(x=>x.name===method).length,0);
   samples.push({mode,dimension,debug:result.debug,ledger:result.ledger});
  }finally{await close(page);}}return samples;
 });
 await check('one hundred real lyric replacements retain pool charges and retirement semantics without resource violations',async()=>{
  const samples=[];for(const mode of ['sonnet','tempera']){const page=await boot(mode);try{
   await page.evaluate(()=>h.mount('positive'));await page.waitForFunction(()=>h.renderer.getDebugSnapshot().initialized);
   const result=await page.evaluate(()=>{const rows=[];for(let i=0;i<100;i++){h.time=i*9000+1000;h.lines=[{start_ms:i*9000,end_ms:(i+1)*9000,text:'晚风送来轻轻的问候 '+i}];h.renderer.frame();if(i%10===0||i===99)rows.push({i,debug:h.renderer.getDebugSnapshot(),ledger:h.ledger.snapshot()});}h.renderer.destroy();return{rows,after:h.ledger.snapshot(true),contexts:h.contexts.map(gl=>gl.isContextLost())};});
   for(const row of result.rows){assert.equal(row.debug.initialized,true,mode+' replacement '+row.i);assert.equal(row.ledger.violations.length,0);}
   assert.equal(result.after.live.gpuContexts,0);assert.equal(result.after.live.programs,0);assert.equal(result.after.live.textureDeclaredBytes,0);assert.equal(result.after.live.renderTargetDeclaredBytes,0);assert.equal(result.after.live.bufferDeclaredBytes,0);assert.ok(result.contexts.every(Boolean));samples.push({mode,...result});
  }finally{await close(page);}}return samples;
 });
 await check('growth refuses a replacement peak while old backing remains held; later explicit reopen succeeds',async()=>{
  const samples=[];for(const mode of ['sonnet','tempera']){const page=await boot(mode);try{
   await page.evaluate(()=>h.mount('positive'));await page.waitForFunction(()=>h.renderer.getDebugSnapshot().initialized);
   const before=await page.evaluate(()=>{h.renderer.frame();const s=h.ledger.snapshot();h.blocker=h.ledger.port('fixture-other-owner').require({drawingBufferPixels:s.caps.drawingBufferPixels-s.held.drawingBufferPixels},'other admitted host drawing surface',1);h.blocker.commit();return{canvas:{width:h.app.canvas.width,height:h.app.canvas.height},ledger:h.ledger.snapshot()};});
   await page.setViewportSize({width:1200,height:800});
   const denied=await page.evaluate(()=>{h.renderer.frame();const failed={debug:h.renderer.getDebugSnapshot(),ledger:h.ledger.snapshot(),hidden:document.querySelector('.fl-pixi-fallback').hidden};h.blocker.release({apiReleased:true,allocationEnded:true});return failed;});
   assert.equal(denied.debug.initialized,false);assert.equal(denied.hidden,false);assert.equal(denied.ledger.peak.drawingBufferPixels,denied.ledger.caps.drawingBufferPixels);assert.equal(denied.ledger.violations.length,0);
   await page.evaluate(()=>{h.renderer.destroy();h.mount('positive');});await page.waitForFunction(()=>h.renderer.getDebugSnapshot().initialized);
   const reopened=await page.evaluate(()=>{h.renderer.frame();return{debug:h.renderer.getDebugSnapshot(),ledger:h.ledger.snapshot()};});assert.equal(reopened.debug.initialized,true);assert.equal(reopened.ledger.live.gpuContexts,1);samples.push({mode,before,denied,reopened});
  }finally{await close(page);}}return samples;
 });
 await check('CPU refusal during unattached Graphics construction retires the original partial context and keeps shared cache charged',async()=>{
  const samples=[];for(const mode of ['sonnet','tempera']){const page=await boot(mode);try{
   await page.evaluate(()=>h.mount('positive'));await page.waitForFunction(()=>h.renderer.getDebugSnapshot().initialized);
   const result=await page.evaluate(()=>{h.renderer.frame();const before=h.ledger.snapshot();const ticket=h.ledger.port('fixture-other-cpu').require({ownedCpuBytes:before.caps.ownedCpuBytes-before.held.ownedCpuBytes},'other admitted host CPU backing',1);ticket.commit();h.time=10000;h.lines=[{start_ms:9000,end_ms:16000,text:'极长新歌词'.repeat(200)}];h.renderer.frame();const after=h.ledger.snapshot(true);ticket.release({apiReleased:true,allocationEnded:true});return{before,after,debug:h.renderer.getDebugSnapshot(),text:document.querySelector('.fl-pixi-fallback').textContent};});
   assert.equal(result.debug.initialized,false);assert.ok(result.text.length>500);assert.equal(result.after.violations.length,0);assert.equal(result.after.live.gpuContexts,0);assert.equal(result.after.entries.filter(x=>x.owner==='stanza-'+mode).length,0);samples.push({mode,...result});
  }finally{await close(page);}}return samples;
 });
 await check('twenty rendered open/close cycles and real context loss retire original contexts without automatic reconstruction',async()=>{
  const samples=[];for(const mode of ['sonnet','tempera']){const page=await boot(mode);try{
   const rows=[];for(let i=0;i<20;i++){await page.evaluate(()=>h.mount('positive'));await page.waitForFunction(()=>h.renderer.getDebugSnapshot().initialized);rows.push(await page.evaluate(()=>{h.renderer.frame();const before=h.ledger.snapshot();h.renderer.destroy();const after=h.ledger.snapshot(true),pool={};for(const entry of after.entries)if(!entry.basis.source.includes('TextMetrics cache'))for(const [key,n]of Object.entries(entry.live))pool[key]=(pool[key]||0)+n;return{before,after,pool,metricEntries:after.entries.filter(e=>e.basis.source.includes('TextMetrics cache')).length};}));}
   for(const row of rows){assert.ok(row.before.live.gpuContexts>0);assert.equal(row.after.live.gpuContexts,0);assert.equal(row.after.live.programs,0);assert.equal(row.after.live.bufferDeclaredBytes,0);}
   for(const row of rows.slice(6)){assert.deepEqual(row.pool,rows[6].pool,'original shared pool capacities stabilize after warm-up');assert.ok(row.metricEntries<=1000,'original metrics cache remains bounded');}
   await page.evaluate(()=>h.mount('positive'));await page.waitForFunction(()=>h.renderer.getDebugSnapshot().initialized);await page.evaluate(()=>{h.renderer.frame();h.gl.getExtension('WEBGL_lose_context').loseContext();});await page.waitForTimeout(40);
   const loss=await page.evaluate(()=>{for(let i=0;i<100;i++)h.renderer.frame();return{created:h.created,debug:h.renderer.getDebugSnapshot(),ledger:h.ledger.snapshot(),text:document.querySelector('.fl-pixi-fallback').textContent};});
   assert.equal(loss.created,21);assert.equal(loss.debug.initialized,false);assert.equal(loss.ledger.live.gpuContexts,0);assert.equal(loss.text,'晚风送来轻轻的问候');samples.push({mode,rows,loss});
  }finally{await close(page);}}return samples;
 });
 await check('actual failed renderer creation retires its original GL context before Application takes ownership',async()=>{
  const samples=[];for(const mode of ['sonnet','tempera']){const page=await boot(mode);try{
   await page.evaluate(()=>h.mount('renderer-failure'));await page.waitForFunction(()=>h.renderer.isReady());
   const result=await page.evaluate(()=>{const first=h.created;for(let i=0;i<50;i++)h.renderer.frame();const fallback=document.querySelector('.fl-pixi-fallback');return{first,after:h.created,lost:h.gl.isContextLost(),debug:h.renderer.getDebugSnapshot(),text:fallback.textContent,display:getComputedStyle(fallback).display,events:h.events};});
   assert.equal(result.first,1);assert.equal(result.after,1);assert.equal(result.lost,true);assert.equal(result.debug.initialized,false);assert.equal(result.debug.initializing,false);assert.equal(result.text,'晚风送来轻轻的问候');assert.notEqual(result.display,'none');samples.push({mode,...result});
  }finally{await close(page);}}return samples;
 });
 await check('actual settled Application rejection retires its stage/renderer and keeps current lyrics readable through subsequent media changes',async()=>{
  const samples=[];for(const mode of ['sonnet','tempera']){const page=await boot(mode);try{
   await page.evaluate(()=>h.mount('failure'));await page.waitForFunction(()=>h.renderer.isReady());
   const result=await page.evaluate(()=>{const before={text:document.querySelector('.fl-pixi-fallback').textContent,lost:h.gl.isContextLost(),debug:h.renderer.getDebugSnapshot()};h.lines=[{start_ms:0,end_ms:8000,text:'换句后仍可读'}];h.renderer.frame();
    const textRect=el=>{if(!el||el.hidden||!el.textContent)return null;const r=document.createRange();r.selectNodeContents(el);const b=r.getBoundingClientRect();return{top:b.top,bottom:b.bottom,left:b.left,right:b.right};};
    const fb=textRect(document.querySelector('.fl-pixi-fallback'));
    const guideEl=[...document.querySelectorAll('.fl-empty,.fl-tempera-note')].find(el=>!el.hidden&&el.textContent);
    const guide=textRect(guideEl);
    const overlap=!!(fb&&guide&&fb.top<guide.bottom&&guide.top<fb.bottom&&fb.left<guide.right&&guide.left<fb.right);
    return{before,after:document.querySelector('.fl-pixi-fallback').textContent,created:h.created,canvasCount:document.querySelectorAll('canvas').length,overlap,guideText:guideEl&&guideEl.textContent};});
   assert.equal(result.before.lost,true);assert.equal(result.before.debug.initialized,false);assert.equal(result.before.text,'晚风送来轻轻的问候');assert.equal(result.after,'换句后仍可读');assert.equal(result.created,1);assert.equal(result.canvasCount,0);
   assert.ok(result.guideText,'failure guidance stays visible');assert.equal(result.overlap,false,'failure guidance must not overlap the readable lyric');
   await page.screenshot({path:path.join(out,mode+'-failure-readable.png')});samples.push({mode,...result});
  }finally{await close(page);}}return samples;
 });
 await check('twenty real delayed Application lifetimes keep context ownership until settlement and reject late canvas/readiness publication',async()=>{
  const samples=[];for(const mode of ['sonnet','tempera']){const page=await boot(mode);try{
   const result=await page.evaluate(async()=>{const rows=[];for(let i=0;i<20;i++){
    h.mount('pending');const api=h.renderer;await h.ready;const context=h.gl,initial=api.getDebugSnapshot();api.destroy();
    const pending={lost:context.isContextLost(),ready:api.isReady(),ledger:h.ledger.snapshot(true)};h.pendingResolve();h.pendingResolve=null;await h.settle();
    rows.push({initial,pending,settled:{lost:context.isContextLost(),ready:api.isReady(),initializing:api.getDebugSnapshot().initializing,canvases:document.querySelectorAll('canvas').length,ledger:h.ledger.snapshot(true)}});
   }return{rows,created:h.created,events:h.events};});
   assert.equal(result.created,20);for(const row of result.rows){assert.equal(row.initial.initializing,true);assert.equal(row.initial.initialized,false);assert.equal(row.pending.lost,false);assert.equal(row.pending.ready,false);assert.ok(row.pending.ledger.held.gpuContexts>0);assert.equal(row.pending.ledger.entries.filter(e=>e.owner==='stanza-lyrics-normalized').length,1,'in-flight init closure still retains its frame');assert.equal(row.settled.lost,true);assert.equal(row.settled.ready,false);assert.equal(row.settled.initializing,false);assert.equal(row.settled.canvases,0);assert.equal(row.settled.ledger.held.gpuContexts,0);assert.equal(row.settled.ledger.entries.filter(e=>e.owner==='stanza-lyrics-normalized').length,0);}samples.push({mode,...result});
  }finally{await close(page);}}return samples;
 });
 await check('one hundred cancellation-before-Pixi-load continuations never construct an Application',async()=>{
  const samples=[];for(const mode of ['sonnet','tempera']){const page=await boot(mode);try{
   const result=await page.evaluate(async()=>{for(let i=0;i<100;i++){h.mount('pending');h.renderer.destroy();}await h.settle();return{created:h.created,canvases:document.querySelectorAll('canvas').length,events:h.events};});
   assert.equal(result.created,0);assert.equal(result.canvases,0);samples.push({mode,...result});
  }finally{await close(page);}}return samples;
 });
 await check('application and partial-renderer cleanup failures retain original owners for explicit retirement retry',async()=>{
  const samples=[];for(const mode of ['sonnet','tempera'])for(const owner of ['application','renderer']){const page=await boot(mode);try{
   await page.evaluate(owner=>{if(owner==='application')h.failDestroy=true;else h.failRendererDestroy=true;h.mount(owner==='application'?'failure':'renderer-failure');},owner);
   await page.waitForFunction(()=>h.renderer.isReady());
   const result=await page.evaluate(()=>{const failed={lost:h.gl.isContextLost(),debug:h.renderer.getDebugSnapshot()};h.renderer.destroy();return{failed,retried:{lost:h.gl.isContextLost(),debug:h.renderer.getDebugSnapshot()}};});
   assert.equal(result.failed.lost,false);assert.ok(result.failed.debug.cleanupFailure);assert.equal(result.retried.lost,true);assert.equal(result.retried.debug.cleanupFailure,null);samples.push({mode,owner,...result});
  }finally{await close(page);}}return samples;
 });
}finally{await browser.close();}report.passed=report.checks.every(check=>check.passed)&&report.errors.length===0;report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,errors:report.errors,report:path.relative(root,path.join(out,'report.json'))}));if(!report.passed)process.exitCode=1;}
main().catch(error=>{report.errors.push(error.stack);fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.error(error);process.exitCode=1;});
