#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// SpaceCamera 契约检查（零依赖、不触网、无 DOM）。docs/design/space3d-mode.md
// §10.2 与 §12.2 的可证伪形式，全部跑在真实模块上（vm 载入 plugin/ui/space-camera.js）：
//
//   1. 角度环绕：350°→10° 的回正走短弧，收敛值与目标在 mod 2π 下相等；
//   2. 钳制：phi/radius/自由镜头 pitch/yaw/roll/fov 的边界逐项对源值；
//   3. combo 派生：(count-1)%4 四槽 + accent 只覆盖非 downbeat 槽（strength>0.84）；
//   4. Named 镜头映射：五个 combo 的 amp/zoomAmp/phiAmp 乘数表与 kick 映射逐字对源；
//   5. 变帧率一致性：同一秒总时长下 60Hz 与 144Hz 帧序列的收敛机位差 < 0.02
//      （θ/φ 以弧度、radius 以世界单位计，取三者最大绝对差）；
//   6. 惯性尾巴：0.46 抬手系数在，「甩一下转过头」不在；
//   7. 轴重置：|rot|>10π 吸附 2π 整数倍，同朝向两次拖到同一位置输出角 mod 2π 相等；
//   8. 自由镜头位姿持久化形状 {locked,active,position,yaw,pitch,roll,fov}；
//   9. 机位基线表：space3d.js 注册表里的 Mineradio 预设值逐字对齐（§12.4 的
//      「注册表是唯一 owner」由此钉住）。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'plugin', 'ui');
let checks = 0;
let failures = 0;
function ok(cond, label) {
  checks += 1;
  if (!cond) { failures += 1; console.error('  ✗ ' + label); }
}
function near(a, b, eps, label) {
  ok(Math.abs(a - b) <= eps, label + '（期望 ' + b + '±' + eps + '，实得 ' + a + '）');
}
function section(name) { console.log('\n' + name); }
const TAU = Math.PI * 2;
const rad = (d) => d * Math.PI / 180;
const wrapPi = (x) => Math.atan2(Math.sin(x), Math.cos(x));

// —— 载入真实模块（不开 DOM，不 fake 数学）—— //
const src = fs.readFileSync(path.join(WEB, 'space-camera.js'), 'utf8');
const sandbox = { console, Date, isFinite, performance: undefined };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'space-camera.js' });
const SC = sandbox.window.SpaceCamera;
ok(!!SC && typeof SC.tick === 'function', 'SpaceCamera 从 window 挂载且可直测');

function fresh() {
  // 每组用例从默认态出发：重开一个沙箱比清状态可靠。
  const sb = { console, Date, isFinite };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(src, sb, { filename: 'space-camera.js' });
  return sb.window.SpaceCamera;
}
function run(sc, totalMs, dtMs, env) {
  for (let t = 0; t < totalMs - 1e-9; t += dtMs) sc.tick(dtMs, env);
}

// —— 1. 角度环绕 —— //
section('角度环绕：350°→10° 走短弧');
{
  const sc = fresh();
  sc.setBaseline({ theta: rad(350), phi: 0.08, radius: 6.6 });
  sc.snap();
  // 换预设 = 换基线：目标跳到 10°，视觉角必须从 360° 方向短弧追过去。
  sc.setBaseline({ theta: rad(10), phi: 0.08, radius: 6.6 });
  let worst = 0;
  for (let i = 0; i < 400; i++) {
    sc.tick(16.667, {});
    const s = sc.internals().orbit;
    worst = Math.max(worst, Math.abs(wrapPi(s.cur[0] - s.user[0])));
  }
  const st = sc.internals().orbit;
  near(wrapPi(st.user[0]), rad(10), 1e-9, '目标角落在 10°');
  near(wrapPi(st.cur[0]), rad(10), 0.01, '视觉角收敛到 10°（mod 2π）');
  ok(worst <= rad(20) + 0.01, '全程走短弧（最大角距 ' + worst.toFixed(4) + ' rad ≤ 20° 弧差）');
  // 注视点基线：场机位带 look（隧道/极光），视觉值 τ260 收敛到基线。
  const sc3 = fresh();
  sc3.setBaseline({ theta: 0, phi: 0, radius: 2.2, look: [0, 0, -2.2] });
  for (let i = 0; i < 200; i++) sc3.tick(16.667, {});
  const lk = sc3.pose().lookAt;
  near(lk[2], -2.2, 0.01, '注视点收敛到基线 look.z');
  sc3.setBaseline({ theta: 0, phi: 0, radius: 2.2, look: [0, 0, 0] });
  for (let i = 0; i < 200; i++) sc3.tick(16.667, {});
  near(sc3.pose().lookAt[2], 0, 0.01, 'look 归零收敛');
  // 基线视场角：场机位要 52–68°（towers 54 / 频谱球 52 / 星云 54），FOV 冲击在它之上做减法。
  const sc4 = fresh();
  sc4.setCinema(true, 0);   // shake=0：FOV 冲击不混入，基线读数纯
  sc4.setBaseline({ theta: 0, phi: 0.08, radius: 6.6, fov: 54 });
  for (let i = 0; i < 200; i++) sc4.tick(16.667, {});
  near(sc4.pose().fov, 54, 0.01, 'orbit fov 收敛到基线 54');
  sc4.setBaseline({ theta: 0, phi: 0.08, radius: 6.6, fov: 100 });
  for (let i = 0; i < 200; i++) sc4.tick(16.667, {});
  near(sc4.pose().fov, 72, 0.01, 'fov 基线钳到 72（与自由镜头同界）');
}

