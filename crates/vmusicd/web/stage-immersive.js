// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors
//
// 沉浸演出模式：浏览器原生全屏 + 舞台场景快速切换坞。
//
// 两件事：
//
//   1. 把 #lyric-page（全屏歌词/演出页）提升为浏览器原生全屏元素
//      （Fullscreen API，带 webkit 前缀回退）。全屏后顶/底栏与切换坞在鼠标
//      静止 2.6s 后自动隐去、光标一起藏，移动鼠标或按任意键唤回，Esc 由
//      浏览器原生处理（只退全屏，不关页面）。F 键全局切换。
//
//   2. 在演出页底部挂一条玻璃"舞台坞"：直接列出六个 WebGL 三维场景
//      （数据来自 CreativeStage.scenes()，不另维护清单），点击即带着
//      900ms 机位补间飞过去。三维舞台没开时先经 'stage:creative-request'
//      事件请 app.js 走 applyCreative 开启（含粒子让位/降级提示），再切场景。
//
// 零依赖、ES5、无构建。本模块不持有任何渲染逻辑。

(function () {
  'use strict';

  var CHROME_HIDE_MS = 2600;

  var page = null;
  var dock = null;
  var dockBtns = [];
  var chromeTimer = 0;

  // 六个场景的极简线性图标（与场景 id 一一对应；未知场景回退到圆点）。
  var ICONS = {
    towers: '<path d="M4 20v-6M8 20V8M12 20v-9M16 20V4M20 20v-7"/>',
    orb: '<circle cx="12" cy="12" r="7.2"/><ellipse cx="12" cy="12" rx="7.2" ry="3"/>' +
      '<ellipse cx="12" cy="12" rx="3" ry="7.2"/>',
    tunnel: '<circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="4.6"/>' +
      '<circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
    nebula: '<circle cx="8" cy="9" r="1.5" fill="currentColor" stroke="none"/>' +
      '<circle cx="15.5" cy="7.5" r="1.1" fill="currentColor" stroke="none"/>' +
      '<circle cx="16" cy="15" r="1.7" fill="currentColor" stroke="none"/>' +
      '<circle cx="9.5" cy="15.5" r="1" fill="currentColor" stroke="none"/>' +
      '<circle cx="12.5" cy="11.5" r="2.1"/>',
    terrain: '<path d="M3 17l5-7 4 5 3-3.5 6 5.5"/>',
    lyric: '<path d="M5 7h14M5 12h14M8.5 17h7"/>'
  };

  function $(id) { return document.getElementById(id); }

  // -------------------------------------------------------------------------
  // 原生全屏
  // -------------------------------------------------------------------------

  function fsElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function requestFs(el) {
    try {
      if (el.requestFullscreen) {
        var p = el.requestFullscreen();
        if (p && p.catch) p.catch(function () { /* 拒绝/不支持时留在页内模式 */ });
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
      }
    } catch (e) { /* 页内全屏仍然可用 */ }
  }

  function exitFs() {
    try {
      if (document.exitFullscreen) {
        var p = document.exitFullscreen();
        if (p && p.catch) p.catch(function () { /* 忽略 */ });
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    } catch (e) { /* 忽略 */ }
  }

  function enter() {
    if (!page) return;
    // 演出页没开时先打开：它是全屏的承载元素。
    if (window.Stage && Stage.setPage && !Stage.isPageOpen()) Stage.setPage(true);
    pokeChrome();
    // .lyric-page 刚从 visibility:hidden 翻到可见，推一帧再请求，
    // 个别浏览器要求全屏元素此刻已处于可见状态。
    setTimeout(function () {
      if (!fsElement()) requestFs(page);
    }, 40);
  }

  function toggle() {
    if (fsElement()) exitFs();
    else enter();
  }

  function syncFsUi() {
    var on = !!fsElement();
    document.body.classList.toggle('fs-on', on);
    var btn = $('lp-fs');
    if (btn) {
      btn.setAttribute('aria-pressed', String(on));
      btn.title = on ? '退出全屏 (F)' : '全屏 (F)';
      btn.setAttribute('aria-label', on ? '退出全屏' : '全屏');
    }
    var side = $('stage-fs');
    if (side) {
      side.setAttribute('aria-pressed', String(on));
      side.title = on ? '退出全屏 (F)' : '全屏舞台 (F)';
    }
    if (on) pokeChrome();
    else {
      document.body.classList.add('fs-chrome');
      if (chromeTimer) clearTimeout(chromeTimer);
    }
  }

  // 全屏时的"光标静止即隐去操作层"。
  function pokeChrome() {
    document.body.classList.add('fs-chrome');
    if (chromeTimer) clearTimeout(chromeTimer);
    chromeTimer = setTimeout(function () {
      document.body.classList.remove('fs-chrome');
    }, CHROME_HIDE_MS);
  }

  function isTypingTarget(t) {
    var tag = t && t.tagName ? String(t.tagName).toUpperCase() : '';
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
      !!(t && t.isContentEditable);
  }

  // -------------------------------------------------------------------------
  // 舞台场景坞
  // -------------------------------------------------------------------------

  function sceneList() {
    return window.CreativeStage && CreativeStage.scenes ? CreativeStage.scenes() : [];
  }

  function chooseScene(id) {
    if (!window.CreativeStage) return;
    // 三维舞台没开（或被降级关掉）：请 app.js 走统一入口开启 —— 粒子让位、
    // 失败 toast、设置持久化都在 applyCreative 里，不在这里复制。
    if (!CreativeStage.active()) {
      document.dispatchEvent(new CustomEvent('stage:creative-request', {
        detail: { on: true }
      }));
    }
    var ok = CreativeStage.setScene(id);
    if (!ok && window.toast) window.toast('该三维舞台在当前设备上不可用', 'error');
    pokeChrome();
  }

  function syncDock() {
    var cur = null;
    try {
      if (window.CreativeStage && CreativeStage.preset) cur = CreativeStage.preset().scene;
    } catch (e) { cur = null; }
    dockBtns.forEach(function (b) {
      var on = b.getAttribute('data-scene') === cur &&
        !!window.CreativeStage && CreativeStage.active();
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  function buildDock() {
    if (!page || dock) return;
    dock = document.createElement('div');
    dock.className = 'lp-dock';
    dock.setAttribute('role', 'toolbar');
    dock.setAttribute('aria-label', '舞台场景切换');

    sceneList().forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'lp-dock-btn';
      b.setAttribute('data-scene', s.id);
      b.setAttribute('aria-pressed', 'false');
      var path = ICONS[s.id] || '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>';
      b.innerHTML =
        '<svg class="lp-dock-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        path + '</svg><span class="lp-dock-tx"></span>';
      b.querySelector('.lp-dock-tx').textContent = s.label || s.id;
      b.addEventListener('click', function () { chooseScene(s.id); });
      dock.appendChild(b);
      dockBtns.push(b);
    });

    page.appendChild(dock);
    syncDock();
  }

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------

  // 只初始化一次。init 里给 #lp-fs / #stage-fs 和 document 绑的是单向监听，
  // 没有解绑路径；重复进来会变成「点一次跑两次」。
  var inited = false;

  function init() {
    if (inited) return;
    inited = true;
    page = $('lyric-page');
    if (!page) return;

    var fsBtn = $('lp-fs');
    if (fsBtn) fsBtn.addEventListener('click', toggle);
    var sideBtn = $('stage-fs');
    if (sideBtn) sideBtn.addEventListener('click', enter);

    document.addEventListener('fullscreenchange', syncFsUi);
    document.addEventListener('webkitfullscreenchange', syncFsUi);

    // 静止隐去操作层：指针移动/点按、按任意键都算"还在操作"。
    page.addEventListener('pointermove', pokeChrome, { passive: true });
    page.addEventListener('pointerdown', pokeChrome, { passive: true });
    document.addEventListener('keydown', function (e) {
      if (fsElement()) pokeChrome();
    });

    // F 全局切换全屏演出（输入框里打字不响应；不和修饰键组合冲突）。
    document.addEventListener('keydown', function (e) {
      if (!(e.key === 'f' || e.key === 'F')) return;
      if (isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      toggle();
    });

    buildDock();
    // 预置变化（切场景/导入工坊预置/三维开关）→ 坞的高亮跟着走。
    if (window.CreativeStage && CreativeStage.onChange) {
      CreativeStage.onChange(function (kind) {
        if (kind === 'preset') syncDock();
      });
    }
    // 演出页每次打开补一次同步：三维开关可能在设置里被切换过（attach 不发
    // preset 事件），坞上的高亮要和当前实际场景一致。
    document.addEventListener('stage:page', function () { syncDock(); });
    // 三维开关经 applyCreative 收口广播：关闭时坞上高亮必须一起熄灭。
    document.addEventListener('stage:creative-changed', function () { syncDock(); });
    document.addEventListener('stage:degrade', syncDock);

    syncFsUi();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
