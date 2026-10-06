// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 界面皮肤：只管**布局**，不管配色。
//
// 一套皮肤 = 一个 id + 一份 CSS（`skins/skin.<id>.css`）。切换时只做两件事：
// 把 `data-skin` 写到 <html> 上、把对应那份 CSS 的 disabled 解开。配色一律
// 沿用当前主题的 token，皮肤 CSS 里不出现任何颜色字面量——所以换皮肤不会
// 把主题色带跑，换主题也不会破坏皮肤。
//
// 加一套新皮肤只需两步（扩展点就是 register）：
//   1. 新建 `skins/skin.<id>.css`，规则用 `[data-skin="<id>"]` 包起来；
//   2. 在 CATALOG 里加一行 `{ id, name, note }`，并在 index.html 里补一个
//      `<link data-skin-css="<id>" disabled>`。
// 其余（切换、持久化、设置页列表与顶栏弹层这两个宿主、事件广播）都由这里统一处理。

(function () {
  'use strict';

  var ATTR = 'data-skin';
  var KEY = 'vmusic.skin';
  var DEFAULT_ID = 'classic';
  var EVENT = 'skin:changed';

  /// 皮肤目录。`classic` 是"没有皮肤"——也就是仓库原本那套布局，它不带 CSS
  /// 文件，其它皮肤都是在它的基础上做覆盖。
  var CATALOG = [
    {
      id: 'classic',
      name: '经典',
      note: '仓库原本的三列布局（导航 / 内容 / 舞台并排）',
    },
    {
      id: 'sheen',
      name: '浮光',
      note: '顶部悬浮胶囊导航 + 全宽卡片网格，舞台贴右侧边',
    },
    {
      id: 'workbench',
      name: '工作台',
      note: '固定窄侧栏 + 内容分栏，直角细线、高信息密度',
    },
    {
      id: 'liunian',
      name: '流年',
      note: '清晰导航、暖调播放卡与凝彩舞台，可收为胶囊，手机端直接浏览歌曲',
    },
    {
      id: 'ios',
      // 显示名不写「iOS」：这套皮肤卖的是 macOS 侧栏 + iOS 分组列表的观感，
      // 与 Apple 官方无关；沿用商标名会让设置列表看着像官方出品。id 仍是
      // 'ios'（持久化键 vmusic.skin 靠它，改名只动这一处）。
      name: 'OS风',
      note: 'macOS 式侧栏与工具栏、iOS 分组列表；小屏横向导航，支持浅色与深色主题',
    },
    {
      id: 'qingfeng',
      name: '清风',
      note: '全宽展墙：顶部胶囊主菜单、方形海报墙队列拼接、folia 式设置浮层',
    },
  ];

  var current = DEFAULT_ID;
  var listeners = [];

  function byId(id) {
    for (var i = 0; i < CATALOG.length; i += 1) {
      if (CATALOG[i].id === id) return CATALOG[i];
    }
    return null;
  }

  /// 皮肤那几份 CSS 在页面上的载体。
  ///
  /// 独立形态下它们是 index.html 里声明的 `<link data-skin-css disabled>`；
  /// DBX 插件形态下宿主会把 `<link rel=stylesheet>` 就地换成 `<style>`
  /// （srcdoc 沙箱的 CSP 不放行外链样式表），属性一并搬过去，于是同一个标记
  /// 挂在另一种元素上。两种都要认，否则插件形态下 hasCss() 永远为假、
  /// apply() 一律回落 classic，表现是「设置里点皮肤没有反应」。
  ///
  /// `.disabled` 是 IDL 属性，link 与 style 都支持（style 的 disabled **内容**
  /// 属性不生效，所以初始的关闭必须由这里在启动时做一次，见 syncCss）。
  function sheets() {
    return document.querySelectorAll('link[data-skin-css], style[data-skin-css]');
  }

  /// 皮肤 CSS 是**按需启用**的：所有皮肤都 link 在页面上但默认 disabled，
  /// 切到谁才解开谁。这样切换是同步的、没有加载闪烁，也不必在运行时插入
  /// <link>（插入会有一帧无样式）。
  function syncCss(id) {
    var links = sheets();
    for (var i = 0; i < links.length; i += 1) {
      var own = links[i].getAttribute('data-skin-css');
      var want = own === id;
      if (links[i].disabled === want) links[i].disabled = !want;
    }
  }

  /// 声明的皮肤必须真的有那份 CSS，否则切过去等于"什么都没变"——
  /// 这种静默失败最难查，所以启动时就把它挑出来。
  function hasCss(id) {
    var links = sheets();
    for (var i = 0; i < links.length; i += 1) {
      if (links[i].getAttribute('data-skin-css') === id) return true;
    }
    return false;
  }

  function apply(id, opts) {
    var def = byId(id);
    if (!def) {
      def = byId(DEFAULT_ID);
      id = DEFAULT_ID;
    }
    // classic 没有 CSS 文件是设计如此；其它皮肤缺 CSS 就是漏了文件。
    if (id !== DEFAULT_ID && !hasCss(id)) {
      if (window.console && console.warn) console.warn('[skins] 缺少 ' + id + ' 的 CSS，回落到 classic');
      id = DEFAULT_ID;
      def = byId(DEFAULT_ID);
    }

    current = id;
    var root = document.documentElement;
    if (root.getAttribute(ATTR) !== id) root.setAttribute(ATTR, id);
    syncCss(id);

    if (!(opts && opts.silent)) {
      try { localStorage.setItem(KEY, id); } catch (e) { /* 隐私模式 */ }
    }
    // 两处宿主（设置页那张卡列表、顶栏那颗弹层）都在这儿一起重画。放在广播
    // 之前：订阅者可能会去读已经更新的高亮态。
    refresh();
    // 舞台画布、3D 场景这些要按新尺寸重排，广播出去让它们自己响应——
    // 与项目里 online-playlists:changed 的做法一致，不在这里硬编码谁要重画。
    try {
      document.dispatchEvent(new CustomEvent(EVENT, { detail: { id: id, skin: def } }));
    } catch (e) { /* 老浏览器没有 CustomEvent 构造器 */ }
    listeners.forEach(function (fn) {
      try { fn(def); } catch (e) { /* 单个订阅者出错不该拖垮换肤 */ }
    });
    return def;
  }

  function init() {
    var saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) { saved = null; }
    // 存过但不认识（比如皮肤被删了）就回落 classic，而不是写个无效属性。
    apply(saved && byId(saved) ? saved : DEFAULT_ID, { silent: true });
    bindEntry();
    return current;
  }

  // ---------------------------------------------------------------------------
  // 皮肤清单的两个宿主：设置页的卡片列表 + 顶栏的切换弹层
  // ---------------------------------------------------------------------------

  function el(id) { return document.getElementById(id); }

  /// 同一份 CATALOG 渲染成两种宿主：设置页是「一张卡一套皮肤」，顶栏弹层是
  /// 「一行一个单选项」。只有可访问性语义不同（aria-pressed vs menuitemradio），
  /// 数据与切换动作共用，所以第二处不再复制一份清单。
  function renderInto(host, isMenu) {
    if (!host) return;
    host.innerHTML = '';
    CATALOG.forEach(function (def) {
      var on = def.id === current;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'skin-option' + (on ? ' is-on' : '');
      b.setAttribute('data-skin-id', def.id);
      if (isMenu) {
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', String(on));
        // 弹层里说明被压成一行省略号，全文挂在 title 上。
        b.title = def.note;
      } else {
        b.setAttribute('aria-pressed', String(on));
      }
      var name = document.createElement('strong');
      name.className = 'skin-option-name';
      name.textContent = def.name;
      var note = document.createElement('span');
      note.className = 'skin-option-note';
      note.textContent = def.note;
      b.appendChild(name);
      b.appendChild(note);
      b.onclick = function () {
        apply(def.id);
        if (isMenu) closeEntry(true);
      };
      host.appendChild(b);
    });
  }

  function renderList() { renderInto(el('skins-list'), false); }
  function renderMenu() { renderInto(entryMenu, true); }

  /// 切肤后两处宿主都要跟上，否则「弹层里已经选了 B，设置页还高亮着 A」。
  function refresh() {
    renderList();
    if (entryMenu) renderMenu();
  }

  // ---------------------------------------------------------------------------
  // 顶栏入口：#skin-btn 开合 #skin-menu
  // ---------------------------------------------------------------------------

  var entryBtn = null;
  var entryMenu = null;
  var entryOpen = false;

  function setEntryOpen(open, returnFocus) {
    if (!entryBtn || !entryMenu) return;
    entryOpen = !!open;
    entryMenu.hidden = !entryOpen;
    entryBtn.classList.toggle('active', entryOpen);
    entryBtn.setAttribute('aria-expanded', String(entryOpen));
    if (entryOpen) {
      renderMenu();
      // 焦点直接落在当前皮肤那一行：开弹层的意图就是「看看现在是哪套」。
      var at = entryMenu.querySelector('.skin-option.is-on') || entryMenu.firstElementChild;
      if (at && at.focus) at.focus();
    } else if (returnFocus && entryBtn.focus) {
      entryBtn.focus();
    }
  }

  function closeEntry(returnFocus) { setEntryOpen(false, returnFocus); }

  function entryRows() {
    return Array.prototype.slice.call(entryMenu.querySelectorAll('.skin-option'));
  }

  function bindEntry() {
    entryBtn = el('skin-btn');
    entryMenu = el('skin-menu');
    // 契约脚本的沙箱只给 #skins-list，这里安静地不绑就行（模块其余部分照旧可用）。
    if (!entryBtn || !entryMenu) return;

    entryBtn.onclick = function (e) {
      e.stopPropagation();
      setEntryOpen(!entryOpen, false);
    };

    document.addEventListener('click', function (e) {
      // contains 而不是 ===：按钮里是个 svg，点图标时 target 落在 svg 上。
      if (entryOpen && !entryMenu.contains(e.target) && !entryBtn.contains(e.target)) {
        setEntryOpen(false, false);
      }
    });

    entryMenu.addEventListener('keydown', function (e) {
      var rows = entryRows();
      if (!rows.length) return;
      var idx = rows.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        e.stopPropagation();
        setEntryOpen(false, true);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var next = idx < 0 ? 0 : idx + (e.key === 'ArrowDown' ? 1 : -1);
        if (next < 0) next = rows.length - 1;
        if (next >= rows.length) next = 0;
        rows[next].focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        rows[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        rows[rows.length - 1].focus();
      }
    });

    window.addEventListener('resize', function () {
      if (entryOpen) setEntryOpen(false, false);
    });
  }

  window.Skins = {
    /// 扩展点：新皮肤走这里登记，之后切换/列表/持久化自动生效。
    register: function (def) {
      if (!def || !def.id || byId(def.id)) return false;
      CATALOG.push(def);
      return true;
    },
    list: function () {
      return CATALOG.map(function (d) { return { id: d.id, name: d.name, note: d.note }; });
    },
    apply: apply,
    current: function () { return byId(current); },
    currentId: function () { return current; },
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
    init: init,
    render: renderList,
    /// 契约脚本与排障用：皮肤之间的差别必须体现在布局上，不是颜色。
    catalog: function () { return CATALOG.slice(); },
  };
})();
