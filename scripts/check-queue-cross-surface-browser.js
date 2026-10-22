// SPDX-License-Identifier: MIT
// Reconcile a queue change made after startup reads but before the first event subscription.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startFixture } = require('./ui-browser-fixture');
const { uiUrl } = require('./ui-token');

async function main() {
  const fixture = await startFixture();
  process.env.VMUSIC_DATA_DIR = fixture.dataDir;
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
  await fixture.connect(context);
  const page = await context.newPage();
  let healthRequests = 0;
  let releaseHealth;
  let healthBlocked;
  const blockedHealth = new Promise(resolve => { healthBlocked = resolve; });
  const healthGate = new Promise(resolve => { releaseHealth = resolve; });
  let initialQueueRead;
  const queueLoaded = new Promise(resolve => { initialQueueRead = resolve; });

  try {
    const track = await fixture.seed();
    await page.route('**/app.js*', route => route.fulfill({
      contentType: 'application/javascript; charset=utf-8',
      body: fs.readFileSync(path.resolve(__dirname, '../plugin/ui/app.js'), 'utf8'),
    }));
    await page.route('**/v1/health', async route => {
      healthRequests += 1;
      if (healthRequests === 2) {
        healthBlocked();
        await healthGate;
      }
      await route.continue();
    });
    await page.route('**/v1/player/queue', async route => {
      if (route.request().method() === 'GET') {
        const response = await route.fetch();
        await route.fulfill({ response });
        initialQueueRead();
      } else await route.continue();
    });

    const initialRead = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/v1/player/queue' && response.request().method() === 'GET');
    await page.goto(uiUrl(fixture.base), { waitUntil: 'domcontentloaded' });
    await Promise.all([blockedHealth, queueLoaded, initialRead]);
    await page.locator(`.q-row[data-track-id="${track.id}"]`).waitFor({ state: 'attached' });

    const otherSurfaceId = 'cross-surface-fixture-item';
    await fixture.api('/v1/player/queue', 'PUT', {
      queue: [track.id, otherSurfaceId], index: 0, resume: true,
    });
    const serverQueue = await fixture.api('/v1/player/queue');
    assert.deepEqual(serverQueue.queue, [track.id, otherSurfaceId]);

    releaseHealth();
    await page.getByText('服务已连接', { exact: true }).waitFor({ timeout: 10000 });
    await page.locator(`.q-row[data-track-id="${otherSurfaceId}"]`).waitFor({ state: 'attached', timeout: 5000 });
    assert.equal(await page.locator(`.q-row[data-track-id="${track.id}"]`).count(), 1);
    console.log('PASS first event subscription re-reads queue changes made during startup; no later queue event required');
  } finally {
    releaseHealth();
    await context.close();
    await browser.close();
    await fixture.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
