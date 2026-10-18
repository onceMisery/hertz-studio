// SPDX-License-Identifier: MIT
// Real parser/store/Stage journey; controlled replies are only lifecycle fixtures.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {startFixture}=require('./ui-browser-fixture'),{uiUrl}=require('./ui-token');
const lrc='[offset:100]\n[00:01.00]你好[00:01.50]世界\n[00:04.00]Second line';
const xml='<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div begin="1s"><p begin="1s" end="4s"><span begin="0s" end="1s">你</span><span begin="1s" end="2s">好</span><span ttm:role="x-translation">Hello</span><span ttm:role="x-roman">nǐ hǎo</span></p></div></body></tt>';
async function main(){
  const fixture=await startFixture();process.env.VMUSIC_DATA_DIR=fixture.dataDir;let browser,context;
  try{
    const track=await fixture.seed(),root='/v1/tracks/'+encodeURIComponent(track.id)+'/lyrics';
    const otherPath=path.join(path.dirname(track.path),'other.wav');fs.copyFileSync(track.path,otherPath);
    await fixture.api('/v1/library/scan','POST',{root:path.dirname(track.path)});
    for(let i=0;i<200 && (await fixture.api('/v1/library/status')).running;i++)await new Promise(r=>setTimeout(r,100));
    const other=(await fixture.api('/v1/tracks?limit=10')).tracks.find(t=>t.path===otherPath);
    assert.ok(other,'Second real local track for switch races');
    await fixture.api(root+'/offset','PUT',{offset_ms:250});
    await fixture.api('/v1/settings','PUT',{global_lyric_offset_ms:500,lyrics_staff_policy:'keep'});
    const original=await fixture.api(root);
    browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome',headless:true});
    context=await browser.newContext({viewport:{width:1280,height:850}});await fixture.connect(context);
    const page=await context.newPage(),errors=[],writes=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(r.method()!=='GET' && r.url().includes('/lyrics'))writes.push({method:r.method(),url:r.url(),body:r.postDataJSON()});});
    await page.goto(uiUrl(fixture.base));
    await page.waitForFunction(id=>Stage.presentation().track?.id===id && Stage.presentation().mediaTrackId===id,track.id);
    async function tools(){
      if(!await page.locator('#np-modal').isVisible())await page.locator('#bar-player-expand').click();
      if(!await page.locator('#np-tools').isVisible())await page.locator('#np-more').click();
    }
    async function choose(name,content){await tools();await page.locator('#np-lyric-file').setInputFiles({name,mimeType:'text/plain',buffer:Buffer.from(content)});}
    const status=page.locator('[data-lyric-import-status]'),apply=page.locator('[data-lyric-import-apply]'),panel=page.locator('#np-lyric-import-panel');
    async function ready(){await status.filter({hasText:'尚未应用'}).waitFor();assert.equal(await apply.isEnabled(),true);}
    async function confirm(){await apply.click();await status.filter({hasText:'歌词已应用'}).waitFor();}
    await choose('fixture.lrc',lrc);await ready();
    assert.equal((await fixture.api(root)).lyricsRevision,original.lyricsRevision,'Selecting/preparing cannot write');
    assert.equal(writes.filter(w=>w.url.endsWith('/candidates/apply')).length,0);
    await confirm();
    let saved=await fixture.api(root);
    assert.equal(saved.user_offset_ms,250);assert.equal(saved.lines[0].start_ms,1350);
    await page.waitForFunction(()=>Stage.lyrics()?.lines[0].start_ms===1850 && Stage.lyricOffset()===250);
    let obs=await fixture.api('/v1/overlay/lyric');
    assert.equal(obs.lines[0].startTime,1.85);assert.equal(obs.lines[0].words[1].startTime,2.35);
    await page.locator('#np-tools-close').click();await page.locator('#np-tab-lyrics').evaluate(el=>el.click());
    await page.locator('#np-lyric-lines').filter({hasText:'你好世界'}).waitFor();

    await choose('fixture.ttml',xml);await ready();await confirm();
    saved=await fixture.api(root);assert.equal(saved.format,'ttml');assert.equal(saved.timing_precision,'word');
    assert.deepEqual(saved.translation,['Hello']);assert.deepEqual(saved.romanization,['nǐ hǎo']);
    assert.equal(saved.lines[0].start_ms,2250);assert.equal(saved.lines[0].words[1].start_ms,3250);
    await page.waitForFunction(()=>Stage.lyrics()?.lines[0].start_ms===2750 && Stage.lyricTranslation(0)==='Hello');
    obs=await fixture.api('/v1/overlay/lyric');assert.equal(obs.lines[0].startTime,2.75);assert.equal(obs.lines[0].romanization,'nǐ hǎo');

    await choose('bad.ttml','<bad>not lyrics</bad>');
    await status.filter({hasText:'request_id'}).waitFor();assert.equal(await apply.isEnabled(),false);
    assert.equal((await fixture.api(root)).lyricsRevision,saved.lyricsRevision);
    const preparedBefore=writes.filter(w=>w.url.endsWith('/candidates')).length;
    await page.locator('#np-lyric-file').setInputFiles({name:'invalid-utf8.lrc',mimeType:'text/plain',buffer:Buffer.concat([Buffer.from('[00:01.00]'),Buffer.from([255])])});
    await status.filter({hasText:'有效的 UTF-8'}).waitFor();assert.equal(await apply.isEnabled(),false);
    assert.equal(writes.filter(w=>w.url.endsWith('/candidates')).length,preparedBefore,'Invalid UTF-8 cannot be normalized into a different lyric');
    await choose('stale.lrc',lrc);await ready();
    await fixture.api(root+'/offset','PUT',{offset_ms:500});
    await apply.click();await status.filter({hasText:'已改变'}).waitFor();assert.equal(await apply.isEnabled(),false);
    assert.equal((await fixture.api(root)).format,'ttml');
    await choose('retry.lrc',lrc);await ready();await confirm();
    assert.equal((await fixture.api(root)).user_offset_ms,500);
    assert.equal(writes.filter(w=>w.method==='PUT' && w.url.endsWith('/lyrics')).length,0,'New UI cannot use immediate legacy PUT');

    await page.setViewportSize({width:390,height:760});
    await choose('窄屏检查.ttml',xml);await ready();
    await panel.scrollIntoViewIfNeeded();
    const bounds=await panel.boundingBox();assert.ok(bounds.x>=0 && bounds.x+bounds.width<=391);
    assert.equal(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
    fs.mkdirSync(path.resolve('output/playwright'),{recursive:true});
    await page.screenshot({path:path.resolve('output/playwright/lyric-import-390.png')});
    await page.locator('[data-lyric-import-cancel]').click();assert.equal(await panel.isVisible(),false);
    await page.setViewportSize({width:1280,height:850});

    // Real service prepares the payload before observation is deliberately delayed.
    const fresh=await fixture.api(root);
    const candidate=await fixture.api(root+'/candidates','POST',{content:lrc,format:'lrc',expectedMetadataRevision:fresh.metadataRevision,expectedLyricsRevision:fresh.lyricsRevision});
    async function delayed(action){
      let release,arrive,finish;
      const hold=new Promise(r=>release=r),waiting=new Promise(r=>arrive=r),done=new Promise(r=>finish=r);
      let calls=0;
      const handler=async route=>{if(calls++)return route.continue();arrive();await hold;try{await route.fulfill({json:candidate});}catch{}finally{finish();}};
      await page.route('**/lyrics/candidates',handler);
      try{await choose('late.lrc',lrc);await waiting;await action();release();await done;}
      finally{release();await page.unroute('**/lyrics/candidates',handler);}
    }
    let applyCount=writes.filter(w=>w.url.endsWith('/candidates/apply')).length;
    await delayed(async()=>{await page.locator('[data-lyric-import-cancel]').click();});
    assert.equal(await panel.isVisible(),false);
    await delayed(async()=>{await page.locator('#np-tools-close').click();});
    assert.equal(await panel.isVisible(),false);
    await delayed(async()=>{await page.locator('#np-close').click();});
    assert.equal(await panel.isVisible(),false);
    await delayed(async()=>{await fixture.api('/v1/player/load','POST',{track_id:other.id});await fixture.api('/v1/player/pause','POST',{});await page.waitForFunction(id=>Stage.presentation().mediaTrackId===id,other.id);});
    assert.equal(await panel.isVisible(),false);
    assert.equal(writes.filter(w=>w.url.endsWith('/candidates/apply')).length,applyCount,'Late preparation must never auto-apply');
    await fixture.api('/v1/player/load','POST',{track_id:track.id});await fixture.api('/v1/player/pause','POST',{});
    await page.waitForFunction(id=>Stage.presentation().mediaTrackId===id,track.id);
    await delayed(async()=>{await choose('newer.ttml',xml);await ready();});
    assert.match(await panel.locator('strong').textContent(),/newer.ttml/);
    assert.match(await status.textContent(),/TTML/);
    await page.locator('[data-lyric-import-cancel]').click();
    await choose('explicit-retry.lrc',lrc);await ready();
    await page.locator('[data-lyric-import-cancel]').click();
    assert.deepEqual(errors,[]);
    console.log('PASS lyric import: real LRC/TTML prepare-confirm, shared Stage/OBS timing, per-track calibration, invalid/stale rejection, lifecycle cancellation, retry and 390px layout');
  }finally{if(context)await context.close();if(browser)await browser.close();await fixture.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
