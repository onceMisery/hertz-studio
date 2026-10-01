// SPDX-License-Identifier: MIT
// stanza 纯函数验证：node scripts/check-stanza.js
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', 'crates', 'hertz-studio', 'web', 'stanza');
// 模块工厂从全局取 StanzaUtil：require util 后先挂到 global，再加载下游模块。
const U = require(path.join(ROOT, 'stanza-util.js'));
global.StanzaUtil = U;
const T = require(path.join(ROOT, 'stanza-theme.js'));
const L = require(path.join(ROOT, 'stanza-textlayout.js'));

let failures = 0;
function ok(cond, msg) { if (!cond) { failures += 1; console.error('FAIL:', msg); } else console.log('ok -', msg); }
function eq(a, b, msg) { ok(a === b, msg + ' (got ' + a + ', want ' + b + ')'); }

// 1) renderHints 分级
let micro = U.renderHints({ start_ms: 0, end_ms: 50 });
eq(micro.timingClass, 'micro', 'micro 分级');
eq(micro.revealMode, 'instant', 'micro reveal');
eq(micro.renderEndMs, 67, 'micro 保底 67ms');
let fast = U.renderHints({ start_ms: 0, end_ms: 150 });
eq(fast.timingClass, 'short', 'short 分级');
ok(fast.enterMs >= 45 && fast.enterMs <= 60, 'fast enter 钳位');
ok(fast.exitMs >= 30 && fast.exitMs <= 40, 'fast exit 钳位');
eq(fast.lookaheadMs, 80, 'fast lookahead');
let normal = U.renderHints({ start_ms: 0, end_ms: 2000 });
eq(normal.timingClass, 'normal', 'normal 分级');
eq(normal.enterMs, 420, 'normal enter 上限');
eq(normal.exitMs, 320, 'normal exit 上限');
eq(normal.lookaheadMs, 150, 'normal lookahead');

// 1b) activeLineIndex 行定位（二分：最后一个 start_ms<=tMs；首行前/空输入为 -1）
(function () {
  var lines = [{ start_ms: 1000 }, { start_ms: 2000 }, { start_ms: 5000 }];
  eq(U.activeLineIndex(lines, 0), -1, 'activeLineIndex pre');
  eq(U.activeLineIndex(lines, 1000), 0, 'activeLineIndex at0');
  eq(U.activeLineIndex(lines, 1999), 0, 'activeLineIndex gap');
  eq(U.activeLineIndex(lines, 2000), 1, 'activeLineIndex at1');
  eq(U.activeLineIndex(lines, 99999), 2, 'activeLineIndex last');
  eq(U.activeLineIndex(null, 1), -1, 'activeLineIndex null');
})();

// 2) wordState 三态
let w = { start_ms: 1000, end_ms: 1200 };
let line = { start_ms: 1000, end_ms: 2000 };
eq(U.wordState(w, normal, line, 800), 'waiting', 'waiting');
eq(U.wordState(w, normal, line, 1050), 'active', 'active');
eq(U.wordState(w, normal, line, 1300), 'passed', 'passed');
// micro hints 属于 0–50ms 时间轴（renderEndMs 保底 67）：同时间轴的词在开始前 30ms 内即点亮。
eq(U.wordState({ start_ms: 50, end_ms: 50 }, micro, { start_ms: 0, end_ms: 50 }, 40), 'active', 'instant lookahead 30ms');

// 3) 字素时间
let gt = U.graphemeTimings({ text: '爱你', start_ms: 0, end_ms: 1000 });
eq(gt.length, 2, '两字两个 timing');
eq(gt[0].start_ms, 0, '首字起点');
eq(gt[1].end_ms, 1000, '末字终点');
eq(U.graphemes('a😀b').length, 3, 'emoji 不劈散');

// 4) 颜色往返
let hex = U.rgbToHex(255, 0, 0);
eq(hex, '#ff0000', 'rgbToHex');
let hsl = U.rgbToHsl(255, 0, 0);
eq(hsl[0], 0, '红相 0°');
ok(U.mixHex('#000000', '#ffffff', 0.5) != null, 'mixHex 有值');

