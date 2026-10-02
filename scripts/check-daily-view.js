#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 每日推荐独立页（导航菜单项 + 独立路由）的契约检查（零依赖、不触网）。
//
//   node scripts/check-daily-view.js
//
// 这个页面最容易坏在三处，各钉一条：
//
//   1. **菜单注入不能动到既有菜单**。需求明确要求"不改动其他菜单的原有逻辑"，
//      所以这里断言注入前后既有项的集合与顺序完全不变，新项只是插进来。
//   2. **排序位置真的按 order 生效**。order=25 必须落在「在线」(20) 与
//      「歌单」(30) 之间；写死成 append 就会掉到「设置」后面。
//   3. **可见性开关是真的开关**。关掉要摘掉入口，且不能把用户留在已经没有
//      入口的页面上（必须退回曲库）。
//
// 另外钉住日期切换（不能翻到未来）、空态文案要区分"没登录"与"已登录但没拿到"、
// 以及播放走的是现有那条混合队列通道。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'plugin', 'ui');
/// 前端文件按 前端目录取；后端文件按仓库根取。
const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8').replace(/\r\n/g, '\n');
const readSrc = (f) => fs.readFileSync(path.join(ROOT, 'crates', 'hertz-studio', 'src', f), 'utf8')
  .replace(/\r\n/g, '\n');
const SRC = read('daily-view.js');
const APP = read('app.js');
const HTML = read('index.html');
const MAIN_RS = readSrc('main.rs');
const DAILY_RS = readSrc('daily.rs');
const ROUTES_RS = readSrc('routes.rs');

let failures = 0;
let checks = 0;
function ok(cond, label) {
  checks += 1;
  if (!cond) { failures += 1; console.error('  X ' + label); }
}
function eq(a, b, label) { ok(a === b, label + ' (got ' + JSON.stringify(a) + ')'); }
function section(name) { console.log('\n' + name); }

// ---------------------------------------------------------------------------
// DOM 桩
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

function makeEl(tag) {
  const el = {
    tagName: tag || 'div',
    id: '',
    className: '',
    disabled: false,
    checked: false,
    textContent: '',
    title: '',
    hidden: false,
    dataset: {},
    attrs: {},
    children: [],
    classList: makeClassList(),
    style: { backgroundImage: '' },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] || null; },
    appendChild(c) {
      // 真实 DOM 里 appendChild(fragment) 会把 fragment 的子节点搬过来，
      // fragment 本身不留在树上。桩必须照做，否则断言会看到"只有一个孩子"。
      if (c.tagName === 'fragment') {
        for (const kid of c.children.slice()) this.appendChild(kid);
        return c;
      }
      c._parent = this;
      this.children.push(c);
      return c;
    },
    insertBefore(c, ref) {
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      c._parent = this;
      return c;
    },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      return c;
    },
    querySelector(sel) {
      const cls = sel.replace(/^\./, '');
      const walk = (n) => {
        for (const c of n.children) {
          if (String(c.className).split(/\s+/).indexOf(cls) >= 0) return c;
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this);
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (matches(c, sel)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() {
      // 直接设过字符串时以字符串为准；否则按子树拼出文本——渲染代码走的是
      // appendChild 这条路，断言要看得到里面的文字。
      if (this._html) return this._html;
      let s = '';
      const walk = (n) => {
        for (const c of n.children) {
          if (c._html) s += c._html;
          else { s += c.textContent || ''; walk(c); }
        }
      };
      walk(this);
      return s;
    },
    set(v) { this._html = String(v); this.children = []; },
  });
  Object.defineProperty(el, 'parentNode', {
    get() { return this._parent || null; },
  });
  return el;
}

/// 只支持本脚本用到的三种选择器：`.cls`、`tag[attr]`、`.rail-spacer`。
function matches(el, sel) {
  const mTag = /^([a-z]+)\[([a-z-]+)\]$/.exec(sel);
  if (mTag) {
    return el.tagName === mTag[1] && el.attrs[mTag[2]] !== undefined;
  }
  if (sel.startsWith('.')) {
    return String(el.className).split(/\s+/).indexOf(sel.slice(1)) >= 0;
  }
  return el.tagName === sel;
}

