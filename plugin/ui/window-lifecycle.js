// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// Only the native main window owns this handshake. HTTP clients never confirm it.
(function () {
  'use strict';

  var host = null, transport = null, refs = null, current = null;
  var initialized = false, requestSent = false, committedBehavior = 'hide';
  var presented = new Set();

  function isNative() {
    var candidate = window.__hertzWindowHost;
    return !(window.hertzHost && window.hertzHost.isDbx) && !!candidate && candidate.lifecycleVersion === 1
      && ['lifecycleReady', 'acknowledgeQuit', 'confirmQuit', 'requestQuit'].every(function (key) {
        return typeof candidate[key] === 'function';
      });
  }

  function errorText(error) { return error && error.message ? error.message : String(error || '请稍后重试'); }
  function alive(context) { return current === context; }
  function recording() {
    return !!(window.VideoExport && typeof window.VideoExport.isRecording === 'function' && window.VideoExport.isRecording());
  }
  function recordingPhase() {
    return window.VideoExport && typeof window.VideoExport.status === 'function' ? window.VideoExport.status().phase : 'recording';
  }

  function note(text, failed) {
    refs.settingStatus.textContent = text;
    refs.settingStatus.classList.toggle('window-lifecycle-error', !!failed);
  }

  async function loadSettings() {
    refs.behavior.disabled = true;
    refs.retry.hidden = true;
    note('正在读取关闭行为…');
    try {
      var snapshot = await transport.get('/v1/window/state');
      if (!snapshot || snapshot.available !== true) throw new Error('原生窗口状态暂不可用');
      committedBehavior = snapshot.closeBehavior === 'quit' ? 'quit' : 'hide';
      refs.behavior.value = committedBehavior;
      refs.behavior.disabled = false;
      note(committedBehavior === 'hide' ? '隐藏后音乐继续播放，可从系统托盘恢复主窗口。' + (snapshot.backgroundPlayback ? ' 页面重载或断开时仍由原生窗口管理播放。' : '') : '关闭主窗口时将退出播放器；音乐会停止，一起听房间会结束。');
    } catch (error) {
      refs.behavior.value = committedBehavior;
      refs.retry.hidden = false;
      note('关闭行为读取失败：' + errorText(error), true);
    }
  }

  async function saveSettings() {
    var next = refs.behavior.value;
    if (next !== 'hide' && next !== 'quit') return;
    refs.behavior.disabled = true;
    note('正在保存关闭行为…');
    try {
      // Await the typed endpoint directly: the generic settings helper swallows errors.
      await transport.put('/v1/window/settings', { closeBehavior: next });
      committedBehavior = next;
      note(next === 'hide' ? '已保存。隐藏后音乐继续播放，可从系统托盘恢复主窗口。' : '已保存。关闭主窗口时将退出播放器。');
    } catch (error) {
      refs.behavior.value = committedBehavior;
      note('保存失败，已恢复上次设置：' + errorText(error), true);
    } finally { refs.behavior.disabled = false; }
  }

  function render(context) {
    if (!alive(context)) return;
    var activity = context.snapshot.activity || {};
    var warnings = [];
    if (activity.playing) warnings.push('正在播放的音乐将停止');
    if (activity.roomActive) warnings.push('一起听房间将结束');
    refs.activity.textContent = warnings.length ? warnings.join('，') + '。' : '';
    refs.activity.hidden = !warnings.length;
    refs.recording.hidden = !context.hasRecording;
    refs.recording.textContent = '歌词视频仍在录制或收尾。退出前会停止录制并等待视频生成；请确认下载文件已保存。';
    refs.status.textContent = context.message;
    refs.status.classList.toggle('window-lifecycle-error', !!context.error);
    refs.cancel.disabled = context.busy;
    refs.approve.disabled = context.busy || context.saving || !context.acknowledged;
    refs.approve.textContent = context.error === 'save' ? '仍然退出'
      : context.error === 'recording' ? '重试结束录制'
        : context.recordingFinished ? '确认视频已保存并退出'
        : context.hasRecording ? '结束录制并退出' : '退出播放器';
    refs.dialog.setAttribute('aria-busy', String(context.busy || context.saving));
  }

  function release(context) {
    if (!alive(context)) return;
    current = null;
    if (refs.dialog.open) refs.dialog.close();
  }

  async function cancel() {
    var context = current;
    if (!context || context.busy) return;
    context.busy = true;
    render(context);
    try {
      await host.confirmQuit(context.requestId, context.presentation, false);
      if (!alive(context)) return;
      requestSent = false;
      release(context);
    } catch (error) {
      if (!alive(context)) return;
      context.busy = false;
      context.error = 'host';
      context.message = '取消退出失败：' + errorText(error) + '。请重试。';
      render(context);
    }
  }

  async function flush(context) {
    try {
      // flushPersistence drains CreativeStage's debounce before StagePersistence;
      // reading persistence status alone would miss edits still in that timer.
      var stage = window.CreativeStage;
      if (!window.StagePersistence || typeof window.StagePersistence.status !== 'function') throw new Error('无法确认舞台保存状态，请返回播放器检查');
      if (stage && typeof stage.hydrated === 'function') await stage.hydrated();
      if (!alive(context)) return;
      if (window.StagePersistence.status().hydrated !== true) throw new Error('舞台设置尚未读取完成，请返回播放器检查');
      var tasks = ['flushPersistence', 'flushLibrary'].map(function (key) {
        return Promise.resolve().then(function () {
          if (!stage || typeof stage[key] !== 'function') throw new Error('无法确认舞台保存状态');
          return stage[key]();
        });
      });
      var results = await Promise.allSettled(tasks);
      if (!alive(context)) return;
      var failure = results.find(function (result) { return result.status === 'rejected'; });
      if (failure) throw failure.reason;
      context.saving = false;
      context.hasRecording = context.hasRecording || recording();
      context.message = context.hasRecording ? '舞台与预置库已保存。录制需要你确认后才能结束。'
        : '舞台与预置库已保存。';
      render(context);
      var activity = context.snapshot.activity || {};
      if (!activity.playing && !activity.roomActive && !context.snapshot.needsConfirmation && !context.hasRecording && context.acknowledged) {
        await approve(false);
      }
    } catch (error) {
      if (!alive(context)) return;
      context.saving = false;
      context.error = 'save';
      context.saveFailed = true;
      context.message = '舞台或预置库尚未保存：' + errorText(error) + '。返回播放器可继续处理；选择“仍然退出”会丢失未保存的更改。';
      render(context);
    }
  }

  async function approve(explicit) {
    var context = current;
    if (!context || context.busy || context.saving || !context.acknowledged) return;
    // A recording may start while the save was in flight. Never stop it implicitly.
    if (recording() && !context.hasRecording) {
      context.hasRecording = true;
      render(context);
      return;
    }
    if (!explicit && (context.hasRecording || context.error)) return;
    context.busy = true;
    render(context);
    try {
      if (context.hasRecording && !context.recordingFinished) {
        context.message = '正在结束录制并生成视频，请稍候…';
        render(context);
        var phase = recordingPhase();
        // The recording may have ended naturally while this dialog was open.
        // stop() then resolves null; inspect the completed result instead.
        var result = phase === 'idle' ? window.VideoExport.status()
          : await window.VideoExport.stop('退出播放器前结束录制。');
        if (!alive(context)) return;
        if (recording()) throw new Error('录制仍未结束');
        // VideoExport also reports encoder/download failures as fulfilled results.
        // Cancelling a starting session legitimately produces no video data.
        if (phase !== 'starting' && (!result || !result.bytes || !result.downloadRequested || result.failed === true)) {
          throw new Error(result && result.message || '未能生成并下载录制文件，请返回录制面板处理');
        }
        context.recordingFinished = true;
        context.error = null;
        if (phase !== 'starting') {
          context.busy = false;
          context.message = '视频已生成并发起下载。请在下载位置确认文件已保存，再确认退出。' + (context.saveFailed ? ' 舞台或预置库仍有未保存的修改，退出将丢弃这些修改。' : '');
          render(context);
          return;
        }
      }
    } catch (error) {
      if (!alive(context)) return;
      context.busy = false;
      context.error = 'recording';
      context.message = '录制收尾失败：' + errorText(error) + '。可重试，或返回播放器检查视频。';
      render(context);
      return;
    }
    if (!alive(context)) return;
    context.message = '正在退出播放器…';
    render(context);
    try {
      await host.confirmQuit(context.requestId, context.presentation, true, explicit === true);
      // Keep the dialog disabled until the host publishes a terminal state.
    } catch (error) {
      if (!alive(context)) return;
      context.busy = false;
      context.error = 'host';
      context.message = '退出请求未送达：' + errorText(error) + '。请重试或返回播放器。';
      render(context);
    }
  }

  function onRequest(event) {
    var detail = event.detail || {}, snapshot = detail.snapshot;
    if (!snapshot || snapshot.phase !== 'pending' || snapshot.requestId == null || detail.presentation == null) return;
    var key = JSON.stringify([snapshot.requestId, detail.presentation]);
    if (presented.has(key)) return;
    if (current) release(current);
    var context = {
      requestId: snapshot.requestId, presentation: detail.presentation, snapshot: snapshot,
      saving: true, busy: false, acknowledged: false, error: null,
      hasRecording: recording(), recordingFinished: false,
      message: '正在保存舞台与预置库，请稍候…'
    };
    current = context;
    requestSent = true;
    render(context);
    refs.dialog.showModal();
    refs.cancel.focus();
    presented.add(key);
    if (presented.size > 32) presented.delete(presented.values().next().value);
    // The native fallback is suppressed only after a visible, cancellable owner
    // exists. Do not await any persistence or recording work before this ACK.
    try {
      var acknowledgment = host.acknowledgeQuit(context.requestId, context.presentation);
      context.acknowledged = true;
      Promise.resolve(acknowledgment).catch(function (error) {
        if (!alive(context)) return;
        context.acknowledged = false;
        context.error = 'host';
        context.message = '无法接管退出请求：' + errorText(error) + '。请返回播放器后重试。';
        render(context);
      });
      void flush(context);
    } catch (error) {
      context.saving = false;
      context.error = 'host';
      context.message = '无法接管退出请求：' + errorText(error) + '。请返回播放器后重试。';
      render(context);
    }
  }

  function onState(event) {
    var snapshot = event.detail;
    if (!snapshot) return;
    if (snapshot.phase === 'pending') {
      if (current && snapshot.requestId === current.requestId) {
        current.snapshot = snapshot;
        render(current);
      }
      return;
    }
    if (!['idle', 'cancelled', 'failed', 'exiting'].includes(snapshot.phase)) return;
    // A late terminal response for an earlier request cannot close the new one.
    if (current && snapshot.requestId !== current.requestId) return;
    requestSent = false;
    if (current) release(current);
    if (snapshot.phase === 'failed' && typeof window.toast === 'function') window.toast('退出失败：' + errorText(snapshot.error), 'error');
  }

  function init(api) {
    if (initialized || (window.hertzHost && window.hertzHost.isDbx)) return;
    if (!isNative()) {
      // The host may finish its DOM setup after app.js has initialized. This
      // inert listener does not read native endpoints in an ordinary browser.
      window.addEventListener('hertz-native-host-ready', function ready() { init(api); }, { once: true });
      return;
    }
    initialized = true;
    host = window.__hertzWindowHost;
    transport = api;
    var byId = function (id) { return document.getElementById('window-lifecycle-' + id); };
    refs = { setting: byId('setting'), behavior: byId('behavior'), settingStatus: byId('setting-status'),
      retry: byId('retry'), dialog: byId('dialog'), activity: byId('activity'), recording: byId('recording'),
      status: byId('status'), cancel: byId('cancel'), approve: byId('approve') };
    if (Object.keys(refs).some(function (key) { return !refs[key]; })) return;
    refs.setting.hidden = false;
    refs.behavior.addEventListener('change', saveSettings);
    refs.retry.addEventListener('click', loadSettings);
    refs.cancel.addEventListener('click', cancel);
    refs.approve.addEventListener('click', function () { void approve(true); });
    refs.dialog.addEventListener('cancel', function (event) { event.preventDefault(); void cancel(); });
    // Own Escape ahead of the stage's document capture handlers. Other keys
    // retain their native button/Tab behavior without invoking app shortcuts.
    window.addEventListener('keydown', function (event) {
      if (!refs.dialog.open) return;
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); void cancel(); }
    }, true);
    window.addEventListener('hertz-native-exit-request', onRequest);
    window.addEventListener('hertz-native-exit-state', onState);
    host.lifecycleReady();
    void loadSettings();
  }

  function requestExit() {
    if (!isNative() || requestSent) return;
    requestSent = true;
    try {
      return Promise.resolve(window.__hertzWindowHost.requestQuit()).catch(function (error) {
        requestSent = false;
        if (typeof window.toast === 'function') window.toast('退出请求未送达：' + errorText(error), 'error');
      });
    } catch (error) {
      requestSent = false;
      if (typeof window.toast === 'function') window.toast('退出请求未送达：' + errorText(error), 'error');
    }
  }

  window.WindowLifecycle = Object.freeze({ init: init, isNative: isNative, requestExit: requestExit });
})();
