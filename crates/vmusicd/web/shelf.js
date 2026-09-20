// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 3D 歌单架：把歌单集合摊成一排可以拨的立体卡片。
//
// 这一层只做表现，不碰任何接口：歌单数据由 app.js 直接喂给 setItems，
// 封面解析走共享的 PlaylistCovers（列表行也用它），用户意图由
// shelf:change / shelf:action 事件发出去。和 stage.js / stage-control.js
// 是同一套分工，所以这里出现不了第二个 fetch 封装、第二份 token 处理。
//
// 为什么用 CSS 3D 而不是 canvas/WebGL：
//   · 不引依赖，也不需要在没有打包器的页面里手工 vendor 一个渲染库；
//   · 卡片内容是文字 + 图片，DOM 天生就把换行、省略号、字体、焦点和
//     屏幕阅读器都做对了，换成 canvas 全要重写一遍；
//   · 位移/旋转/缩放/透明度交给 CSS transition 之后，**静止时一帧都不用画**。
//     逐帧插值只在 center 变化那一刻发生，而那是用户操作触发的。
//     这是本项目里唯一一处"不写 rAF 反而更流畅"的地方。
//
// 每帧循环里唯一持续运行的东西是 CSS 的关键字动画（idle 浮动），
// 它跑在合成线程上，不占主线程。

