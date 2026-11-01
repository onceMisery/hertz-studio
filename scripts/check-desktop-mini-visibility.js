// SPDX-License-Identifier: MIT
// Run the actual main-surface reporter against a deterministic document and transport.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../plugin/ui/app.js'), 'utf8');
const start = source.indexOf('function initMainVisibility() {');
const end = source.indexOf('\nasync function startApp()', start);
assert.ok(start >= 0 && end > start, 'visibility initialization remains independently executable');
assert.match(source.slice(end), /transport = await chooseTransport\(\);\s*initMainVisibility\(\);/);

function harness({ hidden = false, capsule = false, kind = 'server', reject = false } = {}) {
  const posts = [], listeners = new Map(), observers = [];
  const title = {};
  const document = { hidden, title: 'hertz-studio',
    querySelector: selector => selector === 'title' ? title : null,
    addEventListener: (event, fn) => listeners.set(event, fn) };
  class MutationObserver {
    constructor(fn) { this.fn = fn; }
    observe(node, options) { observers.push({ node, options, fn: this.fn }); }
  }
  const context = { document, window: { HertzCapsuleOnly: capsule }, MutationObserver,
    transport: { kind, post: (url, body) => {
      posts.push({ url, ...body });
      return reject ? Promise.reject(new Error('offline')) : Promise.resolve();
    } } };
  vm.runInNewContext(source.slice(start, end) + '\ninitMainVisibility();', context);
  return { document, posts, listeners, observers, title };
}

(async () => {
  const visible = harness();
  assert.deepEqual(visible.posts, [{ url: '/v1/ui/notice', action: 'main-visibility', hidden: false, windowTitle: 'hertz-studio' }]);
  visible.document.hidden = true;
  visible.listeners.get('visibilitychange')();
  assert.equal(visible.posts.at(-1).hidden, true);
  assert.equal(visible.observers.length, 1);
  assert.equal(visible.observers[0].node, visible.title);
  assert.deepEqual({ ...visible.observers[0].options }, { childList: true, characterData: true, subtree: true });
  visible.document.title = '后台新曲 🎵 · hertz-studio';
  visible.observers[0].fn();
  assert.equal(visible.posts.at(-1).windowTitle, visible.document.title);
  assert.equal(visible.posts.at(-1).hidden, true, 'background title reports preserve hidden state');
  visible.document.hidden = false;
  visible.listeners.get('visibilitychange')();
  assert.equal(visible.posts.at(-1).hidden, false);
  assert.equal(harness({ hidden: true }).posts[0].hidden, true, 'startup reports even an initially hidden document');
  for (const options of [{ capsule: true }, { kind: 'dbx' }, { kind: 'demo' }]) {
    const skipped = harness(options);
    assert.equal(skipped.posts.length, 0);
    assert.equal(skipped.listeners.size, 0);
    assert.equal(skipped.observers.length, 0);
  }
  harness({ reject: true });
  await new Promise(resolve => setImmediate(resolve));
  console.log('desktop-mini main visibility reporting checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
