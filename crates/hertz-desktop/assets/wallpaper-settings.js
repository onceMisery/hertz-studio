(function () {
  'use strict';
  var $ = id => document.getElementById(id);
  var saved = null, draft = null, revision = 0, latest = null;
  var ready = false, dirty = false, conflict = false, previewActive = false, editing = false;
  var scenes = [], profiles = [], currentProfile = null, spaceScene = null;
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
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function send(cmd, extra) {
    if (window.ipc && window.ipc.postMessage) window.ipc.postMessage(JSON.stringify(Object.assign({ cmd: cmd }, extra || {})));
  }
  function status(text, error) { $('status').textContent = text; $('status').className = error ? 'error' : ''; }
  function profileKey(profile) { return profile ? String(profile.edition || '').toLowerCase() + '|' + String(profile.dataDir || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() : ''; }
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
    if (payload.profile) currentProfile = payload.profile;
    spaceScene = payload.spaceScene || null;
    var previous = $('profile').value;
    selectOptions('profile', profiles.map(function (profile) {
      var name = String(profile.dataDir || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      return { value: profileKey(profile), label: (profile.edition === 'standard' ? 'Standard' : 'Full') + ' · ' + name };
    }), previous || profileKey(currentProfile));
    if (payload.message === '已切换来源') $('profile').value = profileKey(currentProfile);
    if (draft) {
      selectOptions('scene-fixed', scenes.map(scene => ({ value: scene.id, label: scene.label })), draft.wallpaper.scene);
      selectOptions('monitor', [{ value: '', label: '主显示器（自动）' }].concat((payload.monitors || []).map(monitor => ({ value: monitor.name, label: monitor.label }))), draft.wallpaper.monitor || '');
    }
    var signature = scenes.map(scene => scene.id + scene.label).join('|');
    if ($('scene-grid').dataset.scenes !== signature) {
      $('scene-grid').replaceChildren();
      scenes.forEach(function (scene, index) {
        var button = document.createElement('button'); button.type = 'button'; button.dataset.scene = scene.id;
        var name = document.createElement('span'); name.textContent = scene.label;
        var small = document.createElement('small'); small.textContent = String(index + 1).padStart(2, '0') + ' / 动态场景';
        button.append(name, small); button.addEventListener('click', function () { if (!draft || editing) return; draft.wallpaper.scene = scene.id; draft.wallpaper.source = 'fixed'; changed(true); renderForm(); });
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
    $('enabled').checked = !!wallpaper.enabled; $('fps').value = String(wallpaper.fps); $('music').checked = !!wallpaper.musicResponse;
    $('scene-source').value = wallpaper.source;
    if (latest) renderMetadata(latest);
    $('lyrics-enabled').checked = !!lyrics.enabled; $('lyrics-locked').checked = !!lyrics.locked;
    $('lyrics-secondary').value = lyrics.secondary;
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
    var current = wallpaper.source === 'fixed' ? wallpaper.scene : spaceScene;
    $('scene-heading').textContent = sceneLabel(current);
    $('scene-following').textContent = wallpaper.source === 'fixed' ? '固定场景 · ' + sceneLabel(current) : '跟随三维空间 · ' + sceneLabel(current);
    if (current && !scenes.some(scene => scene.id === current)) $('scene-following').textContent += '（暂不支持壁纸）';
    document.querySelectorAll('[data-scene]').forEach(node => node.setAttribute('aria-pressed', String(wallpaper.source === 'fixed' && node.dataset.scene === wallpaper.scene)));
    var preset = currentPreset(lyrics);
    document.querySelectorAll('[data-preset]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.preset === preset)));
    $('lyrics-preset-status').textContent = preset ? ({single:'单行预设',double:'双行预设',triple:'三行景深预设',translation:'翻译预设'})[preset] : '自定义样式';
    var staticScene = scenes.find(scene => scene.id === current) || scenes.find(scene => scene.id === wallpaper.scene);
    var staticImage = $('scene-static');
    if (staticScene) {
      var thumbnail = '/scene-thumbnails/' + staticScene.id + '.jpg';
      if (staticImage.getAttribute('src') !== thumbnail) staticImage.src = thumbnail;
      staticImage.alt = sceneLabel(staticScene.id) + ' · 真实场景静态参考';
    }
    staticImage.hidden = previewActive || !staticScene;
    $('preview-placeholder').hidden = previewActive || !!staticScene;
    $('preview-kind').textContent = previewActive ? '实时效果预览' : '真实场景静态参考';
    var style = $('lyrics-preview').style;
    style.setProperty('--font-size', lyrics.fontSize + 'px'); style.setProperty('--font-weight', String(lyrics.fontWeight));
    style.setProperty('--font-family', lyrics.fontFamily); style.setProperty('--sung', lyrics.sungColor); style.setProperty('--unsung', lyrics.unsungColor);
    style.setProperty('--outline', lyrics.outlineColor); style.setProperty('--stroke', lyrics.outlineWidth + 'px'); style.setProperty('--opacity', String(lyrics.opacity));
    $('lyric-previous').hidden = lyrics.layout !== 'triple';
    $('lyric-next').hidden = lyrics.layout === 'single';
    $('lyrics-preview').classList.toggle('has-depth', lyrics.layout === 'triple');
    $('lyric-secondary').hidden = lyrics.bilingual === false;
    $('lyric-secondary').textContent = lyrics.secondary === 'romanization' ? 'Rang yin yue liu zai ci ke' : 'Let the music stay in this moment';
    $('lyrics-secondary').value = lyrics.secondary;
    $('opacity-value').textContent = Math.round(lyrics.opacity * 100) + '%';
  }
  function syncControls() {
    var disabled = !ready || editing || pending;
    ['enabled','monitor','fps','music','scene-source','lyrics-enabled','lyrics-locked','lyrics-size','lyrics-weight','lyrics-sung','lyrics-unsung','lyrics-outline','lyrics-stroke','lyrics-opacity','profile'].forEach(id => $(id).disabled = disabled);
    $('scene-fixed').disabled = disabled || !draft || draft.wallpaper.source !== 'fixed';
    $('lyrics-secondary').disabled = disabled || !draft || draft.lyrics.layout === 'single';
    document.querySelectorAll('[data-preset],[data-scene]').forEach(node => node.disabled = disabled);
    $('apply').disabled = disabled || !dirty || conflict || !!document.querySelector('#panel-lyrics input:invalid');
    $('discard').disabled = !ready || !dirty || editing || pending;
    $('position-begin').disabled = disabled || dirty;
    $('position-begin').title = dirty ? '请先应用或放弃草稿，再调整桌面位置' : '';
    $('position-session').hidden = !editing; $('position-begin').hidden = editing;
    $('autostart').disabled = disabled || dirty || !latest || latest.launchAtLogin == null;
    $('preview').disabled = !ready || editing || pending;
    $('preview').textContent = previewActive ? '结束预览' : '开始预览';
    $('settings-state').textContent = !ready ? '读取中' : editing ? '正在调整位置' : pending ? '正在应用' : conflict ? '草稿需要重读' : dirty ? '未应用修改' : '设置已保存';
    $('settings-state').dataset.dirty = String(dirty);
    $('conflict').hidden = !conflict;
    $('discard-close').disabled = pending;
    if (!dirty && !pending) $('close-confirm').hidden = true;
    updateProfilePath();
  }
  function renderRuntime(payload) {
    var runtime = payload.runtime || {}, wallpaper = runtime.wallpaper || {}, policy = runtime.policy || {}, diagnostics = runtime.diagnostics || {};
    var reasons = diagnostics.pauseReasons || [];
    var reasonText = { fullscreen:'全屏应用正在运行', sessionUnavailable:'Windows 已锁屏或会话不可用', displayOff:'显示器已关闭', noSurface:'壁纸尚未挂载', pageNotReady:'渲染页面正在准备' };
    var state = !wallpaper.enabled ? '壁纸未启用' : wallpaper.monitorMissing ? '目标显示器未连接' : wallpaper.hidden ? '壁纸已从托盘隐藏' : wallpaper.visible ? '壁纸正在运行' : diagnostics.recovery && diagnostics.recovery.terminal ? '壁纸挂载失败' : reasons.some(reason => ['fullscreen','sessionUnavailable','displayOff'].includes(reason)) ? '壁纸已按运行规则暂停' : '壁纸正在准备';
    var waitingForScene = payload.config && payload.config.source === 'follow' && !payload.spaceScene;
    var unsupportedScene = payload.config && payload.config.source === 'follow' && payload.spaceScene && !scenes.some(scene => scene.id === payload.spaceScene);
    if (wallpaper.enabled && wallpaper.visible && (waitingForScene || unsupportedScene)) state = waitingForScene ? '等待三维空间场景' : '当前空间场景暂不支持壁纸';
    var running = wallpaper.visible && !waitingForScene && !unsupportedScene;
    $('wallpaper-state').textContent = state;
    $('wallpaper-dot').className = 'state-dot' + (running ? ' running' : state.includes('失败') ? ' error' : '');
    $('wallpaper-detail').textContent = wallpaper.monitorMissing ? '重新连接目标显示器，或选择其他显示器后应用。' : unsupportedScene ? '可以在右侧选择固定场景后应用。' : waitingForScene ? '在播放器打开三维空间，或选择一个固定场景。' : wallpaper.visible ? '桌面实际运行 · ' + wallpaper.fps + ' fps' : reasons.map(reason => reasonText[reason]).filter(Boolean).join(' · ') || '启用并应用壁纸后，将显示在桌面图标后方。';
    $('wallpaper-show').hidden = !wallpaper.hidden;
    $('wallpaper-retry').hidden = !wallpaper.enabled || wallpaper.monitorMissing || (wallpaper.pageReady && !(diagnostics.recovery && diagnostics.recovery.terminal));
    $('lyrics-state').textContent = editing ? '歌词已临时解锁，可拖动位置' : !runtime.enabled ? '歌词未启用' : runtime.userHidden ? '歌词已从托盘隐藏' : runtime.visible ? (runtime.locked ? '歌词正在显示 · 已锁定' : '歌词正在显示 · 可拖动') : policy.noContent && runtime.locked ? '等待可显示的歌词' : '歌词已按运行规则隐藏';
    $('lyrics-dot').className = 'state-dot' + (runtime.visible ? ' running' : '');
    $('lyrics-detail').textContent = payload.sourceMessage || (runtime.source === 'ok' ? '已连接播放器，歌词随播放自动更新。' : '等待播放器与歌词内容。');
    $('lyrics-show').hidden = !runtime.userHidden;
    $('source-state').textContent = (payload.profile ? (payload.profile.edition === 'standard' ? 'Hertz Standard' : 'Hertz Full') + ' · ' : '') + (payload.sourceMessage || runtime.source || '等待连接');
    if (payload.launchAtLogin != null) $('autostart').checked = !!payload.launchAtLogin;
    $('autostart-state').textContent = payload.launchAtLogin == null ? '无法读取 Windows 启动项' : payload.launchAtLogin ? '系统启动项已启用' : '系统启动项未启用';
  }
  function applyStatus(payload) {
    if (!payload) return;
    latest = payload;
    if (payload.navigationRequest && navigationId !== payload.navigationRequest.id) {
      navigationId = payload.navigationRequest.id;
      setTab(payload.navigationRequest.tab);
    }
    var applied = payload.message === '已应用' || payload.message === '已切换来源';
    if (payload.config && payload.lyricsConfig) {
      saved = { wallpaper: clone(payload.config), lyrics: clone(payload.lyricsConfig) };
      if (!dirty || (applied && !payload.error)) { draft = clone(saved); revision = payload.revision; dirty = false; conflict = false; pending = false; }
      else if (payload.revision !== revision) conflict = true;
      ready = true;
    }
    editing = !!payload.positionEditing;
    previewActive = !!payload.previewActive;
    if (payload.error) { pending = false; status(payload.error, true); }
    else if (payload.message) status(payload.message, false);
    else if (!$('status').classList.contains('error')) status(editing ? '正在调整真实歌词位置；关闭窗口会取消本次调整。' : dirty ? '草稿尚未应用；两个页面的修改会一起保存。' : '设置已保存。实际显示状态见上方。', false);
    renderMetadata(payload);
    // Status polling never rewrites inputs while the user is typing.
    var activeInput = document.activeElement && /^(INPUT|SELECT)$/.test(document.activeElement.tagName);
    if ((!dirty && !activeInput) || applied && !payload.error) renderForm(); else { renderPreview(); syncControls(); }
    renderRuntime(payload);
  }
  function changed(wallpaperChanged) {
    if (!draft) return;
    dirty = JSON.stringify(draft) !== JSON.stringify(saved);
    if (!dirty) { conflict = false; revision = latest.revision; }
    status('草稿尚未应用；两个页面的修改会一起保存。', false);
    renderPreview(); syncControls();
    if (wallpaperChanged && previewActive) { clearTimeout(previewTimer); previewTimer = setTimeout(function () { send('preview', { config: draft.wallpaper }); }, 180); }
  }
  var wallpaperFields = { enabled:['enabled','check'], fps:['fps','number'], music:['musicResponse','check'], monitor:['monitor','monitor'], 'scene-source':['source','text'], 'scene-fixed':['scene','text'] };
  Object.keys(wallpaperFields).forEach(function (id) { $(id).addEventListener('change', function () { if (!draft) return; var field = wallpaperFields[id]; draft.wallpaper[field[0]] = field[1] === 'check' ? this.checked : field[1] === 'number' ? Number(this.value) : field[1] === 'monitor' ? this.value || null : this.value; changed(true); }); });
  var lyricsFields = { 'lyrics-enabled':['enabled','check'], 'lyrics-locked':['locked','check'], 'lyrics-secondary':['secondary','text'], 'lyrics-size':['fontSize','number'], 'lyrics-weight':['fontWeight','number'], 'lyrics-sung':['sungColor','text'], 'lyrics-unsung':['unsungColor','text'], 'lyrics-outline':['outlineColor','text'], 'lyrics-stroke':['outlineWidth','number'], 'lyrics-opacity':['opacity','number'] };
  Object.keys(lyricsFields).forEach(function (id) { $(id).addEventListener('input', function () { if (!draft) return; if (this.validity && !this.validity.valid || this.type === 'number' && this.value === '') { dirty = true; status('请填写有效的字号或描边宽度。', true); syncControls(); return; } var field = lyricsFields[id]; draft.lyrics[field[0]] = field[1] === 'check' ? this.checked : field[1] === 'number' ? Number(this.value) : this.value; changed(false); }); });
  document.querySelectorAll('[data-preset]').forEach(node => node.addEventListener('click', function () { if (!draft) return; Object.assign(draft.lyrics, presets[node.dataset.preset]); changed(false); renderForm(); }));
  function setTab(tab) {
    if (!['wallpaper','lyrics','runtime'].includes(tab)) return;
    if (activeTab !== tab) document.querySelector('main').scrollTop = 0;
    activeTab = tab;
    document.querySelectorAll('[data-tab]').forEach(function (node) { var active = node.dataset.tab === tab; node.setAttribute('aria-selected', String(active)); node.tabIndex = active ? 0 : -1; $('panel-' + node.dataset.tab).hidden = !active; });
    if (tab !== 'wallpaper' && previewActive) send('preview-close');
  }
  document.querySelectorAll('[data-tab]').forEach(node => { node.addEventListener('click', () => setTab(node.dataset.tab)); node.addEventListener('keydown', function (event) { var tabs = ['wallpaper','lyrics','runtime'], index = tabs.indexOf(activeTab), target = event.key === 'ArrowRight' ? tabs[(index+1)%3] : event.key === 'ArrowLeft' ? tabs[(index+2)%3] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[2] : null; if (target) { event.preventDefault(); setTab(target); $('tab-' + target).focus(); } }); });
  ['dark','light'].forEach(name => $('bg-' + name).addEventListener('click', function () { $('lyrics-preview').classList.toggle('light', name === 'light'); ['dark','light'].forEach(value => $('bg-' + value).setAttribute('aria-pressed', String(value === name))); }));
  $('profile').addEventListener('change', updateProfilePath);
  $('switch-source').addEventListener('click', function () { var profile = profiles.find(profile => profileKey(profile) === $('profile').value); if (profile && !dirty) { pending = true; syncControls(); send('switch-source', { profile: profile, expectedRevision: revision }); } });
  $('autostart').addEventListener('change', function () { send('autostart', { enabled: this.checked }); });
  $('preview').addEventListener('click', function () { if (previewActive) send('preview-close'); else send('preview', { config: draft.wallpaper }); });
  $('apply').addEventListener('click', function () { if (!dirty || conflict || editing) return; if (!document.querySelectorAll('#panel-lyrics input:invalid').length) { pending = true; syncControls(); send('apply', { expectedRevision: revision, config: draft.wallpaper, lyrics: draft.lyrics }); } else status('请检查字号和描边宽度的有效范围。', true); });
  $('discard').addEventListener('click', function () { dirty = false; conflict = false; pending = false; draft = clone(saved); revision = latest.revision; send('preview-close'); renderForm(); status('已放弃草稿，读取最新保存的设置。', false); });
  $('close').addEventListener('click', requestClose);
  $('continue-editing').addEventListener('click', function () { $('close-confirm').hidden = true; $('close').focus(); });
  $('discard-close').addEventListener('click', function () { dirty = false; send('close'); });
  ['position-begin','position-done','position-cancel','wallpaper-show','wallpaper-retry','lyrics-show'].forEach(id => $(id).addEventListener('click', () => send(id)));
  function unmountPreview() { var frame = $('preview-renderer'); if (frame) frame.remove(); $('preview-placeholder').hidden = false; clearTimeout(previewTimer); previewActive = false; renderPreview(); }
  window.hertzWallpaperSettings = {
    applyStatus: applyStatus, setTab: setTab, requestClose: requestClose,
    mountPreview: function () { setTab('wallpaper'); if ($('preview-renderer')) return; var frame = document.createElement('iframe'); frame.id = 'preview-renderer'; frame.title = '桌面壁纸效果预览'; frame.tabIndex = -1; frame.setAttribute('aria-hidden', 'true'); frame.src = '/wallpaper.html'; $('wallpaper-preview').appendChild(frame); $('preview-placeholder').hidden = true; $('scene-static').hidden = true; },
    unmountPreview: unmountPreview,
    evalPreview: function (script) { var frame = $('preview-renderer'); if (frame && frame.contentWindow) frame.contentWindow.eval(script); },
    previewEvent: function (event) { send('preview-event', { event: event }); }
  };
  setInterval(function () { if (previewActive && !document.hidden && activeTab === 'wallpaper') send('preview-renew'); }, 5000);
  document.addEventListener('visibilitychange', function () { if (document.hidden && previewActive) send('preview-close'); });
  window.addEventListener('pagehide', function () { send('preview-close'); send('position-cancel'); });
  send('ready');
})();
