#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// 曲库空态卡（「曲库还是空的」）的显隐契约：
//
//   本地曲库为空 + 每日推荐来源「在线」  →  不显示
//   本地曲库为空 + 每日推荐来源「本地」  →  显示
//   本地曲库非空                        →  不显示（与来源无关）
//
// 以及两处接线：daily.js 切来源/初始化要回传给宿主，app.js 的宿主回调要接到
// syncLibEmpty 上。少任何一处，切来源时空态卡就纹丝不动。
//
// 这里用真实源码跑，不复制一份实现——复制出来的断言永远是对的，也永远没用。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');

const web = path.join(__dirname, '../plugin/ui');
const appSrc = fs.readFileSync(path.join(web, 'app.js'), 'utf8');
const dailySrc = fs.readFileSync(path.join(web, 'daily.js'), 'utf8');

function between(src, start, end) {
  const at = src.indexOf(start);
  const to = src.indexOf(end, at);
  assert.ok(at >= 0 && to > at, `missing source boundaries: ${start} .. ${end}`);
  return src.slice(at, to);
}

// ---------- 1. syncLibEmpty：把 app.js 里真实那一段拿出来跑 ----------

const emptyCard = { hidden: false };
const stripCard = { hidden: true };
const state = { tracks: [] };
const win = {};
const ctx = vm.createContext({
  state,
  ui: { libEmpty: emptyCard, libEmptyStrip: stripCard },
  window: win,
});
vm.runInContext(between(appSrc, 'function syncLibEmpty(', 'function renderLibrary('), ctx);
const syncLibEmpty = (list) => vm.runInContext('syncLibEmpty', ctx)(list);

// 在线来源：本地库为空也不该弹「曲库还是空的」——页面主体是在线推荐位，
// 它自己会把「没登录 / 这次没返回」写清楚。
win.Daily = { state: { mode: 'online' } };
syncLibEmpty();
assert.equal(emptyCard.hidden, true, 'online source hides the empty card on an empty library');
// 但列表区不能是无解释的白板：在线来源 + 空库要亮出轻空态条（可去填目录）。
assert.equal(stripCard.hidden, false, 'online source shows the empty strip on an empty library');

win.Daily.state.mode = 'local';
syncLibEmpty();
assert.equal(emptyCard.hidden, false, 'local source still explains an empty library');
assert.equal(stripCard.hidden, true, 'local source keeps the strip hidden (guide card is up)');

// 非空曲库：无论来源都不显示。
state.tracks = [{ id: 'a' }];
syncLibEmpty();
assert.equal(emptyCard.hidden, true, 'local source, library has tracks');
assert.equal(stripCard.hidden, true, 'strip hides once the library has tracks');
win.Daily.state.mode = 'online';
syncLibEmpty();
assert.equal(emptyCard.hidden, true, 'online source, library has tracks');
assert.equal(stripCard.hidden, true, 'strip stays hidden when the library has tracks');

// 显式传 list 时以传入的为准（renderLibrary 传的是本帧刚算出来的数组）。
win.Daily.state.mode = 'local';
syncLibEmpty([]);
assert.equal(emptyCard.hidden, false, 'explicit empty list keeps the card');
syncLibEmpty(state.tracks);
assert.equal(emptyCard.hidden, true, 'explicit non-empty list hides the card');

// Daily 模块没加载（脚本顺序、加载失败）时退化为纯条数判据，不能因此报错。
delete win.Daily;
syncLibEmpty([]);
assert.equal(emptyCard.hidden, false, 'without Daily: empty library keeps the card');
assert.equal(stripCard.hidden, true, 'without Daily: strip stays hidden (guide card is up)');
syncLibEmpty(state.tracks);
assert.equal(emptyCard.hidden, true, 'without Daily: non-empty library hides the card');

// DOM 里没有这张卡（老页面/裁剪过的 DOM）时是空操作，不是崩。
vm.runInContext('ui.libEmpty = null; syncLibEmpty();', ctx);
assert.equal(emptyCard.hidden, true, 'missing node is a no-op, not a crash');
vm.runInContext('ui.libEmpty = __card;', Object.assign(ctx, { __card: emptyCard }));
win.Daily = { state: { mode: 'online' } };
// 条节点缺失同理：不能因为找不到 #lib-empty-strip 就崩掉整个空态判定。
vm.runInContext('ui.libEmptyStrip = null; syncLibEmpty([]);', ctx);
assert.equal(emptyCard.hidden, true, 'missing strip node is a no-op, not a crash');
vm.runInContext('ui.libEmptyStrip = __strip;', Object.assign(ctx, { __strip: stripCard }));

// 返回值给 renderLibrary 用：它还要靠这个布尔决定列头去留。
assert.equal(syncLibEmpty([]), true, 'returns hidden=true for online source on empty library');
win.Daily.state.mode = 'local';
assert.equal(syncLibEmpty([]), false, 'returns hidden=false for local source on empty library');
assert.equal(syncLibEmpty(state.tracks), true, 'returns hidden=true whenever tracks exist');

// ---------- 2. daily.js：切来源与初始化都要回传 ----------

const host = {
  ui: { dailyModes: { querySelectorAll: () => [] } },
  calls: [],
  onDailyModeChange(mode) { this.calls.push(mode); },
};
const dailyCtx = vm.createContext({
  window: {},
  localStorage: { getItem: () => null, setItem() {} },
  document: {},
});
vm.runInContext(dailySrc, dailyCtx);
const Daily = dailyCtx.window.Daily;
assert.ok(Daily && typeof Daily.setMode === 'function', 'daily.js exports Daily.setMode');

Daily.bind(host);
Daily.init();
assert.deepEqual(host.calls, ['online'], 'init() reports the restored source');

Daily.setMode('local');
assert.deepEqual(host.calls, ['online', 'local'], 'setMode reports the new source');
Daily.setMode('online');
assert.equal(host.calls[host.calls.length - 1], 'online', 'switching back reports online');

// 宿主没给回调（别的嵌入方）时不能炸。
Daily.bind({ ui: { dailyModes: { querySelectorAll: () => [] } } });
Daily.setMode('local');

// ---------- 3. app.js 的接线 ----------

assert.ok(/onDailyModeChange:\s*\(\)\s*=>\s*syncLibEmpty\(\)/.test(appSrc),
  'app.js host must route onDailyModeChange to syncLibEmpty');
assert.ok(/function renderLibrary\(\)[\s\S]{0,400}?syncLibEmpty\(list\)/.test(appSrc),
  'renderLibrary must drive the empty card through syncLibEmpty');
// 只留这一处写 hidden：再有第二处就是两条真值互相覆盖的老问题。
const writes = appSrc.match(/libEmpty\.hidden\s*=/g) || [];
assert.equal(writes.length, 1, 'exactly one place decides libEmpty.hidden');
// 列头不能比空态卡活得更久：没有曲目又不显示引导卡时，孤零零一行列头像列表坏了。
assert.ok(/ui\.libHint\.hidden = list\.length === 0 && emptyHidden/.test(appSrc),
  'column header follows the empty card instead of outliving it');

console.log('Library empty-card visibility checks passed');
