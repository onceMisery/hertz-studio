// SPDX-License-Identifier: MIT
(function () {
  'use strict';
  const panel = document.getElementById('wallpaper-ai');
  if (!panel || !window.hertzWallpaperSettings) return;
  const settings = window.hertzWallpaperSettings;
  const el = id => document.getElementById(id);
  let target = null, contextKey = '', epoch = 0, busy = false, operation = null;
  const phases = { accepted: '已受理，正在准备确切版本。', saved: '已保存，等待桌面首次呈现。', running: '已保存，正在运行。', paused: '已保存，当前暂停。', failed: '操作未完成，请查看具体原因。' };
  function message(text, error) { el('ai-message').textContent = text; el('ai-message').classList.toggle('error', !!error); }
  function controls() { el('ai-query').disabled = busy || !target; el('ai-brief').disabled = busy || !target; panel.querySelectorAll('[data-ai-action]').forEach(button => { button.disabled = busy || !target; }); }
  function clear() { el('ai-results').replaceChildren(); target = null; controls(); }
  function context() { return settings.currentAiContext(); }
  async function readTarget() {
    if (!panel.open || document.hidden) return;
    const current = context(), key = JSON.stringify([current.groupId, current.revision, current.profile]);
    if (key === contextKey && target) return;
    contextKey = key; const currentEpoch = ++epoch; clear();
    el('ai-target').textContent = '正在读取已保存目标…';
    if (!current.groupId) { el('ai-target').textContent = '没有已选定目标组'; message('先建立并保存一个显示组，再使用离线推荐。'); return; }
    try {
      const receipt = await settings.requestManagement('wallpaper.ai.target', { groupId: current.groupId });
      if (currentEpoch !== epoch || !panel.open) return;
      target = receipt.result;
      const members = new Map();
      (target.members || []).forEach(item => (item.members || []).forEach(member => members.set(member.displayId, member.name)));
      el('ai-target').textContent = '已保存目标：' + target.groupId + ' · ' + [...members.values()].join('、');
      message('只查询已安装且无需新增权限的图片、视频和内置作品。完整的“切换到作品名”会直接受理；重名或多版本需选择确切的一项。组合与网页作品尚未获得离线切换资格。'); controls();
    } catch (error) { if (currentEpoch !== epoch) return; message(error.message, true); el('ai-target').textContent = '当前目标不可用'; }
  }
  function reason(item) {
    const text = { installed: '已安装', exactTitle: '名称精确匹配', title: '名称匹配', tag: '标签匹配', theme: '主题匹配', lowMotion: '低运动内容' };
    return (item.reasons || []).map(reason => (text[reason.kind] || reason.kind) + (reason.value ? '：' + reason.value : '')).join(' · ');
  }
  function render(result) {
    el('ai-results').replaceChildren();
    (result.actions || []).forEach(action => {
      const row = document.createElement('li'), title = document.createElement('strong'), why = document.createElement('p'), button = document.createElement('button');
      title.textContent = action.title + (action.title.includes(' · v') ? '' : ' · v' + action.version);
      why.textContent = reason(action); button.textContent = '切换此版本'; button.dataset.aiAction = action.actionId;
      button.setAttribute('aria-label', '将 ' + action.title + ' v' + action.version + ' 切换到 ' + action.targetGroupId);
      button.addEventListener('click', () => run('wallpaper.ai.confirm', { actionId: action.actionId })); row.append(title, why, button); el('ai-results').append(row);
    });
    message(result.actions && result.actions.length ? result.message : '没有符合当前目标、权限与预算的已安装作品。可在“本地作品”导入，或调整已保存目标。');
  }
  async function recover(requestId, command) {
    try {
      const receipt = await settings.requestManagement('wallpaper.operations.get', { requestId, command });
      if (receipt.result && receipt.result.saved === true) applyProgress({ requestId, phase: 'saved', saved: true });
      else message('原操作尚未保存。请保留请求编号查询：' + requestId, true);
    } catch (error) { message(error.message + ' 原请求：' + requestId, true); }
  }
  async function run(command, payload) {
    if (busy || !target) return;
    const currentEpoch = epoch, requestId = crypto.randomUUID(); busy = true; operation = { requestId, groupId: target.groupId, phase: 'querying' };
    el('ai-loading').hidden = false; controls(); message(command === 'wallpaper.ai.confirm' ? '正在核对确切版本与原生目标…' : '正在查询本地目录…');
    try {
      const receipt = await settings.requestManagement(command, payload, requestId, target.configRevision);
      if (receipt.ai) applyProgress(receipt.ai);
      else if (receipt.result && receipt.result.saved === true) applyProgress({ requestId, phase: 'saved', saved: true });
      else if (currentEpoch === epoch) render(receipt.result || {});
    } catch (error) {
      if (error.code === 'receipt_timeout' || error.code === 'operation_pending') await recover(requestId, command);
      else message(error.message, true);
    } finally { busy = false; el('ai-loading').hidden = true; controls(); }
  }
  function applyProgress(progress) {
    if (!operation || operation.requestId !== progress.requestId) return;
    operation = Object.assign({}, operation, progress);
    message((phases[progress.phase] || '正在核对原操作。') + (progress.groupId ? ' 目标：' + progress.groupId : ''), progress.phase === 'failed');
  }
  el('ai-query').addEventListener('click', () => run('wallpaper.ai.recommend', { brief: el('ai-brief').value }));
  panel.addEventListener('toggle', () => { if (panel.open) { contextKey = ''; readTarget(); } else { ++epoch; clear(); } });
  window.addEventListener('wallpaper-ai-context', () => {
    const current = context(), key = JSON.stringify([current.groupId, current.revision, current.profile]);
    if (key !== contextKey && panel.open) readTarget();
    if (operation && operation.saved) {
      const runtime = settings.currentRuntime();
      const selection = runtime && runtime.appliedSelection;
      if (runtime && runtime.groupId === operation.groupId && runtime.firstFrameReady && selection && selection.kind === 'package'
        && selection.workKey === operation.workKey && selection.packageHash === operation.packageHash) applyProgress({ requestId: operation.requestId, phase: runtime.visible ? 'running' : 'paused', saved: true });
    }
  });
  window.addEventListener('wallpaper-ai-invalidated', () => {
    ++epoch; clear(); contextKey = ''; message('选择或目标草稿已变化，请重新查询已保存目标。');
    if (window.ipc) settings.requestManagement('wallpaper.ai.invalidate', {}).catch(() => {});
    if (panel.open) readTarget();
  });
  window.addEventListener('pagehide', () => { ++epoch; clear(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && panel.open) readTarget(); });
  window.hertzWallpaperAI = { applyProgress };
})();
