// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var requestManagement = function (command, payload, id) { return window.hertzWallpaperSettings.requestManagement(command, payload, id); };
  var libraryBusy = false, libraryLoading = false, libraryRefreshQueued = false, libraryCursor = null, favoritesOnly = false;
  var libraryJob = null, libraryPoll = 0, importRequest = null, cancelRequested = false;
  var operationCommand = 'wallpaper.import.begin';
  var recoveryJob = null;
  var referenceEpoch = 0, referenceTarget = null, referenceLoading = false, pageLeaving = false, deleteInFlight = false;
  var referenceKinds = { savedConfiguration: '已保存配置', settingsDraft: '设置草稿', desktop: '桌面正在使用', preparing: '正在准备', retiring: '正在释放', preview: '预览', applying: '正在应用', playlist: '轮播列表', workDraft: '作品草稿', publication: '正在发布' };
  var references = document.createElement('section'); references.id = 'library-references'; references.className = 'library-references'; references.hidden = true;
  references.setAttribute('aria-labelledby', 'library-references-title');
  var referenceHeading = document.createElement('div'); referenceHeading.className = 'library-references-heading';
  var referenceTitle = document.createElement('h3'); referenceTitle.id = 'library-references-title'; referenceTitle.tabIndex = -1;
  var referenceActions = document.createElement('div'); referenceActions.className = 'library-reference-actions';
  var referenceRefresh = document.createElement('button'); referenceRefresh.id = 'library-references-refresh'; referenceRefresh.type = 'button'; referenceRefresh.textContent = '刷新引用';
  var referenceClose = document.createElement('button'); referenceClose.type = 'button'; referenceClose.textContent = '收起引用';
  referenceActions.append(referenceRefresh, referenceClose); referenceHeading.append(referenceTitle, referenceActions);
  var referenceStatus = document.createElement('p'); referenceStatus.id = 'library-references-status'; referenceStatus.className = 'hint'; referenceStatus.setAttribute('role', 'status');
  var referenceSkeleton = document.createElement('div'); referenceSkeleton.className = 'library-references-loading'; referenceSkeleton.hidden = true; referenceSkeleton.setAttribute('aria-hidden', 'true');
  referenceSkeleton.append(document.createElement('span'), document.createElement('span'));
  var referenceList = document.createElement('ul'); referenceList.id = 'library-references-list'; referenceList.tabIndex = 0; referenceList.setAttribute('aria-label', '引用来源');
  var referenceTruncated = document.createElement('p'); referenceTruncated.id = 'library-references-truncated'; referenceTruncated.className = 'hint'; referenceTruncated.hidden = true;
  referenceTruncated.textContent = '引用较多或名称较长，当前仅显示有限详情（最多 32 条）。处理后可刷新引用。';
  var referenceNote = document.createElement('p'); referenceNote.className = 'hint library-reference-note';
  referenceNote.textContent = '此处仅查看引用。请在对应来源中处理后刷新；删除时会重新检查引用，查询为空也不会自动删除。';
  references.append(referenceHeading, referenceStatus, referenceSkeleton, referenceList, referenceTruncated, referenceNote);
  $('library-message').after(references);
  function invalidateReferences() {
    ++referenceEpoch; referenceTarget = null; referenceLoading = false;
    references.hidden = true; references.setAttribute('aria-busy', 'false'); referenceList.replaceChildren();
    referenceRefresh.disabled = false; referenceSkeleton.hidden = true; referenceTruncated.hidden = true;
  }
  function referenceContext(work, version) {
    return { workKey: work.workKey, packageHash: version && version.packageHash, title: work.title, version: version && version.version };
  }
  function beginReferences(target) {
    ++referenceEpoch; referenceTarget = target; referenceLoading = false;
    referenceTitle.textContent = '引用详情 · “' + target.title + '”' + (target.packageHash ? ' · 版本 ' + target.version : ' · 全部版本');
    referenceList.replaceChildren(); referenceTruncated.hidden = true; referenceSkeleton.hidden = true;
    referenceStatus.classList.remove('error'); referenceRefresh.disabled = false;
    references.setAttribute('aria-busy', 'false');
    return referenceEpoch;
  }
  function currentReference(epoch, target) {
    return !pageLeaving && epoch === referenceEpoch && referenceTarget === target;
  }
  function showReferences() {
    references.hidden = false;
    referenceTitle.focus({ preventScroll: true });
    references.scrollIntoView({ block: 'nearest' });
  }
  function renderReferences(report, blocked) {
    referenceList.replaceChildren();
    report.references.slice(0, 32).forEach(function (reference) {
      var row = document.createElement('li'), kind = document.createElement('span'), label = document.createElement('strong'), detail = document.createElement('p');
      kind.className = 'library-reference-kind'; kind.textContent = referenceKinds[reference.kind] || '其他引用';
      label.textContent = typeof reference.label === 'string' ? reference.label : '未命名来源';
      detail.textContent = typeof reference.detail === 'string' ? reference.detail : '';
      row.append(kind, label, detail); referenceList.appendChild(row);
    });
    referenceTruncated.hidden = !report.truncated && report.references.length <= 32;
    referenceStatus.classList.remove('error');
    referenceStatus.textContent = blocked ? '删除未完成：以下来源仍在引用此内容。'
      : report.references.length ? '以下来源仍在引用此内容。' : report.truncated ? '引用详情未完整显示，请处理相关来源后刷新。' : '当前未发现引用。删除时仍会重新检查。';
  }
  function validReferenceReport(report) {
    return report && Array.isArray(report.references) && report.references.every(function (reference) { return reference && typeof reference === 'object'; });
  }
  async function queryReferences(target) {
    if (pageLeaving) return;
    var epoch = beginReferences(target), payload = { workKey: target.workKey };
    if (target.packageHash) payload.packageHash = target.packageHash;
    referenceLoading = true; referenceRefresh.disabled = true; referenceSkeleton.hidden = false;
    referenceStatus.textContent = '正在读取引用…'; references.setAttribute('aria-busy', 'true'); showReferences();
    try {
      var receipt = await requestManagement('wallpaper.library.references', payload);
      if (!currentReference(epoch, target)) return;
      if (!validReferenceReport(receipt.result)) throw new Error('未能读取引用详情，请刷新重试。');
      renderReferences(receipt.result, false);
    } catch (error) {
      if (!currentReference(epoch, target)) return;
      referenceStatus.classList.add('error');
      referenceStatus.textContent = ['unknown_command', 'unsupported_command'].includes(error.code) ? '当前桌面宿主不支持查询引用，请更新后重试。' : '读取引用失败：' + (error.message || '请刷新重试。');
    } finally {
      if (currentReference(epoch, target)) { referenceLoading = false; referenceRefresh.disabled = false; referenceSkeleton.hidden = true; references.setAttribute('aria-busy', 'false'); }
    }
  }
  referenceRefresh.addEventListener('click', function () { if (referenceTarget && !referenceLoading) queryReferences(referenceTarget); });
  referenceClose.addEventListener('click', invalidateReferences);
  function referenceButton(work, version) {
    var button = document.createElement('button'); button.type = 'button'; button.className = 'library-view-references'; button.textContent = '查看引用';
    button.setAttribute('aria-label', '查看“' + work.title + '”' + (version ? '版本 ' + version.version : '全部版本') + '的引用');
    button.addEventListener('click', function () { queryReferences(referenceContext(work, version)); });
    return button;
  }
  function syncDeleteControls() {
    document.querySelectorAll('.library-delete').forEach(function (button) {
      button.dataset.libraryDeletePending = String(deleteInFlight);
      button.disabled = deleteInFlight || !window.hertzWallpaperSettings.canChooseLibraryVersion();
    });
  }
  var retryExport = document.createElement('button'); retryExport.id = 'library-export-retry'; retryExport.type = 'button'; retryExport.textContent = '重新核验导出'; retryExport.hidden = true;
  $('library-cancel').after(retryExport);
  retryExport.addEventListener('click', async function () {
    if (!recoveryJob) return;
    retryExport.disabled = true;
    try { showLibraryJob((await requestManagement('wallpaper.export.recover', { jobId: recoveryJob })).result); }
    catch (error) { libraryMessage(error.message, true); }
    finally { retryExport.disabled = false; }
  });
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
    if (error.code !== 'asset_in_use') { libraryMessage(error.message, true); return; }
    libraryMessage('删除未完成：此内容仍被引用，请查看下方详情。', true);
    var report = error.receipt && error.receipt.error && error.receipt.error.details;
    if (validReferenceReport(report)) renderReferences(report, true);
    else {
      referenceStatus.classList.add('error');
      referenceStatus.textContent = '此内容仍被引用，当前宿主未返回引用详情。可点击“刷新引用”查询，或在对应来源中切换壁纸、处理草稿和预览后再试。';
    }
    showReferences();
  }
  async function deleteLibraryTarget(work, version, button) {
    if (pageLeaving || deleteInFlight || !button.isConnected || !window.hertzWallpaperSettings.canChooseLibraryVersion()) return;
    var prompt = version ? '删除“' + work.title + '”的版本 ' + version.version + '？此操作不可撤销。'
      : '删除作品“' + work.title + '”及其全部版本？此操作不可撤销。';
    if (!confirm(prompt)) return;
    deleteInFlight = true; syncDeleteControls();
    var target = referenceContext(work, version), epoch = beginReferences(target);
    references.hidden = true;
    var command = version ? 'wallpaper.library.deleteVersion' : 'wallpaper.library.deleteWork', payload = { workKey: work.workKey };
    if (version) { payload.version = version.version; payload.packageHash = version.packageHash; }
    try {
      await requestManagement(command, payload);
      if (pageLeaving) return;
      if (currentReference(epoch, target)) libraryMessage(version ? '已删除“' + work.title + '”的版本 ' + version.version + '。' : '已删除作品“' + work.title + '”。', false);
      await refreshLibrary(false);
    } catch (error) { if (currentReference(epoch, target)) libraryDeleteMessage(error); }
    finally { deleteInFlight = false; syncDeleteControls(); }
  }
  function renderLibraryWorks(works, append) {
    // A read begun while the list was loading also belongs to the old list context.
    invalidateReferences();
    var list = $('library-works');
    if (!append) { forgetPosters(list); list.replaceChildren(); }
    works.forEach(function (work) {
      var item = document.createElement('li'), title = document.createElement('strong');
      var meta = document.createElement('span'), button = document.createElement('button'), detail = document.createElement('div');
      title.textContent = work.title;
      meta.className = 'small'; meta.textContent = ({ image: '图片', video: '视频', scene: '场景', builtin: '内置场景' })[work.kind] || '壁纸';
      button.textContent = '查看版本'; detail.className = 'hint library-versions'; detail.hidden = true;
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
            if (version.state === 'installed' && ['image','video','builtin'].includes(work.kind)) {
              var addToPlaylist = document.createElement('button'); addToPlaylist.type = 'button'; addToPlaylist.textContent = '加入轮播';
              addToPlaylist.addEventListener('click', function () {
                window.dispatchEvent(new CustomEvent('wallpaper-playlist-add', { detail: { work: work, version: version } }));
              });
              row.appendChild(addToPlaylist);
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
            if (version.state === 'installed') {
              if (work.kind === 'builtin') {
                var edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '编辑此版本';
                edit.addEventListener('click', async function () {
                  edit.disabled = true;
                  try { await window.hertzWallpaperWork.openVersion(work, version); }
                  catch (error) { libraryMessage(error.message, true); }
                  finally { edit.disabled = false; }
                });
                row.appendChild(edit);
              }
              var exportButton = document.createElement('button'); exportButton.type = 'button'; exportButton.textContent = '导出此版本';
              exportButton.addEventListener('click', async function () {
                if (libraryBusy || libraryJob || importRequest) return;
                libraryBusy = true; libraryControls(); exportButton.disabled = true;
                try {
                  var selected = await requestManagement('wallpaper.export.pick', { packageHash: version.packageHash });
                  if (selected.result.cancelled) return;
                  operationCommand = 'wallpaper.export.begin'; importRequest = crypto.randomUUID();
                  var accepted = await requestManagement(operationCommand, { packageHash: version.packageHash, outputToken: selected.result.outputToken }, importRequest);
                  libraryJob = accepted.jobId || accepted.result.jobId; importRequest = null; cancelRequested = false;
                  await pollLibraryJob();
                } catch (error) {
                  if (error.code !== 'receipt_timeout' && error.receipt) importRequest = null;
                  libraryMessage(error.message, true);
                } finally { libraryBusy = false; exportButton.disabled = false; libraryControls(); if (importRequest) recoverImport(); }
              });
              row.appendChild(exportButton);
            }
            var removeVersion = document.createElement('button'); removeVersion.type = 'button'; removeVersion.textContent = '删除版本'; removeVersion.className = 'library-delete';
            removeVersion.addEventListener('click', function () { deleteLibraryTarget(work, version, removeVersion); });
            row.append(referenceButton(work, version), removeVersion);
            detail.appendChild(row);
          });
          if (!detail.children.length) detail.textContent = '暂无可用版本';
          detail.hidden = false; button.textContent = '收起版本';
        } catch (error) { libraryMessage(error.message, true); }
        finally { button.disabled = false; syncDeleteControls(); }
      });
      var removeWork = document.createElement('button'); removeWork.type = 'button'; removeWork.textContent = '删除作品'; removeWork.className = 'library-delete';
      removeWork.addEventListener('click', function () { deleteLibraryTarget(work, null, removeWork); });
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
      var heading = document.createElement('div'); heading.className = 'library-work-heading';
      var actions = document.createElement('div'); actions.className = 'library-work-actions'; actions.append(favorite, referenceButton(work), removeWork);
      heading.append(title, meta, actions);
      item.append(heading, button, detail); list.appendChild(item);
    });
    $('library-empty').hidden = list.children.length > 0;
    $('library-empty').textContent = favoritesOnly ? '还没有收藏的作品。' : '作品库还是空的。导入后会显示在这里。';
    syncDeleteControls();
  }
  async function refreshLibrary(append) {
    if (pageLeaving) return;
    if (libraryLoading) {
      if (!append) { libraryRefreshQueued = true; invalidateReferences(); }
      return;
    }
    invalidateReferences();
    libraryLoading = true; libraryControls();
    if (!append) window.hertzWallpaperSettings.invalidatePosters();
    try {
      var receipt = await requestManagement('wallpaper.library.list', { limit: 20, cursor: append ? libraryCursor : null, favoritesOnly: favoritesOnly });
      renderLibraryWorks(receipt.result.works, !!append);
      libraryCursor = receipt.result.nextCursor;
      $('library-more').hidden = !libraryCursor;
    } catch (error) { libraryMessage(error.message, true); }
    finally {
      libraryLoading = false; libraryControls();
      if (libraryRefreshQueued && !pageLeaving) { libraryRefreshQueued = false; refreshLibrary(false); }
    }
  }
  function showLibraryJob(job) {
    clearTimeout(libraryPoll);
    recoveryJob = job.kind === 'export' && job.error && job.error.includes('export_recovery_pending') ? job.jobId : null;
    retryExport.hidden = !recoveryJob;
    if (recoveryJob) {
      libraryJob = null; cancelRequested = false;
      libraryMessage('导出结果尚待核验。请关闭占用目标文件的程序，再点击“重新核验导出”。', true);
      libraryControls(); return;
    }
    var terminal = ['done', 'failed', 'cancelled'].includes(job.state);
    var labels = { queued: '等待导入', preparing: '正在检查并准备壁纸', publishing: '正在保存壁纸', done: '已导入本地作品', failed: '导入失败', cancelled: '已取消导入' };
    if (job.kind === 'export') labels = { queued: '等待导出', preparing: '正在导出原包', publishing: '正在完成文件写入', done: '已导出壁纸包', failed: '导出失败', cancelled: '已取消导出' };
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
      var receipt = await requestManagement('wallpaper.operations.get', { requestId: importRequest, command: operationCommand });
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
      var id = crypto.randomUUID(); importRequest = id; operationCommand = 'wallpaper.import.begin';
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
  window.addEventListener('wallpaper-library-changed', function () { refreshLibrary(false); });
  window.addEventListener('wallpaper-settings-controls-updated', syncDeleteControls);
  window.addEventListener('wallpaper-library-context-changed', invalidateReferences);
  window.addEventListener('pagehide', function () { pageLeaving = true; invalidateReferences(); clearTimeout(libraryPoll); posterObserver.disconnect(); });
})();
