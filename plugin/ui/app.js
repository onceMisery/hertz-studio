// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// v2 原型：零构建原生 JS，和现有 crates/hertz-studio/web/app.js 一样没有 npm 步骤。
//
// 与旧版最大的结构差异：所有后端访问都经过一个极薄的 transport 抽象。
// 有真实服务时走 HTTP + WebSocket，没有时（例如直接双击打开本文件）退到
// 演示后端。业务逻辑只有一份，不存在"演示分支"。

'use strict';

// Token 通常由服务端注入进 HTML；链接带来的 token 用完即抹掉，避免留在历史里。
// DBX 插件形态下整段要跳过：那边 stdio 天然可信没有 token，而且 iframe 是
// opaque origin，调 history.replaceState 会直接抛 SecurityError 把脚本打断。
const TOKEN = (() => {
  if (window.hertzHost && window.hertzHost.isDbx) return '';
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get('token');
  if (fromUrl) {
    params.delete('token');
    const rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : ''));
  }
  return window.__VMUSIC_TOKEN__ || fromUrl || '';
})();

const $ = (id) => document.getElementById(id);
const PAGE = 200; // 每页曲目数

const ui = {
  conn: $('conn'),
  connDot: null,
  demoBadge: $('demo-badge'),
  offlineBanner: $('offline-banner'),

  search: $('search'),
  searchClear: $('search-clear'),
  rail: $('rail'),
  column: $('column'),
  views: {
    library: $('view-library'),
    online: $('view-online'),
    playlists: $('view-playlists'),
    // 每日推荐：一级目的地，容器在 index.html，菜单项由 daily-view.js 注入。
    daily: $('view-daily'),
    queue: $('view-queue'),
    favorites: $('view-favorites'),
    settings: $('view-settings'),
  },

  dvBody: $('dv-body'),
  dvSub: $('dv-sub'),
  dvPrev: $('dv-prev'),
  dvNext: $('dv-next'),
  dvDate: $('dv-date'),
  dvRefresh: $('dv-refresh'),
  dvPlay: $('dv-play'),
  dvModes: $('dv-modes'),
  dvLayouts: $('dv-layouts'),
  setNavDaily: $('set-nav-daily'),
  setNavPlaylists: $('set-nav-playlists'),
  setNavOnline: $('set-nav-online'),
  setNavFavorites: $('set-nav-favorites'),
  setQueueAdd: $('set-queue-add'),
  setPlaybackEntry: $('set-playback-entry'),
  setAutoPlay: $('set-auto-play'),
  setScrobble: $('set-scrobble'),
  setRelay: $('set-relay'),
  setLyricOffsetValue: $('set-lyric-offset-value'),
  setLyricOffsetDown: $('set-lyric-offset-down'),
  setLyricOffsetUp: $('set-lyric-offset-up'),
  setLyricOffsetReset: $('set-lyric-offset-reset'),
  setLyricStaff: $('set-lyric-staff'),
  setLyricStaffPattern: $('set-lyric-staff-pattern'),
  setLyricStaffNote: $('set-lyric-staff-note'),
  setLyricFilterOn: $('set-lyric-filter-on'),
  setLyricFilterPattern: $('set-lyric-filter-pattern'),
  setLyricFilterNote: $('set-lyric-filter-note'),
  setRmBg: $('set-rm-bg'),
  setRmLyrics: $('set-rm-lyrics'),
  setRmUi: $('set-rm-ui'),
  setRmWall: $('set-rm-wall'),

  libCount: $('lib-count'),
  libSort: $('lib-sort'),
  libList: $('lib-list'),
  libArtistFilter: $('lib-artist-filter'),
  libAlbumFilter: $('lib-album-filter'),
  libCleanup: $('lib-cleanup'),
  libBatchBar: $('lib-batch-bar'),
  libBatchCount: $('lib-batch-count'),
  libBatchPlaylist: $('lib-batch-playlist'),
  libBatchFav: $('lib-batch-fav'),
  libBatchEdit: $('lib-batch-edit'),
  libBatchComplete: $('lib-batch-complete'),
  libBatchClear: $('lib-batch-clear'),
  backupExport: $('backup-export'),
  backupImport: $('backup-import'),
  backupFile: $('backup-file'),
  m3uImport: $('m3u-import'),
  m3uFile: $('m3u-file'),
  plDetailM3u: $('pl-detail-m3u'),
  cacheUsage: $('cache-usage'),
  cacheBreakdown: $('cache-breakdown'),
  cacheLimit: $('cache-limit'),
  overlayGroup: $('overlay-group'),
  overlayStyle: $('overlay-style'),
  overlayCopy: $('overlay-copy'),
  overlayOpen: $('overlay-open'),
  videoExportGroup: $('video-export-group'),
  videoExportOpen: $('video-export-open'),
  cacheClear: $('cache-clear'),
  cacheKeepCurrent: $('cache-keep-current'),
  cacheKeepList: $('cache-keep-list'),
  dspEq: $('dsp-eq'),
  dspPreamp: $('dsp-preamp'),
  dspLoudness: $('dsp-loudness'),
  dspCrossfade: $('dsp-crossfade'),
  dspSave: $('dsp-save'),
  dspReset: $('dsp-reset'),
  remoteName: $('remote-name'),
  remoteUrl: $('remote-url'),
  remoteUser: $('remote-user'),
  remotePass: $('remote-pass'),
  remoteAdd: $('remote-add'),
  remoteRootList: $('remote-root-list'),
  remoteBrowse: $('remote-browse'),
  remoteBrowseTitle: $('remote-browse-title'),
  remoteBrowsePath: $('remote-browse-path'),
  remoteBrowseClose: $('remote-browse-close'),
  remoteBrowseList: $('remote-browse-list'),
  remoteImportDir: $('remote-import-dir'),
  remoteBrowseStatus: $('remote-browse-status'),
  remoteScrim: $('remote-scrim'),
  libEmpty: $('lib-empty'),
  libEmptyGuide: $('lib-empty-guide'),
  libEmptyNoMatch: $('lib-empty-nomatch'),
  libEmptyNoMatchText: $('lib-empty-nomatch-text'),
  libEmptyNoMatchClear: $('empty-nomatch-clear'),
  libEmptyStrip: $('lib-empty-strip'),
  libSentinel: $('lib-sentinel'),
  libHint: $('lib-hint'),

  scanToggle: $('scan-toggle'),
  scanPanel: $('scan-panel'),
  scanRoot: $('scan-root'),
  scanBtn: $('scan-btn'),
  scanBar: $('scan-bar'),
  scanLabel: $('scan-label'),
  scanHistory: $('scan-history'),
  scanRoots: $('scan-roots'),
  scanCancel: $('scan-cancel'),
  scanErrors: $('scan-errors'),

  playlistList: $('playlist-list'),
  playlistGrid: $('playlist-grid'),
  plViews: $('pl-views'),
  playlistOnline: $('playlist-online'),
  oplGrid: $('opl-grid'),
  oplDetail: $('opl-detail'),
  playlistCount: $('playlist-count'),
  newPlaylistName: $('new-playlist-name'),
  newPlaylistBtn: $('new-playlist-btn'),
  shelf: $('shelf'),

  plDetail: $('pl-detail'),
  plDetailName: $('pl-detail-name'),
  plDetailCount: $('pl-detail-count'),
  plDetailList: $('pl-detail-list'),
  plDetailBack: $('pl-detail-back'),
  plDetailPlay: $('pl-detail-play'),
  plDetailQueue: $('pl-detail-queue'),
  plDetailRename: $('pl-detail-rename'),
  plDetailDelete: $('pl-detail-delete'),

  queueList: $('queue-list'),
  queueCount: $('queue-count'),
  queueClear: $('queue-clear'),
  queueSave: $('queue-save'),
  sleepTimer: $('sleep-timer'),
  sleepTimerLabel: $('sleep-timer-label'),
  queueBadge: $('queue-badge'),

  setDevice: $('set-device'),
  setDensity: $('set-density'),
  setMotion: $('set-motion'),
  setCoverFollow: $('set-cover-follow'),
  settingsEntry: $('settings-entry'),
  setStageIdleHide: $('set-stage-idle-hide'),
  cookieRows: $('cookie-rows'),
  setRenderMode: $('set-render-mode'),
  renderWarn: $('render-warn'),
  setBackend: $('set-backend'),

  // 开发者选项：播放诊断日志。
  setDevDiag: $('set-dev-diag'),
  devDiagDetail: $('dev-diag-detail'),
  devDiagPath: $('dev-diag-path'),
  devDiagActions: $('dev-diag-actions'),
  devDiagCopy: $('dev-diag-copy'),
  devDiagSave: $('dev-diag-save'),
  devDiagClear: $('dev-diag-clear'),

  // 创意舞台：细分参数在工坊里调。
  workshopBtn: $('workshop-btn'),
  setWorkshopBtn: $('set-workshop-btn'),

  cover: $('cover'),
  nowTitle: $('now-title'),
  nowArtist: $('now-artist'),
  nowTech: $('now-tech'),
  spectrum: $('spectrum'),
  lyrics: $('lyrics'),

  // 胶囊播放器（最小化态）：DOM 在 index.html 的 #capsule，样式在 style.css。
  capsule: $('capsule'),
  capsuleArt: $('capsule-art'),
  capsuleTitle: $('capsule-title'),
  capsuleArtist: $('capsule-artist'),
  capsuleLabel: $('capsule-label'),
  capsuleEntry: $('capsule-entry'),
  capsulePrev: $('capsule-prev'),
  capsulePlay: $('capsule-play'),
  capsuleNext: $('capsule-next'),
  capsuleExpand: $('capsule-expand'),

  // 旧 stage-btn 移除后，「正在播放」入口落在播放栏的曲目标题区。
  stageBtn: $('bar-track'),
  barTitle: $('bar-title'),
  barSub: $('bar-sub'),
  barTime: $('bar-time'),
  prev: $('prev'),
  playpause: $('playpause'),
  next: $('next'),
  stop: $('stop'),
  mode: $('mode'),
  progress: $('progress'),
  progressGhost: $('progress-ghost'),
  volume: $('volume'),
  toast: $('toast'),
  scrim: $('scrim'),
  ambient: $('ambient'),
  ambientImg: $('ambient-img'),
  menu: $('ctx-menu'),

  // 主题色切换
  themeBtn: $('theme-btn'),
  themeMenu: $('theme-menu'),
  setTheme: $('set-theme'),
  themeSwatches: $('theme-swatches'),

  // 舞台控制
  stageCtlBtn: $('stage-control-btn'),
  stageCtl: $('stage-ctl'),
  scClose: $('sc-close'),
  scReset: $('sc-reset'),
  scOk: $('sc-ok'),

  // 在线曲库
  onlineCount: $('online-count'),
  onlineSource: $('online-source'),
  onlineQ: $('online-q'),
  onlineGo: $('online-go'),
  onlineChips: $('online-chips'),
  onlineBody: $('online-body'),
  onlineSentinel: $('online-sentinel'),

  // 收藏
  favList: $('fav-list'),
  favCount: $('fav-count'),
  favTabs: $('fav-tabs'),
  favPlayAll: $('fav-play-all'),
  favMore: $('fav-more'),
  favTabTrack: $('fav-tab-track'),
  favTabRadio: $('fav-tab-radio'),
  favRefresh: $('fav-refresh'),
  favBadge: $('fav-badge'),

  // 每日推荐
  dailyList: $('daily-list'),
  dailyDate: $('daily-date'),
  dailySub: $('daily-sub'),
  dailyPlayAll: $('daily-play-all'),
  dailyRefresh: $('daily-refresh'),
  dailyModes: $('daily-modes'),
};

// 舞台（沉浸音乐模式）由 stage.js 提供，先于 app.js 加载。它只吃数据、只吐
// 事件：渲染与动画在里面，播放逻辑仍然只有 app.js 这一份。
const Stage = window.Stage;

const state = {
  view: 'library',
  tracks: [],
  total: 0,
  q: '',
  offset: 0,
  loading: false,
  sort: 'title',
  byId: new Map(),
  rows: new Map(),

  queue: [],
  queueIndex: -1,
  snapshot: { playing: false, position_ms: 0, duration_ms: null, volume: 0.8, mode: 'repeat', track_id: null },
  // 播放落点的武装位：见过一次「停着」的快照后才允许触发（见 applySnapshot）。
  entryArmed: false,

  current: null,

  seeking: false,
  // 乐观 UI 守卫：刚发出播放/暂停命令时，在途的旧快照会让按钮闪回。
  // 用「命令时刻 + 在途意图」两个量压住这段窗口，判定见 staleCommand()。
  commandAt: 0,
  commandPending: false,
  commandIntent: 0,
  expectedPlaying: false,
  // 用户按下过「停止」且之后没再播放。停止与暂停在快照里长得一样（playing 都是
  // false、track_id 都还在），只有客户端知道那一下是停而不是暂停。
  stopped: false,
  loadingTrack: null,
  spectrum: new Array(64).fill(0),
  peaks: new Array(64).fill(0),
  playlists: [],
  // 曲库多选：勾选的曲目 id。批量栏按它显隐与计数。
  selected: new Set(),
  // 专辑/歌手筛选（覆盖后的展示值精确匹配）。
  libFilter: { artist: '', album: '' },
  devices: [],
  settings: {},
  connected: false,
  modeLabel: { repeat: '列表循环', repeat_one: '单曲循环', shuffle: '随机播放' },
};

// ---------------------------------------------------------------------------
// Transport：HTTP / WebSocket 或演示后端
// ---------------------------------------------------------------------------

// A newer playback command cancels preparation in every view, not just that view.
const PlaybackIntent = {
  generation: 0,
  queueRevision: 0,
  sourceRevision: 0,
  begin() { return ++this.generation; },
  current(ticket) { return ticket === this.generation; },
  command(path) {
    if (/^\/v1\/player\/(load|play|pause|stop|next|previous|replay)$/.test(path) || (path === '/v1/online/play' || path === '/v1/online/radio')) this.begin();
    if (/^\/v1\/player\/(load|next|previous|replay)$/.test(path) || path === '/v1/online/play' || path === '/v1/online/radio') this.sourceRevision += 1;
    if (path === '/v1/player/load' || (path === '/v1/online/play' || path === '/v1/online/radio') || path === '/v1/player/queue') this.queueRevision += 1;
  },
};

let playerCommandQueue = Promise.resolve();

/// 播放命令的串行化：新的播放意图会作废还在排队的旧命令。
///
/// 抽成函数是为了让 HTTP 与 DBX invoke 两条传输共用同一份语义——
/// check-player-races.js 断言的正是「stop 不等下一首准备完就到后端」，
/// 两边各写一遍迟早漂移。`send` 是各传输自己的底层请求函数。
function serializedPlaybackPost(path, body, send) {
  PlaybackIntent.command(path);
  const post = () => send(path, { method: 'POST', body: JSON.stringify(body || {}) });
  if (!/^\/v1\/player\/(play|pause|stop|seek)$/.test(path)) return post();
  const revision = PlaybackIntent.sourceRevision;
  const result = playerCommandQueue.then(() => {
    if (revision !== PlaybackIntent.sourceRevision) throw new DOMException('Playback replaced', 'AbortError');
    return post();
  });
  playerCommandQueue = result.catch(() => {});
  return result;
}