// 5) Theme 回退与强度
let th = T.resolve(1.35);
eq(th.backgroundColor, '#09090b', '无 DOM 回退 P2 底色');
eq(th.accentColor, '#f4f4f5', 'P2 accent');
eq(T.resolve(0.5).animationIntensity, 'calm', 'calm 阈值');
eq(T.resolve(1.9).animationIntensity, 'chaotic', 'chaotic 阈值');
eq(T.wordColor('随便什么', th), '#f4f4f5', '空色板回退 accent');

// 6) 排版器：不溢出 / 唯一 hero / AABB 不重叠
L.configure({ measure: (text, px) => Array.from(text).length * px * 0.92 });
let toks = [];
for (let i = 0; i < 24; i += 1) toks.push({ text: '心情歌詞'[i % 4], start_ms: i * 250, end_ms: i * 250 + 250 });
let r = L.layout(toks, { maxW: 320, fontPx: 40 });
ok(r.placements.length === 24, '24 单元');
ok(r.width <= 320 + 2, '排版宽度不超 maxW');
eq(r.placements.filter(p => p.hero).length, 1, '唯一 hero');
let overlap = 0;
for (let i = 0; i < r.placements.length; i++) {
  for (let j = i + 1; j < r.placements.length; j++) {
    let a = r.placements[i], b = r.placements[j];
    let pa = a.w * (a.scale - 1) / 2, pb = b.w * (b.scale - 1) / 2;
    if (a.x - pa < b.x + b.w + pb && a.x + a.w + pa > b.x - pb &&
        a.y - 10 < b.y + 10 && a.y + 10 > b.y - 10) overlap += 1;
  }
}
// 假测宽（每字等宽）夹具下允许少量相切；真实 canvas 测宽下应趋近 0，视觉回归在 T12 目检。
ok(overlap <= 4, '碰撞推让后重叠计数 <=4（got ' + overlap + '）');

// 7) 可读文本过滤
ok(U.hasReadable('爱你'), 'CJK 可读');
ok(!U.hasReadable('//'), '斜杠不可读');
ok(!U.hasReadable('●●●'), '圆点不可读');
ok(U.hasReadable('abc123'), '英文数字可读');

// 8) Theme 取色分支（Node 下 stub window/document/getComputedStyle，每组切换前清 require.cache）
// require 顺序：global.StanzaUtil 已在文件头部挂好；相对路径以 scripts/ 为基准 → scripts/../crates/...
var THEME_REQ = '../crates/hertz-studio/web/stanza/stanza-theme.js';
function hexHsl(hex) { var c = U.hexToRgb(hex); return U.rgbToHsl(c.r, c.g, c.b); }
// 给定 CSS 变量表重新加载 stanza-theme.js：工厂不碰 DOM，resolve 时才经 cssVar 读 stub。
function loadThemeWithVars(vars) {
  delete require.cache[require.resolve(THEME_REQ)];
  global.window = {};
  global.document = {
    documentElement: {},
    getComputedStyle: function () {
      return { getPropertyValue: function (k) { return vars[k] || ''; } };
    }
  };
  return require(THEME_REQ);
}

// 8a) 空格现代语法 hsl(210 70% 68%) → stage-palette；背景极暗同相、accent 中高亮、secondary L42
(function () {
  var Td = loadThemeWithVars({ '--music-highlight': 'hsl(210 70% 68%)' });
  var th = Td.resolve(1);
  eq(th.name, 'stage-palette', 'hsl 空格语法进 stage-palette');
  var bg = hexHsl(th.backgroundColor);
  ok(Math.abs(bg[2] - 8) <= 1, 'stage 背景 L≈8（got ' + bg[2].toFixed(2) + '）');
  // 极暗色 8-bit hex 量化固有误差：S 实测约 36.6，容差放宽到 2（理论值 35）。
  ok(Math.abs(bg[1] - 35) <= 2, 'stage 背景 S≈35=70*0.5（got ' + bg[1].toFixed(2) + '）');
  var ac = hexHsl(th.accentColor);
  ok(Math.abs(ac[0] - 210) <= 2, 'stage accent H≈210（got ' + ac[0].toFixed(2) + '）');
  ok(ac[1] >= 55 && ac[1] <= 80, 'stage accent S 钳 55–80（got ' + ac[1].toFixed(2) + '）');
  ok(ac[2] >= 55 && ac[2] <= 65, 'stage accent L 钳 55–65（got ' + ac[2].toFixed(2) + '）');
  var sec = hexHsl(th.secondaryColor);
  ok(Math.abs(sec[2] - 42) <= 1.5, 'stage secondary L≈42（got ' + sec[2].toFixed(2) + '）');
})();

