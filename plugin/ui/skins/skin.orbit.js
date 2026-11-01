// SPDX-License-Identifier: MIT
(function () {
  'use strict';

  var moves = window.SkinShared.createMoves('orbit-anchor', 'data-orbit-anchor');
  var built = window.SkinShared.createBuilt();
  var mounted = false;
  var observer = null;
  var navObserver = null;
  var refs = {};
  var queueKey = '';
  var coverKey = null;
  var nextCoverKey = null;
  var listeners = [];
  var mobileMenuKey = '';
  var mobileHome = true;
  var homeEpoch = 0;
  var homeLoading = false;
  var homeLoaded = false;
  var playerMoves = window.SkinShared.createMoves('orbit-anchor', 'data-orbit-anchor');
  // 队列折叠是纯表现层偏好：只记一个开关，不动队列数据本身。
  var QUEUE_COLLAPSED_KEY = 'vmusic.skin.orbit.queue.collapsed';

  function byId(id) { return document.getElementById(id); }
  function make(tag, cls, parent, text) {
    var node = built.make(tag, cls, parent);
    if (text) node.textContent = text;
    return node;
  }
  function icon(name) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
  }
  function listen(node, event, handler) {
    node.addEventListener(event, handler);
    listeners.push(function () { node.removeEventListener(event, handler); });
  }
  function button(parent, id, cls, label, symbol, handler) {
    var node = make('button', cls, parent);
    node.id = id;
    node.type = 'button';
    node.title = label;
    node.setAttribute('aria-label', label);
    node.innerHTML = icon(symbol);
    listen(node, 'click', handler);
    return node;
  }
  function navigate(view) {
    var entry = document.querySelector('.rail-item[data-view="' + view + '"]');
    if (entry) entry.click();
  }

  // Mobile navigation proxies the canonical rail; the skin owns no view or player state.
  function syncMobileNav() {
    if (!mounted || !refs.mobileNav) return;
    var entries = Array.prototype.slice.call(byId('rail').querySelectorAll('.rail-item[data-view]'));
    var active = entries.find(function (entry) { return entry.classList.contains('active'); });
    var view = active && active.dataset.view;
    refs.mobileNav.querySelectorAll('[data-view]').forEach(function (entry) {
      var source = entries.find(function (item) { return item.dataset.view === entry.dataset.view; });
      entry.hidden = !source || source.hidden;
      if (view === entry.dataset.view && (view !== 'library' || mobileHome)) entry.setAttribute('aria-current', 'page');
      else entry.removeAttribute('aria-current');
    });
    if (view !== 'library') setMobileHome(false);
    if (view === 'library' && mobileHome && !homeLoaded) refreshMobileHome();
    var connection = byId('conn').textContent;
    if (refs.menuConnection.textContent !== connection) refs.menuConnection.textContent = connection;
    refs.menuConnection.classList.toggle('is-live', connection === '服务已连接');
    var count = byId('lib-count').textContent;
    if (refs.menuCount.textContent !== count) refs.menuCount.textContent = count;
    var secondary = entries.filter(function (entry) { return !entry.hidden; });
    var key = JSON.stringify([mobileHome, secondary.map(function (entry) {
      return [entry.dataset.view, entry.querySelector('span').textContent, entry === active];
    })]);
    if (mobileMenuKey === key) return;
    mobileMenuKey = key;
    var fragment = document.createDocumentFragment();
    function menuEntry(route, label, symbol, current) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'orbit-more-entry';
      item.dataset.route = route;
      item.innerHTML = icon(symbol);
      if (current) item.setAttribute('aria-current', 'page');
      var text = document.createElement('span'); text.textContent = label; item.appendChild(text);
      fragment.appendChild(item);
    }
    menuEntry('home', '首页', 'home', view === 'library' && mobileHome);
    menuEntry('player', '播放器', 'disc', false);
    secondary.forEach(function (entry) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'orbit-more-entry';
      item.dataset.view = entry.dataset.view;
      item.dataset.route = entry.dataset.view;
      if (entry === active && !(view === 'library' && mobileHome)) item.setAttribute('aria-current', 'page');
      item.appendChild(entry.querySelector('svg').cloneNode(true));
      var label = document.createElement('span');
      label.textContent = entry.getAttribute('aria-label') || entry.querySelector('span').textContent;
      item.appendChild(label);
      fragment.appendChild(item);
    });
    refs.moreList.replaceChildren(fragment);
  }

  function setMobileHome(on) {
    mobileHome = !!on;
    document.querySelector('.app').classList.toggle('orbit-mobile-home', mobileHome);
  }

  function visitMobile(route) {
    closeMobileMenu();
    if (route === 'player') { window.Skins.request('open-player'); return; }
    if (route !== 'online') mobileSearch(false);
    setMobileHome(route === 'home');
    navigate(route === 'home' ? 'library' : route);
    if (route === 'home') { homeLoaded = false; refreshMobileHome(); }
    syncMobileNav();
  }

  function openMobileMenu() {
    if (window.TopSearch) window.TopSearch.close();
    syncMobileNav();
    refs.moreSheet.showModal();
    document.querySelector('.app').classList.add('orbit-menu-open');
    refs.moreButton.setAttribute('aria-expanded', 'true');
    refs.menuToggle.setAttribute('aria-expanded', 'true');
  }

  function closeMobileMenu() {
    if (refs.moreSheet && refs.moreSheet.open) refs.moreSheet.close();
    if (refs.moreButton) refs.moreButton.setAttribute('aria-expanded', 'false');
    if (refs.menuToggle) refs.menuToggle.setAttribute('aria-expanded', 'false');
    var app = document.querySelector('.app');
    if (app) app.classList.remove('orbit-menu-open');
  }

  function mobileSearch(on) {
    document.querySelector('.app').classList.toggle('orbit-search-open', on);
    refs.searchToggle.setAttribute('aria-expanded', String(on));
    refs.searchToggle.setAttribute('aria-label', on ? '收起搜索' : '搜索音乐');
    refs.searchToggle.innerHTML = icon(on ? 'close' : 'search');
    if (on) { byId('search').focus(); if (window.TopSearch) window.TopSearch.open(); }
    else if (window.TopSearch) window.TopSearch.close();
  }

  function homeMessage(parent, text, retry) {
    var note = document.createElement('p'); note.className = 'orbit-home-note'; note.textContent = text; parent.appendChild(note);
    if (retry) {
      var action = document.createElement('button'); action.type = 'button'; action.className = 'btn'; action.textContent = '重试';
      action.onclick = function () { homeLoaded = false; refreshMobileHome(); }; parent.appendChild(action);
    }
  }

  function renderHomeTracks(parent, items, empty, failed) {
    parent.replaceChildren();
    if (!items.length) { homeMessage(parent, failed ? '暂时无法读取，请重试' : empty, failed); return; }
    items.forEach(function (item) {
      var tile = document.createElement('button'); tile.type = 'button'; tile.className = 'orbit-home-tile';
      var art = document.createElement('span'); art.className = 'orbit-home-art'; art.innerHTML = icon('disc');
      if (item.cover) { var img = document.createElement('img'); img.alt = ''; window.SkinShared.applyImg(img, item.cover); art.appendChild(img); }
      var title = document.createElement('strong'); title.textContent = item.title;
      var artist = document.createElement('small'); artist.textContent = item.artist;
      tile.append(art, title, artist); tile.title = item.title + ' · ' + item.artist;
      tile.onclick = function () {
        if (item.source === 'local') window.Skins.request('play-local', { id: item.id });
        else window.Skins.request('play-online', { track: item.raw });
        window.Skins.request('open-player');
      };
      parent.appendChild(tile);
    });
    if (failed) homeMessage(parent, '部分记录未能读取', true);
  }

  function refreshMobileHome() {
    if (!mounted || !refs.home || !mobileHome || homeLoading || !window.matchMedia('(max-width: 767px)').matches) return;
    var result = window.Skins.request('home-request').result;
    if (!result) return;
    var epoch = ++homeEpoch;
    homeLoading = true;
    refs.home.setAttribute('aria-busy', 'true');
    Promise.resolve(result).then(function (data) {
      if (!mounted || epoch !== homeEpoch) return;
      renderHomeTracks(refs.homeRecent, data.recent, '听过的音乐会留在这里', data.recentError);
      renderHomeTracks(refs.homeAdded, data.added, '添加音乐目录，让喜欢的音乐出现在这里', data.libraryError);
      refs.homeArtists.replaceChildren();
      if (!data.artists.length) homeMessage(refs.homeArtists, data.artistsError ? '艺人暂时无法读取' : '收录音乐后，在这里按艺人浏览', data.artistsError);
      data.artists.forEach(function (artist) {
        var tile = document.createElement('button'); tile.type = 'button'; tile.className = 'orbit-home-tile orbit-artist-tile';
        var art = document.createElement('span'); art.className = 'orbit-home-art'; art.innerHTML = icon('user');
        if (artist.cover) { var img = document.createElement('img'); img.alt = ''; window.SkinShared.applyImg(img, artist.cover); art.appendChild(img); }
        var name = document.createElement('strong'); name.textContent = artist.name;
        var count = document.createElement('small'); count.textContent = artist.count + ' 首';
        tile.append(art, name, count);
        tile.onclick = function () {
          visitMobile('library');
          if (window.TopSearch) window.TopSearch.setKind('local');
          window.Skins.request('view-local', { q: '', artist: artist.name });
          refs.syncFilters();
        };
        refs.homeArtists.appendChild(tile);
      });
      homeLoaded = true;
    }, function () {
      if (!mounted || epoch !== homeEpoch) return;
      [refs.homeRecent, refs.homeAdded, refs.homeArtists].forEach(function (node) {
        node.replaceChildren(); homeMessage(node, '内容暂时无法读取', true);
      });
      homeLoaded = true;
    }).finally(function () {
      if (!mounted || epoch !== homeEpoch) return;
      homeLoading = false; refs.home.removeAttribute('aria-busy');
    });
  }

  function mountMobile(app) {
    var topbar = document.querySelector('.topbar');
    refs.menuToggle = button(topbar, 'orbit-menu-toggle', 'orbit-menu-toggle', '打开导航菜单', 'queue', openMobileMenu);
    refs.menuToggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
    refs.menuToggle.setAttribute('aria-haspopup', 'dialog');
    refs.menuToggle.setAttribute('aria-controls', 'orbit-more-sheet');
    refs.menuToggle.setAttribute('aria-expanded', 'false');
    make('span', 'orbit-mobile-heading', topbar, 'Hertz Studio');
    refs.searchToggle = button(topbar, 'orbit-search-toggle', 'orbit-search-toggle', '搜索音乐', 'search', function () {
      mobileSearch(!app.classList.contains('orbit-search-open'));
    });
    refs.searchToggle.setAttribute('aria-expanded', 'false');
    refs.searchToggle.setAttribute('aria-controls', 'search');
    topbar.prepend(refs.menuToggle);
    refs.mobileNav = make('nav', 'orbit-mobile-nav', app);
    refs.mobileNav.setAttribute('aria-label', '手机主导航');
    [['library', '首页', 'home'], ['online', '搜索', 'search'], ['favorites', '收藏', 'heart-outline'], ['more', '我的', 'user']].forEach(function (entry) {
      var item = button(refs.mobileNav, 'orbit-mobile-' + entry[0], 'orbit-mobile-tab', entry[1], entry[2], function () {
        if (entry[0] === 'more') openMobileMenu();
        else if (entry[0] === 'online') { visitMobile('online'); mobileSearch(true); }
        else visitMobile(entry[0] === 'library' ? 'home' : entry[0]);
      });
      make('span', '', item, entry[1]);
      if (entry[0] !== 'more') item.dataset.view = entry[0];
      if (entry[0] === 'more') {
        refs.moreButton = item;
        item.setAttribute('aria-haspopup', 'dialog');
        item.setAttribute('aria-controls', 'orbit-more-sheet');
        item.setAttribute('aria-expanded', 'false');
      }
    });
    refs.moreSheet = make('dialog', 'orbit-more-sheet', app);
    refs.moreSheet.id = 'orbit-more-sheet';
    refs.moreSheet.setAttribute('aria-labelledby', 'orbit-more-title');
    var header = make('header', 'orbit-more-heading', refs.moreSheet);
    make('h2', '', header, 'Hertz Studio').id = 'orbit-more-title';
    button(header, 'orbit-more-close', 'orbit-more-close', '关闭导航菜单', 'close', closeMobileMenu);
    refs.moreList = make('div', 'orbit-more-list', refs.moreSheet);
    refs.moreList.setAttribute('role', 'navigation');
    refs.moreList.setAttribute('aria-label', '全部页面');
    button(refs.moreSheet, 'orbit-menu-exit', 'orbit-more-entry orbit-menu-exit', '退出播放服务', 'power', function () {
      closeMobileMenu(); byId('service-exit').click();
    }).appendChild(document.createTextNode('退出播放服务'));
    var footer = make('footer', 'orbit-menu-footer', refs.moreSheet);
    refs.menuConnection = make('span', 'orbit-menu-connection', footer);
    refs.menuCount = make('span', '', footer);
    listen(refs.moreList, 'click', function (event) {
      var entry = event.target.closest('[data-route]');
      if (!entry) return;
      visitMobile(entry.dataset.route);
    });
    listen(refs.moreSheet, 'close', closeMobileMenu);
    listen(refs.moreSheet, 'click', function (event) {
      if (event.target !== refs.moreSheet) return;
      var rect = refs.moreSheet.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeMobileMenu();
    });
    listen(refs.moreSheet, 'keydown', function (event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeMobileMenu();
    });
    listen(window.matchMedia('(max-width: 767px)'), 'change', function (event) {
      if (!event.matches) closeMobileMenu();
      playerMoves.restore();
      if (event.matches) movesPlayerTools();
      if (event.matches && mobileHome) refreshMobileHome();
    });
    function movesPlayerTools() {
      var volume = document.querySelector('#np-modal .np-volume');
      if (volume) playerMoves.relocate(volume, byId('np-tools'));
    }
    if (window.matchMedia('(max-width: 767px)').matches) movesPlayerTools();
    listen(byId('search'), 'input', function () {
      if (window.TopSearch && window.TopSearch.kind() === 'local') { setMobileHome(false); syncMobileNav(); }
    });

    refs.home = make('section', 'orbit-home', byId('view-library'));
    refs.home.setAttribute('aria-label', '音乐首页');
    byId('view-library').prepend(refs.home);
    [['最近播放', 'homeRecent'], ['最近加入', 'homeAdded'], ['曲库艺人', 'homeArtists']].forEach(function (section) {
      var heading = make('div', 'orbit-home-section-heading', refs.home);
      make('h2', '', heading, section[0]);
      var all = make('button', '', heading, section[1] === 'homeRecent' ? '继续浏览' : '全部');
      all.type = 'button';
      listen(all, 'click', function () {
        if (section[1] === 'homeRecent') { setMobileHome(false); byId('home-recent').click(); }
        else visitMobile('library');
      });
      refs[section[1]] = make('div', 'orbit-home-strip', refs.home);
      for (var i = 0; i < 3; i++) make('span', 'orbit-home-skeleton', refs[section[1]]).setAttribute('aria-hidden', 'true');
    });
    setMobileHome(true);
    listen(document, 'playback:track', function () { homeLoaded = false; refreshMobileHome(); });

    refs.libraryHead = byId('view-library').querySelector('.col-head');
    refs.libraryTools = refs.libraryHead.querySelector('.col-tools');
    refs.libraryTools.id = 'orbit-library-tools';
    refs.selectToggle = make('button', 'btn orbit-select-toggle', refs.libraryTools, '选择曲目');
    refs.selectToggle.type = 'button';
    refs.selectToggle.setAttribute('aria-pressed', 'false');
    listen(refs.selectToggle, 'click', function () {
      var on = app.classList.toggle('orbit-selecting');
      refs.selectToggle.setAttribute('aria-pressed', String(on));
      refs.selectToggle.textContent = on ? '完成选择' : '选择曲目';
    });
    refs.filterToggle = button(refs.libraryHead, 'orbit-filter-toggle', 'orbit-filter-toggle', '筛选与管理曲库', 'sliders', function () {
      var open = refs.libraryHead.classList.toggle('orbit-filters-open');
      refs.filterToggle.setAttribute('aria-expanded', String(open));
    });
    refs.filterToggle.setAttribute('aria-expanded', 'false');
    refs.filterToggle.setAttribute('aria-controls', refs.libraryTools.id);
    var filterLabel = make('span', '', refs.filterToggle, '筛选');
    refs.filterSummary = make('div', 'orbit-filter-summary', byId('view-library'));
    refs.libraryHead.after(refs.filterSummary);
    var filterSummaryText = make('span', '', refs.filterSummary);
    var clearFilters = make('button', '', refs.filterSummary, '清除筛选');
    clearFilters.type = 'button';
    listen(clearFilters, 'click', function () {
      ['lib-artist-filter', 'lib-album-filter'].forEach(function (id) {
        var select = byId(id); select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
    function syncFilters() {
      var count = Number(!!byId('lib-artist-filter').value) + Number(!!byId('lib-album-filter').value);
      filterLabel.textContent = count ? '筛选 · ' + count : '筛选';
      refs.filterToggle.classList.toggle('has-filters', count > 0);
      refs.filterSummary.hidden = !count;
      filterSummaryText.textContent = [byId('lib-artist-filter').value, byId('lib-album-filter').value].filter(Boolean).join(' · ');
    }
    refs.syncFilters = syncFilters;
    listen(refs.libraryTools, 'change', syncFilters);
    syncFilters();
    navObserver = new MutationObserver(syncMobileNav);
    navObserver.observe(byId('rail'), { childList: true, subtree: true, attributes: true,
      attributeFilter: ['class', 'hidden'] });
    navObserver.observe(byId('conn'), { childList: true, subtree: true });
    navObserver.observe(byId('lib-count'), { childList: true });
    syncMobileNav();
  }

  /// 队列折叠：右侧整栏完全隐藏，开关固定在中间卡片右上角。
  /// 只在 .app 上落一个类名 + 维护按钮 aria，队列数据与播放逻辑不参与。
  function queueCollapsed() {
    var app = document.querySelector('.app');
    return !!app && app.classList.contains('orbit-queue-hidden');
  }

  function setQueueCollapsed(on) {
    var app = document.querySelector('.app');
    if (app) app.classList.toggle('orbit-queue-hidden', !!on);
    if (refs.queueToggle) {
      refs.queueToggle.setAttribute('aria-expanded', String(!on));
      refs.queueToggle.title = on ? '展开播放队列' : '收起播放队列';
      refs.queueToggle.setAttribute('aria-label', refs.queueToggle.title);
    }
    try { localStorage.setItem(QUEUE_COLLAPSED_KEY, on ? '1' : '0'); } catch (e) {}
  }

  function storedQueueCollapsed() {
    try { return localStorage.getItem(QUEUE_COLLAPSED_KEY) === '1'; } catch (e) { return false; }
  }

  function sync() {
    if (!mounted) return;
    if (refs.syncFilters) refs.syncFilters();
    var presentation = window.Stage && window.Stage.presentation ? window.Stage.presentation() : {};
    var track = presentation.track;
    var favorite = byId('bar-favorite');
    refs.play.classList.toggle('is-playing', !!presentation.playing);
    refs.play.title = presentation.playing ? '暂停' : '播放';
    refs.play.setAttribute('aria-label', refs.play.title);
    refs.playText.textContent = refs.play.title;
    refs.favorite.disabled = !favorite || favorite.disabled;
    refs.favorite.setAttribute('aria-pressed', favorite ? favorite.getAttribute('aria-pressed') || 'false' : 'false');
    refs.favorite.classList.toggle('is-on', refs.favorite.getAttribute('aria-pressed') === 'true');
    refs.favorite.title = favorite ? favorite.title : '收藏当前歌曲';
    refs.favorite.setAttribute('aria-label', refs.favorite.title);
    refs.currentTitle.textContent = track && track.title || byId('now-title').textContent;
    refs.currentArtist.textContent = track && track.artist || byId('now-artist').textContent;
    refs.currentTitle.title = refs.currentTitle.textContent;
    refs.currentArtist.title = refs.currentArtist.textContent;
    refs.currentSource.replaceChildren();
    if (track && track.source && window.Online && window.Online.badge) {
      refs.currentSource.appendChild(window.Online.badge(track.source));
      refs.currentSource.hidden = false;
    } else {
      refs.currentSource.hidden = true;
    }
    var currentSeconds = Math.max(0, Math.floor((presentation.duration || 0) / 1000));
    refs.currentDuration.textContent = currentSeconds
      ? Math.floor(currentSeconds / 60) + ':' + String(currentSeconds % 60).padStart(2, '0') : '—';
    var cover = presentation.cover || '';
    if (coverKey !== cover) {
      coverKey = cover;
      window.SkinShared.applyImg(refs.currentCover, cover);
      refs.currentCover.hidden = !cover;
    }
    refs.libraryCount.textContent = byId('lib-count').textContent;
    var seconds = Math.max(0, Math.floor((presentation.duration || 0) / 1000));
    refs.duration.textContent = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    refs.album.textContent = track && track.album || '—';
    refs.quality.textContent = byId('now-tech').textContent || '—';
    refs.album.title = refs.album.textContent;
    refs.quality.title = refs.quality.textContent;

    // Render a bounded view of the canonical queue; playback always uses its original index.
    var queue = window.Skins.request('queue-request').queue || [];
    var current = queue.findIndex(function (item) { return item.current; });
    var next = queue.length > 1 ? queue[(current + 1) % queue.length] : null;
    refs.next.hidden = !next;
    refs.nextIndex = next ? next.index : -1;
    refs.nextTitle.textContent = next ? next.title : '';
    refs.next.title = next ? '播放：' + next.title : '下一首';
    if (nextCoverKey !== (next && next.cover || '')) {
      nextCoverKey = next && next.cover || '';
      window.SkinShared.applyImg(refs.nextCover, nextCoverKey);
      refs.nextCover.hidden = !nextCoverKey;
    }
    var start = Math.max(0, current - 1);
    var visible = queue.slice(start, start + 40);
    var key = JSON.stringify(visible.map(function (item) {
      return [item.id, item.index, item.title, item.artist, item.cover, item.duration, item.current];
    }));
    refs.queueCount.textContent = queue.length + ' 首';
    refs.empty.hidden = queue.length > 0;
    if (queueKey === key) return;
    queueKey = key;
    var active = document.activeElement;
    var focusedIndex = refs.queueList.contains(active) ? active.dataset.index : null;
    var fragment = document.createDocumentFragment();
    visible.forEach(function (item) {
      var row = document.createElement('button');
      row.className = 'orbit-queue-row';
      row.type = 'button';
      row.dataset.index = item.index;
      row.setAttribute('aria-current', item.current ? 'true' : 'false');
      row.title = item.title + ' · ' + item.artist;
      var artwork = document.createElement('span');
      artwork.className = 'orbit-queue-art';
      artwork.setAttribute('aria-hidden', 'true');
      artwork.innerHTML = icon('disc');
      if (item.cover) {
        var img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        window.SkinShared.applyImg(img, item.cover);
        artwork.appendChild(img);
      }
      var meta = document.createElement('span');
      meta.className = 'orbit-queue-meta';
      var title = document.createElement('strong');
      title.textContent = item.title;
      var artist = document.createElement('small');
      artist.textContent = item.artist;
      meta.append(title, artist);
      var duration = document.createElement('span');
      duration.className = 'orbit-queue-duration';
      var seconds = Math.max(0, Math.floor((item.duration || 0) / 1000));
      duration.textContent = item.duration ? Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0') : '';
      row.append(artwork, meta, duration);
      fragment.appendChild(row);
    });
    refs.queueList.replaceChildren(fragment);
    if (focusedIndex !== null) {
      var next = refs.queueList.querySelector('[data-index="' + focusedIndex + '"]')
        || refs.queueList.querySelector('.orbit-queue-row');
      if (next) next.focus({ preventScroll: true });
      else refs.queueToggle.focus({ preventScroll: true });
    }
  }

  function resetTilt() {
    if (refs.turntable) {
      ['--orbit-tilt-x', '--orbit-tilt-y', '--orbit-parallax-x', '--orbit-parallax-y'].forEach(function (key) {
        refs.turntable.style.removeProperty(key);
      });
    }
  }
  function tilt(event) {
    if (event.pointerType === 'touch' || document.body.classList.contains('reduce-motion')
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var rect = refs.turntable.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var x = Math.max(-1, Math.min(1, (event.clientX - rect.left) / rect.width * 2 - 1));
    var y = Math.max(-1, Math.min(1, (event.clientY - rect.top) / rect.height * 2 - 1));
    refs.turntable.style.setProperty('--orbit-tilt-x', (x * 10).toFixed(2) + 'deg');
    refs.turntable.style.setProperty('--orbit-tilt-y', (-y * 8).toFixed(2) + 'deg');
    refs.turntable.style.setProperty('--orbit-parallax-x', (-x * 18).toFixed(2) + 'px');
    refs.turntable.style.setProperty('--orbit-parallax-y', (-y * 12).toFixed(2) + 'px');
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    var app = document.querySelector('.app');
    var column = byId('column');
    var stage = byId('stage');
    var rail = byId('rail');
    var main = make('div', 'orbit-main');
    app.insertBefore(main, column);
    moves.relocate(stage, main);
    moves.relocate(column, main);
    var brand = document.querySelector('.topbar .brand');
    if (brand) moves.relocate(brand, rail, rail.firstChild);
    var skinName = make('div', 'orbit-skin-name', null, '星轨');
    rail.insertBefore(skinName, brand ? brand.nextSibling : rail.firstChild);
    moves.relocate(document.querySelector('.topbar'), main, stage);
    var topbar = document.querySelector('.topbar');
    refs.navToggle = button(topbar, 'orbit-nav-toggle', 'iconbtn orbit-nav-toggle', '收起导航栏', 'arrow-left', function () {
      var hidden = app.classList.toggle('orbit-nav-hidden');
      refs.navToggle.setAttribute('aria-expanded', String(!hidden));
      refs.navToggle.title = hidden ? '展开导航栏' : '收起导航栏';
      refs.navToggle.setAttribute('aria-label', refs.navToggle.title);
    });
    refs.navToggle.setAttribute('aria-controls', 'rail');
    refs.navToggle.setAttribute('aria-expanded', 'true');
    topbar.prepend(refs.navToggle);
    var library = make('div', 'orbit-library-status', rail);
    make('span', '', library, '音乐库');
    refs.libraryCount = make('strong', '', library);

    var info = make('div', 'orbit-info', stage);
    moves.relocate(stage.querySelector('.stage-head'), info);
    moves.relocate(byId('now-title'), info);
    moves.relocate(byId('now-artist'), info);
    var actions = make('div', 'orbit-actions', info);
    refs.play = button(actions, 'orbit-play', 'btn primary orbit-play', '播放', 'play', function () {
      window.Skins.request('toggle-play');
    });
    refs.play.querySelector('svg').classList.add('ic-play');
    var pause = make('span', 'ic-pause', refs.play);
    pause.innerHTML = icon('pause');
    refs.playText = make('span', '', refs.play, '播放');
    refs.favorite = button(actions, 'orbit-favorite', 'ctrl bar-favorite', '收藏当前歌曲', 'heart', function () {
      byId('bar-favorite').click();
    });
    button(actions, 'orbit-player', 'ctrl', '展开播放页与歌词', 'lyrics', function () {
      window.Skins.request('open-player');
    });
    var metadata = make('dl', 'orbit-metadata', info);
    [['时长', 'duration'], ['专辑', 'album'], ['音质', 'quality']].forEach(function (entry) {
      var cell = make('div', '', metadata);
      make('dt', '', cell, entry[0]);
      refs[entry[1]] = make('dd', '', cell);
    });

    refs.turntable = make('div', 'orbit-turntable', stage);
    refs.rig = make('div', 'orbit-rig', refs.turntable);
    make('div', 'orbit-ground-shadow', refs.rig).setAttribute('aria-hidden', 'true');
    for (var z = 0; z < 14; z++) {
      var depth = make('div', 'orbit-depth', refs.rig);
      depth.style.transform = 'translateZ(' + z + 'px)';
      depth.setAttribute('aria-hidden', 'true');
    }
    refs.recordToggle = make('button', 'orbit-record-toggle', refs.rig);
    refs.recordToggle.id = 'orbit-record-toggle';
    refs.recordToggle.type = 'button';
    refs.recordToggle.title = '切换为中心封面';
    refs.recordToggle.setAttribute('aria-label', '封面居中');
    refs.recordToggle.setAttribute('aria-pressed', 'false');
    listen(refs.recordToggle, 'click', function () {
      var centered = refs.recordToggle.getAttribute('aria-pressed') !== 'true';
      refs.recordToggle.setAttribute('aria-pressed', String(centered));
      refs.recordToggle.title = centered ? '切换为外圈封面' : '切换为中心封面';
    });
    moves.relocate(stage.querySelector('.disc-wrap'), refs.recordToggle);
    var arm = make('div', 'orbit-tonearm', refs.rig);
    arm.setAttribute('aria-hidden', 'true');
    refs.next = button(refs.turntable, 'orbit-next', 'orbit-float orbit-next', '下一首', 'disc', function () {
      if (refs.nextIndex >= 0) window.Skins.request('play-index', { index: refs.nextIndex });
    });
    var nextArt = make('span', 'orbit-next-art', refs.next);
    refs.nextCover = make('img', '', nextArt);
    refs.nextCover.alt = '';
    var nextMeta = make('span', 'orbit-next-meta', refs.next);
    make('small', '', nextMeta, '下一首');
    refs.nextTitle = make('strong', '', nextMeta);
    listen(refs.turntable, 'pointermove', tilt);
    listen(refs.turntable, 'pointerleave', resetTilt);
    listen(refs.turntable, 'pointercancel', resetTilt);

    var sidebar = make('aside', 'orbit-queue', app);
    sidebar.id = 'orbit-queue';
    sidebar.setAttribute('aria-label', '播放队列');
    var heading = make('div', 'orbit-queue-heading', sidebar);
    make('h2', '', heading, '播放队列');
    refs.queueCount = make('span', 'count', heading);
    var topRight = document.querySelector('.topbar .top-right');
    refs.queueToggle = button(topRight || topbar, 'orbit-queue-toggle', 'iconbtn orbit-queue-toggle', '收起播放队列', 'chevron-down', function () {
      setQueueCollapsed(!queueCollapsed());
    });
    var exitButton = byId('service-exit');
    if (topRight && exitButton && exitButton.parentNode === topRight) topRight.insertBefore(refs.queueToggle, exitButton);
    refs.queueToggle.setAttribute('aria-controls', 'orbit-queue');
    refs.queueToggle.setAttribute('aria-expanded', 'true');
    var current = make('div', 'orbit-current', sidebar);
    var currentArt = make('div', 'orbit-current-art', current);
    currentArt.innerHTML = icon('disc');
    refs.currentCover = make('img', '', currentArt);
    refs.currentCover.alt = '';
    var currentTop = make('div', 'orbit-current-top', current);
    make('span', 'orbit-current-label', currentTop, '正在播放');
    var currentDetails = make('span', 'orbit-current-details', currentTop);
    refs.currentSource = make('span', 'orbit-current-source', currentDetails);
    refs.currentDuration = make('span', 'orbit-current-duration', currentDetails);
    refs.currentTitle = make('strong', 'orbit-current-title', current);
    refs.currentArtist = make('span', 'orbit-current-artist', current);
    refs.queueList = make('div', 'orbit-queue-list', sidebar);
    refs.queueList.setAttribute('aria-label', '队列曲目');
    listen(refs.queueList, 'click', function (event) {
      var row = event.target.closest('.orbit-queue-row');
      if (row && refs.queueList.contains(row)) window.Skins.request('play-index', { index: Number(row.dataset.index) });
    });
    refs.empty = make('div', 'orbit-queue-empty', sidebar);
    make('p', '', refs.empty, '队列为空');
    var browse = make('button', 'btn', refs.empty, '浏览曲库');
    browse.type = 'button';
    listen(browse, 'click', function () { navigate('library'); });

    observer = new MutationObserver(sync);
    ['queue-list', 'bar-favorite', 'now-title', 'now-artist', 'now-tech', 'cover', 'lib-count'].forEach(function (id) {
      var node = byId(id);
      if (node) observer.observe(node, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'style', 'disabled', 'aria-pressed', 'title'] });
    });
    listen(document, 'playback:track', sync);
    listen(document, 'stage:playing-changed', sync);
    listen(document, 'visibilitychange', resetTilt);
    mountMobile(app);
    if (window.SkinSettingsSheet) window.SkinSettingsSheet.mount();
    setQueueCollapsed(storedQueueCollapsed());
    sync();
  }

  function unmount() {
    if (!mounted) return;
    mounted = false;
    if (observer) observer.disconnect();
    observer = null;
    if (navObserver) navObserver.disconnect();
    navObserver = null;
    closeMobileMenu();
    homeEpoch += 1;
    homeLoading = false;
    homeLoaded = false;
    playerMoves.restore();
    listeners.forEach(function (remove) { remove(); });
    listeners = [];
    if (window.SkinSettingsSheet) window.SkinSettingsSheet.unmount();
    var app = document.querySelector('.app');
    if (app) app.classList.remove('orbit-nav-hidden', 'orbit-queue-hidden', 'orbit-mobile-home', 'orbit-search-open', 'orbit-menu-open', 'orbit-selecting');
    resetTilt();
    if (refs.libraryHead) refs.libraryHead.classList.remove('orbit-filters-open');
    if (refs.libraryTools) refs.libraryTools.removeAttribute('id');
    moves.restore();
    built.remove();
    refs = {};
    queueKey = '';
    coverKey = null;
    nextCoverKey = null;
    mobileMenuKey = '';
    mobileHome = true;
  }

  window.Skins.register({
    id: 'orbit',
    name: '星轨',
    note: '侧栏导航、立体唱片与常驻队列，沿用真实曲库与播放控制',
    lifecycle: { mount: mount, unmount: unmount },
  });
})();