const ServerTransport = {
  kind: 'server',
  async get(path, options) { return request(path, options || {}); },
  async postRaw(path, blob, contentType) {
    return request(path, { method: 'POST', rawBody: blob, headers: { 'Content-Type': contentType || 'application/octet-stream' } });
  },
  async post(path, body) {
    return serializedPlaybackPost(path, body, request);
  },
  async put(path, body) {
    PlaybackIntent.command(path);
    return request(path, { method: 'PUT', body: JSON.stringify(body || {}) });
  },
  async del(path) { return request(path, { method: 'DELETE' }); },
  // 直接给出可以塞进 <img src> 的地址，不再自己 fetch + createObjectURL。
  //
  // 旧实现是"单槽缓存"：每次取新封面都 revoke 掉上一个 object URL。作为
  // 「正在播放」那一格它没问题，但曲库列表按行调用时，加载第 N 张会把
  // 第 N-1 张的 URL 作废——往下滚一段，上面的封面就集体变空白。
  // 交给浏览器管图片缓存后，这整类生命周期 bug 一次性消失。
  //
  // token 走查询参数：浏览器不给 <img> 加请求头，和 /ws 用 ?token= 同一个理由。
  // 服务端把这条通道严格限制在 GET 上（见 routes.rs 的 require_token）。
  coverUrl(id) {
    return `/v1/tracks/${encodeURIComponent(id)}/cover?token=${encodeURIComponent(TOKEN)}`;
  },
  connect(onMessage) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(TOKEN)}`);
    ws.onopen = () => onConnectionChange(true);
    ws.onclose = () => { onConnectionChange(false); scheduleReconnect(); };
    ws.onerror = () => ws.close();
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      onMessage(msg);
    };
    return ws;
  },
  // 独立形态下封面有可直连的 URL，不需要预取、就绪通知与缓存失效。给同名空
  // 实现，让调用方不必区分宿主。
  ensureCover: () => Promise.resolve(null),
  invalidateCover: () => Promise.resolve(),
  onCoverReady: () => () => {},
};

// ---------------------------------------------------------------------------
// Transport：DBX 插件形态（stdio JSON-RPC sidecar）
// ---------------------------------------------------------------------------
//
// DBX 的插件界面是 srcdoc + sandbox="allow-scripts" 的 iframe：origin 是 opaque，
// CSP 是 connect-src 'none'，而 host.network 权限只接受 https:// ——插件界面根本
// 没法访问 localhost 上的 HTTP 服务，WebSocket 同理。所有往来只能走
// window.dbxPlugin.invoke 与 onEvent。
//
// 接口与路径写法保持和 ServerTransport 完全一致：调用方照样传 "/v1/tracks?q=x"，
// 由 splitPath 翻成 RPC 方法名与 query，于是上百个调用点一行都不用改。

/// "/v1/tracks?q=x&limit=50" → { method: "v1/tracks", query: { q: "x", limit: "50" } }
///
/// 方法名不能以 "/" 开头：dbx 要求方法名匹配 ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$。
function splitPath(path) {
  const cut = path.indexOf('?');
  const pathname = cut >= 0 ? path.slice(0, cut) : path;
  const query = {};
  if (cut >= 0) new URLSearchParams(path.slice(cut + 1)).forEach((value, key) => { query[key] = value; });
  return { method: pathname.replace(/^\/+/, ''), query };
}

const DBX_EVENT_METHOD = 'studio/event';
const DBX_SUBSCRIBE_METHOD = 'studio/events/subscribe';

/// invoke 只有 timeoutMs，没有中断能力。UI 传 signal 想表达的是「这个结果我不要了」
/// （典型场景：搜索词变了，作废上一批响应），所以让 signal 与 invoke 竞速：本地立刻
/// 按 AbortError 拒绝，后端那次调用会跑完但结果被丢弃。对调用方与 HTTP 版的 abort
/// 等价，代价是白跑一次后端。
function dbxInvoke(method, params, signal) {
  const call = window.dbxPlugin.invoke(method, params, { timeoutMs: REQUEST_TIMEOUT });
  if (!signal) return call;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    const settle = (finish) => (value) => {
      signal.removeEventListener('abort', onAbort);
      finish(value);
    };
    call.then(settle(resolve), settle(reject));
  });
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // 宿主 SDK 自带 base64，省掉 FileReader 和手搓分块 btoa。
  if (window.dbxPlugin && window.dbxPlugin.encodeBase64) return window.dbxPlugin.encodeBase64(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/// 把 sidecar 的 {status, body} 信封还原成与 HTTP 版一致的返回/抛错语义。
async function dbxRequest(path, options = {}, attempt = 0) {
  const { method, query } = splitPath(path);
  const op = (options.method || 'GET').toUpperCase();
  const params = { op, query };
  if (options.rawBody !== undefined) {
    // 二进制上传（封面替换）：HTTP 版是裸 body + Content-Type，这里换成信封里的 base64。
    params.raw_base64 = await blobToBase64(options.rawBody);
    params.raw_content_type = (options.headers && options.headers['Content-Type']) || 'application/octet-stream';
  } else if (options.body !== undefined) {
    params.body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
  }

  try {
    const envelope = await dbxInvoke(method, params, options.signal);
    if (!envelope || typeof envelope.status !== 'number') {
      throw new Error('sidecar 返回了不认识的结果');
    }
    if (envelope.status >= 200 && envelope.status < 300) {
      // HTTP 版 204 返回 null；这里 body 为 null 时同样给出 null。
      return envelope.body === undefined ? null : envelope.body;
    }
    const detail = (envelope.body && envelope.body.error) || {};
    const err = new Error(detail.message || `HTTP ${envelope.status}`);
    // 三个字段都是前端错误契约的一部分：request_id 用来回查日志，code 让前端按
    // 判别式分流，status 决定算不算「可重试的瞬时错误」。
    err.requestId = detail.request_id;
    err.code = detail.code;
    err.status = envelope.status;
    if (detail.source) err.source = detail.source;
    throw err;
  } catch (err) {
    // 与 HTTP 版同一套重试判据：幂等读、瞬时故障、重试一次。
    const transient = !err.status || err.status >= 500 || err.name === 'AbortError' || err.name === 'TypeError';
    if (op === 'GET' && attempt === 0 && transient && !(options.signal && options.signal.aborted)) {
      await new Promise((r) => setTimeout(r, 300));
      return dbxRequest(path, options, attempt + 1);
    }
    throw err;
  }
}

// 封面：插件形态下没有可直连的 URL，只能经 invoke 取回 base64 拼成 data URL。
//
// coverUrl(id) 是**同步**契约——六个文件、十几处调用点把返回值直接塞进 <img src>
// 或 CSS url()。所以它保持同步只读缓存，未命中时返回 null 并顺手触发异步填充，
// 填好后经 onCoverReady 通知，由调用方重绘那一格。
const COVER_CACHE_MAX = 200;
const coverCache = new Map();    // id -> data URL；Map 的插入序就是 LRU 序
const coverPending = new Map();  // id -> Promise，避免同一张图被并发取多次
const coverListeners = new Set();

function coverRemember(id, dataUrl) {
  coverCache.delete(id);
  coverCache.set(id, dataUrl);
  while (coverCache.size > COVER_CACHE_MAX) coverCache.delete(coverCache.keys().next().value);
}

function notifyCover(id, dataUrl) {
  repaintCovers(id, dataUrl);
  coverListeners.forEach((listener) => {
    try { listener(id, dataUrl); } catch (err) { console.warn('[hertz] 封面重绘失败', err); }
  });
}

function ensureCover(id) {
  if (!id) return Promise.resolve(null);
  if (coverCache.has(id)) return Promise.resolve(coverCache.get(id));
  if (coverPending.has(id)) return coverPending.get(id);
  const task = dbxRequest(`/v1/tracks/${encodeURIComponent(id)}/cover`)
    .then((cover) => {
      if (!cover || !cover.data) return null;
      const dataUrl = `data:${cover.content_type || 'image/jpeg'};base64,${cover.data}`;
      coverRemember(id, dataUrl);
      notifyCover(id, dataUrl);
      return dataUrl;
    })
    // 取不到就保持无封面，不该让整行渲染失败。
    .catch(() => null)
    .finally(() => coverPending.delete(id));
  coverPending.set(id, task);
  return task;
}

function dbxCoverUrl(id) {
  if (!id) return null;
  const hit = coverCache.get(id);
  if (hit) { coverRemember(id, hit); return hit; }  // 命中即刷新 LRU 位置
  ensureCover(id);
  return null;
}

// 远程封面（音源 CDN 的 https 图）在插件形态下画不出来：沙箱 CSP 的 img-src 只
// 放行 data: / blob: / 插件资源源，连 fetch 都不行（connect-src 'none'）。独立
// 形态没有这层 CSP，远程 URL 直接进 <img src> 就是对的。所以插件形态一律经
// sidecar 的 /v1/online/cover 取回 base64，复用本地封面那套缓存与回填；下面每个
// 函数对独立形态都是恒等的，调用点因此不需要分支。
function isRemoteCoverUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function remoteCoverKey(url) {
  return 'url:' + url;
}

function ensureRemoteCover(url) {
  const key = remoteCoverKey(url);
  if (coverCache.has(key)) return Promise.resolve(coverCache.get(key));
  if (coverPending.has(key)) return coverPending.get(key);
  const task = dbxRequest(`/v1/online/cover?url=${encodeURIComponent(url)}`)
    .then((cover) => {
      if (!cover || !cover.data) return null;
      const dataUrl = `data:${cover.content_type || 'image/jpeg'};base64,${cover.data}`;
      coverRemember(key, dataUrl);
      notifyCover(key, dataUrl);
      return dataUrl;
    })
    // 取不到就保持占位，不该让整行渲染失败。
    .catch(() => null)
    .finally(() => coverPending.delete(key));
  coverPending.set(key, task);
  return task;
}

/// 同步契约，与 dbxCoverUrl 同款：命中缓存给 data URL；未命中返回 null 并触发取
/// 回，落地后经 coverSlot 回填。非远程地址原样返回。
function remoteCover(url) {
  if (!url) return null;
  if (transport.kind !== 'dbx' || !isRemoteCoverUrl(url)) return url;
  const hit = coverCache.get(remoteCoverKey(url));
  if (hit) return hit;
  ensureRemoteCover(url);
  return null;
}

/// 等一手解析结果：插件形态把远程地址换成 data URL，换不到返回 null。
/// 独立形态恒等。正在播放 / 舞台这类「必须拿到才画」的位置用它。
async function resolveCover(url) {
  if (!url) return null;
  if (transport.kind !== 'dbx' || !isRemoteCoverUrl(url)) return url;
  return (await ensureRemoteCover(url)) || null;
}

/// 回填登记。独立形态下立即用原 URL 调一次 apply，调用点不用分支。
function remoteCoverSlot(url, apply) {
  if (!url || typeof apply !== 'function') return;
  if (transport.kind !== 'dbx' || !isRemoteCoverUrl(url)) {
    apply(url);
    return;
  }
  coverSlot(remoteCoverKey(url), apply);
  ensureRemoteCover(url);
}

/// 背景图位：插件形态先清空、代理落地后回填。
function applyCoverBg(el, url) {
  if (!el) return;
  const resolved = remoteCover(url);
  if (resolved === null) {
    el.style.backgroundImage = '';
    remoteCoverSlot(url, (u) => { el.style.backgroundImage = `url("${u}")`; });
    return;
  }
  el.style.backgroundImage = resolved ? `url("${resolved}")` : '';
}

/// <img> 位：与 applyCoverBg 同一套解析，只是落在 src 上。
function applyCoverImg(img, url) {
  if (!img) return;
  const resolved = remoteCover(url);
  if (resolved === null) {
    img.removeAttribute('src');
    remoteCoverSlot(url, (u) => { img.src = u; });
    return;
  }
  if (resolved) img.src = resolved;
  else img.removeAttribute('src');
}

// 其它模块（daily / 歌单两层 / 登录头像）拿不到 app.js 的闭包，经这个全局取用；
// 与 window.Online 的宿主注入是两种风格，但改六个 bind() 的扩散面更大。
window.HertzCovers = {
  isRemote: isRemoteCoverUrl,
  url: remoteCover,
  resolve: resolveCover,
  slot: remoteCoverSlot,
  applyBg: applyCoverBg,
  applyImg: applyCoverImg,
};

// 封面异步落地后的回填。
//
// 分两路，为的是让调用点改动最小：
//   · `.t-art` 结构（曲库行、歌单详情行、收藏格）按 [data-id] 全局找回来重绘，
//     调用点一行都不用改——paintArt 本来就是幂等的（dataset.src 相同即跳过）。
//   · 背景图 / 封面墙 / 唱片套这类不是 .t-art 的位置，渲染时登记一个 setter。
//
// 独立形态下 coverUrl 是同步的真 URL，首帧就画对了，登记进来的 setter 立刻命中
// 缓存、之后也不会再触发，所以这套机制对 HTTP 宿主是无操作。
const coverSlots = new Map();  // id -> Set<(url) => void>

function coverSlot(id, apply) {
  if (!id || typeof apply !== 'function') return;
  let setters = coverSlots.get(id);
  if (!setters) { setters = new Set(); coverSlots.set(id, setters); }
  setters.add(apply);
  const cached = coverCache.get(id);
  if (cached) apply(cached);
}

function releaseCoverSlots(id) {
  coverSlots.delete(id);
}

function repaintCovers(id, dataUrl) {
  if (typeof CSS !== 'undefined' && CSS.escape) {
    document.querySelectorAll(`[data-id="${CSS.escape(id)}"]`).forEach((host) => {
      if (host.querySelector('.t-art')) paintArt(host, dataUrl);
    });
  }
  const setters = coverSlots.get(id);
  if (setters) setters.forEach((apply) => {
    try { apply(dataUrl); } catch (err) { console.warn('[hertz] 封面回填失败', err); }
  });
}

const DbxTransport = {
  kind: 'dbx',
  async get(path, options) { return dbxRequest(path, options || {}); },
  async postRaw(path, blob, contentType) {
    return dbxRequest(path, {
      method: 'POST',
      rawBody: blob,
      headers: { 'Content-Type': contentType || 'application/octet-stream' },
    });
  },
  async post(path, body) { return serializedPlaybackPost(path, body, dbxRequest); },
  async put(path, body) {
    PlaybackIntent.command(path);
    return dbxRequest(path, { method: 'PUT', body: JSON.stringify(body || {}) });
  },
  async del(path) { return dbxRequest(path, { method: 'DELETE' }); },
  coverUrl: dbxCoverUrl,
  ensureCover,
  /// 换封面之后必须先把缓存里的旧图丢掉，否则重绘出来的还是旧的。
  invalidateCover(id) {
    coverCache.delete(id);
    coverPending.delete(id);
    return Promise.resolve();
  },
  onCoverReady(listener) {
    coverListeners.add(listener);
    return () => coverListeners.delete(listener);
  },
  connect(onMessage) {
    let closed = false;
    const unsubscribe = window.dbxPlugin.onEvent((event) => {
      if (closed || !event || event.method !== DBX_EVENT_METHOD) return;
      onMessage(event.params);
    });
    // 订阅是幂等的：sidecar 侧的转发器只会起一次（emitter 只能在 handle() 里拿到，
    // 而转发必须共用 SDK 那把 stdout 锁，所以只能惰性启动）。
    window.dbxPlugin.invoke(DBX_SUBSCRIBE_METHOD, {})
      .then(() => { if (!closed) onConnectionChange(true); })
      .catch((err) => {
        console.warn('[hertz] 事件订阅失败，界面只能靠轮询', err);
        if (!closed) { onConnectionChange(false); scheduleReconnect(); }
      });
    return {
      close() {
        if (closed) return;
        closed = true;
        if (typeof unsubscribe === 'function') unsubscribe();
        onConnectionChange(false);
      },
    };
  },
};

const REQUEST_TIMEOUT = 15000;

async function request(path, options = {}, attempt = 0) {
  const method = (options.method || 'GET').toUpperCase();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const cancel = () => controller && controller.abort();
  if (options.signal) {
    if (options.signal.aborted) cancel();
    else options.signal.addEventListener('abort', cancel, { once: true });
  }
  const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT) : 0;
  try {
    // rawBody：封面替换这类二进制上传走这里，不包 JSON、不改 Content-Type。
    const body = options.rawBody !== undefined
      ? options.rawBody
      : (options.body !== undefined && typeof options.body !== 'string'
        ? JSON.stringify(options.body) : options.body);
    const res = await fetch(path, {
      ...options,
      body,
      signal: controller ? controller.signal : options.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...(options.headers || {}) },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body?.error?.message || `HTTP ${res.status}`);
      // request_id 与 code 都是后端错误契约的一部分：request_id 用来回查日志，
      // code 让前端能按判别式分流（渲染时才翻成文案，不拿服务端的句子当判据）。
      err.requestId = body?.error?.request_id;
      err.code = body?.error?.code;
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : await res.json();
  } catch (err) {
    // 网络抖动、超时、服务端 5xx：幂等读重试一次，避免偶发失败直接弹红。
    const transient = !err.status || err.status >= 500 || err.name === 'AbortError' || err.name === 'TypeError';
    if (method === 'GET' && attempt === 0 && transient && !(options.signal && options.signal.aborted)) {
      await new Promise((r) => setTimeout(r, 300));
      return request(path, options, attempt + 1);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener('abort', cancel);
  }
}

// 后端错误契约里有 request_id，没有它就只能靠猜去翻日志。
function errText(prefix, err) {
  return `${prefix}：${err.message}${err.requestId ? `（request_id ${err.requestId}）` : ''}`;
}

/// 弹窗统一走 dialogs.js：DBX 的插件 iframe 没有 allow-modals，原生
/// prompt/confirm 会被浏览器静默忽略（返回 null / false），于是"重命名歌单"
/// 这类流程点了没反应。独立形态下 dialogs.js 原样委托给原生，行为不变。
/// 契约脚本的环境里可能没装 hertzDialog，所以退回 window 上的原生实现——
/// 原生是同步返回值，自建的是 Promise，await 对两者都成立。
const modal = () => window.hertzDialog || window;

let transport = ServerTransport;

// 其它表现层模块（创意舞台、工坊、背景层）也要读写服务端设置。与其各自再实现
// 一份带 token 的 fetch，不如把同一个 transport 暴露出去 —— 演示模式下的降级、
// 超时重试、错误归一化都留在这唯一一份实现里。
// 用函数转发而不是直接赋值 `transport`：boot 里会把它换成 MockBackend，
// 直接赋值会让外部一直拿着启动前那个引用。
window.VMusicTransport = {
  beginPlaybackIntent: () => PlaybackIntent.begin(),
  isPlaybackIntent: (ticket) => PlaybackIntent.current(ticket),
  playbackIntent: () => PlaybackIntent.generation,
  get: (p, options) => transport.get(p, options),
  put: (p, body) => transport.put(p, body),
  post: (p, body) => transport.post(p, body),
  postRaw: (p, blob, contentType) => transport.postRaw(p, blob, contentType),
  del: (p) => transport.del(p),
  kind: () => transport.kind
};

async function chooseTransport() {
  // DBX 插件沙箱里 CSP 是 connect-src 'none'，下面的健康探测必然失败，
  // 而且失败后会误落到演示模式，所以直接短路。
  if (window.hertzHost && window.hertzHost.isDbx && window.dbxPlugin) {
    await window.dbxPlugin.ready;
    // 同一个工作台贡献点会开成两种 surface：tab（完整播放器）与 window（宿主给小组件
    // 准备的浮动桌面窗口：无边框、置顶、可拖、贴边吸附，切到别的应用也还在）。浮动
    // 实例只渲染胶囊：整界面隐藏、舞台 rAF 也停掉（见 stage.js 的 schedule 门），
    // 否则等于白跑一份 60fps 渲染。
    const surface = (window.dbxPlugin.context && window.dbxPlugin.context.surface) || 'tab';
    window.HertzCapsuleOnly = surface === 'window';
    if (window.HertzCapsuleOnly) enterFloatingCapsule();
    return DbxTransport;
  }
  const forced = new URLSearchParams(location.search).get('demo');
  if (forced === '1') return window.MockBackend;
  try {
    // file:// 下 fetch 直接抛错；服务不可达时也会走到这里。
    const res = await fetch('/v1/health', { cache: 'no-store' });
    if (!res.ok) throw new Error('unhealthy');
    await res.json();
    return ServerTransport;
  } catch {
    return window.MockBackend || ServerTransport;
  }
}

// ---------------------------------------------------------------------------
// 反馈：toast / 连接状态 / 退避重连
// ---------------------------------------------------------------------------

let toastTimer = 0;

function toast(message, kind = 'info') {
  clearTimeout(toastTimer);
  const hide = () => {
    ui.toast.classList.remove('show');
    setTimeout(() => { ui.toast.hidden = true; }, 220);
  };
  if (!message) { hide(); clearCapsuleNotice(); return; }
  ui.toast.textContent = message;
  ui.toast.className = kind === 'error' ? 'toast error' : 'toast';
  ui.toast.hidden = false;
  requestAnimationFrame(() => ui.toast.classList.add('show'));
  toastTimer = setTimeout(hide, kind === 'error' ? 6000 : 1400);
  // 最小化态里这一层是看不见的，同一句话交给胶囊自己说。
  noticeCapsule(message, kind);
}

let retries = 0;
let reconnectTimer = 0;
// 只有「真的断过线」才需要在重连时补一次全量拉取。启动流程自己会
// await refreshAll()，WebSocket 的首次 onopen 不该再补一遍——那第二遍
// loadSettings 的响应是异步到达的，落在用户已经开始操作的时刻，会把刚点
// 下的即时开关按服务端旧值覆盖回去（症状：舞台上的按钮点了没反应）。
let missedWhileOffline = false;

function onConnectionChange(ok) {
  state.connected = ok;
  ui.conn.textContent = ok ? '服务已连接' : '服务已断开';
  ui.conn.className = ok ? 'conn ok' : 'conn bad';
  ui.offlineBanner.hidden = ok;
  if (ok) {
    retries = 0;
    // 断线期间错过了一切，重连后先把全量状态拉回来。
    if (missedWhileOffline) {
      missedWhileOffline = false;
      refreshAll();
    }
  } else {
    missedWhileOffline = true;
  }
}

function scheduleReconnect() {
  // 指数退避：服务重启时不至于被 3 秒一次的固定重试打爆。
  const delay = Math.min(15000, 1000 * 2 ** retries) * (0.75 + Math.random() * 0.5);
  retries += 1;
  ui.conn.textContent = `重连中（${Math.round(delay / 1000)}s）`;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(openSocket, delay);
}

let socket = null;
function openSocket() {
  if (socket && socket.close) socket.close();
  socket = transport.connect(handleEvent);
}

// ---------------------------------------------------------------------------
// 事件总线
// ---------------------------------------------------------------------------

function handleEvent(msg) {
  switch (msg.type) {
    case 'state': applySnapshot(msg); break;
    case 'spectrum':
      state.spectrum = msg.bands || [];
      drawSpectrum();
      if (Stage) Stage.setSpectrum(state.spectrum);
      break;
    case 'scan': onScanProgress(msg); break;
    case 'library_changed': loadTracks(true); loadPlaylists(); break;
    case 'ended': reconcileEnded(); break;
    case 'ui_notice':
      // dock 胶囊点了一下：tab 实例解除最小化。dock 实例自己忽略（它永远是最小化态）。
      if (msg.action === 'expand-capsule' && !window.HertzCapsuleOnly) setCapsuleMinimized(false);
      break;
    case 'error': {
      // 在线音源失败交给在线面板错误条（可重试当前队列下标 / 跳下一首）；
      // 「已跳过」类是服务端已自行处置的告知，轻提示即可；本地播放失败仍走错误 toast。
      if (msg.source && window.Online && window.Online.showOnlineError) {
        if (/已跳过/.test(msg.message)) {
          toast(msg.message);
        } else {
          // 重试下标以事件携带的为准：快照反查会在自动跳曲/切歌后指错曲。
          var idx = (msg.index != null ? msg.index : null);
          window.Online.showOnlineError(msg.message, idx);
          // 在线错误条在完整界面里；最小化态只剩胶囊，同一句话得由胶囊说。
          noticeCapsule(msg.message, 'error');
        }
      } else {
        toast(`播放异常：${msg.message}`, 'error');
      }
      break;
    }
    case 'buffering': {
      // 在线曲边下边播：播放键转 loading 态，title 提示缓冲进度；收口时清空。
      const active = !!msg.active;
      ui.playpause.classList.toggle('is-loading', active);
      ui.playpause.title = active
        ? (msg.pct != null ? `缓冲中 ${msg.pct}%` : '缓冲中…')
        : '';
      break;
    }
    case 'beatmap_ready':
      // 服务端后台分析完成：是否拉取由 StageCinema 自己按当前曲目判断。
      if (window.StageCinema && StageCinema.onBeatmapReady) StageCinema.onBeatmapReady(msg);
      break;
    case 'scrobbled':
      // 网易云听歌打卡成功（有效收听满 30s）：轻提示确认「播放量 +1」。
      toast(`已计入网易云播放量${state.current ? `：${state.current.title}` : ''}`);
      break;
    case 'source_switched':
      // 曲源自动接力：服务端已在其他音源找到同一首并换源续播（队列项与
      // 封面/标题元数据都已迁到新源名下，界面不跳变）。
      toast(`原音源不可用，已切换到${msg.to_label || '其他音源'}续播《${msg.title}》`);
      break;
    default: break;
  }
}

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------

function fmt(ms) {
  if (ms === null || ms === undefined) return '0:00';
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function qualityLabel(track) {
  if (!track.sample_rate) return null;
  const k = track.sample_rate / 1000;
  const lossless = track.bitrate === null || track.bitrate === undefined || track.bitrate > 900;
  return `${lossless ? '无损' : `${track.bitrate}k`} · ${k.toFixed(1)}kHz`;
}

function digestMs(ms) {
  return `${fmt(ms)} / ${fmt(state.snapshot.duration_ms)}`;
}

// ---------------------------------------------------------------------------
// 曲库：分页 + 行节点复用 + 封面懒加载
// ---------------------------------------------------------------------------

let libraryEpoch = 0;
async function loadTracks(reset) {
  if (state.loading && !reset) return;
  if (reset) libraryEpoch += 1;
  const epoch = libraryEpoch;
  const offset = reset ? 0 : state.tracks.length;
  const q = state.q;
  const sort = state.sort;
  let failed = false;
  state.loading = true;
  ui.libSentinel.disabled = true;
  ui.libSentinel.textContent = '正在读取曲库…';
  if (reset) { state.offset = 0; state.tracks = []; state.rows.clear(); ui.libList.innerHTML = ''; }
  try {
    const artist = state.libFilter.artist ? `&artist=${encodeURIComponent(state.libFilter.artist)}` : '';
    const album = state.libFilter.album ? `&album=${encodeURIComponent(state.libFilter.album)}` : '';
    const page = await transport.get(
      `/v1/tracks?q=${encodeURIComponent(q)}&sort=${encodeURIComponent(sort)}${artist}${album}&limit=${PAGE}&offset=${offset}`);
    if (epoch !== libraryEpoch) return;
    state.total = page.total;
    state.tracks = state.tracks.concat(page.tracks);
    state.offset = state.tracks.length;
    for (const t of page.tracks) state.byId.set(t.id, t);
    renderLibrary();
  } catch (err) {
    if (epoch !== libraryEpoch) return;
    failed = true;
    toast(errText('曲库读取失败', err), 'error');
  } finally {
    if (epoch === libraryEpoch) {
      state.loading = false;
      ui.libSentinel.disabled = false;
      ui.libSentinel.textContent = failed ? '重试读取曲库' : '加载更多歌曲';
      ui.libSentinel.hidden = !failed && state.tracks.length >= state.total;
    }
  }
}

async function libraryTrackIds() {
  const artist = state.libFilter.artist ? `&artist=${encodeURIComponent(state.libFilter.artist)}` : '';
  const album = state.libFilter.album ? `&album=${encodeURIComponent(state.libFilter.album)}` : '';
  const data = await transport.get(`/v1/tracks/ids?q=${encodeURIComponent(state.q)}&sort=${encodeURIComponent(state.sort)}${artist}${album}`);
  return data.track_ids;
}

// 专辑/歌手浏览面：拉一次 facets 重建筛选下拉（保留当前选中值）。
async function loadFacets() {
  const kinds = [['artist', ui.libArtistFilter], ['album', ui.libAlbumFilter]];
  for (const [kind, sel] of kinds) {
    if (!sel) continue;
    try {
      const data = await transport.get(`/v1/tracks/facets?kind=${kind}`);
      const current = state.libFilter[kind];
      sel.innerHTML = '';
      sel.appendChild(new Option(kind === 'artist' ? '全部歌手' : '全部专辑', ''));
      for (const f of data.facets || []) sel.appendChild(new Option(`${f.name}（${f.count}）`, f.name));
      sel.value = current || '';
      if (sel.value !== (current || '')) { sel.value = ''; state.libFilter[kind] = ''; }
    } catch { /* facets 拉取失败不阻塞曲库 */ }
  }
}

/// 曲库空态卡的显隐。容器内有两张互斥的卡：
///   - guide：「曲库还是空的」引导（无任何查询条件时才谈得上）；
///   - noMatch：搜索词/分类筛选命中 0 条时的反馈。
///
/// guide 描述的是**本地曲库**这一件事，可曲库页顶部还挂着一块每日推荐位，而那块
/// 有自己的「在线 / 本地」来源。来源选在线时，页面主体是在线推荐，本地库为空
/// 只是常态而不是待办事项，再压一张「去填音乐目录」的引导既挡视线也说不通
/// ——推荐位自己会把「没登录 / 这次没返回」写清楚。所以来源在线且无查询条件时
/// 一律不显示，切回本地再按曲库实际条数恢复。
///
/// 但搜索是用户的显式意图：哪怕曲库为空、哪怕推荐位停在在线来源，只要敲了词却
/// 0 条，就必须显示 noMatch——否则输入后界面纹丝不动，观感与「搜索坏了」无异。
function syncLibEmpty(list) {
  const tracks = list || state.tracks;
  const setStrip = (on) => { if (ui.libEmptyStrip) ui.libEmptyStrip.hidden = !on; };

  const apply = (guide, noMatch) => {
    setStrip(false);
    if (!ui.libEmpty) return true;
    if (ui.libEmptyGuide) ui.libEmptyGuide.hidden = !guide;
    if (ui.libEmptyNoMatch) ui.libEmptyNoMatch.hidden = !noMatch;
    const containerHidden = !guide && !noMatch;
    ui.libEmpty.hidden = containerHidden;
    return containerHidden;
  };

  if (tracks.length > 0) return apply(false, false);

  const q = (state.q || '').trim();
  const fArtist = !!(state.libFilter && state.libFilter.artist);
  const fAlbum = !!(state.libFilter && state.libFilter.album);
  if (q || fArtist || fAlbum) {
    if (ui.libEmptyNoMatchText) {
      ui.libEmptyNoMatchText.textContent = q
        ? `曲库中没有与「${q}」相关的标题、艺术家或专辑，换个关键词试试。`
        : '当前筛选条件下没有歌曲，换个歌手或专辑试试。';
    }
    if (ui.libEmptyNoMatchClear) {
      ui.libEmptyNoMatchClear.textContent = q ? '清空搜索' : '清除筛选';
    }
    return apply(false, true);
  }

  const onlineSource = !!(window.Daily && window.Daily.state && window.Daily.state.mode === 'online');
  if (onlineSource) {
    // 大引导卡照旧不弹（推荐位才是页面主体），但列表区也不能是无解释的白板：
    // 换成一行「本地曲库还没有歌曲 + 去填目录」的轻提示。
    apply(false, false);
    setStrip(true);
    return true;
  }
  return apply(true, false);
}

function renderLibrary() {
  const host = ui.libList;
  const list = state.tracks;

  const emptyHidden = syncLibEmpty(list);
  ui.libList.hidden = list.length === 0;
  // 后端返回了 total 但旧版 UI 直接丢弃，用户永远不知道自己是否被 500 条截断。
  ui.libCount.textContent = state.q
    ? `匹配 ${state.total} 首${state.total > list.length ? ` · 已加载 ${list.length}` : ''}`
    : `共 ${state.total} 首${state.total > list.length ? ` · 已加载 ${list.length}` : ''}`;
  // 列头跟着空态卡走：在线来源下既没有曲目、也不显示引导卡时，孤零零一行列头
  // 只会让人以为列表坏了。本地来源（引导卡在场）保持原样。
  ui.libHint.hidden = list.length === 0 && emptyHidden;

  const seen = new Set();
  list.forEach((track, index) => {
    seen.add(track.id);
    let row = state.rows.get(track.id);
    if (!row) {
      row = createTrackRow(track);
      state.rows.set(track.id, row);
    }
    updateTrackRow(row, track, index);
    // 只在节点不在 DOM 或位置变化时搬运，避免每次重排整棵子树。
    if (host.children[index] !== row) host.insertBefore(row, host.children[index] || null);
  });
  for (const [id, node] of state.rows) {
    if (!seen.has(id)) { node.remove(); state.rows.delete(id); }
  }
  ui.libSentinel.hidden = list.length >= state.total;
}

function createTrackRow(track) {
  const row = document.createElement('div');
  row.className = 'track';
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.dataset.id = track.id;
  row.innerHTML = `
    <div class="t-index"><span class="t-num"></span><span class="t-eq" aria-hidden="true"><i></i><i></i><i></i></span></div>
    <div class="t-art"></div>
    <div class="t-main">
      <div class="t-title"></div>
      <div class="t-sub"></div>
    </div>
    <div class="t-album"></div>
    <div class="t-quality"></div>
    <div class="t-dur"></div>
    <div class="t-actions">
      <input type="checkbox" class="t-select" data-act="select" title="选择" aria-label="选择曲目">
      <button class="t-act" data-act="play-next" title="${queueAddLabel()}" aria-label="${queueAddLabel()}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-skip-next"/></svg>
      </button>
      <button class="t-act" data-act="menu" title="更多" aria-label="更多操作">
        <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-more"/></svg>
      </button>
    </div>`;
  row.querySelector('.t-title').textContent = track.title;
  const sub = [track.artist].filter(Boolean).join(' · ');
  row.querySelector('.t-sub').textContent = sub || '未知艺术家';
  row.querySelector('.t-album').textContent = track.album || '—';
  const q = qualityLabel(track);
  if (q) row.querySelector('.t-quality').textContent = q;
  row.querySelector('.t-dur').textContent = fmt(track.duration_ms);

  // 收藏红心。本地曲目行的 source 恒为 local，ref_id 就是曲目 id。
  if (window.Favorites) {
    window.Favorites.attachHeart(row.querySelector('.t-actions'), {
      kind: 'track',
      source: 'local',
      ref_id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration_ms: track.duration_ms,
    });
  }

  row.addEventListener('click', (e) => {
    const select = e.target.closest('.t-select');
    if (select) { e.stopPropagation(); toggleSelect(track.id, select.checked); return; }
    const act = e.target.closest('.t-act');
    if (act) {
      e.stopPropagation();
      // 红心按钮自带 handler（含 stopPropagation），这里只是双保险：
      // 万一它回滚到行处理，也不该变成「插入下一首」。
      if (act.dataset.act === 'fav') return;
      if (act.dataset.act === 'menu') openContextMenu(track, act);
      else queueAddTrack(track.id);
      return;
    }
    playFromList(track.id);
  });
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playFromList(track.id); }
  });
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextMenu(track, row, e); });
  return row;
}

function updateTrackRow(row, track, index) {
  const active = track.id === state.snapshot.track_id;
  row.classList.toggle('active', active);
  row.classList.toggle('playing', active && state.snapshot.playing);
  row.querySelector('.t-num').textContent = index + 1;
  const select = row.querySelector('.t-select');
  if (select) select.checked = state.selected.has(track.id);
  // loading="lazy" 已经把"只为可见行加载"交给浏览器了，不再需要手写观察器。
  paintArt(row, track.has_cover ? transport.coverUrl(track.id) : null);
}

// ---------------------------------------------------------------------------
// 曲库多选与批量操作
// ---------------------------------------------------------------------------

function toggleSelect(id, on) {
  if (on) state.selected.add(id); else state.selected.delete(id);
  renderBatchBar();
}

function renderBatchBar() {
  if (!ui.libBatchBar) return;
  const n = state.selected.size;
  ui.libBatchBar.hidden = n === 0;
  ui.libBatchCount.textContent = `已选 ${n} 首`;
}

function clearSelection() {
  state.selected.clear();
  for (const row of state.rows.values()) {
    const select = row.querySelector('.t-select');
    if (select) select.checked = false;
  }
  renderBatchBar();
}

// 行内封面统一走 <img loading="lazy">：可见性、缓存、解码全由浏览器负责。
//
// alt 留空是刻意的——封面在这一行里是装饰，标题与艺术家两字已经完整说明了
// 这是什么，读屏软件再播报一遍图片只会增加噪音。
//
// 用 dataset.src 而不是「画过一次就不再画」作幂等标记：曲库行是按 id 复用
// 的，重新扫描后同一行可能从无封面变成有封面，只认「画过」就永远停在占位图。
function paintArt(row, url) {
  const art = row.querySelector('.t-art');
  if (!art || art.dataset.src === String(url)) return;
  art.dataset.src = String(url);
  art.replaceChildren();
  art.classList.remove('is-loaded', 'is-missing');
  // 占位按曲目 id 稳定取一个色相（--ph）：同一行每次重排都是同一个颜色，
  // 不会跳色；有色的空占位读作「这个音源本来就没有封面」，而不是「图挂了」。
  const markMissing = () => {
    art.classList.add('is-missing');
    const host = art.closest('[data-id]');
    const seed = (host && host.dataset.id) || String(url);
    let h = 0;
    for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 360;
    art.style.setProperty('--ph', String(h));
  };
  if (!url) { markMissing(); return; }
  const resolved = remoteCover(url);
  if (resolved === null) {
    // 插件形态 + 远程地址且缓存未命中：先占位，代理落地后按 data URL 重画这一格。
    // dataset.src 记的是逻辑 URL，重画传的是 data URL，两者不同，所以幂等标记不会
    // 挡掉这次重画；同一行被复用时逻辑 URL 没变也不会重复发请求（缓存/在途去重）。
    markMissing();
    remoteCoverSlot(url, (u) => paintArt(row, u));
    return;
  }
  const img = document.createElement('img');
  img.className = 't-art-img';
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  // 404 / 防盗链 / 断网：把图片本体摘掉，露出 .t-art 自己的占位图，
  // 而不是留一个浏览器默认的回形针图标或一块空白。
  img.onerror = () => { markMissing(); img.remove(); };
  img.onload = () => art.classList.add('is-loaded');
  art.appendChild(img);
  img.src = resolved;
}

// ---------------------------------------------------------------------------
// 播放
// ---------------------------------------------------------------------------

async function playFromList(id) {
  const ticket = PlaybackIntent.begin();
  try {
    const list = await libraryTrackIds();
    if (!PlaybackIntent.current(ticket)) return;
    if (!list.includes(id)) throw new Error('曲库已更新，请刷新后重试');
    await playTrack(id, list);
  } catch (err) {
    if (PlaybackIntent.current(ticket)) toast(errText('播放列表读取失败', err), 'error');
  }
}

async function playTrack(id, queue) {
  let ticket = PlaybackIntent.begin();
  let submittedRevision = PlaybackIntent.queueRevision;
  const track = state.byId.get(id);
  const label = track ? track.title : '曲目';
  // 参考实现在 load 之后会轮询直到 is_loading 落定；这里后端 load 是带回执的，
  // 只需把"正在载入"这段时间显式化，而不是让界面静默几百毫秒。
  state.loadingTrack = id;
  ui.playpause.classList.add('is-loading');
  try {
    const pending = transport.post('/v1/player/load', { track_id: id, queue: queue && queue.length ? queue : [id] });
    ticket = PlaybackIntent.generation;
    submittedRevision = PlaybackIntent.queueRevision;
    state.loadingTrackIntent = ticket;
    await pending;
    // Pausing cancels preparation, but does not undo an already submitted queue.
    // Read the authoritative queue rather than replay a stale request body.
    if (submittedRevision === PlaybackIntent.queueRevision) await restoreQueue();
  } catch (err) {
    if (PlaybackIntent.current(ticket)) toast(errText(`无法播放《${label}》`, err), 'error');
    if (submittedRevision === PlaybackIntent.queueRevision) await restoreQueue();
  } finally {
    if (state.loadingTrackIntent === ticket) {
      state.loadingTrack = null;
      ui.playpause.classList.remove('is-loading');
    }
  }
}

function setStateQueue(queue, currentId) {
  state.queue = queue || [];
  // online.js 热切换音质时按 id 读当前队列下标；与 state.queue 同数组，
  // 单独留一个语义化别名供跨模块读取（renderQueue 等仍只用 state.queue）。
  state.queueIds = state.queue;
  state.queueIndex = currentId ? state.queue.indexOf(currentId) : -1;
  renderQueue();
}

/// 「加入队列」的默认行为（folia 的 queue_add_behavior）：
/// next = 插到当前曲目之后（旧行为），end = 加到队列末尾。
/// 只管列表行的快捷按钮与右键菜单那条动作；点曲名本身总是立即播放。
function queueAddBehavior() {
  return state.settings.queue_add_behavior === 'end' ? 'end' : 'next';
}

function queueAddLabel() {
  return queueAddBehavior() === 'end' ? '加入队列末尾' : '下一首播放';
}

async function queueAddTrack(id) {
  if (queueAddBehavior() === 'end') return appendToQueue(id);
  return insertNext(id);
}

async function insertNext(id) {
  const list = state.queue.length ? state.queue.slice() : [id];
  const at = state.queueIndex >= 0 ? state.queueIndex + 1 : list.length;
  if (state.queue.length) list.splice(at, 0, id);
  // resume=true 让后端保留当前播放位置，插入队列不会打断正在放的歌。
  await applyQueue(list, true);
  toast('已插入到下一首');
}

/// 追加到队尾。队列接口是整体替换（PUT /v1/player/queue），追加 = 取回
/// 当前队列拼上新曲目再整体写回，与歌单「加入队列」是同一套路。
async function appendToQueue(id) {
  const list = state.queue.slice();
  list.push(id);
  await applyQueue(list, true);
  toast('已加入队列末尾');
}

async function applyQueue(list, opts) {
  const resume = opts !== false;
  const current = state.snapshot.track_id;
  const index = current ? Math.max(0, list.indexOf(current)) : null;
  state.queue = list;
  // 与 setStateQueue 保持同一别名：队列重排后音质热切换读到的下标才不旧。
  state.queueIds = state.queue;
  state.queueIndex = index === null ? -1 : index;
  try {
    // 只替换队列与游标，不碰 audio actor：正在播放的曲目不会被打断。
    await transport.put('/v1/player/queue', { queue: list, index, resume });
  } catch (err) {
    if (!resume || !current) { renderQueue(); throw err; }
    // 旧版后端没有这个端点时退回 load，代价是当前曲目从头开始 —— 明确告知。
    await transport.post('/v1/player/load', { track_id: current, queue: list });
    toast('队列已更新（当前曲目从头播放）');
  }
  renderQueue();
}

// 队列原先只存在于服务端内存且没有查询端点，刷新页面即丢失。补了 GET 之后
// 这里能在重连 / 刷新后把它取回来；没有该端点的旧版静默降级。
let queueReadEpoch = 0;
// 启动自动播放只认「会话恢复后的第一拍」，一次机会，用掉即熄火。
let bootAutoPlayArmed = true;
async function restoreQueue() {
  const epoch = ++queueReadEpoch;
  const revision = PlaybackIntent.queueRevision;
  try {
    const data = await transport.get('/v1/player/queue');
    if (epoch !== queueReadEpoch || revision !== PlaybackIntent.queueRevision) return;
    if (data && Array.isArray(data.queue)) {
      state.queue = data.queue;
      // 刷新恢复后同样同步别名，否则 online.js 热切换仍读到旧队列。
      state.queueIds = state.queue;
      state.queueIndex = data.index ?? state.queue.indexOf(state.snapshot.track_id);
      renderQueue();
      // 会话恢复（服务端重启后）：快照还没有曲目——音频惰性起播，但游标已
      // 指向上次听到的那首。把它填进控制条并高亮队列行，按播放键即接续。
      const restoredId = !state.snapshot.track_id
        && state.queueIndex >= 0 ? state.queue[state.queueIndex] : null;
      if (restoredId) {
        loadNowPlaying(restoredId);
        syncQueuePlaying({ track_id: restoredId, playing: false }, true);
        if (bootAutoPlayArmed) {
          bootAutoPlayArmed = false;
          // 设置与队列并行加载，这里再取一次设置才有可靠值；只发生一次。
          transport.get('/v1/settings').then((s) => {
            if (s && s.startup_auto_play) {
              // 播放落点（开始播放时自动进入）不跟自动恢复走：那是手动
              // 开始播放的行为，启动恢复不算（与 folia 语义一致）。
              state.entryArmed = false;
              transport.post('/v1/player/play', {}).catch(() => {});
            }
          }).catch(() => {});
        }
      } else if (bootAutoPlayArmed) {
        // 快照已有曲目（页面刷新、服务未重启）：不存在恢复语义，直接熄火。
        bootAutoPlayArmed = false;
      }
    }
  } catch { /* 端点不存在时忽略 */ }
}

// 命令刚下发、后端还没处理完时到达的快照是旧的：照它渲染会让播放键闪回。
// 参考实现用「切换态标记 + 800ms 窗口」解决同一问题。
function staleCommand(snap) {
  return state.commandAt > 0
    && PlaybackIntent.current(state.commandIntent)
    && (state.commandPending || Date.now() - state.commandAt < 800)
    && snap.playing !== state.expectedPlaying;
}

function applySnapshot(snap) {
  const previous = state.snapshot.track_id;
  const wasPlaying = state.snapshot.playing === true;
  if (previous !== snap.track_id && state.seeking) cancelSeek();
  if (staleCommand(snap)) snap = { ...snap, playing: state.expectedPlaying,
    position_ms: state.stopped ? 0 : snap.position_ms };
  else if (state.commandAt && !state.commandPending) state.commandAt = 0;
  if (volumeTarget !== null) snap = { ...snap, volume: volumeTarget };
  state.snapshot = snap;
  ui.playpause.classList.toggle('is-playing', snap.playing);
  ui.playpause.setAttribute('aria-label', snap.playing ? '暂停' : '播放');
  // 胶囊上的小标签跟着播放态走：停着的时候还写「正在播放」是撒谎。
  ui.capsuleLabel.textContent = snap.playing ? '正在播放' : '已暂停';
  ui.mode.textContent = state.modeLabel[snap.mode] || snap.mode;
  document.title = state.current ? `${state.current.title} · hertz-studio` : 'hertz-studio';
  renderPlaybackProgress(snap);
  syncVolume(snap.volume);

  if (snap.track_id && snap.track_id !== previous) {
    // 新曲起播：上一首留下的在线错误条（如手动失败后的重试条）立即收口，
    // 不能让它带着旧下标盖在新曲上。
    if (window.Online && window.Online.hideOnlineError) window.Online.hideOnlineError();
    loadNowPlaying(snap.track_id);
    // Stage 不暴露当前 track_id（私有变量），换曲由这里显式通知电影相机。
    if (window.StageCinema) StageCinema.onTrack(snap.track_id);
    // 换曲不改队列内容，但两处高亮都要跟着快照走：全屏浮层重推一份，
    // 队列页就地改类名并把当前行带回可视区。
    pushStageQueue();
    syncQueuePlaying(snap, true);
    // 皮肤层的换歌跟随（清风海报墙的「换歌时自动聚焦」）从这个事件取时刻。
    document.dispatchEvent(new CustomEvent('playback:track', { detail: { track_id: snap.track_id } }));
  }
  syncStageIdle();
  updateRowActiveState(snap);
  // 舞台拿走播放状态：它自己有本地时钟补帧，不依赖推送频率。
  if (Stage) Stage.setSnapshot(snap);
  if (window.StageCinema) StageCinema.onSnapshot(snap);
  // 播放控制弹窗同步播放态 / 时间 / 进度
  syncNpSnapshot(snap);
  syncMediaSession();

  // 播放落点（folia 的 playback_entry_view）：手动开始播放时按设置跳进
  // 声场或海报墙。只认「停着 → 在放」的翻转，且要先用一次「停着」武装 ——
  // 启动时快照直接是 playing=true（恢复会话），那样不该弹。自动接力期间
  // playing 连续为 true，天然不触发。
  if (!snap.playing) {
    state.entryArmed = true;
  } else if (state.entryArmed && !wasPlaying) {
    state.entryArmed = false;
    const entry = state.settings.playback_entry;
    if (entry === 'stage') {
      try {
        if (window.Stage3D) Stage3D.open(Stage3D.stageId ? Stage3D.stageId() : undefined);
      } catch (e) { try { Stage3D.open(); } catch (e2) { /* 舞台不可用就当没设 */ } }
    } else if (entry === 'wall') {
      // 墙是清风皮肤的地盘：广播意图，皮肤在就开、不在就当不跳转。
      document.dispatchEvent(new CustomEvent('playback:entry-wall'));
    }
  }
}

// 「自然播完」是权威事件：此刻服务端播放必然已经停下。正常情况下紧随其后的
// state 帧会把 playing 置回 false，但这依赖 WS 帧按时到达——接力失败停在
// 曲尾、FM 尾部停止，或帧丢失 / 连接重连退避时，这一帧可能迟到甚至整个窗口
// 收不到，表现就是「歌停在了结尾，按钮却还是暂停图标」。
// 这里先本地落锤到停止态，再走 REST 独立通道复核一次：自动接力成功时新的
// playing=true 快照（以及这次复核）会立刻把它覆盖回去，不影响连续播放。
let endedReconcileEpoch = 0;
function reconcileEnded() {
  if (!state.snapshot.track_id) return;
  const epoch = ++endedReconcileEpoch;
  if (!staleCommand(state.snapshot)) {
    applySnapshot({ ...state.snapshot, playing: false });
  }
  transport.get('/v1/state').then((server) => {
    if (epoch !== endedReconcileEpoch) return;
    applySnapshot(server);
  }).catch(() => {});
}

function updateRowActiveState(snap) {
  for (const [id, row] of state.rows) {
    const active = id === snap.track_id;
    row.classList.toggle('active', active);
    row.classList.toggle('playing', active && snap.playing);
  }
}

async function loadNowPlaying(id) {
  const isCurrent = () => state.snapshot.track_id === id;
  // 在线试听的虚拟 id 在本地库里查不到，先回落到搜索时缓存下来的元数据
  //（缓存归 online.js 所有，通过 window.Online 访问）。
  let track = state.byId.get(id) || window.Online.getMeta(id);
  // 收藏全部播放/歌单整单等路径写入 byId 的条目可能缺 source/onlineId
  //（只有 id 本身带身份协议）。在这里统一从 id 补齐，否则 refreshLyrics
  // 会把在线曲当本地曲请求 /v1/tracks/online:.../lyrics 而 404。
  if (track && id.startsWith('online:') && (!track.source || !track.onlineId)) {
    const rest = id.slice('online:'.length);
    const at = rest.indexOf(':');
    if (at > 0) {
      track = { ...track, source: rest.slice(0, at), onlineId: rest.slice(at + 1) };
      state.byId.set(id, track);
    }
  }
  // 刷新之后在线缓存是空的，再去查本地库必然 404——这类 id 直接跳过请求，
  // 别让一个已知无解的地址污染控制台和网络面板。
  if (!track && !id.startsWith('online:')) {
    track = await transport.get(`/v1/tracks/${id}`).catch(() => null);
    if (track) state.byId.set(id, track);
  }
  // 刷新后在线缓存是空的，但队列/快照里还留着虚拟 id。
  // 用 id 反解出音源与曲目号，先给一个占位标题把界面填上，再异步补详情。
  if (!track && id.startsWith('online:')) {
    const rest = id.slice('online:'.length);
    const at = rest.indexOf(':');
    if (at > 0) {
      const base = {
        id,
        source: rest.slice(0, at),
        onlineId: rest.slice(at + 1),
        title: '在线曲目',
        artist: '正在获取信息…',
        album: '',
        duration_ms: 0,
        cover: null,
      };
      track = base;
      window.Online.meta.set(id, base);
      state.byId.set(id, base);
      transport
        .get(`/v1/online/detail?source=${encodeURIComponent(base.source)}&id=${encodeURIComponent(base.onlineId)}`)
        .then((d) => {
          if (!d) return;
          Object.assign(base, {
            title: d.title || base.title,
            artist: d.artist || '',
            album: d.album || '',
            duration_ms: d.duration_ms || 0,
            cover: window.Online.safeCoverUrl(d.cover),
          });
          if (window.Online && window.Online.remember) window.Online.remember(id, base);
          // 只在这首仍是当前曲目时重绘，避免切歌后把界面改错
          if (isCurrent() && state.current && state.current.id === id) {
            window.Online.paintNowPlaying(base, base.cover);
            if (Stage) Stage.setTrack(base, base.cover);
            syncNpTrack(base, base.cover);
            updateMediaSessionMetadata(base, base.cover);
            // 详情到了必须重推队列：3D 歌单架的占位卡（「在线曲目/正在获取
            // 信息…」，无封面）只认 pushStageQueue 喂进来的数据，不重推就
            // 永远停在占位状态——这正是「切歌单后封面不显示」的主因。
            pushStageQueue();
          }
        })
        .catch(() => {
          if (isCurrent() && state.current && state.current.id === id) {
            base.artist = '在线试听';
            window.Online.paintNowPlaying(base, null);
            pushStageQueue();
          }
        });
    }
  }
  if (!isCurrent()) return;
  state.current = track;
  if (!track) return;

  ui.nowTitle.textContent = track.title;
  ui.nowArtist.textContent = [track.artist, track.album].filter(Boolean).join(' · ');
  ui.barTitle.textContent = track.title;
  ui.barSub.textContent = [track.artist, track.album].filter(Boolean).join(' · ');

  const tech = [];
  if (track.sample_rate) tech.push(`${(track.sample_rate / 1000).toFixed(1)} kHz`);
  if (track.channels) tech.push(track.channels >= 2 ? '立体声' : '单声道');
  if (track.bitrate) tech.push(`${track.bitrate} kbps`);
  ui.nowTech.textContent = tech.join(' · ');
  ui.nowTech.hidden = tech.length === 0;

  // 本地曲目走 /v1/tracks/<id>/cover；在线曲目用音源给的远程封面地址。
  // 刷新页面后在线缓存是空的，由 online.js 补拉一次详情把封面找回来。
  let url = null;
  if (track.has_cover) {
    // 独立形态下 coverUrl 同步就有真 URL，ensureCover 恒返回 null 于是回落到它；
    // 插件形态下封面要经 invoke 取回 base64，所以这里必须等一手。
    url = (await transport.ensureCover(id)) || transport.coverUrl(id);
  } else if (track.source && track.onlineId) {
    url = window.Online.safeCoverUrl(track.cover) || await window.Online.fetchCover(track);
  } else {
    url = window.Online.safeCoverUrl(track.cover);
  }
  // 插件形态下远程封面必须先换成 data URL：一则沙箱 CSP 画不出 https 图，二则
  // 下面的 probeImage 探的是最终要画的那份——探远程地址在插件形态必然失败，封面
  // 会被当成坏图撤掉，表现正是「正在播放没有封面」。
  const remote = isRemoteCoverUrl(url) ? url : null;
  url = await resolveCover(url);
  // 远程封面可能 404 / 防盗链：加载不出来就撤掉，用占位图而不是空白
  if (url && !(await probeImage(url))) url = null;
  // 探测通过的封面回写进曲目元数据（base/byId/Online.meta 是同一个对象）：
  // pushStageQueue 重推时歌单架当前卡才能拿到封面，不用等下一次换曲。
  // 回写远程原址而不是 data URL：base64 塞进元数据会把内存与持久化一起撑爆。
  if (remote && url && !track.cover && track.source && track.onlineId) track.cover = remote;
  if (!isCurrent()) return;
  // 封面（含旋转）与取色背景交给舞台，app.js 不再直接碰 #cover。
  if (Stage) Stage.setTrack(track, url);
  // 播放控制弹窗同步曲目信息与封面
  syncNpTrack(track, url);
  // 胶囊（最小化态）同步同一份信息与封面
  syncCapsule(track, url);
  // 在线曲的标题/封面往往是异步补全的，重推一次队列让 3D 歌单架的当前卡
  // 离开「在线曲目/正在获取信息…」占位状态；本地曲数据没变，不必重推。
  if (track.source && track.onlineId) pushStageQueue();

  updateMediaSessionMetadata(track, url);
  await refreshLyrics(id, track);
}

// 拉取当前曲目的歌词文档并喂给舞台；np 弹窗的来源徽标/偏移显示同步更新。
// 导入、清除导入、调偏移之后都走这里刷新，保证三处 UI 同源。
// ---------------------------------------------------------------------------
// 歌词管线：全局时间偏移 + 逐行过滤 + 片头人员行策略（folia 的
// global_lyric_timeline_offset / lyrics_filter / lyrics_staff_policy）。
//
// 三件事都发生在「喂给舞台之前」：refreshLyrics（本地与在线通用）和
// online.js 的在线直取各自拿到原始 doc，经 stageDoc() 出一份**浅克隆**——
// 原始 doc 不动（逐曲偏移编辑器还要显示它自己的值，缓存也不被污染）。
// stage.js 的歌词读取（行 / 翻译 / 偏移）全部走 setLyrics 塞进去的这份，
// 所以改这里的产出 = 全部渲染端（逐行 / 卡拉OK / 全屏 / stanza）一起生效。
// ---------------------------------------------------------------------------

// 内置片头人员行词表：行首是制作环节词，后面跟着分隔符或直接结尾才算命中
//（「作曲 : 周杰伦」命中；「作曲家」不命中——词后面跟了别的字）。
const LYRIC_STAFF_DEFAULT = '^(?:作词|作詞|作曲|编曲|編曲|填词|填詞|改编|改編|混音|混缩|混縮|母带|母帶|监制|監製|制作人|製作人|和声|和聲|伴唱|录音|錄音|吉他|贝斯|貝斯|鼓|键盘|鍵盤|弦乐|弦樂|管乐|管樂|配器|指挥|指揮|发行|發行|出品|出版|策划|策劃|统筹|統籌|文案|视觉|視覺|插画|插畫|设计|設計|OP|SP|Lyrics?|Composed?|Arranged?|Produced?|Written\\s+by)\\s*(?:[:：/／・.．\\-—(（【\\[]\\s*\\S.*)?\\s*$';
const LYRIC_OFFSET_LIMIT = 2000;

function globalLyricOffsetMs() {
  const v = Number(state.settings.global_lyric_offset_ms);
  if (!Number.isFinite(v)) return 0;
  return Math.max(-LYRIC_OFFSET_LIMIT, Math.min(LYRIC_OFFSET_LIMIT, Math.round(v)));
}

function lyricStaffPolicy() {
  return ['keep', 'smart', 'hide'].indexOf(state.settings.lyrics_staff_policy) >= 0
    ? state.settings.lyrics_staff_policy : 'smart';
}

// 用户正则的编译缓存：按设置字符串变化重编，编译失败按没配处理（界面会给提示）。
const lyricReCache = new Map();
function lyricRe(kind, source, flags) {
  const key = kind + '\u0000' + source;
  if (lyricReCache.has(key)) return lyricReCache.get(key);
  let re = null;
  try { re = source ? new RegExp(source, flags) : null; } catch (e) { re = null; }
  if (lyricReCache.size > 8) lyricReCache.clear();
  lyricReCache.set(key, re);
  return re;
}

function stageDoc(doc) {
  if (!doc || !doc.lines || !doc.lines.length) return doc;
  const policy = lyricStaffPolicy();
  const sRe = policy === 'keep' ? null : lyricRe('staff', String(state.settings.lyrics_staff_pattern || LYRIC_STAFF_DEFAULT), 'i');
  const fRe = state.settings.lyrics_filter_enabled === true
    ? lyricRe('filter', String(state.settings.lyrics_filter_pattern || ''), '')
    : null;

  let lines = doc.lines;
  let translation = Array.isArray(doc.translation) ? doc.translation : null;

  if (sRe) {
    const drop = new Set();
    if (policy === 'hide') {
      lines.forEach((l, i) => { if (sRe.test(String(l.text || ''))) drop.add(i); });
    } else {
      // smart：只吃片头段——从头扫到第一条「非空且不命中」的行为止，
      // 中段（间奏后报制作名单那种）保留。
      for (let i = 0; i < lines.length; i += 1) {
        const t = String(lines[i].text || '');
        if (!t.trim()) continue;
        if (!sRe.test(t)) break;
        drop.add(i);
      }
    }
    if (drop.size) {
      lines = lines.filter((_, i) => !drop.has(i));
      if (translation) translation = translation.filter((_, i) => !drop.has(i));
    }
  }

  if (fRe) {
    const kept = [];
    const keptT = translation ? [] : null;
    for (let i = 0; i < lines.length; i += 1) {
      if (fRe.test(String(lines[i].text || ''))) continue;
      kept.push(lines[i]);
      if (keptT) keptT.push(translation[i]);
    }
    lines = kept;
    if (keptT) translation = keptT;
  }

  const offset = (doc.user_offset_ms || 0) + globalLyricOffsetMs();
  if (lines === doc.lines && translation === (Array.isArray(doc.translation) ? doc.translation : null)
    && offset === (doc.user_offset_ms || 0)) return doc;
  const out = { ...doc, lines, user_offset_ms: offset };
  if (translation) out.translation = translation;
  return out;
}

// online.js 的在线直取路径与 refreshLyrics 走同一个出口。
window.HertzLyrics = { stageDoc };

// 歌词设置区：回填 + 保存。保存后立即重喂当前曲——管线在喂舞台前读设置，
// 重喂一遍就生效，不用等下一首。
function paintLyricOffset() {
  const v = globalLyricOffsetMs();
  ui.setLyricOffsetValue.textContent = (v > 0 ? '+' : '') + v + 'ms';
}

function paintPatternNotes() {
  if (!ui.setLyricStaffNote) return;
  const staffSrc = String(state.settings.lyrics_staff_pattern || '');
  if (staffSrc && !lyricRe('staff', staffSrc, 'i')) {
    ui.setLyricStaffNote.hidden = false;
    ui.setLyricStaffNote.textContent = '这条正则编译不了，人员行暂时按内置词表匹配';
  } else {
    ui.setLyricStaffNote.hidden = true;
  }
  const filterSrc = String(state.settings.lyrics_filter_pattern || '');
  if (state.settings.lyrics_filter_enabled === true && filterSrc && !lyricRe('filter', filterSrc, '')) {
    ui.setLyricFilterNote.hidden = false;
    ui.setLyricFilterNote.textContent = '这条正则编译不了，逐行过滤暂时不生效';
  } else {
    ui.setLyricFilterNote.hidden = true;
  }
}

function paintLyricSettings() {
  if (!ui.setLyricStaff) return;
  ui.setLyricStaff.value = lyricStaffPolicy();
  ui.setLyricStaffPattern.value = state.settings.lyrics_staff_pattern || '';
  ui.setLyricFilterOn.checked = state.settings.lyrics_filter_enabled === true;
  ui.setLyricFilterPattern.value = state.settings.lyrics_filter_pattern || '';
  paintLyricOffset();
  paintPatternNotes();
}

async function saveLyricSettings(patch) {
  Object.assign(state.settings, patch);
  paintLyricSettings();
  applyMotionSurfaces();
  transport.put('/v1/settings', patch).catch(() => {});
  const id = state.current && state.current.id;
  if (id && state.snapshot.track_id === id) await refreshLyrics(id, state.current).catch(() => {});
}

// ---------------------------------------------------------------------------
// 导航可见性：歌单/电台/收藏三块可整块关掉（「每日推荐」由 daily-view.js
// 自管）。本地曲库与播放队列始终显示，作为退回锚点——不然全关了会没有
// 地方可去。正停在关掉的分区里时退回本地曲库。
// ---------------------------------------------------------------------------

const NAV_TOGGLE_VIEWS = [
  ['playlists', 'setNavPlaylists', 'nav_visible_playlists'],
  ['online', 'setNavOnline', 'nav_visible_online'],
  ['favorites', 'setNavFavorites', 'nav_visible_favorites'],
];

// ---------------------------------------------------------------------------
// 动效分面降级（folia 的 reduce_motion_surfaces）：全局「减少动效」之外的单项
// 开关。面名写进 body[data-rm]（空格分隔），各面的 CSS 在自己文件里认领 token
// —— style.css 管界面微动效、theme-studio.css 管背景纹理、stanza.css 管歌词
// 排版、skin.qingfeng.css 管海报墙。canvas 舞台不归 CSS 管，仍由全局开关与
// 渲染模式控制。
// ---------------------------------------------------------------------------

const MOTION_SURFACES = [
  ['setRmBg', 'reduce_motion_bg', 'bg'],
  ['setRmLyrics', 'reduce_motion_lyrics', 'lyrics'],
  ['setRmUi', 'reduce_motion_ui', 'ui'],
  ['setRmWall', 'reduce_motion_wall', 'wall'],
];

function applyMotionSurfaces() {
  const tokens = MOTION_SURFACES
    .filter(([, settingKey]) => state.settings[settingKey] === true)
    .map(([, , token]) => token);
  if (tokens.length) document.body.dataset.rm = tokens.join(' ');
  else delete document.body.dataset.rm;
}

function applyNavVisibility() {
  let hidCurrent = false;
  for (const [view, uiKey, settingKey] of NAV_TOGGLE_VIEWS) {
    const visible = state.settings[settingKey] !== false;
    const item = document.querySelector(`.rail-item[data-view="${view}"]`);
    if (item) item.hidden = !visible;
    if (ui[uiKey]) ui[uiKey].checked = visible;
    if (!visible && state.view === view) hidCurrent = true;
  }
  if (hidCurrent && state.view !== 'library') setView('library');
  // 皮肤层（清风的胶囊主菜单等）跟着同步；没有监听方时是空投事件。
  document.dispatchEvent(new CustomEvent('nav:changed'));
}

async function refreshLyrics(id, track) {
  const doc = await (track.source && track.onlineId
    ? window.Online.loadLyricDoc(track)
    : transport.get(`/v1/tracks/${id}/lyrics`).catch(() => null));
  const staged = stageDoc(doc);
  if (Stage) Stage.setLyrics(staged && staged.lines && staged.lines.length ? staged : null);
  syncNpLyrics(id, doc);
  return doc;
}

// np 弹窗歌词行：来源徽标 + 用户偏移 + 清除导入入口。
// 在线曲目歌词来自平台接口，没有导入/偏移语义，只显示来源。
function syncNpLyrics(id, doc) {
  if (!isNpOpen() || !np.modal || !state.current || state.current.id !== id) return;
  const online = id.startsWith('online:');
  const sourceText = online
    ? '在线'
    : ({ imported: '已导入', embedded: '内嵌', sidecar: '同名 .lrc' }[doc && doc.source] || '无歌词');
  np.lyricSource.textContent = sourceText;
  np.lyricImport.hidden = online;
  np.lyricClear.hidden = online || !doc || doc.source !== 'imported';
  np.lyricOffset.hidden = online;
  np.lyricOffsetMs = online || !doc ? 0 : (doc.user_offset_ms || 0);
  np.lyricOffsetValue.textContent = `${np.lyricOffsetMs > 0 ? '+' : ''}${(np.lyricOffsetMs / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// 歌词与舞台
//
// 渲染（逐行 / 卡拉OK / 全屏三种排版）、封面转盘、取色背景、律动环都在
// stage.js 里。这里只做两件事：把服务端数据喂进去，把舞台发回来的「意图」
// 接到既有的播放逻辑上。意图不是第二套控制实现——seek/toggle/prev/next 走的
// 还是 seekTo / togglePlay / 那几个 REST 端点。
// ---------------------------------------------------------------------------

function initStage() {
  if (!Stage) { console.warn('stage.js 未加载，歌词与舞台效果不可用'); return; }
  // 主循环与粒子层直接初始化：旧页背景子系统（GL 宿主/粒子封面/星河）已
  // 随全屏歌词页摘除，Stage3D 与创意舞台各自在模块内自举。
  Stage.init();
  if (window.StageParticles) window.StageParticles.init();
  if (window.Shelf) initShelf();
  document.addEventListener('stage:control', onStageControl);
}

let stageSettingsWrite = Promise.resolve();

function onStageControl(e) {
  const d = e.detail || {};
  switch (d.action) {
    case 'seek': seekTo(d.value); break;
    case 'toggle': togglePlay(); break;
    case 'prev': post('/v1/player/previous'); break;
    case 'next': post('/v1/player/next'); break;
    case 'volume':
      ui.volume.value = String(Math.max(0, Math.min(100, (Number(d.value) || 0) * 100)));
      setVolumeFromInput();
      break;
    case 'lyricOffset': {
      // stage3d 侧已做乐观暂存（连点不塌缩），这里只负责落库与回填；
      // 在线曲目没有偏移语义，与 np 弹窗 shiftLyricOffset 同规拦截。
      const id = state.current && state.current.id;
      if (!id || String(id).startsWith('online:')) break;
      const offset_ms = Math.max(-60000, Math.min(60000, Number(d.value) || 0));
      transport.put(`/v1/tracks/${encodeURIComponent(id)}/lyrics/offset`, { offset_ms })
        .then(() => { if (state.current && state.current.id === id) refreshLyrics(id, state.current); })
        .catch((err) => {
          toast('保存歌词偏移失败', 'error');
          // 通知 stage3d 回清该曲的乐观暂存，标签回到服务端值（仍在该曲时才生效）。
          document.dispatchEvent(new CustomEvent('stanza:offset-failed', { detail: { id: id } }));
        });
      break;
    }
    case 'stage3d':
      markSettingsDirty();
      state.settings.stage3d = d.value;
      stageSettingsWrite = stageSettingsWrite.then(() => transport.put('/v1/settings', { stage3d: d.value }))
        .catch(() => toast('舞台设置暂未保存', 'error'));
      break;
    case 'view': setView(d.value); break;
    case 'queue-play':
      // 与队列视图同规：在线试听的虚拟 id 已失效，load 查不到。
      if (String(d.value).startsWith('online:')) { toast('在线曲目已失效，请从歌单或收藏重新点播', 'error'); break; }
      playTrack(String(d.value), state.queue.slice());
      break;
    case 'shelf-play': {
      // 3D 歌单架点卡跳播：本地曲直接走 playTrack；在线曲队列面板的
      // queue-play 走不通（虚拟 id），用队列里缓存的整盘元数据重组一次
      // Online.playAll，保持歌单架的队列顺序不塌。
      const sid = String(d.value);
      if (sid.startsWith('online:')) {
        const metas = state.queue
          .map((qid) => state.byId.get(qid) || (window.Online && window.Online.getMeta(qid)))
          .filter(Boolean);
        const idx = metas.findIndex((m) => m.id === sid);
        if (idx < 0 || !window.Online || !window.Online.playAll) {
          toast('该在线曲目暂不可跳播', 'error');
          break;
        }
        const tracks = metas.map((m) => ({
          id: m.onlineId || String(m.id).split(':').slice(2).join(':'),
          source: m.source,
          title: m.title,
          artist: m.artist,
          album: m.album,
          duration_ms: m.duration_ms,
          cover: m.cover,
          ref: m.ref || {},
        }));
        window.Online.playAll(tracks, idx);
      } else {
        playTrack(sid, state.queue.slice());
      }
      break;
    }
    case 'queue-remove':
      if (d.value === state.snapshot.track_id) { toast('正在播放的曲目不能移出队列', 'error'); break; }
      applyQueue(state.queue.filter((x) => x !== d.value), true);
      break;
    default: break;
  }
}

// 远端设置回填与本地即时操作的竞态守卫。
//
// loadSettings 是异步的：GET 发出之后，用户随时可能在舞台上按下某个即时开关。
// 等响应回来时它带的是按下之前的旧值，无脑回填会把刚按下的状态反杀回去——
// 表现为「点了没反应」，可库里其实已经写对了，刷新页面才看得到。用世代号判定
// 最稳：这条 GET 发出之后只要用户动过即时开关，就以界面上的现状为准。
let settingsEpoch = 0;
function markSettingsDirty() { settingsEpoch += 1; }

// ---------------------------------------------------------------------------
// 空闲时收起「正在播放」
// ---------------------------------------------------------------------------
//
// 右侧舞台占掉 --stage-w（宽屏 460px），没有曲目在播时它只是一块写着「未在播放」
// 的空面板，白占一列。空闲时把它整列让给曲库，播放开始立刻还回来。
//
// 判据只有两条，都很保守：
//   1. 快照里没有 track_id —— 从没载入过曲目；
//   2. 用户按过「停止」且之后没再播放。
// 暂停不算空闲：曲目还在、进度还在，收起来会让歌词和进度条凭空消失。
//
// app.js 只写 body[data-stage-idle] 这一个标记，收起动作本身在 style.css 里。
// 判定和表现分开，窄屏那条「舞台变抽屉」的媒体查询就不用关心这套逻辑。

function stageIdle() {
  return !state.snapshot.track_id || state.stopped;
}

function syncStageIdle() {
  // 真的在播了，上一次「停止」就不作数——舞台该还回来。清在这里而不是散在
  // 各个调用点，是为了让"收起与否"永远只由这一处算出，调用方给什么都行。
  if (state.snapshot.playing) state.stopped = false;
  // 默认开启：设置表里没有这项（老用户、首次运行）时按「开」处理。
  const hide = state.settings.stage_idle_hide !== false && stageIdle();
  if (hide) document.body.dataset.stageIdle = '1';
  else delete document.body.dataset.stageIdle;
}

// 持久化约定：persist 只在用户真的动了一下开关时为 true，
// loadSettings 恢复状态传 false，否则每次刷新都会多写一次设置表。
function setStageIdleHide(on, persist) {
  const want = !!on;
  state.settings.stage_idle_hide = want;
  if (ui.setStageIdleHide && ui.setStageIdleHide.checked !== want) ui.setStageIdleHide.checked = want;
  syncStageIdle();
  if (persist) {
    markSettingsDirty();
    transport.put('/v1/settings', { stage_idle_hide: want }).catch(() => {});
  }
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches || state.settings.reduce_motion === true;
}

// ---------------------------------------------------------------------------
// 频谱
// ---------------------------------------------------------------------------

const spectrumCtx = ui.spectrum.getContext('2d');
let shapePending = true;

function drawSpectrum() {
  const canvas = ui.spectrum;
  const ctx = spectrumCtx;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const bands = state.spectrum.length || 64;
  const gap = 2;
  const bw = Math.max(1, w / bands - gap);
  const grad = ctx.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, '#1d9e75');
  grad.addColorStop(1, '#7f77dd');

  for (let i = 0; i < bands; i += 1) {
    const v = Math.max(0, Math.min(1, state.spectrum[i] || 0));
    // 峰值帽：缓慢回落，让静止段落也有"呼吸"而不是死条的柱子。
    state.peaks[i] = Math.max(state.peaks[i] * 0.94, v);
    const bh = Math.max(2, v * h);
    const ph = Math.max(2, state.peaks[i] * h);
    ctx.fillStyle = grad;
    ctx.fillRect(i * (bw + gap), h - bh, bw, bh);
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    ctx.fillRect(i * (bw + gap), h - ph - 2, bw, 2);
  }
  // 首帧之后按 CSS 尺寸重建画布，避免在大屏上被拉伸成糊图。
  if (shapePending) { shapePending = false; }
}

// ---------------------------------------------------------------------------
// 队列视图
// ---------------------------------------------------------------------------

// 全屏声场（Stage3D）里的播放队列浮层与队列视图同源：这里把精简后的行模型
// 推给 Stage3D，全屏内点行跳播/移出经 stage:control 意图回到同一套播放逻辑。
function pushStageQueue() {
  if (!window.Stage3D || !Stage3D.setQueue) return;
  Stage3D.setQueue(state.queue.map((id) => {
    const track = state.byId.get(id) || window.Online.getMeta(id)
      || { id, title: '未知曲目', artist: '', duration_ms: null };
    // 3D 歌单架要预载封面做切歌交叉淡化：本地曲走封面接口，在线曲用音源封面。
    let cover = null;
    if (track.has_cover) cover = transport.coverUrl(id);
    else if (window.Online && track.cover) cover = window.Online.safeCoverUrl(track.cover);
    return {
      id, title: track.title, artist: track.artist, album: track.album || '',
      duration: track.duration_ms, cover, playing: id === state.snapshot.track_id,
    };
  }));
}

/// 队列里解析不出来的行异步补详情：元数据快照只活在页面内存里，页面一重启
/// （最小化关 tab、展开重开、刷新）队列就整片退化成「未知曲目」。当前曲早有
/// 单首补详情（见 setTrack 的 online 分支），队列行此前没有——这里对缺元数据的
/// id 走同一套 /v1/online/detail（本地 id 走 /v1/tracks/:id），补完重绘一次。
/// 单飞 + 每次启动封顶三轮：源侧瞬时 502 时绝不能变成每几秒一轮的请求风暴
/// （那会把 sidecar 的桥打瘫，整页跟着空白）。
let queueMetaTimer = 0;
let queueMetaInFlight = false;
let queueMetaSweeps = 0;
const QUEUE_META_MAX_SWEEPS = 3;
function missingQueueIds() {
  return state.queue.filter((id) => !state.byId.get(id) && !(window.Online && window.Online.getMeta(id)));
}
function scheduleQueueMetaResolve(delay) {
  if (queueMetaInFlight || queueMetaSweeps >= QUEUE_META_MAX_SWEEPS || clearTimeout === undefined) return;
  if (queueMetaTimer) return;
  queueMetaTimer = setTimeout(() => {
    queueMetaTimer = 0;
    if (queueMetaInFlight || queueMetaSweeps >= QUEUE_META_MAX_SWEEPS) return;
    if (!missingQueueIds().length) return;
    queueMetaSweeps += 1;
    queueMetaInFlight = true;
    resolveQueueMissingMeta().then(() => { queueMetaInFlight = false; renderQueue(); }, () => { queueMetaInFlight = false; });
  }, delay);
}
async function resolveQueueMissingMeta() {
  const missing = missingQueueIds();
  if (!missing.length) return;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, missing.length) }, async () => {
    while (cursor < missing.length) {
      const id = missing[cursor++];
      if (id.startsWith('online:')) {
        const rest = id.slice('online:'.length);
        const at = rest.indexOf(':');
        if (at <= 0) continue;
        const source = rest.slice(0, at);
        const onlineId = rest.slice(at + 1);
        const d = await transport
          .get(`/v1/online/detail?source=${encodeURIComponent(source)}&id=${encodeURIComponent(onlineId)}`)
          .catch(() => null);
        if (!d) continue;   // 音源 offline / 曲目失效：行保留占位，徽标仍标得出来源
        const meta = {
          id, source, onlineId,
          title: d.title || '在线曲目',
          artist: d.artist || '',
          album: d.album || '',
          duration_ms: d.duration_ms || 0,
          cover: window.Online ? window.Online.safeCoverUrl(d.cover) : null,
        };
        if (window.Online) window.Online.remember(id, meta);
        state.byId.set(id, meta);
      } else {
        const t = await transport.get(`/v1/tracks/${id}`).catch(() => null);
        if (t) state.byId.set(id, t);
      }
    }
  });
  await Promise.all(workers);
  // 源侧瞬时 502（同一批 ref 隔几分钟又能解析）：失败的留给下一轮（封顶内）。
  if (missingQueueIds().length) scheduleQueueMetaResolve(5000);
}

