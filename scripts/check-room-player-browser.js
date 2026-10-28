// SPDX-License-Identifier: MIT
// Real room controller and CSS, with an offline transport fixture.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ui = path.resolve(__dirname, '../plugin/ui');
const output = path.resolve(__dirname, '../output/playwright/room-player');
const source = file => fs.readFileSync(path.join(ui, file), 'utf8');
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://room-player.test') return route.abort();
      const file = decodeURIComponent(url.pathname.slice(1)) || 'index.html';
      if (file.includes('..') || !/^(?:[\w./-]+\.css|index\.html)$/.test(file)) return route.abort();
      const body = file === 'index.html' ? source(file).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '') : source(file);
      return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'text/html', body });
    });
    await page.goto('http://room-player.test/');
    for (const file of ['host.js', 'themes.js', 'favorites.js', 'room-transport.js', 'room-workspace.js', 'room-view.js', 'room.js']) await page.addScriptTag({ content: source(file) });
    await page.evaluate(async () => {
      Theme.init(); Theme.apply('orbit-fog');
      window.__requests = [];
      window.__snapshot = { mode: 'host', room_id: 'room', instance_id: 'host', session_id: 'session', member_id: 'member', name: '深夜一起听', revision: '1', sharing_revision: '1', track_instance_id: '1', current_track: { resource_id: 'song', title: '夜机', artist: '张敬轩', duration_ms: 256000 }, position_ms: 32000, playing: true, queue: [], members: [], permissions: { transport: true, chat_read: true, chat_send: true }, output: { enabled: true, settings: { volume: .72 } } };
      window.__show = room => {
        document.body.classList.toggle('room-view', room);
        document.querySelectorAll('.view').forEach(node => { node.hidden = node.id !== (room ? 'view-room' : 'view-library'); });
        if (room) return HertzRoom.onViewEnter();
        HertzRoom.onViewExit();
      };
      document.querySelector('[data-view="room"]').onclick = () => window.__show(true);
      const transport = {
        get: async url => url === '/v1/room' ? window.__snapshot : { tracks: [] },
        post: async (url, body) => {
          window.__requests.push({ url, body: body.action === 'peer' ? body.request : body });
          if (body.action === 'output') window.__snapshot.output = { enabled: body.enabled, settings: body.settings };
          return { tracks: [], queue: [], messages: [], ids: [], state: 'applied' };
        }
      };
      HertzRoom.init({ root: document.querySelector('#view-room'), transport, onReturn: () => window.__show(false) });
      await window.__show(true); window.__show(false);
    });
    const bar = page.locator('.room-global');
    const collapse = page.getByRole('button', { name: '收起一起听播放栏', exact: true });
    const expand = page.getByRole('button', { name: '展开一起听播放栏', exact: true });
    const room = bar.getByRole('button', { name: '返回房间', exact: true });
    const volumeButton = bar.getByRole('button', { name: '调整本机音量', exact: true });
    const volume = bar.getByRole('slider', { name: '房间本机音量', exact: true });
    const volumePanel = bar.locator('.room-global-volume-panel');
    const geometry = () => bar.evaluate(node => {
      const bounds = node.getBoundingClientRect();
      const visible = [...node.querySelectorAll('button,input')].filter(item => item.getClientRects().length);
      const boxes = visible.map(item => item.getBoundingClientRect());
      const overlapping = boxes.some((a, i) => boxes.slice(i + 1).some(b => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1));
      return { width: bounds.width, height: bounds.height, fits: bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight, contained: boxes.every(box => box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom), targets: visible.filter(item => item.tagName === 'BUTTON').every(item => item.getBoundingClientRect().height >= 44), overlapping, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    for (const skin of ['classic', 'heijiao', 'liunian', 'orbit', 'qingfeng']) {
      await page.evaluate(skin => {
        document.documentElement.dataset.skin = skin;
        document.querySelectorAll('link[data-skin-css]').forEach(link => { link.disabled = link.dataset.skinCss !== skin; });
      }, skin);
      await page.waitForFunction(() => [...document.querySelectorAll('link[data-skin-css]')].filter(link => !link.disabled).every(link => !!link.sheet));
      for (const theme of ['orbit-fog', 'mineral']) {
        await page.evaluate(theme => { Theme.apply(theme); if (Theme.current().id !== theme) throw new Error('Unknown theme: ' + theme); }, theme);
        for (const width of [1440, 1024, 768, 700, 600, 390, 360]) {
          await page.setViewportSize({ width, height: 1000 });
          for (const compact of [false, true]) {
            if (compact) await collapse.click();
            const m = await geometry();
            assert.ok(m.fits && m.contained && m.targets && !m.overlapping && !m.overflow, JSON.stringify({ skin, theme, viewport: width, compact, ...m }));
            assert.equal(await room.isVisible(), true, 'return shortcut is available in both modes');
            if (skin === 'classic' && (width === 1440 || width === 390)) await page.screenshot({ path: path.join(output, `${theme}-${width}-${compact ? 'collapsed' : 'expanded'}.png`) });
            await volumeButton.click();
            const v = await volume.boundingBox(), p = await volumePanel.boundingBox(), b = await volumeButton.boundingBox();
            assert.ok(v.height > v.width * 2 && p.y + p.height < b.y && p.x >= 0 && p.x + p.width <= width, 'volume is vertical and opens above the icon: ' + JSON.stringify({ skin, theme, width, compact, v, p, b }));
            if (skin === 'classic' && (width === 1440 || width === 390)) await page.screenshot({ path: path.join(output, `${theme}-${width}-${compact ? 'collapsed' : 'expanded'}-volume.png`) });
            await page.keyboard.press('Escape');
            assert.equal(await volumePanel.isVisible(), false, 'Escape closes volume');
            assert.equal(await volumeButton.evaluate(node => node === document.activeElement), true, 'Escape restores icon focus');
            if (compact) await expand.click();
          }
        }
      }
      console.log('PASS room player responsive geometry:', skin);
    }
    await volumeButton.click();
    await volume.press('ArrowUp');
    await page.waitForFunction(() => window.__snapshot.output.settings.volume === .73);
    assert.equal(await volume.inputValue(), '73', 'up increases native vertical slider');
    assert.equal(await bar.locator('.room-global-volume-value').textContent(), '73');
    await volume.click({ position: { x: 20, y: 8 } });
    await page.waitForFunction(() => window.__snapshot.output.settings.volume > .9);
    await volume.click({ position: { x: 20, y: 108 } });
    await page.waitForFunction(() => window.__snapshot.output.settings.volume < .1);
    await page.locator('.topbar').click({ position: { x: 3, y: 3 } });
    assert.equal(await volumePanel.isVisible(), false, 'outside click closes volume');
    await collapse.focus(); await page.keyboard.press('Enter');
    assert.equal(await expand.getAttribute('aria-expanded'), 'false', 'keyboard collapses player');
    await page.evaluate(async () => { await window.__show(true); HertzRoom.navigate('lobby'); window.__show(false); });
    assert.equal(await expand.isVisible(), true, 'view round trip preserves collapse');
    await room.click();
    assert.equal(await bar.isVisible(), false, 'return shortcut hides global player');
    assert.equal(await page.locator('#view-room').getAttribute('data-room-page'), 'play', 'shortcut opens active playback even if the room was left on lobby');
    await page.evaluate(() => window.__show(false));
    assert.equal(await expand.isVisible(), true);
    await expand.click();
    await page.evaluate(() => { window.__requests.length = 0; });
    await collapse.click(); await expand.click();
    assert.equal(await page.evaluate(() => window.__requests.length), 0, 'presentation controls never send room requests');
    await collapse.click();
    await volumeButton.click();
    await room.click();
    await page.evaluate(() => window.__show(false));
    assert.equal(await volumePanel.isVisible(), false, 'room navigation closes volume');
    await bar.getByRole('button', { name: '暂停', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__requests.filter(item => item.body.action === 'playback' && item.body.command.action === 'pause').length), 1, 'mini player uses real room command');
    await page.evaluate(async () => { window.__snapshot.mode = 'reconnecting'; await HertzRoom.onViewEnter(); window.__show(false); });
    assert.equal(await bar.getByRole('button', { name: '暂停', exact: true }).isDisabled(), true);
    assert.equal(await room.isEnabled(), true, 'reconnect preserves navigation');
    await page.evaluate(async () => { window.__snapshot.output.enabled = false; await HertzRoom.onViewEnter(); window.__show(false); });
    assert.equal(await volumeButton.isDisabled(), true, 'local output must be enabled to change volume');
    await page.evaluate(async () => { window.__snapshot.mode = 'local'; await HertzRoom.onViewEnter(); window.__show(false); });
    assert.equal(await bar.isVisible(), false);
    assert.equal(await page.locator('body').evaluate(node => node.classList.contains('room-player-collapsed')), false);
    await page.evaluate(() => HertzRoom.destroy());
    assert.equal(await bar.count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS room player keyboard, navigation, retained collapse, command routing, reconnect and cleanup');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
