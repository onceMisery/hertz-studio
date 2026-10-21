// SPDX-License-Identifier: MIT
// 「纯真3D」海岸舞台的 Node 侧契约：产物存在且不超预算、暴露完整 API、
// 源码哈希与 .build-manifest.json 一致（改了 tools/coast-stage/src 忘了
// node build.mjs 就在这里红），宿主侧的接线完整（脚本加载顺序、入口/画布/
// 设置项、sceneSource 接线、设置可用性派生）。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
let passed = 0;
function pass(name) { passed += 1; console.log('PASS ' + name); }

// ---- 产物与体积 ----
const bundlePath = path.join(root, 'plugin/ui/vendor/coast-stage.js');
assert.ok(fs.existsSync(bundlePath), 'vendor/coast-stage.js 不存在：先跑 tools/coast-stage 的 node build.mjs');
const bundle = fs.readFileSync(bundlePath, 'utf8');
pass('vendor/coast-stage.js 存在');
assert.ok(bundle.length < 1.2 * 1024 * 1024, '产物超过 1.2MB 预算：当前 ' + (bundle.length / 1024).toFixed(1) + ' KB');
pass('产物体积 < 1.2MB（' + (bundle.length / 1024).toFixed(1) + ' KB）');
assert.match(bundle, /var CoastStagePure\s*=/, '产物必须是 IIFE 且挂 CoastStagePure 全局');
assert.ok(bundle.includes(' SPDX-License-Identifier: MIT'), '产物头必须带许可头与重建说明');
pass('产物为 CoastStagePure IIFE 且带头注释');

// ---- 源码哈希与 manifest 一致（防"改源忘重建"） ----
const manifestPath = path.join(root, 'tools/coast-stage/.build-manifest.json');
assert.ok(fs.existsSync(manifestPath), '缺少 tools/coast-stage/.build-manifest.json：跑一次 node build.mjs');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const { createHash } = require('node:crypto');
for (const [file, expected] of Object.entries(manifest)) {
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex').slice(0, 16), expected, 'Stale shared stage: ' + file);
}
pass('源码哈希与 .build-manifest.json 一致（产物为最新）');

// ---- API 面：在 Node 沙箱里真实执行产物，断言导出完整 ----
const vm = require('node:vm');
const sandbox = { window: {}, document: { createElement: () => ({ getContext: () => null }) }, Math, console };
sandbox.self = sandbox;
const api = vm.runInNewContext(fs.readFileSync(path.join(root, 'plugin/ui/vendor/stage-runtime.js'), 'utf8') + '\n' + bundle + ';CoastStagePure', sandbox, { timeout: 15000 });
for (const fn of ['probe', 'mount', 'unmount', 'setAudio', 'setTimeOfDay', 'setInteraction', 'setRig', 'resize', 'stats', 'capture', 'debug']) {
  assert.equal(typeof api[fn], 'function', 'CoastStagePure 缺少 ' + fn);
}
assert.ok(fs.existsSync(path.join(root, 'plugin/ui/stage-coast.js')), '缺少 stage-coast.js 适配层');
pass('CoastStagePure API 完整（probe/mount/unmount/setAudio/setTimeOfDay/setInteraction/resize/stats/capture/debug）');

