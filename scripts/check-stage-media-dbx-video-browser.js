// SPDX-License-Identifier: MIT
// Real Chrome MSE: DBX lease.read chunks feed a MediaSource; no service or DBX host.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures', 'wallpaper-vp8.webm'));
  const chunkSize = 1000;
  const reads = [], releases = [];
  let mode = 'stream', browser;
  try {
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('dbxCommand', async body => {
      if (body.action === 'lease.acquire') {
        return mode === 'bad-codec'
          ? { leaseId: 'bad', url: null, media: 'video', mime: 'video/mp4', codec: 'avc1', length: bytes.length, ttlMs: 120000, chunkBytes: 262144, contentKey: 'k' }
          : { leaseId: 'dbx', url: null, media: 'video', mime: 'video/webm', codec: 'V_VP8', length: bytes.length, ttlMs: 120000, chunkBytes: 262144, contentKey: 'k' };
      }
      if (body.action === 'lease.read') {
        const offset = body.offset, count = Math.min(body.count, chunkSize, bytes.length - offset);
        reads.push({ offset, count });
        return { offset, length: bytes.length, contentKey: 'k', dataBase64: bytes.subarray(offset, offset + count).toString('base64') };
      }
      if (body.action === 'lease.release') { releases.push(body.leaseId); return { ok: true }; }
      if (body.action === 'lease.renew') return { ttlMs: 120000 };
      throw new Error('unexpected ' + body.action);
    });
    await page.setContent('<!doctype html><html><body><video id="v" muted playsinline></video></body></html>');
    await page.evaluate(() => {
      window.VMusicTransport = { post: function (route, body) { return window.dbxCommand(body); } };
      window.Stage = {
        resources: function () {
          return { port: function () { return { require: function () { return { commit: function () {}, release: function () {} }; } }; } };
        }
      };
    });
    await page.addScriptTag({ path: path.join(__dirname, '..', 'plugin', 'ui', 'stage-media.js') });

    const handle = await page.evaluate(async () => {
      const value = await StageMedia.acquire({ assetRef: { storeId: 's', assetId: 'a'.repeat(64) } }, {});
      window.__handle = value;
      const video = document.getElementById('v');
      video.src = value.url;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('video setup timeout')), 15000);
        video.addEventListener('loadedmetadata', () => { clearTimeout(timeout); resolve(); }, { once: true });
        video.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('video element error')); }, { once: true });
      });
      return { media: value.media, length: value.length };
    });
    assert.equal(handle.media, 'video');
    assert.equal(handle.length, bytes.length);
    await page.waitForFunction(() => {
      const video = document.getElementById('v');
      return video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 0;
    }, null, { timeout: 15000 });
    const facts = await page.evaluate(() => {
      const video = document.getElementById('v');
      return { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
    });
    assert.ok(facts.width > 0 && facts.height > 0, JSON.stringify(facts));
    assert.deepEqual(reads.map(read => read.offset), [0, 1000, 2000, 3000, 4000]);
    assert.equal(reads.at(-1).count, bytes.length - 4000);

    await page.evaluate(async () => { await window.__handle.release(); });
    assert.deepEqual(releases, ['dbx']);
    const readCount = reads.length;
    await page.waitForTimeout(300);
    assert.equal(reads.length, readCount, 'no reads after release');

    mode = 'bad-codec';
    releases.length = 0;
    const rejected = await page.evaluate(async () => {
      try {
        await StageMedia.acquire({ assetRef: { storeId: 's', assetId: 'a'.repeat(64) } }, {});
        return 'resolved';
      } catch (error) { return error.message; }
    });
    assert.match(rejected, /尚不支持该视频编码/);
    assert.deepEqual(releases, ['bad'], 'lease released when the codec is unsupported');
    assert.deepEqual(errors, []);
    console.log(`stage media DBX video: ${bytes.length}B in ${reads.length} reads, ${facts.width}x${facts.height}, duration=${facts.duration.toFixed(2)}s, release+unsupported codec passed`);
  } finally {
    if (browser) await browser.close();
  }
}
main().catch(error => { console.error(error); process.exit(1); });
