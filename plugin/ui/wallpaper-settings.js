// SPDX-License-Identifier: MIT
// The player owns navigation and geometry; the native host owns the editor.
(function () {
  'use strict';
  var transport, root, surface, notice, retry, requested = false, mounted = false;
  var confirmed = false, scheduled = 0, loading = 0, attempt = 0, last = '';
  var activeTab = 'wallpaper';
  var starting = false;
  var quitBlocked = false;
  function host() { return window.__hertzWindowHost; }
  function post(extra) {
    if (host() && window.ipc) window.ipc.postMessage(JSON.stringify(Object.assign({
      kind: 'wallpaper-editor', documentId: host().documentId
    }, extra)));
  }
  function sync() {
    scheduled = 0;
    if (!root || !requested || !mounted || !confirmed) return;
    var rect = surface.getBoundingClientRect(), scale = devicePixelRatio;
    var visible = !root.closest('[hidden]') && getComputedStyle(root).display !== 'none'
      && !document.hidden && !host().presentationHidden && !quitBlocked
      && !document.querySelector('dialog[open]') && rect.width > 0 && rect.height > 0;
    if (!visible && last) {
      var hidden = JSON.parse(last); hidden.visible = false;
      var hiddenKey = JSON.stringify(hidden);
      if (hiddenKey !== last) { last = hiddenKey; post(hidden); }
      return;
    }
    var left = Math.max(0, rect.left), top = Math.max(0, rect.top);
    var right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
    // Native child HWNDs cannot inherit DOM overflow clipping. Project the
    // editor onto the same visible rectangle as its scrolling ancestors.
    for (var node = surface.parentElement; node; node = node.parentElement) {
      var style = getComputedStyle(node), area = node.getBoundingClientRect();
      if (style.overflowY !== 'visible') { top = Math.max(top, area.top); bottom = Math.min(bottom, area.bottom); }
      if (style.overflowX !== 'visible') { left = Math.max(left, area.left); right = Math.min(right, area.right); }
    }
    var nav = document.querySelector('.hz-settings-nav');
    if (nav) top = Math.max(top, nav.getBoundingClientRect().bottom);
    visible = visible && right - left > 100 && bottom - top > 160;
    if (!visible && last) { var previous = JSON.parse(last); previous.visible = false; previous.tab = activeTab;
      var previousKey = JSON.stringify(previous); if (previousKey !== last) { last = previousKey; post(previous); } return; }
    var x = Math.max(0, Math.round(left * scale)), y = Math.max(0, Math.round(top * scale));
    var width = Math.max(1, Math.round(right * scale) - x);
    var height = Math.max(1, Math.round(bottom * scale) - y);
    var value = { bounds: { x: x, y: y, width: width, height: height }, visible: visible,
      light: document.documentElement.dataset.hzTone === 'light', tab: activeTab };
    var key = JSON.stringify(value);
    if (key !== last) { last = key; post(value); }
  }
  function schedule() { if (!scheduled) scheduled = requestAnimationFrame(sync); }
  function fail(error) {
    clearTimeout(loading); mounted = false; last = ''; post({ dispose: true });
    root.dataset.state = 'error'; notice.textContent = error; retry.hidden = false;
  }
  async function open(tab) {
    if (!root) return;
    if (!host()) {
      root.hidden = false; root.dataset.state = 'error';
      notice.textContent = '请在 Hertz 桌面主程序内打开壁纸设置。'; return;
    }
    if (window.HertzShell) window.HertzShell.navigate('settings');
    if (window.HertzSkin) window.HertzSkin.selectSettings('lyrics');
    activeTab = tab || activeTab;
    requested = true; root.hidden = false;
    root.scrollIntoView({ block: 'start' });
    if (mounted) { last = ''; schedule(); return; }
    if (starting) return;
    var ticket = ++attempt;
    starting = true;
    root.dataset.state = 'loading'; notice.textContent = '正在读取壁纸设置…'; retry.hidden = true;
    try {
      var response = await transport.post('/v1/desktop/control', { command: 'wallpaper-settings', value: { tab: activeTab } }, { timeoutMs: 55000 });
      if (response && response.ok === false) throw new Error(response.message || response.error && response.error.message || '无法打开壁纸设置。');
      if (ticket !== attempt || !requested) return;
      mounted = true; last = ''; schedule();
      loading = setTimeout(function () { fail('壁纸设置加载超时，请重试。'); }, 20000);
    } catch (error) { if (ticket === attempt) fail(error.message || '无法读取壁纸设置，请重试。'); }
    finally { starting = false; }
  }
  function init(value) {
    if (root || window.hertzHost && window.hertzHost.isDbx) return;
    transport = value;
    root = document.createElement('section'); root.id = 'wallpaper-settings-workspace'; root.hidden = true;
    root.setAttribute('aria-label', '桌面壁纸设置');
    root.innerHTML = '<div class="wallpaper-workspace-heading"><h3>桌面壁纸设置</h3><p>修改后点击应用保存；放弃修改可恢复已保存的设置。</p></div>'
      + '<div id="wallpaper-settings-surface"><div class="wallpaper-workspace-loading" aria-hidden="true"><span></span><span></span><span></span></div>'
      + '<p id="wallpaper-workspace-status" role="status" aria-live="polite"></p><button id="wallpaper-workspace-retry" class="btn" hidden>重新加载</button></div>';
    document.getElementById('set-wallpaper-note').after(root);
    surface = document.getElementById('wallpaper-settings-surface');
    notice = document.getElementById('wallpaper-workspace-status'); retry = document.getElementById('wallpaper-workspace-retry');
    retry.addEventListener('click', function () { void open(); });
    window.addEventListener('hertz-native-host-confirmed', function () { confirmed = true; last = ''; schedule(); });
    window.addEventListener('hertz-wallpaper-editor-event', function (event) {
      var value = event.detail;
      if (!value) return;
      if (value.kind === 'navigate') { void open(value.tab); return; }
      if (!host() || value.document !== host().documentId) return;
      if (value.kind === 'ready' && requested && mounted) {
        clearTimeout(loading); root.dataset.state = 'ready'; notice.textContent = ''; retry.hidden = true;
      } else if (value.kind === 'failed' && requested) { fail(value.error); }
      else if (value.kind === 'closed') {
        clearTimeout(loading); requested = mounted = false; ++attempt; last = ''; root.hidden = true;
        document.getElementById('set-wallpaper-settings').focus();
      }
    });
    new ResizeObserver(schedule).observe(surface);
    var observer = new MutationObserver(schedule);
    observer.observe(document.getElementById('view-settings'), { attributes: true, subtree: true, attributeFilter: ['hidden', 'class', 'style'] });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-hz-tone', 'style', 'class'] });
    document.addEventListener('scroll', schedule, true);
    document.addEventListener('visibilitychange', schedule);
    window.addEventListener('resize', schedule);
    window.addEventListener('hertz-native-presentation', function () { last = ''; schedule(); });
    window.addEventListener('hertz-native-exit-request', function () { quitBlocked = true; schedule(); });
    window.addEventListener('hertz-native-exit-state', function (event) {
      var state = event.detail;
      if (state && state.phase !== 'pending' && state.phase !== 'exiting') { quitBlocked = false; schedule(); }
    });
    new MutationObserver(schedule).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
    window.addEventListener('pagehide', function () { ++attempt; clearTimeout(loading); cancelAnimationFrame(scheduled); post({ dispose: true }); });
    // Host confirmation may have arrived before the application connected.
    confirmed = !!host() && host().confirmed === true;
    if (host()) window.ipc.postMessage(JSON.stringify({ kind: 'host-ready', documentId: host().documentId }));
  }
  window.HertzWallpaperSettings = Object.freeze({ init: init, open: open });
})();
