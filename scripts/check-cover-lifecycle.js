// SPDX-License-Identifier: MIT
// Real cover assignment functions: delayed proxy/decode results may only commit
// to the element that still requests that image. No network or browser needed.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../plugin/ui/app.js'), 'utf8');
const begin = source.indexOf('const coverAssignments =');
const end = source.indexOf('window.HertzCovers =', begin);
assert(begin >= 0 && end > begin);
const pending = new Map();
const decoders = [];
const context = {
  WeakMap,
  Image: class {
    decode() { return new Promise((resolve, reject) => { decoders.push({ url: this.src, resolve, reject }); }); }
  },
  remoteCover(url) { return url.startsWith('proxy:') ? null : url; },
  resolveCover(url) {
    return new Promise((resolve) => pending.set(url, (value) => { pending.delete(url); resolve(value); }));
  },
  remoteCoverSlot() { throw new Error('one-shot assignments must not retain subscriptions'); },
};
vm.createContext(context);
vm.runInContext(source.slice(begin, end), context);
const tick = () => new Promise((resolve) => setImmediate(resolve));
function el() { return { style: { backgroundImage: 'old' }, src: 'old', removeAttribute() { this.src = ''; } }; }

(async () => {
  const image = el();
  context.applyCoverImg(image, 'proxy:A');
  const oldResponse = pending.get('proxy:A');
  context.applyCoverImg(image, 'proxy:B');
  pending.get('proxy:B')('data:B');
  await tick();
  assert.equal(image.src, 'old', 'keep existing cover until replacement decodes');
  decoders.find((d) => d.url === 'data:B').resolve();
  await tick();
  assert.equal(image.src, 'data:B');
  oldResponse('data:A');
  await tick();
  assert.equal(image.src, 'data:B', 'late proxy cannot replace current image');
  assert(!pending.has('proxy:B'), 'completed proxy released');

  context.applyCoverImg(image, 'proxy:failed');
  pending.get('proxy:failed')(null);
  await tick();
  assert.equal(image.src, '', 'failed proxy clears previous track cover');
  assert(!pending.has('proxy:failed'));

  const bg = el();
  context.applyCoverBg(bg, 'https://A');
  context.applyCoverBg(bg, 'https://B');
  decoders.find((d) => d.url === 'https://B').resolve();
  await tick();
  decoders.find((d) => d.url === 'https://A').resolve();
  await tick();
  assert.equal(bg.style.backgroundImage, 'url("https://B")', 'decode order cannot override selection');
  context.applyCoverBg(bg, 'https://C');
  context.applyCoverBg(bg, null);
  decoders.find((d) => d.url === 'https://C').resolve();
  await tick();
  assert.equal(bg.style.backgroundImage, '', 'clear invalidates decoding image');
  context.applyCoverImg(image, 'https://broken');
  decoders.find((d) => d.url === 'https://broken').reject(new Error('invalid image'));
  await tick();
  assert.equal(image.src, '', 'invalid current image clears stale content');
  context.applyCoverImg(null, 'https://unused');
  console.log('Cover lifecycle: proxy/decode races, clear, completion and failure passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
