// SPDX-License-Identifier: MIT
// Native File objects are forwarded intact; paths never enter JavaScript.
(function () {
  'use strict';
  var host = null, busy = false, depth = 0;
  var area, picker, note, button;
  function clearDrag() {
    depth = 0;
    if (area) area.classList.remove('is-dragging');
    document.documentElement.classList.remove('native-music-dragging');
  }
  function filesDrag(event) {
    var transfer = event.dataTransfer;
    return !!transfer && Array.from(transfer.types || []).includes('Files');
  }
  function message(text, error) {
    note.textContent = text;
    note.classList.toggle('is-error', !!error);
  }
  async function submit(files) {
    clearDrag();
    window.dispatchEvent(new Event('hertz-native-import-requested'));
    if (busy) { message('正在处理上次导入，请稍候', true); return; }
    var selected = Array.from(files || []);
    if (!selected.length) { message('未能取得文件，请使用选择文件或添加目录', true); return; }
    if (selected.length > 256) { message('一次最多选择 256 个文件或目录', true); return; }
    busy = true; button.disabled = true; area.setAttribute('aria-busy', 'true');
    message('正在准备导入…');
    try {
      await host.importFiles(selected);
      message('已开始收录；进度和失败明细显示在下方');
      window.dispatchEvent(new Event('hertz-native-import-started'));
    } catch (error) { message(error && error.message || '音乐导入未能开始，请重试', true); }
    finally { busy = false; button.disabled = false; area.setAttribute('aria-busy', 'false'); picker.value = ''; }
  }
  function setup() {
    var candidate = window.__hertzWindowHost;
    if (host || window.hertzHost?.isDbx || !candidate || !candidate.fileImportReady || candidate.fileImportVersion !== 1 || typeof candidate.importFiles !== 'function') return;
    area = document.getElementById('native-music-import');
    if (!area) return;
    host = candidate; picker = document.getElementById('native-music-files');
    note = document.getElementById('native-music-note'); button = document.getElementById('native-music-pick');
    area.hidden = false;
    button.addEventListener('click', function () { if (!busy) picker.click(); });
    picker.addEventListener('change', function () { submit(picker.files); });
    document.addEventListener('dragenter', function (event) {
      if (!filesDrag(event)) return;
      event.preventDefault(); depth += 1;
      area.classList.add('is-dragging'); document.documentElement.classList.add('native-music-dragging');
    });
    document.addEventListener('dragover', function (event) {
      if (!filesDrag(event)) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
    }, true);
    document.addEventListener('dragleave', function (event) {
      if (!filesDrag(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) clearDrag();
    });
    document.addEventListener('drop', function (event) {
      if (!filesDrag(event)) { clearDrag(); return; }
      event.preventDefault(); event.stopPropagation();
      submit(event.dataTransfer.files);
    }, true);
    document.addEventListener('dragend', clearDrag);
    window.addEventListener('blur', clearDrag);
  }
  window.addEventListener('hertz-native-host-ready', setup);
  window.addEventListener('hertz-native-host-confirmed', setup);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();
})();
