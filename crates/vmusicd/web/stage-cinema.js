// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 电影相机的纯时间轴：rAF 外推时钟、单调游标 / seek 重定位、一帧多拍取最强、
// 确定性节拍包络。不依赖 DOM/GL，Node 可直接 require（check-stage-cinema.js）。
// 浏览器侧的驱动 IIFE 在本文件后半段（任务 6 追加），消费这里导出的
// window.StageCinemaPure。

(function (global) {
  'use strict';

  var ROLL_LIMIT = 25;          // 度，与自由相机共享同一个物理上限
  var RELOCK_MS = 150;          // 本地外推与服务端位置漂移超过它就硬对齐
  var SEEK_TOL_MS = 60;         // seek 落点 ±60ms 内的拍不补发
  var ATTACK_MS = 28;           // 节拍起振
  var DOWN_FOV_MIN = 0.94;      // 强拍 fov 收缩底
  var DOWN_DIST_MIN = 0.975;    // 强拍 dist punch 底
  var DOWN_ROLL_MAX = 1.2;      // 强拍 roll 幅度（度）
  var DOWN_FOV_MS = 320;
  var DOWN_ROLL_MS = 420;
  var BEAT_FOV_MIN = 0.975;     // 普通拍 fov 收缩底
  var BEAT_FOV_MS = 140;
  var BEAT_ROLL_MAX = 0.5;
  var BEAT_ROLL_GATE = 0.8;     // 普通拍 strength 超过它才带 roll

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }

  function lowerBound(beats, t) {
    var lo = 0, hi = beats.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (beats[mid].t < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // 高精度播放时间：服务端 position_ms（约 30Hz）锚点 + 两次 rAF 间按
  // performance.now 外推（速率恒 1.0）。暂停时冻结在锚点。
  function createClock() {
    return { seeded: false, anchorPos: 0, anchorClock: 0, playing: false };
  }

  function pt(clock, clockMs) {
    if (!clock.seeded) return 0;
    return clock.playing ? clock.anchorPos + (clockMs - clock.anchorClock) : clock.anchorPos;
  }

  // 状态帧重锚。返回 true = 硬对齐（首帧 / seek / 漂移 >150ms），
  // 调用方要把拍游标重定位到新位置（历史拍不补发）。
  function reanchor(clock, posMs, clockMs, playing) {
    var hard = !clock.seeded || Math.abs(pt(clock, clockMs) - posMs) > RELOCK_MS;
    clock.anchorPos = posMs;
    clock.anchorClock = clockMs;
    clock.playing = !!playing;
    clock.seeded = true;
    return hard;
  }

  // 拍游标：cursor 是「下一个尚未消费的拍」在 beats 里的下标。
  // 前置条件：map.beats 按 t 非降序（服务端分析库保证；乱序会延迟/丢拍）。
  function createTimeline(map) { return { map: map, cursor: 0 }; }

  // 地图晚到 / 换曲 / seek：从 nowMs 之后开始，落点 ±60ms 内的拍不补放。
  function relocate(tl, nowMs) {
    tl.cursor = lowerBound(tl.map.beats, nowMs + SEEK_TOL_MS + 1);
  }

  // 消费 (prevPt, nowPt] 区间。正常推进返回区间内 strength 最大的一拍
  // （一帧多拍只取最强，长帧/seek 后不连发）；检测到倒退（>60ms）二分
  // 重定位并返回 null。
  function advance(tl, prevPt, nowPt) {
    var beats = tl.map.beats;
    if (nowPt < prevPt - SEEK_TOL_MS) {
      tl.cursor = lowerBound(beats, nowPt + SEEK_TOL_MS + 1);
      return null;
    }
    var i = tl.cursor;
    while (i < beats.length && beats[i].t <= prevPt) i += 1;
    var picked = null;
    while (i < beats.length && beats[i].t <= nowPt) {
      if (!picked || beats[i].strength > picked.strength) picked = beats[i];
      i += 1;
    }
    tl.cursor = i;
    return picked;
  }

  // 确定性包络。sign 为该拍的交替方向（调用方按下标奇偶给 ±1）；
  // params = { punch: 用户冲击强度倍率（已含 peek 压制）, tunnel: 是否近机位 }。
  // punch 定义域 [0,+∞)，UI（cinePunch 滑块 0–200%）实际只给 0..2；该域内
  // fovMul 最低约 0.82、distMul 不低于 0.93，画面安全。
  // 返回 { fovMul, distMul, rollDeg }，超出 [0,420]ms 窗口是单位元。
  function envelope(beat, nowMs, sign, params) {
    var identity = { fovMul: 1, distMul: 1, rollDeg: 0 };
    var dt = nowMs - beat.t;
    // !(dt >= 0) 同时挡住负值与 NaN：NaN 比较既不抛错也不进单位元分支，
    // 放行会产出全 NaN 相机矩阵——层总线的 try/catch 捕不到这种"坏而不崩"。
    if (!(dt >= 0) || dt > DOWN_ROLL_MS) return identity;
    var punch0 = params && params.punch != null ? params.punch : 1;
    var punch = isFinite(punch0) && punch0 >= 0 ? punch0 : 1;
    if (sign !== 1 && sign !== -1) sign = 1;
    var amp = punch * (beat.intensity === 3 ? 1.5 : 1);
    var strong = !!beat.downbeat;
    var fovMin = strong ? DOWN_FOV_MIN : BEAT_FOV_MIN;
    var fovLen = strong ? DOWN_FOV_MS : BEAT_FOV_MS;

    // 0..28ms 线性起振，之后 ease-out 回收（fov/dist 用 fovLen，roll 用自己的长度）。
    var attackK = dt <= ATTACK_MS ? dt / ATTACK_MS : 1;
    var eFov = dt <= ATTACK_MS ? 0 : easeOutCubic(clamp((dt - ATTACK_MS) / fovLen, 0, 1));
    // 0.5 正下界：驱动缺陷给出越界倍率时宁可少推镜头，也不能让负 fov/dist
    // 进投影矩阵造成绕序翻转（合法 punch 域内这两个钳制永不触发）。
    var out = {
      fovMul: Math.max(0.5, 1 - (1 - fovMin) * amp * attackK * (1 - eFov)),
      distMul: 1,
      rollDeg: 0
    };
    if (strong) {
      var tunnel = params && params.tunnel ? 0.5 : 1;
      out.distMul = Math.max(0.5, 1 - (1 - DOWN_DIST_MIN) * amp * tunnel * attackK * (1 - eFov));
      var eRoll = easeOutCubic(clamp((dt - ATTACK_MS) / DOWN_ROLL_MS, 0, 1));
      out.rollDeg = clamp(sign * DOWN_ROLL_MAX * amp * attackK * (1 - eRoll), -ROLL_LIMIT, ROLL_LIMIT);
    } else if (beat.strength > BEAT_ROLL_GATE) {
      var eBeat = easeOutCubic(clamp((dt - ATTACK_MS) / BEAT_FOV_MS, 0, 1));
      out.rollDeg = clamp(sign * BEAT_ROLL_MAX * amp * attackK * (1 - eBeat), -ROLL_LIMIT, ROLL_LIMIT);
    }
    return out;
  }

  var api = {
    ROLL_LIMIT: ROLL_LIMIT,
    SEEK_TOL_MS: SEEK_TOL_MS,
    createClock: createClock,
    pt: pt,
    reanchor: reanchor,
    createTimeline: createTimeline,
    relocate: relocate,
    advance: advance,
    envelope: envelope,
    lowerBound: lowerBound
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.StageCinemaPure = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
