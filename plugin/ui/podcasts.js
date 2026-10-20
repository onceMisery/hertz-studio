// SPDX-License-Identifier: MIT
// Podcast discovery and subscriptions. Playback remains owned by Online/AppState.
(function () {
  'use strict';
  var H, T, bound = false;
  var st = { tab: 'discover', shows: [], subscriptions: [], show: null,
    episodes: [], total: 0, limit: 0, offset: 0, more: false, epoch: 0, busy: false };
  var importing = false, changingSubscription = false;
  var subscriptionsRequest = 0;
  var subscriptionRevisions = new Map();
  var PAGE = 50;
  var COUNTRY_KEY = 'hertz.podcasts.country';
  var activeEpisode = null, progressWrite = Promise.resolve();
  var pendingResume = null, observedTrackId = null;
  function el(id) { return document.getElementById(id); }
  function node(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }
  function status(text, error) {
    el('podcast-status').textContent = text || '';
    el('podcast-status').classList.toggle('is-error', !!error);
  }
  function failure(prefix, error) { status(prefix + '：' + (error && error.message || '请求失败，请重试'), true); }
  function cover(url) {
    var box = node('span', 'podcast-cover');
    box.appendChild(node('span', 'podcast-cover-placeholder', '声'));
    if (url) {
      var safe = window.Online ? Online.safeCoverUrl(url) : null;
      if (!safe) {
        try { var u = new URL(url); if (u.protocol === 'https:' || u.protocol === 'http:') safe = u.href; }
        catch (_) { /* Keep the placeholder. */ }
      }
      if (safe) {
        var img = node('img'); img.alt = ''; img.loading = 'lazy';
        img.onload = function () { box.classList.add('has-image'); };
        img.onerror = function () { img.hidden = true; box.classList.remove('has-image'); };
        if (window.HertzCovers) HertzCovers.applyImg(img, safe); else img.src = safe;
        box.appendChild(img);
      }
    }
    return box;
  }
  function duration(ms) {
    var sec = Math.floor(Number(ms || 0) / 1000);
    if (!(sec > 0)) return '时长未知';
    var s = String(sec % 60).padStart(2, '0'), m = Math.floor(sec / 60);
    return m >= 60 ? Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') + ':' + s : m + ':' + s;
  }
  function dateText(value) {
    var date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN');
  }
  function panels() {
    el('podcast-browse').hidden = !!st.show;
    el('podcast-detail').hidden = !st.show;
    document.querySelectorAll('[data-podcast-tab]').forEach(function (button) {
      var active = button.dataset.podcastTab === st.tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }
  function renderShows() {
    panels();
    var list = st.tab === 'subscriptions' ? st.subscriptions : st.shows;
    var grid = el('podcast-results');
    grid.replaceChildren();
    list.forEach(function (show) {
      var button = node('button', 'podcast-show'); button.type = 'button';
      button.appendChild(cover(show.cover));
      var copy = node('span', 'podcast-show-copy');
      copy.appendChild(node('strong', '', show.title));
      copy.appendChild(node('span', 'podcast-author', show.author || '独立播客'));
      copy.appendChild(node('span', 'podcast-count', show.episode_count ? show.episode_count + ' 期节目' : '查看单集'));
      button.appendChild(copy);
      button.onclick = function () { openShow(show); };
      grid.appendChild(button);
    });
    el('podcast-empty').hidden = list.length > 0 || st.busy;
    el('podcast-empty-title').textContent = st.tab === 'subscriptions' ? '收藏你的常听节目' : '从一个感兴趣的节目开始';
    el('podcast-empty-text').textContent = st.tab === 'subscriptions'
      ? '搜索节目并订阅，或添加发布者提供的公开 RSS 地址。'
      : el('podcast-query').value.trim() ? '没有找到相关节目，换个节目名、主播名或目录地区试试。' : '搜索节目名或主播名，也可以添加公开 RSS。';
    var suggestions = el('podcast-country').value === 'CN'
      ? ['故事FM', '忽左忽右', '声东击西'] : ['Planet Money', 'Global News Podcast', 'TED Talks Daily'];
    document.querySelectorAll('[data-podcast-query]').forEach(function (button, index) {
      button.dataset.podcastQuery = suggestions[index];
      button.textContent = suggestions[index];
    });
    el('podcast-suggestions').hidden = st.tab === 'subscriptions';
  }
  async function refreshSubscriptions() {
    var mine = st.epoch, request = ++subscriptionsRequest;
    try {
      var data = await T.get('/v1/podcasts/subscriptions');
      if (request !== subscriptionsRequest) return;
      st.subscriptions = data.shows || [];
      if (mine === st.epoch && !st.show) renderShows();
    } catch (error) { if (request === subscriptionsRequest && mine === st.epoch && !st.show) failure('订阅加载失败', error); }
  }
  async function search(query) {
    query = String(query || '').trim();
    if (!query) { status('请输入节目名或主播名'); return; }
    var mine = ++st.epoch;
    st.tab = 'discover'; st.show = null; st.busy = true; st.shows = [];
    el('podcast-query').value = query;
    renderShows(); status('正在搜索节目…');
    try {
      var data = await T.get('/v1/podcasts/search?q=' + encodeURIComponent(query) + '&limit=30'
        + '&country=' + encodeURIComponent(el('podcast-country').value));
      if (mine !== st.epoch) return;
      st.shows = data.shows || [];
      status(st.shows.length ? '找到 ' + st.shows.length + ' 个节目 · 目录由 Apple Podcasts 提供' : '没有找到节目');
    } catch (error) { if (mine === st.epoch) failure('搜索失败', error); }
    finally {
      if (mine === st.epoch) { st.busy = false; renderShows(); }
    }
  }
  function renderDetail() {
    if (!st.show) return;
    panels();
    el('podcast-show-cover').replaceChildren(cover(st.show.cover));
    el('podcast-show-title').textContent = st.show.title;
    el('podcast-show-author').textContent = st.show.author || '独立播客';
    el('podcast-show-description').textContent = st.show.description || '这个节目暂未提供简介。';
    el('podcast-subscribe').textContent = st.show.subscribed ? '取消订阅' : '订阅节目';
    el('podcast-subscribe').disabled = changingSubscription;
    el('podcast-episode-count').textContent = st.total ? '已收录 ' + st.total + ' 期 · 已加载 ' + st.episodes.length + ' 期' : '单集';
    var atCapacity = st.limit > 0 && st.total >= st.limit;
    el('podcast-capacity').hidden = !atCapacity;
    el('podcast-capacity').textContent = atCapacity
      ? '本栏目每个节目最多收录 ' + st.limit + ' 期。更多单集请前往原平台查看。' : '';
    el('podcast-play-loaded').disabled = !st.episodes.length;
    var rows = el('podcast-episodes');
    rows.replaceChildren();
    st.episodes.forEach(function (episode, index) {
      var row = node('article', 'podcast-episode');
      row.dataset.episodeId = episode.id;
      var copy = node('div', 'podcast-episode-copy');
      copy.appendChild(node('span', 'podcast-episode-meta',
        [dateText(episode.published_at), duration(episode.duration_ms)].filter(Boolean).join(' · ')));
      var play = node('button', 'podcast-episode-play', episode.title);
      play.type = 'button'; play.disabled = !episode.playable;
      play.setAttribute('aria-label', '播放：' + episode.title);
      play.onclick = function () { playAt(index); };
      copy.appendChild(play);
      if (episode.completed) {
        copy.appendChild(node('span', 'podcast-episode-progress', '已听完'));
      } else if (episode.progress_ms > 0) {
        copy.appendChild(node('span', 'podcast-episode-progress', '继续收听 · ' + duration(episode.progress_ms)));
      }
      if (episode.description) {
        var detail = node('details', 'podcast-episode-description');
        detail.appendChild(node('summary', '', '单集简介'));
        detail.appendChild(node('p', '', episode.description));
        copy.appendChild(detail);
      }
      row.appendChild(copy); rows.appendChild(row);
    });
    el('podcast-more').hidden = !st.more;
    el('podcast-more').disabled = st.busy;
    el('podcast-feed-refresh').disabled = st.busy;
  }
  function updateEpisodeProgress(episode) {
    var rows = el('podcast-episodes').children;
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      if (row.dataset.episodeId !== episode.id) continue;
      var copy = row.querySelector('.podcast-episode-copy');
      var badge = copy.querySelector('.podcast-episode-progress');
      var label = episode.completed ? '已听完'
        : episode.progress_ms > 0 ? '继续收听 · ' + duration(episode.progress_ms) : '';
      if (!label) {
        if (badge) badge.remove();
      } else if (badge) {
        badge.textContent = label;
      } else {
        badge = node('span', 'podcast-episode-progress', label);
        var description = copy.querySelector('.podcast-episode-description');
        copy.insertBefore(badge, description || null);
      }
      return;
    }
  }
  async function loadEpisodes(reset, force) {
    if (!st.show || st.busy) return;
    var mine = st.epoch, show = st.show;
    var subscriptionRevision = subscriptionRevisions.get(show.id) || 0;
    var offset = reset ? 0 : st.offset;
    st.busy = true;
    renderDetail(); status(force ? '正在刷新节目…' : '正在加载单集…');
    try {
      var data = await T.get('/v1/podcasts/feed?url=' + encodeURIComponent(show.feed_url)
        + '&limit=' + PAGE + '&offset=' + offset + '&refresh=' + !!force);
      if (mine !== st.epoch) return;
      if (subscriptionRevision !== (subscriptionRevisions.get(show.id) || 0)) {
        data.show.subscribed = st.show.subscribed;
      }
      st.show = data.show;
      if (reset) st.episodes = [];
      var page = data.episodes || [], seen = new Set(st.episodes.map(function (e) { return e.id; }));
      page.forEach(function (episode) { if (!seen.has(episode.id)) { seen.add(episode.id); st.episodes.push(episode); } });
      st.offset = offset + page.length; st.total = data.total || 0;
      st.limit = Number(data.episode_limit) || 0;
      st.more = page.length > 0 && st.offset < st.total;
      status(st.episodes.length ? '' : '这个订阅源还没有可播放的单集');
    } catch (error) { if (mine === st.epoch) failure('单集加载失败，可点击刷新重试', error); }
    finally { if (mine === st.epoch) { st.busy = false; renderDetail(); } }
  }
  function openShow(show) {
    ++st.epoch; st.show = show; st.busy = false;
    st.episodes = []; st.offset = 0; st.total = 0; st.limit = 0; st.more = false;
    return loadEpisodes(true, false);
  }
  async function playAt(index) {
    var playable = st.episodes.filter(function (episode) { return episode.playable; });
    var selected = st.episodes[index];
    var position = playable.indexOf(selected);
    if (position < 0) return;
    var resume = !selected.completed && selected.progress_ms >= 5_000
      ? { id: selected.id, previousTrackId: observedTrackId, position_ms: selected.progress_ms, ready: false }
      : null;
    pendingResume = resume;
    try {
      await H.play(playable, position);
      if (resume && pendingResume === resume) {
        resume.ready = true;
        if (observedTrackId === 'online:podcast:' + resume.id
          && activeEpisode && activeEpisode.id === resume.id) {
          pendingResume = null;
          restoreEpisodePosition(resume);
        }
      }
    } catch (error) {
      if (pendingResume === resume) pendingResume = null;
      failure('播放失败', error);
    }
  }
  function restoreEpisodePosition(resume) {
    activeEpisode.position_ms = resume.position_ms;
    activeEpisode.lastSavedPosition = resume.position_ms;
    activeEpisode.restoring = true;
    H.seek(resume.position_ms).then(function () {
      if (activeEpisode && activeEpisode.id === resume.id) activeEpisode.restoring = false;
    }).catch(function (error) { failure('恢复收听位置失败', error); });
  }
  function persistProgress(episode, positionMs, completed) {
    if (!episode || !episode.id || !Number.isFinite(positionMs)) return progressWrite;
    var position = Math.max(0, Math.floor(positionMs));
    progressWrite = progressWrite.catch(function () {}).then(async function () {
      var progress = await T.post('/v1/podcasts/progress', {
        episode_id: episode.id, position_ms: position, completed: !!completed,
      });
      st.episodes.forEach(function (item) {
        if (item.id !== episode.id) return;
        item.progress_ms = progress.progress_ms;
        item.completed = progress.completed;
        updateEpisodeProgress(item);
      });
    }).catch(function () { /* Playback must continue if progress storage is unavailable. */ });
    return progressWrite;
  }
  function onPlaybackSnapshot(snap) {
    var match = /^online:podcast:([a-f0-9]{40})$/.exec(snap && snap.track_id || '');
    var id = match && match[1];
    var trackId = snap && snap.track_id || null;
    var resume = null;
    if (pendingResume) {
      if (id === pendingResume.id) {
        if (pendingResume.ready) {
          resume = pendingResume;
          pendingResume = null;
        }
      } else if (trackId !== pendingResume.previousTrackId) {
        pendingResume = null;
      }
    }
    observedTrackId = trackId;
    if (activeEpisode && activeEpisode.id !== id) {
      persistProgress(activeEpisode, activeEpisode.position_ms, activeEpisode.completed);
    }
    if (!id) { activeEpisode = null; return; }
    var now = Date.now();
    if (!activeEpisode || activeEpisode.id !== id) {
      var savedEpisode = st.episodes.find(function (episode) { return episode.id === id; });
      activeEpisode = { id: id, position_ms: snap.position_ms || 0,
        duration_ms: snap.duration_ms || 0, playing: !!snap.playing,
        completed: !!(savedEpisode && savedEpisode.completed),
        lastSavedAt: now, lastSavedPosition: snap.position_ms || 0, restoring: false };
    } else {
      if (!activeEpisode.restoring) activeEpisode.position_ms = snap.position_ms || 0;
      activeEpisode.duration_ms = snap.duration_ms || activeEpisode.duration_ms;
      activeEpisode.playing = !!snap.playing;
    }
    if (activeEpisode.completed && activeEpisode.playing && activeEpisode.position_ms < 5_000) {
      activeEpisode.completed = false;
      persistProgress(activeEpisode, activeEpisode.position_ms, false);
    }
    if (resume) {
      restoreEpisodePosition(resume);
    }
    if (activeEpisode.playing && activeEpisode.position_ms >= 5_000
      && now - activeEpisode.lastSavedAt >= 10_000) {
      activeEpisode.lastSavedAt = now;
      activeEpisode.lastSavedPosition = activeEpisode.position_ms;
      persistProgress(activeEpisode, activeEpisode.position_ms, activeEpisode.completed);
    } else if (!activeEpisode.playing && activeEpisode.position_ms !== activeEpisode.lastSavedPosition) {
      activeEpisode.lastSavedAt = now;
      activeEpisode.lastSavedPosition = activeEpisode.position_ms;
      persistProgress(activeEpisode, activeEpisode.position_ms, activeEpisode.completed);
    }
  }
  async function changeSubscription() {
    if (!st.show || changingSubscription) return;
    var show = st.show, mine = st.epoch, subscribed = !st.show.subscribed;
    changingSubscription = true; renderDetail();
    try {
      if (show.subscribed) await T.del('/v1/podcasts/subscriptions/' + encodeURIComponent(show.id));
      else await T.post('/v1/podcasts/subscriptions', { feed_url: show.feed_url });
      subscriptionRevisions.set(show.id, (subscriptionRevisions.get(show.id) || 0) + 1);
      if (st.show && st.show.id === show.id) st.show.subscribed = subscribed;
      if (mine === st.epoch) {
        status(subscribed ? '已添加到我的订阅' : '已取消订阅，播放记录仍保留');
      }
      await refreshSubscriptions();
    } catch (error) { if (mine === st.epoch) failure('订阅更新失败', error); }
    finally { changingSubscription = false; renderDetail(); }
  }
  async function importFeed() {
    if (importing) return;
    var url = el('podcast-feed-url').value.trim();
    try {
      var parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    } catch (_) { status('请填写不含账号密码的 http 或 https RSS 地址', true); return; }
    var mine = ++st.epoch;
    importing = true; el('podcast-import-submit').disabled = true; status('正在读取并订阅 RSS…');
    try {
      var data = await T.post('/v1/podcasts/subscriptions', { feed_url: url });
      await refreshSubscriptions();
      if (mine !== st.epoch) return;
      el('podcast-feed-url').value = '';
      el('podcast-import-details').open = false;
      await openShow(data.show);
    } catch (error) { if (mine === st.epoch) failure('RSS 导入失败', error); }
    finally { importing = false; el('podcast-import-submit').disabled = false; }
  }
  function browse(tab) {
    ++st.epoch; st.tab = tab || st.tab; st.show = null; st.busy = false;
    status(''); renderShows();
    if (st.tab === 'subscriptions') return refreshSubscriptions();
  }
  function bind(host) {
    H = host; T = window.VMusicTransport;
    if (bound) return;
    bound = true;
    var country = el('podcast-country');
    try {
      var saved = localStorage.getItem(COUNTRY_KEY);
      if (Array.from(country.options).some(function (option) { return option.value === saved; })) country.value = saved;
    } catch (_) { /* Region selection still works without persistent storage. */ }
    country.onchange = function () {
      try { localStorage.setItem(COUNTRY_KEY, country.value); } catch (_) { /* Session preference remains usable. */ }
      st.shows = [];
      if (el('podcast-query').value.trim()) search(el('podcast-query').value);
      else browse('discover');
    };
    el('podcast-search').onsubmit = function (event) { event.preventDefault(); search(el('podcast-query').value); };
    el('podcast-import').onsubmit = function (event) { event.preventDefault(); importFeed(); };
    document.querySelectorAll('[data-podcast-tab]').forEach(function (button) {
      button.onclick = function () { browse(button.dataset.podcastTab); };
    });
    document.querySelectorAll('[data-podcast-query]').forEach(function (button) {
      button.onclick = function () { search(button.dataset.podcastQuery); };
    });
    el('podcast-back').onclick = function () { browse(); };
    el('podcast-subscribe').onclick = changeSubscription;
    el('podcast-more').onclick = function () { loadEpisodes(false, false); };
    el('podcast-feed-refresh').onclick = function () { loadEpisodes(true, true); };
    el('podcast-play-loaded').onclick = function () { playAt(0); };
    document.addEventListener('playback:snapshot', function (event) { onPlaybackSnapshot(event.detail); });
    document.addEventListener('playback:ended', function (event) {
      if (!activeEpisode) return;
      activeEpisode.completed = true;
      activeEpisode.position_ms = activeEpisode.duration_ms || event.detail.position_ms || activeEpisode.position_ms;
      persistProgress(activeEpisode, activeEpisode.position_ms, true);
    });
    renderShows();
  }
  window.Podcasts = { bind: bind, onViewEnter: function () { return refreshSubscriptions(); } };
})();
