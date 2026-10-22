#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 歌单三种浏览方式（立体歌单架 / 封面平铺 / 列表）的契约检查（零依赖、不触网）。
//
//   node scripts/check-playlist-views.js
//
// 三视图最容易坏在"看着都在、其实各说各话"上，所以这里钉四件事：
//
//   1. **同时只有一个可见**。三个容器互相独立地写 hidden，迟早出现两个同时
//      显示或一个都不显示；这条对它俩都成立才算过。
//   2. **默认档是封面墙，且旧值仍有效**。存储键沿用改造前那个，值多了一个
//      'grid'；不认识的值回落到封面墙。旧版本无条件写回过当时的兜底值，
//      所以存着 'shelf' 的老用户要走一次性迁移，而明确选了 'list' 的不能被动。
//   3. **三视图共用同一份数据**。封面墙必须从 shelfItems() 取数——另起一份
//      数据源就会出现"架子上有、墙上没有"。
//   4. **三视图共用同一条动作链路**。点播放/打开都走 dispatchPlaylistAction，
//      各自写一遍 if/else 的话，迟早有一处漏掉在线歌单那条分支。
//
// 判定与分派函数是从 app.js 里整段抠出来跑的，不是照着源码另写一份实现。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'plugin', 'ui');
// 统一成 LF：仓库在 Windows 上检出是 CRLF，按行锚点切代码段会切歪。
const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8').replace(/\r\n/g, '\n');
const APP = read('app.js');
const HTML = read('index.html');
const SHELF = read('shelf.js');

let failures = 0;
let checks = 0;
function ok(cond, label) {
  checks += 1;
  if (!cond) { failures += 1; console.error('  X ' + label); }
}
function eq(a, b, label) { ok(a === b, label + ' (got ' + JSON.stringify(a) + ')'); }
function section(name) { console.log('\n' + name); }

/// 从 app.js 里整段抠出一个函数（顶格 `}` 收尾是仓库的统一格式）。
function grab(name) {
  const head = 'function ' + name + '(';
  const start = APP.indexOf('\n' + head);
  if (start < 0) throw new Error('app.js 里找不到 ' + name);
  const end = APP.indexOf('\n}\n', start);
  if (end < 0) throw new Error(name + ' 的函数体没有以顶格 } 结束');
  return APP.slice(start + 1, end + 2);
}

function grabShelf(name) {
  const head = '  function ' + name + '(';
  const start = SHELF.indexOf('\n' + head);
  if (start < 0) throw new Error('shelf.js 里找不到 ' + name);
  const end = SHELF.indexOf('\n  }\n', start);
  if (end < 0) throw new Error(name + ' 的函数体没有以顶格 } 结束');
  return SHELF.slice(start + 1, end + 4);
}

// ---------------------------------------------------------------------------
// DOM / 存储桩
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
  };
}

function makeEl() {
  const el = {
    hidden: false,
    className: '',
    textContent: '',
    title: '',
    tabIndex: 0,
    classList: makeClassList(),
    attrs: {},
    dataset: {},
    style: {
      backgroundImage: '',
      setProperty(k, v) { this['_' + k] = v; },
      getPropertyValue(k) { return this['_' + k] || ''; },
    },
    children: [],
    _buttons: [],
    _html: '',
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { this.children.push(c); return c; },
    // 真实 DOM 的 querySelector 是递归的；卡片里 .pl-card-play 埋在
    // card > art > face 三层下，只查一层会误报成"按钮没渲染"。
    querySelector(sel) {
      const cls = sel.replace(/^\./, '');
      const walk = (node) => {
        for (const c of node.children) {
          if (String(c.className).split(/\s+/).indexOf(cls) >= 0) return c;
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this);
    },
    querySelectorAll(sel) {
      if (sel.indexOf('button[data-pl-view]') >= 0) return this._buttons;
      return [];
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = String(v); if (v === '') this.children = []; },
  });
  return el;
}

function makeButtons(values) {
  return values.map((v) => {
    const b = makeEl();
    b.dataset.plView = v;
    return b;
  });
}

// ---------------------------------------------------------------------------
// 1. 切档：三容器互斥 + 持久化
// ---------------------------------------------------------------------------

