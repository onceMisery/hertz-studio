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

  // P3 重音词：按逗号/中文逗号分隔、去重、子串匹配，字重随有效强度插值。
  const revisionBeforeAccent = EM.revision();
  EM.setAccent(true, ' 星光，眼睛,星光 ');
  assert(EM.accentFor('星光'), '重音词未匹配 星光');
  assert(EM.accentFor('你的眼睛'), '重音词未匹配子串');
  assert(!EM.accentFor('晚风'), '非重音词被误匹配');
  assert(EM.accentWeight(700, 1) === 780, '重音字重插值错误');
  assert(EM.accentWeight(400, 0.5) === 440, '低强度重音字重错误');
  assert(EM.revision() > revisionBeforeAccent, '重音设置未推进 revision');
  EM.setAccent(false, '星光');
  assert(!EM.accentFor('星光'), '关闭后重音词仍匹配');

  const signatures = new Set();
  for (const id of ids.filter(id => id !== 'neutral')) {
    const emotion = { id, profile: EM.profiles[id], intensity: 0.8 };
    const pose = EM.motionPose(emotion, 0.7, 2.3, 64, 0.8, false);
    assert(Object.values(pose).every(Number.isFinite), id + ' 姿态必须为有限数');
    assert(Math.abs(pose.x) < 24 && Math.abs(pose.y) < 32 && pose.scaleX > 0.8 && pose.scaleY < 1.3,
      id + ' 位姿越过阅读预算');
    assert(JSON.stringify(pose) === JSON.stringify(EM.motionPose(emotion, 0.7, 2.3, 64, 0.8, false)),
      id + ' seek 后姿态不确定');
    const frozen = EM.motionPose(emotion, 0.7, 2.3, 64, 0.8, true);
    assert(JSON.stringify(frozen) === JSON.stringify(EM.motionPose(emotion, 0.7, 7.8, 64, 0.1, true)),
      id + ' 减少动态仍随时间改变');
    assert(EM.fontFamily(emotion, 'fallback') !== 'fallback', id + ' 未选择字体');
    signatures.add(JSON.stringify(pose));
  }
  assert(signatures.size === 7, '七种情绪必须有独立姿态而不是只换颜色');
  const motionSignatures = new Set();
  for (const id of ids.filter(id => id !== 'neutral')) {
    const emotion = { id, profile: EM.profiles[id], intensity: 0.8 };
    const frames = Array.from({ length: 121 }, (_, i) => EM.motionPose(emotion, 0.37, i / 20, 40, 0, false));
    const span = key => Math.max(...frames.map(p => p[key])) - Math.min(...frames.map(p => p[key]));
    const travel = Math.max(span('x'), span('y'), 40 * span('scaleX'), 40 * span('scaleY'), 40 * span('rotate'));
    assert(travel >= 4, id + ' 默认字号下动态行程不足4px，不能只靠静态字形区分：' + travel);
    const first = frames[0], last = frames[frames.length - 1];
    assert(Object.keys(first).every(key => Math.abs(first[key] - last[key]) < 1e-9), id + ' 6秒循环接缝跳变');
    const deltas = frames.map(p => Object.keys(p).map(key => +(p[key] - first[key]).toFixed(3)));
    motionSignatures.add(JSON.stringify(deltas));
    for (const u of [0, 0.5, 1]) {
      for (let i = 0; i <= 120; i++) {
        const pose = EM.motionPose(emotion, u, i / 20, 64, 1, false);
        assert(Object.values(pose).every(Number.isFinite) && Math.abs(pose.x) < 24 && Math.abs(pose.y) < 32 &&
          pose.scaleX > 0.8 && pose.scaleY > 0.8 && pose.scaleX < 1.3 && pose.scaleY < 1.3,
        id + ' 动画越过阅读预算');
      }
    }
  }
  assert(motionSignatures.size === 7, '七种情绪需要不同的运动轨迹，而不只是静态偏移');
  const wordStyles = new Map();
  const word = { style: { setProperty: (key, value) => wordStyles.set(key, value),
    getPropertyValue: key => wordStyles.get(key) || '', removeProperty: key => wordStyles.delete(key) }, removeAttribute() {} };
  const moving = { id: 'joy', profile: EM.profiles.joy, intensity: 0.8 };
  EM.applyWordMotion(word, moving, 0.37, 1, 40, 0, false);
  const wordFirst = JSON.stringify([...wordStyles]);
  EM.applyWordMotion(word, moving, 0.37, 2, 40, 0, false);
  assert(JSON.stringify([...wordStyles]) !== wordFirst, 'DOM 词动画没有逐帧写入');
  EM.applyWordMotion(word, moving, 0.37, 1, 40, 0, false);
  assert(JSON.stringify([...wordStyles]) === wordFirst, 'DOM 词动画 seek 后未归位');
  EM.clearLine(word, [word]);
  assert(wordStyles.size === 0, '关闭情绪后 DOM 动画变量未清除');
  const effectKinds = { joy: 'sparkle', sorrow: 'tears', anger: 'flame', anxious: 'electric', tender: 'petals', triumph: 'rays', lonely: 'mist' };
  for (const [id, kind] of Object.entries(effectKinds)) {
    const emotion = { id, profile: EM.profiles[id], intensity: 0.8 };
    const first = EM.effectFrame(emotion, 3, 0.7, false);
    assert(first.kind === kind && first.particles.length > 0 && first.particles.length <= 3, id + ' 缺少具象字体特效或超出预算');
    assert(first.particles.every(p => [p.x, p.y, p.scaleX, p.scaleY, p.rotation, p.alpha].every(Number.isFinite) && p.alpha >= 0 && p.alpha <= 1), id + ' 特效参数无效');
    assert(JSON.stringify(first) !== JSON.stringify(EM.effectFrame(emotion, 3, 2.1, false)), id + ' 具象特效没有动画');
    assert(JSON.stringify(first) === JSON.stringify(EM.effectFrame(emotion, 3, 0.7, false)), id + ' 特效 seek 不确定');
    assert(EM.effectFrame(emotion, 3, 0.7, true).particles.length === 0, id + ' 减少动态时仍冒火/滴泪');
  }
  assert(EM.effectFrame(null, 0, 1, false).particles.length === 0, '关闭必须停止具象特效');
  assert(EM.fontFamily({ id: 'neutral' }, 'fallback') === 'fallback', '中性必须保留主题字体');
  const neutralPose = EM.motionPose(null, 0.2, 8, 64, 1, false);
  assert(JSON.stringify(neutralPose) === JSON.stringify({ x: 0, y: 0, rotate: 0, scaleX: 1, scaleY: 1, skew: 0 }),
    '关闭必须恢复单位变换');
  for (const [setter, value] of [['setScale', 0.8], ['setCurve', 0.8], ['setPaletteEnabled', false]]) {
    const before = EM.revision();
    EM[setter](value);
    assert(EM.revision() > before, setter + ' 未通知同一句的渲染器');
    const after = EM.revision();
    EM[setter](value);
    assert(EM.revision() === after, setter + ' 相同设置不能反复重建字形');
  }
  EM.setScale(1); EM.setCurve(1); EM.setPaletteEnabled(true);

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
