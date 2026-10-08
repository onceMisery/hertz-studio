#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// OBS 浮层素材通道（obs-css.js）的契约检查（零依赖、无头、不触网）。
//
//   node scripts/check-obs-css.js
//
// 这条通道的两端隔得很远：生产者在应用设置页（把用户选的图压成 data URL、拼一段
// CSS 给用户粘进 OBS），消费者在 OBS 注入那段 CSS 之后的浮层页（用 getComputedStyle
// 读回来）。中间只有**变量名**与 `url("data:…")` 这个形状，任何一端改了另一边都不会
// 报错 —— 只会表现为「选完图浮层什么都没变」。所以这里把约定与两端接线都钉住。
//
// 覆盖：变量名与形状、片段的构成与空态、回读的正负例、编码路径（缩放/底色/清理/
// 拒绝），以及 index.html、overlay.html、main.rs 三处接线与四个方位的类名一致。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'plugin', 'ui');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const OBS_JS = read(path.join(WEB, 'obs-css.js'));
const INDEX_HTML = read(path.join(WEB, 'index.html'));
const OVERLAY_HTML = read(path.join(WEB, 'overlay.html'));
const MAIN_RS = read(path.join(ROOT, 'crates', 'hertz-studio', 'src', 'assets.rs'));

let failures = 0;
let checks = 0;
function ok(cond, label) {
  checks += 1;
  if (!cond) { failures += 1; console.error('  X ' + label); }
}
function section(name) { console.log('\n' + name); }

// ---------------------------------------------------------------------------
// 沙箱：按需注入 document / Image / URL / getComputedStyle
//
// obs-css.js 只在函数体里碰这些宿主对象，所以装载时给一个空 window 就够；
// 要跑某一条路径时再把它需要的那几个桩塞进去。
// ---------------------------------------------------------------------------

function loadObsCss(host) {
  const sandbox = Object.assign({ window: {}, console: console }, host || {});
  vm.createContext(sandbox);
  vm.runInContext(OBS_JS, sandbox, { filename: 'obs-css.js' });
  return sandbox.window.ObsCss;
}

/// 编码路径的桩：一张 width×height 的图、一个记事的 canvas。
/// 断言点都在 stub 记录里（缩放后的尺寸、有没有铺底、有没有 revoke）。
function encodeHarness(options) {
  const opts = options || {};
  const state = { canvas: null, fills: 0, mime: null, quality: null, revoked: 0 };
  const host = {
    URL: {
      createObjectURL: () => 'blob:stub',
      revokeObjectURL: () => { state.revoked += 1; }
    },
    Image: function () {
      const image = this;
      image.naturalWidth = opts.width || 0;
      image.naturalHeight = opts.height || 0;
      Object.defineProperty(image, 'src', {
        set() { setTimeout(() => (opts.unreadable ? image.onerror() : image.onload()), 0); }
      });
    },
    document: {
      documentElement: {},
      createElement(tag) {
        if (tag !== 'canvas') throw new Error('unexpected element: ' + tag);
        state.canvas = {
          width: 0,
          height: 0,
          getContext: () => ({
            fillStyle: '',
            fillRect: () => { state.fills += 1; },
            drawImage: () => {}
          }),
          toDataURL: (mime, quality) => {
            state.mime = mime;
            state.quality = quality;
            return 'data:' + mime + ';base64,' + 'A'.repeat(opts.payload || 16);
          }
        };
        return state.canvas;
      }
    },
    setTimeout: setTimeout,
    getComputedStyle: () => ({ getPropertyValue: () => '' })
  };
  return { api: loadObsCss(host), state: state };
}

/// 消费侧桩：模拟 OBS 把一段 CSS 注进页面后的 getComputedStyle。
function styleHarness(declarations) {
  const values = declarations || {};
  return loadObsCss({
    document: { documentElement: { style: { setProperty: () => {} } } },
    getComputedStyle: () => ({ getPropertyValue: (name) => values[name] || '' })
  });
}

const BG = 'data:image/jpeg;base64,QkfH';
const LOGO = 'data:image/png;base64,TG9nbw==';

// ---------------------------------------------------------------------------
// 1. 变量名与形状
// ---------------------------------------------------------------------------

section('变量名（两端唯一的耦合点）');
const api = loadObsCss({ getComputedStyle: () => ({ getPropertyValue: () => '' }) });
ok(api.VAR_BG === '--hz-obs-bg', 'VAR_BG 就是浮层要读的那个名字');
ok(api.VAR_LOGO === '--hz-obs-logo', 'VAR_LOGO 就是浮层要读的那个名字');
ok(api.VAR_LOGO_POS === '--hz-obs-logo-pos', 'VAR_LOGO_POS 就是浮层要读的那个名字');
ok(api.LOGO_POSITIONS.join(',') === 'top-right,top-left,bottom-right,bottom-left',
  '四个方位与 overlay.html 的类名一一对应');
