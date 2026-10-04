#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 插件形态下站内资源 URL 的契约检查（零依赖、不触网、不开浏览器）。
//
//   node scripts/check-plugin-assets.js
//
// 为什么要单独钉这一条：壁纸与平台图标 404 这件事，在独立形态下永远是对的
// （根相对路径直接命中服务端），在 dev-host 下也看不出来（它的 CSP 本来就把
// 这些资源挡了），只有真 dbx 才暴露。而暴露出来的样子还特别有迷惑性——界面
// 完整渲染、设置页写着「壁纸已铺底」，只有背景是空的、图标是碎的。
//
// 真正的坑在宿主那边：dbx 注入的 <base href> 是
// `<origin>/<插件id>/<entryDirectory>/`，entryDirectory 由入口 HTML 里**第一个
// 带目录的资源引用**推出（apps/desktop/src/lib/plugins/pluginUiHtmlCache.ts:79，
// 那套推导假设产物是打包过的：chunk 全在同一个子目录里）。本插件是零构建的多
// 目录布局，第一个引用 style.css 在根级、推不出目录，宿主便继续往后找，抓到
// `stage-themes/starfall.css`，base 成了 `.../stage-themes/`。于是根相对的
// `/wallpapers/x.jpg` 被解析成 `.../stage-themes/wallpapers/x.jpg`——404。
//
// 资源协议的根其实就是 ui 根，所以 host.js 只取 origin + 第一段（插件 id）。
// 这里钉五件事：
//
//   1. **两种宿主的 base 形状都要对**：WebView2 把自定义协议映射成
//      http(s) 子域，WKWebView/webkit2gtk 用原生 `dbx-plugin://`；后者的
//      `new URL().origin` 是字符串 "null"，只能靠正则拆。
//   2. **多算出来的那段必须被丢掉**，且 entryDirectory 本来就为空时是恒等的。
//   3. **独立形态必须保持恒等**——反代带前缀时根相对路径才是对的
//      （theme-studio.js 的 WALL_BASE 注释记着那个修过的 bug）。
//   4. **声明出来的资源真的在包里**：路径写错和 base 算错的表象一模一样，
//      只有对着磁盘核一遍才分得清。
//   5. **音源直链的图一律经 HertzCovers 代理**：沙箱 CSP 的 img-src 不放行
//      第三方 https，直连就是一张空图；委派那行写错还测不出来（见该节注释）。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'plugin', 'ui');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const HOST_JS = read(path.join(WEB, 'host.js'));

const PLUGIN_ID = 'io.github.mmusic-studio.hertz-studio';

