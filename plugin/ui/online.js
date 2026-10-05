// SPDX-License-Identifier: MIT
//
// 在线曲库：音源清单、搜索/分类浏览、All 聚合、整盘试听。
//
// 搜索/分类走服务端代理（第三方音乐接口没有 CORS 头）；试听则是服务端把远程
// 音频渐进下载并缓存，用 `online:<source>:<id>` 这个虚拟 id 走一遍和本地曲目完全
// 相同的 load 链路——快照、进度条、舞台因此全部复用，无需第二套状态机。
//
// app.js 在启动时先 bind() 注入宿主依赖（ui/state/渲染工具），再 init()。
(function () {
  'use strict';
  var T = null; // app.js 的 VMusicTransport 在本脚本之后才挂到 window，
                // 所以不能在 IIFE 顶层抓，bind() 时（app 启动序列里）再取。
  var H = null; // 宿主：{ ui, state, setStateQueue, applyQueue, paintArt,
                //       probeImage, fmt, toast, errText }

  /// 背景图位封面：插件形态下远程地址要经 sidecar 换成 data URL（沙箱 CSP 画不
  /// 出 https 图）。HertzCovers 由 app.js 挂出；契约检查的沙箱只加载本模块，
  /// 拿不到时回落成直接赋值，即独立形态的同款行为。
  function applyBg(el, url) {
    if (window.HertzCovers) { window.HertzCovers.applyBg(el, url); return; }
    if (el) el.style.backgroundImage = url ? 'url("' + url + '")' : '';
  }

  // 本文件内没有全局 $；个人区新增元素直接按 id 取，不经 H.ui。
  function $(id) { return document.getElementById(id); }

  var onlineState = {
    source: 'netease',
    q: '',
    cat: 'hot',
    tracks: [],
    total: 0,
    loading: false,
    // All 聚合时为 true：此入口保持单曲试听，跨源队列由宿主的混合队列入口管理。
    aggregate: false,
    // 音源清单由 /v1/online/sources 填；拉不到时下拉框保持 index.html 的静态项。
    sources: [],
  };

  // 虚拟曲目的元数据。本地曲库里查不到这些 id，宿主的「正在播放」逻辑会回落
  // 到这里（getMeta）。
  var onlineMeta = new Map();

  // 元数据落盘：页面一重启内存快照就清空，队列行退化成「未知曲目」；源侧日后失效
  // （下架 / VIP 拒绝）时连补详情都补不回来。所以每拿到一份元数据就写进 localStorage
  // （插件形态是宿主替身，boot 里 hydrate 之后才可读），启动时再喂回内存。
  var META_STORE_KEY = 'vmusic.online.meta.v1';
  var META_STORE_MAX = 400;
  var metaStore = {};
  var metaStoreTimer = 0;
  function scheduleMetaStoreSave() {
    clearTimeout(metaStoreTimer);
    metaStoreTimer = setTimeout(function () {
      try {
        var keys = Object.keys(metaStore);
        // 键序即插入序：超上限就砍掉最老的一批，别把替身存储撑爆。
        if (keys.length > META_STORE_MAX) keys.slice(0, keys.length - META_STORE_MAX).forEach(function (k) { delete metaStore[k]; });
        localStorage.setItem(META_STORE_KEY, JSON.stringify(metaStore));
      } catch (e) { /* 存不下就退回落盘前的行为，不影响播放 */ }
    }, 400);
  }
  function rememberMeta(id, meta) {
    onlineMeta.set(id, meta);
    if (id && meta && (meta.title || meta.artist)) { metaStore[id] = meta; scheduleMetaStoreSave(); }
    return meta;
  }
  function seedMetaFromStore() {
    try {
      var raw = localStorage.getItem(META_STORE_KEY);
      var obj = raw ? JSON.parse(raw) : null;
      if (!obj || typeof obj !== 'object') return;
      metaStore = obj;
      Object.keys(obj).forEach(function (id) { if (!onlineMeta.has(id)) onlineMeta.set(id, obj[id]); });
    } catch (e) { /* 坏数据就当没有 */ }
  }

  // 平台徽标：品牌名 / 品牌色 / app 图标。音源 id 以后端注册表为准，
  // 这里只负责显示。
  // 第三项是图标地址：平台一律用 docs/images 提供的官方 app 图标（经
  // /platform-icons/ 内嵌分发，统一 256×256 PNG），不再用手绘的单色字形——
  // 第三方商标轮廓再像也是「仿造」，官方图辨识度更高，且五张图同一规格，
  // 各徽标位上的显示尺寸天然一致。本地曲库与未登记音源没有对应官方图，
  // 继续走 index.html 的 sprite 字形（id 以 i- 开头）。酷我此前整条缺席，
  // 一直降级成通用地球图标，这里补齐。
  var SOURCE_BADGE = {
    netease: ['网易云音乐', '#e60026', '/platform-icons/netease.png'],
    qq: ['QQ 音乐', '#12b7f5', '/platform-icons/qq.png'],
    kugou: ['酷狗音乐', '#2ca5f0', '/platform-icons/kugou.png'],
    kuwo: ['酷我音乐', '#f5a623', '/platform-icons/kuwo.png'],
    qishui: ['汽水音乐', '#45d68f', '/platform-icons/qishui.png'],
    // 本地曲库也走同一套徽标：唱片图标 + 主题色（不占任何平台品牌色）。
    local: ['本地曲库', null, 'i-app-local'],
  };

  // 未登记音源（如 ccmixter）的兜底图标：地球，配主题色而非某个平台的品牌色。
  var GENERIC_ICON = 'i-app-generic';

  // 位图图标以 '/' 开头（站内资源路径）；sprite 字形 id 以 'i-' 开头。
  function isImgIcon(icon) {
    return typeof icon === 'string' && icon.charAt(0) === '/';
  }

  function sourceLabel(id) {
    var info = onlineState.sources.find(function (s) { return s.id === id; });
    return (info && info.label) || id;
  }

  /// 站内资源 URL。独立形态恒等返回；DBX 插件形态下按宿主的 <base href> 补全，
  /// 否则根相对路径会丢掉插件 id 前缀而 404（详见 host.js 的 assetUrl）。
  /// 声明处一律保持根相对，只在赋给 DOM 的这一刻过一遍。
  function assetUrl(url) {
    return window.hertzHost ? window.hertzHost.assetUrl(url) : url;
  }

  // 平台徽标节点。平台源是官方 app 图标的 PNG（.is-img，容器透明，图片
  // 填满同一尺寸的圆角方块）；本地/未登记音源仍是品牌色圆角方块 + 白色
  // 图标字形。图标本身不带文字，所以平台名必须挂到 title 与 aria-label
  // 上——否则读屏用户和想确认来源的人只能看到一个色块。
  function badge(source, label) {
    var b = sourceBadge(source);
    var name = b ? b.text : (label || sourceLabel(source));
    var icon = b ? b.icon : GENERIC_ICON;
    var s = document.createElement('span');
    // 直接写完整 className：测试桩的 className 与 classList 互不同步。
    s.className = isImgIcon(icon) ? 'src-badge is-img' : 'src-badge';
    if (isImgIcon(icon)) {
      s.innerHTML = '<img src="' + assetUrl(icon) + '" alt="" aria-hidden="true">';
    } else {
      // 没有登记品牌色的（本地 / 未登记音源）不写 --badge，让 CSS 回落到主题色。
      if (b && b.color) s.style.setProperty('--badge', b.color);
      s.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#'
        + icon + '"/></svg>';
    }
    s.title = name;
    s.setAttribute('aria-label', name);
    return s;
  }

  // 平台品牌名、品牌色与 app 图标；未登记的音源回 null。
  //
  // 这是徽标信息的唯一事实源：online-playlists.js 的歌单菜单也来问这里，
  // 避免两张表漂移后同一个音源在搜索结果与歌单菜单里长得不一样。
  function sourceBadge(source) {
    var b = SOURCE_BADGE[source];
    return b ? { text: b[0], color: b[1], icon: b[2] } : null;
  }

  // 只取图标 id（歌单菜单等只画图标、自己管颜色的地方用）。
  function sourceIcon(id) {
    var b = sourceBadge(id);
    return b ? b.icon : GENERIC_ICON;
  }

  function virtualId(t) {
    return 'online:' + t.source + ':' + t.id;
  }

  // 封面地址归一：http 升 https（页面跑在 https 下时 http 子资源会被直接拦掉），
  // 空串/空白一律当作「没有封面」。
  function safeCoverUrl(url) {
    if (!url) return null;
    var s = String(url).trim();
    if (!s) return null;
    if (s.indexOf('//') === 0) return 'https:' + s;
    if (s.indexOf('http://') === 0) return s.replace(/^http:\/\//, 'https://');
    return s;
  }

  // 小尺寸展示位用的封面地址。网易云 CDN 认 `?param=宽y高` 缩略图参数：上游
  // 给的原图动辄 300KB 以上，一屏 30 首就是近 10MB，封面得等好几秒才浮出来
  // （看起来就像「没有封面」）。行里只有 40px，换成 90px 的小图（约 2KB）
  // 几乎瞬间出现；歌单卡片传 300。正在播放与舞台仍用全尺寸原图——那里才是
  // 真需要分辨率的地方（舞台封面会铺满视口）。
  function rowCoverUrl(url, px) {
    if (!url) return null;
    if (url.indexOf('.music.126.net/') < 0 || url.indexOf('?') >= 0) return url;
    var n = px || 90;
    return url + '?param=' + n + 'y' + n;
  }

  // 直接复用曲库行的 .track 栅格与子元素类名，在线结果因此和本地曲库长得一样。
  // activate 由调用方给：搜索结果页用「整盘入队」，歌单抽屉用「整盘详情入队」，
  // 标记/置灰/VIP 闸门在这里统一做，调用方只管激活后干什么。
  function buildRow(track, activate) {
    var row = document.createElement('div');
    // 无试听地址：整行置灰。只禁用按钮不够，行点击也必须失效。
    // VIP 曲目不在这里拦截：后端取流时带着用户自己的账号 cookie，VIP 账号
    // 真能拿到完整曲目（已真机验证）；拿不到时后端如实报错（未登录提示
    // 登录、无版权提示下架），前端预判只会误伤登录的 VIP 用户。
    var disabled = !track.playable;
    row.className = 'track online-row' + (disabled ? ' is-disabled' : '');
    row.dataset.onlineId = virtualId(track);
    row.innerHTML =
      '<div class="t-index"><span class="t-num">♪</span></div>' +
      '<div class="t-art is-remote"></div>' +
      '<div class="t-main">' +
        '<div class="t-title"></div>' +
        '<div class="t-sub"></div>' +
      '</div>' +
      '<div class="t-album"></div>' +
      '<div class="t-quality"></div>' +
      '<div class="t-dur"></div>' +
      '<div class="t-actions">' +
        '<button class="t-act" data-act="preview" title="在线试听" aria-label="在线试听">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-play"/></svg>' +
        '</button>' +
      '</div>';
    row.querySelector('.t-title').textContent = track.title;
    row.querySelector('.t-sub').textContent = track.artist || '未知艺术家';
    row.querySelector('.t-album').textContent = track.album || '—';
    row.querySelector('.t-dur').textContent = H.fmt(track.duration_ms || 0);
    H.paintArt(row, rowCoverUrl(safeCoverUrl(track.cover)));

    var quality = row.querySelector('.t-quality');
    quality.appendChild(badge(track.source));
    if (track.vip_only) {
      var vip = document.createElement('span');
      vip.className = 'vip-tag';
      vip.textContent = 'VIP';
      quality.appendChild(vip);
    }

    // 在线曲目也能收藏：source 是音源 id、ref_id 是该音源内的曲目 id。
    // 收藏列表因此能直接显示快照，不登录也能看到自己收藏过什么。
    if (window.Favorites) {
      window.Favorites.attachHeart(row.querySelector('.t-actions'), {
        kind: 'track',
        source: track.source,
        ref_id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration_ms: track.duration_ms,
        cover: track.cover,
      });
    }

    // 加入自建歌单：混合歌单的关键入口。菜单由宿主（app.js）出——它持有
    // 自建歌单清单；这里只把整份在线曲目（含快照字段）交过去。
    if (H.addToPlaylistMenu) {
      var plBtn = document.createElement('button');
      plBtn.className = 't-act';
      plBtn.type = 'button';
      plBtn.title = '加入歌单';
      plBtn.setAttribute('aria-label', '加入歌单');
      plBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-playlist"/></svg>';
      plBtn.onclick = function (e) {
        e.stopPropagation();
        H.addToPlaylistMenu(track, plBtn, e);
      };
      var plActions = row.querySelector('.t-actions');
      // 红心（若已挂）在最前，加入歌单排第二，试听按钮保持最后。
      var anchorNode = plActions.firstChild && plActions.firstChild.nextSibling
        ? plActions.firstChild.nextSibling : null;
      if (anchorNode) plActions.insertBefore(plBtn, anchorNode);
      else plActions.appendChild(plBtn);
    }

    var btn = row.querySelector('[data-act="preview"]');
    btn.disabled = disabled;
    btn.title = track.vip_only
      ? 'VIP 专享，登录会员账号后可完整播放'
      : (track.playable ? '在线试听' : '该音源没有可用的试听地址');

    row.dataset.previewTitle = btn.title;
    btn.onclick = function (e) { e.stopPropagation(); activate(); };
    row.addEventListener('click', activate);
    row.tabIndex = disabled ? -1 : 0;
    row.addEventListener('keydown', function (e) {
      if (e.target !== row || disabled || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault(); activate();
    });
    paintRowPlayback(row);
    return row;
  }

  function onlineRow(track) {
    return buildRow(track, function () {
      // VIP 曲也放行：能不能播由后端按账号 cookie 定，失败如实 toast。
      if (!track.playable) return;
      // All 视图保持单曲试听；单源视图整盘入队，点第几首
      // 就从第几首开始（后端队列与高亮都以同一批虚拟 id 为准）。
      if (onlineState.aggregate) {
        playAll([track], 0);
      } else {
        var idx = onlineState.tracks.indexOf(track);
        playAll(onlineState.tracks, idx < 0 ? 0 : idx);
      }
    });
  }

  // One search session owns all source pages. Late responses never mutate a newer session.
  var searchEpoch = 0;
  var searchSession = null;
  var searchCache = new Map();
  var searchViews = new Map();
  // Use a page size accepted by every registered provider (KuGou caps at 20).
  // Otherwise a valid full KuGou page looks short and pagination stops early.
  var PAGE_SIZE = 20;
  var CACHE_TTL = 120000;
  var CACHE_LIMIT = 12;

  function normalizeSearch(value) {
    return String(value || '').normalize('NFKC').toLowerCase().trim();
  }

  function relevance(track, query) {
    var title = normalizeSearch(track.title);
    var artist = normalizeSearch(track.artist);
    var album = normalizeSearch(track.album);
    var q = normalizeSearch(query);
    if (!q) return 0;
    var score = title === q ? 1000 : title.indexOf(q) >= 0 ? 500 : 0;
    if (artist === q) score += 400;
    else if (artist.indexOf(q) >= 0) score += 200;
    if (album.indexOf(q) >= 0) score += 80;
    q.split(/\s+/).forEach(function (word) {
      if (title.indexOf(word) >= 0) score += 40;
      if (artist.indexOf(word) >= 0) score += 25;
      if (album.indexOf(word) >= 0) score += 10;
    });
    return score;
  }

  function highlight(node, value, query) {
    var text = String(value || '');
    node.textContent = '';
    var words = String(query || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) { node.textContent = text; return; }
    var lower = text.toLowerCase();
    var cursor = 0;
    while (cursor < text.length) {
      var start = text.length, size = 0;
      words.forEach(function (word) {
        var at = lower.indexOf(word.toLowerCase(), cursor);
        if (at >= 0 && (at < start || (at === start && word.length > size))) {
          start = at; size = word.length;
        }
      });
      if (start > cursor) node.appendChild(document.createTextNode(text.slice(cursor, start)));
      if (!size) break;
      var mark = document.createElement('mark');
      mark.textContent = text.slice(start, start + size);
      node.appendChild(mark);
      cursor = start + size;
    }
  }

  function searchScroller() {
    var body = H.ui.onlineBody;
    return body.closest ? body.closest('.online-scroll') || body : body;
  }

  function cancelSearch() {
    if (searchSession) {
      searchViews.delete(searchSession.key);
      searchViews.set(searchSession.key, { scroll: searchScroller().scrollTop || 0, filter: searchSession.filter });
      while (searchViews.size > CACHE_LIMIT) searchViews.delete(searchViews.keys().next().value);
    }
    searchEpoch += 1;
    if (searchSession) searchSession.pages.forEach(function (p) {
      if (p.controller) p.controller.abort();
    });
    searchSession = null;
    onlineState.loading = false;
    if (H.ui.onlineSentinel) H.ui.onlineSentinel.hidden = true;
  }

  function searchButton(label, action, cls) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = cls || 'btn';
    button.textContent = label;
    button.onclick = action;
    return button;
  }

  function renderOnline() {
    var body = H.ui.onlineBody;
    if (!body) return;
    var session = searchSession;
    var scroller = searchScroller();
    var scroll = scroller.scrollTop;
    var anchor = null;
    if (session && !session.resetScroll && scroller.getBoundingClientRect) {
      var top = scroller.getBoundingClientRect().top;
      body.querySelectorAll('.online-row').forEach(function (row) {
        if (!anchor && row.getBoundingClientRect().bottom > top) {
          anchor = { id: row.dataset.onlineId, top: row.getBoundingClientRect().top };
        }
      });
    }
    var active = document.activeElement;
    var focusKey = active && active.dataset && active.dataset.searchKey;
    body.innerHTML = '';
    if (!session) {
      if (H.ui.onlineCount) H.ui.onlineCount.textContent = '0 首';
      body.innerHTML = '<div class="hint">输入关键词搜索，或选择分类浏览。</div>';
      return;
    }
    var pages = session.pages;
    var flat = [];
    pages.forEach(function (p) { flat = flat.concat(p.tracks); });
    // Deterministic ties follow registry/page order, independent of response timing.
    if (session.aggregate) flat = flat.map(function (track, index) {
      return { track: track, index: index, score: relevance(track, session.q) };
    }).sort(function (a, b) { return b.score - a.score || a.index - b.index; })
      .map(function (item) { return item.track; });
    onlineState.tracks = flat;
    onlineState.total = flat.length;
    onlineState.loading = pages.some(function (p) { return p.loading; });
    cacheTracks(flat);
    if (H.ui.onlineSentinel) H.ui.onlineSentinel.hidden = true;
    if (H.ui.onlineCount) H.ui.onlineCount.textContent = flat.length + ' 首已加载';

    var summary = document.createElement('div');
    summary.className = 'search-summary';
    summary.setAttribute('role', 'status');
    summary.textContent = (session.q ? '“' + session.q + '” · ' : '') + flat.length
      + ' 首已加载 · ' + pages.filter(function (p) { return !p.loading; }).length
      + '/' + pages.length + ' 个音源已响应';
    body.appendChild(summary);
    if (session.aggregate) {
      var filters = document.createElement('div');
      filters.className = 'search-source-filters';
      filters.setAttribute('aria-label', '筛选搜索来源');
      [{ source: '', label: '综合', tracks: flat }].concat(pages).forEach(function (p) {
        var label = (p.label || sourceLabel(p.source)) + ' · ' + p.tracks.length;
        if (p.loading) label += ' · 搜索中';
        else if (p.error) label += ' · 失败';
        var button = searchButton(label, function () {
          session.filter = p.source; session.resetScroll = true; renderOnline();
        }, 'chip' + (session.filter === p.source ? ' active' : ''));
        button.dataset.searchKey = 'filter:' + p.source;
        button.setAttribute('aria-pressed', String(session.filter === p.source));
        filters.appendChild(button);
      });
      body.appendChild(filters);
    }
    var shown = session.filter ? flat.filter(function (t) { return t.source === session.filter; }) : flat;
    var list = document.createElement('div');
    list.className = 'search-results';
    shown.forEach(function (t) {
      var row = session.rows.get(virtualId(t));
      if (!row) {
        row = onlineRow(t);
        highlight(row.querySelector('.t-title'), t.title, session.q);
        highlight(row.querySelector('.t-sub'), t.artist || '未知艺术家', session.q);
        highlight(row.querySelector('.t-album'), t.album || '—', session.q);
        session.rows.set(virtualId(t), row);
      }
      paintRowPlayback(row);
      list.appendChild(row);
    });
    body.appendChild(list);
    var visiblePages = pages.filter(function (p) { return !session.filter || p.source === session.filter; });
    if (!shown.length && visiblePages.some(function (p) { return p.loading; })) {
      for (var i = 0; i < 6; i++) {
        var skeleton = document.createElement('div');
        skeleton.className = 'search-skeleton';
        skeleton.setAttribute('aria-hidden', 'true');
        skeleton.innerHTML = '<span></span><span></span><span></span>';
        list.appendChild(skeleton);
      }
    } else if (!shown.length && !visiblePages.some(function (p) { return p.error; })) {
      var empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = '没有找到歌曲，试试歌名或歌手名。';
      list.appendChild(empty);
    }
    var statuses = document.createElement('div');
    statuses.className = 'search-source-statuses';
    visiblePages.forEach(function (p) {
      var item = document.createElement('div');
      item.className = 'search-source-status' + (p.error ? ' all-failed' : '');
      item.appendChild(badge(p.source));
      var text = document.createElement('span');
      text.textContent = sourceLabel(p.source) + ' · ' + p.tracks.length + ' 首已加载'
        + (p.loading ? ' · 加载中…' : p.error ? ' · ' + p.error : !p.more ? ' · 暂无更多结果' : '')
        + (p.warning ? ' · ' + p.warning : '');
      item.appendChild(text);
      if (p.error || p.more) {
        var more = searchButton(p.error ? '重试' : '加载更多', function () { return loadSearchPage(session, p); });
        more.disabled = p.loading;
        more.dataset.searchKey = 'more:' + p.source;
        item.appendChild(more);
      }
      statuses.appendChild(item);
    });
    body.appendChild(statuses);
    scroller.scrollTop = session.resetScroll ? 0 : scroll;
    session.resetScroll = false;
    if (anchor) {
      var anchorRow = session.rows.get(anchor.id);
      if (anchorRow && list.contains && list.contains(anchorRow)) {
        scroller.scrollTop += anchorRow.getBoundingClientRect().top - anchor.top;
      }
    }
    if (focusKey) body.querySelectorAll('[data-search-key]').forEach(function (el) {
      if (el.dataset.searchKey === focusKey) el.focus({ preventScroll: true });
    });
  }

  async function loadSearchPage(session, page) {
    if (session !== searchSession || page.loading || (!page.more && !page.error)) return;
    page.loading = true;
    page.error = '';
    page.controller = typeof AbortController === 'function' ? new AbortController() : null;
    renderOnline();
    try {
      var params = new URLSearchParams({ source: page.source, limit: String(PAGE_SIZE), offset: String(page.offset) });
      if (session.q) params.set('q', session.q);
      else if (session.cat) params.set('cat', session.cat);
      var result = await T.get('/v1/online/search?' + params.toString(),
        page.controller ? { signal: page.controller.signal } : {});
      if (session !== searchSession) return;
      var raw = result.tracks || [];
      var seen = new Set(page.tracks.map(virtualId));
      var added = 0;
      raw.forEach(function (t) {
        // The requested provider owns identity, even when an upstream omits source.
        var track = Object.assign({}, t, { source: page.source });
        if (!seen.has(virtualId(track))) {
          seen.add(virtualId(track)); page.tracks.push(track); added += 1;
        }
      });
      page.offset += raw.length;
      page.more = raw.length >= PAGE_SIZE && added > 0;
      page.warning = result.warning || '';
      // Search cache is bounded and only contains successful snapshots, never live requests.
      if (session.q) {
        var key = JSON.stringify([session.q, page.source]);
        searchCache.delete(key);
        if (page.tracks.length <= 300) searchCache.set(key, { time: Date.now(), tracks: page.tracks.slice(), offset: page.offset, more: page.more, warning: page.warning });
        while (searchCache.size > CACHE_LIMIT) searchCache.delete(searchCache.keys().next().value);
      }
    } catch (err) {
      if (session !== searchSession) return;
      page.error = H.errText('搜索失败', err);
      if (!session.aggregate && !session.silent) H.toast(page.error, 'error');
    } finally {
      if (session === searchSession) {
        page.loading = false;
        page.controller = null;
        renderOnline();
      }
    }
  }

  async function search(opts) {
    opts = opts || {};
    cancelSearch();
    var epoch = searchEpoch;
    var source = onlineState.source;
    var query = onlineState.q.trim();
    onlineState.aggregate = source === 'all';
    onlineState.tracks = [];
    onlineState.total = 0;
    if (H.ui.onlineCount) H.ui.onlineCount.textContent = '0 首已加载';
    if (source === 'all' && !query) {
      renderOnline();
      H.ui.onlineBody.innerHTML = '<div class="hint">聚合搜索需要输入关键词。</div>';
      return;
    }
    if (source === 'all' && !onlineState.sources.length) {
      H.ui.onlineBody.innerHTML = '<div class="hint">正在读取音源…</div>';
      try {
        var data = await T.get('/v1/online/sources');
        if (epoch !== searchEpoch) return;
        onlineState.sources = data.sources || [];
        if (!onlineState.sources.length) throw new Error('没有可用音源');
      } catch (err) {
        if (epoch !== searchEpoch) return;
        renderOnline();
        var retry = searchButton('读取音源失败，点击重试', function () { search(opts); });
        H.ui.onlineBody.appendChild(retry);
        return;
      }
    }
    var ids = source === 'all' ? onlineState.sources.map(function (s) { return s.id; }) : [source];
    var viewKey = JSON.stringify([query, source, query ? '' : onlineState.cat]);
    var view = searchViews.get(viewKey);
    var session = { key: viewKey, rows: new Map(), q: query, cat: onlineState.cat, aggregate: source === 'all', filter: view ? view.filter : '', silent: opts.silent, pages: [] };
    session.pages = ids.map(function (id) {
      var cached = query && searchCache.get(JSON.stringify([query, id]));
      if (cached && Date.now() - cached.time >= CACHE_TTL) cached = null;
      return { source: id, tracks: cached ? cached.tracks.slice() : [], offset: cached ? cached.offset : 0,
        more: cached ? cached.more : true, warning: cached ? cached.warning : '', error: '', loading: false, cached: !!cached };
    });
    searchSession = session;
    searchScroller().scrollTop = 0;
    renderOnline();
    if (view && session.pages.every(function (p) { return p.cached; })) searchScroller().scrollTop = view.scroll;
    await Promise.all(session.pages.map(function (p) {
      return p.cached ? Promise.resolve() : loadSearchPage(session, p);
    }));
  }

  function searchOnline(opts) { return search(opts); }

  function cacheTracks(tracks) {
    tracks.forEach(function (t) {
      rememberMeta(virtualId(t), {
        id: virtualId(t),
        source: t.source,
        onlineId: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album,
        duration_ms: t.duration_ms,
        cover: safeCoverUrl(t.cover),
        vip_only: !!t.vip_only,
      });
    });
  }

  // 整盘试听：把当前页（或单曲）整盘 tracks 连同当前曲的平台引用一起 POST。
  // 后端先占队列再现取首曲，返回与 tracks 同序的虚拟 id 列表；失败时后端会
  // 自行恢复它自己的队列，这里只报错，不乐观改本地队列。
  var pendingPlay = null;
  var failedPlay = null;
  var onlinePlayEpoch = 0;

  function paintRowPlayback(row) {
    var id = row.dataset.onlineId;
    var loading = pendingPlay && pendingPlay.id === id && pendingPlay.current();
    var error = failedPlay && failedPlay.id === id;
    row.classList.toggle('is-loading', !!loading);
    row.classList.toggle('has-play-error', !!error);
    row.setAttribute('aria-busy', String(!!loading));
    var button = row.querySelector('[data-act="preview"]');
    if (loading) { button.title = '正在加载歌曲…'; button.setAttribute('aria-label', '正在加载歌曲'); }
    else if (error) { button.title = failedPlay.message + ' · 点击重试'; button.setAttribute('aria-label', '播放失败，点击重试'); }
    else {
      button.title = row.dataset.previewTitle || '在线试听';
      button.setAttribute('aria-label', '在线试听');
    }
    if (!row._onlineLoadStatus) {
      row._onlineLoadStatus = document.createElement('span');
      row._onlineLoadStatus.className = 'online-load-state';
      row.querySelector('.t-main').appendChild(row._onlineLoadStatus);
    }
    row._onlineLoadStatus.hidden = !loading && !error;
    row._onlineLoadStatus.textContent = loading ? '正在加载…' : error ? '播放失败 · 点击重试' : '';
    row._onlineLoadStatus.title = error ? failedPlay.message : '';
    var status = row.querySelector('.t-num');
    status.textContent = loading ? '…' : error ? '!' : '♪';
    status.title = loading ? '正在加载歌曲' : error ? failedPlay.message : '';
  }

  function refreshPlaybackRows() {
    document.querySelectorAll('.online-row').forEach(paintRowPlayback);
  }

  async function playAll(tracks, index) {
    if (!tracks || !tracks.length) return;
    index = Math.max(0, Math.min(index || 0, tracks.length - 1));
    var id = virtualId(tracks[index]);
    if (pendingPlay && pendingPlay.id === id && pendingPlay.current()) return;
    var epoch = ++onlinePlayEpoch;
    var ticket = T.playbackIntent ? T.playbackIntent() : null;
    function current() { return epoch === onlinePlayEpoch && (!T.isPlaybackIntent || T.isPlaybackIntent(ticket)); }
    pendingPlay = { id: id, current: current };
    failedPlay = null;
    var source = tracks[0].source;
    H.ui.playpause.classList.add('is-loading');
    var res;
    try {
      var request = T.post('/v1/online/play', {
        source: source,
        tracks: tracks.map(function (t) {
          return {
            id: t.id,
            title: t.title,
            artist: t.artist,
            album: t.album,
            duration_ms: t.duration_ms,
            cover: t.cover,
            ref: t.ref || t.track_ref || {},
          };
        }),
        index: index,
      });
      ticket = T.playbackIntent ? T.playbackIntent() : null;
      refreshPlaybackRows();
      if (window.Stage) window.Stage.setLyrics(null);
      res = await request;
      if (!current()) return;
    } catch (err) {
      if (!current()) return;
      failedPlay = { id: id, message: H.errText('试听失败', err) };
      H.toast(failedPlay.message, 'error');
      H.ui.playpause.classList.remove('is-loading');
      return;
    } finally {
      if (epoch === onlinePlayEpoch) {
        pendingPlay = null;
        refreshPlaybackRows();
      }
      if (current()) H.ui.playpause.classList.remove('is-loading');
    }

    var ids = (res.track_ids && res.track_ids.length)
      ? res.track_ids
      : tracks.map(virtualId);
    var startIndex = (res.index != null && res.index < ids.length) ? res.index : index;
    var startId = ids[startIndex];

    // 整盘元数据入缓存：切到队列里其他曲目时不再依赖搜索结果对象。
    tracks.forEach(function (t, i) {
      var meta = {
        id: ids[i],
        source: t.source,
        onlineId: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album,
        duration_ms: t.duration_ms,
        cover: safeCoverUrl(t.cover),
        vip_only: !!t.vip_only,
      };
      rememberMeta(ids[i], meta);
      H.state.byId.set(ids[i], meta);
    });
    var meta = onlineMeta.get(startId);
    // 封面以服务端补的详情为准，其次才是搜索结果里带的。
    var cover = safeCoverUrl(res.cover) || (meta && meta.cover) || null;
    if (meta) meta.cover = cover;
    H.state.current = meta;
    H.setStateQueue(ids, startId);

    // 先把能确定的部分画出来（标题/歌手/封面），歌词异步补，
    // 这样即使歌词接口慢或失败，界面也不会停在空白上。
    paintNowPlaying(meta, cover);
    // 实际可用档位：上游可能给不到请求档（如未登录拿不到无损）。放在
    // paintNowPlaying 之后写 nowTech，否则会被默认的「在线试听」文案盖掉。
    if (res.actual_quality) {
      var requested = qualityMap[source];
      if (requested && requested !== res.actual_quality && !window.__qtoast) {
        window.__qtoast = true;
        H.toast('该曲目实际可用：' + qualityLabel(res.actual_quality));
      }
      var tech = H.ui.nowTech;
      if (tech) tech.textContent = '在线 · ' + qualityLabel(res.actual_quality);
    }
    if (window.Stage && meta) window.Stage.setTrack(meta, cover);
    if (meta) H.toast('试听《' + meta.title + '》');

    // 封面加载不出来就撤掉改用占位图，不留一个永不显示的背景。
    // 插件形态下 cover 是音源直链：probe 前必须先换成 data URL，否则直链在沙箱
    // 里必然加载失败，会把一张好封面误判成坏图撤掉。
    var probeTarget = cover;
    if (cover && window.HertzCovers && window.HertzCovers.resolve) {
      probeTarget = (await window.HertzCovers.resolve(cover)) || cover;
    }
    var coverOk = !cover || await H.probeImage(probeTarget);
    if (!current()) return;
    if (!coverOk) {
      if (meta) meta.cover = null;
      paintNowPlaying(meta, null);
      if (window.Stage && meta) window.Stage.setTrack(meta, null);
    }
    loadOnlineLyrics(meta, current);
  }

  // 在线歌词：接口无数据/无权限都按无歌词处理；网络错误也只是不显示歌词，
  // 不打断播放。
  async function loadOnlineLyrics(meta, isCurrent) {
    if (!meta || !meta.source || !meta.onlineId) return;
    var doc;
    try {
      doc = await T.get(
        '/v1/online/lyric?source=' + encodeURIComponent(meta.source)
        + '&id=' + encodeURIComponent(meta.onlineId)
      );
    } catch (e) {
      doc = null;
    }
    if ((!isCurrent || isCurrent()) && H.state.current && H.state.current.id === meta.id && window.Stage) {
      // 与本地歌词同一出口：全局偏移 / 逐行过滤 / 片头策略在这里统一生效。
      var staged = window.HertzLyrics ? window.HertzLyrics.stageDoc(doc) : doc;
      window.Stage.setLyrics(staged && staged.lines && staged.lines.length ? staged : null);
    }
  }

  // 刷新后 onlineMeta 是空的：用 id 反解音源/曲目号拉详情补封面。
  async function fetchOnlineCover(track) {
    try {
      var d = await T.get(
        '/v1/online/detail?source=' + encodeURIComponent(track.source)
        + '&id=' + encodeURIComponent(track.onlineId)
      );
      var url = safeCoverUrl(d && d.cover);
      if (url && track.id) {
        var meta = onlineMeta.get(track.id) || track;
        meta.cover = url;
        rememberMeta(track.id, meta);
        if (H.state.byId.get(track.id)) H.state.byId.set(track.id, meta);
      }
      return url;
    } catch (e) {
      return null; // 详情拿不到只是没有封面，不该中断「正在播放」的渲染
    }
  }

  async function loadOnlineLyricDoc(track) {
    try {
      return await T.get(
        '/v1/online/lyric?source=' + encodeURIComponent(track.source)
        + '&id=' + encodeURIComponent(track.onlineId)
      );
    } catch (e) {
      return null; // 没有歌词是常态
    }
  }

  // 在线曲目走同一套「正在播放」渲染，只是没有本地技术信息。
  function paintNowPlaying(track, coverUrl) {
    if (!track) return;
    H.ui.nowTitle.textContent = track.title || '未知曲目';
    H.ui.nowArtist.textContent = [track.artist, track.album].filter(Boolean).join(' · ');
    H.ui.barTitle.textContent = track.title || '未知曲目';
    H.ui.barSub.textContent = [track.artist, track.album].filter(Boolean).join(' · ');
    var isOnline = Boolean(track.source && track.onlineId);
    H.ui.nowTech.textContent = isOnline ? '在线试听' : '';
    H.ui.nowTech.hidden = !isOnline;
  }

  // ---- 最近播放（服务端 play_history，个人区区块）----
  function relTime(ms) {
    var d = new Date(ms);
    var today = new Date();
    var sameDay = d.toDateString() === today.toDateString();
    if (sameDay) {
      return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    }
    var yesterday = new Date(today.getTime() - 86400000);
    if (d.toDateString() === yesterday.toDateString()) return '昨天';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  // 历史读取状态：来源筛选 + 游标分页（服务端按 played_at 倒序给 total）。
  var historyState = { source: '', offset: 0, total: 0, loading: false };

  async function loadHistory() {
    var host = $('op-history');
    if (!host) return;
    var list = $('op-history-list');
    if (!list) return;
    historyState.offset = 0;
    historyState.total = 0;
    var more = $('op-history-more');
    if (more) more.hidden = true;
    var sourceSel = $('op-history-source');
    if (sourceSel && !sourceSel.dataset.bound) {
      sourceSel.dataset.bound = '1';
      sourceSel.onchange = function () {
        historyState.source = sourceSel.value;
        loadHistory();
      };
    }
    // 清空按钮每次渲染重新绑定（元素与区块同在，这里绑一定拿得到）。
    var clearBtn = $('op-history-clear');
    if (clearBtn) {
      clearBtn.onclick = async function () {
        try {
          await T.del('/v1/history');
          loadHistory();
        } catch (e) {
          H.toast('清空失败', 'error');
        }
      };
    }
    var data;
    try {
      var src = historyState.source ? '&source=' + encodeURIComponent(historyState.source) : '';
      data = await T.get('/v1/history?limit=20&offset=' + historyState.offset + src);
    } catch (e) {
      host.hidden = true;
      return;
    }
    var items = (data && data.items) || [];
    historyState.total = (data && data.total) || 0;
    host.hidden = (historyState.offset === 0 && items.length === 0);
    list.textContent = '';
    items.forEach(function (it) {
      var row = document.createElement('div');
      row.className = 'op-history-item';

      var cover = document.createElement('div');
      cover.className = 'op-h-cover';
      if (it.cover_url) {
        applyBg(cover, safeCoverUrl(it.cover_url));
      } else {
        cover.textContent = '♪';
      }

      var main = document.createElement('div');
      main.className = 'op-h-main';
      var title = document.createElement('div');
      title.className = 'op-h-title';
      title.textContent = it.title || it.ref_id;
      var sub = document.createElement('div');
      sub.className = 'op-h-sub';
      sub.textContent = [it.artist, it.album].filter(Boolean).join(' · ') || '未知艺术家';
      main.append(title, sub);

      // 最近播放的来源同样用平台 app 图标，不摆文字标签。
      var src = badge(it.source === 'local' ? 'local' : it.source);
      src.classList.add('op-h-src');

      var time = document.createElement('span');
      time.className = 'op-h-time';
      time.textContent = relTime(it.played_at);

      var del = document.createElement('button');
      del.className = 'op-h-del';
      del.type = 'button';
      del.title = '移除';
      del.textContent = '×';
      del.onclick = async function (e) {
        e.stopPropagation();
        try {
          await T.del('/v1/history/' + it.id);
          loadHistory();
        } catch (err) {
          H.toast('移除失败', 'error');
        }
      };

      row.append(cover, main, src, time, del);
      row.addEventListener('click', function () {
        replayHistory(it);
      });
      list.appendChild(row);
    });

    // 游标分页：还有更早的就显示「加载更早」，追加而不是重绘。
    historyState.offset += items.length;
    if (more) {
      var hasMore = historyState.offset < historyState.total;
      more.hidden = !hasMore;
      more.onclick = function () { loadMoreHistory(); };
    }
  }

  async function loadMoreHistory() {
    var list = $('op-history-list');
    var more = $('op-history-more');
    if (!list || historyState.loading) return;
    historyState.loading = true;
    if (more) { more.disabled = true; more.textContent = '正在读取…'; }
    try {
      var src = historyState.source ? '&source=' + encodeURIComponent(historyState.source) : '';
      var data = await T.get('/v1/history?limit=20&offset=' + historyState.offset + src);
      var items = (data && data.items) || [];
      items.forEach(function (it) {
        var row = historyRow(it);
        list.appendChild(row);
      });
      historyState.offset += items.length;
      if (more) {
        more.hidden = historyState.offset >= historyState.total;
        more.textContent = '加载更早';
      }
    } catch (e) {
      H.toast('读取更早的播放记录失败', 'error');
    } finally {
      historyState.loading = false;
      if (more) more.disabled = false;
    }
  }

  // 单条历史行（首次渲染与「加载更早」共用同一套构造）。
  function historyRow(it) {
    var row = document.createElement('div');
    row.className = 'op-history-item';

    var cover = document.createElement('div');
    cover.className = 'op-h-cover';
    if (it.cover_url) {
      applyBg(cover, safeCoverUrl(it.cover_url));
    } else {
      cover.textContent = '♪';
    }

    var main = document.createElement('div');
    main.className = 'op-h-main';
    var title = document.createElement('div');
    title.className = 'op-h-title';
    title.textContent = it.title || it.ref_id;
    var sub = document.createElement('div');
    sub.className = 'op-h-sub';
    sub.textContent = [it.artist, it.album].filter(Boolean).join(' · ') || '未知艺术家';
    main.append(title, sub);

    var src = badge(it.source === 'local' ? 'local' : it.source);
    src.classList.add('op-h-src');

    var time = document.createElement('span');
    time.className = 'op-h-time';
    time.textContent = relTime(it.played_at);

    var del = document.createElement('button');
    del.className = 'op-h-del';
    del.type = 'button';
    del.title = '移除';
    del.textContent = '×';
    del.onclick = async function (e) {
      e.stopPropagation();
      try {
        await T.del('/v1/history/' + it.id);
        loadHistory();
      } catch (err) {
        H.toast('移除失败', 'error');
      }
    };

    row.append(cover, main, src, time, del);
    row.addEventListener('click', function () {
      replayHistory(it);
    });
    return row;
  }

  // 点击历史行：在线曲按单元素 track 重新入队（playable:true 走整盘试听链路，
  // 服务端实时取流，不存在 URL 过期问题）；本地曲走 /v1/player/load 起播
  // （已核实 PUT /queue 只换队列不起播）。
  function replayHistory(it) {
    if (it.source === 'local') {
      T.post('/v1/player/load', { track_id: it.track_id, queue: [it.track_id] })
        .then(function () { H.toast('播放《' + it.title + '》'); })
        .catch(function (err) { H.toast(H.errText('播放失败', err), 'error'); });
      return;
    }
    var track = {
      source: it.source,
      id: it.ref_id,
      title: it.title,
      artist: it.artist || '',
      album: it.album || '',
      duration_ms: it.duration_ms || 0,
      cover: it.cover_url || '',
      playable: true,
    };
    playAll([track], 0);
  }

  var radioEpoch = 0;
  var radioBusy = false;
  function renderRadio(data) {
    if (!$('radio-status')) return;
    $('radio-start').hidden = !!data.active;
    $('radio-next').hidden = !data.active;
    $('radio-stop').hidden = !data.active;
    $('radio-retry').hidden = !data.error;
    $('radio-start').disabled = radioBusy || !!data.loading;
    $('radio-next').disabled = radioBusy || !!data.loading || !(data.tracks || []).length;
    $('radio-retry').disabled = radioBusy || !!data.loading;
    $('radio-status').textContent = data.error || (data.loading ? '正在加载推荐…' :
      data.active ? 'FM 已开启 · 自动补充推荐。退出后保留当前队列。' : '可尝试游客收听；推荐和播放范围由音源决定。');
    var tracks = data.tracks || [];
    var current = tracks[data.index || 0];
    $('radio-track').hidden = !current || !data.active;
    $('radio-track').textContent = current ? [current.title, current.artist].filter(Boolean).join(' · ') : '';
    if (data.active && tracks.length) {
      tracks.forEach(function (t) {
        var id = virtualId(t);
        var meta = Object.assign({}, t, { id: id, onlineId: t.id, cover: safeCoverUrl(t.cover) });
        rememberMeta(id, meta);
        H.state.byId.set(id, meta);
      });
      H.setStateQueue(tracks.map(virtualId), current ? virtualId(current) : null);
    }
  }
  async function refreshRadio() {
    if (radioBusy || document.hidden) return;
    var epoch = radioEpoch;
    var intent = T.playbackIntent ? T.playbackIntent() : null;
    try {
      var data = await T.get('/v1/online/radio');
      if (epoch === radioEpoch && (intent === null || intent === T.playbackIntent())) renderRadio(data);
    } catch (_) { /* Keep the last state while the daemon is unavailable. */ }
  }
  async function radioAction(action) {
    if (radioBusy && action !== 'stop') return;
    var epoch = ++radioEpoch;
    radioBusy = true;
    $('radio-status').textContent = action === 'stop' ? '正在退出 FM…' : '正在加载推荐…';
    ['start', 'next', 'retry'].forEach(function (name) { $('radio-' + name).disabled = true; });
    // Exit remains available while a slow request is in flight.
    $('radio-stop').hidden = false;
    try {
      var promise = T.post('/v1/online/radio', { action: action });
      var intent = T.playbackIntent ? T.playbackIntent() : null;
      var data = await promise;
      if (epoch !== radioEpoch || (intent !== null && intent !== T.playbackIntent())) return;
      radioBusy = false;
      renderRadio(data);
    } catch (e) {
      if (epoch === radioEpoch) {
        $('radio-status').textContent = H.errText('FM 加载失败', e);
        $('radio-retry').hidden = false;
      }
    } finally {
      if (epoch === radioEpoch) {
        radioBusy = false;
        ['start', 'next', 'retry'].forEach(function (name) { $('radio-' + name).disabled = false; });
      }
    }
  }
  function initOnline() {
    if ($('radio-start')) {
      ['start', 'next', 'retry', 'stop'].forEach(function (action) {
        $('radio-' + action).onclick = function () { radioAction(action); };
      });
      refreshRadio();
      setInterval(refreshRadio, 5000);
    }
    if (H.ui.onlineGo) {
      H.ui.onlineGo.onclick = function () {
        onlineState.q = H.ui.onlineQ.value || '';
        search();
      };
    }
    if (H.ui.onlineQ) {
      H.ui.onlineQ.oninput = function () {
        if (H.ui.onlineQ.value.trim() === onlineState.q.trim()) return;
        cancelSearch();
        onlineState.q = H.ui.onlineQ.value || '';
        onlineState.tracks = [];
        renderOnline();
      };
      H.ui.onlineQ.onkeydown = function (e) {
        if (e.key === 'Enter') {
          onlineState.q = H.ui.onlineQ.value || '';
          search();
        }
      };
    }
    if (H.ui.onlineSource) {
      H.ui.onlineSource.onchange = function () {
        cancelSearch();
        onlineState.source = H.ui.onlineSource.value;
        // 按新音源重建档位选项（All 无档位描述，选择器自动隐藏）。
        renderQualityOptions();
        // All 是音源维度的聚合项：没有分类，也不自动拉取（需要关键词）。
        if (onlineState.source === 'all') {
          renderSourceCaps();
          if (onlineState.q.trim()) { search(); return; }
          onlineState.tracks = [];
          onlineState.total = 0;
          onlineState.aggregate = true;
          renderOnline();
          H.ui.onlineBody.innerHTML = '<div class="hint">输入关键词，跨所有音源聚合搜索。</div>';
          return;
        }
        // 按新音源重建分类条：QQ/酷狗/ccmixter 没有 cats，chips 整排隐藏、
        // cat 清空。不重建就会带着上一源（如网易云 hot）的 cat 去请求，
        // 上游必回 400，表现为「切到 QQ 一首都没有」。
        renderSourceCaps();
        if (onlineState.q.trim()) search();
        else if (onlineState.cat) search();
        else {
          // 仅支持关键词检索的音源：不发必失败的空请求，回到引导提示。
          onlineState.tracks = [];
          onlineState.total = 0;
          onlineState.aggregate = false;
          renderOnline();
          H.ui.onlineBody.innerHTML = '<div class="hint">该音源仅支持关键词检索，输入歌名、歌手或专辑试试。</div>';
        }
      };
    }
    // chips 按音源动态生成，监听挂容器上（换源后是一批新按钮）。
    if (H.ui.onlineChips) {
      H.ui.onlineChips.onclick = function (e) {
        var chip = e.target.closest('.chip');
        if (!chip) return;
        H.ui.onlineChips.querySelectorAll('.chip').forEach(function (c) {
          c.classList.remove('active');
        });
        chip.classList.add('active');
        onlineState.cat = chip.dataset.cat;
        onlineState.q = '';
        if (H.ui.onlineQ) H.ui.onlineQ.value = '';
        searchOnline();
      };
    }
    // 音质档位：保存偏好；若正在播该音源的在线曲，按当前队列下标重新取流，
    // 服务端接续进度热切换（queueIds 由 app.js 暴露，Task 14 前可能不存在）。
    var qSel = $('online-quality');
    if (qSel) {
      qSel.onchange = async function () {
        var src = onlineState.source;
        var q = qSel.value;
        try {
          await T.post('/v1/online/quality', { source: src, quality: q });
          qualityMap[src] = q;
          // 正在播该音源在线曲 → 服务端热切换（按当前队列下标重新取流，接续进度）。
          var snap = H.state.snapshot || {};
          if (snap.track_id && snap.track_id.indexOf('online:' + src + ':') === 0) {
            var ids = (H.state.queueIds || []);
            var idx = ids.indexOf(snap.track_id);
            if (idx >= 0) {
              H.ui.playpause.classList.add('is-loading');
              try {
                await T.post('/v1/player/replay', { index: idx });
                var opt = qSel.options ? qSel.options[qSel.selectedIndex] : null;
                H.toast('已切换到' + (opt ? opt.textContent : qualityLabel(q)));
              } finally {
                H.ui.playpause.classList.remove('is-loading');
              }
            }
          }
        } catch (err) {
          H.toast(H.errText('音质切换失败', err), 'error');
          renderQualityOptions();
        }
      };
    }
    renderOnline();
    loadSources();
    loadHistory();
  }

  // ---- 音质档位（GET /v1/online/quality 描述各音源可选档位与当前选择）----
  var qualityMap = {}; // source -> "standard"/...
  var QUALITY_LABELS = { standard: '标准', exhigh: '高品 320k', lossless: '无损', hires: 'Hi-Res' };

  function qualityLabel(q) { return QUALITY_LABELS[q] || q; }

  async function loadQualityPrefs() {
    var data = await T.get('/v1/online/quality').catch(function () { return null; });
    var prefs = (data && data.prefs) || [];
    // 原始描述挂到 window：renderQualityOptions 的选项表（value/label）来自它。
    window.__qualityDesc = prefs;
    qualityMap = {};
    prefs.forEach(function (p) { qualityMap[p.source] = p.selected; });
    renderQualityOptions();
  }

  function renderQualityOptions() {
    var sel = $('online-quality');
    if (!sel) return;
    var src = onlineState.source;
    var data = null;
    // 选项表来自 /v1/online/quality 的描述（缓存在 window.__qualityDesc）。
    (window.__qualityDesc || []).forEach(function (p) {
      if (p.source === src) data = p;
    });
    // All 聚合或后端没给描述的音源：没有档位概念，整枚选择器隐藏。
    if (!data) { sel.hidden = true; return; }
    sel.hidden = false;
    var keep = qualityMap[src] || data.selected;
    sel.textContent = '';
    (data.options || []).forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    });
    sel.value = keep;
  }

  // 手动点播失败 / WS 上报在线音源错误时由 app.js（Task 14）调用：
  // 在面板顶部显示错误条，可重试当前下标或跳到下一首。
  function showOnlineError(message, retryIndex) {
    var bar = $('online-errorbar');
    if (!bar) { H.toast(message, 'error'); return; }
    $('online-error-text').textContent = message;
    bar.hidden = false;
    bar.dataset.index = retryIndex == null ? '' : String(retryIndex);
    // 终态错误（自动接力连 3 停、后端没给下标）没有可重试的具体曲目：
    // 藏掉重试按钮，避免点了毫无反应；有下标时才放出来。
    var retryBtn = $('online-error-retry');
    if (retryBtn) {
      retryBtn.hidden = retryIndex == null || retryIndex === '';
    }
    $('online-error-retry').onclick = function () {
      bar.hidden = true;
      var idx = Number(bar.dataset.index);
      if (bar.dataset.index !== '' && !Number.isNaN(idx)) {
        T.post('/v1/player/replay', { index: idx }).catch(function () {});
      }
    };
    $('online-error-next').onclick = function () {
      bar.hidden = true;
      T.post('/v1/player/next', {}).catch(function (e) { H.toast(H.errText('下一首失败', e), 'error'); });
    };
    $('online-error-close').onclick = function () { bar.hidden = true; };
  }
  function hideOnlineError() {
    var bar = $('online-errorbar');
    if (bar) bar.hidden = true;
  }

  // 音源清单由服务端给出（/v1/online/sources）。写死 HTML 会漏掉分类和能力位。
  async function loadSources() {
    searchCache.clear();
    searchViews.clear();
    if (searchSession) { cancelSearch(); onlineState.tracks = []; renderOnline(); }
    var data = await T.get('/v1/online/sources').catch(function () { return null; });
    onlineState.sources = (data && data.sources) || [];
    refreshCookieUi();
    // 档位描述与音源清单同源拉取；失败自吞（选择器保持隐藏），不影响音源加载。
    loadQualityPrefs();
    // 一个都没拿到时下拉框保持 index.html 里的静态选项。
    if (!onlineState.sources.length) return;
    if (H.ui.onlineSource) {
      var keep = H.ui.onlineSource.value;
      var opts = [];
      // 两个及以上音源时提供 All 聚合项，放在最前；默认仍选中第一个真实音源。
      if (onlineState.sources.length >= 2) {
        var all = document.createElement('option');
        all.value = 'all';
        all.textContent = 'All';
        opts.push(all);
      }
      onlineState.sources.forEach(function (s) {
        var opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.label;
        opts.push(opt);
      });
      H.ui.onlineSource.replaceChildren.apply(H.ui.onlineSource, opts);
      var hasKeep = onlineState.sources.some(function (s) { return s.id === keep; })
        || keep === 'all';
      H.ui.onlineSource.value = hasKeep ? keep : onlineState.sources[0].id;
      onlineState.source = H.ui.onlineSource.value;
    }
    renderSourceCaps();
  }

  // 当前音源的分类 chips。All 或无分类音源整排隐藏。
  function renderSourceCaps() {
    if (!H.ui.onlineChips) return;
    if (onlineState.source === 'all') {
      onlineState.cat = '';
      H.ui.onlineChips.hidden = true;
      H.ui.onlineChips.replaceChildren();
      return;
    }
    var info = onlineState.sources.find(function (s) { return s.id === onlineState.source; });
    var cats = (info && info.cats) || [];
    onlineState.cat = cats.length ? cats[0].id : '';
    H.ui.onlineChips.hidden = cats.length === 0;
    H.ui.onlineChips.replaceChildren.apply(H.ui.onlineChips, cats.map(function (c, i) {
      var btn = document.createElement('button');
      btn.className = 'chip' + (i === 0 ? ' active' : '');
      btn.type = 'button';
      btn.dataset.cat = c.id;
      btn.textContent = c.label;
      return btn;
    }));
  }

  // 音源登录：每个 supportsCookie 的音源生成一行（设置页用）。扫码登录的入口
  // 由 Task 19 的账号区接 OnlineLogin.start(source)。
  function refreshCookieUi() {
    var host = H.ui.cookieRows;
    if (!host) return;
    var sources = onlineState.sources.filter(function (s) { return s.supportsCookie; });
    if (!sources.length) {
      host.innerHTML = '<div class="hint">'
        + (onlineState.sources.length ? '当前音源都不需要登录。' : '还没能读到音源清单。')
        + '</div>';
      return;
    }
    host.replaceChildren.apply(host, sources.map(function (s) {
      var row = document.createElement('div');
      row.className = 'set-row cookie-row';

      var label = document.createElement('label');
      label.textContent = s.label;
      label.htmlFor = 'cookie-' + s.id;

      var input = document.createElement('input');
      input.id = 'cookie-' + s.id;
      input.type = 'password';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.placeholder = s.signedIn ? '已保存；留空并保存即退出' : '粘贴你自己账号的 cookie';

      var btn = document.createElement('button');
      btn.className = 'btn';
      btn.type = 'button';
      btn.textContent = '保存';
      btn.onclick = async function () {
        var value = input.value.trim();
        btn.disabled = true;
        try {
          var res = await T.post('/v1/online/cookie', { source: s.id, cookie: value });
          H.toast(res && res.signedIn ? s.label + '：已保存登录凭据' : s.label + '：已清除登录凭据',
            'info');
          input.value = '';
          await loadSources();
        } catch (err) {
          H.toast(H.errText('保存登录凭据失败', err), 'error');
        } finally {
          btn.disabled = false;
        }
      };

      var badgeEl = document.createElement('span');
      badgeEl.className = 'hint';
      badgeEl.textContent = s.signedIn ? '已登录' : '未登录';

      row.append(label, input, btn, badgeEl);
      return row;
    }));
  }

  window.Online = {
    // 宿主接线（app.js 启动时调用一次）。
    bind: function (host) { H = host; T = window.VMusicTransport; },
    init: initOnline,
    // setView 首次进入在线页时按默认分类拉一屏；当前音源只支持关键词
    // 检索（QQ/酷狗）且搜索框为空时不预取——那条请求后端必回 400。
    onViewEnter: function () {
      // 历史与搜索预取互不依赖：每次切回在线视图都刷新，播完一曲再回来
      // 新记录能置顶（下面的早退只针对搜索预取）。
      loadHistory();
      if (onlineState.loading) return;
      if (onlineState.tracks.length) return;
      if (!onlineState.q.trim() && !onlineState.cat) return;
      search({ silent: true });
    },
    search: search,
    playAll: playAll,
    // 行工厂：歌单抽屉复用同一套标记/VIP/置灰，activate 由调用方注入。
    row: buildRow,
    loadSources: loadSources,
    refreshCookieUi: refreshCookieUi,
    reloadHistory: loadHistory,
    sources: function () { return onlineState.sources; },
    state: onlineState,
    // —— 供宿主「正在播放」/队列渲染回落到在线元数据 ——
    meta: onlineMeta,
    getMeta: function (id) { return onlineMeta.get(id); },
    remember: rememberMeta,
    seedFromStore: seedMetaFromStore,
    safeCoverUrl: safeCoverUrl,
    rowCoverUrl: rowCoverUrl,
    fetchCover: fetchOnlineCover,
    loadLyricDoc: loadOnlineLyricDoc,
    loadLyrics: loadOnlineLyrics,
    paintNowPlaying: paintNowPlaying,
    sourceLabel: sourceLabel,
    sourceBadge: sourceBadge,
    sourceIcon: sourceIcon,
    // 区分位图徽标（平台 PNG，路径以 / 开头）与 sprite 字形（i- 开头）。
    isImgIcon: isImgIcon,
    // 徽标节点工厂：歌单菜单/收藏/两层界面都来这里取，避免各处再拼一遍。
    badge: badge,
    // 在线播放错误条（app.js Task 14 的 WS error 分支调用）。
    showOnlineError: showOnlineError,
    hideOnlineError: hideOnlineError,
  };
})();
