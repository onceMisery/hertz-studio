// SPDX-License-Identifier: MIT
// 星诞导演层契约检查：node scripts/check-stanza-starborn.js
//
// 覆盖四块：
//   1) 曲式层（stanza-songform）—— 段落切分、副歌识别的诚实性、句内画像可信度、镜头语法
//   2) 导演（stanza-starborn）—— 段落级切镜时序、候选池硬门、确定性
//   3) 接线 —— 后端内嵌/路由/加载顺序/宿主启用条件
//   4) 呈现层 —— 切镜交接、镜头机架、电影层 CSS 变量的两端一致性
//
// 为什么第 3 块要钉「启用条件」：星诞上线以来一直是死的 —— stage3d 里有个 autoDirector
// 布尔，初始化为 false 且全仓库没有任何赋值点，于是 director.frame() 一次都没被调用，
// effectiveVisual() 永远返回兜底的 'classic'，用户看到的「星诞」就是流光。
// 而当时这 62 项断言全绿：它只查了 frame() 出现在 planeApi() 之前，没查那个 if 能不能为真。
// 现在把「不许再有第二个需要外部置位的开关」钉成断言（见 变异防护 一节）。
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const UI = path.join(ROOT, 'plugin', 'ui');
const ST = path.join(UI, 'stanza');

let failures = 0;
let checks = 0;
function ok(cond, msg) {
  checks += 1;
  if (!cond) { failures += 1; console.error('FAIL:', msg); } else console.log('ok -', msg);
}
function eq(a, b, msg) { ok(a === b, msg + ' (got ' + a + ', want ' + b + ')'); }
function section(name) { console.log('\n' + name); }

// ---------------------------------------------------------------------------
// 模块装载：曲式层与工具在 Node 下是 UMD，星诞是浏览器 IIFE，要用沙箱喂 window。
const U = require(path.join(ST, 'stanza-util.js'));
globalThis.StanzaUtil = U;
const SF = require(path.join(ST, 'stanza-songform.js'));
globalThis.StanzaSongForm = SF;
const FX = require(path.join(ST, 'stanza-sonnet-fx.js'));
globalThis.StanzaSonnetFx = FX;

const src = fs.readFileSync(path.join(ST, 'stanza-starborn.js'), 'utf8');
const sandbox = { window: {}, console, setTimeout };
sandbox.window.StanzaUtil = U;
sandbox.window.StanzaSongForm = SF;
// 按 UMD 的**实际导出名**装载（StanzaSonnetFx，小写 x）。此前这里手工注入过大写
// 别名 StanzaSonnetFX，把「星诞在真实浏览器里读到 undefined 引擎、音频证据全零」
// mask 成了全绿 —— 沙箱必须复刻浏览器的真实名字空间，而不是给被测代码开小灶。
sandbox.window.StanzaSonnetFx = FX;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const SB = sandbox.window.StanzaStarborn;
ok(!!SB, '星诞模块在带 window 的沙箱里能求值');
if (!SB) { console.error('\n无法加载星诞模块，后续断言跳过'); process.exit(1); }

// ---------------------------------------------------------------------------
section('候选与标签');
eq(SB.CANDIDATE_IDS.length, 4, '候选四个渲染器');
ok(SB.CANDIDATE_IDS.indexOf('starborn') < 0, '星诞不把自己列为候选（否则会自嵌套）');
['classic', 'cadenza', 'sonnet', 'tempera'].forEach(function (id) {
  ok(SB.LABELS[id] && SB.LABELS[id].length > 0, id + ' 有中文标签');
});

// ---------------------------------------------------------------------------
section('曲式层：段落切分按整首歌的间隙自适应');

// 每句 2.4s、句间 0.2s、段落间 2.4s 的歌；带逐字时间轴。
function mkLine(text, start, end, dense) {
  const chars = U.graphemes(text).filter(c => c.trim());
  const words = [];
  const step = (end - start) / Math.max(1, chars.length);
  for (let i = 0; i < chars.length; i++) {
    const a = start + i * step;
    words.push({ text: chars[i], start_ms: a, end_ms: Math.min(end, a + step * (dense ? 0.5 : (i === 0 ? 3 : 0.8))) });
  }
  return { text, start_ms: start, end_ms: end, words };
}
const VERSE_A = ['窗外的雨下了一整夜', '我把旧信又读了一遍', '你说过的话像远处的钟', '敲一下就又安静下来'];
const CHORUS_B = ['我要去很远的地方', '带着你没给的勇气', '哪怕路上没有星光', '也要唱完这支歌'];
const VERSE_C = ['走廊的灯坏了一半', '影子比人先走出门', '我还是会想起那个雨天', '想起你没说完的下半句'];
function mkSong(opts) {
  opts = opts || {};
  const lines = [];
  let t = opts.preRoll == null ? 4000 : opts.preRoll;
  const add = (block, gapAfterMs, dense) => block.forEach((text, i) => {
    lines.push(mkLine(text, t, t + 2400, dense));
    t += 2600 + (i === block.length - 1 ? gapAfterMs : 0);
  });
  add(VERSE_A, 2600, false);
  add(CHORUS_B, 3000, true);
  add(VERSE_C, 2600, false);
  if (opts.repeatChorus !== false) add(CHORUS_B, 8000, true);
  if (opts.tail !== false) lines.push({ text: '（尾奏）', start_ms: t + 9000, end_ms: t + 12000 });
  return lines;
}
const tokensOf = (l) => (l.words
  ? Object.assign(l.words.map(w => ({ text: w.text, start_ms: w.start_ms, end_ms: w.end_ms })), { wordLevel: true })
  : null);

