#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 前端资源接线检查（零依赖）。
//
// hertz-studio 用 `include_str!` 把 plugin/ui/ 下的文件内嵌进二进制，再用一张显式路由表
// 逐个挂出去。这条链有三个容易静默失效的地方，而且都不会被 Rust 编译器拦住：
//
//   1. include_str! 指向的文件不存在      → 这个会被编译器拦住（唯一的好消息）
//   2. 路由表里漏了一个 const             → 编译通过，浏览器 404
//   3. index.html 里引了没挂路由的文件     → 编译通过，浏览器 404，页面半死
//   4. index.html 里引的脚本顺序错了       → 编译通过，运行时 undefined
//
// 所以这里把三份清单（磁盘上的文件 / main.rs 的常量与路由 / index.html 的引用）
// 交叉比对，任何一边多出或少掉都报错。
//
//   node scripts/check-assets.js

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'plugin', 'ui');
const MAIN_RS = path.join(ROOT, 'crates', 'hertz-studio', 'src', 'main.rs');
const INDEX = path.join(WEB, 'index.html');

let failures = 0;
let checks = 0;

function ok(cond, label) {
  checks += 1;
  if (!cond) { failures += 1; console.error('  ✗ ' + label); }
}

const mainRs = fs.readFileSync(MAIN_RS, 'utf8');
const indexHtml = fs.readFileSync(INDEX, 'utf8');

// ---------------------------------------------------------------------------
// 1. main.rs 里的 include_str! —— 文件是否存在
// ---------------------------------------------------------------------------

const includes = [];
const incRe = /const\s+([A-Z0-9_]+)\s*:\s*&str\s*=\s*include_str!\(\s*"([^"]+)"\s*\)/g;
let m;
while ((m = incRe.exec(mainRs)) !== null) includes.push({ name: m[1], rel: m[2] });

console.log('\n内嵌资源');
ok(includes.length >= 15, `include_str! 数量合理（${includes.length}）`);
includes.forEach((inc) => {
  const abs = path.resolve(path.join(ROOT, 'crates', 'hertz-studio', 'src'), inc.rel);
  ok(fs.existsSync(abs), `${inc.name} → ${inc.rel} 文件存在`);
});

// ---------------------------------------------------------------------------
// 2. 路由表 —— 每个资源都有挂载点，且用的 const 已定义
// ---------------------------------------------------------------------------

const declared = new Set(includes.map((i) => i.name));
// 路由可能写成一行，也可能因为行宽被 rustfmt 折成多行 —— 所以空白一律用 \s*
// 匹配，并允许尾随逗号。asset() 的第一个参数是 MIME 常量、第二个才是资源常量。
const routeRe = /\.route\(\s*"(\/[^"]+)"\s*,\s*get\(\s*\|\|\s*asset\(\s*[A-Z0-9_]+\s*,\s*([A-Z0-9_]+)\s*\)\s*,?\s*\)\s*,?\s*\)/g;
const routes = [];
while ((m = routeRe.exec(mainRs)) !== null) routes.push({ path: m[1], const: m[2] });

console.log('\n路由表');
ok(routes.length >= 15, `route 条目数量合理（${routes.length}）`);
routes.forEach((r) => {
  ok(declared.has(r.const), `路由 ${r.path} 引用的 ${r.const} 已在文件顶部声明`);
});

// 每个 JS/CSS 资源常量都必须有一条路由，否则浏览器会 404。
// index.html 是特例：它由 `/` 那条路由用 index() 处理器返回，不走 asset()。
includes.forEach((inc) => {
  if (inc.name === 'INDEX_HTML') return;
  ok(routes.some((r) => r.const === inc.name), `${inc.name} 有对应的路由`);
});

// ---------------------------------------------------------------------------
// 3. index.html —— 引用与路由一一对应，且脚本顺序满足依赖
// ---------------------------------------------------------------------------

const linkedCss = [];
const cssRe = /<link[^>]+href="([^"]+\.css)"/g;
while ((m = cssRe.exec(indexHtml)) !== null) linkedCss.push(m[1]);

const linkedJs = [];
const jsRe = /<script[^>]+src="([^"]+\.js)"/g;
while ((m = jsRe.exec(indexHtml)) !== null) linkedJs.push(m[1]);

