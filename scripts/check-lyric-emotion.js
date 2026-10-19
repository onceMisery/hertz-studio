// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// LyricEmotion P0 契约检查：摘要/generation、A→B→A、Cue 缓存双限与清除。
// 纯 Node，无浏览器。

'use strict';

const crypto = require('crypto');
const EM = require('../plugin/ui/lyric-emotion.js');
const F = require('../plugin/ui/lyric-emotion-field.js');

function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function hashOf(lines) {
  const canonical = JSON.stringify([1, lines.map((line) => [line.start_ms, line.text.normalize('NFC')])]);
  return 'sha256:' + crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}
function cue(hash, extra) {
  return Object.assign({
    version: 1, lyricsHash: hash, source: 'fixture',
    lines: [{ index: 0, emotion: 'joy', intensity: 1, confidence: 1 }]
  }, extra || {});
}

(async function main() {
  const A = { lines: [{ start_ms: 0, end_ms: 1000, text: '甲' }] };
  const B = { lines: [{ start_ms: 0, end_ms: 1000, text: '乙' }] };

  // A→B 乱序：先发的 A 结果必须被标 stale，不能覆盖 B 的 hash。
  const pA = EM.bindLyrics(A);
  const pB = EM.bindLyrics(B);
  const [a1, b1] = await Promise.all([pA, pB]);
  assert(a1.stale === true, 'A 的晚到摘要未被标 stale');
  assert(b1.stale === false, 'B 的摘要被误标 stale');
  assert(b1.hash === hashOf(B.lines), 'B 摘要不一致');
  assert(EM.lyricsHash() === b1.hash, '当前摘要不是 B');

  // A→B→A：重新绑定 A 后可以正常装载 A 的 Cue。
  const a2 = await EM.bindLyrics(A);
  assert(a2.stale === false && a2.hash === hashOf(A.lines), 'A→B→A 的 A 摘要异常');
  assert(EM.setCueDoc(cue(a2.hash, { providerId: 'fixture', modelId: 'm' })) === true, 'setCueDoc 失败');
  assert(EM.commitAtBoundary() === true, 'commit 失败');
  const joy = EM.resolveForLine(0, {});
  assert(joy.id === 'joy' && Math.abs(joy.intensity - 1) < 1e-9, '行 Cue 未解析');
  const lut = F.sample(joy.profile, joy.intensity, 72, 0, 0);
  assert(lut.b.length === F.SAMPLE_N, 'LUT 长度异常');

  // P3 扩展档案：triumph 复用 joy 基函数，lonely 新增 u^1.6 基函数。
  const ids = EM.list().map((profile) => profile.id);
  assert(ids.indexOf('triumph') >= 0 && ids.indexOf('lonely') >= 0, 'P3 档案未注册');
  assert(F.BASIS.lonely && F.BASIS.joy, 'lonely/joy 基函数缺失');
  for (const id of ['triumph', 'lonely']) {
    assert(EM.setCueDoc(cue(a2.hash, {
      lines: [{ index: 0, emotion: id, intensity: 1, confidence: 1 }]
    })) && EM.commitAtBoundary(), id + ' Cue 失败');
    const state = EM.resolveForLine(0, {});
    assert(state.id === id, id + ' 解析成 ' + state.id);
    assert(F.sample(state.profile, state.intensity, 72, 0, 0).b.length === F.SAMPLE_N, id + ' 采样长度异常');
  }

  // 缓存命中：同一 hash/provider/model 取回并提交。
  const cached = EM.loadCached(a2.hash, { providerId: 'fixture', modelId: 'm' });
  assert(cached === true, '缓存未命中');
  assert(EM.commitAtBoundary() === true, '缓存 Cue commit 失败');
  assert(EM.resolveForLine(0).id === 'joy', '缓存 Cue 未生效');

  // P3 强度曲线：<1 放大弱情绪，>1 拉开强弱差；非法值拒绝。
  const weak = { intensity: 0.4, confidence: 1 };
  EM.setCurve(0.5);
  const boosted = EM.effectiveIntensity(weak, 1);
  EM.setCurve(1.5);
  const suppressed = EM.effectiveIntensity(weak, 1);
  assert(boosted > suppressed, '强度曲线未改变弱情绪：' + boosted + '/' + suppressed);
  let curveRejected = false;
  try { EM.setCurve(2); } catch (err) { curveRejected = true; }
  assert(curveRejected, '非法强度曲线未拒绝');
  EM.setCurve(1);

  // 清除只清 Cue，不清歌词绑定。
  assert(EM.clearCues() === true, 'clearCues 未改变状态');
  assert(EM.resolveForLine(0).id === 'neutral', 'clearCues 后未回中性');

  // 数量上限：55 个不同 providerId 的 Cue，缓存不超过 50。
  for (let i = 0; i < 55; i += 1) {
    EM.setCueDoc(cue(a2.hash, { source: 'fixture', providerId: 'p' + i }));
  }
  const countStats = EM.cacheStats();
  assert(countStats.entries <= 50, '缓存条目超过 50：' + countStats.entries);
  assert(countStats.entries > 0, '缓存为空');

  // 字节上限：每个 Cue 带 200 KiB source，缓存总量不超过 1 MiB。
  const big = 'x'.repeat(200 * 1024);
  for (let i = 0; i < 8; i += 1) {
    EM.setCueDoc(cue(a2.hash, { source: big, providerId: 'big' + i }));
  }
  const byteStats = EM.cacheStats();
  assert(byteStats.bytes <= 1024 * 1024, '缓存字节超过 1 MiB：' + byteStats.bytes);
  assert(byteStats.entries <= 50, '大 Cue 后条目超过 50');

  // 返回副本：改命中值不能污染缓存。
  const copy = EM.cacheGet(a2.hash, { providerId: 'fixture', modelId: 'm' });
  if (copy) copy.lines[0].intensity = 0;
  const again = EM.cacheGet(a2.hash, { providerId: 'fixture', modelId: 'm' });
  if (again) assert(again.lines[0].intensity === 1, 'cacheGet 返回了可变引用');

  console.log('✓ LyricEmotion P0：A→B→A、摘要、缓存命中/双限、clearCues 全部通过');
  console.log('  cache entries=' + EM.cacheStats().entries + ' bytes=' + EM.cacheStats().bytes);
})().catch((err) => {
  console.error('✗ ' + (err && err.message || err));
  process.exit(1);
});
