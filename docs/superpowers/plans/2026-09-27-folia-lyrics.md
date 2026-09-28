# folia 歌词模式移植实施计划（流光 classic / 心象 cadenza）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **执行状态（2026-09-27 完成）：T1–T12 全部完成，每模块经规格+质量双审查。定稿偏差见各 Task 顶部"实现修订"，关键汇总：**
> - folia-util 增 num 脏数据归一与 activeLineIndex（Stage.lyrics().index 未定位时被规整为 0，不能直接用）；
> - folia-theme 取色源实际为 hsl token / rgb 三元组（readSourceHsl 支持 hex/hsl/rgb/triplet），近中性 S<20 回 P2；
> - 排版器重写：3 轮成对松弛+确定性保证尾+行重居中，2000 布局零重叠且不超 maxW；passedRotate ±12；
> - classic 补齐容器随机对齐、三档行转场（400/300、160/160、0/120ms）、辉光 4 套关键帧（n/f/i/c）、旋转分层（.fl-crot 5s linear）、呼吸幅度乘数、软重建（拖参不重播进入动画）；
> - cadenza 含软重排、reduced 冻结、窄屏 DPR、居中锚定补偿、单测宽 canvas 复用；
> - 背景修正封面图层顺序、频段直连（圆/方/三角/十字→bass/lowMid/mid/treble）、初始旋转、380px 锚点；
> - stage3d：控件按偏好回填、镜头动态平面禁用、无 GL 放行+降级提示、offset 乐观更新（连点/切歌隔离/失败回清/online 拦截）、拖杆 change 才持久化、classic resize 接线、reduced 保留 120ms 行转场；
> - main.rs 为 include_str! 清单式服务，8 个 folia 资源已登记常量+路由（计划初版未知，T8 发现并处理）。
>
> **已知边界：** ① 后端当前不提供 translation（恒 None），字幕条本期实际呈现"下两句预告"，翻译分支已就位待后端接通；② scripts/check-folia-visual.js（32 格 SSIM 对比）已交付未运行（需 folia-major dev server 与固定时钟），95% 相似度以浏览器目检为准；③ 几何形状 square/triangle/cross 为实心（与 folia 上游一致，仅 circle 描边）。
>
> 静态证据：`node scripts/check-folia.js`（111 断言）、`node scripts/check-assets.js`（358 项）、`cargo build -p vmusicd` 全绿。

**Goal:** 在 hertz-studio 现有全屏舞台中，用零依赖 vanilla JS 高保真移植 folia-major 的流光（classic）与心象（cadenza）两种歌词模式，替换现有 spark/scatter 布局。

**Architecture:** 在 `crates/vmusicd/web/folia/` 下新增 7 个 IIFE/UMD-lite 模块 + 1 个 CSS，由 stage3d 在平面布局下挂载并通过现有 tick/Stage.gate 驱动；时间轴、行号、词 tokens、翻译、能量、封面取色全部复用 Stage 单一事实来源；Theme 换算集中在 folia-theme 一个模块。

**Tech Stack:** 原生 JS（ES5 风格、零依赖、无构建）、CSS 动画/transition、canvas 2D（测宽、光束、封面降采样）、现有 Stage.gate rAF。

**对应 spec：** `docs/superpowers/specs/2026-09-27-folia-lyrics-design.md`

---

## 开发约定（务必先读）

1. **不走 TDD（用户明确要求）**：每个任务先写实现代码，再运行任务内的验证步骤。验证脚本 `scripts/check-folia.js` 在 Task 11 实现完成后补齐。
2. **不自动提交**：全局约定未经用户明确要求不得 git commit。任务末尾的"检查点"只做进度确认；仅当用户在该检查点明确授权时才执行给出的 git 命令。
3. 路径基准：前端根目录 `crates/vmusicd/web/`（下文简称 `web/`）。
4. 风格：新模块沿用现有文件头 SPDX 注释、`'use strict'`、IIFE 挂载全局（`global.FoliaXxx`）；纯计算模块（util/theme/textlayout）用 UMD-lite 尾部以便 Node 直接 require 做验证。
5. 时间单位：Stage 对外为毫秒；模块内部 folia 常量一律换算成毫秒使用，变量名带 `Ms`。
6. 每个任务完成后运行：`node scripts/check-folia.js`（Task 11 之前只跑已存在的检查；若文件尚不存在则跳过）并在浏览器打开舞台目测无报错。

## 文件结构

| 文件 | 责任 | 任务 |
|---|---|---|
| `web/folia/folia-util.js` | 数学/颜色/时间分级/字素（UMD-lite，可 Node require） | T1 |
| `web/folia/folia-theme.js` | Theme 适配层（唯一换算入口）、wordColor、字体栈 | T2 |
| `web/folia/folia-textlayout.js` | 测宽、CJK 断行、hero、碰撞放置 | T3 |
| `web/folia/folia.css` | fl- 命名空间全部样式 | T4 |
| `web/folia/folia-bg.js` | 几何/流体/纯色三档背景 + 暗角 | T4 |
| `web/folia/folia-subtitle.js` | 翻译/预告字幕条 | T5 |
| `web/folia/folia-classic.js` | 流光渲染器 | T6 |
| `web/folia/folia-cadenza.js` | 心象渲染器（DOM + canvas 光束） | T7 |
| `web/index.html` | DOM 容器、设置区块、script/link 接线、布局选项改名 | T8 |
| `web/stage.js` | 新增 `Stage.lyricTranslation` / `Stage.lyricOffset` 两个只读出口 | T8 |
| `web/stage3d.js` | 平面模式、挂载驱动、偏好迁移、设置接线、无 GL 放行 | T9 |
| `web/app.js` | `stage:control` 新增 `lyricOffset` 动作 | T10 |
| `web/workshop.js` | 工坊布局下拉项同步改名（id 迁移） | T9 |
| `scripts/check-folia.js` | 纯函数验证（Node 运行） | T11 |
| `scripts/check-folia-visual.js` | Playwright 双端截图矩阵（实现后） | T12 |

**模块接口契约（后续任务共用，不得改名）：**

```js
// folia-util.js → global.FoliaUtil
clamp(v,a,b); lerp(a,b,t); damp(cur,target,tauMs,dtMs); easeOutCubic(t); srand(seed);
hexToRgb(hex); rgbToHex(r,g,b); mixHex(a,b,t); withAlpha(hex,a); rgbToHsl(r,g,b)/*[h,s,l]*/; hslToHex(h,s,l);
renderHints(lineMs)                 // {start_ms,end_ms, words?} → {timingClass, enterMs, exitMs, holdMs, lookaheadMs, renderEndMs, revealMode}
wordState(wordMs, hints, tMs)       // 'waiting' | 'active' | 'passed'
graphemes(text)                     // string[]
graphemeTimings(wordMs)             // [{char,start_ms,end_ms}]
hasReadable(text)                   // boolean，/\p{L}\p{N}/u

// folia-theme.js → global.FoliaTheme
DEFAULT                             // P2 Midnight 主题对象
resolve(reactivity)                 // number → 冻结主题 {backgroundColor,primaryColor,secondaryColor,accentColor,wordColors,animationIntensity,fontStyle}
signature(theme)                    // string，变化检测用
wordColor(text, theme)              // string
fontStack(style)                    // string

// folia-textlayout.js → global.FoliaTextLayout
configure({ measure })              // measure:(text,fontPx)=>widthPx；浏览器注入 canvas 实现
layout(tokens, opts)                // 见 T3 契约

// 渲染器（classic/cadenza）与 bg/sub 统一表面：
api.frame(dtMs)                      // 每帧（平面布局下由 stage3d tick 调用）
api.update()                         // 元数据变化（8fps gate 调用；内部自读 Stage）
api.setTheme(theme)
api.setFontScale(scale)              // 0.70–1.50
api.setVisible(b)
api.setPaused(b)
api.setEco(b)
api.resize()
api.destroy()
// bg 额外：setMode(m) setOpacity(v) setVignette(b) setCover(url)
// sub 额外：—
// classic 额外：setTuning({rotation,breathing,spacing})
// cadenza 额外：setTuning({width,motion,glow,beam})
// init 形式：FoliaClassic.init(hostEl, onSeekMs) / FoliaBg.init(hostEl) / FoliaSubtitle.init(hostEl)
```

---

## Task 1: folia-util.js — 时间分级、字素、数学与颜色

**Files:**
- Create: `crates/vmusicd/web/folia/folia-util.js`

- [ ] **Step 1: 创建模块（完整代码）**

```js
// SPDX-License-Identifier: MIT
// folia 等价移植：纯函数工具。无 DOM 依赖，UMD-lite 尾部允许 Node require 做验证。
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FoliaUtil = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  // 帧率无关一阶低通：tauMs = 追到 63% 的毫秒数（stage3d 同款公式）。
  function damp(cur, target, tauMs, dtMs) {
    if (!(tauMs > 0)) return target;
    return cur + (target - cur) * (1 - Math.exp(-Math.max(0, dtMs) / tauMs));
  }
  function easeOutCubic(t) { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, 3); }
  function srand(seed) { var x = Math.sin(seed) * 10000; return x - Math.floor(x); }

  function hexToRgb(hex) {
    if (!hex || typeof hex !== 'string') return null;
    var m = hex.replace('#', '').trim();
    if (m.length === 3) m = m[0]+m[0]+m[1]+m[1]+m[2]+m[2];
    if (!/^[0-9a-fA-F]{6}$/.test(m)) return null;
    var n = parseInt(m, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgbToHex(r, g, b) {
    function h(v) { var s = clamp(Math.round(v), 0, 255).toString(16); return s.length === 1 ? '0' + s : s; }
    return '#' + h(r) + h(g) + h(b);
  }
  function mixHex(a, b, t) {
    var ca = hexToRgb(a), cb = hexToRgb(b);
    if (!ca) return cb ? b : a;
    if (!cb) return a;
    return rgbToHex(lerp(ca.r, cb.r, t), lerp(ca.g, cb.g, t), lerp(ca.b, cb.b, t));
  }
  function withAlpha(hex, a) {
    var c = hexToRgb(hex);
    if (!c) return hex;
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + clamp(a, 0, 1) + ')';
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, s * 100, l * 100];
  }
  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360; s = clamp(s, 0, 100) / 100; l = clamp(l, 0, 100) / 100;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs((h / 60) % 2 - 1));
    var m = l - c / 2;
    var r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
  }

  // ---- 行渲染提示（逐值复刻 folia renderHints.ts；单位毫秒）----
  var MICRO_MS = 100, SHORT_MS = 180, MICRO_FLOOR_MS = 67;
  function lastWordEndMs(line) {
    if (line.words && line.words.length) return line.words[line.words.length - 1].end_ms;
    return line.end_ms;
  }
  function renderHints(line) {
    var start = line.start_ms || 0;
    var end = line.end_ms != null ? line.end_ms : start;
    var raw = Math.max(0, end - start);
    var timingClass, revealMode, enterMs, exitMs, holdMs;
    if (raw < MICRO_MS) {
      timingClass = 'micro'; revealMode = 'instant';
      enterMs = 0; exitMs = 0; holdMs = 0;
    } else if (raw < SHORT_MS) {
      timingClass = 'short'; revealMode = 'fast';
      enterMs = clamp(raw * 0.45, 45, 60);
      exitMs = clamp(raw * 0.22, 30, 40);
      holdMs = 30;
    } else {
      timingClass = 'normal'; revealMode = 'normal';
      enterMs = Math.min(420, Math.max(220, Math.max(raw, 120) * 0.34));
      exitMs = Math.min(320, Math.max(180, Math.max(raw, 120) * 0.18));
      holdMs = 60;
    }
    var renderEndMs;
    if (timingClass === 'micro') {
      renderEndMs = Math.max(end, start + MICRO_FLOOR_MS);
    } else {
      var passStart = Math.max(lastWordEndMs(line), start) + holdMs;
      var exitStart = Math.max(passStart, end - exitMs);
      if (timingClass === 'short') exitStart = Math.max(start + enterMs + 10, exitStart);
      renderEndMs = Math.max(end, exitStart + exitMs);
    }
    var lookaheadMs = revealMode === 'instant' ? 30 : revealMode === 'fast' ? 80 : 150;
    return { timingClass: timingClass, revealMode: revealMode, enterMs: enterMs,
      exitMs: exitMs, holdMs: holdMs, renderEndMs: renderEndMs, lookaheadMs: lookaheadMs };
  }
  function wordActiveEndMs(word, hints, line) {
    var start = line.start_ms || 0, end = line.end_ms != null ? line.end_ms : start;
    if (hints.revealMode === 'instant') return hints.renderEndMs;
    if (hints.revealMode === 'fast') return Math.min(hints.renderEndMs, Math.max(word.end_ms, word.start_ms + 120));
    return word.end_ms;
  }
  function wordState(word, hints, line, tMs) {
    var activeEnd = wordActiveEndMs(word, hints, line);
    if (tMs >= word.start_ms - hints.lookaheadMs && tMs <= activeEnd) return 'active';
    if (tMs > activeEnd) return 'passed';
    return 'waiting';
  }

  // ---- 字素（Array.from 正确处理代理对；组合记号随基字）----
  function graphemes(text) {
    if (!text) return [];
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      var seg = new Intl.Segmenter('zh', { granularity: 'grapheme' });
      var out = [];
      var it = seg.segment(text);
      if (typeof it[Symbol.iterator] === 'function') {
        var parts = it[Symbol.iterator]();
        var n;
        while (!(n = parts.next()).done) out.push(n.value.segment);
        return out;
      }
    }
    return Array.from(text);
  }
  function isSpace(ch) { return /\s/.test(ch); }
  // 词时长按字素权重分配：普通字权重 1，空白权重 0.5。
  function graphemeTimings(word) {
    var chars = graphemes(word.text);
    var dur = Math.max(0, (word.end_ms != null ? word.end_ms : word.start_ms) - word.start_ms);
    var weights = chars.map(function (ch) { return isSpace(ch) ? 0.5 : 1; });
    var total = weights.reduce(function (a, b) { return a + b; }, 0) || 1;
    var acc = 0;
    return chars.map(function (ch, i) {
      var from = word.start_ms + dur * (acc / total);
      acc += weights[i];
      var to = word.start_ms + dur * (acc / total);
      return { char: ch, start_ms: from, end_ms: to };
    });
  }

  var READABLE_RE = /[\p{L}\p{N}]/u;
  function hasReadable(text) { return !!text && READABLE_RE.test(text); }

  return {
    clamp: clamp, lerp: lerp, damp: damp, easeOutCubic: easeOutCubic, srand: srand,
    hexToRgb: hexToRgb, rgbToHex: rgbToHex, mixHex: mixHex, withAlpha: withAlpha,
    rgbToHsl: rgbToHsl, hslToHex: hslToHex,
    renderHints: renderHints, wordState: wordState,
    graphemes: graphemes, graphemeTimings: graphemeTimings, hasReadable: hasReadable
  };
});
```