let failures = 0;
let checks = 0;
function ok(cond, label) {
  checks += 1;
  if (!cond) { failures += 1; console.error('  X ' + label); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}
function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// 沙箱：host.js 是个 IIFE，只碰 window / document / localStorage
// ---------------------------------------------------------------------------

/// 在指定 baseURI 与「是否跑在 dbx 里」的前提下加载一遍 host.js。
function loadHost({ baseURI, inDbx }) {
  const store = new Map();
  const sandbox = {
    URL,
    Map,
    Promise,
    setTimeout,
    clearTimeout,
    console: { warn: () => {}, log: () => {}, error: () => {} },
    document: { baseURI },
  };
  if (inDbx) {
    sandbox.window = sandbox;
    sandbox.dbxPlugin = { storage: { get: () => Promise.resolve(null), set: () => Promise.resolve() } };
    sandbox.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    };
  } else {
    sandbox.window = sandbox;
    // 独立形态：原生 localStorage 可用（host.js 探测到就不装替身）
    sandbox.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(HOST_JS, sandbox, { filename: 'host.js' });
  return sandbox;
}

const assetUrl = (opts, p) => loadHost(opts).hertzHost.assetUrl(p);

// ---------------------------------------------------------------------------
// 1. 两种宿主的 base 形状
// ---------------------------------------------------------------------------

function checkWebView2Base() {
  section('WebView2（自定义协议映射成 http 子域）');
  const base = `http://dbx-plugin.localhost/${PLUGIN_ID}/stage-themes/`;
  const opts = { baseURI: base, inDbx: true };

  eq(assetUrl(opts, '/wallpapers/evening-16.jpg'),
    `http://dbx-plugin.localhost/${PLUGIN_ID}/wallpapers/evening-16.jpg`,
    '壁纸解析到 ui 根下的 wallpapers/');
  eq(assetUrl(opts, '/platform-icons/netease.png'),
    `http://dbx-plugin.localhost/${PLUGIN_ID}/platform-icons/netease.png`,
    '平台图标解析到 ui 根下的 platform-icons/');
  eq(assetUrl(opts, '/skins/skins.css'),
    `http://dbx-plugin.localhost/${PLUGIN_ID}/skins/skins.css`,
    '皮肤 CSS 解析到 ui 根下的 skins/');
  eq(assetUrl(opts, '/stanza/stanza.css'),
    `http://dbx-plugin.localhost/${PLUGIN_ID}/stanza/stanza.css`,
    '歌词模块资源解析到 ui 根下的 stanza/');
  ok(!assetUrl(opts, '/wallpapers/x.jpg').includes('stage-themes'),
    '宿主多算出来的 entryDirectory（stage-themes）没有留在结果里');
}

function checkNativeSchemeBase() {
  section('WKWebView / webkit2gtk（原生 dbx-plugin:// 协议）');
  const base = `dbx-plugin://localhost/${PLUGIN_ID}/stage-themes/`;
  const got = assetUrl({ baseURI: base, inDbx: true }, '/wallpapers/evening-16.jpg');
  eq(got, `dbx-plugin://localhost/${PLUGIN_ID}/wallpapers/evening-16.jpg`,
    '自定义协议下同样解析到 ui 根');
  ok(!got.startsWith('null'), '没有退化成 "null/..."（非特殊协议的 URL.origin 是字符串 "null"）');
  ok(!got.includes('stage-themes'), '自定义协议下也没有留下 entryDirectory');
}

// ---------------------------------------------------------------------------
// 2. entryDirectory 为空时恒等（宿主若修好了推导，这里不能反过来算错）
// ---------------------------------------------------------------------------

function checkIdempotent() {
  section('宿主 base 本来就指到 ui 根时');
  const base = `http://dbx-plugin.localhost/${PLUGIN_ID}/`;
  eq(assetUrl({ baseURI: base, inDbx: true }, '/wallpapers/evening-16.jpg'),
    `http://dbx-plugin.localhost/${PLUGIN_ID}/wallpapers/evening-16.jpg`,
    'entryDirectory 为空时结果不变（这个修正是幂等的）');

  // 插件 id 里带点号，不能被当成扩展名/多余分隔符处理掉
  ok(assetUrl({ baseURI: base, inDbx: true }, '/wallpapers/x.jpg').includes(`/${PLUGIN_ID}/`),
    '带点号的插件 id 完整保留在路径第一段');
}

// ---------------------------------------------------------------------------
// 3. 独立形态必须恒等
// ---------------------------------------------------------------------------

function checkStandalone() {
  section('独立形态（不经插件宿主）');
  const opts = { baseURI: 'http://127.0.0.1:7634/', inDbx: false };
  eq(assetUrl(opts, '/wallpapers/evening-16.jpg'), '/wallpapers/evening-16.jpg',
    '根相对路径原样返回（反代带前缀时这才是对的）');
  eq(assetUrl(opts, 'wallpapers/evening-16.jpg'), 'wallpapers/evening-16.jpg',
    '不以 / 开头的引用原样返回');
  eq(loadHost(opts).hertzHost.isDbx, false, 'isDbx 为 false，传输层会走 HTTP');

  const dbxOpts = { baseURI: `http://dbx-plugin.localhost/${PLUGIN_ID}/stage-themes/`, inDbx: true };
  eq(loadHost(dbxOpts).hertzHost.isDbx, true, '插件形态下 isDbx 为 true');
}

// ---------------------------------------------------------------------------
// 4. baseURI 只在 host.js 里用一次
// ---------------------------------------------------------------------------

function checkSingleOwner() {
  section('差异只收敛在 host.js 一处');
  const offenders = [];
  for (const name of fs.readdirSync(WEB)) {
    if (!name.endsWith('.js') || name === 'host.js') continue;
    const text = read(path.join(WEB, name));
    // 只算真代码：去掉整行注释后还剩 document.baseURI 的才算
    const code = text.split('\n').filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join('\n');
    if (code.includes('document.baseURI')) offenders.push(name);
  }
  eq(offenders.join(','), '', 'host.js 之外没有直接读 document.baseURI（否则 base 算错时又漏一处）');
  ok(/function assetBase\(/.test(HOST_JS), 'host.js 里有 assetBase()');
  ok(/new URL\(url\.slice\(1\), assetBase\(\)\)/.test(HOST_JS),
    'assetUrl 用 assetBase() 而不是裸 document.baseURI');

  // 各模块的 assetUrl 都必须转调 hertzHost，不能自己另写一份。
  // stage3d.js 用的是 global.hertzHost（那个文件里 global 就是 window），
  // 所以这里认的是「转调 hertzHost.assetUrl、拿不到就恒等」这个不变量，不是拼写。
  for (const name of ['theme-studio.js', 'stage3d.js', 'online.js']) {
    const text = read(path.join(WEB, name));
    ok(/(?:window|global)\.hertzHost\s*\?\s*(?:window|global)\.hertzHost\.assetUrl\(url\)\s*:\s*url/.test(text),
      `${name} 的 assetUrl 转调 hertzHost.assetUrl`);
  }
}

// ---------------------------------------------------------------------------
// 5. 声明出来的资源真的在包里
// ---------------------------------------------------------------------------

/// 从 theme-studio.js 的壁纸目录里抠出文件名。
function wallpaperIds() {
  const text = read(path.join(WEB, 'theme-studio.js'));
  const block = text.slice(text.indexOf('var WALLPAPERS'), text.indexOf('var WALL_BASE'));
  const ids = [];
  const re = /id:\s*'([^']+\.jpg)'/g;
  let m;
  while ((m = re.exec(block))) ids.push(m[1]);
  return ids;
}

