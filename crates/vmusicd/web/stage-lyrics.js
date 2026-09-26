// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
// Presentation only. Stage owns lyric documents, token timings and the clock.
(function (global) {
  'use strict';
  function init(host, seek) {
    var rail = document.createElement('div'); rail.className = 'sl-rail';
    rail.setAttribute('aria-label', '歌词，滚动浏览，点击跳转');
    var back = document.createElement('button'); back.className = 'sl-return';
    back.type = 'button'; back.textContent = '回到当前句'; back.hidden = true;
    var empty = document.createElement('div'); empty.className = 'sl-empty';
    host.append(rail, empty, back);
    var documentRef = null, lines = [], rows = new Map(), active = -1, center = -2;
    var browsing = null, until = 0, dirty = true, wheelAt = 0, pointer = null;
    var reduced = false, enabled = true, suppressClick = false;
    function resume() { browsing = null; back.hidden = true; center = -2; }
    back.addEventListener('click', resume);
    function browse(delta) {
      if (!lines.length) return;
      browsing = Math.max(0, Math.min(lines.length - 1, (browsing === null ? Math.max(0, active) : browsing) + delta));
      until = Date.now() + 5000; back.hidden = false; center = -2;
    }
    rail.addEventListener('wheel', function (e) {
      if (!lines.length) return;
      e.preventDefault(); e.stopPropagation();
      if (Date.now() - wheelAt < 160 || !e.deltaY) return;
      wheelAt = Date.now(); browse(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });
    rail.addEventListener('pointerdown', function (e) { pointer = { id: e.pointerId, y: e.clientY }; suppressClick = false; });
    rail.addEventListener('pointermove', function (e) {
      if (!pointer || pointer.id !== e.pointerId) return;
      var dy = e.clientY - pointer.y;
      if (Math.abs(dy) > 38) { browse(dy > 0 ? -1 : 1); pointer.y = e.clientY; suppressClick = true; }
    });
    rail.addEventListener('pointerup', function () { pointer = null; });
    rail.addEventListener('pointerleave', function () { pointer = null; });
    rail.addEventListener('pointercancel', function () { pointer = null; suppressClick = true; });
    rail.addEventListener('click', function (e) {
      var row = e.target.closest('.sl-line');
      if (row && !suppressClick) { seek(lines[Number(row.dataset.index)].start_ms); resume(); }
      pointer = null; suppressClick = false;
    });
    rail.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); browse(e.key === 'ArrowDown' ? 1 : -1); }
    });
    var observer = global.ResizeObserver && new ResizeObserver(function () { dirty = true; });
    if (observer) observer.observe(rail);

    function buildRow(index) {
      var line = lines[index], button = document.createElement('button');
      button.type = 'button'; button.className = 'sl-line'; button.dataset.index = index;
      button.setAttribute('aria-label', '播放这一句：' + (line.text || '间奏'));
      var tokens = Stage.lyricTokens(line), nodes = [], cursor = 0, source = line.text || '· · ·';
      tokens.forEach(function (token) {
        // Preserve source spaces/punctuation omitted by the shared tokenizer.
        var at = source.indexOf(token.text, cursor);
        if (at >= cursor) { button.appendChild(document.createTextNode(source.slice(cursor, at))); cursor = at + token.text.length; }
        var node = document.createElement('span'); node.className = 'sl-word'; node.textContent = token.text;
        button.appendChild(node); nodes.push(node);
      });
      if (cursor < source.length) button.appendChild(document.createTextNode(source.slice(cursor)));
      rail.appendChild(button);
      return { el: button, tokens: tokens, nodes: nodes, height: 0 };
    }
    function layout(focus) {
      var wanted = [];
      for (var i = Math.max(0, focus - 3); i <= Math.min(lines.length - 1, focus + 3); i++) wanted.push(i);
      rows.forEach(function (row, index) { if (wanted.indexOf(index) < 0) { row.el.remove(); rows.delete(index); } });
      wanted.forEach(function (index) { if (!rows.has(index)) rows.set(index, buildRow(index)); });
      wanted.forEach(function (index) {
        var row = rows.get(index);
        row.el.style.removeProperty('font-size');
        var maxHeight = Math.max(72, rail.clientHeight * .66);
        var size = parseFloat(getComputedStyle(row.el).fontSize);
        while (row.el.offsetHeight > maxHeight && size > 14) {
          size = Math.max(14, size - 2); row.el.style.fontSize = size + 'px';
        }
        row.height = row.el.offsetHeight;
        row.el.classList.toggle('is-active', index === active);
        row.el.classList.toggle('is-past', index < active);
        row.el.setAttribute('aria-current', index === active ? 'true' : 'false');
        row.el.tabIndex = index === focus ? 0 : -1;
      });
      var focusRow = rows.get(focus); if (!focusRow) return;
      var gap = rail.clientHeight < 300 ? 18 : 28, positions = {};
      positions[focus] = -focusRow.height / 2;
      for (i = focus + 1; rows.has(i); i++) positions[i] = positions[i - 1] + rows.get(i - 1).height + gap;
      for (i = focus - 1; rows.has(i); i--) positions[i] = positions[i + 1] - rows.get(i).height - gap;
      wanted.forEach(function (index) {
        var row = rows.get(index), distance = Math.abs(index - focus);
        row.el.style.setProperty('--sl-y', positions[index] + 'px');
        row.el.style.setProperty('--sl-scale', Math.max(.76, 1 - distance * .09));
        row.el.style.setProperty('--sl-opacity', distance ? Math.max(.12, .58 - distance * .12) : 1);
        row.el.style.setProperty('--sl-blur', (reduced ? 0 : distance * 1.1) + 'px');
      });
      dirty = false;
    }
    function update(data) {
      var doc = Stage.lyrics();
      if (reduced !== data.reduced) { dirty = true; reduced = data.reduced; rows.forEach(function (row) { row.nodes.forEach(function (n) { n._fill = null; }); }); }
      var nextLines = doc && doc.lines;
      if (nextLines !== documentRef) {
        documentRef = nextLines; lines = nextLines || [];
        rows.forEach(function (row) { row.el.remove(); }); rows.clear(); resume(); active = -1;
      }
      var lo = 0, hi = lines.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (lines[mid].start_ms <= data.position) lo = mid + 1; else hi = mid; }
      if (active !== lo - 1) { active = lo - 1; dirty = true; }
      if (browsing !== null && Date.now() > until) resume();
      var focus = browsing === null ? Math.max(0, active) : browsing;
      empty.hidden = !!lines.length;
      if (!lines.length) {
        var title = data.track ? data.track.title || '此刻，只有音乐' : '在声音里，发现另一片宇宙';
        if (empty.dataset.title !== title) {
          empty.dataset.title = title; empty.textContent = '';
          var heading = document.createElement('strong'); heading.textContent = title;
          var note = document.createElement('span'); note.textContent = data.track ? '暂无歌词 · 让旋律继续' : '播放一首音乐，开始聆听';
          empty.append(heading, note);
        }
      }
      if (focus !== center || dirty) { center = focus; layout(focus); }
      paint(data.position);
    }
    function paint(position) {
      if (!enabled) return;
      rows.forEach(function (row, index) {
        if (index !== active) return;
        row.nodes.forEach(function (node, i) {
          var token = row.tokens[i];
          var p = Math.max(0, Math.min(1, (position - token.start_ms) / Math.max(1, (token.end_ms || token.start_ms + 400) - token.start_ms)));
          var pct = Math.round(p * 120 - 10);
          if (node._fill === pct) return;
          node._fill = pct; node.style.setProperty('--sl-fill', pct + '%');
          node.style.setProperty('--sl-rise', (reduced ? 0 : -Math.sin(p * Math.PI) * 2.5) + 'px');
        });
      });
    }
    return { update: update, paint: paint, reset: resume,
      destroy: function () { if (observer) observer.disconnect(); rail.remove(); empty.remove(); back.remove(); rows.clear(); },
      configure: function (on) { enabled = on; dirty = true; } };
  }
  global.StageLyrics = { init: init };
})(window);
