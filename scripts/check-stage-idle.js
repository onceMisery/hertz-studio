#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// 「空闲时收起正在播放」的契约检查（零依赖、不触网）。
//
//   node scripts/check-stage-idle.js
//
// 右侧舞台宽屏占掉 460px，没有曲目在播时它只是一块写着「未在播放」的空面板。
// 收起的判据一共三条，错任何一条的代价都很直接——要么继续白占一列，要么把
// 还在播的歌词和进度条藏掉，所以这里逐条钉住：
//
//   1. 快照里没有 track_id（从没载入过曲目）→ 收起
//   2. 按过「停止」且之后没再播放        → 收起
//   3. 暂停不算空闲                      → 不收起
//
// 另外钉住两条接线，它们坏了不会报错、只会静默失效：
//   - 两个「停止」入口都必须走 stopPlayback。绕过它就记不上 stopped，
//     收起功能直接形同虚设，而界面看起来一切正常。
//   - CSS 只在宽屏收起。窄屏舞台本来就是屏外的抽屉，收起它不但没省地方，
//     还会把「点开抽屉」这条路堵死。
//
// 判定函数是从 app.js 里整段抠出来跑的，不是照着源码另写一份实现——
// 源码改了判定，这里跟着一起变，不会出现"测试通过但行为已经变了"。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'plugin', 'ui');
// 统一成 LF：仓库在 Windows 上检出是 CRLF，按行锚点切代码段会切歪。
const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8').replace(/\r\n/g, '\n');
const APP = read('app.js');
const HTML = read('index.html');
const CSS = read('style.css');

let failures = 0;
let checks = 0;
function ok(cond, label) {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.error('  X ' + label);
  }
}
function eq(a, b, label) { ok(a === b, label + ' (got ' + JSON.stringify(a) + ')'); }
function section(name) { console.log('\n' + name); }

// ---------------------------------------------------------------------------
// 从 app.js 里抠出判定函数，放进最小沙箱直接跑
// ---------------------------------------------------------------------------

// 函数体以顶格的 `}` 收尾，是这个仓库的统一格式，按它切段足够稳。
function grab(name) {
  const head = 'function ' + name + '(';
  const start = APP.indexOf(head);
  if (start < 0) throw new Error('app.js 里找不到 ' + name);
  const end = APP.indexOf('\n}\n', start);
  if (end < 0) throw new Error(name + ' 的函数体没有以顶格 } 结束');
  return APP.slice(start, end + 3);
}

const CODE = [grab('stageIdle'), grab('syncStageIdle'), grab('setStageIdleHide')].join('\n');

function makeEnv(settings) {
  const body = { dataset: {} };
  const state = {
    snapshot: { track_id: null, playing: false, position_ms: 0, duration_ms: null },
    stopped: false,
    settings: settings || {},
  };
  const ui = { setStageIdleHide: { checked: false } };
  const puts = [];
  const transport = {
    put: (p, b) => { puts.push([p, b]); return Promise.resolve({}); },
  };
  const sandbox = {
    state, ui, transport, console,
    document: { body },
    // setStageIdleHide 在用户真的动手时会 bump 设置世代号（防远端旧响应把本地
    // 刚点的状态反杀）。这条链路不归本脚本测，沙箱里给个空实现即可。
    markSettingsDirty: () => {},
    // persistSettings 是 app.js 写设置表的统一出口（失败会 toast）。本脚本只
    // 关心「写了什么」，所以让它直连那台记账用的 transport。
    persistSettings: (patch) => transport.put('/v1/settings', patch),
  };
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox);
  return {
    state, ui, puts, body,
    idle: sandbox.stageIdle,
    sync: sandbox.syncStageIdle,
    setHide: sandbox.setStageIdleHide,
    // 收起与否只看这一个标记：app.js 不直接碰 .stage，表现全在 style.css。
    isHidden: () => body.dataset.stageIdle === '1',
  };
}

// ---------------------------------------------------------------------------

section('接线：设置项 / CSS / 停止入口');

ok(HTML.includes('id="set-stage-idle-hide"'), 'index.html 有 set-stage-idle-hide 复选框');
ok(APP.includes("setStageIdleHide: $('set-stage-idle-hide')"), 'app.js 取到了这个复选框');
ok(
  APP.includes('ui.setStageIdleHide.onchange'),
  '复选框的 onchange 已绑定（否则勾了没反应）',
);

ok(CSS.includes('body[data-stage-idle="1"] .stage { display: none; }'), 'CSS 收起 .stage');
ok(
  CSS.includes('body[data-stage-idle="1"] .app { grid-template-columns: var(--rail-w) minmax(0, 1fr); }'),
  'CSS 把舞台那一列从栅格里去掉（否则留下 460px 空洞）',
);
ok(
  CSS.includes('body[data-stage-idle="1"] #stage-btn { display: inline-flex; }'),
  '收起后顶栏「正在播放」按钮回来（留一条回全屏舞台的路）',
);

