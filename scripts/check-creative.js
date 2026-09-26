#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 创意舞台的无头契约检查（零依赖）。
//
// 三维舞台跑在浏览器里，CI 上起不了 WebGL。但真正容易出错的地方并不是 GLSL，
// 而是**每帧的参数解析链**：基础值 → 音频绑定 → cue 动画 → 钳位，四步里任何
// 一步把值算成 undefined / NaN，画面就整块变黑，而浏览器不会报任何错。
// 所以这里只替换掉 GL 引擎（换成记录调用的假实现），把 DOM 补成最小可用的桩，
// 然后把整套解析链按帧跑几百次，逐帧断言喂给渲染器的每个数字都是有限值。
//
//   node scripts/check-creative.js
//
// 覆盖：预置归一化（含脏数据）、场景切换、参数钳位、绑定叠加、cue 触发与退化、
// 自动导演换段、导出/导入往返、降级路径。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'crates', 'vmusicd', 'web');
const ROOT = path.join(__dirname, '..');

let failures = 0;
let checks = 0;

function ok(cond, label) {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.error('  ✗ ' + label);
  }
}

function section(name) {
  console.log('\n' + name);
}

// ---------------------------------------------------------------------------
// 最小 DOM 桩
// ---------------------------------------------------------------------------

const cssVars = {
  '--music-highlight-rgb': '226, 176, 113',
  '--music-highlight-alt-rgb': '120, 170, 255'
};

function makeClassList(el) {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle: (c, on) => { if (on === undefined) { set.has(c) ? set.delete(c) : set.add(c); } else if (on) { set.add(c); } else { set.delete(c); } },
    contains: (c) => set.has(c),
    _set: set
  };
}

function makeEl(tag, size) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    className: '',
    children: [],
    parentNode: null,
    dataset: {},
    attributes: {},
    style: { setProperty() {}, getPropertyValue() { return ''; } },
    width: 0,
    height: 0,
    clientWidth: 0,
    clientHeight: 0,
    hidden: false,
    _size: size || { w: 420, h: 640 },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k]; },
    removeAttribute(k) { delete this.attributes[k]; },
    appendChild(c) { c.parentNode = this; this.children.push(c); if (!this.firstChild) this.firstChild = c; return c; },
    insertBefore(c, ref) {
      c.parentNode = this;
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i >= 0) this.children.splice(i, 0, c); else this.children.push(c);
      this.firstChild = this.children[0];
      return c;
    },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      this.firstChild = this.children[0] || null;
      c.parentNode = null;
      return c;
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    getBoundingClientRect() { return { left: 0, top: 0, width: this._size.w, height: this._size.h, right: this._size.w, bottom: this._size.h }; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    getContext() { return null; },
    toDataURL() { return 'data:image/jpeg;base64,AAAA'; },
    animate() { return { onfinish: null, cancel() {} }; },
    getAnimations() { return []; },
    cloneNode() { return makeEl(tag, this._size); },
    focus() {}
  };
  el.classList = makeClassList(el);
  el.firstChild = null;
  return el;
}

const knownEls = {
  stage: makeEl('aside', { w: 420, h: 640 }),
  'lyric-page': makeEl('div', { w: 1280, h: 720 })
};

const documentEl = makeEl('html');

const document = {
  documentElement: documentEl,
  body: makeEl('body'),
  createElement: (t) => makeEl(t),
  getElementById: (id) => knownEls[id] || null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return true; }
};
document.body.classList.add('is-playing');

let fakeNow = 1000;

const sandbox = {
  console,
  Math,
  Date,
  Set,
  Map,
  Array,
  Object,
  JSON,
  Number,
  String,
  Boolean,
  Float32Array,
  Uint8Array,
  Uint16Array,
  Int32Array,
  Promise,
  Error,
  isFinite,
  parseFloat,
  parseInt,
  setTimeout: (fn) => { return 0; },     // 不做延迟保存，避免测试里留下定时器
  clearTimeout() {},
  requestAnimationFrame: (fn) => { return 0; },
  // 时钟必须是可控的：整套解析链里有一堆按毫秒计的节流（导演 250ms 采样、
  // 起音不应期 220ms、cue 缓动……）。用真实 Date.now 的话，几百次同步 tick
  // 只过去几毫秒，导演永远不会触发 —— 测试会"通过"，但什么也没验到。
  performance: { now: () => fakeNow },
  devicePixelRatio: 2,
  getComputedStyle: () => ({ getPropertyValue: (n) => cssVars[n] || '' }),
  CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
  localStorage: (() => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      _map: m
    };
  })(),
  document,
  __listeners: []
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

// Stage 桩：帧门把 tick 收下来，由测试自己按帧调用。
const gates = {};
let stageVisible = true;   // E1：窄屏抽屉开关，默认可见（不影响既有测试）
sandbox.Stage = {
  tier: () => 2,
  isHidden: () => false,
  isPageOpen: () => pageOpen,
  isStageVisible: () => stageVisible,
  spectrum: () => spectrum,
  energy: () => 0.4,
  position: () => 12345,
  gate: (name, fpsFn, tickFn) => { gates[name] = { fpsFn, tickFn }; return true; }
};
let pageOpen = false;
let spectrum = null;

vm.createContext(sandbox);

function load(file) {
  const code = fs.readFileSync(path.join(WEB, file), 'utf8');
  vm.runInContext(code, sandbox, { filename: file });
}

// ---------------------------------------------------------------------------
// 假 GL 引擎：记录每次 render 的 state，并检查里面没有 NaN / undefined
// ---------------------------------------------------------------------------

const renderCalls = [];
const engines = [];
let fakeEngineCount = 0;
let nextRenderResult = null;      // 让 render() 在某一帧返回失败，用来测降级分支

function makeFakeEngine() {
  fakeEngineCount += 1;
  const eng = {
    resize(w, h, d) { this.lastResize = { w, h, d }; },
    render(state) {
      renderCalls.push(state);
      if (nextRenderResult) return nextRenderResult;
      return { ok: true, scene: state.scene };
    },
    capture() { return 'data:image/jpeg;base64,AAAA'; },
    warmUp() {},
    dispose() { this.disposed = true; },
    isLost: () => false,
    size: () => ({ w: 10, h: 10, dpr: 1, bw: 10, bh: 10 })
  };
  engines.push(eng);
  return eng;
}

// ---------------------------------------------------------------------------
// 开始
// ---------------------------------------------------------------------------

section('加载模块');
// onset.js 必须最先加载：creative-stage.js 在模块作用域就要拿到它，
// 否则后面每一次 attach 都会以"onset.js 未加载"降级，整套检查全废。
load('onset.js');
ok(!!sandbox.Onset && typeof sandbox.Onset.create === 'function',
  'onset.js 定义了 window.Onset.create');
ok(Array.isArray(sandbox.Onset.GROUPS) && sandbox.Onset.GROUPS.length === 4,
  'onset.js 导出 4 组分带');
load('creative-gl.js');
ok(!!sandbox.CreativeGL, 'creative-gl.js 定义了 window.CreativeGL');
ok(typeof sandbox.CreativeGL.isAvailable === 'function', 'CreativeGL.isAvailable 是函数');
ok(typeof sandbox.CreativeGL.create === 'function', 'CreativeGL.create 是函数');

const scenes = sandbox.CreativeGL.scenes();
ok(scenes.length >= 5, `场景数 >= 5（实际 ${scenes.length}）`);
['towers', 'orb', 'tunnel', 'nebula', 'terrain'].forEach((id) => {
  ok(!!sandbox.CreativeGL.sceneById(id), `场景 ${id} 已注册`);
});

