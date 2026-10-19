// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
(function (global) {
  'use strict';
  var root, host, callbacks, el = {}, active = false, timer = null;
  var panel = null, contexts = new Map(), lastViews = new Map(), generation = 0, returnFocus = null;
  var recent = [], discovery = [], quoteEpoch = 0, homeEpoch = 0, continueKey = '';
  var searchSource = 'all', searchTimer = null, searchComposing = false, restoringSearchFocus = false, videoUrl = '';
  var playAction = null, playGeneration = 0;
  var surface = null, panelNetwork = null;

  var iconNames = { play: 'i-play', library: 'i-library', daily: 'i-daily', timer: 'i-timer',
    search: 'i-search', reset: 'i-reset', next: 'i-next', undo: 'i-undo',
    close: 'i-close', playlist: 'i-playlist', disc: 'i-disc', queue: 'i-queue', 'queue-next': 'i-queue-next', radio: 'i-radio', rss: 'i-rss' };
  function icon(name) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    use.setAttribute('href', '#' + (iconNames[name] || iconNames.disc)); svg.appendChild(use);
    return svg.outerHTML;
  }
  function node(tag, cls, text) {
    var n = document.createElement(tag); if (cls) n.className = cls;
    if (text != null) n.textContent = text; return n;
  }
  function button(label, name, action, cls) {
    var b = node('button', cls || 'sh-icon'); b.type = 'button'; b.title = label;
    b.setAttribute('aria-label', label); b.innerHTML = icon(name);
    b.addEventListener('click', action); return b;
  }
  function run(action, control) {
    if (!host || (control && control.disabled)) return Promise.resolve();
    if (control) control.disabled = true;
    return Promise.resolve().then(action).catch(function (error) {
      if (error && error.name === 'AbortError') return;
      host.notify(error && error.message ? error.message : '操作未完成，请重试');
    }).finally(function () { if (control) control.disabled = false; update(); });
  }
  function cover(img, item, playlist) {
    var key = [item.id, item.cover || '', item.has_cover || false].join('|');
    img.dataset.coverKey = key;
    host.applyCover(img, '');
    var request = playlist && !item.online ? host.playlistCover(item.id) : host.cover(item);
    Promise.resolve(request).then(function (url) {
      if (img.dataset.coverKey === key && img.isConnected) host.applyCover(img, url || '');
    }, function () {});
  }
  function art(item, playlist) {
    var frame = node('span', 'sh-art');
    frame.innerHTML = icon(playlist ? 'playlist' : 'disc');
    var img = node('img'); img.alt = ''; img.loading = 'lazy'; frame.appendChild(img);
    cover(img, item, playlist); return frame;
  }
  function clock() {
    var d = new Date();
    el.time.textContent = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    el.date.textContent = d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  }
  function init(container, nextCallbacks) {
    if (root || !container) return;
    root = container; callbacks = nextCallbacks || {}; root.classList.add('space-home');
    root.innerHTML = [
      '<header class="sh-header"><form class="sh-search" role="search"><button type="submit" title="搜索" aria-label="搜索">' + icon('search') + '</button><label class="sh-sr" for="sh-query">搜索音乐</label><input id="sh-query" type="search" placeholder="搜索歌曲、歌手..." autocomplete="off" spellcheck="false"></form><div class="sh-search-modes" role="tablist" aria-label="搜索来源"></div></header>',
      '<div class="sh-shell"><section class="sh-daily-review"><video class="sh-video" muted loop playsinline hidden></video><div class="sh-date"></div><div class="sh-time"></div><blockquote class="sh-quote" aria-live="polite"></blockquote><div class="sh-quote-foot"><span class="sh-quote-source"></span></div><div class="sh-review-actions"><button type="button" class="sh-quote-next" title="换一条每日内容" aria-label="换一条每日内容">' + icon('reset') + '</button><button type="button" class="sh-video-choose" title="选择 MP4" aria-label="选择 MP4">' + icon('disc') + '</button><button type="button" class="sh-video-clear" hidden title="移除视频" aria-label="移除视频">' + icon('close') + '</button><button type="button" class="sh-player-open" title="展开播放器控制台" aria-label="展开播放器控制台">' + icon('play') + '</button></div><input class="sh-video-input" type="file" accept=".mp4,video/mp4" hidden></section>',
      '<div class="sh-home-content"><div class="sh-actions" aria-label="音乐入口"></div><button class="sh-next-up" type="button"><span class="sh-next-art"></span><span class="sh-next-copy"><span class="sh-eyebrow">NEXT UP · 接下来播放</span><strong></strong><small></small></span>' + icon('next') + '</button>',
      '<section class="sh-discovery"><header><div><span class="sh-eyebrow">FOR YOU</span><h2>为你挑选</h2></div><button type="button" class="sh-discovery-more">每日推荐 ' + icon('next') + '</button></header><div class="sh-discovery-list" aria-live="polite"></div></section><section class="sh-recent"><header><div><span class="sh-eyebrow">RECENT</span><h2>最近聆听</h2></div><button type="button" class="sh-recent-more">全部记录 ' + icon('next') + '</button></header><div class="sh-recent-list" aria-live="polite"></div></section></div></div>',
      '<div class="sh-panel-layer" hidden><div class="sh-scrim"></div><section class="sh-panel" id="sh-panel" role="dialog" aria-modal="true" aria-labelledby="sh-panel-title"><header class="sh-panel-head"><div class="sh-panel-leading"></div><h2 id="sh-panel-title"></h2><div class="sh-panel-tools"></div></header><div class="sh-panel-controls"></div><div class="sh-panel-body" tabindex="-1"></div></section></div>'
    ].join('');
    ['time', 'date', 'quote', 'quote-source', 'quote-next', 'actions', 'search', 'discovery-list', 'recent-list', 'panel-layer', 'panel', 'panel-leading', 'panel-tools', 'panel-controls', 'panel-body'].forEach(function (key) { el[key.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); })] = root.querySelector('.sh-' + key); });
    el.query = root.querySelector('#sh-query'); el.panelTitle = root.querySelector('#sh-panel-title');
    el.searchDock = root.querySelector('.sh-header'); el.searchModes = root.querySelector('.sh-search-modes');
    el.video = root.querySelector('.sh-video'); el.videoInput = root.querySelector('.sh-video-input'); el.videoClear = root.querySelector('.sh-video-clear');
    el.nextUp = root.querySelector('.sh-next-up');
    if (callbacks.chromeRoot) { callbacks.chromeRoot.append(el.searchDock, el.panelLayer); }
    el.search.addEventListener('submit', function (event) {
      event.preventDefault(); search(true);
    });
    el.query.addEventListener('focus', function () { if (restoringSearchFocus) return; el.searchDock.classList.add('is-expanded'); if (!el.query.value.trim()) searchHistory(); });
    el.query.addEventListener('compositionstart', function () { searchComposing = true; clearTimeout(searchTimer); });
    el.query.addEventListener('compositionend', function () { searchComposing = false; scheduleSearch(); });
    el.query.addEventListener('input', scheduleSearch);
    el.query.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown' && !el.panelLayer.hidden && panel && panel.kind === 'search') {
        var first = el.panelBody.querySelector('button'); if (first) { event.preventDefault(); first.focus(); }
      }
    });
    el.quoteNext.addEventListener('click', loadQuote);
    root.querySelector('.sh-player-open').addEventListener('click', function () { if (callbacks.revealPlayer) callbacks.revealPlayer(); });
    root.querySelector('.sh-video-choose').addEventListener('click', function () { el.videoInput.click(); });
    el.videoInput.addEventListener('change', function () {
      var file = this.files[0]; if (!file) return;
      if (!/\.mp4$/i.test(file.name) || file.size > 200 * 1024 * 1024) { if (host) host.notify('请选择小于 200 MB 的 MP4'); this.value = ''; return; }
      clearVideo(); videoUrl = URL.createObjectURL(file); el.video.src = videoUrl; el.video.hidden = false; el.videoClear.hidden = false;
      root.querySelector('.sh-daily-review').classList.add('has-video'); el.video.play().catch(function () {}); this.value = '';
    });
    el.videoClear.addEventListener('click', clearVideo);
    el.nextUp.addEventListener('click', function () { var next = host && host.read().next; if (next && host.playNext) run(host.playNext, el.nextUp); else openEntry({kind:'library',source:'local',offset:0}); });
    document.addEventListener('visibilitychange', function () { if (el.video.hidden) return; if (document.hidden || !active) el.video.pause(); else el.video.play().catch(function () {}); });
    root.querySelector('.sh-discovery-more').addEventListener('click', function () { open({ kind: 'daily', source: 'online', offset: 0 }); });
    root.querySelector('.sh-recent-more').addEventListener('click', function () { open({ kind: 'recent', offset: 0 }); });
    el.panelLayer.querySelector('.sh-scrim').addEventListener('click', function () { closePanel(); });
    el.panel.addEventListener('pointerdown', function (event) { event.stopPropagation(); });
    el.panel.addEventListener('wheel', function (event) { event.stopPropagation(); });
    document.addEventListener('pointerdown', function(event){
      if (!el.panelLayer.hidden && !el.panel.contains(event.target) && !el.searchDock.contains(event.target)) closePanel({restoreFocus:false});
    },true);
    el.panel.addEventListener('keydown', function (event) {
      if (event.key !== 'Tab') return;
      var controls = Array.from(el.panel.querySelectorAll('button:not(:disabled),input,select,[tabindex="0"]')).filter(function (n) { return !n.hidden && n.getClientRects().length; });
      if (!controls.length) return;
      var first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !el.panel.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    [['continue', 'CONTINUE', '继续播放', 'play'], ['library', 'LIBRARY', '音乐库', 'library'], ['daily', 'DAILY MIX', '每日推荐', 'daily'], ['recent', 'RECENT', '最近播放', 'timer'], ['radio', 'RADIO', '电台', 'radio'], ['podcasts', 'PODCASTS', 'RSS · 播客', 'rss']].forEach(function (entry) {
      var b = node('button', 'sh-action sh-action-' + entry[0]); b.type = 'button';
      b.dataset.entry = entry[0];
      if (entry[0] !== 'continue') { b.setAttribute('aria-haspopup', 'dialog'); b.setAttribute('aria-controls', 'sh-panel'); b.setAttribute('aria-expanded', 'false'); }
      b.innerHTML = '<span class="sh-action-copy"><span class="sh-eyebrow">' + entry[1] + '</span><strong>' + entry[2] + '</strong><span class="sh-action-detail"></span></span><span class="sh-action-cover">' + icon(entry[3]) + '<img alt=""></span>';
      b.addEventListener('click', function () {
        if (entry[0] === 'continue') return continuePlayback(b);
        openEntry({ kind: entry[0], source: entry[0] === 'daily' ? 'online' : 'local', offset: 0 });
      });
      el.actions.appendChild(b); el[entry[0] + 'Action'] = b;
    });
    clock();
  }
  function bind(nextHost) { host = nextHost; if (root) { buildSearchModes(); update(); } }
  function clearVideo() {
    el.video.pause(); el.video.removeAttribute('src'); el.video.load(); el.video.hidden = true; el.videoClear.hidden = true;
    root.querySelector('.sh-daily-review').classList.remove('has-video'); if (videoUrl) URL.revokeObjectURL(videoUrl); videoUrl = '';
  }
  function buildSearchModes() {
    if (!host) return;
    var sources = [{id:'all',name:'All'},{id:'local',name:'本地'}].concat(host.read().sources || []);
    sources.forEach(function (source) {
      if (Array.from(el.searchModes.children).some(function(b){return b.dataset.source === source.id;})) return;
      var b = node('button', '', source.label || source.name || source.id); b.type = 'button'; b.dataset.source = source.id; b.setAttribute('role','tab');
      b.addEventListener('click', function () { searchSource = source.id; buildSearchModes(); search(false); }); el.searchModes.appendChild(b);
    });
    el.searchModes.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-selected',String(b.dataset.source === searchSource)); });
  }
  function scheduleSearch() {
    cancelPanelSearch(); clearTimeout(searchTimer);
    if (panel && panel.kind === 'search') {
      panel.items = null; panel.sourceStates = null; panel.loading = true; renderPanelItems();
    }
    if (!searchComposing) {
      if (!el.query.value.trim()) search(false);
      else searchTimer = setTimeout(function () { search(false); }, 400);
    }
  }
  function search(commit) {
    clearTimeout(searchTimer); if (searchComposing || !host) return;
    var q = el.query.value.trim(); el.searchDock.classList.add('is-expanded');
    if (!q) { searchHistory(); return; }
    if (commit && global.HertzSearchHistory) HertzSearchHistory.push(q);
    open({kind:'search',q:q,source:searchSource,offset:0});
  }
  function searchHistory() {
    var items = global.HertzSearchHistory ? HertzSearchHistory.all() : [];
    open({kind:'search',q:'',source:searchSource,offset:0,items:[],history:true}); el.panelBody.replaceChildren();
    var head = node('div','sh-history-head'); head.appendChild(node('strong','','搜索历史'));
    if (items.length) head.appendChild(button('清空搜索历史','close',function () { HertzSearchHistory.clear(); searchHistory(); }));
    el.panelBody.appendChild(head);
    if (!items.length) el.panelBody.appendChild(node('p','sh-state','还没有搜索记录'));
    items.forEach(function (q) { var b = node('button','sh-history-item',q); b.type='button'; b.addEventListener('click',function () { el.query.value=q; search(true); }); el.panelBody.appendChild(b); });
  }
  function contextKey(spec) { return [spec.kind, spec.source || '', spec.provider || '', spec.q || '', spec.playlist ? spec.playlist.id : '', spec.offset || 0].join('|'); }
  function remember() {
    if (panel) { panel.scroll = el.panelBody.scrollTop; contexts.set(contextKey(panel), panel); }
  }
  function openEntry(spec) {
    var last = lastViews.get(spec.kind);
    open(last && (spec.kind !== 'search' || spec.q === last.q) ? last : spec);
  }
  function open(spec) {
    if (!host) return;
    if (callbacks.beforeOpenPanel) callbacks.beforeOpenPanel();
    remember(); cancelPanelSearch(); releaseSurface(); if (el.panelLayer.hidden) returnFocus = document.activeElement;
    var saved = contexts.get(contextKey(spec)); panel = saved || Object.assign({ scroll: 0, items: null }, spec);
    lastViews.set(panel.kind === 'playlist' ? 'library' : panel.kind, panel);
    el.panelLayer.hidden = false; drawPanel();
    syncSelection();
    if (spec.kind !== 'search') el.panelBody.focus({ preventScroll: true });
    if (spec.kind === 'radio' || spec.kind === 'podcasts') return;
    if (!panel.items || panel.loading || spec.kind === 'search') loadPanel();
  }
  function cancelPanelSearch() {
    generation += 1;
    if (panelNetwork) panelNetwork.cancel();
    panelNetwork = null;
  }
  function releaseSurface() { if (surface) { surface.dispose(); surface = null; } }
  function syncSelection() {
    var selected = !el.panelLayer.hidden && panel ? panel.kind === 'playlist' ? 'library' : panel.kind : '';
    el.actions.querySelectorAll('[data-entry]').forEach(function (control) {
      var on = control.dataset.entry === selected;
      control.classList.toggle('is-active', !!on);
      if (control.hasAttribute('aria-expanded')) control.setAttribute('aria-expanded', String(!!on));
    });
  }
  function closePanel(options) {
    if (!root) return false;
    el.searchDock.classList.remove('is-expanded'); clearTimeout(searchTimer);
    if (el.panelLayer.hidden) return false;
    remember(); cancelPanelSearch(); releaseSurface(); el.panelLayer.hidden = true; syncSelection();
    restoringSearchFocus = true;
    try { if ((!options || options.restoreFocus !== false) && returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true }); }
    finally { restoringSearchFocus = false; }
    if (callbacks.revealPlayer) callbacks.revealPlayer();
    return true;
  }
  function tabs(options, selected, change) {
    var row = node('div', 'sh-tabs'); row.setAttribute('role', 'group');
    options.forEach(function (option) {
      var b = node('button', selected === option[0] ? 'is-selected' : '', option[1]); b.type = 'button';
      b.setAttribute('aria-pressed', String(selected === option[0])); b.addEventListener('click', function () { change(option[0]); }); row.appendChild(b);
    }); return row;
  }
  function drawPanel() {
    var spec = panel;
    el.panelLayer.dataset.kind = spec.kind;
    el.panelLayer.classList.toggle('is-search', spec.kind === 'search');
    el.panelTitle.textContent = spec.kind === 'playlist' ? spec.playlist.name : { library: '音乐库', search: '搜索 · ' + (spec.q || ''), daily: '每日推荐', recent: '最近播放', radio: '电台 · 私人 FM', podcasts: 'RSS · 播客' }[spec.kind];
    el.panelLeading.replaceChildren(); el.panelTools.replaceChildren(); el.panelControls.replaceChildren();
    if (spec.kind === 'playlist') el.panelLeading.appendChild(button('返回歌单', 'undo', function () { open(spec.parent); }));
    el.panelTools.appendChild(button('刷新', 'reset', function () { if (spec.kind === 'radio' || spec.kind === 'podcasts') { if (surface) return run(surface.refresh); return drawPanel(); } panel.items = null; loadPanel(); }));
    el.panelTools.appendChild(button('关闭', 'close', closePanel));
    if (spec.kind === 'radio' || spec.kind === 'podcasts') {
      el.panelBody.replaceChildren(); el.panelBody.setAttribute('aria-busy', 'false');
      try { surface = host.mountSurface(spec.kind, el.panelBody); run(surface.refresh); }
      catch (error) { el.panelBody.appendChild(node('p', 'sh-state', error.message || '暂时无法打开，请重试')); }
      return;
    }
    if (spec.kind === 'library') el.panelControls.appendChild(tabs([['local', '本地音乐'], ['playlists', '歌单'], ['online', '在线音乐']], spec.source, function (source) { open({ kind: 'library', source: source, offset: 0 }); }));
    if (spec.kind === 'daily') el.panelControls.appendChild(tabs([['online', '在线推荐'], ['local', '本地推荐']], spec.source, function (source) { open({ kind: 'daily', source: source, offset: 0 }); }));
    if (spec.kind === 'library' && spec.source === 'online') {
      var select = node('select', 'sh-source'); select.setAttribute('aria-label', '搜索来源');
      var sources = host.read().sources || [];
      if (spec.kind === 'search') sources = [{ id: 'local', name: '本地音乐' }].concat(sources);
      sources.forEach(function (source) { var opt = node('option', '', source.name || source.label || source.id); opt.value = source.id; select.appendChild(opt); });
      if (spec.source === 'online' && sources[0]) spec.provider = spec.provider || sources[0].id;
      select.value = spec.provider || spec.source; select.addEventListener('change', function () {
        open({ kind: spec.kind, q: spec.q, source: spec.kind === 'search' ? select.value : 'online', provider: select.value, offset: 0 });
      }); el.panelControls.appendChild(select);
    }
    if (spec.kind === 'library' && spec.source === 'online') {
      var form = node('form', 'sh-inline-search'), input = node('input'); input.type = 'search'; input.placeholder = '搜索在线音乐'; input.setAttribute('aria-label', '搜索在线音乐'); input.value = spec.q || '';
      var submit = button('搜索', 'search', function () {}); submit.type = 'submit'; form.append(input, submit);
      form.addEventListener('submit', function (event) { event.preventDefault(); open({ kind: 'library', source: 'online', provider: select.value, q: input.value.trim(), offset: 0 }); }); el.panelControls.appendChild(form);
    }
    if (spec.kind === 'playlist') {
      var detail = node('div', 'sh-playlist-summary'); detail.appendChild(art(spec.playlist, true));
      var copy = node('div'); copy.appendChild(node('p', '', spec.playlist.sourceLabel || '本地歌单')); copy.appendChild(node('p', '', (spec.items ? spec.items.length : spec.playlist.track_count || 0) + ' 首')); detail.appendChild(copy);
      var play = button('播放歌单', 'play', function () { if (spec.items && spec.items.length) run(function () { return host.play(spec.items[0], spec.items); }, play); }); detail.appendChild(play);
      var queue = button('歌单加入队列', 'queue', function () { if (spec.items && spec.items.length) run(function () { return host.enqueue(null, spec.items); }, queue); }); detail.appendChild(queue);
      el.panelControls.appendChild(detail);
    }
    renderPanelItems();
  }
  function renderPanelItems() {
    var spec = panel, body = el.panelBody, focused = document.activeElement;
    var focusKey = focused && focused.dataset && focused.dataset.searchKey;
    var oldScroll = body.scrollTop;
    var anchor = Array.from(body.querySelectorAll('.sh-track')).find(function (row) {
      return row.getBoundingClientRect().bottom > body.getBoundingClientRect().top;
    });
    var anchorId = anchor && anchor.dataset.trackId, anchorTop = anchor && anchor.getBoundingClientRect().top;
    el.panelBody.replaceChildren();
    el.panelBody.setAttribute('aria-busy', String(!!spec.loading));
    if (!spec.items) {
      var loading = node('p', 'sh-state', '正在读取音乐…');
      if (focusKey === 'panel:retry') {
        loading.tabIndex = -1;
        loading.dataset.searchKey = focusKey;
      }
      el.panelBody.appendChild(loading);
      if (focusKey === 'panel:retry') loading.focus({ preventScroll: true });
      return;
    }
    if (spec.note) el.panelBody.appendChild(node('p', 'sh-state', spec.note));
    if (spec.error) {
      var retry = node('button', 'sh-retry', '重试');
      retry.dataset.searchKey = 'panel:retry';
      retry.addEventListener('click', function () { loadPanel(); });
      el.panelBody.appendChild(retry);
      if (focusKey === 'panel:retry') retry.focus({ preventScroll: true });
      return;
    }
    if (!spec.items.length && !spec.note && !spec.loading) el.panelBody.appendChild(node('p', 'sh-state', spec.kind === 'search' ? '没有找到匹配的音乐' : spec.kind === 'recent' ? '还没有播放记录' : '这里还没有音乐'));
    if (spec.kind === 'library' && spec.source === 'playlists') {
      var grid = node('div', 'sh-playlists');
      spec.items.forEach(function (item) {
        var b = node('button', 'sh-playlist'); b.type = 'button'; b.appendChild(art(item, true)); b.appendChild(node('strong', '', item.name)); b.appendChild(node('span', '', (item.sourceLabel || '本地') + ' · ' + (item.track_count || 0) + ' 首'));
        b.addEventListener('click', function () { remember(); open({ kind: 'playlist', playlist: item, parent: spec, offset: 0 }); }); grid.appendChild(b);
      }); el.panelBody.appendChild(grid);
    } else if (spec.sourceStates) {
      spec.sourceStates.forEach(function (source) {
        var label = source.source === 'local' ? '本地' : global.Online ? Online.sourceLabel(source.source) : source.source;
        var section = node('section', 'sh-search-source'); section.dataset.source = source.source;
        section.appendChild(node('h3', 'sh-state', label));
        trackList(section, spec.items.filter(function (item) { return item.source === source.source; }), spec);
        var text = source.loading ? '搜索中…' : source.error ? source.error.label
          : source.count ? source.count + ' 首已加载' : '没有匹配的音乐';
        var status = node('p', 'sh-state', text);
        status.tabIndex = -1;
        status.dataset.searchStatus = 'true';
        if (source.error) status.dataset.errorCode = source.error.code;
        if (source.error) status.dataset.requestId = source.error.requestId;
        section.appendChild(status);
        if (!source.loading && ((source.error && source.error.retryable) || (!source.error && source.more))) {
          var more = node('button', 'sh-retry', source.error ? '重试 ' + label : '加载更多 · ' + label);
          more.type = 'button'; more.dataset.searchKey = 'source:' + source.source;
          more.addEventListener('click', source.error ? source.retry : source.next); section.appendChild(more);
        }
        el.panelBody.appendChild(section);
      });
    } else trackList(el.panelBody, spec.items, spec);
    if (spec.loading) el.panelBody.appendChild(node('p', 'sh-state', '正在搜索其他音源…'));
    if (!spec.sourceStates && (spec.nextOffset < spec.total || spec.offset)) {
      var pages = node('div', 'sh-pages');
      var pagePrev = node('button', '', '上一页'), pageNext = node('button', '', '下一页'); pagePrev.type = pageNext.type = 'button'; pagePrev.disabled = !spec.offset; pageNext.disabled = spec.nextOffset >= spec.total || spec.nextOffset <= spec.offset;
      pagePrev.addEventListener('click', function () {
        var offsets = (spec.previousOffsets || []).slice(), offset = offsets.pop();
        open(Object.assign({}, spec, { offset: offset == null ? 0 : offset, previousOffsets: offsets, items: null, scroll: 0 }));
      });
      pageNext.addEventListener('click', function () {
        open(Object.assign({}, spec, { offset: spec.nextOffset, previousOffsets: (spec.previousOffsets || []).concat(spec.offset), items: null, scroll: 0 }));
      }); pages.append(pagePrev, node('span', '', (spec.offset + 1) + '–' + spec.nextOffset + ' / ' + spec.total), pageNext); el.panelBody.appendChild(pages);
    }
    el.panelBody.scrollTop = oldScroll || spec.scroll || 0;
    if (anchorId) {
      var restored = spec.rows && spec.rows.get(anchorId);
      if (restored && restored.isConnected) body.scrollTop += restored.getBoundingClientRect().top - anchorTop;
    }
    var restoredFocus = false;
    if (focusKey) body.querySelectorAll('[data-search-key]').forEach(function (control) {
      if (control.dataset.searchKey === focusKey) {
        control.focus({preventScroll:true});
        restoredFocus = true;
      }
    });
    if (!restoredFocus && focusKey && focusKey.indexOf('source:') === 0) {
      var focusSource = focusKey.slice('source:'.length);
      body.querySelectorAll('.sh-search-source').forEach(function (section) {
        if (section.dataset.source === focusSource) {
          var status = section.querySelector('[data-search-status]');
          if (status) status.focus({preventScroll:true});
        }
      });
    }
    if (!restoredFocus && focusKey === 'panel:retry') body.focus({ preventScroll: true });
    updateRows();
  }
  async function loadPanel() {
    cancelPanelSearch();
    var spec = panel, ticket = ++generation;
    panelNetwork = host.beginSearch ? host.beginSearch() : null;
    var network = panelNetwork;
    spec.sourceStates = null; spec.rows = new Map(); spec.error = false; spec.loading = true; spec.items = null; spec.note = ''; renderPanelItems();
    try {
      var result;
      if (spec.kind === 'playlist') result = await host.playlist(spec.playlist, spec.offset);
      else if (spec.kind === 'daily') result = await host.daily(spec.source);
      else if (spec.kind === 'recent') result = await host.recent(spec.offset);
      else if (spec.kind === 'library' && spec.source === 'playlists') result = await host.playlists();
      else result = await host.library({ q: spec.q || '', offset: spec.offset, source: spec.provider || spec.source, network:network,
        onResults: function (partial) {
          if (ticket !== generation || panel !== spec) return;
          spec.items = partial.items; spec.total = partial.total; spec.nextOffset = partial.nextOffset;
          spec.sourceStates = partial.sourceStates; spec.loading = partial.loading;
          renderPanelItems();
        } });
      if (ticket !== generation || panel !== spec) return;
      spec.items = result.items || []; spec.total = result.total || spec.items.length; spec.note = result.note || '';
      spec.sourceStates = result.sourceStates;
      spec.nextOffset = result.nextOffset == null ? spec.offset + spec.items.length : result.nextOffset;
    } catch (error) { if (ticket !== generation || panel !== spec) return; spec.items = []; spec.error = true; spec.note = error.message || '读取失败，请重试'; }
    spec.loading = false; contexts.set(contextKey(spec), spec);
    if (ticket === generation && panel === spec) drawPanel();
  }
  function trackList(container, items, spec) {
    items.forEach(function (item) {
      if (spec && spec.rows && spec.rows.has(item.id)) { container.appendChild(spec.rows.get(item.id)); return; }
      var row = node('div', 'sh-track'); row.dataset.trackId = item.id;
      var play = node('button', 'sh-track-main'); play.type = 'button'; play.setAttribute('aria-label', '播放 ' + item.title);
      var artwork = art(item), cue = node('span', 'sh-track-cue'); cue.innerHTML = icon('play'); artwork.appendChild(cue); play.appendChild(artwork);
      var title = item.title || '未知曲目', artist = item.artist || '未知艺术家', album = item.album || '未知专辑';
      var source = item.source || (String(item.id).startsWith('online:') ? String(item.id).split(':')[1] : 'local');
      var label = source === 'local' ? '本地' : global.Online ? Online.sourceLabel(source) : source;
      play.title = [title, artist, label, album].join(' · ');
      var text = node('span', 'sh-track-copy'), heading = node('span', 'sh-song-title');
      heading.appendChild(node('strong', '', title));
      if (global.Online) Online.syncVipTag(heading, item);
      text.appendChild(heading);
      var meta = node('span', 'sh-track-meta');
      var origin = global.Online ? Online.badge(source, label) : node('span', '', label);
      origin.classList.add('sh-track-source');
      meta.append(origin, node('span', 'sh-track-artist', artist));
      var albumText = node('span', 'sh-track-album', album); albumText.title = album; meta.appendChild(albumText);
      text.appendChild(meta); var status = node('span', 'sh-track-status'); status.setAttribute('role','status'); status.hidden = true; text.appendChild(status); play.appendChild(text);
      play.dataset.searchKey = 'track:' + item.id;
      play.addEventListener('click', function () { activateTrack(item, spec ? spec.items : items); });
      var queue = button('加入队列 · ' + item.title, 'queue-next', function () { run(function () { return host.enqueue(item); }, queue); });
      queue.dataset.searchKey = 'queue:' + item.id;
      if (spec && spec.rows) spec.rows.set(item.id, row);
      row.append(play, queue); container.appendChild(row);
    });
  }
  async function activateTrack(item, items) {
    if (playAction && playAction.id === item.id && playAction.pending) return;
    var ticket = ++playGeneration; playAction = {id:item.id,pending:true,error:''}; updateRows();
    if (callbacks.revealPlayer) callbacks.revealPlayer();
    try {
      var result = await host.play(item, items);
      if (result === false) throw new Error('无法播放《' + (item.title || '当前曲目') + '》，请重试或切换音源');
      if (ticket === playGeneration) playAction = null;
    } catch (error) {
      if (ticket === playGeneration) {
        playAction = {id:item.id,pending:false,error:error.message || '播放失败，请重试'};
        host.notify(playAction.error);
      }
    } finally { if (ticket === playGeneration) update(); }
  }
  function playbackError(message) {
    if (!playAction || !playAction.pending) return;
    playGeneration += 1; playAction = {id:playAction.id,pending:false,error:message || '播放失败，请重试'};
    updateRows();
  }
  function updateRows() {
    if (!root || !host) return; var snapshot = host.read();
    [root, el.panelBody].forEach(function (container) { container.querySelectorAll('.sh-track').forEach(function (row) {
      var current = !!snapshot.current && row.dataset.trackId === snapshot.current.id;
      var action = playAction && playAction.id === row.dataset.trackId ? playAction : null;
      var pending = !!(action && action.pending), error = action && action.error;
      row.classList.toggle('is-current', current); row.classList.toggle('is-playing', current && snapshot.playing);
      row.classList.toggle('is-loading', pending); row.classList.toggle('has-error', !!error);
      if (current) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
      var control = row.querySelector('.sh-track-main'); control.disabled = pending; control.setAttribute('aria-busy',String(pending));
      var status = row.querySelector('.sh-track-status'); status.hidden = !pending && !error;
      status.textContent = pending ? '正在载入…' : error || ''; status.title = error || '';
    }); });
  }
  function update() {
    if (!host || !root) return;
    var snap = host.read(), current = snap.current, item = current || recent[0]; buildSearchModes();
    el.nextUp.querySelector('strong').textContent = snap.next ? snap.next.title || '下一首' : '队列里还没有歌曲';
    el.nextUp.querySelector('small').textContent = snap.next ? snap.next.artist || '未知艺术家' : '打开音乐库';
    var nextArt = el.nextUp.querySelector('.sh-next-art'), nextKey = snap.next ? snap.next.id : '';
    if (nextArt.dataset.track !== nextKey) { nextArt.dataset.track=nextKey; nextArt.replaceChildren(); if(snap.next)nextArt.appendChild(art(snap.next)); else nextArt.innerHTML=icon('disc'); }
    if (global.Online) Online.syncVipTag(nextArt, snap.next);
    var detail = current ? (current.artist || '未知艺术家') + (snap.playing ? ' · 正在播放' : ' · 接着听') : snap.queueLength ? snap.queueLength + ' 首歌曲在队列中' : item ? item.title : '从喜欢的音乐开始';
    el.continueAction.querySelector('.sh-action-detail').textContent = detail;
    el.continueAction.querySelector('strong').textContent = current ? current.title || '当前曲目' : '继续播放'; el.continueAction.disabled = !!snap.pending;
    el.continueAction.title = current ? (snap.playing ? '打开播放队列：' : '继续播放：') + (current.title || '当前曲目') : '继续播放';
    el.libraryAction.querySelector('.sh-action-detail').textContent = '本地音乐与收藏歌单';
    el.dailyAction.querySelector('.sh-action-detail').textContent = discovery.length ? discovery.length + ' 首今日推荐' : '今天的新声音';
    el.recentAction.querySelector('.sh-action-detail').textContent = recent.length ? recent[0].title : '聆听留下的足迹';
    el.radioAction.querySelector('.sh-action-detail').textContent = '私人 FM · 连续推荐';
    el.podcastsAction.querySelector('.sh-action-detail').textContent = '发现节目与 RSS 订阅';
    var key = item ? [item.id, item.cover || '', item.has_cover || false].join('|') : '';
    if (key !== continueKey) { continueKey = key; var img = el.continueAction.querySelector('img'); if (item) cover(img, item); else { img.dataset.coverKey = ''; host.applyCover(img, ''); } }
    if (global.Online) Online.syncVipTag(el.continueAction.querySelector('.sh-action-cover'), item);
    [[el.dailyAction, discovery[0]], [el.recentAction, recent[0]], [el.libraryAction, snap.libraryPreview]].forEach(function (entry) {
      var img = entry[0].querySelector('img'), track = entry[1];
      if (!track) return;
      var artKey = [track.id, track.cover || '', track.has_cover || false].join('|');
      if (img.dataset.coverKey !== artKey) cover(img, track);
    });
    updateRows();
  }
  function continuePlayback(control) {
    var snap = host.read();
    if (snap.playing || (!snap.current && snap.queueLength)) return host.queue();
    if (snap.current) return run(function () { return host.resume(); }, control);
    if (recent.length) return run(function () { return host.play(recent[0], [recent[0]]); }, control);
    openEntry({ kind: 'library', source: 'local', offset: 0 });
  }
  async function loadQuote() {
    if (!host) return; var ticket = ++quoteEpoch; el.quoteNext.disabled = true;
    try { var quote = await host.quote(); if (ticket !== quoteEpoch) return; el.quote.textContent = quote.text; el.quoteSource.textContent = quote.source || ''; }
    catch (_) { if (ticket === quoteEpoch) { el.quote.textContent = '每日内容暂时无法读取'; el.quoteSource.textContent = ''; } }
    finally { if (ticket === quoteEpoch) el.quoteNext.disabled = false; }
  }
  function refreshHome() {
    var ticket = ++homeEpoch;
    el.discoveryList.textContent = '正在读取今日推荐…'; el.recentList.textContent = '正在读取播放记录…';
    run(async function () {
      try {
        var result = await host.daily('auto'); if (ticket !== homeEpoch) return;
        discovery = result.items.slice(0, 6); el.discoveryList.replaceChildren();
        if (discovery.length) trackList(el.discoveryList, discovery); else el.discoveryList.appendChild(node('p', 'sh-state', result.note || '今天还没有推荐')); update();
      } catch (_) { if (ticket === homeEpoch) homeFailure(el.discoveryList, '每日推荐暂时无法读取'); }
    });
    run(async function () {
      try {
        var result = await host.recent(0); if (ticket !== homeEpoch) return;
        recent = result.items.slice(0, 4); el.recentList.replaceChildren();
        if (recent.length) trackList(el.recentList, recent); else el.recentList.appendChild(node('p', 'sh-state', '还没有播放记录')); update();
      } catch (_) { if (ticket === homeEpoch) homeFailure(el.recentList, '最近播放暂时无法读取'); }
    }); loadQuote();
  }
  function homeFailure(container, message) {
    container.replaceChildren(node('p', 'sh-state', message));
    var retry = node('button', 'sh-retry', '重试'); retry.type = 'button'; retry.addEventListener('click', refreshHome); container.appendChild(retry);
  }
  function enter() {
    if (!root) return; closePanel({restoreFocus:false}); active = true; root.hidden = false; el.panelLayer.hidden = true; clock(); update();
    if (videoUrl && !document.hidden) el.video.play().catch(function () {});
    if (!timer) timer = setInterval(clock, 1000); if (host) refreshHome();
  }
  function leave() { active = false; remember(); closePanel(); el.video.pause(); if (root) root.hidden = true; if (timer) clearInterval(timer); timer = null; clearTimeout(searchTimer); }
  global.SpaceHome = { init: init, bind: bind, enter: enter, leave: leave, update: update, closePanel: closePanel,
    focusSearch: function () { el.query.focus(); search(false); }, playbackError:playbackError, isPanelOpen:function(){return !el.panelLayer.hidden;} };
}(window));
