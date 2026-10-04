// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 起音检测 —— 全项目唯一的一份「鼓点是哪一刻」。
//
// 为什么要有这个文件：粒子层（stage-particles.js）和三维舞台（creative-stage.js）
// 都要在鼓点上做动作，而"切渲染模式时节奏不该变"是硬要求。v1.0 之前两边各写了
// 一份，且**并不等价**：粒子层用自适应阈值（滑动均值 + 1.15σ + 地板），三维层
// 用固定阈值 0.055；一个吃加权分带包络差，一个不吃权重。固定阈值在安静的前奏里
// 一拍都不触发、在副歌里连着一片触发，自适应正好相反——所以症状不是"差半帧"，
// 是"换一种渲染，歌的律动看起来变了"。
//
// 判据本身（保留粒子层那一版，它是实测调过的）：
//   score = Σ 权重 × (快慢包络差 × 2.2 + 正向一阶差分 × 3.0)
// 包络差稳、一阶差分快，单用任何一个都会漏掉一半类型的鼓点，所以要相加。
// 阈值 = 滑动均值 + 1.15σ + 0.035 地板：均值+σ 自适应响度、不需要用户手调灵敏度，
// 地板让极安静的段落不至于把噪声当鼓点。窗口 30 帧 ≈ 1s@30Hz；再长一段歌的响度
// 分布会拖慢自适应，从安静前奏进副歌的头几拍全被漏掉。
// 不应期 220ms（上限约 270 BPM）：再短会让同一个底鼓的上升沿和随后的包络回落
// 各触发一次，画面表现是一次重音被抽了两下。
//
// 时间常数全部按毫秒表达、系数用 1 − exp(−dt/τ)：帧门的推送率随设备档位变化，
// 按"每帧固定比例"平滑的话，同一首歌在两台机器上呼吸速度就不一样了。
//
// 时钟由调用方通过 step(dtMs, spectrum, t) 传进来，本模块不读 performance.now()。
// 这样无头检查可以用可控时钟跑确定性的 fixture——真实时钟下几百次同步 tick 只
// 过去几毫秒，不应期分支根本不会被走到。

