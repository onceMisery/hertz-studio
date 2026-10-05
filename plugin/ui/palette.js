// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 命令面板（folia 的 command palette）：Ctrl+K 唤起，模糊搜索全部命令，
// 另支持结构化队列批量操作方言（`artist:周杰伦 --remove` / `album:xx --next`）。
//
// 零依赖 IIFE，只暴露 window.Palette：
//   Palette.register(defs)         注册命令（app.js 启动时用自己的闭包注册）
//   Palette.registerQueueBatch(fn) 注册队列方言解析器（app.js 提供）
//   Palette.open() / close()       开关
//
// 排序分档（folia 的 rankCommands 简化版）：精确命中 4 > 字段包含 3 > 前缀 2 >
// 模糊 1；每档再按字段权重（标题 > 关键词 > 描述）细分。最多显示 10 条。

'use strict';

window.Palette = (function () {
  const MAX_RESULTS = 10;

  /** @type {Array<{id:string,group:string,title:string,description?:string,keywords?:string,run:Function,available?:Function}>} */
  let commands = [];
  /** @type {Function|null} 队列方言解析器：query -> {label, sub, count, apply} | null */
  let queueBatchResolver = null;
  /** 最近使用的命令 id（着陆页置顶）。 */
  let recent = [];
  try {
    recent = JSON.parse(localStorage.getItem('vmusic.palette.recent') || '[]');
  } catch (e) { recent = []; }

  let overlay = null;
  let input = null;
  let list = null;
  let items = [];       // 当前渲染的条目（命令或批量预览）
  let selected = 0;

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
      // 着陆页：最近使用在前，其余按注册顺序。
      const recentCmds = recent
        .map((id) => available.find((c) => c.id === id))
        .filter(Boolean);
      const rest = available.filter((c) => !recent.includes(c.id));
      return [...recentCmds, ...rest].slice(0, MAX_RESULTS);
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
          <span class="palette-hint">↑↓ 选择 · Enter 执行 · Esc 关闭</span>
        </div>
        <div class="palette-list" role="listbox"></div>
      </div>`;
    document.body.appendChild(overlay);
    input = overlay.querySelector('.palette-input');
    list = overlay.querySelector('.palette-list');

    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close();
    });
    input.addEventListener('input', () => { selected = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); execute(selected); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    // 输入框失焦不关面板（点击列表项时焦点会跳）；点击条目即执行。
    list.addEventListener('mousedown', (e) => {
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
    try { localStorage.setItem('vmusic.palette.recent', JSON.stringify(recent)); } catch (e) { /* 私密模式等 */ }
  }

  function execute(index) {
    const item = items[index];
    if (!item) return;
    close();
    if (item.batch) {
      item.apply();
      return;
    }
    remember(item.cmd.id);
    try { item.cmd.run(); } catch (e) { console.error('[palette] 命令执行失败', e); }
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
      const row = document.createElement('div');
      row.className = 'palette-item' + (index === selected ? ' active' : '');
      row.dataset.index = String(index);
      row.setAttribute('role', 'option');
      row.innerHTML = `
        <span class="palette-item-main"><span class="palette-item-title"></span><span class="palette-item-sub"></span></span>
        <span class="palette-item-group"></span>`;
      row.querySelector('.palette-item-title').textContent = cmd.title;
      row.querySelector('.palette-item-sub').textContent = cmd.description || '';
      row.querySelector('.palette-item-group').textContent = cmd.group || '';
      list.appendChild(row);
    });
  }

  // -------------------------------------------------------------------------
  // 出口
  // -------------------------------------------------------------------------

  function open(prefill) {
    ensureDom();
    overlay.hidden = false;
    input.value = prefill || '';
    selected = 0;
    render();
    input.focus();
    input.select();
  }

  function close() {
    if (!overlay) return;
    overlay.hidden = true;
    input.value = '';
  }

  function isOpen() {
    return !!overlay && !overlay.hidden;
  }

  function register(defs) {
    for (const def of defs) {
      if (!def || !def.id || typeof def.run !== 'function') continue;
      // 同 id 重复注册 = 覆盖（皮肤重进/热重载场景不叠加）。
      commands = commands.filter((c) => c.id !== def.id);
      commands.push(def);
    }
  }

  function registerQueueBatch(fn) {
    queueBatchResolver = fn;
  }

  return { register, registerQueueBatch, open, close, isOpen };
})();
