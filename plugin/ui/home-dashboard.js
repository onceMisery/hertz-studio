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

  function update() {
    if (!host || !el) return;
    var snapshot = host.read(), model = present(snapshot);
    text(el.status, model.status); text(el.title, model.title); text(el.detail, model.detail);
    text(el.action, snapshot.pending || acting ? '正在更新播放…' : model.label);
    el.action.disabled = !!snapshot.pending || acting;
    el.action.dataset.action = model.action;
    el.retry.hidden = historyStatus !== 'error' || !!snapshot.current || !!snapshot.queueLength;
    el.daily.hidden = snapshot.dailyVisible === false;
    el.recent.hidden = snapshot.recentVisible === false;
    var track = model.track;
    var nextKey = track ? [track.id, track.cover || '', !!track.has_cover].join('|') : '';
    if (nextKey === artKey) return;
    var oldId = el.art.dataset.trackId || '';
    artKey = nextKey;
    el.art.dataset.trackId = track ? track.id : '';
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
    el = { root: root, art: find('home-art'), status: find('home-status'), title: find('home-title'),
      detail: find('home-detail'), action: find('home-action'), retry: find('home-retry'),
      daily: find('home-daily'), recent: find('home-recent') };
    el.action.addEventListener('click', activate);
    el.retry.addEventListener('click', refreshRecent);
    ['library', 'daily', 'recent'].forEach(function (name) {
      find('home-' + name).addEventListener('click', function () { return navigate(name); });
    });
    update();
  }
  global.HomeDashboard = { bind: bind, update: update, onViewEnter: refreshRecent };
}(window));
