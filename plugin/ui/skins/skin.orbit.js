// SPDX-License-Identifier: MIT
(function () {
  'use strict';

  var moves = window.SkinShared.createMoves('orbit-anchor', 'data-orbit-anchor');
  var built = window.SkinShared.createBuilt();
  var mounted = false;
  var observer = null;
  var refs = {};
  var queueKey = '';
  var coverKey = null;
  var nextCoverKey = null;
  var listeners = [];

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

  function sync() {
    if (!mounted) return;
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
      var next = refs.queueList.querySelector('[data-index="' + focusedIndex + '"]');
      if (next) next.focus({ preventScroll: true });
      else refs.queueOpen.focus({ preventScroll: true });
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
    var mobileName = make('span', 'orbit-mobile-brand', null, '星轨');
    document.querySelector('.topbar').prepend(mobileName);
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
    sidebar.setAttribute('aria-label', '播放队列');
    var heading = make('div', 'orbit-queue-heading', sidebar);
    make('h2', '', heading, '播放队列');
    refs.queueCount = make('span', 'count', heading);
    refs.queueOpen = button(heading, 'orbit-queue-open', 'iconbtn', '查看完整队列', 'expand', function () { navigate('queue'); });
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
    if (window.SkinSettingsSheet) window.SkinSettingsSheet.mount();
    sync();
  }

  function unmount() {
    if (!mounted) return;
    mounted = false;
    if (observer) observer.disconnect();
    observer = null;
    listeners.forEach(function (remove) { remove(); });
    listeners = [];
    if (window.SkinSettingsSheet) window.SkinSettingsSheet.unmount();
    var app = document.querySelector('.app');
    if (app) app.classList.remove('orbit-nav-hidden');
    resetTilt();
    moves.restore();
    built.remove();
    refs = {};
    queueKey = '';
    coverKey = null;
    nextCoverKey = null;
  }

  window.Skins.register({
    id: 'orbit',
    name: '星轨',
    note: '侧栏导航、立体唱片与常驻队列，沿用真实曲库与播放控制',
    lifecycle: { mount: mount, unmount: unmount },
  });
})();
