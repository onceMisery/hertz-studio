#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// 在线歌单两层界面（plugin/ui/online-playlist-view.js）的无头契约检查（零依赖、不触网）。
//
//   node scripts/check-online-playlist-view.js
//
// 检查的是这套界面最容易静默坏掉的几处：
//   1. 层级：网格层 / 详情层的进出只走宿主 setLayer，返回回得去
//   2. 三态：加载中 / 加载失败 / 空歌单 必须是三种渲染，失败不能被画成空
//   3. 分页：offset 递增、曲目追加、剩余数如实、到底收起「加载更多」；
//      「播放/加入」按钮只承诺已加载的那一段，未取全时不许写「播放全部」
//   4. 筛选：作用于已加载曲目，按钮文案跟着切成「播放 N 首 / 加入 N 首」
//   5. 加入队列：交给宿主的必须是当前可见的那批曲目
//
// 桩原则与 check-online.js 一致：DOM 只实现脚本真实用到的方法，HTTP 走可编排
// 的假 transport，定时器不做推进（本模块不用定时器）。

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
function has(v, sub, label) {
  ok(String(v).indexOf(sub) >= 0, label + ' (got ' + JSON.stringify(String(v)) + ')');
}
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
    disabled: false,
    value: '',
    tabIndex: 0,
    dataset: {},
    style: { setProperty(k, v) { this[k] = v; }, getPropertyValue() { return ''; } },
    attrs: {},
    children: [],
    parentNode: null,
    classList: makeClassList(),
    _memo: {},
    _html: '',
    onclick: null,
    onkeydown: null,
    oninput: null,
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    append(...cs) { cs.forEach((c) => this.appendChild(c)); },
    addEventListener() {},
    removeEventListener() {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    focus() {},
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

function classOf(el, cls) {
  return typeof el.className === 'string'
    && el.className.split(/\s+/).indexOf(cls) >= 0;
}
function walk(root, out) {
  if (!root || !root.children) return out;
  for (const c of root.children) {
    out.push(c);
    if (c._memo) Object.values(c._memo).forEach((m) => walk(m, out));
    walk(c, out);
  }
  return out;
}
// 按类名找（含 querySelector 备忘节点，移除按钮就挂在 .t-actions 备忘上）
function byClass(root, cls) { return walk(root, []).filter((e) => classOf(e, cls)); }
function texts(root) { return walk(root, []).map((e) => e.textContent).join(' | '); }
// 找按钮：textContent 命中且类名带 btn
function buttons(root) {
  return walk(root, []).filter((e) => classOf(e, 'btn'));
}
function btnByText(root, sub) {
  return buttons(root).filter((b) => String(b.textContent).indexOf(sub) >= 0)[0];
}

function makeDocument() {
  const registry = {};
  return {
    readyState: 'complete',
    documentElement: { classList: makeClassList() },
    _registry: registry,
    getElementById(id) {
      if (!registry[id]) registry[id] = makeEl(id);
      return registry[id];
    },
    createElement() { return makeEl(); },
    createTextNode(t) { return { text: String(t) }; },
    addEventListener() {},
    dispatchEvent() { return true; },
    querySelector() { return null; },
  };
}

function makeTransport(pages) {
  // pages: 函数 (url) => 返回体 或 抛错
  const calls = [];
  return {
    calls,
    posts: [],
    async get(url) {
      calls.push(url);
      return pages(url);
    },
    async post(url, body) {
      this.posts.push({ url, body });
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------------------
// 沙箱装配：加载 online-playlist-view.js，注入桩宿主
// ---------------------------------------------------------------------------

function makeSandbox(opts) {
  const doc = makeDocument();
  const spies = { layers: [], toasts: [], enqueued: [], played: [], collections: [], listeners: {} };
  const sandbox = {
    console, Promise, Object, Array, JSON, Math, String,
    URL, URLSearchParams, encodeURIComponent, decodeURIComponent,
    setTimeout, clearTimeout,
  };
  sandbox.window = sandbox;
  sandbox.document = doc;
  // 事件桩：真实浏览器里有，这里用注册表替——F2 的整单续载进度行靠它驱动。
  sandbox.addEventListener = (type, fn) => { (spies.listeners[type] = spies.listeners[type] || []).push(fn); };
  sandbox.removeEventListener = () => {};
  sandbox.dispatchEvent = (ev) => {
    (spies.listeners[ev.type] || []).forEach((fn) => fn(ev));
    return true;
  };
  sandbox.VMusicTransport = opts.transport;
  sandbox.window.VMusicTransport = opts.transport;

  // Online：只提供本模块用到的几个入口。row 返回带 .t-actions 的桩行，
  // 并记下激活回调（点击行的行为由调用方注入，不在本模块里）。
  sandbox.window.Online = {
    row(track, activate) {
      const row = makeEl();
      row.className = 'track online-row';
      row._track = track;
      row._activate = activate;
      spies.rows = spies.rows || [];
      spies.rows.push(row);
      return row;
    },
    safeCoverUrl(u) { return u || null; },
    // 缩略图改写：这里按网易云 CDN 的真实规则实现，卡片封面才测得出来。
    rowCoverUrl(u, px) {
      const url = u || null;
      if (!url || url.indexOf('.music.126.net/') < 0 || url.indexOf('?') >= 0) return url;
      const n = px || 90;
      return url + '?param=' + n + 'y' + n;
    },
    sourceBadge(id) {
      return id === 'netease'
        ? { text: '网易云音乐', color: '#e34c4c', icon: 'i-app-netease' }
        : null;
    },
    badge(source, label) {
      const el = makeEl();
      el.className = 'src-badge';
      el.title = label || source;
      el.innerHTML = '<use href="#i-app-netease"/>';
      return el;
    },
    playAll(tracks, index) { spies.played.push({ tracks: tracks.slice(), index }); },
    supports(source, cap) { return ((opts.caps && opts.caps[source]) || []).indexOf(cap) >= 0; },
    playCollection(source, id) { spies.collections.push({ source, id }); },
  };
  sandbox.window.OnlinePlaylists = {
    all() {
      return [
        { source: 'netease', sourceLabel: '网易云音乐', badgeColor: '#e34c4c', badgeText: '网易',
          playlist: { id: 'P1', name: '我喜欢的音乐', cover: null, track_count: 5, play_count: 120, creator: 'me', kind: 'liked' } },
        { source: 'netease', sourceLabel: '网易云音乐', badgeColor: '#e34c4c', badgeText: '网易',
          playlist: { id: 'P2', name: '华语精选', cover: null, track_count: 2, play_count: 0, creator: 'them', kind: 'created' } },
        { source: 'kugou', sourceLabel: '酷狗音乐', badgeColor: '#2ea8ff', badgeText: '酷狗',
          playlist: { id: 'K1', name: '酷狗收藏', cover: null, track_count: 3, play_count: 0, creator: 'me', kind: 'created' } },
      ];
    },
    removeButton() { return makeEl(); },
  };
  sandbox.window.toast = (m, k) => spies.toasts.push({ msg: m, kind: k });
  vm.createContext(sandbox);

  const src = fs.readFileSync(path.join(WEB, 'online-playlist-view.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'online-playlist-view.js' });

  sandbox.window.OnlinePlaylistView.bind({
    setLayer(name) { spies.layers.push(name); },
    caps(src) { return (opts.caps && opts.caps[src]) || []; },
    enqueue: async (tracks) => { spies.enqueued.push(tracks.slice()); return tracks.length; },
    toast: (m, k) => spies.toasts.push({ msg: m, kind: k }),
    errText: (p, e) => p + '：' + (e && e.message),
  });
  sandbox.window.OnlinePlaylistView.init();
  return { sandbox, doc, spies, view: sandbox.window.OnlinePlaylistView };
}

const T = (id, title, extra) => Object.assign({
  source: 'netease', id, title, artist: 'A', album: 'L',
  duration_ms: 1000, cover: null, playable: true, vip_only: false, ref: {},
}, extra || {});

function detailBody(tracks, total) {
  return { playlist: { id: 'P1', name: '我喜欢的音乐', cover: null, track_count: total, play_count: 120, creator: 'me', kind: 'liked' },
    total, tracks };
}

// ---------------------------------------------------------------------------

(async function main() {
  section('层级：网格层与详情层的进出');
  {
    const env = makeSandbox({ transport: makeTransport(() => detailBody([T('1', 'A')], 1)) });
    env.view.openGrid('netease');
    eq(env.spies.layers[0], 'online-grid', '进入网格层只通知一次 online-grid');
    // 网格层只显示该音源的歌单
    const cards = byClass(env.doc.getElementById('opl-grid-list'), 'op-card');
    eq(cards.length, 2, '网格层按音源过滤后只剩该音源的歌单');
    has(env.doc.getElementById('opl-grid-count').textContent, '2', '计数显示歌单个数');

    env.view.open('netease', 'P1', 'grid');
    await ticks();
    eq(env.spies.layers[1], 'online-detail', '从网格层进详情层');
    env.view.close();
    eq(env.spies.layers[2], 'online-grid', '详情返回回到网格层');

    const env2 = makeSandbox({ transport: makeTransport(() => detailBody([T('1', 'A')], 1)) });
    env2.view.open('netease', 'P1', 'arrange');
    await ticks();
    env2.view.close();
    eq(env2.spies.layers[1], 'arrange', '从歌单行直接进详情时返回回到排布层');
  }

  section('三态：加载中 / 加载失败 / 空歌单 是三种渲染');
  {
    const loading = makeSandbox({ transport: makeTransport(() => new Promise(() => {})) });
    loading.view.open('netease', 'P1', 'arrange');
    await ticks();
    has(loading.doc.getElementById('opl-rows').innerHTML, '正在加载歌单', '加载中给出加载态');
    has(loading.doc.getElementById('opl-sentinel').textContent, '加载中', '尾哨兵同步显示加载中');

    const err = Object.assign(new Error('登录已过期'), { code: 'auth_required' });
    const failed = makeSandbox({ transport: makeTransport(() => { throw err; }) });
    failed.view.open('netease', 'P1', 'arrange');
    await ticks();
    const box = failed.doc.getElementById('opl-rows');
    eq(byClass(box, 'opl-error').length, 1, '失败渲染成错误块而不是空列表');
    has(texts(box), '歌单加载失败：登录已过期', '失败态带上真实错误');
    has(texts(box), '重新登录', '失败态给出可操作提示');
    ok(!!btnByText(box, '重试'), '失败态给重试按钮');

    const empty = makeSandbox({ transport: makeTransport(() => detailBody([], 0)) });
    empty.view.open('netease', 'P1', 'arrange');
    await ticks();
    has(texts(empty.doc.getElementById('opl-rows')), '这个歌单是空的', '空歌单单独一句文案');
    eq(byClass(empty.doc.getElementById('opl-rows'), 'opl-error').length, 0, '空歌单不是错误');
  }

  section('分页：offset 递增、曲目追加、剩余数如实');
  {
    let n = 0;
    const transport = makeTransport((url) => {
      n += 1;
      if (url.indexOf('offset=0') >= 0) return detailBody([T('1', '第一首'), T('2', '第二首')], 5);
      return detailBody([T('3', '第三首'), T('4', '第四首'), T('5', '第五首')], 5);
    });
    const env = makeSandbox({ transport });
    env.view.open('netease', 'P1', 'arrange');
    await ticks();
    const rows = env.doc.getElementById('opl-rows');
    eq(rows.children.length, 2, '首页渲染 2 行');
    const more = env.doc.getElementById('opl-more');
    eq(more.hidden, false, '还有剩余时显示「加载更多」');
    has(more.textContent, '还有 3 首', '按钮说清还剩多少首');

    const info = env.doc.getElementById('opl-info');
    ok(!!btnByText(info, '播放已加载 2 首'), '只加载了首页时按钮说「播放已加载 N 首」');
    ok(!!btnByText(info, '加入已加载 2 首到队列'), '加入队列也只承诺已加载的那一段');
    ok(!btnByText(info, '播放全部'), '集合未取全时不许写「播放全部」');

    more.onclick();
    await ticks();
    eq(rows.children.length, 5, '加载更多后曲目追加到 5 行');
    ok(n === 2, '只发了两次请求');
    has(transport.calls[1], 'offset=2', '第二页的 offset 递增');
    eq(more.hidden, true, '加载完后收起「加载更多」');
    ok(!!btnByText(info, '播放全部 5 首'), '取全后按钮改回「播放全部 N 首」');
  }

  section('筛选：作用于已加载曲目，按钮文案跟着变');
  {
    const env = makeSandbox({
      transport: makeTransport(() => detailBody([T('1', '晴天'), T('2', '稻香'), T('3', '夜曲')], 3)),
    });
    env.view.open('netease', 'P1', 'arrange');
    await ticks();
    const info = env.doc.getElementById('opl-info');
    ok(!!btnByText(info, '播放全部 3 首'), '取完且未筛选时按钮才说「播放全部」');
    ok(!!btnByText(info, '加入全部 3 首到队列'), '取完且未筛选时按钮说「加入全部 N 首」');
    eq(!!btnByText(info, 'opl-scope-note'), false, '范围说明不是按钮');
    const note = byClass(info, 'opl-scope-note')[0];
    ok(!!note, '操作按钮下方带一条范围说明节点');
    eq(note.hidden, true, '集合已取完时范围说明收起');
    const q = env.doc.getElementById('opl-detail-q');
    q.value = '稻';
    q.oninput();
    await ticks();
    eq(env.doc.getElementById('opl-rows').children.length, 1, '筛选后只剩匹配行');
    ok(!!btnByText(info, '播放 1 首'), '筛选后按钮改成「播放 N 首」');
    ok(!!btnByText(info, '加入 1 首到队列'), '筛选后按钮改成「加入 N 首到队列」');

    btnByText(info, '加入 1 首到队列').onclick();
    await ticks();
    eq(env.spies.enqueued.length, 1, '加入队列交给宿主一次');
    eq(env.spies.enqueued[0].length, 1, '交给宿主的是筛选后的那一批，不是整盘');
    eq(env.spies.enqueued[0][0].title, '稻香', '交出去的曲目确实是被筛出来的那首');

    btnByText(info, '播放 1 首').onclick();
    await ticks();
    eq(env.spies.played.length, 1, '播放全部走 Online.playAll');
    eq(env.spies.played[0].tracks.length, 1, '播放的是筛选后的曲目');
  }

  section('曲目排布：默认封面，可切列表');
  {
    const env = makeSandbox({
      transport: makeTransport(() => detailBody([
        T('1', '晴天'),
        T('2', '稻香'),
        T('3', 'VIP 曲', { vip_only: true }),
        T('4', '已下架', { playable: false }),
      ], 4)),
    });
    env.view.open('netease', 'P1', 'arrange');
    await ticks();
    const box = env.doc.getElementById('opl-rows');
    const cards = byClass(box, 'opl-track-card');
    eq(cards.length, 4, '默认按封面铺成卡片，一卡一首');
    eq(byClass(box, 'track').length, 0, '封面排布下没有表格行');
    eq(env.doc.getElementById('opl-head').hidden, true, '封面排布收起文本表头');
    ok(classOf(box, 'is-cover'), '容器带上封面排布的类');
    has(texts(cards[0]), '晴天', '卡片上有歌名');
    has(texts(cards[0]), 'A · 0:01', '卡片上带歌手与时长');

    cards[1].onclick();
    await ticks();
    eq(env.spies.played.length, 1, '点卡片即播放');
    eq(env.spies.played[0].index, 1, '从被点的那一首开始');
    eq(env.spies.played[0].tracks.length, 4, '队列是整盘可见曲目');

    // VIP 卡不置灰、照常放行：可播与否由后端按账号 cookie 定（登录的 VIP
    // 真能取到流），前端预拦只会误伤。置灰只留给确实没有试听地址的曲目。
    ok(!classOf(cards[2], 'is-disabled'), 'VIP 可播卡不置灰');
    env.spies.played.length = 0;
    cards[2].onclick();
    await ticks();
    eq(env.spies.played.length, 1, 'VIP 卡点了正常入队');
    eq(env.spies.played[0].index, 2, 'VIP 卡从自己这一首开始');

    ok(classOf(cards[3], 'is-disabled'), '不可播卡置灰');
    env.spies.played.length = 0;
    cards[3].onclick();
    await ticks();
    eq(env.spies.played.length, 0, '不可播卡点了不播');

    env.view.setMode('list');
    await ticks();
    eq(byClass(box, 'opl-track-card').length, 0, '切列表后不再有卡片');
    eq(byClass(box, 'track').length, 4, '切列表后是表格行');
    eq(env.doc.getElementById('opl-head').hidden, false, '列表排布恢复文本表头');
    eq(env.view.state.mode, 'list', '排布状态记录为 list');

    // 切排布不重新取数：筛选词与已加载曲目都保留。
    const q = env.doc.getElementById('opl-detail-q');
    q.value = '稻';
    q.oninput();
    await ticks();
    eq(byClass(box, 'track').length, 1, '列表下的筛选照旧生效');
    env.view.setMode('cover');
    await ticks();
    eq(byClass(box, 'opl-track-card').length, 1, '切回封面后筛选词仍在生效');
    ok(env.spies.played.length === 0, '两次切换都没有触发重新取数或播放');
  }

  section('歌单过期与写能力');
  {
    const env = makeSandbox({ transport: makeTransport(() => detailBody([T('1', 'A')], 1)) });
    env.view.open('netease', 'NOPE', 'arrange');
    await ticks();
    eq(env.spies.layers.length, 0, '找不到歌单时不切层');
    has(env.spies.toasts.map((t) => t.msg).join('|'), '已过期', '找不到歌单时如实提示');
    ok(env.spies.toasts[0].kind === 'error', '提示是错误级');
  }
  {
    // 移除按钮只挂在列表排布的行上——封面卡片没有动作位（与参考实现一致：
    // 它的封面画布也没有单曲移除，移除在曲目列表里）。所以两条用例都先切列表。
    const withWrite = makeSandbox({
      transport: makeTransport(() => detailBody([T('1', 'A')], 1)),
      caps: { netease: ['playlist_write'] },
    });
    withWrite.view.open('netease', 'P1', 'arrange');
    await ticks();
    withWrite.view.setMode('list');
    await ticks();
    const row = withWrite.spies.rows[0];
    eq(row.querySelector('.t-actions').children.length, 1, '列表排布下挂移除按钮');

    const noWrite = makeSandbox({
      transport: makeTransport(() => detailBody([T('1', 'A')], 1)),
      caps: { netease: [] },
    });
    noWrite.view.open('netease', 'P1', 'arrange');
    await ticks();
    noWrite.view.setMode('list');
    await ticks();
    eq(noWrite.spies.rows[0].querySelector('.t-actions').children.length, 0, '没有该能力就不挂');

    // 封面排布下压根不建行，因此也不存在移除按钮。
    const coverOnly = makeSandbox({
      transport: makeTransport(() => detailBody([T('1', 'A')], 1)),
      caps: { netease: ['playlist_write'] },
    });
    coverOnly.view.open('netease', 'P1', 'arrange');
    await ticks();
    eq(coverOnly.spies.rows, undefined, '封面排布下不建表格行');
    eq(byClass(coverOnly.doc.getElementById('opl-rows'), 'op-remove').length, 0,
      '封面卡片上没有移除按钮');
  }

  // ---------------------------------------------------------------------------
  // F2 整单播放：集合意图的按钮路由、标签承诺与续载进度行
  // ---------------------------------------------------------------------------

  {
    section('F2 整单播放：集合意图、标签承诺与续载进度行');
    // 一页两首、总 100：永远「未取全」，hasMore 恒真——标签与按钮路由的
    // 两种分支都站得住。
    const pages = () => detailBody([T('1', 'A'), T('2', 'B')], 100);

    const withCap = makeSandbox({
      transport: makeTransport(pages),
      caps: { netease: ['playlist_detail'] },
    });
    withCap.view.openCollection({ kind: 'playlist', source: 'netease', id: 'P1', name: '歌单' }, 'arrange');
    await ticks();
    const capInfo = withCap.doc.getElementById('opl-info');
    const fullBtn = btnByText(capInfo, '播放全部');
    ok(!!fullBtn, '有 playlist_detail 能力时按钮如实承诺「播放全部」');
    eq(btnByText(capInfo, '播放已加载'), undefined, '此时不再出现「播放已加载」的旧承诺');
    fullBtn.onclick();
    eq(withCap.spies.collections.length, 1, '点击走服务端集合意图');
    eq(withCap.spies.collections[0].source, 'netease');
    eq(withCap.spies.collections[0].id, 'P1');
    eq(withCap.spies.played.length, 0, '这条路径不再把已加载页当整盘发');

    const noCap = makeSandbox({
      transport: makeTransport(pages),
      caps: { netease: [] },
    });
    noCap.view.openCollection({ kind: 'playlist', source: 'netease', id: 'P1', name: '歌单' }, 'arrange');
    await ticks();
    const ncInfo = noCap.doc.getElementById('opl-info');
    ok(!!btnByText(ncInfo, '播放已加载 2 首'), '缺能力位时退回「播放已加载」的诚实文案');
    btnByText(ncInfo, '播放已加载 2 首').onclick();
    eq(noCap.spies.collections.length, 0, '缺能力位不发集合意图（点了必 404 的入口不给）');
    eq(noCap.spies.played.length, 1, '退回整盘 tracks 路径');

    // 进度行：事件驱动，只有对上的歌单才显示；done 后消失；中断给「继续载入」。
    const evView = withCap;
    const note = () => byClass(evView.doc.getElementById('opl-info'), 'opl-load-note')[0];
    evView.sandbox.dispatchEvent({ type: 'online:collection-load', detail: { source: 'netease', id: 'P9', loaded: 52, total: 100, done: false } });
    eq(note().hidden, true, '别的歌单的进度不动本页');
    evView.sandbox.dispatchEvent({ type: 'online:collection-load', detail: { source: 'netease', id: 'P1', loaded: 52, total: 100, done: false } });
    ok(!note().hidden, '对上的歌单显示续载进度');
    ok(String(note().textContent).indexOf('52') >= 0, '进度行说清已加入多少首');
    evView.sandbox.dispatchEvent({ type: 'online:collection-load', detail: { source: 'netease', id: 'P1', loaded: 100, total: 100, done: true } });
    eq(note().hidden, true, '补完即收行');
    evView.sandbox.dispatchEvent({ type: 'online:collection-load', detail: { source: 'netease', id: 'P1', loaded: 52, total: 100, done: false, error: '平台超时' } });
    ok(String(note().textContent).indexOf('中断') >= 0, '中断要如实说');
    const retry = btnByText(note(), '继续载入');
    ok(!!retry, '中断时给「继续载入」按钮');
    retry.onclick();
    await ticks();
    eq(withCap.sandbox.VMusicTransport.posts.length, 1, '继续载入要打 refresh 端点');
    eq(withCap.sandbox.VMusicTransport.posts[0].url, '/v1/online/collection/refresh');
  }

  console.log('\n' + '─'.repeat(64));
  console.log(failures === 0
    ? `在线歌单两层界面契约检查：${checks} 项全部通过`
    : `在线歌单两层界面契约检查：${checks - failures}/${checks} 通过，${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
})();
