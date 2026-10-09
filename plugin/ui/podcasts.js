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
      : el('podcast-query').value.trim() ? '没有找到相关节目，换个节目名或主播名试试。' : '搜索中文节目，也可以直接添加公开 RSS。';
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
      var data = await T.get('/v1/podcasts/search?q=' + encodeURIComponent(query) + '&limit=30');
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
      var copy = node('div', 'podcast-episode-copy');
      copy.appendChild(node('span', 'podcast-episode-meta',
        [dateText(episode.published_at), duration(episode.duration_ms)].filter(Boolean).join(' · ')));
      var play = node('button', 'podcast-episode-play', episode.title);
      play.type = 'button'; play.disabled = !episode.playable;
      play.setAttribute('aria-label', '播放：' + episode.title);
      play.onclick = function () { playAt(index); };
      copy.appendChild(play);
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
  function playAt(index) {
    var playable = st.episodes.filter(function (episode) { return episode.playable; });
    var selected = st.episodes[index];
    var position = playable.indexOf(selected);
    if (position < 0) return;
    Promise.resolve(H.play(playable, position)).catch(function (error) { failure('播放失败', error); });
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
    renderShows();
  }
  window.Podcasts = { bind: bind, onViewEnter: function () { return refreshSubscriptions(); } };
})();
