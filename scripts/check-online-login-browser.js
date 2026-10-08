#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Real DOM + shipped login module; all account/QR requests are local fixtures.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, 'plugin/ui', file), 'utf8');
const html = read('index.html');
const from = html.indexOf('<div id="qr-modal"');
const to = html.indexOf('\n<!-- 播放控制弹窗', from);
assert.ok(from >= 0 && to > from, 'shipped login markup exists');

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const stage of ['sources', 'accounts', 'settings']) {
      for (const outcome of ['success', 'error', ...(stage === 'sources' ? ['empty'] : [])]) {
        const page = await browser.newPage({ viewport: { width: 900, height: 760 } });
        const errors = []; page.on('pageerror', e => errors.push(e.message));
        await page.setContent('<span id="online-account-face"></span><span id="online-account-dot"></span>' + html.slice(from, to));
        for (const file of ['style.css', 'online.css']) await page.addStyleTag({ content: read(file) });
        await page.evaluate(stage => {
          const list = { sources: ['netease', 'qq'].map(id => ({ id, label: id, caps: ['qr_login'] })) };
          let first = true;
          window.calls = [];
          window.VMusicTransport = {
            async get(url) {
              const matches = stage === 'sources' ? url.endsWith('/sources')
                : stage === 'accounts' ? url.includes('account?source=netease') : url.endsWith('/settings');
              if (first && matches) {
                first = false;
                return new Promise((resolve, reject) => {
                  window.settleOld = outcome => outcome === 'error' ? reject(new Error('late failure'))
                    : resolve(outcome === 'empty' ? { sources: [] }
                      : stage === 'sources' ? list : stage === 'accounts' ? { nickname: 'late-account' } : { topAvatarSource: 'netease' });
                });
              }
              if (url.endsWith('/sources')) return list;
              if (url.includes('/account?')) throw { status: 401, code: 'auth_required' };
              if (url.includes('/qr/poll')) return { state: 'waiting' };
              return {};
            },
            async put() {},
            async post(url, body) {
              calls.push({ url, body });
              if (url.endsWith('/qr/start')) return { ticket: body.source,
                qr_image: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><text y="16">' + body.source + '</text></svg>', poll_ms: 60000 };
              return { ok: true };
            },
          };
        }, stage);
        await page.addScriptTag({ content: read('online-login.js') });
        await page.evaluate(() => { window.oldOpen = OnlineLogin.open('netease'); });
        await page.waitForFunction(() => typeof settleOld === 'function');
        await page.locator('#qr-close').click();
        assert.equal(await page.locator('#qr-modal').isVisible(), false);
        await page.evaluate(() => OnlineLogin.open('qq'));
        const image = await page.locator('#qr-canvas img').getAttribute('src');
        const status = await page.locator('#qr-status').textContent();
        await page.evaluate(async outcome => { settleOld(outcome); await oldOpen; }, outcome);
        assert.equal(await page.locator('#qr-modal').isVisible(), true);
        assert.equal(await page.locator('#qr-canvas img').getAttribute('src'), image, stage + '/' + outcome);
        assert.equal(await page.locator('#qr-status').textContent(), status);
        assert.equal(await page.locator('#qr-title').textContent(), 'qq 登录');
        const calls = await page.evaluate(() => window.calls);
        assert.deepEqual(calls.filter(c => c.url.endsWith('/qr/start')).map(c => c.body.source), ['qq']);
        assert.ok(!calls.some(c => c.url.endsWith('/qr/cancel') && c.body.ticket === 'qq'));
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#qr-modal').isVisible(), false);
        assert.deepEqual(errors, []);
        await page.close();
      }
    }
    console.log('Login Chrome: 7 delayed source/account/settings success/error/empty scenarios preserve reopened QQ, ticket and status; Escape closes; no page errors.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
