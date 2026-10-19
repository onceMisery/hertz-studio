// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 情绪场纯函数检查：不启浏览器，直接 require plugin/ui/lyric-emotion-field.js。
// 重点守住两条会被"效果图"掩盖的回归：
//   1. eI=0 必须逐项中性（b/W/T/剪切/激励全回零），否则关掉情绪字仍然是歪的/粗的；
//   2. 任何 pulse/accent 组合下 w 都不许超出图集安全区 0.30–0.62。

'use strict';

const path = require('path');
const F = require(path.join(__dirname, '..', 'plugin', 'ui', 'lyric-emotion-field.js'));

let failures = 0;
function check(name, ok, detail) {
  if (ok) return;
  failures += 1;
  console.error('✗ ' + name + (detail ? ' — ' + detail : ''));
}
function close(a, b, eps) {
  return Math.abs(a - b) <= (eps == null ? 1e-9 : eps);
}

const PROFILES = ['joy', 'sorrow', 'anger', 'anxious', 'tender', 'lonely'];
const profileOf = (id) => ({ field: { basis: id, anchor: 0.12 } });

check('SAMPLE_N 为 33', F.SAMPLE_N === 33, String(F.SAMPLE_N));
check('安全区为 0.30–0.62', F.W_MIN === 0.30 && F.W_MAX === 0.62,
  F.W_MIN + '–' + F.W_MAX);

PROFILES.forEach((id) => {
  const p = profileOf(id);

  // 1. eI=0：三个场 + 剪切 + 激励全部中性
  const z = F.sample(p, 0, 100, 1, 1);
  const zs = F.evaluate(p, 0.37, 0, 100, 1, 1);
  let bad = '';
  for (let i = 0; i < F.SAMPLE_N; i += 1) {
    if (!close(z.b[i], 0) || !close(z.w[i], 0.5)) { bad = '曲线 @' + i; break; }
  }
  if (!bad && (!close(zs.b, 0) || !close(zs.w, 0.5) || !close(zs.t, 0))) bad = 'evaluate 残留';
  if (!bad && (!close(z.turb, 0) || !close(z.shearTan, 0) || !close(z.amp, 0))) bad = '时间参数残留';
  check('eI=0 中性 ' + id, !bad, bad);

  // 2. eI=1：无论节拍/重音怎样，w 都不出安全区
  for (const pulse of [0, 0.5, 1]) {
    for (const accent of [0, 0.5, 1]) {
      const s = F.sample(p, 1, 100, pulse, accent);
      for (let i = 0; i < F.SAMPLE_N; i += 1) {
        // Float32 存 0.62 会变成 0.6200000047，留 1e-6 容差。
        if (s.w[i] < F.W_MIN - 1e-6 || s.w[i] > F.W_MAX + 1e-6) {
          check('安全区 ' + id, false, 'w=' + s.w[i] + ' pulse=' + pulse + ' accent=' + accent);
          break;
        }
      }
    }
  }
});

// joy 的弧：中点贴基线、两端上扬；线性插值到 eI=0 时端点也必须归零
const joy = profileOf('joy');
const joyMid = F.evaluate(joy, 0.5, 1, 100, 0, 0);
const joyStart = F.evaluate(joy, 0, 1, 100, 0, 0);
const joyHalf = F.evaluate(joy, 0, 0.5, 100, 0, 0);
check('joy 中点 b=0', close(joyMid.b, 0, 1e-9), String(joyMid.b));
check('joy 两端 b=-A', close(joyStart.b, -12, 1e-6), String(joyStart.b));
check('joy b 随 eI 线性', close(joyHalf.b, joyStart.b / 2, 1e-9),
  joyHalf.b + ' vs ' + joyStart.b / 2);
check('joy w 随 eI 回中性', close(joyHalf.w, 0.5 + (joyStart.w - 0.5) / 2, 1e-9),
  joyHalf.w + ' vs ' + (0.5 + (joyStart.w - 0.5) / 2));

// sorrow 越到行尾越沉
let prev = -Infinity;
for (let i = 0; i <= 16; i += 1) {
  const v = F.evaluate(profileOf('sorrow'), i / 16, 1, 100, 0, 0).b;
  check('sorrow 单调', v >= prev - 1e-6, 'u=' + (i / 16) + ' b=' + v);
  prev = v;
}

// lonely：纯幂下沉，越到行尾越沉；这是 P3 新增的场基函数
prev = -Infinity;
for (let i = 0; i <= 16; i += 1) {
  const v = F.evaluate(profileOf('lonely'), i / 16, 1, 100, 0, 0).b;
  check('lonely 单调', v >= prev - 1e-6, 'u=' + (i / 16) + ' b=' + v);
  prev = v;
}

// anger 的剪切只随强度出现，eI=0 必须回正
const angerFull = F.sample(profileOf('anger'), 1, 100, 0, 0);
const angerZero = F.sample(profileOf('anger'), 0, 100, 0, 0);
check('anger 有剪切', Math.abs(angerFull.shearTan) > 1e-4, String(angerFull.shearTan));
check('anger eI=0 无剪切', close(angerZero.shearTan, 0), String(angerZero.shearTan));

console.log(failures ? '' : '✓ 情绪场检查通过');
if (failures) {
  console.error('✗ ' + failures + ' 项失败');
  process.exit(1);
}
