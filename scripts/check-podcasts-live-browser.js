#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Live catalog check against an isolated instance; leaves saved subscriptions intact.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { uiUrl } = require('./ui-token');
const base = process.env.PODCASTS_URL || 'http://127.0.0.1:7640';
const output = path.resolve(__dirname, '../output/podcasts-live-browser');

async function search(page, query, country) {
  await page.locator('#podcast-country').selectOption(country);
  await page.locator('#podcast-query').fill(query);
  const pending = page.waitForResponse(r => {
    const url = new URL(r.url());
    return url.pathname === '/v1/podcasts/search'
      && url.searchParams.get('q') === query && url.searchParams.get('country') === country;
  });
  await page.locator('#podcast-search').evaluate(form => form.requestSubmit());
  const response = await pending;
  assert.ok(response.ok(), 'search response succeeds for ' + country);
  const result = await response.json();
  assert.ok(result.shows.some(s => s.title === query), 'catalog contains ' + query);
  await page.locator('.podcast-show').filter({ hasText: query }).first().waitFor();
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(uiUrl(base), { waitUntil: 'load' });
      await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
      await page.waitForFunction(() => window.Podcasts && window.Skins);
      await page.evaluate(() => Skins.apply('hertz'));
      await page.locator('.rail-item[data-view="podcasts"]').click();
      await search(page, 'Planet Money', 'US');
      await page.locator('.podcast-show').filter({ hasText: 'Planet Money' }).first().click();
      await page.locator('.podcast-episode').first().waitFor();
      assert.ok(await page.locator('.podcast-episode').count() > 0, 'US feed loads episodes');
      await page.locator('#podcast-back').click();
      await search(page, 'The Rest Is History', 'GB');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'page fits viewport');
      for (const selector of ['#podcast-country', '#podcast-query', '#podcast-search button']) {
        const box = await page.locator(selector).boundingBox();
        assert.ok(box.width >= 70 && box.x >= 0 && box.x + box.width <= viewport.width, selector + ' fits viewport');
      }
      await page.screenshot({ path: path.join(output, 'regions-' + viewport.width + '.png') });
      assert.deepEqual(errors, [], 'no unhandled JavaScript errors');
      console.log('PASS real US/GB search, RSS episodes and layout at ' + viewport.width);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
