// SPDX-License-Identifier: MIT
// Main-window desktop lyrics settings. Reads never enable a desktop surface.
(function () {
  'use strict';

  var refs = null, transport = null, owner = null, dialog = null;
  var viewRoot = null, viewObserver = null;
  var latest = null, baseline = null, draft = null, baseRevision = null;
  var pending = '', flight = null, message = '', failed = false, conflict = false;
  var invalid = new Map(), heartbeat = 0, mayOwnPosition = false, cancelOnLeave = false, cancellationPending = false;
  var systemLight = window.matchMedia('(prefers-color-scheme: light)');
  var numeric = new Set(['fontSize', 'fontWeight', 'outlineWidth', 'opacity', 'width']);
  var boolean = new Set(['enabled', 'locked', 'bilingual', 'showVocals', 'karaoke', 'readabilityBoost']);
  var choices = {
    layout: ['single', 'double', 'triple'], secondary: ['next', 'translation', 'romanization'],
    theme: ['auto', 'light', 'dark'], surface: ['bare', 'glass', 'solid'], align: ['left', 'center', 'right']
  };
  var defaults = { enabled: false, locked: false, layout: 'single', secondary: 'next', bilingual: false, showVocals: true,
    fontSize: 30, fontWeight: 600, sungColor: '#ffffff', unsungColor: '#ffffff', outlineColor: '#000000',
    outlineWidth: 0, opacity: 1, fontFamily: 'Segoe UI', theme: 'auto', surface: 'bare', align: 'center',
    karaoke: true, readabilityBoost: false, width: 550 };
  var clone = function (value) { return JSON.parse(JSON.stringify(value)); };
  var byId = function (id) { return document.getElementById('dls-' + id); };
  var isDbx = function () { return !!(window.hertzHost && window.hertzHost.isDbx); };
  var dirty = function () { return !!draft && (invalid.size > 0 || JSON.stringify(draft) !== JSON.stringify(baseline)); };
  var ownsPosition = function () { return !!(latest && latest.positionEditing && latest.positionOwned); };
  var visible = function () {
    return refs && !document.hidden && refs.root.isConnected && !refs.root.closest('[hidden]')
      && refs.root.getClientRects().length > 0;
  };
  var textError = function (error) { return error && error.message || '没有收到可确认的结果，请重新读取设置。'; };

  function newOwner() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    var hex = Array.from(bytes, function (value) { return value.toString(16).padStart(2, '0'); }).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  function readSnapshot(reply) {
    var value = reply && reply.lyricsConfig;
    // Missing legacy preferences adopt the native default without touching any saved choice.
    if (value && typeof value === 'object' && !Object.hasOwn(value, 'showVocals')) value.showVocals = true;
    if (!reply || !Number.isSafeInteger(reply.revision) || reply.revision < 0 || !value || Array.isArray(value)
      || typeof value !== 'object' || !Array.from(boolean).every(function (key) { return typeof value[key] === 'boolean'; })
      || !Array.from(numeric).every(function (key) { return typeof value[key] === 'number' && Number.isFinite(value[key]); })
      || !Object.keys(choices).every(function (key) { return choices[key].includes(value[key]); })
      || !['fontFamily', 'sungColor', 'unsungColor', 'outlineColor'].every(function (key) { return typeof value[key] === 'string'; })
      || typeof reply.positionEditing !== 'boolean' || typeof reply.positionOwned !== 'boolean') {
      throw new Error('桌面歌词设置返回不完整，请更新播放器后重新读取。');
    }
    return reply;
  }

  function adopt(reply, replaceDraft) {
    var snapshot = readSnapshot(reply), hadDraft = dirty();
    latest = clone(snapshot);
    mayOwnPosition = !!(snapshot.positionEditing && snapshot.positionOwned);
    if (!mayOwnPosition) { cancelOnLeave = false; cancellationPending = false; }
    if (!draft || replaceDraft || !hadDraft) {
      baseline = clone(snapshot.lyricsConfig);
      draft = clone(snapshot.lyricsConfig);
      baseRevision = snapshot.revision;
      conflict = false;
      invalid.clear();
      fillFields();
    } else {
      conflict = snapshot.revision !== baseRevision;
    }
  }

  function fillFields() {
    refs.fields.forEach(function (field) {
      var value = draft[field.dataset.dlsField];
      field.setCustomValidity(''); field.removeAttribute('aria-invalid');
      if (field.type === 'checkbox') field.checked = !!value;
      else if (field.type === 'color') field.value = color(value, '#ffffff');
      else field.value = String(value);
    });
  }

  function color(value, fallback) {
    var text = String(value || '');
    if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(text)) return text.slice(0, 7);
    if (/^#[0-9a-f]{3}$/i.test(text)) return '#' + text.slice(1).split('').map(function (c) { return c + c; }).join('');
    return fallback;
  }

  function preview() {
    var value = draft || defaults;
    var light = value.theme === 'light' || value.theme === 'auto' && systemLight.matches;
    var neutral = function (hex) { return color(hex, '#ffffff').toLowerCase() === '#ffffff' && light ? '#0b0d11' : color(hex, '#ffffff'); };
    var style = refs.preview.style;
    style.setProperty('--dls-font-size', value.fontSize + 'px');
    style.setProperty('--dls-weight', String(value.fontWeight));
    style.setProperty('--dls-family', JSON.stringify(value.fontFamily));
    style.setProperty('--dls-align', value.align);
    style.setProperty('--dls-sung', neutral(value.karaoke ? value.sungColor : value.unsungColor));
    style.setProperty('--dls-unsung', neutral(value.unsungColor));
    style.setProperty('--dls-outline', color(value.outlineColor, '#000000'));
    style.setProperty('--dls-stroke', value.outlineWidth + 'px');
    style.setProperty('--dls-opacity', String(value.opacity));
    refs.preview.dataset.layout = value.layout;
    refs.preview.dataset.theme = light ? 'light' : 'dark';
    refs.preview.dataset.surface = value.surface;
    refs.preview.dataset.boost = String(value.readabilityBoost);
    refs.previewSecondary.hidden = !value.bilingual;
    refs.previewSecondary.textContent = value.secondary === 'romanization' ? 'Rang yin yue liu zai ci ke' : 'Let the music stay in this moment';
    byId('font-size-value').textContent = value.fontSize + ' px';
    byId('opacity-value').textContent = Math.round(value.opacity * 100) + '%';
    byId('sung-color-value').textContent = color(value.sungColor, '#ffffff').toUpperCase();
    byId('unsung-color-value').textContent = color(value.unsungColor, '#ffffff').toUpperCase();
  }

  function runtimeText() {
    if (!latest) return '读取设置后显示桌面状态';
    var runtime = latest.runtime || {}, policy = runtime.policy || {};
    if (runtime.sessionStopped) return runtime.exitPreferenceSaved === false
      ? '桌面歌词本次已退出。退出偏好未保存，再次启动可能恢复。'
      : '桌面歌词已退出。启用歌词或从托盘定位可重新开始。';
    if (runtime.lyricsStatus === 'unsupported') return '当前桌面歌词组件不支持此歌词，请更新组件';
    if (runtime.lyricsStatus === 'invalid') return '歌词内容无效，请在播放器中重新导入';
    if (runtime.vocalCapacity === 0 && runtime.vocalMode && latest.lyricsConfig.showVocals) return '空间不足，请调整字号或屏幕设置';
    if (latest.positionEditing) return latest.positionOwned ? '真实歌词窗口已临时解锁，可拖动工具栏调整位置。' : '其他窗口正在调整桌面歌词的位置。';
    if (!latest.lyricsConfig.enabled) return '桌面歌词已关闭';
    if (runtime.visible) return '桌面歌词正在显示' + (runtime.locked ? ' · 已锁定并穿透鼠标' : ' · 可拖动');
    if (runtime.userHidden) return '桌面歌词已隐藏，可从系统托盘恢复显示。';
    if (policy.sessionUnavailable || policy.displayOff) return '锁屏或显示器关闭，桌面歌词暂时隐藏。';
    if (policy.fullscreen) return '全屏应用期间，桌面歌词暂时隐藏。';
    if (policy.noContent) return '等待有歌词的歌曲，播放后自动显示。';
    if (runtime.source && runtime.source !== 'ok') return '桌面歌词已启用，正在等待播放器歌词。';
    return '桌面歌词已启用，等待显示。';
  }

  function render() {
    if (!refs) return;
    var changed = dirty(), editing = !!(latest && latest.positionEditing), busy = !!pending;
    var unknownPosition = mayOwnPosition && !ownsPosition();
    var saveWaiting = !!(latest && latest.pendingSave);
    refs.root.setAttribute('aria-busy', String(busy));
    refs.controls.disabled = busy || !draft || editing || unknownPosition;
    refs.refresh.disabled = busy;
    refs.refresh.textContent = pending === 'read' ? '正在读取…' : failed ? '重新读取' : latest ? '刷新状态' : '读取设置';
    refs.apply.disabled = busy || !changed || invalid.size > 0 || conflict || editing || unknownPosition || saveWaiting
      || !!(latest && latest.canLock === false && draft && draft.locked);
    refs.apply.textContent = pending === 'apply' ? '正在应用…' : '应用到桌面';
    refs.discard.disabled = busy || !(changed || conflict) || editing || unknownPosition;
    refs.discard.textContent = conflict ? '放弃修改并读取最新' : '放弃修改';
    refs.positionBegin.hidden = ownsPosition();
    refs.positionBegin.disabled = busy || !draft || changed || conflict || editing || unknownPosition || saveWaiting;
    refs.positionSession.hidden = !ownsPosition();
    refs.positionDone.disabled = busy || !ownsPosition();
    refs.positionCancel.disabled = busy || !ownsPosition();
    refs.secondary.disabled = !draft || !draft.bilingual;
    refs.locked.disabled = !!(latest && latest.canLock === false && draft && !draft.locked);
    refs.conflict.hidden = !conflict;
    refs.runtime.textContent = runtimeText();
    byId('layout-vocals-note').hidden = !(latest && latest.runtime && latest.runtime.vocalMode);
    refs.status.dataset.error = String(failed);
    var blockingNote = saveWaiting ? '桌面歌词正在保存现有修改，请稍后刷新状态。'
      : latest && latest.canLock === false ? '系统托盘暂不可用，当前不能开启鼠标穿透。' : '';
    refs.status.textContent = (message ? message + (blockingNote && !failed ? ' · ' + blockingNote : '') : '') || (invalid.size ? Array.from(invalid.values())[0]
      : editing ? ownsPosition() ? '正在调整桌面位置；完成或取消后可继续编辑样式。' : '其他窗口正在调整位置，完成后请刷新。'
        : saveWaiting ? '桌面歌词正在保存现有修改，请稍后刷新状态。'
          : latest && latest.canLock === false ? '系统托盘暂不可用，当前不能开启鼠标穿透。'
            : changed ? '有未应用的修改' : latest ? '桌面歌词设置已读取' : '尚未读取桌面歌词设置');
    refs.draftNote.textContent = invalid.size ? Array.from(invalid.values())[0]
      : conflict ? '草稿仍保留在本页，尚未写入桌面。'
        : changed ? '样例展示的是当前草稿，点击应用后保存。' : '修改后点击应用，设置会自动保存。';
    preview();
  }

  function fieldChange(event) {
    if (!draft || refs.controls.disabled) return;
    var field = event.currentTarget, key = field.dataset.dlsField, value;
    field.setCustomValidity('');
    var problem = '';
    if (!field.checkValidity()) problem = '请检查“' + field.closest('label').querySelector('span').childNodes[0].textContent.trim() + '”的范围或填写内容。';
    else if (key === 'fontFamily' && (!field.value.trim() || new TextEncoder().encode(field.value).length > 256)) problem = '请填写有效的字体名称，长度不超过 256 字节。';
    if (problem) {
      invalid.set(key, problem); field.setAttribute('aria-invalid', 'true');
    } else {
      value = field.type === 'checkbox' ? field.checked : numeric.has(key) ? Number(field.value) : field.value;
      draft[key] = value;
      invalid.delete(key); field.removeAttribute('aria-invalid');
    }
    message = ''; failed = false;
    render();
  }

  function request(command, value, keepalive) {
    return transport.post('/v1/desktop/control', { command: command, value: value }, { timeoutMs: 55000, keepalive: !!keepalive });
  }

  function replyError(reply) {
    var descriptions = {
      revision_conflict: '桌面设置已更新。草稿已保留，请读取最新设置后再编辑。',
      position_edit_active: '已有位置调整正在进行，请先完成或取消。',
      position_owner_mismatch: '本次位置调整属于其他窗口，请在那里完成或取消。',
      position_edit_inactive: '位置调整已结束或超时，请刷新状态。',
      invalid_value: '部分样式参数无效，请检查后重试。',
      tray_unavailable: '系统托盘暂不可用，不能锁定并穿透鼠标。',
      save_failed: '保存失败，当前草稿已保留。',
      config_busy: '桌面歌词正在处理其他修改，请稍后刷新并重试。'
    };
    return descriptions[reply && reply.error] || reply && reply.message || '操作未完成，请重新读取设置。';
  }

  function stopHeartbeat() { clearTimeout(heartbeat); heartbeat = 0; }

  function scheduleHeartbeat() {
    stopHeartbeat();
    if (!ownsPosition() || cancelOnLeave || cancellationPending || !visible()) return;
    heartbeat = setTimeout(function () { heartbeat = 0; void refresh(true); }, 10000);
  }

  function afterOperation() {
    pending = ''; flight = null;
    render();
    if (cancelOnLeave && mayOwnPosition) { void finishPosition(false, true); return; }
    scheduleHeartbeat();
  }

  function refresh(renewing) {
    if (!refs || isDbx()) return Promise.resolve();
    if (flight) return flight;
    pending = 'read';
    if (!renewing) { message = '正在读取桌面歌词设置…'; failed = false; }
    render();
    flight = (async function () {
      try {
        var reply = await request('lyrics-settings', { owner: owner });
        adopt(reply, false);
        if (reply.ok !== true) { message = replyError(reply); failed = true; }
        else if (!renewing || failed) { message = dirty() ? '状态已刷新，未应用的草稿已保留。' : '桌面歌词设置已读取'; failed = false; }
        if (ownsPosition() && !visible()) cancelOnLeave = true;
      } catch (error) {
        message = '读取失败：' + textError(error) + (draft ? ' 当前草稿已保留。' : ''); failed = true;
      } finally { afterOperation(); }
    })();
    return flight;
  }

  function apply() {
    if (!refs || refs.apply.disabled || pending) return Promise.resolve();
    var submitted = clone(draft);
    pending = 'apply'; message = '正在应用桌面歌词设置…'; failed = false; render();
    flight = (async function () {
      try {
        var reply = await request('lyrics-apply', { expectedRevision: baseRevision, lyrics: submitted });
        adopt(reply, reply.ok === true);
        failed = reply.ok !== true;
        message = failed ? replyError(reply) : '已应用并保存桌面歌词设置';
      } catch (error) {
        message = '尚未确认保存结果：' + textError(error) + ' 当前草稿已保留，请刷新状态确认。'; failed = true;
      } finally { afterOperation(); }
    })();
    return flight;
  }

  function discard() {
    if (!latest || refs.discard.disabled) return;
    adopt(latest, true);
    message = '已放弃草稿，恢复最近读取的桌面设置。'; failed = false; render();
    void refresh(false);
  }

  function beginPosition() {
    if (!refs || refs.positionBegin.disabled || pending) return Promise.resolve();
    pending = 'begin'; mayOwnPosition = true; cancelOnLeave = false; cancellationPending = false;
    message = '正在临时显示并解锁桌面歌词…'; failed = false; render();
    flight = (async function () {
      try {
        var reply = await request('lyrics-position-begin', { expectedRevision: baseRevision, owner: owner });
        adopt(reply, reply.ok === true);
        failed = reply.ok !== true;
        message = failed ? replyError(reply) : '拖动桌面歌词工具栏调整位置，完成后返回这里保存位置。';
        if (mayOwnPosition && !visible()) cancelOnLeave = true;
      } catch (error) {
        message = '位置调整尚未确认：' + textError(error) + ' 请刷新状态确认。'; failed = true;
        cancelOnLeave = !visible();
      } finally { afterOperation(); }
    })();
    return flight;
  }

  function finishPosition(done, automatic) {
    if (!refs || pending || !(ownsPosition() || automatic && mayOwnPosition)) return Promise.resolve();
    stopHeartbeat(); pending = done ? 'done' : 'cancel'; cancellationPending = !done;
    message = done ? '正在保存歌词位置…' : '正在取消位置调整…'; failed = false; render();
    flight = (async function () {
      try {
        var reply = await request(done ? 'lyrics-position-done' : 'lyrics-position-cancel', { owner: owner }, automatic);
        adopt(reply, reply.ok === true);
        failed = reply.ok !== true;
        message = failed ? replyError(reply) : done ? '歌词位置已保存，原来的启用与锁定状态已恢复。'
          : automatic ? '已取消位置调整，歌词已恢复原位置。' : '已取消调整，歌词已恢复原位置与锁定状态。';
      } catch (error) {
        message = '位置调整结果尚未确认：' + textError(error)
          + (done ? ' 请刷新状态或重试保存位置。' : ' 请刷新状态或重试取消；超时后会自动恢复原状态。'); failed = true;
      } finally {
        // A failed cancellation must not create an unbounded retry loop or renew its lease.
        pending = ''; flight = null; render();
        if (done) scheduleHeartbeat();
      }
    })();
    return flight;
  }

  function onVisibility() {
    if (!refs || isDbx()) return;
    if (!visible()) {
      stopHeartbeat();
      if (mayOwnPosition) {
        cancelOnLeave = true;
        if (!pending) void finishPosition(false, true);
      }
    } else if (cancelOnLeave && mayOwnPosition && !pending) {
      void finishPosition(false, true);
    } else { scheduleHeartbeat(); }
  }

  function focus() {
    if (!refs || isDbx()) return;
    refs.root.scrollIntoView({ block: 'start', behavior: 'instant' });
    refs.root.focus({ preventScroll: true });
  }

  function open() {
    if (!dialog || isDbx()) return;
    if (!dialog.open) dialog.showModal();
    void refresh(false);
  }

  function init(api) {
    if (refs) return;
    var root = document.getElementById('desktop-lyrics-settings');
    if (!root) return;
    if (isDbx()) { root.hidden = true; root.dataset.hzAvailable = 'false'; return; }
    transport = api; owner = newOwner();
    dialog = document.createElement('dialog');
    dialog.id = 'desktop-lyrics-dialog';
    dialog.setAttribute('aria-labelledby', 'dls-dialog-title');
    dialog.innerHTML = '<header class="dls-dialog-header"><div><h2 id="dls-dialog-title">桌面歌词</h2><p>调整样式与布局，应用后生效</p></div>'
      + '<form method="dialog"><button type="submit" class="btn" autofocus>关闭</button></form></header>'
      + '<div class="dls-dialog-body"></div>';
    root.before(dialog);
    dialog.querySelector('.dls-dialog-body').appendChild(root);
    document.body.appendChild(dialog);
    dialog.addEventListener('close', onVisibility);
    // 点遮罩关闭：原生 dialog 的 backdrop 点击会以 dialog 自身为事件目标。
    dialog.addEventListener('click', function (event) { if (event.target === dialog) dialog.close(); });
    // 视图切换不派发 nav:changed（它只表示导航可见性设置变了）。离开设置页时
    // #view-settings 会 hidden，观察它才能可靠收起弹窗。
    viewRoot = document.getElementById('view-settings');
    function closeIfLeftSettings() {
      if (dialog.open && window.HertzShell && window.HertzShell.activeView() !== 'settings') dialog.close();
    }
    document.addEventListener('nav:changed', closeIfLeftSettings);
    if (viewRoot) {
      viewObserver = new MutationObserver(closeIfLeftSettings);
      viewObserver.observe(viewRoot, { attributes: true, attributeFilter: ['hidden'] });
    }
    var toggle = document.createElement('label');
    toggle.className = 'dls-toggle'; toggle.htmlFor = 'dls-show-vocals';
    var copy = document.createElement('span'); copy.textContent = '显示多人声';
    var help = document.createElement('small'); help.id = 'dls-vocals-help';
    help.textContent = '按作者标注显示同时演唱的内容，正文和副行合计最多四槽；空间不足时减少显示并提示';
    copy.appendChild(help);
    var input = document.createElement('input'); input.id = 'dls-show-vocals'; input.type = 'checkbox';
    input.dataset.dlsField = 'showVocals'; input.setAttribute('role', 'switch');
    input.setAttribute('aria-describedby', help.id); toggle.append(copy, input);
    byId('bilingual').closest('label').before(toggle);
    var layoutNote = document.createElement('small'); layoutNote.id = 'dls-layout-vocals-note';
    layoutNote.textContent = '仅用于无声部歌词'; layoutNote.hidden = true;
    byId('layout').setAttribute('aria-describedby', layoutNote.id);
    byId('layout').after(layoutNote);
    refs = { root: root, fields: Array.from(root.querySelectorAll('[data-dls-field]')), controls: byId('controls'),
      refresh: byId('refresh'), status: byId('status'), conflict: byId('conflict'), apply: byId('apply'), discard: byId('discard'),
      preview: byId('preview'), previewSecondary: byId('preview-secondary'), runtime: byId('runtime'), draftNote: byId('draft-note'),
      secondary: byId('secondary'), locked: byId('locked'), positionBegin: byId('position-begin'), positionSession: byId('position-session'),
      positionDone: byId('position-done'), positionCancel: byId('position-cancel') };
    refs.fields.forEach(function (field) { field.addEventListener(field.type === 'range' || field.type === 'text' || field.type === 'number' ? 'input' : 'change', fieldChange); });
    refs.refresh.addEventListener('click', function () { void refresh(false); });
    refs.apply.addEventListener('click', function () { void apply(); });
    refs.discard.addEventListener('click', discard);
    refs.positionBegin.addEventListener('click', function () { void beginPosition(); });
    refs.positionDone.addEventListener('click', function () { void finishPosition(true, false); });
    refs.positionCancel.addEventListener('click', function () { void finishPosition(false, false); });
    systemLight.addEventListener('change', preview);
    document.addEventListener('visibilitychange', onVisibility);
    var observer = new MutationObserver(onVisibility);
    observer.observe(root, { attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
    if (viewRoot) observer.observe(viewRoot, { attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
    window.addEventListener('pagehide', function () {
      stopHeartbeat(); cancelOnLeave = true;
      if (mayOwnPosition && pending !== 'done') {
        // Unload cannot await a queued operation; the owner lease covers a lost reply.
        void request('lyrics-position-cancel', { owner: owner }, true).catch(function () {});
      }
    });
    render(); // Registration only: no desktop read, launch, mutation or timer.
  }

  window.HertzDesktopLyricsSettings = Object.freeze({ init: init, refresh: refresh, focus: focus, open: open });
})();