- [ ] **Step 2: 临时冒烟验证（此时 check-folia.js 尚不存在，用 node -e）**

Run（在仓库根目录）：
```
node -e "var U=require('./crates/vmusicd/web/folia/folia-util.js'); var h=U.renderHints({start_ms:0,end_ms:50}); if(h.timingClass!=='micro'||h.renderEndMs!==67) throw new Error('micro'); var n=U.renderHints({start_ms:0,end_ms:2000}); if(n.timingClass!=='normal'||n.enterMs!==420||n.exitMs!==320) throw new Error('normal'); console.log('util ok', h.timingClass, n.enterMs, U.graphemes('爱you').length);"
```
Expected: `util ok micro 420 4`

- [ ] **Step 3: 检查点**：util 完成。无需提交；若用户授权提交，命令：`git add crates/vmusicd/web/folia/folia-util.js && git commit -m "feat(stage): folia util timing/color/grapheme helpers"`

---

## Task 2: folia-theme.js — Theme 适配层（单一换算入口）

> **实现修订（两阶段审查后定稿，以实际文件 folia-theme.js 为准）：**
> 1. 计划代码块最初只解析 hex；审查发现 stage.js 的 `--music-highlight` 实际为 `hsl(H S% L%)` 字符串。定稿新增 `readSourceHsl()`，支持 hex/hsl（空格或逗号、大小写不敏感）/rgb/`--music-highlight-rgb` 三元组，捕获值经 isFinite（rgb 还须 0–255）校验，畸形回退 null。
> 2. 新增近中性守卫 `NEUTRAL_SAT_MAX=20`：源饱和度 <20%（默认白/灰 accent）走 P2，避免把白色伪造成粉红色；有彩色才走取色主题。accent S 钳区间为 **55–80**（MIN 55、MAX 80），L 55–65。
> 3. shallow() 的 wordColors 用 slice() 拷贝，杜绝 DEFAULT 被原地污染。
> 下游接口（DEFAULT/resolve/signature/wordColor/fontStack）签名不变。下方代码块为初版，差异点以本说明与最终文件为准。

**Files:**
- Create: `crates/vmusicd/web/folia/folia-theme.js`

数据源（spec 4.2）：读 `getComputedStyle(document.documentElement)` 的 `--music-highlight`（stage.js 12 色相桶胜出色，L≈68）；无有效色值时回退 P2。accent 有效时：取其 HSL，背景 = 同色相极暗（S×0.5，L 8%），次色 = 同色相低饱（S×0.28，L 42%），主色恒近白。

- [ ] **Step 1: 创建模块（完整代码）**

```js
// SPDX-License-Identifier: MIT
// folia Theme 适配层：所有 folia 渲染器只认本模块输出，禁止在渲染器内自行取色。
(function (root, factory) {
  var api = factory(root.FoliaUtil);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FoliaTheme = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (U) {
  'use strict';

  // P2：folia 源码 DEFAULT_THEME（Midnight Default，baseThemes.ts）
  var DEFAULT = {
    name: 'Midnight Default',
    backgroundColor: '#09090b',
    primaryColor: '#f4f4f5',
    accentColor: '#f4f4f5',
    secondaryColor: '#71717a',
    wordColors: [],
    animationIntensity: 'normal',
    fontStyle: 'sans'
  };

  var FONT_STACKS = {
    sans: '"Inter","Noto Sans CJK SC","Source Han Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif',
    serif: '"Iowan Old Style","Noto Serif CJK SC","Source Han Serif SC","Songti SC","STSong",Georgia,serif',
    mono: '"IBM Plex Mono","SFMono-Regular",Consolas,"Microsoft YaHei",monospace'
  };

  function cssVar(name) {
    if (typeof window === 'undefined' || typeof document === 'undefined') return '';
    var v = window.getComputedStyle(document.documentElement).getPropertyValue(name);
    return v ? v.trim() : '';
  }

  // reactivity：stage3d 律动强度（0–2）。<0.7 calm，>1.6 chaotic。
  function intensityFrom(reactivity) {
    if (typeof reactivity === 'number' && reactivity < 0.7) return 'calm';
    if (typeof reactivity === 'number' && reactivity > 1.6) return 'chaotic';
    return 'normal';
  }

  function resolve(reactivity) {
    var accentRaw = cssVar('--music-highlight');
    var rgb = U.hexToRgb(accentRaw);
    if (!rgb) {
      return shallow(DEFAULT, intensityFrom(reactivity));
    }
    var hsl = U.rgbToHsl(rgb.r, rgb.g, rgb.b);
    var theme = {
      name: 'stage-palette',
      backgroundColor: U.hslToHex(hsl[0], hsl[1] * 0.5, 8),
      primaryColor: '#f4f4f5',
      accentColor: U.hslToHex(hsl[0], Math.min(80, Math.max(55, hsl[1])), Math.min(65, Math.max(55, hsl[2]))),
      secondaryColor: U.hslToHex(hsl[0], hsl[1] * 0.28, 42),
      wordColors: [],
      animationIntensity: intensityFrom(reactivity),
      fontStyle: 'sans'
    };
    return theme;
  }

  function shallow(base, animationIntensity) {
    return {
      name: base.name, backgroundColor: base.backgroundColor, primaryColor: base.primaryColor,
      accentColor: base.accentColor, secondaryColor: base.secondaryColor, wordColors: base.wordColors,
      animationIntensity: animationIntensity, fontStyle: base.fontStyle
    };
  }

  function signature(t) {
    return [t.backgroundColor, t.primaryColor, t.secondaryColor, t.accentColor,
      t.animationIntensity, t.fontStyle].join('|');
  }

  function normalizeToken(s) { return String(s || '').toLowerCase().replace(/[^\w]/g, ''); }
  function isCJK(s) { return /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(s); }

  // 复刻 wordColoring.resolveWordColor：空色板/无匹配回退 accentColor。
  function wordColor(text, theme) {
    var list = theme.wordColors || [];
    var clean = String(text || '').trim();
    if (!clean || !list.length) return theme.accentColor;
    for (var i = 0; i < list.length; i += 1) {
      var target = String(list[i].word || '').trim();
      var color = list[i].color;
      if (!target || !color) continue;
      if (isCJK(clean)) {
        if (target.indexOf(clean) >= 0) return color;
      } else {
        var targetWords = target.split(/\s+/).map(normalizeToken).filter(Boolean);
        if (targetWords.indexOf(normalizeToken(clean)) >= 0) return color;
      }
    }
    return theme.accentColor;
  }

  function fontStack(style) { return FONT_STACKS[style] || FONT_STACKS.sans; }

  return { DEFAULT: DEFAULT, resolve: resolve, signature: signature,
    wordColor: wordColor, fontStack: fontStack };
});
```

- [ ] **Step 2: Node 冒烟（无 DOM 时必须安全回退 P2）**

```
node -e "var T=require('./crates/vmusicd/web/folia/folia-theme.js'); var t=T.resolve(1.35); if(t.backgroundColor!=='#09090b'||t.accentColor!=='#f4f4f5') throw new Error('fallback'); if(T.resolve(0.5).animationIntensity!=='calm'||T.resolve(1.9).animationIntensity!=='chaotic') throw new Error('intensity'); if(T.wordColor('爱',t)!=='#f4f4f5') throw new Error('wordcolor'); console.log('theme ok');"
```
Expected: `theme ok`

- [ ] **Step 3: 检查点**。

---

## Task 3: folia-textlayout.js — 心象文本排版器

> **实现修订（两阶段审查后定稿，以实际文件为准）：**
> 1. 入口防御：tokens 非数组/空、fontPx（finite 钳 8–200，缺省 60）、maxW（finite≥0）、measure NaN→0、时间戳经 numMs 归一（end<start 收敛）、seedBase 同样归一防 NaN。
> 2. atomize 改为字素扫描，支持中英混合 token（连续 CJK 逐字、非 CJK 累积成词、空白分词）：`hello世界我 love你 → hello/世/界/我/love/你`。
> 3. 计划中的单遍 y 推让经实测会系统性制造跨行重叠，已替换为：放置后 3 轮全局成对松弛（独立 x/y 碰撞带 bx=w·(scale−1)/2+2、by=max(12,.45lineH)，最小穿透轴、hero 不动）+ 确定性保证尾（行内后缀推移、以 hero 行为锚逐行整体平移；xHit 用 −0.01px EPS 容差防浮点伪重叠）。初始行锚距 pitchY≈2.32em（spec 7.2 纵向步长 ≥2.2 行高）。实测 2000 布局/185,002 词对零重叠、完全确定、幂等。
> 4. 包围盒归一化修正为 p.y 顶部语义（minY=p.y、maxY=p.y+p.h）；jitterX 降到 ±.045em；删除未用的 rowRects/isLatinWord。返回契约 15 字段不变，字段与 spec 术语映射写在文件头注释。

**Files:**
- Create: `crates/vmusicd/web/folia/folia-textlayout.js`

**契约：**

```js
FoliaTextLayout.configure({ measure: function(text, fontPx){ return widthPx; } });
FoliaTextLayout.layout(tokens, opts)
// tokens: [{text,start_ms,end_ms}]（Stage.lyricTokens 的输出）
// opts: { maxW:Number(px), fontPx:Number }
// 返回:
// { width, height,
//   placements: [{ text, start_ms, end_ms, x, y, w, h, rotate, scale, hero,
//                   entryX, entryY, passedRotate, driftX, driftY }] }
// 坐标原点为行包围盒左上角；放置保证 AABB 不重叠（scale 后外扩）。
```

算法（对应 spec 7.2）：① tokens 展平为原子单元（CJK 逐字、拉丁按空格词；过长拉丁单元按测宽硬切）；② hero 打分（CJK 0.18，拉丁 min(字数×.08,.36)，居中偏置）；③ hero 居中放大 1.3；④ 其余单元在 hero 上下按行贪心放置，行宽 maxW，行内居中，行高 1.5·fontPx；⑤ 每行内每单元加确定性微抖动（srand），与上下相邻行做 AABB 碰撞推让；⑥ rotate/passedRotate/drift 由 srand 生成。

- [ ] **Step 1: 创建模块（完整代码）**

