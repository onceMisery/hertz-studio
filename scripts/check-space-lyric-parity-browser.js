// SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), web = path.join(root, 'plugin/ui');
const output = path.join(root, 'output/playwright/space-lyric-parity');
const scripts = ['vendor/stage-runtime.js', 'vendor/space-stage.js', 'space-camera.js', 'stanza/stanza-util.js', 'stanza/stanza-theme.js',
  'stanza/stanza-textlayout.js', 'stanza/stanza-classic.js', 'stanza/stanza-cadenza.js',
  'stanza/stanza-sonnet-fx.js', 'stanza/stanza-sonnet.js', 'stanza/stanza-tempera.js',
  'stanza/stanza-songform.js', 'stage-lyrics.js', 'space3d.js'];

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://lyric-parity.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html',
        body: fs.readFileSync(path.join(web, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '') });
      const file = path.resolve(web, '.' + url.pathname);
      if (!file.startsWith(web + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'image/jpeg', body: fs.readFileSync(file) });
    });
    await page.goto('https://lyric-parity.test/');
    await page.evaluate(() => {
      window.fixture = { position: 1800, playing: true, reduced: false };
      window.lines = [{ text: 'We sing together', start_ms: 0, end_ms: 6000 },
        { text: '\u8ba9\u97f3\u4e50\u5e26\u6211\u4eec\u8d8a\u8fc7\u8fd9\u7247\u6d77\u6d0b', start_ms: 6000, end_ms: 12000 }];
      window.gates = {};
      window.Stage = {
        position: () => fixture.position,
        presentation: () => ({ ...fixture, duration: 12000, volume: .8, track: { id: 'parity', title: 'Parity', artist: 'Hertz' } }),
        lyrics: () => ({ lines, index: fixture.position >= 6000 ? 1 : 0 }),
        lyricTokens: line => line.text === lines[0].text
          ? [{ text: 'We', start_ms: 0, end_ms: 1500 }, { text: 'sing', start_ms: 1500, end_ms: 3500 }, { text: 'together', start_ms: 3500, end_ms: 6000 }]
          : Array.from(line.text).map((text, i, chars) => ({ text, start_ms: 6000 + 6000 * i / chars.length, end_ms: 6000 + 6000 * (i + 1) / chars.length })),
        gate: (id, fps, tick) => { gates[id] = { fps, tick }; }, kick() {},
        tier: () => 2, spectrum: () => new Float32Array(64).fill(.2), energy: () => .2
      };
      document.addEventListener('stage:control', e => { if (e.detail.action === 'seek') fixture.position = e.detail.value; });
      window.draw = (count = 1) => { for (let i = 0; i < count; i++) gates.space3d.tick(16); };
    });
    for (const file of scripts) await page.addScriptTag({ url: '/' + file });
    await page.evaluate(async () => { Space3D.open(); await Space3D.enterStage('coast'); });
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      await page.setViewportSize({ width, height });
      for (const mode of ['classic', 'cadenza', 'sonnet', 'tempera']) {
        await page.evaluate(mode => { fixture.position = 1800; fixture.playing = true; Space3D.setLyricStyle('lyric-' + mode); draw(2); }, mode);
        const selector = '#sp-stanza .fl-' + mode;
        try { await page.waitForSelector(selector, { state: 'visible', timeout: 3000 }); }
        catch (error) {
          console.error(await page.evaluate(() => ({ stats: Space3D.stats(), prefs: Space3D.preferences(),
            classes: document.getElementById('space3d').className, markup: document.getElementById('sp-stanza').outerHTML })), errors);
          throw error;
        }
        if (mode === 'sonnet' || mode === 'tempera') {
          await page.waitForSelector(selector + ' canvas', { timeout: 15000 });
          await page.evaluate(() => draw(5));
        }
        assert.equal(await page.locator('#sp-reading').isVisible(), false, 'shared performance hides subtitle');
        assert.equal(await page.locator('#sp-stanza > *').count(), 1, 'only the active renderer is mounted');
        assert.equal(await page.evaluate(() => Space3D.stats().renderer.lyricBackend), 'stanza', 'original performance replaces the approximate spatial shader');
        if (mode === 'classic') {
          assert.deepEqual(await page.locator(selector + ' .fl-cword').evaluateAll(nodes => nodes.map(n => n.dataset.st)), ['passed', 'active', 'waiting']);
          const word = await page.locator(selector + ' .fl-cword').first().boundingBox();
          await page.mouse.click(word.x + word.width / 2, word.y + word.height / 2);
          assert.equal(await page.evaluate(() => fixture.position), 0, 'click uses shared seek control');
        }
        await page.evaluate(() => { fixture.position = 4500; fixture.playing = false; draw(3); });
        const pixels = await page.evaluate(selector => {
          draw();
          const canvas = document.querySelector(selector + ' canvas');
          if (!canvas || !/sonnet|tempera/.test(selector)) return null;
          const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
          const data = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
          gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, data);
          let colored = 0; for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 10 && data[i] + data[i + 1] + data[i + 2] > 30) colored++;
          return colored;
        }, selector);
        if (pixels !== null) assert.ok(pixels > 500, mode + ' canvas contains actual rendered pixels');
        await page.screenshot({ path: path.join(output, mode + '-' + width + '.png') });
        const before = await page.locator(selector).innerHTML();
        await page.evaluate(() => draw(3));
        assert.equal(await page.locator(selector).innerHTML(), before, 'paused frame remains stable');
        await page.evaluate(() => { fixture.position = 7200; draw(3); });
        assert.notEqual(await page.locator(selector).innerHTML(), before, 'paused seeking changes current lyrics');
        await page.evaluate(() => { document.getElementById('sp-stage-immersive').click(); draw(); });
        assert.equal(await page.locator(selector).isVisible(), true, 'immersion retains the shared performance');
        await page.keyboard.press('Escape');
        await page.evaluate(() => {
          const input = document.getElementById('sp-lyric-param-reduced');
          input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); draw();
        });
        assert.equal(await page.locator('#sp-stanza').evaluate(node => node.classList.contains('s3d-reduced')), true, 'local reduced motion reaches the original engine');
        const tuning = mode === 'classic' ? 'breathing' : mode === 'cadenza' ? 'glow' : 'halation';
        assert.equal(await page.locator('#sp-lyric-param-' + tuning).count(), 1, 'mode exposes its original tuning');
        await page.evaluate(() => { Space3D.goHome(); draw(); });
        assert.equal(await page.locator('#sp-stanza').isVisible(), false, 'home hides shared lyrics');
        await page.evaluate(() => Space3D.enterStage());
        await page.evaluate(() => draw(2));
      }
    }
    await page.evaluate(() => { Space3D.setLyricStyle('lyric-corridor'); draw(8); });
    assert.equal(await page.locator('#sp-stanza > *').count(), 0, 'native spatial lyrics release the shared renderer');
    await page.evaluate(() => { Space3D.setLyricStyle('lyric-classic'); draw(); document.getElementById('sp-lyric-button').click(); draw(); });
    assert.equal(await page.locator('#sp-stanza').isVisible(), false, 'global lyric toggle hides shared performance');
    await page.evaluate(() => Space3D.close());
    assert.equal(await page.locator('#sp-stanza > *').count(), 0, 'close releases the shared renderer');
    assert.deepEqual(errors, [], 'no runtime errors');
    console.log('Space lyric parity passed: four original renderers, desktop/mobile, word states, seek, pause, navigation and cleanup.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
