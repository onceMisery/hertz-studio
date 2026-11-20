// SPDX-License-Identifier: MIT
// Isolated service + real Chromium canvas capture/MediaRecorder/download/decode.
// Audio uses a synthetic WebAudio track, never screen/microphone permissions.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { uiUrl } = require('./ui-token');
const { readAssets } = require('./ui-assets');

async function main() {
  const fixture = await startFixture();
  process.env.VMUSIC_DATA_DIR = fixture.dataDir;
  const browser = await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome',headless:true,
    args:['--autoplay-policy=no-user-gesture-required']});
  const context = await browser.newContext({viewport:{width:1280,height:850},acceptDownloads:true});
  await fixture.connect(context);
  const page = await context.newPage(), errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  try {
    if (process.env.R6_SOURCE_ASSETS === '1') {
      const assets = new Map(readAssets().map(asset=>[asset.path,asset.file]));
      await page.route('**/*',route=>{
        const url = new URL(route.request().url());
        if (url.origin !== fixture.base) return route.continue();
        if (url.pathname === '/') return route.fulfill({contentType:'text/html; charset=utf-8',
          body:fs.readFileSync(path.resolve(__dirname,'../plugin/ui/index.html'),'utf8')
            .replaceAll('__VMUSIC_TOKEN_VALUE__',new URL(uiUrl(fixture.base)).searchParams.get('token'))});
        if (url.pathname.startsWith('/v1/')) return route.continue();
        const file = assets.get(url.pathname);
        return file && fs.existsSync(file) ? route.fulfill({path:file}) : route.continue();
      });
    }
    const track = await fixture.seed();
    const currentLyric = 'Hertz video export lyric sentinel 这一句混合中英文的长歌词用于验证导出不会被横向压扁 '.repeat(5);
    const nextLyric = 'Next lyric 下一句较长的歌词也需要按画布宽度换行保持清晰 '.repeat(5);
    await fixture.api(`/v1/tracks/${encodeURIComponent(track.id)}/lyrics`, 'PUT', {
      content: '[00:00.00]' + currentLyric + '\n[00:05.00]' + nextLyric,
    });
    await page.goto(uiUrl(fixture.base),{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.VideoExport && window.Stage3D && window.CreativeStage);
    await page.evaluate(()=>{
      window.captureTracks=[];window.capturedRecorders=[];window.captureAudio=[];window.captureCanvases=[];window.captureStreams=[];window.permissionCalls=0;
      const capture=HTMLCanvasElement.prototype.captureStream;
      HTMLCanvasElement.prototype.captureStream=function(...args){
        const stream=capture.apply(this,args);captureTracks.push(...stream.getTracks());captureCanvases.push(this);captureStreams.push(stream);return stream;
      };
      const NativeRecorder=window.MediaRecorder;
      window.MediaRecorder=new Proxy(NativeRecorder,{construct(target,args){
        const recorder=Reflect.construct(target,args);recorder.auditEvents=[];
        recorder.addEventListener('dataavailable',event=>recorder.auditEvents.push({kind:'data',bytes:event.data.size}));
        recorder.addEventListener('error',event=>recorder.auditEvents.push({kind:'error',name:event.error?.name}));
        capturedRecorders.push(recorder);return recorder;
      }});
      Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{configurable:true,value:async()=>{
        window.permissionCalls++;
        const audio=new AudioContext(),osc=audio.createOscillator(),dest=audio.createMediaStreamDestination();
        osc.frequency.value=440;osc.connect(dest);osc.start();await audio.resume();captureAudio.push(audio);
        captureTracks.push(...dest.stream.getTracks());return dest.stream;
      }});
      const draw=CanvasRenderingContext2D.prototype.drawImage;
      const fillRect=CanvasRenderingContext2D.prototype.fillRect;
      const fillText=CanvasRenderingContext2D.prototype.fillText;
      window.outputDraws=0;
      window.outputHasLyric=false;
      window.outputLyricDraws={current:[],next:[]};
      let lyricGroup=null;
      CanvasRenderingContext2D.prototype.fillRect=function(...args){
        if(this.canvas===captureCanvases.at(-1)) lyricGroup='current';
        return fillRect.apply(this,args);
      };
      CanvasRenderingContext2D.prototype.drawImage=function(...args){
        if(this.canvas===captureCanvases.at(-1)) outputDraws++;
        return draw.apply(this,args);
      };
      CanvasRenderingContext2D.prototype.fillText=function(...args){
        if(this.canvas===captureCanvases.at(-1)) {
          const text=String(args[0]);
          if(text.startsWith('Next lyric')) lyricGroup='next';
          else if(text.startsWith('Layout Audit Fixture')) lyricGroup='current';
          const group=lyricGroup;
          if(group && !text.startsWith('Layout Audit Fixture')) {
            outputHasLyric=true;
            const metrics=this.measureText(text);
            const row={text,width:metrics.width,y:args[2],top:args[2]-metrics.actualBoundingBoxAscent,
              bottom:args[2]+metrics.actualBoundingBoxDescent,height:this.canvas.height,
              maxWidth:this.canvas.width*(group==='current'?0.88:0.84),argCount:args.length};
            if(!outputLyricDraws[group].some(existing=>existing.text===row.text&&existing.y===row.y)) {
              outputLyricDraws[group].push(row);
            }
          }
        }
        return fillText.apply(this,args);
      };
      Stage3D.configure({sceneSource:'immersive',stanzaVisual:'stage',stanzaBg:'stage'});Stage3D.open();
    });
    await page.waitForFunction(()=>Stage3D.recordingSurface()?.canvas.width > 0);
    assert.equal(await page.evaluate(()=>Stage3D.recordingSurface().source),'immersive');

    async function start({systemAudio=false,preset='720p',format='auto'}={}) {
      await page.evaluate(options=>{
        window.outputHasLyric=false;window.outputLyricDraws={current:[],next:[]};window.recordingError=null;
        window.recordingDone=VideoExport.begin({preset:{id:options.preset},systemAudio:options.systemAudio,format:options.format});
        recordingDone.catch(error=>{window.recordingError=error.message;});
      },{systemAudio,preset,format});
      await page.waitForFunction(()=>VideoExport.status().phase==='recording' || window.recordingError,{},{timeout:15000})
        .catch(async error=>{
          console.error('Recording startup state:',JSON.stringify(await page.evaluate(()=>({
            status:VideoExport.status(),error:window.recordingError,visibility:document.hidden,
            recorders:capturedRecorders.map(recorder=>({state:recorder.state,mimeType:recorder.mimeType,events:recorder.auditEvents})),
          }))));
          throw error;
        });
      assert.equal(await page.evaluate(()=>window.recordingError || VideoExport.status().phase),'recording');
      const resources=await page.evaluate(()=>Stage.resources().snapshot());
      assert.equal(resources.caps.ownedCpuBytes,128*1024*1024);
      assert.equal(resources.caps.decodeReservedBytes,64*1024*1024);
      assert.ok(resources.held.ownedCpuBytes<=resources.caps.ownedCpuBytes);
      await page.waitForTimeout(1700);
    }
    function assertLyricLayout(layout,height) {
      for(const [group,limit] of [['current',3],['next',2]]) {
        assert.ok(layout[group].length>1,group+' long lyric must wrap into multiple canvas rows');
        assert.ok(layout[group].length<=limit,group+' rows must fit its vertical budget');
        assert.ok(layout[group].every(row=>row.argCount===3),group+' lyric must not use Canvas maxWidth compression');
        assert.ok(layout[group].every(row=>row.width<=row.maxWidth+1),group+' wrapped rows must fit the safe width');
        assert.ok(layout[group].every(row=>row.top>=0&&row.bottom<=height&&row.height===height),
          group+' glyph bounds must stay inside the recorded canvas');
      }
      const currentBottom=Math.max(...layout.current.map(row=>row.bottom));
      const nextTop=Math.min(...layout.next.map(row=>row.top));
      assert.ok(currentBottom<nextTop,'current and next lyric glyphs must not overlap');
    }
    async function save(width,height,audio) {
      assert.equal(await page.evaluate(()=>VideoExport.status().phase),'recording','Session must still be active before explicit stop');
      const beforeStop=await page.evaluate(()=>({status:VideoExport.status(),
        outputDraws,tracks:capturedRecorders.at(-1).stream.getTracks().map(t=>({width:t.getSettings().width,
          height:t.getSettings().height,frameRate:t.getSettings().frameRate,muted:t.muted,state:t.readyState})),
        videos:[...document.querySelectorAll('video')].filter(v=>v.srcObject).map(v=>({ready:v.readyState,frames:v.getVideoPlaybackQuality().totalVideoFrames})),
        canvases:captureCanvases.map(canvas=>({width:canvas.width,height:canvas.height,connected:canvas.isConnected}))}));
      const downloadEvent=page.waitForEvent('download',{timeout:10000});
      await page.evaluate(()=>{window.stoppingDone=VideoExport.stop();});
      const download=await downloadEvent.catch(async error=>{
        console.error(JSON.stringify({beforeStop,after:await page.evaluate(async()=>({status:VideoExport.status(),
          result:await Promise.race([recordingDone.then(result=>({message:result.message,bytes:result.bytes})),
            new Promise(resolve=>setTimeout(()=>resolve('still pending'),1000))]),
          recorderStates:capturedRecorders.map(recorder=>({state:recorder.state,type:recorder.mimeType,events:recorder.auditEvents})),
          errors:window.recordingError,hidden:document.hidden}))}));
        throw error;
      });
      await page.evaluate(()=>Promise.all([recordingDone,stoppingDone]).then(()=>null));
      const file=await download.path(),bytes=fs.readFileSync(file);
      assert.ok(bytes.length>1000,'Native encoder must produce nonempty media');
      const facts=await page.evaluate(()=>({status:VideoExport.status(),mime:capturedRecorders.at(-1).mimeType,
        audioTracks:capturedRecorders.at(-1).stream.getAudioTracks().length,
        ended:captureTracks.every(track=>track.readyState==='ended'),
        hiddenVideos:[...document.querySelectorAll('video')].filter(video=>video.srcObject).length}));
      assert.equal(facts.status.phase,'idle');assert.equal(facts.ended,true);assert.equal(facts.hiddenVideos,0);
      assert.equal(facts.audioTracks,audio?1:0);assert.equal(facts.status.audioMode,audio?'system':'silent');
      assert.equal(download.suggestedFilename().endsWith('.mp4'),facts.mime.startsWith('video/mp4'));
      assert.equal(download.suggestedFilename().includes('-silent.'),!audio);
      const decoded=await page.evaluate(async data=>{
        const bytes=Uint8Array.from(atob(data),char=>char.charCodeAt(0));
        const url=URL.createObjectURL(new Blob([bytes]));const video=document.createElement('video');
        video.muted=true;video.src=url;document.body.appendChild(video);
        try {
          await new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(Error('Saved video did not decode')),10000);
            video.onloadeddata=()=>{clearTimeout(timer);resolve();};video.onerror=()=>{clearTimeout(timer);reject(Error('Saved video decode error'));};
          });
          return {width:video.videoWidth,height:video.videoHeight};
        } finally {video.pause();video.remove();URL.revokeObjectURL(url);}
      },bytes.toString('base64'));
      assert.deepEqual(decoded,{width,height});
      let decodedAudio=null;
      if(audio) {
        decodedAudio=await page.evaluate(async data=>{
          const bytes=Uint8Array.from(atob(data),char=>char.charCodeAt(0));
          const decoder=new OfflineAudioContext(1,1,44100);
          const buffer=await decoder.decodeAudioData(bytes.buffer);
          const channel=buffer.getChannelData(0);
          let sum=0;for(const sample of channel) sum+=sample*sample;
          return {channels:buffer.numberOfChannels,duration:buffer.duration,rms:Math.sqrt(sum/channel.length)};
        },bytes.toString('base64'));
        assert.ok(decodedAudio.duration>0.5 && decodedAudio.rms>0.05,'Saved file must contain decodable synthetic audio');
      }
      return {bytes:bytes.length,filename:download.suggestedFilename(),mime:facts.mime,decodedAudio};
    }

    await start();
    assert.equal(await page.evaluate(()=>outputHasLyric),true,
      'Imported lyric must be drawn to the canvas captured by MediaRecorder');
    assertLyricLayout(await page.evaluate(()=>outputLyricDraws),720);
    await page.evaluate(()=>{VideoExport.open();VideoExport.close();VideoExport.open();});
    await page.getByRole('button',{name:'停止并保存',exact:true}).waitFor();
    const horizontal=await save(1280,720,false);
    await page.setViewportSize({width:390,height:760});
    await page.evaluate(()=>{VideoExport.open();});
    const dimensions=await page.locator('.vex-card').boundingBox();
    assert.ok(dimensions.x>=0 && dimensions.x+dimensions.width<=390 && dimensions.height<=728);
    await page.locator('[data-vex="download"]').waitFor();
    const retryEvent=page.waitForEvent('download');await page.locator('[data-vex="download"]').click();
    assert.equal((await retryEvent).suggestedFilename(),horizontal.filename);

    await page.setViewportSize({width:1280,height:850});
    await page.evaluate(()=>{
      CreativeStage.setPreset(CreativeStage.canonicalBaseline('orb'));
      Stage3D.configure({sceneSource:'creative'});Stage3D.open();
    });
    await page.waitForFunction(()=>Stage3D.recordingSurface()?.source==='creative');
    assert.equal(await page.evaluate(()=>Stage3D.recordingSurface().canvas.classList.contains('creative-canvas')),true,
      'Creative recordings must use the creative owner canvas');
    const refused=await page.evaluate(async()=>{
      const before=Stage.resources().snapshot(),captures=captureTracks.length,permissions=permissionCalls;
      let error='';try{await VideoExport.begin({preset:{id:'portrait'},format:'webm',systemAudio:true});}catch(e){error=e.message;}
      return{before,after:Stage.resources().snapshot(),captures,afterCaptures:captureTracks.length,permissions,afterPermissions:permissionCalls,error};
    });
    assert.match(refused.error,/缩小舞台窗口或选择 720p/);
    assert.deepEqual(refused.after.held,refused.before.held,'Refused startup must preserve all existing resource ownership');
    assert.equal(refused.afterCaptures,refused.captures);assert.equal(refused.afterPermissions,refused.permissions);
    await page.setViewportSize({width:390,height:760});
    await page.waitForFunction(()=>{
      const source=Stage3D.recordingSurface()?.canvas;
      return source && (source.width*source.height+1080*1920)*4*6<=Stage.resources().snapshot().caps.decodeReservedBytes;
    });
    await start({systemAudio:true,preset:'portrait',format:'webm'});
    assertLyricLayout(await page.evaluate(()=>outputLyricDraws),1920);
    assert.ok(await page.evaluate(()=>outputLyricDraws.current.some(row=>row.text.endsWith('…'))),
      'portrait current lyric must visibly truncate overflow rows');
    assert.ok(await page.evaluate(()=>outputLyricDraws.next.some(row=>row.text.endsWith('…'))),
      'portrait next lyric must visibly truncate overflow rows');
    await page.evaluate(()=>VideoExport.open());
    await page.getByText('已包含系统音轨（可能包含其它应用声音）',{exact:true}).waitFor();
    const portrait=await save(1080,1920,true);
    // Native encoders, with only the old stop callback delayed: an expired raw
    // session may retain its allocation lease while a new Creative session runs.
    await page.setViewportSize({width:640,height:480});
    await page.evaluate(()=>{VideoExport.close();Stage3D.configure({sceneSource:'immersive'});Stage3D.open('aurora');});
    await page.waitForFunction(()=>Stage3D.recordingSurface()?.source==='immersive');
    await start({preset:'720p',format:'webm'});
    const timedOut=await page.evaluate(async()=>{
      const recorder=capturedRecorders.at(-1);
      window.retiredRaw={source:Stage3D.recordingSurface(),recorder,onstop:recorder.onstop};
      recorder.onstop=null;VideoExport.stop();const result=await recordingDone;
      return{result:{bytes:result.bytes,failed:result.failed},status:VideoExport.status(),source:Stage3D.stats().resources};
    });
    assert.equal(timedOut.result.failed,true);assert.equal(timedOut.status.retiring,1);assert.equal(timedOut.source.recordingUses,1);
    await page.evaluate(()=>{VideoExport.close();Stage3D.configure({sceneSource:'creative'});Stage3D.open();});
    await page.waitForFunction(()=>Stage3D.recordingSurface()?.source==='creative');
    await start({preset:'720p',format:'webm'});
    await page.evaluate(()=>retiredRaw.source.canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
    await page.waitForFunction(()=>Stage3D.stats().resources.retiring);
    assert.equal(await page.evaluate(()=>VideoExport.status().phase),'recording','Old raw invalidation must not stop the new Creative session');
    const resumed=await page.evaluate(()=>{
      retiredRaw.onstop();return{status:VideoExport.status(),raw:Stage3D.stats().resources};
    });
    assert.equal(resumed.status.phase,'recording');assert.equal(resumed.status.retiring,0);assert.equal(resumed.raw.recordingUses,0);
    const isolated=await save(1280,720,false);
    await page.setViewportSize({width:1000,height:650});
    await page.evaluate(()=>{VideoExport.close();Stage3D.configure({sceneSource:'immersive'});Stage3D.open('aurora');});
    await page.waitForFunction(()=>Stage3D.recordingSurface()?.source==='immersive');
    await start({preset:'720p',format:'webm'});
    const destruction=await page.evaluate(async()=>{
      const source=Stage3D.recordingSurface(),before=Stage.resources().snapshot();
      Stage3D.destroy();
      const retiring={stats:Stage3D.stats(),ledger:Stage.resources().snapshot(),width:source.canvas.width};
      const result=await recordingDone;
      return{before,retiring,after:Stage.resources().snapshot(true),status:VideoExport.status(),width:source.canvas.width,
        result:{bytes:result.bytes,failed:result.failed,message:result.message},ended:captureTracks.every(track=>track.readyState==='ended')};
    });
    assert.equal(destruction.retiring.stats.resources.retiring,true);
    assert.equal(destruction.retiring.stats.resources.recordingUses,1);assert.ok(destruction.retiring.width>0);
    assert.equal(destruction.retiring.ledger.held.gpuContexts,destruction.before.held.gpuContexts);
    assert.equal(destruction.width,0);assert.equal(destruction.status.retiring,0);assert.equal(destruction.ended,true);
    assert.ok(destruction.result.bytes>1000);assert.equal(destruction.result.failed,false);
    assert.ok(!destruction.after.entries.some(entry=>entry.owner==='stage3d-gl'||entry.owner==='stage3d-input'));
    await page.evaluate(()=>{VideoExport.close();Stage3D.init();Stage3D.configure({sceneSource:'immersive'});});
    const beforeCold=await page.evaluate(()=>({surface:!!Stage3D.recordingSurface(),resources:Stage.resources().snapshot()}));
    assert.equal(beforeCold.surface,false);assert.equal(beforeCold.resources.held.gpuContexts,0);
    await start({preset:'720p',format:'webm'});
    const cold=await save(1280,720,false);
    await page.evaluate(async()=>{for(const audio of captureAudio) await audio.close();});
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({horizontal,portrait,narrowDialog:'passed',downloadRetry:'passed',oversizedSourcePreflight:'passed',
      sourceDestruction:{bytes:destruction.result.bytes,ended:destruction.ended},
      retiredSourceIsolation:{bytes:isolated.bytes,lateStop:'passed',oldContextLoss:'passed'},
      uncreatedSourceStartup:{bytes:cold.bytes},
      scope:'Real browser encode/decode and synthetic audio; not a cross-GPU or actual system-audio acceptance'}));
  } finally {await context.close();await browser.close();await fixture.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