/// 导航轨：与 index.html 的现有结构一致（五个一级项 + spacer + 设置）。
function makeRail() {
  const rail = makeEl('nav');
  rail.id = 'rail';
  for (const v of ['library', 'online', 'playlists', 'queue', 'favorites']) {
    const b = makeEl('button');
    b.className = 'rail-item';
    b.dataset.view = v;
    rail.appendChild(b);
  }
  const spacer = makeEl('div');
  spacer.className = 'rail-spacer';
  rail.appendChild(spacer);
  const settings = makeEl('button');
  settings.className = 'rail-item';
  settings.dataset.view = 'settings';
  rail.appendChild(settings);
  return rail;
}

function makeSandbox() {
  const rail = makeRail();
  const requests = [];
  const calls = { playQueue: [], setView: [] };
  const ui = {
    dvBody: makeEl('div'),
    dvSub: makeEl('span'),
    dvPrev: makeEl('button'),
    dvNext: makeEl('button'),
    dvDate: makeEl('button'),
    dvRefresh: makeEl('button'),
    dvPlay: makeEl('button'),
    dvModes: makeEl('div'),
    dvLayouts: makeEl('div'),
    setNavDaily: makeEl('input'),
  };
  // 来源与排布两组 chip，与 index.html 的标记一致。
  for (const m of ['online', 'local']) {
    const b = makeEl('button');
    b.className = 'chip';
    b.setAttribute('data-dv-mode', m);
    ui.dvModes.appendChild(b);
  }
  for (const l of ['list', 'card']) {
    const b = makeEl('button');
    b.className = 'chip';
    b.setAttribute('data-dv-layout', l);
    ui.dvLayouts.appendChild(b);
  }

  const state = { view: 'library', settings: {} };
  const host = {
    ui,
    state,
    toast: () => {},
    // 本地曲目的封面靠宿主拼 URL（与首页推荐条同一条路）。
    coverUrl: (id) => 'cover/' + id,
    setView: (n) => { state.view = n; calls.setView.push(n); },
    playQueue: (ids, meta, startId) => calls.playQueue.push({ ids, meta, startId }),
  };

  const store = new Map();
  const sandbox = {
    console, Object, Array, JSON, Math, String, Number, Date, Promise, Set, Map,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    document: {
      getElementById(id) {
        if (id === 'rail') return rail;
        let found = null;
        const walk = (n) => {
          for (const c of n.children) {
            if (c.id === id) { found = c; return; }
            walk(c);
          }
        };
        walk(rail);
        return found;
      },
      createElement: (t) => makeEl(t),
      createDocumentFragment: () => makeEl('fragment'),
      addEventListener() {},
    },
    VMusicTransport: {
      get: (u) => { requests.push(u); return Promise.resolve({ date: '', total: 0, tracks: [], skipped: [], ready: [] }); },
      put: () => Promise.resolve({}),
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'daily-view.js' });
  sandbox.DailyView.bind(host);
  return { sandbox, rail, ui, host, requests, calls, state, store };
}

function railOrder(rail) {
  return rail.children.map((c) => c.dataset.view || c.className);
}

// ---------------------------------------------------------------------------
// 1. 菜单：配置、注入位置、不动既有项
// ---------------------------------------------------------------------------

function checkNavMounting() {
  section('菜单：按配置注入，既有菜单一个都不动');

  const { sandbox, rail, calls } = makeSandbox();
  const before = railOrder(rail);

  const nav = sandbox.DailyView.nav;
  ok(!!nav.name && !!nav.icon && typeof nav.order === 'number' && !!nav.settingKey,
    '菜单项的名称/图标/排序/开关键都可配置');
  eq(nav.order, 25, 'order 落在「在线」(20) 与「歌单」(30) 之间');

  sandbox.DailyView.mount();
  const after = railOrder(rail);

  ok(after.indexOf('daily') >= 0, '菜单项挂上了导航轨');
  eq(after.indexOf('daily'), 2, '插在「在线」之后、「歌单」之前（order 真的生效）');

  // 既有项：集合与相对顺序一律不变。
  const kept = after.filter((x) => x !== 'daily');
  eq(kept.join(','), before.join(','), '既有菜单项的集合与顺序完全没变');
  eq(after.length, before.length + 1, '只多了一个按钮，没有替换/复制既有项');

  // 新按钮自己带点击：它是在设置到手之后才挂载的，指望 app.js 那次批量
  // 绑定会得到一个点不动的按钮。
  const btn = rail.children[2];
  ok(typeof btn.onclick === 'function', '新按钮自带 onclick（不依赖批量绑定）');
  btn.onclick();
  eq(calls.setView.join(','), 'daily', '点它切到 daily 视图');

  section('菜单：重复挂载不产生第二个');
  sandbox.DailyView.mount();
  sandbox.DailyView.mount();
  eq(railOrder(rail).filter((x) => x === 'daily').length, 1, 'mount 幂等');
}

