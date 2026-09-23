// SPDX-License-Identifier: MIT
//
// 在线曲库：音源清单、搜索/分类浏览、All 聚合、整盘试听。
//
// 搜索/分类走服务端代理（第三方音乐接口没有 CORS 头）；试听则是服务端把远程
// 音频落盘缓存后，用 `online:<source>:<id>` 这个虚拟 id 走一遍和本地曲目完全
// 相同的 load 链路——快照、进度条、舞台因此全部复用，无需第二套状态机。
//
// app.js 在启动时先 bind() 注入宿主依赖（ui/state/渲染工具），再 init()。
(function () {
  'use strict';
  var T = null; // app.js 的 VMusicTransport 在本脚本之后才挂到 window，
                // 所以不能在 IIFE 顶层抓，bind() 时（app 启动序列里）再取。
  var H = null; // 宿主：{ ui, state, setStateQueue, applyQueue, paintArt,
                //       probeImage, fmt, toast, errText }

  // 本文件内没有全局 $；个人区新增元素直接按 id 取，不经 H.ui。
  function $(id) { return document.getElementById(id); }

  var onlineState = {
    source: 'netease',
    q: '',
    cat: 'hot',
    tracks: [],
    total: 0,
    loading: false,
    // All 聚合时为 true：点击单曲只播那一首（跨源曲目不能整成一个队列）。
    aggregate: false,
    // 音源清单由 /v1/online/sources 填；拉不到时下拉框保持 index.html 的静态项。
    sources: [],
  };

  // 虚拟曲目的元数据。本地曲库里查不到这些 id，宿主的「正在播放」逻辑会回落
  // 到这里（getMeta）。
  var onlineMeta = new Map();

  // 平台徽标色。音源 id 以后端注册表为准，这里只负责显示。
  // 汽水的品牌薄荷绿取自官方客户端的主题色；它此前缺了这一条，结果降级成
  // 裸文本「qishui」——既没有品牌色也没有胶囊形状，看着像没做完的占位符。
  var SOURCE_BADGE = {
    netease: ['网易', '#e60026'],
    qq: ['QQ', '#12b7f5'],
    kugou: ['酷狗', '#2ca5f0'],
    qishui: ['汽水', '#45d68f'],
  };

  function sourceLabel(id) {
    var info = onlineState.sources.find(function (s) { return s.id === id; });
    return (info && info.label) || id;
  }

  function badge(source) {
    var b = sourceBadge(source);
    var s = document.createElement('span');
    s.className = 'src-badge';
    // 未登记的音源不该漏出裸 id：短名兜到服务端给的 label，品牌色兜到主题色。
    if (!b) {
      s.textContent = sourceLabel(source);
      return s;
    }
    s.textContent = b.text;
    s.style.setProperty('--badge', b.color);
    return s;
  }

  // 平台徽标短名与品牌色；未登记的音源回 null。
  //
  // 这是徽标信息的唯一事实源：online-playlists.js 的歌单菜单也来问这里，
  // 避免两张表漂移后同一个音源在搜索结果与歌单菜单里长得不一样。
  function sourceBadge(source) {
    var b = SOURCE_BADGE[source];
    return b ? { text: b[0], color: b[1] } : null;
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

  // 直接复用曲库行的 .track 栅格与子元素类名，在线结果因此和本地曲库长得一样。
  // activate 由调用方给：搜索结果页用「整盘入队」，歌单抽屉用「整盘详情入队」，
  // 标记/置灰/VIP 闸门在这里统一做，调用方只管激活后干什么。
  function buildRow(track, activate) {
    var row = document.createElement('div');
    // VIP 专享或无试听地址：整行置灰。只禁用按钮不够，行点击也必须失效——
    // 红线是不模拟会员权益，VIP 曲目绝不偷偷播。
    var disabled = !track.playable || track.vip_only;
    row.className = 'track online-row' + (disabled ? ' is-disabled' : '');
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
    H.paintArt(row, safeCoverUrl(track.cover));

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

    var btn = row.querySelector('[data-act="preview"]');
    btn.disabled = disabled;
    btn.title = track.vip_only
      ? '该曲目为 VIP 专享'
      : (track.playable ? '在线试听' : '该音源没有可用的试听地址');

    btn.onclick = function (e) { e.stopPropagation(); activate(); };
    row.addEventListener('click', activate);
    return row;
  }

  function onlineRow(track) {
    return buildRow(track, function () {
      if (track.vip_only) {
        H.toast('该曲目为 VIP 专享');
        return;
      }
      if (!track.playable) return;
      // All 视图是跨源拼接的结果，只能单曲播；单源视图整盘入队，点第几首
      // 就从第几首开始（后端队列与高亮都以同一批虚拟 id 为准）。
      if (onlineState.aggregate) {
        playAll([track], 0);
      } else {
        var idx = onlineState.tracks.indexOf(track);
        playAll(onlineState.tracks, idx < 0 ? 0 : idx);
      }
    });
  }

  function renderOnline() {
    var body = H.ui.onlineBody;
    if (!body) return;
    body.innerHTML = '';
    if (onlineState.loading) {
      body.innerHTML = '<div class="hint">正在连接音源…</div>';
      return;
    }
    if (!onlineState.tracks.length) {
      // 切源/清空后计数不能留着上一源的数字（如网易云 63 首 → QQ 空结果）。
      if (H.ui.onlineCount) H.ui.onlineCount.textContent = '0 首';
      body.innerHTML = onlineState.aggregate
        ? '<div class="hint">没有找到结果。换个关键词试试。</div>'
        : '<div class="hint">没有找到结果。换个关键词，或确认服务器可以访问外网。</div>';
      return;
    }
    onlineState.tracks.forEach(function (t) { body.appendChild(onlineRow(t)); });
    if (H.ui.onlineCount) H.ui.onlineCount.textContent = onlineState.total + ' 首';
  }

  // 单源搜索/分类浏览。
  async function searchOnline(opts) {
    opts = opts || {};
    var body = H.ui.onlineBody;
    if (!body) return;
    onlineState.aggregate = false;
    onlineState.loading = true;
    if (H.ui.onlineSentinel) H.ui.onlineSentinel.hidden = false;
    renderOnline();
    try {
      var params = new URLSearchParams({ source: onlineState.source, limit: '30' });
      if (onlineState.q.trim()) params.set('q', onlineState.q.trim());
      else if (onlineState.cat) params.set('cat', onlineState.cat);
      var page = await T.get('/v1/online/search?' + params.toString());
      onlineState.tracks = page.tracks || [];
      onlineState.total = page.total != null ? page.total : onlineState.tracks.length;
      cacheTracks(onlineState.tracks);
      if (page.warning && !opts.silent) H.toast(page.warning);
    } catch (err) {
      onlineState.tracks = [];
      onlineState.total = 0;
      // silent 预取（进页面自动拉一屏）失败不弹 toast 吓人；用户主动
      // 搜索/点分类的失败照常如实报错。
      if (!opts.silent) H.toast(H.errText('在线搜索失败', err), 'error');
    } finally {
      onlineState.loading = false;
      if (H.ui.onlineSentinel) H.ui.onlineSentinel.hidden = true;
      renderOnline();
    }
  }

  // All 聚合：按源分组渲染，失败的源单独挂降级提示，绝不把失败吞成空分组。
  async function searchAll(opts) {
    opts = opts || {};
    var body = H.ui.onlineBody;
    if (!body) return;
    onlineState.aggregate = true;
    onlineState.loading = true;
    if (H.ui.onlineSentinel) H.ui.onlineSentinel.hidden = false;
    body.innerHTML = '<div class="hint">正在聚合各音源…</div>';
    var agg;
    try {
      agg = await T.get('/v1/online/search/all?q=' + encodeURIComponent(onlineState.q.trim())
        + '&limit=20');
    } catch (err) {
      onlineState.tracks = [];
      onlineState.total = 0;
      onlineState.loading = false;
      if (H.ui.onlineSentinel) H.ui.onlineSentinel.hidden = true;
      H.toast(H.errText('聚合搜索失败', err), 'error');
      renderOnline();
      return;
    }
    onlineState.loading = false;
    if (H.ui.onlineSentinel) H.ui.onlineSentinel.hidden = true;
    body.innerHTML = '';

    var flat = [];
    var total = 0;
    (agg.results || []).forEach(function (page) {
      var tracks = page.tracks || [];
      if (!tracks.length) return;
      var head = document.createElement('div');
      head.className = 'all-group-head';
      head.appendChild(badge(page.source));
      head.appendChild(document.createTextNode(' · ' + page.total + ' 首'));
      body.appendChild(head);
      tracks.forEach(function (t) {
        body.appendChild(onlineRow(t));
        flat.push(t);
      });
      total += page.total;
      if (page.warning && !opts.silent) {
        var w = document.createElement('div');
        w.className = 'all-failed';
        w.textContent = sourceLabel(page.source) + '：' + page.warning;
        body.appendChild(w);
      }
    });
    (agg.failed || []).forEach(function (f) {
      var d = document.createElement('div');
      d.className = 'all-failed';
      d.textContent = sourceLabel(f.source) + ' 暂时不可用：' + f.message;
      body.appendChild(d);
    });

    onlineState.tracks = flat;
    onlineState.total = total;
    cacheTracks(flat);
    if (H.ui.onlineCount) H.ui.onlineCount.textContent = total + ' 首';
    if (!flat.length && !(agg.failed || []).length) {
      body.innerHTML = '<div class="hint">没有找到结果。换个关键词试试。</div>';
    }
  }

  function search(opts) {
    if (onlineState.source === 'all') {
      // 聚合只支持关键词：空查询不发请求，直接给提示。
      if (!onlineState.q.trim()) {
        onlineState.aggregate = true;
        onlineState.tracks = [];
        onlineState.total = 0;
        renderOnline();
        H.ui.onlineBody.innerHTML = '<div class="hint">All 聚合搜索需要输入关键词。</div>';
        return;
      }
      return searchAll(opts);
    }
    return searchOnline(opts);
  }

  function cacheTracks(tracks) {
    tracks.forEach(function (t) {
      onlineMeta.set(virtualId(t), {
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
  async function playAll(tracks, index) {
    if (!tracks || !tracks.length) return;
    index = index || 0;
    var source = tracks[0].source;
    H.ui.playpause.classList.add('is-loading');
    var res;
    try {
      res = await T.post('/v1/online/play', {
        source: source,
        tracks: tracks.map(function (t) {
          return {
            id: t.id,
            title: t.title,
            artist: t.artist,
            album: t.album,
            duration_ms: t.duration_ms,
            cover: t.cover,
            ref: t.ref || {},
          };
        }),
        index: index,
      });
    } catch (err) {
      H.toast(H.errText('试听失败', err), 'error');
      H.ui.playpause.classList.remove('is-loading');
      return;
    }
    H.ui.playpause.classList.remove('is-loading');

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
      onlineMeta.set(ids[i], meta);
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
    if (window.Stage && meta) window.Stage.setTrack(meta, cover);
    if (meta) H.toast('试听《' + meta.title + '》');

    // 封面加载不出来就撤掉改用占位图，不留一个永不显示的背景。
    if (cover && !(await H.probeImage(cover))) {
      if (meta) meta.cover = null;
      paintNowPlaying(meta, null);
      if (window.Stage && meta) window.Stage.setTrack(meta, null);
    }
    loadOnlineLyrics(meta);
  }

  // 在线歌词：接口无数据/无权限都按无歌词处理；网络错误也只是不显示歌词，
  // 不打断播放。
  async function loadOnlineLyrics(meta) {
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
    if (H.state.current && H.state.current.id === meta.id && window.Stage) {
      window.Stage.setLyrics(doc && doc.lines && doc.lines.length ? doc : null);
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
        onlineMeta.set(track.id, meta);
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
    var url = coverUrl || safeCoverUrl(track.cover);
    if (H.ui.ambient) {
      H.ui.ambientImg.style.backgroundImage = url ? 'url("' + url + '")' : 'none';
      H.ui.ambient.classList.toggle('has-art', Boolean(url));
    }
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

  async function loadHistory() {
    var host = $('op-history');
    if (!host) return;
    var list = $('op-history-list');
    if (!list) return;
    // 清空按钮每次渲染重新绑定（元素与区块同在，这里绑一定拿得到）。
    var clearBtn = $('op-history-clear');
    if (clearBtn) {
      clearBtn.onclick = async function () {
        try {
          await T.delete('/v1/history');
          loadHistory();
        } catch (e) {
          H.toast('清空失败', 'error');
        }
      };
    }
    var data;
    try {
      data = await T.get('/v1/history?limit=20');
    } catch (e) {
      host.hidden = true;
      return;
    }
    var items = (data && data.items) || [];
    host.hidden = items.length === 0;
    list.textContent = '';
    items.forEach(function (it) {
      var row = document.createElement('div');
      row.className = 'op-history-item';

      var cover = document.createElement('div');
      cover.className = 'op-h-cover';
      if (it.cover_url) {
        cover.style.backgroundImage = 'url("' + safeCoverUrl(it.cover_url) + '")';
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

      var src = document.createElement('span');
      src.className = 'op-h-src';
      src.textContent = it.source === 'local' ? '本地' : sourceLabel(it.source);

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
          await T.delete('/v1/history/' + it.id);
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

  function initOnline() {
    if (H.ui.onlineGo) {
      H.ui.onlineGo.onclick = function () {
        onlineState.q = H.ui.onlineQ.value || '';
        search();
      };
    }
    if (H.ui.onlineQ) {
      H.ui.onlineQ.onkeydown = function (e) {
        if (e.key === 'Enter') {
          onlineState.q = H.ui.onlineQ.value || '';
          search();
        }
      };
    }
    if (H.ui.onlineSource) {
      H.ui.onlineSource.onchange = function () {
        onlineState.source = H.ui.onlineSource.value;
        // All 是音源维度的聚合项：没有分类，也不自动拉取（需要关键词）。
        if (onlineState.source === 'all') {
          renderSourceCaps();
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
    renderOnline();
    loadSources();
    loadHistory();
  }

  // 音源清单由服务端给出（/v1/online/sources）。写死 HTML 会漏掉分类和能力位。
  async function loadSources() {
    var data = await T.get('/v1/online/sources').catch(function () { return null; });
    onlineState.sources = (data && data.sources) || [];
    refreshCookieUi();
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
    safeCoverUrl: safeCoverUrl,
    fetchCover: fetchOnlineCover,
    loadLyricDoc: loadOnlineLyricDoc,
    loadLyrics: loadOnlineLyrics,
    paintNowPlaying: paintNowPlaying,
    sourceLabel: sourceLabel,
    sourceBadge: sourceBadge,
  };
})();