function renderQueue() {
  pushStageQueue();
  const list = state.queue;
  ui.queueCount.textContent = `${list.length} 首`;
  ui.queueBadge.textContent = String(list.length);
  ui.queueBadge.hidden = list.length === 0;
  ui.queueList.innerHTML = '';
  if (!list.length) {
    ui.queueList.innerHTML = '<div class="hint">队列为空。点击曲目右侧的按钮可插入下一首。</div>';
    return;
  }
  // 有缺元数据的行就排一次补取（单飞 + 每次启动封顶三轮，见 scheduleQueueMetaResolve）。
  if (missingQueueIds().length) scheduleQueueMetaResolve(300);
  let dragId = null;
  list.forEach((id, index) => {
    // 队列里的曲目可能来自尚未加载的曲库分页；宁可显示占位行，也不要整行消失。
    const track = state.byId.get(id) || window.Online.getMeta(id)
      || { id, title: '未知曲目', artist: '', duration_ms: null };
    const row = document.createElement('div');
    row.className = 'q-row' + (id === state.snapshot.track_id ? ' playing' : '');
    row.draggable = true;
    row.dataset.index = String(index);
    row.dataset.trackId = id;
    row.innerHTML = `
      <span class="q-grip" aria-hidden="true"></span>
      <span class="q-num">${index + 1}</span>
      <span class="q-main"><span class="q-title"></span><span class="q-sub"></span></span>
      <span class="q-dur"></span>
      <button class="t-act" data-act="remove" aria-label="移出队列">
        <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-close"/></svg>
      </button>`;
    row.querySelector('.q-title').textContent = track.title;
    row.querySelector('.q-sub').textContent = track.artist || '未知艺术家';
    row.querySelector('.q-dur').textContent = fmt(track.duration_ms);
    if (id.startsWith('online:') && window.Online) {
      // 与歌单详情同一套平台徽标：混合队列里一眼分清本地与在线。
      // 重启后内存快照没了（行退化为「未知曲目」），源仍能从虚拟 id 里解析出来。
      const sub = row.querySelector('.q-sub');
      sub.appendChild(document.createTextNode(' '));
      sub.appendChild(window.Online.badge(track.source || id.split(':')[1]));
    }

    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="remove"]')) {
        // 正在播放的这首不允许移出，否则会打断播放。
        if (id === state.snapshot.track_id) { toast('正在播放的曲目不能移出队列', 'error'); return; }
        applyQueue(list.filter((x) => x !== id), true);
        return;
      }
      // 在线试听的虚拟 id 不在本地库里，load 会查不到；提示用户从仍支持
      // 在线点播的歌单或收藏入口重新发起播放，而不是抛一个看不懂的 404。
      if (id.startsWith('online:')) {
        toast('在线曲目已失效，请从歌单或收藏重新点播', 'error');
        return;
      }
      transport.post('/v1/player/load', { track_id: id, queue: list });
    });

    row.addEventListener('dragstart', (e) => {
      dragId = id;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
    });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); ui.queueList.querySelectorAll('.q-row').forEach((n) => n.classList.remove('drop-before')); });
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drop-before'); });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drop-before');
      if (!dragId || dragId === id) return;
      const from = list.indexOf(dragId);
      const to = list.indexOf(id);
      if (from < 0 || to < 0) return;
      const next = list.slice();
      next.splice(to, 0, next.splice(from, 1)[0]);
      applyQueue(next, true);
    });
    ui.queueList.appendChild(row);
  });
}

// 换曲不改队列内容，所以这里只改类名，不重建列表：重建会把用户的滚动位置、
// 拖拽中间态连同整段 DOM 一起丢掉。高亮本来只在 renderQueue() 里按当时的
// snapshot 算一次，自动接力/上下曲只走 applySnapshot，于是列表会一直停在
// 「上次重绘队列那一瞬间正在播的那首」——就是队列里红行不跟着换曲的原因。
// locate：把正在播放的行带回可视区，与全屏声场里的队列浮层同一套行为。
function syncQueuePlaying(snap, locate) {
  const rows = ui.queueList.querySelectorAll('.q-row');
  if (!rows.length) return;
  let current = null;
  for (const row of rows) {
    const active = row.dataset.trackId === snap.track_id;
    row.classList.toggle('playing', active);
    if (active) current = row;
  }
  // 队列页没打开时行没有布局，滚动留给进入视图时再做。
  if (locate && current && !ui.views.queue.hidden) current.scrollIntoView({ block: 'center' });
}

// ---------------------------------------------------------------------------
// 歌单
// ---------------------------------------------------------------------------

// Shelf 实例。声明在本节最前面：loadPlaylists / renamePlaylist / deletePlaylist
// 都要读它，而 initShelf 要到启动时才赋值。
let shelf = null;
let plCovers = null;          // 共享封面解析实例（shelf 与列表行共用）
let playlistMode = 'shelf';
let detailPlaylistId = null;
let detailTracks = [];        // 详情内完整曲目对象（按当前顺序）
const rowArts = new Map();    // playlistId -> 列表行封面节点

function paintRowArt(art, id) {
  const st = plCovers.state(id);
  if (st.s === 'url') {
    art.classList.add('pl-has-img');
    art.style.backgroundImage = `url("${st.url}")`;
  } else {
    art.classList.remove('pl-has-img');
    art.style.backgroundImage = '';
    art.style.backgroundColor = `hsl(${st.hue} 32% 16%)`;
  }
}

async function loadPlaylists() {
  const data = await transport.get('/v1/playlists').catch(() => ({ playlists: [] }));
  state.playlists = data.playlists || [];
  if (ui.playlistCount) ui.playlistCount.textContent = state.playlists.length
    ? `${state.playlists.length} 个歌单` : '';
  if (shelf) shelf.setItems(shelfItems());
  // 网格没有自己的数据源，它就是 shelfItems() 的另一种画法；歌单变了要重画，
  // 否则停在网格排布时新建/删除歌单看不到变化。
  if (playlistMode === 'grid') renderPlaylistGrid();
  ui.playlistList.innerHTML = '';
  rowArts.clear();
  const onlineCount = window.OnlinePlaylists ? window.OnlinePlaylists.all().length : 0;
  if (!state.playlists.length && !onlineCount) {
    ui.playlistList.innerHTML = '<div class="hint">还没有歌单，在上面新建一个；或到「在线」面板登录后同步在线歌单。</div>';
    return;
  }
  for (const p of state.playlists) {
    const el = document.createElement('div');
    el.className = 'pl-row';
    el.innerHTML = `
      <span class="pl-art" aria-hidden="true"></span>
      <span class="pl-main"><span class="pl-name"></span><span class="pl-sub"></span></span>
      <button class="t-act" data-act="open" aria-label="打开歌单">
        <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-folder"/></svg>
      </button>
      <button class="t-act" data-act="play" aria-label="播放歌单">
        <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-play"/></svg>
      </button>
      <button class="t-act" data-act="rename" aria-label="重命名">
        <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-pencil"/></svg>
      </button>
      <button class="t-act t-act-danger" data-act="delete" aria-label="删除歌单">
        <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-trash"/></svg>
      </button>`;
    el.querySelector('.pl-name').textContent = p.name;
    el.querySelector('.pl-sub').textContent = `${p.track_count} 首`;
    el.querySelector('[data-act="open"]').onclick = () => openPlaylist(p.id);
    el.querySelector('.pl-main').onclick = () => openPlaylist(p.id);
    el.querySelector('[data-act="play"]').onclick = () => playPlaylist(p.id);
    el.querySelector('[data-act="rename"]').onclick = () => renamePlaylist(p);
    el.querySelector('[data-act="delete"]').onclick = () => deletePlaylist(p);
    const art = el.querySelector('.pl-art');
    if (plCovers) paintRowArt(art, p.id);
    rowArts.set(p.id, art);
    ui.playlistList.appendChild(el);
  }
  renderOnlinePlaylistSection();
}

// 在线歌单分区：数据只存在 online-playlists.js 的 state.lists 一份，这里
// 纯渲染。按音源分组挂在本地歌单之后；点击行打开在线详情抽屉（固定浮层，
// 在任何视图上都能弹出），▶ 直接整盘播放。与在线面板网格始终同源。
//
// 分区块只属于「列表」排布（挂在 #playlist-list 末尾与本地歌单同列滚动）；
// 「歌单架」排布下在线歌单直接上架（见 onlineShelfItems），#playlist-online
// 宿主就此退役，仅保留元素避免 HTML/选择器处处跟着改。
let onlineBlockEl = null;

// 分区块只在列表排布下展示：架子模式下在线歌单已经上了架子（见
// onlineShelfItems），分区再挤在架子下面只剩几十像素，看起来像坏了。
function placeOnlineBlock() {
  if (!ui.playlistOnline) return;
  if (onlineBlockEl && onlineBlockEl.parentElement !== ui.playlistList) {
    ui.playlistList.appendChild(onlineBlockEl);
  }
  ui.playlistOnline.hidden = true;
}

function renderOnlinePlaylistSection() {
  const list = ui.playlistList;
  if (!list) return;
  const OP = window.OnlinePlaylists;
  const items = OP ? OP.all() : [];

  // 本地歌单为空时，空态提示与在线分区互补：在线歌单到达就撤掉
  // 「还没有歌单」提示；两边都空（如退出登录）时把提示补回来。
  if (!state.playlists.length) {
    const hint = list.querySelector('.hint');
    if (items.length) {
      if (hint) hint.remove();
    } else if (!hint) {
      list.innerHTML = '<div class="hint">还没有歌单，在上面新建一个；或到「在线」面板登录后同步在线歌单。</div>';
    }
  }

  // 旧块可能挂在列表或架子宿主任一处，在视图范围内摘掉重建。
  const old = document.querySelector('#view-playlists .pl-online-block');
  if (old) old.remove();
  onlineBlockEl = null;
  if (!items.length) { placeOnlineBlock(); return; }

  const block = document.createElement('div');
  block.className = 'pl-online-block';
  const groups = new Map();
  items.forEach((it) => {
    if (!groups.has(it.source)) {
      groups.set(it.source, { label: it.sourceLabel, rows: [] });
    }
    groups.get(it.source).rows.push(it);
  });

  groups.forEach((g, src) => {
    block.appendChild(Object.assign(document.createElement('hr'), { className: 'pl-online-sep' }));
    const head = document.createElement('div');
    head.className = 'pl-online-head';
    const title = document.createElement('span');
    title.textContent = g.label + ' · 在线歌单';
    head.appendChild(title);
    const count = document.createElement('span');
    count.className = 'pl-online-count';
    count.textContent = g.rows.length + ' 个';
    head.appendChild(count);
    const goto = document.createElement('button');
    goto.className = 'pl-online-goto';
    goto.type = 'button';
    goto.textContent = '去在线面板';
    goto.onclick = () => setView('online');
    head.appendChild(goto);
    // 两层界面的入口：只带这一个音源进网格层，与分组标题指的是同一个音源。
    const grid = document.createElement('button');
    grid.className = 'pl-online-goto';
    grid.type = 'button';
    grid.textContent = '网格';
    grid.onclick = () => {
      if (window.OnlinePlaylistView) window.OnlinePlaylistView.openGrid(src);
      else setView('online');
    };
    head.appendChild(grid);
    block.appendChild(head);

    g.rows.forEach((it) => block.appendChild(onlinePlaylistRow(src, it.playlist)));
  });
  onlineBlockEl = block;
  ui.playlistList.appendChild(block);
  placeOnlineBlock();
}

function onlinePlaylistRow(src, p) {
  const el = document.createElement('div');
  el.className = 'pl-row is-online';
  el.title = p.name;

  const art = document.createElement('span');
  art.className = 'pl-art';
  const cover = window.Online ? window.Online.safeCoverUrl(p.cover) : null;
  applyCoverBg(art, cover);
  if (!cover) art.classList.add('is-missing');
  el.appendChild(art);

  const main = document.createElement('span');
  main.className = 'pl-main';
  const nameLine = document.createElement('span');
  nameLine.className = 'pl-name';
  nameLine.style.display = 'flex';
  nameLine.style.alignItems = 'center';
  nameLine.style.gap = '6px';
  const nameText = document.createElement('span');
  nameText.style.minWidth = '0';
  nameText.style.overflow = 'hidden';
  nameText.style.textOverflow = 'ellipsis';
  nameText.style.whiteSpace = 'nowrap';
  nameText.textContent = (p.kind === 'liked' ? '♥ ' : '') + p.name;
  nameLine.appendChild(nameText);
  // 平台徽标与搜索结果同源同款（online.js 的 badge()），这里不再自己拼。
  const badge = window.Online ? window.Online.badge(src) : null;
  if (badge) {
    badge.classList.add('pl-online-badge');
    nameLine.appendChild(badge);
  }
  main.appendChild(nameLine);
  const sub = document.createElement('span');
  sub.className = 'pl-sub';
  sub.textContent = p.track_count + ' 首' + (p.play_count ? ' · 播放 ' + p.play_count : '');
  main.appendChild(sub);
  el.appendChild(main);

  const play = document.createElement('button');
  play.className = 't-act';
  play.setAttribute('aria-label', '播放在线歌单');
  play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-play"/></svg>';
  play.onclick = (e) => { e.stopPropagation(); window.OnlinePlaylists.play(src, p.id); };
  el.appendChild(play);

  const open = document.createElement('button');
  open.className = 't-act';
  open.setAttribute('aria-label', '打开在线歌单详情');
  open.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-folder"/></svg>';
  open.onclick = (e) => { e.stopPropagation(); openOnlinePlaylistDetail(src, p.id); };
  el.appendChild(open);

  el.onclick = () => openOnlinePlaylistDetail(src, p.id);
  return el;
}

async function renamePlaylist(p) {
  const name = await modal().prompt('重命名歌单', p.name);
  if (!name || !name.trim()) return;
  await transport.put(`/v1/playlists/${p.id}`, { name: name.trim() });
  if (shelf) shelf.invalidate(p.id);
  if (detailPlaylistId === p.id && ui.plDetailName) ui.plDetailName.textContent = name.trim();
  loadPlaylists();
  toast('已重命名');
}

async function deletePlaylist(p) {
  if (!(await modal().confirm(`删除歌单「${p.name}」？此操作不可撤销。`))) return;
  await transport.del(`/v1/playlists/${p.id}`);
  if (shelf) shelf.invalidate(p.id);
  if (detailPlaylistId === p.id) closeDetail();
  loadPlaylists();
  toast('歌单已删除');
}

// ---------------------------------------------------------------------------
// 3D 歌单架：把架子选中/动作接回播放逻辑
//
// shelf.js 不碰接口，所以这里注入两个取数函数。封面用 probeImage 先确认
// 真能加载再交给卡片，避免七张卡里有一张是浏览器的破图图标。
// ---------------------------------------------------------------------------

// 歌单浏览方式的持久化键。键名沿用改造前那个（当时只有 shelf/list 两档），
// 值是 'shelf' | 'grid' | 'list'；读到任何不认识的值都回落到 'shelf'，于是
// 旧版本写下的 'list' 原样继续有效。
const PL_VIEW_KEY = 'vmusic.playlists.mode';

// 在线歌单的架子卡 id 与在线曲目虚拟 id 同构，谁也不必猜第二套拼法。
function onlineShelfId(source, refId) { return `online:${source}:${refId}`; }

// 架子上的完整集合：本地歌单在前，各在线音源的歌单随后（顺序与在线面板
// 网格一致）。在线卡自带封面直链与音源徽标，详情栏动作按音源能力裁剪。
function onlineShelfItems() {
  const OP = window.OnlinePlaylists;
  if (!OP) return [];
  return OP.all().map((it) => ({
    id: onlineShelfId(it.source, it.playlist.id),
    name: it.playlist.name,
    track_count: it.playlist.track_count,
    coverUrl: (window.Online && window.Online.safeCoverUrl(it.playlist.cover)) || null,
    badge: it.badgeIcon,
    badgeColor: it.badgeColor,
    online: true,
    source: it.source,
    sourceLabel: it.sourceLabel,
    refId: it.playlist.id,
    kind: it.playlist.kind,
  }));
}

function shelfItems() {
  return state.playlists.concat(onlineShelfItems());
}

function initShelf() {
  if (!window.Shelf || !ui.shelf) return;

  // 共享封面解析：shelf 卡片与列表行共用同一份两跳缓存与在途请求。
  plCovers = window.PlaylistCovers.init({
    fetchTracks: async (id) => {
      const payload = await transport.get(`/v1/playlists/${id}/tracks`);
      return (payload && payload.tracks) || [];
    },
    fetchCover: async (trackId) => {
      // 曲库里的 has_cover 已经把「这首歌没有内嵌封面」说清楚了，直接返回 null，
      // 省掉一次注定 404 的请求。查不到的 id（在线曲目、还没加载的分页）
      // 才落到探测那条路上。
      const known = state.byId.get(trackId);
      if (known && !known.has_cover) return null;
      // 插件形态下封面是异步取回的 base64，先等一手再探测；独立形态 ensureCover
      // 恒为 null，回落到同步拼出的 URL。
      const url = (await transport.ensureCover(trackId)) || transport.coverUrl(trackId);
      if (!url) return null;
      // 先探一次再返回：拿不到图就明确返回 null，让卡面走占位色，
      // 而不是挂一个必然破图的 <img>。
      return (await probeImage(url)) ? url : null;
    }
  });

  shelf = Shelf.init();
  if (!shelf) return;

  document.addEventListener('shelf:action', (e) => {
    dispatchPlaylistAction((e.detail || {}).id, (e.detail || {}).action);
  });

  // 封面异步就绪：列表行与网格卡按 id 对号重画（shelf 内部已自行订阅）。
  plCovers.onChange((id) => {
    const art = rowArts.get(id);
    if (art) paintRowArt(art, id);
    const card = gridArts.get(id);
    if (card) paintGridArt(card, id);
  });

  // 启动顺序不该决定架子上有没有歌单。loadPlaylists() 只在 shelf 已经建好时
  // 才会喂它一次，而这两件事分属 initStage() 和 refreshAll() 两个阶段——一旦
  // 时序错位，表现就是「歌单列表有内容，架子却是空的」，要等到新建/删除一次
  // 歌单才亮起来。用手头已有的数据兜一次，顺序就无所谓了。
  shelf.setItems(shelfItems());
  // 封面缓存刚就位，停在网格排布时要把先前那批壁纸占位换成真封面。
  if (playlistMode === 'grid') renderPlaylistGrid();
}

// 三档浏览方式的绑定与恢复。
//
// 刻意不放进 initShelf()：架子依赖 shelf.js，而排布切换不该因为某个视觉模块
// 没加载就整个失效——那种连带失效最难排查（列表还在，按钮点不动）。
function initPlaylistViews() {
  if (ui.plViews) {
    // 每个按钮负责"切到自己"，没有整体 toggle——三档时"再点一次换下一个"
    // 会让用户猜不出顺序。
    ui.plViews.querySelectorAll('button[data-pl-view]').forEach((b) => {
      b.addEventListener('click', () => setPlaylistMode(b.dataset.plView));
    });
  }
  let saved = null;
  try { saved = localStorage.getItem(PL_VIEW_KEY); } catch (err) { /* 隐私模式 */ }
  setPlaylistMode(saved);
}

// 对某个歌单执行一个动作，分派到本地 / 在线两条链路。
//
// 歌单架（shelf.js 广播 shelf:action）、封面网格（卡上的播放按钮）、以及将来
// 任何新入口都走这里，于是"同一个歌单在三种排布下点播放"必然是同一件事——
// 而不是三处各写一遍 if/else，等某一处漏掉在线分支再回来修。
function dispatchPlaylistAction(id, action) {
  if (!id || !action) return false;
  const item = state.playlists.find((p) => p.id === id);
  if (item) {
    if (action === 'play') playPlaylist(item.id);
    else if (action === 'queue') queuePlaylistNext(item.id);
    else if (action === 'open') openPlaylist(item.id);
    else if (action === 'rename') renamePlaylist(item);
    else if (action === 'delete') deletePlaylist(item);
    else return false;
    return true;
  }
  // 在线歌单卡：没有重命名/删除这些本地动作，播放/查看走在线链路。
  const online = onlineShelfItems().find((it) => it.id === id);
  if (!online) return false;
  if (action === 'play') window.OnlinePlaylists.playRef(online.source, online.refId, online.name);
  else if (action === 'open') openOnlinePlaylistDetail(online.source, online.refId, 'arrange');
  else return false;
  return true;
}

