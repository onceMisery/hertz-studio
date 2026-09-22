// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 三维歌词图集（lyric3d）。
//
// 这个模块不碰 WebGL：它只负责把「当前行 + 前后各几句」绘制到一张 2D 画布
// （图集 / atlas）上，creative-gl.js 的 lyric 场景每帧把它作为一张普通纹理
// 采样。把文字光栅化和三维渲染拆成两层的理由：
//
//   1. canvas2D 的 fillText 是浏览器里唯一零依赖、自带中文字体回退、零构建
//      的文字光栅化路径；在 GLSL 里用 SDF 字形需要额外的字体解析与字形打包，
//      违背本项目「零运行时依赖、单 exe 分发」的契约。
//   2. 图集绝大多数帧是静止的——只有当前行变化时才重画。GL 侧只在 changed
//      时做一次 texSubImage2D，每帧成本与画一个 quad 相同。
//
// 图集布局：CELLS 个等宽横向条带纵向排列，第 MID 条是当前行。每个条带的
// 世界几何（一张面片）固定，歌词前进时只换条带里的文字，不做几何滚动 ——
// 「穿行」的运动感由面片在三维空间的排布与镜头共同完成（见 creative-gl 的
// lyric 场景）。

(function () {
  'use strict';

  var CELLS = 9;           // 可见句数（奇数，当前行居中）
  var MID = 4;
  var ATLAS_W = 1024;
  var CELL_H = 192;        // 单条带高；条带宽高比 = 1024/192 ≈ 5.33
  var ATLAS_H = CELLS * CELL_H;
  var MAX_TEXT_W = ATLAS_W - 104;   // 两侧各留 52px 安全边
  var quality = 2;

  var ATLAS_WIDTHS = [512, 768, 1024];
  var CELL_HEIGHTS = [96, 144, 192];

  // 中文字体走系统栈，不内嵌字体文件（契约：单 exe 体积与零构建）。
  var FONT_STACK = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", '
    + '"Hiragino Sans GB", system-ui, sans-serif';

  var canvas = document.createElement('canvas');
  canvas.width = ATLAS_W;
  canvas.height = ATLAS_H;
  var ctx = canvas.getContext('2d');

  // 帧签名：index + 九格文本 + 有无歌词。相同就跳过重画。
  var lastSig = '';

  function setQuality(q) {
    var next = Number(q);
    if (!isFinite(next)) next = 2;
    next = next < 0 ? 0 : next > 2 ? 2 : next | 0;
    if (next === quality) return;

    quality = next;
    ATLAS_W = ATLAS_WIDTHS[next];
    CELL_H = CELL_HEIGHTS[next];
    ATLAS_H = CELLS * CELL_H;
    MAX_TEXT_W = ATLAS_W - Math.round(ATLAS_W * 0.10);
    canvas.width = ATLAS_W;
    canvas.height = ATLAS_H;
    lastSig = '';
  }

  function textOf(lyric, lineIdx) {
    if (!lyric || !lyric.lines) return '';
    var ln = lyric.lines[lineIdx];
    return ln ? String(ln.text == null ? '' : ln.text) : '';
  }

  // 从大字号往下试，直到一行放得下。长句靠缩字号而不是换行 —— 三维空间里
  // 两行文字的面片高度会破坏等距排布。
  function fitFont(weight, startSize, text) {
    var size = startSize;
    while (size > 24) {
      ctx.font = weight + ' ' + size + 'px ' + FONT_STACK;
      if (ctx.measureText(text).width <= MAX_TEXT_W) break;
      size -= 2;
    }
    return size;
  }

  function drawCell(cell, text, active) {
    var cy = cell * CELL_H + CELL_H / 2;
    if (!text) return;
    if (active) {
      // 当前行：白、粗、带白晕。白晕是烘进图集的——它同时承担两个职责：
      // 好看的发光，以及让亮度越过后处理的泛光阈值（bloomThresh 默认 0.58）。
      // 晕不能大：密集长句在粗分辨率泛光链里会被糊成一整条白棒，字形全失。
      // 粗体 + 大字号在密集中文长句上会把字怀（笔画间隙）全部堵死，
      // 远看就是一整条实心棒。600 重 + 72px 既保住"当前行"的分量，
      // 又留得出字形内部的呼吸。
      var s1 = fitFont(600, Math.round(CELL_H * 0.375), text);
      ctx.font = '600 ' + s1 + 'px ' + FONT_STACK;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(255,255,255,0.4)';
      ctx.shadowBlur = 8;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, ATLAS_W / 2, cy);
      // 无 shadow 再描一遍实心字：shadow 在字芯下会让字形发虚。
      ctx.shadowBlur = 0;
      ctx.fillText(text, ATLAS_W / 2, cy);
    } else {
      // 周边句：暗蓝灰、轻晕。亮度刻意压低，着色器再按距离乘衰减，
      // 保证视觉焦点永远在当前行。
      var s2 = fitFont(500, Math.round(CELL_H * 0.28125), text);
      ctx.font = '500 ' + s2 + 'px ' + FONT_STACK;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(120,140,180,0.5)';
      ctx.shadowBlur = 10;
      ctx.fillStyle = 'rgba(176,188,210,0.9)';
      ctx.fillText(text, ATLAS_W / 2, cy);
      ctx.shadowBlur = 0;
    }
  }

  // 计算一帧的签名：九格实际可见文本 + 起始行。签名只取决于歌词快照本身，
  // 与图集当前画了什么无关——每个 GL 引擎拿它和自己纹理里装的内容比对。
  function signature(lyric) {
    var index = lyric && (lyric.index | 0);
    if (!lyric || !lyric.lines || !lyric.lines.length || index == null || index < 0) {
      index = -1;
    }

    var parts = new Array(CELLS + 1);
    parts[0] = String(index);
    for (var c = 0; c < CELLS; c += 1) {
      parts[c + 1] = index < 0 ? '' : textOf(lyric, index + c - MID);
    }
    return { sig: parts.join('\u001f'), index: index };
  }

  // lyric = { lines: [{start_ms, text}], index } 或 null。
  // force=true 时跳过去重：图集可能已被另一个引擎改成其它歌词，即使本帧签名
  // 与上次相同，也要把图集重画成调用方要的内容。
  // 返回 true 表示图集像素本帧发生了变化（GL 侧需要 texSubImage2D）。
  function frame(lyric, force) {
    var r = signature(lyric);
    var index = r.index;
    if (!force && r.sig === lastSig) return false;
    lastSig = r.sig;

    ctx.clearRect(0, 0, ATLAS_W, ATLAS_H);

    if (index < 0) {
      // 无歌词（纯音乐 / 歌词未加载）：当前格放一对音符，场景仍然成立，
      // 不会出现「切进三维歌词却空空荡荡」的空窗。
      drawCell(MID, '♪ ♪', true);
      return true;
    }

    for (var cell = 0; cell < CELLS; cell += 1) {
      var lineIdx = index + cell - MID;
      if (lineIdx < 0 || lineIdx >= lyric.lines.length) continue;
      drawCell(cell, textOf(lyric, lineIdx), cell === MID);
    }
    return true;
  }

  window.Lyric3D = {
    frame: frame,
    setQuality: setQuality,
    sig: function (lyric) { return signature(lyric).sig; },
    canvas: canvas,
    size: function () {
      return { w: ATLAS_W, h: ATLAS_H, cells: CELLS, cellH: CELL_H, mid: MID, quality: quality };
    }
  };
})();
