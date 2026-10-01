// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 皮肤：liunian（流年）—— DOM 重编排层（零依赖 IIFE）。
//
// 背景
// ----
// 本项目是 SPA：.rail 导航 → .column 六个视图 → .stage 舞台，.bar 是 body 末尾
// 的播放条。流年皮肤对骨架做如下调整（v3）：
//   · 移除最左侧 .rail 导航轨（display:none，节点保留以备程序化点击与还原）；
//   · 中栏顶部新建胶囊导航 .ln-nav（六个一级目的地）；
//   · .bar 搬进中栏最前成为文档流播放卡（可收为胶囊）；
//   · 右栏改为纵向两区：上部为「搜索面板」（本地/在线双源并行检索、
//     分类结果、搜索历史），下部保留 .stage（频谱 + 歌词）；
//   · 曲库/在线/歌单等列表本体不再搬运，留在中栏各自视图。
//
// 契约
// ----
//   · 只搬运/包裹已有节点 + 新建带 ln-/bar-row1 类名的结构节点，不改任何
//     业务 JS 的状态与事件（原有监听器随节点一起走，不丢）；
//   · 每个搬运的节点原位留一个 <span class="ln-anchor">，还原时 insertBefore
//     回锚点再删锚点，原顺序严格保持；
//   · 视图切换联动用 MutationObserver（观察 .view 的 hidden），不 hook 业务代码；
//   · 搜索面板自包含取数（直连 REST），播放/跳转经 document 上的
//     `ln:panel` 自定义事件交给 app.js 分流。

