// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// Reproducible static references captured from the bundled desktop scene renderer.
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),assets=path.join(root,'crates/hertz-desktop/assets');
const read=file=>fs.readFileSync(file,'utf8');
const html=read(path.join(assets,'wallpaper-scene.html')).replace('__RUNTIME__',read(path.join(root,'plugin/ui/vendor/stage-runtime.js'))).replace('__SHIM__',read(path.join(root,'plugin/ui/vendor/zodiac-stage.js'))).replace('__SCENE__',read(path.join(assets,'wallpaper-scene.js')));
const scenes=[...read(path.join(root,'crates/hertz-desktop/src/config.rs')).matchAll(/^    \("([a-z-]+)", "([^"]+)"\),$/gm)].map(match=>match[1]);
async function main(){
 const output=path.join(assets,'scene-thumbnails');fs.mkdirSync(output,{recursive:true});
 const server=http.createServer((request,response)=>{response.setHeader('Content-Type','text/html; charset=utf-8');response.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true,args:['--use-angle=swiftshader','--enable-webgl']});
 try{
  const page=await browser.newPage({viewport:{width:640,height:360},deviceScaleFactor:1});
  for(const scene of scenes){
   await page.goto('http://127.0.0.1:'+server.address().port);
   await page.waitForFunction(()=>!!window.hertzWallpaper);
   await page.evaluate(scene=>{window.hertzWallpaper.applyConfig({source:'fixed',scene:scene,musicResponse:false});window.hertzWallpaper.start(30);},scene);
   await page.waitForSelector('canvas');await page.waitForTimeout(900);
   await page.locator('canvas').screenshot({path:path.join(output,scene+'.jpg'),type:'jpeg',quality:82});
   console.log(scene+' captured');
  }
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
