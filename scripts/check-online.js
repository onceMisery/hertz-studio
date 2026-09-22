#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// 在线音源前端的无头契约检查（零依赖、不触网）。
//
//   node scripts/check-online.js
//
// 覆盖三块最容易在浏览器里「静默坏掉」的逻辑：
//   1. online-login.js 扫码状态机（waiting/scanned/confirmed/expired、
//      cancel 带真实票据、能力位 404 回落 cookie、轮询网络重试、cookie 判定）
//   2. online.js 聚合搜索（分组头 / 失败条 / 空查询不发请求 / 单源缓存）
//   3. online-playlists.js caps 驱动（无 qr_login 不出扫码按钮、无
//      playlist_write 不出移除按钮、401 安静留在未登录态）
//
// 桩原则：DOM 只实现脚本真实用到的方法；HTTP 全部走可编排的假 transport；
// 定时器全部收进可控时钟，手动推进。

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
    toggle: (c) => (set.has(c) ? set.delete(c) : set.add(c)),
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
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    append(...cs) { cs.forEach((c) => this.appendChild(c)); },
    replaceChildren(...cs) {
      this.children = [];
      cs.forEach((c) => this.appendChild(c));
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    focus() {},
    // 被测代码只往 querySelector 的结果上写文本/属性，不关心它在不在树里，
    // 所以按选择器给稳定的独立桩即可。
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

function classList(el, cls) {
  return typeof el.className === 'string'
    && el.className.split(/\s+/).indexOf(cls) >= 0;
}
function walkClasses(root, cls, out) {
  if (!root || !root.children) return out;
  for (const c of root.children) {
    if (classList(c, cls)) out.push(c);
    // 桩的 querySelector 备忘节点也要扫（移除按钮挂在 .t-actions 备忘上）
    if (c._memo) Object.values(c._memo).forEach((m) => walkClasses(m, cls, out));
    walkClasses(c, cls, out);
  }
  return out;
}
function findByClass(root, cls) { return walkClasses(root, cls, []); }

function makeDocument(readyState) {
  const registry = {};
  const dcl = [];
  const listeners = {};
  // 真实 index.html 里这些节点初始带 hidden 属性，沙箱按同一初始态建桩。
  const initiallyHidden = { 'op-drawer': 1, 'op-drawer-scrim': 1, 'qr-modal': 1 };
  return {
    readyState,
    // online-login.js 开/关节点时会给 <html> 切换 qr-modal-open 类。
    documentElement: { classList: makeClassList() },
    _registry: registry,
    getElementById(id) {
      if (!registry[id]) {
        const node = makeEl(id);
        if (initiallyHidden[id]) node.hidden = true;
        registry[id] = node;
      }
      return registry[id];
    },
    createElement() { return makeEl(); },
    createTextNode(t) { return { text: String(t) }; },
    addEventListener(type, fn) {
      if (type === 'DOMContentLoaded') dcl.push(fn);
      (listeners[type] = listeners[type] || []).push(fn);
    },
    dispatchEvent(ev) {
      (listeners[ev.type] || []).forEach((fn) => fn(ev));
      return true;
    },
    // 测试可查某类型事件的监听数。
    _listenerCount(type) { return (listeners[type] || []).length; },
    // 只服务 paintLoggedIn 的 .op-account[data-source="x"] 选择器
    querySelector(sel) {
      const m = /^\.([\w-]+)\[data-source="([^"]+)"\]$/.exec(sel);
      if (!m) return null;
      const accounts = registry['op-accounts'];
      if (!accounts) return null;
      return accounts.children.find(
        (c) => classList(c, m[1]) && c.dataset.source === m[2]
      ) || null;
    },
    async fireDCL() { dcl.forEach((fn) => fn()); await ticks(); },
  };
}

// ---------------------------------------------------------------------------
// 可控时钟
// ---------------------------------------------------------------------------

