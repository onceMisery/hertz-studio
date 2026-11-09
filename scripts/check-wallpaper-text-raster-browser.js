// SPDX-License-Identifier: MIT
// Actual native planner facts and shipped GL page. The fixture's testing
// qualifier proves integration only; Windows qualification remains separate.
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..');
const directory=path.resolve(process.env.HERTZ_TEXT_RASTER_FIXTURE||path.join(root,'output/a04-p2-20261108/font-text/native-page-internal'));
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const projection=JSON.parse(fs.readFileSync(path.join(directory,'projection.json'),'utf8'));
const uri=fs.readFileSync(path.join(directory,'uri.txt'),'utf8');
const init=fs.readFileSync(path.join(directory,'native-init.js'),'utf8');
const closure=JSON.parse(fs.readFileSync(path.join(directory,'closure.json'),'utf8'));
assert(projection.textRasters.length>0,'the fixture must contain native raster facts');
for(const file of closure){
  const bytes=fs.readFileSync(path.join(directory,file.file));
  assert.equal(digest(bytes),file.entry.sha256,'fixture pin bytes match the native entry');
  assert.equal(bytes.length,file.entry.bytes);
}
const instrumentation=`
window.rasterObservations={canvases:[],measurements:0,fontLoads:0};
if(window.textDeviceMaximum){
  const nativeParameter=WebGL2RenderingContext.prototype.getParameter;
  WebGL2RenderingContext.prototype.getParameter=function(parameter){return parameter===this.MAX_TEXTURE_SIZE?textDeviceMaximum:nativeParameter.call(this,parameter);};
}
const nativeCreateElement=document.createElement.bind(document);
document.createElement=function(tag,...args){const value=nativeCreateElement(tag,...args);if(tag==='canvas')rasterObservations.canvases.push(value);return value;};
const nativeMeasure=CanvasRenderingContext2D.prototype.measureText;
CanvasRenderingContext2D.prototype.measureText=function(...args){rasterObservations.measurements++;return nativeMeasure.apply(this,args);};
const nativeFontLoad=FontFace.prototype.load;
FontFace.prototype.load=function(...args){rasterObservations.fontLoads++;return nativeFontLoad.apply(this,args);};
window.nativeEvents=[];window.ipc={postMessage:message=>nativeEvents.push(message)};
`;
const scene=read('crates/hertz-desktop/assets/wallpaper-scene.js');
assert.equal(scene.split('stage=spaceRuntime.create(canvas,').length,2,'passive host instrumentation has one exact site');
const html=read('crates/hertz-desktop/assets/wallpaper-scene.html')
  .replace('__GL_BUDGET__',()=>read('plugin/ui/stage-resource-budget.js')+'\n'+read('crates/hertz-desktop/assets/wallpaper-gl-budget.js'))
  .replace('__RUNTIME__',()=>instrumentation+'\n'+read('plugin/ui/vendor/stage-runtime.js'))
  .replace('__SHIM__',()=>read('plugin/ui/vendor/zodiac-stage.js'))
  .replace('__SCENE__',()=>scene.replace('stage=spaceRuntime.create(canvas,','stage=window.testNativeHost=spaceRuntime.create(canvas,'));
const evidence={qualification:fs.readFileSync(path.join(directory,'qualification.txt'),'utf8').trim(),
  fixtureSha256:digest(Buffer.from(JSON.stringify(projection))),checks:[],errors:[]};
