// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 每日推荐。两个来源，共用这一条推荐位：
//
//   在线 —— `GET /v1/recommend/daily/online`：服务端挑出**当前已登录**且支持
//           每日推荐接口的平台，并发拉取后轮询交错、跨平台去重，合成一份
//           统一歌单（见 crates/hertz-studio/src/daily.rs）。未登录 / 没这个接口 /
//           上游抽风的平台只在自己那一条 `skipped` 里留名，既不报错也不拖慢
//           整页——单点失败不算失败。
//   本地 —— `GET /v1/recommend/daily`：本机规则引擎，种子是天序号，同一天
//           刷新多少次都是同一份。
//
// 这一层只负责取、画、播三件事：合并规则、打分规则、跳过判据全在服务端，
// 前端一行规则都不重复，否则两端迟早给出不一样的答案。
//
// 两路请求**各自收尾、各自上屏**，不再等对方。以前是 allSettled 之后统一
// render 一次：本地那一路是本机纯函数、毫秒级就有结果，却被在线那一路扣住，
// 用户看到的是「等半天，然后一次性全跳出来」。
(function () {
  'use strict';
  var T = null;
  var H = null; // 宿主：{ ui, state, fmt, toast, errText, playLocal, playQueue, paintArt, coverUrl }

  /// 上一次选的来源。存本地即可——它是个人的看榜习惯，跟"换浏览器也要一致"
  /// 那类服务端设置不是一回事。
  var MODE_KEY = 'vmusic.daily.mode';

  /// 进「曲库」页就会调一次 load()，而在线汇总最坏要等满服务端的等待预算。
  /// 用户在几个视图之间来回切两下不该每轮都重打上游：手上这份不老于这个秒数
  /// 就直接用。显式刷新走 force，不受这条限制。跨天也顺带覆盖了——过零点后
  /// 最多 60 秒就会重取一次。
  var FRESH_SECS = 60;

  /// 服务端只等一个预算就把已落地的平台先返回，没到的记在 `pending`；拿过期
  /// 缓存顶上时记 `refreshing`，新值正在后台刷。两种都表示「这份还不是最终的」，
  /// 要再拉一次才补齐。封顶是为了上游一直不回来时不至于无限轮询下去。
  var TOPUP_MAX = 3;
  var TOPUP_DELAY_MS = 2500;

  /// 补拉定时器与轮次号。每发起一轮 load 就把 generation +1，上一轮的回调与
  /// 定时器据此自行作废：不这么做的话，用户连点两次刷新会看到两份响应互相
  /// 覆盖，最后停在先发出的那一份上。
  var topupTimer = null;
  var generation = 0;
  var fetchedAt = { local: 0, online: 0 };

  var dailyState = {
    /// 两路里任意一路在飞。刷新按钮据它决定要不要作废重来。
    loading: false,
    /// 分路的在飞标记：render() 只在**当前来源**那一路在飞且手上没东西时
    /// 才显示占位，否则「正在挑歌…」会把已经画出来的列表冲掉。
    localBusy: false,
    onlineBusy: false,
    loaded: false,
    /// 本地规则引擎的结果（DailyPage）。
    page: null,
    /// 在线汇总的结果（DailyOnlinePage）。
    online: null,
    /// 在线那一路的错误。只用于副标题里如实说明，不弹红——见 fetchOnline()。
    onlineError: null,
    /// 'online' | 'local'。
    mode: 'online',
    /// 用户是否显式选过来源。没选过时才允许按"有没有登录平台"自动落位。
    modePinned: false,
  };

  function syncLoading() {
    dailyState.loading = dailyState.localBusy || dailyState.onlineBusy;
  }

  function stale(which) {
    var at = fetchedAt[which];
    return !at || (Date.now() - at) > FRESH_SECS * 1000;
  }

  function readMode() {
    try { return localStorage.getItem(MODE_KEY); } catch (e) { return null; }
  }

  function writeMode(mode) {
    try { localStorage.setItem(MODE_KEY, mode); } catch (e) { /* 隐私模式 */ }
  }

  function load(opts) {
    opts = opts || {};
    // 已经有一轮在飞就不重复发。显式刷新是例外：它要把上一轮整个作废重来。
    if (dailyState.loading && !opts.force) return;
    if (topupTimer) { clearTimeout(topupTimer); topupTimer = null; }

    var wantLocal = !!opts.force || !dailyState.page || stale('local');
    var wantOnline = !!opts.force || !dailyState.online || stale('online');
    if (!wantLocal && !wantOnline) { render(); return; }

    generation += 1;
    var gen = generation;
    dailyState.localBusy = wantLocal;
    dailyState.onlineBusy = wantOnline;
    syncLoading();
    render();

    if (wantLocal) fetchLocal(opts, gen);
    if (wantOnline) fetchOnline(gen, 0);
  }

  function fetchLocal(opts, gen) {
    T.get('/v1/recommend/daily?limit=12').then(function (p) {
      if (gen !== generation) return;
      dailyState.page = p;
      dailyState.loaded = true;
      dailyState.localBusy = false;
      fetchedAt.local = Date.now();
      syncLoading();
      settleMode();
      render();
    }).catch(function (err) {
      if (gen !== generation) return;
      dailyState.page = null;
      dailyState.localBusy = false;
      syncLoading();
      // 进页面自动拉的那次失败不弹红：推荐位是锦上添花，不该一进来就报错。
      if (!opts.silent) H.toast(H.errText('每日推荐读取失败', err), 'error');
      settleMode();
      render();
    });
  }

  /// 在线汇总那一路。失败不弹红、也不带 silent 开关：它从头到尾都不是一次
  /// 用户发起的操作，弹红只会让人以为播放器坏了。
  function fetchOnline(gen, attempt) {
    T.get('/v1/recommend/daily/online?limit=24').then(function (p) {
      if (gen !== generation) return;
      dailyState.online = p;
      dailyState.onlineError = null;
      dailyState.onlineBusy = false;
      fetchedAt.online = Date.now();
      syncLoading();
      settleMode();
      render();
      scheduleTopUp(gen, p, attempt);
    }).catch(function (err) {
      if (gen !== generation) return;
      // 副标题里如实写一句就够，用户想看细节时自己会去在线面板。
      dailyState.online = null;
      dailyState.onlineError = err;
      dailyState.onlineBusy = false;
      syncLoading();
      settleMode();
      render();
    });
  }

  /// 补拉一次。两种触发条件，都由服务端判定：
  ///   · `pending` 非空 —— 服务端到点先返回了，这几个平台还在后台抓；
  ///   · `refreshing` —— 有平台是拿过期缓存顶上的，新值正在后台刷新。
  /// 都不满足说明这份就是刚抓齐的最终答案，到此为止。
  ///
  /// 刻意不看 `age_secs`：新鲜命中时它也大于 0，拿它当判据会让每次进页面
  /// 都白补拉三轮、拿回三份一模一样的数据。
  function scheduleTopUp(gen, page, attempt) {
    if (!page || attempt >= TOPUP_MAX) return;
    var unfinished = !!(page.pending && page.pending.length);
    if (!unfinished && !page.refreshing) return;
    if (topupTimer) clearTimeout(topupTimer);
    topupTimer = setTimeout(function () {
      topupTimer = null;
      if (gen !== generation) return;
      dailyState.onlineBusy = true;
      syncLoading();
      fetchOnline(gen, attempt + 1);
    }, TOPUP_DELAY_MS);
  }

  /// 首次拿到数据后决定默认来源。
  ///
  /// 只在用户**没选过**的时候动手：有已登录的平台就用在线，一个都没有就落到
  /// 本地。用户一旦手动切过，之后再怎么登录/登出都不改他的选择。
  function settleMode() {
    if (dailyState.modePinned) return;
    // 在线那一路还在飞就别急着落位。此刻判「没有登录平台」是猜的，等它回来
    // 又要翻回在线，用户会眼睁睁看着列表从本地整屏跳成在线。
    if (dailyState.onlineBusy) return;
    var ready = dailyState.online && dailyState.online.sources && dailyState.online.sources.length;
    setMode(ready ? 'online' : 'local', false);
  }

  /// 来源变了要告诉宿主一声：曲库那张「还是空的」引导卡只在**本地**来源下成立
  /// （在线来源时本地库为空是常态），宿主自己管那张卡，这里不替它操心 DOM。
  function notifyMode() {
    if (H && typeof H.onDailyModeChange === 'function') {
      H.onDailyModeChange(dailyState.mode);
    }
  }

  function setMode(mode, pinned) {
    dailyState.mode = mode === 'local' ? 'local' : 'online';
    if (pinned !== false) {
      dailyState.modePinned = true;
      writeMode(dailyState.mode);
    }
    render();
    notifyMode();
  }

  /// 当前来源下要显示的那批曲目，统一成界面要的形状。
  function visible() {
    if (dailyState.mode === 'online') {
      var page = dailyState.online;
      if (!page || !page.tracks.length) return [];
      return page.tracks.map(function (t) {
        return {
          id: t.virtual_id,
          title: t.title,
          artist: t.artist,
          album: t.album,
          // 在线曲目带的是平台封面直链，走 Online 的归一化（http → 服务端代理），
          // 不经本地封面通道。
          cover: onlineCover(t.cover),
          // 曲目自身的来源平台。合并歌单里"这首是哪个平台的"必须看得出来，
          // 否则同名曲目来自两个平台时会像重复项。
          note: t.source_label || t.source,
          raw: t,
        };
      });
    }
    var local = dailyState.page;
    if (!local || !local.tracks.length) return [];
    return local.tracks.map(function (item) {
      return {
        id: item.id,
        title: item.title,
        artist: item.artist,
        album: item.album,
        cover: item.has_cover && H.coverUrl ? H.coverUrl(item.id) : null,
        // 推荐理由：服务端把规则算完了直接给出来，界面照抄即可。
        note: (item.reasons || []).join(' · '),
        raw: item,
      };
    });
  }

  function onlineCover(url) {
    if (!url) return null;
    return (window.Online && window.Online.safeCoverUrl)
      ? window.Online.safeCoverUrl(url)
      : url;
  }

  /// 展示位专用的小图地址。
  ///
  /// 推荐位的封面格只有 40px，上游给的却是原图——网易云动辄 300KB，24 张就是
  /// 7MB，插件形态下每一张还要经 sidecar 的 /v1/online/cover 取回 base64。
  /// 「歌名早出来了、封面半天不出现」就是这么来的。90px 小图约 2KB，与在线
  /// 搜索行同一档（见 online.js 的 rowCoverUrl）。
  ///
  /// 只在画卡片时用：`item.cover` 必须保持全尺寸，它会随 playQueue 的元数据
  /// 快照进到正在播放与舞台，那里铺满视口，真需要分辨率。
  function thumb(url) {
    if (!url) return null;
    return (window.Online && window.Online.rowCoverUrl)
      ? window.Online.rowCoverUrl(url, 90)
      : url;
  }

  /// 副标题：一行说清"这批是怎么来的"。
  ///
  /// 被跳过的平台一定要写出来。用户装了两三个平台的账号，只看到一份歌单而
  /// 不知道另一个平台为什么缺席，第一反应是"坏了"；写明"未登录，已跳过"
  /// 就变成了一条可执行的提示。
  /// 这次真正去拉过推荐的平台标签（已登录且支持每日推荐）。
  ///
  /// 后端给的 `ready` 是权威答案；老版本没有这个字段时，从 skipped 里反推：
  /// failed / timeout / empty 都只可能发生在"已经去拉过"的平台上，
  /// 而 not_signed_in / unsupported / unavailable 压根没发起请求。
  function onlineTried(page) {
    if (!page) return [];
    if (page.ready && page.ready.length) return page.ready.slice();
    return page.skipped
      .filter(function (s) {
        // history 是"平台支持，但只给当天"，同样只可能发生在去拉过的平台上。
        return s.kind === 'failed' || s.kind === 'timeout' || s.kind === 'empty'
          || s.kind === 'history';
      })
      .map(function (s) { return s.label; });
  }

  function subtitle() {
    if (dailyState.mode === 'online') {
      var page = dailyState.online;
      if (dailyState.onlineError) {
        // 只报事实，不给红条：本地那一路还在，用户可以自己切过去。
        return '在线推荐没拿到，可切到「本地」；或到「在线」面板检查登录状态';
      }
      if (!page) return '正在汇总各平台每日推荐…';
      if (page.empty) {
        // empty 只说明"一首都没拿到"，成因有两种，文案必须分开：
        // 一个平台都没登录（去登录），还是登录了但这次没取到（再试一次）。
        // 之前一律写成"还没登录"，用户为此白白重新扫码登录了好几遍。
        var tried = onlineTried(page);
        if (tried.length) {
          return tried.join('、') + ' 已登录，但这次没有返回推荐曲目。点刷新再试一次。';
        }
        return '还没有登录任何支持每日推荐的平台。到「在线」面板扫码登录后，这里会自动汇总各平台的每日推荐。';
      }
      var parts = ['已合并 ' + page.total + ' 首'];
      if (page.sources.length) {
        parts.push(page.sources.map(function (s) {
          return s.label + ' ' + s.count + ' 首';
        }).join('、'));
      }
      // pending 与 refreshing 说的是两件不同的事，不能混着说：
      //   pending    —— 这几个平台还在抓，稍后自己补上，用户什么都不用做；
      //   refreshing —— 手上这份是过期缓存顶上的，新值正在后台刷。
      // 都不说的话，用户看到的是一个静止的、比平时少一截的列表，第一反应是
      // 「坏了」，然后去点刷新——而那次刷新其实毫无必要。
      //
      // 刻意不看 age_secs：新鲜命中时它也大于 0，据此说「正在后台更新」是句
      // 假话（什么都没在更新）。而且每日推荐一天才换一次，三分钟前的那份与
      // 刚抓的那份没有区别，不值得占副标题的位置。
      if (page.pending && page.pending.length) {
        parts.push(page.pending.join('、') + ' 还在取，稍后自动补上');
      } else if (page.refreshing) {
        parts.push('这份是 ' + ageText(page.age_secs) + '的，正在后台更新');
      }
      var skips = page.skipped.filter(function (s) {
        // empty / failed / timeout 是"这次没拿到"，说成"已跳过"会让人以为
        // 平台没登录。只有 not_signed_in / unsupported 才是稳定状态。
        return s.kind === 'not_signed_in' || s.kind === 'unsupported';
      }).map(function (s) {
        return s.label + '（' + s.message + '）';
      });
      if (skips.length) parts.push('已跳过：' + skips.join('、'));
      return parts.join(' · ');
    }
    var local = dailyState.page;
    return local && local.total
      ? '按本地规则从你的曲库里挑出 ' + local.total + ' 首'
      : '每天换一批，规则跑在本机';
  }

  function ageText(secs) {
    if (secs < 60) return secs + ' 秒前';
    var mins = Math.round(secs / 60);
    if (mins < 60) return mins + ' 分钟前';
    return Math.round(mins / 60) + ' 小时前';
  }

  function dateLabel() {
    if (dailyState.mode === 'online') {
      return (dailyState.online && dailyState.online.date) || '—';
    }
    return dailyState.page ? dailyState.page.date : '—';
  }

  function renderModes() {
    var group = H.ui.dailyModes;
    if (!group || !group.querySelectorAll) return;
    var btns = group.querySelectorAll('button[data-daily-mode]');
    for (var i = 0; i < btns.length; i += 1) {
      var on = btns[i].getAttribute('data-daily-mode') === dailyState.mode;
      btns[i].classList.toggle('active', on);
      btns[i].setAttribute('aria-pressed', String(on));
    }
  }

  /// 当前来源那一路在不在飞。占位符只看这一路：另一路慢不该让已经有结果
  /// 的这一路也跟着显示「正在挑歌…」。
  function currentBusy() {
    return dailyState.mode === 'online' ? dailyState.onlineBusy : dailyState.localBusy;
  }

  /// 上一次画进 DOM 的那批。补拉常常拿回一模一样的一份（后台刷新完了但内容
  /// 没变），此时重建整墙卡片只会让所有封面重新走一遍解析、闪一下，白折腾。
  var paintedKey = '';

  function render() {
    var host = H.ui.dailyList;
    if (!host) return;

    if (H.ui.dailyDate) H.ui.dailyDate.textContent = dateLabel();
    if (H.ui.dailySub) H.ui.dailySub.textContent = subtitle();
    renderModes();

    var items = visible();
    if (H.ui.dailyPlayAll) H.ui.dailyPlayAll.disabled = !items.length;

    // 空态时把提示文案也算进签名：从「正在挑歌…」换成真正的空态提示，
    // 曲目 id 列表两边都是空的，光看 id 会以为没变化。
    var key = dailyState.mode + '|' + (items.length
      ? items.map(function (i) { return i.id; }).join(',')
      : '#' + (currentBusy() ? 'loading' : emptyHint()));
    if (key === paintedKey) return;
    paintedKey = key;

    host.innerHTML = '';
    if (!items.length) {
      host.innerHTML = '<div class="hint">'
        + (currentBusy() ? '正在挑歌…' : emptyHint()) + '</div>';
      return;
    }
    items.forEach(function (item, index) { host.appendChild(card(item, index)); });
  }

  function emptyHint() {
    if (dailyState.mode === 'online') {
      if (dailyState.onlineError) return '在线推荐暂时没拿到。点刷新再试，或切到「本地」。';
      // 服务端只等一个预算就返回了，慢的平台还在后台抓。这时 empty 是 false
      // （那不是「没有推荐」，是「还没到齐」），但曲目确实一首都还没有。
      var wait = dailyState.online && dailyState.online.pending;
      if (wait && wait.length && !(dailyState.online.tracks || []).length) {
        return wait.join('、') + ' 的推荐还在取，马上就来。';
      }
      if (!dailyState.online || dailyState.online.empty) {
        var tried = onlineTried(dailyState.online);
        if (tried.length) {
          return tried.join('、') + ' 已登录，但这次没有返回推荐曲目。点刷新再试一次。';
        }
        return '还没有登录任何支持每日推荐的平台。到「在线」面板登录后，这里会自动汇总。';
      }
      return '各平台这次都没有返回推荐，点刷新再试一次。';
    }
    // 曲库为空是最常见的原因，写清楚而不是笼统的「暂无推荐」。
    return dailyState.loaded
      ? '曲库里还没有可推荐的曲目，先去「曲库」扫描一个音乐目录。'
      : '暂时没有拿到每日推荐，点刷新再试一次。';
  }

  function card(item, index) {
    var el = document.createElement('button');
    el.className = 'daily-card';
    el.type = 'button';
    el.innerHTML =
      '<span class="daily-cover"></span>' +
      '<span class="daily-copy">' +
        '<span class="daily-name"></span>' +
        '<span class="daily-artist"></span>' +
        // 推荐理由/来源平台排在标题与艺术家**下面**，不是卡片右侧第三列：
        // 一行 5 张时卡片宽度不够再塞一列，标题会被挤成几个省略号。
        '<span class="daily-why"></span>' +
      '</span>';
    el.querySelector('.daily-name').textContent = item.title || '未知曲目';
    el.querySelector('.daily-artist').textContent = item.artist || '未知艺术家';
    el.querySelector('.daily-why').textContent = item.note || '';

    /// 背景图位封面。app.js 的 HertzCovers 在插件形态下把远程地址换成 data URL
  /// （沙箱 CSP 画不出 https 图）；契约检查的沙箱只加载本模块、拿不到它，回落
  /// 成直接赋值——那正是独立形态的同款行为。
  function applyBg(el, url) {
    if (window.HertzCovers) { window.HertzCovers.applyBg(el, url); return; }
    if (el) el.style.backgroundImage = url ? 'url("' + url + '")' : '';
  }

  var cover = el.querySelector('.daily-cover');
  if (item.cover) {
    // 画的是小图，item.cover 本身仍是全尺寸（playQueue 的元数据要用原图）。
    applyBg(cover, thumb(item.cover));
    cover.classList.add('has-art');
  } else {
    cover.classList.add('is-missing');
  }

    el.onclick = function () { playAll(index); };
    return el;
  }

  /// 点一张卡 = 把整份推荐当成一个队列从第 index 首开始播。
  ///
  /// 参考实现的做法一致（`playQueue = songs; currentIdx = index`）：推荐是一个
  /// 整体，点第三首就该从第三首往下走，而不是只播那一首。
  function playAll(index) {
    var items = visible();
    if (!items.length) return;
    var at = Math.max(0, Math.min(items.length - 1, index || 0));
    var ids = items.map(function (i) { return i.id; }).filter(Boolean);
    if (!ids.length) return;

    if (dailyState.mode !== 'online') {
      if (typeof H.playLocal === 'function') H.playLocal(ids[at], ids);
      return;
    }

    // 在线合并歌单是跨平台的，不能用 Online.playAll——那条路只吃单一音源。
    // 走混合队列：虚拟 id 由服务端随响应给出（不必前端猜拼法），元数据快照
    // 一并注入，播放历史与队列视图才有标题可显示。
    var meta = {};
    items.forEach(function (item) {
      if (!item.id) return;
      var t = item.raw;
      meta[item.id] = {
        source: t.source,
        onlineId: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album,
        duration_ms: t.duration_ms,
        cover: item.cover,
        vip_only: !!t.vip_only,
      };
    });
    if (typeof H.playQueue === 'function') H.playQueue(ids, meta, ids[at]);
  }

  function init() {
    // 恢复上次选的来源。没存过就用在线起步，等首次数据到达再决定要不要落到
    // 本地（见 settleMode）——启动时还不知道有没有登录平台。
    var saved = readMode();
    // 存过 'local' 也算"用户选过"，不该被自动落位改掉。
    dailyState.mode = saved === 'local' ? 'local' : 'online';
    dailyState.modePinned = saved === 'online' || saved === 'local';

    if (H.ui.dailyModes && H.ui.dailyModes.querySelectorAll) {
      var btns = H.ui.dailyModes.querySelectorAll('button[data-daily-mode]');
      for (var i = 0; i < btns.length; i += 1) {
        (function (btn) {
          btn.onclick = function () { setMode(btn.getAttribute('data-daily-mode')); };
        })(btns[i]);
      }
    }
    if (H.ui.dailyRefresh) {
      // 刷新按钮必须是 force：加了「当天已有数据就不重取」那道闸之后，
      // 普通的 load() 在这里会变成什么都不做，一个点了没反应的刷新按钮。
      H.ui.dailyRefresh.onclick = function () { load({ force: true }); };
    }
    if (H.ui.dailyPlayAll) {
      H.ui.dailyPlayAll.onclick = function () { playAll(0); };
    }
    render();
    // 这里直接赋值而不是走 setMode：恢复上次选择不该被当成"用户刚选过"
    // 而写进 pinned。但来源确实变了，宿主那边的空态卡仍要跟着落位。
    notifyMode();
  }

  window.Daily = {
    bind: function (host) { H = host; T = window.VMusicTransport; },
    init: init,
    load: load,
    setMode: setMode,
    state: dailyState,
  };
})();
