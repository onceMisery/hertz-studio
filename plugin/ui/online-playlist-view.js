// SPDX-License-Identifier: MIT
//
// 在线集合的两层界面：网格层（歌单卡片）→ 详情层（信息面板 + 曲目）。
//
// 「集合」有三种：歌单（/v1/online/playlist）、专辑（/v1/online/album）、
// 歌手热门歌曲（/v1/online/artist）。三者共用同一层 UI 与分页机制，只有
// 端点与头部信息字段不同——openCollection(kind, …) 是统一入口，旧入口
// open/openById 仍是歌单语义的便捷包装。
//
// 详情层的曲目有两种排布：封面（默认，一眼看得到专辑图）与列表（读专辑/时长
// 这些文本列）。这与参考实现一致——它默认把曲目铺成封面卡片，文本列表是二级
// 入口；切换只改渲染，不重新取数。
//
// 结构取自参考项目的「集合网格 → 曲目详情」，实现全部走当前项目的原生
// 方式：
//   · 层级切换只有 `H.setLayer()` 一个出口，由 app.js 收口四层显隐，这里不
//     自己写 hidden，也不引一套导航栈（深度只有两层）。
//   · 曲目行走 `Online.row()`，与在线搜索结果同一套 VIP 置灰 / 收藏 / 试听。
//   · 分页用集合端点现成的 offset+limit，尾哨兵 + 「加载更多」按钮双保险，
//     与曲库的哨兵分页同一套写法。
//   · 歌单数据只有 OnlinePlaylists 那一份，这里不复制缓存；专辑/歌手由
//     搜索结果直接带齐头部信息，不需要清单。
//
// 三条必须如实的地方：
//   1. 加载失败 ≠ 空集合。两者渲染成不同内容，绝不让鉴权/网络故障看起来像
//      「这个集合是空的」。
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
  /// 背景图位封面：插件形态下远程地址要经 sidecar 换成 data URL（沙箱 CSP 画不
  /// 出 https 图）。HertzCovers 由 app.js 挂出；契约检查的沙箱只加载本模块，
  /// 拿不到时回落成直接赋值，即独立形态的同款行为。
  function applyBg(el, url) {
    if (window.HertzCovers) { window.HertzCovers.applyBg(el, url); return; }
    if (el) el.style.backgroundImage = url ? 'url("' + url + '")' : '';
  }

  var PAGE = 50;
  var H = null; // app.js 注入的宿主（setLayer / caps / enqueue / toast）

  var state = {
    // 网格层
    items: [],        // OnlinePlaylists.all() 的扁平清单
    sourceFilter: '', // 从某个音源分组进入时只显示该源
    query: '',
    // 详情层
    from: 'arrange',  // 进入详情前的层，返回时回到那里
    source: null,
    // 集合种类与头部信息。kind: playlist | album | artist；subject 按种类
    // 装各自有的字段（歌单有 play_count/creator，专辑有 artist，歌手只有
    // name/cover/track_count）。
    kind: 'playlist',
    subject: null,
    tracks: [],
    total: 0,
    offset: 0,
    // 专辑/歌手端点的翻页标记（上游不给总数时靠它判断「还有没有下一页」）。
    // 歌单详情没有这个字段，翻页看 tracks.length < total。
    more: false,
    phase: 'idle',    // idle | loading | ready | error
    error: null,      // { kind: 'generic' | 'not-public', message }
    loadingMore: false,
    trackQuery: '',
    mode: 'cover',    // cover | list
    // F2 整单续载进度（队列那一边的）。由 online:collection-load 事件驱动，
    // 只在 msg 与当前打开的歌单对上时更新；done 后不再显示。
    collection: null,
  };

  // 集合种类 → 中文名与取数端点。详情层的一切「歌单」字样都从这里翻。
  var KIND_META = {
    playlist: { label: '歌单', endpoint: '/v1/online/playlist' },
    album: { label: '专辑', endpoint: '/v1/online/album' },
    artist: { label: '歌手', endpoint: '/v1/online/artist' },
  };
  function kindLabel() {
    return (KIND_META[state.kind] || KIND_META.playlist).label;
  }
  function kindEndpoint() {
    return (KIND_META[state.kind] || KIND_META.playlist).endpoint;
  }

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
  // 时长：宿主（app.js）有一份和曲库/搜索完全相同的格式化实现，优先用它，
  // 取不到时退回本地算，卡片上不会出现空白时长。
  function fmt(ms) {
    if (H && H.fmt) return H.fmt(ms);
    if (!ms) return '—';
    var total = Math.round(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

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
    var url = window.Online ? window.Online.rowCoverUrl(window.Online.safeCoverUrl(p.cover), 300) : null;
    if (url) applyBg(cover, url);
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

  // 统一入口。spec = { kind, source, id, name, cover, track_count,
  // play_count, creator, artist }。kind 缺省按歌单处理（旧调用方只给歌单）。
  function openCollection(spec, from) {
    spec = spec || {};
    state.kind = KIND_META[spec.kind] ? spec.kind : 'playlist';
    state.from = from || 'arrange';
    state.source = spec.source;
    state.subject = {
      id: spec.id,
      name: spec.name,
      cover: spec.cover,
      track_count: spec.track_count,
      play_count: spec.play_count,
      creator: spec.creator,
      artist: spec.artist,
    };
    state.tracks = [];
    state.total = 0;
    state.offset = 0;
    state.more = false;
    state.phase = 'loading';
    state.error = null;
    state.loadingMore = false;
    state.trackQuery = '';
    // 换了集合，上一个歌单的续载进度行作废（服务端意图也已被 set_queue 清掉）。
    state.collection = null;
    var q = el('opl-detail-q');
    if (q) q.value = '';
    ensureVisible();
    setLayer('online-detail');
    renderInfo();
    renderTracks();
    loadPage(0);
  }

  // 旧歌单入口：签名保持不变（网格层/歌单视图在线行都还在用）。
  function openDetail(source, p, from) {
    openCollection(Object.assign({ kind: 'playlist' }, p, { source: source }), from);
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
    var p = state.subject;
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
      d = await tr().get(kindEndpoint() + '?source=' + encodeURIComponent(state.source)
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
    // 歌单端点回 { playlist, total, tracks }；专辑/歌手端点回 CollectionDetail
    // （name/cover/total/more）。头部信息以端点返回为准——搜索卡片上的快照
    // 可能过期。
    if (state.kind === 'playlist') {
      state.subject.name = (d.playlist && d.playlist.name) || p.name;
      state.subject.cover = (d.playlist && d.playlist.cover) || p.cover;
    } else {
      if (d.name) state.subject.name = d.name;
      if (d.cover) state.subject.cover = d.cover;
      state.more = !!d.more;
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
    if (state.phase !== 'ready') return false;
    // 歌手/专辑端点带 more 布尔（上游不给总数时 total 是保守值），优先用它。
    if (state.kind !== 'playlist' && typeof state.more === 'boolean') return state.more;
    return state.tracks.length < state.total;
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

  // 信息面板：封面 + 标题 + 音源徽标 + 曲目数/播放数/创建者/主歌手 + 操作按钮。
  // 与参考实现的 cut-in 面板同构，只是不做浮层（歌单视图层内即可）。
  function renderInfo() {
    var p = state.subject;
    if (!p) return;
    var title = el('opl-detail-title');
    if (title) title.textContent = kindLabel() + ' · ' + (p.name || '');

    var box = el('opl-info');
    if (!box) return;
    box.innerHTML = '';

    var cover = document.createElement('div');
    cover.className = 'opl-cover';
    var url = window.Online ? window.Online.rowCoverUrl(window.Online.safeCoverUrl(p.cover), 300) : null;
    if (url) applyBg(cover, url);
    else cover.classList.add('is-missing');
    box.appendChild(cover);

    var head = document.createElement('div');
    head.className = 'opl-info-title';
    var name = document.createElement('strong');
    name.textContent = p.name || '';
    head.appendChild(name);
    // 徽标与在线面板同一套：平台 app 图标（见 online.js 的 badge()）。
    var badge = window.Online && window.Online.badge
      ? window.Online.badge(state.source, capSourceLabel())
      : null;
    if (badge) {
      badge.classList.add('opl-badge');
      head.appendChild(badge);
    }
    box.appendChild(head);

    var meta = document.createElement('div');
    meta.className = 'opl-info-meta';
    var bits = [];
    if (state.kind === 'artist') {
      // 歌手页的 total 是「热门歌曲」条数，不是全部歌曲数，别冒充「N 首」。
      if (state.phase === 'ready' && state.total) bits.push('热门歌曲 ' + state.total + ' 首');
      else if (p.track_count) bits.push('共 ' + p.track_count + ' 首歌曲');
    } else {
      bits.push((state.total ? state.total : p.track_count || 0) + ' 首');
    }
    if (p.play_count) bits.push('播放 ' + p.play_count);
    if (state.kind === 'album' && p.artist) bits.push(p.artist);
    if (p.creator) bits.push('by ' + p.creator);
    meta.textContent = bits.join(' · ');
    box.appendChild(meta);

    var acts = document.createElement('div');
    acts.className = 'opl-info-acts';
    var view = visibleTracks();
    acts.appendChild(actionButton(playLabel(view), 'primary', function () {
      if (!view.length) return;
      // F2 整单播放：歌单未取全且未筛选时发集合意图，首页之后由服务端续载
      // ——只有这条路径上的「播放全部」才真的承诺了全部。专辑/歌手的翻页
      // 接口不同（more 布尔、无服务端续载），保持只播已加载。
      if (playSupportsCollection()) {
        window.Online.playCollection(state.source, state.subject.id);
        return;
      }
      window.Online.playAll(view, 0);
    }));
    acts.appendChild(actionButton(queueLabel(view), '', function () {
      if (!view.length) return;
      enqueue(view);
    }));
    box.appendChild(acts);
    box.appendChild(scopeNote());
    box.appendChild(loadNote());
  }

  // 整单播放的可用性：歌单、未筛选、还没取全、且音源登记了 playlist_detail
  // 能力位（caps 是 UI 的唯一事实表，缺了就是点了必 404）。
  function playSupportsCollection() {
    return state.kind === 'playlist'
      && !state.trackQuery.trim()
      && hasMore()
      && window.Online
      && typeof window.Online.supports === 'function'
      && window.Online.supports(state.source, 'playlist_detail');
  }

  function capSourceLabel() {
    var hit = state.items.filter(function (it) { return it.source === state.source; })[0];
    return hit ? hit.sourceLabel : state.source;
  }

  // 按钮只承诺它实际交出去的那批曲目。分页是惰性的：view 永远不含未加载的页，
  // 所以「全部」只在确实取完时才可以说。筛选的域同样是已加载部分，另在下方
  // 用一行说明（见 scopeNote），不把它塞进按钮文案里堆字数。
  function playLabel(view) {
    if (state.trackQuery.trim()) return '播放 ' + view.length + ' 首';
    // F2：歌单有服务端整单续载时，「全部」由后台按页兑现，可以如实说全部；
    // 其余集合（专辑/歌手）仍只承诺已加载的部分。
    if (playSupportsCollection()) return '播放全部 ' + (state.total || view.length) + ' 首';
    return hasMore() ? '播放已加载 ' + view.length + ' 首' : '播放全部 ' + view.length + ' 首';
  }
  function queueLabel(view) {
    if (state.trackQuery.trim()) return '加入 ' + view.length + ' 首到队列';
    return hasMore() ? '加入已加载 ' + view.length + ' 首到队列' : '加入全部 ' + view.length + ' 首到队列';
  }

  // 筛选生效而集合还没取完时，说清筛选找的是哪一段，并给出取全的动作。
  function scopeNote() {
    var box = document.createElement('div');
    box.className = 'opl-scope-note';
    if (!state.trackQuery.trim()) {
      box.hidden = true;
      return box;
    }
    box.hidden = !hasMore();
    var left = Math.max(0, (state.total || 0) - state.tracks.length);
    box.textContent = '筛选只在已加载的 ' + state.tracks.length + ' 首里查找'
      + (left ? '，还有 ' + left + ' 首未加载。' : '。');
    return box;
  }

  function actionButton(text, kind, onclick) {
    var b = document.createElement('button');
    b.className = 'btn' + (kind ? ' ' + kind : '');
    b.type = 'button';
    b.textContent = text;
    b.onclick = onclick;
    return b;
  }

  // F2 整单续载的进度行。它描述的是「队列那一边」的后台补页，与详情页自己的
  // 分页是两回事；done 之后不再出现。中断时给「继续载入」——force 绕过水位
  // 与节流，但服务端的会话复核不变：换过队就安静作废。
  function loadNote() {
    var box = document.createElement('div');
    box.className = 'opl-scope-note opl-load-note';
    var c = state.collection;
    if (!c || c.done || state.kind !== 'playlist') {
      box.hidden = true;
      return box;
    }
    if (c.error) {
      box.textContent = '后台载入中断，已加入 ' + c.loaded + ' 首（' + c.error + '）';
      box.appendChild(document.createTextNode(' '));
      box.appendChild(actionButton('继续载入', '', function () {
        tr().post('/v1/online/collection/refresh').catch(function () {
          // 失败的进度由下一条 collection_load 事件带回，这里不重复报错。
        });
      }));
      return box;
    }
    box.textContent = '正在把整张歌单加入播放队列：已加入 ' + c.loaded + ' 首'
      + (c.total ? ' / ' + c.total : '')
      + '。可先听当前曲目，切歌不必等。';
    return box;
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
    // 封面排布下"专辑/来源/时长"这几列没有落点（卡片上放不下也读不清），
    // 表头随之收起。
    var cover = state.mode === 'cover';
    box.className = 'opl-rows' + (cover ? ' is-cover' : '');
    var head = el('opl-head');
    if (head) head.hidden = cover;

    if (state.phase === 'loading') {
      box.innerHTML = '<div class="hint">正在加载' + kindLabel() + '…</div>';
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
        : '这个' + kindLabel() + '是空的。';
      box.appendChild(hint);
      paintTail();
      return;
    }

    if (state.mode === 'cover') {
      view.forEach(function (t, i) { box.appendChild(trackCard(t, i, view)); });
      paintTail();
      return;
    }

    // 写操作只有歌单有（往歌单里加/删曲）；专辑与歌手页是只读集合。
    var canWrite = state.kind === 'playlist' && hasCap(state.source, 'playlist_write');
    view.forEach(function (t, i) {
      var row = window.Online.row(t, function () {
        // VIP 曲放行：可播与否由后端按账号 cookie 定，失败如实 toast。
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

  // 封面排布的单张曲目卡：封面 + 歌名 + 歌手·时长。类名沿用在线面板网格那套
  // （.op-card / .op-cover / .op-pl-name / .op-pl-sub），两处网格永远同款。
  // 只有不可播（无试听地址）整卡置灰且点击无效；VIP 保留徽标、点击交给
  // 后端按账号判定，与列表排布下 Online.row 的口径一致。
  function trackCard(t, i, view) {
    var blocked = !t.playable;
    var c = document.createElement('div');
    c.className = 'op-card opl-track-card' + (blocked ? ' is-disabled' : '');
    c.setAttribute('role', 'button');
    c.tabIndex = 0;
    c.title = t.title;

    var cover = document.createElement('div');
    cover.className = 'op-cover';
    var url = window.Online ? window.Online.rowCoverUrl(window.Online.safeCoverUrl(t.cover), 300) : null;
    if (url) applyBg(cover, url);
    else cover.classList.add('is-missing');
    if (t.vip_only) {
      var vip = document.createElement('span');
      vip.className = 'vip-tag opl-card-vip';
      vip.textContent = 'VIP';
      cover.appendChild(vip);
    }
    c.appendChild(cover);

    var name = document.createElement('div');
    name.className = 'op-pl-name';
    name.textContent = t.title;
    c.appendChild(name);

    var sub = document.createElement('div');
    sub.className = 'op-pl-sub';
    sub.textContent = (t.artist || '未知艺术家') + ' · ' + fmt(t.duration_ms || 0);
    c.appendChild(sub);

    function play() {
      if (!t.playable) return;
      window.Online.playAll(view, i);
    }
    c.onclick = play;
    c.onkeydown = function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(); }
    };
    return c;
  }

  // 切换曲目排布。只重渲染，不重新取数：已加载的曲目、筛选词、总数和
  // 「加载更多」的位置都原样保留。
  function setMode(name) {
    state.mode = name === 'list' ? 'list' : 'cover';
    var group = el('opl-modes');
    if (group && group.querySelectorAll) {
      var btns = group.querySelectorAll('button[data-opl-mode]');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('active',
          btns[i].getAttribute('data-opl-mode') === state.mode);
      }
    }
    renderTracks();
  }

  function errorNode() {
    var wrap = document.createElement('div');
    wrap.className = 'opl-error';
    var hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = state.error.kind === 'not-public'
      ? '这个' + kindLabel() + '不是公开内容，当前音源接口读不到它。'
      : errText(kindLabel() + '加载失败', { message: state.error.message })
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

    var modes = el('opl-modes');
    if (modes && modes.querySelectorAll) {
      var btns = modes.querySelectorAll('button[data-opl-mode]');
      for (var i = 0; i < btns.length; i++) {
        (function (btn) {
          btn.onclick = function () { setMode(btn.getAttribute('data-opl-mode')); };
        })(btns[i]);
      }
    }

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

  // F2：整单续载进度事件只影响「队列那一边」。这里把它归到当前打开的歌单
  // ——不是这个歌单的进度不动界面（切歌串台守卫同一原则）。测试沙箱的
  // window 没有 addEventListener，守卫掉；接线本身由契约检查钉住。
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('online:collection-load', function (ev) {
      var msg = ev && ev.detail;
      if (!msg || state.kind !== 'playlist') return;
      if (msg.source !== state.source || !state.subject || msg.id !== state.subject.id) return;
      state.collection = msg;
      renderInfo();
    });
  }

  window.OnlinePlaylistView = {
    bind: function (host) { H = host; },
    init: bindStatic,
    openGrid: openGrid,
    open: openById,
    // 统一集合入口：歌单 / 专辑 / 歌手页都从这里进（kind 缺省歌单）。
    openCollection: openCollection,
    close: back,
    // 曲目排布（cover | list）。菜单/命令面板这类外部入口也用它切换。
    setMode: setMode,
    state: state,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bindStatic(); });
  } else {
    bindStatic();
  }
})();
