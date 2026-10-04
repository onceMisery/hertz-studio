// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 皮肤：qingfeng（清风）—— DOM 重编排层（零依赖 IIFE）。
//
// 背景
// ----
// 本项目是 SPA：.rail 导航 → .column 六个视图 → .stage 舞台，.bar 是 body 末尾的
// 播放条。清风对骨架做如下调整：
//   · 移除最左侧 .rail 导航轨（display:none，节点保留以备程序化点击与还原），
//     改用**顶部居中胶囊主菜单**（歌单 / 电台 / 专辑 / 收藏 / 本地 + 队列拼接图标）；
//   · 左上角在品牌旁挂一枚设置按钮（沿用顶栏既有的设置入口语义）；
//   · 右下角新建「头像 + 箭头」控件：头像开登录，箭头跳舞台播放页；
//   · 「队列拼接」是本皮肤的特色页：全屏海报墙，队列循环铺满，中央一张展开大卡；
//   · 「设置」不进中栏视图，而是把 #view-settings 搬进浮层（遮罩 + 卡片），
//     浮层内再分「左栏两级分类 + 右栏内容」两栏；
//   · 搜索留在顶栏右侧，播放条收成底部居中胶囊。
//
// 契约
// ----
//   · 只搬运/包裹已有节点 + 新建带 qf-*/bar-row1 类名的结构节点，不改任何业务 JS
//     的状态与事件（原有监听器随节点一起走，不丢）；
//   · 每个搬运的节点原位留一个 <span class="qf-anchor">，还原时 insertBefore 回
//     锚点再删锚点，原顺序严格保持；
//   · 视图切换联动用 MutationObserver（观察 .view 的 hidden），不 hook 业务代码；
//   · 播放/取数经 document 上的 `qf:panel` 自定义事件交给 app.js 分流。
//
// 队列拼接页的数据来源
// --------------------
// 海报墙需要「队列里有哪些歌、哪首在放」。这两件事都在 app.js 的闭包里
// （state.queue / state.snapshot），皮肤拿不到，所以走一条只读的自定义事件：
// 皮肤发 `qf:queue-request`，app.js 回一份快照。海报墙自己不发播放请求，
// 点击只发 `qf:play-index`，由 app.js 真正落 play —— 播放路径只有一条，
// 不会出现「皮肤点一下、app.js 又点一下」的双触发。

