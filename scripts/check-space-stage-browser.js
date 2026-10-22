// SPDX-License-Identifier: MIT
// Real renderer/plugin lifecycle; no backend or independent plugin frame loop.
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
async function main() {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<html><body style="margin:0"><canvas style="width:100vw;height:100vh"></canvas></body></html>');
    await page.addScriptTag({ path: path.join(root, 'plugin/ui/vendor/stage-runtime.js') });
    await page.addScriptTag({ path: path.join(root, 'plugin/ui/vendor/space-stage.js') });
    const evidence = await page.evaluate(async () => {
      const canvas = document.querySelector('canvas');
      let rendererCount = 0, draws = 0, releases = 0, updates = 0, held = null;
      const original = HTMLCanvasElement.prototype.getContext;
      const seen = new WeakSet(); let gl;
      HTMLCanvasElement.prototype.getContext = function(type, ...args) {
        const value = original.call(this,type,...args);
        if (this === canvas && value && /webgl/.test(type) && !seen.has(value)) { seen.add(value); rendererCount++; gl=value; }
        return value;
      };
      let invalidations=0;
      const host = SpaceStagePure.create(canvas,{qualityMode:'high',deviceTier:2,onInvalidate(){invalidations++;}});
      const definition = {apiVersion:1,id:'browser-contract',stateVersion:1,label:'Browser contract',category:'test',preview:'/contract.webp',aliases:[],
        params:{radius:{type:'number',default:1,min:.2,max:3,step:.1}},camera:{radius:6},capabilities:{interaction:true,threejs:true},quality:{},
        create(ctx) {
          const geometry=ctx.scope.track(new ctx.THREE.BoxGeometry(2,2,2));
          const material=ctx.scope.track(new ctx.THREE.MeshNormalMaterial());
          const mesh=new ctx.THREE.Mesh(geometry,material);ctx.scene.add(mesh);
          return {update(frame){updates++;mesh.rotation.y=frame.now*.001;},resize(){},setParams(params){mesh.scale.setScalar(params.radius);},setQuality(){},dispose(){releases++;}};
        }};
      SpaceStagePure.register(definition);
      await host.select(definition.id);host.resize(1280,720);
      const pixels = () => {
        host.frame({now:performance.now(),dt:.016,time:0,playing:true,bands:new Float32Array(32),level:.4});
        draws++;
        const bytes=new Uint8Array(64*64*4);gl.readPixels(Math.floor(gl.drawingBufferWidth/2)-32,Math.floor(gl.drawingBufferHeight/2)-32,64,64,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
        let sum=0;for(let i=0;i<bytes.length;i+=4)sum+=bytes[i]+bytes[i+1]+bytes[i+2];return sum;
      };
      const initial=pixels();
      host.setParams({radius:.5});const changed=pixels();
      const contextsBeforeSwitch=rendererCount;
      const worldCounts=[];
      await host.select('coast');
      for (const mode of ['low','medium','high']) { host.setQualityMode(mode); pixels(); const stats=host.stats(); worldCounts.push({id:'coast',mode,calls:stats.drawCalls,triangles:stats.triangles,points:stats.points}); }
      await host.select('zodiac');
      for (const mode of ['low','medium','high']) { host.setQualityMode(mode); pixels(); const stats=host.stats(); worldCounts.push({id:'zodiac',mode,calls:stats.drawCalls,triangles:stats.triangles,points:stats.points}); }
      const frozenWorlds=[];
      const snapshot=frame=>{
        host.frame({...frame,now:performance.now(),dt:.1,bands:new Float32Array(32),level:0});
        const bytes=new Uint8Array(128*128*4);
        gl.readPixels(Math.floor(gl.drawingBufferWidth/2)-64,Math.floor(gl.drawingBufferHeight/2)-64,128,128,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
        let hash=2166136261;for(const byte of bytes)hash=Math.imul(hash^byte,16777619);return hash>>>0;
      };
      for(const id of ['coast','zodiac']){
        await host.select(id);host.setQualityMode('low');
        const playing={playing:true,reduced:false,dynamicDt:.1,sceneTime:1,time:1};
        const first=snapshot(playing),moving=snapshot({...playing,sceneTime:2,time:2});
        const reducedFrame={...playing,reduced:true,dynamicDt:0,sceneTime:2,time:3};
        const reducedFirst=snapshot(reducedFrame),reducedNext=snapshot({...reducedFrame,time:30});
        const paused={...playing,playing:false,dynamicDt:0,sceneTime:2,time:30};
        const pausedFirst=snapshot(paused),pausedNext=snapshot(paused);
        host.setParams({reduced:true});
        const localFirst=snapshot(playing),localNext=snapshot({...playing,sceneTime:3,time:40});
        host.setParams(id==='coast'?{tod:.5}:{sign:'leo'});
        const staticChanged=snapshot({...paused,reduced:true});
        frozenWorlds.push({id,first,moving,reducedFirst,reducedNext,pausedFirst,pausedNext,localFirst,localNext,staticChanged});
      }
      const coverCanvas=document.createElement('canvas');coverCanvas.width=coverCanvas.height=16;
      const coverContext=coverCanvas.getContext('2d');coverContext.fillStyle='#f03020';coverContext.fillRect(0,0,16,16);
      const coverUrl=coverCanvas.toDataURL();
      SpaceStagePure.register({...definition,id:'browser-cover',create(ctx){
        const entry=ctx.services.spatialResources.cover.acquire(coverUrl,ctx.signal);
        const material=ctx.scope.track(new ctx.THREE.MeshBasicMaterial({color:0xffffff}));
        const geometry=ctx.scope.track(new ctx.THREE.PlaneGeometry(4,4));ctx.scene.add(new ctx.THREE.Mesh(geometry,material));
        return {update(){if(entry.texture&&material.map!==entry.texture){material.map=entry.texture;material.needsUpdate=true;}},dispose(){ctx.services.spatialResources.cover.release(entry);}};
      }});
      await host.select('browser-cover');
      const beforeCover=invalidations,coverBefore=snapshot({playing:false,dynamicDt:0,sceneTime:0,time:0});
      await new Promise(resolve=>setTimeout(resolve,100));
      const coverInvalidated=invalidations>beforeCover,coverAfter=snapshot({playing:false,dynamicDt:0,sceneTime:0,time:0});
      const reused=rendererCount===contextsBeforeSwitch;
      let baseCreates=0,baseDisposes=0,baseCamera;
      SpaceStagePure.register({...definition,id:'browser-composition',create(ctx){
        baseCreates++;baseCamera=ctx.camera;
        const geometry=ctx.scope.track(new ctx.THREE.PlaneGeometry(20,12));
        const material=ctx.scope.track(new ctx.THREE.MeshBasicMaterial({color:0x28745a}));
        ctx.scene.add(new ctx.THREE.Mesh(geometry,material));
        return {update(){},dispose(){baseDisposes++;}};
      }});
      await host.select('browser-composition');host.setRig({theta:.15,phi:.08,radius:8,fov:52,lookAt:[0,0,0]});
      const baseHash=snapshot({playing:false,time:2}),cameraBefore=baseCamera.matrixWorld.toArray();
      const lyricFrame={playing:false,reduced:true,time:2,sceneTime:0,lyrics:{index:1,progress:.4,lines:[{text:'上一行歌词',start:0,end:1},{text:'海岸之上，歌词与舞台同行',start:1,end:5},{text:'下一行歌词',start:5,end:9}]}};
      const combinations=[];
      for(const id of SpaceStagePure.catalog().filter(d=>d.capabilities.ownsLyrics).map(d=>d.id)){
        await host.selectLyrics(id);
        for(let i=0;i<5;i++){snapshot(lyricFrame);await new Promise(resolve=>setTimeout(resolve,20));}
        const withLyrics=snapshot(lyricFrame),withoutLyrics=snapshot({playing:false,time:2}),stats=host.stats();
        const state=host.setLyricParams({textWidth:8});
        combinations.push({id,withLyrics,withoutLyrics,baseHash,baseId:stats.id,lyricId:stats.lyricId,params:state.params.textWidth,calls:stats.drawCalls});
      }
      const cameraPreserved=JSON.stringify(cameraBefore)===JSON.stringify(baseCamera.matrixWorld.toArray());
      const layerResources=[];
      for(let i=0;i<12;i++){await host.selectLyrics('lyric-sonnet');snapshot(lyricFrame);layerResources.push(host.stats().resources);}
      host.resize(390,844);host.setQualityMode('low');const portrait=snapshot(lyricFrame);host.resize(1280,720);
      await host.selectLyrics(null);const offStats=host.stats(),offHash=snapshot({playing:false,time:2});
      let invalidLyric='';try{await host.selectLyrics('coast');}catch(error){invalidLyric=error.message;}
      let releaseLyric,staleLyricUpdates=0,staleLyricDisposes=0;
      SpaceStagePure.register({...definition,id:'browser-delayed-lyric',capabilities:{...definition.capabilities,ownsLyrics:true},create(){return new Promise(resolve=>{releaseLyric=()=>resolve({update(){staleLyricUpdates++;},dispose(){staleLyricDisposes++;}});});}});
      const delayedLyric=host.selectLyrics('browser-delayed-lyric');await host.selectLyrics('lyric-sonnet');releaseLyric();await delayedLyric;
      snapshot(lyricFrame);const latestLyric=host.stats().lyricId;
      await host.select('zodiac');snapshot(lyricFrame);const retainedLyric=host.stats().lyricId;
      await host.selectLyrics(null);
      SpaceStagePure.register({...definition,id:'browser-delayed',create(ctx){ctx.scope.track({dispose(){releases++;}});return new Promise(resolve=>{held=()=>resolve({update(){updates+=10000;},dispose(){releases++;}});});}});
      const delayed=host.select('browser-delayed');
      await host.select('browser-contract');held();await delayed;
      const beforeUpdate=updates;pixels();const staleUpdated=updates-beforeUpdate!==1;
      SpaceStagePure.register({...definition,id:'browser-failing',create(ctx){ctx.scope.track({dispose(){releases++;}});ctx.scope.timeout(()=>{updates+=10000;},1);throw new Error('Deliberate factory failure');}});
      let failure='';try{await host.select('browser-failing');}catch(error){failure=error.message;}
      await new Promise(resolve=>setTimeout(resolve,10));
      const failed=host.stats();
      await host.select('browser-contract');pixels();
      const counts=host.stats();host.dispose();host.dispose();const disposed=host.stats();
      const retryCanvas=document.createElement('canvas');retryCanvas.style.cssText=canvas.style.cssText;document.body.appendChild(retryCanvas);
      const retryHost=SpaceStagePure.create(retryCanvas,{qualityMode:'medium',deviceTier:2});await retryHost.select('browser-contract');retryHost.resize(640,360);
      retryHost.frame({now:performance.now(),dt:.016,time:0,playing:true});
      const retryGl=retryCanvas.getContext('webgl2'),loss=retryGl.getExtension('WEBGL_lose_context');
      await retryHost.selectLyrics('lyric-sonnet');
      if (!loss) throw new Error('Context loss extension unavailable');
      loss.loseContext();await new Promise(resolve=>setTimeout(resolve,100));const contextLost=retryHost.stats();
      let lostSelect='';try{await retryHost.select('coast');}catch(error){lostSelect=error.message;}
      retryHost.dispose();retryCanvas.remove();
      const freshCanvas=document.createElement('canvas');document.body.appendChild(freshCanvas);
      const freshHost=SpaceStagePure.create(freshCanvas,{qualityMode:'medium',deviceTier:2});await freshHost.select('browser-contract');freshHost.resize(640,360);
      freshHost.frame({now:performance.now(),dt:.016,time:0,playing:true});const fresh=freshHost.stats();freshHost.dispose();freshCanvas.remove();
      HTMLCanvasElement.prototype.getContext=original;
      return {initial,changed,reused,rendererCount,staleUpdated,failure,failed,counts,disposed,releases,draws,worldCounts,frozenWorlds,coverBefore,coverAfter,coverInvalidated,contextLost,lostSelect,fresh,
        combinations,cameraPreserved,baseCreates,baseDisposes,layerResources,portrait,offStats,offHash,baseHash,invalidLyric,staleLyricUpdates,staleLyricDisposes,latestLyric,retainedLyric};
    });
    assert.ok(evidence.initial>0,'nonblank registered scene');
    assert.notEqual(evidence.initial,evidence.changed,'registered parameter affects pixels');
    assert.ok(evidence.reused,'one renderer survives scene switches');
    assert.equal(evidence.rendererCount,1);
    for(const combo of evidence.combinations){assert.notEqual(combo.withLyrics,combo.baseHash,combo.id+' adds visible lyrics');assert.equal(combo.withoutLyrics,combo.baseHash,combo.id+' preserves the complete base buffer without lyrics');assert.equal(combo.baseId,'browser-composition');assert.equal(combo.lyricId,combo.id);assert.equal(combo.params,8);}
    assert.ok(evidence.cameraPreserved,'lyric selection preserves world camera');assert.equal(evidence.baseCreates,1);assert.equal(evidence.baseDisposes,1);
    assert.equal(new Set(evidence.layerResources).size,1,'repeated layer changes retain bounded resources');
    assert.equal(evidence.offStats.lyricId,null);assert.equal(evidence.offHash,evidence.baseHash);assert.ok(evidence.portrait>0);
    assert.match(evidence.invalidLyric,/Expected a lyric/);assert.equal(evidence.staleLyricUpdates,0);assert.equal(evidence.staleLyricDisposes,1);
    assert.equal(evidence.latestLyric,'lyric-sonnet');assert.equal(evidence.retainedLyric,'lyric-sonnet','world changes retain lyric selection');
    for(const world of evidence.frozenWorlds){
      assert.notEqual(world.first,world.moving,world.id+' moves during playback');
      assert.equal(world.reducedFirst,world.reducedNext,world.id+' freezes under global reduced motion');
      assert.equal(world.pausedFirst,world.pausedNext,world.id+' freezes paused supplemental frames');
      assert.equal(world.localFirst,world.localNext,world.id+' freezes under scene reduced motion');
      assert.notEqual(world.localNext,world.staticChanged,world.id+' applies static parameters while frozen');
    }
    assert.ok(evidence.coverInvalidated,'asynchronous paused cover asks Stage for a supplemental frame');
    assert.notEqual(evidence.coverBefore,evidence.coverAfter,'supplemental frame binds loaded paused cover');
    assert.equal(evidence.staleUpdated,false,'superseded async instance never updated');
    assert.match(evidence.failure,/Deliberate/);assert.equal(evidence.failed.resources,0);assert.equal(evidence.failed.tasks,0);
    assert.equal(evidence.disposed.state,'disposed');assert.equal(evidence.disposed.resources,0);assert.ok(evidence.releases>=5);
    assert.equal(evidence.counts.gpuMs,null,'CPU rendering time is not presented as GPU time');
    assert.equal(evidence.contextLost.state,'failed');assert.equal(evidence.contextLost.resources,0);assert.equal(evidence.contextLost.tasks,0);
    assert.match(evidence.lostSelect,/context is lost/);assert.equal(evidence.fresh.state,'ready');assert.ok(evidence.fresh.drawCalls>0,'fresh host renders after retry');
    assert.deepEqual(errors,[]);
    console.log('check-space-stage-browser: real registered plugin pixels, params, renderer reuse, delayed cancellation, partial failure, disposal, context loss and fresh-host retry passed');
    console.log(JSON.stringify(evidence));
  } finally { await browser.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
