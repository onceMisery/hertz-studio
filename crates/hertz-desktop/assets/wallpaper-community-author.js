// SPDX-License-Identifier: MIT
// Forms display native facts. Credentials, fixed files and write authority stay native.
(function () {
  'use strict';
  const labels = { reserved: '等待继续上传', receiving: '社区正在接收原上传', ready: '已完整接收，可以送审', validating: '社区正在核验原上传', submitted: '已送审', expired: '原上传已到期', rejected: '社区未接受这个包',
    pending_review: '等待审核', approved_pending_signature: '已批准，等待签名', signed_pending_public: '已签名，等待公开', published: '已公开', withdrawn: '已撤回', security_revoked: '因安全问题撤销', copyright_revoked: '因版权问题撤销' };
  function node(tag, text, className) {
    const item = document.createElement(tag);
    if (text != null) item.textContent = String(text);
    if (className) item.className = className;
    return item;
  }
  function facts(target, values) {
    target.replaceChildren(...values.flatMap(([label, value]) => [node('dt', label), node('dd', value)]));
  }
  function create(panel, actions) {
    const el = id => document.getElementById(id);
    if (!el('community-author-workspace')) return null;
    const packages = new Map(), owned = new Set(), edited = new WeakSet();
    let packageTicket = null, reportTicket = null, transfer = null, source = '', identity = null;
    let localCursor = null, candidateOffset = null, packageTimer = 0, reportTimer = 0, transferOperation = '';
    let state = { native: false, busy: false, uncertain: false, account: null, active: null };
    function accountKey(value) { return JSON.stringify([value.sourceId, value.account && value.account.issuer, value.account && value.account.subject]); }
    function flag(input, invalid) {
      input.setAttribute('aria-invalid', String(invalid));
      const errorId = input.dataset.error;
      if (!errorId) return;
      const ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== errorId);
      if (invalid) ids.push(errorId);
      if (ids.length) input.setAttribute('aria-describedby', ids.join(' ')); else input.removeAttribute('aria-describedby');
      el(errorId).hidden = !invalid;
    }
    panel.querySelectorAll('.community-author-controls :is(input, select, textarea)').forEach(input => {
      input.addEventListener('input', () => { edited.add(input); input.setCustomValidity(''); if (input.validity.valid) flag(input, false); });
      input.addEventListener('change', () => { edited.add(input); if (input.type === 'checkbox' || input.type === 'radio') flag(input, !input.validity.valid); });
      input.addEventListener('blur', () => {
        if (!edited.has(input)) return;
        flag(input, !input.validity.valid);
        if (!input.validity.valid && input.dataset.error) actions.message(el(input.dataset.error).textContent, true);
      });
      input.addEventListener('invalid', () => flag(input, true));
    });
    function discardPackage() { packageTicket = null; clearTimeout(packageTimer); el('community-author-review').hidden = true; }
    function discardReport() { reportTicket = null; clearTimeout(reportTimer); el('community-report-review').hidden = true; }
    function clear() {
      discardPackage(); discardReport(); transfer = null; transferOperation = ''; owned.clear(); candidateOffset = null;
      el('community-author-transfer').hidden = true; el('community-author-candidates').replaceChildren(); el('community-author-more').hidden = true;
      el('community-author-empty').hidden = false; el('community-author-empty').textContent = '登录此社区后，点击“刷新我的作品”。';
      el('community-report-result').textContent = ''; el('community-report-id').value = '';
      el('community-report-form').reset();
    }
    function openWorkspace() { el('community-author-workspace').open = true; }
    function moveTo(id) { el(id).focus(); el(id).scrollIntoView({ block: 'nearest' }); }
    function setState(next) {
      const key = accountKey(next);
      if (identity !== null && identity !== key) { clear(); actions.invalidate(); }
      identity = key; source = next.sourceId; state = next;
      const unavailable = !state.native || !source || !state.account;
      ['community-author-mine', 'community-author-more', 'community-report-submit'].forEach(id => { el(id).dataset.blocked = String(unavailable); });
      el('community-author-prepare-form').querySelector('button[type=submit]').dataset.blocked = String(unavailable);
      el('community-author-create').dataset.blocked = String(unavailable || !packageTicket || owned.has(packageTicket.review.workId));
      el('community-author-upload').dataset.blocked = String(unavailable || !packageTicket);
      el('community-author-submit').dataset.blocked = String(unavailable || !transfer || transfer.state !== 'ready');
      el('community-author-query').dataset.blocked = String(unavailable || !transfer || state.busy || state.uncertain);
      el('community-report-query-form').querySelector('button').dataset.blocked = String(unavailable);
      el('community-report-submit').dataset.blocked = String(unavailable || !reportTicket);
      const uploading = state.active && state.active.command.endsWith('authorUpload');
      el('community-author-cancel').hidden = !uploading; el('community-author-cancel').disabled = !state.native;
      panel.querySelectorAll('.community-author-controls :is(input, select, textarea)').forEach(input => { input.disabled = !state.native || state.busy || state.uncertain; });
    }
    function packagesResult(result, append) {
      if (!append) { packages.clear(); el('community-author-package').replaceChildren(node('option', '选择一个本地版本')); el('community-author-package').firstChild.value = ''; }
      for (const item of result.items || []) {
        if (packages.size >= 200) break;
        const key = item.workKey + ':' + item.packageHash;
        if (packages.has(key)) continue;
        packages.set(key, item); const option = node('option', item.title + ' · 版本 ' + item.version); option.value = key; el('community-author-package').append(option);
      }
      localCursor = result.nextCursor; el('community-author-local-more').hidden = localCursor == null || packages.size >= 200;
      openWorkspace(); actions.message(packages.size ? '已读取可上传的本地版本。' : '本页没有可上传的本地版本。可加载更多，或先在作品库保存并发布版本。');
    }
    function prepareResult(result) {
      packageTicket = result; clearTimeout(packageTimer);
      const data = result.review;
      facts(el('community-author-facts'), [['作品', data.title], ['版本', data.version], ['社区', data.sourceOrigin], ['账号', data.subject], ['大小', (data.bytes / 1048576).toFixed(2) + ' MiB'], ['包 SHA-256', data.packageHash], ['许可', data.license.code], ['素材许可', data.license.assets], ['署名', data.license.attribution || '未提供'], ['所需输入', [data.permissions.audioSpectrum && '音频频谱', data.permissions.pointer && '鼠标输入'].filter(Boolean).join('、') || '无']]);
      const resuming = transfer && transfer.state === 'reserved' && transfer.packageHash === data.packageHash && transfer.workId === data.workId;
      el('community-author-upload').textContent = resuming ? '继续上传原版本' : '上传此版本';
      el('community-author-consent').checked = false; flag(el('community-author-consent'), false);
      el('community-author-review').hidden = false; openWorkspace(); moveTo('community-author-review-heading');
      packageTimer = setTimeout(() => { discardPackage(); actions.message('上传核对已过期，请重新读取本地版本。', true); actions.update(); }, 300000);
      actions.message('已核对固定版本。确认许可后可以认领或上传。');
    }
    function uploadResult(upload, operation) {
      transfer = upload; transferOperation = operation || upload.id;
      discardPackage(); openWorkspace(); el('community-author-transfer').hidden = false;
      el('community-author-transfer-state').textContent = labels[upload.state] || upload.state;
      facts(el('community-author-transfer-facts'), [['作品编号', upload.workId], ['上传编号', upload.id], ['包 SHA-256', upload.packageHash], ['大小', (upload.expectedBytes / 1048576).toFixed(2) + ' MiB']]);
      el('community-author-submit-form').hidden = upload.state !== 'ready'; el('community-author-submit-consent').checked = false;
      if (upload.state === 'reserved') actions.message('原上传仍在等待内容。重新核对同一包后，可明确继续原上传。');
      else actions.message(labels[upload.state] || '已读取原上传状态。');
    }
    function candidatesResult(result) {
      owned.clear(); (result.works || []).forEach(work => owned.add(work.id));
      if (!result.offset) {
        if (result.uploads && result.uploads.length) uploadResult(result.uploads[0]);
        else { transfer = null; transferOperation = ''; el('community-author-transfer').hidden = true; }
      }
      if (!result.offset) el('community-author-candidates').replaceChildren();
      for (const candidate of result.candidates || []) {
        if (el('community-author-candidates').childElementCount >= 200) break;
        const row = node('li'); row.append(node('h4', candidate.title + ' · 版本 ' + candidate.version), node('p', labels[candidate.state] || candidate.state, 'hint'), node('code', candidate.id, 'community-code'), node('code', candidate.packageHash, 'community-code'));
        el('community-author-candidates').append(row);
      }
      candidateOffset = result.nextOffset; el('community-author-more').hidden = candidateOffset == null || el('community-author-candidates').childElementCount >= 200;
      el('community-author-empty').hidden = el('community-author-candidates').childElementCount > 0;
      el('community-author-empty').textContent = '此账号还没有送审版本。'; openWorkspace(); actions.message('已读取当前社区账号的作品版本。');
    }
    function reportPrepare(result) {
      reportTicket = result; clearTimeout(reportTimer); const data = result.review;
      facts(el('community-report-facts'), [['社区', data.sourceOrigin], ['作品编号', data.workId], ['发布编号', data.releaseId], ['版本', data.version], ['包 SHA-256', data.packageHash], ['提交账号', data.subject]]);
      el('community-report-form').reset(); el('community-report-review').hidden = false; moveTo('community-report-heading');
      reportTimer = setTimeout(() => { discardReport(); actions.message('举报版本核对已过期，请重新选择作品。', true); actions.update(); }, 300000);
      actions.message('已核对这个已签名版本。请填写举报原因和说明。');
    }
    function reportResult(report) {
      el('community-report-id').value = report.id;
      const text = ({ open: '等待处理', dismissed: '已结案', escalated: '已转交进一步审核' })[report.status] || report.status;
      el('community-report-result').textContent = '举报 ' + report.id + '：' + text + (report.resolution ? '。处理说明：' + report.resolution.reason : '。');
      el('community-report-query-form').closest('details').open = true;
      actions.message('已读取举报处理结果。');
    }
    function accept(command, result, record) {
      if (!/^(author|report)/.test(command)) return false;
      if (command !== 'authorLocal' && record.sourceId !== source) return true;
      if (command !== 'authorLocal' && record.accountIssuer
        && (!state.account || record.accountIssuer !== state.account.issuer || record.accountSubject !== state.account.subject)) return true;
      if (command === 'authorLocal') packagesResult(result, !!(record.payload && record.payload.cursor));
      else if (command === 'authorPrepare') prepareResult(result);
      else if (command === 'authorCreate') { owned.add(result.work.id); actions.message('作品已认领到此账号，可以上传这个版本。'); }
      else if (command === 'authorUpload') uploadResult(result.upload, record.operationId);
      else if (command === 'authorSubmit') { transfer = null; el('community-author-transfer').hidden = true; actions.message('版本已送审：' + (labels[result.candidate.state] || result.candidate.state) + '。可刷新我的作品查看后续进度。'); }
      else if (command === 'authorList') candidatesResult(result);
      else if (command === 'authorOperation') {
        if (result.upload) uploadResult(result.upload, record.operationId);
        if (result.candidate) actions.message('原版本：' + (labels[result.candidate.state] || result.candidate.state) + '。');
        if (result.work) { owned.add(result.work.id); actions.message('原认领操作已确认，作品属于此账号。'); }
        if (result.report) reportResult(result.report);
      }
      else if (command === 'reportPrepare') reportPrepare(result);
      else if (command === 'reportSubmit') { discardReport(); el('community-report-id').value = result.reportId; el('community-report-query-form').closest('details').open = true; el('community-report-result').textContent = '已提交举报，编号 ' + result.reportId + '。'; actions.message('举报已提交，可按编号查询处理结果。'); }
      else if (command === 'reportDetail') reportResult(result.report);
      actions.update(); return true;
    }
    el('community-author-local').addEventListener('click', () => actions.run('authorLocal', {}));
    el('community-author-local-more').addEventListener('click', () => { if (localCursor) actions.run('authorLocal', { cursor: localCursor }); });
    el('community-author-mine').addEventListener('click', () => actions.run('authorList', { sourceId: source, offset: 0 }));
    el('community-author-more').addEventListener('click', () => { if (candidateOffset != null) actions.run('authorList', { sourceId: source, offset: candidateOffset }); });
    el('community-author-package').addEventListener('change', () => { discardPackage(); actions.update(); });
    el('community-author-prepare-form').addEventListener('submit', event => {
      event.preventDefault(); const entry = packages.get(el('community-author-package').value); if (!entry) return;
      actions.run('authorPrepare', { sourceId: source, workKey: entry.workKey, packageHash: entry.packageHash });
    });
    el('community-author-publish-form').addEventListener('submit', event => {
      event.preventDefault(); if (!packageTicket || !event.submitter) return;
      const command = event.submitter.dataset.authorAction === 'create' ? 'authorCreate' : 'authorUpload';
      const data = packageTicket.review;
      const existing = command === 'authorUpload' && transfer && transfer.state === 'reserved' && transfer.packageHash === data.packageHash && transfer.workId === data.workId ? transfer.id : undefined;
      actions.run(command, { sourceId: source, ticket: packageTicket.ticket, operationId: crypto.randomUUID(), consent: true, uploadId: existing });
    });
    el('community-author-dismiss').addEventListener('click', () => { discardPackage(); actions.invalidate(); actions.update(); });
    el('community-author-submit-form').addEventListener('submit', event => { event.preventDefault(); if (transfer) actions.run('authorSubmit', { sourceId: source, uploadId: transfer.id, packageHash: transfer.packageHash, consent: true }); });
    el('community-author-query').addEventListener('click', () => { if (transfer) actions.run('authorOperation', { sourceId: source, kind: 'upload', uploadId: transfer.id, operationId: transferOperation }); });
    el('community-author-cancel').addEventListener('click', actions.cancel);
    el('community-report-form').addEventListener('submit', event => {
      event.preventDefault(); if (!reportTicket) return;
      const description = el('community-report-description').value.trim();
      if (!description) { el('community-report-description').setCustomValidity('请填写具体问题和可核查的线索。'); flag(el('community-report-description'), true); el('community-report-description').reportValidity(); return; }
      actions.run('reportSubmit', { sourceId: source, ticket: reportTicket.ticket, operationId: crypto.randomUUID(), reason: new FormData(event.target).get('reason'), description, consent: true });
    });
    el('community-report-dismiss').addEventListener('click', () => { discardReport(); actions.invalidate(); actions.update(); });
    el('community-report-query-form').addEventListener('submit', event => { event.preventDefault(); actions.run('reportDetail', { sourceId: source, reportId: el('community-report-id').value.toLowerCase() }); });
    window.addEventListener('pagehide', () => { clearTimeout(packageTimer); clearTimeout(reportTimer); });
    return { accept, setState, clear, showReport(work) { actions.run('reportPrepare', { sourceId: source, remoteWorkId: work }); },
      isMutation(command) { return ['authorCreate', 'authorUpload', 'authorSubmit', 'reportSubmit'].includes(command); },
      operationKind(command) { return command === 'authorCreate' ? 'work' : command === 'reportSubmit' ? 'report' : 'upload'; },
      fault(code) { if (['confirmation_expired', 'account_changed', 'source_changed', 'cancelled'].includes(code)) { discardPackage(); discardReport(); } }
    };
  }
  window.hertzWallpaperCommunityAuthor = { create };
})();
