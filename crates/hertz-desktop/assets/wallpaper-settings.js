(function () {
  'use strict';
  var $ = id => document.getElementById(id);
  var saved = null, draft = null, revision = 0, latest = null;
  var ready = false, dirty = false, conflict = false, previewActive = false, editing = false;
  var previewLease = null, mediaPreviewAvailable = false;
  var scenes = [], profiles = [], monitors = [], currentProfile = null, spaceScene = null;
  var presetStyle = { sungColor:'#8fe3ff', unsungColor:'#ffffff', outlineColor:'#000000', outlineWidth:2, opacity:.92, fontWeight:600 };
  var presets = {
    single: Object.assign({}, presetStyle, { layout:'single', secondary:'next', fontSize:36, bilingual:false }),
    double: Object.assign({}, presetStyle, { layout:'double', secondary:'next', fontSize:32, bilingual:false }),
    triple: { layout:'triple', secondary:'next', fontSize:30, fontWeight:600, sungColor:'#ffffff', unsungColor:'#ffffff', outlineColor:'#000000', outlineWidth:0, opacity:1, bilingual:true, theme:'auto', surface:'glass', align:'center', karaoke:true, readabilityBoost:false },
    translation: Object.assign({}, presetStyle, { layout:'double', secondary:'translation', fontSize:30, fontWeight:500, outlineWidth:1.5, bilingual:true })
  };
  function currentPreset(lyrics) { return Object.keys(presets).find(key => Object.keys(presets[key]).every(field => presets[key][field] === lyrics[field])) || null; }
  function requestClose() {
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
    var entry = { input: input };
    var promise = new Promise(function (resolve, reject) {
      entry.resolve = resolve; entry.reject = reject;
      entry.timer = setTimeout(function () {
        managementRequests.delete(id);
        reject(Object.assign(new Error('操作结果尚未确认，请查询原操作。'), { code: 'receipt_timeout', requestId: id }));
      }, command === 'wallpaper.file.pick' ? 300000 : 5000);
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
    if (!nativeDraft) nativeDraft = (await requestManagement('wallpaper.draft.create', { kind: 'settings' })).result;
    if (nativeDraft.baseRevision !== base) throw Object.assign(new Error('设置已变化，请放弃修改后重新读取。'), { code: 'conflict' });
    var receipt = await requestManagement('wallpaper.draft.update', { draftId: nativeDraft.draftId, draftRevision: nativeDraft.draftRevision,
      operations: [{ kind: 'replaceWallpaper', wallpaper: input.wallpaper }, { kind: 'replaceLyrics', lyrics: input.lyrics }] });
    nativeDraft = receipt.result;
    if (epoch !== draftEpoch) throw Object.assign(new Error('草稿已释放。'), { code: 'stale_draft' });
    return { draftId: nativeDraft.draftId, draftRevision: nativeDraft.draftRevision };
  }
  function releaseNativeDraft() {
    ++draftEpoch; clearTimeout(previewTimer);
    return serialNative(async function () {
      var reference = nativeDraft; nativeDraft = null;
      if (reference) await requestManagement('wallpaper.draft.discard', { draftId: reference.draftId, draftRevision: reference.draftRevision });
    }).catch(managementError);
  }
  function releaseNativePreview() {
    clearTimeout(previewTimer);
    var lease = previewLease;
    if (!lease) return Promise.resolve();
    return serialNative(function () { return requestManagement('wallpaper.preview.release', { leaseId: lease }); }).catch(function (error) { if (error.code !== 'preview_lease_invalid') managementError(error); });
  }
  function startNativePreview(update) {
    var input = clone(draft), base = revision, epoch = draftEpoch, lease = previewLease;
    return serialNative(async function () {
      var reference = await updateNativeDraft(input, base, epoch);
      if (epoch !== draftEpoch || activeTab !== 'wallpaper' || document.hidden) return;
      var receipt = await requestManagement(update ? 'wallpaper.preview.update' : 'wallpaper.preview.acquire', update ? Object.assign({ leaseId: lease }, reference) : reference);
      previewLease = receipt.result.leaseId;
    }).catch(managementError);
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
    if (receipt.ok) waiting.resolve(receipt);
    else { var error = new Error(receipt.error && receipt.error.message || '操作未完成。'); error.code = receipt.error && receipt.error.code; error.receipt = receipt; error.requestId = receipt.requestId; waiting.reject(error); }
  }
  function status(text, error) { $('status').textContent = text; $('status').className = error ? 'error' : ''; }
  function profileKey(profile) { return profile ? String(profile.kind || 'standalone') + '|' + String(profile.pluginId || '') + '|' + String(profile.edition || '').toLowerCase() + '|' + String(profile.dataDir || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() : ''; }
  function mainGroup(wallpaper) { return wallpaper.groups[0]; }
  function presentation(wallpaper) { return mainGroup(wallpaper).presentation; }
  var selectedWorkMetadata = null, selectedWorkLookup = '';
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
  function packageSelection(wallpaper) { var selection = mainGroup(wallpaper).selection; return selection.kind === 'package' ? selection : null; }
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
  function canChooseLibraryVersion() { return ready && !!draft && !editing && !pending; }
  async function chooseLibraryVersion(work, version) {
    if (!canChooseLibraryVersion() || version.state !== 'installed' || !['image','video'].includes(work.kind)) return false;
    var input = clone(draft), base = revision, epoch = draftEpoch;
    mainGroup(input.wallpaper).selection = { kind: 'package', workKey: work.workKey, packageHash: version.packageHash };
    input.wallpaper.audioInput = { kind: 'none' };
    pending = true; syncControls();
    try {
      if (previewActive) await releaseNativePreview();
      // Register the reference before showing selection as complete. Other clients then
      // share the native draft's deletion guard even before Preview or Apply is clicked.
      await serialNative(function () { return updateNativeDraft(input, base, epoch); });
      draft = input;
      selectedWorkLookup = '';
      selectedWorkMetadata = { workKey: work.workKey, packageHash: version.packageHash, title: work.title, kind: work.kind, version: version.version };
      changed(true); renderForm();
      return true;
    } finally { pending = false; syncControls(); }
  }
  function follows(wallpaper) { return mainGroup(wallpaper).selection.kind === 'followHertz'; }
  function builtin(wallpaper) { var selection = mainGroup(wallpaper).selection; return selection.kind === 'followHertz' ? selection.idleBuiltin : selection.kind === 'builtin' ? selection : null; }
  function selectedScene(wallpaper) { var state = builtin(wallpaper); return state && state.sceneId; }
  function setBuiltin(wallpaper, id, follow) {
    var state = builtin(wallpaper);
    state = state && state.sceneId === id ? { sceneId: state.sceneId, stateVersion: state.stateVersion, params: clone(state.params) } : { sceneId: id, stateVersion: 1, params: {} };
    mainGroup(wallpaper).selection = follow ? { kind: 'followHertz', idleBuiltin: state } : Object.assign({ kind: 'builtin' }, state);
  }
  function selectedDisplay(wallpaper) { var display = mainGroup(wallpaper).displays[0]; return display.kind === 'fixed' ? display.displayId : display.kind === 'unresolved' ? display.legacyName : ''; }
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
      selectOptions('monitor', [{ value: '', label: '主显示器（自动）' }].concat((payload.monitors || []).map(monitor => ({ value: monitor.displayId, label: monitor.label }))), selectedDisplay(draft.wallpaper));
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
        text.append(name, small); button.append(image, text); button.addEventListener('click', function () { if (!draft || editing) return; setBuiltin(draft.wallpaper, scene.id, false); changed(true); renderForm(); });
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
  function renderForm() {
    if (!draft) return;
    var wallpaper = draft.wallpaper, lyrics = draft.lyrics;
    $('enabled').checked = !!wallpaper.enabled; $('fps').value = String(presentation(wallpaper).fps); $('music').value = wallpaper.audioInput.kind;
    $('audio-gain').value = String(wallpaper.audioInput.gain == null ? 1 : wallpaper.audioInput.gain);
    $('audio-attack').value = String(wallpaper.audioInput.attackMs == null ? 40 : wallpaper.audioInput.attackMs);
    $('audio-release').value = String(wallpaper.audioInput.releaseMs == null ? 250 : wallpaper.audioInput.releaseMs);
    $('scene-source').value = packageSelection(wallpaper) ? 'library' : follows(wallpaper) ? 'follow' : 'fixed';
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
    ['enabled','monitor','fps','quality','brightness','motion','music','scene-source','lyrics-enabled','lyrics-locked','lyrics-size','lyrics-weight','lyrics-sung','lyrics-unsung','lyrics-outline','lyrics-stroke','lyrics-opacity','profile'].forEach(id => $(id).disabled = disabled);
    $('scene-fixed').disabled = disabled || !draft || !builtin(draft.wallpaper);
    var mediaSelection = draft && packageSelection(draft.wallpaper), metadata = draft && mediaMetadata(draft.wallpaper);
    var isVideo = metadata && metadata.kind === 'video';
    $('scene-source').querySelector('[value=library]').hidden = !mediaSelection;
    $('scene-fixed').closest('label').hidden = !!mediaSelection;
    ['fps','quality','music'].forEach(function (id) { $(id).disabled = disabled || !!mediaSelection; });
    var audioInput = draft && draft.wallpaper.audioInput;
    $('audio-device-field').hidden = !audioInput || audioInput.kind !== 'system' || !!mediaSelection;
    $('audio-device').disabled = disabled || !!mediaSelection || !audioInput || audioInput.kind !== 'system';
    ['audio-gain','audio-attack','audio-release'].forEach(function (id) { $(id).disabled = disabled || !!mediaSelection || !audioInput || audioInput.kind === 'none'; });
    $('audio-options').hidden = !!mediaSelection || !audioInput || audioInput.kind === 'none';
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
    $('apply').disabled = disabled || !dirty || conflict || !!document.querySelector('#panel-lyrics input:invalid, #panel-wallpaper input:invalid');
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
    $('preview').disabled = !ready || editing || pending || (!!mediaSelection && !mediaPreviewAvailable);
    $('preview').textContent = previewActive ? '结束预览' : '开始预览';
    $('settings-state').textContent = !ready ? '读取中' : editing ? '正在调整位置' : pending ? (applyInFlight ? '正在应用' : '正在处理') : conflict ? '草稿需要重读' : dirty ? '未应用修改' : '设置已保存';
    $('settings-state').dataset.dirty = String(dirty);
    $('conflict').hidden = !conflict;
    $('discard-close').disabled = pending;
    if (!dirty && !pending) $('close-confirm').hidden = true;
    updateProfilePath();
    document.querySelectorAll('[data-library-select], .library-delete').forEach(function (button) { button.disabled = disabled; });
  }
  function renderRuntime(payload) {
    var runtime = payload.runtime || {}, wallpaper = runtime.wallpaper || {}, policy = runtime.policy || {}, diagnostics = runtime.diagnostics || {};
    var reasons = diagnostics.pauseReasons || [];
    var reasonText = { fullscreen:'全屏应用正在运行', sessionUnavailable:'Windows 已锁屏或会话不可用', displayOff:'显示器已关闭', displayMissing:'目标显示器未连接', manualPause:'已从托盘隐藏', battery:'使用电池供电', noSurface:'壁纸尚未挂载', pageNotReady:'渲染页面正在准备' };
    var state = !wallpaper.enabled ? '壁纸未启用' : wallpaper.monitorMissing ? '目标显示器未连接' : wallpaper.hidden ? '壁纸已从托盘隐藏' : wallpaper.visible ? '壁纸正在运行' : diagnostics.recovery && diagnostics.recovery.terminal ? '壁纸挂载失败' : reasons.some(reason => ['fullscreen','sessionUnavailable','displayOff','displayMissing','battery'].includes(reason)) ? '壁纸已按运行规则暂停' : '壁纸正在准备';
    var waitingForScene = payload.config && follows(payload.config) && !payload.spaceScene;
    var unsupportedScene = payload.config && follows(payload.config) && payload.spaceScene && !scenes.some(scene => scene.id === payload.spaceScene);
    if (wallpaper.enabled && wallpaper.visible && (waitingForScene || unsupportedScene)) state = '等待来源 · ' + sceneLabel(selectedScene(payload.config));
    if (wallpaper.visible && wallpaper.staticPoster) state = '视频播放失败 · 显示静态封面';
    if (wallpaper.selectionPreparing || wallpaper.candidateLoading) state = wallpaper.visible ? '正在准备新壁纸 · 旧画面继续显示' : '壁纸正在准备';
    if (wallpaper.handoff && wallpaper.handoff.visible) state = wallpaper.applyError ? '新壁纸未能显示 · 保留上一帧' : '正在切换壁纸 · 保留上一帧';
    var running = wallpaper.visible && !wallpaper.staticPoster && !(wallpaper.handoff && wallpaper.handoff.visible);
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
    var audio = wallpaper.audio || {};
    $('audio-state').textContent = audio.previewBlocked ? '预览所选设备与桌面不同；音频响应已停止，请选择相同设备。'
      : audio.error ? '系统音频：' + audio.error
      : audio.phase === 'running' ? '正在采集系统播放声音' + (audio.info ? ' · ' + (audio.info.sampleRate / 1000) + ' kHz' : '') + (audio.desktopConsumer && audio.previewConsumer ? ' · 桌面与预览共享' : '')
      : audio.phase === 'stopping' ? '正在释放旧音频设备…'
      : audio.phase === 'starting' || audio.phase === 'pending' ? '等待所选播放设备的声音…'
      : draft && draft.wallpaper.audioInput.kind === 'system' ? '系统音频未采集；运行场景或开始预览后启用。' : '';
    $('audio-retry').hidden = audio.phase !== 'failed';
    $('wallpaper-detail').textContent = detail;
    $('wallpaper-show').hidden = !wallpaper.hidden;
    $('wallpaper-retry').hidden = !wallpaper.enabled || wallpaper.monitorMissing || (wallpaper.pageReady && !wallpaper.applyError && !(diagnostics.recovery && diagnostics.recovery.terminal));
    $('lyrics-state').textContent = editing ? '歌词已临时解锁，可拖动位置' : !runtime.enabled ? '歌词未启用' : runtime.userHidden ? '歌词已从托盘隐藏' : runtime.visible ? (runtime.locked ? '歌词正在显示 · 已锁定' : '歌词正在显示 · 可拖动') : policy.noContent && runtime.locked ? '等待可显示的歌词' : '歌词已按运行规则隐藏';
    $('lyrics-dot').className = 'state-dot' + (runtime.visible ? ' running' : '');
    $('lyrics-detail').textContent = payload.sourceMessage || (runtime.source === 'ok' ? '已连接播放器，歌词随播放自动更新。' : '等待播放器与歌词内容。');
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
    latest = payload;
    if (!dirty && !pending && nativeDraft && nativeDraft.baseRevision !== payload.revision) releaseNativeDraft();
    if (payload.navigationRequest && navigationId !== payload.navigationRequest.id) {
      navigationId = payload.navigationRequest.id;
      setTab(payload.navigationRequest.tab);
    }
    var applied = payload.message === '已应用' || payload.message === '已切换来源';
    if (payload.message === '已切换来源') { nativeDraft = null; ++draftEpoch; }
    if (payload.config && payload.lyricsConfig) {
      saved = { wallpaper: clone(payload.config), lyrics: clone(payload.lyricsConfig) };
      if (!dirty || (applied && !applyInFlight)) { draft = clone(saved); revision = payload.revision; dirty = false; conflict = false; pending = applyInFlight; }
      else if (payload.revision !== revision) conflict = true;
      ready = true;
    }
    editing = !!payload.positionEditing;
    mediaPreviewAvailable = payload.mediaPreviewAvailable === true;
    previewActive = !!payload.previewActive;
    previewLease = payload.previewLease || null;
    if (payload.error) { if (!applyInFlight) pending = false; status(payload.error, true); }
    else if (payload.message) status(payload.message, false);
    else if (!$('status').classList.contains('error')) status(editing ? '正在调整真实歌词位置；关闭窗口会取消本次调整。' : dirty ? '草稿尚未应用；两个页面的修改会一起保存。' : '设置已保存。实际显示状态见上方。', false);
    renderMetadata(payload);
    // Status polling never rewrites inputs while the user is typing.
    var activeInput = document.activeElement && /^(INPUT|SELECT)$/.test(document.activeElement.tagName);
    if (hotkeyPending) {
      hotkeyPending = false;
      if (payload.message === '已更新恢复快捷键') exitHotkeyCapture();
    }
    if ((!dirty && !activeInput) || applied && !applyInFlight) renderForm(); else { renderPreview(); syncControls(); }
    renderRuntime(payload);
    renderHotkey(payload);
  }
  function changed(wallpaperChanged) {
    if (!draft) return;
    dirty = JSON.stringify(draft) !== JSON.stringify(saved);
    if (!dirty) { conflict = false; revision = latest.revision; }
    status('草稿尚未应用；两个页面的修改会一起保存。', false);
    renderPreview(); syncControls();
    if (wallpaperChanged && previewActive) { clearTimeout(previewTimer); previewTimer = setTimeout(function () { startNativePreview(true); }, 180); }
  }
  ['enabled','fps','music','audio-device','audio-gain','audio-attack','audio-release','monitor','scene-source','scene-fixed','quality','brightness','motion','media-fit','pointer'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      if (!draft) return;
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
      else if (id === 'monitor') group.displays = this.value ? [{ kind: 'fixed', displayId: this.value }] : [{ kind: 'primary' }];
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
    if (tab !== 'wallpaper' && previewActive) releaseNativePreview();
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
  $('apply').addEventListener('click', function () { if (!dirty || conflict || editing) return; if (!document.querySelector('#panel-lyrics input:invalid, #panel-wallpaper input:invalid')) { applyNativeDraft(); } else status('请检查字号、描边宽度与音频参数的有效范围。', true); });
  $('discard').addEventListener('click', function () { dirty = false; conflict = false; pending = false; draft = clone(saved); revision = latest.revision; releaseNativePreview(); releaseNativeDraft(); renderForm(); status('已放弃草稿，读取最新保存的设置。', false); });
  $('close').addEventListener('click', requestClose);
  $('continue-editing').addEventListener('click', function () { $('close-confirm').hidden = true; $('close').focus(); });
  $('discard-close').addEventListener('click', function () { dirty = false; send('close'); });
  ['position-begin','position-done','position-cancel','wallpaper-show','wallpaper-retry','lyrics-show'].forEach(id => $(id).addEventListener('click', () => send(id)));
  function unmountPreview() { clearTimeout(previewTimer); previewActive = false; previewLease = null; invalidatePosters(); }
  window.hertzWallpaperSettings = {
    applyStatus: applyStatus, setTab: setTab, requestClose: requestClose,
    requestManagement: requestManagement, applyManagement: applyManagement,
    chooseLibraryVersion: chooseLibraryVersion,
    canChooseLibraryVersion: canChooseLibraryVersion,
    readPoster: readPoster,
    invalidatePosters: invalidatePosters,
    unmountPreview: unmountPreview
  };
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
  window.addEventListener('pagehide', function () { if (previewLease) requestManagement('wallpaper.preview.release', { leaseId: previewLease }).catch(function () {}); send('position-cancel'); });
  send('ready');
})();
