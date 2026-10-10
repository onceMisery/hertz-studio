// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 焦点跟拍（仅悬停 peek，不锁定）：
// 歌单架卡片 / 播放队列行 hover 120ms 确认 → 260ms out-cubic 飞到看台机位；
// 移出即取消并飞回当前模式机位。freecam 开启 / 触屏无 hover 时不响应；
// 只监听 mouseover/mouseout，不拦截点击与滚轮。

(function (global) {
  'use strict';
  if (typeof window === 'undefined') return;

  var HOVER_MS = 120;
  var FLIGHT_MS = 260;
  var SHELF_DIST_MUL = 0.55;
  var QUEUE_DIST_MUL = 0.8;
  // 歌单架固定方位（左前方 70°）+ 元素屏幕位置的小偏移；队列是左侧栏方位。
  var SHELF_YAW = 70, SHELF_YAW_SPAN = 18, SHELF_PITCH_BASE = 2, SHELF_PITCH_SPAN = 14;
  var QUEUE_YAW = -72, QUEUE_PITCH = 4;

  var inited = false;
  var hoverTimer = 0;
  var current = null;            // {el, kind:'shelf'|'queue'}
  var flight = null;             // {from, target, start, out, snapped}
  var lastBase = null;           // 最近一次非 peek 帧的基线机位

  function now() { return global.performance && performance.now ? performance.now() : Date.now(); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }
  // 角度折回 (-180,180]。用于把插值起点拉到终点的**最短弧**上。
  //
  // 为什么需要：yaw 是角度，179° 与 -179° 只差 2°，但裸 lerp 会算出
  // "从 179 走到 -179"是 358°，于是聚焦切换时镜头会绕远路转一整圈 ——
  // 视觉上就是"跨过 180° 时跳一下"。同一模块的 freecam 飞回路径早就有
  // 折回，唯独这里漏了，于是只有聚焦动画会跳。
  function wrap180(v) { v = ((v + 180) % 360 + 360) % 360 - 180; return v; }
  // isBusy 含开启与 600ms 飞回中：飞回期 peek 输出会被 freecam 层覆盖，
  // 等它结束再起，否则两层在同一帧交班时会跳切。
  function freecamBusy() {
    return !!(global.StageFreecam && (
      (StageFreecam.isBusy && StageFreecam.isBusy()) ||
      (!StageFreecam.isBusy && StageFreecam.isEnabled && StageFreecam.isEnabled())));
  }
  function tier0() { return !!(global.Stage && Stage.tier && Stage.tier() === 0); }
  // hover 能力会话内不变：惰性缓存，避免 document 级 mouseover 高频查 matchMedia。
  var hoverCapable = null;
  function touchDevice() {
    if (hoverCapable === null) {
      hoverCapable = !(global.matchMedia && matchMedia('(hover: none)').matches);
    }
    return !hoverCapable;
  }

  function targetFor(ref, kind) {
    var vw = global.innerWidth || 1, vh = global.innerHeight || 1;
    var r = ref.getBoundingClientRect();
    var nx = ((r.left + r.width / 2) - vw / 2) / (vw / 2);
    var ny = ((r.top + r.height / 2) - vh / 2) / (vh / 2);
    if (kind === 'shelf') {
      return {
        yawDeg: SHELF_YAW + nx * SHELF_YAW_SPAN,
        pitchDeg: SHELF_PITCH_BASE - ny * SHELF_PITCH_SPAN,
        distMul: SHELF_DIST_MUL
      };
    }
    return { yawDeg: QUEUE_YAW, pitchDeg: QUEUE_PITCH, distMul: QUEUE_DIST_MUL };
  }

  function beginPeek(ref) {
    if (!lastBase || freecamBusy() || touchDevice()) return false;
    flight = {
      el: ref.el,
      from: { yawDeg: lastBase.yawDeg, pitchDeg: lastBase.pitchDeg, dist: lastBase.dist },
      target: targetFor(ref.el, ref.kind),
      start: now(),
      out: false
    };
    if (global.StageCinema) StageCinema.setPeek(true);
    return true;
  }

  function cancelTimer() {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
  }

  function leavePeek() {
    // 进入回程：cinema 幅度立即恢复；回程起点与计时在 layer 的 out 首帧快照
    // （这里没有 ctx，拿不到当前机位）。
    if (flight && !flight.out) {
      flight.out = true;
      flight.snapped = false;
      if (global.StageCinema) StageCinema.setPeek(false);
    }
  }

  function onOver(e) {
    if (tier0() || touchDevice() || freecamBusy()) return;
    var card = e.target && e.target.closest ? e.target.closest('.shelf-card') : null;
    var row = null;
    if (!card && e.target && e.target.closest) row = e.target.closest('.q-row');
    var el = card || row;
    if (!el || el.hidden) return;
    var kind = card ? 'shelf' : 'queue';
    if (current && current.el === el) return;
    cancelTimer();
    current = { el: el, kind: kind };
    var ref = current;
    hoverTimer = setTimeout(function () {
      hoverTimer = 0;
      // 等待期间歌单架/队列可能被整体重渲染：节点已脱离 DOM 就放弃，
      // 否则会对一个 rect 全 0 的悬空卡片算出错误方位。
      if (current === ref && document.contains(ref.el) && beginPeek(ref)) { /* 已起 peek */ }
      else if (current === ref) current = null;
    }, HOVER_MS);
  }

  function onOut(e) {
    if (!current) return;
    var to = e.relatedTarget;
    if (to && current.el.contains && current.el.contains(to)) return;
    cancelTimer();
    current = null;
    leavePeek();
  }

  function layer(ctx) {
    // perfTier 0：立即取消进行中的 peek（spec §9），cinema/freecam 各有同级处理。
    if (tier0()) {
      cancelTimer();
      current = null;
      if (flight) {
        flight = null;
        if (global.StageCinema) StageCinema.setPeek(false);
      }
      return;
    }
    if (!flight) {
      lastBase = { yawDeg: ctx.baseYawDeg, pitchDeg: ctx.basePitchDeg, dist: ctx.baseDist };
      return;
    }
    if (freecamBusy()) {
      flight = null;
      if (global.StageCinema) StageCinema.setPeek(false);
      return;
    }
    // 悬停中元素被重渲染移除/隐藏（队列/歌单架整体重建不发 mouseout）：自动转回程。
    if (!flight.out && flight.el && (!document.contains(flight.el) || flight.el.hidden)) {
      flight.out = true;
      flight.snapped = false;
      if (global.StageCinema) StageCinema.setPeek(false);
    }
    // 回程起点只在 out 第一帧快照一次，取的是**上一帧 focus 实际输出**
    // （ctx 每帧从基线重建，直接读当帧 ctx 会从基线起跳、回程动画空跑成硬切）；
    // 时长重新计、k 基于固定 start，之后绝不再覆盖 from。
    if (flight.out && !flight.snapped) {
      if (flight.oy != null) {
        flight.from = { yawDeg: flight.oy, pitchDeg: flight.op, dist: flight.od };
      } else {
        flight.from = { yawDeg: ctx.yawDeg, pitchDeg: ctx.pitchDeg, dist: ctx.dist };
      }
      flight.start = ctx.t;
      flight.snapped = true;
    }
    var k = clamp((ctx.t - flight.start) / FLIGHT_MS, 0, 1);
    var e = easeOutCubic(k);
    var from = flight.from;
    var toYaw = flight.out ? ctx.baseYawDeg : flight.target.yawDeg;
    var toPitch = flight.out ? ctx.basePitchDeg : flight.target.pitchDeg;
    var toDist = flight.out ? ctx.baseDist : ctx.baseDist * flight.target.distMul;
    // yaw 走最短弧。179° 与 -179° 只差 2°，裸 lerp 却会插出 358° 的长途
    // 旋转 —— 这就是"跨过 180° 时跳动"的来源。
    //
    // 折的是**差值**而不是起点：`lerp(from, to, e)` 内部算的是
    // `(to - from) * e`，把差值折到 (-180,180] 就让行程恒 ≤180°。
    //
    // ⚠ 别再折起点一次（试过，会把效果抵消，行程又回到 358°）。
    // ⚠ 中间值会短暂越出 (-180,180]（如 179→-179 时经过 -181）：这是
    // **无害的**，别去"修正"。渲染走 sin/cos，而 sin(-181°)=sin(179°)、
    // cos 同理 —— 越界值与域内值渲染结果完全一致。而且它是每帧从
    // flight.from 重算的局部量：不回写 pose、不累积，flight.oy 回写的
    // 是插值**结果**，那个恒在域内。
    var yawDelta = wrap180(from.yawDeg - toYaw);
    ctx.yawDeg = lerp(toYaw + yawDelta, toYaw, e);
    ctx.pitchDeg = lerp(from.pitchDeg, toPitch, e);
    ctx.dist = Math.max(0.3, lerp(from.dist, toDist, e));
    ctx.tx = 0;
    ctx.tz = 0;
    ctx.rollDeg = 0;
    ctx.fov = ctx.baseFov;
    // 记录本帧实际输出，供下一帧（或回程首帧）取机位；标量原地写，无分配。
    flight.oy = ctx.yawDeg;
    flight.op = ctx.pitchDeg;
    flight.od = ctx.dist;
    // 只在回程完成时清 flight：去程到点后 k 钳在 1 持续输出看台机位
    // （鼠标停在卡片上期间一直保持），直到 mouseout 进入回程。无条件清空
    // 会让目标机位只保持一帧，并把 cinema 的 peek 衰减永久闩住。
    if (k >= 1 && flight.out) flight = null;
  }

  function init() {
    if (inited) return;
    inited = true;
    // camLayers：cinema=10 < focus=20 < freecam=30，数字直接写字面量以对齐
    // 无头契约（与 cinema/freecam 注册写法一致）。
    if (global.CreativeStage && CreativeStage.addCamLayer) {
      CreativeStage.addCamLayer(layer, 20);
    }
    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
  }

  global.StageFocus = {
    init: init,
    isPeeking: function () { return !!flight && !flight.out; }
  };
  init();
})(typeof window !== 'undefined' ? window : this);
