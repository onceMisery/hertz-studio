'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { uiUrl } = require('./ui-token');
const root = path.resolve(__dirname, '..');
const base = process.env.PLAYER_UI_URL || 'http://127.0.0.1:18795';
const output = path.join(root, 'output/playwright/now-playing');
const token = require('./ui-token').uiToken();
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; console.log('PASS ' + message); }
async function api(method, endpoint, body, contentType = 'application/json') {
  const response = await fetch(base + endpoint, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': contentType }, body: body == null ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  assert.ok(response.ok, `${method} ${endpoint}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function until(read, test) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = await read(); if (test(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Timed out waiting for player state; last value: ' + JSON.stringify(await read()));
}
async function fixtures() {
  const dir = path.join(root, 'output/playwright/now-playing-fixtures'); fs.mkdirSync(dir, { recursive: true });
  const samples = 8000 * 180, wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 1; i <= 8; i++) fs.writeFileSync(path.join(dir, `Player ${i}.wav`), wav);
  fs.writeFileSync(path.join(dir, 'Player 1.lrc'), '[00:00.00]开始聆听\n[00:05.00]音乐与文字在这里相遇\n[00:20.00]最大化仍是当前这首音乐\n[00:40.00]回到原来的列表\n');
  await api('POST', '/v1/library/scan', { root: dir });
  const tracks = (await until(() => api('GET', '/v1/tracks?limit=200'), data => data.tracks?.filter(track => track.path.startsWith(dir)).length >= 8)).tracks
    .filter(track => track.path.startsWith(dir)).sort((a, b) => a.title.localeCompare(b.title));
  await api('POST', `/v1/tracks/${tracks[0].id}/cover`, fs.readFileSync(path.join(root, 'plugin/ui/wallpapers/celestial-sky.jpg')), 'image/jpeg');
  return tracks;
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: process.env.PLAYER_SOURCE_ASSETS === '1' ? ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] : [] });
  try {
    fs.mkdirSync(output, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error('Browser: ' + error.stack); });
    page.on('console', message => { if (message.type() === 'error' && message.text().includes('[hertz]')) console.error(message.text()); });
    await page.addInitScript(() => localStorage.setItem('vmusic.defaultView', 'library'));
    await page.route('**/v1/online/account?**', route => route.fulfill({ json: { logged_in: false } }));
    await page.route('**/v1/recommend/daily/online?**', route => route.fulfill({ json: { tracks: [], sources: [] } }));
    // Use real API/WS, but the current source assets during the RED/GREEN loop.
    if (process.env.PLAYER_SOURCE_ASSETS === '1') await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      const file = path.join(root, 'plugin/ui', decodeURIComponent(url.pathname));
      if (url.pathname !== '/' && !url.pathname.startsWith('/v1/') && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return route.fulfill({ path: file });
      }
      if (url.pathname === '/') {
        const token = require('./ui-token').uiToken();
        const response = await route.fetch();
        return route.fulfill({ response, contentType: 'text/html', body: fs.readFileSync(path.join(root, 'plugin/ui/index.html'), 'utf8').replaceAll('__VMUSIC_TOKEN_VALUE__', token) });
      }
      return route.continue();
    });
    await page.goto(uiUrl(base));
    await page.waitForFunction(() => window.Skins && document.getElementById('bar-track').onclick);
    try { await page.waitForFunction(() => document.getElementById('conn').textContent === '服务已连接', null, { timeout: 20000 }); }
    catch(error) { console.error(await page.evaluate(() => ({connection:document.getElementById('conn').textContent,boot:document.querySelector('.boot-failed-card')?.textContent}))); throw error; }
    await page.evaluate(() => Skins.apply('classic'));
    await page.locator('#bar-track').click();
    const layout = await page.locator('#np-modal .np-card').boundingBox();
    assert.ok(layout.width >= 1366 - 2 && layout.height >= 768 - 2,
      `ordinary player must fill viewport; actual ${JSON.stringify(layout)}`);
    assert.equal(await page.evaluate(() => document.body.classList.contains('s3d-open')), false, 'opening player does not open stage');
    await page.locator('#np-close').click();
    assert.equal(await page.locator('#np-modal').isVisible(), false, 'collapse returns to browsing');
    check(true, 'ordinary player opens full viewport and returns without entering stage');
    const tracks = await fixtures(), queue = tracks.map(t => t.id);
    await api('POST', '/v1/player/load', { track_id: queue[0], queue });
    await api('POST', '/v1/player/pause');
    await page.reload();
    await page.waitForFunction(() => window.NowPlaying && document.getElementById('bar-track').onclick && document.getElementById('conn').textContent === '服务已连接');
    await page.evaluate(() => restoreQueue());
    await until(() => page.evaluate(() => Stage.presentation().playing), playing => !playing);
    await until(() => page.evaluate(() => Stage.presentation().track?.id), id => id === queue[0]);
    await page.setViewportSize({width:1366,height:768});
    const centered = await page.locator('#playpause').boundingBox();
    check(Math.abs(centered.x + centered.width / 2 - 683) < 2, 'classic bottom transport is centered');
    await page.locator('#bar-track').click();
    await page.locator('#np-playpause').click();
    await until(() => api('GET', '/v1/state'), state => state.playing);
    await page.locator('#np-playpause').click();
    await until(() => api('GET', '/v1/state'), state => !state.playing);
    check(true, 'ordinary transport controls the existing backend');
    await page.locator('#np-volume').fill('43');
    await until(() => api('GET', '/v1/state'), state => Math.abs(state.volume - .43) < .005);
    await page.locator('#np-mute').click(); await until(() => api('GET', '/v1/state'), state => state.volume === 0);
    await page.locator('#np-mute').click(); await until(() => api('GET', '/v1/state'), state => Math.abs(state.volume - .43) < .005);
    check(true, 'volume and mute use the existing synchronized setting');
    await page.locator('#np-progress-bar').fill('200');
    await page.locator('#np-progress-bar').dispatchEvent('change');
    await until(() => api('GET', '/v1/state'), state => Math.abs(state.position_ms - 36000) < 200);
    check(true, 'ordinary seek updates the real playback position');
    await api('PUT', `/v1/tracks/${queue[0]}/lyrics/offset`, { offset_ms: 500 });
    await page.locator('#np-close').click();
    await page.locator('#bar-track').click();
    await page.waitForFunction(() => document.querySelectorAll('.np-line').length === 4);
    await api('POST', '/v1/player/seek', { position_ms: 5750 });
    await until(() => page.locator('.np-line.is-active').getAttribute('data-index'), index => index === '1');
    check(true, 'lyric timing uses the producer offset exactly once');
    await page.locator('#np-lyric-scroll').hover(); await page.mouse.wheel(0, 180);
    await page.waitForTimeout(180);
    const browsed = await page.locator('#np-lyric-scroll').evaluate(el => el.scrollTop);
    await api('POST', '/v1/player/seek', { position_ms: 21000 });
    await until(() => page.locator('.np-line.is-active').getAttribute('data-index'), index => index === '2');
    check(await page.locator('#np-follow').isVisible() && Math.abs(await page.locator('#np-lyric-scroll').evaluate(el => el.scrollTop) - browsed) < 2, 'manual lyric browsing survives line changes');
    await page.locator('#np-follow').click();
    const anchored = await page.evaluate(() => {
      const row = document.querySelector('.np-line.is-active').getBoundingClientRect();
      const scroll = document.getElementById('np-lyric-scroll').getBoundingClientRect();
      return Math.abs((row.top + row.height / 2 - scroll.top) / scroll.height - .45) < .03;
    });
    check(anchored, 'return to current lyric anchors the actual row');
    await page.locator('.np-line[data-index="1"]').click();
    await until(() => api('GET', '/v1/state'), state => state.position_ms === 5500);
    check(true, 'clicking lyric seeks the calibrated timestamp');
    await page.locator('#np-queue').click();
    check(await page.locator('.np-queue-row').count() === 8 && !await page.locator('#np-reading').isVisible(), 'queue replaces lyrics, uses existing queue');
    await page.locator('.np-queue-row[data-index="1"]').click();
    await until(() => api('GET', '/v1/state'), state => state.track_id === queue[1]);
    await page.keyboard.press('Escape');
    check(await page.locator('#np-modal').isVisible() && !await page.locator('#np-queue-pane').isVisible(), 'Escape consumes only the queue layer');
    await page.locator('#np-more').click(); await page.locator('#np-eq').click();
    check(await page.locator('#np-eq-pane #dsp-save').isVisible(), 'existing equalizer controls are usable in player');
    await page.keyboard.press('Escape');
    check(await page.locator('#np-modal').isVisible() && await page.locator('#np-eq-pane .set-group').count() === 0, 'tools close and equalizer nodes return');
    await page.locator('#np-fullscreen').click();
    await page.waitForFunction(() => document.fullscreenElement?.id === 'np-modal');
    await page.locator('#np-more').click(); await page.locator('#np-sleep').click();
    check(await page.locator('#ctx-menu').isVisible() && await page.evaluate(() => document.fullscreenElement.contains(document.getElementById('ctx-menu'))), 'sleep menu is available inside fullscreen player');
    await page.keyboard.press('Tab');
    check(await page.evaluate(() => document.getElementById('ctx-menu').contains(document.activeElement)), 'sleep options are reachable by keyboard');
    await page.keyboard.press('Escape');
    check(await page.locator('#np-tools').isVisible() && !await page.locator('#ctx-menu').isVisible(), 'Escape closes sleep menu before tools');
    await page.keyboard.press('Escape');
    check(await page.evaluate(() => document.fullscreenElement?.id === 'np-modal') && !await page.locator('#np-tools').isVisible(), 'Escape closes tools before fullscreen');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.fullscreenElement);
    check(await page.locator('#np-modal').isVisible(), 'leaving fullscreen keeps the ordinary player open');
    // Exercise the DBX dialog implementation with the real standalone transport.
    await page.evaluate(source => {
      const host = window.hertzHost;
      window.hertzHost = { isDbx: true };
      (0, eval)(source);
      window.hertzHost = host;
    }, fs.readFileSync(path.join(root, 'plugin/ui/dialogs.js'), 'utf8'));
    await page.locator('#np-fullscreen').click();
    await page.waitForFunction(() => document.fullscreenElement?.id === 'np-modal');
    await page.locator('#np-more').click(); await page.locator('#np-sleep').click();
    await page.locator('#ctx-menu button').filter({hasText:'自定义分钟数'}).click();
    await page.locator('.hz-dialog-input').waitFor();
    check(await page.locator('.hz-dialog-input').evaluate(el => {
      const r = el.getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
    }), 'DBX custom sleep dialog is interactive above fullscreen');
    check((await page.locator('.hz-dialog-input').locator('..').boundingBox()).width <= 432, 'fullscreen custom dialog stays compact');
    await page.keyboard.press('Escape');
    check(await page.locator('#np-tools').isVisible() && await page.evaluate(() => document.fullscreenElement?.id === 'np-modal'), 'custom dialog Escape keeps fullscreen and tools');
    await page.locator('#np-close').click();
    await page.waitForFunction(() => !document.fullscreenElement);
    await page.locator('#bar-track').click();
    await page.locator('#np-more').click(); await page.locator('#np-sleep').click();
    await page.evaluate(() => Skins.apply('classic'));
    check(!await page.locator('#ctx-menu').isVisible() && !await page.locator('#np-modal').isVisible(), 'skin switch dismisses the open sleep menu');
    await page.evaluate(() => Skins.apply('classic'));
    await page.locator('#bar-track').click();
    await page.locator('#np-more').click(); await page.locator('#np-sleep').click();
    await page.locator('#np-close').click();
    check(!await page.locator('#ctx-menu').isVisible(), 'collapse dismisses the owned sleep menu');
    await api('POST', '/v1/player/pause');
    await api('POST', '/v1/player/load', { track_id: queue[0], queue });
    await api('POST', '/v1/player/pause');
    await until(() => page.evaluate(() => Stage.presentation().track?.id), id => id === queue[0]);
    const skins = ['classic', 'sheen', 'chaoxi', 'qingfeng', 'liunian', 'heijiao'];
    const sizes = [[1366,768], [1920,1080], [2560,1080], [1024,600], [390,844]];
    for (const skin of skins) {
      await page.evaluate(skin => Skins.apply(skin), skin);
      await page.setViewportSize({width:1366,height:768});
      await page.waitForTimeout(300);
      check(await page.locator('#bar-player-expand').isVisible(), skin + ' has an explicit ordinary-player entry');
      await page.screenshot({path:path.join(output, `${skin}-browsing.png`)});
      for (const [width,height] of sizes) {
        await page.setViewportSize({width,height});
        const bar = await page.locator('#bar-pin-toggle').boundingBox();
        if (bar) check(bar.x >= 0 && bar.x + bar.width <= width + 1, `${skin} ${width}x${height} browsing bar fits`);
        await page.evaluate(() => document.getElementById('bar-track').click());
        await page.waitForFunction(() => document.getElementById('np-art').classList.contains('has-cover'));
        await page.waitForTimeout(280);
        const geometry = await page.evaluate(() => {
          const ids = ['np-close','np-playpause','np-progress-bar','np-volume','np-name'];
          return ids.map(id => { const r = document.getElementById(id).getBoundingClientRect(); return {id,x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}; });
        });
        check(geometry.every(r => r.w > 0 && r.h > 0 && r.x >= -1 && r.y >= -1 && r.right <= width+1 && r.bottom <= height+1), `${skin} ${width}x${height} controls fit`);
        check(!await page.evaluate(() => document.body.classList.contains('s3d-open')), skin + ' never opens stage');
        if (skin === 'heijiao') {
          const disc = await page.locator('#np-disc-host .disc-wrap').boundingBox();
          check(disc.width > 80 && disc.x - disc.width * .1 >= 0 && disc.x + disc.width * 1.3 <= width,
            `${skin} ${width}x${height} disc and tonearm fit: ${JSON.stringify(disc)}`);
        }
        if (width < 900) {
          await page.locator('#np-tab-lyrics').click();
          check(await page.locator('#np-reading').isVisible() && !await page.locator('#np-cover-pane').isVisible(), skin + ' narrow lyric view');
          await page.locator('#np-tab-cover').click();
        }
        await page.screenshot({path:path.join(output, `${skin}-${width}x${height}.png`)});
        await page.locator('#np-close').click();
      }
      await page.evaluate(() => document.getElementById('bar-track').click());
      await page.evaluate(() => Skins.apply('classic'));
      if (skin !== 'classic') check(!await page.locator('#np-modal').isVisible() && !await page.evaluate(() => document.querySelector('.app').inert), skin + ' switching releases expanded surface and background');
      else await page.locator('#np-close').click();
    }
    await page.setViewportSize({width:1366,height:768});
    await page.evaluate(() => Skins.apply('classic'));
    await page.locator('#bar-track').focus(); await page.keyboard.press('Enter');
    await page.locator('#np-close').focus(); await page.keyboard.press('Shift+Tab');
    check(await page.evaluate(() => document.getElementById('np-modal').contains(document.activeElement)), 'keyboard focus remains inside player');
    await page.keyboard.press('Escape');
    check(await page.locator('#bar-track').evaluate(el => el === document.activeElement), 'collapse restores the keyboard entry focus');
    check(await page.evaluate(() => Stage.gateRates().find(gate => gate.name === 'ordinary-player').target === 0), 'closed player releases its frame budget');

    for (const skin of ['sheen','chaoxi']) {
      await page.evaluate(skin => Skins.apply(skin), skin);
      const handle = page.locator(skin === 'sheen' ? '#sheen-player-handle' : '#chaoxi-stage-handle');
      if (await handle.getAttribute('aria-expanded') !== 'true') await handle.click();
      const preference = await page.evaluate(() => localStorage.getItem('vmusic.chaoxi.stage'));
      await page.locator('#bar-player-expand').click(); await page.locator('#np-close').click();
      check(await handle.getAttribute('aria-expanded') === 'true' && await page.evaluate(() => localStorage.getItem('vmusic.chaoxi.stage')) === preference, skin + ' restores the mini panel preference');
      const panel = await page.locator('#stage').boundingBox();
      check(panel && panel.x >= 0 && panel.y >= 0 && panel.x + panel.width <= 1367, skin + ' mini panel is on screen');
      await handle.click();
      if (skin === 'sheen') check((await page.locator('#column').boundingBox()).width > 1300, 'sheen releases the mini panel space when closed');
    }
    await page.evaluate(() => Skins.apply('liunian'));
    await page.locator('.ln-sp-q').fill('Player');
    const compact = await page.locator('.bar').evaluate(el => el.classList.contains('ln-capsule'));
    await page.locator('#bar-player-expand').click(); await page.locator('#np-close').click();
    check(await page.locator('.ln-sp-q').inputValue() === 'Player' && await page.locator('.bar').evaluate(el => el.classList.contains('ln-capsule')) === compact, 'liunian restores search and player card state');
    await page.evaluate(() => Skins.apply('qingfeng'));
    await page.locator('[data-qf-view="wall"]').click();
    await page.waitForTimeout(600);
    check(await page.locator('.qf-queue-peek-player').count() === 1, 'qingfeng wall has an ordinary-player entry');
    const wallState = await page.locator('.qf-lattice-world').evaluate(el => ({transform:el.style.transform,html:el.innerHTML}));
    await page.locator('.qf-queue-peek-player').click();
    check(!await page.locator('.qf-lattice').isVisible() && await page.locator('.qf-lattice').evaluate(el => el.inert), 'expanded player suspends the covered poster wall');
    await page.locator('#np-close').click();
    check(await page.locator('.qf-lattice').isVisible() && await page.locator('.qf-lattice-world').evaluate((el, state) => el.style.transform === state.transform && el.innerHTML === state.html, wallState), 'qingfeng restores the original poster wall and camera');
    await page.evaluate(() => Skins.apply('classic'));

    for (const theme of ['ios-light','midnight']) {
      await page.evaluate(theme => Theme.apply(theme, {silent:true}), theme);
      for (const [width,height] of [[1093,614],[910,512]]) {
        await page.setViewportSize({width,height});
        const loadedLyrics = page.waitForResponse(response => /\/v1\/tracks\/[^/]+\/lyrics(?:\?|$)/.test(response.url()));
        await page.locator('#bar-track').evaluate(el => el.click());
        await loadedLyrics; await page.waitForTimeout(80);
        await page.evaluate(() => {
          document.getElementById('np-name').textContent = '这是一首有很长很长标题的音乐 / A Very Long Song Title With Multiple Words';
          Stage.setLyrics({lines:[{start_ms:0,end_ms:180000,text:'很长的一句歌词应该自然换行并且完整显示，不会挤压底部播放控制或遮挡歌曲信息。',words:[{text:'很长的一句歌词',start_ms:0,end_ms:10000}]}], translation:['A long translated lyric should wrap naturally and remain readable beside the artwork.']});
        });
        await page.waitForTimeout(280);
        const fit = await page.evaluate(() => {
          const title = document.getElementById('np-name'), line = document.querySelector('.np-line'), translation = document.querySelector('.np-translation');
          const footer = document.querySelector('.np-footer').getBoundingClientRect();
          return title.clientHeight <= parseFloat(getComputedStyle(title).lineHeight) * 2 + 1 && line.scrollWidth <= line.clientWidth && translation.scrollWidth <= translation.clientWidth && footer.bottom <= innerHeight;
        });
        check(fit, `${theme} at ${width}x${height} (125%/150% CSS viewport) long bilingual text fits`);
        await page.screenshot({path:path.join(output, `${theme}-${width}x${height}-long.png`)});
        await page.locator('#np-close').click();
      }
    }
    await page.setViewportSize({width:1366,height:768});
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.evaluate(() => Skins.apply('heijiao'));
    await page.locator('#bar-track').evaluate(el => el.click());
    const disc = page.locator('#np-disc-host .disc-wrap');
    await disc.focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
    check(await disc.evaluate(el => parseFloat(el.style.getPropertyValue('--hj-turn'))) === 10, 'black vinyl keyboard rotation survives relocation');
    const rect = await disc.boundingBox();
    await page.mouse.move(rect.x + rect.width/2, rect.y + rect.height/2); await page.mouse.down();
    await page.mouse.move(rect.x + rect.width/2 + 80, rect.y + rect.height/2, {steps:5}); await page.mouse.up();
    const angle = await disc.evaluate(el => parseFloat(el.style.getPropertyValue('--hj-turn')));
    await page.waitForTimeout(180);
    check(angle >= 49 && angle <= 51 && await disc.evaluate(el => parseFloat(el.style.getPropertyValue('--hj-turn'))) === angle, 'reduced motion retains drag with no inertia');
    check(await page.locator('#np-modal .np-card').evaluate(el => getComputedStyle(el).animationName === 'none'), 'system reduced motion disables page entrance animation');
    await disc.click();
    check(await disc.evaluate(el => el.getBoundingClientRect().width > 80), 'disc click retains local lyric state without shrinking expanded artwork');
    await page.locator('#np-close').click();
    check(await page.locator('#stage .disc-wrap').count() === 1 && await page.locator('#np-disc-host').count() === 0, 'black vinyl restores the original disc node');

    await page.evaluate(() => Skins.apply('classic'));
    await page.evaluate(async () => {
      const original = transport.get, pending = [];
      transport.get = url => /\/lyrics$/.test(url) ? new Promise(resolve => pending.push(resolve)) : original.call(transport, url);
      try {
        const track = state.current;
        const older = refreshLyrics(track.id, track), newer = refreshLyrics(track.id, track);
        pending[1]({lines:[{start_ms:0,text:'newer lyrics'}]}); await newer;
        pending[0]({lines:[{start_ms:0,text:'older lyrics'}]}); await older;
      } finally { transport.get = original; }
    });
    check(await page.evaluate(() => Stage.lyrics().lines[0].text === 'newer lyrics'), 'same-track lyric refresh rejects stale completion');
    const obsoleteDidNotBlock = await page.evaluate(async () => {
      const original = transport.get, pending = [];
      transport.get = url => /\/lyrics$/.test(url) ? new Promise(resolve => pending.push(resolve)) : original.call(transport, url);
      try {
        const track = state.current, current = refreshLyrics(track.id, track);
        const obsolete = refreshLyrics('obsolete-track', track);
        pending[0]({lines:[{start_ms:0,text:'current track lyrics'}]}); await current;
        if (pending[1]) pending[1]({lines:[]}); await obsolete;
        return Stage.lyrics().lines[0].text === 'current track lyrics';
      } finally { transport.get = original; }
    });
    check(obsoleteDidNotBlock, 'obsolete-track refresh cannot invalidate the current lyric request');
    await page.route('**/v1/tracks/*/lyrics', route => route.fulfill({status:503,json:{error:'fixture unavailable'}}));
    await page.evaluate(() => Stage.setLyrics(null));
    await page.locator('#bar-track').click();
    await page.waitForTimeout(350);
    check(await page.locator('#np-empty').textContent() === '歌词加载失败', 'lyric failures are distinct from a track without lyrics');
    await page.locator('#np-close').click();
    await page.unroute('**/v1/tracks/*/lyrics');
    await page.locator('#bar-track').click();
    await page.evaluate(() => syncNpTrack(Stage.presentation().track, '/missing-cover-fixture.jpg'));
    await page.waitForTimeout(150);
    check(await page.locator('#np-art .np-art-note').isVisible() && await page.locator('#np-art').evaluate(el => !el.classList.contains('has-cover')), 'failed cover uses the stable artwork placeholder');
    await page.locator('#np-close').click();
    await page.evaluate(() => { const modal = document.getElementById('remote-browse'); modal.hidden = false; });
    check((await page.locator('#remote-browse .np-card').boundingBox()).width <= 432, 'shared remote dialog keeps its compact geometry');
    await page.evaluate(() => document.getElementById('remote-browse').hidden = true);
    check(errors.length === 0, 'no browser exceptions: ' + errors.join('; '));
    console.log('Ordinary player checks passed: ' + checks);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