(function () {
  'use strict';

  var SKIN_ID = 'liunian';

  var mounted = false;
  var moves = [];     // { node, anchor }：搬运记录，后进先出地还原
  var built = [];     // 本文件新建的节点，卸载时 remove
  var observer = null;
  var refs = {};      // 重编排队列里的 DOM 引用
  var savedText = []; // 临时改过的文本，{ node, text }
  var inReflow = false; // reflow 重入保护

  var CAPSULE_KEY = 'vmusic.ln-capsule';
  var HISTORY_KEY = 'vmusic.ln-search-history';
  var HISTORY_MAX = 10;
  var keyHandler = null;

  // 搜索面板运行态。
  var panel = {
    scope: 'all',     // all | local | online
    q: '',
    input: '',
    epoch: 0,
    debounce: 0,
    controllers: [],
    sources: null,
  };

  function $(sel, root) { return (root || document).querySelector(sel); }

  function byId(id) { return document.getElementById(id); }

  function transport() { return window.VMusicTransport; }

  // -------------------------------------------------------------------------
  // 节点搬运（锚点还原）
  // -------------------------------------------------------------------------

  function relocate(node, parent, before) {
    if (!node || !parent) return node || null;
    var anchor = document.createElement('span');
    anchor.className = 'ln-anchor';
    anchor.setAttribute('data-ln', '1');
    node.parentNode.insertBefore(anchor, node);
    if (before) parent.insertBefore(node, before);
    else parent.appendChild(node);
    moves.push({ node: node, anchor: anchor });
    return node;
  }

  function restoreMoves() {
    // 后进先出：被包裹进新节点的（如 disc-wrap 进 .bar-row1、stage 进 .ln-right），
    // 内层先还原到锚点（锚点在原容器），顺序天然安全。
    for (var i = moves.length - 1; i >= 0; i -= 1) {
      var m = moves[i];
      if (m.anchor.parentNode) m.anchor.parentNode.insertBefore(m.node, m.anchor);
      if (m.anchor.parentNode) m.anchor.remove();
    }
    moves = [];
  }

  // -------------------------------------------------------------------------
  // 新建结构节点
  // -------------------------------------------------------------------------

  function make(tag, cls, parent) {
    var n = document.createElement(tag || 'div');
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    built.push(n);
    return n;
  }

  function removeBuilt() {
    built.forEach(function (n) {
      if (n.parentNode) n.parentNode.removeChild(n);
    });
    built = [];
  }

  // -------------------------------------------------------------------------
  // 播放卡重排
  // -------------------------------------------------------------------------

  function rearrangeBar(bar) {
    // 行1：唱片（变方封面）+ 曲目信息
    var row1 = make('div', 'bar-row1');
    relocate($('.disc-wrap', refs.stage), row1);
    relocate(byId('bar-track'), row1);
    bar.insertBefore(row1, bar.firstChild);

    // 行2：进度（bar-progress 提到 bar-controls 之前；track 移走后 controls 在首）
    var controls = $('.bar-controls', bar);
    var progress = $('.bar-progress', bar);
    // 全部走 relocate：原位留锚点，unmount 经 restoreMoves 严格回位
    // （直接 DOM 操作会让切走皮肤后 progress/controls 顺序错乱）。
    if (progress && controls) relocate(progress, bar, controls);

    // 行3：模式按钮进 controls 最左，音量进 controls 最右（VMusic 控制序）。
    var mode = byId('mode');
    var volume = $('.bar-volume', bar);
    if (mode) relocate(mode, controls, controls.firstChild);
    if (volume) relocate(volume, controls);
  }

  function setCapsule(compact, silent) {
    refs.bar.classList.toggle('ln-capsule', compact);
    refs.capsuleBtn.textContent = compact ? '展开' : '收为胶囊';
    refs.capsuleBtn.setAttribute('aria-expanded', String(!compact));
    refs.capsuleBtn.setAttribute('aria-label', compact ? '展开播放卡' : '收为播放胶囊');
    if (!silent) {
      try { localStorage.setItem(CAPSULE_KEY, compact ? '1' : '0'); } catch (error) {}
    }
  }

  function buildPlayerChrome() {
    var heading = make('div', 'ln-player-heading');
    refs.bar.insertBefore(heading, refs.bar.firstChild);
    make('span', 'ln-player-label', heading).textContent = '此刻，听见';
    var actions = make('div', 'ln-player-actions', heading);
    var stageButton = make('button', 'ln-stage-entry', actions);
    stageButton.type = 'button';
    stageButton.textContent = '凝彩舞台 ↗';
    stageButton.addEventListener('click', function () {
      if (!window.Stage3D) return;
      window.Stage3D.configure({ foliaVisual: 'tempera', foliaBg: 'solid', lyrics: true, stageTheme: 'starfall' });
      window.Stage3D.open();
      window.Stage3D.save();
    });
    refs.capsuleBtn = make('button', 'ln-capsule-toggle', actions);
    refs.capsuleBtn.type = 'button';
    refs.capsuleBtn.addEventListener('click', function () {
      setCapsule(!refs.bar.classList.contains('ln-capsule'));
    });
    var preference = null;
    try {
      var saved = localStorage.getItem(CAPSULE_KEY);
      if (saved === '0' || saved === '1') preference = saved === '1';
    } catch (error) {}
    setCapsule(preference === null ? window.innerWidth <= 620 : preference, true);
  }

  // -------------------------------------------------------------------------
  // 中栏胶囊导航
  // -------------------------------------------------------------------------

  function buildNavigation() {
    refs.nav = make('nav', 'ln-nav');
    refs.nav.setAttribute('aria-label', '页面导航');
    refs.column.insertBefore(refs.nav, refs.column.firstChild);
    [['library', '首页'], ['online', '在线'], ['playlists', '歌单'],
      ['favorites', '收藏'], ['queue', '队列'], ['settings', '设置']].forEach(function (entry) {
      var button = make('button', 'ln-nav-item', refs.nav);
      button.type = 'button';
      button.dataset.lnView = entry[0];
      button.textContent = entry[1];
      button.addEventListener('click', function () { clickRailItem(entry[0]); });
    });
  }

  // .rail 虽隐藏，业务的视图切换逻辑仍挂在其按钮上：程序化点击即可复用
  // 整套 setView 链路，避免重写业务行为。
  function clickRailItem(view) {
    var item = refs.rail.querySelector('.rail-item[data-view="' + view + '"]');
    if (item && !item.classList.contains('active')) item.click();
    if (mounted) reflow();
    return item;
  }

  function buildHomeChrome() {
    var tools = $('#view-library .col-tools');
    if (tools) {
      var wrap = make('details', 'ln-library-tools', tools.parentNode);
      make('summary', '', wrap).textContent = '曲库管理';
      relocate(tools, wrap);
    }
    var dailyHead = $('#daily-strip .daily-head');
    if (dailyHead) {
      var more = make('button', 'ln-daily-more', dailyHead);
      refs.dailyMore = more;
      more.type = 'button';
      more.textContent = '查看全部 →';
      more.addEventListener('click', function () { clickRailItem('daily'); });
    }
  }

  // -------------------------------------------------------------------------
  // 视图切换联动（简化：滚动归零 + 导航高亮）
  // -------------------------------------------------------------------------

  function currentViewId() {
    var v = refs.column.querySelector('.view:not([hidden])');
    return v ? v.id : '';
  }

  function reflow() {
    if (inReflow) return;
    inReflow = true;
    try { reflowInner(); } finally { inReflow = false; }
  }

  function reflowInner() {
    var id = currentViewId();
    if (refs.viewId !== id) {
      refs.column.scrollTop = 0;
      revealCurrentView();
    }
    refs.viewId = id;
    var dailyNav = refs.rail.querySelector('[data-view="daily"]');
    if (refs.dailyMore) refs.dailyMore.hidden = !dailyNav || dailyNav.hidden;
    if (dailyNav && observer) observer.observe(dailyNav, { attributes: true, attributeFilter: ['hidden'] });
    refs.column.dataset.lnView = id.replace(/^view-/, '');
    var navKey = id === 'view-daily' ? 'library' : id.replace(/^view-/, '');
    refs.nav.querySelectorAll('[data-ln-view]').forEach(function (button) {
      var selected = button.dataset.lnView === navKey;
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }

  // 中栏顶部是导航 + 播放卡（约 250px）：长列表视图停在 scrollTop=0 时，
  // 整块结果落在首屏之外。视图顶部距栏顶过远时把它带进可视区。
  function revealCurrentView() {
    var column = refs.column;
    var view = column.querySelector('.view:not([hidden])');
    if (!view) return;
    if (column.scrollHeight <= column.clientHeight + 4) return;
    var delta = view.getBoundingClientRect().top - column.getBoundingClientRect().top;
    if (delta < column.clientHeight * 0.6) return;
    column.scrollTop += Math.max(0, delta - 6);
  }

  // -------------------------------------------------------------------------
  // 搜索面板
  // -------------------------------------------------------------------------

  function emit(action, extra) {
    var detail = Object.assign({ action: action }, extra || {});
    document.dispatchEvent(new CustomEvent('ln:panel', { detail: detail }));
  }

  function buildSearchPanel(host) {
    var sp = make('section', 'ln-sp', host);

    // 第一行：检索范围
    var scopeBar = make('div', 'ln-sp-scope', sp);
    [['all', '全部'], ['local', '本地'], ['online', '在线']].forEach(function (s) {
      var b = make('button', 'ln-sp-chip' + (s[0] === 'all' ? ' active' : ''), scopeBar);
      b.type = 'button';
      b.dataset.scope = s[0];
      b.textContent = s[1];
      b.setAttribute('aria-pressed', s[0] === 'all' ? 'true' : 'false');
      b.addEventListener('click', function () {
        if (panel.scope === s[0]) return;
        panel.scope = s[0];
        scopeBar.querySelectorAll('.ln-sp-chip').forEach(function (c) {
          var on = c === b;
          c.classList.toggle('active', on);
          c.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        runSearch(panel.input);
      });
    });

    // 第二行：输入框
    var field = make('div', 'ln-sp-field', sp);
    field.innerHTML = '<svg class="ln-sp-ico" viewBox="0 0 24 24" aria-hidden="true">'
      + '<use href="#i-search"/></svg>';
    var input = make('input', 'ln-sp-q', field);
    input.type = 'search';
    input.placeholder = '搜索本地与在线曲库';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', '搜索本地与在线曲库');
    var clearBtn = make('button', 'ln-sp-clear', field);
    clearBtn.type = 'button';
    clearBtn.setAttribute('aria-label', '清空搜索');
    clearBtn.hidden = true;
    clearBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-close"/></svg>';

    // 结果/历史滚动区
    refs.panelOut = make('div', 'ln-sp-out', sp);

    input.addEventListener('input', function () {
      panel.input = input.value;
      clearBtn.hidden = input.value === '';
      clearTimeout(panel.debounce);
      panel.debounce = setTimeout(function () { runSearch(input.value); }, 250);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        clearTimeout(panel.debounce);
        var q = input.value.trim();
        if (q) pushHistory(q);
        runSearch(input.value);
      }
    });
    clearBtn.addEventListener('click', function () {
      clearTimeout(panel.debounce);
      input.value = '';
      panel.input = '';
      clearBtn.hidden = true;
      input.focus();
      runSearch('');
    });

    renderHistory();
  }

  function abortPending() {
    panel.controllers.forEach(function (c) { try { c.abort(); } catch (e) {} });
    panel.controllers = [];
  }

  function makeSignal() {
    if (typeof AbortController !== 'function') return null;
    var c = new AbortController();
    panel.controllers.push(c);
    return c.signal;
  }

  function runSearch(raw) {
    var q = (raw || '').trim();
    abortPending();
    panel.epoch += 1;
    var epoch = panel.epoch;
    panel.q = q;

    if (!q) {
      clearResults();
      renderHistory();
      return;
    }
    clearHistoryView();
    var out = refs.panelOut;
    out.textContent = '';

    if (panel.scope === 'local' || panel.scope === 'all') {
      refs.localSec = buildSection(out, '本地歌曲');
      searchLocal(epoch, q);
    }
    if (panel.scope === 'online' || panel.scope === 'all') {
      refs.onlineSec = buildSection(out, '在线曲库');
      searchOnline(epoch, q);
    }
  }

  // 一个结果分区：标题 + 计数 + 「查看全部」+ 行容器。
  function buildSection(out, name) {
    var sec = make('section', 'ln-sp-sec', out);
    var head = make('div', 'ln-sp-sec-head', sec);
    make('span', 'ln-sp-sec-name', head).textContent = name;
    make('span', 'ln-sp-sec-count', head);
    var more = make('button', 'ln-sp-more', head);
    more.type = 'button';
    var rows = make('div', 'ln-sp-rows', sec);
    var status = make('div', 'ln-sp-status', sec);
    return { sec: sec, head: head, rows: rows, status: status, more: more };
  }

  function setSectionStatus(sec, text, kind) {
    if (!sec) return;
    sec.status.textContent = text || '';
    sec.status.className = 'ln-sp-status' + (kind ? ' is-' + kind : '');
    sec.status.hidden = !text;
  }

  function setSectionCount(sec, n) {
    if (!sec) return;
    var c = sec.head.querySelector('.ln-sp-sec-count');
    c.textContent = n ? n + ' 条' : '';
  }

  function searchLocal(epoch, q) {
    setSectionStatus(refs.localSec, '搜索中…', 'loading');
    var signal = makeSignal();
    var url = '/v1/tracks?q=' + encodeURIComponent(q) + '&limit=8';
    transport().get(url, signal ? { signal: signal } : {})
      .then(function (page) {
        if (epoch !== panel.epoch) return;
        renderLocalRows(page.tracks || []);
      })
      .catch(function (err) {
        if (epoch !== panel.epoch || (err && err.name === 'AbortError')) return;
        setSectionStatus(refs.localSec, '本地搜索失败，点击重试', 'error');
        refs.localSec.status.onclick = function () { searchLocal(epoch, q); };
      });
  }

  function renderLocalRows(tracks) {
    if (!refs.localSec) return;
    setSectionStatus(refs.localSec, tracks.length ? '' : '本地曲库没有匹配的歌曲', tracks.length ? '' : 'empty');
    setSectionCount(refs.localSec, tracks.length);
    refs.localSec.rows.textContent = '';
    tracks.forEach(function (t) {
      var cover = t.has_cover ? transport().coverUrl(t.id) : '';
      var row = buildResultRow({
        cover: cover,
        title: t.title,
        sub: t.artist || '未知艺术家',
      });
      row.addEventListener('click', function () {
        pushHistory(panel.q);
        emit('play-local', { id: t.id });
      });
      refs.localSec.rows.appendChild(row);
    });
    if (tracks.length) {
      refs.localSec.more.textContent = '在曲库页查看全部 →';
      refs.localSec.more.hidden = false;
      refs.localSec.more.onclick = function () {
        emit('view-local', { q: panel.q });
      };
    } else {
      refs.localSec.more.hidden = true;
    }
  }

  function ensureSources(epoch) {
    if (panel.sources) return Promise.resolve(panel.sources);
    return transport().get('/v1/online/sources')
      .then(function (data) {
        if (epoch !== panel.epoch) return null;
        panel.sources = data.sources || [];
        return panel.sources;
      })
      .catch(function () {
        if (epoch !== panel.epoch) return null;
        return [];
      });
  }

  function searchOnline(epoch, q) {
    setSectionStatus(refs.onlineSec, '正在读取音源…', 'loading');
    var signal = makeSignal();
    ensureSources(epoch).then(function (sources) {
      if (epoch !== panel.epoch) return;
      if (!sources) {
        setSectionStatus(refs.onlineSec, '音源列表读取失败，点击重试', 'error');
        refs.onlineSec.status.onclick = function () {
          panel.sources = null; searchOnline(epoch, q);
        };
        return;
      }
      if (!sources.length) {
        setSectionStatus(refs.onlineSec, '没有可用音源', 'empty');
        return;
      }
      setSectionStatus(refs.onlineSec, '搜索中…', 'loading');
      var perSource = Promise.all(sources.map(function (s) {
        var url = '/v1/online/search?source=' + encodeURIComponent(s.id)
          + '&q=' + encodeURIComponent(q) + '&limit=3';
        return transport().get(url, signal ? { signal: signal } : {})
          .then(function (d) {
            return (d.tracks || []).map(function (t) {
              return Object.assign({}, t, { source: s.id });
            });
          })
          .catch(function () { return []; });
      }));
      perSource.then(function (bySource) {
        if (epoch !== panel.epoch) return;
        // 交错合并：各源第 1 条、各源第 2 条……更像聚合搜索的混排结果。
        var flat = [];
        for (var i = 0; i < 3; i += 1) {
          bySource.forEach(function (list) { if (list[i]) flat.push(list[i]); });
        }
        renderOnlineRows(flat, q);
      });
    });
  }

  function renderOnlineRows(tracks, q) {
    if (!refs.onlineSec) return;
    setSectionStatus(refs.onlineSec, tracks.length ? '' : '在线曲库没有匹配的结果', tracks.length ? '' : 'empty');
    setSectionCount(refs.onlineSec, tracks.length);
    refs.onlineSec.rows.textContent = '';
    tracks.forEach(function (t) {
      var cover = '';
      if (window.Online) cover = window.Online.rowCoverUrl(window.Online.safeCoverUrl(t.cover));
      var row = buildResultRow({
        cover: cover,
        title: t.title,
        sub: [t.artist, t.album].filter(Boolean).join(' · ') || '未知艺术家',
      });
      if (window.Online) {
        var badgeWrap = make('span', 'ln-sp-badge', row);
        badgeWrap.appendChild(window.Online.badge(t.source));
      }
      row.addEventListener('click', function () {
        pushHistory(panel.q);
        emit('play-online', { track: t });
      });
      refs.onlineSec.rows.appendChild(row);
    });
    if (tracks.length) {
      refs.onlineSec.more.textContent = '在在线页查看全部 →';
      refs.onlineSec.more.hidden = false;
      refs.onlineSec.more.onclick = function () {
        emit('view-online', { q: panel.q });
      };
    } else {
      refs.onlineSec.more.hidden = true;
    }
  }

  // 结果行：封面 + 标题/艺人（标题省略号），尾部可挂徽标。
  function buildResultRow(opts) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'ln-sp-row';
    var cover = document.createElement('span');
    cover.className = 'ln-sp-cover';
    if (opts.cover) {
      var img = document.createElement('img');
      img.src = opts.cover;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      cover.appendChild(img);
    }
    row.appendChild(cover);
    var meta = document.createElement('span');
    meta.className = 'ln-sp-meta';
    var title = document.createElement('span');
    title.className = 'ln-sp-title';
    title.textContent = opts.title;
    var sub = document.createElement('span');
    sub.className = 'ln-sp-sub';
    sub.textContent = opts.sub;
    meta.appendChild(title);
    meta.appendChild(sub);
    row.appendChild(meta);
    return row;
  }

  // ---------------------------- 搜索历史 -----------------------------------

  function readHistory() {
    try {
      var raw = localStorage.getItem(HISTORY_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }

  function writeHistory(list) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch (e) {}
  }

  function pushHistory(q) {
    q = (q || '').trim();
    if (!q) return;
    var list = readHistory().filter(function (x) { return x !== q; });
    list.unshift(q);
    writeHistory(list.slice(0, HISTORY_MAX));
    if (!panel.q) renderHistory();
  }

  function removeHistory(q) {
    writeHistory(readHistory().filter(function (x) { return x !== q; }));
    renderHistory();
  }

  function clearResults() {
    refs.panelOut.textContent = '';
    refs.localSec = null;
    refs.onlineSec = null;
  }

  function clearHistoryView() {
    var block = refs.panelOut.querySelector('.ln-sp-history');
    if (block) block.remove();
  }

  function renderHistory() {
    if (!refs.panelOut) return;
    refs.panelOut.textContent = '';
    refs.localSec = null;
    refs.onlineSec = null;
    var list = readHistory();
    var block = make('section', 'ln-sp-history', refs.panelOut);
    var head = make('div', 'ln-sp-sec-head', block);
    make('span', 'ln-sp-sec-name', head).textContent = '搜索历史';
    var clearAll = make('button', 'ln-sp-more', head);
    clearAll.type = 'button';
    clearAll.textContent = '清空';
    clearAll.hidden = !list.length;
    clearAll.addEventListener('click', function () {
      writeHistory([]);
      renderHistory();
    });
    var chips = make('div', 'ln-sp-hist-chips', block);
    if (!list.length) {
      var hint = make('div', 'ln-sp-status is-empty', chips);
      hint.textContent = '输入关键词，同时搜索本地与在线曲库';
      return;
    }
    list.forEach(function (q) {
      var chip = make('button', 'ln-sp-hist', chips);
      chip.type = 'button';
      var txt = document.createElement('span');
      txt.className = 'ln-sp-hist-q';
      txt.textContent = q;
      chip.appendChild(txt);
      var del = make('span', 'ln-sp-hist-del', chip);
      del.setAttribute('aria-hidden', 'true');
      del.textContent = '×';
      del.title = '删除该记录';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        removeHistory(q);
      });
      chip.addEventListener('click', function () {
        var input = $('.ln-sp-q');
        if (input) {
          input.value = q;
          panel.input = q;
          var clearBtn = $('.ln-sp-clear');
          if (clearBtn) clearBtn.hidden = false;
        }
        runSearch(q);
      });
    });
  }

  // -------------------------------------------------------------------------
  // 安装 / 卸载
  // -------------------------------------------------------------------------

  function mount() {
    if (mounted) return;
    var rail = byId('rail');
    var column = byId('column');
    var stage = byId('stage');
    var bar = $('.bar');
    var app = $('.app');
    if (!rail || !column || !stage || !bar || !app) return; // DOM 未就绪

    mounted = true;
    refs.rail = rail;
    refs.column = column;
    refs.stage = stage;
    refs.bar = bar;

    // 1) 右栏包裹器：上搜索面板 + 下舞台
    refs.rightWrap = make('div', 'ln-right', app);

    // 2) 搜索面板（先建，位于包裹器顶部）
    buildSearchPanel(refs.rightWrap);

    // 3) 舞台搬入包裹器下部（原位留锚点）
    relocate(stage, refs.rightWrap);

    // 4) 播放卡搬进中栏最前并重排；再建胶囊导航（导航在播放卡之上）
    relocate(bar, column, column.firstChild);
    rearrangeBar(bar);
    buildPlayerChrome();
    buildNavigation();
    buildHomeChrome();

    // 5) 频谱卡标题对齐
    var kicker = $('.stage-kicker', stage);
    if (kicker) {
      savedText.push({ node: kicker, text: kicker.textContent });
      kicker.textContent = 'Vocal Performance';
    }

    // 6) 视图切换联动
    observer = new MutationObserver(function () { if (mounted) reflow(); });
    Array.prototype.forEach.call(column.querySelectorAll('.view'), function (v) {
      observer.observe(v, { attributes: true, attributeFilter: ['hidden'] });
    });

    reflow();
  }

  function unmount() {
    if (!mounted) return;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    abortPending();
    clearTimeout(panel.debounce);
    restoreMoves();
    refs.bar.classList.remove('ln-capsule');
    delete refs.column.dataset.lnView;
    removeBuilt();
    if (keyHandler) {
      document.removeEventListener('keydown', keyHandler);
      keyHandler = null;
    }
    savedText.forEach(function (s) { s.node.textContent = s.text; });
    savedText = [];
    refs = {};
    mounted = false;
    panel.sources = null;
  }

  function isActiveSkin() {
    return document.documentElement.getAttribute('data-skin') === SKIN_ID;
  }

  function onSkinChanged(e) {
    var id = e && e.detail ? e.detail.id
      : document.documentElement.getAttribute('data-skin');
    if (id === SKIN_ID) mount();
    else unmount();
  }

  document.addEventListener('skin:changed', onSkinChanged);

  if (isActiveSkin()) mount();

  // 暴露仅用于排障/契约脚本：返回当前挂载状态。
  window.__lnSkin = {
    isMounted: function () { return mounted; },
    reflow: function () { if (mounted) reflow(); }
  };
})();
