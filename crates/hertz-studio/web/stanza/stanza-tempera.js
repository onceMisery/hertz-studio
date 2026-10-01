// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
// 凝彩 tempera：全屏 Pixi 色块分镜歌词 MV。每句歌词重新切一次画面 —— 平涂色块
// 按构图入场、局部叠网点/斜线网屏、唱到哪里一条强调色「扫光带」推到哪里，
// 带内文字反色成底色（印刷套色的反白效果）。
// 行为语言参考上游音乐舞台的凝彩模式（出处见 NOTICE「Design lineage」），
// 代码为本项目独立实现。排版 / 镜头 / 起音 / 光学后期全部复用商籁引擎
// StanzaSonnetFx，Pixi 惰性加载与 Stage → 帧适配复用 StanzaSonnet 的出口，
// 本文件只负责「色块 + 网屏 + 扫光反色 + 印刷装饰」这一层。
// 对外 API 与 classic/cadenza/sonnet 渲染器一致（frame/update/setTheme/.../destroy）。
(function (root, factory) {
  var api = factory(root.StanzaUtil, root.StanzaSonnetFx);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StanzaTempera = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (U, FX) {
  'use strict';

  // ------------------------------------------------------------------
  // 纯函数：配色、构图、扫光（Node 下可 require 验证，不碰 DOM/PIXI）
  // ------------------------------------------------------------------

  function hexNum(hex, fallback) {
    var c = U.hexToRgb(hex);
    return c ? (c.r << 16) | (c.g << 8) | c.b : fallback;
  }

  // 三种配色：duo 双色（强调 + 次强调）、mono 单色（只用正文色，黑白灰印刷感）、
  // vivid 高饱和（色块直接吃强调色 55%，更接近波普海报）。所有色调都从主题底色
  // 出发混色，保证正文色（浅）在任何色块上都有描边兜底的可读性。
  var COLOR_MODES = ['duo', 'mono', 'vivid'];
  function palette(theme, mode) {
    theme = theme || {};
    var paper = theme.backgroundColor || '#09090b';
    var ink = theme.primaryColor || '#f4f4f5';
    var accent = theme.accentColor || ink;
    var second = theme.secondaryColor || accent;
    if (mode === 'mono') { accent = ink; second = ink; }
    var k = mode === 'vivid' ? [0.2, 0.42, 0.55, 0.12] : mode === 'mono' ? [0.06, 0.12, 0.2, 0.03] : [0.1, 0.22, 0.26, 0.05];
    return {
      paper: paper, ink: ink, accent: accent,
      tones: [
        U.mixHex(paper, accent, k[0]),
        U.mixHex(paper, second, k[1]),
        U.mixHex(paper, accent, k[2]),
        U.mixHex(paper, ink, k[3])
      ]
    };
  }

  function rect(x, y, w, h) { return [x, y, x + w, y, x + w, y + h, x, y + h]; }
  function diamond(cx, cy, rx, ry) { return [cx, cy - ry, cx + rx, cy, cx, cy + ry, cx - rx, cy]; }

  // 构图表：每种返回若干色块 { poly, tone(0-3), dx, dy }，dx/dy 是入场起点偏移。
  // 第一块总是整屏底板（背景模式为「舞台场景」时它会被调淡，让 3D 场景透出来）。
  // rand 只用于构图内部的小变化，同一 seed 永远得到同一画面。
  var COMPOSITIONS = {
    'split-duo': function (w, h, b, rand) {
      var vertical = rand() > 0.5, cut = 0.42 + rand() * 0.16;
      return vertical ? [
        { poly: rect(-b, -b, w * cut + b, h + b * 2), tone: 0, dx: -w * 0.4, dy: 0 },
        { poly: rect(w * cut, -b, w * (1 - cut) + b, h + b * 2), tone: 2, dx: w * 0.4, dy: 0 }
      ] : [
        { poly: rect(-b, -b, w + b * 2, h * cut + b), tone: 0, dx: 0, dy: -h * 0.4 },
        { poly: rect(-b, h * cut, w + b * 2, h * (1 - cut) + b), tone: 2, dx: 0, dy: h * 0.4 }
      ];
    },
    'quad-grid': function (w, h, b, rand) {
      var sx = w * (0.4 + rand() * 0.2), sy = h * (0.4 + rand() * 0.2);
      return [
        { poly: rect(-b, -b, sx + b, sy + b), tone: 0, dx: -w * 0.3, dy: -h * 0.3 },
        { poly: rect(sx, -b, w - sx + b, sy + b), tone: 3, dx: w * 0.3, dy: -h * 0.3 },
        { poly: rect(-b, sy, sx + b, h - sy + b), tone: 2, dx: -w * 0.3, dy: h * 0.3 },
        { poly: rect(sx, sy, w - sx + b, h - sy + b), tone: 1, dx: w * 0.3, dy: h * 0.3 }
      ];
    },
    'diagonal-cut': function (w, h, b, rand) {
      var lean = h * (0.22 + rand() * 0.2);
      return [
        { poly: [-b, -b, w + b, -b, w + b, lean, -b, h - lean], tone: 1, dx: 0, dy: -h * 0.4 },
        { poly: [-b, h - lean, w + b, lean, w + b, h + b, -b, h + b], tone: 3, dx: 0, dy: h * 0.4 }
      ];
    },
    'triptych': function (w, h, b) {
      var e = w * 0.3;
      return [
        { poly: rect(-b, -b, e + b, h + b * 2), tone: 0, dx: -w * 0.3, dy: 0 },
        { poly: rect(e, -b, w - e * 2, h + b * 2), tone: 3, dx: 0, dy: -h * 0.3 },
        { poly: rect(w - e, -b, e + b, h + b * 2), tone: 2, dx: w * 0.3, dy: 0 }
      ];
    },
    'banded': function (w, h, b) {
      var band = (h + b * 2) / 3;
      return [0, 1, 2].map(function (i) {
        return { poly: rect(-b, -b + band * i, w + b * 2, band + 1), tone: [1, 3, 0][i],
          dx: (i % 2 ? 1 : -1) * w * 0.3, dy: 0 };
      });
    },
    'poster-frame': function (w, h, b) {
      return [
        { poly: rect(-b, -b, w + b * 2, h + b * 2), tone: 0, dx: 0, dy: 0 },
        { poly: rect(w * 0.09, h * 0.13, w * 0.82, h * 0.74), tone: 2, dx: w * 0.25, dy: 0 },
        { poly: rect(w * 0.09, h * 0.8, w * 0.28, h * 0.035), tone: 3, dx: -w * 0.2, dy: 0 }
      ];
    },
    'fan-burst': function (w, h, b, rand) {
      var cx = w * (0.28 + rand() * 0.44), cy = h * (0.5 + rand() * 0.2);
      var reach = Math.hypot(w, h) + b * 2;
      var n = 8, off = rand() * Math.PI;
      var out = [{ poly: rect(-b, -b, w + b * 2, h + b * 2), tone: 0, dx: 0, dy: 0 }];
      for (var i = 0; i < n; i += 2) {
        var a = off + i * Math.PI * 2 / n, z = off + (i + 1) * Math.PI * 2 / n;
        out.push({ poly: [cx, cy, cx + Math.cos(a) * reach, cy + Math.sin(a) * reach,
          cx + Math.cos(z) * reach, cy + Math.sin(z) * reach],
          tone: [2, 1, 3, 2][i / 2], dx: Math.cos(a) * w * 0.15, dy: Math.sin(a) * h * 0.15 });
      }
      return out;
    },
    'shutters': function (w, h, b) {
      var n = 6, slat = (h + b * 2) / n;
      return Array.from({ length: n }, function (_, i) {
        return { poly: rect(-b, -b + i * slat, w + b * 2, slat + 1), tone: [0, 1, 3, 2][i % 4],
          dx: (i % 2 ? 1 : -1) * w * 0.45, dy: 0 };
      });
    },
    'offset-collage': function (w, h, b) {
      return [
        { poly: rect(-b, -b, w + b * 2, h + b * 2), tone: 0, dx: 0, dy: 0 },
        { poly: rect(w * 0.05, h * 0.1, w * 0.36, h * 0.7), tone: 2, dx: -w * 0.4, dy: 0 },
        { poly: rect(w * 0.5, h * 0.05, w * 0.44, h * 0.36), tone: 1, dx: 0, dy: -h * 0.4 },
        { poly: rect(w * 0.58, h * 0.6, w * 0.46, h * 0.34), tone: 3, dx: w * 0.4, dy: 0 },
        { poly: diamond(w * 0.47, h * 0.52, w * 0.16, h * 0.28), tone: 1, dx: 0, dy: h * 0.3 }
      ];
    }
  };
  var COMPOSITION_KINDS = Object.keys(COMPOSITIONS);

  function compositionKind(seed, tuning) {
    var fixed = tuning && tuning.composition;
    return COMPOSITION_KINDS.indexOf(fixed) >= 0
      ? fixed : COMPOSITION_KINDS[FX.hashString('tempera:' + seed) % COMPOSITION_KINDS.length];
  }

  function buildPanels(kind, width, height, seed) {
    var drawer = COMPOSITIONS[kind] || COMPOSITIONS['split-duo'];
    return drawer(width, height, 60, FX.seededRandom('tempera-panels:' + seed));
  }

  // 扫光带：把字素按行归组，记下每个字素的左缘/宽度/时间窗（基准排版坐标）。
  function sweepRows(nodes) {
    var rows = [];
    nodes.forEach(function (node) {
      var d = node.dataset;
      if (!d || !String(d.text).trim()) return;
      var key = Math.round(d.baseY);
      var row = null;
      for (var i = 0; i < rows.length; i += 1) if (rows[i].key === key) { row = rows[i]; break; }
      if (!row) { row = { key: key, y: d.baseY, h: d.fontSize * d.fit * 1.28, glyphs: [] }; rows.push(row); }
      var width = d.advance * d.fit;
      row.glyphs.push({ left: d.baseX - width / 2, width: width, start: d.startTime, end: d.endTime });
    });
    return rows;
  }

  // 某一时刻每行扫光推到的右缘：未开唱的行返回 null；字素内按时间线性推进。
  function sweepExtent(row, time) {
    var left = Infinity, right = -Infinity;
    row.glyphs.forEach(function (g) {
      left = Math.min(left, g.left);
      if (time < g.start) return;
      var p = FX.clamp((time - g.start) / Math.max(0.04, g.end - g.start), 0, 1);
      right = Math.max(right, g.left + g.width * p);
    });
    return right > left ? { left: left, right: right } : null;
  }

  // ------------------------------------------------------------------
  // 导演：一句一镜头（构图 + 网屏 + 扫光 + 印刷装饰）
  // ------------------------------------------------------------------

  function TemperaDirector(root, loadPixi) {
    this.root = root;
    this.loadPixi = loadPixi;
    this.app = null;
    this.initialized = false;
    this.destroyed = false;
    this.pendingShot = null;
    this.width = 1;
    this.height = 1;
    this.kind = 'split-duo';
    this.cameraKind = 'quiet-tableau';
    this.words = [];
    this.phrases = [];
    this.clones = [];
    this.rows = [];
    this.accents = null;
    this.colors = null;
    this.fontStack = '"Inter","Noto Sans CJK SC","Source Han Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif';
    this.performance = FX.createPerformance();
    this.postProcess = null;
    this.retirement = null;
  }

  TemperaDirector.prototype.init = function () {
    var self = this;
    return this.loadPixi().then(function (PIXI) {
      if (self.destroyed) return;
      var application = new PIXI.Application();
      self.app = application;
      return application.init({
        backgroundAlpha: 0,
        preference: 'webgl',
        autoStart: false,
        antialias: true,
        resolution: Math.min(2, (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1),
        autoDensity: true
      }).then(function () {
        if (self.destroyed || self.app !== application) {
          application.destroy({ removeView: true, releaseGlobalResources: false }, { children: true });
          if (self.app === application) self.app = null;
          return;
        }
        application.stop();
        self.root.appendChild(application.canvas);
        application.canvas.className = 'fl-tempera-canvas';
        self.scene = new PIXI.Container();
        self.blocks = new PIXI.Container();
        self.screens = new PIXI.Container();
        self.decor = new PIXI.Container();
        self.ink = new PIXI.Graphics();
        self.text = new PIXI.Container();
        self.invert = new PIXI.Container();
        self.sweepMask = new PIXI.Graphics();
        self.flash = new PIXI.Graphics();
        self.scene.addChild(self.blocks, self.screens, self.decor, self.ink,
          self.text, self.invert, self.sweepMask);
        self.invert.mask = self.sweepMask;
        application.stage.addChild(self.scene, self.flash);
        self.postProcess = FX.createPostProcess(PIXI, application.stage);
        self.retirement = FX.createRetirement(PIXI, application.stage);
        self.initialized = true;
        self.resize();
        if (self.pendingShot) self.buildShot.apply(self, self.pendingShot);
      });
    });
  };

  TemperaDirector.prototype.resize = function () {
    if (!this.initialized || !this.app) return;
    var width = Math.max(1, this.root.clientWidth);
    var height = Math.max(1, this.root.clientHeight);
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.app.renderer.resize(width, height);
    if (this.pendingShot) this.buildShot.apply(this, this.pendingShot);
  };

  function clear(container) {
    container.removeChildren().forEach(function (c) { c.destroy({ children: true }); });
  }

  // 网屏：圆点网（半调）或斜线网，裁进色块多边形。点数设上限，大屏也不爆顶点。
  function buildScreen(PIXI, panel, color, rand, dots, w, h) {
    var wrap = new PIXI.Container();
    var g = new PIXI.Graphics();
    var i;
    if (dots) {
      var step = Math.max(14, Math.sqrt(w * h / 2400));
      var radius = step * (0.16 + rand() * 0.1);
      for (var y = -step; y < h + step; y += step) {
        var shift = Math.round(y / step) % 2 ? step / 2 : 0;
        for (var x = -step; x < w + step; x += step) g.circle(x + shift, y, radius);
      }
      g.fill({ color: color, alpha: 0.32 });
    } else {
      var angle = (rand() - 0.5) * Math.PI * 0.6 + Math.PI / 4;
      var spacing = 13 + rand() * 6, diag = Math.hypot(w, h);
      var dx = Math.cos(angle), dy = Math.sin(angle);
      for (i = -diag / spacing; i < diag / spacing; i += 1) {
        var ox = w / 2 - dy * i * spacing, oy = h / 2 + dx * i * spacing;
        g.moveTo(ox - dx * diag, oy - dy * diag).lineTo(ox + dx * diag, oy + dy * diag);
      }
      g.stroke({ color: color, width: 1.2, alpha: 0.4 });
    }
    var clip = new PIXI.Graphics().poly(panel.poly).fill(0xffffff);
    wrap.addChild(g, clip);
    g.mask = clip;
    wrap.dataset = { dx: panel.dx, dy: panel.dy, screen: g };
    return wrap;
  }

  // 印刷装饰：四角套准十字、底部色标条、分镜编号。全部静态，按句重建。
  function buildDecor(PIXI, container, w, h, colors, lineNo, kind) {
    var g = new PIXI.Graphics();
    var m = Math.min(w, h) * 0.06, arm = 11;
    [[m, m], [w - m, m], [m, h - m], [w - m, h - m]].forEach(function (p) {
      g.moveTo(p[0] - arm, p[1]).lineTo(p[0] + arm, p[1]);
      g.moveTo(p[0], p[1] - arm).lineTo(p[0], p[1] + arm);
      g.circle(p[0], p[1], arm * 0.55);
    });
    g.stroke({ color: hexNum(colors.ink, 0xffffff), width: 1, alpha: 0.5 });
    container.addChild(g);
    var chips = new PIXI.Graphics();
    var cw = Math.max(10, w * 0.012), ch = cw * 0.7;
    [colors.accent].concat(colors.tones).forEach(function (hex, i) {
      chips.rect(m + i * (cw + 3), h - m - arm - ch - 8, cw, ch).fill({ color: hexNum(hex, 0x808080), alpha: 0.9 });
    });
    container.addChild(chips);
    var label = new PIXI.Text({
      text: 'No.' + ('0' + Math.max(0, lineNo + 1)).slice(-2) + '  ' + kind.toUpperCase(),
      style: { fontFamily: '"IBM Plex Mono","SFMono-Regular",Consolas,monospace',
        fontSize: Math.max(9, Math.min(w, h) * 0.014), fontWeight: '700', letterSpacing: 3, fill: '#ffffff' }
    });
    label.tint = hexNum(colors.ink, 0xffffff);
    label.alpha = 0.55;
    label.anchor.set(1, 1);
    label.position.set(w - m - arm - 6, h - m - arm - 8);
    container.addChild(label);
  }

  TemperaDirector.prototype.buildShot = function (line, seed, colors, tuning, lineNo) {
    this.pendingShot = [line, seed, colors, tuning, lineNo];
    if (!this.initialized || this.destroyed) return;
    var PIXI = (typeof globalThis !== 'undefined' ? globalThis : window).PIXI;
    var w = this.width, h = this.height;
    this.colors = colors;
    this.kind = compositionKind(seed, tuning);
    this.cameraKind = FX.shotKind(seed, {});
    var rand = FX.seededRandom('tempera-screens:' + seed);

    this.retirement.capture([this.blocks, this.screens, this.decor], this.scene, line);
    clear(this.blocks);
    clear(this.screens);
    clear(this.decor);

    var panels = buildPanels(this.kind, w, h, seed);
    var tones = colors.tones.map(function (t) { return hexNum(t, 0x202020); });
    var accentNum = hexNum(colors.accent, 0xffffff);
    var self = this;
    panels.forEach(function (panel, i) {
      var g = new PIXI.Graphics().poly(panel.poly).fill({ color: tones[panel.tone % 4], alpha: 1 });
      g.dataset = { dx: panel.dx, dy: panel.dy, delay: i * 0.07, base: i === 0 };
      self.blocks.addChild(g);
      // 网屏只落在两块上（第二块与最后一块），一屏至多两层，不糊画面。
      if (tuning.screens !== false && tuning.quality !== 'energy-saving'
        && panels.length > 1 && (i === 1 || i === panels.length - 1)) {
        var s = buildScreen(PIXI, panel, accentNum, rand, i === 1, w, h);
        s.dataset.delay = i * 0.07 + 0.06;
        self.screens.addChild(s);
      }
    });
    buildDecor(PIXI, this.decor, w, h, colors, lineNo, this.kind);

    // 正文：商籁同一条排版管线（字素时间轴 + 词组断行 + 行宽收敛）。
    clear(this.invert);
    this.words = FX.buildLyrics(PIXI, this.text, line, w, h, tuning, seed, this.fontStack);
    this.phrases = FX.buildPhraseStage(PIXI, this.text, this.words, accentNum);
    if (this.accents) this.accents.destroy();
    this.accents = FX.createAccentChoreography(PIXI, this.text, this.words, accentNum, seed);
    // 反色层：每个字素一个同款克隆，染底色，只在扫光遮罩内可见。
    var paperNum = hexNum(colors.paper, 0x09090b);
    this.clones = this.words.map(function (node) {
      // 样式克隆一份：原字素销毁时不牵连反色层。
      var c = new PIXI.Text({ text: node.text, style: node.style.clone() });
      c.anchor.set(0.5);
      c.tint = paperNum;
      self.invert.addChild(c);
      return c;
    });
    this.rows = sweepRows(this.words);
  };

  TemperaDirector.prototype.update = function (frame, tuning) {
    if (!this.initialized || this.destroyed) return null;
    var perf = tuning.performance = this.performance.update(frame, tuning, this.words);
    FX.applyQuality(this.app, this.width, this.height, tuning.quality);
    var w = this.width, h = this.height;
    var motion = FX.motionScale(tuning);
    var time = frame.playbackTime;
    var start = frame.activeLine ? frame.activeLine.startTime : 0;
    var elapsed = Math.max(0, time - start);
    var kick = perf.impact;
    var drift = motion * FX.amount(tuning.performanceIntensity, 1.25);

    var camera = FX.cameraPose(frame, tuning, this.cameraKind, w, h, this.words);
    this.scene.pivot.set(w / 2, h / 2);
    this.scene.position.set(camera.x, camera.y);
    this.scene.scale.set(camera.scale);
    this.scene.rotation = camera.rotation;

    // 色块：错峰滑入（0.5s 三次缓出）+ 慢漂移 + 起音时沿入场方向轻推。
    var baseAlpha = tuning.blockAlpha == null ? 1 : tuning.blockAlpha;
    this.blocks.children.forEach(function (b) {
      var d = b.dataset;
      var p = motion > 0 ? FX.clamp((elapsed - d.delay) / 0.5, 0, 1) : 1;
      var e = 1 - Math.pow(1 - p, 3);
      var phase = time * 0.6 + d.delay * 13;
      b.position.set(
        d.dx * (1 - e) * motion + (d.base ? 0 : Math.sin(phase) * 12 * drift + d.dx * kick * 0.06),
        d.dy * (1 - e) * motion + (d.base ? 0 : Math.cos(phase * 0.8) * 9 * drift + d.dy * kick * 0.06));
      b.alpha = e * (d.base ? baseAlpha * 0.9 : baseAlpha);
    });
    this.screens.children.forEach(function (s) {
      var d = s.dataset;
      var p = motion > 0 ? FX.clamp((elapsed - d.delay) / 0.55, 0, 1) : 1;
      var e = 1 - Math.pow(1 - p, 3);
      s.position.set(d.dx * (1 - e) * motion, d.dy * (1 - e) * motion);
      d.screen.position.set(Math.sin(time * 0.45 + d.delay) * 18 * drift + kick * 14,
        Math.cos(time * 0.33) * 12 * drift);
      s.alpha = e * (0.55 + kick * 0.35);
    });
    this.decor.position.set(Math.sin(time * 0.4) * 6 * motion, Math.cos(time * 0.3) * 4 * motion);

    FX.animateLyrics(this.words, frame, tuning, hexNum(this.colors.accent, 0xffffff));
    FX.animatePhraseStage(this.phrases, frame, tuning, this.cameraKind);
    if (this.accents) this.accents.update(frame, tuning);

    // 扫光带 + 反色：带画在正文下方，同一形状做反色层遮罩。
    this.ink.clear();
    this.sweepMask.clear();
    var showSweep = tuning.inversion !== false && frame.activeLine;
    this.invert.visible = !!showSweep;
    if (showSweep) {
      var lineEnd = frame.activeLine.vocalEndTime || frame.activeLine.endTime;
      var fade = 1 - FX.ease((time - lineEnd - 0.15) / 0.45);
      var accentNum = hexNum(this.colors.accent, 0xffffff);
      var any = false;
      for (var r = 0; r < this.rows.length; r += 1) {
        var row = this.rows[r];
        var ext = sweepExtent(row, time);
        if (!ext) continue;
        any = true;
        var pad = row.h * 0.12;
        this.ink.rect(ext.left - pad, row.y - row.h / 2, ext.right - ext.left + pad * 2, row.h);
        this.sweepMask.rect(ext.left - pad, row.y - row.h / 2, ext.right - ext.left + pad * 2, row.h);
      }
      if (any) {
        this.ink.fill({ color: accentNum, alpha: 0.94 * fade });
        this.sweepMask.fill(0xffffff);
      }
      this.invert.alpha = fade;
      for (var i = 0; i < this.clones.length; i += 1) {
        var src = this.words[i], c = this.clones[i];
        c.position.copyFrom(src.position);
        c.scale.copyFrom(src.scale);
        c.skew.copyFrom(src.skew);
        c.rotation = src.rotation;
        c.visible = src.visible;
      }
    }

    // 起音闪白：整屏一层强调色薄膜，峰值 alpha 0.07，减少动态时关闭。
    this.flash.clear();
    if (motion > 0 && kick > 0.02 && tuning.quality !== 'energy-saving') {
      this.flash.rect(0, 0, w, h).fill({ color: hexNum(this.colors.accent, 0xffffff), alpha: kick * 0.07 });
    }

    var incoming = this.retirement.update(frame, tuning);
    var a = incoming == null ? 1 : incoming;
    this.blocks.visible = tuning.showBlocks !== false;
    this.screens.visible = tuning.showBlocks !== false;
    this.decor.visible = tuning.showDecor !== false;
    this.decor.alpha = a;
    this.postProcess.update(frame, tuning, w, h);
    this.app.render();
    return camera;
  };

  TemperaDirector.prototype.getDebugSnapshot = function () {
    return {
      initialized: this.initialized, composition: this.kind, camera: this.cameraKind,
      panels: this.blocks ? this.blocks.children.length : 0,
      screens: this.screens ? this.screens.children.length : 0,
      glyphs: this.words.length, clones: this.clones.length, rows: this.rows.length,
      performance: this.performance.snapshot(),
      retirement: this.retirement ? this.retirement.snapshot() : null
    };
  };

  TemperaDirector.prototype.destroy = function () {
    if (this.destroyed && !this.app) return;
    this.destroyed = true;
    this.pendingShot = null;
    this.performance.reset();
    this.words = [];
    this.phrases = [];
    this.clones = [];
    this.rows = [];
    if (this.accents) { this.accents.destroy(); this.accents = null; }
    if (this.retirement) { this.retirement.destroy(); this.retirement = null; }
    if (this.postProcess) { this.postProcess.destroy(); this.postProcess = null; }
    if (this.app && this.initialized) {
      try { this.app.destroy({ removeView: true, releaseGlobalResources: false }, { children: true }); }
      catch (err) { console.warn('[stanza-tempera] PIXI cleanup failed:', err); }
    }
    this.app = null;
    this.scene = this.blocks = this.screens = this.decor = this.ink = null;
    this.text = this.invert = this.sweepMask = this.flash = null;
    this.initialized = false;
  };

  // ------------------------------------------------------------------
  // 渲染器外壳（DOM 层只有角标、空态与寻句热区）
  // ------------------------------------------------------------------

  // 无歌词/前奏时的「片头卡」：用曲名当一句已唱完的歌词，色块照常分镜。
  function titleCard(track) {
    var title = String((track && track.title) || '凝彩 TEMPERA');
    return {
      index: -1, startTime: 0, endTime: 1e9, vocalEndTime: 0, fullText: title,
      words: [{ text: title, startTime: 0, endTime: 0, index: 0 }], isChorus: false,
      renderHints: { lineTransitionMode: 'normal', renderEndTime: 1e9, glyphStyle: 'rise' }
    };
  }

  // 取景框只作视觉：凝彩热区若接点击，舞台中央整块都会把「点一下/拖机位」
  // 变成跳回当前句首——播放位置被反复打回，观感即一点舞台就停。
  function init(host) {
    var G = typeof globalThis !== 'undefined' ? globalThis : window;
    var root = document.createElement('div');
    root.className = 'fl-tempera';
    root.hidden = true;
    var eyebrow = document.createElement('div');
    eyebrow.className = 'fl-tempera-eyebrow';
    eyebrow.textContent = 'TEMPERA · 凝彩';
    var note = document.createElement('div');
    note.className = 'fl-tempera-note';
    note.hidden = true;
    var hot = document.createElement('div');
    hot.className = 'fl-tempera-hot';
    hot.hidden = true;
    root.append(eyebrow, note, hot);
    host.append(root);

    var sonnet = G.StanzaSonnet;
    var director = new TemperaDirector(root, sonnet.loadPixi);
    var theme = G.StanzaTheme ? G.StanzaTheme.DEFAULT : { backgroundColor: '#09090b', primaryColor: '#f4f4f5', accentColor: '#f4f4f5', secondaryColor: '#71717a', animationIntensity: 'normal' };
    var fontScale = 1, visible = false, eco = false, reduced = false;
    var motion = 0.65, reactivity = 1.35, bgMode = 'stage', vignette = true;
    var tuning = { composition: 'auto', colorMode: 'duo', screens: true, inversion: true };
    var destroyed = false, initStarted = false, initFailed = false;
    var renderedKey = '', themeSig = '', lastNote = '';
    var ro = null;

    function engineTuning(frame) {
      return {
        palette: { background: theme.backgroundColor, ink: theme.primaryColor },
        fontScale: fontScale,
        composition: tuning.composition,
        lyricLayout: 'phrases',
        phraseLength: 12,
        cameraIntensity: motion * 1.6,
        animationIntensity: frame && frame.reduced ? 0
          : (theme.animationIntensity === 'calm' ? 0.6 : theme.animationIntensity === 'chaotic' ? 1.6 : 1),
        performanceIntensity: reactivity,
        quality: eco ? 'energy-saving' : 'high',
        reducedMotion: reduced,
        showBlocks: true,
        showDecor: true,
        screens: tuning.screens,
        inversion: tuning.inversion,
        accentEffects: true,
        // 「舞台场景」背景下色块压到 0.62，让 3D 场景从色块间透出来。
        blockAlpha: bgMode === 'stage' ? 0.62 : 0.94,
        vignette: vignette ? 0.22 : 0,
        grain: 0.1,
        contrast: 0.12,
        lensDistortion: 0.18,
        lensDispersion: 0.12,
        opticalImpact: 0.7,
        sceneTransitions: true,
        textInversion: true
      };
    }

    function shotKey(frame, line) {
      var trackId = (frame.track && (frame.track.id || frame.track.title)) || '';
      return [trackId, line.startTime, line.fullText, tuning.composition, tuning.colorMode,
        tuning.screens, fontScale, themeSig, bgMode].join('|');
    }

    function updateHot(frame, camera) {
      var line = frame.activeLine;
      if (!camera || !line || !director.words.length) { hot.hidden = true; return; }
      var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      director.words.forEach(function (n) {
        var d = n.dataset, r = d.fontSize * d.fit * 0.75;
        minX = Math.min(minX, d.baseX - r); maxX = Math.max(maxX, d.baseX + r);
        minY = Math.min(minY, d.baseY - r); maxY = Math.max(maxY, d.baseY + r);
      });
      var cx = ((minX + maxX) / 2 - director.width / 2) * camera.scale;
      var cy = ((minY + maxY) / 2 - director.height / 2) * camera.scale;
      var cos = Math.cos(camera.rotation), sin = Math.sin(camera.rotation);
      var sx = camera.x + cx * cos - cy * sin, sy = camera.y + cx * sin + cy * cos;
      var hw = Math.max(64, (maxX - minX) * camera.scale), hh = Math.max(40, (maxY - minY) * camera.scale);
      hot.hidden = false;
      hot.style.transform = 'translate(' + (sx - hw / 2) + 'px,' + (sy - hh / 2) + 'px)';
      hot.style.width = hw + 'px';
      hot.style.height = hh + 'px';
    }

    function frame() {
      if (destroyed || !visible || !G.Stage) return;
      var f = sonnet.buildFrame(root);
      reduced = f.reduced;
      if (!director.initialized) {
        if (!initStarted && !initFailed) {
          initStarted = true;
          director.init().catch(function (err) {
            if (destroyed) return;
            initFailed = true;
            console.warn('[stanza-tempera] 图形引擎不可用：', err);
            note.hidden = false;
            note.textContent = '图形引擎不可用 · 请切换其他歌词视觉';
          });
        }
        return;
      }
      if (initFailed) return;
      director.resize();
      var line = f.activeLine || titleCard(f.track);
      var key = shotKey(f, line);
      if (key !== renderedKey) {
        renderedKey = key;
        var seed = ((f.track && (f.track.id || f.track.title)) || 'tempera') + ':' + line.startTime;
        director.buildShot(line, seed, palette(theme, tuning.colorMode), engineTuning(f), f.currentLineIndex);
      }
      var camera = director.update(f.activeLine ? f : Object.assign({}, f, { activeLine: null, lineProgress: 0 }),
        engineTuning(f));
      updateHot(f, camera);
      var msg = f.activeLine ? '' : (f.track && !f.lines.length ? '暂无歌词 · 让旋律继续' : '');
      if (msg !== lastNote) { lastNote = msg; note.textContent = msg; note.hidden = !msg; }
    }

    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(function () { director.resize(); });
      ro.observe(root);
    }

    return {
      frame: frame,
      update: function () {},
      setTheme: function (t) {
        if (!t) return;
        var sig = G.StanzaTheme ? G.StanzaTheme.signature(t) : JSON.stringify(t);
        if (sig === themeSig) return;
        theme = t;
        themeSig = sig;
        renderedKey = '';
      },
      setFontScale: function (v) {
        v = U.clamp(v, 0.7, 1.5);
        if (Math.abs(v - fontScale) < 1e-6) return;
        fontScale = v;
        renderedKey = '';
      },
      setVisible: function (b) {
        visible = !!b;
        root.hidden = !visible;
        if (visible) {
          if (!initStarted && !initFailed) frame();
          if (G.Stage && G.Stage.kick) G.Stage.kick();
        } else {
          hot.hidden = true;
        }
      },
      setPaused: function () {},
      setEco: function (b) { eco = !!b; },
      setTuning: function (t) {
        if (!t) return;
        var next = {
          composition: COMPOSITION_KINDS.indexOf(t.composition) >= 0 ? t.composition : 'auto',
          colorMode: COLOR_MODES.indexOf(t.colorMode) >= 0 ? t.colorMode : 'duo',
          screens: t.screens !== false,
          inversion: t.inversion !== false
        };
        if (next.composition === tuning.composition && next.colorMode === tuning.colorMode
          && next.screens === tuning.screens && next.inversion === tuning.inversion) return;
        tuning = next;
        renderedKey = '';
      },
      setMotion: function (v) { motion = U.clamp(U.num(v, 0.65), 0, 1); },
      setReactivity: function (v) { reactivity = U.clamp(U.num(v, 1.35), 0, 2); },
      setBgMode: function (m) { if (m !== bgMode) { bgMode = m; renderedKey = ''; } },
      setVignette: function (b) { vignette = !!b; },
      resize: function () { director.resize(); },
      getDebugSnapshot: function () { return director.getDebugSnapshot(); },
      destroy: function () {
        destroyed = true;
        if (ro) { ro.disconnect(); ro = null; }
        director.destroy();
        root.remove();
      }
    };
  }

  return {
    // 常量与纯函数（验证脚本用）
    COMPOSITION_KINDS: COMPOSITION_KINDS, COLOR_MODES: COLOR_MODES,
    palette: palette, compositionKind: compositionKind, buildPanels: buildPanels,
    sweepRows: sweepRows, sweepExtent: sweepExtent, titleCard: titleCard,
    // 浏览器渲染器
    init: init
  };
});
