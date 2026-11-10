// SPDX-License-Identifier: MIT
'use strict';
// Real Three/decoder and original runtime/scope/context owners. Synthetic targets.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createHash}=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),output=path.join(root,'output/playwright/wallpaper-builtin');
const mapping=JSON.parse(fs.readFileSync(path.join(output,'native-projections.json'))),files=new Map();
for(const item of Object.values(mapping))for(const file of item.files)files.set(file.url,{bytes:fs.readFileSync(path.join(output,file.file)),mime:file.entry.mime});
const catalog=require('../crates/hertz-wallpaper/contracts/catalog.json');
(async()=>{const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{const page=await browser.newPage({viewport:{width:800,height:600},deviceScaleFactor:1}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));let delayVideo=false,videoRequests=0;
  await page.route('**/*',async route=>{const url=route.request().url(),asset=files.get(url);
    if(asset){if(asset.mime.startsWith('video/')){videoRequests++;if(delayVideo)await new Promise(resolve=>setTimeout(resolve,300));}
      const range=/^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range||'');
      if(range){const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),asset.bytes.length-1):asset.bytes.length-1;
        return route.fulfill({status:206,contentType:asset.mime,headers:{'access-control-allow-origin':'*','accept-ranges':'bytes','content-range':`bytes ${start}-${end}/${asset.bytes.length}`},body:asset.bytes.subarray(start,end+1)});}
      return route.fulfill({contentType:asset.mime,headers:{'access-control-allow-origin':'*'},body:asset.bytes});}
    const pathname=new URL(url).pathname;
    if(pathname.startsWith('/tools/space-stage/src/')||pathname.startsWith('/tools/space-stage/node_modules/three/')&&pathname.endsWith('.js'))
      return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(root,pathname.slice(1)))});
    return route.fulfill({contentType:'text/html',body:'<body style="margin:0;background:black"><canvas></canvas></body>'});});
  await page.goto('http://127.0.0.1:41109/');
  await page.addScriptTag({type:'importmap',content:JSON.stringify({imports:{'three/':'/tools/space-stage/node_modules/three/','three':'/tools/space-stage/node_modules/three/build/three.module.js'}})});
  await page.addScriptTag({path:path.join(root,'plugin/ui/stage-resource-budget.js')});
  await page.addScriptTag({path:path.join(root,'plugin/ui/stage-resource-policy.js')});
  await page.addScriptTag({path:path.join(root,'plugin/ui/vendor/stage-runtime.js')});
  await page.evaluate(async catalog=>{
    const [{createRegistry},{sceneDefinitions},{compilePlan},{sourceIdentity},{createRenderContext},{createScope},{createCompositionRuntime},THREE]=await Promise.all([
      import('/tools/space-stage/src/registry.js'),import('/tools/space-stage/src/scenes/index.js'),import('/tools/space-stage/src/composition/plan.js'),
      import('/tools/space-stage/src/composition/builtin.js'),import('/tools/space-stage/src/render-context.js'),import('/tools/space-stage/src/scope.js'),
      import('/tools/space-stage/src/composition/runtime.js'),import('/tools/space-stage/node_modules/three/build/three.module.js')]);
    const registry=createRegistry();for(const metadata of catalog.scenes){const source=sceneDefinitions.find(source=>source.id===metadata.id);
      registry.register({...metadata,apiVersion:1,compositionResourcePlan:source?.compositionResourcePlan,create:source?.create||(()=>{throw new Error('unavailable test source');})});}
    window.m={registry,identity:await sourceIdentity(registry),compilePlan,createRenderContext,createScope,createCompositionRuntime,THREE};
    window.setContext=caps=>{window.ledger=StageResourceBudget.create({...StageResourcePolicy,caps:{...StageResourcePolicy.caps,...caps}});
      const canvas=document.createElement('canvas');document.querySelector('canvas').replaceWith(canvas);canvas.width=408;canvas.height=272;
      canvas.style.width='480px';canvas.style.height='320px';window.context=m.createRenderContext(m.THREE,canvas,{resources:ledger.port('lifecycle','lifecycle'),onContextLost:()=>window.scope?.dispose()});};
    window.prepare=async projection=>{window.plan=m.compilePlan(projection,m.registry,m.identity);window.scope=m.createScope({resources:context.pagePort,generation:projection.generation});
      scope.beginAllocation();try{window.runtime=await m.createCompositionRuntime(m.THREE,context,scope,plan,{generation:projection.generation});runtime.resize(480,320);}
      catch(error){scope.dispose();throw error;}finally{scope.endAllocation();}};
    window.frame=(time,seek=false,paused=true)=>runtime.update({sceneTime:time,seek,paused,level:.35,bands:{bass:.5,mid:.4,treble:.2},spectrum:[10,90,140,40]});
    window.pixels=async()=>{if(!runtime.render())throw new Error('no complete output');const gl=context.renderer.getContext(),bytes=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);
      gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');};
  },catalog);
  const results=[];
  for(const dimension of ['ownedCpuBytes','renderTargetDeclaredBytes','programs','bufferDeclaredBytes','textureDeclaredBytes','decodeReservedBytes','decoderLeases']){
    const result=await page.evaluate(async({projection,dimension})=>{const plan=m.compilePlan(projection,m.registry,m.identity);
      setContext({[dimension]:plan.resources[dimension]-1});let loads=0,factories=0;const acquire=context.pool.acquire.bind(context.pool);context.pool.acquire=(...args)=>{loads++;return acquire(...args);};
      const original=plan.builtin.definition;plan.builtin.definition={...original,create(...args){factories++;return original.create(...args);}};
      const scope=m.createScope({resources:context.pagePort,generation:projection.generation});scope.beginAllocation();let error='';
      try{await m.createCompositionRuntime(m.THREE,context,scope,plan,{generation:projection.generation});}catch(reason){error=reason.message;}
      finally{scope.dispose();scope.endAllocation();context.dispose();}return {dimension,error,loads,factories,ledger:ledger.snapshot()};
    },{projection:mapping.video.projection,dimension});
    assert(result.error);assert.equal(result.loads,0);assert.equal(result.factories,0);assert(Object.values(result.ledger.held).every(value=>value===0));results.push(result);
  }
  await page.evaluate(async projection=>{setContext({});await prepare(projection);},mapping.video.projection);
  await page.waitForFunction(()=>frame(.1,true));const first=await page.evaluate(async()=>{const hash=await pixels();runtime.commitMedia();return {hash,stats:runtime.stats()};});
  assert.equal(first.stats.builtin.input.committedTime,.1);
  const pending=await page.evaluate(()=>{frame(.17,true);return runtime.stats();});assert.equal(pending.builtin.input.committedTime,.1);
  await page.waitForFunction(()=>frame(.17,false,true));const paused=await page.evaluate(async()=>{const hash=await pixels();runtime.commitMedia();return {hash,stats:runtime.stats()};});
  assert.equal(paused.hash,first.hash);assert.equal(paused.stats.builtin.input.committedTime,.1);
  results.push({case:'real decoder pause after unsubmitted seek restores committed mixed output',first,pending,paused});
  await page.waitForFunction(()=>frame(.17,true));
  const failed=await page.evaluate(()=>{const render=context.renderer.render.bind(context.renderer);let calls=0,error='';context.renderer.render=(...args)=>{if(++calls===3)throw new Error('controlled final output failure');return render(...args);};
    try{runtime.render();}catch(reason){error=reason.message;}finally{context.renderer.render=render;}return {calls,error,stats:runtime.stats()};});
  assert.equal(failed.calls,3);assert.match(failed.error,/final output failure/);assert.equal(failed.stats.builtin.input.committedTime,.1);
  await page.waitForFunction(()=>frame(.17,false,true));const recovered=await page.evaluate(async()=>{const hash=await pixels();runtime.commitMedia();return {hash,stats:runtime.stats()};});
  assert.equal(recovered.hash,first.hash);results.push({case:'failed actual final output does not commit prepared decoder or input bank',failed,recovered});
  await page.evaluate(()=>{scope.dispose();});
  const borrowed=await page.evaluate(async projection=>{const before=context.stats();await prepare(projection);frame(.5,true);const hash=await pixels();runtime.commitMedia();return {before,after:context.stats(),hash,stats:runtime.stats()};},mapping['base-480-contain'].projection);
  assert.equal(borrowed.before.contextId,borrowed.after.contextId);assert.equal(borrowed.after.retired,false);results.push({case:'retired media composition leaves borrowed original renderer usable',borrowed});
  await page.evaluate(()=>scope.dispose());delayVideo=true;const requestsBefore=videoRequests;
  await page.evaluate(projection=>{window.pendingPreparation=prepare({...projection,generation:projection.generation+10}).then(()=>({ok:true}),error=>({error:error.message}));},mapping.video.projection);
  await page.waitForFunction(()=>context.pool.stats().poolPending>0);await page.evaluate(()=>scope.dispose());
  const cancellation=await page.evaluate(async()=>await pendingPreparation);assert(cancellation.error);assert(videoRequests>requestsBefore);
  delayVideo=false;
  const replacement=await page.evaluate(async projection=>{await prepare({...projection,generation:projection.generation+11});frame(.5,true);const hash=await pixels();runtime.commitMedia();return {hash,stats:runtime.stats(),context:context.stats()};},mapping['base-480-contain'].projection);
  assert.equal(replacement.stats.generation,mapping['base-480-contain'].projection.generation+11);
  results.push({case:'delayed real video load cancellation cannot submit into successor generation',cancellation,replacement});
  const gpu=await page.evaluate(()=>{const renderer=context.renderer,gl=renderer.getContext(),clear=gl.clear.bind(gl),masks=[];
    gl.clear=mask=>{masks.push(mask);return clear(mask);};frame(.6,true);runtime.render();runtime.commitMedia();gl.clear=clear;
    return {masks,depth:gl.DEPTH_BUFFER_BIT,render:renderer.info.render,stats:runtime.stats()};});
  assert(gpu.masks.some(mask=>mask===gpu.depth));assert.equal(gpu.stats.linearOutputPasses,1);assert(gpu.render.calls>=4);
  results.push({case:'actual GL clears builtin depth before planar rendering with one final output',gpu});
  await page.evaluate(()=>context.renderer.forceContextLoss());await page.waitForFunction(()=>context.stats().retired);
  const loss=await page.evaluate(()=>({context:context.stats(),scope:scope.stats(),ledger:ledger.snapshot()}));
  assert(Object.values(loss.ledger.held).every(value=>value===0),JSON.stringify(loss));results.push({case:'forced real context loss drains original borrower/context/decoder owners',loss});
  assert.deepEqual(errors,[]);
  const sourceFiles=['scripts/check-wallpaper-builtin-lifecycle-browser.js','tools/space-stage/src/composition/builtin.js','tools/space-stage/src/composition/runtime.js','tools/space-stage/src/composition/plan.js','tools/space-stage/src/scope.js','tools/space-stage/src/render-context.js'];
  fs.writeFileSync(path.join(output,'lifecycle-report.json'),JSON.stringify({qualification:'synthetic-native-target-production-source-real-browser',results,errors,
    sourceHashes:Object.fromEntries(sourceFiles.map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]))},null,2));
  console.log('Builtin lifecycle browser: '+results.length+' checks passed');
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