// ---------------------------------------------------------------------------
// 2. 可见性开关
// ---------------------------------------------------------------------------

function checkVisibility() {
  section('可见性：设置页开关真的能摘掉入口');

  const { sandbox, rail, state } = makeSandbox();

  ok(sandbox.DailyView.applySettings({}) === true, '没配过默认显示');
  ok(railOrder(rail).indexOf('daily') >= 0, '默认挂载');

  sandbox.DailyView.applySettings({ nav_daily_visible: false });
  eq(railOrder(rail).indexOf('daily'), -1, '关掉后入口消失');

  // 关掉时若正停在该页，必须退回曲库——否则用户会卡在一个导航里
  // 已经没有入口的页面上。
  state.view = 'daily';
  sandbox.DailyView.applySettings({ nav_daily_visible: false });
  eq(state.view, 'library', '关掉时正停在该页会退回曲库');

  sandbox.DailyView.applySettings({ nav_daily_visible: true });
  ok(railOrder(rail).indexOf('daily') >= 0, '再打开又回来');
  eq(state.view, 'library', '重新打开不会把用户硬拽过去');

  section('可见性：开关写回设置表');
  const { sandbox: s2, ui } = makeSandbox();
  s2.DailyView.init();
  ui.setNavDaily.checked = false;
  const put = [];
  s2.window.VMusicTransport.put = (u, body) => { put.push([u, body]); return Promise.resolve({}); };
  ui.setNavDaily.onchange();
  ok(put.some(([u, b]) => u === '/v1/settings' && b.nav_daily_visible === false),
    '开关变化时 PUT 到 /v1/settings');
}

// ---------------------------------------------------------------------------
// 3. 日期切换
// ---------------------------------------------------------------------------

function checkDates() {
  section('日期：能回看，但不能翻到未来');

  const { sandbox, requests, ui } = makeSandbox();
  sandbox.DailyView.init();

  ok(sandbox.DailyView.state.day === null, '初始是今天（day 为 null）');
  eq(ui.dvNext.disabled, true, '停在今天时「后一天」禁用');

  ui.dvPrev.onclick();
  const day = sandbox.DailyView.state.day;
  ok(typeof day === 'number', '点「前一天」后有了具体天序号');
  ok(requests.some((u) => u.indexOf('day=') >= 0), '请求带上了 day 参数');
  ok(requests.some((u) => u.indexOf('day=' + day) >= 0), `day 与实际选中的那天一致（${day}）`);
  ok(requests.some((u) => u.indexOf('/v1/recommend/daily?') >= 0), '本地推荐按天重拉');
  ok(requests.some((u) => u.indexOf('/v1/recommend/daily/online?') >= 0), '在线汇总也按天重拉');

  // 回到今天：next 从 day-1 走一步就是今天。
  ui.dvNext.onclick();
  ok(sandbox.DailyView.state.day !== null, '往前走了一天');
  ui.dvDate.onclick();
  ok(sandbox.DailyView.state.day === null, '点日期按钮回到今天（不再带偏移）');

  section('日期：天序号与后端同定义（UTC）');
  // 后端 local_offset_secs() 返回 0（按 UTC 换天）。前端一旦改用本地时区，
  // 东八区会差一天：前端的"今天"被后端判成"其它日期"，在线那份走 history
  // 分支，用户一进页面就看到「在线推荐只提供当天」——页面等于废了。
  ok(!/getTimezoneOffset/.test(SRC), '天序号不掺本地时区偏移');
  ok(/Math\.floor\(date\.getTime\(\) \/ 86400000\)/.test(SRC), '天序号 = UTC 毫秒整除一天');
  ok(/getUTCFullYear|getUTCDate/.test(SRC), '日期显示也用 UTC，与后端 date_label 对齐');
  // 后端那一侧的约定也要在，不然有人改了后端前端还蒙在鼓里。
  ok(/fn local_offset_secs/.test(DAILY_RS) && /按 UTC 换天/.test(DAILY_RS),
    '后端仍按 UTC 换天（若改了，前端要同步改）');

  section('日期：今天之后的按钮无效');
  const { sandbox: s2, ui: u2 } = makeSandbox();
  s2.DailyView.init();
  u2.dvNext.onclick();
  ok(s2.DailyView.state.day === null, '今天点「后一天」不生效（明天的榜单不存在）');
}

