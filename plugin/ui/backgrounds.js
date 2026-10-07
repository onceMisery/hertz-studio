// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 自定义背景：舞台后面那层大面积的底色。
//
// 六种来源（跟随主题 / 渐变网格 / 流场 / 频谱色谱 / 用户图片视频 / 封面取色）
// 统一成一个 apply(spec) 接口，切换时只改一件事：谁来画这一层。
//
// 三个贯穿的实现取舍：
//
// 1. **画得很小，让合成器放大。** 生成式背景的离屏画布固定压在长边 384 像素，
//    再由 CSS 拉伸到全屏并加一层 blur。理由：背景是低频图像，信息量本来就低；
//    按屏幕分辨率逐像素算，多花的代价全用在合成器一秒后就抹掉的高频上。
//
// 2. **用户媒体不出本机。** 图片/视频走 File API → ObjectURL，只存在于当前
//    标签页的内存里，既不上传也不落 IndexedDB。这是"本地优先"那条承诺在
//    背景功能上的具体含义 —— 换台机器打不开是特性，不是缺陷。
//
// 3. **视频背景要主动降速降分辨率。** 一个 4K 60fps 的视频当背景，解码器会
//    一直占着 GPU，三维舞台就没得用了。所以只接受用户上传，并且强制
//    playbackRate 降速、画布式降采样。默认关闭，要点开才用。

