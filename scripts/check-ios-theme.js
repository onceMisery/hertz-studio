#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// iOS 浅色主题的契约检查（零依赖、不触网）。
//
//   node scripts/check-ios-theme.js
//
// 为什么浅色主题要单独钉一份契约，而不是并进 check-css-tokens：
//
// 浅色主题的失败**不会报错、不会崩、也不会缺元素**。它只是「白叠白」——
// style.css 的整套玻璃体系是为暗底写的（面板靠叠 rgba(255,255,255,.03~.18)
// 浮起来、描边与内高光全是白叠层）。底色一翻成浅灰白，这批叠层就等于
// 没叠：卡片糊成一片、描边消失、进度条轨道看不见、弹窗是块白斑。
// 页面一切正常，只是**看不见**。这种静默降级只能靠断言兜住。
//
// 四条各钉一处：
//   1. **表面令牌翻没翻**。浅色主题必须自带那批「暗叠层」覆盖。
//   2. **对比度**。每个前景/底色组合按 WCAG AA 反推过，且不是 iOS 原色
//      （systemGreen #34C759 在浅底上只有 2.1:1，systemRed #FF3B30 3.2:1）。
//   3. **能回退**。切回暗色主题后这些覆盖必须消失、回到 style.css 的暗色
//      默认——否则「浅色残留」会污染其它 16 套主题。
//   4. **接线**。编进二进制 + 进了主题目录。

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'plugin', 'ui');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const THEMES_JS = read(path.join(WEB, 'themes.js'));
const STYLE_CSS = read(path.join(WEB, 'style.css'));
const MAIN_RS = read(path.join(ROOT, 'crates', 'hertz-studio', 'src', 'main.rs'));

let failures = 0;
let checks = 0;
function ok(cond, label) {
  checks += 1;
  if (!cond) { failures += 1; console.error('  X ' + label); }
}
function section(name) { console.log('\n' + name); }

// --- 把 ios-light 的 tokens 抠出来（沙箱里跑 themes.js 太重，这里静态取） ---