// ---------------------------------------------------------------------------
// 4. 空态与来源
// ---------------------------------------------------------------------------

function checkEmpty() {
  section('空态：不同成因给不同的话');

  const { sandbox, ui } = makeSandbox();
  sandbox.DailyView.init();

  // 一个平台都没登录：该引导去登录。
  sandbox.DailyView.state.online = { date: '', total: 0, empty: true, tracks: [], sources: [], skipped: [], ready: [] };
  sandbox.DailyView.render();
  ok(ui.dvBody.innerHTML.indexOf('还没有登录任何支持每日推荐的平台') >= 0,
    '没登录平台时引导去登录');

  // 已登录但这次没拿到：不该再说"没登录"。
  sandbox.DailyView.state.online = {
    date: '', total: 0, empty: true, tracks: [], sources: [],
    skipped: [{ source: 'netease', label: '网易云音乐', kind: 'failed', message: 'x' }],
    ready: ['网易云音乐'],
  };
  sandbox.DailyView.render();
  const html = ui.dvBody.innerHTML;
  ok(html.indexOf('网易云音乐') >= 0 && html.indexOf('已登录') >= 0, '已登录但没拿到时点名平台');
  ok(html.indexOf('还没有登录') < 0, '此时不再说"还没登录"（那是误导）');

  // 历史日期 + 在线来源：要说清在线只提供当天。
  sandbox.DailyView.state.day = 1;
  sandbox.DailyView.render();
  ok(ui.dvBody.innerHTML.indexOf('在线推荐只提供当天') >= 0,
    '回看历史且选在线时说明只提供当天');

  section('来源切换：本地/在线各自渲染自己的那份');
  const { sandbox: s2, ui: u2 } = makeSandbox();
  s2.DailyView.init();
  s2.DailyView.state.day = null;
  s2.DailyView.state.local = { date: '', total: 2, tracks: [{ id: 'a', title: '本地一' }, { id: 'b', title: '本地二' }] };
  s2.DailyView.state.online = { date: '', total: 0, empty: true, tracks: [], sources: [], skipped: [], ready: [] };
  u2.dvModes.querySelectorAll('button[data-dv-mode]')[1].onclick();
  eq(s2.DailyView.state.mode, 'local', '切到本地来源');
  ok(u2.dvBody.innerHTML.indexOf('本地一') >= 0, '渲染的是本地那份');
}

// ---------------------------------------------------------------------------
// 5. 排布与播放
// ---------------------------------------------------------------------------