const song = mkSong();
const form = SF.compile(song, tokensOf);
ok(form.paragraphs.length >= 4, '段落按间隙切出（实测 ' + form.paragraphs.length + ' 段）');
ok(form.threshold >= 1.25 && form.threshold <= 3.5, '间隙阈值钳在 1.25–3.5s（实测 ' + form.threshold.toFixed(2) + '）');
eq(form.chorusVisits, 2, '识别出两次副歌');
const chorusParas = form.paragraphs.filter(p => p.kind === 'chorus');
eq(chorusParas.length, 2, '两个副歌段落');
eq(chorusParas.map(p => p.visit).join(','), '1,2', '副歌按时间顺序数 visit（重复但升级的依据）');
ok(chorusParas[1].openness >= chorusParas[0].openness, '第二次副歌景别不低于第一次');
ok(form.paragraphs.some(p => p.kind === 'verse'), '主歌段落被识别为 verse');
ok(form.paragraphs[form.paragraphs.length - 1].kind === 'outro', '末段归为尾奏');
eq(form.paragraphs.filter(p => p.notesTrusted).length >= 3, true, '带真逐字时间轴时句内画像可信');
ok(form.gaps.length >= 1, '识别出器乐间隙（8s 空档）');
form.paragraphs.forEach(p => ok(p.lineCount <= 6 && p.duration <= 18.1,
  '段落 #'+p.index+' 不超标（'+p.lineCount+' 行 / '+p.duration.toFixed(1)+'s）'));

section('曲式层：副歌识别不许谎报');
// 没有任何重复的歌：绝不能出现 chorus 段落
const unique = ['第一句完全不同的内容', '第二句也一个字都不重样', '第三句继续往前走', '第四句还是没有回环', '第五句依旧独家'];
const noChorus = SF.compile(unique.map((s, i) => ({ text: s, start_ms: i * 4000, end_ms: i * 4000 + 2400 })), null);
eq(noChorus.chorusVisits, 0, '无重复歌词 → 不宣称有副歌');
eq(noChorus.paragraphs.filter(p => p.kind === 'chorus').length, 0, '无重复 → 没有 chorus 段落');
// 只重复一次（两句隔得远）：不到 3 次、也不构成连续两行的块 → 仍然不认
const twice = ['同一句台词', '别的词', '别的词2', '别的词3', '别的词4', '同一句台词'];
const weak = SF.compile(twice.map((s, i) => ({ text: s, start_ms: i * 5000, end_ms: i * 5000 + 3000 })), null);
eq(weak.chorusVisits, 0, '只重复一次的单句不算副歌（宁可漏判）');
// 标点/大小写差异不应影响判定（归一化）：连续两行各带不同标点地重复出现
const punct = ['我要去很远的地方', '带着你没给的勇气', '中间有一句别的', '还有一句别的',
  '再来一句别的', '我要去很远的地方！', '带着你没给的勇气。'];
const punctForm = SF.compile(punct.map((s, i) => ({ text: s, start_ms: i * 5000, end_ms: i * 5000 + 3000 })), null);
ok(punctForm.lines.filter(l => l.chorusStrength === 2).length >= 4,
  '标点不同的两行块重复仍然认得出（归一化生效，实测 ' + punctForm.lines.filter(l => l.chorusStrength === 2).length + ' 行）');
// 只有一句钩子反复唱：给弱档（strength 1），导演只据此小幅加分
const hook = ['别的路我都走过', '这句是随口哼的', '再来一句别的', '还有一句别的', '最后一句别的', '别的路我都走过', '换一句唱', '别的路我都走过'];
const hookForm = SF.compile(hook.map((s, i) => ({ text: s, start_ms: i * 5000, end_ms: i * 5000 + 3000 })), null);
ok(hookForm.lines.some(l => l.chorusStrength === 1), '单句钩子重复三次走弱档而不是冒充整块副歌');
ok(!hookForm.lines.some(l => l.chorusStrength === 2), '单句钩子不会被升级成整块副歌');
eq(hookForm.paragraphs.filter(p => p.kind === 'chorus').length, 0,
  '弱档钩子不产生「副歌段落」——段落标签一通胀，导演的副歌门就形同虚设');

section('曲式层：句内画像的诚实性');
// 没有逐字时间轴 → tokensOf 返回 null → 画像不可信，导演不许拿它投票
const noTokens = SF.compile(mkSong(), null);
ok(noTokens.paragraphs.every(p => !p.notesTrusted), '拿不到逐字时间轴时画像一律不可信');
ok(noTokens.lines.every(l => !l.profile.staccato), '不可信画像不会伪装成断奏');
// 单行歌词、空数组、脏 end_ms 都不能崩
[[], [{ text: '只有一句', start_ms: 0 }], [{ text: '', start_ms: 0, end_ms: null }]].forEach((doc, i) => {
  let threw = false;
  try { const f = SF.compile(doc, tokensOf); SF.sample(f, 5); } catch (e) { threw = true; }
  ok(!threw, '脏输入 #' + i + ' 不抛');
});

section('曲式层：读数只依赖时间（seek 可复现）');
const s1 = SF.sample(form, 21.37), s2 = SF.sample(form, 21.37);
eq(JSON.stringify(s1), JSON.stringify(s2), '同一时刻两次读数一致');
let maxStep = 0;
for (let t = 0.25; t < form.duration; t += 0.25) {
  maxStep = Math.max(maxStep, Math.abs(SF.sample(form, t).openness - SF.sample(form, t - 0.25).openness));
}
ok(maxStep <= 0.25, 'openness 每 0.25s 变化有界，不是阶跃（实测 ' + maxStep.toFixed(3) + '）');
ok(s1.paragraph && typeof s1.intensity === 'number', 'sample 同时给段落与力度');

section('镜头语法：每种模式一种走法，且句边归零');
const rec = form.lines[2];
eq(SF.cameraFor('classic', rec, rec.start + 1).active, true, '流光有镜头签名');
eq(SF.cameraFor('cadenza', rec, rec.start + 1).active, true, '心象有镜头签名');
eq(SF.cameraFor('sonnet', rec, rec.start + 1).active, false, '商籁交给自己的 Pixi 相机（否则两套镜头抢画面）');
eq(SF.cameraFor('tempera', rec, rec.start + 1).active, false, '凝彩同上');
const pathA = SF.CAMERA_PATHS.classic, pathB = SF.CAMERA_PATHS.cadenza;
ok(Math.sign(pathA.scale[1] - pathA.scale[0]) !== Math.sign(pathB.scale[1] - pathB.scale[0]),
  '流光推近而心象拉远：两种走法方向相反，切换才读作一记剪辑');
