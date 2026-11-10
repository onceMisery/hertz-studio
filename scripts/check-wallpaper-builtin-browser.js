// SPDX-License-Identifier: MIT
// Original native projection with synthetic target facts; real browser/decoder pixels.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const {execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {loadCompositionFontFixture}=require('./composition-font-fixture.js');
const root=path.resolve(__dirname,'..'),output=path.join(root,'output/playwright/wallpaper-builtin');fs.mkdirSync(output,{recursive:true});
const hash=value=>createHash('sha256').update(value).digest('hex');
function crc(bytes){let c=0xffffffff;for(const byte of bytes){c^=byte;for(let n=0;n<8;n++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(type,bytes){const tag=Buffer.from(type),buffer=Buffer.alloc(bytes.length+12);buffer.writeUInt32BE(bytes.length);tag.copy(buffer,4);bytes.copy(buffer,8);buffer.writeUInt32BE(crc(Buffer.concat([tag,bytes])),bytes.length+8);return buffer;}
function png(){const header=Buffer.alloc(13);header.writeUInt32BE(4);header.writeUInt32BE(4,4);header[8]=8;header[9]=6;
  const bytes=Buffer.alloc(4*17);for(let y=0;y<4;y++)for(let x=0;x<4;x++)Buffer.from([255,0,0,255]).copy(bytes,y*17+1+x*4);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(bytes)),chunk('IEND',Buffer.alloc(0))]);}
const redFile=path.join(output,'red.png');fs.writeFileSync(redFile,png());
const font=loadCompositionFontFixture(),fontFiles=[{file:font.file,bytes:font.bytes,mime:'font/ttf'},...font.packageFiles].map(file=>{const destination=path.join(output,file.file);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,file.bytes);return{path:file.file,source:destination,mime:file.mime};});
const image={id:'red',kind:'image',source:'red.png',variants:[]},video={id:'movie',kind:'video',source:'movie.webm',variants:[]};
const videoFile=path.join(root,'scripts/fixtures/wallpaper-vp8.webm');
const background={id:'background',type:'builtinScene',stateVersion:1,properties:{sceneId:'spectrum-towers',stateVersion:1,params:{director:true,cue:'bridge',dust:.35,discRing:true}}};
const overlay={id:'overlay',type:'image',stateVersion:1,assets:{asset:'red'},properties:{x:0,y:0,width:256,height:128,anchorX:0,anchorY:0,opacity:.5,fit:'stretch'}};
const requests=[];
function fixture(key,width,height,fit,nodes,extraAssets=[],extraFiles=[]){requests.push({key,
  document:{documentVersion:1,canvas:{width:256,height:128,colorSpace:'srgb',background:'#000000'},nodes,
    timeline:{durationSeconds:2,loop:true,tracks:[]},bindings:[],effects:[]},assets:extraAssets,
  properties:[],overrides:{},files:extraFiles,nativeTarget:{width,height,deviceScale:1,fit}});}
for(const [width,height]of[[480,320],[240,320]])for(const fit of['contain','cover','stretch']){
  fixture(`base-${width}-${fit}`,width,height,fit,[background]);
  fixture(`overlay-${width}-${fit}`,width,height,fit,[background,overlay],[image],[{path:'red.png',source:redFile,mime:'image/png'}]);
}
fixture('video',480,320,'contain',[background,{id:'video',type:'video',stateVersion:1,assets:{asset:'movie'},properties:{x:128,y:0,width:128,height:64,anchorX:0,anchorY:0,loopStartMs:0,loopEndMs:200}},overlay],
  [image,video],[{path:'red.png',source:redFile,mime:'image/png'},{path:'movie.webm',source:videoFile,mime:'video/webm'}]);
fixture('text',480,320,'contain',[background,{id:'caption',type:'text',stateVersion:1,assets:{fontAsset:'font'},properties:{x:0,y:0,width:256,height:128,anchorX:0,anchorY:0,text:'Hertz',fontSize:40,color:'#ffffff'}}],
  [{id:'font',kind:'font',source:font.file,variants:[]}],fontFiles);
const input=path.join(output,'requests.json'),mappingFile=path.join(output,'native-projections.json');fs.writeFileSync(input,JSON.stringify(requests,null,2));
const exportProjection=!process.argv.includes('--projection-ready');
if(exportProjection)execFileSync('cargo',['+1.88.0','test','--locked','-p','hertz-desktop','--lib','--features','wallpaper-media-probe',
  'internal_browser_font_requests_export_original_prepared_projection_and_pins','--','--test-threads=1'],
  {cwd:root,stdio:'inherit',env:{...process.env,HERTZ_COMPOSITION_BROWSER_FONT_REQUESTS:input,HERTZ_COMPOSITION_BROWSER_FONT_OUTPUT:mappingFile}});
