// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 应用外壳（AppShell）：活动视图、工作区模式与公共区域装配的唯一权威。
//
// 职责边界（docs/aegis/specs/2026-11-03-ui-architecture-convergence-design.md §4.1/§5）：
//  - 持有活动视图与导航代次；切换按「验证 → 退出交接 → 提交显隐与导航态 → 进入钩子」
//    串行执行，无效请求不提交半成品导航状态。
//  - 工作区模式（普通 / 房间）由视图登记声明；模式对应的公共 chrome 显隐与布局
//    收敛在 shell.css。业务页面与皮肤不得用自身样式隐藏窗口控制区或改动其他页面。
//  - 提供明确的装配区域（页面外浮动结构的挂载点）；区域只暴露稳定容器，不把
//    全局 DOM 查询包装成插槽 API。
//
// 不负责：业务刷新与数据裁决（视图 enter/leave 委托回原模块）、皮肤 ID 的权威
// （归 Skins）、窗口能力（宿主接线就绪前不呈现自绘窗口控制，见设计 §9.1：
// 能力由明确的宿主握手确定，不按 UA 或全局对象猜测）。
(function () {
  'use strict';

  var views = new Map();
  var order = [];
  var rail = null;
  var settingsEntry = null;
  var active = null;
  var generation = 0;
  var initialized = false;
  var regions = null;

  function registerView(def) {
    if (!def || typeof def.id !== 'string' || !def.el) {
      throw new TypeError('视图登记需要 id 与根节点');
    }
    if (views.has(def.id)) throw new Error('视图 id 重复：' + def.id);
    var entry = {
      id: def.id,
      el: def.el,
      // R1 只引入普通工作区与房间工作区两种模式（设计 §5.1），不提前建
      // 覆盖所有沉浸场景的布局状态机。
      mode: def.mode === 'room' ? 'room' : 'default',
      enter: typeof def.enter === 'function' ? def.enter : null,
      leave: typeof def.leave === 'function' ? def.leave : null,
    };
    views.set(def.id, entry);
    order.push(entry);
    return entry;
  }

  function init(options) {
    options = options || {};
    rail = options.rail || null;
    settingsEntry = options.settingsEntry || null;
    (options.views || []).forEach(registerView);
    regions = { floating: createFloatingRegion() };
    initialized = true;
  }

  // 页面外浮动结构（一起听迷你播放条等）的明确挂载区。容器本身不参与布局，
  // 只承载其中的定位元素；业务模块经此挂载，不再各自 append 到 body。
  function createFloatingRegion() {
    var node = document.createElement('div');
    node.className = 'shell-region shell-region-floating';
    document.body.appendChild(node);
    return node;
  }

  function region(name) {
    if (!regions || !Object.prototype.hasOwnProperty.call(regions, name)) {
      throw new Error('未知外壳区域：' + name);
    }
    return regions[name];
  }

  // 受控装配（设计 §7.2）：已登记视图的根节点由外壳持有显隐与登记；宿主表面
  // （设置浮层右栏等）经 attach/detach 迁移根节点，而不是用通用搬运工具自行
  // 移动业务根。attach 记录原位，detach 严格还原父节点与插入点。
  var attachedViews = new Map();
  function attachView(id, container) {
    if (!initialized) throw new Error('外壳尚未初始化');
    var def = views.get(id);
    if (!def) throw new Error('未登记的视图：' + id);
    if (!container) throw new TypeError('装配目标容器缺失');
    if (attachedViews.has(id)) throw new Error('视图已装配在其他表面：' + id);
    attachedViews.set(id, { parent: def.el.parentNode, next: def.el.nextSibling });
    container.appendChild(def.el);
    return def.el;
  }

  function detachView(id) {
    var def = views.get(id);
    var record = attachedViews.get(id);
    if (!def || !record) return false;
    attachedViews.delete(id);
    if (record.parent) {
      if (record.next && record.next.parentNode === record.parent) record.parent.insertBefore(def.el, record.next);
      else record.parent.appendChild(def.el);
    }
    return true;
  }

  function isViewAttached(id) { return attachedViews.has(id); }

  // 导航请求。options 沿用既有语义：historyOnly（在线页只切视图不拉数据）、
  // skipDesktopDetection（设置页恢复不探测可选桌面组件）。无效目标保持当前页面。
  function navigate(name, options) {
    if (!initialized) return false;
    var def = views.get(name);
    if (!def) return false;
    generation += 1;
    var context = { options: options || {}, generation: generation };
    // 退出交接：只在真正离开旧视图时执行。同名重复导航是「重跑进入对账」——
    // 换肤后与 Esc 对账依赖它把被皮肤改动过的 hidden 重新对齐、让进入钩子照常
    // 跑一遍，不能当成 no-op 优化掉（见 app.js onSkinChangedForViews 的注记）。
    if (active && active !== name) {
      var prev = views.get(active);
      if (prev && prev.leave) prev.leave(context);
    }
    active = name;
    // 工作区模式是公共区域显隐的唯一驱动（shell.css 消费这些信号）。
    // room-view 保留既有类名：房间工作区内部规则与既有浏览器探针都认它。
    var roomMode = def.mode === 'room';
    document.body.classList.toggle('room-view', roomMode);
    var i;
    for (i = 0; i < order.length; i += 1) order[i].el.hidden = order[i].id !== name;
    if (rail) {
      var items = rail.querySelectorAll('.rail-item');
      for (i = 0; i < items.length; i += 1) {
        items[i].classList.toggle('active', items[i].dataset.view === name);
      }
    }
    if (settingsEntry) {
      settingsEntry.classList.toggle('active', name === 'settings');
      settingsEntry.setAttribute('aria-pressed', String(name === 'settings'));
    }
    document.body.classList.remove('column-open');
    // 进入钩子在显隐提交之后执行（与旧 setView 顺序一致）；钩子内部已自带
    // 各自的错误处理，异步内容失败不回退导航本身。
    if (def.enter) def.enter(context);
    return true;
  }

  function activeView() { return active; }

  function mode() {
    var def = active ? views.get(active) : null;
    return def ? def.mode : 'default';
  }

  // 导航代次：只保护 UI 交接，不替代业务的播放 generation / 房间 operation ID。
  function viewGeneration() { return generation; }

  function hasView(name) { return views.has(name); }

  window.HertzShell = {
    init: init,
    registerView: registerView,
    navigate: navigate,
    activeView: activeView,
    mode: mode,
    generation: viewGeneration,
    region: region,
    attachView: attachView,
    detachView: detachView,
    isViewAttached: isViewAttached,
    hasView: hasView,
  };
})();