section('场景机位与自由镜头连续性');
{
  const sc = fresh();
  sc.setCinema(false, 0);
  sc.setBaseline({theta: 0, phi: 0.2, radius: 23, fov: 54, look: [0, 1, 0], maxRadius: 80});
  sc.snap();
  near(sc.pose().radius, 23, 1e-9, '场景显式距离范围保留塔林 23 单位构图');
  near(sc.pose().lookAt[1], 1, 1e-9, 'snap 同时应用注视点');
  sc.freeToggle();
  const p = sc.pose();
  const dir = [-Math.sin(p.yaw) * Math.cos(p.pitch), Math.sin(p.pitch), -Math.cos(p.yaw) * Math.cos(p.pitch)];
  const target = p.position.map((v, i) => v + dir[i] * 23);
  near(target[0], 0, 1e-6, '自由镜头进入后仍看向注视点 x');
  near(target[1], 1, 1e-6, '自由镜头进入后仍看向注视点 y');
  near(target[2], 0, 1e-6, '自由镜头进入后仍看向注视点 z');
  sc.freeLoad({locked:true, position:{x:0,y:0,z:0}, fov:54});
  near(sc.pose().position[2], 0, 0, '自由机位 z=0 持久化不被默认值覆盖');
  sc.setBaseline({theta:0,phi:0,radius:6.6});
  sc.snap();
  near(sc.internals().orbit.base[2], 6.6, 0, '切回普通场恢复默认范围');
  sc.freeToggle(); sc.freeKey('KeyW', true); sc.tick(100, {}); sc.clearInput();
  const stopped = sc.pose().position.slice(); sc.tick(100, {});
  ok(sc.pose().position.every((n, i) => Math.abs(n - stopped[i]) < 1e-9), '失焦清输入后不继续移动');
}

// —— 2. 钳制 —— //
section('钳制边界逐项对源值');
{
  const sc = fresh();
  const C = SC.CONSTANTS;
  near(C.BASE_FOV, 45, 0, 'BASE_FOV 45');
  near(C.MIN_PHI, -Math.PI * 0.45, 0, 'minPhi −π·0.45');
  near(C.MAX_PHI, Math.PI * 0.45, 0, 'maxPhi π·0.45');
  near(C.MIN_RADIUS, 2.4, 0, 'minRadius 2.4');
  near(C.MAX_RADIUS, 14, 0, 'maxRadius 14');
  near(C.FREE_PITCH, Math.PI * 0.49, 0, '自由 pitch ±π·0.49');
  near(C.FREE_YAW, Math.PI * 8, 0, '自由 yaw ±π·8');
  near(C.FREE_ROLL, Math.PI, 0, '自由 roll ±π');
  eq(C.FREE_FOV_MIN, 26, 'fov 下限 26');
  eq(C.FREE_FOV_MAX, 72, 'fov 上限 72');
  sc.setBaseline({ theta: 0, phi: 1.5, radius: 20 });
  const b = sc.baseline();
  near(b.phi, Math.PI * 0.45, 1e-9, '基线 phi 被钳到 π·0.45');
  near(b.radius, 14, 1e-9, '基线 radius 被钳到 14');
  sc.wheel(-1e6);
  near(sc.internals().orbit.user[2], 2.4, 1e-9, '滚轮半径钳到 2.4');
  sc.wheel(1e6);
  near(sc.internals().orbit.user[2], 14, 1e-9, '滚轮半径钳到 14');
  sc.freeLoad({ position: { x: 0, y: 99, z: 6.6 }, yaw: 99, pitch: 2, roll: 5, fov: 100, locked: true });
  const f = sc.freeSnapshot();
  near(f.position.y, 80, 1e-9, '恢复位置 y 钳到 ±80');
  near(f.yaw, Math.PI * 8, 1e-9, '恢复 yaw 钳到 ±π·8');
  near(f.pitch, Math.PI * 0.49, 1e-9, '恢复 pitch 钳到 ±π·0.49');
  near(f.roll, Math.PI, 1e-9, '恢复 roll 钳到 ±π');
  near(f.fov, 72, 1e-9, '恢复 fov 钳到 72');
}