function checkDeclaredAssetsExist() {
  section('声明的资源在磁盘上真的存在');

  const ids = wallpaperIds();
  ok(ids.length >= 10, `壁纸目录解析出 ${ids.length} 条（>=10）`);
  const missingWalls = ids.filter((id) => !fs.existsSync(path.join(WEB, 'wallpapers', id)));
  eq(missingWalls.join(','), '', '每张声明的壁纸都在 plugin/ui/wallpapers/ 下');

  const icons = [];
  for (const name of fs.readdirSync(WEB)) {
    if (!name.endsWith('.js')) continue;
    const text = read(path.join(WEB, name));
    const re = /\/platform-icons\/([A-Za-z0-9_.-]+\.(?:png|svg))/g;
    let m;
    while ((m = re.exec(text))) icons.push(m[1]);
  }
  ok(icons.length >= 4, `平台图标引用解析出 ${icons.length} 处（>=4）`);
  const missingIcons = Array.from(new Set(icons)).filter((n) => !fs.existsSync(path.join(WEB, 'platform-icons', n)));
  eq(missingIcons.join(','), '', '每个引用的平台图标都在 plugin/ui/platform-icons/ 下');

  // 这些目录会被打进 .dbxp（dbx-plugin.toml 的 include = ["assets","ui"]），
  // 少一个就是运行时 404，而构建期一声不响。
  for (const dir of ['wallpapers', 'platform-icons', 'skins', 'stanza', 'stage-themes']) {
    ok(fs.existsSync(path.join(WEB, dir)) && fs.readdirSync(path.join(WEB, dir)).length > 0,
      `plugin/ui/${dir}/ 存在且非空`);
  }
}