(function () {
  'use strict';

  var SKIN_ID = 'qingfeng';

  var mounted = false;
  var moves = [];      // { node, anchor }：搬运记录，后进先出地还原
  var built = [];      // 本文件新建的节点，卸载时 remove
  var observer = null;
  var refs = {};       // 重编排队列里的 DOM 引用
  var inReflow = false;
  var keyHandler = null;

  // 设置浮层运行态。viewEl 是被搬进浮层的 #view-settings 本体，
  // lastFocus 用于关闭后把焦点还给触发按钮。
  var sheet = {
    root: null,
    card: null,
    viewEl: null,
    open: false,
    closing: false,
    closeTimer: 0,
    lastFocus: null,
    nav: null,
    entries: [],
    active: '',
  };

  // 海报墙（队列拼接）运行态。
  var wall = {
    root: null,
    world: null,
    field: null,
    open: false,
    tiles: [],        // 去重后的队列项
    posters: [],      // 当前挂载的海报 DOM
    focused: -1,      // 键盘焦点所在的海报下标
    expanded: -1,     // 展开档所在的下标
    cam: { x: 0, y: 0, s: 1 },
    raf: 0,
    lightsOut: false,
    queueKey: '',     // 队列指纹，变了才重建
    entranceDone: false,
  };

  var SECTION_KEY = 'vmusic.qf-set-section';
  var WALL_KEY = 'vmusic.qf-wall';

  // 退场动画时长，与 skin.qingfeng.css 里 .qf-modal-card 的 transition 时长对齐。
  // CSS 改了就同步改这里，否则会出现「动画还没完内容先消失」。
  var MODAL_EXIT_MS = 200;

  // --- 海报墙常量（与 CSS 的 --qf-cell / --qf-cell-gap 对齐） ----------------
  var CELL = 128;        // 单元格边长（世界坐标）
  var GAP = 8;           // 卡片间隙
  var PITCH = CELL + GAP;
  var BLOCK_COLS = 12;   // 一个密排地块 12 列
  var BLOCK_ROWS = 8;    // 8 行
  var EXPAND_COLS = 6;   // 展开档 6×6 单元格 —— 只有这个尺寸有精确重排解
  var EXPAND_ROWS = 6;
  var OVERSCAN = 500;    // 裁剪外扩的渲染余量
  var MAX_INSTANCES = 400;
  var ENTRANCE_STAGGER = 0.03;
  var ENTRANCE_MAX_DELAY = 0.34;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function byId(id) { return document.getElementById(id); }

  // -------------------------------------------------------------------------
  // 节点搬运（锚点还原）
  // -------------------------------------------------------------------------

  function relocate(node, parent, before) {
    if (!node || !parent) return node || null;
    var anchor = document.createElement('span');
    anchor.className = 'qf-anchor';
    anchor.setAttribute('data-qf', '1');
    node.parentNode.insertBefore(anchor, node);
    if (before) parent.insertBefore(node, before);
    else parent.appendChild(node);
    moves.push({ node: node, anchor: anchor });
    return node;
  }

  function restoreMoves() {
    // 后进先出：被包裹进新节点的，内层先还原到锚点（锚点在原容器），顺序天然安全。
    for (var i = moves.length - 1; i >= 0; i -= 1) {
      var m = moves[i];
      if (m.anchor.parentNode) m.anchor.parentNode.insertBefore(m.node, m.anchor);
      if (m.anchor.parentNode) m.anchor.remove();
    }
    moves = [];
  }

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

  // <img> 位封面：插件形态下远程地址要经 sidecar 换成 data URL（沙箱 CSP
  // 画不出 https 图）。HertzCovers 由 app.js 挂出；契约检查的沙箱只加载本
  // 模块，拿不到时回落成直接赋值。
  function applyImg(img, url) {
    if (window.HertzCovers) { window.HertzCovers.applyImg(img, url); return; }
    if (!img) return;
    if (url) img.src = url;
    else img.removeAttribute('src');
  }

  function icon(name) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  }

  // -------------------------------------------------------------------------
  // 与 app.js 通信：只读队列快照 / 请求播放
  // -------------------------------------------------------------------------

  function emit(action, extra) {
    var detail = Object.assign({ action: action }, extra || {});
    document.dispatchEvent(new CustomEvent('qf:panel', { detail: detail }));
    return detail;
  }

  /// 要队列数据。海报墙不自己读 state（那在 app.js 闭包里），发一条只读请求，
  /// app.js 同步把快照挂在 detail 上回来。
  function requestQueue() {
    var out = emit('queue-request');
    return (out && out.queue) || [];
  }

  // -------------------------------------------------------------------------
  // 视图切换：程序化点击隐藏 rail 里的按钮，复用业务 setView 链路
  // -------------------------------------------------------------------------

  function clickRailItem(view) {
    // 设置视图已被搬进浮层，程序化点击它会让 setView 把中栏其它视图全藏掉、
    // 什么也看不见。统一改成开浮层。
    if (view === 'settings') {
      openSettingsSheet();
      reflow();
      return null;
    }
    closeWall();
    var item = refs.rail.querySelector('.rail-item[data-view="' + view + '"]');
    if (item && !item.classList.contains('active')) item.click();
    if (mounted) reflow();
    return item;
  }

  // -------------------------------------------------------------------------
  // 顶部居中胶囊主菜单
  // -------------------------------------------------------------------------

  // 五个一级目的地 + 队列拼接图标。顺序按用户诉求：歌单 / 电台 / 专辑 / 收藏 / 本地。
  // 「队列拼接」不在这一排文字里，单独做成 hover 展开的图标按钮（folia 同款）。
  var NAV_ITEMS = [
    ['playlists', '歌单'],
    ['online', '电台'],
    ['daily', '专辑'],
    ['favorites', '收藏'],
    ['library', '本地'],
  ];

  function buildNav() {
    var nav = make('nav', 'qf-nav');
    nav.setAttribute('aria-label', '主导航');
    refs.nav = nav;

    NAV_ITEMS.forEach(function (entry) {
      var b = make('button', 'qf-nav-item', nav);
      b.type = 'button';
      b.dataset.qfView = entry[0];
      b.textContent = entry[1];
      b.addEventListener('click', function () { clickRailItem(entry[0]); });
    });

    // 队列拼接入口：图标常驻，文字 hover 才展开。
    var wallBtn = make('button', 'qf-nav-icon', nav);
    wallBtn.type = 'button';
    wallBtn.dataset.qfView = 'wall';
    wallBtn.setAttribute('aria-label', '队列拼接');
    wallBtn.setAttribute('aria-haspopup', 'dialog');
    wallBtn.innerHTML = icon('queue') + '<span>队列拼接</span>';
    wallBtn.addEventListener('click', function () { toggleWall(); });
    refs.wallBtn = wallBtn;

    document.body.appendChild(nav);
  }

  // -------------------------------------------------------------------------
  // 左上角设置按钮 / 右下角头像 + 箭头
  // -------------------------------------------------------------------------

  function buildBrandGroup() {
    var brand = $('.brand');
    if (!brand) return;
    // 品牌与设置按钮编成一组，整体贴左上角。
    var group = make('div', 'qf-brand-group');
    brand.parentNode.insertBefore(group, brand);
    group.appendChild(brand);

    var btn = make('button', 'qf-settings-btn', group);
    btn.type = 'button';
    btn.title = '设置';
    btn.setAttribute('aria-label', '打开设置');
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.innerHTML = icon('settings');
    btn.addEventListener('click', function () {
      if (sheet.open) closeSettingsSheet();
      else openSettingsSheet(btn);
    });
    refs.settingsBtn = btn;
  }

  function buildAccount() {
    var box = make('div', 'qf-account');

    // 头像直接搬顶栏那颗登录按钮（#online-account-btn）：它身上已经挂着
    // 业务监听器与在线角标，复制一个头像壳子出来只会得到一个不会更新的假头像。
    var face = byId('online-account-btn');
    if (face) {
      relocate(face, box);
      refs.accountFace = face;
    }

    // 箭头：跳舞台播放页。
    var arrow = make('button', 'qf-account-arrow', box);
    arrow.type = 'button';
    arrow.title = '打开舞台';
    arrow.setAttribute('aria-label', '打开舞台播放页');
    arrow.innerHTML = icon('next');
    arrow.addEventListener('click', openStage);
    refs.accountArrow = arrow;

    document.body.appendChild(box);
  }

  function openStage() {
    closeWall();
    var stage = window.Stage3D;
    if (stage && typeof stage.open === 'function') {
      // Stage3D.open() 不带参进当前舞台；用 stageId() 明确带上，避免内部
      // 读到 undefined 之后默默不开。
      try { stage.open(stage.stageId ? stage.stageId() : undefined); }
      catch (e) { stage.open(); }
      return;
    }
    // 没有 3D 舞台时退到沉浸舞台（stage-immersive 挂在同一个键位上）。
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }));
  }

  // -------------------------------------------------------------------------
  // 队列拼接：海报墙
  // -------------------------------------------------------------------------

  /// 密排模板。folia 用 4 种基础块 + 4 种镜像 = 16 种朝向，按坐标哈希选取，
  /// 避免整墙出现肉眼可见的重复周期。这里取同样的思路，但块型更简单：
  /// 四个矩形切法 + 两种镜像。
  var BLOCKS = [
    // A：一整条 + 三分
    [[0, 0, 12, 3], [0, 3, 5, 5], [5, 3, 4, 5], [9, 3, 3, 5]],
    // B：中间大块 + 两侧条
    [[0, 0, 4, 8], [4, 0, 7, 5], [4, 5, 7, 3], [11, 0, 1, 8]],
    // C：2×2 主格 + 底部横条
    [[0, 0, 6, 4], [6, 0, 6, 4], [0, 4, 8, 4], [8, 4, 4, 4]],
    // D：竖三栏，高度错落
    [[0, 0, 4, 6], [4, 0, 4, 8], [8, 0, 4, 5], [0, 6, 8, 2]],
  ];

  function blockCells(blockIndex, blockX, blockY) {
    var tpl = BLOCKS[blockIndex % BLOCKS.length];
    // 按块坐标做奇偶翻转：两种镜像足够打散周期，又不用维护 16 份模板。
    if (((blockX + blockY) & 1) === 1) {
      return tpl.map(function (r) {
        return [BLOCK_COLS - r[0] - r[2], r[1], r[2], r[3]];
      });
    }
    return tpl;
  }

  /// 墙的裁剪范围（世界坐标）。OVERSCAN 外扩保证平移时新格子已就位。
  function wallBounds() {
    var vw = window.innerWidth || 1280;
    var vh = window.innerHeight || 800;
    var s = wall.cam.s;
    return {
      left: (-wall.cam.x - OVERSCAN) / s,
      top: (-wall.cam.y - OVERSCAN) / s,
      right: (vw - wall.cam.x + OVERSCAN) / s,
      bottom: (vh - wall.cam.y + OVERSCAN) / s,
    };
  }

  /// 一首歌在墙上出现很多次：队列去重后循环铺满。这就是 folia 的
  /// 「队列不改变地块结构，只改变每格显示哪首歌」。
  function tileFor(index) {
    if (!wall.tiles.length) return null;
    return wall.tiles[index % wall.tiles.length];
  }

  function cellRect(blockX, blockY, cell) {
    return {
      x: blockX * BLOCK_COLS * PITCH + cell[0] * PITCH,
      y: blockY * BLOCK_ROWS * PITCH + cell[1] * PITCH,
      w: cell[2] * PITCH - GAP,
      h: cell[3] * PITCH - GAP,
    };
  }

  function buildWall() {
    var root = make('section', 'qf-lattice');
    root.hidden = true;
    root.setAttribute('aria-label', '队列拼接');

    var field = make('div', 'qf-lattice-field', root);
    var world = make('div', 'qf-lattice-world', field);
    root.insertBefore(field, root.firstChild);
    // make() 已经挂到 root 上了，这里把 world 挪进 field。
    field.appendChild(world);

    var empty = make('div', 'qf-lattice-empty', root);
    var emptyTitle = make('strong', '', empty);
    emptyTitle.textContent = '队列是空的';
    var emptyHint = make('span', '', empty);
    emptyHint.textContent = '先在任意列表里加几首歌，再回到这里拼接';

    // 左下角：当前队列浮条。
    var peek = make('div', 'qf-queue-peek', root);
    var peekArt = make('div', 'qf-queue-peek-art', peek);
    var peekCopy = make('div', 'qf-queue-peek-copy', peek);
    var peekTitle = make('strong', '', peekCopy);
    var peekSub = make('span', '', peekCopy);
    peek.title = '当前队列';

    // 右下角：关灯开关 + 返回。
    var tools = make('div', 'qf-tools', root);
    var lights = make('button', 'qf-tools-btn', tools);
    lights.type = 'button';
    lights.title = '关灯';
    lights.setAttribute('aria-label', '关灯：压暗非当前播放的海报');
    lights.setAttribute('aria-pressed', 'false');
    lights.innerHTML = icon('disc');
    lights.addEventListener('click', function () {
      wall.lightsOut = !wall.lightsOut;
      root.classList.toggle('is-lights-out', wall.lightsOut);
      lights.classList.toggle('is-on', wall.lightsOut);
      lights.setAttribute('aria-pressed', String(wall.lightsOut));
      try { localStorage.setItem(WALL_KEY, wall.lightsOut ? '1' : '0'); } catch (e) { /* 隐私模式 */ }
    });

    var back = make('button', 'qf-tools-btn', tools);
    back.type = 'button';
    back.title = '返回';
    back.setAttribute('aria-label', '退出队列拼接');
    back.innerHTML = icon('close');
    back.addEventListener('click', closeWall);

    // 工具面板：键盘说明 + 清空队列。
    var panel = make('div', 'qf-tools-panel', tools);
    panel.hidden = true;
    var help = make('div', 'qf-set-subitem', panel);
    help.textContent = '← → 移动焦点 · Enter 播放 · Space 展开 · Esc 返回';
    var clear = make('button', 'qf-tools-action', panel);
    clear.type = 'button';
    clear.innerHTML = icon('trash') + '<span>清空队列</span>';
    clear.addEventListener('click', function () {
      var c = byId('queue-clear');
      if (c) c.click();
      closeWall();
    });

    var panelBtn = make('button', 'qf-tools-btn', tools);
    panelBtn.type = 'button';
    panelBtn.title = '说明';
    panelBtn.setAttribute('aria-label', '队列拼接说明');
    panelBtn.setAttribute('aria-expanded', 'false');
    panelBtn.innerHTML = icon('more');
    panelBtn.addEventListener('click', function () {
      var show = panel.hidden;
      panel.hidden = !show;
      panelBtn.setAttribute('aria-expanded', String(show));
    });

    // 拖拽平移。
    var drag = null;
    field.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.qf-poster-controls')) return;
      drag = { x: e.clientX, y: e.clientY, cx: wall.cam.x, cy: wall.cam.y, moved: false };
      field.setPointerCapture(e.pointerId);
    });
    field.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x;
      var dy = e.clientY - drag.y;
      // 阈值 4px：小抖动不算拖拽，否则点卡片会被吃掉一次平移。
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      drag.moved = true;
      wall.cam.x = drag.cx + dx;
      wall.cam.y = drag.cy + dy;
      applyCamera();
      renderWall();
    });
    function endDrag(e) {
      if (!drag) return;
      try { field.releasePointerCapture(e.pointerId); } catch (err) { /* 已释放 */ }
      drag = null;
    }
    field.addEventListener('pointerup', endDrag);
    field.addEventListener('pointercancel', endDrag);
    field.addEventListener('wheel', function (e) {
      e.preventDefault();
      wall.cam.y -= e.deltaY;
      applyCamera();
      renderWall();
    }, { passive: false });

    document.body.appendChild(root);

    refs.wallRoot = root;
    refs.wallField = field;
    refs.wallWorld = world;
    refs.wallEmpty = empty;
    refs.wallPeek = peek;
    refs.wallPeekArt = peekArt;
    refs.wallPeekTitle = peekTitle;
    refs.wallPeekSub = peekSub;
    refs.wallPanelBtn = panelBtn;
    wall.root = root;
    wall.field = field;
    wall.world = world;

    var saved = null;
    try { saved = localStorage.getItem(WALL_KEY); } catch (e) { saved = null; }
    wall.lightsOut = saved === '1';
    root.classList.toggle('is-lights-out', wall.lightsOut);
    lights.classList.toggle('is-on', wall.lightsOut);
    lights.setAttribute('aria-pressed', String(wall.lightsOut));

    window.addEventListener('resize', onWallResize);
  }

  function onWallResize() {
    if (!wall.open) return;
    wall.cam.s = wallScale();
    applyCamera();
    renderWall();
  }

  function wallScale() {
    var w = window.innerWidth || 1280;
    if (w < 640) return 0.52;
    if (w < 1100) return 0.64;
    return 0.76;
  }

  function applyCamera() {
    if (!wall.world) return;
    wall.world.style.transform =
      'translate3d(' + wall.cam.x + 'px,' + wall.cam.y + 'px,0) scale(' + wall.cam.s + ')';
  }

  function openWall() {
    if (wall.open) return;
    wall.open = true;
    wall.tiles = requestQueue();
    wall.queueKey = wall.tiles.map(function (t) { return t.id; }).join('|');
    wall.focused = -1;
    wall.expanded = -1;
    wall.cam.s = wallScale();
    wall.cam.x = 34;
    wall.cam.y = 80;
    if (wall.root) wall.root.hidden = false;
    document.body.classList.add('qf-lattice-open');
    if (refs.wallBtn) refs.wallBtn.classList.add('is-active');
    applyCamera();
    renderWall();
    // 自动聚焦到正在播放那张，墙一开就有主体。
    var idx = wall.tiles.findIndex(function (t) { return t.current; });
    if (idx >= 0) focusPoster(idx, true);
  }

  function closeWall() {
    if (!wall.open) return;
    wall.open = false;
    if (wall.root) wall.root.hidden = true;
    document.body.classList.remove('qf-lattice-open');
    if (refs.wallBtn) refs.wallBtn.classList.remove('is-active');
    clearPosters();
  }

  function toggleWall() {
    if (wall.open) closeWall();
    else openWall();
  }

  function clearPosters() {
    if (!wall.world) return;
    wall.world.innerHTML = '';
    wall.posters = [];
  }

  /// 重绘画布。只渲染落在裁剪区（含 OVERSCAN）里的格子，上限 MAX_INSTANCES ——
  /// 不设上限的话一次 pan 就能建出上千个节点，滚动会明显掉帧。
  function renderWall() {
    if (!wall.open || !wall.world) return;
    if (!wall.tiles.length) {
      clearPosters();
      if (refs.wallEmpty) refs.wallEmpty.hidden = false;
      return;
    }
    if (refs.wallEmpty) refs.wallEmpty.hidden = true;

    var b = wallBounds();
    var entries = [];
    var b0x = Math.floor(b.left / (BLOCK_COLS * PITCH)) - 1;
    var b1x = Math.ceil(b.right / (BLOCK_COLS * PITCH)) + 1;
    var b0y = Math.floor(b.top / (BLOCK_ROWS * PITCH)) - 1;
    var b1y = Math.ceil(b.bottom / (BLOCK_ROWS * PITCH)) + 1;

    for (var by = b0y; by <= b1y && entries.length < MAX_INSTANCES; by += 1) {
      for (var bx = b0x; bx <= b1x && entries.length < MAX_INSTANCES; bx += 1) {
        var blockIndex = Math.abs(bx * 7 + by * 13);
        var cells = blockCells(blockIndex, bx, by);
        for (var i = 0; i < cells.length && entries.length < MAX_INSTANCES; i += 1) {
          var r = cellRect(bx, by, cells[i]);
          if (r.x + r.w < b.left || r.x > b.right || r.y + r.h < b.top || r.y > b.bottom) continue;
          entries.push({ rect: r, key: bx + ':' + by + ':' + i });
        }
      }
    }

    // 差量更新：键集合没变就只挪位置，全量重建会让每次平移都闪一下。
    var seen = new Set();
    for (var k = 0; k < entries.length; k += 1) {
      seen.add(entries[k].key);
      var node = wall.posters[k];
      if (!node) node = createPoster(entries[k], k);
      // 展开中的那张不能被 placePoster 拍回原尺寸 —— 平移/改窗口都会走到这里。
      else if (!(node.classList.contains('is-expanded'))) placePoster(node, entries[k].rect);
      node.dataset.qfKey = entries[k].key;
    }
    for (var d = entries.length; d < wall.posters.length; d += 1) {
      if (wall.posters[d] && wall.posters[d].parentNode) wall.posters[d].remove();
    }
    wall.posters.length = entries.length;
    updatePeek();
  }

  function createPoster(entry, index) {
    var tile = tileFor(index);
    var el = document.createElement('article');
    el.className = 'qf-poster';
    if (tile && tile.current) el.classList.add('is-current');
    if (tile && tile.cover) {
      var img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      el.appendChild(img);
      applyImg(img, tile.cover);
    }
    var shade = document.createElement('span');
    shade.className = 'qf-poster-shade';
    el.appendChild(shade);

    var badge = document.createElement('span');
    badge.className = 'qf-poster-badge';
    badge.textContent = tile && tile.badge ? String(tile.badge) : '';
    if (tile && !tile.badge) badge.hidden = true;
    el.appendChild(badge);

    var copy = document.createElement('div');
    copy.className = 'qf-poster-copy';
    var strong = document.createElement('strong');
    strong.textContent = tile ? tile.title : '';
    var small = document.createElement('small');
    small.textContent = tile ? tile.artist : '';
    copy.appendChild(strong);
    copy.appendChild(small);
    el.appendChild(copy);

    placePoster(el, entry.rect);
    // 存原始格位：展开档要按它居中，收起时要还原成它。
    el.dataset.qfRect = JSON.stringify(entry.rect);

    el.addEventListener('click', function (e) {
      // 展开态下点卡片本体是收起；控件区自己 stopPropagation 了。
      if (e.target.closest('.qf-poster-controls')) return;
      if (el.classList.contains('is-expanded')) collapse();
      else focusPoster(wall.posters.indexOf(el), true);
    });

    wall.world.appendChild(el);
    wall.posters.push(el);
    return el;
  }

  function placePoster(el, rect) {
    el.style.left = rect.x + 'px';
    el.style.top = rect.y + 'px';
    el.style.width = rect.w + 'px';
    el.style.height = rect.h + 'px';
  }

  /// 把某张卡放到「展开档」的尺寸与位置：6×6 单元格。
  ///
  /// 必须显式改尺寸，不能只加 .is-expanded 类：模板块是大小混排
  /// （1×8 的竖条只有 128×1080 世界尺寸），只加类的话展开的仍是一条
  /// 竖带 —— 曲名压住播放控件、控件挤在一条窄缝里。参考项目
  /// （blockTemplates.ts 的 EXPANSION_SPAN）也是固定 6×6 档。
  ///
  /// 尺寸走内联 style（与 placePoster 同一套坐标），CSS 只管卡内排版。
  function applyExpandGear(el, on) {
    var base = el.dataset.qfRect;
    if (!base) return;
    var r = JSON.parse(base);
    if (on) {
      el.style.left = (r.x + (r.w - EXPAND_COLS * PITCH) / 2) + 'px';
      el.style.top = (r.y + (r.h - EXPAND_ROWS * PITCH) / 2) + 'px';
      el.style.width = EXPAND_COLS * PITCH - GAP + 'px';
      el.style.height = EXPAND_ROWS * PITCH - GAP + 'px';
    } else {
      placePoster(el, r);
    }
  }

  function focusPoster(index, expand) {
    if (index < 0 || index >= wall.posters.length) return;
    wall.focused = index;
    wall.posters.forEach(function (n, i) { n.classList.toggle('is-focused', i === index); });
    if (expand) {
      wall.expanded = index;
      var el = wall.posters[index];
      el.classList.add('is-expanded');
      applyExpandGear(el, true);
      buildPosterControls(el, index);
      panTo(el);
    }
  }

  function collapse() {
    if (wall.expanded < 0) return;
    var el = wall.posters[wall.expanded];
    if (el) {
      el.classList.remove('is-expanded');
      applyExpandGear(el, false);
      var ctl = $('.qf-poster-controls', el);
      if (ctl) ctl.remove();
    }
    wall.expanded = -1;
    renderWall();
  }

  /// 相机飞过去把展开卡摆到视口中央。写 transform 而不是重排版，60fps 无压力。
  function panTo(el) {
    // 必须用**世界坐标**算，不能用 getBoundingClientRect()：
    // 那个矩形已经含了相机变换（translate + scale），再乘一次 s 就把
    // 偏移算重了 —— 实测展开卡停在 (1565,-948)，相机根本没跟上。
    // 世界坐标要从内联样式的 left/top 读（placePoster 写的世界坐标），
    // 宽高减去 GAP 才是卡片实际边长。
    var wx = parseFloat(el.style.left) || 0;
    var wy = parseFloat(el.style.top) || 0;
    var ww = (parseFloat(el.style.width) || 0) + GAP;
    var wh = (parseFloat(el.style.height) || 0) + GAP;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var s = wall.cam.s;
    var targetX = vw / 2 - (wx + ww / 2) * s;
    var targetY = vh / 2 - (wy + wh / 2) * s;
    var fromX = wall.cam.x;
    var fromY = wall.cam.y;
    var t0 = 0;
    var DUR = 420;
    if (wall.raf) cancelAnimationFrame(wall.raf);
    function step(ts) {
      if (!t0) t0 = ts;
      var t = Math.min(1, (ts - t0) / DUR);
      // easeOutExpo —— 参考项目 useWallCameraPan.ts 用 [0.22,1,0.36,1]，
      // 那正是 easeOutExpo 的贝塞尔写法，视觉等价。
      var e = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      wall.cam.x = fromX + (targetX - fromX) * e;
      wall.cam.y = fromY + (targetY - fromY) * e;
      applyCamera();
      if (t < 1) wall.raf = requestAnimationFrame(step);
      else wall.raf = 0;
    }
    wall.raf = requestAnimationFrame(step);
  }

  function buildPosterControls(el, index) {
    if ($('.qf-poster-controls', el)) return;
    var tile = tileFor(index);
    var box = document.createElement('div');
    box.className = 'qf-poster-controls';

    var chrome = document.createElement('div');
    chrome.className = 'qf-chrome';
    var row = document.createElement('div');
    row.className = 'qf-chrome-row';

    var prev = document.createElement('button');
    prev.type = 'button';
    prev.title = '上一首';
    prev.setAttribute('aria-label', '上一首');
    prev.innerHTML = icon('prev');
    prev.addEventListener('click', function (e) { e.stopPropagation(); emit('play-step', { delta: -1 }); });

    var play = document.createElement('button');
    play.type = 'button';
    play.className = 'qf-chrome-play';
    play.title = tile && tile.current && tile.playing ? '暂停' : '播放';
    play.setAttribute('aria-label', play.title);
    play.innerHTML = icon(tile && tile.current && tile.playing ? 'pause' : 'play');
    play.addEventListener('click', function (e) {
      e.stopPropagation();
      emit('play-index', { index: index });
    });

    var next = document.createElement('button');
    next.type = 'button';
    next.title = '下一首';
    next.setAttribute('aria-label', '下一首');
    next.innerHTML = icon('next');
    next.addEventListener('click', function (e) { e.stopPropagation(); emit('play-step', { delta: 1 }); });

    var time = document.createElement('span');
    time.className = 'qf-chrome-time';
    time.textContent = tile && tile.duration ? fmtDur(tile.duration) : '';

    row.appendChild(prev);
    row.appendChild(play);
    row.appendChild(next);
    row.appendChild(time);
    chrome.appendChild(row);

    var progress = document.createElement('div');
    progress.className = 'qf-progress';
    var fill = document.createElement('div');
    fill.className = 'qf-progress-fill';
    fill.style.width = (tile && tile.progress ? tile.progress : 0) + '%';
    progress.appendChild(fill);
    var range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '1000';
    range.step = '1';
    range.value = String(Math.round((tile && tile.progress ? tile.progress : 0) * 10));
    range.setAttribute('aria-label', '播放进度');
    range.addEventListener('input', function () {
      fill.style.width = (Number(range.value) / 10) + '%';
    });
    range.addEventListener('change', function () {
      // 拖完把手收回焦点，否则焦点停在 range 上，键盘用户再按方向键
      // 是在调进度而不是走全局快捷键。
      range.blur();
      emit('seek', { ratio: Number(range.value) / 1000 });
    });
    progress.appendChild(range);

    box.appendChild(chrome);
    box.appendChild(progress);
    el.appendChild(box);
  }

  function fmtDur(ms) {
    if (!ms || ms < 0) return '';
    var total = Math.round(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function updatePeek() {
    if (!refs.wallPeek) return;
    var t = wall.tiles.find(function (x) { return x.current; }) || wall.tiles[0];
    if (!t) {
      refs.wallPeek.hidden = true;
      return;
    }
    refs.wallPeek.hidden = false;
    refs.wallPeekTitle.textContent = t.title;
    refs.wallPeekSub.textContent = t.artist || '未知艺术家';
    if (t.cover) {
      refs.wallPeekArt.style.backgroundImage = '';
      window.HertzCovers
        ? window.HertzCovers.applyBg(refs.wallPeekArt, t.cover)
        : (refs.wallPeekArt.style.backgroundImage = 'url("' + t.cover + '")');
    } else {
      refs.wallPeekArt.style.backgroundImage = '';
    }
  }

  function onWallKeydown(e) {
    if (!wall.open) return;
    if (e.key === 'Escape') { closeWall(); return; }
    if (e.key === 'ArrowRight') { focusPoster(wall.focused + 1, false); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { focusPoster(wall.focused - 1, false); e.preventDefault(); }
    else if (e.key === 'Enter') { focusPoster(wall.focused < 0 ? 0 : wall.focused, true); e.preventDefault(); }
    else if (e.key === ' ') { focusPoster(wall.focused < 0 ? 0 : wall.focused, true); e.preventDefault(); }
  }

  // -------------------------------------------------------------------------
  // 设置浮层（遮罩 + 卡片 + 两栏分类）
  // -------------------------------------------------------------------------

  // 设置分类表：左栏一级分组 + 二级条目，右栏一次只显示一条对应的分组。
  // 条目按 .set-group 的标题文案（.set-title 的文字）认领，而不是靠序号或
  // 额外标记 —— 皮肤层不往业务 HTML 里塞属性，业务日后新增分组也不用改这里。
  // 认领不到的分组统一落进末尾的「其它」。
  var SET_SECTIONS = [
    {
      id: 'appearance',
      label: '外观',
      items: [
        ['skin', '界面皮肤', '只换布局，不动主题色'],
        ['look', '外观', '主题色、密度、动效与输出设备'],
        ['wall', '主题与壁纸', '二次元主题与背景图'],
        ['nav', '导航', '导航里显示哪些入口'],
      ],
    },
    {
      id: 'playback',
      label: '播放',
      items: [
        ['audio', '音效与均衡器', '均衡器、增益与响度归一'],
        // 沉浸声场与胶囊播放器原本只有顶栏右上角那两个图标能进。
        // 清风把控制入口统一收进左上角的设置按钮，顶栏图标对它是冗余的，
        // 所以在设置里补了这个分组承接 —— 皮肤只隐藏入口，不禁用功能。
        ['window', '窗口与舞台', '沉浸声场与胶囊播放器'],
        ['stage', '创意舞台', '创意工坊与手绘风格'],
        ['keys', '快捷键', '键盘操作一览'],
      ],
    },
    {
      id: 'library',
      label: '数据与在线',
      items: [
        ['source', '在线音源', '各音源的登录 cookie'],
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

  function buildSettingsSheet() {
    var root = make('div', 'qf-modal');
    root.hidden = true;

    var scrim = make('div', 'qf-modal-scrim', root);
    scrim.addEventListener('click', function () { closeSettingsSheet(); });

    var card = make('section', 'qf-modal-card', root);
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');

    // 这里原本有一组「选项 / 帮助」两页切换，现已去掉「帮助」页签。
    //
    // 为什么不留一个只剩「选项」的 tab 条：它唯一的动作是切换到本页，
    // 页签只剩一个时那个动作是空操作，而头部这行位置在清风里是留给
    // 关闭键的。分类标题本来就由右栏的 .qf-set-pane-head 承担
    // （左栏选中项 + 右栏标题两层信息已经够了），不需要再来一层。
    var close = make('button', 'qf-modal-close', card);
    close.type = 'button';
    close.setAttribute('aria-label', '关闭设置');
    close.innerHTML = icon('close');
    close.addEventListener('click', function () { closeSettingsSheet(); });

    var body = make('div', 'qf-modal-body', card);
    var layout = make('div', 'qf-set-layout', body);
    var nav = make('nav', 'qf-set-nav', layout);
    var pane = make('div', 'qf-set-pane', layout);

    var paneHead = make('div', 'qf-set-pane-head', pane);
    var paneTitle = make('h2', '', paneHead);
    var paneDesc = make('p', '', paneHead);

    // 「选项 / 帮助」两页切换已随帮助页签一起去掉。原先切到帮助时会
    // releaseGroups() + layout.hidden = true，而 buildHelp() 是把内容 append
    // 到 pane 里的 —— pane 是 layout 的子节点，于是内容被藏在自己的父容器下，
    // 点「帮助」看到的是一片空白。这是那个页签「点了没效果」的全部原因。
    // 现在只有选项一页，layout 永远可见；右栏内容由 openSettingsSheet 与
    // 各分类的点击处理负责刷新，这里不需要额外的切页入口。

    document.body.appendChild(root);
    sheet.root = root;
    sheet.card = card;
    sheet.nav = nav;
    sheet.pane = pane;
    sheet.paneTitle = paneTitle;
    sheet.paneDesc = paneDesc;
    // 认领分组要读 sheet.pane（relocate 的落点），所以必须等上面字段赋值齐了再调。
    // 写成 sheet.claimGroups() 会 TypeError —— claimGroups 是模块级函数，
    // 不是 sheet 的方法，整个挂载会在这里中断（后续海报墙/浮层全建不出来）。
    claimGroups();
  }

  /// 认领设置页的分组，并把视图本体搬进浮层右栏。
  function claimGroups() {
    var view = byId('view-settings');
    if (!view) return;
    sheet.viewEl = view;
    relocate(view, sheet.pane);

    var groups = Array.prototype.slice.call(view.querySelectorAll('.set-group'));
    // 认领必须走「文案 → 语义 key」这一层间接，不能直接 byKey[item[0]]。
    //
    // byKey 的键是 .set-title 的**文案**（"界面皮肤"、"外观"、"导航"…），
    // 而 SET_SECTIONS.items 的第 0 项是**语义 key**（'skin'、'look'、'nav'…）——
    // 两套命名空间。之前写成 byKey[item[0]] 等于拿语义 key 去查文案表，
    // 永远查不到，于是 13 个分组全部掉进 leftovers 变成 'x界面皮肤' 这种 key，
    // 正常 key 一个都没认领到。
    //
    // 表现是「左栏条目能点、能切（点击路径用同一个 dataset，两边都错但一致），
    // 只有打开浮层时的初始分类会落到 x… 上 → entryGroup 返回 null →
    // hideAll 之后没有任何一组被露出来 → 右栏空白」。不报错、不崩。
    var byKey = {};   // 语义 key -> { key, group, label, note }
    var leftovers = [];
    groups.forEach(function (g) {
      var t = g.querySelector('.set-title');
      var title = t ? t.textContent.trim() : '';
      var found = null;
      SET_SECTIONS.forEach(function (section) {
        if (found) return;
        section.items.forEach(function (item) {
          if (item[1] === title) found = { key: item[0], note: item[2] };
        });
      });
      if (found) byKey[found.key] = { key: found.key, group: g, label: title, note: found.note };
      else leftovers.push({ group: g, label: title });
    });

    var claimed = [];
    SET_SECTIONS.forEach(function (section) {
      section.items.forEach(function (item) {
        if (byKey[item[0]]) claimed.push(byKey[item[0]]);
      });
    });

    // 认领不到的分组统一落进「其它」：业务日后新增设置，表现为「多一项」
    // 而不是「从导航里消失」。
    var rest = leftovers.map(function (l) {
      return { key: 'x' + l.label, label: l.label, note: '', group: l.group };
    });
    if (rest.length) {
      claimed.push.apply(claimed, rest);
      SET_SECTIONS.push({ id: 'misc', label: '其它', items: rest.map(function (l) { return [l.key, l.label, l.note]; }) });
    }

    // 一个分组都没有时不建左栏：设置页退化成长滚动，而不是空面板。
    sheet.entries = claimed;
  }

  function firstKey() {
    for (var s = 0; s < SET_SECTIONS.length; s += 1) {
      if (SET_SECTIONS[s].items.length) return SET_SECTIONS[s].items[0][0];
    }
    return '';
  }

  function entryGroup(key) {
    for (var i = 0; i < sheet.entries.length; i += 1) {
      if (sheet.entries[i].key === key) return sheet.entries[i].group;
    }
    return null;
  }

  function readSectionKey() {
    try { return localStorage.getItem(SECTION_KEY) || ''; } catch (e) { return ''; }
  }

  function writeSectionKey(key) {
    try { localStorage.setItem(SECTION_KEY, key); } catch (e) { /* 隐私模式 */ }
  }

  function renderPaneHead() {
    for (var i = 0; i < sheet.entries.length; i += 1) {
      if (sheet.entries[i].key !== sheet.active) continue;
      sheet.paneTitle.textContent = sheet.entries[i].label;
      sheet.paneDesc.textContent = sheet.entries[i].note || '';
      return;
    }
    sheet.paneTitle.textContent = '设置';
    sheet.paneDesc.textContent = '';
  }

  function paintNav() {
    if (!sheet.nav) return;
    sheet.nav.innerHTML = '';
    SET_SECTIONS.forEach(function (section) {
      // 条目顺序由 SET_SECTIONS 决定（分类表是排序权威，不照 DOM 次序）。
      section.items.forEach(function (item) {
        if (!entryGroup(item[0])) return;
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'qf-set-link';
        b.dataset.qfKey = item[0];
        b.textContent = item[1];
        var on = item[0] === sheet.active;
        b.classList.toggle('is-active', on);
        if (on) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
        sheet.nav.appendChild(b);
      });
    });
  }

  function openSettingsSheet(trigger) {
    if (sheet.open) return;
    sheet.open = true;
    sheet.closing = false;
    sheet.lastFocus = trigger || document.activeElement;
    if (sheet.root) {
      sheet.root.hidden = false;
      sheet.root.classList.remove('is-closing');
    }
    document.body.classList.add('qf-modal-open');
    // 记住的分类已不存在时回落到第一类（不空屏）。
    var initial = readSectionKey();
    if (!sheet.entries.some(function (e) { return e.key === initial; })) initial = firstKey();
    sheet.active = initial;
    hideAll();
    var g = entryGroup(sheet.active);
    if (g) g.hidden = false;
    // 设置视图本体的 hidden 必须在这里摘，不能指望调用方随后调 reflow()。
    //
    // 打开浮层有两条路径，只有其中一条补了 reflow()：
    //   · clickRailItem('settings') → openSettingsSheet() + reflow()  ✅
    //   · 左上角那颗 .qf-settings-btn → openSettingsSheet(btn)，**不调**  ❌
    // 而摘 hidden 的 syncSettingsVisibility() 只挂在 reflowInner() 里，
    // 于是走按钮进来时 viewEl.hidden 一直停在 true —— 视图已经搬进右栏了，
    // 却被自己藏着，整个右栏一片空白。
    //
    // 症状和「认领失败导致没组可露」完全一样（右栏空、左栏能点），
    // 但根因完全不同，别混为一谈。
    if (sheet.viewEl) sheet.viewEl.hidden = false;
    renderPaneHead();
    paintNav();
    // 打开时焦点先落在左栏当前项（键盘用户能看到自己在哪一类）。
    var current = sheet.nav.querySelector('.qf-set-link.is-active');
    if (current) current.focus();
    // 设置页的诊断日志大小是「现在有多少内容」：浮层不经 setView，补一次刷新。
    emit('settings-enter');
  }

  function closeSettingsSheet() {
    if (!sheet.open || sheet.closing) return;
    sheet.closing = true;
    if (sheet.root) sheet.root.classList.add('is-closing');
    sheet.closeTimer = setTimeout(function () {
      if (sheet.root) {
        sheet.root.hidden = true;
        sheet.root.classList.remove('is-closing');
      }
      sheet.open = false;
      sheet.closing = false;
      // qf-modal-open 是底层隔离标记（CSS 里给 .app 加 pointer-events:none），
      // 必须在这摘而不是只在 unmount 里摘 —— 否则关掉设置后整个界面点不动。
      // 摘在退场动画之后：动画期间遮罩还在，隔离还得生效。
      // 只摘自己那一个，别连带把海报墙的标记带走（两个浮层可能先后开着）。
      document.body.classList.remove('qf-modal-open');
      if (sheet.lastFocus && sheet.lastFocus.focus) sheet.lastFocus.focus();
      sheet.lastFocus = null;
      if (mounted) reflow();
    }, MODAL_EXIT_MS);
  }

  /// 切分类：把全部分组先收起来（release = 收起），调用方紧接着把目标组
  /// hidden = false 露出来。切分类只动 hidden，不搬业务节点 ——
  /// hidden 是这些分组本来的语义（[hidden] 带 !important），别的皮肤照旧。
  ///
  /// 之前这里只有一个函数干两件事、且做的是「全显」，于是切分类时右栏从上到下
  /// 把 13 个分组全堆在一起 —— 左栏选中项对了、右栏标题对了，只有内容是错的。
  /// 现在拆成两个：切分类走 hideAll，卸载还原走 showAll（见下）。
  function hideAll() {
    sheet.entries.forEach(function (entry) {
      if (entry.group) entry.group.hidden = true;
    });
  }

  /// 卸载 / 关浮层：把 hidden 全部摘掉。
  /// 这条**必须**有 —— hidden 是皮肤加的，留在业务节点上就会跟着切到别的皮肤，
  /// 表现为「设置里其它项都不见了」，且不报错、不崩，极难定位。
  function showAll() {
    sheet.entries.forEach(function (entry) {
      if (entry.group) entry.group.hidden = false;
    });
  }

  function onNavClick(e) {
    var b = e.target.closest('.qf-set-link');
    if (!b) return;
    var key = b.dataset.qfKey;
    hideAll();
    var g = entryGroup(key);
    if (g) g.hidden = false;
    sheet.active = key;
    writeSectionKey(key);
    renderPaneHead();
    paintNav();
  }

  function onSheetKeydown(e) {
    if (e.key !== 'Escape') return;
    if (!sheet.open) return;
    e.preventDefault();
    closeSettingsSheet();
  }

  /// 设置视图的 hidden 有两条写入路径（浮层自己 + app.js 的 setView，Esc 与
  /// 切视图都会跑）。开着或退场期间必须以浮层为准，否则会出现「退场动画播
  /// 的是一张空壳」或「浮层开着内容没了」。
  function syncSettingsVisibility() {
    if (!sheet.viewEl) return;
    if (sheet.open || sheet.closing) {
      if (sheet.viewEl.hidden) sheet.viewEl.hidden = false;
      var g = entryGroup(sheet.active);
      if (g && g.hidden) g.hidden = false;
    } else if (!sheet.viewEl.hidden) {
      sheet.viewEl.hidden = true;
    }
  }

  // -------------------------------------------------------------------------
  // 视图切换联动
  // -------------------------------------------------------------------------

  function currentViewId() {
    var v = refs.column.querySelector('.view:not([hidden])');
    return v ? v.id : '';
  }

  function reflow() {
    if (inReflow) return;
    inReflow = true;
    try { reflowInner(); } finally { inReflow = false; }
  }

  function reflowInner() {
    syncSettingsVisibility();
    var id = currentViewId();
    if (refs.viewId !== id) {
      refs.column.scrollTop = 0;
      // 队列拼接是独立浮层，切到任何业务视图都该收起来 —— 否则遮着内容。
      if (wall.open && id !== 'view-queue') closeWall();
    }
    refs.viewId = id;
    var navKey = id === 'view-daily' ? 'online' : id.replace(/^view-/, '');
    // 设置视图搬进浮层后不再出现在中栏，所以浮层开着时「设置」才是当前项。
    if (sheet.open) navKey = '__settings';
    if (refs.nav) {
      refs.nav.querySelectorAll('[data-qf-view]').forEach(function (button) {
        var key = button.dataset.qfView;
        var selected = key === navKey || (key === 'wall' && wall.open);
        button.classList.toggle('is-active', selected);
        if (selected) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
    }
    if (refs.settingsBtn) {
      var on = sheet.open;
      refs.settingsBtn.classList.toggle('is-active', on);
      if (on) refs.settingsBtn.setAttribute('aria-pressed', 'true');
      else refs.settingsBtn.removeAttribute('aria-pressed');
    }
  }

  // -------------------------------------------------------------------------
  // 播放条：收成底部居中胶囊
  // -------------------------------------------------------------------------

  function buildBarChrome() {
    var bar = $('.bar');
    if (!bar) return;
    // 胶囊已经由 CSS 钉成居中形态；这里只做一件事：把「打开播放控制」的
    // 语义补上 aria-pressed（业务已经把 bar-track 做成 role=button）。
    var track = byId('bar-track');
    if (track) track.classList.add('qf-capsule-track');
  }

  // -------------------------------------------------------------------------
  // 挂载 / 卸载
  // -------------------------------------------------------------------------

  function mount() {
    if (mounted) return;
    var app = $('.app');
    if (!app) return;
    refs.rail = byId('rail');
    refs.column = byId('column');
    if (!refs.rail || !refs.column) return;

    buildNav();
    buildBrandGroup();
    buildAccount();
    buildSettingsSheet();
    buildWall();
    buildBarChrome();

    // 导航点击在 nav 上委托：条目是按钮，冒泡即可，不必逐条挂。
    if (refs.nav) refs.nav.addEventListener('click', onNavClick);
    if (sheet.nav) sheet.nav.addEventListener('click', onNavClick);

    keyHandler = onSheetKeydown;
    document.addEventListener('keydown', onWallKeydown);
    document.addEventListener('keydown', keyHandler);

    observer = new MutationObserver(function () {
      if (inReflow) return;
      reflow();
    });
    // 设置视图单独 observe（搬出中栏后仍能纠正 hidden）。
    observer.observe(refs.column, { attributes: true, attributeFilter: ['hidden'], subtree: true });
    if (sheet.viewEl) observer.observe(sheet.viewEl, { attributes: true, attributeFilter: ['hidden'] });

    mounted = true;
    reflow();
  }

  function unmount() {
    if (!mounted) return;
    if (observer) { observer.disconnect(); observer = null; }
    document.removeEventListener('keydown', onWallKeydown);
    if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
    window.removeEventListener('resize', onWallResize);
    if (wall.raf) { cancelAnimationFrame(wall.raf); wall.raf = 0; }
    clearTimeout(sheet.closeTimer);
    sheet.closeTimer = 0;
    document.body.classList.remove('qf-modal-open', 'qf-lattice-open');
    // 先把设置视图放回中栏原位（锚点在 column 里），再拆浮层，
    // 否则 removeBuilt 会连着搬过去的业务节点一起删掉。
    // showAll：把皮肤加的 hidden 全部摘掉再搬回原位 —— 留着会跟着切到别的皮肤，
    // 表现为「设置里其它项都不见了」。
    showAll();
    restoreMoves();
    if (refs.nav) refs.nav.removeEventListener('click', onNavClick);
    if (sheet.nav) sheet.nav.removeEventListener('click', onNavClick);
    removeBuilt();
    wall.root = null;
    wall.world = null;
    wall.field = null;
    wall.open = false;
    wall.posters = [];
    sheet.root = null;
    sheet.card = null;
    sheet.viewEl = null;
    sheet.open = false;
    sheet.closing = false;
    sheet.lastFocus = null;
    refs = {};
    mounted = false;
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

  if (isActiveSkin()) mount();

  // 暴露仅用于排障/契约脚本：返回当前挂载状态。
  window.__qfSkin = {
    isMounted: function () { return mounted; },
    isWallOpen: function () { return wall.open; },
    posterCount: function () { return wall.posters.length; },
    reflow: function () { if (mounted) reflow(); }
  };
})();
