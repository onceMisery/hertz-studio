(function () {
  'use strict';
  var $ = id => document.getElementById(id);
  var saved = null, draft = null, revision = 0, latest = null;
  var ready = false, dirty = false, conflict = false, previewActive = false, editing = false;
  var previewLease = null, mediaPreviewAvailable = false, previewGroupId = null, previewSequence = 0, previewTasks = 0;
  var previewMode = 'settings';
  var selectedGroupId = null, displaysEditor = null, displayCapabilities = null, capabilitiesError = null, capabilitiesPending = false, capabilitiesAttempts = 0;
  var scenes = [], profiles = [], monitors = [], currentProfile = null, spaceScene = null;
  var presetStyle = { sungColor:'#8fe3ff', unsungColor:'#ffffff', outlineColor:'#000000', outlineWidth:2, opacity:.92, fontWeight:600 };
  var presets = {
    single: Object.assign({}, presetStyle, { layout:'single', secondary:'next', fontSize:36, bilingual:false }),
    double: Object.assign({}, presetStyle, { layout:'double', secondary:'next', fontSize:32, bilingual:false }),
    triple: { layout:'triple', secondary:'next', fontSize:30, fontWeight:600, sungColor:'#ffffff', unsungColor:'#ffffff', outlineColor:'#000000', outlineWidth:0, opacity:1, bilingual:true, theme:'auto', surface:'glass', align:'center', karaoke:true, readabilityBoost:false },
    translation: Object.assign({}, presetStyle, { layout:'double', secondary:'translation', fontSize:30, fontWeight:500, outlineWidth:1.5, bilingual:true })
  };
  function currentPreset(lyrics) { return Object.keys(presets).find(key => Object.keys(presets[key]).every(field => presets[key][field] === lyrics[field])) || null; }
  async function requestClose() {
    if (window.hertzWallpaperWork) {
      try { await window.hertzWallpaperWork.flush(); }
      catch (error) { status('作品尚未保存：' + error.message, true); return; }
    }
    if (dirty || pending) { $('close-confirm').hidden = false; $('continue-editing').focus(); return; }
    send('close');
  }
  var previewTimer = 0, pending = false, activeTab = 'wallpaper', navigationId = -1;
  // 全局恢复快捷键（§5.1）：页面录入只采集按键，不充当全局快捷键实现。
  var hotkeyPending = false, recording = false, captured = null;
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function send(cmd, extra) {
    if (window.ipc && window.ipc.postMessage) window.ipc.postMessage(JSON.stringify(Object.assign({ cmd: cmd }, extra || {})));
  }
  var managementRequests = new Map();
  function requestManagement(command, payload, requestId, expectedRevision) {
    var id = requestId || crypto.randomUUID(), input = JSON.stringify({ command: command, payload: payload || {}, expectedRevision: expectedRevision });
    var existing = managementRequests.get(id);
    if (existing) {
      if (existing.input === input) return existing.promise;
      return Promise.reject(Object.assign(new Error('此请求编号已用于另一项操作。'), { code: 'request_id_conflict', requestId: id }));
    }
    if (managementRequests.size >= 4) return Promise.reject(Object.assign(new Error('请等待当前操作完成。'), { code: 'budget_busy', requestId: id }));
    var entry = { input: input, command: command, firstPage: !payload || !payload.cursor };
    var promise = new Promise(function (resolve, reject) {
      entry.resolve = resolve; entry.reject = reject;
      entry.timer = setTimeout(function () {
        managementRequests.delete(id);
        reject(Object.assign(new Error('操作结果尚未确认，请查询原操作。'), { code: 'receipt_timeout', requestId: id }));
      }, ['wallpaper.file.pick', 'wallpaper.export.pick'].includes(command) ? 300000 : command === 'wallpaper.draft.publish' ? 30000 : 5000);
      managementRequests.set(id, entry);
      try { window.ipc.postMessage(JSON.stringify({ protocol: 2, requestId: id, command: command, payload: payload || {}, expectedRevision: expectedRevision })); }
      catch (error) { managementRequests.delete(id); clearTimeout(entry.timer); error.requestId = id; reject(error); }
    });
    entry.promise = promise;
    return promise;
  }
  var nativeDraft = null, nativeQueue = Promise.resolve(), draftEpoch = 0, uncertainApply = null, applyInFlight = false;
  function serialNative(action) {
    var next = nativeQueue.catch(function () {}).then(action);
    nativeQueue = next;
    return next;
  }
  function managementError(error) {
    if (error.code === 'stale_draft') return;
    if (error.code === 'conflict' || error.code === 'draft_conflict') conflict = true;
    status(error.message || '操作未完成，草稿已保留。', true); syncControls();
  }
  async function updateNativeDraft(input, base, epoch) {
    if (epoch !== draftEpoch) throw Object.assign(new Error('草稿已释放。'), { code: 'stale_draft' });
    var ruleResults = inspectApplicationRules(input.wallpaper.applicationRules || []);
    var invalidRule = ruleResults.find(function (result) { return result.error; });
    if (invalidRule) throw new Error('请检查指定应用规则：' + invalidRule.error);
    var wallpaper = Object.assign({}, input.wallpaper, { applicationRules: ruleResults.map(function (result, index) { return { executable: result.identity, action: input.wallpaper.applicationRules[index].action }; }) });
    if (!nativeDraft) nativeDraft = (await requestManagement('wallpaper.draft.create', { kind: 'settings' })).result;
    if (nativeDraft.baseRevision !== base) throw Object.assign(new Error('设置已变化，请放弃修改后重新读取。'), { code: 'conflict' });
    var receipt = await requestManagement('wallpaper.draft.update', { draftId: nativeDraft.draftId, draftRevision: nativeDraft.draftRevision,
      operations: [{ kind: 'replaceWallpaper', wallpaper: wallpaper }, { kind: 'replaceLyrics', lyrics: input.lyrics }] });
    nativeDraft = receipt.result;
    if (epoch !== draftEpoch) throw Object.assign(new Error('草稿已释放。'), { code: 'stale_draft' });
    return { draftId: nativeDraft.draftId, draftRevision: nativeDraft.draftRevision };
  }
  function releaseNativeDraft() {
    ++draftEpoch; clearTimeout(previewTimer);
    invalidateGroupLayouts();
    invalidatePublicProperties();
    return serialNative(async function () {
      var reference = nativeDraft; nativeDraft = null;
      if (reference) await requestManagement('wallpaper.draft.discard', { draftId: reference.draftId, draftRevision: reference.draftRevision });
    }).catch(managementError);
  }
  function releaseNativePreview() {
    ++previewSequence; clearTimeout(previewTimer);
    previewActive = false; previewGroupId = null;
    return previewTask(function () {
      return serialNative(async function () {
        // Read inside the queue so a preceding acquire can never leave an orphan lease.
        var lease = previewLease; previewLease = null;
        if (lease) await requestManagement('wallpaper.preview.release', { leaseId: lease });
        else send('preview-close');
      }).catch(function (error) { if (error.code !== 'preview_lease_invalid') managementError(error); });
    });
  }
  function previewTask(action) {
    previewTasks++; syncControls();
    return action().finally(function () { previewTasks--; renderPreview(); syncControls(); });
  }
  function startNativePreview(update) {
    if (!draft || !mainGroup(draft.wallpaper) || update && previewMode !== 'settings') return Promise.resolve();
    if (publicPropertiesError()) { status(publicPropertiesError(), true); return Promise.resolve(); }
    var input = clone(draft), base = revision, epoch = draftEpoch, groupId = selectedGroupId, sequence = ++previewSequence;
    return previewTask(function () {
      return serialNative(async function () {
        var reference = await updateNativeDraft(input, base, epoch);
        if (epoch !== draftEpoch || sequence !== previewSequence || groupId !== selectedGroupId || activeTab !== 'wallpaper' || document.hidden) return;
        reference.groupId = groupId;
        var lease = previewLease;
        var receipt = await requestManagement(lease ? 'wallpaper.preview.update' : 'wallpaper.preview.acquire', lease ? Object.assign({ leaseId: lease }, reference) : reference);
        if (sequence !== previewSequence || groupId !== selectedGroupId) {
          await requestManagement('wallpaper.preview.release', { leaseId: receipt.result.leaseId });
          if (previewLease === receipt.result.leaseId) previewLease = null;
          return;
        }
        previewLease = receipt.result.leaseId; previewActive = true; previewGroupId = groupId; previewMode = 'settings';
      }).catch(function (error) { if (sequence === previewSequence) managementError(error); });
    });
  }
  function finishApply(operation) {
    if (!operation || operation.saved !== true) throw new Error('设置尚未保存，草稿已保留。');
    nativeDraft = null; ++draftEpoch; uncertainApply = null; applyInFlight = false; pending = false;
    dirty = false; conflict = false;
    revision = operation.configRevision || revision;
    status(operation.applyError || '设置已保存。', !!operation.applyError);
    send('status'); syncControls();
  }
  async function recoverApply(requestId) {
    try {
      var receipt = await requestManagement('wallpaper.operations.get', { requestId: requestId, command: "wallpaper.apply" });
      var operation = receipt.result;
      if (operation && operation.protocol === 2) {
        if (!operation.ok) throw Object.assign(new Error(operation.error.message), { code: operation.error.code });
        operation = operation.result;
      }
      if (operation && operation.saved === true) { finishApply(operation); return; }
      if (operation && (operation.saved === false || operation.state === 'config_conflict')) throw new Error('该次设置未保存；请重新读取后明确提交。');
      throw Object.assign(new Error('保存结果仍在确认，请保持设置窗口打开。'), { code: 'operation_pending' });
    } catch (error) {
      if (error.code === 'operation_pending' || error.code === 'receipt_timeout' || error.code === 'query_timeout' || error.code === 'config_busy') {
        status('正在查询原保存操作，请保持设置窗口打开。', true);
        setTimeout(function () { if (uncertainApply === requestId) recoverApply(requestId); }, 5000);
      } else {
        uncertainApply = null; applyInFlight = false; pending = false; conflict = true; managementError(error);
      }
    }
  }
  function applyNativeDraft() {
    var input = clone(draft), base = revision, epoch = draftEpoch;
    applyInFlight = true; pending = true; syncControls();
    serialNative(async function () {
      var reference = await updateNativeDraft(input, base, epoch);
      var requestId = crypto.randomUUID();
      try { finishApply((await requestManagement('wallpaper.apply', reference, requestId, base)).result); }
      catch (error) {
        if (error.code !== 'receipt_timeout' && error.code !== 'operation_pending') throw error;
        uncertainApply = requestId; status('正在核对保存结果，请保持设置窗口打开。', true); recoverApply(requestId);
      }
    }).catch(function (error) { applyInFlight = false; pending = false; managementError(error); syncControls(); });
  }
  function applyManagement(receipt) {
    if (!receipt || receipt.protocol !== 2) return;
    var waiting = managementRequests.get(receipt.requestId);
    if (!waiting) return;
    managementRequests.delete(receipt.requestId); clearTimeout(waiting.timer);
    if (receipt.ok) {
      waiting.resolve(receipt);
      if (['wallpaper.playlist.save', 'wallpaper.library.deleteVersion', 'wallpaper.library.deleteWork'].includes(waiting.command)
        || waiting.command === 'wallpaper.library.list' && waiting.firstPage
        || waiting.command === 'wallpaper.jobs.get' && receipt.result && receipt.result.kind === 'import' && receipt.result.state === 'done') { invalidateGroupLayouts(); invalidatePublicProperties(); }
    }
    else { var error = new Error(receipt.error && receipt.error.message || '操作未完成。'); error.code = receipt.error && receipt.error.code; error.receipt = receipt; error.requestId = receipt.requestId; waiting.reject(error); }
  }
  function status(text, error) { $('status').textContent = text; $('status').className = error ? 'error' : ''; }
  function profileKey(profile) { return profile ? String(profile.kind || 'standalone') + '|' + String(profile.pluginId || '') + '|' + String(profile.edition || '').toLowerCase() + '|' + String(profile.dataDir || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() : ''; }
  function groupById(wallpaper, id) { return wallpaper && Array.isArray(wallpaper.groups) ? wallpaper.groups.find(function (group) { return group.id === id; }) || null : null; }
  function mainGroup(wallpaper) { return groupById(wallpaper, selectedGroupId); }
  function presentation(wallpaper) { var group = mainGroup(wallpaper); return group ? group.presentation : {}; }
  function ensureSelectedGroup() {
    if (draft && !mainGroup(draft.wallpaper)) {
      if (previewLease || previewActive || previewTasks) releaseNativePreview();
      selectedGroupId = draft.wallpaper.groups[0] ? draft.wallpaper.groups[0].id : null;
      selectedWorkLookup = '';
    }
  }
  function selectGroup(id) {
    if (!draft || !groupById(draft.wallpaper, id) || selectedGroupId === id) return;
    if (previewLease || previewActive || previewTasks) releaseNativePreview();
    selectedGroupId = id; selectedWorkLookup = '';
    renderForm();
    if (latest) renderRuntime(latest);
    publishRuntime();
  }
  function selectedRuntime(payload) {
    var wallpaper = payload && payload.runtime && payload.runtime.wallpaper;
    if (!wallpaper) return null;
    if (Array.isArray(wallpaper.targets)) {
      var targets = wallpaper.targets.filter(function (target) { return target.groupId === selectedGroupId; });
      var target = targets.find(function (item) { return item.applyError || item.monitorMissing; }) || targets[0];
      return target ? Object.assign({}, target, { targets: targets }) : null;
    }
    // Older hosts only report their first group. Never display it as another group's status.
    return payload.config && payload.config.groups[0] && payload.config.groups[0].id === selectedGroupId ? Object.assign({}, wallpaper, { groupId: selectedGroupId }) : null;
  }
  function publishRuntime() { window.dispatchEvent(new CustomEvent('wallpaper-runtime-updated', { detail: selectedRuntime(latest) })); }
  function renderDisplays() {
    if (!displaysEditor) return;
    displaysEditor.render({ groups: draft && draft.wallpaper.groups, monitors: monitors, selectedGroupId: selectedGroupId,
      disabled: !ready || editing || pending || conflict, capabilities: displayCapabilities, loading: !ready, error: capabilitiesError,
      targets: latest && latest.runtime && latest.runtime.wallpaper && latest.runtime.wallpaper.targets || [] });
  }
  function acceptDisplayCapabilities(value) {
    if (!value || !Array.isArray(value.layouts) && typeof value.multiDisplay !== 'boolean') return false;
    var signature = JSON.stringify([value.layouts, value.multiDisplay, value.mirrorInspection, value.mirrorBuiltin, value.mirrorPackages, value.mirrorPlaylists, value.publicProperties]);
    if (signature !== layoutCapabilitiesKey) {
      layoutCapabilitiesKey = signature;
      displayCapabilities = clone(value);
      invalidateGroupLayouts();
      invalidatePublicProperties();
    }
    capabilitiesError = null; return true;
  }
  function readDisplayCapabilities() {
    if (displayCapabilities || capabilitiesPending || capabilitiesAttempts >= 3) return;
    capabilitiesPending = true; capabilitiesAttempts++;
    requestManagement('wallpaper.capabilities', {}).then(function (receipt) {
      if (!acceptDisplayCapabilities(receipt.result)) throw new Error('未能读取可用的显示方式。');
    }).catch(function (error) {
      if (['budget_busy', 'query_timeout', 'service_starting'].includes(error.code) && capabilitiesAttempts < 3) setTimeout(readDisplayCapabilities, 500);
      else capabilitiesError = error.message;
    }).finally(function () { capabilitiesPending = false; syncControls(); });
  }
  // Only current draft groups can consume inspection results. The small cache is
  // cleared on library/config changes; ordinary runtime updates never hash selections.
  var layoutCapabilitiesKey = '', layoutEpoch = 0, layoutEntries = new Map(), layoutCache = new Map();
  var layoutRequest = null, layoutTimer = 0, layoutDisposed = false;
  function publishGroupLayouts() {
    if (!displayCapabilities || displayCapabilities.mirrorInspection !== true) return;
    var layouts = Object.create(null), reasons = Object.create(null);
    layoutEntries.forEach(function (entry, id) {
      layouts[id] = entry.result ? entry.result.layouts.slice() : ['single', 'span'];
      if (entry.reason) reasons[id] = entry.reason;
    });
    displayCapabilities.groupLayouts = layouts;
    displayCapabilities.groupLayoutReasons = reasons;
  }
  function invalidateGroupLayouts() {
    layoutEpoch++;
    layoutCache.clear(); layoutEntries.clear();
    clearTimeout(layoutTimer); layoutTimer = 0;
    refreshGroupLayouts();
    if (ready) syncControls();
  }
  function refreshGroupLayouts() {
    if (layoutDisposed || !displayCapabilities || displayCapabilities.mirrorInspection !== true) return;
    var next = new Map(), groups = draft && draft.wallpaper && draft.wallpaper.groups;
    (Array.isArray(groups) ? groups.slice(0, 4) : []).forEach(function (group) {
      if (!group || typeof group.id !== 'string' || next.has(group.id)) return;
      var members = Array.isArray(group.displays) ? group.displays.length : 0;
      var key = JSON.stringify([group.selection, members]), entry = layoutEntries.get(group.id);
      if (!entry || entry.key !== key) {
        var cached = layoutCache.get(key);
        entry = { key: key, epoch: layoutEpoch, groupId: group.id, selection: clone(group.selection || null), members: members,
          attempts: 0, retryAt: 0, state: cached ? 'ready' : 'pending', result: cached || null,
          reason: cached ? cached.reason : '正在检查当前内容的镜像支持…' };
        if (!group.selection || members < 1 || members > 4) {
          entry.state = 'failed'; entry.result = null; entry.reason = '请先选择作品，并为此组保留 1–4 台显示器。';
        }
      }
      next.set(group.id, entry);
    });
    layoutEntries = next;
    publishGroupLayouts(); scheduleGroupLayoutCheck(0);
  }
  function scheduleGroupLayoutCheck(delay) {
    if (layoutDisposed || layoutRequest || layoutTimer) return;
    layoutTimer = setTimeout(function () { layoutTimer = 0; readGroupLayout(); }, delay);
  }
  function currentLayoutEntry(entry) {
    return !layoutDisposed && entry.epoch === layoutEpoch && layoutEntries.get(entry.groupId) === entry;
  }
  function inspectedLayouts(value, members) {
    if (!value || !Array.isArray(value.layouts) || typeof value.mirrorEligible !== 'boolean'
      || !Number.isInteger(value.maxMembers) || value.maxMembers < 1 || value.maxMembers > 4
      || value.layouts.some(function (mode) { return !['single', 'span', 'mirror'].includes(mode); })
      || !value.layouts.includes('single') || !value.layouts.includes('span')) throw new Error('桌面组件返回的布局检查结果不完整。');
    var eligible = value.mirrorEligible && value.layouts.includes('mirror') && members <= value.maxMembers;
    return { layouts: eligible ? ['single', 'span', 'mirror'] : ['single', 'span'],
      reason: eligible ? '' : typeof value.reason === 'string' && value.reason.trim() ? value.reason.trim().slice(0, 240) : '当前内容不支持镜像，可继续使用单屏或跨屏。' };
  }
  function readGroupLayout() {
    if (layoutDisposed || layoutRequest) return;
    var now = performance.now(), entry = null, polling = null, nextAt = Infinity;
    layoutEntries.forEach(function (candidate) {
      if (candidate.state !== 'pending') return;
      if (candidate.inspecting) polling = candidate;
      if (!entry && candidate.retryAt <= now) entry = candidate;
      nextAt = Math.min(nextAt, candidate.retryAt);
    });
    // Let the one native inspection finish before asking it to scan another group.
    if (polling) { entry = polling.retryAt <= now ? polling : null; nextAt = polling.retryAt; }
    if (!entry) { if (Number.isFinite(nextAt)) scheduleGroupLayoutCheck(Math.max(0, nextAt - now)); return; }
    layoutRequest = entry;
    requestManagement('wallpaper.layout.inspect', { selection: entry.selection, members: entry.members }).then(function (receipt) {
      if (!currentLayoutEntry(entry)) return;
      if (receipt.result && receipt.result.pending === true) {
        entry.inspecting = true; entry.attempts = 0; entry.retryAt = performance.now() + 500;
        entry.reason = '正在检查当前内容的镜像支持…';
        return;
      }
      var result = inspectedLayouts(receipt.result, entry.members);
      entry.result = result; entry.reason = result.reason; entry.state = 'ready'; entry.inspecting = false;
      if (layoutCache.size >= 16) layoutCache.delete(layoutCache.keys().next().value);
      layoutCache.set(entry.key, result);
      // Identical selections can share a verified result within this same draft context.
      layoutEntries.forEach(function (other) {
        if (other.key === entry.key) { other.result = result; other.reason = result.reason; other.state = 'ready'; }
      });
    }).catch(function (error) {
      if (!currentLayoutEntry(entry)) return;
      // An older draft's worker retains its reader slot until it actually exits.
      // Waiting for that slot is not an inspection failure or a new scan.
      if (error.code === 'budget_busy') {
        entry.retryAt = performance.now() + 500;
        entry.reason = '正在等待当前检查完成…';
        return;
      }
      entry.attempts++;
      var retry = entry.attempts < 3 && ['query_timeout', 'receipt_timeout', 'service_starting'].includes(error.code);
      entry.state = retry ? 'pending' : 'failed';
      if (!retry) entry.inspecting = false;
      entry.retryAt = performance.now() + entry.attempts * 500;
      entry.reason = retry ? '镜像检查暂未完成，正在重试…' : '未能确认镜像支持：' + String(error.message || '检查未完成').slice(0, 160) + ' 刷新作品库或重新选择内容后重试。';
    }).finally(function () {
      layoutRequest = null;
      publishGroupLayouts();
      if (!layoutDisposed) { syncControls(); scheduleGroupLayoutCheck(0); }
    });
  }
  var selectedWorkMetadata = null, selectedWorkLookup = '';
  // Metadata is read one page at a time, independently of runtime status polling.
  // Entry identity fences every reply against profile, revision and selection changes.
  var propertyEpoch = 0, propertyEntries = new Map(), propertyRequest = null, propertyTimer = 0, propertyDisposed = false;
  function hasOwn(object, id) { return Object.prototype.hasOwnProperty.call(object || {}, id); }
  function propertySelection(group) { return group && group.selection && ['package', 'playlist'].includes(group.selection.kind); }
  function invalidatePublicProperties() {
    propertyEpoch++; propertyEntries.clear(); clearTimeout(propertyTimer); propertyTimer = 0;
    refreshPublicProperties();
    if (ready) syncControls();
  }
  function refreshPublicProperties() {
    if (propertyDisposed) return;
    var next = new Map();
    (draft && draft.wallpaper.groups || []).slice(0, 4).forEach(function (group) {
      if (!propertySelection(group)) return;
      var key = JSON.stringify(group.selection), entry = propertyEntries.get(group.id);
      if (!entry || entry.key !== key) {
        entry = { groupId: group.id, key: key, epoch: propertyEpoch, selection: clone(group.selection), state: 'pending',
          properties: [], snapshot: null, cursor: null, cursors: new Set(), attempts: 0, retryAt: 0, reason: '' };
        if (displayCapabilities && displayCapabilities.publicProperties === false) { entry.state = 'failed'; entry.reason = '当前桌面组件尚不支持公开属性。'; }
      }
      next.set(group.id, entry);
    });
    propertyEntries = next; schedulePublicProperties(0);
  }
  function schedulePublicProperties(delay) {
    if (propertyDisposed || propertyRequest || propertyTimer) return;
    propertyTimer = setTimeout(function () { propertyTimer = 0; readPublicProperties(); }, delay);
  }
  function currentPropertyEntry(entry) {
    return !propertyDisposed && entry.epoch === propertyEpoch && propertyEntries.get(entry.groupId) === entry;
  }
  function propertyValueError(property, value) {
    var limits = property.constraints;
    if (property.type === 'number') return typeof value !== 'number' || !Number.isFinite(value) || value < limits.min || value > limits.max ? '请输入 ' + limits.min + ' 至 ' + limits.max + ' 之间的数值。' : '';
    if (property.type === 'boolean') return typeof value !== 'boolean' ? '请选择开启或关闭。' : '';
    if (property.type === 'select') return !limits.options.some(function (option) { return option.value === value; }) ? '请选择当前声明中的选项。' : '';
    if (property.type === 'asset') return !limits.options.includes(value) ? '请选择作品中声明的资源。' : '';
    if (property.type === 'color') return typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value) ? '请输入六位十六进制颜色，例如 #8fe3ff。' : '';
    if (property.type === 'text') return typeof value !== 'string' || value.length > limits.maxLength ? '文本最多 ' + limits.maxLength + ' 个 UTF-16 字符单位。' : '';
    return '此属性类型尚不支持。';
  }
  function checkedPropertyPage(value, entry) {
    if (!value || !Array.isArray(value.properties) || value.properties.length > 32 || !/^[a-f0-9]{64}$/i.test(value.snapshot)
      || value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !value.nextCursor || value.nextCursor.length > 4096)
      || entry.snapshot && entry.snapshot !== value.snapshot || entry.properties.length + value.properties.length > 64
      || value.nextCursor && (!value.properties.length || entry.cursors.has(value.nextCursor))) throw new Error('公开属性列表已变化或返回不完整，请重新读取。');
    var ids = new Set(entry.properties.map(function (property) { return property.id; }));
    value.properties.forEach(function (property) {
      var limits = property && property.constraints, type = property && property.type;
      if (!property || typeof property.id !== 'string' || !property.id || property.id.length > 128 || ids.has(property.id)
        || typeof property.label !== 'string' || !property.label || !limits || typeof limits !== 'object' || Array.isArray(limits)
        || !['number', 'boolean', 'select', 'color', 'text', 'asset'].includes(type)) throw new Error('公开属性声明不完整。');
      ids.add(property.id);
      if (type === 'number' && (!Number.isFinite(limits.min) || !Number.isFinite(limits.max) || limits.min > limits.max
        || hasOwn(limits, 'step') && (!Number.isFinite(limits.step) || limits.step <= 0))) throw new Error('数值属性的范围无效。');
      if (type === 'text' && (!Number.isInteger(limits.maxLength) || limits.maxLength < 0 || limits.maxLength > 4096)) throw new Error('文本属性的长度限制无效。');
      if ((type === 'select' || type === 'asset') && (!Array.isArray(limits.options) || !limits.options.length || limits.options.length > 64)) throw new Error('属性选项不完整。');
      if (type === 'select' && limits.options.some(function (option) { return !option || typeof option.label !== 'string' || !['string', 'number', 'boolean'].includes(typeof option.value) || typeof option.value === 'number' && !Number.isFinite(option.value); })) throw new Error('选项必须有名称与有效值。');
      if (type === 'asset' && limits.options.some(function (option) { return typeof option !== 'string' || !option; })) throw new Error('资源选项无效。');
      if (propertyValueError(property, property.default)) throw new Error('属性默认值不符合声明。');
    });
    return value;
  }
  function readPublicProperties() {
    if (propertyDisposed || propertyRequest) return;
    var now = performance.now(), entry = null, nextAt = Infinity;
    propertyEntries.forEach(function (candidate) {
      if (candidate.state !== 'pending') return;
      if (candidate.retryAt <= now && (!entry || candidate.cursor || candidate.groupId === selectedGroupId && !entry.cursor)) entry = candidate;
      nextAt = Math.min(nextAt, candidate.retryAt);
    });
    if (!entry) { if (Number.isFinite(nextAt)) schedulePublicProperties(Math.max(0, nextAt - now)); return; }
    propertyRequest = entry;
    requestManagement('wallpaper.properties.inspect', { selection: entry.selection, limit: 32, cursor: entry.cursor }).then(function (receipt) {
      if (!currentPropertyEntry(entry)) return;
      var page = checkedPropertyPage(receipt.result, entry);
      entry.properties.push.apply(entry.properties, page.properties); entry.snapshot = page.snapshot; entry.cursor = page.nextCursor;
      if (entry.cursor) entry.cursors.add(entry.cursor);
      entry.state = entry.cursor ? 'pending' : 'ready'; entry.attempts = 0; entry.retryAt = 0; entry.reason = '';
    }).catch(function (error) {
      if (!currentPropertyEntry(entry)) return;
      entry.attempts++;
      var retry = entry.attempts < 3 && ['budget_busy', 'query_timeout', 'receipt_timeout', 'service_starting'].includes(error.code);
      entry.state = retry ? 'pending' : 'failed'; entry.retryAt = performance.now() + entry.attempts * 250;
      entry.reason = retry ? '正在等待公开属性读取…' : '未能读取公开属性：' + String(error.message || '读取失败').slice(0, 160);
      if (!retry) entry.properties = [];
    }).finally(function () {
      propertyRequest = null;
      if (!propertyDisposed) { syncControls(); schedulePublicProperties(0); }
    });
  }
  function publicPropertiesError() {
    var groups = draft && draft.wallpaper.groups || [];
    for (var group of groups) {
      var overrides = group.properties || {}, ids = Object.keys(overrides), entry = propertyEntries.get(group.id);
      if (!ids.length) continue;
      if (!entry || entry.state !== 'ready') return '显示组 ' + (groups.indexOf(group) + 1) + ' 的公开属性尚未确认，请重新读取或恢复默认。';
      for (var id of ids) {
        var property = entry.properties.find(function (item) { return item.id === id; });
        if (!property) return '公开属性“' + id + '”已不在当前内容中，请恢复默认。';
        var error = propertyValueError(property, overrides[id]);
        if (error) return property.label + '：' + error;
      }
    }
    return '';
  }
  function propertyHelp(property) {
    var limits = property.constraints;
    if (property.type === 'number') return limits.min + ' – ' + limits.max + (limits.step ? ' · 建议步幅 ' + limits.step : '');
    if (property.type === 'text') return '最多 ' + limits.maxLength + ' 个字符，部分特殊字符占两位';
    if (property.type === 'asset') return '仅使用此作品声明的' + ({ image: '图片', video: '视频', audio: '音频' }[limits.kind] || '资源');
    if (property.type === 'color') return '六位十六进制颜色';
    return '仅影响当前显示组';
  }
  function renderPublicProperties(disabled) {
    var section = $('public-properties'), list = $('public-properties-list'), group = draft && mainGroup(draft.wallpaper);
    var overrides = group && group.properties || {}, entry = group && propertyEntries.get(group.id), supported = propertySelection(group);
    section.hidden = !supported && !Object.keys(overrides).length;
    var state = entry ? entry.state : 'failed', descriptors = state === 'ready' ? entry.properties : [];
    var unknown = Object.keys(overrides).filter(function (id) { return !descriptors.some(function (property) { return property.id === id; }); });
    var text = state === 'pending' ? entry.reason || '正在读取当前内容的公开属性…' : state === 'failed' ? entry && entry.reason || '当前内容不支持这些已保存的公开属性。'
      : descriptors.length ? (group.selection.kind === 'playlist' ? '仅显示列表中每一项都相同的属性。' : '调整仅用于当前显示组。') + ' 恢复默认后使用作品原值。'
      : '当前内容没有可调整的公开属性。' + (group && group.selection.kind === 'playlist' ? '列表项须声明完全相同的属性。' : '');
    $('public-properties-status').textContent = text;
    $('public-properties-status').classList.toggle('error', state === 'failed');
    $('public-properties-loading').hidden = state !== 'pending';
    $('public-properties-retry').hidden = !supported || state !== 'failed';
    $('public-properties-retry').disabled = disabled || conflict;
    section.setAttribute('aria-busy', String(state === 'pending'));
    // Retain DOM nodes while values/status are updated so typing and selection survive polling.
    var key = JSON.stringify([group && group.id, entry && entry.key, entry && entry.epoch, state, entry && entry.snapshot, unknown]);
    if (list.dataset.key !== key) {
      list.dataset.key = key; list.replaceChildren();
      var rows = descriptors.map(function (property) { return { id: property.id, property: property }; });
      if (state !== 'pending') unknown.forEach(function (id) { rows.push({ id: id, property: null }); });
      rows.forEach(function (item, index) {
        var property = item.property, row = document.createElement('div'); row.className = 'public-property'; row.dataset.propertyId = item.id;
        var field = document.createElement('label'); field.className = 'field';
        var title = document.createElement('span'); title.textContent = property ? property.label : item.id; field.appendChild(title);
        var help = document.createElement('small'); help.id = 'public-property-help-' + index; help.textContent = property ? propertyHelp(property) : '已保存的覆盖值无法匹配当前声明。';
        if (property) {
          var input = document.createElement(property.type === 'select' || property.type === 'asset' ? 'select' : 'input');
          input.dataset.propertyInput = item.id; input.id = 'public-property-input-' + index;
          input.setAttribute('aria-describedby', help.id + ' public-property-error-' + index);
          if (input.tagName === 'SELECT') {
            property.constraints.options.forEach(function (option, optionIndex) { var node = document.createElement('option'); node.value = String(optionIndex); node.textContent = property.type === 'select' ? option.label : option; input.appendChild(node); });
          } else {
            input.type = property.type === 'number' ? 'number' : property.type === 'boolean' ? 'checkbox' : 'text';
            if (property.type === 'boolean') input.setAttribute('role', 'switch');
            if (property.type === 'number') { input.min = property.constraints.min; input.max = property.constraints.max; input.step = 'any'; input.required = true; }
            if (property.type === 'text') input.maxLength = property.constraints.maxLength;
            if (property.type === 'color') { input.pattern = '#[a-fA-F0-9]{6}'; input.spellcheck = false; input.placeholder = '#8fe3ff'; }
          }
          field.appendChild(input);
          if (property.type === 'color') {
            field.htmlFor = input.id;
            var swatch = document.createElement('input'); swatch.type = 'color'; swatch.dataset.propertyInput = item.id; swatch.dataset.propertyColor = 'true';
            swatch.setAttribute('aria-label', property.label + '：选择颜色'); field.appendChild(swatch);
          }
        }
        field.appendChild(help);
        var error = document.createElement('p'); error.className = 'public-property-error'; error.id = 'public-property-error-' + index; error.setAttribute('aria-live', 'polite');
        var reset = document.createElement('button'); reset.type = 'button'; reset.dataset.propertyReset = item.id; reset.textContent = '恢复默认'; reset.setAttribute('aria-label', (property ? property.label : item.id) + '：恢复默认');
        row.append(field, error, reset); list.appendChild(row);
      });
    }
    Array.from(list.children).forEach(function (row) {
      var id = row.dataset.propertyId, property = descriptors.find(function (item) { return item.id === id; }), overridden = hasOwn(overrides, id);
      var value = overridden ? overrides[id] : property && property.default, input = row.querySelector('[data-property-input]');
      var error = property ? propertyValueError(property, value) : '此覆盖值无法使用。请恢复默认后再应用。';
      if (input) {
        if (document.activeElement !== input) {
          if (property.type === 'boolean') input.checked = value === true;
          else if (property.type === 'select' || property.type === 'asset') input.value = String(property.constraints.options.findIndex(function (option) { return (property.type === 'select' ? option.value : option) === value; }));
          else input.value = typeof value === 'object' ? JSON.stringify(value) : String(value);
        }
        input.disabled = disabled || conflict; input.setCustomValidity(error); input.setAttribute('aria-invalid', String(!!error));
        var swatch = row.querySelector('[data-property-color]');
        if (swatch) { if (!error) swatch.value = value; swatch.disabled = disabled || conflict; }
      }
      row.querySelector('.public-property-error').textContent = error; row.querySelector('.public-property-error').hidden = !error;
      row.querySelector('button').disabled = disabled || conflict || !overridden;
      row.dataset.overridden = String(overridden);
    });
  }
  // All cover consumers share one bounded request queue and a small static-image cache.
  var posterCache = new Map(), posterPending = new Map(), posterQueue = Promise.resolve(), posterRevision = 0;
  function readPoster(workKey, packageHash) {
    var key = workKey + ':' + packageHash;
    if (posterCache.has(key)) return Promise.resolve(posterCache.get(key));
    if (posterPending.has(key)) return posterPending.get(key);
    if (posterPending.size >= 16) return Promise.resolve(null);
    var task = posterQueue.then(async function () {
      var poster, revision;
      do {
        revision = posterRevision; poster = null;
        for (var attempt = 0; attempt < 3 && revision === posterRevision; attempt++) {
          try {
            var receipt = await requestManagement('wallpaper.library.poster', { workKey: workKey, packageHash: packageHash });
            var value = receipt.result.poster;
            if (value && Number.isInteger(value.width) && Number.isInteger(value.height) && value.width > 0 && value.height > 0 && Math.max(value.width, value.height) <= 320 && typeof value.data === 'string' && value.data.length <= 32768 && /^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) poster = 'data:image/jpeg;base64,' + value.data;
            break;
          } catch (error) {
            if (!['budget_busy','query_timeout','service_starting'].includes(error.code)) break;
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 200));
          }
        }
        // Keep the same queue slot while replacing a read that crossed preparation/refresh.
      } while (revision !== posterRevision);
      if (posterCache.size >= 32) posterCache.delete(posterCache.keys().next().value);
      posterCache.set(key, poster); posterPending.delete(key);
      return poster;
    });
    posterPending.set(key, task); posterQueue = task.catch(function () {});
    return task;
  }
  function invalidatePosters() {
    posterRevision++;
    posterCache.clear();
    if (selectedWorkMetadata) delete selectedWorkMetadata.poster;
    if (draft) renderPreview();
    window.dispatchEvent(new Event('wallpaper-posters-invalidated'));
  }
  function packageSelection(wallpaper) { var group = mainGroup(wallpaper), selection = group && group.selection; return selection && selection.kind === 'package' ? selection : null; }
  function playlistSelection(wallpaper) { var group = mainGroup(wallpaper), selection = group && group.selection; return selection && selection.kind === 'playlist' ? selection : null; }
  function mediaMetadata(wallpaper) { var selection = packageSelection(wallpaper); return selection && selectedWorkMetadata && selectedWorkMetadata.workKey === selection.workKey && selectedWorkMetadata.packageHash === selection.packageHash ? selectedWorkMetadata : null; }
  function readSelectedWork(wallpaper) {
    var selection = packageSelection(wallpaper);
    if (!selection) return;
    var key = selection.workKey + ':' + selection.packageHash;
    if (selectedWorkLookup === key || mediaMetadata(wallpaper)) return;
    selectedWorkLookup = key;
    requestManagement('wallpaper.library.get', { workKey: selection.workKey }).then(function (receipt) {
      if (selectedWorkLookup !== key) return;
      var version = receipt.result.versions.find(function (item) { return item.packageHash === selection.packageHash; });
      selectedWorkMetadata = { workKey: selection.workKey, packageHash: selection.packageHash, title: receipt.result.work.title, kind: receipt.result.work.kind, version: version && version.version };
      if (draft && packageSelection(draft.wallpaper) && mediaMetadata(draft.wallpaper)) { renderPreview(); syncControls(); }
    }).catch(function () { /* The persisted reference and native runtime error remain authoritative. */ });
  }
  function canChooseLibraryVersion(groupId) { return ready && !!draft && !!groupById(draft.wallpaper, groupId || selectedGroupId) && !editing && !pending && !conflict; }
  function replaceGroupSelection(group, selection) {
    if (JSON.stringify(group.selection) !== JSON.stringify(selection)) group.properties = {};
    group.selection = selection;
  }
  async function chooseLibraryVersion(work, version, groupId) {
    groupId = groupId || selectedGroupId;
    if (!canChooseLibraryVersion(groupId) || version.state !== 'installed' || !['image','video','builtin'].includes(work.kind)) return false;
    var input = clone(draft), base = revision, epoch = draftEpoch;
    replaceGroupSelection(groupById(input.wallpaper, groupId), { kind: 'package', workKey: work.workKey, packageHash: version.packageHash });
    pending = true; syncControls();
    try {
      if (previewActive || previewLease || previewTasks) await releaseNativePreview();
      // Register the reference before showing selection as complete. Other clients then
      // share the native draft's deletion guard even before Preview or Apply is clicked.
      await serialNative(function () { return updateNativeDraft(input, base, epoch); });
      draft = input;
      if (selectedGroupId === groupId) {
        selectedWorkLookup = '';
        selectedWorkMetadata = { workKey: work.workKey, packageHash: version.packageHash, title: work.title, kind: work.kind, version: version.version };
      }
      changed(true); renderForm();
      return true;
    } finally { pending = false; syncControls(); }
  }
  async function choosePlaylist(playlist, groupId) {
    groupId = groupId || selectedGroupId;
    if (!canChooseLibraryVersion(groupId)) return false;
    var input = clone(draft), base = revision, epoch = draftEpoch;
    replaceGroupSelection(groupById(input.wallpaper, groupId), { kind: 'playlist', playlistId: playlist.playlistId });
    pending = true; syncControls();
    try {
      await releaseNativePreview();
      await serialNative(function () { return updateNativeDraft(input, base, epoch); });
      draft = input; changed(true); renderForm(); return true;
    } finally { pending = false; syncControls(); }
  }
  function follows(wallpaper) { var group = mainGroup(wallpaper); return !!group && group.selection.kind === 'followHertz'; }
  function builtin(wallpaper) { var group = mainGroup(wallpaper), selection = group && group.selection; return !selection ? null : selection.kind === 'followHertz' ? selection.idleBuiltin : selection.kind === 'builtin' ? selection : null; }
  function selectedScene(wallpaper) { var state = builtin(wallpaper); return state && state.sceneId; }
  function setBuiltin(wallpaper, id, follow) {
    var state = builtin(wallpaper);
    state = state && state.sceneId === id ? { sceneId: state.sceneId, stateVersion: state.stateVersion, params: clone(state.params) } : { sceneId: id, stateVersion: 1, params: {} };
    replaceGroupSelection(mainGroup(wallpaper), follow ? { kind: 'followHertz', idleBuiltin: state } : Object.assign({ kind: 'builtin' }, state));
  }
  function sceneLabel(id) { var scene = scenes.find(item => item.id === id); return scene ? scene.label : id || '等待三维空间'; }
  function selectOptions(id, list, selected) {
    var node = $(id), key = list.map(item => item.value + '|' + item.label).join('\n');
    if (node.dataset.options !== key) {
      node.replaceChildren();
      list.forEach(function (item) { var option = document.createElement('option'); option.value = item.value; option.textContent = item.label; node.appendChild(option); });
      node.dataset.options = key;
    }
    if (selected && !Array.from(node.options).some(option => option.value === selected)) {
      var missing = document.createElement('option'); missing.value = selected; missing.textContent = selected + '（未连接）'; node.appendChild(missing);
    }
    node.value = selected || ''; node.title = node.selectedOptions[0] ? node.selectedOptions[0].textContent : '';
  }
  function renderMetadata(payload) {
    if (payload.scenes) scenes = payload.scenes;
    if (payload.profiles) profiles = payload.profiles;
    if (payload.monitors) monitors = payload.monitors;
    if (Object.prototype.hasOwnProperty.call(payload, 'profile')) currentProfile = payload.profile;
    spaceScene = payload.spaceScene || null;
    var previous = $('profile').value;
    selectOptions('profile', profiles.map(function (profile) {
      var name = String(profile.dataDir || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      return { value: profileKey(profile), label: (profile.kind === 'dbx' ? 'DBX · ' : '') + (profile.edition === 'custom' ? 'Custom' : profile.edition === 'standard' ? 'Standard' : 'Full') + ' · ' + name };
    }), previous || profileKey(currentProfile) || profileKey(profiles[0]));
    if (payload.message === '已切换来源') $('profile').value = profileKey(currentProfile);
    if (draft) {
      var endpoints = payload.runtime && payload.runtime.wallpaper && payload.runtime.wallpaper.audio && payload.runtime.wallpaper.audio.endpoints || [];
      var input = draft.wallpaper.audioInput, fixed = input.device && input.device.kind === 'fixed' ? input.device.id : '';
      selectOptions('audio-device', [{ value: '', label: '默认播放设备（自动跟随）' }].concat(endpoints.map(function (endpoint) {
        return { value: endpoint.id, label: endpoint.name + (endpoint.isDefault ? ' · 默认' : '') };
      })), fixed);
      if (fixed && !endpoints.some(function (endpoint) { return endpoint.id === fixed; })) $('audio-device').selectedOptions[0].textContent = '固定设备（当前不可用）';
      selectOptions('scene-fixed', scenes.map(scene => ({ value: scene.id, label: scene.label })), selectedScene(draft.wallpaper));
    }
    var signature = scenes.map(scene => scene.id + scene.label).join('|');
    if ($('scene-grid').dataset.scenes !== signature) {
      $('scene-grid').replaceChildren();
      scenes.forEach(function (scene, index) {
        var button = document.createElement('button'); button.type = 'button'; button.dataset.scene = scene.id;
        var image = document.createElement('img'); image.src = '/scene-thumbnails/' + scene.id + '.jpg'; image.alt = ''; image.loading = 'lazy';
        var text = document.createElement('span'); text.className = 'scene-text';
        var name = document.createElement('span'); name.className = 'scene-name'; name.textContent = scene.label;
        var small = document.createElement('small'); small.textContent = String(index + 1).padStart(2, '0') + ' / 动态场景';
        text.append(name, small); button.append(image, text); button.addEventListener('click', function () { if (!canChooseLibraryVersion()) return; setBuiltin(draft.wallpaper, scene.id, false); changed(true); renderForm(); });
        $('scene-grid').appendChild(button);
      });
      $('scene-grid').dataset.scenes = signature;
    }
    updateProfilePath();
  }
  function updateProfilePath() {
    var selected = profiles.find(profile => profileKey(profile) === $('profile').value);
    $('profile-path').textContent = selected ? selected.dataDir : '';
    $('profile').title = selected ? selected.dataDir : '';
    var canSwitch = !!selected && profileKey(selected) !== profileKey(currentProfile);
    document.querySelector('.source-actions').hidden = !canSwitch;
    $('switch-source').disabled = !ready || !canSwitch || dirty || editing || pending;
  }
  function normalizeExecutablePath(input) {
    if (/[\u0000-\u001f\u007f-\u009f]/.test(input)) throw new Error('路径不能包含换行、制表符或其他控制字符。');
    var path = input.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
    if (!path) throw new Error('请填写完整可执行文件路径。');
    if (path.length > 1024) throw new Error('路径不能超过 1024 个 Windows 字符。');
    path = path.replace(/\//g, '\\').toLowerCase();
    if (path.startsWith('\\\\?\\')) {
      path = path.slice(4);
      if (path.startsWith('unc\\')) path = '\\\\' + path.slice(4);
      else if (!/^[a-z]:\\/.test(path)) throw new Error('不支持设备命名空间路径。');
    }
    if (/["<>|?*]/.test(path) || path.endsWith('\\')) throw new Error('请填写文件路径，不含引号、通配符或命令参数。');
    function validComponent(component) { return !!component && component !== '.' && component !== '..' && !/[. ]$/.test(component) && !component.includes(':'); }
    var root, tail;
    if (/^[a-z]:\\/.test(path)) { root = path.slice(0, 3); tail = path.slice(3); }
    else if (path.startsWith('\\\\')) {
      var parts = path.slice(2).split('\\'), server = parts.shift(), share = parts.shift();
      if (!validComponent(server) || !validComponent(share)) throw new Error('UNC 路径须包含服务器、共享名与文件路径。');
      root = '\\\\' + server + '\\' + share + '\\'; tail = parts.join('\\');
    } else throw new Error('请使用盘符绝对路径或 UNC 路径；不接受文件名、相对路径或环境变量。');
    var components = [];
    tail.split('\\').forEach(function (component) {
      if (!component || component === '.') return;
      if (component === '..') {
        if (!components.length) throw new Error('路径不能超出盘符或共享根目录。');
        components.pop(); return;
      }
      var stem = component.split('.')[0].replace(/\p{White_Space}+$/u, '');
      if (!validComponent(component) || /^(con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³])$/.test(stem)) throw new Error('路径包含无效或保留的文件名。');
      components.push(component);
    });
    if (!components.length) throw new Error('路径须包含可执行文件，不能只填写根目录。');
    path = root + components.join('\\');
    if (path.length > 1024) throw new Error('路径不能超过 1024 个 Windows 字符。');
    return path;
  }
  function inspectApplicationRules(rules) {
    var identities = new Map();
    var results = rules.map(function (rule) {
      try { return { identity: normalizeExecutablePath(rule.executable), error: ['pause','stop'].includes(rule.action) ? '' : '请选择暂停或停止。' }; }
      catch (error) { return { identity: null, error: error.message }; }
    });
    results.forEach(function (result, index) {
      if (index >= 32) { result.error = '最多可设置 32 条应用规则。'; return; }
      if (!result.identity) return;
      if (identities.has(result.identity)) {
        var previous = identities.get(result.identity);
        result.error = '与第 ' + (previous + 1) + ' 条规则是同一路径，请只保留一条。';
        results[previous].error = '与第 ' + (index + 1) + ' 条规则是同一路径，请只保留一条。';
      } else identities.set(result.identity, index);
    });
    return results;
  }
  function renderApplicationRules(replaceFocused) {
    if (!draft) return;
    $('pause-on-fullscreen').checked = draft.wallpaper.pauseOnFullscreen !== false;
    $('pause-on-maximized').checked = draft.wallpaper.pauseOnMaximized === true;
    var rules = draft.wallpaper.applicationRules || [], list = $('application-rules');
    while (list.children.length > rules.length) list.lastElementChild.remove();
    rules.forEach(function (rule, index) {
      var row = list.children[index];
      if (!row) {
        row = document.createElement('li'); row.className = 'application-rule'; row.dataset.ruleIndex = String(index);
        var pathField = document.createElement('label'); pathField.className = 'field application-rule-path';
        var pathLabel = document.createElement('span'); pathLabel.textContent = '完整可执行文件路径';
        var pathInput = document.createElement('input'); pathInput.type = 'text'; pathInput.required = true; pathInput.autocomplete = 'off'; pathInput.spellcheck = false; pathInput.dataset.ruleField = 'executable';
        pathInput.id = 'application-rule-path-' + index; pathInput.setAttribute('aria-describedby', 'application-rules-help application-rule-error-' + index);
        pathInput.placeholder = 'C:\\Apps\\Player.exe'; pathField.append(pathLabel, pathInput);
        var actionField = document.createElement('label'); actionField.className = 'field application-rule-action';
        var actionLabel = document.createElement('span'); actionLabel.textContent = '触发动作';
        var actionSelect = document.createElement('select'); actionSelect.dataset.ruleField = 'action';
        [['pause','暂停 · Pause'],['stop','停止 · Stop']].forEach(function (entry) { var option = document.createElement('option'); option.value = entry[0]; option.textContent = entry[1]; actionSelect.appendChild(option); });
        actionField.append(actionLabel, actionSelect);
        var remove = document.createElement('button'); remove.type = 'button'; remove.className = 'application-rule-remove'; remove.textContent = '移除'; remove.setAttribute('aria-label', '移除第 ' + (index + 1) + ' 条应用规则');
        var error = document.createElement('p'); error.className = 'application-rule-error'; error.id = 'application-rule-error-' + index; error.setAttribute('aria-live', 'polite'); error.hidden = true;
        row.append(pathField, actionField, remove, error); list.appendChild(row);
      }
      var input = row.querySelector('input'), select = row.querySelector('select');
      if (replaceFocused || input !== document.activeElement) input.value = rule.executable;
      if (replaceFocused || select !== document.activeElement) select.value = rule.action;
    });
  }
  function syncApplicationRules(disabled) {
    var rules = draft && draft.wallpaper.applicationRules || [], results = inspectApplicationRules(rules);
    document.querySelectorAll('#window-policy-settings input, #window-policy-settings select, #window-policy-settings button').forEach(function (node) { node.disabled = disabled || conflict; });
    $('application-rule-add').disabled = disabled || conflict || rules.length >= 32;
    $('application-rules-count').textContent = rules.length + ' / 32 条';
    $('application-rules-empty').hidden = rules.length > 0;
    $('application-rules-limit').hidden = rules.length < 32;
    results.forEach(function (result, index) {
      var row = $('application-rules').children[index];
      if (!row) return;
      var input = row.querySelector('input'), error = row.querySelector('.application-rule-error');
      input.setCustomValidity(result.error); input.setAttribute('aria-invalid', String(!!result.error));
      if (error.textContent !== result.error) error.textContent = result.error;
      error.hidden = !result.error;
    });
    return results.find(function (result) { return result.error; });
  }
  function settingsInvalid() {
    return !!publicPropertiesError() || !!document.querySelector('#panel-lyrics .properties input:invalid, #panel-wallpaper .properties input:invalid')
      || !!(draft && inspectApplicationRules(draft.wallpaper.applicationRules || []).some(function (result) { return result.error; }));
  }
  function renderForm(replaceFocused) {
    if (!draft) return;
    renderApplicationRules(replaceFocused);
    var wallpaper = draft.wallpaper, lyrics = draft.lyrics;
    var group = mainGroup(wallpaper);
    if (!group) { syncControls(); return; }
    $('selected-group-status').textContent = '正在编辑显示组 ' + (wallpaper.groups.indexOf(group) + 1) + ' · 场景与画面参数仅用于此组';
    $('enabled').checked = !!wallpaper.enabled; $('fps').value = String(presentation(wallpaper).fps); $('music').value = wallpaper.audioInput.kind;
    $('audio-gain').value = String(wallpaper.audioInput.gain == null ? 1 : wallpaper.audioInput.gain);
    $('audio-attack').value = String(wallpaper.audioInput.attackMs == null ? 40 : wallpaper.audioInput.attackMs);
    $('audio-release').value = String(wallpaper.audioInput.releaseMs == null ? 250 : wallpaper.audioInput.releaseMs);
    $('scene-source').value = playlistSelection(wallpaper) ? 'playlist' : packageSelection(wallpaper) ? 'library' : follows(wallpaper) ? 'follow' : 'fixed';
    $('media-fit').value = presentation(wallpaper).fit || 'cover';
    readSelectedWork(wallpaper);
    $('quality').value = presentation(wallpaper).quality || 'low';
    $('brightness').value = String(presentation(wallpaper).brightness == null ? 1 : presentation(wallpaper).brightness);
    $('motion').value = String(presentation(wallpaper).motion == null ? 1 : presentation(wallpaper).motion);
    $('pointer').checked = presentation(wallpaper).pointer === true;
    $('brightness-value').textContent = Math.round(($('brightness').value || 1) * 100) + '%';
    $('motion-value').textContent = Math.round(($('motion').value == null ? 100 : $('motion').value * 100)) + '%';
    if (latest) renderMetadata(latest);
    $('lyrics-enabled').checked = !!lyrics.enabled; $('lyrics-locked').checked = !!lyrics.locked;
    // 「翻译」选项已并入译文；存量 translation 值按译文显示，草稿保持原值直到用户主动改选。
    $('lyrics-secondary').value = lyrics.secondary === 'translation' ? 'next' : lyrics.secondary;
    $('lyrics-size').value = String(lyrics.fontSize); $('lyrics-weight').value = String(lyrics.fontWeight);
    // Native config also accepts shorthand/alpha hex; color inputs display its RGB component without changing the draft.
    function rgb(value) { var hex = String(value || '#ffffff'); return hex.length === 4 ? '#' + hex.slice(1).split('').map(c => c + c).join('') : hex.slice(0, 7); }
    $('lyrics-sung').value = rgb(lyrics.sungColor); $('lyrics-unsung').value = rgb(lyrics.unsungColor); $('lyrics-outline').value = rgb(lyrics.outlineColor);
    $('lyrics-stroke').value = String(lyrics.outlineWidth); $('lyrics-opacity').value = String(lyrics.opacity);
    renderPreview(); syncControls();
  }
  function renderPreview() {
    if (!draft) return;
    var wallpaper = draft.wallpaper, lyrics = draft.lyrics;
    var current = follows(wallpaper) && scenes.some(scene => scene.id === spaceScene) ? spaceScene : selectedScene(wallpaper);
    var selection = packageSelection(wallpaper), metadata = mediaMetadata(wallpaper);
    $('scene-heading').textContent = selection ? metadata && metadata.title || '本地作品' : sceneLabel(current);
    $('scene-following').textContent = !follows(wallpaper) ? '固定场景 · ' + sceneLabel(current) : (spaceScene ? '跟随三维空间 · ' : '等待来源 · ') + sceneLabel(current);
    if (selection) $('scene-following').textContent = (metadata && metadata.kind === 'video' ? '视频' : metadata && metadata.kind === 'image' ? '图片' : '本地作品') + (metadata && metadata.version ? ' · 版本 ' + metadata.version : ' · 固定版本');
    $('preview-placeholder-title').textContent = previewActive ? '独立预览窗口已打开' : selection ? '本地作品已选入草稿' : '先看效果，再应用到桌面';
    $('preview-placeholder-text').textContent = previewActive ? '可在预览窗口查看当前草稿。结束预览或切换页面会关闭窗口；桌面保持已应用的画面。' : selection ? mediaPreviewAvailable ? '点击开始预览，在独立窗口查看图片或静音视频。应用后，桌面会在新作品就绪时切换。' : '点击应用后在桌面查看。媒体实时预览尚未提供；当前桌面画面会保留到新作品就绪。' : '点击开始预览，在独立窗口查看真实场景与当前音乐效果，不会修改已保存的设置。';
    if (selection && metadata && metadata.kind === 'builtin' && !previewActive) $('preview-placeholder-text').textContent = '预览保存的场景参数与音频效果；应用后切换桌面。';
    if (playlistSelection(wallpaper)) {
      $('scene-heading').textContent = '轮播列表'; $('scene-following').textContent = '按列表中的固定版本轮播';
      if (!previewActive) $('preview-placeholder-text').textContent = '预览列表首项。应用后开始计时，暂停时冻结，失败后可重试。';
    }
    var previewState = latest && latest.mediaPreview;
    if (previewActive && previewState && previewState.handoff) {
      $('preview-placeholder-title').textContent = previewState.error ? '新预览未能显示 · 保留上一帧' : '正在更新预览 · 保留上一帧';
      $('preview-placeholder-text').textContent = previewState.error || '新画面就绪后自动显示。结束预览会关闭窗口。';
    }
    if (current && !scenes.some(scene => scene.id === current)) $('scene-following').textContent += '（暂不支持壁纸）';
    document.querySelectorAll('[data-scene]').forEach(node => node.setAttribute('aria-pressed', String(!follows(wallpaper) && node.dataset.scene === selectedScene(wallpaper))));
    var preset = currentPreset(lyrics);
    document.querySelectorAll('[data-preset]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.preset === preset)));
    $('lyrics-preset-status').textContent = preset ? ({single:'单行预设',double:'双行预设',triple:'三行景深预设',translation:'翻译预设'})[preset] : '自定义样式';
    var staticScene = scenes.find(scene => scene.id === current) || scenes.find(scene => scene.id === selectedScene(wallpaper));
    var staticImage = $('scene-static');
    if (selection && metadata && metadata.kind === 'video' && metadata.poster === undefined) {
      var coverRevision = posterRevision;
      metadata.poster = null;
      readPoster(selection.workKey, selection.packageHash).then(function (poster) {
        if (coverRevision !== posterRevision) return;
        metadata.poster = poster;
        if (draft && mediaMetadata(draft.wallpaper) === metadata) renderPreview();
      });
    }
    var cover = selection && metadata && metadata.poster;
    if (cover) {
      if (staticImage.getAttribute('src') !== cover) staticImage.src = cover;
      staticImage.alt = metadata.title + ' · 视频封面';
    } else if (staticScene && !selection) {
      var thumbnail = '/scene-thumbnails/' + staticScene.id + '.jpg';
      if (staticImage.getAttribute('src') !== thumbnail) staticImage.src = thumbnail;
      staticImage.alt = sceneLabel(staticScene.id) + ' · 真实场景静态参考';
    } else { staticImage.removeAttribute('src'); }
    staticImage.style.objectFit = selection ? presentation(wallpaper).fit === 'stretch' ? 'fill' : presentation(wallpaper).fit : 'cover';
    staticImage.hidden = previewActive || !(cover || !selection && staticScene);
    $('preview-placeholder').hidden = !staticImage.hidden;
    $('preview-kind').textContent = previewActive ? '独立窗口预览' : selection ? cover ? '视频封面' : '本地作品' : '真实场景静态参考';
    var style = $('lyrics-preview').style;
    style.setProperty('--font-size', lyrics.fontSize + 'px'); style.setProperty('--font-weight', String(lyrics.fontWeight));
    style.setProperty('--font-family', lyrics.fontFamily); style.setProperty('--sung', lyrics.sungColor); style.setProperty('--unsung', lyrics.unsungColor);
    style.setProperty('--outline', lyrics.outlineColor); style.setProperty('--stroke', lyrics.outlineWidth + 'px'); style.setProperty('--opacity', String(lyrics.opacity));
    $('lyric-previous').hidden = lyrics.layout !== 'triple';
    $('lyric-next').hidden = lyrics.layout === 'single';
    $('lyrics-preview').classList.toggle('has-depth', lyrics.layout === 'triple');
    $('lyric-secondary').hidden = lyrics.bilingual === false;
    $('lyric-secondary').textContent = lyrics.secondary === 'romanization' ? 'Rang yin yue liu zai ci ke' : 'Let the music stay in this moment';
    $('lyrics-secondary').value = lyrics.secondary === 'translation' ? 'next' : lyrics.secondary;
    $('opacity-value').textContent = Math.round(lyrics.opacity * 100) + '%';
  }
  function syncControls() {
    $('pointer').disabled = !ready || editing || pending || conflict;
    var disabled = !ready || editing || pending;
    var invalidRule = syncApplicationRules(disabled);
    refreshPublicProperties(); renderPublicProperties(disabled);
    ['enabled','fps','quality','brightness','motion','music','scene-source','lyrics-enabled','lyrics-locked','lyrics-size','lyrics-weight','lyrics-sung','lyrics-unsung','lyrics-outline','lyrics-stroke','lyrics-opacity','profile'].forEach(id => $(id).disabled = disabled);
    $('scene-fixed').disabled = disabled || !draft || !builtin(draft.wallpaper);
    var packageValue = draft && packageSelection(draft.wallpaper), metadata = draft && mediaMetadata(draft.wallpaper), playlistValue = draft && playlistSelection(draft.wallpaper);
    var mediaSelection = packageValue && (!metadata || metadata.kind !== 'builtin');
    var isVideo = metadata && metadata.kind === 'video';
    $('scene-source').querySelector('[value=library]').hidden = !packageValue;
    $('scene-source').querySelector('[value=playlist]').hidden = !playlistValue;
    $('scene-fixed').closest('label').hidden = !!packageValue || !!playlistValue;
    ['fps','quality'].forEach(function (id) { $(id).disabled = disabled || !!mediaSelection; });
    var audioInput = draft && draft.wallpaper.audioInput;
    $('audio-device-field').hidden = !audioInput || audioInput.kind !== 'system';
    $('audio-device').disabled = disabled || !audioInput || audioInput.kind !== 'system';
    ['audio-gain','audio-attack','audio-release'].forEach(function (id) { $(id).disabled = disabled || !audioInput || audioInput.kind === 'none'; });
    $('audio-options').hidden = !audioInput || audioInput.kind === 'none';
    var audioRuntime = latest && latest.runtime && latest.runtime.wallpaper && latest.runtime.wallpaper.audio;
    $('audio-retry').disabled = disabled || !audioRuntime || !audioRuntime.requested;
    $('motion').disabled = disabled || (!!mediaSelection && !isVideo && !presentation(draft.wallpaper).pointer);
    $('media-fit-field').hidden = !mediaSelection;
    $('media-fit').disabled = disabled || !mediaSelection;
    $('media-rate-note').hidden = !mediaSelection;
    $('media-rate-note').textContent = isVideo ? '视频保持原速静音播放；流畅度和场景画质设置不改变源视频。运动强度为 0 时冻结当前帧。' : '静态图片没有连续帧循环；流畅度、场景画质和音乐律动不影响图片。';
    $('motion').title = isVideo ? '0 冻结当前帧，其余值均保持视频原速' : '';

    $('lyrics-secondary').disabled = disabled || !draft || draft.lyrics.layout === 'single';
    document.querySelectorAll('[data-preset],[data-scene]').forEach(node => node.disabled = disabled);
    var displayIssues = window.hertzWallpaperDisplays && draft ? window.hertzWallpaperDisplays.inspect({ groups: draft.wallpaper.groups, monitors: monitors, capabilities: displayCapabilities }).issues : [];
    if (draft && !draft.wallpaper.enabled && saved) {
      // Broken media must not prevent turning off an unchanged saved group.
      // New content or membership still requires native mirror qualification.
      displayIssues = displayIssues.filter(function (issue) {
        if (issue.code !== 'mirror-unavailable') return true;
        var previous = groupById(saved.wallpaper, issue.groupId), current = groupById(draft.wallpaper, issue.groupId);
        return !previous || !current || previous.mode !== current.mode
          || JSON.stringify([previous.displays, previous.selection]) !== JSON.stringify([current.displays, current.selection]);
      });
    }
    $('apply').disabled = disabled || !dirty || conflict || displayIssues.length > 0 || settingsInvalid();
    $('apply').title = invalidRule ? invalidRule.error : displayIssues.length ? displayIssues[0].text : publicPropertiesError();
    $('discard').disabled = !ready || !dirty || editing || pending;
    $('position-begin').disabled = disabled || dirty;
    $('position-begin').title = dirty ? '请先应用或放弃草稿，再调整桌面位置' : '';
    $('position-session').hidden = !editing; $('position-begin').hidden = editing;
    $('autostart').disabled = disabled || dirty || !latest || latest.launchAtLogin == null;
    $('hotkey-edit').disabled = disabled || dirty || hotkeyPending || recording;
    $('hotkey-clear').disabled = disabled || dirty || hotkeyPending || recording;
    $('hotkey-record').disabled = hotkeyPending;
    $('hotkey-save').disabled = hotkeyPending || !captured;
    $('hotkey-cancel').disabled = hotkeyPending;
    $('preview').disabled = !ready || editing || pending || previewTasks > 0 || !draft || !mainGroup(draft.wallpaper) || (!!mediaSelection && !mediaPreviewAvailable) || !previewActive && (!!publicPropertiesError() || conflict);
    $('preview').textContent = previewActive ? '结束预览' : '开始预览';
    $('settings-state').textContent = !ready ? '读取中' : editing ? '正在调整位置' : pending ? (applyInFlight ? '正在应用' : '正在处理') : conflict ? '草稿需要重读' : dirty ? '未应用修改' : '设置已保存';
    $('settings-state').dataset.dirty = String(dirty);
    $('conflict').hidden = !conflict;
    $('discard-close').disabled = pending;
    if (!dirty && !pending) $('close-confirm').hidden = true;
    updateProfilePath();
    renderDisplays();
    document.querySelectorAll('[data-library-select], .library-delete').forEach(function (button) { button.disabled = !canChooseLibraryVersion() || button.dataset.libraryDeletePending === 'true'; });
    window.dispatchEvent(new Event('wallpaper-settings-controls-updated'));
  }
  function renderRuntime(payload) {
    var runtime = payload.runtime || {}, globalWallpaper = runtime.wallpaper || {}, target = selectedRuntime(payload), wallpaper = target || {}, policy = runtime.policy || {};
    var diagnostics = wallpaper.diagnostics || (!Array.isArray(globalWallpaper.targets) ? runtime.diagnostics : null) || {};
    var reasons = diagnostics.pauseReasons || [];
    var reasonText = { fullscreen:'前台应用处于全屏', maximized:'前台应用已最大化', applicationRule:'指定应用正在前台', sessionUnavailable:'Windows 已锁屏或会话不可用', displayOff:'显示器已关闭', displayMissing:'目标显示器未连接', manualPause:'已从托盘隐藏', battery:'使用电池供电', noSurface:'壁纸尚未挂载', pageNotReady:'渲染页面正在准备' };
    function targetStopped(item) { return item.enabled && item.applicationRule === 'stop'; }
    function targetPaused(item) {
      return item.enabled && !targetStopped(item) && (item.applicationRule === 'pause'
        || (item.diagnostics && item.diagnostics.pauseReasons || []).some(function (reason) { return ['fullscreen','maximized','applicationRule','sessionUnavailable','displayOff','battery'].includes(reason); }));
    }
    var stopped = targetStopped(wallpaper), retained = wallpaper.staticFrameRetained || wallpaper.handoff && wallpaper.handoff.pauseRetained;
    var paused = targetPaused(wallpaper) || wallpaper.enabled && !stopped && reasons.some(function (reason) { return ['fullscreen','maximized','applicationRule','sessionUnavailable','displayOff','battery'].includes(reason); });
    var state = !wallpaper.enabled ? '壁纸未启用' : wallpaper.monitorMissing ? '目标显示器未连接' : wallpaper.hidden ? '壁纸已从托盘隐藏' : wallpaper.visible ? '壁纸正在运行' : diagnostics.recovery && diagnostics.recovery.terminal ? '壁纸挂载失败' : reasons.some(reason => ['fullscreen','sessionUnavailable','displayOff','displayMissing','battery'].includes(reason)) ? '壁纸已按运行规则暂停' : '壁纸正在准备';
    var waitingForScene = payload.config && follows(payload.config) && !payload.spaceScene;
    var unsupportedScene = payload.config && follows(payload.config) && payload.spaceScene && !scenes.some(scene => scene.id === payload.spaceScene);
    if (wallpaper.enabled && wallpaper.visible && (waitingForScene || unsupportedScene)) state = '等待来源 · ' + sceneLabel(selectedScene(payload.config));
    if (wallpaper.visible && wallpaper.staticPoster) state = '视频播放失败 · 显示静态封面';
    if (wallpaper.applyError && !wallpaper.visible) state = '此显示组运行失败';
    if (wallpaper.selectionPreparing || wallpaper.candidateLoading) state = wallpaper.visible ? '正在准备新壁纸 · 旧画面继续显示' : '壁纸正在准备';
    if (wallpaper.handoff && wallpaper.handoff.visible) state = wallpaper.applyError ? '新壁纸未能显示 · 保留上一帧' : '正在切换壁纸 · 保留上一帧';
    if (paused && !wallpaper.monitorMissing && !wallpaper.hidden) state = retained ? '壁纸已暂停 · 保留静态画面' : '壁纸已按运行规则暂停';
    if (stopped) state = '壁纸已按应用规则停止';
    var running = wallpaper.visible && !paused && !stopped && !retained && !wallpaper.staticPoster && !(wallpaper.handoff && wallpaper.handoff.visible);
    if (globalWallpaper.sessionStopped) { state = '桌面壁纸已退出'; running = false; }
    $('wallpaper-state').textContent = state;
    $('wallpaper-dot').className = 'state-dot' + (running ? ' running' : state.includes('失败') ? ' error' : '');
    var detail = wallpaper.staticPoster ? '原视频选择已保留，当前显示封面且未占用视频解码器。点击重新挂载壁纸可重试。' + (wallpaper.applyError ? ' 原因：' + wallpaper.applyError : '')
      : wallpaper.applyError ? '设置已保存，但运行存在问题：' + wallpaper.applyError
      : wallpaper.monitorMissing ? '重新连接目标显示器，或选择其他显示器后应用。'
      : unsupportedScene ? '当前空间场景暂不支持壁纸，正在显示你选择的等待场景。'
      : waitingForScene ? '正在显示等待场景；播放器提供合格场景后将自动跟随。'
      : wallpaper.visible && wallpaper.media ? (wallpaper.media.kind === 'image' ? '静态图片 · 没有连续动画' : '静音视频 · 原速播放' + (wallpaper.media.sourceFps ? ' · 源帧率 ' + wallpaper.media.sourceFps + ' fps' : ''))
      : wallpaper.visible ? '桌面实际运行 · ' + wallpaper.fps + ' fps · 画质 ' + (wallpaper.quality || 'low')
      : reasons.map(reason => reasonText[reason]).filter(Boolean).join(' · ') || '启用并应用壁纸后，将显示在桌面图标后方。';
    if (paused && !wallpaper.monitorMissing && !wallpaper.hidden) {
      var pauseDetail = reasons.map(function (reason) { return reasonText[reason]; }).filter(Boolean);
      if (wallpaper.applicationRule === 'pause' && !reasons.includes('applicationRule')) pauseDetail.unshift(reasonText.applicationRule);
      detail = (pauseDetail.length ? pauseDetail.join(' · ') + '。' : '') + (retained ? '当前保留静态画面，动画已暂停。' : '渲染已暂停；长时间暂停时会卸载渲染资源。') + '触发状态结束后恢复原来的壁纸内容。';
    }
    if (stopped) detail = '指定应用正在前台，已释放该屏壁纸的渲染资源与画面。应用离开前台后自动恢复原来的壁纸内容。';
    if (!target) {
      $('wallpaper-state').textContent = groupById(payload.config, selectedGroupId) ? '此显示组尚未运行' : '此显示组尚未应用';
      $('wallpaper-dot').className = 'state-dot';
      detail = '应用设置后，此处显示所选组的实际运行状态。';
    } else if (wallpaper.targets && wallpaper.targets.length > 1) {
      var targets = wallpaper.targets, stoppedCount = targets.filter(targetStopped).length, pausedCount = targets.filter(targetPaused).length;
      var visibleCount = targets.filter(function (item) { return item.visible && !targetStopped(item) && !targetPaused(item); }).length;
      if (stoppedCount || pausedCount) {
        $('wallpaper-state').textContent = stoppedCount === targets.length ? '壁纸已按应用规则停止' : pausedCount === targets.length ? '壁纸已按运行规则暂停'
          : stoppedCount && pausedCount ? '本组部分目标已暂停或停止' : stoppedCount ? '本组部分目标已停止' : '本组部分目标已暂停';
        $('wallpaper-dot').className = 'state-dot';
        detail = '前台规则仅影响应用所在的显示目标；触发状态结束后恢复原来的壁纸内容。';
      }
      detail = '本组 ' + targets.length + ' 个显示目标 · ' + visibleCount + ' 个正在显示' + (pausedCount ? ' · ' + pausedCount + ' 个已暂停' : '') + (stoppedCount ? ' · ' + stoppedCount + ' 个已停止' : '') + '。' + detail;
    }
    var audio = globalWallpaper.audio || {};
    $('audio-state').textContent = audio.previewBlocked ? '预览所选设备与桌面不同；音频响应已停止，请选择相同设备。'
      : audio.error ? '系统音频：' + audio.error
      : audio.phase === 'running' ? '正在采集系统播放声音' + (audio.info ? ' · ' + (audio.info.sampleRate / 1000) + ' kHz' : '') + (audio.desktopConsumer && audio.previewConsumer ? ' · 桌面与预览共享' : '')
      : audio.phase === 'stopping' ? '正在释放旧音频设备…'
      : audio.phase === 'starting' || audio.phase === 'pending' ? '等待所选播放设备的声音…'
      : draft && draft.wallpaper.audioInput.kind === 'system' ? '系统音频未采集；运行场景或开始预览后启用。' : '';
    $('audio-retry').hidden = audio.phase !== 'failed';
    if (globalWallpaper.sessionStopped) detail = globalWallpaper.exitPreferenceSaved === false
      ? '本次已停止。退出偏好未保存，再次启动可能恢复。'
      : '退出偏好已保存。启用并应用壁纸可重新开始。';
    $('wallpaper-detail').textContent = detail;
    $('wallpaper-show').hidden = !globalWallpaper.hidden;
    $('wallpaper-retry').hidden = globalWallpaper.sessionStopped || !target || !wallpaper.enabled || stopped || paused || wallpaper.monitorMissing || (wallpaper.pageReady && !wallpaper.applyError && !(diagnostics.recovery && diagnostics.recovery.terminal));
    $('lyrics-state').textContent = editing ? '歌词已临时解锁，可拖动位置' : !runtime.enabled ? '歌词未启用' : runtime.userHidden ? '歌词已从托盘隐藏' : runtime.visible ? (runtime.locked ? '歌词正在显示 · 已锁定' : '歌词正在显示 · 可拖动') : policy.noContent && runtime.locked ? '等待可显示的歌词' : '歌词已按运行规则隐藏';
    if (runtime.sessionStopped) $('lyrics-state').textContent = '桌面歌词已退出';
    $('lyrics-dot').className = 'state-dot' + (runtime.visible ? ' running' : '');
    $('lyrics-detail').textContent = payload.sourceMessage || (runtime.source === 'ok' ? '已连接播放器，歌词随播放自动更新。' : '等待播放器与歌词内容。');
    if (runtime.sessionStopped) $('lyrics-detail').textContent = runtime.exitPreferenceSaved === false
      ? '本次已停止。退出偏好未保存，再次启动可能恢复。'
      : '退出偏好已保存。启用歌词或从托盘定位可重新开始。';
    $('lyrics-show').hidden = !runtime.userHidden;
    $('source-state').textContent = (payload.profile ? (payload.profile.edition === 'standard' ? 'Hertz Standard' : 'Hertz Full') + ' · ' : '') + (payload.sourceMessage || runtime.source || '等待连接');
    if (payload.launchAtLogin != null) $('autostart').checked = !!payload.launchAtLogin;
    $('autostart-state').textContent = payload.launchAtLogin == null ? '无法读取 Windows 启动项' : payload.launchAtLogin ? '系统启动项已启用' : '系统启动项未启用';
  }
  // 保存的组合键与真实注册状态分别展示（§5.1）；旧宿主状态缺字段时保留现状。
  function renderHotkey(payload) {
    if (!payload.recoveryHotkey) return;
    var hk = payload.recoveryHotkey;
    $('hotkey-saved').textContent = hk.saved || '未设置';
    $('hotkey-edit').textContent = hk.saved ? '修改快捷键' : '设置快捷键';
    $('hotkey-clear').hidden = !hk.saved && !(hk.registered && hk.registered.length);
    var detail = [];
    if (hk.registered && hk.registered.length) detail.push('当前生效：' + hk.registered.join('、'));
    else if (hk.saved) detail.push('当前未生效：可重新保存以重试注册。');
    if (hk.error) detail.push(hk.error);
    $('hotkey-actual').textContent = detail.join(' ');
  }
  function applyStatus(payload) {
    if (!payload) return;
    var libraryContextChanged = !latest || profileKey(payload.profile) !== profileKey(latest.profile) || payload.message === '已切换来源';
    var layoutContextChanged = !latest || payload.revision !== latest.revision
      || profileKey(payload.profile) !== profileKey(latest.profile) || payload.message === '已切换来源';
    latest = payload;
    if (libraryContextChanged) window.dispatchEvent(new Event('wallpaper-library-context-changed'));
    if (!dirty && !pending && nativeDraft && nativeDraft.baseRevision !== payload.revision) releaseNativeDraft();
    if (payload.navigationRequest && navigationId !== payload.navigationRequest.id) {
      navigationId = payload.navigationRequest.id;
      setTab(payload.navigationRequest.tab);
    }
    var applied = payload.message === '已应用' || payload.message === '已切换来源', acceptedDraftChanged = false;
    if (payload.message === '已切换来源') { nativeDraft = null; ++draftEpoch; }
    if (payload.config && payload.lyricsConfig) {
      saved = { wallpaper: clone(payload.config), lyrics: clone(payload.lyricsConfig) };
      if (!dirty || (applied && !applyInFlight)) {
        acceptedDraftChanged = revision !== payload.revision || JSON.stringify(draft) !== JSON.stringify(saved);
        draft = clone(saved); revision = payload.revision; dirty = false; conflict = false; pending = applyInFlight;
      }
      else if (payload.revision !== revision) conflict = true;
      ready = true;
      ensureSelectedGroup();
    }
    editing = !!payload.positionEditing;
    mediaPreviewAvailable = payload.mediaPreviewAvailable === true;
    if (!previewTasks) {
      previewActive = !!payload.previewActive;
      previewLease = payload.previewLease || null;
      if (!previewActive) previewGroupId = null;
    }
    acceptDisplayCapabilities(payload.capabilities) || acceptDisplayCapabilities(payload.runtime && payload.runtime.wallpaper && payload.runtime.wallpaper.capabilities);
    if (layoutContextChanged) { invalidateGroupLayouts(); invalidatePublicProperties(); }
    if (ready) readDisplayCapabilities();
    if (payload.error) { if (!applyInFlight) pending = false; status(payload.error, true); }
    else if (payload.message) status(payload.message, false);
    else if (!$('status').classList.contains('error')) status(editing ? '正在调整真实歌词位置；关闭窗口会取消本次调整。' : dirty ? '草稿尚未应用；壁纸、歌词与运行规则会一起保存。' : '设置已保存。实际显示状态见上方。', false);
    renderMetadata(payload);
    // Status polling never rewrites inputs while the user is typing.
    var activeInput = document.activeElement && /^(INPUT|SELECT)$/.test(document.activeElement.tagName);
    if (hotkeyPending) {
      hotkeyPending = false;
      if (payload.message === '已更新恢复快捷键') exitHotkeyCapture();
    }
    if (acceptedDraftChanged || (!dirty && !activeInput) || applied && !applyInFlight) renderForm(acceptedDraftChanged || applied && !applyInFlight); else { renderPreview(); syncControls(); }
    renderRuntime(payload);
    renderHotkey(payload);
    publishRuntime();
  }
  function changed(wallpaperChanged) {
    if (!draft) return;
    dirty = JSON.stringify(draft) !== JSON.stringify(saved);
    if (!dirty) { conflict = false; revision = latest.revision; }
    if (wallpaperChanged) refreshGroupLayouts();
    status('草稿尚未应用；壁纸、歌词与运行规则会一起保存。', false);
    renderPreview(); syncControls();
    if (wallpaperChanged && previewActive && previewMode === 'settings' && previewGroupId === selectedGroupId) { clearTimeout(previewTimer); previewTimer = setTimeout(function () { if (previewMode === 'settings' && !publicPropertiesError()) startNativePreview(true); }, 180); }
  }
  function changePublicProperty(event) {
    if (!canChooseLibraryVersion() || event.target.disabled || !event.target.hasAttribute('data-property-input')) return;
    var group = mainGroup(draft.wallpaper), entry = propertyEntries.get(group.id), id = event.target.dataset.propertyInput;
    if (!entry || entry.state !== 'ready') return;
    var property = entry.properties.find(function (item) { return item.id === id; });
    if (!property || event.type !== (['boolean', 'select', 'asset'].includes(property.type) ? 'change' : 'input')) return;
    var value = event.target.value;
    if (property.type === 'number') value = value.trim() && Number.isFinite(Number(value)) ? Number(value) : value;
    if (property.type === 'boolean') value = event.target.checked;
    if (property.type === 'select' || property.type === 'asset') {
      var option = property.constraints.options[Number(value)];
      if (option === undefined) return;
      value = property.type === 'select' ? option.value : option;
    }
    if (!group.properties) group.properties = {};
    Object.defineProperty(group.properties, id, { value: value, writable: true, enumerable: true, configurable: true });
    changed(true);
  }
  $('public-properties-list').addEventListener('input', changePublicProperty);
  $('public-properties-list').addEventListener('change', changePublicProperty);
  $('public-properties-list').addEventListener('click', function (event) {
    var button = event.target.closest('[data-property-reset]');
    if (!button || button.disabled || !canChooseLibraryVersion()) return;
    var group = mainGroup(draft.wallpaper), id = button.dataset.propertyReset;
    delete group.properties[id]; changed(true);
    var input = Array.from($('public-properties-list').querySelectorAll('[data-property-input]')).find(function (node) { return node.dataset.propertyInput === id; });
    if (input) input.focus();
  });
  $('public-properties-retry').addEventListener('click', function () { if (canChooseLibraryVersion()) invalidatePublicProperties(); });
  function canEditWindowPolicies() { return ready && !!draft && !editing && !pending && !conflict; }
  ['pause-on-fullscreen','pause-on-maximized'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      if (!canEditWindowPolicies() || this.disabled) return;
      draft.wallpaper[id === 'pause-on-fullscreen' ? 'pauseOnFullscreen' : 'pauseOnMaximized'] = this.checked;
      changed(false);
    });
  });
  $('application-rule-add').addEventListener('click', function () {
    if (!canEditWindowPolicies()) return;
    var rules = draft.wallpaper.applicationRules || (draft.wallpaper.applicationRules = []);
    if (rules.length >= 32) return;
    rules.push({ executable: '', action: 'pause' });
    renderApplicationRules(); changed(false);
    $('application-rules').lastElementChild.querySelector('input').focus();
  });
  function changeApplicationRule(event) {
    if (!canEditWindowPolicies() || event.target.disabled) return;
    var field = event.target.dataset.ruleField, row = event.target.closest('[data-rule-index]');
    if (!row || !field || (field === 'executable' ? event.type !== 'input' : event.type !== 'change')) return;
    draft.wallpaper.applicationRules[Number(row.dataset.ruleIndex)][field] = event.target.value;
    changed(false);
  }
  $('application-rules').addEventListener('input', changeApplicationRule);
  $('application-rules').addEventListener('change', changeApplicationRule);
  $('application-rules').addEventListener('click', function (event) {
    if (!event.target.closest('.application-rule-remove') || !canEditWindowPolicies()) return;
    var index = Number(event.target.closest('[data-rule-index]').dataset.ruleIndex);
    draft.wallpaper.applicationRules.splice(index, 1);
    renderApplicationRules(); changed(false);
    var next = $('application-rules').children[Math.min(index, draft.wallpaper.applicationRules.length - 1)];
    (next ? next.querySelector('input') : $('application-rule-add')).focus();
  });
  ['enabled','fps','music','audio-device','audio-gain','audio-attack','audio-release','scene-source','scene-fixed','quality','brightness','motion','media-fit','pointer'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      if (!draft || !mainGroup(draft.wallpaper) || this.disabled) return;
      var wallpaper = draft.wallpaper, group = mainGroup(wallpaper);
      if (id === 'enabled') wallpaper.enabled = this.checked;
      else if (id === 'music') {
        var previous = wallpaper.audioInput;
        wallpaper.audioInput = this.value === 'none' ? { kind: 'none' } : { kind: this.value, gain: previous.gain == null ? 1 : previous.gain, attackMs: previous.attackMs == null ? 40 : previous.attackMs, releaseMs: previous.releaseMs == null ? 250 : previous.releaseMs };
        if (this.value === 'system') wallpaper.audioInput.device = previous.device || { kind: 'default' };
      }
      else if (id === 'audio-device') wallpaper.audioInput.device = this.value ? { kind: 'fixed', id: this.value } : { kind: 'default' };
      else if (id.startsWith('audio-')) {
        if (!this.validity.valid || this.value === '') { dirty = true; this.setAttribute('aria-invalid', 'true'); status('请填写有效的音频增益与响应时长。', true); syncControls(); return; }
        this.removeAttribute('aria-invalid');
        wallpaper.audioInput[{ 'audio-gain':'gain', 'audio-attack':'attackMs', 'audio-release':'releaseMs' }[id]] = Number(this.value);
      }
      else if (id === 'scene-source') setBuiltin(wallpaper, selectedScene(wallpaper) || 'zodiac', this.value === 'follow');
      else if (id === 'scene-fixed') setBuiltin(wallpaper, this.value, follows(wallpaper));
      else if (id === 'media-fit') group.presentation.fit = this.value;
      else if (id === 'pointer') group.presentation.pointer = this.checked;
      else group.presentation[id] = id === 'quality' ? this.value : Number(this.value);
      changed(true);
      if (id === 'music') renderForm();
    });
  });
  var lyricsFields = { 'lyrics-enabled':['enabled','check'], 'lyrics-locked':['locked','check'], 'lyrics-secondary':['secondary','text'], 'lyrics-size':['fontSize','number'], 'lyrics-weight':['fontWeight','number'], 'lyrics-sung':['sungColor','text'], 'lyrics-unsung':['unsungColor','text'], 'lyrics-outline':['outlineColor','text'], 'lyrics-stroke':['outlineWidth','number'], 'lyrics-opacity':['opacity','number'] };
  Object.keys(lyricsFields).forEach(function (id) { $(id).addEventListener('input', function () { if (!draft) return; if (this.validity && !this.validity.valid || this.type === 'number' && this.value === '') { dirty = true; this.setAttribute('aria-invalid', 'true'); status('请填写有效的字号或描边宽度。', true); syncControls(); return; } this.removeAttribute('aria-invalid'); var field = lyricsFields[id]; draft.lyrics[field[0]] = field[1] === 'check' ? this.checked : field[1] === 'number' ? Number(this.value) : this.value; changed(false); }); });
  document.querySelectorAll('[data-preset]').forEach(node => node.addEventListener('click', function () { if (!draft) return; Object.assign(draft.lyrics, presets[node.dataset.preset]); changed(false); renderForm(); }));
  function setTab(tab) {
    if (!['wallpaper','lyrics','runtime'].includes(tab)) return;
    if (activeTab !== tab) document.querySelector('main').scrollTop = 0;
    activeTab = tab;
    document.querySelectorAll('[data-tab]').forEach(function (node) { var active = node.dataset.tab === tab; node.setAttribute('aria-selected', String(active)); node.tabIndex = active ? 0 : -1; $('panel-' + node.dataset.tab).hidden = !active; });
    if (tab !== 'wallpaper') releaseNativePreview();
  }
  document.querySelectorAll('[data-tab]').forEach(node => { node.addEventListener('click', () => setTab(node.dataset.tab)); node.addEventListener('keydown', function (event) { var tabs = ['wallpaper','lyrics','runtime'], index = tabs.indexOf(activeTab), target = event.key === 'ArrowRight' ? tabs[(index+1)%3] : event.key === 'ArrowLeft' ? tabs[(index+2)%3] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[2] : null; if (target) { event.preventDefault(); setTab(target); $('tab-' + target).focus(); } }); });
  ['dark','light'].forEach(name => $('bg-' + name).addEventListener('click', function () { $('lyrics-preview').classList.toggle('light', name === 'light'); ['dark','light'].forEach(value => $('bg-' + value).setAttribute('aria-pressed', String(value === name))); }));
  $('profile').addEventListener('change', updateProfilePath);
  $('audio-retry').addEventListener('click', function () { send('audio-retry'); });
  $('switch-source').addEventListener('click', function () { var profile = profiles.find(profile => profileKey(profile) === $('profile').value); if (profile && !dirty) { pending = true; syncControls(); send('switch-source', { profile: profile, expectedRevision: revision }); } });
  $('autostart').addEventListener('change', function () { send('autostart', { enabled: this.checked }); });
  function modifierList(event) { var parts = []; if (event.ctrlKey) parts.push('Ctrl'); if (event.altKey) parts.push('Alt'); if (event.shiftKey) parts.push('Shift'); return parts.join('+'); }
  // 与宿主 hotkey.rs 同一组合键文法：Ctrl/Alt/Shift 至少两个，主键 A–Z、0–9、F1–F11、F13–F24；不含 Win 与 F12。
  function canonicalHotkey(event) {
    var main = null, key = event.key;
    if (/^[a-zA-Z]$/.test(key)) main = key.toUpperCase();
    else if (/^[0-9]$/.test(key)) main = key;
    else if (/^F\d+$/.test(key)) {
      var number = Number(key.slice(1));
      if (number >= 1 && number <= 24 && number !== 12 && String(number) === key.slice(1)) main = 'F' + number;
      else $('hotkey-progress').textContent = number === 12 ? 'F12 由系统保留，请换一个功能键。' : '功能键支持 F1–F11、F13–F24。';
    }
    if (!main) {
      if (!/^F\d+$/.test(key)) $('hotkey-progress').textContent = '主键请使用字母、数字或 F1–F11、F13–F24。';
      return null;
    }
    if ((event.ctrlKey ? 1 : 0) + (event.altKey ? 1 : 0) + (event.shiftKey ? 1 : 0) < 2) { $('hotkey-progress').textContent = '请至少同时按住 Ctrl、Alt、Shift 中的两个。'; return null; }
    return modifierList(event) + '+' + main;
  }
  function enterHotkeyCapture() {
    recording = true; captured = null;
    $('hotkey-idle').hidden = true; $('hotkey-capture').hidden = false;
    $('hotkey-record').textContent = '按下组合键…';
    $('hotkey-progress').textContent = '按住修饰键后按主键；Esc 取消。';
    $('hotkey-record').focus();
    syncControls();
  }
  function exitHotkeyCapture() {
    recording = false; captured = null;
    $('hotkey-capture').hidden = true; $('hotkey-idle').hidden = false;
    $('hotkey-record').textContent = '按下组合键…';
    $('hotkey-progress').textContent = '';
    syncControls();
  }
  $('hotkey-edit').addEventListener('click', enterHotkeyCapture);
  $('hotkey-cancel').addEventListener('click', exitHotkeyCapture);
  $('hotkey-record').addEventListener('keydown', function (event) {
    if (!recording) return;
    event.preventDefault();
    if (event.key === 'Escape') { exitHotkeyCapture(); return; }
    if (['Control', 'Alt', 'Shift'].includes(event.key)) { $('hotkey-progress').textContent = '已按 ' + (modifierList(event) || '…') + '，请继续按主键。'; return; }
    if (event.metaKey) { $('hotkey-progress').textContent = '不使用 Windows 系统键。'; return; }
    var combo = canonicalHotkey(event);
    if (!combo) return;
    captured = combo;
    $('hotkey-record').textContent = '已选择 ' + combo;
    $('hotkey-progress').textContent = '确认无误后点击保存；重新按键可更换。';
    syncControls();
  });
  $('hotkey-save').addEventListener('click', function () {
    if (!captured) return;
    hotkeyPending = true; syncControls();
    send('recovery-hotkey', { hotkey: captured, expectedRevision: revision });
  });
  $('hotkey-clear').addEventListener('click', function () {
    hotkeyPending = true; syncControls();
    send('recovery-hotkey', { hotkey: null, expectedRevision: revision });
  });
  $('preview').addEventListener('click', function () { if (previewActive) releaseNativePreview(); else startNativePreview(false); });
  $('apply').addEventListener('click', function () { if (!ready || !dirty || conflict || editing || pending || this.disabled) return; if (!settingsInvalid()) { applyNativeDraft(); } else status(publicPropertiesError() || '请检查运行规则、字号、描边宽度与音频参数。', true); });
  $('discard').addEventListener('click', function () { dirty = false; conflict = false; pending = false; draft = clone(saved); revision = latest.revision; releaseNativePreview(); releaseNativeDraft(); ensureSelectedGroup(); renderForm(); if (latest) renderRuntime(latest); publishRuntime(); status('已放弃草稿，读取最新保存的设置。', false); });
  $('close').addEventListener('click', requestClose);
  $('continue-editing').addEventListener('click', function () { $('close-confirm').hidden = true; $('close').focus(); });
  $('discard-close').addEventListener('click', function () { dirty = false; requestClose(); });
  ['position-begin','position-done','position-cancel','wallpaper-show','wallpaper-retry','lyrics-show'].forEach(id => $(id).addEventListener('click', () => send(id)));
  function unmountPreview() { ++previewSequence; clearTimeout(previewTimer); previewActive = false; previewLease = null; previewGroupId = null; invalidatePosters(); syncControls(); }
  window.hertzWallpaperSettings = {
    applyStatus: applyStatus, setTab: setTab, requestClose: requestClose,
    requestManagement: requestManagement, applyManagement: applyManagement,
    chooseLibraryVersion: chooseLibraryVersion,
    choosePlaylist: choosePlaylist,
    currentGroupId: function () { return selectedGroupId; },
    currentRuntime: function () { return selectedRuntime(latest); },
    currentBuiltin: function () { var state = draft && builtin(draft.wallpaper); return state ? Object.assign({ title: sceneLabel(state.sceneId) }, clone(state)) : null; },
    releasePreview: releaseNativePreview,
    previewWork: function (reference) {
      if (!draft || !mainGroup(draft.wallpaper)) return Promise.reject(new Error('请等待显示组读取完成后预览作品。'));
      clearTimeout(previewTimer);
      previewMode = 'work';
      var groupId = selectedGroupId, sequence = ++previewSequence;
      reference = Object.assign({}, reference, { groupId: groupId });
      return previewTask(function () {
        return serialNative(async function () {
          if (sequence !== previewSequence || groupId !== selectedGroupId || activeTab !== 'wallpaper' || document.hidden) throw new Error('显示组或页面已切换，请重新开始作品预览。');
          var lease = previewLease;
          var result = await requestManagement(lease ? 'wallpaper.preview.update' : 'wallpaper.preview.acquire', lease ? Object.assign({ leaseId: lease }, reference) : reference);
          if (sequence !== previewSequence || groupId !== selectedGroupId) {
            await requestManagement('wallpaper.preview.release', { leaseId: result.result.leaseId });
            if (previewLease === result.result.leaseId) previewLease = null;
            throw new Error('显示组已切换，请重新开始作品预览。');
          }
          previewLease = result.result.leaseId; previewActive = true; previewGroupId = groupId; previewMode = 'work';
          return result.result;
        });
      });
    },
    canChooseLibraryVersion: canChooseLibraryVersion,
    readPoster: readPoster,
    invalidatePosters: invalidatePosters,
    unmountPreview: unmountPreview
  };
  if (window.hertzWallpaperDisplays && $('wallpaper-displays')) {
    displaysEditor = window.hertzWallpaperDisplays.create({ mount: $('wallpaper-displays'), onSelect: selectGroup, onChange: function (groups) {
      if (!canChooseLibraryVersion()) return false;
      draft.wallpaper.groups = clone(groups);
      ensureSelectedGroup(); changed(true); renderForm();
      if (latest) renderRuntime(latest);
      publishRuntime(); return true;
    } });
  }
  setInterval(function () {
    if (!previewActive || document.hidden || activeTab !== 'wallpaper') return;
    var lease = previewLease;
    requestManagement('wallpaper.preview.renew', { leaseId: lease }).catch(function (error) {
      // A closing/replaced preview can leave one renewal in flight. Its late
      // receipt must not replace the current preview's status or failure reason.
      if (previewActive && previewLease === lease) managementError(error);
    });
  }, 5000);
  document.addEventListener('visibilitychange', function () { if (document.hidden && previewActive) releaseNativePreview(); });
  window.addEventListener('wallpaper-library-changed', invalidateGroupLayouts);
  window.addEventListener('wallpaper-library-changed', invalidatePublicProperties);
  window.addEventListener('wallpaper-properties-invalidated', invalidatePublicProperties);
  window.addEventListener('wallpaper-layout-invalidated', invalidateGroupLayouts);
  window.addEventListener('pagehide', function () {
    layoutDisposed = true; layoutEpoch++; clearTimeout(layoutTimer); layoutEntries.clear(); layoutCache.clear();
    propertyDisposed = true; propertyEpoch++; clearTimeout(propertyTimer); propertyEntries.clear();
    if (previewLease) requestManagement('wallpaper.preview.release', { leaseId: previewLease }).catch(function () {}); send('position-cancel');
  });
  send('ready');
})();
