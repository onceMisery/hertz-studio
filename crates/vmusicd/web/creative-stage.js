// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 创意舞台：把三维场景、镜头、影调、编排轨和自动导演缝合成可编辑的一份数据。
//
// 这一层最核心的设计决定是：**舞台是一张可寻址的参数表，不是场景图。**
//
// 换成场景图（灯光对象、道具对象、父子变换）看起来更"专业"，但对本项目是错的：
// 编辑这份数据的人是用户，不是写代码的人。一张扁平的
// `cam.dist` / `look.bloom` / `sc.height` 表可以被滑块直接命中、被 cue 直接改写、
// 被音频直接绑定、被 JSON 直接存取，四件事共用一套寻址；场景图则要在每一层
// 都写一遍"找到那个节点、改那个属性"的样板。代价是表达能力弱一些 —— 但
// 三维场景本身是着色器生成的，"打光"发生在那里面，不需要在 JS 里维护灯对象。
//
// 于是跑一帧的顺序固定为四步（每一步都能在工坊里单独看到、单独改）：
//
//   基础值（预置）→ 音频绑定叠加 → 自动导演/编排轨动画写入 → 钳位
//
// 谁写在后面谁说了算。用户手动拖的滑块直接改基础值，所以它一定被 cue 覆盖 ——
// 这正是"编排优先"的语义，而工坊里把 cue 关掉就能拿回手动控制。
//
// 与 stage-particles.js 的关系：两者是并列的舞台主渲染，由 renderer 预置选择，
// 同一时刻只有一个在跑（另一个的帧门返回 0）。共用 Stage.spectrum / Stage.gate /
// Stage.position 三份数据，不会各听各的。

