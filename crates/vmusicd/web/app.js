// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// v2 原型：零构建原生 JS，和现有 crates/vmusicd/web/app.js 一样没有 npm 步骤。
//
// 与旧版最大的结构差异：所有后端访问都经过一个极薄的 transport 抽象。
// 有真实服务时走 HTTP + WebSocket，没有时（例如直接双击打开本文件）退到
// 演示后端。业务逻辑只有一份，不存在"演示分支"。

'use strict';

// Token 通常由服务端注入进 HTML；链接带来的 token 用完即抹掉，避免留在历史里。
const TOKEN = (() => {
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
    playlists: $('view-playlists'),
    queue: $('view-queue'),
    online: $('view-online'),
    favorites: $('view-favorites'),
    settings: $('view-settings'),
  },

  libCount: $('lib-count'),
  libSort: $('lib-sort'),
  libList: $('lib-list'),
  libEmpty: $('lib-empty'),
  libSentinel: $('lib-sentinel'),
  libHint: $('lib-hint'),

  scanToggle: $('scan-toggle'),
  scanPanel: $('scan-panel'),
  scanRoot: $('scan-root'),
  scanBtn: $('scan-btn'),
  scanBar: $('scan-bar'),
  scanLabel: $('scan-label'),
  scanHistory: $('scan-history'),

  playlistList: $('playlist-list'),
  playlistOnline: $('playlist-online'),
  oplGrid: $('opl-grid'),
  oplDetail: $('opl-detail'),
  playlistCount: $('playlist-count'),
  newPlaylistName: $('new-playlist-name'),
  newPlaylistBtn: $('new-playlist-btn'),
  shelf: $('shelf'),
  shelfToggle: $('shelf-toggle'),

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
  queueBadge: $('queue-badge'),

  setDevice: $('set-device'),
  setDensity: $('set-density'),
  setMotion: $('set-motion'),
  setStageCover: $('set-stage-cover'),
  cookieRows: $('cookie-rows'),
  setRenderMode: $('set-render-mode'),
  renderWarn: $('render-warn'),
  setBackend: $('set-backend'),

  // 创意舞台：只在这里开总开关，细分参数在工坊里调。
  workshopBtn: $('workshop-btn'),
  setCreative: $('set-creative'),
  setWorkshopBtn: $('set-workshop-btn'),
  creativeWarn: $('creative-warn'),

  cover: $('cover'),
  nowTitle: $('now-title'),
  nowArtist: $('now-artist'),
  nowTech: $('now-tech'),
  spectrum: $('spectrum'),
  lyrics: $('lyrics'),
  stageBtn: $('stage-btn'),

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
  favRefresh: $('fav-refresh'),
  favBadge: $('fav-badge'),

  // 每日推荐
  dailyList: $('daily-list'),
  dailyDate: $('daily-date'),
  dailySub: $('daily-sub'),
  dailyPlayAll: $('daily-play-all'),
  dailyRefresh: $('daily-refresh'),
};

// 舞台（VCP 音乐模式）由 stage.js 提供，先于 app.js 加载。它只吃数据、只吐
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

  current: null,

  seeking: false,
  // 乐观 UI 守卫：刚发出播放/暂停命令时，在途的旧快照会让按钮闪回。
  // 与 VCP music.js 的 isChangingState / expectedPlayingState / lastCommandTime 同一思路。
  commandAt: 0,
  expectedPlaying: false,
  loadingTrack: null,
  spectrum: new Array(64).fill(0),
  peaks: new Array(64).fill(0),
  playlists: [],
  devices: [],
  settings: {},
  connected: false,
  modeLabel: { repeat: '列表循环', repeat_one: '单曲循环', shuffle: '随机播放' },
};

// ---------------------------------------------------------------------------
// Transport：HTTP / WebSocket 或演示后端
// ---------------------------------------------------------------------------

const ServerTransport = {
  kind: 'server',
  async get(path) { return request(path, {}); },
  async post(path, body) { return request(path, { method: 'POST', body: JSON.stringify(body || {}) }); },
  async put(path, body) { return request(path, { method: 'PUT', body: JSON.stringify(body || {}) }); },
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
};

const REQUEST_TIMEOUT = 15000;

