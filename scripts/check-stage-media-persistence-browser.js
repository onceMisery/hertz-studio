// SPDX-License-Identifier: MIT
// Real service + real browser, isolated DataDir. No provider calls or user applications.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {lifecycleChecks}=require('./stage-media-lifecycle-checks');
const root=path.join(__dirname,'..'),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'hertz-stage-browser-'));
const data=path.join(scratch,'data'),binary=process.env.HERTZ_BIN || path.join(root,'target/debug/hertz-studio.exe');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let child,browser,context,base,discovery;
async function availableBrowserPort(){
  for(let attempt=0;attempt<10;attempt++){
    const server=require('node:net').createServer(),port=require('node:crypto').randomInt(49152,65536);
    try{
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
      await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));return port;
    }catch(error){if(error.code!=='EADDRINUSE' && error.code!=='EACCES')throw error;}
  }
  throw Error('No isolated browser-safe port available');
}
async function start(port=0){
  if(!port)port=await availableBrowserPort();
  fs.mkdirSync(data,{recursive:true});
  const marker=path.join(data,'vmusicd.json');if(fs.existsSync(marker))fs.unlinkSync(marker);
  child=spawn(binary,['--bind','127.0.0.1','--port',String(port),'--data-dir',data],{windowsHide:true,stdio:'ignore',env:{...process.env,VMUSIC_BACKEND:'null',VMUSIC_SECRETS:'memory'}});
  for(let i=0;i<200;i++){
    if(child.exitCode!==null)throw Error('Fixture service exited');
    if(fs.existsSync(marker)){try{discovery=JSON.parse(fs.readFileSync(marker));base='http://127.0.0.1:'+discovery.port;return;}catch{}}
    await delay(100);
  }
  throw Error('Service startup timed out');
}
async function stop(){if(!child || child.exitCode!==null)return;const exited=once(child,'exit');child.kill();await exited;}
async function api(route,method='GET',body){
  const res=await fetch(base+route,{method,headers:{Authorization:'Bearer '+discovery.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const json=await res.json();assert.equal(res.status,200,JSON.stringify(json));return json;
}
async function ready(page){
  await context.addCookies([{name:'vmusic_session',value:discovery.token,url:base,httpOnly:true,sameSite:'Strict'}]);
  await page.goto(base);await page.waitForFunction(()=>window.StagePersistence && StagePersistence.status().hydrated);
  await page.evaluate(()=>CreativeStage.hydrated());
}
async function choose(page,file){
  await page.evaluate(()=>{Workshop.open();Workshop.setTab('look');});
  await page.getByRole('button',{name:'我的图片 / 视频',exact:true}).click();
  await page.locator('#ws-body input[type=file]').setInputFiles(file);
  await page.waitForFunction(()=>document.querySelector('#ws-body')?.textContent.includes('素材与背景选择已保存'),{},{timeout:30000});
  await page.evaluate(()=>Backgrounds.ready());
  return page.evaluate(()=>CreativeStage.preset().bg);
}
async function main(){
  const errors=[];
  try{
    await start();
    for(const file of ['backgrounds.js','stage-media.js']){
      const response=await fetch(base+'/'+file,{headers:{Authorization:'Bearer '+discovery.token}});
      assert.equal(response.status,200);
      const hash=bytes=>require('node:crypto').createHash('sha256').update(bytes).digest('hex');
      assert.equal(hash(Buffer.from(await response.arrayBuffer())),hash(fs.readFileSync(path.join(root,'plugin/ui',file))),file+' embedded in the tested binary must match the current source');
    }
    browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome',headless:true});
    context=await browser.newContext({viewport:{width:1280,height:850}});
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await ready(page);
    const originalImage=path.join(scratch,'original.jpg');fs.copyFileSync(path.join(root,'crates/hertz-desktop/assets/scene-thumbnails/coast.jpg'),originalImage);
    const image=await choose(page,originalImage);assert.ok(image.assetRef);assert.equal(image.url,undefined);assert.equal(image.media,'image');
    fs.unlinkSync(originalImage);
    const saved=await api('/v1/stage/presets');assert.deepEqual(saved.current.bg,image);assert.ok(!JSON.stringify(saved).includes('blob:'));
    await page.reload();await page.waitForFunction(()=>window.StagePersistence && StagePersistence.status().hydrated);await page.evaluate(()=>CreativeStage.hydrated());await page.evaluate(()=>Backgrounds.ready());
    assert.ok(await page.evaluate(()=>Backgrounds.sourceFrame().ready));
    assert.equal(await page.evaluate(()=>Backgrounds.sourceFrame().source.crossOrigin),'anonymous');
    // Regenerate a deleted derived image from the durable original, with no file picker.
    await page.evaluate(()=>CreativeStage.setBackground({type:'theme'}));await page.evaluate(()=>CreativeStage.flushPersistence());
    const derived=path.join(data,'stage-media','derived',image.assetRef.assetId);
    for(const entry of fs.readdirSync(derived))fs.unlinkSync(path.join(derived,entry));
    await page.evaluate(async spec=>{await Backgrounds.selectMedia(spec);CreativeStage.setBackground(spec);await CreativeStage.flushPersistence();Backgrounds.commitSelection();},image);
    assert.ok(fs.readdirSync(derived).some(name=>name.endsWith('.png')));
    // Controlled DBX image transport: same bounded lease/read API, actual Blob and decoder.
    await page.evaluate(async spec=>{
      Backgrounds.apply({type:'theme'});
      const post=VMusicTransport.post;let reads=0;
      VMusicTransport.post=async function(url,body,options){const r=await post(url,body,options);if(body.action==='lease.acquire')r.url=null;if(body.action==='lease.read'){reads++;if(body.count>262144)throw Error('unbounded read');}return r;};
      try{await Backgrounds.selectMedia(spec);if(!Backgrounds.sourceFrame().source.src.startsWith('blob:'))throw Error('not DBX blob');if(!reads)throw Error('no chunk reads');Backgrounds.commitSelection();}
      finally{VMusicTransport.post=post;}
    },image);
    const originalVideo=path.join(scratch,'original.webm');fs.copyFileSync(path.join(root,'scripts/fixtures/wallpaper-vp8.webm'),originalVideo);
    const video=await choose(page,originalVideo);assert.equal(video.media,'video');assert.ok(video.assetRef);fs.unlinkSync(originalVideo);
    await page.evaluate(async()=>{
      const element=Backgrounds.sourceFrame().source;
      if(element.tagName!=='VIDEO' || !element.videoWidth)throw Error('video did not decode');
      CreativeStage.setBackground({...Backgrounds.values(),opacity:37});await CreativeStage.flushPersistence();
      if(Backgrounds.sourceFrame().source!==element)throw Error('parameter edit restarted decoder');
      if(document.querySelectorAll('#creative-bg video').length!==1)throw Error('duplicate decoder');
    });
    // Restart the actual service after deleting both picker originals.
    await page.goto('about:blank');await stop();await start();await ready(page);await page.evaluate(()=>Backgrounds.ready());
    const restored=await page.evaluate(()=>({spec:CreativeStage.preset().bg,frame:{ready:Backgrounds.sourceFrame().ready,tag:Backgrounds.sourceFrame().source?.tagName}}));
    assert.deepEqual(restored.spec.assetRef,video.assetRef);assert.equal(restored.spec.opacity,37);assert.equal(restored.frame.tag,'VIDEO');assert.equal(restored.frame.ready,true);
    const lifecycle=await lifecycleChecks({page,image,video,api,restart:async()=>{
      const port=discovery.port;await stop();
      await page.waitForFunction(()=>window.stageMediaConnection===false);
      await start(port);
    }});
    // A second window's successful save cannot be silently overwritten by stale autosave.
    const before=await api('/v1/stage/presets'),other=structuredClone(before.current);other.name='other window';
    await api('/v1/stage/presets','PUT',{target:'current',requestId:'browser-other-window',expectedPresetRevision:before.state.current.revision,payload:other});
    await page.evaluate(async()=>{CreativeStage.renamePreset('my unsaved edit');await CreativeStage.flushPersistence().catch(()=>{});});
    assert.ok(await page.evaluate(()=>StagePersistence.status().current.error));assert.equal((await api('/v1/stage/presets')).current.name,'other window');
    await page.evaluate(()=>{Workshop.open();Workshop.setTab('look');});
    await page.getByRole('button',{name:'用当前修改重试',exact:true}).click();
    await page.waitForFunction(()=>!StagePersistence.status().current.error && !StagePersistence.status().current.saving);
    assert.equal((await api('/v1/stage/presets')).current.name,'my unsaved edit');
    const output=path.join(root,'output/playwright');fs.mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,'stage-media-persistence.png')});
    assert.deepEqual(errors,[]);
    const hash=file=>require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    fs.writeFileSync(path.join(output,'stage-media-persistence-report.json'),JSON.stringify({
      browser:browser.version(),binarySha256:hash(binary),
      sourceSha256:Object.fromEntries(['backgrounds.js','stage-media.js','app.js'].map(file=>[file,hash(path.join(root,'plugin/ui',file))])),
      imageImport:true,videoImport:true,deletedOriginalRecovery:true,serviceRestart:true,derivedRebuild:true,dbxImageChunks:true,explicitConflictRetry:true,
      lifecycle,errors},null,2)+'\n');
    console.log('Stage media browser: real image/video import, origin-clean decode/seek, picker file deletion, reload/service restart, derived regeneration, DBX chunk image and explicit CAS conflict recovery passed');
  }finally{
    if(context)await context.close();if(browser)await browser.close();await stop();
    const resolved=fs.realpathSync(scratch);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('hertz-stage-browser-'));
    fs.rmSync(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
