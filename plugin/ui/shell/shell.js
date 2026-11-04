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
  var components = new Map();
  var componentOwners = new Map();

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
    // HTML 只在初始化时声明公共组件根与装配区域。皮肤不能登记任意节点，
    // 也不能传选择器；组件内部的 DOM 形状不属于布局接口。
    document.querySelectorAll('[data-shell-component], [data-shell-region]').forEach(function (node) {
      var component = node.getAttribute('data-shell-component');
      var slot = node.getAttribute('data-shell-region');
      if (component) {
        if (components.has(component)) throw new Error('公共组件重复：' + component);
        components.set(component, node);
      }
      if (slot) {
        if (Object.prototype.hasOwnProperty.call(regions, slot)) throw new Error('公共区域重复：' + slot);
        regions[slot] = node;
      }
    });
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

  // 声明式布局：regions 只描述由外壳创建的容器，placements 只引用公共组件
  // 和区域的名字。没有 move(node, parent) 或 selector 回门。区域为容器；组件
  // 为整体迁移单元（包括显式公开的 artwork/volume 等子组件），业务状态不重建。
  var layoutAssemblies = new Map();
  function assembleLayout(id, description) {
    if (!initialized) throw new Error('外壳尚未初始化');
    if (typeof id !== 'string' || !id) throw new TypeError('布局需要 id');
    if (layoutAssemblies.has(id)) throw new Error('布局装配已存在：' + id);
    description = description || {};
    // 外壳持有不可变的布局值。不能保存调用方数组引用，否则媒体切换时调用方
    // 可把已认领的组件换成另一组件，绕过独占检查与还原账本。
    function copySpec(value, fields) {
      if (!value || typeof value !== 'object' || value.nodeType || Array.isArray(value)) {
        throw new TypeError('布局项必须是字段描述');
      }
      var copy = {};
      Object.keys(value).forEach(function (key) {
        if (!Object.prototype.hasOwnProperty.call(fields, key) || typeof value[key] !== fields[key]) {
          throw new TypeError('不支持的布局字段：' + key);
        }
        copy[key] = value[key];
      });
      return Object.freeze(copy);
    }
    var sourceRegions = description.regions || {};
    if (typeof sourceRegions !== 'object' || sourceRegions.nodeType || Array.isArray(sourceRegions)) throw new TypeError('regions 必须是描述表');
    var definitions = Object.create(null);
    Object.keys(sourceRegions).forEach(function (name) {
      definitions[name] = copySpec(sourceRegions[name], { tag: 'string', className: 'string', parent: 'string', before: 'string', first: 'boolean' });
    });
    if (description.placements !== undefined && !Array.isArray(description.placements)) throw new TypeError('placements 必须是数组');
    var placements = (description.placements || []).map(function (item) {
      return copySpec(item, { component: 'string', target: 'string', before: 'string', first: 'boolean' });
    });
    var mediaQuery = description.media;
    if (mediaQuery !== undefined && typeof mediaQuery !== 'string') throw new TypeError('media 必须是查询字符串');
    var local = Object.create(null);
    var created = [];
    var records = [];
    var claimed = new Set();
    var active = false;
    var disposed = false;
    var media = null;

    function target(name) {
      if (typeof name !== 'string') throw new TypeError('区域必须使用名称');
      return local[name] || region(name);
    }
    function insert(node, parent, spec) {
      if (spec.before) {
        if (typeof spec.before !== 'string') throw new TypeError('插入点必须使用名称');
        var before = local[spec.before] || components.get(spec.before) || regions[spec.before];
        if (!before || before.parentNode !== parent) throw new Error('插入点不属于目标区域：' + spec.before);
        parent.insertBefore(node, before);
      } else if (spec.first) parent.insertBefore(node, parent.firstChild);
      else parent.appendChild(node);
    }
    function validatePlacements() {
      // 按声明顺序模拟父关系，未激活的媒体分支也必须通过相同校验。
      var parents = new Map();
      function parentOf(node) { return parents.has(node) ? parents.get(node) : node.parentNode; }
      placements.forEach(function (item) {
        var node = components.get(item.component);
        var parent = target(item.target);
        for (var ancestor = parent; ancestor; ancestor = parentOf(ancestor)) {
          if (ancestor === node) throw new Error('布局不能形成组件循环：' + item.component);
        }
        if (item.before) {
          if (typeof item.before !== 'string') throw new TypeError('插入点必须使用名称');
          var before = local[item.before] || components.get(item.before) || regions[item.before];
          if (!before || parentOf(before) !== parent) throw new Error('插入点不属于目标区域：' + item.before);
        }
        parents.set(node, parent);
      });
    }
    function restore() {
      // 每个组件在原位留下真实节点锚点，原兄弟也参加装配时仍可精确还原。
      // 锚点只由外壳持有，皮肤看不到还原账本。
      for (var i = records.length - 1; i >= 0; i -= 1) {
        var record = records[i];
        if (record.anchor.parentNode) record.anchor.parentNode.insertBefore(record.node, record.anchor);
      }
      active = false;
    }
    function apply() {
      try {
        placements.forEach(function (item) { insert(components.get(item.component), target(item.target), item); });
        active = true;
      } catch (error) {
        restore();
        throw error;
      }
    }
    function updateMedia() {
      if (disposed) return;
      if (!media || media.matches) {
        if (!active) {
          try { validatePlacements(); apply(); }
          catch (error) { dispose(); throw error; }
        }
      } else if (active) restore();
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      if (media) media.removeEventListener('change', updateMedia);
      restore();
      records.forEach(function (record) { record.anchor.remove(); });
      created.reverse().forEach(function (node) { node.remove(); });
      claimed.forEach(function (name) { componentOwners.delete(name); });
      layoutAssemblies.delete(id);
    }

    // 先验证全部组件及所有权；再创建区域与锚点。任何失败都撤销本次装配。
    placements.forEach(function (item) {
      if (!item || typeof item.component !== 'string' || !components.has(item.component)) {
        throw new Error('未公开的布局组件：' + (item && item.component));
      }
      if (claimed.has(item.component) || componentOwners.has(item.component)) {
        throw new Error('组件已被其他布局持有：' + item.component);
      }
      claimed.add(item.component);
    });
    claimed.forEach(function (name) { componentOwners.set(name, id); });
    try {
      claimed.forEach(function (name) {
        var node = components.get(name);
        var anchor = document.createComment('shell-component:' + name);
        node.parentNode.insertBefore(anchor, node);
        records.push({ node: node, anchor: anchor });
      });
      Object.keys(definitions).forEach(function (name) {
        if (regions[name] || components.has(name)) throw new Error('局部区域不得覆盖公共名称：' + name);
        var def = definitions[name];
        if (!def || typeof def !== 'object' || def.nodeType) throw new TypeError('区域必须是创建描述');
        var tag = def.tag || 'div';
        if (!/^(div|section|aside|header|nav|button|details)$/.test(tag)) throw new Error('不支持的区域容器：' + tag);
        var node = document.createElement(tag);
        node.className = def.className || '';
        if (tag === 'button') node.type = 'button';
        created.push(node);
        // 父区域必须已经声明；前向引用和循环直接拒绝。
        insert(node, target(def.parent), def);
        local[name] = node;
      });
      // 即使响应式分支当前未激活，也验证目标区域，避免错误推迟到 resize。
      validatePlacements();
      if (mediaQuery) media = window.matchMedia(mediaQuery);
      updateMedia();
      if (media) media.addEventListener('change', updateMedia);
      var handle = Object.freeze({
        region: function (name) {
          if (disposed || !local[name]) throw new Error('布局区域不可用：' + name);
          return local[name];
        },
        dispose: dispose,
      });
      layoutAssemblies.set(id, handle);
      return handle;
    } catch (error) {
      dispose();
      throw error;
    }
  }


  function isLayoutAssembled(id) { return layoutAssemblies.has(id); }

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
    hasComponent: function (name) { return components.has(name); },
    attachView: attachView,
    detachView: detachView,
    isViewAttached: isViewAttached,
    assembleLayout: assembleLayout,
    isLayoutAssembled: isLayoutAssembled,
    hasView: hasView,
  };
})();