const events = {};
const rigCalls = [];
const interactionCalls = [];
let currentOptions;
const fakeEngine = {
  probe: () => true, mount: (_canvas, options) => { currentOptions = options; return true; },
  unmount() {}, resize() {}, setTimeOfDay() {},
  setRig: (pose, options) => rigCalls.push({ pose, options }),
  setInteraction: value => interactionCalls.push(value),
};
const adapterSandbox = {
  window: { CoastStagePure: fakeEngine }, Float32Array, Date,
  document: {
    body: { classList: { contains: () => false } },
    addEventListener: (name, fn) => { events[name] = fn; },
    createElement: () => ({ className: '', setAttribute() {}, addEventListener() {}, removeEventListener() {}, remove() {} }),
  },
  requestAnimationFrame: () => 1, cancelAnimationFrame() {}, clearTimeout() {},
};
vm.runInNewContext(fs.readFileSync(path.join(root, 'plugin/ui/stage-coast.js'), 'utf8'), adapterSandbox);
const adapter = adapterSandbox.window.StageCoast;
assert.equal(typeof adapter.setInteraction, 'function', 'StageCoast pointer handoff');
const host = { clientWidth: 640, clientHeight: 360, appendChild() {} };
adapter.setHost(host);
adapter.setInteraction(false);
const supplied = { position: [1, 2, 3], yaw: 0.6, pitch: 0.2, fov: 48 };
adapter.setRig(supplied, { external: true });
supplied.position[0] = 999;
events['stage:fps']({ detail: { lowfx: true } });
assert.equal(rigCalls.at(-1).pose.position[0], 1, 'rebuild restores a copied free pose');
assert.equal(rigCalls.at(-1).options.external, true, 'rebuild preserves immediate external mode');
assert.equal(currentOptions.interactive, false, 'rebuild preserves pointer handoff');
assert.equal(interactionCalls.at(-1), false, 'pointer handoff reaches engine');
adapter.setRig(null);
assert.equal(rigCalls.at(-1).pose, null, 'null releases the live engine camera');
adapter.setRig({ yaw: 1 });
adapter.setHost(null);
const callCount = rigCalls.length;
adapter.setHost(host);
assert.equal(rigCalls.length, callCount, 'fresh Stage3D mount does not inherit the previous camera');
adapter.setHost(null);
pass('StageCoast camera/pointer handoff survives rebuild and resets at unmount');

// ---- 宿主接线 ----
const index = fs.readFileSync(path.join(root, 'plugin/ui/index.html'), 'utf8');
assert.ok(index.indexOf('vendor/coast-stage.js') < index.indexOf('stage-coast.js'),
  'vendor 必须先于 stage-coast.js 加载');
assert.ok(index.indexOf('stage-coast.js') < index.indexOf('src="stage3d.js"'),
  'stage-coast.js 必须先于 stage3d.js 加载');
assert.ok(!index.includes('id="s3d-coast-toggle"'),
  '舞台效果不进头部那一排：海岸公路只从「舞台来源」进');
assert.ok(!index.includes('id="s3d-head-trigger"') && index.includes('class="sp-fab s3d-settings-fab"'),
  '声场使用浮动设置入口');
assert.ok(index.includes('<option value="coast">'), '舞台来源下拉缺少海岸公路');
assert.ok(index.includes('id="s3d-coast-tod"') && index.includes('id="s3d-coast-interact"'),
  '缺少海岸时刻/交互设置项');
pass('index.html：脚本顺序、设置入口、来源下拉、设置项齐全');

const stage3d = fs.readFileSync(path.join(root, 'plugin/ui/stage3d.js'), 'utf8');
assert.ok(stage3d.includes("'coast'"), 'stage3d.js 未接入 sceneSource coast');
assert.ok(stage3d.includes('syncCoastStage'), 'stage3d.js 缺少 syncCoastStage');
assert.ok(stage3d.includes('StageCoast.setHost'), 'stage3d.js 未接 StageCoast.setHost');
assert.ok(stage3d.includes('coastTod') && stage3d.includes('coastInteract'), 'stage3d.js 缺少海岸偏好持久化');
pass('stage3d.js：sceneSource/宿主/偏好接线齐全');

const settings = fs.readFileSync(path.join(root, 'plugin/ui/stage-settings.js'), 'utf8');
assert.ok(settings.includes("state.source === 'coast'"), 'stage-settings.js 未派生海岸可用性');
assert.ok(settings.includes("row('s3d-coast-tod'") && settings.includes("row('s3d-coast-interact'"),
  'stage-settings.js 缺少海岸设置行');
pass('stage-settings.js：海岸可用性派生齐全');

console.log('\ncheck-coast-stage: ' + passed + ' checks passed');
