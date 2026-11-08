// SPDX-License-Identifier: MIT
// Persistent work editing is independent of the desktop settings revision.
(function () {
  'use strict';
  const settings = window.hertzWallpaperSettings;
  const request = (command, payload) => settings.requestManagement(command, payload).then(receipt => receipt.result);
  const clone = value => JSON.parse(JSON.stringify(value));
  const serialize = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.keys(item).sort().reduce((result, key) => { result[key] = item[key]; return result; }, {}) : item);
  const publicId = id => id.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  function node(tag, text, id) { const value = document.createElement(tag); if (text) value.textContent = text; if (id) value.id = id; return value; }
  function button(text, id, action) { const value = node('button', text, id); value.type = 'button'; value.addEventListener('click', () => { if (!busy) action().catch(error => message(error.message, true)); }); return value; }
  const section = node('details', '', 'work-editor'); section.className = 'local-library';
  section.append(node('summary', '我的场景作品'));
  const toolbar = node('div'); toolbar.className = 'library-toolbar';
  const open = node('select', '', 'work-draft-select'); open.setAttribute('aria-label', '已保存的作品草稿');
  toolbar.append(button('保存当前场景为作品', 'work-new', create), open, button('打开草稿', 'work-open', () => load(open.value)), button('刷新草稿', 'work-refresh', refresh));
  const status = node('p', '', 'work-message'); status.className = 'hint'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const editor = node('div', '', 'work-fields'); editor.hidden = true;
  function field(label, input) { const value = node('label'); value.className = 'field'; value.append(node('span', label), input); return value; }
  const title = node('input', '', 'work-title'); title.maxLength = 120; title.required = true;
  const description = node('textarea', '', 'work-description'); description.maxLength = 4000; description.rows = 2;
  const params = node('div', '', 'work-params');
  const publicHelp = node('p', '勾选“公开参数”后，使用此作品的人可以调整该参数。当前参数值是发布版本的默认值。'); publicHelp.className = 'hint';
  const actions = node('div'); actions.className = 'library-toolbar';
  actions.append(button('保存作品', 'work-save', () => flush()), button('生成版本', 'work-publish', publish), button('预览作品', 'work-preview', preview), button('重新读取', 'work-reload', reload), button('删除草稿', 'work-discard', discard));
  editor.append(field('作品名称', title), field('作品说明', description), publicHelp, params, actions);
  section.append(toolbar, status, editor);
  document.getElementById('local-library').after(section);
  let draft = null, documentValue = null, savedLocal = '', queue = Promise.resolve(), timer = 0, epoch = 0;
  let busy = false, activeAction = null, validBeforeLock = true;
  function message(text, error) { status.textContent = text; status.classList.toggle('error', !!error); }
  function ref() { return { draftId: draft.draftId, draftRevision: draft.draftRevision }; }
  function serial(action) { const task = queue.catch(() => {}).then(action); queue = task; return task; }
  function validForm() { return !draft || !documentValue || title.checkValidity() && Array.from(params.querySelectorAll('input,select')).every(input => input.checkValidity()); }
  function syncBusy() {
    section.setAttribute('aria-busy', String(busy));
    section.querySelectorAll('button, input, textarea, select').forEach(control => { control.disabled = busy; });
  }
  function exclusive(action) {
    if (busy) return Promise.reject(new Error('请等待当前作品操作完成。'));
    // Disabled controls no longer participate in browser constraint validation.
    // Preserve the old form's validity before locking, then flush under the lock.
    validBeforeLock = validForm(); busy = true; syncBusy();
    activeAction = Promise.resolve().then(action).finally(() => { busy = false; activeAction = null; syncBusy(); });
    return activeAction;
  }
  function edited() {
    if (busy || !documentValue) return;
    documentValue.title = title.value; documentValue.description = description.value;
    message('尚未保存…', false); clearTimeout(timer);
    timer = setTimeout(() => flush().catch(error => message('尚未保存：' + error.message, true)), 1000);
  }
  title.addEventListener('input', edited); description.addEventListener('input', edited);
  function refresh() { return exclusive(refreshDrafts); }
  async function refreshDrafts() {
    const selected = open.value; let cursor = null; const items = [];
    do { const page = await request('wallpaper.draft.list', { limit: 20, cursor }); items.push(...page.drafts); cursor = page.nextCursor; } while (cursor);
    open.replaceChildren();
    items.forEach(item => { const option = node('option', item.title); option.value = item.draftId; open.append(option); });
    if (items.some(item => item.draftId === selected)) open.value = selected;
    if (!items.length) { const option = node('option', '还没有作品草稿'); option.value = ''; open.append(option); }
  }
  async function readDocument(receipt) {
    let cursor = null; const values = {}, properties = [];
    do { const page = await request('wallpaper.draft.parameters', { draftId: receipt.draftId, draftRevision: receipt.draftRevision, limit: 30, cursor }); Object.assign(values, page.params); cursor = page.nextCursor; } while (cursor);
    do { const page = await request('wallpaper.draft.properties', { draftId: receipt.draftId, draftRevision: receipt.draftRevision, limit: 30, cursor }); properties.push(...page.properties); cursor = page.nextCursor; } while (cursor);
    return { title: receipt.title, description: receipt.description, sceneId: receipt.sceneId, stateVersion: receipt.stateVersion, params: values, properties };
  }
  function propertyFor(id) { return documentValue.properties.find(property => property.target.kind === 'node' && property.target.nodeId === 'content' && property.target.property === id && property.target.component == null); }
  function propertyDefinition(id, spec, label) {
    const constraints = spec.type === 'number' ? { min: spec.min, max: spec.max } : spec.type === 'select' ? { options: spec.options.map(option => typeof option === 'object' ? { value: option.value, label: option.label || String(option.value) } : { value: option, label: String(option) }) } : ['text','string'].includes(spec.type) ? { maxLength: spec.maxLength || 256 } : {};
    if (spec.type === 'number' && spec.step != null) constraints.step = spec.step;
    return { id: publicId(id), label, type: spec.type === 'string' ? 'text' : spec.type, default: clone(documentValue.params[id]), constraints, target: { kind: 'node', nodeId: 'content', property: id, component: null } };
  }
  async function show(receipt) {
    const current = ++epoch;
    const value = await readDocument(receipt);
    const schema = await request('wallpaper.draft.schema', { sceneId: value.sceneId });
    if (current !== epoch) return;
    draft = receipt; documentValue = value; savedLocal = serialize(value);
    title.value = value.title; description.value = value.description; params.replaceChildren();
    Object.entries(schema.params).forEach(([id, spec]) => {
      const exposed = propertyFor(id), initialValue = exposed ? exposed.default : value.params[id];
      const input = node(spec.type === 'select' ? 'select' : 'input'); input.dataset.workParam = id;
      function syncParameter(value) {
        const property = propertyFor(id), constraints = property ? property.constraints : spec;
        if (spec.type === 'select') {
          input.replaceChildren();
          constraints.options.forEach(option => { const optionNode = node('option', String(typeof option === 'object' ? option.label || option.value : option)); optionNode.value = JSON.stringify(typeof option === 'object' ? option.value : option); input.append(optionNode); });
          input.value = JSON.stringify(value);
        } else if (spec.type === 'boolean') { input.type = 'checkbox'; input.checked = value; }
        else {
          input.type = spec.type === 'number' ? 'number' : spec.type === 'color' ? 'color' : 'text'; input.value = value;
          if (spec.type === 'number') { input.min = constraints.min; input.max = constraints.max; input.step = 'any'; input.required = true; }
          if (['string','text'].includes(spec.type)) input.maxLength = constraints.maxLength == null ? 256 : constraints.maxLength;
        }
      }
      syncParameter(initialValue);
      input.addEventListener('input', () => {
        if (busy) return;
        input.setAttribute('aria-invalid', String(!input.checkValidity()));
        if (!input.checkValidity()) { message('尚未保存：请检查参数范围。', true); return; }
        documentValue.params[id] = spec.type === 'number' ? Number(input.value) : spec.type === 'boolean' ? input.checked : spec.type === 'select' ? JSON.parse(input.value) : input.value;
        const property = propertyFor(id); if (property) property.default = clone(documentValue.params[id]);
        edited();
      });
      const row = node('div'); row.append(field(spec.label || id, input));
      if (['number', 'boolean', 'select', 'color', 'text', 'string'].includes(spec.type)) {
        const expose = node('input'); expose.type = 'checkbox'; expose.checked = !!exposed; expose.dataset.workPublic = id;
        const exposeField = field('公开参数 · ' + (spec.label || id), expose); exposeField.classList.add('switch');
        const label = node('input'); label.type = 'text'; label.maxLength = 120; label.value = exposed ? exposed.label : spec.label || id; label.required = !!exposed; label.dataset.workPublicLabel = id;
        const labelField = field('公开名称', label); labelField.hidden = !exposed;
        expose.addEventListener('change', () => {
          if (busy) return;
          const previous = propertyFor(id);
          if (expose.checked && !previous) {
            const property = propertyDefinition(id, spec, label.value);
            if (documentValue.properties.some(existing => existing.id === property.id)) { expose.checked = false; message('无法公开此参数：已有公开参数使用相同标识，请先取消它的公开状态。', true); return; }
            documentValue.properties.push(property);
          }
          else if (!expose.checked && previous) { documentValue.params[id] = clone(previous.default); documentValue.properties = documentValue.properties.filter(property => property.id !== previous.id); }
          documentValue.properties.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
          syncParameter(propertyFor(id) ? propertyFor(id).default : documentValue.params[id]);
          label.required = expose.checked; label.setCustomValidity(expose.checked && !label.value.trim() ? '请填写公开名称' : ''); labelField.hidden = !expose.checked; edited();
        });
        label.addEventListener('input', () => {
          if (busy) return;
          label.setCustomValidity(label.value.trim() ? '' : '请填写公开名称');
          label.setAttribute('aria-invalid', String(!label.checkValidity()));
          const property = propertyFor(id); if (property) property.label = label.value; edited();
        });
        row.append(exposeField, labelField);
      }
      params.append(row);
    });
    syncBusy();
    editor.hidden = false; section.open = true;
    message(receipt.savedRevision === receipt.draftRevision ? '作品已保存。生成版本后可在本地作品中选择或导出。' : '草稿已恢复，尚未保存为作品。', false);
  }
  async function flush() {
    if (activeAction) await activeAction;
    return flushCurrent();
  }
  function operationsFor(previous, next) {
    const operations = [];
    if (previous.title !== next.title || previous.description !== next.description) operations.push({ kind: 'replaceMetadata', title: next.title, description: next.description });
    previous.properties.filter(property => !next.properties.some(item => item.id === property.id)).forEach(property => operations.push({ kind: 'removeProperty', id: property.id }));
    Object.entries(next.params).forEach(([id, value]) => { if (serialize(value) !== serialize(previous.params[id])) operations.push({ kind: 'setParam', id, value }); });
    next.properties.forEach(property => { if (serialize(property) !== serialize(previous.properties.find(item => item.id === property.id))) operations.push({ kind: 'setProperty', property }); });
    return operations;
  }
  function applyOperations(value, operations) {
    const next = clone(value);
    operations.forEach(operation => {
      if (operation.kind === 'replaceMetadata') { next.title = operation.title; next.description = operation.description; }
      else if (operation.kind === 'setParam') next.params[operation.id] = clone(operation.value);
      else if (operation.kind === 'removeProperty') next.properties = next.properties.filter(property => property.id !== operation.id);
      else if (operation.kind === 'setProperty') { next.properties = next.properties.filter(property => property.id !== operation.property.id); next.properties.push(clone(operation.property)); }
    });
    next.properties.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    return next;
  }
  async function updateDocument(input) {
    let previous = JSON.parse(savedLocal), operations = operationsFor(previous, input);
    while (operations.length) {
      const batch = [];
      while (operations.length && batch.length < 32) {
        const candidate = batch.concat(operations[0]);
        // Leave space for the management envelope, revision and request ID.
        if (new TextEncoder().encode(JSON.stringify(candidate)).length > 12 * 1024) {
          if (!batch.length) throw new Error('单项修改过大，请缩短公开名称或参数内容。');
          break;
        }
        batch.push(operations.shift());
      }
      const expected = applyOperations(previous, batch);
      try { draft = await request('wallpaper.draft.update', Object.assign(ref(), { operations: batch })); }
      catch (error) {
        if (!['receipt_timeout','draft_conflict','operation_pending'].includes(error.code)) throw error;
        const observed = await request('wallpaper.draft.get', { draftId: draft.draftId });
        const actual = await readDocument(observed);
        if (serialize(actual) !== serialize(expected)) throw new Error('作品已在其他位置修改。本地编辑已保留；可复制参数后点击“重新读取”。');
        draft = observed;
      }
      previous = expected; savedLocal = serialize(expected);
    }
  }
  async function flushCurrent() {
    clearTimeout(timer);
    if (!draft || !documentValue) return;
    const input = clone(documentValue), current = epoch;
    if (!(busy ? validBeforeLock : validForm())) throw new Error('请填写有效名称与场景参数。');
    await serial(async () => {
      if (current !== epoch) return;
      if (serialize(input) !== savedLocal) await updateDocument(input);
      if (draft.savedRevision !== draft.draftRevision) {
        try { draft = await request('wallpaper.draft.save', ref()); }
        catch (error) {
          if (!['receipt_timeout','operation_pending'].includes(error.code)) throw error;
          const observed = await request('wallpaper.draft.get', { draftId: draft.draftId });
          if (observed.draftRevision !== draft.draftRevision || observed.savedRevision !== draft.draftRevision) throw error;
          draft = observed;
        }
      }
      savedLocal = serialize(input);
      if (serialize(documentValue) === savedLocal) message('作品已保存。桌面选择由“应用设置”确认。', false);
    });
    // Close/open must also wait for edits made while the previous CAS was in flight.
    if (current === epoch && documentValue && serialize(documentValue) !== savedLocal) return flushCurrent();
  }
  function create() { return exclusive(async () => {
    await flushCurrent();
    const selected = settings.currentBuiltin();
    if (!selected) throw new Error('请先在上方选择一个固定场景，再保存为作品。');
    const receipt = await request('wallpaper.draft.create', { kind: 'work', document: { title: selected.title, sceneId: selected.sceneId, stateVersion: selected.stateVersion, params: selected.params } });
    await show(receipt); await flushCurrent(); await refreshDrafts(); open.value = receipt.draftId;
  }); }
  async function load(id) { if (!id) return; return exclusive(async () => { await flushCurrent(); await show(await request('wallpaper.draft.get', { draftId: id })); }); }
  function reload() { return exclusive(async () => {
    if (!draft || !confirm('重新读取会放弃当前未保存的作品编辑。继续？')) return;
    clearTimeout(timer); await queue.catch(() => {}); await show(await request('wallpaper.draft.get', { draftId: draft.draftId }));
  }); }
  function openVersion(work, version) { return exclusive(async () => {
    await flushCurrent();
    const receipt = await request('wallpaper.draft.create', { kind: 'work', workKey: work.workKey, packageHash: version.packageHash });
    await show(receipt); await refreshDrafts(); open.value = receipt.draftId;
  }); }
  function publish() { return exclusive(async () => {
    await flushCurrent(); if (!draft) return;
    const result = await serial(() => request('wallpaper.draft.publish', ref()));
    message('已生成版本 ' + result.version + '。在本地作品中选择、预览或导出此版本。', false);
    window.dispatchEvent(new Event('wallpaper-library-changed'));
  }); }
  function preview() { return exclusive(async () => {
    await flushCurrent(); if (!draft) return;
    await settings.previewWork(ref());
    message('正在预览作品，使用已应用的显示与音频设置。修改作品参数后可再次点击预览。', false);
  }); }
  function discard() { return exclusive(async () => {
    if (!draft || !confirm('删除这个作品草稿？已生成的版本会保留。')) return;
    clearTimeout(timer); await queue.catch(() => {});
    await settings.releasePreview();
    await request('wallpaper.draft.discard', ref()); ++epoch; draft = documentValue = null; editor.hidden = true;
    await refreshDrafts(); message('草稿已删除。', false);
  }); }
  section.addEventListener('toggle', () => { if (section.open && !busy) refresh().catch(error => message(error.message, true)); });
  window.addEventListener('pagehide', () => clearTimeout(timer));
  window.hertzWallpaperWork = { flush, openVersion };
})();
