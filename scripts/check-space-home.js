#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, 'plugin/ui', file), 'utf8');

async function bridgeContract() {
  const app = read('app.js');
  const source = app.slice(app.indexOf('function initSpaceHome('), app.indexOf('// 首页那一格右键'));
  let host;
  const commands = [], requests = [];
  const local = { id: 'local-a', title: 'Local', has_cover: true };
  const online = { id: 'remote-a', source: 'netease', virtual_id: 'online:netease:remote-a', title: 'Remote', cover: 'https://cover.example/a.jpg', vip_only: true };
  const context = {
    window: { SpaceHome: {}, Online: { sources: () => [{ id: 'netease', label: '网易云' }], searchSources: () => ['netease'], whenSearchReady: () => Promise.resolve(), safeCoverUrl: (url) => url, getMeta: () => null,
      playOne: track => commands.push({ single: track }) }, Space3D: { openQueue: () => commands.push('queue') } },
    state: { byId: new Map(), tracks: [local], queue: ['current'], settings: {} }, plCovers: null,
    homeSnapshot: () => ({ current: local, playing: false, queueLength: 1 }),
    onlineItemId: (track) => String(track.id).startsWith('online:') ? track.id : 'online:' + track.source + ':' + track.id,
    onlineShelfItems: () => [{ id: 'online-list', online: true, source: 'netease', refId: 'p', name: 'Account playlist' }],
    setPlayback: (action) => commands.push(action), queueAddTrack: (id) => commands.push(['enqueue', id]),
    applyQueue: (queue) => commands.push(['queue-replace', queue]), toast: () => {},
    applyCoverImg: () => {}, $: () => null, URLSearchParams, Date, Promise,
    transport: {
      get: async (url) => {
        requests.push(url);
        if (url.startsWith('/v1/tracks/missing')) throw Object.assign(new Error('removed'), { status: 404 });
        if (url.startsWith('/v1/tracks/local-a')) return local;
        if (url.startsWith('/v1/tracks?')) return { tracks: [local], total: 121 };
        if (url.startsWith('/v1/online/search?')) return { tracks: [online], total: 81 };
        if (url.startsWith('/v1/playlists/')) return { tracks: [local, online], total: 2 };
        if (url === '/v1/playlists') return { playlists: [{ id: 'p', name: 'Saved' }] };
        if (url.startsWith('/v1/history')) return { items: [{ source: 'local', track_id: 'missing' }, { source: 'local', track_id: 'local-a' }, { source: 'netease', ref_id: 'remote-a', title: 'Remote' }], total: 3 };
        if (url.startsWith('/v1/recommend/daily/online')) return { tracks: [online] };
        if (url.startsWith('/v1/recommend/daily')) return { tracks: [local] };
        if (url.startsWith('/v1/home/quote')) return { hitokoto: '真实每日内容', from: '内容来源' };
        throw new Error('Unexpected endpoint: ' + url);
      }, ensureCover: async () => null, coverUrl: (id) => '/v1/tracks/' + id + '/cover',
    },
  };
  context.SpaceHome = { bind: (value) => { host = value; } };
  context.Online = context.window.Online; context.Space3D = context.window.Space3D;
  vm.createContext(context); vm.runInContext(source, context);
  context.initSpaceHome({ playQueue: (ids, meta, id) => { commands.push({ ids, meta, id }); } });
  assert.deepEqual(commands, [], 'binding is read-only');
  assert.equal((await host.library({ q: 'A & B', offset: 60 })).total, 121);
  assert.match(requests.at(-1), /q=A\+%26\+B/); assert.match(requests.at(-1), /offset=60/);
  let releaseSearchReady;
  context.window.Online.whenSearchReady = () => new Promise((resolve) => { releaseSearchReady = resolve; });
  const allSearch = host.library({ q: 'all providers', source: 'all' });
  await Promise.resolve();
  assert.equal(requests.some((url) => url.includes('all+providers')), false, 'All search waits for the online source catalog');
  releaseSearchReady();
  const allResults = await allSearch;
  context.window.Online.whenSearchReady = () => Promise.resolve();
  assert.equal(allResults.sourceStates.length, 2, 'All includes local and every ready online source');
  assert.equal(allResults.items.length, 2);
  assert.equal(allResults.total, 202, 'All totals combine the server counts from each source');
  context.window.Online.searchSources = () => [];
  const localFallback = await host.library({ q: 'local fallback', source: 'all' });
  assert.match(localFallback.note, /仅显示本地结果/, 'All reports when only local results can be searched');
  assert.deepEqual(Array.from(localFallback.sourceStates, (entry) => entry.source), ['local']);
  const found = await host.library({ source: 'netease', q: 'music' });
  assert.equal(found.items[0].id, online.virtual_id);
  assert.equal((await host.playlists()).items.length, 2, 'existing account playlists share the library');
  const playlist = await host.playlist({ id: 'p' });
  await host.play(playlist.items[1], playlist.items);
  const played = commands.at(-1);
  assert.equal(played.id, online.virtual_id); assert.deepEqual(Array.from(played.ids), ['local-a', online.virtual_id]);
  assert.equal(played.meta[online.virtual_id].onlineId, 'remote-a', 'online metadata preserves provider identity');
  assert.equal(played.meta[online.virtual_id].vip_only, true, 'playback metadata preserves VIP status');
  await host.play(found.items[0], found.items, true);
  assert.equal(commands.at(-1).single.id, 'remote-a', 'online search uses the queue-preserving single-track owner');
  assert.equal(commands.at(-1).single.source, 'netease');
  await host.play(local, [local, ...found.items], true);
  assert.deepEqual(Array.from(commands.at(-1).ids), ['current', 'local-a'], 'local search preserves the queue and adds only the selected song');
  context.state.queue = ['current', 'local-a'];
  await host.play(local, [local], true);
  assert.deepEqual(Array.from(commands.at(-1).ids), ['current', 'local-a'], 'playing an existing entry does not duplicate it');
  context.state.queue = ['current'];
  await host.enqueue(found.items[0]); assert.equal(commands.at(-1)[1], online.virtual_id);
  await host.enqueue(null, playlist.items); assert.deepEqual(Array.from(commands.at(-1)[1]), ['current', 'local-a', online.virtual_id]);
  const recent = await host.recent(); assert.equal(recent.items.length, 2, 'removed local history is skipped');
  assert.equal(recent.nextOffset, 3, 'history pagination advances over removed records too');
  assert.equal(recent.items[1].id, online.virtual_id);
  assert.equal(recent.items[1].vip_only, true, 'history retains known VIP metadata');
  assert.equal((await host.daily('auto')).items.length, 2);
  assert.equal((await host.quote()).text, '真实每日内容');
  await host.queue(); assert.equal(commands.at(-1), 'queue');
  console.log('SpaceHome business bridge: passed');
}