(function () {
  'use strict';

  var R = 3;                  // 中心两侧各几张卡 —— 一共 2R+1 个 DOM 节点
  var SLOTS = R * 2 + 1;
  var WHEEL_STEP = 53;        // 一个滚轮刻度的 deltaY，累计到这一步长才走一格

  var api = null;
  var host = null;            // .shelf-stage
  var detail = null;          // 焦点歌单的详情条
  var slots = [];             // [{ el, art, name, count, bound }]
  var items = [];
  var center = 0;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function $(id) { return document.getElementById(id); }

  function slotFor(i) { return center - R + i; }

  // 把「离中心多远」交给 CSS：这里只写两个整数，缩放/旋转/景深/淡出/
  // 错峰全由 stage.css 从它们算出来。理由和歌词的 --row-d 完全一样——
  // 调观感不该去改 JS，而 JS 也不该知道这些视觉量。
  function paint(el, d) {
    var ad = d < 0 ? -d : d;
    if (el._d === d) return;
    el._d = d;
    el.style.setProperty('--shelf-d', d);
    el.style.setProperty('--shelf-ad', ad);
  }

  function bindSlot(slot, index) {
    var item = (index >= 0 && index < items.length) ? items[index] : null;
    var el = slot.el;

    if (!item) {
      if (!el.hidden) el.hidden = true;
      el._bound = null;
      return;
    }
    if (el.hidden) el.hidden = false;
    if (el._bound === item.id) { paint(el, index - center); return; }

    el._bound = item.id;
    el.dataset.id = item.id;
    el.setAttribute('aria-label', item.name + '，' + item.track_count + ' 首');
    slot.name.textContent = item.name;
    slot.count.textContent = item.track_count + ' 首';
    paint(el, index - center);
    applyCover(slot, item);
  }

  // 封面解析在共享的 PlaylistCovers 里（列表行也用它）：这里只把结果画到
  // 卡面上，拿不到封面时用它给的稳定色相占位。
  function applyCover(slot, item) {
    var st = window.PlaylistCovers.state(item.id);
    if (st.s === 'url') {
      slot.art.style.backgroundColor = '';
      slot.art.style.backgroundImage = 'url("' + st.url + '")';
    } else {
      slot.art.style.backgroundImage = '';
      slot.art.style.backgroundColor = 'hsl(' + st.hue + ' 32% 16%)';
    }
  }

  function itemById(id) {
    for (var i = 0; i < items.length; i += 1) if (items[i].id === id) return items[i];
    return null;
  }

  function render() {
    for (var i = 0; i < slots.length; i += 1) bindSlot(slots[i], slotFor(i));
    updateDetail();
    updateAria();
  }

  function updateAria() {
    var idx = clamp(center, 0, items.length - 1);
    var el = slotEl(idx);
    for (var i = 0; i < slots.length; i += 1) {
      var on = slots[i].el._bound && items[idx] && slots[i].el._bound === items[idx].id;
      slots[i].el.classList.toggle('is-center', !!on);
      slots[i].el.setAttribute('aria-selected', String(!!on));
    }
    if (el) host.setAttribute('aria-activedescendant', el.id);
    else host.removeAttribute('aria-activedescendant');
  }

  function slotEl(index) {
    var slot = index - (center - R);
    return (slot >= 0 && slot < SLOTS) ? slots[slot].el : null;
  }

  function updateDetail() {
    if (!detail) return;
    var item = items[clamp(center, 0, items.length - 1)];
    if (!item) { detail.hidden = true; detail.textContent = ''; return; }
    detail.hidden = false;
    detail.innerHTML = '';

    var name = document.createElement('strong');
    name.className = 'pl-name';
    name.textContent = item.name;
    var sub = document.createElement('span');
    sub.className = 'pl-sub';
    sub.textContent = item.track_count + ' 首';
    var spacer = document.createElement('span');
    spacer.className = 'shelf-detail-spacer';

    detail.append(name, sub, spacer);
    [
      ['play', '播放', 'primary'],
      ['queue', '下一首播放', ''],
      ['open', '查看曲目', ''],
      ['rename', '重命名', ''],
      ['delete', '删除', 'danger']
    ].forEach(function (spec) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn shelf-act' + (spec[2] ? ' ' + spec[2] : '');
      b.textContent = spec[1];
      b.addEventListener('click', function () { emit('shelf:action', { action: spec[0], id: item.id }); });
      detail.appendChild(b);
    });
  }

  function emit(type, detail) {
    document.dispatchEvent(new CustomEvent(type, { detail: detail }));
  }

  function focus(index, silent) {
    var next = clamp(index, 0, Math.max(0, items.length - 1));
    if (next === center) { render(); return; }
    center = next;
    render();
    if (!silent) emit('shelf:change', { index: center, item: items[center] || null });
  }

  function stepBy(n) { focus(center + n); }

  // ---------------------------------------------------------------------------
  // 输入
  // ---------------------------------------------------------------------------

  // 滚轮按累计量走格，而不是每个事件 ±1：高精度触摸板的 deltaY 一次能给出
  // 十几个 1–3 像素的小事件，按事件走格会在半秒内飞过整个歌单集合。
  var wheelAcc = 0;
  var wheelAt = 0;
  function onWheel(e) {
    if (!items.length) return;
    e.preventDefault();
    var t = Date.now();
    if (t - wheelAt > 400) wheelAcc = 0;
    wheelAt = t;
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) < WHEEL_STEP) return;
    var n = Math.trunc(wheelAcc / WHEEL_STEP);
    wheelAcc -= n * WHEEL_STEP;
    stepBy(n);
  }

  // 拖拽只改一个 --shelf-drag 变量做整体平移，松手才落到新的 center 上重排。
  // 于是拖动过程中没有逐卡写入，也没有惯性——惯性滚动在这里是负资产：
  // 用户是来挑歌单的，多滚出来的那几格得再滚回去。
  var dragX = 0, dragId = -1, dragMoved = 0;
  function onPointerDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    dragX = e.clientX;
    dragMoved = 0;
    dragId = e.pointerId;
    host.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e) {
    if (dragId !== e.pointerId) return;
    var dx = e.clientX - dragX;
    if (Math.abs(dx) > 4) dragMoved = Math.abs(dx);
    host.style.setProperty('--shelf-drag', dx.toFixed(1) + 'px');
  }
  function onPointerUp(e) {
    if (dragId !== e.pointerId) return;
    dragId = -1;
    host.style.removeProperty('--shelf-drag');
    var dx = e.clientX - dragX;
    // 阈值按卡位宽度算，拖过半格就算要换一张
    var step = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--shelf-step')) || 78;
    var n = Math.round(-dx / step);
    if (dragMoved > 6) { if (n) stepBy(n); return; }
    // 没有拖动 = 点击。中心卡播放，侧边卡只是转过来。
    var card = e.target.closest ? e.target.closest('.shelf-card') : null;
    if (!card) return;
    var index = cardIndex(card);
    if (index === null) return;
    if (index === center) emit('shelf:action', { action: 'play', id: items[index].id });
    else focus(index);
  }
  function cardIndex(el) {
    for (var i = 0; i < items.length; i += 1) if (items[i].id === el._bound) return i;
    return null;
  }

  function onKeyDown(e) {
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': stepBy(1); break;
      case 'ArrowLeft': case 'ArrowUp': stepBy(-1); break;
      case 'PageDown': stepBy(R); break;
      case 'PageUp': stepBy(-R); break;
      case 'Home': focus(0); break;
      case 'End': focus(items.length - 1); break;
      case 'Enter': case ' ':
        if (items[center]) emit('shelf:action', { action: 'play', id: items[center].id });
        break;
      default: return;
    }
    e.preventDefault();
  }

  // ---------------------------------------------------------------------------
  // 构建
  // ---------------------------------------------------------------------------

  function buildSlots() {
    host.textContent = '';
    // 地面：一张 3D 平面，给「退到远处」的卡片一个参照物。纯装饰，所以插在
    // 所有卡之前让它落在最下面，也不参与任何命中测试（CSS 里 pointer-events:none）。
    var floor = document.createElement('div');
    floor.className = 'shelf-floor';
    floor.setAttribute('aria-hidden', 'true');
    host.appendChild(floor);
    slots = [];
    for (var i = 0; i < SLOTS; i += 1) {
      var el = document.createElement('div');
      // 浮动动画的延迟按槽位错开，整排才不会同步呼吸
      el.style.setProperty('--shelf-slot', i - R);
      el.className = 'shelf-card';
      el.id = 'shelf-slot-' + i;
      el.setAttribute('role', 'option');
      var art = document.createElement('div');
      art.className = 'shelf-art';
      art.setAttribute('aria-hidden', 'true');
      var label = document.createElement('div');
      label.className = 'shelf-label';
      var name = document.createElement('div');
      name.className = 'shelf-name pl-name';
      var count = document.createElement('div');
      count.className = 'shelf-count pl-sub';
      label.append(name, count);
      el.append(art, label);
      el.hidden = true;
      host.appendChild(el);
      slots.push({ el: el, art: art, name: name, count: count });
    }
  }

  function init() {
    host = $('shelf-stage');
    detail = $('shelf-detail');
    if (!host) return null;
    buildSlots();

    // 封面异步就绪后，按当前绑定把对应卡面重刷一遍。
    window.PlaylistCovers.onChange(function (id) {
      for (var i = 0; i < slots.length; i += 1) {
        if (slots[i].el._bound === id) applyCover(slots[i], itemById(id));
      }
    });

    host.setAttribute('role', 'listbox');
    host.setAttribute('tabindex', '0');
    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('pointermove', onPointerMove);
    host.addEventListener('pointerup', onPointerUp);
    host.addEventListener('pointercancel', onPointerUp);
    host.addEventListener('keydown', onKeyDown);

    return api = {
      setItems: function (list) {
        items = list || [];
        // 集合变了（新建/删除/重命名）之后中心索引要重新落位，但尽量留住
        // 用户当前正看着的那一张，而不是每次都弹回第一张。
        var keep = items[center] && items[center].id;
        if (keep) {
          for (var i = 0; i < items.length; i += 1) if (items[i].id === keep) { center = i; break; }
        }
        center = clamp(center, 0, Math.max(0, items.length - 1));
        render();
      },
      index: function () { return center; },
      focus: focus,
      // 从别处（右键菜单"打开歌单"）驱动架子转过去
      focusId: function (id) {
        for (var i = 0; i < items.length; i += 1) if (items[i].id === id) { focus(i); return true; }
        return false;
      },
      // 歌单内容变了要让共享解析器丢缓存，否则加歌之后封面还停在旧数据上
      invalidate: function (id) {
        window.PlaylistCovers.invalidate(id);
        render();
      },
      items: function () { return items.slice(); }
    };
  }

  window.Shelf = { init: init };
})();
