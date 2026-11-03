// SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=path.resolve(__dirname,'..'), assets=path.join(root,'crates/hertz-desktop/assets');
const guard=fs.readFileSync(path.join(assets,'wallpaper-gl-budget.js'),'utf8');
const html=fs.readFileSync(path.join(assets,'wallpaper-scene.html'),'utf8')
  .replace('__GL_BUDGET__',()=>guard)
  .replace('__RUNTIME__',()=>fs.readFileSync(path.join(root,'plugin/ui/vendor/stage-runtime.js'),'utf8'))
  .replace('__SHIM__',()=>fs.readFileSync(path.join(root,'plugin/ui/vendor/zodiac-stage.js'),'utf8'))
  .replace('__SCENE__',()=>fs.readFileSync(path.join(assets,'wallpaper-scene.js'),'utf8'));
const output=path.join(root,'output/playwright/wallpaper-gl-browser');
const limits={quality:'low',requestedQuality:'low',fps:30,refreshHz:60,pixelBudget:1900000,gpuBytes:64*1048576,generation:1};
(async()=>{
  fs.mkdirSync(output,{recursive:true});
  const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true,args:['--use-angle=swiftshader','--enable-webgl']});
  const results=[];
  async function pageFor(allocation=limits, scene=false) {
    const page=await browser.newPage({viewport:{width:1280,height:720}});
    await page.addInitScript(allocation=>{
      window.receipts=[];window.ipc={postMessage:message=>receipts.push(message)};
      Object.defineProperty(window,'__hertzWallpaperBinding',{value:Object.freeze({generation:1,sessionId:'browser'})});
      if(allocation)Object.defineProperty(window,'__hertzWallpaperGlAllocation',{value:Object.freeze(allocation)});
      // Observe real driver calls under the guard; denied calls must never reach them.
      window.driverCalls={bufferData:0,texImage2D:0,renderbufferStorage:0,contexts:0};
      const get=HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext=function(type,...args){
        const gl=get.call(this,type,...args);
        if(gl&&type==='webgl2'&&!gl.testObserved){
          driverCalls.contexts++;gl.testObserved=true;
          for(const key of ['bufferData','texImage2D','renderbufferStorage']) {
            const original=gl[key];gl[key]=function(...args){driverCalls[key]++;return original.apply(this,args);};
          }
        }
        return gl;
      };
    },allocation);
    await page.route('http://gl.test/',route=>route.fulfill({contentType:'text/html',body:scene?html:`<script>${guard}</script>`}));
    await page.goto('http://gl.test/');return page;
  }
  try {
    let page=await pageFor(null);
    assert.deepEqual(await page.evaluate(()=>({context:document.createElement('canvas').getContext('webgl2'),calls:driverCalls.contexts})),{context:null,calls:0});
    await page.close();results.push('media/unadmitted pages cannot create a GL context');
    page=await pageFor({...limits,generation:2});
    const stale=await page.evaluate(()=>{let error;try{document.createElement('canvas').getContext('webgl2');}catch(failure){error=String(failure);}return {error,calls:driverCalls.contexts};});
    assert.match(stale.error,/invalid native allocation/);assert.equal(stale.calls,0);results.push({type:'stale native allocation stays closed',...stale});await page.close();
    for(const type of ['buffer','texture','renderbuffer','second-context']) {
      page=await pageFor({...limits,gpuBytes:1048576});
      const result=await page.evaluate(type=>{
        const canvas=document.createElement('canvas'),gl=canvas.getContext('webgl2');
        let error;
        try {
          if(type==='buffer'){gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());gl.bufferData(gl.ARRAY_BUFFER,2*1048576,gl.STATIC_DRAW);}
          if(type==='texture'){gl.bindTexture(gl.TEXTURE_2D,gl.createTexture());gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,1024,1024,0,gl.RGBA,gl.UNSIGNED_BYTE,null);}
          if(type==='renderbuffer'){gl.bindRenderbuffer(gl.RENDERBUFFER,gl.createRenderbuffer());gl.renderbufferStorage(gl.RENDERBUFFER,gl.RGBA8,1024,1024);}
          if(type==='second-context')document.createElement('canvas').getContext('webgl2');
        } catch(failure){error=String(failure);}
        return {error,calls:driverCalls,stats:HertzGlBudget.stats(),receipts};
      },type);
      assert.match(result.error,/gl_budget:/);
      assert.deepEqual(result.calls,{bufferData:0,texImage2D:0,renderbufferStorage:0,contexts:1});
      assert.equal(result.receipts.filter(text=>text.startsWith('wallpaper_gl_failed')).length,1);
      results.push({type,...result});await page.close();
    }
    for(const retired of [false,true]) {
      page=await pageFor({...limits,gpuBytes:2*1048576});
      const result=await page.evaluate(retired=>{
        const canvas=document.createElement('canvas');canvas.width=canvas.height=8;
        const gl=canvas.getContext('webgl2'), buffer=gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,1200000,gl.STATIC_DRAW);
        if(retired){gl.deleteBuffer(buffer);gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());}
        let error;try{gl.bufferData(gl.ARRAY_BUFFER,1200000,gl.STATIC_DRAW);}catch(failure){error=String(failure);}
        return {error,calls:driverCalls,stats:HertzGlBudget.stats()};
      },retired);
      assert.match(result.error,/gl_budget:/);assert.equal(result.calls.bufferData,1,'old storage cannot be credited before actual exit');
      assert.ok(result.stats.bytes>=1200000);if(retired)assert.equal(result.stats.pendingBytes,1200000);
      results.push({type:retired?'deleted storage retains charge':'reallocation peak rejected',...result});await page.close();
    }
    page=await pageFor(limits,true);
    await page.evaluate(()=>{hertzWallpaper.applyConfig({source:'fixed',scene:'zodiac',quality:'high',refreshHz:144});hertzWallpaper.start(60);});
    await page.waitForFunction(()=>hertzWallpaper.debug().draws>2,null,{timeout:15000});
    let debug=await page.evaluate(()=>hertzWallpaper.debug());
    assert.equal(debug.quality,'low');assert.equal(debug.refreshHz,60);assert.equal(debug.gate.budget,30);
    const scenes=['coast','reactor','butterfly-vortex','phoenix-vortex','particle-silk','gravity-sphere','warp-tunnel','prism-galaxy','zodiac'];
    for(const scene of scenes) {
      await page.evaluate(scene=>hertzWallpaper.applyConfig({source:'fixed',scene,quality:'low'}),scene);
      await page.waitForFunction(scene=>{const d=hertzWallpaper.debug();return d.scene===scene&&d.mounted&&d.glBudget.contexts===1;},scene,{timeout:15000});
      await page.waitForTimeout(200);
      debug=await page.evaluate(()=>hertzWallpaper.debug());
      assert.equal(debug.glBudget.error,null);assert.ok(debug.glBudget.peakBytes<=limits.gpuBytes);results.push({scene,debug});
    }
    await page.evaluate(()=>hertzWallpaper.unmount());
    await page.waitForFunction(()=>HertzGlBudget.stats().contexts===0);
    assert.equal(await page.evaluate(()=>HertzGlBudget.stats().bytes),0);
    await page.close();
    for(const quality of ['medium','high']) {
      const profile=JSON.parse(fs.readFileSync(path.join(root,'crates/hertz-wallpaper/contracts/gl-budgets.json'),'utf8'))[quality];
      page=await pageFor({...limits,...profile,quality},true);await page.setViewportSize({width:3840,height:2160});
      await page.evaluate(quality=>{hertzWallpaper.applyConfig({source:'fixed',scene:'reactor',quality});hertzWallpaper.start(30);},quality);
      await page.waitForFunction(()=>hertzWallpaper.debug().draws>2,null,{timeout:15000});
      const debug=await page.evaluate(()=>hertzWallpaper.debug());assert.equal(debug.glBudget.error,null);assert.ok(debug.glBudget.peakBytes<=profile.gpuBytes);
      const dimensions=await page.evaluate(()=>{const c=document.querySelector('canvas');return {width:c.width,height:c.height};});
      assert.ok(dimensions.width*dimensions.height<=profile.pixelBudget);results.push({quality,dimensions,debug});await page.close();
    }
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({ok:true,results},null,2));
    console.log(`GL browser checks passed: ${results.length} groups`);
  } catch(error) {
    const diagnostics=[];
    for(const context of browser.contexts())for(const page of context.pages())diagnostics.push(await page.evaluate(()=>({debug:window.hertzWallpaper?.debug(),receipts:window.receipts,stats:window.HertzGlBudget?.stats()})).catch(()=>null));
    fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:String(error),diagnostics,results},null,2));throw error;
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
