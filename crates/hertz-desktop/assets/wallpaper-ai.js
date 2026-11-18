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
  function scope(current) { return JSON.stringify([current.groupId, current.profile]); }
  function live(receiver) { return receiver && operation === receiver && panel.open && !document.hidden && receiver.scope === scope(context()); }
  function retire() { operation = null; busy = false; el('ai-loading').hidden = true; controls(); }
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
      if (!live(operation) || operation.phase === 'querying') message('只查询已安装且无需新增权限的图片、视频和内置作品。完整的“切换到作品名”会直接受理；重名或多版本需选择确切的一项。组合与网页作品尚未获得离线切换资格。'); controls();
    } catch (error) { if (currentEpoch !== epoch) return; message(error.message, true); el('ai-target').textContent = '当前目标不可用'; }
  }
  function reason(item) {
    const text = { installed: '已安装', exactTitle: '名称精确匹配', title: '名称匹配', tag: '标签匹配', theme: '主题匹配', lowMotion: '低运动内容' };
    return (item.reasons || []).map(reason => (text[reason.kind] || reason.kind) + (reason.value ? '：' + reason.value : '')).join(' · ');
  }
  function render(result) {
    el('ai-results').replaceChildren();
    (result.actions || []).forEach(action => {
      const row = document.createElement('li'), title = document.createElement('strong'), why = document.createElement('p'), identity = document.createElement('span'), button = document.createElement('button');
      title.textContent = action.title + (action.title.includes(' · v') ? '' : ' · v' + action.version);
      why.textContent = reason(action); button.textContent = '切换此版本'; button.dataset.aiAction = action.actionId;
      identity.className = 'ai-content-id';
      identity.textContent = '内容标识 · ' + action.packageHash.slice(0, 12);
      identity.title = action.packageHash;
      why.append(identity);
      button.setAttribute('aria-label', '将 ' + action.title + ' v' + action.version + '，内容标识 ' + action.packageHash.slice(0, 12) + '，切换到 ' + action.targetGroupId);
      button.addEventListener('click', () => run('wallpaper.ai.confirm', { actionId: action.actionId })); row.append(title, why, button); el('ai-results').append(row);
    });
    message(result.actions && result.actions.length ? result.message : '没有符合当前目标、权限与预算的已安装作品。可在“本地作品”导入，或调整已保存目标。');
  }
  async function recover(receiver, command) {
    const requestId = receiver.requestId;
    try {
      const receipt = await settings.requestManagement('wallpaper.operations.get', { requestId, command });
      if (!live(receiver)) return;
      if (receipt.result && receipt.result.saved === true) applyProgress({ requestId, phase: 'saved', saved: true });
      else message('原操作尚未保存。请保留请求编号查询：' + requestId, true);
    } catch (error) { if (live(receiver)) message(error.message + ' 原请求：' + requestId, true); }
  }
  async function run(command, payload) {
    if (busy || !target || !panel.open || document.hidden) return;
    const currentEpoch = epoch, requestId = crypto.randomUUID(), receiver = { requestId, groupId: target.groupId, scope: scope(context()), phase: 'querying' }; busy = true; operation = receiver;
    el('ai-loading').hidden = false; controls(); message(command === 'wallpaper.ai.confirm' ? '正在核对确切版本与原生目标…' : '正在查询本地目录…');
    try {
      const receipt = await settings.requestManagement(command, payload, requestId, target.configRevision);
      if (!live(receiver)) return;
      if (receipt.ai) applyProgress(receipt.ai);
      else if (receipt.result && receipt.result.saved === true) applyProgress({ requestId, phase: 'saved', saved: true });
      else if (currentEpoch === epoch) render(receipt.result || {});
    } catch (error) {
      if (!live(receiver)) return;
      if (error.code === 'receipt_timeout' || error.code === 'operation_pending') await recover(receiver, command);
      else message(error.message, true);
    } finally { if (operation === receiver) { busy = false; el('ai-loading').hidden = true; controls(); } }
  }
  function applyProgress(progress) {
    if (!live(operation) || operation.requestId !== progress.requestId) return;
    Object.assign(operation, progress);
    message((phases[progress.phase] || '正在核对原操作。') + (progress.groupId ? ' 目标：' + progress.groupId : ''), progress.phase === 'failed');
  }
  function runtimePhase(runtime) {
    const targets = runtime && (Array.isArray(runtime.targets) ? runtime.targets : [runtime]);
    if (!targets || !targets.length || targets.some(item => !item || item.groupId !== operation.groupId)) return 'saved';
    if (targets.some(item => item.applyError || item.state === 'failed' || item.session && item.session.state === 'failed')) return 'failed';
    if (targets.some(item => item.monitorMissing || item.state === 'missing')) return 'saved';
    if (targets.some(item => item.sessionStopped || item.runtimeEnabled === false || item.enabled === false || ['closing', 'stopped', 'disabled'].includes(item.state))) return 'paused';
    if (!targets.every(item => {
      const selection = item.appliedSelection;
      return item.firstFrameReady && selection && selection.kind === 'package'
        && selection.workKey === operation.workKey && selection.packageHash === operation.packageHash;
    })) return 'saved';
    return targets.every(item => item.visible && item.state !== 'paused' && !(item.session && item.session.state === 'paused')) ? 'running' : 'paused';
  }
  el('ai-query').addEventListener('click', () => run('wallpaper.ai.recommend', { brief: el('ai-brief').value }));
  panel.addEventListener('toggle', () => { if (panel.open) { contextKey = ''; readTarget(); } else { ++epoch; retire(); clear(); } });
  window.addEventListener('wallpaper-ai-context', () => {
    const current = context(), key = JSON.stringify([current.groupId, current.revision, current.profile]);
    if (operation && operation.scope !== scope(current)) retire();
    if (key !== contextKey && panel.open) readTarget();
    if (live(operation) && operation.saved) applyProgress({ requestId: operation.requestId, phase: runtimePhase(settings.currentRuntime()), saved: true });
  });
  window.addEventListener('wallpaper-ai-invalidated', () => {
    ++epoch; retire(); clear(); contextKey = ''; message('选择或目标草稿已变化，请重新查询已保存目标。');
    if (window.ipc) settings.requestManagement('wallpaper.ai.invalidate', {}).catch(() => {});
    if (panel.open) readTarget();
  });
  window.addEventListener('pagehide', () => { ++epoch; retire(); clear(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { ++epoch; retire(); clear(); } else if (panel.open) readTarget(); });
  window.hertzWallpaperAI = { applyProgress };
})();