function makeClock() {
  const timers = [];
  let seq = 0;
  return {
    pending() { return timers.filter((t) => !t.cancelled); },
    setTimeout(fn, ms) {
      const t = { id: ++seq, fn, ms, cancelled: false };
      timers.push(t);
      return t.id;
    },
    clearTimeout(id) {
      const t = timers.find((x) => x.id === id);
      if (t) t.cancelled = true;
    },
    async flushNext() {
      const t = this.pending()[0];
      if (!t) return false;
      t.cancelled = true;
      t.fn();
      await ticks();
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// 假 transport：按 URL 子串匹配，返回队列或抛错
// ---------------------------------------------------------------------------

function makeTransport(routes) {
  const calls = { get: [], post: [] };
  async function call(verb, url, body) {
    calls[verb.toLowerCase()].push({ url, body });
    const list = routes[verb] || [];
    for (const r of list) {
      const maxTimes = r.times == null ? Infinity : r.times;
      const matched = typeof r.match === 'function'
        ? !!r.match(url)
        : url.indexOf(r.match) >= 0;
      if (matched && (r.used || 0) < maxTimes) {
        r.used = (r.used || 0) + 1;
        if (r.throw) throw r.throw;
        const v = typeof r.returns === 'function' ? r.returns(url, body) : r.returns;
        return v;
      }
    }
    throw new Error('unmocked ' + verb + ' ' + url);
  }
  return {
    calls,
    get(url) { return call('GET', url); },
    post(url, body) { return call('POST', url, body); },
  };
}

// ---------------------------------------------------------------------------
// 沙箱装配：依次加载 online.js / online-login.js / online-playlists.js
// ---------------------------------------------------------------------------

function makeSandbox(opts) {
  const clock = makeClock();
  const doc = makeDocument(opts.readyState || 'loading');
  const spies = { refreshes: 0, toasts: [], loginStarts: [] };
  const sandbox = {
    console,
    Promise,
    Object,
    Array,
    JSON,
    Math,
    String,
    URL,
    URLSearchParams,
    encodeURIComponent,
    // 浏览器原生事件构造器的最小桩（online-playlists 用它同步左侧菜单）。
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = (init || {}).detail || null; }
    },
    // 浏览器原生 Image 的最小桩：renderQr 的 qr_image 分支要 new Image()。
    // 汽水音乐的二维码就是服务端下发的整张 PNG data URL，走的正是这一支。
    Image: class Image {
      constructor() {
        this.tagName = 'IMG';
        this.src = '';
        this.alt = '';
      }
    },
    setTimeout: clock.setTimeout.bind(clock),
    clearTimeout: clock.clearTimeout.bind(clock),
  };
  sandbox.window = sandbox;
  sandbox.document = doc;
  sandbox.VMusicTransport = opts.transport;
  sandbox.window.VMusicTransport = opts.transport;
  sandbox.window.qrcode = function () {
    return {
      addData() { return this; },
      make() { return this; },
      createSvgTag() { return '<svg class="qr-stub"/>'; },
    };
  };
  sandbox.window.toast = function (msg, kind) { spies.toasts.push({ msg, kind }); };
  sandbox.window.OnlinePlaylists = { refresh() { spies.refreshes += 1; } };
  sandbox.window.OnlineLogin = {
    start(src) { spies.loginStarts.push(src); },
    close() {},
    stopPolling() {},
  };
  vm.createContext(sandbox);

  function load(file) {
    const src = fs.readFileSync(path.join(WEB, file), 'utf8');
    vm.runInContext(src, sandbox, { filename: file });
  }
  load('online.js');
  load('online-login.js');
  load('online-playlists.js');
  // 两层界面（online-playlist-view.js）加载后，在线面板的歌单卡片改走整页
  // 详情层；不加载它就退回抽屉。下面两种沙箱分别覆盖这两条路径。
  if (opts.loadPlaylistView) {
    load('online-playlist-view.js');
    spies.layers = [];
    spies.ensureVisible = 0;
    sandbox.window.OnlinePlaylistView.bind({
      setLayer(name) { spies.layers.push(name); },
      ensureVisible() { spies.ensureVisible += 1; },
      caps: () => [],
      enqueue: async (t) => t.length,
      toast: (m, k) => spies.toasts.push({ msg: m, kind: k }),
      errText: (p, e) => p + ':' + (e && e.message),
    });
  }
  const realPlaylists = sandbox.window.OnlinePlaylists;
  // 登录状态机测试只关心「确认后通知账号区」，用间谍替换真实模块；
  // 歌单测试显式要求 realPlaylists 时保留真模块。
  if (!opts.realPlaylists) {
    sandbox.window.OnlinePlaylists = {
      refresh() { spies.refreshes += 1; },
      init() {},
    };
  }
  // 歌单测试只验证「按钮把音源 id 交给登录弹窗」，用间谍替换真实登录模块。
  if (opts.stubLogin) {
    sandbox.window.OnlineLogin = {
      start(src) { spies.loginStarts.push(src); },
      close() {},
      stopPolling() {},
    };
  }
  return { sandbox, clock, doc, spies, realPlaylists };
}

// Online 需要的宿主（app.js 真实注入的那一版最小集）
function bindOnline(env, extra) {
  const ui = {
    onlineBody: env.doc.getElementById('online-body'),
    onlineCount: env.doc.getElementById('online-count'),
    onlineSentinel: env.doc.getElementById('online-sentinel'),
    onlineChips: env.doc.getElementById('online-chips'),
    onlineSource: { value: 'netease' },
    onlineQ: { value: '' },
    onlineGo: {},
    cookieRows: makeEl('cookie-rows'),
    playpause: { classList: { add() {}, remove() {} } },
    nowTitle: makeEl('now-title'), nowArtist: makeEl('now-artist'),
    barTitle: makeEl('bar-title'), barSub: makeEl('bar-sub'),
    nowTech: { textContent: '', hidden: false },
    ambient: null, ambientImg: { style: {} },
  };
  const setStateQueueCalls = [];
  env.sandbox.window.Online.bind(Object.assign({
    ui,
    state: { byId: new Map(), current: null },
    setStateQueue: (ids, start) => setStateQueueCalls.push({ ids, start }),
    applyQueue() {},
    paintArt() {},
    probeImage: async () => true,
    fmt: () => '1:00',
    toast: (m, k) => env.spies.toasts.push({ msg: m, kind: k }),
    errText: (p, e) => p + ':' + (e && e.message),
  }, extra || {}));
  return { ui, setStateQueueCalls };
}

const T = (o) => ({ source: 'netease', id: '1', title: 'T1', artist: 'A', album: 'L',
  duration_ms: 1000, cover: null, playable: true, vip_only: false, track_ref: {}, ...o });

// ---------------------------------------------------------------------------
// 1. 扫码状态机
// ---------------------------------------------------------------------------

async function loginScenario(pollStates, opts) {
  opts = opts || {};
  const polls = pollStates.slice();
  const cancelBodies = [];
  const transport = makeTransport({
    POST: [
      { match: '/v1/online/qr/start', returns: Object.assign(
          { ticket: 'TK-1', qr_text: 'https://x/codekey=TK-1', poll_ms: 1 },
          opts.startReturns || {}
        ),
        ...(opts.startThrow ? { throw: opts.startThrow } : {}) },
      { match: '/v1/online/qr/cancel', returns: { ok: true } },
      { match: '/v1/online/cookie', returns: opts.cookieResult || { signedIn: false } },
    ],
    GET: [
      { match: '/v1/online/qr/poll', returns: () => {
        const s = polls.shift() || 'waiting';
        return typeof s === 'object' ? s : { state: s };
      } },
    ],
  });
  const origPost = transport.post;
  transport.post = async function (url, body) {
    if (url.indexOf('/v1/online/qr/cancel') >= 0) cancelBodies.push(body);
    return origPost(url, body);
  };
  const env = makeSandbox({ transport });
  const modal = env.doc.getElementById('qr-modal');
  const status = env.doc.getElementById('qr-status');
  const canvas = env.doc.getElementById('qr-canvas');

  await env.sandbox.window.OnlineLogin.start('netease');
  await ticks();
  return { env, modal, status, canvas, clock: env.clock, cancelBodies, transport };
}

(async function main() {
  // ---- 1.1 waiting → scanned → confirmed：轮询推进、确认后停表关窗 ----
  section('扫码状态机：waiting/scanned/confirmed');
  {
    const s = await loginScenario(['waiting', 'scanned', 'confirmed']);
    eq(s.modal.hidden, false, 'start 后弹窗打开');
    ok(s.canvas.innerHTML.indexOf('qr-stub') >= 0, 'qr_text 走本地 qrcode 渲染 SVG');
    ok(s.clock.pending().length === 1, 'renderQr 后安排 1 个轮询定时器');

    await s.clock.flushNext();
    ok(/扫码登录/.test(s.status.textContent) && /App/.test(s.status.textContent), 'waiting 态文案（含扫码 App 引导）');
    ok(s.clock.pending().length === 1, 'waiting 后继续轮询');

    await s.clock.flushNext();
    eq(s.status.textContent, '已扫码，请在手机上确认登录', 'scanned 态文案');
    ok(s.clock.pending().length === 1, 'scanned 后继续轮询');

    await s.clock.flushNext();
    eq(s.status.textContent, '登录成功', 'confirmed 态文案');
    eq(s.modal.hidden, true, 'confirmed 后关闭弹窗');
    eq(s.clock.pending().length, 0, 'confirmed 后停掉所有轮询');
    eq(s.env.spies.refreshes, 1, 'confirmed 后触发 OnlinePlaylists.refresh');
  }

  // ---- 1.2 关窗：cancel 带真实票据、停表、幂等 ----
  section('关窗 cancel 与幂等');
  {
    const s = await loginScenario(['waiting']);
    await s.clock.flushNext(); // 进入 waiting，有一个挂着的定时器
    s.env.sandbox.window.OnlineLogin.close();
    eq(s.modal.hidden, true, 'close 后弹窗关闭');
    eq(s.cancelBodies.length, 1, 'cancel 只发一次');
    eq(s.cancelBodies[0] && s.cancelBodies[0].ticket, 'TK-1', 'cancel 带真实 ticket');
    eq(s.cancelBodies[0] && s.cancelBodies[0].source, 'netease', 'cancel 带 source');
    eq(s.clock.pending().length, 0, 'close 后定时器全部取消');
    s.env.sandbox.window.OnlineLogin.close();
    eq(s.cancelBodies.length, 1, '重复 close 不发第二次 cancel');
  }

  // ---- 1.3 expired：停轮询、画布置暗可点刷新 ----
  section('expired 态');
  {
    const s = await loginScenario(['expired']);
    await s.clock.flushNext();
    eq(s.clock.pending().length, 0, 'expired 后不再轮询');
    eq(s.canvas.style.opacity, '.4', 'expired 后画布置暗');
    eq(typeof s.canvas.onclick, 'function', 'expired 后画布可点');
    const before = s.transport.calls.post.length;
    s.canvas.onclick();
    await ticks();
    ok(s.transport.calls.post.length > before, '点画布重新发起 qr/start');
  }

  // ---- 1.3b qr_image：服务端直接下发整张图（汽水音乐走这条）----
  section('qr_image 优先于本地二维码库渲染');
  {
    const s = await loginScenario(['waiting', 'confirmed'], {
      startReturns: { qr_image: 'data:image/png;base64,AAA' },
    });
    const img = s.canvas.children[0];
    ok(img && img.tagName === 'IMG', 'qr_image 渲染成 <img>');
    eq(img.src, 'data:image/png;base64,AAA', 'img.src 就是服务端给的 data URL');
    eq(img.alt, '登录二维码', 'img 有可读替代文本');
    // 服务端已经给好图，就不要再走本地二维码库兜底。
    ok(s.canvas.innerHTML.indexOf('qr-stub') < 0, '不再用本地 qrcode 兜底');
  }

  // ---- 1.4 mfa_required：上游要二次验证，本机做不了，终局不空转 ----
  section('mfa_required 态（上游要求二次安全验证）');
  {
    const s = await loginScenario(['mfa_required']);
    await s.clock.flushNext();
    eq(s.clock.pending().length, 0, 'mfa_required 后停轮询，不空转到超时');
    ok(/二次安全验证/.test(s.status.textContent), '如实说明本机无法完成');
    ok(/cookie/.test(s.status.textContent), '引导改用手动 cookie 导入');
    // 不是「过期重扫」，而是这条路走不通：弹窗留着让用户改走 cookie。
    eq(s.modal.hidden, false, '弹窗保留，用户可改走 cookie');
  }

  // ---- 1.4 start 被 404 能力闸门拒绝：提示 cookie，不安排轮询 ----
  section('start 404 回落 cookie');
  {
    const s = await loginScenario([], { startThrow: Object.assign(new Error('cap'), { status: 404 }) });
    ok(s.status.textContent.indexOf('cookie') >= 0, '404 文案引导 cookie 登录');
    eq(s.clock.pending().length, 0, '404 后不安排轮询');
    eq(s.env.spies.refreshes, 0, '404 不触发 refresh');
  }

  // ---- 1.5 轮询网络异常：保守重试 ----
  section('轮询网络异常重试');
  {
    let n = 0;
    const transport = makeTransport({
      POST: [{ match: '/v1/online/qr/start', returns: { ticket: 'TK-2', qr_text: 'x', poll_ms: 2 } }],
      GET: [{ match: '/v1/online/qr/poll', returns: () => {
        n += 1;
        if (n === 1) throw new Error('network down');
        return { state: 'waiting' };
      } }],
    });
    const env = makeSandbox({ transport });
    await env.sandbox.window.OnlineLogin.start('netease');
    await ticks();
    await env.clock.flushNext();
    const status = env.doc.getElementById('qr-status');
    ok(status.textContent.indexOf('请求失败') >= 0 && status.textContent.indexOf('network down') >= 0,
      '网络失败显示带原文的重试文案');
    ok(status.textContent.indexOf('重试') >= 0, '网络失败文案提示会重试');
    ok(env.clock.pending().length === 1, '网络失败后重新安排轮询');
    await env.clock.flushNext();
    ok(/扫码登录/.test(status.textContent) && /App/.test(status.textContent), '重试成功后回到 waiting 文案（含扫码 App 引导）');
  }

  // ---- 1.6 cookie 兜底：signedIn 由后端回读判定，绝不前端假装成功 ----
  section('cookie 保存判定');
  {
    const transport = makeTransport({
      POST: [
        { match: '/v1/online/qr/start', throw: Object.assign(new Error('cap'), { status: 404 }) },
        { match: '/v1/online/cookie', returns: { signedIn: false } },
      ],
    });
    const env = makeSandbox({ transport });
    await env.sandbox.window.OnlineLogin.start('qq');
    await ticks();
    const input = env.doc.getElementById('qr-cookie-input');
    const saveBtn = env.doc.getElementById('qr-cookie-save');
    const modal = env.doc.getElementById('qr-modal');
    input.value = 'foo=bar';
    await saveBtn.onclick();
    await ticks();
    eq(modal.hidden, false, 'signedIn=false 时弹窗保留，不假装成功');
    ok(env.doc.getElementById('qr-status').textContent.indexOf('未判定为登录态') >= 0,
      'false 时给出明确文案');
    eq(env.spies.refreshes, 0, 'false 时不 refresh');
  }
  {
    const transport = makeTransport({
      POST: [
        { match: '/v1/online/qr/start', throw: Object.assign(new Error('cap'), { status: 404 }) },
        { match: '/v1/online/cookie', returns: { signedIn: true } },
      ],
    });
    const env = makeSandbox({ transport });
    await env.sandbox.window.OnlineLogin.start('qq');
    await ticks();
    env.doc.getElementById('qr-cookie-input').value = 'MUSIC_U=x';
    await env.doc.getElementById('qr-cookie-save').onclick();
    await ticks();
    eq(env.doc.getElementById('qr-modal').hidden, true, 'signedIn=true 才关窗');
    eq(env.spies.refreshes, 1, 'true 时 refresh 账号区');
    ok(env.spies.toasts.some((t) => t.msg.indexOf('登录成功') >= 0), 'true 时 toast 登录成功');
  }

  // -------------------------------------------------------------------------
  // 2. online.js 聚合 / 单源搜索
  // -------------------------------------------------------------------------

  section('All 聚合：两组成一失败');
  {
    const transport = makeTransport({
      GET: [{
        match: '/v1/online/search/all',
        returns: {
          query: '晴天',
          results: [
            { source: 'netease', total: 2, tracks: [T({ id: '1' }), T({ id: '2' })] },
            { source: 'qq', total: 1, tracks: [T({ source: 'qq', id: '9' })] },
          ],
          failed: [{ source: 'kugou', code: 'upstream_timeout', message: '超时了' }],
        },
      }],
    });
    const env = makeSandbox({ transport });
    bindOnline(env);
    env.sandbox.window.Online.state.source = 'all';
    env.sandbox.window.Online.state.q = '晴天';
    env.sandbox.window.Online.search();
    await ticks();
    const body = env.doc.getElementById('online-body');
    eq(findByClass(body, 'all-group-head').length, 2, '渲染 2 个分组头');
    eq(findByClass(body, 'all-failed').length, 1, '渲染 1 条失败源提示');
    eq(findByClass(body, 'online-row').length, 3, '渲染 3 行曲目');
    const failed = findByClass(body, 'all-failed')[0];
    ok(failed.textContent.indexOf('kugou') >= 0 && failed.textContent.indexOf('超时了') >= 0,
      '失败条带源名与原文');
    eq(env.doc.getElementById('online-count').textContent, '3 首', '计数为三源合计');
    eq(env.sandbox.window.Online.state.aggregate, true, 'state 标记 aggregate');
  }

  section('All 空查询：不发请求给提示');
  {
    const transport = makeTransport({ GET: [] });
    const env = makeSandbox({ transport });
    bindOnline(env);
    env.sandbox.window.Online.state.source = 'all';
    env.sandbox.window.Online.state.q = '  ';
    env.sandbox.window.Online.search();
    await ticks();
    eq(transport.calls.get.length, 0, '空关键词不发任何请求');
    ok(env.doc.getElementById('online-body').innerHTML.indexOf('关键词') >= 0, '给出关键词提示');
  }

  section('切到无分类音源（QQ）：不带旧 cat 请求，chips 收起，给关键词引导');
  {
    const transport = makeTransport({
      GET: [
        { match: '/v1/online/sources', returns: { sources: [
          { id: 'netease', label: '网易云音乐', supportsCookie: true,
            cats: [{ id: 'hot', label: '热门' }, { id: 'new', label: '新歌' }], caps: [] },
          { id: 'qq', label: 'QQ音乐', supportsCookie: true, cats: [], caps: [] },
        ] } },
        { match: '/v1/online/search?', returns: { total: 2, tracks: [T({ id: '1' }), T({ id: '2' })] } },
      ],
    });
    const env = makeSandbox({ transport });
    const bound = bindOnline(env);
    // 真实下拉是带 onchange/options 的 select；桩也要能挂 onchange 和换 option。
    bound.ui.onlineSource = {
      value: 'netease', children: [],
      replaceChildren(...cs) { this.children = cs; },
    };
    env.sandbox.window.Online.init();
    await ticks(20);
    const S = env.sandbox.window.Online;
    eq(S.state.cat, 'hot', '初始（网易云）默认分类 hot');
    eq(bound.ui.onlineChips.hidden, false, '网易云显示分类条');

    // 模拟首次进入在线页：按 hot 静默预取一屏。
    S.onViewEnter();
    await ticks(20);
    const searchGets = () => transport.calls.get.filter((c) => c.url.indexOf('/v1/online/search?') >= 0).length;
    eq(searchGets(), 1, '进入页面按分类预取一次');

    // 切到 QQ：旧 cat 必须清空、chips 整排隐藏，且不再发必 400 的 cat 请求。
    bound.ui.onlineSource.value = 'qq';
    bound.ui.onlineSource.onchange();
    await ticks(20);
    eq(S.state.cat, '', '切到 QQ 后 cat 清空');
    eq(bound.ui.onlineChips.hidden, true, 'QQ 无分类，chips 整排隐藏');
    eq(searchGets(), 1, '切到 QQ 不发搜索请求（不带上一源的 cat=hot）');
    eq(env.doc.getElementById('online-count').textContent, '0 首', '计数清零，不留网易云旧数字');
    ok(env.doc.getElementById('online-body').innerHTML.indexOf('关键词') >= 0, '给出关键词检索引导');

    // 切回网易云：chips 恢复并按首个分类重新预取。
    bound.ui.onlineSource.value = 'netease';
    bound.ui.onlineSource.onchange();
    await ticks(20);
    eq(S.state.cat, 'hot', '切回网易云恢复 cat=hot');
    eq(bound.ui.onlineChips.hidden, false, '网易云分类条恢复');
    eq(searchGets(), 2, '切回网易云自动按分类再拉一屏');

    // 全新状态停在 QQ（模拟刷新后下拉保留 qq）：进页面不发必失败的预取。
    const env2 = makeSandbox({ transport: makeTransport({
      GET: [
        { match: '/v1/online/sources', returns: { sources: [
          { id: 'netease', label: '网易云音乐', supportsCookie: true, cats: [{ id: 'hot', label: '热门' }], caps: [] },
          { id: 'qq', label: 'QQ音乐', supportsCookie: true, cats: [], caps: [] },
        ] } },
        { match: '/v1/online/search?', throw: Object.assign(new Error('不该被调用'), { status: 400 }) },
      ],
    }) });
    const b2 = bindOnline(env2);
    b2.ui.onlineSource = { value: 'qq', children: [], replaceChildren(...cs) { this.children = cs; } };
    env2.sandbox.window.Online.init();
    await ticks(20);
    env2.sandbox.window.Online.onViewEnter();
    await ticks(20);
    const searchGets2 = env2.sandbox.VMusicTransport.calls.get
      .filter((c) => c.url.indexOf('/v1/online/search?') >= 0).length;
    eq(searchGets2, 0, '停在 QQ 进在线页不发空搜索');
    eq(env2.spies.toasts.length, 0, '静默预取被跳过时不弹错误 toast');
  }

  section('单源搜索：行渲染、元数据缓存、失败诚实报错');
  {
    const transport = makeTransport({
      GET: [
        { match: '/v1/online/search?', once: false, times: 1,
          returns: { total: 2, tracks: [T({ id: '1', title: '晴天' }), T({ id: '2', vip_only: true, playable: false })] } },
      ],
    });
    const env = makeSandbox({ transport });
    bindOnline(env);
    env.sandbox.window.Online.state.source = 'netease';
    env.sandbox.window.Online.state.q = '晴天';
    env.sandbox.window.Online.search();
    await ticks();
    const body = env.doc.getElementById('online-body');
    eq(findByClass(body, 'online-row').length, 2, '渲染 2 行');
    eq(findByClass(body, 'is-disabled').length, 1, 'VIP/不可播置灰 1 行');
    eq(env.sandbox.window.Online.getMeta('online:netease:1').title, '晴天', '虚拟 id 元数据已缓存');
    eq(env.sandbox.window.Online.state.aggregate, false, '单源不是 aggregate');

    // 再来一次失败的搜索
    const env2 = makeSandbox({ transport: makeTransport({ GET: [{
      match: '/v1/online/search?', throw: Object.assign(new Error('boom'), { status: 502 }),
    }] }) });
    bindOnline(env2);
    env2.sandbox.window.Online.state.q = 'x';
    env2.sandbox.window.Online.search();
    await ticks();
    eq(findByClass(env2.doc.getElementById('online-body'), 'online-row').length, 0, '失败后不留旧行');
    ok(env2.spies.toasts.some((t) => t.kind === 'error'), '失败弹错误 toast，不伪造空成功');
  }

  // -------------------------------------------------------------------------
  // 3. online-playlists.js caps 驱动
  // -------------------------------------------------------------------------

  function playlistSandbox(opts) {
    const bySource = opts.playlistsBySource || null;
    const playlistGet = bySource
      ? // 按 URL 里的 source= 分流，顺序无关（匹配函数各自唯一）。
        opts.sources.map((s) => ({
          match(url) {
            return url.indexOf('/v1/online/playlists') >= 0
              && url.indexOf('source=' + s.id) >= 0;
          },
          returns: bySource[s.id] || [],
        }))
      : [{ match: '/v1/online/playlists', ...(opts.playlistsThrow
          ? { throw: opts.playlistsThrow }
          : { returns: opts.playlists || [] }) }];
    const routes = {
      GET: [
        { match: '/v1/online/sources', returns: { sources: opts.sources } },
        { match: '/v1/online/account', ...(opts.accountThrow
          ? { throw: opts.accountThrow }
          : { returns: { source: opts.sources[0].id, nickname: '张三', vip_label: '黑胶VIP' } }) },
        ...playlistGet,
        { match: '/v1/online/playlist?', returns: opts.detail || { total: 0, tracks: [] } },
      ],
      POST: [
        { match: '/v1/online/playlist/tracks/remove', returns: { ok: true } },
        { match: '/v1/online/play', returns: { track_ids: ['online:netease:1', 'online:netease:2'], index: 0, cover: null } },
      ],
    };
    const transport = makeTransport(routes);
    // 歌单测试要保留真实 OnlinePlaylists（网格/抽屉/导出 all/open/play），
    // 只把登录弹窗换成间谍。
    const env = makeSandbox({
      transport, readyState: 'loading', stubLogin: true, realPlaylists: true,
      loadPlaylistView: opts.loadPlaylistView,
    });
    bindOnline(env);
    if (opts.loadPlaylistView) env.sandbox.window.OnlinePlaylistView.init();
    return env;
  }

  section('在线面板卡片 → 整页详情层（两层界面在场时抽屉不再接这个入口）');
  {
    const env = playlistSandbox({
      loadPlaylistView: true,
      sources: [{ id: 'netease', label: '网易云音乐', caps: ['cookie_login', 'user_playlists', 'playlist_detail'] }],
      playlists: [{ source: 'netease', id: 'p1', name: '我的歌单', track_count: 2, kind: 'created', cover: null }],
      detail: { total: 2, playlist: { id: 'p1' }, tracks: [T({ id: '1' }), T({ id: '2' })] },
    });
    await env.doc.fireDCL();
    await ticks(20);
    const card = env.doc.getElementById('op-grid').children[0];
    ok(card && classList(card, 'op-card'), '在线面板渲染出歌单卡');
    card.onclick();
    await ticks(20);
    eq(env.doc.getElementById('op-drawer').hidden, true, '抽屉不再被这个入口打开');
    ok(env.spies.layers.indexOf('online-detail') >= 0, '改走两层界面的详情层');
    ok(env.spies.ensureVisible >= 1, '先把视图切到歌单页（否则层开了也看不见）');
    eq(env.doc.getElementById('opl-rows').children.length, 2, '详情层渲染出 2 行');
  }

  // 以下抽屉用例跑在「两层界面未加载」的沙箱里，覆盖的是降级路径：
  // 生产环境两层界面一定在场，卡片点开走的是上面那一节。
  section('caps：登录态卡片 + 写能力给移除按钮');
  {
    const env = playlistSandbox({
      sources: [{ id: 'netease', label: '网易云音乐', caps: ['cookie_login', 'qr_login', 'user_playlists', 'playlist_detail', 'playlist_write'] }],
      playlists: [{ source: 'netease', id: 'p1', name: '我的歌单', track_count: 2, kind: 'created', cover: null }],
      detail: { total: 2, playlist: { id: 'p1' }, tracks: [T({ id: '1' }), T({ id: '2' })] },
    });
    await env.doc.fireDCL();
    await ticks(20);

    const card = env.doc.getElementById('op-accounts').children[0];
    ok(card.classList.contains('is-in'), '登录后卡片加 is-in');
    const nick = findByClass(card, 'op-nick')[0];
    eq(nick && nick.textContent, '张三', '昵称渲染');
    const vip = findByClass(card, 'op-vip')[0];
    eq(vip && vip.textContent, '黑胶VIP', 'vip_label 渲染');

    // 网格出现一张歌单卡
    eq(env.doc.getElementById('op-grid-head').hidden, false, '有歌单时网格标题显示');
    const gridCard = env.doc.getElementById('op-grid').children[0];
    ok(gridCard && classList(gridCard, 'op-card'), '歌单卡渲染');

    // 打开详情
    gridCard.onclick();
    await ticks(20);
    eq(env.doc.getElementById('op-drawer').hidden, false, '抽屉打开');
    eq(env.doc.getElementById('op-title').textContent, '我的歌单', '抽屉标题');
    const box = env.doc.getElementById('op-tracks');
    eq(findByClass(box, 'online-row').length, 2, '详情 2 行');
    eq(findByClass(box, 'op-remove').length, 2, '有 playlist_write → 每行带移除');
  }

  section('caps：无写能力详情不出移除按钮');
  {
    const env = playlistSandbox({
      sources: [{ id: 'kugou', label: '酷狗音乐', caps: ['cookie_login', 'user_playlists', 'playlist_detail'] }],
      playlists: [{ source: 'kugou', id: 'k1', name: '酷狗单', track_count: 1, kind: 'created' }],
      detail: { total: 1, tracks: [T({ source: 'kugou', id: '8' })] },
    });
    await env.doc.fireDCL();
    await ticks(20);
    env.doc.getElementById('op-grid').children[0].onclick();
    await ticks(20);
    const box = env.doc.getElementById('op-tracks');
    eq(findByClass(box, 'online-row').length, 1, '详情 1 行');
    eq(findByClass(box, 'op-remove').length, 0, '无 playlist_write → 不出移除按钮');
  }

  section('401：安静留在未登录态，按钮按 caps 出，不出网格，不惊叫');
  {
    const env = playlistSandbox({
      sources: [
        { id: 'netease', label: '网易云音乐', caps: ['cookie_login', 'qr_login', 'user_playlists'] },
        { id: 'qq', label: 'QQ 音乐', caps: ['cookie_login', 'user_playlists'] },
      ],
      accountThrow: Object.assign(new Error('unauthorized'), { status: 401 }),
    });
    await env.doc.fireDCL();
    await ticks(20);

    const accountsEl = env.doc.getElementById('op-accounts');
    eq(accountsEl.children.length, 2, '两个有 user_playlists 的源各一张卡');
    const ne = accountsEl.children.find((c) => c.dataset.source === 'netease');
    const qq = accountsEl.children.find((c) => c.dataset.source === 'qq');
    ok(ne && qq, '卡片按源建立');
    const neTexts = ne.children.map((c) => c.textContent);
    const qqTexts = qq.children.map((c) => c.textContent);
    ok(neTexts.indexOf('扫码登录') >= 0, '有 qr_login → 出扫码按钮');
    ok(neTexts.indexOf('cookie 登录') >= 0, 'cookie 按钮始终有');
    ok(qqTexts.indexOf('扫码登录') < 0, '无 qr_login → 不出扫码按钮');
    ok(qqTexts.indexOf('cookie 登录') >= 0, '无扫码时只剩 cookie 按钮');

    // 点 cookie 按钮 → 交给 OnlineLogin.start
    const starts = env.spies.loginStarts.length;
    qq.children.find((c) => c.textContent === 'cookie 登录').onclick();
    eq(env.spies.loginStarts.length, starts + 1, '点击触发 OnlineLogin.start');
    eq(env.spies.loginStarts[env.spies.loginStarts.length - 1], 'qq', 'start 带音源 id');

    ok(!ne.classList.contains('is-in'), '401 后仍是未登录卡');
    eq(env.doc.getElementById('op-grid-head').hidden, true, '401 后网格标题隐藏');
    eq(env.doc.getElementById('op-grid').children.length, 0, '401 后无歌单卡');
    eq(env.spies.toasts.length, 0, '401 是常态，不弹 toast');
    const playlistsCalls = env.sandbox.VMusicTransport.calls.get
      .filter((c) => c.url.indexOf('/v1/online/playlists') >= 0);
    eq(playlistsCalls.length, 0, '账号态没拿到就不发歌单请求');
  }

  section('详情整盘/随机播放走 Online.playAll');
  {
    const env = playlistSandbox({
      sources: [{ id: 'netease', label: '网易云音乐', caps: ['cookie_login', 'user_playlists', 'playlist_detail', 'playlist_write'] }],
      playlists: [{ source: 'netease', id: 'p1', name: 'P', track_count: 2, kind: 'created' }],
      detail: { total: 2, tracks: [T({ id: '1' }), T({ id: '2' })] },
    });
    await env.doc.fireDCL();
    await ticks(20);
    env.doc.getElementById('op-grid').children[0].onclick();
    await ticks(20);
    env.doc.getElementById('op-playall').onclick();
    await ticks(20);
    let playCalls = env.sandbox.VMusicTransport.calls.post.filter((c) => c.url.indexOf('/v1/online/play') >= 0);
    eq(playCalls.length, 1, '播放全部发一次 play');
    eq(playCalls[0].body.tracks.length, 2, '整盘带 2 首');
    eq(playCalls[0].body.index, 0, '从第 0 首开始');

    env.doc.getElementById('op-shuffle').onclick();
    await ticks(20);
    playCalls = env.sandbox.VMusicTransport.calls.post.filter((c) => c.url.indexOf('/v1/online/play') >= 0);
    eq(playCalls.length, 2, '随机播放再发一次 play');
    eq(playCalls[1].body.tracks.length, 2, '随机仍是 2 首');
  }

  section('抽屉遮罩与抽屉同开同关（Esc / 返回 / 点遮罩）');
  {
    const env = playlistSandbox({
      sources: [{ id: 'netease', label: '网易云音乐', caps: ['cookie_login', 'user_playlists', 'playlist_detail'] }],
      playlists: [{ source: 'netease', id: 'p1', name: 'P', track_count: 1, kind: 'created' }],
      detail: { total: 1, tracks: [T({ id: '1' })] },
    });
    await env.doc.fireDCL();
    await ticks(20);
    const drawer = env.doc.getElementById('op-drawer');
    const scrim = env.doc.getElementById('op-drawer-scrim');
    ok(drawer && scrim, '抽屉与遮罩节点都在');
    eq(drawer.hidden, true, '初始抽屉隐藏');
    eq(scrim.hidden, true, '初始遮罩隐藏');
    env.doc.getElementById('op-grid').children[0].onclick();
    await ticks(20);
    eq(drawer.hidden, false, '打开详情时抽屉显示');
    eq(scrim.hidden, false, '打开详情时遮罩一起显示');
    env.doc.getElementById('op-back').onclick();
    eq(drawer.hidden, true, '点返回抽屉关闭');
    eq(scrim.hidden, true, '点返回遮罩一起关闭');

    // 再打开，点遮罩关闭。
    env.doc.getElementById('op-grid').children[0].onclick();
    await ticks(20);
    scrim.onclick();
    eq(drawer.hidden, true, '点遮罩抽屉关闭');
    eq(scrim.hidden, true, '点遮罩遮罩自身关闭');
  }

  section('在线歌单扁平导出 + 变更事件（供左侧歌单菜单同步）');
  {
    let changed = 0;
    const env = playlistSandbox({
      sources: [
        { id: 'netease', label: '网易云音乐', caps: ['cookie_login', 'user_playlists'] },
        { id: 'qq', label: 'QQ音乐', caps: ['cookie_login', 'qr_login', 'user_playlists'] },
        { id: 'kugou', label: '酷狗音乐', caps: ['cookie_login', 'qr_login', 'user_playlists'] },
      ],
      playlistsBySource: {
        netease: [{ source: 'netease', id: 'n1', name: 'N', track_count: 3, kind: 'created' }],
        qq: [{ source: 'qq', id: 'q1', name: 'Q', track_count: 5, kind: 'created' }],
        kugou: [{ source: 'kugou', id: 'k1', name: 'K', track_count: 2, kind: 'created' }],
      },
    });
    env.doc.addEventListener('online-playlists:changed', () => { changed += 1; });
    await env.doc.fireDCL();
    await ticks(20);
    const before = changed;
    ok(before >= 1, '初次拉到歌单后派发了变更事件');
    const all = env.sandbox.window.OnlinePlaylists.all();
    eq(all.length, 3, '扁平清单包含三个源的歌单');
    eq(all[0].source, 'netease');
    eq(all[0].playlist.id, 'n1');
    eq(all[0].badgeText, '网易', '网易徽标短名');
    eq(all[1].source, 'qq');
    eq(all[1].badgeColor, '#12b7f5', 'QQ 带品牌色');
    eq(all[1].badgeText, 'QQ', 'QQ 徽标短名');
    eq(all[2].source, 'kugou');
    eq(all[2].badgeColor, '#2ca5f0', '酷狗带品牌色');
    eq(all[2].badgeText, '酷狗', '酷狗徽标短名（不裸出 source id）');

    // open() 按 source+id 找到歌单并打开抽屉。
    env.sandbox.window.OnlinePlaylists.open('qq', 'q1');
    await ticks(20);
    eq(env.doc.getElementById('op-drawer').hidden, false, 'open() 能从左侧菜单入口打开抽屉');
    eq(env.doc.getElementById('op-title').textContent, 'Q', '抽屉标题是该在线歌单');

    // open 未知 id：toast 报错，不崩。
    env.sandbox.window.OnlinePlaylists.open('qq', 'nope');
    ok(env.spies.toasts.some((t) => t.msg.indexOf('过期') >= 0), '未知歌单如实提示');
  }

  section('平台徽标：汽水补齐品牌短名与品牌色');
  {
    const env = playlistSandbox({
      sources: [{ id: 'netease', label: '网易云音乐', caps: ['cookie_login'] }],
      playlists: [],
    });
    await env.doc.fireDCL();
    await ticks(20);
    const Online = env.sandbox.window.Online;
    // 汽水此前缺徽标登记，搜索结果里会降级成裸文本「qishui」。
    eq(Online.sourceBadge('qishui').text, '汽水', '汽水徽标短名');
    eq(Online.sourceBadge('qishui').color, '#45d68f', '汽水品牌色');
    eq(Online.sourceBadge('netease').text, '网易', '网易徽标短名（回归）');
    eq(Online.sourceBadge('qq').color, '#12b7f5', 'QQ 品牌色（回归）');
    eq(Online.sourceBadge('kugou').color, '#2ca5f0', '酷狗品牌色（回归）');
    // 未登记音源回 null，由调用方兜到服务端 label，不裸出 source id。
    eq(Online.sourceBadge('ccmixter'), null, '未登记音源无徽标条目');
    // 歌单菜单与搜索行共用同一份表（online-playlists 去问 online.js）。
    const all = env.sandbox.window.OnlinePlaylists.all();
    eq(all.length, 0, '没有歌单时扁平清单为空');
  }

  section('移除失败：按钮复活并报错；成功后重拉详情');
  {
    let removeShouldFail = true;
    let removeBodies = 0;
    const transport = makeTransport({
      GET: [
        { match: '/v1/online/sources', returns: { sources: [{
          id: 'netease', label: '网易云音乐',
          caps: ['cookie_login', 'user_playlists', 'playlist_detail', 'playlist_write'] }] } },
        { match: '/v1/online/account', returns: { nickname: '张三' } },
        { match: '/v1/online/playlists', returns: [{ source: 'netease', id: 'p1', name: 'P', track_count: 1, kind: 'created' }] },
        { match: '/v1/online/playlist?', returns: { total: 1, tracks: [T({ id: '1' })] } },
      ],
      POST: [{
        match: '/v1/online/playlist/tracks/remove',
        returns: () => { if (removeShouldFail) throw Object.assign(new Error('拒绝'), { status: 403 }); return { ok: true }; },
      }],
    });
    const env = makeSandbox({ transport, readyState: 'loading' });
    bindOnline(env);
    await env.doc.fireDCL();
    await ticks(20);
    env.doc.getElementById('op-grid').children[0].onclick();
    await ticks(20);
    const btn = findByClass(env.doc.getElementById('op-tracks'), 'op-remove')[0];
    ok(btn, '有移除按钮');
    await btn.onclick({ stopPropagation() {} });
    await ticks(20);
    removeBodies = transport.calls.post.filter((c) => c.url.indexOf('remove') >= 0).length;
    eq(removeBodies, 1, '发了一次 remove');
    eq(btn.disabled, false, '失败后按钮复活');
    ok(env.spies.toasts.some((t) => t.kind === 'error' && t.msg.indexOf('移除失败') >= 0), '失败明确报错');

    removeShouldFail = false;
    await btn.onclick({ stopPropagation() {} });
    await ticks(20);
    const removes = transport.calls.post.filter((c) => c.url.indexOf('remove') >= 0);
    eq(removes.length, 2, '成功路径再发一次 remove');
    eq(removes[1].body.tracks[0].id, '1', 'remove 带平台稳定 id');
    ok(env.spies.toasts.some((t) => t.msg.indexOf('已从') >= 0), '成功 toast');
    const detailGets = transport.calls.get.filter((c) => c.url.indexOf('/v1/online/playlist?') >= 0);
    ok(detailGets.length >= 2, '移除成功后重拉详情');
  }

  // -------------------------------------------------------------------------
  console.log('\n' + checks + ' checks, ' + failures + ' failures');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('harness error:', e);
  process.exit(2);
});