// —— 3. combo 派生 —— //
section('combo 派生：四槽 + accent 覆盖');
{
  const expect = ['downbeat', 'push', 'drop', 'rebound', 'downbeat', 'push', 'drop', 'rebound'];
  for (let i = 1; i <= 8; i++) eq(SC.comboFor(i, 0.5), expect[i - 1], 'count=' + i + ' strength=0.5 → ' + expect[i - 1]);
  eq(SC.comboFor(2, 0.9), 'accent', 'count=2 strength=0.9 → accent');
  eq(SC.comboFor(1, 0.9), 'downbeat', 'downbeat 槽不被 accent 覆盖');
  eq(SC.comboFor(5, 0.9), 'downbeat', 'count=5（slot 0）不被覆盖');
  eq(SC.comboFor(-3, 0.5), 'downbeat', 'count=-3 → (−3−1)%4 = slot 0 → downbeat');
  eq(SC.comboFor(0, 0.5), 'rebound', 'count=0 → (0−1)%4 = slot 3 → rebound');
}

// —— 4. Named 镜头映射 —— //
section('Named 镜头映射：乘数表与 kick');
{
  const sc = fresh();
  sc.setCinema(true, 0); // shake=0：FOV 冲击不混入，映射读数更纯
  const meta = { time: 0, strength: 0.8, confidence: 0.8, low: 0.62, body: 0.22, snap: 0.16 };
  // count 显式给：1=downbeat 槽，2/3/4 = push/drop/rebound，5=downbeat、6=accent。
  const base = sc.beat(1, Object.assign({}, meta, { time: 0, count: 1 }));
  const RATIO = {
    push: { amp: 0.84, zoom: 0.88 },
    drop: { amp: 0.96, zoom: 0.72 },
    rebound: { amp: 0.74, zoom: 0.62 }
  };
  let t = 1;
  ['push', 'drop', 'rebound'].forEach((combo, i) => {
    const ev = sc.beat(1, Object.assign({}, meta, { time: t, count: i + 2 }));
    t += 1;
    eq(ev.combo, combo, 'count=' + (i + 2) + ' → ' + combo);
    near(ev.amp / base.amp, RATIO[combo].amp / 1.10, 1e-9, combo + ' amp 乘数');
    near(ev.zoomAmp / base.zoomAmp, RATIO[combo].zoom / 1.18, 1e-9, combo + ' zoomAmp 乘数');
  });
  // accent：slot 1 + strength 0.9 → accent（rollAmp ×1.35），对同强度的 downbeat 比。
  const acc = sc.beat(1, Object.assign({}, meta, { time: t, count: 6, strength: 0.9 }));
  const down = sc.beat(1, Object.assign({}, meta, { time: t + 1, count: 5, strength: 0.9 }));
  eq(acc.combo, 'accent', 'count=6 strength=0.9 → accent');
  eq(down.combo, 'downbeat', 'count=5 strength=0.9 → downbeat（不被覆盖）');
  near(acc.rollAmp / down.rollAmp, 1.35, 1e-9, 'accent rollAmp ×1.35');
  // kick 映射：downbeat 的 radiusKick → punch·zoomAmp。音频时间放慢推进，
  // 让 attack+hold（≈60ms 音频时间）铺开成十几个 tick，kick 跟随追得到满值。
  const sc2 = fresh();
  sc2.setBaseline({ theta: 0, phi: 0.08, radius: 6.6 });
  const ev = sc2.beat(1, Object.assign({}, meta, { time: 5, count: 1 }));
  let kick = 0;
  for (let i = 0; i < 60; i++) {
    sc2.tick(16.667, { playing: true, audioTime: 4.994 + i * 0.005 });
    kick = Math.max(kick, sc2.internals().beat.kicks[2]);
  }
  near(kick / (ev.amp * ev.zoomAmp), 1, 0.05, 'downbeat radiusKick ≈ punch·zoomAmp');
}