ok(api.LOGO_POS_DEFAULT === 'top-right', '不写方位时默认右上角');

// ---------------------------------------------------------------------------
// 2. 片段：空态、构成、以及「片段能被自己读回来」
// ---------------------------------------------------------------------------

section('CSS 片段');
ok(api.buildSnippet({}) === null, '没有任何素材时回 null（调用方据此禁用按钮）');
ok(api.buildSnippet({ background: null, logo: null }) === null, '两个槽位都为 null 同样回 null');
ok(api.buildSnippet(null) === null, '连对象都没给也不炸');

const onlyBg = api.buildSnippet({ background: BG });
ok(onlyBg.indexOf(api.VAR_BG + ': url("' + BG + '")') >= 0, '背景图写成了 url("data:…") 的形状');
ok(onlyBg.indexOf(api.VAR_LOGO + ':') < 0, '没配的槽位不写进片段（别塞空规则）');
ok(/body\s*\{[^}]*background-color:\s*rgba\(0, 0, 0, 0\)/.test(onlyBg), '带上 OBS 的透明 body 复位');

const both = api.buildSnippet({ background: BG, logo: LOGO });
ok(both.indexOf(api.VAR_LOGO + ': url("' + LOGO + '")') >= 0, '台标也写进去');
ok(both.indexOf(api.VAR_LOGO_POS) >= 0, '片段里给出改方位的提示（注释形式）');
ok(both.indexOf(':root') >= 0, '两个变量都挂在 :root 上（浮层读 documentElement）');

// ---------------------------------------------------------------------------
// 3. 回读：正例与负例
// ---------------------------------------------------------------------------

section('回读（getComputedStyle）');
ok(api.parseDataUrl('url("' + BG + '")') === BG, '双引号形式取得到');
ok(api.parseDataUrl("url('" + BG + "')") === BG, '单引号形式取得到');
ok(api.parseDataUrl('url(' + BG + ')') === BG, '无引号形式取得到');
for (const junk of ['', null, undefined, '#ffffff', 'url(photo.png)', 'url("https://x/y.jpg")', 'not css at all']) {
  ok(api.parseDataUrl(junk) === null, '不是 data URL 就回 null：' + JSON.stringify(junk));
}

const empty = loadObsCss({
  document: { documentElement: {} },
  getComputedStyle: () => ({ getPropertyValue: () => '' })
}).readAssets();
ok(empty.background === null && empty.logo === null, '没注入 CSS 时两个槽位都是 null');
ok(empty.logoPos === 'top-right', '没注入方位时回默认值');

const injected = styleHarness({
  '--hz-obs-bg': 'url("' + BG + '")',
  '--hz-obs-logo': ' url(\'' + LOGO + '\') ',
  '--hz-obs-logo-pos': 'bottom-left'
}).readAssets();
ok(injected.background === BG, '背景图原样读回来');
ok(injected.logo === LOGO, '台标原样读回来（值首尾有空格也要认）');
ok(injected.logoPos === 'bottom-left', '方位读得回来');

const badPos = styleHarness({
  '--hz-obs-logo': 'url("' + LOGO + '")',
  '--hz-obs-logo-pos': 'middle-of-nowhere'
}).readAssets();
ok(badPos.logoPos === 'top-right', '手改坏的方位回落到默认值，而不是把类名拼成垃圾');

// ---------------------------------------------------------------------------
// 4. 编码路径
// ---------------------------------------------------------------------------

section('编码（缩放 / 底色 / 清理 / 拒绝）');

