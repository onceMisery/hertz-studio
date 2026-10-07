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

  var SPRITE = 32;          // 2D 光点精灵的画布边长
  var RIPPLE_POOL = 12;     // 涟漪 DOM 节点池：同时最多 12 圈
  var RIPPLE_MS = 900;

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

  var onset = HAS_ONSET ? Onset.create({ groups: GROUPS }) : null;
  var band = onset ? onset.agg : new Float64Array(0);
  var rise = onset ? onset.groupRise : new Float64Array(0);
  var feat = onset;
  var SILENCE = new Float64Array(64);  // 断供时的静默帧

  var nowMs = (window.performance && window.performance.now)
    ? function () { return performance.now(); }
    : function () { return Date.now(); };

  if (onset) onset.onBeat(function () { if (opts.ripples) spawnRipple(); });

  // ---------------------------------------------------------------------------
  // 涟漪：池化 DOM 节点 + Web Animations
  //
  // 以前画在 canvas 里（每帧重算 12 个椭圆描边）。搬到 DOM 之后：
  //   · 两种渲染器共用同一套实现，不必在 GL 里再写一遍；
  //   · 动画跑在合成线程，主线程一帧都不参与；
  //   · 椭圆边界是矢量描边，不像点阵圆环那样在 DPR 高时露出锯齿。
  // ---------------------------------------------------------------------------

  var ripLive = 0;
  var ripHead = 0;

  function makePool(el) {
    var pool = [];
    for (var i = 0; i < RIPPLE_POOL; i += 1) {
      var n = document.createElement('span');
      n.className = 'stage-ripple';
      n.setAttribute('aria-hidden', 'true');
      el.appendChild(n);
      pool.push(n);
    }
    return pool;
  }

  function spawnRipple() {
    var v = active;
    if (!v || !v.pool || !v.w) return;
    var generation = lifecycle;
    var el = v.pool[ripHead];
    ripHead = (ripHead + 1) % RIPPLE_POOL;
    var wasLive = !el.classList.contains('is-live');
    el.classList.add('is-live');
    el.style.left = v.cx + 'px';
    el.style.top = v.cy + 'px';
    el.style.width = (v.rx * 2) + 'px';
    el.style.height = (v.ry * 2) + 'px';
    var amp = Math.min(1, feat.pulse) * (opts.strength / 100);
    if (el.animate) {
      el.getAnimations().forEach(function (a) { a.cancel(); });
      var anim = el.animate([
        { transform: 'translate(-50%, -50%) scale(0.35)', opacity: 0.30 * amp },
        { transform: 'translate(-50%, -50%) scale(1.55)', opacity: 0 }
      ], { duration: RIPPLE_MS, easing: 'cubic-bezier(0.30, 0, 0.55, 1)' });
      if (wasLive) ripLive += 1;
      anim.onfinish = function () {
        if (generation !== lifecycle) return;
        el.classList.remove('is-live');
        ripLive = Math.max(0, ripLive - 1);
      };
    } else {
      // 没有 WAAPI 的老内核：退回静态显示，至少不会看不到反馈
      el.style.opacity = String(0.30 * amp);
      el.style.transform = 'translate(-50%, -50%) scale(1)';
      if (wasLive) ripLive += 1;
      if (el.__rippleTimer) clearTimeout(el.__rippleTimer);
      el.__rippleTimer = setTimeout(function () {
        if (generation !== lifecycle) return;
        el.__rippleTimer = 0;
        el.classList.remove('is-live');
        el.style.opacity = '';
        ripLive = Math.max(0, ripLive - 1);
      }, RIPPLE_MS);
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
    var c = document.createElement('canvas');
    c.className = 'stage-particles';
    c.setAttribute('aria-hidden', 'true');
    // 插在歌词容器之前：粒子在字后面，文字永远压在最上层，不会被光点糊住。
    if (anchor) el.insertBefore(c, anchor);
    else el.appendChild(c);
    return { el: el, canvas: c, ctx: null, pool: makePool(el), fade0: -1, fade1: -1 };
  }

  function measureView(v) {
    if (!v || !v.el) return false;
    var r = v.el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    v.w = Math.round(r.width);
    v.h = Math.round(r.height);

    // 涟漪圆心：舞台里是唱盘，全屏页里是当前行锚点。让"声音从哪里发出来"
    // 在两个界面里都读得通，而不是两处各自为政。
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

    // 歌词占据的纵向区间。粒子在这一带里要主动让位——文字永远优先于氛围。
    // 区间从 DOM 量出来而不是写死比例，所以窄屏抽屉、字号调整、模式切换
    // 都不需要跟着改这里。
    var anchorRatio = parseFloat(cssVar('--lyric-anchor-ratio', '0.382'));
    if (isStage) {
      // 侧栏里 .stage-lyrics 就是文字区本身，按它的实际矩形让位最准。
      var lyr = v.el.querySelector('.stage-lyrics');
      if (lyr && lyr.clientHeight) {
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
    if (renderer) renderer.resize(v);
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

  function Canvas2DRenderer() {
    var count = 0;
    var sprites = null;
    var px, py, pz, pseed, psize;

    function rebuild(want) {
      if (want === count) return;
      count = want;
      px = new Float32Array(count);
      py = new Float32Array(count);
      pz = new Float32Array(count);
      pseed = new Float32Array(count);
      psize = new Float32Array(count);
      for (var i = 0; i < count; i += 1) {
        px[i] = Math.random();
        // 初始就铺满整个高度，而不是从底部慢慢升上来：冷启动时画面凭空
        // 长出下半截粒子，看着像 bug。
        py[i] = Math.random();
        pz[i] = 0.18 + Math.random() * 0.82;   // 深度：越近越大、越快、越亮
        pseed[i] = Math.random() * Math.PI * 2;
        psize[i] = 0.6 + Math.random() * 1.9;
      }
    }

    function makeSprite(rgb) {
      var c = document.createElement('canvas');
      c.width = c.height = SPRITE;
      var g = c.getContext('2d');
      var grd = g.createRadialGradient(SPRITE / 2, SPRITE / 2, 0, SPRITE / 2, SPRITE / 2, SPRITE / 2);
      grd.addColorStop(0, 'rgba(' + rgb + ',1)');
      grd.addColorStop(0.32, 'rgba(' + rgb + ',0.5)');
      grd.addColorStop(1, 'rgba(' + rgb + ',0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, SPRITE, SPRITE);
      return c;
    }

    return {
      name: 'canvas2d',
      counts: [90, 240, 420],
      dpr: [1.0, 1.3, 1.6],
      mount: function (v) {
        if (!v.ctx) v.ctx = v.canvas.getContext('2d', { alpha: true });
        return !!v.ctx;
      },
      setColors: function (hi, alt) { sprites = [makeSprite(hi), makeSprite(alt)]; },
      setCount: function (n) { rebuild(n); },
      resize: function (v) {
        if (!v.ctx) return;
        var cap = this.dpr[tierIndex()];
        var dpr = Math.min(window.devicePixelRatio || 1, cap);
        var bw = Math.round(v.w * dpr), bh = Math.round(v.h * dpr);
        if (v.canvas.width !== bw || v.canvas.height !== bh) {
          v.canvas.width = bw; v.canvas.height = bh;
        }
        v.canvas.style.width = v.w + 'px';
        v.canvas.style.height = v.h + 'px';
        v.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      },
      clear: function (v) { if (v.ctx) v.ctx.clearRect(0, 0, v.w, v.h); },
      draw: function (v, f) {
        var g = v.ctx;
        if (!g || !sprites) return;
        g.clearRect(0, 0, v.w, v.h);
        if (!count) return;
        var s = f.strength;
        var low = f.bands[0], body = f.bands[1], mid = f.bands[2], air = f.bands[3];
        var pulse = f.pulse * s;
        var t = f.t;
        var lift = f.drift * (0.018 + mid * 0.05) / 1000;
        var breathe = Math.sin(t / 2400) * low * 0.010 * s;
        var push = pulse * 0.055;
        var flick = air * 0.9;
        var flickLane = (t / 90 | 0) % 8;

        // 'lighter' 让重叠的光点累加而不是互相遮挡，这是"舞台灰尘被灯打亮"
        // 的关键一步；代价是密集处会过曝，所以单颗 alpha 压得很低。
        g.globalCompositeOperation = 'lighter';
        for (var i = 0; i < count; i += 1) {
          var z = pz[i];
          py[i] -= lift * (0.4 + z);
          if (py[i] < -0.05) { py[i] = 1.05; px[i] = Math.random(); }
          var sway = Math.sin(t / 1900 + pseed[i]) * 0.012 * (0.3 + z) * (1 + body);
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
          var tw = 0.72 + 0.28 * Math.sin(t / 420 + pseed[i] * 3.1);
          var a = (0.05 + 0.16 * z + low * 0.10 + pulse * 0.14) * tw * textFade(v, y);
          if (flick > 0.02 && (i & 7) === flickLane) a += flick * 0.22;
          if (a < 0.012) continue;               // 暗到看不出的直接跳过，省下上千次 drawImage
          var size = psize[i] * (0.7 + z * 0.9) * (1 + low * 0.5 + pulse * 0.35) * 3.2;
          g.globalAlpha = a > 1 ? 1 : a;
          g.drawImage(sprites[i & 1], x - size / 2, y - size / 2, size, size);
        }
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
      },
      dispose: function () { sprites = null; count = 0; }
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

  function cancelProbe() {
    probeGeneration += 1;
    if (probeFrame) cancelAnimationFrame(probeFrame);
    probeFrame = 0;
    if (finishProbe) { var finish = finishProbe; finishProbe = null; finish(0); }
    probePending = probeMuted = false;
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
    probeMuted = true;
    var generation = probeGeneration;
    return measureFps(500).then(function (base) {
      if (generation !== probeGeneration) return null;
      probeMuted = false;
      return measureFps(500).then(function (withGL) { return { base: base, withGL: withGL }; });
    }).then(function (r) {
      if (!r || generation !== probeGeneration) return false;
      var base = r.base, withGL = r.withGL;
      if (!(base > 0) || !(withGL > 0)) return true;
      var loss = 1 - withGL / base;
      if (loss <= 0.12) return true;                 // 代价可接受
      if (loss <= 0.30) {                            // 有代价但没到不值得
        countScale = 0.5;
        syncCount();
        return true;
      }
      probeMuted = false;
      degrade('本机 GPU 上这一层反而更卡（帧率下降 ' + Math.round(loss * 100) + '%）');
      return false;
    }).catch(function () {
      if (generation === probeGeneration) probeMuted = false;
      return true;
    });
  }

  // 先真跑一帧，把着色器编译、程序链接、首次 bufferData 这些一次性开销挪到
  // 用户看得见画面之前完成。不预热的话第一帧会卡住几百毫秒，而且那笔一次性的
  // 钱会被下面的探测记到稳态账上。
  function warmUp() {
    if (!renderer || !renderer.warmUp) return;
    for (var i = 0; i < views.length; i += 1) {
      var v = views[i];
      if (v.w) renderer.warmUp(v);
    }
  }

  function tierIndex() {
    var t = Stage.tier();
    return t < 0 ? 0 : t > 2 ? 2 : t;
  }

  function budget() { return TIERS[tierIndex()]; }

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

  function syncCount() {
    if (!renderer) return;
    var caps = renderer.counts;
    var want = Math.round(caps[tierIndex()] * (opts.density / 100) * countScale * areaScale(active));
    renderer.setCount(want < 0 ? 0 : want);
  }

  function colors() {
    return [cssVar('--music-highlight-rgb', '226, 176, 113'),
      cssVar('--music-highlight-alt-rgb', cssVar('--music-highlight-rgb', '226, 176, 113'))];
  }

  function useRenderer(next) {
    cancelProbe();
    countScale = 1;
    // 先释放上一位的资源：GL 渲染器持有 context、VBO 和 program，
    // 不 dispose 就会一直占着显存，切回 2D 也还占着。
    if (renderer && renderer.dispose) { try { renderer.dispose(); } catch (e) { /* 忽略 */ } }
    renderer = next;
    rendererName = next ? next.name : 'none';
    for (var i = 0; i < views.length; i += 1) {
      var v = views[i];
      // 换渲染器时把上一位留下的画面擦干净，否则切回标准模式后
      // GL 的最后一帧会一直糊在 canvas 上（GL 的 drawingBuffer 不受 2D clearRect 影响，
      // 但同一个 canvas 换 context 类型会直接失败，所以这里重建 canvas）。
      v.ctx = null;
      if (next && !next.mount(v)) return false;
      measureView(v);
    }
    if (next) { var c = colors(); next.setColors(c[0], c[1]); }
    syncCount();
    return true;
  }

  function replaceCanvas(v) {
    var fresh = v.canvas.cloneNode(false);
    v.el.replaceChild(fresh, v.canvas);
    v.canvas = fresh;
    v.ctx = null;
  }

  // 降级：从增强退回标准。reason 会显示给用户，所以必须是能看懂的人话。
  function degrade(reason) {
    if (rendererName === 'canvas2d') return false;
    degradedTo = reason;
    for (var i = 0; i < views.length; i += 1) replaceCanvas(views[i]);
    var ok = useRenderer(Canvas2DRenderer());
    document.dispatchEvent(new CustomEvent('stage:degrade', {
      detail: { reason: reason, from: 'enhanced', to: 'standard', ok: ok }
    }));
    return ok;
  }

  // 首次生效。之后用户改设置不会换渲染器——那是"重新加载界面"之后的事。
  // 形参不能叫 mode：它会遮蔽模块级的 mode，赋值只改到局部变量上，
  // 结果 mode() 永远返回 'standard'，而 syncRenderModeUi() 正是拿
  // "请求的是增强 / 生效的是标准"这一对差异来判断要不要提示降级的。
  function attach(wanted) {
    if (attached) return rendererName;
    attached = true;
    mode = (wanted === 'enhanced') ? 'enhanced' : 'standard';
    if (mode === 'enhanced') {
      var gl = window.ParticleGL;
      if (!gl || !gl.isAvailable()) {
        degrade(gl ? '本设备不支持 WebGL2' : '增强渲染模块未加载');
        return rendererName;
      }
      for (var i = 0; i < views.length; i += 1) replaceCanvas(views[i]);
      if (!useRenderer(gl.create())) {
        degrade('创建 WebGL 上下文失败');
        return rendererName;
      }
      warmUp();
      probePending = true;                          // 等第一次真的在画时再测
      return rendererName;
    }
    useRenderer(Canvas2DRenderer());
    return rendererName;
  }

  // ---------------------------------------------------------------------------
  // 帧门
  // ---------------------------------------------------------------------------

  var lastSpectrum = null;
  var lastSpectrumAt = 0;

  function targetFps() {
    if (!renderer || Stage.isHidden()) return 0;
    if (probeMuted) return 0;                       // 探测期间本层必须完全不画
    if (!opts.dust && !opts.ripples) return 0;
    var playing = document.body.classList.contains('is-playing');
    // 判"闲下来"只看会不会再动起来的东西：脉冲和涟漪。不看 feat.energy——
    // 它是各带能量的滑动均值，服务端暂停时仍会推近零但非零的帧过来，
    // 拿它当停机条件会让这一层永远差一点点进不了 0 档。
    var busy = feat.pulse >= 0.01 || ripLive > 0;
    if (!playing && !busy) return 0;            // 停下来之后彻底熄掉，一帧都不画
    if (!busy) return 12;                       // 还在收尾：慢速把残响放完
    return budget().fps;
  }

  function tick(dtMs) {
    syncCount();                                // 档位可能被帧率探针下调，整数比较而已
    var v = pickView();
    if (!v || !renderer) return;
    if (!v.w || !v.h) { if (!measureView(v)) return; }

    var sp = Stage.spectrum();
    if (sp && sp.length && sp !== lastSpectrum) {
      lastSpectrum = sp;
      lastSpectrumAt = nowMs();
    }
    // 频谱断供（WS 掉线、服务停了）时喂零，让各带包络自然落回静默。
    // 冻结在最后一帧的后果是"暂停后画面还跟着并不存在的音乐抖"。
    var fresh = !!(sp && sp.length) && lastSpectrumAt > 0 && (nowMs() - lastSpectrumAt < 600);
    onset.step(dtMs, fresh ? sp : SILENCE, nowMs());

    if (!opts.dust) { renderer.clear(v); return; }
    renderer.draw(v, {
      t: nowMs(), dt: dtMs, bands: band, rise: rise,
      pulse: feat.pulse, energy: feat.energy,
      strength: opts.strength / 100, drift: opts.dustDrift / 100
    });

    if (probePending && rendererName === 'webgl' &&
        document.body.classList.contains('is-playing')) {
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
    var densityChanged = false;
    Object.keys(next).forEach(function (k) {
      if (!(k in opts)) return;
      if (k === 'density' && next[k] !== opts[k]) densityChanged = true;
      opts[k] = next[k];
    });
    if (densityChanged) syncCount();
  }

  function init() {
    if (views.length) return api;
    stageEl = document.getElementById('stage');
    // onset.js 是硬依赖：没有它就没有"鼓点"，脉冲会永远停在 0，于是涟漪、
    // 律动强度、targetFps 的忙判定一起静默失效——画面还在动，但和音乐脱钩了。
    // 这种"活着但错着"的状态比直接不初始化更难发现，所以宁可不起这一层。
    if (!stageEl || !window.Stage || typeof Stage.gate !== 'function') return null;
    if (!onset) { console.warn('onset.js 未加载，舞台粒子层不启用'); return null; }

    var a = mountView(stageEl, '.stage-lyrics');
    if (!a) return null;
    views = [a];
    active = a;

    Stage.gate('particles', targetFps, tick);

    document.addEventListener('stage:retint', retint);
    document.addEventListener('stagecontrol:change', controlChanged);
    // 主动拉一次当前值，而不是只等 stagecontrol:change。面板的 init 在启动序列里
    // 排在本模块之前，那次初始广播已经过去了；靠事件顺序来保证参数正确，
    // 是那种改一行 boot 顺序就会静默失效的依赖。
    if (window.StageControl) apply(window.StageControl.values());

    if (window.ResizeObserver) {
      resizeObserver = new ResizeObserver(function () {
        for (var i = 0; i < views.length; i += 1) measureView(views[i]);
      });
      for (var i = 0; i < views.length; i += 1) if (views[i].el) resizeObserver.observe(views[i].el);
    }

    return api;
  }

  function retint() {
    if (!renderer) return;
    var c = colors();
    renderer.setColors(c[0], c[1]);
  }

  function controlChanged(e) { apply(e.detail); }

  // 销毁：移除注入的画布与涟漪节点、注销帧门
  function destroy() {
    lifecycle += 1;
    cancelProbe();
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    document.removeEventListener('stage:retint', retint);
    document.removeEventListener('stagecontrol:change', controlChanged);
    if (window.Stage && Stage.removeGate) Stage.removeGate('particles');
    if (renderer && renderer.dispose) renderer.dispose();
    views.forEach(function (v) {
      if (v.pool) v.pool.forEach(function (n) {
        if (n.getAnimations) n.getAnimations().forEach(function (animation) { animation.cancel(); });
        if (n.__rippleTimer) clearTimeout(n.__rippleTimer);
        if (n.parentNode) n.parentNode.removeChild(n);
      });
      if (v.canvas && v.canvas.parentNode) v.canvas.parentNode.removeChild(v.canvas);
    });
    views = [];
    active = null;
    renderer = null;
    rendererName = 'none';
    attached = false;
    degradedTo = null;
    countScale = 1;
    probePending = probeMuted = false;
    ripLive = ripHead = 0;
    lastSpectrum = null;
    lastSpectrumAt = 0;
    if (onset) onset.reset();
    stageEl = null;
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
    handleContextLost: function () { degrade('显卡渲染上下文丢失'); },
    mode: function () { return mode; },
    effective: function () { return rendererName === 'webgl' ? 'enhanced' : 'standard'; },
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
        renderer: rendererName, tier: Stage.tier(), fps: targetFps(),
        ripples: ripLive, beats: feat.beats,
        pulse: Number(feat.pulse.toFixed(3)), energy: Number(feat.energy.toFixed(3)),
        bands: Array.prototype.map.call(band, function (v) { return Number(v.toFixed(3)); })
      };
    }
  };

  window.StageParticles = api;
})();
