#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 「刷新一次，选择还在吗」的无头契约检查（零依赖、不触网）。
//
//   node scripts/check-appearance-restore.js
//
// 换肤类的功能最容易坏在一个地方：**选择被存下来了，但读回来的时机不对**。
// 用户在设置页里点了某套主题，界面立刻变样（因为主题对象此刻就在内存里），
// 刷新后却回到默认——存储没丢，是启动时这套主题还没登记进目录，读回来时
// 被当成"不认识的选择"静默忽略了。这种失败没有报错、没有红字，只有"又变回
// 去了"，靠肉眼很难定位，所以钉在这里：
//
//   1. 布局皮肤（skins.js）：data-skin + 对应 CSS 的启用态要跟着存储走。
//   2. 主题色（themes.js）：晚登记的主题（二次元那一批、自定义配色）必须在
//      登记完成后被兑现，不能停在启动时的兜底主题上。
//   3. 形态（theme-studio.js 的 data-ts-skin）与自定义配色的三个颜色同理。
//
// 做法与浏览器里的真实启动序列一致：skins.js / themes.js / theme-studio.js
// 依次求值，再由 app.js 的启动序列 Skins.init → Theme.init → ThemeStudio.init
// 拉起来。"刷新"用共享同一份 localStorage 的新沙箱模拟。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'crates', 'vmusicd', 'web');
const APP = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const SKINS_JS = read(path.join(WEB, 'skins', 'skins.js'));
const THEMES_JS = read(path.join(WEB, 'themes.js'));
const STUDIO_JS = read(path.join(WEB, 'theme-studio.js'));

let failures = 0;
let checks = 0;
function ok(cond, label) {
  checks += 1;
  if (!cond) { failures += 1; console.error('  X ' + label); }
}
function eq(a, b, label) { ok(a === b, label + '（实际 ' + JSON.stringify(a) + '，期望 ' + JSON.stringify(b) + '）'); }
function section(name) { console.log('\n' + name); }

// ---------------------------------------------------------------------------
// 最小 DOM 桩
// ---------------------------------------------------------------------------

function makeEl(tag, id) {
  const attrs = {};
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    id: id || '',
    className: '', textContent: '', innerHTML: '', title: '', type: '',
    value: '', checked: false, hidden: false, disabled: false,
    dataset: {}, children: [], firstChild: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: {
      setProperty(k, v) { this['_' + k] = v; },
      removeProperty(k) { delete this['_' + k]; },
      getPropertyValue(k) { return this['_' + k] || ''; },
    },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    removeAttribute(k) { delete attrs[k]; },
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    querySelectorAll() { return []; },
    addEventListener() {},
    getAttributeNames() { return Object.keys(attrs); },
  };
  return el;
}

/// 建一个"浏览器"：三个模块按 index.html 的顺序求值，随后由 boot() 触发
/// app.js 的启动序列。store 传进来即共享存储，用它模拟一次刷新。
function makeApp(store) {
  const html = makeEl('html');
  const body = makeEl('body');
  const links = ['sheen', 'workbench', 'liunian'].map((id) => {
    const l = makeEl('link');
    l.setAttribute('data-skin-css', id);
    l.disabled = true;
    return l;
  });
  const nodes = new Map();
  const events = [];
  const sandbox = {
    console: { warn() {}, log() {} },
    Object, Array, JSON, Math, String, Number, Boolean, Set, Map, RegExp,
    parseInt, parseFloat, isNaN, Date,
    CustomEvent: class CustomEvent {
      constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; }
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      body,
      documentElement: html,
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, makeEl('div', id));
        return nodes.get(id);
      },
      createElement(tag) { return makeEl(tag); },
      querySelectorAll(sel) { return sel === 'link[data-skin-css]' ? links : []; },
      querySelector() { return null; },
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent(e) { events.push(e); return true; },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // index.html 的加载顺序：skins.js → themes.js → theme-studio.js（中间那些
  // 与观感无关的模块略过）。
  vm.runInContext(SKINS_JS, sandbox, { filename: 'skins.js' });
  vm.runInContext(THEMES_JS, sandbox, { filename: 'themes.js' });
  vm.runInContext(STUDIO_JS, sandbox, { filename: 'theme-studio.js' });
  return { sandbox, html, links, store, events, nodes };
}

/// app.js 的启动序列（所见动词对应那里的三行调用）。
function boot(app) {
  if (app.sandbox.Skins) app.sandbox.Skins.init();
  app.sandbox.Theme.init();
  if (app.sandbox.ThemeStudio) {
    app.sandbox.ThemeStudio.bind({ toast() {} });
    app.sandbox.ThemeStudio.init();
  }
  return app;
}

