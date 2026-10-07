// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
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
//   · 「队列拼接」是本皮肤的特色页：全屏海报墙，12 槽密排地块循环铺满；
//     开墙有一道从左上角涌进来的入场波，关墙反向退回；展开一张卡时
//     整块「重新咬合」让出 6×6 档（模板与让位表取自 folia 的求解器数据）；
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
// **每个 tab 的墙展示那个 tab 的内容** —— 歌单页是歌单、电台页是在线曲库、
// 本地页是曲库、每日推荐是当天的推荐、收藏是收藏列表；播放队列 tab 仍是队列
// （第 6 个来源）。墙开着时切 tab 是**换源**，不是关墙：关掉的话这个功能
// 就退化成「只有队列 tab 有队列拼接」。
//
// 为什么取数不自己摸：各视图的数据分散在五个模块的闭包里（Online.onlineState、
// DailyView.st、OnlinePlaylists 私有 state、Favorites.favState、app 自己的
// state），形状与 id 体系各不相同（本地 id / online: 虚拟 id / 歌单 ref）。
// 皮肤逐个去摸等于把那些内部结构全绑死，业务改一处形状皮肤就跟着坏。
// 收敛成 app.js 的 viewSnapshot()，皮肤只认 {key,label,kind,items,emptyHint}。
//
// 墙上点一下走 `qf:activate`（带整项），**不发** `qf:play-index`：墙上序号是
// **本视图的下标**，而 play-index 按的是播放队列下标，混用会播错歌。
// 真正的 play 永远由 app.js 落 —— 播放路径只有一条，不会双触发。
//
// 歌单那列是两层：一张海报 = 一个歌单，点开进第二层看里面的歌（不发播放）。
// 直接播的话用户根本不知道自己听的是哪个歌单。第二层里 Esc/Backspace 退回。