async function request(path, options = {}, attempt = 0) {
  const method = (options.method || 'GET').toUpperCase();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT) : 0;
  try {
    const res = await fetch(path, {
      ...options,
      signal: controller ? controller.signal : undefined,
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
    return res.status === 204 ? null : res.json();
  } catch (err) {
    // 网络抖动、超时、服务端 5xx：幂等读重试一次，避免偶发失败直接弹红。
    const transient = !err.status || err.status >= 500 || err.name === 'AbortError' || err.name === 'TypeError';
    if (method === 'GET' && attempt === 0 && transient) {
      await new Promise((r) => setTimeout(r, 300));
      return request(path, options, attempt + 1);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 后端错误契约里有 request_id，没有它就只能靠猜去翻日志。
function errText(prefix, err) {
  return `${prefix}：${err.message}${err.requestId ? `（request_id ${err.requestId}）` : ''}`;
}

let transport = ServerTransport;

// 其它表现层模块（创意舞台、工坊、背景层）也要读写服务端设置。与其各自再实现
// 一份带 token 的 fetch，不如把同一个 transport 暴露出去 —— 演示模式下的降级、
// 超时重试、错误归一化都留在这唯一一份实现里。
// 用函数转发而不是直接赋值 `transport`：boot 里会把它换成 MockBackend，
// 直接赋值会让外部一直拿着启动前那个引用。
window.VMusicTransport = {
  get: (p) => transport.get(p),
  put: (p, body) => transport.put(p, body),
  post: (p, body) => transport.post(p, body),
  del: (p) => transport.del(p),
  kind: () => transport.kind
};

async function chooseTransport() {
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
  if (!message) { hide(); return; }
  ui.toast.textContent = message;
  ui.toast.className = kind === 'error' ? 'toast error' : 'toast';
  ui.toast.hidden = false;
  requestAnimationFrame(() => ui.toast.classList.add('show'));
  toastTimer = setTimeout(hide, kind === 'error' ? 6000 : 1400);
}

let retries = 0;
let reconnectTimer = 0;

function onConnectionChange(ok) {
  state.connected = ok;
  ui.conn.textContent = ok ? '服务已连接' : '服务已断开';
  ui.conn.className = ok ? 'conn ok' : 'conn bad';
  ui.offlineBanner.hidden = ok;
  if (ok) {
    retries = 0;
    // 断线期间错过了一切，重连后先把全量状态拉回来。
    refreshAll();
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
    case 'ended': break;
    case 'error': toast(`播放异常：${msg.message}`, 'error'); break;
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

async function loadTracks(reset) {
  if (state.loading) return;
  state.loading = true;
  if (reset) { state.offset = 0; state.rows.clear(); ui.libList.innerHTML = ''; }
  try {
    const page = await transport.get(
      `/v1/tracks?q=${encodeURIComponent(state.q)}&limit=${PAGE}&offset=${state.offset}`);
    state.total = page.total;
    if (reset) state.tracks = [];
    state.tracks = state.tracks.concat(page.tracks);
    for (const t of page.tracks) state.byId.set(t.id, t);
    renderLibrary();
  } catch (err) {
    toast(errText('曲库读取失败', err), 'error');
  } finally {
    state.loading = false;
  }
}

function sortTracks(list) {
  const arr = list.slice();
  const coll = new Intl.Collator('zh-Hans-CN', { numeric: true });
  switch (state.sort) {
    case 'artist': return arr.sort((a, b) => coll.compare(a.artist || '', b.artist || ''));
    case 'album': return arr.sort((a, b) => coll.compare(a.album || '', b.album || ''));
    case 'added': return arr.sort((a, b) => b.added_at - a.added_at);
    default: return arr.sort((a, b) => coll.compare(a.title, b.title));
  }
}

function renderLibrary() {
  const host = ui.libList;
  const list = sortTracks(state.tracks);

  ui.libEmpty.hidden = list.length > 0;
  ui.libList.hidden = list.length === 0;
  // 后端返回了 total 但旧版 UI 直接丢弃，用户永远不知道自己是否被 500 条截断。
  ui.libCount.textContent = state.q
    ? `匹配 ${state.total} 首${state.total > list.length ? ` · 已加载 ${list.length}` : ''}`
    : `共 ${state.total} 首${state.total > list.length ? ` · 已加载 ${list.length}` : ''}`;
  ui.libHint.hidden = list.length !== 0;

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
      <button class="t-act" data-act="play-next" title="下一首播放" aria-label="下一首播放">
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
    const act = e.target.closest('.t-act');
    if (act) {
      e.stopPropagation();
      // 红心按钮自带 handler（含 stopPropagation），这里只是双保险：
      // 万一它回滚到行处理，也不该变成「插入下一首」。
      if (act.dataset.act === 'fav') return;
      if (act.dataset.act === 'menu') openContextMenu(track, act);
      else insertNext(track.id);
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
  // loading="lazy" 已经把"只为可见行加载"交给浏览器了，不再需要手写观察器。
  paintArt(row, track.has_cover ? transport.coverUrl(track.id) : null);
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
  if (!url) { art.classList.add('is-missing'); return; }
  const img = document.createElement('img');
  img.className = 't-art-img';
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  // 404 / 防盗链 / 断网：把图片本体摘掉，露出 .t-art 自己的占位图，
  // 而不是留一个浏览器默认的回形针图标或一块空白。
  img.onerror = () => { art.classList.add('is-missing'); img.remove(); };
  img.onload = () => art.classList.add('is-loaded');
  art.appendChild(img);
  img.src = url;
}

// ---------------------------------------------------------------------------
// 播放
// ---------------------------------------------------------------------------

function playFromList(id) {
  const list = sortTracks(state.tracks).map((t) => t.id);
  playTrack(id, list.length > 1 ? list : [id]);
}

async function playTrack(id, queue) {
  const track = state.byId.get(id);
  const label = track ? track.title : '曲目';
  // VCP 在 load 之后会轮询直到 is_loading 落定；这里后端 load 是带回执的，
  // 只需把"正在载入"这段时间显式化，而不是让界面静默几百毫秒。
  state.loadingTrack = id;
  ui.playpause.classList.add('is-loading');
  try {
    await transport.post('/v1/player/load', { track_id: id, queue: queue && queue.length ? queue : [id] });
    setStateQueue(queue, id);
  } catch (err) {
    toast(errText(`无法播放《${label}》`, err), 'error');
  } finally {
    if (state.loadingTrack === id) {
      state.loadingTrack = null;
      ui.playpause.classList.remove('is-loading');
    }
  }
}

function setStateQueue(queue, currentId) {
  state.queue = queue || [];
  state.queueIndex = currentId ? state.queue.indexOf(currentId) : -1;
  renderQueue();
}

async function insertNext(id) {
  const list = state.queue.length ? state.queue.slice() : sortTracks(state.tracks).map((t) => t.id);
  const at = state.queueIndex >= 0 ? state.queueIndex + 1 : list.length;
  list.splice(at, 0, id);
  // resume=true 让后端保留当前播放位置，插入队列不会打断正在放的歌。
  await applyQueue(list, true);
  toast('已插入到下一首');
}

async function applyQueue(list, opts) {
  const resume = opts !== false;
  const current = state.snapshot.track_id;
  const index = current ? Math.max(0, list.indexOf(current)) : null;
  state.queue = list;
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
async function restoreQueue() {
  try {
    const data = await transport.get('/v1/player/queue');
    if (data && data.queue && data.queue.length) {
      state.queue = data.queue;
      state.queueIndex = data.index ?? state.queue.indexOf(state.snapshot.track_id);
      renderQueue();
    }
  } catch { /* 端点不存在时忽略 */ }
}

// 命令刚下发、后端还没处理完时到达的快照是旧的：照它渲染会让播放键闪回。
// VCP music.js 用 isChangingState + 800ms 窗口解决同一问题。
function staleCommand(snap) {
  return state.commandAt > 0
    && Date.now() - state.commandAt < 800
    && snap.playing !== state.expectedPlaying;
}

function applySnapshot(snap) {
  const previous = state.snapshot.track_id;
  if (staleCommand(snap)) snap = { ...snap, playing: state.expectedPlaying };
  else if (state.commandAt) state.commandAt = 0;
  state.snapshot = snap;
  ui.playpause.classList.toggle('is-playing', snap.playing);
  ui.mode.textContent = state.modeLabel[snap.mode] || snap.mode;
  ui.barTime.textContent = digestMs(snap.position_ms);
  document.title = state.current ? `${state.current.title} · mmusic-studio` : 'mmusic-studio';

  if (!state.seeking && snap.duration_ms) {
    const ratio = snap.position_ms / snap.duration_ms;
    ui.progress.value = String(Math.round(ratio * 1000));
    ui.progressGhost.style.width = `${(ratio * 100).toFixed(2)}%`;
    ui.progress.setAttribute('aria-valuetext', `${fmt(snap.position_ms)} / ${fmt(snap.duration_ms)}`);
  }

  if (snap.track_id && snap.track_id !== previous) loadNowPlaying(snap.track_id);
  updateRowActiveState(snap);
  // 舞台拿走播放状态：它自己有本地时钟补帧，不依赖推送频率。
  if (Stage) Stage.setSnapshot(snap);
  // 播放控制弹窗同步播放态 / 时间 / 进度
  syncNpSnapshot(snap);
  syncMediaSession();
}

function updateRowActiveState(snap) {
  for (const [id, row] of state.rows) {
    const active = id === snap.track_id;
    row.classList.toggle('active', active);
    row.classList.toggle('playing', active && snap.playing);
  }
}

async function loadNowPlaying(id) {
  // 在线试听的虚拟 id 在本地库里查不到，先回落到搜索时缓存下来的元数据
  //（缓存归 online.js 所有，通过 window.Online 访问）。
  let track = state.byId.get(id) || window.Online.getMeta(id);
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
          // 只在这首仍是当前曲目时重绘，避免切歌后把界面改错
          if (state.current && state.current.id === id) {
            window.Online.paintNowPlaying(base, base.cover);
            if (Stage) Stage.setTrack(base, base.cover);
            syncNpTrack(base, base.cover);
          }
        })
        .catch(() => {
          if (state.current && state.current.id === id) {
            base.artist = '在线试听';
            window.Online.paintNowPlaying(base, null);
          }
        });
    }
  }
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
    // coverUrl 现在是同步拼串，不再需要 await / catch
    url = transport.coverUrl(id);
  } else if (track.source && track.onlineId) {
    url = window.Online.safeCoverUrl(track.cover) || await window.Online.fetchCover(track);
  } else {
    url = window.Online.safeCoverUrl(track.cover);
  }
  // 远程封面可能 404 / 防盗链：加载不出来就撤掉，用占位图而不是空白
  if (url && !(await probeImage(url))) url = null;

  if (ui.ambient) {
    ui.ambientImg.style.backgroundImage = url ? `url("${url}")` : 'none';
    ui.ambient.classList.toggle('has-art', Boolean(url));
  }
  // 封面（含旋转）与取色背景交给舞台，app.js 不再直接碰 #cover。
  if (Stage) Stage.setTrack(track, url);
  // 播放控制弹窗同步曲目信息与封面
  syncNpTrack(track, url);

  const doc = await (track.source && track.onlineId
    ? window.Online.loadLyricDoc(track)
    : transport.get(`/v1/tracks/${id}/lyrics`).catch(() => null));
  if (Stage) Stage.setLyrics(doc && doc.lines && doc.lines.length ? doc : null);
  updateMediaSessionMetadata(track, url);
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
  // 视觉子系统（主循环/粒子/GL 宿主/粒子封面/星河）统一由
  // VisualController 按依赖顺序初始化，也可整体销毁。
  if (window.VisualController) VisualController.init();
  else {
    Stage.init();
    if (window.StageParticles) window.StageParticles.init();
    if (window.StageGLHost) window.StageGLHost.init();
    if (window.StageCoverParticles) window.StageCoverParticles.init();
    if (window.StageStarRiver) window.StageStarRiver.init();
  }
  if (window.Shelf) initShelf();
  document.addEventListener('stage:control', onStageControl);
}

function onStageControl(e) {
  const d = e.detail || {};
  switch (d.action) {
    case 'seek': seekTo(d.value); break;
    case 'toggle': togglePlay(); break;
    case 'prev': post('/v1/player/previous'); break;
    case 'next': post('/v1/player/next'); break;
    case 'view': setView(d.value); break;
    // 封面盘在全屏页头部就地切换，状态归 stage.js；这里只负责同步设置页的
    // 复选框并落库，两边共用 setStageCover 才不会各写一半持久化逻辑。
    case 'cover': setStageCover(d.value, true); break;
    default: break;
  }
}

// 舞台封面盘的持久化：persist 只在用户真的动了一下开关时为 true。
// loadSettings 恢复状态时传 false，否则每次刷新页面都会多写一次设置表。
function setStageCover(on, persist) {
  const want = !!on;
  state.settings.stage_cover = want;
  if (ui.setStageCover && ui.setStageCover.checked !== want) ui.setStageCover.checked = want;
  if (window.Stage) Stage.setCoverMode(want, { silent: true });
  if (persist) transport.put('/v1/settings', { stage_cover: want }).catch(() => {});
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

function renderQueue() {
  const list = state.queue;
  ui.queueCount.textContent = `${list.length} 首`;
  ui.queueBadge.textContent = String(list.length);
  ui.queueBadge.hidden = list.length === 0;
  ui.queueList.innerHTML = '';
  if (!list.length) {
    ui.queueList.innerHTML = '<div class="hint">队列为空。点击曲目右侧的按钮可插入下一首。</div>';
    return;
  }
  let dragId = null;
  list.forEach((id, index) => {
    // 队列里的曲目可能来自尚未加载的曲库分页；宁可显示占位行，也不要整行消失。
    const track = state.byId.get(id) || window.Online.getMeta(id)
      || { id, title: '未知曲目', artist: '', duration_ms: null };
    const row = document.createElement('div');
    row.className = 'q-row' + (id === state.snapshot.track_id ? ' playing' : '');
    row.draggable = true;
    row.dataset.index = String(index);
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

    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="remove"]')) {
        // 正在播放的这首不允许移出，否则会打断播放。
        if (id === state.snapshot.track_id) { toast('正在播放的曲目不能移出队列', 'error'); return; }
        applyQueue(list.filter((x) => x !== id), true);
        return;
      }
      // 在线试听的虚拟 id 不在本地库里，load 会查不到。回到在线页重新试听，
      // 而不是抛一个看不懂的 404。
      if (id.startsWith('online:')) {
        toast('在线试听曲目请回到「在线曲库」重新点播', 'error');
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
  if (shelf) shelf.setItems(state.playlists);
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
// 歌单视图有「歌单架 / 列表」两种排布（setPlaylistMode）：列表模式下分区
// 块挂在 #playlist-list 末尾与本地歌单同列滚动；架子模式下 #playlist-list
// 整体隐藏，块搬到独立宿主 #playlist-online（架子下方剩余区域）。两种排布
// 共用同一个块节点，切换时只搬家不重建，滚动状态外的一切都保留。
let onlineBlockEl = null;

function onlinePlaylistHost() {
  return playlistMode === 'list' ? ui.playlistList : ui.playlistOnline;
}

// 把分区块放进当前排布对应的宿主，并维护架子宿主的显隐；没有在线歌单时
// 架子宿主收起，不把立体架子顶上去或留一块空白。
function placeOnlineBlock() {
  if (!ui.playlistOnline) return;
  if (onlineBlockEl) {
    const host = onlinePlaylistHost();
    if (onlineBlockEl.parentElement !== host) host.appendChild(onlineBlockEl);
  }
  ui.playlistOnline.hidden = playlistMode !== 'shelf' || !onlineBlockEl;
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
      groups.set(it.source, {
        label: it.sourceLabel, color: it.badgeColor,
        badgeText: it.badgeText, rows: [],
      });
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

    g.rows.forEach((it) => block.appendChild(onlinePlaylistRow(src, it.playlist, g.color, g.badgeText)));
  });
  onlineBlockEl = block;
  onlinePlaylistHost().appendChild(block);
  placeOnlineBlock();
}

function onlinePlaylistRow(src, p, badgeColor, badgeText) {
  const el = document.createElement('div');
  el.className = 'pl-row is-online';
  el.title = p.name;

  const art = document.createElement('span');
  art.className = 'pl-art';
  const cover = window.Online ? window.Online.safeCoverUrl(p.cover) : null;
  if (cover) art.style.backgroundImage = 'url("' + cover + '")';
  else art.classList.add('is-missing');
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
  const badge = document.createElement('span');
  badge.className = 'pl-online-badge';
  if (badgeColor) badge.style.setProperty('--badge', badgeColor);
  badge.textContent = badgeText;
  nameLine.appendChild(badge);
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
  const name = prompt('重命名歌单', p.name);
  if (!name || !name.trim()) return;
  await transport.put(`/v1/playlists/${p.id}`, { name: name.trim() });
  if (shelf) shelf.invalidate(p.id);
  if (detailPlaylistId === p.id && ui.plDetailName) ui.plDetailName.textContent = name.trim();
  loadPlaylists();
  toast('已重命名');
}

async function deletePlaylist(p) {
  if (!confirm(`删除歌单「${p.name}」？此操作不可撤销。`)) return;
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

const SHELF_MODE_KEY = 'vmusic.playlists.mode';

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
      const url = transport.coverUrl(trackId);
      // 先探一次再返回：拿不到图就明确返回 null，让卡面走占位色，
      // 而不是挂一个必然破图的 <img>。
      return (await probeImage(url)) ? url : null;
    }
  });

  shelf = Shelf.init();
  if (!shelf) return;

  document.addEventListener('shelf:action', (e) => {
    const d = e.detail || {};
    const item = state.playlists.find((p) => p.id === d.id);
    if (!item) return;
    if (d.action === 'play') playPlaylist(item.id);
    else if (d.action === 'queue') queuePlaylistNext(item.id);
    else if (d.action === 'open') openPlaylist(item.id);
    else if (d.action === 'rename') renamePlaylist(item);
    else if (d.action === 'delete') deletePlaylist(item);
  });

  // 封面异步就绪：列表行按 id 对号重画（shelf 内部已自行订阅）。
  plCovers.onChange((id) => {
    const art = rowArts.get(id);
    if (art) paintRowArt(art, id);
  });

  if (ui.shelfToggle) ui.shelfToggle.addEventListener('click', () => setPlaylistMode(null));
  let saved = null;
  try { saved = localStorage.getItem(SHELF_MODE_KEY); } catch (err) { /* 隐私模式 */ }
  setPlaylistMode(saved === 'list' ? 'list' : 'shelf');
  // 启动顺序不该决定架子上有没有歌单。loadPlaylists() 只在 shelf 已经建好时
  // 才会喂它一次，而这两件事分属 initStage() 和 refreshAll() 两个阶段——一旦
  // 时序错位，表现就是「歌单列表有内容，架子却是空的」，要等到新建/删除一次
  // 歌单才亮起来。用手头已有的数据兜一次，顺序就无所谓了。
  shelf.setItems(state.playlists);
}

// 两种排布共用同一份 state.playlists 和同一个 Shelf 实例：列表模式只是把
// 架子藏起来，索引和已取到的封面都还在，来回切不会重新拉一遍。
// persist=false 用于详情返回时恢复显隐，不写 localStorage。
function setPlaylistMode(next, persist) {
  const want = next || (playlistMode === 'shelf' ? 'list' : 'shelf');
  playlistMode = want;
  const on = want === 'shelf';
  ui.shelf.classList.toggle('on', on);
  ui.playlistList.hidden = on;
  if (ui.shelfToggle) {
    ui.shelfToggle.setAttribute('aria-pressed', String(on));
    ui.shelfToggle.textContent = on ? '歌单架' : '列表';
  }
  if (persist !== false) {
    try { localStorage.setItem(SHELF_MODE_KEY, want); } catch (err) { /* 隐私模式 */ }
  }
  // 在线歌单分区块跟随排布搬到对应宿主（架子宿主 / 列表末尾）。
  placeOnlineBlock();
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
    // 排布层：交给 setPlaylistMode 恢复架子/列表与在线分区宿主。persist=false
    // —— 返回不该顺手改掉用户上次选的排布偏好。
    setPlaylistMode(playlistMode, false);
    return;
  }
  ui.shelf.classList.remove('on');
  ui.playlistList.hidden = true;
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

// 在线歌单详情层的入口。两层界面未加载时退回抽屉，行为不倒退。
function openOnlinePlaylistDetail(src, id, from) {
  const view = window.OnlinePlaylistView;
  if (view) { view.open(src, id, from || 'arrange'); return; }
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
  await transport.post('/v1/player/load', { track_id: ids[at], queue: ids });
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
    || { id: tid, title: '本地文件已不存在', artist: '', duration_ms: null, missing: true });
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
    list.innerHTML = '<div class="hint">这个歌单还是空的。去曲库里右键曲目 →「加入歌单」。</div>';
    return;
  }
  detailTracks.forEach((track, index) => {
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
      art.style.backgroundImage = `url("${transport.coverUrl(track.id)}")`;
    }

    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="remove"]')) { removeDetailTrack(id, track.id); return; }
      if (track.missing) { toast('文件已不存在，请先移出这一行', 'error'); return; }
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
    { label: '下一首播放', run: () => insertNext(track.id) },
    { label: '复制文件路径', run: () => copyText(track.path) },
    { sep: true },
    { label: '加入歌单', children: state.playlists.length
      ? state.playlists.map((p) => ({ label: p.name, run: () => addToPlaylist(p.id, track.id) }))
      : [{ label: '（暂无歌单）', disabled: true }] },
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

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('路径已复制'); }
  catch { toast('复制失败，请手动选择', 'error'); }
}