// —— 5. 变帧率一致性 —— //
section('同一秒总时长：60Hz 与 144Hz 收敛一致（<0.02）');
{
  function converge(hz) {
    const sc = fresh();
    sc.setBaseline({ theta: 2.0, phi: 0.3, radius: 9.0 });
    sc.snap();
    sc.setBaseline({ theta: -1.0, phi: 0.1, radius: 5.0 });
    sc.recenter();
    const dtMs = 1000 / hz;
    const steps = Math.round(2000 / dtMs);
    for (let i = 0; i < steps; i++) sc.tick(dtMs, {});
    return sc.internals();
  }
  const a = converge(60);
  const b = converge(144);
  const dT = Math.abs(wrapPi(a.orbit.user[0] - b.orbit.user[0]));
  const dP = Math.abs(a.orbit.user[1] - b.orbit.user[1]);
  const dR = Math.abs(a.orbit.user[2] - b.orbit.user[2]);
  ok(Math.max(dT, dP, dR) < 0.02, '回正机位差 ' + Math.max(dT, dP, dR).toExponential(2) + ' < 0.02');
  ok(dT < 0.02 && dP < 0.02 && dR < 0.02, 'θ/φ/radius 三者各自 < 0.02');
}
{
  // 惯性尾巴同样按墙钟一致。
  function fling(hz) {
    const sc = fresh();
    sc.spinDrag(120, 0, 0.05);
    const dtMs = 1000 / hz;
    for (let i = 0; i < Math.round(1600 / dtMs); i++) sc.tick(dtMs, {});
    return sc.internals().world.target[1];
  }
  const d = Math.abs(wrapPi(fling(60) - fling(144)));
  ok(d < 0.02, '120px 甩拖的世界转角 60/144Hz 差 ' + d.toExponential(2) + ' < 0.02');
}

// —— 6. 惯性尾巴（0.46 抬手系数）—— //
section('抬手惯性：0.46 系数在');
{
  const sc = fresh();
  sc.spinDrag(120, 0, 0.05);
  const targetAfterDrag = sc.internals().world.target[1];
  near(targetAfterDrag, 120 * 0.0034, 1e-9, '拖拽位移直接进目标角');
  for (let i = 0; i < 200; i++) sc.tick(16.667, {});
  const total = sc.internals().world.target[1];
  const tail = total - targetAfterDrag;
  ok(tail > 0.3 && tail < 0.9, '惯性尾巴 ' + tail.toFixed(3) + ' rad ∈ (0.3, 0.9)——没有 0.46 会是 ~1.36（转过头一倍多）');
  ok(total < targetAfterDrag * 3, '总转角没有失控（' + total.toFixed(3) + ' rad）');
  near(sc.internals().world.visual[1], total, 0.02, '惯性积分进目标角，视觉角随后跟平');
}

