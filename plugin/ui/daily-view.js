// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 每日推荐：导航里的独立入口 + 独立路由页面。
//
// 首页那条推荐条（daily.js）是「曲库」页面里的一块，只能顺路看到；这里把它
// 提成一级目的地，带自己的页面：按日期切换、刷新、列表/卡片两种排布、空态
// 提示。数据与播放链路和首页那条完全同源（同样两个接口、同样一条
// playQueue），不另立一套取数，免得两处推荐内容对不上。
//
// 菜单项是**配置驱动**的：名称、图标、排序位置都写在 NAV 里，可见性由设置
// 表里的开关控制。注入时只往导航轨里插一个新按钮，现有菜单项的 HTML、
// 点击绑定与 setView 分支一概不动。

(function () {
  'use strict';

  /// 背景图位封面：插件形态下远程地址要经 sidecar 换成 data URL（沙箱 CSP 画不
  /// 出 https 图）。HertzCovers 由 app.js 挂出；契约检查的沙箱只加载本模块，
  /// 拿不到时回落成直接赋值，即独立形态的同款行为。
  function applyBg(el, url) {
    if (window.HertzCovers) { window.HertzCovers.applyBg(el, url); return; }
    if (el) el.style.backgroundImage = url ? 'url("' + url + '")' : '';
  }

  /// 菜单项配置。改这里就能改名字/图标/位置，不用碰 index.html。
  var NAV = {
    id: 'daily',
    name: '每日推荐',
    // 图标是 index.html 里 svg sprite 的 symbol id。
    icon: '#i-daily',
    /// 排序位置：与现有菜单项的隐含顺序（BASE_ORDER）比较后插到对应位置。
    /// 取 25 = 落在「在线」(20) 与「歌单」(30) 之间。
    order: 25,
    /// 可见性开关在设置表里的键名。没有这条设置时默认显示。
    settingKey: 'nav_daily_visible',
  };

  /// 现有菜单项的顺序。刻意不写进 index.html——那会改动既有菜单的标记；
  /// 新项要插到谁前面，这里查表就够了。
  var BASE_ORDER = {
    library: 10,
    online: 20,
    playlists: 30,
    queue: 40,
    favorites: 50,
    settings: 100,
  };

  var LAYOUT_KEY = 'vmusic.dailyview.layout';
  var MODE_KEY = 'vmusic.dailyview.mode';
  var LIMIT = 30;

  var H = null;
  var T = null;

  var st = {
    /// null 表示「今天」；具体数字是天序号（与后端 day_number() 同定义）。
    day: null,
    /// online = 各平台汇总；local = 本机规则引擎。
    mode: 'online',
    layout: 'list',
    loading: false,
    local: null,
    online: null,
    failed: false,
  };

  // ---------------------------------------------------------------------------
  // 日期：天序号与后端对齐（当天本地零点距纪元的天数）
  // ---------------------------------------------------------------------------

  /// 与后端 day_number() **严格同一套算法**：UTC 毫秒整除一天的毫秒数。
  ///
  /// 后端的 local_offset_secs() 返回 0（按 UTC 换天，见 daily.rs 的注释），
  /// 所以这里绝不能改用本地时区——在东八区两边会差整整一天，于是前端认为的
  /// "今天"被后端判成"其它日期"，在线那份直接走 history 分支，用户一进页面
  /// 就看到「在线推荐只提供当天」。日期是两端共用的主键，必须同定义。
  function dayNumberAt(date) {
    return Math.floor(date.getTime() / 86400000);
  }

  function todayDay() {
    return dayNumberAt(new Date());
  }

  /// 天序号 → Date。同上：以 UTC 为基准，不要在这里加时区偏移。
  function dayToDate(day) {
    return new Date(day * 86400000);
  }

  function activeDay() {
    return st.day === null ? todayDay() : st.day;
  }

  function isToday() {
    return activeDay() === todayDay();
  }

  /// 显示也按 UTC：与后端 date_label() 同源，否则日期标签会比后端返回的那
  /// 个 date 字段差一天，页面顶上写着 09-28、副标题写着 09-29。
  function dateText(day) {
    var d = dayToDate(day);
    var m = String(d.getUTCMonth() + 1);
    var dayNum = String(d.getUTCDate());
    if (m.length < 2) m = '0' + m;
    if (dayNum.length < 2) dayNum = '0' + dayNum;
    return d.getUTCFullYear() + '-' + m + '-' + dayNum;
  }

  // ---------------------------------------------------------------------------
  // 取数
  // ---------------------------------------------------------------------------

  function load() {
    if (!T) return Promise.resolve();
    st.loading = true;
    st.failed = false;
    render();

    var qs = '?limit=' + LIMIT + '&day=' + activeDay();
    // 两条来源并发取：在线挂了不影响本地出榜，反之亦然。
    // allSettled 而不是 all：任一条 reject 都不该把另一条的结果一起丢掉。
    return Promise.allSettled([
      T.get('/v1/recommend/daily' + qs),
      T.get('/v1/recommend/daily/online' + qs),
    ]).then(function (res) {
      st.local = res[0].status === 'fulfilled' ? res[0].value : null;
      st.online = res[1].status === 'fulfilled' ? res[1].value : null;
      // 两条都失败才算失败——只要有一条成了，页面就有东西可看。
      st.failed = res[0].status === 'rejected' && res[1].status === 'rejected';
      st.loading = false;
      render();
    });
  }

  /// 当前来源下的那份数据。
  function page() {
    return st.mode === 'online' ? st.online : st.local;
  }

  /// 当前要展示的曲目（已按来源、已截断到 LIMIT）。
  function items() {
    var p = page();
    if (!p || !p.tracks) return [];
    return p.tracks.slice(0, LIMIT);
  }

  // ---------------------------------------------------------------------------
  // 播放：与首页推荐条共用同一条混合队列通道
  // ---------------------------------------------------------------------------

  /// 入队用的 id。
  ///
  /// **在线曲目必须是 `virtual_id`**。`/v1/recommend/daily/online` 返回的每个
  /// track 同时带着两个 id：`id` 是**平台裸 id**（2751951861），`virtual_id`
  /// 才是服务端认得的 `online:netease:2751951861`。拿裸 id 去 /player/load，
  /// 服务端只当本地曲目查库，回 `not_found` —— 表现就是"点了没反应/播放失败"。
  /// 本地曲目没有 virtual_id，落到 `id` 即可。
  ///
  /// 顺序写成 `virtual_id || t.id` 而不是反过来：两个字段同时存在时，在线那
  /// 一路必须赢。（契约脚本原来只造了带 virtual_id 的假数据，两个顺序都能过，
  /// 这个坑在真实响应下才现形。）
  function idOf(t) {
    return t.virtual_id || t.id;
  }

  function playIds() {
    return items().map(idOf).filter(function (id) { return !!id; });
  }

  /// 在线曲目要带一份元数据快照：服务端才认得 online:xxx 这种虚拟 id，
  /// 不注入的话历史记录里标题会退化成裸 id。
  ///
  /// 快照按服务端 `OnlineMetaSnap` 的形状给（title 必填，缺了整条 meta 会被
  /// 反序列化拒掉、连累整次播放请求 400），所以整条 track 不能原样塞进去。
  function metaOf() {
    var meta = {};
    items().forEach(function (t) {
      var id = idOf(t);
      if (!id || String(id).indexOf('online:') !== 0) return;
      meta[id] = {
        source: t.source || null,
        onlineId: t.id || null,
        title: t.title || '未知曲目',
        artist: t.artist || null,
        album: t.album || null,
        cover: coverOf(t) || null,
        duration_ms: t.duration_ms || null,
      };
    });
    return meta;
  }

  function playAll() {
    if (!H || !H.playQueue) return;
    var ids = playIds();
    if (!ids.length) return;
    H.playQueue(ids, metaOf(), ids[0]);
  }

  function playAt(index) {
    if (!H || !H.playQueue) return;
    var ids = playIds();
    if (!ids.length) return;
    H.playQueue(ids, metaOf(), ids[index]);
  }

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  function subtitle() {
    if (st.loading) return '正在挑歌…';
    if (st.failed) return '两份推荐都没拿到，点刷新再试一次。';
    var p = page();
    if (!p) return '';
    var n = p.total || 0;
    if (!isToday()) {
      // 回看历史时在线那份必然是空的（平台只给当天），说清楚省得以为是坏了。
      return dateText(activeDay()) + ' · ' + n + ' 首'
        + (st.mode === 'online' ? '（在线推荐只提供当天）' : '');
    }
    return (isToday() ? '今天' : dateText(activeDay())) + ' · ' + n + ' 首';
  }

  function emptyText() {
    if (st.failed) return '暂时没有拿到每日推荐，点刷新再试一次。';
    if (st.mode === 'online') {
      var p = st.online;
      if (!p) return '';
      if (!isToday()) {
        return '在线推荐只提供当天。回看 ' + dateText(activeDay()) + ' 请用「本地」来源。';
      }
      var tried = (p.ready || []).slice();
      if (!tried.length) {
        tried = p.skipped.filter(function (s) {
          return s.kind === 'failed' || s.kind === 'timeout' || s.kind === 'empty'
            || s.kind === 'history';
        }).map(function (s) { return s.label; });
      }
      if (tried.length) {
        return tried.join('、') + ' 已登录，但这次没有返回推荐曲目。点刷新再试一次。';
      }
      return '还没有登录任何支持每日推荐的平台。到「在线」面板扫码登录后，这里会自动汇总。';
    }
    return '曲库里还没有可推荐的曲目，先去「曲库」扫描一个音乐目录。';
  }

  function row(item, index) {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'dv-row';
    el.setAttribute('role', 'button');
    el.title = item.title + (item.artist ? ' · ' + item.artist : '');
    var num = document.createElement('span');
    num.className = 'dv-num';
    num.textContent = String(index + 1);
    var main = document.createElement('span');
    main.className = 'dv-main';
    var name = document.createElement('span');
    name.className = 'dv-name';
    name.textContent = item.title || '未知曲目';
    var sub = document.createElement('span');
    sub.className = 'dv-sub';
    sub.textContent = item.artist || item.source_label || '未知艺术家';
    main.appendChild(name);
    main.appendChild(sub);
    var src = document.createElement('span');
    src.className = 'dv-src';
    src.textContent = item.source_label || '本地';
    el.appendChild(num);
    el.appendChild(main);
    el.appendChild(src);
    el.onclick = function () { playAt(index); };
    return el;
  }

  /// 封面 URL。两种来源的取法不一样，写错字段名就是"整墙卡片没有封面"：
  ///   · 在线曲目：后端字段是 **cover**，且必须过 Online.safeCoverUrl——
  ///     平台外链直连会被 Referer/CORS 拦下来，safeCoverUrl 走服务端代发。
  ///   · 本地曲目：没有 cover 字段，要看 has_cover 再用宿主的 coverUrl(id) 拼。
  function coverOf(item) {
    var raw = item.cover || item.cover_url || item.coverUrl || null;
    if (raw) {
      var safe = (window.Online && window.Online.safeCoverUrl)
        ? window.Online.safeCoverUrl(raw) : raw;
      // 卡片格子只有 132~182px，用原图纯属浪费：网易云原图动辄 300KB，
      // 一屏几十张要等好几秒才浮出来，看起来跟"没有封面"一模一样。
      // rowCoverUrl 给 CDN 加 ?param=300y300，小图约几十 KB，几乎瞬间出现。
      return (window.Online && window.Online.rowCoverUrl)
        ? window.Online.rowCoverUrl(safe, 300) : safe;
    }
    if (item.has_cover && H && H.coverUrl && item.id) return H.coverUrl(item.id);
    return '';
  }

  function card(item, index) {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'dv-card';
    el.title = item.title + (item.artist ? ' · ' + item.artist : '');
    var art = document.createElement('span');
    art.className = 'dv-art';
    var cover = coverOf(item);
    if (cover) {
      applyBg(art, cover);
      art.classList.add('has-art');
    } else {
      // 明确标成"缺封面"，与首页推荐条的 daily-cover.is-missing 同一套语义：
      // 有封面和没封面的占位在视觉上要能分开。
      art.classList.add('is-missing');
    }
    var name = document.createElement('span');
    name.className = 'dv-name';
    name.textContent = item.title || '未知曲目';
    var sub = document.createElement('span');
    sub.className = 'dv-sub';
    sub.textContent = item.artist || item.source_label || '未知艺术家';
    el.appendChild(art);
    el.appendChild(name);
    el.appendChild(sub);
    el.onclick = function () { playAt(index); };
    return el;
  }

  function renderBody() {
    var host = H && H.ui ? H.ui.dvBody : null;
    if (!host) return;
    // 排布写在容器的 class 上（而不是靠 :has() 反推子元素）：多列网格只有
    // 卡片画法要，列表画法必须是单列。
    host.className = 'dv-body dv-body-' + st.layout;
    host.innerHTML = '';
    if (st.loading) {
      host.innerHTML = '<div class="hint">正在挑歌…</div>';
      return;
    }
    var list = items();
    if (!list.length) {
      host.innerHTML = '<div class="hint">' + emptyText() + '</div>';
      return;
    }
    var frag = document.createDocumentFragment();
    list.forEach(function (item, i) {
      frag.appendChild(st.layout === 'card' ? card(item, i) : row(item, i));
    });
    host.appendChild(frag);
  }

  /// 排布与来源两组 chip：画法沿用 .chip / .chip.active，与首页推荐条一致。
  function renderChips(group, attr, current) {
    if (!group || !group.querySelectorAll) return;
    var btns = group.querySelectorAll('button[' + attr + ']');
    for (var i = 0; i < btns.length; i += 1) {
      var on = btns[i].getAttribute(attr) === current;
      btns[i].classList.toggle('active', on);
      btns[i].setAttribute('aria-pressed', String(on));
    }
  }

  function render() {
    if (!H || !H.ui) return;
    var ui = H.ui;
    if (ui.dvSub) ui.dvSub.textContent = subtitle();
    if (ui.dvDate) ui.dvDate.textContent = isToday() ? '今天' : dateText(activeDay());
    // 未来不给看：推荐是按天生成的，明天的榜单并不存在。
    if (ui.dvNext) ui.dvNext.disabled = isToday();
    if (ui.dvPrev) ui.dvPrev.disabled = false;
    if (ui.dvPlay) ui.dvPlay.disabled = !items().length;
    renderChips(ui.dvModes, 'data-dv-mode', st.mode);
    renderChips(ui.dvLayouts, 'data-dv-layout', st.layout);
    renderBody();
  }

  // ---------------------------------------------------------------------------
  // 菜单项：按配置注入导航轨
  // ---------------------------------------------------------------------------

  function navButton() {
    var b = document.createElement('button');
    b.className = 'rail-item';
    b.id = 'rail-' + NAV.id;
    b.dataset.view = NAV.id;
    b.setAttribute('aria-label', NAV.name);
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="' + NAV.icon
      + '"/></svg><span>' + NAV.name + '</span>';
    // 自己带 onclick，不吃 app.js 那次批量绑定：菜单项是设置到手之后才决定
    // 要不要挂载的，那时批量绑定早就跑完了，指望它会得到一个点不动的按钮。
    b.onclick = function () { if (H && H.setView) H.setView(NAV.id); };
    return b;
  }

  /// 决定插在哪：现有项里第一个 order 比自己大的，插到它前面。
  /// 全都比自己小就落到 .rail-spacer 之前（「设置」在 spacer 底下，不属于
  /// 一级目的地那一组）。
  function insertPoint(rail) {
    var spacer = rail.querySelector('.rail-spacer');
    var items = rail.querySelectorAll('.rail-item');
    for (var i = 0; i < items.length; i += 1) {
      var o = BASE_ORDER[items[i].dataset.view];
      if (o !== undefined && o > NAV.order) return items[i];
    }
    return spacer || null;
  }

  function mount() {
    var rail = document.getElementById('rail');
    if (!rail) return null;
    // 已挂载就只更新名字与图标（配置可能变了），不重复插入。
    var old = document.getElementById('rail-' + NAV.id);
    if (old) {
      // 配置可能改过（名字/图标），整体重设而不是去改里头的 span/use——
      // 那两个节点是 innerHTML 解析出来的，按结构去取迟早取到 null。
      old.setAttribute('aria-label', NAV.name);
      old.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="' + NAV.icon
        + '"/></svg><span>' + NAV.name + '</span>';
      return old;
    }
    var btn = navButton();
    var before = insertPoint(rail);
    if (before) rail.insertBefore(btn, before);
    else rail.appendChild(btn);
    return btn;
  }

  function unmount() {
    var old = document.getElementById('rail-' + NAV.id);
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }

  /// 可见性来自设置表：没配过默认显示。关掉时若正停在这个页面，退回曲库，
  /// 否则会留在一个导航里已经没有入口的页面上。
  function applySettings(settings) {
    var visible = !settings || settings[NAV.settingKey] !== false;
    if (visible) mount();
    else {
      unmount();
      if (H && H.state && H.state.view === NAV.id && H.setView) H.setView('library');
    }
    if (H && H.ui && H.ui.setNavDaily) H.ui.setNavDaily.checked = visible;
    return visible;
  }

  // ---------------------------------------------------------------------------

  function readStore(key, allowed) {
    try {
      var v = localStorage.getItem(key);
      return allowed.indexOf(v) >= 0 ? v : null;
    } catch (e) { return null; }
  }

  function writeStore(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* 隐私模式 */ }
  }

  function init() {
    st.layout = readStore(LAYOUT_KEY, ['list', 'card']) || 'list';
    st.mode = readStore(MODE_KEY, ['online', 'local']) || 'online';

    var ui = H && H.ui ? H.ui : {};
    if (ui.dvPrev) ui.dvPrev.onclick = function () { st.day = activeDay() - 1; load(); };
    if (ui.dvNext) ui.dvNext.onclick = function () {
      var next = activeDay() + 1;
      if (next > todayDay()) return;
      st.day = next;
      load();
    };
    // 日期按钮身兼两职：显示当前是哪天，点了就回到今天。
    // id 是 dv-date（不是 dv-today），绑错名字会得到一个点了没反应的按钮。
    if (ui.dvDate) ui.dvDate.onclick = function () { st.day = null; load(); };
    if (ui.dvRefresh) ui.dvRefresh.onclick = function () { load(); };
    if (ui.dvPlay) ui.dvPlay.onclick = playAll;

    if (ui.dvModes) {
      ui.dvModes.querySelectorAll('button[data-dv-mode]').forEach(function (b) {
        b.onclick = function () {
          st.mode = b.getAttribute('data-dv-mode');
          writeStore(MODE_KEY, st.mode);
          render();
        };
      });
    }
    if (ui.dvLayouts) {
      ui.dvLayouts.querySelectorAll('button[data-dv-layout]').forEach(function (b) {
        b.onclick = function () {
          st.layout = b.getAttribute('data-dv-layout');
          writeStore(LAYOUT_KEY, st.layout);
          render();
        };
      });
    }
    if (ui.setNavDaily) {
      ui.setNavDaily.onchange = function () {
        if (!T) return;
        var payload = {};
        payload[NAV.settingKey] = ui.setNavDaily.checked;
        // 本地已即时生效（下一行 applySettings）；写服务端只是持久化镜像，
        // 本模块只拿到 H 这个宿主接口、没有 toast 通道，失败就下次拉设置时回退。
        T.put('/v1/settings', payload).catch(function () {});
        applySettings(Object.assign({}, (H.state && H.state.settings) || {}, payload));
      };
    }
    render();
  }

  /// 进入页面时才拉：启动时多打两条请求不值得，用户不一定会点开。
  function onViewEnter() {
    // 已有数据且是今天就不重复拉；切走再回来看到的还是同一份。
    if (!page()) load();
    else render();
  }

  window.DailyView = {
    bind: function (host) { H = host; T = window.VMusicTransport; },
    init: init,
    mount: mount,
    unmount: unmount,
    applySettings: applySettings,
    onViewEnter: onViewEnter,
    load: load,
    render: render,
    /// 配置对外可读可改：改完调 mount() 即可生效。
    nav: NAV,
    state: st,
  };
})();