async function addToPlaylist(playlistId, trackId) {
  await transport.post(`/v1/playlists/${playlistId}/tracks`, { track_ids: [trackId] }).catch(() => {});
  loadPlaylists();
  toast('已加入歌单');
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
    await transport.post('/v1/library/scan', { root });
    // 记住这次的路径，下次不用再手打一遍。
    const prev = state.settings.recent_scan_roots || [];
    state.settings.recent_scan_roots = [root, ...prev.filter((r) => r !== root)].slice(0, 5);
    await transport.put('/v1/settings', { recent_scan_roots: state.settings.recent_scan_roots, last_scan_root: root });
    await loadScanHistory();
  } catch (err) {
    ui.scanLabel.textContent = errText('扫描失败', err);
    toast(errText('扫描失败', err), 'error');
  } finally {
    ui.scanBtn.disabled = false;
  }
}

function onScanProgress(msg) {
  const pct = msg.total ? Math.round((msg.done / msg.total) * 100) : 0;
  ui.scanBar.style.width = `${pct}%`;
  // 真实 WS 事件的 Scan 载荷是 {phase, done, total}，不带文件名；
  // 文件名目前只能在 /v1/library/status 里看到，二期的补点是把它放进事件。
  ui.scanLabel.textContent = msg.current
    ? `${pct}% · ${msg.current}`
    : `${phaseLabel(msg.phase)} ${pct}% · ${msg.done}/${msg.total}`;
  if (msg.total && msg.done >= msg.total) setTimeout(finishScan, 600);
}

