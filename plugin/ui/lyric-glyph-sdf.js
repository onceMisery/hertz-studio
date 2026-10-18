// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 字形有符号距离场（SDF）核心。
//
// 纯函数，无 DOM、无 Canvas 依赖；浏览器里挂到 window.LyricGlyphSdf，
// Node 里可直接 require，供 scripts/check-glyph-sdf.js 做逐值比对。
//
// 符号约定：phi > 0 在字形内部，phi = 0 在轮廓上，phi < 0 在外部。
// 单位是图集像素（栅格化字号下的像素）。
//
// 距离怎么算：
//   内部像素：phi = dist(到最近外部像素中心) - 0.5
//   外部像素：phi = 0.5 - dist(到最近内部像素中心)
// 减/加这半个像素，是因为轮廓落在相邻像素中心的中点，而不是落在像素中心上。
// 把它写成「raw - 0.5」是错的：raw = dOut - dIn 在内部为正、外部为负，
// 外部要做的是 +0.5 而不是 -0.5，否则所有外部像素会多凹一个像素。
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LyricGlyphSdf = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 有限大数而非 Infinity：edt1d 里有 f[q] - f[v[k]] 的减法，
  // Infinity - Infinity 会得到 NaN 并悄悄污染整条包络线。
  var FAR = 1e20;

  // Felzenszwalb & Huttenlocher 2012：一维平方距离变换。
  //   out[i] = min_j ( f[j] + (i - j)^2 )
  // f[j] 为种子代价（种子 0，非种子 FAR）。O(n)，与采样无关。
  // 这是整个 SDF 的数学核心，不要用两重循环替代。
  function edt1d(f, n, out) {
    var v = new Int32Array(n);
    var z = new Float64Array(n + 1);
    var k = 0, q, s, dq;
    v[0] = 0; z[0] = -FAR; z[1] = FAR;
    for (q = 1; q < n; q += 1) {
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k -= 1;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k += 1; v[k] = q; z[k] = s; z[k + 1] = FAR;
    }
    k = 0;
    for (q = 0; q < n; q += 1) {
      while (z[k + 1] < q) k += 1;
      dq = q - v[k];
      out[q] = dq * dq + f[v[k]];
    }
  }

  // 二维平方距离：返回每个像素到最近种子的最小平方欧氏距离。
  // 两遍一维（先行后列），是精确解，不是近似。
  function edt2d(seed, w, h) {
    var grid = new Float64Array(w * h);
    var line = new Float64Array(Math.max(w, h));
    var res = new Float64Array(Math.max(w, h));
    var x, y, i;
    for (i = 0; i < w * h; i += 1) grid[i] = seed[i] ? 0 : FAR;
    for (y = 0; y < h; y += 1) {
      var row = y * w;
      for (x = 0; x < w; x += 1) line[x] = grid[row + x];
      edt1d(line, w, res);
      for (x = 0; x < w; x += 1) grid[row + x] = res[x];
    }
    for (x = 0; x < w; x += 1) {
      for (y = 0; y < h; y += 1) line[y] = grid[y * w + x];
      edt1d(line, h, res);
      for (y = 0; y < h; y += 1) grid[y * w + x] = res[y];
    }
    return grid;
  }

  // RGBA 缓冲（取 alpha 通道）→ 有符号距离 Float32Array。
  //
  // 全空或全实心时没有可测的边界，返回 null；调用方据此跳过该字形，
  // 而不是画一个实心方块（那是"空白字素"最常见的翻车形态）。
  //
  // opts.threshold：内外判定阈值，默认 127.5。
  // opts.subpixel ：是否用覆盖率修正轮廓像素，默认 true。
  //   直线边缘穿透像素时，中心到边缘的距离约等于 |覆盖 - 0.5|，
  //   比二值化后的 ±0.5 更接近真实；对亚像素定位的平滑边缘有帮助。
  //   若目标平台的光栅化器 alpha 分布异常，可关掉退回纯二值。
  function alphaToSignedDistance(alpha, w, h, opts) {
    var o = opts || {};
    var t = o.threshold == null ? 127.5 : o.threshold;
    var subpixel = o.subpixel !== false;

    var inside = new Uint8Array(w * h);
    var outside = new Uint8Array(w * h);
    var i, a;
    var hasIn = false, hasOut = false;
    for (i = 0; i < w * h; i += 1) {
      a = alpha[i * 4 + 3];
      if (a > t) { inside[i] = 1; hasIn = true; }
      else { outside[i] = 1; hasOut = true; }
    }
    if (!hasIn || !hasOut) return null;

    var dIn = edt2d(inside, w, h);
    var dOut = edt2d(outside, w, h);
    var phi = new Float32Array(w * h);
    for (i = 0; i < w * h; i += 1) {
      if (inside[i]) {
        // 到最近外部中心再退半像素 = 到轮廓的距离
        phi[i] = Math.sqrt(dOut[i]) - 0.5;
      } else {
        // 到最近内部中心再退半像素，方向取负
        phi[i] = 0.5 - Math.sqrt(dIn[i]);
      }
      if (subpixel) {
        var cov = alpha[i * 4 + 3] / 255;
        if (cov > 0 && cov < 1) phi[i] = cov - 0.5;
      }
    }
    return phi;
  }

  // phi（Float32）→ Uint8 编码。128 表示轮廓附近，0 表示远外部，255 表示远内部。
  // 舍入到整数：着色器里按 (v/255 - 0.5) * 2 * range 解码。
  function encodeSdf(phi, range) {
    var r = range || 8;
    var out = new Uint8Array(phi.length);
    for (var i = 0; i < phi.length; i += 1) {
      var v = phi[i] / r;
      if (v < -1) v = -1; else if (v > 1) v = 1;
      out[i] = Math.round((v * 0.5 + 0.5) * 255);
    }
    return out;
  }

  function decodeSdf(byte, range) {
    var r = range || 8;
    return (byte / 255 - 0.5) * 2 * r;
  }

  // 一步到位：RGBA alpha → Uint8 SDF。null 表示空字素。
  function rasterToSdf(alpha, w, h, range, opts) {
    var phi = alphaToSignedDistance(alpha, w, h, opts);
    if (!phi) return null;
    return encodeSdf(phi, range);
  }

  return {
    FAR: FAR,
    edt1d: edt1d,
    edt2d: edt2d,
    alphaToSignedDistance: alphaToSignedDistance,
    encodeSdf: encodeSdf,
    decodeSdf: decodeSdf,
    rasterToSdf: rasterToSdf
  };
});
