'use strict';

// Real page + isolated null backend. Current workspace assets replace embedded
// assets so CSS iteration does not require rebuilding the Rust executable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const web = path.join(root, 'plugin/ui');
const output = path.join(root, 'output/playwright/ios');
const base = process.env.IOS_UI_URL || 'http://127.0.0.1:18776';
const diagnose = process.env.IOS_DIAGNOSE === '1';
let token;
let checks = 0;
const failures = [];

function check(condition, label) {
  checks++;
  if (!condition) failures.push(label);
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`);
}
async function api(method, endpoint, body) {
  const response = await fetch(base + endpoint, {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(response.ok, `${method} ${endpoint}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function rect(page, selector) { return page.locator(selector).boundingBox(); }

async function fixtures() {
  const folder = path.join(root, 'output/ios-skin-audit/fixtures');
  fs.mkdirSync(folder, { recursive: true });
  const wav = Buffer.alloc(44 + 8000 * 30 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 1; i <= 24; i++) fs.writeFileSync(path.join(folder, `界面验收 · ${String(i).padStart(2, '0')}.wav`), wav);
  await api('POST', '/v1/library/scan', { root: folder });
  for (let attempt = 0; attempt < 100; attempt++) {
    const data = await api('GET', '/v1/tracks?limit=200');
    if (data.tracks.length >= 24) return data.tracks;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Fixture scan did not finish');
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const health = await fetch(base + '/v1/health').then(r => r.json());
  assert.equal(health.backend, 'null', 'Use a dedicated VMUSIC_BACKEND=null instance');
  console.log('Isolated service ready; loading workspace UI');
  const html = await fetch(base).then(r => r.text());
  token = /window\.__VMUSIC_TOKEN__\s*=\s*"([^"]+)"/.exec(html)?.[1];
  assert.ok(token, 'Test instance must inject its token');
  await api('PUT', '/v1/settings', { stage_idle_hide: true, reduce_motion: false, cover_follow: false });
  await api('POST', '/v1/player/stop');
  assert.ok(!(await api('GET', '/v1/state')).track_id,
    'Idle coverage needs a fresh isolated --data-dir; stop intentionally retains the loaded track');
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true,
    ignoreDefaultArgs: ['--hide-scrollbars'] });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.context().grantPermissions(['local-network-access'], { origin: base });
    page.setDefaultTimeout(15000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('websocket', socket => socket.on('socketerror', e => console.error('WebSocket: ' + String(e).replaceAll(token, '[token]'))));
    await page.route(base + '/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/v1/') || url.pathname === '/ws') return route.continue();
      const relative = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html';
      const file = path.resolve(web, relative);
      if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.continue();
      const extension = path.extname(file);
      if (!['.html', '.js', '.css'].includes(extension)) return route.continue();
      const source = diagnose && relative === 'skins/skin.ios.css' ? path.join(output, 'skin.before.css') : file;
      const body = fs.readFileSync(source, 'utf8').replace('__VMUSIC_TOKEN_VALUE__', token);
      return route.fulfill({ body, contentType: { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' }[extension] });
    });
    await page.route('**/v1/recommend/daily/online?**', route => route.fulfill({ json: { tracks: [], sources: [] } }));
    await page.route('**/v1/online/account?**', route => route.fulfill({ json: { logged_in: false } }));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.Skins && window.Theme && document.getElementById('settings-entry').onclick
      && document.getElementById('conn').textContent === '服务已连接').catch(async error => {
        console.error(await page.evaluate(() => ({ skins: !!window.Skins, theme: !!window.Theme,
          settings: !!document.getElementById('settings-entry')?.onclick, connection: document.getElementById('conn')?.textContent })));
        console.error(errors);
        throw error;
      });
    await page.evaluate(() => { Skins.apply('ios'); Theme.apply('ios-light'); });
    // Wait for the stylesheet that was initially disabled to finish loading.
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--skin-gap').trim());
    for (const theme of ['ios-light', 'mineral']) {
      await page.evaluate(id => Theme.apply(id), theme);
      for (const [width, height] of [[1440, 900], [1280, 720], [1024, 768], [768, 1024], [390, 844], [320, 640], [844, 390]]) {
        await page.setViewportSize({ width, height });
        await page.locator('.rail-item[data-view="library"]').click();
        const label = `${theme} ${width}x${height}`;
        const [rail, column, bar] = await Promise.all(['.rail', '.column', '.bar'].map(s => rect(page, s)));
        check(column.width >= Math.min(width - 32, 560), label + ' usable content width');
        check(column.x + column.width <= width + 1 && column.y + column.height <= bar.y + 1, label + ' content stays above player and within viewport');
        const nav = await page.locator('.rail-item').evaluateAll(elements => elements.map(el => {
          const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
            label: getComputedStyle(el.querySelector('span')).display };
        }));
        check(nav.every(r => r.width >= 44 && r.height >= 44 && (width <= 620 || r.x >= 0 && r.right <= width + 1)), label + ' navigation hit areas remain at least 44px');
        check(nav.every(r => r.label !== 'none'), label + ' navigation text remains visible');
        if (width > 1240) {
          check(rail.width >= 160 && column.x >= rail.x + rail.width, label + ' desktop sidebar has room for icon and label');
          check(width - (column.x + column.width) <= 32, label + ' idle layout releases the stage column');
        }
        if (width <= 620) check(column.y >= rail.y + rail.height - 1 && column.x <= 20, label + ' compact navigation leaves full content width');
        await page.screenshot({ path: path.join(output, `${diagnose ? 'before' : 'after'}-${theme}-${width}.png`), animations: 'disabled' });
        // Use existing handlers; no substitute navigation implementation.
        await page.locator('.rail-item[data-view="settings"]').click();
        if (width <= 620) {
          const settings = await rect(page, '.rail-item[data-view="settings"]');
          check(settings.x >= 0 && settings.x + settings.width <= width + 1, label + ' last navigation item scrolls into view');
        }
        check(await page.locator('#view-settings').isVisible(), label + ' settings navigation works');
        await page.locator('#view-settings').evaluate(el => { el.scrollTop = el.scrollHeight; });
        check(await page.locator('#view-settings').evaluate(el => el.scrollTop > 0), label + ' settings can scroll to the end');
        const lastGroup = await page.locator('#view-settings .set-group').last().boundingBox();
        check(lastGroup && lastGroup.y < bar.y, label + ' final settings group is reachable');
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => Theme.apply('ios-light'));
    await page.locator('.rail-item[data-view="library"]').click();
    const active = await page.locator('.rail-item.active').evaluate(el => {
      const style = getComputedStyle(el); return { color: style.color, icon: getComputedStyle(el.querySelector('svg')).color, weight: style.fontWeight };
    });
    check(active.color === active.icon && Number(active.weight) >= 600, 'active navigation uses one accent and stronger weight');
    await page.locator('#scan-toggle').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    check(await page.locator('#scan-toggle').evaluate(el => getComputedStyle(el).outlineStyle !== 'none'), 'keyboard focus is visible');
    const schemes = [];
    for (const id of ['ios-light', 'mineral', 'ios-light']) {
      await page.evaluate(id => Theme.apply(id), id);
      schemes.push(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme));
    }
    check(schemes.join() === 'light,dark,light', 'native controls follow light/dark/light theme switching');
    if (!diagnose) {
      const tracks = await fixtures();
      await api('POST', '/v1/player/load', { track_id: tracks[0].id, queue: tracks.map(t => t.id) });
      await page.waitForFunction(() => document.body.dataset.stageIdle !== '1' && document.getElementById('bar-title').textContent);
      for (const theme of ['ios-light', 'mineral']) {
        await page.evaluate(id => Theme.apply(id), theme);
        for (const [width, height] of [[1440, 900], [1280, 720], [390, 844], [320, 640], [844, 390]]) {
          await page.setViewportSize({ width, height });
          await page.locator('.rail-item[data-view="library"]').click();
          if (width <= 1240) {
            await page.waitForFunction(() => document.querySelector('.stage').getBoundingClientRect().left >= innerWidth);
            check(true, `${theme} ${width} drawer is fully outside the viewport when closed`);
          }
          const label = `loaded ${theme} ${width}x${height}`;
          const [column, bar] = await Promise.all(['.column', '.bar'].map(s => rect(page, s)));
          check(column.width >= Math.min(width - 32, 560), label + ' content keeps usable width');
          if (width > 1240) {
            const stage = await rect(page, '.stage');
            check(stage.x >= column.x + column.width && stage.y + stage.height <= bar.y + 1, label + ' stage neither overlaps content nor player');
          }
          const controls = await page.locator('.bar button, #bar-track, #progress').evaluateAll(elements => elements.filter(el => el.getClientRects().length).map(el => {
            const r = el.getBoundingClientRect(); return { x: r.x, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
          }));
          check(controls.every(r => r.x >= 0 && r.right <= width + 1 && r.bottom <= height + 1 && r.width > 0), label + ' playback controls fit viewport');
          await page.locator('#lib-list .track').last().scrollIntoViewIfNeeded();
          const last = await page.locator('#lib-list .track').last().boundingBox();
          check(last.y >= column.y && last.y + last.height <= bar.y + 1, label + ' final track scrolls above the player');
          await page.screenshot({ path: path.join(output, `loaded-${theme}-${width}.png`), animations: 'disabled' });
          await page.locator('#bar-track').click();
          check(await page.locator('#np-modal').isVisible(), label + ' now-playing popup opens');
          const close = await rect(page, '#np-close');
          check(close && close.x >= 0 && close.y >= 0 && close.x + close.width <= width + 1 && close.y + close.height <= height + 1, label + ' popup close stays reachable');
          await page.locator('#np-close').click();
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await api('POST', '/v1/player/pause');
      await page.waitForFunction(() => !Stage.presentation().playing);
      await page.locator('#playpause').click();
      await page.waitForFunction(() => Stage.presentation().playing);
      check((await api('GET', '/v1/state')).playing, 'existing play button controls real null-backend playback');
      await page.locator('#playpause').click();
      await page.waitForFunction(() => !Stage.presentation().playing);
      check(!(await api('GET', '/v1/state')).playing, 'existing pause button controls playback');
      await page.locator('#next').click();
      await page.waitForFunction(id => Stage.presentation().track?.id === id, tracks[1].id);
      check((await api('GET', '/v1/state')).track_id === tracks[1].id, 'next track preserves existing queue behavior');
      await api('POST', '/v1/player/pause');
      await page.locator('.rail-item[data-view="settings"]').click();
      await page.locator('#view-settings').evaluate(el => { el.scrollTop = 0; });
      // A temporary disabled state exercises styling, without invoking the button.
      const button = page.locator('#scan-toggle');
      await page.locator('.rail-item[data-view="library"]').click();
      await button.evaluate(el => { el.disabled = true; });
      await button.hover();
      check(await button.evaluate(el => Number(getComputedStyle(el).opacity) < .6 && getComputedStyle(el).transform === 'none'), 'disabled control remains subdued and does not move on hover');
      await button.evaluate(el => { el.disabled = false; });
      await page.evaluate(() => { Theme.apply('ios-light'); ThemeStudio.setWallpaper('', { persist: false }); });
      await page.locator('#lib-list .track').first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, 'desktop-light.png'), animations: 'disabled' });
      await page.evaluate(() => Theme.apply('mineral'));
      await page.screenshot({ path: path.join(output, 'desktop-dark.png'), animations: 'disabled' });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => Theme.apply('ios-light'));
      await page.waitForFunction(() => document.querySelector('.stage').getBoundingClientRect().left >= innerWidth);
      await page.locator('#lib-list .track').first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, 'mobile-light.png'), animations: 'disabled' });
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    check(await page.locator('#scan-toggle').evaluate(el => parseFloat(getComputedStyle(el).transitionDuration) < 0.01), 'reduced motion removes control transitions');
    await page.evaluate(() => Skins.apply('classic'));
    check(await page.evaluate(() => document.querySelector('[data-skin-css="ios"]').disabled), 'switching away disables the entire iOS skin');
    check(errors.length === 0, 'no browser exceptions: ' + errors.join('; '));
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(output, diagnose ? 'before.json' : 'results.json'), JSON.stringify({ checks, failures, errors }, null, 2));
  console.log(`${checks - failures.length}/${checks} passed`);
  if (failures.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
