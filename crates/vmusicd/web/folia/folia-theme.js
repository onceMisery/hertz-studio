// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
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
    // 浏览器里恒为 window.getComputedStyle；document.getComputedStyle 仅作无 window 实现的兜底。
    var getStyle = window.getComputedStyle || document.getComputedStyle;
    if (typeof getStyle !== 'function') return '';
    var v = getStyle.call(window, document.documentElement).getPropertyValue(name);
    return v ? v.trim() : '';
  }

  // reactivity：stage3d 律动强度（0–2）。<0.7 calm，>1.6 chaotic。
  function intensityFrom(reactivity) {
    if (typeof reactivity === 'number' && reactivity < 0.7) return 'calm';
    if (typeof reactivity === 'number' && reactivity > 1.6) return 'chaotic';
    return 'normal';
  }

  // ---- spec 4.2 封面取色适配口径 ----
  // stage.js 封面取色写入 --music-highlight 的是 hsl 字符串（形如 hsl(210 70% 68%)
  // 空格现代语法，hsl(210, 70%, 68%) 逗号语法同样存在），不是 hex；默认/部分主题下
  // 它经 stage.css 回退为 var(--accent)，值可能是 hex（含白色 #ffffff）。另有
  // --music-highlight-rgb 为 "r, g, b" 三元组（如 226, 176, 113），无封面取色时
  // 该变量被 removeProperty（读回为空）。
  var NEUTRAL_SAT_MAX = 20;      // 低于此饱和度视为无彩色（白/灰），回退 P2，避免给中性色注入彩色 accent
  var ACCENT_SAT_MIN = 55, ACCENT_SAT_MAX = 80, ACCENT_L_MIN = 55, ACCENT_L_MAX = 65;
  var BG_LIGHTNESS = 8, BG_SAT_MUL = 0.5, SECONDARY_SAT_MUL = 0.28, SECONDARY_LIGHTNESS = 42;

  // 解析取色源色，统一返回 [h,s,l]（h 0–360，s/l 0–100）；任何格式都不命中返回 null。
  function readSourceHsl() {
    // 三个捕获值必须均为有限数；局部小函数，避免 NaN/Infinity 漏到下游拼色。
    function fin3(a, b, c) { return isFinite(a) && isFinite(b) && isFinite(c); }
    var raw = cssVar('--music-highlight');
    var m, c, h, s, l, r, g, b;
    if (raw) {
      c = U.hexToRgb(raw);
      if (c) return U.rgbToHsl(c.r, c.g, c.b);
      // i：兼容 HSL(...)/HSLA(... 大写写法；-?\d*\.?\d+ 排除 '.'/'..' 这类纯点串。
      m = /hsla?\(\s*(-?\d*\.?\d+)(?:deg)?[\s,]+(-?\d*\.?\d+)%?[\s,]+(-?\d*\.?\d+)%?/i.exec(raw);
      if (m) {
        h = parseFloat(m[1]); s = parseFloat(m[2]); l = parseFloat(m[3]);
        // 任一捕获值非有限数：本分支视为未命中，继续尝试后续来源。
        if (fin3(h, s, l)) return [h, s, l];
      }
      m = /rgba?\(\s*(-?\d*\.?\d+)[\s,]+(-?\d*\.?\d+)[\s,]+(-?\d*\.?\d+)/i.exec(raw);
      if (m) {
        r = parseFloat(m[1]); g = parseFloat(m[2]); b = parseFloat(m[3]);
        // rgb 三元组还要求落在 0–255，越界（如负值）同样视为未命中。
        if (fin3(r, g, b) && r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255) {
          return U.rgbToHsl(r, g, b);
        }
      }
    }
    raw = cssVar('--music-highlight-rgb');
    if (raw) {
      m = /^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*$/.exec(raw);
      if (m) {
        r = parseInt(m[1], 10); g = parseInt(m[2], 10); b = parseInt(m[3], 10);
        if (fin3(r, g, b) && r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255) {
          return U.rgbToHsl(r, g, b);
        }
      }
    }
    return null;
  }

  function resolve(reactivity) {
    var src = readSourceHsl();
    // 无源色，或白/灰等无彩色（s < NEUTRAL_SAT_MAX）：一律走 P2 默认主题，
    // accent 保持 #f4f4f5，不再把低饱和 accent 伪造成粉红色。
    if (!src || src[1] < NEUTRAL_SAT_MAX) {
      return shallow(DEFAULT, intensityFrom(reactivity));
    }
    return {
      name: 'stage-palette',
      backgroundColor: U.hslToHex(src[0], src[1] * BG_SAT_MUL, BG_LIGHTNESS),
      primaryColor: '#f4f4f5',
      accentColor: U.hslToHex(src[0],
        U.clamp(src[1], ACCENT_SAT_MIN, ACCENT_SAT_MAX),
        U.clamp(src[2], ACCENT_L_MIN, ACCENT_L_MAX)),
      secondaryColor: U.hslToHex(src[0], src[1] * SECONDARY_SAT_MUL, SECONDARY_LIGHTNESS),
      wordColors: [],
      animationIntensity: intensityFrom(reactivity),
      fontStyle: 'sans'
    };
  }

  function shallow(base, animationIntensity) {
    return {
      name: base.name, backgroundColor: base.backgroundColor, primaryColor: base.primaryColor,
      accentColor: base.accentColor, secondaryColor: base.secondaryColor,
      wordColors: (base.wordColors || []).slice(),
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
