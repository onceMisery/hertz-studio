(() => {
  'use strict';
  const root = document.documentElement;
  const $ = id => document.getElementById(id);
  const systemTheme = matchMedia('(prefers-color-scheme: light)');

  const state = {
    config: { theme: 'auto', scale: 1, opacity: 1, pet: false, locked: false, topmost: true, edgeHide: false, dock: 'none' },
    snapshot: null,
    // 拖拽阈值：小于这个位移仍然算点击（走展开），与主界面胶囊一致。
    dragPx: 4,
    dragging: false,
    hoverTimer: 0,
    hitFrame: 0,
    flashTimer: 0,
  };

  function ipc(payload) {
    try { window.ipc.postMessage(JSON.stringify(payload)); } catch (_) { /* 浏览器里直接打开时的降级 */ }
  }

  function flash(text, ms) {
    const el = $('flash');
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    clearTimeout(state.flashTimer);
    state.flashTimer = setTimeout(() => { el.hidden = true; }, ms || 1600);
  }

  // --- 配置 -----------------------------------------------------------------

  function applyConfig(value) {
    if (!value) return;
    state.config = Object.assign({}, state.config, value);
    const c = state.config;
    const theme = c.theme === 'auto' ? (systemTheme.matches ? 'light' : 'dark') : c.theme;
    document.body.dataset.theme = theme;
    document.body.dataset.pet = String(!!c.pet);
    document.body.dataset.locked = String(!!c.locked);
    document.body.dataset.peek = String(!!c.peek);
    root.style.setProperty('--scale', String(c.scale || 1));
    root.style.setProperty('--opacity', String(c.opacity == null ? 1 : c.opacity));
    for (const [item, key] of [['topmost', 'topmost'], ['pet', 'pet'], ['edge-hide', 'edgeHide'], ['lock', 'locked']]) {
      const node = document.querySelector(`[data-menu="${item}"]`);
      if (node) node.setAttribute('aria-checked', String(!!c[key]));
    }
    scheduleHitRegions();
  }

  // --- 快照与进度 -----------------------------------------------------------

  function applySnapshot(value) {
    state.snapshot = value || null;
    const track = value && value.track;
    $('title').textContent = track ? track.title : '未在播放';
    $('subtitle').textContent = track
      ? [track.artist, track.album].filter(Boolean).join(' · ') || '—'
      : '—';
    document.body.dataset.playing = String(!!(value && value.playing));
    document.body.classList.toggle('buffering', !!(value && value.buffering));
    const play = $('play');
    if (play) play.setAttribute('aria-label', value && value.playing ? '暂停' : '播放');
    renderPosition(value ? value.positionMs : 0, value ? value.durationMs : 0);
    scheduleHitRegions();
  }

  /// 进度由 native 的呈现时钟推进（4Hz），页面不做二次插值——
  /// 两边都插值会叠加漂移，判定「谁是对的」比省一次 evaluate_script 贵得多。
  function applyPosition(value) {
    if (!value) return;
    renderPosition(value.ms || 0, value.durationMs || 0);
  }

  function renderPosition(ms, durationMs) {
    const ratio = durationMs > 0 ? Math.min(1, ms / durationMs) : 0;
    root.style.setProperty('--p', `${(ratio * 100).toFixed(2)}%`);
  }

  function applyCover(dataUrl) {
    const img = $('cover-img');
    if (!img) return;
    if (!dataUrl) { img.hidden = true; img.removeAttribute('src'); return; }
    img.hidden = false;
    img.src = dataUrl;
  }

  // --- 命中区上报 -----------------------------------------------------------

  /// 把所有 [data-hit] 元素的矩形交给 native。宠物态下这些矩形之外的地方
  /// 在 WM_NCHITTEST 里会被判成 HTTRANSPARENT，鼠标直接穿到下面的窗口。
  /// 只在内容/尺寸变化后重算，不在 mousemove 里算。
  function scheduleHitRegions() {
    if (state.hitFrame) return;
    state.hitFrame = requestAnimationFrame(() => {
      state.hitFrame = 0;
      const regions = [];
      document.querySelectorAll('[data-hit]').forEach(el => {
        const box = el.getBoundingClientRect();
        // 宠物态下隐藏掉的文字块宽高为 0，不能上报，否则整条窗都可点。
        if (box.width <= 0 || box.height <= 0) return;
        regions.push([round(box.left), round(box.top), round(box.width), round(box.height)]);
      });
      ipc({ cmd: 'hit-regions', regions });
    });
  }
  function round(value) { return Math.round(value * 100) / 100; }

  // --- 拖拽 -----------------------------------------------------------------

  /// 过阈值才交还给 native：native 会自己轮询光标移动窗口，页面不再逐帧上报。
  /// 起手要把抓取偏移一起给过去，否则窗口会跳到光标正下方。
  $('capsule').addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.target.closest('#transport')) return;
    const startX = event.clientX, startY = event.clientY;
    let started = false;
    const move = ev => {
      if (started) return;
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < state.dragPx) return;
      started = true;
      state.dragging = true;
      document.body.classList.add('dragging');
      try { $('capsule').setPointerCapture(event.pointerId); } catch (_) { /* 拿不到指针也不影响 native 拖 */ }
      ipc({ cmd: 'drag-begin', offsetX: startX, offsetY: startY });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('dragging');
      // 刚拖过：这次抬起不要触发展开，等这一轮事件走完再放开。
      setTimeout(() => { state.dragging = false; }, 0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });

  // 没拖动的那次点击 = 回到主窗口。
  $('capsule').addEventListener('click', event => {
    if (state.dragging) return;
    if (event.target.closest('#transport')) return;
    ipc({ cmd: 'restore' });
  });

  // --- 播放控制 -------------------------------------------------------------

  const control = (action, value) => ipc({ cmd: 'control', action, value });
  $('prev').addEventListener('click', e => { e.stopPropagation(); control('previous'); });
  $('next').addEventListener('click', e => { e.stopPropagation(); control('next'); });
  $('play').addEventListener('click', e => { e.stopPropagation(); control('toggle'); });
  $('expand').addEventListener('click', e => { e.stopPropagation(); ipc({ cmd: 'restore' }); });

  // --- 右键菜单 -------------------------------------------------------------

  const menu = $('menu');
  function closeMenu() {
    if (!menu) return;
    menu.hidden = true;
    document.body.classList.remove('menu-open');
  }
  window.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (!menu) return;
    // 锁定态不弹菜单：整窗都穿透了，弹出来也点不到，只会让人以为坏了。
    if (state.config.locked) return;
    menu.hidden = false;
    document.body.classList.add('menu-open');
    const width = menu.offsetWidth, height = menu.offsetHeight;
    menu.style.left = `${Math.max(4, Math.min(event.clientX, innerWidth - width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(event.clientY, innerHeight - height - 4))}px`;
    scheduleHitRegions();
  });
  document.addEventListener('pointerdown', event => {
    if (menu && !menu.hidden && !menu.contains(event.target)) closeMenu();
  }, true);
  window.addEventListener('blur', closeMenu);
  if (menu) {
    menu.addEventListener('click', event => {
      const button = event.target.closest('[data-menu]');
      if (!button) return;
      const item = button.dataset.menu;
      // 开关项立刻回显：native 侧是权威，但菜单不该等一拍才动。
      if (button.getAttribute('role') === 'menuitemcheckbox') {
        const next = button.getAttribute('aria-checked') !== 'true';
        button.setAttribute('aria-checked', String(next));
      }
      closeMenu();
      if (item === 'size') { flash('用设置页调整小窗尺寸'); return; }
      ipc({ cmd: 'menu', item, on: button.getAttribute('aria-checked') === 'true' });
    });
  }

  // 宠物态下传输键默认隐藏，靠近才出来；靠 hovering 类驱动，不用 JS 改样式。
  $('capsule').addEventListener('pointerenter', () => {
    clearTimeout(state.hoverTimer);
    document.body.classList.add('hovering');
  });
  $('capsule').addEventListener('pointerleave', () => {
    clearTimeout(state.hoverTimer);
    state.hoverTimer = setTimeout(() => document.body.classList.remove('hovering'), 320);
  });

  window.addEventListener('resize', scheduleHitRegions);
  systemTheme.addEventListener('change', () => applyConfig(state.config));

  // --- 出口 -----------------------------------------------------------------

  window.hertzMini = { applySnapshot, applyPosition, applyCover, applyConfig, flash };
  ipc({ cmd: 'ready' });
  applyConfig(state.config);
})();
