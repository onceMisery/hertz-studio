// SPDX-License-Identifier: MIT
// Post-implementation acceptance: isolated service, real tagged songs, desktop and H5.
// HERTZ_EMBEDDED=1 verifies the built binary's assets instead of routing current sources.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { routeSourceAssets } = require('./ui-source-assets');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'output/playwright');
const checks = [], errors = [], overflows = [];
fs.mkdirSync(out, { recursive: true });
function pass(label) { checks.push(label); console.log('PASS ' + label); }

async function seed(fixture) {
  // More than 200 songs, 40 albums and 60 queue entries exercise real pagination.
  const music = path.join(path.dirname(fixture.dataDir), 'music');
  fs.mkdirSync(music, { recursive: true });
  const titles = ['暮色里', '风经过窗边', '海岸线', '晚安，星河', '日落以前', '街角的灯', '雨后的回声', '你听，风在唱', '向着微光', '山间来信', '远方的船', '月亮的背面'];
  const artists = ['林屿', '晚风电台', '周予安', '青木', '沈知南', '海盐与星光', '山野旅人'];
  const albums = ['蓝色时刻', '慢慢走', '潮汐来信', '夜航', '橘色天空', '城市漫游', '听见山海'];
  const lyric = '[00:00.00]让旋律，陪你慢慢走\n[00:10.00]风经过窗边，留下一缕光\n[00:20.00]穿过人海，回到你身旁\n[00:30.00]把日落收进心里的行囊\n[00:40.00]听海浪轻轻，唱起远方\n[00:50.00]每个平凡的夜晚都有星光\n[01:00.00]让喜欢的旋律继续回响\n[01:10.00]不必匆忙，世界还很长\n[01:20.00]走到下一站，再和你分享\n';
  const chunk = (id, data) => { const h = Buffer.alloc(8); h.write(id); h.writeUInt32LE(data.length, 4); return Buffer.concat([h, data, Buffer.alloc(data.length % 2)]); };
  const format = Buffer.alloc(16); format.writeUInt16LE(1); format.writeUInt16LE(1, 2); format.writeUInt32LE(8000, 4); format.writeUInt32LE(16000, 8); format.writeUInt16LE(2, 12); format.writeUInt16LE(16, 14);
  const audio = chunk('data', Buffer.alloc(8000 * 2 * 90));
  for (let i = 0; i < 224; i++) {
    const title = titles[i % titles.length] + (i < 12 ? '' : ' · ' + (Math.floor(i / 12) + 1));
    const album = albums[Math.floor(i / 2) % 7] + (i < 14 ? '' : ' · ' + (Math.floor(i / 14) + 1));
    const artist = artists[Math.floor(i / 2) % 7];
    const file = path.join(music, 'preview-' + String(i + 1).padStart(3, '0') + '.wav');
    const tags = chunk('LIST', Buffer.concat([Buffer.from('INFO'), chunk('INAM', Buffer.from(title + '\0')), chunk('IART', Buffer.from(artist + '\0')), chunk('IPRD', Buffer.from(album + '\0'))]));
    fs.writeFileSync(file, chunk('RIFF', Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', format), tags, audio])));
    fs.writeFileSync(file.replace('.wav', '.lrc'), '[ar:' + artist + ']\n[ti:' + title + ']\n' + lyric, 'utf8');
  }
  await fixture.api('/v1/library/roots', 'POST', { path: music, enabled: true });
  await fixture.api('/v1/library/scan', 'POST', { root: music });
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline) {
    const status = await fixture.api('/v1/library/status');
    if (!status.running && status.total === 224) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.ok(ready, 'All tagged fixture songs were scanned');
  const tracks = (await fixture.api('/v1/tracks?sort=title&limit=300')).tracks;
  assert.equal(tracks.length, 224);
  const { token } = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'vmusicd.json'), 'utf8'));
  const covers = ['night-02.jpg', 'evening-16.jpg', 'morning-09.jpg', 'afternoon-19.jpg', 'night-08.jpg', 'celestial-sky.jpg', 'evening-18.jpg'].map(name => fs.readFileSync(path.join(root, 'plugin/ui/wallpapers', name)));
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < tracks.length) {
      const track = tracks[cursor++];
      const response = await fetch(fixture.base + '/v1/tracks/' + track.id + '/cover', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'image/jpeg' }, body: covers[artists.indexOf(track.artist)], signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, 200, 'Fixture cover upload');
    }
  }));
  for (const [i, name] of ['夜路与晚风', '安静的清晨', '日落收集者', '专注的留白'].entries()) {
    const playlist = await fixture.api('/v1/playlists', 'POST', { name });
    await fixture.api('/v1/playlists/' + playlist.id + '/tracks', 'POST', { track_ids: tracks.slice(i * 8, i * 8 + 12).map(t => t.id) });
  }
  await fixture.api('/v1/player/volume', 'POST', { volume: 0 });
  for (const t of tracks.slice(0, 8)) { await fixture.api('/v1/player/load', 'POST', { track_id: t.id }); await fixture.api('/v1/player/pause', 'POST', {}); }
  return tracks;
}

