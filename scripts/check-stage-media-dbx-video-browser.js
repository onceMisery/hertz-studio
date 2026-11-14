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
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true, args: ['--enable-features=MediaRecorderUseMP4'] });
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

    // Record a real MP4/H.264 stream, derive avcC's codec string, then feed it
    // through the same DBX chunk path with a page-local transport.
    const mp4 = await page.evaluate(async () => {
      async function record() {
        const canvas = document.createElement('canvas');
        canvas.width = 320; canvas.height = 240;
        canvas.style.cssText = 'position:fixed;left:-10000px;top:0';
        document.body.appendChild(canvas);
        const context = canvas.getContext('2d');
        const stream = canvas.captureStream(30);
        const recorder = new MediaRecorder(stream, { mimeType: 'video/mp4; codecs="avc1.42E01E"', videoBitsPerSecond: 2000000 });
        const parts = [];
        recorder.ondataavailable = event => { if (event.data.size) parts.push(event.data); };
        const stopped = new Promise(resolve => { recorder.onstop = resolve; });
        recorder.start(250);
        const start = performance.now();
        while (performance.now() - start < 2000) {
          const time = (performance.now() - start) / 1000;
          context.fillStyle = 'rgb(' + Math.floor(64 + 64 * Math.sin(time * 6)) + ',20,30)';
          context.fillRect(0, 0, 320, 240);
          context.fillStyle = '#fff';
          context.fillRect(20 + (time * 100) % 280, 100, 20, 20);
          await new Promise(resolve => setTimeout(resolve, 33));
        }
        recorder.requestData();
        recorder.stop();
        await stopped;
        await new Promise(resolve => setTimeout(resolve, 300));
        stream.getTracks().forEach(track => track.stop());
        canvas.remove();
        const bytes = new Uint8Array(await new Blob(parts, { type: 'video/mp4' }).arrayBuffer());
        return { bytes, mime: recorder.mimeType };
      }
      let recorded = await record();
      if (!recorded.bytes.length) recorded = await record();
      const bytes = recorded.bytes;
      let codecString = null;
      for (let index = 0; index + 8 < bytes.length; index++) {
        if (bytes[index] === 0x61 && bytes[index + 1] === 0x76 && bytes[index + 2] === 0x63 && bytes[index + 3] === 0x43) {
          const payload = index + 4, hex = value => value.toString(16).toUpperCase().padStart(2, '0');
          codecString = 'avc1.' + hex(bytes[payload + 1]) + hex(bytes[payload + 2]) + hex(bytes[payload + 3]);
          break;
        }
      }
      return { bytes: Array.from(bytes), mime: recorded.mime, codecString };
    });
    assert.ok(mp4.bytes.length > 0, 'MP4 recorder produced bytes');
    assert.match(mp4.codecString, /^avc1\.[0-9A-F]{6}$/);
    const mp4Result = await page.evaluate(async (recorded) => {
      const bytes = new Uint8Array(recorded.bytes), reads = [];
      window.VMusicTransport = {
        post: async (route, body) => {
          if (body.action === 'lease.acquire') return { leaseId: 'mp4', url: null, media: 'video', mime: 'video/mp4', codec: 'avc1', codecString: recorded.codecString, length: bytes.length, ttlMs: 120000, chunkBytes: 262144, contentKey: 'm' };
          if (body.action === 'lease.read') {
            const offset = body.offset, count = Math.min(body.count, 1000, bytes.length - offset);
            reads.push({ offset, count });
            return { offset, length: bytes.length, contentKey: 'm', dataBase64: btoa(String.fromCharCode.apply(null, bytes.subarray(offset, offset + count))) };
          }
          if (body.action === 'lease.release') return { ok: true };
          if (body.action === 'lease.renew') return { ttlMs: 120000 };
          throw new Error('unexpected ' + body.action);
        }
      };
      const value = await StageMedia.acquire({ assetRef: { storeId: 's', assetId: 'b'.repeat(64) } }, {});
      const video = document.getElementById('v');
      video.removeAttribute('src');
      video.load();
      video.src = value.url;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('mp4 setup timeout')), 15000);
        video.addEventListener('loadedmetadata', () => { clearTimeout(timeout); resolve(); }, { once: true });
        video.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('mp4 element error')); }, { once: true });
      });
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('mp4 play timeout')), 15000);
        const check = () => {
          if (video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 0) { clearTimeout(timeout); resolve(); }
          else setTimeout(check, 50);
        };
        check();
      });
      const facts = { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
      await value.release();
      return { facts, reads, mime: recorded.mime };
    }, mp4);
    assert.equal(mp4Result.facts.width, 320);
    assert.equal(mp4Result.facts.height, 240);
    assert.ok(mp4Result.facts.duration > 0, JSON.stringify(mp4Result.facts));
    assert.equal(mp4Result.reads[0].offset, 0);
    for (let index = 1; index < mp4Result.reads.length; index++) {
      assert.equal(mp4Result.reads[index].offset, mp4Result.reads[index - 1].offset + mp4Result.reads[index - 1].count);
    }

    assert.deepEqual(errors, []);
    console.log(`stage media DBX video: WebM ${bytes.length}B in ${reads.length} reads, ${facts.width}x${facts.height}, duration=${facts.duration.toFixed(2)}s; MP4 ${mp4.bytes.length}B ${mp4.codecString} ${mp4Result.facts.width}x${mp4Result.facts.height} in ${mp4Result.reads.length} reads; release+unsupported codec passed`);
  } finally {
    if (browser) await browser.close();
  }
}
main().catch(error => { console.error(error); process.exit(1); });