function checkLayoutAndPlay() {
  section('排布：列表/卡片，选择被记住');

  const { sandbox, ui, store, calls } = makeSandbox();
  sandbox.DailyView.init();
  eq(sandbox.DailyView.state.layout, 'list', '默认列表');

  sandbox.DailyView.state.online = {
    date: '', total: 2, tracks: [
      // 真实响应里在线曲目**同时**带 id 与 virtual_id：id 是平台裸 id，
      // virtual_id 才是服务端认的虚拟 id。以前这里只造了 virtual_id，
      // 于是 `t.id || t.virtual_id` 也能过——真实数据下取到裸 id，
      // /player/load 直接 not_found（"每日推荐点不动"）。fixture 必须照
      // 真实响应的形状写，否则契约全绿、线上是坏的。
      { id: '1', virtual_id: 'online:netease:1', title: '云一', artist: 'A', source_label: '网易云音乐' },
      { id: '2', virtual_id: 'online:netease:2', title: '云二', artist: 'B', source_label: '网易云音乐' },
    ], sources: [], skipped: [], ready: [],
  };
  sandbox.DailyView.render();
  ok(ui.dvBody.className.indexOf('dv-body-list') >= 0, '列表画法写在容器 class 上');
  ok(ui.dvBody.children.length === 2, '两首都渲染了');

  ui.dvLayouts.querySelectorAll('button[data-dv-layout]')[1].onclick();
  eq(sandbox.DailyView.state.layout, 'card', '切到卡片');
  ok(ui.dvBody.className.indexOf('dv-body-card') >= 0, '容器 class 跟着变');
  eq(store.get('vmusic.dailyview.layout'), 'card', '排布选择写进了 localStorage');

  section('卡片封面：字段取对，两种来源各走各的路');

  const { sandbox: s3, ui: u3 } = makeSandbox();
  s3.DailyView.init();
  s3.DailyView.state.layout = 'card';
  // 在线曲目：后端字段是 cover，且必须过 Online.safeCoverUrl（外链直连会被
  // Referer/CORS 拦）。之前写成 cover_url/coverUrl，于是整墙卡片没有封面。
  let safeAsked = [];
  let pxAsked = [];
  s3.window.Online = {
    safeCoverUrl: (u) => { safeAsked.push(u); return '/safe?u=' + u; },
    rowCoverUrl: (u, px) => { pxAsked.push(px); return u + '?param=' + px + 'y' + px; },
  };
  s3.DailyView.state.online = {
    date: '', total: 1, sources: [], skipped: [], ready: [],
    tracks: [{ virtual_id: 'online:netease:9', title: '云曲', cover: 'https://x/a.jpg' }],
  };
  s3.DailyView.render();
  const cardArt = u3.dvBody.children[0].children[0];
  eq(safeAsked.join(','), 'https://x/a.jpg', '在线封面过 Online.safeCoverUrl');
  ok(cardArt.style.backgroundImage.indexOf('/safe?u=') >= 0, '卡片用的是规范化后的 URL');
  // 卡片只要 300px 的小图：用原图会让整墙封面等好几秒才浮出来。
  eq(pxAsked.join(','), '300', '封面走了缩略图参数（不是原图）');
  ok(cardArt.classList.contains('has-art'), '有封面时标 has-art');

  // 本地曲目：没有 cover 字段，看 has_cover + 宿主 coverUrl(id)。
  const { sandbox: s4, ui: u4 } = makeSandbox();
  s4.DailyView.init();
  s4.DailyView.state.layout = 'card';
  s4.DailyView.state.mode = 'local';
  s4.DailyView.state.local = {
    date: '', total: 1,
    tracks: [{ id: 'local-1', title: '本地曲', has_cover: true }],
  };
  s4.DailyView.render();
  const localArt = u4.dvBody.children[0].children[0];
  ok(localArt.style.backgroundImage.indexOf('cover/local-1') >= 0,
    '本地封面走宿主 coverUrl(id)（got ' + localArt.style.backgroundImage + '）');

  // 两种都没命中 → 标 is-missing，让占位图形露出来，而不是一片空白。
  const { sandbox: s5, ui: u5 } = makeSandbox();
  s5.DailyView.init();
  s5.DailyView.state.layout = 'card';
  s5.DailyView.state.mode = 'local';
  s5.DailyView.state.local = { date: '', total: 1, tracks: [{ id: 'local-2', title: '没封面' }] };
  s5.DailyView.render();
  ok(u5.dvBody.children[0].children[0].classList.contains('is-missing'),
    '没有封面时标 is-missing（占位图形才画得出来）');
  const CSS = read('style.css');
  ok(/\.dv-art\.is-missing::after/.test(CSS), 'is-missing 有对应的占位样式');

  section('播放：走现有那条混合队列通道');
  ui.dvPlay.onclick();
  eq(calls.playQueue.length, 1, '点「播放全部」只发一次队列');
  const q = calls.playQueue[0];
  ok(q && q.ids.length === 2, '整份推荐作为一个队列');
  eq(q.startId, q.ids[0], '播放全部从第一首起');
  // 入队 id 必须是虚拟 id：裸平台 id 会被服务端当本地曲目查库 → not_found。
  ok(q.ids.every((id) => String(id).indexOf('online:') === 0),
    '在线队列的 id 全是虚拟 id（got ' + q.ids.join(',') + '）');
  ok(q.meta && q.meta['online:netease:1'], '在线曲目带元数据快照（历史标题才不退化成裸 id）');
  ok(!q.meta['1'], '快照的键是虚拟 id，不是平台裸 id');
  ok(Object.keys(q.meta || {}).every((k) => String(k).indexOf('online:') === 0),
    'meta 的键全是虚拟 id（服务端只收虚拟 id 的键，其余整条丢弃）');
  // OnlineMetaSnap.title 是必填：缺了整条 meta 反序列化失败，连累整次播放 400。
  ok(q.meta['online:netease:1'].title === '云一', '快照带 title（服务端必填字段）');
  ok(!q.meta['local-1'], '本地曲目不塞进 meta（服务端只认虚拟 id）');
  // 取 id 的顺序钉死：两个字段都在时 virtual_id 必须赢。
  const DV = read('daily-view.js');
  ok(/function idOf\([\s\S]{0,200}?t\.virtual_id \|\| t\.id/.test(DV),
    'idOf 优先取 virtual_id（两个 id 同时存在时在线身份必须赢）');

  // 点第 N 首：从那首起播，队列顺序不变（改顺序会改掉"下一首"）。
  ui.dvPlay.onclick();
  calls.playQueue.length = 0;
  sandbox.DailyView.state.layout = 'list';
  sandbox.DailyView.render();
  ui.dvBody.children[1].onclick();
  const q2 = calls.playQueue[0];
  eq(q2.startId, q2.ids[1], '点第二首就从第二首起播');
  eq(q2.ids[0], q.ids[0], '队列本身没被重排');
}

// ---------------------------------------------------------------------------
// 6. 接线
// ---------------------------------------------------------------------------

function checkWiring() {
  section('接线：页面容器、图标、开关、路由');

  ok(/id="view-daily"/.test(HTML), 'index.html 有独立页面容器 #view-daily');
  ok(/id="rail"/.test(HTML), '导航轨存在（注入点）');
  ok(/symbol id="i-daily"/.test(HTML), '图标 sprite 里有 #i-daily');
  ok(/id="set-nav-daily"/.test(HTML), '设置页有可见性开关');
  ok(/src="daily-view\.js"/.test(HTML), '页面引入了 daily-view.js');
  ok(/route\("\/daily-view\.js"/.test(MAIN_RS), 'main.rs 注册了 /daily-view.js 路由');
  // 只匹配文件名后缀，不写死相对深度：前端目录搬过位置（web/ → plugin/ui/）。
  ok(/include_str!\("[^"]*\/daily-view\.js"\)/.test(MAIN_RS), '脚本被 include 进二进制');

  ok(APP.includes("daily: $('view-daily')"), 'app.js 把 daily 注册成一个视图');
  ok(APP.includes("window.DailyView.onViewEnter()"), '进入该视图时才拉数据');
  ok(APP.includes("window.DailyView.applySettings(state.settings)"), '设置到手后应用可见性');
  ok(APP.includes("window.DailyView.bind(favHost)"), '与首页推荐条共用同一个宿主');
  // 既有菜单的绑定与分支一条都不能少。
  ok(APP.includes("ui.rail.querySelectorAll('.rail-item').forEach((b) => { b.onclick = () => setView(b.dataset.view); })"),
    '既有菜单的批量绑定原样保留');
  for (const v of ['library', 'online', 'playlists', 'queue', 'favorites', 'settings']) {
    ok(new RegExp('^\\s+' + v + ": \\$\\('view-" + v + "'\\)", 'm').test(APP),
      `既有视图 ${v} 的注册还在`);
  }

  section('接线：后端按天出榜');
  ok(/day: Option<i64>/.test(ROUTES_RS), 'DailyQuery 接受 day 参数');
  ok(/daily::daily_at\(&state\.db, limit, q\.day\)/.test(ROUTES_RS), '本地 handler 把 day 传下去');
  ok(/daily::online_daily_at\(&online_ctx\(&state\), limit, q\.day\)/.test(ROUTES_RS),
    '在线 handler 把 day 传下去');
  ok(/fn daily_at\(/.test(DAILY_RS) && /fn online_daily_at\(/.test(DAILY_RS),
    '本地与在线各有一个按天版本');
  ok(/kind: "history"/.test(DAILY_RS), '历史日期的在线跳过原因标为 history');
  // 原签名保留：既有调用点不用跟着改。
  ok(/pub async fn daily\(db: &SqlitePool, limit: usize\)/.test(DAILY_RS), 'daily() 原签名保留');
  ok(/pub async fn online_daily\(ctx: &crate::online::Ctx, limit: usize\)/.test(DAILY_RS),
    'online_daily() 原签名保留');

  section('接线：样式');
  const CSS = read('style.css');
  ok(/\.dv-row\s*\{/.test(CSS) && /\.dv-card\s*\{/.test(CSS), '列表与卡片两种画法都有样式');
  ok(/\.dv-body-card\s*\{/.test(CSS), '卡片排布的多列网格由容器 class 控制');
  ok(!/dv-body:has\(/.test(CSS), '没有依赖 :has()（兼容性）');
}

// ---------------------------------------------------------------------------

(function main() {
  checkNavMounting();
  checkVisibility();
  checkDates();
  checkEmpty();
  checkLayoutAndPlay();
  checkWiring();

  console.log('\n' + '─'.repeat(60));
  if (failures) {
    console.error(`每日推荐独立页契约检查：${checks} 项，${failures} 项失败`);
    process.exit(1);
  }
  console.log(`每日推荐独立页契约检查：${checks}/${checks} 全部通过`);
})();
