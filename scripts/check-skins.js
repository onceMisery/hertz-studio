#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
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
const IOS = read(path.join(SKINS, 'skin.ios.css'));
const QINGFENG = read(path.join(SKINS, 'skin.qingfeng.css'));
const LIUNIAN_JS = read(path.join(SKINS, 'skin.liunian.js'));
const QINGFENG_JS = read(path.join(SKINS, 'skin.qingfeng.js'));
const SKINS_CSS = read(path.join(SKINS, 'skins.css'));
const HTML = read(path.join(WEB, 'index.html'));
const APP = read(path.join(WEB, 'app.js'));
const STAGE3D_JS = read(path.join(WEB, 'stage3d.js'));
const STAGE_CSS = read(path.join(WEB, 'stage.css'));
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

function makeSandbox(cssIds, carrier) {
  // carrier 决定皮肤 CSS 在页面上以什么元素出现：
  //   'link'（默认）独立形态——index.html 里声明的 <link data-skin-css disabled>；
  //   'style' DBX 插件形态——宿主把 <link rel=stylesheet> 就地内联成 <style>
  //          并搬走属性。此时 disabled **内容**属性不生效（<style> 不反射它），
  //          所以四份皮肤 CSS 进来时全是启用的，得由 init 关掉。
  const tag = carrier === 'style' ? 'style' : 'link';
  const links = (cssIds || []).map((id) => {
    const l = makeEl();
    l.tag = tag;
    l.setAttribute('data-skin-css', id);
    l.disabled = tag === 'link';
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
      // 组合选择器：只把标签名对得上的那份交给调用方，与浏览器行为一致。
      querySelectorAll: (sel) => (
        String(sel).split(',').some((s) => s.trim() === tag + '[data-skin-css]') ? links : []
      ),
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
  section('皮肤目录：五套都在，classic 是"没有皮肤"');

  const { sandbox, root, links } = makeSandbox(['sheen', 'workbench', 'liunian', 'ios', 'qingfeng']);
  const ids = sandbox.Skins.catalog().map((s) => s.id);
  ok(ids.indexOf('classic') >= 0, '有 classic（仓库原本那套布局）');
  ok(ids.indexOf('sheen') >= 0, '有 sheen');
  ok(ids.indexOf('workbench') >= 0, '有 workbench');
  ok(ids.indexOf('liunian') >= 0, '有 liunian');
  ok(ids.indexOf('ios') >= 0, '有 ios');
  ok(ids.indexOf('qingfeng') >= 0, '有 qingfeng');
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

  sandbox.Skins.apply('ios');
  eq(links[2].disabled, true, '切到 ios 后 liunian 的 CSS 收起（两套不能同时生效）');
  eq(links[3].disabled, false, 'ios 的 CSS 启用');

  // 清风与其余四套并存：切过去只亮它那一份，回切后其余四份仍然互不干扰。
  sandbox.Skins.apply('qingfeng');
  eq(root.getAttribute('data-skin'), 'qingfeng', '切到 qingfeng');
  eq(links[4].disabled, false, 'qingfeng 的 CSS 被启用');
  eq(links.every((l, i) => i === 4 || l.disabled), true, '其余四份全部收起（不能同时生效）');

  sandbox.Skins.apply('liunian');
  eq(links[4].disabled, true, '切回 liunian 后 qingfeng 的 CSS 收起');
  eq(links[2].disabled, false, 'liunian 重新启用');
  eq(links[0].disabled && links[1].disabled && links[3].disabled, true,
    '来回切之后 sheen/workbench/ios 仍保持禁用（syncCss 没有累积状态）');

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

  // 清风的 localStorage 往返：它有自己的重编排层，持久化错了会导致
  // 「开机停在 classic 但墙的开关状态是开的」这种半开状态。
  section('持久化：清风的选择能被记住并复原');
  const { sandbox: s5, root: r5, store: st5 } = makeSandbox(['sheen', 'qingfeng']);
  s5.Skins.apply('qingfeng');
  eq(st5.get('vmusic.skin'), 'qingfeng', 'qingfeng 写进 localStorage');
  s5.Skins.init();
  eq(r5.getAttribute('data-skin'), 'qingfeng', '重开后落回 qingfeng（不是 classic）');

  // 插件形态：宿主把样式表内联成 <style>，标记还在但载体换了。认不出来就会
  // hasCss() 恒假、apply() 一律回落 classic，表现是"设置里点皮肤没反应"。
  section('插件形态：皮肤 CSS 被内联成 <style>，切换照样生效');
  const { sandbox: s4, root: r4, links: styles } =
    makeSandbox(['sheen', 'workbench', 'liunian', 'ios', 'qingfeng'], 'style');
  eq(styles.every((s) => s.disabled === false), true,
    'style 的 disabled 内容属性不生效，进来时五份都是启用的');
  s4.Skins.init();
  eq(r4.getAttribute('data-skin'), 'classic', '启动落位在 classic');
  eq(styles.every((s) => s.disabled === true), true,
    '启动就把五份皮肤 CSS 全关掉（同时生效会把五套布局叠在一起）');
  s4.Skins.apply('liunian');
  eq(r4.getAttribute('data-skin'), 'liunian', 'style 载体也认得出皮肤，没有回落 classic');
  eq(styles[2].disabled, false, 'liunian 的 CSS 被启用');
  eq(styles.every((s, i) => i === 2 || s.disabled), true, '其余四份保持禁用');
  eq(s4.Skins.currentId(), 'liunian', 'currentId 跟着走（不是嘴上说切了）');
  s4.Skins.apply('qingfeng');
  eq(styles[4].disabled, false, 'style 载体下 qingfeng 也能启用');
  eq(styles.every((s, i) => i === 4 || s.disabled), true, '切到 qingfeng 后其余保持禁用');
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

  section('iOS：颜色字面量同样全禁，选中态只准引用主题 token');

  // iOS 皮肤用 color-mix(var(--brand)) 做选中态填充（iOS 分段控件的
  // 「淡主色填充」），所以允许写 color/background，但值必须来自主题。
  const ioBody = IOS.replace(/\/\*[\s\S]*?\*\//g, '');
  const ioHex = ioBody.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  const ioRgb = ioBody.match(/\brgba?\(/g) || [];
  const ioNamed = ioBody.replace(/white-space|grey|gray/g, '')
    .match(/\b(?:red|blue|green|white|black)\b/g) || [];
  ok(ioHex.length === 0, `ios 没有十六进制颜色${ioHex.length ? '（' + ioHex.join(',') + '）' : ''}`);
  ok(ioRgb.length === 0, 'ios 没有 rgb()/rgba()');
  ok(ioNamed.length === 0, `ios 没有颜色关键字${ioNamed.length ? '（' + ioNamed.join(',') + '）' : ''}`);
  ok(/\bvar\(--/.test(ioBody), 'ios 的着色一律走 var(--…)');
  ok(!/^\s*(--bg|--text|--accent|--muted|--brand|--highlight)\s*:/m.test(ioBody),
    'ios 不重定义主题色变量（配色归 themes.js 管）');
  ok(/color-mix\(in srgb, var\(--brand\)/.test(ioBody),
    'ios 的选中态用主色派生填充，而不是写死一个颜色');

  section('清风：颜色字面量同样全禁，且不重定义主题色变量');

  const qfBody = QINGFENG.replace(/\/\*[\s\S]*?\*\//g, '');
  const qfHex = qfBody.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  const qfRgb = qfBody.match(/\brgba?\(/g) || [];
  const qfNamed = qfBody.replace(/white-space|grey|gray/g, '')
    .match(/\b(?:red|blue|green|white|black)\b/g) || [];
  ok(qfHex.length === 0, `qingfeng 没有十六进制颜色${qfHex.length ? '（' + qfHex.join(',') + '）' : ''}`);
  ok(qfRgb.length === 0, `qingfeng 没有 rgb()/rgba()${qfRgb.length ? '（' + qfRgb.join(',') + '）' : ''}`);
  ok(qfNamed.length === 0, `qingfeng 没有颜色关键字${qfNamed.length ? '（' + qfNamed.join(',') + '）' : ''}`);
  ok(/\bvar\(--/.test(qfBody), 'qingfeng 的着色一律走 var(--…)');
  // 配色归 themes.js 管。皮肤若在这里重定义 --brand / --highlight，
  // 换皮肤就会把主题色带跑，三层外观（主题/皮肤/舞台主题）就不正交了。
  ok(!/^\s*(--bg|--text|--accent|--muted|--brand|--highlight)\s*:/m.test(qfBody),
    'qingfeng 不重定义主题色变量（配色归 themes.js 管）');
  // 队列拼接的方形海报是这套视觉最强的识别特征，钉住它不被"顺手加圆角"改掉。
  ok(/\[data-skin="qingfeng"\] \.qf-poster\s*\{[^}]*border-radius:\s*0/.test(qfBody),
    '海报墙的卡片保持方角（「一切都方角」是这套视觉的识别特征）');

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
// 4b. iOS / macOS：分层圆角、正常分栏与原生状态
// ---------------------------------------------------------------------------

function checkIosSkin() {
  section('iOS / macOS：分层圆角与可读的列表');

  const t = tokensOf(IOS);
  // 不再把“比浮光更圆、更松”当作正确性。桌面采用 macOS 密度，
  // 面板必须仍大于内部控件；几何和触控尺寸由浏览器验收。
  const rawToken = key => Number(new RegExp(key + ':\\s*([\\d.]+)px').exec(IOS)?.[1]);
  ok(rawToken('--r-sm') < rawToken('--r-lg'), '控件圆角小于分组圆角');
  ok(rawToken('--r-lg') < num(t['radius']), '分组圆角小于面板圆角');
  // 行高：iOS 的行比工作台高得多，但不该比浮光还松（否则与浮光没区分）。
  ok(num(t['row-py']) > num(tokensOf(WORKBENCH)['row-py']),
    'iOS 的行比工作台高');
  ok(num(t['row-py']) <= num(tokensOf(SHEEN)['row-py']) + 4,
    'iOS 的行高与浮光同一档（两者都属低密度，不能互相没区分）');

  // 就地覆盖圆角梯度：只声明 --skin-* 不够，组件层的 --r-* 也要跟着圆。
  const ioBody = IOS.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const k of ['--r-md', '--r-lg', '--r-xl']) {
    ok(new RegExp('\\' + k + '\\s*:').test(ioBody), `iOS 覆盖了 ${k}（按钮/输入框/弹窗一起变圆）`);
  }
  // 行高令牌必须真的被行消费，否则声明了也不生效。
  ok(/line-height:\s*var\(--skin-line\)/.test(ioBody), 'iOS 把行高令牌接到列表行上');
  ok(/--skin-line:\s*1\.5/.test(ioBody), 'iOS 的行高约 1.5（正文可读性）');

  section('iOS：布局与真实状态接线');
  ok(/body\[data-stage-idle="1"\] \.app\s*\{\s*grid-template-columns:\s*var\(--rail-w\) minmax\(0, 1fr\)/.test(ioBody),
    '空闲时保留导航列并释放舞台列');
  ok(/\[data-skin="ios"\] \.stage\s*\{\s*position:\s*relative/.test(ioBody),
    '桌面舞台留在正常流，避免固定定位与三列占位叠加');
  // 导航形态：iOS 保留竖排（与工作台一致），但选中态是淡色填充而非左条。
  ok(!/\[data-skin="ios"\] \.rail \{[^}]*position:\s*fixed/.test(IOS),
    'iOS 的导航留在栅格里（不悬浮）');
  ok(/\[data-skin="ios"\] \.rail-item\.active/.test(IOS),
    'iOS 的导航选中态匹配 app.js 使用的 .active');
  ok(/--ios-selected:\s*color-mix\(in srgb, var\(--brand\)/.test(IOS),
    '选中填充从主题主色派生');
  ok(/:focus-visible/.test(ioBody) && /:disabled/.test(ioBody), '皮肤覆盖键盘焦点与禁用状态');
  ok(/safe-area-inset-bottom/.test(ioBody) && /100dvh/.test(ioBody), '包含安全区和动态视口适配');

  // 顶栏那个齿轮是冗余的：侧栏底部已有 data-view="settings" 入口。
  // 这里钉死"用 display:none 而不是 visibility:hidden"——后者仍占位（把后面的
  // 图标顶偏）且留在 Tab 序里，会变成看不见却能聚焦的按钮。
  ok(/\[data-skin="ios"\]\s*#settings-entry\s*\{\s*display:\s*none/.test(IOS),
    'iOS 摘掉顶栏的设置齿轮（侧栏已有同一入口）');
  ok(!/\[data-skin="ios"\][^{}]*#settings-entry[^{}]*\{[^}]*visibility/.test(IOS),
    '摘齿轮用 display:none（visibility 仍占位、且留在 Tab 序里）');
  // 摘的是"不长出来"，不是"功能消失"：业务侧引用必须留着，键盘/快捷键
  // 路径仍要能开设置。index.html 的按钮与 app.js 的缓存引用都不该被改。
  ok(HTML.indexOf('id="settings-entry"') > 0, '业务 HTML 仍保留 #settings-entry（iOS 只是 CSS 层不显示）');
  ok(/rail-item" data-view="settings"/.test(HTML), '侧栏保留设置入口（摘掉顶栏齿轮后仍可达）');

  // 显示名与持久化键是两件事：name 只进设置列表，localStorage 靠 id。
  // 钉死"id 仍是 ios"是为了防止有人连 id 一起改，那会让已经存了
  // vmusic.skin='ios' 的用户切皮肤时静默回落到 classic。
  ok(/id:\s*'ios',\s*\n(?:\s*\/\/[^\n]*\n)*\s*name:\s*'OS风'/.test(SKINS_JS),
    "iOS 皮肤显示名为 'OS风'");
  ok(/id:\s*'ios'/.test(SKINS_JS), "id 仍是 'ios'（持久化键 vmusic.skin 靠它）");
  ok(!/name:\s*'iOS'/.test(SKINS_JS), "皮肤显示名不再叫 'iOS'（避免像 Apple 官方出品）");
}

/// 浮光：胶囊并入顶栏 + 摘掉常驻搜索框。
///
/// 这一组防的是两个曾经出现过的静默退化：
///
///   1. **留白回来了**。胶囊与内容区各占一层时，.view 的 padding-top 是
///      「顶栏 + 胶囊高 + 间距」≈134px。数字看着合理，实际内容区上方
///      那一大片里什么都没有 —— 页面不报错、不少元素，只是白白浪费
///      第一屏。所以这里钉死"宽屏让位值为 0"，且胶囊 top 必须落在
///      顶栏高度**之内**（不是底边之下）。
///   2. **`/` 与 Ctrl+K 静默失效**。摘掉常驻搜索框后，若快捷键还走
///      裸 ui.search.focus()，浮光下那条覆盖式搜索条永远不显形 ——
///      按键没反应、控制台干净。这里要求 app.js 走 focusSearch()，
///      并要求 blur 与 Escape 摘掉标记，否则搜索条会一直挂顶栏。
function checkSheenTopbarLayout() {
  section('浮光：胶囊并入顶栏，常驻搜索框摘掉但快捷键仍可用');

  const style = read(path.join(WEB, 'style.css'));

  // 让位令牌必须是 0（而不是 134px）。写死 0 有点直白，但这里要的就是
  // "宽屏不为胶囊留高度"这个事实本身 —— 换成 calc() 又会被窄屏覆盖
  // 绕回来，不如直接钉住。
  ok(/--skin-clear-wide:\s*0px/.test(SHEEN),
    '浮光宽屏的内容让位值为 0（胶囊并入顶栏，不再留 134px 空白）');

  // 胶囊 top 必须小于顶栏高度，也就是落在顶栏那一行里。
  // 只断言"有个 top"太松：原来的 top = topbar-h + 12 同样有 top。
  // 这里直接读出 .rail 规则块（花括号配平，calc 里的嵌套括号不会被截断），
  // 再判断它是「顶栏内居中」还是「顶栏底边之下」。
  const railRule = (() => {
    const i = SHEEN.indexOf('[data-skin="sheen"] .rail {');
    if (i < 0) return '';
    let depth = 0;
    for (let j = SHEEN.indexOf('{', i); j < SHEEN.length; j += 1) {
      if (SHEEN[j] === '{') depth += 1;
      else if (SHEEN[j] === '}') { depth -= 1; if (!depth) return SHEEN.slice(i, j + 1); }
    }
    return '';
  })();
  ok(!!railRule, '浮光给 .rail 定了位置');
  const topLine = (railRule.match(/top:\s*([^;]+);/) || [])[1] || '';
  ok(!!topLine, '.rail 规则块里有 top 声明');
  ok(/--skin-rail-h/.test(topLine),
    `胶囊 top 由自身高度参与计算，不是写死的偏移（${topLine.trim()}）`);
  ok(!/var\(--topbar-h\)\s*\+\s*var\(--skin-rail-top\)/.test(topLine),
    '胶囊 top 不是「顶栏底边 + 偏移」（那正是留白的成因）');
  // 数值验算：topbar 58 - 胶囊 46 = 12，整除 2 = 6px < 顶栏高。
  ok(/\)\s*\/\s*2\s*\)/.test(topLine) || /var\(--skin-rail-h\)/.test(topLine),
    `胶囊在顶栏高度内垂直居中（${topLine.trim()}）`);

  // .view 与 .stage 必须都消费归零后的让位值：漏掉 .stage 会让它
  // 比内容低一截，两者对不齐（stage 同样浮在同一片区域）。
  ok(/\[data-skin="sheen"\]\s+\.view\s*\{[^}]*padding:\s*var\(--skin-clear-wide\)/.test(SHEEN),
    '.view 用归零后的让位值');
  ok(/\[data-skin="sheen"\]\s+\.stage\s*\{[^}]*top:\s*calc\(var\(--topbar-h\)\s*\+\s*var\(--skin-clear-wide\)/.test(SHEEN),
    '.stage 也跟着归零（否则比内容低 134px）');
  // 宽屏规则里不该再消费旧的 134px 让位值。只查"消费"（var(...) 形式），
  // 不查"声明"——注释里解释这个名字的来历是应该的（--skin-rail-clear
  // 仍然是窄屏胶囊独占一行时要用的值，声明留着不删）。
  ok(!/var\(--skin-rail-clear\)/.test(SHEEN.split('@media')[0]),
    '宽屏基础规则里不再消费 --skin-rail-clear（那 134px 正是留白来源）');
  ok(!/var\(--skin-rail-clear\)/.test(railRule),
    '.rail 规则块里不消费旧的让位值');

  // ⭐ 胶囊**不能居中**。这条是实测抓出来的：顶栏左右并不对称 ——
  // 品牌块只有 --rail-w（86px），右侧图标区却要 408px（连接状态文字 +
  // 六个图标）。`left:50% + translateX(-50%)` 把胶囊往宽的那侧挤，
  // 实测右缘 1050 压住图标区左缘 1032，整整压了 17px。左对齐紧跟品牌块
  // 时右缘只有 763，余量 269px，谁也不碰谁。
  const railLeft = (railRule.match(/left:\s*([^;]+);/) || [])[1] || '';
  ok(!/50%/.test(railLeft),
    `胶囊不按视口居中（left=${railLeft.trim()}）—— 左右不对称会压到右侧图标`);
  ok(!/translateX\(-50%\)/.test(railRule),
    '.rail 没有 translateX(-50%)（那正是居中的实现）');
  ok(/var\(--rail-w\)/.test(railLeft),
    `胶囊左缘跟品牌块对齐（left=${railLeft.trim()}）`);
  // 右侧图标区宽度随连接状态文案变化（"服务已连接" / "重连中 (13s)"），
  // 所以上限必须留足余量，否则文案一变长就压上去。
  const railMax = (railRule.match(/max-width:\s*([^;]+);/) || [])[1] || '';
  ok(/100vw/.test(railMax) && /430px/.test(railMax),
    `胶囊为右侧图标区留足 430px（max-width=${railMax.trim()}）`);

  // 窄屏必须把让位加回来：胶囊在 ≤900px 退回"顶栏下方独占一行"，
  // 那时 .view 的绝对 padding 是唯一防线，胶囊会盖住第一行内容。
  ok(/@media \(max-width: 900px\)[\s\S]*?\.rail\s*\{[\s\S]*?top:\s*calc\(var\(--topbar-h\)\s*\+\s*12px\)/.test(SHEEN),
    '≤900px 胶囊退回顶栏下方独占一行');
  ok(/@media \(max-width: 900px\)[\s\S]*?\.view\s*\{[\s\S]*?padding:\s*calc\(var\(--topbar-h\)/.test(SHEEN),
    '≤900px 内容重新让出高度（胶囊独占一行时不留位会盖住第一行）');
  ok(/@media \(max-width: 900px\)[\s\S]*?\.rail\s*\{[\s\S]*?max-width:\s*none/.test(SHEEN),
    '≤900px 放开胶囊宽度约束（宽屏那套要避开品牌块与右侧图标，窄屏没那个余量）');
  ok(/@media \(max-width: 900px\)[\s\S]*?\.rail\s*\{[\s\S]*?left:\s*10px[\s\S]*?right:\s*10px/.test(SHEEN),
    '≤900px 胶囊左右贴边铺开（居中/跟品牌块都不适用于窄屏）');

  // 搜索框：摘的是"不常驻"，不是"功能没了"。
  ok(/\[data-skin="sheen"\]\s+\.topsearch\s*\{[^}]*opacity:\s*0/.test(SHEEN),
    '浮光下常驻搜索框不可见');
  ok(/\[data-skin="sheen"\]\s+\.topsearch\s*\{[^}]*position:\s*fixed/.test(SHEEN),
    '搜索框改成覆盖式（脱流），不再占顶栏中段把胶囊挤走');
  // display:none / visibility:hidden 都会让 .focus() 静默失效，
  // 所以必须用 opacity + pointer-events 这套"看不见但可聚焦"的写法。
  ok(!/\[data-skin="sheen"\]\s+\.topsearch\s*\{[^}]*display:\s*none/.test(SHEEN),
    '不用 display:none（那样 focus() 静默失效，快捷键就成了死键）');
  ok(/body\.sheen-search\s+\.topsearch\s*\{[^}]*opacity:\s*1/.test(SHEEN),
    '按 / 或 Ctrl+K 时搜索框显形');
  ok(!/\[data-skin="sheen"\][^{}]*\.topsearch[^{}]*\{[^}]*visibility:\s*hidden/.test(SHEEN),
    '不用 visibility:hidden（同样会让焦点丢失）');

  /* --- 唤起时胶囊必须让位（这条是实测抓出来的真 bug，不是洁癖） ---------
     .topsearch 是 header.topbar 的**子节点**，而 .topbar 自己就形成层叠
     上下文（style.css 的 position:relative + z-index:40，再加 backdrop-filter，
     两者任一都够）。于是 .topsearch 上的 z-index:62 只在 topbar 内部比较，
     压不过 body 层的 #rail(61) —— 父级 40 < 兄弟 61，子元素再大也没用。

     后果极静默：按 / 之后 opacity 确实 1、焦点确实在它上面、控制台干净，
     但胶囊那层玻璃完整盖住它，**屏幕上什么都不会出现**，像按键没生效。

     所以让位必须由胶囊退场来兜底，不能只靠搜索框自己的 z-index。 */
  ok(/body\.sheen-search\s+\.rail\s*\{[^}]*visibility:\s*hidden/.test(SHEEN),
    '唤起时胶囊退场（visibility:hidden）—— 否则盖不住，见上面那条');
  ok(/body\.sheen-search\s+\.rail\s*\{[^}]*pointer-events:\s*none/.test(SHEEN),
    '退场后的胶囊不可点（否则仍然吃走命中点）');
  // 反向钉死：不能改成"抬 .topbar 的 z-index 来压过胶囊" ——
  // 40 是给舞台抽屉（窄屏 z-index:50）与控制菜单(80)留的窗口，
  // 抬到 62 会让抽屉贴着顶栏被切开。
  //
  // 必须先剥注释：.topbar 那段说明里恰好写着「窄屏下 .stage 变成
  // z-index:50 的抽屉」，不剥的话正则先命中注释里的 50，断言永远红，
  // 而且红得毫无道理 —— 这是"给自己造一个不会失败的检查"的反面：
  // 造一个永远失败的检查。
  const topbarRule = (() => {
    const clean = stripCssComments(style);
    const i = clean.indexOf('\n.topbar {');
    if (i < 0) return '';
    let depth = 0;
    for (let j = clean.indexOf('{', i); j < clean.length; j += 1) {
      if (clean[j] === '{') depth += 1;
      else if (clean[j] === '}') { depth -= 1; if (!depth) return clean.slice(i, j + 1); }
    }
    return '';
  })();
  const topbarZ = (topbarRule.match(/z-index:\s*(\d+)/) || [])[1] || '';
  ok(topbarZ === '40',
    `.topbar 的 z-index 仍是 40（实际 ${topbarZ || '无'}）—— 抬它去压胶囊会切开舞台抽屉`);

  // 业务侧：快捷键必须走 focusSearch()，并有 blur/Escape 收回标记。
  ok(/function focusSearch\(select\)/.test(APP), 'app.js 有 focusSearch() 统一唤起搜索');
  ok(/body\.classList\.add\('sheen-search'\)/.test(APP),
    'focusSearch 给 body 挂 sheen-search 标记（CSS 据此显形）');
  ok(/e\.key === '\/' && !typing\)\s*\{\s*e\.preventDefault\(\);\s*focusSearch\(false\)/.test(APP),
    '`/` 走 focusSearch()');
  ok(/e\.key\.toLowerCase\(\) === 'k'\)\s*\{[\s\S]{0,200}?window\.Palette\) Palette\.open\(\);[\s\S]{0,80}?else focusSearch\(true\)/.test(APP),
    'Ctrl+K 走命令面板（palette.js 没加载时回落 focusSearch()）');
  ok(/ui\.search\.addEventListener\('blur'[\s\S]{0,120}?classList\.remove\('sheen-search'\)/.test(APP),
    '搜索框失焦时摘掉标记（否则那条覆盖搜索条一直挂在顶栏上）');
  ok(/e\.key === 'Escape'[\s\S]{0,400}?classList\.remove\('sheen-search'\)/.test(APP),
    'Esc 也能摘掉标记');

  // 摘搜索框不能连业务状态一起摘：state.q 与 ui.searchClear 都还在用。
  ok(/ui\.search\.oninput/.test(APP), '搜索输入事件仍绑定（浮光下也能搜）');
  ok(/ui\.searchClear\.onclick/.test(APP), '清空按钮仍绑定');
  ok(/id="search"/.test(HTML) && /id="search-clear"/.test(HTML),
    '搜索框与清空按钮仍在 DOM 里（只是浮光下默认不显示）');
  ok(style.length > 0, 'style.css 可读');
}

// ---------------------------------------------------------------------------
// 5. 模块覆盖：两套必须覆盖同一批模块
// ---------------------------------------------------------------------------

/// 取出皮肤覆盖到的选择器。同一个规则里的多个选择器各自带 `[data-skin=…]`
/// 前缀，归一化后才是"覆盖了哪个模块"——不然 `.lib-head` 和
/// `[data-skin="x"] .fav-head` 会被当成两个不同的东西，比对必然不一致。
///
/// 必须先剥注释：CSS 允许把注释插在选择器列表中间（sheen 的 `.dv-row`
/// 前面就有一整块说明为什么补上它），不剥的话最后一条选择器会被解析成
/// "注释文字 + .dv-row"，与其它皮肤的 `.dv-row` 比不上 —— 报出一个
/// 根本不存在的覆盖缺口。
function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/// JS 侧的同一件事：断言「有没有调某个函数 / 有没有 remove 某个 class」时，
/// 如果说明这个坑的注释里恰好写着那句话，正则会匹配到注释，断言永远绿 ——
/// 这是给自己造一个不会失败的检查，比没有检查更糟。
function stripJsComments(js) {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

function selectorsOf(rawCss) {
  const css = stripCssComments(rawCss);
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

  // 「几何模块」= 每套皮肤都必须覆盖的（漏一个 = 切过去那块的行距/内距/圆角
  // 落回 style.css 默认，与本页其它列表节奏不一致，是真缺陷）。
  // 三类不算在里面，理由各不相同：
  //  a) 纯排版分档（.dv-name 的字号）：漏了只读作"没分档"，不算破相 ——
  //     各皮肤令牌名都不一样（--skin-h2 / --skin-title），强求逐字相等
  //     等于逼着后来者照抄别人的令牌体系。
  //  b) 浮光独有的顶栏搜索框（.topsearch）：浮光把常驻搜索框摘了，让顶栏
  //     中段给导航胶囊，改用「按 / 或 Ctrl+K 唤起一条覆盖式搜索条」。
  //     别的皮肤没有这个交互、也不该有 —— 要求它们各写一条只等于制造死代码。
  //     它是**皮肤间的真实差异**，不是漏覆盖，所以归这里而不是 must 名单。
  //  c) 舞台面板内部的余量分配（.stage-lyrics / .disc-wrap）：浮光的舞台是
  //     fixed 悬浮面板，宽度由 min(420px,32vw) 定，面板有 min-height；
  //     于是「余量给谁」是它独有的问题 —— 实测没歌词时 .disc-wrap（flex:none、
  //     宽高比 1）会吃满余量，把歌词区压到 26px、面板底部空 119px。
  //     别的皮肤舞台是**栅格里的右栏**（高度由栅格给满）或 fixed 抽屉，
  //     本来就不存在这个余量问题，让它们各写一条等于制造死代码。
  //  d) 面板里的曲名/艺人（.stage-title / .stage-artist）：同一个悬浮面板的
  //     另一个独有结论 —— 它是定高 flex 列，歌词区压到 min-height:96 之后
  //     剩下的缺口会落到这两个可收缩行上（实测行盒 33px→14px、字被切半截）。
  //     浮光干脆不展示它们（信息播放条里一直有），别的皮肤舞台有空间、
  //     本来就得显示曲名与艺人，让它们跟着摘等于砍功能。
  const GEOMETRY_OPTIONAL = /^\.(dv-name|dv-sub|dv-num|dv-src|topsearch|stage-lyrics|disc-wrap|stage-title|stage-artist)$/;
  const isGeometry = (s) => !GEOMETRY_OPTIONAL.test(s) && !/^[^\s]*\s/.test(s);

  const geometryGap = (from, to, fromName, toName) => {
    const have = selectorsOf(to);
    const miss = [...selectorsOf(from)].filter((s) => isGeometry(s) && !have.has(s));
    ok(miss.length === 0, `${toName} 覆盖了 ${fromName} 的全部几何模块（缺：${miss.join(' ') || '无'}）`);
  };

  const a = selectorsOf(SHEEN);
  const b = selectorsOf(WORKBENCH);
  const c = selectorsOf(LIUNIAN);
  const d = selectorsOf(IOS);
  const e = selectorsOf(QINGFENG);
  const missingInB = [...a].filter((s) => isGeometry(s) && !b.has(s));
  const missingInA = [...b].filter((s) => isGeometry(s) && !a.has(s));
  ok(missingInB.length === 0, `sheen 覆盖的几何模块 workbench 也都有（缺：${missingInB.join(' ') || '无'}）`);
  ok(missingInA.length === 0, `workbench 覆盖的几何模块 sheen 也都有（缺：${missingInA.join(' ') || '无'}）`);

  // 其余三套与 sheen 比几何模块（多覆盖如 body::after、.qf-* 允许）。
  geometryGap(SHEEN, LIUNIAN, 'sheen', 'liunian');
  geometryGap(SHEEN, IOS, 'sheen', 'ios');
  geometryGap(SHEEN, QINGFENG, 'sheen', 'qingfeng');

  // 这些是主要模块，一套皮肤漏了任何一个，切过去那块就是"没换皮肤"。
  const must = [
    '.app', '.rail', '.rail-item', '.column', '.view', '.col-head', '.col-title',
    '.track', '.q-row', '.fav-row', '.online-row', '.pl-row',
    '.pl-grid', '.daily-strip', '.daily-list', '.set-group', '.stage', '.bar',
    // .dv-row 在这里，是因为五套皮肤曾一致漏掉它：每日推荐的"列表画法"行
    // 自带一套 padding/radius，既不在任何一套皮肤的行名单里，也不在上面
    // 这批 must 里，于是它成了全站唯一"切皮肤不改"的行——每套皮肤里它都
    // 比同页其它列表挤一号。列入 must 是为了让这个缺口不能再无声回来。
    '.dv-row',
  ];
  for (const m of must) {
    for (const [set, name] of [[a, 'sheen'], [b, 'workbench'], [c, 'liunian'], [d, 'ios'], [e, 'qingfeng']]) {
      ok([...set].some((s) => s.indexOf(m) >= 0), `${name} 覆盖了 ${m}`);
    }
  }

  // 卡片列宽规则必须落在 .daily-list，不能落在 .daily-strip。
  //
  // .daily-strip 的直接子元素是 .daily-head 和 .daily-list 两个**块**，
  // 卡片在 .daily-list 里。给 .daily-strip 加 display:grid + 卡片列宽后，
  // .daily-head 成了一个网格项 —— 它内部是「左 copy（长文案）+ 右 tools
  // （一排按钮）」的横向 flex，网格列宽由内容均分，copy 就被压到最窄的一列，
  // 「DAILY MIX · 每日推荐」「2026-10-03」「已合并 24 首」逐字换行竖排成一条。
  //
  // 页面不报错、不崩、不少元素，契约的「覆盖了 .daily-strip」也照样通过 ——
  // 所以必须单独钉这条：外壳容器不许被改成卡片网格。
  const stripRule = (src) => {
    const m = /\.daily-strip\s*\{([^}]*)\}/.exec(stripCssComments(src));
    return m ? m[1] : '';
  };
  for (const [src, name] of [[SHEEN, 'sheen'], [WORKBENCH, 'workbench'], [LIUNIAN, 'liunian'], [IOS, 'ios'], [QINGFENG, 'qingfeng']]) {
    const body = stripRule(src);
    ok(!/display\s*:\s*(grid|inline-grid|flex)/.test(body),
      `${name} 没把 .daily-strip 改成网格/弹性容器`, `实际：${body.trim().slice(0, 60)}`);
  }
  // 反向：清风真的把列宽搬到 .daily-list 了吗？
  ok(/\.daily-list\s*\{[^}]*grid-template-columns/.test(QINGFENG),
    'qingfeng 的卡片列宽落在 .daily-list 上');

  // 每日推荐的行不能只是"被提到"，还得真的调过几何。只写一条空规则
  // 骗过上面的选择器计数是可能的，所以这里断言声明真的落地。
  ok(/\.dv-row\s*\{[^}]*padding/.test(SHEEN),
    'sheen 的 .dv-row 真的调了 padding（不是空壳规则）');
  ok(/\.dv-row\s*\{[^}]*border-radius/.test(SHEEN),
    'sheen 的 .dv-row 真的调了 border-radius');
  ok(/\.dv-row\s*\{[^}]*--skin-row-py/.test(SHEEN),
    'sheen 的 .dv-row 跟着 --skin-row-py 走（行距归皮肤令牌，不写死 px）');
  ok(/\.dv-row\s*\{[^}]*--skin-line-h/.test(SHEEN),
    'sheen 的 .dv-row 跟着 --skin-line-h 走（行高在行容器上定一次）');
  ok(/\.dv-body\s*\{[^}]*--skin-gap/.test(SHEEN),
    'sheen 把 .dv-body 的行距交给 --skin-gap（否则这一屏比同页任何列表都紧）');
}

// ---------------------------------------------------------------------------
// 5b. 每日推荐：滚动链三件套
// ---------------------------------------------------------------------------
// 这一条不属于任何一套皮肤，它在 style.css 里，而且是**基线缺陷**：
// .view 只是 flex:1 + min-height:0，自己不滚；.column 是 overflow:hidden。
// 于是作为内容体的 .dv-body 必须自己收下 flex:1 / min-height:0 /
// overflow-y ——少一条，30 首推荐就撑到内容全高再被裁掉，表现为
// "只能看前十几首且滚不动"。这个失败模式最坏的地方是**不报错、不崩、
// 不少元素**，页面上只是矮了一截，很容易当成"数据就这么多"。
//
// 四条同类内容体（.lib-list / .pl-list / .q-list / .fav-list）早就是这套
// 三件套，.dv-body 是唯一漏的。这里连它们一起扫，免得下次再漏一个。
function checkDailyScroll() {
  section('每日推荐：内容体自己滚，且与同类列表体同一套三件套');

  const style = read(path.join(WEB, 'style.css'));

  // 一个选择器在文件里可能有多条规则（.fav-list 一条管 flex 列向、另一条
  // 才写滚动三件套），所以要把**全部**同名规则的声明拼起来看，而不是只取
  // 第一条 —— 只取第一条会让 .fav-list 假失败。
  // .dv-body 与 .dv-body-card 前缀相同，用 (?![\w-]) 断开，否则卡片那条的
  // 声明会被算成列表这条的。选择器里的 . 要转义。
  const declsOf = (sel) => {
    const re = new RegExp(`${sel.replace('.', '\\.')}(?![\\w-])\\s*\\{([^}]*)\\}`, 'g');
    return [...style.matchAll(re)].map((m) => m[1]).join('\n');
  };

  const dv = declsOf('.dv-body');
  ok(/\bflex:\s*1\b/.test(dv), '.dv-body 有 flex:1（否则撑到内容全高被 .column 裁掉）');
  ok(/\bmin-height:\s*0\b/.test(dv), '.dv-body 有 min-height:0（否则不缩，中栏多高它就多高）');
  ok(/overflow-y:\s*auto/.test(dv), '.dv-body 有 overflow-y:auto（不然后面十几首滚不到）');
  ok(/overscroll-behavior-y:\s*contain/.test(dv),
    '.dv-body 有 overscroll-behavior-y:contain（滚到底不把外层一起带走）');

  // 同类内容体逐个对照：这些是"内容体兼滚动容器"的既有正确写法。
  for (const [sel, label] of [
    ['.lib-list', '曲库'],
    ['.pl-list', '歌单详情'],
    ['.q-list', '队列'],
    ['.fav-list', '收藏'],
  ]) {
    const b = declsOf(sel);
    ok(/overflow-y:\s*auto/.test(b), `${label} ${sel} 是滚动容器（三件套齐）`);
    ok(/\bmin-height:\s*0\b/.test(b), `${label} ${sel} 有 min-height:0`);
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
  ok(!/ln-sp/.test(SHEEN) && !/ln-sp/.test(WORKBENCH), '其它皮肤不引入遮罩浮层');
  ok(!/ln-right|ln-sp/.test(HTML), '业务 HTML 不内置右栏面板（皮肤自持，切走即消失）');
}

// ---------------------------------------------------------------------------
// 6b. 流年：设置浮层（点「设置」在底层面板之上弹一层，而不是切中栏视图）
// ---------------------------------------------------------------------------

function checkLiunianSettingsSheet() {
  section('流年：设置浮层（遮罩 / 过渡 / 关闭 / 层级）');

  // 1) 设置视图被搬进浮层，且用 relocate 留锚点（切皮肤严格回位）。
  ok(/function buildSettingsSheet/.test(LIUNIAN_JS), '构建设置浮层');
  ok(/relocate\(view, pane\)/.test(LIUNIAN_JS),
    '设置视图经 relocate 搬进浮层右栏（原位留锚点，可还原）');
  // 浮层内容切成两栏：左栏分类导航 + 右栏设置视图。两者都在 .ln-modal-body 里，
  // 少一个就退化成单列长滚动（等于这个特性没生效）。
  ok(/make\('div', 'ln-set-layout', body\)/.test(LIUNIAN_JS)
    && /make\('nav', 'ln-set-nav', layout\)/.test(LIUNIAN_JS)
    && /make\('div', 'ln-set-pane', layout\)/.test(LIUNIAN_JS),
    '浮层内容分两栏：左栏 .ln-set-nav + 右栏 .ln-set-pane');
  ok(/make\('section', 'ln-modal-card', root\)/.test(LIUNIAN_JS)
    && /make\('div', 'ln-modal-scrim', root\)/.test(LIUNIAN_JS),
    '浮层由遮罩 + 卡片两层构成');
  ok(/setAttribute\('role', 'dialog'\)/.test(LIUNIAN_JS) && /setAttribute\('aria-modal', 'true'\)/.test(LIUNIAN_JS),
    '卡片带 dialog / aria-modal 语义');

  // 2) 入口：导航「设置」与 clickRailItem('settings') 都开浮层，不切中栏视图。
  ok(/openSettingsSheet\(button\)/.test(LIUNIAN_JS),
    '导航「设置」打开浮层');
  ok(/if \(view === 'settings'\) \{\s*openSettingsSheet\(\)/.test(LIUNIAN_JS),
    'clickRailItem 对 settings 改为开浮层（避免 setView 把中栏切空）');
  ok(/if \(sheet\.open\) closeSettingsSheet\(\);\s*else openSettingsSheet\(target\);/.test(LIUNIAN_JS)
    && /addEventListener\('click', onDocumentClickCapture, true\)/.test(LIUNIAN_JS),
    '顶栏设置图标被 capture 阶段拦截并开关浮层');

  // 3) 关闭路径：遮罩、关闭按钮、Esc，且退场动画结束后才隐藏。
  ok(/ln-modal-scrim'\)\.addEventListener|scrim\.addEventListener\('click', function \(\) \{ closeSettingsSheet\(\); \}\)/.test(LIUNIAN_JS),
    '点遮罩可关闭');
  ok(/close\.addEventListener\('click', function \(\) \{ closeSettingsSheet\(\); \}\)/.test(LIUNIAN_JS),
    '点关闭按钮可关闭');
  ok(/function onSheetKeydown[\s\S]{0,160}e\.key !== 'Escape'/.test(LIUNIAN_JS),
    'Esc 可关闭');
  ok(/classList\.add\('is-closing'\)/.test(LIUNIAN_JS) && /classList\.remove\('is-open'\)/.test(LIUNIAN_JS),
    '关闭走 .is-closing 退场态');
  ok(/setTimeout\(function \(\) \{[\s\S]{0,420}?root\.hidden = true/.test(LIUNIAN_JS),
    '退场动画结束后才置 hidden（退场动画真的能播完）');

  // 4) 层级：浮层必须压过所有既有浮层，且与底层面板不冲突。
  const modalRule = LIUNIAN.match(/\[data-skin="liunian"\]\s+\.ln-modal\s*\{([^}]*)\}/);
  ok(modalRule && /position:\s*fixed/.test(modalRule[1]), '浮层固定定位脱离文档流');
  const z = modalRule && Number((modalRule[1].match(/z-index:\s*(\d+)/) || [])[1]);
  ok(Number.isFinite(z) && z >= 100,
    `浮层层级高于既有浮层（z-index=${z}，须 ≥ 在线弹窗的 100）`);
  ok(/classList\.add\('ln-modal-open'\)/.test(LIUNIAN_JS)
    && /classList\.remove\('ln-modal-open'\)/.test(LIUNIAN_JS),
    '打开/关闭时给 body 打标记，供样式隔离底层');

  // 4b) 隔离底层只能挡交互，不能加 filter/backdrop-filter：
  // filter 会让 .app 变成包含块，而流年把 .bar 搬进了中栏（.app 子树内），
  // 一旦子树里出现 fixed 后代就会被改相对定位。压暗交给遮罩。
  const isolate = LIUNIAN.match(/\[data-skin="liunian"\]\s+body\.ln-modal-open[^{]*\{([^}]*)\}/g) || [];
  ok(isolate.length > 0, 'body 标记确有对应样式（不是死代码）');
  ok(isolate.every((r) => !/filter/.test(r)),
    '底层隔离不加 filter（否则 .app 变包含块，搬进去的播放卡会错位）');
  ok(/pointer-events:\s*none/.test(isolate.join('')), '底层隔离用 pointer-events 挡交互');

  // 5) 过渡动画：进场用 animation（display 恢复自动播），退场用 transition。
  ok(/ln-modal\.is-open \.ln-modal-card\s*\{[^}]*animation:\s*ln-modal-in/.test(LIUNIAN),
    '进场用 keyframes 动画（hidden→可见时自动播放）');
  ok(/ln-modal\.is-closing \.ln-modal-card\s*\{[^}]*animation:\s*none[^}]*transition-duration/.test(LIUNIAN),
    '退场切到 transition 播反向动画');
  ok(/backwards/.test(LIUNIAN.match(/ln-modal\.is-open \.ln-modal-card\s*\{[^}]*\}/)[0]),
    '进场动画用 backwards（both 会留下常驻单位矩阵 transform）');
  ok(/MODAL_EXIT_MS = \d+/.test(LIUNIAN_JS), 'JS 里显式声明退场时长，与 CSS 对齐');

  // 6) 卡片不加 filter/backdrop-filter：否则设置项文字被自身背景糊掉。
  const cardRule = LIUNIAN.match(/\[data-skin="liunian"\]\s+\.ln-modal-card\s*\{([^}]*)\}/);
  ok(cardRule && !/backdrop-filter/.test(cardRule[1]) && !/[^-\s]filter\s*:/.test(cardRule[1]),
    '卡片本身不做模糊/滤镜，只有遮罩模糊');
  ok(/background:\s*var\(--panel-solid\)/.test(cardRule[1]),
    '卡片底色取主题令牌（不写字面量）');

  // 7) 卸载可逆：监听与浮层状态都要清，别把浮层留在页面上。
  ok(/removeEventListener\('click', onDocumentClickCapture, true\)/.test(LIUNIAN_JS),
    '卸载时摘掉 capture 监听');
  ok(/clearTimeout\(sheet\.closeTimer\)/.test(LIUNIAN_JS)
    && /sheet\.viewEl = null/.test(LIUNIAN_JS),
    '卸载时清退场定时器并释放浮层引用');

  // 7b) hidden 归属：设置视图的 hidden 有两条写入路径（浮层自己 + app.js 的
  // setView，Esc 与切视图都会跑）。开着或退场期间必须以浮层为准，否则会出现
  // 「退场动画播的是一张空壳」或「浮层开着内容没了」。
  ok(/observer\.observe\(sheet\.viewEl,/.test(LIUNIAN_JS)
    && /attributeFilter: \['hidden'\]/.test(LIUNIAN_JS),
    '设置视图单独 observe（搬出中栏后仍能纠正 hidden）');
  const sync = LIUNIAN_JS.match(/function syncSettingsVisibility\(\)[\s\S]{0,420}?\n  \}/);
  ok(sync && /sheet\.open \|\| sheet\.closing/.test(sync[0])
    && /if \(sheet\.viewEl\.hidden\) sheet\.viewEl\.hidden = false;/.test(sync[0]),
    '浮层开着/退场中，hidden 以浮层为准并纠正回来');
  ok(sync && /if \(!sheet\.viewEl\.hidden\) sheet\.viewEl\.hidden = true;/.test(sync[0]),
    '浮层关闭后把设置视图收回隐藏（否则中栏留一片空白）');
  ok(/if \(inReflow\) return;/.test(LIUNIAN_JS),
    'reflow 有重入保护（观察器里纠正 hidden 不会自激）');

  // 8) 业务节点不动：浮层仍复用同一个 #view-settings，事件不丢。
  ok(!/id="view-settings"/.test(HTML.replace(/<div class="view" id="view-settings" hidden>/, '')),
    '设置视图仍是业务 HTML 里那一个（皮肤不复制业务节点）');
}

// ---------------------------------------------------------------------------
// 6c. 流年：设置分类导航（左栏归类 / 切换 / 可还原）
// ---------------------------------------------------------------------------

function checkLiunianSettingsNav() {
  section('流年：设置分类导航（左栏归类 / 一次只显示一类 / 切皮肤可还原）');

  // 1) 分类表覆盖设置页的每个分组，且是两级（一级分类 + 二级条目）。
  const table = LIUNIAN_JS.match(/var SET_SECTIONS = \[[\s\S]*?\n  \];/);
  ok(!!table, '声明了设置分类表 SET_SECTIONS');
  const titles = [...HTML.matchAll(/<h2 class="set-title">([^<]+)<\/h2>/g)].map((m) => m[1].trim());
  ok(titles.length >= 12, `设置页分组数量被脚本读到了（${titles.length} 组）`);
  const tableBody = table ? table[0] : '';
  const missing = titles.filter((t) => !tableBody.includes(`'${t}'`));
  ok(missing.length === 0,
    `分类表认领了全部设置分组（缺：${missing.join(' ') || '无'}）`);
  ok(/id: 'appearance'[\s\S]*id: 'playback'/.test(tableBody)
    && /id: 'library'/.test(tableBody) && /id: 'advanced'/.test(tableBody),
    '一级分类至少含外观 / 播放 / 数据与在线 / 高级四类');

  // 顺序也归分类表管，不归 DOM 次序。DOM 里「在线音源」排在「数据备份」
  // 后面只是业务 HTML 的偶然位置，照它排就把最常用的一项挤到了末尾。
  // 这条钉死渲染时遍历的是 section.items 而不是 groups。
  ok(/section\.items\.forEach\(function \(item\) \{\s*if \(byKey\[item\[0\]\]\)/.test(LIUNIAN_JS),
    '左栏条目顺序由 SET_SECTIONS 决定（分类表是排序权威，不照 DOM 次序）');

  // 2) 认领按 .set-title 文案，不靠序号：业务新增分组会落进「其它」而不是消失。
  ok(/querySelector\('\.set-title'\)/.test(LIUNIAN_JS),
    '分组靠 .set-title 文案认领（不往业务 HTML 里塞属性）');
  ok(/leftovers/.test(LIUNIAN_JS) && /textContent = '其它'/.test(LIUNIAN_JS)
    && /if \(leftovers\.length\)/.test(LIUNIAN_JS),
    '认领不到的分组落进「其它」分类（业务加设置时是「多一项」而不是「不见了」）');

  // 3) 切换：只切 hidden，不搬 .set-group。搬节点要维护锚点，而 hidden 是
  //    这些分组本来就有的语义（[hidden] 带 !important），别的皮肤照旧。
  ok(/entry\.group\.hidden = entry\.key !== key/.test(LIUNIAN_JS),
    '切换分类只切 .set-group 的 hidden，不搬业务节点');
  ok(!/relocate\(group/.test(LIUNIAN_JS) && !/relocate\(entry\.group/.test(LIUNIAN_JS),
    '分组节点没有进 moves（没有第二套锚点要维护）');

  // 4) 选中态走 class + aria-current，且左栏与右栏一致。
  ok(/button\.classList\.toggle\('active', on\)/.test(LIUNIAN_JS),
    '左栏选中项用 .active 标记');
  ok(/setAttribute\('aria-current', 'true'\)/.test(LIUNIAN_JS)
    && /removeAttribute\('aria-current'\)/.test(LIUNIAN_JS),
    '选中项带 aria-current（读屏能知道自己在哪一类）');

  // 5) 空态与坏数据：没有分组时不建左栏；记住的 key 失效时回落而不是空屏。
  ok(/if \(!groups\.length\) return;/.test(LIUNIAN_JS),
    '一个分组都没有时不建左栏（设置页退化成长滚动，而不是空面板）');
  ok(/if \(!claimed\.some\(function \(entry\) \{ return entry\.key === initial; \}\)\) \{/.test(LIUNIAN_JS),
    '记住的分类已不存在时回落到第一类（不空屏）');
  ok(/SECTION_KEY = 'vmusic\.ln-set-section'/.test(LIUNIAN_JS),
    '选中分类持久化到 localStorage');
  ok(/function readSectionKey\(\)[\s\S]{0,160}?try[\s\S]{0,120}?localStorage\.getItem[\s\S]{0,80}?catch/.test(LIUNIAN_JS)
    && /function writeSectionKey\(key\)[\s\S]{0,200}?try[\s\S]{0,120}?localStorage\.setItem[\s\S]{0,120}?catch/.test(LIUNIAN_JS),
    'localStorage 读写都包了 try（隐私模式 / 沙箱 iframe 里不抛）');

  // 6) 可还原：hidden 是皮肤加在业务节点上的，切皮肤必须摘干净。
  //    漏掉的话设置页在 classic / iOS 下只剩当前那一个分组——不报错、不崩，
  //    表现为「设置里其它项都没了」，极难定位。
  ok(/function releaseGroups/.test(LIUNIAN_JS)
    && /if \(entry\.group\) entry\.group\.hidden = false/.test(LIUNIAN_JS),
    '卸载时把全部分组的 hidden 摘掉（切回其它皮肤设置项完整）');
  ok(/releaseGroups\(\);\s*\n\s*restoreMoves\(\);/.test(LIUNIAN_JS),
    'releaseGroups 在 restoreMoves 之前（先摘 hidden 再搬回原位）');

  // 7) 焦点：分类切换后焦点不能掉到 body；重开浮层要能找回当前类的分组。
  ok(/nav\.addEventListener\('click'/.test(LIUNIAN_JS)
    && /e\.target\.closest\('\.ln-set-link'\)/.test(LIUNIAN_JS),
    '左栏点击在 nav 上委托（条目是按钮，冒泡即可，不必逐条挂）');
  ok(/var activeGroup = entryGroup\(sheet\.active\);\s*\n\s*if \(activeGroup\) activeGroup\.hidden = false;/.test(LIUNIAN_JS),
    '重开浮层时把当前类的分组带回可见（上次的焦点控件仍可聚焦）');
  ok(/var current = sheet\.nav && sheet\.nav\.querySelector\('\.ln-set-link\.active'\)/.test(LIUNIAN_JS),
    '打开浮层时焦点先落在左栏当前项（键盘用户能看到自己在哪一类）');

  // 8) CSS：两栏 + 左栏自己裁切。缺 min-height:0 的话左栏不裁切而是把
  //    卡片顶高，浮层就长出视口。
  ok(/\[data-skin="liunian"\] \.ln-set-layout\s*\{[^}]*display:\s*flex[^}]*\}/.test(LIUNIAN),
    '.ln-set-layout 是横向两栏 flex');
  ok(/\[data-skin="liunian"\] \.ln-set-nav\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/.test(LIUNIAN),
    '左栏 min-height:0 + 自己裁切（不会把浮层顶出视口）');
  ok(/\[data-skin="liunian"\] \.ln-set-pane\s*\{[^}]*min-width:\s*0/.test(LIUNIAN),
    '右栏 min-width:0（宽表单行不会把左栏挤没）');
  ok(/@media \(max-width: 720px\)[\s\S]{0,2000}?\.ln-set-layout\s*\{\s*flex-direction:\s*column/.test(LIUNIAN),
    '窄屏两栏改竖排（左栏收成横向胶囊条）');
  ok(/\[data-skin="liunian"\] \.ln-set-link\.active \.ln-set-link-text\s*\{[^}]*var\(--highlight\)/.test(LIUNIAN),
    '选中项字色走 --highlight（当前选中项的语义角色，不用 --accent）');
  ok(/\[data-skin="liunian"\] \.ln-set-link\.active::before[\s\S]{0,240}?var\(--brand\)/.test(LIUNIAN),
    '选中竖条走 --brand（与「正在生效」的薄荷青同源，不与字色抢）');
}

// ---------------------------------------------------------------------------
// 7. 接线
// ---------------------------------------------------------------------------

function checkWiring() {
  section('接线：HTML / 路由 / 启动');

  ok(/<link rel="stylesheet" href="skins\/skins\.css">/.test(HTML), 'skins.css 常驻引入');
  for (const id of ['sheen', 'workbench', 'liunian', 'ios', 'qingfeng']) {
    ok(new RegExp('href="skins/skin\\.' + id + '\\.css"[^>]*data-skin-css="' + id + '"').test(HTML),
      `skin.${id}.css 引了进来并带上 data-skin-css`);
    ok(new RegExp('data-skin-css="' + id + '"[^>]*disabled').test(HTML),
      `skin.${id}.css 默认 disabled（默认不生效）`);
  }
  ok(/src="skins\/skins\.js"/.test(HTML), 'skins.js 引了进来');
  ok(HTML.indexOf('skins/skins.js') < HTML.indexOf('src="app.js"'),
    'skins.js 排在 app.js 之前（app.js 启动时要能拿到它）');
  ok(/id="skins-list"/.test(HTML), '设置页有皮肤列表容器');

  for (const p of ['skins/skins.js', 'skins/skins.css', 'skins/skin.sheen.css', 'skins/skin.workbench.css', 'skins/skin.liunian.css', 'skins/skin.liunian.js', 'skins/skin.ios.css', 'skins/skin.qingfeng.css', 'skins/skin.qingfeng.js']) {
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
  ok(/include_str!\("[^"]*\/skins\/skin\.ios\.css"\)/.test(MAIN_RS),
    'skin.ios.css 编进二进制');

  section('接线：流年重编排 JS 的加载顺序与机制');
  const lnJsAt = HTML.indexOf('src="skins/skin.liunian.js"');
  ok(lnJsAt > 0, 'index.html 引入了 skin.liunian.js');
  ok(lnJsAt > HTML.indexOf('src="skins/skins.js"'),
    'skin.liunian.js 排在 skins.js 之后（要监听 skin:changed）');
  ok(lnJsAt < HTML.indexOf('src="app.js"'),
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
// 6d. 清风：胶囊主菜单 / 队列拼接海报墙 / 设置浮层
// ---------------------------------------------------------------------------

function checkQingfengChrome() {
  section('清风：胶囊主菜单与首页骨架');

  // 1) rail 隐藏但节点保留（程序化点击复用 setView 链路）。
  ok(/\[data-skin="qingfeng"\]\s+\.rail\s*\{\s*display:\s*none/.test(QINGFENG),
    'CSS 把左侧 rail 钉为 display:none');
  ok(/function clickRailItem/.test(QINGFENG_JS) && /rail-item\[data-view=/.test(QINGFENG_JS),
    '皮肤经程序化点击隐藏 rail 内 rail-item 切换视图');

  // 2) 胶囊主菜单：用户诉求的五个目的地，顺序不能乱。
  const nav = QINGFENG_JS.match(/var NAV_ITEMS = \[[\s\S]*?\n  \];/);
  ok(nav, '声明了主菜单表 NAV_ITEMS');
  const navBody = nav ? nav[0] : '';
  ok(/'playlists'[\s\S]{0,40}'online'[\s\S]{0,40}'daily'[\s\S]{0,40}'favorites'[\s\S]{0,40}'library'/.test(navBody),
    '主菜单依次为 歌单 / 电台 / 专辑 / 收藏 / 本地');
  ok(!/settings/.test(navBody), '设置不在主菜单里（它在左上角，folia 同款位置关系）');

  // 3) 队列拼接是主菜单末尾那个图标入口，hover 才展开文字。
  ok(/qf-nav-icon/.test(QINGFENG_JS) && /'队列拼接'/.test(QINGFENG_JS),
    '队列拼接入口挂在主菜单里');
  ok(/\[data-skin="qingfeng"\] \.qf-nav-icon span\s*\{[^}]*max-width:\s*0/.test(QINGFENG),
    '队列拼接入口文字默认收起（hover 才展开）');
  ok(/\[data-skin="qingfeng"\] \.qf-nav-icon:hover span[\s\S]{0,120}?max-width:\s*92px/.test(QINGFENG),
    'hover 时文字展开');

  // 4) 胶囊是 fixed 且居中，z-index 要压过内容。
  const navRule = QINGFENG.match(/\[data-skin="qingfeng"\] \.qf-nav\s*\{([^}]*)\}/);
  ok(navRule && /position:\s*fixed/.test(navRule[1]), '主菜单胶囊固定定位脱离文档流');
  const navZ = navRule && Number((navRule[1].match(/z-index:\s*(\d+)/) || [])[1]);
  ok(Number.isFinite(navZ) && navZ >= 50, `胶囊层级高于内容（z-index=${navZ}）`);
  ok(/translateX\(-50%\)/.test(navRule ? navRule[1] : ''), '胶囊水平居中');

  // 5) 左上角设置、右下角头像+箭头。
  ok(/function buildBrandGroup/.test(QINGFENG_JS) && /qf-brand-group/.test(QINGFENG_JS),
    '品牌旁编出一组（左上角设置按钮的落位）');
  ok(/function openStage/.test(QINGFENG_JS) && /Stage3D/.test(QINGFENG_JS),
    '右下角箭头跳舞台播放页');
  ok(/id="online-account-btn"/.test(QINGFENG_JS.replace(/'/g, '"')) === false
    && /byId\('online-account-btn'\)/.test(QINGFENG_JS),
    '右下角搬的是业务那颗登录按钮（不是复制一个不会更新的假头像）');

  section('清风：播放胶囊钉住位置');
  // 胶囊是 fixed 浮件：自动隐藏若能改 transform/opacity，鼠标一悬停就会
  // 先把它甩下去再滑回（上下跳动）。与流年同源，必须钉。
  ok(/\[data-skin="qingfeng"\] \.bar:not\(\.qf-capsule\)\s*\{[^}]*transform:\s*translateX\(-50%\) !important/.test(QINGFENG),
    '播放条钉住 transform，自动隐藏不能把它甩出视口');
  ok(/opacity:\s*1\s*!important/.test(QINGFENG), '播放条钉住 opacity，自动隐藏不能让它闪烁');
}

function checkQingfengWall() {
  section('清风：队列拼接海报墙');

  // 剥掉注释的源码。**必须剥**：下面几条断言的说明文字里就写着
  // paintEmptyState / emit('activate') / step(delta, tile) 这些字符串，
  // 不剥的话断言匹配到自己写的注释，等于永远绿。
  const qfCodeWall = stripJsComments(QINGFENG_JS);
  // app.js 侧的按视图取源。同样要剥注释 —— 下面几条断言的说明文字里
  // 就写着 viewSourceDef / sourceKey 这些标识符。
  const qfApp = stripJsComments(APP);

  // 1) 墙的密排参数：与 CSS 的 --qf-cell / --qf-cell-gap 必须一致，
  //    两处写岔的表现是「卡片之间露出一条背景色的缝」。
  const cell = QINGFENG_JS.match(/var CELL = (\d+)/);
  const gap = QINGFENG_JS.match(/var GAP = (\d+)/);
  ok(cell && gap, '密排参数在 JS 里显式声明');
  eq(cell && Number(cell[1]), Number((/--qf-cell:\s*(\d+)px/.exec(QINGFENG) || [])[1]),
    'CELL 与 CSS 的 --qf-cell 一致');
  eq(gap && Number(gap[1]), Number((/--qf-cell-gap:\s*(\d+)px/.exec(QINGFENG) || [])[1]),
    'GAP 与 CSS 的 --qf-cell-gap 一致');

  // 2) 墙必须整块脱离文档流，且不吃指针事件之外的东西。
  const wallRule = QINGFENG.match(/\[data-skin="qingfeng"\] \.qf-lattice\s*\{([^}]*)\}/);
  ok(wallRule && /position:\s*fixed/.test(wallRule[1]), '海报墙固定定位铺满视口');
  ok(wallRule && /overflow:\s*hidden/.test(wallRule[1]), '海报墙自己裁切');
  ok(/touch-action:\s*none/.test(wallRule ? wallRule[1] : ''), '海报墙禁掉触摸滚动（自己处理平移）');

  // 3) 相机：写在 world 上而不是逐卡定位，否则平移要重排上千节点。
  ok(/translate3d\(/.test(QINGFENG_JS) && /will-change:\s*transform/.test(QINGFENG),
    '相机走 world 的 translate3d + will-change（平移不重排海报）');

  // 4) 渲染上限：不设上限的话一次平移能建出上千节点，滚动会掉帧。
  ok(/MAX_INSTANCES = \d+/.test(QINGFENG_JS) && /entries\.length < MAX_INSTANCES/.test(QINGFENG_JS),
    '渲染实例数有上限（否则平移会建出上千节点）');
  ok(/OVERSCAN = \d+/.test(QINGFENG_JS), '裁剪区有外扩余量（平移时新格子已就位）');

  // 5) 展开档与焦点态：正在播放那张向内构建边框，键盘焦点用 box-shadow。
  ok(/\[data-skin="qingfeng"\] \.qf-poster\.is-current::before/.test(QINGFENG),
    '正在播放的海报有强调边框');
  ok(/\[data-skin="qingfeng"\] \.qf-poster\.is-focused/.test(QINGFENG),
    '键盘焦点态有对应样式');
  ok(/\[data-skin="qingfeng"\] \.qf-poster\.is-expanded/.test(QINGFENG),
    '展开大卡有对应样式');
  // 徽章刻意不用 backdrop-filter：每张卡一个模糊层会把整墙提升为 N 个
  // 合成层，是海报墙最大的 GPU 开销。这条钉住，免得被"优化视觉"加回去。
  const badgeRule = QINGFENG.match(/\[data-skin="qingfeng"\] \.qf-poster-badge\s*\{([^}]*)\}/);
  ok(badgeRule && !/backdrop-filter/.test(badgeRule[1]),
    '序号徽章不用 backdrop-filter（否则每张卡一个合成层）');

  // 6) 墙为空要有空态，不能是一片空白墙。
  //    注意：墙已经**不是播放队列专属**了 —— 每个 tab 的墙展示那个 tab 的
  //    内容，空态文案也随之变化（歌单页说「还没有歌单」、队列页说
  //    「队列是空的」），所以不能再钉死某一句文案，要钉「文案由来源决定」。
  ok(/qf-lattice-empty/.test(QINGFENG_JS) && /function paintEmptyState/.test(QINGFENG_JS),
    '墙为空时有空态提示，且文案随来源变化');
  ok(/function paintEmptyState[\s\S]{0,900}?wall\.emptyHint/.test(qfCodeWall),
    '空态用的是该来源自己的提示文案');

  // 7) 键盘：Esc 返回 / 方向键移焦点 / Enter 展开。
  const key = QINGFENG_JS.match(/function onWallKeydown[\s\S]{0,900}?\n  \}/);
  ok(key && /'Escape'/.test(key[0]), 'Esc 退出队列拼接');
  ok(key && /ArrowRight/.test(key[0]) && /ArrowLeft/.test(key[0]), '方向键移动焦点');
  ok(key && /'Enter'/.test(key[0]) && /' '/.test(key[0]), 'Enter / 空格 展开');

  // 8b) 墙是**每个 tab 都有的**，展示那个 tab 的内容（不是只有播放队列）。
  //     这组钉的是「按视图取源」这条设计：需求是这个功能的核心，
  //     一旦退回成只服务播放队列，断言要能红。
  ok(/function requestSource/.test(qfCodeWall) && /emit\('source-request'\)/.test(qfCodeWall),
    '墙按当前视图取源（source-request），不是只读播放队列');
  // 三个取源入口都必须走 requestSource。只钉 emit 存在是不够的 ——
  // 把 openWall 里的调用换成 requestQueue()，emit 那个函数定义照样在，
  // 断言照样绿，而墙实际已经退回只服务播放队列了。
  for (const [fn, label] of [
    ['openWall', '开墙'],
    ['leaveDrill', '从歌单退回'],
    ['reflowInner', '切 tab 换源'],
  ]) {
    const body = new RegExp(`function ${fn}\\([\\s\\S]{0,3000}?\\n  \\}`).exec(qfCodeWall);
    ok(body && /requestSource\(\)/.test(body[0]), `${label}走 requestSource（按当前 tab 取源）`);
  }
  // 六个视图都要有源，少一个就有一个 tab 的墙是空的。
  for (const k of ['library', 'online', 'playlists', 'daily', 'favorites', 'queue']) {
    ok(new RegExp(`key: '${k}'`).test(qfApp), `viewSourceDef 覆盖 ${k}`);
  }
  ok(/label: '播放队列'/.test(qfApp) && /label: '歌单'/.test(qfApp),
    '每个源都带来源名（墙上要标明自己在看哪一列）');
  // 切 tab 时换源而不是关墙 —— 关掉的话这个功能就退化成
  // 「只有队列 tab 有队列拼接」，正好是需求要避免的。
  // **必须钉「换源那一行紧跟在 if (wall.open) 之后」**：
  // 只测「文件里存在 applySource(requestSource())」会被 enterDrill 之外的
  // 任意调用点满足，换成关墙照样全绿。
  ok(/if \(wall\.open\) \{\s*\n\s*var wasDrill[\s\S]{0,700}?applySource\(requestSource\(\)\)/.test(qfCodeWall),
    '墙开着切 tab 时换源，不关墙');
  ok(!/if \(wall\.open\) \{ closeWall\(\); \}/.test(qfCodeWall),
    '切 tab 没有把墙直接关掉（旧行为，已移除）');
  // 换源前先退到第一层：第二层是「某个歌单里的歌」，跨 tab 留着就串味了。
  ok(/if \(wall\.open\) \{[\s\S]{0,300}?wall\.drill = null;[\s\S]{0,300}?collapse\(true\)/.test(qfCodeWall),
    '换源前先退回第一层（歌单里的歌不属于下一个 tab）');
  // 歌单那列是两层：一张海报 = 一个歌单，点开看里面的歌而不是直接播。
  ok(/function enterDrill/.test(qfCodeWall) && /function leaveDrill/.test(qfCodeWall),
    '歌单墙有两层（enterDrill / leaveDrill）');
  ok(/isPlaylist/.test(qfCodeWall) && /enterDrill\(tile\)/.test(qfCodeWall),
    '歌单项点开走 enterDrill 而不是直接播');
  // 钉死「卡片点击处理器里那一行」：只测文件里存在 enterDrill(tile) 的话，
  // 把卡片点击改成 focusPoster 展开（= 直接播）也照样绿。
  ok(/tile && tile\.isPlaylist\) \{\s*\n[\s\S]{0,300}?enterDrill\(tile\)/.test(qfCodeWall),
    '歌单卡片点击确实进第二层');
  // **pointerdown 里不许 setPointerCapture**。
  //
  // 捕获指针后 pointerup/click 会被重定向到捕获元素（field），
  // 海报上的 click 处理器永远收不到 —— 用户在墙上点卡片就是没反应，
  // 而且**不报任何错**。浏览器实测里只有 element.click()（不走捕获路径）
  // 能展开，真实鼠标点击全部失效；两种结果不一致本身就是证据。
  // 捕获必须推迟到 pointermove 越过拖拽阈值、确认是拖拽之后。
  const dragBlock = /field\.addEventListener\('pointerdown',[\s\S]{0,800}?\n {4}\}\)/.exec(qfCodeWall);
  ok(dragBlock && !/setPointerCapture/.test(dragBlock[0]),
    'pointerdown 不捕获指针（捕获会把 click 重定向到 field，海报点不动）');
  ok(/if \(!drag\.moved\) \{\s*\n\s*drag\.moved = true;[\s\S]{0,200}?setPointerCapture\(e\.pointerId\)/.test(qfCodeWall),
    '指针捕获推迟到确认拖拽之后（纯点击全程不捕获）');
  // 展开卡的主按钮对歌单是「打开歌单」而不是播放控件。
  ok(/if \(tile && tile\.isPlaylist\) \{[\s\S]{0,600}?open\.className = 'qf-chrome-play is-labelled'/.test(qfCodeWall),
    '歌单的展开卡是「打开歌单」而不是播放控件');
  // 非当前项不给进度条：第二层（刚点开的歌单）拖了也不知道在拖谁。
  ok(/progress\.hidden = !\(tile && tile\.current\)/.test(qfCodeWall),
    '没在放的那张不给进度条');

  // 8a) 密排模板与让位表：folia 求解器产物的两份数据必须结构完好 ——
  //     模板精确铺满 12×8；每张让位表精确铺满、被展开的槽位恰为 6×6。
  //     数据坏一块，墙上就是背景色漏缝，或者展开卡直接压住邻居（那是旧观感，
  //     folia 的展开是「整块重新咬合」，靠的就是这份数据可靠）。
  const latticeArr = (name) => {
    const i = qfCodeWall.indexOf('var ' + name + ' = ');
    if (i < 0) return null;
    const start = qfCodeWall.indexOf('[', i);
    let depth = 0;
    for (let k = start; k < qfCodeWall.length; k += 1) {
      if (qfCodeWall[k] === '[') depth += 1;
      else if (qfCodeWall[k] === ']') {
        depth -= 1;
        if (!depth) return eval('(' + qfCodeWall.slice(start, k + 1) + ')');
      }
    }
    return null;
  };
  const coverErr = (tables, expectGear) => {
    if (!Array.isArray(tables)) return '表缺失';
    for (let t = 0; t < tables.length; t += 1) {
      const rects = tables[t];
      if (!Array.isArray(rects) || rects.length !== 12) return `表 ${t} 槽位数不对`;
      const g = Array.from({ length: 8 }, () => new Array(12).fill(false));
      for (const r of rects) {
        for (let y = r[1]; y < r[1] + r[3]; y += 1) {
          for (let x = r[0]; x < r[0] + r[2]; x += 1) {
            if (y < 0 || y > 7 || x < 0 || x > 11) return `表 ${t} 越界 ${JSON.stringify(r)}`;
            if (g[y][x]) return `表 ${t} 重叠 @${x},${y}`;
            g[y][x] = true;
          }
        }
      }
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 12; x += 1) if (!g[y][x]) return `表 ${t} 漏缝 @${x},${y}`;
      }
      if (expectGear) {
        // 传进来的是展平后的 48 张让位表：t 对应 模板 = t/12、槽位 = t%12。
        const slot = t % 12;
        if (rects[slot][2] !== 6 || rects[slot][3] !== 6) return `表 ${t} 展开档不是 6×6`;
      }
    }
    return null;
  };
  const tplErr = coverErr(latticeArr('LATTICE_TEMPLATES'), false);
  ok(tplErr === null, '密排模板精确铺满 12×8（每块 12 槽）', tplErr || '');
  const reflows = latticeArr('LATTICE_REFLOWS');
  const reflowErr = coverErr(
    Array.isArray(reflows) ? reflows.reduce((all, perTemplate) => all.concat(perTemplate), []) : null,
    true,
  );
  ok(reflowErr === null, '让位表精确铺满 12×8 且展开档恰为 6×6', reflowErr || '');
  // 展开走让位表而不是「中心放大压邻居」；让位过渡挂 .is-reflow，
  // 收起对称地滑回去。
  ok(/function expandGear/.test(qfCodeWall) && /expandGear\(index\)/.test(qfCodeWall),
    '展开按让位表重排整块（不是大卡压邻居）');
  // 实例身份模型：节点与格位键绑定（folia 的 instanceId 同款），卡片内容
  // 是格位的纯函数。按数组位置复用节点的话，平移一次窗口格位键整体错位，
  // 展开卡会在下一次重绘时被拍到别人的格位上（实测 6×6 展开档变 2×2）。
  ok(/nodeByKey\.get\(entries\[k\]\.key\)/.test(qfCodeWall)
    && /nodeByKey\.set\(entry\.key, el\)/.test(qfCodeWall),
    '海报按格位键控绑定（键控差量，不按数组位置复用）');
  ok(/function tileForKey/.test(qfCodeWall) && /cellSlot % wall\.tiles\.length/.test(qfCodeWall)
    && /function posterTile/.test(qfCodeWall),
    '卡片内容是格位的纯函数（cellSlot 对项数取模），跨平移不漂移');
  // 相机飞行途中挂载集必须跟着走：落地后窗口外是空的，且格位键会整体错位。
  const panBody = /function panTo\([\s\S]{0,1200}?\n  \}/.exec(qfCodeWall);
  ok(panBody && /renderWall\(\)/.test(panBody[0]),
    '相机飞行逐帧重绘（挂载集跟相机走）');
  ok(/function kickReflowTransition/.test(qfCodeWall) && /is-reflow/.test(QINGFENG),
    '让位滑移由 .is-reflow 短暂挂类驱动（平移期间不能带过渡）');
  // 入场波/退场波/轻上浮三段动画的接线齐全（CSS 负责动，JS 负责延时）。
  ok(/ENTRANCE_WINDOW = \d+/.test(qfCodeWall) && /is-landing/.test(qfCodeWall)
    && /--qf-land-delay/.test(qfCodeWall),
    '开墙有入场波（延时按距离写在 --qf-land-delay）');
  ok(/is-closing/.test(qfCodeWall) && /--qf-exit-delay/.test(qfCodeWall)
    && /@keyframes qf-leave/.test(QINGFENG),
    '关墙有反向退场波（延时取入场补数写在 --qf-exit-delay）');
  ok(/@keyframes qf-land/.test(QINGFENG) && /@keyframes qf-rise/.test(QINGFENG),
    '着落/上浮关键帧在 CSS 里');
  ok(/--qf-popx/.test(qfCodeWall) && /transform: scale\(var\(--qf-popx/.test(QINGFENG),
    'hover/focus 的 pop 系数按卡片尺寸算（四边各长出一个 GAP）');
  // 换源必须重建海报：卡片内容与点击闭包是建卡时的快照，复用旧节点
  // 会挂着上一个 tab 的歌（点击还会播错歌）。
  ok(/function applySource\([\s\S]{0,900}?clearPosters\(\)/.test(qfCodeWall),
    '换源时清空海报按新源重建（旧卡的内容/闭包是过期快照）');

  // 开墙/换源时保证聚焦的那张在视口内（否则第一张在视口外 = 一片空白）。
  // 墙是循环铺满的，同一项有很多实例：聚焦走「就近挑实例」（folia 的
  // locateNearestInstance），实例不在挂载集就把相机瞬时对过去再渲染。
  ok(/function focusAndReveal\([\s\S]{0,200}?focusQueueIndex\(index, false\)/.test(qfCodeWall),
    '开墙/换源的定位走 focusQueueIndex（纯聚焦，不展开）');
  ok(/function focusQueueIndex\([\s\S]{0,300}?locateNearestInstance\(qi, viewportCenterWorld\(\)\)/.test(qfCodeWall)
    && /if \(!node\) \{[\s\S]{0,600}?applyCamera\(\);[\s\S]{0,120}?renderWall\(\)/.test(qfCodeWall),
    '聚焦就近实例；不在挂载集就瞬时对位再渲染（保证可见）');
  // 不能把「保证可见」塞进 focusPoster：方向键每按一次就 panTo 一次，
  // 键盘导航会没法用。所以两条路径必须分开。
  //
  // 这里判的是**分工**而不是「函数里没有 panTo」—— focusPoster 在 expand
  // 分支里调 panTo 是正确行为（展开卡必须带进视口），早先写成「整个函数
  // 里不许出现 panTo」结果把那次合法调用也判红了。所以只钉两件事：
  //   1. panTo 只出现在 expand 分支里，且全函数只有这一处；
  //   2. focusAndReveal 走的是不展开的纯聚焦，可见性另行判断。
  const fp = /function focusPoster\([\s\S]{0,600}?\n  \}/.exec(qfCodeWall);
  const fpPans = fp ? (fp[0].match(/panTo\(/g) || []).length : -1;
  ok(fp && fpPans === 1 && /if \(expand\) \{[\s\S]{0,400}?panTo\(el\);/.test(fp[0]),
    'focusPoster 的相机平移只在 expand 分支（展开卡要带进视口）');
  // （focusAndReveal 的分工断言合并进上面两条 focusQueueIndex 断言。）
  // 展开新卡前必须先收起上一张。开墙时若源里有 current 项它已被展开
  //（开墙的 focusQueueIndex），用户再点另一张若不收，
  // 墙上会同时铺着两张 6×6 展开档，且「展开的是哪一张」不再确定 ——
  // 浏览器实测就是querySelector 取到第一张（旧卡）而断言全红。
  // 键控差量下下标随重渲染漂移，收起守卫按**格位键**比较。
  ok(/if \(wall\.expandedKey && wall\.expandedKey !== el\.dataset\.qfKey\) collapse\(true\);\s*\n\s*wall\.expanded = index;/.test(qfCodeWall),
    '展开新卡前先收起上一张（按格位键，否则同时铺着两张 6×6 展开档）');
  ok(/function collapse\(silent\) \{\s*\n\s*if \(!wall\.expandedKey\) return;\s*\n\s*var el = wall\.nodeByKey\.get\(wall\.expandedKey\);/.test(qfCodeWall),
    '收起按格位键找节点（下标跨重渲染会漂移）');
  // Esc 分层退：第二层先退回列表，再按才关墙。
  ok(/if \(e\.key === 'Escape'\) \{[\s\S]{0,120}?if \(wall\.drill\) leaveDrill\(\);[\s\S]{0,80}?else closeWall\(\)/.test(qfCodeWall),
    'Esc 在第二层先退回歌单列表，再按才退出墙');
  // 展开卡的控件：歌单那列不该跟曲共用「上一首/播放/下一首」——
  // 歌单不是在放的曲，给那组控件用户会以为点播放能直接开播。
  ok(/qf-chrome-play is-labelled/.test(qfCodeWall) && /打开歌单/.test(qfCodeWall),
    '歌单的展开卡是「打开歌单」而不是播放控件');
  // 墙上要标明来源，且来源名跟着 tab 变。
  ok(/qf-lattice-tag/.test(qfCodeWall) && /qf-lattice-tag/.test(QINGFENG),
    '墙上有来源标签（CSS 与 JS 两侧都在）');
  ok(/WALL_TAB_LABELS/.test(qfCodeWall) && /qf-nav-icon-text/.test(qfCodeWall),
    '入口按钮文案跟着 tab 变（不再固定叫「队列拼接」）');
  // 每项都要自报 sourceKey：上一首/下一首要回**同一列**里取，
  // 不能靠皮肤缓存的列表（那会和业务状态不一致）。
  ok(/sourceKey/.test(qfApp) && /item\.sourceKey \? viewSourceDef\(item\.sourceKey\)/.test(qfApp),
    '每项带 sourceKey，播放分派回同一列取');

  // 8) 播放路径只有一条：皮肤发意图，app.js 落 play。
  //    这里刻意**不钉 play-index / play-step**：墙上的序号是**本视图**的下标，
  //    而 play-index 按的是播放队列下标 —— 混用会播错歌。所以墙上点歌走
  //    activate（带整项），由 app.js 按 id 的种类分派。
  ok(/emit\('activate'/.test(QINGFENG_JS), '点播放发 activate 意图（带整项，不靠下标猜）');
  // 「上一首/下一首」必须发 step-track（= 播放队列里前后各一首），
  // **不能**再走 activate+delta。
  //
  // 旧实现发的是 activate + delta，由 app.js 拿**墙上那一项**去
  // queueSnapshot 里 findIndex —— 而展开卡是 focusPoster 聚焦的那张，
  // 用户很可能停在第 3 张（还没点播）就按了下一首，曲库/歌单/收藏这些
  // tab 的墙上序号与队列下标毫无关系，findIndex 必返 -1，落到
  // 「从头开始」的兜底，于是**永远停在队列第一首**。
  // 用户实测：歌点得开、进度在走、唯独上/下一曲不动。
  ok(/function step\(delta\)\s*\{\s*emit\('step-track', \{ delta: delta \}\)/.test(qfCodeWall),
    '上一首/下一首发 step-track（按播放队列前后走，不按墙上那一列）');
  ok(!/emit\('activate', \{ item: tile, delta/.test(qfCodeWall),
    '上一首/下一首不再走 activate+delta（那是「永远停在第一首」的写法）');
  ok(/d\.action === 'step-track'/.test(APP) && /playQueueStep\(d\.delta\)/.test(APP),
    'app.js 侧 step-track 落到 playQueueStep（按正在放的那首算邻居）');
  // 左下角浮条的播放/暂停：走 toggle-play，复用业务既有的 togglePlay。
  ok(/qf-queue-peek-play/.test(QINGFENG) && /qf-queue-peek-play/.test(qfCodeWall),
    '左下角浮条有播放/暂停按钮（CSS 与 JS 两侧都在）');
  ok(/emit\('toggle-play'\)/.test(qfCodeWall) && /d\.action === 'toggle-play'/.test(APP)
    && /togglePlay\(\)/.test(APP),
    '浮条播/停走 toggle-play（复用业务路径，不自己拼 post）');
  ok(/!transport\.post|transport\.post\(/.test(QINGFENG_JS) === false
    || !/transport\.post\('\/v1\/player/.test(QINGFENG_JS),
    '皮肤不自己发 /v1/player 请求（播放路径只有 app.js 一条）');

  section('清风：与 app.js 的桥接接线');
  ok(/function initQingfengBridge/.test(APP) && /initQingfengBridge\(\)/.test(APP),
    'app.js 定义并启动清风桥接');
  ok(/document\.addEventListener\('qf:panel'/.test(APP), 'app.js 监听 qf:panel');
  ok(/function queueSnapshot/.test(APP) && /d\.queue = queueSnapshot\(\)/.test(APP),
    'queue-request 回一份队列快照给海报墙');
  ok(/function playQueueIndex/.test(APP) && /d\.action === 'play-index'/.test(APP),
    '桥接分流 play-index');
  // 桥接是同步回填：皮肤 dispatch 之后立刻读 detail.queue，
  // 若 app.js 改成异步回填，海报墙会永远拿到空队列且不报错。
  // 匹配的是「同一个 d 上赋值」这个结构，不绑定注释文字。
  ok(/d\.queue = queueSnapshot\(\)/.test(APP)
    && !/d\.queue\s*=\s*await/.test(APP) && !/d\.queue\s*=\s*\w+\.then/.test(APP),
    '队列快照是同步回填（emit 返回即可读，不是异步 Promise）');
  // 在线虚拟 id 不在本地库里，直接 load 会 404 —— 必须有与队列页同款的提示。
  ok(/id\.startsWith\('online:'\)/.test(APP) && /在线曲目已失效/.test(APP),
    '播放在线虚拟 id 时给出与队列页一致的提示，而不是抛 404');
  // seek 复用 seekTo：自己拼 post 会丢掉 epoch 竞态保护与失败提示。
  ok(/seekTo\(Math\.round\(total \* d\.ratio\)\)/.test(APP),
    '墙内进度条复用 seekTo（保留竞态保护与错误提示）');
  ok(!/function seekSnapshotRatio/.test(APP), '没有与 seekTo 重复的第二条 seek 实现');
}

function checkQingfengSettings() {
  section('清风：设置浮层（遮罩 / 两栏分类 / 可逆）');

  // 剥掉注释的源码，后面多条断言都要用。
  // **必须剥**：这些新断言的说明文字里就写着 paintEmptyState / emit('activate')
  // 这些字符串，不剥的话断言会匹配到自己写的注释，等于永远绿。
  const qfCode = stripJsComments(QINGFENG_JS);
  const qfCodeWall = qfCode;

  // 1) 浮层结构：遮罩 + 卡片，卡片带 dialog 语义。
  ok(/make\('div', 'qf-modal-scrim', root\)/.test(QINGFENG_JS)
    && /make\('section', 'qf-modal-card', root\)/.test(QINGFENG_JS),
    '浮层由遮罩 + 卡片两层构成');
  ok(/setAttribute\('role', 'dialog'\)/.test(QINGFENG_JS)
    && /setAttribute\('aria-modal', 'true'\)/.test(QINGFENG_JS),
    '卡片带 dialog / aria-modal 语义');

  // 2) 两栏：左栏分类导航 + 右栏设置视图本体。
  ok(/make\('div', 'qf-set-layout', body\)/.test(QINGFENG_JS)
    && /make\('nav', 'qf-set-nav', layout\)/.test(QINGFENG_JS)
    && /make\('div', 'qf-set-pane', layout\)/.test(QINGFENG_JS),
    '浮层内容分两栏：左栏 .qf-set-nav + 右栏 .qf-set-pane');
  ok(/relocate\(view, sheet\.pane\)/.test(QINGFENG_JS),
    '设置视图经 relocate 搬进浮层（原位留锚点，可还原）');

  // 3) 「帮助」页签已按需求去掉，这里反向钉死：那条路曾经存在过一个
  //    点不动的死页签（buildHelp 把内容 append 到 pane，而 pane 是
  //    layout 的子节点，showHelp(true) 又把 layout.hidden 设成 true ——
  //    内容被藏在自己的父容器下，点下去是一片空白）。
  //    源码里还有相关注释，所以这里剥掉注释再匹配，否则会匹配到注释文本。
  const qfJsNoComment = stripJsComments(QINGFENG_JS);
  ok(!/tabHelp|showHelp|buildHelp|qf-modal-tab/.test(qfJsNoComment),
    '帮助页签与其切换逻辑已彻底移除（无死代码残留）');
  // 说明：下面两条扫的是 CSS 全文，而 QINGFENG 里还留着解释「页签已移除」的
  // 注释，注释里就写着这些个类名 —— 不剥注释的话断言会匹配到自己的注释，永远绿。
  // 断言必须跑在剥掉注释的源码上。
  const qfCssNoComment = stripCssComments(QINGFENG);
  ok(!/\.qf-modal-tab/.test(qfCssNoComment) && !/function qf-underline/.test(qfCssNoComment),
    '帮助页签的 CSS 样式也已移除');

  // 4) 顶栏那三个控制按钮对清风隐藏了，但功能不能跟着丢：
  //    沉浸声场与胶囊播放器在设置里必须有可发现的入口。
  //    只隐藏「设置」那个是安全的（左上角已有 .qf-settings-btn）。
  ok(/#capsule-entry[\s\S]*#stage3d-entry[\s\S]*#settings-entry/.test(qfCssNoComment),
    '顶栏三个控制按钮都已隐藏');
  // 新分组在 index.html 里带了一整块说明注释，正则 #set-capsule-btn 会先撞上
  // 注释里的文字。改成匹配属性赋值，真正的目标节点与 id/class 两种写法都覆盖。
  ok(/(?:id|for)="set-capsule-btn"/.test(HTML) && /(?:id|for)="set-stage3d-btn"/.test(HTML),
    '设置页补了「窗口与舞台」分组承接被隐藏的两个入口');
  ok(/enterCapsule[\s\S]*set-capsule-btn/.test(APP) || /set-capsule-btn[\s\S]*enterCapsule/.test(APP),
    '胶囊播放器的新入口复用了同一套最小化逻辑');
  ok(/stage3d-entry', 'set-stage3d-btn/.test(STAGE3D_JS),
    '沉浸声场的新入口进了 openers 列表');
  // 分类表必须认领新分组，否则它会掉进末尾的「其它」——
  // 那是「多一项」而不是「不见了」，用户要多点一次才能找到。
  // 两张表（清风 / 流年）都得认领：业务加分组时两张是一起漏的，
  // 只补一张会让另一套皮肤里它掉进「其它」。同样要剥注释。
  ok(/id: 'playback'[\s\S]*'窗口与舞台'/.test(qfJsNoComment),
    '清风把「窗口与舞台」归进「播放」分类');
  const liunianJsNoComment = stripJsComments(LIUNIAN_JS);
  ok(/id: 'playback'[\s\S]*'窗口与舞台'/.test(liunianJsNoComment),
    '流年也认领了「窗口与舞台」（两张表一起补，别只改一张）');

  // 5) 层级必须压过既有浮层（在线登录弹窗是 100）。
  const modalRule = QINGFENG.match(/\[data-skin="qingfeng"\] \.qf-modal\s*\{([^}]*)\}/);
  const z = modalRule && Number((modalRule[1].match(/z-index:\s*(\d+)/) || [])[1]);
  ok(Number.isFinite(z) && z >= 200, `浮层层级高于既有浮层（z-index=${z}，须 ≥ 在线弹窗的 100）`);

  // 5) 底层隔离只许挡交互，不许加 filter —— filter 会让 .app 变成包含块，
  //    把子树里的 fixed 后代改成相对定位（流年踩过的坑）。
  const isolate = QINGFENG.match(/\[data-skin="qingfeng"\] body\.qf-modal-open[^{]*\{([^}]*)\}/g) || [];
  ok(isolate.length > 0, 'body 标记确有对应样式（不是死代码）');
  ok(isolate.every((r) => !/filter/.test(r)),
    '底层隔离不加 filter（否则 .app 变包含块，固定定位的播放胶囊会错位）');
  ok(isolate.join('').includes('pointer-events'), '底层隔离用 pointer-events 挡交互');

  // 6) 卡片自身不做模糊：否则设置项文字被自己的背景糊掉。
  const cardRule = QINGFENG.match(/\[data-skin="qingfeng"\] \.qf-modal-card\s*\{([^}]*)\}/);
  ok(cardRule && !/backdrop-filter/.test(cardRule[1]),
    '卡片本身不做模糊（只有遮罩模糊）');
  ok(/background:\s*var\(--panel-solid\)/.test(cardRule[1]),
    '卡片底色取主题令牌（不写字面量）');

  // 7) 进退场：进场用 animation（hidden→可见时自动播），退场用 transition。
  ok(/qf-modal-card-in/.test(QINGFENG), '进场用 keyframes 动画');
  // 退场必须同时满足两件事：animation 被关掉（否则 keyframes 继续盖住
  // transition）、且有 transition 播反向。不绑定两条声明的先后顺序 ——
  // 流年那份 CSS 里 transition 在前，这里在后，都对。
  const closing = QINGFENG.match(/\[data-skin="qingfeng"\] \.qf-modal\.is-closing \.qf-modal-card\s*\{([^}]*)\}/);
  ok(closing && /animation:\s*none/.test(closing[1]),
    '退场关掉 keyframes（否则它继续盖住 transition）');
  ok(closing && /transition:[^;}]*opacity[^;}]*transform|transition:[^;}]*transform[^;}]*opacity/.test(closing[1]),
    '退场切到 transition 播反向动画');
  ok(/MODAL_EXIT_MS = \d+/.test(QINGFENG_JS), 'JS 里显式声明退场时长，与 CSS 对齐');
  ok(/setTimeout\(function \(\) \{[\s\S]{0,420}?sheet\.root\.hidden = true/.test(QINGFENG_JS),
    '退场动画结束后才置 hidden（退场动画真的能播完）');

  // 7b) body 隔离标记必须成对摘除。漏摘的后果不是「样式脏」而是
  //     「关掉设置后整个界面点不动」—— CSS 里 qf-modal-open 是给底层
  //     加 pointer-events:none 的，只要它还挂在 body 上就一直在隔离。
  //     这里要求关闭路径里出现 remove，且不能写成 remove(class1, class2)
  //     一把带走（那会把海报墙的标记也摘掉，两个浮层先后开着时误伤）。
  ok(/document\.body\.classList\.remove\('qf-modal-open'\)/.test(stripJsComments(QINGFENG_JS)),
    '关闭浮层时摘掉 body 隔离标记（否则关掉设置后底层永久点不动）');
  // 关闭**单个**浮层只许摘自己的标记，不许顺带摘另一个的（两个浮层可能
  // 先后开着 —— 海报墙上开着设置时，关设置不该把海报墙的隔离也解了）。
  // 注意只查 closeSettingsSheet / closeWall 这两条关闭路径 —— unmount 里
  // `remove('qf-modal-open', 'qf-lattice-open')` 是对的：卸载时两个都得关。
  const qfCode2 = stripJsComments(QINGFENG_JS);
  const closeFn = (name) => {
    const m = qfCode2.match(new RegExp(`function ${name}\\(\\)[\\s\\S]*?\\n  \\}`));
    return m ? m[0] : '';
  };
  const closeSheet = closeFn('closeSettingsSheet');
  const closeWallFn = closeFn('closeWall');
  ok(closeSheet && closeWallFn, '找得到两条关闭路径');
  ok(/remove\('qf-modal-open'\)/.test(closeSheet), '关闭设置摘自己的标记');
  ok(/remove\('qf-lattice-open'\)/.test(closeWallFn), '关闭海报墙摘自己的标记');
  ok(!/qf-lattice-open/.test(closeSheet),
    '关闭设置不连带摘海报墙的标记（海报墙上开着设置时不该被解掉隔离）');
  ok(/qf-modal-open/.test(closeFn('unmount')),
    'unmount 里两个标记一起清（卸载时两个浮层都得关）');

  // 7c) 播放胶囊必须显式 position: fixed。业务 .bar 是 .app 栅格里的 flex
  //     子项（默认 static），皮肤只写 left/bottom 而不写 position，偏移量
  //     会被整份忽略，只剩 translateX(-50%) 生效 —— 胶囊被左移半个身位。
  //     这条 Node 测不出来（纯布局），但源码可以钉死。
  // 7f) 播放栏折叠按钮：点下去必须**当场**收起，且收起后唤得回来。
  //
  //     原实现的时序（2026-10-06 实测踩出）：点击时 `pinned = false`，但
  //     此刻鼠标正悬在播放条上，`bar.addEventListener('pointerenter', beginPeek)`
  //     早已把 peek 置成 true，而 visible = peek || (pinned && !idle)
  //     仍是 true → **点击的当下看不到任何反应**；要等鼠标移开、
  //     leaveTimer 800ms 后把 peek 归零才真的收起。表现就是「按钮点了没用」。
  //     清风实测（程序化 .click() 有效、真实鼠标点击无效）就是这个原因。
  //
  //     收起后唤不回来是第二个坑：胶囊 position:fixed; bottom:22px，
  //     而基础 .bar-hover-zone 只有 bottom:0; height:12px，两者不重叠。
  const toggleFn = stripJsComments(
    (APP.match(/toggleBtn\.addEventListener\('click',[\s\S]*?\n  \}\);/) || [''])[0]);
  ok(/peek = false/.test(toggleFn),
    '折叠时清掉 peek（否则鼠标悬停中点了没反应：visible = peek || …）');
  ok(/else\s+peek = false/.test(toggleFn) || /if \(pinned\)[^{]*\{[^}]*peek = false[^}]*\}\s*else\s+peek = false/.test(toggleFn),
    '收起的分支也清 peek（不只在展开时清）');
  ok(/clearTimeout\(hideTimer\)/.test(toggleFn),
    '收起后不重新 armIdle（15s 定时器会把 idle 置真，与用户意图打架）');
  const zoneRule = QINGFENG.match(/\[data-skin="qingfeng"\] \.bar-hover-zone\s*\{([^}]*)\}/);
  ok(zoneRule && /height:\s*\d+px/.test(zoneRule[1])
    && parseInt((zoneRule[1].match(/height:\s*(\d+)px/) || [0, 0])[1], 10) >= 40,
    '清风把唤出热区加高到能盖住浮起的胶囊（bottom:22px，12px 的热区够不到）',
    zoneRule ? (zoneRule[1].match(/height:[^;]+/) || [''])[0].trim() : 'no rule');

  const barRule = QINGFENG.match(/\[data-skin="qingfeng"\] \.bar\s*\{([^}]*)\}/);
  ok(barRule && /position:\s*fixed/.test(barRule[1]),
    '播放胶囊显式 position: fixed（否则 left/bottom 被忽略、胶囊左移半身）');
  ok(barRule && /left:\s*50%/.test(barRule[1]) && /translateX\(-50%\)/.test(barRule[1]),
    '播放胶囊用 left:50% + translateX(-50%) 居中');
  // 胶囊宽度是算出来的，不是随手取的：里面要装下曲名 + 控制 + 进度条 +
  // 模式 + 音量五块，而且**曲名那一格必须真的拿到宽度**。
  //
  // 原来的断言写死成 `min(6[6-9]\dpx ...)`，把 680px 那个具体值当成了
  // 判据 —— 结果「加宽到 860px」被判红。可那正是修法：实测右侧那组
  // （睡眠定时器 + 模式 + 音量）325px、控制组 188px、进度条最少 120px，
  // 三块加间隙已 675px，680px 的胶囊里曲名一格不剩，bar-track 被压到 0 宽
  // （文本在 DOM 里，界面读不到）。
  //
  // 判据改成真正的意图：**宽度下限 ≥ 860px**（曲名有 150px 可分配），
  // 上界交给视口那道 min(…, 100vw - 2*pad) 去管。
  ok(barRule && /width:\s*min\((8[6-9]\d|9\d\d|[1-9]\d{3,})px/.test(barRule[1]),
    '胶囊宽度够放五块（≥860px，否则曲名那格被压到 0 宽）',
    barRule ? (barRule[1].match(/width:[^;]+/) || [''])[0].trim() : 'no rule');

  // 7d) 「正在播放」侧卡（.stage）：可拖动小卡片。
  //     拖不动 / 位置记不住 / 能被拖出屏幕是三个独立的失效，各钉一条。
  const stageRule = QINGFENG.match(/\[data-skin="qingfeng"\] \.stage\s*\{([^}]*)\}/);
  ok(stageRule && /width:\s*2[0-9]{2}px/.test(stageRule[1]),
    '侧卡宽度收窄（300px → 232px，不挤主内容区）',
    stageRule ? (stageRule[1].match(/width:[^;]+/) || [''])[0].trim() : 'no rule');
  // 纵向必须改成「top 单锚 + max-height」：left/top/bottom 双向锚定会把高度
  // 拉满整屏 —— 那是「占位过大」的根因，光改 width 治不了。
  ok(stageRule && /bottom:\s*auto/.test(stageRule[1]) && /max-height:/.test(stageRule[1]),
    '侧卡高度按内容收（bottom:auto + max-height，不再拉满整屏）');
  ok(stageRule && /transition:\s*none/.test(stageRule[1]),
    '侧卡禁用 transition（拖动时补间会让卡片粘滞追不上鼠标）');
  // 拖动反馈：没有视觉反馈的拖拽用户不知道东西抓起来了没。
  ok(/qf-stage-dragging|qf-dragging/.test(QINGFENG) && /scale\(1\.\d\d\)/.test(QINGFENG),
    '拖动中有视觉反馈（抬升 + 轻微放大）');
  // 拖拽实现三件套：把手、持久化、范围约束。缺一条就有一类失效。
  ok(/onStageDragDown/.test(QINGFENG_JS) && /pointerdown/.test(QINGFENG_JS),
    '侧卡有 pointerdown 拖动入口');
  // 捕获必须在**越过阈值之后**才发生，不能在 pointerdown 里。
  // 同一个文件的海报拖拽（buildWall）踩过：pointerdown 就捕获 →
  // pointerup/click 被重定向到捕获元素 → 头上的按钮（模式切换/全屏/队列）
  // 全部收不到 click，表现为「点标题栏没反应」。
  // ⚠️ 下面两条要**先剥掉注释**再看：onStageDragDown 的注释里就写着
  // 「绝不能 setPointerCapture」，不剥的话断言会匹配到自己写的警告语，
  // 永远红 —— 这是本项目踩过的坑（断言跑在带注释的源码上 = 假红）。
  const stageDownFn = stripJsComments(
    (QINGFENG_JS.match(/function onStageDragDown\([\s\S]*?\n  \}/) || [''])[0]);
  const stageMoveFn = stripJsComments(
    (QINGFENG_JS.match(/function onStageDragMove\([\s\S]*?\n  \}/) || [''])[0]);
  ok(stageDownFn.indexOf('setPointerCapture') < 0,
    '侧卡不在 pointerdown 里就捕获指针（会吃掉标题栏按钮的 click）');
  ok(stageMoveFn.indexOf('setPointerCapture') >= 0 && /!stageDrag\.moved/.test(stageMoveFn),
    '侧卡越过拖动阈值后才捕获指针');
  // 把头上的真按钮让出来：它们照常点，不该被当成拖动。
  ok(/e\.target\.closest\('button, a, input/.test(stageDownFn),
    '侧卡把手上的真按钮不触发拖动');
  // ⚠️ 守卫里不能排除 [role="button"]：把手 .stage-head 自己就是 role=button
  // （键盘可达），写进去等于把手把自己挡死 —— 浏览器实测抓过，症状是
  // 「整张卡哪儿都拖不动、控制台干净」，契约里所有断言都还绿。
  ok(stageDownFn.indexOf('[role="button"]') < 0,
    '拖动守卫不排除 [role="button"]（把手自己就是 role=button，否则整卡拖不动）');
  // 迷你卡只有一百多像素高，拖动入口必须挂在整张卡上（el），不能只挂标题带。
  ok(/el\.addEventListener\('pointerdown', onStageDragDown\)/.test(QINGFENG_JS)
    && !/head\.addEventListener\('pointerdown'/.test(QINGFENG_JS),
    '拖动入口挂在整张迷你卡上（不只标题带，否则难抓）');
  // .stage 是业务节点（切皮肤不重建），卸载必须把整卡上的 pointerdown 摘掉，
  // 否则切走再切回来会叠加第二份拖动逻辑。
  ok(/stageDrag\.el\.removeEventListener\('pointerdown', onStageDragDown\)/.test(QINGFENG_JS),
    '卸载时摘掉整卡上的 pointerdown（业务节点不重建，会叠加）');

  // 7d-2) 迷你播放器小卡：封面 + 歌曲信息 + 当前句歌词，高度按内容收。
  //     改前 232×636（歌词 flex:1 把纵向撑满），盖住曲库右列 —— 光收宽度治不了。
  //     2026-10-06 起卡不再自带进度与播放控制：默认停靠在播放胶囊右缘，
  //     按钮重复一份纯属噪音；多出来的是当前句歌词（放不下转跑马灯）。
  ok(stageRule && /grid-template-areas:/.test(stageRule[1]) && /"lyric/.test(stageRule[1]),
    '迷你卡用 grid 命名区域重排，且给当前句歌词留了 lyric 区');
  ok(stageRule && /display:\s*grid/.test(stageRule[1]),
    '迷你卡是 grid 布局（横排封面+信息，而不是竖排大卡）');
  const qfMiniHide = QINGFENG.match(
    /\[data-skin="qingfeng"\] \.stage-modes,[\s\S]*?\{([^}]*)\}/);
  ok(qfMiniHide && /display:\s*none/.test(qfMiniHide[1])
    && /\.stage-lyrics/.test(qfMiniHide[0]) && /\.spectrum/.test(qfMiniHide[0])
    && /\.stage-ripple/.test(qfMiniHide[0]) && /\.stage-progress/.test(qfMiniHide[0]),
    '非核心块（模式/全屏/队列/频谱/歌词/进度/装饰层）在清风整排摘掉');
  ok(/function buildStageMini\(/.test(QINGFENG_JS)
    && /qf-mini-lyric/.test(QINGFENG_JS) && /qf-mini-close/.test(QINGFENG_JS),
    '迷你卡注入当前句歌词行与关闭（不再自带播放控制行）');
  ok(QINGFENG_JS.indexOf('qf-mini-ctrl') < 0 && QINGFENG.indexOf('qf-mini-ctrl') < 0
    && QINGFENG_JS.indexOf('qf-mini-btn-primary') < 0,
    '迷你卡不再自带播放控制行（胶囊就在旁边，按钮不重复一份）');
  ok(/function tickMiniLyric\(/.test(QINGFENG_JS)
    && /Stage\.lyrics\(\)/.test(QINGFENG_JS) && /Stage\.position\(\)/.test(QINGFENG_JS),
    '当前句歌词读 Stage.lyrics()/Stage.position()（与全屏歌词同一份数据，不读隐藏面板的 DOM）');
  ok(/qf-lyric-marquee/.test(QINGFENG) && /is-scrolling/.test(QINGFENG)
    && /--qf-lyric-dur/.test(QINGFENG_JS),
    '歌词放不下转跑马灯（JS 量宽写时长，CSS 两份拷贝无缝循环）');
  // 播放路径只有一条：迷你卡没有按钮，也不允许自己发播放 HTTP。
  const miniFns = (QINGFENG_JS.match(/function buildStageMini\([\s\S]*?\n  \}/) || [''])[0]
    + (QINGFENG_JS.match(/function lyricLineText\([\s\S]*?\n  \}/) || [''])[0]
    + (QINGFENG_JS.match(/function tickMiniLyric\([\s\S]*?\n  \}/) || [''])[0];
  ok(miniFns.indexOf('fetch(') < 0 && miniFns.indexOf("post('/v1/") < 0,
    '迷你卡不自己发 HTTP（播放落点只有胶囊/队列一条路）');
  ok(/var MINI_CLOSED_KEY\s*=/.test(QINGFENG_JS)
    && /localStorage\.setItem\(\s*MINI_CLOSED_KEY/.test(QINGFENG_JS)
    && /localStorage\.getItem\(\s*MINI_CLOSED_KEY/.test(QINGFENG_JS),
    '迷你卡收起状态有专用 key 且会写会读');
  ok(/classList\.toggle\('qf-mini-closed'/.test(QINGFENG_JS),
    '收起用类不用 hidden（.stage 被钉成 grid，特异性压过 UA 的 [hidden]）');
  ok(/function onMiniTrack\(/.test(QINGFENG_JS)
    && /addEventListener\('playback:track', mini\.trackHandler\)/.test(QINGFENG_JS)
    && /removeEventListener\('playback:track', mini\.trackHandler\)/.test(QINGFENG_JS),
    '换曲把收起的迷你卡放回来，且卸载时摘掉监听');
  // 切走皮肤时 .stage 回栅格布局：清风写的内联 left/top 必须清掉。
  ok(/stageDrag\.el\.style\.left = ''/.test(QINGFENG_JS)
    && /stageDrag\.el\.style\.top = ''/.test(QINGFENG_JS),
    '卸载时清掉内联定位（带到别的皮肤上就是一份脏样式）');
  // 位置持久化：写与读都要有，且**用同一个 key**。
  // 判据拆成「key 声明 / 写 / 读」三段而不是「setItem(key…) 出现在同一行」——
  // 写成 `localStorage.setItem(\n  STAGE_POS_KEY, …)`（换行）或
  // `var k = STAGE_POS_KEY; setItem(k, …)` 都过，跨行匹配会漏。
  ok(/var STAGE_POS_KEY\s*=/.test(QINGFENG_JS), '侧卡位置有专用 storage key');
  ok(/localStorage\.setItem\(\s*STAGE_POS_KEY/.test(QINGFENG_JS), '侧卡位置会写进 localStorage');
  ok(/localStorage\.getItem\(\s*STAGE_POS_KEY/.test(QINGFENG_JS), '侧卡位置刷新后会读回来');
  // 范围约束：clampStage 必须在，且真的被 applyStagePos 用上
  //（定义了但没人调 = 有约束函数但没约束效果）。
  ok(/function clampStage\(/.test(QINGFENG_JS) && /function stageBounds\(/.test(QINGFENG_JS),
    '侧卡有范围约束的边界计算');
  ok(/var p = clampStage\(el, x, y\)/.test(QINGFENG_JS),
    '范围约束被真正应用到位置上（不是定义了没用的空函数）');
  // 2026-10-06 起卡片默认停靠播放胶囊右缘：没记忆位置就停靠（挂载时与
  // resize 时），有记忆才恢复原位。挂载路径要等皮肤 CSS 生效再量宽高
  // （restoreOrDock），否则量到栅格旧布局，停出来的位置是歪的。
  // 底部胶囊/头像用矩形避让而不是封死下缘。
  ok(/function dockStage\(/.test(QINGFENG_JS) && /function restoreOrDock\(/.test(QINGFENG_JS)
    && /restoreOrDock\(saved, 240\)/.test(QINGFENG_JS)
    && /if \(!readStagePos\(\)\) \{ dockStage\(\); return; \}/.test(QINGFENG_JS),
    '迷你卡没记忆位置时默认停靠（等皮肤布局生效再量），resize 重新停靠，有记忆才恢复原位');
  ok(/function pushOutFloaters\(/.test(QINGFENG_JS) && /pushOutFloaters\(p, w, h\)/.test(QINGFENG_JS),
    '拖动时对播放胶囊/头像胶囊做矩形避让（推到其上缘之外，不封死下缘）');
  // 「动了才记位置」：点一下把手（没拖）不该覆盖用户之前摆好的位置。
  ok(/stageDrag\.moved/.test(QINGFENG_JS) && /if \(stageDrag\.moved/.test(QINGFENG_JS),
    '只有真的拖过才持久化位置（点一下把手不覆盖）');
  // 卸载必须摘干净：切到别的皮肤后 document 上不能还挂着 pointermove。
  ok(/removeEventListener\('pointermove', stageDragHandlers\.move\)/.test(QINGFENG_JS)
    && /removeEventListener\('pointerup', stageDragHandlers\.up\)/.test(QINGFENG_JS),
    '卸载时摘掉 document 上的 pointer 监听（切皮肤后不留拖动残影）');
  // 侧卡变小后，「曲名/歌手」那一格必须真的拿到宽度。
  const trackRule = QINGFENG.match(/\[data-skin="qingfeng"\] \.bar-track\s*\{([^}]*)\}/);
  ok(trackRule && /flex:\s*1 1 \d+px/.test(trackRule[1]),
    '播放条曲名格有确定 flex-basis（否则被进度条压到 0 宽）',
    trackRule ? (trackRule[1].match(/flex:[^;]+/) || [''])[0].trim() : 'no rule');

  // 7e) 顶部胶囊导航的选中态：滑块与文字必须都能看见。
  //     原来写 `background: var(--surface-hi)` —— 那个令牌的值是
  //     `inset 0 1px 0 rgba(255,255,255,.055)`，是给 box-shadow 用的内高光，
  //     当颜色解析必然失败、滑块变透明，配上的 --accent-ink（#0A0A0A 近黑）
  //     就压在深色胶囊上，文字彻底读不出来。
  //
  //     滑块**直接画在按钮身上**，不再用 ::before 叠一层：按钮里只有
  //     `textContent` 写的裸文本节点，`.is-active > *` 匹配不到东西，文字就没有
  //     z-index，而 z-index:0 的定位伪元素绘制顺序排在行内内容之上 ——
  //     字已经是 #0A0A0A 了，仍被浅色滑块盖成一个空白格（2026-10-06 实测）。
  ok(!/qf-nav-item\.is-active::before/.test(QINGFENG),
    '导航选中态不用伪元素叠层（裸文本节点没有 z-index，会被盖成空白格）');
  ok(!/qf-nav-item\.is-active\s*>\s*\*/.test(QINGFENG),
    '导航选中态不靠 `> *` 提层（按钮里是裸文本节点，匹配不到任何东西）');
  const navActive = QINGFENG.match(/\[data-skin="qingfeng"\] \.qf-nav-item\.is-active\s*\{([^}]*)\}/);
  ok(navActive && /background:\s*color-mix/.test(navActive[1]),
    '导航选中态滑块用真颜色（不能拿 box-shadow 内高光当 background）',
    navActive ? (navActive[1].match(/background:[^;]+/) || [''])[0].trim() : 'no rule');
  ok(navActive && !/--surface-hi/.test(navActive[1]),
    '导航选中态不再引用 --surface-hi（那是 box-shadow 值，当颜色必失效）');
  ok(navActive && /color:\s*var\(--accent-ink\)/.test(navActive[1]),
    '导航选中态文字是深色（浅底 + 深字是配对的，换一个要换另一个）',
    navActive ? (navActive[1].match(/color:[^;]+/) || [''])[0].trim() : 'no rule');
  // 滑块必须**以文字色为主**混，而不是以胶囊底色为主混。
  // --skin-surface 实测解析成 rgb(18,20,28,.78)（半透明深色），拿它往白里混
  // 14% 出来是 rgb(55,57,64) 的深灰 —— 配 --accent-ink（#0A0A0A 近黑）
  // 几乎同色，选中项还是读不出来（实测截图里那格“本地”隐进背景）。
  // 判据：color-mix 的**第一个**参数得是 --text（占比 ≥60%）。
  const navBg = navActive ? (navActive[1].match(/background:\s*color-mix\([^;]+/) || [''])[0] : '';
  const navMix = navBg.match(/color-mix\(in srgb,\s*var\((--[\w-]+)\)\s+(\d+)%/);
  ok(!!navMix && navMix[1] === '--text' && parseInt(navMix[2], 10) >= 60,
    '选中态滑块以文字色为主混（深底色混不出承得住近黑字的亮度）',
    navBg.trim() || 'no rule');

  const progRule = QINGFENG.match(/\[data-skin="qingfeng"\] \.bar-progress\s*\{([^}]*)\}/);
  ok(progRule && /min-width:\s*(1[2-9]\d|\d{3})px/.test(progRule[1]),
    '进度条有 min-width 下限（否则窄胶囊里先被压没）',
    progRule ? (progRule[1].match(/min-width:[^;]+/) || [''])[0].trim() : 'no rule');
  // 胶囊自己带 !important 的 transform —— 自动隐藏会先把它甩下去再滑回
  ok(/\[data-skin="qingfeng"\] \.bar:not\(\.qf-capsule\)[\s\S]{0,120}?transform:[^;}]*!important/.test(QINGFENG),
    '胶囊钉住 transform（自动隐藏时不会先下坠再滑回）');

  // 8) 分类表：认领全部设置分组，认领不到的落进「其它」。
  const table = QINGFENG_JS.match(/var SET_SECTIONS = \[[\s\S]*?\n  \];/);
  ok(!!table, '声明了设置分类表 SET_SECTIONS');
  const titles = [...HTML.matchAll(/<h2 class="set-title">([^<]+)<\/h2>/g)].map((m) => m[1].trim());
  const tableBody = table ? table[0] : '';
  const missing = titles.filter((t) => !tableBody.includes(`'${t}'`));
  ok(missing.length === 0,
    `分类表认领了全部设置分组（缺：${missing.join(' ') || '无'}）`);
  ok(/id: 'appearance'[\s\S]*id: 'playback'/.test(tableBody)
    && /id: 'library'/.test(tableBody) && /id: 'advanced'/.test(tableBody),
    '一级分类至少含外观 / 播放 / 数据与在线 / 高级四类');
  ok(/leftovers/.test(QINGFENG_JS) && /id: 'misc'/.test(QINGFENG_JS),
    '认领不到的分组落进「其它」（业务加设置时是「多一项」而不是「不见了」）');
  ok(/querySelector\('\.set-title'\)/.test(QINGFENG_JS),
    '分组靠 .set-title 文案认领（不往业务 HTML 里塞属性）');
  // claimGroups 是模块级函数，不是 sheet 的方法。写成 sheet.claimGroups()
  // 会 TypeError 并让整个 mount() 中途静默中断 —— 页面上表现为「主菜单在、
  // 海报墙和浮层都不存在」，不报任何错。
  // qfCode 见函数开头（剥注释的源码，供全函数复用）。
  // 认领必须走「文案 → 语义 key」这一层间接。byKey 的键是 .set-title 文案
  // （"界面皮肤"、"外观"…），SET_SECTIONS.items[0] 是语义 key（'skin'、'look'…），
  // 两套命名空间。直接 byKey[item[0]] 等于拿语义 key 查文案表，永远查不到 ——
  // 后果是全部分组掉进 leftovers 变成 'x界面皮肤' 这样的 key，
  // 打开浮层时 entryGroup(初始 key) 返回 null，右栏整栏空白。
  // 症状极隐蔽：左栏条目能点能切（点击路径两边都错、但一致），
  // 只有「打开时的初始分类」会错，不报错、不崩。
  ok(/item\[1\] === title/.test(qfCode) && /byKey\[found\.key\]/.test(qfCode),
    '认领走「文案 → 语义 key」的间接（byKey 用语义 key 存，不是文案）');
  // 打开设置有两条路径（rail 的程序化点击 / 左上角那颗按钮），只有一条补了
  // reflow()，而摘 hidden 的 syncSettingsVisibility() 只挂在 reflowInner() 里 ——
  // 于是走按钮进来时右栏一片空白（视图搬进来了却还带着 hidden）。
  // 所以「摘 hidden」这件事本身必须由 openSettingsSheet 负责，不能外包给调用方。
  // 这条症状与上面「认领失败」一模一样（右栏空、左栏能点），但根因完全不同。
  ok(/function openSettingsSheet[\s\S]{0,2000}?if \(sheet\.viewEl\) sheet\.viewEl\.hidden = false;/.test(qfCode),
    'openSettingsSheet 自己摘设置视图的 hidden（不依赖调用方调 reflow）');
  ok(/function claimGroups\(\)/.test(qfCode), 'claimGroups 是模块级函数');
  ok(!/sheet\.claimGroups\s*\(/.test(qfCode),
    '不写成 sheet.claimGroups()（那会 TypeError 中断整个挂载，且页面无报错）');
  // claimGroups 读 sheet.pane（relocate 的落点），必须在 sheet 字段赋值齐之后调
  const buildSheet = qfCode.match(/function buildSettingsSheet\(\)[\s\S]*?\n  \}\n/);
  ok(buildSheet && buildSheet[0].indexOf('sheet.pane = pane')
    < buildSheet[0].indexOf('claimGroups();'),
  'claimGroups() 在 sheet.pane 赋值之后调用（否则搬进空落点）');
  // 9) 分组的显隐是皮肤加的，卸载时必须全部摘掉，否则切回其它皮肤时
  //    业务节点身上还留着 hidden，表现为「设置里其它项都没了」，极难定位。
  //    注意这两个方向是**两件事**、两个函数：
  //      showAll —— 卸载还原（hidden = false）
  //      hideAll —— 切分类时先全藏（hidden = true），紧跟着一行把目标组露出来。
  //    之前只有一个 releaseGroups 且做的是「全显」，于是切分类时右栏把
  //    13 个分组从上到下全堆在一起：左栏选中项对、右栏标题对，只有内容错。
  ok(/function showAll/.test(QINGFENG_JS)
    && /if \(entry\.group\) entry\.group\.hidden = false/.test(QINGFENG_JS),
    '卸载时把全部分组的 hidden 摘掉（切回其它皮肤设置项完整）');
  ok(/function hideAll/.test(QINGFENG_JS)
    && /if \(entry\.group\) entry\.group\.hidden = true/.test(QINGFENG_JS),
    '切分类时先把全部分组收起来（否则右栏会堆出全部 13 个分组）');
  ok(/hideAll\(\);\s*\n\s*var g = entryGroup/.test(QINGFENG_JS),
    'hideAll 之后紧跟着露出目标组');
  ok(!/relocate\(group/.test(QINGFENG_JS) && !/relocate\(entry\.group/.test(QINGFENG_JS),
    '分组节点没有进 moves（没有第二套锚点要维护）');
  ok(/showAll\(\);\s*\n\s*restoreMoves\(\);/.test(QINGFENG_JS),
    'showAll 在 restoreMoves 之前（先摘 hidden 再搬回原位）');

  // 10) hidden 归属：设置视图的 hidden 有两条写入路径（浮层自己 + app.js 的
  //     setView）。开着或退场期间必须以浮层为准。
  const sync = QINGFENG_JS.match(/function syncSettingsVisibility\(\)[\s\S]{0,520}?\n  \}/);
  ok(sync && /sheet\.open \|\| sheet\.closing/.test(sync[0])
    && /if \(sheet\.viewEl\.hidden\) sheet\.viewEl\.hidden = false;/.test(sync[0]),
    '浮层开着/退场中，hidden 以浮层为准并纠正回来');
  ok(sync && /else if \(!sheet\.viewEl\.hidden\)\s*\{\s*\n?\s*sheet\.viewEl\.hidden = true;/.test(sync[0]),
    '浮层关闭后把设置视图收回隐藏（否则中栏留一片空白）');
  ok(/observer\.observe\(sheet\.viewEl,/.test(QINGFENG_JS)
    && /attributeFilter: \['hidden'\]/.test(QINGFENG_JS),
    '设置视图单独 observe（搬出中栏后仍能纠正 hidden）');
  ok(/if \(inReflow\) return;/.test(QINGFENG_JS),
    'reflow 有重入保护（观察器里纠正 hidden 不会自激）');

  // 11) 持久化：记住的分类失效时回落第一类，不空屏。
  ok(/SECTION_KEY = 'vmusic\.qf-set-section'/.test(QINGFENG_JS), '选中分类持久化到 localStorage');
  ok(/if \(!sheet\.entries\.some\(function \(e\) \{ return e\.key === initial; \}\)\) initial = firstKey\(\);/.test(QINGFENG_JS),
    '记住的分类已不存在时回落到第一类（不空屏）');

  // 12) CSS：两栏 + 左栏自己裁切（缺 min-height:0 会把浮层顶出视口）。
  ok(/\[data-skin="qingfeng"\] \.qf-set-layout\s*\{[^}]*display:\s*flex[^}]*\}/.test(QINGFENG),
    '.qf-set-layout 是横向两栏 flex');
  ok(/\[data-skin="qingfeng"\] \.qf-set-nav\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/.test(QINGFENG),
    '左栏 min-height:0 + 自己裁切（不会把浮层顶出视口）');
  ok(/\[data-skin="qingfeng"\] \.qf-set-pane\s*\{[^}]*min-width:\s*0/.test(QINGFENG),
    '右栏 min-width:0（宽表单行不会把左栏挤没）');
  ok(/@media \(max-width: 720px\)[\s\S]{0,2400}?\.qf-set-layout|@media \(max-width: 720px\)[\s\S]{0,2400}?\.qf-set-nav\s*\{[^}]*flex-direction:\s*row/.test(QINGFENG),
    '窄屏两栏改竖排（左栏收成横向条）');
  ok(/\[data-skin="qingfeng"\] \.qf-set-subitem\.is-active::before[\s\S]{0,200}?var\(--brand\)/.test(QINGFENG),
    '二级项选中竖条走 --brand（「正在生效」的语义色）');
  ok(/\[data-skin="qingfeng"\] \.qf-set-subitem\.is-active\s*\{[^}]*var\(--text\)/.test(QINGFENG),
    '二级项选中字色走 --text（当前选中项的语义色，不用 --accent）');

  // 13) 开关与分段控件：folia 的组件形态。
  ok(/\[data-skin="qingfeng"\] \.switch\[aria-checked="true"\]/.test(QINGFENG),
    '设置开关有开启态样式');
  ok(/\[data-skin="qingfeng"\] \.seg button\[aria-pressed="true"\]/.test(QINGFENG),
    '分段控件有选中态样式');
}

function checkQingfengWiring() {
  section('清风：接线与加载顺序');

  ok(/href="skins\/skin\.qingfeng\.css"[^>]*data-skin-css="qingfeng"/.test(HTML),
    'skin.qingfeng.css 引了进来并带上 data-skin-css');
  ok(/data-skin-css="qingfeng"[^>]*disabled/.test(HTML), 'skin.qingfeng.css 默认 disabled');
  // 皮肤 CSS 必须排在 style.css 之后：[data-skin=x] 与 :root 同为 (0,1,0)，
  // 靠源码顺序决胜，排错了 --r-* 之类的覆盖不生效（不报错，只是没效果）。
  ok(HTML.indexOf('skins/skin.qingfeng.css') > HTML.indexOf('href="style.css"'),
    'skin.qingfeng.css 排在 style.css 之后（覆盖要靠源码顺序决胜）');

  const qfJsAt = HTML.indexOf('src="skins/skin.qingfeng.js"');
  ok(qfJsAt > 0, 'index.html 引入了 skin.qingfeng.js');
  ok(qfJsAt > HTML.indexOf('src="skins/skins.js"'),
    'skin.qingfeng.js 排在 skins.js 之后（要监听 skin:changed）');
  ok(qfJsAt < HTML.indexOf('src="app.js"'),
    'skin.qingfeng.js 排在 app.js 之前');

  ok(/include_str!\("[^"]*\/skins\/skin\.qingfeng\.css"\)/.test(MAIN_RS),
    'skin.qingfeng.css 编进二进制');
  ok(/include_str!\("[^"]*\/skins\/skin\.qingfeng\.js"\)/.test(MAIN_RS),
    'skin.qingfeng.js 编进二进制');
  ok(MAIN_RS.includes('/skins/skin.qingfeng.css'), 'main.rs 注册了 /skins/skin.qingfeng.css 路由');
  ok(MAIN_RS.includes('/skins/skin.qingfeng.js'), 'main.rs 注册了 /skins/skin.qingfeng.js 路由');

  // 重编排层的挂载机制：不主动 hook 业务代码，挂在 skin:changed 上。
  ok(/addEventListener\('skin:changed', onSkinChanged\)/.test(QINGFENG_JS),
    '重编排层挂在 skin:changed 事件上（不主动 hook 业务代码）');
  ok(/qf-anchor/.test(QINGFENG_JS), '搬运节点带锚点（切走皮肤可还原）');
  ok(/MutationObserver/.test(QINGFENG_JS), '视图联动用 MutationObserver');
  ok(/function unmount/.test(QINGFENG_JS) && /removeBuilt\(\)/.test(QINGFENG_JS),
    '卸载时拆掉自建节点');
  ok(/removeEventListener\('skin:changed'/.test(QINGFENG_JS) === false,
    'skin:changed 监听常驻（切回清风时要能重新挂载）');

  // 作用域：海报墙与设置浮层只属于清风，别漏进业务 HTML。
  ok(!/qf-nav|qf-lattice|qf-modal|qf-poster/.test(HTML),
    '业务 HTML 不内置清风的结构（皮肤自持，切走即消失）');
  ok(!/qf-nav|qf-lattice|qf-modal|qf-poster/.test(SHEEN) && !/qf-nav|qf-lattice|qf-modal|qf-poster/.test(WORKBENCH),
    '其它皮肤不引入清风的结构');
}

// ---------------------------------------------------------------------------

/// 换肤后中栏必须有可见视图 + 播放条显隐不许卡死。
///
/// 两条都是「不报错、不崩、不少元素，只是界面不对」的类型，
/// 契约脚本钉得住的是**因果链上的关键环节**，真实几何仍靠浏览器实测。
///
/// 1) 换肤时 state.view 停在 'settings'：用户最常见的路径就是「在设置页里
///    点皮肤」（皮肤列表就在设置页里）。各皮肤对设置视图的处理完全不同 ——
///    经典系把它当中栏普通视图，流年/清风把它**搬进自己的浮层**并置
///    hidden。于是换过去之后中栏一个可见视图都没有（首页空白），
///    或者干脆停在设置页。修法是 app.js 订阅 Skins.onChange 统一回首页。
///
/// 2) **启动期那次广播必须挡住**（2026-10-06 踩到，钉在这里防复发）。
///    `Skins.init()` 自己也会广播 skin:changed，而订阅排在它之前 ——
///    那次广播必然先到，此时 `Daily.bind()` 还没跑。`setView('library')`
///    → `Daily.load()` → `render()` 读 `H.ui` 抛错，异常正好打断在
///    `load()` 发请求那两行**之前**：busy 置上了、请求一个没发。
///    之后每次 load 都撞 `if (loading && !force) return`，首页永远空白，
///    而独立页 DailyView 是另一套状态、照常有歌 —— 「独立页有、首页没有」
///    正是这个 bug 的指纹。所以判据要从「函数体里有 setView」升级为
///    「有启动期闸门 + 有补跑入口」。
function checkSkinSwitchViewHandoff() {
  section('换肤：设置页切皮肤后落到首页，不留空白中栏');

  ok(/Skins\.onChange\(onSkinChangedForViews\)/.test(APP)
    && /function onSkinChangedForViews\(\)\s*\{[\s\S]{0,400}?setView\('library'\);/.test(APP),
    'app.js 订阅换肤并统一回首页（收尾动作只有一处，不靠各条调用路径记得调）');
  // 启动期闸门 + 补跑：两处都要有，缺一个就退回「首页永久空白」。
  ok(/if \(!dailyStripBound\)\s*\{[\s\S]{0,120}?pendingSkinViewHandoff = true;[\s\S]{0,80}?return;/.test(APP),
    '启动期的那次换肤广播被闸门挡住（不早于 Daily.bind()）');
  ok(/function bindDailyStrip\(\)\s*\{[\s\S]{0,200}?dailyStripBound = true;[\s\S]{0,200}?setView\('library'\);/.test(APP),
    'bind 之后有补跑入口 bindDailyStrip()');
  ok(/Daily\.bind\(favHost\);[\s\S]{0,200}?bindDailyStrip\(\);/.test(APP),
    'bindDailyStrip() 排在 Daily.bind() 之后（闸门由 bind 打开）');
  // 变量声明必须早于函数体执行：函数声明会提升，但 var 赋值不会。
  // 声明写在 onSkinChangedForViews 之后的话，启动期读它会撞 TDZ。
  ok(APP.indexOf('var dailyStripBound') < APP.indexOf('function onSkinChangedForViews()')
    && APP.indexOf('var pendingSkinViewHandoff') < APP.indexOf('function onSkinChangedForViews()'),
    '两个闸门变量声明在 onSkinChangedForViews 之前（启动期不撞 TDZ）');
  // 订阅仍要排在 init 之前（init() 会 apply 已存的选择并广播），但**这次
  // 收到之后不能直接 setView** —— 那正是本条 bug 的成因。两条合起来读：
  // 「排在前面」+「有闸门」= 启动那次广播被记账，bind 后补跑。
  //
  // 定位要用 `window.Skins.` 前缀：函数名 `Skins.init()` 在别处的**注释**里
  // 也出现过（讲为什么要有启动闸门的那段），裸 indexOf 会撞上注释，
  // 判出「订阅在 init 之后」的假象。
  const onChangeAt = APP.indexOf('window.Skins.onChange(onSkinChangedForViews)');
  const initAt = APP.indexOf('window.Skins.init()');
  ok(onChangeAt > 0 && initAt > 0 && onChangeAt < initAt,
    '订阅排在 Skins.init() 之前（启动那一次广播会到，但只记账不 setView）',
    `onChange@${onChangeAt} init@${initAt}`);
  // 症状侧的反向断言：流年/清风确实会把设置视图搬走并隐藏 ——
  // 这正是空白中栏的成因，钉住它才不会有人「顺手改成不搬」，
  // 那样 setView 里的 hidden 语义会与实际可见性脱节。
  // 只钉「搬进浮层」这个语义，不钉局部变量名（流年叫 pane、清风叫
  // sheet.pane，钉死名字就成了改名即失败的死断言）。
  ok(/relocate\(view,\s*(sheet\.)?pane\)/.test(LIUNIAN_JS)
    && /relocate\(view,\s*(sheet\.)?pane\)/.test(QINGFENG_JS),
    '流年/清风都把设置视图搬进浮层（空白中栏的成因，钉住别改回中栏）');
  ok(/if \(!sheet\.viewEl\.hidden\) sheet\.viewEl\.hidden = true;/.test(LIUNIAN_JS)
    && /sheet\.viewEl\.hidden = true;/.test(QINGFENG_JS),
    '浮层关着时设置视图确实被隐藏（换肤对账的就是这个 hidden）');
}

/// 播放条自动隐藏：显隐的**唯一权威是 wantVisible**，不许再拿「正在滑动」
/// 当拒绝新请求的理由。
///
/// 旧写法 hideBar 开头 `|| sliding` 早退、showBar 开头
/// `!classList.contains('is-hidden')` 早退，于是动画途中改变主意的那次
/// 请求被静默丢弃，而兜底 finishHide 照样把 is-hidden 补上：
/// 用户要「显示」拿到的是「永久消失」。浏览器实测稳定复现 ——
/// bar 有 is-hidden 而 body.bar-hidden 不存在，两边永久对不上。
///
/// 钉「有 wantVisible 变量」不够（可能只是声明了没人用），要钉
/// finishSlide 按它落定 + 动画有世代号（否则旧定时器会踩新状态）。
function checkBarAutohideRace() {
  section('播放条：显隐竞态不会把播放条永久藏掉');

  const init = (() => {
    const i = APP.indexOf('function initBarAutohide()');
    if (i < 0) return '';
    let depth = 0;
    for (let j = APP.indexOf('{', i); j < APP.length; j += 1) {
      if (APP[j] === '{') depth += 1;
      else if (APP[j] === '}') { depth -= 1; if (!depth) return APP.slice(i, j + 1); }
    }
    return '';
  })();
  ok(!!init, '定位到 initBarAutohide 函数体');
  if (!init) return;

  ok(/let wantVisible = true;/.test(init), '有 wantVisible 作为显隐的唯一权威');
  ok(/bar\.classList\.toggle\('is-hidden', !wantVisible\)/.test(init),
    '落定时按 wantVisible 决定 is-hidden（不是无条件加上）');
  ok(/let slideGen = 0;/.test(init) && /if \(gen !== slideGen\) return;/.test(init),
    '动画有世代号守卫（旧 transitionend / 兜底定时器不踩新状态）');
  ok(!/function hideBar\(\)\s*\{\s*if \(/.test(init)
    && !/function showBar\(\)\s*\{\s*if \(!bar\.classList\.contains/.test(init),
    'hideBar/showBar 不再用「正在滑动 / 已经隐藏」早退（那正是竞态来源）');
}

/// 舞台面板不该长出横向滚动条。
///
/// `.stage::before` 是 inset:-30% 的取色光晕（绝对定位），面板一旦
/// `overflow:auto`，它就把面板撑宽：实测 sheen 420px 面板被撑宽 125px、
/// workbench 104px 右栏被撑宽 31px，底部那条横滚动条就是它。
/// 基础样式 style.css 的 .stage 本来就是 overflow:hidden，
/// sheen/workbench 覆盖成 auto 属于覆盖过头。
///
/// 同时钉住 #stage-modes 的 min-width:0 —— 窄栏（workbench 右栏 104px，
/// 扣 padding 只剩 78px）里两颗按钮至少要 111px，不给 min-width:0
/// 整颗胶囊会顶出面板边界，是横向溢出的第二个来源。
function checkStageNoHorizontalScroll() {
  section('舞台面板：没有多余的横向滚动条');

  // **断言必须跑在剥掉注释的源码上。** 我给这两条 overflow 写的说明注释里
  // 恰好出现了「基础样式 style.css 的 .stage 本来就是 overflow:hidden」这句话
  // —— 不剥注释的话 `/overflow:\s*hidden/` 会匹配到**注释自己**，无论实际
  // 写的是什么值都绿。变异测试（把 overflow 改回 auto）当时就是不红的，
  // 靠这条才发现。
  const sheenClean = stripCssComments(SHEEN);
  const wbClean = stripCssComments(WORKBENCH);
  const stageClean = stripCssComments(STAGE_CSS);

  // 取一条规则**整块**（含声明体），花括号配平 ——
  // 只 match 到 `{` 的话拿到的是选择器本身，声明全在匹配之外。
  //
  // 必须要求「选择器前面是行首/换行」：stage.css 里 `.stage-lyrics` 有两处，
  // 前一处是 `.stage[data-mode="cover"] .stage-lyrics { display: none }` ——
  // indexOf 会先撞上它，于是「歌词区有 overflow:hidden」永远不成立。
  // sel 传**正则元字符已转义**的选择器字面量（下面两处含 [ ] . 需要手写）。
  const rule = (src, selRe) => {
    const re = new RegExp('(?:^|\\n)\\s*' + selRe + '\\s*\\{');
    const m = re.exec(src);
    if (!m) return '';
    const open = src.indexOf('{', m.index);
    let depth = 0;
    for (let j = open; j < src.length; j += 1) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') { depth -= 1; if (!depth) return src.slice(m.index, j + 1); }
    }
    return '';
  };

  ok(/overflow:\s*hidden/.test(rule(sheenClean, '\\[data-skin="sheen"\\] \\.stage')),
    '浮光的 .stage 面板不滚（歌词区自己滚）');
  ok(/overflow:\s*hidden/.test(rule(wbClean, '\\[data-skin="workbench"\\] \\.stage')),
    '工作台的 .stage 面板不滚（歌词区自己滚）');
  // 歌词区必须自己有滚动/裁剪能力，否则面板改成 hidden 之后歌词就够不着了。
  // 注意它不是 overflow-y:auto —— 歌词滚动是 JS 用 translate3d 推
  // .lyric-track 实现的（用 scrollTop + CSS smooth 会与 transform 打架，
  // 出现「抖一下又回弹」），所以这里只要求「裁剪 + min-height:0 + flex:1」。
  const lyricsRule = rule(stageClean, '.stage-lyrics');
  ok(/overflow:\s*hidden/.test(lyricsRule)
    && /min-height:\s*0/.test(lyricsRule)
    && /flex:\s*1/.test(lyricsRule),
    '歌词区自带裁剪与 flex 占位（面板不滚的前提）');
  const modes = rule(stageClean, '.stage-modes');
  ok(!!modes && /min-width:\s*0/.test(modes),
    '#stage-modes 有 min-width:0（窄栏里能被压缩，不顶破面板）');
  const mode = rule(stageClean, '.stage-mode');
  ok(/min-width:\s*0/.test(mode) && /text-overflow:\s*ellipsis/.test(mode),
    '.stage-mode 可收窄并省略（配合胶囊压缩）');
}

// ---------------------------------------------------------------------------

(function main() {
  checkCatalog();
  checkExtensibility();
  checkNoColor();
  checkContrast();
  checkIosSkin();
  checkSheenTopbarLayout();
  checkCoverage();
  checkDailyScroll();
  checkLiunianExpandedBarStability();
  checkLiunianNavigation();
  checkLiunianSettingsSheet();
  checkLiunianSettingsNav();
  checkQingfengChrome();
  checkQingfengWall();
  checkQingfengSettings();
  checkQingfengWiring();
  checkSkinSwitchViewHandoff();
  checkBarAutohideRace();
  checkStageNoHorizontalScroll();
  checkWiring();

  console.log('\n' + '─'.repeat(60));
  if (failures) {
    console.error(`界面皮肤契约检查：${checks} 项，${failures} 项失败`);
    process.exit(1);
  }
  console.log(`界面皮肤契约检查：${checks}/${checks} 全部通过`);
})();
