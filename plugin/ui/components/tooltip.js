// 播放栏悬浮说明：原生 title 弹出慢（~1s）、样式不可控，密集的图标行里
// 用户根本等不到它。这里用同一份 title/aria-label 文本画一枚玻璃提示，
// hover 后 ~350ms 出现、立即跟随按钮定位；显示期间临时摘掉 title，
// 避免「自定义提示 + 原生提示」双弹，移开时原样还回去（动态改 title 的
// 按钮——如睡眠定时器——下次 hover 读到的仍是最新值）。
(function () {
  'use strict';
  var HOST_SEL = '#playback-bar';
  var TIP_SEL = '[title], [aria-label]';
  var SHOW_DELAY = 350;
  var tip = null, current = null, timer = 0;

  function ensure() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.className = 'ui-tooltip';
    tip.setAttribute('role', 'tooltip');
    tip.setAttribute('aria-hidden', 'true');
    tip.hidden = true;
    document.body.appendChild(tip);
    return tip;
  }

  function labelOf(el) {
    var text = el.getAttribute('title') || el.getAttribute('aria-label') || '';
    return text.trim();
  }

  function show(el) {
    var text = labelOf(el);
    if (!text) { current = null; return; }
    var node = ensure();
    node.textContent = text;
    node.hidden = false;
    node.classList.remove('is-in');
    // 先摆到 (0,0) 量尺寸，再定位到按钮上方；放不下时翻到按钮下方。
    node.style.left = '0px';
    node.style.top = '0px';
    var rect = el.getBoundingClientRect();
    var wide = node.offsetWidth, high = node.offsetHeight;
    var left = Math.round(rect.left + rect.width / 2 - wide / 2);
    left = Math.max(8, Math.min(left, window.innerWidth - wide - 8));
    var top = Math.round(rect.top - high - 8);
    if (top < 8) top = Math.round(rect.bottom + 8);
    node.style.left = left + 'px';
    node.style.top = top + 'px';
    node.classList.add('is-in');
    if (el.hasAttribute('title') && !el.dataset.uiTip) {
      el.dataset.uiTip = el.getAttribute('title');
      el.removeAttribute('title');
    }
    current = el;
  }

  function hide() {
    clearTimeout(timer);
    if (tip && tip.parentNode) {
      tip.classList.remove('is-in');
      tip.hidden = true;
    }
    if (current && current.dataset && current.dataset.uiTip) {
      current.setAttribute('title', current.dataset.uiTip);
      delete current.dataset.uiTip;
    }
    current = null;
  }

  function insideHost(el) {
    return !!(el && el.closest && el.closest(HOST_SEL));
  }

  document.addEventListener('mouseover', function (event) {
    var el = event.target.closest ? event.target.closest(TIP_SEL) : null;
    if (!insideHost(el) || el === current) return;
    hide();
    timer = setTimeout(function () { show(el); }, SHOW_DELAY);
  }, true);

  document.addEventListener('mouseout', function (event) {
    var el = event.target.closest ? event.target.closest(TIP_SEL) : null;
    if (!insideHost(el)) return;
    // 只在真正离开按钮时收起：在按钮内部移动（图标↔边距）不打断计时。
    if (el.contains(event.relatedTarget)) return;
    hide();
  }, true);

  document.addEventListener('focusin', function (event) {
    var el = event.target.closest ? event.target.closest(TIP_SEL) : null;
    if (!insideHost(el)) return;
    hide();
    show(el);
  }, true);

  document.addEventListener('focusout', function (event) {
    var el = event.target.closest ? event.target.closest(TIP_SEL) : null;
    if (insideHost(el)) hide();
  }, true);

  window.addEventListener('blur', hide);
  document.addEventListener('wheel', hide, { passive: true, capture: true });
})();
