#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// 商籁 sonnet 纯函数验证：node scripts/check-stanza-sonnet.js
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', 'crates', 'hertz-studio', 'web', 'stanza');
const U = require(path.join(ROOT, 'stanza-util.js'));
global.StanzaUtil = U;
const FX = require(path.join(ROOT, 'stanza-sonnet-fx.js'));

let failures = 0;
function ok(cond, msg) { if (!cond) { failures += 1; console.error('FAIL:', msg); } else console.log('ok -', msg); }
function eq(a, b, msg) { ok(a === b, msg + ' (got ' + a + ', want ' + b + ')'); }
function near(a, b, eps, msg) { ok(Math.abs(a - b) <= eps, msg + ' (got ' + a + ', want ' + b + ' ±' + eps + ')'); }

// 1) 确定性：同 seed 同序列，异 seed 异序列
(function () {
  const a = FX.seededRandom('sonnet:x'), b = FX.seededRandom('sonnet:x'), c = FX.seededRandom('sonnet:y');
  const seq = [a(), a(), a()];
  eq(b(), seq[0], 'seededRandom 可复现 #1');
  eq(b(), seq[1], 'seededRandom 可复现 #2');
  ok(c() !== seq[0], '不同 seed 不同序列');
  eq(FX.hashString(''), FX.hashString(''), 'hashString 空串稳定');
  ok(FX.hashString('a') !== FX.hashString('b'), 'hashString 区分输入');
})();

// 2) 镜头/构图抽取落在枚举内且确定
(function () {
  const kind = FX.shotKind('track:12.0', {});
  ok(FX.SHOT_KINDS.indexOf(kind) >= 0, 'shotKind 枚举内');
  eq(FX.shotKind('track:12.0', {}), kind, 'shotKind 确定性');
  eq(FX.shotKind('whatever', { shotFlow: 'mask-reveal' }), 'mask-reveal', 'shotFlow 调参固定镜头');
  eq(FX.shotKind('whatever', { shotFlow: 'bogus' }).length > 0, true, 'shotFlow 非法值回退抽取');
  ok(FX.SCENE_KINDS.indexOf(FX.sceneKind('track:1')) >= 0, 'sceneKind 枚举内');
  eq(FX.sceneKind('track:1'), FX.sceneKind('track:1'), 'sceneKind 确定性');
})();

// 3) 字素时间轴：词级时间按字素均分，原文空格对齐补回
(function () {
  const line = {
    startTime: 10, endTime: 13, fullText: '宝贝 我爱你',
    words: [
      { text: '宝贝', startTime: 10, endTime: 11 },
      { text: '我爱你', startTime: 11.5, endTime: 13 }
    ]
  };
  const glyphs = FX.buildGlyphTimeline(line);
  eq(glyphs.map(g => g.text).join(''), '宝贝 我爱你', '字素拼接等于原文');
  near(glyphs[0].startTime, 10, 1e-9, '首字素起点=词起点');
  near(glyphs[0].endTime, 10.5, 1e-9, '词内均分');
  eq(glyphs.length, 6, '空格对齐补回后共 6 字素');
  near(glyphs[3].startTime, 11.5, 1e-9, '第二词首字素起点');
  near(glyphs[5].endTime, 13, 1e-9, '末字素终点=词终点');
  near(glyphs[2].startTime, 11.5, 1e-9, '空格继承邻位时间');
  // 无词级时间轴：整行退化
  const bare = { startTime: 0, endTime: 2, fullText: '啦啦', words: [{ text: '啦啦', startTime: 0, endTime: 2 }] };
  eq(FX.buildGlyphTimeline(bare).length, 2, '两字素');
  eq(FX.buildGlyphTimeline(null).length, 0, 'null 行安全');
})();

// 4) 断句编译：标点硬断、超长软断、phraseStart/End 覆盖组内字素
(function () {
  const mk = (text, gapAt) => {
    const chars = U.graphemes(text);
    const words = chars.map((c, i) => ({
      text: c,
      startTime: i + (gapAt != null && i >= gapAt ? 1 : 0),
      endTime: i + 1 + (gapAt != null && i >= gapAt ? 1 : 0)
    }));
    return { startTime: 0, endTime: words[words.length - 1].endTime, fullText: text, words };
  };
  const line = mk('一二三，四五六');
  const glyphs = FX.compilePhrases(line, { phraseLength: 12 });
  const phrases = new Set(glyphs.map(g => g.phrase));
  ok(phrases.size >= 2, '标点触发断句');
  const comma = glyphs.find(g => g.text === '，');
  const after = glyphs.find(g => g.text === '四');
  ok(comma.phrase < after.phrase, '逗号归前组');
  glyphs.forEach(g => {
    ok(g.phraseStart <= g.startTime && g.phraseEnd >= g.endTime, 'phrase 窗口覆盖字素');
  });
  // 换气 >0.4s 也是硬边界
  const gapLine = mk('甲乙丙丁戊己', 3);
  const g2 = FX.compilePhrases(gapLine, { phraseLength: 12 });
  ok(new Set(g2.map(g => g.phrase)).size >= 2, '换气间隙断句');
  // 无标点无间隙的长串按 phraseLength 软断
  const long = mk('字'.repeat(30));
  const g3 = FX.compilePhrases(long, { phraseLength: 6 });
  ok(new Set(g3.map(g => g.phrase)).size >= 3, 'phraseLength 软断');
})();