```js
// SPDX-License-Identifier: MIT
// 心象排版器：替代 @chenglou/pretext（歌词短文本/CJK 为主的精简面）。
(function (root, factory) {
  var api = factory(root.FoliaUtil);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FoliaTextLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (U) {
  'use strict';

  var measureFn = function () { return 0; };
  function configure(opts) {
    if (opts && typeof opts.measure === 'function') measureFn = opts.measure;
  }
  // 浏览器默认测宽：canvas 2d，字体由调用方通过 configure 注入 font 串前缀。
  function installCanvasMeasure(fontStack, fontWeight) {
    if (typeof document === 'undefined') return;
    var c = document.createElement('canvas');
    var ctx = c.getContext('2d');
    configure({ measure: function (text, fontPx) {
      ctx.font = (fontWeight || 700) + ' ' + fontPx + 'px ' + fontStack;
      return ctx.measureText(text).width;
    }});
  }

  function isCJKChar(ch) { return /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(ch); }
  function isLatinWord(s) { return /^[A-Za-z0-9][A-Za-z0-9'\-]*$/.test(s); }

  // tokens → 原子单元
  function atomize(tokens) {
    var units = [];
    tokens.forEach(function (tk, ti) {
      var text = tk.text || '';
      if (!text) return;
      if (isCJKChar(text)) {
        // 整个 CJK token 逐字，时间均摊到字
        var chars = U.graphemes(text);
        var dur = Math.max(0, (tk.end_ms != null ? tk.end_ms : tk.start_ms) - tk.start_ms);
        chars.forEach(function (ch, i) {
          units.push({ text: ch, start_ms: tk.start_ms + dur * i / chars.length,
            end_ms: tk.start_ms + dur * (i + 1) / chars.length, ti: ti });
        });
      } else {
        // 保留空格切分，拉丁词作为一个单元
        var pieces = text.split(/(\s+)/).filter(function (p) { return !!p; });
        pieces.forEach(function (p) {
          units.push({ text: p, start_ms: tk.start_ms, end_ms: tk.end_ms != null ? tk.end_ms : tk.start_ms, ti: ti });
        });
      }
    });
    return units.filter(function (u) { return !!u.text.trim(); });
  }

  // 过长的拉丁单元按字符硬切到不超过 maxW
  function fitUnit(unit, maxW, fontPx) {
    var w = measureFn(unit.text, fontPx);
    if (w <= maxW || isLatinWord(unit.text) === false && isCJKChar(unit.text)) return [unit];
    var out = [], cur = '', chars = U.graphemes(unit.text);
    chars.forEach(function (ch) {
      if (measureFn(cur + ch, fontPx) > maxW && cur) { out.push(cur); cur = ch; }
      else cur += ch;
    });
    if (cur) out.push(cur);
    return out.map(function (text, i, arr) {
      return { text: text, start_ms: unit.start_ms, end_ms: unit.end_ms, ti: unit.ti, _part: arr.length > 1 ? i : -1 };
    });
  }

  function measureUnits(units, fontPx) {
    units.forEach(function (u) { u.w = measureFn(u.text, fontPx); u.h = fontPx * 0.96; });
  }

  function heroScore(u, centerBias) {
    var n = U.graphemes(u.text).length;
    var semantic = isCJKChar(u.text) ? 0.18 : Math.min(n * 0.08, 0.36);
    return semantic + centerBias * 0.18;
  }

  // 主入口
  function layout(tokens, opts) {
    var maxW = opts.maxW, fontPx = opts.fontPx;
    var seedBase = (tokens[0] && tokens[0].start_ms) || 0;
    var units = [];
    atomize(tokens).forEach(function (u) { fitUnit(u, maxW, fontPx).forEach(function (p) { units.push(p); }); });
    if (!units.length) return { width: 0, height: 0, placements: [] };
    measureUnits(units, fontPx);

    // 1) hero
    var heroIdx = 0, bestScore = -1;
    units.forEach(function (u, i) {
      var centerBias = 1 - Math.abs(i - (units.length - 1) / 2) / Math.max(1, units.length / 2);
      var s = heroScore(u, centerBias);
      if (s > bestScore && /\S/.test(u.text)) { bestScore = s; heroIdx = i; }
    });
    var heroBoost = 1 + U.clamp(bestScore - 0.48, 0, 0.52); // 1.0–1.52

    // 2) 分行（顺序流，hero 独占一行；行宽 maxW，CJK 可任意断，拉丁词整体）
    var gap = fontPx * 0.12, lineH = fontPx * 1.5;
    var rows = [[]];
    function pushRow(u) {
      var row = rows[rows.length - 1];
      var need = u.w + (row.length ? gap : 0);
      var used = row.reduce(function (a, x) { return a + x.w; }, 0) + (row.length ? gap * row.length : 0);
      if (used + need > maxW && row.length) rows.push(row = []);
      row.push(u);
    }
    units.forEach(function (u, i) {
      if (i === heroIdx) {
        if (rows[rows.length - 1].length) rows.push([]);
        rows[rows.length - 1].push(u);
        rows.push([]);
      } else pushRow(u);
    });
    rows = rows.filter(function (r) { return r.length; });

    // 3) 放置：行内居中；行高方向围绕 hero 行上下展开
    var heroRow = rows.findIndex(function (r) { return r.indexOf(units[heroIdx]) >= 0; });
    if (heroRow < 0) heroRow = 0;
    var placements = [], rowRects = [];
    rows.forEach(function (row, ri) {
      var rowW = row.reduce(function (a, u) { return a + u.w; }, 0) + gap * (row.length - 1);
      var startX = (maxW - rowW) / 2, cursor = startX;
      var y = (ri - heroRow) * lineH;
      var rect = { x1: startX, x2: startX + rowW, y1: y - fontPx * 0.42, y2: y + fontPx * 0.5 };
      row.forEach(function (u, ui) {
        var isHero = u === units[heroIdx];
        var rnd = function (off) { return U.srand(seedBase + u.ti + off + ri * 13 + ui * 7); };
        var scale = isHero ? U.clamp(1.18 * heroBoost, 1.18, 1.5) : (1 + rnd(1) * 0.12);
        var jitterX = isHero ? 0 : (rnd(2) - 0.5) * fontPx * 0.18;
        var x = cursor + jitterX;
        var place = {
          text: u.text, start_ms: u.start_ms, end_ms: u.end_ms,
          x: x, y: y - u.h * 0.5, w: u.w, h: u.h,
          rotate: (rnd(3) - 0.5) * (isHero ? 0 : 5),
          scale: scale, hero: isHero,
          entryX: (rnd(4) - 0.5) * fontPx * (isHero ? 0.4 : 0.9),
          entryY: (rnd(5) - 0.5) * fontPx * 0.9,
          passedRotate: (rnd(6) - 0.5) * 12,
          driftX: (rnd(7) - 0.5) * fontPx * 0.5,
          driftY: (rnd(8) - 0.5) * fontPx * 0.4
        };
        // 4) AABB 碰撞推让（含 scale 外扩）
        var pad = u.w * (scale - 1) / 2 + 4;
        var box = { x1: x - pad, x2: x + u.w + pad, y1: place.y - pad, y2: place.y + u.h + pad };
        for (var k = 0; k < placements.length; k += 1) {
          var o = placements[k];
          var opad = o.w * (o.scale - 1) / 2 + 4;
          var ob = { x1: o.x - opad, x2: o.x + o.w + opad, y1: o.y - opad, y2: o.y + o.h + opad };
          if (box.x1 < ob.x2 && box.x2 > ob.x1 && box.y1 < ob.y2 && box.y2 > ob.y1) {
            var pushDown = (ri % 2 === 0 ? 1 : -1) * lineH * 0.22;
            place.y += pushDown; box.y1 += pushDown; box.y2 += pushDown;
          }
        }
        placements.push(place);
        cursor += u.w + gap;
      });
      rowRects.push(rect);
    });

    // 5) 归一化原点到左上角
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    placements.forEach(function (p) {
      var pad = p.w * (p.scale - 1) / 2;
      minX = Math.min(minX, p.x - pad); maxX = Math.max(maxX, p.x + p.w + pad);
      minY = Math.min(minY, p.y - p.h / 2); maxY = Math.max(maxY, p.y + p.h / 2);
    });
    var offX = -minX, offY = -minY;
    placements.forEach(function (p) { p.x += offX; p.y += offY; });
    return { width: maxX - minX, height: maxY - minY, placements: placements };
  }

  return { configure: configure, installCanvasMeasure: installCanvasMeasure, layout: layout };
});
```

- [ ] **Step 2: Node 验证（注入假 measure：每字 10px）**

```
node -e "var L=require('./crates/vmusicd/web/folia/folia-textlayout.js'); L.configure({measure:function(t,px){return Array.from(t).length*10;}}); var toks=[]; for(var i=0;i<20;i++) toks.push({text:String.fromCharCode(0x7231+i%5),start_ms:i*300,end_ms:i*300+300}); var r=L.layout(toks,{maxW:300,fontPx:40}); if(!r.placements.length) throw new Error('empty'); var hero=r.placements.filter(function(p){return p.hero;}); if(hero.length!==1) throw new Error('hero'); var hit=0; r.placements.forEach(function(p,i){r.placements.slice(i+1).forEach(function(q){if(p.x<q.x+q.w&&p.x+p.w>q.x&&p.y<q.y+10&&p.y+10>q.y)hit++;});}); if(hit>4) throw new Error('overlap '+hit); console.log('layout ok units='+r.placements.length+' hero='+hero[0].text+' size='+Math.round(r.width)+'x'+Math.round(r.height));"
```
Expected: 输出 `layout ok units=20 hero=… size=…`，无异常（假测宽夹具下重叠计数 ≤4）。

- [ ] **Step 3: 检查点**。

---

## Task 4: folia.css 与 folia-bg.js（三档背景）

**Files:**
- Create: `crates/vmusicd/web/folia/folia.css`
- Create: `crates/vmusicd/web/folia/folia-bg.js`

### 4A. folia.css

- [ ] **Step 1: 创建样式表（完整代码）**

```css
/* SPDX-License-Identifier: MIT */
/* folia 歌词模式样式。命名空间 fl-，不改动 stage3d.css。 */

.fl-root { position: absolute; inset: 0; z-index: 1; overflow: hidden; pointer-events: none; }
.fl-root[hidden] { display: none !important; }
.fl-bg { position: absolute; inset: 0; overflow: hidden; background: #09090b; }
.fl-bg-layer { position: absolute; inset: 0; transition: opacity .8s ease; }

/* 几何形状 */
.fl-shape { position: absolute; will-change: transform; }
.fl-shape .fl-shape-inner { position: absolute; inset: 0; animation: fl-drift linear infinite; }
.fl-circle { border-radius: 50%; }
.fl-triangle { clip-path: polygon(50% 0%, 0% 100%, 100% 100%); }
.fl-cross { clip-path: polygon(20% 0%,0% 20%,30% 50%,0% 80%,20% 100%,50% 70%,80% 100%,100% 80%,70% 50%,100% 20%,80% 0%,50% 30%); }
@keyframes fl-drift {
  0%   { transform: translate(0, 0) rotate(0deg); }
  50%  { transform: translate(15px, -30px) rotate(180deg); }
  100% { transform: translate(0, 0) rotate(360deg); }
}
.fl-shape.fl-reverse .fl-shape-inner { animation-direction: reverse; }
.fl-particle { position: absolute; border-radius: 50%; animation: fl-rise linear infinite; }
@keyframes fl-rise { 0% { transform: translateY(0); opacity: 0; } 15% { opacity: var(--fl-po, .2); } 85% { opacity: var(--fl-po, .2); } 100% { transform: translateY(-100px); opacity: 0; } }
.fl-vignette { position: absolute; inset: 0; background: radial-gradient(circle, transparent 40%, rgba(0,0,0,.6) 100%); transition: opacity .6s ease; }
.fl-vignette[hidden] { display: none; }

/* 流体封面 */
.fl-fluid-wrap { position: absolute; inset: 0; overflow: hidden; }
.fl-fluid-img { position: absolute; inset: -10%; width: 120%; height: 120%; object-fit: cover;
  filter: blur(40px); transform: scale(1.25); will-change: opacity; }
.fl-fluid-tint { position: absolute; inset: 0; transition: opacity .3s ease, background-color 1s ease; }

/* 流光（容器对指针透明，词节点单独开放点击 seek） */
.fl-lyric { position: absolute; inset: 0; z-index: 2; pointer-events: none; }
.fl-classic { position: absolute; left: 0; right: 0; top: 15vh; height: 70vh;
  display: flex; align-items: center; justify-content: center; padding: 0 32px; pointer-events: none; }
.fl-cline { position: absolute; display: flex; flex-wrap: wrap; width: 100%; max-width: 1152px;
  min-height: 300px; align-content: center; justify-content: center; }
.fl-cword { position: relative; display: inline-block; white-space: nowrap; line-height: 1.22;
  font-weight: 700; will-change: transform, opacity, filter; cursor: pointer; pointer-events: auto; }
.fl-cword .fl-glow, .fl-cword .fl-body { display: block; }
.fl-cword .fl-glow { position: absolute; inset: 0; color: transparent; pointer-events: none; z-index: 0; white-space: pre; }
.fl-cword .fl-body { position: relative; z-index: 1; }
.fl-cword[data-st='waiting'] .fl-body { filter: blur(10px); transition: filter .4s ease, color .4s ease; }
.fl-cword[data-st='active'] .fl-body { transition: color var(--fl-dur, 200ms) linear, filter var(--fl-blur-dur, 200ms) ease; }
.fl-cword[data-st='passed'] .fl-body { transition: color var(--fl-color-back, 800ms) easeInOut, filter .5s ease; }
.fl-cword[data-st='waiting'] { opacity: 0; transition: opacity .4s ease, transform .4s ease; }
.fl-cword[data-st='active'] { opacity: 1; transition: opacity .1s ease, transform .45s cubic-bezier(.34,1.56,.64,1); }
.fl-cword[data-st='passed'] { opacity: .82; transition: opacity .5s ease, transform .5s ease; }
/* 辉光半径由 --fl-r1/--fl-r2 按 reveal 模式给（normal 20/40，fast 18/32，instant 14/24）。 */
@keyframes fl-glow-pulse {
  0% { text-shadow: none; }
  30%, 90% { text-shadow: 0 0 var(--fl-r1, 20px) var(--fl-accent), 0 0 var(--fl-r2, 40px) var(--fl-accent); }
  100% { text-shadow: 0 0 var(--fl-r1, 20px) var(--fl-accent), 0 0 var(--fl-r2, 40px) var(--fl-accent); }
}
/* 辉光始终由字素 span 承载（单字词也包一层 span），多字词逐字 delay 错峰。 */
.fl-cword[data-st='active'] .fl-glow > span {
  animation-name: fl-glow-pulse; animation-timing-function: easeInOut; animation-fill-mode: both;
  animation-duration: var(--fl-dur, 200ms); animation-delay: var(--fl-delay, 0ms);
}
.fl-cword[data-st='passed'] .fl-glow > span { text-shadow: none; transition: text-shadow var(--fl-glow-back, 900ms) easeOut; }
/* 呼吸挂在常驻的 .fl-classic 外层，行进入/退出动画挂在内层 .fl-cline，两者不抢 transform。 */
.fl-classic.fl-cbreath { animation: fl-breath var(--fl-breath-dur, 7s) easeInOut infinite; }
@keyframes fl-breath {
  0% { transform: translateY(0) scale(1); }
  25% { transform: translateY(calc(var(--fl-breath-amp, 14px) * -1)) scale(1.01); }
  50% { transform: translateY(0) scale(1); }
  75% { transform: translateY(calc(var(--fl-breath-amp, 14px) * .45)) scale(.995); }
  100% { transform: translateY(0) scale(1); }
}
@keyframes fl-line-in { from { opacity: 0; transform: scale(.9); filter: blur(10px); } to { opacity: 1; transform: scale(1); filter: blur(0); } }
@keyframes fl-line-out { from { opacity: 1; transform: scale(1); filter: blur(0); } to { opacity: 0; transform: scale(1.1); filter: blur(20px); } }
.fl-line-enter { animation: fl-line-in var(--fl-line-enter, 350ms) ease-out both; }
.fl-line-exit { animation: fl-line-out var(--fl-line-exit, 300ms) ease both forwards; }
.fl-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  text-align: center; opacity: .5; }

/* 心象 */
.fl-cadenza { position: absolute; inset: 0; z-index: 2; pointer-events: none; }
.fl-cadz-canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.fl-cadz { position: absolute; z-index: 2; will-change: transform, opacity; cursor: pointer; pointer-events: auto; }
.fl-cadz .fl-glow { position: absolute; inset: 0; color: transparent; pointer-events: none; z-index: 0; white-space: pre; }
.fl-cadz .fl-body { position: relative; z-index: 1; white-space: pre; }

/* 字幕条 */
.fl-sub { position: absolute; left: 0; right: 0; bottom: calc(118px + env(safe-area-inset-bottom));
  z-index: 5; text-align: center; padding: 0 32px; pointer-events: none; }
.fl-sub[hidden] { display: none; }
.fl-sub-card { position: relative; display: inline-block; max-width: 860px; padding: 2px 6px; }
.fl-sub-glow { position: absolute; inset: -24px -40px; z-index: 0; border-radius: 50%;
  background: radial-gradient(ellipse 115% 130% at center, rgba(9,9,11,.96) 0%, rgba(9,9,11,.78) 62%, transparent 100%);
  filter: blur(24px); }
.fl-sub-text { position: relative; z-index: 1; font-weight: 500; transition: opacity .24s ease, transform .24s ease; }
.fl-sub-next { opacity: .55; filter: blur(1px); margin-top: 8px; }
.fl-sub-anim { animation: fl-sub-in .24s ease-out both; }
@keyframes fl-sub-in { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }

/* reduced：关闭循环运动，保留染色（染色走 transition，不依赖被全局禁用的 animation）。 */
.s3d-reduced .fl-cbreath, .s3d-reduced .fl-shape-inner, .s3d-reduced .fl-particle { animation: none !important; }
.s3d-reduced .fl-cword[data-st='active'] .fl-glow,
.s3d-reduced .fl-cadz[data-st='active'] .fl-glow { animation: none !important; text-shadow: 0 0 9px var(--fl-accent); }

/* 平面模式：停用 3D 画布的视觉层与歌词轨（DOM 仍在，手势入口由 JS 短路） */
.s3d-plane .s3d-canvas-wrap canvas { visibility: hidden; }
.s3d-plane .s3d-reading { display: none !important; }

@media (max-width: 760px) {
  .fl-classic { padding: 0 16px; }
  .fl-sub { padding: 0 16px; bottom: calc(104px + env(safe-area-inset-bottom)); }
  .fl-sub-card { max-width: calc(100vw - 48px); }
  .fl-sub-next ~ .fl-sub-next { display: none; } /* 窄屏预告只留 1 行 */
}
/* 横屏矮窗：歌词区收高，给底部字幕/播放坞让位 */
@media (max-height: 500px) {
  .fl-classic { top: 21vh; height: 58vh; }
  .fl-sub { bottom: calc(96px + env(safe-area-inset-bottom)); }
}
@media (max-width: 380px) {
  /* 窄屏固定收敛（与 eco 无关）：形状保留 6 个，粒子上升全关。 */
  .fl-bg .fl-shape:nth-child(n+7) { display: none !important; }
  .fl-bg .fl-particle { display: none !important; }
}
```