// 8b) 逗号语法 hsl(210, 70%, 68%) 同样命中
(function () {
  var Td = loadThemeWithVars({ '--music-highlight': 'hsl(210, 70%, 68%)' });
  eq(Td.resolve(1).name, 'stage-palette', 'hsl 逗号语法进 stage-palette');
})();

// 8c) 无 --music-highlight、仅 --music-highlight-rgb 三元组（59,130,246 蓝）→ stage-palette
(function () {
  var Td = loadThemeWithVars({ '--music-highlight-rgb': '59, 130, 246' });
  var th = Td.resolve(1);
  eq(th.name, 'stage-palette', 'rgb 三元组进 stage-palette');
  var ac = hexHsl(th.accentColor);
  ok(ac[0] >= 210 && ac[0] <= 225, 'rgb 三元组 accent 蓝色系 H 210–225（got ' + ac[0].toFixed(2) + '）');
})();

// 8d) 近中性守卫：#808080 / #ffffff 饱和度不足 20，回 P2
(function () {
  var Td = loadThemeWithVars({ '--music-highlight': '#808080' });
  var g1 = Td.resolve(1);
  eq(g1.name, 'Midnight Default', '灰回 P2 name');
  eq(g1.accentColor, '#f4f4f5', '灰回 P2 accent');
  Td = loadThemeWithVars({ '--music-highlight': '#ffffff' });
  var g2 = Td.resolve(1);
  eq(g2.name, 'Midnight Default', '白回 P2 name');
  eq(g2.accentColor, '#f4f4f5', '白回 P2 accent');
})();

// 8e) 非法值 / 空值安全回 P2
(function () {
  var Td = loadThemeWithVars({ '--music-highlight': 'garbage' });
  eq(Td.resolve(1).name, 'Midnight Default', '非法 highlight 回 P2');
  Td = loadThemeWithVars({ '--music-highlight': '' });
  eq(Td.resolve(1).name, 'Midnight Default', '空 highlight 回 P2');
  // stub DOM 用毕复原，避免污染后续无 DOM 语义
  delete global.window;
  delete global.document;
})();

// 8f) wordColor：复刻 stanza wordColoring.resolveWordColor 语义——CJK 分支为
// target.indexOf(clean)>=0，即"配置词 target 包含当前歌词词 token"（不是 token 含 target）；
// 英文分支按空白拆 target 后做小写/去标点归一化的整词匹配，部分匹配回退 accent。
(function () {
  var wcTheme = Object.assign({}, T.DEFAULT, {
    wordColors: [{ word: '爱你', color: '#ff0000' }, { word: 'Hello', color: '#00ff00' }]
  });
  eq(T.wordColor('爱你', wcTheme), '#ff0000', 'wordColor CJK 精确（target 爱你 含 token 爱你）→ 红');
  eq(T.wordColor('爱', wcTheme), '#ff0000', 'wordColor CJK 单字 token 爱 被 target 爱你 包含 → 红');
  eq(T.wordColor('你', wcTheme), '#ff0000', 'wordColor CJK 单字 token 你 被 target 爱你 包含 → 红');
  eq(T.wordColor('爱你呀', wcTheme), T.DEFAULT.accentColor, 'wordColor token 爱你呀 不被 target 爱你 完整包含 → 回退 accent');
  eq(T.wordColor('hello', wcTheme), '#00ff00', 'wordColor 英文小写归一命中 Hello → 绿');
  eq(T.wordColor('ell', wcTheme), T.DEFAULT.accentColor, 'wordColor 英文部分匹配 ell 必须回退');

  // 8g) signature：两个相同 resolve 结果签名相等
  eq(T.signature(T.resolve(1)), T.signature(T.resolve(1)), '相同 resolve 签名相等');
  // wordColors 不进 signature（当前实现如此，按任务要求不断言）。

  // 8h) fontStack：sans 栈含雅黑；未知 style 回退 sans
  ok(T.fontStack('sans').indexOf('Microsoft YaHei') >= 0, 'sans 栈含 Microsoft YaHei');
  eq(T.fontStack('unknown-style'), T.fontStack('sans'), '未知 fontStyle 回退 sans');
})();

