// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 共享设置浮层（清风同款）：遮罩 + 卡片 + 左栏分类 + 右栏内容。
// --------------------------------------------------------------------------
//
// 背景
// ----
// 设置原本是中栏的一个普通视图（#view-settings，17 个 .set-group 一路滚到底）。
// 清风率先把它搬进浮层：左栏两级分类、右栏一次只显示一组。这个形态用户反馈
// 很好，于是收敛成**所有皮肤共用**的一层 —— classic 在这里直接注册生命周期，
// heijiao / orbit 在自己的生命周期里调用 mount/unmount；
// liunian / qingfeng 保留各自的浮层实现（它们比本模块更早存在，且有各自的
// 皮肤化样式与契约脚本钉着）。
//
// 入口拦截
// --------
// 业务开设置只有一条路：setView('settings') 把 #view-settings 的 hidden 摘掉
// （rail 条目 / 顶栏齿轮 / 快捷键 4 全都汇到这一处）。本模块挂一个
// MutationObserver 盯着 view-settings 的 hidden：业务一把它点亮，就立刻
// 藏回去并打开浮层。这样**不用改 app.js 的任何一行**，所有入口自动接对，
// 而且业务那套进入钩子（loadDiagnostics / 缓存占用 / DSP / 远程来源刷新）
// 照常跑完 —— 它们挂在 setView 里，不挂在浮层上。
//
// 关闭后把 app 的视图从 'settings' 送回首页（点击 rail 的库条目）：
// state.view 停在 'settings' 的话，下一次 Esc 会触发 setView('settings')，
// 浮层会被再次拉起 —— 用户按 Esc 关掉的东西又在 Esc 里回来，是明显的 bug 观感。
//
// 契约
// ----
//   · 只搬运 #view-settings + 切 .set-group 的 hidden，不改业务 JS 的状态；
//     搬运走 SkinShared 的锚点机制，卸载时严格回位、原顺序保持；
//   · 认领分组靠 .set-title 的**文案**（与清风/流年同一份语义表），认领不到
//     的统一落进「其它」，业务新增设置表现为「多一项」而不是「消失」；
//   · hidden 是皮肤加的，卸载时必须全部摘掉（showAll），否则会跟着切到
//     别的皮肤，表现为「设置里其它项都不见了」且不报错。
//
// 样式在 skins/skins.css 的 .skset-* 一节：常驻加载、不随皮肤启停，
// 尺寸/圆角/描边读各皮肤的 --skin-* 令牌（classic 无令牌时走回退值）。

