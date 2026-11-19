// SPDX-License-Identifier: MIT
(function () {
  'use strict';
  const fixed = ({ workKey, packageHash }) => ({ workKey, packageHash });
  const metadata = value => ({ title: value.title, mode: value.mode, intervalSeconds: value.intervalSeconds });
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const same = (a, b) => a && b && a.playlistId === b.playlistId && a.revision === b.revision
    && equal(metadata(a), metadata(b)) && equal(a.items.map(fixed), b.items.map(fixed));
  const identified = item => Object.assign({}, item, { key: crypto.randomUUID() });
  function operations(base, target) {
    const working = base.slice(), result = [], keep = new Set(target.map(item => item.key));
    // Retain one item until a replacement exists, so every bounded batch is nonempty.
    for (let index = working.length - 1; index >= 0; index--) {
      if (!keep.has(working[index].key) && working.length > 1) {
        working.splice(index, 1); result.push({ kind: 'remove', index });
      }
    }
    if (working.length === 1 && !keep.has(working[0].key) && target.length) {
      working.unshift(target[0]); result.push({ kind: 'insert', index: 0, item: target[0] });
      working.splice(1, 1); result.push({ kind: 'remove', index: 1 });
    }
    target.forEach((item, index) => {
      const from = working.findIndex(value => value.key === item.key);
      if (from === index) return;
      // A row moved down displaces a run. Move that row once, instead of saving
      // a move for every displaced neighbour (up to 999 for a last-position move).
      const displaced = working[index], destination = displaced && target.findIndex(value => value.key === displaced.key);
      if (from === index + 1 && destination > index && destination < working.length) {
        working.splice(destination, 0, working.splice(index, 1)[0]);
        result.push({ kind: 'move', from: index, to: destination });
        return;
      }
      if (from < 0) { working.splice(index, 0, item); result.push({ kind: 'insert', index, item }); }
      else { working.splice(index, 0, working.splice(from, 1)[0]); result.push({ kind: 'move', from, to: index }); }
    });
    while (working.length > target.length) { const index = working.length - 1; working.pop(); result.push({ kind: 'remove', index }); }
    return result;
  }
  function apply(items, edits) {
    const next = items.slice();
    edits.forEach(edit => {
      if (edit.kind === 'insert') next.splice(edit.index, 0, edit.item);
      else if (edit.kind === 'remove') next.splice(edit.index, 1);
      else next.splice(edit.to, 0, next.splice(edit.from, 1)[0]);
    });
    return next;
  }
  window.hertzPlaylistEditor = function (request, notify) {
    const state = { current: null, base: [], items: [], title: '我的轮播', mode: 'sequential', intervalSeconds: 60,
      dirty: false, busy: false, pending: null, conflict: false, message: '', error: false };
    let flight = null;
    const announce = (message, error = false) => { state.message = message; state.error = error; notify(state); };
    const changed = () => {
      state.dirty = state.items.length > 0 && (!state.current || !equal(metadata(state), metadata(state.current))
        || !equal(state.items.map(item => item.key), state.base.map(item => item.key)));
      // An empty edited list is also dirty and must not be silently closed.
      if (state.current && !state.items.length) state.dirty = true;
    };
    async function read(id) {
      let offset = 0, revision, result, items = [];
      do {
        const page = await request('wallpaper.playlist.page', { playlistId: id, expectedPlaylistRevision: revision, offset, limit: 32 });
        if (!page || page.playlistId !== id || !Number.isSafeInteger(page.revision) || page.revision < 1
          || (revision !== undefined && revision !== page.revision) || page.offset !== offset
          || !Array.isArray(page.items) || !page.items.length || page.items.length > 32
          || !Number.isInteger(page.itemCount) || page.itemCount > 1000) throw new Error('列表分页回执无效，原编辑已保留。');
        if (!result) result = page;
        if (page.itemCount !== result.itemCount || !equal(metadata(page), metadata(result))) throw new Error('列表读取期间已变化。');
        revision = page.revision; items.push(...page.items);
        if (items.length > page.itemCount || (page.nextOffset !== null && page.nextOffset !== items.length)
          || (page.nextOffset === null && items.length !== page.itemCount)) throw new Error('列表分页范围不一致。');
        offset = page.nextOffset;
      } while (offset !== null);
      return Object.assign({}, metadata(result), { playlistId: id, revision, items });
    }
    function accept(receipt) {
      const pending = state.pending;
      if (!receipt || receipt.playlistId !== pending.after.playlistId || receipt.revision !== pending.after.revision
        || receipt.itemCount !== pending.after.items.length || !equal(metadata(receipt), metadata(pending.after))) {
        throw new Error('保存回执不完整，请核对保存结果。');
      }
      state.current = pending.after; state.base = pending.after.items; state.pending = null; changed();
    }
    async function locked(action) {
      if (state.busy) throw new Error('列表正在处理，请等待完成。');
      state.busy = true; notify(state);
      try { return await action(); }
      catch (error) { announce(error.message || '列表未保存，编辑内容已保留。', true); throw error; }
      finally { state.busy = false; notify(state); }
    }
    async function save() {
      if (flight) return flight;
      if (state.pending) throw new Error('上次保存结果尚未确认，请先核对保存结果。');
      if (state.conflict) throw new Error('保存的列表已变化。请保留需要的修改，再明确重新读取列表。');
      if (!state.dirty) return;
      if (!state.title.trim() || !Number.isInteger(state.intervalSeconds) || state.intervalSeconds < 10
        || state.intervalSeconds > 86400 || !state.items.length) throw new Error('请填写名称、10–86400秒间隔，并加入至少一个版本。');
      flight = locked(async () => {
        const id = state.current ? state.current.playlistId : 'playlist-' + crypto.randomUUID();
        let completed = 0;
        do {
          const edits = operations(state.base, state.items).slice(0, 32);
          const revision = state.current ? state.current.revision : 0;
          const after = Object.assign({}, metadata(state), { playlistId: id, revision: revision + 1, items: apply(state.base, edits) });
          const payload = Object.assign({}, metadata(state), { playlistId: id, expectedPlaylistRevision: revision,
            operations: edits.map(edit => edit.kind === 'insert' ? Object.assign({}, edit, { item: fixed(edit.item) }) : edit) });
          state.pending = { requestId: crypto.randomUUID(), before: state.current, after, payload };
          announce('正在保存第 ' + (++completed) + ' 批修改；共 ' + state.items.length + ' 项。');
          try { accept(await request('wallpaper.playlist.update', payload, state.pending.requestId)); }
          catch (error) {
            if (error.receipt && error.code !== 'operation_pending') {
              state.pending = null; state.conflict = error.code === 'playlist_conflict';
            }
            throw new Error((state.pending ? '保存结果待确认，请点击“核对保存结果”。' : error.message)
              + ' 已完成的批次已保存，其余编辑保留。');
          }
        } while (state.dirty);
        announce('轮播列表已保存，共 ' + state.items.length + ' 项。应用设置后开始播放。');
      });
      try { await flight; } finally { flight = null; }
    }
    async function recover() {
      return locked(async () => {
        const pending = state.pending;
        if (!pending) return;
        try {
          const original = await request('wallpaper.operations.get', { requestId: pending.requestId, command: 'wallpaper.playlist.update' });
          if (!original.ok) {
            state.pending = null; state.conflict = original.error?.code === 'playlist_conflict';
            throw new Error(original.error?.message || '原保存未完成，编辑已保留。');
          }
          accept(original.result);
        } catch (error) {
          if (error.code !== 'operation_unknown') throw error;
          let actual;
          try { actual = await read(pending.after.playlistId); }
          catch (readError) {
            if (readError.code !== 'playlist_not_found' || pending.before) throw readError;
          }
          if (same(actual, pending.after)) accept(Object.assign({}, actual, { itemCount: actual.items.length }));
          else if ((!actual && !pending.before) || same(actual, pending.before)) { state.pending = null; changed(); }
          else { state.pending = null; state.conflict = true; throw new Error('列表已有其它修改，当前编辑已保留。请明确重新读取。'); }
        }
        announce(state.dirty ? '原保存结果已核对；其余修改尚未保存，请点击“保存列表”继续。' : '已核对：轮播列表已保存。');
      });
    }
    return { state, save, recover, flush: () => flight || save(),
      async load(id) { return locked(async () => {
        if (state.pending) throw new Error('请先核对保存结果。');
        const value = await read(id); value.items = value.items.map(identified);
        state.current = value; state.base = value.items.slice(); state.items = value.items.slice();
        Object.assign(state, metadata(value)); state.dirty = false; state.conflict = false;
        announce('已读取 ' + value.items.length + ' 个固定版本。');
      }); },
      reset() { if (state.busy || state.pending) return; Object.assign(state, { current: null, base: [], items: [], title: '我的轮播', mode: 'sequential', intervalSeconds: 60, dirty: false, conflict: false }); announce('在本地作品中加入版本，保存后即可使用。'); },
      change(values) { if (state.busy || state.pending) return; Object.assign(state, values); changed(); notify(state); },
      add(item) { if (state.busy || state.pending) throw new Error('请等待当前操作完成或核对保存结果。'); if (state.items.length >= 1000) throw new Error('每个列表最多1000项。'); state.items.push(identified(item)); changed(); announce('已加入第 ' + state.items.length + ' 项，尚未保存。'); },
      move(key, to) { if (state.busy || state.pending) return; const from = state.items.findIndex(item => item.key === key); if (from < 0 || to < 0 || to >= state.items.length || !Number.isInteger(to)) return; state.items.splice(to, 0, state.items.splice(from, 1)[0]); changed(); announce('已移到第 ' + (to + 1) + ' 项，尚未保存。'); },
      remove(key) { if (state.busy || state.pending) return; state.items = state.items.filter(item => item.key !== key); changed(); announce('已移除条目，尚未保存。'); }
    };
  };
})();
