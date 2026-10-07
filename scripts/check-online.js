#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// 在线音源前端的无头契约检查（零依赖、不触网）。
//
//   node scripts/check-online.js
//
// 覆盖三块最容易在浏览器里「静默坏掉」的逻辑：
//   1. online-login.js 扫码状态机（waiting/scanned/confirmed/expired、
//      cancel 带真实票据、能力位 404 回落 cookie、轮询网络重试、cookie 判定、
//      登录意图归属：切平台/关窗后迟到的取码不顶掉当前画面也不复活轮询）
//   2. online.js 渐进聚合、排序、分页、竞态、缓存失效与播放意图
//   3. online-playlists.js caps 驱动（无 qr_login 不出扫码按钮、无
//      playlist_write 不出移除按钮、401 安静留在未登录态）
//
// 桩原则：DOM 只实现脚本真实用到的方法；HTTP 全部走可编排的假 transport；
// 定时器全部收进可控时钟，手动推进。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'plugin', 'ui');
const SRC_DIR = path.join(__dirname, '..', 'crates', 'hertz-studio', 'src');

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
    toggle: (c, force) => ((force === undefined ? !set.has(c) : force) ? set.add(c) : set.delete(c)),
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
// 桩里 className 与 classList 是两套（有的代码赋值、有的代码 add），断言两边都看。
function isIn(node) {
  if (!node) return false;
  if (node.classList.contains('is-in')) return true;
  return String(node.className || '').split(' ').indexOf('is-in') >= 0;
}
// 桩的 innerHTML 只存被赋过的字符串（这里代码走 appendChild，不写 innerHTML），
// 所以读文本要自己整棵子树拼。
function textOf(node) {
  return [String(node.textContent || '')].concat((node.children || []).map(textOf)).join(' ');
}

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
    querySelectorAll() { return []; },
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
    setInterval: () => 0,
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
  const onlineState = { byId: new Map(), current: null };
  env.sandbox.window.Online.bind(Object.assign({
    ui,
    state: onlineState,
    setStateQueue: (ids, start) => setStateQueueCalls.push({ ids, start }),
    applyQueue() {},
    paintArt() {},
    probeImage: async () => true,
    fmt: () => '1:00',
    toast: (m, k) => env.spies.toasts.push({ msg: m, kind: k }),
    errText: (p, e) => p + ':' + (e && e.message),
  }, extra || {}));
  env.onlineState = onlineState;
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

  // ---- 1.7 登录意图归属：切平台 / 关窗之后，迟到的取码只许作废自己 ----
  // 复现的是 2026-10 核对到的两条竞态（原文在 docs/research/mineradio-full-assessment.md §11）：
  // 旧实现把「当前 source」和「这张迟到的 ticket」拼在一起轮询，平台票跨平台无效；
  // 关窗只清定时器，撤销不了在途请求，弹窗关掉后后台还多出一个轮询。
  section('登录意图归属：A→B 切换与关窗后的迟到响应');
  {
    function deferred() {
      let settle;
      const p = new Promise((res) => { settle = res; });
      return { promise: p, resolve: settle };
    }

    function intentEnv(a, b) {
      const cancelBodies = [];
      const pollUrls = [];
      const transport = makeTransport({
        POST: [
          { match: '/v1/online/qr/cancel', returns: (url, body) => { cancelBodies.push(body); return { ok: true }; } },
          { match: '/v1/online/qr/start', returns: (url, body) =>
              (body.source === a ? qrA.promise : qrB.promise) },
        ],
        GET: [{ match: '/v1/online/qr/poll', returns: (url) => { pollUrls.push(url); return { state: 'waiting' }; } }],
      });
      const env = makeSandbox({ transport });
      return { env, cancelBodies, pollUrls };
    }

    // 情形一：先点网易云（A）再点 QQ（B），B 先返回、A 迟到。
    var qrA = deferred(); var qrB = deferred();
    let s = intentEnv('netease', 'qq');
    const OL = s.env.sandbox.window.OnlineLogin;
    const callingA = OL.start('netease');
    await ticks();
    const callingB = OL.start('qq');
    await ticks();
    qrB.resolve({ ticket: 'TK-B', qr_image: 'data:imgB', poll_ms: 2 });
    await callingB; await ticks();
    qrA.resolve({ ticket: 'TK-A', qr_image: 'data:imgA', poll_ms: 2 });
    await callingA; await ticks();

    const canvas = s.env.doc.getElementById('qr-canvas');
    eq(canvas.children[0] && canvas.children[0].src, 'data:imgB', '画面上留着 B 的二维码');
    ok(s.env.clock.pending().length === 1, '迟到的 A 不再排第二套轮询');
    await s.env.clock.flushNext();
    ok(s.pollUrls.length === 1 && /source=qq/.test(s.pollUrls[0]) && /ticket=TK-B/.test(s.pollUrls[0]),
      '轮询配对的是 B 的 source + B 的 ticket（不是 qq + TK-A）');
    ok(s.cancelBodies.some((c) => c.source === 'netease' && c.ticket === 'TK-A'),
      '迟到的 A 票按它自己的 source 尽力作废');

    // 情形二：取码还在途就关窗，然后响应才回来。
    qrA = deferred(); qrB = deferred();
    s = intentEnv('netease', 'qq');
    const modal = s.env.doc.getElementById('qr-modal');
    const callingC = s.env.sandbox.window.OnlineLogin.start('netease');
    await ticks();
    ok(modal.hidden === false, '取码时弹窗打开');
    s.env.sandbox.window.OnlineLogin.close();
    qrA.resolve({ ticket: 'TK-C', qr_image: 'data:imgC', poll_ms: 2 });
    await callingC; await ticks();
    eq(modal.hidden, true, '关窗后迟到的取码不把弹窗画回来');
    eq(s.env.clock.pending().length, 0, '关窗后不注册新的轮询');
    ok(s.cancelBodies.some((c) => c.source === 'netease' && c.ticket === 'TK-C'),
      '迟到的票仍然尽力作废，不留孤儿会话');
  }

  // -------------------------------------------------------------------------
  // 2. online.js 聚合 / 单源搜索
  // -------------------------------------------------------------------------

  section('渐进聚合：独立音源、失败重试、确定性排序');
  {
    let finishSlow;
    const slow = new Promise(r => { finishSlow = r; });
    const transport = makeTransport({ GET: [
      { match: 'source=netease', returns: { tracks: [T({ id: '1', title: '晴天 Live' })] } },
      { match: 'source=qq', returns: slow },
      { match: 'source=kugou', throw: new Error('超时了') },
    ] });
    const env = makeSandbox({ transport });
    bindOnline(env);
    const online = env.sandbox.window.Online;
    online.state.sources = ['netease', 'qq', 'kugou'].map(id => ({ id }));
    online.state.source = 'all'; online.state.q = '晴天';
    const pending = online.search();
    await ticks();
    const body = env.doc.getElementById('online-body');
    eq(findByClass(body, 'online-row').length, 1, '慢源未完成时快源已显示');
    eq(online.state.loading, true, '部分结果显示后仍记录慢源加载');
    eq(findByClass(body, 'all-failed').length, 1, '失败源独立显示');
    finishSlow({ tracks: [T({ source: 'qq', id: '9', title: '晴天' })] });
    await pending;
    eq(online.state.tracks[0].source, 'qq', '精确歌名优先于 Live 版本');
    eq(online.state.tracks.length, 2, '跨源不同版本均保留');
    eq(online.state.loading, false, '所有源完成后结束加载');
    eq(env.doc.getElementById('online-count').textContent, '2 首已加载', '显示实际加载数量');
    eq(transport.calls.get.length, 3, '每源一次并发搜索');
  }

  section('搜索竞态：新查询与清空均作废旧响应');
  {
    let finishOld;
    const transport = makeTransport({ GET: [
      { match: 'q=old', returns: new Promise(r => { finishOld = r; }) },
      { match: 'q=new', returns: { tracks: [T({ title: 'new' })] } },
    ] });
    const env = makeSandbox({ transport }); bindOnline(env);
    const online = env.sandbox.window.Online;
    online.state.q = 'old'; const old = online.search();
    online.state.q = 'new'; await online.search();
    finishOld({ tracks: [T({ title: 'old' })] }); await old;
    eq(online.state.tracks[0].title, 'new', '旧查询晚返回不覆盖新结果');
    online.state.source = 'all'; online.state.q = ''; await online.search();
    eq(online.state.tracks.length, 0, '清空聚合查询后清除结果');
    eq(online.state.loading, false, '清空结束加载状态');
  }

  section('分页：原始游标、重复去除、失败后续接、空页终止');
  {
    const batch = Array.from({ length: 30 }, (_, i) => T({ id: String(i) }));
    let fail = true;
    const transport = makeTransport({ GET: [{ match: '/v1/online/search?', returns(url) {
      const offset = Number(new URL('http://local' + url).searchParams.get('offset'));
      if (!offset) return { total: 999, tracks: batch };
      if (offset === 30) {
        if (fail) { fail = false; throw new Error('temporary'); }
        return { total: 999, tracks: batch.slice(1).concat(T({ id: '30' })) };
      }
      return { total: 999, tracks: [] };
    } }] });
    const env = makeSandbox({ transport }); bindOnline(env);
    const online = env.sandbox.window.Online;
    online.state.q = 'page'; await online.search();
    const more = () => findByClass(env.doc.getElementById('online-body'), 'search-source-status')[0].children.find(c => c.className === 'btn');
    await more().onclick();
    eq(online.state.tracks.length, 30, '追加失败保留旧结果');
    eq(more().textContent, '重试', '失败支持原位重试');
    await more().onclick();
    eq(online.state.tracks.length, 31, '重复曲目去除，新曲目保留');
    await more().onclick();
    ok(transport.calls.get[3].url.includes('offset=60'), '游标按原始响应长度推进');
    eq(more(), undefined, '空页停止继续加载，不受错误总数影响');
    const calls = transport.calls.get.length;
    await online.search();
    eq(transport.calls.get.length, calls, '相同查询使用会话缓存');
    eq(online.state.tracks.length, 31, '缓存包含已加载分页');
  }

  section('真实音源分页上限：酷狗满20条后仍能继续');
  {
    const transport = makeTransport({ GET: [{ match: '/v1/online/search?', returns(url) {
      const q = new URL('http://local' + url).searchParams;
      const limit = Math.min(Number(q.get('limit')), 20);
      const offset = Number(q.get('offset'));
      return { total: 80, tracks: Array.from({ length: limit }, (_, i) => T({ source: 'kugou', id: String(offset + i) })) };
    } }] });
    const env = makeSandbox({ transport }); bindOnline(env);
    const online = env.sandbox.window.Online;
    online.state.source = 'kugou'; online.state.q = '晴天'; await online.search();
    const status = findByClass(env.doc.getElementById('online-body'), 'search-source-status')[0];
    const more = status.children.find(c => c.className === 'btn');
    ok(!!more, '酷狗满20条仍显示加载更多');
    if (more) await more.onclick();
    eq(online.state.tracks.length, 40, '酷狗第二页追加到40条');
    ok(transport.calls.get[1] && transport.calls.get[1].url.includes('offset=20'), '后续请求使用offset=20');
  }

  section('播放意图：重复点击去重、旧返回隔离、暂停取消');
  {
    const resolvers = [];
    let ticket = 0;
    const transport = makeTransport({
      POST: [{ match: '/v1/online/play', returns: () => new Promise(resolve => resolvers.push(resolve)) }],
      GET: [{ match: '/v1/online/lyric', returns: null }],
    });
    const post = transport.post;
    transport.post = function (url, body) { ticket++; return post(url, body); };
    transport.playbackIntent = () => ticket;
    transport.isPlaybackIntent = value => value === ticket;
    const env = makeSandbox({ transport });
    const bound = bindOnline(env);
    const online = env.sandbox.window.Online;
    const first = online.playAll([T({ id: 'a' })]);
    await online.playAll([T({ id: 'a' })]);
    eq(resolvers.length, 1, '同一待加载曲目只发一次播放请求');
    const second = online.playAll([T({ id: 'b' })]);
    resolvers[1]({ track_ids: ['online:netease:b'], index: 0 }); await second;
    resolvers[0]({ track_ids: ['online:netease:a'], index: 0 }); await first;
    eq(bound.setStateQueueCalls.length, 1, '旧播放响应不能改写队列');
    eq(bound.setStateQueueCalls[0].start, 'online:netease:b', '保留最新点播曲目');
    const third = online.playAll([T({ id: 'c' })]);
    ticket++; // Another view issues pause/load while online playback is pending.
    resolvers[2]({ track_ids: ['online:netease:c'], index: 0 }); await third;
    eq(bound.setStateQueueCalls.length, 1, '共享播放意图取消旧返回');
  }

  section('缓存：刷新账号后失效；纯重复页终止');
  {
    const batch = Array.from({ length: 30 }, (_, i) => T({ id: String(i) }));
    const transport = makeTransport({ GET: [
      { match: '/v1/online/search?', returns: { tracks: batch } },
      { match: '/v1/online/sources', returns: { sources: [] } },
    ] });
    const env = makeSandbox({ transport }); bindOnline(env);
    const online = env.sandbox.window.Online;
    online.state.q = 'repeat'; await online.search();
    const status = () => findByClass(env.doc.getElementById('online-body'), 'search-source-status')[0];
    await status().children.find(c => c.className === 'btn').onclick();
    eq(online.state.tracks.length, 30, '纯重复页不重复添加');
    ok(!status().children.some(c => c.className === 'btn'), '纯重复页终止分页');
    await online.loadSources();
    await online.search();
    eq(transport.calls.get.filter(c => c.url.includes('/search?')).length, 3, '账号刷新后重新请求歌曲');
  }

  section('缓存时效与容量：过期或淘汰必须重新查询');
  {
    const transport = makeTransport({ GET: [{ match: '/v1/online/search?', returns: { tracks: [T({})] } }] });
    const env = makeSandbox({ transport }); bindOnline(env);
    const online = env.sandbox.window.Online;
    online.state.q = 'ttl'; await online.search();
    vm.runInContext('Date.now = () => 9999999999999', env.sandbox);
    await online.search();
    eq(transport.calls.get.length, 2, '超过两分钟缓存失效');
    for (let i = 0; i < 13; i++) { online.state.q = 'capacity-' + i; await online.search(); }
    online.state.q = 'capacity-0'; await online.search();
    eq(transport.calls.get.length, 16, '超过12个查询/来源条目淘汰最旧缓存');
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
          returns: { total: 3, tracks: [T({ id: '1', title: '晴天' }), T({ id: '2', vip_only: true, playable: false }), T({ id: '3', title: 'VIP但可播', vip_only: true })] } },
      ],
    });
    const env = makeSandbox({ transport });
    bindOnline(env);
    env.sandbox.window.Online.state.source = 'netease';
    env.sandbox.window.Online.state.q = '晴天';
    env.sandbox.window.Online.search();
    await ticks();
    const body = env.doc.getElementById('online-body');
    eq(findByClass(body, 'online-row').length, 3, '渲染 3 行');
    // 置灰只看 playable：VIP 曲在登录态后端真能取到流（真机验证 hires），
    // 前端不再预拦，只挂 VIP 徽标，能不能播由后端按账号 cookie 定。
    eq(findByClass(body, 'is-disabled').length, 1, '仅不可播置灰 1 行，VIP 可播不置灰');
    eq(findByClass(body, 'vip-tag').length, 2, 'VIP 徽标照挂 2 行');
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
        // accountRoutes：同一路由排多条，按 times 依次命中，用来演「第一次探到、
        // 第二次读不到」这种跨次状态变化（A6 的三态只有多次探测才看得出来）。
        ...(opts.accountRoutes
          ? opts.accountRoutes.map((r) => ({ match: '/v1/online/account', ...r }))
          : [{
              match: '/v1/online/account',
              ...(opts.accountThrow
                ? { throw: opts.accountThrow }
                : { returns: { source: opts.sources[0].id, nickname: '张三', vip_label: '黑胶VIP' } }),
            }]),
        ...playlistGet,
        { match: '/v1/online/playlist?', ...(opts.detailThrow
          ? { throw: opts.detailThrow }
          : { returns: opts.detail || { total: 0, tracks: [] } }) },
      ],
      POST: [
        { match: '/v1/online/playlist/tracks/remove', returns: { ok: true } },
        { match: '/v1/online/play', returns: {
          track_ids: ['online:netease:1', 'online:netease:2'], index: 0, cover: null,
          // F2：集合意图的响应带首页元数据（整盘形态的 playAll 不读它）。
          tracks: [
            { id: '1', title: '歌 1', artist: 'A', album: 'L', duration_ms: 1000, cover: null },
            { id: '2', title: '歌 2', artist: 'A', album: 'L', duration_ms: 1000, cover: null },
          ],
        } },
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

  section('会员资料缺失不显示为非会员');
  {
    const env = playlistSandbox({
      sources: [{ id: 'qq', label: 'QQ音乐', caps: ['cookie_login', 'user_playlists'] }],
      accountRoutes: [{ returns: { source: 'qq', nickname: '测试账号', vip_level: 0,
        membership: { state: 'unknown' } } }],
    });
    await env.doc.fireDCL();
    await ticks(20);
    const vip = findByClass(env.doc.getElementById('op-accounts'), 'op-vip')[0];
    eq(vip && vip.textContent, '会员信息暂不可用', '未知资料有独立状态，不断言无会员');
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

  // ---- A6 会话三态：探测没出结果 ≠ 未登录 ---------------------------------
  section('账号探测三态：上游没应答时保留身份，明确 401 才翻回未登录');
  {
    const V = makeSandbox({ transport: makeTransport({ GET: [], POST: [] }) }).sandbox
      .window.Online.accountVerdict;
    eq(V({ status: 401, code: 'auth_required' }), 'signed-out', '401 是授权断言');
    eq(V({ status: 403, code: 'forbidden' }), 'signed-out', '403 同样算明确未登录');
    eq(V({ status: 504, code: 'upstream_timeout' }), 'unknown', '超出不作授权断言');
    eq(V({ status: 500, code: 'internal' }), 'unknown', '服务端 5xx 不算未登录');
    eq(V(new Error('fetch failed')), 'unknown', '没有 status 的网络故障不算未登录');
    eq(V({ status: 404, code: 'capability_unsupported' }), 'unsupported', '没有账号这件事单独一档');
  }
  {
    const env = playlistSandbox({
      sources: [{ id: 'netease', label: '网易云音乐', caps: ['cookie_login', 'qr_login', 'user_playlists'] }],
      playlists: [{ source: 'netease', id: 'p1', name: '我的日常', track_count: 3, kind: 'created' }],
      detail: { total: 0, tracks: [] },
      accountRoutes: [
        { returns: { source: 'netease', nickname: '张三', vip_label: '黑胶VIP' }, times: 1 },
        { throw: Object.assign(new Error('gw timeout'), { status: 504, code: 'upstream_timeout' }) },
      ],
    });
    await env.doc.fireDCL();
    await ticks(20);

    const accountsEl = env.doc.getElementById('op-accounts');
    const first = accountsEl.children.find((c) => c.dataset.source === 'netease');
    ok(first.classList.contains('is-in'), '首屏探到账号 → 登录卡');
    ok(textOf(first).indexOf('张三') >= 0, '昵称展示出来');
    eq(env.doc.getElementById('op-grid').children.length, 1, '歌单网格已就位');

    // 第二次探测：上游 504。这不是「这台没登录」，界面不许塌回未登录。
    env.sandbox.window.OnlinePlaylists.init();
    await ticks(20);
    const again = env.doc.getElementById('op-accounts').children.find((c) => c.dataset.source === 'netease');
    ok(again.classList.contains('is-in'), '读不到账号状态时仍是登录卡（不塌回未登录）');
    ok(textOf(again).indexOf('张三') >= 0, '上次的身份保留着');
    const stale = findByClass(again, 'op-stale');
    eq(stale.length, 1, '挂一行「暂时读不到」的状态说明');
    ok(stale.length === 1 && /不代表未登录|仍按上次结果/.test(stale[0].textContent),
      '说明里不许出现「去登录」这种授权断言');
    ok(textOf(again).indexOf('扫码登录') < 0, '不许把扫码入口当成当前状态端出来');
    eq(env.doc.getElementById('op-grid').children.length, 1, '已取到的歌单不被这次故障清掉');
    const plCalls = env.sandbox.VMusicTransport.calls.get
      .filter((c) => c.url.indexOf('/v1/online/playlists') >= 0);
    eq(plCalls.length, 1, '故障那次探测不追发歌单请求');

    // 反过来：明确 401 就是授权断言，必须翻回未登录并丢掉旧身份。
    const s2 = playlistSandbox({
      sources: [{ id: 'netease', label: '网易云音乐', caps: ['cookie_login', 'qr_login', 'user_playlists'] }],
      playlists: [{ source: 'netease', id: 'p1', name: '我的日常', track_count: 3, kind: 'created' }],
      detail: { total: 0, tracks: [] },
      accountRoutes: [
        { returns: { source: 'netease', nickname: '张三' }, times: 1 },
        { throw: Object.assign(new Error('no session'), { status: 401, code: 'auth_required' }) },
      ],
    });
    await s2.doc.fireDCL();
    await ticks(20);
    s2.sandbox.window.OnlinePlaylists.init();
    await ticks(20);
    const after401 = s2.doc.getElementById('op-accounts').children.find((c) => c.dataset.source === 'netease');
    ok(!after401.classList.contains('is-in'), '明确 401 后回到未登录卡（这才是被允许作的断言）');
    ok(textOf(after401).indexOf('扫码登录') >= 0, '401 后出扫码入口');
    eq(s2.doc.getElementById('op-grid').children.length, 0, '401 后丢掉旧歌单');
    eq(findByClass(after401, 'op-stale').length, 0, '明确未登录时不挂「读不到」说明');
  }
  {
    // 登录弹窗那一侧：探测挂掉不许把已登录源翻成「点这里登录」。
    // 走 open() 而不是 init()：init 只在启动时刷顶栏，源 tab 的登录态是
    // open() 在账号态拉完之后重画的，测试要看的是那张 tab。
    let probe = 0;
    const transport = makeTransport({
      GET: [
        { match: '/v1/online/sources', returns: { sources: [{ id: 'netease', label: '网易云音乐', caps: ['qr_login'] }] } },
        { match: '/v1/settings', returns: {} },
        { match: '/v1/online/account', returns: () => {
          probe += 1;
          if (probe === 1) return { nickname: '张三', avatar: null };
          throw Object.assign(new Error('gw'), { status: 504, code: 'upstream_timeout' });
        } },
      ],
      POST: [{ match: '/v1/online/qr/', returns: { ok: true } }],
    });
    const env = makeSandbox({ transport });
    await env.sandbox.window.OnlineLogin.open();
    await ticks(20);
    const tabs = env.doc.getElementById('qr-sources');
    eq(tabs.children.length, 1, '源 tab 建出来了');
    ok(isIn(tabs.children[0]), '首探成功 → 该源标为已登录');
    ok(textOf(tabs.children[0]).indexOf('张三') >= 0, 'tab 上显示昵称');

    await env.sandbox.window.OnlineLogin.open();
    await ticks(20);
    const modal = env.doc.getElementById('qr-sources').children[0];
    ok(isIn(modal), '第二次探测挂了仍保留登录态（没探到 ≠ 没登录）');
    ok(textOf(modal).indexOf('张三') >= 0, '昵称没被这次故障抹掉');
    // 明确未登录才该翻面：同一套路由换成 401。
    let probe2 = 0;
    const t2 = makeTransport({
      GET: [
        { match: '/v1/online/sources', returns: { sources: [{ id: 'netease', label: '网易云音乐', caps: ['qr_login'] }] } },
        { match: '/v1/settings', returns: {} },
        { match: '/v1/online/account', returns: () => {
          probe2 += 1;
          if (probe2 === 1) return { nickname: '张三' };
          throw Object.assign(new Error('no session'), { status: 401, code: 'auth_required' });
        } },
      ],
      POST: [{ match: '/v1/online/qr/', returns: { ok: true } }],
    });
    const env2 = makeSandbox({ transport: t2 });
    await env2.sandbox.window.OnlineLogin.open();
    await ticks(20);
    await env2.sandbox.window.OnlineLogin.open();
    await ticks(20);
    ok(!isIn(env2.doc.getElementById("qr-sources").children[0]),
      '401 是授权断言：这时才允许翻回未登录');
  }

  // ---- A9 能力第三档：登记了但没真机验收过 ≠ 不支持，也 ≠ 已支持 ------------
  section('能力第三档：未验收的入口照常给，但标注要落在界面上');
  {
    const bare = makeSandbox({ transport: makeTransport({ GET: [], POST: [] }) }).sandbox.window.Online;
    ok(bare.isUnverified({ caps: ['qr_login'], unverified: ['qr_login'] }, 'qr_login'), '登记的未验收能力读得到');
    ok(!bare.isUnverified({ caps: ['qr_login'] }, 'qr_login'), '没有 unverified 字段就不许凭空长出标注');
    ok(!bare.isUnverified({ caps: ['qr_login'], unverified: ['qr_login'] }, 'like'), '只标登记的那一位');
    ok(!bare.isUnverified(null, 'qr_login'), '源对象缺失不报错');

    const env = playlistSandbox({
      sources: [
        { id: 'kugou', label: '酷狗音乐', caps: ['cookie_login', 'qr_login'], unverified: ['qr_login'] },
        { id: 'netease', label: '网易云音乐', caps: ['cookie_login', 'qr_login', 'user_playlists'] },
      ],
      accountThrow: Object.assign(new Error('no session'), { status: 401, code: 'auth_required' }),
    });
    await env.doc.fireDCL();
    await ticks(20);
    const cards = env.doc.getElementById('op-accounts');
    const kugou = cards.children.find((c) => c.dataset.source === 'kugou');
    const ne = cards.children.find((c) => c.dataset.source === 'netease');
    const kQr = kugou.children.find((c) => textOf(c).indexOf('扫码登录') >= 0);
    const kCookie = kugou.children.find((c) => textOf(c).indexOf('cookie 登录') >= 0);
    ok(kQr.classList.contains('is-unverified'), '未验收的扫码入口带上标注类');
    ok(textOf(kQr).indexOf('未验收') >= 0, '标注是看得见的文字，不只是 tooltip');
    ok(String(kQr.getAttribute('title')).indexOf('真机') >= 0, 'tooltip 说清是缺真机验收记录');
    ok(!kCookie.classList.contains('is-unverified'), '同源的 cookie 入口没被连带标上');
    ok(!ne.children.some((c) => c.classList.contains('is-unverified')), '没声明的源一个标注都不该有');
    // 标注不许随重绘累积：同一个按钮被反复 render 时只应有一个「未验收」。
    env.sandbox.window.OnlinePlaylists.init();
    await ticks(20);
    const kQr2 = env.doc.getElementById('op-accounts').children
      .find((c) => c.dataset.source === 'kugou')
      .children.find((c) => textOf(c).indexOf('扫码登录') >= 0);
    ok(textOf(kQr2).indexOf('未验收') >= 0, '重绘后标注还在');
  }
  {
    // 登录弹窗里的源 tab 用同一份判据（两个入口不该各写一套标注规则）。
    const transport = makeTransport({
      GET: [
        {
          match: '/v1/online/sources',
          returns: {
            sources: [{ id: 'kugou', label: '酷狗音乐', caps: ['qr_login'], unverified: ['qr_login'] }],
          },
        },
        { match: '/v1/settings', returns: {} },
        {
          match: '/v1/online/account',
          throw: Object.assign(new Error('no session'), { status: 401, code: 'auth_required' }),
        },
      ],
      POST: [{ match: '/v1/online/qr/', returns: { ok: true } }],
    });
    const env = makeSandbox({ transport });
    await env.sandbox.window.OnlineLogin.open();
    await ticks(20);
    const tab = env.doc.getElementById('qr-sources').children[0];
    ok(tab.classList.contains('is-unverified'), '弹窗里的未验收源 tab 也带标注');
    ok(textOf(tab).indexOf('未验收') >= 0, 'tab 上的标注同样看得见');
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

  section('F2 整单播放：playCollection 只发集合意图，首页元数据直接入缓存');
  {
    const env = playlistSandbox({
      sources: [{ id: 'netease', label: '网易云音乐', caps: ['cookie_login', 'playlist_detail'] }],
      playlists: [],
    });
    await env.doc.fireDCL();
    await ticks(20);
    await env.sandbox.window.Online.playCollection('netease', 'pl1');
    await ticks(20);
    const playCalls = env.sandbox.VMusicTransport.calls.post.filter((c) => c.url.indexOf('/v1/online/play') >= 0);
    eq(playCalls.length, 1, 'playCollection 发一次 play');
    eq(playCalls[0].body.tracks, undefined, '请求体不带整盘 tracks（首页由服务端取）');
    eq(playCalls[0].body.collection && playCalls[0].body.collection.kind, 'playlist', '带集合意图');
    eq(playCalls[0].body.collection.id, 'pl1', '集合 id 随意图上送');
    eq(playCalls[0].body.index, 0, '从头播');
    // 响应带的首页元数据要落到 byId：队列行不退化成平台 id，也不必逐首打详情。
    eq(env.onlineState.byId.has('online:netease:1'), true, '首页元数据入缓存（第 1 首）');
    eq(env.onlineState.byId.has('online:netease:2'), true, '首页元数据入缓存（第 2 首）');
    eq(env.onlineState.byId.get('online:netease:1').title, '歌 1');
    eq(env.onlineState.current && env.onlineState.current.id, 'online:netease:1', '当前曲指向起点');
  }

  section('收藏歌单整盘打开：playRef 不要求歌单在账号清单里');
  {
    // 收藏视图里的电台快照只有 source+id：上次会话收藏的歌单重启后可能不在
    // 首屏卡片里，playRef 必须直接按 id 拉整盘。
    const env = playlistSandbox({
      sources: [{ id: 'netease', label: '网易云音乐', caps: ['cookie_login', 'user_playlists', 'playlist_detail'] }],
      playlists: [],
      detail: { total: 2, tracks: [T({ id: '11' }), T({ id: '22' })] },
    });
    await env.doc.fireDCL();
    await ticks(20);
    await env.sandbox.window.OnlinePlaylists.playRef('netease', 'fav-pl');
    await ticks(20);
    const playCalls = env.sandbox.VMusicTransport.calls.post.filter((c) => c.url.indexOf('/v1/online/play') >= 0);
    eq(playCalls.length, 1, 'playRef 整盘入队一次');
    eq(playCalls[0].body.tracks.length, 2, '收藏歌单的两首都入队');
    eq(playCalls[0].body.index, 0, '从第一首开始');

    // 空歌单与拉取失败都如实提示，不伪造成功。
    const emptyEnv = playlistSandbox({
      sources: [{ id: 'netease', label: '网易云音乐', caps: ['cookie_login', 'user_playlists', 'playlist_detail'] }],
      playlists: [],
      detail: { total: 0, tracks: [] },
    });
    await emptyEnv.doc.fireDCL();
    await ticks(20);
    await emptyEnv.sandbox.window.OnlinePlaylists.playRef('netease', 'empty');
    await ticks(20);
    ok(emptyEnv.spies.toasts.some((t) => t.msg.indexOf('空') >= 0), '空歌单如实提示');

    const failEnv = playlistSandbox({
      sources: [{ id: 'netease', label: '网易云音乐', caps: ['cookie_login', 'user_playlists', 'playlist_detail'] }],
      playlists: [],
      detailThrow: '网络断了',
    });
    await failEnv.doc.fireDCL();
    await ticks(20);
    await failEnv.sandbox.window.OnlinePlaylists.playRef('netease', 'boom');
    await ticks(20);
    ok(failEnv.spies.toasts.some((t) => t.kind === 'error'), '拉取失败如实报错');
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
    eq(all[0].badgeIcon, '/platform-icons/netease.png', '网易徽标用网易云官方图标 PNG');
    eq(all[1].source, 'qq');
    eq(all[1].badgeColor, '#12b7f5', 'QQ 带品牌色');
    eq(all[1].badgeIcon, '/platform-icons/qq.png', 'QQ 徽标用 QQ 音乐官方图标 PNG');
    eq(all[2].source, 'kugou');
    eq(all[2].badgeColor, '#2ca5f0', '酷狗带品牌色');
    eq(all[2].badgeIcon, '/platform-icons/kugou.png', '酷狗徽标用酷狗官方图标 PNG');

    // open() 按 source+id 找到歌单并打开抽屉。
    env.sandbox.window.OnlinePlaylists.open('qq', 'q1');
    await ticks(20);
    eq(env.doc.getElementById('op-drawer').hidden, false, 'open() 能从左侧菜单入口打开抽屉');
    eq(env.doc.getElementById('op-title').textContent, 'Q', '抽屉标题是该在线歌单');

    // open 未知 id：toast 报错，不崩。
    env.sandbox.window.OnlinePlaylists.open('qq', 'nope');
    ok(env.spies.toasts.some((t) => t.msg.indexOf('过期') >= 0), '未知歌单如实提示');
  }

  section('平台徽标：app 图标 + 品牌色，未登记音源有兜底');
  {
    const env = playlistSandbox({
      sources: [{ id: 'netease', label: '网易云音乐', caps: ['cookie_login'] }],
      playlists: [],
    });
    await env.doc.fireDCL();
    await ticks(20);
    const Online = env.sandbox.window.Online;
    // 汽水此前缺徽标登记，搜索结果里会降级成裸文本「qishui」。
    eq(Online.sourceBadge('qishui').text, '汽水音乐', '汽水徽标品牌名');
    eq(Online.sourceBadge('qishui').color, '#45d68f', '汽水品牌色');
    eq(Online.sourceBadge('qishui').icon, '/platform-icons/qishui.png', '汽水官方图标 PNG');
    eq(Online.sourceBadge('netease').text, '网易云音乐', '网易徽标品牌名（回归）');
    eq(Online.sourceBadge('netease').icon, '/platform-icons/netease.png', '网易官方图标 PNG（回归）');
    eq(Online.sourceBadge('qq').color, '#12b7f5', 'QQ 品牌色（回归）');
    eq(Online.sourceBadge('qq').icon, '/platform-icons/qq.png', 'QQ 官方图标 PNG（回归）');
    eq(Online.sourceBadge('kugou').color, '#2ca5f0', '酷狗品牌色（回归）');
    eq(Online.sourceBadge('kugou').icon, '/platform-icons/kugou.png', '酷狗官方图标 PNG（回归）');
    // 酷我此前整条缺席、一直挂通用地球图标，这里钉住它的登记。
    eq(Online.sourceBadge('kuwo').text, '酷我音乐', '酷我徽标品牌名');
    eq(Online.sourceBadge('kuwo').icon, '/platform-icons/kuwo.png', '酷我官方图标 PNG');
    // 本地曲库也有一枚（唱片），且不带任何平台品牌色。
    eq(Online.sourceBadge('local').icon, 'i-app-local', '本地曲库有自己的图标');
    eq(Online.sourceBadge('local').color, null, '本地曲库不占用平台品牌色');
    // 未登记音源回 null，由调用方兜到服务端 label，不裸出 source id。
    eq(Online.sourceBadge('ccmixter'), null, '未登记音源无徽标条目');
    eq(Online.sourceIcon('ccmixter'), 'i-app-generic', '未登记音源兜到通用图标');
    // 歌单菜单与搜索行共用同一份表（online-playlists 去问 online.js）。
    const all = env.sandbox.window.OnlinePlaylists.all();
    eq(all.length, 0, '没有歌单时扁平清单为空');
  }

  section('徽标节点：画图标而非文字，平台名留在 title/aria-label');
  {
    const env = playlistSandbox({
      sources: [{ id: 'netease', label: '网易云音乐', caps: ['cookie_login'] }],
      playlists: [],
    });
    await env.doc.fireDCL();
    await ticks(20);
    const Online = env.sandbox.window.Online;
    const b = Online.badge('netease');
    // 平台徽标是位图：.src-badge 之外必须挂 .is-img（容器透明、尺寸由 CSS 钉）。
    // 桩的 className 与 classList 是两套（classList 只由 .add() 维护），
    // 这里按 className 断言。
    eq(b.className, 'src-badge is-img', '平台徽标带 src-badge + is-img 类');
    // 视觉上只有图标：不能再出现文字节点。
    eq(b.textContent, '', '徽标里不摆文字');
    ok(b.innerHTML.indexOf('src="/platform-icons/netease.png"') >= 0,
      '徽标引用网易云官方图标 PNG');
    // 图标本身说不出平台名，读屏与悬停必须能拿到。
    eq(b.title, '网易云音乐', 'title 给完整平台名');
    eq(b.getAttribute('aria-label'), '网易云音乐', 'aria-label 给完整平台名');

    const unknown = Online.badge('ccmixter', 'CCMixter');
    ok(unknown.innerHTML.indexOf('#i-app-generic') >= 0, '未登记音源画通用图标');
    eq(unknown.title, 'CCMixter', '未登记音源用服务端 label 兜底，不裸出 id');

    // 平台图标的拼字符串 <img src> 静态扫描扫不出拼写错，而且路由在
    // main.rs 的 PLATFORM_ICONS 表里——这里对「online.js 声明的路径」与
    // 「plugin/ui/platform-icons 磁盘文件」「main.rs 白名单」逐个核，任何一边
    // 漏了浏览器都只会拿到一个碎图。
    const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
    const symbols = new Set();
    const re = /<symbol\s+id="(i-[^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) symbols.add(m[1]);
    const mainRs = fs.readFileSync(path.join(SRC_DIR, 'main.rs'), 'utf8');
    ['netease', 'qq', 'kugou', 'kuwo', 'qishui'].forEach((s) => {
      const icon = Online.sourceBadge(s).icon;
      ok(/^\/platform-icons\/[\w-]+\.png$/.test(icon), s + ' 图标是站内 PNG 路径：' + icon);
      const rel = icon.slice(1);
      ok(fs.existsSync(path.join(WEB, rel)), 'plugin/ui/' + rel + ' 文件存在');
      ok(mainRs.indexOf('"' + path.basename(icon) + '"') >= 0,
        'main.rs PLATFORM_ICONS 登记了 ' + path.basename(icon));
    });
    // 本地与兜底仍是 sprite 字形，必须在 index.html 里有对应 symbol。
    ok(symbols.has(Online.sourceBadge('local').icon), 'index.html 定义了本地曲库图标');
    ok(symbols.has(Online.sourceIcon('nope')), 'index.html 定义了兜底图标');
  }

  section('列表封面：网易云走 CDN 缩略图，其余音源原样');
  {
    const env = playlistSandbox({
      sources: [{ id: 'netease', label: '网易云音乐', caps: ['cookie_login'] }],
      playlists: [],
    });
    await env.doc.fireDCL();
    await ticks(20);
    const O = env.sandbox.window.Online;
    // 上游原图 300KB+，一屏 30 首近 10MB —— 行里只有 40px，换小图才不会
    // 「等半天还是没封面」。
    eq(O.rowCoverUrl('https://p1.music.126.net/a/b.jpg'),
      'https://p1.music.126.net/a/b.jpg?param=90y90', '行里换 90px 缩略图');
    eq(O.rowCoverUrl('https://p1.music.126.net/a/b.jpg', 300),
      'https://p1.music.126.net/a/b.jpg?param=300y300', '卡片传 300');
    // 只有网易云 CDN 认这个参数，别的音源不能瞎拼。
    eq(O.rowCoverUrl('https://imge.kugou.com/stdmusic/480/x.jpg'),
      'https://imge.kugou.com/stdmusic/480/x.jpg', '酷狗 URL 原样返回');
    eq(O.rowCoverUrl(null), null, '空封面不拼参数');
    eq(O.rowCoverUrl('https://p1.music.126.net/a/b.jpg?x=1'),
      'https://p1.music.126.net/a/b.jpg?x=1', '已有 query 不再追加');
  }

  section('在线封面：网易云补详情、酷狗展开 {size}');
  {
    // 这两处坏掉的表现都是「整列曲目没有专辑封面」，浏览器里看着像前端没画，
    // 实际是后端取数的问题；不联网也能钉住源码里的取数路径。
    const neteaseRs = fs.readFileSync(
      path.join(__dirname, '..', 'crates', 'hertz-studio', 'src', 'online', 'netease.rs'), 'utf8');
    const kugouRs = fs.readFileSync(
      path.join(__dirname, '..', 'crates', 'hertz-studio', 'src', 'online', 'kugou.rs'), 'utf8');

    // 搜索接口只给 album.picId，必须靠详情接口补 picUrl。
    ok(neteaseRs.includes('const DETAIL_URL: &str = "https://music.163.com/api/song/detail"'),
      'netease.rs：登记了补封面用的歌曲详情端点');
    ok(neteaseRs.includes('fill_album_covers(ctx, &mut tracks).await'),
      'netease.rs：搜索结果走 fill_album_covers 补封面');
    ok(neteaseRs.includes('fn cover_gaps'), 'netease.rs：只给缺封面的曲目补，不重复问');
    ok(neteaseRs.includes('fn apply_detail_covers'), 'netease.rs：按 id 回填 picUrl');
    // 艺人头像兜底只属于详情接口（那里给的是真头像）；搜索映射里拿它当封面
    // 会撞上上游人人同一张的默认图，整列曲目顶着一样的灰图。
    const mStart = neteaseRs.indexOf('fn netease_track(');
    ok(mStart > 0, 'netease.rs：搜索映射函数存在');
    const mEnd = neteaseRs.indexOf('\nfn ', mStart + 20);
    const mapper = neteaseRs
      .slice(mStart, mEnd < 0 ? neteaseRs.length : mEnd)
      // 整行注释里会提到这个字段名，断言只针对真代码。
      .split('\n').filter((l) => l.trim().indexOf('//') !== 0).join('\n');
    ok(mapper.indexOf('img1v1Url') < 0, 'netease.rs：搜索映射不再拿默认艺人头像冒充封面');
    ok(neteaseRs.indexOf('img1v1Url') > 0, 'netease.rs：详情接口仍保留艺人头像兜底');

    // 酷狗下发的是模板 URL，{size} 不展开就是一张打不开的图。
    ok(kugouRs.includes('const COVER_SIZE'), 'kugou.rs：定义了封面尺寸常量');
    ok(kugouRs.includes('u.replace("{size}", COVER_SIZE)'), 'kugou.rs：展开 {size} 占位');
    ok(kugouRs.includes('cover: cover_of(item)'), 'kugou.rs：搜索曲目带上封面');
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
  // 4. 在线音源增强（2026-09）：历史 / 音质热切换 / buffering / 渐进式播放接缝
  //    这些接缝一旦被改名或回退，浏览器里只会静默坏掉；不跑浏览器，直接钉
  //    源码字符串（断言措辞已按当前真实代码校准，路径均为真实全路径）。
  // -------------------------------------------------------------------------
  section('在线音源增强（2026-09）：历史、音质、buffering 与渐进式播放接缝');
  {
    const appJs = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
    const onlineJs = fs.readFileSync(path.join(WEB, 'online.js'), 'utf8');
    const indexHtml = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
    const stateRs = fs.readFileSync(
      path.join(__dirname, '..', 'crates', 'hertz-studio', 'src', 'state.rs'), 'utf8');
    const actorRs = fs.readFileSync(
      path.join(__dirname, '..', 'crates', 'vmusic-audio', 'src', 'actor.rs'), 'utf8');

    ok(indexHtml.includes('id="op-history"'), 'index.html：最近播放历史区块容器存在');
    ok(indexHtml.includes('id="online-quality"'), 'index.html：音质档位选择器存在');
    ok(indexHtml.includes('id="online-errorbar"'), 'index.html：在线错误条容器存在');
    ok(onlineJs.includes('/v1/history'), 'online.js：引用历史端点 /v1/history');
    ok(onlineJs.includes('/v1/online/quality'), 'online.js：引用音质档位端点 /v1/online/quality');
    ok(onlineJs.includes('/v1/player/replay'), 'online.js：失败行经 /v1/player/replay 重播');
    ok(onlineJs.includes('showOnlineError'), 'online.js：暴露 showOnlineError 错误条入口');
    ok(appJs.includes("case 'buffering'"), 'app.js：快照分发处理 buffering 事件');
    ok(appJs.includes('state.queueIds'), 'app.js：state.queueIds 别名供热切换读队列下标');
    ok(actorRs.includes('LoadSource'), 'vmusic-audio actor.rs：定义 LoadSource 命令');
    ok(stateRs.includes('load_source'), 'state.rs：经 AudioHandle 调用 load_source 喂入解码源');
    const stateProduction = stateRs.split(/#\[cfg\(test\)\]\s*(?:pub(?:\([^)]*\))?\s+)?mod tests\s*\{/)[0];
    ok(!stateProduction.includes('Some(320_000)'), 'state.rs：生产取流不再硬编码 320k（测试夹具不参与检查）');
    ok(stateRs.includes('progressive::'), 'state.rs：接入 crate::online::progressive 渐进式下载');
    ok(stateRs.includes('cancel_all_downloads'), 'state.rs：统一下载中止入口 cancel_all_downloads 存在');
    ok(stateRs.includes('auto_failures'), 'state.rs：auto_failures 连续失败计数驱动自动跳曲');
    ok(!stateRs.includes('fetch_to_cache'), 'state.rs：旧整曲下载路径 fetch_to_cache 已移除');
  }

  section('曲源接力后的出处身份（F3：出处与供音分开存）');
  {
    const env = makeSandbox({});
    const O = env.sandbox.window.Online;
    ok(typeof O.relayMeta === 'function', 'Online.relayMeta 有导出');

    // 换源前：前端只有网易云那一项的元数据。
    O.remember('online:netease:n1', {
      id: 'online:netease:n1', source: 'netease', onlineId: 'n1',
      title: '晴天', artist: '周杰伦', cover: 'https://p/1.jpg',
    });
    const moved = O.relayMeta({
      track_id: 'online:qq:q9', from_track_id: 'online:netease:n1',
      from_source: 'netease', to_source: 'qq', to_label: 'QQ 音乐', title: '晴天',
      origin_source: 'netease', origin_id: 'n1', origin_label: '网易云音乐',
    });
    eq(moved.source, 'qq', '供音那一家写成新源（取流、封面、歌词都按它走）');
    eq(moved.onlineId, 'q9', '平台 id 也跟着供音那一家走');
    eq(moved.id, 'online:qq:q9', 'id 是新的虚拟 id');
    eq(moved.title, '晴天', '标题沿用原快照，界面不该跳成平台 id');
    eq(moved.origin && moved.origin.source, 'netease', '出处仍是用户当初点的那一家');
    eq(moved.origin && moved.origin.id, 'n1', '出处带平台 id（收藏、详情都要它）');
    eq(moved.origin && moved.origin.label, '网易云音乐', '出处带展示名，前端不必反查清单');
    ok(moved.relayed === true, '换过源要标出来');

    // 第二跳：出处必须还是第一家，不能跟着挪到 QQ。
    const again = O.relayMeta({
      track_id: 'online:kugou:k3', from_track_id: 'online:qq:q9',
      from_source: 'qq', to_source: 'kugou', title: '晴天',
      origin_source: 'qq', origin_id: 'q9',
    });
    eq(again.origin && again.origin.source, 'netease', '多跳接力记的仍是最初那一家');
    eq(again.origin && again.origin.id, 'n1', '第二跳不许把出处平台 id 改成 q9');
    eq(again.source, 'kugou', '而供音那一家跟着最新一跳走');

    // 平台 id 里带冒号时不能被 split 吃掉。
    const colonish = O.relayMeta({
      track_id: 'online:qq:a:b', from_track_id: 'online:netease:n2',
      to_source: 'qq', title: 'X', origin_source: 'netease', origin_id: 'n2',
    });
    eq(colonish.onlineId, 'a:b', '平台 id 里的冒号要原样保留（虚拟 id 只切前两段）');

    // 拿不到旧快照（重启后、或前端本来没这条）也不能抛。
    const cold = O.relayMeta({
      track_id: 'online:qq:z1', to_source: 'qq', title: '冷启动那首',
      origin_source: 'netease', origin_id: 'z0',
    });
    eq(cold.title, '冷启动那首', '没有旧元数据时按事件带的字段建一条');
    eq(cold.origin && cold.origin.source, 'netease', '这种时候出处取服务端给的字段');
    ok(O.relayMeta(null) === null && O.relayMeta({}) === null, '脏事件安静地不迁');
  }

  // -------------------------------------------------------------------------
  console.log('\n' + checks + ' checks, ' + failures + ' failures');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('harness error:', e);
  process.exit(2);
});