function checkSwitching() {
  section('切档：三种排布互斥，选择被持久化');

  const emptyEl = makeEl();
  const ui = {
    shelf: makeEl(),
    playlistList: makeEl(),
    playlistGrid: makeEl(),
    plViews: makeEl(),
  };
  // 与 index.html 的初始态一致：默认档封面墙可见，架子不带 on、列表带 hidden。
  ui.playlistList.hidden = true;
  ui.plViews._buttons = makeButtons(['shelf', 'grid', 'list']);

  const store = new Map();
  let gridRenders = 0;
  let placements = 0;

  const sandbox = {
    console, Object, Array, JSON, Set, Map, String, Number,
    ui,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    PL_VIEW_KEY: 'vmusic.playlists.mode',
    renderPlaylistGrid: () => { gridRenders += 1; },
    placeOnlineBlock: () => { placements += 1; },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    'var playlistMode = "grid";\n' + grab('setPlaylistMode') + '\n__set = setPlaylistMode;',
    sandbox,
    { filename: 'app.js:setPlaylistMode' }
  );
  const set = sandbox.__set;

  /// 三个排布里"看得见"的那几个。空数组 = 一个都没显示，多于一个 = 叠着显示。
  const visible = () => {
    const out = [];
    if (ui.shelf.classList.contains('on')) out.push('shelf');
    if (!ui.playlistList.hidden) out.push('list');
    if (!ui.playlistGrid.hidden) out.push('grid');
    return out;
  };

  eq(visible().join(','), 'grid', '初始状态只有默认档封面墙可见');

  set('shelf');
  eq(visible().join(','), 'shelf', '切到歌单架后只有架子可见');
  eq(ui.shelf.classList.contains('on'), true, '架子挂上 on');
  eq(store.get('vmusic.playlists.mode'), 'shelf', '选择写进 localStorage');

  set('list');
  eq(visible().join(','), 'list', '切到列表后只有列表可见');
  eq(store.get('vmusic.playlists.mode'), 'list', '选择跟着改');
  eq(gridRenders, 0, '离开展示排布不再渲染网格');

  set('grid');
  eq(visible().join(','), 'grid', '切到封面后只有网格可见');
  eq(ui.playlistGrid.hidden, false, '网格容器显出来');
  eq(gridRenders, 1, '进入封面排布时渲染一次');
  eq(sandbox.playlistMode, 'grid', '模块状态跟着改');

  section('切档：控件选中态与容器一致');
  set('shelf');
  const pressed = ui.plViews._buttons.map((b) => b.getAttribute('aria-pressed'));
  eq(pressed.join(','), 'true,false,false', '只有「歌单架」是选中的');
  const active = ui.plViews._buttons.map((b) => b.classList.contains('active'));
  eq(active.join(','), 'true,false,false', 'active 类与 aria-pressed 同步');

  section('切档：认识的值只有三个，其余回落到封面墙');
  set('把容器名拼错');
  eq(visible().join(','), 'grid', '不认识的值回落到封面墙而不是全隐藏');
  eq(store.get('vmusic.playlists.mode'), 'grid', '回落结果也写回存储，自我修复');
  set('');
  eq(visible().join(','), 'grid', '空串同样回落到封面墙');

  section('切档：从详情返回时不写存储');
  store.set('vmusic.playlists.mode', 'shelf');
  set('list', false);
  eq(store.get('vmusic.playlists.mode'), 'shelf', 'persist=false 不动存储');
  eq(visible().join(','), 'list', '但显隐照常切');
  eq(placements, 7, '每次切档都通知在线分区搬家（含 persist=false 那次）');
}

// ---------------------------------------------------------------------------
// 2. 默认档与旧值迁移
// ---------------------------------------------------------------------------

