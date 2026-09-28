// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
// 心象排版器：替代 @chenglou/pretext（歌词短文本/CJK 为主的精简面）。
//
// 字段与 folia cadenza spec 术语映射：
// x/y/w/h = placement 的左上角坐标与宽高；entryX/entryY = entryOffset（入场偏移）；
// passedRotate/driftX/driftY = passed 漂移（唱过后的旋转与位移）；hero = emphasis 标记（强调词）。
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

  function isCJKChar(ch) { return /[一-鿿぀-ヿ가-힯]/.test(ch); }

  // 时间戳归一：非有限值回退 f；end 早于 start 时收敛到 start。
  function numMs(v, f) { v = Number(v); return isFinite(v) ? v : f; }

  // tokens → 原子单元。逐字素扫描：连续 CJK 字素各自成一个单元（时间按 st/ed 均摊），
  // 连续非 CJK 字素累积成一个拉丁词单元（空白结束当前词且自身不产单元）。
  // 例：hello世界 → hello/世/界；我 love你 → 我/love/你。
  function atomize(tokens) {
    var units = [];
    tokens.forEach(function (tk, ti) {
      if (!tk) return;
      var text = tk.text || '';
      if (!text) return;
      var st = numMs(tk.start_ms, 0);
      var ed = numMs(tk.end_ms, st);
      if (ed < st) ed = st;
      var gs = U.graphemes(text);
      var cjkTotal = 0;
      gs.forEach(function (g) { if (isCJKChar(g)) cjkTotal += 1; });
      var cjkIdx = 0;
      var word = '';
      function flushWord() {
        if (word) { units.push({ text: word, start_ms: st, end_ms: ed, ti: ti }); word = ''; }
      }
      gs.forEach(function (g) {
        if (isCJKChar(g)) {
          flushWord();
          var t0 = cjkTotal ? st + (ed - st) * cjkIdx / cjkTotal : st;
          var t1 = cjkTotal ? st + (ed - st) * (cjkIdx + 1) / cjkTotal : ed;
          cjkIdx += 1;
          units.push({ text: g, start_ms: t0, end_ms: t1, ti: ti });
        } else if (/\s/.test(g)) {
          flushWord();
        } else {
          word += g;
        }
      });
      flushWord();
    });
    return units;
  }

  // 过长的拉丁单元按字素硬切到不超过 maxW
  function fitUnit(unit, maxW, fontPx) {
    var w = measureFn(unit.text, fontPx);
    if (w <= maxW) return [unit];
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
    units.forEach(function (u) {
      var mw = measureFn(u.text, fontPx);
      u.w = isFinite(mw) && mw > 0 ? mw : 0;
      u.h = fontPx * 0.96;
    });
  }

  function heroScore(u, centerBias) {
    var n = U.graphemes(u.text).length;
    var semantic = isCJKChar(u.text) ? 0.18 : Math.min(n * 0.08, 0.36);
    return semantic + centerBias * 0.18;
  }

  // 主入口
  function layout(tokens, opts) {
    tokens = tokens || [];
    if (!Array.isArray(tokens)) tokens = [];
    opts = opts || {};
    var fontPx = isFinite(Number(opts.fontPx)) ? U.clamp(Number(opts.fontPx), 8, 200) : 60;
    var maxW = isFinite(Number(opts.maxW)) ? Math.max(0, Number(opts.maxW)) : 0;
    var seedBase = numMs(tokens[0] && tokens[0].start_ms, 0);
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
      var used = row.reduce(function (a, x) { return a + x.w; }, 0);
      // 加入后总宽 = 已有宽和 + n 个词间间隙（已有 n 词时总间隙数为 n）+ u.w。
      if (used + (row.length ? gap * row.length : 0) + u.w > maxW && row.length) rows.push(row = []);
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
    var placements = [];
    rows.forEach(function (row, ri) {
      var rowW = row.reduce(function (a, u) { return a + u.w; }, 0) + gap * (row.length - 1);
      var startX = (maxW - rowW) / 2, cursor = startX;
      var pitchY = fontPx * 0.96 + 2 * Math.max(12, lineH * 0.45) + 0.01; // ≈2.32em，保证规则网格下跨行 y 带不相交（spec 7.2 纵向步长 ≥2.2 行高）
      var y = (ri - heroRow) * pitchY;
      row.forEach(function (u, ui) {
        var isHero = u === units[heroIdx];
        var rnd = function (off) { return U.srand(seedBase + u.ti + off + ri * 13 + ui * 7); };
        var scale = isHero ? U.clamp(1.18 * heroBoost, 1.18, 1.5) : (1 + rnd(1) * 0.12);
        var jitterX = isHero ? 0 : (rnd(2) - 0.5) * fontPx * 0.09;
        var x = cursor + jitterX;
        placements.push({
          text: u.text, start_ms: u.start_ms, end_ms: u.end_ms,
          x: x, y: y - u.h * 0.5, w: u.w, h: u.h, _ri: ri,
          rotate: (rnd(3) - 0.5) * (isHero ? 0 : 5),
          scale: scale, hero: isHero,
          entryX: (rnd(4) - 0.5) * fontPx * (isHero ? 0.4 : 0.9),
          entryY: (rnd(5) - 0.5) * fontPx * 0.9,
          passedRotate: (rnd(6) - 0.5) * 24,
          driftX: (rnd(7) - 0.5) * fontPx * 0.5,
          driftY: (rnd(8) - 0.5) * fontPx * 0.4
        });
        cursor += u.w + gap;
      });
    });

    // 4) 放置后全局成对松弛：独立 x/y 碰撞带，沿穿透较小的轴各让一半；hero 不动。
    function bandOf(p) {
      return { bx: p.w * (p.scale - 1) / 2 + 2, by: Math.max(12, lineH * 0.45) };
    }
    for (var pass = 0; pass < 3; pass += 1) {
      var moved = false;
      for (var a = 0; a < placements.length; a += 1) {
        var pa = placements[a], ba = bandOf(pa);
        for (var b2 = 0; b2 < a; b2 += 1) {
          var pb = placements[b2], bb = bandOf(pb);
          var ox = Math.min(pa.x + pa.w + ba.bx - (pb.x - bb.bx),
                            pb.x + pb.w + bb.bx - (pa.x - ba.bx));
          var oy = Math.min(pa.y + pa.h + ba.by - (pb.y - bb.by),
                            pb.y + pb.h + bb.by - (pa.y - ba.by));
          if (ox <= 0 || oy <= 0) continue;
          var useX = ox <= oy, d = (useX ? ox : oy) / 2;
          var cpa = useX ? (pa.x + pa.w / 2) - (pb.x + pb.w / 2)
                         : (pa.y + pa.h / 2) - (pb.y + pb.h / 2);
          var dir = cpa >= 0 ? 1 : -1;
          if (useX) {
            if (!pa.hero) { pa.x += d * dir; moved = true; }
            if (!pb.hero) { pb.x -= d * dir; moved = true; }
          } else {
            if (!pa.hero) { pa.y += d * dir; moved = true; }
            if (!pb.hero) { pb.y -= d * dir; moved = true; }
          }
        }
      }
      if (!moved) break;
    }

    // 4b) 保证尾：3 轮半退让在 hero 固定、行密集时仍可能残留正穿透——
    // hero 不动时单个碰撞对每轮穿透至多减半（14px 初始穿透三轮后仍剩约 1.75px），
    // 而 by=0.45·lineH 的收紧带（两侧合计 0.9·lineH）本就大于 1.5em 行距留出的
    // 0.54em 行间空隙，密集行无法都靠沿 x 滑开。此处用两段确定性“恰好接触”兜底
    // （接触边再留 0.01px 安全缝，吸收 A-(A-B) 级浮点舍入，碰撞式严格为负）：
    //   ① 同行按序把后缀右移到与前一词接触，消除所有行内 x 穿透；
    //   ② 以 hero 行为锚向下/向上逐行整体平移（行内各词一起动，保持行形），
    //      消除该行与所有已定位行的 y 穿透。无残留时两段均为零操作。
    var RELAX_EPS = 0.01;
    // 行锚复位：3 轮松弛的 y 半退让可能把同行词散到相邻行之下（无符号保证的半成品），
    // 会干扰下面按行序的整体平移；x 滑动保留，y 回到理想行锚后由 ② 精确重排。
    placements.forEach(function (p) { p.y = (p._ri - heroRow) * lineH - p.h * 0.5; });
    // ①行内：placement 按行主序压入，同 _ri 即同一行。
    var i0 = 0;
    while (i0 < placements.length) {
      var ri0 = placements[i0]._ri, i1 = i0 + 1;
      while (i1 < placements.length && placements[i1]._ri === ri0) i1 += 1;
      for (var ci = i0 + 1; ci < i1; ci += 1) {
        var pw = placements[ci - 1], cu = placements[ci];
        var edge = pw.x + pw.w + bandOf(pw).bx + RELAX_EPS;
        var gapLeft = cu.x - bandOf(cu).bx;
        if (gapLeft < edge) cu.x += edge - gapLeft; // 回代后右侧穿透严格为负
      }
      i0 = i1;
    }
    (function shiftRows() {
      function byOf(p) { return bandOf(p).by; }
      // 仅当 x 碰撞带也相交时才算 y 穿透（否则本来就不算碰撞）。
      function xHit(p, q) {
        var bp = bandOf(p).bx, bq = bandOf(q).bx;
        var ox = Math.min(p.x + p.w + bp - (q.x - bq), q.x + q.w + bq - (p.x - bp));
        return ox > -RELAX_EPS;
      }
      // ②a hero 行以下：自顶向下，第 r 行相对所有已定位的上方行求最大 y 穿透，整后缀下移。
      for (var r2 = heroRow + 1; r2 < rows.length; r2 += 1) {
        var down = 0;
        placements.forEach(function (p) {
          if (p._ri !== r2) return;
          placements.forEach(function (q) {
            if (q._ri >= r2 || !xHit(p, q)) return;
            var pen = (q.y + q.h + byOf(q)) - (p.y - byOf(p)) + RELAX_EPS;
            if (pen > down) down = pen;
          });
        });
        if (down > 0) placements.forEach(function (p) { if (p._ri >= r2) p.y += down; });
      }
      // ②b hero 行以上：自底向上，第 r 行相对所有已定位的下方行求最大 y 穿透，整前缀上移。
      for (var r3 = heroRow - 1; r3 >= 0; r3 -= 1) {
        var up = 0;
        placements.forEach(function (p) {
          if (p._ri !== r3) return;
          placements.forEach(function (q) {
            if (q._ri <= r3 || !xHit(p, q)) return;
            var pen = (p.y + p.h + byOf(p)) - (q.y - byOf(q)) + RELAX_EPS;
            if (pen > up) up = pen;
          });
        });
        if (up > 0) placements.forEach(function (p) { if (p._ri <= r3) p.y -= up; });
      }
    })();
    // ③逐行重居中：②完成 y 定位后，把 ① 的右推、x 松弛位移与初始 jitter 统一收回。
    // 每行整体只平移 x（不动 y、不改变行内相对位置），以 scale 外扩带 bx 计左右界：
    //   span≤maxW → 目标左界 (maxW-span)/2（居中，≥0）；
    //   span>maxW（不可拆的超大词边角）→ 目标左界 maxW/2-span/2（相对中线对称溢出）。
    // 先按行收集位移再统一应用（两遍纯遍历）；空行/空 placements 均安全。
    (function recenterRows() {
      var bounds = [];
      placements.forEach(function (p) {
        var bx = bandOf(p).bx;
        var l = p.x - bx, r = p.x + p.w + bx;
        var b = bounds[p._ri];
        if (!b) bounds[p._ri] = { left: l, right: r };
        else { b.left = Math.min(b.left, l); b.right = Math.max(b.right, r); }
      });
      var delta = bounds.map(function (b) {
        var span = b.right - b.left;
        var target = span <= maxW ? (maxW - span) / 2 : maxW / 2 - span / 2;
        return target - b.left;
      });
      placements.forEach(function (p) { p.x += delta[p._ri]; });
    })();
    placements.forEach(function (p) { delete p._ri; });

    // 5) 归一化原点到左上角（p.y 为顶部坐标：顶 p.y，底 p.y+p.h）
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    placements.forEach(function (p) {
      var pad = p.w * (p.scale - 1) / 2;
      minX = Math.min(minX, p.x - pad); maxX = Math.max(maxX, p.x + p.w + pad);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y + p.h);
    });
    var offX = -minX, offY = -minY;
    placements.forEach(function (p) { p.x += offX; p.y += offY; });
    return { width: maxX - minX, height: maxY - minY, placements: placements };
  }

  return { configure: configure, installCanvasMeasure: installCanvasMeasure, layout: layout };
});
