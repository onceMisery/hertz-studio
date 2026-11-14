// SPDX-License-Identifier: MIT
// Uses a fixture emitted by actual production Rust selection/qualification and
// native GlAdmission. Browser routing proves page integration, not OS eligibility.
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),output=path.join(root,'output/a04-p2-20261108/native-composition');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const projection=JSON.parse(fs.readFileSync(path.join(output,'projection.json'),'utf8'));
const uri=fs.readFileSync(path.join(output,'uri.txt'),'utf8');
let init=fs.readFileSync(path.join(output,'native-init.js'),'utf8');
const movie=fs.readFileSync(path.join(output,'movie.webm'));
function routeMovie(route){
  const range=/^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range||'');
  if(range){
    const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),movie.length-1):movie.length-1;
    assert(start<=end&&start<movie.length,'valid native-contract media range');
    return route.fulfill({status:206,contentType:'video/webm',headers:{'accept-ranges':'bytes',
      'content-range':`bytes ${start}-${end}/${movie.length}`,'content-length':String(end-start+1)},body:movie.subarray(start,end+1)});
  }
  return route.fulfill({status:200,contentType:'video/webm',headers:{'accept-ranges':'bytes','content-length':String(movie.length)},body:movie});
}
let html=read('crates/hertz-desktop/assets/wallpaper-scene.html')
  .replace('__GL_BUDGET__',()=>read('plugin/ui/stage-resource-budget.js')+'\n'+read('crates/hertz-desktop/assets/wallpaper-gl-budget.js'))
  .replace('__RUNTIME__',()=>read('plugin/ui/vendor/stage-runtime.js'))
  .replace('__SHIM__',()=>read('plugin/ui/vendor/zodiac-stage.js'))
  .replace('__SCENE__',()=>read('crates/hertz-desktop/assets/wallpaper-scene.js'));
