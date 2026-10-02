#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 界面皮肤（布局皮肤）的契约检查（零依赖、不触网）。
//
//   node scripts/check-skins.js
//
// 皮肤是"只换布局、不换配色"的一层，最容易坏在四个地方，各钉一条：
//
//   1. **偷偷改配色**。皮肤 CSS 里一旦出现颜色字面量，换皮肤就会把主题色带跑，
//      主题与皮肤不再正交。这里直接扫十六进制/rgb() 字面量。
//   2. **两套皮肤没有区分度**。只是微调就失去了"换皮肤"的意义——对两组布局
//      令牌逐项比对，要求真的反向取值。
//   3. **模块覆盖不齐**。两套皮肤必须覆盖同一批模块，否则切过去会有页面
//      落回默认布局，看起来像"切了一半"。
//   4. **扩展点不Work**。加一套皮肤应该是"一个 CSS + 一行 register"，
//      这里真的 register 一套进去，验证切换/列表/持久化自动生效。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'plugin', 'ui');
const SKINS = path.join(WEB, 'skins');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const SKINS_JS = read(path.join(SKINS, 'skins.js'));
const SHEEN = read(path.join(SKINS, 'skin.sheen.css'));
const WORKBENCH = read(path.join(SKINS, 'skin.workbench.css'));
const LIUNIAN = read(path.join(SKINS, 'skin.liunian.css'));
const LIUNIAN_JS = read(path.join(SKINS, 'skin.liunian.js'));
const SKINS_CSS = read(path.join(SKINS, 'skins.css'));
const HTML = read(path.join(WEB, 'index.html'));
const APP = read(path.join(WEB, 'app.js'));
const MAIN_RS = read(path.join(ROOT, 'crates', 'hertz-studio', 'src', 'main.rs'));

let failures = 0;
let checks = 0;
function ok(cond, label) {
  checks += 1;
  if (!cond) { failures += 1; console.error('  X ' + label); }
}
function eq(a, b, label) { ok(a === b, label + ' (got ' + JSON.stringify(a) + ')'); }
function section(name) { console.log('\n' + name); }

// ---------------------------------------------------------------------------
// 沙箱
// ---------------------------------------------------------------------------

function makeEl(id) {
  const el = {
    id: id || '',
    disabled: false,
    className: '',
    textContent: '',
    attrs: {},
    children: [],
    _html: '',
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] || null; },
    appendChild(c) { this.children.push(c); return c; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = String(v); this.children = []; },
  });
  return el;
}

