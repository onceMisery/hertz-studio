#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// 收藏与每日推荐的无头契约检查（零依赖、不触网）。
//
//   node scripts/check-favorites.js
//
// 与 check-online.js 同一套做法：只桩脚本真实用到的 DOM 方法，HTTP 全部走可
// 编排的假 transport，断言的是「在浏览器里最容易静默坏掉」的那几条：
//
//   收藏：
//     1. 红心开关走 toggle 端点，乐观更新，失败必须回滚（不能留假状态）
//     2. 批量判红一次问完一屏，且取消收藏后红心要灭
//     3. 列表按 kind 分页，counts 两个 tab 各自独立
//     4. 点行：本地曲目进播放队列，电台走在线链路
//
//   每日推荐：
//     1. 取数走 /v1/recommend/daily，卡片数 = 返回条数
//     2. 点第 N 张卡 = 整份当队列从第 N 首开始播（不是只播那一首）
//     3. 空结果给「曲库还没扫描」而不是笼统的「暂无推荐」
//     4. 静默预取失败不弹红

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'crates', 'vmusicd', 'web');

let failures = 0;
let checks = 0;
function ok(cond, label) {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.error('  X ' + label);
  }
}
function eq(a, b, label) { ok(a === b, label + ' (got ' + JSON.stringify(a) + ')'); }
function section(name) { console.log('\n' + name); }
async function ticks(n) {
  for (let i = 0; i < (n || 12); i++) await new Promise((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// 最小 DOM 桩
// ---------------------------------------------------------------------------

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle: (c, force) => {
      const want = force === undefined ? !set.has(c) : !!force;
      if (want) set.add(c); else set.delete(c);
      return want;
    },
    contains: (c) => set.has(c),
    _set: set,
  };
}

function makeEl(id) {
  const el = {
    id: id || '',
    tagName: 'DIV',
    hidden: false,
    className: '',
    textContent: '',
    dataset: {},
    style: { setProperty() {}, getPropertyValue() { return ''; } },
    attrs: {},
    children: [],
    parentNode: null,
    disabled: false,
    value: '',
    _html: '',
    _memo: {},
    classList: makeClassList(),
    onclick: null,
    _on: {},
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    append(...cs) { cs.forEach((c) => this.appendChild(c)); },
    insertBefore(c) { this.children.unshift(c); return c; },
    replaceChildren(...cs) {
      this.children = [];
      cs.forEach((c) => this.appendChild(c));
    },
    addEventListener(type, fn) { (this._on[type] = this._on[type] || []).push(fn); },
    removeEventListener() {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    focus() {},
    // 被测代码用 addEventListener('click') 绑行点击，桩需要一个派发口。
    _click(ev) {
      const e = ev || { stopPropagation() {}, preventDefault() {}, target: this };
      (this._on.click || []).forEach((fn) => fn(e));
      if (typeof this.onclick === 'function') this.onclick(e);
    },
    querySelector(sel) {
      if (!this._memo[sel]) this._memo[sel] = makeEl('qs:' + sel);
      return this._memo[sel];
    },
    querySelectorAll() { return []; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = String(v); this.children = []; },
  });
  return el;
}

function makeDocument() {
  const registry = {};
  return {
    getElementById(id) {
      if (!registry[id]) registry[id] = makeEl(id);
      return registry[id];
    },
    createElement() { return makeEl(); },
    createTextNode(t) { return { text: String(t) }; },
    addEventListener() {},
    dispatchEvent() { return true; },
  };
}

function makeClock() {
  let now = 0;
  return {
    setTimeout(fn) { fn(); return 1; },
    clearTimeout() {},
    now: () => now,
  };
}

// ---------------------------------------------------------------------------
// 假 transport：按路径编排响应，记录每一次调用
// ---------------------------------------------------------------------------

function makeTransport(routes) {
  const calls = [];
  return {
    calls,
    last(pathPart) {
      for (let i = calls.length - 1; i >= 0; i -= 1) {
        if (calls[i].path.indexOf(pathPart) >= 0) return calls[i];
      }
      return null;
    },
    async get(path) {
      calls.push({ method: 'GET', path });
      for (const r of routes) {
        if (r.match(path)) {
          if (r.throw) throw Object.assign(new Error(r.throw), { message: r.throw });
          // reply 允许是函数，好按请求路径编排不同响应。
          return typeof r.reply === 'function' ? r.reply(path) : r.reply;
        }
      }
      throw new Error('unexpected GET ' + path);
    },
    async post(path, body) {
      calls.push({ method: 'POST', path, body });
      for (const r of routes) {
        if (r.match(path)) {
          if (r.throw) throw Object.assign(new Error(r.throw), { message: r.throw });
          return typeof r.reply === 'function' ? r.reply(body) : r.reply;
        }
      }
      throw new Error('unexpected POST ' + path);
    },
  };
}

// ---------------------------------------------------------------------------
// 沙箱
// ---------------------------------------------------------------------------

function makeSandbox(transport) {
  const clock = makeClock();
  const doc = makeDocument();
  const spies = { toasts: [], played: [], radio: [] };
  const sandbox = {
    console,
    Promise, Object, Array, JSON, Math, String, Number, Set, Map,
    URL, URLSearchParams, encodeURIComponent,
    setTimeout: clock.setTimeout.bind(clock),
    clearTimeout: clock.clearTimeout.bind(clock),
    requestAnimationFrame: (fn) => fn(),
  };
  sandbox.window = sandbox;
  sandbox.document = doc;
  sandbox.VMusicTransport = transport;
  sandbox.window.VMusicTransport = transport;
  vm.createContext(sandbox);

  function load(file) {
    const src = fs.readFileSync(path.join(WEB, file), 'utf8');
    vm.runInContext(src, sandbox, { filename: file });
  }
  load('favorites.js');
  load('daily.js');

  const ui = {
    favList: doc.getElementById('fav-list'),
    favCount: doc.getElementById('fav-count'),
    favTabs: doc.getElementById('fav-tabs'),
    favPlayAll: doc.getElementById('fav-play-all'),
    favRefresh: doc.getElementById('fav-refresh'),
    favBadge: doc.getElementById('fav-badge'),
    dailyList: doc.getElementById('daily-list'),
    dailyDate: doc.getElementById('daily-date'),
    dailySub: doc.getElementById('daily-sub'),
    dailyPlayAll: doc.getElementById('daily-play-all'),
    dailyRefresh: doc.getElementById('daily-refresh'),
  };
  const host = {
    ui,
    state: { view: 'favorites' },
    fmt: (ms) => String(Math.round((ms || 0) / 1000)),
    toast: (msg, kind) => spies.toasts.push({ msg, kind }),
    errText: (prefix, err) => prefix + '：' + err.message,
    paintArt: () => {},
    coverUrl: (id) => '/cover/' + id,
    playLocal: (id, queue) => spies.played.push({ id: id, queue: queue }),
    playOnline: (f) => spies.radio.push(f),
    onFavoriteChanged: () => {},
  };
  sandbox.window.Favorites.bind(host);
  sandbox.window.Daily.bind(host);
  return { sandbox, spies, ui, doc };
}

// ---------------------------------------------------------------------------
// 收藏
// ---------------------------------------------------------------------------

async function checkFavorites() {
  section('收藏：列表与分页');

  const t = makeTransport([
    {
      match: (p) => p.indexOf('/v1/favorites?') === 0,
      reply: () => ({
        favorites: [
          { id: 'track:local:a', kind: 'track', source: 'local', ref_id: 'a', title: 'A', artist: 'X', duration_ms: 1000 },
          { id: 'radio:netease:r1', kind: 'radio', source: 'netease', ref_id: 'r1', title: '电台一', artist: null },
        ],
        total: 2,
        counts: { track: 1, radio: 7 },
      }),
    },
  ]);
  const { sandbox, ui, spies } = makeSandbox(t);
  const F = sandbox.window.Favorites;
  F.init();
  await F.load();
  await ticks();

  eq(t.last('/v1/favorites?kind=track').path.indexOf('kind=track') > 0, true, '默认 tab 是歌曲');
  eq(ui.favList.children.length, 2, '两条收藏都渲染出来');
  eq(ui.favCount.textContent, '1 首', '计数只统计歌曲');
  ok(spies.toasts.length === 0, '正常加载不该弹 toast');

  // 切到电台 tab
  F.state.kind = 'radio';
  await F.load();
  await ticks();
  ok(t.last('/v1/favorites?kind=radio') !== null, '切 tab 后按 kind 重新请求');

  section('收藏：红心开关');
  const t2 = makeTransport([
    {
      match: (p) => p.indexOf('/v1/favorites/toggle') === 0,
      reply: (body) => ({ favorited: true, id: 'track:local:' + body.ref_id, favorite: { id: 'x' } }),
    },
    { match: (p) => p.indexOf('/v1/favorites?') === 0, reply: { favorites: [], total: 0, counts: { track: 0, radio: 0 } } },
  ]);
  const s2 = makeSandbox(t2);
  const F2 = s2.sandbox.window.Favorites;
  F2.init();

  const actions = makeEl();
  const btn = F2.attachHeart(actions, { kind: 'track', source: 'local', ref_id: 'a', title: 'A' });
  eq(btn.classList.contains('is-on'), false, '初始未收藏，红心是空心的');
  eq(F2.has('track', 'local', 'a'), false, '集合里还没有它');

  await F2.toggle({ kind: 'track', source: 'local', ref_id: 'a', title: 'A' });
  await ticks();
  eq(F2.has('track', 'local', 'a'), true, '收藏后进入已收藏集合');
  eq(t2.last('/v1/favorites/toggle').body.ref_id, 'a', 'toggle 带 ref_id');
  eq(t2.last('/v1/favorites/toggle').body.source, 'local', 'toggle 带 source');
  eq(t2.last('/v1/favorites/toggle').body.kind, 'track', 'toggle 带 kind');

  section('收藏：失败必须回滚');
  const t3 = makeTransport([
    { match: (p) => p.indexOf('/v1/favorites/toggle') === 0, throw: '服务端炸了' },
  ]);
  const s3 = makeSandbox(t3);
  const F3 = s3.sandbox.window.Favorites;
  F3.init();
  await F3.toggle({ kind: 'track', source: 'local', ref_id: 'b', title: 'B' });
  await ticks();
  eq(F3.has('track', 'local', 'b'), false, '失败后不能留在已收藏状态');
  ok(s3.spies.toasts.some((x) => x.kind === 'error'), '失败要如实报错');

  section('收藏：批量判红');
  const t4 = makeTransport([
    {
      match: (p) => p.indexOf('/v1/favorites/membership') === 0,
      reply: (body) => ({ ids: body.ids.filter((x) => x === 'a') }),
    },
  ]);
  const s4 = makeSandbox(t4);
  const F4 = s4.sandbox.window.Favorites;
  F4.init();
  const hit = await F4.syncMembership('track', 'local', ['a', 'b', 'c']);
  eq(hit.size, 1, '只命中已收藏的那一条');
  eq(F4.has('track', 'local', 'a'), true, '命中的进集合');
  eq(F4.has('track', 'local', 'b'), false, '没命中的不在集合');

  // 取消收藏后，下一次判红要把它摘掉
  const t5 = makeTransport([
    { match: (p) => p.indexOf('/v1/favorites/membership') === 0, reply: { ids: [] } },
  ]);
  const s5 = makeSandbox(t5);
  const F5 = s5.sandbox.window.Favorites;
  F5.init();
  F5.state.owned.add('track:local:a');
  await F5.syncMembership('track', 'local', ['a']);
  eq(F5.has('track', 'local', 'a'), false, '取消收藏后红心必须灭');

  section('收藏：点行的去向');
  const t6 = makeTransport([
    {
      match: (p) => p.indexOf('/v1/favorites?') === 0,
      reply: {
        favorites: [
          { id: 'track:local:a', kind: 'track', source: 'local', ref_id: 'a', title: 'A' },
          { id: 'radio:netease:r1', kind: 'radio', source: 'netease', ref_id: 'r1', title: '电台一' },
        ],
        total: 2,
        counts: { track: 1, radio: 1 },
      },
    },
  ]);
  const s6 = makeSandbox(t6);
  const F6 = s6.sandbox.window.Favorites;
  F6.init();
  await F6.load();
  await ticks();
  const rows = s6.ui.favList.children;
  rows[0]._click();
  await ticks();
  eq(s6.spies.played.length, 1, '本地收藏曲目点行即播放');
  eq(s6.spies.played[0].id, 'a', '播放的是该行的曲目 id');
  eq(s6.spies.radio.length, 0, '歌曲不该走电台链路');

  section('收藏：播放本地收藏');
  s6.ui.favPlayAll.onclick();
  eq(s6.spies.played.length, 2, '「播放本地收藏」再入队一次');
  const lastPlay = s6.spies.played[s6.spies.played.length - 1];
  eq(Array.isArray(lastPlay.queue), true, '整批作为队列而不是单曲');
}

// ---------------------------------------------------------------------------
// 每日推荐
// ---------------------------------------------------------------------------

async function checkDaily() {
  section('每日推荐：取数与渲染');

  const page = {
    date: '2026-09-22',
    day: 20718,
    limit: 12,
    total: 3,
    candidates: 40,
    tracks: [
      { track: { id: 't1', title: '一', artist: 'A', has_cover: true }, score: 18, reasons: ['你收藏过'] },
      { track: { id: 't2', title: '二', artist: 'B', has_cover: false }, score: 12, reasons: ['有封面'] },
      { track: { id: 't3', title: '三', artist: 'C', has_cover: false }, score: 6, reasons: [] },
    ],
  };
  const t = makeTransport([
    { match: (p) => p.indexOf('/v1/recommend/daily') === 0, reply: page },
  ]);
  const { sandbox, ui, spies } = makeSandbox(t);
  const D = sandbox.window.Daily;
  D.init();
  await D.load();
  await ticks();

  ok(t.last('/v1/recommend/daily') !== null, '走了 /v1/recommend/daily');
  eq(ui.dailyList.children.length, 3, '三张卡片都渲染');
  eq(ui.dailyDate.textContent, '2026-09-22', '显示服务端给的日期');
  eq(ui.dailyPlayAll.disabled, false, '有结果时「播放全部」可用');
  ok(ui.dailySub.textContent.indexOf('3') >= 0, '副标题带条数');

  section('每日推荐：点第 N 张 = 整份从第 N 首开始');
  ui.dailyList.children[1].onclick();
  await ticks();
  eq(spies.played.length, 1, '点击触发一次播放');
  eq(spies.played[0].id, 't2', '从被点的那首开始');
  eq(spies.played[0].queue.length, 3, '整份推荐进队列，而不是只播一首');
  eq(spies.played[0].queue[0], 't1', '队列顺序就是推荐顺序');

  ui.dailyPlayAll.onclick();
  eq(spies.played[spies.played.length - 1].id, 't1', '「播放全部」从头开始');

  section('每日推荐：空结果与静默失败');
  const t2 = makeTransport([
    { match: (p) => p.indexOf('/v1/recommend/daily') === 0, reply: { date: '2026-09-22', day: 20718, limit: 12, total: 0, candidates: 0, tracks: [] } },
  ]);
  const s2 = makeSandbox(t2);
  s2.sandbox.window.Daily.init();
  await s2.sandbox.window.Daily.load();
  await ticks();
  eq(s2.ui.dailyPlayAll.disabled, true, '空结果时「播放全部」禁用');
  ok(s2.ui.dailyList.innerHTML.indexOf('曲库') >= 0, '空结果提示去扫描曲库');

  const t3 = makeTransport([
    { match: (p) => p.indexOf('/v1/recommend/daily') === 0, throw: '网络断了' },
  ]);
  const s3 = makeSandbox(t3);
  s3.sandbox.window.Daily.init();
  await s3.sandbox.window.Daily.load({ silent: true });
  await ticks();
  eq(s3.spies.toasts.length, 0, '静默预取失败不弹红');
  await s3.sandbox.window.Daily.load();
  await ticks();
  eq(s3.spies.toasts.length, 1, '用户手动刷新失败要如实报错');
}

// ---------------------------------------------------------------------------

(async function main() {
  await checkFavorites();
  await checkDaily();

  console.log('\n' + '─'.repeat(60));
  if (failures) {
    console.error(`收藏与每日推荐契约检查：${checks} 项，${failures} 项失败`);
    process.exit(1);
  }
  console.log(`收藏与每日推荐契约检查：${checks}/${checks} 全部通过`);
})();
