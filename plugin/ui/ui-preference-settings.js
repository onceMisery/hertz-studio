// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
(function () {
  'use strict';
  var refs, selected = null, saved = false, busy = false, returnFocus = null;
  function note(message, error) {
    refs.status.textContent = message;
    refs.status.classList.toggle('ui-preference-error', !!error);
  }
  function dialogNote(message, error) {
    refs.dialogStatus.textContent = message;
    refs.dialogStatus.classList.toggle('ui-preference-error', !!error);
  }
  function lock(value) {
    busy = value;
    refs.export.disabled = value; refs.import.disabled = value;
    refs.apply.disabled = value || !selected || !selected.entries.length;
    refs.cancel.disabled = value;
    refs.apply.textContent = saved ? '保存舞台并重新加载' : '应用并重新加载';
    refs.cancel.textContent = saved ? '返回播放器' : '取消';
    refs.dialog.setAttribute('aria-busy', String(value));
  }
  function message(error) { return String(error && error.message || error); }
  function display(value, key) {
    if (value == null) return '未保存（使用默认值）';
    if (typeof value === 'boolean') return value ? '开启' : '关闭';
    if (key === 'vmusic.theme.v2' && window.Theme) {
      var theme = window.Theme.list().find(function (item) { return item.id === value; });
      if (theme) return theme.name;
      if (window.ThemeStudio && value === window.ThemeStudio.customThemeId()) return '自定义配色';
    }
    if (key === 'vmusic.skin' && window.Skins) {
      var skin = window.Skins.catalog().find(function (item) { return item.id === value; });
      if (skin) return skin.name;
    }
    if (key === 'vmusic.theme.custom.v1' && typeof value === 'object'
        && ['bg', 'accent', 'accent2'].every(function (name) { return typeof value[name] === 'string'; })) {
      return '底色 ' + value.bg + '\n强调色 ' + value.accent + '\n辅助色 ' + value.accent2;
    }
    return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  }
  function currentValue(key) {
    var raw = localStorage.getItem(key);
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch (_) { return raw; }
  }
  async function exportFile() {
    lock(true); note('正在读取界面偏好…');
    try {
      await window.hertzHost.storageReady();
      var data = window.UiPreferences.exportDocument();
      var receipt = await window.hertzHost.saveTextFile('hertz-ui-preferences.json', 'application/json', JSON.stringify(data, null, 2));
      note(receipt && receipt.status === 'saved' ? '界面偏好已保存'
        : receipt && receipt.status === 'cancelled' ? '已取消保存' : '已发起界面偏好文件保存，请在宿主中完成保存');
    } catch (error) { note('偏好导出失败：' + message(error), true); }
    finally { lock(false); }
  }
  async function readFile() {
    var file = refs.file.files && refs.file.files[0]; refs.file.value = '';
    if (!file) return;
    selected = null; saved = false; lock(true); note('正在检查偏好文件…');
    try {
      if (file.size > window.UiPreferences.maxBytes) throw new Error('偏好文件不能超过 64 KiB');
      await window.hertzHost.storageReady();
      selected = window.UiPreferences.parse(await file.text());
      refs.rows.replaceChildren();
      selected.entries.forEach(function (entry) {
        var row = document.createElement('tr'), title = document.createElement('th');
        title.scope = 'row'; title.textContent = entry.label; row.appendChild(title);
        [currentValue(entry.key), entry.value].forEach(function (value, index) {
          var cell = document.createElement('td'), content = document.createElement('pre');
          cell.dataset.label = index === 0 ? '当前值' : '导入值';
          content.textContent = display(value, entry.key); cell.appendChild(content); row.appendChild(cell);
        });
        refs.rows.appendChild(row);
      });
      if (!selected.entries.length) throw new Error('文件没有可应用的界面偏好');
      dialogNote('将覆盖下列 ' + selected.entries.length + ' 项偏好；文件中未列出的项保持当前值');
      returnFocus = refs.import; refs.dialog.showModal(); refs.cancel.focus();
      note('文件已检查，等待确认应用');
    } catch (error) { selected = null; note('偏好导入失败：' + message(error), true); }
    finally { lock(false); }
  }
  function recording() {
    return window.VideoExport && typeof window.VideoExport.isRecording === 'function' && window.VideoExport.isRecording();
  }
  async function saveStage() {
    var stage = window.CreativeStage, persistence = window.StagePersistence;
    function checkMediaEdits() {
      if (window.Workshop && (typeof window.Workshop.hasPendingMediaEdits !== 'function'
          || window.Workshop.hasPendingMediaEdits())) {
        throw new Error('工坊仍在处理背景素材，完成后请重试');
      }
    }
    checkMediaEdits();
    if (!stage || !persistence || typeof stage.hydrated !== 'function'
        || typeof stage.flushPersistence !== 'function' || typeof stage.flushLibrary !== 'function') {
      throw new Error('无法确认舞台保存状态，请重新加载页面后再试');
    }
    await stage.hydrated();
    if (persistence.status().hydrated !== true) throw new Error('舞台设置尚未读取完成');
    var results = await Promise.allSettled([stage.flushPersistence(), stage.flushLibrary()]);
    var failure = results.find(function (result) { return result.status === 'rejected'; });
    if (failure) throw failure.reason;
    checkMediaEdits();
  }
  async function applyFile() {
    if (busy || !selected) return;
    lock(true); dialogNote('正在保存当前舞台与预置库…');
    try {
      if (recording()) throw new Error('正在录制，请先结束录制并保存视频，再应用偏好');
      await saveStage();
      if (recording()) throw new Error('正在录制，请先结束录制并保存视频，再应用偏好');
      if (!saved) {
        var entries = window.UiPreferences.writes(selected);
        dialogNote('正在保存导入的界面偏好…');
        await window.hertzHost.applyStorageBatch(entries);
        saved = true;
      }
      // Async work already started in the workshop may finish while the SDK
      // write waits. Drain both save owners again before leaving this document.
      dialogNote('偏好已保存，正在确认舞台与预置库保存…');
      await saveStage();
      if (recording()) {
        selected = null;
        note('偏好已保存；请结束录制并保存视频，再重新加载页面生效');
        dialogNote('偏好已保存；请结束录制并保存视频，再重新加载页面生效');
        return;
      }
      selected = null; note('界面偏好已保存，正在重新加载页面…');
      window.location.reload();
    } catch (error) { dialogNote((saved ? '偏好已保存，暂不重新加载：' : '应用失败：') + message(error), true); }
    finally { lock(false); }
  }
  function bind() {
    var ids = { export: 'ui-preferences-export', import: 'ui-preferences-import', file: 'ui-preferences-file',
      status: 'ui-preferences-status', dialog: 'ui-preferences-dialog', rows: 'ui-preferences-rows',
      dialogStatus: 'ui-preferences-dialog-status', cancel: 'ui-preferences-cancel', apply: 'ui-preferences-apply' };
    refs = {};
    Object.keys(ids).forEach(function (key) { refs[key] = document.getElementById(ids[key]); });
    if (Object.keys(ids).some(function (key) { return !refs[key]; })) return;
    refs.export.onclick = exportFile;
    refs.import.onclick = function () { refs.file.click(); };
    refs.file.onchange = readFile; refs.apply.onclick = applyFile;
    refs.cancel.onclick = function () { if (!busy) refs.dialog.close(); };
    refs.dialog.addEventListener('cancel', function (event) {
      if (busy) event.preventDefault();
    });
    refs.dialog.addEventListener('close', function () {
      if (saved) note('偏好已保存，将在下次重新加载页面时生效');
      else if (selected) note('已取消偏好导入');
      selected = null; lock(false);
      if (returnFocus) returnFocus.focus(); returnFocus = null;
    });
    lock(false);
  }
  window.UiPreferenceSettings = { bind: bind };
})();