(function () {
  'use strict';

  var SECTION_KEY = 'vmusic.skset-section';
  var MODAL_EXIT_MS = 200;

  // 设置分类表：与 skin.qingfeng.js 的 SET_SECTIONS 同源。条目按
  // .set-group 的标题文案（.set-title 的文字）认领。第 0 项是语义 key，
  // 第 1 项是标题文案，第 2 项是右栏的说明行。
  var SET_SECTIONS = [
    {
      id: 'appearance',
      label: '外观',
      items: [
        ['skin', '界面皮肤', '只换布局，不动主题色'],
        ['look', '外观', '主题色、密度、动效与输出设备'],
        ['wall', '主题与壁纸', '二次元主题与背景图'],
        ['nav', '导航', '导航里显示哪些入口'],
        ['walllook', '海报墙', '队列拼接的观感与跟随（仅清风生效）'],
      ],
    },
    {
      id: 'playback',
      label: '播放',
      items: [
        ['audio', '音效与均衡器', '均衡器、增益与响度归一'],
        ['play', '播放', '加入队列的默认行为与播放落点'],
        ['lyrics', '歌词', '全局偏移、逐行过滤与片头人员行'],
        ['lyricout', '歌词输出（OBS 浮层）', 'OBS 浏览器源的歌词浮层地址'],
        ['videoexport', '歌词视频导出', '舞台画面与歌词录成视频'],
        ['window', '窗口与舞台', '沉浸声场与胶囊播放器'],
        ['stage', '创意舞台', '创意工坊与手绘风格'],
        ['keys', '快捷键', '键盘操作一览'],
      ],
    },
    {
      id: 'library',
      label: '数据与在线',
      items: [
        ['source', '在线音源', '应用配置与音源连接'],
        ['remote', '远程来源（WebDAV）', '连自己的 WebDAV 目录'],
        ['cache', '在线缓存', '缓存占用与清理'],
        ['backup', '数据备份', '导入导出歌单与设置'],
      ],
    },
    {
      id: 'advanced',
      label: '高级',
      items: [
        ['dev', '开发者选项', '播放诊断日志'],
      ],
    },
  ];

  // 本模块服务哪些皮肤：它们没有自己的生命周期脚本，由这里代管。
  // liunian / qingfeng / heijiao / orbit 各有自己的 skin.<id>.js，不在此列。
  var MANAGED_SKINS = ['classic'];

  var mounted = false;
  var st = {
    root: null,
    card: null,
    closeBtn: null,
    nav: null,
    pane: null,
    paneTitle: null,
    paneDesc: null,
    viewEl: null,
    entries: [],
    sections: [],
    active: '',
    open: false,
    closing: false,
    closeTimer: 0,
    lastFocus: null,
    // true = 这次打开来自业务 setView('settings') 的拦截（关闭时要送回首页）。
    openedViaView: false,
  };
  var moves = null;
  var built = null;
  var viewObserver = null;
  var keyHandler = null;

  function byId(id) { return document.getElementById(id); }

  function make(tag, cls, parent) {
    // 挂载期间走 SkinShared 的登记工厂（卸载时统一拆）；沙箱/极端路径下
    // 没有登记器也能建节点。
    if (built) return built.make(tag, cls, parent);
    var n = document.createElement(tag || 'div');
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }

  function readSectionKey() {
    try { return localStorage.getItem(SECTION_KEY) || ''; } catch (e) { return ''; }
  }

  function writeSectionKey(key) {
    try { localStorage.setItem(SECTION_KEY, key); } catch (e) { /* 隐私模式 */ }
  }

  // -------------------------------------------------------------------------
  // 分组认领：文案 → 语义 key（与清风同一套判据）
  // -------------------------------------------------------------------------

  function claimGroups() {
    var view = st.viewEl;
    if (!view) return;
    // 每次挂载都从模板深拷贝一份：「其它」兜底类是运行期追加的，
    // 直接往模板里 push 的话，二次挂载会重复追加、左栏出现两份。
    var sections = [];
    SET_SECTIONS.forEach(function (s) {
      sections.push({ id: s.id, label: s.label, items: s.items.slice() });
    });
    st.sections = sections;

    var groups = Array.prototype.slice.call(view.querySelectorAll('.set-group'));
    var byKey = {};   // 语义 key -> { key, group, label, note }
    var leftovers = [];
    groups.forEach(function (g) {
      var t = g.querySelector('.set-title');
      var title = t ? t.textContent.trim() : '';
      var found = null;
      sections.forEach(function (section) {
        if (found) return;
        section.items.forEach(function (item) {
          if (item[1] === title) found = { key: item[0], note: item[2] };
        });
      });
      if (found) byKey[found.key] = { key: found.key, group: g, label: title, note: found.note };
      else leftovers.push({ group: g, label: title });
    });

    var claimed = [];
    sections.forEach(function (section) {
      section.items.forEach(function (item) {
        if (byKey[item[0]]) claimed.push(byKey[item[0]]);
      });
    });

    // 认领不到的分组统一落进「其它」：业务日后新增设置，表现为「多一项」
    // 而不是「从导航里消失」。
    if (leftovers.length) {
      var rest = [];
      leftovers.forEach(function (l) {
        var key = 'x' + l.label;
        rest.push([key, l.label, '']);
        claimed.push({ key: key, label: l.label, note: '', group: l.group });
      });
      sections.push({ id: 'misc', label: '其它', items: rest });
    }

    st.entries = claimed;
  }

  function firstKey() {
    for (var s = 0; s < st.sections.length; s += 1) {
      if (st.sections[s].items.length) return st.sections[s].items[0][0];
    }
    return '';
  }

  function entryGroup(key) {
    for (var i = 0; i < st.entries.length; i += 1) {
      if (st.entries[i].key === key) return st.entries[i].group;
    }
    return null;
  }

  function hideAll() {
    st.entries.forEach(function (entry) {
      if (entry.group) entry.group.hidden = true;
    });
  }

  /// 卸载：把皮肤加的 hidden 全部摘掉。留着会跟到别的皮肤上，
  /// 表现为「设置里其它项都不见了」，且不报错、不崩，极难定位。
  function showAll() {
    st.entries.forEach(function (entry) {
      if (entry.group) entry.group.hidden = false;
    });
  }

  // -------------------------------------------------------------------------
  // 左栏 / 右栏标题
  // -------------------------------------------------------------------------

  function paintNav() {
    if (!st.nav) return;
    st.nav.innerHTML = '';
    st.sections.forEach(function (section) {
      section.items.forEach(function (item) {
        var known = null;
        for (var i = 0; i < st.entries.length; i += 1) {
          if (st.entries[i].key === item[0]) { known = st.entries[i]; break; }
        }
        if (!known) return;
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'skset-link';
        b.dataset.sksetKey = item[0];
        b.textContent = item[1];
        var on = item[0] === st.active;
        b.classList.toggle('is-active', on);
        if (on) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
        st.nav.appendChild(b);
      });
    });
  }

  function renderPaneHead() {
    for (var i = 0; i < st.entries.length; i += 1) {
      if (st.entries[i].key !== st.active) continue;
      st.paneTitle.textContent = st.entries[i].label;
      st.paneDesc.textContent = st.entries[i].note || '';
      return;
    }
    st.paneTitle.textContent = '设置';
    st.paneDesc.textContent = '';
  }

  // -------------------------------------------------------------------------
  // 开 / 关
  // -------------------------------------------------------------------------

  function openSheet(trigger) {
    if (!mounted || !st.root || st.open) return;
    st.open = true;
    st.closing = false;
    clearTimeout(st.closeTimer);
    st.lastFocus = trigger || document.activeElement;
    st.root.hidden = false;
    st.root.classList.remove('is-closing');
    document.body.classList.add('skset-modal-open');
    // 记住的分类已不存在时回落到第一类（不空屏）。
    var initial = readSectionKey();
    if (!st.entries.some(function (e) { return e.key === initial; })) initial = firstKey();
    st.active = initial;
    hideAll();
    var g = entryGroup(st.active);
    if (g) g.hidden = false;
    // setView 那条路径进来时视图已被业务点亮，这里统一按浮层语义收着。
    if (st.viewEl) st.viewEl.hidden = false;
    renderPaneHead();
    paintNav();
    if (st.pane) st.pane.scrollTop = 0;
    // 焦点落在左栏当前项：键盘用户能看到自己在哪一类。
    var current = st.nav.querySelector('.skset-link.is-active') || st.nav.firstElementChild;
    if (current && current.focus) current.focus({ preventScroll: true });
  }

  /// 关闭后把 app 的视图从 'settings' 送回首页。只有「拦截 setView 打开」的
  /// 这一次需要 —— 不送回的话 state.view 停在 'settings'，下一次全局 Esc
  /// 会 setView('settings') 把浮层再次拉起。走 rail 条目的正常点击路径，
  /// 业务的高亮 / 钩子全部照常。
  function restoreAppView() {
    var item = document.querySelector('.rail-item[data-view="library"]');
    if (item && item.click) item.click();
  }

  function closeSheet(options) {
    if (!st.open || st.closing) return;
    st.closing = true;
    if (st.root) st.root.classList.add('is-closing');
    // 视图收回去：下一次业务 setView('settings') 的「点亮」对 MutationObserver
    // 来说才是一次真实的属性变化，重复打开的拦截才接得上。
    if (st.viewEl) st.viewEl.hidden = true;
    var viaView = st.openedViaView;
    st.openedViaView = false;
    if (viaView) restoreAppView();
    function finishClose() {
      st.closeTimer = 0;
      st.closing = false;
      if (st.root) {
        st.root.hidden = true;
        st.root.classList.remove('is-closing');
      }
      st.open = false;
      // 退场期间视图可能被业务重新点亮过（见 onViewHiddenChange 的 closing
      // 分支）；这里统一收回去，下一次 setView('settings') 的「点亮」才又是
      // 一次可拦截的属性变化。
      if (st.viewEl) st.viewEl.hidden = true;
      // skset-modal-open 是底层隔离标记（CSS 给 .app/.bar/.topbar 关点击），
      // 必须在退场动画之后摘，动画期间隔离还得生效。
      document.body.classList.remove('skset-modal-open');
      var focus = options && options.focusTarget || st.lastFocus;
      if (focus && focus.focus) {
        try { focus.focus({ preventScroll: true }); } catch (e) { focus.focus(); }
      }
      st.lastFocus = null;
    }
    if (options && options.immediate) finishClose();
    else st.closeTimer = setTimeout(finishClose, MODAL_EXIT_MS);
  }

  function onNavClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('.skset-link') : null;
    if (!b) return;
    var key = b.dataset.sksetKey;
    hideAll();
    var g = entryGroup(key);
    if (g) g.hidden = false;
    st.active = key;
    writeSectionKey(key);
    renderPaneHead();
    paintNav();
  }

  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    if (!st.open) return;
    // preventDefault 拦下 app.js 的全局 Esc（它会 setView(state.view)，在
    // 设置页上等于把刚藏回去的视图又点亮）。浮层是模态的，Esc 的语义
    // 只有一个：关浮层。
    e.preventDefault();
    closeSheet();
  }

  // -------------------------------------------------------------------------
  // 入口拦截：业务把 view-settings 点亮 = 想开设置
  // -------------------------------------------------------------------------
  //
  // 可见性归浮层管：视图住在浮层右栏里，浮层开着它就必须可见（内容才渲染），
  // 关闭时收回去（下一次 setView('settings') 的「点亮」才是可拦截的信号）。
  // 注意 openSheet 自己的 unhide 也会到达本回调 —— 那时 st.open 已经是 true，
  // 走「保持可见」分支，不会把自己刚点亮的视图又按回去（那是第一版
  // 「右栏空白」事故的全部原因）。
  function onViewHiddenChange() {
    if (!mounted || !st.viewEl) return;
    if (st.viewEl.hidden) {
      // 藏回去的两来路：closeSheet 开场那一藏（退场中，是它有意的），以及
      // 业务程序化 setView 到别的视图（浮层还开着，以浮层为准，重新点亮）。
      if (st.closing) return;
      if (st.open) st.viewEl.hidden = false;
      return;
    }
    // 点亮的两来路：openSheet 自己（st.open 已置位，忽略），以及业务
    // setView('settings') 撞在关着的浮层上 —— 这才是要拦的入口。
    if (st.open || st.closing) return;
    st.openedViaView = true;
    openSheet(null);
  }

  // -------------------------------------------------------------------------
  // 挂载 / 卸载
  // -------------------------------------------------------------------------

  function mount() {
    if (mounted) return;
    var view = byId('view-settings');
    if (!view) return;
    if (!window.SkinShared) return;
    mounted = true;
    moves = window.SkinShared.createMoves('skset-anchor', 'data-skset');
    built = window.SkinShared.createBuilt();

    var root = make('div', 'skset-modal');
    root.hidden = true;

    var scrim = make('div', 'skset-modal-scrim', root);
    scrim.addEventListener('click', function () { closeSheet(); });

    var card = make('section', 'skset-modal-card', root);
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', '设置');

    // 卡片头：左上角「设置」标题 + 右上角关闭键同一行。此前头部只有一颗
    // 绝对定位的关闭键，左上角空着；标题进卡片后，body 的顶部内边距不再
    // 需要给关闭键让位（见 skins.css 的 .skset-modal-body）。
    var head = make('div', 'skset-modal-head', card);
    var title = make('h2', '', head);
    title.textContent = '设置';

    var close = make('button', 'skset-modal-close', head);
    close.type = 'button';
    close.setAttribute('aria-label', '关闭设置');
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-close"/></svg>';
    close.addEventListener('click', function () { closeSheet(); });

    var body = make('div', 'skset-modal-body', card);
    var layout = make('div', 'skset-layout', body);
    var nav = make('nav', 'skset-nav', layout);
    nav.setAttribute('aria-label', '设置分类');
    var pane = make('div', 'skset-pane', layout);
    var paneHead = make('div', 'skset-pane-head', pane);
    var paneTitle = make('h2', '', paneHead);
    var paneDesc = make('p', '', paneHead);

    document.body.appendChild(root);

    st.root = root;
    st.card = card;
    st.closeBtn = close;
    st.nav = nav;
    st.pane = pane;
    st.paneTitle = paneTitle;
    st.paneDesc = paneDesc;
    st.viewEl = view;
    st.open = false;
    st.closing = false;
    st.openedViaView = false;

    // 搬进浮层右栏（原位留锚点，卸载时严格回位），回中栏时收着。
    moves.relocate(view, pane);
    view.hidden = true;
    claimGroups();

    nav.addEventListener('click', onNavClick);
    keyHandler = onKeydown;
    document.addEventListener('keydown', keyHandler);
    viewObserver = new MutationObserver(onViewHiddenChange);
    viewObserver.observe(view, { attributes: true, attributeFilter: ['hidden'] });
  }

  function unmount() {
    if (!mounted) return;
    if (viewObserver) { viewObserver.disconnect(); viewObserver = null; }
    if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
    clearTimeout(st.closeTimer);
    st.closeTimer = 0;
    document.body.classList.remove('skset-modal-open');
    if (st.root) st.root.classList.remove('is-closing');
    if (st.nav) st.nav.removeEventListener('click', onNavClick);
    showAll();
    if (st.viewEl) st.viewEl.hidden = true;
    // 先还原业务节点，再拆自建浮层 —— 反过来的话 removeBuilt 会连着
    // view-settings 一起删（它此刻还挂在浮层里）。
    if (moves) { moves.restore(); moves = null; }
    if (built) { built.remove(); built = null; }
    st.root = null;
    st.card = null;
    st.closeBtn = null;
    st.nav = null;
    st.pane = null;
    st.paneTitle = null;
    st.paneDesc = null;
    st.viewEl = null;
    st.entries = [];
    st.sections = [];
    st.active = '';
    st.open = false;
    st.closing = false;
    st.openedViaView = false;
    st.lastFocus = null;
    mounted = false;
  }

  // -------------------------------------------------------------------------
  // 皮肤接入：没有自有生命周期脚本的皮肤在这里代管。
  // registerLifecycle 对已有生命周期的皮肤（liunian/qingfeng/heijiao/orbit）是
  // no-op，所以这份名单写宽一点也不冲突。
  // -------------------------------------------------------------------------

  function attach() {
    if (!window.Skins || typeof window.Skins.registerLifecycle !== 'function') return;
    MANAGED_SKINS.forEach(function (id) {
      window.Skins.registerLifecycle(id, { mount: mount, unmount: unmount });
    });
  }

  attach();

  // 暴露给其它皮肤的生命周期与契约/排障脚本。
  window.SkinSettingsSheet = {
    mount: mount,
    unmount: unmount,
    open: function (trigger) { openSheet(trigger); },
    close: closeSheet,
    isOpen: function () { return mounted && st.open; },
    isMounted: function () { return mounted; },
    /// 契约脚本用：当前认领结果与激活分类的只读快照。
    info: function () {
      return {
        mounted: mounted,
        open: st.open,
        active: st.active,
        entries: st.entries.map(function (e) { return { key: e.key, label: e.label }; }),
        viewInPane: !!(st.viewEl && st.pane && st.pane.contains(st.viewEl)),
      };
    },
  };
})();
