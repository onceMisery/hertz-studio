// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// 星诞 starborn：元导演。它本身不渲染，只按当前段的音乐特征在候选渲染器之间自动切镜。
//
// 设计约束（与参考项目一致）：瞬态不得污染确定性。音频特征只影响「选哪个模式」这一次决策，
// 切镜时机必须由「新鲜句边界 + 冷却锁 + 播放态」三者共同决定 —— 因此直接 seek 到句中
// 不会触发切镜，而反向拖动会把锁重置到当前时刻，保证不会连切。
//
// 与参考项目的差异：本项目没有 luminous/fume/diorama 三个渲染器，候选收窄为
// classic/cadenza/sonnet/tempera 四种；且渲染器实例由 stage3d 统一持有，
// 本模块只做「可见性与调音」的调度，不负责 init/destroy，避免与 stage3d 的惰性初始化打架。
(function (global) {
  'use strict';
  if (typeof window === 'undefined') return;
  var U = global.StanzaUtil;
  var FX = global.StanzaSonnetFX;
  if (!U) throw new Error('StanzaUtil must load before stanza-starborn.js');

  // 候选模式。tempera/sonnet 是 Pixi 层，与它们互斥是天然成立的（共用一个宿主层，
  // 同时只亮一个）；classic/cadenza 共用歌词宿主，同样靠 setVisible 互斥。
  var CANDIDATE_IDS = ['classic', 'cadenza', 'sonnet', 'tempera'];

  var LABELS = {
    classic: '流光', cadenza: '心象', sonnet: '商籁', tempera: '凝彩',
    stage: '舞台'
  };

  // 参考项目用 isChorus / renderHints / syllables 等字段加分，本项目只有 renderHints
  // 与逐字 tokens（见 stanza-util 的 renderHints / Stage.lyricTokens）。
  // 缺失的证据一律不参与打分 —— 宁可少一条线索，也不要用假数据把决策带偏。
  function lineChars(line) {
    if (!line) return 0;
    return U.graphemes(line.text || '').filter(function (c) { return c.trim(); }).length;
  }

  // 该段的文本统计量。只用当前行 + 下一行，够用来区分「抒情长句」与「密集短句」。
  function segmentStats(activeLine, nextLine) {
    var lines = [activeLine, nextLine].filter(Boolean);
    var text = lines.map(function (l) { return l.text || ''; }).join(' ');
    var chars = lineChars(activeLine) + lineChars(nextLine);
    var duration = 0, words = 0;
    // 全程走 global.Stage 而不是裸 Stage：裸标识符依赖隐式全局，
    // 在 Node 的模块沙箱里会 ReferenceError，契约脚本就无法验证这些纯函数。
    var S = global.Stage;
    lines.forEach(function (l) {
      var d = (l.end_ms == null ? l.start_ms : l.end_ms) - l.start_ms;
      if (d > 0) duration += d;
      var toks = S && S.lyricTokens ? S.lyricTokens(l) : null;
      words += toks && toks.length ? toks.length : 0;
    });
    duration = Math.max(0.001, duration / 1000);
    return {
      text: text,
      chars: chars,
      words: words,
      // 语速：词/秒。密集短句偏 partita 式的阶梯，此处映射到 classic。
      rate: words / duration,
      // 标点密度：叹号问号省略号破折号。情绪强烈时偏向 tempera/sonnet 的强对比。
      marks: (text.match(/[!?！？…—]/g) || []).length
    };
  }

  // 六条候选打分。系数对齐参考项目 music-stage-modes.js:40-64 的量级，
  // 但把缺失的证据项（chorus / translated / syllables / hintedFast）去���，
  // 并把本项目可得的 rate / marks 作为补偿。
  function scoreAll(stats, audio, rand) {
    // rand 是 0–1 的随机源函数。缺省给常 0，保证调用方忘了传也不会得到 NaN。
    var jitter = (typeof rand === 'function' ? rand() : 0) * 0.42;   // 抖动上限 0.42
    var chars = (stats && stats.chars) || 0;
    var marks = (stats && stats.marks) || 0;
    // 频段缺失时按 0 处理：宁可少一条线索，也不要用 NaN 把整个决策带偏。
    var a = audio || {};
    var power = num01(a.power), bass = num01(a.bass), vocal = num01(a.vocal);
    return {
      // 流光：人声与低音主导、字数少 → 舒缓，适合抒情段
      classic: jitter + vocal * 1.05 + bass * 0.72 + (chars <= 18 ? 0.48 : 0),
      // 心象：标点多、能量低（安静段落）→ 留白与镜头漂移
      cadenza: jitter + marks * 0.28 + (1 - power) * 0.66 + (marks >= 2 ? 0.38 : 0),
      // 商籁：字数适中、有标点、人声稳 → 平面排版节目包装
      sonnet: jitter + vocal * 0.72 + marks * 0.22
        + Math.min(0.52, chars / 48) + (chars >= 20 && chars <= 42 ? 0.28 : 0),
      // 凝彩：低频重、能量高、标点强 → 色块分镜 MV
      tempera: jitter + bass * 0.95 + power * 0.65 + marks * 0.18
        + (bass > 0.55 ? 0.35 : 0)
    };
  }

  function num01(v) { return typeof v === 'number' && isFinite(v) ? U.clamp(v, 0, 1) : 0; }

  function init(opts) {
    var o = opts || {};
    var getVisual = o.getVisual;        // () => 'stage'|当前 visual
    var setVisual = o.setVisual;        // (id) => void  导演要求切到某模式
    var onSwitch = o.onSwitch;          // (id, meta) => void 供 HUD 显示导演决策
    if (typeof getVisual !== 'function' || typeof setVisual !== 'function') return null;

    var enabled = false;
    var transitionLock = 4;             // 秒，两次切镜的最小间隔
    var avoidRepeat = true;
    var destroyed = false;

    var lastTime = null;                // 上一次 frame 的播放位置（秒）
    var segmentKey = '';
    var trackKey = '';
    var observedLine = null;
    var protectedUntil = -Infinity;     // 该句的演唱结束时间（秒），此之前不切
    var lastSwitchAt = -Infinity;
    var recent = [];                    // 最近选过的模式，index 0 是上一次
    var count = 0;
    var currentId = null;

    function currentTrackId() {
      var S = global.Stage;
      var pres = S && S.presentation ? S.presentation() : null;
      var t = pres && pres.track;
      if (!t) return '';
      return t.path || t.title || '';
    }

    function activeLineAt(lines, t) {
      var lo = 0, hi = lines.length - 1, ans = -1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (lines[mid].start_ms <= t * 1000) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      return ans;
    }

    function readFrame() {
      var S = global.Stage;
      var pres = S && S.presentation ? S.presentation() : null;
      var posS = (S && S.position ? S.position() : 0) / 1000;
      var doc = (S && S.lyrics) ? S.lyrics() : null;
      var lines = doc && doc.lines ? doc.lines : [];
      var idx = activeLineAt(lines, posS);
      var spectrum = (S && S.spectrum && S.spectrum()) || [];
      return {
        playbackTime: posS,
        isPlaying: !!(pres && pres.playing),
        activeLine: idx >= 0 ? lines[idx] : null,
        nextLine: idx >= 0 ? (lines[idx + 1] || null) : (lines[0] || null),
        lines: lines,
        audio: FX ? FX.resolveAudioBands(spectrum)
          : { power: 0, bass: 0, lowMid: 0, mid: 0, vocal: 0, treble: 0, spectrum: spectrum },
        reduced: !!(pres && pres.reduced)
      };
    }

    // U.srand(seed) 内部是 Math.sin(seed)，只接受数值 —— 直接传 'track:segment'
    // 这类字符串会隐式转成 NaN，整个打分表变成 NaN，chooseMode 只能返回 undefined。
    // 所以先用 hashString 把任意标识压成 32 位整数再喂给 srand。
    function seedOf(str) {
      var h = 2166136261 >>> 0;
      var s = String(str);
      for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      return h;
    }

    function chooseMode(frame, stats) {
      var seed = seedOf(trackKey + ':' + segmentKey);
      // 取两段不同频率的噪声线性混合当作抖动源：同一 seed 仍然可复现（演出可重现），
      // 且不引入 Math.random。抖动幅度在 scoreAll 内被钳到 0.42，独吞不了决策。
      var n1 = U.srand((seed % 1000) * 0.618 + 0.11);
      var n2 = U.srand((seed % 733) * 1.317 + 0.53);
      var scores = scoreAll(stats, frame.audio, function () { return n1 * 0.62 + n2 * 0.38; });
      // 稳定偏置：同一段落的同一句话，恒定偏好同一模式。
      var biasId = CANDIDATE_IDS[seed % CANDIDATE_IDS.length];
      scores[biasId] += 0.44;
      if (avoidRepeat) {
        recent.forEach(function (id, i) {
          if (scores[id] !== undefined) scores[id] -= i === 0 ? 0.72 : 0.34;
        });
      }
      var best = null, bestScore = -Infinity;
      CANDIDATE_IDS.forEach(function (id) {
        // 显式跳过非有限值：一旦有 NaN，`NaN > -Infinity` 为 false，best 会一直是 null。
        if (typeof scores[id] === 'number' && isFinite(scores[id]) && scores[id] > bestScore) {
          bestScore = scores[id];
          best = id;
        }
      });
      return best || biasId || CANDIDATE_IDS[0];
    }

    // 只有「新鲜句边界」才允许切：冷启动可能落在句中（atBoundary 为假），
    // 此后每次自动切镜都必须落在新句开头 120ms 内 —— 不会出现延后触发的"补切"。
    function atFreshBoundary(frame) {
      var line = frame.activeLine;
      if (!line) return false;
      var since = frame.playbackTime - line.start_ms / 1000;
      return since >= 0 && since <= 0.12;
    }

    function frame() {
      if (destroyed || !enabled) return;
      var f = readFrame();
      var nextTrack = currentTrackId();
      var trackChanged = trackKey !== nextTrack;
      var prev = lastTime;
      var backward = prev !== null && f.playbackTime < prev - 0.05;
      var jumped = prev !== null && f.playbackTime - prev > 0.5;
      lastTime = f.playbackTime;

      if (trackChanged) {
        // 换曲：段落记忆与抑制记录全部作废，否则新歌第一句会被上一首的 recent 压住。
        trackKey = nextTrack;
        segmentKey = '';
        observedLine = null;
        recent.length = 0;
        protectedUntil = -Infinity;
        lastSwitchAt = -Infinity;
        currentId = null;
      } else if (backward || jumped) {
        // 时钟校正 / seek / 换歌词数组都不是"音乐切镜"。
        // 把锁挪到当前时刻：seek 之后至少再等 transitionLock 才允许自动切。
        if (backward) lastSwitchAt = f.playbackTime;
        segmentKey = '';
        observedLine = null;
        protectedUntil = -Infinity;
      }

      var line = f.activeLine;
      var prevSegmentKey = segmentKey;
      segmentKey = line ? (line.start_ms + ':' + (line.text || '')) : '';
      var lineChanged = !!line && segmentKey !== prevSegmentKey;
      var canCut = enabled && f.isPlaying && line && U.hasReadable(line.text || '')
        && atFreshBoundary(f) && !backward && !jumped
        && f.playbackTime - lastSwitchAt >= transitionLock
        && line.start_ms / 1000 >= protectedUntil - 0.001;

      if (currentId === null) {
        // 冷启动：无论落在句中哪里都先挂一个，之后只等新鲜句边界再切。
        var s0 = segmentStats(f.activeLine, f.nextLine);
        currentId = chooseMode(f, s0);
        recent.unshift(currentId);
        recent.splice(2);
        count += 1;
        setVisual(currentId);
        lastSwitchAt = f.playbackTime;
        if (typeof onSwitch === 'function') onSwitch(currentId, { cold: true, count: count });
      } else if (canCut) {
        var stats = segmentStats(f.activeLine, f.nextLine);
        var picked = chooseMode(f, stats);
        if (picked !== currentId) {
          currentId = picked;
          recent.unshift(picked);
          recent.splice(2);
          count += 1;
          setVisual(picked);
          lastSwitchAt = f.playbackTime;
          if (typeof onSwitch === 'function') onSwitch(picked, { cold: false, count: count });
        } else {
          // 选到同一个：仍要刷新抑制记录与冷却，避免连续多句同模式后被永久锁死。
          recent.unshift(picked);
          recent.splice(2);
          lastSwitchAt = f.playbackTime;
        }
      }

      // 记录该句的演唱结束边界：唱完之前不切镜，否则新模式会在半句上接手。
      if (line && observedLine !== line) {
        observedLine = line;
        var toks = global.Stage && global.Stage.lyricTokens ? global.Stage.lyricTokens(line) : null;
        var vocalEnd = line.end_ms != null ? line.end_ms / 1000 : line.start_ms / 1000;
        if (toks && toks.length) {
          toks.forEach(function (t) {
            if (t.end_ms != null) vocalEnd = Math.max(vocalEnd, t.end_ms / 1000);
          });
        }
        protectedUntil = Math.max(protectedUntil, vocalEnd);
      }
    }

    return {
      frame: frame,
      setEnabled: function (b) {
        b = !!b;
        if (enabled === b) return;
        enabled = b;
        if (!b) {
          // 关闭时把导演状态清干净，下次开启重新冷启动，避免拿旧抑制记录误切。
          currentId = null;
          lastTime = null;
          segmentKey = '';
          observedLine = null;
          recent.length = 0;
          protectedUntil = -Infinity;
          lastSwitchAt = -Infinity;
        }
      },
      isEnabled: function () { return enabled; },
      setTransitionLock: function (v) { transitionLock = U.clamp(Number(v) || 0, 0, 30); },
      setAvoidRepeat: function (b) { avoidRepeat = !!b; },
      // 供设置面板与验证脚本读状态。
      snapshot: function () {
        return {
          enabled: enabled, directedMode: currentId, transitionCount: count,
          lastSwitchAt: lastSwitchAt, protectedUntil: protectedUntil,
          transitionLock: transitionLock, avoidRepeat: avoidRepeat,
          recent: recent.slice(), candidates: CANDIDATE_IDS.slice(),
          // 与参考项目一致：交叉淡入会短暂持有两个子实例，因此不把 WebGL 类互斥
          // 模式判为"可同时在场"。当前候选四个都可安全共存，此处仅作诊断输出。
          excludesWebGLModes: false
        };
      },
      destroy: function () { destroyed = true; enabled = false; }
    };
  }

  global.StanzaStarborn = {
    init: init,
    CANDIDATE_IDS: CANDIDATE_IDS,
    LABELS: LABELS,
    // 导出纯函数给契约脚本，避免脚本只能靠跑渲染器来验证打分逻辑。
    scoreAll: scoreAll,
    segmentStats: segmentStats
  };
})(window);
