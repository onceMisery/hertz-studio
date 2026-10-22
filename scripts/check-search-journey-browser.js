// SPDX-License-Identifier: MIT
// Real isolated UI, controlled source responses, no external search or playback.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { uiUrl } = require('./ui-token');
const output = path.resolve(process.env.SEARCH_JOURNEY_OUTPUT || path.join(__dirname, '../output/playwright/search-journey'));
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
  const sources = ['netease','qq','kugou'].map((id,i) => ({id,label:['网易云音乐','QQ音乐','酷狗音乐'][i],kind:'music',
    caps:['playlist_search','artist_search'],cats:[]}));
  const track = (source, id, q) => ({source,id:String(id),title:q + ' ' + source + ' ' + id,artist:'Fixture',album:'Search',duration_ms:180000,playable:true,track_ref:{source,id:String(id)}});
  let failSourcesOnce = false;
  await page.route('**/v1/online/sources', route => {
    if (failSourcesOnce) {
      failSourcesOnce = false;
      return route.fulfill({status:400,json:{error:{code:'fixture_sources_unavailable',message:'fixture source list failure'}}});
    }
    return route.fulfill({json:{sources}});
  });
  let emptySearchRequests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if ((url.pathname === '/v1/tracks' || url.pathname === '/v1/online/search') && url.searchParams.get('q') === '') {
      emptySearchRequests.push(url.pathname);
    }
  });
  await page.route('**/v1/tracks?**', route => {
    const q = new URL(route.request().url()).searchParams.get('q') || '';
    if (!q) return route.fulfill({json:{tracks:[],total:0}});
    if (!q.startsWith('R1')) return route.continue();
    return route.fulfill({json:{tracks:[track('local','local-1',q)],total:1}});
  });
  await page.route('**/v1/online/search?**', async route => {
    const url = new URL(route.request().url()), source = url.searchParams.get('source'), q = url.searchParams.get('q') || '';
    const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 20);
    requests.push({q,source,offset}); active++; maxActive = Math.max(maxActive, active);
    try {
      if (!q) { await route.fulfill({json:{tracks:[],total:0}}); return; }
      if (q.includes('slow') && source === 'qq') await new Promise(resolve => releases.set(q, resolve));
      if (q === 'R1 online slow' && source === 'netease' && offset > 0) {
        await new Promise(resolve => releases.set(q + ':page', resolve));
      }
      const attempt = requests.filter(r => r.q === q && r.source === source && r.offset === offset).length;
      if (source === 'kugou' && attempt === 1) {
        await route.fulfill({status:400,json:{error:{code:'upstream_timeout',request_id:'r1-timeout',message:'fixture timeout'}}}); return;
      }
      const count = offset ? 2 : source === 'netease' ? limit : 2;
      await route.fulfill({json:{tracks:Array.from({length:count},(_,i)=>track(source,offset+i,q)),total:source==='netease'?22:2}});
    } catch (e) {
      if (!/closed|handled|Invalid Interception/i.test(e.message)) throw e;
    } finally { active--; }
  });
  await page.route('**/v1/online/playlists/search?**', route =>
    route.fulfill({json:{source:'netease',keyword:'fixture',total:1,playlists:[{
      source:'netease',id:'fixture-playlist',name:'Fixture playlist',track_count:3,kind:'created',
    }]}}));
  await page.route('**/v1/online/artists/search?**', route =>
    route.fulfill({json:{source:'netease',keyword:'fixture',total:1,artists:[{
      source:'netease',id:'fixture-artist',name:'Fixture artist',song_count:3,
    }]}}));
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
    assert.equal(await page.evaluate(() => document.activeElement.dataset.source), 'kugou',
      'successful source retry moves focus to its status when retry control disappears');
    assert.equal(count('R1 online slow','netease'),1,'source retry retains successful response');
    const loadMore = page.locator('.search-source-status').filter({hasText:'网易云音乐'}).getByRole('button',{name:'加载更多',exact:true});
    await loadMore.focus();
    await loadMore.click();
    await page.waitForFunction(() => document.querySelector('.search-source-status[data-source="netease"] button')?.disabled);
    await page.locator('#online-q').focus();
    release('R1 online slow:page');
    await page.waitForFunction(() => Online.state.tracks.length===26);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'online-q',
      'last-page completion does not steal focus after the user moves to the search input');
    assert.ok(requests.some(r=>r.q==='R1 online slow' && r.source==='netease' && r.offset===20));
    assert.ok(maxActive<=2,'actual initial/retry/page source reads share limit');
    await page.screenshot({path:path.join(output,'online.png')});

    // Topbar progressive groups, local retry, immediate input invalidation and close.
    await page.locator('#search').fill('R1 top slow');
    await page.waitForFunction(() => document.querySelectorAll('.ts-menu .ts-row').length===8);
    const tsNet = page.locator('.ts-menu section[data-source="netease"] .ts-row').first();
    await tsNet.evaluate(el=>{window.r1TopRow=el;});
    release('R1 top slow');
    const topRetry = page.locator('.ts-menu').getByRole('button',{name:'重试 酷狗音乐',exact:true});
    await topRetry.focus();
    await topRetry.click();
    await page.waitForFunction(() => TopSearch.state.previewTracks.length===12);
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('ts-hint')), true,
      'topbar retry keeps focus on its source status');
    assert.equal(await page.evaluate(()=>r1TopRow.isConnected),true);
    assert.equal(count('R1 top slow','netease'),1);
    const tsQqRows = page.locator('.ts-menu section[data-source="qq"] .ts-row');
    const selectedQqTitle = await tsQqRows.nth(1).locator('.t-title').textContent();
    await page.evaluate(() => {
      window.r1TopPlayCapture = null;
      Online.playAll = (tracks, index) => {
        window.r1TopPlayCapture = {
          sources: tracks.map(track => track.source),
          titles: tracks.map(track => track.title),
          index,
        };
      };
    });
    await tsQqRows.nth(1).click();
    const topPlayCapture = await page.evaluate(() => window.r1TopPlayCapture);
    assert.deepEqual(topPlayCapture.sources, ['qq', 'qq'],
      'topbar playback queue contains only the clicked source');
    assert.equal(topPlayCapture.titles[topPlayCapture.index], selectedQqTitle,
      'topbar playback starts from the clicked row in its source queue');
    await page.locator('#search').fill('R1 top canceled slow');
    assert.equal(await page.locator('.ts-menu .ts-row').count(),0,'new input clears stale selectable rows before debounce');
    await page.waitForFunction(()=>TopSearch.state.previewTracks.length===8);
    await page.keyboard.press('Escape');
    release('R1 top canceled slow');
    assert.equal(await page.evaluate(()=>TopSearch.state.network===null && !TopSearch.isOpen()),true);

    // Local mode keeps the library's type-to-filter behavior while preserving
    // a reachable way back to the online search ranges.
    await page.locator('#search').fill('R1 top mode switch');
    await page.waitForFunction(() => TopSearch.state.previewTracks.length >= 8);
    await page.keyboard.press('Escape');
    await page.locator('#search').click();
    await page.locator('.ts-chip[data-kind="local"]').click();
    assert.equal(await page.evaluate(() => !TopSearch.isOpen() && TopSearch.kind() === 'local'),true);
    await page.locator('#search').click();
    await page.waitForSelector('.ts-menu:not([hidden])');
    assert.equal(await page.locator('.ts-chip[data-kind="local"]').getAttribute('aria-pressed'),'true');
    const localFilterRequest = page.waitForRequest(request => {
      const url = new URL(request.url());
      return url.pathname === '/v1/tracks' && url.searchParams.get('q') === 'R1 local mode filter';
    });
    await page.locator('#search').fill('R1 local mode filter');
    await page.waitForFunction(() => !TopSearch.isOpen());
    await localFilterRequest;
    await page.locator('#search').click();
    await page.locator('.ts-chip[data-kind="song"]').click();
    await page.waitForFunction(() => TopSearch.kind() === 'song' && TopSearch.state.previewTracks.length > 0);
    assert.equal(await page.evaluate(() => TopSearch.isOpen()),true,'topbar can return from local filtering to online search');

    // Space uses the actual app host, including local normalization and retry closures.
    await page.evaluate(() => localStorage.setItem('vmusic.search-history', JSON.stringify({v:1,items:['R1 saved history']})));
    emptySearchRequests = [];
    await page.locator('#space3d-entry').click();
    await page.locator('#sh-query').focus();
    await page.getByRole('button', {name:'R1 saved history',exact:true}).waitFor();
    await page.waitForTimeout(150);
    assert.equal(await page.getByRole('button', {name:'R1 saved history',exact:true}).count(),1,
      'space search history remains visible while the query is empty');
    assert.deepEqual(emptySearchRequests,[], 'opening space search history does not issue empty local or online queries');
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
    const spaceRetry = spaceError.getByRole('button',{name:'重试 酷狗音乐',exact:true});
    await spaceRetry.focus();
    await spaceRetry.click();
    await spaceError.locator('.sh-track').first().waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.dataset.searchStatus), 'true',
      'space source retry transfers focus to its status when the action is removed');
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
    failSourcesOnce = true;
    await page.evaluate(()=>Skins.apply('liunian'));
    await page.locator('.ln-sp-q').fill('R1 liunian');
    const sourcesRetry = page.getByRole('button',{name:'重试读取音源',exact:true});
    await sourcesRetry.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelectorAll('.ln-sp-row').length===6
      && document.querySelector('[data-error-code="upstream_timeout"]'));
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('ln-sp-q')),true,
      'Liunian source-list retry returns focus to the search field after recovery');
    const lnError = page.locator('.ln-sp-sec').filter({hasText:'酷狗音乐'}).last();
    assert.equal(await lnError.locator('[data-error-code="upstream_timeout"]').count(),1,
      'Liunian provider failure belongs to the Kugou result group');
    const lnRetry = lnError.locator('button.ln-sp-more');
    await lnRetry.evaluate(el => { window.r1LiunianRetry = el; });
    await lnRetry.focus();
    await lnRetry.click();
    await page.waitForFunction(()=>document.querySelectorAll('.ln-sp-row').length===8);
    assert.equal(await page.evaluate(() => document.activeElement === window.r1LiunianRetry && !window.r1LiunianRetry.hidden), true,
      'Liunian keeps the retry control focused while converting it to the next action');
    assert.equal(count('R1 liunian','netease'),1);
    await page.locator('.ln-sp-q').fill('R1 liunian canceled slow');
    await page.waitForFunction(()=>document.querySelectorAll('.ln-sp-row').length===4);
    await page.evaluate(()=>Skins.apply('default'));
    release('R1 liunian canceled slow');
    await page.waitForFunction(()=>!document.querySelector('.ln-sp'));

    const visibleSkins = await page.evaluate(() => Skins.list().map(skin => skin.id));
    assert.deepEqual(visibleSkins, ['classic','liunian','qingfeng','heijiao','orbit'],
      'the public skin list matches the five supported layouts');
    await page.getByRole('button',{name:'在线曲库',exact:true}).click();
    await page.getByRole('combobox',{name:'音源',exact:true}).selectOption('netease');
    await page.locator('#search').click();
    await page.setViewportSize({width:390,height:420});
    for (const skin of visibleSkins) {
      await page.evaluate(id => Skins.apply(id), skin);
      await page.waitForFunction(id => id === 'classic' || !!document.querySelector('link[data-skin-css="' + id + '"]').sheet, skin);
      const search = page.locator('#search');
      if (skin === 'qingfeng') {
        assert.equal(await search.isVisible(),false,'Qingfeng intentionally hides topbar search below 900px');
        await page.setViewportSize({width:1440,height:420});
      }
      await search.evaluate(el => el.focus({preventScroll:true}));
      await search.fill('R1 skin ' + skin);
      await page.locator('.ts-menu:not([hidden]) .ts-row, .ts-menu:not([hidden]) .ts-card').first().waitFor();
      const geometry = await page.evaluate(() => {
        const menu = document.querySelector('.ts-menu').getBoundingClientRect();
        const body = document.querySelector('.ts-body');
        return {left:menu.left,right:menu.right,bottom:menu.bottom,
          scrollHeight:body.scrollHeight,clientHeight:body.clientHeight,
          viewportWidth:innerWidth,viewportHeight:innerHeight};
      });
      assert.ok(geometry.left >= 0 && geometry.right <= geometry.viewportWidth,
        skin + ' top-search panel stays within the narrow viewport');
      assert.ok(geometry.bottom <= geometry.viewportHeight,
        skin + ' top-search panel stays above the viewport bottom');
      assert.ok(geometry.scrollHeight >= geometry.clientHeight,
        skin + ' top-search results remain in a scrollable panel');
      const keyboardKind = await page.evaluate(() => TopSearch.state.kind === 'playlist' ? 'artist' : 'playlist');
      await page.locator('.ts-chip[data-kind="' + keyboardKind + '"]').evaluate(el => el.focus({preventScroll:true}));
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.kind), keyboardKind,
        skin + ' keyboard activation keeps focus on the newly rendered range chip');
      const chipFocus = await page.evaluate(() => ({
        id: document.activeElement.id, className: document.activeElement.className,
        insideMenu: document.querySelector('.ts-menu').contains(document.activeElement),
      }));
      assert.ok(chipFocus.insideMenu, skin + ' search chip receives focus before Escape: ' + JSON.stringify(chipFocus));
      await page.keyboard.press('Escape');
      const escapeState = await page.evaluate(() => ({
        open: TopSearch.isOpen(), activeId: document.activeElement.id,
        activeClass: document.activeElement.className,
        menuHidden: document.querySelector('.ts-menu').hidden,
        spaceActive: !!(Space3D && Space3D.isActive && Space3D.isActive()),
      }));
      assert.equal(!escapeState.open && escapeState.activeId === 'search',true,
        skin + ' Escape closes the panel and restores focus to search: ' + JSON.stringify(escapeState));
    }
    assert.deepEqual(errors,[]);
    console.log('Search browser journeys passed: online/topbar/space/Liunian progressive groups, seven public skins, narrow viewport bounds, Escape focus restoration, local identity, source retry/paging, preserved rows/focus, immediate invalidation, close/unmount and shared two-call admission');
  } finally {
    releases.forEach(fn=>fn());
    await browser.close(); await fixture.close();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