function phaseLabel(phase) {
  return { scanning: '扫描中', walking: '扫描中', done: '完成', failed: '失败' }[phase] || '扫描中';
}

// 后端一直在 ScanProgress 里统计 added / failed / last_error，旧 UI 一个都没显示，
// 于是"扫了一半、其中 37 个文件解析失败"这类结果完全是静默的。
async function finishScan() {
  const status = await transport.get('/v1/library/status').catch(() => null);
  if (!status) { ui.scanLabel.textContent = '扫描完成'; return; }
  ui.scanLabel.textContent = `扫描完成 · 新增 ${status.added ?? '—'} 首 · 失败 ${status.failed ?? 0} 个`;
  if (status.failed) toast(`有 ${status.failed} 个文件未能解析${status.last_error ? `：${status.last_error}` : ''}`, 'error');
  else toast('扫描完成');
}

// ---------------------------------------------------------------------------
// 设置 / 输出设备（又一个后端已有、旧 UI 完全没接的能力）
// ---------------------------------------------------------------------------

async function loadSettings() {
  const s = await transport.get('/v1/settings').catch(() => ({}));
  state.settings = s || {};
  await loadScanHistory();
  if (ui.scanRoot && !ui.scanRoot.value && state.settings.last_scan_root) {
    ui.scanRoot.value = state.settings.last_scan_root;
  }
  ui.setDensity.value = state.settings.ui_density || 'comfortable';
  ui.setMotion.checked = state.settings.reduce_motion === true;
  document.body.dataset.density = ui.setDensity.value;
  document.body.classList.toggle('reduce-motion', ui.setMotion.checked);
  if (Stage) Stage.setReducedMotion(ui.setMotion.checked);
  // 封面盘是即时开关：恢复状态不写库（persist=false），也不经过 stage:control。
  setStageCover(state.settings.stage_cover, false);
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
  // 创意舞台的开关也在这里恢复：initCreative 跑的时候设置还没到手，在那里读
  // state.settings 只会拿到空对象 —— 症状是"上次明明开着三维，刷新后是关的"，
  // 而复选框停在未勾选，与服务端存的 true 不一致。只恢复一次，之后归用户管。
  if (!creativeRestored) {
    creativeRestored = true;
    const saved = !!state.settings.creative_stage;
    const degraded = state.settings.creative_stage_effective === 'standard';
    applyCreative(saved, false);
    if (saved && degraded) {
      showCreativeWarn(state.settings.creative_stage_note || '上次运行时设备不支持');
    }
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
  document.body.classList.remove('column-open');
  // 在线面板的首次拉取、分类/chips 状态都归 online.js，app.js 只通知进入。
  if (name === 'online') window.Online.onViewEnter();
  // 在线歌单可能在歌单视图没渲染期间到达（登录、刷新），进入时补一次同步。
  if (name === 'playlists') renderOnlinePlaylistSection();
  // 收藏与每日推荐同理：进入时才拉，避免启动时多打两条请求。
  if (name === 'favorites' && window.Favorites) window.Favorites.onViewEnter();
  if (name === 'library' && window.Daily) window.Daily.load({ silent: true });
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
      artwork: artUrl ? [{ src: artUrl, sizes: '512x512', type: 'image/svg+xml' }] : [],
    });
  } catch { /* 某些浏览器在缺字段时会抛，忽略即可 */ }
}

function syncMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState = state.snapshot.playing ? 'playing' : 'paused';
  if (state.snapshot.duration_ms) {
    try {
      navigator.mediaSession.setPositionState({
        duration: state.snapshot.duration_ms / 1000,
        playbackRate: 1,
        position: state.snapshot.position_ms / 1000,
      });
    } catch { /* positionState 在部分内核上不可用 */ }
  }
}

function bindMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const handlers = {
    play: () => transport.post('/v1/player/play', {}),
    pause: () => transport.post('/v1/player/pause', {}),
    previoustrack: () => transport.post('/v1/player/previous', {}),
    nexttrack: () => transport.post('/v1/player/next', {}),
    seekforward: (d) => seekRelative(d.seekOffset || 10),
    seekbackward: (d) => seekRelative(-(d.seekOffset || 10)),
  };
  for (const [name, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(name, (e) => fn(e).catch(() => {})); } catch { /* 不支持的动作 */ }
  }
}

// ---------------------------------------------------------------------------
// 控件
// ---------------------------------------------------------------------------

async function seekTo(ms) {
  await transport.post('/v1/player/seek', { position_ms: Math.max(0, Math.round(ms)) }).catch(() => {});
}

async function seekRelative(deltaSec) {
  const base = state.snapshot.position_ms || 0;
  await seekTo(base + deltaSec * 1000);
}

