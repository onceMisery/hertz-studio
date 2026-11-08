'use strict';
// Production glyph owners and actual GL allocation calls. Controlled phases
// exercise the contract; these samples do not qualify hardware or whole M1.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),web=path.join(root,'plugin/ui');
const sources=['stage-resource-budget.js','stage-resource-policy.js','stanza/stanza-util.js','stanza/stanza-theme.js',
  'lyric-glyph-sdf.js','lyric-emotion-field.js','lyric-glyph-atlas.js','lyric-glyph-gl.js','stanza/stanza-glyph.js'];
const out=path.join(root,'output/a09-m1-20261108/glyph-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(out,{recursive:true});
const report={startedAt:new Date().toISOString(),scope:'Glyph typed arrays, Canvas2D/WebGL, program/buffer/texture lifecycle and original Stage3D binding; no Pixi or physical qualification.',
  sourceSha256:Object.fromEntries([...sources,'stage.js','stage3d.js','stanza/stanza.css','stanza/stanza-bg.js','stanza/stanza-subtitle.js']
    .map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(web,file))).digest('hex')])),checks:[],errors:[]};
let browser;
async function pageFor(caps={}){
  const page=await browser.newPage({viewport:{width:900,height:600}});page.on('pageerror',error=>report.errors.push(error.stack));
  await page.setContent('<style>html,body{margin:0;background:#101015}#host{position:absolute;inset:0}</style><div id="host"></div>');
  await page.addStyleTag({path:path.join(web,'stanza/stanza.css')});
  await page.evaluate(()=>{
    const h=window.h={hidden:false,time:1000,playing:true,reduced:false,frameId:0,contexts:0,programs:0,buffers:0,textures:0,bufferData:0,bufferSubData:0,draws:0,fail:null,uniformNames:new Map(),uniforms:{}};
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>h.hidden});
    const get=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(kind,...args){const context=get.call(this,kind,...args);if(context&&/webgl/.test(kind)){
      h.contexts++;h.gl=context;
      for(const [method,count]of [['createProgram','programs'],['createBuffer','buffers'],['createTexture','textures']]){
        const create=context[method].bind(context);context[method]=(...params)=>{h[count]++;if(h.fail===method)return null;return create(...params);};
      }
      const createShader=context.createShader.bind(context);context.createShader=kind=>h.fail==='fragment-shader'&&kind===context.FRAGMENT_SHADER?null:createShader(kind);
      for(const method of ['bufferData','bufferSubData','drawArraysInstanced']){const original=context[method].bind(context);context[method]=(...params)=>{h[method==='drawArraysInstanced'?'draws':method]++;return original(...params);};}
      const locate=context.getUniformLocation.bind(context),uniform=context.uniform1f.bind(context);
      context.getUniformLocation=(program,name)=>{const location=locate(program,name);if(location)h.uniformNames.set(location,name);return location;};
      context.uniform1f=(location,value)=>{h.uniforms[h.uniformNames.get(location)]=value;return uniform(location,value);};
    }return context;};
  });
  for(const file of sources)await page.addScriptTag({path:path.join(web,file)});
  await page.evaluate(caps=>{
    h.ledger=StageResourceBudget.create({...StageResourcePolicy,caps:{...StageResourcePolicy.caps,...caps}});
    h.lines=[{start_ms:0,end_ms:8000,text:'晚风送来轻轻的问候'}];
    window.Stage={resources:()=>h.ledger,tier:()=>2,lyrics:()=>({lines:h.lines}),position:()=>h.time,
      lyricTokens:line=>[{text:line.text,start_ms:line.start_ms,end_ms:line.end_ms}],kick(){},energy:()=>0,beat:()=>0};
    h.mount=()=>{h.renderer=StanzaGlyph.init(document.getElementById('host'),()=>{}, {resources:h.ledger.port('glyph-test'),admissionRequired:true});h.renderer.setVisible(true);};
    h.frame=(dt=16)=>h.renderer.frame(dt,{version:1,frameId:++h.frameId,mediaPositionMs:h.time,playing:h.playing,reduced:h.reduced,documentHidden:h.hidden});
    h.dispose=()=>{if(h.renderer)h.renderer.destroy();h.renderer=null;};
  },caps);
  return page;
}
async function close(page){await page.evaluate(()=>h.dispose());await page.close();}
async function check(name,run){try{const evidence=await run();report.checks.push({name,passed:true,evidence});console.log('PASS '+name);}catch(error){report.checks.push({name,passed:false,error:error.stack});console.error('FAIL '+name+': '+error.message);}}
async function main(){browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});try{
  await check('inert mount, hidden and zero layout do not allocate; missing migrated port fails closed',async()=>{
    const page=await pageFor();try{const result=await page.evaluate(()=>{
      let missing=false;try{StanzaGlyph.init(document.getElementById('host'),null,{admissionRequired:true});}catch(error){missing=error.message==='resource-port-required';}
      h.mount();const mounted=h.ledger.snapshot();h.hidden=true;h.frame();const hidden=h.ledger.snapshot();h.hidden=false;
      document.getElementById('host').style.display='none';h.renderer.resize();h.frame();return{missing,mounted,hidden,zero:h.ledger.snapshot(),contexts:h.contexts};
    });assert.equal(result.missing,true);assert.equal(result.mounted.resources,0);assert.equal(result.hidden.resources,0);assert.equal(result.zero.resources,0);assert.equal(result.contexts,0);return result;}finally{await close(page);}
  });
  await check('context/program/buffer/CPU/canvas/atlas texture refusal occurs before its native allocation and preserves readable text',async()=>{
    const samples=[];for(const caps of [{gpuContexts:0},{programs:0},{bufferDeclaredBytes:0},{ownedCpuBytes:0},{canvases:0},{textureDeclaredBytes:0}]){
      const page=await pageFor(caps);try{const result=await page.evaluate(()=>{h.mount();h.frame();const first=h.ledger.snapshot(),a=document.querySelector('.fl-glyph-a11y');
        for(let i=0;i<100;i++)h.frame();return{first,stable:h.ledger.snapshot(),debug:h.renderer.getDebugSnapshot(),ready:h.renderer.isReady(),contexts:h.contexts,programs:h.programs,buffers:h.buffers,textures:h.textures,
          text:a.textContent,opacity:getComputedStyle(a).opacity,color:getComputedStyle(a).color,canvases:document.querySelectorAll('canvas').length};});
        assert.equal(result.debug.actualBackend,'dom');assert.equal(result.debug.failure,'aggregate-budget');assert.equal(result.ready,true);assert.equal(result.text,'晚风送来轻轻的问候');assert.equal(result.opacity,'1');assert.notEqual(result.color,'rgba(0, 0, 0, 0)');
        assert.equal(result.first.resources,0);assert.equal(result.stable.rejections,result.first.rejections);assert.equal(result.canvases,0);
        if(!('textureDeclaredBytes' in caps))assert.equal(result.contexts,0);else assert.equal(result.textures,0);
        samples.push({caps,...result});
      }finally{await close(page);}
    }return samples;
  });
  await check('fixed instance storage, retained SDF workspace and temporary cell uploads have distinct capacity lifetimes',async()=>{
    const page=await pageFor();try{const result=await page.evaluate(()=>{h.mount();h.frame();const first=h.ledger.snapshot(true),bufferData=h.bufferData;
      for(let i=0;i<40;i++){h.time+=20;h.frame();}const stable=h.ledger.snapshot(true),debug=h.renderer.getDebugSnapshot();h.dispose();return{first,stable,debug,bufferData,afterBufferData:h.bufferData,subData:h.bufferSubData,draws:h.draws,closed:h.ledger.snapshot()};});
      assert.equal(result.debug.actualBackend,'webgl2');assert.equal(result.first.held.gpuContexts,1);assert.equal(result.first.held.canvases,4);assert.equal(result.first.held.programs,1);
      assert.equal(result.first.held.bufferDeclaredBytes,8192);assert.equal(result.first.held.textureDeclaredBytes,2048*1024*2);assert.equal(result.bufferData,1);assert.equal(result.afterBufferData,1);assert.ok(result.subData>=41);assert.ok(result.draws>=41);
      assert.deepEqual(result.first.held,result.stable.held);assert.equal(result.first.pending.ownedCpuBytes,0);assert.ok(result.first.peak.ownedCpuBytes>=result.first.held.ownedCpuBytes+128*128*4);assert.equal(result.closed.resources,0);return result;
    }finally{await close(page);}
  });
  await check('shader/VAO buffer partial creation failure destroys its context and all owned CPU representations',async()=>{
    const samples=[];for(const failure of ['createProgram','fragment-shader','createBuffer','createTexture']){
      const page=await pageFor();try{const result=await page.evaluate(failure=>{h.fail=failure;h.mount();h.frame();return{debug:h.renderer.getDebugSnapshot(),ledger:h.ledger.snapshot(),contexts:h.contexts,canvases:document.querySelectorAll('canvas').length};},failure);
        assert.equal(result.debug.actualBackend,'dom');assert.ok(result.debug.failure);assert.equal(result.ledger.resources,0);assert.equal(result.canvases,0);samples.push({failure,...result});
      }finally{await close(page);}
    }return samples;
  });
  await check('resize competition retains previous submitted dimensions and reports refusal without every-frame reservation retries',async()=>{
    const page=await pageFor();try{const result=await page.evaluate(()=>{h.mount();h.frame();const canvas=document.querySelector('canvas'),size={width:canvas.width,height:canvas.height},before=h.ledger.snapshot();
      const blocker=h.ledger.port('competition').require({drawingBufferPixels:before.caps.drawingBufferPixels-before.held.drawingBufferPixels},'test resize competition',0);
      document.getElementById('host').style.width='450px';h.renderer.resize();h.frame();const first=h.ledger.snapshot();for(let i=0;i<50;i++)h.frame();const debug=h.renderer.getDebugSnapshot();
      blocker.release({apiReleased:true,allocationEnded:true});return{size,width:canvas.width,height:canvas.height,debug,first,stable:h.ledger.snapshot()};});
      assert.equal(result.width,result.size.width);assert.equal(result.height,result.size.height);assert.equal(result.debug.actualBackend,'webgl2');assert.equal(result.debug.failure,'aggregate-budget');assert.equal(result.first.rejections,result.stable.rejections);return result;
    }finally{await close(page);}
  });
  await check('borrowed field and glyph phase freeze through pause/reduced/hidden/zero layout; seeking only moves media uniforms',async()=>{
    const page=await pageFor();try{const result=await page.evaluate(()=>{h.mount();h.renderer.setEmotion({field:{basis:'anxious',anchor:.1}},1);h.frame();h.frame(20);const initial=h.renderer.getDebugSnapshot().sceneTimeMs;
      h.time=5000;h.frame(20);const seek={phase:h.renderer.getDebugSnapshot().sceneTimeMs,media:h.uniforms.uTimeMs,geometry:h.uniforms.uSceneTimeMs};
      h.playing=false;h.frame(100);h.frame(100);const paused=h.renderer.getDebugSnapshot().sceneTimeMs;h.playing=true;h.frame(100);const resume=h.renderer.getDebugSnapshot().sceneTimeMs;
      h.reduced=true;h.frame(100);const reduced=h.renderer.getDebugSnapshot().sceneTimeMs;h.reduced=false;h.frame(100);const reducedResume=h.renderer.getDebugSnapshot().sceneTimeMs;
      h.hidden=true;h.frame(60000);h.hidden=false;h.frame(60000);const hiddenResume=h.renderer.getDebugSnapshot().sceneTimeMs;
      const host=document.getElementById('host');host.style.display='none';h.renderer.resize();h.frame(60000);host.style.display='';h.renderer.resize();h.frame(60000);const zeroResume=h.renderer.getDebugSnapshot().sceneTimeMs;
      return{initial,seek,paused,resume,reduced,reducedResume,hiddenResume,zeroResume};});
      assert.equal(result.initial,20);assert.equal(result.seek.phase,40);assert.equal(result.seek.media,5000);assert.equal(result.seek.geometry,40);
      for(const name of ['paused','resume','reduced','reducedResume','hiddenResume','zeroResume'])assert.equal(result[name],40,name);return result;
    }finally{await close(page);}
  });
  await check('real context loss shows readable text and retires the generation; restoration cannot allocate; explicit retry creates one replacement',async()=>{
    const page=await pageFor();try{await page.evaluate(()=>{h.mount();h.frame();h.oldCanvas=document.querySelector('canvas');h.gl.getExtension('WEBGL_lose_context').loseContext();});
      await page.waitForFunction(()=>h.renderer.getDebugSnapshot().failure==='context-lost');
      const lost=await page.evaluate(()=>{const before=h.contexts;h.oldCanvas.dispatchEvent(new Event('webglcontextrestored'));for(let i=0;i<40;i++)h.frame();return{before,after:h.contexts,ledger:h.ledger.snapshot(),debug:h.renderer.getDebugSnapshot(),text:document.querySelector('.fl-glyph-a11y').textContent,opacity:getComputedStyle(document.querySelector('.fl-glyph-a11y')).opacity};});
      await page.screenshot({path:path.join(out,'context-lost-readable.png')});assert.equal(lost.before,lost.after);assert.equal(lost.ledger.resources,0);assert.equal(lost.opacity,'1');assert.ok(lost.text.length);
      await page.locator('.fl-glyph-retry').click();const retried=await page.evaluate(()=>{h.frame();return{contexts:h.contexts,debug:h.renderer.getDebugSnapshot(),ledger:h.ledger.snapshot()};});
      assert.equal(retried.contexts,lost.after+1);assert.equal(retried.debug.generation,1);assert.equal(retried.debug.actualBackend,'webgl2');return{lost,retried};
    }finally{await close(page);}
  });
  await check('twenty glyph exits and one hundred hidden canceled mounts return all declared representations to baseline',async()=>{
    const page=await pageFor();try{const result=await page.evaluate(()=>{const baseline=h.ledger.snapshot(),samples=[];for(let i=0;i<20;i++){h.mount();h.frame();const active=h.ledger.snapshot();h.dispose();samples.push({active,closed:h.ledger.snapshot()});}
      const contexts=h.contexts;for(let i=0;i<100;i++){h.mount();h.renderer.setVisible(false);h.frame();h.dispose();}return{baseline,samples,contexts,afterContexts:h.contexts,closed:h.ledger.snapshot()};});
      for(const sample of result.samples){assert.equal(sample.active.held.gpuContexts,1);assert.deepEqual(sample.closed.held,result.baseline.held);}assert.equal(result.contexts,result.afterContexts);assert.equal(result.closed.listeners,0);return result;
    }finally{await close(page);}
  });
  await check('original Stage3D registry binds a required page port and submits the borrowed production Stage frame',async()=>{
    const page=await pageFor();try{
      await page.setContent(fs.readFileSync(path.join(web,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,''));
      await page.addStyleTag({path:path.join(web,'stage3d.css')});await page.addStyleTag({path:path.join(web,'stanza/stanza.css')});
      await page.evaluate(()=>{h.now=100;h.callbacks=new Map();h.next=0;performance.now=()=>h.now;requestAnimationFrame=fn=>{h.callbacks.set(++h.next,fn);return h.next;};cancelAnimationFrame=id=>h.callbacks.delete(id);
        h.advance=async count=>{for(let i=0;i<count;i++){h.now+=1000/60;const callbacks=[...h.callbacks.values()];h.callbacks.clear();callbacks.forEach(fn=>fn(h.now));await Promise.resolve();}};});
      for(const file of ['onset.js','stage-settings.js','stage.js','stanza/stanza-bg.js','stanza/stanza-subtitle.js','stage3d.js'])await page.addScriptTag({path:path.join(web,file)});
      const result=await page.evaluate(async()=>{Stage.init();Stage.setTrack({id:'glyph-binding',title:'Glyph binding',duration_ms:120000});Stage.setLyrics({lines:h.lines});Stage.setSnapshot({playing:true,track_id:'glyph-binding',position_ms:1000,duration_ms:120000});
        Stage3D.configure({stanzaVisual:'glyph',sceneSource:'immersive',layout:'focus',lyrics:true});Stage3D.open('aurora');await h.advance(20);const active=Stage.resources().snapshot(true),state=document.querySelector('.fl-glyph').dataset.glyphState;
        Stage3D.destroy();const closed=Stage.resources().snapshot();Stage.destroy();return{active,state,closed};});
      assert.equal(result.state,'active');assert.ok(result.active.entries.some(entry=>entry.owner==='stanza-glyph'));const glyph=result.active.hosts.find(host=>host.owner==='stanza-glyph');assert.equal(glyph.actualBackend,'webgl2');assert.ok(glyph.sceneTimeMs>0);assert.equal(result.closed.resources,0);return result;
    }finally{await page.close();}
  });
}finally{await browser.close();}report.passed=report.checks.every(check=>check.passed)&&report.errors.length===0;report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,errors:report.errors,report:path.relative(root,path.join(out,'report.json'))}));if(!report.passed)process.exitCode=1;}
main().catch(error=>{report.errors.push(error.stack);fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.error(error);process.exitCode=1;});
