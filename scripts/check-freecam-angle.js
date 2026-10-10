#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// 自由相机（stage-freecam.js）的角度边界契约。
//
// 钉的是"跨过 180° 时不跳"这件事。根因是 yaw 在拖拽里**无界累加**
// （`pose.yawDeg -= dx * LOOK_YAW` 连做几千次都不回绕），而渲染层直接拿它
// 建旋转矩阵。两个后果：
//   ① 精度 —— double 约 15 位有效数字，角度越大每度的浮点间隔越粗，
//      同一朝向算出两个略有差的值，表现为持续微抖；
//   ② 边界 —— 存档存的是无界值，读回后与「飞回」路径 wrap180() 的结果
//      不是同一个数，切风景 / 复位那一帧就跳一下（跨 180° 时最明显）。
//
// 所以要求：**交给渲染层之前折回，且读档也折回**。折回只作用于写出去的值，
// pose 本身保持无界 —— 连续拖拽才不会在 -180/180 处突然反向。
//
// 静态契约测不了"跳不跳"（那是运行时现象），所以这里测的是**折回函数的
// 数学性质**——跨圈等价性与唯一性。性质破了，跳变必然出现；性质成立，
// 运行时就不会跳。

'use strict';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'plugin', 'ui', 'stage-freecam.js'), 'utf8');

let failures = 0, checks = 0;
function check(cond, label, detail) {
  checks += 1;
  if (cond) return;
  failures += 1;
  console.error('  X ' + label + (detail ? '  [' + detail + ']' : ''));
}
function section(name) { console.log('\n' + name); }

// ---------------------------------------------------------------------------
section('折回：写渲染层与读档都必须过wrap180');

check(/ctx\.yawDeg = wrap180\(pose\.yawDeg\)/.test(SRC),
  'writePoseToCtx 里 yaw 折回后才写渲染层（不折回 = 无界值直送矩阵）');
check(/yawDeg:\s*wrap180\(p\.yawDeg\)/.test(SRC),
  'loadPose 读档时折回（旧存档存的是无界值，不折回则首次操作就跳）');

// pose 本身必须保持无界。若连拖拽都折回，跨 -180/180 时会突然反向。
check(!/pose\.yawDeg = wrap180/.test(SRC),
  '拖拽累加的 pose.yawDeg 保持无界（折回会让连续拖拽在边界处反向）');

check(/function wrap180\(v\)\s*\{\s*v = \(\(v \+ 180\) % 360 \+ 360\) % 360 - 180;/.test(SRC),
  'wrap180 用双模保证正值（只写一次 %360 时负数会得到负结果）');

// ---------------------------------------------------------------------------
section('折回函数的数学性质：跨圈等价 + 唯一');

// 从源码里抽出 wrap180 的实现来实测，而不是重写一遍——
// 重写等于"用被测代码的副本自证"，源码改了这里不会报警。
const m = /function wrap180\(v\)\s*\{([^}]*)\}/.exec(SRC);
check(!!m, '能从源码里提取到 wrap180');
const wrap180 = new Function('return function wrap180(v) {' + (m ? m[1] : '') + '}')();

const near = (a, b) => Math.abs(a - b) < 1e-9;

// 跨圈等价：同一朝向无论转过几圈，折回后必须是同一个值。
let eqFail = [];
for (const base of [0, 45, 90, 135, 179.5, -179.5, -90, -1, 0.5, -0.5]) {
  const a = wrap180(base);
  for (const turns of [1, 2, 5, 10, -1, -2, -5, -10]) {
    const b = wrap180(base + turns * 360);
    if (!near(a, b)) eqFail.push(base + '+' + turns + '圈: ' + a + ' vs ' + b);
  }
}
check(eqFail.length === 0,
  '同一朝向跨任意圈数折回后值唯一（这是"跨 180° 不跳"的前提）',
  eqFail.slice(0, 3).join('; '));

// 唯一映射：不能同时给出 +180 与 -180 两个表示，
// 否则插值时"从 180 到 -180"会被算成走完整一圈 —— 那正是跳动。
const hasPlus180 = [0, 180, 540, 900].some(v => wrap180(v) === 180);
check(!hasPlus180, '输出范围是 (-180, -180]，不含 +180（含 +180 会让插值绕远路）');
check(wrap180(180) === -180 && wrap180(-180) === -180,
  '±180 都折到 -180，唯一');
