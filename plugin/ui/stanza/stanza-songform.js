// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// 曲式层：把整首歌的歌词一次性编译成「段落 / 副歌 / 句内画像」，并定义每种歌词模式的镜头语法。
//
// 为什么要这一层：导演若只盯着「当前这一句」的文本与频谱，得到的必然是按行号轮播的随机换片 ——
// 副歌听不出比主歌更隆重，一句的呼吸感也没有。上游项目在同一个坑里摔过，结论写在出处里
// （见 NOTICE「Design lineage」）：结构决定画面与运镜，音频只在结构选定的镜头里调幅度。
// 所以这里产出的全是整首歌级别的确定性事实，导演与渲染器各自消费，谁都不再逐帧猜测。
//
// 硬约束：本模块是纯函数，输入只有歌词行与时间，不读全局、不累积状态。任意 t 的读数必须与
// 「怎么到达 t」无关 —— 直接 seek 到句中拿到的结果，和顺着播到那里逐帧推进得到的完全一致。
// 这条同时让导演层能在 Node 沙箱里被契约脚本验证，不必起浏览器。
(function (root, factory) {
  var api = factory(root.StanzaUtil);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StanzaSongForm = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (U) {
  'use strict';

  function num(v, f) { v = Number(v); return isFinite(v) ? v : f; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function ease(v) { var t = clamp(v, 0, 1); return t * t * (3 - 2 * t); }

  // 段落切分的间隙阈值按整首歌的间隙中位数自适应，而不是拍一个常数：
  // 说唱的句间空隙本来就比钢琴曲短，固定阈值会把前者切得稀碎、把后者糊成一坨。
  var GAP_MULTIPLIER = 2.5;
  var GAP_MIN = 1.25, GAP_MAX = 3.5;
  var PARA_MAX_LINES = 6, PARA_MAX_SECONDS = 18;
  // 副歌块识别的门槛：同样的连续两行至少隔 4 行、12 秒再出现，才敢认是副歌而不是巧合同一句。
  var CHORUS_MIN_INDEX_GAP = 4, CHORUS_MIN_TIME_GAP = 12, CHORUS_MAX_BLOCK = 12;
  var INSTRUMENTAL_GAP = 6;

  var KINDS = {
    breath: { openness: 0.20, intensity: 0.15 },
    verse: { openness: 0.40, intensity: 0.42 },
    lift: { openness: 0.75, intensity: 0.72 },
    chorus: { openness: 1.00, intensity: 1.00 },
    outro: { openness: 0.50, intensity: 0.30 }
  };

  var STRONG_RE = /[!?！？…—]/g;
  var ANY_PUNCT_RE = /[!?！？…—,，.。;；:：]/g;
  var READABLE_RE = /[\p{L}\p{N}]/u;

  // 副歌识别用的归一化：只留字母与数字，大小写、标点、空白全抹掉。
  // 「同一句副歌带不带逗号」在真实歌词里太常见，不归一就会漏判。
  function normalize(text) {
    var s = String(text == null ? '' : text).toLowerCase();
    var out = '';
    for (var i = 0; i < s.length; i++) {
      if (READABLE_RE.test(s.charAt(i))) out += s.charAt(i);
    }
    return out;
  }

  // 这一行实际唱到什么时候为止。逐字时间轴存在时末字往往比行尾 end_ms 更晚；
  // 只信 end_ms 会把保护人声区间算短，切镜就可能砸在还没唱完的字上。
  function vocalEndOf(rec, tokens) {
    var end = rec.end;
    if (tokens && tokens.length) {
      for (var i = 0; i < tokens.length; i++) {
        var t = num(tokens[i].end_ms, num(tokens[i].start_ms, 0)) / 1000;
        if (t > end) end = t;
      }
    }
    return end;
  }

  function firstSpeechStart(rec, tokens) {
    if (!tokens || !tokens.length) return rec.start;
    var best = Infinity;
    for (var i = 0; i < tokens.length; i++) {
      var s = num(tokens[i].start_ms, NaN) / 1000;
      if (isFinite(s) && s < best) best = s;
    }
    // 只信比行首更晚的读数：歌词源的 token 偶尔整体早于本行 start_ms（重叠行），
    // 那种情况下「提前切」会切进上一句的尾巴。
    return isFinite(best) && best > rec.start ? best : rec.start;
  }

  // 句内画像。只有歌词源真给了逐字时间轴才可信 —— 插值出来的 token 时长是按字数线性摊的，
  // maxNote/avgNote 恒等于均分，拿它当「断奏/拖腔」证据等于拿假数据投票。
  function noteProfile(tokens, trusted) {
    var p = { noteCount: 0, maxNote: 0, avgNote: 0, staccato: false, longNote: false, trusted: !!trusted };
    if (!trusted || !tokens || tokens.length < 2) return p;
    var sum = 0, max = 0, n = 0;
    for (var i = 0; i < tokens.length; i++) {
      var s = num(tokens[i].start_ms, NaN), e = num(tokens[i].end_ms, NaN);
      if (!isFinite(s) || !isFinite(e) || e <= s) continue;
      var d = (e - s) / 1000;
      sum += d; n += 1; if (d > max) max = d;
    }
    if (!n) return p;
    p.noteCount = n; p.maxNote = max; p.avgNote = sum / n;
    p.staccato = n >= 4 && p.avgNote > 0 && p.avgNote <= 0.34;
    p.longNote = max >= 1.3;
    return p;
  }

  function buildRecords(lines, tokensOf) {
    var recs = [];
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i] || {};
      var start = num(raw.start_ms, 0) / 1000;
      var nextStart = i + 1 < lines.length ? num(lines[i + 1].start_ms, NaN) / 1000 : NaN;
      var end = num(raw.end_ms, NaN) / 1000;
      if (!isFinite(end) || end <= start) {
        end = isFinite(nextStart) && nextStart > start ? nextStart : start + 3;
      }
      var text = String(raw.text == null ? '' : raw.text);
      var tokens = tokensOf ? tokensOf(raw) : null;
      var trusted = !!(tokens && tokens.wordLevel);
      var strong = (text.match(STRONG_RE) || []).length;
      var rec = {
        index: i, text: text, start: start, end: end,
        chars: U ? U.graphemes(text).filter(function (c) { return c.trim(); }).length : text.length,
        marks: strong,
        puncts: Math.max(0, (text.match(ANY_PUNCT_RE) || []).length - strong),
        words: tokens ? tokens.length : 0,
        profile: noteProfile(tokens, trusted)
      };
      rec.vocalEnd = vocalEndOf(rec, tokens);
      // 起唱时刻：真正发出第一个字的时刻。逐字时间轴可信时才取，否则等于行首。
      // 导演用它决定切镜窗口 —— 前奏留白长的句子，允许在更早的区间里下刀，
      // 而不是死守「行首 120ms」把带长前奏的段落整段错过。
      rec.speechStart = firstSpeechStart(rec, tokens);
      rec.gapBefore = i === 0 ? start : Math.max(0, start - recs[i - 1].vocalEnd);
      recs.push(rec);
    }
    return recs;
  }

  function median(values) {
    if (!values.length) return 0;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function gapThreshold(recs) {
    var gaps = [];
    for (var i = 1; i < recs.length; i++) gaps.push(recs[i].gapBefore);
    return clamp(median(gaps) * GAP_MULTIPLIER, GAP_MIN, GAP_MAX);
  }

  // 在 [from,to) 这段连续行里找内部最大的间隙并在其后劈开 —— 只在句间下刀，绝不切断正在唱的行。
  function largestGapCut(recs, from, to) {
    var best = -1, bestGap = -Infinity;
    for (var i = from + 1; i < to; i++) {
      if (recs[i].gapBefore > bestGap) { bestGap = recs[i].gapBefore; best = i; }
    }
    return best > from && best < to ? best : -1;
  }

  function groupParagraphs(recs, threshold) {
    var starts = [0];
    for (var i = 1; i < recs.length; i++) if (recs[i].gapBefore >= threshold) starts.push(i);
    var groups = [];
    var push = function (from, to) {
      if (to - from <= 0) return;
      var span = recs[to - 1].vocalEnd - recs[from].start;
      if (to - from > PARA_MAX_LINES || span > PARA_MAX_SECONDS) {
        var cut = largestGapCut(recs, from, to);
        if (cut > 0) { push(from, cut); push(cut, to); return; }
      }
      groups.push({ startLine: from, endLine: to - 1 });
    };
    for (var g = 0; g < starts.length; g++) {
      push(starts[g], g + 1 < starts.length ? starts[g + 1] : recs.length);
    }
    if (!groups.length && recs.length) groups.push({ startLine: 0, endLine: recs.length - 1 });
    return groups;
  }

  // 副歌识别。返回每个下标的强度：2=连续多行整块重复（可信），1=只有一句反复出现的钩子（弱证据），
  // 0=认不出来。宁可判不出（导演就不加这一票），也不肯把「凑巧唱了两次的一句」当成副歌。
  function detectChorus(recs) {
    var strength = new Array(recs.length).fill(0);
    var norm = recs.map(function (r) { return normalize(r.text); });
    var best = null;
    for (var i = 0; i < recs.length - 1; i++) {
      if (!norm[i] || !norm[i + 1]) continue;
      for (var j = i + 2; j < recs.length - 1; j++) {
        if (j - i < CHORUS_MIN_INDEX_GAP) continue;
        if (recs[j].start - recs[i].start < CHORUS_MIN_TIME_GAP) continue;
        if (norm[i] !== norm[j] || norm[i + 1] !== norm[j + 1]) continue;
        var len = 2;
        while (len < CHORUS_MAX_BLOCK && i + len < recs.length && j + len < recs.length
          && norm[i + len] && norm[i + len] === norm[j + len]) len++;
        if (!best || len > best.len) best = { at: i, len: len };
      }
    }
    if (best) {
      var block = norm.slice(best.at, best.at + best.len);
      var joined = block.join('|');
      for (var k = 0; k + best.len <= recs.length; k++) {
        var hit = true;
        for (var q = 0; q < best.len; q++) { if (norm[k + q] !== block[q]) { hit = false; break; } }
        if (!hit) continue;
        for (var w = 0; w < best.len; w++) strength[k + w] = 2;
      }
      // 整块重复只认第一次命中的那个块；换块再判会把主歌里偶然的两句也抬成副歌。
      if (strength.some(function (s) { return s === 2; })) return strength;
    }
    // 弱档兜底：出现次数最多的一句，且至少 3 次、真的带字。副歌钩子常常只有一行，
    // 但三次以下更可能是采样或口头禅，不足以断定结构。
    var counts = {}, chosen = '', bestCount = 0;
    for (var n = 0; n < recs.length; n++) {
      if (!norm[n] || norm[n].length < 2) continue;
      counts[norm[n]] = (counts[norm[n]] || 0) + 1;
      if (counts[norm[n]] > bestCount) { bestCount = counts[norm[n]]; chosen = norm[n]; }
    }
    if (chosen && bestCount >= 3) {
      for (var c = 0; c < recs.length; c++) if (norm[c] === chosen) strength[c] = 1;
    }
    return strength;
  }

  function classify(par, index, total) {
    // 段落被叫作「副歌」的门槛是整块重复（strength=2），不是某句钩子反复出现（strength=1）。
    // 真跑一首歌试过用弱档判段落：17 段里 9 段成副歌，标签一通胀，导演的副歌门就等于没有门。
    // 弱证据仍然保留在行上（isChorus），导演据此小幅加分，但不改段落类型。
    if (par.strongLines >= Math.max(1, Math.ceil(par.lineCount * 0.5))) return 'chorus';
    if (index === total - 1) return 'outro';
    if (par.duration <= 3.5 || par.lineCount <= 1) return 'breath';
    if (par.marks >= 2 || par.lineCount / Math.max(par.duration, 0.5) > 2.5) return 'lift';
    return 'verse';
  }

  function compile(lines, tokensOf) {
    var recs = buildRecords(lines || [], tokensOf);
    if (!recs.length) {
      return { signature: '', lines: [], paragraphs: [], gaps: [], threshold: GAP_MIN, chorusVisits: 0, duration: 0 };
    }
    var threshold = gapThreshold(recs);
    var strength = detectChorus(recs);
    var groups = groupParagraphs(recs, threshold);
    var paragraphs = [];
    for (var g = 0; g < groups.length; g++) {
      var from = groups[g].startLine, to = groups[g].endLine;
      var chars = 0, marks = 0, words = 0, chorusLines = 0, strongLines = 0, maxStrength = 0, trustedNotes = 0;
      for (var i = from; i <= to; i++) {
        chars += recs[i].chars; marks += recs[i].marks; words += recs[i].words;
        if (strength[i] > 0) chorusLines++;
        if (strength[i] === 2) strongLines++;
        if (strength[i] > maxStrength) maxStrength = strength[i];
        if (recs[i].profile.trusted) trustedNotes++;
      }
      var start = recs[from].start;
      var end = recs[to].vocalEnd;
      var par = {
        index: g, startLine: from, endLine: to, lineCount: to - from + 1,
        start: start, end: end, duration: Math.max(0.001, end - start),
        chars: chars, marks: marks, words: words,
        chorusLines: chorusLines, strongLines: strongLines, chorusStrength: maxStrength,
        // 逐字画像的可信度按整段计：只有一两行带真时间轴的歌，不足以让导演拿断奏当线索。
        notesTrusted: trustedNotes >= Math.max(2, Math.ceil((to - from + 1) * 0.6)),
        gapBefore: recs[from].gapBefore,
        density: words / Math.max(0.001, end - start)
      };
      par.kind = classify(par, g, groups.length);
      paragraphs.push(par);
    }
    // 副歌按时间顺序数「第几次来到副歌」：第二次及以后应该更隆重，而不是换一个全新的镜头。
    var visit = 0;
    paragraphs.forEach(function (par) {
      if (par.kind !== 'chorus') { par.visit = 0; return; }
      visit += 1; par.visit = visit;
    });
    paragraphs.forEach(function (par) {
      var base = KINDS[par.kind] || KINDS.verse;
      // 重复但升级：同一类型的副歌再次到来时抬一档景别与力度，最高加两档，避免越唱越平。
      var bump = par.kind === 'chorus' ? Math.min(0.16, (par.visit - 1) * 0.08) : 0;
      par.openness = clamp(base.openness + bump, 0, 1);
      par.intensity = clamp(base.intensity + bump, 0, 1);
    });
    var gaps = [];
    for (var p = 1; p < paragraphs.length; p++) {
      var dur = paragraphs[p].start - paragraphs[p - 1].end;
      if (dur >= INSTRUMENTAL_GAP) {
        gaps.push({ at: paragraphs[p - 1].end, end: paragraphs[p].start, duration: dur,
          fromParagraph: p - 1, toParagraph: p });
      }
    }
    var out = recs.map(function (rec, i) {
      var par = paragraphs.find(function (q) { return i >= q.startLine && i <= q.endLine; }) || null;
      return {
        index: i, text: rec.text, start: rec.start, end: rec.end, vocalEnd: rec.vocalEnd,
        speechStart: rec.speechStart,
        gapBefore: rec.gapBefore, chars: rec.chars, marks: rec.marks, puncts: rec.puncts,
        words: rec.words, profile: rec.profile,
        isChorus: strength[i] > 0, chorusStrength: strength[i],
        paragraph: par ? par.index : -1,
        firstOfParagraph: !!par && i === par.startLine,
        lastOfParagraph: !!par && i === par.endLine,
        kind: par ? par.kind : '', visit: par ? par.visit : 0,
        positionInParagraph: par ? i - par.startLine : 0,
        paragraphCount: par ? par.lineCount : 0
      };
    });
    return {
      lines: out, paragraphs: paragraphs, gaps: gaps, threshold: threshold,
      chorusVisits: visit, duration: recs[recs.length - 1].vocalEnd
    };
  }

  // 同一份歌词数组只编译一次。渲染器与导演可能在同一帧各自索取，WeakMap 按数组身份缓存，
  // 换歌（新的 lines 数组）自然失效，不需要显式清理。
  var cache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function forDoc(lines, tokensOf) {
    if (!lines || typeof lines !== 'object') return null;
    if (cache) {
      var hit = cache.get(lines);
      if (hit) return hit;
    }
    var form = compile(lines, tokensOf);
    if (cache) { try { cache.set(lines, form); } catch (e) { /* 不可 weak 引用就不缓存 */ } }
    return form;
  }

  function indexOfLineAt(lines, tSec) {
    if (!lines.length) return -1;
    var lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lines[mid].start <= tSec) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans;
  }

  function lineAt(form, tSec) {
    if (!form || !form.lines || !form.lines.length) return null;
    var i = indexOfLineAt(form.lines, num(tSec, 0));
    return i >= 0 ? form.lines[i] : null;
  }

  function paragraphAt(form, index) {
    if (!form || !form.paragraphs || !form.paragraphs.length) return null;
    var p = form.paragraphs.find(function (q) { return index >= q.startLine && index <= q.endLine; });
    return p || null;
  }

  // 时间 → 段落（最后一个 start<=t 的段落）。这里刻意按时间而不是按「当前行」定位：
  // 句间空隙里当前行仍属于上一段，若按行取段落，淡变窗口就算到错误的邻居上，
  // openness 会在下一句起唱那一帧整档跳变 —— 黑边与镜头跟着抽一下，正是「幻灯片感」的来源。
  function paragraphIndexAt(form, tSec) {
    var ps = form.paragraphs, lo = 0, hi = ps.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (ps[mid].start <= tSec) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans;
  }

  // 时间 → 曲式读数。段落之间淡化的是「参数」而不是换对象：镜头与黑边因此是被开出去的，
  // 而不是在边界上瞬移。窗口按缝长自适应并钳在 0.25–3s，短缝不会拖满整段。
  function sample(form, tSec) {
    var t = num(tSec, 0);
    var line = lineAt(form, t);
    var progress = line ? clamp((t - line.start) / Math.max(0.001, line.vocalEnd - line.start), 0, 1) : 0;
    if (!form || !form.paragraphs || !form.paragraphs.length) {
      return { line: line, paragraph: null, index: -1, kind: '', progress: progress,
        openness: 0.30, intensity: 0.30, instrumental: false, firstOfParagraph: false };
    }
    var i = paragraphIndexAt(form, t);
    var cur = i >= 0 ? form.paragraphs[i] : null;
    var nxt = i >= 0 ? form.paragraphs[i + 1] : null;
    var openness, intensity, par;
    if (cur) {
      par = cur; openness = cur.openness; intensity = cur.intensity;
      if (nxt) {
        var ramp = clamp(Math.min(3, (nxt.start - cur.end) * 0.5), 0.25, 3);
        var w = ease((t - (nxt.start - ramp)) / ramp);
        openness += (nxt.openness - openness) * w;
        intensity += (nxt.intensity - intensity) * w;
      }
    } else {
      // 前奏：从最低景别向第一段靠，避免一开场就顶满或压死。
      par = form.paragraphs[0];
      var ramp0 = clamp(Math.min(3, par.start * 0.5), 0.25, 3);
      var w0 = ease((t - (par.start - ramp0)) / ramp0);
      openness = 0.20 + (par.openness - 0.20) * w0;
      intensity = 0.15 + (par.intensity - 0.15) * w0;
    }
    var instrumental = false;
    for (var gi = 0; gi < form.gaps.length; gi++) {
      if (t >= form.gaps[gi].at && t <= form.gaps[gi].end) { instrumental = true; break; }
    }
    return {
      line: line, paragraph: par, index: cur ? cur.index : -1, kind: cur ? cur.kind : 'intro',
      progress: progress, openness: clamp(openness, 0, 1), intensity: clamp(intensity, 0, 1),
      instrumental: instrumental, firstOfParagraph: !!line && line.firstOfParagraph
    };
  }

  // ---------------------------------------------------------------------------
  // 镜头语法：每种歌词模式自己的走法。
  //
  // 每个签名是 [dx, dy, scale, rot] 四个随句内进度 e∈[0,1] 走完的端点，单位分别是
  // 视口宽/高的比例、倍率、弧度。幅度一律再乘一个「句边包络」，两端归零 ——
  // 这样无论从头播到某一刻、还是直接 seek 到那一刻，画面完全相同（可复现，也免掉 seek 抖一下）。
  // 商籁/凝彩是 Pixi 层，自带相机（FX.cameraPose），这里必须给中性值，否则两套镜头抢一个画面。
  // ---------------------------------------------------------------------------
  var CAMERA_PATHS = {
    // 流光：缓慢推近 + 向右下方漂移，收尾回一点 —— 抒情段「靠近读数」。
    classic: { dx: [-0.016, 0.022], dy: [0.010, -0.020], scale: [0.985, 1.038], rot: [-0.0042, 0.0065], softness: 0.55 },
    // 心象：起手近、随后拉开并反向漂移 —— 留白与「退后看全景」。
    cadenza: { dx: [0.030, -0.034], dy: [-0.012, 0.026], scale: [1.046, 0.972], rot: [0.0068, -0.0050], softness: 0.72 },
    sonnet: null, tempera: null, stage: null, starborn: null
  };

  // 中性镜头：调用方据此知道「这个模式不该被外部相机推动」。
  var NEUTRAL = { dx: 0, dy: 0, scale: 1, rot: 0, envelope: 0, active: false };

  function cameraFor(modeId, line, tSec) {
    var path = CAMERA_PATHS[modeId];
    if (!path || !line) return Object.assign({}, NEUTRAL);
    var start = num(line.start, 0), end = num(line.vocalEnd, num(line.end, start + 3));
    if (!(end > start)) return Object.assign({}, NEUTRAL);
    var t = num(tSec, 0);
    // ramp 用秒而不是归一化比例：短句的过渡窗口本就短，按固定秒数钳住才不会在句首句尾各抖一次。
    var ramp = Math.min(Math.max(0.001, (end - start) * 0.4), 0.45 + path.softness * 0.75);
    var envelope = ease((t - start) / ramp) * ease((end - t) / ramp);
    if (!(envelope > 0)) return Object.assign({}, NEUTRAL, { envelope: 0 });
    var e = clamp((t - start) / Math.max(0.001, end - start), 0, 1);
    return {
      dx: path.dx[0] + (path.dx[1] - path.dx[0]) * e,
      dy: path.dy[0] + (path.dy[1] - path.dy[0]) * e,
      scale: path.scale[0] + (path.scale[1] - path.scale[0]) * e,
      rot: path.rot[0] + (path.rot[1] - path.rot[0]) * e,
      envelope: envelope, active: true
    };
  }

  // 相机合成：签名幅度乘运动强度与段落景别，再落到 CSS 可用的字符串与量值上。
  // 钳位必须在增益之后 —— 先钳再乘，副歌那档增益就会把上限顶穿（实测过 15.6vw 的位移）。
  // 上限取自参考项目踩过「镜头乱晃」之后写进设计手册的量级：位移 ±12%、旋转 ±0.02rad、缩放 ±8%。
  function cameraTransform(camera, motion, openness) {
    if (!camera || !camera.active) return '';
    var m = clamp(num(motion, 0.65), 0, 1) * camera.envelope;
    if (!(m > 0)) return '';
    var gain = m * (0.7 + clamp(num(openness, 0.4), 0, 1) * 0.6);
    var dx = clamp(camera.dx * gain, -0.12, 0.12);
    var dy = clamp(camera.dy * gain, -0.12, 0.12);
    var scale = 1 + clamp((camera.scale - 1) * gain, -0.08, 0.08);
    var rot = clamp(camera.rot * gain, -0.02, 0.02);
    return 'translate3d(' + (dx * 100).toFixed(3) + 'vw, ' + (dy * 100).toFixed(3) + 'vh, 0) '
      + 'scale(' + scale.toFixed(5) + ') rotate(' + rot.toFixed(5) + 'rad)';
  }

  return {
    KINDS: KINDS, CAMERA_PATHS: CAMERA_PATHS, INSTRUMENTAL_GAP: INSTRUMENTAL_GAP,
    normalize: normalize, compile: compile, forDoc: forDoc,
    lineAt: lineAt, paragraphAt: paragraphAt, paragraphIndexAt: paragraphIndexAt, sample: sample,
    cameraFor: cameraFor, cameraTransform: cameraTransform,
    gapThreshold: gapThreshold
  };
});
