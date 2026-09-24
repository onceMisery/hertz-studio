#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 电影相机无头检查：
//   1) 时间轴纯函数（外推时钟 / 重锚 / 单调游标 / seek 重定位 / 多拍取最强 / 包络）；
//   2) 跨文件契约（roll 通道、层总线与优先级、协议分支、互斥与降级常量）。
//
//   node scripts/check-stage-cinema.js

'use strict';

const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'crates', 'vmusicd', 'web');
const P = require(path.join(WEB, 'stage-cinema.js'));

let failures = 0;
let checks = 0;
function ok(cond, label) {
  checks += 1;
  if (!cond) { failures += 1; console.error('  ✗ ' + label); }
}
function section(name) { console.log('\n' + name); }
function approx(a, b, eps) { return Math.abs(a - b) <= eps; }
function read(file) { return fs.readFileSync(path.join(WEB, file), 'utf8'); }

function makeMap(beatSpec) {
  return {
    version: 1, bpm: 120, offset_ms: 0, truncated: false,
    beats: beatSpec.map(function (b, i) {
      return { t: b[0], strength: b[1], downbeat: !!b[2], intensity: b[3] != null ? b[3] : (i % 4 === 0 ? 2 : 1) };
    })
  };
}

section('时间轴：外推时钟');
{
  const c = P.createClock();
  ok(P.pt(c, 999) === 0, '未锚定时钟恒为 0');
  const hard1 = P.reanchor(c, 1000, 500, true);
  ok(hard1 === true, '首帧锚定是硬对齐');
  ok(P.pt(c, 750) === 1250, '播放中按本地时钟外推');
  P.reanchor(c, 1300, 800, true);
  ok(P.pt(c, 800) === 1300, '状态帧到达即重锚');
  ok(P.reanchor(c, 1400, 900, false) === false, '小幅偏差不是硬对齐');
  ok(P.pt(c, 1000) === 1400, '暂停时冻结在锚点');
  ok(P.reanchor(c, 5000, 1100, true) === true, '漂移 >150ms 触发硬对齐');
}

section('时间轴：游标 / seek / 一帧多拍');
{
  const map = makeMap([[100, 0.3], [200, 0.9], [300, 0.5], [500, 0.7], [560, 0.4]]);
  const tl = P.createTimeline(map);
  const got1 = P.advance(tl, 0, 300);
  ok(got1 && got1.t === 200, '区间多拍取 strength 最大（200@0.9）');
  ok(P.advance(tl, 300, 400) === null, '已消费区间不重复发拍');
  const got2 = P.advance(tl, 400, 600);
  ok(got2 && got2.t === 500, '后续区间继续推进');

  const tl2 = P.createTimeline(makeMap([[1000, 0.5], [5000, 0.6], [5050, 0.9], [5100, 0.4]]));
  ok(P.advance(tl2, 0, 1000).t === 1000, '正常区间拍点');
  // seek：驱动侧检测到硬对齐会先 relocate 到新位置，随后 advance 不得补发
  // 跨越区间内的历史拍（spec §9：只取最强一拍的长帧规则也不允许连发）。
  P.relocate(tl2, 30000);
  ok(P.advance(tl2, 1000, 30000) === null, 'seek 经 relocate 后不补发区间拍');

  const tl3 = P.createTimeline(makeMap([[1000, 0.5], [2000, 0.6]]));
  P.relocate(tl3, 5000);
  ok(P.advance(tl3, 5000, 6000) === null, '地图晚到/重定位后历史拍不补放');

  const tl4 = P.createTimeline(makeMap([[1000, 0.5], [1500, 0.6], [2000, 0.7]]));
  P.advance(tl4, 0, 1600);
  ok(P.advance(tl4, 1600, 900) === null, '倒退 seek 重定位且不补发');
  ok(P.advance(tl4, 900, 2010) && tl4.cursor >= 3, '重定位后未来拍仍可继续推进');
}