// 换掉 GL 引擎：真正的 WebGL2 在 Node 里跑不了，但解析链与它无关。
let failNextShader = false;
sandbox.CreativeGL.isAvailable = () => true;
sandbox.CreativeGL.create = () => (failNextShader ? null : makeFakeEngine());

load('creative-stage.js');
ok(!!sandbox.CreativeStage, 'creative-stage.js 定义了 window.CreativeStage');

const CS = sandbox.CreativeStage;

section('预置归一化');
CS.init();
let p = CS.preset();
ok(p.scene === 'towers', '默认场景是 towers');
ok(typeof p.cam.dist === 'number' && p.cam.dist > 0, 'cam.dist 有数值');
ok(typeof p.look.bloom === 'number', 'look.bloom 有数值');
ok(Array.isArray(p.cues) && p.cues.length === 0, '默认没有 cue');
ok('grade' in p.look, '下拉项 look.grade 进入了预置');

// 脏数据：未知键、错类型、越界值、坏 cue
const dirty = CS.setPreset({
  name: '脏预置',
  scene: 'nebula',
  cam: { dist: 1e9, yaw: 30, 乱来的键: 5, fov: '不是数字' },
  look: { bloom: -4, grade: 3 },
  sc: { cloudR: 9, 不存在的键: 1 },
  cues: [{ at: 1, set: { 'look.bloom': 2 } }, { 坏: true }, null, 3],
  bindings: [{ target: 'sc.size', source: 'agg.3', gain: 0.5 }, { target: 1 }]
});
ok(dirty.scene === 'nebula', '场景切到 nebula 生效');
ok(dirty.cam.dist <= 44, '越界的 cam.dist 被钳回量程（' + dirty.cam.dist + '）');
ok(dirty.look.bloom >= 0, '负数 bloom 被钳回 0（' + dirty.look.bloom + '）');
ok(!('乱来的键' in dirty.cam), '未知键被丢弃');
ok(dirty.sc.cloudR === 9, '非默认值的场景参数被保留');
ok(!('不存在的键' in dirty.sc), '场景里的未知键被丢弃');
ok(dirty.cues.length === 1, `坏 cue 被过滤（剩 ${dirty.cues.length} 条）`);
ok(dirty.bindings.length === 1, `坏绑定被过滤（剩 ${dirty.bindings.length} 条）`);

section('挂载与帧门');
ok(gates.creative === undefined, 'attach 之前没有登记帧门');
const eff = CS.attach(true);
ok(eff === '3d', 'attach(true) 返回 3d（' + eff + '）');
ok(fakeEngineCount === 2, `舞台与全屏页各开一个引擎（实际 ${fakeEngineCount}）`);
ok(!!gates.creative, 'attach 之后登记了 creative 帧门');
// 挂上就要有一帧画面：暂停时帧门返回 0，而 stage.js 的主循环此刻可能已经停转，
// 不补这一帧的话用户拨开开关看到的是一块空白舞台。
ok(renderCalls.length === 2, `挂载时两块画布各补了一帧（${renderCalls.length}）`);
const callsAtAttach = renderCalls.length;

const stageEl = knownEls.stage;
ok(stageEl.children.length > 0 && stageEl.children[0].className === 'creative-canvas',
  '三维画布是舞台容器的第一个孩子（否则会盖住歌词）');
ok(stageEl.classList.contains('creative-on'), '舞台容器加上了 creative-on');

section('逐帧解析链');
function feed(bands) { spectrum = bands; }

// 三段式动态：安静前奏 → 副歌 → 间奏。自动导演要能从中看出起伏，
// 恒定响度的合成信号会让它一直停在 verse，等于没测。
function fakeSpectrum(t, amp) {
  const a = new Float32Array(64);
  for (let i = 0; i < 64; i += 1) {
    const v = amp * (0.55 + 0.45 * Math.sin(t * 0.6 + i * 0.31) * Math.sin(t * 0.17 + i));
    a[i] = Math.max(0, Math.min(1, v));
  }
  return a;
}

function ampAt(elapsed) {
  if (elapsed < 3000) return 0.10;       // 前奏
  if (elapsed < 11000) return 0.78;      // 副歌
  return 0.20;                           // 间奏
}

const tick = gates.creative.tickFn;
ok(typeof tick === 'function', '帧门拿到了 tick');

const FRAMES = 900;
let frames = 0;
let mutedFrames = 0;      // 代价探测的静默窗口：这些帧本来就不该画
let catchups = 0;         // 换挂载点时补的那一帧，一次 tick 会渲染两次
let sectionsSeen = {};
for (let f = 0; f < FRAMES; f += 1) {
  fakeNow += 16.7;
  feed(fakeSpectrum(f / 30, ampAt(fakeNow - 1000)));
  if (f % 120 === 0) { pageOpen = !pageOpen; catchups += 1; }   // 中途来回切挂载点
  tick(16.7);
  frames += 1;
  const st = CS.stats();
  if (st.probe.muted) mutedFrames += 1;
  sectionsSeen[st.section] = 1;
}
ok(frames === FRAMES, `${FRAMES} 帧全部跑完没有抛异常`);
// 渲染次数要逐帧对上账，而不是"大概够多"：静默窗口里一次都不许画，
// 非静默帧每帧恰好一次（外加换挂载点补的那帧）。这条等式同时钉住了
// A/B 的隔离性 —— 基线窗口里要是偷偷画了，等式就不成立。
ok(renderCalls.length - callsAtAttach === frames - mutedFrames + catchups,
  `渲染次数逐帧对账（${renderCalls.length - callsAtAttach} = ${frames} − ${mutedFrames} 静默 + ${catchups} 补帧）`);
ok(mutedFrames > 0 && mutedFrames < FRAMES / 4,
  `探测跑过一个静默窗口后自己收了（${mutedFrames} 帧没画）`);
ok(CS.stats().probe.rounds >= 1 && CS.stats().probe.loss === 0,
  `假引擎没有代价，探测结论是 0（rounds=${CS.stats().probe.rounds}）`);

// 关键断言：喂给渲染器的每个字段都必须是有限数。
let badField = null;
renderCalls.forEach((s, i) => {
  const flat = [];
  const walk = (v, p) => {
    if (typeof v === 'number') { if (!isFinite(v)) flat.push(p); return; }
    if (v && typeof v === 'object' && !(v instanceof Float32Array)) {
      Object.keys(v).forEach((k) => walk(v[k], p + '.' + k));
    }
  };
  walk(s.p, 'p');
  walk(s.cam, 'cam');
  walk(s.post, 'post');
  if (typeof s.pulse !== 'number' || !isFinite(s.pulse)) flat.push('pulse');
  if (typeof s.energy !== 'number' || !isFinite(s.energy)) flat.push('energy');
  if (Array.isArray(s.agg)) s.agg.forEach((v, j) => { if (!isFinite(v)) flat.push('agg.' + j); });
  if (!s.modelMatrix || s.modelMatrix.length !== 16) flat.push('modelMatrix');
  else for (let j = 0; j < 16; j += 1) if (!isFinite(s.modelMatrix[j])) flat.push('modelMatrix[' + j + ']');
  if (flat.length && !badField) badField = `第 ${i} 帧：` + flat.join(', ');
});
ok(!badField, '渲染参数里没有 NaN / 非有限值' + (badField ? ' → ' + badField : ''));