(function () {
  'use strict';

  // 帧门预算。三维 + 后处理比点精灵贵得多；原则是"降 DPR 保帧率"——
  // 快速运动的场景（隧道、副歌的塔林）在 20fps 下是肉眼可见的卡顿，
  // 而 0.55 DPR 的模糊在泛光链路里几乎看不出来。糊一点换流畅，值。
  var TIERS = [{ fps: 30, dpr: 0.55 }, { fps: 40, dpr: 0.85 }, { fps: 48, dpr: 1.10 }];

  // 代价探测往下让的档位（见"渲染代价探测"一节）。只降 DPR、不降帧率，
  // 理由与 TIERS 上面那段注释是同一条：快速运动的场景在 20fps 下是肉眼可见的
  // 卡顿，而阶梯最底档那点的糊在泛光链路里几乎看不出来。
  var DPR_STEPS = [1, 0.78, 0.6];
  var PROBE_WINDOW = 500;     // 单轮采样时长；静默与在画各一轮，串行走完算一次测量
  var PROBE_KEEP = 0.12;      // 帧率损失低于此值：本档预算留着，不再往下让
  var PROBE_OFF = 0.45;       // 降到最低档仍高于此值：开着比关掉更糟

  var LOCAL_KEY = 'vmusic.creative.preset';
  var LOCAL_LIB_KEY = 'vmusic.creative.library';
  var SERVER_KEY = 'creative_presets';

  // 分带边界与起音判据都在 onset.js。两边的"鼓点"必须是同一个时刻，所以这块
  // 只能有一份实现（v1.0 之前这里是独立一份，且阈值用固定 0.055，与粒子层的
  // 自适应阈值根本不是同一个判据 —— 见 onset.js 顶部说明）。
  var HAS_ONSET = !!(window.Onset && window.Onset.GROUPS);
  var GROUPS = HAS_ONSET ? Onset.GROUPS : [];

  // -------------------------------------------------------------------------
  // 基础参数表
  // -------------------------------------------------------------------------

  var BASE_SPEC = [
    {
      id: 'cam', title: '镜头', items: [
        ['cam.fov', '视场角', 30, 110, 1, '°', 58],
        ['cam.dist', '机位距离', 3, 44, 0.5, '', 15],
        ['cam.yaw', '水平角', -180, 180, 1, '°', 0],
        ['cam.pitch', '俯仰角', -55, 80, 1, '°', 14],
        ['cam.height', '注视高度', -6, 10, 0.1, '', 0.6],
        ['cam.drift', '自动漂移', 0, 200, 5, '%', 40],
        ['cam.shake', '节拍抖动', 0, 200, 5, '%', 70],
        ['cam.kick', '低频跟随', 0, 200, 5, '%', 80]
      ]
    },
    {
      id: 'look', title: '影调', items: [
        ['look.bloom', '泛光', 0, 3, 0.05, '', 0.9],
        ['look.bloomThresh', '泛光阈值', 0, 1, 0.01, '', 0.58],
        ['look.chroma', '径向色散', 0, 4, 0.05, '', 0.35],
        ['look.vignette', '暗角', 0, 1.2, 0.02, '', 0.28],
        ['look.grain', '胶片颗粒', 0, 1.2, 0.02, '', 0.20],
        ['look.toon', '手绘描边', 0, 1, 0.02, '', 0],
        ['look.paper', '纸张质感', 0, 1, 0.02, '', 0],
        ['look.exposure', '曝光', 0.4, 2.4, 0.02, '', 1.12],
        ['look.saturation', '饱和度', 0, 2, 0.02, '', 1.10]
      ],
      selects: [['look.grade', '调色', [['0', '原色'], ['1', '双色调'], ['2', '单色'], ['3', '霓虹']], 0]]
    },
    {
      id: 'stage', title: '舞台', items: [
        ['stage.rotY', '绕 Y 自转', -180, 180, 1, '°', 0],
        ['stage.scale', '整体缩放', 0.3, 2.5, 0.05, '', 1],
        ['stage.seed', '随机种子', 0, 1, 0.01, '', 0.42]
      ]
    }
  ];

  // 场景私有参数。每项 = [键, 中文名, min, max, step, 单位, 默认值]。
  // 路径一律写作 `sc.<键>`，切场景时自动指向当前场景那一份。
  var SCENE_SPEC = {
    towers: [
      ['height', '柱高', 0.5, 22, 0.1, '', 9],
      ['span', '排列宽度', 6, 60, 0.5, '', 26],
      ['width', '柱宽', 0.1, 2, 0.02, '', 0.62],
      ['depth', '柱厚', 0.1, 2, 0.02, '', 0.62],
      ['mirror', '地面倒影', 0, 1, 0.02, '', 0.45]
    ],
    orb: [
      ['radius', '球半径', 1, 8, 0.1, '', 3.0],
      ['amp', '位移幅度', 0, 4, 0.05, '', 1.3],
      ['wire', '线框强度', 0, 1.5, 0.02, '', 0.55],
      ['wobble', '切向抖动', 0, 1.5, 0.02, '', 0.6]
    ],
    tunnel: [
      ['ringRadius', '隧道半径', 1, 12, 0.1, '', 4.2],
      ['ringLen', '隧道长度', 6, 48, 0.5, '', 22],
      ['spread', '光带宽度', 0.2, 5, 0.05, '', 1.5],
      ['push', '推进力', 0, 20, 0.2, '', 6.5]
    ],
    nebula: [
      ['cloudR', '星云半径', 1, 16, 0.2, '', 6.0],
      ['spread3', '垂直铺开', 0, 8, 0.1, '', 2.4],
      ['size', '颗粒大小', 0.4, 8, 0.05, '', 2.6],
      ['spin', '公转速度', 0, 3, 0.02, '', 0.5],
      ['densityK', '密度系数', 0.2, 2, 0.02, '', 1.0]
    ],
    terrain: [
      ['extent', '地形尺度', 6, 60, 0.5, '', 26],
      ['amp2', '起伏幅度', 0, 8, 0.1, '', 2.6],
      ['scroll', '滚动速度', 0, 3, 0.02, '', 0.55],
      ['wire2', '网格线强度', 0, 2, 0.05, '', 0.9]
    ],
    lyric: [
      ['spacing', '行距', 1, 9, 0.1, '', 2.5],
      ['arc', '弧线', 0, 10, 0.1, '', 3.2],
      ['pwidth', '文字宽度', 8, 32, 0.5, '', 20],
      ['dimK', '远句亮度', 0, 1, 0.02, '', 0.32],
      ['bob', '漂浮幅度', 0, 2, 0.05, '', 0.5],
      ['tint', '着色强度', 0, 1.5, 0.02, '', 0.8]
    ]
  };

  // 自动导演的三个"段落情绪"。数值刻意拉开：安静段几乎不动、副歌段机位拉近 +
  // 大幅抖动，用户一眼能看出导演做了什么，再决定要不要改。
  var MOODS = {
    quiet: { 'look.bloom': 0.45, 'look.vignette': 0.55, 'look.saturation': 0.85,
      'cam.dist': 24, 'cam.drift': 12, 'cam.shake': 20, 'cam.kick': 40,
      'cam.fov': 48, 'stage.scale': 0.88 },
    verse: { 'look.bloom': 0.95, 'look.vignette': 0.28, 'look.saturation': 1.10,
      'cam.dist': 16, 'cam.drift': 45, 'cam.shake': 70, 'cam.kick': 80,
      'cam.fov': 58, 'stage.scale': 1.0 },
    chorus: { 'look.bloom': 1.75, 'look.vignette': 0.18, 'look.saturation': 1.32,
      'look.chroma': 0.72, 'cam.dist': 10.5, 'cam.drift': 95, 'cam.shake': 150,
      'cam.kick': 140, 'cam.fov': 68, 'stage.scale': 1.16 }
  };

  // 每个场景的入画机位。五个场景共用一个默认机位的结果是：隧道从外面看
  // （一个转圈的光环，而不是穿越）、星云贴得太近、地形俯视角度不够。
  // 切场景时基础值直接落位 + 推一条从旧机位出发的补间，镜头"飞过去"。
  var SCENE_CAM = {
    towers: { 'cam.dist': 15, 'cam.pitch': 14, 'cam.fov': 58, 'cam.height': 0.6 },
    orb: { 'cam.dist': 10.5, 'cam.pitch': 8, 'cam.fov': 55, 'cam.height': 0.4 },
    // 隧道要钻进去看：机位收进环口内侧，视场角拉大，透视的"冲向深处"才成立。
    tunnel: { 'cam.dist': 4.2, 'cam.pitch': 2, 'cam.fov': 74, 'cam.height': 0 },
    nebula: { 'cam.dist': 17, 'cam.pitch': 26, 'cam.fov': 60, 'cam.height': 0 },
    terrain: { 'cam.dist': 16, 'cam.pitch': 24, 'cam.fov': 62, 'cam.height': 0.8 },
    // 歌词走廊：机位放在走廊一端，大视场角让纵深与掠过感成立。
    // yaw 必须钉死：用户自由拖拽可以环游，但每次选进这个场景时入口机位要确定，
    // 不能继承上一个场景（或自己上次环游后）存下的 yaw——否则进场就在走廊
    // 另一端看到整屏镜像反字。
    lyric: { 'cam.yaw': 0, 'cam.dist': 20, 'cam.pitch': 4, 'cam.fov': 64, 'cam.height': 0 }
  };

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------

  var views = [];            // [{ el, canvas, eng, w, h }]：舞台 + 全屏页各一块
  // 相机层总线：每帧按 priority 升序调用（cinema=10 / focus peek=20 /
  // freecam=30）。层函数只改 ctx，基线/ shake/漂移在层外统一收口。
  var camLayers = [];
  // 交互屏蔽钩子：自由相机启用时由任务 7 注册，bindInteraction 各入口早退。
  var interactionBlocker = null;
  // 各交互入口统一走 blocked 早退：钩子返回 true（自由相机开启/飞回中）时，
  // 原生拖拽/视差/惯性/爆闪/滚轮/双击复位全部不触发，避免与 freecam 双控。
  function blocked(e) { return !!(interactionBlocker && interactionBlocker(e)); }
  var activeIdx = 0;
  var attached = false;
  var wanted = false;        // 用户是否要求启用三维舞台
  var degradedBecause = null;
  var degradedByProbe = false;   // 这次降级是"量出来太贵"，不是"起不来"

  var preset = null;
  var runtime = {};          // 每帧解析结果
  var animations = [];       // 正在跑的 cue 实例
  var section = 'verse';
  var sectionSince = 0;

  // band / rise / agg / feat 都是 onset.js 内部数组与字段的**别名**，不是副本：
  // 频谱纹理每帧要读 64 段，拷一次纯属浪费。检测器同时出逐段（bins / binRise）
  // 和分带（agg）两种粒度，所以两边共用一份不需要谁迁就谁的段数。
  var onset = HAS_ONSET ? Onset.create({ groups: GROUPS, binCount: 64 }) : null;
  var band = onset ? onset.bins : new Float32Array(64);
  var rise = onset ? onset.binRise : new Float32Array(64);
  var agg = onset ? onset.agg : new Float64Array(4);
  var feat = onset;
  var silent = new Float32Array(64);   // 断供时的静默帧
  if (onset) onset.onBeat(onBeat);     // onBeat 是函数声明，已提升，这里可以直接引用

  var cam = { yaw: 0, pitch: 0, dist: 15, shakeYaw: 0, shakePitch: 0 };
  var driftPhase = 0;
  var lastSpectrum = null, lastSpectrumAt = 0;
  var lastT = 0;

  var energyHist = [];       // 每 250ms 一个样本，用来判段落
  var lastHistAt = 0;

  var listeners = [];

  // 探测状态。loss = 1 − 在画帧率 / 静默帧率，是这一层自己吃掉的帧，
  // 不是整页帧率（那会把"这页本来就重"误判成"这台机器不行"）。
  // phase: 'off' 没在测；'base' 静默窗口（这一帧不画 GL）；'draw' 在画窗口。
  var dprStep = 0;
  var adaptSlowMs = 0;
  var probe = { pending: false, running: false, skip: false, phase: 'off',
    frames: 0, elapsed: 0, total: 0,
    base: 0, on: 0, loss: null, rounds: 0 };

  function now() {
    return (window.performance && performance.now) ? performance.now() : Date.now();
  }

  function $(id) { return document.getElementById(id); }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function deep(o) { return JSON.parse(JSON.stringify(o)); }

  function alpha(dtMs, tauMs) { return 1 - Math.exp(-Math.max(0.001, dtMs) / tauMs); }

  // -------------------------------------------------------------------------
  // 参数寻址
  //
  // 路径只有四种前缀：cam. / look. / stage. / sc.
  // 前三种直接落到预置的对应子对象；sc. 落到"当前场景"那一份，所以切场景
  // 不需要搬数据，用户的调参也跟着场景各留一份。
  // -------------------------------------------------------------------------

  // 参数元数据查表。每帧会被调用几百次（每个绑定 + 每个 cue 的每个键都要钳位），
  // 所以缓存两张表：基础表与场景无关，建一次就够；场景表随场景切换重建。
  var baseSpec = null;
  var sceneSpecCache = null, sceneSpecScene = null;

  function buildBaseSpec() {
    baseSpec = {};
    BASE_SPEC.forEach(function (g) {
      (g.items || []).forEach(function (it) { baseSpec[it[0]] = it; });
      (g.selects || []).forEach(function (it) { baseSpec[it[0]] = it; });
    });
  }

  function sceneRow(sceneId, key) {
    var rows = SCENE_SPEC[sceneId] || [];
    for (var i = 0; i < rows.length; i += 1) if (rows[i][0] === key) return rows[i];
    return null;
  }

  function specFor(path) {
    if (!baseSpec) buildBaseSpec();
    if (path.slice(0, 3) !== 'sc.') return baseSpec[path] || null;
    var scene = currentScene();
    if (!sceneSpecCache || sceneSpecScene !== scene) {
      sceneSpecCache = {};
      (SCENE_SPEC[scene] || []).forEach(function (it) { sceneSpecCache['sc.' + it[0]] = it; });
      sceneSpecScene = scene;
    }
    return sceneSpecCache[path] || null;
  }

  // 数值项是 [路径, 名称, min, max, step, 单位, 默认值]，下拉项是
  // [路径, 名称, 选项表, 默认值] —— 长度不同，所以按"第 2 位是不是数字"分流，
  // 不去猜数组长度。
  function clampTo(row, v) {
    if (!row || typeof row[2] !== 'number') return v;
    return clamp(v, row[2], row[3]);
  }

  function clampPath(path, v) { return clampTo(specFor(path), v); }

  /** 这个路径在当前场景下是否可写。未知路径必须被拒绝：写进去的键不会有人读，
   *  但会原样存进预置，再被导出 —— 于是"改了一个不存在的旋钮"会安静地留在
   *  数据里，下次导入时变成一个永远解释不了的字段。 */
  function writable(path) { return !!specFor(path); }

  function currentScene() { return (preset && preset.scene) ? preset.scene : null; }

  function readPath(src, path) {
    var dot = path.indexOf('.');
    var head = path.slice(0, dot), key = path.slice(dot + 1);
    if (head === 'sc') return (src.sc && src.sc[key] !== undefined) ? src.sc[key] : 0;
    return (src[head] && src[head][key] !== undefined) ? src[head][key] : 0;
  }

  function writePath(dst, path, value) {
    var dot = path.indexOf('.');
    var head = path.slice(0, dot), key = path.slice(dot + 1);
    if (head === 'sc') {
      if (!dst.sc) dst.sc = {};
      dst.sc[key] = value;
    } else {
      if (!dst[head]) dst[head] = {};
      dst[head][key] = value;
    }
  }

  // -------------------------------------------------------------------------
  // 预置
  // -------------------------------------------------------------------------
  function sceneDefaults(sceneId) {
    var out = {};
    (SCENE_SPEC[sceneId] || []).forEach(function (row) { out[row[0]] = row[6]; });
    return out;
  }

  function basePreset() {
    var p = { version: 1, name: '未命名舞台', scene: 'towers',
      cam: {}, look: {}, stage: {}, sc: sceneDefaults('towers'),
      cues: [], bindings: [], director: true,
      bg: { type: 'theme' }, hand: { on: false } };
    BASE_SPEC.forEach(function (g) {
      (g.items || []).forEach(function (it) { writePath(p, it[0], it[6]); });
      (g.selects || []).forEach(function (it) { writePath(p, it[0], it[3]); });
    });
    return p;
  }

  // 导入的预置可能来自别的版本（甚至别人手写的 JSON），所以一律走这里过一遍：
  // 未知键丢弃、缺失键补默认值。不做这层清洗的话，多出来的键会让渲染器读到
  // undefined 再把画面算成黑的 —— 一个"什么都没报错但什么都没显示"的坑。
  function normalize(p) {
    var out = basePreset();
    if (!p) return out;
    out.name = typeof p.name === 'string' ? p.name : out.name;
    if (typeof p.id === 'string') out.id = p.id;
    if (typeof p.thumb === 'string') out.thumb = p.thumb;
    if (p.scene && window.CreativeGL && CreativeGL.sceneById(p.scene)) out.scene = p.scene;
    out.sc = sceneDefaults(out.scene);

    ['cam', 'look', 'stage'].forEach(function (k) {
      if (!p[k] || typeof p[k] !== 'object') return;
      Object.keys(p[k]).forEach(function (kk) {
        var path = k + '.' + kk;
        var row = specFor(path);
        if (!row) return;
        var v = p[k][kk];
        // 非数字一律丢弃，而不是 Number() 转一下：字符串转出来的 NaN 会顺着
        // 矩阵一路传到顶点着色器，最后的表现是"整块画面消失"，而控制台干净得
        // 像什么都没发生 —— 最难查的一类故障。
        if (typeof v !== 'number' || !isFinite(v)) return;
        writePath(out, path, clampTo(row, v));
      });
    });
    if (p.sc && typeof p.sc === 'object') {
      Object.keys(p.sc).forEach(function (kk) {
        if (!(kk in out.sc)) return;
        var sv = p.sc[kk];
        if (typeof sv !== 'number' || !isFinite(sv)) return;
        out.sc[kk] = clampTo(sceneRow(out.scene, kk), sv);
      });
    }
    out.cues = Array.isArray(p.cues) ? p.cues.filter(validCue).slice(0, 64) : [];
    out.bindings = Array.isArray(p.bindings) ? p.bindings.filter(validBinding).slice(0, 32) : [];
    out.director = p.director !== false;
    out.bg = (p.bg && typeof p.bg === 'object' && p.bg.type) ? p.bg : { type: 'theme' };
    out.hand = (p.hand && typeof p.hand === 'object') ? p.hand : { on: false };
    return out;
  }

  function validCue(c) {
    if (!c || typeof c !== 'object') return false;
    if (typeof c.at !== 'number' && typeof c.every !== 'number') return false;
    return !!c.set && typeof c.set === 'object';
  }

  function validBinding(b) {
    return !!(b && typeof b.target === 'string' && typeof b.source === 'string');
  }

  // ---------------------------------------------------------------------------
  // 特征提取
  //
  // 判据在 onset.js。这里只剩本层特有的两件事：起音时镜头抖一下、
  // 触发 every=N 的编排 cue（见下面的 onBeat）。
  // ---------------------------------------------------------------------------

  function onBeat() {
    var shake = readPath(runtime, 'cam.shake') / 100;
    cam.shakeYaw += (Math.random() - 0.5) * 0.055 * shake;
    cam.shakePitch += (Math.random() - 0.5) * 0.040 * shake;
    // 编排轨里 every=N 的 cue 由节拍计数触发，不必再自己维护一个 BPM 估计。
    for (var i = 0; i < preset.cues.length; i += 1) {
      var c = preset.cues[i];
      if (typeof c.every === 'number' && c.every > 0 && feat.beats % Math.round(c.every) === 0) {
        fire(c);
      }
    }
  }

  // -------------------------------------------------------------------------
  // cue 动画：一次触发 = 一个从 from 到 to 的缓动，写完自动出栈。
  // -------------------------------------------------------------------------

  function ease(kind, x) {
    if (kind === 'in') return x * x;
    if (kind === 'inout') return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    if (kind === 'linear') return x;
    return 1 - Math.pow(1 - x, 3);          // out，默认
  }

  function fire(cue, lenOverride) {
    var set = cue.set || {};
    var keys = Object.keys(set);
    if (!keys.length) return;
    var from = {};
    keys.forEach(function (k) { from[k] = readPath(runtime, k); });
    animations.push({
      keys: keys, from: from, to: set,
      start: now(),
      len: Math.max(16, lenOverride || cue.len || 600),
      ease: cue.ease || 'out'
    });
    if (animations.length > 24) animations.shift();
  }

  function stepAnimations(t) {
    for (var i = animations.length - 1; i >= 0; i -= 1) {
      var a = animations[i];
      var k = clamp((t - a.start) / a.len, 0, 1);
      var e = ease(a.ease, k);
      for (var j = 0; j < a.keys.length; j += 1) {
        var key = a.keys[j];
        var v = a.from[key] + (a.to[key] - a.from[key]) * e;
        writePath(runtime, key, clampPath(key, v));
      }
      if (k >= 1) animations.splice(i, 1);
    }
  }

  // -------------------------------------------------------------------------
  // 音频绑定：把某个特征值按增益叠到某个参数上。
  // 这是"舞台跟着音乐动"的唯一入口 —— 常量位移写在预置里，动态部分全写在这里，
  // 于是关掉绑定就能得到一张静止的舞台照片，方便调构图。
  // -------------------------------------------------------------------------

  var BIND_SOURCES = {
    'agg.0': function () { return agg[0]; },
    'agg.1': function () { return agg[1]; },
    'agg.2': function () { return agg[2]; },
    'agg.3': function () { return agg[3]; },
    'pulse': function () { return feat.pulse; },
    'energy': function () { return feat.energy; }
  };

  function stepBindings() {
    for (var i = 0; i < preset.bindings.length; i += 1) {
      var b = preset.bindings[i];
      var src = BIND_SOURCES[b.source];
      if (!src) continue;
      var v = readPath(runtime, b.target) + src() * (b.gain === undefined ? 1 : b.gain);
      writePath(runtime, b.target, clampPath(b.target, v));
    }
  }

  // -------------------------------------------------------------------------
  // 自动导演
  //
  // 判段只需要一个比值：短窗能量 / 长窗能量。比值高 = 副歌，低 = 前奏或间奏。
  // 不做真正的结构分析（那需要服务端配合），因为导演的目的是"让画面有起伏"，
  // 不是"标出副歌"；判错的代价只是切换时机差几秒，而收益是不必为每首歌
  // 手动打一份 cue 轨。
  // -------------------------------------------------------------------------

  var SHORT_MS = 1500, LONG_MS = 8000, DWELL_MS = 4500;

  function stepDirector(t) {
    if (!preset.director) return;
    if (t - lastHistAt < 250) return;
    lastHistAt = t;
    energyHist.push(feat.energy);
    if (energyHist.length > LONG_MS / 250) energyHist.shift();
    if (energyHist.length < 6) return;

    var n = energyHist.length;
    var shortN = Math.max(2, Math.round(SHORT_MS / 250));
    var shortSum = 0, longSum = 0;
    for (var i = 0; i < n; i += 1) {
      longSum += energyHist[i];
      if (i >= n - shortN) shortSum += energyHist[i];
    }
    var s = shortSum / Math.min(shortN, n);
    var l = longSum / n;
    var ratio = l > 0.004 ? s / l : 1;

    var want = ratio > 1.22 ? 'chorus' : ratio < 0.72 ? 'quiet' : 'verse';
    if (want === section || t - sectionSince < DWELL_MS) return;
    section = want;
    sectionSince = t;

    var mood = {};
    Object.keys(MOODS[want]).forEach(function (k) {
      mood[k] = clampPath(k, MOODS[want][k]);
    });
    // 机位切一刀，而不是慢慢转过去：段落切换要看得出来。
    mood['cam.yaw'] = readPath(runtime, 'cam.yaw')
      + (Math.random() < 0.5 ? -1 : 1) * (55 + Math.random() * 90);
    mood['cam.yaw'] = clampPath('cam.yaw', mood['cam.yaw']);
    animations.push({ keys: Object.keys(mood), from: null, to: mood,
      start: t, len: want === 'chorus' ? 420 : 1600, ease: 'inout', mood: want });
    // 上面这个动画的 from 要在 stepAnimations 里第一次遇到时补，见下面的补采样。
    document.dispatchEvent(new CustomEvent('creative:section', { detail: { section: want } }));
  }

  // -------------------------------------------------------------------------
  // 全局解析：一帧的参数是"基础值 → 绑定 → 动画"三步叠出来的。
  // -------------------------------------------------------------------------

  function resolve(t) {
    runtime = { cam: {}, look: {}, stage: {}, sc: {} };
    ['cam', 'look', 'stage'].forEach(function (k) {
      Object.keys(preset[k] || {}).forEach(function (kk) { runtime[k][kk] = preset[k][kk]; });
    });
    runtime.sc = deep(preset.sc);

    // 低频跟随：整体抬高机位注视点。放在绑定之前，所以绑定可以再叠加。
    var kick = readPath(runtime, 'cam.kick') / 100;
    runtime.cam.height += agg[0] * kick * 2.2;

    stepBindings();
    stepAnimations(t);
  }

  // -------------------------------------------------------------------------
  // 交互
  //
  // 默认不抢事件：舞台上的歌词行点击要能跳转，粒子层也不吃指针。所以三维层
  // 只有在用户显式打开「舞台交互」之后才接管拖拽 —— 这个开关在工坊的视图页里。
  // 打开后：拖拽转视角、滚轮推拉、单击触发一次爆闪、双击复位。
  // -------------------------------------------------------------------------

  var interact = { on: false, dragging: false, lastX: 0, lastY: 0, moved: 0,
    pid: -1, vx: 0, vy: 0, hadInertia: false,
    zoomTarget: null,
    px: 0, py: 0, parYaw: 0, parPitch: 0 };

  function bindInteraction(el) {
    el.addEventListener('pointerdown', function (e) {
      if (blocked(e)) return;
      if (!interact.on) return;
      if (interact.dragging) return;          // 多指：第二根手指不接管拖拽
      if (e.target.closest && e.target.closest('button, a, input, select, textarea, .stage-lyrics, .lp-body')) return;
      interact.dragging = true;
      interact.pid = e.pointerId;
      interact.moved = 0;
      interact.lastX = e.clientX;
      interact.lastY = e.clientY;
      interact.vx = 0;
      interact.vy = 0;
    });
    el.addEventListener('pointermove', function (e) {
      if (blocked(e)) return;
      if (!interact.on) return;
      // 视差：不拖拽时指针也轻轻推着镜头偏。不写入任何参数，只是渲染层的
      // 一个偏移量 —— 所以 cue、导演、预置数据完全不受它污染。
      var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (r && r.width > 1 && r.height > 1) {
        interact.px = clamp((e.clientX - r.left) / r.width, 0, 1) * 2 - 1;
        interact.py = clamp((e.clientY - r.top) / r.height, 0, 1) * 2 - 1;
      }
      if (!interact.dragging || e.pointerId !== interact.pid) return;
      var dx = e.clientX - interact.lastX;
      var dy = e.clientY - interact.lastY;
      interact.lastX = e.clientX;
      interact.lastY = e.clientY;
      interact.moved += Math.abs(dx) + Math.abs(dy);
      var yawStep = -dx * 0.28;
      var pitchStep = -dy * 0.22;
      // 记住最后的步长当惯性初速度：松手后按这个速度继续滑、指数衰减。
      interact.vx = yawStep;
      interact.vy = pitchStep;
      setParam('cam.yaw', wrap180(readPath(runtime, 'cam.yaw') + yawStep));
      setParam('cam.pitch', readPath(runtime, 'cam.pitch') + pitchStep);
    });
    el.addEventListener('pointerup', function (e) {
      if (blocked(e)) return;
      if (!interact.on || !interact.dragging) return;
      if (e.pointerId !== interact.pid) return;
      interact.dragging = false;
      // 位移小于 4px 才算点击：否则每一次拖完视角都会附带一次爆闪。
      if (interact.moved < 4) { interact.vx = 0; interact.vy = 0; burst(e); }
    });
    el.addEventListener('pointercancel', function () { interact.dragging = false; });
    el.addEventListener('wheel', function (e) {
      if (blocked(e)) return;
      if (!interact.on) return;
      e.preventDefault();
      // 只记目标值，真正的移动在渲染帧里做平滑趋近 —— 滚轮事件是离散的，
      // 直接写参数的话每一格都是一次跳变。
      var base = (interact.zoomTarget === null) ? readPath(runtime, 'cam.dist') : interact.zoomTarget;
      interact.zoomTarget = clampPath('cam.dist', base + Math.sign(e.deltaY) * 1.2);
    }, { passive: false });
    el.addEventListener('dblclick', function (e) { if (blocked(e)) return; resetView(); });
  }

  // 每帧的交互连续量：拖拽惯性、滚轮缩放的平滑趋近、指针视差。
  // 全部放在渲染帧里推进，与事件循环解耦 —— 事件是离散的，画面是连续的。
  function stepInteraction(dtMs) {
    // 交互屏蔽（自由相机开启/飞回中）：事件入口虽已早退，这里仍要把视差目标
    // 归零，让已平滑出去的残差用下面的 520ms 收回；同时解除"拖拽中被切走"
    // 留下的 dragging 闩锁（pointerup 在屏蔽期被吞）。惯性/滚轮不动基线外
    // 的量，保持原衰减路径。
    var interactionBlocked = !!(interactionBlocker && interactionBlocker(null));
    if (interactionBlocked) {
      interact.dragging = false;
      // 视差采样一并清零：屏蔽解除时不会朝旧指针位置缓动。
      interact.px = 0;
      interact.py = 0;
    }
    // 惯性：松手后按最后的步长继续滑，指数衰减到停。
    if (interact.on && !interact.dragging && (Math.abs(interact.vx) > 0.02 || Math.abs(interact.vy) > 0.02)) {
      interact.hadInertia = true;
      var k = Math.exp(-dtMs / 260);
      writePath(preset, 'cam.yaw', clampPath('cam.yaw', wrap180(readPath(runtime, 'cam.yaw') + interact.vx)));
      writePath(runtime, 'cam.yaw', clampPath('cam.yaw', wrap180(readPath(runtime, 'cam.yaw') + interact.vx)));
      writePath(preset, 'cam.pitch', clampPath('cam.pitch', readPath(runtime, 'cam.pitch') + interact.vy));
      writePath(runtime, 'cam.pitch', clampPath('cam.pitch', readPath(runtime, 'cam.pitch') + interact.vy));
      interact.vx *= k;
      interact.vy *= k;
    } else if (interact.hadInertia) {
      // 惯性停稳的那一拍才落盘 + 广播：滑动期间每帧都 emit 的话面板会一直重排。
      interact.hadInertia = false;
      interact.vx = 0;
      interact.vy = 0;
      saveLocalSoon();
      emit('param', { path: 'cam.yaw', value: readPath(runtime, 'cam.yaw') });
    }

    // 滚轮缩放：向目标值趋近，到位即清。
    if (interact.zoomTarget !== null) {
      var cur = readPath(runtime, 'cam.dist');
      var next = cur + (interact.zoomTarget - cur) * alpha(dtMs, 90);
      if (Math.abs(next - interact.zoomTarget) < 0.03) {
        next = interact.zoomTarget;
        interact.zoomTarget = null;
      }
      writePath(preset, 'cam.dist', next);
      writePath(runtime, 'cam.dist', next);
    }

    // 视差：慢速跟随，幅度刻意小（±2° 上下），只是"舞台活着"的呼吸感。
    // 交互关掉时目标归零，镜头悄悄回正。
    var pk = alpha(dtMs, 520);
    var tpx = (interact.on && !interactionBlocked) ? interact.px : 0;
    var tpy = (interact.on && !interactionBlocked) ? interact.py : 0;
    interact.parYaw += (tpx * 0.038 - interact.parYaw) * pk;
    interact.parPitch += (tpy * 0.024 - interact.parPitch) * pk;
  }

  function wrap180(v) { while (v > 180) v -= 360; while (v < -180) v += 360; return v; }

  // 单击爆闪：走的是和 cue 同一条动画通道，所以工坊里能看见它、也能禁掉。
  // 刻意不改几何：点击处变亮靠的是色散与泛光的位移感，而不是真的塞一个点光源
  // 进场景 —— 后者要求每个场景都支持一个光源接口，成本与收益不成比例。
  function burst(e) {
    var v = views[activeIdx];
    var el = v && v.canvas;
    var py = 0.5;
    if (el && el.getBoundingClientRect && e && e.clientY !== undefined) {
      var r = el.getBoundingClientRect();
      py = clamp((e.clientY - r.top) / Math.max(1, r.height), 0, 1);
    }
    animations.push({
      keys: ['look.bloom', 'look.chroma'],
      from: null,
      to: { 'look.bloom': clampPath('look.bloom', readPath(runtime, 'look.bloom') * 2.1 + 0.5),
        'look.chroma': clampPath('look.chroma', 1.4 + py * 0.6) },
      start: now(), len: 160, ease: 'out', flash: true
    });
  }

  // 双击复位：基础值立刻落到目标（保证动画出栈后不会回弹），同时推一个
  // 从当前值出发的补间 —— 于是看到的是镜头"滑回去"，而不是跳回去。
  function resetView() {
    var target = { 'cam.yaw': 0, 'cam.pitch': 14, 'cam.dist': specFor('cam.dist')[6] };
    Object.keys(target).forEach(function (k) { writePath(preset, k, target[k]); });
    interact.zoomTarget = null;
    interact.vx = 0;
    interact.vy = 0;
    cam.shakeYaw = 0;
    cam.shakePitch = 0;
    animations.push({ keys: Object.keys(target), from: null, to: target,
      start: now(), len: 550, ease: 'inout' });
    saveLocalSoon();
    emit('preset', preset);
  }

  // 写回的是预置的基础值，所以手动拖动会覆盖上一轮导演的落点 —— 这是有意的：
  // 用户一动，导演的这次落点就作废，否则滑块会在松手的瞬间被弹回去。
  // 暂停 + 帧门停机时，滑块的改动不会等到"下一帧"——没有下一帧。
  // 用 16ms 的短延时把一串拖动事件合并成至多约 60 次/秒的补帧，
  // 既实时，又保证松手后最后一次取值一定被画出来。
  var kickQueued = false;
  function kickStaticFrame() {
    if (targetFps() > 0 || kickQueued) return;
    kickQueued = true;
    setTimeout(function () {
      kickQueued = false;
      try { tick(16.7); } catch (e) { /* 页面正在拆卸等瞬态：忽略这一补帧 */ }
    }, 16);
  }

  function setParam(path, v) {
    if (!writable(path)) return;
    var val = clampPath(path, v);
    writePath(preset, path, val);
    writePath(runtime, path, val);
    emit('param', { path: path, value: val });
    saveLocalSoon();
    kickStaticFrame();
  }

  // -------------------------------------------------------------------------
  // StageIntent：提示词编译器（creative-prompt.js）产出的窄协议，经这里一次性
  // 落到预置上。它是 patch 之外的第二个原子写入口 —— 只新增、不替代：现有
  // API（setScene/setParam/setPreset…）语义不变，工坊也绝不允许拿一串 setter
  // 去拼一个"生成的舞台"，那样会产生场景已切、参数未到的半应用状态。
  //
  // 流程与 setScene/setPreset 同源：从 deep(preset) 起步 → 校验与钳位全部
  // 通过后才上任 → normalize/resolve/applyHand/saveLocalSoon/emit 各恰好一次。
  // 校验失败时返回 {ok:false,...} 且一个字节都不写。
  // -------------------------------------------------------------------------

  // patch 路径的权威校验。sc. 前缀指向**目标场景**的那一行 —— 编译器按约定
  // 不产出 sc.*，但手写意图可能有，必须在切场景后的视角下校验。
  function intentRowFor(path, sceneId) {
    if (path.slice(0, 3) !== 'sc.') return specFor(path);
    return sceneRow(sceneId, path.slice(3));
  }

  function applyIntent(intent) {
    if (!intent || typeof intent !== 'object' || intent.version !== 1) {
      return { ok: false, code: 'bad_version', message: '意图版本不受支持' };
    }
    if (!preset) {
      return { ok: false, code: 'bad_state', message: '舞台尚未初始化' };
    }
    var hasScene = typeof intent.scene === 'string' && !!intent.scene;
    var hasDirector = typeof intent.director === 'boolean';
    var hasHand = !!(intent.hand && typeof intent.hand === 'object'
      && typeof intent.hand.on === 'boolean');
    var patchKeys = (intent.patch && typeof intent.patch === 'object')
      ? Object.keys(intent.patch) : [];
    if (!hasScene && !hasDirector && !hasHand && !patchKeys.length) {
      return { ok: false, code: 'empty', message: '意图不包含任何可应用的改变' };
    }
    if (hasScene && (!window.CreativeGL || !CreativeGL.sceneById(intent.scene))) {
      return { ok: false, code: 'bad_scene', message: '未知场景：' + intent.scene };
    }

    var next = deep(preset);
    var applied = [];
    var ignored = [];
    var changed = false;
    var sceneSwitched = hasScene && intent.scene !== preset.scene;

    // 切场景：私有参数整体换成目标场景的默认值，机位落到入画点。与 setScene
    // 同语义（含"同场景不算切换、不重置用户调参"），但先建好再上任，中途
    // 不广播。patch 在机位落位之后应用 —— 意图里明确写了的值优先于场景默认。
    if (sceneSwitched) {
      next.scene = intent.scene;
      next.sc = sceneDefaults(intent.scene);
      var camTo = SCENE_CAM[intent.scene];
      if (camTo) {
        Object.keys(camTo).forEach(function (k) {
          writePath(next, k, clampPath(k, camTo[k]));
        });
      }
      changed = true;
    }

    patchKeys.forEach(function (path) {
      var v = intent.patch[path];
      if (typeof v !== 'number' || !isFinite(v)) { ignored.push(path); return; }
      var row = intentRowFor(path, next.scene);
      if (!row) { ignored.push(path); return; }
      var val;
      if (Array.isArray(row[2])) {
        // 下拉项（look.grade）没有量程：按选项序号取整并夹进有效档位。
        val = clamp(Math.round(v), 0, row[2].length - 1);
      } else {
        val = clampTo(row, v);
      }
      writePath(next, path, val);
      applied.push(path);
      changed = true;
    });

    if (hasDirector) { next.director = intent.director; changed = true; }
    if (hasHand) {
      // 首期意图只表达 on；jitter/frame/wave 等用户设置原样保留
      next.hand = Object.assign({}, next.hand, { on: intent.hand.on });
      changed = true;
    }

    if (!changed) {
      return { ok: false, code: 'empty',
        message: '意图与当前舞台一致，没有需要应用的改变' };
    }

    if (sceneSwitched) animations.length = 0;   // 旧场景的 cue 动画不跨场景续跑
    preset = normalize(next);
    runtime = {};
    resolve(now());
    applyHand();
    saveLocalSoon();
    emit('preset', preset);
    return { ok: true, preset: deep(preset), applied: applied, ignored: ignored };
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  function tierIndex() {
    var t = window.Stage ? Stage.tier() : 2;
    return t < 0 ? 0 : t > 2 ? 2 : t;
  }

  function targetFps() {
    if (!attached || !wanted || !views.length) return 0;
    if (window.Stage && Stage.isHidden()) return 0;
    // 活动画布不可见就一帧都不画：窄屏抽屉关着时舞台画布只是被 transform
    // 移出屏幕，尺寸与上下文都在，不挡这一下 GPU 就一直空烧。全屏页开着时
    // 活动的是第二块画布，与抽屉无关（isPageOpen 为真即放行）。
    if (window.Stage && !Stage.isPageOpen()
        && typeof Stage.isStageVisible === 'function' && !Stage.isStageVisible()) return 0;
    // 探测期间强制满帧：不画东西的窗口量不到代价，而"暂停且无动画"时帧门本来是 0，
    // 拿它当基准会得出一个自信的错误结论。探测一结束这条就退场，预算恢复原样。
    if (probe.pending || probe.running) return TIERS[tierIndex()].fps;
    var playing = document.body.classList.contains('is-playing');
    var busy = feat.pulse >= 0.01 || animations.length > 0;
    if (!playing && !busy) return 0;
    if (!playing) return 8;
    return TIERS[tierIndex()].fps;
  }

  function pickView() {
    var want = (window.Stage && Stage.isPageOpen()) ? 1 : 0;
    if (want !== activeIdx) {
      // 切挂载点时立刻给新视图补一帧：暂停状态下帧门是 0，不补这一帧的话
      // 全屏页会是一块空白，直到用户按下播放才突然出现。
      activeIdx = want;
      var next = views[activeIdx];
      if (next) {
        measure(next);
        // 补的这一帧是给用户看的，静默窗口要为它让路：全屏页不能为了测得准
        // 而先空 500ms。代价是一帧重活混进了基线窗口，约 4%，方向是把损失估小
        // 一点 —— 所以 PROBE_KEEP 的余量里已经含了它。
        var saved = probe.phase;
        probe.phase = 'draw';
        renderOne(next, 16);
        probe.phase = saved;
      }
    }
    return views[activeIdx];
  }

  function measure(v, force) {
    // force 只有一处用：探测往下让档时，即使元素尺寸没变也必须重设后备缓冲，
    // 否则 DPR 折扣只写进了变量，画面还是上一档的分辨率。
    if (!v || !v.el) return false;
    var r = v.el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    var quality = tierIndex();
    // 工坊开着的时候这块画布是用户正在调参数的预览：低档 0.55/0.85 的 DPR
    // 在这里读作"糊成一团"。预览场景帧率压力小，抬到 0.9 起步，聆听时不变。
    // （用 window 判而非 global：本文件要过 Node 无头契约扫描。）
    var dprFloor = (typeof window !== 'undefined' && window.Workshop && window.Workshop.isOpen()) ? 0.9 : 0;
    var d = Math.min(window.devicePixelRatio || 1, 1.5)
      * Math.max(TIERS[quality].dpr, dprFloor) * DPR_STEPS[dprStep];
    if (v.w === Math.round(r.width) && v.h === Math.round(r.height)
        && v.dpr === d && v.quality === quality && !force) return true;
    v.w = Math.round(r.width);
    v.h = Math.round(r.height);
    v.dpr = d;
    v.quality = quality;
    if (v.eng) v.eng.resize(v.w, v.h, d);
    return true;
  }

  function tick(dtMs) {
    // 顺序要紧：先推进探测的状态，本帧才拿得到正确的静默判定；
    // 探测还没开始时，这一步顺手把它起来。
    maybeProbe();
    stepProbe(dtMs);
    var v = pickView();
    if (!v || !v.eng) return;
    // 纵深第二道：正常路径里帧门 fpsFn 在不可见时已报 0、stage.js 不会把
    // tick 调进来；但补帧等旁路仍可能直接触达这里，挡住，不往不可见画布渲染。
    if (window.Stage && !Stage.isPageOpen()
        && typeof Stage.isStageVisible === 'function' && !Stage.isStageVisible()) return;
    if (!v.w || !v.h) { if (!measure(v)) return; }
    renderOne(v, dtMs);
  }

  // 一帧只在活动视图的那个引擎上跑：另一个停着不画，省下来的 GPU 时间正好
  // 留给后处理链；切回去时由 pickView 触发一次即时重绘。
  function renderOne(v, dtMs) {
    var t = now();
    var sp = window.Stage ? Stage.spectrum() : null;
    if (sp && sp.length && sp !== lastSpectrum) { lastSpectrum = sp; lastSpectrumAt = t; }
    var fresh = !!(sp && sp.length) && lastSpectrumAt > 0 && (t - lastSpectrumAt < 600);
    onset.step(dtMs, fresh ? sp : silent, now());

    resolve(t);
    stepDirector(t);
    // 导演推进去的动画没有 from（它是"从当前值到目标值"的相对运动）。
    // 补采样放在这里而不是 fire 里：此刻 runtime 还是上一帧的稳定值，
    // 补出来的起点与屏幕上正在显示的那一帧一致，不会看到一次回跳。
    for (var i = 0; i < animations.length; i += 1) {
      var a = animations[i];
      if (!a.from) {
        a.from = {};
        a.keys.forEach(function (k) { a.from[k] = readPath(runtime, k); });
      }
    }

    // --- 相机：基线 → camLayers（cinema/peek/freecam）→ 漂移 → shake ---
    stepInteraction(dtMs);
    var driftBase = readPath(runtime, 'cam.drift') / 100;
    driftPhase += dtMs / 1000 * 0.12 * driftBase;
    cam.shakeYaw *= Math.exp(-dtMs / 130);
    cam.shakePitch *= Math.exp(-dtMs / 130);
    var ctx = {
      t: t,
      dtMs: dtMs,
      scene: preset.scene,
      play: document.body.classList.contains('is-playing'),
      readPath: function (p) { return readPath(runtime, p); },
      // 基线（preset/滑块/导演），层函数读它但不改它。
      baseYawDeg: readPath(runtime, 'cam.yaw'),
      basePitchDeg: readPath(runtime, 'cam.pitch'),
      baseDist: readPath(runtime, 'cam.dist'),
      baseFov: readPath(runtime, 'cam.fov'),
      baseHeight: readPath(runtime, 'cam.height'),
      // 层输出：cinema 乘 fov/dist/加 roll；peek/freecam 直接覆盖机位。
      yawDeg: readPath(runtime, 'cam.yaw'),
      pitchDeg: readPath(runtime, 'cam.pitch'),
      dist: readPath(runtime, 'cam.dist'),
      fov: readPath(runtime, 'cam.fov'),
      tx: 0,
      ty: readPath(runtime, 'cam.height'),
      tz: 0,
      rollDeg: 0,
      // 漂移倍率（cinema 在 intensity 3 时抬到 1.4；freecam 置 0）。
      driftMul: 1,
      // 自由相机全开标志（目前只作观测，不参与合成分支）。
      freecam: false
    };
    for (var li = 0; li < camLayers.length; li += 1) {
      try { camLayers[li].fn(ctx); } catch (e) { /* 单层抛错不能拖垮帧循环 */ }
    }

    var drift = driftBase * ctx.driftMul;
    var yaw = (ctx.yawDeg * Math.PI / 180)
      + Math.sin(driftPhase) * 0.22 * drift + cam.shakeYaw + interact.parYaw;
    var pitch = clamp((ctx.pitchDeg * Math.PI / 180)
      + Math.sin(driftPhase * 0.73 + 1.1) * 0.10 * drift + cam.shakePitch + interact.parPitch, -1.35, 1.35);
    // agg kick 是基线音频响应，对所有层生效；near plane 0.1，dist 不得贴到 0.3 以下。
    var dist = Math.max(0.3, ctx.dist
      * (1 - agg[0] * 0.06 * (readPath(runtime, 'cam.kick') / 100)));

    var rot = readPath(runtime, 'stage.rotY') * Math.PI / 180 + driftPhase * 0.25 * drift;
    var sc = readPath(runtime, 'stage.scale');

    var state = {
      t: t, dt: dtMs,
      bands: band, rises: rise, agg: agg,
      pulse: feat.pulse, energy: feat.energy,
      play: document.body.classList.contains('is-playing'),
      seed: readPath(runtime, 'stage.seed'),
      scene: preset.scene,
      quality: tierIndex(),
      p: runtime.sc,
      // 三维歌词场景的只读歌词快照（行数组 + 当前行号）；其它场景忽略。
      lyric: (window.Stage && Stage.lyrics) ? Stage.lyrics() : null,
      cam: { yaw: yaw, pitch: pitch, dist: dist,
        fov: ctx.fov,
        tx: ctx.tx, ty: ctx.ty, tz: ctx.tz,
        roll: ctx.rollDeg * Math.PI / 180 },
      colors: colors(),
      // 模型矩阵只承载绕 Y 旋转与整体缩放，但仍然走完整的 mat4：towers 场景
      // 的地面倒影需要把它整体换成镜像矩阵再画一遍，接口一致才不用特殊分支。
      modelMatrix: makeRotScale(rot, sc),
      post: {
        bloom: readPath(runtime, 'look.bloom'),
        bloomThresh: readPath(runtime, 'look.bloomThresh'),
        chroma: readPath(runtime, 'look.chroma'),
        vignette: readPath(runtime, 'look.vignette'),
        grain: readPath(runtime, 'look.grain'),
        toon: readPath(runtime, 'look.toon'),
        paper: readPath(runtime, 'look.paper'),
        exposure: readPath(runtime, 'look.exposure'),
        saturation: readPath(runtime, 'look.saturation'),
        grade: readPath(runtime, 'look.grade') | 0
      }
    };
    lastT = t;

    // 静默窗口：这一层什么都不画，但上面那一大堆（起音、解析、导演、相机、
    // state 组装）照常跑 —— 探测要量的正是"GL 与后处理值多少帧"，把 CPU 那半
    // 也一起停掉的话，量出来的是整层的代价而不是差异。
    // 手绘与背景不在静默范围内：它们是另外两层，不该被算进三维的账。
    if (!probeMuted()) {
      var frameStart = now();
      var r = v.eng.render(state);
      if (r && r.ok === false) {
        if (r.reason === 'shader') {
          // 着色器挂了：把 GL 的日志原文带出来（消息里会写清楚是场景还是后处理
          // 那三个 program 之一）。这几乎只会发生在自己改过片段之后，
          // 用户需要看到是哪一行。
          degrade('着色器编译失败：' + (r.message || '').split('\n')[0], false, true);
          return;
        }
        // 上下文没了（驱动重置、系统休眠回来、GPU 进程换了）：这一层已经画不出
        // 任何东西，而 canvas 还留在舞台上糊着一张定格画面。必须走降级，
        // 让粒子层接管并把画布摘掉 —— 只靠 webglcontextrestored 是等不来的。
        if (r.reason === 'context-lost') { degrade('WebGL 上下文在运行中丢失', false, true); return; }
      }
      if (r && r.ok) {
        var frameMs = now() - frameStart;
        var budget = 1000 / TIERS[tierIndex()].fps;
        adaptSlowMs = frameMs > budget * 1.35 ? adaptSlowMs + dtMs : 0;
        if (adaptSlowMs >= 1800 && dprStep < DPR_STEPS.length - 1) {
          dprStep += 1;
          views.forEach(function (item) { measure(item, true); });
          adaptSlowMs = 0;
        }
      }
    }
    if (window.HandDrawn) HandDrawn.frame(state);
    if (window.Backgrounds) Backgrounds.frame(state);
  }

  function makeRotScale(rotY, scale) {
    var c = Math.cos(rotY) * scale, s = Math.sin(rotY) * scale;
    var m = new Float32Array(16);
    m[0] = c; m[1] = 0; m[2] = -s; m[3] = 0;
    m[4] = 0; m[5] = scale; m[6] = 0; m[7] = 0;
    m[8] = s; m[9] = 0; m[10] = c; m[11] = 0;
    m[12] = 0; m[13] = 0; m[14] = 0; m[15] = 1;
    return m;
  }

  function colors() {
    var a = cssRgb('--music-highlight-rgb', '226, 176, 113');
    var b = cssRgb('--music-highlight-alt-rgb', null) || a;
    return [a, b];
  }

  function cssRgb(name, fallback) {
    var raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!raw && fallback) raw = fallback;
    if (!raw) return null;
    var p = raw.split(',');
    return [
      clamp(parseFloat(p[0]) / 255 || 0, 0, 1),
      clamp(parseFloat(p[1]) / 255 || 0, 0, 1),
      clamp(parseFloat(p[2]) / 255 || 0, 0, 1)
    ];
  }

  // -------------------------------------------------------------------------
  // 渲染代价探测（串行 A/B）
  //
  // 为什么不用 stage.js 那个全局帧率探针的结论来判：那个数反映的是**整页**
  // （backdrop-filter、歌词、别层的动画都算在里面），而这里要回答的问题是
  // "三维 + 后处理这条链值多少帧"。拿整页帧率判一个子模块，会把"这页本来就重"
  // 误判成"这台机器不行"，反过来也会漏掉真正拖帧的情况。所以做 A/B：同一台机器、
  // 同一个时刻，先量本层静默时的帧率，再量按当前预算画的帧率，比的是差值。
  //
  // 为什么必须有它：TIERS 是按设备档静态选的，而设备档只看核心数 / 内存 / 像素数。
  // 核显的真实填充率推不出来 —— 没有测量手段就不知道该降到哪一档，
  // "降 DPR 比降帧率划算"这条原则也就落不了地。
  //
  // 为什么是状态机而不是 Promise + 自己一条 rAF：全页只允许 stage.js 里那一个
  // requestAnimationFrame，其它层一律通过帧门登记。自己再开一条循环不只是多一次
  // 布局/样式计算，它还会在标签页被切走的那一刻停摆，把一个"静默"标记永久留在
  // true —— 那一层就再也不画了，而且控制台干净得像什么都没发生。挂在帧门的
  // dtMs 上数帧，探测与渲染共用同一条命脉，不可能失步。
  // -------------------------------------------------------------------------

  function cancelProbe() {
    probe.running = false;
    probe.pending = false;
    probe.phase = 'off';
  }

  // 这一帧该不该跳过 GL。
  function probeMuted() { return probe.running && probe.phase === 'base'; }

  function beginProbe() {
    probe.pending = false;
    probe.running = true;
    probe.phase = 'base';
    probe.frames = 0;
    probe.elapsed = 0;
    probe.total = 0;
  }

  function maybeProbe() {
    if (!probe.pending || probe.running || probe.skip) return;
    // 页面藏着的时候不测：那时帧门本来就停着，dt 是切回来时截断出来的 200ms，
    // 拿它算出来的"帧率"是一个自信的错误结论。
    if (window.Stage && Stage.isHidden()) return;
    // 抽屉关着同样不测：不可见画布上跑出来的帧数不代表用户要付的代价。
    if (window.Stage && !Stage.isPageOpen()
        && typeof Stage.isStageVisible === 'function' && !Stage.isStageVisible()) return;
    beginProbe();
  }

  // 由 tick 每帧推进。phase==='base' 的那段窗口里 renderOne 不画 GL（见那里）。
  function stepProbe(dtMs) {
    if (!probe.running) return;
    // 兜底：正常一轮是 base+draw 两个 500ms，最多三次降档 ≈ 3s。超过这个数还
    // 没收尾，说明 dt 的来源不正常（页面被冻结、门被别处停掉），放弃这次测量，
    // 带着当前预算继续跑 —— 探测失败的后果应该是"没测到"，不是"画面没了"。
    probe.total += dtMs;
    if (probe.total > PROBE_WINDOW * 16) { cancelProbe(); return; }

    probe.frames += 1;
    probe.elapsed += dtMs;
    if (probe.elapsed < PROBE_WINDOW) return;
    var fps = probe.frames / (probe.elapsed / 1000);
    probe.frames = 0;
    probe.elapsed = 0;

    if (probe.phase === 'base') {
      probe.base = Math.round(fps);
      probe.phase = 'draw';
      return;
    }
    probe.on = Math.round(fps);
    probe.rounds += 1;
    // 任一侧量到 0 帧就没有可比性（例如刚切进来那一帧的 dt 是截断值）：判"没代价"，
    // 而不是判"代价 100%"。宁可漏降一档，也不要把一个能用的舞台关掉。
    probe.loss = (probe.base > 0 && probe.on > 0) ? Math.max(0, 1 - probe.on / probe.base) : 0;
    var loss = probe.loss;

    if (loss > PROBE_KEEP && dprStep < DPR_STEPS.length - 1) {
      dprStep += 1;
      views.forEach(function (v) { measure(v, true); });
      probe.phase = 'base';        // 分辨率变了，上一轮的基线作废，重走一遍
      return;
    }
    cancelProbe();
    if (loss > PROBE_OFF) {
      degrade('本机 GPU 上三维层代价过高（帧率下降 ' + Math.round(loss * 100)
        + '%，降到最低渲染分辨率仍如此）', true, true);
      return;
    }
    emit('probe', probeInfo());
  }

  function probeInfo() {
    return {
      loss: probe.loss === null ? null : Number(probe.loss.toFixed(3)),
      base: probe.base, on: probe.on, rounds: probe.rounds,
      dprScale: DPR_STEPS[dprStep], step: dprStep,
      pending: probe.pending, running: probe.running, skipped: probe.skip,
      // 静默窗口里这一层不画 GL。测试用它把"探测期间少画的那些帧"对上账，
      // 也就顺手钉住了 A/B 的隔离性：基线窗口里真的一次都没画。
      muted: probeMuted()
    };
  }

  // -------------------------------------------------------------------------
  // 挂载 / 降级
  // -------------------------------------------------------------------------

  function mountView(el) {
    if (!el) return null;
    var c = document.createElement('canvas');
    c.className = 'creative-canvas';
    c.setAttribute('aria-hidden', 'true');
    // 必须是第一个孩子：三维场景在最底下，歌词、唱盘、粒子层都压在它上面。
    // 反过来放会让文字被场景糊住，而且是那种"看上去只是有点脏"的糊。
    el.insertBefore(c, el.firstChild);
    return { el: el, canvas: c, eng: null, w: 0, h: 0, dpr: 0 };
  }

  // 只在两个挂载点上切可见性与那个抬层类的开关。
  function showViews(on) {
    for (var i = 0; i < views.length; i += 1) {
      var v = views[i];
      v.el.classList.toggle('creative-on', on);
      // 关掉时必须把画布一起藏掉。只停渲染、画布留在 DOM 里，最后一帧会一直
      // 糊在舞台上 —— 用户看到的是"三维已经关了，画面还在"。
      if (v.canvas) v.canvas.style.display = on ? '' : 'none';
    }
    document.documentElement.classList.toggle('creative-3d', on && !!views.length);
  }

  // 真拆： dispose 上下文 + 把画布从 DOM 摘掉。降级走这条，强制重试也走这条。
  function teardown() {
    for (var i = 0; i < views.length; i += 1) {
      var v = views[i];
      if (v.eng) { try { v.eng.dispose(); } catch (e) { /* 上下文没了就算了 */ } v.eng = null; }
      if (v.canvas && v.canvas.parentNode) v.canvas.parentNode.removeChild(v.canvas);
      v.el.classList.remove('creative-on', 'creative-interact');
    }
    views = [];
    attached = false;
    document.documentElement.classList.remove('creative-3d');
  }

  // 立刻补一帧。帧门在"暂停且无动画"时本来就返回 0，而 stage.js 的 rAF 此刻可能
  // 已经停转（不播放、别的层也不要帧），不补这一帧的话用户拨开开关看到的是一块
  // 空白舞台，非得按下播放才有画面。
  function refreshViews() {
    if (!preset) return;
    for (var i = 0; i < views.length; i += 1) {
      if (views[i].eng) { measure(views[i]); renderOne(views[i], 16.7); }
    }
  }

  // 舞台与全屏页是两个挂载点，各自一块画布 —— 一个 canvas 只能有一个 GL 上下文，
  // 共用画布就要在切页时重建上下文（几百毫秒卡顿 + 显存抖动）。各开一个引擎之后，
  // 切页只是换一个渲染目标，预置、状态、参数全都不动。
  function attach(enable, opts) {
    wanted = !!enable;
    if (!wanted) {
      // 关掉只是不画：GL 上下文与探测结论都留着。用户来回拨这个开关时，
      // 不该每次都重编五个场景的着色器、也不该再被量一遍代价。
      // 但测到一半要取消 —— 帧门停了以后 dt 不再进来，一个悬着的静默窗口
      // 会在下一次开启时先什么都不画地跑几百毫秒。
      cancelProbe();
      showViews(false);
      return 'off';
    }
    if (opts && opts.force && degradedBecause) {
      // 降级之后再点"开启"是一次明确的重试：上一次的结论作废。
      // 只有"被探测劝退"这一种重试才顺带关掉后续探测 —— 用户是在否定那次测量，
      // 而不是在否定 WebGL。硬故障（没有 WebGL2）之后重试，测不测都无所谓，
      // 留着探测才对：万一这次真的起来了呢。
      if (degradedByProbe) probe.skip = true;
      degradedByProbe = false;
      degradedBecause = null;
      dprStep = 0;
      adaptSlowMs = 0;
      probe.loss = null;
      teardown();
    }
    if (attached) { showViews(true); refreshViews(); return effective(); }

    if (!window.CreativeGL || !CreativeGL.isAvailable()) {
      degrade(window.CreativeGL ? '本设备不支持 WebGL2' : '三维舞台模块未加载');
      return 'off';
    }
    // 没有 onset.js 就没有"鼓点"：pulse 永远停在 0，于是镜头抖动、kick 联动、
    // every=N 的编排 cue 全部静默失效，而画面看着还在正常渲染 —— 这种
    // "活着但错着"的状态必须报出来，而不是让它悄悄跑着。
    if (!onset) { degrade('onset.js 未加载，起音检测不可用'); return 'off'; }
    var stageEl = $('stage');
    var pageEl = $('lyric-page');
    var a = mountView(stageEl);
    if (!a) { degrade('找不到舞台容器'); return 'off'; }
    views = [a];
    var b = mountView(pageEl);
    if (b) views.push(b);

    views.forEach(function (v) {
      try {
        v.eng = CreativeGL.create(v.canvas, { quality: tierIndex() });
      } catch (e) { v.eng = null; }
      if (v.eng) v.eng.warmUp();
    });
    if (!views[0].eng) { degrade('创建 WebGL2 上下文失败'); return 'off'; }

    attached = true;
    activeIdx = 0;
    // 不能写成 views.forEach(measure)：forEach 把下标当第二个参数传进去，
    // 而第二个参数是 force —— 第 1 号视图会因此每次量尺寸都无条件重设后备缓冲。
    views.forEach(function (v) { measure(v); });
    views.forEach(function (v) { bindInteraction(v.el); });
    showViews(true);
    refreshViews();

    if (window.Stage && Stage.gate) Stage.gate('creative', targetFps, tick);

    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () {
        views.forEach(function (v) { measure(v); });
      });
      views.forEach(function (v) { ro.observe(v.el); });
    }
    // 一次会话只量一次代价（降到的档位是这台机器的属性，不是这一首歌的属性）。
    // 真正的测量等第一次"确实在画"时再开始，见 tick 里的 maybeProbe。
    if (!probe.skip && probe.loss === null) probe.pending = true;
    return effective();
  }

  function degrade(reason, byProbe, runtime) {
    degradedByProbe = !!byProbe;
    degradedBecause = reason;
    wanted = false;
    cancelProbe();
    teardown();
    // runtime=true 表示"已经在画的过程中被摘掉"（上下文丢失、着色器失败、
    // 探测判定代价过高）。attach 启动期的失败由 applyCreative 自己处理，
    // app.js 只消费 runtime 事件，避免两处重复提示与回报。
    document.dispatchEvent(new CustomEvent('creative:degrade', {
      detail: { reason: reason, runtime: !!runtime }
    }));
  }

  function effective() { return (wanted && !degradedBecause && views.length) ? '3d' : 'off'; }

  // -------------------------------------------------------------------------
  // 预置库：优先写服务端 settings（换浏览器也在），失败退回 localStorage。
  // 这是 README 里"不依赖 localStorage 存设置"那条约定的落地：本机缓存只是
  // 离线兜底，权威副本在 SQLite 里。
  // -------------------------------------------------------------------------

  var library = [];

  function api() {
    var t = window.VMusicTransport;
    if (!t) return null;
    return t;
  }

  function loadLibrary() {
    var t = api();
    if (!t) return Promise.resolve(readLocalLibrary());
    return t.get('/v1/settings').then(function (all) {
      var raw = all && all[SERVER_KEY];
      if (Array.isArray(raw)) { library = raw; writeLocalLibrary(raw); return raw; }
      var local = readLocalLibrary();
      if (local.length) t.put('/v1/settings', kv(SERVER_KEY, local)).catch(function () {});
      return local;
    }).catch(function () { return readLocalLibrary(); });
  }

  function kv(k, v) { var o = {}; o[k] = v; return o; }

  function readLocalLibrary() {
    try {
      var raw = localStorage.getItem(LOCAL_LIB_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function writeLocalLibrary(arr) {
    try { localStorage.setItem(LOCAL_LIB_KEY, JSON.stringify(arr)); } catch (e) { /* 隐私模式 */ }
  }

  function persistLibrary() {
    writeLocalLibrary(library);
    var t = api();
    if (t) t.put('/v1/settings', kv(SERVER_KEY, library)).catch(function () {});
  }

  var saveTimer = 0;
  function saveLocalSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = 0;
      try { localStorage.setItem(LOCAL_KEY, JSON.stringify(preset)); } catch (e) { /* 忽略 */ }
      emit('change', preset);
    }, 400);
  }

  function loadLocal() {
    try {
      var raw = localStorage.getItem(LOCAL_KEY);
      return raw ? normalize(JSON.parse(raw)) : null;
    } catch (e) { return null; }
  }

  function emit(kind, detail) {
    listeners.forEach(function (fn) { try { fn(kind, detail); } catch (e) { /* 单个监听器坏了不拖垮整帧 */ } });
  }

  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

  // -------------------------------------------------------------------------
  // 初始化
  // -------------------------------------------------------------------------

  function applyBackground() {
    if (window.Backgrounds) Backgrounds.apply(preset.bg || { type: 'theme' });
  }

  function applyHand() {
    if (window.HandDrawn) HandDrawn.apply(preset.hand || { on: false });
  }

  function init() {
    preset = loadLocal() || basePreset();
    loadLibrary();
    applyBackground();
    applyHand();
    return api2;
  }

  var api2 = {
    init: init,
    attach: attach,
    effective: effective,
    degradedBecause: function () { return degradedBecause; },
    active: function () { return effective() === '3d'; },

    // 预置
    preset: function () { return deep(preset); },
    setPreset: function (p, opts) {
      preset = normalize(p);
      if (!(opts && opts.keepName)) { /* 名字随预置走 */ }
      animations.length = 0;
      runtime = {};
      resolve(now());
      applyBackground();
      applyHand();
      saveLocalSoon();
      emit('preset', preset);
      return deep(preset);
    },
    setScene: function (id) {
      if (!window.CreativeGL || !CreativeGL.sceneById(id)) return false;
      // 入画补间的起点要在改数据之前采样：之后 resolve 会把 runtime 刷成
      // 新场景的值，那时再补采样拿到的"起点"就是终点，镜头会瞬移。
      var camTo = SCENE_CAM[id];
      var camFrom = null;
      if (camTo) {
        camFrom = {};
        Object.keys(camTo).forEach(function (k) { camFrom[k] = readPath(runtime, k); });
      }
      preset.scene = id;
      preset.sc = sceneDefaults(id);
      animations.length = 0;
      if (camTo) {
        Object.keys(camTo).forEach(function (k) { writePath(preset, k, clampPath(k, camTo[k])); });
      }
      runtime = {};
      resolve(now());
      if (camTo) {
        animations.push({ keys: Object.keys(camTo), from: camFrom, to: camTo,
          start: now(), len: 900, ease: 'inout' });
      }
      saveLocalSoon();
      emit('preset', preset);
      return true;
    },
    setParam: setParam,
    /** 视图切换补帧：暂停空闲时帧门返回 0，全屏页开/关都不会触发 GL tick。
     *  stage.js 的 setPage 在切换后调用它，保证新挂载点立刻有一帧可看
     *  （否则打开时是空白、关闭时舞台停在旧歌词）。帧门本身在跑时为空操作。 */
    kick: kickStaticFrame,
    /** 只改名字。单独开一个口子是因为改名发生在每次按键上：走 setPreset 的话
     *  一次输入会触发一次完整的归一化 + 广播，面板监听到广播就重排 DOM，
     *  输入框随即失焦，用户一个字符都打不进去。 */
    renamePreset: function (name) {
      preset.name = String(name || '');
      saveLocalSoon();
      return preset.name;
    },
    /** 一次性把一组参数写进基础值（工坊里"应用"按钮）。 */
    patch: function (obj) {
      Object.keys(obj || {}).forEach(function (k) {
        if (specFor(k)) writePath(preset, k, clampPath(k, obj[k]));
      });
      resolve(now());
      saveLocalSoon();
      emit('preset', preset);
      return deep(preset);
    },
    /** 原子应用一份 StageIntent（提示词编译器的产出）。要么整份预置一次性
     *  换掉并广播一次 preset 事件，要么状态零变化返回 {ok:false,...}。 */
    applyIntent: applyIntent,

    // 场景与参数元数据：工坊用它们生成控件，不自己维护一份表
    scenes: function () { return window.CreativeGL ? CreativeGL.scenes() : []; },
    spec: function () {
      // 场景行路径必须带 sc. 前缀：setParam/readPath/readRuntime 全都按
      // "sc.键"寻址，runtime() 返回的扁平映射里也是 sc.dimK 这样的键。
      // 工坊拿到前缀后，滑块写值、pathPicker 选值、findRow 反查名称三处才一致。
      var sceneRows = deep(SCENE_SPEC[currentScene()] || []).map(function (row) {
        var out = row.slice();
        out[0] = 'sc.' + row[0];
        return out;
      });
      return { base: deep(BASE_SPEC),
        scene: sceneRows,
        binds: Object.keys(BIND_SOURCES) };
    },
    runtime: function () { return readRuntime(); },

    // 编排轨与绑定
    addCue: function (cue) {
      if (!validCue(cue)) return false;
      preset.cues.push(cue);
      saveLocalSoon();
      emit('preset', preset);
      return true;
    },
    updateCue: function (i, cue) {
      if (!preset.cues[i] || !validCue(cue)) return false;
      preset.cues[i] = cue;
      saveLocalSoon();
      emit('preset', preset);
      return true;
    },
    removeCue: function (i) {
      if (!preset.cues[i]) return false;
      preset.cues.splice(i, 1);
      saveLocalSoon();
      emit('preset', preset);
      return true;
    },
    setBindings: function (list) {
      preset.bindings = (list || []).filter(validBinding);
      saveLocalSoon();
      emit('preset', preset);
      return true;
    },
    fire: function (cue) { fire(cue); },
    setDirector: function (on) {
      preset.director = !!on;
      sectionSince = 0;
      energyHist.length = 0;
      saveLocalSoon();
      emit('preset', preset);
      return preset.director;
    },
    section: function () { return section; },

    // 视图
    setInteract: function (on) {
      interact.on = !!on;
      views.forEach(function (v) { v.el.classList.toggle('creative-interact', interact.on); });
      return interact.on;
    },
    isInteract: function () { return interact.on; },
    resetView: resetView,

    // 背景 / 手绘
    setBackground: function (spec) { preset.bg = spec || { type: 'theme' }; applyBackground(); saveLocalSoon(); return preset.bg; },
    setHandDrawn: function (spec) { preset.hand = spec || { on: false }; applyHand(); saveLocalSoon(); return preset.hand; },

    // 预置库
    library: function () { return deep(library); },
    savePreset: function (name) {
      var p = deep(preset);
      p.name = name || p.name || '未命名舞台';
      var thumb = capture();
      if (thumb) p.thumb = thumb;
      var id = p.id || ('p' + Date.now().toString(36));
      p.id = id;
      var at = -1;
      for (var i = 0; i < library.length; i += 1) if (library[i].id === id) at = i;
      if (at >= 0) library[at] = p; else library.unshift(p);
      if (library.length > 40) library.length = 40;
      persistLibrary();
      emit('library', library);
      return p;
    },
    loadPresetById: function (id) {
      for (var i = 0; i < library.length; i += 1) {
        if (library[i].id === id) return api2.setPreset(library[i]);
      }
      return null;
    },
    removePreset: function (id) {
      library = library.filter(function (p) { return p.id !== id; });
      persistLibrary();
      emit('library', library);
      return true;
    },
    exportJSON: function () { return JSON.stringify(preset, null, 2); },
    importJSON: function (text) {
      try {
        var p = JSON.parse(text);
        if (!p || typeof p !== 'object') return { ok: false, message: '不是一个对象' };
        if (!p.scene && !p.look && !p.cam) return { ok: false, message: '缺少场景或影调字段' };
        api2.setPreset(p);
        return { ok: true, message: '已载入「' + (p.name || '未命名') + '」' };
      } catch (e) {
        return { ok: false, message: 'JSON 解析失败：' + (e.message || e) };
      }
    },
    capture: capture,
    stats: function () {
      return {
        active: !!wanted, scene: preset.scene, section: section,
        fps: targetFps(), tier: tierIndex(), dprScale: DPR_STEPS[dprStep],
        beats: feat.beats, animations: animations.length,
        energy: Number(feat.energy.toFixed(3)),
        agg: agg.map(function (v) { return Number(v.toFixed(3)); }),
        cueCount: preset.cues.length, bindCount: preset.bindings.length,
        // 探测结论要在工坊里看得见：它改的是用户没碰过的东西（渲染分辨率）。
        // 一次不告知的自动降档，和"画面为什么突然糊了"是同一类问题。
        probe: probeInfo()
      };
    },
    onChange: onChange,

    // 相机层注册。priority 小者先执行；同 fn 不重复注册。
    addCamLayer: function (fn, priority) {
      if (typeof fn !== 'function') return;
      if (camLayers.some(function (x) { return x.fn === fn; })) return;
      camLayers.push({ fn: fn, p: priority == null ? 100 : priority });
      camLayers.sort(function (a, b) { return a.p - b.p; });
    },
    removeCamLayer: function (fn) {
      for (var i = 0; i < camLayers.length; i += 1) {
        if (camLayers[i].fn === fn) { camLayers.splice(i, 1); return; }
      }
    },
    // 自由相机等需要完全屏蔽舞台原生拖拽/点击爆闪/滚轮/双击的场景注册；
    // fn 返回 true 时 bindInteraction 各入口早退。传 null 解除。
    setInteractionBlocker: function (fn) {
      interactionBlocker = typeof fn === 'function' ? fn : null;
    }
  };

  function readRuntime() {
    var out = {};
    ['cam.', 'look.', 'stage.', 'sc.'].forEach(function (pre) {
      var head = pre.slice(0, -1);
      var src = head === 'sc' ? runtime.sc : runtime[head];
      if (!src) return;
      Object.keys(src).forEach(function (k) { out[pre + k] = src[k]; });
    });
    return out;
  }

  // 缩略图：抓活动视图的那一帧。切到全屏页时舞台上那块画布是上一帧的旧内容，
  // 拿它当封面会得到一张对不上的图，所以只认当前正在画的那一个引擎。
  function capture() {
    try {
      var v = views[activeIdx];
      return (v && v.eng) ? v.eng.capture() : null;
    } catch (e) { return null; }
  }

  window.CreativeStage = api2;
})();
