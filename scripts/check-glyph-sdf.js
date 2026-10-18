#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 字形 SDF 核心检查（零依赖、不触网、不碰 DOM）。
//
//   node scripts/check-glyph-sdf.js
//
// 治的是「距离变换只差一个像素、整条歌词的辉光和粗细全歪」这类问题：
// SDF 算错不会抛异常，只会让字看起来"糊了一点""胖了一点"，几十米外没人能归因。
// 所以这里不写快照，所有期望值都是按定义手算的独立结论。
//
// 钉五件事：
//
//   1. 符号：内部为正、外部为负、轮廓在半像素处；
//   2. 距离：与暴力法逐像素对拍（精确 EDT，不是近似）；
//   3. 编解码：8 位量化往返误差不超过 RANGE/255；
//   4. 空字素：全空/全实心必须返回 null，而不是一块实心方块；
//   5. 亚像素修正：可关，关掉后退回纯二值结果。

'use strict';

const path = require('path');
const S = require(path.join(__dirname, '..', 'plugin', 'ui', 'lyric-glyph-sdf.js'));

let checks = 0;
let failures = 0;

function ok(cond, label) {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.error('  ✗ ' + label);
  }
}
function close(actual, want, eps, label) {
  const e = eps == null ? 1e-6 : eps;
  const pass = Math.abs(actual - want) <= e;
  ok(pass, label + '（期望 ' + want + ' ±' + e + '，实得 ' + actual + '）');
}
function section(name) { console.log('\n' + name); }

// 造一个 w*h 的 RGBA 缓冲，只在指定格子写 alpha
function mask(w, h, cells) {
  const buf = new Uint8ClampedArray(w * h * 4);
  cells.forEach(([x, y, a]) => { buf[(y * w + x) * 4 + 3] = a == null ? 255 : a; });
  return buf;
}

// ---------------------------------------------------------------- 1. 单点距离
section('1. 单中心像素的符号与距离（按定义手算）');
{
  const w = 5, h = 5;
  const buf = mask(w, h, [[2, 2]]);
  const phi = S.alphaToSignedDistance(buf, w, h, { subpixel: false });
  const at = (x, y) => phi[y * w + x];

  // 轮廓落在相邻像素中心的中点，所以内部 +0.5、相邻外部 -0.5
  close(at(2, 2), 0.5, 1e-6, '内部像素 φ = +0.5');
  close(at(1, 2), -0.5, 1e-6, '相邻外部 φ = −0.5');
  close(at(2, 1), -0.5, 1e-6, '上方相邻外部 φ = −0.5');
  // 两格外：内部中心到它的距离是 2，轮廓再退半像素
  close(at(0, 2), -1.5, 1e-6, '两格外 φ = −1.5');
  close(at(0, 0), 0.5 - Math.sqrt(8), 1e-6, '对角 φ = 0.5 − √8');

  // 对称性：以 (2,2) 为轴的镜像必须逐值相等（实现若把行列写反，这条会红）
  let sym = true;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (Math.abs(at(x, y) - at(4 - x, y)) > 1e-6) sym = false;
      if (Math.abs(at(x, y) - at(x, 4 - y)) > 1e-6) sym = false;
    }
  }
  ok(sym, '关于中心横纵对称');
}

// ---------------------------------------------------------- 2. 与暴力法对拍
section('2. EDT 与暴力法逐像素对拍（200 组随机掩码）');
{
  const w = 12, h = 12;
  let worst = 0;

  for (let trial = 0; trial < 200; trial += 1) {
    const seed = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i += 1) seed[i] = Math.random() < 0.15 ? 1 : 0;
    seed[0] = 1;                       // 保证至少一个种子

    const fast = S.edt2d(seed, w, h);
    const slow = brute(seed, w, h);

    for (let j = 0; j < w * h; j += 1) {
      const d = Math.abs(Math.sqrt(fast[j]) - Math.sqrt(slow[j]));
      if (d > worst) worst = d;
    }
  }
  close(worst, 0, 1e-9, '最大距离误差');
}