// Managed generation shares the native settings bridge; page data contains no bearer.
(function () {
  'use strict';
  const panel = document.getElementById('wallpaper-generation');
  const settings = window.hertzWallpaperSettings;
  if (!panel || !settings) return;
  const el = id => document.getElementById('generation-' + id);
  let epoch = 0, timer = null, busy = false, connected = false, ready = false, quote = null, job = null, submissionPending = false;
  let candidates = [], candidateKey = '', receiving = null, previewing = null;
  let thumbnailQueue = Promise.resolve();
  let generationContext = JSON.stringify(settings.currentAiContext());
  let externalRequest = null;
  function node(tag, text, id) { const value = document.createElement(tag); if (text) value.textContent = text; if (id) value.id = 'generation-' + id; return value; }
  const body = panel.querySelector('.ai-body');
  const quoteForm = node('form', '', 'form'); quoteForm.setAttribute('aria-label', '壁纸生成报价');
  const sceneLabel = el('scene').closest('label'), briefLabel = el('brief').closest('label'), quoteTools = el('quote').closest('.ai-toolbar');
  sceneLabel.before(quoteForm); quoteForm.append(sceneLabel, briefLabel, quoteTools);
  const externalSource = node('p', '', 'external-source'); externalSource.className = 'hint'; externalSource.hidden = true;
  quoteForm.before(externalSource);
  el('scene').name = 'scene'; el('brief').name = 'brief'; el('brief').required = true; el('quote').type = 'submit';
  el('brief').setAttribute('aria-describedby', 'generation-type-info');
  let capability = null;
  let assetSnapshot = null, assetCursor = null, assetsLoaded = false;
  const selectedAssets = new Map();
  const kindField = node('fieldset'), kindLegend = node('legend', '生成类型'); kindField.id = 'generation-kinds'; kindField.className = 'generation-options'; kindField.append(kindLegend);
  for (const [value, text] of [['builtin', '内置场景'], ['image', '图片'], ['composition', '组合场景']]) {
    const input = node('input', '', 'kind-' + value); input.type = 'radio'; input.name = 'generation-kind'; input.value = value; input.checked = value === 'builtin'; input.disabled = true;
    const label = node('label', text); label.htmlFor = input.id;
    const option = node('div'); option.className = 'generation-option'; option.append(input, label); kindField.append(option);
  }
  const imageFields = node('div', '', 'image-fields'); imageFields.hidden = true;
  const sizeField = node('fieldset', '', 'sizes'); sizeField.className = 'generation-options'; sizeField.append(node('legend', '图片尺寸'));
  const qualityField = node('fieldset', '', 'qualities'); qualityField.className = 'generation-options'; qualityField.append(node('legend', '图片质量'));
  const typeInfo = node('p', '', 'type-info'); typeInfo.className = 'hint';
  const compositionFields = node('fieldset', '', 'composition-fields'); compositionFields.hidden = true; compositionFields.className = 'generation-materials';
  compositionFields.append(node('legend', '选定本地素材（最多 32 项）'));
  const materialHelp = node('p', '素材文件名和路径只在本机显示。生成服务只收到临时别名、类型、尺寸和时长。', 'material-help'); materialHelp.className = 'hint';
  const materialList = node('div', '', 'materials'); materialList.setAttribute('aria-describedby', materialHelp.id);
  const materialCount = node('p', '已选 0 / 32 项', 'material-count'); materialCount.className = 'hint'; materialCount.setAttribute('role', 'status');
  const materialTools = node('div'); materialTools.className = 'ai-toolbar';
  const materialRefresh = node('button', '读取本地素材', 'materials-refresh'); materialRefresh.type = 'button';
  const materialMore = node('button', '更多素材', 'materials-more'); materialMore.type = 'button'; materialMore.hidden = true;
  const rights = node('input', '', 'rights'); rights.type = 'checkbox'; rights.name = 'rights'; rights.setAttribute('aria-describedby', materialHelp.id);
  const rightsLabel = node('label', '我有权使用和改编所选素材'); rightsLabel.htmlFor = rights.id;
  const rightsRow = node('div'); rightsRow.className = 'generation-option'; rightsRow.append(rights, rightsLabel);
  materialTools.append(materialRefresh, materialMore); compositionFields.append(materialHelp, materialList, materialCount, materialTools, rightsRow);
  imageFields.append(sizeField, qualityField); el('scene').closest('label').before(kindField, imageFields, compositionFields, typeInfo);
  function chosen(name) { return panel.querySelector('input[name="generation-' + name + '"]:checked')?.value || ''; }
  function outputSpec() {
    if (chosen('kind') === 'composition') return { kind: 'composition', assetSetId: assetSnapshot?.assetSetId || '' };
    if (chosen('kind') !== 'image') return { kind: 'builtin', sceneId: el('scene').value };
    const [width, height] = chosen('size').split('x').map(Number);
    return { kind: 'image', width, height, qualityId: chosen('quality') };
  }
  function choices(field, name, values) {
    const selected = chosen(name); field.querySelectorAll('.generation-option').forEach(item => item.remove());
    values.forEach(([value, text], index) => {
      const input = node('input', '', name + '-' + index); input.type = 'radio'; input.name = 'generation-' + name; input.value = value;
      input.checked = value === selected || (!values.some(item => item[0] === selected) && index === 0);
      const label = node('label', text); label.htmlFor = input.id;
      const option = node('div'); option.className = 'generation-option'; option.append(input, label); field.append(option);
      input.addEventListener('change', () => { invalidateQuote(); controls(); });
    });
  }
  function typeControls() {
    const kind = chosen('kind'), output = (capability?.outputs || []).find(item => item.kind === kind);
    ready = !!output?.ready;
    el('scene').closest('label').hidden = kind !== 'builtin'; imageFields.hidden = kind !== 'image'; compositionFields.hidden = kind !== 'composition';
    for (const value of ['builtin', 'image', 'composition']) {
      const item = (capability?.outputs || []).find(item => item.kind === value);
      el('kind-' + value).disabled = busy || !connected || !item?.ready;
    }
    imageFields.querySelectorAll('input').forEach(input => { input.disabled = busy || !ready || !connected; });
    compositionFields.querySelectorAll('input,button').forEach(input => { input.disabled = busy || !ready || !connected || input.dataset.eligible === 'false' || input.dataset.generationAsset != null && !input.checked && selectedAssets.size >= 32; });
    rights.required = kind === 'composition';
    materialCount.textContent = '已选 ' + selectedAssets.size + ' / 32 项';
    materialMore.hidden = !assetCursor;
    typeInfo.textContent = kind === 'composition' ? '组合所选素材，生成可编辑的图层、效果和动画。保存作品会复制素材并保留来源声明。' : kind === 'image'
      ? ready ? '离线图片测试 · 诊断网格，不调用模型。正式图像模型与价格尚未启用。' : '图片生成尚未启用。请在播放器配置独立图像能力。'
      : '内置场景生成公开参数。' + (!(capability?.outputs || []).some(item => item.kind === 'image' && item.ready) ? ' 图片生成尚未启用。' : '');
  }
  for (const value of ['builtin', 'image', 'composition']) el('kind-' + value).addEventListener('change', () => {
    invalidateQuote(); controls();
    if (value === 'composition' && !assetsLoaded) loadMaterials(false);
  });
  rights.addEventListener('change', invalidateQuote);
  materialRefresh.addEventListener('click', () => loadMaterials(false)); materialMore.addEventListener('click', () => loadMaterials(true));
  function loadMaterials(more) {
    return action('assets.list', { limit: 32, cursor: more ? assetCursor : null }, result => {
      if (!more) materialList.replaceChildren();
      assetCursor = result.nextCursor || null; assetsLoaded = true;
      const kinds = { image: '图片', video: '视频', vector: '矢量图', texture: '纹理', font: '字体', model: '模型' };
      for (const item of result.assets || []) {
        const key = JSON.stringify([item.workKey, item.packageHash, item.assetId]);
        const input = node('input', '', 'material-' + materialList.childElementCount); input.type = 'checkbox'; input.name = 'material'; input.value = key;
        input.dataset.generationAsset = key; input.dataset.eligible = String(!!item.rights?.eligible); input.checked = selectedAssets.has(key);
        const label = node('label', item.label || kinds[item.kind] || '素材'); label.htmlFor = input.id;
        const detail = node('span', (kinds[item.kind] || item.kind) + (item.width && item.height ? ' · ' + item.width + '×' + item.height : '') + (item.durationMs ? ' · ' + (item.durationMs / 1000).toFixed(1) + ' 秒' : ''));
        const explanation = node('p', item.rights?.explanation || '请确认素材使用权。'); explanation.className = 'hint'; explanation.id = input.id + '-help'; input.setAttribute('aria-describedby', explanation.id);
        const row = node('div'); row.className = 'generation-material-row'; label.append(detail); row.append(input, label, explanation); materialList.append(row);
        input.addEventListener('change', () => {
          if (input.checked) selectedAssets.set(key, { workKey: item.workKey, packageHash: item.packageHash, assetId: item.assetId }); else selectedAssets.delete(key);
          assetSnapshot = null; invalidateQuote(); controls();
        });
      }
      if (!materialList.childElementCount) materialList.append(node('p', '还没有可用素材。请先从“本地作品”导入有权使用的图片、视频或资源。'));
      controls();
    });
  }
  const receive = node('button', '接收生成候选', 'receive'); receive.type = 'button';
  const receiveCancel = node('button', '取消接收', 'receive-cancel'); receiveCancel.type = 'button';
  const receiveState = node('p', '', 'receive-state'); receiveState.className = 'hint'; receiveState.setAttribute('role', 'status');
  const stopPreview = node('button', '结束候选预览', 'stop-preview'); stopPreview.type = 'button';
  const list = node('ul', '', 'candidates'); list.className = 'generation-candidates'; list.setAttribute('aria-label', '生成候选与保存回执');
  body.lastElementChild.textContent = '接收后可预览并明确保存作品。保存后从“本地作品”选择，再应用到桌面。';
  body.append(receive, receiveCancel, receiveState, node('h3', '候选与保存回执'), stopPreview, list);
  const phases = { accepted: '已受理，等待生成。', running: '正在生成候选。', succeeded: '候选已生成，尚未保存或应用。',
    cancelled: '任务已取消。费用以实际派发与结算为准。', failed: '生成失败。', interrupted: '生成已中断。' };
  function visible() { return panel.open && !document.hidden && !panel.closest('[role="tabpanel"]').hidden; }
  function status(text) { el('status').textContent = text; }
  function controls() {
    typeControls();
    panel.setAttribute('aria-busy', String(busy));
    el('connect').hidden = connected; el('connect').disabled = busy;
    el('disconnect').hidden = !connected; el('disconnect').disabled = busy;
    el('scene').disabled = busy || !connected || !ready;
    el('brief').disabled = busy || !connected || !ready;
    el('quote').disabled = busy || submissionPending || !ready || !connected;
    el('recover').hidden = !submissionPending; el('recover').disabled = busy || !connected;
    el('price').hidden = !quote; el('confirm').disabled = busy || !quote || quote.expiresAt <= Date.now();
    el('cancel').hidden = !job || !['accepted', 'running'].includes(job.state); el('cancel').disabled = busy;
    receive.hidden = !job || job.state !== 'succeeded'; receive.disabled = busy || !connected || !!receiving;
    receiveCancel.hidden = !receiving; receiveCancel.disabled = busy;
    stopPreview.hidden = !previewing; stopPreview.disabled = busy;
    list.querySelectorAll('button,input').forEach(control => { control.disabled = busy; });
  }
  function stop() { clearTimeout(timer); timer = null; }
  function invalidateQuote() {
    quote = null;
    settings.requestManagement('wallpaper.ai.invalidate', {}).catch(() => {});
  }
  function schedule() { stop(); if (visible()) timer = setTimeout(refresh, 2100); }
  async function request(command, payload) {
    const receipt = await settings.requestManagement('wallpaper.ai.' + command, payload || {});
    return receipt.result;
  }
  async function action(command, payload, success) {
    if (busy || !visible()) return;
    stop(); const current = epoch; busy = true; controls();
    if (command === 'generate.confirm') assetSnapshot = null;
    try {
      const result = await request(command, payload);
      if (current === epoch && visible()) await success(result);
    } catch (error) {
      if (current === epoch && visible()) {
        if (command === 'generate.confirm' && ['generation_cancelled', 'ai_target_changed', 'grant_revoked'].includes(error.code)) {
          externalRequest = null; externalSource.hidden = true; invalidateQuote();
        }
        status(error.message || '操作未完成，请重试原操作。');
      }
    } finally {
      busy = false; controls(); schedule();
    }
  }
  function stopCandidatePreview() { if (previewing) settings.releasePreview(); previewing = null; controls(); }
  function renderCandidates(result) {
    const next = result.candidates || [], key = JSON.stringify(next);
    candidates = next;
    if (key === candidateKey) { list.querySelectorAll('li').forEach(row => row.loadThumbnail?.()); return; }
    candidateKey = key; list.replaceChildren();
    if (!next.length) { list.append(node('li', '尚未接收候选。生成完成后点击“接收生成候选”。')); return; }
    for (const item of next) {
      const row = node('li'); row.dataset.receiptId = item.receiptId;
      const title = node('strong', (item.kind === 'composition' ? '组合场景候选' : item.kind === 'image' ? '图片候选' : '内置场景候选') + ' · ' + item.artifact.sha256.slice(0, 12));
      const detail = node('p', item.state === 'preparing' ? '正在准备所选素材与预览，请稍候。' : item.state === 'failed' ? '准备未通过：' + (item.diagnostics?.message || '请编辑组合以修正，或删除此候选。') : item.state === 'saved' ? '已保存作品，可从本地作品入口选择。' : item.state === 'saving' ? '已转交作品保存，重试将继续原保存。' : '已接收，尚未保存。候选到期时间：' + new Date(Number(item.artifact.expiresAt)).toLocaleString()); detail.className = 'hint';
      row.append(title, detail);
      if (item.sceneId) {
        const reference = node('figure'), image = node('img');
        image.src = '/scene-thumbnails/' + encodeURIComponent(item.sceneId) + '.jpg';
        image.alt = ''; image.width = 320; image.height = 180; image.loading = 'lazy'; image.decoding = 'async';
        reference.append(image, node('figcaption', '场景静态参考；生成参数的效果请点击“预览候选”查看。'));
        row.append(reference);
      } else if (item.kind === 'image' && item.state !== 'saved') {
        const reference = node('figure'), image = node('img'), caption = node('figcaption', '正在读取图片缩略图…');
        image.alt = '生成图片的静态缩略图'; image.decoding = 'async'; image.hidden = true;
        reference.append(image, caption); row.append(reference);
        let thumbnailState = 'idle';
        row.loadThumbnail = () => {
          if (thumbnailState !== 'idle') return;
          thumbnailState = 'pending';
          thumbnailQueue = thumbnailQueue.then(async () => {
          if (!visible() || !row.isConnected) { thumbnailState = 'idle'; return; }
          try {
            const thumbnail = await request('candidate.thumbnail', { receiptId: item.receiptId });
            if (!visible() || !row.isConnected) { thumbnailState = 'idle'; return; }
            if (!Number.isInteger(thumbnail.width) || !Number.isInteger(thumbnail.height) || thumbnail.width < 1 || thumbnail.height < 1 || Math.max(thumbnail.width, thumbnail.height) > 96 || typeof thumbnail.data !== 'string' || thumbnail.data.length > 55 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(thumbnail.data)) throw new Error('缩略图回执无效');
            image.width = thumbnail.width; image.height = thumbnail.height; image.style.aspectRatio = thumbnail.width + ' / ' + thumbnail.height;
            image.src = 'data:image/png;base64,' + thumbnail.data; image.hidden = false;
            caption.textContent = '图片静态缩略图；完整效果请点击“预览候选”查看。';
            thumbnailState = 'ready';
          } catch (error) { thumbnailState = 'failed'; if (row.isConnected) caption.textContent = '缩略图不可用，请预览候选或重新打开面板。'; }
          });
        };
        row.retryThumbnail = () => { if (thumbnailState === 'failed') thumbnailState = 'idle'; row.loadThumbnail(); };
        row.loadThumbnail();
      }
      if (['previewReady', 'saving'].includes(item.state)) {
        const form = node('form'); form.setAttribute('aria-label', '保存候选 ' + item.artifact.sha256.slice(0, 12));
        const label = node('label', '作品名'), input = node('input'); input.name = 'title'; input.maxLength = 120; input.required = true; input.value = item.title || (item.kind === 'composition' ? 'AI 组合场景' : item.kind === 'image' ? 'AI 图片' : 'AI 内置场景'); label.append(input);
        const save = node('button', item.state === 'saving' ? '继续保存原作品' : '保存作品'); save.type = 'submit'; form.append(label, save);
        form.addEventListener('submit', event => {
          event.preventDefault();
          action('candidate.save', { receiptId: item.receiptId, title: input.value }, async saved => {
            stopCandidatePreview(); status('作品已保存。请在本地作品中选择，再应用到桌面。');
            window.dispatchEvent(new Event('wallpaper-library-changed'));
            renderCandidates(await request('candidates'));
          });
        });
        row.append(form);
      }
      if (item.kind === 'composition' && item.savedDraftId && ['failed', 'saved'].includes(item.state)) {
        const edit = node('button', item.state === 'failed' ? '编辑以修正组合' : '编辑已保存组合'); edit.type = 'button'; edit.dataset.candidateEdit = item.receiptId;
        edit.setAttribute('aria-controls', 'work-editor');
        edit.addEventListener('click', () => window.hertzWallpaperWork?.openDraft(item.savedDraftId).catch(error => status(error.message)));
        row.append(edit);
      }
      if (['preparing', 'failed'].includes(item.state)) {
        if (item.kind === 'composition' && item.state === 'failed' && !item.savedDraftId) {
          const retry = node('button', '重新准备候选'); retry.type = 'button'; retry.dataset.candidateRetry = item.receiptId;
          retry.addEventListener('click', () => action('candidate.retry', { receiptId: item.receiptId }, async () => {
            status('正在重新准备候选。'); renderCandidates(await request('candidates'));
          })); row.append(retry);
        }
        const remove = node('button', '删除未保存候选'); remove.type = 'button'; remove.dataset.candidateDelete = item.receiptId;
        remove.addEventListener('click', () => action('candidate.delete', { receiptId: item.receiptId }, async () => { if (previewing === item.receiptId) stopCandidatePreview(); renderCandidates(await request('candidates')); status('未保存候选已删除。'); }));
        row.append(remove);
      }
      if (item.state === 'previewReady') {
        const tools = node('div'); tools.className = 'ai-toolbar';
        const preview = node('button', '预览候选'); preview.type = 'button'; preview.dataset.candidatePreview = item.receiptId;
        preview.addEventListener('click', async () => {
          if (busy || !visible()) return;
          busy = true; const current = epoch; controls(); stop();
          try {
            await settings.previewWork({ draftId: item.draftId, draftRevision: item.draftRevision });
            if (current !== epoch || !visible()) settings.releasePreview();
            else { previewing = item.receiptId; status('正在预览候选，尚未保存或应用。'); }
          } catch (error) { if (current === epoch) status(error.message); }
          finally { busy = false; controls(); schedule(); }
        });
        const remove = node('button', '删除未保存候选'); remove.type = 'button'; remove.dataset.candidateDelete = item.receiptId;
        remove.addEventListener('click', () => action('candidate.delete', { receiptId: item.receiptId }, async () => { if (previewing === item.receiptId) stopCandidatePreview(); renderCandidates(await request('candidates')); status('未保存候选已删除。'); }));
        tools.append(preview, remove); row.append(tools);
      }
      if (item.packageHash) { const hash = node('p', '保存内容标识 · ' + item.packageHash.slice(0, 12)); hash.className = 'ai-content-id'; hash.title = item.packageHash; row.append(hash); }
      list.append(row);
    }
    controls();
  }
  async function refresh() {
    if (!visible() || busy) return;
    const current = epoch; busy = true; controls();
    try {
      const state = await request('status');
      if (current !== epoch || !visible()) return;
      connected = !!state.connected; if (!connected) capability = null;
      job = state.job || null; submissionPending = !!state.submissionPending;
      el('job').textContent = job ? phases[job.state] || '任务状态未知。' : '';
      if (!connected) {
        ready = false; quote = null; assetSnapshot = null;
        status(state.pending ? '请在播放器设置 → 连接 → AI 与外部连接中确认此连接。配对 60 秒后到期。' : '尚未连接。请先启动已选来源的播放器，再连接生成服务。');
      } else if (!capability) {
        capability = await request('capabilities');
        if (current !== epoch || !visible()) return;
        const output = (capability.outputs || []).find(item => item.kind === chosen('kind') && item.ready);
        ready = !!output; el('scene').replaceChildren();
        const image = (capability.outputs || []).find(item => item.kind === 'image');
        choices(sizeField, 'size', (image?.sizes || []).map(([width, height]) => [width + 'x' + height, width + '×' + height]));
        choices(qualityField, 'quality', (image?.qualityIds || []).map(value => [value, value === 'fixture' ? '离线测试' : value]));
        for (const scene of capability.scenes || []) {
          const option = document.createElement('option'); option.value = scene.id; option.textContent = scene.label || scene.id;
          el('scene').appendChild(option);
        }
        status(ready ? '已连接。查看报价不会调用模型。' : '已连接，当前模型尚未提供壁纸生成能力。请在播放器中配置受支持的模型。');
      }
      if (submissionPending) { assetSnapshot = null; status('已确认请求的回执尚未核实。查询原请求会使用同一标识，不会创建第二个生成任务。'); }
      if (connected && job && ['accepted', 'running'].includes(job.state)) {
        const result = await request('generate.job', { jobId: job.jobId });
        if (current === epoch && visible()) { job = result; el('job').textContent = phases[job.state] || '任务状态未知。'; }
      }
      if (quote && quote.expiresAt <= Date.now()) { quote = null; status('报价已到期，请重新查看报价。'); }
      if (receiving) {
        const receipt = await settings.requestManagement('wallpaper.jobs.get', { jobId: receiving });
        if (current !== epoch || !visible()) return;
        const local = receipt.result;
        receiveState.textContent = ({ queued: '等待接收候选…', preparing: '正在接收并核验候选…', done: '同一候选已接收，可预览或保存。', cancelled: '接收已取消，可重新接收同一候选。', failed: '接收失败：' + (local.error || '可重新接收同一候选。') })[local.state] || '正在接收候选…';
        if (['done', 'cancelled', 'failed'].includes(local.state)) receiving = null;
      }
      const localCandidates = await request('candidates');
      if (current === epoch && visible()) renderCandidates(localCandidates);
    } catch (error) {
      if (current === epoch && visible()) { ready = false; status(error.message || '连接不可用，请重新连接或重试原操作。'); }
    } finally { busy = false; controls(); schedule(); }
  }
  receive.addEventListener('click', () => action('receive', { jobId: job.jobId }, result => { receiving = result.jobId; receiveState.textContent = '正在接收同一候选…'; }));
  receiveCancel.addEventListener('click', async () => {
    if (!receiving || busy) return;
    try { await settings.requestManagement('wallpaper.jobs.cancel', { jobId: receiving }); receiveState.textContent = '正在取消，等待接收退出…'; }
    catch (error) { status(error.message); }
  });
  stopPreview.addEventListener('click', () => { stopCandidatePreview(); status('候选预览已结束。'); });
  el('connect').addEventListener('click', () => action('connect', {}, () => { ready = false; capability = null; assetSnapshot = null; status('请在播放器设置 → 连接 → AI 与外部连接中确认连接。'); }));
  el('disconnect').addEventListener('click', () => action('disconnect', {}, () => { connected = false; ready = false; capability = null; quote = null; assetSnapshot = null; job = null; el('job').textContent = ''; status('生成连接已断开。'); }));
  quoteForm.addEventListener('submit', event => {
    event.preventDefault();
    el('brief').setCustomValidity(el('brief').value.trim() ? '' : '请描述你想要的画面。');
    if (!quoteForm.reportValidity()) return;
    if (chosen('kind') === 'composition' && !selectedAssets.size) { status('请选择至少一项素材后再查看报价。'); materialRefresh.focus(); return; }
    const showQuote = result => {
    quote = result;
    const price = result.pricingMode === 'free' ? '本地离线 fixture，免费' : result.pricingMode === 'token-only'
      ? '费用未知 · 最多 ' + result.maxInputTokens + ' 输入 / ' + result.maxOutputTokens + ' 输出 token'
      : '费用预留上界 ' + result.maximumCostMicroUsd + ' micro-USD';
    const labels = { inputTokens: '输入 token', outputTokens: '输出 token', imageOutput: '图片张数' };
    const metering = Array.isArray(result.dimensions) ? result.dimensions.map(item => (labels[item.dimension] || item.dimension) + '最多 ' + item.quantityLimit + '，每 ' + item.unitScale + ' 单位 ' + item.unitPriceMicroUsd + ' micro-USD').join('；') : '';
    el('price-text').textContent = result.provider + ' / ' + result.model + ' · ' + price + (metering ? ' · ' + metering : '') + ' · 执行最多 ' + result.executionSeconds + ' 秒，含排队最多 ' + result.maximumWaitSeconds + ' 秒';
    status('报价有效期 5 分钟。' + (result.assetCount ? '绑定 ' + result.assetCount + ' 项素材。' : '') + '确认时将再次显示原生生成许可。');
    };
    if (chosen('kind') === 'composition' && (!assetSnapshot || assetSnapshot.expiresAt <= Date.now())) {
      action('asset-set.create', { selections: Array.from(selectedAssets.values()), rightsConfirmed: rights.checked }, async result => {
        assetSnapshot = result;
        showQuote(await request('generate.quote', { brief: el('brief').value, output: outputSpec() }));
      });
    } else action('generate.quote', { brief: el('brief').value, output: outputSpec() }, showQuote);
  });
  el('confirm').addEventListener('click', () => action('generate.confirm', {
    confirmationToken: quote && quote.confirmationToken,
    ...(externalRequest ? { externalRequestId: externalRequest.requestId } : {})
  }, result => {
    job = result.job || result; quote = null; externalRequest = null; externalSource.hidden = true;
    el('job').textContent = phases[job.state] || '任务已受理。'; status('本次请求已提交。');
  }));
  el('cancel').addEventListener('click', () => action('generate.cancel', { jobId: job.jobId, expectedStateRevision: job.stateRevision }, result => {
    job = result; el('job').textContent = phases[job.state] || '取消结果已返回。';
  }));
  el('recover').addEventListener('click', () => action('generate.recover', {}, result => {
    job = result.job; submissionPending = false; assetSnapshot = null; el('job').textContent = phases[job.state] || '原任务已受理。'; status('已找回原请求回执。');
  }));
  for (const name of ['brief', 'scene']) el(name).addEventListener('input', () => { if (name === 'brief') el(name).setCustomValidity(''); invalidateQuote(); controls(); });
  panel.addEventListener('toggle', () => { ++epoch; stop(); if (!visible()) stopCandidatePreview(); invalidateQuote(); if (visible()) { ready = false; capability = null; list.querySelectorAll('li').forEach(row => row.retryThumbnail?.()); refresh(); } });
  new MutationObserver(() => { ++epoch; stop(); if (!visible()) stopCandidatePreview(); invalidateQuote(); if (visible()) refresh(); })
    .observe(panel.closest('[role="tabpanel"]'), { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', () => { ++epoch; stop(); if (!visible()) stopCandidatePreview(); invalidateQuote(); if (visible()) refresh(); });
  window.addEventListener('wallpaper-ai-context', () => {
    const next = JSON.stringify(settings.currentAiContext());
    if (next === generationContext) return;
    generationContext = next; ++epoch; stop(); stopCandidatePreview(); ready = false; capability = null; quote = null; assetSnapshot = null; if (visible()) refresh();
  });
  window.addEventListener('pagehide', () => { stop(); stopCandidatePreview(); });
  window.hertzWallpaperGeneration = {
    openExternal(request) {
      if (busy || !['builtin', 'image', 'composition'].includes(request.outputKind)) throw new Error('当前生成操作尚未结束，请稍后打开申请。');
      externalRequest = request; externalSource.hidden = false;
      externalSource.textContent = '外部申请来源：' + request.label + '。请检查描述、类型与素材，再查看报价。';
      el('brief').value = request.brief; el('brief').setCustomValidity('');
      el('kind-' + request.outputKind).checked = true;
      panel.open = true; invalidateQuote(); controls();
      if (!el('brief').disabled) el('brief').focus();
      else if (!el('connect').hidden) el('connect').focus();
      else panel.querySelector('summary').focus();
    }
  };
  controls();
})();
