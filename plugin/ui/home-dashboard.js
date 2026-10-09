// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
(function (global) {
  'use strict';
  var host = null, el = null, recent = null, recentIntent = -1;
  var historyEpoch = 0, historyStatus = 'idle', artKey = '', actionEpoch = 0, acting = false;

  function present(snapshot) {
    var track = snapshot.current;
    if (track) return { action: snapshot.playing ? 'queue' : 'resume', track: track,
      label: snapshot.playing ? '查看队列' : '继续播放',
      status: snapshot.playing ? '正在播放' : '接着上次的位置听', title: track.title || '当前曲目',
      detail: track.artist || '当前播放队列' };
    if (snapshot.queueLength) return { action: 'queue', label: '查看队列', status: '播放队列已保留',
      title: '选一首，继续听', detail: snapshot.queueLength + ' 首歌曲在队列中' };
    if (recent && recentIntent === snapshot.intent) return { action: 'recent', track: recent,
      label: '播放最近一首', status: '最近听过', title: recent.title || '最近播放的歌曲',
      detail: recent.artist || '重新播放这一首' };
    return { action: historyStatus === 'ready' ? 'add' : 'library',
      label: historyStatus === 'ready' ? '添加音乐' : '去曲库', status: '开始聆听',
      title: '从喜欢的音乐开始', detail: historyStatus === 'loading' ? '正在读取最近播放…'
        : historyStatus === 'error' ? '最近播放暂时无法读取，可先浏览曲库'
          : '选择本地目录，或浏览已有曲库' };
  }

  function text(node, value) { if (node.textContent !== value) node.textContent = value; }

  // 与 app.js 的 paintArt 同一份哈希：占位色相按曲目 id 稳定取值，
  // 首页卡片与曲库那一行的「没有封面」才是同一个颜色。
  function hueOf(seed) {
    var h = 0;
    for (var i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 360;
    return String(h);
  }

  function update(force) {
    if (!host || !el) return;
    var snapshot = host.read(), model = present(snapshot);
    text(el.status, model.status); text(el.detail, model.detail);
    // 曲名与歌手不再常驻（封面左置后，歌名只在悬停/聚焦时从封面浮出）。
    // 但**必须有一行常驻兜底**，否则默认状态下读不到"现在在放什么"，
    // 而触屏根本没有 hover。所以状态行右侧带一句「曲名 - 歌手」，
    // 没有当前曲目时整段隐藏（不占位、不留「undefined」）。
    //
    // ⚠ 每个写入都要判空：这个函数被 check-home-dashboard.js 拿 vm 沙箱跑，
    //   那边用 makeEl() 造的 fixture 只认脚本里 getElementById 过的那些 id。
    //   直接 el.track.hidden = … 会在缺节点时抛 TypeError，把整条契约崩掉
    //   （症状是「契约脚本 TypeError」，看起来像产品坏了，其实是探针没喂依赖）。
    if (model.track) {
      if (el.track) {
        el.track.hidden = false;
        var line = model.track.title || '当前曲目';
        if (model.track.artist) line += ' - ' + model.track.artist;
        text(el.track, line);
      }
    } else if (el.track) {
      el.track.hidden = true;
    }
    // 封面浮层是同一份信息的第二个出口（指针/键盘下才出现），
    // 必须在换歌时一起更新 —— 否则浮出会露出上一首的歌名。
    if (el.tipTitle) {
      text(el.tipTitle, model.track ? (model.track.title || '当前曲目') : '未在播放');
      text(el.tipArtist, model.track ? (model.track.artist || '') : '');
    }
    text(el.action, snapshot.pending || acting ? '正在更新播放…' : model.label);
    el.action.disabled = !!snapshot.pending || acting;
    el.action.dataset.action = model.action;
    el.retry.hidden = historyStatus !== 'error' || !!snapshot.current || !!snapshot.queueLength;
    el.daily.hidden = snapshot.dailyVisible === false;
    el.recent.hidden = snapshot.recentVisible === false;
    var track = model.track;
    var nextKey = track ? [track.id, track.cover || '', !!track.has_cover].join('|') : '';
    // force：封面字节换了但封面键没变（给已有封面的曲子再换一张），
    // 不强制就永远停在旧图上。
    if (!force && nextKey === artKey) return;
    var oldId = el.art.dataset.trackId || '';
    artKey = nextKey;
    el.art.dataset.trackId = track ? track.id : '';
    if (track) el.wrap.style.setProperty('--ph', hueOf(track.id));
    else el.wrap.style.removeProperty('--ph');
    // 换曲先撤下旧图并作废旧解码；同曲新封面仍由共享封面owner解码后提交。
    if (!track || oldId !== track.id) host.applyCover(el.art, '');
    if (!track) return;
    Promise.resolve(host.cover(track)).then(function (url) {
      if (nextKey === artKey) host.applyCover(el.art, url || '');
    }, function () { if (nextKey === artKey) host.applyCover(el.art, ''); });
  }

  async function refreshRecent() {
    if (!host || !el) return;
    var snapshot = host.read();
    if (snapshot.current || snapshot.queueLength) { update(); return; }
    var epoch = ++historyEpoch, intent = snapshot.intent;
    historyStatus = 'loading'; recent = null; update();
    try {
      var item = await host.readRecent();
      if (epoch !== historyEpoch) return;
      var current = host.read();
      if (current.intent !== intent || current.current || current.queueLength) {
        historyStatus = 'idle'; return;
      }
      recent = item; recentIntent = intent; historyStatus = 'ready';
    } catch (_) {
      if (epoch === historyEpoch) historyStatus = host.read().intent === intent ? 'error' : 'idle';
    } finally { if (epoch === historyEpoch) update(); }
  }

  async function activate() {
    var snapshot = host.read();
    if (snapshot.pending || acting) return;
    var model = present(snapshot), epoch = ++actionEpoch;
    acting = true; update();
    try {
      // 点击时重读权威快照，播放中的主入口始终导航，绝不反向暂停。
      if (model.action === 'resume') await host.resume();
      else if (model.action === 'recent') await host.playRecent(model.track);
      else await host.navigate(model.action);
    } catch (_) {
      if (epoch === actionEpoch) host.notify('操作未完成，请重试');
    }
    if (epoch === actionEpoch) acting = false;
    update();
  }

  async function navigate(name) {
    try { await host.navigate(name); }
    catch (_) { host.notify('页面暂时无法打开，请重试'); }
  }

  function bind(nextHost) {
    if (host) return;
    var root = document.getElementById('home-dashboard');
    if (!root) return;
    host = nextHost;
    var find = function (id) { return document.getElementById(id); };
    el = { root: root, art: find('home-art'), wrap: find('home-art-wrap'),
      status: find('home-status'), track: find('home-track'),
      detail: find('home-detail'), action: find('home-action'), retry: find('home-retry'),
      daily: find('home-daily'), recent: find('home-recent'),
      tipTitle: find('home-tip-title'), tipArtist: find('home-tip-artist') };
    el.action.addEventListener('click', activate);
    el.retry.addEventListener('click', refreshRecent);
    // 封面浮层里的歌名/歌手：与状态行同源，改一处两处都要跟。
    if (el.tipTitle) {
      el.tipTitle.textContent = '—';
      el.tipArtist.textContent = '';
    }
    ['library', 'daily', 'recent'].forEach(function (name) {
      find('home-' + name).addEventListener('click', function () { return navigate(name); });
    });
    update();
  }
  global.HomeDashboard = { bind: bind, update: update, onViewEnter: refreshRecent };
}(window));
