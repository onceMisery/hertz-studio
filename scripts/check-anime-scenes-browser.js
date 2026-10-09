// SPDX-License-Identifier: MIT
// Real WebGL pixels plus the workshop journey against an isolated null backend.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output/playwright/anime-scenes');
const report = { checks: [], renders: [], samples: {}, layouts: [], errors: [] };
const pass = name => { report.checks.push(name); console.log('PASS ' + name); };

async function pixels(browser) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => report.errors.push(error.message));
  try {
    await page.setContent('<style>html,body{margin:0;background:#16203c}canvas{display:block}</style><canvas></canvas>');
    for (const file of ['creative-gl.js', 'creative-anime.js'])
      await page.addScriptTag({ path: path.join(root, 'plugin/ui', file) });
    const tests = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      window.animeEngine = CreativeGL.create(canvas);
      if (!animeEngine) throw new Error('WebGL2 unavailable');
      animeEngine.resize(720, 450, 1);
      window.animeState = scene => {
        const def = CreativeGL.sceneById(scene);
        return { scene, quality: 2, t: 42000, dt: 16, play: true, seed: .42,
          p: { ...def.defaults }, bands: new Array(64).fill(.35), rises: new Array(64).fill(.08),
          agg: [.45,.32,.26,.17], energy: .32, pulse: .2, colors: [[.6,.8,.8],[.3,.4,.6]],
          cam: { yaw: 0, pitch: 0, dist: 20, fov: 55, tx: 0, ty: 0, tz: 0 },
          post: { bloom: .28, bloomThresh: .74, chroma: 0, vignette: .14, grain: .06,
            toon: 0, paper: 0, exposure: 1, saturation: 1, grade: 0 } };
      };
      const gl = canvas.getContext('webgl2');
      function render(state) {
        const status = animeEngine.render(state);
        if (!status.ok) throw new Error(state.scene + ': ' + JSON.stringify(status));
        const data = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
        gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,data);
        if (gl.getError() !== gl.NO_ERROR) throw new Error(state.scene + ': WebGL error');
        let hash = 2166136261, light = 0, visible = 0, clipped = 0;
        for (let i=0;i<data.length;i+=4) {
          hash = Math.imul(hash ^ data[i] ^ (data[i+1] << 8) ^ (data[i+2] << 16), 16777619);
          light += .2126*data[i]+.7152*data[i+1]+.0722*data[i+2];
          if (Math.max(data[i],data[i+1],data[i+2]) > 20) visible++;
          if (Math.min(data[i],data[i+1],data[i+2]) > 245) clipped++;
        }
        const count = data.length/4;
        return { hash:hash>>>0, light:light/count, visible:visible/count, clipped:clipped/count };
      }
      const results=[];
      for (const scene of CreativeGL.scenes().filter(s => s.presentation?.family === 'anime')) {
        const state=animeState(scene.id), base=render(state);
        for (const quality of [0,1,2]) {
          for (const energy of [0,1]) {
            results.push({scene:scene.id,quality,energy,...render({...state,quality,energy,pulse:energy,agg:new Array(4).fill(energy)})});
          }
        }
        for (const param of scene.params) {
          const low=render({...state,p:{...state.p,[param[0]]:param[2]}});
          const high=render({...state,p:{...state.p,[param[0]]:param[3]}});
          if (low.hash===high.hash) throw new Error(scene.id+': parameter '+param[0]+' has no visible effect');
        }
        if (render({...state,t:72000}).hash===base.hash) throw new Error(scene.id+': stage clock does not move the scene');
        if (render({...state,cam:{...state.cam,yaw:.32,dist:17}}).hash===base.hash) throw new Error(scene.id+': camera crop is inert');
        for (const [control,change] of [
          ['camera height',{cam:{...state.cam,ty:5}}],
          ['camera roll',{cam:{...state.cam,roll:.08}}],
          ['stage scale',{modelMatrix:new Float32Array([1.6,0,0,0,0,1.6,0,0,0,0,1.6,0,0,0,0,1])}],
          ['stage rotation',{modelMatrix:new Float32Array([0,0,-1,0,0,1,0,0,1,0,0,0,0,0,0,1])}],
          ['seed',{seed:.91}], ['bloom',{post:{...state.post,bloom:3,bloomThresh:.2}}]
        ]) if (render({...state,...change}).hash===base.hash) throw new Error(scene.id+': '+control+' has no visible effect');
      }
      return results;
    });
    assert.equal(tests.length,24);
    for (const test of tests) {
      assert.ok(test.visible>.94,test.scene+' fills the drawing');
      assert.ok(test.clipped<.01,test.scene+' avoids blown highlights');
      assert.ok(test.light>18,test.scene+' is readable');
      if (test.scene === 'anime-sky') assert.ok(test.light>120,'daylight paint retains its intended luminance');
    }
    report.renders=tests;
    pass('four distinct flat scenes render across all quality and energy levels; every control changes real pixels');
    const scenes=await page.evaluate(()=>CreativeGL.scenes().filter(s=>s.presentation?.family==='anime').map(s=>({id:s.id,label:s.label})));
    assert.equal(new Set(tests.filter(t=>t.quality===2&&t.energy===0).map(t=>t.hash)).size,4,'four distinct compositions');
    for(const size of [{width:1600,height:900},{width:420,height:800}]) {
      await page.setViewportSize(size);
      for(const scene of scenes) {
        const data=await page.evaluate(({scene,size})=>{
          animeEngine.resize(size.width,size.height,1);
          const result=animeEngine.render(animeState(scene));
          if(!result.ok)throw new Error(JSON.stringify(result));
          return document.querySelector('canvas').toDataURL('image/png').split(',')[1];
        },{scene:scene.id,size});
        fs.writeFileSync(path.join(out,scene.id+'-'+size.width+'.png'),Buffer.from(data,'base64'));
      }
    }
    await page.evaluate(()=>animeEngine.dispose());
    pass('desktop and portrait artwork captured from the actual renderer');
  } finally { await page.close(); }
}

