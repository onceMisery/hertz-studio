// SPDX-License-Identifier: MIT
// Current trusted settings document only. No proof, automatic opening or focus.
(function () {
  'use strict';
  const settings = window.hertzWallpaperSettings;
  const offline = document.getElementById('wallpaper-ai'), generation = document.getElementById('wallpaper-generation');
  if (!settings || !offline || !generation) return;
  const workspace = offline.closest('[role="tabpanel"]');
  function node(tag, text) { const element = document.createElement(tag); if (text) element.textContent = text; return element; }
  const region = node('section'); region.className = 'wallpaper-ai external-wallpaper-requests'; region.hidden = true;
  const heading = node('h3', '外部助手申请'); heading.id = 'external-requests-heading';
  const status = node('p', '这里只显示当前授权来源提出的申请。确认前不会生成或切换。'); status.className = 'ai-message'; status.setAttribute('role', 'status');
  const list = node('ul'); list.className = 'external-request-list';
  region.append(heading, status, list); offline.before(region);
  let timer = null, epoch = 0, active = false, busy = false, lastKey = '';
  const states = { pending_confirmation: '等待本机确认', accepted: '已受理', succeeded: '已完成', failed: '未完成', rejected: '已拒绝', cancelled: '已取消', expired: '已到期', interrupted: '已中断' };
  function visible() { return !document.hidden && !workspace.hidden && (offline.open || generation.open); }
  function stop() { clearTimeout(timer); timer = null; }
  function schedule() { stop(); if (active && visible()) timer = setTimeout(refresh, 2100); }
  async function action(command, request, success) {
    if (!active || !visible() || busy) return;
    const current = epoch; busy = true; stop(); region.setAttribute('aria-busy', 'true');
    list.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      const receipt = await settings.requestManagement('wallpaper.ai.external.' + command, { requestId: request.requestId });
      if (current === epoch && visible()) {
        if (success) success(receipt.result);
        status.textContent = command === 'reject' ? '申请已拒绝，没有生成或切换。' : command === 'confirm' ? '原本机切换已受理。' : '请在生成表单中查看报价并确认。';
      }
    } catch (error) { if (current === epoch && visible()) status.textContent = error.message || '申请未完成，请重试原申请。'; }
    finally { busy = false; region.removeAttribute('aria-busy'); lastKey = ''; if (current === epoch && visible()) refresh(); }
  }
  function render(requests) {
    const key = JSON.stringify(requests); if (key === lastKey) return; lastKey = key;
    const focused = document.activeElement?.closest('[data-request-id]');
    const focusId = focused?.dataset.requestId, focusCommand = document.activeElement?.dataset.externalAction;
    list.replaceChildren();
    if (!requests.length) { list.append(node('li', '暂无外部申请。')); return; }
    for (const request of requests) {
      const row = node('li'); row.dataset.requestId = request.requestId;
      const title = node('strong', request.operation === 'generate' ? '生成壁纸申请' : '切换到 ' + request.title + ' · v' + request.version);
      const description = node('p', '来源：' + request.label); description.className = 'hint';
      const state = node('p', (states[request.state] || '状态未知') + ' · 到期 ' + new Date(Number(request.expiresAt) * 1000).toLocaleTimeString()); state.className = 'hint';
      row.append(title, description);
      if (request.operation === 'generate') { const brief = node('p', request.brief); brief.className = 'external-request-brief'; row.append(brief); }
      row.append(state);
      if (request.state === 'pending_confirmation') {
        const tools = node('div'); tools.className = 'ai-toolbar';
        const accept = node('button', request.operation === 'generate' ? '进入生成表单' : '确认这次切换'); accept.type = 'button';
        accept.dataset.externalAction = request.operation === 'generate' ? 'open' : 'confirm'; accept.disabled = busy || !request.confirmable;
        accept.setAttribute('aria-label', accept.textContent + '，来源 ' + request.label);
        accept.addEventListener('click', () => action(accept.dataset.externalAction, request,
          request.operation === 'generate' ? result => window.hertzWallpaperGeneration.openExternal(result) : null));
        const reject = node('button', '拒绝申请'); reject.type = 'button'; reject.dataset.externalAction = 'reject'; reject.disabled = busy;
        reject.setAttribute('aria-label', '拒绝申请，来源 ' + request.label); reject.addEventListener('click', () => action('reject', request));
        tools.append(accept, reject); row.append(tools);
        if (!request.confirmable) row.append(node('p', '原面板、目标或授权已变化，请让助手重新提出申请。'));
      }
      list.append(row);
    }
    if (focusId && focusCommand) {
      const replacement = [...list.querySelectorAll('[data-request-id]')].find(row => row.dataset.requestId === focusId)?.querySelector('[data-external-action="' + focusCommand + '"]');
      if (replacement && !replacement.disabled) replacement.focus();
    }
  }
  async function refresh() {
    if (!active || !visible() || busy) return;
    const current = epoch;
    try {
      const receipt = await settings.requestManagement('wallpaper.ai.external.list', {});
      if (current === epoch && visible()) render(receipt.result.requests || []);
    } catch (error) { if (current === epoch && visible()) status.textContent = error.message || '申请列表暂不可用，请重新打开面板。'; }
    finally { if (current === epoch) schedule(); }
  }
  async function visibility() {
    const current = ++epoch; stop(); active = visible(); region.hidden = !active;
    try {
      if (active) {
        try {
          await settings.requestManagement('wallpaper.ai.target', { groupId: settings.currentAiContext().groupId });
        } catch (error) {
          if (current === epoch && visible()) status.textContent = '生成申请可用。切换目标暂不可用：' + (error.message || '请检查已保存的显示组。');
        }
        if (current !== epoch || !visible()) return;
      }
      const receipt = await settings.requestManagement('wallpaper.ai.external.panel', { visible: active });
      if (current === epoch) { active = !!receipt.result.visible && visible(); if (active) refresh(); }
    } catch (error) { if (current === epoch && active) status.textContent = error.message || '面板登记未完成，请重新打开面板。'; }
  }
  offline.addEventListener('toggle', visibility); generation.addEventListener('toggle', visibility);
  new MutationObserver(visibility).observe(workspace, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', visibility); window.addEventListener('focus', visibility);
  window.addEventListener('wallpaper-ai-context', visibility);
  window.addEventListener('pagehide', () => { ++epoch; active = false; stop(); settings.requestManagement('wallpaper.ai.external.panel', { visible: false }).catch(() => {}); });
})();
