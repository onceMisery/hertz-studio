// SPDX-License-Identifier: MIT
// Real service, source assets, and touch viewports for the Orbit mobile prototype.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { readAssets } = require('./ui-assets');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/playwright/orbit-mobile');
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; console.log('PASS ' + message); }
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const fixture = await startFixture();
  let browser, page;
  const errors = [];
  try {
    const track = await fixture.seed();
    browser = await chromium.launch({ channel: 'chrome', headless: true,
      args: ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    await fixture.connect(context);
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.addInitScript(() => localStorage.setItem('vmusic.defaultView', 'library'));
    const token = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'vmusicd.json'), 'utf8')).token;
    await page.request.post(fixture.base + '/v1/tracks/' + track.id + '/cover', {
      data: fs.readFileSync(path.join(root, 'plugin/ui/wallpapers/celestial-sky.jpg')),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'image/jpeg' },
    });
    const assets = new Map(readAssets().map(asset => [asset.path, asset]));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== fixture.base) return route.continue();
      const asset = assets.get(url.pathname);
      if (asset) return route.fulfill({ path: asset.file, contentType: asset.mime === 'JS' ? 'application/javascript' : 'text/css' });
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body:
        fs.readFileSync(path.join(root, 'plugin/ui/index.html'), 'utf8').replace('__VMUSIC_TOKEN_VALUE__', token) });
      if (url.pathname === '/v1/online/account') return route.fulfill({ json: { logged_in: false } });
      if (url.pathname === '/v1/recommend/daily/online') return route.fulfill({ json: { tracks: [], sources: [], skipped: [], ready: [] } });
      return route.continue();
    });
    await page.goto(fixture.base);
    await page.waitForFunction(() => window.Skins && document.getElementById('conn').textContent === '服务已连接');
    await page.locator('#orbit-mobile-library').click();
    await page.locator('.orbit-home[aria-busy="true"]').waitFor({ state: 'hidden' });
    await page.waitForSelector('.orbit-home-tile');
    check(await page.locator('.orbit-mobile-tab').allTextContents().then(labels => labels.join('|') === '首页|搜索|收藏|我的'), 'four tabs follow the prototype');
    check(await page.locator('.orbit-home').isVisible(), 'home shows real recently added music');
    check((await page.locator('.orbit-home').textContent()).includes(track.title), 'home reads actual library metadata');
    check(!await page.locator('#playback-bar').isVisible() && !await page.locator('#stage').isVisible(), 'browsing has no transport or turntable');
    check(!await page.locator('.top-right').isVisible() && !await page.locator('.orbit-skin-name').isVisible(), 'skin name and desktop toolbar are absent');
    await page.screenshot({ path: path.join(output, 'home-390.png') });
    await page.locator('.orbit-home-tile').first().click();
    await page.waitForSelector('#np-modal:not([hidden])');
    await page.waitForFunction(() => document.body.classList.contains('is-playing'));
    check((await fixture.api('/v1/state')).playing, 'home artwork opens the real player and starts the selected song');
    await page.locator('#np-close').click();
    await page.locator('#orbit-mobile-favorites').click();
    check((await fixture.api('/v1/state')).playing, 'changing browsing pages preserves playback');
    await fixture.api('/v1/player/pause', 'POST', {});
    await page.locator('#orbit-mobile-library').click();
    await page.locator('.orbit-artist-tile').first().click();
    await page.waitForFunction(() => document.querySelector('.orbit-filter-summary').textContent.includes('Hertz Audit Artist'));
    check(await page.locator('#lib-artist-filter').inputValue() === track.artist, 'artist tile applies the real exact artist filter');
    await page.locator('.orbit-filter-summary button').click();
    check(await page.locator('#lib-artist-filter').inputValue() === '', 'artist filter has a visible clear action');
    await page.locator('#orbit-mobile-library').click();
    await page.locator('#orbit-mobile-more').click();
    await page.waitForFunction(() => document.getElementById('orbit-more-sheet').open);
    await page.locator('#orbit-more-sheet').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    const drawer = await page.locator('#orbit-more-sheet').boundingBox();
    check(drawer.x === 0 && drawer.width <= 342 && drawer.height >= 840, 'menu is a full-height left drawer');
    check(await page.locator('.orbit-more-entry[data-route="home"]').getAttribute('aria-current') === 'page', 'menu identifies the current home');
    await page.screenshot({ path: path.join(output, 'menu-390.png') });
    await page.locator('.orbit-more-entry[data-view="library"]').click();
    check(await page.locator('#view-library').isVisible() && !await page.locator('.orbit-home').isVisible(), 'drawer library opens the song list');
    check(!await page.locator('#orbit-more-sheet').evaluate(el => el.open), 'navigation closes the drawer');
    await page.screenshot({ path: path.join(output, 'library-390.png') });
    check(!await page.locator('#orbit-library-tools').isVisible(), 'library tools start collapsed');
    await page.locator('#orbit-filter-toggle').click();
    await page.locator('#lib-sort').selectOption('added');
    check(await page.locator('#lib-sort').inputValue() === 'added', 'existing sort remains usable');
    await page.locator('.orbit-select-toggle').click();
    const selection = page.locator('#lib-list .t-select').first();
    await selection.check();
    check(await selection.isChecked() && !(await fixture.api('/v1/state')).playing, 'batch selection does not start playback');
    await selection.uncheck();
    await page.locator('.orbit-select-toggle').click();
    await page.locator('#scan-toggle').click();
    check(await page.locator('#scan-root').isVisible(), 'directory management remains available');
    await page.locator('#scan-toggle').click();
    await page.locator('#orbit-filter-toggle').click();
    await page.locator('#lib-list [data-act="menu"]').first().click();
    check(await page.locator('#ctx-menu').isVisible(), 'one row menu retains secondary song actions');
    await page.keyboard.press('Escape');
    await page.locator('#orbit-menu-toggle').click();
    await page.keyboard.press('Escape');
    check(!await page.locator('#orbit-more-sheet').evaluate(el => el.open), 'Escape closes the drawer');
    check(await page.locator('#orbit-menu-toggle').evaluate(el => el === document.activeElement), 'closing restores keyboard focus');
    await page.locator('#orbit-menu-toggle').click();
    await page.mouse.click(375, 400);
    check(!await page.locator('#orbit-more-sheet').evaluate(el => el.open), 'backdrop closes the drawer');
    await page.locator('#orbit-mobile-online').click();
    check(await page.locator('#search').isVisible() && await page.locator('#search').evaluate(el => el === document.activeElement), 'search tab opens the existing global search');
    await page.locator('#orbit-search-toggle').click();
    await page.locator('#orbit-mobile-favorites').click();
    check(await page.locator('#view-favorites').isVisible(), 'favorites tab uses canonical navigation');
    await page.locator('#orbit-mobile-more').click();
    await page.locator('.orbit-more-entry[data-view="settings"]').click();
    await page.waitForFunction(() => SkinSettingsSheet.isOpen());
    check(await page.evaluate(() => SkinSettingsSheet.info().entries.some(entry => entry.label === '界面皮肤')), 'appearance and skins remain inside settings');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !SkinSettingsSheet.isOpen());
    await page.locator('#orbit-menu-toggle').click();
    await page.locator('.orbit-more-entry[data-route="player"]').click();
    await page.waitForSelector('#np-modal:not([hidden])');
    check(await page.locator('#np-playpause').isVisible(), 'player has its own playback controls');
    await page.locator('#np-playpause').click();
    await page.waitForFunction(() => document.body.classList.contains('is-playing'));
    check((await fixture.api('/v1/state')).playing, 'player starts real backend playback');
    await page.locator('#np-playpause').click();
    await page.waitForFunction(() => !document.body.classList.contains('is-playing'));
    const playerClose = await page.locator('#np-close').boundingBox();
    check(playerClose.y >= 0 && playerClose.y + playerClose.height <= 844, 'player close stays on screen while scrolling');
    await page.locator('#np-modal .np-card').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: path.join(output, 'player-390.png') });
    await page.locator('#np-more').click();
    check(await page.locator('#np-volume').isVisible() && await page.locator('#np-tools .np-volume').count() === 1, 'volume is available inside playback tools');
    await page.locator('#np-tools-close').click();
    await page.locator('#np-tab-lyrics').click();
    check(await page.locator('#np-reading').isVisible(), 'lyrics view stays accessible');
    await page.locator('#np-tab-cover').click();
    await page.locator('#np-close').click();
    for (const [width, height] of [[320, 667], [390, 844], [767, 900]]) {
      await page.setViewportSize({ width, height });
      await page.locator('#orbit-mobile-library').click();
      const layout = await page.evaluate(() => {
        const nav = document.querySelector('.orbit-mobile-nav').getBoundingClientRect();
        return { overflow: document.documentElement.scrollWidth > innerWidth,
          bottom: nav.bottom, y: nav.y, height: innerHeight,
          tabs: Array.from(document.querySelectorAll('.orbit-mobile-tab')).map(el => {
            const r = el.getBoundingClientRect(); return r.width >= 44 && r.height >= 44 && r.right <= innerWidth + 1;
          }) };
      });
      check(!layout.overflow && Math.abs(layout.bottom - height) <= 1 && layout.y >= height - 85 && layout.tabs.every(Boolean), width + 'px has four usable tabs at the viewport bottom');
      await page.locator('#orbit-menu-toggle').click();
      await page.locator('.orbit-more-entry[data-view="library"]').click();
      const row = await page.locator('#lib-list .track').first().boundingBox();
      check(row.width >= width - 44 && row.x >= 0 && row.x + row.width <= width, width + 'px song list fits');
      if (width === 320) await page.screenshot({ path: path.join(output, 'library-320.png') });
    }
    await page.locator('#orbit-menu-toggle').click();
    await page.setViewportSize({ width: 1600, height: 1000 });
    check(!await page.locator('#orbit-more-sheet').evaluate(el => el.open), 'resizing to desktop closes the drawer');
    check(!await page.locator('.orbit-mobile-nav').isVisible() && await page.locator('#rail').isVisible() && await page.locator('#playback-bar').isVisible(), 'desktop keeps its rail and transport');
    check(await page.locator('.np-footer .np-volume').count() === 1, 'desktop player restores the original volume position');
    await page.screenshot({ path: path.join(output, 'desktop-1600.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#orbit-mobile-library').click();
    let homeFails = true;
    await page.route('**/v1/history?limit=8&offset=0', route => homeFails ? route.fulfill({ status: 503, json: { error: 'fixture unavailable' } }) : route.fallback());
    await page.locator('#orbit-mobile-library').click();
    await page.waitForFunction(() => document.querySelector('.orbit-home').textContent.includes('暂时无法读取'));
    check(await page.locator('.orbit-home button').filter({ hasText: '重试' }).count() > 0, 'home read failures expose a retry');
    homeFails = false;
    await page.locator('.orbit-home button').filter({ hasText: '重试' }).first().click();
    await page.waitForFunction(() => !document.querySelector('.orbit-home').hasAttribute('aria-busy'));
    check(!(await page.locator('.orbit-home').textContent()).includes('暂时无法读取'), 'home recovers after retry');
    await page.route('**/v1/tracks?sort=added&limit=12&offset=0', route => route.fulfill({ json: { tracks: [], total: 0 } }));
    await page.route('**/v1/tracks/facets?kind=artist', route => route.fulfill({ json: { facets: [] } }));
    await page.route('**/v1/history?limit=8&offset=0', route => route.fulfill({ json: { items: [], total: 0 } }));
    await page.locator('#orbit-mobile-library').click();
    await page.waitForFunction(() => document.querySelector('.orbit-home').textContent.includes('添加音乐目录'));
    check((await page.locator('.orbit-home').textContent()).includes('听过的音乐会留在这里'), 'empty home explains recent history and library setup');
    await page.locator('#orbit-menu-toggle').click();
    await page.evaluate(() => Skins.apply('classic'));
    check(!await page.locator('.orbit-mobile-nav, .orbit-more-sheet, .orbit-home').count() && !await page.locator('.orbit-menu-open, .orbit-mobile-home').count(), 'skin switching removes mobile surfaces and classes');
    check(await page.locator('.np-footer .np-volume').count() === 1, 'skin switching restores moved player controls');
    check(errors.length === 0, 'no browser exceptions: ' + errors.join('; '));
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ checks, errors, sourceAssets: true }, null, 2));
    console.log(JSON.stringify({ checks, output }));
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') });
    throw error;
  } finally { if (browser) await browser.close(); await fixture.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
