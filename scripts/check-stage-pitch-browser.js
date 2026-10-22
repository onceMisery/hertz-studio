// SPDX-License-Identifier: MIT
// Real local WAV analysis and Stage clock; injected replies only for UI races.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {startFixture}=require('./ui-browser-fixture'),{uiUrl}=require('./ui-token');

function signal(file,silent=false){
  const wav=fs.readFileSync(file);
  let offset=12;
  while(wav.toString('ascii',offset,offset+4)!=='data'){
    assert.ok(offset+8<wav.length,'WAV data chunk');
    const len=wav.readUInt32LE(offset+4);offset+=8+len+(len%2);
  }
  const frames=wav.readUInt32LE(offset+4)/2;
  for(let i=0;i<frames;i++){
    const t=i/44100,hz=t<10?220:(t>=20?440:0);
    wav.writeInt16LE(silent||!hz?0:Math.round(10000*Math.sin(2*Math.PI*hz*t)),offset+8+i*2);
  }
  fs.writeFileSync(file,wav);
}

async function main(){
  const fixture=await startFixture();process.env.VMUSIC_DATA_DIR=fixture.dataDir;
  let browser,context;
  try{
    const track=await fixture.seed();signal(track.path);
    // External media edits require an official reload, not stale audio state.
    await fixture.api('/v1/player/load','POST',{track_id:track.id});
    await fixture.api('/v1/player/pause','POST',{});
    const actual=await fixture.api('/v1/stage/pitch','POST',{track_id:track.id});
    assert.equal(actual.media.sha256,crypto.createHash('sha256').update(fs.readFileSync(track.path)).digest('hex'));
    assert.equal(actual.map.analyzedMs,30000);assert.equal(actual.map.truncated,false);
    for(const [start,end,hz]of [[400,9600,220],[10400,19600,null],[20400,29600,440]]){
      const points=actual.map.points.filter(p=>p.t>=start && p.t<=end);assert.ok(points.length>100);
      assert.ok(points.every(p=>hz===null?p.hz===null:p.hz!==null && Math.abs(p.hz-hz)<2),'True decoded pitch/silence region');
    }
    assert.ok(!JSON.stringify(actual).includes(track.path));
    assert.equal((await fixture.api('/v1/stage/pitch','POST',{track_id:track.id})).cached,true);
    assert.equal((await fetch(fixture.base+'/v1/stage/pitch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({track_id:track.id})})).status,401);
    browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome',headless:true});
    context=await browser.newContext({viewport:{width:1280,height:850}});await fixture.connect(context);
    const page=await context.newPage(),errors=[],calls=[],modelCalls=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(r.method()==='POST'){
      if(/\/v1\/stage\/pitch$/.test(r.url()))calls.push(r.url());
      if(/\/v1\/ai\/jobs$/.test(r.url()))modelCalls.push(r.url());
    }});
    await page.goto(uiUrl(fixture.base));
    await page.waitForFunction(id=>Stage.presentation().track?.id===id && Stage.presentation().mediaTrackId===id,track.id);
    await page.evaluate(()=>{
      window.pitchGates=new Set();
      const gate=Stage.gate,remove=Stage.removeGate;
      Stage.gate=function(name,...args){if(name==='pitch-inspector')pitchGates.add(name);return gate.call(this,name,...args);};
      Stage.removeGate=function(name){pitchGates.delete(name);return remove.call(this,name);};
      Workshop.open();Workshop.setTab('cues');
    });
    const original=await page.evaluate(()=>CreativeStage.shareSnapshot());
    async function open(){
      await page.evaluate(()=>{Workshop.open();Workshop.setTab('cues');});
      if(!await page.locator('.ws-pitch').evaluate(el=>el.open))await page.locator('.ws-pitch summary').click();
    }
    await open();assert.equal(calls.length,0,'Opening inspector does not analyze audio');
    await page.locator('[data-pitch="analyze"]').click();
    await page.locator('[data-pitch-status]').filter({hasText:'已分析 30.0 秒'}).waitFor();
    assert.equal(calls.length,1);assert.equal(await page.evaluate(()=>pitchGates.size),1);
    assert.equal(await page.locator('.ws-pitch path').evaluate(el=>(el.getAttribute('d').match(/M/g)||[]).length),2,'Silent section is not bridged');
    async function seek(ms,hz){
      await fixture.api('/v1/player/seek','POST',{position_ms:ms});
      await page.waitForFunction(ms=>Math.abs(Stage.position()-ms)<5,ms);
      await page.waitForFunction(hz=>{
        const text=document.querySelector('[data-pitch-position]')?.textContent||'';
        if(hz===null)return text.includes('无可靠基频');
        const found=text.match(/([0-9.]+) Hz/);return found && Math.abs(Number(found[1])-hz)<2;
      },hz);
    }
    await seek(500,220);await seek(15000,null);await seek(25000,440);await seek(500,220);
    const frozen=await page.locator('[data-pitch-position]').textContent();
    await page.waitForTimeout(350);assert.equal(await page.locator('[data-pitch-position]').textContent(),frozen);
    assert.deepEqual(await page.evaluate(()=>CreativeStage.shareSnapshot()),original,'Pitch inspector cannot author a preset/project');
    await page.setViewportSize({width:390,height:760});
    await page.locator('.ws-pitch').scrollIntoViewIfNeeded();
    const bounds=await page.locator('.ws-pitch').boundingBox();assert.ok(bounds.x>=0 && bounds.x+bounds.width<=391);
    assert.equal(await page.locator('.ws-pitch').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
    fs.mkdirSync(path.resolve('output/playwright'),{recursive:true});
    await page.screenshot({path:path.resolve('output/playwright/stage-pitch-390.png')});
    await page.locator('.ws-pitch-graph').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.resolve('output/playwright/stage-pitch-graph-390.png')});
    await page.setViewportSize({width:1280,height:850});

    // Controlled response races verify observation/lifecycle, not decoder quality.
    async function delayed(action){
      let release,arrived,finished;
      const waiting=new Promise(r=>arrived=r),done=new Promise(r=>finished=r),hold=new Promise(r=>release=r);
      const handler=async route=>{arrived();await hold;try{await route.fulfill({json:actual});}catch{}finally{finished();}};
      await page.route('**/v1/stage/pitch',handler);
      try{
        await page.locator('[data-pitch="analyze"]').click();await waiting;
        await action();release();await done;
      }finally{release();await page.unroute('**/v1/stage/pitch',handler);}
    }
    await delayed(async()=>{
      await page.evaluate(()=>Workshop.close());assert.equal(await page.evaluate(()=>pitchGates.size),0);
    });
    await open();assert.equal(await page.locator('.ws-pitch-graph').isHidden(),true);
    await delayed(async()=>{await page.evaluate(()=>Workshop.setTab('io'));assert.equal(await page.evaluate(()=>pitchGates.size),0);});
    await open();assert.equal(await page.locator('.ws-pitch-graph').isHidden(),true);
    await delayed(async()=>{
      await page.locator('.ws-pitch summary').click();
      await page.getByText('已停止等待；可重新分析当前曲目。',{exact:true}).waitFor({state:'attached'});
    });
    await open();assert.equal(await page.locator('.ws-pitch-graph').isHidden(),true);
    let rejected=0;
    const busy=async route=>{rejected++;await route.fulfill({status:429,json:{error:{code:'pitch_busy',message:'后台分析忙，请重试',request_id:'fixture'}}});};
    await page.route('**/v1/stage/pitch',busy);
    await page.locator('[data-pitch="analyze"]').click();await page.getByText(/后台分析忙/).waitFor();
    assert.match(await page.locator('[data-pitch-status]').textContent(),/request_id fixture/);
    await page.waitForTimeout(300);assert.equal(rejected,1,'No automatic POST retry');
    assert.equal(await page.locator('[data-pitch="analyze"]').isEnabled(),true);
    await page.unroute('**/v1/stage/pitch',busy);
    const malformed=async route=>{const reply=structuredClone(actual);reply.map.version=99;await route.fulfill({json:reply});};
    await page.route('**/v1/stage/pitch',malformed);
    await page.locator('[data-pitch="analyze"]').click();await page.getByText('基频轨迹版本或结构无效',{exact:true}).waitFor();
    assert.equal(await page.locator('.ws-pitch-graph').isHidden(),true);await page.unroute('**/v1/stage/pitch',malformed);

    const silentPath=path.join(path.dirname(track.path),'silent.wav');fs.copyFileSync(track.path,silentPath);signal(silentPath,true);
    await fixture.api('/v1/library/scan','POST',{root:path.dirname(track.path)});
    let other;
    for(let i=0;i<100;i++){
      other=(await fixture.api('/v1/tracks?limit=10')).tracks.find(t=>t.path===silentPath);
      if(other)break;await page.waitForTimeout(100);
    }
    assert.ok(other);
    await delayed(async()=>{
      await fixture.api('/v1/player/load','POST',{track_id:other.id});await fixture.api('/v1/player/pause','POST',{});
      await page.waitForFunction(id=>Stage.presentation().track?.id===id && Stage.presentation().mediaTrackId===id,other.id);
      await page.getByText('曲目已改变，请重新分析当前本地曲目。',{exact:true}).waitFor();
    });
    assert.equal(await page.locator('.ws-pitch-graph').isHidden(),true);
    await page.locator('[data-pitch="analyze"]').click();
    await page.getByText(/未检测到可靠基频；静音/).waitFor();assert.equal(await page.locator('.ws-pitch-graph').isHidden(),true);
    assert.deepEqual(await page.evaluate(()=>CreativeStage.shareSnapshot()),original);
    await page.evaluate(()=>Workshop.close());assert.equal(await page.evaluate(()=>pitchGates.size),0);
    assert.deepEqual(modelCalls,[]);assert.deepEqual(errors,[]);
    console.log('PASS actual WAV pitch/silence, SHA-256/cache/auth, explicit UI, shared clock/seek/pause, null gaps, close/tab/track late-reply isolation, controlled busy/version errors, retry, gate cleanup and 390px layout; no model calls');
  }finally{if(context)await context.close();if(browser)await browser.close();await fixture.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
