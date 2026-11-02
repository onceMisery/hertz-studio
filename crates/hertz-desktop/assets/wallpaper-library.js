// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var requestManagement = function (command, payload, id) { return window.hertzWallpaperSettings.requestManagement(command, payload, id); };
  var libraryBusy = false, libraryLoading = false, libraryCursor = null;
  var libraryJob = null, libraryPoll = 0, importRequest = null, cancelRequested = false;
  function libraryMessage(text, error) {
    $('library-message').textContent = text;
    $('library-message').classList.toggle('error', !!error);
  }
  function libraryControls() {
    $('library-import').disabled = libraryBusy || !!libraryJob || !!importRequest;
    $('library-refresh').disabled = libraryLoading;
    $('library-more').disabled = libraryLoading;
    $('library-cancel').hidden = !libraryJob;
    $('library-cancel').disabled = cancelRequested;
    $('library-recover').hidden = !importRequest;
  }
  function renderLibraryWorks(works, append) {
    var list = $('library-works');
    if (!append) list.replaceChildren();
    works.forEach(function (work) {
      var item = document.createElement('li'), title = document.createElement('strong');
      var meta = document.createElement('span'), button = document.createElement('button'), detail = document.createElement('div');
      title.textContent = work.title;
      meta.className = 'small'; meta.textContent = ({ image: '图片', video: '视频', scene: '场景' })[work.kind] || '壁纸';
      button.textContent = '查看版本'; detail.className = 'hint'; detail.hidden = true;
      button.addEventListener('click', async function () {
        if (!detail.hidden) { detail.hidden = true; button.textContent = '查看版本'; return; }
        button.disabled = true;
        try {
          var receipt = await requestManagement('wallpaper.library.get', { workKey: work.workKey });
          detail.replaceChildren();
          receipt.result.versions.forEach(function (version) {
            var row = document.createElement('div'), label = document.createElement('span'); row.className = 'library-version';
            label.textContent = '版本 ' + version.version + (version.state === 'installed' ? ' · 已安装' : ' · ' + version.state);
            row.appendChild(label);
            if (version.state === 'installed' && ['image','video'].includes(work.kind)) {
              var choose = document.createElement('button'); choose.type = 'button'; choose.dataset.librarySelect = 'true'; choose.textContent = '选择此版本'; choose.disabled = !window.hertzWallpaperSettings.canChooseLibraryVersion();
              choose.addEventListener('click', async function () {
                choose.disabled = true;
                try {
                  var selected = await window.hertzWallpaperSettings.chooseLibraryVersion(work, version);
                  libraryMessage(selected ? '已选择“' + work.title + '”。点击应用后切换桌面壁纸。' : '请先完成当前设置操作。', !selected);
                } catch (error) { libraryMessage(error.message, true); }
                finally { choose.disabled = !window.hertzWallpaperSettings.canChooseLibraryVersion(); }
              });
              row.appendChild(choose);
            }
            detail.appendChild(row);
          });
          if (!detail.children.length) detail.textContent = '暂无可用版本';
          detail.hidden = false; button.textContent = '收起版本';
        } catch (error) { libraryMessage(error.message, true); }
        finally { button.disabled = false; }
      });
      var heading = document.createElement('div'); heading.append(title, meta);
      item.append(heading, button, detail); list.appendChild(item);
    });
    $('library-empty').hidden = list.children.length > 0;
  }
  async function refreshLibrary(append) {
    if (libraryLoading) return;
    libraryLoading = true; libraryControls();
    try {
      var receipt = await requestManagement('wallpaper.library.list', { limit: 20, cursor: append ? libraryCursor : null });
      renderLibraryWorks(receipt.result.works, !!append);
      libraryCursor = receipt.result.nextCursor;
      $('library-more').hidden = !libraryCursor;
    } catch (error) { libraryMessage(error.message, true); }
    finally { libraryLoading = false; libraryControls(); }
  }
  function showLibraryJob(job) {
    clearTimeout(libraryPoll);
    var terminal = ['done', 'failed', 'cancelled'].includes(job.state);
    var labels = { queued: '等待导入', preparing: '正在检查并准备壁纸', publishing: '正在保存壁纸', done: '已导入本地作品', failed: '导入失败', cancelled: '已取消导入' };
    var text = cancelRequested && !terminal ? '正在取消，等待文件处理结束…' : labels[job.state] || '正在导入';
    if (job.stagedBytes > 0 && !terminal) text += ' · ' + (job.stagedBytes / 1048576).toFixed(1) + ' MiB';
    if (job.state === 'failed') text += '：' + (job.error || '请重新选择文件后再试。');
    libraryMessage(text, job.state === 'failed');
    libraryJob = terminal ? null : job.jobId;
    if (terminal) {
      cancelRequested = false;
      if (job.state === 'done' && $('local-library').open) refreshLibrary(false);
    } else libraryPoll = setTimeout(pollLibraryJob, 5000);
    libraryControls();
  }
  async function pollLibraryJob() {
    if (!libraryJob) return;
    try { showLibraryJob((await requestManagement('wallpaper.jobs.get', { jobId: libraryJob })).result); }
    catch (error) {
      libraryMessage(error.message + ' 将继续查询任务状态。', true);
      libraryPoll = setTimeout(pollLibraryJob, 5000);
    }
  }
  async function recoverImport() {
    if (!importRequest || libraryBusy) return;
    libraryBusy = true; libraryControls();
    try {
      var receipt = await requestManagement('wallpaper.operations.get', { requestId: importRequest, command: "wallpaper.import.begin" });
      var operation = receipt.result;
      if (operation.protocol === 2) {
        if (!operation.ok) { importRequest = null; throw Object.assign(new Error(operation.error.message), { code: operation.error.code }); }
        libraryJob = operation.jobId || operation.result.jobId;
      } else libraryJob = operation.jobId;
      if (libraryJob) { importRequest = null; cancelRequested = false; await pollLibraryJob(); }
    } catch (error) {
      libraryMessage(error.code === 'operation_unknown' ? '未找到原操作记录。请刷新作品列表，确认结果后再选择文件。' : error.message, true);
      if (error.code === 'operation_unknown') { importRequest = null; refreshLibrary(false); }
    } finally { libraryBusy = false; libraryControls(); }
  }
  $('local-library').addEventListener('toggle', async function () {
    if (!this.open) return;
    refreshLibrary(false);
    try {
      var receipt = await requestManagement('wallpaper.status', {});
      if (receipt.result.activeJob) showLibraryJob(receipt.result.activeJob);
    } catch (error) { libraryMessage(error.message, true); }
  });
  $('library-refresh').addEventListener('click', function () { refreshLibrary(false); if (libraryJob) pollLibraryJob(); });
  $('library-more').addEventListener('click', function () { refreshLibrary(true); });
  $('library-recover').addEventListener('click', recoverImport);
  $('library-import').addEventListener('click', async function () {
    if (libraryBusy || libraryJob || importRequest) return;
    libraryBusy = true; libraryControls();
    try {
      var selected = await requestManagement('wallpaper.file.pick', {});
      if (selected.result.cancelled) return;
      var id = crypto.randomUUID(); importRequest = id;
      libraryMessage('正在导入 ' + selected.result.name + '…', false);
      var accepted = await requestManagement('wallpaper.import.begin', { fileToken: selected.result.fileToken }, id);
      libraryJob = accepted.jobId; importRequest = null; cancelRequested = false;
      await pollLibraryJob();
    } catch (error) {
      if (error.code !== 'receipt_timeout' && error.receipt) importRequest = null;
      libraryMessage(error.message, true);
    } finally {
      libraryBusy = false; libraryControls();
      if (importRequest) recoverImport();
    }
  });
  $('library-cancel').addEventListener('click', async function () {
    if (!libraryJob || cancelRequested) return;
    cancelRequested = true; libraryControls();
    libraryMessage('正在取消，等待文件处理结束…', false);
    try { await requestManagement('wallpaper.jobs.cancel', { jobId: libraryJob }); }
    catch (error) { libraryMessage(error.message + ' 将继续查询任务状态。', true); }
    clearTimeout(libraryPoll); pollLibraryJob();
  });
  window.addEventListener('pagehide', function () { clearTimeout(libraryPoll); });
})();
