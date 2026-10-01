'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.join(__dirname, '..');
const web = path.join(root, 'crates/vmusicd/web');
const output = path.join(root, 'output/playwright/stage-visual');
const base = process.env.STAGE_VISUAL_URL || 'http://127.0.0.1:18774';
let token;
const checks = [];
function pass(label) { checks.push(label); console.log('PASS ' + label); }
async function api(method, endpoint, body, type = 'application/json') {
  const response = await fetch(base + endpoint, { method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': type },
    body: body == null ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  assert.ok(response.ok, `${method} ${endpoint}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function until(read, accepts, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (accepts(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
}
// 球面是否真的画出来：preserveDrawingBuffer=false，只能在 rAF 内合成清屏前
// readPixels；减少动效 15fps 并非每个 rAF 都渲染，跨 12 帧取最大亮度。
function sphereLuma(page) {
  return page.evaluate(() => new Promise(resolve => {
    const gl = document.querySelector('#stage3d canvas').getContext('webgl2');
    if (!gl) { resolve({ avg: 0, litRatio: 0, gl: false }); return; }
    let best = { avg: 0, litRatio: 0 };
    let left = 12;
    (function sample() {
      requestAnimationFrame(() => {
        const size = 200;
        const px = new Uint8Array(size * size * 4);
        gl.readPixels(Math.floor(gl.drawingBufferWidth / 2) - size / 2,
          Math.floor(gl.drawingBufferHeight / 2) - size / 2, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let sum = 0, lit = 0;
        const n = size * size;
        for (let i = 0; i < px.length; i += 4) {
          const luma = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
          sum += luma;
          if (luma > 24) lit += 1;
        }
        if (sum / n > best.avg) best = { avg: sum / n, litRatio: lit / n };
        left -= 1;
        if (left > 0) sample();
        else resolve({ ...best, gl: true });
      });
    })();
  }));
}
async function fixture() {
  const folder = path.join(root, 'output/stage-visual/fixtures');
  fs.mkdirSync(folder, { recursive: true });
  const samples = 8000 * 40;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  fs.writeFileSync(path.join(folder, 'Stage Visual Fixture.wav'), wav);
  fs.writeFileSync(path.join(folder, 'Stage Visual Fixture.lrc'),
    '[00:00.00]晚风吹过你的眼睛\n[00:05.00]星光落在你我之间\n[00:10.00]让每一颗星都有颜色\n[00:16.00]听见远方温柔的回声\n[00:22.00]在夜色里与你相遇\n[00:30.00]直到黎明映亮天际\n');
  await api('POST', '/v1/library/scan', { root: folder });
  const data = await until(() => api('GET', '/v1/tracks?limit=200'),
    value => value.tracks.some(track => track.title === 'Stage Visual Fixture'), 'fixture scan');
  return data.tracks.find(track => track.title === 'Stage Visual Fixture');
}
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const health = await fetch(base + '/v1/health').then(response => response.json());
  assert.equal(health.backend, 'null', 'Use an isolated null backend, never your listening instance');
  const html = await fetch(base).then(response => response.text());
  token = /window\.__VMUSIC_TOKEN__\s*=\s*"([^"]+)"/.exec(html)?.[1];
  assert.ok(token);
  for (const file of ['stage3d.js', 'app.js', 'stanza/stanza.css', 'stanza/stanza-theme.js', 'stanza/stanza-sonnet.js']) {
    const embedded = await fetch(base + '/' + file).then(response => response.text());
    assert.ok(embedded.replace(/\r\n/g, '\n') === fs.readFileSync(path.join(web, file), 'utf8').replace(/\r\n/g, '\n'), 'Rebuild stale embedded resource: ' + file);
  }
  const track = await fixture();
  await api('PUT', '/v1/settings', { cover_follow: false, reduce_motion: false });
  const browser = await chromium.launch({ channel: 'chrome', headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(base);
    await page.waitForFunction(() => window.Stage3D && document.getElementById('settings-entry').onclick);
    await page.waitForFunction(() => document.getElementById('conn').textContent === '服务已连接');
    const cover = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
      const context = canvas.getContext('2d');
      context.fillStyle = '#143b55'; context.fillRect(0, 0, 1024, 1024);
      const gradient = context.createLinearGradient(0, 0, 1024, 1024);
      gradient.addColorStop(0, '#2d72bb'); gradient.addColorStop(0.5, '#5ec9b4'); gradient.addColorStop(1, '#efb77d');
      context.fillStyle = gradient; context.fillRect(64, 64, 896, 896);
      context.fillStyle = '#f0c877'; context.beginPath(); context.arc(660, 335, 148, 0, Math.PI * 2); context.fill();
      context.fillStyle = '#244d61'; context.beginPath(); context.moveTo(64, 650); context.lineTo(350, 300); context.lineTo(600, 660); context.lineTo(960, 435); context.lineTo(960, 960); context.lineTo(64, 960); context.fill();
      context.fillStyle = '#fbf4db'; context.font = 'bold 100px Georgia'; context.fillText('ORBIT', 330, 770);
      context.font = '28px sans-serif'; context.fillText('COLOUR / SOUND / MEMORY', 290, 825);
      for (let index = 0; index < 7; index++) { context.fillStyle = index % 2 ? '#d26556' : '#f5edcc'; context.fillRect(230 + index * 80, 868, 54, 8); }
      return canvas.toDataURL('image/png').split(',')[1];
    });
    fs.writeFileSync(path.join(output, 'cover-original.png'), Buffer.from(cover, 'base64'));
    await api('POST', `/v1/tracks/${track.id}/cover`, Buffer.from(cover, 'base64'), 'image/png');
    await page.reload();
    await page.waitForFunction(() => window.Stage3D && document.getElementById('settings-entry').onclick);
    await api('POST', '/v1/player/load', { track_id: track.id, queue: [track.id] });
    await api('POST', '/v1/player/pause');
    await api('POST', '/v1/player/seek', { position_ms: 12500 });
    await page.waitForFunction(id => Stage.presentation().track?.id === id && Stage.coverUrl() && Stage.lyrics()?.lines?.length >= 6, track.id);
    await page.evaluate(() => { Theme.apply('mono'); Stage3D.configure({ scene: 'silk', stanzaVisual: 'stage', stanzaBg: 'stage', motion: 0, cruise: false, lyrics: false, shelfMode: 'off' }); Stage3D.open('silk'); });
    await page.waitForFunction(() => Stage3D.stats().buffer !== '0x0');
    await page.waitForTimeout(900);
    assert.equal(await page.locator('#s3d-fallback').isVisible(), false);
    await page.screenshot({ path: path.join(output, 'sphere-desktop.png') });
    pass('sphere renders a detailed cover without WebGL fallback');
    await page.mouse.move(620, 440); await page.mouse.down(); await page.mouse.move(750, 465, { steps: 10 }); await page.mouse.up();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(output, 'sphere-rotated.png') });
    pass('sphere remains rendered while camera rotates');
    const homepage = await page.evaluate(() => JSON.stringify(ThemeStudio.state));
    await page.evaluate(() => Stage3D.configure({ stanzaVisual: 'sonnet', lyrics: true, stanzaBg: 'atmosphere', stanzaSubtitle: false, sonnetTuning: { shotFlow: 'quiet-tableau', lyricLayout: 'lines', phraseLength: 12, decor: true, accents: true } }));
    await page.waitForFunction(() => document.querySelector('#s3d-fl-sonnet-stage canvas'));
    await page.waitForTimeout(800);
    const palette = await page.evaluate(() => StanzaTheme.resolveSonnet(1));
    assert.notEqual(palette.accentColor, palette.primaryColor);
    assert.notEqual(palette.secondaryColor, palette.accentColor);
    await page.screenshot({ path: path.join(output, 'sonnet-atmosphere.png') });
    pass('neutral UI theme still gives sonnet a coloured palette');
    await page.mouse.move(900, 120);
    await page.locator('#s3d-settings-toggle').click();
    await page.locator('#s3d-fl-bg-mode').selectOption('anime');
    const chosen = page.locator('#s3d-fl-wallpaper-grid button[data-wallpaper="morning-09.jpg"]');
    await chosen.click();
    await page.waitForFunction(() => document.getElementById('s3d-fl-backdrop').dataset.image === 'ready');
    await page.locator('#s3d-fl-wallpaper-dim').evaluate(element => { element.value = '0.4'; element.dispatchEvent(new Event('input')); element.dispatchEvent(new Event('change')); });
    await until(() => api('GET', '/v1/settings'), value => value.stage3d?.stanzaWallpaper === 'morning-09.jpg' && value.stage3d.stanzaWallpaperDim === 0.4, 'wallpaper save');
    assert.equal(await page.evaluate(() => JSON.stringify(ThemeStudio.state)), homepage);
    await page.screenshot({ path: path.join(output, 'sonnet-settings.png') });
    await page.locator('#s3d-settings-close').click();
    await page.screenshot({ path: path.join(output, 'sonnet-anime.png') });
    pass('wallpaper and dimming save independently of homepage');
    await page.reload();
    await page.waitForFunction(() => Stage3D.preferences().stanzaWallpaper === 'morning-09.jpg' && Stage3D.preferences().stanzaBg === 'anime');
    await page.evaluate(() => Stage3D.open());
    await page.waitForFunction(() => document.getElementById('s3d-fl-wallpaper').naturalWidth > 0 && document.querySelector('#s3d-fl-sonnet-stage canvas'));
    assert.equal(await page.evaluate(() => Stage3D.preferences().stanzaWallpaperDim), 0.4);
    pass('background preferences survive a real page reload');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(output, 'sonnet-mobile.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    pass('mobile reduced-motion sonnet remains within viewport');
    await page.route('**/wallpapers/evening-16.jpg', route => route.fulfill({ status: 404, body: '' }));
    await page.evaluate(() => Stage3D.configure({ stanzaWallpaper: 'evening-16.jpg' }));
    await page.waitForFunction(() => document.getElementById('s3d-fl-backdrop').dataset.image === 'error');
    assert.equal(await page.locator('#s3d-fl-wallpaper').isVisible(), false);
    pass('failed image falls back to atmosphere without broken image icon');
    await page.evaluate(() => Stage3D.configure({ stanzaVisual: 'stage', stanzaBg: 'anime', lyrics: false }));
    assert.equal(await page.locator('#s3d-fl-backdrop').isVisible(), false);
    assert.equal(await page.evaluate(() => document.getElementById('stage3d').classList.contains('s3d-scene-covered')), false);
    // 减少动效下 15fps：configure 后立刻截图会抢在恢复后首帧之前拍到黑画布。
    const luma = await sphereLuma(page);
    assert.ok(luma.gl && luma.litRatio > 0.2, 'sphere pixels after returning to 3D: ' + JSON.stringify(luma));
    await page.screenshot({ path: path.join(output, 'sphere-mobile.png') });
    pass('returning to 3D restores the sphere and its input surface');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, palette, errors }, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    await api('POST', '/v1/player/stop').catch(() => {});
    await browser.close();
  }
  console.log('Stage visual browser checks passed: ' + checks.length);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
