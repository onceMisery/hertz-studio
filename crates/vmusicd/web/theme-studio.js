// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 主题工作室：壁纸背景 + 二次元主题 + 自定义配色。
//
// 与 themes.js 的分工
// -------------------
// themes.js 是**令牌层**：一张 { token: value } 表写成 <html> 的行内变量，
// 它不认识「壁纸」也不认识「二次元」。这个模块是**编排层**：它往 Theme 里
// 注册新主题（走 Theme.register，不复制那套 apply 逻辑），另外管一件 themes.js
// 管不了的事——铺在一切之下的壁纸背景层。
//
// 三条设计纪律
// ------------
// 1. **文字色一律从底色反推，不手写**。ANIME_THEMES 与自定义配色都只声明
//    `bg / accent / accent2` 三个颜色，`--text`/`--muted`/`--panel`/`--line`
//    由 `tokensFor()` 按 WCAG AA 反算出来。手写十来套主题的文字色，迟早有
//    一套在某个底色上糊掉，而反推是构造性保证——这是「兼顾文字可读性」的
//    实现方式，不是一句承诺。
// 2. **自定义底色夹在暗色区间**。本项目的玻璃质感令牌（--glass-*）按契约只能
//    定义在 style.css 的 :root 里，不随主题走，底色一浅面板就会跟它失配。
//    所以这里把自定义底色锁在 L ≤ 0.30，宁可少一点自由度，不给出一个看起来
//    坏掉的界面。
// 3. **壁纸层压在 z-index 负数区**。style.css 里 body::before（主题辉光）在
//    -2、#ambient（在播封面的模糊氛围）在 -1，壁纸排在 -3，于是天然是
//    「壁纸 → 主题辉光 → 在播氛围」的正确覆盖顺序，不必碰现有那两层。
//
// 与读写相关的状态只有两处 localStorage 键（与 themes.js 同一种做法：纯本地
// 观感不上服务端），键名前缀统一 vmusic.。

