'use strict';
// Real CreativeStage source, Stage ledger, canvas capture and native MediaRecorder.
// The Stage3D delegation fixture does not qualify the immersive Stage3D owner.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=path.resolve(__dirname,'..'),web=path.join(root,'plugin/ui');
const sources=['stage-resource-budget.js','stage-resource-policy.js','stage-json-source.js','stage-image-source.js','stage.js','onset.js',
  'lyric3d.js','creative-gl.js','creative-anime.js','stage-media.js','bgwall.js','backgrounds.js','handdrawn.js','creative-stage.js','video-export.js'];
const digest=()=>Object.fromEntries(sources.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(web,file))).digest('hex')]));
const out=path.join(root,'output/a09-m1-20261108/export-browser-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(out,{recursive:true});
const report={startedAt:new Date().toISOString(),scope:'Native Chrome export from current CreativeStage; test-only CPU caps. Immersive owner, decoder workspace bounds, GPU/weak-device qualification and current embedded products remain open.',sourceSha256:digest(),checks:[],errors:[]};
let browser;
async function pageFor(cpu=768*1024*1024){
  const page=await browser.newPage({viewport:{width:1000,height:700},acceptDownloads:true});
  page.on('pageerror',error=>report.errors.push(error.stack));
  await page.route('**/*',route=>{
    if(route.request().url().includes('/v1/overlay/lyric')) return route.fulfill({json:{track_id:'m1-export',title:'Export contract',artist:'Hertz',lines:[{startTime:0,endTime:120,text:'资源交接与录制清理'}],playing:false,position_ms:1200}});
    return route.fulfill({contentType:'text/html',body:'<style>body{margin:0;background:#191b1c}#stage{width:320px;height:240px}#creative{position:relative;width:640px;height:400px}.creative-canvas{position:absolute;inset:0}</style><div id="stage"></div><div id="creative"></div>'});
  });
  await page.goto('http://m1-export.test');
  for(const file of sources){
    await page.addScriptTag({path:path.join(web,file)});
    if(file==='stage-resource-policy.js') await page.evaluate(cpu=>{
      StageResourcePolicy=Object.freeze({...StageResourcePolicy,qualification:'contract-test-only',caps:Object.freeze({...StageResourcePolicy.caps,ownedCpuBytes:cpu,decodeReservedBytes:128*1024*1024})});
    },cpu);
  }
  await page.evaluate(()=>{
    Stage.init();Stage.setTrack({id:'m1-export',title:'Export contract',duration_ms:120000});
    Stage.setSnapshot({playing:false,track_id:'m1-export',position_ms:1200,duration_ms:120000});CreativeStage.init();
    window.harness={captures:0,tracks:[],downloads:0};
    const capture=HTMLCanvasElement.prototype.captureStream;
    HTMLCanvasElement.prototype.captureStream=function(...args){const stream=capture.apply(this,args);harness.captures++;harness.tracks.push(...stream.getTracks());return stream;};
    window.Stage3D={open(){document.body.classList.add('s3d-open');CreativeStage.attachStage(document.getElementById('creative'));},recordingSurface:()=>CreativeStage.recordingSurface()};
    harness.begin=()=>{harness.error=null;harness.done=VideoExport.begin({preset:{id:'720p'},format:'webm'}).catch(error=>{harness.error=error.message;return null;});};
  });
  page.on('download',()=>page.evaluate(()=>harness.downloads++).catch(()=>{}));
  return page;
}
async function close(page){await page.evaluate(()=>{dispatchEvent(new Event('pagehide'));CreativeStage.destroy();Backgrounds.destroy();HandDrawn.destroy();Stage.destroy();});await page.close();}
async function check(name,run){try{report.checks.push({name,passed:true,evidence:await run()});console.log('PASS '+name);}catch(error){report.checks.push({name,passed:false,error:error.stack});console.error('FAIL '+name+': '+error.message);}}
async function main(){
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  try{
    await check('production128MiB CPU cap refuses before native capture or encoder startup',async()=>{
      const page=await pageFor(128*1024*1024);try{
        const result=await page.evaluate(async()=>{const baseline=Stage.resources().snapshot();harness.begin();await harness.done;return{baseline,after:Stage.resources().snapshot(),error:harness.error,captures:harness.captures,status:VideoExport.status()};});
        assert.equal(result.error,'aggregate-budget');assert.equal(result.captures,0);assert.deepEqual(result.after.held,result.baseline.held);return result;
      }finally{await close(page);}
    });
    await check('twenty native encodes preserve valid media and retire composition, decoder and source leases',async()=>{
      const page=await pageFor();try{
        const samples=[];
        for(let i=0;i<20;i++){
          await page.evaluate(()=>harness.begin());
          await page.waitForFunction(()=>VideoExport.status().phase==='recording'||harness.error,{},{timeout:16000});
          assert.equal(await page.evaluate(()=>harness.error),null);
          await page.waitForTimeout(250);
          const download=page.waitForEvent('download',{timeout:10000});
          const result=await page.evaluate(async()=>{const live=Stage.resources().snapshot();await VideoExport.stop();const result=await harness.done;CreativeStage.attachStage(null);
            harness.lastResult=result;return{live,bytes:result.bytes,failed:result.failed,message:result.message,status:VideoExport.status(),after:Stage.resources().snapshot(true),ended:harness.tracks.every(track=>track.readyState==='ended'),videos:[...document.querySelectorAll('video')].filter(video=>video.srcObject).length};});
          const file=await download;await file.saveAs(path.join(out,'cycle-'+i+'.webm'));
          assert.ok(result.bytes>1000,result.message);assert.equal(result.failed,false);assert.equal(result.status.retiring,0);assert.equal(result.ended,true);assert.equal(result.videos,0);
          assert.equal(result.after.held.decoderLeases,0);assert.equal(result.after.held.gpuContexts,0);assert.equal(result.after.held.canvases,0);
          if(i===0||i===19){result.decoded=await page.evaluate(async()=>{
            const url=URL.createObjectURL(harness.lastResult.blob),video=document.createElement('video');video.muted=true;
            try{const loaded=new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(Error('Saved output decode failed'));});video.src=url;document.body.appendChild(video);await loaded;return{width:video.videoWidth,height:video.videoHeight};}
            finally{video.pause();video.removeAttribute('src');video.load();video.remove();URL.revokeObjectURL(url);}
          });assert.deepEqual(result.decoded,{width:1280,height:720});}
          samples.push(result);
        }
        const closed=await page.evaluate(()=>{dispatchEvent(new Event('pagehide'));return Stage.resources().snapshot(true);});
        assert.ok(!closed.entries.some(entry=>entry.owner==='video-export'));return{samples,closed};
      }finally{await close(page);}
    });
    await check('closing a live native source stops capture and settles all source and export resources',async()=>{
      const page=await pageFor();try{
        await page.evaluate(()=>harness.begin());await page.waitForFunction(()=>VideoExport.status().phase==='recording'||harness.error,{},{timeout:16000});
        assert.equal(await page.evaluate(()=>harness.error),null);await page.waitForTimeout(300);
        const result=await page.evaluate(async()=>{CreativeStage.attachStage(null);const closing=Stage.resources().snapshot();await harness.done;
          const status=VideoExport.status();dispatchEvent(new Event('pagehide'));return{closing,status,closed:Stage.resources().snapshot(true)};});
        assert.equal(result.closing.held.gpuContexts,1);assert.equal(result.status.retiring,0);assert.ok(result.status.bytes>0);
        assert.equal(result.closed.held.gpuContexts,0);assert.ok(!result.closed.entries.some(entry=>entry.owner==='video-export'));return result;
      }finally{await close(page);}
    });
  }finally{await browser.close();}
  report.sourceSha256After=digest();report.passed=!report.errors.length&&report.checks.every(item=>item.passed)&&JSON.stringify(report.sourceSha256)===JSON.stringify(report.sourceSha256After);
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(path.join(out,'report.json'));assert.ok(report.passed,'native export checks');
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