// —— 7. 轴重置 —— //
section('轴重置：10π 吸附 + mod 2π 同朝向一致');
{
  const sc = fresh();
  for (let i = 0; i < 12; i++) { sc.spinDrag(1000, 0, 0.02); sc.tick(16.667, {}); }
  const st = sc.internals().world;
  ok(Math.abs(st.target[1]) < SC.CONSTANTS.REBASE_LIMIT, '目标角始终有界（' + st.target[1].toFixed(3) + ' rad < 10π，未重置会累计到 ~45）');
  ok(Math.abs(wrapPi(st.target[1])) < Math.abs(st.target[1]) - 1e-9 || Math.abs(st.target[1]) <= Math.PI + 1e-9,
    '越过 10π 时已按 2π 整数倍吸附');
  for (let i = 0; i < 240; i++) sc.tick(16.667, {});
  const settled = sc.internals().world;
  near(wrapPi(settled.target[1] - settled.visual[1]), 0, 0.01, '重置同时平移了目标与视觉（无落差）');
  // 两次从零出发、同幅度的拖拽序列，终点在 mod 2π 下相等。
  function dragSeq() {
    const s2 = fresh();
    for (let i = 0; i < 12; i++) { s2.spinDrag(1000, 0, 0.02); s2.tick(16.667, {}); }
    return s2.internals().world.target[1];
  }
  near(wrapPi(dragSeq() - dragSeq()), 0, 1e-9, '同朝向两次拖到同一位置：输出角 mod 2π 相等');
}

// —— 8. 自由镜头持久化形状 —— //
section('自由镜头位姿持久化形状');
{
  const sc = fresh();
  const snap = sc.freeSnapshot();
  ok(JSON.stringify(Object.keys(snap)) === JSON.stringify(['locked', 'active', 'position', 'yaw', 'pitch', 'roll', 'fov']),
    '快照键序 {locked,active,position,yaw,pitch,roll,fov}');
  ok(JSON.stringify(Object.keys(snap.position)) === JSON.stringify(['x', 'y', 'z']), 'position 是 {x,y,z}');
  eq(snap.active, false, '快照不携带激活态');
  sc.freeLoad({ locked: true, position: { x: 1.5, y: 0.25, z: -3 }, yaw: 0.4, pitch: -0.1, roll: 0.02, fov: 50 });
  const back = sc.freeSnapshot();
  near(back.position.x, 1.5, 1e-9, 'load→snapshot 往返 x');
  near(back.fov, 50, 1e-9, 'load→snapshot 往返 fov');
  eq(back.locked, true, 'locked 语义保留');
  ok(sc.isFreeEngaged() && !sc.isFreeActive(), '恢复后是「已固定」而不是「激活」');
  // 键位捕获集与源文件逐字一致。
  eq(SC.CONSTANTS.FREE_MOVE_CODES,
    '^(KeyW|KeyA|KeyS|KeyD|KeyQ|KeyE|Space|ShiftLeft|ShiftRight|ControlLeft|ControlRight)$',
    'WASD/QE/Space/Shift/Ctrl 移动键集合');
}

// —— 9. Shared plugin definitions own camera baselines. —— //
section('机位基线表：注册表是唯一 owner');
{
  const s3dPath = path.join(WEB, 'space3d.js');
  if (!fs.existsSync(s3dPath)) {
    ok(false, 'space3d.js 尚未落地，基线表检查待其实现后生效');
  } else {
  const s3dSrc = fs.readFileSync(s3dPath, 'utf8');
  ok(!/SOURCE_BASELINES\s*=|PRESET_BASELINE/.test(s3dSrc), '空间不维护第二份插件机位表');
  ok(/camera\.setBaseline\(/.test(s3dSrc) && /baseline\.lookAt/.test(s3dSrc), '注册机位注视点经空间相机消费');
  const vm = require('node:vm');
  const bundle = fs.readFileSync(path.join(WEB, 'vendor/space-stage.js'), 'utf8');
  const sandbox = { console, AbortController, setTimeout, clearTimeout };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  const api = vm.runInNewContext(fs.readFileSync(path.join(WEB, 'vendor/stage-runtime.js'), 'utf8') + '\n' + bundle + ';SpaceStagePure', sandbox);
  api.catalog().forEach(d => {
    const sc = fresh();
    sc.setBaseline(Object.assign({}, d.camera, { look: d.camera.lookAt }));
    near(sc.baseline().theta, d.camera.theta, 1e-9, d.id + ' theta');
    near(sc.baseline().radius, d.camera.radius, 1e-9, d.id + ' radius');
  });
  }
}

function eq(a, b, label) {
  checks += 1;
  if (a !== b) { failures += 1; console.error('  ✗ ' + label + '（期望 ' + JSON.stringify(b) + '，实得 ' + JSON.stringify(a) + '）'); }
}

console.log('\nSpaceCamera 契约检查：' + checks + ' 项，' + failures + ' 项失败');
process.exit(failures ? 1 : 0);