// 三种排布共用同一份 state.playlists、同一个 Shelf 实例和同一个封面缓存：
// 换排布只是把另外两个容器藏起来，架子索引、已取到的封面、列表滚动位置都还在，
// 来回切不会重新拉一遍。persist=false 用于从详情返回时恢复显隐，不写 localStorage。
function setPlaylistMode(next, persist) {
  // 不认识的值（含旧版本可能写下的任何东西）一律回落到歌单架，不抛错。
  const want = (next === 'grid' || next === 'list') ? next : 'shelf';
  playlistMode = want;
  if (ui.shelf) ui.shelf.classList.toggle('on', want === 'shelf');
  if (ui.playlistList) ui.playlistList.hidden = want !== 'list';
  if (ui.playlistGrid) {
    ui.playlistGrid.hidden = want !== 'grid';
    // 网格是唯一需要"按需渲染"的排布：它要遍历一遍封面缓存，而架子和列表
    // 各自有更早的渲染时机。进入时才渲染，就不会为了没显示的视图做无用功。
    if (want === 'grid') renderPlaylistGrid();
  }
  if (ui.plViews) {
    ui.plViews.querySelectorAll('button[data-pl-view]').forEach((b) => {
      const on = b.dataset.plView === want;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }
  if (persist !== false) {
    try { localStorage.setItem(PL_VIEW_KEY, want); } catch (err) { /* 隐私模式 */ }
  }
  // 在线歌单分区块跟随排布搬到对应宿主（架子宿主 / 列表末尾）。
  placeOnlineBlock();
}

// 封面平铺：本地歌单与在线歌单混排成一片封面墙。
//
// 数据源与歌单架是同一个 shelfItems()，所以两边永远不会出现"架子上有、墙上没有"
// 这类错位——这也是三种排布能共用一个播放逻辑的前提。
const gridArts = new Map();   // playlistId -> 网格卡封面节点

// 没有封面时拿壁纸当素材，与主题工作室同一个来源，按 id 稳定散列。
//
// 用壁纸而不是纯色块：一片封面墙里混着几个纯色块，看起来像加载失败；壁纸至少
// 是"有内容"的，而且同一个歌单每次拿到同一张，不会刷一次换一张。
function placeholderArt(id) {
  return window.ThemeStudio ? window.ThemeStudio.artPlaceholder(id) : '';
}

// 本地歌单的网格封面：与列表行、歌单架同一套两跳缓存（plCovers）。
//
// 只给本地 id 用。在线歌单的封面是现成的 URL，走这里会拿 `online:…` 这种虚拟
// id 去问 PlaylistCovers，而它的解析链第一步就是 `GET /v1/playlists/{id}/tracks`
// ——那会打出一个必然 404 的请求，还顺手在缓存里记下一条假状态。
function paintGridArt(art, id) {
  const st = plCovers ? plCovers.state(id) : null;
  if (st && st.s === 'url') {
    art.style.backgroundImage = `url("${st.url}")`;
    art.classList.add('has-art');
    return;
  }
  art.classList.remove('has-art');
  art.style.backgroundImage = placeholderArt(id);
}

function renderPlaylistGrid() {
  const host = ui.playlistGrid;
  if (!host) return;
  host.innerHTML = '';
  gridArts.clear();

  const items = shelfItems();
  if (!items.length) {
    host.innerHTML = '<div class="hint">还没有歌单，在上面新建一个；或到「在线」面板登录后同步在线歌单。</div>';
    return;
  }

  for (const it of items) {
    const card = document.createElement('div');
    card.className = 'pl-card' + (it.online ? ' is-online' : '');
    card.dataset.plId = it.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `${it.name}，${it.track_count || 0} 首`);
    card.title = it.online ? `${it.sourceLabel} · ${it.name}` : it.name;

    const art = document.createElement('div');
    art.className = 'pl-card-art';
    if (it.online) {
      // 在线卡自带封面直链（由 Online 归一化过），不走 plCovers。
      if (it.coverUrl) {
        applyCoverBg(art, it.coverUrl);
        art.classList.add('has-art');
      } else {
        art.style.backgroundImage = placeholderArt(it.id);
      }
    } else {
      paintGridArt(art, it.id);
      // 只有本地歌单的封面是异步解析出来的，需要登记等 onChange 回来重画。
      gridArts.set(it.id, art);
    }

    const face = document.createElement('div');
    face.className = 'pl-card-face';
    const play = document.createElement('button');
    play.className = 'pl-card-play';
    play.type = 'button';
    play.setAttribute('aria-label', `播放 ${it.name}`);
    play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-play"/></svg>';
    // 播放按钮的点击不该同时触发卡片的"打开"——stopPropagation 比事后判断
    // 事件来源可靠，卡片本身的 onclick 只管打开。
    play.onclick = (e) => { e.stopPropagation(); dispatchPlaylistAction(it.id, 'play'); };
    face.appendChild(play);

    if (it.badge) {
      const badge = document.createElement('span');
      if (String(it.badge).charAt(0) === '/') {
        // 平台官方 PNG 徽标：与在线面板同款同位图，统一尺寸由 CSS 钉死。
        badge.className = 'pl-card-badge is-img';
        badge.innerHTML = '<img src="' + it.badge + '" alt="" aria-hidden="true">';
      } else {
        badge.className = 'pl-card-badge';
        badge.textContent = it.badge;
        if (it.badgeColor) badge.style.color = it.badgeColor;
      }
      face.appendChild(badge);
    }
    art.appendChild(face);

    const name = document.createElement('div');
    name.className = 'pl-card-name';
    name.textContent = it.name;
    const sub = document.createElement('div');
    sub.className = 'pl-card-sub';
    sub.textContent = it.online
      ? `${it.sourceLabel} · ${it.track_count || 0} 首`
      : `${it.track_count || 0} 首`;

    card.appendChild(art);
    card.appendChild(name);
    card.appendChild(sub);
    card.onclick = () => dispatchPlaylistAction(it.id, 'open');
    // 键盘可达：封面墙是 div 拼的，Enter/Space 得自己接。
    card.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        dispatchPlaylistAction(it.id, 'open');
      }
    };
    host.appendChild(card);
  }
}

// 歌单视图的层：排布层（架子 / 列表 + 在线分区）、本地歌单详情、在线歌单
// 网格层、在线歌单详情层。
//
// 四层的显隐只写这一处。散到各模块自己 `hidden = false` 的话，「返回」迟早
// 会漏掉某一层——参考实现因此专门需要一个导航栈；这里最深只有两层，一个
// 字符串状态量就够，不为此引一套 store。
let playlistLayer = 'arrange';

function setPlaylistLayer(layer) {
  playlistLayer = layer;
  ui.plDetail.hidden = layer !== 'local-detail';
  if (ui.oplGrid) ui.oplGrid.hidden = layer !== 'online-grid';
  if (ui.oplDetail) ui.oplDetail.hidden = layer !== 'online-detail';
  if (layer === 'arrange') {
    // 排布层：交给 setPlaylistMode 恢复架子/列表/网格与在线分区宿主。
    // persist=false —— 返回不该顺手改掉用户上次选的排布偏好。
    setPlaylistMode(playlistMode, false);
    return;
  }
  ui.shelf.classList.remove('on');
  ui.playlistList.hidden = true;
  if (ui.playlistGrid) ui.playlistGrid.hidden = true;
  if (ui.playlistOnline) ui.playlistOnline.hidden = true;
}

// 在线曲目加入队列。虚拟 id 是 `online:{source}:{id}`（后端 virtual_id 是纯
// 函数，set_queue 也不校验 id），所以前端能直接构造，不必先起播一次。
// 代价：不带平台专有 ref，播放时后端按稳定 id 回落取流，音质可能非最优。
// 元数据同步进 state.byId，队列视图才有名字可显示。
function enqueueOnlineTracks(tracks) {
  const ids = [];
  for (const t of tracks) {
    const vid = `online:${t.source}:${t.id}`;
    state.byId.set(vid, {
      id: vid,
      source: t.source,
      onlineId: t.id,
      title: t.title,
      artist: t.artist,
      album: t.album,
      duration_ms: t.duration_ms,
      cover: window.Online ? window.Online.safeCoverUrl(t.cover) : null,
      vip_only: !!t.vip_only,
    });
    ids.push(vid);
  }
  // 队列接口只有整体替换，没有"追加一批"的端点：拼到尾部再整体写回。
  const list = state.queue.length ? state.queue.slice() : [];
  for (const x of ids) if (!list.includes(x)) list.push(x);
  return applyQueue(list, true).then(() => ids.length);
}

// 在线歌单详情层的唯一入口。两层界面未加载时退回抽屉，行为不倒退。
function openOnlinePlaylistDetail(src, id, from) {
  const view = window.OnlinePlaylistView;
  if (view) {
    // 切视图那一步由模块自己调宿主的 ensureVisible()：两层界面挂在歌单
    // 视图里，从在线面板卡片进来时它是隐藏的，不切就看不见。
    view.open(src, id, from || 'arrange');
    return;
  }
  window.OnlinePlaylists.open(src, id);
}

function capsOfSource(src) {
  const list = (window.Online && window.Online.sources()) || [];
  const hit = list.filter((x) => x.id === src)[0];
  return (hit && hit.caps) || [];
}

async function queuePlaylistNext(id) {
  let ids = [];
  try {
    ids = normalizeIds(await transport.get(`/v1/playlists/${id}/tracks`));
  } catch (err) {
    toast(errText('读取歌单失败', err), 'error');
    return;
  }
  if (!ids.length) { toast('这个歌单还是空的', 'error'); return; }
  // 队列接口是整体替换（PUT /v1/player/queue），没有"追加一批"的端点，
  // 所以在这里把歌单拼到当前队列尾部再整体写回去。
  const list = state.queue.length ? state.queue.slice() : [];
  for (const x of ids) if (!list.includes(x)) list.push(x);
  await applyQueue(list, true);
  toast(`已把 ${ids.length} 首加入队列`);
}

function normalizeIds(payload) {
  const raw = Array.isArray(payload) ? payload : (payload && (payload.track_ids || payload.tracks)) || [];
  return raw.map((item) => (typeof item === 'string' ? item : (item.track_id || item.id))).filter(Boolean);
}

async function playPlaylist(id, startIndex) {
  let ids = [];
  try {
    const payload = await transport.get(`/v1/playlists/${id}/tracks`);
    ids = normalizeIds(payload);
    // 歌单里的曲目可能不在当前已加载的曲库分页里；顺手入库，队列视图才有名字可显示。
    for (const t of (payload && payload.tracks) || []) state.byId.set(t.id, t);
    if (ids.length && !state.tracks.some((t) => t.id === ids[0])) {
      const known = ids.map((x) => state.byId.get(x)).filter(Boolean);
      if (known.length === ids.length) state.tracks = state.tracks.concat(known);
    }
  } catch (err) {
    // 旧版 vmusicd 只给这条路径注册了 POST（追加曲目），GET 会 405。
    // 旧 UI 用 .catch(() => []) 把这个错误吞掉，于是点歌单看起来毫无反应。
    toast(`${errText('读取歌单失败', err)}（后端缺少 GET /v1/playlists/{id}/tracks）`, 'error');
    return;
  }
  if (!ids.length) { toast('这个歌单还是空的', 'error'); return; }
  const at = Math.max(0, Math.min(startIndex || 0, ids.length - 1));
  // 重启后服务端的在线元数据暂存是空的：把歌单快照随队注入，播放历史的
  // 标题才不会退化成平台 id。
  const meta = {};
  for (const t of state.byId.values()) {
    if (t.id && t.id.startsWith('online:') && ids.includes(t.id)) {
      meta[t.id] = { title: t.title, artist: t.artist, album: t.album, cover: t.cover, duration_ms: t.duration_ms };
    }
  }
  await transport.post('/v1/player/load', {
    track_id: ids[at],
    queue: ids,
    ...(Object.keys(meta).length ? { meta } : {}),
  });
  setStateQueue(ids, ids[at]);
}

// ---------------------------------------------------------------------------
// 歌单详情：浏览曲目、从指定曲目起播、移出单曲、拖拽排序
// ---------------------------------------------------------------------------

async function openPlaylist(id) {
  detailPlaylistId = id;
  // 层显隐交给 setPlaylistLayer：本地歌单详情覆盖整个排布时，架子、列表、
  // 在线分区宿主和在线两层一并收起，closeDetail() 原路恢复。
  setPlaylistLayer('local-detail');
  try {
    await refreshDetail();
  } catch (err) {
    toast(errText('读取歌单失败', err), 'error');
    closeDetail();
  }
}

function closeDetail() {
  detailPlaylistId = null;
  detailTracks = [];
  setPlaylistLayer('arrange');
}

async function refreshDetail() {
  const id = detailPlaylistId;
  const payload = await transport.get(`/v1/playlists/${id}/tracks`);
  detailTracks = (payload && payload.tracks) || [];
  const ids = (payload && payload.track_ids) || detailTracks.map((t) => t.id);
  // tracks 可能因曲库被删而缺项：以 track_ids 为准对齐，缺的画占位行。
  const byId = new Map(detailTracks.map((t) => [t.id, t]));
  detailTracks = ids.map((tid) => byId.get(tid)
    || { id: tid, title: tid.startsWith('online:') ? '在线信息缺失，请重新添加' : '本地文件已不存在',
      artist: '', duration_ms: null, missing: true });
  renderDetailHead(id);
  renderDetailRows(id);
}

function renderDetailHead(id) {
  const p = state.playlists.find((x) => x.id === id);
  ui.plDetailName.textContent = p ? p.name : '歌单';
  ui.plDetailCount.textContent = `${detailTracks.length} 首`;
}

function renderDetailRows(id) {
  const list = ui.plDetailList;
  list.innerHTML = '';
  if (!detailTracks.length) {
    list.innerHTML = '<div class="hint">这个歌单还是空的。去曲库里右键曲目 →「加入歌单」，在线结果行也有同一颗按钮。</div>';
    return;
  }
  detailTracks.forEach((track, index) => {
    const online = track.id && track.id.startsWith('online:');
    const row = document.createElement('div');
    row.className = 'pd-row' + (track.missing ? ' is-missing' : '');
    row.dataset.index = String(index);
    row.innerHTML = `
      <span class="pd-grip" aria-hidden="true" title="拖拽排序">
        <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-grip"/></svg>
      </span>
      <span class="pd-num"></span>
      <span class="pd-art" aria-hidden="true"></span>
      <span class="pd-main"><span class="pd-title"></span><span class="pd-sub"></span></span>
      <span class="pd-dur"></span>
      <button class="t-act t-act-danger" data-act="remove" aria-label="移出歌单">
        <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-close"/></svg>
      </button>`;
    row.querySelector('.pd-num').textContent = String(index + 1);
    row.querySelector('.pd-title').textContent = track.title;
    row.querySelector('.pd-sub').textContent = track.artist || '未知艺术家';
    row.querySelector('.pd-dur').textContent = fmt(track.duration_ms);
    if (track.has_cover) {
      const art = row.querySelector('.pd-art');
      art.classList.add('pd-has-img');
      // 背景图不是 .t-art 结构，按 [data-id] 那套自动回填找不到它，所以显式登记。
      const paint = (url) => { art.style.backgroundImage = url ? `url("${url}")` : ''; };
      paint(transport.coverUrl(track.id));
      coverSlot(track.id, paint);
    } else if (online && track.cover) {
      // 在线快照行：封面是入单时存的 URL，用与在线列表同一套缩略图规则。
      const art = row.querySelector('.pd-art');
      art.classList.add('pd-has-img');
      const url = window.Online && window.Online.rowCoverUrl
        ? window.Online.rowCoverUrl(track.cover) : track.cover;
      applyCoverBg(art, url);
    }
    if (online && window.Online) {
      // 来源徽标与在线面板同一套平台图标，混合歌单里一眼分清本地与在线。
      const sub = row.querySelector('.pd-sub');
      sub.appendChild(document.createTextNode(' '));
      sub.appendChild(window.Online.badge(track.source));
    }

    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="remove"]')) { removeDetailTrack(id, track.id); return; }
      if (track.missing) { toast(track.id && track.id.startsWith('online:') ? '在线信息缺失，请重新添加这一首' : '文件已不存在，请先移出这一行', 'error'); return; }
      playPlaylist(id, index);
    });
    list.appendChild(row);
  });
}

async function removeDetailTrack(id, trackId) {
  try {
    await transport.del(`/v1/playlists/${id}/tracks/${trackId}`);
  } catch (err) {
    toast(errText('移出失败', err), 'error');
    return;
  }
  toast('已移出歌单');
  await loadPlaylists();
  if (detailPlaylistId === id) await refreshDetail();
}

// 拖拽提交：本地先按新顺序改 detailTracks，再整体回报服务端。
async function commitDetailOrder(id, from, to) {
  const next = detailTracks.slice();
  next.splice(to, 0, next.splice(from, 1)[0]);
  detailTracks = next;
  renderDetailRows(id);
  try {
    await transport.put(`/v1/playlists/${id}/tracks/order`, {
      track_ids: next.map((t) => t.id)
    });
    toast('顺序已保存');
  } catch (err) {
    toast(errText('保存顺序失败', err), 'error');
    await refreshDetail();
    return;
  }
  await loadPlaylists();
}

// 指针式拖拽：鼠标与触摸同一套路径。只抓 .pd-grip 起拖，避免和点行起播冲突。
function initDetailSortable() {
  let drag = null;

  ui.plDetailList.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest ? e.target.closest('.pd-grip') : null;
    if (!grip || !grip.classList) return;
    const row = grip.closest('.pd-row');
    if (!row) return;
    e.preventDefault();
    const rows = Array.prototype.slice.call(ui.plDetailList.querySelectorAll('.pd-row'));
    const snaps = rows.map((r) => {
      const b = r.getBoundingClientRect();
      return { row: r, top: b.top, h: b.height };
    });
    const idx = rows.indexOf(row);
    drag = { row, idx, startY: e.clientY, snaps, target: idx };
    row.classList.add('pd-dragging');
    try { row.setPointerCapture(e.pointerId); } catch (err) { /* 已被捕获 */ }
  });

  ui.plDetailList.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    drag.row.style.transform = `translateY(${dy.toFixed(1)}px)`;
    // 指针越过谁的中点，就插到谁的位置。
    let t = 0;
    for (let i = 0; i < drag.snaps.length; i += 1) {
      if (e.clientY > drag.snaps[i].top + drag.snaps[i].h / 2) t = i;
    }
    drag.target = t;
    const from = drag.idx;
    const dragH = drag.snaps[from].h;
    drag.snaps.forEach((s, i) => {
      if (i === from) return;
      let off = 0;
      if (from < t && i > from && i <= t) off = -dragH;
      else if (from > t && i >= t && i < from) off = dragH;
      s.row.style.transform = off ? `translateY(${off}px)` : '';
    });
  });

  const finish = (commit) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.row.classList.remove('pd-dragging');
    d.snaps.forEach((s) => { s.row.style.transform = ''; });
    if (commit && d.target !== d.idx && detailPlaylistId) {
      commitDetailOrder(detailPlaylistId, d.idx, d.target);
    }
  };
  ui.plDetailList.addEventListener('pointerup', () => finish(true));
  ui.plDetailList.addEventListener('pointercancel', () => finish(false));
}

// ---------------------------------------------------------------------------
// 右键菜单：把后端已有、旧 UI 没接的能力接到曲目上
// ---------------------------------------------------------------------------

function openContextMenu(track, anchor, event) {
  ui.menu.innerHTML = '';
  const items = [
    { label: '播放', run: () => playFromList(track.id) },
    { label: queueAddLabel(), run: () => queueAddTrack(track.id) },
    { label: '复制文件路径', run: () => copyText(track.path) },
    { sep: true },
    { label: '加入歌单', children: state.playlists.length
      ? state.playlists.map((p) => ({ label: p.name, run: () => addToPlaylist(p.id, track.id) }))
      : [{ label: '（暂无歌单）', disabled: true }] },
    { label: '编辑信息', run: () => editTrackInfo(track) },
    { label: '联网补全信息', run: () => completeTrackInfo(track) },
    { label: '替换封面', run: () => replaceTrackCover(track) },
    { label: '重置编辑', run: () => resetTrackEdit(track) },
  ];
  buildMenu(ui.menu, items);
  const rect = anchor.getBoundingClientRect();
  const x = event ? event.clientX : rect.right - 8;
  const y = event ? event.clientY : rect.bottom;
  showMenu(x, y);
}

function buildMenu(host, items) {
  for (const item of items) {
    if (item.sep) { const d = document.createElement('div'); d.className = 'menu-sep'; host.appendChild(d); continue; }
    const btn = document.createElement('button');
    btn.className = 'menu-item';
    btn.textContent = item.label;
    btn.disabled = Boolean(item.disabled);
    if (item.children) { btn.classList.add('has-sub'); btn.onclick = (e) => { e.stopPropagation(); openSubMenu(btn, item.children); }; }
    else btn.onclick = () => { closeMenu(); item.run(); };
    host.appendChild(btn);
  }
}

function openSubMenu(anchorBtn, children) {
  ui.menu.querySelectorAll('.menu-sub').forEach((n) => n.remove());
  const sub = document.createElement('div');
  sub.className = 'menu menu-sub';
  buildMenu(sub, children);
  anchorBtn.parentElement.appendChild(sub);
  sub.hidden = false;
}

function showMenu(x, y) {
  ui.menu.hidden = false;
  const rect = ui.menu.getBoundingClientRect();
  ui.menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  ui.menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
}

function closeMenu() { ui.menu.hidden = true; ui.menu.innerHTML = ''; }

