// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
(function () {
  'use strict';

  function init(options) {
    var form = document.getElementById('dsp-settings');
    if (!form) return null;
    var bands = Array.from(form.querySelectorAll('input[data-band]'));
    var preamp = document.getElementById('dsp-preamp');
    var loudness = document.getElementById('dsp-loudness');
    var crossfade = document.getElementById('dsp-crossfade');
    var save = document.getElementById('dsp-save');
    var reset = document.getElementById('dsp-reset');
    var status = document.getElementById('dsp-status');
    var dirty = false, edits = 0, intent = 0, busy = false, reading = null, timer = 0, closed = false;
    var lastMessage = '正在读取音效设置…';

    function hidden() {
      return window.Stage && typeof window.Stage.isDocumentHidden === 'function'
        ? window.Stage.isDocumentHidden() : !!document.hidden;
    }
    function visible() { return !closed && !hidden() && form.getClientRects().length > 0; }
    function cancelTimer() { if (timer) clearTimeout(timer); timer = 0; }
    function note(message) {
      lastMessage = message;
      status.textContent = (dirty ? '有未保存的修改。' : '') + message;
    }
    function describe(cfg) {
      var application = cfg && cfg.application;
      if (!application) return '设置已保存；当前服务未提供均衡器生效状态。';
      switch (application.state) {
        case 'applied': return application.eq && application.eq.active
          ? '设置已保存，均衡器已应用到播放输出。'
          : '设置已保存，均衡器已应用；当前播放已暂停。';
        case 'applying': return '设置已保存，均衡器正在平滑切换…';
        case 'deferred': return '设置已保存，均衡器将在播放时应用。';
        case 'unavailable': return '设置已保存；当前没有可用的音频处理输出。';
        case 'room': return '本机设置已保存；一起听正在使用房间的共同音效。';
        case 'failed': return '设置已保存，应用失败：' + String(application.error && application.error.message || '请重试保存');
        default: return '设置已保存，正在确认均衡器状态。';
      }
    }
    function fill(cfg) {
      bands.forEach(function (input) { input.value = cfg.eq_gains_db[Number(input.dataset.band)] || 0; });
      preamp.value = cfg.preamp_db;
      loudness.value = cfg.loudness_mode || (cfg.loudness_norm ? 'track' : 'off');
      crossfade.value = cfg.crossfade_ms;
    }
    function schedule() {
      cancelTimer();
      if (visible() && !busy) timer = setTimeout(function () { timer = 0; if (visible()) refresh(false); }, 1000);
    }
    function refresh(fillInputs) {
      if (closed || busy) return Promise.resolve();
      if (reading) return reading;
      var requestIntent = intent, requestEdits = edits;
      reading = (async function () {
        try {
          var cfg = await options.transport.get('/v1/player/dsp');
          if (closed || requestIntent !== intent) return;
          if (dirty && bands.every(function (input) { return Number(input.value) === cfg.eq_gains_db[Number(input.dataset.band)]; })
              && Number(preamp.value) === cfg.preamp_db && loudness.value === cfg.loudness_mode
              && Number(crossfade.value) === cfg.crossfade_ms) dirty = false;
          if (!dirty && requestEdits === edits) fill(cfg);
          note(describe(cfg));
        } catch (error) {
          if (!closed && requestIntent === intent) note('暂时无法读取生效状态；保留当前修改。');
        } finally {
          reading = null;
          schedule();
        }
      })();
      return reading;
    }
    function changed() { dirty = true; edits++; note(lastMessage); }
    async function submit(event) {
      event.preventDefault();
      if (closed || busy || !form.reportValidity()) return;
      var requestEdits = edits;
      var requestIntent = ++intent;
      var body = {
        eq_gains_db: bands.map(function (input) { return Number(input.value); }),
        preamp_db: Number(preamp.value),
        loudness_mode: loudness.value,
        crossfade_ms: Number(crossfade.value)
      };
      cancelTimer();
      busy = true;
      save.disabled = true;
      reset.disabled = true;
      form.setAttribute('aria-busy', 'true');
      note('正在保存音效设置…');
      try {
        var cfg = await options.transport.post('/v1/player/dsp', body);
        if (closed || requestIntent !== intent) return;
        if (requestEdits === edits) { dirty = false; fill(cfg); }
        var message = describe(cfg);
        note(message);
        options.toast(message, cfg.application && cfg.application.state === 'failed' ? 'error' : undefined);
      } catch (error) {
        if (!closed && requestIntent === intent) {
          // A lost reply does not prove that the server did not save it. A GET
          // checks saved/effective state; never repeat the POST automatically.
          note('保存结果未确认，修改已保留；正在读取服务端状态。');
          options.toast('保存未确认：' + String(error && error.message || error), 'error');
        }
      } finally {
        busy = false;
        save.disabled = false;
        reset.disabled = false;
        form.setAttribute('aria-busy', 'false');
        schedule();
      }
    }
    function resetDraft() {
      if (busy) return;
      bands.forEach(function (input) { input.value = 0; });
      preamp.value = 0; loudness.value = 'off'; crossfade.value = 0;
      changed();
    }
    function visibilityChanged() {
      cancelTimer();
      if (visible()) refresh(false);
    }
    function destroy() {
      closed = true; intent++; cancelTimer();
      form.removeEventListener('submit', submit);
      form.removeEventListener('input', changed);
      form.removeEventListener('change', changed);
      reset.removeEventListener('click', resetDraft);
      document.removeEventListener('visibilitychange', visibilityChanged);
      window.removeEventListener('hertz-native-presentation', visibilityChanged);
      window.removeEventListener('hertz-native-host-ready', visibilityChanged);
      window.removeEventListener('pagehide', destroy);
    }
    form.addEventListener('submit', submit);
    form.addEventListener('input', changed);
    form.addEventListener('change', changed);
    reset.addEventListener('click', resetDraft);
    document.addEventListener('visibilitychange', visibilityChanged);
    window.addEventListener('hertz-native-presentation', visibilityChanged);
    window.addEventListener('hertz-native-host-ready', visibilityChanged);
    window.addEventListener('pagehide', destroy);
    return { load: function () { return refresh(true); }, destroy: destroy };
  }
  window.HertzDspSettings = { init: init };
})();
