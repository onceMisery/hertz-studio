// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var requestManagement = function (command, payload, id) { return window.hertzWallpaperSettings.requestManagement(command, payload, id); };
  var libraryBusy = false, libraryLoading = false, libraryCursor = null, favoritesOnly = false;
  var libraryJob = null, libraryPoll = 0, importRequest = null, cancelRequested = false;
  var posterRevision = 0;
  var posterObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var node = entry.target, revision = posterRevision; posterObserver.unobserve(node);
      window.hertzWallpaperSettings.readPoster(node.dataset.workKey, node.dataset.packageHash).then(function (source) {
        if (!source || !node.isConnected || revision !== posterRevision) return;
        var image = document.createElement('img'); image.alt = '视频封面'; image.decoding = 'async';
        image.onload = function () { if (node.isConnected && revision === posterRevision) node.replaceChildren(image); };
        image.src = source;
      });
    });
  }, { root: document.querySelector('main') });
  window.addEventListener('wallpaper-posters-invalidated', function () {
    posterRevision++;
    document.querySelectorAll('.library-poster').forEach(function (node) {
      posterObserver.unobserve(node);
      node.textContent = '暂无封面';
      posterObserver.observe(node);
    });
  });
  function forgetPosters(element) {
    element.querySelectorAll('.library-poster').forEach(node => posterObserver.unobserve(node));
  }
  function libraryMessage(text, error) {
    $('library-message').textContent = text;
    $('library-message').classList.toggle('error', !!error);
  }
  function libraryControls() {
    $('library-import').disabled = libraryBusy || !!libraryJob || !!importRequest;
    $('library-refresh').disabled = libraryLoading;
    $('library-more').disabled = libraryLoading;
    $('library-favorites-only').disabled = libraryLoading;
    $('library-cancel').hidden = !libraryJob;
    $('library-cancel').disabled = cancelRequested;
    $('library-recover').hidden = !importRequest;
  }
  function libraryDeleteMessage(error) {
    libraryMessage(error.code === 'asset_in_use'
      ? '作品仍被已保存的壁纸、设置草稿或预览使用。请在相应来源中切换壁纸，或放弃草稿并结束预览后再删除。'
      : error.message, true);
  }
  function renderLibraryWorks(works, append) {
    var list = $('library-works');
    if (!append) { forgetPosters(list); list.replaceChildren(); }
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
          forgetPosters(detail); detail.replaceChildren();
          receipt.result.versions.forEach(function (version) {
            var row = document.createElement('div'), label = document.createElement('span'); row.className = 'library-version';
            label.textContent = '版本 ' + version.version + (version.state === 'installed' ? ' · 已安装' : ' · ' + version.state);
            row.appendChild(label);
            if (['installed','unavailable'].includes(version.state) && work.kind === 'video') {
              var poster = document.createElement('span'); poster.className = 'library-poster'; poster.textContent = '暂无封面';
              poster.dataset.workKey = work.workKey; poster.dataset.packageHash = version.packageHash;
              row.prepend(poster); posterObserver.observe(poster);
            }
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
            var removeVersion = document.createElement('button'); removeVersion.type = 'button'; removeVersion.textContent = '删除版本'; removeVersion.className = 'library-delete';
            removeVersion.disabled = !window.hertzWallpaperSettings.canChooseLibraryVersion();
            removeVersion.addEventListener('click', async function () {
              if (!confirm('删除“' + work.title + '”的版本 ' + version.version + '？此操作不可撤销。')) return;
              removeVersion.disabled = true;
              try {
                await requestManagement('wallpaper.library.deleteVersion', { workKey: work.workKey, version: version.version, packageHash: version.packageHash });
                libraryMessage('已删除“' + work.title + '”的版本 ' + version.version + '。', false);
                detail.hidden = true; button.textContent = '查看版本';
                await refreshLibrary(false);
              } catch (error) { libraryDeleteMessage(error); }
              finally { removeVersion.disabled = false; }
            });
            row.appendChild(removeVersion);
            detail.appendChild(row);
          });
          if (!detail.children.length) detail.textContent = '暂无可用版本';
          detail.hidden = false; button.textContent = '收起版本';
        } catch (error) { libraryMessage(error.message, true); }
        finally { button.disabled = false; }
      });
      var removeWork = document.createElement('button'); removeWork.type = 'button'; removeWork.textContent = '删除作品'; removeWork.className = 'library-delete';
      removeWork.disabled = !window.hertzWallpaperSettings.canChooseLibraryVersion();
      removeWork.addEventListener('click', async function () {
        if (!confirm('删除作品“' + work.title + '”及其全部版本？此操作不可撤销。')) return;
        removeWork.disabled = true;
        try {
          await requestManagement('wallpaper.library.deleteWork', { workKey: work.workKey });
          libraryMessage('已删除作品“' + work.title + '”。', false);
          await refreshLibrary(false);
        } catch (error) { libraryDeleteMessage(error); }
        finally { removeWork.disabled = false; }
      });
      var favorite = document.createElement('button'); favorite.type = 'button'; favorite.className = 'library-favorite';
      favorite.textContent = work.favorite ? '★ 已收藏' : '☆ 收藏';
      favorite.addEventListener('click', async function () {
        favorite.disabled = true;
        try {
          var receipt = await requestManagement('wallpaper.library.favorite', { workKey: work.workKey, favorite: !work.favorite });
          work.favorite = receipt.result.favorite;
          favorite.textContent = work.favorite ? '★ 已收藏' : '☆ 收藏';
          if (favoritesOnly && !work.favorite) await refreshLibrary(false);
        } catch (error) { libraryMessage(error.message, true); }
        finally { favorite.disabled = false; }
      });
      var heading = document.createElement('div'); heading.append(title, meta, favorite, removeWork);
      item.append(heading, button, detail); list.appendChild(item);
    });
    $('library-empty').hidden = list.children.length > 0;
    $('library-empty').textContent = favoritesOnly ? '还没有收藏的作品。' : '作品库还是空的。导入后会显示在这里。';
  }
  async function refreshLibrary(append) {
    if (libraryLoading) return;
    libraryLoading = true; libraryControls();
    if (!append) window.hertzWallpaperSettings.invalidatePosters();
    try {
      var receipt = await requestManagement('wallpaper.library.list', { limit: 20, cursor: append ? libraryCursor : null, favoritesOnly: favoritesOnly });
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
  $('library-favorites-only').addEventListener('change', function () {
    favoritesOnly = this.checked; libraryCursor = null; refreshLibrary(false);
  });
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
  window.addEventListener('pagehide', function () { clearTimeout(libraryPoll); posterObserver.disconnect(); });
})();
