// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 外观族的轻量点击反馈。与 anime-interactions.css 一起加载；不依赖主题或宿主 API。
(function (global) {
  'use strict';
  if (!global || !global.document || global.AnimeInteractions) return;

  var doc = global.document;
  var CONTROLS = 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], a.btn, a.iconbtn, a.btn-pill';
  var PARTICLES = 6;
  var MAX_BURSTS = 3;
  var DURATION = 280;
  var MIN_GAP = 90;
  // 外观族名单，与 anime-interactions.css 的选择器是同一份。
  // 这里判**族**而不是判主题 id：族是"这套外观有没有星屑反馈"的唯一真值，
  // 新加的主题只要声明 look 就自动获得，不必回来改这个文件。
  var LOOKS = ['glass', 'cel'];
  var started = false, waiting = false;
  var layer = null, observer = null;
  var bursts = [];
  var lastBurstAt = -Infinity;
  var motionQuery = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : null;

  function enabled() {
    var html = doc.documentElement, body = doc.body;
    if (!started || !body || doc.hidden) return false;
    if (LOOKS.indexOf(html.getAttribute('data-look')) < 0) return false;
    if (motionQuery && motionQuery.matches) return false;
    if (body.classList.contains('reduce-motion')) return false;
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
    // data-look 与 data-theme 都要看：换族（glass ↔ cel）而 id 不变时，
    // 只监听 data-theme 会漏掉，那套新外观于是接着放上一族的粒子。
    for (var i = 0; i < records.length; i += 1) {
      var name = records[i].attributeName;
      if (name === 'data-theme' || name === 'data-look') { clear(); break; }
    }
    sync();
  }

  function createBurst(x, y) {
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
    node.style.left = x + 'px';
    node.style.top = y + 'px';
    var burst = { node: node, timer: null, done: false, onEnd: null };
    burst.onEnd = function (event) {
      if (event.animationName !== 'anime-button-spark' || event.target.parentNode !== node) return;
      event.target.remove();
      if (!node.firstElementChild) removeBurst(burst);
    };
    node.addEventListener('animationend', burst.onEnd);
    node.addEventListener('animationcancel', burst.onEnd);
    var phase = Math.random() * Math.PI * 2;
    for (var i = 0; i < PARTICLES; i += 1) {
      var particle = doc.createElement('span');
      var angle = phase + i * Math.PI * 2 / PARTICLES;
      var distance = 15 + Math.random() * 17;
      particle.className = 'anime-interactions-particle';
      particle.style.setProperty('--anime-spark-x', (Math.cos(angle) * distance).toFixed(2) + 'px');
      particle.style.setProperty('--anime-spark-y', (Math.sin(angle) * distance - 5).toFixed(2) + 'px');
      node.appendChild(particle);
    }
    bursts.push(burst);
    layer.appendChild(node);
    // 动画被外部样式移除或浏览器不派发结束事件时，也有有界的清理兜底。
    burst.timer = global.setTimeout(function () { removeBurst(burst); }, DURATION + 100);
  }

  function onClick(event) {
    if (!enabled() || event.button != null && event.button !== 0) return;
    var target = event.target;
    if (target && target.nodeType !== 1) target = target.parentElement;
    var control = target && target.closest ? target.closest(CONTROLS) : null;
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
    createBurst(x, y);
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
      observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-look', 'data-rm', 'inert'] });
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