console.log('\nindex.html 引用');
const routed = new Set(routes.map((r) => r.path));
linkedCss.concat(linkedJs).forEach((href) => {
  const p = '/' + href.replace(/^\.\//, '');
  ok(routed.has(p), `index.html 引用的 ${href} 已挂路由`);
  ok(fs.existsSync(path.join(WEB, href)), `index.html 引用的 ${href} 文件存在`);
});

// 每个前端资源也都应该被 index.html 引用，否则它永远不会被加载。
// 用相对 plugin/ui/ 的完整 href 比对而不是 basename：vendor/qrcode.js 与未来可能的
// 同名文件处在子目录里，basename 会把它们混为一谈。
// 例外：允许被 index.html 引用的脚本按 URL 字符串惰性注入的资源（如商籁
// 首次启用时才加载的 vendor/pixi.min.js）——在全部已引用脚本源码里能查到
// 同一 href 字符串即视为已接线。
const linkedJsSource = linkedJs
  .map((href) => {
    try { return fs.readFileSync(path.join(WEB, href), 'utf8'); } catch (e) { return ''; }
  })
  .join('\n');
includes.forEach((inc) => {
  if (inc.name === 'INDEX_HTML') return;
  const abs = path.resolve(path.join(ROOT, 'crates', 'hertz-studio', 'src'), inc.rel);
  const href = path.relative(WEB, abs).split(path.sep).join('/');
  ok(linkedCss.includes(href) || linkedJs.includes(href) || linkedJsSource.includes(`'${href}'`)
    || linkedJsSource.includes(`'/${href}'`),
    `${inc.name}（${href}）被 index.html 引用`);
});

// ---------------------------------------------------------------------------
// 4. 脚本顺序：依赖必须排在被依赖者之前
// ---------------------------------------------------------------------------

console.log('\n脚本加载顺序');
const REQUIRE_BEFORE = [
  ['bgwall.js', 'backgrounds.js'],          // 弧形墙内核先于背景模块
  ['pl-covers.js', 'shelf.js'],             // 共享封面解析先于歌单架
  ['lyric3d.js', 'creative-stage.js'],      // 歌词图集先于编排层
  ['creative-gl.js', 'creative-stage.js'],      // 编排层建引擎时读 window.CreativeGL
  ['stage.js', 'creative-stage.js'],            // 帧门登记在 Stage 上
  ['stage.js', 'handdrawn.js'],
  ['stage-particles.js', 'handdrawn.js'],       // 手绘抖动读起音脉冲
  ['stage-control.js', 'creative-stage.js'],    // 三维开启时让粒子层让位
  ['creative-stage.js', 'creative-prompt.js'],  // 提示词编译器读编排层 scenes/spec
  ['creative-prompt.js', 'workshop.js'],        // 工坊"一句成景"读 CreativePrompt
  ['creative-stage.js', 'workshop.js'],
  ['creative-stage.js', 'stage-cinema.js'],   // cinema 注册 camLayers 依赖编排层 API
  ['stage-cinema.js', 'stage-freecam.js'],    // freecam 与 cinema 互斥联动
  ['stage-cinema.js', 'stage-focus.js'],      // peek 经 cinema setPeek 联动
  ['stage.js', 'stage3d.js'],                 // 三维舞台挂 Stage.gate 读 Stage.tier
  ['onset.js', 'stage3d.js'],                 // 三维舞台复用全项目唯一一份起音判定
  ['stage.js', 'stage-immersive.js'],         // 沉浸入口模块依赖 Stage 帧门
  ['creative-stage.js', 'stage-immersive.js'], // 舞台坞读 CreativeStage.scenes/preset
  ['stage-immersive.js', 'app.js'],
  ['creative-stage.js', 'app.js'],              // app.js 调 CreativeStage.init()
  ['stage.js', 'app.js'],
  ['vendor/qrcode.js', 'online-login.js']      // 扫码弹窗读 window.qrcode
];

REQUIRE_BEFORE.forEach((pair) => {
  const a = linkedJs.indexOf(pair[0]);
  const b = linkedJs.indexOf(pair[1]);
  if (a < 0 || b < 0) return;
  ok(a < b, `${pair[0]} 排在 ${pair[1]} 之前`);
});

ok(linkedJs[linkedJs.length - 1] === 'app.js', 'app.js 是最后一个脚本（它负责启动）');
ok(linkedJs.indexOf('creative.css') < 0 && linkedCss.indexOf('creative.css') >= 0,
  'creative.css 走 <link> 而不是 <script>');
ok(linkedCss.indexOf('creative.css') > linkedCss.indexOf('style.css'),
  'creative.css 排在 style.css 之后（令牌覆盖顺序）');

// ---------------------------------------------------------------------------
// 5. 面板骨架：app.js 会按 id 取这些节点，缺一个就是运行时 null
// ---------------------------------------------------------------------------

console.log('\n工坊面板骨架');
['workshop', 'ws-close', 'ws-tabs', 'ws-body', 'ws-toast'].forEach((id) => {
  ok(new RegExp('id="' + id + '"').test(indexHtml), `index.html 存在 #${id}`);
});
['workshop-btn', 'set-workshop-btn'].forEach((id) => {
  ok(new RegExp('id="' + id + '"').test(indexHtml), `index.html 存在 #${id}`);
});

// app.js 里 $('xxx') 取的 id 都应该能在 index.html 找到。漏掉的会静默变 null，
// 然后在某个事件回调里抛 TypeError —— 而那个回调平时根本不会被触发。
const appJs = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
const ids = new Set();
const idRe = /\$\('([a-zA-Z0-9_-]+)'\)/g;
while ((m = idRe.exec(appJs)) !== null) ids.add(m[1]);
const missing = [];
ids.forEach((id) => {
  if (!new RegExp('id="' + id + '"').test(indexHtml)) missing.push(id);
});
ok(missing.length === 0,
  'app.js 取用的每个 id 都存在于 index.html' + (missing.length ? ' → 缺：' + missing.join(', ') : ''));

// ---------------------------------------------------------------------------
// 6. 图标库：每个 <use href="#i-*"> 都必须有对应 symbol
// ---------------------------------------------------------------------------

console.log('\n图标库');
const spriteStart = indexHtml.indexOf('<svg id="icon-sprite"');
const spriteEnd = indexHtml.indexOf('</svg>', spriteStart);
const spriteBlock = spriteStart >= 0 && spriteEnd > spriteStart
  ? indexHtml.slice(spriteStart, spriteEnd + 6) : '';
const symbolIds = new Set();
let symbolMatch;
const symbolRe = /<symbol\s+id="(i-[^"]+)"/g;
while ((symbolMatch = symbolRe.exec(spriteBlock)) !== null) symbolIds.add(symbolMatch[1]);