function tokensOfTheme(id) {
  const at = THEMES_JS.indexOf("id: '" + id + "'");
  if (at < 0) return null;
  const open = THEMES_JS.indexOf('{', THEMES_JS.indexOf('tokens:', at));
  // 花括号配平，取出 tokens 对象字面量。
  let depth = 0;
  let end = open;
  for (let i = open; i < THEMES_JS.length; i += 1) {
    if (THEMES_JS[i] === '{') depth += 1;
    else if (THEMES_JS[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const body = THEMES_JS.slice(open, end + 1);
  const out = {};
  const re = /'(--[a-z0-9-]+)':\s*'([^']*)'/gi;
  let m;
  while ((m = re.exec(body))) out[m[1]] = m[2];
  return out;
}

const T = tokensOfTheme('ios-light');

// ---------------------------------------------------------------------------
// 0. 主题存在
// ---------------------------------------------------------------------------

section('iOS 浅色主题：在主题目录里，且只有一份');

ok(T !== null, 'themes.js 里有 ios-light');
ok(/id:\s*'ios-light',\s*\n\s*name:\s*'iOS 浅色'/.test(THEMES_JS), 'iOS 浅色有可读的名字');
ok(/note:\s*'iOS 浅色/.test(THEMES_JS), 'iOS 浅色有说明（设置页要靠它做选择）');
ok(THEMES_JS.indexOf("id: 'ios-light'") > THEMES_JS.indexOf("id: 'liunian'"),
  'iOS 浅色追加在目录末尾（不打乱既有顺序与默认项）');
// 追加式最容易出的事：漏了逗号把上一项的语法吃掉。跑一遍语法解析。
try {
  new Function(THEMES_JS);
  ok(true, 'themes.js 语法有效（新条目没把上一项的逗号吃掉）');
} catch (e) {
  ok(false, 'themes.js 语法有效：' + e.message);
}

// ---------------------------------------------------------------------------
// 1. 表面令牌必须翻转（浅色主题静默失效的头号原因）
// ---------------------------------------------------------------------------

section('表面令牌：白叠层已逐个翻成暗叠层');

if (T) {
  // 这批令牌在 style.css 里是 rgba(255,255,255,…) 的白叠层，浅底上等于没叠。
  // 浅色主题必须逐个给出自己的值。
  const mustFlip = [
    '--glass-border', '--glass-line', '--glass-bg', '--glass-bg-strong',
    '--glass-shadow', '--glass-shadow-glow',
    '--surface-1', '--surface-2', '--surface-line', '--surface-line-strong',
    '--surface-hi', '--surface-lift',
    '--field-bg', '--field-bg-hover', '--field-border', '--field-border-strong',
    '--track', '--hover', '--panel', '--panel-solid', '--panel-2',
  ];
  for (const k of mustFlip) {
    ok(T[k] !== undefined, `ios-light 覆盖了 ${k}`);
  }

  // 「白叠层」要分两种，否则这条断言本身就是错的：
  //
  //  · **分隔类**（描边/轨道/悬停/内阴影底）——在暗底上靠白叠层浮起来，
  //    浅底上白叠白等于没叠，**必须翻成暗的**。这几项漏一个，那条线就
  //    真的消失了（不是变淡，是看不见）。
  //  · **表面类**（panel/surface/glass-bg）——浅色 iOS 本来就是
  //    「浅灰底 + 纯白卡片」，这里**该是白的**。把它判成错，等于把
  //    正确的实现判成 bug（第一版就犯了这个错）。
  //
  // 所以下面正反两面都断言：分隔类不许是白，表面类不许不是白。
  const separators = ['--track', '--hover', '--glass-border', '--line', '--line-strong',
    '--field-border', '--field-border-strong', '--surface-line', '--surface-line-strong'];
  for (const k of separators) {
    if (!T[k]) continue;
    ok(!/rgba\(255,\s*255,\s*255/.test(T[k]),
      `${k} 不是白叠层（分隔线在浅底上必须是暗的，否则等于没有）`);
  }
  const surfaces = ['--panel', '--panel-solid', '--surface-1', '--surface-2',
    '--glass-bg-strong', '--glass-line', '--surface-hi'];
  for (const k of surfaces) {
    if (!T[k]) continue;
    ok(/rgba\(255,\s*255,\s*255|^#fff/i.test(T[k]) || !/rgba\(\s*\d+,\s*\d+,\s*\d+/.test(T[k]),
      `${k} 是浅色表面（iOS 是「浅灰底 + 纯白卡片」，表面该是白的）`);
  }
  // 轨道与悬停是「看不见就等于坏掉」的两个：白底上必须是灰。
  if (T['--track']) {
    ok(!/rgba\(255/.test(T['--track']), '进度条轨道不是白叠层（浅底上必须看得见）');
  }
  if (T['--hover']) {
    ok(!/rgba\(255/.test(T['--hover']), '悬停底不是白叠层');
  }
  // 玻璃描边：白底上的白描边等于没有描边。
  if (T['--glass-border']) {
    ok(!/rgba\(255/.test(T['--glass-border']), '玻璃描边不是白叠层（否则卡片没有边界）');
  }
  // 阴影：暗色那套 22px/64px 弥散黑在浅底上是一坨脏污，必须换成贴地双层。
  if (T['--glass-shadow']) {
    ok(/0 1px 2px/.test(T['--glass-shadow']) && /0 8px/.test(T['--glass-shadow']),
      '玻璃投影是 iOS 的双层贴地影（接触影 + 扩散影），不是暗底那套弥散黑雾');
  }
}

// ---------------------------------------------------------------------------
// 2. 对比度：按 WCAG AA 实算，不接受「看起来挺清楚」
// ---------------------------------------------------------------------------

section('对比度：全部由 --bg #F2F2F7 / --panel #FFFFFF 实算 AA');

function lin(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin(n >> 16 & 255) + 0.7152 * lin(n >> 8 & 255) + 0.0722 * lin(n & 255);
}
function ratio(a, b) {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

if (T) {
  const bg = T['--bg'];
  const panel = T['--panel-solid'];
  ok(/^#[0-9a-f]{6}$/i.test(bg), '--bg 是实色（实算对比度需要）');
  ok(/^#[0-9a-f]{6}$/i.test(panel), '--panel-solid 是实色');

  if (/^#[0-9a-f]{6}$/i.test(bg) && /^#[0-9a-f]{6}$/i.test(panel)) {
    // 正文 4.5:1（WCAG AA）。
    const body = [['--text', T['--text']], ['--muted', T['--muted']],
      ['--accent', T['--accent']], ['--highlight', T['--highlight']],
      ['--danger', T['--danger']], ['--ok', T['--ok']], ['--warn', T['--warn']]];
    for (const [k, v] of body) {
      ok(/^#[0-9a-f]{6}$/i.test(v || ''), `${k} 是实色`);
      if (!/^#[0-9a-f]{6}$/i.test(v || '')) continue;
      const rBg = ratio(v, bg);
      const rPanel = ratio(v, panel);
      ok(rBg >= 4.5, `${k} ${v} 压 --bg ${rBg.toFixed(2)}:1（正文 AA 4.5）`);
      ok(rPanel >= 4.5, `${k} ${v} 压 --panel ${rPanel.toFixed(2)}:1（正文 AA 4.5）`);
    }
    // 主按钮：accent 底 + accent-ink 字。这是最容易漏的一处——
    // iOS 原色 #007AFF 配白字只有 4.02:1，所以刻意加深过。
    const ink = T['--accent-ink'];
    if (/^#[0-9a-f]{6}$/i.test(ink || '') && /^#[0-9a-f]{6}$/i.test(T['--accent'])) {
      const r = ratio(ink, T['--accent']);
      ok(r >= 4.5, `主按钮：${ink} 压 ${T['--accent']} ${r.toFixed(2)}:1（按钮文字 AA 4.5）`);
    }
    // 焦点环：2px 品牌色，浅底上要比暗底更实。
    if (T['--focus-ring']) {
      // 注意不能直接拿逗号切：`rgba(var(--brand-rgb, 10, 99, 201), 0.75)` 的
      // var() Fallback 里本身带逗号，按逗号切会切出 " 0.75)" 这种碎片。
      // 取**最后一个**顶层逗号之后的那段才是 alpha。
      const alpha = T['--focus-ring'].match(/,\s*([\d.]+)\s*\)\s*$/);
      ok(alpha && Number(alpha[1]) >= 0.7,
        `焦点环不透明度 ≥0.7（浅底上 0.6 偏淡、键盘用户看不见焦点在哪），实得 ${alpha ? alpha[1] : '未解析'}`);
    }
  }

  // 明确否掉 iOS 原色：这三个在浅底上都不达标，换成加深档并说明。
  ok(T['--ok'] !== '#34C759', '成功色不是 systemGreen #34C759（浅底上仅 2.1:1）');
  ok(T['--danger'] !== '#FF3B30', '错误色不是 systemRed #FF3B30（浅底上仅 3.2:1）');
  ok(T['--accent'] !== '#007AFF', '主色不是 systemBlue #007AFF（白字仅 4.02:1）');
}

// ---------------------------------------------------------------------------
// 3. 结构令牌不许混进主题表
// ---------------------------------------------------------------------------

section('尺度归皮肤：圆角/间距不进主题表');

if (T) {
  for (const k of ['--r-sm', '--r-md', '--r-lg', '--r-xl', '--skin-gap', '--skin-radius']) {
    ok(T[k] === undefined, `${k} 不在主题表里（themes.js 自己的规矩：结构令牌归皮肤）`);
  }
}

// ---------------------------------------------------------------------------
// 4. 回退：切回暗色主题时这些覆盖必须消失
// ---------------------------------------------------------------------------

section('回退：切回暗色主题后不残留浅色覆盖');

ok(/Object\.keys\(prev\.tokens\)\.forEach/.test(THEMES_JS) && /removeProperty/.test(THEMES_JS),
  'themes.js 切主题时会清掉上一套独有的键（浅色覆盖随之消失）');
// :root 里的暗色默认值必须还在——它是「回退落点」，被改掉就没有退路。
ok(/--glass-border:\s*1px solid rgba\(255,\s*255,\s*255/.test(STYLE_CSS),
  'style.css 的 --glass-border 暗色默认值仍在（回退落点没被改掉）');
ok(/--track:\s*rgba\(255,\s*255,\s*255/.test(STYLE_CSS),
  'style.css 的 --track 暗色默认值仍在');
ok(/--danger:\s*#ff9b9b/.test(STYLE_CSS),
  'style.css 的 --danger 暗色默认值仍在（16 套暗色主题不受影响）');
// 语义色的暗色默认值：iOS 主题新增了 --ok/--warn，别的主题也得有值，
// 否则 var(--ok) 在暗色主题下是空值。
ok(/--ok:\s*#[0-9a-f]{3,8}/i.test(STYLE_CSS), 'style.css 给了 --ok 的暗色默认值');
ok(/--warn:\s*#[0-9a-f]{3,8}/i.test(STYLE_CSS), 'style.css 给了 --warn 的暗色默认值');

// ---------------------------------------------------------------------------
// 5. 接线
// ---------------------------------------------------------------------------

section('接线：编进二进制');

ok(THEMES_JS.length > 0, 'themes.js 可读');
ok(/include_str!\("[^"]*\/themes\.js"\)/.test(MAIN_RS), 'themes.js 编进二进制');

// ---------------------------------------------------------------------------

console.log('\n' + '─'.repeat(60));
if (failures) {
  console.error(`iOS 浅色主题契约检查：${checks} 项，${failures} 项失败`);
  process.exit(1);
}
console.log(`iOS 浅色主题契约检查：${checks}/${checks} 全部通过`);
