// SPDX-License-Identifier: MIT
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const context = vm.createContext({ window: {}, crypto });
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../crates/hertz-desktop/assets/wallpaper-playlist-editor.js'), 'utf8'), context);
const copy = value => JSON.parse(JSON.stringify(value));
const item = index => ({ workKey: 'work-' + index, packageHash: index.toString(16).padStart(64, '0') });
const fixed = ({ workKey, packageHash }) => ({ workKey, packageHash });
const checks = [];
(async () => {
  let saved, writes = [], maxBytes = 0;
  const request = async (command, payload) => {
    if (command === 'wallpaper.playlist.page') {
      assert.equal(payload.playlistId, saved.playlistId);
      const end = Math.min(payload.offset + payload.limit, saved.items.length);
      return { ...copy(saved), items: copy(saved.items.slice(payload.offset, end)), itemCount: saved.items.length, offset: payload.offset, nextOffset: end < saved.items.length ? end : null };
    }
    assert.equal(command, 'wallpaper.playlist.update');
    assert.equal(payload.expectedPlaylistRevision, saved?.revision || 0);
    assert.ok(payload.operations.length <= 32);
    maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify({ protocol: 2, requestId: crypto.randomUUID(), command, payload })));
    const items = saved ? copy(saved.items) : [];
    payload.operations.forEach(edit => {
      if (edit.kind === 'insert') { assert.ok(edit.index >= 0 && edit.index <= items.length); items.splice(edit.index, 0, copy(edit.item)); }
      else if (edit.kind === 'remove') { assert.ok(edit.index >= 0 && edit.index < items.length); items.splice(edit.index, 1); }
      else { assert.ok(edit.from >= 0 && edit.from < items.length && edit.to >= 0 && edit.to < items.length); items.splice(edit.to, 0, items.splice(edit.from, 1)[0]); }
      assert.ok(items.length <= 1000);
    });
    assert.ok(items.length > 0);
    saved = { playlistId: payload.playlistId, revision: payload.expectedPlaylistRevision + 1, title: payload.title, mode: payload.mode, intervalSeconds: payload.intervalSeconds, items };
    writes.push(copy(payload));
    const { items: _, ...result } = saved; return { ...result, itemCount: items.length };
  };
  const editor = context.window.hertzPlaylistEditor(request, () => {});
  for (let i = 0; i < 1000; i++) editor.add(item(i));
  await editor.save(); assert.equal(saved.items.length, 1000); assert.equal(writes.length, 32);
  assert.ok(maxBytes < 16384); assert.equal(editor.state.dirty, false);
  checks.push('1000 items created in 32 bounded CAS batches');
  writes = []; editor.move(editor.state.items[0].key, 999); await editor.save();
  assert.equal(writes.length, 1); assert.equal(writes[0].operations.length, 1); assert.equal(saved.items[999].workKey, 'work-0');
  checks.push('long distance move sends one operation');
  for (const value of [...editor.state.items]) editor.remove(value.key);
  for (let i = 0; i < 1000; i++) editor.add(item(1000 + i));
  await editor.save(); assert.deepEqual(saved.items, Array.from({ length: 1000 }, (_, i) => item(1000 + i)));
  checks.push('complete replacement at capacity keeps every committed batch nonempty and <=1000');
  let seed = 173;
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let round = 0; round < 30; round++) {
    for (let i = 0; i < 25; i++) {
      const index = random(editor.state.items.length), choice = random(3);
      if (choice === 0 && editor.state.items.length > 1) editor.remove(editor.state.items[index].key);
      else if (choice === 1 && editor.state.items.length < 1000) editor.add(item(random(1500)));
      else editor.move(editor.state.items[index].key, random(editor.state.items.length));
    }
    const expected = copy(editor.state.items.map(fixed)); await editor.save(); assert.deepEqual(saved.items, expected);
  }
  checks.push('mixed duplicate entries, inserts, removals and moves survive repeated bounded saves');
  editor.change({ title: '元数据更新', mode: 'random', intervalSeconds: 86400 }); const before = saved.items;
  await editor.save(); assert.equal(saved.title, '元数据更新'); assert.deepEqual(saved.items, before);
  const restored = context.window.hertzPlaylistEditor(request, () => {}); await restored.load(saved.playlistId);
  assert.deepEqual(copy(restored.state.items.map(fixed)), saved.items);
  checks.push('metadata-only saves and full revision-bound reload');
  console.log('PASS', checks.length, 'playlist editor scenarios; max request', maxBytes, 'bytes');
})().catch(error => { console.error(error); process.exitCode = 1; });