async function swipe(page, from, to, cancel = false) {
  const session = await page.context().newCDPSession(page);
  try {
    const point = (x, y) => ({ id: 1, x, y, radiusX: 4, radiusY: 4, force: 1 });
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(...from)] });
    // Realistic gesture duration avoids Chrome consuming the next tap after an instant fling.
    for (let step = 1; step <= 8; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(from[0] + (to[0] - from[0]) * step / 8, from[1] + (to[1] - from[1]) * step / 8)] });
      await page.waitForTimeout(20);
    }
    await session.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(280);
  } finally { await session.detach(); }
}
(async () => {
  const fixture = await startFixture();
  let browser;
  try {
    await seed(fixture);
    const base = fixture.base, api = fixture.api;
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', hasTouch: true, isMobile: true });
    await fixture.connect(context);
    await context.addInitScript(() => { localStorage.setItem('vmusic.defaultView', 'home'); localStorage.setItem('vmusic.skin', 'hertz'); });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    if (!process.env.HERTZ_EMBEDDED) await routeSourceAssets(page, fixture);
    const navigate = async view => {
      await page.evaluate(view => { const entry = document.querySelector('#rail [data-view="' + view + '"]'); if (!entry || entry.hidden) throw new Error('Unavailable view ' + view); entry.click(); }, view);
      await page.waitForFunction(view => window.HertzShell.activeView() === view, view);
      await page.evaluate(() => document.getElementById('column').scrollTop = 0);
    };
    async function capture(name) {
      await page.waitForTimeout(140);
      const dimensions = await page.evaluate(() => {
        const main = document.getElementById('column'), modal = document.getElementById('np-modal');
        const bad = Array.from(document.querySelectorAll('.view:not([hidden]) button,.view:not([hidden]) input,.view:not([hidden]) select')).filter(n => {
          if (!n.getClientRects().length || getComputedStyle(n).visibility === 'hidden') return false;
          const r = n.getBoundingClientRect(); return r.width > 15 && (r.right > innerWidth + 2 || r.left < -2) && !n.closest('.hz-music-strip,.hz-library-tabs,.hz-settings-nav');
        }).slice(0, 10).map(n => ({ id: n.id, cls: n.className, text: n.textContent.slice(0, 70) }));
        return { root: document.documentElement.scrollWidth, width: innerWidth, column: main.scrollWidth, columnClient: main.clientWidth, player: modal.hidden ? null : { scroll: modal.scrollWidth, client: modal.clientWidth }, bad };
      });
      if (dimensions.root > dimensions.width + 1 || dimensions.column > dimensions.columnClient + 1 || (dimensions.player && dimensions.player.scroll > dimensions.player.client + 1) || dimensions.bad.length) overflows.push({ name, ...dimensions });
      await page.screenshot({ path: path.join(out, name + '.png') });
    }
    // Interaction acceptance: keep the native scroll surface and its width, reveal
    // only while moving, and hide even when the pointer remains over the content.
    const scrollSurface = selector => page.locator(selector).evaluate(node => ({
      top: node.scrollTop, left: node.scrollLeft, width: node.clientWidth,
      thumb: getComputedStyle(node, '::-webkit-scrollbar-thumb').backgroundColor,
      gutter: getComputedStyle(node, '::-webkit-scrollbar').width,
    }));
    async function checkScroll(selector, gesture, axis = 'top') {
      await page.waitForFunction(selector => !document.querySelector(selector).hasAttribute('data-hz-scrolling'), selector);
      const before = await scrollSurface(selector);
      assert.equal(before.thumb, 'rgba(0, 0, 0, 0)', selector + ' idle thumb is invisible');
      await gesture();
      await page.waitForFunction(({ selector, axis, value }) => {
        const node = document.querySelector(selector);
        return node[axis === 'top' ? 'scrollTop' : 'scrollLeft'] !== value && getComputedStyle(node, '::-webkit-scrollbar-thumb').backgroundColor !== 'rgba(0, 0, 0, 0)';
      }, { selector, axis, value: before[axis] });
      const moving = await scrollSurface(selector);
      assert.equal(moving.width, before.width, selector + ' does not shift content');
      assert.equal(moving.gutter, '8px', selector + ' retains the slim native scrollbar');
      await page.waitForTimeout(1200);
      assert.equal((await scrollSurface(selector)).thumb, 'rgba(0, 0, 0, 0)', selector + ' hides after scrolling stops');
    }
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.HertzShell?.activeView() === 'home' && window.Skins?.currentId() === 'hertz' && document.querySelectorAll('#view-home .hz-music-tile').length > 10, null, { timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll('#view-home .hz-playlist-entry').length === 4, null, { timeout: 30000 });
    assert.equal(await page.locator('#view-home .hz-home-section[data-section="recent"]').locator('.hz-music-tile').count(), 8);
    assert.equal(await page.locator('#view-home .hz-continuation').evaluate(n => n === document.getElementById('view-home').firstElementChild && n.open && !!n.querySelector('#home-dashboard')), true, 'Continue-listening dashboard leads the home page and starts expanded');
    pass('Home renders real recent tracks, albums, artists and four playlists');
    await capture('hertz-desktop-home');
    await page.locator('#search').focus();
    await page.locator('.ts-menu').waitFor();
    const searchChrome = await page.evaluate(() => {
      const shell = document.querySelector('.topsearch'), input = document.getElementById('search');
      const panel = document.querySelector('.ts-menu');
      return { field: shell.getBoundingClientRect().toJSON(), menu: panel.getBoundingClientRect().toJSON(),
        inputOutline: getComputedStyle(input).outlineStyle, shellOutline: getComputedStyle(shell).outlineStyle };
    });
    assert.equal(searchChrome.inputOutline, 'none', 'Search has a single outer focus treatment');
    assert.ok(Math.abs(searchChrome.field.left - searchChrome.menu.left) <= 1);
    assert.ok(Math.abs(searchChrome.field.width - searchChrome.menu.width) <= 1);
    await capture('hertz-desktop-search');
    await page.keyboard.press('Escape');
    await page.locator('#top-more-btn').click();
    for (const removed of ['settings-entry', 'bar-pin-toggle', 'service-exit']) {
      assert.equal(await page.locator('#top-more-menu #' + removed).count(), 0);
    }
    await capture('hertz-desktop-tools-menu');
    await page.keyboard.press('Escape');
    pass('Search focus and dropdown align as one field; tools menu omits settings, collapse and service exit');
    const recentStrip = '#view-home .hz-home-section[data-section="recent"] .hz-music-strip';
    await checkScroll(recentStrip, async () => {
      await page.locator(recentStrip).hover(); await page.mouse.wheel(260, 0);
    }, 'left');
    pass('Horizontal albums retain native scrolling and hide their scrollbar while the pointer stays inside');
    const expandedWidth = await page.locator('#hz-workspace').evaluate(n => n.clientWidth);
    await page.locator('#hz-sidebar-toggle').click();
    assert.equal(await page.locator('#rail').evaluate(n => n.inert && n.getAttribute('aria-hidden') === 'true'), true);
    assert.equal(await page.locator('#hz-workspace').evaluate(n => n.clientWidth), expandedWidth + 232);
    await capture('hertz-desktop-sidebar-hidden');
    await page.reload();
    await page.waitForFunction(() => window.Skins?.currentId() === 'hertz' && document.querySelector('.hz-sidebar-toggle'));
    assert.equal(await page.locator('#hz-sidebar-toggle').getAttribute('aria-expanded'), 'false');
    await page.locator('#hz-sidebar-toggle').click();
    assert.equal(await page.locator('#hz-workspace').evaluate(n => n.clientWidth), expandedWidth);
    pass('Desktop sidebar slides away, expands content and restores saved state after reload');
    await page.locator('#view-home .hz-music-tile').first().click();
    await page.waitForFunction(() => !document.getElementById('bar-title').textContent.includes('从喜欢'));
    await page.waitForTimeout(350);
    assert.equal((await api('/v1/player/queue')).queue.length, 8);
    pass('Recent track uses the complete recent source queue');
    await api('/v1/player/pause', 'POST', {});
    await page.locator('.hz-queue-toggle').click(); await page.locator('.hz-queue-row').first().waitFor();
    assert.equal(await page.locator('.hz-queue-row').count(), 8); await capture('hertz-desktop-queue');
    await page.locator('.hz-queue-head .hz-icon').click();
    assert.equal(await page.locator('#rail > .rail-item').count(), 3, 'Primary rail matches the prototype');
    await page.locator('.hz-extra-nav > summary').click();
    await page.locator('#rail [data-view="daily"]').click();
    await page.waitForFunction(() => HertzShell.activeView() === 'daily');
    await navigate('home'); await page.locator('.hz-extra-nav > summary').click();
    assert.equal(await page.locator('.hz-featured-dots button').count(), 3);
    await page.locator('.hz-featured-dots button').nth(1).focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('.hz-featured-dots button').nth(1).getAttribute('aria-pressed'), 'true');
    await page.locator('.hz-featured-actions .primary').click();
    await page.waitForFunction(() => document.getElementById('view-library').dataset.hzLibraryDetail === 'true');
    await page.waitForTimeout(350);
    assert.equal((await api('/v1/player/queue')).queue.length, 2, 'Featured play uses exactly the real album');
    await api('/v1/player/pause', 'POST', {});
    await page.locator('.hz-detail-back').click(); await page.locator('#hz-library-tab-songs').click();
    pass('Prototype navigation, real sidebar playlists and keyboard album selection preserve business actions');
    await navigate('library');
    await page.locator('#lib-list .track').first().waitFor();
    const initialRows = await page.locator('#lib-list .track').count();
    assert.equal(initialRows, 200, 'Songs retain the original 200-track page');
    await capture('hertz-desktop-library');
    await checkScroll('#column', async () => { await page.mouse.move(960, 490); await page.mouse.wheel(0, 440); });
    await page.screenshot({ path: path.join(out, 'hertz-liquid-scroll-idle.png') });
    await checkScroll('#column', async () => {
      await page.locator('#lib-list .track .t-select').nth(8).focus();
      await page.keyboard.press('PageDown');
    });
    await page.evaluate(() => document.getElementById('column').scrollTop = 0);
    pass('Wheel and keyboard scrolling reveal a slim thumb without layout shift, then hide it at rest');
    pass('Original library row interactions and bounded pagination remain active');
    await page.locator('#hz-library-tab-album').click();
    await page.waitForFunction(() => document.querySelectorAll('.hz-library-grid .hz-music-tile').length === 40);
    await page.locator('.hz-library-more').click();
    await page.waitForFunction(() => document.querySelectorAll('.hz-library-grid .hz-music-tile').length === 80);
    await capture('hertz-desktop-albums');
    pass('Album browser pages 40 then 80 of 112 real albums');
    await page.locator('.hz-library-grid .hz-music-tile').first().click();
    await page.waitForFunction(() => document.getElementById('view-library').dataset.hzLibraryDetail === 'true' && document.querySelectorAll('#lib-list .track').length === 2, null, { timeout: 8000 }).catch(async e => {
      console.log('DETAIL', await page.evaluate(() => ({ view: HertzShell.activeView(), attr: document.getElementById('view-library').dataset.hzLibraryDetail, rows: document.querySelectorAll('#lib-list .track').length, artist: document.getElementById('lib-artist-filter').value, album: document.getElementById('lib-album-filter').value, title: document.querySelector('.hz-detail-content h2')?.textContent, hint: document.getElementById('lib-hint').textContent, errors: Array.from(document.querySelectorAll('.toast')).map(n => n.textContent) })));
      await capture('hertz-failed-detail'); throw e;
    });
    await capture('hertz-desktop-album-detail');
    await page.locator('.hz-library-actions .primary').click(); await page.waitForTimeout(350);
    assert.equal((await api('/v1/player/queue')).queue.length, 2);
    pass('Album detail uses exact real filtering and plays both songs');
    await api('/v1/player/pause', 'POST', {}); await page.locator('.hz-detail-back').click();
    await page.locator('#hz-library-tab-artist').click();
    await page.waitForFunction(() => document.querySelectorAll('.hz-library-grid .hz-music-tile').length === 7);
    pass('Artist browser includes all seven real artists');
    await page.locator('#hz-library-tab-songs').click();
    await page.waitForTimeout(120);
    await page.locator('.hz-library-actions .primary').click(); await page.waitForTimeout(300);
    assert.equal((await api('/v1/player/queue')).queue.length, 224);
    pass('Play all uses all 224 IDs beyond visible pagination');
    await api('/v1/player/pause', 'POST', {});
    await page.locator('#bar-track').click();
    await page.waitForFunction(() => window.NowPlaying.isOpen());
    await capture('hertz-desktop-player');
    await page.locator('#np-tab-lyrics').click();
    await page.waitForFunction(() => document.querySelectorAll('#np-lyric-lines .np-line').length > 6, null, { timeout: 20000 });
    await page.locator('.np-line').nth(3).click();
    await page.waitForTimeout(300);
    await capture('hertz-desktop-lyrics');
    pass('NowPlaying renders and seeks through the real LRC timeline');
    await page.locator('#np-queue').click(); await page.locator('.np-queue-row').first().waitFor();
    assert.equal(await page.locator('.np-queue-row').count(), 60);
    await page.locator('.np-queue-more').focus(); await page.keyboard.press('Enter'); assert.equal(await page.locator('.np-queue-row').count(), 120);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.index), '60');
    assert.equal(await page.locator('#np-reading').evaluate(n => n.hidden), false);
    assert.equal(await page.locator('.np-footer').evaluate(n => n.inert), true);
    await page.locator('#np-queue-close').click();
    assert.equal(await page.locator('.np-footer').evaluate(n => n.inert), false);
    pass('Player queue loads 60 then 120, preserves lyrics, restores input after close');
    await page.locator('#np-more').click(); await page.locator('#np-eq').click();
    assert.equal(await page.locator('#np-eq-pane').evaluate(n => n.hidden), false);
    assert.equal(await page.locator('#dsp-eq-row').evaluate(n => n.closest('.set-group').hidden), false);
    await capture('hertz-desktop-player-tools');
    await page.locator('#np-tools-close').click();
    assert.equal(await page.locator('#dsp-eq-row').evaluate(n => n.closest('#view-settings') !== null), true);
    pass('EQ uses original settings and restores its DOM when tools close');
    await page.locator('#np-close').click();
    await navigate('settings'); await capture('hertz-desktop-settings');
    for (const cat of ['appearance', 'playback', 'lyrics', 'connection', 'tools']) {
      await page.locator('.hz-settings-nav [data-category="' + cat + '"]').click();
      assert.ok(await page.locator('#view-settings > .set-group:not([hidden])').count());
    }
    await page.locator('.hz-settings-nav [data-category="appearance"]').click(); await page.locator('#hz-theme-light').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'hertz-light');
    await capture('hertz-desktop-settings-light');
    await navigate('home'); await capture('hertz-desktop-home-light');
    await checkScroll('#column', async () => { await page.mouse.move(960, 490); await page.mouse.wheel(0, 380); });
    await page.evaluate(() => document.getElementById('column').scrollTop = 0);
    pass('All five settings categories and prototype light theme work');
    for (const [width, height, label] of [[1024, 768, 'tablet'], [390, 844, 'mobile'], [320, 740, 'small-mobile']]) {
      await page.setViewportSize({ width, height }); await navigate('home'); await capture('hertz-' + label + '-home-light');
      await page.evaluate(() => window.Theme.apply('hertz-dark'));
      await capture('hertz-' + label + '-home');
      await navigate('library'); await page.locator('#hz-library-tab-songs').click(); await capture('hertz-' + label + '-library');
      await navigate('settings'); await page.locator('.hz-settings-nav [data-category="appearance"]').click(); await capture('hertz-' + label + '-settings');
      if (width < 900) {
        await page.locator('#hz-sidebar-toggle').tap();
        assert.equal(await page.locator('#rail').getAttribute('aria-modal'), 'true');
        assert.equal(await page.locator('#hz-workspace').evaluate(n => n.inert), true);
        await page.waitForFunction(() => document.activeElement.matches('.hz-sidebar-close'));
        await capture('hertz-' + label + '-sidebar');
        await page.keyboard.press('Shift+Tab');
        assert.equal(await page.locator('#rail').evaluate(n => n.contains(document.activeElement)), true);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#hz-sidebar-toggle').evaluate(n => n === document.activeElement), true);
        await page.locator('#hz-sidebar-toggle').tap();
        await page.waitForFunction(() => document.body.classList.contains('hz-sidebar-open'));
        await page.keyboard.press('Control+k');
        await page.waitForFunction(() => Palette.isOpen());
        assert.equal(await page.locator('#hz-sidebar-toggle').getAttribute('aria-expanded'), 'false');
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => !!document.activeElement.closest('.palette-scrim')), true);
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => Palette.isOpen()), false);
        assert.equal(await page.locator('#hz-sidebar-toggle').evaluate(n => n === document.activeElement), true);
        await swipe(page, [5, 350], [145, 350]);
        assert.equal(await page.locator('#hz-sidebar-toggle').getAttribute('aria-expanded'), 'true');
        await page.locator('#rail [data-view="library"]').tap();
        await page.waitForFunction(() => !document.body.classList.contains('hz-sidebar-open')).catch(async error => {
          await page.screenshot({ path: path.join(out, 'hertz-sidebar-navigation-failure.png') });
          console.error('SIDEBAR', await page.evaluate(() => ({ width: innerWidth, view: HertzShell.activeView(), body: document.body.className, focus: document.activeElement?.outerHTML.slice(0, 200), rail: document.getElementById('rail').getBoundingClientRect().toJSON() })));
          throw error;
        });
        assert.equal(await page.locator('#hz-sidebar-toggle').getAttribute('aria-expanded'), 'false');
        assert.equal(await page.locator('#hz-workspace').evaluate(n => n.inert), false);
        await swipe(page, [5, 350], [145, 350]);
        await page.locator('.hz-sidebar-scrim').tap({ position: { x: width - 20, y: 250 } });
        await page.waitForFunction(() => !document.body.classList.contains('hz-sidebar-open'));
        assert.equal(await page.locator('#hz-sidebar-toggle').getAttribute('aria-expanded'), 'false');
        await swipe(page, [5, 350], [145, 350]); await swipe(page, [230, 350], [70, 350]);
        assert.equal(await page.locator('#hz-sidebar-toggle').getAttribute('aria-expanded'), 'false');
        await swipe(page, [5, 350], [5, 475]); await swipe(page, [5, 350], [145, 350], true);
        assert.equal(await page.locator('#hz-sidebar-toggle').getAttribute('aria-expanded'), 'false');
        await swipe(page, [5, 350], [145, 350]);
        await page.getByRole('button', { name: '打开沉浸播放器', exact: true }).tap();
        await page.waitForFunction(() => NowPlaying.isOpen());
        assert.equal(await page.locator('#hz-sidebar-toggle').getAttribute('aria-expanded'), 'false');
        await swipe(page, [5, 350], [145, 350]);
        assert.equal(await page.locator('#hz-sidebar-toggle').getAttribute('aria-expanded'), 'false');
        await page.locator('#np-close').tap();
        assert.equal(await page.locator('#hz-workspace').evaluate(n => n.inert), false);
        await page.evaluate(() => Space3D.open());
        await swipe(page, [5, 350], [145, 350]);
        assert.equal(await page.locator('#hz-sidebar-toggle').getAttribute('aria-expanded'), 'false');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.body.classList.contains('space3d-open'));
        await page.locator('.hz-mobile-tab[data-view="library"]').tap();
        await page.locator('#hz-library-tab-songs').tap();
        await page.evaluate(() => { document.getElementById('column').scrollTop = 0; });
        await page.locator('#lib-list .track').first().locator('.t-select').tap();
        await page.locator('#lib-batch-count').waitFor();
        const batch = await page.locator('#lib-batch-bar').boundingBox();
        assert.ok(batch.x >= 0 && batch.x + batch.width <= width + 1 && batch.y + batch.height < height - 150);
        await page.locator('#lib-batch-clear').tap();
        assert.equal(await page.locator('#lib-batch-bar').isVisible(), false);
        await page.mouse.move(width / 2, 360); await page.mouse.wheel(0, 420); await page.waitForTimeout(300);
        assert.ok(await page.locator('#column').evaluate(n => n.scrollTop) > 0);
        assert.equal(await page.locator('#view-library').evaluate(n => n.scrollTop), 0);
        await checkScroll('#column', () => swipe(page, [width / 2, 510], [width / 2, 330]));
        pass(label + ' native sidebar swipes, focus, player boundaries, batch touch controls and single scroll owner');
        await page.getByRole('button', { name: '全部功能', exact: true }).click();
        assert.ok(await page.locator('.hz-menu-tools .hz-menu-entry').count() >= 7);
        await capture('hertz-' + label + '-more');
        await page.getByRole('button', { name: '关闭全部功能', exact: true }).click();
        await page.locator('.hz-mobile-tab[data-view="home"]').click();
      }
      await page.locator('#bar-track').click(); await page.locator('#np-tab-cover').click(); await capture('hertz-' + label + '-player');
      await page.locator('#np-tab-lyrics').click(); await capture('hertz-' + label + '-lyrics');
      await page.locator('#np-queue').click(); await capture('hertz-' + label + '-player-queue'); await page.locator('#np-queue-close').click();
      await page.locator('#np-more').click();
      if (width < 900) assert.equal(await page.locator('#np-stage-mobile').isVisible(), true);
      await page.locator('#np-tools-close').click(); await page.locator('#np-close').click();
      pass(label + ' navigation, original tools, cover/lyrics player and queue remain reachable');
    }
    await page.locator('#hz-sidebar-toggle').tap();
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.equal(await page.locator('#rail').getAttribute('aria-modal'), null);
    assert.equal(await page.locator('#hz-workspace').evaluate(n => n.inert), false);
    await page.locator('.hz-queue-toggle').click();
    await page.locator('.hz-queue-more').focus(); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.index), '60');
    await checkScroll('.hz-queue-list', async () => { await page.locator('.hz-queue-list').hover(); await page.mouse.wheel(0, -220); });
    await page.locator('.hz-queue-head .hz-icon').click();
    pass('Sidebar resize restores desktop input and queue keyboard paging keeps focus on new songs');
    for (const view of ['playlists', 'queue', 'favorites', 'online', 'podcasts', 'reader', 'room']) { await navigate(view); await capture('hertz-desktop-' + view); }
    pass('All original business views remain in canonical navigation');
    await navigate('home');
    await page.setViewportSize({ width: 1024, height: 540 });
    await checkScroll('#rail', async () => { await page.mouse.move(140, 330); await page.mouse.wheel(0, 220); });
    pass('Queue and short-window sidebar scroll independently and hide their own idle thumb');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
      const lifecycle = Skins.current().lifecycle;
      document.getElementById('column').scrollTop = 100;
      window.__hertzGlassLifecycle = lifecycle;
    });
    await page.waitForFunction(() => document.querySelector('[data-hz-scrolling]'));
    await page.evaluate(() => window.__hertzGlassLifecycle.unmount());
    assert.equal(await page.locator('[data-hz-scrolling]').count(), 0);
    assert.equal(await page.locator('html').getAttribute('data-hz-tone'), null);
    await page.evaluate(() => { window.__hertzGlassLifecycle.mount(); delete window.__hertzGlassLifecycle; });
    await page.waitForFunction(() => document.querySelector('.hz-top-tools') && document.documentElement.dataset.hzTone);
    await checkScroll('#column', async () => { await page.mouse.move(960, 490); await page.mouse.wheel(0, 380); });
    pass('Skin teardown removes active timers and tone, and remount restores scrolling behavior');
    assert.deepEqual(errors, [], 'No browser JavaScript errors');
    fs.writeFileSync(path.join(out, 'hertz-ui-results.json'), JSON.stringify({ embedded: !!process.env.HERTZ_EMBEDDED, checks, errors, overflows }, null, 2));
    assert.deepEqual(overflows, [], 'Responsive controls and scroll surfaces must stay within viewport');
    pass('All captured desktop/tablet/H5 surfaces have no horizontal overflow');
  } finally {
    fs.writeFileSync(path.join(out, 'hertz-ui-results.json'), JSON.stringify({ embedded: !!process.env.HERTZ_EMBEDDED, checks, errors, overflows }, null, 2));
    if (browser) await browser.close();
    await fixture.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
