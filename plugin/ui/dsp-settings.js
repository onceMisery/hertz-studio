// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
(function () {
  'use strict';

  function init(options) {
    var form = document.getElementById('dsp-settings');
    if (!form) return null;
    var bands = Array.from(form.querySelectorAll('input[data-band]'));
    var frequencies = Array.from(form.querySelectorAll('input[data-frequency]'));
    var qs = Array.from(form.querySelectorAll('input[data-q]'));
    var enabled = document.getElementById('dsp-eq-enabled');
    var headroom = document.getElementById('dsp-headroom');
    var limiter = document.getElementById('dsp-limiter');
    var loudnessSource=document.getElementById('dsp-loudness-source'),targetLufs=document.getElementById('dsp-target-lufs');
    var crossfeed=document.getElementById('dsp-crossfeed'),crossfeedAmount=document.getElementById('dsp-crossfeed-amount');
    var compensation=document.getElementById('dsp-compensation'),saturation=document.getElementById('dsp-saturation');
    var drive=document.getElementById('dsp-drive'),mix=document.getElementById('dsp-mix'),impulse=document.getElementById('dsp-impulse');

    var revision = null, latest = null;
    var preamp = document.getElementById('dsp-preamp');
    var loudness = document.getElementById('dsp-loudness');
    var crossfade = document.getElementById('dsp-crossfade');
    var save = document.getElementById('dsp-save');
    var reset = document.getElementById('dsp-reset');
    var rebase = document.getElementById('dsp-rebase');
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
      var effective = cfg.effective, active = effective && effective.eq && effective.eq.active;
      if (cfg.application_state === 'failed') return '设置已保存，应用失败：' + String(cfg.issues && cfg.issues[0] && cfg.issues[0].message || '请检查输出设备');
      if (cfg.application_state === 'applied' && cfg.applied_revision === cfg.revision) return active ? '设置已保存，音效已应用到播放输出。' : '设置已保存，音效已采用；当前播放已暂停。';
      if (cfg.application_state === 'applying') return '设置已保存，音效正在平滑切换…';
      if(effective && effective.deferred_reason==='processing_latency_change_waits_for_seek_or_load') return '设置已保存；为保持媒体时间连续，保护策略将在下一次载入或定位后应用。';
      return '设置已保存，等待本机音频输出采用。';
    }
    function draft() {
      return { eq: { enabled: enabled.checked, bands: bands.map(function (input, i) { return {frequency_hz:Number(frequencies[i].value),q:Number(qs[i].value),gain_db:Number(input.value)}; }) },
        loudness_source:loudnessSource.value,target_lufs:Number(targetLufs.value),impulse_id:impulse.value.trim(),tone:{crossfeed:crossfeed.checked,crossfeed_amount:Number(crossfeedAmount.value),loudness_compensation:compensation.checked,saturation:saturation.checked,drive:Number(drive.value),mix:Number(mix.value)},preamp_db:Number(preamp.value),limiter:limiter.value,headroom_mode:headroom.value,loudness_mode:loudness.value,crossfade_ms:Number(crossfade.value) };
    }
    function sameDraft(cfg) {
      var d=draft(), q=cfg.requested;
      return JSON.stringify(d.eq)===JSON.stringify(q.eq) && d.preamp_db===q.preamp_db && d.limiter===(q.limiter||'soft') && d.headroom_mode===q.headroom_mode && d.loudness_mode===q.loudness_mode && d.crossfade_ms===q.crossfade_ms && d.loudness_source===(q.loudness_source||'file_tags') && d.target_lufs===(q.target_lufs===undefined?-18:q.target_lufs) && d.impulse_id===(q.impulse_id||'') && JSON.stringify(d.tone)===JSON.stringify(q.tone||{crossfeed:false,crossfeed_amount:0.25,loudness_compensation:false,saturation:false,drive:0.15,mix:0.1});
    }
    function fill(cfg) {
      var q=cfg.requested;
      enabled.checked=q.eq.enabled; headroom.value=q.headroom_mode; limiter.value=q.limiter||'soft';
      bands.forEach(function (input,i) { input.value=q.eq.bands[i].gain_db; frequencies[i].value=q.eq.bands[i].frequency_hz; qs[i].value=q.eq.bands[i].q; });
      loudnessSource.value=q.loudness_source||'file_tags';targetLufs.value=q.target_lufs===undefined?-18:q.target_lufs;impulse.value=q.impulse_id||'';
      var tone=q.tone||{};crossfeed.checked=!!tone.crossfeed;crossfeedAmount.value=tone.crossfeed_amount===undefined?0.25:tone.crossfeed_amount;
      compensation.checked=!!tone.loudness_compensation;saturation.checked=!!tone.saturation;drive.value=tone.drive===undefined?0.15:tone.drive;mix.value=tone.mix===undefined?0.1:tone.mix;
      preamp.value=q.preamp_db; loudness.value=q.loudness_mode; crossfade.value=q.crossfade_ms;
    }
    function showEffective(cfg) {
      latest=cfg;
      var capabilities=cfg.capabilities||{};
      var saturationNote=document.getElementById('dsp-saturation-status');
      var impulseNote=document.getElementById('dsp-impulse-status');
      if(saturationNote) saturationNote.textContent=capabilities.saturation&&capabilities.saturation.available===false
        ? capabilities.saturation.message||'当前输出暂不支持过采样饱和；可关闭它后保存其他音效。' : '4× 过采样，仅支持 44.1/48 kHz，干湿延迟对齐；改变启用状态在下一次定位或载入后采用。';
      if(impulseNote) impulseNote.textContent=capabilities.impulse&&capabilities.impulse.available===false
        ? capabilities.impulse.message||'当前输出暂不支持校正核；可清空资源 ID 后保存其他音效。' : '使用下方导入返回的资源 ID。正式播放仅支持 44.1/48 kHz 的短对称线性相位核；不会自动应用通用耳机曲线。';
      [[saturation,capabilities.saturation],[impulse,capabilities.impulse]].forEach(function(entry){
        if(!entry[1]||entry[1].available!==false){entry[0].setCustomValidity('');entry[0].removeAttribute('aria-invalid');}
      });
      var loudnessNote=document.getElementById('dsp-measured-status'),applied=cfg.loudness_application;
      if(loudnessNote) {if(cfg.requested.loudness_source==='r128' && cfg.requested.loudness_mode!=='off') {
        loudnessNote.textContent=applied?'当前采用本机测量增益 '+applied.gain_db.toFixed(2)+' dB'+(applied.selection&&applied.selection.limited_by?'；目标受 '+applied.selection.limited_by+' 限制':''):'当前未采用测量增益（0 dB）；尚未分析或内容未核验。';
      }else{loudnessNote.textContent='';}}

      var output=document.getElementById('dsp-output-status'), actual=cfg.output && cfg.output.actual;
      if (output) output.textContent=actual ? actual.device_id+' · '+actual.sample_rate+' Hz · '+actual.sample_format+' · '+(actual.mode==='exclusive'?'独占':'共享')+(cfg.output.active?' · 活动':' · 空闲') : '当前没有本机输出格式；一起听使用房间的共同音效。';
      var info=cfg.effective && cfg.effective.requested_headroom, target=document.getElementById('dsp-headroom-status');
      if (target) target.textContent=info ? '准备的 EQ 峰值 '+info.eq_peak_db.toFixed(2)+' dB，混音 '+info.mix_peak_db.toFixed(2)+' dB，保护 '+info.margin_db.toFixed(1)+' dB；余量扣减 '+info.attenuation_db.toFixed(2)+' dB。稳态估算不能保证任意波形不过载。' : '';
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
          var cfg = await options.transport.get('/v1/player/audio-quality');
          if (closed || requestIntent !== intent) return;
          if (dirty && sameDraft(cfg)) dirty = false;
          if (!dirty && requestEdits === edits) { fill(cfg); revision=cfg.revision; }
          else if (revision===null) revision=cfg.revision;
          showEffective(cfg);
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
    function clearCapabilityErrors() {
      [saturation,impulse].forEach(function(input){input.setCustomValidity('');input.removeAttribute('aria-invalid');});
    }
    function changed() { clearCapabilityErrors();dirty = true; edits++; note(lastMessage); }
    function validateCapabilities() {
      clearCapabilityErrors();
      var capabilities=latest&&latest.capabilities||{};
      [[saturation,capabilities.saturation,saturation.checked],[impulse,capabilities.impulse,!!impulse.value.trim()]].forEach(function(entry){
        if(entry[1]&&entry[1].available===false&&entry[2]) {
          entry[0].setCustomValidity(entry[1].message||'当前输出暂不支持此处理；请关闭它或选择受支持的输出格式。');
          entry[0].setAttribute('aria-invalid','true');
        }
      });
    }
    async function submit(event) {
      event.preventDefault();
      if (closed || busy) return;
      validateCapabilities();
      if (!form.reportValidity()) return;
      var requestEdits = edits;
      var requestIntent = ++intent;
      if (revision===null) { note('尚未读取保存版本，请等待设置读取完成。'); return; }
      var body = {expected_revision:revision,patch:draft()};
      cancelTimer();
      busy = true;
      save.disabled = true;
      reset.disabled = true;
      form.setAttribute('aria-busy', 'true');
      note('正在保存音效设置…');
      try {
        var cfg = await options.transport.post('/v1/player/audio-quality', body);
        if (closed || requestIntent !== intent) return;
        revision=cfg.revision; showEffective(cfg);
        if (requestEdits === edits) { dirty = false; fill(cfg); }
        var message = describe(cfg);
        note(message);
        options.toast(message, cfg.application_state === 'failed' ? 'error' : undefined);
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
      bands.forEach(function (input,i) { input.value=0; frequencies[i].value=[60,150,400,1000,2400,6000][i]; qs[i].value=1.2; });
      enabled.checked=false; headroom.value='off';
      preamp.value = 0;
      changed();
    }
    async function rebaseDraft() {
      if (busy || closed) return;
      var request=++intent;
      try { var cfg=await options.transport.get('/v1/player/audio-quality');
        if(closed || request!==intent)return;
        revision=cfg.revision;showEffective(cfg);note('已读取最新保存版本，当前草稿保留；再次保存会应用这份草稿。');
      } catch(error) {note('无法读取最新版本，请稍后重试；草稿保留。');}
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
      rebase.removeEventListener('click', rebaseDraft);
      document.removeEventListener('visibilitychange', visibilityChanged);
      window.removeEventListener('hertz-native-presentation', visibilityChanged);
      window.removeEventListener('hertz-native-host-ready', visibilityChanged);
      window.removeEventListener('pagehide', destroy);
    }
    form.addEventListener('submit', submit);
    form.addEventListener('input', changed);
    form.addEventListener('change', changed);
    reset.addEventListener('click', resetDraft);
    rebase.addEventListener('click', rebaseDraft);
    document.addEventListener('visibilitychange', visibilityChanged);
    window.addEventListener('hertz-native-presentation', visibilityChanged);
    window.addEventListener('hertz-native-host-ready', visibilityChanged);
    window.addEventListener('pagehide', destroy);
    return { load: function () { return refresh(true); }, destroy: destroy };
  }
  window.HertzDspSettings = { init: init };
})();
