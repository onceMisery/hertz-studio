// SPDX-License-Identifier: MIT
// Actual Rust IR, shipped bundle, media decoders, FontFace and GL pixels.
'use strict';
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
const {execFileSync}=require('node:child_process'), {createHash}=require('node:crypto'), zlib=require('node:zlib');
const {loadCompositionFontFixture}=require('./composition-font-fixture.js');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=path.resolve(__dirname,'..'), output=path.join(root,'output/a04-p2-20261108/composition-browser');
const fontFixture=loadCompositionFontFixture();
fs.mkdirSync(output,{recursive:true});
function hash(bytes){return createHash('sha256').update(bytes).digest('hex');}
function crc(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function chunk(type,bytes){const t=Buffer.from(type), out=Buffer.alloc(bytes.length+12);out.writeUInt32BE(bytes.length);t.copy(out,4);bytes.copy(out,8);out.writeUInt32BE(crc(Buffer.concat([t,bytes])),bytes.length+8);return out;}
function png(width,height,pixel){const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
 const data=Buffer.alloc(height*(width*4+1));for(let y=0;y<height;y++)for(let x=0;x<width;x++)Buffer.from(pixel(x,y)).copy(data,y*(width*4+1)+1+x*4);
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(data)),chunk('IEND',Buffer.alloc(0))]);}
const sourceAssets=[
 {assetId:'blue',kind:'image',file:'blue.png',mime:'image/png',width:8,height:8,bytes:png(8,8,()=>[0,0,255,255])},
 {assetId:'red',kind:'image',file:'red.png',mime:'image/png',width:8,height:8,bytes:png(8,8,()=>[255,0,0,255])},
 {assetId:'soft',kind:'image',file:'soft.png',mime:'image/png',width:8,height:8,bytes:png(8,8,()=>[255,0,0,128])},
 {assetId:'green',kind:'image',file:'green.png',mime:'image/png',width:8,height:8,bytes:png(8,8,()=>[0,255,0,255])},
 {assetId:'mask',kind:'image',file:'mask.png',mime:'image/png',width:8,height:8,bytes:png(8,8,()=>[128,128,128,255])},
 {assetId:'wide',kind:'image',file:'wide.png',mime:'image/png',width:16,height:8,bytes:png(16,8,(x)=>x<8?[255,0,0,255]:[0,255,0,255])},
 {assetId:'video',kind:'video',file:'video.webm',mime:'video/webm',bytes:fs.readFileSync(path.join(root,'scripts/fixtures/wallpaper-vp8.webm'))},
 {assetId:'font',kind:'font',file:fontFixture.file,mime:fontFixture.mime,bytes:fontFixture.bytes}
];
for(const a of sourceAssets)fs.writeFileSync(path.join(output,a.file),a.bytes);
for(const file of fontFixture.packageFiles){fs.mkdirSync(path.dirname(path.join(output,file.file)),{recursive:true});fs.writeFileSync(path.join(output,file.file),file.bytes);}
const compilerTarget=process.env.HERTZ_COMPOSITION_COMPILER_TARGET_DIR?path.resolve(process.env.HERTZ_COMPOSITION_COMPILER_TARGET_DIR):path.join(root,'target');
const compilerArgs=['build','-p','hertz-wallpaper','--example','export_composition_ir'];
if(process.env.HERTZ_COMPOSITION_COMPILER_TARGET_DIR)compilerArgs.push('--target-dir',compilerTarget);
execFileSync('cargo',compilerArgs,{cwd:root,stdio:'inherit'});
const executable=path.join(compilerTarget,'debug/examples/export_composition_ir'+(process.platform==='win32'?'.exe':''));
let number=0;const compilerInputs=new WeakMap(),nativeFontRequests=[];
const fontProjectionKey=compiled=>hash(Buffer.from(JSON.stringify([compiled.ir.semanticKey,compiled.finalPublicValues])));
function rememberFontProjection(compiled,inputs,overrides={}){
 if(!compiled.ir.nodes.some(node=>node.nodeType==='text'))return;
 const manifest=JSON.parse(fs.readFileSync(inputs[0],'utf8'));
 nativeFontRequests.push({key:fontProjectionKey(compiled),document:JSON.parse(fs.readFileSync(inputs[1],'utf8')),
  assets:manifest.assets,properties:manifest.properties,overrides,
  files:manifest.files.filter(entry=>entry.path!=='document.json').map(entry=>({path:entry.path,mime:entry.mime,
   source:path.join(output,entry.path.startsWith('assets/')?entry.path.slice(7):entry.path)}))});
}
function compile(nodes,canvas={width:64,height:64,colorSpace:'srgb',background:'#000000'},properties=[]){
 const document={documentVersion:1,canvas,nodes,timeline:{durationSeconds:2,loop:true,tracks:[]},bindings:[]};
 const bytes=Buffer.from(JSON.stringify(document)), id=++number, documentPath=path.join(output,`document-${id}.json`), manifestPath=path.join(output,`manifest-${id}.json`);
 fs.writeFileSync(documentPath,bytes);
 fs.writeFileSync(manifestPath,JSON.stringify({formatVersion:1,workId:'8bc16f98-a0ef-4df9-a9a4-aecdb4c3f772',version:1,title:'Composition browser verification',
  content:{kind:'composition',document:'document.json'},assets:sourceAssets.map(a=>({id:a.assetId,kind:a.kind,source:'assets/'+a.file})),
  files:[{path:'document.json',bytes:bytes.length,sha256:hash(bytes),mime:'application/json'},...sourceAssets.map(a=>({path:'assets/'+a.file,bytes:a.bytes.length,sha256:hash(a.bytes),mime:a.mime})),
   ...fontFixture.packageFiles.map(file=>({path:file.file,bytes:file.bytes.length,sha256:hash(file.bytes),mime:file.mime}))],
  properties,permissions:{audioSpectrum:false,pointer:false},license:{code:'MIT',...fontFixture.manifestLicense}}));
 const result=JSON.parse(execFileSync(executable,[manifestPath,documentPath],{cwd:root,encoding:'utf8'}));
 fs.writeFileSync(path.join(output,`ir-${id}.json`),JSON.stringify(result,null,2));compilerInputs.set(result,[manifestPath,documentPath]);rememberFontProjection(result,[manifestPath,documentPath]);return result;
}
function publicValues(compiled,values){const valuePath=path.join(output,`public-values-${++number}.json`);fs.writeFileSync(valuePath,JSON.stringify(values));
 const projected=JSON.parse(execFileSync(executable,[...compilerInputs.get(compiled),valuePath],{cwd:root,encoding:'utf8'}));
 fs.writeFileSync(path.join(output,`final-projection-${number}.json`),JSON.stringify(projected,null,2));rememberFontProjection(projected,compilerInputs.get(compiled),values);return projected;}
const property=(id,type,nodeId,field,value,constraints)=>({id,label:id,type,default:value,constraints,target:{kind:'node',nodeId,property:field,component:null}});
const image=(id,asset,properties={},assets={})=>({id,type:'image',stateVersion:1,assets:{asset,...assets},properties:{x:0,y:0,width:64,height:64,anchorX:0,anchorY:0,fit:'stretch',...properties}});
const alpha=compile([image('back','blue'),image('red-layer','red',{width:32,height:32,opacity:.5}),
 {id:'parent',type:'group',stateVersion:1,children:['red-layer'],properties:{x:16,y:16,width:64,height:64,anchorX:0,anchorY:0,opacity:.5}},
 image('front','green',{x:32,y:16,width:16,height:32,opacity:.5})]);
