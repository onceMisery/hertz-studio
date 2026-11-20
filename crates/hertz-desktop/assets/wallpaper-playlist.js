// SPDX-License-Identifier: MIT
(function () {
  'use strict';
  const settings = window.hertzWallpaperSettings;
  const request = (command, payload, id) => settings.requestManagement(command, payload, id).then(receipt => receipt.result);
  function node(tag, text, id) { const value = document.createElement(tag); if (text) value.textContent = text; if (id) value.id = id; return value; }
  function button(text, id, action) { const value = node('button', text, id); value.type = 'button'; value.addEventListener('click', () => Promise.resolve().then(action).catch(error => message(error.message, true))); return value; }
  function field(text, input) { const label = node('label'); label.className = 'field'; label.htmlFor = input.id; label.append(node('span', text), input); return label; }
  const section = node('details', '', 'playlist-editor'); section.className = 'local-library';
  section.append(node('summary', '轮播列表', 'playlist-heading'));
  const toolbar = node('div'); toolbar.className = 'library-toolbar';
  const select = node('select', '', 'playlist-select'); select.setAttribute('aria-label', '保存的轮播列表');
  const open = button('打开列表', 'playlist-open', load);
  const fresh = button('新建列表', 'playlist-new', () => { if (discard()) { page = 0; editor.reset(); syncFields(); } });
  const reload = button('刷新', 'playlist-refresh', refresh);
  toolbar.append(select, open, fresh, reload);
  const form = node('form'); form.setAttribute('aria-labelledby', 'playlist-heading'); form.noValidate = true;
  const title = node('input', '', 'playlist-title'); title.type = 'text'; title.name = 'title'; title.maxLength = 120; title.required = true;
  const mode = node('select', '', 'playlist-mode'); mode.name = 'mode';
  [['sequential', '按顺序'], ['random', '随机']].forEach(([value, label]) => { const option = node('option', label); option.value = value; mode.append(option); });
  const interval = node('input', '', 'playlist-interval'); interval.name = 'intervalSeconds'; interval.type = 'number'; interval.min = 10; interval.max = 86400; interval.step = 1; interval.required = true;
  const hint = node('p', '从本地作品中“加入轮播”。每个列表最多1000项，每页32项；条目固定到所选版本。暂停期间不计时。'); hint.className = 'hint';
  const list = node('ol', '', 'playlist-items'); list.setAttribute('aria-label', '轮播条目');
  const pager = node('div'); pager.className = 'library-toolbar';
  const previous = button('上一页', 'playlist-previous-page', () => { page--; render(); });
  const following = button('下一页', 'playlist-next-page', () => { page++; render(); });
  const pageLabel = node('span', '', 'playlist-page-label'); pageLabel.setAttribute('role', 'status');
  pager.append(previous, pageLabel, following);
  const status = node('p', '', 'playlist-message'); status.className = 'hint'; status.setAttribute('role', 'status');
  const runtime = node('p', '', 'playlist-runtime'); runtime.className = 'hint'; runtime.setAttribute('aria-live', 'polite');
  const actions = node('div'); actions.className = 'library-toolbar';
  const saveButton = node('button', '保存列表', 'playlist-save'); saveButton.type = 'submit';
  const recover = button('核对保存结果', 'playlist-recover', () => editor.recover()); recover.hidden = true;
  const reread = button('重新读取列表', 'playlist-reread', () => load(editor.state.current?.playlistId)); reread.hidden = true;
  const choose = button('选择此列表', 'playlist-choose', async () => {
    const groupId = settings.currentGroupId(); await save();
    if (!await settings.choosePlaylist(editor.state.current, groupId)) throw new Error('原显示组已移除或设置正在处理，请重新选择。');
    message('已为原显示组选择此轮播列表。点击应用设置后开始播放。');
  });
  const next = button('下一项', 'playlist-next', () => step(false));
  const retry = button('重试失败项', 'playlist-retry', () => step(true)); retry.hidden = true;
  actions.append(saveButton, choose, recover, reread, next, retry);
  form.append(field('列表名称（必填）', title), field('播放顺序', mode), field('间隔 / 秒（必填）', interval), hint, list, pager, actions);
  section.append(toolbar, form, status, runtime);
  document.getElementById('work-editor').after(section);
  let page = 0, active = null, activeGroupId = null, refreshing = null;
  const rows = new Map();
  const editor = window.hertzPlaylistEditor(request, state => { message(state.message, state.error); render(); });
  function message(text, error) { status.textContent = text; status.classList.toggle('error', !!error); }
  function syncFields() { title.value = editor.state.title; mode.value = editor.state.mode; interval.value = editor.state.intervalSeconds; }
  function discard() { return !editor.state.dirty || confirm('放弃尚未保存的列表修改？已保存的批次会保留。'); }
  [title, mode, interval].forEach(input => input.addEventListener('input', () => {
    title.setCustomValidity(''); editor.change({ title: title.value, mode: mode.value, intervalSeconds: Number(interval.value) });
  }));
  function rowFor(item) {
    if (rows.has(item.key)) return rows.get(item.key);
    const row = node('li'); row.className = 'library-version'; row.dataset.key = item.key;
    const label = node('span'); label.className = 'playlist-item-label';
    const position = () => editor.state.items.findIndex(value => value.key === item.key);
    const move = to => { page = Math.floor(to / 32); editor.move(item.key, to); };
    const up = button('上移', '', () => move(position() - 1));
    const down = button('下移', '', () => move(position() + 1));
    const destination = node('input'); destination.type = 'number'; destination.min = 1; destination.step = 1; destination.className = 'playlist-position';
    const go = button('移到', '', () => {
      const index = Number(destination.value) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= editor.state.items.length) { destination.reportValidity(); destination.focus(); return; }
      move(index);
    });
    const remove = button('移除', '', () => { const index = position(); editor.remove(item.key); const nearby = list.children[Math.min(index % 32, list.children.length - 1)]; (nearby?.querySelector('button') || saveButton).focus(); });
    const controls = node('div'); controls.className = 'playlist-item-actions'; controls.append(up, down, destination, go, remove);
    row.append(label, controls); const value = { row, label, up, down, destination, go, remove }; rows.set(item.key, value); return value;
  }
  function render() {
    const state = editor.state, locked = state.busy || !!state.pending, pages = Math.max(1, Math.ceil(state.items.length / 32));
    page = Math.min(Math.max(0, page), pages - 1);
    const shown = state.items.slice(page * 32, (page + 1) * 32), keys = new Set(shown.map(item => item.key));
    const focused = document.activeElement, focusedRow = focused?.closest('#playlist-items > li');
    for (const [key, value] of rows) if (!keys.has(key)) { value.row.remove(); rows.delete(key); }
    list.start = page * 32 + 1;
    shown.forEach((item, local) => {
      const index = page * 32 + local, entry = rowFor(item);
      entry.label.textContent = (index + 1) + '. ' + (item.label || '版本 ' + item.packageHash.slice(0, 8));
      entry.destination.max = state.items.length; entry.destination.setAttribute('aria-label', '第' + (index + 1) + '项的目标位置');
      if (entry.destination !== focused) entry.destination.value = index + 1;
      entry.up.disabled = locked || index === 0; entry.down.disabled = locked || index === state.items.length - 1;
      entry.go.disabled = entry.remove.disabled = entry.destination.disabled = locked;
      const before = list.children[local] || null;
      if (before !== entry.row) {
        if (entry.row.parentNode === list && list.moveBefore) list.moveBefore(entry.row, before);
        else list.insertBefore(entry.row, before);
      }
    });
    if (focused && list.contains(focused) && document.activeElement !== focused && !focused.disabled) focused.focus({ preventScroll: true });
    else if (!locked && focused?.disabled && focusedRow && list.contains(focusedRow)) focusedRow.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
    pageLabel.textContent = '第 ' + (page + 1) + ' / ' + pages + ' 页 · 共 ' + state.items.length + ' 项';
    previous.disabled = locked || page === 0; following.disabled = locked || page + 1 >= pages;
    [title, mode, interval, select, open, fresh].forEach(control => { control.disabled = locked; });
    reload.disabled = state.busy;
    choose.disabled = locked || state.conflict || !state.items.length || !settings.canChooseLibraryVersion();
    saveButton.disabled = locked || state.conflict;
    recover.hidden = !state.pending; recover.disabled = state.busy;
    reread.hidden = !state.conflict; reread.disabled = locked;
    next.disabled = state.busy || !active || !activeGroupId || !!active.failed || active.pendingIndex != null;
    retry.hidden = !active || !active.failed; retry.disabled = state.busy;
    form.setAttribute('aria-busy', String(state.busy));
  }
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const old = editor.state.current?.playlistId || select.value; let cursor = null; const all = [];
      do { const value = await request('wallpaper.playlist.list', { limit: 20, cursor }); all.push(...value.playlists); cursor = value.nextCursor; } while (cursor && all.length < 100);
      select.replaceChildren(); all.forEach(value => { const option = node('option', value.title + ' · ' + value.itemCount + '项'); option.value = value.playlistId; select.append(option); });
      if (all.some(value => value.playlistId === old)) select.value = old;
    })();
    try { await refreshing; } finally { refreshing = null; }
  }
  async function load(id) {
    id = typeof id === 'string' ? id : select.value;
    if (!id || editor.state.busy || !discard()) return;
    await editor.load(id); page = 0; syncFields(); render();
  }
  async function save() {
    title.setCustomValidity(title.value.trim() ? '' : '请填写列表名称。');
    for (const input of [title, interval]) if (!input.reportValidity()) { input.focus(); throw new Error('请检查列表名称与间隔。'); }
    await editor.save();
    refresh().catch(error => message('列表已保存；列表目录刷新失败：' + error.message, true));
  }
  form.addEventListener('submit', event => { event.preventDefault(); save().catch(error => message(error.message, true)); });
  async function step(retry) { if (!active || !activeGroupId) return; const groupId = activeGroupId, playlistId = active.playlistId; await request('wallpaper.playlist.next', { playlistId, groupId, retry }); message(retry ? '正在重试同一版本。' : '正在切换下一项。'); }
  window.addEventListener('wallpaper-playlist-add', event => {
    try { const { work, version } = event.detail; page = Math.floor(editor.state.items.length / 32); editor.add({ workKey: work.workKey, packageHash: version.packageHash, label: work.title + ' · 版本 ' + version.version }); section.open = true; }
    catch (error) { message(error.message, true); }
  });
  function updateRuntime(value) {
    active = value && value.playlist; activeGroupId = value && value.groupId;
    runtime.textContent = active ? active.title + ' · ' + (active.failed ? '切换失败，等待重试' : active.pendingIndex != null ? '正在切换第' + (active.pendingIndex + 1) + '项' : '第' + ((active.currentIndex || 0) + 1) + ' / ' + active.itemCount + '项') : '';
    render();
  }
  window.hertzWallpaperPlaylist = { flush: () => editor.flush() };
  window.addEventListener('wallpaper-runtime-updated', event => updateRuntime(event.detail));
  section.addEventListener('toggle', () => { if (section.open) refresh().catch(error => message(error.message, true)); });
  syncFields(); updateRuntime(settings.currentRuntime());
})();