### 4B. folia-bg.js

- [ ] **Step 2: 创建背景模块（完整代码）**

```js
// SPDX-License-Identifier: MIT
// folia common 背景三档：geometric / fluid / solid。频段缩放走外部 frame(dt) 低通。
(function (global) {
  'use strict';
  if (typeof window === 'undefined') return;
  var U = global.FoliaUtil;

  function init(host) {
    var layer = document.createElement('div');
    layer.className = 'fl-bg-layer';
    var shapeLayer = document.createElement('div'); shapeLayer.className = 'fl-bg-layer';
    var fluidWrap = document.createElement('div'); fluidWrap.className = 'fl-fluid-wrap'; fluidWrap.hidden = true;
    var tint = document.createElement('div'); tint.className = 'fl-fluid-tint'; tint.hidden = true;
    var vignette = document.createElement('div'); vignette.className = 'fl-vignette';
    host.append(layer, fluidWrap, vignette);
    fluidWrap.append(tint);

    var mode = 'geometric', opacity = 0.75, vignetteOn = true, paused = false, eco = false;
    var theme = FoliaTheme.DEFAULT;
    var shapes = [], particles = [], coverUrl = null;
    var scaleSmooth = { bass: 1, lowMid: 1, mid: 1, treble: 1 };

    function rnd(seed, off) { return U.srand(seed + off); }
    function buildShapes() {
      shapes.forEach(function (s) { s.el.remove(); });
      particles.forEach(function (p) { p.el.remove(); });
      shapes = []; particles = [];
      var seed = Date.now ? 0 : 0;
      var types = ['circle', 'square', 'triangle', 'cross'];
      var n = eco ? 8 : 15, pn = eco ? 10 : 20;
      for (var i = 0; i < n; i += 1) {
        var s = Math.floor(rnd(i * 3.1, 1) * 9000) + i;
        var type = types[Math.floor(rnd(s, 2) * types.length)];
        var el = document.createElement('div');
        var inner = document.createElement('div');
        inner.className = 'fl-shape-inner';
        el.className = 'fl-shape fl-' + type + (rnd(s, 3) > 0.5 ? ' fl-reverse' : '');
        var size = 40 + rnd(s, 4) * 100;
        var filled = rnd(s, 5) < 0.3;
        el.style.left = (rnd(s, 6) * 100) + '%';
        el.style.top = (rnd(s, 7) * 100) + '%';
        el.style.width = size + 'px'; el.style.height = size + 'px';
        el.style.opacity = (0.11 + rnd(s, 8) * 0.08);
        inner.style.background = filled ? theme.secondaryColor : 'transparent';
        if (!filled && type === 'circle') inner.style.border = '1px solid ' + theme.secondaryColor;
        else if (!filled) inner.style.background = theme.secondaryColor;
        var dur = 30 + rnd(s, 9) * 30;
        inner.style.animationDuration = dur + 's';
        inner.style.animationDelay = (rnd(s, 10) * 5) + 's';
        el.append(inner); shapeLayer.append(el);
        shapes.push({ el: el, inner: inner, band: ['bass','bass','lowMid','mid','treble'][types.indexOf(type)], base: 1 });
      }
      for (var j = 0; j < pn; j += 1) {
        var q = Math.floor(rnd(j * 7.7, 11) * 9000) + j;
        var p = document.createElement('div');
        p.className = 'fl-particle';
        var psize = 1 + rnd(q, 12) * 4;
        p.style.width = psize + 'px'; p.style.height = psize + 'px';
        p.style.left = (rnd(q, 13) * 100) + '%'; p.style.top = (rnd(q, 14) * 100) + '%';
        p.style.setProperty('--fl-po', String(rnd(q, 15) * 0.3));
        p.style.background = theme.accentColor;
        p.style.animationDuration = (15 + rnd(q, 16) * 20) + 's';
        p.style.animationDelay = (rnd(q, 17) * 10) + 's';
        shapeLayer.append(p); particles.push({ el: p });
      }
    }

    function paintTheme() {
      layer.style.background = theme.backgroundColor;
      shapes.forEach(function (s) {
        var inner = s.inner;
        if (inner.style.border) inner.style.borderColor = theme.secondaryColor;
        else inner.style.background = theme.secondaryColor;
      });
      particles.forEach(function (p) { p.el.style.background = theme.accentColor; });
    }

    // 封面降采样（长边 384），失败回退原图
    function downscale(url) {
      return new Promise(function (resolve) {
        var img = new Image();
        img.crossOrigin = 'anonymous'; img.decoding = 'async';
        img.onload = function () {
          try {
            var nw = img.naturalWidth || img.width, nh = img.naturalHeight || img.nHeight;
            var sc = Math.min(1, 384 / Math.max(nw, nh));
            var c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(nw * sc)); c.height = Math.max(1, Math.round(nh * sc));
            var ctx = c.getContext('2d');
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, c.width, c.height);
            resolve(c.toDataURL('image/jpeg', 0.82));
          } catch (e) { resolve(url); }
        };
        img.onerror = function () { resolve(url); };
        img.src = url;
      });
    }
    var fluidImgs = [];
    function setCover(url) {
      coverUrl = url;
      if (mode !== 'fluid' || !url) {
        fluidImgs.forEach(function (x) { x.el.remove(); }); fluidImgs = [];
        return;
      }
      downscale(url).then(function (src) {
        if (mode !== 'fluid' || coverUrl !== url) return;
        var el = document.createElement('img');
        el.className = 'fl-fluid-img'; el.src = src; el.alt = '';
        el.style.opacity = '0';
        fluidWrap.prepend(el);
        requestAnimationFrame(function () { el.style.opacity = '1'; });
        fluidImgs.push({ el: el, url: url });
        if (fluidImgs.length > 2) { var old = fluidImgs.shift();
          old.el.style.opacity = '0'; setTimeout(function () { old.el.remove(); }, 800); }
      });
    }

    function applyMode() {
      shapeLayer.hidden = mode !== 'geometric';
      fluidWrap.hidden = mode !== 'fluid';
      tint.hidden = mode !== 'fluid';
      if (!shapeLayer.parentElement && mode === 'geometric') host.insertBefore(shapeLayer, vignette);
      if (mode === 'geometric') buildShapes();
      if (mode === 'fluid' && coverUrl) setCover(coverUrl);
      if (mode !== 'fluid') { fluidImgs.forEach(function (x) { x.el.remove(); }); fluidImgs = []; }
    }

    // hertz 的 Stage 只导出 0–1 的 energy 与原始 FFT 数组 spectrum()；
    // 不同形状按频段给轻微系数差（无细分频段数据时退化为 energy）。
    var BAND_MUL = { bass: 1.12, lowMid: 1.0, mid: 0.9, treble: 0.78 };
    function bandLevel(name) {
      var e = global.Stage && Stage.energy ? Stage.energy() : 0;
      var bins = global.Stage && Stage.spectrum ? Stage.spectrum() : null;
      if (bins && bins.length) {
        var pick = { bass: 0.06, lowMid: 0.22, mid: 0.5, treble: 0.82 }[name];
        var i = Math.min(bins.length - 1, Math.floor(pick * bins.length));
        e = Math.max(e, Number(bins[i]) || 0); // bins 约定为 0–1
      }
      return U.clamp(e * BAND_MUL[name], 0, 1);
    }
    function frame(dtMs) {
      if (mode === 'geometric' && !paused && global.Stage) {
        Object.keys(scaleSmooth).forEach(function (k) {
          var target = U.lerp(0.95, 1.45, bandLevel(k));
          scaleSmooth[k] = U.damp(scaleSmooth[k], target, 90, dtMs);
        });
        shapes.forEach(function (s) {
          s.el.style.transform = 'scale(' + scaleSmooth[s.band].toFixed(3) + ')';
        });
      } else if (mode === 'fluid' && !paused && global.Stage) {
        var e = Stage.energy ? Stage.energy() : 0;
        fluidWrap.style.transform = 'scale(' + (1 + e * 0.03).toFixed(3) + ')';
      }
    }

    var api = {
      setTheme: function (t) { theme = t; paintTheme(); },
      // 相同模式不重建形状场（applyFoliaConfig 每 8fps 会调用一次）。
      setMode: function (m) {
        m = (m === 'fluid' || m === 'solid') ? m : 'geometric';
        if (m === mode) return;
        mode = m; applyMode();
      },
      setOpacity: function (v) { opacity = U.clamp(v, 0, 1); tint.style.opacity = String(1 - opacity); },
      setVignette: function (b) { vignetteOn = b; vignette.hidden = !b; },
      setCover: setCover,
      setPaused: function (b) {
        paused = b;
        var p = paused ? 'paused' : 'running';
        shapes.forEach(function (s) { s.inner.style.animationPlayState = p; });
        particles.forEach(function (x) { x.el.style.animationPlayState = p; });
      },
      setEco: function (b) { if (eco !== b) { eco = b; buildShapes(); paintTheme(); } },
      frame: frame,
      destroy: function () { layer.remove(); shapeLayer.remove(); fluidWrap.remove(); vignette.remove(); }
    };
    // tint 用背景色压在封面上：不透明度语义与 folia 一致（opacity=.75 表示主题色遮罩 25%）
    tint.style.background = theme.backgroundColor;
    tint.style.opacity = String(1 - opacity);
    vignette.hidden = !vignetteOn;
    applyMode();
    paintTheme();
    return api;
  }

  global.FoliaBg = { init: init };
})(window);
```

> 说明：folia 的"封面底色浓度 .75"语义是**主题色层不透明度 .25**（封面透显 75%）；`setOpacity(.75)` 时 tint opacity=.25，与上面代码一致。eco 类在 host（fl-root）上切换：Task 9 调用 `setEco` 时同步 `root.classList`，本模块内部形状数量已按 eco 收敛。

- [ ] **Step 3: 浏览器冒烟**：启动 vmusicd，进入舞台后在控制台执行 `window.FoliaBg && document.querySelectorAll('#s3d-folia .fl-shape').length`（T8/T9 接线前可先临时手动 `FoliaBg.init(document.body)`），确认几何形状生成无报错、三档 `setMode` 切换正常。

- [ ] **Step 4: 检查点**。

---

## Task 5: folia-subtitle.js — 底部字幕条

**Files:**
- Create: `crates/vmusicd/web/folia/folia-subtitle.js`

内容优先级（spec 8）：当前行翻译 → 空档最近完成行翻译 → 未来两行原文预告；过滤无字母数字行。

- [ ] **Step 1: 创建模块（完整代码）**

```js
// SPDX-License-Identifier: MIT
// 底部字幕条：翻译 / 最近完成句翻译 / 下两句预告。
(function (global) {
  'use strict';
  if (typeof window === 'undefined') return;
  var U = global.FoliaUtil;

  function init(host) {
    var card = document.createElement('div');
    card.className = 'fl-sub-card';
    var glow = document.createElement('div'); glow.className = 'fl-sub-glow'; glow.hidden = true;
    var text = document.createElement('div'); text.className = 'fl-sub-text';
    card.append(glow, text);
    host.append(card);

    function paintGlow() {
      glow.style.background = 'radial-gradient(ellipse 115% 130% at center,' +
        U.withAlpha(theme.backgroundColor, 0.96) + ' 0%,' +
        U.withAlpha(theme.backgroundColor, 0.78) + ' 62%,transparent 100%)';
    }

    var theme = FoliaTheme.DEFAULT, visible = true, fontScale = 1, glowBg = true;
    var lastKey = '';

    // 直接复刻 folia 的 clamp：min / vw / max 三段
    function fs(minRem, vw, maxRem) {
      return 'clamp(' + (minRem * fontScale).toFixed(3) + 'rem,' + (vw * fontScale).toFixed(3) + 'vw,' +
        (maxRem * fontScale).toFixed(3) + 'rem)';
    }

    function upcomingLines(lines, index, tMs) {
      var out = [];
      if (index >= 0) {
        for (var i = index + 1; i < lines.length && out.length < 2; i += 1) {
          if (U.hasReadable(lines[i].text)) out.push(lines[i]);
        }
      } else {
        for (var j = 0; j < lines.length && out.length < 2; j += 1) {
          if (lines[j].start_ms > tMs && U.hasReadable(lines[j].text)) out.push(lines[j]);
        }
      }
      return out;
    }

    function update() {
      host.hidden = !visible;
      if (!visible || !global.Stage) return;
      var doc = Stage.lyrics();
      var tMs = Stage.position();
      var lines = doc ? doc.lines : [];
      var index = doc ? doc.index : -1;
      var content = null, kind = 'trans';
      var tr = index >= 0 ? Stage.lyricTranslation(index) : null;
      if (U.hasReadable(tr)) {
        content = [{ t: tr, next: false }];
      } else if (index < 0) {
        // 空档：最近完成行翻译
        for (var k = lines.length - 1; k >= 0; k -= 1) {
          if (tMs > (lines[k].end_ms != null ? lines[k].end_ms : lines[k].start_ms)) {
            var rt = Stage.lyricTranslation(k);
            if (U.hasReadable(rt)) { content = [{ t: rt, next: false }]; break; }
          }
        }
      }
      if (!content) {
        var ups = upcomingLines(lines, index, tMs);
        if (ups.length) { content = ups.map(function (l) { return { t: l.text, next: true }; }); kind = 'next'; }
      }
      var key = content ? content.map(function (c) { return c.t; }).join('|') + ':' + kind : 'empty';
      if (key === lastKey) return;
      lastKey = key;
      text.innerHTML = '';
      glow.hidden = !glowBg;
      if (glowBg) paintGlow();
      if (!content) { host.hidden = true; return; }
      host.hidden = false;
      content.forEach(function (c, i) {
        var div = document.createElement('div');
        div.className = 'fl-sub-anim' + (c.next ? ' fl-sub-next' : '');
        div.style.color = theme.secondaryColor;
        div.style.fontFamily = FoliaTheme.fontStack(theme.fontStyle);
        div.style.fontSize = fs(c.next ? 0.875 : 1.125, c.next ? 2 : 2.6, c.next ? 1 : 1.25);
        div.textContent = c.t;
        text.append(div);
      });
    }

    return {
      update: update,
      setTheme: function (t) { theme = t; lastKey = ''; paintGlow(); },
      setFontScale: function (v) { fontScale = v; lastKey = ''; },
      setVisible: function (b) { visible = b; host.hidden = !b; if (b) lastKey = ''; },
      setGlowBackground: function (b) { glowBg = b; lastKey = ''; },
      setPaused: function () {}, setEco: function () {}, resize: function () { lastKey = ''; },
      destroy: function () { card.remove(); }
    };
  }
  global.FoliaSubtitle = { init: init };
})(window);
```