section('GL 视图可见性门控（E1）');
{
  pageOpen = false;
  const fpsGate = gates.creative.fpsFn;
  stageVisible = true;
  ok(fpsGate() > 0, '舞台可见且播放中：GL 请求帧');

  // 窄屏抽屉关着：门控必须报 0，且 tick 不渲染。
  stageVisible = false;
  ok(fpsGate() === 0, '抽屉关闭（画布不可见）：GL 目标帧率为 0，GPU 不空烧');
  const beforeHidden = renderCalls.length;
  tick(16.7);
  ok(renderCalls.length === beforeHidden, '不可见期间 tick 不触发任何渲染');

  // 全屏页打开时活动的是第二块画布，与抽屉无关。
  pageOpen = true;
  ok(fpsGate() > 0, '全屏沉浸页打开：不受抽屉状态影响，GL 照常请求帧');
  const beforePage = renderCalls.length;
  tick(16.7);   // pickView 切到页画布会补一帧，随后本帧再渲染一次
  ok(renderCalls.length > beforePage, '页打开时切挂载点补帧并渲染');

  pageOpen = false;
  stageVisible = true;
  tick(16.7);   // 复位活动视图，避免污染后续测试
}

section('自动导演');
const st = CS.stats();
ok(['quiet', 'verse', 'chorus'].includes(st.section), '段落判定落在三个已知取值内（' + st.section + '）');
ok(Object.keys(sectionsSeen).length >= 2,
  '动态变化被导演识别出来，至少切换过一次段落（见到 ' + Object.keys(sectionsSeen).join('/') + '）');
ok(renderCalls.some((s) => s.post.bloom > 1.0), '至少有一帧被导演推到了高能量影调');

section('参数写入与钳位');
CS.setScene('towers');
CS.setParam('cam.dist', 999);
ok(CS.preset().cam.dist === 44, 'setParam 越界被钳到 44（' + CS.preset().cam.dist + '）');
CS.setParam('sc.不存在的参数', 5);
ok(!('不存在的参数' in CS.preset().sc), 'setParam 拒绝未知路径');
CS.patch({ 'look.bloom': 5, 'sc.height': -10, '不存在的': 1 });
ok(CS.preset().look.bloom === 3, 'patch 越界被钳到 3（' + CS.preset().look.bloom + '）');
ok(CS.preset().sc.height === 0.5, 'patch 越界被钳到 0.5（' + CS.preset().sc.height + '）');
ok(!('不存在的' in CS.preset().sc), 'patch 忽略未知键');

section('编排轨');
const cues0 = CS.preset().cues.length;
ok(CS.addCue({ at: 12, len: 800, set: { 'look.bloom': 2.5 } }), '秒级 cue 可以加入');
ok(CS.addCue({ every: 4, len: 200, set: { 'look.chroma': 2 } }), '节拍 cue 可以加入');
ok(!CS.addCue({ 只有: '垃圾' }), '非法 cue 被拒绝');
ok(CS.preset().cues.length === cues0 + 2, `新加的两条 cue 都在（${cues0} → ${CS.preset().cues.length}）`);
CS.fire({ set: { 'cam.dist': 6 }, len: 300 });
ok(CS.runtime()['cam.dist'] !== undefined, '手动触发 cue 后 runtime 里有 cam.dist');
CS.removeCue(0);
ok(CS.preset().cues.length === cues0 + 1, '删除一条 cue 生效');
// 节拍 cue 必须真的被鼓点触发过，而不是躺在数据里。
CS.removeCue(0);
for (let f = 0; f < 240; f += 1) { fakeNow += 16.7; feed(fakeSpectrum(f / 30, 0.8)); tick(16.7); }
ok(CS.stats().beats > 0, '节拍检测有输出（' + CS.stats().beats + ' 次起音）');

section('绑定叠加');
// 绑定目标用场景私有参数，所以先把场景切回 nebula —— sc. 前缀指向"当前场景"，
// 在 towers 下绑 sc.cloudR 会找不到目标（这正是设计要的：场景私有参数不串味）。
CS.setScene('nebula');
CS.setBindings([
  { target: 'sc.cloudR', source: 'agg.0', gain: 3 },
  { target: 'look.exposure', source: '不存在', gain: 1 },      // 未知源应被忽略而不是崩
  { target: 'look.vignette', source: 'pulse', gain: 0.1 }
]);
ok(CS.preset().bindings.length === 3, '绑定写进去了');
for (let f = 0; f < 20; f += 1) { fakeNow += 16.7; feed(fakeSpectrum(f, 0.6)); tick(16.7); }
const r = CS.runtime();
ok(typeof r['sc.cloudR'] === 'number' && isFinite(r['sc.cloudR']),
  '绑定算出的值仍然有限（sc.cloudR = ' + r['sc.cloudR'] + '）');
ok(r['sc.cloudR'] > CS.preset().sc.cloudR, '低频绑定确实把参数推上去了');

section('导出 / 导入');
const json = CS.exportJSON();
ok(json.length > 100, '导出得到非空 JSON');
const round = CS.importJSON(json);
ok(round.ok === true, '往返导入成功：' + round.message);
ok(CS.importJSON('{ 这不是 json').ok === false, '坏 JSON 被拒绝而不是抛异常');
ok(CS.importJSON('[1,2,3]').ok === false, '错误形状的 JSON 被拒绝');

section('预置库');
const saved = CS.savePreset('冒烟预置');
ok(!!saved.id, '保存返回了 id');
ok(CS.library().length >= 1, '库里至少有一条');
ok(!!saved.thumb, '保存时抓到了缩略图');
ok(CS.loadPresetById(saved.id) !== null, '按 id 载入成功');
ok(CS.removePreset(saved.id) === true, '删除成功');
ok(CS.library().every((x) => x.id !== saved.id), '删除后库里不再有它');