function enabledSkin(app) {
  const on = app.links.filter((l) => !l.disabled);
  return on.length === 1 ? on[0].getAttribute('data-skin-css') : null;
}

// ---------------------------------------------------------------------------
// 1. 布局皮肤
// ---------------------------------------------------------------------------

function checkSkinRestore() {
  section('布局皮肤：刷新后 data-skin 与配套 CSS 的启用状态都还在');

  const store = new Map();
  const first = boot(makeApp(store));
  first.sandbox.Skins.apply('workbench');
  eq(store.get('vmusic.skin'), 'workbench', '选择写进 localStorage');

  const second = boot(makeApp(store));
  eq(second.html.getAttribute('data-skin'), 'workbench', '刷新后 html 上还是这套皮肤');
  eq(enabledSkin(second), 'workbench', '刷新后启用的还是这套皮肤的 CSS');
  eq(second.sandbox.Skins.currentId(), 'workbench', 'Skins.currentId 与之一致');

  // 换回去也要成立，否则只是"记住了第一次"。
  second.sandbox.Skins.apply('liunian');
  const third = boot(makeApp(store));
  eq(third.html.getAttribute('data-skin'), 'liunian', '改成另一套后刷新仍然保持');
  eq(enabledSkin(third), 'liunian', 'CSS 跟着换到流年');

  const bad = new Map([['vmusic.skin', 'no-such-skin']]);
  const fourth = boot(makeApp(bad));
  eq(fourth.sandbox.Skins.currentId(), 'classic', '存了不认识的皮肤回落 classic（不写无效值）');

  const empty = boot(makeApp(new Map()));
  eq(empty.sandbox.Skins.currentId(), 'classic', '没存过就是默认皮肤');
}

// ---------------------------------------------------------------------------
// 2. 主题色：早登记的内置主题
// ---------------------------------------------------------------------------

function checkBuiltinThemeRestore() {
  section('主题色：内置主题刷新后还要在同一套上');

  const store = new Map();
  const first = boot(makeApp(store));
  first.sandbox.Theme.apply('sakura');
  eq(store.get('vmusic.theme.v2'), 'sakura', '内置主题写进 localStorage');

  const second = boot(makeApp(store));
  eq(second.sandbox.Theme.current().id, 'sakura', '刷新后主题没跑');
  eq(second.html.getAttribute('data-theme'), 'sakura', 'html 上的标记也是它');
  eq(second.html.style.getPropertyValue('--accent'), '#ff8c94', '令牌值跟着主题走');

  const unknown = boot(makeApp(new Map([['vmusic.theme.v2', 'not-a-theme']])));
  eq(unknown.sandbox.Theme.current().id, 'mineral', '不认识的主题 id 回落到默认');
}

// ---------------------------------------------------------------------------
// 3. 主题色：晚登记的二次元主题（自动化测试的主力目标）
// ---------------------------------------------------------------------------

function checkLateThemeRestore() {
  section('主题色：二次元主题是在 theme-studio 里登记的，刷新后必须兑现');

  const store = new Map();
  const first = boot(makeApp(store));
  // 用户从设置页色块里点了一套二次元主题。
  first.sandbox.Theme.apply('anime-shinobi');
  eq(first.sandbox.Theme.current().id, 'anime-shinobi', '当场切换成功');
  eq(store.get('vmusic.theme.v2'), 'anime-shinobi', '选择写进 localStorage');

  // 刷新一次：Theme.init() 跑的时候这套主题还没有登记上去。
  const second = boot(makeApp(store));
  eq(second.sandbox.Theme.current().id, 'anime-shinobi', '刷新后仍是这套主题（不是兜底首项）');
  eq(second.html.getAttribute('data-theme'), 'anime-shinobi', 'html 标记同步');
  eq(second.html.getAttribute('data-ts-skin'), 'blade', '随主题一起的形态也回来了');
  eq(second.html.style.getPropertyValue('--accent'), '#ff6a3d', '强调色令牌在');

  // 换一套也要跟得上——只兑现第一次等于没修。
  second.sandbox.Theme.apply('anime-sakura');
  const third = boot(makeApp(store));
  eq(third.sandbox.Theme.current().id, 'anime-sakura', '换成樱花后刷新保持');
  eq(third.html.getAttribute('data-ts-skin'), 'petal', '形态跟着换了');

  // 七套都能读回来才算数：有的登记顺序在后、有的形态不同。
  const all = second.sandbox.Theme.list().map((t) => t.id).filter((id) => id.indexOf('anime-') === 0);
  ok(all.length >= 7, `二次元主题齐全（${all.length} 套）`);
  for (const id of all) {
    const s = new Map([['vmusic.theme.v2', id]]);
    const app = boot(makeApp(s));
    eq(app.sandbox.Theme.current().id, id, `${id} 刷新后可恢复`);
  }
}