function setVolumeFromInput() {
  // 保持弹窗内音量滑块与底部播放栏一致
  if (np.volume) np.volume.value = ui.volume.value;
  transport.post('/v1/player/volume', { volume: Number(ui.volume.value) / 100 }).catch(() => {});
}

// ---------------------------------------------------------------------------
// 快捷键
// ---------------------------------------------------------------------------

function bindShortcuts() {
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); ui.search.focus(); ui.search.select(); return; }
    if (e.key === 'Escape') { closeMenu(); closeNowPlaying(); if (typing) document.activeElement.blur(); setView(state.view); document.body.classList.remove('stage-open'); return; }
    if (e.key === '/' && !typing) { e.preventDefault(); ui.search.focus(); return; }
    if (typing) return;

    switch (e.key) {
      case ' ': e.preventDefault(); togglePlay(); break;
      case 'ArrowRight': e.preventDefault(); if (e.shiftKey) post('next'); else seekRelative(5); break;
      case 'ArrowLeft': e.preventDefault(); if (e.shiftKey) post('previous'); else seekRelative(-5); break;
      case 'ArrowUp': e.preventDefault(); ui.volume.value = String(Math.min(100, Number(ui.volume.value) + 5)); setVolumeFromInput(); break;
      case 'ArrowDown': e.preventDefault(); ui.volume.value = String(Math.max(0, Number(ui.volume.value) - 5)); setVolumeFromInput(); break;
      case 'm': case 'M': {
        const v = Number(ui.volume.value) > 0 ? 0 : 80;
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
// 这一节只做四件事，一行业务渲染逻辑都没有：
//   1. 依次初始化表现层模块（三维舞台 / 背景 / 手绘 / 工坊）；
//   2. 把「三维舞台」这一个开关接到服务端设置上，其余细分参数全部归工坊；
//   3. 开三维时让原来的粒子层让位 —— 两者都是铺满舞台的氛围层，同时开会
//      互相糊住，而且 GPU 预算直接翻倍；
//   4. 降级时把原因说人话，而不是安静地什么都不显示。
// 背景与手绘不依赖三维舞台：它们各自独立生效，所以即使 WebGL 不可用，
// 背景层和手绘风格照样能用。
// ---------------------------------------------------------------------------

let particleBackup = null;
let creativeRestored = false;   // 设置到手后只恢复一次三维舞台开关，之后归用户管

function applyCreative(on, persist) {
  const want = !!on;
  if (ui.setCreative && ui.setCreative.checked !== want) ui.setCreative.checked = want;

  // 粒子层让位。备份的是用户自己的设置，关掉三维时原样还回去 —— 不做备份的话
  // "试一下三维"会永久改掉用户调好的粒子参数，而他不会想到去看那一栏。
  if (window.StageControl) {
    if (want) {
      if (!particleBackup) {
        const cur = StageControl.values();
        particleBackup = { dust: cur.dust, ripples: cur.ripples };
      }
      StageControl.set({ dust: false, ripples: false });
    } else if (particleBackup) {
      StageControl.set(particleBackup);
      particleBackup = null;
    }
  }

  // 用户亲手拨这个开关 = 一次明确的重试，之前那次降级的结论作废（attach 的
  // force 分支）。启动时按服务端存档恢复不算，那只是"把上次的选择再演一遍"。
  const effective = window.CreativeStage ? CreativeStage.attach(want, { force: !!persist }) : 'off';
  if (want && effective !== '3d') {
    const why = (window.CreativeStage && CreativeStage.degradedBecause()) || '设备不支持';
    showCreativeWarn(why);
    toast(`三维舞台已自动关闭：${why}`, 'error');
  } else {
    showCreativeWarn(null);
  }

  state.settings.creative_stage = want;
  if (persist) {
    transport.put('/v1/settings', { creative_stage: want })
      .catch((err) => toast(errText('保存创意舞台设置失败', err), 'error'));
    // 降级原因同样回报服务端：设置页和别的客户端因此能看到"实际生效"而不是
    // "用户想要什么"，与 render_mode_effective 是同一个思路。
    if (want && effective !== '3d') {
      transport.put('/v1/settings', {
        creative_stage_effective: 'standard',
        creative_stage_note: (window.CreativeStage && CreativeStage.degradedBecause()) || ''
      }).catch(() => {});
    } else {
      transport.put('/v1/settings', { creative_stage_effective: null }).catch(() => {});
    }
  }
}

function showCreativeWarn(reason) {
  if (!ui.creativeWarn) return;
  if (!reason) { ui.creativeWarn.hidden = true; ui.creativeWarn.textContent = ''; return; }
  ui.creativeWarn.hidden = false;
  ui.creativeWarn.className = 'render-warn is-error';
  ui.creativeWarn.textContent = `三维舞台已自动关闭：${reason}。背景层与手绘风格不受影响，仍可正常使用。`;
}

// 运行中（已经在画之后）被摘掉的降级：上下文丢失、着色器失败、探测判定 GPU
// 代价过高。attach 启动期的失败走 applyCreative 自己的分支，事件里 runtime
// 为 false，这里不接手 —— 否则会重复提示、重复回报。
function onCreativeRuntimeDegrade(ev) {
  const d = (ev && ev.detail) || {};
  if (!d.runtime) return;
  const why = d.reason || '设备不支持';
  if (ui.setCreative) ui.setCreative.checked = false;
  state.settings.creative_stage = false;
  // 与用户亲手关掉三维走同一套粒子还原约定：备份是用户自己的参数，原样还回去。
  if (window.StageControl && particleBackup) {
    StageControl.set(particleBackup);
    particleBackup = null;
  }
  showCreativeWarn(why);
  toast(`三维舞台已自动关闭：${why}`, 'error');
  // 设置页必须显示"生效真相"：creative_stage 也一并置 false，否则别的客户端
  // 打开设置看到的是"用户想要开"，而实际渲染层早已摘除。
  transport.put('/v1/settings', {
    creative_stage: false,
    creative_stage_effective: 'standard',
    creative_stage_note: why
  }).catch(() => {});
}

function initCreative() {
  if (window.CreativeStage) CreativeStage.init();
  if (window.Backgrounds) Backgrounds.init();
  if (window.HandDrawn) HandDrawn.init();
  if (window.Workshop) Workshop.init();

  // 打开工坊不影响渲染：它只是编辑同一份数据。所以两个入口（顶栏与设置页）
  // 都直接调 Workshop.toggle，不需要在这里复制状态。
  const openWs = () => { if (window.Workshop) Workshop.toggle(); };
  if (ui.workshopBtn) ui.workshopBtn.addEventListener('click', openWs);
  if (ui.setWorkshopBtn) ui.setWorkshopBtn.addEventListener('click', openWs);

  if (ui.setCreative) ui.setCreative.onchange = () => applyCreative(ui.setCreative.checked, true);

  document.addEventListener('creative:degrade', onCreativeRuntimeDegrade);

  // 存档的恢复不在这里：此刻 state.settings 还是空的（loadSettings 在
  // refreshAll 里，而 refreshAll 排在 initCreative 之后）。它和渲染模式、
  // 封面盘一样，都在设置到手之后由 loadSettings 统一恢复。
}

function togglePlay() {
  const next = !state.snapshot.playing;
  // 乐观更新 + 800ms 守卫窗口：按钮立刻响应，在途的旧快照不会把它弹回去。
  state.expectedPlaying = next;
  state.commandAt = Date.now();
  ui.playpause.classList.toggle('is-playing', next);
  if (np.play) np.play.classList.toggle('is-playing', next);
  post(next ? '/v1/player/play' : '/v1/player/pause');
}

// ---------------------------------------------------------------------------
// 播放控制弹窗（顶栏「正在播放」）
// ---------------------------------------------------------------------------

const np = {
  modal: $('np-modal'), scrim: $('np-scrim'), close: $('np-close'),
  art: $('np-art'), name: $('np-name'), artist: $('np-artist'),
  time: $('np-time'), bar: $('np-progress-bar'),
  play: $('np-playpause'), prev: $('np-prev'), next: $('np-next'), stop: $('np-stop'),
  volume: $('np-volume'), goto: $('np-goto-stage')
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
  if (state.current) syncNpTrack(state.current);
}

function closeNowPlaying() {
  np.scrim.hidden = true;
  np.modal.hidden = true;
}

// 播放快照 → 弹窗（播放态 / 时间 / 进度）
function syncNpSnapshot(snap) {
  if (!isNpOpen()) return;
  np.play.classList.toggle('is-playing', snap.playing);
  np.time.textContent = digestMs(snap.position_ms);
  if (!state.seeking && snap.duration_ms) {
    np.bar.value = String(Math.round((snap.position_ms / snap.duration_ms) * 1000));
  }
}

// 曲目信息 → 弹窗（标题 / 艺术家 / 封面）
function syncNpTrack(track, coverUrl) {
  if (!isNpOpen() || !track) return;
  np.name.textContent = track.title || '未命名';
  np.artist.textContent = [track.artist, track.album].filter(Boolean).join(' · ') || '未知艺术家';
  if (coverUrl) np.art.style.backgroundImage = `url("${coverUrl}")`;
}

function initNowPlayingModal() {
  if (!np.modal) return;

  np.close.onclick = closeNowPlaying;
  np.scrim.onclick = closeNowPlaying;

  np.play.onclick = togglePlay;
  np.prev.onclick = () => post('/v1/player/previous');
  np.next.onclick = () => post('/v1/player/next');
  np.stop.onclick = () => post('/v1/player/stop');

  // 进度：拖动即时显示时间，松手跳转
  np.bar.addEventListener('input', () => {
    const d = state.snapshot.duration_ms || 0;
    np.time.textContent = `${fmt((np.bar.value / 1000) * d)} / ${fmt(d)}`;
  });
  np.bar.addEventListener('change', async () => {
    const d = state.snapshot.duration_ms;
    if (d) await seekTo((np.bar.value / 1000) * d);
  });

  // 音量：与底部播放栏双向同步后走同一条设置链路
  np.volume.oninput = () => {
    ui.volume.value = np.volume.value;
    setVolumeFromInput();
  };

  // 跳转到舞台播放页面：关闭弹窗并打开全屏沉浸舞台
  np.goto.onclick = () => {
    closeNowPlaying();
    document.body.classList.remove('stage-open');
    if (Stage) Stage.setPage(true);
  };
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

(async function boot() {
  transport = await chooseTransport();
  if (transport.kind === 'demo') {
    ui.demoBadge.hidden = false;
    toast('未连接 vmusicd，已进入演示模式', 'info');
  }

  ui.playpause.onclick = togglePlay;
  ui.prev.onclick = () => post('/v1/player/previous');
  ui.next.onclick = () => post('/v1/player/next');
  ui.stop.onclick = () => post('/v1/player/stop');
  ui.mode.onclick = () => {
    const order = ['repeat', 'repeat_one', 'shuffle'];
    const next = order[(order.indexOf(state.snapshot.mode) + 1) % order.length];
    // VCP 把播放模式写进 localStorage；这里写服务端 settings，换浏览器也一致。
    transport.post('/v1/player/mode', { mode: next })
      .then(() => transport.put('/v1/settings', { play_mode: next }).catch(() => {}))
      .catch((err) => toast(errText('切换播放模式失败', err), 'error'));
  };

  ui.progress.addEventListener('pointerdown', () => { state.seeking = true; });
  ui.progress.addEventListener('input', () => {
    state.seeking = true;
    const d = state.snapshot.duration_ms || 0;
    ui.barTime.textContent = `${fmt((ui.progress.value / 1000) * d)} / ${fmt(d)}`;
    ui.progressGhost.style.width = `${(ui.progress.value / 10).toFixed(2)}%`;
  });
  ui.progress.addEventListener('change', async () => {
    const d = state.snapshot.duration_ms;
    if (d) await seekTo((ui.progress.value / 1000) * d);
    state.seeking = false;
  });

  ui.volume.oninput = setVolumeFromInput;

  let searchTimer = null;
  ui.search.oninput = () => {
    ui.searchClear.hidden = ui.search.value === '';
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = ui.search.value.trim(); loadTracks(true); }, 250);
  };
  ui.searchClear.onclick = () => { ui.search.value = ''; ui.searchClear.hidden = true; state.q = ''; loadTracks(true); };

  ui.libSort.onchange = () => { state.sort = ui.libSort.value; renderLibrary(); };

  ui.scanToggle.onclick = () => { ui.scanPanel.hidden = !ui.scanPanel.hidden; };
  $('empty-scan-btn').onclick = () => { ui.scanPanel.hidden = false; ui.scanRoot.focus(); };
  ui.scanBtn.onclick = startScan;

  ui.newPlaylistBtn.onclick = async () => {
    const name = ui.newPlaylistName.value.trim();
    if (!name) return;
    await transport.post('/v1/playlists', { name }).catch((e) => toast(errText('创建失败', e), 'error'));
    ui.newPlaylistName.value = '';
    loadPlaylists();
  };

  // 歌单详情头部
  const currentDetailPl = () => state.playlists.find((p) => p.id === detailPlaylistId);
  ui.plDetailBack.onclick = () => closeDetail();
  ui.plDetailPlay.onclick = () => { if (detailPlaylistId) playPlaylist(detailPlaylistId); };
  ui.plDetailQueue.onclick = () => { const p = currentDetailPl(); if (p) queuePlaylistNext(p.id); };
  ui.plDetailRename.onclick = () => { const p = currentDetailPl(); if (p) renamePlaylist(p); };
  ui.plDetailDelete.onclick = () => { const p = currentDetailPl(); if (p) deletePlaylist(p); };
  initDetailSortable();

  ui.queueClear.onclick = () => applyQueue(state.snapshot.track_id ? [state.snapshot.track_id] : [], true);

  ui.setDevice.onchange = () => transport.post('/v1/devices/select', { id: ui.setDevice.value }).catch(() => {});
  initRenderMode();

  ui.setDensity.onchange = () => {
    document.body.dataset.density = ui.setDensity.value;
    transport.put('/v1/settings', { ui_density: ui.setDensity.value }).catch(() => {});
  };
  ui.setMotion.onchange = () => {
    state.settings.reduce_motion = ui.setMotion.checked;
    document.body.classList.toggle('reduce-motion', ui.setMotion.checked);
    if (Stage) Stage.setReducedMotion(ui.setMotion.checked);
    transport.put('/v1/settings', { reduce_motion: ui.setMotion.checked }).catch(() => {});
  };
  ui.setStageCover.onchange = () => setStageCover(ui.setStageCover.checked, true);

  ui.rail.querySelectorAll('.rail-item').forEach((b) => { b.onclick = () => setView(b.dataset.view); });
  // 点击「正在播放」：弹出清晰的播放控制弹窗（不再切换舞台抽屉）
  ui.stageBtn.onclick = openNowPlaying;
  initNowPlayingModal();
  ui.scrim.onclick = () => { document.body.classList.remove('stage-open'); closeMenu(); };

  // 顶栏「账号」：任何视图下都能打开统一登录弹窗。
  const onlineAccountBtn = $('online-account-btn');
  if (onlineAccountBtn) {
    onlineAccountBtn.onclick = () => {
      if (window.OnlineLogin) window.OnlineLogin.open();
    };
  }

  // 滚到底自动加载下一页，取代"一次性拉 500 条"的硬截断。
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && state.tracks.length < state.total && !state.loading) {
        state.offset += PAGE;
        loadTracks(false);
      }
    }, { root: ui.column.querySelector('#view-library') }).observe(ui.libSentinel);
  }

  initTheme();
  initStageControl();
  initTopMoreMenu();
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
  });
  window.Online.init();
  // 在线歌单两层界面（web/online-playlist-view.js）：同样是先注入宿主再 init。
  // 宿主只给三样它自己造不出来的东西：层切换、音源能力位、队列写入。
  if (window.OnlinePlaylistView) {
    window.OnlinePlaylistView.bind({
      setLayer: setPlaylistLayer,
      caps: capsOfSource,
      enqueue: enqueueOnlineTracks,
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
    coverUrl: (id) => transport.coverUrl(id),
    playLocal: (id, queue) => playTrack(id, queue && queue.length ? queue : [id]),
    // 电台/在线收藏：整盘载入交给 online.js 的试听链路。
    playOnline: (f) => { if (window.Online) window.Online.playAll([toOnlineTrack(f)], 0); },
    playRadio: (f) => { if (window.Online) window.Online.playAll([toOnlineTrack(f)], 0); },
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
  // 在线歌单（账号区网格）任何变化都同步重绘左侧歌单菜单的在线分区。
  document.addEventListener('online-playlists:changed', renderOnlinePlaylistSection);
  initStage();
  initCreative();
  bindShortcuts();
  initBarAutohide();
  bindMediaSession();

  setView('library');
  await refreshAll();
  const health = await transport.get('/v1/health').catch(() => null);
  if (health) {
    ui.setBackend.textContent = `${health.backend} · v${health.version} · 协议 ${health.protocol_version}`;
  }
  openSocket();
})();