/// 写剪贴板。
///
/// 插件 iframe 是 opaque origin，navigator.clipboard 会被浏览器直接拒（宿主只
/// 给了 allow="clipboard-write"，但那不足以让 Clipboard API 在 null origin 下
/// 工作），所以改走宿主的 copy 通道——它不需要额外权限。独立形态保持原路径。
async function writeClipboard(text) {
  if (window.hertzHost && window.hertzHost.isDbx && window.dbxPlugin) {
    await window.dbxPlugin.copy(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}

/// 存一个文本文件到磁盘。
///
/// 插件 iframe 没有 allow-downloads，`<a download>` 点了没反应（宿主代码里也
/// 记着这条：WKWebView 会取消没有下载处理器的 blob 导航），所以改走宿主的
/// saveFile——原生存盘对话框 + 宿主写盘，不需要额外权限。
///
/// 注意 SDK 把**字符串**参数当 base64 解释，所以文本必须编码成 Uint8Array
/// 走 ArrayBuffer 转移那条路，直接传字符串会得到一堆乱码字节。
async function saveTextFile(fileName, contentType, text) {
  if (window.hertzHost && window.hertzHost.isDbx && window.dbxPlugin) {
    await window.dbxPlugin.saveFile({ fileName, contentType }, new TextEncoder().encode(text));
    return;
  }
  const blob = new Blob([text], { type: contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text) {
  try { await writeClipboard(text); toast('路径已复制'); }
  catch { toast('复制失败，请手动选择', 'error'); }
}

async function addToPlaylist(playlistId, track) {
  // track 可以是纯 id（本地曲库右键），也可以是完整曲目对象（在线行带来源与
  // 快照字段）。在线身份沿用 online:<source>:<id> 协议，随单带上快照，服务端
  // 才能在重启后仍把这首歌渲染出来。
  const body = typeof track === 'string'
    ? { track_ids: [track] }
    : { tracks: [{ id: track.id, source: track.source, title: track.title,
      artist: track.artist, album: track.album, duration_ms: track.duration_ms, cover: track.cover }] };
  try {
    await transport.post(`/v1/playlists/${playlistId}/tracks`, body);
  } catch (err) {
    toast(errText('加入歌单失败', err), 'error');
    return;
  }
  loadPlaylists();
  toast('已加入歌单');
}

// 编辑信息：覆盖层字段留空 = 不改动；输入空白 = 回退扫描值。
// 不直接写音频文件标签——扫描永远以文件为准，用户编辑放在覆盖层。
let coverFileInput = null;
async function editTrackInfo(track) {
  const title = await modal().prompt(`标题（留空跳过，现：${track.title}）`, track.title);
  if (title === null) return;
  const artist = await modal().prompt(`歌手（留空跳过，现：${track.artist || '（无）'}；输入空格清除）`, track.artist || '');
  if (artist === null) return;
  const album = await modal().prompt(`专辑（留空跳过，现：${track.album || '（无)'}；输入空格清除）`, track.album || '');
  if (album === null) return;
  const body = {};
  if (title.trim() && title !== track.title) body.title = title.trim();
  if (artist.trim() !== (track.artist || '')) body.artist = artist.trim();
  if (album.trim() !== (track.album || '')) body.album = album.trim();
  if (!Object.keys(body).length) { toast('信息未改动'); return; }
  transport.post('/v1/tracks/batch-edit', { track_ids: [track.id], ...body })
    .then(() => loadTracks(true))
    .then(() => toast('信息已更新'))
    .catch((err) => toast(errText('编辑失败', err), 'error'));
}

// 联网补全：候选先行、用户点选才落地。
//
// 分两阶段（后端见 crates/hertz-studio/src/complete.rs）：
//   complete/suggest 只搜索打分、不写库；complete/apply 按选中的候选补缺。
// 单曲入口与批量入口共用下面这套——差别只在候选行的数量。

/// 候选下拉的一行文案：标题 - 歌手《专辑》· 分值 时长。
function candidateLabel(c) {
  const bits = [c.title || c.id];
  if (c.artist) bits.push(`- ${c.artist}`);
  if (c.album) bits.push(`《${c.album}》`);
  bits.push(`· ${Math.round(c.score || 0)} 分`);
  if (c.duration_ms) bits.push(fmt(c.duration_ms));
  return bits.join(' ');
}

/// suggest 结果 → 候选挑选的一行。默认选中分数最高的候选，末项是「不采纳」
/// （记下决定，之后不再自动匹配这首）。
function completionRow(result) {
  const options = (result.candidates || []).map((c) => ({
    value: c.id,
    label: candidateLabel(c),
  }));
  options.push({ value: '', label: '不采纳（记住：以后不再自动匹配这首）' });
  const missing = result.missing || {};
  const waiting = [];
  if (missing.album) waiting.push('专辑');
  if (missing.cover) waiting.push('封面');
  if (missing.lyrics) waiting.push('歌词');
  return {
    key: result.track_id,
    label: `${result.title || result.track_id}${result.artist ? ' - ' + result.artist : ''}`,
    sublabel: waiting.length ? `待补：${waiting.join('、')}` : '信息已齐全',
    options,
    value: (result.candidates && result.candidates[0] && result.candidates[0].id) || '',
  };
}

/// 弹出候选挑选（dialogs.js 的 pick）。取消返回 null。
async function pickCompletions(rows, message) {
  const dlg = modal();
  if (typeof dlg.pick !== 'function') {
    toast('当前环境不支持候选挑选，无法补全', 'error');
    return null;
  }
  return dlg.pick({ title: '在线补全：选择匹配', message, confirmLabel: '应用选择', rows });
}

/// 逐曲落地（串行，上游压力可控）。signal 是协作式取消：每曲开始前看一眼，
/// 已发出的那一曲等它自己收尾。返回统计。
async function applyCompletions(choices, signal, onProgress) {
  const stats = { applied: 0, skipped: 0, failed: 0, albums: 0, covers: 0, lyrics: 0 };
  for (let i = 0; i < choices.length; i++) {
    if (signal && signal.aborted) break;
    if (onProgress) onProgress(i + 1, choices.length);
    const choice = choices[i];
    try {
      const res = await transport.post('/v1/tracks/complete/apply', {
        track_id: choice.key,
        candidate_id: choice.value || null,
      }, { signal });
      if (res.status === 'applied') {
        stats.applied++;
        if (res.filled && res.filled.album) stats.albums++;
        if (res.filled && res.filled.cover) stats.covers++;
        if (res.filled && res.filled.lyrics) stats.lyrics++;
      } else {
        stats.skipped++;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') break;
      stats.failed++;
      console.warn('[hertz] 补全落地失败', choice.key, err);
    }
  }
  return stats;
}

function completionSummary(stats) {
  const parts = [];
  if (stats.applied) parts.push(`已补 ${stats.applied} 首`);
  if (stats.skipped) parts.push(`不匹配 ${stats.skipped} 首`);
  if (stats.failed) parts.push(`失败 ${stats.failed} 首`);
  const fills = [];
  if (stats.albums) fills.push(`${stats.albums} 个专辑`);
  if (stats.covers) fills.push(`${stats.covers} 张封面`);
  if (stats.lyrics) fills.push(`${stats.lyrics} 份歌词`);
  if (!parts.length) return '没有需要落地的选择';
  return parts.join('、') + (fills.length ? `，补齐了${fills.join('、')}` : '');
}

// 联网补全单曲：右键菜单入口（folia 的 LocalSongMetadataMatchDialog 的等价物）。
// 候选先摆出来，用户点了才写库。
async function completeTrackInfo(track) {
  toast(`正在为《${track.title}》匹配在线信息…`);
  try {
    const res = await transport.post('/v1/tracks/complete/suggest', { track_ids: [track.id] });
    const r = (res.results && res.results[0]) || {};
    if (!r.candidates || !r.candidates.length) {
      toast(r.status === 'skipped'
        ? (r.reason || '已跳过这首')
        : '没有找到足够相似的在线匹配（标题需命中且总分达标）');
      return;
    }
    const choices = await pickCompletions(
      [completionRow(r)],
      '默认选中分数最高的候选；选「不采纳」会记住这个决定，之后不再自动匹配这首。',
    );
    if (!choices) return;
    const stats = await applyCompletions(choices);
    toast(completionSummary(stats));
    if (stats.albums || stats.covers || stats.lyrics) { loadTracks(true); loadFacets(); }
  } catch (err) {
    toast(errText('联网补全失败', err), 'error');
  }
}

function replaceTrackCover(track) {
  if (!coverFileInput) {
    coverFileInput = document.createElement('input');
    coverFileInput.type = 'file';
    coverFileInput.accept = 'image/*';
    coverFileInput.hidden = true;
    document.body.appendChild(coverFileInput);
    coverFileInput.onchange = async () => {
      const file = coverFileInput.files && coverFileInput.files[0];
      const id = coverFileInput.dataset.trackId;
      coverFileInput.value = '';
      if (!file || !id) return;
      try {
        const blob = await file.arrayBuffer();
        await transport.postRaw(`/v1/tracks/${encodeURIComponent(id)}/cover`, blob,
          file.type || 'image/jpeg');
        toast('封面已替换');
        const track = state.byId.get(id);
        // 换过封面后缓存里还是旧图，必须先失效再重绘。插件形态下新图要重新
        // 取一次，就绪后由回填机制画上去；独立形态 coverUrl 直接就是新 URL。
        if (track) {
          track.has_cover = 1;
          await transport.invalidateCover(id);
          const row = state.rows.get(id);
          if (row) paintArt(row, (await transport.ensureCover(id)) || transport.coverUrl(id));
        }
      } catch (err) {
        toast(errText('封面替换失败', err), 'error');
      }
    };
  }
  coverFileInput.dataset.trackId = track.id;
  coverFileInput.click();
}

function resetTrackEdit(track) {
  transport.del(`/v1/tracks/${encodeURIComponent(track.id)}/edit`)
    .then(() => loadTracks(true))
    .then(() => toast('已恢复文件标签'))
    .catch((err) => toast(errText('重置失败', err), 'error'));
}

// 在线行的「加入歌单」：与服务端能力一致的自建歌单都是本地持久化的，
// 在线曲按快照富形态入单。anchor 是触发按钮，菜单贴着它弹出。
function openPlaylistMenu(track, anchor, event) {
  if (!state.playlists.length) {
    toast('还没有自建歌单，先到「歌单」页新建一个', 'error');
    return;
  }
  ui.menu.innerHTML = '';
  buildMenu(ui.menu, state.playlists.map((p) => ({
    label: p.name, run: () => addToPlaylist(p.id, track),
  })));
  const rect = anchor
    ? anchor.getBoundingClientRect()
    : { right: 8, bottom: 0 };
  showMenu(event ? event.clientX : rect.right - 8, event ? event.clientY : rect.bottom);
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

async function loadScanHistory() {
  const history = state.settings.last_scan_root ? [state.settings.last_scan_root] : [];
  const extra = state.settings.recent_scan_roots || [];
  const roots = [...new Set([...history, ...extra])].slice(0, 5);
  ui.scanHistory.innerHTML = '';
  if (!roots.length) { ui.scanHistory.hidden = true; return; }
  ui.scanHistory.hidden = false;
  for (const root of roots) {
    const btn = document.createElement('button');
    btn.className = 'chip-btn';
    btn.textContent = root;
    btn.onclick = () => { ui.scanRoot.value = root; };
    ui.scanHistory.appendChild(btn);
  }
}

async function startScan() {
  const root = ui.scanRoot.value.trim();
  if (!root) { toast('先填一个音乐目录', 'error'); return; }
  ui.scanBtn.disabled = true;
  ui.scanLabel.textContent = '正在准备…';
  try {
    await transport.post('/v1/library/roots', { path: root, enabled: true });
    await loadScanRoots();
    ui.scanLabel.textContent = '目录已添加，正在等待自动同步';
    scheduleScanStatus();
  } catch (err) {
    ui.scanLabel.textContent = errText('添加目录失败', err);
    toast(errText('添加目录失败', err), 'error');
  } finally {
    ui.scanBtn.disabled = false;
  }
}

let scanRootsEpoch = 0;
async function loadScanRoots() {
  const epoch = ++scanRootsEpoch;
  try {
    const data = await transport.get('/v1/library/roots');
    if (epoch !== scanRootsEpoch) return;
    ui.scanRoots.replaceChildren();
    for (const root of data.roots) {
      const row = document.createElement('div');
      row.className = 'scan-root-row';
      const label = document.createElement('label');
      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = root.enabled;
      enabled.setAttribute('aria-label', `自动同步 ${root.path}`);
      const name = document.createElement('span');
      name.textContent = root.path;
      label.append(enabled, name);
      const status = document.createElement('span');
      status.className = 'hint scan-root-status';
      status.textContent = root.last_error || (root.last_scanned_at
        ? `上次同步 ${new Date(root.last_scanned_at).toLocaleString()}` : '等待首次同步');
      const rescan = document.createElement('button');
      rescan.className = 'btn'; rescan.type = 'button'; rescan.textContent = '扫描';
      const remove = document.createElement('button');
      remove.className = 'btn'; remove.type = 'button'; remove.textContent = '移除';
      async function change(action) {
        enabled.disabled = rescan.disabled = remove.disabled = true;
        try { await action(); await loadScanRoots(); }
        catch (err) { enabled.checked = root.enabled; toast(errText('目录操作失败', err), 'error'); }
        finally { enabled.disabled = rescan.disabled = remove.disabled = false; }
      }
      enabled.onchange = () => change(() => transport.put('/v1/library/roots', {path: root.path, enabled: enabled.checked}));
      remove.onclick = () => change(() => transport.del(`/v1/library/roots?path=${encodeURIComponent(root.path)}`));
      rescan.onclick = () => change(async () => {
        await transport.post('/v1/library/scan', {root: root.path});
        await refreshScanStatus();
      });
      row.append(label, rescan, remove, status);
      ui.scanRoots.appendChild(row);
    }
  } catch (err) {
    if (epoch === scanRootsEpoch) ui.scanRoots.textContent = errText('目录读取失败', err);
  }
}

let scanStatusTimer = 0;
let scanStatusPending = false;
function scheduleScanStatus() {
  clearTimeout(scanStatusTimer);
  scanStatusTimer = setTimeout(() => { scanStatusTimer = 0; refreshScanStatus(); }, 1000);
}

async function refreshScanStatus() {
  if (scanStatusPending) { scheduleScanStatus(); return; }
  scanStatusPending = true;
  clearTimeout(scanStatusTimer); scanStatusTimer = 0;
  try {
    const status = await transport.get('/v1/library/status');
    ui.scanCancel.hidden = !status.running;
    ui.scanCancel.disabled = !!status.cancelled;
    ui.scanCancel.textContent = status.cancelled ? '正在取消…' : '取消扫描';
    const pct = status.total ? Math.round(status.done / status.total * 100) : 0;
    ui.scanBar.style.width = `${pct}%`;
    if (status.root) {
      ui.scanLabel.textContent = `${phaseLabel(status.phase)} · ${status.done}/${status.total}`
        + ` · 新增 ${status.added} · 更新 ${status.updated} · 跳过 ${status.skipped}`
        + ` · 移除 ${status.removed} · 失败 ${status.failed}`
        + (status.last_error ? ` · ${status.last_error}` : '');
    }
    const errors = status.errors || [];
    ui.scanErrors.hidden = errors.length === 0;
    const list = ui.scanErrors.querySelector('ul');
    list.replaceChildren();
    for (const error of errors) {
      const item = document.createElement('li');
      item.textContent = `${error.path}：${error.message}`;
      list.appendChild(item);
    }
    if (status.running) scheduleScanStatus();
    else await loadScanRoots();
  } catch (err) {
    ui.scanLabel.textContent = errText('扫描状态读取失败', err);
  } finally { scanStatusPending = false; }
}

function onScanProgress(msg) {
  const pct = msg.total ? Math.round((msg.done / msg.total) * 100) : 0;
  ui.scanBar.style.width = `${pct}%`;
  ui.scanLabel.textContent = `${phaseLabel(msg.phase)} ${pct}% · ${msg.done}/${msg.total}`;
  if (['done', 'failed', 'cancelled'].includes(msg.phase)) finishScan();
  else if (!scanStatusTimer && !scanStatusPending) refreshScanStatus();
}

function phaseLabel(phase) {
  return { scanning: '扫描中', walking: '正在查找文件', done: '扫描完成', failed: '扫描失败', cancelled: '已取消' }[phase] || '尚未扫描';
}

// 后端一直在 ScanProgress 里统计 added / failed / last_error，旧 UI 一个都没显示，
// 于是"扫了一半、其中 37 个文件解析失败"这类结果完全是静默的。
async function finishScan() {
  await refreshScanStatus();
}

// ---------------------------------------------------------------------------
// 设置 / 输出设备（又一个后端已有、旧 UI 完全没接的能力）
// ---------------------------------------------------------------------------

async function loadSettings() {
  // 这条 GET 在飞期间用户有没有动过即时开关，见 settingsEpoch 的注释。
  const epoch = settingsEpoch;
  const s = await transport.get('/v1/settings').catch(() => ({}));
  state.settings = epoch === settingsEpoch ? (s || {}) : { ...(s || {}), ...state.settings };
  await loadScanHistory();
  await loadScanRoots();
  await refreshScanStatus();
  if (ui.scanRoot && !ui.scanRoot.value && state.settings.last_scan_root) {
    ui.scanRoot.value = state.settings.last_scan_root;
  }
  ui.setDensity.value = state.settings.ui_density || 'comfortable';
  ui.setMotion.checked = state.settings.reduce_motion === true;
  // 播放行为偏好（folia 的 queue_add_behavior / playback_entry_view）：
  // 缺省值与下拉里的第一项一致——没配过 = 旧行为。
  ui.setQueueAdd.value = state.settings.queue_add_behavior === 'end' ? 'end' : 'next';
  ui.setPlaybackEntry.value = ['stage', 'wall'].indexOf(state.settings.playback_entry) >= 0
    ? state.settings.playback_entry : 'none';
  if (ui.setAutoPlay) ui.setAutoPlay.checked = state.settings.startup_auto_play === true;
  if (ui.setScrobble) ui.setScrobble.checked = state.settings.scrobble_enabled !== false;
  if (ui.setRelay) ui.setRelay.checked = state.settings.online_auto_relay !== false;
  paintLyricSettings();
  setCoverFollow(state.settings.cover_follow !== false, false);
  // 导航里「每日推荐」的可见性：关掉就把入口摘掉，其它菜单项不受影响。
  // 放在设置到手之后而不是启动时——早于这一步挂载的话，设置里是关的就白挂了。
  if (window.DailyView) window.DailyView.applySettings(state.settings);
  applyNavVisibility();
  document.body.dataset.density = ui.setDensity.value;
  document.body.classList.toggle('reduce-motion', ui.setMotion.checked);
  if (Stage) Stage.setReducedMotion(ui.setMotion.checked);
  // 下面两项是舞台上的即时开关。这条 GET 在飞期间用户动过它们的话，响应里是
  // 旧值——回填等于把刚点下的状态反杀，所以那一次以界面现状为准（库里已经由
  // 用户那次操作写对了），只回填确实没被动过的项。
  if (epoch === settingsEpoch) {
    if (window.Stage3D) Stage3D.configure(state.settings.stage3d);
    // 空闲收起默认开：设置表里没有这项时传 true，行为与"用户勾上了"一致。
    setStageIdleHide(state.settings.stage_idle_hide !== false, false);
  }
  // 渲染器在这里定：设置到手之前，粒子层一直挂着（帧门报 0，一帧不画）。
  // attach 只认第一次调用，所以之后用户改设置不会换渲染器——那是
  // 「重新加载界面」之后的事，设置页也是这么写的。
  if (window.StageParticles) {
    StageParticles.attach(state.settings.render_mode || 'standard');
    syncRenderModeUi();
  }
  // 播放模式在服务端有状态，但进程重启后要恢复成上次的选择。
  if (state.settings.play_mode && state.settings.play_mode !== state.snapshot.mode) {
    transport.post('/v1/player/mode', { mode: state.settings.play_mode }).catch(() => {});
  }
  loadDiagnostics();
}

// ---------------------------------------------------------------------------
// 开发者选项：播放诊断日志
//
// 三件事凑成这一节：开关（即时生效，不要求重启服务）、路径回显、把日志交出去。
// 路径必须显式显示——「把日志发给开发者」这一步不能要求用户先去翻数据目录。
// 日志接口返回 text/plain，所以复制/下载不走 transport（它固定按 JSON 解）。
// ---------------------------------------------------------------------------

let diagInfo = null;

function fmtDiagSize(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function renderDiagnostics(info) {
  diagInfo = info || null;
  const on = !!(info && info.enabled);
  if (ui.setDevDiag && ui.setDevDiag.checked !== on) ui.setDevDiag.checked = on;
  if (ui.devDiagDetail) ui.devDiagDetail.hidden = !on;
  if (ui.devDiagActions) ui.devDiagActions.hidden = !on;
  if (!ui.devDiagPath) return;
  if (!on) {
    ui.devDiagPath.textContent = '—';
  } else if (info && info.exists) {
    ui.devDiagPath.textContent = `${info.path}（${fmtDiagSize(info.size_bytes)}）`;
  } else {
    ui.devDiagPath.textContent = `${(info && info.path) || '—'}（还没有内容）`;
  }
}

async function loadDiagnostics() {
  const info = await transport.get('/v1/diagnostics').catch(() => null);
  // 这条 GET 失败（服务断开）时不动界面：勾选框停在用户刚按下的状态比跳回
  // 「关」诚实，反正库里写没写通由下面那次 POST 自己报错。
  if (info) renderDiagnostics(info);
}

async function setDevDiagnostics(on) {
  try {
    renderDiagnostics(await transport.post('/v1/diagnostics', { enabled: on }));
    toast(on ? '播放诊断日志已开启，复现问题后把下面的日志发给开发者' : '播放诊断日志已关闭');
  } catch (err) {
    if (ui.setDevDiag) ui.setDevDiag.checked = !on;
    toast(errText('切换失败', err), 'error');
  }
}

async function diagLogText() {
  // 插件形态没有 HTTP 可 fetch（CSP 是 connect-src 'none'），日志走 RPC 取回。
  if (window.hertzHost && window.hertzHost.isDbx) {
    const text = await transport.get('/v1/diagnostics/log');
    return typeof text === 'string' ? text : '';
  }
  const res = await fetch('/v1/diagnostics/log', {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function saveDiagLog(text) {
  return saveTextFile(
    `mmusic-playback-${new Date().toISOString().slice(0, 10)}.log`,
    'text/plain;charset=utf-8',
    text,
  );
}

async function copyDiagLog() {
  if (!ui.devDiagCopy) return;
  ui.devDiagCopy.disabled = true;
  try {
    const text = await diagLogText();
    if (!text.trim()) {
      toast('日志还是空的：先开启，再复现一次问题');
      return;
    }
    // 剪贴板不可用（非安全上下文或被拒）时不硬试第二遍，直接引导到下载。
    await writeClipboard(text);
    toast(`已复制 ${text.split('\n').filter(Boolean).length} 行日志，可直接粘贴发给开发者`);
    loadDiagnostics();
  } catch (err) {
    toast('复制失败，请改用「下载文件」', 'error');
  } finally {
    ui.devDiagCopy.disabled = false;
  }
}

async function saveDiagLogFromServer() {
  try {
    const text = await diagLogText();
    if (!text.trim()) {
      toast('日志还是空的：先开启，再复现一次问题');
      return;
    }
    await saveDiagLog(text);
    loadDiagnostics();
  } catch (err) {
    toast(errText('日志导出失败', err), 'error');
  }
}

async function clearDiagLog() {
  try {
    await transport.del('/v1/diagnostics/log');
    // 开关保持原样：用户的下一步通常是「清一次，重新复现」。
    renderDiagnostics({ ...(diagInfo || {}), enabled: true, exists: false, size_bytes: 0 });
    toast('日志已清空，继续复现即可');
  } catch (err) {
    toast(errText('清空失败', err), 'error');
  }
}

// ---------------------------------------------------------------------------
// 渲染模式：标准（Canvas 2D）/ 增强（WebGL2）
//
// 三条规则决定了这块交互的形状：
//   1. 选「增强」不立刻落库。先把硬件警示摊开，由警示块里的确认按钮写库——
//      直接 onchange 就保存的话，误操作的人会在下一帧才看到提示。
//   2. 落库之后不热切换，提示「重新加载界面」。渲染器在 attach 时只认第一次
//      调用，所以这条提示是真的，不是装饰性文案。
//   3. 但**降级是立刻生效的**：设备扛不住时还要求用户手动重载，等于把人关在
//      卡顿里。运行期帧率不足或 GL 上下文丢失，直接退回标准渲染并说明原因。
// ---------------------------------------------------------------------------

const RENDER_MODE_LABEL = { standard: '标准渲染', enhanced: 'WebGL 增强渲染' };
let renderModePending = null;   // 用户在界面上选了但还没确认落库的值

function renderWarnHtml() {
  return `
    <strong>增强渲染对显卡、内存和整机配置要求较高</strong>
    <p>该模式改由 GPU 直接绘制粒子：粒子数从数百提升到数万，并叠加一层泛光。
       它需要独立显卡或较新的核显、足够的显存，以及开启了硬件加速的浏览器。</p>
    <p>在低配设备、远程桌面 / 虚拟机、或浏览器已禁用 GPU 加速的环境下，
       可能出现明显掉帧、画面卡顿、风扇高速运转与耗电上升。</p>
    <p class="render-warn-note">开启后若感觉卡顿，把这里切回「标准渲染」即可恢复；
       程序检测到帧率不足时也会自动切回并提示你，不需要手动干预。</p>
    <div class="render-warn-actions">
      <button type="button" class="btn primary" id="render-confirm">确认开启并重新加载</button>
      <button type="button" class="btn" id="render-cancel">取消</button>
    </div>`;
}

function renderSavedHtml() {
  return `
    <strong>已保存，重新加载界面后生效</strong>
    <p>当前仍在运行 <b>${RENDER_MODE_LABEL[StageParticles ? StageParticles.effective() : 'standard']}</b>。
       重新加载不会中断播放，也不会改变音量与队列。</p>
    <div class="render-warn-actions">
      <button type="button" class="btn primary" id="render-reload">立即重新加载</button>
      <button type="button" class="btn" id="render-later">稍后</button>
    </div>`;
}

function showWarn(kind) {
  if (!ui.renderWarn) return;
  if (!kind) { ui.renderWarn.hidden = true; ui.renderWarn.textContent = ''; return; }
  ui.renderWarn.hidden = false;
  ui.renderWarn.className = 'render-warn is-' + kind;
  ui.renderWarn.innerHTML = kind === 'confirm' ? renderWarnHtml() : renderSavedHtml();
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  if (kind === 'confirm') {
    // 必须包一层：直接传 commitRenderMode 的话，click 的 Event 会被当成模式参数
    on('render-confirm', () => commitRenderMode());
    on('render-cancel', () => {
      renderModePending = null;
      ui.setRenderMode.value = committedRenderMode();
      showWarn(null);
    });
  } else {
    on('render-reload', () => location.reload());
    on('render-later', () => showWarn(null));
  }
}

function committedRenderMode() {
  return state.settings.render_mode || 'standard';
}

// next 省略时取界面上待确认的值；从「取消增强」那条路径会显式传 'standard'。
async function commitRenderMode(next) {
  const mode = next === undefined ? renderModePending : next;
  renderModePending = null;
  if (!mode) return;
  try {
    await transport.put('/v1/settings', { render_mode: mode });
    // 只在写库成功之后才更新内存里的值：否则失败分支里 committedRenderMode()
    // 读到的已经是"没保存成功的新值"，下拉框会停在一个骗人的位置上。
    state.settings.render_mode = mode;
  } catch (err) {
    toast(errText('保存渲染模式失败', err), 'error');
    ui.setRenderMode.value = committedRenderMode();
    showWarn(null);
    return;
  }
  // 用户主动改设置就是把生效模式改成了他选的那个，降级记录随之作废。
  transport.put('/v1/settings', { render_mode_effective: null }).catch(() => {});
  showWarn(mode === 'enhanced' ? 'saved' : null);
  if (mode !== 'enhanced') toast('已切回标准渲染，重新加载后生效');
}

// 设置页显示的是「真相」而不是「用户想要什么」：请求增强但被降级时，
// 下拉框保持标准渲染，并把原因写在旁边——否则用户会以为增强模式还开着。
function syncRenderModeUi() {
  if (!ui.setRenderMode || !window.StageParticles) return;
  const effective = StageParticles.effective();
  const requested = StageParticles.mode();
  ui.setRenderMode.value = renderModePending || committedRenderMode();
  if (requested === 'enhanced' && effective === 'standard') {
    const why = StageParticles.degradedBecause() || '设备不支持';
    ui.setRenderMode.value = 'standard';
    renderModePending = null;
    showWarn(null);
    toast(`增强渲染已自动关闭：${why}`, 'error');
  }
}

function initRenderMode() {
  if (!ui.setRenderMode) return;
  ui.setRenderMode.onchange = () => {
    const next = ui.setRenderMode.value;
    if (next === committedRenderMode()) { renderModePending = null; showWarn(null); return; }
    if (next === 'enhanced') {
      renderModePending = 'enhanced';
      showWarn('confirm');
      return;
    }
    showWarn(null);
    commitRenderMode('standard');
  };
  document.addEventListener('stage:degrade', (e) => {
    syncRenderModeUi();
    // 把"实际生效的模式"写回服务端：设置页和任何其它客户端因此能看到真相，
    // 而不是只看到用户当初想要什么。不清空是因为下次启动仍会重试
    // （上下文丢失多半是显卡驱动重置这类瞬时事件），重试失败会再更新一次。
    if (e.detail && e.detail.to === 'standard') {
      transport.put('/v1/settings', {
        render_mode_effective: 'standard',
        render_mode_note: e.detail.reason || ''
      }).catch(() => {});
    }
  });

}

async function loadDevices() {
  const data = await transport.get('/v1/devices').catch(() => ({ devices: [] }));
  state.devices = data.devices || [];
  ui.setDevice.innerHTML = '';
  if (!state.devices.length) {
    ui.setDevice.innerHTML = '<option>（无可用设备）</option>';
    return;
  }
  for (const d of state.devices) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.name + (d.is_default ? ' · 默认' : '');
    ui.setDevice.appendChild(opt);
  }
  if (state.snapshot.device) ui.setDevice.value = state.snapshot.device;
}

// ---------------------------------------------------------------------------
// 导航
// ---------------------------------------------------------------------------

function setView(name) {
  state.view = name;
  for (const [key, el] of Object.entries(ui.views)) el.hidden = key !== name;
  ui.rail.querySelectorAll('.rail-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (ui.settingsEntry) {
    ui.settingsEntry.classList.toggle('active', name === 'settings');
    ui.settingsEntry.setAttribute('aria-pressed', String(name === 'settings'));
  }
  document.body.classList.remove('column-open');
  if (name === 'online' && window.Online) window.Online.onViewEnter();
  // 设置页里的诊断日志大小是「现在有多少内容」：不进页面就不刷新，用户开着
  // 日志录了一晚上，这里还停在「还没有内容」，等于把功能自己的状态说错了。
  if (name === 'settings') loadDiagnostics();
  // 在线歌单可能在歌单视图没渲染期间到达（登录、刷新），进入时补一次同步。
  if (name === 'playlists') renderOnlinePlaylistSection();
  // 队列页的高亮由快照实时同步，但隐藏期间没有布局可滚；进入时把当前曲定位回来。
  if (name === 'queue') syncQueuePlaying(state.snapshot, true);
  // 收藏与每日推荐同理：进入时才拉，避免启动时多打两条请求。
  if (name === 'favorites' && window.Favorites) window.Favorites.onViewEnter();
  // 每日推荐独立页：数据与首页那条推荐条同源，只是换了个地方展示。
  if (name === 'daily' && window.DailyView) window.DailyView.onViewEnter();
  if (name === 'library') {
    if (window.Daily) window.Daily.load({ silent: true });
    // 专辑/歌手浏览面：编辑/扫描可能改过 facet，进入时对齐一次。
    loadFacets();
  }
  // 缓存占用是随时会变的数字，进设置页才刷新。
  if (name === 'settings') {
    if (window.__loadCacheStats) window.__loadCacheStats();
    if (window.__loadDspSettings) window.__loadDspSettings();
    if (window.__loadRemoteRoots) window.__loadRemoteRoots();
  }
}

function refreshAll() {
  loadTracks(true);
  loadPlaylists();
  loadSettings();
  loadDevices();
  transport.get('/v1/state').then((snap) => { applySnapshot(snap); restoreQueue(); }).catch(() => {});
}

// ---------------------------------------------------------------------------
// 主题色
//
// 主题本身由 themes.js 负责（写 CSS 变量 + 持久化 + 广播），app.js 只做三件
// 表现层的事：把目录渲染成菜单 / 设置项 / 色块，切换后让舞台重新取色，以及
// 记住用户选择。新增主题只需要往 Theme.CATALOG 里加一项，这里不用改。
// ---------------------------------------------------------------------------

const Theme = window.Theme;

// 喂三个颜色：主题色样本 = 底色（盘心）+ 主色→次色（外环），画法见 stage.css
// 的 `.theme-dot, .theme-swatch`。
//
// 底色必须一起给：主题名说的是底色（矿石黑 / 星蓝深空 / 夜樱猫语），只给主色
// 的话「矿石黑（默认）」会画成一个亮青球，名字和样本对不上。CSS 那侧的兜底是
// var(--bg)（当前主题的底色），漏传不会报错，只会让所有样本变成同一个颜色 ——
// scripts/check-css-tokens.js 有断言盯着这两个别名，别只改这里。
function themeDotStyle(theme) {
  return `--t-bg:${theme.tokens['--bg']};--t-accent:${theme.tokens['--accent']};--t-accent-2:${theme.tokens['--accent-2']}`;
}

function renderThemeMenu() {
  if (!Theme || !ui.themeMenu) return;
  const current = Theme.current();
  ui.themeMenu.innerHTML = '';
  Theme.list().forEach((theme) => {
    const btn = document.createElement('button');
    btn.className = 'theme-item';
    btn.type = 'button';
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', String(current && theme.id === current.id));
    btn.innerHTML = `<span class="theme-dot" style="${themeDotStyle(theme)}"></span>
      <span class="theme-meta"><span class="theme-name"></span></span>`;
    btn.querySelector('.theme-name').textContent = theme.name;
    btn.onclick = () => { applyTheme(theme.id); closeThemeMenu(); };
    ui.themeMenu.appendChild(btn);
  });
}

function renderThemeSettings() {
  if (!Theme) return;
  const current = Theme.current();
  if (ui.setTheme) {
    ui.setTheme.innerHTML = '';
    Theme.list().forEach((theme) => {
      const opt = document.createElement('option');
      opt.value = theme.id;
      opt.textContent = theme.name;
      if (current && theme.id === current.id) opt.selected = true;
      ui.setTheme.appendChild(opt);
    });
  }
  if (ui.themeSwatches) {
    ui.themeSwatches.innerHTML = '';
    Theme.list().forEach((theme) => {
      const b = document.createElement('button');
      b.className = 'theme-swatch';
      b.type = 'button';
      b.title = theme.name;
      b.setAttribute('aria-label', theme.name);
      b.setAttribute('aria-pressed', String(Boolean(current && theme.id === current.id)));
      b.style.cssText = themeDotStyle(theme);
      b.onclick = () => applyTheme(theme.id);
      ui.themeSwatches.appendChild(b);
    });
  }
}

function applyTheme(id) {
  if (!Theme) return;
  Theme.apply(id);
  // 主题换了，取色背景与歌词衰减色都要按新变量重算一遍，否则会残留旧主题的色相。
  if (Stage && typeof Stage.retint === 'function') Stage.retint();
}

function closeThemeMenu() {
  if (!ui.themeMenu) return;
  ui.themeMenu.hidden = true;
  if (ui.themeBtn) ui.themeBtn.setAttribute('aria-expanded', 'false');
}

// 菜单挂在 <body> 上，位置只能自己算：默认与按钮右对齐、落在按钮下方；
// 下方放不下就翻到上方，右边超出视口就向左收。
function positionThemeMenu() {
  if (!ui.themeMenu || ui.themeMenu.hidden || !ui.themeBtn) return;
  const r = ui.themeBtn.getBoundingClientRect();
  const w = ui.themeMenu.offsetWidth || 232;
  const h = ui.themeMenu.offsetHeight || 0;
  const gap = 8;
  const pad = 8;

  let left = r.right - w;
  left = Math.min(left, window.innerWidth - w - pad);
  left = Math.max(pad, left);

  let top = r.bottom + gap;
  if (top + h > window.innerHeight - pad && r.top - h - gap >= pad) {
    top = r.top - h - gap; // 下方不够就翻上去
  }
  top = Math.max(pad, Math.min(top, Math.max(pad, window.innerHeight - h - pad)));

  ui.themeMenu.style.left = `${Math.round(left)}px`;
  ui.themeMenu.style.top = `${Math.round(top)}px`;
}

function setThemeMenuOpen(open) {
  if (!ui.themeMenu) return;
  ui.themeMenu.hidden = !open;
  if (ui.themeBtn) ui.themeBtn.setAttribute('aria-expanded', String(open));
  if (open) positionThemeMenu();
}

function initTheme() {
  if (!Theme) return;
  Theme.init();
  Theme.onChange(() => { renderThemeMenu(); renderThemeSettings(); });
  renderThemeMenu();
  renderThemeSettings();

  if (ui.themeBtn && ui.themeMenu) {
    // 关键一步：把菜单从 .topbar 的层叠上下文里搬出来。留在原处的话，
    // 后面那些带 backdrop-filter 的玻璃面板（.column / .stage）会整块盖住它。
    document.body.appendChild(ui.themeMenu);

    ui.themeBtn.onclick = (e) => {
      e.stopPropagation();
      setThemeMenuOpen(ui.themeMenu.hidden);
    };
    document.addEventListener('click', (e) => {
      // 用 contains 而不是 ===：按钮里有个 svg，点图标时 target 是 svg，
      // 严格相等判断会漏掉，导致点按钮先关又立刻被 onclick 打开。
      if (!ui.themeMenu.hidden && !ui.themeMenu.contains(e.target) && !ui.themeBtn.contains(e.target)) {
        closeThemeMenu();
      }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeThemeMenu(); });
    // 窗口尺寸变化时菜单可能变得越界，跟随重算
    window.addEventListener('resize', () => { if (!ui.themeMenu.hidden) positionThemeMenu(); });
  }
  if (ui.setTheme) ui.setTheme.onchange = () => applyTheme(ui.setTheme.value);
}

// 主题工作室（web/theme-studio.js）：壁纸背景 + 二次元主题 + 自定义配色。
//
// 它自己管状态、持久化与设置页那块 DOM，宿主只需要给一个 toast。放在这里而不是
// 塞进 initTheme()：initTheme() 属于 themes.js 的令牌层，工作室是它的下游——
// 令牌先就位，工作室才有底色可读（自动压暗要按 --bg 算）。
function initThemeStudio() {
  if (!window.ThemeStudio) return;
  window.ThemeStudio.bind({ toast });
  window.ThemeStudio.init();
}

// ---------------------------------------------------------------------------
// 舞台控制舱
//
// 面板自己管参数与持久化（stage-control.js），app.js 只负责开关按钮和关闭
// 交互。参数变化会广播 stagecontrol:change，这里顺手同步一次设置里的
// 「减少动效」——两者目标不同但会互相打架，以用户的显式选择为准。
// ---------------------------------------------------------------------------

const StageControl = window.StageControl;

// 开合与持久化都由 stage-control.js 自己管（它已经绑好了按钮、关闭、Esc）。
// app.js 这里只做两件它做不了的事：恢复默认后给个提示，以及参数变化时让舞台
// 重新取色——两者都需要 app.js 才拿到的 toast / Stage 引用。
function initStageControl() {
  if (!StageControl) return;
  StageControl.init();
  if (ui.scReset) {
    // 用捕获阶段先跑，面板自己的 reset 在冒泡阶段，顺序不影响结果，
    // 这里只是补一句提示。
    ui.scReset.addEventListener('click', () => toast('舞台参数已恢复默认'), true);
  }
  document.addEventListener('stagecontrol:change', () => {
    // 滤镜强度/舞台预设会改到 --accent 之外的一批变量，取色背景要跟着重算。
    if (Stage && typeof Stage.retint === 'function') Stage.retint();
  });
}

function initTopMoreMenu() {
  const root = $('top-more');
  const btn = $('top-more-btn');
  const menu = $('top-more-menu');
  if (!root || !btn || !menu) return;

  let open = false;
  const items = () => Array.prototype.slice.call(menu.querySelectorAll('.menu-item'));

  function setOpen(next) {
    open = !!next;
    menu.hidden = !open;
    btn.classList.toggle('active', open);
    btn.setAttribute('aria-expanded', String(open));
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!open);
  });

  // 先让菜单项自己的 click 处理器执行，再收起菜单；不阻止默认行为。
  menu.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('.menu-item')) {
      setOpen(false);
      btn.focus();
    }
  });

  document.addEventListener('click', (e) => {
    if (open && !root.contains(e.target)) setOpen(false);
  });

  menu.addEventListener('keydown', (e) => {
    const list = items();
    if (!list.length) return;
    const idx = list.indexOf(document.activeElement);

    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      btn.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      let next = idx < 0 ? 0 : idx + (e.key === 'ArrowDown' ? 1 : -1);
      if (next < 0) next = list.length - 1;
      if (next >= list.length) next = 0;
      list[next].focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      list[0].focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      list[list.length - 1].focus();
    }
  });

  menu.addEventListener('focusout', (e) => {
    if (open && !menu.contains(e.relatedTarget)) setOpen(false);
  });

  window.addEventListener('resize', () => setOpen(false));
}

// 在线曲库的全部 UI/状态机已迁到 web/online.js（window.Online），
// app.js 只在启动时 bind() 注入宿主依赖。

// 预加载封面：失败（404 / 防盗链 / 超时）就当作没有封面，交给占位图兜底，
// 绝不让一张图片把「正在播放」变成空白。
function probeImage(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!url) { resolve(false); return; }
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    const img = new Image();
    // 跨域图片不做 canvas 取色也要能显示；不设 crossOrigin 就不会触发 CORS 失败
    img.onload = () => finish(img.naturalWidth > 0);
    img.onerror = () => finish(false);
    img.src = url;
    setTimeout(() => finish(false), timeoutMs); // 卡住的请求不能无限等
  });
}

// ---------------------------------------------------------------------------
// MediaSession —— 让系统媒体键在浏览器里也能控制本地播放器
// ---------------------------------------------------------------------------

function updateMediaSessionMetadata(track, artUrl) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: track.title,
      artist: track.artist || '未知艺术家',
      album: track.album || '',
      artwork: artUrl ? [{ src: new URL(artUrl, location.href).href }] : [],
    });
  } catch { /* 某些浏览器在缺字段时会抛，忽略即可 */ }
}

function syncMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.playbackState = !state.snapshot.track_id || state.stopped
      ? 'none' : state.snapshot.playing ? 'playing' : 'paused';
    const duration = playbackDuration(state.snapshot);
    if (duration > 0 && !state.stopped) {
      navigator.mediaSession.setPositionState({
        duration: duration / 1000,
        playbackRate: 1,
        position: Math.max(0, Math.min(duration, state.snapshot.position_ms || 0)) / 1000,
      });
    } else {
      navigator.mediaSession.setPositionState();
    }
  } catch { /* positionState 在部分内核上不可用 */ }
}

function bindMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const handlers = {
    play: () => setPlayback('play'),
    pause: () => setPlayback('pause'),
    stop: stopPlayback,
    previoustrack: () => post('/v1/player/previous'),
    nexttrack: () => post('/v1/player/next'),
    seekto: (d) => seekTo(d.seekTime * 1000),
    seekforward: (d) => seekRelative(d.seekOffset || 10),
    seekbackward: (d) => seekRelative(-(d.seekOffset || 10)),
  };
  for (const [name, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(name, (e) => Promise.resolve(fn(e || {})).catch(() => {})); } catch { /* 不支持的动作 */ }
  }
}

// ---------------------------------------------------------------------------
// 控件
// ---------------------------------------------------------------------------

let seekRequestEpoch = 0;

async function seekTo(ms) {
  if (!state.snapshot.track_id || !Number.isFinite(ms)) return;
  const epoch = ++seekRequestEpoch;
  const intent = PlaybackIntent.generation;
  const trackId = state.snapshot.track_id;
  const duration = playbackDuration(state.snapshot);
  const position = Math.max(0, Math.min(duration || Infinity, Math.round(ms)));
  try {
    await transport.post('/v1/player/seek', { position_ms: position });
    if (epoch !== seekRequestEpoch || !PlaybackIntent.current(intent) || state.snapshot.track_id !== trackId) return;
    state.snapshot = { ...state.snapshot, position_ms: position };
    if (Stage) Stage.setSnapshot(state.snapshot, { seek: true });
    renderPlaybackProgress(state.snapshot);
    syncMediaSession();
  } catch (error) {
    if (epoch === seekRequestEpoch && PlaybackIntent.current(intent)) toast(errText('跳转播放位置失败', error), 'error');
  }
}

async function seekRelative(deltaSec) {
  const base = Stage ? Stage.position() : state.snapshot.position_ms || 0;
  await seekTo(base + deltaSec * 1000);
}

let volumeTarget = null;
let volumeRequest = null;
let unmutedVolume = 80;

function syncVolume(volume) {
  if (!Number.isFinite(volume)) return;
  const value = Math.round(Math.max(0, Math.min(1, volume)) * 100);
  if (value > 0) unmutedVolume = value;
  [ui.volume, np.volume].forEach((range) => {
    if (!range) return;
    range.value = String(value);
    range.setAttribute('aria-valuetext', `${value}%`);
  });
}

function setVolumeFromInput() {
  volumeTarget = Math.max(0, Math.min(1, Number(ui.volume.value) / 100));
  syncVolume(volumeTarget);
  state.snapshot = { ...state.snapshot, volume: volumeTarget };
  if (Stage) Stage.setSnapshot(state.snapshot);
  if (!volumeRequest) {
    volumeRequest = (async () => {
      try {
        let sent;
        do {
          sent = volumeTarget;
          try {
            await transport.post('/v1/player/volume', { volume: sent });
          } catch (error) {
            toast(errText('调整音量失败', error), 'error');
          }
        } while (volumeTarget !== sent);
      } finally {
        volumeTarget = null;
        volumeRequest = null;
      }
    })();
  }
  return volumeRequest;
}

function playbackDuration(snap) {
  return Math.max(0, Number(snap.duration_ms)
    || (state.current && state.current.id === snap.track_id && Number(state.current.duration_ms)) || 0);
}

function renderPlaybackProgress(snap, preview) {
  const duration = playbackDuration(snap);
  const position = Math.max(0, Math.min(duration, preview == null ? snap.position_ms || 0 : preview));
  const ratio = duration > 0 ? position / duration : 0;
  [ui.progress, np.bar].forEach((range) => {
    if (!range) return;
    range.disabled = !snap.track_id || duration <= 0;
    if (state.seeking && preview == null) return;
    range.value = String(Math.round(ratio * 1000));
    range.setAttribute('aria-valuetext', `${fmt(position)} / ${fmt(duration)}`);
  });
  if (state.seeking && preview == null) return;
  ui.barTime.textContent = `${fmt(position)} / ${fmt(duration)}`;
  if (np.time) np.time.textContent = ui.barTime.textContent;
  ui.progressGhost.style.width = `${(ratio * 100).toFixed(2)}%`;
}

let seekGesture = null;
let seekEpoch = 0;

function cancelSeek() {
  seekEpoch += 1;
  seekGesture = null;
  state.seeking = false;
  renderPlaybackProgress(state.snapshot);
}

function bindSeekRange(range) {
  if (!range) return;
  const begin = () => {
    seekEpoch += 1;
    seekGesture = { range, trackId: state.snapshot.track_id };
    state.seeking = true;
  };
  range.addEventListener('pointerdown', begin);
  range.addEventListener('input', () => {
    if (!seekGesture || seekGesture.range !== range) begin();
    renderPlaybackProgress(state.snapshot, Number(range.value) / 1000 * playbackDuration(state.snapshot));
  });
  range.addEventListener('change', async () => {
    const trackId = seekGesture ? seekGesture.trackId : state.snapshot.track_id;
    const position = Number(range.value) / 1000 * playbackDuration(state.snapshot);
    const epoch = ++seekEpoch;
    seekGesture = null;
    state.seeking = true;
    try {
      if (trackId === state.snapshot.track_id) await seekTo(position);
    } finally {
      if (epoch === seekEpoch) {
        state.seeking = false;
        renderPlaybackProgress(state.snapshot);
      }
    }
  });
  const cancel = () => { if (seekGesture && seekGesture.range === range) cancelSeek(); };
  range.addEventListener('pointerup', () => setTimeout(cancel, 0));
  range.addEventListener('pointercancel', cancel);
  range.addEventListener('lostpointercapture', () => setTimeout(cancel, 0));
  range.addEventListener('blur', cancel);
}

let coverFollowWrite = Promise.resolve();

function setCoverFollow(value, persist) {
  const enabled = value !== false;
  state.settings.cover_follow = enabled;
  if (ui.setCoverFollow) ui.setCoverFollow.checked = enabled;
  if (Stage) Stage.setCoverFollow(enabled);
  if (persist) {
    markSettingsDirty();
    coverFollowWrite = coverFollowWrite.then(() => transport.put('/v1/settings', { cover_follow: enabled }))
      .catch((error) => toast(errText('保存封面联动设置失败', error), 'error'));
  }
}

// ---------------------------------------------------------------------------
// 睡眠定时器（folia 的 sleep timer）：到点暂停播放。偏好时长跨会话记住，
// 运行中的倒计时只活在内存里——刷新/重开页面即失效，与 folia 行为一致。
// ---------------------------------------------------------------------------

const SLEEP_TIMER_KEY = 'vmusic.sleep-timer-preset';
const sleepState = { deadline: 0, timer: 0 };

function sleepPresetMinutes() {
  const v = Number(localStorage.getItem(SLEEP_TIMER_KEY));
  return Number.isFinite(v) && v > 0 ? v : 30;
}

function sleepRemainingMs() {
  return sleepState.deadline ? Math.max(0, sleepState.deadline - Date.now()) : 0;
}