(function () {
  'use strict';

  var WALL_KEY = 'vmusic.wallpaper.v1';
  var CUSTOM_KEY = 'vmusic.theme.custom.v1';
  /// 自定义主题在 Theme 里的 id。固定值，好让 themes.js 的 localStorage 记住它。
  var CUSTOM_ID = 'custom-studio';

  // -------------------------------------------------------------------------
  // 壁纸目录
  //
  // 素材来自 naruto-wallpapers（morning / afternoon / evening / night 四个
  // 时段），已按长边 1600px 压过并内嵌进二进制，字节由 main.rs 的
  // `/wallpapers/{name}` 挂出。这里只声明观感属性：
  //
  //   lum —— 0..255 的平均亮度。它不是给人看的数字，是**自动压暗**的输入：
  //          亮壁纸必须压得更狠，否则叠在面板下的那一层会把文字顶没。
  //   tone —— 时段，用来分组显示；也是给用户的第一层心理预期。
  // -------------------------------------------------------------------------
  var WALLPAPERS = [
    { id: 'morning-01.jpg', label: '晨光', tone: '晨', lum: 188, theme: 'anime-dawn' },
    { id: 'morning-09.jpg', label: '晴日', tone: '晨', lum: 164, theme: 'anime-dawn' },
    { id: 'morning-14.jpg', label: '暮色起', tone: '晨', lum: 49, theme: 'anime-shinobi' },
    { id: 'afternoon-19.jpg', label: '盛夏', tone: '昼', lum: 225, theme: 'anime-dawn' },
    { id: 'afternoon-07.jpg', label: '林间', tone: '昼', lum: 155, theme: 'anime-chakra' },
    { id: 'afternoon-20.jpg', label: '黄昏前', tone: '昼', lum: 89, theme: 'anime-sunset' },
    { id: 'evening-12.jpg', label: '夜灯', tone: '夕', lum: 21, theme: 'anime-shinobi' },
    { id: 'evening-16.jpg', label: '晚霞', tone: '夕', lum: 90, theme: 'anime-sunset' },
    { id: 'evening-18.jpg', label: '灯市', tone: '夕', lum: 182, theme: 'anime-scroll' },
    { id: 'night-02.jpg', label: '写轮眼', tone: '夜', lum: 2, theme: 'anime-abyss' },
    { id: 'night-08.jpg', label: '暗夜', tone: '夜', lum: 80, theme: 'anime-abyss' },
    { id: 'night-12.jpg', label: '月下', tone: '夜', lum: 175, theme: 'anime-sakura' }
  ];

  /// 壁纸的 URL 前缀。**必须是绝对路径**：相对路径按"当前文档"解析，页面一旦
  /// 不是挂在站点根上（反代带前缀、或从某个子路径打开），`wallpapers/x.jpg`
  /// 就会解析到 `/前缀/wallpapers/x.jpg` 而对服务端是 404 —— 表现正是
  /// "换了主题，背景图却不出来"。舞台那边的壁纸一直是绝对路径，这里对齐。
  var WALL_BASE = '/wallpapers/';

  /// 兜底壁纸：某套主题没声明背景、或声明的那张加载不出来时用这张。
  /// 挑中间亮度（lum 90）那张是有意的——自动压暗对它的处理最轻，于是
  /// "兜底"这件事本身不会顺手把界面压得看不清。
  var DEFAULT_WALL = 'evening-16.jpg';

  // -------------------------------------------------------------------------
  // 主题 → 背景图
  //
  // 这是"换到二次元主题却看不到背景图"那一类问题的正面答案。
  // 主题与壁纸原本是两套互不相干的状态：Theme 每套主题只有**配色令牌**，
  // 不带任何背景资源；壁纸则只有一个全局 id，而且默认为空（= 不铺）。
  // 目录里 WALLPAPERS[].theme 是**壁纸 → 主题**的单向推荐（挑壁纸才顺带换
  // 主题），反方向不成立。于是"点主题"永远带不出背景图。
  //
  // 两条纪律：
  //   1. 二次元那七套**不在**这里重复声明——每张壁纸已经带着推荐主题，反查
  //      即可（同一套被多张推荐时取第一张）。真值只留一处，就不会出现
  //      "表里的图和画廊里推荐的那张对不上"。
  //   2. 内置主题没有专属素材，按底色气质各指派一张；表里没有的、或写了
  //      不存在文件名的，一律落到 DEFAULT_WALL —— 这就是缺资源时的兜底。
  // -------------------------------------------------------------------------
  var THEME_WALL = {
    mineral: 'night-08.jpg',
    'vcp-starblue': 'night-12.jpg',
    'vcp-emerald': 'afternoon-07.jpg',
    'vcp-midnight-neon': 'evening-18.jpg',
    'vcp-mono': 'morning-14.jpg',
    'vcp-aero': 'morning-09.jpg',
    'vcp-codeide': 'evening-16.jpg',
    'vcp-sakura': 'morning-01.jpg',
    'vcp-crimson': 'evening-12.jpg',
    'vcp-paper-ink': 'afternoon-20.jpg',
    'vcp-forest': 'afternoon-19.jpg',
    'vcp-porcelain': 'morning-09.jpg',
    'vcp-snow-dawn': 'morning-01.jpg',
    'vcp-acid': 'night-08.jpg',
    liunian: 'evening-16.jpg'
  };
  // 自定义配色没有署名素材，与"没声明"的主题同样走兜底那张。
  THEME_WALL[CUSTOM_ID] = DEFAULT_WALL;

  /// 某套主题该用哪张壁纸：二次元推荐 → 内置映射表 → 默认兜底。
  /// 表里给出的文件名还要过一遍目录，写错一个名字不该让整层变空白。
  function wallForTheme(themeId) {
    var i;
    if (themeId) {
      for (i = 0; i < WALLPAPERS.length; i += 1) {
        if (WALLPAPERS[i].theme === themeId) return WALLPAPERS[i].id;
      }
      var listed = THEME_WALL[themeId];
      if (listed && wallById(listed)) return listed;
    }
    return wallById(DEFAULT_WALL) ? DEFAULT_WALL : (WALLPAPERS[0] && WALLPAPERS[0].id) || '';
  }

  // -------------------------------------------------------------------------
  // 二次元主题
  //
  // 只给三个颜色，其余由 tokensFor() 反推。两个强调角色的分工沿用全项目约定：
  //   --brand     薄荷青位 = 「正在生效 / 正在播放」（这里取 accent2 一系的冷色）
  //   --highlight 香槟金位 = 「当前选中项」（这里各套自带一个暖色）
  // 名称都取自忍界意象，避免出现「主题 1 / 主题 2」这种没有信息量的选项。
  // -------------------------------------------------------------------------
  // `skin` 是配色之外的那半套皮肤：圆角、描边、纹理、装饰条与动效。
  // 只换配色的话七套主题看起来是"同一张脸涂了七种颜色"，用户说的
  // 「只有主题色、没有主题样式」就是这个；形态差异由 theme-studio.css 里
  // 的 [data-ts-skin="…"] 段落承接，这里只负责把它挂到 <html> 上。
  var ANIME_THEMES = [
    {
      id: 'anime-shinobi',
      name: '忍法帖 · 夜行',
      note: '二次元 · 夜行忍者的橙红刀光',
      skin: 'blade',
      bg: '#0d0f14',
      accent: '#ff6a3d',
      accent2: '#4a7dff',
      highlight: '#f4b860'
    },
    {
      id: 'anime-sakura',
      name: '樱吹雪',
      note: '二次元 · 靛紫夜里的樱粉',
      skin: 'petal',
      bg: '#191426',
      accent: '#ff9ec4',
      accent2: '#b39ddb',
      highlight: '#ffd9e6'
    },
    {
      id: 'anime-chakra',
      name: '查克拉 · 涌动',
      note: '二次元 · 青蓝的查克拉辉光',
      skin: 'chakra',
      bg: '#07171f',
      accent: '#22e0ff',
      accent2: '#0f8cff',
      highlight: '#ffd479'
    },
    {
      id: 'anime-scroll',
      name: '卷轴 · 朱与墨',
      note: '二次元 · 墨底上的朱印与金泥',
      skin: 'scroll',
      bg: '#121013',
      accent: '#e0403c',
      accent2: '#d9c27f',
      highlight: '#e8c07b'
    },
    {
      id: 'anime-sunset',
      name: '夕日之约',
      note: '二次元 · 暮橙与暖金的黄昏',
      skin: 'ember',
      bg: '#1d1216',
      accent: '#ff8a5c',
      accent2: '#ffd166',
      highlight: '#ffd166'
    },
    {
      id: 'anime-abyss',
      name: '深渊 · 万花筒',
      note: '二次元 · 写轮眼紫与血的对比',
      skin: 'kaleido',
      bg: '#0a0812',
      accent: '#a06bff',
      accent2: '#ff2d55',
      highlight: '#ff8fa3'
    },
    {
      id: 'anime-dawn',
      name: '破晓 · 日向',
      note: '二次元 · 冷灰晨光配暖白高光',
      skin: 'dawn',
      bg: '#101418',
      accent: '#7fd4c1',
      accent2: '#5b8dd9',
      highlight: '#f0e2c0'
    }
  ];

  var SKIN_ATTR = 'data-ts-skin';
  var DEFAULT_SKIN = 'plain';

  function skinOf(id) {
    for (var i = 0; i < ANIME_THEMES.length; i += 1) {
      if (ANIME_THEMES[i].id === id) return ANIME_THEMES[i].skin;
    }
    return DEFAULT_SKIN;
  }

  /// 把当前主题的形态挂到 <html> 上。换肤必须走这里——CSS 那七套形态全靠
  /// 这个属性选中，漏了就只剩配色在动。
  function applySkin(id) {
    var el = document.documentElement;
    if (!el) return;
    var skin = skinOf(id);
    if (el.getAttribute(SKIN_ATTR) !== skin) el.setAttribute(SKIN_ATTR, skin);
  }

  /// 自动压暗的预算：把壁纸叠完后的**有效亮度**压到「底色亮度 + 这个量」以内。
  /// 0.055 ≈ 14/255，是「看得出壁纸，但面板底下那层不至于把文字顶没」的实测量。
  var AUTO_BUDGET = 0.055;
  /// 自动模式下压暗不会拉满——留一点让壁纸始终"在"，不然自动档等于关壁纸。
  var AUTO_MAX_DIM = 0.92;
  /// 自定义底色的亮度上限。超过这条线，白系叠层就叠不出层级了（见 applyCustom）。
  /// 0.04 大约对应 #333，与内置主题那批 0.005–0.015 同属"明确的暗底"。
  var DARK_BG_CAP = 0.04;

  // -------------------------------------------------------------------------
  // 颜色工具
  //
  // 全部按 WCAG 2.x 的定义实现：先做 sRGB → 线性光逆伽马，再取亮度加权和。
  // 直接对 0..255 求平均是另一回事（那是"感知明度"的粗近似），拿它算对比度
  // 会在中间调上偏乐观。
  // -------------------------------------------------------------------------

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  function hex2rgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgb2hex(rgb) {
    var h = function (v) {
      var s = Math.round(clamp01(v / 255) * 255).toString(16);
      return s.length < 2 ? '0' + s : s;
    };
    return '#' + h(rgb[0]) + h(rgb[1]) + h(rgb[2]);
  }

  function toLinear(c) {
    var v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  /// 相对亮度，0（纯黑）.. 1（纯白）。
  function luminance(rgb) {
    return 0.2126 * toLinear(rgb[0]) + 0.7152 * toLinear(rgb[1]) + 0.0722 * toLinear(rgb[2]);
  }

  function contrast(l1, l2) {
    var a = Math.max(l1, l2) + 0.05;
    var b = Math.min(l1, l2) + 0.05;
    return a / b;
  }

  function rgb2hsl(rgb) {
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: l };
    var d = max - min;
    var s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    var h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return { h: h, s: s, l: l };
  }

  function hsl2rgb(h, s, l) {
    if (s === 0) {
      var v = Math.round(l * 255);
      return [v, v, v];
    }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    var f = function (t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
  }

  /// 从底色反推一个达到 `target` 对比度的前景色。
  ///
  /// 方向由底色明暗决定：暗底往上找浅色，亮底往下找深色；色相沿用底色的，
  /// 饱和度压到 0.35 再加一点点底，免得文字变成死灰或者过度染色——「有底色的
  /// 近白」比纯白在暗底上更耐看。二分 24 步足以收敛到 1/255 以内。
  function deriveForeground(bgHex, target) {
    var bg = hex2rgb(bgHex);
    if (!bg) return '#ffffff';
    var hsl = rgb2hsl(bg);
    var bgLum = luminance(bg);
    var lighter = bgLum < 0.5;
    var sat = clamp01(hsl.s * 0.35 + 0.03);
    var lo = lighter ? hsl.l : 0;
    var hi = lighter ? 1 : hsl.l;
    // 兜底从极端值起步：纯白/纯黑在任何底色上都达标，所以循环不可能找不到解。
    var best = rgb2hex(hsl2rgb(hsl.h, sat, lighter ? 1 : 0));
    for (var i = 0; i < 32; i += 1) {
      var mid = (lo + hi) / 2;
      // 关键：参与判定的必须是**量化后**的那个 8bit 颜色。用浮点候选去判定、
      // 却把四舍五入的结果交出去，会稳定差出 0.02 左右的对比度——正好让 7:1
      // 变成 6.98：看起来没问题，其实没达标。
      var hex = rgb2hex(hsl2rgb(hsl.h, sat, mid));
      if (contrast(luminance(hex2rgb(hex)), bgLum) >= target) {
        if (lighter) hi = mid; else lo = mid;
        best = hex;
      } else if (lighter) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    // 量化还会让收敛点偶尔差最后一点点，朝远离底色的方向补齐。
    var step = lighter ? 0.004 : -0.004;
    var at = rgb2hsl(hex2rgb(best)).l;
    for (var guard = 0; guard < 24 && contrast(luminance(hex2rgb(best)), bgLum) < target; guard += 1) {
      at = clamp01(at + step);
      best = rgb2hex(hsl2rgb(hsl.h, sat, at));
    }
    return best;
  }

  /// 把颜色朝白（或朝黑）混一点，用来做比底色略亮的面板。
  function shade(hex, amount, towardWhite) {
    var rgb = hex2rgb(hex);
    if (!rgb) return hex;
    var t = towardWhite ? 255 : 0;
    return rgb2hex([
      rgb[0] + (t - rgb[0]) * amount,
      rgb[1] + (t - rgb[1]) * amount,
      rgb[2] + (t - rgb[2]) * amount
    ]);
  }

  /// 在某个底色上放文字时该用黑还是白。取对比度更高的那个——这样黄色、
  /// 粉色这类"亮强调色"不会配出白字糊在亮底上的按钮。
  function inkOn(hex) {
    var lum = luminance(hex2rgb(hex) || [0, 0, 0]);
    return contrast(lum, 1) >= contrast(lum, 0) ? '#ffffff' : '#0a0a0a';
  }

  function rgbTriple(hex) {
    var rgb = hex2rgb(hex);
    return rgb ? rgb.map(function (v) { return Math.round(v); }).join(', ') : '255, 255, 255';
  }

  function rgba(hex, alpha) {
    return 'rgba(' + rgbTriple(hex) + ', ' + alpha + ')';
  }

  /// from 是 '#rrggbb' 或 'rgba(r, g, b, a)'，取它的 rgb 三元组。
  function anyToRgbTriple(from) {
    var hex = hex2rgb(from);
    if (hex) return rgbTriple(from);
    var m = /rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)/i.exec(String(from));
    return m ? [m[1], m[2], m[3]].join(', ') : '255, 255, 255';
  }

  // -------------------------------------------------------------------------
  // 令牌推导
  // -------------------------------------------------------------------------

  /// 由「底色 + 两个强调色」推出一整张主题令牌表。
  ///
  /// 自定义配色与内置二次元主题走的是**同一条**推导路径，所以自定义出来的
  /// 主题在文字对比度上与内置主题是同一档——不会出现"自己调的颜色特别难读"。
  function tokensFor(spec) {
    var bg = hex2rgb(spec.bg) ? spec.bg : '#0d0f14';
    var accent = hex2rgb(spec.accent) ? spec.accent : '#ff6a3d';
    var accent2 = hex2rgb(spec.accent2) ? spec.accent2 : '#4a7dff';
    var highlight = hex2rgb(spec.highlight) ? spec.highlight : accent;
    var bgLum = luminance(hex2rgb(bg));
    // 暗底朝白混，亮底朝黑混。当前自定义底色被夹在暗区间，这里保留分支是为了
    // 内置主题将来真要放浅色主题时不用回头改推导。
    var towardWhite = bgLum < 0.5;
    var lineTint = towardWhite ? '255, 255, 255' : '0, 0, 0';
    return {
      '--bg': bg,
      // 正文 7:1、次要 4.5:1：都在 AA 之上留了余量。壁纸压暗后有效底色会略亮
      // 于 --bg，余量就是留给那一段的。
      '--text': deriveForeground(bg, 7),
      '--muted': deriveForeground(bg, 4.5),
      '--panel': 'rgba(' + rgbTriple(shade(bg, 0.045, towardWhite)) + ', 0.72)',
      '--panel-solid': shade(bg, 0.05, towardWhite),
      '--panel-2': 'rgba(' + lineTint + ', 0.05)',
      '--line': 'rgba(' + lineTint + ', 0.10)',
      '--line-strong': 'rgba(' + lineTint + ', 0.18)',
      '--accent': accent,
      '--accent-2': accent2,
      '--accent-ink': inkOn(accent),
      // 角色分工见文件头：brand = 正在生效，highlight = 当前选中。
      '--brand': accent2,
      '--brand-rgb': rgbTriple(accent2),
      '--highlight': highlight,
      '--highlight-rgb': rgbTriple(highlight),
      '--hover': rgba(accent, 0.12)
    };
  }

  /// 把 state 里的三个颜色登记成一套主题。
  ///
  /// **不写存储、也不切换过去**：它的职责只是让 CUSTOM_ID 这套主题存在于
  /// 目录里。用户点「应用」时由 applyCustom 接着 apply；启动时则由 restore
  /// 调用它，好让 themes.js 记着的那个 id 有处可落——自定义主题是每次启动
  /// 现登记的，漏掉这一步，"记住了选择"就等于白记。
  function registerCustom() {
    if (!window.Theme) return;
    window.Theme.register({
      id: CUSTOM_ID,
      name: '自定义配色',
      note: '自定义 · 底色 + 双强调色，文字色按 AA 反推',
      tokens: tokensFor({
        bg: state.bg,
        accent: state.accent,
        accent2: state.accent2,
        highlight: state.accent2
      })
    });
  }

  function registerAnimeThemes() {
    if (!window.Theme) return;
    ANIME_THEMES.forEach(function (spec) {
      window.Theme.register({
        id: spec.id,
        name: spec.name,
        note: spec.note,
        tokens: tokensFor(spec)
      });
    });
  }

  // -------------------------------------------------------------------------
  // 壁纸层
  // -------------------------------------------------------------------------

  var layer = null;   // { root, img, scrim }
  var state = {
    id: '',           // 壁纸文件名；空串 = 不铺壁纸
    opacity: 0.55,    // 壁纸自身强度（图 → 底色的覆盖率）
    dim: 0,           // 压暗层透明度（0..1）
    blur: 0,          // 背景模糊 px
    auto: true,       // 自动压暗
    /// 壁纸是否被用户钉住。钉住 = 在画廊里亲手点过（包括点「无」），此后换
    /// 主题不再动它。没钉住时壁纸**跟着主题走**——这样"选中某主题就有对应
    /// 背景图"才成立。旧存档没有这个字段：只要存过一个文件名就当是用户选的，
    /// 老用户的选择不会被升级悄悄改掉。
    pinned: false,
    bg: '#141821',
    accent: '#ff6a3d',
    accent2: '#4a7dff'
  };

  /// 「选壁纸」自己触发的那次换主题，不该反过来改写壁纸。
  /// 见 setWallpaper：那里先按用户点的图设好 state.id，再 apply 推荐主题；
  /// 若放任 followTheme 跑，用户刚点的那张当场就被主题默认图顶掉了。
  var suppressFollow = 0;

  /// 让壁纸跟上当前主题。只在「没钉住 + 不是选壁纸引发的那次 apply」时生效，
  /// 且目标图必须真的在目录里——映射写错不能把壁纸清成空。
  function followTheme(themeId) {
    if (suppressFollow > 0 || state.pinned) return;
    var want = wallForTheme(themeId);
    if (!want || want === state.id) return;
    state.id = want;
  }

  function wallById(id) {
    for (var i = 0; i < WALLPAPERS.length; i += 1) {
      if (WALLPAPERS[i].id === id) return WALLPAPERS[i];
    }
    return null;
  }

  /// 壁纸叠完后的**有效亮度**。
  ///
  /// 这是一个刻意的近似：真实合成发生在线性光之外，而这里用亮度线性插值。
  /// 它的用途是给压暗量定一个"照这个走大体不会错"的初值，再由用户微调，
  /// 所以不需要精确；把每次拖动都做成一次真实渲染取色反而是过度设计。
  function effectiveLum(wallLum, bgLum, opacity, dim) {
    var afterImage = opacity * wallLum + (1 - opacity) * bgLum;
    return (1 - dim) * afterImage + dim * bgLum;
  }

  /// 自动压暗：解出「有效亮度 ≤ 底色亮度 + AUTO_BUDGET」所需的最小压暗量。
  function autoDim(wallLum, bgLum, opacity) {
    var budget = bgLum + AUTO_BUDGET;
    var afterImage = opacity * wallLum + (1 - opacity) * bgLum;
    if (afterImage <= budget) return 0;
    var span = afterImage - bgLum;
    if (span <= 1e-6) return 0;
    return Math.min(AUTO_MAX_DIM, clamp01((afterImage - budget) / span));
  }

  function currentThemeTokens() {
    var t = window.Theme && window.Theme.current && window.Theme.current();
    return (t && t.tokens) || {};
  }

  function currentBgLum() {
    var tokens = currentThemeTokens();
    var rgb = hex2rgb(tokens['--bg'] || '#0a0a0a');
    return rgb ? luminance(rgb) : 0.004;
  }

  /// 本次实际生效的压暗量：自动档按壁纸亮度解算，手动档用用户的值。
  function effectiveDim() {
    var w = wallById(state.id);
    if (!w) return 0;
    if (!state.auto) return clamp01(state.dim);
    return autoDim(w.lum / 255, currentBgLum(), clamp01(state.opacity));
  }

  /// 文字实际压在什么底色上：面板（--panel，不透明度 0.72）盖在"壁纸 + 压暗"
  /// 之上，所以真正决定可读性的不是壁纸那一层，而是这两层合成后的结果。
  ///
  /// 把面板算进来不是为了让数字好看：漏掉它会把一个其实达标的组合报成"偏低"，
  /// 用户按提示一路加大压暗，最后壁纸完全看不见——那才是真的把功能做坏了。
  function backdropLum() {
    var w = wallById(state.id);
    if (!w) return currentBgLum();
    var afterScrim = effectiveLum(w.lum / 255, currentBgLum(), clamp01(state.opacity), effectiveDim());
    var rgb = hex2rgb(currentThemeTokens()['--panel-solid'] || '#121213');
    var panelLum = rgb ? luminance(rgb) : currentBgLum();
    // 0.72 是 --panel 的不透明度，与 style.css/themes.js 里那份保持一致。
    return 0.72 * panelLum + 0.28 * afterScrim;
  }

  /// 正文在面板上的对比度估计。
  ///
  /// 数值依然是近似的（亮度按线性插值合成，而真实合成发生在线性光之前），
  /// 但两条边界是对的：没铺壁纸时报的就是主题自身那 7:1 / 4.5:1，铺满亮壁纸
  /// 且不压暗时会明确掉到 AA 以下并触发自动压暗。这是"提示"该有的精度。
  function readability() {
    var textRgb = hex2rgb(currentThemeTokens()['--text'] || '#e8ecef');
    if (!textRgb) return { ratio: 21, verdict: 'ok' };
    var lum = backdropLum();
    // 折回一个中性灰再算对比度：文字色的色相对比值影响很小，而这里要回答的是
    // "底色压暗够不够"，不是精确复算某个像素。
    var g = Math.pow(clamp01(lum), 1 / 2.2) * 255;
    var ratio = contrast(luminance(textRgb), luminance([g, g, g]));
    var verdict = ratio >= 7 ? 'ok' : (ratio >= 4.5 ? 'fair' : 'low');
    return { ratio: ratio, verdict: verdict };
  }

  function ensureLayer() {
    if (layer || !document.body) return layer;
    var root = document.createElement('div');
    root.id = 'ts-wallpaper';
    root.setAttribute('aria-hidden', 'true');
    var img = document.createElement('div');
    img.className = 'ts-wall-img';
    var scrim = document.createElement('div');
    scrim.className = 'ts-wall-scrim';
    root.appendChild(img);
    root.appendChild(scrim);
    // 插在 body 最前面：z-index 负数组自己会把它压到 #ambient 之下，插前面
    // 只是让 DOM 顺序和层叠顺序读起来一致。
    document.body.insertBefore(root, document.body.firstChild);
    layer = { root: root, img: img, scrim: scrim };
    return layer;
  }

  /// 壁纸的绝对 URL。文件名过一遍 encodeURIComponent：它是按名字寻址的，
  /// 名字里出现需要转义的字符时不能把 URL 拼坏。
  function wallUrl(id) { return WALL_BASE + encodeURIComponent(id); }

  /// 取不到的图记在这张表里，之后不再重复试探：结果是确定的，每换一次主题
  /// 就重试一次只会把控制台刷满。
  var badWalls = {};
  var probedWalls = {};

  /// 背景图是不是真的取得到。这是"主题缺少背景资源"在**运行时**的那一半：
  /// 目录里写错了名字、或服务端确实没有这张，浏览器只会静默留一层空白，
  /// 不会报错——必须有个地方把它接住并换上兜底图。
  function probeWall() {
    // 契约脚本这类非浏览器环境没有 Image，直接跳过（那里验证的是目录解析）。
    if (typeof Image !== 'function') return;
    if (!state.id || state.id === DEFAULT_WALL) return;
    if (badWalls[state.id] || probedWalls[state.id]) return;
    var probing = state.id;
    probedWalls[probing] = true;
    var probe = new Image();
    probe.onerror = function () {
      badWalls[probing] = true;
      // DEFAULT_WALL 自己失败就停在原地，否则会无限回落。
      if (state.id === probing && wallById(DEFAULT_WALL)) {
        state.id = DEFAULT_WALL;
        paintWallpaper();
        emit();
      }
    };
    probe.src = wallUrl(probing);
  }

  /// 把当前状态刷到壁纸层上。
  function paintWallpaper() {
    var l = ensureLayer();
    if (!l) return;
    if (!state.id) {
      l.root.classList.remove('on');
      l.img.style.backgroundImage = '';
      l.img.removeAttribute('data-wall');
      return;
    }
    // 用 data-wall 记当前图，而不是比对 style.backgroundImage：后者是浏览器
    // **规范化后**的字符串（各引擎对引号与相对路径的处理并不完全一致），
    // 拿它做去抖会在某些引擎上永远不等，于是拖动滑块时每一帧都重写一次图、
    // 每帧重新解码——这正是那段注释原本想避免的事。
    if (l.img.getAttribute('data-wall') !== state.id) {
      l.img.setAttribute('data-wall', state.id);
      l.img.style.backgroundImage = 'url("' + wallUrl(state.id) + '")';
    }
    l.root.classList.add('on');
    l.root.style.setProperty('--ts-wall-opacity', String(clamp01(state.opacity)));
    l.root.style.setProperty('--ts-wall-blur', state.blur + 'px');
    // 压暗层本身取主题底色，于是"压暗"永远是往当前主题的底色方向压，
    // 换主题不用重新调——这正是各主题 --text 反推的基准色。
    // 写成百分比字符串：theme-studio.css 直接把它当 color-mix 的占比位用。
    var dim = effectiveDim();
    l.root.style.setProperty('--ts-wall-dim', (dim * 100).toFixed(1) + '%');
    // 上下两端再多压一档：顶栏与播放条底下没有面板垫着，直接就是壁纸。
    l.root.style.setProperty('--ts-wall-dim-edge', (Math.min(1, dim + 0.12) * 100).toFixed(1) + '%');
    var tokens = currentThemeTokens();
    l.root.style.setProperty('--ts-wall-scrim', tokens['--bg'] || '#0a0a0a');
    probeWall();
  }

  function persist() {
    try {
      localStorage.setItem(WALL_KEY, JSON.stringify({
        id: state.id,
        opacity: state.opacity,
        dim: state.dim,
        blur: state.blur,
        auto: state.auto,
        pinned: state.pinned
      }));
    } catch (e) { /* 隐私模式 */ }
  }

  /// 把存过的观感读回来。
  ///
  /// 两段必须互不牵连：**没铺过壁纸不等于没调过配色**。早先这里读到壁纸为空
  /// 就 `return`，于是"只改了自定义配色"的用户每次刷新都退回默认——那一次
  /// 提前返回把下面整段都跳过了。
  function restore() {
    try {
      var raw = localStorage.getItem(WALL_KEY);
      if (raw) {
        var s = JSON.parse(raw);
        if (s && typeof s === 'object') {
          if (typeof s.id === 'string' && wallById(s.id)) state.id = s.id;
          if (typeof s.opacity === 'number') state.opacity = clamp01(s.opacity);
          if (typeof s.dim === 'number') state.dim = clamp01(s.dim);
          if (typeof s.blur === 'number') state.blur = Math.max(0, Math.min(40, s.blur));
          if (typeof s.auto === 'boolean') state.auto = s.auto;
          // 没存过 pinned 的旧存档：存着一个文件名就说明用户亲手挑过，
          // 按"已钉住"还原，升级不该把他的选择换成主题默认图。
          state.pinned = typeof s.pinned === 'boolean' ? s.pinned : !!state.id;
        }
      }
    } catch (e) { /* 坏数据当没存过 */ }

    try {
      var rawCustom = localStorage.getItem(CUSTOM_KEY);
      if (rawCustom) {
        var c = JSON.parse(rawCustom);
        if (c && hex2rgb(c.bg) && hex2rgb(c.accent) && hex2rgb(c.accent2)) {
          state.bg = c.bg;
          state.accent = c.accent;
          state.accent2 = c.accent2;
          // 三个颜色还原出来还不算完：这套主题本身也得重新登记回去。
          // 登记这一步若由 pending 机制接着 apply，用户上次选的就是它。
          registerCustom();
        }
      }
    } catch (e) { /* 同上 */ }
  }

  // -------------------------------------------------------------------------
  // 对外动作
  // -------------------------------------------------------------------------

  /// 选壁纸。`id` 为空串即撤掉壁纸。
  ///
  /// 同时把壁纸推荐的二次元主题换上：壁纸与主题是一起被"看"的，让用户先看到
  /// 一套配好的组合，比先换壁纸再自己去调主题省事得多。用户随后手动换主题
  /// 不会被覆盖——这里只在选壁纸的那一刻推一次。
  function setWallpaper(id, opts) {
    opts = opts || {};
    state.id = wallById(id) ? id : '';
    // 用户亲手点过（含点「无」）就把壁纸钉住，此后换主题不再覆盖它。
    state.pinned = true;
    if (state.id && !opts.keepTheme) {
      var w = wallById(state.id);
      // 抑制跟随：这次 apply 是"选壁纸"顺带换上推荐主题。放任 followTheme
      // 跑的话，它按主题又把壁纸改回默认那张，用户刚点的图当场就没了。
      suppressFollow += 1;
      if (w && w.theme && window.Theme) window.Theme.apply(w.theme);
      suppressFollow -= 1;
    }
    paintWallpaper();
    if (opts.persist !== false) persist();
    emit();
  }

  function setOptions(next) {
    next = next || {};
    if (typeof next.opacity === 'number') state.opacity = clamp01(next.opacity);
    if (typeof next.dim === 'number') state.dim = clamp01(next.dim);
    if (typeof next.blur === 'number') state.blur = Math.max(0, Math.min(40, next.blur));
    if (typeof next.auto === 'boolean') state.auto = next.auto;
    paintWallpaper();
    persist();
    emit();
  }

  /// 应用自定义配色。
  ///
  /// 底色被夹在暗色区间：style.css 里那批白系叠层（--surface-* / --field-*
  /// / --glass-line）按契约只能定义在 :root，不随主题走。底色一浅，它们就从
  /// "叠一层提高一级"变成"在白底上叠白"，面板层级整个消失。
  ///
  /// 夹的是**相对亮度**而不是 HSL 明度：后者和感知亮度不是一回事（高饱和的
  /// 蓝与灰可能同 l 而亮度差一个数量级），而这里的保证本来就是关于亮度的。
  /// 做法是按比例缩 RGB 而不是改 HSL 的 l——缩 RGB 精确保留色相，改 l 会让
  /// 用户挑的颜色变味。
  function applyCustom(spec) {
    spec = spec || {};
    if (hex2rgb(spec.bg)) state.bg = spec.bg;
    if (hex2rgb(spec.accent)) state.accent = spec.accent;
    if (hex2rgb(spec.accent2)) state.accent2 = spec.accent2;

    var base = hex2rgb(state.bg);
    var clamped = luminance(base) > DARK_BG_CAP;
    if (clamped) {
      var scale = 1;
      var shrunk = base;
      // 亮度对缩放单调，逐档缩到线下即可；40 档 0.92 足够覆盖最亮的白。
      for (var i = 0; i < 40 && luminance(shrunk) > DARK_BG_CAP; i += 1) {
        scale *= 0.92;
        shrunk = [base[0] * scale, base[1] * scale, base[2] * scale];
      }
      state.bg = rgb2hex(shrunk);
    }

    registerCustom();
    window.Theme.apply(CUSTOM_ID);
    try {
      localStorage.setItem(CUSTOM_KEY, JSON.stringify({
        bg: state.bg,
        accent: state.accent,
        accent2: state.accent2
      }));
    } catch (e) { /* 隐私模式 */ }
    paintWallpaper();
    emit();
    return { clamped: clamped, bg: state.bg };
  }

  // -------------------------------------------------------------------------
  // 设置界面
  // -------------------------------------------------------------------------

  var listeners = [];
  function emit() {
    listeners.forEach(function (fn) {
      try { fn(state); } catch (e) { /* 单个订阅者出错不该拖垮换肤 */ }
    });
  }

  var H = null; // 宿主：{ toast }
  function el(id) { return document.getElementById(id); }

  function renderWallGrid() {
    var host = el('ts-wall-grid');
    if (!host) return;
    host.innerHTML = '';
    WALLPAPERS.forEach(function (w) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ts-wall-item';
      b.dataset.wallId = w.id;
      b.setAttribute('aria-pressed', String(state.id === w.id));
      b.title = w.tone + ' · ' + w.label;
      var thumb = document.createElement('span');
      thumb.className = 'ts-wall-thumb';
      thumb.style.backgroundImage = 'url("' + wallUrl(w.id) + '")';
      var name = document.createElement('span');
      name.className = 'ts-wall-name';
      name.textContent = w.label;
      b.appendChild(thumb);
      b.appendChild(name);
      b.onclick = function () {
        // 再点一次当前壁纸 = 取消，省掉一个单独的"关闭壁纸"按钮。
        setWallpaper(state.id === w.id ? '' : w.id);
        renderWallGrid();
      };
      host.appendChild(b);
    });
    // 末尾一格是"无壁纸"，与壁纸卡同尺寸，位置固定在最右。
    var off = document.createElement('button');
    off.type = 'button';
    off.className = 'ts-wall-item ts-wall-off';
    off.dataset.wallId = '';
    off.setAttribute('aria-pressed', String(!state.id));
    off.title = '不铺壁纸';
    off.innerHTML = '<span class="ts-wall-thumb"></span><span class="ts-wall-name">无</span>';
    off.onclick = function () {
      setWallpaper('');
      renderWallGrid();
    };
    host.appendChild(off);
  }

  function renderThemeSwatches() {
    var host = el('ts-themes');
    if (!host || !window.Theme) return;
    var active = (window.Theme.current() || {}).id;
    host.innerHTML = '';
    ANIME_THEMES.forEach(function (spec) {
      var tokens = tokensFor(spec);
      var b = document.createElement('button');
      b.type = 'button';
      // 复用 .theme-swatch：色块的画法（盘心 = 底色、外环 = 主色→次色）是
      // stage.css 里那条共享规则，这里只喂同样的三个变量，不另起一套画法。
      b.className = 'theme-swatch ts-theme-swatch';
      b.style.cssText = '--t-bg:' + tokens['--bg']
        + ';--t-accent:' + tokens['--accent']
        + ';--t-accent-2:' + tokens['--accent-2'];
      b.title = spec.name + ' · ' + spec.note;
      b.setAttribute('aria-label', spec.name);
      b.setAttribute('aria-pressed', String(active === spec.id));
      // 形态标识：色块本身也按 skin 长成不同的样子（圆角/描边），
      // 光看七个圆点分不出"换了皮肤"。
      b.setAttribute('data-skin', spec.skin);
      b.onclick = function () {
        window.Theme.apply(spec.id);
        renderThemeSwatches();
      };
      host.appendChild(b);
    });
    paintSkinPreview(active);
  }

  /// 形态名是给用户看的说明：只写颜色他会以为主题就是换个色。
  var SKIN_LABEL = {
    blade: '锐角 · 斜切刀纹',
    petal: '大圆角 · 柔光飘落',
    chakra: '脉冲 · 同心波纹',
    scroll: '方正 · 装裱双线',
    ember: '暖光 · 呼吸外晕',
    kaleido: '旋转 · 勾玉纹理',
    dawn: '细网格 · 晨光扫过',
    plain: '统一组件层圆角'
  };

  function paintSkinPreview(activeId) {
    var box = el('ts-skin-preview');
    var nameEl = el('ts-skin-name');
    if (!box || !nameEl) return;
    var spec = null;
    for (var i = 0; i < ANIME_THEMES.length; i += 1) {
      if (ANIME_THEMES[i].id === activeId) spec = ANIME_THEMES[i];
    }
    if (!spec) {
      box.hidden = true;
      nameEl.textContent = '';
      return;
    }
    box.hidden = false;
    nameEl.textContent = spec.name + '　形态：' + (SKIN_LABEL[spec.skin] || spec.skin);
  }

  function syncControls() {
    var w = wallById(state.id);
    var opacity = el('ts-wall-opacity');
    var dim = el('ts-wall-dim');
    var blur = el('ts-wall-blur');
    var auto = el('ts-wall-auto');
    if (opacity) opacity.value = String(Math.round(state.opacity * 100));
    if (dim) dim.value = String(Math.round(effectiveDim() * 100));
    if (blur) blur.value = String(Math.round(state.blur));
    if (auto) auto.checked = !!state.auto;
    if (dim) {
      // 自动档下压暗量是算出来的，用户拖它也改不动结果，所以禁掉而不是
      // 让它看起来能用却毫无反应。
      dim.disabled = !!state.auto || !state.id;
    }
    if (opacity) opacity.disabled = !state.id;

    var opacityVal = el('ts-wall-opacity-val');
    var dimVal = el('ts-wall-dim-val');
    var blurVal = el('ts-wall-blur-val');
    if (opacityVal) opacityVal.textContent = Math.round(clamp01(state.opacity) * 100) + '%';
    if (dimVal) dimVal.textContent = Math.round(effectiveDim() * 100) + '%';
    if (blurVal) blurVal.textContent = Math.round(state.blur) + 'px';

    var read = readability();
    var contrast = el('ts-contrast');
    if (contrast) {
      if (!w) {
        contrast.textContent = '未铺壁纸';
        contrast.className = 'hint';
      } else {
        var label = read.verdict === 'ok' ? '文字对比度良好'
          : (read.verdict === 'fair' ? '文字对比度尚可' : '文字偏糊，建议加大压暗');
        contrast.textContent = label + '（约 ' + read.ratio.toFixed(1) + ':1）';
        contrast.className = 'hint ts-contrast-' + read.verdict;
      }
    }

    var bg = el('ts-bg');
    var accent = el('ts-accent');
    var accent2 = el('ts-accent2');
    if (bg) bg.value = state.bg;
    if (accent) accent.value = state.accent;
    if (accent2) accent2.value = state.accent2;

    var note = el('ts-note');
    if (note) {
      var bgNow = currentThemeTokens()['--bg'] || '—';
      note.textContent = w
        ? '壁纸已铺底，压暗取当前主题底色（' + bgNow + '）。'
          + (state.pinned ? '已手动指定，换主题时保持不变。' : '跟随主题自动切换。')
        : (state.pinned
          ? '已手动关闭壁纸：换主题也不会自动铺。'
          : '未铺壁纸时只有主题底色与辉光，即改造前的观感。');
    }
  }

  function render() {
    renderThemeSwatches();
    renderWallGrid();
    syncControls();
  }

  function initControls() {
    var opacity = el('ts-wall-opacity');
    if (opacity) {
      opacity.oninput = function () { setOptions({ opacity: Number(opacity.value) / 100 }); syncControls(); };
    }
    var dim = el('ts-wall-dim');
    if (dim) {
      // 手动拖压暗 = 显式放弃自动档，否则拖了没反应更让人困惑。
      dim.oninput = function () {
        setOptions({ dim: Number(dim.value) / 100, auto: false });
        syncControls();
      };
    }
    var blur = el('ts-wall-blur');
    if (blur) {
      blur.oninput = function () { setOptions({ blur: Number(blur.value) }); syncControls(); };
    }
    var auto = el('ts-wall-auto');
    if (auto) {
      auto.onchange = function () { setOptions({ auto: auto.checked }); syncControls(); };
    }
    var apply = el('ts-custom-apply');
    if (apply) {
      apply.onclick = function () {
        var r = applyCustom({
          bg: el('ts-bg') ? el('ts-bg').value : state.bg,
          accent: el('ts-accent') ? el('ts-accent').value : state.accent,
          accent2: el('ts-accent2') ? el('ts-accent2').value : state.accent2
        });
        renderThemeSwatches();
        syncControls();
        if (H && H.toast) {
          H.toast(r.clamped
            ? '自定义配色已应用（底色已收敛到暗色区间，以保证面板与玻璃质感一致）'
            : '自定义配色已应用');
        }
      };
    }
    var reset = el('ts-custom-reset');
    if (reset) {
      reset.onclick = function () {
        state.bg = '#141821';
        state.accent = '#ff6a3d';
        state.accent2 = '#4a7dff';
        try { localStorage.removeItem(CUSTOM_KEY); } catch (e) { /* 隐私模式 */ }
        window.Theme.apply(ANIME_THEMES[0].id);
        renderThemeSwatches();
        syncControls();
      };
    }
  }

  /// 给「没有封面的东西」找一张壁纸当占位素材。
  ///
  /// 歌单/专辑网格里总有几个没有封面的条目，默认的纯色占位在壁纸背景上很显眼。
  /// 这里按 id 稳定散列到一张壁纸上——同一个条目每次拿到同一张，不会刷新一次
  /// 换一个花色。返回的是可直接塞进 background-image 的 url(...)。
  function artPlaceholder(seed) {
    if (!WALLPAPERS.length) return '';
    var h = 0;
    var s = String(seed || '');
    for (var i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 100003;
    var w = WALLPAPERS[h % WALLPAPERS.length];
    return 'url("' + wallUrl(w.id) + '")';
  }

  function init() {
    // 订阅必须排在 restore 之前：restore 会把存过的自定义配色重新登记，而登记
    // 一个"存储里正等着被兑现"的主题会当场触发 Theme.apply。订阅晚一步，这次
    // 广播就没有听众，形态与壁纸层会因为收不到通知停在初始值上。
    if (window.Theme) {
      window.Theme.onChange(function (theme) {
        // 跟随必须排在刷层之前：先按新主题定好该用哪张图，paintWallpaper
        // 才会把它写进 DOM，否则这一帧刷的还是上一张。
        followTheme(theme && theme.id);
        applySkin(theme && theme.id);
        paintWallpaper();
        renderThemeSwatches();
        syncControls();
      });
    }

    restore();

    registerAnimeThemes();
    // 注册本身不广播（Theme.register 只改目录）。但顶栏菜单、设置页的
    // 「主题色」下拉与色块组都是**按目录渲染**的，不广播就等于新主题只活在
    // 这一组控件里，用户在原来的入口找不到——静默少了一半功能。
    // 用 silent 重放一次当前主题即可触发 Theme.onChange：它不写 localStorage，
    // 也不改选择，只是把"目录变了"这件事说出去。
    var currentTheme = window.Theme && window.Theme.current && window.Theme.current();
    if (currentTheme) {
      window.Theme.apply(currentTheme.id, { silent: true });
      // apply 触发的那次 onChange 已经刷过 skin 与壁纸；这里再补一次是为了
      // 「Theme 存在但当前没有主题」以及契约脚本直接跑 init 的情形。
      applySkin(currentTheme.id);
      followTheme(currentTheme.id);
    }

    paintWallpaper();
    initControls();
    render();
  }

  window.ThemeStudio = {
    bind: function (host) { H = host; },
    init: init,
    // 壁纸与主题的对外动作：app.js 与将来的其它视图（如封面占位）都用这几个。
    setWallpaper: setWallpaper,
    setOptions: setOptions,
    applyCustom: applyCustom,
    artPlaceholder: artPlaceholder,
    wallpapers: function () { return WALLPAPERS.slice(); },
    /// 主题 → 背景图的唯一入口。供宿主与契约脚本做"每套主题都有背景"的检查。
    wallpaperForTheme: wallForTheme,
    defaultWallpaper: function () { return DEFAULT_WALL; },
    state: state,
    /// 供契约脚本与排障读取：当前有效压暗量与可读性估计。
    effectiveDim: effectiveDim,
    readability: readability,
    render: render
  };
})();
