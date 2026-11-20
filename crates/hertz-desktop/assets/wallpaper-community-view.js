// SPDX-License-Identifier: MIT
(function () {
  'use strict';
  const labels = {
    queued: '已登记，等待原下载槽', downloading: '正在下载并校验', installed: '已安装',
    ready: '已安装，等待应用', awaiting_confirmation: '已安装，需要确认差异',
    apply_requested: '正在核对配置提交', applied: '配置提交已确认', failed: '操作未完成', stale: '应用意图已过期'
  };
  const policies = [['prompt', '下载后提示应用'], ['cutpoint', '在轮播切点应用'], ['startup', '在下次启动应用']];
  function node(tag, text, className) {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text == null ? '' : String(text);
    if (className) item.className = className;
    return item;
  }
  function time(seconds) {
    return seconds > 0 ? new Date(seconds * 1000).toLocaleString() : '尚未同步';
  }
  function facts(target, entries) {
    const fragment = document.createDocumentFragment();
    entries.forEach(([label, value, code]) => {
      fragment.append(node('dt', label));
      const cell = node('dd');
      cell.append(node(code ? 'code' : 'span', value == null ? '未提供' : value, code ? 'community-code' : ''));
      fragment.append(cell);
    });
    target.replaceChildren(fragment);
  }
  function button(text, action, mutation, target) {
    const item = node('button', text);
    item.type = 'button';
    if (mutation) item.dataset.communityMutation = '';
    else item.dataset.communityRead = '';
    if (target) item.dataset.communityTarget = '';
    item.addEventListener('click', action);
    return item;
  }
  function permissionText(permissions) {
    const result = [];
    if (permissions && permissions.audioSpectrum) result.push('音频频谱');
    if (permissions && permissions.pointer) result.push('鼠标输入');
    return result.length ? result.join('、') : '没有音频频谱或鼠标输入要求';
  }
  function kind(value) {
    return ({ image: '图片', video: '视频', builtin: '内置场景', composition: '声明式组合', web: '网页内容' })[value] || value || '未提供';
  }
  function license(value) {
    if (!value) return '未提供';
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
  }
  function create(panel, actions) {
    const el = id => document.getElementById(id);
    const subscriptionRows = new Map(), updateRows = new Map(), works = new Map();
    let sourceOptions = '', targetOptions = '', subscriptionLimit = 30;
    let snapshot = { sources: [], subscriptions: [], updates: [], accounts: [] }, selectedSource = '', context = {};
    let controlsState = { busy: false, uncertain: false, native: false, login: false };
    function message(text, error) {
      if (el('community-message').textContent !== text) el('community-message').textContent = text;
      el('community-message').classList.toggle('error', !!error);
    }
    function source() { return snapshot.sources.find(item => item.profile.sourceId === selectedSource); }
    function title(sub) {
      const item = works.get(sub.sourceId + ':' + sub.remoteWorkId);
      return sub.title || (item && item.title) || '已订阅作品';
    }
    function selectOptions(select, choices, value) {
      select.replaceChildren(...choices.map(choice => {
        const option = node('option', choice.name); option.value = choice.id; return option;
      }));
      select.value = value || '';
    }
    function choice(form, id, name, value, label, type) {
      const row = node('div', undefined, 'community-choice'), input = node('input'), text = node('label', label);
      input.id = id; input.name = name; input.type = type; input.value = value; text.htmlFor = id;
      row.append(input, text); form.append(row); return input;
    }
    function newSubscription(sub) {
      const row = node('li'), heading = node('h4'), state = node('p', '', 'hint'), identity = node('code', '', 'community-code');
      const toolbar = node('div', undefined, 'community-actions');
      const download = button('检查并下载版本', () => actions.download(row.latest), true, true);
      toolbar.append(download); row.append(heading, identity, state, toolbar);
      const disclosure = node('details', undefined, 'community-extra'); disclosure.append(node('summary', '更新策略'));
      const form = node('form', undefined, 'community-form community-policy'); form.method = 'post'; form.action = '#panel-community';
      heading.id = 'community-sub-' + sub.subscriptionId; form.setAttribute('aria-labelledby', heading.id);
      const enabled = choice(form, heading.id + '-enabled', 'enabled', 'enabled', '启用此订阅', 'checkbox');
      const set = node('fieldset'); set.append(node('legend', '下载后的应用方式'));
      const radios = policies.map(([value, label]) => choice(set, heading.id + '-' + value, 'policy', value, label, 'radio'));
      form.append(set);
      const note = node('p', '新增权限、转为网页内容或协议变化时，仍需单独确认。', 'hint community-policy-note');
      const buttons = node('div', undefined, 'community-actions'), save = node('button', '保存更新策略'), discard = button('放弃策略修改', reset, false);
      save.type = 'submit'; save.dataset.communityMutation = ''; buttons.append(save, discard); form.append(note, buttons); disclosure.append(form); row.append(disclosure);
      function reset() {
        if (!row.latest) return;
        enabled.checked = row.latest.enabled === 1;
        radios.forEach(input => { input.checked = input.value === row.latest.policy; });
        row.editRevision = row.latest.revision; row.policyDirty = false;
        note.textContent = '新增权限、转为网页内容或协议变化时，仍需单独确认。';
      }
      form.addEventListener('change', () => {
        if (!row.policyDirty) row.editRevision = row.latest.revision;
        row.policyDirty = true; note.textContent = '策略修改尚未保存。';
      });
      form.addEventListener('submit', event => {
        event.preventDefault();
        actions.policy(row.latest, row.editRevision, radios.find(input => input.checked).value, enabled.checked).then(saved => {
          if (saved) { row.latest = saved; reset(); }
        });
      });
      Object.assign(row, { heading, state, identity, download, form, reset, note });
      return row;
    }
    function renderSubscriptions() {
      const list = snapshot.subscriptions.filter(sub => sub.sourceId === selectedSource);
      const visible = list.slice(0, subscriptionLimit), ids = new Set(visible.map(sub => sub.subscriptionId));
      for (const [id, row] of subscriptionRows) {
        if (!snapshot.subscriptions.some(sub => sub.subscriptionId === id)) { row.remove(); subscriptionRows.delete(id); }
        else row.hidden = !ids.has(id);
      }
      visible.forEach(sub => {
        let row = subscriptionRows.get(sub.subscriptionId);
        if (!row) { row = newSubscription(sub); subscriptionRows.set(sub.subscriptionId, row); el('community-subscriptions').append(row); }
        row.latest = sub; row.heading.textContent = title(sub); row.identity.textContent = sub.remoteWorkId;
        row.hidden = false;
        row.state.textContent = (sub.enabled === 1 ? '订阅已启用' : '订阅已暂停') + ' · ' + (policies.find(item => item[0] === sub.policy) || ['', sub.policy])[1]
          + ' · 最后检查：' + time(sub.lastSync) + (sub.lastError ? ' · ' + sub.lastError : '');
        row.download.dataset.blocked = String(sub.enabled !== 1 || snapshot.updates.some(update => update.subscriptionId === sub.subscriptionId && ['queued', 'downloading', 'apply_requested'].includes(update.state)));
        if (!row.policyDirty) row.reset();
        else if (row.editRevision !== sub.revision) row.note.textContent = '订阅已变化。你的策略输入仍保留；可放弃修改后重新选择。';
      });
      el('community-subscriptions-empty').hidden = list.length > 0;
      el('community-subscriptions-more').hidden = visible.length === list.length;
    }
    function newUpdate(update) {
      const row = node('li'), heading = node('h4'), state = node('p', '', 'community-state'), error = node('p', '', 'hint error'), target = node('p', '', 'hint');
      const progress = node('progress', undefined, 'community-record-progress'); progress.setAttribute('aria-label', '正在下载或核对配置');
      const toolbar = node('div', undefined, 'community-actions');
      const review = button('查看差异并应用', () => actions.review(row.latest, false), true, true);
      const rollback = button('回到上一版本', () => actions.review(row.latest, true), true, true);
      const query = button('查询原操作', () => actions.queryUpdate(row.latest), false);
      const cancel = button('取消下载', () => actions.cancelDownload(row.latest), true);
      heading.id = 'community-update-' + update.operationId;
      state.id = heading.id + '-state';
      target.id = heading.id + '-target';
      [review, rollback, query, cancel].forEach(item => item.setAttribute('aria-describedby', heading.id + ' ' + state.id + ' ' + target.id));
      toolbar.append(review, rollback, query, cancel);
      const details = node('details', undefined, 'community-extra'); details.append(node('summary', '版本与操作编号'));
      const info = node('dl', undefined, 'community-facts'); details.append(info);
      row.append(heading, state, target, progress, error, toolbar, details);
      Object.assign(row, { heading, state, target, progress, error, review, rollback, query, cancel, info }); return row;
    }
    function renderUpdate(row, update) {
      const sub = snapshot.subscriptions.find(item => item.subscriptionId === update.subscriptionId);
      row.latest = update; row.heading.textContent = sub ? title(sub) : '版本更新';
      let text = labels[update.state] || update.state;
      const isRollback = update.applyRollback === true;
      if (isRollback) text = ({ apply_requested: '正在核对回滚配置提交', applied: '回滚配置提交已确认', failed: '回滚未完成' })[update.state] || text;
      if (update.state === 'ready' && sub && sub.policy !== 'prompt') text += sub.policy === 'cutpoint' ? '，等候轮播切点' : '，等候下次启动';
      if (update.state === 'applied' && update.applyConfigRevision != null) text += ' · 配置版本 ' + update.applyConfigRevision;
      row.state.textContent = text; row.error.textContent = update.error || ''; row.error.hidden = !update.error;
      let binding = {}; try { binding = JSON.parse(update.bindingJson); } catch (_) {}
      row.target.textContent = '下载时的显示组：' + (binding.groupId || '未提供') + ' · ' + time(update.updatedAt);
      if (update.previousHash && update.rollbackAvailable === false) row.target.textContent += ' · 上一版本不可用或安全检查未通过；请核对版本并同步来源。';
      row.progress.hidden = !['queued', 'downloading', 'apply_requested'].includes(update.state);
      row.review.hidden = !update.candidateHash || update.state === 'applied' && !isRollback;
      row.review.dataset.blocked = String(['queued', 'downloading', 'apply_requested'].includes(update.state));
      row.rollback.hidden = !update.previousHash || !['applied', 'failed', 'ready', 'awaiting_confirmation', 'installed', 'stale'].includes(update.state) || update.state === 'applied' && isRollback;
      row.rollback.dataset.blocked = String(update.rollbackAvailable !== true);
      row.cancel.hidden = !['queued', 'downloading'].includes(update.state);
      const entries = [['候选包 SHA-256', update.candidateHash || '尚未取得候选', true], ['保留的上一包', update.previousHash || '没有上一选择', true], ['更新操作', update.operationId, true], ['下载请求', update.requestId, true], ['下载任务', update.jobId, true]];
      if (update.applyRequestId) entries.push(['配置请求', update.applyRequestId, true]);
      if (update.applyPackageHash) entries.push([isRollback ? '本次回滚包 SHA-256' : '本次应用包 SHA-256', update.applyPackageHash, true]);
      facts(row.info, entries);
    }
    function renderUpdates() {
      const subscriptions = new Set(snapshot.subscriptions.filter(sub => sub.sourceId === selectedSource).map(sub => sub.subscriptionId));
      const items = snapshot.updates.filter(update => subscriptions.has(update.subscriptionId));
      const ids = new Set(items.map(update => update.operationId));
      for (const [id, row] of updateRows) { if (!ids.has(id)) { row.remove(); updateRows.delete(id); } }
      items.forEach(update => {
        let row = updateRows.get(update.operationId);
        if (!row) { row = newUpdate(update); updateRows.set(update.operationId, row); el('community-updates').append(row); }
        renderUpdate(row, update);
      });
      el('community-updates-empty').hidden = items.length > 0;
    }
    function render(next, sourceId, current) {
      snapshot = next; selectedSource = sourceId; context = current;
      const choices = snapshot.sources.map(item => ({ id: item.profile.sourceId, name: item.profile.origin }));
      const signature = JSON.stringify(choices);
      if (sourceOptions !== signature) { sourceOptions = signature; selectOptions(el('community-source'), choices.length ? choices : [{ id: '', name: '尚未添加社区' }], selectedSource); }
      else el('community-source').value = selectedSource;
      const groupChoices = context.groups || [], groupSignature = JSON.stringify(groupChoices);
      if (targetOptions !== groupSignature) { targetOptions = groupSignature; selectOptions(el('community-target'), groupChoices.length ? groupChoices : [{ id: '', name: '等待已保存的显示组' }], context.groupId); }
      else el('community-target').value = context.groupId || '';
      el('community-draft-note').hidden = !context.dirty;
      el('community-target-help').textContent = context.pending ? '请先完成当前设置或位置调整。' : context.groupId ? '已保存的显示组 · 配置版本 ' + context.revision + '。版本应用将保存新的配置版本。' : '先在壁纸页建立并保存一个显示组。';
      const currentSource = source(); el('community-source-details').hidden = !currentSource;
      if (currentSource) {
        const profile = currentSource.profile;
        el('community-freshness').textContent = currentSource.clockRollback ? '检测到时钟回退，安全清单按陈旧处理' : currentSource.revocationsFresh ? '撤销清单在有效期内' : '撤销清单陈旧，新的社区网页内容不能激活';
        el('community-freshness').dataset.state = currentSource.revocationsFresh && !currentSource.clockRollback ? 'fresh' : 'stale';
        facts(el('community-source-facts'), [['来源', profile.origin], ['根 SHA-256', profile.rootFingerprint, true], ['授权代次', currentSource.keyGeneration], ['最后安全同步', time(currentSource.lastSync)]]);
        const account = snapshot.accounts.find(item => item.sourceId === selectedSource);
        el('community-renew-choice').hidden=!profile.auth.scopes.includes('offline_access');
        el('community-account').textContent = account ? account.subject + ' · ' + account.issuer + (account.expiresAt > Date.now() / 1000 ? ' · 登录有效' : ' · 需要检查登录或重新登录') : '尚未登录此来源。';
        el('community-me').hidden = !account; el('community-logout').hidden = !account;
      }
      renderSubscriptions(); renderUpdates(); controls(controlsState);
      el('community-works').querySelectorAll('[data-community-work]').forEach(item=>{
        if(snapshot.subscriptions.some(sub=>sub.sourceId===item.dataset.sourceId&&sub.remoteWorkId===item.dataset.communityWork)){item.textContent='已订阅';item.dataset.blocked='true';item.disabled=true;}
      });
    }
    function renderWorks(items, sourceId, append, nextOffset) {
      if (!append) el('community-works').replaceChildren();
      items.forEach(work => {
        works.set(sourceId + ':' + work.id, work);
        const row = node('li'), heading = node('h4', work.title), id = node('code', work.id, 'community-code'), licenseText = node('p', '', 'hint');
        let statement; try { statement = JSON.parse(work.licenseJson); } catch (_) { statement = work.licenseJson; }
        licenseText.textContent = '许可：' + license(statement);
        const subscribed = snapshot.subscriptions.some(sub => sub.sourceId === sourceId && sub.remoteWorkId === work.id);
        const subscribe = button(subscribed ? '已订阅' : '订阅此作品', () => actions.subscribe(work.id), true); subscribe.dataset.blocked = String(subscribed);
        subscribe.dataset.communityWork=work.id;subscribe.dataset.sourceId=sourceId;
        subscribe.setAttribute('aria-label', (subscribed ? '已订阅 ' : '订阅此作品 ') + work.title);
        const toolbar = node('div', undefined, 'community-actions'); toolbar.append(subscribe);
        if (actions.report) {
          const report = button('举报此作品', () => actions.report(work.id), false);
          report.dataset.communityReport = sourceId;
          report.setAttribute('aria-label', '举报此作品 ' + work.title); toolbar.append(report);
        }
        row.append(heading, id, licenseText, toolbar); el('community-works').append(row);
      });
      el('community-browse-empty').textContent = el('community-works').childElementCount ? '' : '此来源当前没有可公开下载的已签名作品。';
      el('community-browse-empty').hidden = el('community-works').childElementCount > 0;
      el('community-browse-more').hidden = nextOffset == null || el('community-works').childElementCount >= 300;
      renderSubscriptions(); controls(controlsState);
    }
    function clearWorks() { el('community-works').replaceChildren(); el('community-browse-more').hidden = true; el('community-browse-empty').hidden = false; el('community-browse-empty').textContent = '选择社区后，点击“浏览已发布作品”。'; }
    function rootDraft(value) {
      const profile = value.profile;
      facts(el('community-root-facts'), [['来源', profile.origin], ['根 SHA-256', value.fingerprint, true], ['登录提供方', profile.auth.issuer], ['请求的登录范围', profile.auth.scopes.join('、')]]);
      el('community-root-input').value = ''; el('community-root-input').setCustomValidity(''); el('community-root-input').removeAttribute('aria-invalid'); el('community-root-error').textContent = '';
      el('community-root').hidden = false; el('community-root-heading').focus(); el('community-root').scrollIntoView({ block: 'nearest' });
    }
    function review(value) {
      const data = value.review, delta = data.delta || {}, differences = [];
      facts(el('community-review-facts'), [['作品', data.title], ['版本', data.version], ['内容类型', kind(data.kind)], ['包 SHA-256', data.packageHash, true], ['来源', data.sourceOrigin], ['根 SHA-256', data.rootFingerprint || '本地来源未验证', true], ['所需输入', permissionText(data.permissions)], ['署名（包内声明）', data.attribution || '未提供'], ['许可', license(data.license)], ['应用到显示组', data.targetGroupId], ['当前配置版本', data.expectedConfigRevision]]);
      if (delta.oldVersion != null) differences.push('版本 ' + delta.oldVersion + ' 到版本 ' + delta.newVersion);
      if (delta.permissionsAdded && delta.permissionsAdded.audioSpectrum) differences.push('新增音频频谱输入要求。');
      if (delta.permissionsAdded && delta.permissionsAdded.pointer) differences.push('新增鼠标输入要求。');
      if (delta.becameWeb) differences.push('内容将变为网页类型，须有新鲜安全清单和设备执行资格。');
      if (delta.protocolChanged) differences.push('要求的引擎协议发生变化：' + delta.minEngineProtocol);
      if (!differences.length) differences.push('未发现新的输入权限或协议要求。确切包内容以完整 SHA-256 为准。');
      el('community-review-differences').replaceChildren(...differences.map(text => node('li', text)));
      el('community-review-note').textContent = (data.rollback ? '此回滚也会保存新的配置版本，并重新检查安全撤销、权限、能力与预算。' : '确认后由原安装和设置流程准备并应用此版本。') + (data.playlist ? ' 此显示组使用轮播；更新会保留其它条目，并保存一个候选列表。' : '') + ' 本次确认有效期为五分钟。';
      el('community-apply').textContent = data.rollback ? '确认回到此版本' : '确认应用此版本';
      el('community-review-consent').checked = false; el('community-review').hidden = false;
      el('community-review-heading').focus(); el('community-review').scrollIntoView({ block: 'nearest' });
    }
    function controls(state) {
      controlsState = state;
      panel.querySelectorAll('[data-community-mutation]').forEach(item => {
        const reauthentication = state.authorRecovery && ['community-login', 'community-logout'].includes(item.id);
        item.disabled = !state.native || state.busy || state.uncertain && !reauthentication || item.dataset.blocked === 'true'
          || item.hasAttribute('data-community-target') && (!context.ready || !context.groupId || context.pending);
      });
      panel.querySelectorAll('[data-community-read]').forEach(item => { item.disabled = !state.native || item.dataset.blocked === 'true'; });
      panel.querySelectorAll('[data-community-report]').forEach(item => {
        const loggedIn = snapshot.accounts.some(account => account.sourceId === item.dataset.communityReport);
        item.disabled ||= !loggedIn;
        item.textContent = loggedIn ? '举报此作品' : '登录后举报';
      });
      el('community-source').disabled = !state.native || snapshot.sources.length === 0;
      el('community-target').disabled = !state.native || !context.ready || !(context.groups || []).length || context.pending;
      ['community-sync', 'community-browse', 'community-login', 'community-logout', 'community-me'].forEach(id => { if (!source()) el(id).disabled = true; });
      el('community-subscribe-form').querySelector('button[type=submit]').disabled ||= !source();
      el('community-login-cancel').hidden = !state.login;
      el('community-loading').hidden = !state.busy;
      el('community-uncertain').hidden = !state.uncertain;
    }
    el('community-subscriptions-more').addEventListener('click', () => { subscriptionLimit += 30; renderSubscriptions(); controls(controlsState); });
    return { render, message, controls, rootDraft, review, renderWorks, clearWorks,
      uncertain(record) { el('community-uncertain-id').textContent = record ? record.requestId : ''; el('community-uncertain-text').textContent = record ? '本机尚未确认这次操作的最终结果。查询会读取原请求、任务或配置提交记录。' : ''; },
      dismissRoot() { el('community-root').hidden = true; }, dismissReview() { el('community-review').hidden = true; },
      rootError(text) { el('community-root-error').textContent = text; el('community-root-input').setCustomValidity(text); el('community-root-input').setAttribute('aria-invalid', 'true'); el('community-root-input').reportValidity(); },
      originError(text) { el('community-origin-error').textContent = text; el('community-origin').setCustomValidity(text); el('community-origin').setAttribute('aria-invalid', 'true'); el('community-origin').reportValidity(); }
    };
  }
  window.hertzWallpaperCommunityView = { create };
})();