const mask=compile([image('back','blue'),image('front','soft',{}, {maskAsset:'mask'})]);
const fit=compile([image('wide-layer','wide',{width:64,height:64,fit:'contain'})]);
const text=compile([{id:'label',type:'text',stateVersion:1,assets:{fontAsset:'font'},properties:{x:0,y:0,width:64,height:64,anchorX:0,anchorY:0,text:'Hertz',fontSize:32,color:'#ffffff'}}]);
const particles=compile([{id:'field',type:'particles',stateVersion:1,properties:{x:32,y:0,width:64,height:64,anchorX:0,anchorY:0,count:24,seed:19,lifetimeSeconds:2,speed:24,spread:50}}]);
const video=compile([{id:'movie',type:'video',stateVersion:1,assets:{asset:'video'},properties:{x:0,y:0,width:64,height:64,anchorX:0,anchorY:0,loopStartMs:0,loopEndMs:200}}]);
const dirtyFixture=compile([image('back','blue'),image('child','red',{width:16,height:16}),
 {id:'parent',type:'group',stateVersion:1,children:['child'],properties:{x:8,y:8,width:64,height:64,anchorX:0,anchorY:0}},
 image('unrelated','green',{x:48,y:48,width:16,height:16}),
 {id:'caption',type:'text',stateVersion:1,assets:{fontAsset:'font'},properties:{x:0,y:32,width:32,height:32,anchorX:0,anchorY:0,text:'Hertz',fontSize:16}}],undefined,[
 property('parent-x','number','parent','x',8,{min:-65536,max:65536}),property('parent-opacity','number','parent','opacity',1,{min:0,max:1}),
 property('parent-visible','boolean','parent','visible',true,{}),
 property('picture','asset','child','asset','red',{kind:'image',options:['red','soft','wide']}),
 property('caption-text','text','caption','text','Hertz',{maxLength:4096})]);
const movedDirty=publicValues(dirtyFixture,{'parent-x':24}), resourceDirty=publicValues(dirtyFixture,{'parent-x':24,picture:'soft'}),
 textDirty=publicValues(dirtyFixture,{'parent-x':24,picture:'soft','caption-text':'Studio'}),
 badDirty=publicValues(dirtyFixture,{'parent-x':24,picture:'wide','caption-text':'Hertz Studio'}),
 hiddenDirty=publicValues(dirtyFixture,{'parent-visible':false});
const clipping=compile([image('outside','red',{y:-16,height:96})]);
const clippingRotated=compile([image('outside','soft',{x:32,y:32,width:96,height:96,anchorX:.5,anchorY:.5,rotation:45},{maskAsset:'mask'})]);
const sharedVideo=compile([
 {id:'movie-a',type:'video',stateVersion:1,assets:{asset:'video'},properties:{x:0,y:0,width:32,height:32,anchorX:0,anchorY:0,loopStartMs:0,loopEndMs:200}},
 {id:'movie-b',type:'video',stateVersion:1,assets:{asset:'video'},properties:{x:32,y:0,width:32,height:32,anchorX:0,anchorY:0,loopStartMs:0,loopEndMs:200}},
 {id:'movie-c',type:'video',stateVersion:1,assets:{asset:'video'},properties:{x:0,y:32,width:64,height:32,anchorX:0,anchorY:0,loopStartMs:0,loopEndMs:300}}
],undefined,[property('movie-end','number','movie-a','loopEndMs',200,{min:.001,max:86400000})]);
const independentVideo=publicValues(sharedVideo,{'movie-end':100});
const particleDirty=compile([{id:'field',type:'particles',stateVersion:1,properties:{x:32,y:0,width:64,height:64,anchorX:0,anchorY:0,count:24,seed:19,lifetimeSeconds:2,speed:24,spread:50}}],undefined,[
 property('count','number','field','count',24,{min:0,max:65536}),property('seed','number','field','seed',19,{min:0,max:4294967295})]);