async function browserContract() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    const html = read('index.html'), spriteStart = html.indexOf('<svg id="icon-sprite"');
    const sprite = html.slice(spriteStart, html.indexOf('</svg>', spriteStart) + 6);
    await page.setContent(sprite + '<div id="sp-home"></div>');
    await page.addStyleTag({ content: ':root { --bg:#171a1c; --text:#eff1f3; --muted:#a0a6ae; --accent:#71ceac; --sp-text:#eff1f3; --sp-muted:#a0a6ae; --sp-accent:#71ceac; --sp-accent-2:#ff8fb1; --sp-line:#42494e; --sp-line-soft:#292f33; } body {margin:0;font-family:Arial,sans-serif;} * {box-sizing:border-box;}' + read('space-home.css') });
    await page.addScriptTag({ content: read('host.js') });
    await page.addScriptTag({ content: read('space-home.js') });
    await page.evaluate(() => {
      window.actions = []; window.searches = []; window.libraryFailures = 0;
      window.snapshot = { current: { id: 'a', title: '当前音乐', artist: '歌手' }, playing: false, pending: false, queueLength: 1, sources: [{ id: 'netease', label: '网易云' }] };
      const items = [{ id: 'a', title: '当前音乐', artist: '歌手' }, { id: 'b', title: '这是很长的歌曲名称需要保持曲目列表布局和按钮可用', artist: '很长的艺术家名字' }];
      const png = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>');
      window.HertzSearchHistory = { push: (q) => searches.push(q),all:()=>[],clear:()=>{} };
      SpaceHome.init(document.querySelector('#sp-home'), {});
      SpaceHome.bind({ read: () => snapshot, library: async (spec) => {
        searches.push(spec);
        if (window.libraryFailures > 0) {
          window.libraryFailures -= 1;
          throw new Error('fixture library failure');
        }
        if (spec.source === 'all' && !snapshot.sources.length) return { items, total: 2, note: '当前没有可用在线音源，以下仅显示本地结果' };
        if (spec.source === 'netease') return { items: Array.from({ length: Math.min(20, 45 - spec.offset) }, (_, i) => ({ id: 'remote-' + (spec.offset + i), title: 'Remote ' + (spec.offset + i), artist: 'Artist' })), total: 45 };
        return { items, total: 2 };
      }, whenSearchReady: async () => {}, playlists: async () => ({ items: [{ id: 'p', name: '收藏歌单', track_count: 2 }] }), playlist: async () => ({ items }), daily: async () => ({ items }), recent: async () => ({ items }), quote: async () => ({ text: '每日内容来自共享服务', source: '来源' }),
        play: async (item, list) => { actions.push(['play', item.id, list.map((t) => t.id)]); }, enqueue: async (item, list) => actions.push(['enqueue', item ? item.id : list.length]), resume: async () => { actions.push('resume'); snapshot.playing = true; }, queue: () => actions.push('queue'), cover: async () => png, playlistCover: async () => png, applyCover: (img, url) => { if (url) img.src = url; else img.removeAttribute('src'); }, notify: (message) => actions.push(['error', message]) });
      SpaceHome.enter();
    });
    await page.waitForFunction(() => document.querySelectorAll('.sh-discovery-list .sh-track').length === 2);
    assert.deepEqual(await page.evaluate(() => actions), [], 'entry never auto-plays');
    const card = page.locator('.sh-action-library');
    const cardBox = await card.boundingBox();
    const restingTransform = await card.evaluate((node) => getComputedStyle(node).transform);
    await page.mouse.move(cardBox.x + cardBox.width * 0.8, cardBox.y + cardBox.height * 0.2);
    const tilt = await card.evaluate((node) => ({
      x: node.style.getPropertyValue('--sp-tilt-x'),
      y: node.style.getPropertyValue('--sp-tilt-y'),
    }));
    assert.notEqual(tilt.x, '', 'pointer movement sets the card pitch');
    assert.notEqual(tilt.y, '', 'pointer movement sets the card yaw');
    await page.waitForTimeout(450);
    assert.notEqual(await card.evaluate((node) => getComputedStyle(node).transform), restingTransform,
      'pointer movement visibly changes the card perspective');
    const output = path.join(root, 'target', 'space-home-verification'); fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'desktop-card-hover.png') });
    await page.mouse.move(1, 1);
    const resetTilt = await card.evaluate((node) => [
      node.style.getPropertyValue('--sp-tilt-x'),
      node.style.getPropertyValue('--sp-tilt-y'),
    ]);
    assert.deepEqual(resetTilt, ['', ''], 'pointer leave clears transient tilt');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.mouse.move(cardBox.x + cardBox.width * 0.8, cardBox.y + cardBox.height * 0.2);
    const reducedTilt = await card.evaluate((node) => node.style.getPropertyValue('--sp-tilt-x'));
    assert.equal(reducedTilt, '', 'reduced motion suppresses pointer tilt');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.mouse.move(1, 1);
    await page.locator('.sh-action-continue').click(); assert.equal(await page.evaluate(() => actions.at(-1)), 'resume');
    await page.locator('.sh-action-continue').click(); assert.equal(await page.evaluate(() => actions.at(-1)), 'queue');
    await page.locator('.sh-action-library').click(); await page.waitForSelector('.sh-panel-body .sh-track');
    await page.locator('.sh-panel-body .sh-track-main').first().click(); assert.equal(await page.evaluate(() => actions.at(-1)[0]), 'play');
    assert.equal(await page.locator('.sh-panel-layer').isVisible(), true, 'play remains inside panel');
    await page.locator('.sh-panel-body .sh-track .sh-icon').first().click(); assert.equal(await page.evaluate(() => actions.at(-1)[0]), 'enqueue');
    await page.evaluate(() => { window.libraryFailures = 2; });
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.waitForSelector('.sh-panel-body .sh-retry');
    await page.locator('.sh-panel-body .sh-retry').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement && document.activeElement.dataset.searchKey === 'panel:retry'
      && document.activeElement.matches('button'));
    assert.equal(await page.locator('.sh-panel-body .sh-retry').count(), 1, 'failed retry remains available');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.sh-panel-body .sh-track').length === 2);
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('sh-panel-body')),
      'successful retry returns focus to the loaded panel');
    console.log('SpaceHome generic retry restores keyboard focus after failure and success');
    await page.getByRole('button', { name: '歌单', exact: true }).click(); await page.waitForSelector('.sh-playlist');
    await page.locator('.sh-playlist').click(); await page.waitForSelector('.sh-playlist-summary');
    assert.equal(await page.locator('#sh-panel-title').textContent(), '收藏歌单');
    await page.getByRole('button', { name: '播放歌单', exact: true }).click();
    await page.getByRole('button', { name: '歌单加入队列', exact: true }).click(); assert.deepEqual(await page.evaluate(() => actions.at(-1)), ['enqueue', 2]);
    await page.getByRole('button', { name: '返回歌单', exact: true }).click(); await page.waitForSelector('.sh-playlist');
    assert.equal(await page.getByRole('button', { name: '固定面板', exact: true }).count(), 0, 'ambiguous pin command removed');
    await page.mouse.click(1,1); assert.equal(await page.locator('.sh-panel-layer').isVisible(), false);
    await page.locator('#sh-query').fill('A & B'); await page.locator('#sh-query').press('Enter');
    await page.waitForSelector('.sh-panel-body .sh-track'); assert.match(await page.locator('#sh-panel-title').textContent(), /A & B/);
    await page.getByRole('tab', {name:'网易云',exact:true}).click();
    await page.waitForFunction(() => searches.some((q) => q && q.source === 'netease'));
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await page.waitForFunction(() => searches.some((q) => q && q.source === 'netease' && q.offset === 20));
    assert.match(await page.locator('.sh-panel-body .sh-track-main').first().textContent(), /Remote 20/);
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await page.waitForFunction(() => searches.some((q) => q && q.source === 'netease' && q.offset === 40));
    assert.equal(await page.locator('.sh-panel-body .sh-track-main').count(), 5);
    assert.equal(await page.getByRole('button', { name: '下一页', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '上一页', exact: true }).click();
    assert.match(await page.locator('.sh-panel-body .sh-track-main').first().textContent(), /Remote 20/);
    assert.equal(await page.evaluate(() => SpaceHome.closePanel()), true); assert.equal(await page.evaluate(() => SpaceHome.closePanel()), false);
    await page.locator('#sh-query').press('Enter'); assert.equal(await page.locator('#sh-query').inputValue(), 'A & B');
    assert.equal(await page.getByRole('tab', {name:'网易云',exact:true}).getAttribute('aria-selected'), 'true', 'reopened query keeps provider context');
    await page.evaluate(() => { snapshot.sources = []; });
    await page.locator('#sh-query').fill('R1 removed source');
    await page.waitForFunction(() => !document.querySelector('.sh-search-modes [data-source="netease"]')
      && document.querySelector('.sh-search-modes [data-source="all"]')?.getAttribute('aria-selected') === 'true');
    await page.waitForSelector('.sh-panel-body .sh-track');
    assert.equal(await page.locator('.sh-panel-body .sh-state').filter({hasText:'仅显示本地结果'}).count(), 1,
      'removed provider falls back to All and reports local-only results');
    await page.screenshot({ path: path.join(output, 'desktop-panel.png') });
    await page.evaluate(() => SpaceHome.closePanel()); await page.screenshot({ path: path.join(output, 'desktop-home.png') });
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(output, 'mobile-home.png') });
    await page.locator('.sh-action-library').click(); await page.getByRole('button', { name: '本地音乐', exact: true }).click(); await page.waitForSelector('.sh-panel-body .sh-track');
    await page.screenshot({ path: path.join(output, 'mobile-panel.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile has no document overflow');
    assert.equal(await page.evaluate(() => { const rect = document.querySelector('.sh-panel').getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth; }), true);
    await page.evaluate(() => SpaceHome.leave()); assert.equal(await page.locator('#sp-home').isVisible(), false);
    assert.deepEqual(errors, []); console.log('SpaceHome browser interactions and responsive screenshots: passed');
  } finally { await browser.close(); }
}
bridgeContract().then(() => process.argv.includes('--bridge-only') ? undefined : browserContract())
  .catch((error) => { console.error(error); process.exitCode = 1; });
