// SPDX-License-Identifier: MIT
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),assets=path.join(root,'crates/hertz-desktop/assets');
const read=file=>fs.readFileSync(file,'utf8');
const html=read(path.join(assets,'wallpaper-scene.html'))
 .replace('__GL_BUDGET__',()=>read(path.join(assets,'wallpaper-gl-budget.js')))
 .replace('__RUNTIME__',()=>read(path.join(root,'plugin/ui/vendor/stage-runtime.js')))
 .replace('__SHIM__',()=>read(path.join(root,'plugin/ui/vendor/zodiac-stage.js')))
 .replace('__SCENE__',()=>read(path.join(assets,'wallpaper-scene.js')));
const output=path.join(root,'output/playwright/wallpaper-handoff-browser');
(async()=>{
 fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true,args:['--use-angle=swiftshader','--enable-webgl']});
 const checks=[];
 try{
  for(const kind of ['gl','image','video']){
   const page=await browser.newPage({viewport:{width:960,height:540}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
   await page.addInitScript(kind=>{
    window.receipts=[];window.ipc={postMessage:message=>receipts.push(message)};
    Object.defineProperty(window,'__hertzWallpaperBinding',{value:Object.freeze({sessionId:'1'.repeat(32),generation:7})});
    if(kind==='gl')Object.defineProperty(window,'__hertzWallpaperGlAllocation',{value:Object.freeze({generation:7,quality:'low',fps:30,refreshHz:60,pixelBudget:1900000,gpuBytes:64*1048576})});
   },kind);
   await page.route('http://frame.test/',route=>route.fulfill({contentType:'text/html',body:html}));
   await page.route('https://**.wallpaper.invalid/files/**',route=>route.fulfill({contentType:kind==='image'?'image/jpeg':'video/webm',body:fs.readFileSync(path.join(root,kind==='image'?'crates/hertz-desktop/assets/scene-thumbnails/coast.jpg':'scripts/fixtures/wallpaper-vp8.webm'))}));
   await page.goto('http://frame.test/');
   assert.equal(await page.evaluate(()=>hertzWallpaper.reveal()),false);
   await page.evaluate(kind=>{
    hertzWallpaper.applyConfig({source:'fixed',scene:'coast',brightness:.7,quality:'low'});
    if(kind!=='gl')hertzWallpaper.applyMedia({kind,url:'https://'+'a'.repeat(32)+'.'+'a'.repeat(32)+'.wallpaper.invalid/files/frame',fit:'contain'});
    hertzWallpaper.start(30);
   },kind);
   await page.waitForFunction(kind=>{const d=hertzWallpaper.debug();return kind==='gl'?d.draws>2:d.media?.state==='ready';},kind,{timeout:15000});
   const request={token:'2'.repeat(32),sessionId:'1'.repeat(32),generation:7,width:480,height:270};
   assert.equal(await page.evaluate(request=>hertzWallpaper.requestCapture({...request,generation:8}),request),false);
   assert.equal(await page.evaluate(request=>hertzWallpaper.requestCapture({...request,width:961}),request),false);
   assert.equal(await page.evaluate(request=>hertzWallpaper.requestCapture(request),request),true);
   await page.waitForFunction(()=>receipts.some(text=>text.startsWith('wallpaper_capture ')));
   const receipt=await page.evaluate(()=>JSON.parse(receipts.find(text=>text.startsWith('wallpaper_capture ')).slice(18)));
   assert.equal(receipt.error,undefined);assert.equal(receipt.token,request.token);
   const pixels=Buffer.from(receipt.rgba,'base64');assert.equal(pixels.length,480*270*4);
   const colors=new Set();for(let at=0;at<pixels.length;at+=4){assert.equal(pixels[at+3],255);colors.add(pixels.readUInt32LE(at));}
   assert.ok(colors.size>16,'actual captured frame is nonuniform');
   await page.evaluate(()=>hertzWallpaper.reveal());
   await page.waitForFunction(()=>receipts.some(text=>text.startsWith('wallpaper_session ')&&JSON.parse(text.slice(18)).event==='revealed'));
   assert.equal(await page.evaluate(()=>hertzWallpaper.debug().session.revealed),true);
   assert.deepEqual(errors,[]);
   checks.push({kind,colors:colors.size,rgbaBytes:pixels.length,sha256:crypto.createHash('sha256').update(pixels).digest('hex'),debug:await page.evaluate(()=>hertzWallpaper.debug())});
   await page.screenshot({path:path.join(output,kind+'.png')});await page.close();
  }
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({ok:true,checks},null,2));
  console.log('wallpaper handoff browser checks passed: real GL/image/video pixels, bounds, identity, and reveal receipt');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
