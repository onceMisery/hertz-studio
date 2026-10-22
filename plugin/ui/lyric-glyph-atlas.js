// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// 字形图集：Canvas2D 栅格化 → SDF → Uint8Array 图集。LRU 淘汰，按 cell 上传。
(function (global) {
  'use strict';
  if (typeof window === 'undefined') return;
  var SDF = global.LyricGlyphSdf;

  // 字体度量必须实测，不能按「中文大约 0.88em」硬编码。
  // 之前 BASELINE 固定取 0.78×RENDER_PX，导致 64px 中文的顶部 6px 落到内容框外：
  // getImageData 把字切出一条直边，距离场把它当成轮廓，画出来就是每个字顶上的白块。
  // 这类错误不会报异常，只会让"字看起来怪"——所以度量必须来自 measureText。
  function measureMetrics(fontStack, weight) {
    var probe = document.createElement('canvas').getContext('2d');
    var PROBE_PX = 100;
    probe.font = weight + ' ' + PROBE_PX + 'px ' + fontStack;
    // 取样只覆盖「歌词真正会出现的东西」：汉字、拉丁字母、数字、常用西文标点。
    // 不要把「（）」「，。」这类全角标点算进来 —— 它们下伸到 0.26em，
    // 会把可用字号从 ~112px 压到 ~87px，字就软了；而歌词里不会出现全角括号。
    var sample = '国鬱口回一永日月目山火水木金土' +
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' +
      ' .,\'"!?-:;';
    var asc = 0, desc = 0, adv = 0;
    for (var i = 0; i < sample.length; i += 1) {
      var m = probe.measureText(sample[i]);
      if (m.actualBoundingBoxAscent > asc) asc = m.actualBoundingBoxAscent;
      if (m.actualBoundingBoxDescent > desc) desc = m.actualBoundingBoxDescent;
      if (m.width > adv) adv = m.width;
    }
    // 少数实现不给 actualBoundingBox*：退回保守估计，宁可留白也不裁字。
    if (!(asc > 0)) asc = PROBE_PX * 0.92;
    if (!(desc > 0)) desc = PROBE_PX * 0.16;
    if (!(adv > 0)) adv = PROBE_PX;
    return { ascentPerPx: asc / PROBE_PX, descentPerPx: desc / PROBE_PX, advancePerPx: adv / PROBE_PX };
  }

  var ATLAS_W = 2048, ATLAS_H = 1024;

  // 160/128 是权衡：cell 再大就要减少图集槽位（2048/160 = 12 列 × 6 行 = 72 槽），
  // 而 72 槽刚好覆盖一行歌词 + LRU 余量；栅格化字号据此可到 112px，
  // 与 stanza 全屏字号的实际上限（4.5rem × 1.5 缩放 ≈ 108px）基本 1:1，不再放大发虚。
  var CELL = 160;
  var PAD = 16;
  var RANGE = 8;
  var SAFETY = 2;                                  // 墨迹盒与内容框之间再留 2px
  var CONTENT = CELL - PAD * 2;                    // 128
  var MAX_RENDER_PX = 112;
  var COLS = Math.floor(ATLAS_W / CELL);
  var ROWS = Math.floor(ATLAS_H / CELL);
  var CAP = COLS * ROWS;

  // 一张图集的几何：字号与基线都由「这张脸的墨迹盒」反推。
  // 双图集必须共用同一份几何（见 createDual），否则 400 和 700 的字会
  // 以不同字号/基线交错在同一格里，混合出来像重影。
  function geometryFor(met, renderPx) {
    var px = renderPx;
    if (!(px >= 16)) px = 16;
    var baseline = Math.round(SAFETY + met.ascentPerPx * px);
    // 下伸也不能出内容框；极端字体度量下把基线往上收。
    var bottom = baseline + met.descentPerPx * px;
    if (bottom > CONTENT - SAFETY) baseline = Math.floor(CONTENT - SAFETY - met.descentPerPx * px);
    return { renderPx: px, baseline: baseline };
  }

  function maxRenderPx(metricsList) {
    var maxAsc = 0, maxDesc = 0, maxAdv = 0;
    metricsList.forEach(function (m) {
      maxAsc = Math.max(maxAsc, m.ascentPerPx);
      maxDesc = Math.max(maxDesc, m.descentPerPx);
      maxAdv = Math.max(maxAdv, m.advancePerPx);
    });
    var maxSide = CONTENT - SAFETY * 2;             // 124
    // 上限 112：再大只是把内存花在 1:1 以上的精度上，屏幕字号到不了。
    return Math.floor(Math.min(
      maxSide / (maxAsc + maxDesc),
      maxSide / maxAdv,
      MAX_RENDER_PX
    ));
  }

  function create(fontStack, baseWeight, sharedGeometry) {
    // 基准字重必须可配置：Windows 的 Microsoft YaHei 没有 600 面，
    // 600 会被匹配成 700，导致粗细场只能变胖、无法变细。
    var rasterWeight = baseWeight || 600;
    var met = measureMetrics(fontStack, rasterWeight);
    var geom = sharedGeometry || geometryFor(met, maxRenderPx([met]));
    var renderPx = geom.renderPx;
    var BASELINE = geom.baseline;

    var bytes = new Uint8Array(ATLAS_W * ATLAS_H);   // 全 0 = 远外部

    var scratch = document.createElement('canvas');
    scratch.width = scratch.height = CELL;
    var sctx = scratch.getContext('2d', { willReadFrequently: true });

    var slots = new Array(CAP);
    var index = Object.create(null);
    var used = 0, stamp = 0;
    var dirty = [];

    function fontOf(px) { return rasterWeight + ' ' + px + 'px ' + fontStack; }

    // 墨迹包围盒（内容盒坐标，含端点的像素中心）。辉光在 SDF 饱和区
    // （距轮廓 ≥RANGE）拿不到真实距离，必须用这个盒子把远场延续下去，
    // 否则每个字后面会出现一整格 160px 的方形暗光。
    function inkBox(img) {
      var x0 = CONTENT, y0 = CONTENT, x1 = -1, y1 = -1;
      for (var y = 0; y < CONTENT; y += 1) {
        var row = y * CONTENT * 4;
        for (var x = 0; x < CONTENT; x += 1) {
          if (img.data[row + x * 4 + 3] <= 127) continue;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
      if (x1 < x0 || y1 < y0) return null;
      return {
        cx: (x0 + x1 + 1) / 2, cy: (y0 + y1 + 1) / 2,
        hx: (x1 - x0 + 1) / 2, hy: (y1 - y0 + 1) / 2
      };
    }

    // 栅格化单个字素 → { sdf, box }，空白字素返回 null。
    // 不设 shadowBlur：lyric3d 靠"画两遍"做辉光，这里辉光在片元里算，字形必须干净。
    function rasterize(ch) {
      sctx.clearRect(0, 0, CELL, CELL);
      sctx.font = fontOf(renderPx);
      sctx.textBaseline = 'alphabetic';
      sctx.fillStyle = '#fff';
      sctx.fillText(ch, PAD, PAD + BASELINE);
      var img = sctx.getImageData(PAD, PAD, CONTENT, CONTENT);
      var sdf = SDF.rasterToSdf(img.data, CONTENT, CONTENT, RANGE);
      if (!sdf) return null;
      return { sdf: sdf, box: inkBox(img) };
    }

    // 写进图集内容区；边距保持 0（= 距轮廓 ≥8px 的外部）。
    function writeSlot(slot, sdf) {
      var cx = (slot % COLS) * CELL, cy = Math.floor(slot / COLS) * CELL;
      for (var y = 0; y < CONTENT; y += 1) {
        var src = y * CONTENT;
        var dst = (cy + PAD + y) * ATLAS_W + (cx + PAD);
        bytes.set(sdf.subarray(src, src + CONTENT), dst);
      }
      dirty.push(slot);
    }

    // 图集只管「字形长什么样」，不管「字占多宽」。
    // advance 与字体字重、屏幕字号相关，归排版层（stanza-glyph.js）所有。
    // 图集 key 只含字形 + 栅格化字号：屏幕字号不影响 SDF，放进 key 会让拖字号滑杆时全表失效。
    function acquire(ch) {
      var key = ch + '\u0001' + renderPx;
      var slot = index[key];
      if (slot != null) { slots[slot].used = ++stamp; return slots[slot]; }

      if (used < CAP) slot = used++;
      else {
        // LRU：线性扫 210 项。容量小，维护堆反而更贵，且不在热路径。
        var oldest = 0, best = Infinity;
        for (var i = 0; i < CAP; i += 1) {
          if (slots[i] && slots[i].used < best) { best = slots[i].used; oldest = i; }
        }
        slot = oldest;
        if (slots[slot]) delete index[slots[slot].key];
      }

      var made = rasterize(ch);
      if (made) writeSlot(slot, made.sdf);

      var cx = (slot % COLS) * CELL, cy = Math.floor(slot / COLS) * CELL;
      slots[slot] = { key: key, used: ++stamp, u0: cx / ATLAS_W, v0: cy / ATLAS_H,
        box: made ? made.box : null };
      index[key] = slot;
      return slots[slot];
    }

    return {
      bytes: bytes, W: ATLAS_W, H: ATLAS_H,
      CELL: CELL, PAD: PAD, CONTENT: CONTENT, BASELINE: BASELINE,
      RENDER_PX: renderPx, RANGE: RANGE, CAP: CAP, COLS: COLS, ROWS: ROWS,
      // 把实测度量一并导出：排版层要用 ascent 决定行高，检查脚本要用它对齐原生基准。
      metrics: { ascent: met.ascentPerPx * renderPx, descent: met.descentPerPx * renderPx,
        advance: met.advancePerPx * renderPx, weight: rasterWeight },
      acquire: acquire,
      takeDirty: function () { var d = dirty; dirty = []; return d; },
      cellBytes: function (slot) {
        // 紧凑缓冲（CELL² 字节），供 texSubImage2D 逐 cell 上传。
        var out = new Uint8Array(CELL * CELL);
        var cx = (slot % COLS) * CELL, cy = Math.floor(slot / COLS) * CELL;
        for (var y = 0; y < CELL; y += 1) {
          out.set(bytes.subarray((cy + y) * ATLAS_W + cx, (cy + y) * ATLAS_W + cx + CELL), y * CELL);
        }
        return out;
      },
      cellOrigin: function (slot) {
        return { x: (slot % COLS) * CELL, y: Math.floor(slot / COLS) * CELL };
      },
      reset: function () {
        used = 0; stamp = 0; index = Object.create(null);
        slots.length = CAP; dirty.length = 0;
        bytes.fill(0);
      }
    };
  }

  // 双图集：R=400、G=700。两张脸必须共用字号与基线；
  // 分配槽位也必须一致，否则片元里混的是两个不同位置的字。
  function createDual(fontStack) {
    var m400 = measureMetrics(fontStack, 400);
    var m700 = measureMetrics(fontStack, 700);
    var geom = geometryFor(
      { ascentPerPx: Math.max(m400.ascentPerPx, m700.ascentPerPx),
        descentPerPx: Math.max(m400.descentPerPx, m700.descentPerPx) },
      maxRenderPx([m400, m700])
    );
    var lo = create(fontStack, 400, geom);
    var hi = create(fontStack, 700, geom);
    function acquire(ch) {
      var a = lo.acquire(ch);
      var b = hi.acquire(ch);
      if (a.u0 !== b.u0 || a.v0 !== b.v0) throw new Error('dual atlas slot mismatch: ' + ch);
      // 两张脸的墨迹盒取并集：片元只用一个盒子，不能偏向某一边。
      var box = null;
      if (a.box && b.box) {
        var x0 = Math.min(a.box.cx - a.box.hx, b.box.cx - b.box.hx);
        var x1 = Math.max(a.box.cx + a.box.hx, b.box.cx + b.box.hx);
        var y0 = Math.min(a.box.cy - a.box.hy, b.box.cy - b.box.hy);
        var y1 = Math.max(a.box.cy + a.box.hy, b.box.cy + b.box.hy);
        box = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, hx: (x1 - x0) / 2, hy: (y1 - y0) / 2 };
      } else {
        box = a.box || b.box;
      }
      return { u0: a.u0, v0: a.v0, box: box, used: a.used };
    }
    return {
      W: lo.W, H: lo.H, CELL: lo.CELL, PAD: lo.PAD, RANGE: lo.RANGE,
      CONTENT: lo.CONTENT, BASELINE: lo.BASELINE, RENDER_PX: lo.RENDER_PX,
      metrics: lo.metrics, CAP: lo.CAP, COLS: lo.COLS, ROWS: lo.ROWS,
      acquire: acquire,
      takeDirty: function () { var d = lo.takeDirty(); hi.takeDirty(); return d; },
      cellOrigin: function (slot) { return lo.cellOrigin(slot); },
      cellBytes: function (slot) {
        var a = lo.cellBytes(slot);
        var b = hi.cellBytes(slot);
        var out = new Uint8Array(a.length * 2);
        for (var i = 0; i < a.length; i += 1) {
          out[i * 2] = a[i];
          out[i * 2 + 1] = b[i];
        }
        return out;
      },
      reset: function () { lo.reset(); hi.reset(); }
    };
  }

  global.LyricGlyphAtlas = { create: create, createDual: createDual };
})(window);
