// SPDX-License-Identifier: MIT
// Shared lifecycle for the original standalone Coast/Zodiac owners. Definitions,
// local quality and input behavior remain in their adapters and pure engines.
(function (global) {
  'use strict';
  global.StageSceneHost = function (config) {
    var host = null, canvas = null, notice = null, mounted = false, pending = false;
    var port = null, canvasTicket = null, inputTicket = null, zeros = null, onset = null;
    var unsubscribe = null, observer = null, cleanups = [], generation = 0;
    var width = 0, height = 0, dpr = 0, dirty = false, advancing = false, inputActive = false;
    var sceneTimeMs = 0, lastFrame = -1, watermark = 0, phaseState = null;
    var lifecycle = 'absent', reason = '', actualQuality = '', firstSubmit = false;
    var gate = 'stage-' + config.id, rig = null, rigOptions = null;
    function engine() { return config.engine(); }
    function stage() { return global.Stage; }
    function release(ticket) { if (ticket) ticket.release({ apiReleased: true, allocationEnded: true }); }
    function hidden() { return !stage() || stage().isDocumentHidden(); }
    function allowed() { return !!host && !hidden() && width > 0 && height > 0; }
    function report() {
      if (!port) return;
      var frame = stage().frameState();
      port.report({ requestId: String(generation), logicalInstanceId: config.id + '-' + generation,
        lifecycle: lifecycle, presentation: hidden() ? 'hidden' : !width || !height ? 'zero-size'
          : frame.reduced ? 'reduced' : !frame.playing ? 'paused' : 'visible',
        visibleUses: allowed() ? 1 : 0, requestedQuality: config.requestedQuality(),
        actualQuality: actualQuality, actualBackend: mounted ? 'three-webgl2' : 'none',
        firstSubmit: firstSubmit, reason: reason, sceneTimeMs: sceneTimeMs,
        coverage: 'source-planned-context-surface-array-texture-pmrem-post' });
    }
    function emit(state) {
      document.dispatchEvent(new CustomEvent('stage:scene-context', { detail: { source: config.id, state: state } }));
    }
    function neutral() {
      advancing = inputActive = false;
      if (stage()) watermark = stage().frameState().spectrumRevision;
      if (onset && onset.reset) onset.reset();
      if (mounted && engine().resetInput) engine().resetInput();
    }
    function invalidate() { dirty = true; if (stage()) stage().kick(); }
    function listen(target, type, fn, opts) {
      target.addEventListener(type, fn, opts); cleanups.push(function () { target.removeEventListener(type, fn, opts); });
    }
    function clearNotice() { if (notice) notice.remove(); notice = null; }
    function showNotice() {
      clearNotice(); if (!host || !reason) return;
      notice = document.createElement('aside'); notice.className = 'stage-scene-resource-status';
      notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
      var text = document.createElement('span'); text.textContent = config.label + '暂不可用：' + reason + '。';
      var button = document.createElement('button'); button.type = 'button'; button.textContent = '重试';
      button.addEventListener('click', retry); notice.append(text, button); host.appendChild(notice);
    }
    function retire() {
      neutral(); mounted = false;
      if (config.beforeUnmount) config.beforeUnmount(canvas);
      if (engine()) engine().unmount();
      if (canvas) { canvas.remove(); canvas = null; }
      release(canvasTicket); release(inputTicket); canvasTicket = inputTicket = null;
      zeros = onset = null; actualQuality = ''; firstSubmit = false;
    }
    function fail(error) {
      pending = false; reason = error && error.message || String(error);
      retire(); lifecycle = 'error'; showNotice(); report(); emit('failed');
    }
    function mount() {
      if (!allowed() || mounted || !pending) return false;
      pending = false; generation++; lifecycle = 'preparing'; reason = ''; clearNotice();
      try {
        var ledger = stage().resources();
        if (!ledger || ledger.contractVersion !== 1) throw new Error('resource-policy-required');
        port = ledger.port(gate);
        var useOnset = global.Onset && Onset.create;
        inputTicket = port.require({ ownedCpuBytes: 64 * 4 + (useOnset ? (4 * 64 + 5 * Onset.GROUPS.length + 30) * 8 : 0) },
          config.label + ' original 64 audio bins and Onset history30 arrays', generation);
        zeros = new Float32Array(64); onset = useOnset ? Onset.create({ binCount: 64, history: 30 }) : null;
        inputTicket.commit();
        canvasTicket = port.require({ canvases: 1 }, config.label + ' standalone canvas identity', generation);
        canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        canvas.className = config.id + '-canvas'; canvas.setAttribute('aria-hidden', 'true');
        host.appendChild(canvas); canvasTicket.commit();
        actualQuality = config.quality();
        var options = Object.assign({}, config.options(), { external: true, admissionRequired: true,
          resources: port, generation: generation, quality: actualQuality, width: width, height: height,
          onContextLost: function () { fail(new Error('图形上下文已丢失，请重试')); } });
        if (!engine().mount(canvas, options)) throw new Error('WebGL2 initialization failed');
        mounted = true; engine().resize(width, height); config.apply();
        if (rig) engine().setRig(rig, rigOptions);
        if (config.afterMount) config.afterMount(canvas, host);
        neutral(); firstSubmit = false; invalidate(); report(); return true;
      } catch (error) { fail(error); return false; }
    }
    function measure() {
      var oldWidth = width, oldHeight = height;
      var oldDpr = dpr; dpr = global.devicePixelRatio || 1;
      width = host ? host.clientWidth : 0; height = host ? host.clientHeight : 0;
      if (!oldWidth || !oldHeight || !width || !height) neutral();
      if (mounted && allowed() && (oldWidth !== width || oldHeight !== height || oldDpr !== dpr)) {
        try { engine().resize(width, height); } catch (error) { fail(error); }
      }
      if (pending) mount(); invalidate(); report();
    }
    function onState(frame) {
      var signature = [frame.playing, frame.reduced, frame.documentHidden, frame.mediaEpoch, frame.positionDiscontinuityRevision].join(':');
      if (signature !== phaseState) { phaseState = signature; neutral(); invalidate(); }
      if (pending && allowed()) mount(); report();
    }
    function fps() {
      if (!mounted || !allowed()) { advancing = false; return 0; }
      var f = stage().frameState();
      if (!f.playing || f.reduced) { advancing = false; return dirty ? 30 : 0; }
      return actualQuality === 'low' ? 30 : 60;
    }
    function tick(dt, frame) {
      if (!frame || frame.version !== 1 || frame.frameId === lastFrame) return;
      lastFrame = frame.frameId;
      if (!mounted || !allowed() || frame.documentHidden) { neutral(); return; }
      var moving = frame.playing && !frame.reduced;
      var delta = moving && advancing ? Math.max(0, Math.min(Number(dt) || 0, 100)) : 0;
      advancing = moving; sceneTimeMs += delta;
      var fresh = moving && frame.spectrumAvailable && frame.spectrumRevision > watermark;
      if (!fresh && inputActive) { if (onset) onset.reset(); engine().resetInput?.(); }
      inputActive = fresh;
      var spectrum = fresh ? frame.spectrum : zeros;
      if (onset && fresh) onset.step(delta, spectrum, frame.sampledAtMs);
      var energy = 0;
      if (fresh) { for (var i = 0; i < spectrum.length; i++) energy += spectrum[i] || 0; energy /= spectrum.length || 1; }
      try {
        engine().setAudio({ level: fresh && onset ? onset.energy : energy, bands: spectrum, onset: fresh && onset ? onset.pulse > .45 : false });
        if (engine().setTime) engine().setTime({ time: sceneTimeMs / 1000, playing: moving });
        if (engine().setReduced) engine().setReduced(frame.reduced);
        if (engine().setMotion) engine().setMotion({ active: moving });
        var ok = engine().render(frame.sampledAtMs, delta / 1000, dirty ? .016 : delta / 1000, sceneTimeMs / 1000);
        if (ok) { lifecycle = 'ready'; firstSubmit = true; dirty = false; }
        report();
      } catch (error) { fail(error); }
      finally { if (mounted) engine().setAudio({ level: 0, bands: zeros, onset: false }); }
    }
    function unbind() {
      if (stage()) stage().removeGate(gate);
      if (unsubscribe) unsubscribe(); unsubscribe = null;
      if (observer) observer.disconnect(); observer = null;
      cleanups.splice(0).forEach(function (cleanup) { cleanup(); });
    }
    function retry() {
      if (!host) return false;
      retire(); pending = true; reason = ''; lifecycle = 'preparing'; clearNotice();
      var ok = mount(); if (ok) emit('recovered'); return ok;
    }
    function setHost(el) {
      if (el === host) return !el || mounted || pending;
      retire(); unbind(); clearNotice();
      if (port) port.forgetReport(); port = null; host = el;
      sceneTimeMs = 0; lastFrame = -1; phaseState = null; reason = ''; lifecycle = el ? 'preparing' : 'disposed';
      pending = !!el; if (!el) { rig = rigOptions = null; return true; }
      if (!stage() || !stage().gate || !config.engine()) { fail(new Error('舞台模块未加载')); return false; }
      stage().gate(gate, fps, tick); unsubscribe = stage().onFrameState(onState);
      listen(global, 'resize', measure); listen(document, 'visibilitychange', measure);
      listen(global, 'hertz-native-presentation', measure); listen(global, 'hertz-native-host-ready', measure);
      ['pointerdown', 'pointermove', 'pointerup', 'pointerleave', 'wheel', 'dblclick'].forEach(function (type) { listen(host, type, invalidate, { passive: true }); });
      if (global.ResizeObserver) { observer = new ResizeObserver(measure); observer.observe(host); }
      measure(); return mounted || pending;
    }
    return { setHost: setHost, retry: retry, invalidate: invalidate,
      available: function () { return !!(engine() && engine().probe()); },
      degradedBecause: function () { return reason || null; },
      apply: function () { if (mounted) config.apply(); invalidate(); },
      setRig: function (value, opts) { rig = value ? Object.assign({}, value) : null;
        if (rig && Array.isArray(value.position)) rig.position = value.position.slice(); rigOptions = opts ? Object.assign({}, opts) : null;
        if (mounted) engine().setRig(rig, rigOptions); invalidate(); },
      stats: function () { return { lifecycle: lifecycle, mounted: mounted, pending: pending, generation: generation,
        sceneTimeMs: sceneTimeMs, actualQuality: actualQuality, requestedQuality: config.requestedQuality(),
        firstSubmit: firstSubmit, reason: reason, width: width, height: height, inputActive: inputActive,
        renderer: mounted ? engine().stats() : null }; } };
  };
}(window));
