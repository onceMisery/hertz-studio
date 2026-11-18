// SPDX-License-Identifier: MIT
// Native management is the only network, trust, credential and update owner.
(function () {
  'use strict';
  const panel = document.getElementById('panel-community');
  const settings = window.hertzWallpaperSettings;
  if (!panel || !settings || !window.hertzWallpaperCommunityView) return;
  const el = id => document.getElementById(id);
  const storageKey = 'hertz.wallpaper.community.pending.v1';
  const mutations = new Set(['confirmRoot', 'subscribe', 'policy', 'download', 'apply', 'login', 'logout']);
  let snapshot = { sources: [], subscriptions: [], updates: [], accounts: [] }, selectedSource = '';
  let active = null, uncertain = restore(), rootTicket = null, reviewTicket = null;
  let scopeKey = '', epoch = 0, browseOffset = null, refreshFlight = null, pollTimer = 0, expiryTimer = 0, invalidateTimer = 0, disposed = false;
  function context() { return settings.currentCommunityContext(); }
  function scope() {
    const current = context();
    return JSON.stringify([current.groupId, current.revision, current.profile, current.selection, current.presentation, current.dirty, current.pending]);
  }
  function visible() { return !panel.hidden && !document.hidden && !disposed; }
  function native() { return !!(window.ipc && typeof window.ipc.postMessage === 'function'); }
  function restore() {
    try {
      const record = JSON.parse(sessionStorage.getItem(storageKey));
      if (record && typeof record.requestId === 'string' && /^[0-9a-f-]{36}$/.test(record.requestId)
        && typeof record.command === 'string' && record.command.startsWith('wallpaper.community.')) return record;
    } catch (_) {}
    return null;
  }
  function savePending(record) {
    try {
      if (!record) sessionStorage.removeItem(storageKey);
      else sessionStorage.setItem(storageKey, JSON.stringify({ requestId: record.requestId, command: record.command, sourceId: record.sourceId,
        operationId: record.operationId, remoteWorkId: record.payload && record.payload.remoteWorkId, subscriptionId: record.payload && record.payload.subscriptionId,
        subscriptionRevision: record.payload && record.payload.subscriptionRevision, policy: record.payload && record.payload.policy, enabled: record.payload && record.payload.enabled,
        fingerprint: record.payload && record.payload.fingerprint, origin: record.origin, groupId: record.groupId }));
    } catch (_) {}
  }
  const view = window.hertzWallpaperCommunityView.create(panel, {
    subscribe: work => run('subscribe', { sourceId: selectedSource, remoteWorkId: work.toLowerCase() }),
    download: sub => run('download', { subscriptionId: sub.subscriptionId, targetGroupId: context().groupId }, { target: true }),
    policy: (sub, revision, policy, enabled) => run('policy', { subscriptionId: sub.subscriptionId, subscriptionRevision: revision, policy, enabled }),
    review: (update, rollback) => run('review', { operationId: update.operationId, targetGroupId: context().groupId, rollback }, { target: true, operationId: update.operationId }),
    queryUpdate,
    cancelDownload: async update => {
      try {
        await settings.requestManagement('wallpaper.jobs.cancel', { jobId: update.jobId });
        view.message('已请求取消下载，等待原任务退出。'); await queryUpdate(update);
      } catch (error) { view.message(error.message, true); }
    }
  });
  function controls() {
    el('community-root-form').querySelector('button[type=submit]').dataset.blocked = String(!rootTicket);
    el('community-apply').dataset.blocked = String(!reviewTicket);
    view.uncertain(uncertain);
    view.controls({ native: native(), busy: !!active, uncertain: !!uncertain,
      login: !!(active && active.command === 'wallpaper.community.login' || uncertain && uncertain.command === 'wallpaper.community.login') });
  }
  function render() {
    if (visible()) view.render(snapshot, selectedSource, context());
    controls();
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!visible() || !native()) return;
    const pending = snapshot.updates.some(update => ['queued', 'downloading', 'apply_requested'].includes(update.state));
    pollTimer = setTimeout(() => refresh().finally(schedulePoll), pending || uncertain || active ? 2000 : 30000);
  }
  function acceptStatus(value) {
    if (!value || !['sources', 'accounts', 'subscriptions', 'updates'].every(key => Array.isArray(value[key]))) return;
    snapshot = value;
    if (!snapshot.sources.some(item => item.profile.sourceId === selectedSource)) selectedSource = snapshot.sources[0] ? snapshot.sources[0].profile.sourceId : '';
    resolveProjection(); render(); schedulePoll();
  }
  async function refresh() {
    if (!native() || disposed) return;
    if (refreshFlight) return refreshFlight;
    refreshFlight = settings.requestManagement('wallpaper.community.status', {}).then(receipt => { acceptStatus(receipt.result); return receipt.result; })
      .catch(error => { if (visible()) view.message('本机社区状态未读取完成：' + error.message, true); })
      .finally(() => { refreshFlight = null; });
    return refreshFlight;
  }
  function retireUncertain(message) {
    uncertain = null; savePending(null); if (message) view.message(message); controls();
  }
  function resolveProjection() {
    if (!uncertain) return;
    const command = uncertain.command.split('.').pop();
    const sub = snapshot.subscriptions.find(item => item.subscriptionId === uncertain.subscriptionId);
    const account = snapshot.accounts.find(item => item.sourceId === uncertain.sourceId);
    if (command === 'confirmRoot' && snapshot.sources.some(item => item.profile.origin === uncertain.origin && item.profile.rootFingerprint === uncertain.fingerprint)) retireUncertain('社区根身份已在本机保存。');
    else if (command === 'subscribe' && snapshot.subscriptions.some(item => item.sourceId === uncertain.sourceId && item.remoteWorkId === uncertain.remoteWorkId)) retireUncertain('已读取到本机订阅记录。');
    else if (command === 'policy' && sub && sub.revision > uncertain.subscriptionRevision) retireUncertain('已重新读取订阅策略，当前保存结果显示在订阅中。');
    else if (command === 'login' && account && account.expiresAt > Date.now() / 1000) retireUncertain('已读取到当前社区的有效登录。');
    else if (command === 'logout' && !account) retireUncertain('本机已退出此来源的账号。');
    else if (command === 'download' && snapshot.updates.some(item => item.requestId === uncertain.requestId)) retireUncertain('下载已登记，后续状态见原任务记录。');
    else if (command === 'apply') {
      const update = snapshot.updates.find(item => item.operationId === uncertain.operationId && item.applyRequestId === uncertain.requestId);
      if (update && ['applied', 'failed'].includes(update.state)) retireUncertain(update.state === 'applied' ? '原配置提交已确认。实际画面见壁纸页。' : '原应用操作已结束，候选版本仍保留在库中。');
    }
  }
  function dropTickets() { rootTicket = null; reviewTicket = null; view.dismissRoot(); view.dismissReview(); clearTimeout(expiryTimer); controls(); }
  function expireTickets() {
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => { dropTickets(); if (visible()) view.message('本次确认已过期。请重新读取来源或查看版本差异。', true); }, 300000);
  }
  async function consume(record, receipt) {
    if (!receipt.ok) {
      const error = new Error(receipt.error && receipt.error.message || '社区操作未完成。');
      error.code = receipt.error && receipt.error.code; throw error;
    }
    const result = receipt.result || {}, command = record.command.split('.').pop();
    if (command === 'discover') {
      if (record.epoch !== epoch || record.origin !== el('community-origin').value.trim()) { view.message('来源输入或目标已变化，请重新读取来源。', true); return; }
      rootTicket = result; view.rootDraft(result); expireTickets(); view.message('已读取社区身份，请核对完整根指纹。');
    } else if (command === 'review') {
      if (record.epoch !== epoch || record.scope !== scope()) { view.message('显示组或草稿已变化，请重新查看版本差异。', true); return; }
      reviewTicket = { ...result, scope: record.scope, operationId: record.operationId }; view.review(result); expireTickets(); view.message('候选已安装。核对差异后可明确应用。');
    } else if (command === 'browse') {
      if (record.sourceId !== selectedSource || record.epoch !== epoch) return;
      browseOffset = result.nextOffset; view.renderWorks(result.items || [], record.sourceId, result.offset > 0, browseOffset);
      view.message('已读取该来源的公开作品。');
    } else if (command === 'sync') {
      acceptStatus(result); view.message('安全同步已完成；新鲜度与最后同步时间已更新。');
    } else if (command === 'confirmRoot') {
      selectedSource = result.sourceId; dropTickets(); view.message('已保存此社区根身份。');
    } else if (command === 'apply') {
      view.dismissReview(); reviewTicket = null;
      view.message(result.saved === true || result.state === 'committed' ? '配置提交已确认。实际桌面状态可在壁纸页查看。' : '原配置提交仍需核对，请查询原操作。', result.state !== 'committed' && result.saved !== true);
    } else {
      const messages = { subscribe: '订阅已保存，默认下载后提示应用。', policy: '更新策略已保存。', download: '下载已登记，后续状态见原任务记录。', login: '登录已完成。', logout: '已退出此社区账号。', me: '账号状态已核对。' };
      if (messages[command]) view.message(messages[command]);
    }
    if (uncertain && uncertain.requestId === record.requestId) uncertain = null;
    if (mutations.has(command)) savePending(null);
    if (!['browse', 'review', 'discover'].includes(command)) await refresh();
    render(); return result;
  }
  async function run(command, payload, options = {}) {
    if (disposed || !native()) { view.message('社区操作需要原生桌面设置窗口。', true); return; }
    if (active || uncertain) { view.message(uncertain ? '请先查询原操作的结果。' : '请等待当前社区操作完成。', true); return; }
    const current = context();
    if (options.target && (!current.ready || !current.groupId || current.pending)) { view.message('请先完成设置保存或位置调整，并选择一个已保存的显示组。', true); return; }
    const record = { requestId: crypto.randomUUID(), command: 'wallpaper.community.' + command, payload,
      sourceId: payload.sourceId || selectedSource, operationId: options.operationId || payload.operationId,
      groupId: current.groupId, scope: scope(), epoch, origin: options.origin || (rootTicket && rootTicket.profile.origin) };
    active = record; if (mutations.has(command)) savePending(record); controls();
    try {
      const receipt = await settings.requestManagement(record.command, payload, record.requestId, options.target ? current.revision : undefined);
      return await consume(record, receipt);
    } catch (error) {
      if (['receipt_timeout', 'operation_pending', 'journal_unavailable'].includes(error.code) && mutations.has(command)) {
        uncertain = { ...record, subscriptionId: payload.subscriptionId, remoteWorkId: payload.remoteWorkId,
          subscriptionRevision: payload.subscriptionRevision, fingerprint: payload.fingerprint };
        savePending(record); view.message('操作结果尚未确认，请查询原操作。', true);
      } else {
        if (mutations.has(command)) savePending(null);
        view.message(error.code === 'cancelled' ? '社区登录或操作已取消。' : error.message, error.code !== 'cancelled');
        if (command === 'apply' || error.code === 'confirmation_expired') { reviewTicket = null; view.dismissReview(); }
      }
    } finally { if (active === record) active = null; controls(); schedulePoll(); }
  }
  async function queryUpdate(update) {
    try {
      const receipt = await settings.requestManagement('wallpaper.community.update', { operationId: update.operationId });
      const current = receipt.result;
      snapshot.updates = [current, ...snapshot.updates.filter(item => item.operationId !== current.operationId)].slice(0, 100);
      if (current.applyRequestId) {
        const proof = await settings.requestManagement('wallpaper.operations.get', { requestId: current.applyRequestId });
        view.message(proof.result.saved === true ? '原配置提交已确认，配置版本 ' + proof.result.configRevision + '。实际画面见壁纸页。' : '原配置操作尚未确认，更新记录保持等待核对。', proof.result.saved !== true);
      } else {
        const job = await settings.requestManagement('wallpaper.jobs.get', { jobId: current.jobId });
        view.message('原下载任务：' + (job.result.state || '等待核对') + '。版本安装与应用结果见记录。');
      }
      await refresh(); resolveProjection(); render(); return current;
    } catch (error) { view.message('原操作查询：' + error.message, true); await refresh(); }
  }
  async function recover() {
    const record = uncertain; if (!record) return;
    const command = record.command.split('.').pop();
    if (command === 'download' || command === 'apply') {
      await queryUpdate({ operationId: record.operationId || record.requestId });
    } else await refresh();
    if (uncertain === record) view.message('尚未取得原操作的最终事实。可继续查询，当前不会重新派发这次操作。', true);
  }
  function acceptReceipt(receipt) {
    const record = uncertain;
    if (!record || record.requestId !== receipt.requestId) return;
    if (receipt.ok && receipt.result && receipt.result.loginPending) return;
    consume(record, receipt).catch(error => { retireUncertain(); view.message(error.message, true); }).finally(() => { controls(); schedulePoll(); });
  }
  function loginPending(receipt) {
    if (active && active.requestId === receipt.requestId) view.message('系统浏览器已打开。请在五分钟内完成登录；也可取消本次登录。');
  }
  function invalidateContext() {
    const currentKey = scope();
    if (scopeKey === currentKey) { render(); return; }
    scopeKey = currentKey; ++epoch; reviewTicket = null; view.dismissReview(); render();
    clearTimeout(invalidateTimer);
    if (!native() || disposed) return;
    const current = context();
    invalidateTimer = setTimeout(() => {
      settings.requestManagement('wallpaper.community.invalidate', { editing: current.dirty || current.pending }).catch(() => {});
    }, 0);
  }
  el('community-add-form').addEventListener('submit', event => {
    event.preventDefault(); const origin = el('community-origin').value.trim();
    try { const url = new URL(origin); if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(); }
    catch (_) { view.originError('请填写仅包含 HTTPS 协议、主机和可选端口的社区来源地址。'); return; }
    dropTickets(); run('discover', { origin }, { origin });
  });
  el('community-origin').addEventListener('input', () => { el('community-origin').setCustomValidity(''); el('community-origin').removeAttribute('aria-invalid'); el('community-origin-error').textContent = ''; rootTicket = null; view.dismissRoot(); controls(); });
  el('community-root-input').addEventListener('input', () => { el('community-root-input').setCustomValidity(''); el('community-root-input').removeAttribute('aria-invalid'); el('community-root-error').textContent = ''; });
  el('community-root-form').addEventListener('submit', event => {
    event.preventDefault(); if (!rootTicket) return;
    const fingerprint = el('community-root-input').value.toLowerCase();
    if (fingerprint !== rootTicket.fingerprint) { view.rootError('完整指纹与本次来源不一致，请重新核对全部 64 位字符。'); return; }
    run('confirmRoot', { ticket: rootTicket.ticket, fingerprint });
  });
  el('community-root-cancel').addEventListener('click', () => { rootTicket = null; view.dismissRoot(); controls(); });
  el('community-source').addEventListener('change', event => { selectedSource = event.target.value; ++epoch; browseOffset = null; el('community-allow-refresh').checked=false; dropTickets(); view.clearWorks(); render(); });
  el('community-target').addEventListener('change', event => { settings.chooseGroup(event.target.value); invalidateContext(); });
  el('community-sync').addEventListener('click', () => run('sync', { sourceId: selectedSource }));
  el('community-browse').addEventListener('click', () => run('browse', { sourceId: selectedSource, offset: 0 }));
  el('community-browse-more').addEventListener('click', () => { if (browseOffset != null) run('browse', { sourceId: selectedSource, offset: browseOffset }); });
  el('community-subscribe-form').addEventListener('submit', event => { event.preventDefault(); run('subscribe', { sourceId: selectedSource, remoteWorkId: el('community-work-id').value.toLowerCase() }); });
  el('community-login').addEventListener('click', () => run('login', { sourceId: selectedSource,allowRefresh:el('community-allow-refresh').checked }));
  el('community-logout').addEventListener('click', () => run('logout', { sourceId: selectedSource }));
  el('community-me').addEventListener('click', () => run('me', { sourceId: selectedSource }));
  el('community-login-cancel').addEventListener('click', async () => {
    try { await settings.requestManagement('wallpaper.community.cancelLogin', {}); view.message('已请求取消登录，等待原登录操作结束。'); }
    catch (error) { view.message(error.message, true); }
  });
  el('community-apply-form').addEventListener('submit', event => {
    event.preventDefault(); if (!reviewTicket) return;
    if (reviewTicket.scope !== scope()) { reviewTicket = null; view.dismissReview(); view.message('显示组、配置或草稿已变化，请重新查看差异。', true); controls(); return; }
    run('apply', { ticket: reviewTicket.ticket }, { target: true, operationId: reviewTicket.operationId });
  });
  el('community-review-cancel').addEventListener('click', () => { reviewTicket = null; view.dismissReview(); controls(); });
  el('community-refresh').addEventListener('click', () => refresh());
  el('community-recover').addEventListener('click', recover);
  el('community-show-wallpaper').addEventListener('click', () => settings.setTab('wallpaper'));
  ['wallpaper-ai-context', 'wallpaper-ai-invalidated', 'wallpaper-settings-controls-updated', 'wallpaper-layout-invalidated'].forEach(event => window.addEventListener(event, invalidateContext));
  const observer = new MutationObserver(() => { if (visible()) { render(); refresh().finally(schedulePoll); } else { clearTimeout(pollTimer); } });
  observer.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', () => { if (visible()) refresh().finally(schedulePoll); else clearTimeout(pollTimer); });
  window.addEventListener('pagehide', () => { disposed = true; clearTimeout(pollTimer); clearTimeout(expiryTimer); clearTimeout(invalidateTimer); observer.disconnect(); });
  window.hertzWallpaperCommunity = { acceptStatus, acceptReceipt, loginPending };
  invalidateContext(); render();
  if (!native()) view.message('社区操作需要原生桌面设置窗口。', true);
})();
