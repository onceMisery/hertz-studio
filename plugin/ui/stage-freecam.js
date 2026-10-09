// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 自由相机：cine.freecam 开关开启期间接管全部 5 个场景的相机——
// WASD(+Shift) 水平面平移、画布 click 指针锁定环视（拒绝则按住拖拽回落）、
// Q/E 滚转、K 回正、Esc 退出；关闭时 600ms inout 飞回导演/电影机位。
// 机位存独立 localStorage 键，仅在进入自由模式时恢复，不跨曲自动应用。

(function (global) {
  'use strict';

  // Node（无头契约扫描）下早退：不触碰 document/localStorage，纯文本扫描不受影响。
  if (typeof window === 'undefined') return;

  var POSE_KEY = 'vmusic.stage.freecam.pose';
  var MOVE_SPEED = 0.35;         // ×cam.dist/秒
  var SHIFT_MUL = 2;
  var LOOK_YAW = 0.14;           // 度/px（creative-stage 拖拽 0.28 的一半）
  var LOOK_PITCH = 0.11;         // 度/px（拖拽 0.22 的一半）
  var PITCH_LIMIT = 77;          // 度，与合成端 ±1.35rad 对齐
  var ROLL_SPEED = 40;           // 度/秒
  var ROLL_LIMIT = 25;
  var RETURN_MS = 600;
  var ROLL_RETURN_MS = 260;

  var inited = false;
  var enabled = false;
  var pose = null;               // {yawDeg,pitchDeg,dist,tx,tz,rollDeg}
  var returning = null;          // {start, from}
  var rollBack = null;           // {start, from}
  var keys = {};
  // 移动键显式集合：keys 只保存按下状态。判定必须查 MOVE_CODES，
  // 不能写 hasOwnProperty(keys, code)——空表永不命中，WASD 会整体失效。
  var MOVE_CODES = {
    KeyW: 1, KeyA: 1, KeyS: 1, KeyD: 1,
    KeyQ: 1, KeyE: 1, ShiftLeft: 1, ShiftRight: 1
  };
  var locked = false;
  var dragging = false;
  var pid = null;               // 拖拽中指针 id：多指触摸只认落下的第一指
  var lastX = 0, lastY = 0;
  var lastT = 0;

  function now() { return global.performance && performance.now ? performance.now() : Date.now(); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function easeInOut(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }
  // 角度折回 (-180,180]：飞回 yaw 永远走最短弧，积累多圈时不会原地倒转。
  function wrap180(v) { v = ((v + 180) % 360 + 360) % 360 - 180; return v; }
  function tier0() { return !!(global.Stage && Stage.tier && Stage.tier() === 0); }
  function stageEl() { return document.getElementById('stage'); }
  function reducedMotion() {
    return !!(global.Stage && Stage.presentation && Stage.presentation().reduced) ||
      !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function loadPose() {
    try {
      var p = JSON.parse(localStorage.getItem(POSE_KEY) || 'null');
      // 存储可能被外部写残（缺字段/类型错/NaN/Infinity）：逐项补全，任何非有限值都不进相机。
      if (p && typeof p.yawDeg === 'number' && isFinite(p.yawDeg)) {
        var num = function (v, d) { return typeof v === 'number' && isFinite(v) ? v : d; };
        var d = num(p.dist, 6);
        return {
          yawDeg: p.yawDeg,
          pitchDeg: num(p.pitchDeg, 0),
          dist: d < 0.3 ? 0.3 : (d > 100 ? 100 : d),
          tx: num(p.tx, 0),
          tz: num(p.tz, 0),
          rollDeg: num(p.rollDeg, 0)
        };
      }
    } catch (e) { /* 隐私模式：会话内 pose 变量兜底 */ }
    return null;
  }
  function savePose() {
    if (!pose) return;
    try { localStorage.setItem(POSE_KEY, JSON.stringify(pose)); } catch (e) { /* 同上 */ }
  }

  function syncControl(on) {
    if (global.StageControl && StageControl.set) StageControl.set({ freecam: !!on });
  }
  function updateSwitchVisibility() {
    var sw = document.getElementById('sc-cine-freecam');
    if (sw) sw.style.display = tier0() ? 'none' : '';
  }

  function releaseLock() {
    try {
      if (document.pointerLockElement === stageEl()) document.exitPointerLock();
    } catch (e) { /* 老浏览器无此 API */ }
    locked = false;
  }

  function setEnabled(on, fromEvent) {
    on = !!on;
    if (on) {
      if (enabled) return;
      if (tier0()) {
        // 探针落锤前用户点了开关：把面板拨回 false 并隐藏，杜绝卡在 ON。
        syncControl(false);
        updateSwitchVisibility();
        return;
      }
      enabled = true;
      returning = null;
      rollBack = null;
      keys = {};
      dragging = false;
      pid = null;
      if (!pose) pose = loadPose();   // 首帧层回调还会用基线兜底
      if (global.StageCinema) StageCinema.setFreecam(true);
      addDomListeners();
      if (!fromEvent) syncControl(true);
      updateSwitchVisibility();
      return;
    }
    if (!enabled) { if (!fromEvent) syncControl(false); return; }
    enabled = false;
    keys = {};
    dragging = false;
    pid = null;
    releaseLock();
    if (global.StageCinema) StageCinema.setFreecam(false);
    removeDomListeners();
    // 600ms inout 飞回；终点在层里逐帧取最新基线（飞回期间导演可能在动）。
    if (pose && !reducedMotion()) returning = { start: now(), from: {
      yawDeg: pose.yawDeg, pitchDeg: pose.pitchDeg, dist: pose.dist,
      tx: pose.tx, tz: pose.tz, rollDeg: pose.rollDeg
    } };
    savePose();
    if (!fromEvent) syncControl(false);
    updateSwitchVisibility();
  }

  function reset() {
    // 舞台恢复默认会卸载创意帧门，不能等待关闭动画来归还相机。
    enabled = false;
    pose = null;
    returning = null;
    rollBack = null;
    keys = {};
    dragging = false;
    pid = null;
    lastX = lastY = lastT = 0;
    releaseLock();
    removeDomListeners();
    if (global.StageCinema) StageCinema.setFreecam(false);
    syncControl(false);
    updateSwitchVisibility();
    // 清除失败交给调用方报告，不能把仍会恢复的旧机位宣称为已重置。
    localStorage.removeItem(POSE_KEY);
  }

  function typingTarget(e) {
    var t = e.target;
    return t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(t.tagName || ''));
  }

  function onKeyDown(e) {
    if (!enabled || document.hidden || typingTarget(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (MOVE_CODES[e.code]) {
      keys[e.code] = true;
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyK') {
      if (pose) {
        if (reducedMotion()) { pose.rollDeg = 0; rollBack = null; }
        else rollBack = { start: now(), from: pose.rollDeg };
      }
      e.preventDefault();
    } else if (e.code === 'Escape') {
      setEnabled(false, false);
    }
  }
  function onKeyUp(e) { if (MOVE_CODES[e.code]) keys[e.code] = false; }
  // 窗口失焦（Alt-Tab/切桌面）时 keyup 会丢：清空按键与拖拽，回来不会自己继续走。
  function onBlur() { keys = {}; dragging = false; pid = null; lastT = 0; releaseLock(); }
  function onVisibilityChange() { if (document.hidden) onBlur(); }
  function onFocusIn(e) { if (typingTarget(e)) onBlur(); }

  function onPointerDown(e) {
    if (!enabled || document.hidden || dragging) return;
    if (e.target && e.target.closest && e.target.closest('button, a, input, select, textarea, [contenteditable], .stage-lyrics, .lp-body')) return;
    if (e.isPrimary === false) return;
    if (e.button !== 0) return;
    dragging = true;
    pid = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    // 用户手势里申请指针锁定；被拒绝（权限策略/非安全上下文）也没关系，
    // 按住拖拽（pointermove 回落分支）始终可用。
    var el = stageEl();
    if (e.pointerType === 'mouse' && el && el.requestPointerLock && !document.pointerLockElement) {
      try {
        var r = el.requestPointerLock();
        if (r && r.catch) r.catch(function () { locked = false; });
      } catch (err) { locked = false; }
    }
  }
  function onPointerUp(e) {
    if (e.pointerId !== pid) return;
    dragging = false;
    pid = null;
  }
  function onMouseMove(e) {
    if (!enabled || !pose || document.hidden) return;
    if (locked && typeof e.movementX === 'number') {
      pose.yawDeg -= e.movementX * LOOK_YAW;
      pose.pitchDeg = clamp(pose.pitchDeg + e.movementY * LOOK_PITCH, -PITCH_LIMIT, PITCH_LIMIT);
    } else if (dragging && (e.pointerId == null || e.pointerId === pid)) {
      var dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      pose.yawDeg -= dx * LOOK_YAW;
      pose.pitchDeg = clamp(pose.pitchDeg + dy * LOOK_PITCH, -PITCH_LIMIT, PITCH_LIMIT);
    }
  }
  function onLockChange() {
    var el = stageEl();
    locked = !!(el && document.pointerLockElement === el);
    if (locked && (!enabled || document.hidden)) releaseLock();
    if (!locked) { keys = {}; dragging = false; pid = null; }
  }
  function onLockError() { locked = false; }

  function addDomListeners() {
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('pointermove', onMouseMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('pointerlockchange', onLockChange);
    document.addEventListener('pointerlockerror', onLockError);
    window.addEventListener('blur', onBlur);
    var el = stageEl();
    if (el) {
      el.addEventListener('pointerdown', onPointerDown);
    }
  }
  function removeDomListeners() {
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('pointermove', onMouseMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerUp);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.removeEventListener('focusin', onFocusIn);
    document.removeEventListener('pointerlockchange', onLockChange);
    document.removeEventListener('pointerlockerror', onLockError);
    window.removeEventListener('blur', onBlur);
    var el = stageEl();
    if (el) {
      el.removeEventListener('pointerdown', onPointerDown);
    }
  }

  function writePoseToCtx(ctx) {
    ctx.yawDeg = pose.yawDeg;
    ctx.pitchDeg = clamp(pose.pitchDeg, -PITCH_LIMIT, PITCH_LIMIT);
    ctx.dist = Math.max(0.3, pose.dist);
    ctx.tx = pose.tx;
    ctx.tz = pose.tz;
    ctx.ty = ctx.baseHeight;
    ctx.rollDeg = clamp(pose.rollDeg, -ROLL_LIMIT, ROLL_LIMIT);
    ctx.fov = ctx.baseFov;
    ctx.freecam = true;
  }

  function layer(ctx) {
    if (document.hidden) { lastT = 0; return; }
    var dt = lastT ? Math.min(100, ctx.t - lastT) : 16;
    lastT = ctx.t;

    if (returning) {
      if (reducedMotion()) { returning = null; return; }
      var k = clamp((ctx.t - returning.start) / RETURN_MS, 0, 1);
      var e = easeInOut(k);
      var f = returning.from;
      var fromYaw = ctx.baseYawDeg + wrap180(f.yawDeg - ctx.baseYawDeg);
      ctx.yawDeg = lerp(fromYaw, ctx.baseYawDeg, e);
      ctx.pitchDeg = lerp(f.pitchDeg, ctx.basePitchDeg, e);
      ctx.dist = lerp(f.dist, ctx.baseDist, e);
      ctx.tx = lerp(f.tx, 0, e);
      ctx.tz = lerp(f.tz, 0, e);
      ctx.rollDeg = lerp(f.rollDeg, 0, e);
      ctx.ty = ctx.baseHeight;
      ctx.fov = ctx.baseFov;
      ctx.freecam = true;
      ctx.driftMul = 0;
      if (k >= 1) returning = null;
      return;
    }
    if (!enabled) return;

    ctx.driftMul = 0;
    ctx.freecam = true;
    if (!pose) {
      pose = {
        yawDeg: ctx.baseYawDeg, pitchDeg: ctx.basePitchDeg, dist: ctx.baseDist,
        tx: 0, tz: 0, rollDeg: 0
      };
    }

    // Q/E 滚转（K 回正进行中不叠加）。
    var rollV = (keys.KeyE ? 1 : 0) - (keys.KeyQ ? 1 : 0);
    if (rollV !== 0) {
      rollBack = null;
      pose.rollDeg = clamp(pose.rollDeg + rollV * ROLL_SPEED * dt / 1000, -ROLL_LIMIT, ROLL_LIMIT);
    } else if (rollBack) {
      var rk = clamp((ctx.t - rollBack.start) / ROLL_RETURN_MS, 0, 1);
      pose.rollDeg = lerp(rollBack.from, 0, easeInOut(rk));
      if (rk >= 1) rollBack = null;
    }

    // WASD：屏幕前向 = target-eye 水平向（eye 向量 x=sin(yaw)、z=cos(yaw)，
    // 与 creative-gl 一致），故 W 取其反方向 (-sin,-cos)。
    var speed = MOVE_SPEED * pose.dist * ((keys.ShiftLeft || keys.ShiftRight) ? SHIFT_MUL : 1) * dt / 1000;
    var yaw = pose.yawDeg * Math.PI / 180;
    var fx = -Math.sin(yaw), fz = -Math.cos(yaw);   // 屏幕前向 = target-eye 水平向
    var rx = Math.cos(yaw), rz = -Math.sin(yaw);
    var mx = 0, mz = 0;
    if (keys.KeyW) { mx += fx; mz += fz; }
    if (keys.KeyS) { mx -= fx; mz -= fz; }
    if (keys.KeyD) { mx += rx; mz += rz; }
    if (keys.KeyA) { mx -= rx; mz -= rz; }
    if (mx !== 0 || mz !== 0) {
      var ml = Math.hypot(mx, mz);
      pose.tx += (mx / ml) * speed;
      pose.tz += (mz / ml) * speed;
    }

    writePoseToCtx(ctx);
  }

  function init() {
    if (inited) return;
    inited = true;
    if (global.CreativeStage) {
      // camLayers：cinema=10 < focus=20 < freecam=30，priority 小者先执行。
      if (CreativeStage.addCamLayer) CreativeStage.addCamLayer(layer, 30);
      if (CreativeStage.setInteractionBlocker) {
        CreativeStage.setInteractionBlocker(function () { return enabled || !!returning; });
      }
    }
    document.addEventListener('stagecontrol:change', function (e) {
      if (e.detail && typeof e.detail.freecam === 'boolean') setEnabled(e.detail.freecam, true);
    });
    document.addEventListener('stage:fps', function (e) {
      if (e.detail && e.detail.lowfx) setEnabled(false, false);
      updateSwitchVisibility();
    });
    updateSwitchVisibility();
  }

  global.StageFreecam = {
    init: init,
    reset: reset,
    isEnabled: function () { return enabled; },
    // 含 600ms 飞回中：focus 等覆盖型模块据此避让交班跳切。
    isBusy: function () { return enabled || !!returning; },
    // 供 focus 等模块查询/联动。
    setEnabled: function (on) { setEnabled(!!on, false); }
  };
  init();
})(typeof window !== 'undefined' ? window : this);
