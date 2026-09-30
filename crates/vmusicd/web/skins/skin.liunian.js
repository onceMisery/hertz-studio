// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 皮肤：liunian（流年）—— DOM 重编排层（零依赖 IIFE）。
//
// 背景
// ----
// 本项目是 SPA：.rail 导航 → .column 六个视图 → .stage 舞台，.bar 是 body 末尾
// 的播放条。VCPChat/Musicmodules（VMusic）的骨架与此完全不同：
//   左栏 = 搜索 + 操作按钮 + tabs + **歌曲列表本体**；
//   中栏 = **文档流播放卡** + 内容区；
//   右栏 = 频谱 + 歌词。
// 单靠 CSS 无法把「列表本体」移出视图容器、把播放条搬进中栏，所以流年皮肤
// 除 skin.liunian.css 外还有本文件：皮肤激活时做可逆的 DOM 重编排，切走时
// 经锚点逐一还原，恢复到与本文件从未运行过一致的状态。
//
// 契约
// ----
//   · 只搬运/包裹已有节点 + 新建带 ln-/bar-row1 类名的结构节点，不改任何
//     业务 JS 的状态与事件（原有监听器随节点一起走，不丢）；
//   · 每个搬运的节点原位留一个 <span class="ln-anchor">，还原时 insertBefore
//     回锚点再删锚点，原顺序严格保持；
//   · 视图切换联动用 MutationObserver（观察 .view 的 hidden），不 hook 业务代码。

