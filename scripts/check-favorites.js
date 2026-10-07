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

const WEB = path.join(__dirname, '..', 'plugin', 'ui');

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
    appendChild(c) { return this.insertBefore(c, null); },
    append(...cs) { cs.forEach((c) => this.appendChild(c)); },
    insertBefore(c, ref) {
      if (c === ref) return c;
      if (c.parentNode) c.parentNode.children = c.parentNode.children.filter((item) => item !== c);
      const index = ref ? this.children.indexOf(ref) : this.children.length;
      this.children.splice(index, 0, c);
      c.parentNode = this;
      return c;
    },
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((item) => item !== this);
      this.parentNode = null;
    },
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

/// localStorage 桩。每日推荐要记住用户选的来源（在线/本地），没有它的话
/// writeMode 会静默吞掉（代码里有 try/catch），于是"选择被持久化"这件事
/// 根本测不到。
function makeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

/// 给容器挂一组"可按属性选择器查到"的按钮。
///
/// 桩没有真正的选择器引擎，而来源切换 / 歌单排布这类控件都是
/// `querySelectorAll('button[data-x]')` 拿的。只支持这一种形态：
/// 元素不参与布局，能读到属性、能派发 click，就够契约检查用了。
function attachButtons(host, attr, values) {
  const btns = values.map((v) => {
    const b = makeEl('btn:' + attr + '=' + v);
    b.tagName = 'BUTTON';
    b.attrs[attr] = v;
    return b;
  });
  host.querySelectorAll = (sel) => (sel.indexOf('button[' + attr + ']') >= 0 ? btns.slice() : []);
  // 补一个按 class 找的入口：来源切换的「选中态高亮」正是通过
  // classList.toggle('active') 落的，只按 attr 查的桩看不见它。
  // makeEl 的通用 querySelector 只会返回 memo 假元素（它只认 #id），
  // 拿它判高亮会得到「恒为 null」这种假象。
  host.querySelector = (sel) => {
    const wantActive = sel.indexOf('.active') >= 0;
    return btns.find((b) => b.classList.contains('active') === wantActive && wantActive)
      || (wantActive ? null : btns[0]);
  };
  host._buttons = btns;
  return btns;
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
  const held = [];
  let playbackIntent = 0;
  return {
    calls,
    beginPlaybackIntent() { return ++playbackIntent; },
    isPlaybackIntent(intent) { return intent === playbackIntent; },
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
          // hold：这一路先**不返回**，等测试显式 release(path) 才放行。
          //
          // 为什么不用 delay 毫秒数：这份沙箱的 setTimeout 是**同步立即执行**的
          // 桩（makeClock 里 setTimeout(fn){ fn(); }），没有任何真实延时，
          // `await sleep(40)` 拿不到时间差；而用 Date.now() 轮询又要求沙箱
          // 注入 Date（它没有，注入就不是同一个沙箱了）。
          //
          // 闸门反过来更贴近要验的东西：「慢的那路还没回」是一个**状态**，
          // 由测试自己控制何时结束，比掐表准也不脆弱。
          if (r.hold) {
            await new Promise((res) => { held.push({ path, res }); });
          }
          // reply 允许是函数，好按请求路径编排不同响应。
          return typeof r.reply === 'function' ? r.reply(path) : r.reply;
        }
      }
      throw new Error('unexpected GET ' + path);
    },
    /// 放行所有被 hold 住的请求。返回放行条数。
    release(part) {
      let n = 0;
      for (let i = held.length - 1; i >= 0; i -= 1) {
        if (!part || held[i].path.indexOf(part) >= 0) {
          held[i].res();
          held.splice(i, 1);
          n += 1;
        }
      }
      return n;
    },
    heldCount() { return held.length; },
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
  const spies = { toasts: [], played: [], queues: [], radio: [] };
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
  sandbox.localStorage = makeLocalStorage();
  sandbox.window.localStorage = sandbox.localStorage;
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
    favMore: doc.getElementById('fav-more'),
    favRefresh: doc.getElementById('fav-refresh'),
    favBadge: doc.getElementById('fav-badge'),
    dailyList: doc.getElementById('daily-list'),
    dailyDate: doc.getElementById('daily-date'),
    dailySub: doc.getElementById('daily-sub'),
    dailyPlayAll: doc.getElementById('daily-play-all'),
    dailyRefresh: doc.getElementById('daily-refresh'),
    dailyModes: doc.getElementById('daily-modes'),
  };
  attachButtons(ui.dailyModes, 'data-daily-mode', ['online', 'local']);
  const host = {
    ui,
    state: { view: 'favorites' },
    fmt: (ms) => String(Math.round((ms || 0) / 1000)),
    toast: (msg, kind) => spies.toasts.push({ msg, kind }),
    errText: (prefix, err) => prefix + '：' + err.message,
    paintArt: () => {},
    coverUrl: (id) => '/cover/' + id,
    playLocal: (id, queue) => spies.played.push({ id: id, queue: queue }),
    // startId 是第三个参数：每日推荐的在线合并歌单要"从被点的那首起播"，
    // 而队列里包含多个音源的曲目，不能靠重排队列来实现。
    playQueue: (ids, meta, startId) => spies.queues.push({ ids: ids, meta: meta, startId: startId }),
    playOnline: (f) => spies.radio.push(f),
    playRadio: (f) => spies.radio.push(f),
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

  section('收藏：播放收藏（本地单曲 + 电台行不进歌曲队列）');
  rows[1]._click();
  await ticks();
  eq(s6.spies.radio.length, 1, '电台收藏行点开走整盘载入链路');
  eq(s6.spies.radio[0].ref_id, 'r1', '电台载入携带歌单身份');
  await s6.ui.favPlayAll.onclick();
  eq(s6.spies.queues.length, 1, '「播放收藏」提交混合队列');
  eq(s6.spies.queues[0].ids.join(','), 'a', '歌曲 tab 的本地收藏进队列');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function favorite(id, source, kind) {
  return { id: String(id), kind: kind || 'track', source: source || 'local', ref_id: String(id), title: String(id) };
}

function favoritePage(items, total, counts) {
  return { favorites: items, total: total == null ? items.length : total, counts: counts || { track: 201, radio: 0 } };
}

function selectFavoriteTab(ui, kind) {
  ui.favTabs.onclick({ target: { closest: () => ({ dataset: { favKind: kind } }) } });
}

async function checkFavoritesPagination() {
  section('收藏：201 条、分页失败与原页重试');
  const items = Array.from({ length: 201 }, (_, i) => favorite(i));
  let failMore = true;
  const retry = deferred();
  const t = makeTransport([{
    match: (p) => p.startsWith('/v1/favorites?'),
    reply: (p) => {
      const offset = Number(new URL(p, 'http://local').searchParams.get('offset'));
      if (!offset) return favoritePage(items.slice(0, 200), 201);
      if (failMore) { failMore = false; throw new Error('page failed'); }
      return retry.promise;
    },
  }]);
  const { sandbox, ui, spies } = makeSandbox(t);
  const F = sandbox.Favorites;
  F.init();
  eq(ui.favMore.hidden, true, '首屏读取前隐藏加载更多');
  await F.load();
  eq(ui.favList.children.length, 200, '首屏显示 200 条');
  eq(ui.favMore.hidden, false, '还有第 201 条时显示加载更多');
  eq(ui.favMore.disabled, false, '首屏完成后可加载更多');
  await ui.favMore.onclick({ type: 'click' });
  eq(ui.favList.children.length, 200, '下一页失败保留已有 200 条');
  eq(F.state.offset, 200, '失败不推进分页位置');
  eq(ui.favMore.hidden, false, '失败后保留加载更多入口');
  eq(ui.favMore.disabled, false, '失败后按钮恢复可重试');
  eq(ui.favMore.textContent, '加载更多收藏', '失败后清除加载中标签');
  eq(spies.toasts.length, 1, '分页失败只报告一次');
  const more = ui.favMore.onclick({ type: 'click' });
  eq(ui.favList.children.length, 200, '读取下一页过程中保留已有行');
  eq(ui.favMore.disabled, true, '读取下一页时禁用按钮');
  eq(ui.favMore.hidden, false, '读取下一页时保留按钮位置');
  eq(ui.favMore.textContent, '正在读取收藏…', '读取下一页时显示加载中标签');
  const requestCount = t.calls.length;
  await F.loadMore();
  eq(t.calls.length, requestCount, '重复点击不会同时发出同页请求');
  retry.resolve(favoritePage(items.slice(200), 201));
  await more;
  eq(ui.favList.children.length, 201, '第 201 条追加到已有行');
  eq(F.state.items[200].ref_id, '200', '第二页追加正确曲目');
  eq(F.state.offset, 201, '仅成功后推进 offset');
  eq(ui.favMore.hidden, true, '所有收藏读完后隐藏按钮');
  eq(t.calls[1].path, t.calls[2].path, '失败与重试请求完全相同的 offset');
  await F.loadMore();
  eq(t.calls.length, requestCount, '全部读取后不发额外请求');

  section('收藏：切 tab 与刷新丢弃过期响应');
  const pending = [];
  const t2 = makeTransport([{
    match: (p) => p.startsWith('/v1/favorites?'),
    reply: () => { const req = deferred(); pending.push(req); return req.promise; },
  }]);
  const s2 = makeSandbox(t2);
  const F2 = s2.sandbox.Favorites;
  F2.init();
  const oldTrack = F2.load();
  selectFavoriteTab(s2.ui, 'radio');
  eq(pending.length, 2, '上一 tab 未完成也立即请求新 tab');
  eq(s2.ui.favPlayAll.hidden, true, '电台 tab 隐藏播放本地收藏');
  ok(t2.calls[1].path.includes('kind=radio'), '新请求捕获电台 kind');
  pending[0].resolve(favoritePage([favorite('stale-track')], 1, { track: 1, radio: 0 }));
  await oldTrack;
  eq(F2.state.items.length, 0, '旧 tab 响应不污染新 tab');
  eq(F2.state.loading, true, '旧请求 finally 不清除新请求 loading');
  eq(F2.has('track', 'local', 'stale-track'), false, '过期响应不污染判红集合');
  pending[1].resolve(favoritePage([favorite('radio', 'netease', 'radio')], 1, { track: 201, radio: 1 }));
  await ticks();
  eq(F2.state.items[0].ref_id, 'radio', '仅当前 tab 的响应进入列表');
  eq(F2.state.loading, false, '当前请求完成后清除 loading');

  const oldRefresh = F2.load();
  s2.ui.favRefresh.onclick({ type: 'click' });
  eq(pending.length, 4, '刷新立即替代同 kind 的进行中请求');
  pending[3].resolve(favoritePage([favorite('new-radio', 'netease', 'radio')], 1, { track: 300, radio: 1 }));
  await ticks();
  pending[2].resolve(favoritePage([favorite('old-radio', 'netease', 'radio')], 99, { track: 999, radio: 99 }));
  await oldRefresh;
  eq(F2.state.items[0].ref_id, 'new-radio', '同 kind 的旧刷新响应也被丢弃');
  eq(F2.state.total, 1, '过期响应不覆盖 total');
  eq(s2.ui.favCount.textContent, '300 首', '过期响应不覆盖 counts');
  eq(s2.ui.favMore.hidden, true, '过期响应不重新展示加载更多');

  const oldFailure = F2.load();
  selectFavoriteTab(s2.ui, 'track');
  pending[4].reject(new Error('stale failure'));
  await oldFailure;
  eq(s2.spies.toasts.length, 0, '过期请求失败不弹无关错误');
  eq(F2.state.loading, true, '过期失败不改变新请求状态');
  eq(s2.ui.favPlayAll.hidden, false, '歌曲 tab 恢复播放本地收藏');
  pending[5].reject(new Error('initial failure'));
  await ticks();
  eq(F2.state.loading, false, '当前首屏失败结束 loading');
  eq(s2.spies.toasts.length, 1, '当前首屏失败报告错误');
  s2.ui.favRefresh.onclick({ type: 'click' });
  eq(pending.length, 7, '首屏失败后可通过刷新重试');
  pending[6].resolve(favoritePage([favorite('recovered')], 1));
  await ticks();
  eq(F2.state.items[0].ref_id, 'recovered', '首屏刷新重试恢复列表');

  section('收藏：全部本地收藏跨三页后再播放');
  const all = Array.from({ length: 405 }, (_, i) => favorite('all-' + i, i === 200 ? 'netease' : 'local'));
  const t3 = makeTransport([{
    match: (p) => p.startsWith('/v1/favorites?'),
    reply: (p) => {
      const query = new URL(p, 'http://local').searchParams;
      eq(query.get('kind'), 'track', '整批播放始终读取歌曲收藏');
      const offset = Number(query.get('offset'));
      return favoritePage(all.slice(offset, offset + 200), all.length);
    },
  }]);
  const s3 = makeSandbox(t3);
  const F3 = s3.sandbox.Favorites;
  F3.init();
  await F3.load();
  eq(F3.state.items.length, 200, '播放前界面仅加载第一页');
  const play = s3.ui.favPlayAll.onclick({ type: 'click' });
  eq(s3.ui.favPlayAll.disabled, true, '收集跨页队列时禁用重复播放');
  eq(s3.spies.queues.length, 0, '全部页读取完成之前不播放残缺队列');
  await s3.ui.favPlayAll.onclick();
  await play;
  eq(s3.spies.queues.length, 1, '重复点击只播放一轮');
  eq(s3.spies.queues[0].ids.length, 405, '整批播放包含三页全部收藏');
  eq(s3.spies.queues[0].ids[404], 'all-404', '最后一页收藏进入队列');
  ok(s3.spies.queues[0].ids.includes('online:netease:all-200'), '在线收藏折成虚拟身份入队');
  eq(s3.spies.queues[0].meta['online:netease:all-200'].title, 'all-200', '在线收藏快照随队提交');
  ok(!Object.prototype.hasOwnProperty.call(s3.spies.queues[0].meta, 'local'), '本地收藏不写在线快照');
  eq(F3.state.items.length, 200, '整批播放不改变界面已加载页');
  eq(s3.ui.favPlayAll.disabled, false, '播放完成后恢复按钮');
  eq(s3.ui.favPlayAll.textContent, '播放收藏', '播放完成后恢复标签');
  eq(t3.calls.map((c) => new URL(c.path, 'http://local').searchParams.get('offset')).join(','), '0,0,200,400', '整批播放从第一页重新读到末页');

  section('收藏：整批播放分页失败不启动残缺队列');
  let playbackFail = true;
  const t4 = makeTransport([{
    match: (p) => p.startsWith('/v1/favorites?'),
    reply: (p) => {
      const offset = Number(new URL(p, 'http://local').searchParams.get('offset'));
      if (offset && playbackFail) throw new Error('last page failed');
      return favoritePage(items.slice(offset, offset + 200), items.length);
    },
  }]);
  const s4 = makeSandbox(t4);
  s4.sandbox.Favorites.init();
  await s4.ui.favPlayAll.onclick();
  eq(s4.spies.queues.length, 0, '尾页失败时不播放前 200 首');
  eq(s4.ui.favPlayAll.disabled, false, '失败后可重试整批播放');
  eq(s4.spies.toasts.length, 1, '尾页失败如实报告');
  playbackFail = false;
  await s4.ui.favPlayAll.onclick();
  eq(s4.spies.queues[0].ids.length, 201, '重试成功后播放完整队列');

  section('收藏：后续播放意图取消尚未读完的收藏队列');
  for (const staleFailure of [false, true]) {
    const pendingPage = deferred();
    const raceTransport = makeTransport([{
      match: (p) => p.startsWith('/v1/favorites?'),
      reply: (p) => {
        const offset = Number(new URL(p, 'http://local').searchParams.get('offset'));
        return offset ? pendingPage.promise : favoritePage(items.slice(0, 200), items.length);
      },
    }]);
    const race = makeSandbox(raceTransport);
    race.sandbox.Favorites.init();
    const collecting = race.ui.favPlayAll.onclick();
    await ticks();
    eq(raceTransport.calls.length, 2, '收藏队列正在等待第二页');
    eq(race.spies.queues.length, 0, '等待尾页时没有提交部分队列');
    raceTransport.beginPlaybackIntent(); // 用户在其他入口选择了更新的播放。
    if (staleFailure) pendingPage.reject(new Error('stale page failure'));
    else pendingPage.resolve(favoritePage(items.slice(200), items.length));
    await collecting;
    eq(race.spies.played.length, 0, staleFailure ? '过期失败不播放收藏队列' : '过期成功不覆盖更新的播放');
    eq(race.spies.toasts.length, 0, '过期的收藏读取不弹错误');
    eq(race.ui.favPlayAll.disabled, false, '过期收集结束后恢复播放按钮');
    eq(race.ui.favPlayAll.textContent, '播放收藏', '过期收集结束后恢复按钮标签');
  }
}

// ---------------------------------------------------------------------------
// 每日推荐
// ---------------------------------------------------------------------------

/// `/v1/recommend/daily` 会把 `/v1/recommend/daily/online` 也匹配进来，
/// 两路请求必须分开编排，这里给出唯一的判定口。
function isLocalDaily(p) { return p.indexOf('/v1/recommend/daily') === 0 && p.indexOf('/online') < 0; }
function isOnlineDaily(p) { return p.indexOf('/v1/recommend/daily/online') === 0; }

async function checkDaily() {
  section('每日推荐：取数与渲染');

  const page = {
    date: '2026-09-22',
    day: 20718,
    limit: 12,
    total: 3,
    candidates: 40,
    tracks: [
      { id: 't1', title: '一', artist: 'A', has_cover: true, score: 18, reasons: ['你收藏过'] },
      { id: 't2', title: '二', artist: 'B', has_cover: false, score: 12, reasons: ['有封面'] },
      { id: 't3', title: '三', artist: 'C', has_cover: false, score: 6, reasons: [] },
    ],
  };
  // 本地那一路的匹配要显式排掉 /online：/v1/recommend/daily 是它的前缀，
  // 不排掉的话在线请求会被这条规则接走，测的就不是本地取数了。
  const t = makeTransport([
    { match: isLocalDaily, reply: page },
  ]);
  const { sandbox, ui, spies } = makeSandbox(t);
  const D = sandbox.window.Daily;
  D.init();
  await D.load();
  await ticks();

  ok(t.last('/v1/recommend/daily') !== null, '走了 /v1/recommend/daily');
  // 没有在线路由 → 在线那一路 reject；页面必须仍然按本地结果渲染。
  eq(ui.dailyList.children.length, 3, '三张卡片都渲染');
  eq(ui.dailyList.children[0].querySelector('.daily-name').textContent, '一', '读取服务端扁平曲目字段');
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

  section('每日推荐：同 id 更新和重排保留卡片身份');
  const original = ui.dailyList.children.slice();
  D.state.page.tracks[0].title = '更新后的标题';
  D.state.page.tracks[0].has_cover = false;
  D.setMode('local');
  ok(ui.dailyList.children[0] === original[0], '同 id 不重建按钮');
  eq(original[0].querySelector('.daily-name').textContent, '更新后的标题', '同 id 元数据变化不会被签名跳过');
  ok(original[0].querySelector('.daily-cover').classList.contains('is-missing'), '移除封面时占位同步');
  D.state.page.tracks.reverse();
  D.setMode('local');
  ok(ui.dailyList.children[0] === original[2], '重排移动原卡片而非复制');
  ui.dailyList.children[0].onclick();
  eq(spies.played[spies.played.length - 1].id, 't3', '重排后点击对应当前队列位置');
  eq(ui.dailyList.children.length, 3, '移动不重复增加 DOM');

  section('每日推荐：空结果与静默失败');
  const t2 = makeTransport([
    { match: isLocalDaily, reply: { date: '2026-09-22', day: 20718, limit: 12, total: 0, candidates: 0, tracks: [] } },
  ]);
  const s2 = makeSandbox(t2);
  s2.sandbox.window.Daily.init();
  await s2.sandbox.window.Daily.load();
  await ticks();
  eq(s2.ui.dailyPlayAll.disabled, true, '空结果时「播放全部」禁用');
  ok(s2.ui.dailyList.innerHTML.indexOf('曲库') >= 0, '空结果提示去扫描曲库');

  const t3 = makeTransport([
    { match: isLocalDaily, throw: '网络断了' },
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
// 每日推荐 · 在线汇总
//
// 这一路的铁律是"单点失败不算失败"，所以检查的重点不是"能拿到数据"，
// 而是：未登录的平台只留名不报错、某个平台挂了不影响别的平台、
// 整路挂掉也不影响本地那一路。
// ---------------------------------------------------------------------------

const LOCAL_PAGE = {
  date: '2026-09-28',
  day: 20724,
  limit: 12,
  total: 2,
  candidates: 30,
  tracks: [
    { id: 't1', title: '本地一', artist: 'L', has_cover: false, score: 9, reasons: ['你收藏过'] },
    { id: 't2', title: '本地二', artist: 'L', has_cover: false, score: 4, reasons: [] },
  ],
};

/// 两个平台出歌、两个平台被跳过（一个没登录、一个没接口）。
const ONLINE_PAGE = {
  date: '2026-09-28',
  limit: 24,
  total: 3,
  empty: false,
  tracks: [
    {
      source: 'netease', id: '11', title: '云一', artist: 'N', album: '素', duration_ms: 210000,
      cover: null, playable: true, vip_only: false,
      virtual_id: 'online:netease:11', source_label: '网易云音乐',
    },
    {
      source: 'qq', id: '99', title: 'Q 一', artist: 'Q', album: '素', duration_ms: 180000,
      cover: null, playable: true, vip_only: false,
      virtual_id: 'online:qq:99', source_label: 'QQ音乐',
    },
    {
      source: 'netease', id: '12', title: '云二', artist: 'N', album: '素', duration_ms: 200000,
      cover: null, playable: true, vip_only: false,
      virtual_id: 'online:netease:12', source_label: '网易云音乐',
    },
  ],
  sources: [
    { source: 'netease', label: '网易云音乐', count: 2 },
    { source: 'qq', label: 'QQ音乐', count: 1 },
  ],
  skipped: [
    { source: 'kugou', label: '酷狗音乐', kind: 'not_signed_in', message: '未登录' },
    { source: 'kuwo', label: '酷我音乐', kind: 'unsupported', message: '该音源没有每日推荐歌曲接口' },
  ],
};

async function checkDailyOnline() {
  section('每日推荐 · 在线：默认走在线、合并结果与跳过项可见');

  const t = makeTransport([
    { match: isOnlineDaily, reply: ONLINE_PAGE },
    { match: isLocalDaily, reply: LOCAL_PAGE },
  ]);
  const { sandbox, ui, spies } = makeSandbox(t);
  const D = sandbox.window.Daily;
  D.init();
  await D.load();
  await ticks();

  ok(t.last('/v1/recommend/daily/online') !== null, '在线那一路真的被请求了');
  eq(D.state.mode, 'online', '有已登录平台时默认落在在线');
  eq(ui.dailyList.children.length, 3, '合并后的三首都渲染');
  eq(ui.dailyList.children[0].querySelector('.daily-name').textContent, '云一', '取的是在线曲目的标题');
  eq(ui.dailyList.children[1].querySelector('.daily-why').textContent, 'QQ音乐',
    '卡片带来源平台，跨平台同名曲目才分得清');
  eq(ui.dailyDate.textContent, '2026-09-28', '日期用在线那一份');

  ok(ui.dailySub.textContent.indexOf('已合并 3 首') >= 0, '副标题写明合并条数');
  ok(ui.dailySub.textContent.indexOf('网易云音乐 2 首') >= 0, '副标题列出各平台贡献');
  ok(ui.dailySub.textContent.indexOf('已跳过') >= 0, '副标题写明有平台被跳过');
  ok(ui.dailySub.textContent.indexOf('酷狗音乐（未登录）') >= 0, '未登录平台如实写出原因');
  ok(ui.dailySub.textContent.indexOf('酷我音乐（该音源没有每日推荐歌曲接口）') >= 0,
    '没接口的平台也如实写出原因');

  eq(spies.toasts.length, 0, '未登录/无接口都不该弹错');

  section('每日推荐 · 在线：点第 N 张 = 整份合并歌单从第 N 首起播');
  ui.dailyList.children[1].onclick();
  await ticks();
  eq(spies.queues.length, 1, '在线曲目走混合队列而不是本地播放');
  eq(spies.queues[0].ids.length, 3, '整份合并歌单进队列');
  eq(spies.queues[0].ids[0], 'online:netease:11', '队列用服务端给的虚拟 id');
  eq(spies.queues[0].startId, 'online:qq:99', '从被点的那首起播');
  ok(!!spies.queues[0].meta['online:qq:99'], '注入元数据快照，队列与历史才有标题');
  eq(spies.queues[0].meta['online:qq:99'].onlineId, '99', '快照里带平台侧 id');
  eq(spies.played.length, 0, '在线曲目不该走本地播放链路');

  section('每日推荐 · 在线：切到本地不改数据，只换渲染');
  const before = t.calls.length;
  ui.dailyModes._buttons[1].onclick();
  await ticks();
  eq(D.state.mode, 'local', '点了「本地」就切过去');
  eq(t.calls.length, before, '切来源只重渲染，不重新取数');
  eq(ui.dailyList.children.length, 2, '换成本地那批');
  eq(ui.dailyList.children[0].querySelector('.daily-name').textContent, '本地一', '本地标题来自规则引擎');
  eq(sandbox.localStorage.getItem('vmusic.daily.mode'), 'local', '选择被持久化');
}

async function checkDailyOnlineDegraded() {
  section('每日推荐 · 在线：全都没登录时静默落到本地');

  const t = makeTransport([
    {
      match: isOnlineDaily,
      reply: {
        date: '2026-09-28', limit: 24, total: 0, empty: true,
        tracks: [], sources: [],
        skipped: [
          { source: 'netease', label: '网易云音乐', kind: 'not_signed_in', message: '未登录' },
          { source: 'qq', label: 'QQ音乐', kind: 'not_signed_in', message: '未登录' },
        ],
      },
    },
    { match: isLocalDaily, reply: LOCAL_PAGE },
  ]);
  const { sandbox, ui, spies } = makeSandbox(t);
  const D = sandbox.window.Daily;
  D.init();
  await D.load();
  await ticks();

  eq(D.state.mode, 'local', '一个平台都没登录时落到本地');
  eq(ui.dailyList.children.length, 2, '页面显示本地推荐');
  eq(spies.toasts.length, 0, '未登录不是错误，不弹红');
  eq(ui.dailyPlayAll.disabled, false, '本地有结果时播放全部可用');

  section('每日推荐 · 在线：整路失败不影响本地那一路');
  const t2 = makeTransport([
    { match: isOnlineDaily, throw: '在线服务不可达' },
    { match: isLocalDaily, reply: LOCAL_PAGE },
  ]);
  const s2 = makeSandbox(t2);
  s2.sandbox.window.Daily.init();
  await s2.sandbox.window.Daily.load({ silent: true });
  await ticks();
  eq(s2.ui.dailyList.children.length, 2, '在线挂了本地仍然渲染');
  eq(s2.spies.toasts.length, 0, '自动拉取失败不弹红');

  section('每日推荐 · 在线：用户显式选过来源后不再自动落位');
  const t3 = makeTransport([
    { match: isOnlineDaily, reply: ONLINE_PAGE },
    { match: isLocalDaily, reply: LOCAL_PAGE },
  ]);
  const s3 = makeSandbox(t3);
  s3.sandbox.localStorage.setItem('vmusic.daily.mode', 'local');
  s3.sandbox.window.Daily.init();
  await s3.sandbox.window.Daily.load();
  await ticks();
  eq(s3.sandbox.window.Daily.state.mode, 'local',
    '上次选了本地，即使这次有已登录平台也保持本地');
}

/// 起始态用 'auto'：哪一路先到就按哪一路渲染。
///
/// 实测两端差两个数量级 —— 本地规则引擎 20ms、在线汇总要顶满服务端 2s 的
/// 等待预算（网易云 + QQ 并发抓）。曾经**起始 mode 直接写死 'online'**，于是
/// 本地那份到手后因 mode 不匹配而被无视：`visible()` 走在线分支、本地数据
/// 根本没人读，用户盯着「正在汇总…」「正在挑歌…」两行整整 2 秒 —— 推荐早就在
/// 内存里了，只是没画出来。
///
/// 这组断言钉的是**因果链上的环节**（起始值 / 生效来源判定 / 各消费点是否用
/// 生效来源），首屏时间线由 scripts/check-daily-firstpaint.js 在浏览器里量。
async function checkDailyAutoSettle() {
  section('每日推荐 · 起始态：先到的那路先渲染（不等在线）');

  // 在线那一路用 hold 闸门扣住不放，本地立刻回。判据是**在线被扣住的那段时间里**
  // 屏幕上有没有画出本地那批卡 —— 那段时间正是用户白等的那 2 秒。
  const t = makeTransport([
    { match: isOnlineDaily, reply: ONLINE_PAGE, hold: true },
    { match: isLocalDaily, reply: LOCAL_PAGE },
  ]);
  const { sandbox, ui } = makeSandbox(t);
  sandbox.localStorage.removeItem('vmusic.daily.mode');
  const D = sandbox.window.Daily;
  D.init();

  eq(D.state.mode, 'auto', '没选过来源时起始是 auto（不是先假定在线）');
  eq(D.state.modePinned, false, 'auto 不是「用户选过」，仍允许自动落位');

  D.load();
  await ticks();

  eq(D.state.localBusy, false, '本地那一路已收工');
  eq(D.state.onlineBusy, true, '在线那一路仍被扣住');
  eq(t.heldCount(), 1, '确实扣住了在线那一次请求');
  ok(ui.dailyList.children.length === 2,
    '在线还没回来时，本地那批已经画出来了（首屏不等在线）',
    `children=${ui.dailyList.children.length}`);
  eq(ui.dailyList.children[0].querySelector('.daily-name').textContent, '本地一',
    '画的是本地曲库那批');
  eq(D.state.mode, 'auto', '此刻还没落位（要等两路都收工）');
  eq(ui.dailyDate.textContent, LOCAL_PAGE.date, '日期取的是本地那一份');
  ok(ui.dailySub.textContent.indexOf('本地规则') >= 0,
    '副标题说的是本地那份的来历', ui.dailySub.textContent);

  // 高亮必须跟着**生效**来源走。落位之前 mode 是 'auto'，若 renderModes
  // 拿 dailyState.mode 去比，两个按钮都不亮 —— 用户看着一屏本地推荐，
  // 却不知道自己在「本地」这个来源下。
  const chipNow = ui.dailyModes.querySelector('button.active');
  ok(!!chipNow && chipNow.getAttribute('data-daily-mode') === 'local',
    '落位前高亮跟着生效来源（不是两个都不亮）',
    chipNow ? chipNow.getAttribute('data-daily-mode') : 'null');

  // 放行在线 → 两路都收工 → 落位
  t.release('online');
  await ticks(14);

  eq(D.state.mode, 'online', '两路都收工后落位到 online（有已登录平台）');
  eq(D.state.modePinned, false, '自动落位不算「用户选过」');
  eq(ui.dailyList.children.length, 3, '落位后换成在线那三首',
    `children=${ui.dailyList.children.length}`);
  eq(ui.dailyList.children[0].querySelector('.daily-name').textContent, '云一',
    '落位后卡片内容换成在线曲目');
  ok(ui.dailySub.textContent.indexOf('已合并') >= 0,
    '副标题跟着换成在线的合并说明', ui.dailySub.textContent);
  const chipAfter = ui.dailyModes.querySelector('button.active');
  ok(!!chipAfter && chipAfter.getAttribute('data-daily-mode') === 'online',
    '落位后高亮切到在线', chipAfter ? chipAfter.getAttribute('data-daily-mode') : 'null');

  section('每日推荐 · 起始态：两路都扣住时不谎报「本地也没有」');

  const t2 = makeTransport([
    { match: isOnlineDaily, reply: ONLINE_PAGE, hold: true },
    { match: isLocalDaily, reply: LOCAL_PAGE, hold: true },
  ]);
  const s2 = makeSandbox(t2);
  s2.sandbox.localStorage.removeItem('vmusic.daily.mode');
  s2.sandbox.window.Daily.init();
  s2.sandbox.window.Daily.load();
  await ticks();
  // 都还没回：占位该说「在汇总/挑歌」，不该说「曲库是空的」——
  // 后者会让用户以为自己没扫库，白跑去设置里加目录。
  const sub2 = s2.ui.dailySub.textContent;
  ok(sub2.indexOf('汇总') >= 0 || sub2.indexOf('挑歌') >= 0,
    '两路都在飞时副标题是「正在…」，不是空态断言', sub2);
  ok(sub2.indexOf('曲库里还没有') < 0, '没有误报「曲库是空的」', sub2);
  t2.release();
  await ticks(14);

  section('每日推荐 · 起始态：点卡片按生效来源分派，不按 mode');
  // 'auto' 期间画的是**在线**那批（在线先到、本地还扣着）。若 playAll 按
  // dailyState.mode 判（'auto' !== 'online'）就会走本地路径，把 online: 虚拟 id
  // 喂给 playLocal —— 那是必然 404 的一路。
  const t3 = makeTransport([
    { match: isOnlineDaily, reply: ONLINE_PAGE },
    { match: isLocalDaily, reply: LOCAL_PAGE, hold: true },
  ]);
  const s3 = makeSandbox(t3);
  s3.sandbox.localStorage.removeItem('vmusic.daily.mode');
  s3.sandbox.window.Daily.init();
  s3.sandbox.window.Daily.load();
  await ticks();

  eq(s3.sandbox.window.Daily.state.mode, 'auto', '此刻仍未落位');
  eq(s3.ui.dailyList.children.length, 3, '画的是在线那三首',
    `children=${s3.ui.dailyList.children.length}`);
  const onlineCard = s3.ui.dailyList.children[0];
  ok(!!onlineCard, '拿到了在线那张卡');
  onlineCard.onclick();
  eq(s3.spies.queues.length, 1, '点在线卡走 playQueue（不是 playLocal）');
  eq(s3.spies.played.length, 0, '没有误走本地路径');
  ok(s3.spies.queues.length && String(s3.spies.queues[0].ids[0]).indexOf('online:') === 0,
    '队列里是在线虚拟 id（不是本地 track id）',
    s3.spies.queues.length ? String(s3.spies.queues[0].ids[0]) : '(无)');
  t3.release();
  await ticks(14);

  section('每日推荐 · 宿主还没 bind 时 load 不进（否则卡在永久 loading）');

  // 这条钉的是 2026-10-06 那个「首页推荐空白、独立页正常」的根因：
  // app.js 的换肤对账 setView('library') 早于 Daily.bind()，load() 里
  // render() 读 H.ui 抛错，异常正好打断在发请求那两行**之前** ——
  // busy 置上了、请求一个没发，此后每次 load 都撞 loading 早退。
  const src = fs.readFileSync(path.join(WEB, 'daily.js'), 'utf8');
  const loadBody = (() => {
    const i = src.indexOf('function load(opts)');
    if (i < 0) return '';
    let depth = 0;
    for (let j = src.indexOf('{', i); j < src.length; j += 1) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') { depth -= 1; if (!depth) return src.slice(i, j + 1); }
    }
    return '';
  })();
  ok(/if \(!H \|\| !T\)\s*\{[\s\S]{0,120}?loadPending = true;[\s\S]{0,40}?return;/.test(loadBody),
    'load() 在宿主未 bind 时记账并早退（不把 busy 置上后卡死）');
  // 记账必须在置 busy **之前**：反过来的话照样卡在「永远 loading」。
  ok(loadBody.indexOf('loadPending = true') < loadBody.indexOf('dailyState.localBusy = wantLocal'),
    '闸门在置 busy 之前（否则请求仍会被打断在同一个位置）');
  // bind 时补跑，否则那次 load 的意图会静默丢失
  ok(/bind: function \(host\)[\s\S]{0,240}?if \(loadPending\) load\(\);/.test(src),
    'bind() 里补跑被挡下的 load（否则调用方以为已发起，不会再来第二次）');
  ok(/var loadPending = false;/.test(src), 'loadPending 有声明（不是隐式全局）');

  section('每日推荐 · 起始态：notifyMode 报的是生效来源');
  // 宿主（app.js 的 syncLibEmpty）判据是 `mode === 'online'` 来决定弹不弹
  // 「本地曲库是空的」大引导卡。落位之前 dailyState.mode 是 'auto'，
  // 报 'auto' 会被当成非在线 → 屏幕上正显示着一屏推荐，引导卡却弹出来了。
  const t5 = makeTransport([
    { match: isOnlineDaily, reply: ONLINE_PAGE, hold: true },
    { match: isLocalDaily, reply: LOCAL_PAGE },
  ]);
  const s5 = makeSandbox(t5);
  s5.sandbox.localStorage.removeItem('vmusic.daily.mode');
  const seen = [];
  s5.sandbox.onDailyModeChangeOf = null;
  s5.sandbox.window.Daily.bind({
    ui: s5.ui,
    state: { view: 'favorites' },
    fmt: (ms) => String(Math.round((ms || 0) / 1000)),
    toast: (m, k) => s5.spies.toasts.push({ msg: m, kind: k }),
    errText: (p, e) => p + '：' + e.message,
    coverUrl: () => null,
    // 记录宿主每次收到的来源
    onDailyModeChange: (m) => seen.push(m),
  });
  s5.sandbox.window.Daily.init();
  s5.sandbox.window.Daily.load();
  await ticks();
  ok(seen.indexOf('local') >= 0,
    '落位前报的是 local（生效来源），宿主据此不弹「曲库是空的」',
    JSON.stringify(seen));
  ok(seen.indexOf('auto') < 0, '没有把 auto 报给宿主（那会被当成非在线）',
    JSON.stringify(seen));
  t5.release('online');
  await ticks(14);
  ok(seen[seen.length - 1] === 'online', '落位后报 online', JSON.stringify(seen));
  // 逐次比对而不是只比末位：通知**只该在生效来源真的变了时**发。
  // setMode 里若再补一次 notifyMode，同一次落位会报两遍 'online'，
  // 宿主白白重判一次空态卡（它会重写 DOM），末位断言却照样绿。
  const uniq = seen.filter((m, i) => m !== seen[i - 1]);
  eq(seen.length, uniq.length,
    '来源没变就不重复通知（宿主每次都要重判空态卡）', JSON.stringify(seen));

  section('每日推荐 · 起始态：显式选过来源时 auto 那套不生效');
  const t4 = makeTransport([
    { match: isOnlineDaily, reply: ONLINE_PAGE, hold: true },
    { match: isLocalDaily, reply: LOCAL_PAGE },
  ]);
  const s4 = makeSandbox(t4);
  s4.sandbox.localStorage.setItem('vmusic.daily.mode', 'local');
  s4.sandbox.window.Daily.init();
  s4.sandbox.window.Daily.load();
  await ticks();
  eq(s4.sandbox.window.Daily.state.mode, 'local', '存过 local 就直接是 local（不是 auto）');
  eq(s4.ui.dailyList.children.length, 2, '画的是本地那批',
    `children=${s4.ui.dailyList.children.length}`);
  t4.release();
  await ticks(14);
}

// ---------------------------------------------------------------------------

(async function main() {
  await checkFavorites();
  await checkFavoritesPagination();
  await checkDaily();
  await checkDailyOnline();
  await checkDailyOnlineDegraded();
  await checkDailyAutoSettle();

  console.log('\n' + '─'.repeat(60));
  if (failures) {
    console.error(`收藏与每日推荐契约检查：${checks} 项，${failures} 项失败`);
    process.exit(1);
  }
  console.log(`收藏与每日推荐契约检查：${checks}/${checks} 全部通过`);
})();