section('起音检测唯一实现');
// K9 的守卫。两份"鼓点是哪一刻"的实现是文档 v1.0 里最贵的一处自相矛盾：
// 粒子层用自适应阈值，三维层用固定 0.055，两者根本不是同一个判据，
// 于是"切渲染模式节奏就变"恰恰发生在声称要避免它的那两个模块之间。
// 下面这组断言分三层：源码里不许再有第二份实现、检测器行为被钉死、
// 以及真实消费方与独立检测器在同一份 fixture 上给出完全相同的节拍。
{
  const src = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');
  // 本地实现的指纹：滑动窗口统计量、自己的不应期与脉冲衰减。
  const FINGERPRINTS = ['histSqr', 'ONSET_HISTORY', 'lastBeatAt', 'beats += 1',
    'score >', 'Math.exp(-dtMs / 170)'];
  ['stage-particles.js', 'creative-stage.js'].forEach((f) => {
    const code = src(f);
    ok(/Onset\.create\(/.test(code), `${f} 通过 Onset.create 取检测器`);
    ok(/Onset\.GROUPS/.test(code), `${f} 的分带取自 Onset.GROUPS`);
    FINGERPRINTS.forEach((fp) => {
      ok(code.indexOf(fp) < 0, `${f} 里不再残留本地起音实现（发现 "${fp}"）`);
    });
  });
}

{
  const G = sandbox.Onset.GROUPS;
  const kickSpec = (on) => {
    const a = new Float64Array(64);
    a.fill(0.04);
    if (on) for (let i = 0; i < 8; i += 1) a[i] = 0.9;
    return a;
  };
  const quietSpec = () => new Float64Array(64);

  // 每 10 帧一次底鼓，跑 60 帧 → 应当恰好一响一拍：不应期不吞拍、也不双触发。
  const runFixture = (frames, every, specOf) => {
    const d = sandbox.Onset.create({ groups: G, binCount: 64 });
    const times = [];
    d.onBeat((t) => times.push(t));
    for (let f = 0; f < frames; f += 1) {
      d.step(33, specOf(f % every === 0 && f >= every), f * 33);
    }
    return { d, times };
  };

  const loud = runFixture(60, 10, (k) => kickSpec(k));
  ok(loud.d.beats === 5, `5 次底鼓出 5 拍（实际 ${loud.d.beats}）`);
  ok(JSON.stringify(loud.times) === JSON.stringify([330, 660, 990, 1320, 1650]),
    '触发时刻逐一对应：' + JSON.stringify(loud.times));

  const again = runFixture(60, 10, (k) => kickSpec(k));
  ok(JSON.stringify(again.times) === JSON.stringify(loud.times),
    '同一份 fixture 重跑结果一致（检测器不依赖全局状态）');

  const hush = runFixture(60, 10, () => quietSpec());
  ok(hush.d.beats === 0, `静默不该出拍（实际 ${hush.d.beats}）`);

  // 自适应阈值的直接证据：响段把阈值抬到地板的几十倍，静段回落到地板附近。
  // 固定阈值（v1.0 三维层里的 0.055）不可能有这个行为。
  const floor = sandbox.Onset.DEFAULTS.floor;
  ok(loud.d.threshold > floor * 10,
    `响段阈值自适应抬升：${loud.d.threshold.toFixed(3)} > 地板 ${floor} 的 10 倍`);
  ok(hush.d.threshold < floor * 2,
    `静段阈值回落到地板附近：${hush.d.threshold.toFixed(4)}`);
}

// 接线断言：三维层确实在消费共享检测器，而不是自己算一份（那样 beats 会
// 永远不动）。这里刻意不拿它和独立检测器比"节拍数相等"——活着的这一份已经
// 带着上面几百帧的历史窗口，相等与否取决于测试的帧序，而不是契约本身。
{
  const kick = (on) => {
    const a = new Float64Array(64);
    a.fill(0.04);
    if (on) for (let i = 0; i < 8; i += 1) a[i] = 0.9;
    return a;
  };
  const before = CS.stats().beats;
  for (let f = 0; f < 60; f += 1) {
    fakeNow += 33;
    feed(kick(f % 10 === 0 && f >= 10));
    tick(33);
  }
  const delta = CS.stats().beats - before;
  ok(delta > 0, `三维层随共享检测器数到 ${delta} 拍`);
}

section('渲染代价探测');
// 决策表要三台"机器"：代价可接受的、降档能救回来的、降到最低档仍然该关掉的。
// 每台都得是没测过的全新实例（探测一次会话只跑一次），所以沿用降级路径那一节
// 的办法：重跑 IIFE 重建模块级状态。
//
// 怎么模拟机器：探测数的是"帧门实际拿到的 dt"，所以给定每个窗口的 dt 就等于
// 给定了这台机器的帧率。静默窗口 16.7ms（60fps 的空载），在画窗口按当前档位给
// —— 真实机器上降一档 DPR 就是少画像素、每帧更快，所以那张表是随档位递减的。
function freshStage() {
  knownEls.stage.children.length = 0;
  knownEls.stage.firstChild = null;
  knownEls['lyric-page'].children.length = 0;
  knownEls['lyric-page'].firstChild = null;
  sandbox.CreativeGL.isAvailable = () => true;
  sandbox.CreativeGL.create = () => makeFakeEngine();
  delete gates.creative;
  load('creative-stage.js');
  const inst = sandbox.CreativeStage;
  inst.init();
  const e0 = engines.length;
  const got = inst.attach(true);
  return { inst: inst, got: got, engines: engines.slice(e0) };
}

function pump(s, n, drawDtByStep) {
  const t = gates.creative.tickFn;
  for (let i = 0; i < n; i += 1) {
    const st = s.inst.stats();
    const dt = st.probe.muted ? 16.7 : (drawDtByStep ? drawDtByStep[st.probe.step] : 16.7);
    fakeNow += dt;
    feed(fakeSpectrum(i / 30, 0.5));
    t(dt);
  }
  return s.inst.stats();
}

function runProbe(s, drawDtByStep, maxFrames) {
  let n = 0;
  while (n < (maxFrames || 4000)) {
    const st = s.inst.stats();
    if (!st.probe.running && !st.probe.pending) break;
    pump(s, 1, drawDtByStep);
    n += 1;
  }
  const f = s.inst.stats();
  return { frames: n, probe: f.probe, active: f.active };
}

const p1 = freshStage();
ok(p1.got === '3d', '探测场景一：三维层已挂载');
const r1 = runProbe(p1, [18, 25, 40]);
ok(r1.probe.loss !== null && r1.probe.loss < 0.12,
  `轻机器：实测代价低于保留阈值（loss=${r1.probe.loss}）`);
ok(r1.probe.step === 0 && r1.probe.rounds === 1,
  `轻机器一测就收，不降任何档（step=${r1.probe.step}，rounds=${r1.probe.rounds}）`);
ok(r1.active === true, '轻机器：三维层留在原地');
ok(Math.abs(p1.engines[0].lastResize.d - 1.5 * 1.10) < 1e-6,
  `轻机器：渲染分辨率没有被动过（dpr=${p1.engines[0].lastResize.d}）`);
ok(p1.inst.stats().probe.running === false && p1.inst.stats().probe.pending === false,
  '轻机器：探测自己收尾了，不会一直占着满帧预算');

// 开关来回拨的那条路：不画了，但画布不能留在屏幕上。
p1.inst.attach(false);
ok(p1.engines.every((e) => !e.disposed),
  '关掉三维不销毁 GL 上下文（来回拨开关不该每次都重编五个场景）');
ok(knownEls.stage.children.filter((c) => c.className === 'creative-canvas')
  .every((c) => c.style.display === 'none'),
  '关掉三维把画布藏起来了（否则会留一张定格的最后一帧）');
ok(!documentEl.classList.contains('creative-3d'), '关掉三维撤掉了 creative-3d 抬层');
ok(p1.inst.attach(true) === '3d' && p1.inst.stats().probe.pending === false,
  '重新开启后画面回来了，且不会重测一次代价');

const p2 = freshStage();
const r2 = runProbe(p2, [60, 25, 18]);
ok(r2.probe.step === 2, `中档机器一路让到最低档（step=${r2.probe.step}）`);
ok(r2.probe.rounds === 3, `每让一档重测一次（rounds=${r2.probe.rounds}）`);
ok(r2.probe.loss !== null && r2.probe.loss < 0.12,
  `中档机器让档之后代价落回保留阈值内（loss=${r2.probe.loss}）`);
ok(r2.active === true && p2.inst.degradedBecause() === null,
  '中档机器：留住了这一层，只是画面分辨率低了');
const dpr2 = p2.engines.map((e) => e.lastResize.d);
ok(dpr2.every((d) => Math.abs(d - 1.5 * 1.10 * 0.6) < 1e-6),
  `两块画布都按最低档重设过后备缓冲（dpr=${dpr2.join(' / ')}）`);

const p3 = freshStage();
const r3 = runProbe(p3, [60, 55, 50]);
ok(r3.active === false, '重机器：降到最低档仍不可接受，这一层自己关掉了');
ok(/代价过高/.test(p3.inst.degradedBecause() || ''),
  '重机器给出的原因是人话：' + p3.inst.degradedBecause());
ok(knownEls.stage.children.every((c) => c.className !== 'creative-canvas'),
  '重机器：关掉时把画布摘干净了，不留一块定格的最后一帧');
ok(p3.engines.every((e) => e.disposed === true), '重机器：GL 上下文跟着释放');

// 用户在被探测劝退之后仍然点"开启"：这次不许再自作主张。
const beforeRetry = engines.length;
const gotRetry = p3.inst.attach(true, { force: true });
ok(gotRetry === '3d', '重机器：用户强制重试之后重新起来了');
ok(engines.length === beforeRetry + 2, `重试各开一块新画布（+${engines.length - beforeRetry}）`);
const afterRetry = pump(p3, 400, [60, 55, 50]);   // 无条件跑 400 帧重负载
ok(afterRetry.probe.skipped === true, '重机器：这次探测被跳过，不会再否定用户的决定');
ok(afterRetry.probe.running === false && afterRetry.probe.pending === false,
  '重机器：400 帧之后仍然没有重新起测');
ok(afterRetry.active === true, '重机器：强制开启之后画面留住了（没有被二次劝退）');
ok(afterRetry.probe.step === 0, '重机器：重试从满预算开始，而不是接着上次的降档');

// 运行中丢上下文（驱动重置 / 休眠回来）：引擎每次 render 都返回 context-lost，
// 这一层必须自己关掉并把画布摘掉，否则会留一张定格的最后一帧在舞台上。
const p4 = freshStage();
nextRenderResult = { ok: false, reason: 'context-lost' };
const drawsAtLoss = renderCalls.length;
let lostFrames = 0, lostMuted = 0;
while (p4.inst.stats().active && lostFrames < 300) {
  if (p4.inst.stats().probe.muted) lostMuted += 1;
  pump(p4, 1);
  lostFrames += 1;
}
ok(!p4.inst.stats().active,
  `第一次真的画就撞上丢上下文，这一层立刻自己关掉（跑了 ${lostFrames} 帧）`);
ok(renderCalls.length - drawsAtLoss === lostFrames - lostMuted,
  `静默的 ${lostMuted} 帧一次都没画，画掉的 ${renderCalls.length - drawsAtLoss} 帧就是触发降级的那一帧`);
ok(/上下文/.test(p4.inst.degradedBecause() || ''),
  '丢上下文的原因是可读的：' + p4.inst.degradedBecause());
ok(knownEls.stage.children.every((c) => c.className !== 'creative-canvas'),
  '丢上下文时画布被摘掉了（不会留一张定格画面）');
nextRenderResult = null;

section('GLSL 静态校验');
// 真正的 GLSL 编译只能在浏览器里做。但有一整类错误不必等到那时候才发现：
//
//   · 着色器里引用了一个从未声明的 uniform —— GL 只会给一句 "use of undeclared
//     identifier"，不带上下文；而这个错误在开发中极其容易犯（表里加了 uniform
//     名字、着色器里忘了写声明），本轮开发就踩过一次。
//   · decl 里声明了但 setup() 里从没设过值 —— 编译能过，但那个参数永远停在 0，
//     表现为"旋钮拖了没反应"，比编译失败更难查。
//   · 括号不配对、#version 不在第一行 —— 这两条 GL 会直接拒绝整个着色器。
//
// 所以这里对每个场景和每个后处理 pass 做一遍静态检查。识别符用的是正则，
// 宁可漏报也不误报：只检查以 u 开头、后接大写的标识符（本项目里所有 uniform
// 都遵守这个命名约定，局部变量一律小写开头）。
{
  const common = sandbox.CreativeGL.commonUniforms();
  ok(common.length >= 12, `COMMON 前导声明了 ${common.length} 个公共 uniform`);

  const autoCommon = ['uViewProj', 'uModel', 'uCamPos', 'uTime', 'uSeed', 'uSpec',
    'uAgg', 'uPulse', 'uEnergy', 'uPlay', 'uRes', 'uColorA', 'uColorB'];

  const declaredIn = (src) => {
    const out = new Set(common);
    // 顶点/片元属性与 varying 不算 uniform，但也不该出现在未声明检查里，
    // 所以把 in/out 声明一并收进来。
    const re = /(?:uniform\s+\w+\s+|(?:in|out)\s+\w+\s+)(\w+)\s*;/g;
    let m;
    while ((m = re.exec(src)) !== null) out.add(m[1]);
    return out;
  };

  const usedUniforms = (src) => {
    const out = new Set();
    const re = /\bu[A-Z][A-Za-z0-9_]*\b/g;
    let m;
    while ((m = re.exec(src)) !== null) out.add(m[0]);
    return out;
  };

  const balanced = (src) => {
    const count = (ch) => (src.split(ch).length - 1);
    return count('{') === count('}') && count('(') === count(')');
  };

  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');

  const scenes = sandbox.CreativeGL.scenes();
  scenes.forEach((s) => {
    const src = sandbox.CreativeGL.sceneSource(s.id);
    ok(src !== null, `能取到 ${s.id} 的着色器源码`);

    if (!src) return;

    const forVert = src.common + src.decl + src.geom + src.vert;
    const forFrag = src.common + src.decl + src.frag;
    ok(balanced(forVert), `${s.id} 顶点着色器括号配对`);
    ok(balanced(forFrag), `${s.id} 片元着色器括号配对`);

    // 场景声明集合 = COMMON ∪ decl ∪ 该阶段自己的 in/out
    const declaredV = declaredIn(src.common + src.decl + src.vert);
    const declaredF = declaredIn(src.common + src.decl + src.frag);
    autoCommon.forEach((n) => { declaredV.add(n); declaredF.add(n); });

    const missingV = [...usedUniforms(src.vert)].filter((n) => !declaredV.has(n));
    const missingF = [...usedUniforms(src.frag)].filter((n) => !declaredF.has(n));
    ok(missingV.length === 0,
      `${s.id} 顶点着色器没有未声明的 uniform` + (missingV.length ? ' → ' + missingV.join(', ') : ''));
    ok(missingF.length === 0,
      `${s.id} 片元着色器没有未声明的 uniform` + (missingF.length ? ' → ' + missingF.join(', ') : ''));

    // 声明了却没在 setup 里设：编译能过，但那个参数永远是 0。
    const scen = sandbox.CreativeGL.sceneById(s.id);
    const setupSrc = scen.setup ? scen.setup.toString() : '';
    const rows = (scen.uniforms || []).filter((n) => {
      const declaredSomewhere = (src.decl + src.vert + src.frag).includes(n);
      if (!declaredSomewhere) return false;           // 只在 decl 里出现的才算"场景私有"
      return !setupSrc.includes(n);
    });
    ok(rows.length === 0,
      `${s.id} 的每个自定义 uniform 都在 setup() 里被赋值` + (rows.length ? ' → 未赋值：' + rows.join(', ') : ''));

    // 反方向也要查一遍：setup 设了值、表里登记了，但着色器源码里一次都没
    // 引用 —— 编译和上面那项检查都不会发现它，表现为"旋钮拖了没反应"。
    // 本轮优化就抓到 tunnel 的 uPush 是这么个死参数。
    const dead = (scen.uniforms || []).filter((n) => !(src.vert + src.frag).includes(n));
    ok(dead.length === 0,
      `${s.id} 没有"设了值但着色器不用"的死参数` + (dead.length ? ' → ' + dead.join(', ') : ''));
  });

  const post = sandbox.CreativeGL.postSource();
  Object.keys(post).forEach((k) => {
    ok(balanced(post[k]), `后处理 ${k} 括号配对`);
    ok(/^#version 300 es/.test(post[k]), `后处理 ${k} 的 #version 在首行`);

    // 后处理这 4 个 program 是自包含的（自带 #version 与 precision），
    // 所以"用了没声明的 uniform"这一类检查同样做得动。2026-09-19 那个
    // "复合 pass 引用了 uBloom2 / uBloom2K 却没声明"就是死在这里 ——
    // 每一次 render 都抛异常，而三维舞台看起来只是"没生效"。
    const declared = new Set();
    let mm;
    const dre = /uniform\s+\w+\s+(\w+)\s*(?:\[\s*\d+\s*)?\s*;/g;
    while ((mm = dre.exec(stripComments(post[k]))) !== null) declared.add(mm[1]);
    const usedP = new Set();
    const ure = /\bu[A-Z][A-Za-z0-9_]*\b/g;
    while ((mm = ure.exec(stripComments(post[k]))) !== null) usedP.add(mm[0]);
    const missingP = [...usedP].filter((n) => !declared.has(n));
    ok(missingP.length === 0,
      `后处理 ${k} 没有未声明的 uniform` + (missingP.length ? ' → ' + missingP.join(', ') : ''));
  });

  // 两类"GL 直接拒绝整段着色器"的写法，静态就能查。这两条都是 2026-09-19 在
  // 真实浏览器里抓到的（无头检查当时全绿，画面却整块没了）：
  //   · GLSL ES 3.00 把 half 列成保留字，`float half = ...` 声明即语法错；
  //   · 不带花括号的 if 后面跟了第二条语句，下一行的 else 就找不到配对的 if。
  // 两处都在 GEOM / 公共前导里 —— 一处坏了不是"这个场景没了"，是"五个场景全没了"。
  const RESERVED = ['asm', 'class', 'union', 'enum', 'typedef', 'template', 'this',
    'packed', 'goto', 'switch', 'default', 'inline', 'noinline', 'volatile', 'public',
    'static', 'extern', 'external', 'interface', 'long', 'short', 'double', 'half',
    'fixed', 'unsigned', 'input', 'output', 'superp', 'patch', 'sample', 'filter',
    'active', 'resource', 'subroutine', 'cast', 'namespace', 'usage', 'row_major',
    'column_major', 'partition', 'gather', 'joint', 'signal', 'direction',
    'hvec2', 'hvec3', 'hvec4', 'dvec2', 'dvec3', 'dvec4', 'fvec2', 'fvec3', 'fvec4',
    'sampler1D', 'sampler3D', 'sampler1DShadow', 'sampler2DRect'];

  // 参数列表里的 out/in 不是 varying（`vec3 gridCell(int v, int n, out vec2 cellXZ, …)`），
  // 把括号里的内容抹平成 () 之后再找声明。
  const stripParens = (s) => {
    let prev;
    do { prev = s; s = s.replace(/\([^()]*\)/g, '()'); } while (s !== prev);
    return s;
  };
  const decls = (src, kw) => {
    const out = new Set();
    const re = new RegExp('\\b' + kw + '\\s+\\w+\\s+(\\w+)\\s*;', 'g');
    let m;
    while ((m = re.exec(stripParens(stripComments(src)))) !== null) out.add(m[1]);
    return out;
  };

  // 片元里的每一个 in，顶点必须有同名 out。对不上时 GL 在 link 阶段就拒绝
  // （"FRAGMENT varying vZ does not match any VERTEX varying"），而 warmUp() 为了
  // "单个场景坏掉不影响其它"把异常咽了 —— 症状于是推迟成"第一次切进这个场景，
  // 整个三维层降级"。本轮真的踩到一次（terrain 的 vZ）。
  scenes.forEach((s) => {
    const src = sandbox.CreativeGL.sceneSource(s.id);
    if (!src) return;
    const outs = decls(src.vert, 'out');
    const orphans = [...decls(src.frag, 'in')].filter((n) => !outs.has(n));
    ok(orphans.length === 0, `${s.id} 的片元 in 在顶点里都有对应的 out`
      + (orphans.length ? ' → 缺：' + orphans.join(', ') : ''));
  });

  function hazards(label, source) {
    const code = stripComments(source);
    const bad = [];
    RESERVED.forEach((w) => {
      if (new RegExp('\\b' + w + '\\b').test(code)) bad.push('用了保留字 ' + w);
    });
    code.split('\n').forEach((line, i) => {
      if (/^\s*(else\s+)?if\s*\([^)]*\)\s*[^{\s][^;]*;[^;]*;/.test(line)) {
        bad.push(`第 ${i + 1} 行裸 if 里跟了两条语句`);
      }
    });
    ok(bad.length === 0, `${label} 没有保留字 / 裸 if 多语句`
      + (bad.length ? ' → ' + bad.slice(0, 3).join('；') : ''));
  }

  scenes.forEach((s) => {
    const src = sandbox.CreativeGL.sceneSource(s.id);
    if (!src) return;
    // 注意不叠加 src.geom：每个场景的 vert 本身就是 `GEOM + …` 拼出来的，
    // 再前置一份只是把同一段扫两遍。
    hazards(`${s.id} 顶点`, src.common + src.decl + src.vert);
    hazards(`${s.id} 片元`, src.common + src.decl + src.frag);
  });
  Object.keys(post).forEach((k) => hazards(`后处理 ${k}`, post[k]));
  scenes.forEach((s) => {
    const src = sandbox.CreativeGL.sceneSource(s.id);
    if (!src) return;
    // 顶点/片元的 #version 由 sceneProgram 在拼接时补在最前面，
    // 所以这里检查"源码本身没有把 #version 写在中间"。
    ok(!/#version/.test(src.vert) && !/#version/.test(src.frag),
      `${s.id} 的着色器源码里没有重复的 #version 指令`);
  });
}

section('三维歌词：图集去重契约');
// 2026-09-20 真机抓到的跨视图陈旧 bug：舞台与全屏页各持一个 GL 引擎、一张
// lyricTex，却共享同一张 Lyric3D 图集。停渲视图的纹理不再更新；它重新激活时
// 若全局签名恰好相同，旧的"全局去重"返回 false，纹理便停在旧内容（实测：
// 舞台先渲过无歌词占位，全屏页推进到 index6 后返回舞台，画面仍是音符）。
{
  const src = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');
  const glsrc = src('creative-gl.js');
  ok(/var lyricSig = null;/.test(glsrc),
    'creative-gl 为歌词纹理声明了引擎本地签名 lyricSig');
  ok(/window\.Lyric3D\.sig\(S\.lyric\)/.test(glsrc),
    'uploadLyric 用 Lyric3D.sig 计算本引擎需要的内容签名');
  ok(/Lyric3D\.frame\(S\.lyric, true\)/.test(glsrc),
    '签名变化时以 force=true 重画图集（图集可能装着另一视图的歌词）');

  // 视图切换补帧接线：暂停时空帧门不会自己跑，全屏页开/关必须显式补一帧。
  const cssrc = src('creative-stage.js');
  ok(/kick:\s*kickStaticFrame/.test(cssrc),
    'CreativeStage 导出 kick（视图切换补帧）');
  const stsrc = src('stage.js');
  ok(/CreativeStage\.kick\(\)/.test(stsrc),
    'stage.js setPage 切换时调用 CreativeStage.kick()');

  // 在独立沙箱里加载 lyric3d.js：桩 2D 上下文只记录 fillText 的文字。
  const fillLog = [];
  const ctx2d = {
    font: '', textAlign: '', textBaseline: '', shadowColor: '', shadowBlur: 0, fillStyle: '',
    measureText: () => ({ width: 200 }),
    fillText: (txt) => fillLog.push(txt),
    clearRect: () => {}
  };
  const fakeCanvas = { width: 0, height: 0, getContext: () => ctx2d };
  const box = {
    console, Math, Array, Object, String, Number, JSON, Error, isFinite
  };
  box.document = { createElement: () => fakeCanvas };
  box.window = box;
  vm.createContext(box);
  vm.runInContext(src('lyric3d.js'), box, { filename: 'lyric3d.js' });
  const L = box.window.Lyric3D;
  ok(!!L && typeof L.frame === 'function' && typeof L.sig === 'function',
    'Lyric3D 导出 frame / sig');

  const lines = [];
  for (let i = 0; i < 9; i += 1) lines.push({ start_ms: i * 1000, text: '句' + i });
  const snap = (i) => ({ lines: lines, index: i });

  ok(L.frame(snap(6)) === true, '首帧重画');
  ok(L.frame(snap(6)) === false, '相同签名跳过重画');
  ok(L.frame(snap(6), true) === true, 'force=true 强制重画');
  ok(L.sig(snap(6)) === L.sig(snap(6)), 'sig 对同一快照确定');
  ok(L.sig(snap(6)) !== L.sig(snap(7)), 'sig 随 index 变化');
  ok(L.sig(null) !== L.sig(snap(0)), 'null 与有歌词签名不同');

  // 引擎本地签名 + force 的上传策略。
  function step(eng, lyric) {
    const need = L.sig(lyric);
    if (need === eng.sig) return false;
    eng.sig = need;
    return L.frame(lyric, true);
  }
  // 真机序列：A=舞台先渲 null（其纹理=音符占位）；B=全屏页推进 0..6。
  const A = { sig: null };
  ok(step(A, null) === true, '舞台首帧（无歌词）上传');
  const B = { sig: null };
  for (let i = 0; i <= 6; i += 1) step(B, snap(i));
  // 舞台重新激活、需要 index6：本地签名仍是 null，必须补传。
  ok(step(A, snap(6)) === true,
    '舞台重新激活时补传纹理（修复跨视图陈旧）');
  ok(fillLog.indexOf('句6') >= 0 && fillLog[fillLog.length - 1] === '句8',
    '重画序列里含当前行"句6"（末位是更未来的"句8"，符合绘制顺序）');
  // 同帧若误用不带本地签名的全局去重，会得到 false —— 钉死这个危险点。
  ok(L.frame(snap(6)) === false,
    '此刻全局去重确实会说"无变化"：证明只能靠引擎本地签名');
}

section('降级路径');
// 重新执行一遍 creative-stage.js：IIFE 会重建全部模块级状态，于是在同一个
// 上下文里就能拿到一个"还没 attach 过"的新实例。这次让 create 返回 null，
// 断言它走进降级分支、给出可读的原因，而且不登记帧门（不该再空转）。
// 先把上一次成功挂载留下的画布清掉，否则"有没有残留画布"这一条断言测不准。
knownEls.stage.children.length = 0;
knownEls.stage.firstChild = null;
knownEls['lyric-page'].children.length = 0;
knownEls['lyric-page'].firstChild = null;

sandbox.CreativeGL.create = () => null;
sandbox.CreativeGL.isAvailable = () => true;
delete gates.creative;
load('creative-stage.js');
const CS3 = sandbox.CreativeStage;
CS3.init();
const eff3 = CS3.attach(true);
ok(eff3 === 'off', '拿不到 GL 上下文时返回 off（' + eff3 + '）');
ok(!!CS3.degradedBecause(), '给出了降级原因：' + CS3.degradedBecause());
ok(gates.creative === undefined, '降级后没有登记帧门');
ok(knownEls.stage.children.every((c) => c.className !== 'creative-canvas'),
  '降级时把画布从 DOM 里摘掉了（否则会留一块永久黑屏）');

// 设备完全不支持 WebGL2 的那条分支
sandbox.CreativeGL.isAvailable = () => false;
load('creative-stage.js');
const CS4 = sandbox.CreativeStage;
CS4.init();
ok(CS4.attach(true) === 'off', '不支持 WebGL2 时返回 off');
ok(/WebGL2/.test(CS4.degradedBecause() || ''), '原因是"不支持 WebGL2"：' + CS4.degradedBecause());

section('运行时降级的生效真相');
{
  const csSrc = fs.readFileSync(path.join(WEB, 'creative-stage.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  // 事件必须能区分两类降级：attach 启动期失败（applyCreative 自己接手）
  // vs 运行中被摘掉（需要事件监听者补做 UI 与服务端真相）。
  ok(/function degrade\(reason,\s*byProbe,\s*runtime\)/.test(csSrc),
    'degrade 签名带 runtime 标记');
  ok(/detail:\s*\{\s*reason:\s*reason,\s*runtime:\s*!!runtime\s*\}/.test(csSrc),
    'creative:degrade 事件 detail 携带 runtime');
  // 三处运行中调用点（上下文丢失、着色器失败、探测判定代价过高）必须显式标 true。
  // 不能用 [^)]* 一路匹配：着色器那行参数里有 (r.message||'').split 的右括号。
  const c1 = (csSrc.match(/,\s*false,\s*true\)/g) || []).length;
  const c2 = (csSrc.match(/,\s*true,\s*true\)/g) || []).length;
  ok(c1 >= 2 && c2 >= 1,
    '运行中降级三处调用点都带 runtime（false,true x' + c1 + '；true,true x' + c2 + '）');
  // app.js 必须监听、按 runtime 过滤，并把"生效真相"回报服务端。
  ok(/addEventListener\('creative:degrade',\s*onCreativeRuntimeDegrade\)/.test(appSrc),
    'app.js 注册 creative:degrade 监听者');
  ok(/function onCreativeRuntimeDegrade[\s\S]{0,200}?if \(!d\.runtime\) return/.test(appSrc),
    '处理器忽略启动期事件（runtime=false），不与 applyCreative 重复');
  ok(/creative_stage:\s*false,[\s\S]{0,120}?creative_stage_effective:\s*'standard'/.test(appSrc),
    '运行时降级回报：creative_stage=false + effective=standard');
}

section('歌单体验：封面共享与详情契约');
{
  const shelfSrc = fs.readFileSync(path.join(WEB, 'shelf.js'), 'utf8');
  const appSrc2 = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  const routesSrc = fs.readFileSync(
    path.join(ROOT, 'crates', 'vmusicd', 'src', 'routes.rs'), 'utf8');
  const plsRs = fs.readFileSync(path.join(ROOT, 'crates', 'vmusic-store', 'src', 'playlists.rs'), 'utf8');
  const libmetaSrc = fs.readFileSync(
    path.join(ROOT, 'crates', 'vmusic-library', 'src', 'lib.rs'), 'utf8');
  const storeSrc2 = fs.readFileSync(
    path.join(ROOT, 'crates', 'vmusic-store', 'src', 'lib.rs'), 'utf8');
  const scanSrc = fs.readFileSync(
    path.join(ROOT, 'crates', 'vmusicd', 'src', 'scan.rs'), 'utf8');

  // 重扫必须复用既有行 id，否则封面按新 UUID 落盘、DB 保留旧 id，204。
  ok(/pub async fn get_track_id_by_path\(/.test(storeSrc2),
    'store 提供按路径查既有 id 的接口');
  // 增量扫描：既有行走 existing 映射复用 id（track.id = id），封面随后按
  // 复用后的 track.id 落盘——身份跟路径走的契约不变，代码形态变了。
  ok(/track\.id = id;[\s\S]{0,1500}?let id = track\.id\.clone\(\);[\s\S]{0,200}?save_cover\(&cache, &id,/.test(scanSrc),
    '扫描在保存封面前复用既有曲目 id（身份跟路径走）');

  // MP3 的 ID3v2 位于容器外，Probe 单独返回；漏读它封面与标签全丢。
  ok(/probed\.metadata\.into_inner\(\)/.test(libmetaSrc),
    '元数据读取合并 Probe 返回的容器外标签（ID3v2 on MP3）');

  // shelf.js 必须撤掉私有封面逻辑，改走共享解析器；详情条多一个「查看曲目」。
  ok(/window\.PlaylistCovers\.state\(item\.id\)/.test(shelfSrc),
    'shelf 卡面改走共享 PlaylistCovers');
  ok(!/var covers = new Map\(\)/.test(shelfSrc),
    'shelf 不再私有封面缓存（共享模块的全部意义）');
  ok(/\['open', '查看曲目', ''\]/.test(shelfSrc),
    'shelf 详情条提供「查看曲目」入口');

  // app.js：列表行封面、详情打开/返回、单曲移出 DELETE、排序 PUT。
  ok(/function paintRowArt\(art, id\)/.test(appSrc2), '列表行封面绘制函数');
  ok(/data-act="open"/.test(appSrc2), '列表行带「打开歌单」动作');
  ok(/async function openPlaylist\(id\)/.test(appSrc2)
    && /function closeDetail\(\)/.test(appSrc2), '详情打开 / 返回函数');
  ok(/transport\.del\(`\/v1\/playlists\/\$\{id\}\/tracks\/\$\{trackId\}`\)/.test(appSrc2),
    '单曲移出接 DELETE tracks/{track_id}');
  ok(/\/tracks\/order`/.test(appSrc2), '排序提交走 tracks/order');
  ok(/function initDetailSortable\(\)/.test(appSrc2), '详情内拖拽排序初始化');

  // 后端：store reorder 与路由接线。
  ok(/pub async fn reorder\(/.test(plsRs), 'store 提供 reorder');
  ok(/submitted order does not match playlist contents/.test(plsRs),
    'reorder 校验成员集合（排序端点不能顺手增删曲目）');
  ok(/tracks\/order/.test(routesSrc) && /reorder_playlist_tracks/.test(routesSrc),
    'PUT tracks/order 路由已注册');
}

section('性能收口：不可见画布门控（E1）');
{
  const stageSrc = fs.readFileSync(path.join(WEB, 'stage.js'), 'utf8');
  const csSrc = fs.readFileSync(path.join(WEB, 'creative-stage.js'), 'utf8');
  const appSrcE = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');

  // stage.js：暴露舞台可见性，窄屏以 body.stage-open 为准。
  ok(/function isStageVisible\(\)/.test(stageSrc)
    && /isStageVisible: isStageVisible/.test(stageSrc),
    'stage.js 提供并导出 isStageVisible');
  ok(/matchMedia\('\(max-width: 1240px\)'\)/.test(stageSrc),
    '窄屏判定与 CSS 抽屉断点共用 1240px');

  // creative-stage：targetFps 与 maybeProbe 都要在不可见时停掉。
  ok(/function targetFps\(\)[\s\S]{0,500}?isStageVisible/.test(csSrc),
    'targetFps 门控接 isStageVisible（不渲染不可见画布）');
  ok(/function maybeProbe\(\)[\s\S]{0,400}?isStageVisible/.test(csSrc),
    'maybeProbe 不在抽屉关闭时启动探测');
  ok(/function tick\(dtMs\)[\s\S]{0,420}?isStageVisible[\s\S]{0,120}?return;/.test(csSrc),
    'tick 内部有不可见即返回的第二道门');

  // app.js：点击「正在播放」打开播放控制弹窗（新契约，不再切换舞台抽屉）。
  ok(/ui\.stageBtn\.onclick = openNowPlaying/.test(appSrcE),
    '点击正在播放打开播放控制弹窗');
  ok(/function openNowPlaying[\s\S]{0,260}?np\.modal\.hidden = false/.test(appSrcE),
    'openNowPlaying 取消弹窗 hidden 并同步播放状态');
  // 弹窗底部 CTA：点击关闭弹窗并打开全屏沉浸舞台
  ok(/np\.goto\.onclick[\s\S]{0,220}?Stage\.setPage\(true\)/.test(appSrcE),
    '「跳转到舞台播放页面」准确导航至舞台播放页面');
  // E2 真机走查发现：窄屏模态抽屉键盘用户关不掉。Esc 必须能关抽屉
  // （沉浸页打开时 stage.js 自己 stopPropagation 处理 Esc，互不干扰）。
  ok(/e\.key === 'Escape'[\s\S]{0,180}?classList\.remove\('stage-open'\)/.test(appSrcE),
    'Esc 可关闭窄屏舞台抽屉（可访问性收口）');
}

// PlaylistCovers 的异步行为测试放到最后，跑完再统一输出结论（CommonJS
// 没有顶层 await，故把收尾日志挪进这个 IIFE）。
;(async function playlistCoverBehavior() {
  try {
    section('歌单体验：PlaylistCovers 行为');
    load('pl-covers.js');

    let trackCalls = 0;
    let coverCalls = [];
    const changed = [];
    const inst = sandbox.PlaylistCovers.init({
      fetchTracks: async (id) => {
        trackCalls += 1;
        if (id === 'PL-EMPTY') return [];
        return [{ id: 't1', has_cover: false }, { id: 't2', has_cover: true }];
      },
      fetchCover: async (trackId) => {
        coverCalls.push(trackId);
        return trackId === 't2' ? 'http://x.test/cover.jpg' : null;
      }
    });
    inst.onChange((id) => changed.push(id));

    // window 级方法与返回实例必须同源（shelf.js 走 window 这一路）。
    let viaWindowHit = 0;
    sandbox.PlaylistCovers.onChange(() => { viaWindowHit += 1; });
    sandbox.PlaylistCovers.state('PL1');
    ok(inst.state('PL1').s === 'pending', 'window.PlaylistCovers.state 与返回实例同源');

    const first = inst.state('PL1');
    ok(first.s === 'pending' && typeof first.hue === 'number',
      '首次询问立即返回 pending 并带占位色相');
    // 在途期间两个视图重复询问：不打第二遍两跳请求。
    inst.state('PL1');
    ok(trackCalls === 1, '在途重复询问共享同一次 fetchTracks（x' + trackCalls + '）');

    // 无封面曲目不会触发 cover 请求：挑中的是 t2。
    await new Promise((r) => setTimeout(r, 0));
    const done = inst.state('PL1');
    ok(done.s === 'url' && done.url === 'http://x.test/cover.jpg',
      '解析收敛到封面 URL（' + done.s + '）');
    ok(done.hue === first.hue, '占位色相前后稳定');
    ok(coverCalls.length === 1 && coverCalls[0] === 't2',
      '只向第一首 has_cover 的曲子取封面（' + coverCalls.join(',') + '）');
    ok(changed.length === 1 && changed[0] === 'PL1', '就绪后 onChange 通知一次');
    ok(viaWindowHit === 1, 'window 级 onChange 与实例级监听者同时被通知');

    // 空歌单：收敛到 none，色相仍在，供占位块使用。
    const e0 = inst.state('PL-EMPTY');
    await new Promise((r) => setTimeout(r, 0));
    const e1 = inst.state('PL-EMPTY');
    ok(e0.hue === e1.hue && e1.s === 'none',
      '空歌单收敛 none 且色相稳定');

    // invalidate 后重新询问要重新解析。
    inst.invalidate('PL1');
    inst.state('PL1');
    await new Promise((r) => setTimeout(r, 0));
    ok(trackCalls === 3 && inst.state('PL1').s === 'url',
      'invalidate 后重新解析（fetchTracks x' + trackCalls + '，含此前空歌单的一次）');
  } catch (err) {
    failures += 1;
    console.error('PlaylistCovers 行为测试异常：' + (err && err.stack || err));
  }

  console.log('\n' + '─'.repeat(56));
  if (failures) {
    console.error(`创意舞台契约检查：${checks - failures}/${checks} 通过，${failures} 项失败`);
    process.exit(1);
  }
  console.log(`创意舞台契约检查：${checks}/${checks} 全部通过`);
})();

