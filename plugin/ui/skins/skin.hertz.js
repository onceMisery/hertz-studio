// SPDX-License-Identifier: MIT
// HertzStudio 的响应式布局。播放、队列与导航仍由原模块裁决。
(function () {
  'use strict';
  var mounted = false, layout, built, refs = {}, cleanup = [], observer;
  var homeEpoch = 0, homeBusy = false, homeAgain = false, queueKey = '', queueLimit = 60;
  var featuredAlbums = [], featuredIndex = 0;
  var queueOpen = false, queueTrigger, lastView = '', pendingFrame = 0, menuKey = '', queueBackground = [];
  var sidebarOpen = false, sidebarCollapsed = false, sidebarBackground = [], sidebarGesture = null;
  var sidebarKey = 'vmusic.hertz.sidebar.v1';
  var libraryTab = 'songs', libraryEpoch = 0, libraryController, libraryOffset = 0, libraryTotal = 0, libraryBusy = false;
  var libraryDetail = null, settingsTab = 'appearance', preferenceKey = 'vmusic.hertz.appearance.v1';
  var preferences = { intensity: 70, animated: true, wordSync: true };
  var mobile = window.matchMedia('(max-width: 899px)');
  function id(value) { return document.getElementById(value); }
  function icon(name) { return `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}"></use></svg>`; }
  function make(tag, cls, parent, text) {
    var node = built.make(tag, cls, parent);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function listen(node, name, fn, opts) {
    if (!node) return;
    node.addEventListener(name, fn, opts);
    cleanup.push(function () { node.removeEventListener(name, fn, opts); });
  }
  function button(parent, cls, label, symbol, fn) {
    var node = make('button', cls, parent); node.type = 'button';
    node.title = label; node.setAttribute('aria-label', label);
    if (symbol) node.innerHTML = icon(symbol);
    if (fn) listen(node, 'click', fn);
    return node;
  }
  function navigate(view) {
    closeMenu(); setQueue(false); if (mobile.matches) setSidebar(false, false);
    var entry = document.querySelector('#rail .rail-item[data-view="' + view + '"]');
    if (entry && !entry.hidden) entry.click();
  }
  function art(parent, cover, cls) {
    var box = document.createElement('span'); box.className = cls; box.innerHTML = icon('disc');
    if (cover) {
      var img = document.createElement('img'); img.alt = ''; img.loading = 'lazy';
      window.SkinShared.applyImg(img, cover); box.appendChild(img);
    }
    parent.appendChild(box); return box;
  }
  function text(tag, cls, value, parent) {
    var node = document.createElement(tag); node.className = cls; node.textContent = value || '';
    parent.appendChild(node); return node;
  }
  function notice(parent, value, retry) {
    text('p', 'hz-empty-note', value, parent);
    if (retry) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = '重试';
      b.onclick = function () { refreshHome(true); }; parent.appendChild(b);
    }
  }
  function renderTracks(parent, items, empty, failed) {
    parent.replaceChildren();
    if (!items.length) { notice(parent, failed ? '内容暂时无法读取' : empty, failed); return; }
    items.forEach(function (item) {
      var tile = document.createElement('button'); tile.type = 'button'; tile.className = 'hz-music-tile';
      tile.title = '播放 ' + item.title + (item.artist ? ' · ' + item.artist : '');
      var cover = art(tile, item.cover, 'hz-tile-art');
      var play = text('span', 'hz-tile-play', '', cover); play.innerHTML = icon('play');
      text('strong', '', item.title, tile); text('small', '', item.artist || '未知歌手', tile);
      tile.onclick = function () {
        if (item.source === 'local') window.Skins.request('play-local', { id: item.id, list: items });
        else window.Skins.request('play-online', { track: item.raw, list: items });
      };
      parent.appendChild(tile);
    });
    if (failed) notice(parent, '部分内容未能读取', true);
  }
  function refreshHome(force) {
    if (!mounted || !refs.home || window.HertzShell.activeView() !== 'home') return;
    if (homeBusy) { if (force === true) homeAgain = true; return; }
    var task = window.Skins.request('home-request').result;
    if (!task) return;
    homeBusy = true; var epoch = ++homeEpoch;
    refs.home.setAttribute('aria-busy', 'true');
    Promise.resolve(task).then(function (data) {
      if (!mounted || epoch !== homeEpoch) return;
      renderTracks(refs.recent, data.recent || [], '最近听过的音乐，会留在这里', data.recentError);
      renderTracks(refs.added, data.added || [], '添加音乐目录，建立自己的曲库', data.libraryError);
      renderFacets(refs.albums, data.albums || [], data.albumsError, '收录音乐后，在这里浏览专辑');
      featuredAlbums = (data.albums || []).slice(0, 3);
      featuredIndex = Math.min(featuredIndex, Math.max(0, featuredAlbums.length - 1));
      renderFeatured();
      renderPlaylists(refs.playlists, data.playlists || [], data.playlistsError);
      refs.artists.replaceChildren();
      if (!(data.artists || []).length) notice(refs.artists, data.artistsError ? '歌手暂时无法读取' : '收录音乐后，在这里发现曲库中的歌手', data.artistsError);
      (data.artists || []).forEach(function (artist) {
        var tile = document.createElement('button'); tile.type = 'button'; tile.className = 'hz-music-tile hz-artist-tile';
        art(tile, artist.cover, 'hz-tile-art'); text('strong', '', artist.name, tile); text('small', '', artist.count + ' 首歌曲', tile);
        tile.onclick = function () { openFacet(Object.assign({ kind: 'artist' }, artist)); };
        refs.artists.appendChild(tile);
      });
    }, function () {
      if (!mounted || epoch !== homeEpoch) return;
      [refs.recent, refs.added, refs.albums, refs.artists, refs.playlists].forEach(function (node) { node.replaceChildren(); notice(node, '内容暂时无法读取，请重试', true); });
      refs.featuredContent.replaceChildren(); notice(refs.featuredContent, '专辑暂时无法读取，请重试', true);
    }).finally(function () {
      if (!mounted || epoch !== homeEpoch) return;
      homeBusy = false; refs.home.removeAttribute('aria-busy');
      if (homeAgain) { homeAgain = false; refreshHome(true); }
    });
  }
  function mountHome() {
    refs.home = id('view-home');
    var dashboard = id('home-dashboard'), continuation;
    [['最近播放', 'recent', '听过的旋律，再听一遍'], ['最近加入', 'added', '曲库中的新声音'], ['从一张专辑开始', 'albums', '曲库里的专辑'], ['熟悉的歌手', 'artists', '从一个声音开始']].forEach(function (section) {
      var block = make('section', 'hz-home-section', refs.home);
      var top = make('div', 'hz-section-head', block), titles = make('div', '', top);
      make('h2', '', titles, section[0]);
      var all = button(top, 'hz-text-link', '查看全部', '', function () {
        if (section[1] === 'recent') id('home-recent').click();
        else { navigate('library'); showLibraryTab(section[1] === 'albums' ? 'album' : section[1] === 'artists' ? 'artist' : 'songs'); }
      }); all.textContent = '查看全部';
      refs[section[1]] = make('div', 'hz-music-strip', block);
      for (var i = 0; i < 4; i++) make('div', 'hz-tile-skeleton', refs[section[1]]).setAttribute('aria-hidden', 'true');
      if (section[1] === 'recent' && dashboard) {
        refs.featured = make('section', 'hz-home-section hz-featured', refs.home);
        var featuredHead = make('div', 'hz-section-head', refs.featured); make('h2', '', featuredHead, '精选专辑');
        refs.featuredDots = make('div', 'hz-featured-dots', featuredHead); refs.featuredDots.setAttribute('aria-label', '切换精选专辑');
        refs.featuredContent = make('div', 'hz-featured-content', refs.featured);
        notice(refs.featuredContent, '正在读取专辑…');
        continuation = make('details', 'hz-home-section hz-continuation', refs.home);
        make('summary', '', continuation, '继续聆听与快捷入口'); layout.move(dashboard, continuation);
      }
    });
    var playlists = make('section', 'hz-home-section', refs.home), title = make('div', 'hz-section-head', playlists);
    make('h2', '', title, '把喜欢编成歌单');
    var allPlaylists = button(title, 'hz-text-link', '管理我的歌单', '', function () { navigate('playlists'); }); allPlaylists.textContent = '管理歌单';
    refs.playlists = make('div', 'hz-playlist-grid', playlists);
    if (continuation) refs.home.appendChild(continuation);
    var quick = make('section', 'hz-quick-links', refs.home);
    [['online', '寻找新的旋律', '浏览在线曲库', 'globe'], ['playlists', '把喜欢编成歌单', '打开我的歌单', 'playlist']].forEach(function (entry) {
      var b = button(quick, 'hz-quick-link', entry[2], entry[3], function () { navigate(entry[0]); });
      b.dataset.view = entry[0];
      var copy = make('span', '', b); make('strong', '', copy, entry[1]); make('small', '', copy, entry[2]);
      make('span', 'hz-link-arrow', b, '↗');
    });
  }
  function renderFeatured() {
    refs.featuredDots.replaceChildren(); refs.featuredContent.replaceChildren();
    if (!featuredAlbums.length) {
      notice(refs.featuredContent, '添加音乐目录，让喜欢的专辑在这里相遇'); return;
    }
    featuredAlbums.forEach(function (item, index) {
      var dot = document.createElement('button'); dot.type = 'button';
      dot.setAttribute('aria-label', '展示专辑 ' + item.name); dot.setAttribute('aria-pressed', String(index === featuredIndex));
      dot.onclick = function () { featuredIndex = index; renderFeatured(); refs.featuredDots.children[index].focus({ preventScroll: true }); };
      refs.featuredDots.appendChild(dot);
    });
    var item = featuredAlbums[featuredIndex];
    var cover = document.createElement('button'); cover.type = 'button'; cover.className = 'hz-featured-cover';
    cover.setAttribute('aria-label', '浏览专辑 ' + item.name); art(cover, item.cover, 'hz-featured-art');
    cover.onclick = function () { openFacet(item); }; refs.featuredContent.appendChild(cover);
    var copy = text('div', 'hz-featured-copy', '', refs.featuredContent);
    text('p', 'hz-featured-sub', item.subtitle || item.count + ' 首歌曲', copy);
    text('h2', '', item.name, copy);
    var actions = text('div', 'hz-featured-actions', '', copy);
    var play = document.createElement('button'); play.type = 'button'; play.className = 'btn primary';
    play.innerHTML = icon('play'); text('span', '', '播放专辑', play);
    play.onclick = function () { openFacet(item); playLibrary(false); }; actions.appendChild(play);
    var browse = document.createElement('button'); browse.type = 'button'; browse.className = 'btn'; browse.textContent = '查看专辑';
    browse.onclick = function () { openFacet(item); }; actions.appendChild(browse);
  }
  function renderFacets(parent, items, failed, empty) {
    parent.replaceChildren();
    if (!items.length) { notice(parent, failed ? '内容暂时无法读取' : empty, failed); return; }
    items.forEach(function (item) {
      var tile = document.createElement('button'); tile.type = 'button'; tile.className = 'hz-music-tile' + (item.kind === 'artist' ? ' hz-artist-tile' : '');
      tile.setAttribute('aria-label', '浏览' + (item.kind === 'artist' ? '歌手 ' : '专辑 ') + item.name);
      art(tile, item.cover, 'hz-tile-art'); text('strong', '', item.name, tile); text('small', '', item.subtitle || item.count + ' 首歌曲', tile);
      tile.onclick = function () { openFacet(item); }; parent.appendChild(tile);
    });
  }
  function renderPlaylists(parent, items, failed) {
    parent.replaceChildren();
    refs.railPlaylists.replaceChildren();
    items.slice(0, 6).forEach(function (item) {
      var entry = document.createElement('button'); entry.type = 'button'; entry.className = 'hz-rail-playlist'; entry.textContent = item.name; entry.title = item.name;
      entry.onclick = function () { if (mobile.matches) setSidebar(false, false); window.Skins.request('playlist-open', { id: item.id }); };
      refs.railPlaylists.appendChild(entry);
    });
    if (!items.length) text('p', 'hz-rail-empty', failed ? '暂时无法读取歌单' : '收藏喜欢的旋律', refs.railPlaylists);
    if (!items.length) { notice(parent, failed ? '歌单暂时无法读取' : '把喜欢的歌曲收进歌单，留给下次聆听', failed); return; }
    items.forEach(function (item, index) {
      var row = document.createElement('button'); row.type = 'button'; row.className = 'hz-playlist-entry';
      text('span', 'hz-playlist-num', String(index + 1).padStart(2, '0'), row); art(row, item.cover, 'hz-playlist-art');
      var copy = text('span', 'hz-playlist-copy', '', row); text('strong', '', item.name, copy); text('small', '', item.subtitle, copy);
      var arrow = text('span', 'hz-link-arrow', '', row); arrow.innerHTML = icon('chevron-down');
      row.onclick = function () { closeMenu(); setQueue(false); window.Skins.request('playlist-open', { id: item.id }); }; parent.appendChild(row);
    });
  }
  function mountLibrary() {
    var root = id('view-library'), header = root.querySelector('.col-head');
    refs.libraryTabs = make('div', 'hz-library-tabs', root); refs.libraryTabs.setAttribute('role', 'tablist'); refs.libraryTabs.setAttribute('aria-label', '曲库分类');
    header.after(refs.libraryTabs);
    [['songs', '歌曲'], ['album', '专辑'], ['artist', '歌手'], ['playlist', '歌单']].forEach(function (entry) {
      var b = button(refs.libraryTabs, '', entry[1], '', function () { showLibraryTab(entry[0]); }); b.textContent = entry[1];
      b.dataset.kind = entry[0]; b.id = 'hz-library-tab-' + entry[0]; b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', entry[0] === 'songs' ? 'hz-library-songs' : 'hz-library-browser');
    });
    refs.libraryDetail = make('section', 'hz-library-detail', root); refs.libraryDetail.hidden = true; refs.libraryTabs.after(refs.libraryDetail);
    refs.librarySongs = make('section', 'hz-library-songs', root); refs.librarySongs.id = 'hz-library-songs';
    refs.librarySongs.setAttribute('role', 'tabpanel'); refs.librarySongs.setAttribute('aria-labelledby', 'hz-library-tab-songs');
    var actions = make('div', 'hz-library-actions', refs.librarySongs);
    refs.libraryPlay = button(actions, 'btn primary', '播放当前筛选的全部歌曲', 'play', function () { playLibrary(false); }); make('span', '', refs.libraryPlay, '播放全部');
    refs.libraryShuffle = button(actions, 'btn', '随机播放当前筛选的歌曲', 'shuffle', function () { playLibrary(true); }); make('span', '', refs.libraryShuffle, '随机播放');
    // 原曲库 DOM 继续持有行复用、多选、分页与右键管理。
    ['lib-empty', 'lib-empty-strip', 'lib-hint', 'lib-list', 'lib-sentinel', 'lib-batch-bar'].forEach(function (key) { layout.move(id(key), refs.librarySongs); });
    var daily = id('daily-strip'); root.appendChild(refs.librarySongs);
    if (daily) layout.move(daily, refs.librarySongs);
    refs.libraryBrowser = make('section', 'hz-library-browser', root); refs.libraryBrowser.id = 'hz-library-browser'; refs.libraryBrowser.hidden = true;
    refs.libraryBrowser.setAttribute('role', 'tabpanel'); refs.libraryBrowser.setAttribute('aria-live', 'polite');
    refs.libraryGrid = make('div', 'hz-library-grid', refs.libraryBrowser);
    refs.libraryMore = button(refs.libraryBrowser, 'btn hz-library-more', '加载更多', '', function () { loadLibraryBrowse(true); }); refs.libraryMore.textContent = '加载更多'; refs.libraryMore.hidden = true;
    listen(refs.libraryTabs, 'keydown', function (event) {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      var tabs = Array.from(refs.libraryTabs.children).filter(function (tab) { return !tab.hidden; }), current = tabs.indexOf(document.activeElement);
      var next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      event.preventDefault(); showLibraryTab(tabs[next].dataset.kind); tabs[next].focus();
    });
    listen(id('search'), 'input', function () { if (window.TopSearch && window.TopSearch.kind() === 'local') showLibraryTab('songs'); });
    showLibraryTab('songs');
  }
  function playLibrary(shuffle) {
    refs.libraryPlay.disabled = true; refs.libraryShuffle.disabled = true;
    Promise.resolve(window.Skins.request('library-play', { shuffle: shuffle }).result).finally(function () {
      if (mounted) { refs.libraryPlay.disabled = false; refs.libraryShuffle.disabled = false; }
    });
  }
  function showLibraryTab(kind) {
    if (!mounted || !refs.libraryTabs) return;
    if (kind === 'playlist') { navigate('playlists'); return; }
    libraryTab = kind; libraryDetail = null; refs.libraryDetail.hidden = true; refs.libraryTabs.hidden = false;
    id('view-library').dataset.hzLibraryTab = kind; id('view-library').removeAttribute('data-hz-library-detail');
    if (libraryController) libraryController.abort(); ++libraryEpoch; libraryBusy = false; refs.libraryBrowser.removeAttribute('aria-busy');
    refs.librarySongs.hidden = kind !== 'songs'; refs.libraryBrowser.hidden = kind === 'songs';
    refs.libraryTabs.querySelectorAll('[data-kind]').forEach(function (tab) { var selected = tab.dataset.kind === kind; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; });
    refs.libraryBrowser.setAttribute('aria-labelledby', 'hz-library-tab-' + kind);
    if (kind !== 'songs') loadLibraryBrowse(false);
  }
  function loadLibraryBrowse(append) {
    if (!mounted || libraryBusy || libraryTab === 'songs') return;
    if (!append) { libraryOffset = 0; refs.libraryGrid.replaceChildren(); refs.libraryMore.textContent = '加载更多'; }
    var epoch = ++libraryEpoch, kind = libraryTab;
    libraryController = new AbortController(); libraryBusy = true; refs.libraryBrowser.setAttribute('aria-busy', 'true');
    refs.libraryMore.disabled = true;
    if (!append) notice(refs.libraryGrid, '正在读取曲库…');
    Promise.resolve(window.Skins.request('library-browse', { kind: kind, q: id('search').value, offset: libraryOffset, signal: libraryController.signal }).result).then(function (data) {
      if (!mounted || epoch !== libraryEpoch) return;
      if (!append) refs.libraryGrid.replaceChildren();
      data.items.forEach(function (item) {
        var tile = document.createElement('button'); tile.type = 'button'; tile.className = 'hz-music-tile' + (kind === 'artist' ? ' hz-artist-tile' : '');
        art(tile, item.cover, 'hz-tile-art'); text('strong', '', item.name, tile); text('small', '', item.subtitle, tile);
        tile.onclick = function () { openFacet(item); }; refs.libraryGrid.appendChild(tile);
      });
      libraryTotal = data.total; libraryOffset = data.nextOffset;
      if (!libraryTotal) notice(refs.libraryGrid, id('search').value ? '没有找到相关' + (kind === 'album' ? '专辑' : '歌手') : '添加音乐目录后，在这里浏览' + (kind === 'album' ? '专辑' : '歌手'));
      refs.libraryMore.hidden = libraryOffset >= libraryTotal;
    }, function () {
      if (!mounted || epoch !== libraryEpoch) return;
      if (!append) refs.libraryGrid.replaceChildren(); notice(refs.libraryGrid, '曲库暂时无法读取');
      refs.libraryMore.hidden = false; refs.libraryMore.textContent = '重试读取';
    }).finally(function () {
      if (!mounted || epoch !== libraryEpoch) return;
      libraryBusy = false; refs.libraryMore.disabled = false; refs.libraryBrowser.removeAttribute('aria-busy');
    });
  }
  function openFacet(item) {
    navigate('library');
    var kind = item.kind === 'artist' ? 'artist' : 'album'; showLibraryTab('songs'); libraryDetail = item;
    refs.libraryTabs.hidden = true; refs.libraryDetail.hidden = false; refs.libraryDetail.replaceChildren();
    id('view-library').dataset.hzLibraryDetail = 'true';
    var back = document.createElement('button'); back.type = 'button'; back.className = 'hz-text-link hz-detail-back'; back.textContent = '‹ 返回' + (kind === 'artist' ? '歌手' : '专辑');
    back.onclick = function () { window.Skins.request('view-local', { q: '', artist: '', album: '' }); showLibraryTab(kind); }; refs.libraryDetail.appendChild(back);
    var content = text('div', 'hz-detail-content', '', refs.libraryDetail); art(content, item.cover, 'hz-detail-art' + (kind === 'artist' ? ' is-round' : ''));
    var copy = text('div', '', '', content); text('p', 'hz-eyebrow', kind === 'artist' ? '歌手' : '专辑', copy); var title = text('h2', '', item.name, copy); title.tabIndex = -1; text('p', 'hz-detail-sub', item.subtitle || item.count + ' 首歌曲', copy);
    if (window.TopSearch && window.TopSearch.kind() !== 'local') window.TopSearch.setKind('local');
    window.Skins.request('view-local', { q: '', artist: kind === 'artist' ? item.name : '', album: kind === 'album' ? item.name : '' });
    id('column').scrollTo({ top: 0 }); title.focus({ preventScroll: true });
  }
  function applyPreferences(persist) {
    document.documentElement.style.setProperty('--hz-ambient-opacity', String(preferences.intensity / 100 * .42));
    document.body.dataset.hzAnimated = String(preferences.animated);
    document.body.dataset.hzWordSync = String(preferences.wordSync);
    id('hz-ambient-intensity').value = preferences.intensity; id('hz-ambient-value').textContent = preferences.intensity + '%';
    id('hz-ambient-animated').checked = preferences.animated; id('hz-word-sync').checked = preferences.wordSync;
    if (persist) { try { localStorage.setItem(preferenceKey, JSON.stringify(preferences)); } catch (error) { /* 本次界面偏好仍然生效。 */ } }
    if (window.NowPlaying && window.NowPlaying.isOpen()) window.NowPlaying.update();
  }
  function mountPreferences() {
    try {
      var saved = JSON.parse(localStorage.getItem(preferenceKey) || '{}');
      if (typeof saved.intensity === 'number' && Number.isFinite(saved.intensity)) preferences.intensity = Math.round(Math.max(0, Math.min(100, saved.intensity)));
      if (typeof saved.animated === 'boolean') preferences.animated = saved.animated;
      if (typeof saved.wordSync === 'boolean') preferences.wordSync = saved.wordSync;
    } catch (error) { /* 旧偏好或损坏数据使用默认值。 */ }
    ['set-cover-follow', 'set-motion'].forEach(function (key) {
      var row = id(key).closest('.set-row'); row.classList.add('hz-setting-row', 'hz-borrowed-control');
      layout.move(row, id('hz-appearance'), id('hz-intensity-row'));
      cleanup.push(function () { row.classList.remove('hz-setting-row', 'hz-borrowed-control'); });
    });
    listen(id('hz-ambient-intensity'), 'input', function (event) { preferences.intensity = Number(event.currentTarget.value); applyPreferences(true); });
    listen(id('hz-ambient-animated'), 'change', function (event) { preferences.animated = event.currentTarget.checked; applyPreferences(true); });
    listen(id('hz-word-sync'), 'change', function (event) { preferences.wordSync = event.currentTarget.checked; applyPreferences(true); });
    listen(id('hz-theme-dark'), 'click', function () { window.Theme.apply('hertz-dark'); });
    listen(id('hz-theme-light'), 'click', function () { window.Theme.apply('hertz-light'); });
    applyPreferences(false);
    refs.settingsNav = make('nav', 'hz-settings-nav', id('view-settings')); refs.settingsNav.setAttribute('role', 'tablist'); refs.settingsNav.setAttribute('aria-label', '设置分类');
    id('view-settings').querySelector('.col-head').after(refs.settingsNav);
    [['appearance', '外观'], ['playback', '播放'], ['lyrics', '歌词'], ['connection', '连接'], ['tools', '工具']].forEach(function (entry) {
      var b = button(refs.settingsNav, '', entry[1], '', function () { selectSettings(entry[0]); }); b.textContent = entry[1]; b.dataset.category = entry[0]; b.setAttribute('role', 'tab');
    });
    refs.settingsGroups = Array.from(id('view-settings').children).filter(function (group) { return group.classList.contains('set-group'); });
    refs.settingsGroups.forEach(function (group) {
      var title = group.querySelector('.set-title').textContent, originalHidden = group.hidden;
      group.dataset.hzCategory = /AI|远程|在线音源/.test(title) ? 'connection' : /歌词/.test(title) ? 'lyrics' : /音效|^播放$|在线缓存/.test(title) ? 'playback' : /备份|快捷键|开发者/.test(title) ? 'tools' : 'appearance';
      group.dataset.hzAvailable = String(!originalHidden && !(window.hertzHost && window.hertzHost.isDbx && ['overlay-group', 'video-export-group', 'desktop-lyrics-settings'].includes(group.id)));
      cleanup.push(function () { group.hidden = originalHidden; delete group.dataset.hzCategory; delete group.dataset.hzAvailable; });
    });
    listen(refs.settingsNav, 'keydown', function (event) {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      var tabs = Array.from(refs.settingsNav.children), current = tabs.indexOf(document.activeElement);
      var next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      event.preventDefault(); selectSettings(tabs[next].dataset.category); tabs[next].focus();
    });
    selectSettings(settingsTab);
  }
  function selectSettings(category) {
    settingsTab = category;
    refs.settingsNav.querySelectorAll('button').forEach(function (tab) { var active = tab.dataset.category === category; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; });
    refs.settingsGroups.forEach(function (group) { group.hidden = group.dataset.hzAvailable === 'false' || group.dataset.hzCategory !== category; });
    window.dispatchEvent(new CustomEvent('hertz-settings-category', { detail: { category: category } }));
  }
  function setQueue(open, trigger) {
    if (!mounted) return;
    if (open && sidebarOpen) setSidebar(false, false);
    queueOpen = !!open;
    if (open && trigger) queueTrigger = trigger;
    document.body.classList.toggle('hz-queue-open', queueOpen);
    refs.queuePane.hidden = !queueOpen;
    refs.queueScrim.hidden = !queueOpen || !mobile.matches;
    refs.queueToggle.setAttribute('aria-expanded', String(queueOpen));
    queueBackground.forEach(function (saved) { saved.node.inert = saved.inert; }); queueBackground = [];
    if (queueOpen && mobile.matches) {
      refs.queuePane.setAttribute('role', 'dialog'); refs.queuePane.setAttribute('aria-modal', 'true');
      [refs.workspace, id('playback-bar'), refs.nav].forEach(function (node) { queueBackground.push({ node: node, inert: node.inert }); node.inert = true; });
    } else { refs.queuePane.removeAttribute('role'); refs.queuePane.removeAttribute('aria-modal'); }
    if (queueOpen) { paintQueue(); refs.queueClose.focus({ preventScroll: true }); }
    else if (queueTrigger && document.contains(queueTrigger)) { queueTrigger.focus({ preventScroll: true }); queueTrigger = null; }
  }
  function paintQueue(nextFocus) {
    if (!mounted || !queueOpen) return;
    var queue = window.Skins.request('queue-request').queue || [];
    var key = JSON.stringify([queue.length, queue.slice(0, queueLimit).map(function (item) { return [item.id, item.index, item.title, item.artist, item.cover, item.duration, item.current]; })]);
    refs.queueCount.textContent = queue.length + ' 首歌曲';
    if (key === queueKey) return; queueKey = key;
    var active = document.activeElement, hadFocus = refs.queueList.contains(active);
    var focused = hadFocus && active.hasAttribute('data-index') ? Number(active.dataset.index) : null;
    var focusedMore = hadFocus && active.classList.contains('hz-queue-more');
    refs.queueList.replaceChildren();
    if (!queue.length) notice(refs.queueList, '队列还是空的，从喜欢的音乐开始');
    queue.slice(0, queueLimit).forEach(function (item) {
      var row = document.createElement('button'); row.type = 'button'; row.className = 'hz-queue-row'; row.dataset.index = item.index;
      if (item.current) row.setAttribute('aria-current', 'true');
      art(row, item.cover, 'hz-queue-art');
      var meta = text('span', 'hz-queue-meta', '', row); text('strong', '', item.title, meta); text('small', '', item.artist, meta);
      var sec = Math.floor((item.duration || 0) / 1000);
      text('time', '', sec ? Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0') : '', row);
      row.onclick = function () { window.Skins.request('play-index', { index: item.index }); };
      refs.queueList.appendChild(row);
    });
    if (queue.length > queueLimit) {
      var more = text('button', 'btn hz-queue-more', '加载更多歌曲', refs.queueList); more.type = 'button';
      more.onclick = function () { var firstAdded = queueLimit; queueLimit += 60; queueKey = ''; paintQueue(firstAdded); };
    }
    if (Number.isInteger(nextFocus) || focused !== null || focusedMore) {
      var at = Number.isInteger(nextFocus) ? nextFocus : focused;
      var rows = refs.queueList.querySelectorAll('[data-index]');
      var target = at !== null ? refs.queueList.querySelector('[data-index="' + at + '"]') : refs.queueList.querySelector('.hz-queue-more');
      if (!target) target = rows[Math.min(Math.max(0, at || 0), rows.length - 1)] || refs.queueClose;
      target.focus({ preventScroll: !Number.isInteger(nextFocus) });
    }
  }
  function mountQueue(app) {
    refs.queueScrim = button(document.body, 'hz-queue-scrim', '收起队列', '', function () { setQueue(false); }); refs.queueScrim.hidden = true;
    refs.queueScrim.tabIndex = -1; refs.queueScrim.setAttribute('aria-hidden', 'true');
    refs.queuePane = make('aside', 'hz-queue-pane', app); refs.queuePane.hidden = true; refs.queuePane.id = 'hz-queue-pane';
    refs.queuePane.setAttribute('aria-label', '接下来播放');
    var head = make('header', 'hz-queue-head', refs.queuePane), title = make('div', '', head);
    make('h2', '', title, '接下来播放'); refs.queueCount = make('p', '', title);
    refs.queueClose = button(head, 'hz-icon', '收起队列', 'close', function () { setQueue(false); });
    refs.queueList = make('div', 'hz-queue-list', refs.queuePane);
    var manage = button(refs.queuePane, 'hz-text-link hz-queue-manage', '管理播放队列', '', function () { navigate('queue'); }); manage.textContent = '管理队列 · 排序、移除与保存';
  }
  function closeMenu() {
    if (refs.menu && refs.menu.open) refs.menu.close();
    if (refs.menuToggle) refs.menuToggle.setAttribute('aria-expanded', 'false');
  }
  function syncSidebar() {
    sidebarBackground.forEach(function (saved) { saved.node.inert = saved.inert; }); sidebarBackground = [];
    var expanded = mobile.matches ? sidebarOpen : !sidebarCollapsed;
    document.body.classList.toggle('hz-sidebar-hidden', !mobile.matches && sidebarCollapsed);
    document.body.classList.toggle('hz-sidebar-open', mobile.matches && sidebarOpen);
    refs.rail.inert = !expanded; refs.rail.setAttribute('aria-hidden', String(!expanded));
    refs.sidebarToggle.setAttribute('aria-expanded', String(expanded));
    refs.sidebarToggle.title = expanded ? '收起导航菜单' : '展开导航菜单'; refs.sidebarToggle.setAttribute('aria-label', refs.sidebarToggle.title);
    if (mobile.matches && sidebarOpen) {
      refs.rail.setAttribute('role', 'dialog'); refs.rail.setAttribute('aria-modal', 'true'); refs.rail.setAttribute('aria-label', '导航菜单');
      [refs.workspace, id('playback-bar'), refs.nav].forEach(function (node) { sidebarBackground.push({ node: node, inert: node.inert }); node.inert = true; });
    } else { refs.rail.removeAttribute('role'); refs.rail.removeAttribute('aria-modal'); refs.rail.setAttribute('aria-label', '主导航'); }
  }
  function setSidebar(open, returnFocus) {
    if (!mounted || !refs.rail) return;
    if (mobile.matches) sidebarOpen = !!open;
    else {
      sidebarCollapsed = !open;
      try { localStorage.setItem(sidebarKey, JSON.stringify({ collapsed: sidebarCollapsed })); } catch (error) { /* 本次界面仍可收起。 */ }
    }
    if (open) {
      closeMenu(); setQueue(false);
      if (window.TopSearch) window.TopSearch.close();
      document.dispatchEvent(new CustomEvent('topbar:popup', { detail: { id: 'sidebar' } }));
    }
    syncSidebar();
    if (mobile.matches && open) refs.sidebarClose.focus({ preventScroll: true });
    else if (returnFocus) refs.sidebarToggle.focus({ preventScroll: true });
  }
  function mountSidebar(rail, topbar) {
    refs.rail = rail;
    var original = { inert: rail.inert, role: rail.getAttribute('role'), label: rail.getAttribute('aria-label'), hidden: rail.getAttribute('aria-hidden') };
    try { sidebarCollapsed = JSON.parse(localStorage.getItem(sidebarKey) || '{}').collapsed === true; } catch (error) { sidebarCollapsed = false; }
    refs.sidebarToggle = button(topbar, 'hz-icon hz-sidebar-toggle', '收起导航菜单', 'menu', function () { setSidebar(mobile.matches ? !sidebarOpen : sidebarCollapsed, true); });
    refs.sidebarToggle.id = 'hz-sidebar-toggle'; refs.sidebarToggle.setAttribute('aria-controls', 'rail'); topbar.prepend(refs.sidebarToggle);
    var head = make('div', 'hz-rail-head', rail); rail.prepend(head); layout.move(rail.querySelector('.brand'), head);
    refs.sidebarClose = button(head, 'hz-icon hz-sidebar-close', '关闭导航菜单', 'close', function () { setSidebar(false, true); });
    refs.sidebarScrim = button(document.body, 'hz-sidebar-scrim', '关闭导航菜单', '', function () { setSidebar(false, true); });
    refs.sidebarScrim.tabIndex = -1; refs.sidebarScrim.setAttribute('aria-hidden', 'true');
    refs.sidebarEdge = make('div', 'hz-sidebar-edge', document.body); refs.sidebarEdge.setAttribute('aria-hidden', 'true');
    listen(rail, 'click', function (event) {
      var action = event.target.closest('button');
      if (mobile.matches && action && action !== refs.sidebarClose) setSidebar(false, true);
    }, true);
    listen(document, 'keydown', function (event) {
      if (!mobile.matches || !sidebarOpen || rail.closest('[inert]')) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setSidebar(false, true); return; }
      if (event.key !== 'Tab') return;
      var nodes = Array.from(rail.querySelectorAll('button')).filter(function (node) { return !node.disabled && node.getClientRects().length; });
      var first = nodes[0], last = nodes[nodes.length - 1];
      if (!rail.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }, true);
    listen(document, 'touchstart', function (event) {
      sidebarGesture = null;
      if (!mobile.matches || event.touches.length !== 1 || window.HertzShell.mode() === 'room' || document.body.matches('.np-expanded,.s3d-open,.space3d-open,.is-capsule,.qf-lattice-open') || queueOpen) return;
      if (document.querySelector('dialog[open]') || Array.from(document.querySelectorAll('[aria-modal="true"]')).some(function (node) { return node !== rail && !node.hidden && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden'; })) return;
      var touch = event.touches[0];
      if (!sidebarOpen && touch.clientX > 20) return;
      sidebarGesture = { x: touch.clientX, y: touch.clientY, open: sidebarOpen };
    }, { passive: true });
    listen(document, 'touchend', function (event) {
      var start = sidebarGesture; sidebarGesture = null;
      if (!start || !event.changedTouches.length) return;
      var touch = event.changedTouches[0], dx = touch.clientX - start.x, dy = touch.clientY - start.y;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      if (!start.open && dx > 0) setSidebar(true, false);
      else if (start.open && dx < 0) setSidebar(false, true);
    }, { passive: true });
    listen(document, 'touchcancel', function () { sidebarGesture = null; }, { passive: true });
    listen(mobile, 'change', function () {
      var hadFocus = rail.contains(document.activeElement);
      sidebarOpen = false; sidebarGesture = null; syncSidebar();
      if (hadFocus && rail.inert) refs.sidebarToggle.focus({ preventScroll: true });
    });
    listen(document, 'topbar:popup', function (event) {
      if (!event.detail || event.detail.id === 'sidebar') return;
      if (sidebarOpen) setSidebar(false, true);
      if (event.detail.id === 'palette') { closeMenu(); setQueue(false); }
    });
    listen(document, 'hertz:cover-wall', function (event) { if (event.detail.open && sidebarOpen) setSidebar(false, false); });
    listen(document, 'stage:visibility', function (event) { if (event.detail.open && sidebarOpen) setSidebar(false, false); });
    cleanup.push(function () {
      sidebarBackground.forEach(function (saved) { saved.node.inert = saved.inert; }); sidebarBackground = [];
      rail.inert = original.inert; rail.removeAttribute('aria-modal');
      [['role', original.role], ['aria-label', original.label], ['aria-hidden', original.hidden]].forEach(function (entry) { if (entry[1] === null) rail.removeAttribute(entry[0]); else rail.setAttribute(entry[0], entry[1]); });
    });
    syncSidebar();
  }
  function syncNavigation() {
    if (!mounted) return;
    var view = window.HertzShell.activeView(), entries = Array.from(id('rail').querySelectorAll('.rail-item[data-view]'));
    // 每日推荐等入口在设置到手后才挂载，也归入同一展开菜单。
    entries.forEach(function (entry) {
      if (!['home', 'library', 'settings'].includes(entry.dataset.view) && entry.parentNode !== refs.extraEntries) layout.move(entry, refs.extraEntries);
    });
    document.body.dataset.hzView = view || 'home';
    refs.nav.querySelectorAll('[data-view]').forEach(function (b) {
      var source = entries.find(function (entry) { return entry.dataset.view === b.dataset.view; });
      b.hidden = !source || source.hidden;
      if (view === b.dataset.view || (b.dataset.view === 'library' && ['playlists', 'favorites'].includes(view))) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    refs.home.querySelectorAll('.hz-quick-link[data-view]').forEach(function (link) { var entry = entries.find(function (b) { return b.dataset.view === link.dataset.view; }); link.hidden = !entry || entry.hidden; });
    var tools = Array.from(id('top-more-menu').querySelectorAll('button')), account = id('online-account-btn'); if (account) tools.push(account);
    var key = JSON.stringify([view, entries.map(function (entry) { return [entry.dataset.view, entry.hidden]; }), tools.map(function (entry) { return [entry.id, entry.hidden, entry.disabled]; })]);
    if (menuKey !== key) {
      menuKey = key; refs.menuList.replaceChildren(); refs.menuTools.replaceChildren();
      entries.filter(function (entry) { return !entry.hidden; }).forEach(function (entry) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'hz-menu-entry'; b.dataset.view = entry.dataset.view;
        if (entry.dataset.view === view) b.setAttribute('aria-current', 'page');
        b.appendChild(entry.querySelector('svg').cloneNode(true)); text('span', '', entry.getAttribute('aria-label'), b);
        b.onclick = function () { navigate(entry.dataset.view); }; refs.menuList.appendChild(b);
      });
      tools.filter(function (entry) { return !entry.hidden; }).forEach(function (entry) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'hz-menu-entry'; b.disabled = entry.disabled;
        var svg = entry.querySelector('svg'); if (svg) b.appendChild(svg.cloneNode(true)); text('span', '', entry.id === 'theme-btn' ? '主题与配色' : entry.getAttribute('title') || entry.getAttribute('aria-label'), b);
        b.onclick = function () { closeMenu(); if (entry.id === 'theme-btn') { navigate('settings'); selectSettings('appearance'); id('set-theme').scrollIntoView({ block: 'center' }); id('set-theme').focus(); } else entry.click(); };
        refs.menuTools.appendChild(b);
      });
    }
    refs.libraryTabs.querySelector('[data-kind="playlist"]').hidden = !!(entries.find(function (entry) { return entry.dataset.view === 'playlists'; }) || {}).hidden;
    refs.playlistTabs.querySelectorAll('button').forEach(function (button) {
      button.setAttribute('aria-current', button.dataset.kind === 'playlist' ? 'page' : 'false');
    });
    if (view !== lastView) { lastView = view; setQueue(false); if (sidebarOpen) setSidebar(false, false); if (view === 'home') refreshHome(); }
  }
  function scheduleSync() {
    if (pendingFrame) return;
    pendingFrame = requestAnimationFrame(function () { pendingFrame = 0; syncNavigation(); paintQueue(); });
  }
  function mountMobile() {
    refs.nav = make('nav', 'hz-mobile-nav', document.querySelector('.app')); refs.nav.setAttribute('aria-label', '手机主导航');
    [['home', '首页', 'home'], ['library', '曲库', 'library'], ['settings', '设置', 'settings']].forEach(function (entry) {
      var b = button(refs.nav, 'hz-mobile-tab', entry[1], entry[2], function () { navigate(entry[0]); }); b.dataset.view = entry[0]; make('span', '', b, entry[1]);
    });
    refs.menuToggle = button(document.querySelector('.hz-top-tools'), 'hz-icon hz-mobile-more', '全部功能', 'more', function () {
      syncNavigation(); refs.menu.showModal(); refs.menuToggle.setAttribute('aria-expanded', 'true');
    }); refs.menuToggle.setAttribute('aria-haspopup', 'dialog');
    refs.menu = make('dialog', 'hz-mobile-menu', document.body); refs.menu.setAttribute('aria-label', '全部功能');
    var top = make('header', '', refs.menu); make('h2', '', top, '你的音乐空间');
    button(top, 'hz-icon', '关闭全部功能', 'close', closeMenu);
    refs.menuList = make('nav', 'hz-menu-list', refs.menu);
    refs.menuTools = make('div', 'hz-menu-tools', refs.menu);
    listen(refs.menu, 'click', function (event) { if (event.target === refs.menu) closeMenu(); });
    listen(refs.menu, 'close', function () { refs.menuToggle.setAttribute('aria-expanded', 'false'); });
    listen(refs.menu, 'keydown', function (event) { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); } });
    listen(mobile, 'change', function () { closeMenu(); if (queueOpen) setQueue(false); });
  }
  function syncTheme() {
    if (!mounted) return;
    var theme = window.Theme.current(), light = theme && theme.tokens && !isDark(theme.tokens['--bg']);
    document.documentElement.dataset.hzTone = light ? 'light' : 'dark';
    refs.themeToggle.innerHTML = icon(light ? 'moon' : 'sun');
    refs.themeToggle.title = light ? '切换深色外观' : '切换浅色外观'; refs.themeToggle.setAttribute('aria-label', refs.themeToggle.title);
    if (id('hz-theme-dark')) { id('hz-theme-dark').setAttribute('aria-pressed', String(!light)); id('hz-theme-light').setAttribute('aria-pressed', String(!!light)); }
    var meta = document.querySelector('meta[name="theme-color"]'); if (meta && theme) meta.content = theme.tokens['--bg'];
  }
  function isDark(hex) { var n = parseInt((hex || '#000000').slice(1), 16); return (((n >> 16) & 255) * .2126 + ((n >> 8) & 255) * .7152 + (n & 255) * .0722) < 150; }
  function mountScrollActivity() {
    // 只响应实际位移，悬停不显示；同一个监听器覆盖动态队列、弹层和横向专辑。
    var active = new Map();
    function clear() {
      active.forEach(function (timer, node) { clearTimeout(timer); node.removeAttribute('data-hz-scrolling'); });
      active.clear();
    }
    listen(document, 'scroll', function (event) {
      var node = event.target === document ? document.scrollingElement : event.target;
      if (!(node instanceof Element) || document.hidden) return;
      if (!active.has(node)) node.setAttribute('data-hz-scrolling', 'true');
      else clearTimeout(active.get(node));
      active.set(node, setTimeout(function () {
        node.removeAttribute('data-hz-scrolling'); active.delete(node);
      }, 900));
    }, { capture: true, passive: true });
    listen(document, 'visibilitychange', function () { if (document.hidden) clear(); });
    cleanup.push(clear);
  }
  function mount() {
    if (mounted) return; mounted = true;
    built = window.SkinShared.createBuilt(); layout = window.HertzShell.beginLayout('hertz');
    var app = document.querySelector('.app'), rail = id('rail'), topbar = document.querySelector('.topbar');
    refs.workspace = make('main', 'hz-workspace', app); refs.workspace.id = 'hz-workspace';
    layout.move(topbar, refs.workspace); layout.move(id('column'), refs.workspace);
    var brand = document.querySelector('.brand'); layout.move(brand, rail, rail.firstChild);
    var mark = make('span', 'hz-brand-name', brand, 'HertzStudio'); mark.setAttribute('aria-hidden', 'true');
    var logo = brand.querySelector('.brand-mark'), originalLogo = logo.innerHTML;
    logo.innerHTML = icon('hz-wave'); cleanup.push(function () { logo.innerHTML = originalLogo; });
    var mobileBrand = make('span', 'hz-mobile-brand', topbar, 'HertzStudio'); topbar.prepend(mobileBrand);
    var libraryEntry = rail.querySelector('[data-view="library"]'), settingsEntry = rail.querySelector('[data-view="settings"]');
    layout.move(settingsEntry, rail, libraryEntry.nextSibling);
    var moreNavigation = make('details', 'hz-extra-nav', rail); rail.insertBefore(moreNavigation, settingsEntry.nextSibling);
    var extraSummary = make('summary', '', moreNavigation); extraSummary.innerHTML = icon('grid'); make('span', '', extraSummary, '更多功能');
    var extraEntries = make('div', 'hz-extra-nav-items', moreNavigation); refs.extraEntries = extraEntries;
    Array.from(rail.querySelectorAll('.rail-item[data-view]')).filter(function (entry) { return !['home', 'library', 'settings'].includes(entry.dataset.view); }).forEach(function (entry) { layout.move(entry, extraEntries); });
    var playlistBlock = make('div', 'hz-rail-playlists', rail); moreNavigation.after(playlistBlock);
    make('p', 'hz-nav-caption', playlistBlock, '我的歌单'); refs.railPlaylists = make('nav', '', playlistBlock); refs.railPlaylists.setAttribute('aria-label', '我的歌单');
    var modes = make('div', 'hz-listening-modes', rail); make('p', 'hz-nav-caption', modes, '聆听方式');
    var group = make('div', 'hz-segmented', modes);
    var daily = button(group, 'is-active', '日常聆听', '', function () { navigate('home'); }); daily.textContent = '日常';
    var immersive = button(group, '', '打开沉浸播放器', '', function () { window.Skins.request('open-player'); }); immersive.textContent = '沉浸';
    var tools = make('div', 'hz-top-tools', topbar); tools.setAttribute('role', 'group'); tools.setAttribute('aria-label', '界面工具');
    var switcher = make('div', 'hz-segmented hz-view-switch', tools); switcher.setAttribute('role', 'group'); switcher.setAttribute('aria-label', '浏览模式');
    refs.listMode = button(switcher, 'is-active', '列表模式', 'queue', function () { if (window.HertzCoverWall) window.HertzCoverWall.close(); }); make('span', '', refs.listMode, '列表');
    refs.coverMode = button(switcher, '', '封面模式', 'grid', function () {
      if (['home', 'settings', 'room', 'reader', 'podcasts'].includes(window.HertzShell.activeView())) navigate('library');
      if (window.HertzCoverWall) window.HertzCoverWall.open();
    }); make('span', '', refs.coverMode, '封面');
    refs.themeToggle = button(tools, 'hz-icon hz-theme-toggle', '切换浅色外观', 'sun', function () { var theme = window.Theme.current(); window.Theme.apply(isDark(theme.tokens['--bg']) ? 'hertz-light' : 'hertz-dark'); });
    refs.queueToggle = button(tools, 'hz-icon hz-queue-toggle', '播放队列', 'queue', function (event) { setQueue(!queueOpen, event.currentTarget); }); refs.queueToggle.setAttribute('aria-controls', 'hz-queue-pane');
    layout.move(topbar.querySelector('.top-right'), tools);
    var menu = id('top-more-menu');
    [['capsule-entry', '胶囊播放器'], ['stage3d-entry', '沉浸声场']].forEach(function (entry) {
      var node = id(entry[0]); layout.move(node, menu); node.classList.add('menu-item'); make('span', '', node, entry[1]);
      cleanup.push(function () { node.classList.remove('menu-item'); });
    });
    // 设置已有侧栏入口；原业务节点保留以便卸载还原，更多菜单只呈现工具。
    var retiredTools = make('div', 'hz-retired-tools', document.body); retiredTools.hidden = true;
    ['settings-entry', 'bar-pin-toggle', 'service-exit'].forEach(function (key) { layout.move(id(key), retiredTools); });
    var transport = make('div', 'hz-bar-center', id('playback-bar'));
    layout.move(document.querySelector('.bar-controls'), transport); layout.move(document.querySelector('.bar-progress'), transport);
    layout.move(id('mode'), document.querySelector('.bar-controls'), id('prev'));
    var lyricButton = button(document.querySelector('.bar-right'), 'ctrl hz-lyrics-button', '打开歌词', 'lyrics', function () { window.Skins.request('open-player'); id('np-tab-lyrics').click(); });
    document.querySelector('.bar-right').prepend(lyricButton);
    // 队列抽屉拦截展示入口，原队列页面仍可管理所有曲目。
    listen(id('bar-queue'), 'click', function (event) { event.preventDefault(); event.stopImmediatePropagation(); setQueue(!queueOpen, event.currentTarget); }, true);
    mountHome(); mountLibrary(); mountPreferences(); mountQueue(app); mountMobile(); mountSidebar(rail, topbar); mountScrollActivity();
    refs.playlistTabs = make('nav', 'hz-library-tabs', id('view-playlists')); refs.playlistTabs.setAttribute('aria-label', '曲库分类');
    id('view-playlists').querySelector('.col-head').after(refs.playlistTabs);
    [['songs', '歌曲'], ['album', '专辑'], ['artist', '歌手'], ['playlist', '歌单']].forEach(function (entry) {
      var tab = button(refs.playlistTabs, '', entry[1], '', function () { if (entry[0] !== 'playlist') { navigate('library'); showLibraryTab(entry[0]); } }); tab.textContent = entry[1]; tab.dataset.kind = entry[0];
    });
    listen(id('np-stage-mobile'), 'click', function () { id('np-stage').click(); });
    if (window.HertzCoverWall) window.HertzCoverWall.mount();
    listen(document, 'hertz:cover-wall', function (event) {
      var open = event.detail.open;
      refs.listMode.classList.toggle('is-active', !open); refs.coverMode.classList.toggle('is-active', open);
      refs.listMode.setAttribute('aria-pressed', String(!open)); refs.coverMode.setAttribute('aria-pressed', String(open)); setQueue(false);
    });
    listen(document, 'playback:track', function () { queueKey = ''; paintQueue(); refreshHome(true); });
    function syncPlaying() { document.body.dataset.hzPlaying = String(window.Stage && window.Stage.presentation().playing); paintQueue(); }
    listen(document, 'stage:playing-changed', syncPlaying); syncPlaying();
    listen(document, 'nav:changed', scheduleSync);
    listen(document, 'keydown', function (event) {
      if (queueOpen && !document.body.classList.contains('np-expanded') && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setQueue(false); }
      if (!queueOpen || !mobile.matches || event.key !== 'Tab') return;
      var nodes = Array.from(refs.queuePane.querySelectorAll('button')).filter(function (b) { return !b.disabled && b.getClientRects().length; });
      var first = nodes[0], last = nodes[nodes.length - 1];
      if (!refs.queuePane.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }, true);
    observer = new MutationObserver(scheduleSync);
    observer.observe(rail, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden'] });
    observer.observe(id('queue-list'), { childList: true, subtree: true });
    observer.observe(id('top-more-menu'), { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    var libraryObserver = new MutationObserver(function () {
      if (window.HertzShell.activeView() === 'home') refreshHome(true);
      if (window.HertzShell.activeView() === 'library' && libraryTab !== 'songs') loadLibraryBrowse(false);
    });
    libraryObserver.observe(id('lib-artist-filter'), { childList: true });
    libraryObserver.observe(id('playlist-list'), { childList: true });
    cleanup.push(function () { libraryObserver.disconnect(); });
    var themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    cleanup.push(function () { themeObserver.disconnect(); document.documentElement.removeAttribute('data-hz-tone'); });
    syncTheme(); scheduleSync();
  }
  function unmount() {
    if (!mounted) return;
    if (sidebarOpen) setSidebar(false, false); setQueue(false); closeMenu(); mounted = false; ++homeEpoch; homeBusy = false; homeAgain = false;
    if (libraryController) libraryController.abort(); libraryController = null; ++libraryEpoch; libraryBusy = false;
    if (observer) observer.disconnect(); cancelAnimationFrame(pendingFrame); pendingFrame = 0;
    cleanup.splice(0).forEach(function (fn) { fn(); });
    if (window.HertzCoverWall) window.HertzCoverWall.unmount();
    layout.restore(); window.HertzShell.releaseLayout('hertz'); built.remove();
    document.body.classList.remove('hz-queue-open', 'hz-sidebar-hidden', 'hz-sidebar-open'); delete document.body.dataset.hzView;
    ['hzAnimated', 'hzWordSync', 'hzLyricSize', 'hzPlaying'].forEach(function (key) { delete document.body.dataset[key]; });
    document.documentElement.style.removeProperty('--hz-ambient-opacity'); id('view-library').removeAttribute('data-hz-library-tab'); id('view-library').removeAttribute('data-hz-library-detail');
    refs = {}; queueKey = ''; lastView = ''; menuKey = ''; libraryTab = 'songs'; libraryDetail = null; sidebarOpen = false; sidebarGesture = null; featuredAlbums = []; featuredIndex = 0;
  }
  window.HertzSkin = { refreshHome: refreshHome, openQueue: function () { setQueue(true); }, selectSettings: function (category) { if (mounted && refs.settingsNav) selectSettings(category); } };
  window.Skins.registerLifecycle('hertz', { mount: mount, unmount: unmount });
})();
