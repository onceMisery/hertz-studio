// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
'use strict';
// Default: complete shipped document/scripts, only app startup removed. Set
// SHARE_CODE_URL and VMUSIC_DATA_DIR for the actual embedded UI + null service.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { uiUrl } = require('./ui-token');
const web = path.resolve(__dirname, '..', 'plugin/ui');
const output = path.resolve(__dirname, '..', 'output/playwright/creative-share-code');
async function main() {
  let server, browser;
  const live = !!process.env.SHARE_CODE_URL;
  try {
    let base = process.env.SHARE_CODE_URL;
    if (!live) {
      server = http.createServer((req, res) => {
        const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '') || 'index.html';
        const file = path.resolve(web, rel);
        if (!file.startsWith(web + path.sep)) { res.writeHead(403); res.end(); return; }
        try {
          let body = fs.readFileSync(file);
          if (rel === 'index.html') body = Buffer.from(body.toString().replace(/<script\b[^>]*src="app\.js"[^>]*><\/script>/, ''));
          res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream');
          res.end(body);
        } catch (_) { res.writeHead(404); res.end(); }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      base = 'http://127.0.0.1:' + server.address().port;
    } else assert.equal((await fetch(base + '/v1/health').then(r => r.json())).backend, 'null');
    for (const file of ['creative-stage.js', 'creative-share-code.js', 'workshop.js']) {
      const response = await fetch(base + '/' + file);
      assert.equal(response.status, 200);
      assert.equal((await response.text()).replace(/\r\n/g, '\n'), fs.readFileSync(path.join(web, file), 'utf8').replace(/\r\n/g, '\n'), 'current served asset: ' + file);
    }
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(live ? uiUrl(base) : base);
    await page.waitForFunction(() => window.Workshop && window.CreativeShareCode);
    if (live) await page.waitForFunction(() => document.getElementById('conn').textContent === '服务已连接');
    else await page.evaluate(() => { Stage.init(); CreativeStage.init(); Stage3D.init(); Workshop.init(); });
    await page.evaluate(() => {
      Workshop.open(); Workshop.setTab('io');
      const preset = CreativeStage.preset(); preset.name = '晚风 · 分享验收 🎵';
      CreativeStage.setPreset(preset);
      document.execCommand = () => false;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('clipboard denied')) } });
    });
    await page.locator('#ws-share-compatible').check();
    await page.locator('#ws-share-copy').click();
    await page.waitForFunction(() => document.getElementById('ws-share-status').textContent.includes('自动复制失败'));
    const portable = await page.locator('#ws-share-code').inputValue();
    assert.match(portable, /^HSCP1\.J\./);
    assert.equal(await page.locator('#ws-share-code').evaluate(el => el.selectionEnd - el.selectionStart), portable.length, 'manual copy fallback selects all code');
    const expected = await page.evaluate(() => CreativeStage.shareSnapshot());
    await page.evaluate(() => CreativeStage.setParam('cam.dist', 33));
    await page.locator('#ws-share-code').fill(portable);
    await page.locator('#ws-share-import').click();
    await page.waitForFunction(dist => CreativeStage.preset().cam.dist === dist, expected.cam.dist);
    assert.deepEqual(await page.evaluate(() => CreativeStage.shareSnapshot()), expected, 'UI import restores the complete creative preset');
    await page.locator('#ws-share-code').fill(portable.slice(0, -8) + '00000000');
    await page.locator('#ws-share-import').click();
    await page.waitForFunction(() => document.getElementById('ws-share-status').textContent.includes('校验失败'));
    assert.deepEqual(await page.evaluate(() => CreativeStage.shareSnapshot()), expected, 'bad code does not mutate the preset');
    // Delay the real decoder at its async boundary; later user actions must win.
    await page.evaluate(() => {
      const decode = CreativeShareCode.decode;
      window.__realShareDecode = decode;
      CreativeShareCode.decode = text => new Promise((resolve, reject) => {
        window.__finishShareDecode = () => decode(text).then(resolve, reject);
      });
    });
    for (const action of ['edit', 'close', 'input']) {
      await page.locator('#ws-share-code').fill(portable);
      await page.locator('#ws-share-import').click();
      await page.waitForFunction(() => !!window.__finishShareDecode);
      if (action === 'edit') await page.evaluate(() => CreativeStage.setParam('cam.dist', 34));
      if (action === 'close') await page.evaluate(() => Workshop.close());
      if (action === 'input') await page.locator('#ws-share-code').fill('新的输入');
      await page.evaluate(async () => { const finish = window.__finishShareDecode; window.__finishShareDecode = null; await finish(); });
      await page.waitForTimeout(50);
      assert.equal(await page.evaluate(() => CreativeStage.preset().cam.dist), 34, action + ' supersedes pending import');
      if (action === 'edit') assert.match(await page.locator('#ws-share-status').textContent(), /已取消/);
      if (action === 'close') {
        assert.equal(await page.evaluate(() => Workshop.isOpen()), false);
        await page.evaluate(() => { Workshop.open(); Workshop.setTab('io'); });
      }
      if (action === 'input') assert.equal(await page.locator('#ws-share-code').inputValue(), '新的输入');
    }
    await page.evaluate(() => { CreativeShareCode.decode = window.__realShareDecode; });
    await page.locator('#ws-share-compatible').uncheck();
    await page.locator('#ws-share-copy').click();
    await page.waitForFunction(() => document.getElementById('ws-share-code').value.startsWith('HSCP1.G.'));
    const compressed = await page.locator('#ws-share-code').inputValue();
    await page.evaluate(() => { window.__decompressor = window.DecompressionStream; window.DecompressionStream = undefined; });
    await page.locator('#ws-share-import').click();
    await page.waitForFunction(() => document.getElementById('ws-share-status').textContent.includes('不支持 gzip'));
    await page.evaluate(() => { window.DecompressionStream = window.__decompressor; });
    await page.locator('#ws-share-code').fill(compressed);
    await page.locator('#ws-share-import').click();
    await page.waitForFunction(() => document.getElementById('ws-share-code').value === '');
    assert.ok(await page.getByRole('button', { name: '载入这段 JSON', exact: true }).count(), 'JSON import stays available');
    fs.mkdirSync(output, { recursive: true });
    await page.locator('#ws-share-compatible').check();
    await page.locator('#ws-share-copy').click();
    await page.waitForFunction(() => document.getElementById('ws-share-status').textContent.includes('自动复制失败'));
    await page.screenshot({ path: path.join(output, live ? 'share-live-desktop.png' : 'share-fixture-desktop.png') });
    await page.setViewportSize({ width: 420, height: 900 });
    await page.locator('#ws-share-import').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, live ? 'share-live-narrow.png' : 'share-fixture-narrow.png') });
    assert.equal(await page.evaluate(() => document.getElementById('ws-body').scrollWidth <= document.getElementById('ws-body').clientWidth + 2), true, 'narrow editor has no horizontal overflow');
    assert.deepEqual(errors, [], 'no browser runtime errors');
    console.log('Creative share UI (' + (live ? 'live-service' : 'complete-document fixture') + '): J/G import, clipboard fallback, bad code, edit/close/input races, gzip capability, JSON compatibility and narrow layout passed.');
  } finally {
    if (browser) await browser.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
