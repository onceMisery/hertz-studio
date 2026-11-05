// SPDX-License-Identifier: MIT
// Run against an isolated instance with VMUSIC_DATA_DIR and OPEN_MUSIC_URL set.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { uiToken, uiUrl } = require('./ui-token');

const base = process.env.OPEN_MUSIC_URL || 'http://127.0.0.1:7640';
const output = path.resolve(__dirname, '../output/playwright/open-music');
const token = uiToken();
let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; console.log('PASS ' + label); }
async function api(method, endpoint, body) {
  const r = await fetch(base + endpoint, {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  assert.ok(r.ok, method + ' ' + endpoint + ': ' + r.status);
  return r.json();
}
async function settings(page) {
  await page.evaluate(() => window.HertzShell.navigate('settings'));
  await page.locator('.hz-settings-nav [data-category="connection"]').click();
  await page.locator('#jamendo-client-id').waitFor({ state: 'visible' });
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  await api('PUT', '/v1/settings', { jamendo_client_id: '' });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(uiUrl(base), { waitUntil: 'load' });
      await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
      await page.waitForFunction(() => window.Online && Online.sources().length && window.Skins);
      await page.evaluate(() => window.Skins.apply('hertz'));
      await settings(page);
      await page.waitForFunction(() => !document.querySelector('#jamendo-save').disabled);
      const rect = await page.locator('#jamendo-client-id').boundingBox();
      check(rect.width >= 120 && rect.x >= 0 && rect.x + rect.width <= viewport.width,
        'Jamendo input is readable and inside viewport at ' + viewport.width);
      await page.locator('#jamendo-client-id').fill('hertz-verification-app');
      await page.locator('#jamendo-save').click();
      await page.waitForFunction(() => Online.sources().some(s => s.id === 'jamendo'));
      check((await api('GET', '/v1/settings')).jamendo_client_id === 'hertz-verification-app', 'Jamendo UI saves to backend at ' + viewport.width);
      await page.screenshot({ path: path.join(output, 'settings-' + viewport.width + '.png') });
      await page.locator('#jamendo-client-id').fill('');
      await page.locator('#jamendo-save').click();
      await page.waitForFunction(() => !Online.sources().some(s => s.id === 'jamendo'));
      check(!(await api('GET', '/v1/online/sources')).sources.some(s => s.id === 'jamendo'), 'Clearing client ID disables Jamendo');
      await page.evaluate(() => window.HertzShell.navigate('online'));
      await page.locator('#online-source').selectOption('ccmixter');
      await page.locator('#online-q').fill('zzhertznonexistent12345678');
      await page.locator('#online-q').press('Enter');
      await page.waitForFunction(() => !Online.state.loading && Online.state.q === 'zzhertznonexistent12345678');
      check(await page.locator('.online-row').count() === 0, 'Nonexistent ccMixter query has no results');
      await page.locator('#online-q').fill('Vacation Ukulele Sample');
      await page.locator('#online-q').press('Enter');
      await page.waitForFunction(() => !Online.state.loading && Online.state.tracks.some(t => t.id === '71185'), null, { timeout: 30000 });
      const row = page.locator('.online-row[data-online-id="online:ccmixter:71185"]');
      check((await row.textContent()).includes('Vacation - Ukulele Sample'), 'Existing title search returns correct song');
      check((await row.locator('.online-attribution').textContent()).includes('CC BY 4.0'), 'Per-track license is visible');
      check((await row.locator('.online-attribution a').count()) === 2, 'License and original work links present');
      check(await page.evaluate(() => Online.getMeta('online:ccmixter:71185').ref.license_url.includes('/by/4.0/')), 'Attribution survives metadata cache');
      await page.screenshot({ path: path.join(output, 'search-' + viewport.width + '.png') });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      check(!overflow, 'Page has no horizontal overflow at ' + viewport.width);
      if (viewport.width === 1440) {
        const response = page.waitForResponse(r => r.url().includes('/v1/online/play') && r.request().method() === 'POST', { timeout: 30000 });
        await row.locator('[data-act="preview"]').click();
        check((await response).ok(), 'Real ccMixter track enters player');
        check((await api('GET', '/v1/state')).track_id === 'online:ccmixter:71185', 'Player holds numeric ccMixter ID');
        await api('POST', '/v1/player/stop', {});
      }
      check(errors.length === 0, 'No browser JavaScript exceptions: ' + errors.join('; '));
      await page.close();
    }
  } finally {
    await api('PUT', '/v1/settings', { jamendo_client_id: '' });
    await browser.close();
  }
  console.log(checks + ' browser checks passed');
})().catch(e => { console.error(e.message); process.exitCode = 1; });