// 9) 颜色纯函数补强
(function () {
  var c3 = U.hexToRgb('#f00'), c6 = U.hexToRgb('#ff0000');
  ok(c3 && c3.r === 255 && c3.g === 0 && c3.b === 0, 'hex3 #f00 → (255,0,0)');
  ok(c6 && c6.r === 255 && c6.g === 0 && c6.b === 0, 'hex6 #ff0000 → (255,0,0)');
  eq(U.hexToRgb('red'), null, 'hexToRgb 非法 red → null');
  eq(U.hexToRgb(null), null, 'hexToRgb null → null');

  eq(U.mixHex('#000000', '#ffffff', 0.5), '#808080', 'mixHex 黑白各半');
  eq(U.mixHex('#xxx', '#ffffff', 0.5), '#ffffff', 'mixHex 非法左端回退右端');
  eq(U.withAlpha('#fff', 0.5), 'rgba(255,255,255,0.5)', 'withAlpha 白色 .5');

  // hsl→hex→rgb→hsl 往返（hex 8bit 量化容差内闭合）
  [0, 120, 240].forEach(function (h) {
    var back = hexHsl(U.hslToHex(h, 70, 50));
    ok(Math.abs(back[0] - h) < 1, '往返 H=' + h + '（got ' + back[0].toFixed(2) + '）');
    ok(Math.abs(back[1] - 70) < 1.5, '往返 S=70 @H' + h + '（got ' + back[1].toFixed(2) + '）');
    ok(Math.abs(back[2] - 50) < 1.5, '往返 L=50 @H' + h + '（got ' + back[2].toFixed(2) + '）');
  });

  eq(U.damp(0, 100, 0, 16), 100, 'damp tau≤0 瞬切 target');
  // damp 帧率无关一阶低通：cur + (target-cur) * (1 - e^(-dt/tau))。
  // 0→100、tau=16、dt=16：100*(1-e^-1)=100*0.63212≈63.21（86.47 对应的是 dt=32 即 dt/tau=2）。
  ok(Math.abs(U.damp(0, 100, 16, 16) - 63.21) <= 0.5,
    'damp tau=16/dt=16：100*(1-e^-1)≈63.21（got ' + U.damp(0, 100, 16, 16).toFixed(3) + '）');

  eq(U.srand(123), U.srand(123), 'srand 同种子确定');
  eq(U.easeOutCubic(0), 0, 'easeOutCubic(0)=0');
  eq(U.easeOutCubic(1), 1, 'easeOutCubic(1)=1');
})();

