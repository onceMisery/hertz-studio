// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
// 商籁 sonnet 图形引擎：镜头调度、字素时间轴、词组舞台、重音编舞、光学印相后期。
// 行为语言参考 VCPChat 音乐舞台的商籁模式与 folia 原版 sonnet 的电影镜头思路，
// 代码为本项目独立实现（见 NOTICE「Design lineage」）。
// 纯函数（时间轴/断句/选点/镜头数学）可在 Node 下 require 做验证；PIXI 相关
// 构建函数一律以 PIXI 作首参注入，本文件不触碰全局。
(function (root, factory) {
  var api = factory(root.FoliaUtil);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FoliaSonnetFx = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (U) {
  'use strict';

  function num(v, f) { v = Number(v); return isFinite(v) ? v : f; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  // 调参归一：非法值回退 fallback，再钳进 [0, max]。
  function amount(v, fallback, max) {
    max = max == null ? 2 : max;
    return clamp(num(v, fallback), 0, max);
  }
  function ease(v) { var t = clamp(v, 0, 1); return t * t * (3 - 2 * t); }
  function expo(v) { var t = clamp(v, 0, 1); return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); }

  // FNV-1a：字符串 → uint32。选景/构图/随机种子的确定性来源，seek 后不换样。
  function hashString(input) {
    var s = String(input == null ? '' : input), h = 2166136261;
    for (var i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  // mulberry32 变体：同一 seed 永远产出同一序列。
  function seededRandom(seed) {
    var state = hashString(seed) || 1;
    return function () {
      state += 0x6D2B79F5;
      var v = state;
      v = Math.imul(v ^ (v >>> 15), v | 1);
      v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
      return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 七种镜头调度（shot）：每句按 seed 抽一种，或由调参固定。
  var SHOT_KINDS = ['editorial-column', 'type-impact', 'fragment-collage',
    'tracking-ribbon', 'mask-reveal', 'poster-blocks', 'quiet-tableau'];
  function shotKind(seed, tuning) {
    return SHOT_KINDS.indexOf(tuning.shotFlow) >= 0
      ? tuning.shotFlow : SHOT_KINDS[hashString(seed) % SHOT_KINDS.length];
  }
  // 六种背景构图：与镜头独立抽取，同一句的 HUD 布景稳定可复现。
  var SCENE_KINDS = ['orbital', 'constellation', 'perspective', 'wave-score', 'orrery', 'editorial-lattice'];
  function sceneKind(seed) { return SCENE_KINDS[hashString('scene:' + seed) % SCENE_KINDS.length]; }

  // reduced / 动效量统一出口：减少动态直接归零，位移旋转全部冻结在基准位。
  function motionScale(tuning) {
    return tuning.reducedMotion ? 0 : amount(tuning.animationIntensity, 1);
  }

  // ------------------------------------------------------------------
  // 字素时间轴与断句
  // ------------------------------------------------------------------

  // 行 → 字素表。优先用词级时间轴（Stage.lyricTokens），词内按字素均分；
  // 再把「分词时被丢掉的空格/标点」按原文对齐补回，保证逐字排版与原文一致。
  function buildGlyphTimeline(line) {
    if (!line) return [];
    var words = line.words || [];
    var source = [];
    words.forEach(function (w, wi) {
      var gs = U.graphemes(w.text);
      var st = num(w.startTime, line.startTime), en = Math.max(st, num(w.endTime, line.endTime));
      gs.forEach(function (text, gi) {
        source.push({
          text: text, char: text,
          startTime: st + (en - st) * gi / Math.max(1, gs.length),
          endTime: st + (en - st) * (gi + 1) / Math.max(1, gs.length),
          wordIndex: wi, syllableIndex: -1
        });
      });
    });
    var full = U.graphemes(line.fullText);
    if (!full.length || source.map(function (g) { return g.text; }).join('') === line.fullText) return source;
    // 对齐：源字素按顺序落位到原文；原文多出来的字符（空格等）继承邻位时间。
    var aligned = full.map(function (text) {
      return { text: text, char: text, startTime: line.startTime, endTime: line.startTime,
        wordIndex: -1, syllableIndex: -1 };
    });
    var cursor = 0, lastTime = line.startTime;
    source.forEach(function (g) {
      var target = -1;
      for (var i = cursor; i < full.length; i += 1) {
        if (full[i] === g.text) { target = i; break; }
      }
      if (target < 0) return;
      for (var j = cursor; j < target; j += 1) {
        aligned[j].startTime = g.startTime;
        aligned[j].endTime = g.startTime;
      }
      aligned[target] = g;
      cursor = target + 1;
      lastTime = Math.max(lastTime, g.endTime);
    });
    for (var k = cursor; k < aligned.length; k += 1) {
      aligned[k].startTime = lastTime;
      aligned[k].endTime = lastTime;
    }
    return aligned;
  }

  var BREAK_PUNCT = /[，。！？；、,.!?;:：]/u;
  var CJK_RE = /[\u3040-\u30ff\u3400-\u9fff]/u;

  // 词组编译：标点与 >0.4s 的换气是硬边界；超过 phraseLength 后在词/汉字边界软断。
  // 只打 phrase 标记，不改任何时间戳。
  function compilePhrases(line, tuning) {
    var glyphs = buildGlyphTimeline(line);
    var limit = Math.round(amount(tuning.phraseLength, 12, 24)) || 12;
    var phrase = 0, count = 0;
    glyphs.forEach(function (g, i) {
      var prev = glyphs[i - 1];
      var naturalBreak = prev && (BREAK_PUNCT.test(prev.text) || g.startTime - prev.endTime > 0.4);
      var wordBreak = prev && (/\s/u.test(prev.text) || CJK_RE.test(g.text));
      if (count >= 3 && (naturalBreak || (count >= limit && wordBreak))) {
        phrase += 1;
        count = 0;
      }
      g.phrase = phrase;
      if (g.text.trim()) count += 1;
    });
    var groups = [];
    glyphs.forEach(function (g) {
      if (!groups[g.phrase]) groups[g.phrase] = { start: g.startTime, end: g.endTime };
      groups[g.phrase].end = Math.max(groups[g.phrase].end, g.endTime);
    });
    glyphs.forEach(function (g) {
      g.phraseStart = groups[g.phrase].start;
      g.phraseEnd = groups[g.phrase].end;
    });
    return glyphs;
  }

  // ------------------------------------------------------------------
  // 重音选点：哪些行值得放粒子重音（确定性，逐行独立判定）
  // ------------------------------------------------------------------

  var CUE_PUNCT = /[，。！？…!?]/u;
  var accentCueCache = typeof WeakMap === 'function' ? new WeakMap() : null;

  function computeAccentCues(lines, seed) {
    var selected = new Set();
    if (!Array.isArray(lines)) return selected;
    var previous = -Infinity;
    lines.forEach(function (line, index) {
      var duration = line.endTime - line.startTime;
      var count = U.graphemes(line.fullText).filter(function (c) { return c.trim(); }).length;
      var gap = index ? line.startTime - lines[index - 1].endTime : 1;
      var random = seededRandom(seed + ':' + index + ':' + line.fullText);
      // 长句、字数适中、密度不超 9 字/秒、与上个重音隔 7s，且满足
      // 换气/标点/随机三者其一 —— 才挂重音，避免满屏粒子。
      if (duration >= 2.4 && count >= 3 && count / duration < 9
        && line.startTime - previous >= 7
        && (gap > 0.45 || CUE_PUNCT.test(line.fullText) || random() > 0.40)) {
        selected.add(index);
        previous = line.startTime;
      }
    });
    return selected;
  }

  function accentCues(lines, seed) {
    if (!accentCueCache) return computeAccentCues(lines, seed);
    var cache = accentCueCache.get(lines);
    if (!cache) { cache = new Map(); accentCueCache.set(lines, cache); }
    if (cache.has(seed)) return cache.get(seed);
    var selected = computeAccentCues(lines, seed);
    if (cache.size >= 4) cache.delete(cache.keys().next().value);
    cache.set(seed, selected);
    return selected;
  }

  // ------------------------------------------------------------------
  // 镜头：七条绝对时间位姿路径。同一时刻位姿恒定 —— 直接 seek 与连续播放
  // 得到完全相同的画面，不依赖帧历史。
  // ------------------------------------------------------------------

  // 每条路径 = [x0,dx, y0,dy, s0,ds, r0,dr]：位姿 = 基准 + 增量×e（e 为行进度缓动）。
  var CAMERA_PATHS = {
    'editorial-column':  [-0.055, 0.095, 0.025, -0.04, 0.98, 0.07, -0.006, 0.01],
    'type-impact':       [-0.025, 0.05, 0.012, -0.02, 1, 0, -0.004, 0.008],
    'fragment-collage':  [-0.045, 0.085, 0.028, 0, 0.97, 0.09, -0.014, 0.028],
    'tracking-ribbon':   [-0.16, 0.28, 0.05, -0.085, 0.98, 0.07, 0.008, -0.014],
    'mask-reveal':       [0.035, -0.065, 0.1, -0.135, 0.96, 0.12, -0.006, 0.009],
    'poster-blocks':     [-0.012, 0.024, 0.008, -0.016, 0.99, 0.025, -0.0015, 0.003],
    'quiet-tableau':     [-0.022, 0.04, 0.014, -0.025, 1, 0.028, -0.002, 0.003]
  };

  // 镜头位姿：绝对时间函数 —— 同一时刻位姿恒定，直接 seek 与连续播放画面一致。
  function cameraPose(frame, tuning, kind, width, height, glyphs) {
    glyphs = glyphs || [];
    var p = clamp(num(frame.lineProgress, 0), 0, 1);
    var e = ease(p);
    var path = CAMERA_PATHS[kind] || CAMERA_PATHS['quiet-tableau'];
    var strength = amount(tuning.cameraIntensity, 1) * motionScale(tuning);
    var time = num(frame.playbackTime, 0) * Math.PI * 2;
    var breath = amount(tuning.cameraBreath, 0.5);
    var softness = amount(tuning.cameraSoftness, 0.75, 1);
    var focusX = width / 2, focusY = height / 2;
    if (glyphs.length) {
      var sigma = 0.18 + softness * 0.65;
      var t = num(frame.playbackTime, 0);
      var dist = function (d) { return Math.max(d.startTime - t, t - d.endTime, 0); };
      var nearest = Infinity;
      glyphs.forEach(function (node) { nearest = Math.min(nearest, dist(node.dataset)); });
      var total = 0, x = 0, y = 0;
      glyphs.forEach(function (node) {
        var d = node.dataset;
        var delta = dist(d);
        var w = Math.exp(-(delta * delta - nearest * nearest) / (2 * sigma * sigma));
        total += w;
        x += d.baseX * w;
        y += d.baseY * w;
      });
      if (total > 0) { focusX = x / total; focusY = y / total; }
    }
    var tracking = amount(tuning.cameraTracking, 0.35, 1);
    var start = frame.activeLine ? num(frame.activeLine.startTime, frame.playbackTime) : num(frame.playbackTime, 0);
    var nextStart = frame.nextLines && frame.nextLines[0] ? num(frame.nextLines[0].startTime, Infinity) : Infinity;
    var end = Math.min(frame.activeLine ? num(frame.activeLine.endTime, start) : start, nextStart);
    var ramp = Math.min(Math.max(0.001, (end - start) * 0.4), 0.45 + softness * 0.75);
    var envelope = ease((frame.playbackTime - start) / ramp) * ease((end - frame.playbackTime) / ramp);
    var travel = strength * envelope * (1 - softness * 0.4);
    var impact = clamp(num(tuning.performance && tuning.performance.impact, 0), 0, 1);
    // path = [x0, x1, y0, y1, s0, s1, r0, r1]；type-impact 的 scale 与
    // fragment-collage 的 y 走 sin 拱形而非线性。
    var dx = (path[0] + e * path[1]) * width * 0.35;
    var dyBase = path[2] + (kind === 'fragment-collage' ? -Math.sin(e * Math.PI) * 0.055 : e * path[3]);
    var dy = dyBase * height * 0.3;
    var sGain = kind === 'type-impact' ? Math.sin(e * Math.PI) * 0.055 : e * path[5];
    var rGain = path[6] + e * path[7];
    return {
      x: width / 2 + (dx - clamp(focusX - width / 2, -width * 0.12, width * 0.12) * tracking) * travel
        + Math.sin(time * 0.13) * width * 0.003 * breath * strength,
      y: height / 2 + (dy - clamp(focusY - height / 2, -height * 0.08, height * 0.08) * tracking) * travel
        + Math.cos(time * 0.11) * height * 0.003 * breath * strength,
      scale: 1 + (path[4] - 1 + sGain) * travel + impact * 0.035 * strength,
      rotation: (rGain * travel + impact * 0.012 * strength) * amount(tuning.cameraRoll, 0.25, 1)
    };
  }

  // ------------------------------------------------------------------
  // 排版：字素逐个成 Text 节点，词组边界断行，行宽收敛居中
  // ------------------------------------------------------------------

  function buildLyrics(PIXI, container, line, width, height, tuning, seed, fontStack) {
    container.removeChildren().forEach(function (c) { c.destroy({ children: true }); });
    container.position.set(0, 0);
    var kind = shotKind(seed, tuning);
    var random = seededRandom(seed);
    var fontSize = Math.min(width * 0.08, height * 0.12, 76) * amount(tuning.fontScale, 1, 1.5);
    var maxWidth = width * 0.68;
    var layout = tuning.lyricLayout || 'phrases';
    var rows = [[]];
    var rowWidth = 0;
    var glyphs = compilePhrases(line, tuning);
    var nodes = glyphs.map(function (glyph, index) {
      var node = new PIXI.Text({
        text: glyph.text,
        style: {
          fontFamily: fontStack,
          fontSize: fontSize, fontWeight: '800', fill: '#ffffff',
          stroke: { color: tuning.palette && tuning.palette.background || '#09090b',
            width: Math.max(1, fontSize * 0.025) }
        }
      });
      node.anchor.set(0.5);
      var advance = Math.max(fontSize * 0.18, node.width) + fontSize * 0.035;
      var row = rows[rows.length - 1];
      var phraseBreak = layout !== 'lines' && row.length
        && row[row.length - 1].dataset.phrase !== glyph.phrase;
      if ((rowWidth + advance > maxWidth || phraseBreak) && row.length) {
        rows.push([]);
        rowWidth = 0;
      }
      node.dataset = Object.assign({}, glyph, {
        advance: advance, rowX: rowWidth + advance / 2, index: index,
        angle: (random() - 0.5) * 0.18
      });
      rows[rows.length - 1].push(node);
      rowWidth += advance;
      container.addChild(node);
      return node;
    });
    var lineHeight = fontSize * 1.4;
    var fit = Math.min(1, height * 0.42 / Math.max(lineHeight, rows.length * lineHeight));
    rows.forEach(function (row, rowIndex) {
      var total = row.reduce(function (s, n) { return s + n.dataset.advance; }, 0);
      // 两种镜头给排版加不对称偏移：社论栏整体左移，碎片拼贴逐行错位。
      var shift = kind === 'editorial-column' ? -width * 0.04
        : kind === 'fragment-collage' ? (rowIndex % 2 ? 1 : -1) * width * 0.035 : 0;
      row.forEach(function (node) {
        var d = node.dataset;
        var alignment = layout === 'staircase' ? (rowIndex % 3 - 1) * width * 0.055 : 0;
        d.baseX = width / 2 + (d.rowX - total / 2) * fit + shift + alignment;
        d.baseY = height * 0.47 + (rowIndex - (rows.length - 1) / 2) * lineHeight * fit;
        d.fit = fit;
        d.fontSize = fontSize;
        node.position.set(d.baseX, d.baseY);
        node.scale.set(fit);
      });
    });
    return nodes;
  }

  // 行尾释放：normal 0.45s 缓退，fast 0.08s，micro 立即。
  function releaseOf(hints, tuning) {
    var mode = hints && hints.lineTransitionMode;
    if (mode === 'none') return 0;
    if (mode === 'fast') return 0.08;
    return amount(tuning.releaseDuration, 0.45, 1.5);
  }

  function animateLyrics(nodes, frame, tuning, color) {
    var strength = amount(tuning.typographyMotion, 1) * motionScale(tuning);
    var hints = (frame.activeLine && frame.activeLine.renderHints) || {};
    var style = hints.glyphStyle || tuning.glyphStyle || 'rise';
    var time = num(frame.playbackTime, 0);
    var release = releaseOf(hints, tuning);
    var lineEnd = num(frame.activeLine && frame.activeLine.vocalEndTime,
      num(frame.activeLine && frame.activeLine.endTime, Infinity));
    var renderEnd = num(hints.renderEndTime, lineEnd);
    var exitStart = Math.max(lineEnd, renderEnd - release);
    var exit = release > 0 ? ease((time - exitStart) / release) : (time > renderEnd ? 1 : 0);
    var performance = amount(tuning.performanceIntensity, 1.25) * strength;
    var phraseEmphasis = amount(tuning.phraseEmphasis, 0.4, 1);
    var ink = parseInt(String(tuning.palette && tuning.palette.ink || '#f4f4f5').slice(1), 16);
    nodes.forEach(function (node) {
      var d = node.dataset;
      var progress = clamp((time - d.startTime) / Math.max(0.04, d.endTime - d.startTime), 0, 1);
      // 进场：0.42s expo 衰减的「浮起」，唱中 sin 拱弹跳，行尾整体下沉退出。
      var entry = 1 - expo((time - d.startTime + 0.12) / 0.42);
      var active = time >= d.startTime && time < d.endTime;
      var bounce = active ? Math.sin(progress * Math.PI) : 0;
      var direction = d.index % 2 ? 1 : -1;
      node.position.set(
        d.baseX + (style === 'scatter' ? direction * entry * d.fontSize * 0.65 : 0) * strength
          - entry * d.fontSize * 0.45 * performance,
        d.baseY + (entry * d.fontSize * (style === 'scatter' ? direction : 1) * 0.65
          - bounce * d.fontSize * 0.08 - exit * d.fontSize * 0.35) * strength
      );
      node.rotation = style === 'scatter' ? d.angle * (entry + bounce) * strength : 0;
      var pop = style === 'impact' ? -entry * 0.38 + bounce * 0.2 : bounce * 0.1 - entry * 0.12;
      // 词组重音：起唱 0.48s 内一次 sin×exp 冲击（punch），带斜切。
      var phraseAge = time - d.phraseStart;
      var punch = phraseAge >= 0
        ? Math.sin(Math.min(1, phraseAge / 0.48) * Math.PI) * Math.exp(-phraseAge * 3) : 0;
      node.position.y -= punch * d.fontSize * 0.07 * performance;
      node.skew.x = entry * 0.16 * performance;
      node.scale.set(
        d.fit * Math.max(0.2, 1 + pop * strength + punch * 0.12 * performance),
        d.fit * Math.max(0.2, 1 + pop * strength - punch * 0.08 * performance)
      );
      // 词组聚焦：非当前词组压暗一半，注意力跟着语义单元走。
      var phraseWeight = ease((time - d.phraseStart + 0.3) / 0.3)
        * (1 - ease((time - d.phraseEnd) / 0.65));
      var focusAlpha = 1 - phraseEmphasis * 0.5 * (1 - phraseWeight);
      node.alpha = (time < d.startTime ? amount(tuning.waitingOpacity, 0.25, 1) : 1)
        * (1 - exit * 0.8) * focusAlpha;
      // 光栅保持白字，主题色在 GPU 上 tint：唱到的字素换 accent。
      node.tint = active && tuning.textInversion !== false ? color : ink;
    });
  }

  // ------------------------------------------------------------------
  // 词组舞台：每词组一套「显影遮罩 + 重音轨 + 角括 + 套印回声 + 射线」
  // ------------------------------------------------------------------

  function buildPhraseStage(PIXI, textContainer, nodes, color) {
    var groups = [];
    nodes.forEach(function (node) {
      var d = node.dataset;
      var group = groups[d.phrase];
      if (!group) {
        var root = new PIXI.Container();
        textContainer.addChild(root);
        group = groups[d.phrase] = { root: root, nodes: [], start: d.phraseStart, end: d.phraseEnd,
          left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
      }
      group.nodes.push(node);
      group.root.addChild(node);
      var margin = d.fontSize * d.fit;
      group.left = Math.min(group.left, d.baseX - d.advance * d.fit / 2 - margin * 0.25);
      group.right = Math.max(group.right, d.baseX + d.advance * d.fit / 2 + margin * 0.25);
      group.top = Math.min(group.top, d.baseY - margin * 0.85);
      group.bottom = Math.max(group.bottom, d.baseY + margin * 0.85);
    });
    groups.forEach(function (group) {
      if (!group) return;
      var width = group.right - group.left, height = group.bottom - group.top;
      // 显影遮罩：词组从左侧揭开的矩形 mask（ settles 后摘除，见 animate）。
      var mask = new PIXI.Graphics().rect(0, 0, width, height).fill(0xffffff);
      mask.position.set(group.left, group.top);
      textContainer.addChild(mask);
      group.root.mask = mask;
      group.mask = mask;
      var rail = new PIXI.Graphics().rect(0, 0, width, 3).fill({ color: color, alpha: 0.85 });
      rail.position.set(group.left, group.bottom - height * 0.12);
      textContainer.addChild(rail);
      group.rail = rail;
      var bracket = new PIXI.Graphics();
      bracket.moveTo(12, 0).lineTo(0, 0).lineTo(0, height);
      bracket.lineTo(12, height);
      bracket.moveTo(width - 12, 0).lineTo(width, 0).lineTo(width, height).lineTo(width - 12, height);
      bracket.stroke({ color: color, width: 1.4, alpha: 0.55 });
      bracket.position.set(group.left, group.top);
      textContainer.addChild(bracket);
      group.bracket = bracket;
      // 两层错位「套印」框与四根细射线：只在长词组起唱时短暂浮现。
      group.echoes = [0, 1].map(function (index) {
        var echo = new PIXI.Graphics().rect(-width / 2, -height / 2, width, height)
          .stroke({ color: color, width: index ? 1 : 2, alpha: 0.5 });
        echo.position.set((group.left + group.right) / 2, (group.top + group.bottom) / 2);
        textContainer.addChildAt(echo, 0);
        return echo;
      });
      var rays = new PIXI.Graphics();
      [-1, 1].forEach(function (side) {
        var x = side * (width / 2 + 10);
        rays.moveTo(x, -height * 0.23).lineTo(x + side * 22, -height * 0.38);
        rays.moveTo(x, height * 0.23).lineTo(x + side * 22, height * 0.38);
      });
      rays.stroke({ color: color, width: 1.3, alpha: 0.7 });
      textContainer.addChildAt(rays, 0);
      group.rays = rays;
    });
    return groups;
  }

  function animatePhraseStage(groups, frame, tuning, kind) {
    var time = num(frame.playbackTime, 0);
    var motion = motionScale(tuning);
    groups.forEach(function (group) {
      if (!group) return;
      // 揭开在人声起点前完成，绝不遮住正在唱的字。
      var enter = motion && tuning.sceneTransitions !== false
        ? expo((time - group.start + 0.45) / 0.45) : 1;
      var focus = ease((time - group.start + 0.25) / 0.25) * (1 - ease((time - group.end) / 0.55));
      var reveal = enter < 1 && tuning.quality !== 'energy-saving';
      group.root.mask = reveal ? group.mask : null;
      group.mask.visible = reveal;
      group.mask.scale.set(kind === 'mask-reveal' ? 1 : Math.max(0.001, enter),
        kind === 'mask-reveal' ? Math.max(0.001, enter) : 1);
      group.rail.scale.x = Math.max(0.001, enter);
      group.rail.alpha = focus * (0.3 + num(tuning.performance && tuning.performance.phrasePulse, 0) * 0.35);
      group.rail.visible = tuning.showDecor !== false;
      group.bracket.alpha = focus * 0.7;
      group.bracket.visible = tuning.showDecor !== false && tuning.guideLines !== false;
      var flourish = tuning.accentEffects !== false && tuning.showDecor !== false
        && tuning.quality !== 'energy-saving' && motion > 0;
      var strength = motion * amount(tuning.accentMotion, 1) * amount(tuning.performanceIntensity, 1.25);
      var duration = Math.max(0, group.end - group.start);
      var age = time - group.start;
      var tailAge = time - group.end;
      var pulse = age >= 0 && age < 0.8 ? Math.sin(age / 0.8 * Math.PI) * (1 - age / 0.8) : 0;
      // 只有长词组（≥1.5s）获得尾段回响，短促句保持安静排版。
      var tail = duration > 1.5 && tailAge >= 0 && tailAge < 0.65
        ? Math.sin(tailAge / 0.65 * Math.PI) * 0.45 : 0;
      var amplitude = Math.min(1, (pulse + tail) * strength);
      var cx = (group.left + group.right) / 2, cy = (group.top + group.bottom) / 2;
      group.echoes.forEach(function (echo, index) {
        echo.visible = flourish && duration >= 0.65 && amplitude > 0;
        var spread = (index + 1) * amplitude;
        echo.position.set(cx, cy - spread * 4);
        echo.scale.set(1 + spread * 0.07, 1 + spread * 0.15);
        echo.alpha = amplitude * (index ? 0.2 : 0.35);
      });
      group.rays.visible = flourish && duration >= 0.65 && amplitude > 0;
      group.rays.position.set(cx, cy);
      group.rays.scale.set(1 + amplitude * 0.14);
      group.rays.alpha = amplitude * 0.55;
    });
  }

  // ------------------------------------------------------------------
  // 重音编舞：对选点行的三个字素，各放 5 条对数螺线粒子尾迹汇聚到字上
  // ------------------------------------------------------------------

  function createAccentChoreography(PIXI, parent, nodes, color, seed) {
    var layer = new PIXI.Container();
    parent.addChild(layer);
    var random = seededRandom('accent:sonnet:' + seed);
    var eligible = nodes.filter(function (node) {
      return node.dataset.text.trim() && !/^[，。！？、,.!?;:：；]$/u.test(node.dataset.text);
    });
    // 只挑三个字素做落点，绝不做整行粒子发射器。
    var targets = eligible.filter(function (n, i) { return i >= Math.floor(eligible.length * 0.3); })
      .filter(function (n, i) { return i % Math.max(1, Math.floor(eligible.length / 3)) === 0; })
      .slice(0, 3);
    var particles = targets.flatMap(function (target, index) {
      var baseAngle = random() * Math.PI * 2;
      return Array.from({ length: 5 }, function (_, arm) {
        var trail = [];
        for (var j = 0; j < 18; j += 1) {
          var dot = new PIXI.Graphics().circle(0, 0, j === 0 ? 3.2 : 1.6).fill({ color: color, alpha: 1 });
          layer.addChild(dot);
          trail.push(dot);
        }
        return {
          target: target, trail: trail, index: index, arm: arm,
          angle: baseAngle + arm * Math.PI * 2 / 5 + (random() - 0.5) * 0.22,
          direction: arm % 2 ? -1 : 1,
          radiusScale: 0.8 + random() * 0.4,
          lead: 1.65 + arm * 0.13 + random() * 0.15
        };
      });
    });
    return {
      update: function (frame, tuning) {
        var strength = motionScale(tuning) * amount(tuning.accentMotion, 1);
        var track = (frame.track && (frame.track.path || frame.track.title)) || '';
        var enabled = tuning.accentEffects !== false && tuning.showDecor !== false && strength > 0
          && accentCues(frame.lines, 'sonnet:' + track).has(frame.currentLineIndex);
        layer.visible = enabled;
        if (!enabled) return;
        var time = num(frame.playbackTime, 0);
        var viewportSpan = Math.min(frame.viewport ? frame.viewport.width : 900,
          frame.viewport ? frame.viewport.height : 600);
        particles.forEach(function (pt) {
          var d = pt.target.dataset;
          // 汇聚在字素开唱后即刻到达，随后 7Hz 指数辉光衰减。
          var arrival = d.startTime + Math.min(0.12, (d.endTime - d.startTime) * 0.3);
          var duration = Math.min(pt.lead, Math.max(0.15, arrival - frame.activeLine.startTime));
          var p = (time - arrival + duration) / duration;
          var glow = p >= 1 ? Math.exp(-(time - arrival) * 7) : 0;
          if (pt.arm === 0 && glow > 0.01) {
            pt.target.tint = color;
            pt.target.scale.x *= 1 + glow * 0.07 * strength;
            pt.target.scale.y *= 1 + glow * 0.07 * strength;
          }
          pt.trail.forEach(function (dot, j) {
            var u = p - j * 0.014;
            var armBudget = tuning.quality === 'ultimate' ? 5
              : tuning.quality === 'energy-saving' ? 2 : 4;
            dot.visible = u >= 0 && u <= 1 && pt.arm < armBudget
              && (tuning.quality !== 'energy-saving' || (pt.index === 0 && j < 8));
            if (!dot.visible) return;
            var sweep = Math.PI * 2.6;
            var turn = (1 - u) * sweep;
            // 归一化对数螺线（黄金角增长率）：大视口小字号都收敛到字上。
            var growth = Math.log(1.618034) / (Math.PI / 2);
            var reach = Math.min(viewportSpan * 0.44, Math.max(130, d.fontSize * 4.2))
              * pt.radiusScale * Math.min(1.5, strength);
            var radius = (Math.exp(turn * growth) - 1) / (Math.exp(sweep * growth) - 1) * reach;
            dot.position.set(pt.target.x + Math.cos(pt.angle + turn * pt.direction) * radius,
              pt.target.y + Math.sin(pt.angle + turn * pt.direction) * radius * 0.86);
            dot.alpha = ease(u / 0.08) * (1 - j / pt.trail.length) * (pt.arm === 0 ? 0.8 : 0.55);
          });
        });
      },
      snapshot: function () {
        return { emitters: particles.length, targets: targets.length,
          particles: particles.reduce(function (s, p) { return s + p.trail.length; }, 0),
          visible: layer.visible };
      },
      destroy: function () {
        layer.removeFromParent();
        layer.destroy({ children: true });
      }
    };
  }

  // ------------------------------------------------------------------
  // 音频：谱通量起音检测（非节拍栅格 —— 瞬态只加冲击，绝不参与布景/镜头决策）
  // ------------------------------------------------------------------

  function createOnsetDetector() {
    var bins = new Float32Array(48);
    var lastTime = null, track = null, source = null, playing = false;
    var baseline = 0.02, energy = 0, hitAt = -Infinity, hitStrength = 0, hits = 0;
    var state = { impact: 0, energy: 0, time: 0, reset: true, onsets: 0 };
    var pulse = function (age) {
      return age >= 0 && age < 0.85 ? (1 - Math.exp(-age * 35)) * Math.exp(-age * 5) : 0;
    };
    return {
      update: function (frame) {
        var time = num(frame.playbackTime, 0);
        var identity = (frame.track && (frame.track.path || frame.track.title)) || '';
        var dt = lastTime === null ? 0 : time - lastTime;
        var reset = lastTime === null || identity !== track || source !== frame.lines
          || dt < -0.025 || dt > 0.5;
        var resumed = frame.isPlaying && !playing;
        var spectrum = (frame.audio && frame.audio.spectrum) || [];
        if (reset || resumed || (frame.isPlaying && dt > 0)) {
          var flux = 0;
          for (var i = 0; i < bins.length; i += 1) {
            var value = clamp(num(spectrum[Math.floor(i / bins.length * spectrum.length)], 0), 0, 1);
            flux += Math.max(0, value - bins[i]);
            bins[i] = value;
          }
          flux /= bins.length;
          if (reset || resumed) {
            baseline = 0.02;
            hitAt = -Infinity;
            hitStrength = 0;
            energy = clamp(num(frame.audio && frame.audio.power, 0), 0, 1);
          } else {
            energy += (clamp(num(frame.audio && frame.audio.power, 0), 0, 1) - energy)
              * (1 - Math.exp(-dt * 3));
            var threshold = Math.max(0.018, baseline * 1.8);
            if (flux > threshold && energy > 0.035 && time - hitAt > 0.38) {
              hitAt = time;
              hitStrength = clamp((flux - threshold) * 10 + 0.35, 0, 1);
              hits += 1;
            }
            baseline += (flux - baseline) * (1 - Math.exp(-dt * 1.8));
          }
        }
        state.impact = pulse(time - hitAt) * hitStrength;
        state.energy = energy;
        state.time = time;
        state.reset = reset;
        state.onsets = hits;
        lastTime = time;
        track = identity;
        source = frame.lines;
        playing = Boolean(frame.isPlaying);
        return state;
      },
      snapshot: function () { return Object.assign({}, state, { historyBins: bins.length }); },
      reset: function () { lastTime = null; hitAt = -Infinity; bins.fill(0); }
    };
  }

  function createPerformance() {
    var onset = createOnsetDetector();
    var state = { impact: 0, phrasePulse: 0, energy: 0, phrase: -1, time: 0, reset: true };
    return {
      update: function (frame, tuning, nodes) {
        var time = num(frame.playbackTime, 0);
        var live = onset.update(frame);
        var phrase = -1, phraseStart = -Infinity;
        nodes.forEach(function (node) {
          var d = node.dataset;
          if (d.phraseStart <= time && d.phraseStart > phraseStart) {
            phraseStart = d.phraseStart;
            phrase = d.phrase;
          }
        });
        var pulse = phraseStart > -Infinity && time - phraseStart >= 0 && time - phraseStart < 0.85
          ? (1 - Math.exp(-(time - phraseStart) * 35)) * Math.exp(-(time - phraseStart) * 5) : 0;
        var strength = motionScale(tuning) * amount(tuning.performanceIntensity, 1.25);
        state.phrasePulse = pulse * strength;
        state.impact = clamp(live.impact * amount(tuning.beatImpact, 1.15) * strength
          + state.phrasePulse * 0.45, 0, 1);
        state.energy = live.energy;
        state.phrase = phrase;
        state.time = time;
        state.reset = live.reset;
        return state;
      },
      snapshot: function () {
        return Object.assign({}, state, onset.snapshot());
      },
      reset: function () { onset.reset(); }
    };
  }

  // 频谱 → 五段均值 + 总功率（一段一次遍历）。
  function resolveAudioBands(spectrum) {
    var values = spectrum || [];
    if (!values.length) {
      return { power: 0, bass: 0, lowMid: 0, mid: 0, vocal: 0, treble: 0, spectrum: values };
    }
    var length = values.length;
    var ranges = [
      [Math.floor(length * 0.01), Math.max(1, Math.ceil(length * 0.10))],
      [Math.floor(length * 0.10), Math.max(Math.floor(length * 0.10) + 1, Math.ceil(length * 0.24))],
      [Math.floor(length * 0.24), Math.max(Math.floor(length * 0.24) + 1, Math.ceil(length * 0.46))],
      [Math.floor(length * 0.18), Math.max(Math.floor(length * 0.18) + 1, Math.ceil(length * 0.58))],
      [Math.floor(length * 0.58), Math.max(Math.floor(length * 0.58) + 1, Math.ceil(length * 0.98))]
    ];
    var totals = [0, 0, 0, 0, 0];
    for (var i = 0; i < length; i += 1) {
      var v = num(values[i], 0);
      for (var b = 0; b < ranges.length; b += 1) {
        if (i >= ranges[b][0] && i < ranges[b][1]) totals[b] += v;
      }
    }
    var avg = totals.map(function (t, b) {
      return clamp(t / Math.max(1, ranges[b][1] - ranges[b][0]), 0, 1);
    });
    var power = clamp(avg[0] * 0.25 + avg[1] * 0.2 + avg[2] * 0.2 + avg[3] * 0.25 + avg[4] * 0.1, 0, 1);
    return { power: power, bass: avg[0], lowMid: avg[1], mid: avg[2], vocal: avg[3], treble: avg[4],
      spectrum: values };
  }

  // ------------------------------------------------------------------
  // 分辨率预算：eco 720p 上限，常规 1080p×1.5，DPR 钳 2
  // ------------------------------------------------------------------

  function applyQuality(app, width, height, quality) {
    var budget = quality === 'ultimate' ? 3840 * 2160
      : quality === 'energy-saving' ? 1280 * 720 : 1920 * 1080 * 1.5;
    var cap = quality === 'energy-saving' ? 1 : Math.min(2, (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1) || 1);
    var resolution = Math.max(0.25, Math.min(cap, Math.sqrt(budget / Math.max(1, width * height))));
    if (Math.abs(app.renderer.resolution - resolution) > 0.01) {
      app.renderer.resize(width, height, resolution);
    }
  }

  // ------------------------------------------------------------------
  // 光学印相后期：桶形畸变 + 径向色散 + 网点半调 + 颗粒 + 暗角混纸色。
  // 自写 GLSL（v8 in/out 语法），只对舞台根挂一次 filter。
  // ------------------------------------------------------------------

  var OPTICAL_VS = [
    'in vec2 aPosition;',
    'out vec2 vTextureCoord;',
    'uniform vec4 uInputSize;',
    'uniform vec4 uOutputFrame;',
    'uniform vec4 uOutputTexture;',
    'void main() {',
    '  vec2 p = aPosition * uOutputFrame.zw + uOutputFrame.xy;',
    '  p.x = p.x * (2.0 / uOutputTexture.x) - 1.0;',
    '  p.y = p.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;',
    '  gl_Position = vec4(p, 0.0, 1.0);',
    '  vTextureCoord = aPosition * uOutputFrame.zw * uInputSize.zw;',
    '}'
  ].join('\n');

  var OPTICAL_FS = [
    'in vec2 vTextureCoord;',
    'out vec4 finalColor;',
    'uniform sampler2D uTexture;',
    'uniform highp vec4 uInputSize;',
    'uniform vec4 uInputClamp;',
    'uniform highp vec4 uOutputFrame;',
    'uniform float uDistortion;',
    'uniform float uDispersion;',
    'uniform float uGrain;',
    'uniform float uContrast;',
    'uniform float uHalftone;',
    'uniform float uVignette;',
    'uniform float uTime;',
    'uniform vec3 uPaper;',
    'vec4 sampleInside(vec2 uv) {',
    '  if (uv.x < uInputClamp.x || uv.y < uInputClamp.y || uv.x > uInputClamp.z || uv.y > uInputClamp.w) return vec4(0.0);',
    '  return texture(uTexture, uv);',
    '}',
    // 三通道错位旋转网点（15°/75°/0°），半径随亮度开方 —— 经典印相半调。
    'float screenDot(vec2 p, float a, float v) {',
    '  float c = cos(a), s = sin(a);',
    '  vec2 q = mat2(c, s, -s, c) * p;',
    '  float d = length(fract(q / 5.0) - 0.5) * 5.0;',
    '  float r = sqrt(clamp(v, 0.0, 1.0)) * 3.1;',
    '  return 1.0 - smoothstep(r - 1.2, r + 1.2, d);',
    '}',
    'void main() {',
    '  vec2 screenUv = vTextureCoord * uInputSize.xy / max(uOutputFrame.zw, vec2(1.0));',
    '  vec2 centered = screenUv - 0.5;',
    '  float aspect = uOutputFrame.z / max(uOutputFrame.w, 1.0);',
    '  centered.x *= aspect;',
    '  float r2 = dot(centered, centered);',
    // 桶形畸变：径向二次收缩 + 轻微四次回补。
    '  float curve = uDistortion * 0.32;',
    '  vec2 warped = centered * (1.0 - curve * r2 + curve * 0.16 * r2 * r2);',
    '  warped.x /= aspect;',
    '  vec2 uv = (warped + 0.5) * uOutputFrame.zw * uInputSize.zw;',
    '  float radius = sqrt(r2);',
    '  vec2 dispersion = radius > 0.0001 ? centered / radius : vec2(0.0);',
    '  dispersion *= uDispersion * 0.012 * smoothstep(0.12, 0.9, radius);',
    '  dispersion.x /= aspect;',
    '  vec2 offset = dispersion * uOutputFrame.zw * uInputSize.zw;',
    '  vec4 center = sampleInside(uv);',
    '  vec4 red = sampleInside(uv + offset);',
    '  vec4 blue = sampleInside(uv - offset);',
    '  float alpha = max(center.a, max(red.a, blue.a));',
    '  vec3 rgb = max(center.rgb * (0.84 - clamp(uDispersion, 0.0, 1.0) * 0.18), vec3(red.r, center.g, blue.b));',
    '  if (alpha > 0.0001) rgb /= alpha;',
    '  rgb = clamp((rgb - 0.5) * (1.0 + uContrast * 0.5) + 0.5, 0.0, 1.0);',
    '  vec2 frag = gl_FragCoord.xy;',
    '  vec3 dots = vec3(screenDot(frag, 0.2618, rgb.r), screenDot(frag, 1.3090, rgb.g), screenDot(frag, 0.0, rgb.b));',
    '  rgb = mix(rgb, dots, uHalftone);',
    // 24fps 翻页颗粒：hash 噪声按帧步进，不逐帧连续抖动。
    '  float noise = fract(sin(dot(frag + floor(uTime * 24.0), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;',
    '  rgb = clamp(rgb + noise * uGrain * 0.18, 0.0, 1.0);',
    '  vec4 color = vec4(rgb * alpha, alpha);',
    '  float vignette = smoothstep(0.52, 1.08, radius) * uVignette * 0.6;',
    '  finalColor = mix(color, vec4(uPaper, 1.0), vignette);',
    '}'
  ].join('\n');

  function createPostProcess(PIXI, stage) {
    var descriptors = {};
    ['Distortion', 'Dispersion', 'Grain', 'Contrast', 'Halftone', 'Vignette', 'Time']
      .forEach(function (key) { descriptors['u' + key] = { value: 0, type: 'f32' }; });
    descriptors.uPaper = { value: new Float32Array([0, 0, 0]), type: 'vec3<f32>' };
    var uniforms = new PIXI.UniformGroup(descriptors);
    var filter = new PIXI.Filter({
      glProgram: PIXI.GlProgram.from({ vertex: OPTICAL_VS, fragment: OPTICAL_FS, name: 'hertz-sonnet-optical-print' }),
      resources: { opticalUniforms: uniforms },
      antialias: 'on'
    });
    return {
      update: function (frame, tuning, width, height) {
        var kick = motionScale(tuning) * amount(tuning.opticalImpact, 0.65, 1)
          * clamp(num(tuning.performance && tuning.performance.impact, 0), 0, 1);
        var values = {
          Distortion: amount(tuning.lensDistortion, 0.35),
          Dispersion: clamp(amount(tuning.lensDispersion, 0.18, 1) + kick * 0.45, 0, 1),
          Grain: amount(tuning.grain, 0, 1),
          Contrast: amount(tuning.contrast, 0, 1),
          Halftone: amount(tuning.halftone, 0, 1),
          Vignette: amount(tuning.vignette, 0.18, 1)
        };
        var enabled = tuning.postProcess !== false && tuning.quality !== 'energy-saving'
          && Object.keys(values).some(function (k) { return values[k] > 0; });
        stage.filters = enabled ? [filter] : null;
        if (!enabled) return;
        if (!stage.filterArea) stage.filterArea = new PIXI.Rectangle();
        stage.filterArea.x = 0;
        stage.filterArea.y = 0;
        stage.filterArea.width = width;
        stage.filterArea.height = height;
        Object.keys(values).forEach(function (key) { uniforms.uniforms['u' + key] = values[key]; });
        uniforms.uniforms.uTime = num(frame.playbackTime, 0);
        var paper = String((tuning.palette && tuning.palette.background) || '#09090b');
        var n = parseInt(paper.slice(1), 16) || 0;
        uniforms.uniforms.uPaper.set([(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]);
      },
      destroy: function () { stage.filters = null; filter.destroy(); }
    };
  }

  // ------------------------------------------------------------------
  // 退场溶解：切句瞬间把上一句的背景几何整体搬走，按行时长快速淡出。
  // 只在「无缝衔接」（下一行 0.2s 内起唱）时触发；seek/切歌立即作废。
  // ------------------------------------------------------------------

  function createRetirement(PIXI, stage) {
    var duration = 0.6;
    var layer = null, born = 0, lastFrame = null, lastTuning = null, outgoingLine = null;
    function release() {
      if (layer) { layer.removeFromParent(); layer.destroy({ children: true }); layer = null; }
    }
    return {
      capture: function (containers, scene, nextLine) {
        release();
        var frame = lastFrame, tuning = lastTuning;
        if (!frame || !frame.isPlaying || !nextLine || !frame.activeLine
          || nextLine === frame.activeLine || !motionScale(tuning)
          || tuning.sceneTransitions === false || tuning.quality === 'energy-saving'
          || (nextLine.renderHints && nextLine.renderHints.lineTransitionMode === 'none')
          || nextLine.startTime < frame.playbackTime
          || nextLine.startTime - frame.playbackTime > 0.2) return;
        layer = new PIXI.Container();
        layer.position.copyFrom(scene.position);
        layer.pivot.copyFrom(scene.pivot);
        layer.scale.copyFrom(scene.scale);
        layer.rotation = scene.rotation;
        containers.forEach(function (container) {
          if (!container.visible) return;
          var copy = new PIXI.Container();
          copy.position.copyFrom(container.position);
          copy.pivot.copyFrom(container.pivot);
          copy.scale.copyFrom(container.scale);
          copy.rotation = container.rotation;
          copy.alpha = container.alpha;
          container.removeChildren().forEach(function (child) { copy.addChild(child); });
          layer.addChild(copy);
        });
        stage.addChildAt(layer, 0);
        var hints = nextLine.renderHints || {};
        duration = hints.lineTransitionMode === 'fast' ? 0.12
          : clamp((nextLine.endTime - nextLine.startTime) * 0.3, 0.12, 0.8);
        born = nextLine.startTime;
        outgoingLine = nextLine;
      },
      update: function (frame, tuning) {
        var incoming = 1;
        if (layer) {
          var elapsed = frame.playbackTime - born;
          var trackOf = function (f) { return (f && f.track && (f.track.path || f.track.title)) || ''; };
          var changedTrack = lastFrame && trackOf(frame) !== trackOf(lastFrame);
          var jumped = lastFrame && (frame.playbackTime - lastFrame.playbackTime > 0.5
            || frame.playbackTime < lastFrame.playbackTime - 0.025);
          if (elapsed < 0 || elapsed >= duration || frame.activeLine !== outgoingLine
            || changedTrack || jumped
            || (lastFrame && frame.lines !== lastFrame.lines)
            || (lastTuning && (tuning.showBackground !== lastTuning.showBackground
              || tuning.guideLines !== lastTuning.guideLines
              || tuning.lyricLayout !== lastTuning.lyricLayout))
            || !motionScale(tuning) || tuning.sceneTransitions === false
            || tuning.quality === 'energy-saving') {
            release();
          } else {
            var p = ease(elapsed / duration);
            layer.alpha = 1 - p;
            incoming = p;
          }
        }
        lastFrame = frame;
        lastTuning = tuning;
        return incoming;
      },
      snapshot: function () { return { outgoingLayers: layer ? 1 : 0 }; },
      destroy: function () { release(); lastFrame = lastTuning = outgoingLine = null; }
    };
  }

  // ------------------------------------------------------------------
  // 装饰母题：种子抽 4 类线稿（轨道椭圆组 / 柱状谱 / 山形折线 / 花瓣曲线）
  // ------------------------------------------------------------------

  function buildMotif(PIXI, container, width, height, color, seed) {
    var random = seededRandom('motif:' + seed);
    var kind = Math.floor(random() * 4);
    var graphic = new PIXI.Graphics();
    var cx = width * 0.5, cy = height * 0.46;
    var r = Math.min(width, height) * 0.32;
    var i, x, y, h, a;
    if (kind === 0) {
      for (i = 0; i < 7; i += 1) {
        a = i / 7 * Math.PI * 2;
        graphic.ellipse(cx, cy, r, r * (0.22 + i * 0.08));
        graphic.circle(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.45, 3 + i);
      }
    } else if (kind === 1) {
      for (i = -7; i <= 7; i += 1) {
        x = cx + i * r / 7;
        h = (0.2 + random() * 0.8) * r;
        graphic.rect(x, cy - h / 2, r * 0.06, h);
        graphic.moveTo(x, cy + r * 0.7).lineTo(x, cy + r * 0.8);
      }
    } else if (kind === 2) {
      for (i = 0; i < 8; i += 1) {
        y = cy - r + i * r * 0.27;
        graphic.moveTo(cx - r, y).lineTo(cx, y - r * 0.25).lineTo(cx + r, y);
        graphic.moveTo(cx - r + i * r * 0.28, cy - r).lineTo(cx - r + i * r * 0.28, cy + r);
      }
    } else {
      for (i = 0; i < 12; i += 1) {
        a = i * Math.PI / 6;
        x = cx + Math.cos(a) * r; y = cy + Math.sin(a) * r;
        graphic.moveTo(cx, cy).quadraticCurveTo(x, cy, x, y).quadraticCurveTo(cx, y, cx, cy);
      }
    }
    graphic.stroke({ color: color, width: 1.2, alpha: 0.22 });
    container.addChild(graphic);
    return graphic;
  }

  return {
    // 常量与枚举（验证脚本用）
    SHOT_KINDS: SHOT_KINDS, SCENE_KINDS: SCENE_KINDS, CAMERA_PATHS: CAMERA_PATHS,
    // 纯函数
    num: num, clamp: clamp, amount: amount, ease: ease, expo: expo,
    hashString: hashString, seededRandom: seededRandom,
    shotKind: shotKind, sceneKind: sceneKind, motionScale: motionScale,
    buildGlyphTimeline: buildGlyphTimeline, compilePhrases: compilePhrases,
    accentCues: accentCues, computeAccentCues: computeAccentCues,
    cameraPose: cameraPose, releaseOf: releaseOf, resolveAudioBands: resolveAudioBands,
    // PIXI 注入式构建/驱动
    buildLyrics: buildLyrics, animateLyrics: animateLyrics,
    buildPhraseStage: buildPhraseStage, animatePhraseStage: animatePhraseStage,
    createAccentChoreography: createAccentChoreography,
    createOnsetDetector: createOnsetDetector, createPerformance: createPerformance,
    applyQuality: applyQuality, createPostProcess: createPostProcess,
    createRetirement: createRetirement, buildMotif: buildMotif
  };
});
