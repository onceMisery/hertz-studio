// SPDX-License-Identifier: MIT
// Commands and data belong to app.js; Stage owns lyric timing and the only frame loop.
(function () {
  'use strict';
  var el = {}, actions, opened = false, trigger, background = [], moves = [], eqMoves = [];
  var linesRef, rows = [], active = -2, browsing = false, resize, queueKey = '', lyricStatus = 'empty', view = 'cover';
  function time(ms) { var s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  function move(node, parent, records) {
    if (!node) return;
    var anchor = document.createComment('ordinary-player');
    node.before(anchor); records.push({ node: node, anchor: anchor }); parent.appendChild(node);
  }
  function restore(records) { records.reverse().forEach(function (m) { m.anchor.replaceWith(m.node); }); records.length = 0; }
  function selectView(next) {
    view = next; el.modal.dataset.view = next;
    el.coverTab.setAttribute('aria-pressed', String(next === 'cover'));
    el.lyricsTab.setAttribute('aria-pressed', String(next === 'lyrics')); positionLine();
  }
  function showQueue(show) {
    el.queuePane.hidden = !show; el.reading.hidden = show;
    el.queue.setAttribute('aria-expanded', String(show));
    if (show) { paintQueue(); el.queueClose.focus(); }
    else { positionLine(); el.queue.focus(); }
  }
  function showTools(show) {
    if (!show && actions.closeLyricImport) actions.closeLyricImport();
    el.tools.hidden = !show; el.more.setAttribute('aria-expanded', String(show));
    if (show) el.toolsClose.focus();
    else { el.eqPane.hidden = true; restore(eqMoves); el.more.focus(); }
  }
  function showEq() {
    if (!eqMoves.length) {
      move(document.getElementById('dsp-eq-row').closest('.set-group'), el.eqPane, eqMoves);
      Skins.request('settings-enter', { sections: ['dsp'] });
    }
    el.eqPane.hidden = !el.eqPane.hidden;
  }
  function positionLine() {
    if (!opened || browsing || !rows.length || el.reading.hidden || !el.reading.getBoundingClientRect().height) return;
    var row = rows[Math.max(0, active)]; if (!row) return;
    el.scroll.scrollTop = row.button.offsetTop - el.lines.offsetTop - el.scroll.clientHeight * .45 + Math.min(row.button.offsetHeight, el.scroll.clientHeight * .6) / 2;
  }
  function resume() { browsing = false; el.follow.hidden = true; positionLine(); }
  function browse() { if (rows.length) { browsing = true; el.follow.hidden = false; } }
  function buildLyrics() {
    var doc = Stage.lyrics(), lines = doc && doc.lines;
    if (lines === linesRef) return;
    linesRef = lines; rows = []; active = -2; browsing = false;
    el.lines.replaceChildren(); el.follow.hidden = true;
    (lines || []).forEach(function (line, index) {
      var button = document.createElement('button'); button.type = 'button'; button.className = 'np-line';
      button.dataset.index = index; button.setAttribute('aria-label', '播放这一句：' + (line.text || '间奏'));
      var tokens = Stage.lyricTokens(line), nodes = [], cursor = 0, source = line.text || '· · ·';
      tokens.forEach(function (token) {
        var at = source.indexOf(token.text, cursor);
        if (at >= cursor) { button.appendChild(document.createTextNode(source.slice(cursor, at))); cursor = at + token.text.length; }
        var span = document.createElement('span'); span.className = 'np-word'; span.textContent = token.text;
        button.appendChild(span); nodes.push(span);
      });
      if (cursor < source.length) button.appendChild(document.createTextNode(source.slice(cursor)));
      var translated = Stage.lyricTranslation(index);
      if (translated) { var tr = document.createElement('span'); tr.className = 'np-translation'; tr.textContent = translated; button.appendChild(tr); }
      button.onclick = function () { actions.seek(line.start_ms); resume(); };
      el.lines.appendChild(button); rows.push({ button: button, tokens: tokens, nodes: nodes });
    });
    el.empty.hidden = !!rows.length; emptyState();
  }
  function emptyState() {
    if (!opened) return;
    el.empty.textContent = lyricStatus === 'loading' ? '歌词加载中' : lyricStatus === 'error' ? '歌词加载失败' : Stage.presentation().track ? '暂无歌词' : '播放一首音乐';
  }
  function paintQueue() {
    if (!opened || el.queuePane.hidden) return;
    var items = actions.queue(), key = JSON.stringify(items.map(function (i) { return [i.id, i.title, i.artist, i.cover, i.current]; }));
    if (key === queueKey) return;
    queueKey = key; el.queueList.replaceChildren(); el.queueCount.textContent = items.length + ' 首';
    if (!items.length) { var empty = document.createElement('p'); empty.textContent = '队列是空的'; el.queueList.appendChild(empty); }
    items.forEach(function (item) {
      var button = document.createElement('button'); button.type = 'button'; button.className = 'np-queue-row' + (item.current ? ' is-current' : '');
      button.setAttribute('aria-current', String(item.current)); button.dataset.index = item.index;
      var art = document.createElement('span'); art.className = 'np-queue-art'; art.textContent = item.badge;
      if (item.cover && window.HertzCovers) HertzCovers.applyBg(art, item.cover);
      var meta = document.createElement('span'), title = document.createElement('strong'), artist = document.createElement('small');
      title.textContent = item.title; artist.textContent = item.artist; meta.append(title, artist);
      var duration = document.createElement('time'); duration.textContent = item.duration ? time(item.duration) : '';
      button.append(art, meta, duration); button.onclick = function () { actions.playIndex(item.index); };
      el.queueList.appendChild(button);
    });
  }
  function tick() {
    if (!opened) return;
    var data = Stage.presentation(); buildLyrics();
    // The lyric producer has already calibrated line and word timestamps.
    var position = data.position, lo = 0, hi = rows.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (linesRef[mid].start_ms <= position) lo = mid + 1; else hi = mid; }
    var index = lo - 1;
    if (index !== active) {
      if (rows[active]) { rows[active].button.classList.remove('is-active'); rows[active].button.removeAttribute('aria-current'); }
      active = index;
      if (rows[active]) { rows[active].button.classList.add('is-active'); rows[active].button.setAttribute('aria-current', 'true'); }
      positionLine();
    }
    var row = rows[active];
    if (row) row.nodes.forEach(function (node, i) {
      var token = row.tokens[i], fill = Math.round(Math.max(0, Math.min(1, (position - token.start_ms) / Math.max(1, token.end_ms - token.start_ms))) * 100);
      if (node._fill !== fill) { node._fill = fill; node.style.setProperty('--np-fill', fill + '%'); }
    });
    if (!actions.seeking()) { el.elapsed.textContent = time(data.position); el.duration.textContent = time(data.duration); }
    var favorite = actions.favoriteState(); el.favorite.disabled = favorite.disabled;
    el.favorite.setAttribute('aria-pressed', String(favorite.on));
    el.favorite.querySelector('use').setAttribute('href', favorite.on ? '#i-heart' : '#i-heart-outline');
    var mode = actions.modeState(); el.mode.title = mode.label; el.mode.setAttribute('aria-label', mode.label);
    el.mode.querySelector('use').setAttribute('href', mode.icon);
    paintQueue(); emptyState();
  }
  function fullscreenState() {
    var on = document.fullscreenElement === el.modal;
    el.fullscreen.setAttribute('aria-pressed', String(on)); el.fullscreen.title = on ? '退出全屏' : '全屏播放页';
    el.fullscreen.setAttribute('aria-label', el.fullscreen.title); positionLine();
  }
  function back() {
    if (!opened) return false;
    if (actions.closeTop()) { document.getElementById('np-sleep').focus(); return true; }
    if (!el.tools.hidden) { showTools(false); return true; }
    if (!el.queuePane.hidden) { showQueue(false); return true; }
    if (document.fullscreenElement === el.modal) { document.exitFullscreen().catch(function () {}); return true; }
    actions.close(); return true;
  }
  function keydown(e) {
    if (!opened || e.defaultPrevented) return;
    if (!el.modal.contains(document.activeElement) && document.activeElement !== document.body) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); back(); return; }
    if (e.key === 'Tab') {
      var menu = document.getElementById('ctx-menu');
      var container = !menu.hidden ? menu : el.tools.hidden ? el.modal : el.tools;
      var focusable = Array.from(container.querySelectorAll('button,input,select,[tabindex="0"]')).filter(function (n) { return !n.disabled && n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden'; });
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (!first) return;
      if (!container.contains(document.activeElement)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  function init(hostActions) {
    actions = hostActions;
    var ids = { modal: 'np-modal', scroll: 'np-lyric-scroll', lines: 'np-lyric-lines', empty: 'np-empty', reading: 'np-reading', follow: 'np-follow', coverTab: 'np-tab-cover', lyricsTab: 'np-tab-lyrics', queue: 'np-queue', queuePane: 'np-queue-pane', queueList: 'np-queue-list', queueClose: 'np-queue-close', queueCount: 'np-queue-count', more: 'np-more', tools: 'np-tools', toolsClose: 'np-tools-close', fullscreen: 'np-fullscreen', elapsed: 'np-elapsed', duration: 'np-duration', favorite: 'np-favorite', mode: 'np-mode', eqPane: 'np-eq-pane' };
    Object.keys(ids).forEach(function (key) { el[key] = document.getElementById(ids[key]); });
    el.coverTab.onclick = function () { selectView('cover'); }; el.lyricsTab.onclick = function () { selectView('lyrics'); };
    el.queue.onclick = function () { showQueue(el.queuePane.hidden); }; el.queueClose.onclick = function () { showQueue(false); };
    el.more.onclick = function () { showTools(el.tools.hidden); }; el.toolsClose.onclick = function () { showTools(false); };
    el.follow.onclick = resume;
    el.scroll.addEventListener('wheel', browse, { passive: true }); el.scroll.addEventListener('touchstart', browse, { passive: true });
    el.scroll.addEventListener('keydown', function (e) { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) browse(); });
    el.scroll.addEventListener('pointerdown', browse);
    el.favorite.onclick = actions.favorite; el.mode.onclick = actions.mode;
    document.getElementById('np-mute').onclick = actions.mute; document.getElementById('np-eq').onclick = showEq;
    document.getElementById('np-sleep').onclick = function (e) {
      e.stopPropagation(); actions.sleep(e.currentTarget);
      var first = document.querySelector('#ctx-menu button:not(:disabled)'); if (first) first.focus();
    };
    el.fullscreen.hidden = !document.fullscreenEnabled || typeof el.modal.requestFullscreen !== 'function';
    el.fullscreen.onclick = function () {
      var task = document.fullscreenElement === el.modal ? document.exitFullscreen() : el.modal.requestFullscreen();
      task.catch(function () { actions.notice('当前窗口无法进入全屏'); fullscreenState(); });
    };
    Stage.gate('ordinary-player', function () { return opened ? 30 : 0; }, tick);
    document.addEventListener('fullscreenchange', fullscreenState); document.addEventListener('keydown', keydown, true);
  }
  function open() {
    if (opened) return;
    trigger = document.activeElement; opened = true; queueKey = ''; linesRef = undefined;
    el.modal.dataset.skin = document.documentElement.getAttribute('data-skin'); document.body.classList.add('np-expanded');
    // Fullscreen exposes only descendants of the fullscreen element.
    move(document.getElementById('ctx-menu'), el.modal, moves);
    background = Array.from(document.querySelectorAll('.topbar,.app,.bar,#capsule,.qf-lattice'));
    background = background.map(function (n) { var old = n.inert; n.inert = true; return { node: n, inert: old }; });
    if (el.modal.dataset.skin === 'heijiao') {
      var disc = document.querySelector('#stage .disc-wrap'), parent = document.getElementById('np-art').parentElement;
      var host = document.createElement('div'); host.id = 'np-disc-host'; parent.prepend(host);
      move(disc, host, moves); document.getElementById('np-art').hidden = true;
    }
    selectView(view); tick(); resize = new ResizeObserver(positionLine); resize.observe(el.scroll);
    document.getElementById('np-close').focus({ preventScroll: true });
  }
  function close(options) {
    if (!opened) return;
    opened = false;
    actions.closeTop();
    if (document.fullscreenElement === el.modal) document.exitFullscreen().catch(function () {});
    if (resize) resize.disconnect(); resize = null;
    restore(eqMoves); restore(moves);
    var host = document.getElementById('np-disc-host'); if (host) host.remove(); document.getElementById('np-art').hidden = false;
    el.tools.hidden = true; el.eqPane.hidden = true; el.queuePane.hidden = true; el.reading.hidden = false;
    el.more.setAttribute('aria-expanded', 'false'); el.queue.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('np-expanded'); background.forEach(function (m) { m.node.inert = m.inert; }); background = [];
    if (!(options && options.switching) && trigger && trigger.isConnected && !trigger.inert) trigger.focus({ preventScroll: true }); trigger = null;
  }
  window.NowPlaying = { init: init, open: open, close: close, back: back, isOpen: function () { return opened; },
    lyricState: function (status) { lyricStatus = status; emptyState(); }, update: tick,
    preview: function (position, duration) { if (opened) { el.elapsed.textContent = time(position); el.duration.textContent = time(duration); } }
  };
})();
