// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 锚定弹层的公共生命周期与定位（设计收敛 §6.5 / R3）。
//
// 收敛的是顶栏菜单族的共同骨架：搬出 .topbar 层叠上下文、hidden/aria/active
// 状态机、点外部收起、Escape/方向键/Home/End 漫游、resize 收起、topbar:popup
// 互斥广播，以及同一份「右对齐锚点、下方优先、放不下翻上去」的定位。
// 目前消费者：更多工具菜单（app.js）、界面皮肤菜单（skins.js）、主题色菜单的
// 定位（theme-picker.js）。
//
// 两种确有差异的形态不硬塞进这里：dialogs.js 的模态对话（inert 焦点归还/
// 全屏顶层承载），与 theme-picker 的多触发 listbox（随滚动重定位、Tab 收起、
// roving tabindex）——后者只复用 position，交互语义各自持有。
(function () {
  'use strict';

  var POPUP_EVENT = 'topbar:popup';

  // 右对齐锚点、下方优先、下方不够翻上去，四边留 8px。fallbackW 供菜单
  // 尚未完成布局时的首次定位兜底。
  function position(anchor, menu, fallbackW) {
    if (!anchor || !menu || menu.hidden) return;
    var r = anchor.getBoundingClientRect();
    var w = menu.offsetWidth || fallbackW || 0;
    var h = menu.offsetHeight || 0;
    var gap = 8;
    var pad = 8;
    var left = Math.max(pad, Math.min(r.right - w, window.innerWidth - w - pad));
    var top = r.bottom + gap;
    if (top + h > window.innerHeight - pad && r.top - h - gap >= pad) top = r.top - h - gap;
    top = Math.max(pad, Math.min(top, Math.max(pad, window.innerHeight - h - pad)));
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
  }

  // 互斥广播：触发钮的 click 都 stopPropagation，彼此的「点外部就关」收不到
  // 对方的按钮点击，两个面板会叠着开。约定 topbar:popup——谁开谁喊一声，
  // 其余弹层听见不是自己开的就收起。
  function broadcast(id) {
    try { document.dispatchEvent(new CustomEvent(POPUP_EVENT, { detail: { id: id } })); }
    catch (e) { /* 老浏览器没有 CustomEvent 构造器 */ }
  }

  // .topbar 是 relative + z-index + backdrop-filter 的层叠上下文，弹层写多高
  // 的 z-index 都出不去（舞台抽屉 fixed + z-index:58 会整块盖住，实测命中
  // #stage）。搬进 body 后就是根上下文里的 fixed 元素。
  function moveOutOfTopbar(menu) {
    if (menu && menu.parentNode !== document.body) document.body.appendChild(menu);
  }

  // 单触发锚定菜单的生命周期。options：
  //   id                topbar:popup 广播里的身份
  //   trigger / menu    触发按钮与弹层节点
  //   fallbackW         首次定位的宽度兜底
  //   getAnchor         可选：开层时解析实际锚点（嵌进「更多工具」的入口锚到 ⋮）
  //   itemSelector      键盘漫游的目标行（缺省 .menu-item）
  //   onOpen            开层钩子（皮肤菜单在此 render 并聚焦当前行）
  //   closeOnItemClick  点菜单项后收起并把焦点还给触发钮（「更多工具」语义）
  //   closeOnFocusOut   焦点离开弹层即收起
  function create(options) {
    if (!options || !options.id || !options.trigger || !options.menu) {
      throw new TypeError('锚定弹层需要 id、trigger 与 menu');
    }
    var trigger = options.trigger;
    var menu = options.menu;
    var open = false;
    moveOutOfTopbar(menu);

    function setOpen(next) {
      open = !!next;
      menu.hidden = !open;
      trigger.classList.toggle('active', open);
      trigger.setAttribute('aria-expanded', String(open));
      if (open) {
        if (typeof options.onOpen === 'function') options.onOpen();
        position(typeof options.getAnchor === 'function' ? options.getAnchor() : trigger, menu, options.fallbackW);
        broadcast(options.id);
      }
    }

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      setOpen(!open);
    });

    menu.addEventListener('click', function (e) {
      if (!options.closeOnItemClick) return;
      if (e.target.closest && e.target.closest(options.itemSelector || '.menu-item')) {
        setOpen(false);
        trigger.focus();
      }
    });

    // contains 而不是 ===：按钮里通常是 svg，点图标时 target 落在 svg 上。
    document.addEventListener('click', function (e) {
      if (open && !menu.contains(e.target) && !trigger.contains(e.target)) setOpen(false);
    });

    if (options.closeOnFocusOut) {
      menu.addEventListener('focusout', function (e) {
        if (open && !menu.contains(e.relatedTarget)) setOpen(false);
      });
    }

    // 搬出按钮的 relative 盒之后，位置是开层那一刻算的：窗口一变就作废，直接收。
    window.addEventListener('resize', function () {
      if (open) setOpen(false);
    });

    document.addEventListener(POPUP_EVENT, function (e) {
      if (e.detail && e.detail.id !== options.id && open) setOpen(false);
    });

    menu.addEventListener('keydown', function (e) {
      var rows = Array.prototype.slice.call(menu.querySelectorAll(options.itemSelector || '.menu-item'));
      if (!rows.length) return;
      var idx = rows.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        trigger.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        var next;
        if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = rows.length - 1;
        else next = idx < 0 ? 0 : idx + (e.key === 'ArrowDown' ? 1 : -1);
        if (next < 0) next = rows.length - 1;
        if (next >= rows.length) next = 0;
        rows[next].focus();
      }
    });

    return {
      setOpen: setOpen,
      open: function () { setOpen(true); },
      close: function () { setOpen(false); },
      toggle: function () { setOpen(!open); },
      isOpen: function () { return open; },
    };
  }

  window.HertzPopup = { create: create, position: position, broadcast: broadcast };
})();
