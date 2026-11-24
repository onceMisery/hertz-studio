// SPDX-License-Identifier: MIT
(function () {
  'use strict';
  function init(options) {
    var root = document.getElementById('audio-quality-preview');
    if (!root) return null;
    var start = document.getElementById('audio-preview-start');
    var end = document.getElementById('audio-preview-end');
    var match = document.getElementById('audio-preview-match');
    var path = document.getElementById('audio-preview-path');
    var acknowledge = document.getElementById('audio-preview-phase');
    var sides = document.getElementById('audio-preview-sides');
    var status = document.getElementById('audio-preview-status');
    var radios = Array.from(sides.querySelectorAll('input[type=radio]'));
    var currentId = null, foreignId = null, intent = 0, preparing = false, switching = false;
    var active = false, closing = false, saving = false, cancelling = null, heartbeat = 0, capability = null;
    function visible() {
      var hidden = window.Stage && typeof Stage.isDocumentHidden === 'function' ? Stage.isDocumentHidden() : document.hidden;
      return !closing && !hidden && options.form.getClientRects().length > 0;
    }
    function note(message) { if (!closing && status.textContent !== message) status.textContent = message; }
    function buttons() {
      start.disabled = saving || preparing || switching || !!cancelling || !!currentId || !!foreignId || capability && capability.available === false;
      end.disabled = !!cancelling || !currentId && !foreignId;
      sides.disabled = saving || !active || switching || !!cancelling || !currentId;
      root.setAttribute('aria-busy', String(preparing || switching || !!cancelling));
    }
    function stopHeartbeat() { if (heartbeat) clearTimeout(heartbeat); heartbeat = 0; }
    function clearErrors() {
      [path, acknowledge].forEach(function (input) { input.setCustomValidity(''); input.removeAttribute('aria-invalid'); });
    }
    function scheduleHeartbeat() {
      stopHeartbeat();
      if (currentId && active && visible()) heartbeat = setTimeout(async function () {
        heartbeat = 0;
        var id = currentId, serial = intent;
        if (!visible()) { cancel('设置已隐藏，正在结束试听。'); return; }
        try {
          var result = await options.transport.post('/v1/player/audio-quality/preview/refresh', { request_id: id });
          if (serial !== intent || id !== currentId) return;
          if (!result.refreshed) { active = false; currentId = null; note('参考片段已结束，正在读取保存状态。'); buttons(); options.refresh(); return; }
          scheduleHeartbeat();
        } catch (error) {
          if (serial === intent && id === currentId) {
            stopHeartbeat(); note('试听连接中断；正在核对状态，服务端会在期限后结束试听。'); options.refresh();
          }
        }
      }, 5000);
    }
    function describe(preview, cfg) {
      var side = preview.side === 'bypass' ? '旁路' : '增强草稿';
      if (preview.state === 'starting' || preview.state === 'applying') return '正在采用临时试听；保存设置保持原版本。';
      var message = '正在试听' + side + '。';
      if (preview.matching) {
        var m = preview.matching;
        message += '同响度已匹配，复核差值 ' + Math.abs(m.residual_lu).toFixed(2) + ' LU；增强侧 ' + m.enhanced_attenuation_db.toFixed(2)
          + ' dB，旁路侧 ' + m.bypass_attenuation_db.toFixed(2) + ' dB，共同余量 ' + m.common_attenuation_db.toFixed(2) + ' dB。';
      } else { message += '普通旁路，响度未匹配。'; }
      if (preview.phase === 'unknown') message += '此 WAV 内在相位和群延迟未知，只对齐可确定的算法缓冲，不保证音画同步。';
      if (cfg.effective && cfg.effective.eq && !cfg.effective.eq.active) message += '当前播放已暂停。';
      return message + '参考片段结束或退出设置后恢复保存配置和进入前的位置。';
    }
    function onRead(cfg) {
      if (closing) return;
      capability = cfg.capabilities && cfg.capabilities.preview;
      var preview = cfg.effective && cfg.effective.preview;
      if (!visible()) { if (currentId) cancel('设置已隐藏，正在结束试听。'); return; }
      if (preview && preview.request_id === currentId) {
        foreignId = null; active = preview.state === 'active' || preview.state === 'applying';
        radios.forEach(function (radio) { radio.checked = radio.value === preview.side; });
        note(describe(preview, cfg));
        if (!heartbeat && active) scheduleHeartbeat();
      } else if (preview) {
        foreignId = preview.request_id;
        if (currentId && !preparing) { stopHeartbeat(); currentId = null; active = false; }
        note('另一界面正在临时试听。先结束当前试听，再试听这里的草稿；当前草稿已保留。');
      } else {
        foreignId = null;
        if (currentId && !preparing && !cancelling) { stopHeartbeat(); active = false; currentId = null; note('试听已结束，保存配置保持原版本。'); }
        if (!preparing && !currentId && capability && capability.available === false) note(capability.message || '请先播放当前曲目并使用可用的本机输出，再准备试听。');
      }
      buttons();
    }
    async function cancel(message) {
      if (cancelling) return cancelling;
      var id = currentId || foreignId;
      var serial = ++intent;
      stopHeartbeat(); clearErrors(); active = false; switching = false;
      if (!id) { buttons(); return; }
      currentId = null; foreignId = null;
      if (message) note(message);
      cancelling = (async function () {
        try {
          var result = await options.transport.post('/v1/player/audio-quality/preview/cancel', { request_id: id });
          if (!closing && serial === intent) note(result.message || '试听已结束，保存配置保持原版本。');
        } catch (error) {
          if (!closing && serial === intent) { currentId = id; note('结束试听的结果未确认；草稿已保留，正在读取状态。'); }
        } finally {
          cancelling = null; buttons(); if (!closing) options.refresh();
        }
      })();
      buttons();
      return cancelling;
    }
    async function begin() {
      if (saving || preparing || switching || currentId || foreignId || cancelling || closing || !visible()) return;
      clearErrors();
      if (path.value.trim() && !acknowledge.checked) {
        acknowledge.setCustomValidity('请确认这个 WAV 仅临时试听，未知相位不保证音画同步。');
        acknowledge.setAttribute('aria-invalid', 'true'); acknowledge.reportValidity(); return;
      }
      if (!options.form.reportValidity()) return;
      var revision = options.getRevision();
      if (revision === null) { note('尚未读取保存版本，请等待读取完成。'); return; }
      var d = structuredClone(options.getDraft());
      var id = crypto.randomUUID(), serial = ++intent;
      currentId = id; foreignId = null; preparing = true; active = false; buttons();
      note(match.checked ? '正在准备固定参考片段并分别测量两侧响度…' : '正在准备固定参考片段，普通旁路暂不匹配响度…');
      try {
        var cfg = await options.transport.post('/v1/player/audio-quality/preview', {
          request_id: id, expected_revision: revision,
          patch: { eq: d.eq, preamp_db: d.preamp_db, headroom_mode: d.headroom_mode, tone: d.tone, impulse_id: d.impulse_id },
          match_loudness: match.checked, impulse_path: path.value.trim() || null,
          acknowledge_unknown_phase: acknowledge.checked
        });
        if (closing || serial !== intent || id !== currentId || !visible()) {
          options.transport.post('/v1/player/audio-quality/preview/cancel', { request_id: id }).catch(function () {}); return;
        }
        options.onState(cfg); onRead(cfg); options.refresh();
      } catch (error) {
        if (!closing && serial === intent && id === currentId) {
          currentId = null; active = false;
          note('试听未完成：' + String(error && error.message || error) + '。当前草稿已保留。');
          options.transport.post('/v1/player/audio-quality/preview/cancel', { request_id: id }).catch(function () {});
        }
      } finally {
        preparing = false; buttons();
      }
    }
    async function select(event) {
      if (saving || !event.target.checked || !currentId || !active || switching || cancelling) return;
      var id = currentId, serial = intent;
      switching = true; buttons(); note('正在重播同一参考片段并切换试听侧…');
      try {
        var cfg = await options.transport.post('/v1/player/audio-quality/preview/select', { request_id: id, side: event.target.value });
        if (!closing && serial === intent && id === currentId) { options.onState(cfg); onRead(cfg); }
      } catch (error) {
        if (!closing && serial === intent) { note('切换未完成：' + String(error && error.message || error) + '。正在读取实际状态。'); options.refresh(); }
      } finally { switching = false; buttons(); }
    }
    function edited(event) {
      clearErrors();
      if (currentId) cancel('试听参数已改变，正在结束旧试听；请重新试听当前草稿。');
    }
    function visibilityChanged() { if (!visible() && currentId) cancel('设置已隐藏，正在结束试听。'); }
    function endClicked() { cancel('正在结束试听并恢复保存配置…'); }
    var observer = new MutationObserver(visibilityChanged);
    for (var ancestor = options.form; ancestor; ancestor = ancestor.parentElement) {
      observer.observe(ancestor, { attributes: true, attributeFilter: ['hidden', 'style', 'class', 'aria-hidden'] });
    }
    function destroy() {
      if (closing) return;
      cancel(); closing = true; stopHeartbeat(); observer.disconnect();
      start.removeEventListener('click', begin); end.removeEventListener('click', endClicked);
      radios.forEach(function (radio) { radio.removeEventListener('change', select); });
      [path, acknowledge, match].forEach(function (input) { input.removeEventListener('input', edited); });
      document.removeEventListener('visibilitychange', visibilityChanged);
      window.removeEventListener('hertz-native-presentation', visibilityChanged);
      window.removeEventListener('pagehide', destroy);
    }
    start.addEventListener('click', begin); end.addEventListener('click', endClicked);
    radios.forEach(function (radio) { radio.addEventListener('change', select); });
    [path, acknowledge, match].forEach(function (input) { input.addEventListener('input', edited); });
    document.addEventListener('visibilitychange', visibilityChanged);
    window.addEventListener('hertz-native-presentation', visibilityChanged);
    window.addEventListener('pagehide', destroy);
    buttons();
    return { onRead: onRead, invalidate: edited, cancel: cancel, clearErrors: clearErrors, destroy: destroy,
      setSaving: function (value) { saving = value; buttons(); } };
  }
  window.HertzAudioPreviewSettings = { init: init };
})();
