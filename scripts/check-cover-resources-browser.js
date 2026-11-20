// SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const http = require('node:http'), crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { root, owner, probe, paint, exportsSource } = require('./cover-lifecycle-fixture');
const app = fs.readFileSync(path.join(root, 'plugin/ui/app.js'), 'utf8');
const mediaSource = app.slice(app.indexOf('const MEDIA_SESSION_ACTIONS ='), app.indexOf('function bindMediaSession()'));
const output = path.join(root, 'output/offline-design-completion/m1-covers');
fs.mkdirSync(output, { recursive: true });
const files = ['plugin/ui/app.js', 'plugin/ui/stage-image-source.js', 'plugin/ui/stage3d.js', 'plugin/ui/stage.js', 'plugin/ui/space3d.js', 'plugin/ui/pl-covers.js', 'plugin/ui/stage-shelf.js', 'plugin/ui/backgrounds.js',
  'plugin/ui/stage-resource-budget.js', 'plugin/ui/stage-resource-policy.js'];
const report = { at: new Date().toISOString(), scope: 'Production common cover owner and raster helper in real local Chrome; DOM/native physical caches are not measured.',
  hashes: Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])), checks: [] };
let browser, origin, foreign, png;
const sockets = new Set();
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/image')) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); }
  else if (req.url === '/missing') { res.writeHead(404); res.end(); }
  else if (req.url === '/stall') { /* owner deadline must retire this presentation */ }
  else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Cover resources</title><body style="background:#191b1c"></body>'); }
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
async function pageFor(caps = {}, kind = 'server') {
  const page = await browser.newPage();
  await page.route('**/*', route => route.request().url().startsWith(origin) || route.request().url().startsWith(foreign) ? route.continue() : route.abort());
  await page.goto(origin);
  for (const file of ['stage-resource-budget.js', 'stage-resource-policy.js', 'stage-image-source.js'])
    await page.addScriptTag({ path: path.join(root, 'plugin/ui', file) });
  await page.evaluate(({ caps, kind }) => {
    const ledger = window.ledger = StageResourceBudget.create({ ...StageResourcePolicy, caps: { ...StageResourcePolicy.caps, ...caps } });
    window.Stage = { resources: () => ledger }; window.transport = { kind }; window.calls = [];
    window.dbxRequest = (path, options) => new Promise((resolve, reject) => calls.push({ path, options, resolve, reject }));
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 4;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#21aa77'; ctx.fillRect(0, 0, 4, 4);
    window.pngUrl = canvas.toDataURL('image/png');
    window.target = document.createElement('img'); target.style.cssText = 'width:120px;height:120px;image-rendering:pixelated'; document.body.append(target);
  }, { caps, kind });
  await page.addScriptTag({ content: owner + probe + paint + exportsSource });
  return page;
}
async function check(name, body) {
  const evidence = await body(); report.checks.push({ name, passed: true, evidence }); console.log('PASS ' + name);
}
async function main() {
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  const port = server.address().port; origin = `http://127.0.0.1:${port}/`; foreign = `http://localhost:${port}/`;
  browser = await chromium.launch({ channel: 'chrome', headless: true }); report.browser = browser.version();
  await check('actual raster decode, borrowed cache eviction and detached-element cleanup', async () => {
    const page = await pageFor({}, 'dbx');
    png = Buffer.from((await page.evaluate(() => pngUrl)).split(',')[1], 'base64');
    await page.evaluate(async () => {
      const pending = coverTest.ensureCover('actual'); calls[0].resolve({ data: pngUrl.split(',')[1], content_type: 'image/png' });
      const url = await pending; coverTest.applyCoverImg(target, url);
    });
    await page.waitForFunction(() => target.naturalWidth === 4 && coverTest.stats().preparations === 0);
    await page.screenshot({ path: path.join(output, 'decoded-cover.png') });
    const before = await page.evaluate(() => ledger.snapshot());
    assert.equal(before.held.decoderLeases, 0); assert.equal(before.resources, 2);
    await page.evaluate(() => coverTest.invalidate('actual'));
    assert.equal(await page.evaluate(() => coverTest.stats().sources), 1);
    await page.evaluate(() => target.remove()); await page.waitForFunction(() => ledger.snapshot().resources === 0);
    await page.close(); return { sourceBytes: before.held.ownedCpuBytes, width: 4 };
  });
  await check('decode refusal happens before Image construction or src assignment', async () => {
    const page = await pageFor({ decoderLeases: 0 });
    const result = await page.evaluate(async () => {
      const NativeImage = Image; let images = 0;
      window.Image = function (...args) { images++; return new NativeImage(...args); };
      const ok = await coverTest.probeImage(pngUrl); await Promise.resolve(); await Promise.resolve();
      return { ok, images, held: ledger.snapshot().held, stats: coverTest.stats() };
    });
    assert.equal(result.ok, false); assert.equal(result.images, 0); assert.equal(result.held.ownedCpuBytes, 0);
    await page.close(); return result;
  });
  await check('foreign HTTP without CORS, 404 fallback, timeout and 100 replacement cleanup', async () => {
    const page = await pageFor();
    const result = await page.evaluate(async foreign => {
      coverTest.applyCoverImg(target, foreign + 'image');
      const missing = await coverTest.probeImage(foreign + 'missing');
      const timeout = await coverTest.probeImage(foreign + 'stall', 30);
      for (let i = 0; i < 100; i++) coverTest.applyCoverBg(document.body, foreign + 'image?v=' + i);
      coverTest.applyCoverBg(document.body, foreign + 'image');
      return { missing, timeout };
    }, foreign);
    assert.equal(result.missing, false); assert.equal(result.timeout, false);
    await page.waitForFunction(() => target.naturalWidth === 4 && coverTest.stats().preparations === 0);
    const final = await page.evaluate(() => ({ crossOrigin: target.crossOrigin, resources: ledger.snapshot().resources, stats: coverTest.stats() }));
    assert.equal(final.crossOrigin, null); assert.equal(final.resources, 0);
    await page.close(); return { ...result, ...final };
  });
  await check('canceled real decoder retains its budget until injected settlement finishes', async () => {
    const page = await pageFor({ decoderLeases: 1 });
    await page.evaluate(() => {
      const native = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = function () { return native.call(this).then(() => new Promise(resolve => { window.finishDecode = resolve; })); };
      window.work = coverTest.prepareCoverImage(pngUrl);
    });
    await page.waitForFunction(() => !!window.finishDecode);
    const result = await page.evaluate(async () => {
      work.cancel(); const canceled = await work.promise; const held = ledger.snapshot().held;
      const waiting = coverTest.prepareCoverImage(pngUrl), queued = coverTest.stats().preparationQueue;
      waiting.cancel(); const refused = await waiting.promise; return { canceled, refused, held, queued };
    });
    assert.equal(result.canceled, false); assert.equal(result.refused, false); assert.equal(result.held.decoderLeases, 1);
    assert.equal(result.queued, 1);
    assert(result.held.decodeReservedBytes > 0);
    await page.evaluate(() => finishDecode()); await page.waitForFunction(() => ledger.snapshot().resources === 0);
    await page.close(); return result;
  });
  await check('Stage current track and Space3D queue keep evicted sources until their own retirement', async () => {
    const page = await pageFor();
    await page.addScriptTag({ path: path.join(root, 'plugin/ui/stage.js') });
    await page.addScriptTag({ path: path.join(root, 'plugin/ui/space3d.js') });
    await page.evaluate(() => { window.ledger = Stage.resources(); Stage.setTrack({ id: 'track' }, pngUrl); });
    assert.equal(await page.evaluate(() => coverTest.stats().sources), 1);
    await page.evaluate(() => Space3D.setQueue([{ id: 'track', cover: pngUrl }]));
    await page.evaluate(() => Stage.setTrack(null, null));
    assert.equal(await page.evaluate(() => coverTest.stats().sources), 1, 'queue remains owner after Stage track changes');
    await page.evaluate(() => Space3D.setQueue([]));
    await page.waitForFunction(() => ledger.snapshot().resources === 0);
    const snapshot = await page.evaluate(() => ledger.snapshot()); await page.close(); return snapshot;
  });
  await check('MediaSession source lives through cache retirement and ends when native ownership clears metadata', async () => {
    const page = await pageFor({}, 'dbx');
    await page.addScriptTag({ content: `let mediaSessionStateKey = '';\n${mediaSource.replace('let mediaSessionCoverBorrow = null;', '')}
      window.testMedia = { updateMediaSessionMetadata, clearBrowserMediaSession };` });
    await page.evaluate(async () => {
      const request = coverTest.ensureCover('media'); calls[0].resolve({ data: pngUrl.split(',')[1], content_type: 'image/png' });
      const url = await request;
      testMedia.updateMediaSessionMetadata({ title: 'Cover source' }, url); await coverTest.invalidate('media');
    });
    assert.equal(await page.evaluate(() => navigator.mediaSession.metadata.title), 'Cover source');
    assert.equal(await page.evaluate(() => coverTest.stats().sources), 1);
    await page.evaluate(() => testMedia.clearBrowserMediaSession());
    await page.waitForFunction(() => ledger.snapshot().resources === 0);
    const snapshot = await page.evaluate(() => ledger.snapshot()); await page.close(); return snapshot;
  });
  await check('mounted playlist artwork follows a local cover edit without a retained callback', async () => {
    const page = await pageFor({}, 'dbx');
    await page.evaluate(async () => {
      window.art = document.createElement('div'); art.dataset.coverId = 'editable'; document.body.append(art);
      const request = coverTest.ensureCover('editable'); calls[0].resolve({ data: pngUrl.split(',')[1], content_type: 'image/png' }); await request;
    });
    await page.waitForFunction(() => art.style.backgroundImage.includes(pngUrl) && coverTest.stats().preparations === 0);
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 5;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#aa2277'; ctx.fillRect(0, 0, 5, 5); window.changed = canvas.toDataURL();
      await coverTest.invalidate('editable'); const request = coverTest.ensureCover('editable');
      calls[1].resolve({ data: changed.split(',')[1], content_type: 'image/png' }); await request;
    });
    await page.waitForFunction(() => art.style.backgroundImage.includes(changed) && coverTest.stats().preparations === 0);
    assert.equal(await page.evaluate(() => coverTest.stats().slots), 0);
    await page.evaluate(async () => { await coverTest.invalidate('editable'); art.remove(); });
    await page.waitForFunction(() => ledger.snapshot().resources === 0); await page.close(); return { changed: true, retainedSlots: 0 };
  });
  await check('Backgrounds retains its polled cover through other-owner retirement and releases on destroy', async () => {
    const page = await pageFor({}, 'dbx');
    await page.addScriptTag({ path: path.join(root, 'plugin/ui/backgrounds.js') });
    await page.evaluate(async () => {
      const request = coverTest.ensureCover('background'); calls[0].resolve({ data: pngUrl.split(',')[1], content_type: 'image/png' });
      const url = await request; Backgrounds.setCover(url); await coverTest.invalidate('background');
    });
    assert.equal(await page.evaluate(() => coverTest.stats().sources), 1);
    await page.evaluate(() => Backgrounds.destroy()); await page.waitForFunction(() => ledger.snapshot().resources === 0);
    const snapshot = await page.evaluate(() => ledger.snapshot()); await page.close(); return snapshot;
  });
  await check('ordinary library rows retain data sources through cache invalidation and release on row reuse or detach', async () => {
    const page = await pageFor({}, 'dbx');
    await page.evaluate(async () => {
      window.row = document.createElement('div'); row.dataset.id = 'library'; row.innerHTML = '<div class="t-art"></div>'; document.body.append(row);
      const pending = coverTest.ensureCover('library'); calls[0].resolve({ data: pngUrl.split(',')[1], content_type: 'image/png' }); await pending;
    });
    await page.waitForFunction(() => row.querySelector('img')?.naturalWidth === 4);
    await page.evaluate(() => coverTest.invalidate('library'));
    const retained = await page.evaluate(() => ({ source: coverTest.stats().sources, held: ledger.snapshot().held.ownedCpuBytes,
      dataset: row.querySelector('.t-art').dataset.src || null, src: row.querySelector('img').getAttribute('src') }));
    assert.equal(retained.source, 1); assert(retained.held > 0); assert.equal(retained.dataset, null); assert(retained.src.startsWith('data:'));
    await page.evaluate(() => { window.oldImage = row.querySelector('img'); coverTest.paintArt(row, null); });
    await page.waitForFunction(() => ledger.snapshot().resources === 0);
    assert.equal(await page.evaluate(() => oldImage.getAttribute('src')), null, 'row reuse clears old element URL before releasing its source');
    await page.evaluate(() => coverTest.paintArt(row, pngUrl)); await page.waitForFunction(() => row.querySelector('img')?.naturalWidth === 4);
    await page.evaluate(() => { window.detachedArt = row.querySelector('.t-art'); row.remove(); });
    await page.waitForFunction(() => ledger.snapshot().resources === 0);
    assert.equal(await page.evaluate(() => detachedArt.querySelector('img')), null);
    await page.close(); return retained;
  });
  await check('sixty simultaneous foreign covers recover after the first thirty-two preparations', async () => {
    const page = await pageFor();
    const initial = await page.evaluate(foreign => {
      window.manyCovers = Array.from({ length: 60 }, (_, index) => {
        const image = document.createElement('img'); document.body.append(image);
        coverTest.applyCoverImg(image, foreign + 'image?row=' + index); return image;
      });
      return coverTest.stats();
    }, foreign);
    assert.equal(initial.preparations, 32); assert.equal(initial.preparationQueue, 28);
    await page.waitForFunction(() => manyCovers.every(image => image.naturalWidth === 4) && coverTest.stats().preparations === 0
      && coverTest.stats().preparationQueue === 0);
    const result = await page.evaluate(() => ({ loaded: manyCovers.filter(image => image.naturalWidth === 4).length,
      cors: manyCovers.some(image => image.crossOrigin !== null), resources: ledger.snapshot().resources }));
    assert.equal(result.loaded, 60); assert.equal(result.cors, false); assert.equal(result.resources, 0);
    await page.close(); return { initial, result };
  });
  await check('connected element detached during native decode cannot commit or keep a displayed source', async () => {
    const page = await pageFor();
    await page.evaluate(() => {
      const native = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = function () { return native.call(this).then(() => new Promise(resolve => { window.finishDetachedDecode = resolve; })); };
      coverTest.applyCoverImg(target, pngUrl);
    });
    await page.waitForFunction(() => !!window.finishDetachedDecode);
    await page.evaluate(() => target.remove());
    await page.waitForFunction(() => coverTest.stats().displays === 0 && ledger.snapshot().held.decoderLeases === 1);
    const retiring = await page.evaluate(() => ({ src: target.getAttribute('src'), held: ledger.snapshot().held, stats: coverTest.stats() }));
    assert.equal(retiring.src, null); assert(retiring.held.decodeReservedBytes > 0);
    await page.evaluate(() => finishDetachedDecode()); await page.waitForFunction(() => ledger.snapshot().resources === 0);
    const final = await page.evaluate(() => ({ src: target.getAttribute('src'), stats: coverTest.stats() }));
    assert.equal(final.src, null); assert.equal(final.stats.sources, 0); assert.equal(final.stats.displays, 0);
    await page.close(); return { retiring, final };
  });
  await check('detached construction may mount before decode, but a later detach retires its source', async () => {
    const page = await pageFor();
    await page.evaluate(() => {
      window.constructed = document.createElement('img'); coverTest.applyCoverImg(constructed, pngUrl); document.body.append(constructed);
    });
    await page.waitForFunction(() => constructed.naturalWidth === 4 && coverTest.stats().preparations === 0);
    assert.equal(await page.evaluate(() => coverTest.stats().sources), 1);
    await page.evaluate(() => constructed.remove()); await page.waitForFunction(() => ledger.snapshot().resources === 0);
    assert.equal(await page.evaluate(() => constructed.getAttribute('src')), null);
    await page.close(); return { mounted: true, releasedOnDetach: true };
  });
  await check('sixty data raster assignments drain within the page decoder limit and retire every lease', async () => {
    const page = await pageFor();
    const initial = await page.evaluate(() => {
      window.rasterCovers = Array.from({ length: 60 }, () => {
        const image = document.createElement('img'); document.body.append(image); coverTest.applyCoverImg(image, pngUrl); return image;
      });
      return coverTest.stats();
    });
    assert.equal(initial.preparations, 1); assert.equal(initial.preparationQueue, 59);
    await page.waitForFunction(() => rasterCovers.every(image => image.naturalWidth === 4) && coverTest.stats().preparations === 0
      && coverTest.stats().preparationQueue === 0);
    const result = await page.evaluate(() => ({ loaded: rasterCovers.length, sources: coverTest.stats().sources, held: ledger.snapshot().held }));
    assert.equal(result.sources, 1); assert.equal(result.held.decoderLeases, 0);
    await page.evaluate(() => rasterCovers.forEach(image => image.remove())); await page.waitForFunction(() => ledger.snapshot().resources === 0);
    await page.close(); return { initial, result };
  });
  await check('old row image natural error cannot cancel a newer pending DBX cover assignment', async () => {
    const page = await pageFor({}, 'dbx');
    await page.evaluate(() => {
      window.errorRow = document.createElement('div'); errorRow.style.cssText = 'width:100px;height:100px';
      errorRow.innerHTML = '<div class="t-art"></div>'; document.body.append(errorRow);
      coverTest.paintArt(errorRow, 'data:image/png;base64,bm90IGEgcG5n');
      window.failedOldImage = errorRow.querySelector('img'); failedOldImage.style.cssText = 'width:100px;height:100px';
      failedOldImage.addEventListener('error', event => { window.oldImageNaturalError = event.isTrusted; }, { once: true });
      coverTest.paintArt(errorRow, 'https://remote.example/new-cover');
    });
    await page.waitForFunction(() => window.oldImageNaturalError === true);
    const waiting = await page.evaluate(() => ({ requests: calls.length, waiters: coverTest.stats().waiters,
      missing: errorRow.querySelector('.t-art').classList.contains('is-missing') }));
    assert.equal(waiting.requests, 1); assert.equal(waiting.waiters, 1); assert.equal(waiting.missing, false);
    await page.evaluate(() => calls[0].resolve({ data: pngUrl.split(',')[1], content_type: 'image/png' }));
    await page.waitForFunction(() => errorRow.querySelector('img')?.naturalWidth === 4 && coverTest.stats().waiters === 0);
    const result = await page.evaluate(() => ({ naturalError: oldImageNaturalError, cache: coverTest.stats().cache,
      displays: coverTest.stats().displays, sources: coverTest.stats().sources, width: errorRow.querySelector('img').naturalWidth }));
    assert.equal(result.cache, 1); assert.equal(result.displays, 1); assert.equal(result.sources, 1); assert.equal(result.width, 4);
    await page.evaluate(async () => { await coverTest.invalidate('url:https://remote.example/new-cover'); errorRow.remove(); });
    await page.waitForFunction(() => ledger.snapshot().resources === 0);
    await page.evaluate(() => {
      window.currentErrorRow = document.createElement('div'); currentErrorRow.innerHTML = '<div class="t-art"></div>'; document.body.append(currentErrorRow);
      coverTest.paintArt(currentErrorRow, 'data:image/png;base64,YW5vdGhlciBpbmNvcnJlY3QgcG5n');
    });
    await page.waitForFunction(() => currentErrorRow.querySelector('.t-art').classList.contains('is-missing') && ledger.snapshot().resources === 0);
    await page.close(); return { waiting, result, currentFailureStillClears: true };
  });
  report.passed = true;
}
main().catch(error => { report.error = error.stack; report.passed = false; console.error(error); process.exitCode = 1; })
  .finally(async () => { if (browser) await browser.close(); for (const socket of sockets) socket.destroy(); server.close();
    fs.writeFileSync(path.join(output, 'browser.json'), JSON.stringify(report, null, 2) + '\n'); });
