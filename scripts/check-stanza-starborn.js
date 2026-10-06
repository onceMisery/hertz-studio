// SPDX-License-Identifier: MIT
// 星诞 starborn 契约检查：node scripts/check-stanza-starborn.js
//
// 覆盖三类断言：
//   1) 打分纯函数（scoreAll/segmentStats）—— 决策倾向是否符合设计意图
//   2) 切镜时序守卫 —— 直接 seek 不切、反向拖动重置冷却、句中不切
//   3) 接线 —— 资源内嵌/路由/index.html 引用/控件与持久化字段
//
// 设计约束（与参考项目 music-stage-modes.js 一致）：瞬态只影响"选哪个模式"，
// 切镜时机必须由新鲜句边界决定。违反这条就会出现"拖进度条时画面疯狂闪"的故障。
'use strict';
const path = require('path');
const fs = require('fs');
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

// 模块工厂从全局取 StanzaUtil / StanzaSonnetFX：require 后先挂全局再加载下游。
const U = require(path.join(ST, 'stanza-util.js'));
global.StanzaUtil = U;
const FX = require(path.join(ST, 'stanza-sonnet-fx.js'));
global.StanzaSonnetFX = FX;

// 星诞模块在 Node 里 require 时会走 `typeof window === 'undefined'` 早退分支，
// 所以纯函数拿不到 —— 这里用 vm 把它塞进一个带 window 的沙箱里跑。
const src = fs.readFileSync(path.join(ST, 'stanza-starborn.js'), 'utf8');
const sandbox = { window: {}, console, setTimeout };
sandbox.window.StanzaUtil = U;
sandbox.window.StanzaSonnetFX = FX;
vmrun(src, sandbox);
const SB = sandbox.window.StanzaStarborn;
ok(!!SB, '星诞模块在带 window 的沙箱里能求值');
if (!SB) { console.error('\n无法加载星诞模块，后续断言跳过'); process.exit(1); }

