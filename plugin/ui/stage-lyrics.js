// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
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
    var browsing = null, until = 0, dirty = true;
    var reduced = false, enabled = true;
    function resume() { browsing = null; back.hidden = true; center = -2; }
    back.addEventListener('click', resume);
    function browse(delta) {
      if (!lines.length) return;
      browsing = Math.max(0, Math.min(lines.length - 1, (browsing === null ? Math.max(0, active) : browsing) + delta));
      until = Date.now() + 5000; back.hidden = false; center = -2;
    }
    // 轨道已对指针透明（.sl-rail pointer-events:none）：滚轮与拖拽整块让给
    // 三维机位，此处只保留键盘路径——聚焦歌词行后 Enter 触发 click 寻句、
    // 方向键回看。滚轮/拖拽回看由 stage3d 的画布手势接管，不再在这里抢。
    rail.addEventListener('click', function (e) {
      var row = e.target.closest('.sl-line');
      // 抓行拖拽歌词平面后的那一下 click 不算跳转（stage3d 在宿主上标 _justDragged）。
      if (!row || host._justDragged) return;
      var line = lines[Number(row.dataset.index)];
      if (line && typeof line.start_ms === 'number') { seek(line.start_ms); resume(); }
    });
    rail.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); browse(e.key === 'ArrowDown' ? 1 : -1); }
    });
    var observer = global.ResizeObserver && new ResizeObserver(function () { dirty = true; });
    if (observer) observer.observe(rail);

    // 心象（scatter）布局的散开量：与歌词页同一套手法，构建时一次算完写成
    // 变量，不随时间变。hash 与 stage.js 的 hash2 同式，同一行词在两边的
    // 落位一致。
    function hash2(a, b, k) {
      var x = Math.sin(a * 127.1 + b * 311.7 + k * 74.7) * 43758.5453;
      return x - Math.floor(x);
    }
    function buildRow(index) {
      var line = lines[index], button = document.createElement('button');
      button.type = 'button'; button.className = 'sl-line'; button.dataset.index = index;
      button.setAttribute('aria-label', '播放这一句：' + (line.text || '间奏'));
      var tokens = Stage.lyricTokens(line), nodes = [], cursor = 0, source = line.text || '· · ·';
      tokens.forEach(function (token, k) {
        // Preserve source spaces/punctuation omitted by the shared tokenizer.
        var at = source.indexOf(token.text, cursor);
        if (at >= cursor) { button.appendChild(document.createTextNode(source.slice(cursor, at))); cursor = at + token.text.length; }
        var node = document.createElement('span'); node.className = 'sl-word'; node.textContent = token.text;
        node.style.setProperty('--w-dx', ((hash2(index, k, 1) - 0.5) * 2).toFixed(3));
        node.style.setProperty('--w-dy', ((hash2(index, k, 2) - 0.5) * 2).toFixed(3));
        node.style.setProperty('--w-rot', ((hash2(index, k, 3) - 0.5) * 2).toFixed(3));
        node.style.setProperty('--w-sc', (0.9 + hash2(index, k, 4) * 0.22).toFixed(3));
        // 星火（spark）布局的逐字点亮参数：染色时长取词自己的时长（词快则闪、
        // 词慢则浸），辉光脉冲往词尾外拖一段衰减；钳位防脏时间轴（0ms/超长词）。
        // --w-pop 用同一套 hash2 出确定性弹跳幅度，seek 后重排不换样。
        var sparkDur = Math.max(0, (token.end_ms || token.start_ms) - token.start_ms);
        node.style.setProperty('--w-dur', Math.max(90, Math.min(sparkDur, 2400)).toFixed(0) + 'ms');
        node.style.setProperty('--w-pulse', Math.max(520, Math.min(sparkDur * 2.2, 1500)).toFixed(0) + 'ms');
        node.style.setProperty('--w-pop', (1.03 + hash2(index, k, 5) * 0.05).toFixed(3));
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
        // 超出轨道可视界的行直接归零：原 overflow:hidden 的裁剪改由这里表达，
        // 3D 链路（reading→rail→行）上不能有 overflow/mask，否则 Z 会被压平。
        var out = Math.abs(positions[index]) > rail.clientHeight * 0.5 + 40;
        row.el.style.setProperty('--sl-opacity', out ? 0 : (distance ? Math.max(.12, .58 - distance * .12) : 1));
        row.el.style.setProperty('--sl-blur', (reduced ? 0 : distance * 1.1) + 'px');
        // 离当前行的距离 → translateZ 深度（css 端乘 --s3d-row-depth），旋转时的视差来源。
        row.el.style.setProperty('--sl-d', distance);
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
          // 星火（spark）布局按这个词级开关逐字点亮，其余布局不消费 is-lit。
          // 必须放在 _fill 早退之前：词起点附近 pct 常落在同一档，早退会吞掉翻转。
          var lit = p > 0;
          if (node._lit !== lit) { node._lit = lit; node.classList.toggle('is-lit', lit); }
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
