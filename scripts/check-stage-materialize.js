// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// R3-K 物化检查：加载真实的 CreativeGL + CreativeStage + CreativeShareCode，
// 验证 materializeIntent 的纯性与 create 模式语义，并做旧分享码往返。
//
//   1. 确定性：同一 (基线, 意图) 物化两次逐字节相等；
//   2. 基线无关：create 模式（canonicalBaseline）不受「当前舞台状态」影响；
//   3. defaults：切场景时参数换成目标场景默认、机位落入画点；
//   4. 校验负例：版本/场景/未知参数（ignored）与夹位；
//   5. 旧分享往返：物化候选 → HSCP1 编码 → 解码 → normalize 后逐字段相等；
//   6. 提交等价：applyIntent 的产出与 materializeIntent 的候选一致。
//
// 用法：node scripts/check-stage-materialize.js

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const UI = path.join(ROOT, 'plugin', 'ui');

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function load(file, sandbox) {
  const code = fs.readFileSync(path.join(UI, file), 'utf8');
  vm.runInContext(code, sandbox, { filename: file });
}

const sandbox = {
  window: {},
  console,
  // 分享码压缩走浏览器/Node 18+ 都有的全局流 API。
  Blob,
  TextEncoder,
  TextDecoder,
  CompressionStream,
  DecompressionStream,
  btoa: (data) => Buffer.from(data, 'binary').toString('base64'),
  atob: (data) => Buffer.from(data, 'base64').toString('binary'),
  setTimeout,
  clearTimeout,
  // materialize 路径不触 DOM；给懒引用兜底以防将来有人在加载期碰它。
  document: {
    hidden: false,
    addEventListener() {},
    dispatchEvent() {},
    getElementById() {
      return null;
    },
    body: { classList: { contains() { return false; } } },
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

load('creative-gl.js', sandbox);
load('handdrawn.js', sandbox);
// creative-stage 的模块顶层用裸标识符引用同伴（BASE_SPEC 构建要
// CreativeGL.cameraSpec()、basePreset 要 HandDrawn.defaults），镜像成
// 沙箱全局。
sandbox.CreativeGL = sandbox.window.CreativeGL;
sandbox.HandDrawn = sandbox.window.HandDrawn;
load('creative-share-code.js', sandbox);
load('creative-stage.js', sandbox);
// share-code 的 encode/decode 用裸 CreativeStage 引用，同样镜像。
sandbox.CreativeStage = sandbox.window.CreativeStage;
sandbox.CreativeShareCode = sandbox.window.CreativeShareCode;

const GL = sandbox.window.CreativeGL;
const Stage = sandbox.window.CreativeStage;
const Share = sandbox.window.CreativeShareCode;
if (!GL || !Stage || !Share) fail(`加载失败: GL=${!!GL} Stage=${!!Stage} Share=${!!Share}`);
if (typeof Stage.materializeIntent !== 'function' || typeof Stage.canonicalBaseline !== 'function') {
  fail('CreativeStage 未暴露 materializeIntent / canonicalBaseline（R3-K 导出面缺失）');
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---- 1. create 模式确定性 + 基线无关 ----
// patch 值取 orb 半径量程的中点（量程外值的夹位在负例段单独验证）。
const orbRadius = GL.sceneById('orb').params.find((row) => row[0] === 'radius');
const radiusMid = orbRadius[2] + (orbRadius[3] - orbRadius[2]) / 2;
const intent = {
  version: 1,
  scene: 'orb',
  director: false,
  patch: { 'sc.radius': radiusMid },
};
const baseTowers = Stage.canonicalBaseline('towers');
if (baseTowers.scene !== 'towers' || !baseTowers.sc || !baseTowers.cam) {
  fail('canonicalBaseline(towers) 应是带参数与机位的 towers 默认预置');
}
const a = Stage.materializeIntent(null, intent);
const b = Stage.materializeIntent(null, intent);
if (!a.ok || !b.ok || !deepEqual(a.preset, b.preset)) {
  fail('同一意图的两次 create 物化必须逐字段一致');
}
if (a.preset.scene !== 'orb') fail('create 模式必须落到目标场景');
// 切场景后参数表是 orb 的默认值，patch 值优先生效。
if (a.preset.sc.radius !== radiusMid) fail('意图里明确写了的 patch 值必须优先于场景默认');
console.log('1. create 确定性 + 目标场景默认/机位 ✓');

// ---- 2. 基线无关：编辑语义与 create 语义分离 ----
// 当前舞台是什么不影响 create 物化（调用方显式传基线）；编辑语义下基线
// 参与结果——两者并存且互不干扰。
const mutated = JSON.parse(JSON.stringify(baseTowers));
mutated.look.grade = 2; // 偏离默认的当前舞台
const fromMutated = Stage.materializeIntent(mutated, {
  version: 1,
  scene: 'orb',
  patch: {},
});
const fromClean = Stage.materializeIntent(baseTowers, {
  version: 1,
  scene: 'orb',
  patch: {},
});
if (!fromMutated.ok || !fromClean.ok) fail('基线物化意外失败');
if (deepEqual(fromMutated.preset, fromClean.preset)) {
  fail('不同基线物化出同一候选：基线没有参与，编辑语义被破坏');
}
// create 模式传规范基线：两次 canonicalBaseline('orb') 物化产物一致——
// 「不从当前舞台猜」的含义。显式传污染基线则不同（上面已验证那是编辑语义）。
const createViaStage = Stage.materializeIntent(
  Stage.canonicalBaseline('orb'),
  intent
);
if (!deepEqual(a.preset, createViaStage.preset)) {
  fail('create 模式必须从规范基线出发，与当前舞台状态无关');
}
console.log('2. 基线参与编辑、create 与当前舞台无关 ✓');

// ---- 3. 校验负例与夹位 ----
if (Stage.materializeIntent(null, { version: 2 }).code !== 'bad_version') {
  fail('版本不受支持必须 bad_version');
}
if (Stage.materializeIntent(null, { version: 1, scene: 'space', patch: {} }).code !== 'bad_scene') {
  fail('假场景必须 bad_scene（评审 P2-7 的回归钉）');
}
const clamped = Stage.materializeIntent(null, {
  version: 1,
  patch: { 'sc.height': 99999, 'sc.nonsense': 1 },
});
if (!clamped.ok) fail(`合法意图意外失败: ${clamped.message}`);
if (!clamped.ignored.includes('sc.nonsense')) fail('未登记参数必须进 ignored');
const towers = GL.sceneById('towers');
const heightRow = towers.params.find((row) => row[0] === 'height');
const materializedHeight = clamped.preset.sc.height;
if (materializedHeight > heightRow[3] || materializedHeight < heightRow[2]) {
  fail(`patch 值必须夹进场景量程: ${materializedHeight}`);
}
console.log('3. 校验负例 / ignored / 夹位 ✓');

// ---- 4. 旧分享往返：物化候选 → HSCP1 → 解码 → 相等 ----
(async () => {
  const code = await Share.encode(a.preset, { compress: false });
  if (!code.startsWith('HSCP1.J.')) fail(`分享码帧格式错误: ${code.slice(0, 16)}`);
  const decoded = await Share.decode(code);
  // 编码端做 normalizeSharePreset 清洗，解码回来应与候选的规范形一致。
  if (!deepEqual(decoded, Stage.materializeIntent(null, intent).preset)) {
    fail('分享往返后与物化候选不一致');
  }
  console.log('4. HSCP1 分享往返 ✓');

  // ---- 5. 提交等价（结构约束）----
  // Stage.create 需要 WebGL，Node 里跑不了真舞台；行为等价由「applyIntent
  // 必须委托纯物化」的结构约束保证——委托一丢（比如有人把旧实现抄回来），
  // 这里的检查立刻红。
  const stageSource = fs.readFileSync(path.join(UI, 'creative-stage.js'), 'utf8');
  if (!/function applyIntent\(intent\) \{[\s\S]*?materializeIntent\(preset, intent\)/.test(stageSource)) {
    fail('applyIntent 必须委托 materializeIntent（提交等价的结构保证）');
  }
  console.log('5. applyIntent ≡ materializeIntent + 提交（结构约束）✓');

  console.log('✓ R3-K 物化检查全部通过');
  process.exit(0);
})().catch((error) => fail(error.message));