(async () => {
  // 背景图：长边 4000 的图应被缩到 1280，且 JPEG 路径必须先铺一层深色底。
  const big = encodeHarness({ width: 4000, height: 2000 });
  const bgUrl = await big.api.encode('background', { type: 'image/jpeg', name: 'a.jpg' });
  ok(bgUrl.indexOf('data:image/jpeg;base64,') === 0, '背景图编成 JPEG data URL');
  ok(big.state.canvas.width === 1280 && big.state.canvas.height === 640,
    `长边缩到 1280（实得 ${big.state.canvas.width}x${big.state.canvas.height}）`);
  ok(big.state.fills > 0, 'JPEG 路径先铺了底色（透明 PNG 不会变成黑边）');
  ok(big.state.revoked === 1, 'object URL 用完就 revoke（否则整页图片常驻内存）');

  // 小图不放大：scale 上限是 1。
  const small = encodeHarness({ width: 30, height: 20 });
  await small.api.encode('background', { type: 'image/png', name: 's.png' });
  ok(small.state.canvas.width === 30 && small.state.canvas.height === 20, '小图不放大');

  // 台标：512 长边 + PNG（要保留透明通道），且不铺底色。
  const logo = encodeHarness({ width: 900, height: 300 });
  const logoUrl = await logo.api.encode('logo', { type: 'image/png', name: 'l.png' });
  ok(logoUrl.indexOf('data:image/png;base64,') === 0, '台标编成 PNG data URL');
  ok(logo.state.canvas.width === 512 && logo.state.canvas.height === 171,
    `台标长边缩到 512（实得 ${logo.state.canvas.width}x${logo.state.canvas.height}）`);
  ok(logo.state.fills === 0, 'PNG 路径不铺底色（透明要留着）');

  // 拒绝路径：非图片、读不出来、压完仍然过大、未知槽位。四条都要给出能读的原因。
  //
  // 每条都包成 thunk 再调：Promise.reject 是同步产生的，四条一起预生成会让后几条
  // 在本轮微任务里无人接管，Node 直接按 unhandled rejection 崩掉。
  //
  // 判据用 error.message 而不是 `instanceof Error`：这些错误由沙箱（另一个 realm）
  // 里的构造函数产生，跨 realm 的 instanceof 恒为 false。
  const rejects = [
    [() => big.api.encode('background', { type: 'text/plain', name: 'a.txt' }), '非图片文件'],
    [() => encodeHarness({ width: 10, height: 10, unreadable: true }).api.encode('background', { type: 'image/png' }), '读不出来的图'],
    [() => encodeHarness({ width: 10, height: 10, payload: api.MAX_DATA_URL_CHARS + 16 }).api.encode('logo', { type: 'image/png' }), '压完仍然过大'],
    [() => big.api.encode('nope', { type: 'image/png' }), '未知槽位']
  ];
  for (const [make, label] of rejects) {
    let reason = null;
    try { await make(); } catch (err) { reason = err; }
    ok(!!reason && typeof reason.message === 'string' && reason.message.length > 0,
      label + ' 会被拒绝，且理由不是空的');
  }

  // -------------------------------------------------------------------------
  // 5. 三处接线
  // -------------------------------------------------------------------------

  section('接线');
  ok(/<script defer src="obs-css\.js"><\/script>/.test(INDEX_HTML), 'index.html 引了 obs-css.js');
  const resource = require('./ui-assets').readAssets().find(a => a.path === '/obs-css.js');
  ok(resource && resource.name === 'OBS_CSS_JS' && resource.mime === 'JS', 'OBS 脚本由资源目录统一挂载并参与指纹');

  // 浮层页是同步 <script src>，必须排在它自己的内联脚本之前：内联脚本一跑就要读
  // window.ObsCss，晚一步就是「素材永远读不到」。
  const overlayLoad = OVERLAY_HTML.indexOf('<script src="/obs-css.js"></script>');
  const overlayInline = OVERLAY_HTML.indexOf("'use strict';\n(function () {");
  ok(overlayLoad >= 0, 'overlay.html 引了 /obs-css.js');
  ok(overlayLoad >= 0 && overlayLoad < overlayInline, '它在浮层自己的脚本之前同步加载');
  ok(OVERLAY_HTML.indexOf('ObsCss.readAssets()') >= 0, '浮层确实调用 readAssets 取回素材');
  ok(OVERLAY_HTML.indexOf('window.ObsCss ?') >= 0 && OVERLAY_HTML.indexOf('if (!assets) return;') >= 0,
    '浮层对「模块没加载出来 / 没注入素材」做了判空（缺了不该整页报错）');

  // 四个方位的类名必须都在浮层样式里，否则 --hz-obs-logo-pos 改了位置但看起来没变。
  for (const pos of api.LOGO_POSITIONS) {
    ok(OVERLAY_HTML.indexOf('.obs-logo.' + pos) >= 0, '浮层样式里有 .obs-logo.' + pos);
  }

  console.log('\n' + '─'.repeat(56));
  if (failures) {
    console.error(`OBS 素材通道检查：${checks - failures}/${checks} 通过，${failures} 项失败`);
    process.exit(1);
  }
  console.log(`OBS 素材通道检查：${checks}/${checks} 全部通过`);
})();
