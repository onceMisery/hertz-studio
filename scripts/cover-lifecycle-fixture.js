// SPDX-License-Identifier: MIT
// Load the original cover owner and resource helpers without unrelated app boot.
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'plugin/ui/app.js'), 'utf8');
const owner = app.slice(app.indexOf('const COVER_CACHE_MAX ='), app.indexOf('const REQUEST_TIMEOUT'));
const probe = app.slice(app.indexOf('function probeImage('), app.indexOf('// ---------------------------------------------------------------------------', app.indexOf('function probeImage(')));
const paint = app.slice(app.indexOf('function clearRowCover('), app.indexOf('// ---------------------------------------------------------------------------', app.indexOf('function paintArt(')));
const exportsSource = `
let lastNowCoverBorrow = null, lastNowCover = null, mediaSessionCoverBorrow = null;
this.coverTest = { ensureCover, ensureRemoteCover, dbxCoverUrl, remoteCover, resolveCover,
  applyCoverImg, applyCoverBg, probeImage, prepareCoverImage, coverSlot, paintArt,
  invalidate: id => DbxTransport.invalidateCover(id),
  stats: () => ({ cache: coverCache.size, sources: coverSources.size, requests: coverRequests.size,
    pending: coverPending.size, preparations: coverPreparations.size, preparationQueue: coverPreparationQueue.size, waiters: coverResolutionWaiters.size,
    slots: coverSlotCount, displays: coverDisplayedSources.size }),
};`;
function setup(caps = {}) {
  const calls = [], images = [], timers = new Map(), events = new Map();
  let serial = 0, observer = null;
  class Image {
    constructor() { this.naturalWidth = this.naturalHeight = 1; this.src = ''; images.push(this); }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    decode() { return new Promise((resolve, reject) => { this.resolveDecode = resolve; this.rejectDecode = reject; }); }
  }
  const box = { console, AbortController, WeakRef, Image, URL, Blob,
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} disconnect() { observer = null; } },
    document: { documentElement: {}, createElement(name) { if (name !== 'img') throw Error(name); return new Image(); } },
    transport: { kind: 'dbx' },
    dbxRequest(path, options) { return new Promise((resolve, reject) => calls.push({ path, options, resolve, reject })); },
    addEventListener(name, fn) { const list = events.get(name) || []; list.push(fn); events.set(name, list); },
  };
  box.window = box; vm.createContext(box);
  for (const file of ['stage-resource-budget.js', 'stage-resource-policy.js', 'stage-image-source.js'])
    vm.runInContext(fs.readFileSync(path.join(root, 'plugin/ui', file), 'utf8'), box, { filename: file });
  const ledger = box.StageResourceBudget.create({ ...box.StageResourcePolicy, caps: { ...box.StageResourcePolicy.caps, ...caps } });
  box.Stage = { resources: () => ledger };
  vm.runInContext(owner + probe + paint + exportsSource, box, { filename: 'app.js:cover-owner' });
  return { box, api: box.coverTest, ledger, calls, images, timers,
    mutate() { if (observer) observer(); },
    expire() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); } },
    close() { (events.get('pagehide') || []).forEach(fn => fn({ persisted: false })); },
  };
}
module.exports = { root, owner, probe, paint, exportsSource, setup };