(function () {
  'use strict';

  var SKIN_ID = 'liunian';

  var mounted = false;
  var moves = [];     // { node, anchor }：搬运记录，后进先出地还原
  var built = [];     // 本文件新建的节点，卸载时 remove
  var observer = null;
  var libraryObserver = null;
  var refs = {};      // 重编排队列里的 DOM 引用
  var savedText = []; // 临时改过的文本，{ node, text }
  var activeTab = 'all';
  var reflowQueued = false;

  // 左栏折叠状态（持久化）；进入设置前的视图记忆。
  var COLLAPSE_KEY = 'vmusic.ln-rail-collapsed';
  var CAPSULE_KEY = 'vmusic.ln-capsule';
  var lastWorkView = 'library'; // data-view 名（不含 settings/daily）
  var keyHandler = null;

  function $(sel, root) { return (root || document).querySelector(sel); }

  function byId(id) { return document.getElementById(id); }

  // -------------------------------------------------------------------------
  // 节点搬运（锚点还原）
  // -------------------------------------------------------------------------

  function relocate(node, parent, before) {
    if (!node || !parent) return node || null;
    var anchor = document.createElement('span');
    anchor.className = 'ln-anchor';
    anchor.setAttribute('data-ln', '1');
    node.parentNode.insertBefore(anchor, node);
    if (before) parent.insertBefore(node, before);
    else parent.appendChild(node);
    moves.push({ node: node, anchor: anchor });
    return node;
  }

  function restoreMoves() {
    // 后进先出：被包裹进新节点的（如 disc-wrap 进 .bar-row1），bar-row1 作为
    // built 会在 restoreMoves 之后删除——先把内层还原到锚点（锚点在原容器），
    // 顺序天然安全。
    for (var i = moves.length - 1; i >= 0; i -= 1) {
      var m = moves[i];
      if (m.anchor.parentNode) m.anchor.parentNode.insertBefore(m.node, m.anchor);
      if (m.anchor.parentNode) m.anchor.remove();
    }
    moves = [];
  }

  // -------------------------------------------------------------------------
  // 新建结构节点
  // -------------------------------------------------------------------------

  function make(tag, cls, parent) {
    var n = document.createElement(tag || 'div');
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    built.push(n);
    return n;
  }

  function removeBuilt() {
    built.forEach(function (n) {
      if (n.parentNode) n.parentNode.removeChild(n);
    });
    built = [];
  }

  // -------------------------------------------------------------------------
  // 左栏构建
  // -------------------------------------------------------------------------

  function buildLeft(rail) {
    // 顶部控制条：折叠/展开切换按钮（始终可见；窄屏由 CSS 隐藏，走抽屉机制）。
    refs.railbar = make('div', 'ln-railbar', rail);
    refs.collapseBtn = make('button', 'ln-collapse-btn', refs.railbar);
    refs.collapseBtn.type = 'button';
    refs.collapseBtn.title = '收起侧栏 (Ctrl+B)';
    refs.collapseBtn.setAttribute('aria-label', '收起侧栏');
    refs.collapseBtn.innerHTML = '<span class="ln-cb-glyph" aria-hidden="true">«</span>';

    // 搜索槽（.topsearch 由顶栏移入）
    refs.searchSlot = make('div', 'ln-search', rail);

    // 操作按钮：本地 / 云端导入
    refs.actions = make('div', 'ln-actions', rail);
    refs.btnLocal = make('button', '', refs.actions);
    refs.btnLocal.id = 'ln-btn-local';
    refs.btnLocal.type = 'button';
    refs.btnLocal.textContent = '添加音乐';
    refs.btnCloud = make('button', '', refs.actions);
    refs.btnCloud.id = 'ln-btn-cloud';
    refs.btnCloud.type = 'button';
    refs.btnCloud.textContent = '在线找歌';

    // tabs：全部/专辑/歌手/歌单
    refs.tabs = make('div', 'ln-tabs', rail);
    [
      { id: 'all', label: '全部', count: true },
      { id: 'albums', label: '专辑' },
      { id: 'artists', label: '歌手' },
      { id: 'playlists', label: '歌单' }
    ].forEach(function (t) {
      var b = make('button', 'ln-tab' + (t.id === 'all' ? ' active' : ''), refs.tabs);
      b.type = 'button';
      b.dataset.tab = t.id;
      b.textContent = t.label;
      if (t.count) {
        var c = document.createElement('span');
        c.className = 'count';
        c.id = 'ln-all-count';
        c.textContent = '0';
        b.appendChild(c);
      }
    });

    // 列表区与六个槽位（曲库/队列/收藏/在线/歌单/分类）
    refs.listWrap = make('div', 'ln-list', rail);
    refs.slotLib = make('div', 'ln-slot on', refs.listWrap);
    refs.slotCategory = make('div', 'ln-slot', refs.listWrap);

    // 底部：新建歌单（VMusic 仅歌单 tab 可见，默认隐藏）
    refs.footer = make('div', 'ln-footer is-hidden', rail);
    refs.newPl = make('button', 'ln-newpl', refs.footer);
    refs.newPl.type = 'button';
    refs.newPl.innerHTML = '<span>+</span> 新建歌单';
  }

  // -------------------------------------------------------------------------
  // 视图/tab 联动
  // -------------------------------------------------------------------------

  function showSlot(slot) {
    [refs.slotLib, refs.slotCategory].forEach(function (s) {
      s.classList.toggle('on', s === slot);
    });
  }

  function ensureView(view) {
    var railItem = refs.rail.querySelector('.rail-item[data-view="' + view + '"]');
    if (railItem && !railItem.classList.contains('active')) railItem.click();
    return railItem;
  }

  // 从曲库行 DOM 聚合专辑/歌手分组，生成 VMusic 分类卡片。
  function renderCategory(kind) {
    var slot = refs.slotCategory;
    slot.textContent = '';
    var groups = Object.create(null);
    var order = [];

    refs.slotLib.querySelectorAll('.track').forEach(function (row) {
      var name;
      var art = null;
      if (kind === 'albums') {
        var a = row.querySelector('.t-album');
        name = a ? a.textContent.trim() : '';
      } else {
        var s = row.querySelector('.t-sub');
        name = s ? s.textContent.trim() : '';
      }
      if (!name || name === '—') name = kind === 'albums' ? '未知专辑' : '未知艺术家';
      if (!groups[name]) {
        groups[name] = { name: name, count: 0 };
        order.push(name);
        var artDiv = row.querySelector('.t-art');
        var bg = artDiv ? artDiv.style.backgroundImage : '';
        if (bg && bg !== 'none' && bg.indexOf('url(') === 0) groups[name].art = bg;
      }
      groups[name].count += 1;
    });

    order
      .map(function (n) { return groups[n]; })
      .sort(function (x, y) { return y.count - x.count; })
      .forEach(function (g) {
        var cat = document.createElement('button');
        cat.type = 'button';
        cat.className = 'ln-cat' + (kind === 'artists' ? ' is-artist' : '');
        slot.appendChild(cat);
        var cover = document.createElement('span');
        cover.className = 'ln-cat-cover';
        cat.appendChild(cover);
        if (g.art) cover.style.backgroundImage = g.art;
        var info = document.createElement('span');
        info.className = 'ln-cat-info';
        cat.appendChild(info);
        var nm = document.createElement('span');
        nm.className = 'ln-cat-name';
        info.appendChild(nm);
        nm.textContent = g.name;
        var ct = document.createElement('span');
        ct.className = 'ln-cat-count';
        info.appendChild(ct);
        ct.textContent = g.count + ' 首';
        cat.addEventListener('click', function () {
          applyLibFilter(kind, g.name);
        });
      });
  }

  // 点分类卡片 → 操作曲库的歌手/专辑筛选下拉，然后回全部 tab。
  function applyLibFilter(kind, name) {
    var select = byId(kind === 'albums' ? 'lib-album-filter' : 'lib-artist-filter');
    if (select) {
      var opt = Array.prototype.find.call(select.options, function (o) {
        return o.textContent.trim() === name.trim();
      });
      if (opt && select.value !== opt.value) {
        select.value = opt.value;
        if (typeof select.onchange === 'function') select.onchange();
      }
    }
    setTab('all');
  }

  function setTab(tab) {
    activeTab = tab;
    Array.prototype.forEach.call(refs.tabs.querySelectorAll('.ln-tab'), function (b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    refs.footer.classList.toggle('is-hidden', tab !== 'playlists');

    if (tab === 'all') {
      showSlot(refs.slotLib);
    } else if (tab === 'albums' || tab === 'artists') {
      renderCategory(tab);
      showSlot(refs.slotCategory);
    } else if (tab === 'playlists') {
      showSlot(refs.slotLib);
    }
  }

  function currentViewId() {
    var v = refs.column.querySelector('.view:not([hidden])');
    return v ? v.id : '';
  }

  // 视图切换（业务代码切 .view hidden）后的左栏重排。
  function reflow() {
    var id = currentViewId();
    if (refs.viewId !== id) refs.column.scrollTop = 0;
    refs.viewId = id;
    var dailyNav = refs.rail.querySelector('[data-view="daily"]');
    if (refs.dailyMore) refs.dailyMore.hidden = !dailyNav || dailyNav.hidden;
    if (dailyNav && observer) observer.observe(dailyNav, { attributes: true, attributeFilter: ['hidden'] });
    refs.column.dataset.lnView = id.replace(/^view-/, '');
    refs.nav.querySelectorAll('[data-ln-view]').forEach(function (button) {
      var selected = button.dataset.lnView === (id === 'view-daily' ? 'library' : id.replace(/^view-/, ''));
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    // 记录最近一个非设置视图：设置页「返回」要精确回到这里（含每日推荐）。
    if (id && id !== 'view-settings') {
      lastWorkView = id.replace(/^view-/, '');
    }
    if (id === 'view-library') {
      setTab(activeTab === 'playlists' ? 'all' : activeTab);
    } else if (id === 'view-playlists') {
      setTab('playlists');
    } else if (id === 'view-queue') {
      setTab('all');
    } else if (id === 'view-favorites') {
      setTab('all');
    } else if (id === 'view-online') {
      setTab('all');
    } else if (id === 'view-settings') {
      // VMusic 左栏始终是曲库内容，设置在中栏播放卡下方。
      setTab('all');
    } else if (id === 'view-daily') {
      setTab('all');
    }
    // 窄屏切视图后收起左抽屉
    document.body.classList.remove('ln-left-open');
  }

  function scheduleReflow() {
    if (reflowQueued) return;
    reflowQueued = true;
    requestAnimationFrame(function () {
      reflowQueued = false;
      if (mounted) reflow();
    });
  }

  // -------------------------------------------------------------------------
  // 左栏折叠/展开（body 单一状态类驱动；CSS 负责过渡，JS 不写内联尺寸）
  // -------------------------------------------------------------------------

  function readCollapsed() {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; }
    catch (e) { return false; }
  }

  function writeCollapsed(on) {
    try { localStorage.setItem(COLLAPSE_KEY, on ? '1' : '0'); }
    catch (e) { /* 隐私模式等写入失败不阻塞 */ }
  }

  function setCollapsed(on, silent) {
    on = !!on;
    document.body.classList.toggle('ln-rail-collapsed', on);
    if (refs.collapseBtn) {
      refs.collapseBtn.title = (on ? '展开侧栏' : '收起侧栏') + ' (Ctrl+B)';
      refs.collapseBtn.setAttribute('aria-label', on ? '展开侧栏' : '收起侧栏');
      refs.collapseBtn.setAttribute('aria-expanded', on ? 'false' : 'true');
      var glyph = $('.ln-cb-glyph', refs.collapseBtn);
      if (glyph) glyph.textContent = on ? '»' : '«';
    }
    if (!silent) writeCollapsed(on);
  }

  function toggleCollapsed() {
    // 窄屏左栏是抽屉（品牌/遮罩机制），折叠按钮在该宽度已隐藏，
    // 此处兜底不执行两套互相冲突的机制。
    if (window.innerWidth <= 1000) return;
    setCollapsed(!document.body.classList.contains('ln-rail-collapsed'));
  }

  // -------------------------------------------------------------------------
  // 设置页：返回按钮 + 回到来源视图
  // -------------------------------------------------------------------------

  function buildSettingsChrome() {
    var left = $('#view-settings .col-head-left');
    if (!left) return;
    refs.backBtn = make('button', 'ln-back-btn'); // 不传 parent：要插到标题前
    refs.backBtn.type = 'button';
    refs.backBtn.innerHTML = '<span class="ln-back-glyph" aria-hidden="true">←</span> 返回';
    left.insertBefore(refs.backBtn, left.firstChild);
  }

  function closeSettings() {
    var item = refs.rail.querySelector('.rail-item[data-view="' + lastWorkView + '"]');
    if (item) item.click();
  }

  // -------------------------------------------------------------------------
  // 播放卡重排
  // -------------------------------------------------------------------------

  function rearrangeBar(bar) {
    // 行1：唱片（变方封面）+ 曲目信息
    var row1 = make('div', 'bar-row1');
    relocate($('.disc-wrap', refs.stage), row1);
    relocate(byId('bar-track'), row1);
    bar.insertBefore(row1, bar.firstChild);

    // 行2：进度（bar-progress 提到 bar-controls 之前；track 移走后 controls 在首）
    var controls = $('.bar-controls', bar);
    var progress = $('.bar-progress', bar);
    // 全部走 relocate：原位留锚点，unmount 经 restoreMoves 严格回位
    // （直接 DOM 操作会让切走皮肤后 progress/controls 顺序错乱）。
    if (progress && controls) relocate(progress, bar, controls);

    // 行3：模式按钮进 controls 最左，音量进最右（VMusic 控制序）。
    var mode = byId('mode');
    var volume = $('.bar-volume', bar);
    if (mode) relocate(mode, controls, controls.firstChild);
    if (volume) relocate(volume, controls);
  }

  function buildNavigation() {
    refs.nav = make('nav', 'ln-nav');
    refs.nav.setAttribute('aria-label', '页面导航');
    refs.column.insertBefore(refs.nav, refs.column.firstChild);
    [['library', '首页'], ['online', '在线'], ['playlists', '歌单'],
      ['favorites', '收藏'], ['queue', '队列'], ['settings', '设置']].forEach(function (entry) {
      var button = make('button', 'ln-nav-item', refs.nav);
      button.type = 'button';
      button.dataset.lnView = entry[0];
      button.textContent = entry[1];
      button.addEventListener('click', function () { ensureView(entry[0]); refs.column.scrollTop = 0; });
    });
    refs.mobileSearch = make('div', 'ln-mobile-search');
    refs.nav.after(refs.mobileSearch);
  }

  function setCapsule(compact, silent) {
    refs.bar.classList.toggle('ln-capsule', compact);
    refs.capsuleBtn.textContent = compact ? '展开' : '收为胶囊';
    refs.capsuleBtn.setAttribute('aria-expanded', String(!compact));
    refs.capsuleBtn.setAttribute('aria-label', compact ? '展开播放卡' : '收为播放胶囊');
    if (!silent) {
      refs.capsulePreference = compact;
      try { localStorage.setItem(CAPSULE_KEY, compact ? '1' : '0'); } catch (error) {}
    }
  }

  function buildPlayerChrome() {
    var heading = make('div', 'ln-player-heading');
    refs.bar.insertBefore(heading, refs.bar.firstChild);
    make('span', 'ln-player-label', heading).textContent = '此刻，听见';
    var actions = make('div', 'ln-player-actions', heading);
    var stageButton = make('button', 'ln-stage-entry', actions);
    stageButton.type = 'button';
    stageButton.textContent = '凝彩舞台 ↗';
    stageButton.addEventListener('click', function () {
      if (!window.Stage3D) return;
      window.Stage3D.configure({ foliaVisual: 'tempera', foliaBg: 'solid', lyrics: true, stageTheme: 'starfall' });
      window.Stage3D.open();
      window.Stage3D.save();
    });
    refs.capsuleBtn = make('button', 'ln-capsule-toggle', actions);
    refs.capsuleBtn.type = 'button';
    refs.capsuleBtn.addEventListener('click', function () {
      setCapsule(!refs.bar.classList.contains('ln-capsule'));
    });
    refs.capsulePreference = null;
    try {
      var preference = localStorage.getItem(CAPSULE_KEY);
      if (preference === '0' || preference === '1') refs.capsulePreference = preference === '1';
    } catch (error) {}
    setCapsule(refs.capsulePreference === null ? window.innerWidth <= 620 : refs.capsulePreference, true);
  }

  function buildHomeChrome() {
    var tools = $('#view-library .col-tools');
    if (tools) {
      refs.libraryTools = make('details', 'ln-library-tools', tools.parentNode);
      make('summary', '', refs.libraryTools).textContent = '曲库管理';
      relocate(tools, refs.libraryTools);
    }
    var dailyHead = $('#daily-strip .daily-head');
    if (dailyHead) {
      var more = make('button', 'ln-daily-more', dailyHead);
      refs.dailyMore = more;
      more.type = 'button';
      more.textContent = '查看全部 →';
      more.addEventListener('click', function () { ensureView('daily'); });
    }
  }

  function syncResponsive() {
    if (refs.capsulePreference === null) setCapsule(window.innerWidth <= 620, true);
    var narrow = window.innerWidth <= 1000;
    if (refs.narrow === narrow) return;
    refs.narrow = narrow;
    refs.libraryNodes.forEach(function (node) {
      var entry = moves.find(function (move) { return move.node === node; });
      if (narrow && entry) entry.anchor.after(node);
      else refs.slotLib.appendChild(node);
    });
    (narrow ? refs.mobileSearch : refs.searchSlot).appendChild(refs.search);
    setCollapsed(!narrow && readCollapsed(), true);
  }

  // -------------------------------------------------------------------------
  // 安装 / 卸载
  // -------------------------------------------------------------------------

  function mount() {
    if (mounted) return;
    var rail = byId('rail');
    var column = byId('column');
    var stage = byId('stage');
    var bar = $('.bar');
    if (!rail || !column || !stage || !bar) return; // DOM 未就绪，等 skin:changed 再试

    mounted = true;
    refs.rail = rail;
    refs.column = column;
    refs.stage = stage;
    refs.bar = bar;

    // 1) 左栏骨架
    buildLeft(rail);

    // 2) 列表节点入槽
    refs.search = relocate($('.topsearch'), refs.searchSlot);

    // 注意：曲库表头的 id 是 lib-hint（class lib-head），用视图作用域选择器，
    // 避免误选收藏视图的 .lib-head.fav-head。
    refs.libraryNodes = [byId('lib-empty'), $('#view-library .lib-head'), byId('lib-list'),
      byId('lib-sentinel'), byId('lib-batch-bar')].filter(Boolean);
    refs.libraryNodes.forEach(function (node) { relocate(node, refs.slotLib); });

    // 3) 播放卡：先把 .bar 搬进中栏最前，再重排内部
    relocate(bar, column, column.firstChild);
    rearrangeBar(bar);
    buildPlayerChrome();
    buildNavigation();
    buildHomeChrome();

    // 4) 频谱卡标题对齐 VMusic（VOCAL PERFORMANCE）
    var kicker = $('.stage-kicker', stage);
    if (kicker) {
      savedText.push({ node: kicker, text: kicker.textContent });
      kicker.textContent = 'Vocal Performance';
    }

    // 5) 交互
    refs.tabs.addEventListener('click', function (e) {
      var b = e.target.closest('.ln-tab');
      if (!b) return;
      var tab = b.dataset.tab;
      if (tab === 'all' || tab === 'albums' || tab === 'artists') {
        ensureView('library');
        setTab(tab);
      } else if (tab === 'playlists') {
        ensureView('playlists');
        setTab('playlists');
      }
    });

    refs.btnLocal.addEventListener('click', function () {
      ensureView('library');
      var toggle = byId('scan-toggle');
      if (toggle) toggle.click();
    });

    refs.btnCloud.addEventListener('click', function () {
      ensureView('online');
    });

    refs.newPl.addEventListener('click', function () {
      ensureView('playlists');
      var input = byId('new-playlist-name');
      if (input) input.focus();
    });

    // 窄屏左栏开关：品牌点击 + 遮罩
    var scrim = make('div');
    scrim.id = 'ln-left-scrim';
    document.body.appendChild(scrim);
    scrim.addEventListener('click', function () {
      document.body.classList.remove('ln-left-open');
    });

    // 设置页头部「返回」
    buildSettingsChrome();
    if (refs.backBtn) {
      refs.backBtn.addEventListener('click', closeSettings);
    }

    // 左栏折叠/展开：按钮 + 快捷键 Ctrl/Cmd+B
    refs.collapseBtn.addEventListener('click', toggleCollapsed);
    keyHandler = function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        if (window.innerWidth > 1000) toggleCollapsed();
        else document.body.classList.remove('ln-left-open'); // 窄屏=关抽屉
      }
    };
    document.addEventListener('keydown', keyHandler);

    // 跨断点同步：窄屏左栏是抽屉，collapsed 的栅格规则（特异性更高）会压过
    // 单列媒体查询，所以窄屏临时解除类（不动 storage）；回到宽屏按持久化恢复。
    refs.resizeHandler = syncResponsive;
    window.addEventListener('resize', refs.resizeHandler);

    // 恢复上次的折叠状态（silent：同值仍落一次 storage，无害；CSS 过渡即反馈）。
    syncResponsive();

    // 6) 视图切换联动
    observer = new MutationObserver(scheduleReflow);
    Array.prototype.forEach.call(column.querySelectorAll('.view'), function (v) {
      observer.observe(v, { attributes: true, attributeFilter: ['hidden'] });
    });
    observer.observe(rail, { childList: true });
    libraryObserver = new MutationObserver(function () {
      syncLibraryCount();
      if (activeTab === 'albums' || activeTab === 'artists') renderCategory(activeTab);
    });
    libraryObserver.observe(byId('lib-count'), { childList: true, subtree: true, characterData: true });
    libraryObserver.observe(byId('lib-list'), { childList: true });
    syncLibraryCount();

    reflow();
  }

  function unmount() {
    if (!mounted) return;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (libraryObserver) { libraryObserver.disconnect(); libraryObserver = null; }
    restoreMoves();
    refs.bar.classList.remove('ln-capsule');
    delete refs.column.dataset.lnView;
    removeBuilt();
    if (keyHandler) {
      document.removeEventListener('keydown', keyHandler);
      keyHandler = null;
    }
    if (refs.resizeHandler) {
      window.removeEventListener('resize', refs.resizeHandler);
    }
    savedText.forEach(function (s) { s.node.textContent = s.text; });
    savedText = [];
    document.body.classList.remove('ln-left-open', 'ln-rail-collapsed');
    refs = {};
    mounted = false;
    activeTab = 'all';
  }

  function syncLibraryCount() {
    var count = byId('lib-count');
    var label = byId('ln-all-count');
    if (count && label) label.textContent = (count.textContent.match(/\d+/) || ['0'])[0];
  }

  function isActiveSkin() {
    return document.documentElement.getAttribute('data-skin') === SKIN_ID;
  }

  function onSkinChanged(e) {
    var id = e && e.detail ? e.detail.id
      : document.documentElement.getAttribute('data-skin');
    if (id === SKIN_ID) mount();
    else unmount();
  }

  document.addEventListener('skin:changed', onSkinChanged);

  // 脚本在 skins.js 之后加载：若启动时已是流年（理论上 Skins.init 尚未跑，
  // 初始 data-skin 为空），保险处理一次。
  if (isActiveSkin()) mount();

  // 暴露仅用于排障/契约脚本：返回当前挂载状态。
  window.__lnSkin = {
    isMounted: function () { return mounted; },
    reflow: function () { if (mounted) reflow(); }
  };
})();
