// SPDX-License-Identifier: MIT
// 队列「存为歌单」的插件形态验收：真实服务 + 允许脚本的宿主桩 + 假在线音源。
//
// 症状回归：在线曲目存进平台歌单后，「歌单」页当时还看不到它（缓存不刷新），
// 读起来就是「点了没反应」。这条检查同时钉住自建模态（插件里 window.prompt
// 被沙箱吞掉，只能走 dialogs.js）与保存后列表立即可见。
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { readAssets } = require('./ui-assets');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output', 'playwright', 'queue-save');
const QUEUE = ['online:netease:1001', 'online:netease:1002', 'online:netease:1003'];
let checks = 0;

function check(value, label) {
  assert.ok(value, label);
  checks += 1;
  console.log('PASS ' + label);
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const fixture = await startFixture();
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true,
    args: ['--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets'] });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await fixture.connect(context);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.stack || error.message));

    // 只替换在线音源与队列两处：其余仍打到夹具服务，业务断言不依赖假数据。
    await page.addInitScript(({ queue }) => {
      const online = { created: [], added: [], lists: [] };
      window.__fakeOnline = online;
      const json = (body, status = 200) => Promise.resolve({ status, body });
      window.dbxPlugin = {
        ready: Promise.resolve(),
        context: { surface: 'tab' },
        onEvent: () => () => {},
        encodeBase64: bytes => btoa(String.fromCharCode(...bytes)),
        copy: async () => {},
        invoke: async (method, params) => {
          const query = (params && params.query) || {};
          const body = params && params.body;
          const op = (params && params.op) || 'GET';
          if (method === 'v1/player/queue') return json({ queue, index: 0 });
          if (method === 'v1/online/sources') {
            return json({ sources: [{ id: 'netease', label: '网易云音乐',
              caps: ['qr_login', 'cookie_login', 'user_playlists', 'playlist_write'] }] });
          }
          if (method === 'v1/online/account') return json({ logged_in: true, nickname: '验收账号' });
          if (method === 'v1/online/playlists') return json(online.lists.slice());
          if (method === 'v1/online/playlist' && op === 'POST') {
            const playlist = { id: 'created-' + (online.created.length + 1), name: body.name, cover: null };
            online.created.push({ ...playlist, source: body.source });
            online.lists.unshift(playlist);
            return json(playlist);
          }
          if (method === 'v1/online/playlist/tracks/add') {
            online.added.push({ source: body.source, id: body.id, ids: (body.tracks || []).map(track => track.id) });
            return json({ state: 'applied' });
          }
          if (method.startsWith('v1/online/')) return json({ tracks: [], sources: [], queue: [], total: 0 });
          const url = '/' + method + (Object.keys(query).length ? '?' + new URLSearchParams(query) : '');
          const response = await fetch(url, {
            method: op,
            headers: { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          const text = await response.text();
          let payload; try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
          return { status: response.status, body: payload };
        },
      };
    }, { queue: QUEUE });

    const assets = new Map(readAssets().map(asset => [asset.path, asset]));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== fixture.base) return route.continue();
      if (url.pathname === '/') {
        const response = await route.fetch();
        const token = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'vmusicd.json'), 'utf8')).token;
        return route.fulfill({ response, contentType: 'text/html', body:
          fs.readFileSync(path.join(root, 'plugin/ui/index.html'), 'utf8').replace('__VMUSIC_TOKEN_VALUE__', token) });
      }
      if (assets.has(url.pathname)) {
        const asset = assets.get(url.pathname);
        return route.fulfill({ path: asset.file, contentType: asset.mime === 'JS' ? 'application/javascript' : 'text/css' });
      }
      return route.fallback();
    });

    await page.goto(fixture.base);
    await page.waitForFunction(() => window.hertzHost && window.hertzHost.isDbx && window.hertzDialog);
    check(await page.evaluate(() => window.hertzDialog.usesCustomModals()), 'plugin host routes prompts through the built-in dialog');
    await page.evaluate(() => restoreQueue());
    await page.waitForFunction(count => document.getElementById('queue-count').textContent === count, QUEUE.length + ' 首');

    await page.evaluate(() => document.querySelector('.rail-item[data-view="queue"]').click());
    await page.waitForFunction(() => !document.getElementById('view-queue').hidden);
    await page.evaluate(() => document.getElementById('queue-save').click());
    await page.waitForSelector('.np-modal .hz-dialog-input');
    check(true, 'save-as-playlist asks for a name without relying on window.prompt');

    await page.locator('.np-modal .hz-dialog-input').fill('验收歌单');
    await page.locator('.np-modal .hz-dialog-actions .btn.primary').click();
    await page.waitForFunction(() => window.__fakeOnline.created.length === 1);
    const saved = await page.evaluate(() => window.__fakeOnline);
    check(saved.created[0].name === '验收歌单' && saved.created[0].source === 'netease',
      'the named playlist is created on the matching online source');
    check(saved.added.length === 1 && saved.added[0].ids.length === QUEUE.length,
      'every online queue entry is appended to that playlist');
    await page.waitForFunction(() => document.querySelector('.toast.show')?.textContent.includes('验收歌单'));

    await page.evaluate(() => document.querySelector('.rail-item[data-view="playlists"]').click());
    await page.waitForFunction(() => !document.getElementById('view-playlists').hidden);
    const listed = await page.evaluate(() => document.getElementById('view-playlists').textContent.includes('验收歌单'));
    check(listed, 'the new online playlist is visible in 歌单 without waiting for another sync');

    await page.screenshot({ path: path.join(output, 'queue-save.png') });
    check(errors.length === 0, 'no browser exceptions: ' + errors.join('; '));
    console.log(JSON.stringify({ checks, output }));
  } finally {
    await browser.close();
    await fixture.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