function checkDefaultView() {
  section('默认档：index.html 的初始标记就是封面墙');

  ok(/<div class="pl-grid" id="playlist-grid"><\/div>/.test(HTML),
    '#playlist-grid 不带 hidden（默认档可见）');
  ok(/<div class="shelf" id="shelf">/.test(HTML),
    '#shelf 不带 on（默认档下架子是收着的）');
  ok(/<button class="chip active" type="button" data-pl-view="grid" aria-pressed="true">/.test(HTML),
    '「封面」那颗 chip 的初始选中态与容器一致');
  ok(!/data-pl-view="shelf" aria-pressed="true"/.test(HTML), '「歌单架」不再是初始选中');
  ok(APP.includes("let playlistMode = 'grid'"), '模块初值与默认档一致');

  section('默认档：开机恢复不写回存储');
  // 旧实现无条件持久化那次恢复，把「没选过」钉成「选过歌单架」，
  // 默认档就再也改不动了。这条只钉得住源码形状，行为在下一节的桩里跑。
  ok(/setPlaylistMode\(migratePlaylistView\(saved\), false\)/.test(APP),
    'initPlaylistViews 恢复时传 persist=false');

  section('默认档：旧值一次性迁移');
  const run = (stored, marker) => {
    const store = new Map();
    if (stored !== null) store.set('vmusic.playlists.mode', stored);
    if (marker) store.set('vmusic.playlists.viewV2', '1');
    const sandbox = {
      console, Object, String,
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
      },
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(
      "const PL_VIEW_KEY = 'vmusic.playlists.mode';\n"
        + "const PL_VIEW_V2_KEY = 'vmusic.playlists.viewV2';\n"
        + grab('migratePlaylistView') + '\n__m = migratePlaylistView;',
      sandbox, { filename: 'app.js:migratePlaylistView' }
    );
    return { got: sandbox.__m(stored), store };
  };

  let r = run(null, false);
  eq(r.got, null, '没选过的用户交回兜底值，迁移不插手');
  eq(r.store.size, 0, '这条路一个字节都不写');

  r = run('list', false);
  eq(r.got, 'list', '明确选过「列表」的原样保留');
  eq(r.store.has('vmusic.playlists.viewV2'), false, '不该动的值连标记都不落');

  r = run('shelf', false);
  eq(r.got, 'grid', '旧默认档钉下的「歌单架」换成封面墙');
  eq(r.store.get('vmusic.playlists.mode'), 'grid', '存储里的旧值同步改掉，别下次开机又读回 shelf');
  eq(r.store.get('vmusic.playlists.viewV2'), '1', '落下一次性标记');

  r = run('shelf', true);
  eq(r.got, 'shelf', '迁移之后用户再主动选歌单架，就不该被改回去');
  eq(r.store.get('vmusic.playlists.mode'), 'shelf', '带标记时不重写值');
}

// ---------------------------------------------------------------------------
// 3. 动作分派：本地与在线两条链路
// ---------------------------------------------------------------------------