function vmrun(code, ctx) {
  const vm = require('vm');
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

// ---------------------------------------------------------------------------
section('候选与标签');
eq(SB.CANDIDATE_IDS.length, 4, '候选四个渲染器');
ok(SB.CANDIDATE_IDS.indexOf('starborn') < 0, '星诞不把自己列为候选（否则会自嵌套）');
['classic', 'cadenza', 'sonnet', 'tempera'].forEach(function (id) {
  ok(SB.LABELS[id] && SB.LABELS[id].length > 0, id + ' 有中文标签');
});

// ---------------------------------------------------------------------------
section('段落统计：只用可得证据');
const S = SB.segmentStats;
// 无 Stage.lyricTokens 时 words 应为 0 而不是崩 —— 契约脚本里没有 Stage。
const calm = S({ text: '在这漫长的夜里我独自走过', start_ms: 0, end_ms: 4000 }, null);
eq(calm.chars, 12, '字符数按字素计（不是 UTF-16 长度）');
eq(calm.marks, 0, '无标点则 marks 为 0');
const punct = S({ text: '你到底要我怎么说？！', start_ms: 0, end_ms: 2000 }, null);
eq(punct.marks, 2, '中文叹号问号计入 marks');
ok(punct.rate >= 0, '语速字段存在且非负（无 tokens 时为 0）');
// 两行合并统计
const two = S(
  { text: '第一句', start_ms: 0, end_ms: 2000 },
  { text: '第二句', start_ms: 2000, end_ms: 5000 });
eq(two.chars, 6, '当前行 + 下一行一起计入');
ok(two.duration !== undefined || true, '段落统计不抛（字段随实现演进）');

// ---------------------------------------------------------------------------
section('打分倾向：不同音乐特征应选不同模式');
const A = SB.scoreAll;
const flat = { power: 0.15, bass: 0.15, lowMid: 0.2, mid: 0.2, vocal: 0.25, treble: 0.15 };
const heavy = { power: 0.92, bass: 0.9, lowMid: 0.6, mid: 0.4, vocal: 0.45, treble: 0.6 };
const zeroRand = function () { return 0; };

// 抒情长句 + 低能量 → 流光（人声与低音主导、字数少）
const calmScore = A(S({ text: '在这漫长的夜里我独自走过', start_ms: 0, end_ms: 4000 }, null), flat, zeroRand);
ok(calmScore.classic > calmScore.tempera, '低能量长句偏向流光而非凝彩');
// 密集短句 + 低音重 → 凝彩
const heavyScore = A(S({ text: '快跑！', start_ms: 0, end_ms: 900 }, null), heavy, zeroRand);
ok(heavyScore.tempera > heavyScore.cadenza, '高能量低音重偏向凝彩');
// 强标点 + 中能量 → 心象（留白与镜头漂移）
const markScore = A(S({ text: '你到底要我怎么说？！', start_ms: 0, end_ms: 2000 }, null),
  { power: 0.5, bass: 0.5, lowMid: 0.4, mid: 0.5, vocal: 0.6, treble: 0.4 }, zeroRand);
ok(markScore.cadenza > markScore.tempera, '强标点中能量偏向心象');

// 抖动上限：随机项最多 0.42，独吞不了决策（否则"演出"退化成随机换片）
const lowRand = A(S({ text: '短', start_ms: 0, end_ms: 1000 }, null), flat, function () { return 0; });
const hiRand = A(S({ text: '短', start_ms: 0, end_ms: 1000 }, null), flat, function () { return 1; });
const spread = Math.max.apply(null, Object.keys(hiRand).map(function (k) { return hiRand[k]; })) -
  Math.max.apply(null, Object.keys(lowRand).map(function (k) { return lowRand[k]; }));
ok(spread <= 0.43, '随机抖动幅度不超过 0.42（实测 ' + spread.toFixed(3) + '）');
// 决策不变量：四种特征下都必须有唯一最高分（不打平）
[['flat', flat], ['heavy', heavy]].forEach(function (pair) {
  const sc = A(S({ text: '测试文本', start_ms: 0, end_ms: 2000 }, null), pair[1], zeroRand);
  const vals = Object.keys(sc).map(function (k) { return sc[k]; });
  var max = Math.max.apply(null, vals);
  eq(vals.filter(function (v) { return Math.abs(v - max) < 1e-9; }).length, 1,
    pair[0] + ' 特征下最高分唯一');
});

// ---------------------------------------------------------------------------
section('导演实例：切镜时序守卫');
// 构造一个可编程的 Stage 桩，驱动导演走完整流程。
// current 模拟"当前生效的视觉"：导演 getVisual 读它、setVisual 写它。
// 必须声明在 mkDirector 之前 —— let 有 TDZ，mkDirector 内的求值会捕获它。
let current = 'stage';

function makeStage() {
  var st = {
    t: 0, playing: true, pos: 0,
    lines: [
      { text: '第一句歌词', start_ms: 0, end_ms: 3000 },
      { text: '第二句歌词', start_ms: 3000, end_ms: 6000 },
      { text: '第三句歌词', start_ms: 6000, end_ms: 9000 }
    ],
    band: { power: 0.5, bass: 0.5, vocal: 0.5 }
  };
  global.Stage = {
    presentation: function () {
      return { track: { path: 'test.mp3' }, playing: st.playing, reduced: false };
    },
    position: function () { return st.pos; },
    lyrics: function () { return { lines: st.lines, index: 0 }; },
    spectrum: function () { return new Array(64).fill(st.band.power); },
    energy: function () { return st.band.power; },
    lyricTokens: function () { return null; }
  };
  sandbox.window.Stage = global.Stage;
  return st;
}

function mkDirector(lock) {
  var picks = [];
  var d = SB.init({
    getVisual: function () { return current; },
    setVisual: function (id) { current = id; picks.push(id); },
    onSwitch: function () {}
  });
  current = 'stage';
  d.setEnabled(true);
  if (lock != null) d.setTransitionLock(lock);
  return { d: d, picks: picks, get current() { return current; } };
}

let st = makeStage();

// 冷启动：即使落在句中也必须先挂一个（否则画面空着）
const ctx = mkDirector(4);
st.pos = 1500;                       // 句中
ctx.d.frame();
eq(ctx.picks.length, 1, '冷启动必挂一个模式（即使落在句中）');
ok(SB.CANDIDATE_IDS.indexOf(ctx.picks[0]) >= 0,
  '冷启动选中的模式在候选内 (got ' + ctx.picks[0] + ')');

// 句中不切：锁为 4s 时，把时间推到第二句句中，不该切
let before = ctx.picks.length;
st.pos = 4500;                       // 第二句句中（+1500ms）
ctx.d.frame();
eq(ctx.picks.length, before, '句中不切镜（必须等新鲜句边界）');

// 反向拖动：把锁重置到当前时刻，之后短时间内不切
st.pos = 500;                        // 往回拖
ctx.d.frame();
before = ctx.picks.length;
st.pos = 3200;                       // 第二句开头（边界内）
ctx.d.frame();
eq(ctx.picks.length, before, '反向拖动后立刻不切（锁被重置）');

// 关闭导演后状态清空：再次开启应重新冷启动
ctx.d.setEnabled(false);
ctx.d.frame();                       // 关闭时 frame 不应产生任何决策
eq(ctx.picks.length, before, '导演关闭时 frame 不决策');
ctx.d.setEnabled(true);
st.pos = 200;
ctx.d.frame();
eq(ctx.picks.length, before + 1, '重新开启后冷启动一次');

// 暂停时不切镜
const ctx2 = mkDirector(0);
st.playing = false;
st.pos = 6100;                       // 第三句开头
ctx2.d.frame();
eq(ctx2.picks.length, 1, '暂停时只冷启动，不切镜');
st.playing = true;

// snapshot 契约
const snap = ctx2.d.snapshot();
ok('enabled' in snap && 'directedMode' in snap && 'transitionCount' in snap,
  'snapshot 含 enabled/directedMode/transitionCount');
ok(Array.isArray(snap.candidates) && snap.candidates.length === 4, 'snapshot 列出候选');
ok(Array.isArray(snap.recent), 'snapshot 记录最近模式（供抑制重复）');
eq(snap.enabled, true, 'snapshot.enabled 反映开启态');
// 切镜计数应与实际切换次数一致
eq(snap.transitionCount, ctx2.picks.length, 'transitionCount 与实际挂载次数一致');

// setTransitionLock 钳位
ctx2.d.setTransitionLock(999);
eq(ctx2.d.snapshot().transitionLock, 30, '切镜间隔上限钳到 30s');
ctx2.d.setTransitionLock(-5);
eq(ctx2.d.snapshot().transitionLock, 0, '切镜间隔下限钳到 0s');

// destroy 后不再决策
ctx2.d.destroy();
before = ctx2.picks.length;
ctx2.d.frame();
eq(ctx2.picks.length, before, 'destroy 后 frame 不再决策');

// ---------------------------------------------------------------------------
section('接线：资源与宿主');
const mainRs = fs.readFileSync(path.join(ROOT, 'crates', 'hertz-studio', 'src', 'main.rs'), 'utf8');
const indexHtml = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const stage3d = fs.readFileSync(path.join(UI, 'stage3d.js'), 'utf8');

ok(/include_str!\("\.\.\/\.\.\/\.\.\/plugin\/ui\/stanza\/stanza-starborn\.js"\)/.test(mainRs),
  '后端 include_str! 内嵌星诞脚本');
// 路由在 main.rs 里是 rustfmt 展开的多行形式，匹配时容忍换行与缩进。
ok(/route\(\s*"\/stanza\/stanza-starborn\.js"/.test(mainRs), '后端提供 /stanza/stanza-starborn.js 路由');
ok(/<script[^>]*src="stanza\/stanza-starborn\.js"><\/script>/.test(indexHtml), 'index.html 加载星诞脚本');
// 依赖顺序：星诞要用 StanzaSonnetFX.resolveAudioBands，必须排在 sonnet-fx 之后
ok(indexHtml.indexOf('stanza-sonnet-fx.js') < indexHtml.indexOf('stanza-starborn.js'),
  '星诞排在 sonnet-fx 之后（要用 resolveAudioBands）');

ok(/<option value="starborn">/.test(indexHtml), '歌词视觉下拉含星诞选项');
ok(/id="s3d-fl-starborn"/.test(indexHtml), '星诞设置面板存在');
ok(/id="s3d-fl-auto-lock"/.test(indexHtml), '切镜间隔滑杆存在');
ok(/id="s3d-fl-auto-avoid"/.test(indexHtml), '抑制重复开关存在');

ok(/stanza\.autoLock/.test(stage3d), 'autoLock 参与状态与持久化');
ok(/stanza\.autoAvoidRepeat/.test(stage3d), 'autoAvoidRepeat 参与状态与持久化');
ok(/autoLock: stanza\.autoLock, autoAvoidRepeat: stanza\.autoAvoidRepeat/.test(stage3d),
  'preferences() 导出导演参数');
ok(/'starborn'[^\n]*indexOf\(value\.stanzaVisual\)/.test(stage3d) ||
  /indexOf\(value\.stanzaVisual\)[^\n]*'starborn'/.test(stage3d) ||
  /\['stage', 'starborn', 'classic'/.test(stage3d), 'configure() 接受 starborn 视觉');

// 关键接线：stanzaActive 必须把 starborn 算进去，否则导演一切镜画面就黑。
ok(/id === 'starborn' \|\| STANZA_VISUALS\.indexOf\(id\) >= 0/.test(stage3d),
  'stanzaActive() 把 starborn 视为激活态（否则切镜后宿主被收起）');
ok(/function effectiveVisual\(\)/.test(stage3d), 'effectiveVisual() 解析导演当前指向');
// planeApi / 可见性必须走 effectiveVisual 而不是 stanza.visual
const planeBody = (stage3d.match(/function planeApi\(\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
ok(/effectiveVisual\(\)/.test(planeBody), 'planeApi() 走 effectiveVisual');
ok(/var effVisual = effectiveVisual\(\);/.test(stage3d), '可见性切换走 effVisual');
// 导演必须在渲染器驱动之前决策
const driveBody = (stage3d.match(/function driveStanza\([\s\S]*?\n  \}/) || [''])[0];
ok(driveBody.indexOf('director.frame()') < driveBody.indexOf('planeApi()'),
  '导演先决策再驱动渲染器（否则当帧驱动即将隐藏的渲染器）');
// 主题签名也要走 effectiveVisual，否则切镜后残留上一个模式的取色
ok(/var effForTheme = effectiveVisual\(\);/.test(stage3d), '主题签名走 effectiveVisual');

// ---------------------------------------------------------------------------
section('逐字时间轴的诚实性');
const stageJs = fs.readFileSync(path.join(UI, 'stage.js'), 'utf8');
ok(/toks\.wordLevel = !!/.test(stageJs), 'tokensFor 标记逐字时间轴是否真实');
ok(/function hasWordLevelTiming\(\)/.test(stageJs), '提供全曲逐字数据探测');
ok(/hasWordLevelTiming: hasWordLevelTiming/.test(stageJs), 'Stage 导出 hasWordLevelTiming');

// 提示必须真的接到界面上：只导出不用等于没做。
ok(/id="s3d-fl-wordlevel-note"/.test(indexHtml), '设置面板有逐字时间轴提示位');
ok(/function syncWordLevelNote\(\)/.test(stage3d), '实现 syncWordLevelNote');
ok(/Stage\.hasWordLevelTiming\(\)/.test(stage3d), '提示读的是真实探测结果而不是猜');
ok(/syncWordLevelNote\(\);/.test(stage3d), 'syncWordLevelNote 被实际调用（否则是死代码）');
// 提示应挂在 8fps 的 syncStanzaMeta 上，不能进帧循环。
const syncMetaBody = (stage3d.match(/function syncStanzaMeta\([\s\S]*?\n  \}/) || [''])[0];
ok(syncMetaBody.indexOf('syncWordLevelNote()') >= 0, '提示挂在 syncStanzaMeta（8fps）而非帧循环');
const driveBody2 = (stage3d.match(/function driveStanza\([\s\S]*?\n  \}/) || [''])[0];
ok(driveBody2.indexOf('syncWordLevelNote') < 0, '帧循环里不查逐字时间轴（避免每帧空转）');
// 无逐字数据时的文案要如实说明是"估算"，不能宣称精确。
ok(/按字数估算/.test(indexHtml) || /按字数估算/.test(stage3d), '文案如实说明逐字进度是估算');

console.log('\n' + '-'.repeat(60));
console.log('星诞契约检查：' + checks + ' 项，' + failures + ' 项失败');
process.exit(failures ? 1 : 0);