// 10) textlayout 补充
(function () {
  // 10a) 空 / null 输入统一零结果
  var empty = L.layout([], { maxW: 300, fontPx: 40 });
  var nulled = L.layout(null, { maxW: 300, fontPx: 40 });
  [['空数组', empty], ['null', nulled]].forEach(function (pair) {
    eq(pair[1].width, 0, pair[0] + ' width=0');
    eq(pair[1].height, 0, pair[0] + ' height=0');
    eq(pair[1].placements.length, 0, pair[0] + ' placements=[]');
  });

  // 10b) 拉丁长词硬切：每字 10px、maxW=60 → 多片，拼接还原、每片 ≤60、时间戳不丢
  L.configure({ measure: function (text) { return Array.from(text).length * 10; } });
  var word = L.layout([{ text: 'internationalization', start_ms: 0, end_ms: 1000 }], { maxW: 60, fontPx: 40 });
  ok(word.placements.length > 1, '拉丁长词被切成多片（got ' + word.placements.length + '）');
  eq(word.placements.map(function (p) { return p.text; }).join(''), 'internationalization', '碎片拼接还原原词');
  ok(word.placements.every(function (p) { return p.w === Array.from(p.text).length * 10; }), '碎片测宽 10px/字');
  ok(word.placements.every(function (p) { return p.w <= 60; }), '碎片宽度均 ≤maxW=60');
  ok(word.placements.every(function (p) { return p.start_ms === 0 && p.end_ms === 1000; }), '碎片时间戳均 0/1000');

  // 10c) 同一组 20 CJK tokens 在 380 / 1280 两宽下：无重叠、不溢出、结果随宽度响应
  L.configure({ measure: function (text, px) { return Array.from(text).length * px * 0.92; } });
  var cjkToks = [];
  for (var i = 0; i < 20; i += 1) {
    cjkToks.push({ text: '心情歌詞'[i % 4], start_ms: i * 250, end_ms: i * 250 + 250 });
  }
  function overlapCount(r) {
    var n = 0;
    for (var a = 0; a < r.placements.length; a += 1) {
      for (var b = a + 1; b < r.placements.length; b += 1) {
        var x = r.placements[a], y = r.placements[b];
        var pax = x.w * (x.scale - 1) / 2, pby = y.w * (y.scale - 1) / 2;
        if (x.x - pax < y.x + y.w + pby && x.x + x.w + pax > y.x - pby &&
            x.y - 10 < y.y + y.h + 10 && x.y + x.h + 10 > y.y - 10) n += 1;
      }
    }
    return n;
  }
  function rowCount(r) {
    var ys = {};
    r.placements.forEach(function (p) { ys[p.y] = 1; });
    return Object.keys(ys).length;
  }
  var narrow = L.layout(cjkToks, { maxW: 380, fontPx: 40 });
  var wide = L.layout(cjkToks, { maxW: 1280, fontPx: 40 });
  eq(overlapCount(narrow), 0, '窄容器 380 AABB（±10 带）无重叠');
  eq(overlapCount(wide), 0, '宽容器 1280 AABB（±10 带）无重叠');
  ok(narrow.width <= 380 + 2, '窄容器 width ≤382（got ' + narrow.width.toFixed(1) + '）');
  ok(wide.width <= 1280 + 2, '宽容器 width ≤1282（got ' + wide.width.toFixed(1) + '）');
  ok(JSON.stringify(narrow) !== JSON.stringify(wide), '两宽排版结果不同（响应式生效）');
  ok(rowCount(wide) < rowCount(narrow) || wide.width > narrow.width,
    '宽容器行数更少或宽度更大（rows ' + rowCount(narrow) + '→' + rowCount(wide) +
    '，width ' + narrow.width.toFixed(0) + '→' + wide.width.toFixed(0) + '）');

  // 10d) 确定性：同参数两次结果逐值相等
  eq(JSON.stringify(L.layout(cjkToks, { maxW: 380, fontPx: 40 })), JSON.stringify(narrow), 'layout 确定性复跑一致');
})();

// 11) graphemeTimings 中点：等权两字 0–1000 在 500 处切分
(function () {
  var ab = U.graphemeTimings({ text: 'ab', start_ms: 0, end_ms: 1000 });
  eq(ab[0].char, 'a', '首字 a');
  eq(ab[0].start_ms, 0, 'a 起点 0');
  eq(ab[0].end_ms, 500, 'a 终点 500 中点');
  eq(ab[1].char, 'b', '次字 b');
  eq(ab[1].start_ms, 500, 'b 起点 500 中点');
  eq(ab[1].end_ms, 1000, 'b 终点 1000');
})();

if (failures) { console.error('\n' + failures + ' 个失败'); process.exit(1); }
console.log('\n全部通过');