- [ ] **Step 2: 检查点**（接线后随 Task 9 联调目测：有翻译显翻译；无翻译显预告）。

---

## Task 6: folia-classic.js — 流光渲染器

**Files:**
- Create: `crates/vmusicd/web/folia/folia-classic.js`

要点（spec 6）：单行；每词等待/激活/唱过三态；辉光层逐字 span（带 delay）；整行呼吸；行进入/退出动画类；间奏；点击 seek。

- [ ] **Step 1: 创建模块（完整代码）**

```js
// SPDX-License-Identifier: MIT
// 流光 classic：单行逐词三态。JS 只翻状态/写 CSS 变量，过渡与辉光全交 CSS。
(function (global) {
  'use strict';
  if (typeof window === 'undefined') return;
  var U = global.FoliaUtil;

  function init(host, onSeek) {
    var root = document.createElement('div'); root.className = 'fl-classic';
    var lineEl = null, emptyEl = null;
    var theme = FoliaTheme.DEFAULT, fontScale = 1, visible = true, paused = false;
    var tuning = { rotation: true, breathing: 1, spacing: 0.7 };
    var curLine = null, curHints = null, measureCanvas = null;

    function fontPx(viewportW) {
      var minPx = 2.25 * fontScale * 16;
      var valPx = 6 * fontScale * viewportW / 100;
      var maxPx = 4.5 * fontScale * 16;
      return Math.max(minPx, Math.min(valPx, maxPx));
    }
    function measure(text, px) {
      if (!measureCanvas) measureCanvas = document.createElement('canvas');
      var ctx = measureCanvas.getContext('2d');
      ctx.font = '700 ' + px + 'px ' + FoliaTheme.fontStack(theme.fontStyle);
      return ctx.measureText(text).width;
    }

    function rand(seed, off) { return U.srand(seed + off); }

    function buildLine(line) {
      if (lineEl) { lineEl.remove(); lineEl = null; }
      var tokens = Stage.lyricTokens(line);
      var isInterlude = !U.hasReadable(line.text);
      var container = document.createElement('div');
      container.className = 'fl-cline fl-line-enter';
      var px = fontPx(global.innerWidth || 1200);
      container.style.fontSize = px + 'px';
      // 呼吸作用于常驻外层 root，避免与行进入/退出动画抢同一元素的 transform。
      root.classList.add('fl-cbreath');
      root.style.setProperty('--fl-breath-amp',
        ((theme.animationIntensity === 'calm' ? 10 : theme.animationIntensity === 'chaotic' ? 18 : 14) * tuning.breathing) + 'px');
      root.style.setProperty('--fl-breath-dur',
        (theme.animationIntensity === 'calm' ? 8.5 : theme.animationIntensity === 'chaotic' ? 5.8 : 7) + 's');
      root.style.animationPlayState = (tuning.breathing <= 0 || paused) ? 'paused' : 'running';
      container.style.setProperty('--fl-accent', theme.accentColor);
      curHints = U.renderHints(line);

      var dispTokens = tokens;
      var widths = dispTokens.map(function (w) { return measure(w.text, px); });
      var chaotic = theme.animationIntensity === 'chaotic';
      var calm = theme.animationIntensity === 'calm';
      var narrow = (global.innerWidth || 1200) < 760;
      var baseSpread = (chaotic ? 60 : calm ? 0 : 20) * (narrow ? 0.6 : 1);
      var activeScaleMul = narrow ? 1.28 : 1.4;   // folia 窄屏收敛
      var seed = line.start_ms;

      dispTokens.forEach(function (w, i) {
        var wordSeed = seed / 1000 + i; // folia 用秒级 seed
        var r = function (off) { return rand(wordSeed, off); };
        var scaleCfg = chaotic ? 0.8 + r(4) * 0.6 : 1.1 + r(4) * 0.2;
        var x = (r(1) - 0.5) * baseSpread * 2;
        var y = (r(2) - 0.5) * baseSpread * 2;
        var rotate = tuning.rotation ? (r(3) - 0.5) * (chaotic ? 60 : calm ? 0 : 10) : 0;
        var passedRotate = tuning.rotation ? (r(8) - 0.5) * 45 : 0;
        // 精确词距（folia 新版排版）
        var wi = widths[i] || 0, si = scaleCfg * activeScaleMul;
        var wnext = 0, snext = 1, xnext = 0;
        if (i + 1 < dispTokens.length) {
          var ns = seed / 1000 + i + 1, nr = function (o) { return rand(ns, o); };
          snext = (chaotic ? 0.8 + nr(4) * 0.6 : 1.1 + nr(4) * 0.2) * activeScaleMul;
          xnext = (nr(1) - 0.5) * baseSpread * 2;
          wnext = widths[i + 1] || 0;
        }
        var gap = 0.05 * px;
        var calc = (wi * (si - 1) / 2 + wnext * (snext - 1) / 2 + (x - xnext) + gap) * tuning.spacing;
        var minM = (chaotic ? 0.08 : 0.12) * px * tuning.spacing;
        var margin = Math.max(minM, calc);

        var wordEl = document.createElement('span');
        wordEl.className = 'fl-cword';
        wordEl.dataset.st = 'waiting';
        wordEl.style.fontSize = px + 'px';
        wordEl.style.fontFamily = FoliaTheme.fontStack(theme.fontStyle);
        wordEl.style.marginRight = (isInterlude ? 48 /* folia: 3rem */ : margin) + 'px';
        wordEl.style.setProperty('--fl-x', x + 'px');
        wordEl.style.setProperty('--fl-y', y + 'px');
        wordEl.style.setProperty('--fl-rot', rotate + 'deg');
        wordEl._cfg = { x: x, y: y, rotate: rotate, scale: isInterlude ? 1.5 : scaleCfg, passedRotate: passedRotate };
        wordEl._word = w; wordEl._line = line;

        var glow = document.createElement('span'); glow.className = 'fl-glow';
        var body = document.createElement('span'); body.className = 'fl-body';
        var color = FoliaTheme.wordColor(w.text, theme);
        body.style.color = theme.primaryColor;
        glow.style.setProperty('--fl-accent', color);
        wordEl.style.setProperty('--fl-accent', color);

        // 辉光始终逐字素包 span：单字词语义/动画统一，多字词内联时长/延迟错峰。
        U.graphemeTimings(w).forEach(function (g, gi, all) {
          var gs = document.createElement('span');
          gs.textContent = g.char;
          if (all.length > 1) {
            gs.style.animationDelay = Math.max(0, g.start_ms - w.start_ms) + 'ms';
            gs.style.animationDuration = Math.max(80, (g.end_ms - g.start_ms) * 6) + 'ms';
          }
          glow.append(gs);
        });
        body.textContent = w.text;
        wordEl.append(glow, body);
        wordEl.addEventListener('click', function (e) {
          e.stopPropagation();
          if (typeof line.start_ms === 'number' && onSeek) onSeek(line.start_ms);
        });
        applyPose(wordEl, 'waiting');
        container.append(wordEl);
      });

      root.append(container);
      lineEl = container;
      lineEl._tokens = dispTokens;
      lineEl._words = Array.prototype.slice.call(container.querySelectorAll('.fl-cword'));
    }

    function applyPose(el, st) {
      var cfg = el._cfg;
      if (st === 'waiting') {
        // folia 原公式：x + sin(y)·100，y + cos(x)·50（cfg 单位即 px）。
        el.style.transform = 'translate(' + (cfg.x + Math.sin(cfg.y) * 100) + 'px,' +
          (cfg.y + Math.cos(cfg.x) * 50) + 'px) scale(.5) rotate(' + (cfg.rotate + 20) + 'deg)';
      } else if (st === 'active') {
        var mul = (global.innerWidth || 1200) < 760 ? 1.28 : 1.4;
        el.style.transform = 'translate(' + cfg.x + 'px,' + cfg.y + 'px) scale(' +
          (cfg.scale * mul).toFixed(3) + ') rotate(' + cfg.rotate + 'deg)';
      } else {
        el.style.transform = 'translate(' + cfg.x + 'px,' + cfg.y + 'px) scale(' +
          cfg.scale.toFixed(3) + ') rotate(' + (cfg.rotate + cfg.passedRotate) + 'deg)';
        el.style.opacity = theme.animationIntensity === 'chaotic' ? '0.9' : '0.82';
      }
      el.dataset.st = st;
    }

    function buildEmpty() {
      if (emptyEl) return;
      emptyEl = document.createElement('div');
      emptyEl.className = 'fl-empty';
      emptyEl.style.color = theme.secondaryColor;
      emptyEl.style.fontSize = 'clamp(' + (1.5 * fontScale).toFixed(3) + 'rem,' +
        (3.5 * fontScale).toFixed(3) + 'vw,' + (2.25 * fontScale).toFixed(3) + 'rem)';
      emptyEl.textContent = global.Stage && Stage.presentation && Stage.presentation().track ? '暂无歌词 · 让旋律继续' : '在声音里，发现另一片宇宙';
      root.append(emptyEl);
    }

    function frame() {
      if (!visible || !global.Stage) return;
      var doc = Stage.lyrics();
      var tMs = Stage.position();
      var line = doc && doc.index >= 0 ? doc.lines[doc.index] : null;
      if (line !== curLine) {
        if (lineEl) {
          var old = lineEl;
          // popLayout：退出行脱离文档流，不挤掉新行的居中位置。
          old.style.position = 'absolute';
          old.classList.remove('fl-line-enter');
          old.classList.add('fl-line-exit');
          setTimeout(function () { old.remove(); }, curHints ? curHints.exitMs : 300);
          lineEl = null;
        }
        curLine = line;
        if (line) buildLine(line);
      }
      if (emptyEl) { emptyEl.remove(); emptyEl = null; }
      if (!line) { buildEmpty(); return; }
      if (!lineEl || !curHints) return;
      var words = lineEl._words, tokens = lineEl._tokens;
      for (var i = 0; i < words.length; i += 1) {
        var st = U.wordState(tokens[i], curHints, line, tMs);
        if (words[i].dataset.st !== st) {
          var w = tokens[i];
          var dur = Math.max(w.end_ms - w.start_ms, curHints.revealMode === 'instant' ? 80 : curHints.revealMode === 'fast' ? 120 : 100);
          words[i].style.setProperty('--fl-dur', Math.round(dur) + 'ms');
          var radii = curHints.revealMode === 'instant' ? [14, 24] : curHints.revealMode === 'fast' ? [18, 32] : [20, 40];
          words[i].style.setProperty('--fl-r1', radii[0] + 'px');
          words[i].style.setProperty('--fl-r2', radii[1] + 'px');
          words[i].style.setProperty('--fl-blur-dur', curHints.revealMode === 'instant' ? '80ms' : curHints.revealMode === 'fast' ? '120ms' : '200ms');
          words[i].style.setProperty('--fl-color-back', curHints.revealMode === 'instant' ? '120ms' : curHints.revealMode === 'fast' ? '240ms' : '800ms');
          words[i].style.setProperty('--fl-glow-back', curHints.revealMode === 'instant' ? '120ms' : curHints.revealMode === 'fast' ? '220ms' : '900ms');
          words[i].querySelector('.fl-body').style.color = st === 'waiting' ? theme.primaryColor :
            (st === 'active' ? FoliaTheme.wordColor(w.text, theme) : theme.primaryColor);
          if (st !== 'passed') words[i].style.opacity = '';
          applyPose(words[i], st);
        }
      }
    }

    host.append(root);
    return {
      frame: frame,
      // 8fps 元数据 gate：行变更由 frame 依据 Stage 行号自行检测，这里不得重建行。
      update: function () {},
      setTheme: function (t) { theme = t; curLine = null; },
      setFontScale: function (v) { v = U.clamp(v, 0.7, 1.5); if (Math.abs(v - fontScale) < 1e-6) return; fontScale = v; curLine = null; },
      setVisible: function (b) { visible = b; root.hidden = !b; },
      setPaused: function (b) {
        paused = b;
        root.style.animationPlayState = (tuning.breathing <= 0 || paused) ? 'paused' : 'running';
      },
      setEco: function () {},
      setTuning: function (t) {
        var next = { rotation: t.rotation !== false,
          breathing: U.clamp(t.breathing != null ? t.breathing : 1, 0, 2),
          spacing: U.clamp(t.spacing != null ? t.spacing : 0.7, 0, 2) };
        if (next.rotation === tuning.rotation && next.breathing === tuning.breathing && next.spacing === tuning.spacing) return;
        tuning = next; curLine = null;
      },
      resize: function () { curLine = null; },
      destroy: function () { root.remove(); }
    };
  }
  global.FoliaClassic = { init: init };
})(window);
```

> 注意：`el.dataset.st` 翻转时会重新触发 CSS transition/animation，这是复刻 folia"仅状态翻转时改 DOM"的关键；`frame()` 每帧跑但只在状态变化时写样式。逗号表达式 `emptyEl.remove(), emptyEl = null;` 为合法 ES5 写法，执行时若 lint 报错可改写为两行。

- [ ] **Step 2: 检查点**（联调时确认：逐词点亮/辉光、唱过回落、行切模糊、暂停冻结）。

---

## Task 7: folia-cadenza.js — 心象渲染器

**Files:**
- Create: `crates/vmusicd/web/folia/folia-cadenza.js`

要点（spec 7）：active + 预热行；FoliaTextLayout 放置；DOM 层每 placement 一个 `.fl-cadz`（glow+body）；canvas 胶囊光束（beam 默认 0）；rAF 低通向目标姿态插值。

- [ ] **Step 1: 创建模块（完整代码）**