ok(symbolIds.size >= 20, `图标 symbol 数量合理（${symbolIds.size}）`);
ok(symbolIds.has('i-play') && symbolIds.has('i-close') && symbolIds.has('i-settings'),
  '核心图标已定义');

const iconRefs = [];
fs.readdirSync(WEB).filter((f) => f.endsWith('.js')).forEach((f) => {
  const text = fs.readFileSync(path.join(WEB, f), 'utf8');
  let ref;
  const refRe = /<use\s+href="#(i-[^"]+)"/g;
  while ((ref = refRe.exec(text)) !== null) iconRefs.push({ file: f, id: ref[1] });
});
let useMatch;
const useRe = /<use\s+href="#(i-[^"]+)"/g;
while ((useMatch = useRe.exec(indexHtml)) !== null) {
  iconRefs.push({ file: 'index.html', id: useMatch[1] });
}
ok(iconRefs.length >= 30, `图标引用数量合理（${iconRefs.length}）`);
iconRefs.forEach((ref) => {
  ok(symbolIds.has(ref.id), `${ref.file} 引用的 ${ref.id} 已定义`);
});

// 一个控件只能有一个主人。同一个 id 在两个文件里各绑一次 click，一次点击就会
// 翻两遍开关 —— 症状是"按钮没反应"，而两边代码单看都对。2026-09-19 顶栏的
// 「打开创意工坊」就是这么坏的：workshop.js 的 init 和 app.js 的 initCreative
// 都绑了 #workshop-btn 的 click。
{
  // app.js 的 ui 映射：key -> id。绑定大多写成 ui.workshopBtn.addEventListener，
  // 不解这一层就会漏掉最典型的那一类重复。
  const keyToId = {};
  let km;
  const kre = /(\w+)\s*:\s*(?:\$\(|document\.getElementById\()\s*['"]([\w-]+)['"]/g;
  while ((km = kre.exec(appJs)) !== null) keyToId[km[1]] = km[2];

  const EVT = 'click|change|input|keydown|keyup|submit|pointerdown|blur|focus';
  // 取元素和绑事件常常是两行（`var btn = $('x'); if (btn) btn.addEventListener(...)`），
  // 所以先按文件收一遍"局部别名 -> id"，再在绑定点上解引用。
  // 两种写法各用一条正则：合并成一条的话分组编号会互相错位，读起来也费劲。
  const aliasRe = new RegExp(
    "(?:var|let|const)\\s+(\\w+)\\s*=\\s*(?:\\$\\(|document\\.getElementById\\()\\s*['\"]([\\w-]+)['\"]", 'g');
  const directRe = new RegExp(
    "(?:\\$\\(|getElementById\\()\\s*['\"]([\\w-]+)['\"]\\s*\\)\\s*\\.\\s*" +
    "(?:addEventListener\\(\\s*['\"](" + EVT + ")['\"]|\\bon(" + EVT + ")\\s*=)", 'g');
  const aliasBindRe = new RegExp(
    "\\b(?:ui\\.)?(\\w+)\\s*\\.\\s*(?:addEventListener\\(\\s*['\"](" + EVT + ")['\"]|\\bon(" + EVT + ")\\s*=)", 'g');

  const owners = new Map();          // "id#event#阶段" -> Set("file:line")
  const note = (id, evt, where, capture) => {
    if (!id || !evt) return;
    const key = id + '#' + evt + '#' + (capture ? 'capture' : 'bubble');
    if (!owners.has(key)) owners.set(key, new Set());
    owners.get(key).add(where);
  };
  fs.readdirSync(WEB).filter((f) => f.endsWith('.js')).forEach((f) => {
    const lines = fs.readFileSync(path.join(WEB, f), 'utf8').split('\n');
    const alias = {};
    lines.forEach((line) => {
      let am;
      aliasRe.lastIndex = 0;
      while ((am = aliasRe.exec(line)) !== null) alias[am[1]] = am[2];
    });
    lines.forEach((line, i) => {
      if (!/addEventListener|\son[a-z]+\s*=/.test(line)) return;
      const where = f + ':' + (i + 1);
      // 捕获阶段的那个 handler 通常是"旁观者"（补一句提示、顺手刷新别处），
      // 与冒泡阶段的正主并存是有意的 —— #sc-reset 就是这样。只有同阶段重复
      // 才是"一次点击翻两遍开关"。判阶段看行尾的 `, true)`，写成多行的调用
      // 会被当成冒泡，那种情况宁可漏报也不误报。
      const capture = /addEventListener\((?:[^()]|\([^()]*\))*?,\s*true\s*\)/.test(line);
      let bm;
      directRe.lastIndex = 0;
      while ((bm = directRe.exec(line)) !== null) note(bm[1], bm[2] || bm[3], where, capture);
      aliasBindRe.lastIndex = 0;
      while ((bm = aliasBindRe.exec(line)) !== null) {
        note(alias[bm[1]] || keyToId[bm[1]], bm[2] || bm[3], where, capture);
      }
    });
  });
  const shared = [];
  owners.forEach((where, key) => {
    const files = new Set([...where].map((w) => w.split(':')[0]));
    if (files.size > 1) shared.push(key + ' ← ' + [...where].join(', '));
  });
  ok(shared.length === 0,
    '没有哪个控件被两个文件各绑一次同一阶段的同一事件'
    + (shared.length ? ' → ' + shared.join('；') : ''));
}

// ---------------------------------------------------------------------------

console.log('\n' + '─'.repeat(56));
if (failures) {
  console.error(`前端资源接线检查：${checks - failures}/${checks} 通过，${failures} 项失败`);
  process.exit(1);
}
console.log(`前端资源接线检查：${checks}/${checks} 全部通过`);