async function until(probe, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
}

async function ready(page, trackId) {
  await page.waitForFunction(id => window.Workshop && window.CreativeStage &&
    document.querySelector('#conn.ok') && Stage.presentation().track?.id === id &&
    Stage.lyrics()?.lines?.length >= 5, trackId);
  await page.evaluate(() => document.fonts.ready);
  // Sample the real renderer immediately after draw, before the browser clears
  // its drawing buffer. The observer owns no animation loop or scene state.
  await page.evaluate(() => {
    window.__animeSamples = {};
    window.__animeErrors = [];
    const create = CreativeGL.create;
    CreativeGL.create = (...args) => {
      const engine = create(...args);
      if (!engine) return engine;
      const canvas = args[0], render = engine.render;
      engine.render = state => {
        const result = render(state);
        if (!canvas.closest('#s3d-creative')) return result;
        window.__animeFrame = { scene: state.scene, t: state.t, play: state.play, cam: { ...state.cam } };
        if (!result.ok) __animeErrors.push(result);
        if (window.__animeRead) {
          const label = __animeRead;
          window.__animeRead = null;
          const gl = canvas.getContext('webgl2'), width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
          const data = new Uint8Array(width * height * 4);
          gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,data);
          let hash = 2166136261, light = 0, chroma = 0;
          const stride = Math.max(1,Math.floor(width*height/4096));
          let count = 0;
          for (let p=0;p<width*height;p+=stride) {
            const i=p*4, r=data[i], g=data[i+1], b=data[i+2];
            hash=Math.imul(hash^r^(g<<8)^(b<<16),16777619);
            light+=.2126*r+.7152*g+.0722*b;
            chroma+=Math.max(r,g,b)-Math.min(r,g,b);
            count++;
          }
          __animeSamples[label]={...__animeFrame,width,height,hash:hash>>>0,light:light/count,chroma:chroma/count,glError:gl.getError()};
        }
        return result;
      };
      return engine;
    };
  });
}

async function sample(page, label) {
  await page.evaluate(name => { window.__animeRead=name; CreativeStage.kick(); },label);
  await page.waitForFunction(name => !!window.__animeSamples[name],label);
  const value=await page.evaluate(name => __animeSamples[name],label);
  assert.equal(value.glError,0,label+' WebGL status');
  report.samples[label]=value;
  return value;
}