```js
// SPDX-License-Identifier: MIT
// 心象 cadenza：排版放置 → DOM 层 + canvas 光束层；姿态逐帧低通插值。
(function (global) {
  'use strict';
  if (typeof window === 'undefined') return;
  var U = global.FoliaUtil;

  function init(host, onSeek) {
    FoliaTextLayout.installCanvasMeasure(FoliaTheme.fontStack('sans'), 700);
    var wrap = document.createElement('div'); wrap.className = 'fl-cadenza';
    var canvas = document.createElement('canvas'); canvas.className = 'fl-cadz-canvas';
    var ctx = canvas.getContext('2d');
    var dom = document.createElement('div'); dom.style.position = 'absolute'; dom.style.inset = '0';
    wrap.append(canvas, dom);
    host.append(wrap);

    var theme = FoliaTheme.DEFAULT, fontScale = 1.12, visible = true, paused = false, eco = false;
    var tuning = { width: 0.72, motion: 1, glow: 1, beam: 0 };
    var cur = null;          // {line, hints, pack, nodes[]}
    var W = 0, H = 0, dpr = 1;

    function resize() {
      var r = host.getBoundingClientRect();
      W = r.width; H = r.height;
      dpr = Math.min(global.devicePixelRatio || 1, eco ? 1.5 : 2);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (cur) cur._dirty = true;
    }
    var ro = global.ResizeObserver && new ResizeObserver(resize);
    if (ro) ro.observe(host);
    resize();

    function baseFontPx() {
      var vw = W || global.innerWidth || 1200;
      return U.clamp(vw * 0.086 * fontScale, 34 * fontScale, 94 * fontScale);
    }

    function packLine(line) {
      var tokens = Stage.lyricTokens(line);
      var fontPx = baseFontPx();
      var graphemeCount = tokens.reduce(function (a, t) { return a + U.graphemes(t.text).length; }, 0);
      if (graphemeCount > 12) fontPx *= U.clamp(0.92 - (graphemeCount - 12) * 0.018, 0.62, 0.92);
      // 窄屏排版宽度下限提到 0.88（spec 10.2）。
      var widthRatio = W < 760 ? Math.max(0.88, tuning.width) : tuning.width;
      var maxW = W * widthRatio;
      FoliaTextLayout.installCanvasMeasure(FoliaTheme.fontStack(theme.fontStyle), 700);
      var laid = FoliaTextLayout.layout(tokens, { maxW: maxW, fontPx: fontPx });
      return { line: line, hints: U.renderHints(line), tokens: tokens, laid: laid, fontPx: fontPx };
    }

    function mount(pack) {
      dom.innerHTML = '';
      pack.nodes = pack.laid.placements.map(function (p) {
        var el = document.createElement('div');
        el.className = 'fl-cadz';
        // 定位全部由 frame 的 transform 给出（left/top 锚 0，避免位移被叠加两次）。
        el.style.left = '0';
        el.style.top = '0';
        var narrowHero = p.hero && W < 760 ? 0.85 : 1;   // 窄屏 hero 尺寸上限收 15%
        el.style.fontSize = (pack.fontPx * p.scale * narrowHero) + 'px';
        el.style.fontFamily = FoliaTheme.fontStack(theme.fontStyle);
        el.style.fontWeight = '700';
        var glow = document.createElement('span'); glow.className = 'fl-glow';
        var body = document.createElement('span'); body.className = 'fl-body';
        glow.textContent = p.text; body.textContent = p.text;
        el.append(glow, body);
        el.dataset.st = 'waiting';
        el.style.color = theme.primaryColor;
        el.addEventListener('click', function () { if (onSeek) onSeek(pack.line.start_ms); });
        dom.append(el);
        var state = { x: p.x + p.entryX, y: p.y + p.entryY, rot: p.rotate - 4, scale: 0.97, alpha: 0.65, glowA: 0 };
        return { p: p, el: el, glow: glow, body: body, state: state, target: state, heroMul: narrowHero };
      });
    }

    function glowAlpha(node, tMs) {
      var p = node.p, h = cur.hints, mode = h.revealMode;
      var dur = Math.max(p.end_ms - p.start_ms, mode === 'fast' ? 45 : 100);
      var upTo = mode === 'fast' ? 0.14 : 0.18;
      var platEnd = mode === 'fast' ? 0.82 : 0.9;
      var prog = U.clamp((tMs - p.start_ms) / Math.max(1, dur), 0, 1);
      var g;
      if (prog < upTo) g = U.easeOutCubic(prog / upTo);
      else if (prog < platEnd) g = 1;
      else g = U.lerp(1, mode === 'fast' ? 0.92 : 0.9, (prog - platEnd) / (1 - platEnd));
      var fade = U.clamp((tMs - p.end_ms) / (mode === 'fast' ? 120 : 900), 0, 1);
      g *= Math.pow(1 - fade, 2);
      if (p.hero) g = U.lerp(g, 1, 0.25);
      return U.clamp(g * tuning.glow, 0, 1.6);
    }

    function frame(dtMs) {
      if (!visible || !global.Stage) return;
      var doc = Stage.lyrics();
      var tMs = Stage.position();
      var line = doc && doc.index >= 0 ? doc.lines[doc.index] : null;
      if ((!cur || cur.line !== line) && line) {
        cur = packLine(line); mount(cur);
      } else if (!line) {
        if (cur) { dom.innerHTML = ''; cur = null; }
        return;
      }
      if (cur._dirty) { mount(cur); cur._dirty = false; }
      var cx = W / 2, cy = H * 0.46;
      var motion = tuning.motion;
      ctx.clearRect(0, 0, W, H);

      cur.nodes.forEach(function (node) {
        var p = node.p;
        var st = U.wordState(p, cur.hints, cur.line, tMs);
        node.el.dataset.st = st;
        var tx, ty, trot, tscale, talpha;
        if (st === 'waiting') {
          tx = p.x + p.entryX * motion; ty = p.y + p.entryY * motion;
          trot = p.rotate - 4;
          // folia：normal 行进场 scale .97，fast/instant 行 .9。
          tscale = cur.hints.revealMode === 'normal' ? 0.97 : 0.9;
          talpha = 0.65;
        } else if (st === 'active') {
          tx = p.x; ty = p.y; trot = p.rotate; tscale = 1; talpha = 1;
        } else {
          var fadeMs = cur.hints.revealMode === 'fast' ? 120 : 900;
          var f = U.clamp((tMs - p.end_ms) / fadeMs, 0, 1);
          tx = p.x + p.driftX * motion * f; ty = p.y + p.driftY * motion * f;
          trot = p.rotate + p.passedRotate * motion * f;
          tscale = U.lerp(1, 0.9, f); talpha = 0.9 * Math.pow(1 - f, 2) + 0.05;
        }
        var s = node.state;
        s.x = U.damp(s.x, tx, 160, dtMs); s.y = U.damp(s.y, ty, 160, dtMs);
        s.rot = U.damp(s.rot, trot, 260, dtMs); s.scale = U.damp(s.scale, tscale, 160, dtMs);
        s.alpha = U.damp(s.alpha, talpha, 140, dtMs);
        var targetGlow = st === 'active' ? glowAlpha(node, tMs) : 0;
        s.glowA = U.damp(s.glowA, targetGlow, 120, dtMs);
        var color = st === 'active' ? FoliaTheme.wordColor(p.text, theme) : theme.primaryColor;
        var absX = cx + s.x - cur.laid.width / 2, absY = cy + s.y - cur.laid.height / 2;
        node.el.style.transform = 'translate(' + absX.toFixed(1) + 'px,' + absY.toFixed(1) + 'px) rotate(' + s.rot.toFixed(2) + 'deg) scale(' + s.scale.toFixed(3) + ')';
        node.el.style.opacity = U.clamp(s.alpha, 0, 1).toFixed(3);
        node.body.style.color = color;
        if (s.glowA > 0.01) {
          node.glow.style.textShadow = '0 0 40px ' + U.withAlpha(color, U.clamp(0.98 * s.glowA, 0, 0.98)) +
            ',0 0 40px ' + U.withAlpha(color, U.clamp(0.92 * s.glowA, 0, 0.92)) +
            ',0 0 40px ' + U.withAlpha(color, U.clamp(0.35 * s.glowA, 0, 0.35));
        } else node.glow.style.textShadow = 'none';

        // 光束
        if (tuning.beam > 0.01 && st === 'active') {
          var energy = Stage.energy ? Stage.energy() : 0;
          var hm = node.heroMul || 1;
          var wpx = p.w * p.scale * hm * s.scale;
          var bx = absX, by = absY + p.h * p.scale * hm * 0.78;
          var bh = Math.max(2, p.h * p.scale * hm * (0.05 + energy * 0.03) * Math.max(tuning.beam, 0.12));
          var g = ctx.createLinearGradient(bx, by, bx + wpx, by);
          g.addColorStop(0, U.withAlpha(color, 0));
          g.addColorStop(0.5, U.withAlpha(color, 0.5 * tuning.beam));
          g.addColorStop(1, U.withAlpha(color, 0));
          ctx.fillStyle = g;
          var r2 = bh / 2;
          ctx.beginPath();
          ctx.moveTo(bx + r2, by);
          ctx.lineTo(bx + wpx - r2, by);
          ctx.arc(bx + wpx - r2, by + r2, r2, -Math.PI / 2, Math.PI / 2);
          ctx.lineTo(bx + r2, by + bh);
          ctx.arc(bx + r2, by + r2, r2, Math.PI / 2, -Math.PI / 2);
          ctx.closePath(); ctx.fill();
        }
      });
    }

    return {
      frame: frame,
      // 元数据 gate：行切换由 frame 依据 Stage 行号检测；ResizeObserver 负责尺寸，这里不重排。
      update: function () {},
      setTheme: function (t) { if (t === theme) return; theme = t; if (cur) cur._dirty = true; },
      setFontScale: function (v) {
        v = U.clamp(v, 0.7, 1.5) * 1.12;
        if (Math.abs(v - fontScale) < 1e-6) return;
        fontScale = v; resize();
      },
      setVisible: function (b) { visible = b; wrap.hidden = !b; },
      setPaused: function (b) { paused = b; },
      setEco: function (b) { if (eco === b) return; eco = b; resize(); },
      setTuning: function (t) {
        var next = { width: U.clamp(t.width != null ? t.width : 0.72, 0.5, 0.9),
          motion: U.clamp(t.motion != null ? t.motion : 1, 0, 2),
          glow: U.clamp(t.glow != null ? t.glow : 1, 0, 1.6),
          beam: U.clamp(t.beam != null ? t.beam : 0, 0, 1.2) };
        if (next.width === tuning.width && next.motion === tuning.motion &&
            next.glow === tuning.glow && next.beam === tuning.beam) return;
        tuning = next;
        resize();
      },
      resize: resize,
      destroy: function () { if (ro) ro.disconnect(); wrap.remove(); }
    };
  }
  global.FoliaCadenza = { init: init };
})(window);
```

- [ ] **Step 2: 检查点**（联调确认：词块排布不重叠、激活辉光、唱过漂散、beam>0 时胶囊光条随能量变化）。

---

## Task 8: index.html 接线 + stage.js 只读出口

**Files:**
- Modify: `crates/vmusicd/web/index.html`（约 897–910 行设置面板、约 850–896 行舞台 DOM、约 1114–1146 脚本区）
- Modify: `crates/vmusicd/web/stage.js`（约 1297–1303 行 Stage 出口区）

- [ ] **Step 1: 舞台 DOM 增加 folia 容器**

在 `index.html` 中找到 `<aside class="s3d-settings"...` 之前（sleeve 容器 `#s3d-sleeve` 结束之后），插入：

```html
  <div class="fl-root" id="s3d-folia" hidden>
    <div class="fl-bg" id="s3d-fl-bg"></div>
    <div class="fl-lyric" id="s3d-fl-lyric"></div>
    <div class="fl-sub" id="s3d-fl-sub"></div>
  </div>
```

- [ ] **Step 2: 布局下拉项改名（id 迁移）**

把设置面板里的 select 整行替换为：

```html
    <select id="s3d-layout"><option value="focus">沉浸歌词</option><option value="cadenza">心象歌词</option><option value="classic">流光歌词</option><option value="sleeve">封面与歌词</option><option value="single">简洁单句</option></select>
```

- [ ] **Step 3: 设置面板新增条件区块**

在 `<p>拖动探索视角…` 这段之前插入（字号/背景/字幕/偏移 + 两组调参）：

```html
    <div id="s3d-fl-common" hidden>
      <label for="s3d-fl-size">歌词字号 <output id="s3d-fl-size-value">100%</output></label>
      <input id="s3d-fl-size" type="range" min="0.70" max="1.50" step="0.05" value="1">
      <label for="s3d-fl-bg">背景样式</label>
      <select id="s3d-fl-bg"><option value="geometric">几何</option><option value="fluid">流体</option><option value="solid">纯色</option></select>
      <label for="s3d-fl-opacity">封面底色浓度 <output id="s3d-fl-opacity-value">75%</output></label>
      <input id="s3d-fl-opacity" type="range" min="0" max="1" step="0.05" value="0.75">
      <label for="s3d-fl-vignette"><input id="s3d-fl-vignette" type="checkbox" checked> 暗角</label>
      <label for="s3d-fl-subtitle"><input id="s3d-fl-subtitle" type="checkbox" checked> 字幕条</label>
      <label>歌词偏移 <button class="s3d-btn" id="s3d-fl-off-down" type="button">−0.1s</button> <output id="s3d-fl-off-value">+0.0s</output> <button class="s3d-btn" id="s3d-fl-off-up" type="button">+0.1s</button></label>
    </div>
    <div id="s3d-fl-classic" hidden>
      <label for="s3d-fl-rotation"><input id="s3d-fl-rotation" type="checkbox" checked> 词旋转</label>
      <label for="s3d-fl-breathing">呼吸幅度 <output id="s3d-fl-breathing-value">1.00x</output></label>
      <input id="s3d-fl-breathing" type="range" min="0" max="2" step="0.05" value="1">
      <label for="s3d-fl-spacing">词间距 <output id="s3d-fl-spacing-value">0.70x</output></label>
      <input id="s3d-fl-spacing" type="range" min="0" max="2" step="0.05" value="0.7">
    </div>
    <div id="s3d-fl-cadenza" hidden>
      <label for="s3d-fl-width">排版宽度 <output id="s3d-fl-width-value">72%</output></label>
      <input id="s3d-fl-width" type="range" min="0.5" max="0.9" step="0.02" value="0.72">
      <label for="s3d-fl-motion">动效量 <output id="s3d-fl-motion-value">1.00x</output></label>
      <input id="s3d-fl-motion" type="range" min="0" max="2" step="0.05" value="1">
      <label for="s3d-fl-glow">辉光强度 <output id="s3d-fl-glow-value">1.00x</output></label>
      <input id="s3d-fl-glow" type="range" min="0" max="1.6" step="0.05" value="1">
      <label for="s3d-fl-beam">光束强度 <output id="s3d-fl-beam-value">0.00x</output></label>
      <input id="s3d-fl-beam" type="range" min="0" max="1.2" step="0.05" value="0">
    </div>
```