// ---------------------------------------------------------------------------
// 4. 自定义配色：不只是记住 id，那套主题本身要重新登记出来
// ---------------------------------------------------------------------------

function checkCustomRestore() {
  section('自定义配色：刷新后主题与三个颜色都要回来');

  const store = new Map();
  const first = boot(makeApp(store));
  first.sandbox.ThemeStudio.applyCustom({ bg: '#12161c', accent: '#ff6a3d', accent2: '#4a7dff' });
  eq(store.get('vmusic.theme.v2'), 'custom-studio', '自定义主题 id 写进 localStorage');

  const second = boot(makeApp(store));
  eq(second.sandbox.Theme.current().id, 'custom-studio', '刷新后还在自定义配色上');
  eq(second.html.style.getPropertyValue('--accent'), '#ff6a3d', '强调色回来了');
  eq(second.sandbox.ThemeStudio.state.accent, '#ff6a3d', '设置页里的三个值也还原了');
  eq(second.sandbox.ThemeStudio.state.accent2, '#4a7dff', '次强调色还原');

  // 自定义配色是"每次启动现登记"的：登记不出来就是换了个地方静默失败。
  ok(second.sandbox.Theme.list().some((t) => t.id === 'custom-studio'),
    '自定义主题在启动后被登记进目录（菜单里能再选到）');

  // 自定义 → 二次元 → 自定义，来回切换也要稳定。
  second.sandbox.Theme.apply('anime-chakra');
  const third = boot(makeApp(store));
  eq(third.sandbox.Theme.current().id, 'anime-chakra', '从自定义切到二次元后刷新保持');
  third.sandbox.Theme.apply('custom-studio');
  const fourth = boot(makeApp(store));
  eq(fourth.sandbox.Theme.current().id, 'custom-studio', '再切回自定义后刷新仍然保持');
}

// ---------------------------------------------------------------------------
// 5. 壁纸：与主题一起看的那一层
// ---------------------------------------------------------------------------

function checkWallpaperRestore() {
  section('壁纸：刷新后还在，且不会劫走用户手动选的主题');

  const store = new Map();
  const first = boot(makeApp(store));
  first.sandbox.ThemeStudio.setWallpaper('night-02.jpg', { keepTheme: true });
  const second = boot(makeApp(store));
  eq(second.sandbox.ThemeStudio.state.id, 'night-02.jpg', '刷新后壁纸还在');

  // 选壁纸会顺带推一套推荐主题，但推荐不应该盖住用户后来的手动选择。
  const third = boot(makeApp(new Map()));
  third.sandbox.Theme.apply('forest');
  third.sandbox.ThemeStudio.setWallpaper('evening-12.jpg', { keepTheme: true });
  const fourth = boot(makeApp(third.store));
  eq(fourth.sandbox.Theme.current().id, 'forest', 'keepTheme 下壁纸不动主题');
  eq(fourth.sandbox.ThemeStudio.state.id, 'evening-12.jpg', '壁纸自己记下来了');
}

// ---------------------------------------------------------------------------
// 6. 接线：app.js 的启动序列不能被改乱
// ---------------------------------------------------------------------------

function checkBootOrder() {
  section('接线：app.js 里的启动顺序');

  // 比的是 boot() 里的**调用**位置，不是函数定义位置（initTheme 定义在
  // Skins.init 那一行之前，按定义位置比会得出相反的结论）。
  const skinAt = APP.indexOf('window.Skins.init()');
  const themeAt = APP.indexOf('initTheme();');
  const studioAt = APP.indexOf('initThemeStudio();');
  ok(skinAt > 0, 'app.js 启动时会初始化皮肤');
  ok(themeAt > 0, 'app.js 启动时会初始化主题');
  ok(studioAt > 0, 'app.js 启动时会初始化主题工作室');
  ok(skinAt < themeAt, 'Skins.init 排在 initTheme 之前（先布局后配色）');
  ok(themeAt < studioAt, 'initTheme 排在 initThemeStudio 之前（令牌先就位）');
}

// ---------------------------------------------------------------------------

(function main() {
  checkSkinRestore();
  checkBuiltinThemeRestore();
  checkLateThemeRestore();
  checkCustomRestore();
  checkWallpaperRestore();
  checkBootOrder();

  console.log('\n' + '─'.repeat(60));
  if (failures) {
    console.error(`刷新恢复契约检查：${checks} 项，${failures} 项失败`);
    process.exit(1);
  }
  console.log(`刷新恢复契约检查：${checks}/${checks} 全部通过`);
})();
