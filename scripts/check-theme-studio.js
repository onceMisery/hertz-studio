#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 主题工作室的无头契约检查（零依赖、不触网）。
//
//   node scripts/check-theme-studio.js
//
// theme-studio.js 做两件容易"看起来没问题但其实坏了"的事，所以两条都钉住：
//
//   1. 它新加的主题与自定义配色，文字色是从底色反推的。反推写错了界面不会
//      报错，只会让某个主题的正文糊在背景上——本脚本用**自己实现的** WCAG
//      对比度（不复用被测代码里的那份）逐套主题验一遍，保证 ≥ 7:1 / 4.5:1。
//   2. 壁纸是按文件名寻址的：JS 目录 → main.rs 的白名单表 → 磁盘上的 jpg，
//      三处任缺一处就是运行时静默 404（设置页里一个格子永远空着）。这里
//      把三份清单交叉比对，与 check-assets.js 对 JS/CSS 的做法一致。
//
// 另外钉住：自动压暗必须真的随壁纸亮度上升（不然"自动"等于没开），
// 以及自定义底色必须被夹在暗色区间（玻璃质感令牌不随主题走）。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'crates', 'vmusicd', 'web');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const STUDIO = read(path.join(WEB, 'theme-studio.js'));
const STUDIO_CSS = read(path.join(WEB, 'theme-studio.css'));
const STYLE_CSS = read(path.join(WEB, 'style.css'));
const HTML = read(path.join(WEB, 'index.html'));
const MAIN_RS = read(path.join(ROOT, 'crates', 'vmusicd', 'src', 'main.rs'));
const THEMES_JS = read(path.join(WEB, 'themes.js'));

// main.rs 的壁纸白名单：一对一对的 (名字, include_bytes!)。多个章节都要查它，
// 所以在这里解析一次。
const RS_WALLPAPERS = new Map();
{
  const re = /\(\s*"([^"]+\.jpg)"\s*,\s*include_bytes!\("([^"]+)"\)\s*,?\s*\)/g;
  let m;
  while ((m = re.exec(MAIN_RS)) !== null) RS_WALLPAPERS.set(m[1], m[2]);
}

/// 内置主题（themes.js 的 CATALOG）里的 id。"每套主题都要有背景图"这句话里的
/// "每套"包括它们，不能只验二次元那七套。
const BUILTIN_THEME_IDS = [...THEMES_JS.matchAll(/^\s*id:\s*'([^']+)',\s*$/gm)].map((m) => m[1]);
const ANIME_THEME_IDS = [...STUDIO.matchAll(/^\s*id:\s*'(anime-[^']+)',/gm)].map((m) => m[1]);

let failures = 0;
let checks = 0;
function ok(cond, label) {
  checks += 1;
  if (!cond) { failures += 1; console.error('  X ' + label); }
}
function section(name) { console.log('\n' + name); }

// ---------------------------------------------------------------------------
// 独立实现的 WCAG 对比度
//
// 刻意不复用 theme-studio.js 里的那份：复用等于用被测代码自证，反推公式
// 整体写反了也照样"通过"。这里只依赖 WCAG 2.x 的定义本身。
// ---------------------------------------------------------------------------

function toLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function lum(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return 0.2126 * toLinear(rgb[0]) + 0.7152 * toLinear(rgb[1]) + 0.0722 * toLinear(rgb[2]);
}
function contrast(a, b) {
  const hi = Math.max(a, b) + 0.05;
  const lo = Math.min(a, b) + 0.05;
  return hi / lo;
}

// ---------------------------------------------------------------------------
// 最小 DOM / 存储桩
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
    tagName: (tag || 'div').toUpperCase(),
    id: '', className: '', textContent: '', title: '', type: '',
    value: '', checked: false, disabled: false,
    dataset: {}, attrs: {}, children: [], _on: {},
    classList: makeClassList(),
    style: {
      cssText: '', backgroundImage: '',
      setProperty(k, v) { this['_' + k] = v; },
      removeProperty(k) { delete this['_' + k]; },
      getPropertyValue(k) { return this['_' + k] || ''; },
    },
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
    querySelectorAll() { return []; },
    addEventListener() {},
    _html: '',
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = String(v); this.children = []; },
  });
  return el;
}

