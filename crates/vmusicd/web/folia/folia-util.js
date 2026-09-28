// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
// folia 等价移植：纯函数工具。无 DOM 依赖，UMD-lite 尾部允许 Node require 做验证。
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FoliaUtil = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 数值归一：非有限值（undefined/NaN/Infinity 等）一律回退到 f，避免脏时间轴污染下游计算。
  function num(v, f) { v = Number(v); return isFinite(v) ? v : f; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  // 帧率无关一阶低通：tauMs = 追到 63% 的毫秒数（stage3d 同款公式）。
  function damp(cur, target, tauMs, dtMs) {
    if (!(tauMs > 0)) return target;
    return cur + (target - cur) * (1 - Math.exp(-Math.max(0, dtMs) / tauMs));
  }
  function easeOutCubic(t) { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, 3); }
  function srand(seed) { var x = Math.sin(seed) * 10000; return x - Math.floor(x); }

  // 按时间定位活动行：最后一个 start_ms<=tMs 的下标；首行开始前返回 -1。
  // 不信任 Stage.lyrics().index（它在未定位时被规整为 0）。
  function activeLineIndex(lines, tMs) {
    if (!lines || !lines.length) return -1;
    var lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (num(lines[mid].start_ms, 0) <= tMs) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

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
    var start = num(line.start_ms, 0);
    var end0 = num(line.end_ms, start);
    var end = end0 < start ? start : end0;
    if (line.words && line.words.length) {
      // 末词 end_ms 缺失/非数值时回退行 end；早于行起点的异常值同样回退。
      var w = num(line.words[line.words.length - 1].end_ms, end);
      if (w >= start) return w;
    }
    return end;
  }
  function renderHints(line) {
    var start = num(line.start_ms, 0);
    var end0 = num(line.end_ms, start);
    var end = end0 < start ? start : end0;
    var raw = end - start;
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
    // word 时间戳同样做防御性归一：缺省 start 回退行 start，缺省 end 回退行 end（整词时间戳缺失时沿用行窗口）。
    var wordStart = num(word.start_ms, num(line.start_ms, 0));
    var wordEnd = num(word.end_ms, num(line.end_ms, wordStart));
    if (hints.revealMode === 'instant') return hints.renderEndMs;
    if (hints.revealMode === 'fast') return Math.min(hints.renderEndMs, Math.max(wordEnd, wordStart + 120));
    return wordEnd;
  }
  // 三态区间语义（按时间 tMs 划分，端点闭区间、彼此无重叠无空洞）：
  // - waiting：t < start_ms - lookaheadMs，词尚未进入提前点亮段；
  // - active：start_ms - lookaheadMs <= t <= activeEnd，含 lookahead 提前点亮段，故 t 可早于 start_ms；
  // - passed：t > activeEnd，以严格大于分界（activeEnd 瞬间仍属 active）。
  // 因此 0 时长词（activeEnd 收敛到起点附近）只在开始前 lookahead 到起点的那一瞬间为 active，之后立即 passed。
  function wordState(word, hints, line, tMs) {
    var startMs = num(word.start_ms, num(line.start_ms, 0));
    var activeEnd = wordActiveEndMs(word, hints, line);
    if (tMs >= startMs - hints.lookaheadMs && tMs <= activeEnd) return 'active';
    if (tMs > activeEnd) return 'passed';
    return 'waiting';
  }

  // ---- 字素（Array.from 正确处理代理对；组合记号随基字）----
  // Intl.Segmenter 构造代价高，惰性单例：首次需要时构造一次并复用。
  var segmenterZh = null;
  function graphemes(text) {
    if (!text) return [];
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      if (!segmenterZh) segmenterZh = new Intl.Segmenter('zh', { granularity: 'grapheme' });
      var seg = segmenterZh;
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
    activeLineIndex: activeLineIndex,
    renderHints: renderHints, wordState: wordState,
    graphemes: graphemes, graphemeTimings: graphemeTimings, hasReadable: hasReadable
  };
});