const mapping=JSON.parse(fs.readFileSync(mappingFile)),files=new Map();
for(const item of Object.values(mapping))for(const file of item.files){const bytes=fs.readFileSync(path.join(output,file.file));assert.equal(hash(bytes),file.entry.sha256);files.set(file.url,{bytes,mime:file.entry.mime});}
const results=[],errors=[];
(async()=>{const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{const page=await browser.newPage({viewport:{width:800,height:600},deviceScaleFactor:1});page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{const url=route.request().url(),file=files.get(url);if(file){
    const match=/^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range||'');
    if(match){const start=Number(match[1]),end=match[2]?Math.min(Number(match[2]),file.bytes.length-1):file.bytes.length-1;return route.fulfill({status:206,contentType:file.mime,headers:{'access-control-allow-origin':'*','accept-ranges':'bytes','content-range':`bytes ${start}-${end}/${file.bytes.length}`},body:file.bytes.subarray(start,end+1)});}
    return route.fulfill({contentType:file.mime,headers:{'access-control-allow-origin':'*'},body:file.bytes});}
    return route.fulfill({contentType:'text/html',body:'<body style="margin:0;background:black"><canvas></canvas></body>'});});
  await page.goto('http://127.0.0.1:41108/');await page.addScriptTag({path:path.join(root,'plugin/ui/stage-resource-budget.js')});
  await page.addScriptTag({path:path.join(root,'plugin/ui/stage-resource-policy.js')});await page.addScriptTag({path:path.join(root,'plugin/ui/vendor/stage-runtime.js')});
  await page.addScriptTag({path:path.join(root,'plugin/ui/vendor/space-stage.js')});
  await page.evaluate(()=>{const get=HTMLCanvasElement.prototype.getContext,seen=new WeakSet();window.contexts=0;
    HTMLCanvasElement.prototype.getContext=function(kind,...args){const ctx=get.call(this,kind,...args);if(ctx&&kind==='webgl2'&&!seen.has(ctx)){seen.add(ctx);contexts++;window.gl=ctx;}return ctx;};});
  async function select(key){const request=requests.find(value=>value.key===key),projection=mapping[key].projection;
    return page.evaluate(async({projection,native})=>{window.host?.dispose();const canvas=document.createElement('canvas');document.querySelector('canvas').replaceWith(canvas);canvas.width=projection.target.width;canvas.height=projection.target.height;canvas.style.width=native.width+'px';canvas.style.height=native.height+'px';
      window.ledger=StageResourceBudget.create(StageResourcePolicy);window.host=SpaceStagePure.create(canvas,{compositionTarget:projection.target,qualityMode:'low',resources:ledger.port('builtin','builtin-browser')});
      await host.selectComposition(projection);host.frame({sceneTime:.5,seek:true,paused:true,level:.35,bands:{bass:.5,mid:.4,treble:.2},spectrum:[10,90,140,40]});return host.stats();},
      {projection,native:request.nativeTarget});}
  async function pixel(x,y){return page.evaluate(({x,y})=>{host.frame({sceneTime:host.stats().sceneStats.sceneTime,paused:true,redraw:true});const value=new Uint8Array(4);gl.readPixels(x,gl.drawingBufferHeight-1-y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,value);return[...value];},{x,y});}
  async function snapshot(){return page.evaluate(async()=>{host.frame({sceneTime:host.stats().sceneStats.sceneTime,paused:true,redraw:true});const value=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,value);return[...new Uint8Array(await crypto.subtle.digest('SHA-256',value))].map(byte=>byte.toString(16).padStart(2,'0')).join('');});}
  const linear=value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4,encode=value=>255*(value<=.0031308?value*12.92:1.055*value**(1/2.4)-.055);
  for(const [width,height]of[[480,320],[240,320]])for(const fit of['contain','cover','stretch']){
    const key=`base-${width}-${fit}`,stats=await select(key);assert.equal(stats.state,'ready',JSON.stringify(stats));const projection=mapping[key].projection,W=projection.target.width,H=projection.target.height;
    const sx=fit==='stretch'?W/256:fit==='contain'?Math.min(W/256,H/128):Math.max(W/256,H/128),sy=fit==='stretch'?H/128:sx;
    // Choose a colored source pixel inside the independently computed author
    // clip. A black point cannot prove background/foreground composition.
    const {x,y}=await page.evaluate(({W,H,sx,sy})=>{host.frame({sceneTime:.5,paused:true,redraw:true});
      const bytes=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
      let best=-1,point=null;const left=(W-256*sx)/2,top=(H-128*sy)/2;
      for(let y=2;y<H-2;y++)for(let x=2;x<W-2;x++){
        if(x<left+2||x>left+256*sx-2||y<top+2||y>top+128*sy-2)continue;
        const i=((H-1-y)*W+x)*4,score=bytes[i+1]+bytes[i+2];
        // Saturated output loses the source HDR value before alpha mixing.
        if(bytes[i]<235&&bytes[i+1]<235&&bytes[i+2]<235&&score>best){best=score;point={x,y};}}
      if(best<30)throw new Error('No colored builtin pixel inside author clip');return point;},{W,H,sx,sy});
    const back=await pixel(x,y);await select(`overlay-${width}-${fit}`);const front=await pixel(x,y);
    for(let channel=0;channel<3;channel++)assert(Math.abs(front[channel]-encode(.5*linear(back[channel]/255)+(channel===0?.5:0)))<=5,JSON.stringify({fit,back,front}));
    if(fit==='contain')assert.deepEqual((await pixel(1,1)).slice(0,3),[0,0,0]);
    const before=await snapshot();await page.evaluate(()=>host.frame({sceneTime:1.3,paused:true,redraw:true,level:.99,spectrum:[255,255]}));assert.equal(await snapshot(),before);
    await page.screenshot({path:path.join(output,`${width}-${fit}.png`)});
    results.push({case:'fit and linear alpha over colored builtin with paused fixed input',width,height,fit,W,H,x,y,back,front,input:stats.sceneStats.builtin.input});
  }
  await select('text');assert.equal(await page.evaluate(()=>document.fonts.size),1);results.push({case:'same-package native-prepared font + builtin share output'});
  await select('video');await page.waitForFunction(()=>host.frame({sceneTime:.1,seek:true,paused:true,level:.5,spectrum:[30,90]}),null,{timeout:12000});
  assert.equal(await page.evaluate(()=>ledger.snapshot().held.decoderLeases),1);const first=await snapshot();
  await page.waitForFunction(()=>host.frame({sceneTime:1.2,seek:true,paused:true,level:.5,spectrum:[30,90]}));
  await page.waitForFunction(()=>host.frame({sceneTime:.1,seek:true,paused:true,level:.5,spectrum:[30,90]}));assert.equal(await snapshot(),first);
  results.push({case:'real video decoder with deterministic reverse seek',stats:await page.evaluate(()=>host.stats().sceneStats)});
  await select('base-480-contain');
  const fresh=new Map();
  for(const phase of [0,.001,.5,1.999,2,2.001,3.999]){
    await page.evaluate(phase=>host.frame({sceneTime:phase,seek:true,paused:true,level:.35,bands:{bass:.5,mid:.4,treble:.2},spectrum:[10,90,140,40]}),phase);
    fresh.set(phase,await snapshot());
  }
  for(const phase of [3.999,2.001,2,1.999,.5,.001,0]){
    await select('base-480-contain');
    await page.evaluate(phase=>host.frame({sceneTime:phase,seek:true,paused:true,level:.35,bands:{bass:.5,mid:.4,treble:.2},spectrum:[10,90,140,40]}),phase);
    assert.equal(await snapshot(),fresh.get(phase),'fresh/forward/reverse exact source pixels at '+phase);
  }
  assert.equal(fresh.get(0),fresh.get(2));assert.equal(fresh.get(.001),fresh.get(2.001));
  results.push({case:'real original factory fresh/forward/reverse and loop-boundary pixel matrix',pixels:Object.fromEntries(fresh)});
  const surface=await page.evaluate(()=>{const before=host.stats();host.resize(470,320,1);return {before,after:host.stats()};});
  assert.match(surface.after.resourceAdmissionFailure,/replan/);results.push({case:'CSS-only resize requires original native target replanning',surface});
  await select('video');
  const refusal=structuredClone(mapping.video.projection);refusal.builtinTarget.profile.sourceResources.cpuPeakBytes=1;
  const rejected=await page.evaluate(async projection=>{const before=ledger.snapshot();let error='';try{await host.selectComposition(projection);}catch(reason){error=reason.message;}return{error,before,after:ledger.snapshot()};},refusal);
  assert.match(rejected.error,/projection-mismatch/);assert.deepEqual(rejected.after.held,rejected.before.held);results.push({case:'forged source cost refuses before loading and preserves current scope'});
  const exit=await page.evaluate(()=>{host.dispose();return{ledger:ledger.snapshot(),stats:host.stats(),fonts:document.fonts.size};});
  assert(Object.values(exit.ledger.held).every(value=>value===0),JSON.stringify(exit));assert.equal(exit.fonts,0);assert.deepEqual(errors,[]);
  results.push({case:'context, decoder, font, source buffers and input banks retire',exit});
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({qualification:'synthetic-native-target-real-browser',nativeProjectionExportedInThisRun:exportProjection,
    projectionSha256:hash(fs.readFileSync(mappingFile)),sourceHashes:Object.fromEntries(['scripts/check-wallpaper-builtin-browser.js','plugin/ui/vendor/stage-runtime.js','plugin/ui/vendor/space-stage.js',
      'tools/space-stage/src/composition/builtin.js','tools/space-stage/src/composition/runtime.js','tools/space-stage/src/composition/plan.js'].map(file=>[file,hash(fs.readFileSync(path.join(root,file)))])),results,errors},null,2));
  console.log(`Builtin browser: ${results.length} checks passed; ${output}`);
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
