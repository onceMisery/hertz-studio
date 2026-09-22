// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 每日推荐。
//
// 榜单由服务端按本地规则算出（见 crates/vmusicd/src/daily.rs）：种子是本地
// 日期的天序号，所以同一天无论刷新多少次都是同一份，换一天自然换一批。
// 这里只负责取、画、播三件事——规则一行都不在前端。
(function () {
  'use strict';
  var T = null;
  var H = null; // 宿主：{ ui, state, fmt, toast, errText, playLocal, paintArt, coverUrl }

  var dailyState = {
    loading: false,
    loaded: false,
    page: null,
  };

  async function load(opts) {
    opts = opts || {};
    if (dailyState.loading) return;
    dailyState.loading = true;
    render();
    try {
      dailyState.page = await T.get('/v1/recommend/daily?limit=12');
      dailyState.loaded = true;
    } catch (err) {
      dailyState.page = null;
      // 进页面自动拉的那次失败不弹红：推荐位是锦上添花，不该一进来就报错。
      if (!opts.silent) H.toast(H.errText('每日推荐读取失败', err), 'error');
    } finally {
      dailyState.loading = false;
      render();
    }
  }

  function render() {
    var host = H.ui.dailyList;
    if (!host) return;
    var page = dailyState.page;

    if (H.ui.dailyDate) {
      H.ui.dailyDate.textContent = page ? page.date : '—';
    }
    if (H.ui.dailySub) {
      H.ui.dailySub.textContent = page && page.total
        ? '按本地规则从你的曲库里挑出 ' + page.total + ' 首'
        : '每天换一批，规则跑在本机';
    }
    if (H.ui.dailyPlayAll) H.ui.dailyPlayAll.disabled = !(page && page.total);

    host.innerHTML = '';
    if (dailyState.loading) {
      host.innerHTML = '<div class="hint">正在挑歌…</div>';
      return;
    }
    if (!page || !page.total) {
      // 曲库为空是最常见的原因，写清楚而不是笼统的「暂无推荐」。
      host.innerHTML = '<div class="hint">'
        + (dailyState.loaded
          ? '曲库里还没有可推荐的曲目，先去「曲库」扫描一个音乐目录。'
          : '暂时没有拿到每日推荐，点刷新再试一次。')
        + '</div>';
      return;
    }
    page.tracks.forEach(function (item, index) { host.appendChild(card(item, index)); });
  }

  function card(item, index) {
    var track = item.track || {};
    var el = document.createElement('button');
    el.className = 'daily-card';
    el.type = 'button';
    el.innerHTML =
      '<span class="daily-cover"></span>' +
      '<span class="daily-copy">' +
        '<span class="daily-name"></span>' +
        '<span class="daily-artist"></span>' +
      '</span>' +
      '<span class="daily-why"></span>';
    el.querySelector('.daily-name').textContent = track.title || '未知曲目';
    el.querySelector('.daily-artist').textContent = track.artist || '未知艺术家';
    // 推荐理由：服务端把规则算完了直接给出来，界面照抄即可。
    el.querySelector('.daily-why').textContent = (item.reasons || []).join(' · ');

    var cover = el.querySelector('.daily-cover');
    if (track.has_cover && H.coverUrl) {
      cover.style.backgroundImage = 'url("' + H.coverUrl(track.id) + '")';
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
    var page = dailyState.page;
    if (!page || !page.tracks.length) return;
    var ids = page.tracks.map(function (i) { return i.track && i.track.id; }).filter(Boolean);
    if (!ids.length) return;
    if (typeof H.playLocal === 'function') {
      H.playLocal(ids[Math.max(0, Math.min(ids.length - 1, index || 0))], ids);
    }
  }

  function init() {
    if (H.ui.dailyRefresh) {
      H.ui.dailyRefresh.onclick = function () { load(); };
    }
    if (H.ui.dailyPlayAll) {
      H.ui.dailyPlayAll.onclick = function () { playAll(0); };
    }
    render();
  }

  window.Daily = {
    bind: function (host) { H = host; T = window.VMusicTransport; },
    init: init,
    load: load,
    state: dailyState,
  };
})();