section('节拍包络');
{
  const down = { t: 1000, strength: 0.9, downbeat: true, intensity: 2 };
  const weak = { t: 1000, strength: 0.95, downbeat: false, intensity: 1 };
  const weakSoft = { t: 1000, strength: 0.5, downbeat: false, intensity: 1 };

  const e0 = P.envelope(down, 990, 1, {});
  ok(e0.fovMul === 1 && e0.distMul === 1 && e0.rollDeg === 0, '拍前是单位元');
  const attack = P.envelope(down, 1028, 1, { punch: 1 });
  ok(approx(attack.fovMul, 0.94, 0.0001), '强拍起振底 fov×0.94');
  ok(approx(attack.distMul, 0.975, 0.0001), '强拍 dist×0.975');
  ok(approx(attack.rollDeg, 1.2, 0.0001), '强拍 roll +1.2°');
  ok(P.envelope(down, 1028, -1, {}).rollDeg < 0, '相邻方向交替取负');
  const back = P.envelope(down, 1420, 1, {});
  ok(approx(back.fovMul, 1, 0.001) && approx(back.rollDeg, 0, 0.001), '收束段回到基线');

  const w = P.envelope(weak, 1028, 1, {});
  ok(approx(w.fovMul, 0.975, 0.0001), '普通拍 fov×0.975');
  ok(w.distMul === 1, '普通拍无 dist punch');
  ok(approx(w.rollDeg, 0.5, 0.0001), 'strength>0.8 普通拍带 ±0.5° roll');
  const ws = P.envelope(weakSoft, 1028, 1, {});
  ok(ws.rollDeg === 0, 'strength≤0.8 普通拍无 roll');

  const hot = P.envelope({ t: 1000, strength: 0.9, downbeat: true, intensity: 3 }, 1028, 1, {});
  ok(approx(hot.fovMul, 1 - 0.06 * 1.5, 0.0001), 'intensity 3 幅度 ×1.5');
  const tuned = P.envelope(down, 1028, 1, { punch: 0.5 });
  ok(approx(tuned.fovMul, 1 - 0.06 * 0.5, 0.0001), 'cinePunch 等比缩放');
  const tunnel = P.envelope(down, 1028, 1, { punch: 1, tunnel: true });
  ok(approx(tunnel.distMul, 1 - 0.025 * 0.5, 0.0001), 'tunnel 近机位 dist punch 折半');
  // 越界倍率（驱动缺陷的极端输入，UI 合法域 punch≤2）：roll 原始 27° 精确
  // 钳到 25，fov/dist 被 0.5 正下界兜住，画面不翻转。
  const wild = P.envelope({ t: 0, strength: 1, downbeat: true, intensity: 3 }, 28, 1, { punch: 15 });
  ok(wild.rollDeg === P.ROLL_LIMIT, 'roll 超幅时精确钳到 +25°');
  ok(wild.fovMul === 0.5 && wild.distMul === 0.5, 'fov/dist 有 0.5 正下界');
  const nanEnv = P.envelope(down, NaN, 1, {});
  ok(nanEnv.fovMul === 1 && nanEnv.distMul === 1 && nanEnv.rollDeg === 0, 'NaN 时间返回单位元');
  const negPunch = P.envelope(down, 1028, 1, { punch: -1 });
  ok(approx(negPunch.fovMul, 0.94, 0.0001), '负 punch 退回缺省倍率 1');
  const over = P.envelope(down, 1421, 1, {});
  ok(over.fovMul === 1 && over.distMul === 1 && over.rollDeg === 0, '超过 420ms 窗口是单位元');
}

section('边界：relocate 的 ±60ms 容差');
{
  // now=1000：now+60 的拍排除、now+61 的拍保留（lowerBound(now+61)）。
  const tl = P.createTimeline(makeMap([[1060, 0.5], [1061, 0.6]]));
  P.relocate(tl, 1000);
  const got = P.advance(tl, 1000, 1100);
  ok(got && got.t === 1061, '落点 +60ms 内不补、+61ms 保留');
}

section('跨文件契约：roll 通道');
{
  const gl = read('creative-gl.js');
  const stage = read('creative-stage.js');
  ok(/function rollView\b/.test(gl), 'creative-gl 定义 rollView');
  ok(/cam\.roll/.test(gl), 'render 相机段消费 cam.roll');
  ok(/addCamLayer/.test(stage) && /removeCamLayer/.test(stage), 'creative-stage 暴露层总线 API');
  ok(/var camLayers = \[\]/.test(stage), 'camLayers 模块状态存在');
  ok(/roll: ctx\.rollDeg \* Math\.PI \/ 180/.test(stage), 'ctx.rollDeg 以弧度进 cam.roll');
  ok(/ctx\.yawDeg[\s\S]*cam\.shakeYaw/.test(stage),
    'shake 在层结果之后最后叠加（单向顺序，不收反向）');
}

section('跨文件契约：驱动 / 协议 / 开关');
{
  const cinema = read('stage-cinema.js');
  const control = read('stage-control.js');
  const app = read('app.js');
  const main = fs.readFileSync(path.join(__dirname, '..', 'crates', 'vmusicd', 'src', 'main.rs'), 'utf8');
  const html = read('index.html');

  ok(cinema.indexOf("'absent'") >= 0 && cinema.indexOf("'waiting'") >= 0 && cinema.indexOf("'active'") >= 0,
    '三态 absent/waiting/active 存在');
  ok(/\/v1\/stage\/beatmap\?track=/.test(cinema), 'beatmap 请求 URL');
  ok(/addCamLayer\(layer, 10\)/.test(cinema), 'cinema 以 priority 10 注册');
  ok(/Stage\.tier\(\) === 0/.test(cinema), 'tier0 不请求/不驱动');
  ok(/stagecontrol:change/.test(cinema) && /detail/.test(cinema), '消费控制面板事件');
  ok(/v\.cinema|detail\.cinema/.test(cinema) && /cinePunch/.test(cinema) && /freecam/.test(cinema),
    'cine 三键被读取');
  ok(/setPeek/.test(cinema) && /0\.3/.test(cinema), 'peek 压制系数 0.3');
  ok(/baseDist < 5/.test(cinema), 'tunnel 判定基线 dist<5');

  ok(/id: 'cine'/.test(control), 'SCHEMA 含 cine 组');
  ok(/g\.id === 'cine'/.test(control), 'push 跳过 cine 组脏变量');
  ok(/case 'beatmap_ready'/.test(app), 'app.js 分发 beatmap_ready');
  ok(/StageCinema\.onTrack\(snap\.track_id\)/.test(app), '换曲钩子 onTrack');
  ok(/StageCinema\.onSnapshot\(snap\)/.test(app), '快照重锚钩子 onSnapshot');
  ok(/STAGE_CINEMA_JS/.test(main) && /stage-cinema\.js/.test(html), 'cinema 资源内嵌与页面引用');
}

console.log(`\n${failures === 0 ? 'OK' : 'FAIL'}: ${checks - failures}/${checks} 通过`);
process.exit(failures === 0 ? 0 : 1);