function checkDispatch() {
  section('动作：三种排布走同一条分派，本地/在线各归各的链路');

  const calls = [];
  const sandbox = {
    console, Object, Array, JSON, Set, Map, String, Number,
    state: { playlists: [{ id: 'p1', name: '本地一' }] },
    onlineShelfItems: () => [
      { id: 'online:netease:5', source: 'netease', refId: '5', name: '云歌单' },
    ],
    playPlaylist: (id) => calls.push(['play', id]),
    queuePlaylistNext: (id) => calls.push(['queue', id]),
    openPlaylist: (id) => calls.push(['open', id]),
    renamePlaylist: (p) => calls.push(['rename', p.id]),
    deletePlaylist: (p) => calls.push(['delete', p.id]),
    openOnlinePlaylistDetail: (src, ref, from) => calls.push(['online-open', src, ref, from]),
    OnlinePlaylists: { playRef: (src, ref, name) => calls.push(['online-play', src, ref, name]) },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(grab('dispatchPlaylistAction') + '\n__d = dispatchPlaylistAction;', sandbox, {
    filename: 'app.js:dispatchPlaylistAction',
  });
  const d = sandbox.__d;

  eq(d('p1', 'play'), true, '本地歌单的播放认得出来');
  eq(calls.pop().join(','), 'play,p1', '本地播放走 playPlaylist');
  d('p1', 'open');
  eq(calls.pop().join(','), 'open,p1', '本地打开走 openPlaylist');
  d('p1', 'queue');
  eq(calls.pop().join(','), 'queue,p1', '下一首播放走 queuePlaylistNext');

  eq(d('online:netease:5', 'play'), true, '在线歌单也认得出来');
  eq(calls.pop().join(','), 'online-play,netease,5,云歌单', '在线播放走 OnlinePlaylists.playRef');
  d('online:netease:5', 'open');
  eq(calls.pop().join(','), 'online-open,netease,5,arrange',
    '在线打开进在线详情层，返回时回到排布层');

  eq(d('online:netease:5', 'rename'), false, '在线歌单没有重命名这条路');
  eq(calls.length, 0, '不可用的动作不该转发到任何地方');
  eq(d('不存在的 id', 'play'), false, '认不出的 id 返回 false 而不是静默什么都不做');
  eq(d('', 'play'), false, '空 id 不做事');
  eq(d('p1', ''), false, '空动作不做事');
}

// ---------------------------------------------------------------------------
// 4. 封面墙渲染：本地与在线各走各的封面通道
// ---------------------------------------------------------------------------

function checkGridRendering() {
  section('封面墙：本地走封面缓存，在线用现成直链，不互相串门');

  const cards = [];
  const host = makeEl();
  const askedCovers = [];
  const placeholders = [];

  const sandbox = {
    console, Object, Array, JSON, Set, Map, String, Number,
    document: { createElement: () => makeEl() },
    ui: { playlistGrid: host },
    // 一个本地歌单（封面靠两跳解析）+ 一个在线歌单（带直链）+ 一个没有封面的在线歌单
    // + 一个只有 sprite 字形的在线歌单（咪咕没有官方 PNG）。
    shelfItems: () => [
      { id: 'p1', name: '本地一', track_count: 3 },
      { id: 'online:netease:5', name: '云歌单', track_count: 9, online: true, coverUrl: '/api/cover/5', sourceLabel: '网易云音乐', badge: '/platform-icons/netease.png', badgeColor: '#e60026' },
      { id: 'online:qq:7', name: 'Q 歌单', track_count: 4, online: true, coverUrl: null, sourceLabel: 'QQ音乐' },
      { id: 'online:migu:9', name: '咪咕歌单', track_count: 2, online: true, coverUrl: '/api/cover/9', sourceLabel: '咪咕音乐', badge: 'i-app-generic', badgeColor: '#7a5cff' },
    ],
    plCovers: {
      state: (id) => { askedCovers.push(id); return { s: 'none', hue: 12 }; },
    },
    ThemeStudio: { artPlaceholder: (id) => { placeholders.push(id); return 'url("wallpapers/morning-01.jpg")'; } },
    dispatchPlaylistAction: () => true,
    // renderPlaylistGrid 用applyCoverBg 落封面（app.js:2420），不注入就是
    // ReferenceError: applyCoverBg is not defined —— 而**报错点出现在被测
    // 函数里**，很容易误判成业务代码坏了，实际是沙箱漏了依赖。
    //
    // 这里注入的是**独立形态下的等价实现**而不是真的applyCoverBg：后者要拖
    // 一整条链（remoteCover → transport.kind / coverCache / coverPending /
    // dbxRequest），而这组函数在独立形态下按设计就是**恒等**的
    // （app.js:530-533的注释原话：「下面每个函数对独立形态都是恒等的」）。
    // 本节要验的是「在线卡用现成直链、本地卡去问缓存」这条分工，
    // 恒等实现正好让直链原样落地，断言 `url("/api/cover/5")` 才成立。
    applyCoverBg: (el, url) => { if (el) el.style.backgroundImage = url ? `url("${url}")` : ''; },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    'var gridArts = new Map();\n'
      + grab('placeholderArt') + '\n'
      + grab('paintGridArt') + '\n'
      + grab('renderPlaylistGrid') + '\n'
      + '__render = renderPlaylistGrid;',
    sandbox,
    { filename: 'app.js:renderPlaylistGrid' }
  );
  sandbox.__render();

  eq(host.children.length, 4, '四个歌单都渲染成卡片');
  for (const c of host.children) cards.push(c);

  eq(askedCovers.join(','), 'p1',
    '只有本地歌单去问封面缓存（拿在线虚拟 id 去问会打出一个必然 404 的 /v1/playlists/{id}/tracks）');
  eq(sandbox.gridArts.size, 1, '只登记本地歌单等待封面异步就绪');
  ok(sandbox.gridArts.has('p1'), '登记的是本地那一个');

  const onlineWithCover = cards[1].querySelector('.pl-card-art');
  eq(onlineWithCover.style.backgroundImage, 'url("/api/cover/5")', '有封面的在线卡直接用直链');
  eq(onlineWithCover.classList.contains('has-art'), true, '在线卡封面上 has-art');

  section('封面墙：徽标两态，位图与 sprite 字形各走各的画法');
  const pngBadge = cards[1].querySelector('.pl-card-badge');
  eq(pngBadge.classList.contains('is-img'), true, '平台 PNG 走 is-img（容器透明，图自带品牌底色）');
  ok(/<img src="\/platform-icons\/netease\.png"/.test(pngBadge.innerHTML), 'PNG 徽标画成 <img>');
  const spriteBadge = cards[3].querySelector('.pl-card-badge');
  ok(/<use href="#i-app-generic"/.test(spriteBadge.innerHTML),
    '只有 sprite 字形的源（咪咕这类）画成 <use>，不再把 symbol id 当文字印到墙上');
  eq(spriteBadge.classList.contains('is-img'), false, '字形徽标不套透明容器，它要画品牌色方块');
  eq(spriteBadge.style.getPropertyValue('--badge'), '#7a5cff',
    '品牌色走 --badge（与 shelf.js、在线面板 .src-badge 同一条通道）');
  ok(!/badge\.textContent\s*=\s*it\.badge/.test(APP),
    '墙上不再有「把 badge 值当文字塞进去」那条分支（symbol id 不是文案）');

  ok(placeholders.indexOf('online:qq:7') >= 0, '没有封面的在线卡用壁纸占位');
  ok(placeholders.indexOf('p1') >= 0, '没有封面的本地卡同样用壁纸占位');
  ok(placeholders.indexOf('online:netease:5') < 0, '有封面的在线卡不必再铺一层占位');

  section('封面墙：卡片上的播放与打开都走统一分派');
  const localCard = cards[0];
  const actions = [];
  sandbox.dispatchPlaylistAction = (id, action) => { actions.push(id + ':' + action); return true; };
  localCard.querySelector('.pl-card-play').onclick({ stopPropagation() {} });
  eq(actions.join(','), 'p1:play', '卡上播放按钮派发 play');
  localCard.onclick();
  eq(actions.join(','), 'p1:play,p1:open', '点卡面派发 open');
  localCard.onkeydown({ key: 'Enter', preventDefault() {} });
  eq(actions.length, 3, '键盘 Enter 也能打开（卡片是 div 拼的）');

  section('封面墙：空态与歌单架给同一句话');
  const emptyHost = makeEl();
  const s2 = {
    console, Object, Array, JSON, Set, Map, String, Number,
    document: { createElement: () => makeEl() },
    ui: { playlistGrid: emptyHost },
    shelfItems: () => [],
    plCovers: { state: () => ({ s: 'none', hue: 0 }) },
    ThemeStudio: { artPlaceholder: () => '' },
    dispatchPlaylistAction: () => true,
  };
  s2.window = s2;
  vm.createContext(s2);
  vm.runInContext(
    'var gridArts = new Map();\n' + grab('placeholderArt') + '\n' + grab('paintGridArt')
      + '\n' + grab('renderPlaylistGrid') + '\n__render = renderPlaylistGrid;',
    s2, { filename: 'app.js:renderPlaylistGrid' }
  );
  s2.__render();
  ok(emptyHost.innerHTML.indexOf('还没有歌单') >= 0, '没有歌单时给的是引导文案而不是空白');
}

// ---------------------------------------------------------------------------
// 5. 歌单架在线封面走代理，迟到结果不能覆盖复用槽位
// ---------------------------------------------------------------------------

async function checkShelfCoverProxy() {
  section('歌单架：在线封面经共享代理，槽位复用后忽略迟到结果');

  const asked = [];
  const pending = [];
  const sandbox = {
    Promise,
    JSON,
    window: {
      HertzCovers: {
        resolve(url) {
          asked.push(url);
          return new Promise((resolve) => pending.push(resolve));
        },
      },
      PlaylistCovers: { state: () => ({ s: 'none', hue: 160 }) },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(grabShelf('applyCover') + '\n__apply = applyCover;', sandbox, {
    filename: 'shelf.js:applyCover',
  });

  const slot = {
    el: makeEl(),
    art: makeEl(),
  };
  slot.el.style.removeProperty = function (key) { delete this['_' + key]; };
  const firstUrl = 'https://qq.example/playlist.jpg';
  slot.el._bound = 'online:qq:q1';
  sandbox.__apply(slot, { id: 'online:qq:q1', coverUrl: firstUrl });
  eq(asked.length, 1, '在线封面交给 HertzCovers.resolve');
  ok(!slot.el.style.getPropertyValue('--sleeve-art').includes('https://'),
    '远程 URL 不直接写入歌单架 CSS');
  if (!pending.length) return;

  pending[0]('data:image/jpeg;base64,first');
  await Promise.resolve();
  await Promise.resolve();
  eq(slot.el.style.getPropertyValue('--sleeve-art'),
    'url("data:image/jpeg;base64,first")', 'CSS 使用代理返回的 data URL');
  eq(slot.el.classList.contains('has-art'), true, '解析成功后才标记有封面');

  slot.el._bound = 'online:qq:q2';
  sandbox.__apply(slot, { id: 'online:qq:q2', coverUrl: 'https://qq.example/old.jpg' });
  slot.el._bound = 'online:qq:q3';
  sandbox.__apply(slot, { id: 'online:qq:q3', coverUrl: 'https://qq.example/current.jpg' });
  pending[1]('data:image/jpeg;base64,stale');
  await Promise.resolve();
  await Promise.resolve();
  eq(slot.el.style.getPropertyValue('--sleeve-art'), '',
    '复用槽位后旧请求不能写回封面');
  pending[2]('data:image/jpeg;base64,current');
  await Promise.resolve();
  await Promise.resolve();
  eq(slot.el.style.getPropertyValue('--sleeve-art'),
    'url("data:image/jpeg;base64,current")', '当前歌单的解析结果仍能显示');
}

// 6. 接线：数据源、容器与键名
// ---------------------------------------------------------------------------

function checkWiring() {
  section('接线：容器、控件与存储键');

  for (const id of ['shelf', 'playlist-list', 'playlist-grid']) {
    ok(new RegExp('id="' + id + '"').test(HTML), `index.html 里有 #${id}`);
  }
  ok(/id="pl-views"/.test(HTML), 'index.html 里有切换控件 #pl-views');
  const views = [...HTML.matchAll(/data-pl-view="([a-z]+)"/g)].map((m) => m[1]);
  eq(views.join(','), 'shelf,grid,list', '控件恰好声明了三种排布，顺序稳定');
  ok(!/id="shelf-toggle"/.test(HTML), '旧的两档 toggle 已经摘掉');

  ok(APP.includes("plViews: $('pl-views')"), 'app.js 取到了切换控件');
  ok(APP.includes("playlistGrid: $('playlist-grid')"), 'app.js 取到了网格容器');
  ok(APP.includes("const PL_VIEW_KEY = 'vmusic.playlists.mode'"),
    '存储键沿用改造前那个键名（旧用户的选择不丢）');
  ok(APP.includes("localStorage.setItem(PL_VIEW_KEY, want)"), '切档真的写存储');
  ok(APP.includes('initPlaylistViews();'), '启动序列里调了 initPlaylistViews');
  // 排布切换不该因为 stage.js 缺失而失效：initStage() 会整段提前返回。
  const boot = APP.indexOf('initPlaylistViews();');
  const stage = APP.indexOf('\n  initStage();');
  ok(boot > 0 && stage > 0 && boot < stage, 'initPlaylistViews 排在 initStage 之前');

  section('接线：三视图共用一份数据与一条动作链路');

  const grid = grab('renderPlaylistGrid');
  ok(grid.includes('shelfItems()'), '封面墙从 shelfItems() 取数（与歌单架同源）');
  ok(grid.includes('dispatchPlaylistAction('), '封面墙的动作走统一分派');
  ok(!grid.includes('playPlaylist(') && !grid.includes('openPlaylist('),
    '封面墙不自己调本地播放/打开（那样会漏掉在线分支）');
  ok(!grid.includes('playRef('), '封面墙不自己调在线播放');

  ok(APP.includes("dispatchPlaylistAction((e.detail || {}).id, (e.detail || {}).action)"),
    '歌单架广播的动作也走同一条分派');
  ok(!APP.includes('shelfToggle'), '旧 toggle 的引用清干净了');

  section('接线：从详情返回会同时收掉三种排布');
  const layer = grab('setPlaylistLayer');
  ok(layer.includes('ui.shelf.classList.remove'), '非排布层收掉歌单架');
  ok(layer.includes('ui.playlistList.hidden = true'), '非排布层收掉列表');
  ok(layer.includes('ui.playlistGrid.hidden = true'), '非排布层收掉封面墙');

  section('滚动权：谁都不许把封面墙的纵向滚动交出去');
  // 默认档是封面墙之后，这堵墙必须自己滚。清风曾为了拍立得的抬升不被裁
  // 写过 overflow:visible，而本皮肤的 .view/.column 都不滚（后者 hidden）——
  // 墙一超过一屏就没有任何滚动宿主，实测 13 个歌单在 620 高视口下第二排
  // 6 张彻底够不着。排布挤压这类问题沙箱量不出来（见 docs/adr），这里只能
  // 钉住「规则里不许出现 visible」这一条形状，可达性本身仍要真浏览器量。
  const STYLE = read('style.css');
  ok(/\.pl-grid\s*\{[^}]*overflow-y:\s*auto/.test(STYLE), '基础 .pl-grid 自己是滚动宿主');
  for (const f of fs.readdirSync(path.join(WEB, 'skins')).filter((n) => /^skin\.[a-z]+\.css$/.test(n))) {
    const css = read(path.join('skins', f));
    for (const m of css.matchAll(/\[data-skin="[a-z]+"\][^{]*\.pl-grid[^{]*\{([^}]*)\}/g)) {
      ok(!/overflow(?:-[xy])?\s*:\s*visible/.test(m[1]), `${f} 的 .pl-grid 没有交出滚动权`);
    }
  }

  section('悬停层：来源徽标是左上角标，不跟播放键挤在同一排');
  // 徽标以前排在 .pl-card-face 那条 flex 里（align-self:center），于是停在封面
  // 竖向中间、正好压在画面主体上，而那道渐变只护得住底部那一排。
  ok(/\.pl-card-badge\s*\{[^}]*position:\s*absolute;[^}]*top:\s*8px;[^}]*left:\s*8px/.test(STYLE),
    '徽标钉在悬停层左上角');
  ok(!/\.pl-card-badge\s*\{[^}]*align-self/.test(STYLE), '徽标不再参与那条 flex 的竖向居中');
  ok(/\.pl-card-face\s*\{[^}]*justify-content:\s*flex-start/.test(STYLE),
    '播放键钉在左下角（徽标退出这条 flex 后它不跟着跳到右边）');
  // JS 写 --badge、CSS 读 --badge：这类"一头写了另一头不读"的耦合不会崩、
  // 不会报错，只是品牌色方块画不出来。
  ok(/\.pl-card-badge\s*\{[^}]*background:\s*var\(--badge,/.test(STYLE),
    'CSS 侧真的读 --badge（字形徽标的品牌色方块）');
  ok(/\.pl-card-badge svg\s*\{[^}]*width:\s*12px/.test(STYLE),
    '字形有确定尺寸：不钉的话内联 <svg> 会按默认尺寸撑破角标');
}

// ---------------------------------------------------------------------------

(async function main() {
  checkSwitching();
  checkDefaultView();
  checkDispatch();
  checkGridRendering();
  await checkShelfCoverProxy();
  checkWiring();

  console.log('\n' + '─'.repeat(60));
  if (failures) {
    console.error(`歌单浏览方式契约检查：${checks} 项，${failures} 项失败`);
    process.exit(1);
  }
  console.log(`歌单浏览方式契约检查：${checks}/${checks} 全部通过`);
})().catch((error) => {
  console.error('harness error:', error);
  process.exitCode = 2;
});
