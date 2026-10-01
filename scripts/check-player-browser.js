'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const web = path.join(root, 'crates/vmusicd/web');
const output = path.join(root, 'output/playwright/player');
const base = process.env.PLAYER_UI_URL || 'http://127.0.0.1:18774';
const suites = (process.env.PLAYER_CHECKS || 'skins,playback,lists,appearance').split(',');
let token;
let checks = 0;

function check(value, message) {
  assert.ok(value, message);
  checks += 1;
  console.log('PASS ' + message);
}

async function api(method, endpoint, body, contentType = 'application/json') {
  const response = await fetch(base + endpoint, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': contentType },
    body: body == null ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  assert.ok(response.ok, `${method} ${endpoint}: ${response.status} ${response.ok ? '' : await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function until(read, predicate, message, timeout = 10000) {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(message + ': ' + JSON.stringify(value));
}

async function fixtures() {
  const folder = path.join(root, 'output/skin-playback/fixtures');
  fs.mkdirSync(folder, { recursive: true });
  const samples = 8000 * 30;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < 24; index += 1) {
    fs.writeFileSync(path.join(folder, `Audit ${String(index + 1).padStart(2, '0')}.wav`), wav);
  }
  fs.writeFileSync(path.join(folder, 'Audit 01.lrc'), '[00:00.00]开始播放\n[00:05.00]滚动与歌词同步\n[00:10.00]暂停后继续\n[00:20.00]最后一行\n');
  await api('POST', '/v1/library/scan', { root: folder });
  return until(() => api('GET', '/v1/tracks?limit=200'), data => data.tracks?.length >= 24,
    'fixture scan did not finish');
}

async function routeAssets(page) {
  await page.route('**/v1/online/account?**', route => route.fulfill({ json: { logged_in: false } }));
  await page.route('**/v1/recommend/daily/online?**', route => route.fulfill({ json: { tracks: [], sources: [] } }));
  await page.addInitScript(() => {
    window.__auditMedia = {};
    if ('mediaSession' in navigator) {
      const original = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
      navigator.mediaSession.setActionHandler = (action, handler) => {
        window.__auditMedia[action] = handler;
        return original(action, handler);
      };
    }
  });
}

async function ready(page) {
  await page.goto(base);
  try {
    await page.waitForFunction(() => window.Stage && window.Skins && document.getElementById('settings-entry').onclick, null, { timeout: 10000, polling: 100 });
    await page.waitForFunction(() => document.getElementById('conn').textContent === '服务已连接', null, { timeout: 10000, polling: 100 });
  } catch (error) {
    console.error(await page.evaluate(() => ({ stage: !!window.Stage, skins: !!window.Skins,
      settings: !!document.getElementById('settings-entry')?.onclick,
      connection: document.getElementById('conn')?.textContent, url: location.href,
      scripts: [...document.scripts].map(script => script.src).filter(Boolean) })));
    throw error;
  }
}

async function scrollSurface(page, selector, message) {
  const surface = page.locator(selector);
  await surface.evaluate(element => { element.scrollTop = 0; });
  const box = await surface.boundingBox();
  assert.ok(box && box.height > 60, message + ' has a visible scroll area');
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 180));
  await page.mouse.wheel(0, 780);
  await until(() => surface.evaluate(element => element.scrollTop), value => value > 20, message);
  check(true, message);
  await surface.evaluate(element => { element.scrollTop = 0; });
}

async function skins(page) {
  for (const skin of ['classic', 'sheen', 'workbench', 'liunian']) {
    for (const [width, height] of [[1440, 900], [1024, 700], [390, 844], [320, 640]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(value => Skins.apply(value), skin);
      await page.locator('#settings-entry').click();
      const label = `${skin} ${width}x${height}`;
      const owner = await page.locator('#view-settings').evaluate(element => {
        for (let node = element; node; node = node.parentElement) {
          if (/auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 5) {
            return '#' + node.id;
          }
        }
        return null;
      });
      assert.ok(owner, label + ' has no settings scroll owner');
      await scrollSurface(page, owner, label + ' settings wheel scroll');
      const layout = await page.evaluate(() => {
        const viewport = window.innerWidth;
        const column = document.getElementById('column').getBoundingClientRect();
        const entry = document.getElementById('settings-entry').getBoundingClientRect();
        return { viewport, column: { left: column.left, right: column.right, width: column.width },
          entry: { left: entry.left, right: entry.right }, width: document.documentElement.scrollWidth };
      });
      check(layout.column.width >= width * 0.5 && layout.column.right <= width + 1
        && layout.entry.left >= 0 && layout.entry.right <= width + 1 && layout.width <= width + 1,
      label + ' content width and settings access ' + JSON.stringify(layout));
      await page.screenshot({ path: path.join(output, `${skin}-${width}.png`) });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => Skins.apply('classic'));
  await page.locator('#settings-entry').click();
  const settings = page.locator('#view-settings');
  const box = await settings.boundingBox();
  await page.mouse.move(box.x + box.width - 8, box.y + 24);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 8, box.y + 250, { steps: 12 });
  await page.mouse.up();
  check(await settings.evaluate(element => element.scrollTop > 100), 'settings native scrollbar thumb drag');
}

async function playback(page, tracks) {
  const queue = tracks.slice(0, 4).map(track => track.id);
  await api('POST', '/v1/player/load', { track_id: queue[0], queue });
  await page.waitForFunction(id => Stage.presentation().track?.id === id, queue[0]);
  await page.locator('#playpause').click();
  await until(() => api('GET', '/v1/state'), value => !value.playing, 'pause');
  const paused = await api('GET', '/v1/state');
  await new Promise(resolve => setTimeout(resolve, 180));
  const still = await api('GET', '/v1/state');
  check(Math.abs(still.position_ms - paused.position_ms) < 40, 'pause holds playback position');
  await page.locator('#playpause').click();
  await until(() => api('GET', '/v1/state'), value => value.playing, 'play');
  await page.locator('#playpause').click();
  await until(() => api('GET', '/v1/state'), value => !value.playing, 'pause before seek');
  await page.locator('#progress').focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await until(() => api('GET', '/v1/state'), value => value.position_ms > 0, 'keyboard seek');
  check(true, 'keyboard progress seeks server playback');
  const range = page.locator('#progress');
  const box = await range.boundingBox();
  await page.mouse.click(box.x + box.width * 0.65, box.y + box.height / 2);
  const sought = await until(() => api('GET', '/v1/state'), value => value.position_ms > 15000, 'pointer seek');
  check(Math.abs(sought.position_ms - 19500) < 1600, 'pointer seek matches track position');
  await page.evaluate(() => document.getElementById('progress').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  await page.evaluate(() => document.getElementById('progress').dispatchEvent(new PointerEvent('pointercancel', { bubbles: true })));
  await api('POST', '/v1/player/seek', { position_ms: 4000 });
  await page.waitForFunction(() => Math.abs(Number(document.getElementById('progress').value) - 133) < 4);
  check(true, 'cancelled progress drag resumes snapshot updates');

  await page.locator('#bar-track').click();
  await page.locator('#np-progress-bar').evaluate(element => {
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    element.value = '800';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise(resolve => setTimeout(resolve, 450));
  check(await page.locator('#np-progress-bar').inputValue() === '800', 'popup drag preview survives server snapshots');
  await page.locator('#np-progress-bar').dispatchEvent('change');
  await until(() => api('GET', '/v1/state'), value => Math.abs(value.position_ms - 24000) < 80, 'popup seek');
  await page.locator('#np-close').click();

  await api('POST', '/v1/player/volume', { volume: 0.37 });
  await page.waitForFunction(() => document.getElementById('volume').value === '37');
  check(true, 'volume slider follows server or second-client changes');
  await page.locator('#volume').evaluate(element => {
    for (const value of [15, 70, 21, 62]) {
      element.value = String(value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await until(() => api('GET', '/v1/state'), value => Math.abs(value.volume - 0.62) < 0.005, 'coalesced volume');
  check(await page.locator('#np-volume').inputValue() === '62', 'rapid volume input keeps final value across controls');
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('m');
  await until(() => api('GET', '/v1/state'), value => value.volume === 0, 'mute');
  await page.keyboard.press('m');
  await until(() => api('GET', '/v1/state'), value => Math.abs(value.volume - 0.62) < 0.005, 'unmute');
  check(true, 'unmute restores chosen volume');

  await page.locator('#next').click();
  await until(() => api('GET', '/v1/state'), value => value.track_id === queue[1], 'next');
  await page.locator('#prev').click();
  await until(() => api('GET', '/v1/state'), value => value.track_id === queue[0], 'previous');
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Shift+ArrowRight');
  await until(() => api('GET', '/v1/state'), value => value.track_id === queue[1], 'keyboard next');
  check(true, 'next, previous and Shift+ArrowRight use the same queue');
  await page.locator('#stop').click();
  await until(() => api('GET', '/v1/state'), value => !value.playing && value.position_ms === 0, 'stop');
  check(await page.evaluate(() => navigator.mediaSession.playbackState === 'none'), 'stop clears media session playing state');
  await page.locator('#playpause').click();
  await until(() => api('GET', '/v1/state'), value => value.playing && value.position_ms < 2000, 'restart');
  check(true, 'play after stop restarts at the beginning');

  const actions = await page.evaluate(() => Object.keys(window.__auditMedia));
  check(['play', 'pause', 'stop', 'seekto', 'seekforward', 'seekbackward', 'nexttrack', 'previoustrack']
    .every(action => actions.includes(action)), 'all system media actions registered');
  await page.evaluate(() => window.__auditMedia.pause({}));
  await until(() => api('GET', '/v1/state'), value => !value.playing, 'media pause');
  await page.evaluate(() => window.__auditMedia.seekto({ seekTime: 12 }));
  await until(() => api('GET', '/v1/state'), value => value.position_ms === 12000, 'media seekto');
  check(true, 'system media seekto synchronizes server position');
  await page.evaluate(() => window.__auditMedia.play({}));
  await until(() => api('GET', '/v1/state'), value => value.playing, 'media play');
  const backgroundStart = await api('GET', '/v1/state');
  await page.goto('about:blank');
  await new Promise(resolve => setTimeout(resolve, 650));
  const backgroundEnd = await api('GET', '/v1/state');
  check(backgroundEnd.playing && backgroundEnd.position_ms > backgroundStart.position_ms + 400,
    'server playback continues after the player page leaves');
  await ready(page);
  await page.waitForFunction(id => Stage.presentation().track?.id === id, backgroundEnd.track_id);
  check(true, 'reopening page restores current track and queue');
  await api('POST', '/v1/player/pause');
}

async function listScrolling(page, tracks) {
  const queue = tracks.map(track => track.id);
  await api('POST', '/v1/player/load', { track_id: queue[0], queue });
  await api('POST', '/v1/player/pause');
  for (const track of tracks) {
    await api('POST', '/v1/favorites', { kind: 'track', source: 'local', ref_id: track.id });
  }
  const playlist = await api('POST', '/v1/playlists', { name: 'Skin scroll audit' });
  await api('POST', `/v1/playlists/${playlist.id}/tracks`, { track_ids: queue });
  await ready(page);
  for (const skin of ['classic', 'sheen', 'workbench', 'liunian']) {
    await page.setViewportSize({ width: 1024, height: 700 });
    await page.evaluate(value => Skins.apply(value), skin);
    for (const [view, selector] of [['library', '#lib-list'], ['queue', '#queue-list'], ['favorites', '#fav-list']]) {
      await page.locator(`.rail-item[data-view="${view}"]:visible, [data-ln-view="${view}"]:visible`).click();
      await page.waitForFunction(selector => document.querySelector(selector).children.length >= 24, selector);
      const owner = await page.locator(selector).evaluate(element => {
        for (let node = element; node; node = node.parentElement) {
          if (/auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 5) return '#' + node.id;
        }
        return null;
      });
      assert.ok(owner, `${skin} ${view} must have a scroll owner`);
      await scrollSurface(page, owner, `${skin} ${view} wheel scroll`);
    }
  }
  await page.locator('.rail-item[data-view="playlists"]:visible, [data-ln-view="playlists"]:visible').click();
  await page.locator('[data-pl-view="list"]').click();
  await page.locator('.pl-row').filter({ hasText: 'Skin scroll audit' }).last().click();
  await page.waitForFunction(() => document.getElementById('pl-detail-list').children.length >= 24);
  const detailOwner = await page.locator('#pl-detail-list').evaluate(element => {
    for (let node = element; node; node = node.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 5) return '#' + node.id;
    }
    return null;
  });
  assert.ok(detailOwner, 'playlist detail must have a scroll owner');
  await scrollSurface(page, detailOwner, 'playlist detail wheel scroll');
  await page.locator('#pl-detail-play').click();
  await until(() => api('GET', '/v1/state'), value => value.playing, 'playlist playback');
  check(true, 'playlist play switches to selected playlist');
  await api('POST', '/v1/player/pause');
  await api('DELETE', `/v1/playlists/${playlist.id}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => Skins.apply('classic'));
}

async function appearance(page, tracks) {
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const context = canvas.getContext('2d');
    context.fillStyle = '#d84d3f'; context.fillRect(0, 0, 32, 32);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await api('POST', `/v1/tracks/${tracks[0].id}/cover`, Buffer.from(image, 'base64'), 'image/png');
  await api('POST', '/v1/player/load', { track_id: tracks[0].id, queue: tracks.slice(0, 4).map(track => track.id) });
  await ready(page);
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--music-highlight'));
  await page.locator('#settings-entry').click();
  await page.locator('#set-cover-follow').uncheck();
  await until(() => api('GET', '/v1/settings'), value => value.cover_follow === false, 'cover preference saved');
  check(await page.evaluate(() => !document.documentElement.style.getPropertyValue('--music-highlight')
    && !document.getElementById('ambient').classList.contains('has-art')
    && document.getElementById('cover').style.backgroundImage !== 'none'), 'cover follow off restores theme and preserves album art');
  await ready(page);
  await page.waitForFunction(() => !document.getElementById('set-cover-follow').checked);
  check(await page.evaluate(() => !document.documentElement.style.getPropertyValue('--music-highlight')
    && !document.getElementById('ambient').classList.contains('has-art')), 'cover follow preference survives refresh');
  await page.locator('#settings-entry').click();
  await page.locator('#set-cover-follow').check();
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--music-highlight'));
  check(true, 'cover follow re-enables without changing track');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => Stage.presentation().reduced);
  check(true, 'system reduced-motion preference takes effect while running');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const health = await fetch(base + '/v1/health').then(response => response.json());
  assert.equal(health.backend, 'null', 'Use an isolated VMUSIC_BACKEND=null service for this check');
  for (const file of ['app.js', 'stage.js', 'style.css', ...['sheen', 'workbench', 'liunian'].map(skin => `skins/skin.${skin}.css`)]) {
    const response = await fetch(new URL(file, base));
    assert.ok(response.ok, `Cannot fetch ${file}`);
    assert.ok((await response.text()).replace(/\r\n/g, '\n') === fs.readFileSync(path.join(web, file), 'utf8').replace(/\r\n/g, '\n'),
      `Stale embedded asset ${file}; rebuild the isolated service`);
  }
  const html = await fetch(base + '/').then(response => response.text());
  token = /window\.__VMUSIC_TOKEN__\s*=\s*"([^"]+)"/.exec(html)?.[1];
  assert.ok(token, 'isolated service did not inject a token');
  const tracks = (await fixtures()).tracks;
  await api('PUT', '/v1/settings', { cover_follow: true, stage_idle_hide: true, reduce_motion: false });
  await api('POST', '/v1/player/stop');
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true,
    ignoreDefaultArgs: ['--hide-scrollbars'] });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', error => { errors.push(error.message); console.error('Browser error: ' + error.stack); });
    page.on('websocket', socket => socket.on('socketerror', error => console.error('WebSocket: ' + String(error).replaceAll(token, '[token]'))));
    await routeAssets(page);
    await ready(page);
    if (suites.includes('skins')) await skins(page);
    if (suites.includes('playback')) await playback(page, tracks);
    if (suites.includes('lists')) await listScrolling(page, tracks);
    if (suites.includes('appearance')) await appearance(page, tracks);
    check(errors.length === 0, 'no uncaught browser exceptions: ' + errors.join('; '));
    console.log(`Player browser checks passed: ${checks}; suites=${suites.join(',')}; assets=embedded`);
  } finally {
    await api('POST', '/v1/player/stop').catch(() => {});
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
