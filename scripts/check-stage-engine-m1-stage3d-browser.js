'use strict';
// Production raw Stage3D context/surface/post owner in real Chrome. Authored
// scene shaders/buffers, Stanza/Pixi, wrappers and physical caps remain open.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=path.resolve(__dirname,'..'),web=path.join(root,'plugin/ui');
const sources=['stage-resource-budget.js','stage-resource-policy.js','stage-image-source.js','stage.js','onset.js','stage-settings.js','stage3d.js'];
const out=path.join(root,'output/a09-m1-20261108/stage3d-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(out,{recursive:true});
const report={startedAt:new Date().toISOString(),scope:'Production raw Stage3D context/input/drawing/post allocation subset only; controlled time is not physical qualification.',
  sourceSha256:Object.fromEntries([...sources,'index.html','stage3d.css'].map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(web,file))).digest('hex')])),checks:[],errors:[]};
let browser;
async function pageFor(caps={}){
  const page=await browser.newPage({viewport:{width:900,height:600}});page.on('pageerror',error=>report.errors.push(error.stack));
  await page.route('**/*',route=>route.abort());
  await page.setContent(fs.readFileSync(path.join(web,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,''));
  await page.addStyleTag({path:path.join(web,'stage3d.css')});
  await page.evaluate(()=>{
    const h=window.harness={time:100,hidden:false,next:0,callbacks:new Map(),contexts:0,textures:0,programs:0,buffers:0,draws:0,uniformNames:new Map(),uniforms:{}};
    performance.now=()=>h.time;requestAnimationFrame=fn=>{h.callbacks.set(++h.next,fn);return h.next;};cancelAnimationFrame=id=>h.callbacks.delete(id);
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>h.hidden});
    const get=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(kind,...args){if(/webgl/.test(kind))h.contexts++;const context=get.call(this,kind,...args);if(context&&/webgl/.test(kind)){
      h.gl=context;for(const [method,count]of[['createTexture','textures'],['createProgram','programs'],['createBuffer','buffers']]){const create=context[method].bind(context);context[method]=()=>{h[count]++;return create();};}
      const locate=context.getUniformLocation.bind(context),write=context.uniform1f.bind(context);
      context.getUniformLocation=(program,name)=>{const result=locate(program,name);if(result)h.uniformNames.set(result,name);return result;};
      context.uniform1f=(location,value)=>{h.uniforms[h.uniformNames.get(location)]=value;return write(location,value);};
      for(const method of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']) {
        const draw=context[method].bind(context);context[method]=(...args)=>{h.draws++;return draw(...args);};
      }
    }return context;};
    h.advance=async(count,dt=1000/60)=>{for(let i=0;i<count;i++){h.time+=dt;const work=[...h.callbacks.values()];h.callbacks.clear();work.forEach(fn=>fn(h.time));await Promise.resolve();}};
    h.hide=value=>{h.hidden=value;document.dispatchEvent(new Event('visibilitychange'));};
  });
  for(const file of sources){
    await page.addScriptTag({path:path.join(web,file)});
    if(file==='stage-resource-policy.js')await page.evaluate(caps=>{StageResourcePolicy=Object.freeze({...StageResourcePolicy,qualification:'contract-test-only',caps:Object.freeze({...StageResourcePolicy.caps,...caps})});},caps);
    if(file==='stage.js')await page.evaluate(()=>{Stage.init();Stage.setTrack({id:'m1-stage3d',title:'Stage3D contract',duration_ms:120000});Stage.setSnapshot({playing:false,track_id:'m1-stage3d',position_ms:0,duration_ms:120000,volume:.5});});
  }
  await page.evaluate(()=>{Stage3D.configure({sceneSource:'immersive',layout:'focus',lyrics:false});});return page;
}
async function close(page){await page.evaluate(()=>{Stage3D.destroy();Stage.destroy();});await page.close();}
async function mount(page){await page.evaluate(async()=>{Stage3D.open('aurora');await harness.advance(12);});assert.ok(await page.evaluate(()=>document.querySelector('.s3d-canvas')?.width>1));}
async function check(name,run){try{report.checks.push({name,passed:true,evidence:await run()});console.log('PASS '+name);}catch(error){report.checks.push({name,passed:false,error:error.stack});console.error('FAIL '+name+': '+error.message);}}
async function main(){browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});try{
  await check('raw geometry freezes through pause, hidden time, reduced motion and zero layout while seek relocates media independently',async()=>{
    const page=await pageFor();try{await mount(page);const result=await page.evaluate(async()=>{
      const phase=()=>Stage3D.stats().sceneTimeMs, snapshot=(playing,position=Stage.position(),seek=false)=>Stage.setSnapshot({playing,track_id:'m1-stage3d',position_ms:position,duration_ms:120000},{seek});
      const firstSubmit=async()=>{const before=harness.draws;for(let i=0;i<20&&harness.draws===before;i++)await harness.advance(1);if(harness.draws===before)throw new Error('No resumed raw submit');return phase();};
      snapshot(true);await harness.advance(12);const initial=phase();
      snapshot(false);await harness.advance(12);const paused=phase();
      Stage3D.configure({bloom:.55});await harness.advance(12);const edited=phase();
      harness.hide(true);harness.time+=60000;await harness.advance(12);const hidden=phase();
      harness.hide(false);snapshot(true,80000,true);const hiddenResume=await firstSubmit();const position=Stage.position();await harness.advance(12);const resumed=phase();
      Stage.setReducedMotion(true);await harness.advance(12);const reduced=phase();
      Stage.setReducedMotion(false);const reducedResume=await firstSubmit();await harness.advance(12);const afterReduced=phase();
      const wrap=document.getElementById('s3d-canvas-wrap');wrap.style.display='none';dispatchEvent(new Event('resize'));await harness.advance(12);const zero=phase();
      wrap.style.display='';dispatchEvent(new Event('resize'));const zeroResume=await firstSubmit();await harness.advance(12);const restored=phase();
      return{initial,paused,edited,hidden,hiddenResume,position,resumed,reduced,reducedResume,afterReduced,zero,zeroResume,restored};
    });assert.ok(result.initial>0);assert.equal(result.paused,result.initial);assert.equal(result.edited,result.paused);assert.equal(result.hidden,result.paused);
      assert.equal(result.hiddenResume,result.hidden);assert.ok(result.position>=80000);assert.ok(result.resumed>result.hiddenResume);assert.equal(result.reduced,result.resumed);
      assert.equal(result.reducedResume,result.reduced);assert.ok(result.afterReduced>result.reducedResume);assert.equal(result.zero,result.afterReduced);assert.equal(result.zeroResume,result.zero);assert.ok(result.restored>result.zeroResume);return result;
    }finally{await close(page);}
  });
  await check('raw audio rejects expired spectra and spectra received before hidden or zero-layout suspension ends',async()=>{
    const page=await pageFor();try{await mount(page);const result=await page.evaluate(async()=>{
      const signal=()=>Stage.setSpectrum(new Float32Array(64).fill(.65)),audio=()=>Stage3D.stats().audio;
      Stage.setSnapshot({playing:true,track_id:'m1-stage3d',position_ms:0,duration_ms:120000});signal();await harness.advance(12);const fresh=audio();
      await harness.advance(42);const expired=audio();harness.hide(true);signal();harness.time+=60000;harness.hide(false);await harness.advance(12);const hiddenResume=audio();
      signal();await harness.advance(12);const newSignal=audio();
      const wrap=document.getElementById('s3d-canvas-wrap');wrap.style.display='none';dispatchEvent(new Event('resize'));signal();await harness.advance(3);
      wrap.style.display='';dispatchEvent(new Event('resize'));await harness.advance(12);const zeroResume=audio();
      signal();await harness.advance(12);const zeroNewSignal=audio();return{fresh,expired,hiddenResume,newSignal,zeroResume,zeroNewSignal};
    });assert.ok(result.fresh.energy>.2);assert.equal(result.expired.energy,0);assert.equal(result.hiddenResume.energy,0);assert.ok(result.newSignal.energy>.2);
      assert.equal(result.zeroResume.energy,0,JSON.stringify(result));assert.equal(result.zeroResume.beat,0);assert.ok(result.zeroNewSignal.energy>.2);return result;
    }finally{await close(page);}
  });
  await check('inert evaluation and zero context budget reject before getContext or input arrays',async()=>{
    const page=await pageFor({gpuContexts:0});try{const result=await page.evaluate(async()=>{const baseline=Stage.resources().snapshot();Stage3D.open('aurora');await harness.advance(12);return{baseline,after:Stage.resources().snapshot(),contexts:harness.contexts,stats:Stage3D.stats(),canvases:document.querySelectorAll('.s3d-canvas').length};});
      assert.equal(result.baseline.resources,0);assert.equal(result.contexts,0);assert.equal(result.canvases,0);assert.deepEqual(result.after.held,result.baseline.held);return result;
    }finally{await close(page);}
  });
  await check('old/new surface refusal keeps the previously admitted actual pixels and post targets',async()=>{
    const page=await pageFor();try{await mount(page);const result=await page.evaluate(async()=>{
      const ledger=Stage.resources(),before=ledger.snapshot(true),canvas=document.querySelector('.s3d-canvas'),size={width:canvas.width,height:canvas.height},textures=harness.textures;
      const blocker=ledger.port('stage3d-pixel-competition').require({drawingBufferPixels:before.caps.drawingBufferPixels-before.held.drawingBufferPixels},'test competing pixels',0);
      const wrap=document.getElementById('s3d-canvas-wrap');wrap.style.width='480px';wrap.style.height='320px';dispatchEvent(new Event('resize'));await harness.advance(12);
      const refused={stats:Stage3D.stats(),width:canvas.width,height:canvas.height,textures:harness.textures,after:ledger.snapshot(true)};await harness.advance(120);const stable=ledger.snapshot();blocker.release({apiReleased:true,allocationEnded:true});return{before,size,textures,refused,stable};});
      assert.equal(result.refused.width,result.size.width);assert.equal(result.refused.height,result.size.height);assert.equal(result.refused.textures,result.textures);
      assert.equal(result.refused.stats.resources.failure,'aggregate-budget');assert.equal(result.stable.rejections,result.refused.after.rejections);return result;
    }finally{await close(page);}
  });
  await check('program and buffer refusal precede native allocation and cleanup the partial post context',async()=>{
    const samples=[];
    for(const caps of [{programs:0},{bufferDeclaredBytes:0}]){
      const page=await pageFor(caps);try{const result=await page.evaluate(async()=>{Stage3D.open('aurora');await harness.advance(12);return{programs:harness.programs,buffers:harness.buffers,ledger:Stage.resources().snapshot(true),stats:Stage3D.stats()};});
        assert.equal(caps.programs===0?result.programs:result.buffers,0);assert.equal(result.ledger.held.gpuContexts,0);assert.equal(result.ledger.held.programs,0);assert.equal(result.ledger.held.bufferDeclaredBytes,0);samples.push({caps,...result});
      }finally{await close(page);}
    }return samples;
  });
  await check('failed artwork replacement keeps its previous uploaded mip source and readable cover uniform',async()=>{
    const page=await pageFor();try{
      await page.evaluate(async()=>{
        const canvas=document.createElement('canvas');canvas.width=canvas.height=64;const ctx=canvas.getContext('2d');ctx.fillStyle='#b46035';ctx.fillRect(0,0,64,64);harness.cover=canvas.toDataURL();ctx.fillStyle='#307c61';ctx.fillRect(0,0,64,64);harness.nextCover=canvas.toDataURL();canvas.width=canvas.height=0;
        Stage.setTrack({id:'m1-stage3d',title:'Artwork contract',duration_ms:120000},harness.cover);Stage3D.open('silk');await harness.advance(12);
      });
      await page.waitForFunction(()=>Stage.resources().snapshot().held.decoderLeases>0);
      await page.waitForTimeout(40);await page.evaluate(()=>harness.advance(16));
      const result=await page.evaluate(async()=>{
        const ledger=Stage.resources(),before=ledger.snapshot(true);harness.beforeArt=before;
        harness.blocker=ledger.port('raw-artwork-coexistence').require({textureDeclaredBytes:before.caps.textureDeclaredBytes-before.held.textureDeclaredBytes},'test artwork competition',0);
        Stage.setTrack({id:'m1-stage3d',title:'Artwork contract',duration_ms:120000},harness.nextCover);await harness.advance(12);
        return{before};
      });
      await page.waitForTimeout(40);const after=await page.evaluate(async()=>{await harness.advance(16);const after=Stage.resources().snapshot(true),stats=Stage3D.stats(),uniform=harness.uniforms.uHasArt;harness.blocker.release({apiReleased:true,allocationEnded:true});return{after,stats,uniform};});
      const art=snapshot=>snapshot.entries.filter(entry=>/artwork replacement complete mip/.test(entry.basis.source));
      assert.equal(art(result.before).length,1);assert.deepEqual(art(after.after),art(result.before));assert.equal(after.uniform,1);assert.equal(after.stats.resources.failure,'aggregate-budget');return{...result,...after};
    }finally{await close(page);}
  });
  await check('post target rejection preserves the complete old target set and releases partial candidates',async()=>{
    const page=await pageFor();try{await mount(page);const result=await page.evaluate(async()=>{
      const ledger=Stage.resources(),before=ledger.snapshot(true),canvas=document.querySelector('.s3d-canvas'),size={width:canvas.width,height:canvas.height};
      const blocker=ledger.port('stage3d-target-competition').require({renderTargetDeclaredBytes:before.caps.renderTargetDeclaredBytes-before.held.renderTargetDeclaredBytes-6000000},'test competing targets',0);
      const wrap=document.getElementById('s3d-canvas-wrap');wrap.style.width='880px';wrap.style.height='580px';dispatchEvent(new Event('resize'));await harness.advance(12);
      const after=ledger.snapshot(true),stats=Stage3D.stats();blocker.release({apiReleased:true,allocationEnded:true});return{before,after,stats,size,width:canvas.width,height:canvas.height};});
      const targets=snapshot=>snapshot.entries.filter(entry=>/post target$/.test(entry.basis.source));
      assert.equal(result.stats.resources.failure,'aggregate-budget');assert.deepEqual(targets(result.after),targets(result.before));
      assert.equal(result.width,result.size.width);assert.equal(result.height,result.size.height);return result;
    }finally{await close(page);}
  });
  await check('twenty complete host lifetimes return context, input arrays, drawing surfaces and post targets to baseline',async()=>{
    const page=await pageFor();try{const result=await page.evaluate(async()=>{const ledger=Stage.resources(),baseline=ledger.snapshot(),samples=[];for(let i=0;i<20;i++){
      Stage3D.init();Stage3D.open('aurora');await harness.advance(12);const active=ledger.snapshot(true);Stage3D.destroy();samples.push({active,closed:ledger.snapshot()});
    }return{baseline,samples};});for(const sample of result.samples){assert.equal(sample.active.held.gpuContexts,1);assert.equal(sample.active.held.canvases,1);assert.equal(sample.active.held.ownedCpuBytes,2896);assert.deepEqual(sample.closed.held,result.baseline.held);}return result;
    }finally{await close(page);}
  });
  await check('real context loss retires this generation and restored events cannot allocate a replacement',async()=>{
    const page=await pageFor();try{await mount(page);await page.evaluate(()=>{harness.canvas=document.querySelector('.s3d-canvas');harness.gl.getExtension('WEBGL_lose_context').loseContext();});
      await page.waitForFunction(()=>!document.querySelector('.s3d-canvas'));
      const result=await page.evaluate(async()=>{const contexts=harness.contexts;harness.canvas.dispatchEvent(new Event('webglcontextrestored'));await harness.advance(24);return{contexts,afterContexts:harness.contexts,stats:Stage3D.stats(),ledger:Stage.resources().snapshot()};});
      assert.equal(result.afterContexts,result.contexts);assert.equal(result.stats.resources.failure,'context-lost');assert.equal(result.ledger.held.gpuContexts,0);assert.equal(result.ledger.held.renderTargetDeclaredBytes,0);return result;
    }finally{await close(page);}
  });
}finally{await browser.close();}report.passed=!report.errors.length&&report.checks.every(item=>item.passed);fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(path.join(out,'report.json'));assert.ok(report.passed,'Stage3D subset checks');}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
