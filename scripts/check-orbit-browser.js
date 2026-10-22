// SPDX-License-Identifier: MIT
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { uiUrl, uiToken } = require('./ui-token');
const { readAssets } = require('./ui-assets');
const root = path.resolve(__dirname, '..');
const base = process.env.PLAYER_UI_URL || 'http://127.0.0.1:18826';
const output = path.join(root, 'output/playwright/orbit');
const source = process.env.PLAYER_SOURCE_ASSETS === '1';
let checks = 0;

function check(value, label) {
  assert.ok(value, label);
  checks++;
  console.log('PASS ' + label);
}

async function api(method, endpoint, body, type = 'application/json') {
  const response = await fetch(base + endpoint, {
    method, headers: { Authorization: 'Bearer ' + uiToken(), 'Content-Type': type },
    body: body == null ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  assert.ok(response.ok, method + ' ' + endpoint + ': ' + response.status);
  return response.status === 204 ? null : response.json();
}

async function until(read, predicate) {
  let last;
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + JSON.stringify(last));
}

async function fixtures() {
  const dir = path.join(output, 'audio');
  fs.mkdirSync(dir, { recursive: true });
  const wav = Buffer.alloc(44 + 8000 * 180 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 1; i <= 6; i++) fs.writeFileSync(path.join(dir, 'Orbit ' + i + '.wav'), wav);
  fs.writeFileSync(path.join(dir, 'Orbit 1.lrc'), '[00:00.00]星轨\n[00:05.00]音乐与文字在这里相遇\n[00:30.00]继续聆听\n');
  await api('POST', '/v1/library/scan', { root: dir });
  const data = await until(() => api('GET', '/v1/tracks?limit=200'), data =>
    data.tracks?.filter(track => track.path.startsWith(dir)).length === 6);
  const tracks = data.tracks.filter(track => track.path.startsWith(dir)).sort((a, b) => a.title.localeCompare(b.title));
  await api('POST', '/v1/tracks/' + tracks[0].id + '/cover',
    fs.readFileSync(path.join(root, 'plugin/ui/wallpapers/celestial-sky.jpg')), 'image/jpeg');
  return tracks;
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
  const errors = [];
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('vmusic.defaultView', 'library'));
    await page.route('**/v1/online/account?**', route => route.fulfill({ json: { logged_in: false } }));
    await page.route('**/v1/recommend/daily/online?**', route => route.fulfill({ json: { tracks: [], sources: [] } }));
    if (source) {
      const assets = new Map(readAssets().map(asset => [asset.path, asset]));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== base) return route.continue();
        if (assets.has(url.pathname)) {
          const asset = assets.get(url.pathname);
          return route.fulfill({ path: asset.file, contentType: asset.mime === 'JS' ? 'application/javascript' : 'text/css' });
        }
        if (url.pathname === '/') {
          const response = await route.fetch();
          return route.fulfill({ response, contentType: 'text/html', body:
            fs.readFileSync(path.join(root, 'plugin/ui/index.html'), 'utf8').replace('__VMUSIC_TOKEN_VALUE__', uiToken()) });
        }
        return route.continue();
      });
    }
    await page.goto(uiUrl(base));
    await page.waitForFunction(() => window.Skins && document.getElementById('conn').textContent === '服务已连接');
    check(await page.evaluate(() => Skins.list().some(skin => skin.id === 'orbit' && skin.name === '星轨')),
      '星轨 is selectable through the existing skin registry');
    check(await page.evaluate(() => Skins.currentId() === 'orbit'), 'fresh startup selects 星轨 by default');

    const tracks = await fixtures(), queue = tracks.map(track => track.id);
    await api('POST', '/v1/player/load', { track_id: queue[0], queue });
    await api('POST', '/v1/player/pause');
    await page.reload();
    await page.waitForFunction(() => window.Skins && document.getElementById('conn').textContent === '服务已连接');
    await page.evaluate(() => restoreQueue());
    await until(() => page.evaluate(() => Stage.presentation().track?.id), id => id === queue[0]);
    await page.evaluate(() => {
      const presentation = Stage.presentation();
      Stage.setTrack({ ...presentation.track, source: 'netease' }, presentation.cover);
      document.dispatchEvent(new Event('playback:track'));
    });
    await page.waitForFunction(() => document.querySelector('.orbit-current-source .src-badge'));
    check((await page.locator('.orbit-current-source .src-badge').getAttribute('title')).includes('网易云'),
      'current-track card shows the provider icon label');
    check(await page.locator('.orbit-current-source .src-badge img').evaluate(img => img.complete && img.naturalWidth > 0),
      'current-track provider icon asset renders');
    check(await page.locator('.orbit-current-duration').textContent() === '3:00',
      'current-track card shows the track duration');
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.evaluate(() => Skins.apply('orbit'));
    await page.waitForSelector('.orbit-queue-row');
    check(await page.locator('.orbit-main #column').count() === 1 && await page.locator('.orbit-main #stage').count() === 1,
      'layout reuses the original library and stage nodes');
    check(await page.evaluate(theme => document.documentElement.dataset.theme === theme, theme), 'switching skin preserves theme');
    check(await page.locator('#cover').count() === 1 && await page.locator('#playpause').count() === 1, 'business node IDs remain unique');
    const navToggle = page.locator('#orbit-nav-toggle');
    check(await navToggle.count() === 1, 'navigation has an accessible expand/hide control outside the rail');
    check(await navToggle.getAttribute('aria-controls') === 'rail' && await navToggle.getAttribute('aria-expanded') === 'true',
      'navigation toggle identifies its target and expanded state');
    check(await page.locator('.orbit-depth').count() === 14, 'vinyl retains the original fourteen physical depth layers');
    check(await page.locator('.orbit-ring').count() === 0, 'record is one solid vinyl without exterior decorative rings');
    const recordToggle = page.locator('#orbit-record-toggle');
    check(await recordToggle.getAttribute('aria-pressed') === 'false', 'record starts with the cover on the outer surface');
    await recordToggle.click();
    check(await recordToggle.getAttribute('aria-pressed') === 'true'
      && await page.locator('#cover').evaluate(el => getComputedStyle(el).backgroundSize === '36% 36%'),
      'clicking the record moves the cover into the black vinyl center');
    await recordToggle.click();
    check(await recordToggle.getAttribute('aria-pressed') === 'false'
      && await page.locator('#cover').evaluate(el => getComputedStyle(el).backgroundSize === 'cover'),
      'clicking the record again restores the outer cover');
    await recordToggle.focus();
    await page.keyboard.press('Enter');
    check(await recordToggle.getAttribute('aria-pressed') === 'true', 'Enter switches the record style');
    await page.keyboard.press('Space');
    check(await recordToggle.getAttribute('aria-pressed') === 'false', 'Space switches the record style back');
    check(!await page.locator('#stage .stage-fx').isVisible(), 'original stage vignette does not frame the sculpted record');
    const rig = page.locator('.orbit-rig');
    await page.mouse.move(4, 4);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.orbit-rig')).transform !== 'none');
    await rig.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    const rest = await rig.evaluate(el => getComputedStyle(el).transform);
    const turntable = await page.locator('.orbit-turntable').boundingBox();
    await page.mouse.move(turntable.x + turntable.width * .85, turntable.y + turntable.height * .7);
    await page.waitForTimeout(350);
    check(await rig.evaluate(el => getComputedStyle(el).transform) !== rest, 'pointer movement changes the record perspective');
    await page.mouse.move(4, 4);
    await page.waitForTimeout(350);
    const resetTransform = await until(() => rig.evaluate(el => getComputedStyle(el).transform), value => value === rest);
    check(resetTransform === rest, 'leaving the record restores its resting perspective');
    const row = page.locator('#lib-list .track').first();
    const rowRest = await row.evaluate(el => ({ y:el.getBoundingClientRect().y, shadow:getComputedStyle(el).boxShadow }));
    await row.hover();
    await page.waitForTimeout(300);
    check(await row.evaluate((el, before) => el.getBoundingClientRect().y < before.y - 2 && getComputedStyle(el).boxShadow !== before.shadow, rowRest),
      'hovering a library row visibly lifts it and deepens its shadow');
    const selection = row.locator('.t-select');
    await selection.click({ delay:120 });
    check(await selection.isChecked() && (await api('GET', '/v1/state')).track_id === queue[0],
      'lifted-row selection remains a selection without starting playback');
    await selection.click({ delay:120 });
    const queueRow = page.locator('.orbit-queue-row').last();
    const queueRest = await queueRow.evaluate(el => el.getBoundingClientRect().y);
    await queueRow.hover();
    await page.waitForTimeout(300);
    check(await queueRow.evaluate((el, before) => el.getBoundingClientRect().y < before - 2, queueRest), 'queue rows share the raised hover effect');
    await page.mouse.move(4, 4);

    await page.locator('#orbit-play').click();
    await until(() => api('GET', '/v1/state'), state => state.playing);
    await page.waitForFunction(() => getComputedStyle(document.getElementById('cover')).animationPlayState === 'running');
    const playingTransform = await page.locator('#cover').evaluate(el => getComputedStyle(el).transform);
    await until(() => page.locator('#cover').evaluate(el => getComputedStyle(el).transform), transform => transform !== playingTransform);
    check(true, 'record rotates during real playback');
    await page.locator('#orbit-play').click();
    await until(() => api('GET', '/v1/state'), state => !state.playing);
    check(true, 'hero play/pause controls the real backend');
    await page.locator('#orbit-favorite').click();
    await until(() => page.locator('#bar-favorite').getAttribute('aria-pressed'), value => value === 'true');
    await page.locator('#orbit-favorite').click();
    await until(() => page.locator('#bar-favorite').getAttribute('aria-pressed'), value => value === 'false');
    check(true, 'hero favorite uses the existing persistent favorite action');
    await page.locator('.orbit-queue-row[data-index="1"]').click();
    await until(() => api('GET', '/v1/state'), state => state.track_id === queue[1]);
    await api('POST', '/v1/player/pause');
    await until(() => page.locator('.orbit-queue-row[data-index="1"]').getAttribute('aria-current'), value => value === 'true');
    check(true, 'sidebar activates the actual queue index and follows current track');
    await page.locator('#progress').fill('350'); await page.locator('#progress').dispatchEvent('change');
    await until(() => api('GET', '/v1/state'), state => Math.abs(state.position_ms - 63000) < 300);
    await page.locator('#volume').fill('43');
    await until(() => api('GET', '/v1/state'), state => Math.abs(state.volume - .43) < .005);
    check(true, 'original seek and volume controls remain connected');

    await page.locator('#orbit-player').click();
    await page.waitForSelector('#np-modal:not([hidden])');
    await page.locator('#np-close').click();
    check(await page.locator('.orbit-rig #cover').count() === 1, 'ordinary player returns its record to 星轨');
    for (const view of ['online', 'podcasts', 'playlists', 'queue', 'favorites', 'library']) {
      await page.locator('.rail-item[data-view="' + view + '"]').click();
      check(await page.locator('#view-' + view).isVisible(), view + ' remains reachable');
    }
    check(!await page.locator('#settings-entry').isVisible(), 'duplicate top-right settings entry is hidden');
    await page.locator('.rail-item[data-view="settings"]').click();
    await page.waitForFunction(() => SkinSettingsSheet.isOpen());
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !SkinSettingsSheet.isOpen());
    check(!await page.evaluate(() => SkinSettingsSheet.isOpen()), 'shared settings opens and dismisses');

    for (const [width, height] of [[1600,1000], [1366,768], [1024,600], [768,1024], [390,844], [320,667]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(160);
      const layout = await page.evaluate(() => {
        const box = selector => {
          const el = document.querySelector(selector), style = getComputedStyle(el), r = el.getBoundingClientRect();
          return { x:r.x, y:r.y, right:r.right, bottom:r.bottom, width:r.width, height:r.height,
            visible:style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0 };
        };
        return { width:innerWidth, height:innerHeight, scroll:document.documentElement.scrollWidth,
          top:box('.topbar'), rail:box('.rail'), main:box('.orbit-main'), column:box('#column'),
          bar:box('#playback-bar'), play:box('#playpause'), volume:box('#volume'), queue:box('.orbit-queue') };
      });
      check(layout.scroll <= width + 1, width + 'px has no horizontal page overflow');
      for (const key of ['top','rail','main','column','bar','play','volume']) {
        const b = layout[key];
        check(b.visible && b.width > 8 && b.height > 8 && b.x >= -1 && b.right <= width + 1 && b.bottom <= height + 1,
          width + 'px ' + key + ' is visible and fits: ' + JSON.stringify(b));
      }
      check(layout.column.height >= 100, width + 'px leaves room for library content');
      if (layout.queue.visible) check(layout.queue.bottom <= layout.bar.y + 1, width + 'px sidebar stays above player');
      await page.screenshot({ path:path.join(output, width + 'x' + height + '.png') });
      await recordToggle.click();
      check(await recordToggle.getAttribute('aria-pressed') === 'true'
        && await page.locator('#stage').evaluate(el => el.scrollLeft === 0),
        width + 'px switches record style without shifting the stage');
      await recordToggle.click();
      await navToggle.click();
      check(!await page.locator('#rail').isVisible() && await navToggle.getAttribute('aria-expanded') === 'false',
        width + 'px hides navigation while keeping the expand control available');
      const collapsed = await page.locator('.orbit-main').boundingBox();
      check(width > 620 ? collapsed.width > layout.main.width + 50 : collapsed.y < layout.main.y - 40,
        width + 'px reclaims the hidden navigation space');
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)
        && await page.locator('#playpause').isVisible(), width + 'px hidden navigation keeps playback and page bounds intact');
      if (width === 1600 || width === 320) {
        await page.screenshot({ path:path.join(output, width + 'x' + height + '-nav-hidden.png') });
      }
      await navToggle.focus();
      await page.keyboard.press('Enter');
      check(await page.locator('#rail').isVisible() && await navToggle.getAttribute('aria-expanded') === 'true',
        width + 'px keyboard expands navigation again');
    }

    await page.setViewportSize({ width:1600, height:1000 });
    await page.emulateMedia({ reducedMotion:'reduce' });
    check(await page.locator('#cover').evaluate(el => getComputedStyle(el).animationName === 'none'), 'reduced motion disables automatic record animation');
    await page.emulateMedia({ reducedMotion:'no-preference' });
    const themes = await page.evaluate(() => Theme.list().filter(theme => ['mineral','orbit-fog','sakura','celestial'].includes(theme.id)).map(theme => theme.id));
    for (const themeId of themes) {
      await page.evaluate(id => Theme.apply(id), themeId);
      await page.waitForTimeout(700);
      check(await page.locator('#stage').evaluate(el => getComputedStyle(el).backgroundColor === 'rgba(0, 0, 0, 0)'),
        themeId + ' record stays unframed on the main surface');
      await page.screenshot({ path:path.join(output, 'theme-' + themeId + '.png') });
      check(await page.locator('#orbit-play').isVisible(), themeId + ' keeps transport visible');
    }

    await page.evaluate(() => Skins.apply('orbit'));
    await page.reload();
    await page.waitForFunction(() => window.Skins && Skins.currentId() === 'orbit' && document.querySelector('.orbit-main'));
    check(true, 'reload restores 星轨');
    await navToggle.click();
    const recovery = await page.evaluate(() => {
      Skins.apply('classic');
      const navClean = !document.querySelector('#orbit-nav-toggle, .orbit-nav-hidden')
        && getComputedStyle(document.getElementById('rail')).display !== 'none';
      const stage = document.getElementById('stage'), column = document.getElementById('column');
      const stageParent = stage.parentNode, columnParent = column.parentNode;
      for (const id of ['orbit','orbit','sheen','orbit','heijiao','orbit','liunian','orbit','qingfeng','orbit','classic']) Skins.apply(id);
      const clean = stage.parentNode === stageParent && column.parentNode === columnParent
        && !document.querySelector('.orbit-main, .orbit-queue, .orbit-anchor, #orbit-record-toggle');
      const Observer = window.MutationObserver;
      window.MutationObserver = class { constructor() { window.MutationObserver = Observer; throw new Error('orbit mount probe'); } };
      let failed = false;
      try { Skins.apply('orbit'); } catch (error) { failed = /orbit mount probe/.test(error.message); }
      finally { window.MutationObserver = Observer; }
      return { clean, failed, navClean, restored:Skins.currentId() === 'classic' && stage.parentNode === stageParent
        && column.parentNode === columnParent && !document.querySelector('.orbit-main, .orbit-queue, .orbit-anchor') };
    });
    check(recovery.clean, 'repeated selection and cross-skin switching restore original nodes');
    check(recovery.navClean, 'switching away from hidden navigation restores the original rail and removes the toggle');
    check(recovery.failed && recovery.restored, 'partial mount failure cleans resources and restores previous skin');
    await page.evaluate(() => Skins.apply('orbit'));
    await page.evaluate(async () => {
      const link = document.querySelector('link[data-skin-css="orbit"]');
      const style = document.createElement('style');
      style.setAttribute('data-skin-css', 'orbit'); style.textContent = await (await fetch(link.href)).text();
      link.replaceWith(style);
      Skins.apply('classic'); Skins.apply('orbit');
    });
    check(await page.locator('.orbit-queue').isVisible(), 'DBX inline stylesheet carrier enables the same layout');
    check(errors.length === 0, 'no browser exceptions: ' + errors.join('; '));
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ source, checks, errors, recovery, themes }, null, 2));
    console.log(JSON.stringify({ checks, source, output }));
  } catch (error) {
    if (page) await page.screenshot({ path:path.join(output, 'failure.png') });
    throw error;
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