function sleepLabel(remainingMs) {
  const total = Math.ceil(remainingMs / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function renderSleepTimer() {
  if (!ui.sleepTimer) return;
  const active = sleepState.deadline > 0;
  ui.sleepTimer.classList.toggle('is-active', active);
  ui.sleepTimer.setAttribute('aria-pressed', String(active));
  const label = active ? sleepLabel(sleepRemainingMs()) : '';
  if (ui.sleepTimerLabel) {
    ui.sleepTimerLabel.hidden = !active;
    if (active) ui.sleepTimerLabel.textContent = label;
  }
  ui.sleepTimer.title = active ? `睡眠定时：还剩 ${label}` : '睡眠定时器';
}

function stopSleepTicker() {
  if (sleepState.timer) { clearInterval(sleepState.timer); sleepState.timer = 0; }
}

function clearSleepTimer(silent) {
  sleepState.deadline = 0;
  stopSleepTicker();
  renderSleepTimer();
  if (!silent) toast('已取消睡眠定时');
}

function armSleepTimer(minutes) {
  if (!(minutes > 0)) return;
  localStorage.setItem(SLEEP_TIMER_KEY, String(minutes));
  sleepState.deadline = Date.now() + minutes * 60 * 1000;
  stopSleepTicker();
  sleepState.timer = setInterval(() => {
    if (!sleepRemainingMs()) {
      clearSleepTimer(true);
      toast('睡眠定时到了，已暂停播放');
      post('/v1/player/pause');
      return;
    }
    renderSleepTimer();
  }, 500);
  renderSleepTimer();
  toast(`将在 ${minutes} 分钟后暂停播放`);
}

function openSleepTimerMenu(anchor) {
  const preset = sleepPresetMinutes();
  const items = [
    { label: '取消定时', disabled: !sleepState.deadline, run: () => clearSleepTimer() },
    { sep: true },
    ...[15, 30, 45, 60, 90].map((m) => ({
      label: `${m} 分钟${m === preset ? ' ✓' : ''}`,
      run: () => armSleepTimer(m),
    })),
    {
      label: '自定义分钟数…',
      run: async () => {
        const v = await modal().prompt('多少分钟后暂停播放？（分钟，1–1440）', String(preset));
        if (v === null) return;
        const m = Number(v);
        if (!Number.isFinite(m) || m < 1 || m > 1440) { toast('请输入 1–1440 之间的分钟数', 'error'); return; }
        armSleepTimer(Math.round(m));
      },
    },
  ];
  buildMenu(ui.menu, items);
  const rect = anchor.getBoundingClientRect();
  showMenu(rect.left, rect.bottom + 6);
}

function initSleepTimer() {
  if (!ui.sleepTimer) return;
  // 菜单在同一次点击里建起，document 的 closeMenu 监听会立刻清掉它（与批量
  // 加入歌单同一坑），必须挡冒泡。
  ui.sleepTimer.onclick = (e) => { e.stopPropagation(); openSleepTimerMenu(ui.sleepTimer); };
  renderSleepTimer();
}

// ---------------------------------------------------------------------------
// 命令面板（palette.js 的引擎 + 这里的命令注册）。命令用闭包拿 app.js 里的
// 一切（播放控制、视图切换、睡眠定时、队列操作……），面板本体不认识业务。
// ---------------------------------------------------------------------------

/// 队列批量方言（folia 的 queueQuery）：`artist:xxx --remove` / `album:xx --next`
/// / `自由词 --end`。当前曲永远豁免（与 folia 的 skip-current 规则一致）。
function paletteQueueBatch(query) {
  if (!/--(remove|rm|delete|next|end)\b/i.test(query)) return null;
  const action = /--(remove|rm|delete)\b/i.test(query) ? 'remove'
    : (/--next\b/i.test(query) ? 'next' : 'end');
  const facetMatch = query.match(/(artist|album|歌手|专辑)\s*[:：]\s*(.+?)(?=\s*--|$)/i);
  let facet = null;
  let filterText = '';
  if (facetMatch) {
    facet = /^(artist|歌手)$/i.test(facetMatch[1]) ? 'artist' : 'album';
    filterText = facetMatch[2].trim();
  } else {
    filterText = query.replace(/--\S+/g, '').replace(/(artist|album|歌手|专辑)\s*[:：]\s*/gi, '').trim();
  }
  if (!filterText) return null;
  const current = state.snapshot.track_id;
  const needle = filterText.toLowerCase();
  const matched = [];
  state.queue.forEach((id) => {
    if (id === current) return;
    const meta = state.byId.get(id) || (window.Online && window.Online.getMeta(id));
    if (!meta) return;
    const field = facet === 'artist' ? (meta.artist || '')
      : facet === 'album' ? (meta.album || '')
        : `${meta.title || ''} ${meta.artist || ''} ${meta.album || ''}`;
    if (String(field).toLowerCase().includes(needle)) matched.push(id);
  });
  if (!matched.length) return null;
  const actionLabel = action === 'remove' ? '移出队列' : action === 'next' ? '插到当前曲之后' : '移到队尾';
  const facetLabel = facet ? (facet === 'artist' ? '歌手' : '专辑') : '关键词';
  const names = matched.slice(0, 6)
    .map((id) => ((state.byId.get(id) || {}).title) || id);
  return {
    label: `${actionLabel}：${facetLabel}「${filterText}」命中 ${matched.length} 首`,
    sub: `${names.join('、')}${matched.length > 6 ? '…' : ''}（Enter 应用）`,
    apply: () => {
      if (action === 'remove') {
        applyQueue(state.queue.filter((id) => !matched.includes(id)), true);
        toast(`已移出 ${matched.length} 首`);
        return;
      }
      const rest = state.queue.filter((id) => !matched.includes(id));
      const list = rest.slice();
      if (action === 'next' && current) {
        list.splice(Math.max(0, list.indexOf(current)) + 1, 0, ...matched);
      } else {
        list.push(...matched);
      }
      applyQueue(list, true);
      toast(`已把 ${matched.length} 首${action === 'next' ? '插到当前曲目之后' : '移到队尾'}`);
    },
  };
}

function initPalette() {
  if (!window.Palette) return;
  const P = window.Palette;
  P.registerQueueBatch(paletteQueueBatch);

  const cmds = [
    // --- 播放 ---
    { id: 'play-toggle', group: '播放', title: '播放 / 暂停', keywords: 'play pause 播放 暂停', run: () => togglePlay() },
    { id: 'play-next', group: '播放', title: '下一首', keywords: 'next 下一首', run: () => post('/v1/player/next') },
    { id: 'play-prev', group: '播放', title: '上一首', keywords: 'previous 上一首', run: () => post('/v1/player/previous') },
    { id: 'play-stop', group: '播放', title: '停止播放', keywords: 'stop 停止', run: () => post('/v1/player/stop') },
    { id: 'play-seek-fwd', group: '播放', title: '快进 30 秒', keywords: 'seek forward 快进', run: () => seekRelative(30) },
    { id: 'play-seek-back', group: '播放', title: '快退 30 秒', keywords: 'seek backward 快退', run: () => seekRelative(-30) },
    {
      id: 'play-mode', group: '播放', title: '切换播放模式',
      description: '列表循环 → 单曲循环 → 随机', keywords: 'mode repeat shuffle 循环 随机',
      run: () => {
        const order = ['repeat', 'repeat_one', 'shuffle'];
        const next = order[(order.indexOf(state.snapshot.mode) + 1) % order.length];
        transport.post('/v1/player/mode', { mode: next }).catch(() => {});
      },
    },
    {
      id: 'play-mute', group: '播放', title: '静音 / 取消静音', keywords: 'mute volume 静音 音量',
      run: () => {
        const v = Number(ui.volume.value) > 0 ? 0 : unmutedVolume;
        ui.volume.value = String(v);
        setVolumeFromInput();
        toast(v ? '已取消静音' : '已静音');
      },
    },

    // --- 视图 ---
    { id: 'view-library', group: '导航', title: '转到：曲库', keywords: 'library 曲库 本地', run: () => setView('library') },
    { id: 'view-online', group: '导航', title: '转到：在线曲库', keywords: 'online 在线 搜索', run: () => setView('online') },
    { id: 'view-playlists', group: '导航', title: '转到：歌单', keywords: 'playlist 歌单', run: () => setView('playlists') },
    { id: 'view-daily', group: '导航', title: '转到：每日推荐', keywords: 'daily 推荐 每日', run: () => setView('daily') },
    { id: 'view-queue', group: '导航', title: '转到：播放队列', keywords: 'queue 队列', run: () => setView('queue') },
    { id: 'view-favorites', group: '导航', title: '转到：收藏', keywords: 'favorite 收藏 红心', run: () => setView('favorites') },
    { id: 'view-settings', group: '导航', title: '转到：设置', keywords: 'settings 设置', run: () => setView('settings') },
    { id: 'view-search', group: '导航', title: '聚焦搜索框', keywords: 'search 搜索 查找', run: () => focusSearch(true) },

    // --- 队列 ---
    {
      id: 'queue-clear', group: '队列', title: '清空队列（保留当前曲目）',
      keywords: 'clear queue 清空', run: () => applyQueue(state.snapshot.track_id ? [state.snapshot.track_id] : [], true),
    },
    {
      id: 'queue-save-playlist', group: '队列', title: '把队列存为歌单',
      description: '本地曲目收进本地歌单，在线曲目按音源存到对应平台',
      keywords: 'save playlist 歌单 保存',
      run: () => { if (ui.queueSave) ui.queueSave.click(); else setView('queue'); },
    },

    // --- 舞台 ---
    {
      id: 'stage-open', group: '舞台', title: '打开沉浸声场',
      keywords: 'stage 3d 沉浸 声场 舞台 fullscreen',
      run: () => { try { if (window.Stage3D) Stage3D.open(Stage3D.stageId ? Stage3D.stageId() : undefined); } catch (e) { try { Stage3D.open(); } catch (e2) { toast('沉浸声场不可用', 'error'); } } },
    },
    {
      id: 'stage-close', group: '舞台', title: '关闭沉浸声场',
      keywords: 'stage close 关闭 退出',
      run: () => { try { if (window.Stage3D) Stage3D.close(); } catch (e) { /* 不在舞台里 */ } },
    },

    // --- 睡眠定时 ---
    ...[15, 30, 45, 60, 90].map((m) => ({
      id: `sleep-${m}`, group: '睡眠定时', title: `${m} 分钟后暂停播放`,
      keywords: `sleep timer 睡眠 定时 ${m}`,
      run: () => armSleepTimer(m),
    })),
    { id: 'sleep-cancel', group: '睡眠定时', title: '取消睡眠定时', keywords: 'sleep cancel 取消', run: () => clearSleepTimer() },

    // --- 外观 ---
    ...(window.Theme && Theme.list ? Theme.list().map((t) => ({
      id: `theme-${t.id}`, group: '主题', title: `主题：${t.name}`,
      keywords: `theme 主题 配色 ${t.name} ${t.note || ''}`,
      run: () => Theme.apply(t.id),
    })) : []),
    ...(window.Skins && Skins.list ? Skins.list().map((s) => ({
      id: `skin-${s.id}`, group: '皮肤', title: `皮肤：${s.name}`,
      description: s.note || '', keywords: `skin 皮肤 布局 ${s.name}`,
      run: () => Skins.apply(s.id),
    })) : []),

    // --- 工具 ---
    {
      id: 'tool-video-export', group: '工具', title: '录制歌词视频',
      description: '舞台画面 + 歌词 + 系统声音，录成 MP4/WebM',
      keywords: 'video export record 录制 导出 视频 歌词 mv',
      available: () => window.VideoExport && VideoExport.supported()
        && !(window.hertzHost && window.hertzHost.isDbx),
      run: () => VideoExport.open(),
    },
    {
      id: 'tool-video-export-stop', group: '工具', title: '停止录制并保存',
      keywords: 'video stop record 停止 保存 录制',
      available: () => window.VideoExport && typeof VideoExport.isRecording === 'function'
        ? VideoExport.isRecording() : false,
      run: () => VideoExport.stop(),
    },
    {
      id: 'tool-copy-overlay', group: '工具', title: '复制 OBS 歌词浮层地址',
      description: '粘进 OBS 浏览器源即可显示歌词', keywords: 'obs overlay 歌词 浮层 直播',
      available: () => !(window.hertzHost && window.hertzHost.isDbx),
      run: async () => {
        const style = ui.overlayStyle ? ui.overlayStyle.value : 'full';
        const url = `${location.origin}/overlay?token=${encodeURIComponent(TOKEN)}&style=${encodeURIComponent(style)}`;
        try { await writeClipboard(url); toast('浮层地址已复制'); } catch (e) { toast(errText('复制失败', e), 'error'); }
      },
    },
    {
      id: 'tool-scrobble-toggle', group: '工具', title: '切换网易云听歌打卡',
      keywords: 'scrobble 打卡 播放量',
      run: async () => {
        const next = state.settings.scrobble_enabled === false;
        state.settings.scrobble_enabled = next;
        if (ui.setScrobble) ui.setScrobble.checked = next;
        await transport.put('/v1/settings', { scrobble_enabled: next }).catch(() => {});
        toast(next ? '听歌打卡已开启' : '听歌打卡已关闭');
      },
    },
    {
      id: 'tool-relay-toggle', group: '工具', title: '切换曲源自动接力',
      keywords: 'relay 接力 换源 失效 音源',
      run: async () => {
        const next = state.settings.online_auto_relay === false;
        state.settings.online_auto_relay = next;
        if (ui.setRelay) ui.setRelay.checked = next;
        await transport.put('/v1/settings', { online_auto_relay: next }).catch(() => {});
        toast(next ? '曲源自动接力已开启' : '曲源自动接力已关闭');
      },
    },
    {
      id: 'tool-rescan', group: '工具', title: '重新扫描曲库',
      keywords: 'scan rescan 扫描 曲库',
      run: () => { startScan(); },
    },
  ];
  P.register(cmds);
}

// ---------------------------------------------------------------------------
// 快捷键
// ---------------------------------------------------------------------------

/// 唤起搜索框。浮光皮肤把常驻搜索框摘掉了（顶栏中段让给导航胶囊），
/// 但 `/` 与 Ctrl+K 必须仍然能把它叫出来 —— 否则这条快捷键就成了
/// "按了没反应且不报错"的静默失效。所以聚焦的同时给 body 挂一个标记，
/// 由 skin.sheen.css 的 `body.sheen-search .topsearch { opacity:1 }` 显形，
/// blur 时（见下）摘掉标记让它收回。
function focusSearch(select) {
  document.body.classList.add('sheen-search');
  ui.search.focus();
  if (select) ui.search.select();
}

function bindShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const target = document.activeElement;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      // 命令面板接管 Ctrl+K（folia 的 command palette）；面板没加载时回落
      // 到旧的聚焦搜索。
      if (window.Palette) Palette.open();
      else focusSearch(true);
      return;
    }
    if (e.key === 'Escape') { closeMenu(); closeNowPlaying(); if (typing) document.activeElement.blur(); setView(state.view); document.body.classList.remove('stage-open'); document.body.classList.remove('sheen-search'); return; }
    if (e.key === '/' && !typing) { e.preventDefault(); focusSearch(false); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey || target.closest('button, a, [role="button"], [role="slider"]')) return;

    switch (e.key) {
      case ' ': e.preventDefault(); togglePlay(); break;
      case 'ArrowRight': e.preventDefault(); if (e.shiftKey) post('/v1/player/next'); else seekRelative(5); break;
      case 'ArrowLeft': e.preventDefault(); if (e.shiftKey) post('/v1/player/previous'); else seekRelative(-5); break;
      case 'ArrowUp': e.preventDefault(); ui.volume.value = String(Math.min(100, Number(ui.volume.value) + 5)); setVolumeFromInput(); break;
      case 'ArrowDown': e.preventDefault(); ui.volume.value = String(Math.max(0, Number(ui.volume.value) - 5)); setVolumeFromInput(); break;
      case 'm': case 'M': {
        const v = Number(ui.volume.value) > 0 ? 0 : unmutedVolume;
        ui.volume.value = String(v);
        setVolumeFromInput();
        toast(v ? '已取消静音' : '已静音');
        break;
      }
      case '1': setView('library'); break;
      case '2': setView('playlists'); break;
      case '3': setView('queue'); break;
      case '4': setView('settings'); break;
      default: break;
    }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#ctx-menu')) closeMenu(); });
}

// ---------------------------------------------------------------------------
// 流年搜索面板桥接：播放分流 + 「查看全部」带词跳转
// ---------------------------------------------------------------------------
function initPanelBridge() {
  document.addEventListener('ln:panel', (e) => {
    const d = e.detail || {};
    if (d.action === 'settings-enter') {
      // 流年把设置页搬进了浮层，不再经过 setView('settings')，
      // 这里补上它原本顺带做的诊断日志刷新，否则设置页里的日志大小会停在旧值。
      loadDiagnostics();
    } else if (d.action === 'play-local') {
      playTrack(String(d.id), state.queue.slice());
    } else if (d.action === 'play-online') {
      if (window.Online && d.track) {
        window.Online.playAll([Object.assign({ playable: true }, d.track)], 0);
      }
    } else if (d.action === 'view-local') {
      const q = d.q || '';
      ui.search.value = q;
      ui.searchClear.hidden = !q;
      state.q = q.trim();
      setView('library');
      loadTracks(true);
    } else if (d.action === 'view-online') {
      const q = d.q || '';
      const wasOnline = state.view === 'online';
      ui.onlineQ.value = q;
      // Online.state 导出的是 onlineState 对象本身（非函数），直接写属性。
      if (window.Online) window.Online.state.q = q;
      setView('online');
      // 已在在线页且已有旧结果时 onViewEnter 早退，补一次显式搜索新关键词。
      if (wasOnline && window.Online) window.Online.search();
    }
  });
}

// 清风皮肤的「队列拼接」海报墙需要两件在闭包里的事：队列里有哪些歌、哪首
// 在放。皮肤拿不到 state，所以走一条只读请求：它发 qf:panel('queue-request')，
// 这里同步把快照挂回 detail（同一批 CustomEvent 对象，emit 之后皮肤即可读）。
//
// 播放方向相反：皮肤**不自己发播放请求**，只发意图（play-index / play-step），
// 真正落 play 的还是 app.js —— 播放路径只有一条，不会出现皮肤点一下、app.js
// 又点一下的双触发。
function initQingfengBridge() {
  document.addEventListener('qf:panel', (e) => {
    const d = e.detail || {};
    if (d.action === 'settings-enter') {
      // 清风把设置页搬进了浮层，不再经过 setView('settings')，
      // 这里补上它原本顺带做的诊断日志刷新，否则设置页里的日志大小会停在旧值。
      loadDiagnostics();
      if (window.__loadCacheStats) window.__loadCacheStats();
      if (window.__loadDspSettings) window.__loadDspSettings();
      if (window.__loadRemoteRoots) window.__loadRemoteRoots();
    } else if (d.action === 'queue-request') {
      d.queue = queueSnapshot();
    } else if (d.action === 'source-request') {
      // 按当前 tab 取源 —— 队列拼接墙的正式入口。
      // 保留 queue-request 是因为播放队列 tab 走的就是它（kind==='queue'，
      // 那一路的项带 queueItem 标记，播放分派与原逻辑逐字一致）。
      d.source = viewSnapshot();
    } else if (d.action === 'activate') {
      activateSourceItem(d.item);
    } else if (d.action === 'playlist-drill') {
      // 歌单墙的第二层：取数，不播。异步，所以这里只发起、把 promise 交回去，
      // 皮肤那边自己管 loading / 失败提示。
      d.result = window.OnlinePlaylists && window.OnlinePlaylists.drillTracks
        ? window.OnlinePlaylists.drillTracks(d.source, d.playlistId)
        : Promise.resolve({ error: '歌单展开功能还没准备好' });
    } else if (d.action === 'play-index') {
      // 队列语义：按播放队列下标。只有播放队列 tab 会发这个。
      playQueueIndex(d.index);
    } else if (d.action === 'play-step') {
      playQueueStep(d.delta);
    } else if (d.action === 'seek') {
      // 复用 seekTo：它带了 epoch 竞态保护、时长夹取与失败提示，
      // 自己拼一条 post 会把这三样都丢掉。
      const total = playbackDuration(state.snapshot);
      if (total) seekTo(Math.round(total * d.ratio));
    }
  });
}

