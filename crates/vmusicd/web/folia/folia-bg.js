// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
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
    var BAND_KEYS = ['bass', 'lowMid', 'mid', 'treble'];
    var coverSeq = 0; // 封面请求单调序号：过期 resolve 直接丢弃
    var destroyed = false;

    function rnd(seed, off) { return U.srand(seed + off); }
    // 按当前 paused 同步全部形状/粒子的动画播放态（新建节点与 setPaused 复用）
    function applyPlayState() {
      var pl = paused ? 'paused' : 'running';
      shapes.forEach(function (s) { s.inner.style.animationPlayState = pl; });
      particles.forEach(function (x) { x.el.style.animationPlayState = pl; });
    }
    function buildShapes() {
      shapes.forEach(function (s) { s.el.remove(); });
      particles.forEach(function (p) { p.el.remove(); });
      shapes = []; particles = [];
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
        inner.style.setProperty('--fl-rot0', Math.floor(rnd(s, 18) * 360) + 'deg');
        el.append(inner); shapeLayer.append(el);
        shapes.push({ el: el, inner: inner, band: ['bass','lowMid','mid','treble'][types.indexOf(type)], base: 1 });
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
      applyPlayState(); // 暂停期间重建形状场也要保持暂停
    }

    function paintTheme() {
      layer.style.background = theme.backgroundColor;
      tint.style.background = theme.backgroundColor;
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
        img.crossOrigin = 'anonymous';
        img.decoding = 'async';
        img.onload = function () {
          try {
            var nw = img.naturalWidth || img.width, nh = img.naturalHeight || img.height;
            var sc = Math.min(1, 384 / Math.max(nw, nh));
            var c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(nw * sc)); c.height = Math.max(1, Math.round(nh * sc));
            var ctx = c.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, c.width, c.height);
            resolve(c.toDataURL('image/jpeg', 0.82));
          } catch (e) { resolve(url); }
        };
        img.onerror = function () { resolve(url); };
        img.src = url;
      });
    }
    var fluidImgs = []; // 顺序即 DOM 层级：首项最旧（最底层），末项最新（紧贴 tint 之下、最上层）
    function setCover(url) {
      coverUrl = url;
      if (mode !== 'fluid' || !url) {
        fluidImgs.forEach(function (x) { x.el.remove(); }); fluidImgs = [];
        return;
      }
      // fluid 重入（applyMode 以同 URL 再调）：顶层已是该图则 no-op，不重复加层
      if (fluidImgs.length && fluidImgs[fluidImgs.length - 1].url === url) return;
      var mySeq = ++coverSeq;
      downscale(url).then(function (src) {
        if (destroyed || mySeq !== coverSeq) return; // 过期请求直接放弃，不加图层
        if (mode !== 'fluid' || coverUrl !== url) return;
        var el = document.createElement('img');
        el.className = 'fl-fluid-img'; el.src = src; el.alt = '';
        el.style.opacity = '0';
        // 插到 tint 之前：旧图之后、最上层，形成新图在上淡入、旧图在下淡出
        fluidWrap.insertBefore(el, tint);
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(function () {
            if (destroyed) return;
            requestAnimationFrame(function () {
              if (destroyed) return;
              el.style.opacity = '1'; // 双 rAF 确保 opacity:0 先落盘再过渡
            });
          });
        } else {
          el.style.opacity = '1';
        }
        fluidImgs.push({ el: el, url: url });
        if (fluidImgs.length > 2) { // 淘汰数组首项（DOM 最底层的最旧图）
          var old = fluidImgs.shift();
          old.el.style.opacity = '0';
          setTimeout(function () {
            if (destroyed) return;
            old.el.remove();
          }, 800);
        }
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
      var e = global.Stage && global.Stage.energy ? global.Stage.energy() : 0;
      var bins = global.Stage && global.Stage.spectrum ? global.Stage.spectrum() : null;
      if (bins && bins.length) {
        var pick = { bass: 0.06, lowMid: 0.22, mid: 0.5, treble: 0.82 }[name];
        var i = Math.min(bins.length - 1, Math.floor(pick * bins.length));
        e = Math.max(e, Number(bins[i]) || 0); // bins 约定为 0–1
      }
      return U.clamp(e * BAND_MUL[name], 0, 1);
    }
    function frame(dtMs) {
      if (mode === 'geometric' && !paused && global.Stage) {
        BAND_KEYS.forEach(function (k) {
          var target = U.lerp(0.95, 1.45, bandLevel(k));
          scaleSmooth[k] = U.damp(scaleSmooth[k], target, 90, dtMs);
        });
        shapes.forEach(function (s) {
          s.el.style.transform = 'scale(' + scaleSmooth[s.band].toFixed(3) + ')';
        });
      } else if (mode === 'fluid' && !paused && global.Stage) {
        var e = global.Stage.energy ? global.Stage.energy() : 0;
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
      // applyFoliaConfig 每 8fps 推一次：值没变就别碰 DOM 写。
      setOpacity: function (v) {
        v = U.clamp(v, 0, 1);
        if (Math.abs(v - opacity) < 1e-9) return;
        opacity = v;
        tint.style.opacity = String(1 - opacity);
      },
      setVignette: function (b) { vignetteOn = b; vignette.hidden = !b; },
      setCover: setCover,
      setPaused: function (b) { if (paused === b) return; paused = b; applyPlayState(); },
      setEco: function (b) { if (eco !== b) { eco = b; buildShapes(); paintTheme(); } },
      frame: frame,
      destroy: function () {
        destroyed = true;
        layer.remove(); shapeLayer.remove(); fluidWrap.remove(); vignette.remove();
      }
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
