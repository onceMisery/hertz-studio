// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 点击反馈引擎。与 anime-interactions.css 一起加载；不依赖主题或宿主 API。
//
// 特效**归主题声明**：themes.js 的 fx 字段落到 <html data-fx>，这里按注册表
// 出粒子（数量 / 距离 / 方向锥 / 错峰 / 时长），形状与配色全在 CSS 的原型里
// （html[data-fx="…"] 选择器，颜色走令牌）。本文件只管"在哪里、几点、放几颗"，
// 不认识任何主题 id——新加主题只要在目录里声明 fx 就自动获得特效。
(function (global) {
  'use strict';
  if (!global || !global.document || global.AnimeInteractions) return;

  var doc = global.document;
  var CONTROLS = 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], a.btn, a.iconbtn, a.btn-pill';
  var MAX_BURSTS = 3;
  var MIN_GAP = 90;
  var FX_ATTR = 'data-fx';
  // 特效原型注册表。键与 anime-interactions.css 的 html[data-fx="…"] 是同一份
  // 名单；CSS 管长相，这里管运动学：
  //   count    粒子数；0 = 不放粒子，圆环/光晕画在 burst 节点本身上
  //   dist     距离区间 px（全圆匀布时也逐粒随机）
  //   lift     端点上抬 px（负值 = 下坠；keyframe 之外唯一的"重力"入口）
  //   angle    方向锥 [朝向°, 扇开°]（90 = 向下，-90 = 向上）；null = 全圆匀布
  //   stagger  错峰上限 ms（0 = 同时出发）
  //   duration 最长动画 ms；也是清理兜底定时器的基准
  var EFFECTS = {
    stardust: { count: 6,  dist: [15, 32], lift: 5,   angle: null,       stagger: 0,   duration: 280 },
    shard:    { count: 7,  dist: [18, 34], lift: 0,   angle: null,       stagger: 0,   duration: 240 },
    comet:    { count: 7,  dist: [24, 42], lift: 16,  angle: [-90, 76],  stagger: 40,  duration: 380 },
    ember:    { count: 8,  dist: [10, 24], lift: 30,  angle: [-90, 60],  stagger: 140, duration: 560 },
    nova:     { count: 7,  dist: [6, 18],  lift: 0,   angle: null,       stagger: 80,  duration: 440 },
    firework: { count: 10, dist: [20, 38], lift: -8,  angle: null,       stagger: 70,  duration: 460 },
    warp:     { count: 8,  dist: [26, 48], lift: 0,   angle: null,       stagger: 0,   duration: 230 },
    glint:    { count: 6,  dist: [10, 24], lift: 0,   angle: null,       stagger: 100, duration: 480 },
    pixel:    { count: 7,  dist: [14, 30], lift: 0,   angle: null,       stagger: 0,   duration: 320 },
    petal:    { count: 7,  dist: [18, 36], lift: -12, angle: [90, 110],  stagger: 80,  duration: 660 },
    burst:    { count: 8,  dist: [22, 40], lift: 0,   angle: null,       stagger: 0,   duration: 220 },
    ink:      { count: 6,  dist: [4, 16],  lift: 0,   angle: null,       stagger: 90,  duration: 520 },
    firefly:  { count: 6,  dist: [18, 34], lift: 8,   angle: null,       stagger: 160, duration: 780 },
    glaze:    { count: 7,  dist: [14, 30], lift: 0,   angle: null,       stagger: 60,  duration: 500 },
    snow:     { count: 8,  dist: [12, 28], lift: -20, angle: [90, 56],   stagger: 130, duration: 740 },
    glitch:   { count: 7,  dist: [10, 26], lift: 0,   angle: null,       stagger: 0,   duration: 340 },
    sand:     { count: 9,  dist: [8, 22],  lift: -16, angle: [90, 68],   stagger: 110, duration: 620 },
    bubble:   { count: 7,  dist: [10, 22], lift: 24,  angle: [-90, 52],  stagger: 120, duration: 700 },
    spark:    { count: 6,  dist: [14, 30], lift: 4,   angle: null,       stagger: 0,   duration: 300 },
    // 单节点原型：粒子数为 0，圆环/光晕直接画在 burst 节点上（见 CSS）。
    ripple:   { count: 0, dist: [0, 0], lift: 0, angle: null, stagger: 0, duration: 420 },
    halo:     { count: 0, dist: [0, 0], lift: 0, angle: null, stagger: 0, duration: 480 },
    neon:     { count: 0, dist: [0, 0], lift: 0, angle: null, stagger: 0, duration: 460 },
    pill:     { count: 0, dist: [0, 0], lift: 0, angle: null, stagger: 0, duration: 360 },
    tide:     { count: 0, dist: [0, 0], lift: 0, angle: null, stagger: 0, duration: 520 },
    // 暖白：纸屑轻扬（与 spark 一样是多粒子原型）。
    paper:    { count: 7,  dist: [16, 34], lift: 4,   angle: null,       stagger: 80,  duration: 520 }
  };

  var started = false, waiting = false;
  var layer = null, observer = null;
  var bursts = [];
  var lastBurstAt = -Infinity;
  var motionQuery = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : null;

  function effect() {
    if (!started) return null;
    var name = doc.documentElement.getAttribute(FX_ATTR);
    return (name && EFFECTS[name]) || null;
  }

  function enabled() {
    var body = doc.body;
    if (!body || doc.hidden || !effect()) return false;
    if (motionQuery && motionQuery.matches) return false;
    if (body.classList.contains('reduce-motion')) return false;
    var html = doc.documentElement;
    return !html.matches('[data-rm~="ui"], [inert]') && !body.matches('[data-rm~="ui"], [inert]');
  }

  function removeBurst(burst) {
    if (burst.done) return;
    burst.done = true;
    global.clearTimeout(burst.timer);
    burst.node.removeEventListener('animationend', burst.onEnd);
    burst.node.removeEventListener('animationcancel', burst.onEnd);
    burst.node.remove();
    var index = bursts.indexOf(burst);
    if (index >= 0) bursts.splice(index, 1);
    if (!bursts.length && layer) { layer.remove(); layer = null; }
  }

  function clear() {
    bursts.slice().forEach(removeBurst);
    lastBurstAt = -Infinity;
  }

  function sync() { if (!enabled()) clear(); }

  function onAttributes(records) {
    // 主题重选也终止旧反馈；只观察 html/body 的少数属性，不扫描业务 DOM。
    // data-theme 与 data-fx 都要看：同 id 换配色（自定义配色改色重登记）或
    // 换 fx 声明时，旧粒子不该带着新主题的颜色继续飘。
    for (var i = 0; i < records.length; i += 1) {
      var name = records[i].attributeName;
      if (name === 'data-theme' || name === FX_ATTR) { clear(); break; }
    }
    sync();
  }

  function createBurst(x, y, cfg, control) {
    var host = doc.fullscreenElement || doc.body;
    if (layer && layer.parentNode !== host) clear();
    while (bursts.length >= MAX_BURSTS) removeBurst(bursts[0]);
    if (!layer) {
      layer = doc.createElement('div');
      layer.className = 'anime-interactions-layer';
      layer.setAttribute('aria-hidden', 'true');
      // 样式尚未到达时也不占布局、不挡输入。
      // 反馈层在现有录制浮条（400）之上，始终不参与命中。
      layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:410;';
      host.appendChild(layer);
    }
    var node = doc.createElement('div');
    node.className = 'anime-interactions-burst';
    // 只记「这一击落在哪个界面区」，放大多少由 CSS 的原型决定（特效长相归 CSS）。
    // 舞台是全屏暗底、控件是 44px 的圆牌，同一份细碎粒子在那儿等于没放。
    var zone = control && control.closest ? control.closest('[data-fx-zone]') : null;
    if (zone && zone.dataset.fxZone) node.className += ' fx-' + zone.dataset.fxZone;
    node.style.left = x + 'px';
    node.style.top = y + 'px';
    var burst = { node: node, timer: null, done: false, onEnd: null };
    burst.onEnd = function (event) {
      // 节点级原型（count 0）动画结束即收场；粒子级先收粒子，
      // 收完最后一个再拆 burst。层内只有本引擎的动画，不必按名过滤。
      if (event.target === node) { removeBurst(burst); return; }
      if (event.target.parentNode !== node) return;
      event.target.remove();
      if (!node.firstElementChild) removeBurst(burst);
    };
    node.addEventListener('animationend', burst.onEnd);
    node.addEventListener('animationcancel', burst.onEnd);
    var phase = Math.random() * Math.PI * 2;
    for (var i = 0; i < cfg.count; i += 1) {
      var particle = doc.createElement('span');
      var angle;
      if (cfg.angle) {
        angle = (cfg.angle[0] + (Math.random() - 0.5) * cfg.angle[1]) * Math.PI / 180;
      } else {
        angle = phase + i * Math.PI * 2 / cfg.count;
      }
      var distance = cfg.dist[0] + Math.random() * (cfg.dist[1] - cfg.dist[0]);
      particle.className = 'anime-interactions-particle';
      particle.style.setProperty('--anime-spark-x', (Math.cos(angle) * distance).toFixed(2) + 'px');
      particle.style.setProperty('--anime-spark-y', (Math.sin(angle) * distance - cfg.lift).toFixed(2) + 'px');
      // 径向原型的两个补充量：m = 行程模长（rotate 对准后再 translateY），
      // a = 行程方向角 +90°（让"竖条向上"对齐到实际飞行方向）。
      particle.style.setProperty('--anime-spark-m', distance.toFixed(2) + 'px');
      particle.style.setProperty('--anime-spark-a', (angle * 180 / Math.PI + 90).toFixed(1) + 'deg');
      particle.style.setProperty('--anime-spark-d', Math.round(Math.random() * cfg.stagger) + 'ms');
      // 逐粒随机姿态角，给花瓣/瓷片/碎片这类"会转"的原型用；不转的原型不读它。
      particle.style.setProperty('--anime-spark-r', Math.round(Math.random() * 120 - 60) + 'deg');
      node.appendChild(particle);
    }
    bursts.push(burst);
    layer.appendChild(node);
    // 动画被外部样式移除或浏览器不派发结束事件时，也有有界的清理兜底。
    burst.timer = global.setTimeout(function () { removeBurst(burst); }, cfg.duration + cfg.stagger + 120);
  }

  function onClick(event) {
    if (!enabled() || event.button != null && event.button !== 0) return;
    var target = event.target;
    if (target && target.nodeType !== 1) target = target.parentElement;
    var control = target && target.closest ? target.closest(CONTROLS) : null;
    if (control && control.getAttribute('data-click-feedback') === 'custom') return;
    if (!control || !control.isConnected || control.matches(':disabled, [disabled]')
        || control.closest('[inert], [hidden], [aria-disabled="true"], .is-disabled')) return;
    var time = global.performance && global.performance.now ? global.performance.now() : Date.now();
    if (time - lastBurstAt < MIN_GAP) return;
    var rect = control.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || global.getComputedStyle(control).visibility !== 'visible') return;
    // 原生键盘激活和 .click() 的 detail 为 0；只画反馈，不合成第二次业务点击。
    var pointer = event.detail > 0 && event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
    var x = pointer ? event.clientX : rect.left + rect.width / 2;
    var y = pointer ? event.clientY : rect.top + rect.height / 2;
    lastBurstAt = time;
    createBurst(x, y, effect(), control);
  }

  function onReady() { waiting = false; init(); }

  function init() {
    if (started) return;
    if (!doc.body) {
      if (!waiting) { doc.addEventListener('DOMContentLoaded', onReady, { once: true }); waiting = true; }
      return;
    }
    doc.removeEventListener('DOMContentLoaded', onReady);
    waiting = false;
    started = true;
    // 捕获阶段也能看到业务模块 stopPropagation 的按钮；passive 保证不取消默认行为。
    doc.addEventListener('click', onClick, { capture: true, passive: true });
    doc.addEventListener('visibilitychange', sync);
    doc.addEventListener('fullscreenchange', clear);
    global.addEventListener('pagehide', clear);
    if (global.MutationObserver) {
      observer = new global.MutationObserver(onAttributes);
      observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme', FX_ATTR, 'data-rm', 'inert'] });
      observer.observe(doc.body, { attributes: true, attributeFilter: ['class', 'data-rm', 'inert'] });
    }
    if (motionQuery) {
      if (motionQuery.addEventListener) motionQuery.addEventListener('change', sync);
      else if (motionQuery.addListener) motionQuery.addListener(sync);
    }
  }

  function destroy() {
    doc.removeEventListener('DOMContentLoaded', onReady);
    waiting = false;
    started = false;
    clear();
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('visibilitychange', sync);
    doc.removeEventListener('fullscreenchange', clear);
    global.removeEventListener('pagehide', clear);
    if (observer) { observer.disconnect(); observer = null; }
    if (motionQuery) {
      if (motionQuery.removeEventListener) motionQuery.removeEventListener('change', sync);
      else if (motionQuery.removeListener) motionQuery.removeListener(sync);
    }
  }

  global.AnimeInteractions = { init: init, clear: clear, destroy: destroy };
  init();
})(typeof window !== 'undefined' ? window : null);
