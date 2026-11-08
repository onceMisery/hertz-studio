// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 舞台粒子层：跟着音乐呼吸的环境光尘 + 落在节拍上的涟漪。
//
// 本文件负责的是「算」和「调度」，不负责「画」：
//   · 音频特征：从服务端推来的 64 段频谱里抽出各带包络、起音与节拍脉冲；
//   · 视图几何：容器尺寸、涟漪圆心、歌词让位带；
//   · 帧门：向 stage.js 的单一 rAF 循环登记本层的目标帧率；
//   · 渲染器选择：标准 = 内置 Canvas 2D；增强 = stage-particles-gl.js 的 WebGL2。
//
// 两个渲染器消费**同一个** frame 状态（同一组 band / pulse / 几何 / 让位带），
// 所以切换模式只会改变画面密度与质感，不会出现"增强模式下节奏不一样"。
// 音频分析只有一份实现，这是这个拆分最重要的理由。
//
// 数据来源只有一个：服务端算好的 64 段频谱（WS，约 30Hz 一帧）。浏览器里
// 没有 <audio> 元素——声音是 vmusic-audio 用 cpal 直接送到输出设备的，
// 所以这里既拿不到、也不需要 Web Audio 的 AnalyserNode。
//
// 与 stage.js 的契约：不自己起 requestAnimationFrame。整个页面只允许有一个
// 循环（stage.js 那个），这里通过 Stage.gate() 登记成一个子系统帧门。

