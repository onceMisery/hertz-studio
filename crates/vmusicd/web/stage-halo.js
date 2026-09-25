// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 星幕（halo）：全屏歌词页的第三种歌词排版 —— 半调圆点光环 + 像素化封面 +
// 景深歌词。视觉对标 Mineradio 的舞台歌词：文字按与当前行的距离在 3D 空间里
// 退远（缩小 / 变暗 / 虚化，公式全部复用 .lp-line 的 --row-d 体系，本模块只
// 在星幕作用域里改令牌），背后是一张由同心点阵组成的"光碟"，碟心把当前曲目
// 封面像素化成小方块。
//
// 性能约定（与项目其它表现层一致）：
//   · 画布只在 换曲 / 换主题 / 尺寸变化 时重画，旋转与节拍呼吸全走 CSS
//     （spin 关键帧 + --stage-energy），不占逐帧 JS；
//   · 唯一的帧门只做指针视差的阻尼平滑与封面 URL 轮询，星幕页未打开时
//     目标帧率报 0，不烧 GPU/CPU；
//   · 零依赖、ES5、无构建。

(function () {
  'use strict';

  var GATE_NAME = 'halo';
  var POLL_MS = 450;          // 封面 URL 轮询间隔
  var ACCENT_POLL_MS = 2000;  // 主题色轮询（主题切换不发事件）
  var TILT_DEG = 3.2;         // 指针视差最大倾角

  var page = null, scene = null, layer = null, canvas = null, ctx = null;
  var cssSize = 0, dpr = 1;
  var coverUrl = null, imgEl = null;
  var triedOk = '', triedFail = '';
  var accentSig = '';
  var tmpCanvas = null, tmpCtx = null;
  var pollAcc = 0, accentAcc = 0, resizeTimer = 0;
  var px = 0, py = 0, sx = 0, sy = 0;
  var ro = null, gateReady = false;

  function $(id) { return document.getElementById(id); }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // 与 stage.css 的令牌保持一致：优先吃主色，回退到强调色 / 暖白。
  function accentRGB() {
    var cs = window.getComputedStyle ? getComputedStyle(document.documentElement) : null;
    var raw = cs ? (cs.getPropertyValue('--music-highlight-rgb') ||
      cs.getPropertyValue('--lyric-highlight-rgb') ||
      cs.getPropertyValue('--accent-rgb')) : '';
    var m = String(raw || '').match(/(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
    return m ? [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
      : [232, 206, 206];
  }

  // 稳定的 0..1 伪随机（圆点闪烁/排布用，重画要稳定不能用 Math.random）。
  function hash(n) {
    var v = Math.sin(n * 12.9898) * 43758.5453;
    return v - Math.floor(v);
  }

  function smoothstep(a, b, x) {
    var t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function isOpen() {
    return !!page && page.classList.contains('open');
  }

  function isHalo() {
    return isOpen() && page.getAttribute('data-lp-mode') === 'halo';
  }

  function lowFx() {
    return !!(window.Stage && Stage.isLowFx && Stage.isLowFx());
  }

  // -------------------------------------------------------------------------
  // 画布：半调点环 + 中心像素封面
  // -------------------------------------------------------------------------

  function tempBuffer(cells) {
    if (!tmpCanvas) {
      tmpCanvas = document.createElement('canvas');
      tmpCtx = tmpCanvas.getContext('2d');
    }
    if (tmpCanvas.width !== cells) {
      tmpCanvas.width = cells;
      tmpCanvas.height = cells;
    }
    return tmpCtx;
  }

  // 居中裁切绘制（cover-fit），保证任意比例封面都不变形。
  function drawCoverFit(g, w, h) {
    var iw = imgEl.width || w;
    var ih = imgEl.height || h;
    var s = Math.max(w / iw, h / ih);
    var dw = iw * s;
    var dh = ih * s;
    g.drawImage(imgEl, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  function drawMosaic(c, half, acc) {
    var side = half * 2;
    var x = c - half;
    var y = c - half;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, side, side);
    ctx.clip();

    if (imgEl) {
      // 34×34 的小缓冲 + 关闭平滑放大 = 粗像素块。先画小缓冲再放大，
      // 比直接在大画布上缩图更可控（不同浏览器对 smoothingQuality 不一）。
      var cells = 34;
      var g = tempBuffer(cells);
      g.imageSmoothingEnabled = true;
      g.clearRect(0, 0, cells, cells);
      drawCoverFit(g, cells, cells);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmpCanvas, 0, 0, cells, cells, x, y, side, side);
      ctx.imageSmoothingEnabled = true;
      // 主色罩染 + 轻微压暗：让封面融进整张光碟的色调，而不是一块突兀彩图。
      ctx.fillStyle = 'rgba(' + acc[0] + ',' + acc[1] + ',' + acc[2] + ',0.20)';
      ctx.fillRect(x, y, side, side);
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      ctx.fillRect(x, y, side, side);
    } else {
      // 无封面：主色柔光核，呼吸量交给 CSS 的 --stage-energy 缩放。
      var grad = ctx.createRadialGradient(c, c, 0, c, c, half);
      grad.addColorStop(0, 'rgba(' + acc[0] + ',' + acc[1] + ',' + acc[2] + ',0.55)');
      grad.addColorStop(0.65, 'rgba(' + acc[0] + ',' + acc[1] + ',' + acc[2] + ',0.18)');
      grad.addColorStop(1, 'rgba(' + acc[0] + ',' + acc[1] + ',' + acc[2] + ',0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, side, side);
    }
    ctx.restore();

    // 方块描一圈极淡的亮边，把"碟心"和点阵分开。
    ctx.strokeStyle = 'rgba(' + acc[0] + ',' + acc[1] + ',' + acc[2] + ',0.16)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, side, side);
  }

  function paint() {
    if (!ctx || cssSize <= 0) return;
    var S = cssSize;
    canvas.width = Math.round(S * dpr);
    canvas.height = Math.round(S * dpr);
    canvas.style.width = S + 'px';
    canvas.style.height = S + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, S, S);

    var c = S / 2;
    var acc = accentRGB();
    accentSig = acc.join(',');

    // 点阵几何：内圈要让出方形碟心的对角线（half*sqrt2 ≈ 0.181S），
    // 外圈留 4% 边做渐隐。点间距随尺寸缩放，整碟约 4~5 千个点。
    var R = S * 0.46;
    var r0 = S * 0.195;
    var pitch = S * 0.0126;
    var ringStep = pitch * 0.94;
    var dotR = pitch * 0.155;

    // 暖白点向主色靠 30%，保证任何主题下点阵都和歌词高亮同色系。
    var col = [
      Math.round(226 * 0.70 + acc[0] * 0.30),
      Math.round(220 * 0.70 + acc[1] * 0.30),
      Math.round(218 * 0.70 + acc[2] * 0.30)
    ];

    var ringIdx = 0;
    for (var r = r0; r <= R; r += ringStep) {
      var n = Math.max(8, Math.round(2 * Math.PI * r / pitch));
      // 内两圈淡入、外 18% 淡出，环与环之间再叠一点亮度波纹。
      var edge = 1 - smoothstep(R * 0.82, R, r);
      var innerFade = smoothstep(r0, r0 + ringStep * 2, r);
      var wave = 0.92 + 0.08 * Math.sin(r * 0.11);
      var ringA = 0.55 * edge * innerFade * wave;
      // 黄金角散布相位：避免点阵排成从圆心向外的径向直线。
      var phase = ringIdx * 2.3999632 + r * 0.02;
      for (var i = 0; i < n; i += 1) {
        var a = (i / n) * Math.PI * 2 + phase;
        var flick = 0.62 + 0.38 * hash(ringIdx * 91.7 + i * 3.3);
        var dot = dotR * (0.82 + 0.36 * hash(i * 7.1 + ringIdx * 1.3));
        var al = ringA * flick;
        if (al <= 0.01) continue;
        ctx.fillStyle = 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + al.toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(c + Math.cos(a) * r, c + Math.sin(a) * r, dot, 0, Math.PI * 2);
        ctx.fill();
      }
      ringIdx += 1;
    }

    drawMosaic(c, S * 0.128, acc);
  }

  function schedulePaint(ms) {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(paint, ms || 0);
  }

  // -------------------------------------------------------------------------
  // 封面加载（与 stage-cover-particles 同一数据来源）
  // -------------------------------------------------------------------------

  function loadCover(url) {
    if (!url) {
      imgEl = null;
      paint();
      return;
    }
    if (url === triedOk || url === triedFail) return;
    var im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = function () {
      if (url !== coverUrl) return;  // 加载期间切歌了
      triedOk = url;
      imgEl = im;
      paint();
    };
    im.onerror = function () {
      if (url !== coverUrl) return;
      triedFail = url;
      imgEl = null;
      paint();
    };
    im.src = url;
  }

  // -------------------------------------------------------------------------
  // 尺寸 / 事件 / 帧门
  // -------------------------------------------------------------------------

  function resize() {
    // 不能量 .lp-body：三维舞台开启时它的 clientHeight 恒为 0（粒子画布在
    // 文档流占位的既有行为）。碟要铺满演出区，直接以视口短边为基准（vmin）。
    var vmin = Math.min(window.innerWidth, window.innerHeight);
    var next = Math.max(320, Math.round(vmin * 0.96));
    var nextDpr = Math.min(window.devicePixelRatio || 1, 2);
    if (next === cssSize && nextDpr === dpr) return;
    cssSize = next;
    dpr = nextDpr;
    schedulePaint(120);
  }

  function targetFps() {
    if (!isHalo() || document.hidden || lowFx()) return 0;
    return 30;
  }

  function tick(dt) {
    pollAcc += dt;
    if (pollAcc >= POLL_MS) {
      pollAcc = 0;
      var url = window.Stage && Stage.coverUrl ? Stage.coverUrl() : null;
      if (url !== coverUrl) {
        coverUrl = url;
        triedOk = '';
        triedFail = '';
        loadCover(url);
      }
    }
    accentAcc += dt;
    if (accentAcc >= ACCENT_POLL_MS) {
      accentAcc = 0;
      var sig = accentRGB().join(',');
      if (sig !== accentSig) paint();
    }
    // 指针视差：指数阻尼，掉帧也稳。
    var k = 1 - Math.exp(-dt / 110);
    sx += (px - sx) * k;
    sy += (py - sy) * k;
    if (layer) {
      layer.style.setProperty('--halo-rx', (-sy * TILT_DEG).toFixed(2) + 'deg');
      layer.style.setProperty('--halo-ry', (sx * TILT_DEG).toFixed(2) + 'deg');
    }
  }

  function onPointer(e) {
    if (!isHalo()) return;
    px = clamp((e.clientX / Math.max(1, window.innerWidth)) * 2 - 1, -1, 1);
    py = clamp((e.clientY / Math.max(1, window.innerHeight)) * 2 - 1, -1, 1);
  }

  function build() {
    page = $('lyric-page');
    if (!page) return false;
    scene = page.querySelector('.lp-scene');
    if (!scene) return false;  // stage.js 的 createView 尚未跑到，稍后重试
    if (page.querySelector('.lp-halo')) return true;

    layer = document.createElement('div');
    layer.className = 'lp-halo';
    layer.setAttribute('aria-hidden', 'true');
    var spinEl = document.createElement('div');
    spinEl.className = 'lp-halo-spin';
    canvas = document.createElement('canvas');
    canvas.className = 'lp-halo-disc';
    spinEl.appendChild(canvas);
    layer.appendChild(spinEl);
    // 必须是 .lp-scene 第一个孩子：与歌词同一个 preserve-3d 空间，
    // 但用负 translateZ 退到所有歌词行之后（见 stage.css .lp-halo）。
    scene.insertBefore(layer, scene.firstChild);
    ctx = canvas.getContext('2d');

    document.addEventListener('pointermove', onPointer, { passive: true });
    document.addEventListener('stage:retint', function () { schedulePaint(120); });
    window.addEventListener('resize', function () { schedulePaint(120); });
    if (window.ResizeObserver) {
      ro = new ResizeObserver(function () { resize(); });
      var body = page.querySelector('.lp-body');
      if (body) ro.observe(body);
    } else {
      window.addEventListener('resize', resize);
    }

    resize();
    return true;
  }

  function tryStart() {
    if (gateReady || !window.Stage || !Stage.gate) return;
    if (!build()) { setTimeout(tryStart, 120); return; }
    Stage.gate(GATE_NAME, targetFps, tick);
    gateReady = true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryStart);
  } else {
    tryStart();
  }

  window.StageHalo = {
    active: isHalo,
    repaint: function () { schedulePaint(0); }
  };
}());
