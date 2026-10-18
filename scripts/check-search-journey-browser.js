// SPDX-License-Identifier: MIT
// Real isolated UI, controlled source responses, no external search or playback.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { uiUrl } = require('./ui-token');
const output = path.resolve(__dirname, '../output/playwright/search-journey');
async function main() {
  fs.mkdirSync(output, {recursive:true});
  const fixture = await startFixture();
  process.env.VMUSIC_DATA_DIR = fixture.dataDir;
  const browser = await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome',headless:true});
  const context = await browser.newContext({viewport:{width:1440,height:960}});
  await fixture.connect(context);
  const page = await context.newPage(), errors = [], requests = [], releases = new Map();
  let active = 0, maxActive = 0;
  page.on('pageerror', e => errors.push(e.message));
  const sources = ['netease','qq','kugou'].map((id,i) => ({id,label:['网易云音乐','QQ音乐','酷狗音乐'][i],kind:'music',caps:[],cats:[]}));
  const track = (source, id, q) => ({source,id:String(id),title:q + ' ' + source + ' ' + id,artist:'Fixture',album:'Search',duration_ms:180000,playable:true,track_ref:{source,id:String(id)}});
  await page.route('**/v1/online/sources', route => route.fulfill({json:{sources}}));
  await page.route('**/v1/tracks?**', route => {
    const q = new URL(route.request().url()).searchParams.get('q') || '';
    if (!q.startsWith('R1')) return route.continue();
    return route.fulfill({json:{tracks:[track('local','local-1',q)],total:1}});
  });
  await page.route('**/v1/online/search?**', async route => {
    const url = new URL(route.request().url()), source = url.searchParams.get('source'), q = url.searchParams.get('q') || '';
    const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 20);
    requests.push({q,source,offset}); active++; maxActive = Math.max(maxActive, active);
    try {
      if (q.includes('slow') && source === 'qq') await new Promise(resolve => releases.set(q, resolve));
      const attempt = requests.filter(r => r.q === q && r.source === source && r.offset === offset).length;
      if (source === 'kugou' && attempt === 1) {
        await route.fulfill({status:504,json:{error:{code:'upstream_timeout',request_id:'r1-timeout',message:'fixture timeout'}}}); return;
      }
      const count = offset ? 2 : source === 'netease' ? limit : 2;
      await route.fulfill({json:{tracks:Array.from({length:count},(_,i)=>track(source,offset+i,q)),total:source==='netease'?22:2}});
    } catch (e) {
      if (!/closed|handled|Invalid Interception/i.test(e.message)) throw e;
    } finally { active--; }
  });
  const release = q => { const fn = releases.get(q); assert.ok(fn,'slow source was started: ' + q); releases.delete(q); fn(); };
  const count = (q,source) => requests.filter(r=>r.q===q && r.source===source).length;
  try {
    await page.goto(uiUrl(fixture.base),{waitUntil:'domcontentloaded'});
    await page.waitForFunction(() => Online.sources().length === 3);
    await page.getByRole('button',{name:'在线曲库',exact:true}).click();
    await page.getByRole('combobox',{name:'音源',exact:true}).selectOption('all');
    await page.locator('#online-q').fill('R1 online slow');
    await page.getByRole('button',{name:'搜索',exact:true}).click();
    await page.waitForFunction(() => Online.state.tracks.length===20 && Online.state.loading);
    const onlineRow = page.locator('.online-row').first();
    await onlineRow.evaluate(el => { window.r1OnlineRow = el; el.querySelector('button').focus(); });
    release('R1 online slow');
    await page.waitForFunction(() => !Online.state.loading);
    assert.equal(await page.evaluate(() => r1OnlineRow.isConnected && r1OnlineRow.contains(document.activeElement)),true,'late source preserves successful row and focus');
    assert.match(await onlineRow.getAttribute('data-online-id'),/^online:netease:/,'stable source grouping');
    const failed = page.locator('.search-source-status[data-error-code="upstream_timeout"]');
    assert.equal(await failed.getAttribute('data-request-id'),'r1-timeout');
    await failed.getByRole('button',{name:'重试',exact:true}).click();
    await page.waitForFunction(() => Online.state.tracks.length===24);
    assert.equal(count('R1 online slow','netease'),1,'source retry retains successful response');
    await page.locator('.search-source-status').filter({hasText:'网易云音乐'}).getByRole('button',{name:'加载更多',exact:true}).click();
    await page.waitForFunction(() => Online.state.tracks.length===26);
    assert.ok(requests.some(r=>r.q==='R1 online slow' && r.source==='netease' && r.offset===20));
    assert.ok(maxActive<=2,'actual initial/retry/page source reads share limit');
    await page.screenshot({path:path.join(output,'online.png')});

    // Topbar progressive groups, local retry, immediate input invalidation and close.
    await page.locator('#search').fill('R1 top slow');
    await page.waitForFunction(() => document.querySelectorAll('.ts-menu .ts-row').length===8);
    const tsNet = page.locator('.ts-menu section[data-source="netease"] .ts-row').first();
    await tsNet.evaluate(el=>{window.r1TopRow=el;});
    release('R1 top slow');
    await page.locator('.ts-menu').getByRole('button',{name:'重试 酷狗音乐',exact:true}).click();
    await page.waitForFunction(() => TopSearch.state.previewTracks.length===12);
    assert.equal(await page.evaluate(()=>r1TopRow.isConnected),true);
    assert.equal(count('R1 top slow','netease'),1);
    await page.locator('#search').fill('R1 top canceled slow');
    assert.equal(await page.locator('.ts-menu .ts-row').count(),0,'new input clears stale selectable rows before debounce');
    await page.waitForFunction(()=>TopSearch.state.previewTracks.length===8);
    await page.keyboard.press('Escape');
    release('R1 top canceled slow');
    assert.equal(await page.evaluate(()=>TopSearch.state.network===null && !TopSearch.isOpen()),true);

    // Space uses the actual app host, including local normalization and retry closures.
    await page.locator('#space3d-entry').click();
    await page.locator('#sh-query').fill('R1 space slow');
    await page.waitForFunction(()=>document.querySelectorAll('.sh-panel-body .sh-track').length===21);
    const local = page.locator('.sh-search-source[data-source="local"] .sh-track');
    assert.equal(await local.count(),1,'local source identity remains visible in grouped results');
    await page.locator('.sh-search-source[data-source="netease"] .sh-track').first().evaluate(el=>{
      window.r1SpaceRow=el; el.querySelector('button').focus();
    });
    release('R1 space slow');
    await page.locator('.sh-search-source[data-source="qq"] .sh-track').first().waitFor();
    assert.equal(await page.evaluate(()=>r1SpaceRow.isConnected && r1SpaceRow.contains(document.activeElement)),true);
    const spaceError = page.locator('.sh-search-source[data-source="kugou"]');
    await spaceError.getByRole('button',{name:'重试 酷狗音乐',exact:true}).click();
    await spaceError.locator('.sh-track').first().waitFor();
    assert.equal(await spaceError.locator('.sh-track').count(),2,'retry after initial completion still publishes');
    assert.equal(count('R1 space slow','netease'),1);
    await page.getByRole('button',{name:'加载更多 · 网易云音乐',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.sh-search-source[data-source="netease"] .sh-track').length===22);
    assert.equal(await page.evaluate(()=>r1SpaceRow.isConnected),true);
    await page.screenshot({path:path.join(output,'space.png')});
    await page.locator('#sh-query').fill('R1 space canceled slow');
    assert.equal(await page.locator('.sh-panel-body .sh-track').count(),0);
    await page.waitForFunction(()=>document.querySelectorAll('.sh-panel-body .sh-track').length===21);
    await page.keyboard.press('Escape'); release('R1 space canceled slow');
    await page.locator('#sh-query').fill('R1 space new');
    await page.waitForFunction(()=>document.querySelector('.sh-panel-body .sh-track strong')?.textContent.includes('R1 space new'));
    assert.equal(await page.locator('.sh-panel-body').getByText(/R1 space canceled/).count(),0);
    await page.evaluate(()=>Space3D.close());

    // The persistent Liunian panel joins the same coordinator and exposes source failures.
    await page.evaluate(()=>Skins.apply('liunian'));
    await page.locator('.ln-sp-q').fill('R1 liunian');
    const lnError = page.locator('.ln-sp-sec').filter({has:page.locator('[data-error-code="upstream_timeout"]')}).last();
    await lnError.getByRole('button',{name:'重试',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.ln-sp-row').length===8);
    assert.equal(count('R1 liunian','netease'),1);
    await page.locator('.ln-sp-q').fill('R1 liunian canceled slow');
    await page.waitForFunction(()=>document.querySelectorAll('.ln-sp-row').length===4);
    await page.evaluate(()=>Skins.apply('default'));
    release('R1 liunian canceled slow');
    await page.waitForFunction(()=>!document.querySelector('.ln-sp'));
    assert.deepEqual(errors,[]);
    console.log('Search browser journeys passed: online/topbar/space/Liunian progressive groups, local identity, source retry/paging, preserved rows/focus, immediate invalidation, close/unmount and shared two-call admission');
  } finally {
    releases.forEach(fn=>fn());
    await browser.close(); await fixture.close();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