// 队列快照：海报墙要的每项就是「id / 标题 / 艺人 / 封面 / 序号 / 在不在放」。
// 队列里的 id 可能来自尚未加载的曲库分页（Online.getMeta）或在线虚拟 id，
// 与 renderQueue 走同一套回落，拿不到就显示占位而不是整项消失。
function queueSnapshot() {
  const list = state.queue || [];
  return list.map((id, index) => {
    const track = state.byId.get(id) || (window.Online && window.Online.getMeta(id))
      || { id, title: '未知曲目', artist: '' };
    const current = id === state.snapshot.track_id;
    // 正在播放这首的封面走 applyCoverImg 那套已解析好的地址（state.current），
    // 其余按曲库元数据拼 —— 与 renderQueue 里的行 artwork 同源。
    let cover = null;
    if (current && state.current) {
      cover = transport.coverUrl(id) || null;
    } else if (track.has_cover) {
      cover = transport.coverUrl(id);
    } else if (id.startsWith('online:') && window.Online) {
      cover = window.Online.safeCoverUrl(track.cover || null);
    }
    // 正在播放这首的时长以快照为准（快照里才有真实解码时长），其余取元数据。
    const duration = current
      ? playbackDuration(state.snapshot)
      : (Number(track.duration_ms) || 0);
    return {
      id,
      index,
      badge: index + 1,
      sourceKey: 'queue',
      title: track.title || '未知曲目',
      artist: track.artist || '未知艺术家',
      duration: duration || null,
      cover,
      current,
      playing: current && state.snapshot.playing,
      // 播放队列这一份要按**队列下标**播，不能走 playSourceItem 那套
      // 「看 id 猜来源」的分派 —— 队列里既有本地 id 也可能有 online: 前缀的
      // 失效项（playQueueIndex 见到它会提示重新点播），语义与墙上来源无关。
      queueItem: true,
      // 海报墙内的进度条：按已播时长 / 总时长算，没有总时长就不给。
      progress: current && duration
        ? Math.max(0, Math.min(1, (state.snapshot.position_ms || 0) / duration))
        : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// 队列拼接的「按视图取源」
//
// 需求：**每个 tab 的墙展示那个 tab 的内容** —— 歌单页是歌单、电台页是在线曲库、
// 本地页是曲库、每日推荐是当天的推荐、收藏是收藏列表；播放队列 tab 仍是队列
// （第 6 个来源，保留原行为）。
//
// 为什么在这里做而不是让皮肤自己去读：各视图的数据分散在五个模块的闭包里
// （Online.onlineState、DailyView.st、OnlinePlaylists 私有 state、
//  Favorites.favState、app 自己的 state），每份形状与 id 体系都不一样
// （本地 id / online: 虚拟 id / 歌单 ref）。皮肤层逐个去摸会把这些内部结构
// 全绑死，业务任一处改形状皮肤就跟着坏。收敛成一份统一形状的快照，
// 皮肤只认 {key,label,kind,items} 这一个契约。
//
// 统一项形状：{id,index,badge,title,artist,duration,cover,current,playing,progress}
// 再加供播放分派用的 ref/source/playlistId/raw。index/badge/current/playing 是
// **这个源里的位置**，与播放队列无关 —— 墙上的序号永远是「本视图第几项」。
// ---------------------------------------------------------------------------

/// 单个视图的取源器。kind 决定墙上点一下怎么落播放：
///   'queue'     播放队列（本地 id，play-index 走 /v1/player/load）
///   'track'     一列普通曲目（本地或在线都能混，交给各自的播放入口）
///   'playlist'  一列**歌单**（点开不是播放，是进歌单内的曲目，见 drillIntoPlaylist）
function viewSourceDef(view) {
  return {
    library: {
      key: 'library',
      label: '本地曲库',
      kind: 'track',
      items: () => state.tracks.map((track, i) => localSourceItem(track, i)),
    },
    online: {
      key: 'online',
      label: '在线曲库',
      kind: 'track',
      items: () => (window.Online ? window.Online.state.tracks : []).map((t, i) => onlineSourceItem(t, i)),
    },
    playlists: {
      key: 'playlists',
      label: '歌单',
      // 歌单视图的墙上是**歌单本身**，不是歌单里的歌。所以 kind 是 playlist：
      // 点开进第二层，而不是直接播 —— 直接播用户根本看不到里面有哪些歌。
      kind: 'playlist',
      items: () => playlistSourceItems(),
    },
    daily: {
      key: 'daily',
      label: '每日推荐',
      kind: 'track',
      items: () => dailySourceItems(),
    },
    favorites: {
      key: 'favorites',
      label: '我的收藏',
      kind: 'track',
      items: () => favoriteSourceItems(),
    },
    queue: {
      key: 'queue',
      label: '播放队列',
      kind: 'queue',
      items: () => queueSnapshot(),
    },
  }[view] || null;
}

/// 当前视图的源快照。皮肤发 qf:panel('source-request') 过来要这个。
function viewSnapshot() {
  const def = viewSourceDef(state.view);
  if (!def) return { key: '', label: '', kind: 'track', items: [], emptyHint: '' };
  let items = [];
  try {
    items = def.items() || [];
  } catch (err) {
    // 取源失败不该让整面墙空掉还报成一片白。给个空源 + 提示，墙上显示空态
    // 文案，用户知道是没内容而不是崩了。取值器都只读内存，正常不会抛 ——
    // 这层是兜底，不是常规路径。
    items = [];
  }
  return {
    key: def.key,
    label: def.label,
    kind: def.kind,
    items,
    emptyHint: sourceEmptyHint(def.key),
  };
}

function sourceEmptyHint(key) {
  return {
    library: '曲库还是空的，先去「本地」导入音乐',
    online: '在线曲库还没有内容，试试搜索或换个分类',
    playlists: '还没有歌单。在歌单页新建一个，或去在线曲库收藏几张',
    daily: '今天的推荐还没加载出来，稍等一下',
    favorites: '还没有收藏。点曲库或在线结果里的红心加进来',
    queue: '队列是空的，先在任意列表里加几首歌',
  }[key] || '这里还没有内容';
}

/// 本地曲库项。state.tracks 的元素就是曲库元数据，id 是本地 id。
function localSourceItem(track, index, sourceKey) {
  const current = track.id === state.snapshot.track_id;
  const duration = Number(track.duration_ms) || 0;
  return {
    id: track.id,
    sourceKey: sourceKey || 'library',
    source: 'local',
    ref: track.id,
    index,
    badge: index + 1,
    title: track.title || '未知曲目',
    artist: track.artist || '未知艺术家',
    duration: duration || null,
    cover: track.has_cover ? transport.coverUrl(track.id) : null,
    current,
    playing: current && state.snapshot.playing,
    progress: current && duration
      ? Math.max(0, Math.min(1, (state.snapshot.position_ms || 0) / duration))
      : 0,
  };
}

/// 在线曲库项。在线曲目是**虚拟 id**（online: 前缀），不在本地库里，
/// 播放只能走 Online.playAll，喂 /v1/player/load 会 404。
function onlineSourceItem(t, index, sourceKey) {
  const Online = window.Online;
  const id = onlineItemId(t);
  const current = id === state.snapshot.track_id;
  const duration = Number(t.duration_ms) || 0;
  return {
    id,
    sourceKey: sourceKey || 'online',
    source: t.source || (Online ? Online.state.source : 'netease'),
    ref: t.ref || t.track_ref || {},
    // 整条原始记录留给播放侧 —— playAll 要 id/artist/album/duration/cover 全套，
    // 快照里只留海报要显示的字段。
    raw: t,
    index,
    badge: index + 1,
    title: t.title || '未知曲目',
    artist: t.artist || '未知艺术家',
    duration: duration || null,
    cover: Online ? Online.safeCoverUrl(t.cover || null) : null,
    current,
    playing: current && state.snapshot.playing,
    progress: current && duration
      ? Math.max(0, Math.min(1, (state.snapshot.position_ms || 0) / duration))
      : 0,
  };
}

/// 在线虚拟 id。online.js 的 virtualId 是闭包私有函数，这里不能直接调，
/// 只能按它的规则重算一遍 —— 规则变了两边会不一致，所以 check-skins.js
/// 钉住了这条表达式。
function onlineItemId(t) {
  if (t.id && String(t.id).startsWith('online:')) return String(t.id);
  const src = t.source || 'netease';
  const ref = t.ref || t.track_ref || t.id;
  const key = typeof ref === 'string' ? ref : (ref && (ref.id || ref.song_id)) || t.id;
  return 'online:' + src + ':' + key;
}

/// 每日推荐项。已按当前 mode（online/local）选源并截断到 LIMIT。
function dailySourceItems() {
  const DV = window.DailyView;
  if (!DV || !DV.state) return [];
  const page = DV.state.mode === 'online' ? DV.state.online : DV.state.local;
  const list = (page && page.tracks ? page.tracks : []).slice(0, 30);
  return list.map((t, i) => (
    t.source ? onlineSourceItem(t, i, 'daily') : localSourceItem(t, i, 'daily')
  ));
}

/// 收藏项。歌曲收藏与电台收藏在同一份 items 里，靠 f.kind 区分；
/// 电台不是单曲，墙上照样展示（标题/艺人齐），点开时由播放侧分派。
function favoriteSourceItems() {
  const F = window.Favorites;
  const items = (F && F.state ? F.state.items : []) || [];
  return items.map((f, i) => {
    const base = f.kind === 'radio'
      ? onlineSourceItem({
        id: f.ref_id,
        source: f.source,
        ref: { id: f.ref_id },
        title: f.title,
        artist: f.artist,
        duration_ms: f.duration_ms,
        cover: f.cover,
      }, i, 'favorites')
      : (f.source === 'local'
        ? localSourceItem({
          id: f.ref_id,
          title: f.title,
          artist: f.artist,
          duration_ms: f.duration_ms,
          has_cover: !!f.cover,
        }, i, 'favorites')
        : onlineSourceItem({
          id: f.ref_id,
          source: f.source,
          ref: { id: f.ref_id },
          title: f.title,
          artist: f.artist,
          album: f.album,
          duration_ms: f.duration_ms,
          cover: f.cover,
        }, i, 'favorites'));
    // 收藏项的 id 是 ref_id（不是虚拟 id），播放侧靠这几个字段认出这是收藏。
    base.favKind = f.kind;
    base.favRefId = f.ref_id;
    base.favSource = f.source;
    return base;
  });
}

/// 歌单项。歌单视图的墙上是**歌单本身**：一张海报 = 一个歌单。
/// 点开进第二层（那个歌单里的歌），所以额外带 playlistId/source/ref/raw。
function playlistSourceItems() {
  const OP = window.OnlinePlaylists;
  const all = OP && OP.all ? OP.all() : [];
  return all.map((entry, i) => {
    const p = entry.playlist || {};
    return {
      // 歌单没有可播放 id，用平台 id 当唯一键。
      id: 'pl:' + entry.source + ':' + (p.id != null ? p.id : i),
      sourceKey: 'playlists',
      source: entry.source,
      sourceLabel: entry.sourceLabel,
      playlistId: p.id,
      ref: p,
      raw: p,
      index: i,
      badge: i + 1,
      title: p.name || '未命名歌单',
      // 歌单的「艺人」位改放来源 + 曲目数 —— 海报上那行小字更有信息量。
      artist: (p.track_count != null ? p.track_count + ' 首' : '')
        + (entry.sourceLabel ? ' · ' + entry.sourceLabel : ''),
      duration: null,
      cover: p.cover ? onlineSafeCover(p.cover) : null,
      current: false,
      playing: false,
      progress: 0,
      // 播放侧靠这个标记决定「点开 = 进第二层」而不是直接播。
      isPlaylist: true,
    };
  });
}

function onlineSafeCover(url) {
  const Online = window.Online;
  return Online ? Online.safeCoverUrl(url) : url;
}

/// 载入一个在线电台（收藏里的电台用它）。
function playRadioRef(source, refId, name) {
  const OP = window.OnlinePlaylists;
  if (OP && typeof OP.playRef === 'function') {
    OP.playRef(source, refId, name);
    return true;
  }
  toast('该电台来自 ' + source + '，请到「在线」面板登录后载入');
  return false;
}

/// 播某一首时给出的上下文队列。源不是播放队列时，用源里的本地 id 组成一条
/// 同序队列传下去，这样上一首/下一首与进度条在源内也有意义。
function queueForSourceItem(item) {
  const def = viewSourceDef(state.view);
  const list = (def ? def.items() : []) || [];
  const ids = list
    .filter((x) => x && !x.isPlaylist && !String(x.id).startsWith('online:'))
    .map((x) => x.id);
  if (ids.includes(item.id)) return ids;
  // 兜底：源里凑不出一条纯本地队列（在线源 / 收藏电台），退回播放队列。
  return state.queue || [];
}

/// 在线项播放。整份原始记录交给 Online.playAll —— 它要 id/artist/album/
/// duration/cover/ref 全套，海报快照里只留了显示字段。
function playOnlineItem(item) {
  const Online = window.Online;
  if (!Online || typeof Online.playAll !== 'function') {
    toast('在线播放还没准备好', 'error');
    return;
  }
  const def = viewSourceDef(state.view);
  const list = (def ? def.items() : []) || [];
  // 传整份同源列表：playAll 从 tracks[index] 开播，之后 next/prev 才有意义。
  const tracks = list.map((x) => x.raw || x).filter((x) => x && x.id);
  if (!tracks.length) {
    toast('这个来源里没有可播放的曲目', 'error');
    return;
  }
  const at = tracks.findIndex((x) => onlineItemId(x) === item.id);
  Online.playAll(tracks, at >= 0 ? at : 0);
}

/// 点开一张海报。歌单是**进第二层**，其余是播放。
/// d.delta 有值时是「相对步进」（展开卡的上一首/下一首）—— 墙上的序号是
/// **本视图的下标**，不是播放队列下标，所以必须由源来算下一项，不能交给
/// playQueueStep（那走的是 state.queue，传墙上的下标会播错歌）。
function activateSourceItem(d) {
  const item = d.item;
  if (!item) return;
  if (item.isPlaylist && !d.delta) {
    drillIntoPlaylist(item);
    return;
  }
  if (d.delta) {
    const list = walllessSourceItems(item);
    if (!list.length) return;
    const at = list.findIndex((x) => x.id === item.id);
    // 当前项不在源里时从头/从末开始，而不是 -1+1=0 这种巧合。
    let next = at < 0 ? (d.delta > 0 ? 0 : list.length - 1) : at + d.delta;
    if (next < 0) next = list.length - 1;
    if (next >= list.length) next = 0;
    playSourceItem(list[next]);
    return;
  }
  playSourceItem(item);
}

/// 取当前墙上那一列的项。墙上算好了才发 activate，这里按 item 上带的
/// sourceKey 重新取一次（业务侧唯一权威，避免皮肤自己缓存一份列表）。
function walllessSourceItems(item) {
  const def = item && item.sourceKey ? viewSourceDef(item.sourceKey) : null;
  if (!def) return [];
  return def.items() || [];
}

/// 播放某个源里的一项。分派依据是它带的是哪种 id —— 这层判据必须与
/// viewSnapshot 造 id 的那几处保持一致（同一条规则，见 onlineItemId）。
function playSourceItem(item) {
  if (!item) return;
  // 播放队列那一份已经带好了 id，直接走队列路径（顺序播放语义要对）。
  if (item.queueItem) {
    playQueueIndex(item.index);
    return;
  }
  // 电台收藏：整盘载入，不是一首。
  if (item.favKind === 'radio') {
    playRadioRef(item.favSource, item.favRefId, item.title);
    return;
  }
  // 在线虚拟 id：本地库里没有，喂 /v1/player/load 必 404。
  if (String(item.id).startsWith('online:')) {
    playOnlineItem(item);
    return;
  }
  // 本地 id。
  transport.post('/v1/player/load', {
    track_id: item.id,
    queue: queueForSourceItem(item),
  });
}

/// 展开一个歌单：拉它的曲目，交给皮肤进第二层。
/// 歌单页的墙上是歌单，所以这一层是「点歌单 → 看歌单里的歌」，
/// 不能直接播 —— 直接播用户根本不知道自己听的是哪个歌单。
///
/// 同步返回（不进网络等待）：拉歌单是异步的，皮肤那边拿到的是 pending
/// 标记并自己转 loading；这里只在**参数就已经不对**时同步报错。
function drillIntoPlaylist(item) {
  const source = item.source;
  const playlistId = item.playlistId;
  if (!source || playlistId == null) {
    return { error: '这个歌单缺少平台信息，无法展开' };
  }
  if (window.OnlinePlaylists && typeof window.OnlinePlaylists.drillTracks === 'function') {
    return { source, playlistId, name: item.title, drill: true };
  }
  return { error: '歌单展开功能还没准备好' };
}

// 从队列里挑一首播。在线虚拟 id 不在本地库里，load 查不到会 404，
// 与 renderQueue 的点击处理同款提示，避免墙上点一下弹看不懂的错误。
function playQueueIndex(index) {
  const list = state.queue || [];
  const id = list[index];
  if (!id) return;
  if (id.startsWith('online:')) {
    toast('在线曲目已失效，请从歌单或收藏重新点播', 'error');
    return;
  }
  transport.post('/v1/player/load', { track_id: id, queue: list });
}

function playQueueStep(delta) {
  const list = state.queue || [];
  if (!list.length) return;
  const cur = list.indexOf(state.snapshot.track_id);
  // 当前不在队列里时，从头（或从末）开始，而不是 -1 + 1 = 0 这种巧合。
  let next = cur < 0 ? (delta > 0 ? 0 : list.length - 1) : cur + delta;
  if (next < 0) next = list.length - 1;
  if (next >= list.length) next = 0;
  playQueueIndex(next);
}

// ---------------------------------------------------------------------------
// 播放栏显隐：15s 无操作自动隐藏 + 底部热区唤出 + 手动切换
// ---------------------------------------------------------------------------
function initBarAutohide() {
  const bar = document.querySelector('.bar');
  if (!bar) return;
  const HIDE_MS = 15000;
  const LEAVE_MS = 800;
  const STORE_KEY = 'vmusic.bar.pinned.v1';

  let pinned = true;
  try { if (localStorage.getItem(STORE_KEY) === '0') pinned = false; } catch (e) { /* ignore */ }
  let idle = false;
  let peek = false;
  let hideTimer = null;
  let leaveTimer = null;
  let sliding = false;

  // 隐藏状态下的底部唤出热区（鼠标移到屏幕最底部即唤出）
  const zone = document.createElement('div');
  zone.className = 'bar-hover-zone';
  zone.setAttribute('aria-hidden', 'true');
  document.body.appendChild(zone);

  // 手动显隐切换按钮（播放栏最右侧）
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.id = 'bar-pin-toggle';
  toggleBtn.className = 'btn-pill bar-pin-toggle';
  toggleBtn.title = '隐藏播放栏';
  toggleBtn.setAttribute('aria-label', '隐藏或显示播放控制栏');
  toggleBtn.setAttribute('aria-pressed', 'false');
  toggleBtn.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-chevron-down"/></svg>';
  const barRight = document.querySelector('.bar-right');
  if (barRight) barRight.appendChild(toggleBtn);

  function persist() {
    try { localStorage.setItem(STORE_KEY, pinned ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  // 下滑 → 收起（display:none，空间让给主内容）
  function hideBar() {
    if (bar.classList.contains('is-hidden') || sliding) return;
    sliding = true;
    bar.style.transition = 'transform 0.32s var(--ease-out), opacity 0.25s ease';
    bar.style.transform = 'translateY(calc(100% + 20px))';
    bar.style.opacity = '0';
    bar.addEventListener('transitionend', function onEnd(ev) {
      if (ev.target !== bar) return;
      bar.removeEventListener('transitionend', onEnd);
      finishHide();
    });
    // 保底：个别环境 transitionend 不可靠时不卡在半空中
    setTimeout(finishHide, 600);
  }
  function finishHide() {
    if (!sliding) return;
    sliding = false;
    bar.classList.add('is-hidden');
    bar.style.transition = '';
    bar.style.transform = '';
    bar.style.opacity = '';
  }

  // 展开（先离屏布局，再上滑，避免可见的重排跳变）
  function showBar() {
    if (!bar.classList.contains('is-hidden')) return;
    bar.classList.remove('is-hidden');
    bar.style.transform = 'translateY(calc(100% + 20px))';
    bar.style.opacity = '0';
    void bar.offsetHeight;
    requestAnimationFrame(() => {
      bar.style.transition = 'transform 0.32s var(--ease-out), opacity 0.3s ease';
      bar.style.transform = '';
      bar.style.opacity = '';
      setTimeout(() => {
        bar.style.transition = '';
        bar.style.transform = '';
        bar.style.opacity = '';
      }, 360);
    });
  }

  function sync() {
    const visible = peek || (pinned && !idle);
    document.body.classList.toggle('bar-hidden', !visible);
    toggleBtn.setAttribute('aria-pressed', String(!visible));
    toggleBtn.title = visible ? '隐藏播放栏' : '显示播放栏';
    if (visible) showBar();
    else hideBar();
  }

  function armIdle() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { idle = true; sync(); }, HIDE_MS);
  }

  function beginPeek() {
    clearTimeout(leaveTimer);
    if (!peek) { peek = true; sync(); }
  }
  function endPeekSoon() {
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => { peek = false; sync(); }, LEAVE_MS);
  }

  // 底部热区唤出
  zone.addEventListener('pointerenter', beginPeek);
  zone.addEventListener('pointermove', beginPeek);
  // 鼠标/焦点在播放栏上时保持显示，离开再按当前状态收起
  bar.addEventListener('pointerenter', beginPeek);
  bar.addEventListener('pointerleave', endPeekSoon);
  bar.addEventListener('focusin', beginPeek);
  bar.addEventListener('focusout', endPeekSoon);

  // 全局活动重置 15s 计时（节流，避免 mousemove 风暴）
  let lastArm = 0;
  function onActivity() {
    const now = Date.now();
    if (now - lastArm < 500) return;
    lastArm = now;
    if (idle) { idle = false; if (!peek) sync(); }
    armIdle();
  }
  ['pointerdown', 'keydown', 'mousemove'].forEach((type) =>
    document.addEventListener(type, onActivity, { passive: true }));

  // 手动切换：用户意图持久化；手动隐藏后只有底部热区能唤出
  toggleBtn.addEventListener('click', () => {
    pinned = !pinned;
    persist();
    if (pinned) { idle = false; peek = false; }
    armIdle();
    sync();
  });

  armIdle();
  sync();
}

function post(path) { return transport.post(path, {}).catch((err) => toast(errText('操作失败', err), 'error')); }

// ---------------------------------------------------------------------------
// 创意舞台
//
// 只负责依次初始化表现层模块（三维引擎 / 背景 / 手绘 / 工坊），一行业务渲染
// 逻辑都没有。三维引擎不再替换右栏粒子层：它只服务于工坊的实时预览与
// 沉浸声场里挂载的镜头层。背景与手绘各自独立生效，WebGL 不可用也照样能用。
// ---------------------------------------------------------------------------

function initCreative() {
  if (window.CreativeStage) CreativeStage.init();
  if (window.StageCinema) StageCinema.init();
  if (window.StageFreecam) StageFreecam.init();
  if (window.StageFocus) StageFocus.init();
  if (window.Backgrounds) Backgrounds.init();
  if (window.HandDrawn) HandDrawn.init();
  if (window.Workshop) Workshop.init();

  // 「高级编排」目标不再经由这里做任何事：既不替主页强行打开增强渲染
  // （那会当场改掉右侧播放视窗的画面），也不拉起旧的全屏歌词页。参数改动
  // 在用户自己开启的增强渲染里实时生效，没开启就是纯编辑。
  const openWs = () => { if (window.Workshop) Workshop.toggle(); };
  if (ui.workshopBtn) ui.workshopBtn.addEventListener('click', openWs);
  if (ui.setWorkshopBtn) ui.setWorkshopBtn.addEventListener('click', openWs);
}

let playbackCommandEpoch = 0;

async function setPlayback(action) {
  const epoch = ++playbackCommandEpoch;
  if (action === 'stop') seekRequestEpoch += 1;
  const previous = state.snapshot;
  const wasStopped = state.stopped;
  state.commandAt = 0;
  state.stopped = action === 'stop';
  state.expectedPlaying = action === 'play';
  applySnapshot({ ...previous, playing: state.expectedPlaying,
    position_ms: action === 'stop' ? 0 : previous.position_ms });
  state.commandAt = Date.now();
  state.commandPending = true;
  const command = transport.post(`/v1/player/${action}`, {});
  const intent = PlaybackIntent.generation;
  state.commandIntent = intent;
  try {
    await command;
  } catch (error) {
    if (epoch !== playbackCommandEpoch || !PlaybackIntent.current(intent)) return;
    state.commandAt = 0;
    state.commandPending = false;
    state.stopped = wasStopped;
    const snapshot = await transport.get('/v1/state').catch(() => previous);
    if (epoch === playbackCommandEpoch && PlaybackIntent.current(intent)) applySnapshot(snapshot);
    toast(errText('播放操作失败', error), 'error');
  } finally {
    if (epoch === playbackCommandEpoch) state.commandPending = false;
  }
}

function togglePlay() {
  return setPlayback(state.snapshot.playing ? 'pause' : 'play');
}

// 停止与暂停在快照里无法区分（playing 都变 false、track_id 都留着），
// 所以这里自己记一笔，空闲收起才知道「这一下是停，不是暂停」。
function stopPlayback() {
  cancelSeek();
  return setPlayback('stop');
}

// ---------------------------------------------------------------------------
// 播放控制弹窗（顶栏「正在播放」）
// ---------------------------------------------------------------------------

const np = {
  modal: $('np-modal'), scrim: $('np-scrim'), close: $('np-close'),
  art: $('np-art'), name: $('np-name'), artist: $('np-artist'),
  time: $('np-time'), bar: $('np-progress-bar'),
  play: $('np-playpause'), prev: $('np-prev'), next: $('np-next'), stop: $('np-stop'),
  volume: $('np-volume'), goto: $('np-goto-stage'),
  // 歌词控件（来源徽标 / 导入 / 清除 / 每曲偏移）
  lyricSource: $('np-lyric-source'), lyricImport: $('np-lyric-import'),
  lyricClear: $('np-lyric-clear'), lyricFile: $('np-lyric-file'),
  lyricOffset: $('np-lyric-offset'), lyricOffsetValue: $('np-lyric-offset-value'),
  lyricOffsetDown: $('np-lyric-offset-down'), lyricOffsetUp: $('np-lyric-offset-up'),
  lyricOffsetMs: 0,
};

function isNpOpen() {
  return !!np.modal && !np.modal.hidden;
}

function openNowPlaying() {
  np.scrim.hidden = false;
  np.modal.hidden = false;
  // 弹窗内音量与底部播放栏保持一致
  np.volume.value = ui.volume.value;
  syncNpSnapshot(state.snapshot);
  if (state.current) {
    syncNpTrack(state.current, Stage && Stage.coverUrl());
    // 打开时重拉一次歌词：导入/偏移可能在别的会话改过，徽标要跟服务端对齐。
    refreshLyrics(state.current.id, state.current).catch(() => {});
  }
}

function closeNowPlaying() {
  np.scrim.hidden = true;
  np.modal.hidden = true;
}

// 播放快照 → 弹窗（播放态 / 时间 / 进度）
function syncNpSnapshot(snap) {
  if (!isNpOpen()) return;
  np.play.classList.toggle('is-playing', snap.playing);
  np.play.setAttribute('aria-label', snap.playing ? '暂停' : '播放');
  renderPlaybackProgress(snap);
}

// ---------------------------------------------------------------------------
// 胶囊播放器（最小化态）
// ---------------------------------------------------------------------------

const CAPSULE_KEY = 'vmusic.capsule.minimized';
const CAPSULE_POS_KEY = 'vmusic.capsule.pos';
const PLAYER_WORKBENCH = 'io.github.oncemisery.hertz-studio.player';
// 拖拽与点击的位移阈值：小于它算「点了一下」（展开），大于才算拖。
const CAPSULE_DRAG_PX = 4;
// 页内最小化态：离边多远开始吸附；20 与默认外边距同值，吸上之后正好落回默认位。
// 浮动实例的吸附由宿主按屏幕工作区做，与这两个常量无关。
const CAPSULE_SNAP_PX = 28;
const CAPSULE_MARGIN = 20;
let lastNowCover = null;

/// 胶囊定位。CSS 里默认锚在 right/bottom，一旦拖过就换成内联 left/top——两种
/// 锚不能同时生效，换锚时必须把另一边显式置 auto。坐标 clamp 进当前视口。
function placeCapsule(x, y) {
  const r = ui.capsule.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  x = Math.max(8, Math.min(vw - r.width - 8, x));
  y = Math.max(8, Math.min(vh - r.height - 8, y));
  const s = ui.capsule.style;
  s.left = Math.round(x) + 'px';
  s.top = Math.round(y) + 'px';
  s.right = 'auto';
  s.bottom = 'auto';
  return { x: Math.round(x), y: Math.round(y) };
}

/// 靠边/靠角吸附：哪条边近贴哪条，两条都近就吸成角，都不近则留在松手处。
function snapCapsule(x, y) {
  const r = ui.capsule.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const dl = x, dr = vw - r.width - x, dt = y, db = vh - r.height - y;
  if (Math.min(dl, dr) < CAPSULE_SNAP_PX) x = dl < dr ? CAPSULE_MARGIN : vw - r.width - CAPSULE_MARGIN;
  if (Math.min(dt, db) < CAPSULE_SNAP_PX) y = dt < db ? CAPSULE_MARGIN : vh - r.height - CAPSULE_MARGIN;
  return placeCapsule(x, y);
}

function saveCapsulePos(p) {
  try { localStorage.setItem(CAPSULE_POS_KEY, p.x + ',' + p.y); } catch (err) { /* 偏好丢一次无所谓 */ }
}

/// 回放上次位置。只在胶囊可见时调：隐藏态量出来是 0×0，会把坐标写坏。
function restoreCapsulePos() {
  let raw = null;
  try { raw = localStorage.getItem(CAPSULE_POS_KEY); } catch (err) { raw = null; }
  const m = raw ? /^(\d+),(\d+)$/.exec(raw) : null;
  if (m) placeCapsule(+m[1], +m[2]);
}

/// 浮动实例（surface === 'window'）的初始态：整页只留胶囊。与 tab 内最小化共用
/// 同一套隐藏规则，但胶囊常显，点击是「跳回主工作台 tab」——浮窗里展开没有意义，
/// 那里只有一个胶囊大小。位置、拖动、贴边吸附全归宿主窗口管：页内不再绝对定位，
/// 页面与胶囊同色（宿主的不透明窗口读作一张卡片），胶囊自己画形状
/// （见 style.css 的 is-floating-capsule）。
function enterFloatingCapsule() {
  document.body.classList.add('is-floating-capsule');
  ui.capsule.hidden = false;
  // syncCapsule 末尾会把窗口收到胶囊尺寸（见 fitFloatingWindowToCapsule）。
  syncCapsule(state.current, lastNowCover);
}

/// 把浮动窗口收到胶囊的实际尺寸。宿主按 open() 里给的估值开窗，内容量出来之后再
/// 回一次真实尺寸，胶囊才不会浮在一片空白里（或被窗口裁掉）。每次同步曲目都重算：
/// 换皮肤可能换字体与字号，窗口尺寸得跟着文字走，不能只量开机那一次。
function fitFloatingWindowToCapsule() {
  const floating = window.dbxPlugin && window.dbxPlugin.floating;
  if (!floating || !floating.setSize) return;
  const r = ui.capsule.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return;
  floating.setSize(Math.ceil(r.width), Math.ceil(r.height)).catch(() => {});
}

/// 最小化 / 展开。隐藏整界面靠 body.is-capsule 一把罩（见 style.css），不逐个
/// 容器列名单——皮肤会改栅格的类名与层级，列名单必然漏。播放不受影响：最小化
/// 只是把文档流里的界面藏起来，音频与事件链路照旧跑。
function setCapsuleMinimized(min) {
  state.capsuleMin = !!min;
  document.body.classList.toggle('is-capsule', !!min);
  ui.capsule.hidden = !min;
  try { localStorage.setItem(CAPSULE_KEY, min ? '1' : ''); } catch (err) { /* 偏好丢一次无所谓 */ }
  if (min) {
    restoreCapsulePos();
    syncCapsule(state.current, lastNowCover);
  }
}

/// 胶囊态的提示出口。最小化两态（页内 `is-capsule`、浮窗 `is-floating-capsule`）
/// 把除胶囊以外的顶层节点整层 `display:none`（style.css），toast 与在线错误条因此
/// 都看不见——「按到了但这首放不了」和「什么都没按到」在界面上长得一模一样。
/// 同一句话改写进胶囊的文字行，靠既有的轮播滚动读完。
let capsuleNotice = null;
let capsuleNoticeKind = 'info';
let capsuleNoticeTimer = 0;

function capsuleShown() {
  return document.body.classList.contains('is-capsule') || document.body.classList.contains('is-floating-capsule');
}

function noticeCapsule(message, kind) {
  if (!message || !capsuleShown()) return;
  clearTimeout(capsuleNoticeTimer);
  capsuleNotice = message;
  capsuleNoticeKind = kind === 'error' ? 'error' : 'info';
  // 比整页 toast 留得久一点：窗口只有 5em 宽，长句子要滚一轮才看得完。
  capsuleNoticeTimer = setTimeout(clearCapsuleNotice, capsuleNoticeKind === 'error' ? 6000 : 3500);
  paintCapsuleNotice();
}

function clearCapsuleNotice() {
  clearTimeout(capsuleNoticeTimer);
  if (!capsuleNotice) return;
  capsuleNotice = null;
  syncCapsule(state.current, lastNowCover);
}

/// 由 syncCapsule 结尾调用：状态重绘（换曲、换封面、皮肤改字号）不能把正在显示的
/// 提示擦掉，也不能让过期后的曲名留在原地。
function paintCapsuleNotice() {
  if (!capsuleNotice) {
    ui.capsule.classList.remove('is-notice', 'is-notice-error');
    ui.capsule.removeAttribute('title');
    return;
  }
  ui.capsule.classList.add('is-notice');
  ui.capsule.classList.toggle('is-notice-error', capsuleNoticeKind === 'error');
  ui.capsuleTitle.textContent = capsuleNotice;
  ui.capsuleArtist.textContent = '';
  // 浮窗里没有别的出口能看全文，hover 出原生 tooltip 兜住截断。
  ui.capsule.title = capsuleNotice;
}

/// 胶囊内容同步。封面与正在播放位走同一套解析：插件形态下远程地址要先换成
/// data URL（沙箱 CSP 画不出 https 图），未命中先空着、代理落地后回填这一块。
function syncCapsule(track, coverUrl) {
  lastNowCover = coverUrl || null;
  if (!track) {
    ui.capsuleTitle.textContent = '—';
    ui.capsuleArtist.textContent = '';
    ui.capsuleArt.style.backgroundImage = '';
  } else {
    ui.capsuleTitle.textContent = track.title || '未命名';
    ui.capsuleArtist.textContent = [track.artist, track.album].filter(Boolean).join(' · ');
    const apply = (u) => { ui.capsuleArt.style.backgroundImage = u ? `url("${u}")` : ''; };
    const resolved = remoteCover(coverUrl);
    if (resolved === null) {
      apply(null);
      remoteCoverSlot(coverUrl, apply);
    } else {
      apply(resolved);
    }
  }
  // 提示压过曲名：状态重绘不能把刚说出来的话擦掉。
  paintCapsuleNotice();
  // 浮动实例：文字换了尺寸就可能变，窗口跟着收一次（页内最小化态没有窗口可收）。
  if (window.HertzCapsuleOnly) fitFloatingWindowToCapsule();
}

/// 胶囊文字轮播。歌名 / 演唱人的窗口只有 5 / 3 字宽，文字更长时**一个字一个字**
/// 往左滚：每字停一拍，滚到端点多停一会再往回返，比省略号能读全，胶囊也因此
/// 保持窄。格子之间的位移交给 CSS transition 抹成一格一格的滑动；共用一个 rAF，
/// 且只在格子变化时才写 transform。胶囊不可见或减少动效时归位不跑。
const CAPSULE_MARQUEE_STEP_MS = 400;   // 每个字停多久
const CAPSULE_MARQUEE_HOLD_MS = 1200;  // 滚到端点后的停顿
function stepCapsuleMarquee(el, now) {
  const win = el && el.parentNode;
  if (!win || win.clientWidth <= 0) return;
  // 内层是 inline-block：offsetWidth 是未加 transform 的排版宽，正好与窗口比。
  const over = el.offsetWidth - win.clientWidth;
  if (over <= 1) {
    if (el.style.transform) el.style.transform = '';
    el._mqIdx = -1;
    return;
  }
  // 一字宽 ≈ 窗口的字号（CJK 一字一个 em）。只在溢出量变化时重读样式。
  if (el._mqOver !== over) {
    el._mqOver = over;
    el._mqCharW = parseFloat(getComputedStyle(win).fontSize) || 12;
  }
  const charW = el._mqCharW;
  const steps = Math.max(1, Math.ceil(over / charW));
  const sweep = steps * CAPSULE_MARQUEE_STEP_MS;
  const period = (sweep + CAPSULE_MARQUEE_HOLD_MS) * 2;
  const t = now % period;
  let idx;
  if (t < sweep + CAPSULE_MARQUEE_HOLD_MS) idx = Math.min(steps, Math.floor(t / CAPSULE_MARQUEE_STEP_MS));
  else idx = Math.max(0, steps - Math.floor((t - sweep - CAPSULE_MARQUEE_HOLD_MS) / CAPSULE_MARQUEE_STEP_MS));
  if (idx === el._mqIdx) return;
  el._mqIdx = idx;
  el.style.transform = 'translateX(' + (-Math.min(over, idx * charW)).toFixed(1) + 'px)';
}
function tickCapsuleMarquee() {
  if (ui.capsule.hidden || prefersReducedMotion()) {
    if (ui.capsuleTitle.style.transform) ui.capsuleTitle.style.transform = '';
    if (ui.capsuleArtist.style.transform) ui.capsuleArtist.style.transform = '';
    ui.capsuleTitle._mqIdx = -1;
    ui.capsuleArtist._mqIdx = -1;
  } else {
    const now = performance.now();
    stepCapsuleMarquee(ui.capsuleTitle, now);
    stepCapsuleMarquee(ui.capsuleArtist, now);
  }
  requestAnimationFrame(tickCapsuleMarquee);
}

// 曲目信息 → 弹窗（标题 / 艺术家 / 封面）
function syncNpTrack(track, coverUrl) {
  if (!isNpOpen() || !track) return;
  np.name.textContent = track.title || '未命名';
  np.artist.textContent = [track.artist, track.album].filter(Boolean).join(' · ') || '未知艺术家';
  // 调用方有的传已解析的 data URL（换曲主流程），有的传在线元数据里的远程原址
  // （详情补拉回填），所以解析收在这里：插件形态远程地址先占位、代理落地后回填。
  const apply = (u) => { np.art.style.backgroundImage = u ? `url("${u}")` : 'none'; };
  const resolved = remoteCover(coverUrl);
  if (resolved === null) {
    apply(null);
    remoteCoverSlot(coverUrl, apply);
  } else {
    apply(resolved);
  }
}

function initNowPlayingModal() {
  if (!np.modal) return;

  np.close.onclick = closeNowPlaying;
  np.scrim.onclick = closeNowPlaying;

  // 点击/回车「正在播放」区打开弹窗；Enter 与 Space 都要能用（role=button）。
  if (ui.stageBtn) {
    ui.stageBtn.onclick = openNowPlaying;
    ui.stageBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openNowPlaying(); }
    });
  }

  np.play.onclick = togglePlay;
  np.prev.onclick = () => post('/v1/player/previous');
  np.next.onclick = () => post('/v1/player/next');
  np.stop.onclick = () => stopPlayback();

  // 歌词控件：导入读 .lrc 文本按原文入库；偏移每次 ±500ms 直接落库；
  // 两者成功后都重拉歌词，舞台与弹窗徽标一起刷新。
  np.lyricImport.onclick = () => np.lyricFile.click();
  np.lyricFile.onchange = async () => {
    const file = np.lyricFile.files && np.lyricFile.files[0];
    np.lyricFile.value = '';
    const id = state.current && state.current.id;
    if (!file || !id || id.startsWith('online:')) return;
    try {
      const content = await file.text();
      await transport.put(`/v1/tracks/${encodeURIComponent(id)}/lyrics`, { content });
      toast('歌词已导入');
      await refreshLyrics(id, state.current);
    } catch (err) {
      toast(errText('歌词导入失败', err), 'error');
    }
  };
  np.lyricClear.onclick = async () => {
    const id = state.current && state.current.id;
    if (!id || id.startsWith('online:')) return;
    try {
      await transport.del(`/v1/tracks/${encodeURIComponent(id)}/lyrics`);
      toast('已清除导入的歌词');
      await refreshLyrics(id, state.current);
    } catch (err) {
      toast(errText('清除歌词失败', err), 'error');
    }
  };
  const shiftLyricOffset = async (delta) => {
    const id = state.current && state.current.id;
    if (!id || id.startsWith('online:')) return;
    try {
      const offset_ms = Math.max(-60000, Math.min(60000, np.lyricOffsetMs + delta));
      await transport.put(`/v1/tracks/${encodeURIComponent(id)}/lyrics/offset`, { offset_ms });
      np.lyricOffsetMs = offset_ms;
      np.lyricOffsetValue.textContent = `${offset_ms > 0 ? '+' : ''}${(offset_ms / 1000).toFixed(1)}s`;
      await refreshLyrics(id, state.current);
    } catch (err) {
      toast(errText('保存歌词偏移失败', err), 'error');
    }
  };
  np.lyricOffsetDown.onclick = () => shiftLyricOffset(-500);
  np.lyricOffsetUp.onclick = () => shiftLyricOffset(500);

  // 进度：拖动即时显示时间，松手跳转
  bindSeekRange(np.bar);

  // 音量：与底部播放栏双向同步后走同一条设置链路
  np.volume.oninput = () => {
    ui.volume.value = np.volume.value;
    setVolumeFromInput();
  };

  // 跳转到舞台播放：关闭弹窗并进入沉浸声场（与全屏舞台按钮同一入口同一效果）
  np.goto.onclick = () => {
    closeNowPlaying();
    if (window.Stage3D && Stage3D.open) {
      Stage3D.open();
      setTimeout(function () { if (Stage3D.requestFullscreen) Stage3D.requestFullscreen(); }, 40);
    }
  };
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function startApp() {
  // 插件形态下 localStorage 是替身，得先把宿主里存的界面偏好读回内存，否则下面
  // 这一串 init() 拿到的全是默认值（症状：刷新后主题、皮肤、舞台参数集体丢失）。
  // 独立形态用原生 localStorage，这里是空操作。
  if (window.hertzHost) await window.hertzHost.hydrate();
  // 落盘的在线元数据先喂回内存：队列行第一帧就能显示真名字，不用等补取。
  if (window.Online && window.Online.seedFromStore) window.Online.seedFromStore();
  transport = await chooseTransport();
  if (transport.kind === 'demo') {
    ui.demoBadge.hidden = false;
    toast('未连接本地服务，已进入演示模式', 'info');
  }

  ui.playpause.onclick = togglePlay;
  ui.prev.onclick = () => post('/v1/player/previous');
  ui.next.onclick = () => post('/v1/player/next');
  ui.stop.onclick = () => stopPlayback();
  ui.mode.onclick = () => {
    const order = ['repeat', 'repeat_one', 'shuffle'];
    const next = order[(order.indexOf(state.snapshot.mode) + 1) % order.length];
    // 播放模式写服务端 settings 而不是 localStorage，换浏览器也能保持一致。
    transport.post('/v1/player/mode', { mode: next })
      .then(() => transport.put('/v1/settings', { play_mode: next }).catch(() => {}))
      .catch((err) => toast(errText('切换播放模式失败', err), 'error'));
  };

  bindSeekRange(ui.progress);
  window.addEventListener('blur', () => { if (state.seeking) cancelSeek(); });

  ui.volume.oninput = setVolumeFromInput;

  let searchTimer = null;
  ui.search.oninput = () => {
    ui.searchClear.hidden = ui.search.value === '';
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = ui.search.value.trim();
      // 顶部搜索框的靶子是本地曲库（占位符已标明）：带着关键词时把结果送到
      // 用户眼前——否则停在在线/歌单页敲字毫无反应，观感即「搜索坏了」。
      if (state.q && state.view !== 'library') setView('library');
      loadTracks(true);
    }, 250);
  };
  ui.searchClear.onclick = () => { ui.search.value = ''; ui.searchClear.hidden = true; state.q = ''; loadTracks(true); };

  // 浮光下搜索框默认收着（opacity:0），靠 body.sheen-search 显形。
  // blur 时必须摘掉标记让它收回，否则那条覆盖式搜索条会一直挂在顶栏上。
  ui.search.addEventListener('blur', () => { document.body.classList.remove('sheen-search'); });

  // 无结果卡上的「清空搜索 / 清除筛选」：一键撤掉所有让列表变空的条件。
  if (ui.libEmptyNoMatchClear) {
    ui.libEmptyNoMatchClear.onclick = () => {
      let touched = false;
      if (ui.search.value) {
        ui.search.value = '';
        ui.searchClear.hidden = true;
        state.q = '';
        touched = true;
      }
      if (state.libFilter.artist) {
        state.libFilter.artist = '';
        if (ui.libArtistFilter) ui.libArtistFilter.value = '';
        touched = true;
      }
      if (state.libFilter.album) {
        state.libFilter.album = '';
        if (ui.libAlbumFilter) ui.libAlbumFilter.value = '';
        touched = true;
      }
      if (touched) loadTracks(true);
      ui.search.focus();
    };
  }

  ui.libSort.onchange = () => { state.sort = ui.libSort.value; loadTracks(true); };

  // 专辑/歌手筛选：选择即按覆盖后的展示值精确过滤。
  if (ui.libArtistFilter) {
    ui.libArtistFilter.onchange = () => {
      state.libFilter.artist = ui.libArtistFilter.value;
      loadTracks(true);
    };
  }
  if (ui.libAlbumFilter) {
    ui.libAlbumFilter.onchange = () => {
      state.libFilter.album = ui.libAlbumFilter.value;
      loadTracks(true);
    };
  }

  // 失效整理：列出文件已丢失的曲目，确认后批量移除。列表为空时如实告知。
  if (ui.libCleanup) {
    ui.libCleanup.onclick = async () => {
      try {
        const data = await transport.get('/v1/tracks/missing');
        if (!data.total) { toast('没有失效曲目，曲库很干净'); return; }
        const names = data.missing.slice(0, 8).map((m) => m.title).join('、');
        const more = data.total > 8 ? ' 等' : '';
        if (!(await modal().confirm(`有 ${data.total} 首曲目文件已丢失：${names}${more}。从曲库移除这些条目？（不删除任何文件）`))) return;
        const res = await transport.post('/v1/tracks/batch-delete', { track_ids: data.missing.map((m) => m.id) });
        toast(`已移除 ${res.deleted} 条失效条目`);
        clearSelection();
        loadTracks(true);
        loadFacets();
      } catch (err) {
        toast(errText('失效整理失败', err), 'error');
      }
    };
  }

  // 批量操作栏
  if (ui.libBatchClear) ui.libBatchClear.onclick = clearSelection;
  if (ui.libBatchFav) {
    ui.libBatchFav.onclick = async () => {
      const ids = [...state.selected];
      if (!ids.length) return;
      let added = 0;
      for (const id of ids) {
        const t = state.byId.get(id);
        if (!t) continue;
        try {
          // 幂等添加端点：已收藏的曲目保持原状，不会因为批量操作被反转。
          await transport.post('/v1/favorites', {
            kind: 'track', source: 'local', ref_id: id,
            title: t.title, artist: t.artist, album: t.album,
            duration_ms: t.duration_ms, cover: null,
          });
          added += 1;
        } catch (err) {
          toast(errText(`收藏《${t.title}》失败`, err), 'error');
        }
      }
      if (added) toast(`已收藏 ${added} 首`);
      clearSelection();
    };
  }
  if (ui.libBatchEdit) {
    ui.libBatchEdit.onclick = async () => {
      const ids = [...state.selected];
      if (!ids.length) return;
      const artist = await modal().prompt('批量设置歌手（留空跳过；输入空格清除这些曲目的歌手）', '');
      if (artist === null) return;
      const album = await modal().prompt('批量设置专辑（留空跳过；输入空格清除专辑）', '');
      if (album === null) return;
      const body = { track_ids: ids };
      if (artist.trim()) body.artist = artist.trim();
      if (album.trim()) body.album = album.trim();
      if (artist.trim() === '' && album.trim() === '') { toast('未填写任何字段'); return; }
      if (!body.artist && !body.album) { toast('未填写任何字段'); return; }
      transport.post('/v1/tracks/batch-edit', body)
        .then((res) => { toast(`已更新 ${res.changed} 首`); clearSelection(); loadTracks(true); loadFacets(); })
        .catch((err) => toast(errText('批量编辑失败', err), 'error'));
    };
  }
  // 联网补全（folia 的「整理歌曲信息」）：匹配网易云，只补缺失的
  // 封面/歌词/专辑，不覆盖已有信息。
  //
  // 两阶段：先把整批的候选搜出来（只读、不改库），一次性摆进挑选弹窗，
  // 用户逐行确认后才逐曲落地。运行中再点一次按钮 = 取消。
  if (ui.libBatchComplete) {
    let batchAbort = null;
    ui.libBatchComplete.onclick = async () => {
      if (batchAbort) { batchAbort.abort(); toast('已取消补全'); return; }
      const ids = [...state.selected].filter((id) => !id.startsWith('online:'));
      if (!ids.length) { toast('请先勾选要补全的本地曲目', 'error'); return; }
      const btn = ui.libBatchComplete;
      const original = btn.textContent;
      const controller = new AbortController();
      batchAbort = controller;
      btn.textContent = `匹配中（0/${ids.length}）…`;
      try {
        // 一次最多 50 首，超过自动分批串行。
        const rows = [];
        let suggestFailed = 0;
        for (let i = 0; i < ids.length; i += 50) {
          if (controller.signal.aborted) return;
          const chunk = ids.slice(i, i + 50);
          btn.textContent = `匹配中（${i}/${ids.length}）…`;
          const res = await transport.post('/v1/tracks/complete/suggest', { track_ids: chunk }, { signal: controller.signal });
          for (const r of res.results || []) {
            if (r.status === 'match' || r.status === 'nothing_to_fill') rows.push(completionRow(r));
          }
          suggestFailed += res.failed || 0;
        }
        if (controller.signal.aborted) return;
        if (!rows.length) {
          toast(suggestFailed
            ? `有 ${suggestFailed} 首匹配失败，其余没有可用候选`
            : '没有找到可采纳的匹配');
          return;
        }
        btn.textContent = original;
        const choices = await pickCompletions(
          rows,
          `共 ${rows.length} 首有候选，逐行确认后才会写库；选「不采纳」的曲目以后不再自动匹配。`,
        );
        if (!choices) return;
        btn.disabled = true;
        btn.textContent = `落地中（0/${choices.length}）…`;
        const stats = await applyCompletions(choices, controller.signal, (done, total) => {
          btn.textContent = `落地中（${done}/${total}）…`;
        });
        if (suggestFailed) stats.failed += suggestFailed;
        toast(`整理完成：${completionSummary(stats)}`);
        clearSelection();
        loadTracks(true);
        loadFacets();
      } catch (err) {
        if (err && err.name === 'AbortError') toast('已取消补全');
        else toast(errText('联网补全失败', err), 'error');
      } finally {
        batchAbort = null;
        btn.disabled = false;
        btn.textContent = original;
      }
    };
  }
  // 在线缓存：设置页显示占用与保留名单，进入设置视图时刷新一次。
  const SOURCE_NAMES = { netease: '网易云', qq: 'QQ音乐', kugou: '酷狗', kuwo: '酷我', qishui: '汽水', ccmixter: 'CCMixter' };
  async function loadCacheStats() {
    if (!ui.cacheUsage) return;
    try {
      const stats = await transport.get('/v1/online/cache');
      const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
      ui.cacheUsage.textContent = stats.max_bytes
        ? `${mb(stats.total_bytes)} / ${mb(stats.max_bytes)} · ${stats.files} 个文件`
        : `${mb(stats.total_bytes)} · ${stats.files} 个文件 · 不限容量`;
      // 分项展示：按音源分组（folia 的 cache usage breakdown）。
      if (ui.cacheBreakdown) {
        const bySource = (stats.by_source || []).filter(([, bytes]) => bytes > 0);
        if (bySource.length) {
          ui.cacheBreakdown.hidden = false;
          ui.cacheBreakdown.innerHTML = '';
          for (const [source, bytes] of bySource) {
            const row = document.createElement('div');
            row.className = 'cache-source-row';
            const label = document.createElement('span');
            label.className = 'cache-source-name';
            if (window.Online && window.Online.badge) {
              label.appendChild(window.Online.badge(source));
              label.appendChild(document.createTextNode(` ${SOURCE_NAMES[source] || source}`));
            } else {
              label.textContent = SOURCE_NAMES[source] || source;
            }
            const size = document.createElement('span');
            size.className = 'cache-source-size';
            size.textContent = mb(bytes);
            row.appendChild(label);
            row.appendChild(size);
            ui.cacheBreakdown.appendChild(row);
          }
        } else {
          ui.cacheBreakdown.hidden = true;
        }
      }
      // 上限选择器回填：预设 GB 档位 + 当前值不属于任何档时追加一项。
      if (ui.cacheLimit) {
        const gb = Math.round((stats.max_bytes || 0) / 1024 / 1024 / 1024);
        const known = [...ui.cacheLimit.options].some((o) => Number(o.value) === gb);
        if (!known) {
          const opt = document.createElement('option');
          opt.value = String(gb);
          opt.textContent = `${gb} GB`;
          ui.cacheLimit.appendChild(opt);
        }
        ui.cacheLimit.value = String(gb);
      }
      if (ui.cacheKeepList) {
        const keep = stats.keep || [];
        if (!keep.length) {
          ui.cacheKeepList.hidden = true;
          ui.cacheKeepList.textContent = '';
        } else {
          ui.cacheKeepList.hidden = false;
          ui.cacheKeepList.textContent = `已保留 ${keep.length} 项：${keep.map((k) => k.replace(/-$/, '')).join('、')}`;
        }
      }
    } catch { /* 缓存统计拉取失败不阻塞设置页 */ }
  }
  window.__loadCacheStats = loadCacheStats;
  // 上限热改：写后端 settings + 立即 LRU 回收，回包后刷新占用。
  if (ui.cacheLimit) {
    ui.cacheLimit.onchange = async () => {
      const gb = Number(ui.cacheLimit.value) || 0;
      try {
        await transport.post('/v1/online/cache/limit', { max_bytes: gb * 1024 * 1024 * 1024 });
        toast(gb ? `缓存上限已设为 ${gb} GB` : '缓存上限已设为不限');
        loadCacheStats();
      } catch (err) {
        toast(errText('设置缓存上限失败', err), 'error');
        loadCacheStats();
      }
    };
  }
  // 歌词输出（OBS 浮层）：插件形态没有本地 HTTP 服务，整组隐藏。
  if (ui.overlayGroup) {
    if (window.hertzHost && window.hertzHost.isDbx) {
      ui.overlayGroup.hidden = true;
    } else {
      const overlayUrl = () => `${location.origin}/overlay?token=${encodeURIComponent(TOKEN)}&style=${encodeURIComponent(ui.overlayStyle.value)}`;
      if (ui.overlayCopy) {
        ui.overlayCopy.onclick = async () => {
          try {
            await writeClipboard(overlayUrl());
            toast('浮层地址已复制，粘进 OBS 浏览器源即可');
          } catch (err) {
            toast(errText('复制失败', err), 'error');
          }
        };
      }
      if (ui.overlayOpen) {
        ui.overlayOpen.onclick = () => window.open(overlayUrl(), '_blank');
      }
    }
  }
  // 歌词视频导出：模块自管弹窗与录制管线，这里只提供入口与降级说明。
  if (ui.videoExportGroup) {
    if (window.hertzHost && window.hertzHost.isDbx) {
      ui.videoExportGroup.hidden = true;
    } else if (ui.videoExportOpen) {
      if (window.VideoExport && VideoExport.supported()) {
        ui.videoExportOpen.onclick = () => VideoExport.open();
      } else {
        ui.videoExportOpen.disabled = true;
        ui.videoExportOpen.title = '当前浏览器不支持 MediaRecorder，无法录制';
      }
    }
  }
  if (ui.cacheClear) {
    ui.cacheClear.onclick = async () => {
      try {
        const res = await transport.post('/v1/online/cache/clear', {});
        const mb = (res.removed_bytes / 1024 / 1024).toFixed(1);
        toast(`已清理 ${mb} MB 缓存`);
        loadCacheStats();
      } catch (err) {
        toast(errText('缓存清理失败', err), 'error');
      }
    };
  }
  // 保留当前播放的在线曲目；本地曲没有缓存语义，点了如实提示。
  if (ui.cacheKeepCurrent) {
    ui.cacheKeepCurrent.onclick = async () => {
      const id = state.current && state.current.id;
      if (!id || !id.startsWith('online:')) { toast('当前没有播放在线曲目', 'error'); return; }
      const rest = id.slice('online:'.length);
      const at = rest.indexOf(':');
      if (at <= 0) { toast('在线曲目身份异常', 'error'); return; }
      const source = rest.slice(0, at);
      const onlineId = rest.slice(at + 1);
      try {
        await transport.post('/v1/online/cache/keep', { source, id: onlineId, keep: true });
        toast('已加入保留名单');
        loadCacheStats();
      } catch (err) {
        toast(errText('保留失败', err), 'error');
      }
    };
  }

  // 远程来源（WebDAV）：登记 / 浏览 / 导入。
  const remoteState = { roots: [], browseRootId: null, browsePath: '/', browseEntries: [] };
  async function loadRemoteRoots() {
    if (!ui.remoteRootList) return;
    try {
      const data = await transport.get('/v1/remote/roots');
      remoteState.roots = data.roots || [];
      ui.remoteRootList.hidden = remoteState.roots.length === 0;
      ui.remoteRootList.innerHTML = '';
      for (const root of remoteState.roots) {
        const row = document.createElement('div');
        row.className = 'remote-root';
        row.innerHTML = `
          <span class="remote-root-name"></span>
          <span class="remote-root-url"></span>
          <button class="btn" data-act="browse">浏览</button>
          <button class="btn danger" data-act="delete">删除</button>`;
        row.querySelector('.remote-root-name').textContent = root.name;
        row.querySelector('.remote-root-url').textContent = root.base_url;
        row.querySelector('[data-act="browse"]').onclick = () => openRemoteBrowse(root);
        row.querySelector('[data-act="delete"]').onclick = async () => {
          try {
            await transport.del(`/v1/remote/roots/${encodeURIComponent(root.id)}`);
            toast('远程来源已删除');
            loadRemoteRoots();
          } catch (err) {
            toast(errText('删除失败', err), 'error');
          }
        };
        ui.remoteRootList.appendChild(row);
      }
    } catch { /* 列表拉取失败不阻塞设置页 */ }
  }
  // 与 __loadCacheStats / __loadDspSettings 同模式：setView 在本初始化函数
  // 之外，拿不到嵌套的 loadRemoteRoots，挂到 window 上供其调用。
  window.__loadRemoteRoots = loadRemoteRoots;
  if (ui.remoteAdd) {
    ui.remoteAdd.onclick = async () => {
      const body = {
        name: ui.remoteName.value.trim(),
        base_url: ui.remoteUrl.value.trim(),
        username: ui.remoteUser.value.trim(),
        password: ui.remotePass.value,
      };
      if (!body.name || !body.base_url) { toast('名称与地址必填', 'error'); return; }
      try {
        await transport.post('/v1/remote/roots', body);
        toast('远程来源已添加');
        ui.remotePass.value = '';
        loadRemoteRoots();
      } catch (err) {
        toast(errText('添加失败', err), 'error');
      }
    };
  }
  function setRemoteBrowseVisible(on) {
    if (!ui.remoteBrowse) return;
    ui.remoteBrowse.hidden = !on;
    if (ui.remoteScrim) ui.remoteScrim.hidden = !on;
  }
  function fmtSize(n) {
    if (n == null) return '';
    if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    if (n > 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${n} B`;
  }
  async function renderRemoteBrowse() {
    const root = remoteState.roots.find((r) => r.id === remoteState.browseRootId);
    if (!root || !ui.remoteBrowseList) return;
    ui.remoteBrowseTitle.textContent = root.name;
    ui.remoteBrowsePath.textContent = remoteState.browsePath;
    ui.remoteBrowseStatus.textContent = '';
    ui.remoteBrowseList.innerHTML = '<div class="hint">正在读取目录…</div>';
    try {
      const data = await transport.get(
        `/v1/remote/roots/${encodeURIComponent(root.id)}/browse?path=${encodeURIComponent(remoteState.browsePath)}`);
      remoteState.browseEntries = data.entries || [];
      ui.remoteBrowseList.innerHTML = '';
      // 上一级
      if (remoteState.browsePath !== '/') {
        const up = document.createElement('div');
        up.className = 'remote-row';
        up.innerHTML = '<span class="remote-name">← 上一级</span>';
        up.onclick = () => {
          remoteState.browsePath = remoteState.browsePath.replace(/[^/]+\/$/, '/') || '/';
          renderRemoteBrowse();
        };
        ui.remoteBrowseList.appendChild(up);
      }
      const audioCount = remoteState.browseEntries.filter((e) => e.is_audio).length;
      for (const entry of remoteState.browseEntries) {
        const row = document.createElement('div');
        row.className = 'remote-row';
        const icon = entry.is_dir ? '📁' : (entry.is_audio ? '♪' : '·');
        row.innerHTML = `<span>${icon}</span><span class="remote-name"></span><span class="remote-size"></span>
          ${entry.is_audio ? '<button class="btn" data-act="import">导入</button>' : ''}`;
        row.querySelector('.remote-name').textContent = entry.name;
        row.querySelector('.remote-size').textContent = fmtSize(entry.size);
        if (entry.is_dir) {
          row.onclick = () => {
            remoteState.browsePath = entry.path.endsWith('/') ? entry.path : `${entry.path}/`;
            renderRemoteBrowse();
          };
        }
        const importBtn = row.querySelector('[data-act="import"]');
        if (importBtn) {
          importBtn.onclick = async (e) => {
            e.stopPropagation();
            importBtn.disabled = true;
            try {
              const res = await transport.post(`/v1/remote/roots/${encodeURIComponent(root.id)}/import`, { paths: [entry.path] });
              toast(res.imported ? '已导入曲库' : '已在曲库中');
            } catch (err) {
              toast(errText('导入失败', err), 'error');
              importBtn.disabled = false;
            }
          };
        }
        ui.remoteBrowseList.appendChild(row);
      }
      ui.remoteBrowseStatus.textContent = `${remoteState.browseEntries.length} 项 · ${audioCount} 首可导入`;
      ui.remoteImportDir.disabled = audioCount === 0;
    } catch (err) {
      // 断网/鉴权失败：如实展示错误，可关闭后重试，不伪造空目录。
      ui.remoteBrowseList.innerHTML = '';
      ui.remoteBrowseStatus.textContent = errText('读取失败', err);
      ui.remoteImportDir.disabled = true;
    }
  }
  async function openRemoteBrowse(root) {
    remoteState.browseRootId = root.id;
    remoteState.browsePath = '/';
    setRemoteBrowseVisible(true);
    await renderRemoteBrowse();
  }
  if (ui.remoteBrowseClose) {
    ui.remoteBrowseClose.onclick = () => setRemoteBrowseVisible(false);
  }
  if (ui.remoteScrim) ui.remoteScrim.onclick = () => setRemoteBrowseVisible(false);
  if (ui.remoteImportDir) {
    ui.remoteImportDir.onclick = async () => {
      const root = remoteState.roots.find((r) => r.id === remoteState.browseRootId);
      if (!root) return;
      const paths = remoteState.browseEntries.filter((e) => e.is_audio).map((e) => e.path);
      if (!paths.length) { toast('本目录没有音频文件', 'error'); return; }
      try {
        const res = await transport.post(`/v1/remote/roots/${encodeURIComponent(root.id)}/import`, { paths });
        toast(`已导入 ${res.imported} 首（${res.skipped} 首已在库）`);
      } catch (err) {
        toast(errText('导入失败', err), 'error');
      }
    };
  }

  // 音效与均衡器：进设置页拉取当前配置回填；保存后立即生效。
  async function loadDspSettings() {
    if (!ui.dspEq) return;
    try {
      const cfg = await transport.get('/v1/player/dsp');
      ui.dspEq.querySelectorAll('input[data-band]').forEach((input) => {
        input.value = cfg.eq_gains_db[Number(input.dataset.band)] || 0;
      });
      ui.dspPreamp.value = cfg.preamp_db;
      // 三档响度：旧后端可能仍回布尔 loudness_norm，true 视作 track。
      ui.dspLoudness.value = (typeof cfg.loudness_mode === 'string' && cfg.loudness_mode)
        || (cfg.loudness_norm ? 'track' : 'off');
      ui.dspCrossfade.value = cfg.crossfade_ms;
    } catch { /* 设置读取失败不阻塞 */ }
  }
  window.__loadDspSettings = loadDspSettings;
  if (ui.dspSave) {
    ui.dspSave.onclick = async () => {
      try {
        const body = {
          eq_gains_db: [...ui.dspEq.querySelectorAll('input[data-band]')]
            .map((i) => Number(i.value)),
          preamp_db: Number(ui.dspPreamp.value) || 0,
          loudness_mode: ui.dspLoudness.value || 'off',
          crossfade_ms: Math.max(0, Number(ui.dspCrossfade.value) || 0),
        };
        await transport.post('/v1/player/dsp', body);
        toast('音效设置已保存');
      } catch (err) {
        toast(errText('保存失败', err), 'error');
      }
    };
  }
  if (ui.dspReset) {
    ui.dspReset.onclick = () => {
      ui.dspEq.querySelectorAll('input[data-band]').forEach((i) => { i.value = 0; });
      ui.dspPreamp.value = 0;
      ui.dspLoudness.value = 'off';
      ui.dspCrossfade.value = 0;
    };
  }

  // 数据备份：导出下载 JSON；导入读文件后按幂等语义恢复。
  if (ui.backupExport) {
    ui.backupExport.onclick = async () => {
      try {
        const data = await transport.get('/v1/backup');
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mmusic-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toast('备份已导出');
      } catch (err) {
        toast(errText('备份导出失败', err), 'error');
      }
    };
  }
  if (ui.backupImport && ui.backupFile) {
    ui.backupImport.onclick = () => ui.backupFile.click();
    ui.backupFile.onchange = async () => {
      const file = ui.backupFile.files && ui.backupFile.files[0];
      ui.backupFile.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        let parsed;
        try { parsed = JSON.parse(text); } catch { throw new Error('不是有效的 JSON 备份文件'); }
        const res = await transport.post('/v1/backup/restore', parsed);
        toast(`恢复完成：新建歌单 ${res.playlists_created}、合并 ${res.playlists_merged}、收藏 ${res.favorites_added} 条`);
        loadPlaylists();
        loadTracks(true);
        loadSettings();
        loadFacets();
      } catch (err) {
        toast(errText('备份导入失败', err), 'error');
      }
    };
  }
  // M3U 导入：新建歌单，路径匹配本地曲目。
  if (ui.m3uImport && ui.m3uFile) {
    ui.m3uImport.onclick = () => ui.m3uFile.click();
    ui.m3uFile.onchange = async () => {
      const file = ui.m3uFile.files && ui.m3uFile.files[0];
      ui.m3uFile.value = '';
      if (!file) return;
      const name = file.name.replace(/\.(m3u8?|M3U8?)$/, '') || '导入歌单';
      try {
        const content = await file.text();
        const res = await transport.post('/v1/playlists/import-m3u', { name, content });
        toast(`已导入《${name}》：匹配 ${res.added} 首，未匹配 ${res.skipped} 首`);
        loadPlaylists();
      } catch (err) {
        toast(errText('M3U 导入失败', err), 'error');
      }
    };
  }

  if (ui.libBatchPlaylist) {
    ui.libBatchPlaylist.onclick = (e) => {
      // 菜单是在这同一次点击里建起来的，而 document 上那条「点不到 #ctx-menu 就
      // closeMenu()」的监听会在冒泡阶段立刻把它清空——按钮看起来就是点了没反应。
      // 行内「更多」与 online.js 的加入歌单都挡了冒泡，这里同样得挡。
      e.stopPropagation();
      const ids = [...state.selected];
      if (!ids.length) return;
      if (!state.playlists.length) { toast('还没有自建歌单，先到「歌单」页新建一个', 'error'); return; }
      ui.menu.innerHTML = '';
      buildMenu(ui.menu, state.playlists.map((p) => ({
        label: p.name,
        run: () => {
          transport.post(`/v1/playlists/${p.id}/tracks`, { track_ids: ids })
            .then(() => { toast(`已把 ${ids.length} 首加入《${p.name}》`); clearSelection(); loadPlaylists(); })
            .catch((err) => toast(errText('加入歌单失败', err), 'error'));
        },
      })));
      showMenu(window.innerWidth / 2 - 80, window.innerHeight / 3);
    };
  }

  ui.scanToggle.onclick = () => {
    ui.scanPanel.hidden = !ui.scanPanel.hidden;
    if (!ui.scanPanel.hidden) { loadScanRoots(); refreshScanStatus(); }
  };
  $('empty-scan-btn').onclick = () => { ui.scanPanel.hidden = false; ui.scanRoot.focus(); };
  // 轻空态条上的同名按钮：同一件事，另一个入口（在线推荐来源下列表区那行提示）。
  const emptyStripScan = $('empty-strip-scan');
  if (emptyStripScan) emptyStripScan.onclick = () => { ui.scanPanel.hidden = false; ui.scanRoot.focus(); };
  ui.scanBtn.onclick = startScan;
  ui.scanCancel.onclick = async () => {
    ui.scanCancel.disabled = true;
    try { await transport.post('/v1/library/scan/cancel'); await refreshScanStatus(); }
    catch (err) { ui.scanCancel.disabled = false; toast(errText('取消扫描失败', err), 'error'); }
  };

  // 新建歌单：按钮与输入框回车同一入口。成功后架子转到位——新歌单追加在
  // 集合末尾，架子只摆中心附近的几张卡，不主动聚焦时用户看到的就是「没反应」。
  async function createPlaylist() {
    const name = ui.newPlaylistName.value.trim();
    if (!name) return;
    let created = null;
    try {
      created = await transport.post('/v1/playlists', { name });
    } catch (e) {
      toast(errText('创建失败', e), 'error');
      return;
    }
    ui.newPlaylistName.value = '';
    toast(`已创建《${name}》`);
    await loadPlaylists();
    if (shelf && created && created.id) shelf.focusId(created.id);
  }
  ui.newPlaylistBtn.onclick = createPlaylist;
  ui.newPlaylistName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); createPlaylist(); }
  });

  // 歌单详情头部
  const currentDetailPl = () => state.playlists.find((p) => p.id === detailPlaylistId);
  if (ui.plDetailM3u) {
    ui.plDetailM3u.onclick = async () => {
      if (!detailPlaylistId) return;
      const encoded = encodeURIComponent(detailPlaylistId);
      // 插件 iframe 没有 allow-popups，window.open 会被静默丢弃；而且也没有
      // 可直连的下载 URL。改成取回文本再交给宿主的 saveFile。
      if (window.hertzHost && window.hertzHost.isDbx) {
        try {
          const text = await transport.get(`/v1/playlists/${encoded}/m3u`);
          await saveTextFile(`playlist-${detailPlaylistId}.m3u`, 'audio/x-mpegurl',
            typeof text === 'string' ? text : '');
          toast('已导出 m3u');
        } catch (err) {
          toast(errText('导出 m3u 失败', err), 'error');
        }
        return;
      }
      // 走带 token 的链接下载：coverUrl 同款 query 参数通道。
      window.open(`/v1/playlists/${encoded}/m3u?token=${encodeURIComponent(TOKEN)}`, '_blank');
    };
  }
  ui.plDetailBack.onclick = () => closeDetail();
  ui.plDetailPlay.onclick = () => { if (detailPlaylistId) playPlaylist(detailPlaylistId); };
  ui.plDetailQueue.onclick = () => { const p = currentDetailPl(); if (p) queuePlaylistNext(p.id); };
  ui.plDetailRename.onclick = () => { const p = currentDetailPl(); if (p) renamePlaylist(p); };
  ui.plDetailDelete.onclick = () => { const p = currentDetailPl(); if (p) deletePlaylist(p); };
  initDetailSortable();

  ui.queueClear.onclick = () => applyQueue(state.snapshot.track_id ? [state.snapshot.track_id] : [], true);

  // 队列存为歌单（folia 的 saveCurrentQueueAsLocalPlaylist）：本地曲目收进
  // 本地歌单；在线曲目按音源拆组，各存进对应平台的在线歌单（仅限已登录且
  // 具备 playlist_write 能力的源）。各部分独立成败，最后汇总提示。
  if (ui.queueSave) {
    ui.queueSave.onclick = async () => {
      const localIds = state.queue.filter((id) => !id.startsWith('online:'));
      const onlineGroups = {};
      let onlineCount = 0;
      for (const id of state.queue) {
        if (!id.startsWith('online:')) continue;
        const parts = id.split(':');
        const source = parts[1] || '';
        const trackId = parts.slice(2).join(':'); // 平台 id 自身可能含冒号
        if (!source || !trackId) continue;
        (onlineGroups[source] = onlineGroups[source] || []).push(trackId);
        onlineCount += 1;
      }
      if (!localIds.length && !onlineCount) { toast('队列为空', 'error'); return; }

      const scope = onlineCount
        ? (localIds.length ? `本地 ${localIds.length} 首和在线 ${onlineCount} 首（按音源拆分）` : `在线 ${onlineCount} 首（按音源拆分）`)
        : `本地 ${localIds.length} 首`;
      const fallback = `播放队列 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
      const name = await modal().prompt(`把队列里的${scope}曲目存为歌单`, fallback);
      if (name === null) return;
      const trimmed = name.trim();
      if (!trimmed) { toast('歌单名称不能为空', 'error'); return; }

      const saved = [];
      const problems = [];

      if (localIds.length) {
        try {
          const created = await transport.post('/v1/playlists', { name: trimmed });
          await transport.post(`/v1/playlists/${created.id}/tracks`, { track_ids: localIds });
          saved.push(`本地 ${localIds.length} 首`);
        } catch (err) {
          problems.push(errText('本地歌单保存失败', err));
        }
      }

      if (onlineCount) {
        // 能力表拉不到时不拦人，逐源直接尝试（后端 gate 会给出具体原因）。
        let writable = null;
        try {
          const list = await transport.get('/v1/online/sources');
          writable = {};
          for (const s of list.sources || []) {
            if ((s.caps || []).includes('playlist_write')) writable[s.id] = s.label || s.id;
          }
        } catch (err) { writable = null; }
        for (const [source, ids] of Object.entries(onlineGroups)) {
          const label = (writable && writable[source]) || source;
          if (writable && !writable[source]) {
            problems.push(`${label}：该音源不支持写歌单（或未登录）`);
            continue;
          }
          try {
            const pl = await transport.post('/v1/online/playlist', { source, name: trimmed });
            await transport.post('/v1/online/playlist/tracks/add', {
              source, id: pl.id, tracks: ids.map((trackId) => ({ id: trackId })),
            });
            saved.push(`${label} ${ids.length} 首`);
          } catch (err) {
            problems.push(errText(`${label} 保存失败`, err));
          }
        }
      }

      if (saved.length) {
        toast(`已保存《${trimmed}》（${saved.join('、')}）${problems.length ? `；另有 ${problems.join('；')}` : ''}`);
        loadPlaylists();
      } else if (problems.length) {
        toast(`保存歌单失败：${problems.join('；')}`, 'error');
      }
    };
  }

  ui.setDevice.onchange = () => transport.post('/v1/devices/select', { id: ui.setDevice.value }).catch(() => {});
  initRenderMode();

  ui.setDensity.onchange = () => {
    markSettingsDirty();
    state.settings.ui_density = ui.setDensity.value;
    document.body.dataset.density = ui.setDensity.value;
    transport.put('/v1/settings', { ui_density: ui.setDensity.value }).catch(() => {});
  };
  ui.setMotion.onchange = () => {
    markSettingsDirty();
    state.settings.reduce_motion = ui.setMotion.checked;
    document.body.classList.toggle('reduce-motion', ui.setMotion.checked);
    if (Stage) Stage.setReducedMotion(ui.setMotion.checked);
    transport.put('/v1/settings', { reduce_motion: ui.setMotion.checked }).catch(() => {});
  };
  // 播放行为偏好：写服务端设置表（通用 KV），启动时随 GET /v1/settings 回来。
  ui.setQueueAdd.onchange = () => {
    state.settings.queue_add_behavior = ui.setQueueAdd.value;
    transport.put('/v1/settings', { queue_add_behavior: ui.setQueueAdd.value }).catch(() => {});
  };
  ui.setPlaybackEntry.onchange = () => {
    state.settings.playback_entry = ui.setPlaybackEntry.value;
    transport.put('/v1/settings', { playback_entry: ui.setPlaybackEntry.value }).catch(() => {});
  };
  // 启动自动播放（folia 的 autoPlayOnLaunch）：会话恢复的收尾开关，服务端
  // 设置表持久化，restoreQueue 里按它决定要不要自动按下播放键。
  if (ui.setAutoPlay) {
    ui.setAutoPlay.checked = state.settings.startup_auto_play === true;
    ui.setAutoPlay.onchange = () => {
      state.settings.startup_auto_play = ui.setAutoPlay.checked;
      transport.put('/v1/settings', { startup_auto_play: ui.setAutoPlay.checked }).catch(() => {});
    };
  }
  // 网易云听歌打卡：后端在每次结算时读设置（缺省开），这里只写开关。
  if (ui.setScrobble) {
    ui.setScrobble.checked = state.settings.scrobble_enabled !== false;
    ui.setScrobble.onchange = () => {
      state.settings.scrobble_enabled = ui.setScrobble.checked;
      transport.put('/v1/settings', { scrobble_enabled: ui.setScrobble.checked }).catch(() => {});
    };
  }
  // 曲源失效自动接力：后端每次接力前读设置（缺省开），这里只写开关。
  if (ui.setRelay) {
    ui.setRelay.checked = state.settings.online_auto_relay !== false;
    ui.setRelay.onchange = () => {
      state.settings.online_auto_relay = ui.setRelay.checked;
      transport.put('/v1/settings', { online_auto_relay: ui.setRelay.checked }).catch(() => {});
    };
  }
  // 歌词设置：偏移步进 100ms（±2000 封顶），正则改完失焦即存。
  ui.setLyricOffsetDown.onclick = () => saveLyricSettings({ global_lyric_offset_ms: Math.max(-2000, globalLyricOffsetMs() - 100) });
  ui.setLyricOffsetUp.onclick = () => saveLyricSettings({ global_lyric_offset_ms: Math.min(2000, globalLyricOffsetMs() + 100) });
  ui.setLyricOffsetReset.onclick = () => saveLyricSettings({ global_lyric_offset_ms: 0 });
  ui.setLyricStaff.onchange = () => saveLyricSettings({ lyrics_staff_policy: ui.setLyricStaff.value });
  ui.setLyricStaffPattern.onchange = () => saveLyricSettings({ lyrics_staff_pattern: ui.setLyricStaffPattern.value.trim() });
  ui.setLyricFilterOn.onchange = () => saveLyricSettings({ lyrics_filter_enabled: ui.setLyricFilterOn.checked });
  ui.setLyricFilterPattern.onchange = () => saveLyricSettings({ lyrics_filter_pattern: ui.setLyricFilterPattern.value });
  // 动效分面：写设置表 + 刷 body[data-rm]，各面 CSS 即时生效。
  for (const [uiKey, settingKey] of MOTION_SURFACES) {
    if (!ui[uiKey]) continue;
    ui[uiKey].onchange = () => {
      state.settings[settingKey] = ui[uiKey].checked;
      transport.put('/v1/settings', { [settingKey]: ui[uiKey].checked }).catch(() => {});
      applyMotionSurfaces();
    };
  }
  // 导航可见性：写服务端设置表，同时立刻摘/挂 rail 上的入口。
  for (const [view, uiKey, settingKey] of NAV_TOGGLE_VIEWS) {
    if (!ui[uiKey]) continue;
    ui[uiKey].onchange = () => {
      state.settings[settingKey] = ui[uiKey].checked;
      transport.put('/v1/settings', { [settingKey]: ui[uiKey].checked }).catch(() => {});
      applyNavVisibility();
    };
  }
  ui.setStageIdleHide.onchange = () => setStageIdleHide(ui.setStageIdleHide.checked, true);
  ui.setCoverFollow.onchange = () => setCoverFollow(ui.setCoverFollow.checked, true);
  // 开发者选项：诊断日志的四个动作。开关是即时的，导出与清空都只碰日志本身。
  if (ui.setDevDiag) ui.setDevDiag.onchange = () => setDevDiagnostics(ui.setDevDiag.checked);
  if (ui.devDiagCopy) ui.devDiagCopy.onclick = copyDiagLog;
  if (ui.devDiagSave) ui.devDiagSave.onclick = saveDiagLogFromServer;
  if (ui.devDiagClear) ui.devDiagClear.onclick = clearDiagLog;
  ui.settingsEntry.onclick = () => {
    setView('settings');
    ui.views.settings.scrollTop = 0;
    ui.views.settings.querySelector('button, input, select').focus({ preventScroll: true });
  };

  ui.rail.querySelectorAll('.rail-item').forEach((b) => { b.onclick = () => setView(b.dataset.view); });
  // 点击「正在播放」：弹出清晰的播放控制弹窗（不再切换舞台抽屉）
  ui.scrim.onclick = () => { document.body.classList.remove('stage-open'); closeMenu(); };

  // 顶栏「账号」：任何视图下都能打开统一登录弹窗。
  const onlineAccountBtn = $('online-account-btn');
  if (onlineAccountBtn) {
    onlineAccountBtn.onclick = () => {
      if (window.OnlineLogin) window.OnlineLogin.open();
    };
  }

  // 滚到底自动加载下一页，取代"一次性拉 500 条"的硬截断。
  ui.libSentinel.onclick = () => loadTracks(false);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && state.tracks.length < state.total && !state.loading) {
        loadTracks(false);
      }
    }, { root: ui.column.querySelector('#view-library') }).observe(ui.libSentinel);
  }

  // 界面皮肤排在 initTheme() 之前：先定布局（data-skin + 启用对应 CSS），
  // 再定配色（主题令牌），皮肤写的是布局属性，两者互不覆盖。
  // 反过来会让第一帧先按默认布局排一遍，再被皮肤推倒重排。
  if (window.Skins) window.Skins.init();
  initTheme();
  // 主题工作室必须排在 initTheme() 之后：它第一件事就是往 Theme 里注册二次元
  // 主题，而 Theme.init() 已经跑完，于是注册结果会经 Theme.onChange 触发的那次
  // 重渲染落进菜单与设置页。
  initThemeStudio();
  initStageControl();
  initTopMoreMenu();
  // 播放控制弹窗（np）：绑定开/关、音量与跳转。此前只定义未调用，
  // 弹窗在界面上不可达。
  initNowPlayingModal();
  // 胶囊播放器：顶栏按钮收进去；胶囊上直接给传输三键与展开，不展开也能操作。
  // 页内最小化态整块可拖、靠边吸附、位置记进 localStorage；浮动实例改由宿主窗口
  // 承担移动与吸附（见下面的 pointerdown）。
  /// 宿主是否给了浮动窗口能力。capabilities 是 init 消息里的广告位：Web 宿主没有
  /// 窗口，老版本 dbx 也没有这个 surface，两种情况都得退回页内最小化。
  function floatingApi() {
    const bridge = window.dbxPlugin;
    return bridge && bridge.capabilities && bridge.capabilities.floating && bridge.floating ? bridge.floating : null;
  }
  /// 开浮动胶囊窗口。尺寸先给估值：浮窗实例量出自己的胶囊之后会再 setSize 修正
  /// （见 fitFloatingWindowToCapsule）。整窗不透明、与胶囊同色，读作一张圆角卡片
  /// （见 style.css 的 is-floating-capsule）：宿主的浮窗本来就不透明，一个要给用户
  /// 拖的东西必须处处点得动。
  function openFloatingCapsule() {
    const floating = floatingApi();
    if (!floating) return Promise.resolve(null);
    return floating
      .open({ contributionId: PLAYER_WORKBENCH, title: '正在播放', width: 268, height: 55 })
      .catch((err) => {
        console.warn('[hertz] 打开浮动胶囊失败：', err);
        return null;
      });
  }
  /// 展开：tab 实例解除最小化；浮动实例跳回主工作台 tab 并关掉自己。
  function expandCapsule() {
    if (window.HertzCapsuleOnly) {
      // 先清偏好再开 tab：两个 surface 共用宿主 storage 的键空间，新 tab 启动时
      // 若读到 '1' 会把自己又最小化成一页空白。
      try { localStorage.setItem(CAPSULE_KEY, ''); } catch (err) { /* 偏好丢一次无所谓 */ }
      // 跳回主工作台 tab：浮窗里没有标签栏，宿主会把这次导航转发给主窗口并把它带到
      // 前台。同时借 sidecar 广播让还活着的 tab 实例解除最小化——两个 iframe 是
      // opaque origin，浏览器侧没有直达通道，只能绕服务端这条事件管道。
      // 必须等转发落地再关自己：窗口一销毁，还在路上的那次转发就没人送了，用户点了
      // 展开却什么也没开出来。
      Promise.allSettled([
        window.dbxPlugin.openWorkbench(PLAYER_WORKBENCH, {}, { target: 'tab' }),
        transport.post('/v1/ui/notice', { action: 'expand-capsule' }),
      ]).then(() => {
        const floating = floatingApi();
        if (floating) floating.close().catch(() => {});
      });
      return;
    }
    setCapsuleMinimized(false);
  }
  // 最小化到胶囊。抽成函数是因为入口有两处：顶栏的胶囊按钮，以及设置里
  // 「窗口与舞台」分组的新按钮（清风皮肤把控制入口统一收进左上角设置，
  // 顶栏那几个图标对它是冗余的，隐藏前必须在这里补一个可发现的入口）。
  const enterCapsule = () => {
    if (floatingApi()) {
      // dbx：最小化 = 浮动胶囊窗口接管 + 关掉这个 tab。留一个空白 tab 在 dbx 里读作
      // 「页面坏了」，而浮窗那份本来就是「切到哪个应用都还在」的胶囊。不写 minimized
      // 偏好：tab 已关，之后任何一次打开都该是完整界面。浮窗叫不出来时退回页内最小化，
      // 不能把用户关在门外。
      openFloatingCapsule().then((r) => {
        if (!r) {
          setCapsuleMinimized(true);
          return;
        }
        if (window.dbxPlugin.closeWorkbench) window.dbxPlugin.closeWorkbench();
      });
      return;
    }
    setCapsuleMinimized(true);
  };
  ui.capsuleEntry.addEventListener('click', enterCapsule);
  const setCapsuleBtn = $('set-capsule-btn');
  if (setCapsuleBtn) setCapsuleBtn.addEventListener('click', enterCapsule);
  // 传输三键：与底部播放条同一批调用。stopPropagation 免得冒到胶囊的展开/拖拽上。
  ui.capsulePrev.addEventListener('click', (e) => { e.stopPropagation(); post('/v1/player/previous'); });
  ui.capsuleNext.addEventListener('click', (e) => { e.stopPropagation(); post('/v1/player/next'); });
  ui.capsulePlay.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
  ui.capsuleExpand.addEventListener('click', (e) => { e.stopPropagation(); expandCapsule(); });
  // 拖拽：整块是把手，按钮除外。位移过阈值才算拖；没超过阈值的那次 pointerup 之后的
  // click 仍走展开，靠 capsuleJustDragged 挡一下。两种形态移动的东西不同：
  //   page —— 页内最小化态，移动 DOM，松手吸附到视口边缘并落盘；
  //   host —— 浮动实例：过阈值时把窗口交给宿主（beginDrag），之后宿主自己轮询原生
  //           光标移动窗口，插件不逐帧上报；松手时 endDrag，宿主吸附到屏幕工作区并
  //           落盘，宿主自己也有「光标停顿即结束」的兜底。
  let capsuleJustDragged = false;
  ui.capsule.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.capsule-btn')) return;
    const startX = e.clientX, startY = e.clientY;
    const box = ui.capsule.getBoundingClientRect();
    const offX = startX - box.left, offY = startY - box.top;
    const floating = window.HertzCapsuleOnly ? floatingApi() : null;
    let dragging = false;
    let dragMode = floating ? 'pending' : 'page';
    const move = (ev) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < CAPSULE_DRAG_PX) return;
        dragging = true;
        capsuleJustDragged = true;
        ui.capsule.classList.add('is-dragging');
        // 抓住指针：拖出 iframe 之外事件也还回这里，不然一过边界就丢拖拽。
        try { ui.capsule.setPointerCapture(e.pointerId); } catch (err) { /* 拿不到就算了 */ }
        if (floating) {
          dragMode = 'host';
          floating.beginDrag().catch((err) => { console.warn('[hertz] 浮窗拖动起手失败：', err); dragMode = 'off'; });
        }
      }
      // host 形态下移动由操作系统接管，这里什么都不做；pending/off 也不动页内 DOM。
      if (dragMode === 'page') placeCapsule(ev.clientX - offX, ev.clientY - offY);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancelled);
      ui.capsule.classList.remove('is-dragging');
      setTimeout(() => { capsuleJustDragged = false; }, 0);
    };
    const up = () => {
      cleanup();
      if (!dragging) return;
      if (dragMode === 'host') {
        floating.endDrag().catch(() => {});
      } else if (dragMode === 'page') {
        const r = ui.capsule.getBoundingClientRect();
        saveCapsulePos(snapCapsule(r.left, r.top));
      }
    };
    // pointercancel 不代表「拖动结束」：真机上 pointerup 会正常到达，但捕获一旦被
    // 系统收走就只剩 cancel。所以这里只清监听，收尾留给宿主的「光标静止即结束」兜底
    // （FLOATING_DRAG_IDLE_MS）；pointerup 真到了就提前收尾。
    const cancelled = () => {
      cleanup();
      if (dragging && dragMode === 'page') {
        const r = ui.capsule.getBoundingClientRect();
        saveCapsulePos(snapCapsule(r.left, r.top));
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancelled);
  });
  ui.capsule.addEventListener('click', (e) => {
    if (capsuleJustDragged) return;
    if (e.target.closest('.capsule-btn')) return;
    expandCapsule();
  });
  // 宿主改窗口尺寸后把越界的位置夹回来。浮动实例没有页内坐标可夹（胶囊就是窗口
  // 的全部内容，位置归宿主窗口管），直接跳过。
  window.addEventListener('resize', () => {
    if (window.HertzCapsuleOnly) return;
    if (!ui.capsule.style.left || ui.capsule.hidden) return;
    const r = ui.capsule.getBoundingClientRect();
    placeCapsule(r.left, r.top);
  });
  requestAnimationFrame(tickCapsuleMarquee);
  let capsuleMin = false;
  try { capsuleMin = localStorage.getItem(CAPSULE_KEY) === '1'; } catch (err) { capsuleMin = false; }
  // 浮动实例的形态由 surface 决定，不读 tab 那份偏好：两个 surface 共用宿主 storage
  // 的同一个键空间，互相读会把对方的初始态改错（还会顺手写脏偏好）。
  if (capsuleMin && !window.HertzCapsuleOnly) setCapsuleMinimized(true);
  // 在线面板（web/online.js）：先注入宿主依赖，再拉音源清单、绑事件。
  window.Online.bind({
    ui,
    state,
    setStateQueue,
    applyQueue,
    paintArt,
    probeImage,
    fmt,
    toast,
    errText,
    // 在线行的「加入歌单」：本地自建歌单按快照富形态收下在线曲目。
    addToPlaylistMenu: openPlaylistMenu,
  });
  window.Online.init();
  // 扫码登录模块（web/online-login.js）：放在 Online.init 之后，头像 URL
  // 归一化要用它挂出的 safeCoverUrl。init() 负责在启动阶段就把顶栏头像按
  // 服务端持久化的选择恢复出来（以前只有打开登录弹窗才恢复）。
  if (window.OnlineLogin) window.OnlineLogin.init();
  // 在线歌单两层界面（web/online-playlist-view.js）：同样是先注入宿主再 init。
  // 宿主只给三样它自己造不出来的东西：层切换、音源能力位、队列写入。
  if (window.OnlinePlaylistView) {
    window.OnlinePlaylistView.bind({
      setLayer: setPlaylistLayer,
      // 两层界面住在歌单视图里：从在线面板卡片进来时要先把视图切过去，
      // 否则开了层也看不见。已经在歌单视图上时这一步是空操作。
      ensureVisible: () => { if (state.view !== 'playlists') setView('playlists'); },
      caps: capsOfSource,
      enqueue: enqueueOnlineTracks,
      // 时长格式化与曲库/搜索共用同一个实现，卡片上的时长不会和别处不一致。
      fmt,
      toast,
      errText,
    });
    window.OnlinePlaylistView.init();
  }
  // 收藏与每日推荐：同样是「先注入宿主依赖，再 init」。宿主回调里
  // playLocal 走现有播放链路，coverUrl 走带 token 的封面通道。
  const favHost = {
    ui,
    state,
    fmt,
    toast,
    errText,
    paintArt,
    // 给每日推荐页用：菜单入口被关掉时，若正停在该页要退回曲库，否则会
    // 留在一个导航里已经没有入口的页面上。
    setView,
    // 每日推荐切来源时回传一声：曲库空态卡的显隐要看当前来源（见 syncLibEmpty）。
    onDailyModeChange: () => syncLibEmpty(),
    coverUrl: (id) => transport.coverUrl(id),
    // 插件形态下封面是异步落地的（要经 invoke 取回 base64）。卫星模块渲染时
    // 用 coverSlot 登记一个 setter，图到了由 app.js 统一回填；独立形态下
    // coverUrl 同步就有真 URL，登记即命中缓存，等于无操作。
    ensureCover: (id) => transport.ensureCover(id),
    coverSlot,
    playLocal: (id, queue) => playTrack(id, queue && queue.length ? queue : [id]),
    // 混合队列：收藏全部播放的本地与在线身份共用一条 /player/load 队列。
    // meta 是在线 id 的快照，注入服务端在线暂存，历史标题才不退化。
    //
    // startId 可选：每日推荐这类"整份推荐是一个队列，点第几首就从第几首往下"
    // 的场景，需要从中间起播。服务端按 queue 里 track_id 的下标定位，所以
    // 把起点放进 track_id 就行，不必重新排列队列（排了会改掉"下一首"的顺序）。
    playQueue: async (ids, meta, startId) => {
      if (!ids || !ids.length) return;
      const track_id = (startId && ids.includes(startId)) ? startId : ids[0];
      try {
        await transport.post('/v1/player/load', {
          track_id,
          queue: ids,
          ...(meta && Object.keys(meta).length ? { meta } : {}),
        });
        for (const [id, m] of Object.entries(meta || {})) {
          state.byId.set(id, { id, ...m, duration_ms: m.duration_ms ?? null });
        }
        setStateQueue(ids, track_id);
      } catch (err) {
        toast(errText('播放失败', err), 'error');
      }
    },
    // 单曲在线收藏：直接把快照包成在线曲交给整盘试听链路。
    playOnline: (f) => {
      if (window.Online) {
        window.Online.playAll([{
          source: f.source, id: f.ref_id, title: f.title, artist: f.artist,
          album: f.album, duration_ms: f.duration_ms, cover: f.cover, playable: true,
        }], 0);
      }
    },
    // 电台/在线歌单收藏：整盘载入交给 OnlinePlaylists——它按 source+id 拉
    // 平台歌单再整盘入队，收藏对象是歌单而不是单曲。
    playRadio: (f) => {
      if (window.OnlinePlaylists) window.OnlinePlaylists.playRef(f.source, f.ref_id);
      else toast('在线歌单模块未加载，请刷新页面后重试', 'error');
    },
    // 红心状态变化时让曲库行跟着改色。
    onFavoriteChanged: (kind, source, refId, on) => {
      if (kind !== 'track' || source !== 'local') return;
      const row = state.rows.get(refId);
      if (!row) return;
      const btn = row.querySelector('[data-act="fav"]');
      if (!btn) return;
      btn.classList.toggle('is-on', on);
      btn.innerHTML = window.Favorites.heartSvg(on);
      btn.title = on ? '取消收藏' : '加入我的收藏';
    },
  };
  if (window.Favorites) {
    window.Favorites.bind(favHost);
    window.Favorites.init();
  }
  if (window.Daily) {
    window.Daily.bind(favHost);
    window.Daily.init();
  }
  // 每日推荐独立页：菜单注入与页面初始化。可见性开关等设置到手后再 applied
  // （见 loadSettings），这里先把模块挂上，按钮的点击自己带，不依赖批量绑定。
  if (window.DailyView) {
    window.DailyView.bind(favHost);
    window.DailyView.init();
  }
  // 在线歌单（账号区网格）任何变化都同步重绘左侧歌单菜单的在线分区。
  // 在线歌单到达/变化：列表分区重画，架子也换上含在线卡的完整集合——
  // 登录成功是异步的，架子建好后数据才到，不挂这条就会一直缺在线卡。
  document.addEventListener('online-playlists:changed', () => {
    renderOnlinePlaylistSection();
    if (shelf) shelf.setItems(shelfItems());
    // 在线歌单也上封面墙（与架子上的是同一批卡），所以这里同样要重画。
    if (playlistMode === 'grid') renderPlaylistGrid();
  });
  // 排布切换排在 initStage() 之前、且不挂在它下面：initStage() 在 stage.js
  // 缺失时会整段提前返回，排布按钮不该跟着一起失效。
  initPlaylistViews();
  initStage();
  initCreative();
  bindShortcuts();
  initSleepTimer();
  initPalette();
  initBarAutohide();
  initPanelBridge();
  initQingfengBridge();
  bindMediaSession();

  setView('library');
  await refreshAll();
  const health = await transport.get('/v1/health').catch(() => null);
  if (health) {
    ui.setBackend.textContent = `${health.backend} · v${health.version} · 协议 ${health.protocol_version}`;
  }
  openSocket();
}

/// 启动半路抛错（sidecar 没起、桥调用被拒……）时绝不能留一屏白：浮窗形态下那就是
/// 桌面上一块点不动、关不掉的白方块。这里换成一张深色错误卡 + 重试按钮，
/// 至少看得见、点得动、能自救。
function showBootFailure(err) {
  console.error('[hertz] 启动失败：', err);
  document.body.classList.add('is-boot-failed');
  const box = document.createElement('div');
  box.className = 'boot-failed-card';
  const msg = document.createElement('span');
  msg.textContent = '启动失败：' + ((err && err.message) || err || '未知错误');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '重试';
  btn.onclick = () => location.reload();
  box.append(msg, btn);
  document.body.append(box);
}

(async function boot() {
  try {
    await startApp();
  } catch (err) {
    showBootFailure(err);
  }
})();