(function () {
  'use strict';

  // The Stage facade includes native parent-window suspension. Standalone consumers keep browser visibility.
  function documentHidden() {
    var stage = window.Stage;
    return stage && typeof stage.isDocumentHidden === "function" ? stage.isDocumentHidden() : !!document.hidden;
  }

  var SPRITE = 32;          // 2D 光点精灵的画布边长
  var RIPPLE_POOL = 12;     // 涟漪 DOM 节点池：同时最多 12 圈
  var RIPPLE_MS = 1600;

  // 每档设备的帧率预算。tier 由 stage.js 按核心数 / 内存 / 渲染像素判一次，
  // 之后只会被帧率探针往下调。粒子数与 DPR 上限由各渲染器自己报，
  // 因为 Canvas 2D 和 WebGL 的开销曲线完全不同。
  //
  // 档位只取 60 与 120 的公因数（15/20/30）：帧门按「每 N 个 rAF 一帧」兑现，
  // 声明一个不是整数分频的数（原来写的 18/26/34）在最常见的 60Hz 屏上会被向下
  // 夹成 15/20/30 —— 数字说谎，而看数字调档的人据此做的判断全错。
  var TIERS = [{ fps: 15 }, { fps: 20 }, { fps: 30 }];

  // 分带边界与起音判据都在 onset.js。这里刻意不抄一份：粒子层和三维层必须
  // 在同一个时刻认同一个鼓点，而"再抄一份"看着只差几行，实际差的是整套阈值
  // 语义（详见 onset.js 顶部那段说明）。
  var HAS_ONSET = !!(window.Onset && window.Onset.GROUPS);
  var GROUPS = HAS_ONSET ? Onset.GROUPS : [];
  var NG = GROUPS.length;
  var pageResources = window.Stage && Stage.resources ? Stage.resources() : null;
  var moduleResources = pageResources ? pageResources.port('stage-particles') : null;
  var featureTicket = null;
  if (moduleResources) {
    try { featureTicket = moduleResources.require({ ownedCpuBytes: NG * 8 * 3 }, 'particle frame/band/rise retained arrays', 0); }
    catch (e) { /* Missing aggregate capacity disables this visual layer, never playback. */ }
  }

  // 参数唯一真源是服务端设置里的舞台参数（stage-control.js 推过来）。
  // 这里刻意不自己存一份 localStorage —— 两个存储必然会在某次改动后分叉，
  // 而分叉的表现是"面板显示 100% 但实际跑着上次的 40%"，极难自查。
  var opts = {
    dust: true, density: 100, strength: 100, dustDrift: 100, ripples: true
  };

  var stageEl = null;
  var views = [];          // [{ el, host, canvas, ctx, w, h, cx, cy, rx, ry, fade0, fade1, pool }]
  var active = null;
  var renderer = null;
  var rendererName = 'none';
  var mode = 'standard';   // 用户请求的模式，与实际生效的 rendererName 分开记
  var attached = false;    // 渲染器只在首次 attach 时选定；之后改设置要重新加载界面
  var pendingAttachMode = null, pendingFallback = false;
  var degradedTo = null;   // 已发生的降级原因，供设置页显示真相
  // 代价探测得出的粒子数缩放。必须存成状态而不是直接 setCount：syncCount()
  // 每帧都会按档位预算重算，直接 setCount 会在下一帧被覆盖回去。
  var countScale = 1;
  // 代价探测要等到"本层真的在画"之后再跑。attach 发生在启动序列里，那时既没
  // 播放也没开抽屉，帧门报 0、GL 一帧都不画，两轮测出来的差值恒等于 0，
  // 探测会无条件放行 —— 一个永远说"没问题"的检查比没有检查更糟。
  var probePending = false;
  var resizeObserver = null;
  var lifecycle = 0;
  var backendGeneration = 0, stateUnsubscribe = null, classObserver = null;
  var state = null, dirty = true, geometryDirty = true, advancing = false;
  var sceneTimeMs = 0, lastFrameId = -1, spectrumWatermark = 0, lastInputRevision = -1;
  var primed = false, invalidated = true, currentTier = 2, particleCount = 0;
  var budgetInput = { tier: 2, dpr: 1 };
  var instanceFrame = {
    version: 1, instanceId: 0, backendGeneration: 0, frameId: 0,
    sceneTimeMs: 0, geometryDeltaMs: 0, t: 0, dt: 0, mediaPositionMs: 0,
    mediaEpoch: 0, positionAnchorRevision: 0, positionDiscontinuityRevision: 0,
    spectrumRevision: 0, available: false, bands: null, rise: null,
    pulse: 0, energy: 0, strength: 1, drift: 1, tier: 2,
    requestedMode: 'standard', actualBackend: 'none', count: 0, dpr: 1, countScale: 1
  };
  var stepOptions = { publishBeat: false };
  var warmFrame = { t: 0, dt: 0, sceneTimeMs: 0, geometryDeltaMs: 0,
    bands: new Float64Array(featureTicket ? NG : 0), pulse: 0, energy: 0, strength: 1, drift: 0 };
  var metrics = null, resourcePeak = null, lastResources = null;
  var firstRequestedAt = null, warmPending = true, firstFramePending = true;
  var creativeOccluded = false;

  // ---------------------------------------------------------------------------
  // 音频特征
  // ---------------------------------------------------------------------------
  //
  // 判据本身在 onset.js：粒子层与三维层必须在同一时刻认同同一个鼓点，
  // 所以"哪一刻算起音"只能有一份实现。这里只负责喂频谱、取结果，
  // 以及起音时落一圈涟漪。
  //
  // band / rise / feat 都是检测器内部数组与字段的**别名**，不是副本：
  // 下面 renderer.draw 与 stats() 直接读它们，省掉每帧一次拷贝。

  var onset = HAS_ONSET && featureTicket ? Onset.create({ groups: GROUPS }) : null;
  var band = new Float64Array(featureTicket ? NG : 0);
  var rise = new Float64Array(featureTicket ? NG : 0);
  if (featureTicket) featureTicket.commit();
  var feat = { agg: band, groupRise: rise, pulse: 0, energy: 0, beats: 0,
    sampledAt: null, available: false, instanceId: 0, spectrumRevision: 0 };
  instanceFrame.bands = band; instanceFrame.rise = rise;

  var nowMs = (window.performance && window.performance.now)
    ? function () { return performance.now(); }
    : function () { return Date.now(); };

  if (onset) onset.onBeat(function () {
    feat.beats += 1;
    feat.pulse = onset.pulse;
    if (advancing && opts.ripples) spawnRipple();
  });

  // ---------------------------------------------------------------------------
  // 涟漪：池化 DOM 节点 + Web Animations
  //
  // 以前画在 canvas 里（每帧重算 12 个椭圆描边）。搬到 DOM 之后：
  //   · 两种渲染器共用同一套实现，不必在 GL 里再写一遍；
  //   · WAAPI 始终暂停，时间只由本实例的 sceneTime 设置；
  //   · 椭圆边界是矢量描边，不像点阵圆环那样在 DPR 高时露出锯齿。
  // ---------------------------------------------------------------------------

  var ripLive = 0;
  var ripHead = 0;

  function releaseRipple(el) {
    el.__rippleToken = (el.__rippleToken || 0) + 1;
    if (el.__rippleAnimation) {
      el.__rippleAnimation.onfinish = el.__rippleAnimation.oncancel = null;
      el.__rippleAnimation.cancel(); el.__rippleAnimation = null;
    }
    if (el.classList.contains('is-live')) ripLive = Math.max(0, ripLive - 1);
    el.classList.remove('is-live'); el.style.opacity = ''; el.style.transform = '';
  }

  function clearRipples() {
    for (var i = 0; i < views.length; i += 1) {
      var pool = views[i].pool;
      for (var j = 0; pool && j < pool.length; j += 1) releaseRipple(pool[j]);
    }
    ripLive = 0;
  }

  function updateRipples() {
    var pool = active && active.pool;
    for (var i = 0; pool && i < pool.length; i += 1) {
      var el = pool[i];
      if (!el.classList.contains('is-live')) continue;
      var age = sceneTimeMs - el.__rippleBorn;
      if (age >= RIPPLE_MS) releaseRipple(el);
      else if (el.__rippleAnimation) el.__rippleAnimation.currentTime = Math.max(0, age);
    }
  }

  function makePool(el) {
    var pool = [];
    try {
    for (var i = 0; i < RIPPLE_POOL; i += 1) {
      var n = document.createElement('span');
      pool.push(n);
      n.className = 'stage-ripple';
      n.setAttribute('aria-hidden', 'true');
      el.appendChild(n);
    }
    return pool;
    } catch (e) {
      for (var j = 0; j < pool.length; j += 1) if (pool[j].parentNode) pool[j].parentNode.removeChild(pool[j]);
      throw e;
    }
  }

  function spawnRipple() {
    var v = active;
    if (!v || !v.pool || !v.w || !advancing || !opts.ripples) return;
    var generation = lifecycle;
    var el = v.pool[ripHead];
    ripHead = (ripHead + 1) % RIPPLE_POOL;
    releaseRipple(el);
    var token = el.__rippleToken;
    el.__rippleBorn = sceneTimeMs;
    el.classList.add('is-live');
    el.style.left = v.cx + 'px';
    el.style.top = v.cy + 'px';
    el.style.width = (v.rx * 2) + 'px';
    el.style.height = (v.ry * 2) + 'px';
    var amp = Math.min(1, feat.pulse) * (opts.strength / 100);
    if (el.animate) {
      var anim = el.animate([
        { transform: 'translate(-50%, -50%) scale(0.82)', opacity: 0 },
        { transform: 'translate(-50%, -50%) scale(0.90)', opacity: 0.10 * amp, offset: 0.18 },
        { transform: 'translate(-50%, -50%) scale(1.12)', opacity: 0 }
      ], { duration: RIPPLE_MS, easing: 'cubic-bezier(0.30, 0, 0.55, 1)' });
      anim.pause(); anim.currentTime = 0; el.__rippleAnimation = anim;
      ripLive += 1;
      anim.onfinish = function () {
        if (generation !== lifecycle || token !== el.__rippleToken) return;
        // A queued compositor event cannot advance the instance clock.
        if (sceneTimeMs - el.__rippleBorn >= RIPPLE_MS) releaseRipple(el);
      };
    } else {
      // 没有 WAAPI 的老内核：退回静态显示，至少不会看不到反馈
      el.style.opacity = String(0.10 * amp);
      el.style.transform = 'translate(-50%, -50%) scale(1)';
      ripLive += 1;
    }
  }

  // ---------------------------------------------------------------------------
  // 视图几何
  // ---------------------------------------------------------------------------

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function mountView(el, beforeSel) {
    if (!el) return null;
    var anchor = el.querySelector(beforeSel);
    var c = null, ticket = null;
    // 插在歌词容器之前：粒子在字后面，文字永远压在最上层，不会被光点糊住。
    try {
      if (!moduleResources) throw new Error('resource-policy-required');
      ticket = moduleResources.require({ canvases: 1 }, 'particle host canvas', lifecycle);
      c = document.createElement('canvas');
      c.width = c.height = 0;
      c.className = 'stage-particles';
      c.setAttribute('aria-hidden', 'true');
      if (anchor) el.insertBefore(c, anchor);
      else el.appendChild(c);
      ticket.commit();
      return { el: el, canvas: c, canvasTicket: ticket, ctx: null, pool: makePool(el), fade0: -1, fade1: -1 };
    } catch (e) {
      if (c && c.parentNode) c.parentNode.removeChild(c);
      c = null;
      if (ticket) ticket.release({ apiReleased: true, allocationEnded: true });
      degradedTo = '粒子图层创建失败';
      return null;
    }
  }

  function measureView(v) {
    if (!v || !v.el) return false;
    var r = v.el.getBoundingClientRect();
    if (!r.width || !r.height) { v.w = v.h = 0; return false; }
    v.w = Math.round(r.width);
    v.h = Math.round(r.height);

    // 涟漪圆心：舞台里是唱盘，全屏页里是当前行锚点。让"声音从哪里发出来"
    // 在两个界面里都读得通，而不是两处各自为政。
    var anchorRatio = parseFloat(cssVar('--lyric-anchor-ratio', '0.382'));
    var isStage = v.el === stageEl;
    var disc = v.el.querySelector(isStage ? '.disc-wrap' : '.lp-body');
    if (!disc) { v.cx = v.w / 2; v.cy = v.h * 0.4; v.rx = v.w * 0.4; v.ry = v.h * 0.28; }
    else {
      var dr = disc.getBoundingClientRect();
      v.cx = dr.left - r.left + dr.width / 2;
      v.cy = isStage ? dr.top - r.top + dr.height / 2 : v.h * anchorRatio;
      v.rx = Math.max(60, dr.width * (isStage ? 0.62 : 0.5));
      v.ry = Math.max(40, dr.height * (isStage ? 0.62 : 0.26));
    }

    // 光尘聚在封面周围，边缘柔和消失。几何随封面和抽屉布局变化。
    v.canvas.style.setProperty('--particle-cx', v.cx + 'px');
    v.canvas.style.setProperty('--particle-cy', v.cy + 'px');
    v.canvas.style.setProperty('--particle-rx', Math.max(v.w * 0.7, v.rx * 1.6) + 'px');
    v.canvas.style.setProperty('--particle-ry', Math.max(180, v.ry * 1.6) + 'px');

    // 歌词占据的纵向区间。粒子在这一带里要主动让位——文字永远优先于氛围。
    // 区间从 DOM 量出来而不是写死比例，所以窄屏抽屉、字号调整、模式切换
    // 都不需要跟着改这里。
    if (isStage) {
      // 歌曲信息、进度条和歌词共用一条安静区，封面模式也为标题让位。
      var title = v.el.querySelector('.stage-title');
      var lyr = v.el.querySelector('.stage-lyrics');
      if (title && title.clientHeight) {
        v.fade0 = title.getBoundingClientRect().top - r.top;
        v.fade1 = v.h;
      } else if (lyr && lyr.clientHeight) {
        var lr = lyr.getBoundingClientRect();
        v.fade0 = lr.top - r.top;
        v.fade1 = lr.bottom - r.top;
      } else { v.fade0 = -1; v.fade1 = -1; }
    } else {
      // 全屏页里 .lp-body 是整个滚动视口（几乎占满屏）。拿它当"文字区"会把
      // 整页都判成需要让位，粒子被均匀压到 28%，等于这一层白做。真正需要
      // 让位的只有当前行上下几行——那正是锚点附近的一条窄带。
      var span = v.h * parseFloat(cssVar('--lp-fade-span', '0.17'));
      var mid = v.h * anchorRatio;
      v.fade0 = mid - span;
      v.fade1 = mid + span;
    }
    if (renderer && renderer.resize(v, budgetInput) === false) throw new Error('粒子尺寸更新失败');
    return true;
  }

  // 文字让位曲线：歌词带内压到 28%，两侧各 48px 线性过渡回 100%。
  // 用斜坡而不是硬边界，否则粒子会在歌词上下沿整齐地"断掉"，反而更抢眼。
  var FADE_EDGE = 48;
  var FADE_MIN = 0.28;
  function textFade(v, y) {
    if (v.fade1 <= 0) return 1;
    var d;
    if ((d = v.fade0 - y) > 0) return d >= FADE_EDGE ? 1 : 1 - (1 - FADE_MIN) * (1 - d / FADE_EDGE);
    if ((d = y - v.fade1) > 0) return d >= FADE_EDGE ? 1 : 1 - (1 - FADE_MIN) * (1 - d / FADE_EDGE);
    return FADE_MIN;
  }

  // ---------------------------------------------------------------------------
  // 标准渲染器：Canvas 2D
  // ---------------------------------------------------------------------------

  function Canvas2DRenderer(resourcePort) {
    var count = 0, sprites = null;
    var px = null, py = null, pz = null, pseed = null, psize = null;
    var mounted = [], spriteOwners = [], currentSprites = [];
    var disposed = false, failed = false, failures = 0, lastFailure = '';
    var arraysTicket = null;
    function admission(resources, source) {
      if (!resourcePort) throw new Error('resource-policy-required');
      return resourcePort.require(resources, source, backendGeneration);
    }
    function releaseTicket(ticket) { if (ticket) ticket.release({ apiReleased: true, allocationEnded: true }); }
    var lastDrawCalls = 0, productionDraws = 0;
    var alive = { contexts: 0, canvases: 0, sprites: 0, typedArrays: 0,
      typedArrayBytes: 0, surfacePixels: 0, drawingBufferPixels: 0, spritePixels: 0 };
    var created = { contexts: 0, canvases: 0, sprites: 0, typedArrays: 0 };
    var released = { contexts: 0, canvases: 0, sprites: 0, typedArrays: 0 };
    var peak = { contexts: 0, canvases: 0, sprites: 0, typedArrays: 0,
      typedArrayBytes: 0, surfacePixels: 0, drawingBufferPixels: 0, spritePixels: 0 };

    function copy(source) {
      var result = {};
      for (var key in source) if (Object.prototype.hasOwnProperty.call(source, key)) result[key] = source[key];
      return result;
    }

    function updatePeak() {
      for (var key in alive) if (alive[key] > peak[key]) peak[key] = alive[key];
    }

    function own(kind) { alive[kind] += 1; created[kind] += 1; updatePeak(); }
    function release(kind) { alive[kind] -= 1; released[kind] += 1; }
    function checked(result) {
      if (result === false || result === null) throw new Error('Canvas operation returned ' + result);
      return result;
    }

    function find(v) {
      for (var i = 0; i < mounted.length; i += 1) if (mounted[i].v === v) return mounted[i];
      return null;
    }

    function updatePixels(owner) {
      var pixels = owner.ctx ? owner.canvas.width * owner.canvas.height : 0;
      if (owner.sprite) alive.spritePixels += pixels - owner.pixels;
      else {
        alive.surfacePixels += pixels - owner.pixels;
        alive.drawingBufferPixels += pixels - owner.pixels;
      }
      owner.pixels = pixels;
      updatePeak();
    }

    function releaseCanvas(owner) {
      if (!owner.active) return;
      owner.active = false;
      if (owner.sprite) alive.spritePixels -= owner.pixels;
      else {
        alive.surfacePixels -= owner.pixels;
        alive.drawingBufferPixels -= owner.pixels;
      }
      owner.pixels = 0;
      if (owner.ctx) { owner.ctx = null; release('contexts'); }
      if (owner.v) owner.v.ctx = null;
      // Width and height releases are independent so one exception cannot retain both.
      try { owner.canvas.width = 0; } catch (e) { /* Reference cleanup still proceeds. */ }
      try { owner.canvas.height = 0; } catch (e) { /* Reference cleanup still proceeds. */ }
      if (owner.sprite) release('sprites');
      release('canvases');
      owner.canvas = owner.v = null;
      releaseTicket(owner.surfaceTicket); releaseTicket(owner.spriteTicket); releaseTicket(owner.pendingSurfaceTicket);
      owner.surfaceTicket = owner.spriteTicket = owner.pendingSurfaceTicket = null;
    }

    function releaseArray(array) {
      if (!array) return;
      alive.typedArrayBytes -= array.byteLength;
      release('typedArrays');
    }

    function releaseAll() {
      for (var i = 0; i < spriteOwners.length; i += 1) releaseCanvas(spriteOwners[i]);
      for (var j = 0; j < mounted.length; j += 1) releaseCanvas(mounted[j]);
      spriteOwners.length = currentSprites.length = mounted.length = 0;
      sprites = null;
      releaseArray(px); releaseArray(py); releaseArray(pz); releaseArray(pseed); releaseArray(psize);
      px = py = pz = pseed = psize = null;
      count = 0;
      releaseTicket(arraysTicket); arraysTicket = null;
    }

    function fail(error) {
      failed = true; failures += 1;
      lastFailure = error && error.message ? String(error.message) : String(error);
      releaseAll();
      return false;
    }

    function rebuild(want) {
      if (disposed || failed) return false;
      if (!isFinite(want) || want < 0) return fail(new Error('Invalid Canvas particle count'));
      want = Math.floor(want);
      if (want === count) return true;
      var next = [null, null, null, null, null];
      var nextTicket = null;
      try {
        nextTicket = admission({ ownedCpuBytes: want * 5 * 4 }, 'five Canvas particle arrays, full replacement peak');
        if (want) for (var i = 0; i < next.length; i += 1) {
          next[i] = new Float32Array(want);
          own('typedArrays');
          alive.typedArrayBytes += next[i].byteLength;
          updatePeak();
        }
        for (var j = 0; j < want; j += 1) {
          next[0][j] = Math.random();
          next[1][j] = Math.random();
          next[2][j] = 0.18 + Math.random() * 0.82;
          next[3][j] = Math.random() * Math.PI * 2;
          next[4][j] = 0.6 + Math.random() * 1.9;
        }
        // Old and new arrays coexist until seeding succeeds; their peak is explicit.
        releaseArray(px); releaseArray(py); releaseArray(pz); releaseArray(pseed); releaseArray(psize);
        px = next[0]; py = next[1]; pz = next[2]; pseed = next[3]; psize = next[4];
        nextTicket.commit(); releaseTicket(arraysTicket); arraysTicket = nextTicket;
        count = want;
        return true;
      } catch (error) {
        for (var k = 0; k < next.length; k += 1) releaseArray(next[k]);
        next.length = 0; releaseTicket(nextTicket);
        return fail(error);
      }
    }

    function makeSprite(rgb) {
      var ticket = admission({ canvases: 1, drawingBufferPixels: SPRITE * SPRITE,
        ownedCpuBytes: SPRITE * SPRITE * 4 }, 'Canvas particle sprite RGBA8 backing');
      var canvas;
      try { canvas = document.createElement('canvas'); }
      catch (e) { releaseTicket(ticket); throw e; }
      var owner = { canvas: canvas, ctx: null, v: null, sprite: true, active: true, pixels: 0, spriteTicket: ticket };
      spriteOwners.push(owner); own('canvases'); own('sprites');
      canvas.width = canvas.height = SPRITE;
      owner.ctx = canvas.getContext('2d');
      if (!owner.ctx) throw new Error('Canvas sprite unavailable');
      own('contexts'); updatePixels(owner);
      var g = owner.ctx;
      var gradient = g.createRadialGradient(SPRITE / 2, SPRITE / 2, 0, SPRITE / 2, SPRITE / 2, SPRITE / 2);
      if (!gradient) throw new Error('Canvas gradient unavailable');
      checked(gradient.addColorStop(0, 'rgba(' + rgb + ',1)'));
      checked(gradient.addColorStop(0.32, 'rgba(' + rgb + ',0.5)'));
      checked(gradient.addColorStop(1, 'rgba(' + rgb + ',0)'));
      g.fillStyle = gradient;
      checked(g.fillRect(0, 0, SPRITE, SPRITE));
      ticket.commit();
      return owner;
    }

    function render(v, f) {
      try {
        var g = v.ctx;
        if (!g || !sprites || !v.w || !v.h || disposed || failed) return false;
        checked(g.clearRect(0, 0, v.w, v.h));
        lastDrawCalls = 0;
        if (!count) return false;
        var s = f.strength;
        var low = f.bands[0], body = f.bands[1], mid = f.bands[2], air = f.bands[3];
        var pulse = f.pulse * s;
        var t = f.t;
        var lift = Math.min(100, Math.max(0, f.dt)) / 1000 * f.drift * (0.004 + mid * 0.004);
        var breathe = Math.sin(t / 5000) * low * 0.002 * s;
        var push = pulse * 0.012;

        // 'lighter' 让重叠的光点累加而不是互相遮挡，这是"舞台灰尘被灯打亮"
        // 的关键一步；代价是密集处会过曝，所以单颗 alpha 压得很低。
        g.globalCompositeOperation = 'lighter';
        for (var i = 0; i < count; i += 1) {
          var z = pz[i];
          py[i] -= lift * (0.4 + z);
          if (py[i] < -0.05) { py[i] = 1.05; px[i] = Math.random(); }
          var sway = Math.sin(t / 5000 + pseed[i]) * 0.006 * (0.3 + z) * (1 + body * 0.2);
          var x = (px[i] + sway) * v.w;
          var y = (py[i] + breathe) * v.h;
          if (push > 0.0005) {
            // 节拍把粒子沿「离圆心的方向」推开，于是是炸开而不是整体平移；
            // 越靠近圆心推得越狠，边缘几乎不动，读起来像冲击波。
            var dx = x - v.cx, dy = y - v.cy;
            var d = Math.sqrt(dx * dx + dy * dy) || 1;
            var k = push * (1 - Math.min(1, d / (v.w * 0.75))) * 0.5;
            x += dx / d * k * v.w * 0.14;
            y += dy / d * k * v.h * 0.14;
          }
          var tw = 0.82 + 0.18 * Math.sin(t * 0.00045 + pseed[i] * 3.1);
          var shimmer = air * 0.025 * (0.5 + 0.5 * Math.sin(t * 0.0007 + pseed[i]));
          var a = (0.06 + 0.13 * z + low * 0.035 + pulse * 0.04 + shimmer) * tw * textFade(v, y);
          if (a < 0.012) continue;               // 暗到看不出的直接跳过，省下上千次 drawImage
          var size = psize[i] * (0.7 + z * 0.9) * (1 + low * 0.12 + pulse * 0.10) * 3.0;
          g.globalAlpha = a > 1 ? 1 : a;
          checked(g.drawImage(sprites[i & 1], x - size / 2, y - size / 2, size, size));
          lastDrawCalls += 1;
        }
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
        return true;
      } catch (error) { return fail(error); }
    }

    return {
      name: 'canvas2d',
      counts: [36, 72, 120],
      dpr: [1.0, 1.3, 1.6],
      mount: function (v) {
        if (disposed || failed) return false;
        if (find(v)) return !!v.ctx;
        try {
          if (!v || !v.canvas) throw new Error('Missing Canvas view');
          var pixels = v.canvas.width * v.canvas.height;
          var surfaceTicket = admission({ drawingBufferPixels: pixels, ownedCpuBytes: pixels * 4 }, 'Canvas particle initial surface RGBA8');
          var owner = { v: v, canvas: v.canvas, ctx: null, sprite: false, active: true, pixels: 0, surfaceTicket: surfaceTicket };
          mounted.push(owner); own('canvases');
          owner.ctx = v.ctx || v.canvas.getContext('2d', { alpha: true });
          if (!owner.ctx) throw new Error('Canvas context unavailable');
          own('contexts'); v.ctx = owner.ctx; updatePixels(owner);
          surfaceTicket.commit();
          return true;
        } catch (error) { return fail(error); }
      },
      setColors: function (hi, alt) {
        if (disposed || failed) return false;
        try {
          var first = makeSprite(hi), second = makeSprite(alt);
          for (var i = 0; i < currentSprites.length; i += 1) releaseCanvas(currentSprites[i]);
          // Discard retired owners so repeated retints retain only the two live sprites.
          currentSprites = [first, second]; spriteOwners = [first, second];
          sprites = [first.canvas, second.canvas];
          return true;
        } catch (error) { return fail(error); }
      },
      setCount: rebuild,
      resize: function (v, budget) {
        var owner = find(v);
        if (disposed || failed || !owner || !v.ctx) return false;
        try {
          var dpr = budget.dpr;
          var bw = Math.round(v.w * dpr), bh = Math.round(v.h * dpr);
          var nextTicket = null;
          if (v.canvas.width !== bw || v.canvas.height !== bh) {
            var peakPixels = Math.max(bw * v.canvas.height, bw * bh);
            nextTicket = admission({ drawingBufferPixels: peakPixels, ownedCpuBytes: peakPixels * 4 }, 'Canvas particle resize including intermediate width/height backing');
          }
          try {
          if (v.canvas.width !== bw) { v.canvas.width = bw; updatePixels(owner); }
          if (v.canvas.height !== bh) { v.canvas.height = bh; updatePixels(owner); }
          if (nextTicket) {
            nextTicket.commit({ drawingBufferPixels: bw * bh, ownedCpuBytes: bw * bh * 4 });
            releaseTicket(owner.surfaceTicket); owner.surfaceTicket = nextTicket; nextTicket = null;
          }
          } finally {
            // On partial resize, fail() clears the surface before its reservation is reclaimed.
            if (nextTicket) { owner.pendingSurfaceTicket = nextTicket; }
          }
          v.canvas.style.width = v.w + 'px'; v.canvas.style.height = v.h + 'px';
          checked(v.ctx.setTransform(dpr, 0, 0, dpr, 0, 0));
          return true;
        } catch (error) { return fail(error); }
      },
      clear: function (v) {
        if (disposed || failed || !v.ctx) return false;
        try { checked(v.ctx.clearRect(0, 0, v.w, v.h)); return true; }
        catch (error) { return fail(error); }
      },
      draw: function (v, f) {
        var submitted = render(v, f);
        if (submitted) productionDraws += 1;
        return submitted;
      },
      warmUp: function (v, f) {
        if (disposed || failed) return { status: 'failed', count: count, drawCalls: 0 };
        if (!v.w || !v.h || !count) return { status: 'deferred', count: count, drawCalls: 0 };
        var submitted = render(v, f), drawCalls = submitted ? lastDrawCalls : 0;
        if (submitted) submitted = this.clear(v);
        return { status: submitted ? 'submitted' : 'failed', count: count, drawCalls: drawCalls };
      },
      resources: function () {
        var result = copy(alive);
        result.backend = 'canvas2d';
        result.created = copy(created); result.released = copy(released); result.peak = copy(peak);
        result.bufferBytes = result.shaders = result.buffers = result.vaos = result.programs = result.listeners = 0;
        result.count = count; result.disposed = disposed;
        result.ready = !disposed && !failed && mounted.length > 0;
        result.contextReferencesReleased = released.contexts;
        result.surfaceRgbaEstimateBytes = (alive.surfacePixels + alive.spritePixels) * 4;
        result.failures = failures; result.failure = lastFailure;
        result.productionDraws = productionDraws;
        return result;
      },
      dispose: function () {
        if (disposed) return;
        disposed = true; releaseAll();
      }
    };
  }

  // ---------------------------------------------------------------------------
  // 渲染器选择与降级
  // ---------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // 增强模式的代价探测
  // -------------------------------------------------------------------------
  //
  // 为什么不用 stage.js 那个全局帧率探针的结论来判：那个数反映的是**整页**
  // （backdrop-filter、歌词、别层的动画都算在里面），而我们要回答的问题是
  // "GPU 渲染器比标准渲染器多花了多少"。拿整页帧率去判一个子模块，会把
  // "这页本来就重"误判成"GPU 不行"，反过来也会漏掉真正拖帧的情况。
  //
  // 所以做 A/B：同一台机器、同一个时刻，先量本层不画东西时的帧率，再量按
  // 当前预算画的帧率，比的是差值。
  var probeMuted = false;
  var probeFrame = 0;
  var finishProbe = null;
  var probeGeneration = 0;
  var probeActive = false, probeDraws = 0, probeResult = null;

  function neutralize() {
    band.fill(0); rise.fill(0); feat.pulse = feat.energy = 0;
    feat.available = false;
  }

  function invalidateInput(watermark) {
    if (!invalidated && onset) onset.reset();
    invalidated = true; primed = false; lastInputRevision = -1;
    spectrumWatermark = Math.max(spectrumWatermark, watermark || 0);
    neutralize();
  }

  function freeze(watermark) {
    advancing = false;
    instanceFrame.dt = instanceFrame.geometryDeltaMs = 0;
    invalidateInput(watermark);
  }

  function layerOccluded() {
    return document.body.classList.contains('creative-3d') ||
      document.body.classList.contains('creative-on');
  }

  function visible(s) {
    return !!(s && s.stageVisible && !s.documentHidden && !creativeOccluded);
  }

  function requestStatic(remeasure) {
    dirty = true;
    if (remeasure) geometryDirty = true;
    if (firstFramePending && firstRequestedAt === null && renderer && visible(state) &&
        !state.reduced && active && active.w && active.h && opts.dust && particleCount) {
      firstRequestedAt = perfBegin();
    }
    if (window.Stage) Stage.kick();
  }

  function interruptFirstFrame() {
    if (firstFramePending && firstRequestedAt !== null) metrics.firstFrameStatus = 'interrupted';
    firstRequestedAt = null;
  }

  function invalidatePreparation() {
    if (!firstFramePending || !metrics || metrics.warmUpStatus !== 'submitted') return;
    metrics.firstFrameInterruptions += 1;
    interruptFirstFrame(); warmPending = true; metrics.warmUpStatus = 'deferred';
  }

  function refreshState(s) {
    var previouslyActive = state && visible(state) && state.playing && !state.reduced;
    var boundary = state && (s.mediaEpoch !== state.mediaEpoch ||
      s.positionDiscontinuityRevision !== state.positionDiscontinuityRevision);
    state = s;
    if (boundary) { invalidateInput(s.spectrumRevision); clearRipples(); }
    if (!visible(s) || !s.playing || s.reduced) freeze(s.spectrumRevision);
    else if (!previouslyActive) { advancing = false; invalidateInput(s.spectrumRevision); }
    if (probeActive) cancelProbe(true);
    if (!visible(s) || s.reduced) interruptFirstFrame();
    requestStatic(true);
    reportResources();
  }

  function reportResources() {
    if (!moduleResources) return;
    var reasons = [];
    if (degradedTo) reasons.push(degradedTo.indexOf('上下文') >= 0 ? 'context-lost' : 'prepare-failed');
    if (metrics && metrics.failure && metrics.failure.indexOf('aggregate-budget') >= 0) reasons.push('aggregate-budget');
    if (countScale < 1) reasons.push('frame-pressure');
    var presentation = !views.length ? 'hidden' : !active || !active.w || !active.h ? 'zero-size'
      : state && state.documentHidden ? 'hidden' : creativeOccluded ? 'occluded'
      : state && state.reduced ? 'reduced' : state && !state.playing ? 'paused' : 'visible';
    moduleResources.report({ logicalInstanceId: 'particles:' + lifecycle, requestId: 'backend:' + backendGeneration,
      rendererId: rendererName + ':' + backendGeneration, generation: lifecycle,
      lifecycle: renderer ? firstFramePending ? 'preparing' : 'ready' : pendingAttachMode || pendingFallback ? 'preparing' : attached ? 'error' : 'absent',
      presentation: presentation, visibleUses: visible(state) && active && active.w && active.h ? 1 : 0,
      requestedQuality: mode, actualQuality: renderer && !firstFramePending ? 'tier-' + currentTier : 'unavailable',
      actualBackend: renderer && !firstFramePending ? rendererName : 'none', effectiveDpr: budgetInput.dpr,
      reasons: reasons });
  }

  function classChanged() {
    var occluded = layerOccluded();
    if (occluded === creativeOccluded) return;
    creativeOccluded = occluded;
    if (occluded) { freeze(state ? state.spectrumRevision : 0); interruptFirstFrame(); }
    else if (state) { state = Stage.frameState(); invalidateInput(state.spectrumRevision); }
    if (probeActive) cancelProbe(true);
    requestStatic(true);
  }

  function perfBegin() {
    return typeof HertzPerf !== 'undefined' && HertzPerf.state.enabled ? HertzPerf.now() : null;
  }

  function perfEnd(name, started) {
    if (started === null) return null;
    var elapsed = typeof HertzPerf !== 'undefined' && HertzPerf.now() - started;
    if (typeof HertzPerf !== 'undefined') HertzPerf.mark('particles.' + name, elapsed);
    return elapsed;
  }

  function trackResources() {
    if (!renderer || !renderer.resources) return;
    var r = renderer.resources();
    lastResources = r;
    for (var key in r) {
      if (typeof r[key] === 'number' && isFinite(r[key])) {
        resourcePeak[key] = Math.max(resourcePeak[key] || 0, r[key]);
      }
    }
    if (r.peak) for (var name in r.peak) {
      if (typeof r.peak[name] === 'number') resourcePeak[name] = Math.max(resourcePeak[name] || 0, r.peak[name]);
    }
  }

  function cancelProbe(retry) {
    probeGeneration += 1;
    if (probeFrame) cancelAnimationFrame(probeFrame);
    probeFrame = 0;
    if (finishProbe) { var finish = finishProbe; finishProbe = null; finish(0); }
    if (probeActive) probeResult = { status: 'interrupted' };
    probeActive = false; probeMuted = false;
    probePending = !!(retry && rendererName === 'webgl');
    advancing = false;
  }

  function measureFps(windowMs) {
    return new Promise(function (resolve) {
      finishProbe = resolve;
      var frames = 0;
      var t0 = nowMs();
      function step(now) {
        frames += 1;
        if (now - t0 < windowMs) probeFrame = requestAnimationFrame(step);
        else {
          probeFrame = 0;
          finishProbe = null;
          resolve(frames / ((nowMs() - t0) / 1000));
        }
      }
      probeFrame = requestAnimationFrame(step);
    });
  }

  // 返回 true 表示探测完成且增强模式可以留下。
  function probeEnhanced() {
    // 必须串行：两轮测量若并发跑，probeMuted 会被第二次调用立刻改回 false，
    // "基线"窗口里其实一直在画，量出来的差值恒等于 0，探测就白做了。
    if (probeActive || rendererName !== 'webgl') return Promise.resolve(false);
    probeActive = true; probeMuted = true; probeDraws = 0;
    freeze(state ? state.spectrumRevision : 0);
    var generation = probeGeneration;
    return measureFps(500).then(function (base) {
      if (generation !== probeGeneration) return null;
      probeMuted = false;
      advancing = false;
      state = Stage.frameState(); invalidateInput(state.spectrumRevision);
      Stage.kick();
      return measureFps(500).then(function (withGL) { return { base: base, withGL: withGL }; });
    }).then(function (r) {
      if (!r || generation !== probeGeneration) return false;
      var base = r.base, withGL = r.withGL;
      probeActive = false;
      if (!(base > 0) || !(withGL > 0) || !(probeDraws > 0)) {
        probeResult = { status: 'invalid', base: base, withGL: withGL, draws: probeDraws };
        probePending = true; return false;
      }
      var loss = 1 - withGL / base;
      probeResult = { status: 'valid', base: base, withGL: withGL, loss: loss, draws: probeDraws };
      if (loss <= 0.12) return true;                 // 代价可接受
      if (loss <= 0.30) {                            // 有代价但没到不值得
        countScale = 0.5;
        syncCount(currentTier); requestStatic(false);
        return true;
      }
      probeMuted = false;
      degrade('本机 GPU 上这一层反而更卡（帧率下降 ' + Math.round(loss * 100) + '%）');
      return false;
    }).catch(function () {
      if (generation === probeGeneration) { cancelProbe(true); Stage.kick(); }
      return false;
    });
  }

  // 先真跑一帧，把着色器编译、程序链接、首次 bufferData 这些一次性开销挪到
  // 用户看得见画面之前完成。不预热的话第一帧会卡住几百毫秒，而且那笔一次性的
  // 钱会被下面的探测记到稳态账上。
  function warmUp() {
    if (!renderer || !warmPending || !opts.dust || !particleCount) return true;
    for (var i = 0; i < views.length; i += 1) {
      var v = views[i];
      if (!v.w || !v.h) { metrics.warmUpStatus = 'deferred'; continue; }
      warmFrame.strength = opts.strength / 100;
      var previousVisibility = v.canvas.style.visibility;
      v.canvas.style.visibility = 'hidden';
      var started = perfBegin(), result;
      try { result = renderer.warmUp(v, warmFrame); }
      finally { v.canvas.style.visibility = previousVisibility; }
      metrics.warmUpSubmitCpuMs = perfEnd('warmUpSubmitCpuMs', started);
      metrics.warmUpStatus = result.status; metrics.warmUpDrawCalls = result.drawCalls;
      metrics.warmUpCount = particleCount; metrics.warmUpWidth = v.w; metrics.warmUpHeight = v.h;
      metrics.warmUpDpr = budgetInput.dpr;
      if (result.status === 'failed') throw new Error('粒子预热失败');
      if (result.status === 'submitted') warmPending = false;
    }
    trackResources(); return true;
  }

  function tierIndex(t) { return t < 0 ? 0 : t > 2 ? 2 : t; }
  function budget() { return TIERS[currentTier]; }

  // 颗数按面板面积归一。这一层住在右侧舞台里，窗口大小和皮肤都会改变它的面积，
  // 而固定颗数意味着观感跟着窗口变：小面板糊成一片白雾、大面板只剩稀星。
  // 基准取一个常见尺寸的舞台。上下都要夹住：上限之外宁可稀一点，因为标准渲染器
  // 是逐粒子 drawImage，颗数翻倍就是主线程开销翻倍（2D 那边一千颗左右就开始吃
  // 歌词滚动的帧）；下限之下不许清零，否则窄屏抽屉里这一层直接消失。
  //
  // 还要量化到 1/8 一档：换颗数在两个渲染器里都是整场重播随机位置，跟着
  // 拖窗口的每一帧重算会让粒子在手里跳来跳去。
  var REF_AREA = 460 * 780;
  function areaScale(v) {
    if (!v || !v.w || !v.h) return 1;
    var s = Math.round((v.w * v.h) / REF_AREA * 8) / 8;
    return s < 0.5 ? 0.5 : s > 1.75 ? 1.75 : s;
  }

  function syncCount(t) {
    if (!renderer) return;
    currentTier = tierIndex(t);
    budgetInput.tier = currentTier;
    budgetInput.dpr = Math.min(window.devicePixelRatio || 1, renderer.dpr[currentTier]);
    var caps = renderer.counts;
    var want = Math.max(0, Math.round(caps[currentTier] * (opts.density / 100) * countScale * areaScale(active)));
    if (want !== particleCount) {
      invalidatePreparation();
      if (renderer.setCount(want) === false) throw new Error('粒子数量上传失败');
      particleCount = want; trackResources();
    }
  }

  function colors() {
    return [cssVar('--music-highlight-rgb', '226, 176, 113'),
      cssVar('--music-highlight-alt-rgb', cssVar('--music-highlight-rgb', '226, 176, 113'))];
  }

  function useRenderer(next) {
    cancelProbe();
    backendGeneration += 1; advancing = false; particleCount = 0;
    warmPending = firstFramePending = true;
    countScale = 1;
    // 先释放上一位的资源：GL 渲染器持有 context、VBO 和 program，
    // 不 dispose 就会一直占着显存，切回 2D 也还占着。
    if (renderer && renderer.dispose) {
      trackResources(); renderer.dispose(); trackResources();
    }
    renderer = next;
    rendererName = next ? next.name : 'none';
    try {
    for (var i = 0; i < views.length; i += 1) {
      var v = views[i];
      // 换渲染器时把上一位留下的画面擦干净，否则切回标准模式后
      // GL 的最后一帧会一直糊在 canvas 上（GL 的 drawingBuffer 不受 2D clearRect 影响，
      // 但同一个 canvas 换 context 类型会直接失败，所以这里重建 canvas）。
      replaceCanvas(v);
      if (next && !next.mount(v)) {
        var failedResources = next.resources ? next.resources() : null;
        var failureReason = failedResources && (failedResources.failure || failedResources.mount && failedResources.mount.reason);
        throw new Error('粒子画布创建失败' + (failureReason ? '：' + failureReason : ''));
      }
      currentTier = tierIndex(state.tier);
      budgetInput.tier = currentTier;
      budgetInput.dpr = Math.min(window.devicePixelRatio || 1, next.dpr[currentTier]);
      measureView(v);
    }
    if (next) { var c = colors(); if (next.setColors(c[0], c[1]) === false) throw new Error('粒子色彩更新失败'); }
    syncCount(state.tier);
    trackResources(); requestStatic(false); reportResources();
    return true;
    } catch (e) {
      trackResources();
      if (renderer && renderer.dispose) renderer.dispose();
      trackResources(); renderer = null; rendererName = 'none';
      metrics.failure = e.message; return false;
    }
  }

  function replaceCanvas(v) {
    if (!moduleResources) throw new Error('resource-policy-required');
    var ticket = moduleResources.require({ canvases: 1 }, 'particle host canvas replacement coexistence', lifecycle);
    var fresh = null, previous = v.canvas;
    try {
      fresh = previous.cloneNode(false); fresh.width = fresh.height = 0;
      v.el.replaceChild(fresh, previous);
      ticket.commit();
      previous.width = previous.height = 0;
      v.canvas = fresh; v.ctx = null;
      if (v.canvasTicket) v.canvasTicket.release({ apiReleased: true, allocationEnded: true });
      v.canvasTicket = ticket;
    } catch (e) {
      if (fresh && fresh.parentNode) { v.el.replaceChild(previous, fresh); }
      fresh = null; ticket.release({ apiReleased: true, allocationEnded: true }); throw e;
    }
  }

  // 降级：从增强退回标准。reason 会显示给用户，所以必须是能看懂的人话。
  function degrade(reason) {
    if (rendererName === 'canvas2d') return unavailable(reason);
    degradedTo = reason;
    if (!visible(state) || !active || !active.w || !active.h) {
      cancelProbe(); freeze(state ? state.spectrumRevision : 0);
      if (renderer) { trackResources(); renderer.dispose(); trackResources(); }
      renderer = null; rendererName = 'none'; particleCount = 0;
      pendingFallback = true; pendingAttachMode = null;
      firstFramePending = warmPending = true;
      dirty = true; reportResources(); Stage.kick(); return true;
    }
    var started = perfBegin();
    var ok = useRenderer(Canvas2DRenderer(pageResources ? pageResources.port('stage-particles-canvas') : null));
    metrics.attachCpuMs = perfEnd('attachCpuMs', started);
    if (ok) {
      try { warmUp(); } catch (e) { ok = false; metrics.failure = e.message; }
    }
    if (!ok) return unavailable(reason + '，标准渲染也无法创建');
    document.dispatchEvent(new CustomEvent('stage:degrade', {
      detail: { reason: degradedTo, from: 'enhanced', to: ok ? 'standard' : 'unavailable', ok: ok }
    }));
    return ok;
  }

  function unavailable(reason) {
    var previousMode = rendererName === 'canvas2d' ? 'standard' : mode;
    cancelProbe(); freeze(state ? state.spectrumRevision : 0); clearRipples();
    if (renderer) { trackResources(); renderer.dispose(); trackResources(); }
    renderer = null; rendererName = 'none'; degradedTo = reason;
    pendingAttachMode = null; pendingFallback = false;
    particleCount = 0; budgetInput.dpr = 0;
    dirty = false; metrics.failure = reason;
    reportResources();
    document.dispatchEvent(new CustomEvent('stage:degrade', {
      detail: { reason: reason, from: previousMode, to: 'unavailable', ok: false }
    }));
    return false;
  }

  // 首次生效。之后用户改设置不会换渲染器——那是"重新加载界面"之后的事。
  // 形参不能叫 mode：它会遮蔽模块级的 mode，赋值只改到局部变量上，
  // 结果 mode() 永远返回 'standard'，而 syncRenderModeUi() 正是拿
  // "请求的是增强 / 生效的是标准"这一对差异来判断要不要提示降级的。
  function attach(wanted) {
    if (attached) return rendererName;
    if (!views.length || !state) return 'none';
    mode = (wanted === 'enhanced') ? 'enhanced' : 'standard';
    if (!visible(state) || !active || !active.w || !active.h) {
      pendingAttachMode = mode; reportResources(); Stage.kick(); return 'none';
    }
    pendingAttachMode = null;
    attached = true;
    var started = perfBegin();
    if (visible(state) && active && active.w && active.h && opts.dust && started !== null) firstRequestedAt = started;
    if (mode === 'enhanced') {
      var gl = window.ParticleGL;
      if (!gl) {
        degrade('增强渲染模块未加载');
        metrics.attachCpuMs = perfEnd('attachCpuMs', started);
        return rendererName;
      }
      var instance = lifecycle, generation = backendGeneration + 1;
      if (!useRenderer(gl.create({ resources: pageResources ? pageResources.port('stage-particles-gl') : null, onContextLost: function () {
        if (instance === lifecycle && generation === backendGeneration && rendererName === 'webgl') {
          degrade('显卡渲染上下文丢失');
        }
      } }))) {
        degrade('创建或预热 WebGL 失败');
        metrics.attachCpuMs = perfEnd('attachCpuMs', started);
        return rendererName;
      }
      probePending = true;                          // 等第一次真的在画时再测
      metrics.attachCpuMs = perfEnd('attachCpuMs', started);
      try { warmUp(); } catch (e) { degrade('WebGL 粒子预热失败'); return rendererName; }
      return rendererName;
    }
    if (!useRenderer(Canvas2DRenderer(pageResources ? pageResources.port('stage-particles-canvas') : null))) unavailable('标准粒子渲染无法创建');
    metrics.attachCpuMs = perfEnd('attachCpuMs', started);
    try { warmUp(); } catch (e) { unavailable('标准粒子预热失败'); }
    return rendererName;
  }

  // ---------------------------------------------------------------------------
  // 帧门
  // ---------------------------------------------------------------------------

  function targetFps() {
    if ((pendingAttachMode || pendingFallback) && visible(state) && active && active.w && active.h)
      return TIERS[tierIndex(state.tier)].fps;
    if (!renderer || !visible(state) || !active || !active.w || !active.h) return 0;
    if (probeMuted) return 0;                       // 探测期间本层必须完全不画
    if (!opts.dust && !opts.ripples) return dirty ? 12 : 0;
    if (!state.playing || state.reduced) return dirty ? 12 : 0;
    var busy = feat.pulse >= 0.01 || ripLive > 0;
    if (!busy) return 12;
    return budget().fps;
  }

  function tick(dtMs, frame) {
    if (!frame || frame.version !== 1 || lastFrameId === frame.frameId) return;
    lastFrameId = frame.frameId;
    if (visible(frame) && active && active.w && active.h && !documentHidden()) {
      if (pendingAttachMode) attach(pendingAttachMode);
      else if (pendingFallback) { pendingFallback = false; degrade(degradedTo); }
    }
    if (!renderer || !visible(frame) || documentHidden() || !Stage.isStageVisible() || probeMuted) {
      freeze(frame.spectrumRevision); return;
    }
    var v = pickView();
    if (!v || !renderer) return;
    try {
      var oldTier = currentTier, oldDpr = budgetInput.dpr;
      syncCount(frame.tier);
      if (oldTier !== currentTier || oldDpr !== budgetInput.dpr) {
        invalidatePreparation();
        geometryDirty = true;
        if (probeActive) cancelProbe(true);
      }
      if (geometryDirty) {
        geometryDirty = false;
        var oldWidth = v.w, oldHeight = v.h;
        if (!measureView(v)) { freeze(frame.spectrumRevision); interruptFirstFrame(); return; }
        if (oldWidth !== v.w || oldHeight !== v.h) invalidatePreparation();
        syncCount(frame.tier); trackResources();
      }
      if (!v.w || !v.h) { freeze(frame.spectrumRevision); interruptFirstFrame(); return; }
      if (!opts.dust || !particleCount) interruptFirstFrame();
      if (firstFramePending && firstRequestedAt === null && opts.dust && particleCount && !frame.reduced) {
        firstRequestedAt = perfBegin();
      }
      warmUp();
    } catch (e) { degrade('粒子准备失败：' + e.message); return; }

    var moving = frame.playing && !frame.reduced && (opts.dust || opts.ripples);
    var delta = moving && advancing && isFinite(dtMs) ? Math.min(100, Math.max(0, dtMs)) : 0;
    advancing = !!moving;
    if (moving) sceneTimeMs += delta;
    else freeze(frame.spectrumRevision);

    var fresh = moving && frame.spectrumAvailable && frame.spectrumRevision > spectrumWatermark;
    if (!fresh) invalidateInput(frame.spectrumRevision);
    else {
      if (!primed) {
        onset.prime(frame.spectrum, frame.sampledAtMs); primed = true; invalidated = false;
      } else {
        stepOptions.publishBeat = frame.spectrumRevision !== lastInputRevision;
        onset.step(delta, frame.spectrum, frame.sampledAtMs, stepOptions);
      }
      lastInputRevision = frame.spectrumRevision;
      band.set(onset.agg); rise.set(onset.groupRise);
      feat.pulse = onset.pulse; feat.energy = onset.energy; feat.available = true;
      feat.sampledAt = frame.spectrumReceivedAtMs; feat.spectrumRevision = frame.spectrumRevision;
    }

    instanceFrame.instanceId = lifecycle; instanceFrame.backendGeneration = backendGeneration;
    instanceFrame.frameId = frame.frameId; instanceFrame.sceneTimeMs = instanceFrame.t = sceneTimeMs;
    instanceFrame.geometryDeltaMs = instanceFrame.dt = delta;
    instanceFrame.mediaPositionMs = frame.mediaPositionMs; instanceFrame.mediaEpoch = frame.mediaEpoch;
    instanceFrame.positionAnchorRevision = frame.positionAnchorRevision;
    instanceFrame.positionDiscontinuityRevision = frame.positionDiscontinuityRevision;
    instanceFrame.spectrumRevision = frame.spectrumRevision; instanceFrame.available = feat.available;
    instanceFrame.pulse = feat.pulse; instanceFrame.energy = feat.energy;
    instanceFrame.strength = opts.strength / 100; instanceFrame.drift = opts.dustDrift / 100;
    instanceFrame.tier = currentTier; instanceFrame.requestedMode = mode; instanceFrame.actualBackend = rendererName;
    instanceFrame.count = particleCount; instanceFrame.dpr = budgetInput.dpr; instanceFrame.countScale = countScale;
    if (moving) updateRipples();
    var submitted = false;
    var drawStarted = firstFramePending && opts.dust && particleCount ? perfBegin() : null;
    try {
      if (!opts.dust || !particleCount) {
        if (renderer.clear(v) === false) { degrade('粒子清屏失败'); return; }
      }
      else submitted = renderer.draw(v, instanceFrame);
      if (opts.dust && particleCount && !submitted) { degrade('粒子绘制失败'); return; }
    } catch (e) { degrade('粒子绘制失败：' + e.message); return; }
    dirty = false;
    if (submitted && firstFramePending) {
      metrics.firstFrameSubmitCpuMs = perfEnd('firstFrameSubmitCpuMs', drawStarted);
      if (firstRequestedAt !== null) {
        metrics.firstFrameLatencyMs = typeof HertzPerf !== 'undefined' ? HertzPerf.now() - firstRequestedAt : null;
        if (typeof HertzPerf !== 'undefined') HertzPerf.mark('particles.firstFrameLatencyMs', metrics.firstFrameLatencyMs);
      }
      metrics.firstFrameStatus = 'submitted'; firstFramePending = false;
      reportResources();
    }
    if (submitted && probeActive && !probeMuted) probeDraws += 1;
    if (probePending && rendererName === 'webgl' && moving && submitted) {
      probePending = false;
      probeEnhanced();
    }
  }

  function pickView() {
    var want = views[0];
    if (want && want !== active) {
      if (active && renderer) renderer.clear(active);
      active = want;
      measureView(active);
    }
    return active;
  }

  // ---------------------------------------------------------------------------
  // 参数
  // ---------------------------------------------------------------------------

  function apply(next) {
    if (!next) return;
    var previouslyDisabled = !opts.dust && !opts.ripples;
    var changed = false;
    Object.keys(next).forEach(function (k) {
      if (!(k in opts)) return;
      if (next[k] === opts[k]) return;
      changed = true;
      opts[k] = next[k];
    });
    if (!changed) return;
    invalidatePreparation();
    if (probeActive) cancelProbe(true);
    if (!opts.ripples) clearRipples();
    if (!opts.dust && !opts.ripples) freeze(state ? state.spectrumRevision : 0);
    else if (previouslyDisabled && state) {
      state = Stage.frameState(); advancing = false; invalidateInput(state.spectrumRevision);
    }
    if (!opts.dust || opts.density <= 0) interruptFirstFrame();
    requestStatic(false);
  }

  function init() {
    if (views.length) return api;
    if (!featureTicket) { degradedTo = '舞台资源不足，粒子暂不可用'; return null; }
    stageEl = document.getElementById('stage');
    // onset.js 是硬依赖：没有它就没有"鼓点"，脉冲会永远停在 0，于是涟漪、
    // 律动强度、targetFps 的忙判定一起静默失效——画面还在动，但和音乐脱钩了。
    // 这种"活着但错着"的状态比直接不初始化更难发现，所以宁可不起这一层。
    if (!stageEl || !window.Stage || typeof Stage.gate !== 'function' ||
        typeof Stage.frameState !== 'function' || typeof Stage.onFrameState !== 'function') return null;
    if (!onset) { console.warn('onset.js 未加载，舞台粒子层不启用'); return null; }

    var a = mountView(stageEl, '.stage-lyrics');
    if (!a) return null;
    views = [a];
    active = a;
    lifecycle += 1;
    state = Stage.frameState(); currentTier = tierIndex(state.tier);
    creativeOccluded = layerOccluded();
    sceneTimeMs = 0; lastFrameId = -1; advancing = false;
    spectrumWatermark = state.spectrumRevision; invalidated = true; primed = false;
    lastInputRevision = -1; onset.reset(); neutralize();
    feat.beats = 0; feat.instanceId = lifecycle; feat.spectrumRevision = 0; feat.sampledAt = null;
    instanceFrame.instanceId = lifecycle; instanceFrame.t = instanceFrame.sceneTimeMs = 0;
    instanceFrame.dt = instanceFrame.geometryDeltaMs = 0;
    metrics = { attachCpuMs: null, warmUpSubmitCpuMs: null, firstFrameSubmitCpuMs: null,
      firstFrameLatencyMs: null, warmUpStatus: 'deferred', warmUpDrawCalls: 0, firstFrameStatus: 'pending',
      firstFrameInterruptions: 0, warmUpCount: 0, warmUpWidth: 0, warmUpHeight: 0, warmUpDpr: 0, failure: null };
    resourcePeak = {}; lastResources = null; probeResult = null;
    firstRequestedAt = null; warmPending = firstFramePending = true;
    dirty = geometryDirty = true; measureView(a);
    stateUnsubscribe = Stage.onFrameState(refreshState);
    if (window.MutationObserver) {
      classObserver = new MutationObserver(classChanged);
      classObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    Stage.gate('particles', targetFps, tick);

    document.addEventListener('stage:retint', retint);
    document.addEventListener('stagecontrol:change', controlChanged);
    // 主动拉一次当前值，而不是只等 stagecontrol:change。面板的 init 在启动序列里
    // 排在本模块之前，那次初始广播已经过去了；靠事件顺序来保证参数正确，
    // 是那种改一行 boot 顺序就会静默失效的依赖。
    if (window.StageControl) apply(window.StageControl.values());

    if (window.ResizeObserver) {
      resizeObserver = new ResizeObserver(function () {
        try {
          var wasZero = !active || !active.w || !active.h;
          var oldWidth = active && active.w, oldHeight = active && active.h;
          for (var i = 0; i < views.length; i += 1) measureView(views[i]);
          if (active && (oldWidth !== active.w || oldHeight !== active.h)) invalidatePreparation();
          if (!active || !active.w || !active.h) {
            freeze(state ? state.spectrumRevision : 0); interruptFirstFrame();
          }
          else if (wasZero) {
            state = Stage.frameState(); advancing = false; invalidateInput(state.spectrumRevision);
          }
          if (probeActive) cancelProbe(true);
          trackResources(); requestStatic(true);
        } catch (e) { degrade('粒子尺寸更新失败：' + e.message); }
      });
      for (var i = 0; i < views.length; i += 1) {
        resizeObserver.observe(views[i].el);
        // 封面/卡拉OK切换与长标题会改变内部几何，面板本身的尺寸可能不变。
        views[i].el.querySelectorAll('.disc-wrap, .stage-title').forEach(function (el) {
          resizeObserver.observe(el);
        });
      }
    }

    return api;
  }

  function retint() {
    if (!renderer) return;
    invalidatePreparation();
    var c = colors();
    try {
      if (renderer.setColors(c[0], c[1]) === false) throw new Error('粒子色彩更新失败');
      trackResources();
    }
    catch (e) { degrade('粒子颜色更新失败：' + e.message); }
    if (probeActive) cancelProbe(true);
    requestStatic(false);
  }

  function controlChanged(e) { apply(e.detail); }

  // 销毁：移除注入的画布与涟漪节点、注销帧门
  function destroy() {
    lifecycle += 1;
    cancelProbe();
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    if (classObserver) { classObserver.disconnect(); classObserver = null; }
    if (stateUnsubscribe) { stateUnsubscribe(); stateUnsubscribe = null; }
    document.removeEventListener('stage:retint', retint);
    document.removeEventListener('stagecontrol:change', controlChanged);
    if (window.Stage && Stage.removeGate) Stage.removeGate('particles');
    clearRipples();
    if (renderer && renderer.dispose) { trackResources(); renderer.dispose(); trackResources(); }
    views.forEach(function (v) {
      if (v.pool) v.pool.forEach(function (n) {
        if (n.parentNode) n.parentNode.removeChild(n);
      });
      if (v.canvas && v.canvas.parentNode) v.canvas.parentNode.removeChild(v.canvas);
      if (v.canvas) { v.canvas.width = v.canvas.height = 0; v.canvas = null; }
      if (v.canvasTicket) v.canvasTicket.release({ apiReleased: true, allocationEnded: true });
      v.canvasTicket = null;
    });
    views = [];
    active = null;
    renderer = null;
    rendererName = 'none';
    particleCount = 0; budgetInput.dpr = 0;
    attached = false;
    pendingAttachMode = null; pendingFallback = false;
    degradedTo = null;
    countScale = 1;
    probePending = probeMuted = false;
    ripLive = ripHead = 0;
    state = null; dirty = geometryDirty = false; advancing = false;
    firstRequestedAt = null; neutralize();
    if (onset) onset.reset();
    stageEl = null;
    if (moduleResources) moduleResources.forgetReport();
  }

  var api = {
    init: init,
    destroy: destroy,
    // 由 app.js 在设置加载完成后调用一次；之后再调用不会换渲染器。
    attach: attach,
    renderer: function () { return rendererName; },
    // 用户请求的模式与实际生效的模式是两件事：降级之后 mode 仍然是 enhanced，
    // 但画面跑的是 canvas2d。设置页必须显示后者，否则用户会以为增强模式还开着。
    // GL 上下文丢失时由渲染器回调。丢失不可恢复，只能整体退回 2D。
    handleContextLost: function () { if (rendererName === 'webgl') degrade('显卡渲染上下文丢失'); },
    mode: function () { return mode; },
    effective: function () { return rendererName === 'webgl' ? 'enhanced' : rendererName === 'canvas2d' ? 'standard' : 'unavailable'; },
    attached: function () { return attached; },
    degradedBecause: function () { return degradedTo; },
    values: function () { return JSON.parse(JSON.stringify(opts)); },
    set: function (patch) { apply(patch); },
    // 开关走 StageControl，这样面板上的滑块和实际生效的值不会各说各话。
    toggle: function () {
      var next = !opts.dust;
      if (window.StageControl) window.StageControl.set({ dust: next });
      else apply({ dust: next });
      return next;
    },
    stats: function () {
      return {
        renderer: rendererName, tier: currentTier, fps: targetFps(),
        requestedMode: mode, actualBackend: rendererName, effectiveMode: api.effective(),
        count: particleCount, dpr: budgetInput.dpr, countScale: countScale, reason: degradedTo,
        instanceId: feat.instanceId, backendGeneration: backendGeneration,
        frame: JSON.parse(JSON.stringify(instanceFrame)), dirty: dirty, advancing: advancing,
        available: feat.available, spectrumWatermark: spectrumWatermark,
        metrics: metrics ? Object.assign({}, metrics) : null,
        probe: probeResult ? Object.assign({}, probeResult) : { status: probeActive ? (probeMuted ? 'baseline' : 'webgl') : 'pending' },
        resources: { renderer: renderer && renderer.resources ? renderer.resources() :
          (lastResources ? JSON.parse(JSON.stringify(lastResources)) : null),
          peak: Object.assign({}, resourcePeak), canvases: views.length, rippleNodes: views.length * RIPPLE_POOL,
          gate: views.length ? 1 : 0, resizeObservers: resizeObserver ? 1 : 0,
          classObservers: classObserver ? 1 : 0, stateSubscriptions: stateUnsubscribe ? 1 : 0,
          rippleAnimations: ripLive },
        ripples: ripLive, beats: feat.beats,
        pulse: Number(feat.pulse.toFixed(3)), energy: Number(feat.energy.toFixed(3)),
        bands: Array.prototype.map.call(band, function (v) { return Number(v.toFixed(3)); })
      };
    }
  };

  window.StageParticles = api;
  // Borrow the existing detector output without allocating another analyzer.
  api.audioFeatures = function () { return feat; };
})();
