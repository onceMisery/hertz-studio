// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 手绘舞台：把舞台的几条关键轮廓换成一笔画出来的铅笔线，并且让它们跟着鼓点抖。
//
// 关键取舍：**不做"把手绘贴图铺上去"，而是"用手绘算法重新生成几何"。**
//
// 贴一张手绘纹理当作背景/遮罩是最省事的做法，但会有三个死结：缩放会糊、
// 主题换色要重做图、线条粗细不随字号变。换成"给定几何 → 现算一条抖动路径"
// 之后这三个问题同时消失：矢量线条在任意尺寸下都是利的，描边色走 CSS 变量
// 所以换主题自动跟随，而"抖多少"变成了一个可以绑到音量的数字。
//
// 所以这里自带一个极小的 rough 引擎（约 80 行），而不是引 rough.js：
// 需要的只有"折线 / 闭合折线 / 椭圆"三种图元 + 两个抖动参数，rough.js 的
// 填充排线、多笔触、SVG/Canvas 双后端在这一个场景里都用不到。
//
// 手绘层刻意跑在更低的帧率上（约 16fps）。这既省开销，也刚好是手绘动画的
// 观感 —— 逐帧全速的"手绘"看起来像噪点，不像笔触。

(function () {
  'use strict';

  var HZ = 16;                  // 手绘层的目标帧率
  var WAVE_POINTS = 40;         // 声波涂鸦的采样点数

  var opts = {
    on: false,
    frame: true,                // 手绘边框
    wave: true,                 // 手绘声波
    annot: true,                // 当前歌词行的圈注
    paper: true,                // 纸张噪点
    jitter: 100,                // 抖动幅度（%）
    speed: 100                  // 抖动刷新速度（%）
  };

  var views = [];               // [{ el, svg, framePath, wavePath, annotPath, w, h }]
  var attached = false;
  var activeIdx = 0;
  var paperUri = null;
  var lastWaveAt = 0;
  var rngState = 20260919;

  // 确定性伪随机：抖动必须是"可复现的噪声"而不是 Math.random()。
  // 用 Math.random 的话每帧的偏移完全无关，线条会变成高频噪点；
  // 用一个随时间推进的种子，相邻两帧的偏移才是相关的 —— 那才是"手抖"。
  function rnd() {
    rngState = (rngState * 1664525 + 1013904223) & 0x7fffffff;
    return rngState / 0x7fffffff;
  }

  function seedAt(t) { rngState = (Math.floor(t / 90) * 2654435761) & 0x7fffffff; }
  function jit(amt) { return (rnd() - 0.5) * 2 * amt; }

  // -------------------------------------------------------------------------
  // rough 引擎
  // -------------------------------------------------------------------------

  // 一段"手绘直线"：两个控制点放在 1/3 与 2/3 处，各自偏一点。
  // 用三次贝塞尔而不是折线，是因为人手的抖动是低频的 —— 折线看起来像
  // 低分辨率的锯齿，贝塞尔才像笔锋。
  function roughSeg(x1, y1, x2, y2, amt, out, move) {
    var dx = x2 - x1, dy = y2 - y1;
    var len = Math.hypot(dx, dy) || 1;
    // 抖动幅度跟线段长度走但设上限：短线段抖一脸、长线段纹丝不动，
    // 都不像手画。上限取 2.6px 是拿几种字号目测出来的。
    var a = Math.min(amt, amt * 0.35 + len * 0.012, 2.6);
    var c1x = x1 + dx / 3 + jit(a), c1y = y1 + dy / 3 + jit(a);
    var c2x = x1 + dx * 2 / 3 + jit(a), c2y = y1 + dy * 2 / 3 + jit(a);
    if (move) out.push('M' + f(x1) + ' ' + f(y1));
    out.push('C' + f(c1x) + ' ' + f(c1y) + ' ' + f(c2x) + ' ' + f(c2y)
      + ' ' + f(x2 + jit(a * 0.6)) + ' ' + f(y2 + jit(a * 0.6)));
  }

  function f(v) { return (Math.round(v * 10) / 10).toString(); }

  /** 折线。closed=true 时闭合（描边矩形/多边形就用它）。 */
  function roughPolyline(pts, amt, closed) {
    var out = [];
    if (pts.length < 2) return '';
    for (var i = 0; i < pts.length - 1; i += 1) {
      roughSeg(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], amt, out, i === 0);
    }
    if (closed) {
      var last = pts[pts.length - 1], first = pts[0];
      roughSeg(last[0], last[1], first[0], first[1], amt, out, false);
      out.push('Z');
    }
    return out.join('');
  }

  /** 椭圆：把圆周按角度采样成折线再手绘化。 */
  function roughEllipse(cx, cy, rx, ry, amt, seg) {
    var n = seg || 26;
    var pts = [];
    for (var i = 0; i <= n; i += 1) {
      var a = i / n * Math.PI * 2;
      pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
    }
    return roughPolyline(pts, amt, false);
  }

  /** 一笔画出的矩形边框：四角各留一个"出格"的小尾巴，像没对齐的速写。 */
  function roughRect(w, h, amt, overhang) {
    var o = overhang === undefined ? 3 : overhang;
    var pts = [
      [-o, -o + jit(amt)], [w + jit(amt), -o], [w + o, h + jit(amt)],
      [jit(amt) - o, h + o], [-o, -o + jit(amt)]
    ];
    return roughPolyline(pts, amt, false);
  }

  // -------------------------------------------------------------------------
  // 纸张
  //
  // 一次生成、缓存成 dataURI。SVG 的 feTurbulence 也能做，但那个滤镜在
  // 全屏尺寸下是每帧重新求值的，代价比一张静态位图高一个数量级。
  // -------------------------------------------------------------------------

  function makePaper() {
    var size = 128;
    var c = document.createElement('canvas');
    c.width = c.height = size;
    var g = c.getContext('2d');
    var img = g.createImageData(size, size);
    seedAt(7);
    for (var i = 0; i < size * size; i += 1) {
      var n = 200 + rnd() * 55;
      // 纤维：横向拉长的斑点，比纯高斯噪声更像纸。
      if (rnd() < 0.06) n -= 45;
      var o = i * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = n;
      img.data[o + 3] = 26;
    }
    g.putImageData(img, 0, 0);
    try { return c.toDataURL('image/png'); } catch (e) { return null; }
  }

  // -------------------------------------------------------------------------
  // 视图
  // -------------------------------------------------------------------------

  var NS = 'http://www.w3.org/2000/svg';

  function mount(el) {
    if (!el) return null;
    var layer = document.createElement('div');
    layer.className = 'hd-layer';
    layer.setAttribute('aria-hidden', 'true');
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'hd-svg');
    var paths = {};
    ['frame', 'wave', 'annot'].forEach(function (k) {
      var p = document.createElementNS(NS, 'path');
      p.setAttribute('class', 'hd-' + k);
      p.setAttribute('d', '');
      paths[k] = p;
      svg.appendChild(p);
    });
    layer.appendChild(svg);
    el.appendChild(layer);
    return {
      el: el, layer: layer, svg: svg,
      framePath: paths.frame, wavePath: paths.wave, annotPath: paths.annot,
      w: 0, h: 0, lastJitter: -1, lastAnnot: '', lastAnnotJitter: -1, frameDrawn: false
    };
  }

  function measure(v) {
    if (!v || !v.el) return false;
    var r = v.el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    v.w = Math.round(r.width);
    v.h = Math.round(r.height);
    v.svg.setAttribute('viewBox', '0 0 ' + v.w + ' ' + v.h);
    v.svg.setAttribute('width', v.w);
    v.svg.setAttribute('height', v.h);
    v.lastJitter = -1;
    return true;
  }

  function tone() {
    var t = window.Stage ? (Stage.tier ? Stage.tier() : 2) : 2;
    return t < 0 ? 0 : t > 2 ? 2 : t;
  }

  // -------------------------------------------------------------------------
  // 绘制
  // -------------------------------------------------------------------------

  function jitterAmt(pulse) {
    // 基础抖动 + 鼓点带来的额外抖动。上限压在 3.4px：再大线条就开始"跳"，
    // 而不是"抖"。
    var base = 0.9 + opts.jitter / 100 * 1.5;
    return Math.min(3.4, base + pulse * 1.6 * (opts.jitter / 100));
  }

  function drawFrame(v, amt) {
    if (!opts.frame) {
      if (v.frameDrawn) { v.framePath.setAttribute('d', ''); v.frameDrawn = false; }
      return;
    }
    v.framePath.setAttribute('d', roughRect(v.w - 26, v.h - 26, amt * 0.8, 4));
    v.framePath.setAttribute('transform', 'translate(13 13)');
    v.frameDrawn = true;
  }

  // 声波涂鸦：每根柱子画成一小段抖动的竖线，而不是一条连续的折线。
  // 连续折线看起来是"心电图"，一撮竖线才像铅笔在纸上涂出来的频谱。
  function drawWave(v, amt, bands) {
    if (!opts.wave || !bands || !bands.length) { v.wavePath.setAttribute('d', ''); return; }
    var n = WAVE_POINTS;
    var pad = 34;
    var usable = Math.max(40, v.w - pad * 2);
    var step = usable / n;
    var baseY = v.h - 34;
    var maxH = Math.min(96, v.h * 0.17);
    var out = [];
    for (var i = 0; i < n; i += 1) {
      // 频谱是 64 段、这里只取 40 根：按比例抽样而不是截断，否则高频整段消失。
      var b = bands[Math.min(bands.length - 1, Math.floor((i + 0.5) / n * bands.length))] || 0;
      var hgt = 2 + b * maxH;
      var x = pad + i * step;
      roughSeg(x, baseY, x + jit(amt * 0.5), baseY - hgt, amt * 0.7, out, true);
      // 每根柱子再补一撮短斜线，密度跟着能量走 —— 这是"铅笔排线"的暗示。
      if (b > 0.35) {
        var k = 1 + Math.floor(b * 3);
        for (var j = 0; j < k; j += 1) {
          var yy = baseY - hgt * (j + 1) / (k + 1);
          roughSeg(x - step * 0.3, yy, x + step * 0.3, yy + jit(amt), amt * 0.5, out, true);
        }
      }
    }
    v.wavePath.setAttribute('d', out.join(''));
  }

  // 当前歌词行的圈注：一条手绘下划线 + 一个不闭合的圈。
  // 锚点从真实的 .lyric.active 元素量出来，所以字号、行高、抽屉开合都不用
  // 同步维护 —— 元素在哪，圈就画在哪。
  function drawAnnot(v, amt) {
    if (!opts.annot || !v.el.classList.contains('hand-target')) {
      v.annotPath.setAttribute('d', '');
      return;
    }
    var sel = '.stage-lyrics .lyric.active';
    var node = v.el.querySelector(sel);
    if (!node) { v.annotPath.setAttribute('d', ''); return; }
    var r = node.getBoundingClientRect();
    var box = v.el.getBoundingClientRect();
    var key = Math.round(r.left - box.left) + ':' + Math.round(r.top - box.top)
      + ':' + Math.round(r.width) + ':' + Math.round(r.height);
    // 锚点没动、抖动幅度也没变时直接复用上一帧的路径。圈注是"标在字下面"的
    // 东西，每帧重画只会让它在原地嗡嗡响，并不会更像手画的。
    if (key === v.lastAnnot && Math.abs(amt - v.lastAnnotJitter) < 0.25) return;
    v.lastAnnot = key;
    v.lastAnnotJitter = amt;

    var cx = r.left - box.left + r.width / 2;
    var y = r.top - box.top + r.height * 0.94;
    var half = Math.min(v.w * 0.44, Math.max(28, r.width / 2 + 10));
    var out = [];
    roughSeg(cx - half, y, cx + half, y + jit(amt), amt, out, true);
    // 第二笔，略短且略高一点：两笔才是"描了一遍"，一笔像印刷。
    roughSeg(cx - half * 0.86, y + 2.5, cx + half * 0.9, y + 2.5 + jit(amt * 1.4), amt * 1.2, out, true);
    v.annotPath.setAttribute('d', out.join(''));
  }

  // -------------------------------------------------------------------------
  // 帧门
  // -------------------------------------------------------------------------

  function targetFps() {
    if (!attached || !opts.on || !views.length) return 0;
    if (window.Stage && Stage.isHidden()) return 0;
    var playing = document.body.classList.contains('is-playing');
    if (!playing) return 0;
    return Math.max(4, Math.round(HZ * (opts.speed / 100)) * (tone() === 0 ? 0.6 : 1));
  }

  function tick(dtMs) {
    var v = pickView();
    if (!v) return;
    if (!v.w || !v.h) { if (!measure(v)) return; }

    var t = window.performance && performance.now ? performance.now() : Date.now();
    var bands = window.Stage && Stage.spectrum ? Stage.spectrum() : null;
    var pulse = 0;
    if (window.StageParticles && StageParticles.stats) {
      pulse = StageParticles.stats().pulse || 0;
    } else if (window.Stage && Stage.energy) {
      pulse = Stage.energy();
    }

    seedAt(t);
    var amt = jitterAmt(pulse);

    // 边框只在抖动幅度真的变了才重画。每帧重画不会更"手绘"，只会让边缘
    // 出现持续的高频噪点 —— 而且白烧几十次字符串拼接。
    if (!v.frameDrawn || Math.abs(amt - v.lastJitter) > 0.12) {
      drawFrame(v, amt);
      v.lastJitter = amt;
    }
    drawWave(v, amt, bands);
    drawAnnot(v, amt);
  }

  function pickView() {
    return views[0];
  }

  // -------------------------------------------------------------------------
  // 应用
  // -------------------------------------------------------------------------

  function apply(spec) {
    if (spec) {
      Object.keys(opts).forEach(function (k) {
        if (k in spec) opts[k] = typeof opts[k] === 'boolean' ? !!spec[k] : spec[k];
      });
    }
    var root = document.documentElement;
    root.classList.toggle('hand-on', !!opts.on);
    root.classList.toggle('hand-paper', !!opts.on && !!opts.paper);

    if (!opts.on) {
      views.forEach(function (v) { v.wavePath.setAttribute('d', ''); v.framePath.setAttribute('d', ''); v.annotPath.setAttribute('d', ''); });
      return opts;
    }

    if (!attached) {
      var a = mount(document.getElementById('stage'));
      views = [a].filter(Boolean);
      if (!views.length) return opts;
      attached = true;
      if (window.Stage && Stage.gate) Stage.gate('handdrawn', targetFps, tick);
      if (window.ResizeObserver) {
        var ro = new ResizeObserver(function () { views.forEach(measure); });
        views.forEach(function (v) { ro.observe(v.el); });
      }
      // 圈注只画在真正承载歌词的那个容器上：舞台侧栏的 .stage-lyrics。
      // 挂在最外层会让量出来的矩形包含整个页面高度。
      if (views[0]) views[0].el.classList.add('hand-target');
    }

    if (opts.paper && !paperUri) paperUri = makePaper();
    views.forEach(function (v) {
      v.layer.style.backgroundImage = (opts.paper && paperUri) ? 'url("' + paperUri + '")' : 'none';
      v.lastJitter = -1;
    });
    return opts;
  }

  function init() {
    // 帧门在首次 apply(true) 时才登记：用户没开手绘模式就不该占一个门。
    return api;
  }

  var api = {
    init: init,
    apply: apply,
    frame: function () { /* 手绘层有自己的帧门，不需要外部驱动 */ },
    values: function () { return JSON.parse(JSON.stringify(opts)); },
    // 供测试与工坊调用：把几何生成器直接暴露出来，避免为了预览再造一份。
    rough: {
      polyline: roughPolyline,
      rect: roughRect,
      ellipse: roughEllipse
    },
    stats: function () {
      return {
        on: !!opts.on, views: views.length, fps: targetFps(),
        jitter: Number(jitterAmt(0).toFixed(2)),
        hasPaper: !!paperUri
      };
    }
  };

  window.HandDrawn = api;
})();