const diagnostic=process.env.COMPOSITION_BOOTSTRAP_DIAGNOSTIC==='1';
if(diagnostic){
  init=init.replace(/"gpuBytes":(\d+)/,(_,bytes)=>'"gpuBytes":'+(Number(bytes)+4096));
  html=html.replace('state.beforeDraw=function(){',()=>"globalThis.nativeGlDetails=()=>Array.from(state.objects.values()).map(e=>({bytes:e.bytes,levels:Array.from(e.levels.values()),deleted:!!e.deleted}));state.beforeDraw=function(){");
}
(async()=>{
 const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 try{
  // The headless browser uses this machine's actual rAF cadence. Bind the copied
  // fixture's scheduler metadata to it; target, files and native resource caps
  // stay as admitted. A 60Hz default on a 165Hz browser incorrectly runs at 41fps.
  const cadencePage=await browser.newPage();
  const cadence=await cadencePage.evaluate(()=>new Promise(resolve=>{
    const intervals=[];let previous=null;
    function sample(now){if(previous!==null)intervals.push(now-previous);previous=now;
      if(intervals.length===24)resolve(intervals);else requestAnimationFrame(sample);}
    requestAnimationFrame(sample);
  }));
  await cadencePage.close();
  const median=cadence.slice().sort((a,b)=>a-b)[Math.floor(cadence.length/2)];
  const refreshHz=1000/median;
  const bindCadence=source=>source.replace(/"refreshHz":\d+(?:\.\d+)?/,()=>`"refreshHz":${refreshHz}`)
    .replace(/"frameDivisor":\d+/,()=>`"frameDivisor":${Math.ceil(refreshHz/15)}`);
  init=bindCadence(init);
  const page=await browser.newPage({viewport:{width:64,height:64}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error'){errors.push(message.text());console.error('browser:',message.text());}});
  await page.addInitScript(init+'\nwindow.nativeEvents=[];window.ipc={postMessage:message=>nativeEvents.push(message)};');
  await page.route('https://**.wallpaper.invalid/**',route=>{
    if(route.request().url()===uri)return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(projection)});
    if(route.request().url()===projection.resolvedAssets[0].url)return routeMovie(route);
    return route.fulfill({status:404,body:''});
  });
  await page.route('http://hertz.localhost/',route=>route.fulfill({status:200,contentType:'text/html',body:html}));
  await page.goto('http://hertz.localhost/');
  console.log('native composition page loaded');
  const accepted=await page.evaluate(async uri=>{hertzWallpaper.applyConfig({source:'fixed',audioInput:{kind:'none'},motion:1,quality:'low'});
    const pending=hertzWallpaper.applyComposition(uri);hertzWallpaper.start(15);
    return Promise.race([pending,new Promise(resolve=>setTimeout(()=>resolve('preparation-timeout'),10000))]);},uri);
  assert.equal(accepted,true,JSON.stringify({errors,events:await page.evaluate(()=>nativeEvents)}));
  console.log('native composition preparation completed');
  await page.waitForFunction(()=>nativeEvents.some(event=>event.includes('firstFrame')),null,{timeout:10000}).catch(async failure=>{
    throw new Error(failure.message+'\n'+JSON.stringify(await page.evaluate(()=>({events:nativeEvents,stats:hertzWallpaper.debug(),budget:HertzGlBudget.stats()}))));
  });
  await page.waitForFunction(()=>hertzWallpaper.debug().draws>=3,null,{timeout:10000});
  await page.waitForFunction(()=>hertzWallpaper.debug().sceneTime>=2200&&hertzWallpaper.debug().stats.sceneStats.ready,null,{timeout:10000});
  const runningCadence=await page.evaluate(()=>hertzWallpaper.debug());
  assert(runningCadence.draws>=25,'real 15fps page submits across multiple video loop boundaries');
  assert.equal(runningCadence.gate.divisor,Math.ceil(refreshHz/15));
  assert(runningCadence.stats.actualFps<=17,'test must exercise the native 15fps cadence');
  await page.evaluate(()=>{
    const gl=document.querySelector('#host canvas').getContext('webgl2');
    window.nativeFencePoll=gl.clientWaitSync.bind(gl);
    gl.clientWaitSync=()=>gl.TIMEOUT_EXPIRED;
  });
  await page.waitForFunction(()=>HertzGlBudget.stats().blockedFrames>0,null,{timeout:10000});
  const blockedBefore=await page.evaluate(()=>({budget:HertzGlBudget.stats(),draws:hertzWallpaper.debug().draws}));
  await page.waitForTimeout(250);
  const blockedAfter=await page.evaluate(()=>({budget:HertzGlBudget.stats(),draws:hertzWallpaper.debug().draws}));
  assert.equal(blockedAfter.budget.uploadBytes,blockedBefore.budget.uploadBytes,'GPU delay must not allocate another video storage');
  assert.equal(blockedAfter.draws,blockedBefore.draws,'GPU delay retains the last complete output');
  await page.evaluate(()=>{document.querySelector('#host canvas').getContext('webgl2').clientWaitSync=nativeFencePoll;});
  await page.waitForFunction(previous=>hertzWallpaper.debug().draws>previous,blockedAfter.draws,{timeout:10000});
  const state=await page.evaluate(()=>{
    const canvas=document.querySelector('#host canvas'),gl=canvas.getContext('webgl2'),pixel=new Uint8Array(4);
    gl.readPixels(32,32,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
    return {pixel:[...pixel],stats:hertzWallpaper.debug(),budget:HertzGlBudget.stats(),events:nativeEvents};
  });
  if(diagnostic){const details=await page.evaluate(()=>nativeGlDetails());
    fs.writeFileSync(path.join(output,'bootstrap-diagnostic.json'),JSON.stringify({qualification:'diagnostic only; increased test cap is not native admission',state,details},null,2));
    console.log('DIAGNOSTIC bootstrap details saved; this is not native qualification');return;}
  assert.equal(state.budget.contexts,1);assert.equal(state.budget.error,null);assert.equal(errors.length,0,errors.join('\n'));
  assert(state.stats.draws>0);assert(state.events.some(event=>event.includes('firstFrame')));
  assert.equal(state.stats.stats.firstSubmit,true);assert.equal(state.stats.stats.sceneStats.ready,true);
  await page.evaluate(()=>hertzWallpaper.reveal());
  await page.screenshot({path:path.join(output,'native-page-first-frame.png')});
  // Headless Chrome keeps all tabs visible. Inject only the host's visibility
  // state/event; the real shipped page, clock, video, scheduler and GL execute.
  const visibilityStart=await page.evaluate(()=>{
    window.controlledHidden=true;
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>controlledHidden});
    Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>controlledHidden?'hidden':'visible'});
    document.dispatchEvent(new Event('visibilitychange'));
    return hertzWallpaper.debug();
  });
  await page.waitForFunction(()=>{
    const videos=hertzWallpaper.debug().stats.sceneStats.videoClocks;
    return videos.length===1&&videos.every(video=>video.paused&&!video.seeking&&video.seekReady);
  });
  const hiddenBefore=await page.evaluate(()=>{
    const stats=hertzWallpaper.debug();
    return {stats,budget:HertzGlBudget.stats(),videos:stats.stats.sceneStats.videoClocks};
  });
  await page.waitForTimeout(350);
  const hiddenAfter=await page.evaluate(()=>{
    const stats=hertzWallpaper.debug();
    return {stats,budget:HertzGlBudget.stats(),videos:stats.stats.sceneStats.videoClocks};
  });
  assert.equal(hiddenBefore.videos.length,1,'detached composition media must be observed through the actual runtime');
  assert(hiddenBefore.videos.every(video=>video.paused&&!video.seeking&&video.seekReady));
  assert.equal(hiddenAfter.stats.sceneTime,visibilityStart.sceneTime,'hidden page freezes the original scene clock');
  assert.equal(hiddenAfter.stats.draws,hiddenBefore.stats.draws);
  assert.equal(hiddenAfter.budget.uploadBytes,hiddenBefore.budget.uploadBytes);
  assert.deepEqual(hiddenAfter.videos,hiddenBefore.videos,'hidden composition videos remain paused');
  await page.evaluate(()=>{window.nativeVisibilityResumeAt=performance.now();controlledHidden=false;document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(previous=>hertzWallpaper.debug().draws>previous,hiddenAfter.stats.draws);
  const visibilityResumed=await page.evaluate(()=>({stats:hertzWallpaper.debug(),activeMs:performance.now()-nativeVisibilityResumeAt,budget:HertzGlBudget.stats()}));
  assert(visibilityResumed.stats.sceneTime-hiddenAfter.stats.sceneTime<=visibilityResumed.activeMs+2,'resume cannot catch up hidden wall time');
  assert.equal(visibilityResumed.budget.contexts,1);assert.equal(visibilityResumed.budget.error,null);
  await page.evaluate(()=>hertzWallpaper.stop());
  const paused=await page.evaluate(()=>hertzWallpaper.debug());
  await page.waitForTimeout(100);
  assert.equal((await page.evaluate(()=>hertzWallpaper.debug())).draws,paused.draws);
  await page.evaluate(()=>hertzWallpaper.unmount());await page.waitForTimeout(50);
  const retired=await page.evaluate(()=>HertzGlBudget.stats());assert.equal(retired.contexts,0);assert.equal(retired.error,null);assert.deepEqual(errors,[]);
  const fits={};
  for(const name of ['contain','cover','stretch']){
    const directory=path.join(output,name),fitProjection=JSON.parse(fs.readFileSync(path.join(directory,'projection.json'),'utf8'));
    const fitUri=fs.readFileSync(path.join(directory,'uri.txt'),'utf8'),fitInit=bindCadence(fs.readFileSync(path.join(directory,'native-init.js'),'utf8'));
    const fitPage=await browser.newPage({viewport:{width:64,height:128}}),fitErrors=[];
    fitPage.on('pageerror',error=>fitErrors.push(error.message));
    fitPage.on('console',message=>{if(message.type()==='error')fitErrors.push(message.text());});
    await fitPage.addInitScript(fitInit+'\nwindow.nativeEvents=[];window.ipc={postMessage:message=>nativeEvents.push(message)};');
    await fitPage.route('https://**.wallpaper.invalid/**',route=>{
      if(route.request().url()===fitUri)return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(fitProjection)});
      if(route.request().url()===fitProjection.resolvedAssets[0].url)return routeMovie(route);
      return route.fulfill({status:404,body:''});
    });
    await fitPage.route('http://hertz.localhost/',route=>route.fulfill({status:200,contentType:'text/html',body:html}));
    await fitPage.goto('http://hertz.localhost/');
    assert.equal(await fitPage.evaluate(async url=>{hertzWallpaper.applyConfig({source:'fixed',audioInput:{kind:'none'},motion:1,quality:'low'});
      const prepared=hertzWallpaper.applyComposition(url);hertzWallpaper.start(15);return await prepared;},fitUri),true);
    await fitPage.waitForFunction(()=>hertzWallpaper.debug().draws>=2);
    fits[name]=await fitPage.evaluate(()=>{
      const gl=document.querySelector('#host canvas').getContext('webgl2');
      const sample=(x,y)=>{const pixel=new Uint8Array(4);gl.readPixels(x,127-y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);return [...pixel];};
      return {side:sample(8,64),upper:sample(32,40),center:sample(32,64),stats:hertzWallpaper.debug(),budget:HertzGlBudget.stats()};
    });
    assert.equal(fits[name].stats.stats.physicalPixels,64*128);
    assert.equal(fits[name].budget.contexts,1);assert.equal(fits[name].budget.error,null);assert.deepEqual(fitErrors,[]);
    await fitPage.evaluate(()=>hertzWallpaper.reveal());
    await fitPage.screenshot({path:path.join(directory,'native-page-fit.png')});
    await fitPage.evaluate(()=>hertzWallpaper.unmount());await fitPage.waitForTimeout(50);
    assert.equal((await fitPage.evaluate(()=>HertzGlBudget.stats())).contexts,0);
    await fitPage.close();
  }
  const colored=pixel=>Math.max(...pixel.slice(0,3))>10;
  assert.equal(colored(fits.contain.side),false);assert.equal(colored(fits.stretch.side),false);assert.equal(colored(fits.cover.side),true);
  assert.equal(colored(fits.contain.upper),false);assert.equal(colored(fits.stretch.upper),true);assert.equal(colored(fits.cover.upper),true);
  for(const fit of Object.values(fits))assert.equal(colored(fit.center),true);
  const glowDir=path.join(output,'glow');
  let glow=null;
  if(fs.existsSync(path.join(glowDir,'projection.json'))){
    const glowProjection=JSON.parse(fs.readFileSync(path.join(glowDir,'projection.json'),'utf8'));
    const glowUri=fs.readFileSync(path.join(glowDir,'uri.txt'),'utf8');
    const glowInit=bindCadence(fs.readFileSync(path.join(glowDir,'native-init.js'),'utf8'));
    const glowPage=await browser.newPage({viewport:{width:64,height:64}}),glowErrors=[];
    glowPage.on('pageerror',error=>glowErrors.push(error.message));
    glowPage.on('console',message=>{if(message.type()==='error')glowErrors.push(message.text());});
    await glowPage.addInitScript(glowInit+'\nwindow.nativeEvents=[];window.ipc={postMessage:message=>nativeEvents.push(message)};');
    await glowPage.route('https://**.wallpaper.invalid/**',route=>{
      if(route.request().url()===glowUri)return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(glowProjection)});
      if(route.request().url()===glowProjection.resolvedAssets[0].url)return routeMovie(route);
      return route.fulfill({status:404,body:''});
    });
    await glowPage.route('http://hertz.localhost/',route=>route.fulfill({status:200,contentType:'text/html',body:html}));
    await glowPage.goto('http://hertz.localhost/');
    assert.equal(await glowPage.evaluate(async url=>{hertzWallpaper.applyConfig({source:'fixed',audioInput:{kind:'none'},motion:1,quality:'low'});
      const prepared=hertzWallpaper.applyComposition(url);hertzWallpaper.start(15);return await prepared;},glowUri),true);
    await glowPage.waitForFunction(()=>nativeEvents.some(event=>event.includes('firstFrame')),null,{timeout:10000});
    await glowPage.waitForFunction(()=>hertzWallpaper.debug().draws>=3,null,{timeout:10000});
    glow=await glowPage.evaluate(()=>({stats:hertzWallpaper.debug(),budget:HertzGlBudget.stats(),events:nativeEvents}));
    assert.equal(glowProjection.ir.effects[0].type,'glow');
    assert.deepEqual(glowProjection.ir.effectSurfaces,[2]);
    assert.equal(glowProjection.pageLimits.renderTargetDeclaredBytes,64*64*16+2*32*32*4);
    assert.equal(glowProjection.pageLimits.programs,4);
    assert.equal(glow.budget.contexts,1);assert.equal(glow.budget.error,null);assert.deepEqual(glowErrors,[]);
    assert.equal(glow.budget.bytes-state.budget.bytes,2*32*32*4,'native glow adds two half-resolution RGBA8 surfaces');
    await glowPage.evaluate(()=>hertzWallpaper.reveal());
    await glowPage.screenshot({path:path.join(glowDir,'native-page-glow.png')});
    await glowPage.evaluate(()=>hertzWallpaper.unmount());await glowPage.waitForTimeout(50);
    assert.equal((await glowPage.evaluate(()=>HertzGlBudget.stats())).contexts,0);
    await glowPage.close();
  }
  const tracksDir=path.join(output,'tracks');
  let tracks=null;
  if(fs.existsSync(path.join(tracksDir,'projection.json'))){
    const tracksProjection=JSON.parse(fs.readFileSync(path.join(tracksDir,'projection.json'),'utf8'));
    const tracksUri=fs.readFileSync(path.join(tracksDir,'uri.txt'),'utf8');
    const tracksInit=bindCadence(fs.readFileSync(path.join(tracksDir,'native-init.js'),'utf8'));
    const tracksPage=await browser.newPage({viewport:{width:64,height:64}}),tracksErrors=[];
    tracksPage.on('pageerror',error=>tracksErrors.push(error.message));
    tracksPage.on('console',message=>{if(message.type()==='error')tracksErrors.push(message.text());});
    await tracksPage.addInitScript(tracksInit+'\nwindow.nativeEvents=[];window.ipc={postMessage:message=>nativeEvents.push(message)};');
    await tracksPage.route('https://**.wallpaper.invalid/**',route=>{
      if(route.request().url()===tracksUri)return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(tracksProjection)});
      if(route.request().url()===tracksProjection.resolvedAssets[0].url)return routeMovie(route);
      return route.fulfill({status:404,body:''});
    });
    await tracksPage.route('http://hertz.localhost/',route=>route.fulfill({status:200,contentType:'text/html',body:html}));
    await tracksPage.goto('http://hertz.localhost/');
    assert.equal(await tracksPage.evaluate(async url=>{hertzWallpaper.applyConfig({source:'fixed',audioInput:{kind:'none'},motion:1,quality:'low'});
      const prepared=hertzWallpaper.applyComposition(url);hertzWallpaper.start(15);return await prepared;},tracksUri),true);
    await tracksPage.waitForFunction(()=>nativeEvents.some(event=>event.includes('firstFrame')),null,{timeout:10000});
    await tracksPage.waitForFunction(()=>hertzWallpaper.debug().draws>=2,null,{timeout:10000});
    const sample=()=>tracksPage.evaluate(()=>{
      const gl=document.querySelector('#host canvas').getContext('webgl2'),pixel=new Uint8Array(4);
      gl.readPixels(32,32,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
      return {pixel:[...pixel],stats:hertzWallpaper.debug(),budget:HertzGlBudget.stats()};
    });
    const early=await sample();
    assert(early.stats.sceneTime<2500,'gated binding needs an early frame');
    assert(Math.max(...early.pixel.slice(0,3))<=8,'binding keeps the early composition output black');
    await tracksPage.waitForFunction(()=>hertzWallpaper.debug().sceneTime>=3200,null,{timeout:10000});
    const late=await sample();
    assert(Math.max(...late.pixel.slice(0,3))>10,'binding reaches full opacity after the gate');
    assert.equal(late.budget.contexts,1);assert.equal(late.budget.error,null);assert.deepEqual(tracksErrors,[]);
    tracks={early,late,ir:{tracks:tracksProjection.ir.tracks.length,bindings:tracksProjection.ir.bindings.length}};
    await tracksPage.evaluate(()=>hertzWallpaper.reveal());
    await tracksPage.screenshot({path:path.join(tracksDir,'native-page-tracks.png')});
    await tracksPage.evaluate(()=>hertzWallpaper.unmount());await tracksPage.waitForTimeout(50);
    assert.equal((await tracksPage.evaluate(()=>HertzGlBudget.stats())).contexts,0);
    await tracksPage.close();
  }
  const maskDir=path.join(output,'mask');
  let mask=null;
  if(fs.existsSync(path.join(maskDir,'projection.json'))){
    const maskProjection=JSON.parse(fs.readFileSync(path.join(maskDir,'projection.json'),'utf8'));
    const maskUri=fs.readFileSync(path.join(maskDir,'uri.txt'),'utf8');
    const maskInit=bindCadence(fs.readFileSync(path.join(maskDir,'native-init.js'),'utf8'));
    const maskFiles=JSON.parse(fs.readFileSync(path.join(maskDir,'files.json'),'utf8'));
    const maskPage=await browser.newPage({viewport:{width:64,height:64}}),maskErrors=[];
    maskPage.on('pageerror',error=>maskErrors.push(error.message));
    maskPage.on('console',message=>{if(message.type()==='error')maskErrors.push(message.text());});
    await maskPage.addInitScript(maskInit+'\nwindow.nativeEvents=[];window.ipc={postMessage:message=>nativeEvents.push(message)};');
    await maskPage.route('https://**.wallpaper.invalid/**',route=>{
      if(route.request().url()===maskUri)return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(maskProjection)});
      const asset=maskFiles.find(entry=>entry.url===route.request().url());
      if(asset)return route.fulfill({status:200,contentType:'image/png',body:fs.readFileSync(path.join(maskDir,asset.file))});
      return route.fulfill({status:404,body:''});
    });
    await maskPage.route('http://hertz.localhost/',route=>route.fulfill({status:200,contentType:'text/html',body:html}));
    await maskPage.goto('http://hertz.localhost/');
    assert.equal(await maskPage.evaluate(async url=>{hertzWallpaper.applyConfig({source:'fixed',audioInput:{kind:'none'},motion:1,quality:'low'});
      const prepared=hertzWallpaper.applyComposition(url);hertzWallpaper.start(15);return await prepared;},maskUri),true);
    await maskPage.waitForFunction(()=>nativeEvents.some(event=>event.includes('firstFrame')),null,{timeout:10000});
    await maskPage.waitForFunction(()=>hertzWallpaper.debug().draws>=2,null,{timeout:10000});
    const masked=await maskPage.evaluate(()=>{
      const gl=document.querySelector('#host canvas').getContext('webgl2');
      const sample=(x,y)=>{const pixel=new Uint8Array(4);gl.readPixels(x,63-y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);return [...pixel];};
      return {left:sample(16,32),right:sample(48,32),stats:hertzWallpaper.debug(),budget:HertzGlBudget.stats()};
    });
    assert(masked.left[0]>200&&masked.left[1]<20&&masked.left[2]<20,'mask keeps the left red half');
    assert(Math.max(...masked.right.slice(0,3))<=8,'mask hides the right half');
    assert.equal(masked.budget.contexts,1);assert.equal(masked.budget.error,null);assert.deepEqual(maskErrors,[]);
    mask={pixels:{left:masked.left,right:masked.right},budget:masked.budget,ir:{effects:maskProjection.ir.effects.length,textures:maskFiles.length}};
    await maskPage.evaluate(()=>hertzWallpaper.reveal());
    await maskPage.screenshot({path:path.join(maskDir,'native-page-mask.png')});
    await maskPage.evaluate(()=>hertzWallpaper.unmount());await maskPage.waitForTimeout(50);
    assert.equal((await maskPage.evaluate(()=>HertzGlBudget.stats())).contexts,0);
    await maskPage.close();
  }
  const modelDir=path.join(output,'model');
  let model=null;
  if(fs.existsSync(path.join(modelDir,'projection.json'))){
    const modelProjection=JSON.parse(fs.readFileSync(path.join(modelDir,'projection.json'),'utf8'));
    const modelUri=fs.readFileSync(path.join(modelDir,'uri.txt'),'utf8');
    const modelInit=bindCadence(fs.readFileSync(path.join(modelDir,'native-init.js'),'utf8'));
    const modelFiles=JSON.parse(fs.readFileSync(path.join(modelDir,'files.json'),'utf8'));
    const modelPage=await browser.newPage({viewport:{width:64,height:64}}),modelErrors=[];
    modelPage.on('pageerror',error=>modelErrors.push(error.message));
    modelPage.on('console',message=>{if(message.type()==='error')modelErrors.push(message.text());});
    await modelPage.addInitScript(modelInit+'\nwindow.nativeEvents=[];window.ipc={postMessage:message=>nativeEvents.push(message)};');
    await modelPage.route('https://**.wallpaper.invalid/**',route=>{
      if(route.request().url()===modelUri)return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(modelProjection)});
      const asset=modelFiles.find(entry=>entry.url===route.request().url());
      if(asset)return route.fulfill({status:200,contentType:'model/gltf-binary',body:fs.readFileSync(path.join(modelDir,asset.file))});
      return route.fulfill({status:404,body:''});
    });
    await modelPage.route('http://hertz.localhost/',route=>route.fulfill({status:200,contentType:'text/html',body:html}));
    await modelPage.goto('http://hertz.localhost/');
    assert.equal(await modelPage.evaluate(async url=>{hertzWallpaper.applyConfig({source:'fixed',audioInput:{kind:'none'},motion:1,quality:'low'});
      const prepared=hertzWallpaper.applyComposition(url);hertzWallpaper.start(15);return await prepared;},modelUri),true);
    await modelPage.waitForFunction(()=>nativeEvents.some(event=>event.includes('firstFrame')),null,{timeout:10000}).catch(async failure=>{
      throw new Error(failure.message+'\n'+JSON.stringify(await modelPage.evaluate(()=>({events:nativeEvents,stats:hertzWallpaper.debug(),budget:HertzGlBudget.stats()}))));
    });
    await modelPage.waitForFunction(()=>hertzWallpaper.debug().draws>=2,null,{timeout:10000});
    const modeled=await modelPage.evaluate(()=>{
      const gl=document.querySelector('#host canvas').getContext('webgl2');
      const sample=(x,y)=>{const pixel=new Uint8Array(4);gl.readPixels(x,y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);return [...pixel];};
      return {inside:sample(40,40),outside:sample(8,8),stats:hertzWallpaper.debug(),budget:HertzGlBudget.stats()};
    });
    assert(Math.min(...modeled.inside.slice(0,3))>200,'static GLB triangle renders through the scene3d camera');
    assert(Math.max(...modeled.outside.slice(0,3))<=8,'background stays black outside the model');
    assert.equal(modeled.budget.contexts,1);assert.equal(modeled.budget.error,null);assert.deepEqual(modelErrors,[]);
    assert.equal(modelProjection.resolvedAssets[0].kind,'model');
    assert.equal(modelProjection.resolvedAssets[0].modelFacts.profile,'static-core-pbr-v1');
    assert.equal(modelProjection.pageLimits.programs,3);
    assert.equal(modelProjection.pageLimits.bufferDeclaredBytes,170);
    model={pixels:{inside:modeled.inside,outside:modeled.outside},budget:modeled.budget,
      facts:{profile:modelProjection.resolvedAssets[0].modelFacts.profile,
        drawCalls:modelProjection.resolvedAssets[0].modelFacts.scene.drawCalls}};
    await modelPage.evaluate(()=>hertzWallpaper.reveal());
    await modelPage.screenshot({path:path.join(modelDir,'native-page-model.png')});
    await modelPage.evaluate(()=>hertzWallpaper.unmount());await modelPage.waitForTimeout(50);
    assert.equal((await modelPage.evaluate(()=>HertzGlBudget.stats())).contexts,0);
    await modelPage.close();
  }
  const texturedModelDir=path.join(output,'model-textured');
  let texturedModel=null;
  if(fs.existsSync(path.join(texturedModelDir,'projection.json'))){
    const texturedProjection=JSON.parse(fs.readFileSync(path.join(texturedModelDir,'projection.json'),'utf8'));
    const texturedUri=fs.readFileSync(path.join(texturedModelDir,'uri.txt'),'utf8');
    const texturedInit=bindCadence(fs.readFileSync(path.join(texturedModelDir,'native-init.js'),'utf8'));
    const texturedFiles=JSON.parse(fs.readFileSync(path.join(texturedModelDir,'files.json'),'utf8'));
    const texturedPage=await browser.newPage({viewport:{width:64,height:64}}),texturedErrors=[];
    texturedPage.on('pageerror',error=>texturedErrors.push(error.message));
    texturedPage.on('console',message=>{if(message.type()==='error')texturedErrors.push(message.text());});
    await texturedPage.addInitScript(texturedInit+'\nwindow.nativeEvents=[];window.ipc={postMessage:message=>nativeEvents.push(message)};');
    await texturedPage.route('https://**.wallpaper.invalid/**',route=>{
      if(route.request().url()===texturedUri)return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(texturedProjection)});
      const asset=texturedFiles.find(entry=>entry.url===route.request().url());
      if(asset)return route.fulfill({status:200,contentType:'model/gltf-binary',body:fs.readFileSync(path.join(texturedModelDir,asset.file))});
      return route.fulfill({status:404,body:''});
    });
    await texturedPage.route('http://hertz.localhost/',route=>route.fulfill({status:200,contentType:'text/html',body:html}));
    await texturedPage.goto('http://hertz.localhost/');
    assert.equal(await texturedPage.evaluate(async url=>{hertzWallpaper.applyConfig({source:'fixed',audioInput:{kind:'none'},motion:1,quality:'low'});
      const prepared=hertzWallpaper.applyComposition(url);hertzWallpaper.start(15);return await prepared;},texturedUri),true);
    await texturedPage.waitForFunction(()=>nativeEvents.some(event=>event.includes('firstFrame')),null,{timeout:10000}).catch(async failure=>{
      throw new Error(failure.message+'\n'+JSON.stringify(await texturedPage.evaluate(()=>({events:nativeEvents,stats:hertzWallpaper.debug(),budget:HertzGlBudget.stats()}))));
    });
    await texturedPage.waitForFunction(()=>hertzWallpaper.debug().draws>=2,null,{timeout:10000});
    const textured=await texturedPage.evaluate(()=>{
      const gl=document.querySelector('#host canvas').getContext('webgl2');
      const sample=(x,y)=>{const pixel=new Uint8Array(4);gl.readPixels(x,y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);return [...pixel];};
      return {red:sample(36,40),green:sample(46,40),budget:HertzGlBudget.stats()};
    });
    assert(textured.red[0]>200&&textured.red[1]<20&&textured.red[2]<20,'embedded texture keeps the left red half');
    assert(textured.green[1]>200&&textured.green[0]<20&&textured.green[2]<20,'embedded texture keeps the right green half');
    assert.equal(textured.budget.contexts,1);assert.equal(textured.budget.error,null);assert.deepEqual(texturedErrors,[]);
    assert.equal(texturedProjection.resolvedAssets[0].modelFacts.profile,'static-pbr-texture-v1');
    assert.equal(texturedProjection.pageLimits.textureDeclaredBytes,32+4096);
    assert.equal(texturedProjection.pageLimits.bufferDeclaredBytes,194);
    texturedModel={pixels:{red:textured.red,green:textured.green},budget:textured.budget,
      facts:{profile:texturedProjection.resolvedAssets[0].modelFacts.profile,
        textureUploadBytes:texturedProjection.resolvedAssets[0].textureUploadBytes}};
    await texturedPage.evaluate(()=>hertzWallpaper.reveal());
    await texturedPage.screenshot({path:path.join(texturedModelDir,'native-page-model-textured.png')});
    await texturedPage.evaluate(()=>hertzWallpaper.unmount());await texturedPage.waitForTimeout(50);
    assert.equal((await texturedPage.evaluate(()=>HertzGlBudget.stats())).contexts,0);
    await texturedPage.close();
  }
  fs.writeFileSync(path.join(output,'native-page-evidence.json'),JSON.stringify({source:'actual Rust production selector + GlAdmission + original native page',qualification:'browser integration; copied scheduler metadata matches measured headless rAF; native resource caps unchanged; controlled visibility event/state; Windows/GPU qualification pending',cadence:{intervals:cadence,refreshHz,running:runningCadence},state,blockedBefore,blockedAfter,hiddenBefore,hiddenAfter,visibilityResumed,fits,glow,tracks,mask,model,texturedModel,paused,retired,errors},null,2));
  console.log('PASS native composition page: real Rust projection, one context, complete frame, pause and retirement'+(glow?', glow surfaces admitted':'')+(tracks?', tracks/bindings applied':'')+(mask?', mask texture applied':'')+(model?', scene3d model rendered':'')+(texturedModel?', textured model pixels':''));
 }finally{await browser.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
