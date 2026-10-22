#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Real service/DOM with controlled failure responses. Actual decoder format
// classification is covered separately by vmusic-audio's in-memory media test.
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
  const context = await browser.newContext({ viewport: {width:390,height:760} });
  const errors = [], output = path.resolve('output/playwright/audio-errors');
  fs.mkdirSync(output, {recursive:true});
  try {
    await fixture.connect(context);
    const track = await fixture.seed();
    const targetPath = path.join(path.dirname(track.path), 'second.wav');
    fs.copyFileSync(track.path, targetPath);
    await fixture.api('/v1/library/scan', 'POST', {root:path.dirname(track.path)});
    let target;
    for (let i=0;i<100;i++) {
      target = (await fixture.api('/v1/tracks?limit=10')).tracks.find(t => t.id !== track.id);
      if (target) break;
      await new Promise(resolve => setTimeout(resolve,100));
    }
    assert.ok(target, 'Use a different selected track to verify failed loads preserve current media');
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(uiUrl(fixture.base));
    await page.waitForFunction(() => document.getElementById('conn').classList.contains('ok'));
    await page.locator('[data-view="library"]').first().click();
    await page.locator('#scan-toggle').click();
    assert.match(await page.locator('#scan-format-note').innerText(), /Opus、APE、WMA/);
    assert.equal(await page.locator('#scan-root').getAttribute('aria-describedby'), 'scan-format-note');
    await page.locator('#scan-format-note').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({path:path.join(output,'formats-390.png')});
    await page.locator('#scan-toggle').click();
    const row = page.locator('#lib-list .track[data-id="'+target.id+'"]');
    await row.waitFor();
    let attempts = 0;
    for (const [code,status,expected] of [
      ['unsupported_format',415,'无法识别容器或编码'],
      ['decode_failed',500,'音频读取或解码失败'],
    ]) {
      const intercept = async route => {
        attempts++;
        await route.fulfill({status,contentType:'application/json',body:JSON.stringify({error:{
          code,message:'decoder internal detail',request_id:'audio-browser-'+code,
        }})});
      };
      await page.route('**/v1/player/load', intercept);
      await row.click();
      await page.waitForFunction(text => document.getElementById('toast').textContent.includes(text), expected);
      await page.waitForFunction(() => !document.getElementById('playpause').classList.contains('is-loading'));
      const text = await page.locator('#toast').innerText();
      assert.match(text, new RegExp('audio-browser-'+code));
      assert.doesNotMatch(text, /decoder internal detail/);
      if (code === 'decode_failed') assert.doesNotMatch(text, /Opus/);
      await page.waitForFunction(() => Number(getComputedStyle(document.getElementById('toast')).opacity) === 1);
      const bounds = await page.locator('#toast').boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.width >= 300,
        'Long error uses the available viewport width: '+JSON.stringify(bounds));
      assert.equal(await page.locator('#toast').evaluate(el => el.scrollWidth <= el.clientWidth), true);
      assert.equal((await fixture.api('/v1/state')).track_id, track.id);
      assert.equal((await fixture.api('/v1/state')).playing, false);
      await page.screenshot({path:path.join(output,code+'-390.png')});
      await page.unroute('**/v1/player/load', intercept);
    }
    assert.equal(attempts, 2, 'Failed load POSTs are never automatically retried');
    const loaded = page.waitForResponse(response => response.url().endsWith('/v1/player/load') && response.status() === 200);
    await row.click();
    await loaded;
    await page.waitForFunction(() => !document.getElementById('playpause').classList.contains('is-loading'));
    assert.equal((await fixture.api('/v1/state')).track_id, target.id, 'A successful later load changes the actual current track');
    assert.deepEqual(errors, []);
    console.log('PASS real UI format guidance, controlled codec/read failures, request IDs, no POST retry, loading cleanup and subsequent load; no sound-card acceptance claimed');
  } finally {
    await context.close();
    await browser.close();
    await fixture.close();
  }
}
main().catch(error => { console.error(error); process.exitCode=1; });