const results=[];
(async()=>{
 const requestsFile=path.join(output,'native-font-requests.json'),nativeFile=path.join(output,'native-font-projections.json');
 fs.writeFileSync(requestsFile,JSON.stringify(nativeFontRequests,null,2));
 execFileSync('cargo',['test','--locked','-p','hertz-desktop','--lib','--features','wallpaper-media-probe',
  'internal_browser_font_requests_export_original_prepared_projection_and_pins','--','--test-threads=1'],
  {cwd:root,stdio:'inherit',env:{...process.env,HERTZ_COMPOSITION_BROWSER_FONT_REQUESTS:requestsFile,HERTZ_COMPOSITION_BROWSER_FONT_OUTPUT:nativeFile}});
 const nativeFontProjections=JSON.parse(fs.readFileSync(nativeFile,'utf8')),nativeFiles=new Map();
 for(const item of Object.values(nativeFontProjections))for(const file of item.files){
  const bytes=fs.readFileSync(path.join(output,file.file));assert.equal(hash(bytes),file.entry.sha256);assert.equal(bytes.length,file.entry.bytes);
  nativeFiles.set(file.url,{bytes,mime:file.entry.mime});
 }
 const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 try{
  const page=await browser.newPage({viewport:{width:64,height:64}}), errors=[],consoleErrors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',message=>{if(message.type()==='error'){consoleErrors.push(message.text());console.error(message.text());}});
  await page.route('https://**.wallpaper.invalid/**',route=>{
   const file=nativeFiles.get(route.request().url());return file?route.fulfill({body:file.bytes,contentType:file.mime}):route.fulfill({status:404,body:''});
  });
  let delayedRoute=null;
  await page.route('http://composition.test/**',async route=>{
   const file=new URL(route.request().url()).pathname.slice(1);
   if(file==='broken.png')return route.fulfill({body:Buffer.from('bad PNG decoder input'),contentType:'image/png'});
   if(file==='delayed.png'){delayedRoute=route;return;}
   const asset=sourceAssets.find(a=>a.file===file);
   if(asset){
    const range=asset.kind==='video'&&/^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range||'');
    if(range){const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),asset.bytes.length-1):asset.bytes.length-1;
     return route.fulfill({status:206,contentType:asset.mime,headers:{'accept-ranges':'bytes','content-range':`bytes ${start}-${end}/${asset.bytes.length}`},body:asset.bytes.subarray(start,end+1)});}
    return route.fulfill({body:asset.bytes,contentType:asset.mime});
   }
   if(file.startsWith('src/'))return route.fulfill({body:fs.readFileSync(path.join(root,'tools/space-stage',file)),contentType:'text/javascript'});
   if(file==='')return route.fulfill({contentType:'text/html',body:'<body style="margin:0;background:black"><canvas width="64" height="64" style="width:64px;height:64px"></canvas></body>'});
   return route.abort();
  });
  await page.goto('http://composition.test/');
  await page.addScriptTag({path:path.join(root,'plugin/ui/stage-resource-budget.js')});
  await page.addScriptTag({path:path.join(root,'plugin/ui/stage-resource-policy.js')});
  await page.addScriptTag({path:path.join(root,'plugin/ui/vendor/stage-runtime.js')});
  await page.addScriptTag({path:path.join(root,'plugin/ui/vendor/space-stage.js')});
  const actualVideo=await page.evaluate(async()=>{const v=document.createElement('video');v.muted=true;v.src='/video.webm';await new Promise((r,j)=>{v.onloadedmetadata=r;v.onerror=j;});const m={width:v.videoWidth,height:v.videoHeight,durationMs:v.duration*1000};v.removeAttribute('src');v.load();return m;});
  const nativeFont=Object.values(nativeFontProjections)[0].projection.resolvedAssets.find(asset=>asset.kind==='font');
  const resolved=sourceAssets.map(a=>a.kind==='font'?{...nativeFont,url:'http://composition.test/'+a.file}:({assetId:a.assetId,kind:a.kind,width:a.width,height:a.height,...(a.kind==='video'?actualVideo:{}),
    contentKey:hash(a.bytes),byteLength:a.bytes.length,url:'http://composition.test/'+a.file,decodeOptions:{colorSpace:a.kind==='font'?'none':'srgb',alphaMode:'straight'},adapterId:a.kind==='font'?'fontface-v1':a.kind==='video'?'video-element-v1':'image-element-v1',adapterVersion:1}));
  const setup=await page.evaluate(()=>{window.counts={contexts:0,loads:0};let original=HTMLCanvasElement.prototype.getContext;
   const seen=new WeakSet();HTMLCanvasElement.prototype.getContext=function(type,...args){const ctx=original.call(this,type,...args);if(ctx&&type==='webgl2'&&!seen.has(ctx)){seen.add(ctx);counts.contexts++;window.gl=ctx;}return ctx;};
   window.ledger=StageResourceBudget.create(StageResourcePolicy);window.port=ledger.port('composition','composition-session');
   window.reservationCalls=0;window.gatePort={...port,require(...args){reservationCalls++;if(window.reservationFailure&&reservationCalls===reservationFailure)throw new Error('delta-refusal');return port.require(...args);}};
   window.observedVideos=[];const element=document.createElement.bind(document);document.createElement=function(tag,...args){const value=element(tag,...args);if(tag==='video'){
    value.testPauseCalls=0;const pause=value.pause.bind(value);value.pause=function(){value.testPauseCalls++;return pause();};observedVideos.push(value);}return value;};
   window.host=SpaceStagePure.create(document.querySelector('canvas'),{qualityMode:'high',deviceTier:2,resources:gatePort,onInvalidate(){}});
   window.redraw=()=>host.frame({sceneTime:host.stats().sceneStats.sceneTime,paused:true,redraw:true});
   window.snapshot=()=>{redraw();const b=new Uint8Array(64*64*4);gl.readPixels(0,0,64,64,gl.RGBA,gl.UNSIGNED_BYTE,b);return Array.from(b);};
   window.pixel=(x,y)=>{redraw();const b=new Uint8Array(4);gl.readPixels(x,63-y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,b);return Array.from(b);};return {width:gl.drawingBufferWidth,height:gl.drawingBufferHeight};});
  assert.deepEqual(setup,{width:64,height:64});
  const projection=compiled=>{
   const native=nativeFontProjections[fontProjectionKey(compiled)]?.projection;
   if(compiled.ir.nodes.some(node=>node.nodeType==='text'))assert(native,'every text fixture uses actual Rust prepared facts');
   if(native)assert.equal(native.ir.semanticKey,compiled.ir.semanticKey,'native preparation preserves the compiler semantic identity');
   return {...(native||compiled),resolvedAssets:native?.resolvedAssets||resolved,sessionId:'browser',generation:1,
    target:{width:64,height:64,fit:'stretch',budgetFps:30,budgetAllocationRevision:1}};
  };
  async function select(compiled){
   return page.evaluate(async p=>{await host.selectComposition(p);host.frame({sceneTime:0,paused:true});return host.stats();},projection(compiled));}
  let stats=await select(alpha);assert.equal(stats.state,'ready',JSON.stringify(stats));
  const pixels=await page.evaluate(()=>({back:pixel(4,4),red:pixel(20,20),front:pixel(36,20),contexts:counts.contexts,ledger:ledger.snapshot()}));
  const near=(actual,expected)=>{for(let i=0;i<3;i++)assert.ok(Math.abs(actual[i]-expected[i])<=4,`${actual} != ${expected}`);};
  near(pixels.back,[0,0,255]);near(pixels.red,[137,0,225]);near(pixels.front,[99,188,165]);assert.equal(pixels.contexts,1);assert.equal(pixels.ledger.violations.length,0);
  results.push({case:'linear alpha, fixed child/root painter order, inherited matrix, unique renderer',pixels});
  await select(mask);near(await page.evaluate(()=>pixel(32,32)),[137,0,225]);results.push({case:'linear numeric mask and real straight-alpha source premultiplication'});
  await select(fit);near(await page.evaluate(()=>pixel(8,8)),[0,0,0]);near(await page.evaluate(()=>pixel(8,32)),[255,0,0]);near(await page.evaluate(()=>pixel(56,32)),[0,255,0]);results.push({case:'decoded dimensions contain-fit without canvas refit'});
  await select(text);const textPixels=await page.evaluate(()=>({pixels:snapshot(),fonts:document.fonts.size}));assert.ok(textPixels.pixels.some((value,index)=>index%4!==3&&value>200));assert.equal(textPixels.fonts,1);results.push({case:'actual prepared FontFace and text pixels'});
  await select(particles);const first=await page.evaluate(()=>{host.frame({sceneTime:.5,paused:true});return snapshot();});
  await page.evaluate(()=>host.frame({sceneTime:1.4,paused:true}));const backwards=await page.evaluate(()=>{host.frame({sceneTime:.5,paused:true});return snapshot();});assert.deepEqual(backwards,first);assert.ok(first.some((value,index)=>index%4!==3&&value>0));results.push({case:'preallocated particles absolute phase and reverse seek'});
  await select(video);try{await page.waitForFunction(()=>host.frame({sceneTime:.1,paused:true,seek:true}),null,{timeout:8000});}
  catch(error){console.error(JSON.stringify(await page.evaluate(()=>host.stats())));throw error;}
  const videoStats=await page.evaluate(()=>({stats:host.stats(),ledger:ledger.snapshot(),fonts:document.fonts.size,pixels:snapshot()}));assert.equal(videoStats.ledger.held.decoderLeases,1);assert.equal(videoStats.fonts,0);assert.ok(videoStats.pixels.some((value,index)=>index%4!==3&&value>0));results.push({case:'actual silent video texture, seek completion and obsolete font exit',videoStats});
  // A decoded sparse frame may report an earlier timestamp. Keep the real
  // decoder/texture, controlling only that timestamp and counting seek requests.
  await page.evaluate(()=>{
    const video=observedVideos.find(video=>video.getAttribute('src')),native=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime');
    window.sparseVideo=video;window.sparseSeeks=0;
    Object.defineProperty(video,'currentTime',{configurable:true,get:()=>0,set:value=>{sparseSeeks++;native.set.call(video,value);}});
  });
  await page.waitForFunction(()=>host.frame({sceneTime:.19,paused:false}));
  const sparseCompleted=await page.evaluate(()=>{
    const completed=host.stats().sceneStats.videoClocks[0],requests=sparseSeeks;
    for(let repeat=0;repeat<8;repeat++)if(!host.frame({sceneTime:.19,paused:true,seek:true}))throw new Error('same sparse completed phase must stay ready');
    const after=host.stats().sceneStats.videoClocks[0];delete sparseVideo.currentTime;
    return {completed,after,requests,afterRequests:sparseSeeks};
  });
  assert.equal(sparseCompleted.requests,1);assert.equal(sparseCompleted.afterRequests,1);assert.equal(sparseCompleted.completed.seekPending,false);
  assert.equal(sparseCompleted.completed.requestedTime,.19);assert.equal(sparseCompleted.completed.currentTime,0);
  results.push({case:'completed sparse running seek submits once and repeated explicit fixed-phase requests do not seek again',sparseCompleted});
  await select(alpha);assert.equal(await page.evaluate(()=>ledger.snapshot().held.decoderLeases),0);
  async function commit(compiled){return page.evaluate(async p=>{const result=await host.selectComposition(p);host.frame({sceneTime:0,paused:true});return {result,stats:host.stats().sceneStats,ledger:ledger.snapshot()};},projection(compiled));}
  await select(dirtyFixture);
  const same=await page.evaluate(async p=>{const before={work:host.stats().sceneStats.work,ledger:ledger.snapshot()};const result=await host.selectComposition(p);host.frame({sceneTime:0,paused:true});return {before,result,after:{work:host.stats().sceneStats.work,ledger:ledger.snapshot()}};},projection(publicValues(dirtyFixture,{})));
  assert.equal(same.result.changed,false);assert.deepEqual(same.after,same.before);results.push({case:'same trusted final projection causes zero dirty work, reservations and draws',same});
  let before=await page.evaluate(()=>host.stats().sceneStats.work), moved=await commit(movedDirty);
  assert.equal(moved.result.changed,true);assert.deepEqual(moved.result.dirtyNodes.map(mask=>!!mask),[false,true,true,false,false]);
  assert.deepEqual(moved.stats.work.matrixUpdates.map((value,index)=>value-before.matrixUpdates[index]),[0,0,1,0,0]);
  assert.deepEqual(moved.stats.work.worldMatrixUpdates.map((value,index)=>value-before.worldMatrixUpdates[index]),[0,1,1,0,0]);
  near(await page.evaluate(()=>pixel(10,10)),[0,0,255]);near(await page.evaluate(()=>pixel(26,10)),[255,0,0]);results.push({case:'compiled parent matrix dependents update only the affected branch',moved});
  const changedResource=await commit(resourceDirty);assert.deepEqual(changedResource.result.dirtyNodes.map(mask=>!!mask),[false,true,false,false,false]);
  assert.equal(changedResource.result.resourceChanges,1);near(await page.evaluate(()=>pixel(26,10)),[188,0,188]);near(await page.evaluate(()=>pixel(56,56)),[0,255,0]);
  results.push({case:'fixed resource users dirty only the actual image leaf and output',changedResource});
  before=await page.evaluate(()=>host.stats().sceneStats.work);const changedText=await commit(textDirty);
  assert.deepEqual(changedText.stats.work.nodeRebuilds.map((value,index)=>value-before.nodeRebuilds[index]),[0,0,0,0,1]);
  const textHeld=changedText.ledger.held;assert.equal(textHeld.canvases,1);results.push({case:'compiled constant dependency replaces only the prepared text raster',changedText});
  const hidden=await commit(hiddenDirty);assert.ok(hidden.result.dirtyNodes[1]&8);assert.ok(hidden.result.dirtyNodes[2]&8);
  near(await page.evaluate(()=>pixel(10,10)),[0,0,255]);results.push({case:'compiled inherited visibility updates actual children',hidden});
  await commit(textDirty);
  const refusedDelta=await page.evaluate(async p=>{const before={held:ledger.snapshot().held,work:host.stats().sceneStats.work},src=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');let loads=0,error;
    Object.defineProperty(HTMLImageElement.prototype,'src',{...src,set(value){if(value)loads++;return src.set.call(this,value);}});
    window.reservationCalls=0;window.reservationFailure=3;
    try{await host.selectComposition(p);}catch(reason){error=reason.message;}finally{window.reservationFailure=0;Object.defineProperty(HTMLImageElement.prototype,'src',src);}
    return {before,error,loads,after:{held:ledger.snapshot().held,work:host.stats().sceneStats.work}};
  },projection(badDirty));
  assert.match(refusedDelta.error,/delta-refusal/);assert.equal(refusedDelta.loads,0);assert.deepEqual(refusedDelta.after,refusedDelta.before);
  results.push({case:'partial incremental require refusal precedes every new source load and restores its original quota',refusedDelta});
  const badProjection=projection(badDirty);badProjection.resolvedAssets=badProjection.resolvedAssets.map(asset=>asset.assetId==='wide'?{...asset,url:'http://composition.test/broken.png'}:asset);
  const badResult=await page.evaluate(async p=>{const before={work:host.stats().sceneStats.work,held:ledger.snapshot().held};let error;
    try{await host.selectComposition(p);}catch(reason){error=reason.message;}return {before,error,after:{work:host.stats().sceneStats.work,held:ledger.snapshot().held},state:host.stats().state};},badProjection);
  assert.match(badResult.error,/composition-media-decode-failed/);assert.equal(badResult.state,'ready');assert.deepEqual(badResult.after,badResult.before);
  near(await page.evaluate(()=>pixel(26,10)),[188,0,188]);results.push({case:'bad image after complete delta reservations rolls back partial text/media preparation',badResult});
  const partial=await page.evaluate(async p=>{const before=ledger.snapshot().held,original=document.createElement.bind(document);let error;
    document.createElement=function(tag,...args){const el=original(tag,...args);if(tag==='canvas')el.getContext=()=>null;return el;};
    try{await host.selectComposition(p);}catch(reason){error=reason.message;}finally{document.createElement=original;}return {error,before,after:ledger.snapshot().held};},projection(badDirty));
  assert.match(partial.error,/composition-text-canvas-unavailable/);assert.deepEqual(partial.after,partial.before);results.push({case:'partial node initialization releases the newly decoded image and unused raster/buffer tickets',partial});
  const delayed=projection(badDirty);delayed.resolvedAssets=delayed.resolvedAssets.map(asset=>asset.assetId==='wide'?{...asset,url:'http://composition.test/delayed.png'}:asset);
  await page.evaluate(p=>{window.pendingProjection=host.selectComposition(p).then(()=>({ok:true}),error=>({ok:false,error:error.name}));},delayed);
  for(let attempt=0;!delayedRoute&&attempt<500;attempt++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(delayedRoute);
  const cancelled=await page.evaluate(async()=>{host.cancelPreparation();const result=await pendingProjection;return {result,state:host.stats().state,held:ledger.snapshot().held,pending:host.stats().sceneStats.preparationPending};});
  await delayedRoute.fulfill({body:sourceAssets.find(asset=>asset.assetId==='wide').bytes,contentType:'image/png'}).catch(()=>{});delayedRoute=null;
  assert.equal(cancelled.result.ok,false);assert.equal(cancelled.result.error,'AbortError');assert.equal(cancelled.state,'ready');assert.equal(cancelled.pending,false);assert.deepEqual(cancelled.held,partial.before);
  results.push({case:'last-consumer cancellation and late real image response cannot replace the committed scene',cancelled});
  await page.evaluate(p=>{window.pendingProjection=host.selectComposition(p).then(()=>({ok:true}),error=>({ok:false,error:error.name}));},delayed);
  for(let attempt=0;!delayedRoute&&attempt<500;attempt++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(delayedRoute);
  const hiddenCancellation=await page.evaluate(async()=>{Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'));
    const result=await pendingProjection;delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));return {result,state:host.stats().state,held:ledger.snapshot().held};});
  await delayedRoute.fulfill({body:sourceAssets.find(asset=>asset.assetId==='wide').bytes,contentType:'image/png'}).catch(()=>{});delayedRoute=null;
  assert.equal(hiddenCancellation.result.error,'AbortError');assert.equal(hiddenCancellation.state,'ready');assert.deepEqual(hiddenCancellation.held,partial.before);
  results.push({case:'hidden lifecycle cancels pending incremental resource work and preserves the last complete image',hiddenCancellation});
  await select(particleDirty);
  const geometry=[];for(let index=0;index<8;index++){
    const changed=await commit(publicValues(particleDirty,{count:32+index,seed:19+index}));
    assert.equal(changed.ledger.held.bufferDeclaredBytes,92+(32+index)*20);assert.equal(changed.ledger.held.programs,2);geometry.push({count:32+index,held:changed.ledger.held});
  }results.push({case:'changed absolute particle geometry retires only the old node scope without quota growth',geometry});
  await select(sharedVideo);await page.waitForFunction(()=>host.frame({sceneTime:.15,paused:true,seek:true}));
  assert.equal(await page.evaluate(()=>ledger.snapshot().held.decoderLeases),2);
  // Completion belongs to the whole output, including two independent sparse
  // clocks. A ready member must neither consume its proof nor start playback
  // while another member still waits; either completion order must work.
  await page.evaluate(()=>{
    window.multiVideos=observedVideos.filter(video=>video.getAttribute('src'));window.multiDelays=[false,false];
    window.multiSeeks=[0,0];window.multiEvents=[0,0];window.multiPlays=[0,0];window.multiOriginalPlay=[];
    const time=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime'),seeking=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'seeking');
    multiVideos.forEach((video,index)=>{
      video.addEventListener('seeked',()=>multiEvents[index]++);multiOriginalPlay[index]=video.play.bind(video);
      video.play=function(){multiPlays[index]++;return multiOriginalPlay[index]();};
      Object.defineProperty(video,'currentTime',{configurable:true,get:()=>0,set:value=>{multiSeeks[index]++;time.set.call(video,value);}});
      Object.defineProperty(video,'seeking',{configurable:true,get:()=>multiDelays[index]||seeking.get.call(video)});
    });
  });
  const multiSparse=[];
  for(const delayed of [1,0]){
    await page.waitForFunction(()=>host.frame({sceneTime:0,paused:true,seek:true}));
    await page.evaluate(()=>{multiSeeks.fill(0);multiEvents.fill(0);multiPlays.fill(0);});
    assert.equal(await page.evaluate(index=>{const submitted=host.frame({sceneTime:.19,paused:false});multiDelays[index]=true;return submitted;},delayed),false);
    await page.waitForFunction(()=>multiEvents.every((count,index)=>count>=multiSeeks[index]));
    const blocked=await page.evaluate(()=>{
      const attempts=[];for(let repeat=0;repeat<3;repeat++)attempts.push(host.frame({sceneTime:.19,paused:false}));
      return {attempts,seeks:[...multiSeeks],plays:[...multiPlays],stats:host.stats().sceneStats};
    });
    assert.deepEqual(blocked.attempts,[false,false,false]);assert.deepEqual(blocked.seeks,[1,1]);assert.deepEqual(blocked.plays,[0,0]);
    assert(blocked.stats.videoClocks.every(clock=>clock.seekPending&&clock.paused));
    const prepared=await page.evaluate(index=>{
      multiDelays[index]=false;host.pauseComposition(.19);
      return {stats:host.stats().sceneStats,seeks:[...multiSeeks],plays:[...multiPlays]};
    },delayed);
    assert.equal(prepared.stats.ready,true);assert(prepared.stats.videoClocks.every(clock=>clock.seekPending&&clock.paused));
    assert.deepEqual(prepared.plays,[0,0],'update-only completion cannot start drive before output');
    const submitted=await page.evaluate(()=>{
      const draw=gl.drawElements;let duringOutput=null;
      gl.drawElements=function(...args){const result=draw.apply(this,args);if(!this.getParameter(this.FRAMEBUFFER_BINDING))duringOutput={clocks:host.stats().sceneStats.videoClocks,plays:[...multiPlays]};return result;};
      let submitted;try{submitted=host.frame({sceneTime:.19,paused:false});}finally{gl.drawElements=draw;}
      return {submitted,duringOutput,stats:host.stats().sceneStats,seeks:[...multiSeeks],plays:[...multiPlays]};
    });
    assert.equal(submitted.submitted,true);assert.deepEqual(submitted.seeks,[1,1]);assert.deepEqual(submitted.plays,[1,1]);
    assert(submitted.duringOutput.clocks.every(clock=>clock.seekPending&&clock.paused));assert.deepEqual(submitted.duringOutput.plays,[0,0]);
    assert(submitted.stats.videoClocks.every(clock=>!clock.seekPending&&!clock.paused));
    const retained=await page.evaluate(()=>{
      const renders=host.stats().sceneStats.work.renders;for(let repeat=0;repeat<8;repeat++)if(!host.frame({sceneTime:.19,paused:true,seek:true}))throw new Error('same completed cohort phase must retain output');
      return {renders,afterRenders:host.stats().sceneStats.work.renders,seeks:[...multiSeeks],stats:host.stats().sceneStats};
    });
    assert.equal(retained.afterRenders,retained.renders);assert.deepEqual(retained.seeks,[1,1]);
    multiSparse.push({delayed,blocked,prepared,submitted,retained});
  }
  await page.evaluate(()=>multiVideos.forEach((video,index)=>{delete video.currentTime;delete video.seeking;video.play=multiOriginalPlay[index];}));
  results.push({case:'independent sparse clocks retain completion and pause the whole cohort until actual output commits in either completion order',multiSparse});
  // Two layers share the .2s clock; the .3s clock must keep its own completion.
  await page.waitForFunction(()=>host.frame({sceneTime:0,paused:true,seek:true}));
  await page.evaluate(()=>Promise.all(observedVideos.filter(video=>video.getAttribute('src')).map(video=>new Promise(resolve=>{
    video.addEventListener('seeked',resolve,{once:true});video.currentTime=.22;
  }))));
  const wrappedShared=await page.evaluate(()=>({submitted:host.frame({sceneTime:.22,paused:false}),stats:host.stats().sceneStats,decoders:ledger.snapshot().held.decoderLeases}));
  assert.equal(wrappedShared.submitted,false);assert.equal(wrappedShared.decoders,2);
  // Runtime statistics follow asynchronous resource completion, so bind each
  // clock to its distinct absolute request rather than its array position.
  const clockAtRequest=(clocks,time)=>{const matches=clocks.filter(clock=>Math.abs(clock.requestedTime-time)<1e-9);assert.equal(matches.length,1,'one decoder for the exact requested phase');return matches[0];};
  const wrappingClock=clockAtRequest(wrappedShared.stats.videoClocks,.02),alignedClock=clockAtRequest(wrappedShared.stats.videoClocks,0);
  assert.equal(wrappingClock.seekPending,true);assert.equal(alignedClock.seekPending,false);assert(Math.abs(alignedClock.currentTime-.22)<.003);
  await page.waitForFunction(()=>{
    const submitted=host.frame({sceneTime:.22,paused:false});
    if(submitted)window.completedWrapClocks=host.stats().sceneStats.videoClocks;
    return submitted;
  });
  const wrapCompleted=await page.evaluate(()=>completedWrapClocks);
  assert.deepEqual(wrapCompleted.map(clock=>clock.seekPending),[false,false]);
  assert(Math.abs(clockAtRequest(wrapCompleted,.02).currentTime-.02)<.003);assert.equal(clockAtRequest(wrapCompleted,0).requestedTime,0);
  results.push({case:'normal small wrap corrects stale target once for a shared two-layer decoder while the independent clock stays aligned',wrappedShared,wrapCompleted});
  const split=await page.evaluate(async p=>{const result=await host.selectComposition(p);return {result,decoders:ledger.snapshot().held.decoderLeases};},projection(independentVideo));
  assert.equal(split.decoders,3);assert.deepEqual(split.result.dirtyNodes.map(mask=>!!mask),[true,false,false]);
  await page.waitForFunction(()=>host.frame({sceneTime:.15,paused:true,seek:true}));
  const clocks=await page.evaluate(()=>host.stats().sceneStats.videoClocks);assert.deepEqual(clocks.map(clock=>Number(clock.requestedTime.toFixed(3))).sort(),[.05,.15,.15]);
  const rejoined=await page.evaluate(async p=>{const held=observedVideos.at(-3),calls=held.testPauseCalls;await host.selectComposition(p);return {pauseBefore:calls,pauseAfter:held.testPauseCalls,decoders:ledger.snapshot().held.decoderLeases,silent:observedVideos.every(video=>video.muted&&video.volume===0)};},projection(sharedVideo));
  assert.equal(rejoined.decoders,2);assert.equal(rejoined.pauseAfter,rejoined.pauseBefore);assert.equal(rejoined.silent,true);
  results.push({case:'real matching video clocks share a decoder while independent loop domains split and rejoin leases',split,clocks,rejoined});
  const pausedWithoutSubmit=await page.evaluate(async()=>{
    const live=observedVideos.filter(video=>video.getAttribute('src'));await Promise.all(live.map(video=>video.play()));
    const playingBefore=live.map(video=>!video.paused),before=host.stats(),heldBefore=ledger.snapshot().held;
    const read=()=>{const bytes=new Uint8Array(64*64*4);gl.readPixels(0,0,64,64,gl.RGBA,gl.UNSIGNED_BYTE,bytes);return bytes;},pixelsBefore=read();
    let glCalls=0,schedules=0;const originals=new Map();
    for(const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced','texImage2D','texSubImage2D','texStorage2D']){
      const original=gl[name];originals.set(name,original);gl[name]=function(...args){glCalls++;return original.apply(this,args);};
    }
    const requestFrame=window.requestAnimationFrame;window.requestAnimationFrame=function(...args){schedules++;return requestFrame.apply(this,args);};
    let accepted;try{accepted=host.pauseComposition(.031);}finally{for(const [name,original] of originals)gl[name]=original;window.requestAnimationFrame=requestFrame;}
    const after=host.stats(),pixelsAfter=read();
    return {accepted,playingBefore,pausedAfter:live.map(video=>video.paused),glCalls,schedules,
      before:{state:before.state,firstSubmit:before.firstSubmit,frameCount:before.frameCount,renders:before.sceneStats.work.renders,held:heldBefore},
      after:{state:after.state,firstSubmit:after.firstSubmit,frameCount:after.frameCount,renders:after.sceneStats.work.renders,held:ledger.snapshot().held},
      sceneTime:after.sceneStats.sceneTime,videoClocks:after.sceneStats.videoClocks,pixelsPreserved:pixelsBefore.every((value,index)=>value===pixelsAfter[index])};
  });
  assert.equal(pausedWithoutSubmit.accepted,true);assert.ok(pausedWithoutSubmit.playingBefore.every(Boolean));assert.ok(pausedWithoutSubmit.pausedAfter.every(Boolean));
  assert.equal(pausedWithoutSubmit.glCalls,0);assert.equal(pausedWithoutSubmit.schedules,0);assert.equal(pausedWithoutSubmit.before.firstSubmit,false);
  assert.deepEqual(pausedWithoutSubmit.after,pausedWithoutSubmit.before);assert.equal(pausedWithoutSubmit.sceneTime,.031);assert.equal(pausedWithoutSubmit.pixelsPreserved,true);
  assert.ok(pausedWithoutSubmit.videoClocks.every(clock=>Math.abs(clock.requestedTime-.031)<.001));
  results.push({case:'host pause immediately stops real video and samples absolute time without GL upload, draw, scheduler or first submission',pausedWithoutSubmit});
  const clipEvidence=await page.evaluate(async ({compiled,rotated,assets})=>{
    const originalGl=gl,evidence=[];
    for(const fit of ['contain','cover','stretch'])for(const image of [compiled,rotated]){
      const canvas=document.createElement('canvas');canvas.width=64;canvas.height=128;canvas.style.width='64px';canvas.style.height='128px';document.body.append(canvas);
      const clipped=SpaceStagePure.create(canvas,{qualityMode:'high',deviceTier:2,resources:port});const driver=canvas.getContext('webgl2');
      await clipped.selectComposition({...image,resolvedAssets:assets,sessionId:'clipping',generation:1,target:{width:64,height:128,fit,budgetFps:30,budgetAllocationRevision:1}});
      clipped.frame({sceneTime:0,paused:true});const pixelAt=(x,y)=>{const b=new Uint8Array(4);driver.readPixels(x,127-y,1,1,driver.RGBA,driver.UNSIGNED_BYTE,b);return Array.from(b);};
      evidence.push({fit,rotated:image===rotated,top:pixelAt(32,16),inside:pixelAt(32,64),bottom:pixelAt(32,112)});clipped.dispose();canvas.remove();
    }window.gl=originalGl;return evidence;
  },{compiled:clipping,rotated:clippingRotated,assets:resolved});
  for(const clip of clipEvidence){if(clip.fit==='contain'){near(clip.top,[0,0,0]);near(clip.bottom,[0,0,0]);}near(clip.inside,clip.rotated?[137,0,0]:[255,0,0]);}
  results.push({case:'author canvas clipping preserves contain bars and clips rotated masked leaves in the sole linear RT',clipEvidence});
  const completeRetirement=await page.evaluate(async ({before,after,assets})=>{
    const originalGl=gl,canvas=document.createElement('canvas');canvas.width=canvas.height=64;canvas.style.width=canvas.style.height='64px';document.body.append(canvas);
    const policy={...StageResourcePolicy,caps:{...StageResourcePolicy.caps,gpuContexts:1,drawingBufferPixels:4096,renderTargetDeclaredBytes:65536,
      programs:2,textureDeclaredBytes:768,bufferDeclaredBytes:368,ownedCpuBytes:368,decodeReservedBytes:768}};
    const ownLedger=StageResourceBudget.create(policy),limited=SpaceStagePure.create(canvas,{qualityMode:'low',deviceTier:2,compositionTarget:{width:64,height:64},resources:ownLedger.port('retirement','retirement')});
    const project=ir=>({...ir,resolvedAssets:assets,sessionId:'retirement',generation:1,target:{width:64,height:64,fit:'stretch',budgetFps:30,budgetAllocationRevision:1}});
    await limited.selectComposition(project(before));limited.frame({sceneTime:0,paused:true});const old=limited.stats().sceneStats;
    const initialPhysical=[canvas.width,canvas.height];limited.resize(32,48);const resizedPhysical=[canvas.width,canvas.height];
    await limited.selectComposition(project(after));limited.frame({sceneTime:0,paused:true});const next=limited.stats().sceneStats;
    const admitted=ownLedger.snapshot();limited.dispose();const ended=ownLedger.snapshot();canvas.remove();window.gl=originalGl;
    return {old,next,initialPhysical,resizedPhysical,admitted,ended};
  },{before:alpha,after:clipping,assets:resolved});
  assert.equal(completeRetirement.old.contextId,completeRetirement.next.contextId);assert.notEqual(completeRetirement.old.semanticKey,completeRetirement.next.semanticKey);
  assert.deepEqual(completeRetirement.initialPhysical,[64,64]);assert.deepEqual(completeRetirement.resizedPhysical,[64,64]);
  assert.equal(completeRetirement.admitted.violations.length,0);assert.ok(Object.values(completeRetirement.ended.held).every(value=>value===0));
  results.push({case:'new semantic IR forecasts and retires the complete old scope/pool/RT/program ownership under its exact original envelope',completeRetirement});
  await select(alpha);
  const denied=await page.evaluate(async compiled=>{const original=port.require;let calls=0,loads=0;
    const src=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');Object.defineProperty(HTMLImageElement.prototype,'src',{...src,set(value){if(value)loads++;return src.set.call(this,value);}});
    const refusing={...port,require(...args){calls++;if(calls===4)throw new Error('planned-refusal');return original(...args);}};
    const canvas=document.createElement('canvas');canvas.width=canvas.height=64;canvas.style.width=canvas.style.height='64px';document.body.append(canvas);
    const separate=SpaceStagePure.create(canvas,{qualityMode:'high',deviceTier:2,resources:refusing});let reason;
    calls=0;try{await separate.selectComposition(compiled);}catch(e){reason=e.message;}separate.dispose();Object.defineProperty(HTMLImageElement.prototype,'src',src);
    return {reason,loads,violations:ledger.snapshot().violations};
  },{...alpha,resolvedAssets:resolved,sessionId:'refusal',generation:1,target:{width:64,height:64,fit:'stretch',budgetFps:30,budgetAllocationRevision:1}});
  assert.match(denied.reason,/planned-refusal/);assert.equal(denied.loads,0);assert.equal(denied.violations.length,0);results.push({case:'partial reservation refuses before any loader begins',denied});
  async function prepareFailedFrame(){await page.evaluate(async compiled=>{
    window.failureOriginalGl=gl;window.failureBefore=ledger.snapshot().held;
    window.failureCanvas=document.createElement('canvas');failureCanvas.width=failureCanvas.height=64;
    failureCanvas.style.width=failureCanvas.style.height='64px';document.body.append(failureCanvas);
    const start=observedVideos.length;
    window.failureOnReady=null;
    window.failureHost=SpaceStagePure.create(failureCanvas,{qualityMode:'high',deviceTier:2,resources:port,onStatus(value){if(value.state==='ready')failureOnReady?.();}});
    await failureHost.selectComposition(compiled);
    window.failureVideos=observedVideos.slice(start);window.failureSeeks=[0,0];window.failureEvents=[0,0];window.failurePlays=[0,0];window.failurePlaySnapshots=[];
    const time=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime');
    failureVideos.forEach((video,index)=>{
      const play=video.play.bind(video);video.play=function(){failurePlays[index]++;failurePlaySnapshots.push({index,clocks:failureHost.stats().sceneStats.videoClocks});return play();};
      video.addEventListener('seeked',()=>failureEvents[index]++);
      Object.defineProperty(video,'currentTime',{configurable:true,get:()=>0,set:value=>{failureSeeks[index]++;time.set.call(video,value);}});
    });
    if(failureHost.frame({sceneTime:.19,paused:false}))throw new Error('new sparse phase must wait for actual decoder completion');
  },projection(sharedVideo));
  await page.waitForFunction(()=>failureEvents.every((count,index)=>count>=failureSeeks[index]));}
  await prepareFailedFrame();
  const failedOutput=await page.evaluate(()=>{
    const driver=failureCanvas.getContext('webgl2'),draw=driver.drawElements;let duringDraw=null;
    driver.drawElements=function(){duringDraw={clocks:failureHost.stats().sceneStats.videoClocks,plays:[...failurePlays]};throw new Error('controlled-output-submit-failure');};
    const submitted=failureHost.frame({sceneTime:.19,paused:false});driver.drawElements=draw;
    const failed=failureHost.stats();failureHost.dispose();failureCanvas.remove();window.gl=failureOriginalGl;
    return {submitted,duringDraw,plays:[...failurePlays],playSnapshots:[...failurePlaySnapshots],state:failed.state,error:failed.error,before:failureBefore,after:ledger.snapshot().held};
  });
  assert.equal(failedOutput.submitted,false);assert.equal(failedOutput.state,'failed');assert.match(failedOutput.error,/controlled-output-submit-failure/);
  assert(failedOutput.duringDraw.clocks.every(clock=>clock.seekPending&&clock.paused));assert.deepEqual(failedOutput.duringDraw.plays,[0,0]);
  assert.deepEqual(failedOutput.plays,[0,0]);assert.deepEqual(failedOutput.playSnapshots,[]);
  assert.deepEqual(failedOutput.after,failedOutput.before);
  results.push({case:'failed real output does not consume prepared media completion or start drive and retires its full scope',failedOutput});
  await prepareFailedFrame();const shaderErrorStart=consoleErrors.length;
  const failedShader=await page.evaluate(()=>{
    const driver=failureCanvas.getContext('webgl2'),source=driver.shaderSource;let injected=0,atOutputShader=null;
    driver.shaderSource=function(shader,text){if(text.includes('uniform sampler2D inputMap')){injected++;atOutputShader={clocks:failureHost.stats().sceneStats.videoClocks,plays:[...failurePlays]};text+='\nTHIS_IS_A_REAL_INVALID_FRAGMENT_SHADER_TOKEN\n';}return source.call(this,shader,text);};
    let submitted;try{submitted=failureHost.frame({sceneTime:.19,paused:false});}finally{driver.shaderSource=source;}
    const failed=failureHost.stats();failureHost.dispose();failureCanvas.remove();window.gl=failureOriginalGl;
    return {submitted,injected,atOutputShader,plays:[...failurePlays],playSnapshots:[...failurePlaySnapshots],state:failed.state,error:failed.error,before:failureBefore,after:ledger.snapshot().held};
  });
  failedShader.consoleErrors=consoleErrors.slice(shaderErrorStart);
  assert.equal(failedShader.injected,1);assert.equal(failedShader.submitted,false);assert.equal(failedShader.state,'failed');assert.match(failedShader.error,/Three shader program failed/);
  assert(failedShader.atOutputShader.clocks.every(clock=>clock.seekPending&&clock.paused));assert.deepEqual(failedShader.plays,[0,0]);assert.deepEqual(failedShader.playSnapshots,[]);
  assert(failedShader.consoleErrors.some(text=>/Shader Error/.test(text)&&/INVALID_FRAGMENT_SHADER_TOKEN/.test(text)),'real Three program compilation reports the invalid final output shader');
  assert.deepEqual(failedShader.after,failedShader.before);
  results.push({case:'real final output shader link failure rejected by original Three diagnostics cannot commit media',failedShader});
  await prepareFailedFrame();
  await page.evaluate(async()=>{
    SpaceStagePure.register({apiVersion:1,id:'commit-boundary-lyrics',stateVersion:1,label:'Commit boundary lyric fixture',category:'lyrics',preview:'/commit-boundary-lyrics.png',camera:{radius:15,fov:58},capabilities:{ownsLyrics:true},quality:{},
      create(context){window.failureLyricRenderer=context.renderer;window.failureLyricScene=context.scene;return {update(){},dispose(){}};}});
    await failureHost.selectLyrics('commit-boundary-lyrics');
  });
  const failedLyrics=await page.evaluate(()=>{
    const renderer=failureLyricRenderer,render=renderer.render;let duringLyrics=null;
    renderer.render=function(scene,...args){if(scene===failureLyricScene){duringLyrics={clocks:failureHost.stats().sceneStats.videoClocks,plays:[...failurePlays],renders:failureHost.stats().sceneStats.work.renders};throw new Error('controlled-later-lyric-output-failure');}return render.call(this,scene,...args);};
    let submitted;try{submitted=failureHost.frame({sceneTime:.19,paused:false,lyrics:{lines:[{text:'fixture'}]}});}finally{renderer.render=render;}
    const failed=failureHost.stats();failureHost.dispose();failureCanvas.remove();window.gl=failureOriginalGl;
    return {submitted,duringLyrics,plays:[...failurePlays],playSnapshots:[...failurePlaySnapshots],state:failed.state,error:failed.error,before:failureBefore,after:ledger.snapshot().held};
  });
  assert.equal(failedLyrics.submitted,false);assert.equal(failedLyrics.state,'failed');assert.match(failedLyrics.error,/controlled-later-lyric-output-failure/);assert.equal(failedLyrics.duringLyrics.renders,1);
  assert(failedLyrics.duringLyrics.clocks.every(clock=>clock.seekPending&&clock.paused));assert.deepEqual(failedLyrics.duringLyrics.plays,[0,0]);assert.deepEqual(failedLyrics.plays,[0,0]);assert.deepEqual(failedLyrics.playSnapshots,[]);
  assert.deepEqual(failedLyrics.after,failedLyrics.before);
  results.push({case:'later lyric render throw after actual composition output leaves the entire media cohort uncommitted',failedLyrics});
  const callbackFences=[];
  for(const throwAfterSelect of [false,true]){
    await prepareFailedFrame();
    const fenced=await page.evaluate(async({compiled,throwAfterSelect})=>{
      let duringCallback=null;
      failureOnReady=()=>{failureOnReady=null;duringCallback={clocks:failureHost.stats().sceneStats.videoClocks,plays:[...failurePlays]};window.failureReplacement=failureHost.selectComposition(compiled);if(throwAfterSelect)throw new Error('controlled-old-frame-status-failure');};
      const submitted=failureHost.frame({sceneTime:.19,paused:false}),replacementBefore=failureHost.stats();await failureReplacement;
      const replacementPrepared=failureHost.stats(),replacementSubmitted=failureHost.frame({sceneTime:0,paused:true}),replacementAfter=failureHost.stats();
      failureHost.dispose();failureCanvas.remove();window.gl=failureOriginalGl;
      return {throwAfterSelect,submitted,duringCallback,plays:[...failurePlays],playSnapshots:[...failurePlaySnapshots],replacementBefore:{state:replacementBefore.state,firstSubmit:replacementBefore.firstSubmit,error:replacementBefore.error},replacementPrepared:{state:replacementPrepared.state,firstSubmit:replacementPrepared.firstSubmit,error:replacementPrepared.error},replacementSubmitted,replacementAfter:{state:replacementAfter.state,firstSubmit:replacementAfter.firstSubmit,error:replacementAfter.error},before:failureBefore,after:ledger.snapshot().held};
    },{compiled:{...projection(alpha),sessionId:'replacement-callback'},throwAfterSelect});
    assert.equal(fenced.submitted,false);assert(fenced.duringCallback.clocks.every(clock=>clock.seekPending&&clock.paused));assert.deepEqual(fenced.duringCallback.plays,[0,0]);assert.deepEqual(fenced.plays,[0,0]);assert.deepEqual(fenced.playSnapshots,[]);
    assert.deepEqual(fenced.replacementBefore,{state:'loading',firstSubmit:false,error:''});assert.deepEqual(fenced.replacementPrepared,{state:'preparing',firstSubmit:false,error:''});assert.equal(fenced.replacementSubmitted,true);assert.deepEqual(fenced.replacementAfter,{state:'ready',firstSubmit:true,error:''});assert.deepEqual(fenced.after,fenced.before);
    callbackFences.push(fenced);
  }
  results.push({case:'synchronous successful-status selection and old-frame throw cannot commit or fail the replacement instance',callbackFences});
  const poolEvidence=await page.evaluate(async()=>{
    const {createResourcePool}=await import('/src/resources/pool.js'), pool=createResourcePool({contextId:'browser',maxEntries:2});
    let resolve,releases=0,loads=0,signal;const identity={contentKey:'same',decodeOptions:{b:2,a:1},adapterId:'test',adapterVersion:1};
    const spec={load:o=>{loads++;signal=o.signal;return new Promise(r=>resolve=r);},releaseValue(){releases++;}};
    const a=pool.acquire(identity,spec), b=pool.acquire({...identity,decodeOptions:{a:1,b:2}},spec);let rejected=false;
    const waiting=a.ready.catch(()=>{rejected=true;});await Promise.resolve();a.release();await waiting;const stillAlive=!signal.aborted;
    resolve({});await b.ready;const cached=pool.acquire(identity,spec);await cached.ready;b.release();cached.release();
    let lateResolve;const late=pool.acquire(identity,{...spec,load:()=>new Promise(r=>lateResolve=r)});await Promise.resolve();late.release();lateResolve({});
    await new Promise(r=>setTimeout(r,0));
    let attempts=0;const retry=pool.acquire(identity,{...spec,load:()=>{attempts++;if(attempts===1)throw new Error('once');return {};}});await retry.ready.catch(()=>{});
    pool.retry();await retry.ready;const recovered=pool.acquire(identity,{...spec});await recovered.ready;retry.release();recovered.release();pool.dispose();
    return {loads,releases,stillAlive,rejected,attempts,stats:pool.stats()};
  });
  assert.equal(poolEvidence.loads,1);assert.equal(poolEvidence.stillAlive,true);assert.equal(poolEvidence.rejected,true);assert.equal(poolEvidence.attempts,2);assert.equal(poolEvidence.releases,3);assert.deepEqual(poolEvidence.stats,{poolEntries:0,poolPending:0,poolLeases:0});results.push({case:'independent cancellation, canonical decode identity, late retirement, retry',poolEvidence});
  const scopeOwnership=await page.evaluate(async()=>{
    const {createResourcePool}=await import('/src/resources/pool.js'), {createScope}=await import('/src/scope.js');
    const pool=createResourcePool({contextId:'scope-ownership'}), a=createScope(), b=createScope();let textureDisposals=0,materialDisposals=0;
    const texture=pool.markOwned({isTexture:true,dispose(){textureDisposals++;}}),identity={contentKey:'shared',decodeOptions:{},adapterId:'scope-test',adapterVersion:1};
    const spec={load:()=>texture,releaseValue(value){value.dispose();}},leaseA=a.lease(pool.acquire(identity,{...spec,signal:a.signal})),leaseB=b.lease(pool.acquire(identity,{...spec,signal:b.signal}));
    await Promise.all([leaseA.ready,leaseB.ready]);
    const tree=()=>({traverse(fn){fn({material:{map:texture,uniforms:{map:{value:texture}},dispose(){materialDisposals++;}}});}});
    a.track(texture);a.trackTree(tree());a.dispose();a.dispose();leaseA.release();
    const survivor={textureDisposals,materialDisposals,usable:leaseB.value===texture,stats:pool.stats()};
    a.track(texture);const afterDisposedTrack=textureDisposals;
    b.track(texture);b.trackTree(tree());b.dispose();b.dispose();leaseB.release();pool.dispose();pool.dispose();
    return {survivor,afterDisposedTrack,textureDisposals,materialDisposals,stats:pool.stats()};
  });
  assert.equal(scopeOwnership.survivor.textureDisposals,0);assert.equal(scopeOwnership.survivor.materialDisposals,1);assert.equal(scopeOwnership.survivor.usable,true);
  assert.deepEqual(scopeOwnership.survivor.stats,{poolEntries:1,poolPending:0,poolLeases:1});assert.equal(scopeOwnership.afterDisposedTrack,0);
  assert.equal(scopeOwnership.textureDisposals,1);assert.equal(scopeOwnership.materialDisposals,2);assert.deepEqual(scopeOwnership.stats,{poolEntries:0,poolPending:0,poolLeases:0});
  results.push({case:'direct and tree scope tracking retain a shared pool texture through the surviving consumer and retire it exactly once',scopeOwnership});
  const exit=await page.evaluate(()=>{host.dispose();return {ledger:ledger.snapshot(),fonts:document.fonts.size,stats:host.stats()};});
  assert.ok(Object.values(exit.ledger.held).every(value=>value===0));assert.equal(exit.fonts,0);assert.equal(exit.ledger.violations.length,0);assert.equal(exit.stats.state,'disposed');assert.deepEqual(errors,[]);
  results.push({case:'all resource API lifetimes retired',exit});
  await page.screenshot({path:path.join(output,'composition-final.png')});
  fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify({actualVideo,results,errors},null,2));
  console.log(`Composition browser: ${results.length} checks passed; actual Rust IR, shared bundle, media/font/GL pixels; evidence ${output}`);
 } finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