// 5) 重音选点：短行/密行/相邻行不选中；确定性
(function () {
  const mkLine = (start, end, text) => ({ startTime: start, endTime: end, fullText: text });
  const lines = [
    mkLine(0, 0.5, '短句不选'),                       // 时长 <2.4s 不选
    mkLine(10, 14, '这是一句足够长而且密度适中的歌词'),   // 应选中
    mkLine(14.2, 18, '紧随其后的长句也不该连续选中'),     // 与上一重音 <7s 不选
    mkLine(40, 44, '间隔足够远的另一句长歌词应当入选')
  ];
  const cues = FX.computeAccentCues(lines, 'sonnet:t1');
  ok(!cues.has(0), '短行不选');
  ok(cues.has(1), '合格长句选中');
  ok(!cues.has(2), '7s 冷却生效');
  const again = FX.computeAccentCues(lines, 'sonnet:t1');
  eq([...again].join(','), [...cues].join(','), 'accentCues 确定性');
  eq(FX.computeAccentCues(null, 'x').size, 0, '非数组安全');
})();

// 6) 镜头位姿：绝对时间函数，行边界回中性，seek 一致
(function () {
  const line = { startTime: 10, endTime: 14, renderHints: {} };
  const base = { activeLine: line, nextLines: [{ startTime: 15 }], playbackTime: 10, lineProgress: 0 };
  const tuning = { cameraIntensity: 1, animationIntensity: 1 };
  const atStart = FX.cameraPose(base, tuning, 'editorial-column', 1280, 720, []);
  const mid = FX.cameraPose({ ...base, playbackTime: 12, lineProgress: 0.5 }, tuning, 'editorial-column', 1280, 720, []);
  const midAgain = FX.cameraPose({ ...base, playbackTime: 12, lineProgress: 0.5 }, tuning, 'editorial-column', 1280, 720, []);
  near(mid.x, midAgain.x, 1e-12, 'cameraPose 确定性 x');
  near(mid.y, midAgain.y, 1e-12, 'cameraPose 确定性 y');
  near(atStart.scale, 1, 1e-9, '行起点 scale 中性');
  ok(Math.abs(mid.scale - 1) < 0.05, '行中段 scale 微推近');
  ok(FX.SHOT_KINDS.every(k => Array.isArray(FX.CAMERA_PATHS[k]) && FX.CAMERA_PATHS[k].length === 8
    && FX.CAMERA_PATHS[k].every(Number.isFinite)), 'CAMERA_PATHS 表完整（7 镜头 × 8 有限数）');
  // reduced：motionScale=0 → 位姿完全中性
  const reduced = FX.cameraPose({ ...base, playbackTime: 12, lineProgress: 0.5 },
    { ...tuning, reducedMotion: true }, 'editorial-column', 1280, 720, []);
  near(reduced.x, 640, 1e-9, 'reduced x 回中');
  near(reduced.y, 360, 1e-9, 'reduced y 回中');
  near(reduced.scale, 1, 1e-9, 'reduced scale 回中');
})();

// 7) 频谱分段与行释放时长
(function () {
  const bands = FX.resolveAudioBands([]);
  eq(bands.power, 0, '空频谱 power=0');
  const full = FX.resolveAudioBands(new Array(64).fill(0.5));
  near(full.bass, 0.5, 1e-9, 'bass 均值');
  near(full.power, 0.5, 1e-9, '均匀谱 power=均值');
  eq(FX.releaseOf({ lineTransitionMode: 'none' }, {}), 0, 'micro 行零释放');
  eq(FX.releaseOf({ lineTransitionMode: 'fast' }, {}), 0.08, 'fast 行 0.08s');
  eq(FX.releaseOf({}, {}), 0.45, 'normal 行默认 0.45s');
})();

// 8) 起音检测：静音无冲击，跳变自动复位
(function () {
  const det = FX.createOnsetDetector();
  const frame = (t, playing, spectrum) => ({ playbackTime: t, isPlaying: playing,
    audio: { power: 0, spectrum: spectrum || [] }, lines: [], track: { path: 'x' } });
  det.update(frame(0, true, new Array(64).fill(0)));
  const s1 = det.update(frame(0.03, true, new Array(64).fill(0)));
  eq(s1.impact, 0, '静音零冲击');
  const s2 = det.update(frame(0.06, true, new Array(64).fill(0.9)));
  ok(s2.impact >= 0, '突增谱产生非负冲击');
  const s3 = det.update(frame(5, true, new Array(64).fill(0)));
  ok(s3.reset, '时间跳变触发复位');
})();

if (failures) { console.error(failures + ' 项失败'); process.exit(1); }
console.log('check-stanza-sonnet 全部通过');
