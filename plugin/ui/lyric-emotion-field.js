// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// 情绪场：把情绪求值成作用在字形空间上的三条曲线 + 一组时间参数。纯函数，无 DOM。
// 「场的形状」只在这里定义；任何后端只允许采样，不允许自己写公式。
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LyricEmotionField = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SAMPLE_N = 33;   // 与着色器 uCurveB[33] / uCurveW[33] 对齐，改一处必须改两处

  // 形状原语：u ∈ [0,1] 是字素在本行内的归一位置（按 advance 累加）。
  //
  // w 的取值范围受图集实测约束，不是自由参数：
  //   本机字体栈只有三个真实字面（100/200/300 同面、400/500 同面、600/700/800/900 同面），
  //   双图集取 400 与 700 两面：w=0.30 → 400，w=0.50 → 700，
  //   0.50–0.62 用 SDF 膨胀补最后约 1px 的粗端。
  //   增益 4 时 0.62–0.86 的墨量会被 8 位距离场量化吞掉；增益 8 能打开，
  //   代价是 0.70 以上「鬱」的字怀开始被填。情绪场只用 0.30–0.62，
  //   在这个区间里增益 8 不破坏「口 / 回 / 鬱」的结构。
  //
  // 所以可用区间是 0.30–0.62：细端 0.30、粗端 0.62。joy 与 anger 都取粗端附近，
  // 它们的区分不靠粗细，靠基线场（拱 vs 斜）、剪切与扰动——这正是场模型的本意。
  var W_MIN = 0.30, W_MAX = 0.62;
  function clampW(v) { return v < W_MIN ? W_MIN : v > W_MAX ? W_MAX : v; }
  var BASIS = {
    // 两端上扬，中间贴基线：(2u-1)^2 在 u=0.5 取 0、两端取 1
    // 粗端 0.56 → 0.62，幅度很小；joy 的辨识度来自弧线，不来自粗细。
    joy:     { b: function (u) { var t = 2 * u - 1; return -t * t; },
               w: function (u, pulse) { return 0.56 + 0.06 * pulse; }, anchor: 0.10 },
    // 行首几乎不动，行尾明显下坠；粗细同步变细（0.46 → 0.30），走在可用区间上。
    // 末尾的 u^8 只压住 sin 项在 u≈0.94 的回勾，保证行尾是整条曲线的最低点；
    // 中段值几乎不变（0.564 → 0.564），不改变观感。
    sorrow:  { b: function (u) {
                 return 0.35 * Math.sin(Math.PI * u) + 0.65 * Math.pow(u, 1.6) + 0.02 * Math.pow(u, 8);
               },
               w: function (u) { return 0.46 - 0.16 * u; }, anchor: 0.14 },
    // 整行前倾，右端抬起；重音词稍重，但停在 0.62 以内
    anger:   { b: function (u) { return -u; },
               w: function (u, pulse, accent) { return 0.58 + 0.04 * (accent || 0); }, anchor: 0.08 },
    // 没有方向，只有不稳定
    anxious: { b: function () { return 0; },
               w: function () { return 0.52; }, anchor: 0.03 },
    // 极浅的波浪
    tender:  { b: function (u) { return 0.18 * Math.sin(2 * Math.PI * u); },
               w: function () { return 0.44; }, anchor: 0.05 },
    // P3：sorrow 去掉正弦后的纯幂下沉；验证「新增形状」只需加一条基函数。
    lonely:  { b: function (u) { return Math.pow(u, 1.6); },
               w: function (u) { return 0.42 - 0.10 * u; }, anchor: 0.13 }
  };

  // 扰动场（UV 空间振幅）与整行剪切（角度，度）
  var TURB  = { joy: 0,     sorrow: 0.004, anger: 0.012, anxious: 0.020, tender: 0.002, lonely: 0.003 };
  var SHEAR = { joy: 0,     sorrow: 0,     anger: -1.0,  anxious: 0,     tender: 0,     lonely: 0 };

  // 逐字激励：e = amp * (1-x)^damp * sin(2π·freq·x)，x 是该字素已过的时长比例。
  // freq = 0 时 sin = 0，整条式子退化为纯衰减 —— 悲伤不需要第二种分支。
  var EXCITE = {
    joy:     { amp:  0.12, freq: 1.0, damp: 1.5 },   // 干净地跳一下
    sorrow:  { amp: -0.06, freq: 0.0, damp: 2.0 },   // 纯下沉，不回弹
    anger:   { amp:  0.10, freq: 2.0, damp: 3.0 },   // 抽搐后立刻收住
    anxious: { amp:  0.04, freq: 3.0, damp: 1.0 },   // 抖两下停不下来
    tender:  { amp:  0.03, freq: 0.5, damp: 2.0 }
  };

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function basisId(profile) { return (profile && profile.field && profile.field.basis) || null; }

  // 单个 u 上的求值。DOM 后端直接用它；GL 后端用 sample() 的曲线。
  //   eI   有效强度 0..1
  //   emPx 宿主当前字号（CSS px）
  function evaluate(profile, u, eI, emPx, pulse, accent) {
    var id = basisId(profile), basis = BASIS[id];
    if (!basis) return { b: 0, w: 0.5, t: 0 };
    var e = clamp01(eI);
    var anchor = (profile.field && profile.field.anchor != null) ? profile.field.anchor : basis.anchor;
    var A = anchor * e * emPx;          // px
    var uu = clamp01(u);
    // 所有场都从「中性」出发：e=0 时 w 必须是 0.5、b/t 必须是 0。
    // 不能把 basis.w 当成绝对字重直接返回，否则关掉情绪后字仍然偏粗/偏细。
    return {
      b: basis.b(uu) * A,               // 基线位移，px
      w: clampW(0.5 + (basis.w(uu, pulse || 0, accent || 0) - 0.5) * e),
      t: (TURB[id] || 0) * e
    };
  }

  // 采样 SAMPLE_N 点给 GL 当 uniform 数组。长度必须严格等于 SAMPLE_N。
  function sample(profile, eI, emPx, pulse, accent) {
    var id = basisId(profile);
    var b = new Float32Array(SAMPLE_N);
    var w = new Float32Array(SAMPLE_N);
    var i, r;
    for (i = 0; i < SAMPLE_N; i += 1) {
      r = evaluate(profile, i / (SAMPLE_N - 1), eI, emPx, pulse, accent);
      b[i] = r.b; w[i] = r.w;
    }
    var ex = EXCITE[id] || { amp: 0, freq: 0, damp: 2 };
    var e = clamp01(eI);
    return {
      b: b, w: w,
      turb: (TURB[id] || 0) * e,
      // 剪切也是场：强度 0 时整行必须回正，否则中性行仍然是斜的。
      shearTan: Math.tan((SHEAR[id] || 0) * Math.PI / 180) * e,
      amp: ex.amp * e * emPx,        // px，直接进 uAmp
      freq: ex.freq,
      damp: ex.damp
    };
  }

  return {
    SAMPLE_N: SAMPLE_N, W_MIN: W_MIN, W_MAX: W_MAX,
    BASIS: BASIS, TURB: TURB, SHEAR: SHEAR, EXCITE: EXCITE,
    evaluate: evaluate, sample: sample
  };
});