- [ ] **Step 4: 引入 CSS 与脚本（顺序在 stage-lyrics.js 之前、themes.js 之后均可；CSS 放 head 既有 link 区）**

在脚本区 `stage-lyrics.js` 一行之前依次加入：

```html
<script src="folia/folia-util.js"></script>
<script src="folia/folia-theme.js"></script>
<script src="folia/folia-textlayout.js"></script>
<script src="folia/folia-bg.js"></script>
<script src="folia/folia-subtitle.js"></script>
<script src="folia/folia-classic.js"></script>
<script src="folia/folia-cadenza.js"></script>
```

在 `<head>` 现有样式表引用附近（stage3d.css 的 link 旁）加入：

```html
<link rel="stylesheet" href="folia/folia.css">
```

（若 head 中没有 stage3d.css 的 link 而是统一注入，先 `grep -n "stage3d.css" crates/vmusicd/web/index.html` 定位后同位置加入。）

- [ ] **Step 5: stage.js 增加两个只读出口**

在 `stage.js` 的 Stage 返回对象中，`lyrics: function () {...}` 之后加入：

```js
    // folia 歌词模式：翻译行与每曲偏移（数据已在 doc 内，只读暴露，不复制）。
    lyricTranslation: function (i) {
      return doc && doc.translation ? (doc.translation[i] || null) : null;
    },
    lyricOffset: function () {
      return doc && typeof doc.user_offset_ms === 'number' ? doc.user_offset_ms : 0;
    },
```

- [ ] **Step 6: 验证**：运行 `cargo build`（确认 Rust 端 `include_str!`/静态目录对新文件无影响——web 若为运行时目录服务则无需构建；`grep -rn "web/" crates/vmusicd/src | grep -i "include\|embed"` 确认无 embed 清单需要登记）。浏览器打开舞台，控制台无 404、无脚本错误。

- [ ] **Step 7: 检查点**。

---

## Task 9: stage3d.js 集成 + workshop.js 选项同步

**Files:**
- Modify: `crates/vmusicd/web/stage3d.js`
- Modify: `crates/vmusicd/web/workshop.js:1158`

- [ ] **Step 1: 顶部状态变量区（约 45–50 行常量后）新增 folia 状态**

```js
  var FOLIA_LAYOUTS = ['classic', 'cadenza'];
  function isPlane(l) { return FOLIA_LAYOUTS.indexOf(l != null ? l : layout) >= 0; }
  var folia = { ready: false, bg: null, sub: null, classic: null, cadenza: null,
    bgMode: 'geometric', bgOpacity: 0.75, vignette: true, subtitle: true,
    classicTuning: { rotation: true, breathing: 1, spacing: 0.7 },
    cadenzaTuning: { width: 0.72, motion: 1, glow: 1, beam: 0 },
    themeSig: '', coverSig: '' };
```

- [ ] **Step 2: preferences/configure 增加键与旧 id 迁移**

`preferences()` 返回对象中追加：

```js
      foliaBg: folia.bgMode, foliaBgOpacity: folia.bgOpacity, foliaVignette: folia.vignette,
      foliaSubtitle: folia.subtitle, classicTuning: folia.classicTuning, cadenzaTuning: folia.cadenzaTuning
```

`configure(value)` 中：
1. 将布局白名单行 `if (['focus', 'sleeve', 'single', 'scatter', 'spark'].indexOf(value.layout) >= 0) layout = value.layout;` 替换为：

```js
      if (value.layout === 'spark') { layout = 'classic'; }
      else if (value.layout === 'scatter') { layout = 'cadenza'; }
      else if (['focus', 'sleeve', 'single', 'classic', 'cadenza'].indexOf(value.layout) >= 0) { layout = value.layout; }
```

2. 在该函数末尾（restoring 块内）追加读取：

```js
      if (value.foliaBg === 'geometric' || value.foliaBg === 'fluid' || value.foliaBg === 'solid') folia.bgMode = value.foliaBg;
      if (typeof value.foliaBgOpacity === 'number') folia.bgOpacity = clamp(value.foliaBgOpacity, 0, 1);
      if (typeof value.foliaVignette === 'boolean') folia.vignette = value.foliaVignette;
      if (typeof value.foliaSubtitle === 'boolean') folia.subtitle = value.foliaSubtitle;
      if (value.classicTuning && typeof value.classicTuning === 'object') folia.classicTuning = {
        rotation: value.classicTuning.rotation !== false,
        breathing: clamp(num(value.classicTuning.breathing, 1), 0, 2),
        spacing: clamp(num(value.classicTuning.spacing, 0.7), 0, 2)
      };
      if (value.cadenzaTuning && typeof value.cadenzaTuning === 'object') folia.cadenzaTuning = {
        width: clamp(num(value.cadenzaTuning.width, 0.72), 0.5, 0.9),
        motion: clamp(num(value.cadenzaTuning.motion, 1), 0, 2),
        glow: clamp(num(value.cadenzaTuning.glow, 1), 0, 1.6),
        beam: clamp(num(value.cadenzaTuning.beam, 0), 0, 1.2)
      };
```

- [ ] **Step 3: 无 GL 放行 + 帧驱动平面模式**

`targetFps()` 改为：

```js
  function targetFps() {
    if (!active || document.hidden) return 0;
    if (!gl) return isPlane() ? (reducedMotion() ? 15 : 60) : 0;
    return reducedMotion() ? 15 : 240;
  }
```

`tick(dtMs)` 开头 `if (!active || !gl) return;` 改为 `if (!active) return;`；并在函数末尾 `sampleCost(...)` 之前加入平面驱动：

```js
    if (isPlane()) driveFolia(step);
```

`render(step)`（约 1404 行）首行加入 GL 短路（平面模式直接不提交 GPU，画面由 CSS 隐藏）：

```js
  function render(dtMs) {
    if (isPlane() || !gl || contextLost) return;
```

`open(stageId)` 中将 `if (!ensureGl()) { showFallback(...)； return false; }` 替换为：

```js
    var hasGl = ensureGl();
    if (!hasGl && !isPlane()) { showFallback('当前设备暂不支持三维渲染，仍可播放音乐或返回曲库。'); return false; }
```

（平面布局下允许无 GL 打开。已核实 `resize()`（1192–1205 行）首行 `if (!gl || !root) return;` 自我保护，`render()` 也已短路，平面模式不会解引用空 GL。）

- [ ] **Step 4: 手势入口短路 + 双击**

`onPointerDown`、`onWheel` 首行（`if (!active…` 之后）加入：

```js
    if (isPlane()) return;
```

把绑定双击的一行：

```js
    wrapEl.addEventListener('dblclick', function () { resetView(); });
```

改为：

```js
    wrapEl.addEventListener('dblclick', function () { if (!isPlane()) resetView(); });
```

在 `onKeyDown` 中处理 `k`/`K` 复位的分支（若存在；`grep -n "'k'" stage3d.js` 定位）同样加 `if (isPlane()) return;` 前置；若该键直接调用 `resetView()`，包裹一层。

- [ ] **Step 5: syncLayout 增加平面模式挂载与设置区块显隐**

把现有 `syncLayout()` 整体替换为：

```js
  function ensureFolia() {
    if (folia.ready) { applyFoliaConfig(); return; }
    var bgHost = $('s3d-fl-bg'), lyricHost = $('s3d-fl-lyric'), subHost = $('s3d-fl-sub');
    if (!global.FoliaBg || !bgHost) return;
    folia.bg = global.FoliaBg.init(bgHost);
    folia.sub = global.FoliaSubtitle.init(subHost);
    folia.classic = global.FoliaClassic.init(lyricHost, function (ms) { control('seek', ms); });
    folia.cadenza = global.FoliaCadenza.init(lyricHost, function (ms) { control('seek', ms); });
    folia.ready = true;
    bindFoliaControls();
    applyFoliaConfig();
  }

  function planeApi() { return layout === 'classic' ? folia.classic : folia.cadenza; }

  function applyFoliaConfig() {
    if (!folia.ready) return;
    var t = global.FoliaTheme.resolve(reactivity);
    var sig = global.FoliaTheme.signature(t);
    if (sig !== folia.themeSig) {
      folia.themeSig = sig;
      folia.bg.setTheme(t); folia.sub.setTheme(t);
      folia.classic.setTheme(t); folia.cadenza.setTheme(t);
    }
    var fs = clamp(num(lyricSize, 1), 0.7, 1.5);
    root.style.setProperty('--folia-fontscale', String(fs));
    [folia.classic, folia.cadenza, folia.sub].forEach(function (a) { a.setFontScale(fs); });
    folia.bg.setMode(folia.bgMode);
    folia.bg.setOpacity(folia.bgOpacity);
    folia.bg.setVignette(folia.vignette);
    folia.sub.setVisible(folia.subtitle && showLyrics);
    folia.classic.setTuning(folia.classicTuning);
    folia.cadenza.setTuning(folia.cadenzaTuning);
    // 只有当前布局对应的渲染器可见，另一个必须隐藏（两者共用 #s3d-fl-lyric）。
    folia.classic.setVisible(showLyrics && layout === 'classic');
    folia.cadenza.setVisible(showLyrics && layout === 'cadenza');
    var data = global.Stage && Stage.presentation ? Stage.presentation() : null;
    folia.bg.setPaused(!data || !data.playing);
    [folia.classic, folia.cadenza].forEach(function (a) { a.setPaused(!data || !data.playing); });
    folia.bg.setEco(global.Stage && Stage.tier ? Stage.tier() === 0 : false);
    [folia.classic, folia.cadenza].forEach(function (a) { a.setEco(global.Stage && Stage.tier ? Stage.tier() === 0 : false); });
  }

  function driveFolia(dtMs) {
    if (!folia.ready) return;
    // 配置只在 8fps 的 syncFoliaMeta/控件回调里推；帧循环只做动画驱动，避免每帧重建。
    var data = global.Stage && Stage.presentation ? Stage.presentation() : null;
    if (data && data.cover !== folia.coverSig) {
      folia.coverSig = data.cover;
      folia.bg.setCover(data.cover || null);
    }
    folia.bg.frame(dtMs);
    if (showLyrics) { planeApi().frame(dtMs); }
  }

  function syncFoliaMeta() {
    if (!folia.ready || !isPlane()) return;
    applyFoliaConfig();
    folia.sub.update();
    planeApi().update();
    var off = global.Stage && Stage.lyricOffset ? Stage.lyricOffset() : 0;
    var ov = $('s3d-fl-off-value');
    if (ov) ov.textContent = (off > 0 ? '+' : '') + (off / 1000).toFixed(1) + 's';
  }

  function syncLayout() {
    root.dataset.layout = layout;
    root.style.setProperty('--sl-size', lyricSize);
    root.style.setProperty('--sl-glow', lyricGlow);
    $('s3d-layout').value = layout;
    $('s3d-sleeve').hidden = layout !== 'sleeve';
    if (lyricView) lyricView.configure(showLyrics && !isPlane());
    var plane = isPlane();
    root.classList.toggle('s3d-plane', plane);
    $('s3d-folia').hidden = !plane;
    $('s3d-reading').hidden = plane ? true : !showLyrics;
    $('s3d-fl-common').hidden = !plane;
    $('s3d-fl-classic').hidden = layout !== 'classic';
    $('s3d-fl-cadenza').hidden = layout !== 'cadenza';
    $('s3d-fl-opacity').parentElement.style.opacity = folia.bgMode === 'fluid' ? '1' : '.4';
    if (plane) ensureFolia();
    else if (folia.ready) { folia.classic.setVisible(false); folia.cadenza.setVisible(false); }
  }
```

同时修改现有 `toggleLyrics()`（约 1834–1841 行）中的隐藏行，并在切换后立即推一次配置（不等 8fps）：

```js
  function toggleLyrics() {
    showLyrics = !showLyrics;
    syncLayout();
    $('s3d-reading').hidden = isPlane() ? true : !showLyrics;
    $('s3d-lyrics-toggle').setAttribute('aria-pressed', String(showLyrics));
    if (isPlane() && folia.ready) applyFoliaConfig();
    pokeChrome();
    savePreferences();
  }
```

- [ ] **Step 6: 元数据 gate 中调用 syncFoliaMeta**

在 `syncNowPlaying()` 函数体内（任意靠前位置，`root.classList.toggle('s3d-reduced', …)` 之后即可）加入：

```js
    if (isPlane()) syncFoliaMeta();
```

并在 `readTint()` 末尾加入（主题切换后强制重算）：

```js
    folia.themeSig = '';
```

- [ ] **Step 7: 绑定设置控件（bindFoliaControls）**

在 `bindUi()` 内（或紧邻定义工具函数区）新增：