(function () {
  'use strict';

  var MAX_EDGE = 384;             // 离屏画布长边上限
  var BG_FPS = 12;                // 生成式背景的目标帧率

  // 每种类型「出厂时」的融合参数。用户显式设过的值存在 spec 里，优先级更高。
  // 与 creative.css 里旧的硬编码值保持一致，保证默认观感不变。
  var FX_DEFAULTS = {
    media: { opacity: 55, blur: 0 },
    mesh: { opacity: 90, blur: 38 },
    spectrogram: { opacity: 62, blur: 0 },
    flow: { opacity: 80, blur: 6 },
    cover: { opacity: 90, blur: 38 }
  };
  var BLEND_MODES = ['normal', 'screen', 'overlay', 'soft-light', 'lighten'];

  var state = {
    spec: { type: 'theme' },
    layer: null,
    canvas: null,
    ctx: null,
    media: null,                  // <img> 或 <video>
    mediaUrl: null,               // 用户本地文件的 ObjectURL，切走时要 revoke
    w: 0, h: 0,
    attached: false,
    stageHost: null,              // 大舞台复用同一背景层，退出后归还原挂点
    homeParent: null,
    homeNext: null,
    coverUrl: null,
    palette: null,                // 从封面提出来的一组颜色 [[r,g,b], ...]
    palFor: null,                 // 上面那组颜色属于哪张封面，用来判断要不要重算
    specColX: 0,                  // 色谱画布的滚动写入位置
    depthEffective: 'flat',       // 实际生效的空间模式（scene 失败时回落）
    wallApi: null,                // 当前 attach 的 BgWall 实例（拆除时的唯一主人）
    txShown: null, tyShown: null, // 上次写出的视差位移
    inputBound: false
  };

  // 视差输入：指针在视口内的归一化位置（-1..1）+ 平滑后的版本。
  // 所有「随动」都读这同一个值，墙和 DOM 位移才不会各晃各的。
  var pointer = { x: 0, y: 0, sx: 0, sy: 0 };

  function $(id) { return document.getElementById(id); }

  function rnd() { return Math.random(); }

  // -------------------------------------------------------------------------
  // 取色
  //
  // 不用 k-means：迭代次数少了结果随机、多了每次切歌都要几十毫秒。改成
  // 4×4×4 的 RGB 直方图（64 个桶）—— 一次遍历，然后挑三个"彼此足够远"
  // 的高票桶，各自回桶内求平均做精修。多次运行结果一致，也够好看。
  // -------------------------------------------------------------------------

  function extractPalette(img) {
    var N = 32;
    var c = document.createElement('canvas');
    c.width = c.height = N;
    var g = c.getContext('2d', { willReadFrequently: true });
    try {
      g.drawImage(img, 0, 0, N, N);
      var data = g.getImageData(0, 0, N, N).data;
      var bins = new Array(64);
      var i, k;
      for (i = 0; i < bins.length; i += 1) bins[i] = { n: 0, r: 0, g: 0, b: 0, sat: 0 };
      for (i = 0; i < data.length; i += 4) {
        var r = data[i], gg = data[i + 1], b = data[i + 2];
        var mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
        if (mx < 26) continue;                       // 纯黑不提色
        var sat = mx === 0 ? 0 : (mx - mn) / mx;
        k = ((r >> 6) << 4) | ((gg >> 6) << 2) | (b >> 6);
        var bin = bins[k];
        bin.n += 1; bin.r += r; bin.g += gg; bin.b += b; bin.sat += sat;
      }
      var list = [];
      for (i = 0; i < bins.length; i += 1) {
        if (!bins[i].n) continue;
        var n = bins[i].n;
        list.push({
          n: n,
          r: bins[i].r / n, g: bins[i].g / n, b: bins[i].b / n,
          sat: bins[i].sat / n,
          // 票数 × 饱和度加权：直方图里最大的一格往往是"整张专辑的灰底"，
          // 乘上饱和度之后真正有颜色的那一格才会浮上来。
          score: Math.pow(n, 0.72) * (0.25 + bins[i].sat)
        });
      }
      if (list.length < 2) return null;
      list.sort(function (a, b) { return b.score - a.score; });

      var picked = [];
      for (i = 0; i < list.length && picked.length < 3; i += 1) {
        var cand = list[i];
        var far = true;
        for (var j = 0; j < picked.length; j += 1) {
          var d = Math.abs(cand.r - picked[j][0]) + Math.abs(cand.g - picked[j][1]) + Math.abs(cand.b - picked[j][2]);
          if (d < 110) { far = false; break; }
        }
        if (far) picked.push([cand.r / 255, cand.g / 255, cand.b / 255]);
      }
      while (picked.length < 3) picked.push(picked[0] || [0.5, 0.4, 0.3]);
      return picked;
    } catch (e) {
      return null;                                   // 跨源图片会在这里抛，降级即可
    }
  }

  function themeColors() {
    var a = readVar('--music-highlight-rgb', '226, 176, 113');
    var b = readVar('--music-highlight-alt-rgb', a);
    var c = readVar('--bg', '13, 15, 18');
    return [toRgb(a), toRgb(b), toRgb(c)];
  }

  function readVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function toRgb(str) {
    var p = String(str).split(',');
    return [
      Math.max(0, Math.min(1, (parseFloat(p[0]) || 0) / 255)),
      Math.max(0, Math.min(1, (parseFloat(p[1]) || 0) / 255)),
      Math.max(0, Math.min(1, (parseFloat(p[2]) || 0) / 255))
    ];
  }

  function css(c, a) {
    return 'rgba(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' +
      Math.round(c[2] * 255) + ',' + (a === undefined ? 1 : a) + ')';
  }

  // -------------------------------------------------------------------------
  // 融合参数（不透明度 / 模糊 / 混合 / 空间模式）
  // -------------------------------------------------------------------------

  function clampN(v, min, max, def) {
    var n = Number(v);
    if (!isFinite(n)) return def;
    return Math.max(min, Math.min(max, n));
  }

  // 把外部传进来的 spec 收成一份字段齐全、值合法的副本。默认值按类型取。
  function normalizeSpec(spec) {
    var s = spec && spec.type ? spec : { type: 'theme' };
    var out = { type: s.type };
    if (s.type === 'media') {
      out.url = s.url || '';
      out.media = s.media === 'video' ? 'video' : 'image';
      if (s.name) out.name = s.name;
      if (s.rate !== undefined) out.rate = clampN(s.rate, 0.25, 2, 0.75);
    }
    if (s.type === 'cover' || s.type === 'mesh') {
      out.hue = clampN(s.hue, 0, 360, 0);
    }

    var def = FX_DEFAULTS[s.type];
    if (def) {
      out.opacity = s.opacity === undefined ? def.opacity
        : clampN(s.opacity, 0, 100, def.opacity);
      out.blur = s.blur === undefined ? def.blur
        : clampN(s.blur, 0, 60, def.blur);
      out.blend = BLEND_MODES.indexOf(s.blend) >= 0 ? s.blend : 'normal';
      out.depthMode = ['flat', 'parallax', 'scene'].indexOf(s.depthMode) >= 0
        ? s.depthMode : 'flat';
    }
    return out;
  }

  // 把融合参数写进层上的 CSS 变量，creative.css 各类型规则按变量消费。
  function configureFx() {
    if (!state.layer) return;
    var s = state.spec;
    if (!FX_DEFAULTS[s.type]) return;
    var st = state.layer.style;
    st.setProperty('--bg-opacity', (s.opacity / 100).toFixed(3));
    st.setProperty('--bg-blur', s.blur + 'px');
    st.setProperty('--bg-blend', s.blend);
  }

  // 墙的纹理源：媒体类型用 <img>/<video>，生成式类型用离屏画布。
  function wallSource() {
    return state.spec.type === 'media' ? state.media : state.canvas;
  }

  function ensureWall() {
    if (!window.BgWall || !state.layer) return false;
    if (state.wallApi && state.wallApi.ready()) {
      state.wallApi.setSource(wallSource());
      return true;
    }
    var ok = window.BgWall.attach(state.layer, onWallLost);
    if (ok) {
      state.wallApi = window.BgWall;   // 留一份主人引用，window.BgWall 被换也能拆
      state.wallApi.setSource(wallSource());
    }
    return ok;
  }

  function destroyWall() {
    // 用登记时的模块实例：window.BgWall 可能已被置空/替换，但旧墙归旧实例管
    var BW = state.wallApi || window.BgWall;
    if (BW && BW.ready && BW.ready()) BW.dispose();
    state.wallApi = null;
  }

  function onWallLost() {
    // 上下文丢失：摘画布是硬契约，然后让 data-depth 立刻反映降级真相
    var BW = state.wallApi || window.BgWall;
    if (BW && BW.detach) BW.detach();
    state.wallApi = null;
    state.depthEffective = 'parallax';
    if (state.layer) state.layer.dataset.depth = 'parallax';
  }

  // 空间模式生命周期：谁在 DOM 里、墙是否存在，全部在这里收口。
  function configureDepth() {
    if (!state.layer) return;
    var want = state.spec.depthMode || 'flat';
    var eff = want;
    if (want === 'scene') {
      eff = ensureWall() ? 'scene' : 'parallax';
      if (eff !== 'scene') destroyWall();   // 旧墙残留必须摘除，不能留在 DOM 里
    } else {
      destroyWall();
    }
    state.depthEffective = eff;
    state.layer.dataset.depth = eff;
    // 离开视差/墙时位移立即归零，避免残留半个像素
    if (eff === 'flat') {
      state.txShown = null; state.tyShown = null;
      state.layer.style.removeProperty('--bg-tx');
      state.layer.style.removeProperty('--bg-ty');
    }
  }

  // 轻量更新：类型与素材没变时不拆 DOM、不重起视频，只刷新融合参数。
  function update(spec) {
    var next = normalizeSpec(spec);
    var structural = next.type !== state.spec.type ||
      (next.type === 'media' && next.url !== state.spec.url);
    if (structural) return apply(spec);
    state.spec = next;
    configureFx();
    configureDepth();
    if (state.media && state.media.tagName === 'VIDEO') {
      state.media.playbackRate = next.rate === undefined ? 0.75 : next.rate;
    }
    refresh();
    return state.spec;
  }

  // -------------------------------------------------------------------------
  // 层
  // -------------------------------------------------------------------------

  function ensureLayer() {
    if (state.layer) return state.layer;
    var layer = document.createElement('div');
    layer.id = 'creative-bg';
    layer.setAttribute('aria-hidden', 'true');
    var canvas = document.createElement('canvas');
    canvas.id = 'creative-bg-canvas';
    layer.appendChild(canvas);
    // 插在 body 最前面：它是最底下的一层，DOM 顺序本身就保证了层级，
    // 不需要靠 z-index 跟别的模块比赛谁的数字大。
    document.body.insertBefore(layer, document.body.firstChild);
    state.homeParent = layer.parentNode;
    state.homeNext = layer.nextSibling;
    if (state.stageHost) state.stageHost.appendChild(layer);
    state.layer = layer;
    state.canvas = canvas;
    state.ctx = canvas.getContext('2d');
    return layer;
  }

  // 只搬 DOM，不重新 apply：本地 ObjectURL、视频进度和 BgWall 的纹理主人都不变。
  function setStageHost(host) {
    state.stageHost = host || null;
    if (state.layer) {
      var parent = state.stageHost || state.homeParent || document.body;
      if (state.layer.parentNode !== parent) {
        var next = !state.stageHost && state.homeNext && state.homeNext.parentNode === parent
          ? state.homeNext : null;
        parent.insertBefore(state.layer, next);
      }
      if (isCanvasType()) sizeCanvas();
      if (state.wallApi && state.wallApi.ready()) state.wallApi.resize();
    }
    syncMediaPlayback();
    refresh();
  }

  function isVisible() {
    return !document.hidden && !!state.layer && !state.layer.hidden
      && (!!state.stageHost || !document.body.classList.contains('s3d-open'));
  }

  function syncMediaPlayback() {
    var media = state.media;
    if (!media || media.tagName !== 'VIDEO') return;
    if (!isVisible()) { media.pause(); return; }
    var playing = media.play();
    if (playing && playing.catch) playing.catch(function () { /* 静帧仍可显示 */ });
  }

  function refresh() {
    // 暂停时改色相、切背景、搬进舞台都立即补一帧，不等待音频推动帧门。
    if (state.spec.type !== 'theme' && isVisible()) tick(0);
    if (window.Stage && Stage.kick) Stage.kick();
  }

  function clearMedia() {
    // 入口处先把「将要清掉的这个元素对应的 URL」固定下来：setLocalFile 会在
    // apply 之前改 state.mediaUrl，不先捕获的话会误撤新 URL（真实存在的隐患）。
    var urlForMedia = state.mediaUrl;
    if (!state.media) { state.mediaUrl = null; return; }
    if (state.media.tagName === 'VIDEO') {
      try { state.media.pause(); } catch (e) { /* 已经停了 */ }
      state.media.removeAttribute('src');
      state.media.load();
    }
    if (state.media.parentNode) state.media.parentNode.removeChild(state.media);
    if (urlForMedia) { try { URL.revokeObjectURL(urlForMedia); } catch (e) { /* 忽略 */ } }
    state.media = null;
    state.mediaUrl = null;
  }

  function sizeCanvas() {
    var vw = Math.max(1, state.stageHost && state.stageHost.clientWidth || window.innerWidth);
    var vh = Math.max(1, state.stageHost && state.stageHost.clientHeight || window.innerHeight);
    var scale = Math.min(1, MAX_EDGE / Math.max(vw, vh));
    var w = Math.max(64, Math.round(vw * scale));
    var h = Math.max(36, Math.round(vh * scale));
    if (state.canvas.width !== w || state.canvas.height !== h) {
      state.canvas.width = w;
      state.canvas.height = h;
      state.w = w; state.h = h;
      if (state.spec.type === 'flow' || state.spec.type === 'spectrogram') resetField();
      return true;
    }
    state.w = w; state.h = h;
    return false;
  }

  // -------------------------------------------------------------------------
  // 流场
  // -------------------------------------------------------------------------

  var flow = { px: null, py: null, life: null, n: 0 };
  var noiseSeed = 1337;

  function hash2(x, y) {
    var n = Math.sin(x * 127.1 + y * 311.7 + noiseSeed) * 43758.5453;
    return n - Math.floor(n);
  }

  function vnoise(x, y) {
    var ix = Math.floor(x), iy = Math.floor(y);
    var fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    var a = hash2(ix, iy), b = hash2(ix + 1, iy);
    var c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
    return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
  }

  function resetField() {
    var n = state.w * state.h > 0 ? Math.round(Math.min(520, state.w * state.h / 220)) : 240;
    flow.n = n;
    flow.px = new Float32Array(n);
    flow.py = new Float32Array(n);
    flow.life = new Float32Array(n);
    for (var i = 0; i < n; i += 1) {
      flow.px[i] = rnd() * state.w;
      flow.py[i] = rnd() * state.h;
      flow.life[i] = rnd();
    }
    if (state.ctx) {
      state.ctx.fillStyle = '#05070a';
      state.ctx.fillRect(0, 0, state.w, state.h);
    }
  }

  function stepFlow(pal, agg, pulse) {
    var g = state.ctx;
    if (!g || !flow.n) return;
    var w = state.w, h = state.h;
    // 拖尾：每帧盖一层半透明底色而不是清屏，粒子就留下轨迹。
    // alpha 跟能量反向走 —— 安静的段落轨迹长、显得空灵；副歌时拖尾变短、
    // 画面变"实"，和音乐的密度对上。
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = 'rgba(5,7,10,' + (0.055 + agg * 0.05).toFixed(3) + ')';
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'lighter';
    g.lineWidth = 1;
    var speed = 0.55 + agg * 1.9 + pulse * 0.9;
    for (var i = 0; i < flow.n; i += 1) {
      var x = flow.px[i], y = flow.py[i];
      // 旋度噪声：用噪声场的有限差分构造无散度方向场，粒子会绕着走而不是
      // 一起涌向某个吸引子 —— 后者看起来像烟雾倒放。
      var e = 0.012;
      var nx1 = vnoise(x * 0.012, y * 0.012), nx2 = vnoise(x * 0.012 + e, y * 0.012);
      var ny1 = vnoise(x * 0.012, y * 0.012), ny2 = vnoise(x * 0.012, y * 0.012 + e);
      var vx = (ny2 - ny1) / e, vy = -(nx2 - nx1) / e;
      var len = Math.hypot(vx, vy) || 1;
      var px = flow.px[i], py = flow.py[i];
      flow.px[i] = x + vx / len * speed;
      flow.py[i] = y + vy / len * speed;
      flow.life[i] -= 0.004;
      if (flow.px[i] < -4 || flow.px[i] > w + 4 || flow.py[i] < -4 || flow.py[i] > h + 4 || flow.life[i] <= 0) {
        flow.px[i] = rnd() * w;
        flow.py[i] = rnd() * h;
        flow.life[i] = 0.6 + rnd() * 0.6;
      }
      var c = pal[i % pal.length];
      g.strokeStyle = css(c, 0.16 + pulse * 0.12);
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(flow.px[i], flow.py[i]);
      g.stroke();
    }
    g.globalCompositeOperation = 'source-over';
  }

  // -------------------------------------------------------------------------
  // 渐变网格
  // -------------------------------------------------------------------------

  function stepMesh(pal, agg, pulse, t) {
    var g = state.ctx;
    if (!g) return;
    var w = state.w, h = state.h;
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = css(pal[2] || [0.05, 0.06, 0.08]);
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'lighter';
    var k = 0.12;
    for (var i = 0; i < 6; i += 1) {
      // 每个光斑一条独立的 Lissajous 轨迹。给不同的相位与频率，六个点才不会
      // 排成一列一起晃 —— 那是这套做法最容易露馅的地方。
      var a = t * 0.00017 * (1 + i * 0.07) + i * 1.7;
      var b = t * 0.00013 * (1 + i * 0.05) + i * 2.3;
      var cx = w * (0.5 + 0.42 * Math.sin(a * (1 + i * 0.13)));
      var cy = h * (0.5 + 0.42 * Math.cos(b * (1 + i * 0.11)));
      var r = Math.max(w, h) * (0.24 + 0.10 * Math.sin(t * 0.0004 + i)) * (1 + agg * 0.35 + pulse * 0.15);
      var c = pal[i % pal.length];
      var grd = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(8, r));
      grd.addColorStop(0, css(c, k * (1.1 + agg)));
      grd.addColorStop(1, css(c, 0));
      g.fillStyle = grd;
      g.fillRect(0, 0, w, h);
    }
    g.globalCompositeOperation = 'source-over';
  }

  // -------------------------------------------------------------------------
  // 频谱色谱
  //
  // 把每一帧的频谱画成一根竖条，随时间横向流过整块画布 —— 于是背景本身就是
  // "这首歌长什么样"。安静段是细密的暗线，副歌是一整片亮带，段落结构一眼可见。
  // -------------------------------------------------------------------------

  function stepSpectrogram(bands, pal, t) {
    var g = state.ctx;
    if (!g || !bands || !bands.length) return;
    var w = state.w, h = state.h;
    // 整帧静音（曲目间隙/seek 后无输入）时主动把历史色谱渐隐掉：
    // 色谱是逐列累积滚动的画布，仅靠新列擦除会让旧网格在屏幕上残留一整屏。
    var maxV = 0;
    for (var bi = 0; bi < bands.length; bi += 1) { if (bands[bi] > maxV) maxV = bands[bi]; }
    // AnalyserNode 在暂停时仍返回最后一帧（非零），必须额外判播放态，
    // 否则暂停/停止后色谱永远不会淡出。
    var silent = !document.body.classList.contains('is-playing') || maxV < 0.01;
    if (silent) {
      var playingNow = document.body.classList.contains('is-playing');
      g.save();
      g.globalCompositeOperation = 'destination-out';
      // 播放中的静音间隙用弱渐隐（保留段落呼吸感）；暂停/停止时快速擦净，
      // 非播放帧门只有 4fps，alpha 要足够大才能在两三秒内消失。
      g.fillStyle = playingNow ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.3)';
      g.fillRect(0, 0, w, h);
      g.restore();
      return;
    }
    if (state.specColX === undefined) state.specColX = 0;
    var x = state.specColX % w;
    var c = pal[0];
    var c2 = pal[1];
    var bw = Math.max(1, Math.round(w / 320));
    for (var i = 0; i < bands.length; i += 1) {
      var v = bands[i];
      var y = h - (i + 1) / bands.length * h;
      var hgt = Math.max(1, h / bands.length + 0.6);
      var mix = v;
      // 不透明度从 0 起：旧实现给每个频段 0.08 的固定底色，静音段也铺满整屏，
      // 32+ 条频段行在深黑背景上显出静态横向网格。静音频段应当完全透明，
      // 只保留极弱（0.015）的底线让极低能量处仍有连续感。
      var alpha = v <= 0.001 ? 0 : 0.015 + v * 0.95;
      g.fillStyle = 'rgba(' + Math.round((c[0] * (1 - mix) + c2[0] * mix) * 255) + ','
        + Math.round((c[1] * (1 - mix) + c2[1] * mix) * 255) + ','
        + Math.round((c[2] * (1 - mix) + c2[2] * mix) * 255) + ','
        + alpha.toFixed(3) + ')';
      g.fillRect(x, y, bw, hgt);
    }
    // 下一列的前瞻：把还没写到的区域擦掉，滚动才不会留残影。
    g.clearRect((x + bw) % w, 0, bw, h);
    state.specColX = x + bw;
  }

  // -------------------------------------------------------------------------
  // 帧门
  // -------------------------------------------------------------------------

  function isCanvasType() {
    return state.spec.type === 'mesh' || state.spec.type === 'flow' ||
      state.spec.type === 'spectrogram' || state.spec.type === 'cover';
  }

  function targetFps() {
    if (!state.attached || state.spec.type === 'theme' || !isVisible()) return 0;
    var playing = document.body.classList.contains('is-playing');
    var depth = state.depthEffective;
    // 墙与视差要跟着指针/视频走：30fps 才顺；非播放时降下来省点。
    if (depth === 'scene') return playing ? 30 : 10;
    if (depth === 'parallax') return playing ? 30 : 12;
    if (!isCanvasType()) return 0;
    return playing ? BG_FPS : 4;
  }

  // 视差平滑：时间常数归一化，任何帧率下手感一致。位移量化到 0.1%，
  // 减少拖动期间的样式写入。
  function updateParallax(dtMs) {
    var k = 1 - Math.exp(-Math.max(0.01, dtMs) / 140);
    pointer.sx += (pointer.x - pointer.sx) * k;
    pointer.sy += (pointer.y - pointer.sy) * k;
    if (state.depthEffective === 'parallax' && state.layer) {
      var tx = Math.round(pointer.sx * 400) / 100;   // 最大 ±4%
      var ty = Math.round(pointer.sy * 300) / 100;   // 最大 ±3%
      if (tx !== state.txShown) {
        state.txShown = tx;
        state.layer.style.setProperty('--bg-tx', tx + '%');
      }
      if (ty !== state.tyShown) {
        state.tyShown = ty;
        state.layer.style.setProperty('--bg-ty', ty + '%');
      }
    }
  }

  // 指针输入只绑一次。触屏没有 pointermove 时视差保持 0，墙仍是静止正视角。
  function bindInput() {
    if (state.inputBound) return;
    state.inputBound = true;
    window.addEventListener('pointermove', function (e) {
      pointer.x = Math.max(-1, Math.min(1, e.clientX / window.innerWidth * 2 - 1));
      pointer.y = Math.max(-1, Math.min(1, e.clientY / window.innerHeight * 2 - 1));
    }, { passive: true });
    window.addEventListener('pointercancel', function () {
      pointer.x = pointer.y = 0;
    }, { passive: true });
    document.addEventListener('visibilitychange', function () {
      syncMediaPlayback();
      if (!document.hidden) refresh();
    });
  }

  function tick(dtMs) {
    var t = window.performance && performance.now ? performance.now() : Date.now();
    var depth = state.depthEffective;
    if (depth === 'parallax' || depth === 'scene') updateParallax(dtMs || 16.7);

    var bands = window.Stage && Stage.spectrum ? Stage.spectrum() : null;
    var agg = 0, pulse = 0;
    if (window.Stage && Stage.energy) agg = Stage.energy() || 0;
    if (window.StageParticles && StageParticles.stats) pulse = StageParticles.stats().pulse || 0;
    if (window.CreativeStage && CreativeStage.stats) {
      var s = CreativeStage.stats();
      if (s.agg) agg = (s.agg[0] + s.agg[1] + s.agg[2] + s.agg[3]) / 4;
    }
    var pal = palette();
    if (state.spec.type === 'flow') stepFlow(pal, agg, pulse);
    else if (state.spec.type === 'spectrogram') stepSpectrogram(bands, pal, t);
    else if (isCanvasType()) stepMesh(pal, agg, pulse, t);

    if (depth === 'scene' && state.wallApi && state.wallApi.ready()) {
      // 墙源在媒体元素刚建出来时可能没同步上，每帧补一次 setSource（只是赋值）
      state.wallApi.setSource(wallSource());
      state.wallApi.render(dtMs || 16.7, {
        yaw: pointer.sx * 0.24,
        pitch: -pointer.sy * 0.12,
        energy: agg
      });
    }
  }

  /// 封面地址解析：插件形态下 state.coverUrl 是元数据里的音源 https 原址，沙箱
  /// CSP 画不出来、canvas 取色也会因跨域污染抛错。HertzCovers.slot 登记回填并
  /// 触发 sidecar 代理；独立形态同步用原址回调。
  function resolveCover(url, apply) {
    if (window.HertzCovers && window.HertzCovers.slot) { window.HertzCovers.slot(url, apply); return; }
    apply(url);
  }

  function palette() {
    if (state.spec.type === 'cover') {
      if (state.palFor !== state.coverUrl) {
        state.palFor = state.coverUrl;
        state.palette = null;
        if (state.coverUrl) {
          var target = state.coverUrl;
          var img = new Image();
          img.onload = function () {
            if (state.palFor === target) { state.palette = extractPalette(img); refresh(); }
          };
          img.onerror = function () { if (state.palFor === target) state.palette = null; };
          resolveCover(target, function (resolved) { if (resolved) img.src = resolved; });
        }
      }
      if (state.palette && state.palette.length === 3) return state.palette;
    }
    var base = themeColors();
    var shift = (state.spec.hue === undefined ? 0 : state.spec.hue) / 360;
    if (!shift) return base;
    return base.map(function (c) { return rotateHue(c, shift); });
  }

  function rotateHue(c, h) {
    var mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
    var l = (mx + mn) / 2;
    var s = mx === mn ? 0 : (l > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn));
    var hh = 0;
    if (mx !== mn) {
      if (mx === c[0]) hh = ((c[1] - c[2]) / (mx - mn) + (c[1] < c[2] ? 6 : 0)) / 6;
      else if (mx === c[1]) hh = ((c[2] - c[0]) / (mx - mn) + 2) / 6;
      else hh = ((c[0] - c[1]) / (mx - mn) + 4) / 6;
    }
    hh = (hh + h) % 1;
    if (s === 0) return [l, l, l];
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    function h2c(t) {
      t = (t + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    return [h2c(hh + 1 / 3), h2c(hh), h2c(hh - 1 / 3)];
  }

  // -------------------------------------------------------------------------
  // 应用
  // -------------------------------------------------------------------------

  function apply(spec) {
    state.spec = normalizeSpec(spec);
    var root = document.documentElement;
    var type = state.spec.type;

    root.dataset.bgType = type;
    root.classList.toggle('creative-bg-on', type !== 'theme');
    bindInput();

    if (type === 'theme') {
      clearMedia();
      destroyWall();
      state.depthEffective = 'flat';
      if (state.layer) {
        delete state.layer.dataset.depth;
        state.layer.hidden = true;
      }
      return state.spec;
    }

    ensureLayer();
    state.layer.hidden = false;
    state.layer.dataset.type = type;

    if (type === 'media') {
      // 同 URL 的重复 apply 必须幂等：setBackground 引发的联动会把同一 spec 再
      // 送进来一遍。真去 applyMedia 的话 clearMedia 会 revoke 这个 blob URL，
      // 紧接着又拿死 URL 建 <img>，图片永远解码失败（实测 naturalWidth=0）。
      if (!(state.media && state.media.src === state.spec.url)) applyMedia();
    } else {
      clearMedia();
      sizeCanvas();
      // 换类型时把画布清干净：流场的拖尾、色谱的滚动列都是跨帧累积的，
      // 不清的话新背景会从旧背景的残影上长出来。
      if (state.ctx) {
        state.ctx.globalCompositeOperation = 'source-over';
        state.ctx.clearRect(0, 0, state.w, state.h);
        state.ctx.fillStyle = '#05070a';
        state.ctx.fillRect(0, 0, state.w, state.h);
      }
      state.specColX = 0;
      if (type === 'flow') resetField();
    }

    // 帧门对所有非主题类型登记一次（media 在视差/墙模式下也要跑）。
    if (!state.attached) {
      state.attached = true;
      if (window.Stage && Stage.gate) Stage.gate('background', targetFps, tick);
      window.addEventListener('resize', function () {
        if (isCanvasType()) sizeCanvas();
        if (state.wallApi && state.wallApi.ready()) state.wallApi.resize();
        refresh();
      });
    }

    configureFx();
    configureDepth();
    syncMediaPlayback();
    refresh();
    return state.spec;
  }

  function applyMedia() {
    clearMedia();
    var src = state.spec.url;
    if (!src) {
      // 没有素材时退回主题色，而不是留一块黑 —— 用户看到的第一眼不该是"坏了"。
      state.layer.hidden = true;
      document.documentElement.dataset.bgType = 'theme';
      return;
    }
    var isVideo = state.spec.media === 'video' || /\.(mp4|webm|mov|m4v)$/i.test(src);
    var el;
    if (isVideo) {
      el = document.createElement('video');
      el.muted = true;
      el.loop = true;
      el.autoplay = !document.hidden;
      el.setAttribute('playsinline', '');
      // 降速：背景视频是氛围，不是内容。放慢之后解码压力下降，移动也更耐看。
      el.playbackRate = state.spec.rate === undefined ? 0.75 : state.spec.rate;
      el.addEventListener('loadeddata', function () {
        if (state.media === el) { syncMediaPlayback(); refresh(); }
      });
    } else {
      el = document.createElement('img');
      el.alt = '';
      el.decoding = 'async';
      el.addEventListener('load', function () { if (state.media === el) refresh(); });
    }
    el.className = 'creative-bg-media';
    el.src = src;
    state.layer.appendChild(el);
    state.media = el;
    // 记下这个元素对应的 URL，供下一次 clearMedia 精确撤销
    state.mediaUrl = src;
  }

  /** 用户选的本地文件。只建 ObjectURL，不上传、不落库。 */
  function setLocalFile(file) {
    if (!file) return apply({ type: 'theme' });
    var url = URL.createObjectURL(file);
    // 旧 URL 由 apply → applyMedia → clearMedia 按 state.mediaUrl 撤销，
    // 这里不提前 revoke，避免历史上「撤错成新 URL」的问题。
    return apply({
      type: 'media',
      url: url,
      media: /^video\//.test(file.type) ? 'video' : 'image',
      name: file.name
    });
  }

  function setCover(url) {
    state.coverUrl = url || null;
  }

  function init() {
    // 从封面读色：封面地址由 Stage 在换曲时写进 .disc 的 background-image。
    // 定时读一次比让 app.js 反过来通知本模块更省事，也不会引入新的耦合 ——
    // 一秒一次的成本可以忽略，而依赖方向保持单向（背景层读 DOM，DOM 不知道它）。
    setInterval(function () {
      var disc = $('cover');
      if (!disc) return;
      var bg = disc.style.backgroundImage || '';
      var m = /url\(["']?([^"')]+)/.exec(bg);
      var url = m ? m[1] : null;
      if (url !== state.coverUrl) state.coverUrl = url;
    }, 1000);
    return api;
  }

  var api = {
    init: init,
    apply: apply,
    update: update,
    setStageHost: setStageHost,
    // 某类型的出厂融合参数（供工坊双击滑块找回默认）
    defaults: function (type) {
      var d = FX_DEFAULTS[type];
      return d ? JSON.parse(JSON.stringify(d)) : null;
    },
    setLocalFile: setLocalFile,
    setCover: setCover,
    frame: function () { /* 背景层有自己的帧门 */ },
    values: function () { return JSON.parse(JSON.stringify(state.spec)); },
    palette: function () { return palette(); },
    // 供工坊预览与测试：把取色算法单独暴露出来
    extractPalette: extractPalette,
    media: function () {
      return state.media ? {
        tag: state.media.tagName,
        rate: state.media.playbackRate,
        paused: state.media.paused !== false
      } : null;
    },
    stats: function () {
      return {
        type: state.spec.type, fps: targetFps(),
        host: state.stageHost ? 'stage3d' : 'home',
        depthMode: state.spec.depthMode || 'flat',
        depthEffective: state.depthEffective,
        wallReady: !!(state.wallApi && state.wallApi.ready()),
        wallTex: state.wallApi && state.wallApi.ready() ? state.wallApi.textureSize() : null,
        size: state.w + 'x' + state.h,
        palette: palette().map(function (c) {
          return '#' + c.map(function (v) { return ('0' + Math.round(v * 255).toString(16)).slice(-2); }).join('');
        })
      };
    }
  };

  window.Backgrounds = api;
})();
