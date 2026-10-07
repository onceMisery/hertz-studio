// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// 星诞 starborn：元导演。它不渲染，只决定「这一段由哪个渲染器来讲」，并把曲式层的读数
// 压成一条可复现的决策记录。
//
// 主轴是段落而不是句子。曲式层先把整首歌编译成段落（句间间隙 + 副歌识别 + 句内画像），
// 导演只在「段落起始句」的起唱之前下刀，一首歌大约 6–14 次切镜。按句轮播渲染器是上游摔过的坑：
// 每一句都重选一次画面，本质上就是按行号轮播的幻灯片，副歌与主歌一个样。句内的变化交给
// 各渲染器自己的镜头（见 stanza-songform 的 CAMERA_PATHS 与 stage3d 的相机机架），不归这里管。
//
// 硬约束：瞬态不得污染确定性。音频特征只影响「选哪个模式」这一次决策，切镜时机必须由
// 「段落起始 + 新鲜句边界 + 冷却锁 + 播放态」共同决定 —— 直接 seek 到句中不会触发切镜，
// 反向拖动会把锁重置到当前时刻，保证不会连切。
//
// 渲染器实例由 stage3d 统一持有，本模块只做调度，不负责 init/destroy，避免与惰性初始化打架。
(function (global) {
  'use strict';
  if (typeof window === 'undefined') return;
  var U = global.StanzaUtil;
  var SF = global.StanzaSongForm;
  // 引擎全局的实际导出名是 StanzaSonnetFx（小写 x）。大写拼写在浏览器里是
  // undefined —— 打分的音频证据会静默全零，而 Node 契约沙箱曾用大写别名注入
  // 把这件事 mask 掉了（2026-10-07 修复，契约已改为按真实导出名装载）。
  var FX = global.StanzaSonnetFx;
  if (!U) throw new Error('StanzaUtil must load before stanza-starborn.js');
  if (!SF) throw new Error('StanzaSongForm must load before stanza-starborn.js');

  var CANDIDATE_IDS = ['classic', 'cadenza', 'sonnet', 'tempera'];

  var LABELS = {
    classic: '流光', cadenza: '心象', sonnet: '商籁', tempera: '凝彩',
    stage: '舞台', starborn: '星诞'
  };

  // 段落类型对候选池是硬门，不是打分项：副歌绝不允许交给「留白」模式，一口气的空白
  // 也不该被色块分镜轰炸。上游同样的处理写成了「a chorus never whispers」。
  // 门只收窄池子、从不加分，所以任何段落下池子都至少剩三个候选，不会出现无解。
  var POOL_BY_KIND = {
    chorus: ['classic', 'sonnet', 'tempera'],
    lift: ['sonnet', 'tempera', 'classic'],
    breath: ['classic', 'cadenza', 'sonnet'],
    outro: ['cadenza', 'classic', 'sonnet'],
    verse: CANDIDATE_IDS
  };

  function num0(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
  function num01(v) { return typeof v === 'number' && isFinite(v) ? U.clamp(v, 0, 1) : 0; }

  function spanSec(rec) {
    if (!rec) return 0;
    var d = num0(rec.vocalEnd) - num0(rec.start);
    return d > 0 ? d : 0;
  }

  // 该段的统计量。入参是曲式层的行记录（已经带 chars/marks/words/profile/kind/isChorus），
  // 所以这里不再回查全局 Stage —— 纯函数、可在 Node 里直接喂构造数据验证。
  // 缺失的证据一律不参与打分：宁可少一条线索，也不要用估计算出来的假画像投票。
  function segmentStats(line, nextLine) {
    var a = line || {}, b = nextLine || {};
    var profile = a.profile || {};
    var words = num0(a.words) + num0(b.words);
    var duration = spanSec(a) + spanSec(b);
    return {
      kind: a.kind || '',
      isChorus: !!a.isChorus,
      chorusStrength: num0(a.chorusStrength),
      visit: num0(a.visit),
      paragraphIndex: num0(a.paragraph),
      paragraphLines: num0(a.paragraphCount),
      chars: num0(a.chars) + num0(b.chars),
      words: words,
      // 语速：词/秒。没有真实 token 时 words 为 0，rate 也保持 0，不参与任何加分。
      rate: words > 0 && duration > 0 ? words / duration : 0,
      marks: num0(a.marks) + num0(b.marks),
      notesTrusted: !!profile.trusted,
      staccato: !!profile.staccato,
      longNote: !!profile.longNote,
      maxNote: num0(profile.maxNote)
    };
  }

  // 打分全部是加法 ±，没有乘法门：一条线索缺失只会少加一点，不会把某个候选一票否决。
  // 系数沿用参考项目 music-stage-modes 的量级，但把本项目拿不到的证据（translated、
  // romanized、syllables、bpm）全部剔除，换成曲式层里真拿得到的（副歌、句内画像、段落类型）。
  function scoreAll(stats, audio, rand) {
    var jitter = (typeof rand === 'function' ? rand() : 0) * 0.42;   // 抖动上限 0.42
    var s = stats || {};
    var a = audio || {};
    var chars = num0(s.chars), marks = num0(s.marks), rate = num0(s.rate);
    var trust = !!s.notesTrusted, staccato = !!s.staccato && trust, longNote = !!s.longNote && trust;
    var chorus = !!s.isChorus, strongChorus = num0(s.chorusStrength) >= 2;
    var power = num01(a.power), bass = num01(a.bass), vocal = num01(a.vocal), treble = num01(a.treble);
    return {
      // 流光：人声与低音主导、句子真的短、有拖腔 → 舒缓的逐字辉光。密集断奏要让它位。
      // 「短」的门槛是 12 字（当前句 + 下一句），再宽就会把断奏密集段也判成抒情。
      classic: jitter + vocal * 1.05 + bass * 0.72
        + (chars <= 12 ? 0.42 : 0) + (s.kind === 'verse' ? 0.22 : 0)
        + (longNote ? 0.34 : 0) - (staccato ? 0.38 : 0),
      // 心象：标点多、能量低、段落本来就短 → 留白与镜头漂移。副歌走不到这里（池子已经关掉了）。
      cadenza: jitter + marks * 0.28 + (1 - power) * 0.66
        + (marks >= 2 ? 0.38 : 0) + (s.kind === 'breath' ? 0.5 : 0)
        + (rate > 0 && rate <= 0.6 ? 0.2 : 0),
      // 商籁：字数适中、人声稳、主歌或推进段 → 平面排版的节目包装。
      sonnet: jitter + vocal * 0.72 + marks * 0.22
        + Math.min(0.52, chars / 48) + (chars >= 20 && chars <= 42 ? 0.28 : 0)
        + (s.kind === 'verse' || s.kind === 'lift' ? 0.3 : 0)
        + (strongChorus ? 0.24 : 0),
      // 凝彩：低频重、能量高、副歌或推进段、断奏密集 → 色块分镜 MV。
      tempera: jitter + bass * 0.95 + power * 0.65 + marks * 0.18
        + (bass > 0.55 ? 0.35 : 0) + (treble > 0.6 ? 0.18 : 0)
        + (chorus ? 0.9 : 0) + (s.kind === 'lift' ? 0.35 : 0)
        + (staccato ? 0.45 : 0)
    };
  }

  function poolFor(stats) {
    var list = POOL_BY_KIND[(stats || {}).kind] || CANDIDATE_IDS;
    var pool = CANDIDATE_IDS.filter(function (id) { return list.indexOf(id) >= 0; });
    // 池子被收紧到不足两个候选时退回全集：宁可少一层门，也不能让导演只剩一个选项可切。
    return pool.length >= 2 ? pool : CANDIDATE_IDS.slice();
  }

  // 电影语言仍由导演发出，DOM/Pixi 的生命周期与实际绘制仍归宿主。
  // 参考 music-stage 的光学栈与 folia 的 transitionEase：冷色阴影保住黑位，暖光只落在
  // 画面边缘；时间包络两端速度为零，不能拿每帧随机闪白冒充电影转场。
  function filmEase(v) {
    var t = num01(v);
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  function transitionFor(line, kind, time, direction) {
    var gap = Math.max(0, num0(line && line.gapBefore));
    var style = kind === 'chorus' || kind === 'lift' ? 'light-wipe'
      : kind === 'breath' || kind === 'outro' ? 'dissolve' : 'soft-cut';
    var base = style === 'light-wipe' ? 320 : style === 'dissolve' ? 400 : 280;
    return {
      start: num0(time), durationMs: Math.round(U.clamp(base + gap * 45, 200, 460)),
      kind: style, direction: direction < 0 ? -1 : 1
    };
  }

  // sample 的 openness/intensity 已在曲式层跨段插值：不在这里重新推断曲式或重建一套调色时钟。
  // audio 来自实例的慢速曝光平滑。变化局限在低透明度边缘光，正文保持原本的对比度与色彩。
  function cinematicFrame(sample, audio, timeSec, cut, reduced) {
    var s = sample || {}, a = audio || {};
    var open = num01(s.openness), strength = num01(s.intensity);
    var t = reduced ? 0 : num0(timeSec);
    var progress = cut ? num01((t - cut.start) * 1000 / Math.max(1, num0(cut.durationMs))) : 1;
    var envelope = cut && !reduced && t >= cut.start
      ? Math.pow(Math.sin(Math.PI * filmEase(progress)), 2) : 0;
    // 精确归零，避免 sin(PI) 的浮点尾巴把转场合成层一直留着。
    if (progress >= 1) envelope = 0;
    var direction = cut && cut.direction < 0 ? -1 : 1;
    return {
      shadow: reduced ? 0.22 : 0.30 - open * 0.10,
      cool: reduced ? 0.055 : 0.085 - strength * 0.035,
      warm: reduced ? 0.035 : 0.028 + open * 0.035,
      light: reduced ? 0.10 : 0.085 + strength * 0.075 + num01(a.vocal) * 0.035,
      lightX: reduced ? 0 : Math.sin(t * 0.075) * (0.7 + open * 0.65),
      lightY: reduced ? 0 : Math.cos(t * 0.055) * (0.45 + num01(a.bass) * 0.25),
      transition: envelope,
      transitionX: cut && !reduced ? direction * (filmEase(progress) * 36 - 18) : 0,
      transitionKind: cut ? cut.kind : 'dissolve',
      transitionMs: cut ? cut.durationMs : 380
    };
  }

  function init(opts) {
    var o = opts || {};
    var getVisual = o.getVisual;        // () => 当前生效模式（导演用来对齐现状）
    var setVisual = o.setVisual;        // (id) => void  导演要求切到某模式
    var onSwitch = o.onSwitch;          // (id, meta) => void 供 HUD 显示导演决策
    if (typeof getVisual !== 'function' || typeof setVisual !== 'function') return null;

    var transitionLock = 4;             // 秒，两次切镜的最小间隔
    var avoidRepeat = true;
    var destroyed = false;

    var lastTime = null;                // 上一次 frame 的播放位置（秒）
    var trackKey = '';
    var decidedParagraph = -1;          // 已经决策过的段落；段落内不再二次下刀
    var protectedUntil = -Infinity;     // 上一句唱完的时刻（秒），之前不切
    var lastSwitchAt = -Infinity;
    var recent = [];                    // 最近选过的模式，index 0 是上一次
    var lastChorusMode = null;          // 上一次副歌用的模式，供「重复但升级」复用
    var count = 0;
    var currentId = null;
    var lastDecision = null;            // 最近一次打分表，供面板与验证脚本读
    var cinemaState = null;
    var cinemaCut = null;
    var cinemaTime = null;
    var cinemaAudio = { bass: 0, vocal: 0 };

    function updateCinema(f, reset) {
      // 暂停冻结同一张画面；降低动态可立即撤掉光擦与漂移，不受暂停冻结阻挡。
      if (!f.isPlaying && cinemaState && !reset && !f.reduced) return;
      var dt = cinemaTime === null ? 0 : f.playbackTime - cinemaTime;
      var snap = reset || cinemaTime === null || dt < 0 || dt > 0.5;
      var mix = snap ? 1 : 1 - Math.exp(-Math.max(0, dt) * 4.8);
      cinemaAudio.bass += (num01(f.audio.bass) - cinemaAudio.bass) * mix;
      cinemaAudio.vocal += (num01(f.audio.vocal) - cinemaAudio.vocal) * mix;
      cinemaTime = f.playbackTime;
      cinemaState = cinematicFrame(f.sample, cinemaAudio, cinemaTime, cinemaCut, f.reduced);
    }

    function currentTrackId() {
      var S = global.Stage;
      var pres = S && S.presentation ? S.presentation() : null;
      var t = pres && pres.track;
      if (!t) return '';
      return t.path || t.title || '';
    }

    function readFrame() {
      var S = global.Stage;
      var pres = S && S.presentation ? S.presentation() : null;
      var posS = (S && S.position ? S.position() : 0) / 1000;
      var doc = (S && S.lyrics) ? S.lyrics() : null;
      var lines = doc && doc.lines ? doc.lines : [];
      var spectrum = (S && S.spectrum && S.spectrum()) || [];
      // 曲式层按歌词数组身份缓存，每帧取是常数开销。
      var form = SF.forDoc(lines, S && S.lyricTokens ? function (l) { return S.lyricTokens(l); } : null);
      var line = form ? SF.lineAt(form, posS) : null;
      var para = line ? SF.paragraphAt(form, line.index) : null;
      return {
        playbackTime: posS,
        isPlaying: !!(pres && pres.playing),
        form: form,
        line: line,
        nextLine: line && form && form.lines[line.index + 1] ? form.lines[line.index + 1] : null,
        paragraph: para,
        sample: form ? SF.sample(form, posS) : null,
        audio: FX ? FX.resolveAudioBands(spectrum)
          : { power: 0, bass: 0, lowMid: 0, mid: 0, vocal: 0, treble: 0, spectrum: spectrum },
        reduced: !!(pres && pres.reduced)
      };
    }

    // U.srand(seed) 内部是 Math.sin(seed)，只接受数值 —— 直接传 'track:段落'
    // 这类字符串会隐式转成 NaN，整个打分表变成 NaN。先用 FNV 压成 32 位整数再喂给 srand。
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
      var para = frame.paragraph;
      var key = trackKey + ':' + (para ? para.index + ':' + para.startLine + ':' + para.kind : 'cold');
      var seed = seedOf(key);
      // 取两段不同频率的噪声线性混合当作抖动源：同一 seed 仍然可复现（演出可重现），
      // 且不引入 Math.random。抖动幅度在 scoreAll 内被钳到 0.42，独吞不了决策。
      var n1 = U.srand((seed % 1000) * 0.618 + 0.11);
      var n2 = U.srand((seed % 733) * 1.317 + 0.53);
      var scores = scoreAll(stats, frame.audio, function () { return n1 * 0.62 + n2 * 0.38; });
      var pool = poolFor(stats);
      // 稳定偏置：同一个段落的同一版本编曲，恒定偏好同一模式（整首歌因此有「这一版」的性格）。
      var biasId = CANDIDATE_IDS[seed % CANDIDATE_IDS.length];
      if (pool.indexOf(biasId) >= 0) scores[biasId] += 0.44;
      // 重复但升级：第二次及以后的副歌复用上次那张脸，由曲式层把景别与力度抬一档，
      // 而不是换一个全新的模式 —— 观众要认出「这是副歌又来了」。
      var escalating = stats.kind === 'chorus' && num0(stats.visit) >= 2 && !!lastChorusMode;
      if (escalating && pool.indexOf(lastChorusMode) >= 0) scores[lastChorusMode] += 0.66;
      if (avoidRepeat && !escalating) {
        recent.forEach(function (id, i) {
          if (scores[id] !== undefined) scores[id] -= i === 0 ? 0.72 : 0.34;
        });
      }
      var best = null, bestScore = -Infinity, runner = -Infinity;
      pool.forEach(function (id) {
        // 显式跳过非有限值：一旦有 NaN，`NaN > -Infinity` 为 false，best 会一直是 null。
        var v = scores[id];
        if (typeof v === 'number' && isFinite(v) && v > bestScore) {
          runner = bestScore; bestScore = v; best = id;
        }
      });
      var picked = best || pool[0] || CANDIDATE_IDS[0];
      lastDecision = {
        paragraph: para ? para.index : -1, kind: stats.kind, visit: num0(stats.visit),
        picked: picked, margin: isFinite(runner) ? bestScore - runner : bestScore,
        scores: Object.keys(scores).map(function (id) {
          return { id: id, value: scores[id], inPool: pool.indexOf(id) >= 0 };
        }),
        pool: pool.slice(), escalating: escalating
      };
      if (stats.kind === 'chorus') lastChorusMode = picked;
      return picked;
    }

    // 只有「段落起始句 + 起唱之前」才允许切。窗口按该句的前置留白放宽，上限 0.6s：
    // 带长前奏的段落不会因为没有帧正好落在 120ms 里而被整段错过，同时也绝不会切进正在唱的字。
    function atFreshBoundary(frame) {
      var line = frame.line;
      if (!line) return false;
      var since = frame.playbackTime - line.start;
      if (since < 0) return false;
      var lead = Math.max(0, num0(line.speechStart) - num0(line.start));
      return since <= Math.min(0.6, 0.12 + lead);
    }

    function frame() {
      if (destroyed) return;
      var f = readFrame();
      var nextTrack = currentTrackId();
      var trackChanged = trackKey !== nextTrack;
      var prev = lastTime;
      var backward = prev !== null && f.playbackTime < prev - 0.05;
      var jumped = prev !== null && f.playbackTime - prev > 0.5;
      lastTime = f.playbackTime;

      if (trackChanged) {
        // 换曲：段落记忆与抑制记录全部作废，否则新歌第一段会被上一首的 recent 压住。
        trackKey = nextTrack;
        decidedParagraph = -1;
        recent.length = 0;
        lastChorusMode = null;
        protectedUntil = -Infinity;
        lastSwitchAt = -Infinity;
        currentId = null;
        cinemaCut = null;
      } else if (backward || jumped) {
        // 时钟校正 / seek 都不是「音乐切镜」。把锁挪到当前时刻：seek 之后至少再等
        // transitionLock 才允许自动切，同时当前段落视为已决策，绝不在句中补刀。
        if (backward) lastSwitchAt = f.playbackTime;
        if (f.paragraph) decidedParagraph = f.paragraph.index;
        protectedUntil = -Infinity;
        cinemaCut = null;
      }
      updateCinema(f, trackChanged || backward || jumped);

      var line = f.line;
      var para = f.paragraph;
      // 门禁用「上一句的演唱结束时刻」，不是本句自己的：本句的 vocalEnd 必然晚于它的 start，
      // 先记录再判定就会把每一个段首都堵死（改造时踩到的坑，调换这两行就会复发）。
      var gateUntil = protectedUntil;
      if (line) protectedUntil = Math.max(protectedUntil, num0(line.vocalEnd));

      if (currentId === null) {
        // 冷启动：先挂上一个模式，之后只等段落起始句再切。没有可读歌词行时不挂 ——
        // 前缀留白里画面本来就该是空的，硬选一个只会拿到一份全零证据的瞎猜。
        if (!line || !U.hasReadable(line.text || '')) return;
        var stats0 = segmentStats(line, f.nextLine);
        currentId = chooseMode(f, stats0);
        decidedParagraph = para ? para.index : -1;
        recent.unshift(currentId);
        recent.splice(2);
        count += 1;
        setVisual(currentId);
        lastSwitchAt = f.playbackTime;
        if (typeof onSwitch === 'function') onSwitch(currentId, { cold: true, count: count, decision: lastDecision });
        return;
      }

      var freshParagraph = para && para.index !== decidedParagraph;
      var canCut = f.isPlaying && line && para && U.hasReadable(line.text || '')
        && freshParagraph && line.firstOfParagraph && atFreshBoundary(f)
        && !backward && !jumped
        && f.playbackTime - lastSwitchAt >= transitionLock
        && line.start >= gateUntil - 0.001;

      if (!canCut) return;

      decidedParagraph = para.index;
      var stats = segmentStats(line, f.nextLine);
      var picked = chooseMode(f, stats);
      if (picked !== currentId) {
        cinemaCut = transitionFor(line, stats.kind, f.playbackTime,
          (para.index + CANDIDATE_IDS.indexOf(picked)) % 2 === 0 ? 1 : -1);
        updateCinema(f, false);
        currentId = picked;
        recent.unshift(picked);
        recent.splice(2);
        count += 1;
        setVisual(picked);
        if (typeof onSwitch === 'function') onSwitch(picked, { cold: false, count: count, decision: lastDecision });
      } else {
        // 选到同一个：仍要刷新抑制记录与冷却，避免连续多段同模式后被永久锁死。
        recent.unshift(picked);
        recent.splice(2);
      }
      lastSwitchAt = f.playbackTime;
    }

    return {
      frame: frame,
      // 宿主每帧读取的只是本帧数据，不复制完整打分表，也不额外读取音频或歌词。
      cinemaFrame: function () { return cinemaState; },
      // 导演的开关就是「歌词视觉选了星诞」这一个条件，由宿主 stage3d 决定要不要调用 frame()。
      // 以前这里另有一个 autoDirector 布尔，而它在全仓库没有任何赋值点 —— 于是导演一帧都没跑过，
      // 画面永远停在 effectiveVisual() 兜底的流光。不要再引入第二个需要外部置位的开关。
      reset: function () {
        currentId = null;
        lastTime = null;
        decidedParagraph = -1;
        lastChorusMode = null;
        recent.length = 0;
        protectedUntil = -Infinity;
        lastSwitchAt = -Infinity;
        lastDecision = null;
        cinemaState = null;
        cinemaCut = null;
        cinemaTime = null;
        cinemaAudio.bass = cinemaAudio.vocal = 0;
      },
      setTransitionLock: function (v) { transitionLock = U.clamp(Number(v) || 0, 0, 30); },
      setAvoidRepeat: function (b) { avoidRepeat = !!b; },
      // 供设置面板与验证脚本读状态。
      snapshot: function () {
        return {
          directedMode: currentId, transitionCount: count,
          lastSwitchAt: lastSwitchAt, protectedUntil: protectedUntil,
          transitionLock: transitionLock, avoidRepeat: avoidRepeat,
          decidedParagraph: decidedParagraph, recent: recent.slice(),
          candidates: CANDIDATE_IDS.slice(), lastChorusMode: lastChorusMode,
          // 交叉淡入会短暂持有两个子实例，因此不把 WebGL 类互斥模式判为「可同时在场」。
          // 当前候选四个都可安全共存，此处仅作诊断输出。
          excludesWebGLModes: false,
          lastDecision: lastDecision
        };
      },
      destroy: function () { destroyed = true; currentId = null; cinemaState = null; cinemaCut = null; }
    };
  }

  global.StanzaStarborn = {
    init: init,
    CANDIDATE_IDS: CANDIDATE_IDS,
    LABELS: LABELS,
    POOL_BY_KIND: POOL_BY_KIND,
    // 导出纯函数给契约脚本，避免脚本只能靠跑渲染器来验证打分逻辑。
    scoreAll: scoreAll,
    segmentStats: segmentStats,
    poolFor: poolFor,
    cinematicFrame: cinematicFrame,
    transitionFor: transitionFor
  };
})(window);