(function () {
  'use strict';

  var SKIN_ID = 'qingfeng';

  // 低层工具复用 skins/skin-shared.js（顺序加载保证它先于本模块）：
  // 封面位图回填、带锚点的搬运与还原、自建节点登记。
  var applyImg = window.SkinShared.applyImg;

  var mounted = false;
  // 搬运控制器：原位留 <span class="qf-anchor" data-qf="1">，卸载时 LIFO 还原。
  var moves = window.SkinShared.createMoves('qf-anchor', 'data-qf');
  // 自建节点登记：卸载时统一 remove。
  var built = window.SkinShared.createBuilt();
  var observer = null;
  var refs = {};       // 重编排队列里的 DOM 引用
  var inReflow = false;
  var keyHandler = null;
  // 播放落点 = 队列拼接墙：app.js 在手动开始播放时广播意图（playback:entry-wall），
  // 皮肤在就开墙，不在（别的皮肤）就当不跳转。
  var wallEntryHandler = null;
  var navChangedHandler = null;
  // 播放态实时化：换曲（playback:track）与暂停/续播（stage:playing-changed）都要
  // 让展开档跟到当前曲、让墙上那两颗播放键翻面。
  var wallPlayHandler = null;

  // 「正在播放」侧卡（.stage）的拖动运行态。
  //
  // 为什么要自己拖而不是交给 CSS：侧卡是 position:fixed 的浮件，要能被拖到
  // 任意位置并**记住**这个位置（刷新后恢复），必须同时改 left 与 top ——
  // CSS 只能给 transform，而 transform 叠在 right 定位上不好算落点。
  //
  // 记录的是「视口坐标」而不是「距右/距上的距离」：窗口尺寸变了重新 clamp
  // 一次就行，不用反算偏移（反算在 RTL、缩放、滚动条出现时都会偏）。
  var stageDrag = {
    el: null,        // .stage 本体
    head: null,      // 拖动把手（.stage-head）
    active: false,
    moved: false,    // 本次按下是否真的移动过（没动就不该记位置）
    startX: 0, startY: 0,
    origX: 0, origY: 0,   // 按下时卡片的视口坐标
    offX: 0, offY: 0,     // 鼠标按下点相对卡片左上角的偏移
    ro: null,      // 尺寸观察器：没记忆位时按内容高度重新停靠
  };
  var stageDragHandlers = null;   // { move, up }，卸载时解绑

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
    tiles: [],        // 当前这一列的项（来源视图的，或第二层里那个歌单的）
    posters: [],      // 当前挂载的海报 DOM（渲染顺序，供方向键步进）
    nodeByKey: null,  // 格位键 → 节点。节点与格位键控绑定，跨平移/重排不漂移
    geo: null,        // cell 几何缓存（按 tiles.length 失效）
    focused: -1,      // 键盘焦点所在 wall.posters 下标
    focusedKey: '',   // 焦点节点的格位键（跨重渲染跟节点走）
    expanded: -1,     // 展开档所在的下标（渲染时重建，仅作簿记）
    expandedKey: '',  // 展开档的格位键 —— 跨重渲染跟节点走，收起按它找节点
    // 换曲广播进来的「现在在放哪首」。海报上的 current/playing 是**建卡那一刻**
    // 的快照，暂停/续播/换曲都不会重建卡 —— 播放键要实时翻面就得自己跟一份。
    trackId: '',
    cam: { x: 0, y: 0, s: 1 },
    raf: 0,
    lightsOut: false,
    entranceDone: false,
    // 观感/跟随（设置页「海报墙」组，localStorage 持久化，buildWall 时读入）。
    follow: true,          // 换歌时相机飞到正在播放那张并展开
    vignette: true,        // 整墙四角暗角
    tint: false,           // 海报统一着色
    tintColor: WALL_TINT_DEFAULT_COLOR,
    tintIntensity: WALL_TINT_DEFAULT_INTENSITY,
    entranceUntil: 0, // 入场波截止时刻（performance.now() 基准）；0 = 不在波内
    // 展开让位表：海报键 'bx:by:slot' → 世界坐标矩形。展开期间这块的卡按它摆，
    // 收起时置回 null。null = 没有展开档，全员原格位。
    reflow: null,
    closeTimer: 0,    // 退场波播完后的清理定时器（提前重开时要掐掉）
    reflowTimer: 0,   // 让位过渡类的回收定时器
    // —— 按视图取源 ——
    // 每个 tab 的墙展示**那个 tab 的内容**：歌单页是歌单、电台页是在线曲库…
    // 播放队列 tab 仍然是队列（第 6 个来源）。取源走 qf:panel('source-request')，
    // 由 app.js 按当前 state.view 统一给一份快照 —— 皮肤不自己读各视图的
    // 内部状态，那些结构分散在五个模块的闭包里，摸了就绑死。
    sourceKey: '',      // 当前列来自哪个视图（'library'/'online'/…）
    sourceLabel: '',    // 墙顶显示的来源名
    emptyHint: '',      // 该来源为空时的提示
    // —— 第二层 ——
    // 歌单视图的墙上，一张海报是一个**歌单**；点开要看里面的歌，不是直接播。
    // 所以墙有两层：drill 里有值就是第二层，点返回键退回第一层。
    drill: null,        // { source, playlistId, name }
    drillBusy: false,   // 拉歌单曲目中（第二层显示 loading）
    drillError: '',
  };

  var SECTION_KEY = 'vmusic.qf-set-section';
  var WALL_KEY = 'vmusic.qf-wall';
  // 海报墙的观感/跟随配置（设置页「海报墙」组）。都是皮肤自己的偏好，
  // 存皮肤前缀的 localStorage，不进服务端设置表 —— 别的皮肤用不上这些键。
  var WALL_FOLLOW_KEY = 'vmusic.qf-wall-follow';
  var WALL_VIGNETTE_KEY = 'vmusic.qf-wall-vignette';
  var WALL_TINT_KEY = 'vmusic.qf-wall-tint';
  var WALL_TINT_COLOR_KEY = 'vmusic.qf-wall-tint-color';
  var WALL_TINT_INTENSITY_KEY = 'vmusic.qf-wall-tint-intensity';
  var WALL_TINT_DEFAULT_COLOR = '#161419';
  var WALL_TINT_DEFAULT_INTENSITY = 35;

  // 墙的入口按钮在每个 tab 下的名字。这个入口开的是**当前视图**的墙，
  // 所以名字也得跟着变 —— 固定叫「队列拼接」会让人以为在所有 tab 下
  // 看的都是播放队列，而实际上歌单页开的是歌单、电台页开的是在线曲库。
  //
  // 键是视图 id 去掉 'view-' 前缀（与 currentViewId() 对齐）。
  // 缺键时回落到「队列拼接」，所以新增视图不会让按钮变成空白。
  var WALL_TAB_LABELS = {
    library: '曲库拼接',
    online: '电台拼接',
    playlists: '歌单墙',
    favorites: '收藏墙',
    daily: '每日墙',
    queue: '队列拼接',
  };

  // 退场动画时长，与 skin.qingfeng.css 里 .qf-modal-card 的 transition 时长对齐。
  // CSS 改了就同步改这里，否则会出现「动画还没完内容先消失」。
  var MODAL_EXIT_MS = 200;

  // --- 海报墙常量（与 CSS 的 --qf-cell / --qf-cell-gap 对齐） ----------------
  var CELL = 128;        // 单元格边长（世界坐标）
  var GAP = 8;           // 卡片间隙
  var PITCH = CELL + GAP;
  var BLOCK_COLS = 12;   // 一个密排地块 12 列
  var BLOCK_ROWS = 8;    // 8 行
  var LATTICE_SLOTS = 12; // 每个地块 12 个槽位（LATTICE_TEMPLATES 每行一张切法）
  var OVERSCAN = 500;    // 裁剪外扩的渲染余量
  var MAX_INSTANCES = 400;
  // 入场波（folia 的 Metro 着陆）：卡片从上方 90 世界单位落回格位，延时按
  // 「到视口左上角的曼哈顿距离」逐级展开；整波 ENTRANCE_WINDOW 后算结束，
  // 之后平移/换源露出的新卡片只做一次轻上浮，不重播整波。
  var ENTRANCE_LIFT = 90;   // 供注释对照，实际位移写在 CSS 的 @keyframes 里
  var ENTRANCE_STAGGER = 0.03;
  var ENTRANCE_MAX_DELAY = 0.34;
  var ENTRANCE_WINDOW = 1100;
  var REFLOW_ANIM_MS = 520; // 展开让位/收起的滑移时长（CSS .is-reflow 的过渡要与之同步）

  function $(sel, root) { return (root || document).querySelector(sel); }
  function byId(id) { return document.getElementById(id); }

  // -------------------------------------------------------------------------
  // 节点搬运（锚点还原）
  // -------------------------------------------------------------------------

  function relocate(node, parent, before) {
    return moves.relocate(node, parent, before);
  }

  function restoreMoves() {
    moves.restore();
  }

  function make(tag, cls, parent) {
    return built.make(tag, cls, parent);
  }

  function removeBuilt() {
    built.remove();
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

  /// 要「当前 tab 那一列」的项。海报墙不自己读各视图状态（那分散在五个模块的
  /// 闭包里），发一条只读请求，app.js 按当前 view 统一给一份快照回来。
  ///
  /// 皮肤只认 {key,label,kind,items,emptyHint} 这一个契约 —— 换视图、换数据源
  /// 都不需要改皮肤。
  function requestSource() {
    var out = emit('source-request');
    return (out && out.source) || { key: '', label: '', kind: 'track', items: [], emptyHint: '' };
  }

  /// 要播放队列那份（第二层「从队列打开」与老路径的兼容入口）。
  function requestQueue() {
    var out = emit('queue-request');
    return (out && out.queue) || [];
  }

  /// 皮肤偏好的小读写（localStorage 布尔/数字/字符串，隐私模式静默回落默认）。
  function readFlag(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      if (v === null) return fallback;
      if (v === '1') return true;
      if (v === '0') return false;
      return fallback;
    } catch (e) { return fallback; }
  }

  function writeFlag(key, value) {
    try { localStorage.setItem(key, value ? '1' : '0'); } catch (e) { /* 隐私模式 */ }
  }

  function readStr(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (e) { return fallback; }
  }

  function writeStr(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* 隐私模式 */ }
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
    // 文案跟着当前 tab 变（reflow 里改）：这个入口展示的是**当前视图的**内容，
    // 在歌单页它开的是歌单墙、在电台页开的是在线曲库墙，固定叫「队列拼接」
    // 会让用户以为在所有 tab 下都看的是播放队列。
    var wallBtn = make('button', 'qf-nav-icon', nav);
    wallBtn.type = 'button';
    wallBtn.dataset.qfView = 'wall';
    wallBtn.setAttribute('aria-label', '队列拼接');
    wallBtn.setAttribute('aria-haspopup', 'dialog');
    wallBtn.innerHTML = icon('queue') + '<span class="qf-nav-icon-text">队列拼接</span>';
    wallBtn.addEventListener('click', function () { toggleWall(); });
    refs.wallBtn = wallBtn;
    refs.wallBtnText = $('.qf-nav-icon-text', wallBtn);

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

  /// 密排模板与展开让位表。从 folia-major 的 blockTemplates.ts / blockReflows.ts
  /// 机械提取（生成脚本校验过：模板精确铺满 12×8；每张让位表精确铺满 12×8；
  /// 被展开的槽位恰好是 6×6 档）。每块 12 槽、大小混排（2×2 到 6×4），
  /// 比自造的四槽块密度高、节奏感强 —— 这就是 folia 墙面的观感来源。
  var LATTICE_TEMPLATES = [
    [[0,0,3,2], [3,0,6,4], [9,0,3,2], [0,2,3,2], [9,2,3,4], [0,4,4,4], [4,4,2,2], [6,4,3,2], [4,6,2,2], [6,6,2,2], [8,6,2,2], [10,6,2,2]],
    [[0,0,2,3], [2,0,2,3], [4,0,2,3], [6,0,6,4], [0,3,6,2], [6,4,2,4], [8,4,2,4], [10,4,2,2], [0,5,2,3], [2,5,2,3], [4,5,2,3], [10,6,2,2]],
    [[0,0,6,4], [6,0,6,3], [6,3,4,3], [10,3,2,2], [0,4,4,2], [4,4,2,2], [10,5,2,3], [0,6,2,2], [2,6,2,2], [4,6,2,2], [6,6,2,2], [8,6,2,2]],
    [[0,0,2,2], [2,0,2,2], [4,0,4,3], [8,0,2,4], [10,0,2,4], [0,2,2,3], [2,2,2,2], [4,3,4,3], [2,4,2,2], [8,4,4,4], [0,5,2,3], [2,6,6,2]],
  ];

    // // 下标 = [模板][被展开的槽位] → 该块 12 张卡在展开期间的位置（[x,y,cols,rows]）
  var LATTICE_REFLOWS = [
    [
      [[0,0,6,6], [6,0,4,4], [10,0,2,2], [2,6,2,2], [10,2,2,4], [0,6,2,2], [4,6,2,2], [6,4,2,2], [6,6,2,2], [8,6,2,2], [8,4,2,2], [10,6,2,2]],
      [[0,0,3,2], [3,0,6,6], [9,0,3,2], [0,2,3,2], [9,2,3,2], [0,4,3,2], [3,6,3,2], [6,6,2,2], [0,6,3,2], [8,6,2,2], [10,6,2,2], [9,4,3,2]],
      [[0,0,3,2], [3,0,3,4], [6,0,6,6], [0,2,3,2], [10,6,2,2], [0,4,2,4], [4,4,2,2], [6,6,2,2], [4,6,2,2], [8,6,2,2], [2,6,2,2], [2,4,2,2]],
      [[2,0,2,2], [4,0,6,2], [8,2,2,2], [0,2,6,6], [10,0,2,6], [0,0,2,2], [6,2,2,2], [6,4,2,2], [6,6,2,2], [8,6,2,2], [8,4,2,2], [10,6,2,2]],
      [[0,0,3,2], [3,0,4,2], [10,0,2,2], [0,2,2,3], [6,2,6,6], [0,5,2,3], [2,4,2,2], [4,4,2,2], [4,6,2,2], [2,6,2,2], [7,0,3,2], [2,2,4,2]],
      [[0,0,3,2], [5,0,4,2], [9,0,3,2], [3,0,2,2], [8,2,4,2], [0,2,6,6], [6,2,2,2], [6,4,2,2], [6,6,2,2], [8,4,2,4], [10,6,2,2], [10,4,2,2]],
      [[0,0,4,2], [4,0,3,2], [9,0,3,2], [0,2,2,3], [10,2,2,2], [0,5,2,3], [4,2,6,6], [10,4,2,2], [2,6,2,2], [10,6,2,2], [7,0,2,2], [2,2,2,4]],
      [[0,0,4,2], [4,0,4,2], [8,0,2,2], [0,2,2,3], [10,0,2,2], [0,5,2,3], [4,4,2,2], [6,2,6,6], [4,6,2,2], [2,6,2,2], [2,4,2,2], [2,2,4,2]],
      [[0,0,4,2], [4,0,3,2], [9,0,3,2], [0,2,2,3], [10,2,2,2], [0,5,2,3], [2,2,2,4], [10,4,2,2], [4,2,6,6], [2,6,2,2], [10,6,2,2], [7,0,2,2]],
      [[0,0,4,2], [4,0,4,2], [8,0,2,2], [0,2,2,3], [10,0,2,2], [0,5,2,3], [2,4,2,2], [4,4,2,2], [4,6,2,2], [6,2,6,6], [2,6,2,2], [2,2,4,2]],
      [[0,0,4,2], [4,0,4,2], [8,0,2,2], [0,2,2,3], [10,0,2,2], [0,5,2,3], [2,4,2,2], [4,4,2,2], [4,6,2,2], [2,6,2,2], [6,2,6,6], [2,2,4,2]],
      [[0,0,4,2], [4,0,4,2], [8,0,2,2], [0,2,2,3], [10,0,2,2], [0,5,2,3], [2,4,2,2], [4,4,2,2], [4,6,2,2], [2,6,2,2], [2,2,4,2], [6,2,6,6]],
    ],
    [
      [[0,0,6,6], [6,0,2,2], [6,2,2,2], [8,0,4,4], [2,6,2,2], [6,4,2,4], [8,4,2,2], [10,4,2,2], [0,6,2,2], [4,6,2,2], [8,6,2,2], [10,6,2,2]],
      [[0,0,2,3], [2,0,6,6], [8,2,4,2], [8,0,4,2], [0,3,2,2], [6,6,2,2], [8,4,2,4], [10,4,2,2], [0,5,2,3], [2,6,2,2], [4,6,2,2], [10,6,2,2]],
      [[0,0,2,3], [2,0,2,3], [4,0,6,6], [10,0,2,4], [0,3,4,2], [6,6,2,2], [8,6,2,2], [10,4,2,2], [0,5,2,3], [2,5,2,3], [4,6,2,2], [10,6,2,2]],
      [[0,0,2,3], [2,0,2,3], [4,0,2,4], [6,0,6,6], [0,3,4,2], [6,6,2,2], [8,6,2,2], [10,6,2,2], [0,5,2,3], [2,5,2,3], [4,6,2,2], [4,4,2,2]],
      [[0,0,2,2], [2,0,2,2], [4,0,4,2], [8,0,4,4], [0,2,6,6], [6,4,2,2], [8,4,2,2], [10,4,2,2], [6,6,2,2], [6,2,2,2], [8,6,2,2], [10,6,2,2]],
      [[0,0,2,4], [2,0,2,3], [4,0,4,2], [8,0,2,2], [2,3,2,2], [6,2,6,6], [4,4,2,2], [10,0,2,2], [0,4,2,4], [2,5,2,3], [4,6,2,2], [4,2,2,2]],
      [[0,0,2,4], [2,0,2,3], [4,0,4,2], [8,0,2,2], [2,3,2,2], [4,4,2,2], [6,2,6,6], [10,0,2,2], [0,4,2,4], [2,5,2,3], [4,6,2,2], [4,2,2,2]],
      [[0,0,2,4], [2,0,2,3], [4,0,4,2], [8,0,2,2], [2,3,2,2], [4,4,2,2], [4,6,2,2], [6,2,6,6], [0,4,2,4], [2,5,2,3], [4,2,2,2], [10,0,2,2]],
      [[0,0,2,2], [4,0,2,2], [6,0,2,3], [8,0,4,4], [2,0,2,2], [6,6,2,2], [8,4,2,2], [10,4,2,2], [0,2,6,6], [6,3,2,3], [8,6,2,2], [10,6,2,2]],
      [[0,0,2,2], [2,0,2,2], [4,0,4,2], [8,0,4,4], [0,2,2,2], [8,4,2,2], [8,6,2,2], [10,4,2,2], [0,6,2,2], [2,2,6,6], [0,4,2,2], [10,6,2,2]],
      [[0,0,2,3], [2,0,2,4], [4,0,4,2], [8,0,4,2], [0,3,2,3], [2,4,2,2], [10,4,2,2], [10,2,2,2], [0,6,2,2], [2,6,2,2], [4,2,6,6], [10,6,2,2]],
      [[0,0,2,4], [2,0,2,3], [4,0,4,2], [8,0,2,2], [2,3,2,2], [4,4,2,2], [4,6,2,2], [10,0,2,2], [0,4,2,4], [2,5,2,3], [4,2,2,2], [6,2,6,6]],
    ],
    [
      [[0,0,6,6], [6,0,6,2], [8,2,2,4], [10,2,2,3], [0,6,2,2], [6,4,2,2], [10,5,2,3], [2,6,2,2], [4,6,2,2], [6,6,2,2], [8,6,2,2], [6,2,2,2]],
      [[0,0,4,4], [6,0,6,6], [6,6,2,2], [8,6,2,2], [0,4,2,2], [4,4,2,2], [10,6,2,2], [0,6,2,2], [2,6,2,2], [4,6,2,2], [2,4,2,2], [4,0,2,4]],
      [[0,0,4,4], [8,0,2,2], [6,2,6,6], [6,0,2,2], [0,4,2,2], [4,4,2,2], [10,0,2,2], [0,6,2,2], [2,6,2,2], [4,6,2,2], [2,4,2,2], [4,0,2,4]],
      [[0,0,4,4], [8,0,2,2], [4,4,2,2], [6,2,6,6], [0,4,2,2], [4,2,2,2], [10,0,2,2], [0,6,2,2], [2,6,2,2], [4,6,2,2], [2,4,2,2], [4,0,4,2]],
      [[2,0,4,2], [6,0,6,2], [6,4,2,2], [10,4,2,2], [0,2,6,6], [6,2,2,2], [10,6,2,2], [0,0,2,2], [6,6,2,2], [8,6,2,2], [8,4,2,2], [8,2,4,2]],
      [[0,0,4,4], [8,0,2,2], [10,4,2,2], [10,2,2,2], [0,4,2,2], [4,2,6,6], [10,6,2,2], [0,6,2,2], [2,6,2,2], [2,4,2,2], [4,0,4,2], [10,0,2,2]],
      [[0,0,4,4], [8,0,2,2], [4,4,2,2], [10,0,2,2], [0,4,2,2], [4,2,2,2], [6,2,6,6], [0,6,2,2], [2,6,2,2], [4,6,2,2], [2,4,2,2], [4,0,4,2]],
      [[0,0,4,2], [6,0,6,2], [6,4,2,2], [10,2,2,3], [4,0,2,2], [6,2,2,2], [10,5,2,3], [0,2,6,6], [6,6,2,2], [8,6,2,2], [8,4,2,2], [8,2,2,2]],
      [[0,0,6,2], [6,0,6,2], [8,4,2,2], [10,2,2,2], [0,4,2,2], [0,2,2,2], [10,6,2,2], [0,6,2,2], [2,2,6,6], [8,6,2,2], [8,2,2,2], [10,4,2,2]],
      [[0,0,4,4], [8,0,2,2], [10,4,2,2], [10,2,2,2], [0,4,2,2], [2,4,2,2], [10,6,2,2], [0,6,2,2], [2,6,2,2], [4,2,6,6], [4,0,4,2], [10,0,2,2]],
      [[0,0,4,4], [8,0,2,2], [4,4,2,2], [6,0,2,2], [0,4,2,2], [2,4,2,2], [10,0,2,2], [0,6,2,2], [2,6,2,2], [4,6,2,2], [6,2,6,6], [4,0,2,4]],
      [[0,0,4,4], [8,0,2,2], [4,4,2,2], [4,0,4,2], [0,4,2,2], [4,2,2,2], [10,0,2,2], [0,6,2,2], [2,6,2,2], [4,6,2,2], [2,4,2,2], [6,2,6,6]],
    ],
    [
      [[0,0,6,6], [6,2,2,2], [6,0,2,2], [8,0,2,6], [10,0,2,2], [0,6,2,2], [6,6,2,2], [6,4,2,2], [8,6,2,2], [10,2,2,6], [2,6,2,2], [4,6,2,2]],
      [[0,0,2,2], [2,0,6,6], [8,0,2,3], [8,3,2,3], [10,0,2,4], [0,2,2,2], [6,6,2,2], [4,6,2,2], [8,6,2,2], [10,4,2,4], [0,4,2,4], [2,6,2,2]],
      [[0,0,2,2], [2,0,2,3], [4,0,6,6], [10,0,2,2], [10,2,2,3], [0,2,2,2], [2,3,2,2], [4,6,6,2], [0,4,2,2], [10,5,2,3], [0,6,2,2], [2,5,2,3]],
      [[0,0,2,2], [2,0,2,2], [4,0,2,4], [6,0,6,6], [7,6,2,2], [0,2,2,4], [2,2,2,2], [4,4,2,2], [2,4,2,4], [9,6,3,2], [0,6,2,2], [4,6,3,2]],
      [[0,0,2,2], [2,0,2,2], [4,0,2,4], [7,6,2,2], [6,0,6,6], [0,2,2,4], [2,2,2,2], [4,4,2,2], [2,4,2,4], [9,6,3,2], [0,6,2,2], [4,6,3,2]],
      [[3,0,2,2], [6,2,2,2], [5,0,2,2], [8,2,2,3], [9,0,3,2], [0,2,6,6], [7,0,2,2], [6,4,2,2], [8,5,2,3], [10,2,2,6], [0,0,3,2], [6,6,2,2]],
      [[0,0,2,2], [2,0,2,2], [4,0,6,2], [8,2,2,2], [10,0,2,3], [0,2,2,3], [2,2,6,6], [8,4,2,2], [10,3,2,2], [10,5,2,3], [0,5,2,3], [8,6,2,2]],
      [[0,0,2,3], [2,0,2,2], [4,0,3,2], [7,0,3,2], [10,0,2,6], [0,3,2,2], [2,2,2,2], [4,2,6,6], [2,4,2,2], [10,6,2,2], [0,5,2,3], [2,6,2,2]],
      [[0,0,2,2], [2,0,2,2], [4,0,6,2], [8,2,2,2], [10,0,2,3], [0,2,2,3], [10,3,2,2], [8,4,2,2], [2,2,6,6], [10,5,2,3], [0,5,2,3], [8,6,2,2]],
      [[0,0,2,2], [2,0,3,2], [5,0,3,2], [8,0,2,2], [10,0,2,2], [0,2,2,3], [2,2,2,2], [4,2,2,6], [2,4,2,2], [6,2,6,6], [0,5,2,3], [2,6,2,2]],
      [[2,0,3,2], [6,2,2,2], [5,0,3,2], [8,0,4,3], [10,3,2,2], [0,0,2,2], [8,3,2,3], [6,4,2,2], [8,6,2,2], [10,5,2,3], [0,2,6,6], [6,6,2,2]],
      [[0,0,2,2], [2,0,4,2], [6,0,2,2], [8,0,2,4], [10,0,2,3], [0,2,2,2], [0,4,2,2], [8,4,2,2], [10,3,2,3], [8,6,4,2], [0,6,2,2], [2,2,6,6]],
    ],
  ];

  /// 朝向选择（folia 的 getBlockOrientation）：模板按 (列 + 行×2) 步进，
  /// 保证相邻块不同型；镜像由坐标哈希挑选，整墙不出现肉眼可见的重复周期。
  function mixBlockCoords(bx, by) {
    var v = Math.imul(bx, 0x9e3779b1) ^ Math.imul(by, 0x85ebca6b);
    v = Math.imul(v ^ (v >>> 15), 0x2c1b3c6d);
    v ^= v >>> 12;
    return v >>> 0;
  }

  function blockOrientation(lc, lr) {
    var n = LATTICE_TEMPLATES.length;
    var template = ((lc + lr * 2) % n + n) % n;
    return template * 4 + (mixBlockCoords(lc, lr) % 4);
  }

  /// 镜像：mode 位 0 = 水平翻转，位 1 = 垂直翻转。翻转逐槽保持槽位顺序，
  /// 所以一张卡在任意朝向下的槽位下标不变 —— 让位表才能按槽位对上。
  function reflectRect(r, mode) {
    var x = r[0], y = r[1];
    if (mode & 1) x = BLOCK_COLS - x - r[2];
    if (mode & 2) y = BLOCK_ROWS - y - r[3];
    return [x, y, r[2], r[3]];
  }

  /// 朝向取自块在 **cell 内**的局部坐标（folia 同构）：cell 是重复周期单位，
  /// 局部坐标定朝向，同一座位在每次周期重复里形状一致 ——
  /// 「第 qi 项坐在哪」才是格位的纯函数（见 tileForKey / locateNearestInstance）。
  function blockCells(bx, by) {
    var g = getGeometry();
    var lc = ((bx % g.perRow) + g.perRow) % g.perRow;
    var lr = ((by % g.rows) + g.rows) % g.rows;
    var o = blockOrientation(lc, lr);
    var mode = o & 3;
    return LATTICE_TEMPLATES[(o - mode) / 4].map(function (r) { return reflectRect(r, mode); });
  }

  /// 展开档让位表：展开 (bx,by) 块的第 slot 张时，全块 12 张卡各去哪。
  /// 被展开的槽位恰好吃满 6×6 档，其余 11 张换小档把块重新铺满 ——
  /// 块的占地不变，邻居块纹丝不动，卡片是「重新咬合」而不是被大卡压住。
  function blockReflow(bx, by, slot) {
    if (slot < 0 || slot >= LATTICE_SLOTS) return null;
    var g = getGeometry();
    var lc = ((bx % g.perRow) + g.perRow) % g.perRow;
    var lr = ((by % g.rows) + g.rows) % g.rows;
    var o = blockOrientation(lc, lr);
    var mode = o & 3;
    return LATTICE_REFLOWS[(o - mode) / 4][slot].map(function (r) { return reflectRect(r, mode); });
  }

  /// cell 几何：队列铺满一个 cell（perRow×rows 个地块）后周期重复。
  /// perRow 按 folia 的 FIELD_ASPECT=2.2 取，让重复周期略呈横向。
  function getGeometry() {
    var n = wall.tiles.length || 1;
    if (wall.geo && wall.geo.n === n) return wall.geo.g;
    var blocks = Math.max(1, Math.ceil(n / LATTICE_SLOTS));
    var perRow = blocks <= 1 ? 1
      : Math.max(1, Math.round(Math.sqrt(2.2 * blocks * BLOCK_ROWS / BLOCK_COLS)));
    var rows = Math.ceil(blocks / perRow);
    wall.geo = {
      n: n,
      g: {
        perRow: perRow,
        rows: rows,
        slots: perRow * rows * LATTICE_SLOTS,
        w: perRow * BLOCK_COLS * PITCH,
        h: rows * BLOCK_ROWS * PITCH,
      },
    };
    return wall.geo.g;
  }

  /// 格位键 → 这一格显示哪一项。cellSlot 是格位在 cell 内的序号，对项数
  /// 取模 —— 同一项在墙上出现多次、每次周期重复坐同一座位（folia 的
  /// queueIndex = cellSlot % totalEntries）。
  function tileForKey(key) {
    var parts = String(key).split(':');
    if (parts.length !== 3 || !wall.tiles.length) return null;
    var g = getGeometry();
    var bx = Number(parts[0]), by = Number(parts[1]), slot = Number(parts[2]);
    var rx = Math.floor(bx / g.perRow), ry = Math.floor(by / g.rows);
    var cellSlot = ((by - ry * g.rows) * g.perRow + (bx - rx * g.perRow)) * LATTICE_SLOTS + slot;
    return wall.tiles[cellSlot % wall.tiles.length] || null;
  }

  /// 从海报节点取它那一项（节点与格位键控绑定，内容跨平移/跨重排不漂移）。
  function posterTile(el) {
    return el ? tileForKey(el.dataset.qfKey) : null;
  }

  /// 离世界点 pt 最近的、显示第 qi 项的实例（folia 的 locateNearestInstance）。
  /// 一项在一个 cell 里可能坐多个座位（项数 < cell 槽位数时），每个座位
  /// 各取离 pt 最近的周期重复，再取最近者。
  function locateNearestInstance(qi, pt) {
    var g = getGeometry();
    var n = wall.tiles.length;
    if (n <= 0 || qi < 0 || qi >= n) return null;
    var best = null;
    var bestD = Infinity;
    for (var cellSlot = qi; cellSlot < g.slots; cellSlot += n) {
      var blockInCell = Math.floor(cellSlot / LATTICE_SLOTS);
      var lc = blockInCell % g.perRow;
      var lr = Math.floor(blockInCell / g.perRow);
      var slot = cellSlot % LATTICE_SLOTS;
      var base = cellRect(lc, lr, blockCells(lc, lr)[slot]);
      var rx = Math.round((pt.x - base.x - base.w / 2) / g.w);
      var ry = Math.round((pt.y - base.y - base.h / 2) / g.h);
      var dxx = base.x + rx * g.w + base.w / 2 - pt.x;
      var dyy = base.y + ry * g.h + base.h / 2 - pt.y;
      var d = dxx * dxx + dyy * dyy;
      if (d < bestD) {
        bestD = d;
        best = {
          key: (rx * g.perRow + lc) + ':' + (ry * g.rows + lr) + ':' + slot,
          rect: { x: base.x + rx * g.w, y: base.y + ry * g.h, w: base.w, h: base.h },
        };
      }
    }
    return best;
  }

  /// 视口中心的世界坐标。
  function viewportCenterWorld() {
    return {
      x: ((window.innerWidth || 1280) / 2 - wall.cam.x) / wall.cam.s,
      y: ((window.innerHeight || 800) / 2 - wall.cam.y) / wall.cam.s,
    };
  }

  /// 视口的精确世界坐标范围（无外扩）。入/退场波的延时按它算 ——
  /// 波是「从视口左上角涌进来」的，外扩的 OVERSCAN 不该参与延时。
  function viewBounds() {
    var vw = window.innerWidth || 1280;
    var vh = window.innerHeight || 800;
    var s = wall.cam.s;
    return {
      left: -wall.cam.x / s,
      top: -wall.cam.y / s,
      right: (vw - wall.cam.x) / s,
      bottom: (vh - wall.cam.y) / s,
    };
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

  /// 一张海报在波里的延时：按格位到视口左上角的曼哈顿距离逐级展开
  /// （folia 的 getEntranceDelay）—— 左上角先落，对角线方向涌过去。
  function entranceDelayFor(rect) {
    var b = viewBounds();
    var steps = Math.max(0, rect.x - b.left) + Math.max(0, rect.y - b.top);
    return Math.min(ENTRANCE_MAX_DELAY, (steps / PITCH) * ENTRANCE_STAGGER);
  }

  /// 退场延时 = 入场延时取补数（folia 的 getExitDelay）：墙朝它进来的
  /// 那个角反着清空，卡片沿原路飞回去。
  function exitDelayFor(rect) {
    return ENTRANCE_MAX_DELAY - entranceDelayFor(rect);
  }

  /// 海报此刻的世界坐标矩形（读内联样式 —— 那是相机变换前的坐标）。
  function posterWorldRect(el) {
    return {
      x: parseFloat(el.style.left) || 0,
      y: parseFloat(el.style.top) || 0,
      w: parseFloat(el.style.width) || 0,
      h: parseFloat(el.style.height) || 0,
    };
  }

  /// 一首歌在墙上出现很多次：队列去重后按 cell 座位循环铺满（tileForKey）。
  /// 这就是 folia 的「队列不改变地块结构，只改变每格显示哪首歌」。

  /// 墙的动效要不要压：系统偏好或设置页「动效分面：海报墙」（body[data-rm]
  /// 带 wall token）任一命中即压。CSS 门控在 skin.qingfeng.css；JS 这边只差
  /// 两处 —— 入场波要不要挂 is-landing、关墙要不要播退场波。
  function wallMotionReduced() {
    try {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
    } catch (e) { /* 老内核按没设处理 */ }
    var rm = document.body ? document.body.dataset.rm : '';
    return !!(rm && rm.split(/\s+/).indexOf('wall') >= 0);
  }

  /// 把观感偏好落到墙的根节点：暗角是类，着色是两个 CSS 变量
  /// （色值来自用户的取色器，只能走内联变量——皮肤 CSS 里不许出现颜色字面量）。
  function applyWallLook() {
    if (!wall.root) return;
    wall.root.classList.toggle('is-vignette', wall.vignette);
    wall.root.classList.toggle('is-tint', wall.tint);
    wall.root.style.setProperty('--qf-tint-color', wall.tintColor);
    wall.root.style.setProperty('--qf-tint-opacity', String(wall.tintIntensity / 100));
  }

  /// 换歌跟随（设置页「换歌时自动聚焦」）：墙开着时切歌，就近挑一张
  /// 正在播放的实例飞过去并展开。列表里没有 current 项（比如歌单那列
  /// 停在第二层）就不动 —— 跟随是锦上添花，不是必须。
  function followCurrent() {
    if (!mounted || !wall.open || !wall.follow) return;
    // 判据走 posterIsCurrent（换曲广播的 trackId），不吃 tile.current 那份建卡快照。
    var idx = wall.tiles.findIndex(posterIsCurrent);
    if (idx < 0) return;
    focusQueueIndex(idx, true);
  }

  /// 墙顶的来源标签。歌单视图要点得进去，所以额外挂一个返回键。
  function paintSourceTag() {
    if (refs.wallTag) {
      var label = wall.sourceLabel || '';
      if (refs.wallTagLabel) refs.wallTagLabel.textContent = label;
      if (refs.wallTagCount) {
        var n = wall.tiles.length;
        refs.wallTagCount.textContent = n ? n + ' 项' : '';
      }
      if (refs.wallTagBack) refs.wallTagBack.hidden = !wall.drill;
      // 没有来源名就别占位（理论上不会 —— 六个视图都有 label）。
      refs.wallTag.hidden = !label;
      if (wall.drill) refs.wallTag.classList.add('is-drill');
      else refs.wallTag.classList.remove('is-drill');
    }
    // 「清空队列」只对播放队列那一列成立：其余视图的项是视图自己的内容
    // （曲库/在线/收藏），清播放队列不会让墙变空，只会让「正在播放」那张卡
    // 消失 —— 摆在那儿就是给了个点了没用的按钮。
    if (refs.wallClear) refs.wallClear.hidden = wall.sourceKey !== 'queue' || !!wall.drill;
  }

  /// 空态 / 加载态 / 错误态的文案。歌单那列没拉到东西时要说清是哪一层
  /// ——「加载失败」和「这个歌单是空的」对用户是两件事。
  function paintEmptyState() {
    if (!refs.wallEmpty) return;
    if (wall.tiles.length) {
      refs.wallEmpty.hidden = true;
      return;
    }
    refs.wallEmpty.hidden = false;
    var title = '';
    var hint = wall.emptyHint || '';
    if (wall.drillBusy) {
      title = '正在读这个歌单…';
    } else if (wall.drillError) {
      title = wall.drillError;
      hint = '点左上角返回，或退出后重试';
    } else {
      title = wall.drill ? '这个歌单是空的' : '这里是空的';
    }
    if (refs.wallEmptyTitle) refs.wallEmptyTitle.textContent = title;
    if (refs.wallEmptyHint) refs.wallEmptyHint.textContent = hint;
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
    emptyTitle.textContent = '这里是空的';
    var emptyHint = make('span', '', empty);
    emptyHint.textContent = '';

    // 左上角：当前这一列的来源名。用户是从某个 tab 点进来的，光看歌名分不清
    // 「这是歌单页的墙」还是「这是队列的墙」—— 尤其两者内容可能一模一样。
    var tag = make('div', 'qf-lattice-tag', root);
    var tagLabel = make('strong', '', tag);
    var tagCount = make('span', '', tag);
    var tagBack = make('button', 'qf-lattice-back', tag);
    tagBack.type = 'button';
    tagBack.hidden = true;
    tagBack.title = '返回歌单列表';
    tagBack.setAttribute('aria-label', '返回歌单列表');
    tagBack.innerHTML = icon('prev');
    tagBack.addEventListener('click', leaveDrill);

    // 左下角：当前队列浮条。
    //
    // 悬停浮现播放/暂停按钮：浮条本身是「当前聚焦的那一项」的只读回显，
    // 鼠标停在它上面时用户最自然的动作就是「播/停这一首」—— 尤其在墙
    // 开着、海报密密麻麻的时候，回到底部找播放条要移动很远。
    // 按钮**常驻在 DOM 里**（不是 hover 才插入）：每次 hover 重建节点会
    // 让指针在按钮出现的瞬间落在新节点上，click 丢失，而且每次都要重挂
    // 监听。显隐只切 opacity / pointer-events。
    var peek = make('div', 'qf-queue-peek', root);
    var peekArt = make('div', 'qf-queue-peek-art', peek);
    var peekPlay = make('button', 'qf-queue-peek-play', peek);
    peekPlay.type = 'button';
    peekPlay.setAttribute('aria-label', '播放');
    peekPlay.addEventListener('click', function (e) {
      // 冒泡到 .qf-queue-peek 就会触发「聚焦这一项」，那会把用户从正在
      // 看的卡上拽走 —— 播放按钮要的是「只播这一首」。
      e.stopPropagation();
      var t = peekTile();
      if (!t) return;
      if (t.isPlaylist) { enterDrill(t); return; }
      // 已经在放这一首 → 播/停切换；否则播它。判据必须走实时那一份：
      // tile.current/playing 是建卡快照，暂停和续播都不换曲、不会刷新它 ——
      // 读快照的话停着的时候点它会发 activate，等于把同一首从头再 load 一遍。
      if (posterIsCurrent(t)) { emit('toggle-play'); updatePeek(); }
      // 连墙上这一列一起交出去：第二层的歌只活在墙上（业务侧没有对应的
      // sourceKey），不带 list 的话业务会按当前 tab 重推一份，播错歌。
      else emit('activate', { item: t, list: wall.tiles });
    });
    var peekCopy = make('div', 'qf-queue-peek-copy', peek);
    var peekTitle = make('strong', '', peekCopy);
    var peekSub = make('span', '', peekCopy);
    peek.title = '当前队列';

    // 浮条右端的舞台入口。墙开着时顶栏、胶囊导航都被 .qf-lattice-open 隐藏，
    // 迷你卡又正好被这条浮条压住 —— 墙上够得着的舞台入口一个都不剩，
    // 所以这颗必须**常驻可见**（不像那颗播放键 hover 才浮现）。
    var peekStage = make('button', 'qf-queue-peek-stage', peek);
    peekStage.type = 'button';
    peekStage.title = '打开舞台';
    peekStage.setAttribute('aria-label', '打开舞台');
    peekStage.innerHTML = icon('expand');
    peekStage.addEventListener('click', function (e) {
      // 不挡住就会冒泡到浮条本体，那变成「聚焦这一项」而不是进舞台。
      e.stopPropagation();
      openStage();
    });

    // 右下角：关灯开关 + 返回。
    var tools = make('div', 'qf-tools', root);
    var lights = make('button', 'qf-tools-btn', tools);
    lights.type = 'button';
    lights.setAttribute('aria-pressed', 'false');
    lights.innerHTML = icon('lamp');
    // 状态同步只此一份：点击与启动恢复（下面读 WALL_KEY 那处）都走它。
    // 两处各写一遍，标题与 aria-label 这种「第二份真相」必然漏改一处 ——
    // 之前就出现过灯已经关着、tooltip 还写着「关灯」。
    function syncLights() {
      root.classList.toggle('is-lights-out', wall.lightsOut);
      lights.classList.toggle('is-on', wall.lightsOut);
      lights.setAttribute('aria-pressed', String(wall.lightsOut));
      // 标题说的是「点下去会发生什么」，所以跟着当前状态翻面。
      lights.title = wall.lightsOut ? '开灯' : '关灯';
      lights.setAttribute('aria-label', wall.lightsOut
        ? '开灯：恢复非当前播放海报的亮度'
        : '关灯：压暗非当前播放的海报');
    }
    syncLights();
    lights.addEventListener('click', function () {
      wall.lightsOut = !wall.lightsOut;
      syncLights();
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
    help.textContent = '← → 移动焦点 · Enter 播放/打开 · Esc 返回';
    // 「清空队列」只对播放队列那一列成立 —— 其余视图的项是视图自己的内容
    // （曲库/在线/收藏），清掉播放队列不会让墙变空，只会让「正在播放」那
    // 张卡消失。所以按来源显隐，而不是摆一个点了没用的按钮。
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
    refs.wallClear = clear;
    refs.wallPanel = panel;

    // 拖拽平移。
    //
    // **pointerdown 时不能 setPointerCapture** —— 捕获后 pointerup/click 会被
    // 重定向到 field（捕获元素），海报上的 click 处理器永远收不到，
    // 表现为「点墙上那张卡没反应」。浏览器实测三种点法里两种失效：
    //   · locator.click / page.mouse.click（真实输入）→ click 落在 field 上，卡片不动
    //   · element.click()（JS 直调，不走捕获路径）→ 正常展开
    // 两种结果不一致本身就是证据：问题出在指针捕获，不在点击逻辑。
    //
    // 改成越过拖拽阈值**之后**才捕获：那一步才确定用户是在拖墙而不是点卡片，
    // 此时捕获是有意的（拖拽就该把指针收进 field）。纯点击全程不捕获，
    // click 照常派发给海报。
    var drag = null;
    field.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.qf-poster-controls')) return;
      drag = { x: e.clientX, y: e.clientY, cx: wall.cam.x, cy: wall.cam.y, moved: false };
    });
    field.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x;
      var dy = e.clientY - drag.y;
      // 阈值 4px：小抖动不算拖拽，否则点卡片会被吃掉一次平移。
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      if (!drag.moved) {
        drag.moved = true;
        // 到这一步才确认是拖拽，此时捕获指针才是对的。
        try { field.setPointerCapture(e.pointerId); } catch (err) { /* 捕获失败不影响拖拽 */ }
        // 拖拽一来就摘让位过渡：平移必须 1:1 跟手，不许被过渡拖尾。
        if (wall.root) wall.root.classList.remove('is-reflow');
      }
      wall.cam.x = drag.cx + dx;
      wall.cam.y = drag.cy + dy;
      applyCamera();
      renderWall();
    });
    function endDrag(e) {
      if (!drag) return;
      // 只在真的捕获过（moved）时才release —— 纯点击那条路从没捕获过，
      // 对未捕获的指针调 release 是规范允许的空操作，但意图上不该调。
      if (drag.moved) {
        try { field.releasePointerCapture(e.pointerId); } catch (err) { /* 已释放 */ }
      }
      drag = null;
    }
    field.addEventListener('pointerup', endDrag);
    field.addEventListener('pointercancel', endDrag);
    field.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (wall.root) wall.root.classList.remove('is-reflow');
      wall.cam.y -= e.deltaY;
      applyCamera();
      renderWall();
    }, { passive: false });

    document.body.appendChild(root);

    refs.wallRoot = root;
    refs.wallField = field;
    refs.wallWorld = world;
    refs.wallEmpty = empty;
    refs.wallEmptyTitle = emptyTitle;
    refs.wallEmptyHint = emptyHint;
    refs.wallTag = tag;
    refs.wallTagLabel = tagLabel;
    refs.wallTagCount = tagCount;
    refs.wallTagBack = tagBack;
    refs.wallPeek = peek;
    refs.wallPeekArt = peekArt;
    refs.wallPeekPlay = peekPlay;
    refs.wallPeekTitle = peekTitle;
    refs.wallPeekSub = peekSub;
    refs.wallPanelBtn = panelBtn;
    wall.root = root;
    wall.field = field;
    wall.world = world;
    wall.nodeByKey = new Map();

    var saved = null;
    try { saved = localStorage.getItem(WALL_KEY); } catch (e) { saved = null; }
    wall.lightsOut = saved === '1';
    syncLights();

    // 观感/跟随偏好（设置页「海报墙」组写的 localStorage，见 wireWallSettings）。
    wall.follow = readFlag(WALL_FOLLOW_KEY, true);
    wall.vignette = readFlag(WALL_VIGNETTE_KEY, true);
    wall.tint = readFlag(WALL_TINT_KEY, false);
    wall.tintColor = readStr(WALL_TINT_COLOR_KEY, WALL_TINT_DEFAULT_COLOR);
    var intensity = Number(readStr(WALL_TINT_INTENSITY_KEY, String(WALL_TINT_DEFAULT_INTENSITY)));
    wall.tintIntensity = Number.isFinite(intensity) ? Math.max(0, Math.min(100, Math.round(intensity))) : WALL_TINT_DEFAULT_INTENSITY;
    applyWallLook();

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
    // 上一次退场波还没播完就重开：掐掉清理定时器、摘退场标记，
    // 这面墙从入场波重新开始，而不是接着残局。
    if (wall.closeTimer) { clearTimeout(wall.closeTimer); wall.closeTimer = 0; }
    if (wall.root) wall.root.classList.remove('is-closing');
    wall.open = true;
    wall.drill = null;
    wall.drillBusy = false;
    wall.drillError = '';
    wall.reflow = null;
    wall.entranceUntil = performance.now() + ENTRANCE_WINDOW;
    var src = requestSource();
    applySource(src);
    wall.focused = -1;
    wall.expanded = -1;
    wall.expandedKey = '';
    wall.cam.s = wallScale();
    wall.cam.x = 34;
    wall.cam.y = 80;
    if (wall.root) wall.root.hidden = false;
    document.body.classList.add('qf-lattice-open');
    if (refs.wallBtn) refs.wallBtn.classList.add('is-active');
    applyCamera();
    renderWall();
    // 自动聚焦到正在播放那张，墙一开就有主体（就近挑实例，不长途飞行）。
    // 歌单那一份没有「正在播放」的概念（歌单不是曲），聚焦第 0 项即可。
    var idx = wall.tiles.findIndex(posterIsCurrent);
    if (idx >= 0) focusQueueIndex(idx, true);
    // 没有「正在播放」那张（歌单墙永远没有）时落到第 0 项，并**保证它在
    // 视口内** —— 密排下它的格位可能整个在视口外，那样用户看到一片空白，
    // 以为墙没加载出来。
    else if (wall.tiles.length) focusAndReveal(0);
  }

  /// 把一份来源快照铺到墙上。第一层与第二层共用这一条路径 ——
  /// 区别只是快照的 kind 与 label 不同。
  function applySource(src) {
    wall.tiles = (src && src.items) || [];
    wall.sourceKey = (src && src.key) || '';
    // 第二层的标题是「歌单名」，第一层用来源名。
    wall.sourceLabel = wall.drill
      ? wall.drill.name
      : ((src && src.label) || '');
    wall.emptyHint = (src && src.emptyHint) || '';
    // 换源必须换内容：海报上的曲名/封面/点击闭包都是**建卡那一刻**抓的快照，
    // 复用旧节点的话，切了 tab 墙上还挂着上一个 tab 的歌，点击还会播错歌。
    // 密排的格位键（bx:by:slot）换源前后一模一样，diff 会把旧节点全留下
    // —— 所以清空让 renderWall 按新源重建。
    clearPosters();
    paintSourceTag();
    paintEmptyState();
  }

  /// 展开一个歌单：进第二层看它里面的歌。
  /// 不直接播 —— 直接播用户根本不知道自己听的是哪个歌单。
  function enterDrill(item) {
    var out = emit('playlist-drill', { source: item.source, playlistId: item.playlistId });
    var res = out && out.result;
    wall.drill = { source: item.source, playlistId: item.playlistId, name: item.title };
    wall.drillBusy = true;
    wall.drillError = '';
    wall.expanded = -1;
    wall.expandedKey = '';
    // 先退到收起态再换列，否则展开档的尺寸会按新列的格位算错。
    collapse(true);
    wall.tiles = [];
    wall.sourceLabel = item.title;
    paintSourceTag();
    renderWall();
    if (!res || typeof res.then !== 'function') {
      wall.drillBusy = false;
      wall.drillError = (out && out.error) || '歌单展开功能还没准备好';
      paintEmptyState();
      return;
    }
    res.then(function (r) {
      // 拉的过程中用户可能已经 Esc 关了墙或退回了第一层，这时别再改墙。
      if (!wall.open || !wall.drill) return;
      wall.drillBusy = false;
      if (r && r.error) {
        wall.drillError = r.error;
        wall.tiles = [];
      } else {
        var list = (r && r.tracks) || [];
        // 第二层的项要按「曲」来造，不能带 isPlaylist —— 否则点开又进第三层。
        wall.tiles = list.map(drillItem);
        wall.drillError = list.length ? '' : '这个歌单是空的';
      }
      wall.focused = -1;
      paintSourceTag();
      paintEmptyState();
      renderWall();
      if (wall.tiles.length) focusPoster(0, true);
    });
  }

  /// 第二层的项。形状与 app.js 的 onlineSourceItem 一致，但**不带 isPlaylist**。
  function drillItem(t, i) {
    var Online = window.Online;
    var duration = Number(t.duration_ms) || 0;
    return {
      id: 'online:' + (t.source || 'netease') + ':' + ((t.ref && (t.ref.id || t.ref.song_id)) || t.id),
      sourceKey: 'playlists',
      source: t.source,
      ref: t.ref || {},
      raw: t,
      index: i,
      badge: i + 1,
      title: t.title || '未知曲目',
      artist: t.artist || '未知艺术家',
      duration: duration || null,
      cover: Online ? Online.safeCoverUrl(t.cover || null) : null,
      current: false,
      playing: false,
      progress: 0,
    };
  }

  /// 退回第一层（从歌单里返回歌单列表）。
  function leaveDrill() {
    if (!wall.drill) return;
    wall.drill = null;
    wall.drillBusy = false;
    wall.drillError = '';
    wall.expanded = -1;
    wall.expandedKey = '';
    collapse(true);
    applySource(requestSource());
    wall.focused = -1;
    renderWall();
  }

  function closeWall() {
    if (!wall.open) return;
    wall.open = false;
    // 第二层直接退到第一层而不是留在歌单里 —— 关掉再开应该还是原来的那个 tab
    // 的内容，进去-退出-再开要停在歌单里会让人以为随机。
    wall.drill = null;
    wall.drillBusy = false;
    wall.drillError = '';
    document.body.classList.remove('qf-lattice-open');
    if (refs.wallBtn) refs.wallBtn.classList.remove('is-active');
    // 退场波：卡片按入场延时的补数依次飞回上去（folia 的退出反向波），
    // 墙朝它进来的那个角清空。root 先留着，播完再藏再回收。
    // reduced-motion 或墙上没卡（空态）时没必要演，直接收。
    var reduced = wallMotionReduced();
    if (wall.root && wall.posters.length && !reduced) {
      wall.posters.forEach(function (el) {
        el.style.setProperty('--qf-exit-delay', exitDelayFor(posterWorldRect(el)).toFixed(3) + 's');
      });
      wall.root.classList.add('is-closing');
      wall.closeTimer = setTimeout(finishWallClose, ENTRANCE_MAX_DELAY * 1000 + 420);
    } else {
      if (wall.root) wall.root.hidden = true;
      clearPosters();
    }
  }

  /// 退场波播完：藏 root、回收海报、摘标记。
  function finishWallClose() {
    wall.closeTimer = 0;
    if (wall.root) {
      wall.root.classList.remove('is-closing');
      wall.root.hidden = true;
    }
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
    if (wall.nodeByKey) wall.nodeByKey.clear();
    wall.reflow = null;
    wall.focused = -1;
    wall.focusedKey = '';
  }

  /// 一张海报此刻该在的矩形：展开期间查让位表，其余时候是原格位。
  function resolveRect(entry) {
    if (wall.reflow) {
      var r = wall.reflow.get(entry.key);
      if (r) return r;
    }
    return entry.rect;
  }

  /// 重绘画布。只渲染落在裁剪区（含 OVERSCAN）里的格子，上限 MAX_INSTANCES ——
  /// 不设上限的话一次 pan 就能建出上千个节点，滚动会明显掉帧。
  function renderWall() {
    if (!wall.open || !wall.world) return;
    if (!wall.tiles.length) {
      clearPosters();
      paintEmptyState();
      paintSourceTag();
      return;
    }
    paintEmptyState();

    var b = wallBounds();
    var entries = [];
    var b0x = Math.floor(b.left / (BLOCK_COLS * PITCH)) - 1;
    var b1x = Math.ceil(b.right / (BLOCK_COLS * PITCH)) + 1;
    var b0y = Math.floor(b.top / (BLOCK_ROWS * PITCH)) - 1;
    var b1y = Math.ceil(b.bottom / (BLOCK_ROWS * PITCH)) + 1;

    for (var by = b0y; by <= b1y && entries.length < MAX_INSTANCES; by += 1) {
      for (var bx = b0x; bx <= b1x && entries.length < MAX_INSTANCES; bx += 1) {
        var cells = blockCells(bx, by);
        for (var i = 0; i < cells.length && entries.length < MAX_INSTANCES; i += 1) {
          var r = cellRect(bx, by, cells[i]);
          if (r.x + r.w < b.left || r.x > b.right || r.y + r.h < b.top || r.y > b.bottom) continue;
          entries.push({ rect: r, key: bx + ':' + by + ':' + i });
        }
      }
    }

    // 键控差量：节点与格位键绑定（folia 的 instanceId 同款）。平移时窗口
    // 一端的键离开、另一端进来，各建各的、各删各的 —— 位置复用会让
    // 「节点 ↔ 格位」错位，展开卡会在下一次重绘时被拍到别人的格位上。
    var seen = new Set();
    var next = [];
    for (var k = 0; k < entries.length; k += 1) {
      seen.add(entries[k].key);
      var node = wall.nodeByKey.get(entries[k].key);
      if (!node) node = createPoster(entries[k]);
      else placePoster(node, resolveRect(entries[k]));
      next.push(node);
    }
    wall.nodeByKey.forEach(function (node, key) {
      if (!seen.has(key)) {
        node.remove();
        wall.nodeByKey.delete(key);
      }
    });
    wall.posters = next;
    // 焦点跟节点（键控）走：重渲染后节点还在就更新下标，被平移出窗口
    // 就当作失去焦点。
    if (wall.focusedKey) {
      wall.focused = -1;
      for (var f = 0; f < next.length; f += 1) {
        if (next[f].dataset.qfKey === wall.focusedKey) { wall.focused = f; break; }
      }
      if (wall.focused < 0) wall.focusedKey = '';
    }
    updatePeek();
  }

  function createPoster(entry) {
    var tile = tileForKey(entry.key);
    var el = document.createElement('article');
    el.className = 'qf-poster';
    el.dataset.qfKey = entry.key;
    if (tile && tile.current) el.classList.add('is-current');
    if (tile && tile.cover) {
      var img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      el.appendChild(img);
      applyImg(img, tile.cover);
    }
    // 统一着色层（设置页「海报墙 → 海报统一着色」）：压在封面上、
    // 文字与 scrim 之下，开关与强度走根节点上的 CSS 变量。
    var tint = document.createElement('span');
    tint.className = 'qf-poster-tint';
    el.appendChild(tint);

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

    // 存原始格位（展开档以让位表为准，收起/校验回到它）。
    el.dataset.qfRect = JSON.stringify(entry.rect);
    // 初次落位也要过 resolveRect：展开期间平移新露出的卡直接按让位表摆。
    placePoster(el, resolveRect(entry));
    // 入场波窗口内的卡按到视口左上角的距离依次落下（Metro 着陆）；
    // 窗口外（平移/换源）露出的卡走 CSS 默认的一次轻上浮，不重播整波。
    if (wall.open && !wallMotionReduced() && performance.now() < wall.entranceUntil) {
      el.classList.add('is-landing');
      el.style.setProperty('--qf-land-delay', entranceDelayFor(entry.rect).toFixed(3) + 's');
    }

    el.addEventListener('click', function (e) {
      // 展开态下点卡片本体是收起；控件区自己 stopPropagation 了。
      if (e.target.closest('.qf-poster-controls')) return;
      if (el.classList.contains('is-expanded')) collapse();
      else if (tile && tile.isPlaylist) {
        // 歌单：进第二层看里面的歌，不直接播。
        var at = wall.posters.indexOf(el);
        enterDrill(tile);
        if (at >= 0) wall.focused = at;
      } else focusPoster(wall.posters.indexOf(el), true);
    });

    wall.world.appendChild(el);
    wall.nodeByKey.set(entry.key, el);
    return el;
  }

  function placePoster(el, rect) {
    el.style.left = rect.x + 'px';
    el.style.top = rect.y + 'px';
    el.style.width = rect.w + 'px';
    el.style.height = rect.h + 'px';
    // hover/聚焦的「pop」放大系数：四条边各向外长出一个 GAP（folia 的
    // popScale）。X/Y 独立算，非方形的卡也恰好各长出一格缝。
    el.style.setProperty('--qf-popx', ((rect.w + GAP * 2) / rect.w).toFixed(4));
    el.style.setProperty('--qf-popy', ((rect.h + GAP * 2) / rect.h).toFixed(4));
  }

  /// 按让位表展开一块：被点的卡吃到 6×6 档，同块其余 11 张换小档重新铺满，
  /// 邻居块纹丝不动（folia 的 layoutExpandedBlock —— 「让位」而不是「压住」）。
  /// 过渡靠 .is-reflow 短暂挂类：拖拽/滚轮一来就摘，平移必须 1:1 不许拖尾。
  function kickReflowTransition() {
    if (wall.reflowTimer) clearTimeout(wall.reflowTimer);
    if (wall.root) wall.root.classList.add('is-reflow');
    wall.reflowTimer = setTimeout(function () {
      wall.reflowTimer = 0;
      if (wall.root) wall.root.classList.remove('is-reflow');
    }, REFLOW_ANIM_MS);
  }

  function expandGear(index) {
    var el = wall.posters[index];
    if (!el) return;
    var m = /^(-?\d+):(-?\d+):(\d+)$/.exec(el.dataset.qfKey || '');
    if (!m) return;
    var reflow = blockReflow(Number(m[1]), Number(m[2]), Number(m[3]));
    if (!reflow) return;
    var map = new Map();
    for (var i = 0; i < reflow.length; i += 1) {
      map.set(m[1] + ':' + m[2] + ':' + i, cellRect(Number(m[1]), Number(m[2]), reflow[i]));
    }
    wall.reflow = map;
    kickReflowTransition();
    renderWall();
    buildPosterControls(el);
  }

  function focusPoster(index, expand) {
    if (index < 0 || index >= wall.posters.length) return;
    wall.focused = index;
    wall.focusedKey = wall.posters[index].dataset.qfKey || '';
    wall.posters.forEach(function (n, i) { n.classList.toggle('is-focused', i === index); });
    if (expand) {
      // **先收起上一张**。开墙时若源里有 current 项，它已经被展开
      //（openWall 里 focusQueueIndex 的展开分支），用户再点另一张时若不收，
      // 墙上会同时铺着两张 6×6 展开档 —— 既视觉错乱（两张都在抢注意力），
      // 也让「展开的是哪一张」这件事变得不确定（querySelector 取到的是第一张）。
      // 静默收起（不重绘）：列马上要按新卡重排。键控差量下 wall.expanded
      // 的下标会随重渲染漂移，收起必须按**格位键**找节点。
      var el = wall.posters[index];
      if (wall.expandedKey && wall.expandedKey !== el.dataset.qfKey) collapse(true);
      wall.expanded = index;
      wall.expandedKey = el.dataset.qfKey;
      el.classList.add('is-expanded');
      expandGear(index);
      panTo(el);
    }
    // 浮条跟焦点走：歌单那列没有 current，不跟焦点就永远显示第一张。
    updatePeek();
  }

  /// 聚焦「显示第 qi 项」的那张，并保证它在视口内。
  ///
  /// 单独于 focusPoster 是因为**不能把这件事塞进 focusPoster**：
  /// 方向键移动焦点时每一步都 panTo 会让键盘导航没法用（每按一次就跳一次）。
  /// 只有「刚开墙 / 刚换源」这种一次性定位才需要。
  ///
  /// 为什么按**项**找而不是按下标：墙是循环铺满的，同一项有很多实例，
  /// 就近挑一张（folia 的 locateNearestInstance）不用长途飞行；开墙时若
  /// 没有「正在播放」（歌单墙永远没有），就退到第 0 项的最近实例 ——
  /// 它的格位完全可能在视口外，那样用户看到的是一片空白，还以为墙没加载。
  function focusQueueIndex(qi, expand) {
    if (qi < 0 || !wall.open) return;
    var inst = locateNearestInstance(qi, viewportCenterWorld());
    if (!inst) return;
    var node = wall.nodeByKey.get(inst.key);
    if (!node) {
      // 最近实例不在挂载集（OVERSCAN 之外）：把相机瞬间对过去再渲染。
      // 开墙首聚焦走瞬时对位（folia 的 instant），不做飞行。
      wall.cam.x = (window.innerWidth || 1280) / 2 - (inst.rect.x + inst.rect.w / 2) * wall.cam.s;
      wall.cam.y = (window.innerHeight || 800) / 2 - (inst.rect.y + inst.rect.h / 2) * wall.cam.s;
      applyCamera();
      renderWall();
      node = wall.nodeByKey.get(inst.key);
    }
    if (node) focusPoster(wall.posters.indexOf(node), expand);
  }

  function focusAndReveal(index) {
    focusQueueIndex(index, false);
  }

  /// 收起展开档，块内卡片滑回原格位。silent = true 时不重绘不过渡
  /// （换列时用，列马上要重建）。
  function collapse(silent) {
    if (!wall.expandedKey) return;
    var el = wall.nodeByKey.get(wall.expandedKey);
    wall.reflow = null;
    wall.expanded = -1;
    wall.expandedKey = '';
    if (el) {
      el.classList.remove('is-expanded');
      var ctl = $('.qf-poster-controls', el);
      if (ctl) ctl.remove();
    }
    if (!silent) {
      kickReflowTransition();
      renderWall();
    }
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
    // 名字带 Pan 是为了跟模块级的 step(delta)（上/下一首）区分开：
    // 同名局部函数在两处含义完全不同，读代码时极易以为它们是一件事。
    function stepPan(ts) {
      if (!t0) t0 = ts;
      var t = Math.min(1, (ts - t0) / DUR);
      // easeOutExpo —— 参考项目 useWallCameraPan.ts 用 [0.22,1,0.36,1]，
      // 那正是 easeOutExpo 的贝塞尔写法，视觉等价。
      var e = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      wall.cam.x = fromX + (targetX - fromX) * e;
      wall.cam.y = fromY + (targetY - fromY) * e;
      applyCamera();
      // 挂载集必须跟相机走：飞行可能跨出 OVERSCAN，不跟的话落地后
      // 窗口外是空的，下一次重绘还会把格位键整体错位（实测展开卡被
      // 拍到别人的 2×2 格上）。键控差量每帧增量建/删，代价可控。
      renderWall();
      if (t < 1) wall.raf = requestAnimationFrame(stepPan);
      else wall.raf = 0;
    }
    wall.raf = requestAnimationFrame(stepPan);
  }

  /// 这张海报是不是「现在在放的那首」。
  ///
  /// 判据与 app.js 自己算 current 时用的是同一个字符串（tile.id 就是快照里的
  /// track_id），所以皮肤不需要重新发明一套 id 协议。没收到过换曲广播时用建卡
  /// 那份快照的 current —— 开墙那一下快照是新的。
  function posterIsCurrent(tile) {
    if (!tile || tile.isPlaylist) return false;
    return wall.trackId ? wall.trackId === String(tile.id) : !!tile.current;
  }

  /// 「在不在放」直接读 body.is-playing：Stage.setSnapshot 每个快照都同步它。
  /// 自己缓存一份必漏 —— 暂停和续播都不换曲，没有 playback:track 可跟。
  function posterIsPlaying(tile) {
    return posterIsCurrent(tile) && document.body.classList.contains('is-playing');
  }

  /// 只重画那颗按钮，不重建控制条：重建会把展开过渡与相机让位一起卷进来。
  function paintPosterPlay(el) {
    var btn = el && $('.qf-chrome-play', el);
    var tile = el && posterTile(el);
    if (!btn || !tile || tile.isPlaylist) return;   // 歌单那颗是「打开歌单」，没有播放态
    var playing = posterIsPlaying(tile);
    var label = playing ? '暂停' : '播放';
    btn.innerHTML = icon(playing ? 'pause' : 'play');
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  /// 换曲 / 暂停续播 → 展开档跟到当前曲，墙上那两颗播放键翻面。
  ///
  /// 顺序要紧：先记 trackId 再 followCurrent。后者挑卡用的是「现在在放哪首」，
  /// 而 tile.current 是建卡那一刻的快照（换曲不会重取源），照快照跟就会一直停在
  /// 上一首那张卡上 —— 表现是「换歌了墙不动」。
  function onWallPlayback(e) {
    if (e.type === 'playback:track') {
      wall.trackId = String((e.detail && e.detail.track_id) || '');
      followCurrent();
    }
    if (!wall.open) return;
    paintPosterPlay(wall.expandedKey && wall.nodeByKey ? wall.nodeByKey.get(wall.expandedKey) : null);
    updatePeek();
  }

  function buildPosterControls(el) {
    // 节点是键控复用的，展开一张建过的卡不会重跑这里 —— 复用时至少把图标
    // 按实时态纠正一次，否则收起再展开会看到旧的播放/暂停面。
    if ($('.qf-poster-controls', el)) { paintPosterPlay(el); return; }
    var tile = posterTile(el);
    var box = document.createElement('div');
    box.className = 'qf-poster-controls';

    var chrome = document.createElement('div');
    chrome.className = 'qf-chrome';
    var row = document.createElement('div');
    row.className = 'qf-chrome-row';

    // 歌单那列没有「上一首/播放/下一首」这组控件 —— 它不是曲，
    // 换成「打开这个歌单」一个动作，否则用户会以为点播放能直接开播。
    if (tile && tile.isPlaylist) {
      var open = document.createElement('button');
      open.type = 'button';
      // 带 .is-labelled 是因为它有文字：.qf-chrome button 给的是方形固定尺寸
      // （给 20px 图标用的），直接放文字会被压扁。用显式 class 而不是
      // CSS 里的 :has(span) —— :has() 在旧内核上不生效时会静默退回压扁版。
      open.className = 'qf-chrome-play is-labelled';
      open.title = '打开这个歌单';
      open.setAttribute('aria-label', '打开这个歌单');
      open.innerHTML = icon('play') + '<span>打开歌单</span>';
      open.addEventListener('click', function (e) {
        e.stopPropagation();
        enterDrill(tile);
      });
      row.appendChild(open);
    } else {
      var prev = document.createElement('button');
      prev.type = 'button';
      prev.title = '上一首';
      prev.setAttribute('aria-label', '上一首');
      prev.innerHTML = icon('prev');
      prev.addEventListener('click', function (e) { e.stopPropagation(); step(-1); });

      var play = document.createElement('button');
      play.type = 'button';
      play.className = 'qf-chrome-play';
      play.addEventListener('click', function (e) {
        e.stopPropagation();
        // 已经是当前曲 → 这颗就是播放/暂停键，复用业务 toggle-play（左下角浮条同一条
        // 路，它带「没在放任何东西时先起播当前选中项」的回落）。再发一次 activate
        // 等于把同一首重新 load 一遍，用户看到的是「点了没反应」。
        if (posterIsCurrent(tile)) emit('toggle-play');
        // 走 activate 而不是 play-index：墙上的下标是**本视图**的下标，
        // play-index 按的是播放队列下标，传墙上的数会播错歌。
        // list 带上墙上这一列，业务才不必按当前 tab 重推（第二层推出来是歌单记录）。
        else emit('activate', { item: tile, list: wall.tiles });
        // toggle-play 不换曲，等不到 playback:track；app.js 的乐观快照
        // （setPlayback 先 applySnapshot 再 POST）在这条调用链里已经翻过
        // body.is-playing，所以点完立刻重画拿到的就是新值。
        paintPosterPlay(el);
      });

      var next = document.createElement('button');
      next.type = 'button';
      next.title = '下一首';
      next.setAttribute('aria-label', '下一首');
      next.innerHTML = icon('next');
      next.addEventListener('click', function (e) { e.stopPropagation(); step(1); });

      var time = document.createElement('span');
      time.className = 'qf-chrome-time';
      time.textContent = tile && tile.duration ? fmtDur(tile.duration) : '';

      row.appendChild(prev);
      row.appendChild(play);
      row.appendChild(next);
      row.appendChild(time);
    }
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
    // 没在放的那首不给进度条 —— 第二层（刚点开的歌单）与非当前项
    // 拖了也不知道拖的是谁，拖了还会误以为在 seek。
    progress.hidden = !(tile && tile.current);

    box.appendChild(chrome);
    box.appendChild(progress);
    el.appendChild(box);
    // 图标按实时态画，不吃 tile.playing 那份建卡快照 —— 快照只在建卡那一帧是新的。
    paintPosterPlay(el);
  }

  /// 上一首/下一首 = **播放队列**里前后各一首，即「正在放的那首」的邻居。
  ///
  /// 曾经发的是 `activate` + delta（按墙上这一列的前后项算），那个语义是错的：
  /// 展开卡是 focusPoster 聚焦的那张，用户很可能停在第 3 张上（还没点播）
  /// 就按了下一首，而曲库/歌单/收藏这些 tab 的墙上序号与播放队列下标毫无
  /// 关系 —— app.js 拿墙上那一项去队列里 findIndex 必然 -1，落到
  /// 「从头开始」的兜底，于是永远停在队列第一首，听感就是「按了没反应」。
  /// 而「点歌能播、进度在走、唯独上/下一曲不动」正是用户报的现象。
  ///
  /// 所以这里只发意图（step-track），真正按播放队列算的活交给 app.js ——
  /// 播放路径仍然只有一条。
  function step(delta) {
    emit('step-track', { delta: delta });
  }

  function fmtDur(ms) {
    if (!ms || ms < 0) return '';
    var total = Math.round(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /// 左下角浮条：显示「当前聚焦的那一项」。
  ///
  /// 不再优先找 current：歌单那列没有「正在播放」的概念（一首歌单不是在放的），
  /// 硬找会退化成永远显示第一张，用户在看第 20 张歌单时浮条还停在第 1 张。
  /// 聚焦优先、没有聚焦才回落到 current，最后才是第一项。
  /// 浮条当前该显示哪一项。与 updatePeek 共用一份判据 ——
  /// 拆两处的话，按钮点下去播的那首会跟浮条上写着的那首不一致。
  function peekTile() {
    return posterTile(wall.posters[wall.focused])
      || wall.tiles.find(posterIsCurrent) || wall.tiles[0];
  }

  function updatePeek() {
    if (!refs.wallPeek) return;
    var t = peekTile();
    if (!t) {
      refs.wallPeek.hidden = true;
      return;
    }
    refs.wallPeek.hidden = false;
    refs.wallPeekTitle.textContent = t.title;
    refs.wallPeekSub.textContent = t.artist || '未知艺术家';
    if (refs.wallPeek) {
      // 歌单那列的浮条标题要说明它是歌单，否则「点它会怎样」不明确。
      refs.wallPeek.title = t.isPlaylist ? '歌单 · 点开看里面的歌' : (wall.sourceLabel || '当前');
    }
    if (refs.wallPeekPlay) {
      // 歌单项：这一列没有「正在放」的概念，按钮是「打开歌单」。
      // 已经在放的那首：图标切成暂停。title/aria-label 一起换，
      // 屏幕阅读器读到的才不会与图标相反。实时判据与展开卡那颗共用一份。
      var playing = posterIsPlaying(t);
      var label = t.isPlaylist ? '打开歌单' : (playing ? '暂停' : '播放');
      refs.wallPeekPlay.innerHTML = icon(t.isPlaylist ? 'play' : (playing ? 'pause' : 'play'));
      refs.wallPeekPlay.title = label;
      refs.wallPeekPlay.setAttribute('aria-label', label);
      refs.wallPeekPlay.classList.toggle('is-labelled', !!t.isPlaylist);
    }
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
    // Esc 分层退：第二层先退回歌单列表，再按才退出整面墙。
    // 不分层的话在歌单里按 Esc 会连墙一起关掉，用户丢掉了「回到列表」的中间态，
    // 下次进来又要重新点一遍歌单。
    if (e.key === 'Escape') {
      if (wall.drill) leaveDrill();
      else closeWall();
      return;
    }
    if (e.key === 'Backspace' && wall.drill) {
      e.preventDefault();
      leaveDrill();
      return;
    }
    if (e.key === 'ArrowRight') { focusPoster(wall.focused + 1, false); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { focusPoster(wall.focused - 1, false); e.preventDefault(); }
    else if (e.key === 'Enter' || e.key === ' ') {
      var at = wall.focused < 0 ? 0 : wall.focused;
      var t = posterTile(wall.posters[at]);
      e.preventDefault();
      // 歌单项：Enter 是「打开歌单」而不是展开卡片 —— 卡片里那个
      // 「打开歌单」按钮才是同一条路径，键盘与鼠标必须一致。
      if (t && t.isPlaylist) enterDrill(t);
      else focusPoster(at, true);
    }
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
    var viewKey = id.replace(/^view-/, '');
    if (refs.viewId !== id) {
      refs.column.scrollTop = 0;
      // 墙开着时切 tab —— **换源，不关墙**。
      //
      // 需求是「每个 tab 都有队列拼接」，所以从歌单页开着墙切到电台页，
      // 期望看到的是电台的内容，而不是墙被关掉、用户什么也没换到。
      // 关掉的话这个功能就退化成「只有队列 tab 有队列拼接」。
      //
      // 换源前先退回第一层：在歌单的第二层里切 tab 会把「歌单里的歌」
      // 留在墙上，那属于上一个 tab 的内容。
      if (wall.open) {
        var wasDrill = !!wall.drill;
        wall.drill = null;
        wall.drillBusy = false;
        wall.drillError = '';
        collapse(true);
        applySource(requestSource());
        wall.focused = -1;
        wall.expanded = -1;
    wall.expandedKey = '';
        renderWall();
        // 新来源没有「正在播放」可聚焦时，落在第一张，墙不至于空着没主体。
        if (wall.tiles.length) {
          var at = wall.tiles.findIndex(posterIsCurrent);
          focusAndReveal(at >= 0 ? at : 0);
        }
        if (wasDrill) applyCamera();
      }
    }
    refs.viewId = id;
    var navKey = id === 'view-daily' ? 'online' : viewKey;
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
    // 分区可见性跟 rail 同源：设置里关掉的分区（app.js 的 applyNavVisibility
    // 会摘 rail 入口），胶囊菜单里也不再出现。「每日推荐」那颗是 daily-view
    // 挂进 rail 的，关掉是整个按钮消失，按「按钮还在不在」判。
    if (refs.nav && refs.rail) {
      refs.nav.querySelectorAll('[data-qf-view]').forEach(function (button) {
        var key = button.dataset.qfView;
        if (key === 'wall') return;
        var railItem = refs.rail.querySelector('.rail-item[data-view="' + key + '"]');
        if (key === 'daily') railItem = document.getElementById('rail-daily');
        button.hidden = !railItem || railItem.hidden;
      });
    }
    // 入口文案跟着当前 tab：这个入口开的是**当前视图**的墙，
    // 固定叫「队列拼接」会让人以为在所有 tab 下看的都是播放队列。
    if (refs.wallBtnText) {
      var label = WALL_TAB_LABELS[viewKey] || '队列拼接';
      refs.wallBtnText.textContent = label;
      refs.wallBtn.setAttribute('aria-label', label);
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
  // 迷你播放器控制行：上一首 / 播放暂停 / 下一首 + 关闭
  //
  // 卡片本体（#stage）是业务节点，样式重排全在 CSS（grid 命名区域）里做；
  // 这里只补业务没有的两样东西：一排控制按钮和一颗关闭。
  // -------------------------------------------------------------------------

  var MINI_CLOSED_KEY = 'vmusic.qf.stage.closed.v1';
  var mini = { trackHandler: null, lyric: null, a: null, b: null, lyricText: null, timer: null };
  // 当前句歌词的轮询间隔与跑马灯速度。行进是低频事件，用不着进 rAF；
  // 滚动本身交给 CSS 动画，这里只在上句→下句的瞬间动一次 DOM。
  var LYRIC_TICK_MS = 250;
  var LYRIC_SPEED = 28;   // 跑马灯速度 px/s，太快要追、太慢像卡死

  function svgIcon(name, cls) {
    return '<svg' + (cls ? ' class="' + cls + '"' : '') +
      ' viewBox="0 0 24 24" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  }

  function miniClosed() {
    try { return localStorage.getItem(MINI_CLOSED_KEY) === '1'; } catch (e) { return false; }
  }

  function applyMiniClosed() {
    var el = stageDrag.el;
    if (!el) return;
    // 用类不用 hidden：.stage 被皮肤钉成 display:grid，特异性压过 UA 的
    // [hidden] 规则，hidden 属性写上去也不会生效（最难查的那种「写了没效果」）。
    el.classList.toggle('qf-mini-closed', miniClosed());
    // 收起期间 tick 一直早退；display:none 里 clientWidth 恒为 0，量出来的
    // 溢出状态不可信，展开后强制重算一次。
    if (!miniClosed() && mini.lyric) {
      mini.lyricText = null;
      tickMiniLyric();
    }
  }

  function setMiniClosed(v) {
    try {
      if (v) localStorage.setItem(MINI_CLOSED_KEY, '1');
      else localStorage.removeItem(MINI_CLOSED_KEY);
    } catch (e) { /* 隐私模式 / 配额满：只影响「记住收起」，不影响功能 */ }
    applyMiniClosed();
  }

  /// 当前句歌词：Stage.lyrics()（行数组）+ Stage.position()（同一口本地
  /// 插值时钟），自己二分定位 —— 不读隐藏面板的 DOM（3D 舞台不开时那边的
  /// 行根本不更新）。用户的逐曲/全局偏移已在 app.js 烤进行时间里，直接用。
  /// 返回空串表示无歌词或还没唱到第一句（前奏），卡片整行收起。
  function lyricLineText() {
    var st = window.Stage;
    if (!st || !st.lyrics || typeof st.position !== 'function') return '';
    var doc = st.lyrics();
    var lines = doc && doc.lines;
    if (!lines || !lines.length) return '';
    var pos = st.position();
    var lo = 0, hi = lines.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (lines[mid].start_ms <= pos) lo = mid + 1; else hi = mid;
    }
    if (lo === 0) return '';
    return lines[lo - 1].text || '· · ·';   // 间奏行没有词，给个呼吸感的占位
  }

  function tickMiniLyric() {
    var el = mini.lyric;
    if (!el || miniClosed()) return;
    var text = lyricLineText();
    if (text === mini.lyricText) return;
    mini.lyricText = text;
    // 两份拷贝只服务跑马灯的无缝循环；不滚的时候第二份由 CSS 收掉
    // （.qf-mini-lyric-inner span + span），否则放得下的歌词也会露出重复半句。
    mini.a.textContent = text;
    mini.b.textContent = text;
    el.classList.remove('is-scrolling');
    el.classList.toggle('is-empty', !text);
    if (!text) return;
    // 量宽决定是否滚动。文案变化才有这次强制布局，稳态轮询只是比对字符串。
    var cw = el.clientWidth;
    var tw = mini.a.offsetWidth;
    if (cw > 0 && tw > cw) {
      el.style.setProperty('--qf-lyric-dur', Math.max(6, Math.round(tw / LYRIC_SPEED)) + 's');
      el.classList.add('is-scrolling');
    }
  }

  function buildStageMini() {
    var el = stageDrag.el;
    var head = stageDrag.head;
    if (!el || !head) return;

    // 关闭放进把手（.stage-head）：flex space-between 把它推到最右。
    // 它是 button，onStageDragDown 的 closest 守卫会把它让出来，照常可点。
    var close = make('button', 'qf-mini-btn qf-mini-close', head);
    close.type = 'button';
    close.title = '收起迷你播放器（换曲会自动回来）';
    close.setAttribute('aria-label', '收起迷你播放器');
    close.innerHTML = svgIcon('close');
    close.addEventListener('click', function () { setMiniClosed(true); });

    // 当前句歌词行挂在卡片末尾（grid-area: lyric）。make() 必须传父节点，
    // 否则节点游离在 DOM 外，样式全不生效且不报错。
    var lyric = make('div', 'qf-mini-lyric', el);
    var inner = make('div', 'qf-mini-lyric-inner', lyric);
    mini.a = make('span', '', inner);
    mini.b = make('span', '', inner);
    mini.lyric = lyric;

    applyMiniClosed();
    tickMiniLyric();
    mini.timer = setInterval(tickMiniLyric, LYRIC_TICK_MS);
  }

  /// 换曲 = 「正在播放」的内容换了，收着的卡片重新浮出来 ——
  /// 否则关掉之后用户没有任何入口能再打开它（清风没有第二个入口指向 .stage）。
  function onMiniTrack() {
    if (!mounted) return;
    if (miniClosed()) setMiniClosed(false);
  }

  // -------------------------------------------------------------------------
  // 正在播放侧卡（.stage）：缩小 + 可拖动 + 位置持久化
  // -------------------------------------------------------------------------

  // key 升到 v2：默认停靠点从「播放胶囊右缘」改成「左下角」，旧记忆里那个
  // 坐标是按上一版语义摆的，留着等于让用户以为改动没生效。直接换 key，
  // 不做旧值映射。
  var STAGE_POS_KEY = 'vmusic.qf.stage.pos.v2';
  // 卡片四周的最小留白，贴边也不算被切掉。
  var STAGE_MARGIN = 12;
  // 底部不整体让位（旧版留 84px 防压头像）：播放胶囊和头像胶囊是两块具体的
  // 矩形，clampStage 按它们的实际位置把卡片推出去 —— 把整个下缘封死，等于
  // 把默认停靠点（就在下缘这条带上）也封了。

  function stageBounds() {
    var top = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--qf-clear')) || 96;
    return {
      left: STAGE_MARGIN,
      top: top,
      right: window.innerWidth - STAGE_MARGIN,
      bottom: window.innerHeight - STAGE_MARGIN,
    };
  }

  /// 停靠：没有用户记忆位置时，卡片贴在视口左下角 —— 左缘留一个最小留白，
  /// 竖直中心对齐播放胶囊（卡片就挂在胶囊那条带上）。
  ///
  /// 左下角是屏幕上常年空着的那块：内容列在它右边，胶囊居中、头像胶囊靠右，
  /// 都离它一截 —— 谁都不挡。窄视口下胶囊会涨到压住左缘，那时交给
  /// clampStage→pushOutFloaters 往上推（≤1100px 整卡已按设计撤掉，真走到
  /// 这一步的是「比 1100 宽一点、胶囊又顶到左边」的窗口）。
  function dockStage() {
    var el = stageDrag.el;
    if (!el) return;
    var bar = document.querySelector('.bar');
    var h = el.offsetHeight || 110;
    var barH = bar && bar.offsetHeight ? bar.offsetHeight : 76;
    var r = bar && !bar.classList.contains('is-hidden') ? bar.getBoundingClientRect() : null;
    // 中心优先**实测矩形**：.bar 除了 bottom:22px 还从基础样式继承了 margin，
    // 照公式算出来的落点比真实位置低十几像素（旧版横向停靠踩过同一条）。
    // 胶囊自动隐藏时矩形塌成 0 或被移走，才退回公式。
    var cy = r && r.height > 0 ? r.top + r.height / 2 : window.innerHeight - 22 - barH / 2;
    var p = clampStage(el, STAGE_MARGIN, cy - h / 2);
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.left = Math.round(p.x) + 'px';
    el.style.top = Math.round(p.y) + 'px';
  }

  /// 皮肤布局生效后：有记忆位置就恢复（钳制要用真实的卡片尺寸），没有
  /// 就停靠。挂载那一帧皮肤 CSS 可能还没生效（<link> 首次启用要现取），
  /// #stage 量出来还是栅格里的旧布局（实测 460×748），照那个尺寸停靠/
  /// 钳位必然歪 —— 等 .stage 的 position 变成 fixed（皮肤布局接管）再动；
  /// 等不到就维持 CSS 里的默认兜底位，最多等 240 帧（约 4 秒）。
  function restoreOrDock(saved, tries) {
    var el = stageDrag.el;
    if (!el) return;
    if (getComputedStyle(el).position !== 'fixed') {
      if (tries > 0) requestAnimationFrame(function () { restoreOrDock(saved, tries - 1); });
      return;
    }
    if (saved) applyStagePos(el, saved.x, saved.y);
    else dockStage();
  }

  /// 把卡片夹回可视区内。**每帧都要做**：拖动时窗口可能被拖动/缩放，
  /// 只在松手时夹一次的话，中途窗口缩小会让卡片整个跑到屏幕外。
  function clampStage(el, x, y) {
    var b = stageBounds();
    var w = el.offsetWidth || 232;
    var h = el.offsetHeight || 200;
    // 卡片比可用区还高时（很矮的窗口）以顶部为准，否则 top 会被算成负数
    var maxY = Math.max(b.top, b.bottom - h);
    var p = {
      x: Math.min(Math.max(x, b.left), Math.max(b.left, b.right - w)),
      y: Math.min(Math.max(y, b.top), maxY),
    };
    return pushOutFloaters(p, w, h);
  }

  /// 底部两块浮件（播放胶囊、头像胶囊）用矩形避让而不是封死下缘：
  /// 拖进它们的矩形就把整卡推到最高的那块上缘之外（两块水平错开，
  /// 取更高的上缘一次推完，两块都让开）。停靠位也走这里：卡片就停在胶囊那
  /// 条带上，宽视口下与它不相交（推不动），窄视口下正是靠这条才不被胶囊压住。
  function pushOutFloaters(p, w, h) {
    var floats = document.querySelectorAll('.bar:not(.is-hidden), .qf-account');
    var top = null;
    for (var i = 0; i < floats.length; i++) {
      var r = floats[i].getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (p.x + w <= r.left || p.x >= r.right ||
          p.y + h <= r.top || p.y >= r.bottom) continue;
      if (top === null || r.top < top) top = r.top;
    }
    if (top !== null) p.y = Math.max(stageBounds().top, Math.round(top - h - 8));
    return p;
  }

  function applyStagePos(el, x, y) {
    var p = clampStage(el, x, y);
    // right: auto 是必须的：卡片默认靠 right:24px 定位，不清掉的话
    // left 与 right 同时生效，宽度会被拉伸变形。
    el.style.right = 'auto';
    el.style.left = Math.round(p.x) + 'px';
    el.style.top = Math.round(p.y) + 'px';
    el.style.bottom = 'auto';
    return p;
  }

  function readStagePos() {
    try {
      var raw = localStorage.getItem(STAGE_POS_KEY);
      if (!raw) return null;
      var v = JSON.parse(raw);
      return (v && typeof v.x === 'number' && typeof v.y === 'number') ? v : null;
    } catch (e) { return null; }
  }

  function writeStagePos(p) {
    // 隐私模式 / 配额满都会抛：只影响「记住卡片位置」，不影响功能。
    try { localStorage.setItem(STAGE_POS_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ }
  }

  function onStageDragDown(e) {
    if (e.button !== undefined && e.button !== 0) return;   // 只认左键
    var el = stageDrag.el;
    if (!el || el.hidden) return;
    // 卡片上的真控件（播放/上一首/下一首/关闭/进度滑块）照常点，不当拖动处理。
    // ⚠️ 守卫里**不能**写 [role="button"]：把手 .stage-head 自己就被设了
    // role=button（键盘可达），写进去等于把手把自己挡死 —— 实测抓过，
    // 症状是「整张卡哪儿都拖不动、控制台干净」。
    if (e.target && e.target.closest('button, a, input, textarea, select, .stage-lyrics')) return;

    var b = el.getBoundingClientRect();
    stageDrag.active = true;
    stageDrag.moved = false;
    stageDrag.startX = e.clientX;
    stageDrag.startY = e.clientY;
    stageDrag.origX = b.left;
    stageDrag.origY = b.top;
    stageDrag.offX = e.clientX - b.left;
    stageDrag.offY = e.clientY - b.top;
    el.classList.add('qf-dragging');
    document.body.classList.add('qf-stage-dragging');
    // **这里绝不能 setPointerCapture** —— 捕获后 pointerup/click 会被重定向
    // 到捕获元素（.stage-head），把头上的真按钮（模式切换 / 全屏 / 队列）
    // 全部吃掉，表现为「点标题栏上的按钮没反应」。
    // 本文件下面 buildWall() 的海报拖拽踩过同一个坑，注释在 884 行附近。
    // 正确做法：越过拖拽阈值**之后**才捕获（见 onStageDragMove）。
    e.preventDefault();
  }

  function onStageDragMove(e) {
    if (!stageDrag.active) return;
    var el = stageDrag.el;
    var dx = e.clientX - stageDrag.startX;
    var dy = e.clientY - stageDrag.startY;
    // 阈值 3px：抖动不算拖动，否则点一下把手也会把卡片挪走几像素。
    if (!stageDrag.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    if (!stageDrag.moved) {
      // 越过阈值才捕获：到这一步才确定用户是在拖卡片而不是点标题栏上的
      // 按钮。此刻捕获是有意的（拖拽该把指针收进 .stage-head）。
      stageDrag.moved = true;
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* 老浏览器忽略 */ }
    }
    applyStagePos(el, e.clientX - stageDrag.offX, e.clientY - stageDrag.offY);
  }

  function onStageDragUp(e) {
    if (!stageDrag.active) return;
    var el = stageDrag.el;
    stageDrag.active = false;
    if (el) {
      el.classList.remove('qf-dragging');
      try { el.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    document.body.classList.remove('qf-stage-dragging');
    // 只有真的挪过才记位置：点一下把手（没动）不该覆盖用户之前摆好的位置。
    if (stageDrag.moved && el) {
      var b = el.getBoundingClientRect();
      writeStagePos({ x: Math.round(b.left), y: Math.round(b.top) });
    }
  }

  function onStageResize() {
    if (!stageDrag.el) return;
    // 没拖过就重新停靠（卡片跟着胶囊那条带走）；拖过则只把原位置
    // 夹回屏内，不落盘，避免污染记忆。
    if (!readStagePos()) { dockStage(); return; }
    var b = stageDrag.el.getBoundingClientRect();
    applyStagePos(stageDrag.el, b.left, b.top);
  }

  /// 卡片高度会随内容变（歌词行出现/消失），而定位写的是 top —— 不重新停靠
  /// 的话，歌词一出现卡片就往下长一截，默认位读起来比胶囊那条带低半截。
  /// 只在没有记忆位时观察：拖过的位置归用户，不该被内容高度改动。
  function watchStageSize(el) {
    if (typeof ResizeObserver !== 'function') return null;
    var ro = new ResizeObserver(function () { if (!readStagePos()) dockStage(); });
    ro.observe(el);
    return ro;
  }

  function buildStageDrag() {
    var el = byId('stage');
    if (!el) return;
    var head = el.querySelector('.stage-head');
    if (!head) return;
    stageDrag.el = el;
    stageDrag.head = head;

    // 恢复上次位置；没拖过（无记忆）就停靠到视口左下角。两条路都等
    // 皮肤布局生效再量（见 restoreOrDock）。
    var saved = readStagePos();
    requestAnimationFrame(function () { restoreOrDock(saved, 240); });
    stageDrag.ro = watchStageSize(el);

    // 拖动入口挂在**整张卡**上：迷你卡只有一百多像素高，只留一条标题带当
    // 把手太难抓（实测抓不满）。控件由 onStageDragDown 的守卫让出来。
    el.addEventListener('pointerdown', onStageDragDown);
    var move = onStageDragMove;
    var up = onStageDragUp;
    // move/up 挂 document：指针可能被 pointercapture 交出去，也可能没交
    // （老浏览器不支持时），两边都要能收到。
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    window.addEventListener('resize', onStageResize);
    stageDragHandlers = { move: move, up: up };

    // 键盘可达：把手是 role=button 后，方向键移动、Esc 复位。
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.setAttribute('aria-label', '正在播放卡片，拖动或用方向键移动，双击复位');
    if (!head.getAttribute('title')) {
      head.title = '拖动移动这张卡片；双击复位到左下角';
    }
  }

  function onStageKey(e) {
    var el = stageDrag.el;
    if (!el) return;
    var step = e.shiftKey ? 32 : 8;
    var b = el.getBoundingClientRect();
    var x = b.left, y = b.top;
    if (e.key === 'ArrowLeft') x -= step;
    else if (e.key === 'ArrowRight') x += step;
    else if (e.key === 'ArrowUp') y -= step;
    else if (e.key === 'ArrowDown') y += step;
    else if (e.key === 'Escape' || e.key === 'Home') {
      // 复位 = 丢掉记忆、回到默认停靠点（与双击复位同语义）。
      try { localStorage.removeItem(STAGE_POS_KEY); } catch (err) { /* ignore */ }
      el.style.left = '';
      el.style.right = '';
      el.style.top = '';
      el.style.bottom = '';
      dockStage();
      e.preventDefault();
      return;
    } else return;
    e.preventDefault();
    writeStagePos(applyStagePos(el, x, y));
  }

  function onStageDblClick() {
    // 双击复位：拖歪之后最直接的「我不要了」。丢掉记忆、回到默认停靠点。
    var el = stageDrag.el;
    if (!el) return;
    el.style.left = '';
    el.style.right = '';
    el.style.top = '';
    el.style.bottom = '';
    try { localStorage.removeItem(STAGE_POS_KEY); } catch (e) { /* ignore */ }
    dockStage();
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
    buildStageDrag();
    buildStageMini();

    // 导航点击在 nav 上委托：条目是按钮，冒泡即可，不必逐条挂。
    if (refs.nav) refs.nav.addEventListener('click', onNavClick);
    if (sheet.nav) sheet.nav.addEventListener('click', onNavClick);

    keyHandler = onSheetKeydown;
    document.addEventListener('keydown', onWallKeydown);
    if (stageDrag.head) {
      stageDrag.head.addEventListener('keydown', onStageKey);
      stageDrag.head.addEventListener('dblclick', onStageDblClick);
    }
    wallEntryHandler = function () { if (mounted && !wall.open) openWall(); };
    document.addEventListener('playback:entry-wall', wallEntryHandler);
    // 设置里关掉分区时 app.js 广播 nav:changed，胶囊菜单同步摘入口。
    navChangedHandler = function () { if (mounted) reflow(); };
    document.addEventListener('nav:changed', navChangedHandler);
    // 换歌跟随 + 播放键实时化：换曲走 app.js 的 playback:track，暂停/续播不换曲、
    // 只有 Stage 的跳变沿广播（stage.js 在 setSnapshot 里发，不受帧率门控影响）。
    wallPlayHandler = onWallPlayback;
    document.addEventListener('playback:track', wallPlayHandler);
    document.addEventListener('stage:playing-changed', wallPlayHandler);
    document.addEventListener('keydown', keyHandler);
    // 换曲把收起的迷你卡放回来（皮肤自持的唯一状态入口）。
    mini.trackHandler = onMiniTrack;
    document.addEventListener('playback:track', mini.trackHandler);

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
    if (wallEntryHandler) {
      document.removeEventListener('playback:entry-wall', wallEntryHandler);
      wallEntryHandler = null;
    }
    if (navChangedHandler) {
      document.removeEventListener('nav:changed', navChangedHandler);
      navChangedHandler = null;
    }
    if (wallPlayHandler) {
      document.removeEventListener('playback:track', wallPlayHandler);
      document.removeEventListener('stage:playing-changed', wallPlayHandler);
      wallPlayHandler = null;
    }
    if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
    window.removeEventListener('resize', onWallResize);
    if (stageDragHandlers) {
      document.removeEventListener('pointermove', stageDragHandlers.move);
      document.removeEventListener('pointerup', stageDragHandlers.up);
      document.removeEventListener('pointercancel', stageDragHandlers.up);
      stageDragHandlers = null;
    }
    if (stageDrag.head) {
      stageDrag.head.removeEventListener('keydown', onStageKey);
      stageDrag.head.removeEventListener('dblclick', onStageDblClick);
    }
    window.removeEventListener('resize', onStageResize);
    if (stageDrag.ro) { stageDrag.ro.disconnect(); stageDrag.ro = null; }
    if (mini.trackHandler) {
      document.removeEventListener('playback:track', mini.trackHandler);
      mini.trackHandler = null;
    }
    if (mini.timer) { clearInterval(mini.timer); mini.timer = null; }
    mini.lyric = null; mini.a = null; mini.b = null; mini.lyricText = null;
    if (stageDrag.el) {
      // pointerdown 挂在整张卡上，而 .stage 是业务节点（切皮肤不重建）——
      // 不摘的话切走再切回来会叠加第二份拖动逻辑。
      stageDrag.el.removeEventListener('pointerdown', onStageDragDown);
      stageDrag.el.classList.remove('qf-dragging', 'qf-mini-closed');
      // 内联定位必须清掉：applyStagePos 写的 left/top 在清风是 fixed 定位用的，
      // 带到别的皮肤上（.stage 在那边是栅格里的普通子项）就是一份脏样式。
      // 位置本身记在 localStorage，下次挂载会读回来，这里清的只是现场。
      stageDrag.el.style.left = '';
      stageDrag.el.style.top = '';
      stageDrag.el.style.right = '';
      stageDrag.el.style.bottom = '';
    }
    document.body.classList.remove('qf-stage-dragging');
    stageDrag.el = null;
    stageDrag.head = null;
    stageDrag.active = false;
    if (wall.raf) { cancelAnimationFrame(wall.raf); wall.raf = 0; }
    clearTimeout(sheet.closeTimer);
    sheet.closeTimer = 0;
    clearTimeout(wall.closeTimer);
    wall.closeTimer = 0;
    clearTimeout(wall.reflowTimer);
    wall.reflowTimer = 0;
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
    if (wall.nodeByKey) wall.nodeByKey.clear();
    wall.geo = null;
    wall.focusedKey = '';
    wall.reflow = null;
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

  // -------------------------------------------------------------------------
  // 设置页「海报墙」组：共享页面，无论当前皮肤是否清风都接线 —— 勾选直接写
  // 皮肤自己的 localStorage，mount 时读回。用 on* 赋值挂接，脚本重复执行也不叠加。
  // -------------------------------------------------------------------------

  function wireWallSettings() {
    var follow = document.getElementById('set-wall-follow');
    if (!follow) return;
    follow.checked = readFlag(WALL_FOLLOW_KEY, true);
    follow.onchange = function () { writeFlag(WALL_FOLLOW_KEY, follow.checked); };

    var vignette = document.getElementById('set-wall-vignette');
    vignette.checked = readFlag(WALL_VIGNETTE_KEY, true);
    vignette.onchange = function () {
      writeFlag(WALL_VIGNETTE_KEY, vignette.checked);
      wall.vignette = vignette.checked;
      applyWallLook();
    };

    var tint = document.getElementById('set-wall-tint');
    var color = document.getElementById('set-wall-tint-color');
    var intensity = document.getElementById('set-wall-tint-intensity');
    var intensityVal = document.getElementById('set-wall-tint-intensity-val');
    tint.checked = readFlag(WALL_TINT_KEY, false);
    color.value = readStr(WALL_TINT_COLOR_KEY, WALL_TINT_DEFAULT_COLOR);
    var v = Number(readStr(WALL_TINT_INTENSITY_KEY, String(WALL_TINT_DEFAULT_INTENSITY)));
    intensity.value = String(Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : WALL_TINT_DEFAULT_INTENSITY);
    intensityVal.textContent = intensity.value + '%';
    tint.onchange = function () {
      writeFlag(WALL_TINT_KEY, tint.checked);
      wall.tint = tint.checked;
      applyWallLook();
    };
    color.onchange = function () {
      writeStr(WALL_TINT_COLOR_KEY, color.value);
      wall.tintColor = color.value;
      applyWallLook();
    };
    intensity.oninput = function () {
      intensityVal.textContent = intensity.value + '%';
    };
    intensity.onchange = function () {
      writeStr(WALL_TINT_INTENSITY_KEY, intensity.value);
      wall.tintIntensity = Number(intensity.value);
      applyWallLook();
    };
  }

  wireWallSettings();

  // 暴露仅用于排障/契约脚本：返回当前挂载状态。
  window.__qfSkin = {
    isMounted: function () { return mounted; },
    isWallOpen: function () { return wall.open; },
    posterCount: function () { return wall.posters.length; },
    reflow: function () { if (mounted) reflow(); },
    // 墙当前这一列的只读快照。浏览器实测靠它断言「取到了哪个来源、
    // 有几项、在不在第二层」—— 这些从 DOM 上看不出来（不同来源的卡片
    // 结构完全一样），不看这个就只剩「墙打开了」这种没信息量的断言。
    wallInfo: function () {
      return {
        sourceKey: wall.sourceKey,
        label: wall.sourceLabel,
        count: wall.tiles.length,
        drill: wall.drill ? { name: wall.drill.name, playlistId: wall.drill.playlistId } : null,
        emptyHint: wall.emptyHint,
      };
    },
  };
})();
