// SPDX-License-Identifier: MIT
//
// 顶栏搜索框 = 全局搜索入口。默认搜**在线**歌曲，可切歌单 / 歌手 / 专辑；
// 「本地」档保留旧的本地曲库筛选行为（输入即过滤曲库列表）。
//
// 为什么是下拉面板：顶栏只有一行的高度，五档类型塞不进去；而预览结果
// （歌能直接播、歌单/歌手/专辑能直接进详情）让这个框成为真正的全局搜索，
// 而不是「回车才见结果」的跳转器。面板是 position:fixed 的自由浮层，坐标
// 由 JS 按输入框的实际位置算 —— 五套皮肤各自给 .topsearch 换了圆角/底色/
// 摆位（清风把它挪到顶栏右侧、流年换底色），锚在布局流里要么被皮肤裁掉
// 要么贴错边，只有 JS 定位对所有皮肤一视同仁。
//
// 与「在线」页共用同一份状态：kind 就是 onlineState.kind（切档互相同步），
// 关键词只在「查看全部 / 回车」时才写回 onlineState.q —— 顶栏敲字只刷预览，
// 不打扰在线页已经打开的结果。
//
// app.js 保留 #search 输入框的**本地**行为（state.q → loadTracks）；非本地
// 档时它的 oninput 转发到这里（onInput），两条路径不会同时生效。
(function () {
  'use strict';
  /// 背景图位封面：插件形态下远程地址要经 sidecar 换成 data URL（沙箱 CSP 画不
  /// 出 https 图）。HertzCovers 由 app.js 挂出；契约检查的沙箱只加载本模块，
  /// 拿不到时回落成直接赋值，即独立形态的同款行为。
  function applyBg(el, url) {
    if (window.HertzCovers) { window.HertzCovers.applyBg(el, url); return; }
    if (el) el.style.backgroundImage = url ? 'url("' + url + '")' : '';
  }

  // 宿主：{ setView, jumpToOnline(q, kind), toast, errText }。jumpToOnline
  // 由 app.js 实现——它持有 setView 与 onlineQ 输入框，跳转语义（写回
  // onlineState.q / setKind / 显式 search）与流年面板的 view-online 分支同源。
  var H = null;

  var input = null;
  var clearBtn = null;
  var menu = null;
  var kindHost = null;
  var body = null;      // 预览结果滚动区
  var moreBtn = null;   // 「在「在线」页查看全部」脚注

  var KINDS = [
    { id: 'song', label: '歌曲' },
    { id: 'playlist', label: '歌单' },
    { id: 'artist', label: '歌手' },
    { id: 'album', label: '专辑' },
    { id: 'local', label: '本地' },
  ];

  // 非单曲类型的音源能力位（与 online.js 的 KIND_CAPS 同一张表；这里只需要
  // 「能不能搜」，进详情的门槛由卡片自判）。
  var KIND_CAPS = {
    song: null,
    playlist: 'playlist_search',
    artist: 'artist_search',
    album: 'album_search',
  };

  var PLACEHOLDERS = {
    song: '搜索在线歌曲，回车看全部',
    playlist: '搜索在线歌单，回车看全部',
    artist: '搜索歌手，回车看全部',
    album: '搜索在线专辑，回车看全部',
    local: '在本地曲库中搜索标题、艺术家、专辑',
  };

  var state = {
    kind: 'song',
    open: false,
    epoch: 0,
    timer: 0,
    q: '',
    // 预览里的歌列表：点行播歌时按这套顺序整盘入队。
    previewTracks: [],
  };

  function transport() { return window.VMusicTransport; }
  function toast(msg, kind_) {
    if (H && H.toast) H.toast(msg, kind_);
    else if (window.toast) window.toast(msg, kind_);
  }
  function errText(prefix, err) {
    if (H && H.errText) return H.errText(prefix, err);
    return prefix + '：' + (err && err.message ? err.message : '网络错误');
  }

  function online() { return window.Online || null; }

  // 当前生效的在线 kind：本地档恒可用；在线档要看当前音源的能力位——
  // 在线页换源后 kind 可能被 renderKind 拉回单曲，这里跟着读那份事实。
  function effectiveKind() {
    if (state.kind === 'local') return 'local';
    var o = online();
    if (!o) return 'local';
    var kind = o.state.kind || 'song';
    if (kindAllowed(kind, o.state.source)) return kind;
    return 'song';
  }

  function kindAllowed(kind, source) {
    var cap = KIND_CAPS[kind];
    if (!cap) return true;
    if (!source || source === 'all') return false;
    return sourceHasCap(source, cap);
  }

  function sourceHasCap(source, cap) {
    var info = (online() ? online().sources() : []).filter(function (s) { return s.id === source; })[0];
    return !!(info && (info.caps || []).indexOf(cap) >= 0);
  }

  function labelOf(kind) {
    for (var i = 0; i < KINDS.length; i += 1) if (KINDS[i].id === kind) return KINDS[i].label;
    return '歌曲';
  }

  // ── 面板骨架 ─────────────────────────────────────────────────────────────

  function build() {
    if (!input) return;
    // 面板挂 body 而不是 .topsearch：多套皮肤的顶栏带 backdrop-filter（会
    // 把 fixed 后代的包含块改成顶栏本身）、overflow 裁剪与各自的层叠上下文，
    // 挂在搜索框里任何一条都能让浮层错位/被裁。挂 body 后坐标永远是视口
    // 坐标，代价只是 outside 点击判定要多认一个 .ts-menu。
    menu = document.createElement('div');
    menu.className = 'ts-menu';
    menu.hidden = true;

    kindHost = document.createElement('div');
    kindHost.className = 'ts-kind';
    kindHost.setAttribute('role', 'group');
    kindHost.setAttribute('aria-label', '搜索范围');
    menu.appendChild(kindHost);

    body = document.createElement('div');
    body.className = 'ts-body';
    menu.appendChild(body);

    moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'ts-more';
    moreBtn.hidden = true;
    moreBtn.addEventListener('click', function () {
      var q = state.q;
      var kind = effectiveKind();
      close();
      if (H && H.jumpToOnline) H.jumpToOnline(q, kind === 'local' ? 'song' : kind);
    });
    menu.appendChild(moreBtn);

    document.body.appendChild(menu);
    renderChips();
  }

  function renderChips() {
    if (!kindHost) return;
    kindHost.textContent = '';
    var active = effectiveKind();
    KINDS.forEach(function (k) {
      var allowed = k.id === 'local' || kindAllowed(k.id, online() ? online().state.source : null);
      if (!allowed) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip ts-chip' + (k.id === active ? ' active' : '');
      b.dataset.kind = k.id;
      b.textContent = k.label;
      b.setAttribute('aria-pressed', k.id === active ? 'true' : 'false');
      b.addEventListener('click', function () { setKind(k.id); });
      kindHost.appendChild(b);
    });
  }

  function syncPlaceholder() {
    if (!input) return;
    var kind = effectiveKind();
    input.placeholder = PLACEHOLDERS[kind] || PLACEHOLDERS.song;
    input.setAttribute('aria-label', kind === 'local' ? '搜索本地曲库' : '搜索在线曲库');
  }

  // ── 开合与定位 ───────────────────────────────────────────────────────────

  function place() {
    if (!menu) return;
    var r = input.getBoundingClientRect();
    var w = Math.min(Math.max(Math.round(r.width), 380), 480);
    var left = Math.round(r.left);
    var maxLeft = window.innerWidth - w - 12;
    if (left > maxLeft) left = Math.max(12, maxLeft);
    menu.style.left = left + 'px';
    menu.style.top = Math.round(r.bottom + 8) + 'px';
    menu.style.width = w + 'px';
  }

  function open() {
    if (!menu || state.open) return;
    state.open = true;
    renderChips();
    syncPlaceholder();
    menu.hidden = false;
    place();
    renderEmptyState();
    if (state.q) runPreview(state.q);
  }

  function close() {
    if (!menu || !state.open) return;
    state.open = false;
    menu.hidden = true;
  }

  function renderEmptyState() {
    body.textContent = '';
    state.previewTracks = [];
    moreBtn.hidden = true;
    var hint = document.createElement('div');
    hint.className = 'ts-hint';
    hint.textContent = effectiveKind() === 'local'
      ? '本地档：输入即筛选曲库列表。'
      : '输入关键词搜索' + labelOf(effectiveKind()) + '，回车进「在线」页看全部。';
    body.appendChild(hint);
  }

  // ── 预览取数与渲染 ───────────────────────────────────────────────────────

  function onInput() {
    if (!input) return; // bind() 之前不会走到这（app.js 启动序列先 bind）
    var q = input.value.trim();
    if (q === state.q) return;
    state.q = q;
    clearTimeout(state.timer);
    if (!q) {
      if (state.open) renderEmptyState();
      return;
    }
    if (!state.open) open();
    state.timer = setTimeout(function () { runPreview(q); }, 300);
  }

  // 歌单/歌手/专辑预览的卡片。复用 .playlist-card 一族类名——与在线页的
  // 结果网格同一套皮肤。
  function previewCard(item, kind) {
    var card = document.createElement('div');
    card.className = 'playlist-card ts-card';
    var cover = document.createElement('div');
    cover.className = 'playlist-card-cover';
    var url = window.Online ? window.Online.safeCoverUrl(item.cover) : item.cover;
    if (url) applyBg(cover, url);
    else cover.classList.add('is-empty');
    var main = document.createElement('div');
    main.className = 'playlist-card-main';
    var title = document.createElement('div');
    title.className = 'playlist-card-title';
    title.textContent = item.name || '';
    var sub = document.createElement('div');
    sub.className = 'playlist-card-sub';
    var bits = [];
    if (kind === 'album' && item.artist) bits.push(item.artist);
    if (kind === 'artist' && item.alias) bits.push(item.alias);
    var n = kind === 'artist' ? item.song_count : item.track_count;
    if (n != null) bits.push(n + (kind === 'artist' ? ' 首歌曲' : ' 首'));
    if (kind === 'playlist' && item.play_count != null) bits.push('播放 ' + item.play_count);
    sub.textContent = bits.join(' · ') || '—';
    main.appendChild(title);
    main.appendChild(sub);
    card.appendChild(cover);
    card.appendChild(main);
    return card;
  }

  function renderPreview(kind, q, data) {
    body.textContent = '';
    state.previewTracks = [];
    var count = document.createElement('div');
    count.className = 'ts-hint';
    body.appendChild(count);

    if (kind === 'song') {
      var tracks = (data && data.tracks) || [];
      state.previewTracks = tracks;
      count.textContent = tracks.length
        ? '来自' + (online() ? online().sourceLabel(data.source) : data.source) + ' · 回车看全部'
        : '没有匹配的歌曲。';
      if (!tracks.length) return;
      tracks.forEach(function (t, i) {
        var row = window.Online.row(t, function () {
          if (!t.playable) return;
          window.Online.playAll(state.previewTracks, i);
          close();
        });
        row.classList.add('ts-row');
        body.appendChild(row);
      });
      return;
    }

    var lists = kind === 'playlist' ? ((data && data.playlists) || [])
      : kind === 'artist' ? ((data && data.artists) || [])
        : ((data && data.albums) || []);
    count.textContent = lists.length ? '回车看全部' : '没有匹配的' + labelOf(kind) + '。';
    if (!lists.length) return;
    var grid = document.createElement('div');
    grid.className = 'ts-cards';
    lists.forEach(function (item) {
      var card = previewCard(item, kind);
      // 歌单卡片要能进详情才算真的可点：咪咕等只有搜索、没有歌单详情端点
      // 的音源保持只读卡片（与在线页同口径）。
      var canOpen = kind !== 'playlist' || sourceHasCap(item.source, 'playlist_detail');
      if (canOpen && window.OnlinePlaylistView) {
        card.classList.add('is-openable');
        card.setAttribute('role', 'button');
        card.tabIndex = 0;
        function openCard() {
          window.OnlinePlaylistView.openCollection({
            kind: kind,
            source: item.source,
            id: item.id,
            name: item.name,
            cover: item.cover,
            track_count: kind === 'artist' ? item.song_count : item.track_count,
            play_count: item.play_count,
          });
          close();
        }
        card.addEventListener('click', openCard);
        card.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard(); }
        });
      }
      grid.appendChild(card);
    });
    body.appendChild(grid);
  }

  async function runPreview(q) {
    var kind = effectiveKind();
    if (kind === 'local' || !q) return;
    var epoch = state.epoch;
    var o = online();
    if (!o || !transport()) return;
    // 聚合档（all）没有单端点可打：预览落回第一个可用音源（通常网易云），
    // 「回车看全部」仍会进入在线页做真正的跨源聚合。
    var source = o.state.source;
    if (source === 'all') {
      var first = (o.sources() || [])[0];
      source = first ? first.id : 'netease';
    }
    var endpoint = kind === 'song' ? '/v1/online/search'
      : kind === 'playlist' ? '/v1/online/playlists/search'
        : kind === 'artist' ? '/v1/online/artists/search'
          : '/v1/online/albums/search';
    var params = new URLSearchParams({
      source: source,
      q: q,
      limit: kind === 'song' ? '8' : '6',
    });
    body.textContent = '';
    var loading = document.createElement('div');
    loading.className = 'ts-hint';
    loading.textContent = '搜索中…';
    body.appendChild(loading);
    try {
      var data = await transport().get(endpoint + '?' + params.toString());
      if (epoch !== state.epoch || q !== state.q) return;
      renderPreview(kind, q, data);
      moreBtn.hidden = false;
      moreBtn.textContent = '在「在线」页查看全部「' + q + '」→';
    } catch (err) {
      if (epoch !== state.epoch) return;
      body.textContent = '';
      var hint = document.createElement('div');
      hint.className = 'ts-hint';
      hint.textContent = errText('搜索失败', err);
      body.appendChild(hint);
    }
  }

  // ── 档位切换 ─────────────────────────────────────────────────────────────

  function setKind(kind) {
    if (KINDS.every(function (k) { return k.id !== kind; })) return;
    if (kind === state.kind) return;
    state.kind = kind;
    state.epoch += 1; // 作废在途预览
    clearTimeout(state.timer);
    syncPlaceholder();
    renderChips();
    if (kind === 'local') {
      close();
      input.focus();
      // 框里已有的词立刻生效为本地筛选（app.js 的 oninput 不会因程序化
      // 改值而触发，这里手动补一发）。
      if (input.value.trim()) notifyLocalFilter();
      return;
    }
    // 在线档：与在线页同步同一份 kind（renderKind 会把没有能力位的档拉回
    // 单曲，这里读回真实落点）。
    var o = online();
    if (o && o.setKind) {
      o.setKind(kind);
      state.kind = o.state.kind;
    }
    renderChips();
    if (!state.open) open();
    else if (state.q) runPreview(state.q);
    else renderEmptyState();
  }

  function notifyLocalFilter() {
    // 本地筛选的落地在 app.js（state.q → loadTracks → setView('library')），
    // 这里只负责把输入框的值交回去：程序化同步不触发 input 事件。
    if (H && H.applyLocalFilter) H.applyLocalFilter(input.value);
  }

  // ── 接线 ─────────────────────────────────────────────────────────────────

  function onDocumentPointerDown(e) {
    if (!state.open) return;
    // 面板自己（已挂 body）与搜索框内的点击都算「在内」。
    if (e.target.closest && (e.target.closest('.topsearch') || e.target.closest('.ts-menu'))) return;
    close();
  }

  function onDocumentKeyDown(e) {
    if (e.key !== 'Escape' || !state.open) return;
    close();
  }

  function onReflow(e) {
    if (!state.open) return;
    // 面板自己内部的滚动（预览列表超长）不该把面板关掉。
    if (e && e.target && e.target.nodeType === 1 && menu.contains(e.target)) return;
    close();
  }

  function bind(host) {
    H = host;
    input = document.getElementById('search');
    clearBtn = document.getElementById('search-clear');
    if (!input) return;
    build();
    input.addEventListener('focus', function () {
      if (effectiveKind() !== 'local') open();
    });
    // 焦点已在输入框时再点不会重发 focus（回车跳转后、点外面收起后都是
    // 这样），click 兜底把面板重新拉开。
    input.addEventListener('click', function () {
      if (!state.open && effectiveKind() !== 'local' && document.activeElement === input) open();
    });
    input.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      if (effectiveKind() === 'local') return; // 本地行为归 app.js
      e.preventDefault();
      var q = input.value.trim();
      state.q = q;
      clearTimeout(state.timer);
      var kind = effectiveKind();
      close();
      if (H && H.jumpToOnline) H.jumpToOnline(q, kind);
    });
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        state.q = '';
        state.epoch += 1;
        clearTimeout(state.timer);
        if (state.open) renderEmptyState();
      });
    }
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.addEventListener('keydown', onDocumentKeyDown);
    // 固定定位的面板不跟着布局走：页面滚动/窗口变形时直接收起，最省心。
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
  }

  window.TopSearch = {
    bind: bind,
    // app.js 的 oninput 在非本地档转发进来；本地档它自己处理。
    onInput: onInput,
    kind: effectiveKind,
    setKind: setKind,
    open: open,
    close: close,
    isOpen: function () { return state.open; },
    state: state,
  };
})();