eq(JSON.stringify(SF.cameraFor('classic', rec, rec.start + 1.2)),
  JSON.stringify(SF.cameraFor('classic', rec, rec.start + 1.2)), '镜头读数可复现');
ok(SF.cameraFor('classic', rec, rec.start - 0.5).envelope === 0, '句首之前包络为 0');
ok(SF.cameraFor('classic', rec, rec.vocalEnd + 0.5).envelope === 0, '句尾之后包络为 0');
const xf = SF.cameraTransform(SF.cameraFor('classic', rec, rec.start + 1.2), 1, 1);
ok(/translate3d\(.+vw,.+vh, 0\) scale\(.+\) rotate\(.+\)/.test(xf), '合成出硬件加速的 transform：' + xf.slice(0, 40));
// 幅度上限：位移 ±12%、旋转 ±0.02rad（连续映射不许把镜头晃到人晕）
const extreme = SF.cameraTransform({ dx: 9, dy: 9, rot: 9, scale: 3, envelope: 1, active: true }, 1, 1);
ok(/translate3d\(([-\d.]+)vw/.exec(extreme)[1] <= 12 && /rotate\(([-\d.]+)rad/.exec(extreme)[1] <= 0.02,
  '越界镜头被钳住：' + extreme);
eq(SF.cameraTransform(SF.cameraFor('sonnet', rec, rec.start + 1), 1, 1), '', '中性镜头不产出 transform');

// ---------------------------------------------------------------------------
section('打分倾向：曲式证据真的进了分数');
const A = SB.scoreAll, S = SB.segmentStats;
const flat = { power: 0.15, bass: 0.15, lowMid: 0.2, mid: 0.2, vocal: 0.25, treble: 0.15 };
const heavy = { power: 0.92, bass: 0.9, lowMid: 0.6, mid: 0.4, vocal: 0.45, treble: 0.6 };
const zeroRand = () => 0;
// 用曲式行记录喂 segmentStats（它不再回查全局 Stage，所以能在 Node 里直接构造）
function statsOf(text, startMs, endMs, opts) {
  opts = opts || {};
  // 要真时间轴就用 mkLine 造 token，否则 compile 拿不到 words，画像永远不可信。
  const line = opts.realTokens ? mkLine(text, startMs, endMs, true)
    : { text, start_ms: startMs, end_ms: endMs };
  const next = { text: '下一句', start_ms: endMs + 400, end_ms: endMs + 2400 };
  const f = SF.compile([line, next], opts.realTokens ? tokensOf : null);
  const rec = f.lines[0];
  if (opts.kind) rec.kind = opts.kind;
  if (opts.chorus) { rec.isChorus = true; rec.chorusStrength = 2; }
  return S(rec, f.lines[1]);
}
const calmScore = A(statsOf('在这漫长的夜里我独自走过', 0, 4000), flat, zeroRand);
ok(calmScore.classic > calmScore.tempera, '低能量长句偏向流光而非凝彩');
const heavyScore = A(statsOf('快跑！', 0, 900, { chorus: true }), heavy, zeroRand);
ok(heavyScore.tempera > heavyScore.cadenza, '副歌 + 高能量低音重 → 凝彩压过心象');
const markScore = A(statsOf('你到底要我怎么说？！', 0, 2000), { power: 0.5, bass: 0.5, lowMid: 0.4, mid: 0.5, vocal: 0.6, treble: 0.4 }, zeroRand);
ok(markScore.cadenza > markScore.tempera, '强标点中能量偏向心象');
// 副歌证据必须真的加分：同一份文本，只改 isChorus
const withChorus = A(statsOf('我要去很远的地方', 0, 2400, { chorus: true }), heavy, zeroRand);
const withoutChorus = A(statsOf('我要去很远的地方', 0, 2400), heavy, zeroRand);
ok(withChorus.tempera > withoutChorus.tempera, 'isChorus 真值给凝彩加分（不是摆设）');
// 断奏只信真时间轴
const staccatoReal = A(statsOf('跑跑跑跑跑跑', 0, 1200, { realTokens: true }), flat, zeroRand);
ok(staccatoReal.tempera > staccatoReal.classic, '可信断奏偏向凝彩');
const fakeStats = statsOf('跑跑跑跑跑跑', 0, 1200);
ok(!fakeStats.staccato && fakeStats.notesTrusted === false, '拿不到逐字时间轴时不冒充断奏证据');
const staccatoFake = A(fakeStats, flat, zeroRand);
ok(staccatoReal.tempera - staccatoReal.classic > staccatoFake.tempera - staccatoFake.classic,
  '同一句文本，可信画像才把天平推向凝彩（不可信时这条线索干脆不参与）');
// 抖动上限 0.42：随机项独吞不了决策
const lowRand = A(statsOf('短', 0, 1000), flat, () => 0);
const hiRand = A(statsOf('短', 0, 1000), flat, () => 1);
const spread = Math.max(...Object.values(hiRand)) - Math.max(...Object.values(lowRand));
ok(spread <= 0.43, '随机抖动幅度不超过 0.42（实测 ' + spread.toFixed(3) + '）');
// 四种特征下最高分唯一（不打平，否则切镜结果依赖遍历顺序）
[['flat', flat], ['heavy', heavy]].forEach(([name, band]) => {
  const sc = A(statsOf('测试文本内容', 0, 2000), band, zeroRand);
  const vals = Object.values(sc), max = Math.max(...vals);
  eq(vals.filter(v => Math.abs(v - max) < 1e-9).length, 1, name + ' 特征下最高分唯一');
});

section('候选池硬门：副歌不耳语，留白不轰炸');
ok(SB.poolFor({ kind: 'chorus' }).indexOf('cadenza') < 0, '副歌池里没有心象（留白模式）');
ok(SB.poolFor({ kind: 'breath' }).indexOf('tempera') < 0, '呼吸段池里没有凝彩（色块轰炸）');
ok(SB.poolFor({ kind: 'chorus' }).length >= 2, '副歌池至少两个候选');
ok(SB.poolFor({ kind: 'breath' }).length >= 2, '呼吸段池至少两个候选');
eq(SB.poolFor({ kind: 'verse' }).length, 4, '主歌用全集');
eq(SB.poolFor({ kind: '不认识的类型' }).length, 4, '未知段落类型退回全集');
eq(SB.poolFor(null).length, 4, '没有曲式读数时不拦任何候选');

// ---------------------------------------------------------------------------
section('导演：段落级切镜时序');
// 可编程的 Stage 桩 + 真实曲式（导演内部会 forDoc 缓存同一份数组）
function makeStage(lines) {
  const st = { pos: 0, playing: true, lines, track: 'probe.mp3', reduced: false, spectrumValue: 0.4 };
  const api = {
    presentation: () => ({ track: { path: st.track }, playing: st.playing, reduced: st.reduced }),
    position: () => st.pos,
    lyrics: () => ({ lines: st.lines, index: 0 }),
    spectrum: () => new Array(64).fill(st.spectrumValue),
    energy: () => 0.4,
    lyricTokens: tokensOf
  };
  globalThis.Stage = sandbox.window.Stage = api;
  return st;
}
function mkDirector(lock, lines) {
  // 舞台桩必须先建好：全局 Stage 只有一个槽位，setVisual 要读它的当前位置记录切镜时刻。
  const st = makeStage(lines);
  const picks = [];
  let current = 'stage';
  const d = SB.init({
    getVisual: () => current,
    setVisual: (id) => { current = id; picks.push({ mode: id, at: st.pos / 1000, cinema: d.cinemaFrame() }); },
    onSwitch: (id, meta) => {
      const last = picks[picks.length - 1];
      if (last) { last.cold = meta.cold; last.count = meta.count; last.decision = meta.decision; }
    }
  });
  d.setTransitionLock(lock);
  d.setAvoidRepeat(true);
  return { d, picks, st };
}
// 全局 Stage 是单槽：创建与推进必须成对做完，否则后建的桩会把前一个导演喂到 pos=0。
function runDirector(lock, lines, fromMs, toMs, stepMs) {
  const run = mkDirector(lock, lines);
  const step = stepMs || 16.7;
  for (run.st.pos = fromMs; run.st.pos <= toMs; run.st.pos += step) run.d.frame();
  return run;
}
const formOfProbe = SF.forDoc(song, tokensOf);
const songMs = formOfProbe.duration * 1000;
const probe = runDirector(4, song, 0, songMs);
ok(probe.picks.length >= 3, '整首歌切了多段（实测 ' + probe.picks.length + ' 次）');
const midLineCuts = probe.picks.slice(1).filter(p => {
  const l = SF.lineAt(formOfProbe, p.at);
  return !(l && l.firstOfParagraph);
});
eq(midLineCuts.length, 0, '每次切镜都落在段落第一句（段内不二次下刀）');
const chorusCuts = probe.picks.filter(p => {
  const l = SF.lineAt(formOfProbe, p.at);
  const par = l && SF.paragraphAt(formOfProbe, l.index);
  return par && par.kind === 'chorus';
});
ok(chorusCuts.length >= 1, '副歌段落有切镜（实测 ' + chorusCuts.length + ' 次）');
chorusCuts.forEach(p => ok(p.mode !== 'cadenza', '副歌没有落到心象：' + p.mode));
eq(new Set(chorusCuts.map(p => p.mode)).size, 1, '两次副歌沿用同一个模式（重复但升级）：' + chorusCuts.map(p => p.mode).join(','));
// 每个段落最多决策一次
const perParagraph = {};
probe.picks.forEach(p => {
  const l = SF.lineAt(formOfProbe, p.at);
  if (!l) return;
  perParagraph[l.paragraph] = (perParagraph[l.paragraph] || 0) + 1;
});
ok(Object.values(perParagraph).every(n => n <= 1), '同一段落不被切两次：' + JSON.stringify(perParagraph));
// 切镜决策必须带得回的证据（复盘「为什么切到这」靠它，不靠猜）
ok(probe.picks.every(p => !p.decision || !p.decision.pool || p.decision.pool.length >= 2),
  '每次决策都记下当时候选池');

// 确定性：同一首歌重跑必须一模一样
const again = runDirector(4, song, 0, songMs);
eq(again.picks.map(p => p.at.toFixed(1)).join(','), probe.picks.map(p => p.at.toFixed(1)).join(','),
  '两次重跑的切镜时刻完全一致（演出可重现）');

// 暂停时不切
const paused = mkDirector(0, song);
paused.st.playing = false;
for (paused.st.pos = 0; paused.st.pos <= 40000; paused.st.pos += 16.7) paused.d.frame();
eq(paused.picks.length, 1, '暂停中只可能冷启动一次');

// 前奏（还没有可读歌词行）不许瞎挂一个模式
const pre = mkDirector(4, song);
let preCold = 0;
for (pre.st.pos = 0; pre.st.pos < 3900; pre.st.pos += 16.7) { pre.d.frame(); preCold = pre.picks.length; }
eq(preCold, 0, '第一句之前的冷启动不决策（画面本来就该空着）');

// 已经挂上模式之后，直接 seek 到句中不得再补切
const seekTest = runDirector(4, song, 0, 20000);
const beforeSeek = seekTest.picks.length;
ok(beforeSeek >= 1, 'seek 前已有一个在演的模式');
seekTest.st.pos = 21400;                                 // 直接落到副歌句中
seekTest.d.frame();
for (seekTest.st.pos = 21400; seekTest.st.pos <= 23200; seekTest.st.pos += 16.7) seekTest.d.frame();
eq(seekTest.picks.length, beforeSeek, '落在句中之后不补切（瞬态不污染确定性）');

// 倒退把冷却重置到当前时刻：此后 4s 内遇到的段首（本歌在 30.4s 处）必须被跳过
const back = runDirector(4, song, 0, 60000);
back.st.pos = 30000; back.d.frame();
const afterBack = back.picks.length;
for (back.st.pos = 30000; back.st.pos <= 34000; back.st.pos += 16.7) back.d.frame();
eq(back.picks.length, afterBack, '倒退后冷却期内不连切（段首被跳过而不是连环闪）');

// 换曲：抑制记录作废，重新冷启动
const switched = runDirector(4, song, 0, 60000);
const beforeTrack = switched.picks.length;
switched.st.track = 'second.mp3';
switched.st.lines = mkSong({ preRoll: 2000 });
switched.st.pos = 2000;
switched.d.frame();
ok(switched.picks.length > beforeTrack, '换曲后重新冷启动（不被上一首的 recent 压住）');
eq(switched.picks[switched.picks.length - 1].cold, true, '换曲后的第一次决策标记为冷启动');

// 冷却越长切得越少（两次都要各自建桩、各自跑完，全局 Stage 是单槽）
const loose = runDirector(0, song, 0, songMs);
const tight = runDirector(12, song, 0, songMs);
ok(tight.picks.length <= loose.picks.length,
  '冷却越长切得越少（' + tight.picks.length + ' vs ' + loose.picks.length + '）');

// reset 与 snapshot 契约
const snapDir = mkDirector(4, song);
snapDir.st.pos = 5000; snapDir.d.frame();
const snap = snapDir.d.snapshot();
ok(!('enabled' in snap), 'snapshot 不再有 enabled（开关只剩宿主那一个条件，见变异防护）');
ok('directedMode' in snap && 'transitionCount' in snap && 'lastDecision' in snap,
  'snapshot 含 directedMode/transitionCount/lastDecision');
ok(Array.isArray(snap.candidates) && snap.candidates.length === 4, 'snapshot 列出候选');
ok(snap.lastDecision && Array.isArray(snap.lastDecision.pool) && snap.lastDecision.pool.length >= 2,
  '决策记录带当时候选池（「为什么切到这」可复盘）');
eq(snap.lastDecision.picked, snap.directedMode, '决策记录的 picked 就是当前模式');
snapDir.d.reset();
eq(snapDir.d.snapshot().directedMode, null, 'reset 后回到未决策（切走星诞再切回来重新冷启动）');
snapDir.d.setTransitionLock(999);
eq(snapDir.d.snapshot().transitionLock, 30, '切镜间隔上限钳到 30s');
snapDir.d.setTransitionLock(-5);
eq(snapDir.d.snapshot().transitionLock, 0, '切镜间隔下限钳到 0s');
snapDir.d.destroy();
const afterDestroy = snapDir.picks.length;
snapDir.st.pos = 6000; snapDir.d.frame();
eq(snapDir.picks.length, afterDestroy, 'destroy 后 frame 不再决策');

section('星诞电影语言：统一调色、光影与播放时钟转场');
const filmVerse = SB.cinematicFrame({ openness: 0.4, intensity: 0.42 }, { vocal: 0.3 }, 5, null, false);
const filmChorus = SB.cinematicFrame({ openness: 1, intensity: 1 }, { vocal: 0.3 }, 5, null, false);
ok(filmChorus.shadow < filmVerse.shadow && filmChorus.light > filmVerse.light,
  '副歌打开黑位与定向光；主歌保持更深的冷影');
ok(filmChorus.warm > filmVerse.warm && filmChorus.cool < filmVerse.cool,
  '段落力度推动冷影暖光配比，避免每换渲染器就换一套滤镜');
const filmQuiet = SB.cinematicFrame({ openness: 0.4, intensity: 0.42 }, { vocal: 0 }, 5, null, false);
ok(filmVerse.light > filmQuiet.light && filmVerse.light - filmQuiet.light < 0.04,
  '人声只轻抬边缘光，不能推成全屏白闪');
ok(Object.keys(filmVerse).filter(k => typeof filmVerse[k] === 'number').every(k => Number.isFinite(filmVerse[k])),
  '全部电影层数值有限');
ok(JSON.stringify(filmVerse) === JSON.stringify(SB.cinematicFrame(
  { openness: 0.4, intensity: 0.42 }, { vocal: 0.3 }, 5, null, false)), '同一曲式/音频/时间的电影帧可重现');
const cutFilm = SB.transitionFor({ gapBefore: 2.8 }, 'chorus', 12, -1);
eq(cutFilm.kind, 'light-wipe', '副歌使用定向光擦');
eq(SB.transitionFor({ gapBefore: 1 }, 'breath', 12, 1).kind, 'dissolve', '留白段使用低照度叠化');
eq(SB.transitionFor({ gapBefore: 0 }, 'verse', 12, 1).kind, 'soft-cut', '主歌使用柔和剪切');
ok(cutFilm.durationMs <= 460 && cutFilm.durationMs >= 200,
  '转场仍在双实例交接的 200–460ms 预算内');
const filmAt = fraction => SB.cinematicFrame({ openness: 1, intensity: 1 }, {},
  cutFilm.start + cutFilm.durationMs * fraction / 1000, cutFilm, false);
eq(filmAt(-1).transition, 0, '切镜前没有光擦');
eq(filmAt(0).transition, 0, '光擦从精确零开始');
ok(filmAt(0.5).transition > 0.99, '光擦包络中点可见');
eq(filmAt(2).transition, 0, '交接结束精确归零，不残留合成光层');
ok(filmAt(0.25).transitionX > filmAt(0.75).transitionX, '种子负方向的光擦从右向左经过');
ok(filmAt(0.001).transition < 0.00001 && filmAt(0.999).transition < 0.00001,
  '转场两端平缓起落，没有阶跃亮度');
const staticFilm = SB.cinematicFrame({ openness: 1, intensity: 1 }, { vocal: 1, bass: 1 }, 12.2, cutFilm, true);
ok(staticFilm.transition === 0 && staticFilm.lightX === 0 && staticFilm.lightY === 0,
  '减弱动效撤销光擦与漂移，保留静态调色');

const filmRun = runDirector(4, song, 0, 17200, 20);
ok(filmRun.d.cinemaFrame().transition > 0.5, '真实导演在副歌换渲染器后输出可见的光擦');
const filmSwitch = filmRun.picks.find(p => !p.cold);
ok(filmSwitch && filmSwitch.cinema.transitionKind === 'light-wipe' && filmSwitch.cinema.transitionMs <= 460,
  'setVisual 回调执行前已发布本次转场意图，宿主交接无需延迟一帧读取');
const frozenFilm = JSON.stringify(filmRun.d.cinemaFrame());
filmRun.st.playing = false;
filmRun.st.spectrumValue = 1;
filmRun.st.pos = 17260;
filmRun.d.frame();
ok(JSON.stringify(filmRun.d.cinemaFrame()) === frozenFilm, '暂停冻结曝光、光位与进行中的转场');
filmRun.st.reduced = true;
filmRun.d.frame();
eq(filmRun.d.cinemaFrame().transition, 0, '暂停时启用减弱动效也立即撤掉转场');
filmRun.st.reduced = false;
filmRun.st.playing = true;
filmRun.st.pos = 5000;
filmRun.d.frame();
eq(filmRun.d.cinemaFrame().transition, 0, '倒退 seek 清除旧转场，不把旧光擦搬到新时刻');
filmRun.st.pos = 30200;
filmRun.d.frame();
eq(filmRun.d.cinemaFrame().transition, 0, '向前 seek 不制造电影切镜');
filmRun.st.track = 'film-next.mp3';
filmRun.st.pos = 4000;
filmRun.d.frame();
eq(filmRun.d.cinemaFrame().transition, 0, '换曲冷启动不继承上一首的光擦');
filmRun.d.reset();
eq(filmRun.d.cinemaFrame(), null, '切走星诞时释放电影帧状态');

// ---------------------------------------------------------------------------
section('接线：资源与宿主');
const mainRs = fs.readFileSync(path.join(ROOT, 'crates', 'hertz-studio', 'src', 'main.rs'), 'utf8');
const indexHtml = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const stage3d = fs.readFileSync(path.join(UI, 'stage3d.js'), 'utf8');
// 注释里要提这段历史（否则后来人不知道为什么不许再加开关），所以「不存在 autoDirector」
// 只能对代码断言，不能对整份文本断言。
const stage3dCode = stage3d.replace(/\/\/[^\n]*/g, '');
const css = fs.readFileSync(path.join(ST, 'stanza.css'), 'utf8');
const starbornCss = fs.readFileSync(path.join(ST, 'stanza-starborn.css'), 'utf8');
ok(/#stage3d\.s3d-starborn \.s3d-cinema \{ overflow: hidden; \}/.test(starbornCss),
  '星诞的光照 overscan 限制在电影层内部，不制造窄屏溢出');
ok(!/(?:^|[;{}\s])(?:filter|backdrop-filter|animation)\s*:/.test(starbornCss),
  '星诞使用低透明度光层，没有额外全屏滤镜或脱离播放时钟的 CSS 动画');
ok(/#stage3d\.s3d-starborn\.s3d-no-vignette \.s3d-starborn-grade::before \{ opacity: 0; \}/.test(starbornCss)
  && /classList\.toggle\('s3d-no-vignette', stanzaActive\(\) && !stanza\.vignette\)/.test(stage3d),
  '取消暗角同时撤掉星诞径向阴影，冷暖调色与定向光仍保留');
['shadow', 'cool', 'warm', 'light', 'light-x', 'light-y', 'transition', 'transition-x'].forEach(name => {
  ok(starbornCss.includes('var(--sb-' + name + ','), '星诞电影 CSS 消费 --sb-' + name);
});
ok(/href="stanza\/stanza-starborn\.css"/.test(indexHtml), '页面加载独立星诞电影层 CSS');
ok(/include_str!\("\.\.\/\.\.\/\.\.\/plugin\/ui\/stanza\/stanza-starborn\.css"\)/.test(mainRs)
  && /route\(\s*"\/stanza\/stanza-starborn\.css"/.test(mainRs), '星诞 CSS 同时有后端内嵌与资源路由');
['s3d-starborn-grade', 's3d-starborn-transition'].forEach(name => {
  ok(indexHtml.includes('class="' + name + '"') && starbornCss.includes('.' + name), '电影层节点与 CSS 同名：' + name);
});
const writeFilmBody = (stage3d.match(/function writeStarbornCinema\([\s\S]*?\n  \}/) || [''])[0];
ok(/stanza\.visual === 'starborn' && showLyrics/.test(writeFilmBody)
  && /classList\.toggle\('s3d-starborn', enabled\)/.test(writeFilmBody), '调色层仅在星诞且歌词可见时启用');
ok(/cinemaFrame\(\)/.test(writeFilmBody) && /if \(!film\)/.test(writeFilmBody),
  '宿主读取真实导演电影帧，并覆盖未冷启动/reset后的空帧');
const filmFields = { shadow: 'shadow', cool: 'cool', warm: 'warm', light: 'light', lightX: 'light-x',
  lightY: 'light-y', transition: 'transition', transitionX: 'transition-x' };
ok(Object.keys(filmFields).every(key => writeFilmBody.includes(key + ": '" + filmFields[key] + "'"))
  && writeFilmBody.includes("setProperty('--sb-' + fields[key]"), '全部导演光影字段都写入 CSS，不能只在模型里存在');
ok(/dataset\.sbTransition = film\.transitionKind/.test(writeFilmBody), '导演转场种类送到对应 CSS 选择器');
const cinemaBody = (stage3d.match(/function driveCinema\([\s\S]*?\n  \}/) || [''])[0];
ok(cinemaBody.indexOf('writeStarbornCinema()') >= 0
  && cinemaBody.indexOf('writeStarbornCinema()') < cinemaBody.indexOf('!playing'), '暂停分支前先写冻结的电影帧，不能重置曝光');
const handoffBody = (stage3d.match(/function handoffDuration\([\s\S]*?\n  \}/) || [''])[0];
ok(/cinemaFrame\(\)/.test(handoffBody) && /transitionMs/.test(handoffBody),
  '宿主双实例交接与导演光擦使用同一个时长');

ok(/include_str!\("\.\.\/\.\.\/\.\.\/plugin\/ui\/stanza\/stanza-songform\.js"\)/.test(mainRs),
  '后端 include_str! 内嵌曲式层脚本');
ok(/route\(\s*"\/stanza\/stanza-songform\.js"/.test(mainRs), '后端提供 /stanza/stanza-songform.js 路由');
ok(/include_str!\("\.\.\/\.\.\/\.\.\/plugin\/ui\/stanza\/stanza-starborn\.js"\)/.test(mainRs),
  '后端 include_str! 内嵌星诞脚本');
ok(/route\(\s*"\/stanza\/stanza-starborn\.js"/.test(mainRs), '后端提供 /stanza/stanza-starborn.js 路由');
ok(/<script[^>]*src="stanza\/stanza-songform\.js"><\/script>/.test(indexHtml), 'index.html 加载曲式层脚本');
ok(/<script[^>]*src="stanza\/stanza-starborn\.js"><\/script>/.test(indexHtml), 'index.html 加载星诞脚本');
// 依赖顺序：曲式层只用 StanzaUtil；星诞要读 StanzaSongForm 与引擎 StanzaSonnetFx。
ok(indexHtml.indexOf('stanza-util.js') < indexHtml.indexOf('stanza-songform.js'), '曲式层排在 util 之后');
ok(indexHtml.indexOf('stanza-songform.js') < indexHtml.indexOf('stanza-starborn.js'), '曲式层排在星诞之前');
ok(/StanzaSongForm must load before/.test(src), '星诞缺曲式层时直接抛（不许静默退化回流光）');

// 引擎全局名拼写：大写 StanzaSonnetFX 在浏览器里是 undefined（fx 的 UMD 导出是
// 小写 x），星诞的音频证据、stage3d 电影层的起音冲击都会静默归零。按剥注释后的
// 代码判，文档性提及不算。
const starbornCode = src.replace(/\/\/[^\n]*/g, '');
ok(starbornCode.indexOf('StanzaSonnetFX') < 0,
  '星诞引用的引擎全局名与实际导出一致（大写拼写在浏览器是 undefined）');
ok(starbornCode.indexOf('StanzaSonnetFx') >= 0, '星诞真的在引用引擎（不是干脆没引用）');
ok(stage3dCode.indexOf('StanzaSonnetFX') < 0,
  'stage3d 引用引擎全局名与实际导出一致（拼错=电影层冲击/色散恒 0）');

ok(/<option value="starborn">/.test(indexHtml), '歌词视觉下拉含星诞选项');
ok(/id="s3d-fl-starborn"/.test(indexHtml), '星诞设置面板存在');
ok(/id="s3d-fl-auto-lock"/.test(indexHtml), '切镜间隔滑杆存在');
ok(/id="s3d-fl-auto-avoid"/.test(indexHtml), '抑制重复开关存在');
ok(/id="s3d-cinema"/.test(indexHtml), '电影层锚点存在');
ok(/stanza\.autoLock/.test(stage3d) && /stanza\.autoAvoidRepeat/.test(stage3d), '导演参数参与状态与持久化');

// 关键接线：stanzaActive 必须把 starborn 算进去，否则导演一切镜画面就黑。
ok(/id === 'starborn' \|\| STANZA_VISUALS\.indexOf\(id\) >= 0/.test(stage3d),
  'stanzaActive() 把 starborn 视为激活态（否则切镜后宿主被收起）');
ok(/function effectiveVisual\(\)/.test(stage3d), 'effectiveVisual() 解析导演当前指向');
const planeBody = (stage3d.match(/function planeFor\([\s\S]*?\n  \}/) || [''])[0];
ok(/for \(var i = 0; i < RENDERER_IDS\.length/.test(planeBody), 'planeFor() 有回退链（渲染器缺失不至于双黑）');
const driveBody = (stage3d.match(/function driveStanza\([\s\S]*?\n  \}/) || [''])[0];
ok(driveBody.indexOf('director.frame()') < driveBody.indexOf('planeApi()'),
  '导演先决策再驱动渲染器（否则当帧驱动即将被隐藏的渲染器）');
ok(/var effForTheme = effectiveVisual\(\);/.test(stage3d), '主题签名走 effectiveVisual');

section('变异防护：导演只许有一个启用条件');
// 这一节钉的是「星诞从上线起就是死的」那个具体回归：一个初始化为 false 且永不赋值的
// autoDirector 布尔让 frame() 从未被调用，而当时契约脚本全绿。把这三件事都钉住。
ok(!/autoDirector/.test(stage3dCode), 'stage3d 代码里不存在 autoDirector（历史上它把导演钉死在兜底值）');
const condLine = (driveBody.match(/if \((stanza\.visual === 'starborn'[^\n]*)/) || [])[1] || '';
ok(condLine.length > 0, '驱动条件是 stanza.visual===starborn 本身');
ok(!/&&\s*stanza\.(?!director\b)/.test(condLine),
  '条件里不许再出现别的 stanza.* 开关（第二个需要外部置位的布尔就是这次的病根）');
const layoutBody = (stage3d.match(/function syncLayout\([\s\S]*?\n  \}/) || [''])[0];
ok(/stanza\.visual !== 'starborn' && stanza\.directorLive/.test(layoutBody)
  && /director\.reset\(\)/.test(layoutBody), '配置边界清导演状态，切回不再驱动 stanza 的 3D 轨也不会漏清');
// 兜底值本身也要看得见：directedMode 为 null 时画面停在哪，必须是有据可查的而不是巧合。
ok(/return \(snap && snap\.directedMode\) \|\| 'classic';/.test(stage3d),
  'effectiveVisual 的兜底是 classic（星诞未决策时等价流光 —— 界面文案必须如实说明）');

section('呈现层：交接淡出与电影层的两端一致性');
// 交接：宿主加类，CSS 必须有对应的类，否则「代码写了、画面没反应」。
ok(/function applyLayerVisibility\(/.test(stage3d), '可见性有唯一写入点 applyLayerVisibility');
ok(/fl-hand-out/.test(stage3d) && /fl-hand-out/.test(css), '离场淡出：JS 加的类在 CSS 里有定义');
ok(/fl-hand-in/.test(stage3d) && /\.fl-hand-in/.test(css), '进场淡入：两端都在');
ok(/--fl-hand-opacity/.test(stage3d) && /--fl-hand-opacity/.test(css), '交接透明度由宿主播放时钟写、CSS 读');
ok(/beginHandoff\(prev, nextId, handoffDuration\(\)\)/.test(stage3d) && /reducedMotion\(\)/.test(stage3d),
  '交接时长来自段落空气，且受 reduced motion 拦截');
ok(!/setTimeout/.test(stage3d.match(/function beginHandoff\([\s\S]*?\n  \}/)[0])
  && /driveHandoff\(\)/.test(driveBody),
  '交接由单帧循环收尾，暂停不被墙钟定时器提前隐藏');
['classic', 'cadenza', 'sonnet', 'tempera'].forEach(id => {
  const file = fs.readFileSync(path.join(ST, 'stanza-' + id + '.js'), 'utf8');
  ok(/rootEl: function/.test(file), id + ' 暴露 rootEl（交接按元素淡出，需要它）');
});
// 镜头机架：DOM 层走签名，Pixi 层必须中性；电影层三个变量必须两端都写读。
ok(/driveCameraRig\(\)/.test(driveBody), '帧循环驱动镜头机架');
ok(/cameraFor\(id, snap\.line, snap\.t\)/.test(stage3d), '机架按当前模式取签名');
['--s3d-bars', '--s3d-kick', '--s3d-grain-x', '--s3d-grain-y'].forEach(v => {
  ok(stage3d.includes("'" + v + "'"), 'JS 写 ' + v);
  ok(css.includes('var(' + v), 'CSS 读 ' + v);
});
ok(/is-live/.test(stage3d) && /\.s3d-cinema\.is-live/.test(css), '电影层显隐两端一致');
ok(/body\[data-rm~="lyrics"\] \.s3d-cinema \{ display: none; \}/.test(css),
  '弱化动效时电影层整体撤掉（与既有分面降级机制同源）');
ok(/createOnsetDetector\(\)/.test(stage3d), '起音检测器被宿主用起来（色散冲击的来源）');

section('副歌真值下传到渲染器');
const sonnetJs = fs.readFileSync(path.join(ST, 'stanza-sonnet.js'), 'utf8');
const temperaJs = fs.readFileSync(path.join(ST, 'stanza-tempera.js'), 'utf8');
const fxJs = fs.readFileSync(path.join(ST, 'stanza-sonnet-fx.js'), 'utf8');
ok(/isChorus: false/.test(sonnetJs) === false, '商籁不再把 isChorus 写死成 false');
ok(/section: section,/.test(sonnetJs), '行对象带上曲式段落');
ok(/FX\.shotKind\(seed, tuning, line && line\.section\)/.test(sonnetJs), '商籁镜头选择看见段落');
ok(/FX\.sceneKind\(seed, line && line\.section\)/.test(sonnetJs), '商籁背景构图看见段落');
ok(/compositionKind\(seed, tuning, line && line\.section\)/.test(temperaJs), '凝彩分镜看见段落');
ok(/FX\.shotKind\(seed, \{\}, line && line\.section\)/.test(temperaJs), '凝彩镜头看见段落');
ok(/SHOT_BY_SECTION/.test(fxJs) && /SCENE_BY_SECTION/.test(fxJs), 'FX 里有按段落的池子表');
ok(/COMPOSITION_BY_SECTION/.test(temperaJs), '凝彩有按段落的构图池子表');
// 池子真的被段落改变（不是查了不用）
const chorusShot = new Set();
for (let i = 0; i < 60; i++) chorusShot.add(FX.shotKind('probe:' + i, {}, { kind: 'chorus' }));
ok(!chorusShot.has('quiet-tableau'), '副歌 60 句里抽不到静像镜头');
const breathShot = new Set();
for (let i = 0; i < 60; i++) breathShot.add(FX.shotKind('probe:' + i, {}, { kind: 'breath' }));
ok(!breathShot.has('type-impact'), '呼吸段抽不到满屏冲击');
eq(FX.shotKind('probe:1', { shotFlow: 'quiet-tableau' }, { kind: 'chorus' }), 'quiet-tableau',
  '用户钉住镜头时优先于段落门');
const chorusPool = (temperaJs.match(/chorus: \[([^\]]*)\]/) || ['', ''])[1];
ok(chorusPool.indexOf('fan-burst') >= 0 && chorusPool.indexOf('split-duo') < 0,
  '凝彩副歌池走爆裂/四宫格，不含两刀分屏：' + chorusPool);

// 副歌升级的下半句（2026-10-07）：「景别与力度抬一档」此前只在 DOM 机架/遮幅
// 经 openness 生效，Pixi 两层（商籁/凝彩自带相机）完全看不见 visit —— 导演的承诺
// 对副歌的主力模式是空的。现在 chorusLift 用与曲式层同一个 bump 公式出口到相机。
ok(/function chorusLift/.test(fxJs) && /chorusLift: chorusLift/.test(fxJs), 'chorusLift 已导出');
ok(/Math\.min\(0\.16, \(visit - 1\) \* 0\.08\)/.test(fxJs),
  'bump 公式与曲式层同源（两处各写一个数迟早漂移）');
ok(/FX\.chorusLift\(frame && frame\.activeLine \? frame\.activeLine\.section : null\)/.test(sonnetJs),
  '商籁 cameraIntensity 消费副歌升级');
ok(/FX\.chorusLift\(frame && frame\.activeLine \? frame\.activeLine\.section : null\)/.test(temperaJs),
  '凝彩 cameraIntensity 消费副歌升级');
ok(FX.chorusLift({ kind: 'chorus', visit: 2 }) > FX.chorusLift({ kind: 'chorus', visit: 1 })
  && FX.chorusLift({ kind: 'chorus', visit: 3 }) > FX.chorusLift({ kind: 'chorus', visit: 2 }),
  '升级逐次递增且封顶（第二次 1.08 / 第三次 1.16）');
ok(FX.chorusLift({ kind: 'chorus', visit: 9 }) === FX.chorusLift({ kind: 'chorus', visit: 5 }),
  '封顶之后不再涨');

console.log('\n' + '-'.repeat(60));
console.log('星诞导演层契约检查：' + checks + ' 项，' + failures + ' 项失败');
process.exit(failures ? 1 : 0);