```js
  function bindFoliaControls() {
    function range(id, fn, fmt) {
      var el = $(id), out = $(id + '-value') ;
      if (!el || el._bound) return;
      el._bound = true;
      el.addEventListener('input', function () {
        fn(Number(el.value));
        if (out) out.textContent = fmt ? fmt(Number(el.value)) : el.value;
        applyFoliaConfig(); savePreferences();
      });
    }
    function check(id, fn) {
      var el = $(id);
      if (!el || el._bound) return;
      el._bound = true;
      el.addEventListener('change', function () { fn(el.checked); applyFoliaConfig(); savePreferences(); });
    }
    range('s3d-fl-size', function (v) { lyricSize = v; }, function (v) { return Math.round(v * 100) + '%'; });
    var bgSel = $('s3d-fl-bg');
    if (bgSel && !bgSel._bound) { bgSel._bound = true; bgSel.value = folia.bgMode;
      bgSel.addEventListener('change', function () {
        folia.bgMode = bgSel.value;
        $('s3d-fl-opacity').parentElement.style.opacity = folia.bgMode === 'fluid' ? '1' : '.4';
        applyFoliaConfig(); savePreferences();
      }); }
    range('s3d-fl-opacity', function (v) { folia.bgOpacity = v; }, function (v) { return Math.round(v * 100) + '%'; });
    check('s3d-fl-vignette', function (b) { folia.vignette = b; });
    check('s3d-fl-subtitle', function (b) { folia.subtitle = b; });
    check('s3d-fl-rotation', function (b) { folia.classicTuning.rotation = b; });
    range('s3d-fl-breathing', function (v) { folia.classicTuning.breathing = v; }, function (v) { return v.toFixed(2) + 'x'; });
    range('s3d-fl-spacing', function (v) { folia.classicTuning.spacing = v; }, function (v) { return v.toFixed(2) + 'x'; });
    range('s3d-fl-width', function (v) { folia.cadenzaTuning.width = v; }, function (v) { return Math.round(v * 100) + '%'; });
    range('s3d-fl-motion', function (v) { folia.cadenzaTuning.motion = v; }, function (v) { return v.toFixed(2) + 'x'; });
    range('s3d-fl-glow', function (v) { folia.cadenzaTuning.glow = v; }, function (v) { return v.toFixed(2) + 'x'; });
    range('s3d-fl-beam', function (v) { folia.cadenzaTuning.beam = v; }, function (v) { return v.toFixed(2) + 'x'; });
    var down = $('s3d-fl-off-down'), up = $('s3d-fl-off-up');
    function nudge(d) {
      if (!global.Stage || !Stage.lyricOffset) return;
      var next = Math.max(-60000, Math.min(60000, Stage.lyricOffset() + d));
      control('lyricOffset', next);
      var ov = $('s3d-fl-off-value');
      if (ov) ov.textContent = (next > 0 ? '+' : '') + (next / 1000).toFixed(1) + 's';
    }
    if (down && !down._bound) { down._bound = true; down.addEventListener('click', function () { nudge(-100); }); }
    if (up && !up._bound) { up._bound = true; up.addEventListener('click', function () { nudge(100); }); }
    // 初始化控件显示值
    var sizeEl = $('s3d-fl-size'); if (sizeEl) sizeEl.value = String(lyricSize);
    var sizeOut = $('s3d-fl-size-value'); if (sizeOut) sizeOut.textContent = Math.round(lyricSize * 100) + '%';
  }
```

注意修正绑定选择器：output 的 id 是 `s3d-fl-size-value`，而 `range()` 内用 `$(id+'-value')` 对 `s3d-fl-size` 正确；但 `s3d-fl-opacity` 的 output 同名规则为 `s3d-fl-opacity-value`，HTML 一致，OK。`s3d-fl-bg` 是 select 不用 range()。

- [ ] **Step 8: 销毁清理**

`destroy()` 中 `lyricView.destroy()` 附近加入：

```js
    if (folia.ready) {
      [folia.bg, folia.sub, folia.classic, folia.cadenza].forEach(function (a) { a.destroy(); });
      folia.ready = false; folia.bg = folia.sub = folia.classic = folia.cadenza = null;
    }
```

- [ ] **Step 9: workshop.js 同步选项**

把 `workshop.js:1158` 一行替换为：

```js
    reading.appendChild(select('聆听布局', [['focus', '沉浸歌词'], ['cadenza', '心象歌词'], ['classic', '流光歌词'], ['sleeve', '封面与歌词'], ['single', '简洁单句']], prefs.layout, function (v) { edit({ layout: v }); }));
```

- [ ] **Step 10: 全局残留检查**

Run:
```
rg -n "scatter|spark" crates/vmusicd/web --glob "*.js" --glob "*.html"
```
Expected: 仅余 stage3d.js 迁移分支（`'spark'`/`'scatter'` 两个比较字面量）、stage3d.css 中旧布局死规则（保留不影响），以及 stage-lyrics.js 注释。若发现其他读取点（如快捷键映射、存档代码），同样改为 classic/cadenza。

- [ ] **Step 11: 端到端目测**：`cargo run`（或项目既有启动方式）→ 进入舞台 → 依次切 focus/cadenza/classic/sleeve/single：流光与心象下无 3D 拖拽/滚轮、歌词与背景/字幕正常；切回旧布局 3D 恢复；设置面板控件即时生效并持久化（刷新）；无 GL 环境（可在浏览器 DevTools 模拟 WebGL 禁用）平面模式仍可打开。

- [ ] **Step 12: 检查点**。

---

## Task 10: app.js 歌词偏移动作

**Files:**
- Modify: `crates/vmusicd/web/app.js:1053-1072`

- [ ] **Step 1: onStageControl 增加 case**

在 `case 'view': setView(d.value); break;` 之前插入：

```js
    case 'lyricOffset': {
      const id = state.current && state.current.id;
      if (!id || String(id).startsWith('online:')) break;
      const offset_ms = Math.max(-60000, Math.min(60000, Number(d.value) || 0));
      transport.put(`/v1/tracks/${encodeURIComponent(id)}/lyrics/offset`, { offset_ms })
        .then(() => refreshLyrics(id, state.current))
        .catch(() => toast('保存歌词偏移失败', 'error'));
      break;
    }
```

说明：与播放页 `shiftLyricOffset`（app.js 3191–3203）同一端点；这里值由舞台按 ±100ms 预算好直接下发，成功后 refreshLyrics 重建文档，Stage 时间轴自动带新偏移，字幕/歌词同步移动。

- [ ] **Step 2: 验证**：舞台内点 +0.1s/−0.1s，Network 面板看到 PUT 200，歌词整体移动；刷新后偏移保留；播放页偏移显示同步。

- [ ] **Step 3: 检查点**。

---

## Task 11: check-folia.js 纯函数验证（实现后补齐，非 TDD）

**Files:**
- Create: `scripts/check-folia.js`

Node 运行、零依赖、失败时 exit 1。覆盖 spec 11.1。

- [ ] **Step 1: 创建脚本（完整代码）**

```js
// SPDX-License-Identifier: MIT
// folia 纯函数验证：node scripts/check-folia.js
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', 'crates', 'vmusicd', 'web', 'folia');
// 模块工厂从全局取 FoliaUtil：require util 后先挂到 global，再加载下游模块。
const U = require(path.join(ROOT, 'folia-util.js'));
global.FoliaUtil = U;
const T = require(path.join(ROOT, 'folia-theme.js'));
const L = require(path.join(ROOT, 'folia-textlayout.js'));

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

// 2) wordState 三态
let w = { start_ms: 1000, end_ms: 1200 };
let line = { start_ms: 1000, end_ms: 2000 };
eq(U.wordState(w, normal, line, 800), 'waiting', 'waiting');
eq(U.wordState(w, normal, line, 1050), 'active', 'active');
eq(U.wordState(w, normal, line, 1300), 'passed', 'passed');
eq(U.wordState(w, micro, line, 40), 'active', 'instant lookahead 30ms');

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

if (failures) { console.error('\n' + failures + ' 个失败'); process.exit(1); }
console.log('\n全部通过');
```

- [ ] **Step 2: 运行并要求全绿**

Run（仓库根目录）：
```
node scripts/check-folia.js
```
Expected: 末行 `全部通过`，exit code 0。

- [ ] **Step 3: 检查点**。

---

## Task 12: 视觉对比与回归验证（实现后）

**Files:**
- Create: `scripts/check-folia-visual.js`
- 产物目录：`output/folia-verify/`

前置（脚本不负责启动服务，提示前置条件）：
1. folia-major：`cd D:\code\github\folia-major && npm install && npm run dev`（Node ≥24），记录地址如 `http://localhost:5173`；
2. hertz：按项目方式启动 vmusicd 并登录、加载夹具歌单；
3. Playwright：项目根无 package.json，脚本使用 `npx -y playwright@latest` 体系；若本机已全局安装 playwright 可直接 `node scripts/check-folia-visual.js`。

夹具歌词（两边各导入同一 LRC，保存为测试资源；含 normal/short/micro 行、间奏、超长 CJK 句、中英混合行）：

```lrc
[00:00.00]短
[00:00.05]极短快速句
[00:12.00]今日所见的夕阳漫天散落的星点在风里慢慢发亮
[00:18.00]宝贝 我 爱 你 baby I love you
[00:24.00]......
[00:30.00]最后一句安静收场
```

- [ ] **Step 1: 创建截图脚本（完整代码）**

```js
#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// folia 视觉对比：固定时钟截图矩阵。用法：
//   FOLIA_URL=http://localhost:5173 HERTZ_URL=http://localhost:8080 node scripts/check-folia-visual.js
// 依赖 playwright（npx -y playwright@latest install chromium 后可用 require）。
'use strict';
const fs = require('fs');
const path = require('path');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  console.error('未找到 playwright。请先执行：npx -y playwright@latest install chromium');
  process.exit(2);
}

const FOLIA = process.env.FOLIA_URL || 'http://localhost:5173';
const HERTZ = process.env.HERTZ_URL || 'http://localhost:8080';
const OUT = path.join(__dirname, '..', 'output', 'folia-verify');
fs.mkdirSync(OUT, { recursive: true });

const MATRIX = [
  { mode: 'classic', bg: 'geometric', w: 1440, h: 900 },
  { mode: 'classic', bg: 'fluid',    w: 1440, h: 900 },
  { mode: 'classic', bg: 'solid',    w: 1440, h: 900 },
  { mode: 'cadenza', bg: 'geometric',w: 1440, h: 900 },
  { mode: 'cadenza', bg: 'fluid',    w: 1440, h: 900 },
  { mode: 'cadenza', bg: 'solid',    w: 1440, h: 900 },
  { mode: 'classic', bg: 'geometric', w: 390, h: 844 },
  { mode: 'cadenza', bg: 'geometric', w: 390, h: 844 }
];
// 夹具中两个采样时刻：12.6s（normal 长句）、0.6s（short/micro 快句）
const SAMPLES = [{ t: 12600, name: 'normal' }, { t: 600, name: 'fast' }];

async function shot(page, url, file) {
  await page.goto(url, { waitUntil: 'networkidle' });
  // 两侧测试页都约定监听该事件，把播放时钟固定到指定 ms（夹具页/调试钩子）。
  await page.evaluate((ms) => window.__pinPlayback && window.__pinPlayback(ms), 0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: file });
}

(async () => {
  const browser = await chromium.launch();
  for (const m of MATRIX) {
    for (const s of SAMPLES) {
      const ctx = await browser.newContext({ viewport: { width: m.w, height: m.h } });
      const page = await ctx.newPage();
      const q = `?mode=${m.mode}&bg=${m.bg}`;
      const base = `${m.mode}-${m.bg}-${m.w}x${m.h}-${s.name}.png`;
      await shot(page, `${FOLIA}/${q}&t=${s.t}`, path.join(OUT, 'folia-' + base));
      await shot(page, `${HERTZ}/stage3d${q}&t=${s.t}`, path.join(OUT, 'hertz-' + base));
      await ctx.close();
    }
  }
  await browser.close();
  console.log('截图完成：', OUT);
  console.log('对比：npx pixelmatch 或人工 SSIM 目检；结构差异目标 <5%，SSIM >=0.95');
})().catch((e) => { console.error(e); process.exit(1); });
```

> 说明：`__pinPlayback(ms)` 为验证钩子。folia 侧通过其 dev 页 URL 参数（mode/bg/t）在测试构建中读取；hertz 侧在 Task 9 的 stage3d 增加一个**仅测试用**时钟覆盖：`window.__pinPlayback = (ms)=>{ Stage.position = ()=>ms; };`（写在 stage3d.js init 末尾，`// 仅视觉验证夹具使用` 注释；生产无调用方，零副作用）。若评审认为不应加入生产文件，则改为在 Playwright 里用 route 拦截快照 websocket 注入固定 position，本任务按评审意见二选一执行，并在此处记录决定。

- [ ] **Step 2: 在 stage3d.js 增加测试时钟钩子（若采用钩子方案）**

在 `init()` 成功末尾（`return api;` 之前）加入：

```js
    // 仅视觉验证夹具使用：固定播放时钟，无外部调用方。
    global.__pinPlayback = function (ms) {
      if (global.Stage) Stage.position = function () { return ms; };
    };
```

- [ ] **Step 3: 执行截图并目检**

Run：
```
$env:FOLIA_URL="http://localhost:5173"; $env:HERTZ_URL="http://localhost:你启动的端口"; node scripts/check-folia-visual.js
```
Expected: `output/folia-verify/` 生成 32 张 PNG，无脚本报错。人工对照同名 folia-*/hertz-*：布局结构、配色、词态位置、背景元素一致；可量化差异 <5%。

- [ ] **Step 4: 手工回归清单（逐项打勾，记录到 PR 描述）**

- [ ] 五个布局互切：focus/cadenza/classic/sleeve/single，旧三布局截图与改造前零差异
- [ ] 流光：逐词点亮与辉光、唱过回落变暗、整行呼吸、行切模糊进出场、词旋转开关、呼吸 0 时静止、词间距变化不重叠
- [ ] 心象：hero 强调、词块不重叠、辉光拉起/衰减、passed 漂散、beam 0 默认无光条、beam 滑杆出现胶囊光条
- [ ] 背景三档切换与暗角开关；fluid 切歌交叉淡化无分块闪烁；solid 零动画
- [ ] 字幕：有翻译显翻译；无翻译显预告；占位符行（//、●●●）不显示；开关生效
- [ ] seek（拖进度条 + 点词）后无补放、状态立即正确；±0.1s 偏移持久化并整体移动
- [ ] reduced motion（系统开关）：循环动画关闭，逐词染色保留
- [ ] 暂停：呼吸/背景/光束冻结，染色保持
- [ ] 响应式：1440×900 / 390×844 / 380px 宽 / 矮横屏；ResizeObserver 后不错位
- [ ] 刷新：偏好恢复，旧 spark/scatter 偏好迁移为 classic/cadenza
- [ ] eco 档（可临时 `Stage.tier=()=>0`）形状 8、粒子 10、心象画布降分辨率
- [ ] 连续切歌 20 次：`.fl-cword/.fl-cadz` 节点数与 img 数不持续增长

- [ ] **Step 5: 性能快测**：桌面稳定 60fps（`Stage3D.stats().fps`），eco ≥30fps；切歌后无控制台报错/警告（跨域封面降级 warning 除外）。

- [ ] **Step 6: 最终检查点**：全部任务完成。向用户汇报验证产物路径与回归清单结果；提交仅在用户授权时执行：
```
git add crates/vmusicd/web/folia crates/vmusicd/web/index.html crates/vmusicd/web/stage.js crates/vmusicd/web/stage3d.js crates/vmusicd/web/app.js crates/vmusicd/web/workshop.js scripts/check-folia.js scripts/check-folia-visual.js docs/superpowers
git commit -m "feat(stage): folia classic/cadenza lyric modes"
```
