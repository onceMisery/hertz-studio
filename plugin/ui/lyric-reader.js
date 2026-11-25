// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 沉浸歌词 · 双栏阅读模式。
//
// 与三维舞台（stage3d）并行的一条只读呈现层：左侧封套/黑胶与曲目信息，
// 右侧同步歌词，底部播放控制。它**不拥有**播放状态与歌词文档——
// 曲目、位置、歌词都从 window.Stage 的只读快照读；播放、切歌、跳转、音量
// 一律交给 app.js 暴露的 window.HertzPlayback，避免出现第二套时钟。
(function (global) {
  'use strict';

  var VINYL_KEY = 'vmusic.reader.vinyl';
  var TRANS_KEY = 'vmusic.reader.translation';
  var CLOSE_MS = 260;

  var root = null, el = null, open = false, raf = 0, closeTimer = 0;
  var lastFocus = null;
  var vinyl = false, translate = true;
  var lastTrackId = null, lastCover = null;
  var linesRef = null, lineNodes = [], builtTrackId = null, hasTranslation = false;
  var activeIndex = -2, lastPaint = 0, dragging = false, dragValue = 0;
  var userScrollUntil = 0, lastScrollIndex = -1;

  function $(id) { return document.getElementById(id); }
  function text(node, value) { if (node && node.textContent !== value) node.textContent = value; }
  function fmt(ms) {
    var s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }
  function readStore(key, fallback) {
    try {
      var v = global.localStorage.getItem(key);
      return v === null ? fallback : v === '1';
    } catch (_) { return fallback; }
  }
  function writeStore(key, value) {
    try { global.localStorage.setItem(key, value ? '1' : '0'); } catch (_) { /* 隐私模式 */ }
  }
  function assetUrl(url) {
    var host = global.hertzHost;
    return host && typeof host.assetUrl === 'function' ? host.assetUrl(url) : url;
  }
  function stage() { return global.Stage; }

  function presentation() {
    var S = stage();
    if (!S || typeof S.presentation !== 'function') return null;
    try { return S.presentation(); } catch (_) { return null; }
  }

  function lyricDoc() {
    var S = stage();
    if (!S || typeof S.lyrics !== 'function') return null;
    try { return S.lyrics(); } catch (_) { return null; }
  }

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  function paintTrack(pres) {
    var track = pres && pres.track;
    var trackId = track ? track.id : '';
    var cover = pres ? pres.cover : null;
    if (trackId === lastTrackId && cover === lastCover) return;
    lastTrackId = trackId;
    lastCover = cover;

    if (!track) {
      text(el.title, '未在播放');
      text(el.sub, '从曲库选择一首歌，歌词会在这里展开');
      el.art.hidden = true;
      el.artEmpty.hidden = false;
      el.ambient.classList.remove('has-cover');
      el.tech.hidden = true;
      el.quality.hidden = true;
      el.format.hidden = true;
      el.vinylDisc.hidden = true;
      el.root.classList.remove('has-track');
      return;
    }

    text(el.title, track.title || '未命名曲目');
    var sub = [track.artist, track.album].filter(Boolean).join(' · ');
    text(el.sub, sub || '未知艺术家');

    var tech = [];
    if (track.format) tech.push(String(track.format).toUpperCase());
    if (track.sample_rate) tech.push((track.sample_rate / 1000).toFixed(1) + ' kHz');
    if (track.bitrate) tech.push(track.bitrate + ' kbps');
    if (track.channels) tech.push(track.channels >= 2 ? '立体声' : '单声道');
    text(el.techText, tech.join(' · '));
    el.tech.hidden = tech.length === 0;

    var quality = [];
    if (track.sample_rate) quality.push((track.sample_rate / 1000).toFixed(1) + ' kHz');
    if (track.bitrate) quality.push(track.bitrate + ' kbps');
    text(el.quality, quality.join(' · '));
    el.quality.hidden = quality.length === 0;

    var format = track.format ? String(track.format).toUpperCase() : '';
    text(el.format, format);
    el.format.hidden = !format;

    el.root.classList.add('has-track');
    var src = cover || assetUrl('/art/default-cover.svg');
    if (el.art.getAttribute('src') !== src) el.art.setAttribute('src', src);
    if (el.vinylArt.getAttribute('src') !== src) el.vinylArt.setAttribute('src', src);
    if (el.ambientArt.getAttribute('src') !== src) el.ambientArt.setAttribute('src', src);
    el.art.hidden = vinyl;
    el.vinylDisc.hidden = !vinyl;
    el.artEmpty.hidden = true;
    el.ambient.classList.toggle('has-cover', !!cover);
  }

  function paintTransport(pres) {
    var duration = Math.max(0, Number(pres && pres.duration) || 0);
    var position = Math.max(0, Number(pres && pres.position) || 0);
    if (dragging) position = dragValue * duration;
    var ratio = duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0;

    text(el.duration, fmt(duration));
    if (!dragging) {
      text(el.elapsed, fmt(position));
      el.seekRange.value = String(Math.round(ratio * 1000));
      el.seekRange.style.setProperty('--lr-p', (ratio * 100).toFixed(2) + '%');
    }
    el.seekRange.disabled = duration <= 0;

    var playing = !!(pres && pres.playing);
    el.playBtn.classList.toggle('is-playing', playing);
    el.playBtn.setAttribute('aria-label', playing ? '暂停' : '播放');

    var vinylSpin = playing && vinyl;
    el.vinylDisc.classList.toggle('is-spinning', vinylSpin);

    var volume = Math.round((pres ? Number(pres.volume) : 0.8) * 100);
    if (document.activeElement !== el.volumeRange) {
      el.volumeRange.value = String(volume);
      el.volumeRange.style.setProperty('--lr-v', volume + '%');
    }

    var modeNode = $('mode');
    if (modeNode) {
      var label = modeNode.textContent || '列表循环';
      text(el.modeLabel, label);
      if (el.modeIcon) el.modeIcon.setAttribute('href', label.indexOf('随机') >= 0 ? '#i-shuffle' : '#i-repeat');
    }

    var fav = $('bar-favorite');
    if (fav) {
      var pressed = fav.getAttribute('aria-pressed') === 'true';
      if (el.heartBtn.getAttribute('aria-pressed') !== String(pressed)) {
        el.heartBtn.setAttribute('aria-pressed', String(pressed));
        el.heartBtn.setAttribute('aria-label', pressed ? '取消收藏' : '收藏当前歌曲');
        var icon = el.heartBtn.querySelector('use');
        if (icon) icon.setAttribute('href', pressed ? '#i-heart' : '#i-heart-outline');
      }
      el.heartBtn.disabled = fav.disabled;
    }
  }

  function buildLyrics(doc, pres) {
    el.lyrics.textContent = '';
    lineNodes = [];
    linesRef = doc && doc.lines ? doc.lines : null;
    builtTrackId = pres && pres.track ? pres.track.id : null;
    hasTranslation = false;

    if (!linesRef || !linesRef.length) {
      el.empty.hidden = false;
      var hasTrack = !!(pres && pres.track);
      var status = stage() && stage().lyricStatus ? stage().lyricStatus() : '';
      text(el.empty, !hasTrack
        ? '选择一首歌后，歌词会在这里同步显示'
        : status === 'unsupported'
          ? '这首歌包含多人声，阅读模式暂不支持；可在三维舞台或桌面歌词里查看。'
          : '这首歌还没有可用歌词');
      el.translateBtn.disabled = true;
      el.translateBtn.setAttribute('aria-pressed', 'false');
      return;
    }

    el.empty.hidden = true;
    var frag = document.createDocumentFragment();
    var S = stage();
    for (var i = 0; i < linesRef.length; i += 1) {
      var line = linesRef[i] || {};
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lr-line';
      btn.dataset.index = String(i);

      var label = document.createElement('span');
      label.className = 'lr-line-text';
      label.textContent = line.text || '';
      btn.appendChild(label);

      var tr = '';
      try { tr = S && S.lyricTranslation ? (S.lyricTranslation(i) || '') : ''; } catch (_) { tr = ''; }
      var trNode = document.createElement('span');
      trNode.className = 'lr-line-tr';
      trNode.textContent = tr;
      trNode.hidden = !tr || !translate;
      if (tr) hasTranslation = true;
      btn.appendChild(trNode);

      var time = document.createElement('span');
      time.className = 'lr-line-time';
      time.textContent = fmt(line.start_ms);
      btn.appendChild(time);

      btn.addEventListener('click', (function (start) {
        return function () {
          if (global.HertzPlayback && global.HertzPlayback.seek) global.HertzPlayback.seek(start);
        };
      }(Number(line.start_ms) || 0)));

      frag.appendChild(btn);
      lineNodes.push(btn);
    }
    el.lyrics.appendChild(frag);

    el.translateBtn.disabled = !hasTranslation;
    el.translateBtn.setAttribute('aria-pressed', String(translate && hasTranslation));
    el.translateBtn.classList.toggle('is-off', !translate || !hasTranslation);
    activeIndex = -2;
    lastScrollIndex = -1;
    userScrollUntil = 0;
  }

  function paintLyrics(pres) {
    var doc = lyricDoc();
    var trackId = pres && pres.track ? pres.track.id : null;
    if (!doc || !doc.lines || !doc.lines.length) {
      if (linesRef !== null || el.lyrics.childElementCount || el.empty.hidden) buildLyrics(null, pres);
      return;
    }
    if (doc.lines !== linesRef || trackId !== builtTrackId) buildLyrics(doc, pres);

    var index = Number(doc.index);
    if (!Number.isFinite(index)) index = 0;
    if (index < 0) index = 0;
    if (index >= lineNodes.length) index = lineNodes.length - 1;
    if (index === activeIndex) return;

    var firstPaint = activeIndex === -2;
    if (activeIndex >= 0 && lineNodes[activeIndex]) lineNodes[activeIndex].classList.remove('is-active');
    for (var i = 0; i < lineNodes.length; i += 1) {
      lineNodes[i].classList.toggle('is-past', i < index);
    }
    var node = lineNodes[index];
    if (!node) return;
    node.classList.add('is-active');
    activeIndex = index;

    if (index !== lastScrollIndex && performance.now() >= userScrollUntil) {
      lastScrollIndex = index;
      // 首帧直接定位，避免打开页面时先停在顶部再滑到当前句。
      centerLine(node, firstPaint);
    }
  }

  function centerActive(instant) {
    if (activeIndex >= 0 && lineNodes[activeIndex]) centerLine(lineNodes[activeIndex], instant);
  }

  function centerLine(node, instant) {
    var scroller = el.scroll;
    if (!scroller || !node) return;
    var nodeRect = node.getBoundingClientRect();
    var boxRect = scroller.getBoundingClientRect();
    var top = scroller.scrollTop + (nodeRect.top - boxRect.top) + nodeRect.height / 2 - scroller.clientHeight / 2;
    var max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    var reduced = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollTo({ top: Math.max(0, Math.min(max, top)), behavior: instant || reduced ? 'auto' : 'smooth' });
  }

  function paint(force) {
    var pres = presentation();
    if (!pres) return;
    paintTrack(pres);
    paintTransport(pres);
    paintLyrics(pres);
  }

  // ---------------------------------------------------------------------------
  // 循环与显隐
  // ---------------------------------------------------------------------------

  function frame(now) {
    if (!open) return;
    if (now - lastPaint >= 90) {
      lastPaint = now;
      paint();
    }
    raf = global.requestAnimationFrame(frame);
  }

  function start() {
    stop();
    lastPaint = 0;
    raf = global.requestAnimationFrame(frame);
  }

  function stop() {
    if (raf) global.cancelAnimationFrame(raf);
    raf = 0;
  }

  function openReader() {
    if (!root || open) return;
    open = true;
    lastFocus = document.activeElement;
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lr-open');
    requestAnimationFrame(function () { root.classList.add('is-open'); });
    // 打开时按当前黑胶偏好同步一次按钮文案，再刷新数据。
    syncToggles();
    // 上次关闭时的活动行可能已经过期：重新定位并把它滚到视野中央。
    activeIndex = -2;
    lastScrollIndex = -1;
    userScrollUntil = 0;
    paint(true);
    start();
    // 首帧布局（尤其是 flex 高度与遮罩）可能还没稳定，稍后再校正一次，
    // 保证打开时直接停在当前唱到的那一句，而不是顶部。
    global.setTimeout(function () { if (open) centerActive(true); }, 120);
    if (el.closeBtn) el.closeBtn.focus({ preventScroll: true });
  }

  function closeReader() {
    if (!root || !open) return;
    open = false;
    stop();
    root.classList.remove('is-open');
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lr-open');
    clearTimeout(closeTimer);
    closeTimer = setTimeout(function () { if (!open) root.hidden = true; }, CLOSE_MS);
    if (lastFocus && lastFocus.focus) {
      try { lastFocus.focus({ preventScroll: true }); } catch (_) { /* 元素已移除 */ }
    }
  }

  function toggleReader() { if (open) closeReader(); else openReader(); }

  function syncToggles() {
    el.vinylBtn.setAttribute('aria-pressed', String(vinyl));
    text(el.vinylLabel, vinyl ? '黑胶唱盘' : '艺术封套');
    el.vinylDisc.hidden = !vinyl || !root.classList.contains('has-track');
    el.art.hidden = vinyl || !root.classList.contains('has-track');
    if (el.artWrap) {
      el.artWrap.setAttribute('aria-label', vinyl ? '当前为黑胶唱盘，点击切换为艺术封套' : '当前为艺术封套，点击切换为黑胶唱盘');
      el.artWrap.title = vinyl ? '切换为艺术封套' : '切换为黑胶唱盘';
    }
    el.translateBtn.setAttribute('aria-pressed', String(translate && !el.translateBtn.disabled));
    el.translateBtn.classList.toggle('is-off', !translate);
    for (var i = 0; i < lineNodes.length; i += 1) {
      var tr = lineNodes[i].querySelector('.lr-line-tr');
      if (tr) tr.hidden = !translate || !tr.textContent;
    }
  }

  // ---------------------------------------------------------------------------
  // 交互
  // ---------------------------------------------------------------------------

  function toggleVinyl() {
    vinyl = !vinyl;
    writeStore(VINYL_KEY, vinyl);
    syncToggles();
  }

  function bindControls() {
    el.closeBtn.addEventListener('click', closeReader);
    el.vinylBtn.addEventListener('click', toggleVinyl);
    // 封面本身就是最直观的切换入口：点一下在封套与黑胶之间切换。
    if (el.artWrap) {
      el.artWrap.addEventListener('click', toggleVinyl);
      el.artWrap.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggleVinyl();
      });
    }
    el.translateBtn.addEventListener('click', function () {
      if (el.translateBtn.disabled) return;
      translate = !translate;
      writeStore(TRANS_KEY, translate);
      syncToggles();
    });
    el.playBtn.addEventListener('click', function () {
      if (global.HertzPlayback && global.HertzPlayback.toggle) global.HertzPlayback.toggle();
    });
    el.prevBtn.addEventListener('click', function () {
      if (global.HertzPlayback && global.HertzPlayback.previous) global.HertzPlayback.previous();
    });
    el.nextBtn.addEventListener('click', function () {
      if (global.HertzPlayback && global.HertzPlayback.next) global.HertzPlayback.next();
    });
    el.modeBtn.addEventListener('click', function () {
      var node = $('mode');
      if (node) node.click();
      setTimeout(function () {
        var n = $('mode');
        if (!n) return;
        text(el.modeLabel, n.textContent || '列表循环');
        if (el.modeIcon) el.modeIcon.setAttribute('href', (n.textContent || '').indexOf('随机') >= 0 ? '#i-shuffle' : '#i-repeat');
      }, 0);
    });
    el.heartBtn.addEventListener('click', function () {
      var node = $('bar-favorite');
      if (!node || node.disabled) return;
      node.click();
      setTimeout(paint, 60);
    });
    el.queueBtn.addEventListener('click', function () {
      closeReader();
      var node = $('bar-queue');
      if (node) node.click();
    });

    el.seekRange.addEventListener('pointerdown', function () {
      if (el.seekRange.disabled) return;
      dragging = true;
      dragValue = Number(el.seekRange.value) / 1000;
    });
    el.seekRange.addEventListener('input', function () {
      if (!dragging) { dragging = true; }
      dragValue = Number(el.seekRange.value) / 1000;
      var pres = presentation();
      var duration = Math.max(0, Number(pres && pres.duration) || 0);
      text(el.elapsed, fmt(dragValue * duration));
      el.seekRange.style.setProperty('--lr-p', (dragValue * 100).toFixed(2) + '%');
    });
    el.seekRange.addEventListener('change', function () {
      var pres = presentation();
      var duration = Math.max(0, Number(pres && pres.duration) || 0);
      var position = dragValue * duration;
      dragging = false;
      if (global.HertzPlayback && global.HertzPlayback.seek) global.HertzPlayback.seek(position);
    });
    el.seekRange.addEventListener('pointerup', function () { dragging = false; });

    el.volumeRange.addEventListener('input', function () {
      var value = Number(el.volumeRange.value) / 100;
      el.volumeRange.style.setProperty('--lr-v', (value * 100) + '%');
      if (global.HertzPlayback && global.HertzPlayback.setVolume) global.HertzPlayback.setVolume(value);
    });

    el.scroll.addEventListener('wheel', markUserScroll, { passive: true });
    el.scroll.addEventListener('touchstart', markUserScroll, { passive: true });
    el.scroll.addEventListener('pointerdown', markUserScroll);
    el.scroll.addEventListener('keydown', markUserScroll);
  }

  function markUserScroll() { userScrollUntil = performance.now() + 3600; }

  function onKeydown(event) {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeReader();
      return;
    }
    if (event.key !== 'Tab') return;
    var nodes = Array.prototype.slice.call(root.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])'))
      .filter(function (node) { return !node.disabled && node.getClientRects().length; });
    if (!nodes.length) return;
    var first = nodes[0], last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function bindEntries() {
    // 皮肤在播放栏注入的歌词按钮：捕获阶段先拦下，统一走阅读模式。
    document.addEventListener('click', function (event) {
      var node = event.target && event.target.closest ? event.target.closest('.hz-lyrics-button, #bar-lyrics-reader') : null;
      if (!node) return;
      node.title = '沉浸歌词';
      node.setAttribute('aria-label', '打开沉浸歌词');
      event.preventDefault();
      event.stopImmediatePropagation();
      openReader();
    }, true);

    document.addEventListener('click', function (event) {
      var node = event.target && event.target.closest ? event.target.closest('#home-immersive, #lr-open-entry') : null;
      if (!node) return;
      event.preventDefault();
      // 首页按钮与原型一致：进入沉浸歌词舞台（沉浸声场），而不是阅读歌词。
      if (node.id === 'home-immersive') {
        var stageEntry = $('stage3d-entry');
        if (stageEntry) stageEntry.click();
        return;
      }
      openReader();
    });

    document.addEventListener('keydown', onKeydown, true);
    global.addEventListener('resize', function () {
      if (!open) return;
      lastScrollIndex = -1;
      centerActive(true);
    });
    document.addEventListener('stage:playing-changed', function () {
      if (open) paint(true);
    });
    document.addEventListener('playback:track', function () {
      if (open) paint(true);
    });
  }

  function init() {
    root = $('lyric-reader');
    if (!root) return;
    el = {
      root: root,
      closeBtn: $('lr-close'),
      vinylBtn: $('lr-vinyl'),
      vinylLabel: $('lr-vinyl-label'),
      vinylDisc: $('lr-vinyl-disc'),
      vinylArt: $('lr-vinyl-art'),
      translateBtn: $('lr-translate'),
      tech: $('lr-tech'),
      techText: $('lr-tech-text'),
      artWrap: document.querySelector('.lr-art-wrap'),
      art: $('lr-art'),
      artEmpty: $('lr-art-empty'),
      ambient: $('lr-ambient'),
      ambientArt: $('lr-ambient-art'),
      title: $('lr-title'),
      sub: $('lr-sub'),
      quality: $('lr-quality'),
      format: $('lr-format'),
      heartBtn: $('lr-favorite'),
      scroll: $('lr-lyrics-scroll'),
      lyrics: $('lr-lyrics'),
      empty: $('lr-empty'),
      elapsed: $('lr-elapsed'),
      duration: $('lr-duration'),
      seekRange: $('lr-seek'),
      modeBtn: $('lr-mode'),
      modeLabel: $('lr-mode-label'),
      modeIcon: $('lr-mode-icon'),
      prevBtn: $('lr-prev'),
      playBtn: $('lr-play'),
      nextBtn: $('lr-next'),
      volumeRange: $('lr-volume'),
      queueBtn: $('lr-queue'),
    };
    if (!el.closeBtn || !el.seekRange) return;

    vinyl = readStore(VINYL_KEY, false);
    translate = readStore(TRANS_KEY, true);
    el.vinylDisc.hidden = !vinyl;
    el.art.hidden = !!vinyl;

    bindControls();
    bindEntries();
    syncToggles();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();

  global.LyricReader = {
    open: openReader,
    close: closeReader,
    toggle: toggleReader,
    isOpen: function () { return open; },
  };
}(window));
