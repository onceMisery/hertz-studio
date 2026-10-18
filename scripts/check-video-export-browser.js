// SPDX-License-Identifier: MIT
// Isolated service + real Chromium canvas capture/MediaRecorder/download/decode.
// Audio uses a synthetic WebAudio track, never screen/microphone permissions.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { uiUrl } = require('./ui-token');

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
    await fixture.seed();
    await page.goto(uiUrl(fixture.base),{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.VideoExport && window.Stage3D && window.CreativeStage);
    await page.evaluate(()=>{
      window.captureTracks=[];window.capturedRecorders=[];window.captureAudio=[];window.captureCanvases=[];window.captureStreams=[];
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
        const audio=new AudioContext(),osc=audio.createOscillator(),dest=audio.createMediaStreamDestination();
        osc.frequency.value=440;osc.connect(dest);osc.start();await audio.resume();captureAudio.push(audio);
        captureTracks.push(...dest.stream.getTracks());return dest.stream;
      }});
      const draw=CanvasRenderingContext2D.prototype.drawImage;
      window.outputDraws=0;
      CanvasRenderingContext2D.prototype.drawImage=function(...args){
        if(this.canvas===captureCanvases.at(-1)) outputDraws++;
        return draw.apply(this,args);
      };
      Stage3D.configure({sceneSource:'immersive',stanzaVisual:'stage',stanzaBg:'stage'});Stage3D.open();
    });
    await page.waitForFunction(()=>Stage3D.recordingSurface()?.canvas.width > 0);
    assert.equal(await page.evaluate(()=>Stage3D.recordingSurface().source),'immersive');

    async function start({systemAudio=false,preset='720p',format='auto'}={}) {
      await page.evaluate(options=>{
        window.recordingDone=VideoExport.begin({preset:{id:options.preset},systemAudio:options.systemAudio,format:options.format});
        recordingDone.catch(error=>{window.recordingError=error.message;});
      },{systemAudio,preset,format});
      await page.waitForFunction(()=>VideoExport.status().phase==='recording' || window.recordingError,{},{timeout:15000});
      assert.equal(await page.evaluate(()=>window.recordingError || VideoExport.status().phase),'recording');
      await page.waitForTimeout(1700);
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
    await start({systemAudio:true,preset:'portrait',format:'webm'});
    await page.evaluate(()=>VideoExport.open());
    await page.getByText('已包含系统音轨（可能包含其它应用声音）',{exact:true}).waitFor();
    const portrait=await save(1080,1920,true);
    await page.evaluate(async()=>{for(const audio of captureAudio) await audio.close();});
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({horizontal,portrait,narrowDialog:'passed',downloadRetry:'passed',
      scope:'Real browser encode/decode and synthetic audio; not a cross-GPU or actual system-audio acceptance'}));
  } finally {await context.close();await browser.close();await fixture.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
