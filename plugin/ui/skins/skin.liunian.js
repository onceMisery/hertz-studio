// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 皮肤：liunian（流年）—— DOM 重编排层（零依赖 IIFE）。
//
// 背景
// ----
// 本项目是 SPA：.rail 导航 → .column 六个视图 → .stage 舞台，.bar 是 body 末尾
// 的播放条。流年皮肤对骨架做如下调整（v3）：
//   · 移除最左侧 .rail 导航轨（display:none，节点保留以备程序化点击与还原）；
//   · 中栏顶部新建胶囊导航 .ln-nav（六个一级目的地）；
//   · 「设置」不进中栏视图，而是把 #view-settings 搬进浮层 .ln-modal
//     （遮罩 + 卡片 + 入退场动画），底层中栏保持原视图不动；
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
//     `Skins.request` 通用请求交给 app.js 分流。

(function () {
  'use strict';

  // 低层工具复用 skins/skin-shared.js（顺序加载保证它先于本模块）：
  // 封面位图回填、带锚点的搬运与还原、自建节点登记。
  var applyImg = window.SkinShared.applyImg;

  var SKIN_ID = 'liunian';

  var mounted = false;
  // 搬运控制器：原位留 <span class="ln-anchor" data-ln="1">，卸载时 LIFO 还原。
  var moves = window.SkinShared.createMoves('ln-anchor', 'data-ln');
  // 自建节点登记：卸载时统一 remove。
  var built = window.SkinShared.createBuilt();
  var observer = null;
  var refs = {};      // 重编排队列里的 DOM 引用
  var savedText = []; // 临时改过的文本，{ node, text }
  var inReflow = false; // reflow 重入保护

  var CAPSULE_KEY = 'vmusic.ln-capsule';
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

  // 设置浮层运行态。viewEl 是被搬进浮层的 #view-settings 本体，
  // lastFocus 用于关闭后把焦点还给触发按钮。
  var sheet = {
    root: null,
    card: null,
    viewEl: null,
    open: false,
    closing: false,
    closeTimer: 0,
    lastFocus: null,
    nav: null,        // 左栏分类导航
    entries: [],      // [{ key, group }]：左栏条目与它控制的 .set-group
    active: '',       // 当前条目的 key
  };

  // 设置分类表：左栏一级分组 + 二级条目，右栏一次只显示一条对应的分组。
  //
  // 条目按 .set-group 的标题文案（.set-title 的文字）认领，而不是靠序号或
  // 额外标记 —— 皮肤层不往业务 HTML 里塞属性，业务日后新增分组也不用改这里。
  // 认领不到的分组统一落进末尾的「其它」，保证新设置不会从导航里消失。
  var SET_SECTIONS = [
    {
      id: 'appearance',
      label: '外观',
      items: [
        ['skin', '界面皮肤', '只换布局，不动主题色'],
        ['look', '外观', '主题色、密度、动效与输出设备'],
        ['wall', '主题与壁纸', '二次元主题与背景图'],
        ['nav', '导航', '导航里显示哪些入口'],
        ['walllook', '海报墙', '队列拼接的观感与跟随（仅清风生效）'],
      ],
    },
    {
      id: 'playback',
      label: '播放',
      items: [
        ['audio', '音效与均衡器', '均衡器、增益与响度归一'],
        ['play', '播放', '加入队列的默认行为与播放落点'],
        ['lyrics', '歌词', '全局偏移、逐行过滤与片头人员行'],
        // 与清风那张表保持一致：业务加了这个分组，两边都得认领，
        // 否则它会掉进末尾的「其它」——分类在，但要多点一次才找得到。
        ['lyricout', '歌词输出（OBS 浮层）', 'OBS 浏览器源的歌词浮层地址'],
        ['videoexport', '歌词视频导出', '舞台画面与歌词录成视频'],
        ['window', '窗口与舞台', '沉浸声场与胶囊播放器'],
        ['stage', '创意舞台', '创意工坊与手绘风格'],
        ['keys', '快捷键', '键盘操作一览'],
      ],
    },
    {
      id: 'library',
      label: '数据与在线',
      items: [
        ['source', '在线音源', '各音源的登录 cookie'],
        ['remote', '远程来源（WebDAV）', '连自己的 WebDAV 目录'],
        ['cache', '在线缓存', '缓存占用与清理'],
        ['backup', '数据备份', '导入导出歌单与设置'],
      ],
    },
    {
      id: 'advanced',
      label: '高级',
      items: [
        ['dev', '开发者选项', '播放诊断日志'],
      ],
    },
  ];

  var SECTION_KEY = 'vmusic.ln-set-section';

  // 退场动画时长，与 skin.liunian.css 里 .ln-modal-card 的 transition 时长
  // 对齐。CSS 改了就同步改这里，否则会出现「动画还没完内容先消失」。
  var MODAL_EXIT_MS = 200;

  function $(sel, root) { return (root || document).querySelector(sel); }

  function byId(id) { return document.getElementById(id); }

  function transport() { return window.VMusicTransport; }

  // -------------------------------------------------------------------------
  // 节点搬运（锚点还原）
  // -------------------------------------------------------------------------

  function relocate(node, parent, before) {
    return moves.relocate(node, parent, before);
  }

  function restoreMoves() {
    moves.restore();
  }

  // -------------------------------------------------------------------------
  // 新建结构节点
  // -------------------------------------------------------------------------

  function make(tag, cls, parent) {
    return built.make(tag, cls, parent);
  }

  function removeBuilt() {
    built.remove();
  }

  // -------------------------------------------------------------------------
  // 播放卡重排
  // -------------------------------------------------------------------------

  function rearrangeBar(bar) {
    // 行1：唱片（变方封面）+ 曲目信息
    var row1 = make('div', 'bar-row1');
    relocate($('.disc-wrap', refs.stage), row1);
    relocate(byId('bar-summary'), row1);
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
    refs.capsuleBtn.textContent = compact ? '展开' : '收起';
    refs.capsuleBtn.setAttribute('aria-expanded', String(!compact));
    refs.capsuleBtn.setAttribute('aria-label', compact ? '展开播放卡' : '收为播放胶囊');
    if (!silent) {
      // 隐私模式/配额满：记不住本机偏好而已，折叠态本次会话照常生效。
      try { localStorage.setItem(CAPSULE_KEY, compact ? '1' : '0'); } catch (error) { /* 见上 */ }
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
      window.Stage3D.configure({ stanzaVisual: 'tempera', stanzaBg: 'solid', lyrics: true, stageTheme: 'starfall' });
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
    } catch (error) { /* 读不到就按默认（收起）走，下一行处理 */ }
    // 播放胶囊默认收起（窄屏原本就收起），用户手动展开/收起后以偏好为准。
    setCapsule(preference === null ? true : preference, true);
  }

  // -------------------------------------------------------------------------
  // 中栏胶囊导航
  // -------------------------------------------------------------------------

  function buildNavigation() {
    refs.nav = make('nav', 'ln-nav');
    refs.nav.setAttribute('aria-label', '页面导航');
    refs.column.insertBefore(refs.nav, refs.column.firstChild);
    [['library', '首页'], ['online', '在线'], ['podcasts', '播客'], ['playlists', '歌单'],
      ['favorites', '收藏'], ['queue', '队列'], ['settings', '设置']].forEach(function (entry) {
      var button = make('button', 'ln-nav-item', refs.nav);
      button.type = 'button';
      button.dataset.lnView = entry[0];
      button.textContent = entry[1];
      // 「设置」走浮层，不进中栏视图；其余仍复用隐藏 rail 的程序化点击。
      button.addEventListener('click', function () {
        if (entry[0] === 'settings') {
          if (sheet.open) closeSettingsSheet();
          else openSettingsSheet(button);
          reflow();
          return;
        }
        // 浮层开着时切别的视图：先收掉，免得它悬在新视图上面。
        if (sheet.open) closeSettingsSheet();
        clickRailItem(entry[0]);
      });
      if (entry[0] === 'settings') button.setAttribute('aria-haspopup', 'dialog');
    });
  }

  // .rail 虽隐藏，业务的视图切换逻辑仍挂在其按钮上：程序化点击即可复用
  // 整套 setView 链路，避免重写业务行为。
  function clickRailItem(view) {
    // 设置视图已被搬进浮层，程序化点击它会让 setView 把中栏其它视图全藏掉、
    // 却什么也看不见（设置视图不在中栏了）。统一改成开浮层。
    if (view === 'settings') {
      openSettingsSheet();
      reflow();
      return null;
    }
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
    syncSettingsVisibility();
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
    // 设置视图搬进浮层后不再出现在中栏，所以浮层开着时「设置」才是当前项。
    if (sheet.open) navKey = 'settings';
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
    return window.Skins.request(action, extra);
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
    // abort() 本身不抛；包一层是防个别内核对已结束的 controller 抛异常。
    panel.controllers.forEach(function (c) { try { c.abort(); } catch (e) { /* 见上 */ } });
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
      applyImg(img, opts.cover);
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
  // 存储与规则交给 `search-history.js`（唯一的 owner）：关键词历史属于搜索能力
  // 本身，不属于这套皮肤。原先这里是 `vmusic.ln-search-history` 私有键，于是
  // 顶栏与在线框敲的词进不来、换皮肤就看不见。下面四个函数只保留「流年怎么
  // 渲染与何时记一笔」这一层。

  function readHistory() {
    return window.HertzSearchHistory ? window.HertzSearchHistory.all() : [];
  }

  function pushHistory(q) {
    if (!window.HertzSearchHistory) return;
    var list = window.HertzSearchHistory.push(q);
    // 空查询面板才是「历史」视图；已经有输入时不要抢走刚渲染的结果。
    if (!panel.q) renderHistory();
    return list;
  }

  function removeHistory(q) {
    if (window.HertzSearchHistory) window.HertzSearchHistory.remove(q);
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
      if (window.HertzSearchHistory) window.HertzSearchHistory.clear();
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
  // 设置浮层
  // -------------------------------------------------------------------------
  //
  // 流年把「设置」从中栏视图改成浮层：#view-settings 整个搬进 .ln-modal 的
  // .ln-modal-body（relocate 留锚点，切皮肤时严格回位），业务节点与事件原样
  // 跟着走，所以设置项的增删改完全不用两处维护。
  //
  // 层级：浮层挂在 body 末尾、z-index 高于所有底层面板（.app 6 / np 96 /
  // stage3d 90 / online 弹窗 100），因此舞台、搜索面板、播放卡都在它之下，
  // 不会被它的遮罩或入场动画压住。
  //
  // 显隐：CSS 用 [hidden] 之外的 .is-open / .is-closing 两个状态跑过渡，
  // 关闭动画结束后才置 hidden —— 直接 display:none 会让退场动画根本不播。

  function buildSettingsSheet() {
    // 挂 body 末尾：body 是 .app / .bar 之上的一层，浮层放在这里才不会被
    // 中栏的 overflow:hidden 裁掉，也不会与底层面板抢同一个包含块。
    var root = make('div', 'ln-modal', document.body);
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');

    var scrim = make('div', 'ln-modal-scrim', root);
    var card = make('section', 'ln-modal-card', root);
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', '设置');

    var head = make('header', 'ln-modal-head', card);
    var title = make('div', 'ln-modal-titles', head);
    make('h2', 'ln-modal-title', title).textContent = '设置';
    make('p', 'ln-modal-sub', title).textContent = '皮肤、主题、播放与数据，全部在这里';
    var close = make('button', 'ln-modal-close', head);
    close.type = 'button';
    close.setAttribute('aria-label', '关闭设置');
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-close"/></svg>';

    var body = make('div', 'ln-modal-body', card);
    var view = byId('view-settings');
    if (!view) return;            // 业务 HTML 没有设置视图：留空壳，不抛
    var layout = make('div', 'ln-set-layout', body);
    var nav = make('nav', 'ln-set-nav', layout);
    nav.setAttribute('aria-label', '设置分类');
    var pane = make('div', 'ln-set-pane', layout);
    relocate(view, pane);        // 原位留锚点，卸载时回位

    buildSetNav(nav, view);

    scrim.addEventListener('click', function () { closeSettingsSheet(); });
    close.addEventListener('click', function () { closeSettingsSheet(); });

    sheet.root = root;
    sheet.card = card;
    sheet.viewEl = view;
    sheet.nav = nav;
    // 浮层常驻但默认 hidden，Enter 不需要特殊处理：display 从 none 恢复时
    // .ln-modal-card 的入场动画会自动播放。
    view.hidden = true;
  }

  // -------------------------------------------------------------------------
  // 设置分类导航（左栏）
  // -------------------------------------------------------------------------
  //
  // #view-settings 里是 12 个平铺的 .set-group，单列一路滚到底。这里给它们
  // 套一层分类：左栏列出「外观 / 播放 / 数据与在线 / 高级」，点一条，右栏
  // 只显示它对应的那一个 .set-group。
  //
  // 两处刻意保持克制：
  //   · 不搬 .set-group —— 只切 hidden。搬家要维护锚点，而 hidden 是它本来就
  //     有的语义（[hidden] 有 !important，别的皮肤照旧），切皮肤零残留。
  //   · 不改业务 HTML —— 分组靠 .set-title 文案认领，见 SET_SECTIONS 的注释。
  //     认领不到的落进「其它」，所以业务加新设置时这里是「多一项」而不是
  //     「新设置不出现」。

  function groupTitle(group) {
    var head = group.querySelector('.set-title');
    return head ? head.textContent.trim() : '';
  }

  function readSectionKey() {
    try { return localStorage.getItem(SECTION_KEY) || ''; } catch (e) { return ''; }
  }

  function writeSectionKey(key) {
    try { localStorage.setItem(SECTION_KEY, key); } catch (e) { /* 隐私模式等 */ }
  }

  function selectSection(key) {
    if (!sheet.entries.length) return;
    var found = false;
    sheet.entries.forEach(function (entry) {
      if (entry.key === key) found = true;
      entry.group.hidden = entry.key !== key;
    });
    if (!found) return;          // 记住的 key 已不存在：保持当前选择
    sheet.active = key;
    writeSectionKey(key);
    if (sheet.nav) {
      sheet.nav.querySelectorAll('.ln-set-link').forEach(function (button) {
        var on = button.dataset.lnKey === key;
        button.classList.toggle('active', on);
        if (on) button.setAttribute('aria-current', 'true');
        else button.removeAttribute('aria-current');
      });
    }
    if (sheet.viewEl) sheet.viewEl.scrollTop = 0;
  }

  function buildSetNav(nav, view) {
    var groups = Array.prototype.slice.call(view.querySelectorAll('.set-group'));
    if (!groups.length) return;  // 没有分组可分类：留空栏，右栏照旧

    var byKey = {};              // key -> { key, group, label, note }
    var order = [];              // key 的认领顺序，仅供「其它」类沿用 DOM 次序
    var leftovers = [];          // 认领不到的分组（业务新增的）

    groups.forEach(function (group) {
      var title = groupTitle(group);
      var found = null;
      SET_SECTIONS.forEach(function (section) {
        if (found) return;
        section.items.forEach(function (item) {
          if (item[1] === title) found = { key: item[0], note: item[2] };
        });
      });
      if (found) {
        byKey[found.key] = { key: found.key, group: group, label: title, note: found.note };
        order.push(found.key);
      } else {
        leftovers.push({ group: group, label: title });
      }
    });

    var claimed = [];
    SET_SECTIONS.forEach(function (section) {
      var entries = [];
      // 条目顺序由 SET_SECTIONS 决定，不按 DOM 次序：分类表是唯一的排序
      // 权威（照 DOM 排会把「在线音源」挤到「数据备份」后面，那是业务
      // HTML 里的偶然位置，不是人该用的次序）。DOM 只在「其它」类里兜底。
      section.items.forEach(function (item) {
        if (byKey[item[0]]) { entries.push(byKey[item[0]]); claimed.push(byKey[item[0]]); }
      });
      if (!entries.length) return;  // 这一类在业务 HTML 里已不存在：不显示空类
      var cat = make('div', 'ln-set-cat', nav);
      cat.textContent = section.label;
      entries.forEach(function (entry) {
        appendSetLink(nav, entry.key, entry.label, entry.note);
      });
    });

    // 认领不到的（业务日后新增的设置）统一挂到末尾的「其它」分类，
    // key 用序号兜底，保证每条都有唯一可寻址的入口。
    if (leftovers.length) {
      var tail = make('div', 'ln-set-cat', nav);
      tail.textContent = '其它';
      leftovers.forEach(function (entry, i) {
        var key = 'other-' + i;
        entry.key = key;
        entry.note = '业务新增的设置';
        claimed.push(entry);
        appendSetLink(nav, key, entry.label || '未命名分组', entry.note);
      });
    }

    sheet.entries = claimed;

    // 默认落在上次看的那一类；没有记录（或记录已失效）就第一类。
    var initial = readSectionKey();
    if (!claimed.some(function (entry) { return entry.key === initial; })) {
      initial = claimed.length ? claimed[0].key : '';
    }

    nav.addEventListener('click', function (e) {
      var button = e.target.closest ? e.target.closest('.ln-set-link') : null;
      if (!button) return;
      selectSection(button.dataset.lnKey);
    });

    selectSection(initial);
  }

  function appendSetLink(nav, key, label, note) {
    var button = make('button', 'ln-set-link', nav);
    button.type = 'button';
    button.dataset.lnKey = key;
    var text = make('span', 'ln-set-link-text', button);
    text.textContent = label;
    if (note) {
      var hint = make('span', 'ln-set-link-note', button);
      hint.textContent = note;
    }
    return button;
  }

  function openSettingsSheet(trigger) {
    if (!sheet.root || !sheet.viewEl) return;
    if (sheet.open) return;
    sheet.open = true;
    sheet.closing = false;
    clearTimeout(sheet.closeTimer);
    sheet.lastFocus = trigger || document.activeElement;
    document.body.classList.add('ln-modal-open');
    sheet.viewEl.hidden = false;
    // 重新打开时把焦点那条所在的分组带回可见：上次可能是在「外观」下操作到
    // 一半就关掉浮层，切到别的分类再打开时该分组是 hidden 的，浏览器不会
    // 自动把焦点挪回来，键盘用户会直接掉到 body 上。
    var activeGroup = entryGroup(sheet.active);
    if (activeGroup) activeGroup.hidden = false;
    sheet.viewEl.scrollTop = 0;
    sheet.root.hidden = false;
    sheet.root.setAttribute('aria-hidden', 'false');
    sheet.root.classList.add('is-open');
    emit('settings-enter');
    // 焦点先落在左栏当前项：右栏只有一个分组，直接聚焦里面的控件会跳过
    // 分类导航这道门，键盘用户看不出自己在哪一类。
    var current = sheet.nav && sheet.nav.querySelector('.ln-set-link.active');
    var focusable = current || sheet.viewEl.querySelector('button, input, select');
    if (focusable) focusable.focus({ preventScroll: true });
    reflow();
  }

  function entryGroup(key) {
    for (var i = 0; i < sheet.entries.length; i += 1) {
      if (sheet.entries[i].key === key) return sheet.entries[i].group;
    }
    return null;
  }

  function closeSettingsSheet() {
    if (!sheet.open || sheet.closing) return;
    sheet.open = false;
    sheet.closing = true;
    document.body.classList.remove('ln-modal-open');
    sheet.root.classList.remove('is-open');
    sheet.root.classList.add('is-closing');
    // 退场动画跑完再藏。setTimeout 而非 transitionend：SwiftShader/旧内核下
    // 合成器时钟推不动过渡，transitionend 可能永远不来，浮层就卡在半开。
    clearTimeout(sheet.closeTimer);
    sheet.closeTimer = setTimeout(function () {
      sheet.closeTimer = 0;
      sheet.closing = false;
      if (!sheet.root) return;
      sheet.root.classList.remove('is-closing');
      sheet.root.hidden = true;
      sheet.root.setAttribute('aria-hidden', 'true');
      if (sheet.viewEl) sheet.viewEl.hidden = true;
      var back = sheet.lastFocus;
      sheet.lastFocus = null;
      if (back && back.focus) back.focus({ preventScroll: true });
    }, MODAL_EXIT_MS);
    reflow();
  }

  // 顶栏「设置」图标走的是业务 setView('settings')，而设置视图已被搬进浮层：
  // 真让它跑完会把中栏其它视图全藏掉、设置视图又不在中栏，结果是一整列空白。
  // 在 capture 阶段拦下（比按钮自己的 onclick 早），统一改成开关浮层。
  function onDocumentClickCapture(e) {
    var target = e.target && e.target.closest
      ? e.target.closest('#settings-entry')
      : null;
    if (!target || !sheet.root) return;
    e.preventDefault();
    e.stopPropagation();
    if (sheet.open) closeSettingsSheet();
    else openSettingsSheet(target);
  }

  // 浮层开着时按 Esc 关它。放行让 app.js 的全局 Escape 继续跑（它只重置
  // 视图，不影响浮层），所以这里不 preventDefault。
  function onSheetKeydown(e) {
    if (e.key !== 'Escape' || !sheet.open) return;
    closeSettingsSheet();
  }

  // 设置视图的 hidden 由两条路写：浮层自己，以及 app.js 的 setView
  // （Esc 会跑 setView(state.view)，切视图也会）。它是浮层的内容，开着时不该被
  // 业务藏掉；退场动画期间也不该提前消失，否则卡片淡出的是一张空壳。
  function syncSettingsVisibility() {
    if (!sheet.viewEl) return;
    if (sheet.open || sheet.closing) {
      if (sheet.viewEl.hidden) sheet.viewEl.hidden = false;
      return;
    }
    if (!sheet.viewEl.hidden) sheet.viewEl.hidden = true;
  }

  // 分组可见性是皮肤加的，不属于业务：切走皮肤前必须全部摘掉，否则设置页
  // 在 classic / iOS 下只剩当前那一个分组（表现为「设置里其它项都不见了」，
  // 而且因为不报错、不崩，很容易被当成设置本身丢了）。
  function releaseGroups() {
    sheet.entries.forEach(function (entry) {
      if (entry.group) entry.group.hidden = false;
    });
    sheet.entries = [];
    sheet.active = '';
    sheet.nav = null;
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

    // 6) 设置浮层（挂在 body 末尾，层级高于所有底层面板）
    buildSettingsSheet();

    // 7) 视图切换联动
    observer = new MutationObserver(function () { if (mounted) reflow(); });
    Array.prototype.forEach.call(column.querySelectorAll('.view'), function (v) {
      observer.observe(v, { attributes: true, attributeFilter: ['hidden'] });
    });
    // 设置视图已被搬出中栏，得单独 observe：否则 app.js 的 setView
    // （Esc、切视图都会跑）改它的 hidden 时没有任何钩子把它纠正回来。
    if (sheet.viewEl) {
      observer.observe(sheet.viewEl, { attributes: true, attributeFilter: ['hidden'] });
    }

    keyHandler = onSheetKeydown;
    document.addEventListener('keydown', keyHandler);
    document.addEventListener('click', onDocumentClickCapture, true);

    reflow();
  }

  function unmount() {
    if (!mounted) return;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (keyHandler) {
      document.removeEventListener('keydown', keyHandler);
      keyHandler = null;
    }
    document.removeEventListener('click', onDocumentClickCapture, true);
    clearTimeout(sheet.closeTimer);
    sheet.closeTimer = 0;
    document.body.classList.remove('ln-modal-open');
    abortPending();
    clearTimeout(panel.debounce);
    // 先把设置视图放回中栏原位（锚点在 column 里），再拆浮层，
    // 否则 removeBuilt 会连着搬过去的业务节点一起删掉。
    releaseGroups();
    restoreMoves();
    refs.bar.classList.remove('ln-capsule');
    delete refs.column.dataset.lnView;
    removeBuilt();
    sheet.root = null;
    sheet.card = null;
    sheet.viewEl = null;
    sheet.open = false;
    sheet.closing = false;
    sheet.lastFocus = null;
    savedText.forEach(function (s) { s.node.textContent = s.text; });
    savedText = [];
    refs = {};
    mounted = false;
    panel.sources = null;
  }

  window.Skins.registerLifecycle(SKIN_ID, { mount: mount, unmount: unmount });

  // 暴露仅用于排障/契约脚本：返回当前挂载状态。
  window.__lnSkin = {
    isMounted: function () { return mounted; },
    reflow: function () { if (mounted) reflow(); }
  };
})();
