// SPDX-License-Identifier: MIT
// Real isolated service, content hashing, project file reopening and song clock.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {startFixture}=require('./ui-browser-fixture'),{uiUrl}=require('./ui-token');
async function main(){
  const fixture=await startFixture();process.env.VMUSIC_DATA_DIR=fixture.dataDir;
  const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome',headless:true});
  const context=await browser.newContext({viewport:{width:1280,height:850},acceptDownloads:true});await fixture.connect(context);
  const page=await context.newPage(),errors=[],modelCalls=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.method()==='POST' && /\/v1\/ai\/jobs$/.test(r.url()))modelCalls.push(r.url());});
  try{
    const track=await fixture.seed();
    const identity=await fixture.api('/v1/stage/project-media','POST',{track_id:track.id});
    assert.deepEqual(identity,{kind:'local-file-sha256-v1',sha256:crypto.createHash('sha256').update(fs.readFileSync(track.path)).digest('hex'),
      byteLength:String(fs.statSync(track.path).size)});
    assert.equal((await fetch(fixture.base+'/v1/stage/project-media',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({track_id:track.id})})).status,401);
    await page.goto(uiUrl(fixture.base));
    await page.waitForFunction(id=>Stage.presentation().track?.id===id && Stage.presentation().mediaTrackId===id,track.id);
    await page.evaluate(()=>{
      const p=CreativeStage.canonicalBaseline('orb');p.look.bloom=0;p.director=false;
      p.cues=[{at:1,len:1000,ease:'linear',set:{'look.bloom':1}}];CreativeStage.setPreset(p);
      Workshop.open();Workshop.setTab('io');
    });
    await page.evaluate(()=>Workshop.setTab('cues'));
    await page.getByText('当前为普通预置',{exact:true}).waitFor();
    await page.evaluate(()=>Workshop.setTab('io'));
    const original=await page.evaluate(()=>CreativeStage.shareSnapshot());
    const event=page.waitForEvent('download');await page.locator('[data-project="save"]').click();
    const download=await event;
    assert.ok(download.suggestedFilename().endsWith('.hertz-stage.json'));
    const bytes=fs.readFileSync(await download.path()),project=JSON.parse(bytes);
    assert.deepEqual(project.media,identity);assert.equal(project.projectVersion,1);assert.deepEqual(project.preset,original);
    assert.ok(!bytes.toString().includes(track.path));
    await page.evaluate(()=>CreativeStage.setPreset(CreativeStage.canonicalBaseline('towers')));
    const before=await page.evaluate(()=>CreativeStage.preset());
    await page.getByLabel('打开舞台工程文件').setInputFiles({name:download.suggestedFilename(),mimeType:'application/json',buffer:bytes});
    await page.getByText('文件已读取，请检查后应用。',{exact:true}).waitFor();
    await page.locator('[data-project="check"]').click();
    assert.deepEqual(await page.evaluate(()=>CreativeStage.preset()),before,'Checking must not write stage');
    await page.locator('[data-project="apply"]').click();
    await page.getByText('工程已载入，cue 轨等待媒体内容确认',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>CreativeStage.preset().scene),'orb');
    await page.locator('[data-project="bind"]').click();
    await page.getByText('本次曲目已确认，工程 cue 轨已启用',{exact:true}).waitFor();
    await page.evaluate(()=>Workshop.setTab('cues'));
    await page.getByText('本次曲目已确认，工程 cue 轨已启用',{exact:true}).waitFor();
    await page.getByText('歌曲秒数',{exact:true}).locator('..').locator('input').fill('1.2');
    await page.getByText('歌曲秒数',{exact:true}).locator('..').locator('input').dispatchEvent('change');
    assert.equal(await page.evaluate(()=>CreativeStage.preset().cues[0].at),1.2);
    await page.getByText('歌曲秒数',{exact:true}).locator('..').locator('input').fill('1');
    await page.getByText('歌曲秒数',{exact:true}).locator('..').locator('input').dispatchEvent('change');
    await page.evaluate(()=>Workshop.setTab('io'));
    async function seek(ms,want){
      await fixture.api('/v1/player/seek','POST',{position_ms:ms});
      try {
        await page.waitForFunction(({ms,want})=>Math.abs(Stage.position()-ms)<5 && Math.abs(CreativeStage.runtime()['look.bloom']-want)<.01,{ms,want});
      } catch(e) {
        const state=await page.evaluate(()=>({position:Stage.position(),bloom:CreativeStage.runtime()['look.bloom'],
          project:CreativeProject.status(),preset:CreativeStage.preset()}));
        throw new Error('Seek '+ms+' expected bloom '+want+': '+JSON.stringify(state),{cause:e});
      }
    }
    await seek(1500,.5);await seek(0,0);await seek(1500,.5);
    await page.waitForTimeout(300);assert.equal(await page.evaluate(()=>CreativeStage.runtime()['look.bloom']),.5,'Paused song clock freezes absolute cue');
    await page.waitForTimeout(450);
    await page.reload();await page.waitForFunction(()=>window.CreativeProject && CreativeStage.preset().project);
    await page.evaluate(()=>{Workshop.open();Workshop.setTab('io');});
    await page.getByText('工程已载入，cue 轨等待媒体内容确认',{exact:true}).waitFor();
    await page.waitForFunction(()=>Stage.presentation().track?.id && Stage.presentation().track.id===Stage.presentation().mediaTrackId);
    assert.equal(await page.evaluate(()=>CreativeStage.runtime()['look.bloom']),0);
    await page.evaluate(()=>Workshop.setTab('cues'));
    await page.getByText('工程已载入，cue 轨等待媒体内容确认',{exact:true}).waitFor();
    await page.evaluate(()=>Workshop.setTab('io'));
    await page.locator('[data-project="bind"]').click();await page.getByText('本次曲目已确认，工程 cue 轨已启用',{exact:true}).waitFor();
    const otherPath=path.join(path.dirname(track.path),'another.wav');fs.copyFileSync(track.path,otherPath);
    await fixture.api('/v1/library/scan','POST',{root:path.dirname(track.path)});
    let other;
    for(let i=0;i<100;i++){
      other=(await fixture.api('/v1/tracks?limit=10')).tracks.find(t=>t.id!==track.id);
      if(other)break;await page.waitForTimeout(100);
    }
    assert.ok(other);await page.evaluate(()=>Workshop.setTab('cues'));
    await page.getByText('本次曲目已确认，工程 cue 轨已启用',{exact:true}).waitFor();
    await fixture.api('/v1/player/load','POST',{track_id:other.id});
    await page.waitForFunction(id=>Stage.presentation().track?.id===id,other.id);
    await page.getByText('工程已载入，cue 轨等待媒体内容确认',{exact:true}).waitFor();
    await fixture.api('/v1/player/load','POST',{track_id:track.id});
    await page.waitForFunction(id=>Stage.presentation().track?.id===id,track.id);
    await page.getByText('工程已载入，cue 轨等待媒体内容确认',{exact:true}).waitFor();
    await page.evaluate(()=>Workshop.setTab('io'));
    await fixture.api('/v1/player/pause','POST',{});
    await page.waitForFunction(()=>!Stage.presentation().playing);
    assert.match(await page.evaluate(()=>CreativeProject.status()),/等待/,'Returning to original track never silently restores binding');
    project.media.sha256='0'.repeat(64);
    await page.getByLabel('舞台工程 JSON').fill(JSON.stringify(project));await page.locator('[data-project="check"]').click();
    await page.locator('[data-project="apply"]').click();await page.locator('[data-project="bind"]').click();
    await page.getByText('当前文件与工程媒体内容不匹配，未绑定',{exact:true}).waitFor();
    const stable=await page.evaluate(()=>CreativeStage.preset());
    project.projectVersion=99;await page.getByLabel('舞台工程 JSON').fill(JSON.stringify(project));
    await page.locator('[data-project="check"]').click();
    await page.getByText('不支持的工程或时间线版本',{exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>CreativeStage.preset()),stable);
    // Complete the same piece through the existing native video exporter.
    await page.getByLabel('舞台工程 JSON').fill(bytes.toString());
    await page.locator('[data-project="check"]').click();await page.locator('[data-project="apply"]').click();
    await page.locator('[data-project="bind"]').click();await page.getByText('本次曲目已确认，工程 cue 轨已启用',{exact:true}).waitFor();
    // Manual authoring goes through the real panel, then the same project file
    // and video path. Sections compile to editable cues; no second track owner.
    await page.evaluate(()=>Workshop.setTab('cues'));
    await page.locator('.ws-arrangement summary').click();
    await page.getByLabel('删除分段 4',{exact:true}).click();
    for(const [i,at,mode]of [[1,'0','quiet'],[2,'1','chorus'],[3,'2','original']]){
      await page.getByLabel('分段 '+i+' 开始秒数',{exact:true}).fill(at);
      await page.getByLabel('分段 '+i+' 过渡毫秒',{exact:true}).fill('500');
      await page.getByLabel('分段 '+i+' 规则',{exact:true}).selectOption(mode);
    }
    const unmodified=await page.evaluate(()=>CreativeStage.preset());
    await page.getByLabel('分段 2 开始秒数',{exact:true}).fill('0');
    await page.locator('[data-arrangement="check"]').click();
    await page.getByText('分段时间须递增，过渡不能越过下一分段',{exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>CreativeStage.preset()),unmodified);
    await page.getByLabel('分段 2 开始秒数',{exact:true}).fill('1');
    await page.locator('[data-arrangement="check"]').click();
    await page.getByText('检查通过，请核对替换范围后应用。',{exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>CreativeStage.preset()),unmodified);
    await page.locator('[data-arrangement="apply"]').click();
    const arranged=await page.evaluate(()=>CreativeStage.preset());
    assert.equal(arranged.cues.length,3);assert.equal(arranged.director,false);assert.equal(arranged.project.timelineVersion,1);
    assert.match(await page.evaluate(()=>CreativeProject.status()),/等待/);
    // A later owner edit invalidates a checked replacement rather than applying
    // a candidate based on parameters that no longer exist.
    await page.locator('.ws-arrangement summary').click();await page.locator('[data-arrangement="check"]').click();
    await page.evaluate(()=>CreativeStage.setParam('look.grain',.12));
    assert.equal(await page.locator('[data-arrangement="apply"]').isDisabled(),true);
    await page.setViewportSize({width:390,height:760});
    const bounds=await page.locator('.ws-arrangement').boundingBox();
    assert.ok(bounds.x>=0 && bounds.x+bounds.width<=391);
    assert.equal(await page.locator('.ws-arrangement').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
    await page.locator('.ws-arrangement summary').scrollIntoViewIfNeeded();
    fs.mkdirSync(path.resolve('output/playwright'),{recursive:true});
    await page.screenshot({path:path.resolve('output/playwright/stage-project-sections-390.png')});
    await page.setViewportSize({width:1280,height:850});
    await page.getByText('媒体确认与工程保存',{exact:true}).click();
    await page.locator('[data-project="bind"]').click();await page.getByText('本次曲目已确认，工程 cue 轨已启用',{exact:true}).waitFor();
    await seek(500,.18);await seek(1250,.3);await seek(2250,.21);await seek(1250,.3);
    const arrangedEvent=page.waitForEvent('download');await page.locator('[data-project="save"]').click();
    const arrangedDownload=await arrangedEvent,arrangedBytes=fs.readFileSync(await arrangedDownload.path());
    assert.equal(JSON.parse(arrangedBytes).preset.cues.length,3);
    await page.getByLabel('打开舞台工程文件').setInputFiles({name:'sections.hertz-stage.json',mimeType:'application/json',buffer:arrangedBytes});
    await page.getByText('文件已读取，请检查后应用。',{exact:true}).waitFor();
    await page.locator('[data-project="check"]').click();await page.locator('[data-project="apply"]').click();
    await page.locator('[data-project="bind"]').click();await page.getByText('本次曲目已确认，工程 cue 轨已启用',{exact:true}).waitFor();
    await seek(1250,.3);
    await page.evaluate(()=>Workshop.setTab('cues'));
    const editedTime=page.getByText('歌曲秒数',{exact:true}).nth(1).locator('..').locator('input');
    await editedTime.fill('1.1');await editedTime.dispatchEvent('change');
    assert.equal(await page.evaluate(()=>CreativeStage.preset().cues[1].at),1.1);
    await seek(1350,.3);await page.evaluate(()=>Workshop.setTab('io'));
    await page.evaluate(()=>{window.videoDone=VideoExport.begin({preset:{id:'720p'},format:'webm',systemAudio:false});});
    await page.waitForFunction(()=>VideoExport.status().phase==='recording');await page.waitForTimeout(1100);
    const videoEvent=page.waitForEvent('download');await page.evaluate(()=>{window.videoStopped=VideoExport.stop();});
    const videoDownload=await videoEvent;await page.evaluate(()=>Promise.all([videoDone,videoStopped]).then(()=>null));
    const videoBytes=fs.readFileSync(await videoDownload.path());assert.ok(videoBytes.length>1000);
    const dimensions=await page.evaluate(async data=>{
      const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));const url=URL.createObjectURL(new Blob([bytes]));
      const video=document.createElement('video');video.muted=true;video.src=url;
      try{await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Project video decode timeout')),10000);
        video.onloadeddata=()=>{clearTimeout(t);resolve();};video.onerror=()=>{clearTimeout(t);reject(Error('Project video decode failed'));};});
        return {width:video.videoWidth,height:video.videoHeight};
      }finally{video.pause();video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
    },videoBytes.toString('base64'));
    assert.deepEqual(dimensions,{width:1280,height:720});await page.evaluate(()=>VideoExport.close());
    await page.setViewportSize({width:390,height:760});
    const panel=await page.locator('#workshop').boundingBox();assert.ok(panel.x>=0 && panel.x+panel.width<=391);
    assert.deepEqual(modelCalls,[]);assert.deepEqual(errors,[]);
    console.log('PASS actual SHA-256/auth, project/section check/apply/bind/edit/reopen, invalid/stale replacement isolation, seek/pause, refresh/switch invalidation, native video export/decode and 390px layout; no model calls');
  }finally{await context.close();await browser.close();await fixture.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