// 收起规则必须被 @media (min-width: 1241px) 包住：窄屏舞台是抽屉，
// 收起它等于把入口堵死。
const ruleAt = CSS.indexOf('body[data-stage-idle="1"] .app');
const mediaAt = CSS.lastIndexOf('@media', ruleAt);
const mediaHead = CSS.slice(mediaAt, mediaAt + 40);
ok(mediaAt >= 0 && mediaHead.includes('min-width: 1241px'), '收起规则只作用于宽屏（窄屏抽屉不受影响）');

// 停止入口：两个按钮都得走 stopPlayback，且 /v1/player/stop 只在它内部出现一次。
ok(APP.includes('ui.stop.onclick = () => stopPlayback();'), '底部播放条的停止走 stopPlayback');
ok(APP.includes('np.stop.onclick = () => stopPlayback();'), '播放弹窗的停止走 stopPlayback');
const actions = [];
const stopSandbox = { cancelSeek() {}, setPlayback(action) { actions.push(action); } };
vm.runInNewContext(grab('stopPlayback'), stopSandbox);
stopSandbox.stopPlayback();
eq(actions.join(','), 'stop', 'stopPlayback 只提交一次统一停止动作');

// 快照进来时必须重新算一次，否则"播放开始自动恢复"没有触发点。
const snapBody = APP.slice(APP.indexOf('function applySnapshot('), APP.indexOf('function updateRowActiveState('));
ok(snapBody.includes('syncStageIdle();'), 'applySnapshot 里调用了 syncStageIdle');
ok(
  APP.includes('setStageIdleHide(state.settings.stage_idle_hide !== false, false);'),
  'loadSettings 恢复开关，且默认按「开」处理',
);

section('判定：什么算空闲');

{
  const e = makeEnv({});
  e.sync();
  ok(e.isHidden(), '没有 track_id（从没载入曲目）→ 收起');
  ok(e.idle() === true, 'stageIdle 报空闲');
}

{
  const e = makeEnv({});
  e.state.snapshot.track_id = 't1';
  e.state.snapshot.playing = true;
  e.sync();
  ok(!e.isHidden(), '有曲目且正在播放 → 不收起');
}

{
  const e = makeEnv({});
  e.state.snapshot.track_id = 't1';
  e.state.snapshot.playing = false; // 暂停
  e.sync();
  ok(!e.isHidden(), '暂停不收起（曲目还在，收起会让歌词和进度凭空消失）');
}

{
  const e = makeEnv({});
  e.state.snapshot.track_id = 't1';
  e.state.snapshot.playing = false;
  e.state.stopped = true;
  e.sync();
  ok(e.isHidden(), '按过停止 → 收起');
}

{
  const e = makeEnv({});
  e.state.snapshot.track_id = 't1';
  e.state.stopped = true;
  e.state.snapshot.playing = true; // 又开始播了
  e.sync();
  ok(!e.isHidden(), '重新播放后舞台回来');
  eq(e.state.stopped, false, '重新播放后 stopped 被清掉（不会残留成下次的伪空闲）');
}

section('开关：默认开、关了永不收起、持久化时机');

{
  const e = makeEnv({}); // 设置表里还没有这项（老用户 / 首次运行）
  e.sync();
  ok(e.isHidden(), '默认开：设置缺失时按「收起」处理');
}

{
  const e = makeEnv({ stage_idle_hide: false });
  e.sync();
  ok(!e.isHidden(), '用户关掉后，空闲也不收起');
}

{
  const e = makeEnv({});
  e.setHide(false, false);
  eq(e.ui.setStageIdleHide.checked, false, '恢复设置时复选框跟着落位');
  eq(e.puts.length, 0, '恢复设置不写库（否则每次刷新都多写一次设置表）');
  e.state.snapshot.track_id = null;
  e.sync();
  ok(!e.isHidden(), '关掉之后立刻生效，不用刷新');
}

{
  const e = makeEnv({});
  e.setHide(false, true);
  eq(e.puts.length, 1, '用户动手时写一次库');
  eq(e.puts[0][0], '/v1/settings', '写的是 /v1/settings');
  eq(e.puts[0][1].stage_idle_hide, false, '写入的键是 stage_idle_hide');
}

{
  const e = makeEnv({ stage_idle_hide: false });
  e.setHide(true, false);
  ok(e.ui.setStageIdleHide.checked === true, '重新打开时复选框回到勾上');
  e.sync();
  ok(e.isHidden(), '重新打开后空闲就收起');
}

console.log('\n' + '─'.repeat(56));
if (failures) {
  console.log(`空闲收起契约检查：${failures}/${checks} 项失败`);
  process.exit(1);
}
console.log(`空闲收起契约检查：${checks}/${checks} 全部通过`);