// ---------------------------------------------------------------------------
// 6. 远程封面一律经 HertzCovers 代理，且委派没写成递归
// ---------------------------------------------------------------------------

/// 找出所有自带 applyBg / applyImg 包装的模块。这两个包装是"远程封面在插件
/// 沙箱里画不出来"的统一出口：真 app 里 window.HertzCovers 一定存在，所以走的
/// 永远是委派分支——而契约脚本的沙箱里没有它，只跑到回落分支。于是委派那行
/// 写错（`applyImg(img, url)` 调自己而不是 `HertzCovers.applyImg(...)`）在
/// 沙箱里静默无恙，在真 app 里是 Maximum call stack size exceeded。
function checkCoverDelegation() {
  section('远程封面委派：走 HertzCovers，且没有写成自己调自己');

  const files = fs.readdirSync(WEB).filter((n) => n.endsWith('.js'))
    .filter((n) => /function applyBg\(|function applyImg\(/.test(read(path.join(WEB, n))));
  ok(files.length >= 5, `找到 ${files.length} 个自带封面包装的模块（>=5）`);

  for (const name of files) {
    const text = read(path.join(WEB, name));
    for (const fn of ['applyBg', 'applyImg']) {
      if (!new RegExp('function ' + fn + '\\(').test(text)) continue;
      ok(text.includes('window.HertzCovers.' + fn + '('),
        `${name} 的 ${fn} 委派给 HertzCovers.${fn}（不是调自己）`);
      ok(!new RegExp('HertzCovers\\)\\s*\\{\\s*' + fn + '\\(').test(text),
        `${name} 的 ${fn} 没有递归调用自己`);
    }
  }

  // 绕过包装直接写 background-image 的地方。独立形态看不出问题（远程 URL 直接
  // 就能画），插件形态是一整面空图 + 一串 CSP 报错。
  //
  // 白名单里两处画的都是**站内**资源：app.js 的 applyCoverBg 是代理落地后的
  // 终点，theme-studio.js 铺的是经 assetUrl 补全的壁纸，都在 img-src 放行范围
  // 内，不需要再过代理。包装自己的回落分支写成三元式（`= url ? 'url("' … : ''`），
  // 不落在下面这两个形状里，所以不用排除。
  const RAW_BG_ALLOWED = new Set(['app.js', 'theme-studio.js']);
  const bypass = fs.readdirSync(WEB).filter((n) => n.endsWith('.js') && !RAW_BG_ALLOWED.has(n))
    .filter((n) => /style\.backgroundImage\s*=\s*('url\("'|`url\("\$\{)/.test(read(path.join(WEB, n))));
  eq(bypass.join(','), '', '没有模块绕过 applyBg 直接写 background-image');

  // innerHTML 模板里的空 href/src：解析瞬间就按 <base> 解析成插件 ui 的**目录**
  // URL 去加载——插件形态下 opaque origin 直接拒（"Unsafe attempt to load" 刷屏），
  // 独立形态是一次 404。引用应当先建不带 href 的节点、再 setAttribute 挂上。
  const emptyRef = fs.readdirSync(WEB).filter((n) => n.endsWith('.js') && /(href|src)=""/.test(read(path.join(WEB, n))));
  eq(emptyRef.join(','), '', '没有空 href/src 的 innerHTML 模板');
}

(async () => {
  checkWebView2Base();
  checkNativeSchemeBase();
  checkIdempotent();
  checkStandalone();
  checkSingleOwner();
  checkDeclaredAssetsExist();
  checkCoverDelegation();

  console.log('\n' + '─'.repeat(60));
  if (failures) {
    console.error(`插件资源 URL 契约检查：${checks} 项，${failures} 项失败`);
    process.exit(1);
  }
  console.log(`插件资源 URL 契约检查：${checks}/${checks} 全部通过`);
})();