function brute(seed, w, h) {
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let best = Infinity;
      for (let yy = 0; yy < h; yy += 1) {
        for (let xx = 0; xx < w; xx += 1) {
          if (!seed[yy * w + xx]) continue;
          const dx = x - xx, dy = y - yy;
          const d = dx * dx + dy * dy;
          if (d < best) best = d;
        }
      }
      out[y * w + x] = best;
    }
  }
  return out;
}

// -------------------------------------------------------------- 3. 编解码往返
section('3. 8 位量化往返');
{
  const range = 8;
  const src = [-8, -4, 0, 0.5, 4, 8];
  const enc = S.encodeSdf(new Float32Array(src), range);
  const eps = range / 255;

  // 128 附近容差 + 半级量化是必然的，eps 已经含了它
  src.forEach((v, i) => {
    close(S.decodeSdf(enc[i], range), v, eps + 1e-9, '往返 ' + v);
  });

  // 钳位：超出 range 的输入必须饱和，不能回绕
  const clamp = S.encodeSdf(new Float32Array([-100, 100]), range);
  ok(clamp[0] === 0, '远外部钳到 0');
  ok(clamp[1] === 255, '远内部钳到 255');
}

// ------------------------------------------------------------ 4. 空字素语义
section('4. 空字素返回 null');
{
  const w = 5, h = 5;
  ok(S.alphaToSignedDistance(new Uint8ClampedArray(w * h * 4), w, h) === null, '全空 → null');

  const full = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) full[i * 4 + 3] = 255;
  ok(S.alphaToSignedDistance(full, w, h) === null, '全实心 → null（没有可测边界）');

  ok(S.rasterToSdf(new Uint8ClampedArray(w * h * 4), w, h, 8) === null, 'rasterToSdf 同样返回 null');
}

// -------------------------------------------------------- 5. 亚像素修正可开关
section('5. 亚像素修正');
{
  const w = 3, h = 1;
  // 中间像素半覆盖（alpha 100 < 阈值 127.5，二值化后算外部）：
  // 修正后它应落在轮廓上，而不是被推到整整一格之外。
  // 注意别用 alpha=128：它高于阈值 127.5，会被判成内部，测的就不是"外部半覆盖"了。
  const buf = mask(w, h, [[0, 0], [1, 0, 100]]);
  const plain = S.alphaToSignedDistance(buf, w, h, { subpixel: false });
  const sub = S.alphaToSignedDistance(buf, w, h, { subpixel: true });

  close(plain[1], 0.5 - 1, 1e-6, '关闭修正时半覆盖像素按外部计（−0.5）');
  close(sub[1], 100 / 255 - 0.5, 1e-6, '开启修正时按覆盖率定位轮廓');

  // 全实心/全空像素不受修正影响
  ok(plain[0] === sub[0], '满覆盖像素不被修正改写');
}

// -------------------------------------------------------------- 6. 单调性
section('6. 距离场的单调性');
{
  const w = 9, h = 1;
  const buf = mask(w, h, [[4, 0]]);
  const phi = S.alphaToSignedDistance(buf, w, h, { subpixel: false });

  let mono = true;
  for (let x = 0; x < 4; x += 1) {
    // 从左走到中心，φ 应严格递增（−3.5 → −2.5 → −1.5 → −0.5 → +0.5）
    if (!(phi[x] < phi[x + 1])) mono = false;
  }
  ok(mono, '自左向右单调递增至中心');
  ok(phi[4] > 0 && phi[0] < 0, '内部为正、外部为负');
}

// ------------------------------------------------------------------- 汇总
console.log('\n' + (failures ? '✗ ' : '✓ ') + checks + ' 项检查，' + failures + ' 项失败');
process.exit(failures ? 1 : 0);
