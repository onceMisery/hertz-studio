// SPDX-License-Identifier: MIT
// Actual cover owner, source parser and ledger; controllable delayed operations.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { setup, root } = require('./cover-lifecycle-fixture');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZI0AAAAASUVORK5CYII=';
const data = 'data:image/png;base64,' + png;
const reply = { data: png, content_type: 'image/png' };
const tick = () => new Promise(resolve => setImmediate(resolve));
function element() { return { isConnected: true, style: { backgroundImage: 'old' }, src: 'old', removeAttribute() { this.src = ''; } }; }
function clean(h) {
  assert.equal(h.ledger.snapshot().resources, 0, 'all allocations and borrowed sources released');
  assert.equal(h.ledger.snapshot().listeners, 0, 'all waiting requests unsubscribed');
  assert.equal(h.timers.size, 0, 'watchdogs cleared');
}
async function run() {
  {
    const h = setup({ ownedCpuBytes: 256 });
    assert.equal(await h.api.ensureCover('refused'), null);
    assert.equal(h.calls.length, 0, 'response/request refusal occurs before DBX invocation');
    assert.equal(await h.api.probeImage('https://foreign/image'), false);
    assert.equal(h.images.length, 0, 'presentation refusal occurs before creating or assigning img');
    clean(h);
  }
  {
    const h = setup({ decoderLeases: 0 });
    assert.equal(await h.api.probeImage(data), false); await tick();
    assert.equal(h.images.length, 0, 'raster byte/lease refusal occurs before Image/src'); clean(h);
  }
  {
    const h = setup();
    assert.equal(h.api.dbxCoverUrl('track'), null, 'cold URL remains synchronous null');
    const pending = h.api.ensureCover('track');
    assert.equal(h.calls.length, 1, 'same-key requests share the original pending operation');
    assert.equal(h.calls[0].options.waitForSettlement, true); assert.equal(h.calls[0].options.retry, false);
    assert(h.ledger.snapshot().pending.ownedCpuBytes >= 8 * 1024 * 1024 * 4, 'response reserved before it exists');
    h.calls[0].resolve(reply); assert.equal(await pending, data); await tick();
    assert.equal(h.api.dbxCoverUrl('track'), data, 'cache URL remains synchronously available');
    assert.equal(h.ledger.snapshot().resources, 1, 'only retained source survives response settlement');
    const sourceBytes = h.ledger.snapshot().held.ownedCpuBytes;
    const image = element(); h.api.applyCoverImg(image, data); await tick();
    assert.equal(h.ledger.snapshot().held.ownedCpuBytes, sourceBytes + 512 + 128 * 3, 'decode borrows cached bytes; only operation and three lease identities are additional');
    assert.equal(h.images.length, 1); h.images[0].resolveDecode(); await tick(); assert.equal(image.src, data);
    await h.api.invalidate('track'); assert.equal(h.api.stats().cache, 0);
    assert.equal(h.api.stats().sources, 1, 'evicted source lives while displayed borrower uses it');
    image.isConnected = false; h.mutate(); await tick(); clean(h);
  }
  {
    const h = setup(); const old = h.api.ensureCover('race');
    await h.api.invalidate('race'); assert.equal(await old, null, 'invalidate resolves callers promptly');
    assert.equal(h.api.stats().requests, 1, 'uncancelable bridge stays owned until settlement');
    const replacement = h.api.ensureCover('race'); assert.equal(h.calls.length, 2);
    h.calls[0].resolve(reply); await tick();
    assert.equal(h.api.stats().pending, 1, 'old finally cannot remove current pending request');
    assert.equal(h.api.stats().cache, 0, 'late invalidated reply cannot resurrect old cover');
    h.calls[1].resolve(reply); assert.equal(await replacement, data); await tick();
    assert.equal(h.api.dbxCoverUrl('race'), data); h.close(); await tick(); clean(h);
  }
  {
    const h = setup(); const image = element();
    h.api.applyCoverImg(image, 'https://old'); h.api.applyCoverImg(image, 'https://new');
    assert.equal(h.calls.length, 2); h.calls[1].resolve(reply); await tick();
    assert.equal(image.src, 'old', 'old presentation remains until replacement decodes');
    h.images[0].resolveDecode(); await tick(); assert.equal(image.src, data);
    h.calls[0].resolve(reply); await tick(); assert.equal(h.images.length, 1, 'stale proxy result cannot start decoder');
    h.api.applyCoverImg(image, 'https://failed'); h.calls[2].reject(new Error('no cover')); await tick();
    assert.equal(image.src, '', 'failed current replacement clears previous track artwork');
    h.close(); await tick(); clean(h);
  }
  {
    const h = setup({ decoderLeases: 1 }); const first = h.api.prepareCoverImage(data); await tick();
    const held = h.ledger.snapshot().held.decodeReservedBytes;
    first.cancel(); assert.equal(await first.promise, false); await tick();
    assert.equal(h.ledger.snapshot().held.decodeReservedBytes, held, 'abort does not refund unsettled decoder');
    assert.equal(h.api.stats().preparations, 1);
    const waiting = h.api.prepareCoverImage(data); await tick();
    assert.equal(h.api.stats().preparationQueue, 1, 'later data preparation waits for the unsettled original decode');
    assert.equal(h.images.length, 1, 'replacement cannot exceed outstanding decoder lease');
    waiting.cancel(); assert.equal(await waiting.promise, false);
    h.images[0].rejectDecode(new Error('settled cancellation')); await tick(); clean(h);
    const success = h.api.probeImage(data); await tick(); h.images[1].resolveDecode();
    assert.equal(await success, true); await tick(); clean(h);
  }
  {
    const h = setup(); h.box.transport.kind = 'server';
    assert.equal(h.api.remoteCover('https://foreign/image'), 'https://foreign/image');
    assert.equal(await h.api.resolveCover('https://foreign/image'), 'https://foreign/image');
    const image = element(); h.api.applyCoverBg(image, 'https://A');
    const a = h.images[0]; h.api.applyCoverBg(image, 'https://B');
    assert.equal(a.src, '', 'replacement removes stale native presentation request');
    assert.equal(a.onload, null); assert.equal(a.onerror, null);
    const b = h.images[1]; assert.equal(b.crossOrigin, undefined, 'HTTP display has no new CORS requirement');
    b.onload(); await tick(); assert.equal(image.style.backgroundImage, 'url("https://B")');
    assert.equal(h.ledger.snapshot().held.decodeReservedBytes, 0, 'DOM presentation does not invent pixel estimates');
    const probe = h.api.probeImage('https://stalled'); h.expire(); assert.equal(await probe, false); await tick();
    assert.equal(h.images[2].src, ''); clean(h);
  }
  {
    const h = setup(); const promises = [];
    for (let i = 0; i < 350; i++) promises.push(h.api.ensureCover('pending-' + i));
    assert.equal(h.api.stats().requests, 200, 'request state bounded independently of unique track count');
    assert.equal(h.calls.length, 3, 'response peaks compete in single page budget');
    h.expire(); await Promise.all(promises); await tick();
    assert.equal(h.api.stats().requests, 3, 'timeouts retire waiting state, retain unsettled bridge reservations');
    for (const call of h.calls) call.resolve(reply);
    await tick(); clean(h); assert.equal(h.api.stats().cache, 0, 'timed-out replies cannot refill cache');
  }
  {
    const h = setup(); let delivered = 0; const pending = h.api.ensureCover('slots');
    for (let i = 0; i < 300; i++) h.api.coverSlot('slots', () => delivered++);
    assert.equal(h.api.stats().slots, 200);
    h.calls[0].reject(new Error('unavailable')); assert.equal(await pending, null); await tick();
    assert.equal(delivered, 200); assert.equal(h.api.stats().slots, 0); clean(h);
  }
  {
    const h = setup(); let borrowed;
    for (let i = 0; i < 205; i++) {
      const pending = h.api.ensureCover('lru-' + i); h.calls[i].resolve(reply); await pending;
      if (!i) borrowed = await h.api.resolveCover.borrow(data, h.ledger.port('test-consumer'));
    }
    await tick();
    assert.equal(h.api.stats().cache, 200, 'existing 200-entry cap remains in force');
    assert.equal(h.api.stats().sources, 201, 'evicted borrowed source remains charged beside cache');
    borrowed.release(); assert.equal(h.api.stats().sources, 200);
    h.close(); await tick(); clean(h);
  }
  {
    const h = setup(); h.box.transport.kind = 'server'; const pending = [];
    for (let i = 0; i < 350; i++) pending.push(h.api.probeImage('https://stalled/' + i));
    assert.equal(h.images.length, 32, 'native presentation probes have a finite concurrent owner bound');
    assert.equal(h.api.stats().preparationQueue, 200, 'waiting preparations retain a finite owner bound');
    h.expire(); await Promise.all(pending); await tick(); clean(h);
    assert(h.images.every(image => !image.src && image.onload === null && image.onerror === null));
  }
  {
    const h = setup();
    vm.runInContext(fs.readFileSync(path.join(root, 'plugin/ui/pl-covers.js'), 'utf8'), h.box);
    const instance = h.box.PlaylistCovers.init({ fetchTracks: async () => [{ id: 't', has_cover: true }], fetchCover: async () => data });
    instance.state('playlist'); await tick(); assert.equal(instance.state('playlist').url, data);
    assert.equal(h.api.stats().sources, 1, 'playlist adopts and retains uncached data URL');
    for (let i = 0; i < 205; i++) { instance.state('list-' + i); await tick(); }
    assert.equal(h.ledger.snapshot(true).entries.filter(e => e.owner === 'playlist-cover-state' && e.basis.source.startsWith('playlist')).length, 200);
    instance.invalidate(); await tick(); clean(h);
    const delayed = [];
    const pending = h.box.PlaylistCovers.init({ fetchTracks: () => new Promise(resolve => delayed.push(resolve)), fetchCover: async () => data });
    for (let i = 0; i < 240; i++) { pending.state('slow-' + i); pending.invalidate('slow-' + i); }
    assert.equal(delayed.length, 200, 'invalidating uncancelable playlist fetches does not create unbounded work');
    assert.equal(h.ledger.snapshot().resources, 200, 'retired playlist calls stay charged until real settlement');
    delayed.forEach(resolve => resolve([{ id: 'late', has_cover: true }])); await tick(); clean(h);
  }
  {
    const h = setup();
    const source = fs.readFileSync(path.join(root, 'plugin/ui/space3d.js'), 'utf8');
    h.box.document.readyState = 'loading'; h.box.document.addEventListener = () => {};
    vm.runInContext(source, h.box);
    const request = h.api.ensureCover('queue'); h.calls[0].resolve(reply); await request;
    h.box.Space3D.setQueue([{ id: 'q', cover: data }]); await h.api.invalidate('queue');
    assert.equal(h.api.stats().sources, 1, 'closed Space3D retains queue source for later reopening');
    h.box.Space3D.setQueue([]); await tick(); clean(h);
    const stage3d = fs.readFileSync(path.join(root, 'plugin/ui/stage3d.js'), 'utf8');
    const setQueue = stage3d.slice(stage3d.indexOf('  function setQueue(list)'), stage3d.indexOf('  function toggleLyrics()', stage3d.indexOf('  function setQueue(list)')));
    h.box.global = h.box;
    vm.runInContext('var queueData = [], queueCoverBorrows = [], queueOpen = false, shelf = null;\n' + setQueue + '\nthis.queueSetter = setQueue;', h.box);
    h.box.queueSetter([{ id: 'q', cover: data }]); assert.equal(h.api.stats().sources, 1);
    h.box.queueSetter([{ id: 'q', cover: data }]); assert.equal(h.api.stats().sources, 1, 'same queue handoff does not duplicate source');
    h.box.queueSetter([]); await tick(); clean(h);
  }
  {
    const h = setup(), image = element();
    for (let i = 0; i < 600; i++) h.api.applyCoverImg(image, 'https://same-unsettled');
    assert.equal(h.calls.length, 1); assert.equal(h.api.stats().waiters, 200, 'shared unresolved result cannot collect unlimited assignment closures');
    h.calls[0].resolve(reply); await tick();
    assert.equal(h.images.length, 0, 'all retired resolution callbacks stay inert');
    assert.equal(h.api.stats().waiters, 0); h.close(); await tick(); clean(h);
  }
  {
    const h = setup(); h.box.global = h.box;
    const source = fs.readFileSync(path.join(root, 'plugin/ui/stage-shelf.js'), 'utf8');
    const forget = source.slice(source.indexOf('    function forgetPreload('), source.indexOf('\n    }', source.indexOf('    function forgetPreload(')) + 6);
    const preload = source.slice(source.indexOf('    function preloadCover('), source.indexOf('    // ---- DOM', source.indexOf('    function preloadCover(')));
    vm.runInContext('var shelfCoverCache = new Map();\n' +
      '(function(){const coverCache = shelfCoverCache, coverBorrows = new Map(), COVER_CACHE_CAP = 2;\n' + forget +
      '\nfunction resolveCover(url, apply) { apply(url); }\n' + preload +
      '\nthis.preload = preloadCover; this.forgetPreloadTest = forgetPreload;}).call(this);', h.box);
    const pending = h.api.ensureCover('preload'); h.calls[0].resolve(reply); await pending;
    h.box.preload(data); await h.api.invalidate('preload');
    assert.equal(h.api.stats().sources, 1, 'original shelf preload cache holds its source key after queue/cache retirement');
    h.box.forgetPreloadTest(data); await tick(); clean(h);
  }
  {
    const h = setup(); h.box.transport.kind = 'server';
    const targets = Array.from({ length: 60 }, () => element());
    targets.forEach((target, index) => h.api.applyCoverImg(target, 'https://cover/' + index));
    assert.equal(h.images.length, 32); assert.equal(h.api.stats().preparationQueue, 28);
    h.api.applyCoverImg(targets[59], 'https://cover/latest');
    h.api.applyCoverImg(targets[58], null);
    targets[57].isConnected = false; h.mutate();
    for (let i = 0; i < h.images.length; i++) if (h.images[i].onload) h.images[i].onload();
    await tick();
    assert.equal(targets[59].src, 'https://cover/latest', 'latest queued selection reaches the element');
    assert.equal(targets[58].src, ''); assert.equal(targets[57].src, '');
    for (let i = 0; i < 57; i++) assert.equal(targets[i].src, 'https://cover/' + i);
    assert.equal(h.api.stats().preparationQueue, 0); clean(h);
  }
  {
    const h = setup(), target = element(); h.api.applyCoverImg(target, data); await tick();
    target.isConnected = false; h.mutate(); await tick();
    assert.equal(target.src, ''); assert.equal(h.api.stats().displays, 0);
    assert.equal(h.ledger.snapshot().held.decoderLeases, 1, 'detach revokes presentation without refunding unsettled decode');
    h.images[0].resolveDecode(); await tick();
    assert.equal(target.src, ''); clean(h);
  }
  console.log('Cover lifecycle: 17 groups passed (admission, source borrow, stale replies, true settlement, bounded waiting/cache/probes, playlist/queue/preload ownership, detach authority and URL semantics)');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