async function journey(browser) {
  const fixture=await startFixture();
  let context, page;
  try {
    const track=await fixture.seed();
    const music=path.join(path.dirname(fixture.dataDir),'music');
    fs.writeFileSync(path.join(music,'layout.lrc'),
      '[00:00.00]晚风吹过你的眼睛\n[00:05.00]把星光画进这一页\n[00:10.00]听见远方温柔的回声\n[00:17.00]让每一颗星都有颜色\n[00:22.00]我们沿着星光继续向前走\n');
    await fixture.api('/v1/library/scan','POST',{root:music});
    await until(async()=>!(await fixture.api('/v1/library/status')).running,'sidecar lyrics scan');
    await fixture.api('/v1/player/load','POST',{track_id:track.id,queue:[track.id]});
    await fixture.api('/v1/player/pause','POST',{});
    await fixture.api('/v1/player/seek','POST',{position_ms:7500});
    await fixture.api('/v1/settings','PUT',{cover_follow:false,reduce_motion:false,render_mode:'standard'});
    for (const file of ['creative-anime.js','creative-anime.css','creative-gl.js','creative-stage.js','workshop.js']) {
      const response=await fetch(fixture.base+'/'+file);
      assert.equal(response.status,200,file+' is embedded');
      assert.equal((await response.text()).replace(/\r\n/g,'\n'),fs.readFileSync(path.join(root,'plugin/ui',file),'utf8').replace(/\r\n/g,'\n'),file+' matches current source');
    }
    pass('rebuilt native service serves the current scene, gallery and host assets');
    context=await browser.newContext({viewport:{width:1440,height:960},deviceScaleFactor:1});
    await fixture.connect(context);
    page=await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror',error=>report.errors.push(error.message));
    page.on('console',message=>{
      if (/shader.*(error|fail)|GL_INVALID|INVALID_OPERATION/i.test(message.text())) report.errors.push(message.text());
    });
    await page.goto(fixture.base,{waitUntil:'domcontentloaded'});
    await ready(page,track.id);
    await page.evaluate(()=>Theme.apply('celestial'));
    const defaults=await page.evaluate(()=>({stage:Stage3D.preferences(),creative:CreativeStage.preset()}));
    await page.locator('#stage3d-entry').click();
    await page.evaluate(()=>{Workshop.open();Workshop.setTab('scene');CreativeStage.setDirector(false);});
    await page.waitForFunction(()=>CreativeStage.stageActive()&&window.__animeFrame);
    const material=()=>page.evaluate(()=>({
      head:getComputedStyle(document.querySelector('.s3d-head')).backgroundImage,
      canvas:getComputedStyle(document.querySelector('#s3d-creative canvas')).mixBlendMode
    }));
    const previousMaterial=await material();
    const scenes=await page.evaluate(()=>CreativeGL.scenes().filter(s=>s.presentation?.family==='anime').map(s=>s.id));
    assert.equal(await page.locator('.ws-anime-card').count(),4);
    for (const id of scenes) {
      await page.evaluate(()=>CreativeStage.setStyle('manga'));
      await page.locator('#ws-scene-'+id).click();
      await page.waitForFunction(scene=>window.__animeFrame?.scene===scene,id);
      const preset=await page.evaluate(()=>CreativeStage.preset());
      assert.equal(preset.scene,id);
      assert.equal(preset.hand.on,false,'new drawing clears prior handdrawn filter');
      assert.equal(preset.look.grade,0,'new drawing clears prior monochrome grade');
      assert.equal(await page.locator('#ws-scene-'+id).getAttribute('aria-pressed'),'true');
      const frame=await sample(page,id+'-selected');
      assert.ok(frame.chroma>10,id+' retains its colored paint');
      assert.equal(await page.locator('#s3d-creative').getAttribute('data-scene-family'),'anime');
      assert.equal((await material()).canvas,'normal');
      await page.locator('#ws-close').click();
      await page.waitForTimeout(300);
      assert.ok(await page.locator('#s3d-reading').isVisible(),'host lyrics visible');
      assert.ok((await page.locator('#s3d-reading').innerText()).includes('把星光画进这一页'));
      assert.ok(await page.locator('#s3d-play').isVisible(),'transport visible');
      await page.screenshot({path:path.join(out,id+'-stage-1440.png')});
      await page.evaluate(()=>{Workshop.open();Workshop.setTab('scene');});
    }
    pass('all four gallery choices activate the real stage, clear monochrome filters and retain host lyrics');

    await page.evaluate(()=>{CreativeStage.setParam('sc.light',1.17);CreativeStage.setParam('cam.height',2);});
    const edited=await page.evaluate(()=>CreativeStage.exportJSON());
    const selected=page.locator('#ws-scene-anime-forest');
    await selected.focus();
    await selected.press('Enter');
    assert.equal(await page.evaluate(()=>CreativeStage.exportJSON()),edited,'reselecting keeps edited parameters');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'ws-scene-anime-forest','reselection keeps keyboard focus');
    await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(()=>document.querySelector('.ws-panel').contains(document.activeElement)),'Tab remains in workshop');
    pass('reselecting a drawing preserves edits and keyboard focus');

    for (const width of [1440,760,420,320]) {
      await page.setViewportSize({width,height:width===1440?960:860});
      await page.evaluate(()=>{document.getElementById('ws-body').scrollTop=0;});
      await page.waitForFunction(()=>{
        const panel=document.querySelector('.ws-panel'),rect=panel.getBoundingClientRect();
        return panel.classList.contains('is-open')&&rect.left>=-1&&rect.right<=innerWidth+1;
      });
      const layout=await page.evaluate(()=>{
        const panel=document.querySelector('.ws-panel'),grid=document.querySelector('.ws-anime-grid');
        const rect=panel.getBoundingClientRect(),style=getComputedStyle(grid);
        return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,panel:{left:rect.left,right:rect.right},
          gap:parseFloat(style.gap),columns:style.gridTemplateColumns.split(' ').length,
          cards:[...grid.children].map(el=>({width:el.clientWidth,scroll:el.scrollWidth})),
          close:!!document.elementFromPoint(...(()=>{const r=document.getElementById('ws-close').getBoundingClientRect();return[r.x+r.width/2,r.y+r.height/2];})())?.closest('#ws-close')};
      });
      report.layouts.push(layout);
      assert.ok(layout.scrollWidth<=width+1,'page fits '+width);
      assert.ok(layout.panel.left>=-1&&layout.panel.right<=width+1,'workshop fits '+width);
      assert.ok(layout.gap>=24,'gallery breathing room at '+width);
      assert.equal(layout.columns,width<360?1:2,'responsive gallery at '+width);
      assert.ok(layout.cards.every(c=>c.scroll<=c.width+1),'card captions fit '+width);
      assert.ok(layout.close,'workshop close remains reachable at '+width);
      await page.screenshot({path:path.join(out,'gallery-'+width+'.png')});
      await page.locator('#ws-close').click();
      await page.waitForTimeout(300);
      for (const id of ['s3d-play','s3d-close','s3d-lyrics-toggle']) {
        const box=await page.locator('#'+id).boundingBox();
        assert.ok(box&&box.x>=-1&&box.x+box.width<=width+1&&box.y>=0&&box.y+box.height<=860+100*(width===1440),id+' fits '+width);
      }
      await page.screenshot({path:path.join(out,'stage-'+width+'.png')});
      await page.evaluate(()=>{Workshop.open();Workshop.setTab('scene');});
    }
    pass('gallery and stage controls fit 1440, 760, 420 and 320px without page overflow');

    await page.setViewportSize({width:1440,height:960});
    await page.locator('#ws-scene-anime-rail').click();
    await page.locator('#ws-close').click();
    const paused=await sample(page,'paused-a');
    await page.waitForTimeout(400);
    const pausedAgain=await sample(page,'paused-b');
    assert.equal(paused.t,pausedAgain.t,'paused song freezes scene clock');
    assert.equal(paused.hash,pausedAgain.hash,'paused scene is pixel stable');
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.locator('#s3d-play').click();
    await page.waitForFunction(()=>document.body.classList.contains('is-playing'));
    const reduced=await sample(page,'reduced-a');
    const position=await page.evaluate(()=>Stage.position());
    await page.waitForTimeout(500);
    const reducedAgain=await sample(page,'reduced-b');
    assert.ok(await page.evaluate(start=>Stage.position()>start,position),'audio timeline still advances');
    assert.equal(reduced.t,reducedAgain.t,'OS reduced motion freezes the scene clock');
    assert.equal(reduced.hash,reducedAgain.hash,'OS reduced motion freezes scenery pixels');
    await page.emulateMedia({reducedMotion:'no-preference'});
    const resumed=await sample(page,'motion-resumed');
    assert.ok(resumed.t>reduced.t,'normal motion resumes on the existing song clock');
    await page.locator('#s3d-play').click();
    await page.waitForFunction(()=>!document.body.classList.contains('is-playing'));
    await page.locator('#s3d-lyrics-toggle').click();
    assert.equal(await page.locator('#s3d-reading').isVisible(),false);
    await page.locator('#s3d-lyrics-toggle').click();
    assert.equal(await page.locator('#s3d-reading').isVisible(),true);
    pass('pause and OS reduced motion freeze scenery; playback and lyric toggles remain functional');

    await page.evaluate(()=>{Workshop.open();Workshop.setTab('scene');CreativeStage.setParam('sc.light',1.09);});
    await page.locator('#ws-body .ws-name').fill('月下列车 · 动画绘景验收');
    await page.getByRole('button',{name:'存进工坊',exact:true}).click();
    const saved=await page.evaluate(()=>CreativeStage.library()[0]);
    assert.equal(saved.scene,'anime-rail');
    assert.ok(saved.thumb?.startsWith('data:image/'),'saved work includes a renderer thumbnail');
    await until(async()=>{
      const settings=await fixture.api('/v1/settings');
      return settings.creative_presets?.some(p=>p.id===saved.id);
    },'saved artwork reaches service storage');
    const snapshot=await page.evaluate(()=>CreativeStage.shareSnapshot());
    await page.evaluate(()=>Workshop.setTab('io'));
    await page.locator('#ws-share-copy').click();
    await page.waitForFunction(()=>document.getElementById('ws-share-code').value.length>20);
    const code=await page.locator('#ws-share-code').inputValue();
    await page.evaluate(()=>CreativeStage.setScene('orb'));
    await page.locator('#ws-share-code').fill(code);
    await page.locator('#ws-share-import').click();
    await page.waitForFunction(()=>CreativeStage.preset().scene==='anime-rail');
    assert.deepEqual(await page.evaluate(()=>CreativeStage.shareSnapshot()),snapshot,'share UI restores the full artwork');
    const exported=await page.locator('#ws-body .ws-json:not(#ws-share-code)').inputValue();
    await page.evaluate(()=>CreativeStage.setScene('orb'));
    await page.locator('#ws-body .ws-json:not(#ws-share-code)').fill(exported);
    await page.getByRole('button',{name:'载入这段 JSON',exact:true}).click();
    assert.equal(await page.evaluate(()=>CreativeStage.exportJSON()),exported,'JSON UI roundtrip');
    pass('save, renderer thumbnail, service persistence, share code and JSON import retain the authored scene');

    const beforeReload=await page.evaluate(()=>CreativeStage.preset());
    await page.waitForFunction(expected=>localStorage.getItem('vmusic.creative.preset')===JSON.stringify(expected),beforeReload);
    assert.deepEqual(await page.evaluate(()=>window.__animeErrors),[]);
    await page.reload({waitUntil:'domcontentloaded'});
    await ready(page,track.id);
    assert.deepEqual(await page.evaluate(()=>CreativeStage.preset()),beforeReload,'page reload preserves edits');
    await page.waitForFunction(id=>CreativeStage.library().some(p=>p.id===id),saved.id);
    await page.locator('#stage3d-entry').click();
    await page.evaluate(()=>{Workshop.open();Workshop.setTab('scene');});
    await page.locator('#ws-defaults').click();
    await page.waitForFunction(()=>document.getElementById('ws-defaults').getAttribute('aria-busy')!=='true');
    assert.deepEqual(await page.evaluate(()=>Stage3D.preferences()),defaults.stage,'reset restores immersive defaults');
    assert.deepEqual(await page.evaluate(()=>CreativeStage.preset()),defaults.creative,'reset restores creative defaults');
    assert.deepEqual(await page.evaluate(id=>CreativeStage.library().find(p=>p.id===id),saved.id),saved,'reset preserves saved artwork');
    await page.evaluate(()=>Workshop.setTab('presets'));
    assert.equal(await page.locator('.ws-shot-name',{hasText:saved.name}).count(),1,'saved artwork is visible after reset');
    await page.locator('.ws-shot').filter({hasText:saved.name}).getByRole('button',{name:'载入并应用',exact:true}).click();
    await page.evaluate(()=>Workshop.setTab('scene'));
    await page.waitForFunction(()=>window.__animeFrame?.scene==='anime-rail');
    await page.locator('.ws-scene-card[data-scene="orb"]').click();
    await page.waitForFunction(()=>window.__animeFrame?.scene==='orb');
    assert.equal(await page.locator('#s3d-creative').getAttribute('data-scene-family'),'');
    assert.deepEqual(await material(),previousMaterial,'old scene materials return after leaving drawings');
    const old=await sample(page,'original-orb');
    assert.ok(old.light>0,'original scene still renders');
    assert.deepEqual(await page.evaluate(()=>window.__animeErrors),[]);
    pass('reload and restore preserve saved work; original scenes recover their existing rendering and materials');
  } catch (error) {
    if (page) await page.screenshot({path:path.join(out,'journey-failure.png')}).catch(()=>{});
    throw error;
  } finally {
    if (context) await context.close();
    await fixture.close();
  }
}

async function main() {
  fs.mkdirSync(out,{recursive:true});
  const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});
  try {
    await pixels(browser);
    await journey(browser);
    assert.deepEqual(report.errors,[]);
  } catch (error) {
    report.failure=error.stack;
    throw error;
  } finally {
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
    await browser.close();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