check(wrap180(181) === -179 && wrap180(-181) === 179,
  '跨 180° 两侧连续（181↔-179 只差 2°，不是 358°）');
check(wrap180(360) === 0 && wrap180(-360) === 0,
  '整圈回到原位');

// 值域兜底：任何有限输入都该落在 (-180, 180]，NaN / Infinity 不该静默通过。
const outOfRange = [1e9, -1e9, 1e18, 12345.6789].filter(v => {
  const r = wrap180(v);
  return !(r > -180 && r <= 180);
});
check(outOfRange.length === 0, '极端输入折回后仍在 (-180, 180]',
  JSON.stringify(outOfRange));

// ---------------------------------------------------------------------------
section('聚焦动画（stage-focus.js）：yaw 必须走最短弧');

const FOCUS = fs.readFileSync(
  path.join(__dirname, '..', 'plugin', 'ui', 'stage-focus.js'), 'utf8');

// 这里量的是**行程**，不是值域。跨边界时起点会短暂越出 (-180,180]，
// 那是无害的（渲染走 sin/cos，-181 与 179 完全等价），也是必要代价：
// 若强制起点在域内，179° → -179° 就只能从 180 出发，行程 358° ——
// 那正是要修的跳动。两者不可兼得，选行程短。
check(/function wrap180\(v\)/.test(FOCUS), 'stage-focus.js 有 wrap180');
check(/var yawDelta = wrap180\(from\.yawDeg - toYaw\)/.test(FOCUS),
  '聚焦插值折的是**差值**（折起点会抵消效果，行程又回到 358°）');
check(/lerp\(toYaw \+ yawDelta, toYaw, e\)/.test(FOCUS),
  '插值用折后的差值走最短弧');
check(!/lerp\(from\.yawDeg, toYaw, e\)/.test(FOCUS),
  '不再用裸 lerp（那是 358° 长途旋转的来源）');
// pitch / dist 是标量不是角度，别被顺手折回
check(/lerp\(from\.pitchDeg, toPitch, e\)/.test(FOCUS),
  'pitch 保持标量插值（不是角度，折回是错的）');

// 从源码抽出 wrap180 与 lerp，实测行程上界。
const wf = /function wrap180\(v\)\s*\{([^}]*)\}/.exec(FOCUS);
check(!!wf, '能从 stage-focus.js 提取 wrap180');
if (wf) {
  const wrap = new Function('return function wrap180(v) {' + wf[1] + '}')();
  const lerp = (a, b, k) => a + (b - a) * k;
  let worstSpan = 0, worstPair = null, outOfSpan = 0;
  for (let a = -180; a <= 180; a += 5) {
    for (let b = -180; b <= 180; b += 5) {
      const delta = wrap(a - b);
      const span = Math.abs(b + delta - b);   // = |delta|
      if (span > 180.0001) { outOfSpan++; if (outOfSpan === 1) worstPair = [a, b]; }
      worstSpan = Math.max(worstSpan, span);
      // 逐帧：相邻帧跨度必须都很小（否则就是"跳"）
      let prev = null;
      for (let i = 0; i <= 100; i++) {
        const e = 1 - Math.pow(1 - i / 100, 3);      // easeOutCubic
        const v = lerp(b + delta, b, e);
        if (prev !== null && Math.abs(v - prev) > 20) outOfSpan++;
        prev = v;
      }
    }
  }
  check(worstSpan <= 180.0001, '任意起终角的最大行程 ≤180°（实得 ' + worstSpan.toFixed(1) + '°）',
    worstPair ? '首例 a=' + worstPair[0] + ' b=' + worstPair[1] : '');
  check(outOfSpan === 0, '逐帧插值无大跨度跳变（任意起终角对）',
    outOfSpan ? '首个违规角对 a=' + worstPair[0] + ' b=' + worstPair[1] : '');
}

console.log('\n' + '─'.repeat(56));
console.log(failures
  ? `自由相机角度契约：${checks - failures}/${checks}，${failures} 项失败`
  : `自由相机角度契约：${checks}/${checks} 全部通过`);
process.exit(failures ? 1 : 0);