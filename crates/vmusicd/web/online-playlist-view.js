// SPDX-License-Identifier: MIT
//
// 在线歌单的两层界面：网格层（歌单卡片）→ 详情层（信息面板 + 曲目表）。
//
// 结构参照 folia-major 的「集合网格 → 曲目详情」，实现全部走当前项目的原生
// 方式：
//   · 层级切换只有 `H.setLayer()` 一个出口，由 app.js 收口四层显隐，这里不
//     自己写 hidden，也不引一套导航栈（深度只有两层）。
//   · 曲目行走 `Online.row()`，与在线搜索结果同一套 VIP 置灰 / 收藏 / 试听。
//   · 分页用 `/v1/online/playlist` 现成的 offset+limit，尾哨兵 + 「加载更多」
//     按钮双保险，与曲库的哨兵分页同一套写法。
//   · 数据只有 OnlinePlaylists 那一份，这里不复制缓存。
//
// 三条必须如实的地方：
//   1. 加载失败 ≠ 空歌单。两者渲染成不同内容，绝不让鉴权/网络故障看起来像
//      「这个歌单是空的」。
//   2. 错误存判别式而不是成品文案：`state.error = { kind, message }`，渲染时
//      才翻成中文。后端目前没有「非公开歌单」语义（Capability 里也没有订阅
//      类能力），所以只有 generic 一支会真的出现；等后端补了错误码，这里加
//      一个 kind 分支即可，渲染层不用改。
//   3. 加入队列用的是前端构造的虚拟 id `online:{source}:{id}`（后端
//      virtual_id 是纯函数，set_queue 也不校验 id）。它不必先起播一次，代价
//      是不带平台专有 ref，播放时后端按稳定 id 回落取流 —— QQ media_mid、
//      酷狗 album_id 这类字段缺失时音质可能不是最优。这是这条路径的已知
//      代价，不是 bug。
(function () {
  'use strict';

  var PAGE = 50;
  var H = null; // app.js 注入的宿主（setLayer / caps / enqueue / toast）

  var state = {
    // 网格层
    items: [],        // OnlinePlaylists.all() 的扁平清单
    sourceFilter: '', // 从某个音源分组进入时只显示该音源
    query: '',
    // 详情层
    from: 'arrange',  // 进入详情前的层，返回时回到那里
    source: null,
    playlist: null,
    tracks: [],
    total: 0,
    offset: 0,
    phase: 'idle',    // idle | loading | ready | error
    error: null,      // { kind: 'generic' | 'not-public', message }
    loadingMore: false,
    trackQuery: '',
  };

  function el(id) { return document.getElementById(id); }
  function tr() { return window.VMusicTransport; }
  function toast(msg, kind) {
    if (H && H.toast) H.toast(msg, kind);
    else if (window.toast) window.toast(msg, kind);
  }
  function errText(prefix, err) {
    if (H && H.errText) return H.errText(prefix, err);
    return prefix + '：' + (err && err.message ? err.message : '网络错误');
  }
  function setLayer(name) { if (H && H.setLayer) H.setLayer(name); }
  function capsOf(src) { return (H && H.caps) ? (H.caps(src) || []) : []; }
  function hasCap(src, cap) { return capsOf(src).indexOf(cap) >= 0; }

  // ── 网格层 ───────────────────────────────────────────────────────────────

  function refreshItems() {
    state.items = (window.OnlinePlaylists && window.OnlinePlaylists.all)
      ? window.OnlinePlaylists.all() : [];
  }

  function openGrid(source) {
    refreshItems();
    state.sourceFilter = source || '';
    state.query = '';
    var q = el('opl-grid-q');
    if (q) q.value = '';
    ensureVisible();
    setLayer('online-grid');
    renderGrid();
  }

  function gridItems() {
    var q = state.query.trim().toLowerCase();
    return state.items.filter(function (it) {
      if (state.sourceFilter && it.source !== state.sourceFilter) return false;
      if (!q) return true;
      return String(it.playlist.name || '').toLowerCase().indexOf(q) >= 0;
    });
  }

  function renderGrid() {
    var box = el('opl-grid-list');
    var empty = el('opl-grid-empty');
    var count = el('opl-grid-count');
    if (!box) return;
    box.innerHTML = '';
    var items = gridItems();
    if (count) count.textContent = items.length ? ' · ' + items.length + ' 个' : '';
    if (!items.length) {
      if (empty) {
        empty.hidden = false;
        empty.textContent = state.items.length
          ? '没有匹配的在线歌单。'
          : '还没有在线歌单。到「在线」面板登录后会自动同步过来。';
      }
      return;
    }
    if (empty) empty.hidden = true;
    items.forEach(function (it) { box.appendChild(playlistCard(it)); });
  }

  // 卡片沿用在线面板网格的 .op-card 一套类名，两个网格因此永远长一样。
  function playlistCard(it) {
    var p = it.playlist;
    var c = document.createElement('div');
    c.className = 'op-card opl-card' + (p.kind === 'liked' ? ' is-liked' : '');
    c.setAttribute('role', 'button');
    c.tabIndex = 0;

    var cover = document.createElement('div');
    cover.className = 'op-cover';
    var url = window.Online ? window.Online.safeCoverUrl(p.cover) : null;
    if (url) cover.style.backgroundImage = 'url("' + url + '")';
    else cover.classList.add('is-missing');
    c.appendChild(cover);

    var name = document.createElement('div');
    name.className = 'op-pl-name';
    name.textContent = (p.kind === 'liked' ? '♥ ' : '') + p.name;
    c.appendChild(name);

    var sub = document.createElement('div');
    sub.className = 'op-pl-sub';
    sub.textContent = it.sourceLabel + ' · ' + p.track_count + ' 首'
      + (p.play_count ? ' · 播放 ' + p.play_count : '');
    c.appendChild(sub);

    if (window.Favorites) {
      c.appendChild(heartButton(it));
    }

    function open() { openDetail(it.source, p, 'grid'); }
    c.onclick = open;
    c.onkeydown = function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    };
    return c;
  }

  // 整盘收藏（kind=radio）：与在线面板卡片、歌单视图在线行的红心同源。
  function heartButton(it) {
    var p = it.playlist;
    var b = document.createElement('button');
    b.className = 'op-fav';
    b.type = 'button';
    var on = window.Favorites.has('radio', it.source, p.id);
    b.classList.toggle('is-on', on);
    b.innerHTML = window.Favorites.heartSvg(on);
    b.title = on ? '取消收藏这个歌单' : '收藏这个歌单';
    b.setAttribute('aria-label', b.title);
    b.onclick = function (e) {
      e.stopPropagation();
      window.Favorites.toggle({
        kind: 'radio', source: it.source, ref_id: p.id,
        title: p.name, cover: p.cover,
      }, function (final) {
        b.classList.toggle('is-on', final);
        b.innerHTML = window.Favorites.heartSvg(final);
        b.title = final ? '取消收藏这个歌单' : '收藏这个歌单';
      });
    };
    return b;
  }

  // ── 详情层 ───────────────────────────────────────────────────────────────

  function openDetail(source, p, from) {
    state.from = from || 'arrange';
    state.source = source;
    state.playlist = p;
    state.tracks = [];
    state.total = 0;
    state.offset = 0;
    state.phase = 'loading';
    state.error = null;
    state.loadingMore = false;
    state.trackQuery = '';
    var q = el('opl-detail-q');
    if (q) q.value = '';
    ensureVisible();
    setLayer('online-detail');
    renderInfo();
    renderTracks();
    loadPage(0);
  }

  // 两层界面挂在歌单视图里。从在线面板的歌单卡片进来时当前视图还是「在线」，
  // 不先切过去的话层是开了但整个视图 hidden —— 表现就是点了没反应。
  function ensureVisible() {
    if (H && H.ensureVisible) H.ensureVisible();
  }

  // 歌单视图的在线行 / 左侧菜单点进来时手上只有一个 id，先回 OnlinePlaylists
  // 那份清单里找；找不到就如实说，不静默失败。
  function openById(source, id, from) {
    refreshItems();
    var hit = state.items.filter(function (it) {
      return it.source === source && String(it.playlist.id) === String(id);
    })[0];
    if (!hit) {
      toast('在线歌单信息已过期，请回「在线」面板刷新', 'error');
      return;
    }
    openDetail(source, hit.playlist, from);
  }

  async function loadPage(offset) {
    var p = state.playlist;
    if (!p) return;
    if (offset === 0) {
      state.phase = 'loading';
      renderTracks();
    } else {
      state.loadingMore = true;
      paintTail();
    }
    var d;
    try {
      d = await tr().get('/v1/online/playlist?source=' + encodeURIComponent(state.source)
        + '&id=' + encodeURIComponent(p.id) + '&limit=' + PAGE + '&offset=' + offset);
    } catch (e) {
      state.loadingMore = false;
      state.phase = 'error';
      // 判别式而非成品文案：后端补了 not-public 语义后，这里加一个 kind 即可。
      state.error = {
        kind: (e && e.code === 'not_public') ? 'not-public' : 'generic',
        message: (e && e.message) ? e.message : '网络错误',
      };
      renderTracks();
      return;
    }
    var tracks = (d.tracks || []).map(function (t) {
      if (!t.source) t.source = state.source;
      return t;
    });
    state.tracks = offset === 0 ? tracks : state.tracks.concat(tracks);
    state.total = d.total || state.tracks.length;
    state.offset = state.tracks.length;
    state.phase = 'ready';
    state.loadingMore = false;
    renderInfo();
    renderTracks();
  }

  function hasMore() {
    return state.phase === 'ready' && state.tracks.length < state.total;
  }

  function loadMore() {
    if (state.loadingMore || !hasMore()) return;
    loadPage(state.offset);
  }

  function visibleTracks() {
    var q = state.trackQuery.trim().toLowerCase();
    if (!q) return state.tracks;
    return state.tracks.filter(function (t) {
      return String(t.title || '').toLowerCase().indexOf(q) >= 0
        || String(t.artist || '').toLowerCase().indexOf(q) >= 0
        || String(t.album || '').toLowerCase().indexOf(q) >= 0;
    });
  }

  // 信息面板：封面 + 标题 + 音源徽标 + 曲目数/播放数/创建者 + 操作按钮。
  // 与参考实现的 cut-in 面板同构，只是不做浮层（歌单视图层内即可）。
  function renderInfo() {
    var p = state.playlist;
    if (!p) return;
    var title = el('opl-detail-title');
    if (title) title.textContent = p.name;

    var box = el('opl-info');
    if (!box) return;
    box.innerHTML = '';

    var cover = document.createElement('div');
    cover.className = 'opl-cover';
    var url = window.Online ? window.Online.safeCoverUrl(p.cover) : null;
    if (url) cover.style.backgroundImage = 'url("' + url + '")';
    else cover.classList.add('is-missing');
    box.appendChild(cover);

    var head = document.createElement('div');
    head.className = 'opl-info-title';
    var name = document.createElement('strong');
    name.textContent = p.name;
    head.appendChild(name);
    var badge = document.createElement('span');
    badge.className = 'src-badge opl-badge';
    var b = window.Online && window.Online.sourceBadge
      ? window.Online.sourceBadge(state.source) : null;
    badge.textContent = b ? b.text : capSourceLabel();
    if (b && b.color) badge.style.setProperty('--badge', b.color);
    head.appendChild(badge);
    box.appendChild(head);

    var meta = document.createElement('div');
    meta.className = 'opl-info-meta';
    var bits = [state.total ? state.total + ' 首' : p.track_count + ' 首'];
    if (p.play_count) bits.push('播放 ' + p.play_count);
    if (p.creator) bits.push('by ' + p.creator);
    meta.textContent = bits.join(' · ');
    box.appendChild(meta);

    var acts = document.createElement('div');
    acts.className = 'opl-info-acts';
    var view = visibleTracks();
    acts.appendChild(actionButton(playLabel(view), 'primary', function () {
      if (!view.length) return;
      window.Online.playAll(view, 0);
    }));
    acts.appendChild(actionButton(queueLabel(view), '', function () {
      if (!view.length) return;
      enqueue(view);
    }));
    box.appendChild(acts);
  }

  function capSourceLabel() {
    var hit = state.items.filter(function (it) { return it.source === state.source; })[0];
    return hit ? hit.sourceLabel : state.source;
  }

  // 参考实现的语义：筛选生效时按钮说清「播放 N 首 / 加入 N 首」，
  // 否则说「播放全部 / 加入队列」。
  function playLabel(view) {
    return state.trackQuery.trim() ? '播放 ' + view.length + ' 首' : '播放全部';
  }
  function queueLabel(view) {
    return state.trackQuery.trim() ? '加入 ' + view.length + ' 首到队列' : '加入队列';
  }

  function actionButton(text, kind, onclick) {
    var b = document.createElement('button');
    b.className = 'btn' + (kind ? ' ' + kind : '');
    b.type = 'button';
    b.textContent = text;
    b.onclick = onclick;
    return b;
  }

  async function enqueue(tracks) {
    if (!H || !H.enqueue) { toast('当前版本不支持加入队列', 'error'); return; }
    var n = await H.enqueue(tracks);
    toast('已把 ' + n + ' 首加入队列');
  }

  function renderTracks() {
    var box = el('opl-rows');
    if (!box) return;
    box.innerHTML = '';

    if (state.phase === 'loading') {
      box.innerHTML = '<div class="hint">正在加载歌单…</div>';
      paintTail();
      return;
    }
    if (state.phase === 'error') {
      box.appendChild(errorNode());
      paintTail();
      return;
    }

    var view = visibleTracks();
    if (!view.length) {
      var hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = state.trackQuery.trim()
        ? '已加载的曲目里没有匹配项。'
        : '这个歌单是空的。';
      box.appendChild(hint);
      paintTail();
      return;
    }

    var canWrite = hasCap(state.source, 'playlist_write');
    view.forEach(function (t, i) {
      var row = window.Online.row(t, function () {
        if (t.vip_only) { toast('该曲目为 VIP 专享'); return; }
        if (!t.playable) return;
        window.Online.playAll(view, i);
      });
      if (canWrite && window.OnlinePlaylists && window.OnlinePlaylists.removeButton) {
        var actions = row.querySelector('.t-actions');
        if (actions) {
          actions.appendChild(window.OnlinePlaylists.removeButton(
            state.source, state.playlist, t, function () { loadPage(0); }
          ));
        }
      }
      box.appendChild(row);
    });
    paintTail();
  }

  function errorNode() {
    var wrap = document.createElement('div');
    wrap.className = 'opl-error';
    var hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = state.error.kind === 'not-public'
      ? '这个歌单不是公开歌单，当前音源接口读不到它的内容。'
      : errText('歌单加载失败', { message: state.error.message })
        + '。登录可能已过期，请回「在线」面板重新登录。';
    wrap.appendChild(hint);
    var retry = actionButton('重试', '', function () { loadPage(0); });
    wrap.appendChild(retry);
    return wrap;
  }

  // 列表尾部：加载中 / 加载更多按钮 / 尾哨兵（滚动到底自动翻页）。
  function paintTail() {
    var more = el('opl-more');
    var sentinel = el('opl-sentinel');
    if (!more || !sentinel) return;
    if (state.phase === 'loading') {
      more.hidden = true;
      sentinel.hidden = false;
      sentinel.textContent = '加载中…';
      return;
    }
    var more_left = hasMore();
    more.hidden = !more_left;
    more.disabled = state.loadingMore;
    if (more_left) {
      more.textContent = '加载更多（还有 ' + (state.total - state.tracks.length) + ' 首）';
    }
    sentinel.hidden = !more_left;
    sentinel.textContent = state.loadingMore ? '加载中…' : '';
  }

  // ── 接线 ─────────────────────────────────────────────────────────────────

  function back() {
    setLayer(state.from === 'grid' ? 'online-grid' : 'arrange');
    if (state.from === 'grid') renderGrid();
  }

  function bindStatic() {
    var gb = el('opl-grid-back');
    if (gb) gb.onclick = function () { setLayer('arrange'); };
    var db = el('opl-detail-back');
    if (db) db.onclick = back;
    var more = el('opl-more');
    if (more) more.onclick = loadMore;

    var gq = el('opl-grid-q');
    if (gq) gq.oninput = function () { state.query = gq.value || ''; renderGrid(); };
    var dq = el('opl-detail-q');
    if (dq) dq.oninput = function () {
      state.trackQuery = dq.value || '';
      renderInfo();
      renderTracks();
    };

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var grid = el('opl-grid');
      var detail = el('opl-detail');
      if (detail && !detail.hidden) back();
      else if (grid && !grid.hidden) setLayer('arrange');
    });

    // 尾哨兵：滚到底自动翻页。没有 IntersectionObserver（老浏览器 / 测试
    // 沙箱）时按钮仍然可用，功能不缺失。
    var sentinel = el('opl-sentinel');
    if (sentinel && typeof IntersectionObserver === 'function') {
      new IntersectionObserver(function (entries) {
        if (entries[0] && entries[0].isIntersecting) loadMore();
      }).observe(sentinel);
    }
  }

  window.OnlinePlaylistView = {
    bind: function (host) { H = host; },
    init: bindStatic,
    openGrid: openGrid,
    open: openById,
    close: back,
    state: state,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bindStatic(); });
  } else {
    bindStatic();
  }
})();