evidence.sourceHashes=Object.fromEntries([
  'crates/hertz-desktop/assets/wallpaper-scene.js','crates/hertz-desktop/assets/wallpaper-scene.html',
  'crates/hertz-desktop/assets/wallpaper-gl-budget.js','crates/hertz-desktop/src/wallpaper/composition_plan.rs',
  'crates/hertz-desktop/src/wallpaper/composition_plan_tests.rs','crates/hertz-desktop/src/wallpaper/text_raster.rs',
  'tools/space-stage/src/composition/plan.js','tools/space-stage/src/composition/nodes.js',
  'tools/space-stage/src/composition/runtime.js','tools/space-stage/src/resources/pool.js',
  'plugin/ui/vendor/stage-runtime.js','scripts/check-wallpaper-text-raster-browser.js'
].map(name=>[name,digest(fs.readFileSync(path.join(root,name)))]));
async function main(){
  const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true,
    args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try{
    const page=await browser.newPage({viewport:{width:projection.target.width,height:projection.target.height}});
    page.on('pageerror',error=>evidence.errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error')evidence.errors.push(message.text());});
    await page.addInitScript(init);
    let blockedFont=null,fontRequests=0;
    const fulfill=async(route,asset)=>{
      const url=new URL(asset.url),relative=decodeURIComponent(url.pathname).replace(/^\//,'');
      const file=closure.find(file=>file.file===relative);
      assert(file,'only the exact native closure supplies bytes');
      const bytes=fs.readFileSync(path.join(directory,file.file));
      const range=/^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range||'');
      if(range){const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),bytes.length-1):bytes.length-1;
        assert(start<=end&&end<bytes.length);return route.fulfill({status:206,contentType:file.entry.mime,
          headers:{'accept-ranges':'bytes','content-range':`bytes ${start}-${end}/${bytes.length}`},body:bytes.subarray(start,end+1)});}
      return route.fulfill({status:200,contentType:file.entry.mime,headers:{'accept-ranges':'bytes'},body:bytes});
    };
    await page.route('https://**.wallpaper.invalid/**',async route=>{
      if(route.request().url()===uri)return route.fulfill({contentType:'application/json',body:JSON.stringify(projection)});
      const asset=projection.resolvedAssets.find(asset=>asset.url===route.request().url());
      if(!asset)return route.fulfill({status:404,body:''});
      if(asset.kind==='font'){fontRequests++;blockedFont={route,asset};return;}
      await fulfill(route,asset);
    });
    await page.route('http://hertz.localhost/',route=>route.fulfill({contentType:'text/html',body:html}));
    await page.goto('http://hertz.localhost/');
    await page.evaluate(uri=>{
      hertzWallpaper.applyConfig({source:'fixed',audioInput:{kind:'none'},motion:0,quality:'low'});
      window.preparing=hertzWallpaper.applyComposition(uri);hertzWallpaper.start(15);
    },uri);
    for(let count=0;!blockedFont&&count<500;count++)await new Promise(resolve=>setTimeout(resolve,10));
    assert(blockedFont,'the actual font source is requested');
    const blocked=await page.evaluate(()=>({events:nativeEvents,stats:hertzWallpaper.debug(),fonts:document.fonts.size,
      measurements:rasterObservations.measurements,canvases:rasterObservations.canvases.filter(canvas=>canvas.width>0&&canvas.height>0).length}));
    assert(!blocked.events.some(event=>event.includes('firstFrame')));assert.equal(blocked.fonts,0);assert.equal(blocked.measurements,0);
    evidence.checks.push({case:'blocked font bytes cannot publish a text first frame or start layout',blocked});
    await fulfill(blockedFont.route,blockedFont.asset);blockedFont=null;
    assert.equal(await page.evaluate(()=>preparing),true);
    await page.waitForFunction(()=>nativeEvents.some(event=>event.includes('firstFrame')),null,{timeout:10000});
    await page.evaluate(()=>hertzWallpaper.stop());
    const ready=await page.evaluate(()=>{
      const rasters=rasterObservations.canvases.filter(canvas=>canvas.getContext('2d'));
      return {fonts:document.fonts.size,fontLoads:rasterObservations.fontLoads,measurements:rasterObservations.measurements,
        rasters:rasters.map(canvas=>({width:canvas.width,height:canvas.height,
          alpha:canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data.some((value,index)=>index%4===3&&value>0)})),
        stats:testNativeHost.stats(),budget:HertzGlBudget.stats()};
    });
    assert.equal(fontRequests,1);assert.equal(ready.fonts,1);assert.equal(ready.fontLoads,1);
    assert.equal(ready.rasters.length,projection.textRasters.length);
    for(let index=0;index<ready.rasters.length;index++){
      assert.equal(ready.rasters[index].width,projection.textRasters[index].widthPx);
      assert.equal(ready.rasters[index].height,projection.textRasters[index].heightPx);
      assert(ready.rasters[index].alpha,'the actual prepared font produces raster glyph pixels');
    }
    assert.equal(ready.budget.contexts,1);assert.equal(ready.budget.error,null);
    evidence.checks.push({case:'native representations are deduplicated under the original GL budget',
      sharedConsumers:projection.textRasters.filter(fact=>fact.nodeIndices.length>1).map(fact=>fact.nodeIndices),ready});
    if(projection.resolvedAssets.every(asset=>asset.kind==='font')){
      const outputPixels=await page.evaluate(()=>{
        if(!testNativeHost.frame({sceneTime:0,paused:true,redraw:true}))throw new Error('text frame did not submit');
        const canvas=document.querySelector('#host canvas'),gl=canvas.getContext('webgl2');
        const pixels=new Uint8Array(canvas.width*canvas.height*4);
        gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        let glyphPixels=0;for(let index=0;index<pixels.length;index+=4)if(pixels[index]>128&&pixels[index+1]>128&&pixels[index+2]>128)glyphPixels++;
        return {width:canvas.width,height:canvas.height,glyphPixels,png:canvas.toDataURL('image/png')};
      });
      assert(outputPixels.glyphPixels>20,'prepared glyph pixels must reach the actual GL output');
      fs.writeFileSync(path.join(directory,'text-raster-output.png'),Buffer.from(outputPixels.png.split(',')[1],'base64'));
      delete outputPixels.png;
      evidence.checks.push({case:'prepared glyph pixels reach the actual GL output',outputPixels});
    }
    const unchanged=await page.evaluate(async projection=>{
      const before={measurements:rasterObservations.measurements,fontLoads:rasterObservations.fontLoads,
        work:testNativeHost.stats().sceneStats.work,canvases:rasterObservations.canvases.length};
      for(let count=0;count<100;count++){const result=await testNativeHost.selectComposition(projection);if(result.changed)throw new Error('same native facts changed');}
      return {before,after:{measurements:rasterObservations.measurements,fontLoads:rasterObservations.fontLoads,
        work:testNativeHost.stats().sceneStats.work,canvases:rasterObservations.canvases.length}};
    },projection);
    assert.deepEqual(unchanged.after,unchanged.before);
    evidence.checks.push({case:'100 identical native updates do not relayout, reload or allocate',unchanged});
    const hiddenFile=path.join(path.dirname(directory),'hidden','projection.json');
    if(path.basename(directory)==='base'&&fs.existsSync(hiddenFile)){
      const hidden=JSON.parse(fs.readFileSync(hiddenFile,'utf8'));
      const hiddenUpdate=await page.evaluate(async projection=>{
        const before={measurements:rasterObservations.measurements,canvases:rasterObservations.canvases.length,fontLoads:rasterObservations.fontLoads};
        const result=await testNativeHost.selectComposition(projection);
        if(!testNativeHost.frame({sceneTime:0,paused:true,redraw:true}))throw new Error('hidden update did not submit');
        return {result,before,after:{measurements:rasterObservations.measurements,canvases:rasterObservations.canvases.length,fontLoads:rasterObservations.fontLoads},
          work:testNativeHost.stats().sceneStats.work,fonts:document.fonts.size};
      },hidden);
      assert.equal(hiddenUpdate.result.changed,true);assert.deepEqual(hiddenUpdate.after,hiddenUpdate.before);
      assert(hiddenUpdate.work.nodeRebuilds.every(count=>count===0));assert.equal(hiddenUpdate.fonts,1);
      evidence.checks.push({case:'a native visibility update changes materials while retaining shared raster and font',hiddenUpdate});
      const style=JSON.parse(fs.readFileSync(path.join(path.dirname(directory),'style','projection.json'),'utf8'));
      const refusal=await page.evaluate(async projection=>{
        const before={measurements:rasterObservations.measurements,canvases:rasterObservations.canvases.length,
          work:testNativeHost.stats().sceneStats.work};let error;
        try{await testNativeHost.selectComposition(projection);}catch(reason){error=reason.message;}
        return {error,before,after:{measurements:rasterObservations.measurements,canvases:rasterObservations.canvases.length,
          work:testNativeHost.stats().sceneStats.work},state:testNativeHost.stats().state};
      },style);
      assert(refusal.error,'the original one-raster native page cap denies an additional style representation');
      assert.deepEqual(refusal.after,refusal.before);assert.equal(refusal.state,'ready');
      evidence.checks.push({case:'the original native cap refuses a new raster before layout and preserves the committed output',refusal});
      await page.evaluate(async projection=>{await testNativeHost.selectComposition(projection);testNativeHost.frame({sceneTime:0,paused:true,redraw:true});},projection);
    }
    await page.evaluate(()=>hertzWallpaper.reveal());
    await page.screenshot({path:path.join(directory,'text-raster-page.png')});
    await page.evaluate(()=>hertzWallpaper.unmount());
    await page.waitForFunction(()=>HertzGlBudget.stats().contexts===0&&document.fonts.size===0);
    const retired=await page.evaluate(()=>({fonts:document.fonts.size,budget:HertzGlBudget.stats(),
      canvases:rasterObservations.canvases.filter(canvas=>canvas.width>0&&canvas.height>0).map(canvas=>({width:canvas.width,height:canvas.height}))}));
    assert.equal(retired.budget.error,null);assert.deepEqual(retired.canvases,[]);
    evidence.checks.push({case:'final exit removes FontFace and clears every tracked canvas',retired});
    const unsupportedPage=await browser.newPage({viewport:{width:projection.target.width,height:projection.target.height}});
    await unsupportedPage.addInitScript(init+'\nwindow.textDeviceMaximum=1;');
    let unsupportedFetches=0;
    await unsupportedPage.route('https://**.wallpaper.invalid/**',async route=>{
      if(route.request().url()===uri)return route.fulfill({contentType:'application/json',body:JSON.stringify(projection)});
      const asset=projection.resolvedAssets.find(asset=>asset.url===route.request().url());
      if(!asset)return route.fulfill({status:404,body:''});
      unsupportedFetches++;await fulfill(route,asset);
    });
    await unsupportedPage.route('http://hertz.localhost/',route=>route.fulfill({contentType:'text/html',body:html}));
    await unsupportedPage.goto('http://hertz.localhost/');
    const unsupported=await unsupportedPage.evaluate(async uri=>{
      const accepted=await hertzWallpaper.applyComposition(uri);
      return {accepted,events:nativeEvents,fontLoads:rasterObservations.fontLoads,measurements:rasterObservations.measurements,
        fonts:document.fonts.size,liveCanvases:rasterObservations.canvases.filter(canvas=>canvas.width>0&&canvas.height>0).length,
        budget:HertzGlBudget.stats()};
    },uri);
    assert.equal(unsupported.accepted,false);assert.equal(unsupportedFetches,0);
    assert.equal(unsupported.fontLoads,0);assert.equal(unsupported.measurements,0);assert.equal(unsupported.fonts,0);
    assert.equal(unsupported.liveCanvases,0);
    assert(unsupported.events.some(event=>event.includes('composition-adapter-unavailable:text-texture-size')));
    assert(!unsupported.events.some(event=>event.includes('firstFrame')));
    await unsupportedPage.waitForFunction(()=>HertzGlBudget.stats().contexts===0);
    const unsupportedRetired=await unsupportedPage.evaluate(()=>HertzGlBudget.stats());
    assert.equal(unsupportedRetired.contexts,0);
    evidence.checks.push({case:'an insufficient reported GL texture size refuses all source loading and waits for renderer retirement',
      reportedMaximum:1,sourceFetches:unsupportedFetches,unsupported,unsupportedRetired});
    await unsupportedPage.close();
    assert.deepEqual(evidence.errors,[]);
    evidence.passed=true;
  }catch(error){evidence.failure=error.stack;throw error;}
  finally{await browser.close();fs.writeFileSync(path.join(directory,'text-raster-browser-report.json'),JSON.stringify(evidence,null,2)+'\n');}
  console.log(`${evidence.checks.length} native text raster page integration cases passed; Windows qualification remains separate.`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
