// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 收藏（我的收藏）。
//
// 两类收藏对象共用一张表、一个视图：
//   - track：一首歌。本地曲目或某个在线音源的曲目。
//   - radio：电台 / 在线歌单这类可整体播放的节目。
//
// app.js 启动时先 bind() 注入宿主依赖（transport/ui/state/渲染工具），
// 再 init()。行工厂与「已收藏集合」的查询也对外暴露，供曲库行与在线结果行
// 挂同一颗红心。
(function () {
  'use strict';
  var T = null; // VMusicTransport，bind() 时取
  var H = null; // 宿主：{ ui, state, setStateQueue, paintArt, fmt, toast, errText, playOnline }

  var favState = {
    kind: 'track',      // track | radio，当前 tab
    items: [],
    total: 0,
    counts: { track: 0, radio: 0 },
    loading: false,
    offset: 0,
    generation: 0,
    playingAll: false,
    // 已收藏的身份集合，键是 `identity(kind, source, refId)`。
    // 曲库一屏 200 行，靠它做 O(1) 判红，不必每行回服务端问一次。
    owned: new Set(),
    // 判红的音源维度：本地曲库行是 local，在线行是各音源 id。
    membershipSource: 'local',
  };

  function identity(kind, source, refId) {
    return kind + ':' + source + ':' + refId;
  }

  function has(kind, source, refId) {
    return favState.owned.has(identity(kind, source, refId));
  }

  // ---------------------------------------------------------------------------
  // 读写
  // ---------------------------------------------------------------------------

  function pageUrl(kind, offset) {
    return '/v1/favorites?kind=' + encodeURIComponent(kind) + '&limit=200&offset=' + offset;
  }

  function load() {
    // 刷新与切 tab 都开启新一轮读取，旧请求即使晚到也不能改写当前列表。
    favState.generation += 1;
    favState.items = [];
    favState.offset = 0;
    favState.total = 0;
    return loadPage(false);
  }

  function loadMore() {
    if (favState.loading || favState.offset >= favState.total) return;
    return loadPage(true);
  }

  async function loadPage(append) {
    var kind = favState.kind;
    var generation = favState.generation;
    var offset = append ? favState.offset : 0;
    function current() {
      return generation === favState.generation && kind === favState.kind;
    }
    favState.loading = true;
    render();
    try {
      var page = await T.get(pageUrl(kind, offset));
      if (!current()) return;
      var items = page.favorites || [];
      favState.items = append ? favState.items.concat(items) : items;
      // 仅成功后推进 offset；失败重试仍取同一页。
      favState.offset = offset + items.length;
      favState.total = page.total || 0;
      favState.counts = page.counts || favState.counts;
      // 本地列表本身就是判红集合的来源之一，顺手合并进去。
      items.forEach(function (f) {
        favState.owned.add(identity(f.kind, f.source, f.ref_id));
      });
      renderCounts();
    } catch (err) {
      if (!current()) return;
      H.toast(H.errText('收藏读取失败', err), 'error');
    } finally {
      if (current()) {
        favState.loading = false;
        render();
      }
    }
  }

  /// 收藏全部播放：本地与在线收藏混入同一条队列。
  ///
  /// 逐页读全量身份（界面只加载了第一页，不能只播已加载的），本地 ref_id 直接
  /// 进队列，在线 ref_id 折成 `online:<source>:<id>` 虚拟身份并把快照交给
  /// H.playQueue——服务端历史与队列渲染都靠这份快照，重启后也不退化。
  async function playFavorites() {
    if (favState.playingAll) return;
    var intent = T.beginPlaybackIntent();
    favState.playingAll = true;
    renderButtons();
    try {
      var offset = 0;
      var ids = [];
      var meta = {};
      var total;
      do {
        var page = await T.get(pageUrl('track', offset));
        if (!T.isPlaybackIntent(intent)) return;
        var items = page.favorites || [];
        total = page.total || 0;
        if (!items.length && offset < total) throw new Error('收藏列表已变化，请重试');
        items.forEach(function (f) {
          if (f.kind !== 'track') return;
          if (f.source === 'local' || !f.source) {
            ids.push(f.ref_id);
            return;
          }
          var vid = 'online:' + f.source + ':' + f.ref_id;
          ids.push(vid);
          meta[vid] = {
            title: f.title,
            artist: f.artist,
            album: f.album,
            cover: f.cover,
            duration_ms: f.duration_ms || null,
          };
        });
        offset += items.length;
      } while (offset < total);
      if (!ids.length) {
        H.toast('还没有可播放的收藏曲目');
        return;
      }
      if (!T.isPlaybackIntent(intent)) return;
      await H.playQueue(ids, meta);
    } catch (err) {
      if (!T.isPlaybackIntent(intent)) return;
      H.toast(H.errText('收藏播放失败', err), 'error');
    } finally {
      favState.playingAll = false;
      renderButtons();
    }
  }

  /// 批量判红：把一屏的对象 id 一次问完。
  ///
  /// 返回命中的 id 集合（Set），调用方拿去给行加 .is-fav。失败时**不**清空
  /// 已有集合：一次网络抖动不该让整屏的红心集体消失。
  async function syncMembership(kind, source, ids) {
    if (!ids || !ids.length) return new Set();
    try {
      var res = await T.post('/v1/favorites/membership', { kind: kind, source: source, ids: ids });
      var hit = new Set(res && res.ids || []);
      hit.forEach(function (id) { favState.owned.add(identity(kind, source, id)); });
      // 未被命中的要从集合里摘掉，否则取消收藏后红心不灭。
      ids.forEach(function (id) {
        if (!hit.has(id)) favState.owned.delete(identity(kind, source, id));
      });
      return hit;
    } catch (err) {
      return new Set(ids.filter(function (id) { return has(kind, source, id); }));
    }
  }

  /// 红心开关。乐观更新 + 失败回滚：收藏是一次点击就能完成的动作，等服务端
  /// 回来再变色会让人以为没点上；但失败了必须变回去，不能留一个假状态。
  async function toggle(input, onDone) {
    var kind = input.kind || 'track';
    var source = input.source || 'local';
    var refId = input.ref_id != null ? input.ref_id : input.id;
    if (refId == null || refId === '') return;
    var key = identity(kind, source, refId);
    var next = !favState.owned.has(key);

    favState.owned[next ? 'add' : 'delete'](key);
    repaint(input, next);
    try {
      var res = await T.post('/v1/favorites/toggle', {
        kind: kind,
        source: source,
        ref_id: String(refId),
        title: input.title,
        artist: input.artist,
        album: input.album,
        duration_ms: input.duration_ms,
        cover: input.cover,
      });
      var final = !!(res && res.favorited);
      if (final !== next) {
        favState.owned[final ? 'add' : 'delete'](key);
        repaint(input, final);
      }
      H.toast(final ? '已加入我的收藏' : '已取消收藏');
      if (final && res && res.favorite) {
        favState.counts[kind] = (favState.counts[kind] || 0) + 1;
      } else if (!final) {
        favState.counts[kind] = Math.max(0, (favState.counts[kind] || 0) - 1);
      }
      renderCounts();
      // 收藏视图正开着：立刻反映增删，而不是等下次进入才更新。
      if (H.state.view === 'favorites' && favState.kind === kind) load();
      if (typeof onDone === 'function') onDone(final);
    } catch (err) {
      favState.owned[next ? 'delete' : 'add'](key);
      repaint(input, !next);
      H.toast(H.errText('收藏失败', err), 'error');
    }
  }

  /// 让订阅了同一批 id 的视图（曲库行、在线行、收藏列表）重画红心。
  function repaint(input, on) {
    var refId = input.ref_id != null ? input.ref_id : input.id;
    if (H.onFavoriteChanged) H.onFavoriteChanged(input.kind || 'track', input.source || 'local', refId, on);
  }

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  function heartSvg(on) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'
      + (on
        ? 'M12 21s-7.5-4.7-9.3-9.1C1.2 8.5 3.1 5 6.6 5c2 0 3.6 1.1 4.4 2.6C11.8 6.1 13.4 5 15.4 5c3.5 0 5.4 3.5 3.9 6.9C19.5 16.3 12 21 12 21z'
        : 'M12 20.4l-1.1-1C6.7 15.6 3.6 12.8 3.6 9.2 3.6 6.3 5.9 4 8.8 4c1.6 0 3.1.7 4.1 1.9C13.9 4.7 15.4 4 17 4c2.9 0 5.2 2.3 5.2 5.2 0 3.6-3.1 6.4-7.3 10.2L12 20.4zm0-2.6c3.6-3.3 6.4-5.9 6.4-8.6 0-1.8-1.4-3.2-3.2-3.2-1.3 0-2.5.8-3.1 2h-1.4c-.6-1.2-1.8-2-3.1-2C6.8 6 5.6 7.4 5.6 9.2c0 2.7 2.8 5.3 6.4 8.6z')
      + '"/></svg>';
  }

  /// 给任意曲目行加一颗红心。曲库行、队列行、在线结果行都调它，
  /// 于是三处的收藏交互完全一致。
  function attachHeart(actions, input) {
    if (!actions) return null;
    var btn = document.createElement('button');
    btn.className = 't-act fav-act';
    btn.type = 'button';
    btn.dataset.act = 'fav';
    var kind = input.kind || 'track';
    var source = input.source || 'local';
    var on = has(kind, source, input.ref_id != null ? input.ref_id : input.id);
    btn.classList.toggle('is-on', on);
    btn.innerHTML = heartSvg(on);
    btn.title = on ? '取消收藏' : '加入我的收藏';
    btn.setAttribute('aria-label', btn.title);
    btn.onclick = function (e) {
      e.stopPropagation();
      toggle(input, function (final) {
        btn.classList.toggle('is-on', final);
        btn.innerHTML = heartSvg(final);
        btn.title = final ? '取消收藏' : '加入我的收藏';
        btn.setAttribute('aria-label', btn.title);
      });
    };
    actions.insertBefore(btn, actions.firstChild);
    return btn;
  }

  function renderCounts() {
    if (H.ui.favCount) {
      var n = favState.counts.track || 0;
      H.ui.favCount.textContent = n ? n + ' 首' : '—';
    }
    if (H.ui.favTabTrack) H.ui.favTabTrack.textContent = '歌曲 ' + (favState.counts.track || 0);
    if (H.ui.favTabRadio) H.ui.favTabRadio.textContent = '电台 ' + (favState.counts.radio || 0);
  }

  function emptyText() {
    if (favState.kind === 'radio') {
      return '还没有收藏电台。在「在线」里打开一个电台或歌单，点标题旁的收藏即可。';
    }
    return '还没有收藏歌曲。在曲库或在线搜索结果里点曲目行的红心即可收藏。';
  }

  function render() {
    renderButtons();
    var body = H.ui.favList;
    if (!body) return;
    if (H.ui.favTabs) {
      H.ui.favTabs.querySelectorAll('[data-fav-kind]').forEach(function (b) {
        b.classList.toggle('active', b.dataset.favKind === favState.kind);
      });
    }
    body.innerHTML = '';
    if (favState.loading && !favState.items.length) {
      body.innerHTML = '<div class="hint">正在读取收藏…</div>';
      return;
    }
    if (!favState.items.length) {
      body.innerHTML = '<div class="hint">' + emptyText() + '</div>';
      return;
    }
    favState.items.forEach(function (f) { body.appendChild(row(f)); });
  }

  function renderButtons() {
    if (H.ui.favMore) {
      H.ui.favMore.hidden = favState.offset >= favState.total;
      H.ui.favMore.disabled = favState.loading;
      H.ui.favMore.textContent = favState.loading ? '正在读取收藏…' : '加载更多收藏';
    }
    if (H.ui.favPlayAll) {
      H.ui.favPlayAll.hidden = favState.kind !== 'track';
      H.ui.favPlayAll.disabled = favState.playingAll;
      H.ui.favPlayAll.textContent = favState.playingAll ? '正在读取收藏…' : '播放收藏';
    }
  }

  function row(f) {
    var el = document.createElement('div');
    el.className = 'track fav-row';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.innerHTML =
      '<div class="t-index"><span class="t-num">'
      + (f.kind === 'radio' ? '📻' : '♪')
      + '</span></div>' +
      '<div class="t-art"></div>' +
      '<div class="t-main">' +
        '<div class="t-title"></div>' +
        '<div class="t-sub"></div>' +
      '</div>' +
      '<div class="t-album"></div>' +
      '<div class="t-quality"></div>' +
      '<div class="t-dur"></div>' +
      '<div class="t-actions"></div>';
    el.querySelector('.t-title').textContent = f.title;
    el.querySelector('.t-sub').textContent = f.artist || '未知艺术家';
    el.querySelector('.t-album').textContent = f.album || '—';
    el.querySelector('.t-dur').textContent = f.duration_ms ? H.fmt(f.duration_ms) : '—';

    var quality = el.querySelector('.t-quality');
    // 来源徽标与在线面板同一套平台 app 图标；没有 online.js 时（单元测试桩）
    // 退回裸文本，至少不把整行渲染打断。
    var tag = window.Online && window.Online.badge
      ? window.Online.badge(f.source === 'local' ? 'local' : f.source)
      : null;
    if (!tag) {
      tag = document.createElement('span');
      tag.className = 'src-badge';
      tag.textContent = f.source === 'local' ? '本地' : f.source;
    }
    quality.appendChild(tag);

    // 封面：本地曲目走服务端封面接口，在线曲目用存下来的快照 URL。
    var art = el.querySelector('.t-art');
    if (f.cover) {
      // 与在线列表同一套缩略图规则：40px 的行不需要 MB 级原图。
      H.paintArt(el, window.Online && window.Online.rowCoverUrl
        ? window.Online.rowCoverUrl(f.cover) : f.cover);
    } else if (f.source === 'local' && H.coverUrl) {
      H.paintArt(el, H.coverUrl(f.ref_id));
    } else {
      art.classList.add('is-missing');
    }

    var actions = el.querySelector('.t-actions');
    attachHeart(actions, {
      kind: f.kind,
      source: f.source,
      ref_id: f.ref_id,
      title: f.title,
      artist: f.artist,
      album: f.album,
      duration_ms: f.duration_ms,
      cover: f.cover,
    });

    var play = document.createElement('button');
    play.className = 't-act';
    play.type = 'button';
    play.title = f.kind === 'radio' ? '载入这个电台' : '播放';
    play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-play"/></svg>';
    play.onclick = function (e) { e.stopPropagation(); activate(f); };
    actions.appendChild(play);

    el.addEventListener('click', function () { activate(f); });
    return el;
  }

  /// 点一行：歌曲直接播，电台整盘载入。
  async function activate(f) {
    if (f.kind === 'radio') {
      if (typeof H.playRadio === 'function') {
        H.playRadio(f);
        return;
      }
      H.toast('该电台来自 ' + f.source + '，请到「在线」面板登录后载入');
      return;
    }
    if (f.source === 'local') {
      if (typeof H.playLocal === 'function') {
        H.playLocal(f.ref_id);
        return;
      }
    }
    // 在线收藏：走在线试听链路。
    if (typeof H.playOnline === 'function') {
      H.playOnline(f);
      return;
    }
    H.toast('这首收藏来自 ' + f.source + '，需要在「在线」面板登录后播放');
  }

  function init() {
    if (H.ui.favTabs) {
      H.ui.favTabs.onclick = function (e) {
        var btn = e.target.closest('[data-fav-kind]');
        if (!btn) return;
        favState.kind = btn.dataset.favKind;
        load();
      };
    }
    if (H.ui.favPlayAll) {
      H.ui.favPlayAll.onclick = function () { return playFavorites(); };
    }
    if (H.ui.favMore) H.ui.favMore.onclick = function () { return loadMore(); };
    if (H.ui.favRefresh) H.ui.favRefresh.onclick = function () { load(); };
    renderCounts();
    render();
  }

  window.Favorites = {
    bind: function (host) { H = host; T = window.VMusicTransport; },
    init: init,
    onViewEnter: function () { load(); },
    load: load,
    loadMore: loadMore,
    playFavorites: playFavorites,
    // 旧导出名：check 脚本与既有调用方的兼容别名。
    playLocalFavorites: playFavorites,
    toggle: toggle,
    syncMembership: syncMembership,
    attachHeart: attachHeart,
    heartSvg: heartSvg,
    has: has,
    identity: identity,
    state: favState,
  };
})();
