// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 舞台电影手绘：同一张透明画稿跟随当前舞台宿主。
// 分镜、网点、排线留在画面边缘；中央留白，不给应用界面加全局滤镜。
// Stage 仍是唯一的音频、歌词与时间源。15fps 帧门只在真实播放时打开。

(function () {
  'use strict';

  var HZ = 15;                  // 手绘层的目标帧率（60/120 的公因数，见 stage.js 帧门约定）
  var WAVE_POINTS = 40;         // 声波涂鸦的采样点数

  var DEFAULTS = {
    on: false,
    style: 'manga',             // manga / anime / pencil / color
    frame: true,                // 手绘边框
    wave: true,                 // 手绘声波
    annot: true,                // 当前歌词行的圈注
    paper: true,                // 纸张噪点
    jitter: 100,                // 抖动幅度（%）
    speed: 100                  // 抖动刷新速度（%）
  };
  var opts = Object.assign({}, DEFAULTS);

  var view = null;
  var stageHost = null;
  var registered = false;
  var initialized = false;
  var resizeObserver = null;
  var motionQuery = null;
  var paperUri = null;
  var rngState = 20260919;
  var PRESETS = [
    { id: 'manga', label: '漫画分镜', caption: '黑白墨线 · 网点阴影',
      description: '分级灰面、清晰墨线与斜切分镜，像一页正在演出的漫画。',
      look: { toon: 0.94, paper: 0.54, grade: 2, bloom: 0.02, bloomThresh: 0.74,
        chroma: 0, grain: 0.025, saturation: 0, exposure: 1.28, vignette: 0.22 },
      hand: { on: true, style: 'manga', frame: true, wave: true, annot: true, paper: true, jitter: 65, speed: 100 } },
    { id: 'anime', label: '动画赛璐璐', caption: '清透色块 · 动画光影',
      description: '有层次的色块、利落轮廓与宽幅取景，把舞台画成动画镜头。',
      look: { toon: 0.86, paper: 0.08, grade: 0, bloom: 0.08, bloomThresh: 0.74,
        chroma: 0, grain: 0.015, saturation: 1.14, exposure: 1.35, vignette: 0.18 },
      hand: { on: true, style: 'anime', frame: true, wave: true, annot: false, paper: false, jitter: 16, speed: 75 } },
    { id: 'pencil', label: '铅笔分镜', caption: '暖灰线稿 · 纸面笔触',
      description: '轻柔灰面、纸张纤维与细密排线，保留铅笔起稿的呼吸感。',
      look: { toon: 0.58, paper: 0.72, grade: 2, bloom: 0.02, bloomThresh: 0.74,
        chroma: 0, grain: 0.04, saturation: 0.18, exposure: 1.20, vignette: 0.18 },
      hand: { on: true, style: 'pencil', frame: true, wave: true, annot: true, paper: true, jitter: 95, speed: 75 } },
    { id: 'color', label: '双色漫画', caption: '双色套印 · 彩色分镜',
      description: '主题双色铺进明暗面，搭配套印线条与局部网点。',
      look: { toon: 0.82, paper: 0.30, grade: 1, bloom: 0.06, bloomThresh: 0.74,
        chroma: 0, grain: 0.02, saturation: 1.05, exposure: 1.30, vignette: 0.20 },
      hand: { on: true, style: 'color', frame: true, wave: true, annot: true, paper: true, jitter: 45, speed: 75 } }
  ];

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
    var size = 128, canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;
    var img = ctx.createImageData(size, size);
    seedAt(913);
    for (var i = 0; i < size * size; i += 1) {
      var offset = i * 4, grain = rnd();
      img.data[offset] = 231; img.data[offset + 1] = 224; img.data[offset + 2] = 208;
      img.data[offset + 3] = grain > 0.80 ? Math.round(10 + grain * 24) : 0;
    }
    ctx.putImageData(img, 0, 0);
    try { return canvas.toDataURL('image/png'); } catch (e) { return null; }
  }

  var NS = 'http://www.w3.org/2000/svg';
  function svgNode(tag, attrs) {
    var node = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    return node;
  }

  function mount(el) {
    var layer = document.createElement('div');
    layer.className = 'hd-layer'; layer.setAttribute('aria-hidden', 'true');
    var svg = svgNode('svg', { 'class': 'hd-svg', focusable: 'false' });
    var defs = svgNode('defs');
    var pattern = svgNode('pattern', { id: 'hd-stage-dots', width: 9, height: 9, patternUnits: 'userSpaceOnUse' });
    pattern.appendChild(svgNode('circle', { cx: 2, cy: 2, r: 0.75, 'class': 'hd-dot' }));
    defs.appendChild(pattern); svg.appendChild(defs);
    var paths = {};
    ['bars', 'panels', 'tone', 'hatch', 'frame', 'accent', 'focus', 'wave', 'annot'].forEach(function (key) {
      paths[key] = svgNode('path', { 'class': 'hd-' + key, d: '' });
      svg.appendChild(paths[key]);
    });
    layer.appendChild(svg); el.appendChild(layer);
    return { el: el, layer: layer, svg: svg, paths: paths, w: 0, h: 0, frameKey: '', lastPosition: -1 };
  }

  function measure() {
    if (!view || !view.el) return false;
    var rect = view.el.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    var w = Math.round(rect.width), h = Math.round(rect.height);
    if (w !== view.w || h !== view.h) {
      view.w = w; view.h = h; view.frameKey = '';
      view.svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    }
    return true;
  }

  function isImmersive() {
    return !!(view && view.el.closest && view.el.closest('#stage3d'));
  }
  function presentation() {
    return window.Stage && Stage.presentation ? Stage.presentation() : {
      playing: document.body.classList.contains('is-playing'),
      reduced: !!(motionQuery && motionQuery.matches)
    };
  }
  function visible() {
    if (!opts.on || !view || document.hidden || view.el.isConnected === false) return false;
    // Stage.isHidden includes the open immersive stage; that sidebar-only stop
    // signal must not hide the art layer attached to the immersive host.
    if (isImmersive()) return view.el.closest('#stage3d').getAttribute('aria-hidden') !== 'true';
    return !(window.Stage && Stage.isHidden && Stage.isHidden()) &&
      !(window.Stage && Stage.isStageVisible && !Stage.isStageVisible());
  }
  function jitterAmt(pulse) {
    return Math.min(2.6, opts.jitter / 100 * (0.75 + pulse * 1.4));
  }
  function polygon(points) {
    return 'M' + points.map(function (p) { return f(p[0]) + ' ' + f(p[1]); }).join('L') + 'Z';
  }

  function drawFrame(v, amt, position) {
    // Frame changes follow a slow, quantized music clock. The spectrum has its
    // own 15fps cadence; neither uses wall-clock noise while playback is paused.
    var stamp = opts.jitter ? Math.floor(position * opts.speed / 100 / 360) : 0;
    var key = [v.w, v.h, opts.frame, opts.paper, opts.style, opts.jitter, stamp].join(':');
    if (key === v.frameKey) return;
    v.frameKey = key; seedAt(stamp * 90 + 900);
    var w = v.w, h = v.h, pad = Math.min(30, Math.max(14, w * 0.026));
    var edge = Math.min(150, w * 0.14), top = Math.min(100, h * 0.14);
    var frame = [], accents = [], hatch = [], focus = [], bars = '';
    var anime = opts.style === 'anime';
    var comic = opts.style === 'manga' || opts.style === 'color';
    if (opts.frame && anime) {
      var barH = Math.min(40, Math.max(12, h * 0.04));
      bars = polygon([[0, 0], [w, 0], [w, barH], [0, barH]]) +
        polygon([[0, h - barH], [w, h - barH], [w, h], [0, h]]);
      var corner = Math.min(42, w * 0.065), inset = pad + 7, yTop = barH + 12, yBottom = h - barH - 12;
      [[inset, yTop, 1, 1], [w - inset, yTop, -1, 1],
        [inset, yBottom, 1, -1], [w - inset, yBottom, -1, -1]].forEach(function (c) {
        roughSeg(c[0], c[1] + c[3] * corner * 0.5, c[0], c[1], amt * 0.12, frame, true);
        roughSeg(c[0], c[1], c[0] + c[2] * corner, c[1], amt * 0.12, frame, true);
      });
      roughSeg(w * 0.12, barH + 1, w * 0.35, barH + 1, 0, accents, true);
      roughSeg(w * 0.66, h - barH - 1, w * 0.87, h - barH - 1, 0, accents, true);
      [[w * 0.13, h * 0.29, 5], [w * 0.87, h * 0.40, 8]].forEach(function (s) {
        roughSeg(s[0] - s[2], s[1], s[0] + s[2], s[1], 0, focus, true);
        roughSeg(s[0], s[1] - s[2] * 1.6, s[0], s[1] + s[2] * 1.6, 0, focus, true);
      });
    } else if (opts.frame) {
      // Cropped asymmetric panels leave the central lyric field unboxed.
      roughSeg(pad, top + h * 0.15, pad, pad, amt, frame, true);
      roughSeg(pad, pad, w * 0.36, pad + 1, amt, frame, true);
      roughSeg(w * 0.64, pad, w - pad, pad, amt, frame, true);
      roughSeg(w - pad, pad, w - pad, h * 0.21, amt, frame, true);
      roughSeg(w - pad, h * 0.66, w - pad, h - pad, amt, frame, true);
      roughSeg(w - pad, h - pad, w * 0.66, h - pad, amt, frame, true);
      roughSeg(w * 0.28, h - pad, pad, h - pad, amt, frame, true);
      roughSeg(pad, h - pad, pad, h * 0.77, amt, frame, true);
      roughSeg(pad + 5, top, pad + 5, pad + 5, amt * 0.7, accents, true);
      roughSeg(pad + 5, pad + 5, w * 0.19, pad + 5, amt * 0.7, accents, true);
      roughSeg(w - edge, h - pad - 5, w - pad - 5, h - pad - 5, amt, accents, true);
      roughSeg(w - pad - 5, h - pad - 5, w - pad - 5, h * 0.84, amt, accents, true);
      // Sparse speed lines stay outside the middle 68% of the lyric field.
      for (var i = 0; i < 10; i += 1) {
        var yy = h * (0.61 + i * 0.018), length = edge * (0.26 + (i % 4) * 0.11);
        roughSeg(pad, yy, pad + length, yy - length * 0.36, amt * 0.5, hatch, true);
        roughSeg(w - pad, h - yy, w - pad - length, h - yy + length * 0.36, amt * 0.5, hatch, true);
      }
      if (comic) {
        // Diagonal gutters and rays stay outside the central lyric column.
        roughSeg(0, h * 0.67, w * 0.25, h, amt * 0.45, frame, true);
        roughSeg(w * 0.77, 0, w, h * 0.30, amt * 0.45, frame, true);
        roughSeg(0, h * 0.70, w * 0.22, h, amt * 0.3, accents, true);
        roughSeg(w * 0.80, 0, w, h * 0.26, amt * 0.3, accents, true);
        for (var ray = 0; ray < 7; ray += 1) {
          var ry = h * (0.27 + ray * 0.045), reach = edge * (0.26 + (ray % 3) * 0.14);
          var innerY = ry + (h * 0.46 - ry) * 0.18;
          roughSeg(pad, ry, pad + reach, innerY, amt * 0.2, hatch, true);
          roughSeg(w - pad, ry, w - pad - reach, innerY, amt * 0.2, hatch, true);
        }
        var mark = Math.min(34, w * 0.045);
        roughSeg(w - pad - mark, h * 0.59, w - pad, h * 0.59, 0, focus, true);
        roughSeg(w - pad - mark * 0.45, h * 0.59 - 5, w - pad - mark * 0.45, h * 0.59 + 5, 0, focus, true);
      }
    }
    v.paths.bars.setAttribute('d', bars);
    v.paths.frame.setAttribute('d', frame.join(''));
    v.paths.accent.setAttribute('d', accents.join(''));
    v.paths.hatch.setAttribute('d', hatch.join(''));
    v.paths.focus.setAttribute('d', focus.join(''));
    var panels = opts.paper && !anime ? polygon([[0, h * 0.68], [w * 0.16, h * 0.85], [w * 0.25, h], [0, h]]) +
      polygon([[w * 0.77, 0], [w, 0], [w, h * 0.30], [w * 0.89, h * 0.19]]) : '';
    v.paths.panels.setAttribute('d', panels); v.paths.tone.setAttribute('d', panels);
  }

  function drawWave(v, amt, bands) {
    if (!opts.wave) { v.paths.wave.setAttribute('d', ''); return; }
    var n = Math.min(WAVE_POINTS, Math.max(18, Math.round(v.w / 25)));
    var baseY = isImmersive() && v.h > 560 ? v.h - 172 : v.h - 30;
    var maxH = Math.min(52, v.h * 0.065), out = [], points = [], start = v.w * 0.10, width = v.w * 0.80;
    for (var i = 0; i < n; i += 1) {
      // Read all bands from the real spectrum. Silence leaves a fine ink
      // baseline; there is no demo oscillator or fabricated audio envelope.
      var value = bands && bands.length ? Number(bands[Math.min(bands.length - 1, Math.floor((i + 0.5) / n * bands.length))]) : 0;
      var b = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
      var x = start + i / Math.max(1, n - 1) * width, height = 1.5 + b * maxH;
      if (opts.style === 'anime') { points.push([x, baseY - height * 0.5]); continue; }
      roughSeg(x, baseY, x + jit(amt * 0.18), baseY - height, amt * 0.28, out, true);
      if (b > 0.3) roughSeg(x - 2, baseY - height * 0.45, x + 2, baseY - height * 0.45 - 2, amt * 0.2, out, true);
    }
    v.paths.wave.setAttribute('d', opts.style === 'anime' ? roughPolyline(points, amt * 0.12, false) : out.join(''));
  }

  function drawAnnot(v, amt) {
    if (!opts.annot) { v.paths.annot.setAttribute('d', ''); return; }
    var root = isImmersive() ? v.el.closest('#stage3d') : v.el;
    var node = root.querySelector('.sl-line.is-active, .stage-lyrics .lyric.active');
    if (!node) { v.paths.annot.setAttribute('d', ''); return; }
    var rect = node.getBoundingClientRect(), box = v.el.getBoundingClientRect();
    if (!rect.width || !rect.height || node.closest('[hidden]')) { v.paths.annot.setAttribute('d', ''); return; }
    // Measure the text range, not the full-width lyric button.
    if (document.createRange && node.firstChild) {
      var range = document.createRange(); range.selectNodeContents(node);
      var ink = range.getBoundingClientRect();
      if (ink.width && ink.height) rect = ink;
    }
    var left = Math.max(26, rect.left - box.left), right = Math.min(v.w - 26, rect.right - box.left);
    var y = rect.bottom - box.top + 7;
    if (right <= left || y < 20 || y > v.h - 26) { v.paths.annot.setAttribute('d', ''); return; }
    var length = Math.min(180, (right - left) * 0.45), cx = (left + right) * 0.5, out = [];
    seedAt(1800);
    roughSeg(cx - length * 0.5, y, cx + length * 0.5, y - 1, amt * 0.7, out, true);
    roughSeg(cx - length * 0.25, y + 3, cx + length * 0.42, y + 2, amt * 0.4, out, true);
    v.paths.annot.setAttribute('d', out.join(''));
  }

  function targetFps() {
    if (!visible()) return 0;
    var state = presentation();
    if (!state.playing || state.reduced || (motionQuery && motionQuery.matches)) return 0;
    var ceiling = window.Stage && Stage.tier && Stage.tier() === 0 ? 10 : HZ;
    // Snap to common 60/120Hz integer divisors instead of arbitrary FPS values.
    var target = Math.min(ceiling, HZ * opts.speed / 100);
    return target >= 15 ? 15 : target >= 12 ? 12 : target >= 10 ? 10 : target >= 6 ? 6 : 4;
  }
  function tick() {
    if (!visible() || !measure()) return;
    var state = presentation();
    var position = window.Stage && Stage.position ? Number(Stage.position()) : 0;
    if (!Number.isFinite(position)) position = 0;
    var animate = state.playing && !state.reduced && !(motionQuery && motionQuery.matches);
    var pulse = animate && window.Stage && Stage.energy ? Number(Stage.energy()) || 0 : 0;
    var amt = jitterAmt(Math.max(0, Math.min(1, pulse)));
    drawFrame(view, amt, animate ? position : view.lastPosition >= 0 ? view.lastPosition : position);
    seedAt(Math.floor(position / (1000 / HZ)) * 90 + 90);
    drawWave(view, amt, window.Stage && Stage.spectrum ? Stage.spectrum() : null);
    drawAnnot(view, amt); view.lastPosition = position;
  }

  function setHostClasses(el, on) {
    if (!el) return;
    el.classList.toggle('hand-target', !!on); el.classList.toggle('hand-on', !!on);
    el.classList.toggle('hand-paper', !!on && !!opts.paper);
    if (on) el.setAttribute('data-hand-style', opts.style); else el.removeAttribute('data-hand-style');
  }
  function attachHost() {
    var next = stageHost || document.getElementById('stage');
    if (!next || (!view && !opts.on)) return;
    if (!view) view = mount(next);
    else if (view.el !== next) {
      setHostClasses(view.el, false);
      if (resizeObserver) resizeObserver.disconnect();
      view.el = next; next.appendChild(view.layer);
      view.w = view.h = 0; view.frameKey = ''; view.lastPosition = -1;
    }
    setHostClasses(view.el, opts.on);
    if (resizeObserver) resizeObserver.observe(view.el);
    if (!registered && window.Stage && Stage.gate) {
      registered = true; Stage.gate('handdrawn', targetFps, tick);
    }
  }
  function init() {
    if (initialized) return api;
    initialized = true;
    motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    if (window.ResizeObserver) resizeObserver = new ResizeObserver(function () {
      if (view) view.frameKey = '';
      tick();
    });
    if (motionQuery && motionQuery.addEventListener) motionQuery.addEventListener('change', tick);
    document.addEventListener('visibilitychange', tick);
    document.addEventListener('stage:playing-changed', tick);
    document.addEventListener('stage:retint', tick);
    window.addEventListener('resize', tick);
    return api;
  }
  function apply(spec) {
    init();
    if (spec) {
      ['on', 'frame', 'wave', 'annot', 'paper'].forEach(function (key) { if (key in spec) opts[key] = !!spec[key]; });
      ['jitter', 'speed'].forEach(function (key) {
        if (!(key in spec) || !Number.isFinite(Number(spec[key]))) return;
        opts[key] = Math.max(key === 'speed' ? 25 : 0, Math.min(200, Number(spec[key])));
      });
      if (PRESETS.some(function (preset) { return preset.id === spec.style; })) opts.style = spec.style;
    }
    // Retire the application-wide hand skin; only the current art host owns it.
    document.documentElement.classList.remove('hand-on', 'hand-paper');
    attachHost();
    if (!view) return api.values();
    if (opts.on && opts.paper && !paperUri) paperUri = makePaper();
    view.layer.style.setProperty('--hd-paper-image', opts.paper && paperUri ? 'url("' + paperUri + '")' : 'none');
    view.layer.hidden = !opts.on; view.frameKey = '';
    if (opts.on) tick(); // Paused first paint, settings and host swaps are immediate.
    return api.values();
  }
  function setStageHost(host) {
    stageHost = host && host.nodeType === 1 ? host : null;
    init(); attachHost();
    if (view) view.frameKey = '';
    tick();
  }
  var api = {
    init: init, apply: apply, setStageHost: setStageHost,
    frame: function () {}, // CreativeStage never creates a second drawing driver.
    refresh: tick,
    // Called after the host updates lyric DOM. The stopped art gate must not
    // leave an underline attached to a previous or newly hidden lyric.
    refreshAnnotation: function () {
      if (targetFps() === 0 && visible() && measure()) drawAnnot(view, jitterAmt(0));
    },
    values: function () { return Object.assign({}, opts); },
    defaults: function () { return Object.assign({}, DEFAULTS); },
    presets: function () { return JSON.parse(JSON.stringify(PRESETS)); },
    rough: { polyline: roughPolyline, rect: roughRect, ellipse: roughEllipse },
    stats: function () {
      return { on: !!opts.on, style: opts.style, views: view ? 1 : 0, fps: targetFps(),
        host: view ? view.el.id || 'stage-art' : null,
        jitter: Number(jitterAmt(0).toFixed(2)), hasPaper: !!paperUri };
    }
  };
  window.HandDrawn = api;
})();
