'use strict';
// Original Pixi/Application late init and failure owners. Full allocation
// admission and physical context/memory qualification remain explicitly open.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),web=path.join(root,'plugin/ui');
const sources=['vendor/pixi.min.js','stanza/stanza-util.js','stanza/stanza-theme.js','stanza/stanza-sonnet-fx.js','stanza/stanza-sonnet.js','stanza/stanza-tempera.js'];
const out=path.join(root,'output/a09-m1-20261108/pixi-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(out,{recursive:true});
const report={startedAt:new Date().toISOString(),scope:'Actual Pixi initialization/partial failure/cancellation and readable lyric failure only. Original probes and implicit allocation owners are not migrated or physically qualified.',
 sourceSha256:Object.fromEntries([...sources,'stanza/stanza.css'].map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(web,file))).digest('hex')])),checks:[],errors:[]};
let browser;
async function boot(mode,kind='application'){
 const page=await browser.newPage({viewport:{width:900,height:600}});page.on('pageerror',error=>report.errors.push(error.stack));
 await page.setContent('<style>html,body{margin:0;background:#101015}#host,.fl-sonnet,.fl-tempera{position:absolute;inset:0}</style><div id="host"></div>');
 await page.addStyleTag({path:path.join(web,'stanza/stanza.css')});
 await page.evaluate(()=>{
  const h=window.h={time:1000,contexts:[],events:[],apps:[],created:0,mode:null,failDestroy:false,failRendererDestroy:false,pendingResolve:null,readyResolve:null};
  const get=HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext=function(kind,...args){const value=get.call(this,kind,...args);if(value&&/webgl/.test(kind)&&!h.contexts.includes(value)){h.contexts.push(value);h.events.push({kind,width:this.width,height:this.height,stack:new Error().stack});}return value;};
 });
 for(const file of sources)await page.addScriptTag({path:path.join(web,file)});
 await page.evaluate(({mode,kind})=>{
  h.rendererKind=mode;h.kind=kind;h.lines=[{start_ms:0,end_ms:8000,text:'晚风送来轻轻的问候'}];
  window.Stage={presentation:()=>({playing:false,reduced:false,track:{id:'pixi-m1',title:'Pixi lifecycle'}}),position:()=>h.time,
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
async function main(){browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});try{
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
   const result=await page.evaluate(()=>{const before={text:document.querySelector('.fl-pixi-fallback').textContent,lost:h.gl.isContextLost(),debug:h.renderer.getDebugSnapshot()};h.lines=[{start_ms:0,end_ms:8000,text:'换句后仍可读'}];h.renderer.frame();return{before,after:document.querySelector('.fl-pixi-fallback').textContent,created:h.created,canvasCount:document.querySelectorAll('canvas').length};});
   assert.equal(result.before.lost,true);assert.equal(result.before.debug.initialized,false);assert.equal(result.before.text,'晚风送来轻轻的问候');assert.equal(result.after,'换句后仍可读');assert.equal(result.created,1);assert.equal(result.canvasCount,0);
   await page.screenshot({path:path.join(out,mode+'-failure-readable.png')});samples.push({mode,...result});
  }finally{await close(page);}}return samples;
 });
 await check('twenty real delayed Application lifetimes keep context ownership until settlement and reject late canvas/readiness publication',async()=>{
  const samples=[];for(const mode of ['sonnet','tempera']){const page=await boot(mode);try{
   const result=await page.evaluate(async()=>{const rows=[];for(let i=0;i<20;i++){
    h.mount('pending');const api=h.renderer;await h.ready;const context=h.gl,initial=api.getDebugSnapshot();api.destroy();
    const pending={lost:context.isContextLost(),ready:api.isReady()};h.pendingResolve();h.pendingResolve=null;await h.settle();
    rows.push({initial,pending,settled:{lost:context.isContextLost(),ready:api.isReady(),initializing:api.getDebugSnapshot().initializing,canvases:document.querySelectorAll('canvas').length}});
   }return{rows,created:h.created,events:h.events};});
   assert.equal(result.created,20);for(const row of result.rows){assert.equal(row.initial.initializing,true);assert.equal(row.initial.initialized,false);assert.equal(row.pending.lost,false);assert.equal(row.pending.ready,false);assert.equal(row.settled.lost,true);assert.equal(row.settled.ready,false);assert.equal(row.settled.initializing,false);assert.equal(row.settled.canvases,0);}samples.push({mode,...result});
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
