// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 命令面板（folia 的 command palette）：Ctrl+K 唤起，模糊搜索全部命令，
// 另支持结构化队列批量操作方言（`artist:周杰伦 --remove` / `album:xx --next`）。
//
// 零依赖 IIFE，只暴露 window.Palette：
//   Palette.register(defs)          注册命令（app.js 启动时用自己的闭包注册）
//   Palette.registerQueueBatch(fn)  注册队列方言解析器（app.js 提供）
//   Palette.registerSurface(def)    注册内联 surface（面板主区常驻的小面板）
//   Palette.openSurface(id)         直接打开某个 surface
//   Palette.open() / close()        开关
//
// 排序分档（folia 的 rankCommands 简化版）：精确命中 4 > 字段包含 3 > 前缀 2 >
// 模糊 1；每档再按字段权重（标题 > 关键词 > 描述）细分。最多显示 10 条。
// 着陆页顺序：钉住（pinned）→ 最近使用 → 其余，与 folia 的 pinned 置顶一致。
//
// surface 是「面板主区停留」的二级界面（folia 的同名概念）：打开时搜索框让位，
// 主区换成该 surface 自己的控件，Esc 返回命令列表而不是关面板。

'use strict';

window.Palette = (function () {
  const MAX_RESULTS = 10;
  /** 钉住上限：着陆页只有 10 行，钉太多等于把「最近使用」挤没了。 */
  const MAX_PINNED = 5;
  const PINNED_KEY = 'vmusic.palette.pinned';
  const RECENT_KEY = 'vmusic.palette.recent';
  const DEFAULT_HINT = '↑↓ 选择 · Enter 执行 · Alt+P 钉住 · Esc 关闭';
  /** 星形图标：钉住状态用填充/描边区分（图标库里没有 pin，就地内联避免动 sprite）。 */
  const PIN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.4l2.62 5.3 5.86.86-4.24 4.13 1 5.85L12 16.77 6.76 19.54l1-5.85L3.52 9.56l5.86-.86L12 3.4z"/></svg>';

  /** @type {Array<{id:string,group:string,title:string,description?:string,keywords?:string,run?:Function,surface?:string,available?:Function}>} */
  let commands = [];
  /** @type {Function|null} 队列方言解析器：query -> {label, sub, count, apply} | null */
  let queueBatchResolver = null;
  /** @type {Object<string,{id:string,title:string,hint?:string,render:Function}>} 内联 surface 表。 */
  let surfaces = {};
  /** 最近使用的命令 id（着陆页第二段）。 */
  let recent = [];
  /** 钉住的命令 id（着陆页第一段，顺序即用户钉的顺序）。 */
  let pinned = [];
  try {
    recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch (e) { recent = []; }
  pinned = readPinned();

  let overlay = null;
  let input = null;
  let list = null;
  let hintEl = null;
  // 面板打开期间的焦点收尾函数（见 dialogs.js 的 focusScope）：命令列表在
  // 无障碍语义上就是一个模态弹窗，背景该在它开着时完全不可达。
  let releaseScope = null;
  let surfaceHost = null;
  let items = [];       // 当前渲染的条目（命令或批量预览）
  let selected = 0;
  /** 当前打开的 surface：`{id, cleanup}`；非空时主区归它，搜索框让位。 */
  let activeSurface = null;

  /// 只认非空字符串 id，去重，超出上限丢最早的（保序）。
  function normalizePinned(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const id of raw) {
      if (typeof id !== 'string' || !id || out.includes(id)) continue;
      out.push(id);
    }
    return out.slice(0, MAX_PINNED);
  }

  function readPinned() {
    try {
      return normalizePinned(JSON.parse(localStorage.getItem(PINNED_KEY) || '[]'));
    } catch (e) {
      return [];
    }
  }

  function writePinned(next) {
    pinned = normalizePinned(next);
    try { localStorage.setItem(PINNED_KEY, JSON.stringify(pinned)); } catch (e) { /* 私密模式等 */ }
  }

  function isPinned(id) {
    return pinned.includes(id);
  }

  function togglePin(id) {
    writePinned(isPinned(id) ? pinned.filter((x) => x !== id) : [...pinned, id]);
  }

  // -------------------------------------------------------------------------
  // 模糊打分
  // -------------------------------------------------------------------------

  /// 字段得分：精确相等 4；query 为字段前缀 2；query 含于字段 3（更长的命中更
  /// 有意义）；子序列模糊 1。大小写不敏感。
  function scoreField(field, query) {
    if (!field) return 0;
    const f = field.toLowerCase();
    const q = query.toLowerCase();
    if (!q) return 0;
    if (f === q) return 4;
    if (f.includes(q)) return 3;
    if (f.startsWith(q)) return 2;
    // 子序列模糊：ASCII 至少 2 字符才值得模糊匹配，中文单字也可。
    const asciiOnly = /^[\x00-\x7f]+$/.test(q);
    if (asciiOnly && q.length < 2) return 0;
    let fi = 0;
    let consecutive = 0;
    let best = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const ch = q[qi];
      if (ch === ' ') continue;
      const at = f.indexOf(ch, fi);
      if (at < 0) return 0;
      consecutive = at === fi ? consecutive + 1 : 1;
      best = Math.max(best, consecutive);
      fi = at + 1;
    }
    // 连续命中越长分越高（1 + 最多 +1 加成）。
    return best >= 3 ? 1.5 : 1;
  }

  function scoreCommand(cmd, query) {
    if (!query.trim()) return 0.5;
    const title = scoreField(cmd.title, query) * 3;
    const keywords = scoreField(cmd.keywords || '', query) * 2;
    const desc = scoreField(cmd.description || '', query) * 1;
    const group = scoreField(cmd.group, query) * 1;
    const best = Math.max(title, keywords, desc, group);
    if (best <= 0) return 0;
    return best + (title === best ? 0.2 : 0);
  }

  function rankCommands(query) {
    const available = commands.filter((c) => !c.available || c.available());
    if (!query.trim()) {
      // 着陆页：钉住 → 最近使用 → 其余（注册顺序）。三段互斥，同一个命令只出现
      // 一次，否则一条被钉住的命令会占掉两行。
      const pinnedCmds = pinned
        .map((id) => available.find((c) => c.id === id))
        .filter(Boolean);
      const pinnedIds = new Set(pinned);
      const recentCmds = recent
        .map((id) => available.find((c) => c.id === id))
        .filter((c) => c && !pinnedIds.has(c.id));
      const recentIds = new Set(recent);
      const rest = available.filter((c) => !pinnedIds.has(c.id) && !recentIds.has(c.id));
      return [...pinnedCmds, ...recentCmds, ...rest].slice(0, MAX_RESULTS);
    }
    return available
      .map((c) => ({ c, s: scoreCommand(c, query) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c)
      .slice(0, MAX_RESULTS);
  }

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------

  function ensureDom() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'palette-scrim';
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <div class="palette-head">
          <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-search"/></svg>
          <input class="palette-input" type="text" placeholder="搜索命令，或 artist:/album: 过滤队列 + --remove/--next/--end"
                 autocomplete="off" spellcheck="false">
          <span class="palette-hint"></span>
        </div>
        <div class="palette-list" role="listbox"></div>
        <div class="palette-surface" hidden></div>
      </div>`;
    document.body.appendChild(overlay);
    input = overlay.querySelector('.palette-input');
    list = overlay.querySelector('.palette-list');
    hintEl = overlay.querySelector('.palette-hint');
    surfaceHost = overlay.querySelector('.palette-surface');
    hintEl.textContent = DEFAULT_HINT;

    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close();
    });
    input.addEventListener('input', () => {
      if (activeSurface) return;   // surface 模式下主区不归搜索管
      selected = 0;
      render();
    });
    input.addEventListener('keydown', (e) => {
      if (activeSurface) {
        // surface 里只剩一个约定：Esc 回命令列表（其余按键交给 surface 控件）。
        if (e.key === 'Escape') { e.preventDefault(); backToCommands(); }
        return;
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); execute(selected); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        const item = items[selected];
        if (item && item.cmd) { togglePin(item.cmd.id); render(); }
      }
    });
    // 焦点在 surface 控件里时输入框收不到 keydown，Esc 得在这一层兜住。
    overlay.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.key !== 'Escape') return;
      e.preventDefault();
      if (activeSurface) backToCommands();
      else close();
    });
    // 输入框失焦不关面板（点击列表项时焦点会跳）；点击条目即执行。
    list.addEventListener('mousedown', (e) => {
      const pin = e.target.closest('.palette-pin');
      if (pin) {
        e.preventDefault();
        e.stopPropagation();
        togglePin(pin.dataset.pinId);
        render();
        return;
      }
      const row = e.target.closest('.palette-item');
      if (!row) return;
      e.preventDefault();
      execute(Number(row.dataset.index));
    });
  }

  function move(delta) {
    if (!items.length) return;
    selected = (selected + delta + items.length) % items.length;
    render();
    const active = list.querySelector('.palette-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function remember(id) {
    recent = [id, ...recent.filter((x) => x !== id)].slice(0, 6);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch (e) { /* 私密模式等 */ }
  }

  function execute(index) {
    const item = items[index];
    if (!item) return;
    if (item.batch) {
      close();
      item.apply();
      return;
    }
    // surface 命令：面板不关、主区就地换界面（folia 的 inline surface）。
    if (item.cmd.surface) {
      remember(item.cmd.id);
      if (openSurface(item.cmd.surface)) return;
      close();
      return;
    }
    close();
    remember(item.cmd.id);
    try { item.cmd.run(); } catch (e) { console.error('[palette] 命令执行失败', e); }
  }

  // -------------------------------------------------------------------------
  // 内联 surface：主区常驻的小面板，Esc 回命令列表
  // -------------------------------------------------------------------------

  function openSurface(id) {
    const def = surfaces[id];
    if (!def || typeof def.render !== 'function') return false;
    ensureDom();
    overlay.hidden = false;   // 直接 openSurface 时也要把面板显出来
    closeSurface();
    activeSurface = { id, cleanup: null };
    list.hidden = true;
    input.hidden = true;
    surfaceHost.hidden = false;
    surfaceHost.innerHTML = '';
    hintEl.textContent = def.hint || 'Esc 返回命令列表';
    const ctx = { back: backToCommands, close };
    let cleanup = null;
    try {
      cleanup = def.render(surfaceHost, ctx);
    } catch (e) {
      console.error('[palette] surface 渲染失败', e);
      closeSurface();
      list.hidden = false;
      input.hidden = false;
      hintEl.textContent = DEFAULT_HINT;
      return false;
    }
    if (activeSurface) activeSurface.cleanup = typeof cleanup === 'function' ? cleanup : null;
    const focusTarget = surfaceHost.querySelector('[data-autofocus]') || surfaceHost;
    try { focusTarget.focus(); } catch (e) { /* 元素不可聚焦 */ }
    return true;
  }

  /// 卸下 surface（跑它的清理函数、恢复列表与搜索框），但不回到列表焦点。
  function closeSurface() {
    if (activeSurface && typeof activeSurface.cleanup === 'function') {
      try { activeSurface.cleanup(); } catch (e) { console.error('[palette] surface 清理失败', e); }
    }
    activeSurface = null;
    if (!overlay) return;
    surfaceHost.hidden = true;
    surfaceHost.innerHTML = '';
    list.hidden = false;
    input.hidden = false;
    hintEl.textContent = DEFAULT_HINT;
  }

  function backToCommands() {
    closeSurface();
    selected = 0;
    render();
    input.focus();
    input.select();
  }

  function render() {
    const query = input.value.trim();
    // 队列批量方言：解析器认领时展示预览条目（只有一条可展开的应用项）。
    const batch = queueBatchResolver ? queueBatchResolver(query) : null;
    if (batch) {
      items = [{ batch: true, label: batch.label, sub: batch.sub, apply: batch.apply }];
      selected = 0;
      list.innerHTML = '';
      const row = document.createElement('div');
      row.className = 'palette-item batch active';
      row.dataset.index = '0';
      row.innerHTML = `
        <span class="palette-item-main"><span class="palette-item-title"></span><span class="palette-item-sub"></span></span>
        <span class="palette-item-group">队列</span>`;
      row.querySelector('.palette-item-title').textContent = batch.label;
      row.querySelector('.palette-item-sub').textContent = batch.sub;
      list.appendChild(row);
      return;
    }
    items = rankCommands(query).map((cmd) => ({ cmd }));
    if (selected >= items.length) selected = Math.max(0, items.length - 1);
    list.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'palette-empty';
      empty.textContent = query ? '没有匹配的命令' : '暂无命令';
      list.appendChild(empty);
      return;
    }
    items.forEach((item, index) => {
      const cmd = item.cmd;
      const pinnedNow = isPinned(cmd.id);
      const row = document.createElement('div');
      row.className = 'palette-item' + (index === selected ? ' active' : '') + (pinnedNow ? ' is-pinned' : '');
      row.dataset.index = String(index);
      row.setAttribute('role', 'option');
      row.innerHTML = `
        <span class="palette-item-main"><span class="palette-item-title"></span><span class="palette-item-sub"></span></span>
        <span class="palette-item-side"><span class="palette-item-group"></span><button type="button" class="palette-pin"></button></span>`;
      row.querySelector('.palette-item-title').textContent = cmd.title;
      row.querySelector('.palette-item-sub').textContent = cmd.description || '';
      row.querySelector('.palette-item-group').textContent = cmd.group || '';
      const pin = row.querySelector('.palette-pin');
      pin.dataset.pinId = cmd.id;
      pin.classList.toggle('is-pinned', pinnedNow);
      pin.setAttribute('aria-pressed', String(pinnedNow));
      const pinLabel = pinnedNow ? `取消钉住「${cmd.title}」` : `钉住「${cmd.title}」`;
      pin.setAttribute('aria-label', pinLabel);
      pin.title = pinLabel;
      pin.innerHTML = PIN_ICON;
      list.appendChild(row);
    });
  }

  // -------------------------------------------------------------------------
  // 出口
  // -------------------------------------------------------------------------

  function open(prefill) {
    ensureDom();
    closeSurface();          // 关掉后重开一律从命令列表起步
    overlay.hidden = false;
    releaseScope = window.hertzDialog ? window.hertzDialog.focusScope(overlay) : null;
    input.value = prefill || '';
    selected = 0;
    render();
    input.focus();
    input.select();
  }

  function close() {
    if (!overlay) return;
    closeSurface();
    overlay.hidden = true;
    input.value = '';
    if (releaseScope) { releaseScope(); releaseScope = null; }
  }

  function isOpen() {
    return !!overlay && !overlay.hidden;
  }

  function register(defs) {
    for (const def of defs) {
      // 命令要么有 run（执行一个动作），要么有 surface（展开主区界面）。
      if (!def || !def.id) continue;
      if (typeof def.run !== 'function' && !def.surface) continue;
      // 同 id 重复注册 = 覆盖（皮肤重进/热重载场景不叠加）。
      commands = commands.filter((c) => c.id !== def.id);
      commands.push(def);
    }
  }

  function registerQueueBatch(fn) {
    queueBatchResolver = fn;
  }

  /// 注册内联 surface：`{id, title, hint?, render(host, ctx) -> cleanup?}`。
  /// render 里自己建 DOM；返回的函数在收起时调用（清定时器等）。
  function registerSurface(def) {
    if (!def || !def.id || typeof def.render !== 'function') return;
    surfaces[def.id] = def;
  }

  return { register, registerQueueBatch, registerSurface, openSurface, open, close, isOpen };
})();
