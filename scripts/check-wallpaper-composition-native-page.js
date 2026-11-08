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
  const page=await browser.newPage({viewport:{width:64,height:64}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error'){errors.push(message.text());console.error('browser:',message.text());}});
  await page.addInitScript(init+'\nwindow.nativeEvents=[];window.ipc={postMessage:message=>nativeEvents.push(message)};');
  await page.route('https://**.wallpaper.invalid/**',route=>{
    if(route.request().url()===uri)return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(projection)});
    if(route.request().url()===projection.resolvedAssets[0].url)return route.fulfill({status:200,contentType:'video/webm',body:fs.readFileSync(path.join(output,'movie.webm'))});
    return route.fulfill({status:404,body:''});
  });
  await page.route('http://hertz.localhost/',route=>route.fulfill({status:200,contentType:'text/html',body:html}));
  await page.goto('http://hertz.localhost/');
  console.log('native composition page loaded');
  const accepted=await page.evaluate(async uri=>{const pending=hertzWallpaper.applyComposition(uri);hertzWallpaper.start(15);
    return Promise.race([pending,new Promise(resolve=>setTimeout(()=>resolve('preparation-timeout'),10000))]);},uri);
  assert.equal(accepted,true,JSON.stringify({errors,events:await page.evaluate(()=>nativeEvents)}));
  console.log('native composition preparation completed');
  await page.waitForFunction(()=>nativeEvents.some(event=>event.includes('firstFrame')),null,{timeout:10000}).catch(async failure=>{
    throw new Error(failure.message+'\n'+JSON.stringify(await page.evaluate(()=>({events:nativeEvents,stats:hertzWallpaper.debug(),budget:HertzGlBudget.stats()}))));
  });
  await page.waitForFunction(()=>hertzWallpaper.debug().draws>=3,null,{timeout:10000});
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
    const fitUri=fs.readFileSync(path.join(directory,'uri.txt'),'utf8'),fitInit=fs.readFileSync(path.join(directory,'native-init.js'),'utf8');
    const fitPage=await browser.newPage({viewport:{width:64,height:128}}),fitErrors=[];
    fitPage.on('pageerror',error=>fitErrors.push(error.message));
    fitPage.on('console',message=>{if(message.type()==='error')fitErrors.push(message.text());});
    await fitPage.addInitScript(fitInit+'\nwindow.nativeEvents=[];window.ipc={postMessage:message=>nativeEvents.push(message)};');
    await fitPage.route('https://**.wallpaper.invalid/**',route=>{
      if(route.request().url()===fitUri)return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(fitProjection)});
      if(route.request().url()===fitProjection.resolvedAssets[0].url)return route.fulfill({status:200,contentType:'video/webm',body:fs.readFileSync(path.join(output,'movie.webm'))});
      return route.fulfill({status:404,body:''});
    });
    await fitPage.route('http://hertz.localhost/',route=>route.fulfill({status:200,contentType:'text/html',body:html}));
    await fitPage.goto('http://hertz.localhost/');
    assert.equal(await fitPage.evaluate(async url=>{const prepared=hertzWallpaper.applyComposition(url);hertzWallpaper.start(15);return await prepared;},fitUri),true);
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
  fs.writeFileSync(path.join(output,'native-page-evidence.json'),JSON.stringify({source:'actual Rust production selector + GlAdmission + original native page',qualification:'browser integration; controlled visibility event/state; Windows/GPU qualification pending',state,blockedBefore,blockedAfter,hiddenBefore,hiddenAfter,visibilityResumed,fits,paused,retired,errors},null,2));
  console.log('PASS native composition page: real Rust projection, one context, complete frame, pause and retirement');
 }finally{await browser.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