function makeSandbox() {
  const registry = {};
  const body = makeEl('body');
  body.firstChild = null;
  const doc = {
    body,
    documentElement: makeEl('html'),
    getElementById(id) {
      if (!registry[id]) registry[id] = makeEl('div');
      return registry[id];
    },
    createElement(tag) { return makeEl(tag); },
    addEventListener() {},
  };
  const store = new Map();
  const registered = new Map();
  const applied = [];
  let current = null;
  const listeners = [];

  const sandbox = {
    console, Object, Array, JSON, Math, String, Number, Set, Map, RegExp, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent,
    document: doc,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  };
  sandbox.window = sandbox;
  // themes.js 的 API 面：register / apply / current / onChange。
  sandbox.Theme = {
    register(theme) {
      if (!theme || !theme.id || !theme.tokens) return false;
      registered.set(theme.id, theme);
      return true;
    },
    apply(id, opts) {
      current = registered.get(id) || current;
      applied.push({ id, silent: !!(opts && opts.silent) });
      listeners.forEach((fn) => { try { fn(current); } catch (e) { /* 忽略 */ } });
      return current;
    },
    current: () => current,
    onChange(fn) { if (typeof fn === 'function') listeners.push(fn); },
  };
  vm.createContext(sandbox);
  vm.runInContext(STUDIO, sandbox, { filename: 'theme-studio.js' });
  return { sandbox, registered, store, registry, doc, applied };
}

// ---------------------------------------------------------------------------
// 1. 主题：文字色必须真的达到 AA
// ---------------------------------------------------------------------------

function checkThemeContrast() {
  section('主题：每套二次元主题的正文/次要文字都达到 WCAG AA');

  const { sandbox, registered, applied } = makeSandbox();
  // 先有一套"当前主题"，模拟真实启动顺序（themes.js 的 Theme.init() 在前）。
  sandbox.Theme.register({ id: 'mineral', tokens: { '--bg': '#0A0A0A' } });
  sandbox.Theme.apply('mineral');
  applied.length = 0;
  sandbox.ThemeStudio.init();

  const ids = [...registered.keys()];
  ok(ids.length >= 5, `注册了多套主题（${ids.length} 套）`);

  section('主题：注册后要广播一次，既有菜单才认得新主题');
  // 顶栏菜单、设置页的下拉与色块组都是按目录渲染的；注册不广播的话，
  // 新主题只活在这个模块自己的色块行里，用户在原来的入口找不到。
  ok(applied.length >= 1, '注册完成后重放了一次当前主题以触发 Theme.onChange');
  ok(applied.some((a) => a.silent === true), '重放用 silent：不改用户的选择，也不写存储');

  for (const id of ids) {
    const t = registered.get(id);
    const bg = lum(t.tokens['--bg']);
    const text = lum(t.tokens['--text']);
    const muted = lum(t.tokens['--muted']);
    ok(bg !== null, `${id} 的 --bg 是合法颜色`);
    if (bg === null || text === null || muted === null) continue;
    const cText = contrast(text, bg);
    const cMuted = contrast(muted, bg);
    ok(cText >= 7, `${id} 正文对比度 ≥ 7:1（实际 ${cText.toFixed(2)}）`);
    ok(cMuted >= 4.5, `${id} 次要文字对比度 ≥ 4.5:1（实际 ${cMuted.toFixed(2)}）`);
    // --accent-ink 是在强调色底上放文字用的前景色，反了就是"亮按钮上糊白字"。
    const ink = contrast(lum(t.tokens['--accent-ink']), lum(t.tokens['--accent']));
    ok(ink >= 4.5, `${id} 强调色上的前景色 ≥ 4.5:1（实际 ${ink.toFixed(2)}）`);
    // 两个强调角色必须都有值，否则统一组件层的激活态会退化成空白描边。
    ok(!!t.tokens['--brand'] && !!t.tokens['--highlight'], `${id} 声明了 --brand 与 --highlight`);
  }
}

