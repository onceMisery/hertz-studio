// SPDX-License-Identifier: MIT
// Real DOM/CSS with the production Theme and room views; no service or audio device.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ui = path.resolve(__dirname, '../plugin/ui');
function source(file) {
  return fs.readFileSync(path.join(ui, file), 'utf8');
}
async function main() {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://room-theme.test') return route.abort();
      const file = decodeURIComponent(url.pathname.slice(1)) || 'index.html';
      if (file.includes('..') || !/^(?:[\w./-]+\.css|index\.html)$/.test(file)) return route.abort();
      let body = source(file);
      if (file === 'index.html') body = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
      return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'text/html', body });
    });
    await page.goto('http://room-theme.test/');
    for (const file of ['themes.js', 'favorites.js', 'room-workspace.js', 'room-view.js', 'room.js']) await page.addScriptTag({ content: source(file) });
    await page.evaluate(async () => {
      Theme.init();
      document.querySelectorAll('.view').forEach(node => { node.hidden = node.id !== 'view-favorites'; });
      window.__appends = 0;
      window.HertzRoom = { activateFavorite: async () => { window.__appends++; } };
      window.VMusicTransport = {
        get: async () => ({ favorites: [{ kind: 'track', source: 'lan', ref_id: 'host:stable', title: '局域网收藏歌曲', artist: '共享艺术家', album: '共享专辑', duration_ms: 32000 }], total: 1 }),
        post: async () => ({ favorited: true })
      };
      Favorites.bind({ ui: { favList: document.querySelector('#fav-list') }, state: { view: 'favorites' }, fmt: () => '0:32', toast() {}, errText: (prefix, error) => prefix + error.message, paintArt() {} });
      await Favorites.load();
    });
    const measureFavorite = () => page.evaluate(() => {
      const badge = document.querySelector('.fav-row .src-badge'), action = document.querySelector('.fav-room-append');
      const row = document.querySelector('.fav-row'), b = badge.getBoundingClientRect(), a = action.getBoundingClientRect(), r = row.getBoundingClientRect();
      return { badgeWidth: b.width, badgeHeight: b.height, badgeOverflow: badge.scrollHeight > badge.clientHeight, actionVisible: getComputedStyle(action).display !== 'none' && +getComputedStyle(action.parentElement).opacity === 1, actionWidth: a.width, actionHeight: a.height, contained: a.left >= r.left && a.right <= r.right && a.top >= r.top && a.bottom <= r.bottom, noOverflow: document.documentElement.scrollWidth <= innerWidth };
    });
    for (const skin of ['classic', 'heijiao', 'liunian', 'orbit', 'qingfeng']) {
      await page.evaluate(skin => {
        document.documentElement.dataset.skin = skin;
        document.querySelectorAll('link[data-skin-css]').forEach(link => { link.disabled = link.dataset.skinCss !== skin; });
      }, skin);
      await page.waitForFunction(() => Array.from(document.querySelectorAll('link[data-skin-css]')).filter(link => !link.disabled).every(link => !!link.sheet));
      for (const width of [1440, 390, 360]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(100);
        const m = await measureFavorite();
        console.log('favorite', skin, width, JSON.stringify(m));
        assert.ok(!m.badgeOverflow && m.badgeWidth > 30, skin + ' LAN source remains horizontal');
        assert.ok(m.actionVisible && m.actionWidth >= 43.5 && m.actionHeight >= 43.5 && m.contained && m.noOverflow, skin + ' explicit append remains usable at ' + width);
      }
    }
    await page.getByRole('button', { name: '加入当前房间队列', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.__appends), 1, 'keyboard activates the explicit append action');
    // Restore the real controller after the isolated favorites fixture.
    await page.addScriptTag({ content: source('room.js') });
    await page.evaluate(async () => {
      document.body.classList.add('room-view');
      document.querySelectorAll('.view').forEach(node => { node.hidden = node.id !== 'view-room'; });
      window.__snapshot = { mode: 'host', room_id: 'room', instance_id: 'host', session_id: 'session', member_id: 'member', name: '同一主题房间', revision: '1', sharing_revision: '1', track_instance_id: '1', current_track: { resource_id: 'song', title: '午夜霓虹', artist: '共享艺术家', duration_ms: 32000 }, queue: [], members: [], permissions: { transport: true, chat_read: true, chat_send: true }, output: {} };
      const transport = { get: async url => url === '/v1/room' ? window.__snapshot : { tracks: [] }, post: async () => ({ tracks: [], queue: [], messages: [], ids: [] }) };
      window.HertzRoomTransport = { create: () => ({ render() {}, notice() {}, destroy() {}, setWorkspaceVisible() {} }) };
      HertzRoom.init({ root: document.querySelector('#view-room'), transport, confirm: async () => true });
      await HertzRoom.onViewEnter();
    });
    const theme = page.getByRole('combobox', { name: '主题色', exact: true });
    for (const width of [1440, 1024, 700, 390, 360]) {
      await page.setViewportSize({ width, height: width === 360 ? 800 : width < 700 ? 844 : 1000 });
      await theme.selectOption('orbit-fog');
      await page.waitForTimeout(500);
      const light = await page.evaluate(() => {
        const root = document.querySelector('#view-room'), primary = root.querySelector('.primary');
        return { bg: getComputedStyle(root).backgroundColor, ink: getComputedStyle(primary).color };
      });
      assert.equal(light.bg, 'rgb(228, 230, 238)', 'room inherits light Theme background: ' + JSON.stringify(light));
      assert.equal(light.ink, 'rgb(255, 255, 255)', 'primary button uses global accent ink');
      await page.evaluate(() => Theme.apply('mineral'));
      assert.equal(await theme.inputValue(), 'mineral', 'global changes sync room immediately');
      await theme.focus();
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => Theme.current().id), await theme.inputValue(), 'native keyboard selection applies Theme');
      assert.ok(await theme.isVisible());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'room fits ' + width);
      if (width < 700) {
        const controls = await page.locator('.room-play-button').boundingBox(), nav = await page.locator('.room-mobile-navigation').boundingBox();
        if (controls.y + controls.height > nav.y) {
          const output = path.resolve(__dirname, '../output/playwright'); fs.mkdirSync(output, { recursive: true });
          await page.screenshot({ path: path.join(output, 'room-theme-layout-failure.png') });
        }
        assert.ok(controls.y + controls.height <= nav.y, 'primary playback stays above bottom navigation at ' + width + ': ' + JSON.stringify({ controls, nav }));
      }
    }
    await page.evaluate(() => { Theme.register({ id: 'room-custom', name: '扩展自定义配色', tokens: { '--bg': '#18232a', '--accent': '#aadeef' } }); });
    await theme.focus();
    await theme.selectOption('room-custom');
    assert.equal(await page.evaluate(() => localStorage.getItem('vmusic.theme.v2')), 'room-custom', 'room uses existing global persistence');
    await page.evaluate(async () => { window.__snapshot = { mode: 'local' }; await HertzRoom.onViewEnter(); });
    assert.ok(await theme.isVisible(), 'unjoined lobby has a theme selector');
    assert.equal(await theme.inputValue(), 'room-custom', 'lobby remount retains global theme');
    console.log('Room theme browser: inherited colors, bidirectional sync, custom themes, keyboard, lobby, responsive geometry and LAN favorite actions passed.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