function makeSandbox(cssIds) {
  const links = (cssIds || []).map((id) => {
    const l = makeEl();
    l.setAttribute('data-skin-css', id);
    l.disabled = true;
    return l;
  });
  const root = makeEl('html');
  const listHost = makeEl('skins-list');
  const events = [];
  const store = new Map();
  const sandbox = {
    console: { warn: () => {}, log: () => {} },
    Object, Array, JSON, String, Number, Math, Set, Map,
    CustomEvent: class CustomEvent {
      constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; }
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    document: {
      documentElement: root,
      getElementById: (id) => (id === 'skins-list' ? listHost : null),
      querySelectorAll: (sel) => (sel === 'link[data-skin-css]' ? links : []),
      createElement: () => makeEl(),
      dispatchEvent: (e) => { events.push(e); return true; },
      addEventListener: () => {},
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SKINS_JS, sandbox, { filename: 'skins.js' });
  return { sandbox, root, links, listHost, store, events };
}

// ---------------------------------------------------------------------------
// 1. 注册表与切换
// ---------------------------------------------------------------------------

function checkCatalog() {
  section('皮肤目录：四套都在，classic 是"没有皮肤"');

  const { sandbox, root, links } = makeSandbox(['sheen', 'workbench', 'liunian']);
  const ids = sandbox.Skins.catalog().map((s) => s.id);
  ok(ids.indexOf('classic') >= 0, '有 classic（仓库原本那套布局）');
  ok(ids.indexOf('sheen') >= 0, '有 sheen');
  ok(ids.indexOf('workbench') >= 0, '有 workbench');
  ok(ids.indexOf('liunian') >= 0, '有 liunian');
  ok(sandbox.Skins.catalog().every((s) => s.name && s.note),
    '每套皮肤都有可读的名字与说明（设置页要靠它做选择）');

  section('切换：写 data-skin，并只启用对应那份 CSS');

  sandbox.Skins.apply('sheen');
  eq(root.getAttribute('data-skin'), 'sheen', 'html 上写了当前皮肤');
  eq(links[0].disabled, false, 'sheen 的 CSS 被启用');
  eq(links[1].disabled, true, 'workbench 的 CSS 保持禁用（两套不能同时生效）');
  eq(links[2].disabled, true, 'liunian 的 CSS 保持禁用');

  sandbox.Skins.apply('workbench');
  eq(links[0].disabled, true, '切走后 sheen 的 CSS 收起');
  eq(links[1].disabled, false, 'workbench 的 CSS 启用');

  sandbox.Skins.apply('liunian');
  eq(links[0].disabled, true, '切到 liunian 后 sheen 的 CSS 收起');
  eq(links[1].disabled, true, 'workbench 的 CSS 收起');
  eq(links[2].disabled, false, 'liunian 的 CSS 启用');

  sandbox.Skins.apply('classic');
  eq(links.every((l) => l.disabled), true, 'classic 不启用任何皮肤 CSS（它本身就是默认布局）');

  section('切换：广播事件让画布类模块自己重排');
  const { sandbox: s2, events } = makeSandbox(['sheen', 'workbench', 'liunian']);
  s2.Skins.apply('workbench');
  ok(events.some((e) => e.type === 'skin:changed' && e.detail && e.detail.id === 'workbench'),
    '切肤后广播 skin:changed（舞台/3D 这类要按新尺寸重排）');

  section('持久化：选择被记住，坏数据回落而不是写个无效值');
  const { sandbox: s3, store } = makeSandbox(['sheen', 'workbench', 'liunian']);
  s3.Skins.apply('workbench');
  eq(store.get('vmusic.skin'), 'workbench', '选择写进 localStorage');
  store.set('vmusic.skin', 'no-such-skin');
  s3.Skins.init();
  eq(s3.Skins.currentId(), 'classic', '存了不认识的皮肤时回落 classic');
}

// ---------------------------------------------------------------------------
// 2. 扩展点：加一套新皮肤只需要一个 CSS + 一行 register
// ---------------------------------------------------------------------------

function checkExtensibility() {
  section('扩展：register 一套新皮肤后，切换/列表自动生效');

  const { sandbox, root, links } = makeSandbox(['sheen', 'workbench', 'compact']);
  const okReg = sandbox.Skins.register({ id: 'compact', name: '紧凑', note: '测试用的第三套' });
  ok(okReg === true, 'register 接受新皮肤');
  ok(sandbox.Skins.register({ id: 'compact', name: '重复' }) === false, '重复 id 被拒绝');
  ok(sandbox.Skins.catalog().some((s) => s.id === 'compact'), '新皮肤进了目录');

  sandbox.Skins.apply('compact');
  eq(root.getAttribute('data-skin'), 'compact', '新皮肤可以切换过去');
  eq(links[2].disabled, false, '新皮肤的 CSS 被启用');

  sandbox.Skins.render();
  const opts = sandbox.Skins.list();
  ok(opts.length >= 4, `设置页列表会多出这一项（${opts.length} 套）`);

  section('扩展：声明了皮肤但漏了 CSS 要显式回落，不能静默装作切成功');
  const { sandbox: s2, root: r2 } = makeSandbox(['sheen']); // 没有 workbench 的 link
  s2.Skins.apply('workbench');
  eq(r2.getAttribute('data-skin'), 'classic', '缺 CSS 的皮肤回落到 classic');
  eq(s2.Skins.currentId(), 'classic', 'currentId 也是 classic（不是嘴上说切了）');
}

// ---------------------------------------------------------------------------
// 3. 皮肤只管布局：不许出现颜色字面量
// ---------------------------------------------------------------------------

function checkNoColor() {
  section('皮肤只管布局：CSS 里不许有颜色字面量');

  for (const [name, css] of [['sheen', SHEEN], ['workbench', WORKBENCH]]) {
    // 去掉注释再扫：注释里会提到"不出现颜色"这类字样。
    const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const hex = body.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    const rgb = body.match(/\brgba?\(/g) || [];
    // white-space 这类属性名里带颜色词，先把它们摘掉再扫，否则会误报。
    const named = body.replace(/white-space|grey|gray/g, '')
      .match(/\b(?:red|blue|green|white|black)\b/g) || [];
    ok(hex.length === 0, `${name} 没有十六进制颜色${hex.length ? '（' + hex.join(',') + '）' : ''}`);
    ok(rgb.length === 0, `${name} 没有 rgb()/rgba()`);
    ok(named.length === 0, `${name} 没有颜色关键字${named.length ? '（' + named.join(',') + '）' : ''}`);
    // 允许出现的"颜色"只能是变量引用。
    ok(/\bvar\(--/.test(body), `${name} 的着色一律走 var(--…)`);
  }

  section('liunian：颜色字面量同样全禁，color 只准引用主题 token');

  // liunian 复刻 VMusic 的「激活行翻色」，所以它是唯一被允许写 color 的皮肤；
  // 但值必须来自主题（var(--…))，绝不允许字面量在皮肤里把主题色带跑。
  const lnBody = LIUNIAN.replace(/\/\*[\s\S]*?\*\//g, '');
  const lnHex = lnBody.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  const lnRgb = lnBody.match(/\brgba?\(/g) || [];
  const lnNamed = lnBody.replace(/white-space|grey|gray/g, '')
    .match(/\b(?:red|blue|green|white|black)\b/g) || [];
  ok(lnHex.length === 0, `liunian 没有十六进制颜色${lnHex.length ? '（' + lnHex.join(',') + '）' : ''}`);
  ok(lnRgb.length === 0, 'liunian 没有 rgb()/rgba()');
  ok(lnNamed.length === 0, `liunian 没有颜色关键字${lnNamed.length ? '（' + lnNamed.join(',') + '）' : ''}`);
  // 扫独立 color 属性（排除 background-color/-webkit-text-fill-color 这类带前缀的）：
  // 每个 color: 的值都必须以 var(-- 开头。
  const lnColors = Array.from(lnBody.matchAll(/(?:^|[\s;}])color\s*:\s*([^;}]+)/g));
  const badColor = lnColors.filter((m) => !/^\s*var\(--/.test(m[1]));
  ok(badColor.length === 0,
    `liunian 的 color 只能引用主题 token${badColor.length ? '（' + badColor.map((m) => m[1].trim()).join(',') + '）' : ''}`);
  ok(lnColors.length >= 2, 'liunian 确实做了激活行翻色（VMusic 实心底 + 深字）');

  section('皮肤只管布局：属性也应该是布局属性');
  for (const [name, css] of [['sheen', SHEEN], ['workbench', WORKBENCH]]) {
    const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
    // 这两条是"改配色"的典型入口，皮肤不该碰。
    ok(!/^\s*(--bg|--text|--accent|--muted|--brand|--highlight)\s*:/m.test(body),
      `${name} 不重定义主题色变量`);
    ok(!/[^-]\bcolor\s*:/.test(body), `${name} 不写 color（文字色仍由主题决定）`);
  }
}

// ---------------------------------------------------------------------------
// 4. 两套皮肤要有区分度（不是微调）
// ---------------------------------------------------------------------------

function tokensOf(css) {
  const out = {};
  const re = /--skin-([a-z-]+):\s*([^;]+);/g;
  let m;
  while ((m = re.exec(css))) out[m[1]] = m[2].trim();
  return out;
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function checkContrast() {
  section('区分度：两套皮肤的布局令牌要真的反向取值');

  const a = tokensOf(SHEEN);
  const b = tokensOf(WORKBENCH);
  const keys = ['gap', 'pad', 'radius', 'row-py', 'card-min', 'head-pb', 'title'];
  for (const k of keys) {
    ok(k in a && k in b, `两套皮肤都声明了 --skin-${k}`);
  }

  // 间距/圆角/格子：sheen 宽松，workbench 紧凑。要求至少差 1.8 倍，
  // 差个 10% 只能算微调，换皮肤没有意义。
  for (const k of ['gap', 'pad', 'radius', 'row-py', 'card-min', 'head-pb']) {
    const va = num(a[k]);
    const vb = num(b[k]);
    ok(va !== null && vb !== null, `--skin-${k} 是数值（${a[k]} / ${b[k]}）`);
    const ratio = Math.max(va, vb) / Math.min(va, vb);
    ok(ratio >= 1.8, `--skin-${k} 两套相差 ${ratio.toFixed(2)} 倍（要求 ≥1.8，否则只是微调）`);
  }
  ok(num(a['row-py']) > num(b['row-py']), 'sheen 的行更高（低信息密度）');
  ok(num(a['card-min']) > num(b['card-min']), 'sheen 的卡片格子更大（一屏放更少）');

  section('区分度：导航形式与分区方式也不能一样');
  // sheen：导航脱离栅格悬浮在顶部；workbench：导航留在栅格里、贴左侧。
  ok(/\[data-skin="sheen"\] \.rail \{[^}]*position:\s*fixed/.test(SHEEN),
    'sheen 的导航是悬浮定位');
  ok(/flex-direction:\s*row/.test(SHEEN), 'sheen 的导航横向排布');
  ok(!/position:\s*fixed/.test(WORKBENCH.replace(/\/\*[\s\S]*?\*\//g, '')),
    'workbench 的导航不悬浮（留在栅格里）');
  ok(/flex-direction:\s*column/.test(WORKBENCH) || !/flex-direction/.test(WORKBENCH),
    'workbench 的导航仍是竖向（沿用默认布局的竖轨）');

  // 分区：sheen 单列全宽，workbench 三栏。
  ok(/grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(SHEEN), 'sheen 是单列全宽');
  ok(/grid-template-columns:\s*104px/.test(WORKBENCH), 'workbench 是固定三栏');
  ok(/gap:\s*1px/.test(WORKBENCH), 'workbench 用 1px 细线分隔（不是靠间距）');
}

// ---------------------------------------------------------------------------
// 5. 模块覆盖：两套必须覆盖同一批模块
// ---------------------------------------------------------------------------

/// 取出皮肤覆盖到的选择器。同一个规则里的多个选择器各自带 `[data-skin=…]`
/// 前缀，归一化后才是"覆盖了哪个模块"——不然 `.lib-head` 和
/// `[data-skin="x"] .fav-head` 会被当成两个不同的东西，比对必然不一致。
function selectorsOf(css) {
  const out = new Set();
  const re = /\[data-skin="[a-z]+"\]([^{]+)\{/g;
  let m;
  while ((m = re.exec(css))) {
    m[1].split(',').forEach((part) => {
      const s = part.replace(/\[data-skin="[a-z]+"\]\s*/g, '').trim();
      if (s) out.add(s);
    });
  }
  return out;
}

function checkCoverage() {
  section('覆盖：两套皮肤要覆盖同一批模块，不能切过去落回默认');

  const a = selectorsOf(SHEEN);
  const b = selectorsOf(WORKBENCH);
  const missingInB = [...a].filter((s) => !b.has(s));
  const missingInA = [...b].filter((s) => !a.has(s));
  ok(missingInB.length === 0, `sheen 覆盖的模块 workbench 也都有（缺：${missingInB.join(' ')}）`);
  ok(missingInA.length === 0, `workbench 覆盖的模块 sheen 也都有（缺：${missingInA.join(' ')}）`);

  // liunian 必须覆盖与前两套相同的模块集合：多覆盖（如 body::after、.disc-wrap）
  // 允许，少一个都会让某个页面"切了一半"落回默认布局。
  const c = selectorsOf(LIUNIAN);
  const missingInC = [...a].filter((s) => !c.has(s));
  ok(missingInC.length === 0, `liunian 覆盖了其它皮肤的全部模块（缺：${missingInC.join(' ')}）`);

  // 这些是主要模块，一套皮肤漏了任何一个，切过去那块就是"没换皮肤"。
  const must = [
    '.app', '.rail', '.rail-item', '.column', '.view', '.col-head', '.col-title',
    '.track', '.q-row', '.fav-row', '.online-row', '.pl-row',
    '.pl-grid', '.daily-strip', '.daily-list', '.set-group', '.stage', '.bar',
  ];
  for (const m of must) {
    ok([...a].some((s) => s.indexOf(m) >= 0), `sheen 覆盖了 ${m}`);
    ok([...b].some((s) => s.indexOf(m) >= 0), `workbench 覆盖了 ${m}`);
    ok([...c].some((s) => s.indexOf(m) >= 0), `liunian 覆盖了 ${m}`);
  }
}

// ---------------------------------------------------------------------------
// 6. 流年播放卡稳定性（展开态 + 胶囊态）
// ---------------------------------------------------------------------------

function checkLiunianExpandedBarStability() {
  section('流年：播放卡（展开/胶囊）不参与底部播放栏自动隐藏');

  const rule = LIUNIAN.match(/\[data-skin="liunian"\]\s+\.bar:not\(\.ln-capsule\)\s*\{([^}]*)\}/);
  ok(rule && /transform:\s*none\s*!important/.test(rule[1]),
    '展开态钉住 transform，自动隐藏不能把文档流卡片滑出');
  ok(rule && /opacity:\s*1\s*!important/.test(rule[1]),
    '展开态钉住 opacity，自动隐藏不能让文档流卡片闪烁');
  // 胶囊也是文档流卡片：showBar() 先瞬间写 translateY(100%+20px) 再动画
  // 归位，不钉住则鼠标一悬停胶囊就整块下坠再滑回（上下跳动）。
  const capRules = LIUNIAN.match(/\[data-skin="liunian"\]\s+\.bar\.ln-capsule\s*\{[^}]*\}/g) || [];
  ok(capRules.some((r) => /transform:\s*none\s*!important/.test(r)),
    '胶囊态钉住 transform，悬停不会先下坠再滑回');
  ok(capRules.some((r) => /opacity:\s*1\s*!important/.test(r)),
    '胶囊态钉住 opacity，悬停不会闪烁');
  ok(/\.bar\.ln-capsule\.is-hidden\s*\{[^}]*display:\s*grid\s*!important/.test(LIUNIAN),
    '胶囊 is-hidden 仍保持 grid 排版，不发生 flex/grid 切换');
  ok(/\.bar\.is-hidden\s*\{\s*display:\s*none/.test(read(path.join(WEB, 'style.css'))),
    '其它主题仍保留播放栏自动隐藏规则');
}

// ---------------------------------------------------------------------------
// 7. 流年 v3：rail 移除 + 中栏胶囊导航 + 右侧搜索面板
// ---------------------------------------------------------------------------

function checkLiunianNavigation() {
  section('流年 v3：rail 移除、中栏导航与搜索面板');

  // 1) rail 整体隐藏，节点保留（程序化点击其 rail-item 复用 setView）。
  ok(/\[data-skin="liunian"\]\s+\.rail\s*\{\s*display:\s*none/.test(LIUNIAN),
    'CSS 把左侧 rail 钉为 display:none');
  ok(/function clickRailItem/.test(LIUNIAN_JS) && /rail-item\[data-view=/.test(LIUNIAN_JS),
    '皮肤经程序化点击隐藏 rail 内 rail-item 切换视图');
  ok(!/buildLeft\(/.test(LIUNIAN_JS), '不再构建旧左栏');

  // 2) 中栏胶囊导航：六个一级目的地。
  const navBlock = LIUNIAN_JS.match(/function buildNavigation[\s\S]{0,900}?\]\.forEach/);
  ok(navBlock, '中栏顶部构建胶囊导航');
  ok(navBlock && /'library'[\s\S]{0,60}'online'[\s\S]{0,60}'playlists'[\s\S]{0,60}'favorites'[\s\S]{0,60}'queue'[\s\S]{0,60}'settings'/.test(navBlock[0]),
    '胶囊导航含首页/在线/歌单/收藏/队列/设置六项');

  // 3) 右栏包裹器：上搜索面板 + 下舞台。
  ok(/make\('div', 'ln-right', app\)/.test(LIUNIAN_JS), '创建右栏包裹器');
  ok(/buildSearchPanel\(refs\.rightWrap\)/.test(LIUNIAN_JS), '搜索面板挂入右栏上部');
  ok(/relocate\(stage, refs\.rightWrap\)/.test(LIUNIAN_JS), '舞台搬入右栏下部（带锚点可还原）');
  ok(/\[data-skin="liunian"\]\s+\.ln-right\s*\{[\s\S]{0,220}?display:\s*flex/.test(LIUNIAN),
    '右栏包裹器为纵向 flex 分区');

  // 4) 面板输入：范围切换、防抖、epoch 竞态、AbortController。
  ok(/dataset\.scope/.test(LIUNIAN_JS) && /'all'[\s\S]{0,40}'local'[\s\S]{0,40}'online'/.test(LIUNIAN_JS),
    '面板支持全部/本地/在线范围切换');
  ok(/setTimeout\(function \(\) \{ runSearch\(input\.value\); \}, 250\)/.test(LIUNIAN_JS),
    '输入防抖 250ms 后检索');
  ok(/panel\.epoch \+= 1/.test(LIUNIAN_JS) && /AbortController/.test(LIUNIAN_JS)
    && /epoch !== panel\.epoch/.test(LIUNIAN_JS),
    '检索带 epoch 竞态保护与 AbortController 取消');

  // 5) 两源取数与分类分区显示。
  ok(/\/v1\/tracks\?q=' \+ encodeURIComponent\(q\) \+ '&limit=8'/.test(LIUNIAN_JS),
    '本地结果走 /v1/tracks（限 8 条）');
  ok(/\/v1\/online\/search\?source=/.test(LIUNIAN_JS) && /Promise\.all\(sources\.map/.test(LIUNIAN_JS),
    '在线结果并行请求各音源 /v1/online/search');
  ok(/buildSection\(out, '本地歌曲'/.test(LIUNIAN_JS) && /buildSection\(out, '在线曲库'/.test(LIUNIAN_JS),
    '结果按本地歌曲 / 在线曲库两分区显示');
  ok(/window\.Online\.badge\(t\.source\)/.test(LIUNIAN_JS), '在线行挂音源徽标');
  ok(/catch\(function \(\) \{ return \[\]; \}\)/.test(LIUNIAN_JS),
    '单个音源失败时回落空数组，不拖垮整盘搜索');

  // 6) 结果点击：本地/在线直接播放，经 ln:panel 事件交 app.js。
  ok(/new CustomEvent\('ln:panel'/.test(LIUNIAN_JS), '面板经 ln:panel 自定义事件对外通信');
  ok(/emit\('play-local', \{ id: t\.id \}\)/.test(LIUNIAN_JS), '本地结果点击派发 play-local');
  ok(/emit\('play-online', \{ track: t \}\)/.test(LIUNIAN_JS), '在线结果点击派发 play-online');
  ok(/emit\('view-local', \{ q: panel\.q \}\)/.test(LIUNIAN_JS)
    && /emit\('view-online', \{ q: panel\.q \}\)/.test(LIUNIAN_JS),
    '分区可带词跳转曲库页/在线页查看全部');

  // 7) 搜索历史：持久化、去重置顶、单删/清空。
  ok(/HISTORY_KEY = 'vmusic\.ln-search-history'/.test(LIUNIAN_JS),
    '历史记录持久化到 localStorage');
  ok(/readHistory\(\)\.filter\(function \(x\) \{ return x !== q; \}\)/.test(LIUNIAN_JS)
    && /list\.unshift\(q\)/.test(LIUNIAN_JS) && /list\.slice\(0, HISTORY_MAX\)/.test(LIUNIAN_JS),
    '历史去重后置顶，上限 10 条');
  ok(/function removeHistory/.test(LIUNIAN_JS) && /writeHistory\(\[\]\)/.test(LIUNIAN_JS),
    '支持单条删除与清空历史');

  // 8) app.js 桥接。
  ok(/function initPanelBridge/.test(APP) && /initPanelBridge\(\)/.test(APP),
    'app.js 定义并启动面板桥接');
  ok(/document\.addEventListener\('ln:panel'/.test(APP), 'app.js 监听 ln:panel');
  ok(/playTrack\(String\(d\.id\), state\.queue\.slice\(\)\)/.test(APP)
    && /Online\.playAll\(\[Object\.assign\(\{ playable: true \}, d\.track\)\], 0\)/.test(APP),
    '桥接分流本地 playTrack / 在线 Online.playAll');

  // 9) 作用域：搜索面板只属于流年。
  ok(!/ln-sp/.test(SHEEN) && !/ln-sp/.test(WORKBENCH), '其它皮肤不引入搜索面板');
  ok(!/ln-right|ln-sp/.test(HTML), '业务 HTML 不内置右栏面板（皮肤自持，切走即消失）');
}

// ---------------------------------------------------------------------------
// 7. 接线
// ---------------------------------------------------------------------------

function checkWiring() {
  section('接线：HTML / 路由 / 启动');

  ok(/<link rel="stylesheet" href="skins\/skins\.css">/.test(HTML), 'skins.css 常驻引入');
  for (const id of ['sheen', 'workbench', 'liunian']) {
    ok(new RegExp('href="skins/skin\\.' + id + '\\.css"[^>]*data-skin-css="' + id + '"').test(HTML),
      `skin.${id}.css 引了进来并带上 data-skin-css`);
    ok(new RegExp('data-skin-css="' + id + '"[^>]*disabled').test(HTML),
      `skin.${id}.css 默认 disabled（默认不生效）`);
  }
  ok(/src="skins\/skins\.js"/.test(HTML), 'skins.js 引了进来');
  ok(HTML.indexOf('skins/skins.js') < HTML.indexOf('<script src="app.js"'),
    'skins.js 排在 app.js 之前（app.js 启动时要能拿到它）');
  ok(/id="skins-list"/.test(HTML), '设置页有皮肤列表容器');

  for (const p of ['skins/skins.js', 'skins/skins.css', 'skins/skin.sheen.css', 'skins/skin.workbench.css', 'skins/skin.liunian.css', 'skins/skin.liunian.js']) {
    ok(MAIN_RS.includes(`/skins/${p.split('/')[1]}`) || MAIN_RS.includes(p),
      `main.rs 注册了 /${p} 路由`);
  }
  // 只匹配文件名后缀、不写死相对深度：前端目录搬过位置（web/ → plugin/ui/），
  // 把深度写进断言只会让下一次搬迁假红一片。
  ok(/include_str!\("[^"]*\/skins\/skins\.js"\)/.test(MAIN_RS), 'skins.js 编进二进制');
  ok(/include_str!\("[^"]*\/skins\/skin\.liunian\.css"\)/.test(MAIN_RS),
    'skin.liunian.css 编进二进制');
  ok(/include_str!\("[^"]*\/skins\/skin\.liunian\.js"\)/.test(MAIN_RS),
    'skin.liunian.js 编进二进制');

  section('接线：流年重编排 JS 的加载顺序与机制');
  const lnJsAt = HTML.indexOf('src="skins/skin.liunian.js"');
  ok(lnJsAt > 0, 'index.html 引入了 skin.liunian.js');
  ok(lnJsAt > HTML.indexOf('src="skins/skins.js"'),
    'skin.liunian.js 排在 skins.js 之后（要监听 skin:changed）');
  ok(lnJsAt < HTML.indexOf('<script src="app.js"'),
    'skin.liunian.js 排在 app.js 之前');
  ok(/addEventListener\(['"]skin:changed['"]/.test(LIUNIAN_JS),
    '重编排层挂在 skin:changed 事件上（不主动 hook 业务代码）');
  ok(/ln-anchor/.test(LIUNIAN_JS),
    '搬运节点带锚点（切走皮肤可还原）');
  ok(/MutationObserver/.test(LIUNIAN_JS),
    '视图联动用 MutationObserver');

  ok(APP.includes('window.Skins.init()'), 'app.js 启动时初始化皮肤');
  // 皮肤排主题之后：先定主题（配色）再定皮肤（布局），两者互不覆盖。
  const skinAt = APP.indexOf('window.Skins.init()');
  const themeAt = APP.indexOf('initTheme();');
  ok(skinAt > 0 && themeAt > 0 && skinAt < themeAt, 'Skins.init 排在 initTheme 之前');

  ok(/\.skin-option/.test(SKINS_CSS) && /\.skins-list/.test(SKINS_CSS), '皮肤选择控件有样式');
  ok(!/data-skin-css/.test(SKINS_CSS), 'skins.css 不是皮肤本体（没有 data-skin-css 标记）');
}

// ---------------------------------------------------------------------------

(function main() {
  checkCatalog();
  checkExtensibility();
  checkNoColor();
  checkContrast();
  checkCoverage();
  checkLiunianExpandedBarStability();
  checkLiunianNavigation();
  checkWiring();

  console.log('\n' + '─'.repeat(60));
  if (failures) {
    console.error(`界面皮肤契约检查：${checks} 项，${failures} 项失败`);
    process.exit(1);
  }
  console.log(`界面皮肤契约检查：${checks}/${checks} 全部通过`);
})();
