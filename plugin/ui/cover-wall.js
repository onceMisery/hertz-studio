// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// Independent cover wall. Owns only its own DOM, camera and preferences; the
// shared Skins.request bridge owns sources and playback. Geometry and reflow
// templates are retained from the Qingfeng cover wall.
// Load after skins/skin-shared.js and skins/skins.js, before skin.hertz.js.
(function () {
  'use strict';

  var mounted = false;
  var built = window.SkinShared.createBuilt();
  var applyImg = window.SkinShared.applyImg;
  var refs = {};
  var observer = null;
  var wallResizeObserver = null;
  var sourceTimer = 0;
  var progressTimer = 0;
  var sourceSignature = '';
  var lastFocus = null;
  var settingsCleanup = [];
  var pointerReset = null;
  var suppressClickUntil = 0;
  var SOURCE_ITEMS = [
    ['library', '曲库'], ['online', '在线'], ['playlists', '歌单'],
    ['favorites', '收藏'], ['queue', '队列'], ['daily', '每日推荐'],
  ];

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
    trackKnown: false,
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
    // 播放队列 tab 仍然是队列（第 6 个来源）。取源走 Skins.request('source-request')，
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

  function $(sel, root) { return (root || document).querySelector(sel); }
  function byId(id) { return document.getElementById(id); }

  function make(tag, cls, parent) { return built.make(tag, cls, parent); }

  function applyBg(node, url) {
    if (window.HertzCovers) { window.HertzCovers.applyBg(node, url); return; }
    node.style.backgroundImage = url ? 'url("' + url + '")' : '';
  }

  function icon(name) {
    var iconReference = `#i-${name}`;
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="${iconReference}"/></svg>`;
  }

  // -------------------------------------------------------------------------
  // 与 app.js 通信：只读队列快照 / 请求播放
  // -------------------------------------------------------------------------

  function emit(action, extra) {
    return window.Skins.request(action, extra);
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

  // Camera coordinates belong to the wall's content box. The native host can
  // reserve space above it, so client coordinates enter through this helper.
  function wallSize() {
    return { width: wall.root.clientWidth, height: wall.root.clientHeight };
  }

  function wallPoint(clientX, clientY) {
    var rect = wall.root.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  /// 视口中心的世界坐标。
  function viewportCenterWorld() {
    return {
      x: (wallSize().width / 2 - wall.cam.x) / wall.cam.s,
      y: (viewportCenterY() - wall.cam.y) / wall.cam.s,
    };
  }

  /// 视口的精确世界坐标范围（无外扩）。入/退场波的延时按它算 ——
  /// 波是「从视口左上角涌进来」的，外扩的 OVERSCAN 不该参与延时。
  function viewBounds() {
    var size = wallSize();
    var s = wall.cam.s;
    return {
      left: -wall.cam.x / s,
      top: -wall.cam.y / s,
      right: (size.width - wall.cam.x) / s,
      bottom: (size.height - wall.cam.y) / s,
    };
  }

  /// 墙的裁剪范围（世界坐标）。OVERSCAN 外扩保证平移时新格子已就位。
  function wallBounds() {
    var size = wallSize();
    var s = wall.cam.s;
    return {
      left: (-wall.cam.x - OVERSCAN) / s,
      top: (-wall.cam.y - OVERSCAN) / s,
      right: (size.width - wall.cam.x + OVERSCAN) / s,
      bottom: (size.height - wall.cam.y + OVERSCAN) / s,
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
  /// 带 wall token）任一命中即压。CSS 门控在 cover-wall.css；JS 这边只差
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
      if (refs.wallTagBack) {
        var backLabel = wall.drill ? '返回歌单列表' : '返回浏览';
        refs.wallTagBack.title = backLabel;
        refs.wallTagBack.setAttribute('aria-label', backLabel);
      }
      // 没有来源名就别占位（理论上不会 —— 六个视图都有 label）。
      refs.wallTag.hidden = false;
      if (wall.drill) refs.wallTag.classList.add('is-drill');
      else refs.wallTag.classList.remove('is-drill');
    }
    // 「清空队列」只对播放队列那一列成立：其余视图的项是视图自己的内容
    // （曲库/在线/收藏），清播放队列不会让墙变空，只会让「正在播放」那张卡
    // 消失 —— 摆在那儿就是给了个点了没用的按钮。
    if (refs.wallClear) refs.wallClear.hidden = wall.sourceKey !== 'queue' || !!wall.drill;
    syncSourceButtons();
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
    root.id = 'hertz-cover-wall';
    root.hidden = true;
    root.tabIndex = -1;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', '封面墙');

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
    var header = make('header', 'qf-wall-header', root);
    var tag = make('div', 'qf-lattice-tag', header);
    var tagLabel = make('strong', '', tag);
    var tagCount = make('span', '', tag);
    var tagBack = make('button', 'qf-lattice-back', tag);
    tagBack.type = 'button';
    tagBack.title = '返回浏览';
    tagBack.setAttribute('aria-label', '返回浏览');
    tagBack.innerHTML = icon('arrow-left');
    tagBack.addEventListener('click', function () {
      if (wall.drill) leaveDrill();
      else closeWall();
    });
    tag.insertBefore(tagBack, tagLabel);
    var sources = make('nav', 'qf-wall-sources', header);
    sources.setAttribute('aria-label', '封面墙来源');
    SOURCE_ITEMS.forEach(function (entry) {
      var button = make('button', 'qf-wall-source', sources);
      button.type = 'button';
      button.dataset.source = entry[0];
      button.textContent = entry[1];
      button.addEventListener('click', function () { selectSource(entry[0]); });
    });
    refs.wallHeader = header;
    refs.wallSources = sources;

    // 左下角：当前播放的小封面与悬停播放按钮。
    // 按钮**常驻在 DOM 里**（不是 hover 才插入）：每次 hover 重建节点会
    // 让指针在按钮出现的瞬间落在新节点上，click 丢失，而且每次都要重挂
    // 监听。显隐只切 opacity / pointer-events。
    var peek = make('div', 'qf-queue-peek', root);
    var peekArt = make('div', 'qf-queue-peek-art', peek);
    peekArt.innerHTML = icon('disc');
    var peekPlay = make('button', 'qf-queue-peek-play', peekArt);
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

    var peekPlayer = make('button', 'qf-queue-peek-stage qf-queue-peek-player', peek);
    peekPlayer.type = 'button';
    peekPlayer.title = '展开播放页';
    peekPlayer.setAttribute('aria-label', peekPlayer.title);
    peekPlayer.innerHTML = icon('headphones');
    peekPlayer.addEventListener('click', function (e) {
      e.stopPropagation();
      emit('open-player');
    });

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
    refs.wallTools = tools;
    [['minus', '缩小', 1 / 1.2], ['plus', '放大', 1.2]].forEach(function (entry) {
      var button = make('button', 'qf-tools-btn qf-wall-zoom', tools);
      button.type = 'button';
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12' + (entry[0] === 'plus' ? 'M12 6v12' : '') + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
      button.title = entry[1];
      button.setAttribute('aria-label', entry[1]);
      button.addEventListener('click', function () {
        zoomAt(wall.cam.s * entry[2], wallSize().width / 2, viewportCenterY());
      });
    });
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
    back.setAttribute('aria-label', '退出封面墙');
    back.innerHTML = icon('close');
    back.addEventListener('click', closeWall);

    // 工具面板：键盘说明 + 清空队列。
    var panel = make('div', 'qf-tools-panel', tools);
    panel.hidden = true;
    var help = make('div', 'qf-set-subitem', panel);
    help.textContent = '拖动平移 · 双指缩放 · 方向键选择 · Enter 展开 · Tab 切换控件 · Esc 返回';
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
    panelBtn.setAttribute('aria-label', '封面墙说明');
    panelBtn.setAttribute('aria-expanded', 'false');
    panelBtn.innerHTML = icon('more');
    panelBtn.addEventListener('click', function () {
      var show = panel.hidden;
      panel.hidden = !show;
      panelBtn.setAttribute('aria-expanded', String(show));
    });
    refs.wallClear = clear;
    refs.wallPanel = panel;

    // Capture only after the drag threshold, so a tap still activates its card.
    // Keep both touch pointers for pinch zoom and suppress the synthetic click
    // after a gesture (otherwise dragging a card can expand it on release).
    var pointers = new Map();
    var drag = null;
    var pinch = null;
    function beginGesture() {
      var points = Array.from(pointers.values());
      if (points.length >= 2) {
        var x = (points[0].x + points[1].x) / 2;
        var y = (points[0].y + points[1].y) / 2;
        pinch = { distance: Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y),
          scale: wall.cam.s, wx: (x - wall.cam.x) / wall.cam.s, wy: (y - wall.cam.y) / wall.cam.s };
        drag = null;
      } else if (points.length) {
        drag = { x: points[0].x, y: points[0].y, cx: wall.cam.x, cy: wall.cam.y, moved: false };
        pinch = null;
      } else { drag = null; pinch = null; }
    }
    pointerReset = function () {
      pointers.forEach(function (_, id) {
        try { if (field.hasPointerCapture(id)) field.releasePointerCapture(id); } catch (e) { /* Already released. */ }
      });
      pointers.clear(); drag = null; pinch = null;
    };
    field.addEventListener('pointerdown', function (e) {
      if (e.button > 0 || e.target.closest('.qf-poster-controls')) return;
      stopCamera();
      pointers.set(e.pointerId, wallPoint(e.clientX, e.clientY));
      beginGesture();
    });
    field.addEventListener('pointermove', function (e) {
      if (!pointers.has(e.pointerId)) return;
      var point = wallPoint(e.clientX, e.clientY);
      pointers.set(e.pointerId, point);
      if (pinch) {
        var points = Array.from(pointers.values());
        var x = (points[0].x + points[1].x) / 2;
        var y = (points[0].y + points[1].y) / 2;
        var distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
        wall.cam.s = clampScale(pinch.scale * distance / Math.max(1, pinch.distance));
        wall.cam.x = x - pinch.wx * wall.cam.s;
        wall.cam.y = y - pinch.wy * wall.cam.s;
      } else if (drag) {
        var dx = point.x - drag.x, dy = point.y - drag.y;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        drag.moved = true;
        wall.cam.x = drag.cx + dx;
        wall.cam.y = drag.cy + dy;
      } else return;
      try { field.setPointerCapture(e.pointerId); } catch (error) { /* Pointer already ended. */ }
      suppressClickUntil = performance.now() + 400;
      root.classList.remove('is-reflow');
      applyCamera(); renderWall();
    });
    function endDrag(e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (pinch || (drag && drag.moved)) suppressClickUntil = performance.now() + 400;
      try { if (field.hasPointerCapture(e.pointerId)) field.releasePointerCapture(e.pointerId); } catch (error) { /* Already released. */ }
      beginGesture();
    }
    field.addEventListener('pointerup', endDrag);
    field.addEventListener('pointercancel', endDrag);
    field.addEventListener('lostpointercapture', function (e) {
      // Touch starts with implicit capture on the poster. Moving capture to
      // the field releases that child first; only losing the field ends drag.
      if (e.target === field) endDrag(e);
    });
    field.addEventListener('pointerleave', function (e) {
      if (!field.hasPointerCapture(e.pointerId)) endDrag(e);
    });
    field.addEventListener('click', function (e) {
      if (performance.now() < suppressClickUntil) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    field.addEventListener('wheel', function (e) {
      e.preventDefault(); stopCamera();
      root.classList.remove('is-reflow');
      var unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? wallSize().height : 1);
      if (e.ctrlKey || e.metaKey) {
        var point = wallPoint(e.clientX, e.clientY);
        zoomAt(wall.cam.s * Math.exp(-e.deltaY * unit * 0.004), point.x, point.y);
      } else {
        wall.cam.x -= e.deltaX * unit;
        wall.cam.y -= e.deltaY * unit;
        applyCamera(); renderWall();
      }
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

    wallResizeObserver = new ResizeObserver(onWallResize);
    wallResizeObserver.observe(root);
  }

  function onWallResize() {
    if (!wall.open || !wall.root.clientWidth || !wall.root.clientHeight) return;
    stopCamera();
    if (pointerReset) pointerReset();
    wall.cam.s = wallScale();
    applyCamera();
    renderWall();
    var el = wall.nodeByKey.get(wall.expandedKey || wall.focusedKey);
    if (el) panTo(el);
  }

  function wallScale() {
    var w = wallSize().width;
    var space = wallViewport();
    return Math.max(0.3, Math.min(w < 1100 ? 0.64 : 0.76,
      (w - 32) / (6 * PITCH), (space.bottom - space.top) / (6 * PITCH)));
  }

  function wallViewport() {
    var h = wallSize().height;
    var origin = wall.root.getBoundingClientRect().top;
    var top = refs.wallHeader ? refs.wallHeader.getBoundingClientRect().bottom - origin + 20 : 130;
    var bottom = h - 100;
    [refs.wallPeek, refs.wallTools].forEach(function (node) {
      if (node && !node.hidden) bottom = Math.min(bottom, node.getBoundingClientRect().top - origin - 20);
    });
    return { top: top, bottom: Math.max(top + 160, bottom) };
  }

  function viewportCenterY() {
    var space = wallViewport();
    return (space.top + space.bottom) / 2;
  }

  function clampScale(scale) { return Math.max(0.3, Math.min(1.4, scale)); }

  function stopCamera() {
    if (wall.raf) { cancelAnimationFrame(wall.raf); wall.raf = 0; }
  }

  function zoomAt(scale, x, y) {
    if (!wall.open) return;
    stopCamera();
    var wx = (x - wall.cam.x) / wall.cam.s;
    var wy = (y - wall.cam.y) / wall.cam.s;
    wall.cam.s = clampScale(scale);
    wall.cam.x = x - wx * wall.cam.s;
    wall.cam.y = y - wy * wall.cam.s;
    applyCamera();
    renderWall();
  }

  function applyCamera() {
    if (!wall.world) return;
    wall.world.style.transform =
      'translate3d(' + wall.cam.x + 'px,' + wall.cam.y + 'px,0) scale(' + wall.cam.s + ')';
    wall.root.style.setProperty('--qf-scale', String(wall.cam.s));
  }

  function openWall() {
    if (!mounted) mount();
    if (!mounted || !wall.root) return;
    if (wall.open) return;
    lastFocus = document.activeElement;
    // 上一次退场波还没播完就重开：掐掉清理定时器、摘退场标记，
    // 这面墙从入场波重新开始，而不是接着残局。
    if (wall.closeTimer) { clearTimeout(wall.closeTimer); wall.closeTimer = 0; }
    if (wall.root) wall.root.classList.remove('is-closing');
    wall.open = true;
    wall.root.hidden = false;
    wall.root.inert = false;
    wall.drill = null;
    wall.drillBusy = false;
    wall.drillError = '';
    wall.reflow = null;
    wall.entranceUntil = performance.now() + ENTRANCE_WINDOW;
    var src = requestSource();
    if (!src.key) {
      var fallback = railItem('library') || railItem('queue');
      if (fallback) fallback.click();
      src = requestSource();
    }
    applySource(src);
    sourceSignature = sourceKey(src);
    wall.focused = -1;
    wall.expanded = -1;
    wall.expandedKey = '';
    wall.cam.s = wallScale();
    wall.cam.x = 34;
    wall.cam.y = 80;
    if (wall.root) wall.root.hidden = false;
    document.body.classList.add('qf-lattice-open');
    refs.wallTagBack.focus({ preventScroll: true });
    applyCamera();
    renderWall();
    // 自动聚焦到正在播放那张，墙一开就有主体（就近挑实例，不长途飞行）。
    // 歌单那一份没有「正在播放」的概念（歌单不是曲），聚焦第 0 项即可。
    var idx = wall.tiles.findIndex(posterIsCurrent);
    if (idx >= 0) focusQueueIndex(idx, true, true);
    // 没有「正在播放」那张（歌单墙永远没有）时落到第 0 项，并**保证它在
    // 视口内** —— 密排下它的格位可能整个在视口外，那样用户看到一片空白，
    // 以为墙没加载出来。
    else if (wall.tiles.length) focusAndReveal(0, true);
    progressTimer = window.setInterval(updateProgress, 250);
    announce(true);
  }

  /// 把一份来源快照铺到墙上。第一层与第二层共用这一条路径 ——
  /// 区别只是快照的 kind 与 label 不同。
  function applySource(src) {
    stopCamera();
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
    updatePeek();
  }

  /// 展开一个歌单：进第二层看它里面的歌。
  /// 不直接播 —— 直接播用户根本不知道自己听的是哪个歌单。
  function enterDrill(item) {
    stopCamera();
    var moveFocus = wall.world.contains(document.activeElement);
    if (moveFocus) wall.root.focus({ preventScroll: true });
    var out = emit('playlist-drill', { source: item.source, playlistId: item.playlistId });
    var res = out && out.result;
    var drill = { source: item.source, playlistId: item.playlistId, name: item.title };
    wall.drill = drill;
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
      if (!mounted || !wall.open || wall.drill !== drill) return;
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
      clearPosters();
      renderWall();
      if (wall.tiles.length) focusQueueIndex(0, true, moveFocus && document.activeElement === wall.root);
    }).catch(function () {
      if (!mounted || !wall.open || wall.drill !== drill) return;
      wall.drillBusy = false;
      wall.drillError = '歌单加载失败';
      paintEmptyState();
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
    if (wall.tiles.length) focusAndReveal(0);
    refs.wallTagBack.focus({ preventScroll: true });
  }

  function closeWall() {
    if (!wall.open) return;
    wall.open = false;
    stopCamera();
    if (pointerReset) pointerReset();
    clearTimeout(sourceTimer); sourceTimer = 0;
    clearInterval(progressTimer); progressTimer = 0;
    clearTimeout(wall.reflowTimer); wall.reflowTimer = 0;
    wall.root.inert = true;
    // 第二层直接退到第一层而不是留在歌单里 —— 关掉再开应该还是原来的那个 tab
    // 的内容，进去-退出-再开要停在歌单里会让人以为随机。
    wall.drill = null;
    wall.drillBusy = false;
    wall.drillError = '';
    document.body.classList.remove('qf-lattice-open');
    if (lastFocus && lastFocus.isConnected && typeof lastFocus.focus === 'function') {
      lastFocus.focus({ preventScroll: true });
    }
    lastFocus = null;
    announce(false);
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
    if (wall.open && !wall.root.inert && wall.world.contains(document.activeElement)) {
      wall.root.focus({ preventScroll: true });
    }
    wall.world.innerHTML = '';
    wall.posters = [];
    if (wall.nodeByKey) wall.nodeByKey.clear();
    wall.reflow = null;
    wall.focused = -1;
    wall.focusedKey = '';
    wall.expanded = -1;
    wall.expandedKey = '';
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
      updatePeek();
      return;
    }
    paintEmptyState();

    var active = document.activeElement;
    var contentHadFocus = wall.world.contains(active);
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
    // The virtual wall has one Tab stop. If panning recycles that instance,
    // choose a nearby replacement instead of leaving every poster at -1.
    if (!wall.focusedKey && next.length) {
      var center = viewportCenterWorld();
      var nearest = 0;
      var distance = Infinity;
      next.forEach(function (node, index) {
        var rect = posterWorldRect(node);
        var dx = rect.x + rect.w / 2 - center.x;
        var dy = rect.y + rect.h / 2 - center.y;
        var score = dx * dx + dy * dy;
        if (score < distance) { nearest = index; distance = score; }
      });
      wall.focused = nearest;
      wall.focusedKey = next[nearest].dataset.qfKey;
    }
    next.forEach(function (node, index) {
      node.tabIndex = index === wall.focused ? 0 : -1;
      node.classList.toggle('is-focused', index === wall.focused);
    });
    if (contentHadFocus && !active.isConnected && !wall.root.inert && next[wall.focused]) {
      next[wall.focused].focus({ preventScroll: true });
    }
    updatePeek();
  }

  function createPoster(entry) {
    var tile = tileForKey(entry.key);
    var el = document.createElement('article');
    el.className = 'qf-poster';
    el.dataset.qfKey = entry.key;
    if (posterIsCurrent(tile)) el.classList.add('is-current');
    el.tabIndex = -1;
    el.setAttribute('aria-label', (tile ? tile.title : '') + (tile && tile.isPlaylist ? ' · 打开歌单' : ' · 展开播放控件'));
    el.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight ArrowUp ArrowDown Enter Space');
    el.addEventListener('focus', function () {
      focusPoster(wall.posters.indexOf(el), false);
      var rect = el.getBoundingClientRect();
      var space = wallViewport();
      var point = wallPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (point.x < 0 || point.x > wallSize().width || point.y < space.top || point.y > space.bottom) panTo(el);
    });
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
      } else focusPoster(wall.posters.indexOf(el), true, true);
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

  function focusPoster(index, expand, moveFocus) {
    if (index < 0 || index >= wall.posters.length) return;
    var active = document.activeElement;
    var contentHadFocus = wall.world.contains(active);
    var poster = wall.posters[index];
    wall.focused = index;
    wall.focusedKey = poster.dataset.qfKey || '';
    wall.posters.forEach(function (n, i) {
      n.classList.toggle('is-focused', i === index);
      n.tabIndex = i === index ? 0 : -1;
    });
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
    // Explicit navigation moves DOM focus. Playback/source updates keep native
    // controls focused, unless rebuilding their poster removed the control.
    if (moveFocus || (contentHadFocus && (active.matches('.qf-poster') || !active.isConnected))) {
      poster.focus({ preventScroll: true });
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
  function focusQueueIndex(qi, expand, moveFocus) {
    if (qi < 0 || !wall.open) return;
    var inst = locateNearestInstance(qi, viewportCenterWorld());
    if (!inst) return;
    var node = wall.nodeByKey.get(inst.key);
    if (!node) {
      // 最近实例不在挂载集（OVERSCAN 之外）：把相机瞬间对过去再渲染。
      // 开墙首聚焦走瞬时对位（folia 的 instant），不做飞行。
      wall.cam.x = wallSize().width / 2 - (inst.rect.x + inst.rect.w / 2) * wall.cam.s;
      wall.cam.y = viewportCenterY() - (inst.rect.y + inst.rect.h / 2) * wall.cam.s;
      applyCamera();
      renderWall();
      node = wall.nodeByKey.get(inst.key);
    }
    if (node) focusPoster(wall.posters.indexOf(node), expand, moveFocus);
  }

  function focusAndReveal(index, moveFocus) {
    focusQueueIndex(index, false, moveFocus);
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
      if (!silent && ctl && ctl.contains(document.activeElement)) el.focus({ preventScroll: true });
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
    var vw = wallSize().width;
    var s = wall.cam.s;
    var targetX = vw / 2 - (wx + ww / 2) * s;
    var targetY = viewportCenterY() - (wy + wh / 2) * s;
    var fromX = wall.cam.x;
    var fromY = wall.cam.y;
    var t0 = 0;
    var DUR = 420;
    if (wall.raf) cancelAnimationFrame(wall.raf);
    if (wallMotionReduced()) {
      wall.cam.x = targetX; wall.cam.y = targetY; wall.raf = 0;
      applyCamera(); renderWall();
      return;
    }
    // 名字带 Pan 是为了跟模块级的 step(delta)（上/下一首）区分开：
    // 同名局部函数在两处含义完全不同，读代码时极易以为它们是一件事。
    function stepPan(ts) {
      if (!mounted || !wall.open) { wall.raf = 0; return; }
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
    return wall.trackKnown ? wall.trackId === String(tile.id) : !!tile.current;
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
      wall.trackKnown = true;
      followCurrent();
    }
    if (!wall.open) return;
    wall.posters.forEach(function (node) { node.classList.toggle('is-current', posterIsCurrent(posterTile(node))); });
    paintPosterPlay(wall.expandedKey && wall.nodeByKey ? wall.nodeByKey.get(wall.expandedKey) : null);
    updatePeek();
    updateProgress();
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
      var posterPreviousButton = document.createElement('button');
      posterPreviousButton.type = 'button';
      posterPreviousButton.title = '上一首';
      posterPreviousButton.setAttribute('aria-label', '上一首');
      posterPreviousButton.innerHTML = icon('prev');
      posterPreviousButton.addEventListener('click', function (e) { e.stopPropagation(); step(-1); });

      var posterPlayButton = document.createElement('button');
      posterPlayButton.type = 'button';
      posterPlayButton.className = 'qf-chrome-play';
      posterPlayButton.addEventListener('click', function (e) {
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

      var posterNextButton = document.createElement('button');
      posterNextButton.type = 'button';
      posterNextButton.title = '下一首';
      posterNextButton.setAttribute('aria-label', '下一首');
      posterNextButton.innerHTML = icon('next');
      posterNextButton.addEventListener('click', function (e) { e.stopPropagation(); step(1); });

      var time = document.createElement('span');
      time.className = 'qf-chrome-time';
      time.textContent = tile && tile.duration ? fmtDur(tile.duration) : '';

      row.appendChild(posterPreviousButton);
      row.appendChild(posterPlayButton);
      row.appendChild(posterNextButton);
      row.appendChild(time);
    }
    chrome.appendChild(row);

    var progress = document.createElement('div');
    progress.className = 'qf-progress';
    var fill = document.createElement('div');
    fill.className = 'qf-progress-fill';
    fill.style.width = ((tile && tile.progress ? tile.progress : 0) * 100) + '%';
    progress.appendChild(fill);
    var range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '1000';
    range.step = '1';
    range.value = String(Math.round((tile && tile.progress ? tile.progress : 0) * 1000));
    range.setAttribute('aria-label', '播放进度');
    range.addEventListener('input', function () {
      fill.style.width = (Number(range.value) / 10) + '%';
    });
    range.addEventListener('change', function () {
      emit('seek', { ratio: Number(range.value) / 1000 });
    });
    progress.appendChild(range);
    // 没在放的那首不给进度条 —— 第二层（刚点开的歌单）与非当前项
    // 拖了也不知道拖的是谁，拖了还会误以为在 seek。
    progress.hidden = !posterIsCurrent(tile);

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

  // 当前播放优先：浏览别的来源或海报时，左下角仍是可靠的播放入口。
  // 没有已加载歌曲时才显示选中的海报；文案和点击共用这一份选择结果。
  function peekTile() {
    var current = window.Stage && window.Stage.presentation ? window.Stage.presentation() : null;
    if (current && current.track && current.mediaTrackId && String(current.track.id) === String(current.mediaTrackId)) {
      return { id: current.mediaTrackId, title: current.track.title || '未知曲目',
        artist: current.track.artist || '未知艺术家', cover: current.cover,
        current: true, playing: current.playing };
    }
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
      refs.wallPeek.title = t.isPlaylist ? '歌单 · 点开看里面的歌' : (posterIsCurrent(t) ? '正在播放' : (wall.sourceLabel || '当前'));
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
    applyBg(refs.wallPeekArt, t.cover || null);
    refs.wallPeekArt.classList.toggle('has-cover', !!t.cover);
  }

  function onPresentationChange() {
    // Stage emits its track change while updating metadata. Read once that
    // synchronous update has completed, including a late-resolved cover.
    queueMicrotask(function () { if (mounted && wall.open) updatePeek(); });
  }

  function onWallKeydown(e) {
    if (!wall.open || e.defaultPrevented || wall.root.inert ||
        (window.NowPlaying && window.NowPlaying.isOpen())) return;
    var target = e.target;
    if (target && !wall.root.contains(target) && target !== document.body) return;
    if (e.key === 'Tab') {
      var buttons = Array.from(wall.root.querySelectorAll('button,input,select,[tabindex="0"]'))
        .filter(function (node) { return !node.disabled && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden'; });
      var first = buttons[0], last = buttons[buttons.length - 1];
      if (!first) { e.preventDefault(); wall.root.focus(); return; }
      if (e.shiftKey && (target === first || target === wall.root)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (target === last || target === wall.root)) { e.preventDefault(); first.focus(); }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (refs.wallPanel && !refs.wallPanel.hidden) {
        refs.wallPanel.hidden = true;
        refs.wallPanelBtn.setAttribute('aria-expanded', 'false');
        refs.wallPanelBtn.focus();
      } else if (wall.drill) leaveDrill();
      else closeWall();
      return;
    }
    // Native buttons and range inputs keep their keyboard behavior. In
    // particular, Space must not activate both a source button and a poster.
    if (target && target.closest('button,input,select,textarea,[contenteditable="true"]')) return;
    if (e.key === 'Backspace' && wall.drill) {
      e.preventDefault(); e.stopPropagation(); leaveDrill(); return;
    }
    if (/^Arrow(Right|Left|Up|Down)$/.test(e.key)) {
      e.preventDefault(); e.stopPropagation();
      var next = adjacentPoster(e.key);
      focusPoster(next, false, true);
      if (wall.posters[next]) panTo(wall.posters[next]);
    } else if (e.key === 'Enter' || e.key === ' ') {
      var at = wall.focused < 0 ? 0 : wall.focused;
      var t = posterTile(wall.posters[at]);
      e.preventDefault(); e.stopPropagation();
      if (t && t.isPlaylist) enterDrill(t);
      else focusPoster(at, true, true);
    }
  }

  function adjacentPoster(key) {
    var current = wall.posters[wall.focused];
    if (!current) return wall.posters.length ? 0 : -1;
    var rect = posterWorldRect(current);
    var horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
    var sign = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
    var best = wall.focused;
    var distance = Infinity;
    wall.posters.forEach(function (node, index) {
      if (node === current) return;
      var other = posterWorldRect(node);
      var dx = other.x + other.w / 2 - rect.x - rect.w / 2;
      var dy = other.y + other.h / 2 - rect.y - rect.h / 2;
      var forward = sign * (horizontal ? dx : dy);
      var across = horizontal ? dy : dx;
      if (forward <= 1) return;
      var score = forward * forward + across * across * 3;
      if (score < distance) { best = index; distance = score; }
    });
    return best;
  }

  function railItem(key) {
    return refs.rail && refs.rail.querySelector('.rail-item[data-view="' + key + '"]');
  }

  function syncSourceButtons() {
    if (!refs.wallSources) return;
    refs.wallSources.querySelectorAll('[data-source]').forEach(function (button) {
      var key = button.dataset.source;
      var item = railItem(key);
      button.disabled = !item || item.hidden || item.disabled;
      button.setAttribute('aria-pressed', String(key === wall.sourceKey));
      button.title = button.disabled ? button.textContent + '分区未启用' : button.textContent;
    });
  }

  function selectSource(key) {
    var item = railItem(key);
    if (!item || item.hidden || item.disabled) return;
    wall.drill = null; wall.drillBusy = false; wall.drillError = '';
    sourceSignature = '';
    item.click(); // Existing rail -> HertzShell navigation contract.
    refreshSource();
  }

  function sourceKey(source) {
    return JSON.stringify([source.key, source.label, source.emptyHint,
      (source.items || []).map(function (item) {
        return [item.id, item.source, item.playlistId, item.title, item.artist, item.cover, item.duration];
      })]);
  }

  function refreshSource() {
    sourceTimer = 0;
    if (!mounted) return;
    syncSourceButtons();
    if (!wall.open) return;
    var source = requestSource();
    if (!source.key) return;
    if (wall.drill && source.key === wall.sourceKey) return;
    var signature = sourceKey(source);
    if (signature === sourceSignature) return;
    var previous = peekTile();
    var moveFocus = wall.world.contains(document.activeElement);
    var expanded = !!wall.expandedKey;
    var changed = source.key !== wall.sourceKey;
    wall.drill = null; wall.drillBusy = false; wall.drillError = '';
    sourceSignature = signature;
    applySource(source);
    renderWall();
    if (!wall.tiles.length) return;
    var index = !changed && previous ? wall.tiles.findIndex(function (item) { return item.id === previous.id; }) : -1;
    if (index < 0) index = wall.tiles.findIndex(posterIsCurrent);
    if (index < 0) index = 0;
    if (expanded && !changed) focusQueueIndex(index, true, moveFocus);
    else focusAndReveal(index, moveFocus);
  }

  function scheduleSourceRefresh() {
    if (!mounted || sourceTimer) return;
    sourceTimer = window.setTimeout(refreshSource, 80);
  }

  function updateProgress() {
    if (!wall.open || !wall.expandedKey || !wall.nodeByKey) return;
    var poster = wall.nodeByKey.get(wall.expandedKey);
    var tile = poster && posterTile(poster);
    var progress = poster && $('.qf-progress', poster);
    if (!progress || !tile) return;
    progress.hidden = !posterIsCurrent(tile);
    if (progress.hidden) return;
    var input = $('input', progress);
    if (input === document.activeElement) return;
    var ratio = Number(tile.progress) || 0;
    var presentation = window.Stage && window.Stage.presentation ? window.Stage.presentation() : null;
    if (presentation && presentation.duration > 0) ratio = presentation.position / presentation.duration;
    ratio = Math.max(0, Math.min(1, ratio));
    $('.qf-progress-fill', progress).style.width = (ratio * 100) + '%';
    input.value = String(Math.round(ratio * 1000));
  }

  function announce(open) {
    document.dispatchEvent(new CustomEvent('hertz:cover-wall', { detail: { open: open } }));
  }

  function onPlaybackEntry() {
    if (mounted && !wall.open && !(window.NowPlaying && window.NowPlaying.isOpen())) openWall();
  }

  function bindSetting(id, event, handler) {
    var node = byId(id);
    if (!node) return null;
    node.addEventListener(event, handler);
    settingsCleanup.push(function () { node.removeEventListener(event, handler); });
    return node;
  }

  function wireWallSettings() {
    var follow = bindSetting('set-wall-follow', 'change', function () {
      wall.follow = follow.checked;
      writeFlag(WALL_FOLLOW_KEY, wall.follow);
      if (wall.follow) followCurrent();
    });
    if (follow) follow.checked = wall.follow;
    var vignette = bindSetting('set-wall-vignette', 'change', function () {
      wall.vignette = vignette.checked; writeFlag(WALL_VIGNETTE_KEY, wall.vignette); applyWallLook();
    });
    if (vignette) vignette.checked = wall.vignette;
    var tint = bindSetting('set-wall-tint', 'change', function () {
      wall.tint = tint.checked; writeFlag(WALL_TINT_KEY, wall.tint); applyWallLook();
    });
    if (tint) tint.checked = wall.tint;
    var color = bindSetting('set-wall-tint-color', 'input', function () {
      wall.tintColor = color.value; writeStr(WALL_TINT_COLOR_KEY, wall.tintColor); applyWallLook();
    });
    if (color) color.value = wall.tintColor;
    var intensity = bindSetting('set-wall-tint-intensity', 'input', function () {
      wall.tintIntensity = Math.max(0, Math.min(100, Number(intensity.value) || 0));
      writeStr(WALL_TINT_INTENSITY_KEY, String(wall.tintIntensity));
      if (label) label.textContent = wall.tintIntensity + '%';
      applyWallLook();
    });
    var label = byId('set-wall-tint-intensity-val');
    if (intensity) intensity.value = String(wall.tintIntensity);
    if (label) label.textContent = wall.tintIntensity + '%';
  }

  function mount() {
    if (mounted) return;
    refs.rail = byId('rail');
    refs.column = byId('column');
    if (!document.body || !refs.rail || !refs.column) return;
    mounted = true;
    try {
      buildWall();
      wireWallSettings();
      document.addEventListener('keydown', onWallKeydown, true);
      document.addEventListener('playback:entry-wall', onPlaybackEntry);
      document.addEventListener('nav:changed', scheduleSourceRefresh);
      document.addEventListener('online-playlists:changed', scheduleSourceRefresh);
      document.addEventListener('playback:track', onWallPlayback);
      document.addEventListener('stage:playing-changed', onWallPlayback);
      document.addEventListener('stage:track-changed', onPresentationChange);
      document.addEventListener('stage:retint', onPresentationChange);
      observer = new MutationObserver(scheduleSourceRefresh);
      observer.observe(refs.column, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
      observer.observe(refs.rail, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
      syncSourceButtons();
    } catch (error) { unmount(); throw error; }
  }

  function unmount() {
    if (!mounted) return;
    var wasOpen = wall.open;
    mounted = false; wall.open = false;
    if (observer) { observer.disconnect(); observer = null; }
    if (wallResizeObserver) { wallResizeObserver.disconnect(); wallResizeObserver = null; }
    document.removeEventListener('keydown', onWallKeydown, true);
    document.removeEventListener('playback:entry-wall', onPlaybackEntry);
    document.removeEventListener('nav:changed', scheduleSourceRefresh);
    document.removeEventListener('online-playlists:changed', scheduleSourceRefresh);
    document.removeEventListener('playback:track', onWallPlayback);
    document.removeEventListener('stage:playing-changed', onWallPlayback);
    document.removeEventListener('stage:track-changed', onPresentationChange);
    document.removeEventListener('stage:retint', onPresentationChange);
    settingsCleanup.forEach(function (remove) { remove(); }); settingsCleanup = [];
    stopCamera();
    clearTimeout(sourceTimer); sourceTimer = 0;
    clearInterval(progressTimer); progressTimer = 0;
    clearTimeout(wall.closeTimer); wall.closeTimer = 0;
    clearTimeout(wall.reflowTimer); wall.reflowTimer = 0;
    if (pointerReset) pointerReset(); pointerReset = null;
    document.body.classList.remove('qf-lattice-open');
    built.remove();
    wall.root = null; wall.world = null; wall.field = null;
    wall.tiles = []; wall.posters = []; wall.nodeByKey = null; wall.geo = null;
    wall.focused = -1; wall.focusedKey = ''; wall.expanded = -1; wall.expandedKey = '';
    wall.reflow = null; wall.drill = null; wall.drillBusy = false; wall.drillError = '';
    wall.trackId = ''; wall.trackKnown = false; wall.sourceKey = ''; wall.sourceLabel = ''; wall.emptyHint = '';
    refs = {}; lastFocus = null; sourceSignature = ''; suppressClickUntil = 0;
    if (wasOpen) announce(false);
  }

  window.HertzCoverWall = {
    mount: mount,
    open: openWall,
    close: closeWall,
    toggle: toggleWall,
    unmount: unmount,
    isOpen: function () { return wall.open; },
  };
})();