(function () {
  'use strict';

  // 服务端 tap 按 TAP_STRIDE=3 抽样，分析带宽只有采样率的三分之一，带边是
  // (i/n)² 二次 spaced。反解出 125Hz / 500Hz / 2kHz / 4.7kHz。
  // 这份分带是**唯一一处**定义，两个消费方都从这里拿，不再各自抄一遍边界。
  var GROUPS = [
    { lo: 0.000, hi: 0.125, w: 1.00 },   // 底鼓 / 贝斯
    { lo: 0.125, hi: 0.250, w: 0.85 },   // 军鼓 / 节奏体
    { lo: 0.250, hi: 0.500, w: 0.35 },   // 人声与和声
    { lo: 0.610, hi: 1.000, w: 0.15 }    // 高频泛音
  ];

  var DEFAULTS = {
    groups: GROUPS,
    binCount: 64,        // 逐段输出的长度（三维层要按它铺频谱纹理）
    history: 30,         // 自适应阈值的滑动窗口（帧）
    sigma: 1.15,
    floor: 0.035,
    refractoryMs: 220,
    fastTau: 45,
    slowTau: 380,
    binTau: 110,         // 逐段平滑
    lowGroupTau: 90,     // 低频组的聚合平滑：要快，鼓点的信息主要在这里
    groupTau: 160,       // 其余各组
    riseWeight: 2.2,
    fluxWeight: 3.0,
    pulseBase: 0.55,
    pulseK: 0.5,
    pulseCap: 1.35,
    decayTau: 170
  };

  function alpha(dtMs, tauMs) {
    return 1 - Math.exp(-Math.max(0.001, dtMs) / tauMs);
  }

  function create(options) {
    var cfg = {};
    var k;
    for (k in DEFAULTS) cfg[k] = DEFAULTS[k];
    if (options) for (k in options) if (options[k] !== undefined) cfg[k] = options[k];

    var NG = cfg.groups.length;
    var NB = cfg.binCount;

    var d = {
      // 调用方直接读这几个数组（不复制，每帧都拷一次纯属浪费）。
      bins: new Float64Array(NB),       // 逐段平滑能量 0–1
      binRise: new Float64Array(NB),    // 逐段快慢包络差（频谱纹理的"起音行"）
      agg: new Float64Array(NG),        // 分带聚合能量
      groupRise: new Float64Array(NG),  // 分带快慢包络差
      energy: 0,
      pulse: 0,
      beats: 0,
      lastBeatAt: 0,
      score: 0,
      threshold: cfg.floor,
      config: cfg
    };

    var fastB = new Float64Array(NB);
    var slowB = new Float64Array(NB);
    var fastG = new Float64Array(NG);
    var slowG = new Float64Array(NG);
    var prevAgg = new Float64Array(NG);
    var hist = new Float64Array(cfg.history);
    var histAt = 0, histN = 0, histSum = 0, histSqr = 0;
    var handlers = [];

    function groupMean(spectrum, n, g) {
      var lo = Math.floor(g.lo * n);
      var hi = Math.max(lo + 1, Math.ceil(g.hi * n));
      if (hi > n) hi = n;
      var acc = 0;
      for (var i = lo; i < hi; i += 1) acc += spectrum[i];
      return acc / (hi - lo);
    }

    d.onBeat = function (fn) { if (typeof fn === 'function') handlers.push(fn); };

    d.reset = function () {
      hist.fill(0);
      histAt = 0; histN = 0; histSum = 0; histSqr = 0;
      fastB.fill(0); slowB.fill(0); fastG.fill(0); slowG.fill(0); prevAgg.fill(0);
      d.bins.fill(0); d.binRise.fill(0); d.agg.fill(0); d.groupRise.fill(0);
      d.energy = 0; d.pulse = 0; d.beats = 0; d.lastBeatAt = 0; d.score = 0;
    };

    // spectrum 可以是任意长度（服务端 spectrum_bands 可配），逐段输出固定
    // 是 binCount 长：按 (i+0.5)/NB 重采样，段数变了着色器和渲染器都不用改。
    d.step = function (dtMs, spectrum, t) {
      var n = spectrum.length;
      if (!n) return;
      var aFast = alpha(dtMs, cfg.fastTau);
      var aSlow = alpha(dtMs, cfg.slowTau);
      var i, g, v;

      for (i = 0; i < NB; i += 1) {
        v = spectrum[Math.min(n - 1, Math.floor((i + 0.5) / NB * n))] || 0;
        fastB[i] += (v - fastB[i]) * aFast;
        slowB[i] += (v - slowB[i]) * aSlow;
        var r = fastB[i] - slowB[i];
        d.binRise[i] = r > 0 ? r : 0;
        d.bins[i] += (v - d.bins[i]) * alpha(dtMs, cfg.binTau);
      }

      var score = 0;
      var total = 0;
      for (g = 0; g < NG; g += 1) {
        var m = groupMean(spectrum, n, cfg.groups[g]);
        total += m;
        fastG[g] += (m - fastG[g]) * aFast;
        slowG[g] += (m - slowG[g]) * aSlow;
        var gr = fastG[g] - slowG[g];
        d.groupRise[g] = gr > 0 ? gr : 0;
        var flux = m - prevAgg[g];
        prevAgg[g] = m;
        score += cfg.groups[g].w *
          (d.groupRise[g] * cfg.riseWeight + (flux > 0 ? flux : 0) * cfg.fluxWeight);
        var tau = g === 0 ? cfg.lowGroupTau : cfg.groupTau;
        d.agg[g] += (m - d.agg[g]) * alpha(dtMs, tau);
      }
      d.energy = total / NG;
      d.score = score;

      var mean = histN ? histSum / histN : 0;
      var variance = histN ? Math.max(0, histSqr / histN - mean * mean) : 0;
      var limit = mean + Math.sqrt(variance) * cfg.sigma + cfg.floor;
      d.threshold = limit;

      if (score > limit && t - d.lastBeatAt > cfg.refractoryMs) {
        d.lastBeatAt = t;
        d.beats += 1;
        // 一次起音给多少冲击按"超出阈值多少"算，而不是非 0 即 1：
        // 否则军鼓和底鼓看起来一样重，画面会显得很平。
        d.pulse = Math.min(cfg.pulseCap, d.pulse + cfg.pulseBase + score * cfg.pulseK);
        for (i = 0; i < handlers.length; i += 1) handlers[i](t, score);
      }

      // 窗口要**先入栈再比较**还是后入栈？这里在判定之后写入，等于
      // "当前帧不进自己的阈值"——否则一个强拍会把自己抬高，紧接着的
      // 第二个强拍被判成噪声。
      histSum += score - hist[histAt];
      histSqr += score * score - hist[histAt] * hist[histAt];
      hist[histAt] = score;
      histAt = (histAt + 1) % cfg.history;
      if (histN < cfg.history) histN += 1;

      d.pulse *= Math.exp(-Math.max(0.001, dtMs) / cfg.decayTau);
    };

    return d;
  }

  window.Onset = { create: create, GROUPS: GROUPS, DEFAULTS: DEFAULTS };
})();