// ---------------------------------------------------------------------------
// 1b. 形态（skin）：主题不能只是"同一张脸涂七种颜色"
// ---------------------------------------------------------------------------

function checkSkins() {
  section('形态：每套主题各有自己的长相，不只换配色');

  // 源码里声明的 skin 与 CSS 里定义到的必须一一对应。少一个就是"换了主题
  // 但那套形态没有样式"，运行时表现为：该主题看起来跟默认一模一样。
  const declared = [...STUDIO.matchAll(/^\s*skin:\s*'([a-z]+)'/gm)].map((m) => m[1]);
  const inCss = [...STUDIO_CSS.matchAll(/\[data-ts-skin="([a-z]+)"\]/g)].map((m) => m[1]);

  ok(declared.length >= 5, `声明了多套形态（${declared.length} 套）`);
  ok(new Set(declared).size === declared.length, '每套主题的形态互不相同（重复就等于没分）');

  for (const s of declared) {
    ok(inCss.indexOf(s) >= 0, `CSS 里定义了 [data-ts-skin="${s}"]`);
  }
  for (const s of inCss) {
    ok(declared.indexOf(s) >= 0, `CSS 里的形态 ${s} 确实被某套主题用到（没有死样式）`);
  }

  // 形态必须真的"有形"：只有圆角没有纹理/装饰，换皮肤仍然只是一点轮廓变化。
  for (const s of declared) {
    const block = STUDIO_CSS.slice(
      STUDIO_CSS.indexOf(`[data-ts-skin="${s}"]`),
      STUDIO_CSS.indexOf('}', STUDIO_CSS.indexOf(`[data-ts-skin="${s}"]`))
    );
    ok(/--ts-card-radius:/.test(block), `${s} 定义了圆角`);
    ok(/--ts-card-texture:|--ts-card-stripe:/.test(block), `${s} 定义了纹理或装饰条`);
  }

  section('形态：换主题时真的把形态挂到了 <html> 上');

  const { sandbox, registered, doc } = makeSandbox();
  sandbox.Theme.register({ id: 'mineral', tokens: { '--bg': '#0A0A0A' } });
  sandbox.Theme.apply('mineral');
  sandbox.ThemeStudio.init();

  const seen = new Map();
  for (const id of registered.keys()) {
    // 只有二次元主题带 skin；走 Theme.apply 触发 onChange → applySkin。
    sandbox.Theme.apply(id);
    seen.set(id, doc.documentElement.getAttribute('data-ts-skin'));
  }
  const skins = [...seen.values()].filter((v) => v && v !== 'plain');
  ok(skins.length >= 5, `多套主题各自挂上了形态（${skins.length} 套）`);
  ok(new Set(skins).size === skins.length,
    '不同主题挂的是不同形态（挂成同一个就退回"只换色"了）');
  ok([...seen.values()].indexOf('plain') >= 0 || seen.size === 0,
    '非二次元主题回落到 plain（沿用统一组件层的圆角）');

  section('形态：卡片与设置页真的吃了这套变量');

  // 变量定义了但没人用是最容易出现的"假做完"：CSS 全绿、界面一点没变。
  const art = STYLE_CSS.slice(STYLE_CSS.indexOf('.pl-card-art {'),
    STYLE_CSS.indexOf('}', STYLE_CSS.indexOf('.pl-card-art {')));
  ok(/border-radius:\s*var\(--ts-card-radius/.test(art), '卡片圆角吃形态变量');
  ok(/\.pl-card-art::before/.test(STYLE_CSS) && /var\(--ts-card-texture/.test(STYLE_CSS),
    '卡片铺了纹理层');
  ok(/\.pl-card-art::after/.test(STYLE_CSS) && /var\(--ts-card-stripe/.test(STYLE_CSS),
    '卡片右下角有装饰条');
  ok(/var\(--ts-card-radius/.test(STYLE_CSS.slice(STYLE_CSS.indexOf('.daily-strip {'))),
    '首页推荐条也跟着换形态（最显眼的一块）');

  ok(/id="ts-skin-preview"/.test(HTML), '设置页有形态预览块');
  ok(/ts-skin-preview/.test(STUDIO_CSS), '预览块有对应样式');
  ok(/paintSkinPreview/.test(STUDIO) && /SKIN_LABEL/.test(STUDIO),
    '预览会写出当前形态的名字（否则用户只看到颜色名）');
  // 预览的名字要覆盖所有形态，漏一个就是切换后那一行空白。
  const labelBlock = STUDIO.slice(STUDIO.indexOf('var SKIN_LABEL'), STUDIO.indexOf('};', STUDIO.indexOf('var SKIN_LABEL')));
  for (const s of declared) {
    ok(labelBlock.indexOf(s + ':') >= 0, `形态 ${s} 有中文说明`);
  }
  ok(/data-skin/.test(STUDIO), '主题色块也带上了形态标识');
}

// ---------------------------------------------------------------------------
// 2. 壁纸目录 / 路由 / 磁盘三处对齐
// ---------------------------------------------------------------------------

function checkWallpaperWiring() {
  section('壁纸：JS 目录 ↔ main.rs 白名单 ↔ 磁盘文件');

  const { sandbox } = makeSandbox();
  sandbox.ThemeStudio.init();
  const catalog = sandbox.ThemeStudio.wallpapers();
  ok(catalog.length >= 8, `壁纸目录条目合理（${catalog.length} 张）`);

  // main.rs 的白名单表：一对一对的 (名字, include_bytes!)。
  const table = RS_WALLPAPERS;
  ok(table.size >= 8, `main.rs 白名单条目合理（${table.size} 条）`);

  for (const w of catalog) {
    ok(table.has(w.id), `JS 目录里的 ${w.id} 在 main.rs 白名单里`);
    const rel = table.get(w.id);
    if (rel) {
      const abs = path.resolve(path.join(ROOT, 'crates', 'vmusicd', 'src'), rel);
      ok(fs.existsSync(abs), `${w.id} → ${rel} 文件存在`);
      ok(fs.statSync(abs).size > 1024, `${w.id} 不是空文件`);
    }
    // lum 是自动压暗的输入，必须是个像样的数字。
    ok(typeof w.lum === 'number' && w.lum >= 0 && w.lum <= 255, `${w.id} 带 0..255 的亮度`);
    // 每张壁纸都要能推荐出一套主题，否则选壁纸时主题不跟着走。
    ok(typeof w.theme === 'string' && w.theme.length > 0, `${w.id} 绑了推荐主题`);
  }

  // 反向：白名单里有、JS 目录里没有的，等于内嵌了一份用不到的字节。
  const listed = new Set(catalog.map((w) => w.id));
  for (const name of table.keys()) {
    ok(listed.has(name), `main.rs 里的 ${name} 也出现在 JS 目录里`);
  }
}

// ---------------------------------------------------------------------------
// 2b. 主题 → 背景图
//
// "切到二次元主题后背景图不显示"的根因是：主题与壁纸原本是两套互不相干的
// 状态，点主题不带背景。这一段把修好的那半边钉住——**每一套**主题（内置 +
// 二次元 + 自定义）都要解析出一张真实存在的背景图，而且来回切换要稳定。
// ---------------------------------------------------------------------------

/// 造一个把内置主题也登记进 Theme 的沙箱：真实运行时它们由 themes.js 的
/// CATALOG 提供，而这里的 Theme 是桩，得自己补上，否则 apply('mineral') 之类
/// 取不到主题对象，广播出去的还是上一套。
function sandboxWithFullCatalog() {
  const env = makeSandbox();
  for (const id of BUILTIN_THEME_IDS) {
    env.sandbox.Theme.register({ id, tokens: { '--bg': '#0a0a0a' } });
  }
  return env;
}

function checkThemeBackgrounds() {
  section('主题 → 背景图：每一套主题都解析出一张真实存在的图');

  ok(BUILTIN_THEME_IDS.length >= 10, `内置主题被抽出来验证（${BUILTIN_THEME_IDS.length} 套）`);
  ok(ANIME_THEME_IDS.length >= 5, `二次元主题被抽出来验证（${ANIME_THEME_IDS.length} 套）`);

  const { sandbox } = sandboxWithFullCatalog();
  const S = sandbox.ThemeStudio;
  const catalog = S.wallpapers();
  const onDisk = new Set(catalog.map((w) => w.id));
  S.init();

  const all = BUILTIN_THEME_IDS.concat(ANIME_THEME_IDS).concat(['custom-studio']);
  const resolved = new Map();
  for (const id of all) {
    const wall = S.wallpaperForTheme(id);
    resolved.set(id, wall);
    ok(!!wall, `${id} 解析出了背景图（${wall}）`);
    if (!wall) continue;
    ok(onDisk.has(wall), `${id} 的 ${wall} 在 JS 壁纸目录里`);
    ok(RS_WALLPAPERS.has(wall), `${id} 的 ${wall} 在 main.rs 白名单里`);
    const rel = RS_WALLPAPERS.get(wall);
    if (rel) {
      const abs = path.resolve(path.join(ROOT, 'crates', 'vmusicd', 'src'), rel);
      ok(fs.existsSync(abs) && fs.statSync(abs).size > 1024, `${id} 的 ${wall} 磁盘文件非空`);
    }
  }

  section('主题 → 背景图：二次元主题拿到的就是画廊里推荐给它的那张');

  // 真值只留一处：二次元那七套不在映射表里重复声明，而是从 WALLPAPERS 的
  // theme 字段反查。这里反过来验一遍——两边对不上就是"表里的图和画廊里
  // 推荐的那张不一致"，用户点色块和点缩略图会看到两张不同的图。
  for (const id of ANIME_THEME_IDS) {
    const recommended = catalog.find((w) => w.theme === id);
    ok(!!recommended && resolved.get(id) === recommended.id,
      `${id} → ${resolved.get(id)}（画廊首推 ${recommended && recommended.id}）`);
  }

  section('主题 → 背景图：缺资源时落到默认兜底');

  const fallback = S.defaultWallpaper();
  ok(!!fallback && onDisk.has(fallback), `默认兜底图 ${fallback} 本身在目录里`);
  ok(RS_WALLPAPERS.has(fallback), `默认兜底图 ${fallback} 在 main.rs 白名单里`);
  ok(S.wallpaperForTheme('__no-such-theme__') === fallback, '没声明过的主题落到兜底图');
  ok(S.wallpaperForTheme('') === fallback, '空主题 id 也落到兜底图（不清成空白）');
  ok(S.wallpaperForTheme(null) === fallback, 'null 主题 id 也落到兜底图');

  section('主题 → 背景图：切换时真的把图换上了，来回切稳定');

  const env = sandboxWithFullCatalog();
  const T = env.sandbox.ThemeStudio;
  T.init();
  ok(T.state.pinned === false, '默认状态是「跟随主题」（未钉住）');

  const trip = ['anime-shinobi', 'mineral', 'anime-sakura', 'vcp-starblue',
    'anime-abyss', 'liunian', 'anime-shinobi', 'mineral'];
  const seen = [];
  for (const id of trip) {
    env.sandbox.Theme.apply(id);
    seen.push(T.state.id);
    ok(T.state.id === T.wallpaperForTheme(id),
      `切到 ${id} 后背景图是 ${T.state.id}`);
  }
  ok(seen[0] === seen[6], `A→…→A 回到同一张（${seen[0]}）`);
  ok(seen[1] === seen[7], `B→…→B 回到同一张（${seen[1]}）`);
  ok(seen[0] !== seen[1], '不同主题拿到不同的背景图（全落兜底就等于没分）');

  // 二次元七套之间必须真的分开了——这是用户能直接看到的那部分。
  const animeSeen = new Set(ANIME_THEME_IDS.map((id) => T.wallpaperForTheme(id)));
  ok(animeSeen.size === ANIME_THEME_IDS.length,
    `七套二次元主题各有一张不同的背景图（${animeSeen.size}/${ANIME_THEME_IDS.length}）`);

  section('主题 → 背景图：用户手动指定后不再被主题覆盖');

  const env2 = sandboxWithFullCatalog();
  const T2 = env2.sandbox.ThemeStudio;
  T2.init();
  T2.setWallpaper('night-02.jpg', { keepTheme: true, persist: false });
  ok(T2.state.pinned === true, '手动选图后壁纸被钉住');
  env2.sandbox.Theme.apply('vcp-emerald');
  ok(T2.state.id === 'night-02.jpg', '钉住后换主题不改壁纸');
  T2.setWallpaper('', { keepTheme: true, persist: false });
  env2.sandbox.Theme.apply('mineral');
  ok(T2.state.id === '', '手动关掉壁纸后换主题也不会自动铺回来');

  // 选壁纸顺带换上的推荐主题，不能反过来把用户刚点的那张图顶掉。
  const env3 = sandboxWithFullCatalog();
  const T3 = env3.sandbox.ThemeStudio;
  T3.init();
  T3.setWallpaper('night-12.jpg');
  ok(T3.state.id === 'night-12.jpg',
    '选壁纸→换推荐主题，壁纸保持用户点的那张（不被主题默认图顶掉）');

  section('主题 → 背景图：旧存档按「用户选过」还原，不被升级改写');

  const old = JSON.stringify({ id: 'morning-01.jpg', opacity: 0.5, dim: 0, blur: 0, auto: true });
  const env4 = sandboxWithFullCatalog();
  env4.store.set('vmusic.wallpaper.v1', old);
  env4.sandbox.ThemeStudio.init();
  ok(env4.sandbox.ThemeStudio.state.pinned === true, '没有 pinned 字段的旧存档视为已钉住');
  ok(env4.sandbox.ThemeStudio.state.id === 'morning-01.jpg', '旧存档的壁纸被原样还原');

  section('主题 → 背景图：图加载不出来时回落到默认图');

  // 目录里写错名字 / 服务端没有这张，浏览器只会静默留一层空白。这一段用一个
  // 会失败的 Image 桩把那条兜底路径逼出来。
  const probe = { fail: true };
  const env5 = makeSandbox();
  env5.sandbox.Image = function ImageStub() {
    const self = this;
    Object.defineProperty(self, 'src', {
      configurable: true,
      get() { return self._src; },
      set(v) {
        self._src = v;
        if (probe.fail) { if (typeof self.onerror === 'function') self.onerror(); }
        else if (typeof self.onload === 'function') self.onload();
      },
    });
  };
  const T5 = env5.sandbox.ThemeStudio;
  T5.init();
  T5.setWallpaper('morning-01.jpg', { keepTheme: true, persist: false });
  ok(T5.state.id === T5.defaultWallpaper(),
    `加载失败回落到默认图（${T5.state.id}）`);
  probe.fail = false;
  T5.setWallpaper('night-08.jpg', { keepTheme: true, persist: false });
  ok(T5.state.id === 'night-08.jpg', '能加载时不回落');
  probe.fail = true;
  T5.setWallpaper(T5.defaultWallpaper(), { keepTheme: true, persist: false });
  ok(T5.state.id === T5.defaultWallpaper(), '默认图自身失败也停在默认图（不会无限回落）');
}

// ---------------------------------------------------------------------------
// 3. 自动压暗：随壁纸亮度上升，且压完仍然可读
// ---------------------------------------------------------------------------

function checkAutoDim() {
  section('壁纸：自动压暗随亮度上升');

  const { sandbox, registered } = makeSandbox();
  const S = sandbox.ThemeStudio;
  S.init();

  const catalog = S.wallpapers();
  const dark = catalog.reduce((a, b) => (a.lum <= b.lum ? a : b));
  const bright = catalog.reduce((a, b) => (a.lum >= b.lum ? a : b));

  sandbox.Theme.apply('anime-shinobi');

  S.setWallpaper(bright.id, { keepTheme: true, persist: false });
  S.setOptions({ auto: true, opacity: 1, blur: 0 });
  const dimBright = S.effectiveDim();

  S.setWallpaper(dark.id, { keepTheme: true, persist: false });
  S.setOptions({ auto: true, opacity: 1, blur: 0 });
  const dimDark = S.effectiveDim();

  ok(dimBright > dimDark, `亮壁纸压得更狠（${dimBright.toFixed(3)} > ${dimDark.toFixed(3)}）`);
  ok(dimBright >= 0.5, `最亮的壁纸也压到一半以上（${dimBright.toFixed(3)}）`);

  section('壁纸：铺满任何一张壁纸，正文都还有 AA');

  let worst = { ratio: Infinity, at: null };
  for (const id of registered.keys()) {
    sandbox.Theme.apply(id);
    for (const w of catalog) {
      for (const opacity of [0.35, 0.55, 0.85, 1]) {
        S.setWallpaper(w.id, { keepTheme: true, persist: false });
        S.setOptions({ auto: true, opacity, blur: 0 });
        const r = S.readability();
        if (r.ratio < worst.ratio) worst = { ratio: r.ratio, at: `${id} + ${w.id} @${opacity}` };
        ok(r.verdict !== 'low', `${id} + ${w.id} @${opacity} 不应判为偏低（${r.ratio.toFixed(2)}）`);
      }
    }
  }
  ok(worst.ratio >= 4.5,
    `最差的组合也达到 AA（${worst.ratio.toFixed(2)}:1，出现在 ${worst.at}）`);

  section('壁纸：手动档听用户的，自动档忽略手动值');
  sandbox.Theme.apply('anime-shinobi');
  S.setWallpaper(bright.id, { keepTheme: true, persist: false });
  S.setOptions({ auto: false, dim: 0.9 });
  ok(Math.abs(S.effectiveDim() - 0.9) < 1e-6, '手动档直接用用户的值');
  S.setOptions({ auto: false, dim: 0 });
  ok(Math.abs(S.effectiveDim() - 0) < 1e-6, '手动档拖到 0 就是完全不压暗');
}

// ---------------------------------------------------------------------------
// 4. 自定义配色与持久化
// ---------------------------------------------------------------------------

function checkCustomAndPersistence() {
  section('自定义配色：底色夹在暗色区间，文字仍然 AA');

  const { sandbox, registered } = makeSandbox();
  const S = sandbox.ThemeStudio;
  S.init();

  // 给一个很亮的底色，模块必须自己收敛回暗色区间。
  const r = S.applyCustom({ bg: '#f3f0e4', accent: '#ff6a3d', accent2: '#4a7dff' });
  ok(r.clamped === true, '亮底色被判为需要收敛');
  ok(lum(r.bg) <= 0.041, `收敛后的底色确实落在暗区（${r.bg}，亮度 ${lum(r.bg).toFixed(3)}）`);

  const custom = registered.get('custom-studio');
  ok(!!custom, '自定义主题已注册进 Theme');
  const cText = contrast(lum(custom.tokens['--text']), lum(custom.tokens['--bg']));
  const cMuted = contrast(lum(custom.tokens['--muted']), lum(custom.tokens['--bg']));
  ok(cText >= 7, `自定义正文 ≥ 7:1（${cText.toFixed(2)}）`);
  ok(cMuted >= 4.5, `自定义次要文字 ≥ 4.5:1（${cMuted.toFixed(2)}）`);

  // 强调色反过来也要处理：亮强调色必须配深色前景，不能糊白字。
  const bright = S.applyCustom({ bg: '#101418', accent: '#ffe066', accent2: '#4a7dff' });
  ok(bright.clamped === false, '本来就在暗区间的底色不动它');
  const c2 = registered.get('custom-studio');
  ok(contrast(lum(c2.tokens['--accent-ink']), lum(c2.tokens['--accent'])) >= 4.5,
    '亮强调色配的是能读的前景色');

  section('持久化：壁纸与配色进 localStorage，坏数据当没存过');

  const a = makeSandbox();
  a.sandbox.ThemeStudio.init();
  a.sandbox.ThemeStudio.setWallpaper('night-02.jpg', { keepTheme: true });
  a.sandbox.ThemeStudio.setOptions({ opacity: 0.4, auto: false, dim: 0.3, blur: 12 });

  // 同一份存储喂给一个新实例，等于刷新一次页面。
  const raw = a.store.get('vmusic.wallpaper.v1');
  ok(!!raw, '壁纸选择被写进 localStorage');

  const b = makeSandbox();
  b.store.set('vmusic.wallpaper.v1', raw);
  b.sandbox.ThemeStudio.init();
  const st = b.sandbox.ThemeStudio.state;
  ok(st.id === 'night-02.jpg', '刷新后壁纸还在');
  ok(Math.abs(st.opacity - 0.4) < 1e-6, '刷新后强度还在');
  ok(st.auto === false && Math.abs(st.dim - 0.3) < 1e-6, '刷新后压暗档位还在');
  ok(Math.abs(st.blur - 12) < 1e-6, '刷新后模糊还在');

  const c = makeSandbox();
  c.store.set('vmusic.wallpaper.v1', '{ 这不是 json');
  c.sandbox.ThemeStudio.init();
  ok(c.sandbox.ThemeStudio.state.id === '', '坏数据当没存过，不抛错');

  const d = makeSandbox();
  d.store.set('vmusic.wallpaper.v1', JSON.stringify({ id: 'not-a-real-file.jpg' }));
  d.sandbox.ThemeStudio.init();
  ok(d.sandbox.ThemeStudio.state.id === '',
    '存储里的文件名不在目录里就忽略（否则会向服务端要一个 404）');

  section('封面素材：同一条目每次拿同一张壁纸');
  const e = makeSandbox();
  e.sandbox.ThemeStudio.init();
  const one = e.sandbox.ThemeStudio.artPlaceholder('pl-42');
  const two = e.sandbox.ThemeStudio.artPlaceholder('pl-42');
  ok(one === two, '同一个 id 稳定映射到同一张');
  ok(/^url\("\/wallpapers\/[a-z0-9-]+\.jpg"\)$/.test(one), `产出可直接用且是绝对路径（${one}）`);
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(e.sandbox.ThemeStudio.artPlaceholder('id-' + i));
  ok(seen.size > 1, `不同 id 会分散到多张壁纸（命中 ${seen.size} 张）`);
}

// ---------------------------------------------------------------------------

(function main() {
  checkThemeContrast();
  checkSkins();
  checkWallpaperWiring();
  checkThemeBackgrounds();
  checkAutoDim();
  checkCustomAndPersistence();

  console.log('\n' + '─'.repeat(60));
  if (failures) {
    console.error(`主题工作室契约检查：${checks} 项，${failures} 项失败`);
    process.exit(1);
  }
  console.log(`主题工作室契约检查：${checks}/${checks} 全部通过`);
})();
