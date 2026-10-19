// SPDX-License-Identifier: MIT
// UI fixtures only: search/provenance are controlled, parser/apply use the real
// isolated service. Provider/storage behavior has separate Rust coverage.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {startFixture}=require('./ui-browser-fixture'),{uiUrl}=require('./ui-token');
async function main(){
  const fixture=await startFixture();process.env.VMUSIC_DATA_DIR=fixture.dataDir;let browser,context;
  try{
    const track=await fixture.seed(),root='/v1/tracks/'+encodeURIComponent(track.id)+'/lyrics';
    browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome',headless:true});
    context=await browser.newContext({viewport:{width:1280,height:850}});await fixture.connect(context);
    const page=await context.newPage(),errors=[],writes=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(r.method()!=='GET' && r.url().includes('/lyrics'))writes.push({url:r.url(),method:r.method(),body:r.postDataJSON()});});
    await page.goto(uiUrl(fixture.base));
    await page.waitForFunction(id=>Stage.presentation().mediaTrackId===id,track.id);
    async function tools(){
      if(!await page.locator('#np-modal').isVisible())await page.locator('#bar-player-expand').click();
      if(!await page.locator('#np-tools').isVisible())await page.locator('#np-more').click();
    }
    await tools();
    const actualSources=await fixture.api('/v1/online/sources');
    if(!actualSources.sources.some(s=>(s.caps||[]).includes('lyric_candidates'))){
      assert.equal(await page.locator('#np-lyric-search').isVisible(),false,'Standard exposes no Full lyric protocols');
    }
    // Inject capability facts for the generic UI; no external provider requests.
    const first=actualSources.sources.find(s=>!s.kind || s.kind==='music');
    assert.ok(first);
    const sources=[first,{...first,id:'ui-lyric-fixture',label:'另一个受控来源'}];
    const sourcePayload={...actualSources,sources:sources.map((s,i)=>({...s,label:'受控歌词来源 '+i,caps:[...s.caps,'lyric_candidates']}))};
    await page.route('**/v1/online/sources',route=>route.fulfill({json:sourcePayload}));
    await page.reload();await page.waitForFunction(id=>Stage.presentation().mediaTrackId===id,track.id);
    await tools();await page.locator('#np-lyric-search').waitFor();
    const panel=page.locator('#np-lyric-import-panel'),status=panel.locator('[data-lyric-import-status]');
    const apply=panel.locator('[data-lyric-import-apply]'),submit=panel.locator('[data-lyric-search]'),query=panel.locator('[data-lyric-query]'),auto=panel.locator('[data-lyric-auto-apply]');
    let prepared,reply,searchFailure=false,prepareFailure=false,searches=0,fetches=0;
    async function reset(){
      const baseline=await fixture.api(root);
      prepared=await fixture.api(root+'/candidates','POST',{content:'[offset:100]\n[00:01.00]受控预览\n[00:04.00]Second line',format:'lrc',expectedMetadataRevision:baseline.metadataRevision,expectedLyricsRevision:baseline.lyricsRevision});
      reply={candidates:[{candidateId:prepared.candidateId,source:sources[0].id,sourceLabel:'受控歌词来源',refId:'public-id',title:('很长的候选曲名 ').repeat(12),artist:track.artist,album:'受控专辑',durationMs:30000,licenseStatus:'not_provided',evidence:{titleEqual:true,artistEqual:true,albumEqual:false,durationDeltaMs:1200,versionMismatch:false,strongMetadataMatch:false,automaticApplyAllowed:false,reasons:['title_equal','artist_equal','album_different','duration_different']}}],metadataRevision:baseline.metadataRevision,lyricsRevision:baseline.lyricsRevision,expiresInMs:600000,automaticApplyAllowed:false};
    }
    function onlinePreview(){return {...prepared,source:'online-provider',origin:{provider:sources[0].id,label:'受控歌词来源',refId:'public-id',licenseStatus:'not_provided'}};}
    const searchRoute=async route=>{searches++;if(searchFailure)return route.fulfill({status:502,json:{error:{code:'upstream_rejected',message:'受控搜索失败',request_id:'fixture-search'}}});await route.fulfill({json:reply});};
    const prepareRoute=async route=>{fetches++;if(prepareFailure)return route.fulfill({status:422,json:{error:{code:'lyrics_empty',message:'受控来源没有带时间歌词',request_id:'fixture-prepare'}}});await route.fulfill({json:onlinePreview()});};
    await page.route('**/lyrics/candidates/search',searchRoute);await page.route('**/lyrics/candidates/prepare-online',prepareRoute);
    async function open(){await tools();await page.locator('#np-lyric-search').click();}
    async function search(){await submit.click();await status.filter({hasText:'找到 1 份候选'}).waitFor();}
    async function preview(){await panel.locator('[data-lyric-check]').click();await status.filter({hasText:'尚未应用'}).waitFor();}
    await reset();const initial=await fixture.api(root);await open();
    assert.equal(searches,0,'Opening is not search consent');assert.equal(fetches,0);
    await query.fill('明确发送的检索词');await search();
    assert.equal(writes.filter(w=>w.url.endsWith('/search')).at(-1).body.query,'明确发送的检索词');
    assert.equal(writes.filter(w=>w.url.endsWith('/search')).at(-1).body.allowAutomaticApply,false);
    assert.equal(fetches,0,'Search cannot fetch lyrics');assert.equal(await apply.isEnabled(),false);
    assert.match(await panel.textContent(),/曲名一致.*歌手一致.*时长差 1.200/s);

    await auto.check();
    reply.candidates[0]={...reply.candidates[0],title:track.title,artist:track.artist,album:track.album,durationMs:track.duration_ms,
      evidence:{titleEqual:true,artistEqual:true,albumEqual:true,durationDeltaMs:0,versionMismatch:false,strongMetadataMatch:true,automaticApplyAllowed:true,reasons:['title_equal','artist_equal','album_equal','duration_close']}};
    reply.automaticApplyAllowed=true;
    const automaticRequests=[];
    const automaticApplyRoute=async route=>{
      const body=route.request().postDataJSON();
      if(body.automaticApply){automaticRequests.push(body);await route.fulfill({json:{ok:true,source:'imported',format:'lrc',lyricsRevision:initial.lyricsRevision}});}
      else await route.fallback();
    };
    await page.route('**/lyrics/candidates/apply',automaticApplyRoute);
    await submit.click();await status.filter({hasText:'歌词已应用'}).waitFor();
    assert.equal(writes.filter(w=>w.url.endsWith('/search')).at(-1).body.allowAutomaticApply,true);
    assert.equal(automaticRequests.length,1);assert.equal(automaticRequests[0].automaticApply,true);
    assert.equal((await fixture.api(root)).lyricsRevision,initial.lyricsRevision,'auto UI flow is fixture-routed and does not mutate the service');
    await page.unroute('**/lyrics/candidates/apply',automaticApplyRoute);
    reply.automaticApplyAllowed=false;await auto.uncheck();await reset();await search();

    await preview();assert.equal((await fixture.api(root)).lyricsRevision,initial.lyricsRevision);
    assert.match(await panel.textContent(),/未提供歌词再分发许可/);assert.equal(await apply.isEnabled(),true);
    await page.setViewportSize({width:390,height:760});await panel.scrollIntoViewIfNeeded();
    assert.equal(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
    const bounds=await panel.boundingBox();assert.ok(bounds.x>=0 && bounds.x+bounds.width<=391);
    fs.mkdirSync(path.resolve('output/playwright'),{recursive:true});
    await page.screenshot({path:path.resolve('output/playwright/lyric-online-390.png')});
    await apply.click();await status.filter({hasText:'歌词已应用'}).waitFor();
    assert.equal((await fixture.api(root)).lines[0].text,'受控预览');
    const applyWrites=writes.filter(w=>w.url.endsWith('/candidates/apply'));
    assert.equal(applyWrites.length,2,'fixture covers one automatic and one confirmed manual apply');
    assert.deepEqual(applyWrites.map(w=>w.body.automaticApply),[true,false]);
    assert.equal(writes.filter(w=>w.method==='PUT' && w.url.endsWith('/lyrics')).length,0);
    await page.setViewportSize({width:1280,height:850});
    await reset();await open();searchFailure=true;await submit.click();await status.filter({hasText:'受控搜索失败'}).waitFor();
    assert.equal(await apply.isEnabled(),false);searchFailure=false;await search();
    prepareFailure=true;await panel.locator('[data-lyric-check]').click();await status.filter({hasText:'没有带时间歌词'}).waitFor();
    assert.equal(await apply.isEnabled(),false);prepareFailure=false;await preview();
    await query.fill('changed');assert.equal(await apply.isEnabled(),false);assert.equal(await panel.locator('[data-lyric-check]').count(),0);
    await search();await preview();await panel.locator('[data-lyric-source]').selectOption(sources[1].id);
    assert.equal(await apply.isEnabled(),false);assert.equal(await panel.locator('[data-lyric-check]').count(),0);
    // Deliberately delayed UI observations exercise invalidation, not upstream acceptance.
    async function delayed(kind,action){
      let release,arrive,finish;const hold=new Promise(r=>release=r),waiting=new Promise(r=>arrive=r),done=new Promise(r=>finish=r);
      const pattern='**/lyrics/candidates/'+kind;
      const handler=async route=>{arrive();await hold;try{await route.fulfill({json:kind==='search'?reply:onlinePreview()});}catch{}finally{finish();}};
      await page.route(pattern,handler);
      try{
        if(kind==='search')await submit.click();else await panel.locator('[data-lyric-check]').click();
        await waiting;await action();release();await done;
      }finally{release();await page.unroute(pattern,handler);}
    }
    const applyCount=writes.filter(w=>w.url.endsWith('/candidates/apply')).length;
    await delayed('search',async()=>{await query.fill('invalidate pending search');});
    assert.equal(await panel.locator('[data-lyric-check]').count(),0);assert.equal(await apply.isEnabled(),false);
    await search();await delayed('prepare-online',async()=>{await query.fill('invalidate pending lyric');});
    assert.equal(await apply.isEnabled(),false);assert.match(await status.textContent(),/检索条件已改变/);
    await search();await delayed('prepare-online',async()=>{await panel.locator('[data-lyric-import-cancel]').click();});
    assert.equal(await panel.isVisible(),false);
    await open();await search();await delayed('prepare-online',async()=>{await page.locator('#np-tools-close').click();});
    assert.equal(await panel.isVisible(),false);
    await open();await search();await delayed('prepare-online',async()=>{await page.locator('#np-close').click();});
    assert.equal(await panel.isVisible(),false);
    await open();await search();await delayed('prepare-online',async()=>{
      await page.locator('#np-lyric-file').setInputFiles({name:'newer.lrc',mimeType:'text/plain',buffer:Buffer.from('[00:01.00]本地选择优先')});
      await status.filter({hasText:'尚未应用'}).waitFor();
    });
    assert.match(await panel.locator(':scope > strong').textContent(),/newer.lrc/);assert.match(await status.textContent(),/本地导入/);
    assert.equal(writes.filter(w=>w.url.endsWith('/candidates/apply')).length,applyCount,'Late replies never apply');
    assert.deepEqual(errors,[]);
    console.log('PASS online lyric UI fixtures: edition gate, explicit search/select/preview/apply, real parser/write, errors/retry, query/source/local/close invalidation, 390px layout; no real provider acceptance');
  }finally{if(context)await context.close();if(browser)await browser.close();await fixture.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
