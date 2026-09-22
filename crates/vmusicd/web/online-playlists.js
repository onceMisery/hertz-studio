// SPDX-License-Identifier: MIT
//
// 在线「我的账号 / 我的歌单」：
//   账号卡（扫码 / cookie 登录、退出）→ 登录后拉用户歌单 → 网格卡片 →
//   右侧详情抽屉（整盘播放 / 随机 / 移除曲目）。
//
// 事实表只有一张：/v1/online/sources 的 caps。没有任何登录能力
// （cookie_login/qr_login/user_playlists）的音源（如 ccmixter）不出现账号卡；
// 没有 qr_login 只给 cookie 入口；没有 playlist_write 不给移除按钮。
// 任何接口失败都如实提示，绝不把失败渲染成空成功。
//
// 传输层 VMusicTransport 由后加载的 app.js 挂到 window，需要时现取，不能在
// IIFE 顶层缓存（那时它还是 undefined）。
(function () {
  'use strict';

  var state = {
    sources: [],          // 只保留有任一登录能力（cookie/qr/歌单）的音源
    capsById: {},         // source -> caps 数组
    accounts: {},         // source -> AccountInfo
    lists: {},            // source -> OnlinePlaylist[]
    detailSource: null,
    detailPlaylist: null,
    detailTracks: [],
    detailTotal: 0,
    detailLoading: false,
  };

  function el(id) { return document.getElementById(id); }
  function tr() { return window.VMusicTransport; }
  function hasCap(src, cap) {
    return (state.capsById[src] || []).indexOf(cap) >= 0;
  }
  function sourceLabel(id) {
    var s = state.sources.filter(function (x) { return x.id === id; })[0];
    return s ? s.label : id;
  }

  // ── 音源清单与账号区 ─────────────────────────────────────────────────────

  async function loadSources() {
    var data;
    try {
      data = await tr().get('/v1/online/sources');
    } catch (e) {
      // 清单都拿不到：账号区给一句实话，不伪造「暂不支持」卡片。
      el('op-accounts').innerHTML =
        '<div class="hint">音源清单加载失败，稍后重试。</div>';
      return;
    }
    state.sources = (data.sources || []).filter(function (s) {
      var caps = s.caps || [];
      // 任一登录/账号能力即显示账号卡：酷狗当前只有扫码+cookie，没有歌单能力，
      // 但仍要让用户能登录（登录后才能取流会员曲目）。
      return caps.indexOf('cookie_login') >= 0
        || caps.indexOf('qr_login') >= 0
        || caps.indexOf('user_playlists') >= 0;
    });
    state.capsById = {};
    state.sources.forEach(function (s) { state.capsById[s.id] = s.caps || []; });
    renderAccounts();
    // 已登录过的音源刷新页面后要自动把昵称/歌单找回来：各源独立拉，
    // 单个源失败不影响别的源（Promise.all 会被一个 401 带崩，所以不用）。
    state.sources.forEach(function (s) { refreshAccount(s.id); });
  }

  function renderAccounts() {
    var box = el('op-accounts');
    box.innerHTML = '';
    state.sources.forEach(function (s) {
      var card = document.createElement('div');
      card.className = 'op-account';
      card.dataset.source = s.id;

      var name = document.createElement('span');
      name.className = 'op-name';
      name.textContent = s.label;
      card.appendChild(name);

      // 扫码登录按 qr_login 能力位显示；没有这个位（如 QQ）只剩 cookie 入口，
      // 点开的是同一个弹窗——弹窗里有 cookie 兜底折叠区。
      if (s.caps.indexOf('qr_login') >= 0) {
        var qr = document.createElement('button');
        qr.className = 'btn op-login';
        qr.type = 'button';
        qr.textContent = '扫码登录';
        qr.onclick = function () { window.OnlineLogin.start(s.id); };
        card.appendChild(qr);
      }
      var cookie = document.createElement('button');
      cookie.className = 'btn op-cookie';
      cookie.type = 'button';
      cookie.textContent = 'cookie 登录';
      cookie.onclick = function () { window.OnlineLogin.start(s.id); };
      card.appendChild(cookie);

      box.appendChild(card);
    });
  }

  // 拉账号信息 + 歌单。未登录（401/403/上游错误）时静默保留登录按钮——
  // 这是常态而不是错误，不该弹 toast 吓人；歌单网格相应留空。
  async function refreshAccount(sourceId) {
    var acc = null;
    try {
      acc = await tr().get('/v1/online/account?source=' + encodeURIComponent(sourceId));
    } catch (e) {
      delete state.accounts[sourceId];
      delete state.lists[sourceId];
      renderGrid();
      return;
    }
    state.accounts[sourceId] = acc;
    paintLoggedIn(sourceId, acc);
    // 没有歌单能力（如酷狗当前阶段）就不发必失败的歌单请求，只保留登录态展示。
    if (!hasCap(sourceId, 'user_playlists')) {
      renderGrid();
      return;
    }
    try {
      var lists = await tr().get('/v1/online/playlists?source=' + encodeURIComponent(sourceId)
        + '&scope=created&limit=30&offset=0');
      state.lists[sourceId] = lists || [];
      renderGrid();
    } catch (e) {
      delete state.lists[sourceId];
      renderGrid();
    }
  }

  function paintLoggedIn(src, acc) {
    var card = document.querySelector('.op-account[data-source="' + src + '"]');
    if (!card) return;
    card.classList.add('is-in');
    card.innerHTML = '';

    var avatar = document.createElement('div');
    avatar.className = 'op-avatar';
    var url = acc.avatar && window.Online
      ? window.Online.safeCoverUrl(acc.avatar) : null;
    if (url) {
      var img = document.createElement('img');
      img.src = url;
      img.alt = '';
      avatar.appendChild(img);
    } else {
      avatar.classList.add('is-missing');
      avatar.textContent = (acc.nickname || src).slice(0, 1).toUpperCase();
    }
    card.appendChild(avatar);

    var meta = document.createElement('div');
    meta.className = 'op-meta';
    var nick = document.createElement('div');
    nick.className = 'op-nick';
    nick.textContent = acc.nickname || sourceLabel(src);
    meta.appendChild(nick);
    if (acc.vip_label) {
      var vip = document.createElement('div');
      vip.className = 'op-vip';
      vip.textContent = acc.vip_label;
      meta.appendChild(vip);
    }
    card.appendChild(meta);

    var logout = document.createElement('button');
    logout.className = 'btn op-logout';
    logout.type = 'button';
    logout.textContent = '退出';
    logout.onclick = function () { logoutOf(src); };
    card.appendChild(logout);
  }

  async function logoutOf(src) {
    // 后端约定空 cookie 即清除并回读判定；signedIn=false 是正常结果不是错误。
    try {
      await tr().post('/v1/online/cookie', { source: src, cookie: '' });
    } catch (e) {
      window.toast('退出登录失败：' + (e && e.message ? e.message : '网络错误'), 'error');
      return;
    }
    delete state.accounts[src];
    delete state.lists[src];
    renderAccounts();
    renderGrid();
    // 重绘的是未登录卡，顺手再探一次账号态确认真的退干净了。
    refreshAccount(src);
  }

  // ── 歌单网格 ─────────────────────────────────────────────────────────────

  function renderGrid() {
    var grid = el('op-grid');
    var head = el('op-grid-head');
    grid.innerHTML = '';
    var any = false;
    Object.keys(state.lists).forEach(function (src) {
      (state.lists[src] || []).forEach(function (p) {
        any = true;
        grid.appendChild(playlistCard(src, p));
      });
    });
    head.hidden = !any;
    // 左侧歌单菜单与网格同源，任何重绘都同步通知。
    notifyChanged();
  }

  function playlistCard(src, p) {
    var c = document.createElement('div');
    c.className = 'op-card' + (p.kind === 'liked' ? ' is-liked' : '');
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
    sub.textContent = sourceLabel(src) + ' · ' + p.track_count + ' 首'
      + (p.play_count ? ' · 播放 ' + p.play_count : '');
    c.appendChild(sub);

    // 收藏电台/歌单：整盘作为一个收藏对象（kind=radio），点开可整体载入。
    if (window.Favorites) {
      var fav = document.createElement('button');
      fav.className = 'op-fav';
      fav.type = 'button';
      var on = window.Favorites.has('radio', src, p.id);
      fav.classList.toggle('is-on', on);
      fav.innerHTML = window.Favorites.heartSvg(on);
      fav.title = on ? '取消收藏这个电台' : '收藏这个电台';
      fav.setAttribute('aria-label', fav.title);
      fav.onclick = function (e) {
        e.stopPropagation();
        window.Favorites.toggle({
          kind: 'radio', source: src, ref_id: p.id,
          title: p.name, cover: p.cover,
        }, function (final) {
          fav.classList.toggle('is-on', final);
          fav.innerHTML = window.Favorites.heartSvg(final);
          fav.title = final ? '取消收藏这个电台' : '收藏这个电台';
        });
      };
      c.appendChild(fav);
    }

    function open() { openDetail(src, p); }
    c.onclick = open;
    c.onkeydown = function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    };
    return c;
  }

  // ── 详情抽屉 ─────────────────────────────────────────────────────────────

  function setDrawerOpen(open) {
    el('op-drawer').hidden = !open;
    el('op-drawer-scrim').hidden = !open;
  }

  function isDrawerOpen() {
    return !el('op-drawer').hidden;
  }

  function closeDrawer() {
    state.detailSource = null;
    state.detailPlaylist = null;
    state.detailTracks = [];
    state.detailTotal = 0;
    setDrawerOpen(false);
  }

  async function openDetail(src, p) {
    if (state.detailLoading) return;
    state.detailLoading = true;
    state.detailSource = src;
    state.detailPlaylist = p;
    state.detailTracks = [];
    el('op-title').textContent = p.name;
    var box = el('op-tracks');
    box.innerHTML = '<div class="hint">正在加载歌单…</div>';
    setDrawerOpen(true);

    var d;
    try {
      d = await tr().get('/v1/online/playlist?source=' + encodeURIComponent(src)
        + '&id=' + encodeURIComponent(p.id) + '&limit=50&offset=0');
    } catch (e) {
      box.innerHTML = '';
      var hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = '歌单加载失败：' + (e && e.message ? e.message : '网络错误')
        + '。登录可能已过期，请回账号区重新登录。';
      box.appendChild(hint);
      state.detailLoading = false;
      return;
    }
    state.detailLoading = false;

    var tracks = (d.tracks || []).map(function (t) {
      // 平台层一般已带 source；缺失时用当前歌单音源补上。
      if (!t.source) t.source = src;
      return t;
    });
    state.detailTracks = tracks;
    state.detailTotal = d.total || tracks.length;
    renderDetail();
  }

  function renderDetail() {
    var src = state.detailSource;
    var p = state.detailPlaylist;
    var tracks = state.detailTracks;
    var canWrite = hasCap(src, 'playlist_write');
    var box = el('op-tracks');
    box.innerHTML = '';

    var count = document.createElement('div');
    count.className = 'op-detail-count hint';
    count.textContent = '共 ' + state.detailTotal + ' 首'
      + (state.detailTotal > tracks.length ? '，当前加载前 ' + tracks.length + ' 首' : '');
    box.appendChild(count);

    if (!tracks.length) {
      var empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = '歌单是空的。';
      box.appendChild(empty);
    }

    tracks.forEach(function (t, i) {
      var row = window.Online.row(t, function () {
        // 与搜索页同一道闸门：VIP 不偷播、无试听地址不反应。
        if (t.vip_only) { window.toast('该曲目为 VIP 专享'); return; }
        if (!t.playable) return;
        window.Online.playAll(tracks, i);
      });
      if (canWrite) {
        var actions = row.querySelector('.t-actions');
        // 移除按钮由本模块统一产出并导出：在线歌单详情层复用同一个，
        // 两处的行为（入参、400 处理、刷新口径）才不会各自漂移。
        if (actions) actions.appendChild(removeButton(src, p, t, null));
      }
      box.appendChild(row);
    });

    el('op-playall').onclick = function () {
      if (!tracks.length) return;
      window.Online.playAll(tracks, 0);
    };
    el('op-shuffle').onclick = function () {
      if (!tracks.length) return;
      var shuffled = tracks.slice();
      for (var i = shuffled.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
      }
      window.Online.playAll(shuffled, 0);
    };
  }

  // src 显式传入而不是读 state.detailSource：详情层（online-playlist-view.js）
  // 也用这颗按钮，那里的当前音源不在本模块的 state 里。
  // after 为空时走本模块默认的「重拉抽屉详情」；详情层传自己的重拉函数。
  function removeButton(src, p, t, after) {
    var b = document.createElement('button');
    b.className = 't-act op-remove';
    b.type = 'button';
    b.title = '从该歌单移除';
    b.textContent = '移除';
    b.onclick = async function (e) {
      e.stopPropagation();
      if (b.disabled) return;
      b.disabled = true;
      try {
        // 入参是平台稳定 id + 不透明 ref（{id, ref}）；载荷缺失时后端仅用
        // id 尝试，需要专有字段而缺失会明确 400——不静默丢项。
        await tr().post('/v1/online/playlist/tracks/remove', {
          source: src,
          id: p.id,
          tracks: [{ id: t.id, ref: t.ref || {} }],
        });
      } catch (err) {
        b.disabled = false;
        window.toast('移除失败：' + (err && err.message ? err.message : '网络错误'), 'error');
        return;
      }
      window.toast('已从《' + p.name + '》移除');
      // 重新拉详情，让总数和行序与平台保持一致。
      if (after) after();
      else openDetail(src, p);
    };
    return b;
  }

  // ── 接线与导出 ───────────────────────────────────────────────────────────

  function bindStatic() {
    el('op-back').onclick = closeDrawer;
    el('op-drawer-scrim').onclick = closeDrawer;
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isDrawerOpen()) closeDrawer();
    });
  }

  // 左侧歌单菜单等外部消费者通过这个事件与在线面板保持同步：数据只在
  // state.lists 一份，谁也不复制缓存。
  function notifyChanged() {
    document.dispatchEvent(new CustomEvent('online-playlists:changed'));
  }

  // 扫码/cookie 登录成功后由 online-login.js 回调：整区重建，把新登录的
  // 账号昵称和歌单拉回来。
  function refresh() {
    state.accounts = {};
    state.lists = {};
    notifyChanged();
    loadSources();
  }

  // 扁平的在线歌单清单（供左侧歌单菜单渲染）：附带音源 id/名称/徽标色/
  // 徽标短名，顺序按 sources 清单与平台返回顺序，与在线面板网格完全一致。
  function allPlaylists() {
    var out = [];
    state.sources.forEach(function (s) {
      (state.lists[s.id] || []).forEach(function (p) {
        out.push({
          source: s.id,
          sourceLabel: s.label,
          badgeColor: sourceBadge(s.id),
          badgeText: sourceBadgeText(s.id, s.label),
          playlist: p,
        });
      });
    });
    return out;
  }

  // 平台徽标色与短名的事实源在 online.js 的 SOURCE_BADGE，这里只去取用，
  // 不再各存一份表——两张表一旦漂移，同一个音源会在搜索结果和歌单菜单里
  // 显示成两种颜色/两个名字。本模块本来就依赖 window.Online（行渲染、播放、
  // 封面归一都走它），所以直接问它；它没加载时才回落到 label/主题色。
  function badgeOf(id) {
    return window.Online && window.Online.sourceBadge
      ? window.Online.sourceBadge(id)
      : null;
  }

  function sourceBadge(id) {
    var b = badgeOf(id);
    return b ? b.color : null;
  }

  // 徽标里塞两字短名而不是完整源名；未知音源回退到源清单 label。
  function sourceBadgeText(id, label) {
    var b = badgeOf(id);
    return b ? b.text : label;
  }

  // 左侧菜单按 source+id 打开抽屉。
  function openPlaylistById(source, id) {
    var p = (state.lists[source] || []).filter(function (x) { return x.id === id; })[0];
    if (p) return openDetail(source, p);
    window.toast('在线歌单信息已过期，请回在线面板刷新', 'error');
  }

  // 左侧菜单的「播放」按钮：拉详情后从第一首整盘播放，与抽屉「播放全部」
  // 走同一条闸门（VIP 灰显、不可播不反应在 Online.playAll 内部处理）。
  async function playPlaylistById(source, id) {
    var p = (state.lists[source] || []).filter(function (x) { return x.id === id; })[0];
    if (!p) {
      window.toast('在线歌单信息已过期，请回在线面板刷新', 'error');
      return;
    }
    var d;
    try {
      d = await tr().get('/v1/online/playlist?source=' + encodeURIComponent(source)
        + '&id=' + encodeURIComponent(id) + '&limit=50&offset=0');
    } catch (e) {
      window.toast('读取在线歌单失败：' + (e && e.message ? e.message : '网络错误'), 'error');
      return;
    }
    var tracks = d.tracks || [];
    if (!tracks.length) {
      window.toast('这个歌单是空的', 'error');
      return;
    }
    tracks.forEach(function (t) { if (!t.source) t.source = source; });
    window.Online.playAll(tracks, 0);
  }

  window.OnlinePlaylists = {
    refresh: refresh,
    init: loadSources,
    all: allPlaylists,
    open: openPlaylistById,
    play: playPlaylistById,
    closeDrawer: closeDrawer,
    // 详情层（online-playlist-view.js）复用同一颗移除按钮。
    removeButton: removeButton,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bindStatic(); loadSources(); });
  } else {
    bindStatic();
    loadSources();
  }
})();
