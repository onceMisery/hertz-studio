// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors.
// Optional presentation layer. StageControl owns preferences; Stage owns time.
(function (global) {
  'use strict';

  // The Stage facade includes native parent-window suspension. Standalone consumers keep browser visibility.
  function documentHidden() {
    var stage = window.Stage;
    return stage && typeof stage.isDocumentHidden === "function" ? stage.isDocumentHidden() : !!document.hidden;
  }
  var stage = null, canvas = null, engine = null, options = null;
  var initialized = false, generation = 0, preparing = false, failure = null;
  var observer = null, resizeObserver = null, pointerAttached = false, hostHasLayout = false;
  var state = 'off', reason = '', actualTier = 0, ceiling = 2, dirty = false, resetDt = true;
  var created = 0, disposed = 0, completedFrames = 0, completedSteps = 0;
  var sceneTime = 0, lastMusic = -1, lastInput = 0, lastBeat = 0, mediaEpoch = null;
  var beatInstance = null, beatSampledAt = null;
  var spectrumWatermark = 0, lastFrameId = -1, frameUnsubscribe = null;
  var pointerX = -1, pointerY = -1, pendingPointer = false;
  var pointerSplat = null, queue = null, queueAt = 0, queueCount = 0;
  var rgb = null, bounds = { left: 0, top: 0, width: 0, height: 0 };
  var resourcePort = null, arraysTicket = null, canvasTicket = null, firstSubmit = false;
  var orbit = { x: .5, y: .5, rx: .43, ry: .43 };
  var interactive = 'button,a,input,select,textarea,[role="button"],[role="slider"],[contenteditable],.stage-lyrics';

  function supportsHost() {
    return !!stage && !document.body.classList.contains('s3d-open')
      && !document.body.classList.contains('space3d-open')
      && !document.documentElement.classList.contains('creative-3d')
      && !stage.classList.contains('creative-on')
      && !(global.Stage3D && Stage3D.isActive && Stage3D.isActive())
      && !(global.Space3D && Space3D.isActive && Space3D.isActive());
  }
  function report(next, message) {
    if (state === next && reason === message) return;
    state = next; reason = message || '';
    reportResources();
    document.dispatchEvent(new CustomEvent('stagefluid:state'));
  }
  function reportResources() {
    if (!resourcePort) return;
    var frame = Stage.frameState(), reasons = [];
    if (failure) reasons.push(failure.resourceReason || 'prepare-failed');
    if (ceiling < Stage.tier()) reasons.push('frame-pressure');
    var shown = !frame.documentHidden && frame.stageVisible && supportsHost() && hostHasLayout;
    resourcePort.report({ logicalInstanceId: 'fluid:' + generation, requestId: 'fluid-request:' + generation,
      rendererId: 'fluid-renderer:' + generation, generation: generation,
      lifecycle: engine ? firstSubmit ? 'ready' : 'preparing' : preparing ? 'preparing' : failure ? 'error' : 'absent',
      presentation: frame.documentHidden ? 'hidden' : !hostHasLayout ? 'zero-size' : !shown ? 'occluded'
        : frame.reduced ? 'reduced' : !frame.playing ? 'paused' : 'visible',
      visibleUses: shown && options && options.fluidEnabled ? 1 : 0,
      requestedQuality: 'tier-' + Stage.tier(), actualQuality: engine && firstSubmit ? 'tier-' + actualTier : 'unavailable',
      actualBackend: engine && firstSubmit ? 'webgl2' : 'none', reasons: reasons });
  }
  function kick() { if (global.Stage && Stage.kick) Stage.kick(); }
  function clearInput() {
    queueAt = queueCount = 0; pendingPointer = false; pointerX = pointerY = -1;
    lastBeat = 0; beatInstance = null; beatSampledAt = null;
    resetDt = true;
  }
  function sharedBeat(features, now) {
    var age = features && typeof features.sampledAt === 'number' ? now - features.sampledAt : NaN;
    if (!features || features.available !== true || features.instanceId == null
      || typeof features.beats !== 'number' || !isFinite(features.beats) || features.beats < 0
      || !isFinite(age) || age < 0 || age >= 600) {
      lastBeat = 0; beatInstance = null; beatSampledAt = null;
      return false;
    }
    // 首次、换实例和缺测后的读数只重建基线，不能补发期间累积的拍。
    var sameStream = beatInstance === features.instanceId && beatSampledAt !== null
      && now - beatSampledAt >= 0 && now - beatSampledAt < 600;
    var freshBeat = sameStream && features.beats > lastBeat;
    beatInstance = features.instanceId; beatSampledAt = features.sampledAt; lastBeat = features.beats;
    return freshBeat;
  }
  function detachPointer() {
    if (!pointerAttached || !stage) return;
    stage.removeEventListener('pointermove', onPointer);
    stage.removeEventListener('pointerleave', onPointerLeave);
    pointerAttached = false;
  }
  function release() {
    generation++; preparing = false; clearInput(); detachPointer();
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    if (canvas) canvas.removeEventListener('webglcontextlost', contextLost);
    if (engine) {
      var totals = engine.stats(); completedFrames += totals.frames; completedSteps += totals.steps;
      engine.dispose(); engine = null; disposed++;
    }
    if (canvas) { canvas.width = canvas.height = 0; canvas.remove(); canvas = null; }
    if (canvasTicket) canvasTicket.release({ apiReleased: true, allocationEnded: true });
    canvasTicket = null; firstSubmit = false;
    actualTier = 0; dirty = false;
  }
  function stopWatching() {
    if (observer) { observer.disconnect(); observer = null; }
    global.removeEventListener('resize', onResize);
    global.removeEventListener('scroll', measure);
  }
  function watch() {
    if (observer || typeof MutationObserver !== 'function') return;
    observer = new MutationObserver(function () { measure(); sync(); });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-stage-preset', 'data-skin'] });
    observer.observe(stage, { attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
    global.addEventListener('resize', onResize);
    global.addEventListener('scroll', measure, { passive: true });
    measure();
  }
  function queueMusic(x, y, dx, dy, amount) {
    if (queueCount === 15) { queueAt = (queueAt + 1) % 15; queueCount--; }
    var at = ((queueAt + queueCount) % 15) * 5;
    queue[at] = x; queue[at + 1] = y; queue[at + 2] = dx; queue[at + 3] = dy; queue[at + 4] = amount;
    queueCount++;
  }
  function onPointerLeave() { pointerX = pointerY = -1; pendingPointer = false; }
  function onPointer(event) {
    if (!engine || !options.fluidPointer || state !== 'active' || event.pointerType === 'touch'
      || event.buttons || event.target.closest(interactive) || !bounds.width || !bounds.height) {
      onPointerLeave(); return;
    }
    var x = (event.clientX - bounds.left) / bounds.width;
    var y = 1 - (event.clientY - bounds.top) / bounds.height;
    if (x <= 0 || x >= 1 || y <= 0 || y >= 1) { onPointerLeave(); return; }
    if (pointerX >= 0) {
      pointerSplat[0] = x; pointerSplat[1] = y;
      pointerSplat[2] = Math.max(-180, Math.min(180, (x - pointerX) * 1800));
      pointerSplat[3] = Math.max(-180, Math.min(180, (y - pointerY) * 1800));
      pointerSplat[4] = .7; pendingPointer = true; dirty = true; kick();
    }
    pointerX = x; pointerY = y;
  }
  function bindPointer() {
    if (engine && options.fluidPointer && !pointerAttached) {
      stage.addEventListener('pointermove', onPointer, { passive: true });
      stage.addEventListener('pointerleave', onPointerLeave, { passive: true }); pointerAttached = true;
    } else if (!options.fluidPointer) { detachPointer(); onPointerLeave(); }
  }
  function color() {
    if (!engine) return;
    var style = getComputedStyle(document.documentElement);
    var triplet = style.getPropertyValue('--music-highlight-rgb').trim();
    if (!triplet) triplet = style.getPropertyValue('--accent-rgb').trim();
    var values = triplet.match(/[\d.]+/g);
    if (values && values.length >= 3) {
      for (var i = 0; i < 3; i++) rgb[i] = Math.min(255, Number(values[i])) / 255;
    } else {
      // Resolve the existing theme color once on retint, never in the frame path.
      var probe = document.createElement('span'); probe.style.color = 'var(--accent)';
      probe.hidden = true; stage.appendChild(probe);
      values = getComputedStyle(probe).color.match(/[\d.]+/g); probe.remove();
      for (var j = 0; j < 3; j++) rgb[j] = values && values.length >= 3 ? Math.min(255, Number(values[j])) / 255 : 0;
    }
    engine.configure(rgb, options.fluidStrength / 100); dirty = true; kick();
  }
  function measure() {
    if (!stage || documentHidden() || !Stage.isStageVisible()) return;
    var art = stage.querySelector('.disc-wrap'), host = stage.getBoundingClientRect();
    hostHasLayout = host.width > 0 && host.height > 0;
    if (!engine || !canvas || !hostHasLayout) return;
    if (!art) return;
    var rect = art.getBoundingClientRect(), margin = Math.min(80, rect.width * .32);
    var left = Math.max(8, rect.left - host.left - margin), right = Math.min(host.width - 8, rect.right - host.left + margin);
    var top = Math.max(8, rect.top - host.top - margin), bottom = Math.min(host.height - 8, rect.bottom - host.top + margin);
    var head = stage.querySelector('.stage-head'), entry = stage.querySelector('.emotion-entry');
    [head, entry].forEach(function (node) {
      if (node && node.getClientRects().length) top = Math.max(top, node.getBoundingClientRect().bottom - host.top + 4);
    });
    ['.stage-title', '.stage-artist', '.stage-progress', '.stage-lyrics', '.spectrum'].forEach(function (selector) {
      var node = stage.querySelector(selector);
      if (node && node.getClientRects().length) {
        var protect = node.getBoundingClientRect();
        if (protect.top >= rect.top) bottom = Math.min(bottom, protect.top - host.top - 4);
      }
    });
    bounds.left = host.left + left; bounds.top = host.top + top;
    bounds.width = Math.max(1, right - left); bounds.height = Math.max(1, bottom - top);
    orbit.x = Math.max(.12, Math.min(.88, (rect.left + rect.width * .5 - bounds.left) / bounds.width));
    orbit.y = Math.max(.12, Math.min(.88, 1 - (rect.top + rect.height * .5 - bounds.top) / bounds.height));
    orbit.rx = Math.min(.44, (rect.width * .5 + margin * .35) / bounds.width);
    orbit.ry = Math.min(.44, (rect.height * .5 + margin * .35) / bounds.height);
    canvas.style.left = left + 'px'; canvas.style.top = top + 'px';
    canvas.style.width = bounds.width + 'px'; canvas.style.height = bounds.height + 'px';
    try { engine.resize(bounds.width, bounds.height); }
    catch (error) { fail(error); return; }
    dirty = true; resetDt = true; kick();
  }
  function contextLost(event) {
    event.preventDefault(); var error = new Error('图形资源已中断，点击重试恢复流体增强');
    error.code = 'CONTEXT_LOST'; fail(error);
  }
  function fail(error) {
    failure = { message: error.message, unsupported: /^UNSUPPORTED_/.test(error.code || ''),
      resourceReason: error.resourceFailure && error.resourceFailure.reason,
      contextLost: error.code === 'CONTEXT_LOST' };
    if (failure.contextLost) failure.resourceReason = 'context-lost';
    release(); report(failure.unsupported ? 'unavailable' : 'error', failure.unsupported
      ? '当前设备暂不支持此效果' : '流体暂不可用，请重试');
  }
  function prepare(tier) {
    if (preparing || engine) return;
    var ticket = ++generation; preparing = true; report('preparing', '正在准备流体');
    Promise.resolve().then(function () {
      measure();
      if (ticket !== generation || !options.fluidEnabled || !supportsHost() || documentHidden()
        || !Stage.isStageVisible() || !hostHasLayout) return;
      try {
        canvasTicket = resourcePort.require({ canvases: 1 }, 'fluid host canvas, empty before context admission', generation);
        canvas = document.createElement('canvas'); canvas.className = 'stage-fluid-canvas';
        canvas.width = canvas.height = 0; canvasTicket.commit();
        canvas.setAttribute('aria-hidden', 'true');
        engine = global.HertzFluidEngine.create(canvas, tier, { resources: resourcePort }); created++; actualTier = tier;
        canvas.addEventListener('webglcontextlost', contextLost);
        stage.insertBefore(canvas, stage.firstChild);
        measure(); if (!engine) return; color(); dirty = true; preparing = false;
        if (typeof ResizeObserver === 'function') {
          resizeObserver = new ResizeObserver(onResize);
          resizeObserver.observe(stage);
          var cover = stage.querySelector('.disc-wrap'); if (cover) resizeObserver.observe(cover);
        }
        bindPointer(); sync(); reportResources(); kick();
      } catch (error) { fail(error); }
    });
  }
  function sync() {
    if (!initialized || !options) return;
    if (!options.fluidEnabled) {
      release(); stopWatching(); failure = null; ceiling = 2; report('off', ''); return;
    }
    watch();
    if (failure) { report(failure.unsupported ? 'unavailable' : 'error', failure.unsupported
      ? '当前设备暂不支持此效果' : '流体暂不可用，请重试'); return; }
    if (!supportsHost()) { release(); report('suspended', '当前舞台暂不支持流体增强'); return; }
    // DBX's measured tail-frame cost exceeded the design budget. Keep the
    // request portable through its existing storage shim, but admit no GPU
    // effect until that host has passed performance and native acceptance.
    if (global.hertzHost && hertzHost.isDbx) {
      release(); report('unavailable', '当前宿主暂不支持此效果，请使用独立浏览器'); return;
    }
    var presentation = Stage.presentation();
    if (presentation.reduced || document.body.classList.contains('reduce-motion')) {
      release(); report('suspended', '减少动态效果已开启，流体已暂停'); return;
    }
    if (options.stagePreset === 'still') { release(); report('suspended', '静帧主题下流体已暂停'); return; }
    ceiling = Math.min(ceiling, Stage.tier());
    if (!HertzFluidEngine.profiles[ceiling]) { release(); report('suspended', '为保持流畅，流体已暂停'); return; }
    if (!options.fluidStrength || (!options.fluidAudio && !options.fluidPointer)) {
      release(); report('suspended', '调整强度或开启输入后生效'); return;
    }
    if (documentHidden() || !Stage.isStageVisible() || !hostHasLayout) {
      if (preparing) release(); else clearInput();
      report('suspended', '舞台隐藏时流体已暂停'); return;
    }
    if (engine && actualTier > ceiling) release();
    if (!engine) { prepare(ceiling); return; }
    bindPointer();
    if (!presentation.playing) { clearInput(); report('suspended', '播放后流体继续流动'); }
    else { report('active', '流体已启用'); }
  }
  function targetFps() {
    if (!initialized || !options || !options.fluidEnabled) return 0;
    sync();
    if (!engine || documentHidden() || !Stage.isStageVisible() || !hostHasLayout) return 0;
    if (dirty) return HertzFluidEngine.profiles[actualTier].fps;
    if (state !== 'active') return 0;
    var frame = Stage.frameState();
    var musicActive = options.fluidAudio && frame.spectrumAvailable && frame.spectrumRevision > spectrumWatermark
      && Stage.energy() >= .005;
    if (!pendingPointer && !queueCount && !musicActive
      && sceneTime - lastInput > 8000) { resetDt = true; return 0; }
    return HertzFluidEngine.profiles[actualTier].fps;
  }
  function tick(dtMs, frame) {
    if (!engine || !frame || frame.version !== 1 || lastFrameId === frame.frameId) return;
    lastFrameId = frame.frameId;
    if (frame.documentHidden || !frame.stageVisible || !hostHasLayout || !supportsHost()) {
      clearInput(); spectrumWatermark = frame.spectrumRevision; return;
    }
    try {
      if (mediaEpoch !== frame.mediaEpoch) {
        mediaEpoch = frame.mediaEpoch; engine.reset(); clearInput(); lastMusic = -1;
      }
      if (state !== 'active' || !frame.playing || frame.reduced) {
        clearInput(); spectrumWatermark = frame.spectrumRevision;
        if (dirty) { engine.render(); dirty = false; firstSubmit = true; reportResources(); } return;
      }
      var deltaMs = resetDt || !isFinite(dtMs) ? 0 : Math.min(100, Math.max(0, dtMs));
      resetDt = false; sceneTime += deltaMs;
      var now = frame.sampledAtMs;
      var fresh = frame.spectrumAvailable && frame.spectrumRevision > spectrumWatermark;
      var energy = fresh ? Math.max(0, Math.min(1, Stage.energy())) : 0;
      var features = global.StageParticles && StageParticles.audioFeatures ? StageParticles.audioFeatures() : null;
      var newBeat = sharedBeat(features, now);
      if (options.fluidAudio && energy > .005 && (sceneTime - lastMusic > 130 || newBeat)) {
        var phase = sceneTime / 1000 * .65, amount = Math.min(1.5, energy * 1.8 + (newBeat ? .3 : 0));
        queueMusic(orbit.x + Math.cos(phase) * orbit.rx, orbit.y + Math.sin(phase) * orbit.ry,
          -Math.sin(phase) * (40 + energy * 75), Math.cos(phase) * (40 + energy * 75), amount);
        queueMusic(orbit.x - Math.cos(phase) * orbit.rx, orbit.y - Math.sin(phase) * orbit.ry,
          Math.sin(phase) * (30 + energy * 55), -Math.cos(phase) * (30 + energy * 55), amount * .65);
        lastMusic = sceneTime;
      }
      var remaining = 4, inputStrength = .55 + options.fluidStrength * .009;
      if (pendingPointer) {
        engine.splat(pointerSplat[0], pointerSplat[1], pointerSplat[2] * inputStrength,
          pointerSplat[3] * inputStrength, pointerSplat[4] * inputStrength);
        pendingPointer = false; remaining--; lastInput = sceneTime;
      }
      while (queueCount && remaining--) {
        var at = queueAt * 5; engine.splat(queue[at], queue[at + 1], queue[at + 2] * inputStrength,
          queue[at + 3] * inputStrength, queue[at + 4] * inputStrength);
        queueAt = (queueAt + 1) % 15; queueCount--; lastInput = sceneTime;
      }
      engine.step(deltaMs / 1000); engine.render(); dirty = false;
      if (!firstSubmit) { firstSubmit = true; reportResources(); }
    } catch (error) { fail(error); }
  }
  function onValues(event) {
    var next = event.detail || StageControl.values(), wasEnabled = options && options.fluidEnabled;
    options = next;
    if (!wasEnabled && next.fluidEnabled) { failure = null; ceiling = Stage.tier(); }
    sync(); if (engine) { color(); measure(); } kick();
  }
  function onVisibility() { measure(); sync(); kick(); }
  function onResize() { measure(); sync(); kick(); }
  function onTrack() {
    clearInput(); spectrumWatermark = Stage.frameState().spectrumRevision; lastMusic = -1;
    if (engine) color();
  }
  function onPageHide() { release(); stopWatching(); }
  function retry() { failure = null; ceiling = Stage.tier(); sync(); kick(); }
  function init() {
    if (initialized || !global.Stage || !global.StageControl || !global.HertzFluidEngine) return;
    stage = document.getElementById('stage'); if (!stage) return;
    resourcePort = Stage.resources() && Stage.resources().port('stage-fluid');
    try {
      if (!resourcePort) throw new Error('resource-policy-required');
      arraysTicket = resourcePort.require({ ownedCpuBytes: 332 }, 'fluid input Float32 arrays 5+75+3', 0);
      pointerSplat = new Float32Array(5); queue = new Float32Array(75); rgb = new Float32Array(3);
      arraysTicket.commit();
    } catch (error) {
      pointerSplat = queue = rgb = null;
      if (arraysTicket) arraysTicket.release({ apiReleased: true, allocationEnded: true });
      arraysTicket = null; fail(error); return;
    }
    initialized = true; options = StageControl.values();
    spectrumWatermark = Stage.frameState().spectrumRevision;
    frameUnsubscribe = Stage.onFrameState(function (frame) {
      if (!frame.playing || frame.documentHidden || !frame.stageVisible || frame.reduced) {
        clearInput(); spectrumWatermark = frame.spectrumRevision;
      }
      measure(); sync(); reportResources(); kick();
    });
    Stage.gate('stage-fluid', targetFps, tick);
    document.addEventListener('stagecontrol:change', onValues);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('stage:retint', color);
    document.addEventListener('stage:track-changed', onTrack);
    global.addEventListener('pagehide', onPageHide);
    global.addEventListener('pageshow', onVisibility);
    sync();
  }
  function destroy() {
    release(); stopWatching(); initialized = false;
    if (frameUnsubscribe) frameUnsubscribe(); frameUnsubscribe = null;
    if (global.Stage) Stage.removeGate('stage-fluid');
    document.removeEventListener('stagecontrol:change', onValues);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('stage:retint', color);
    document.removeEventListener('stage:track-changed', onTrack);
    global.removeEventListener('pagehide', onPageHide); global.removeEventListener('pageshow', onVisibility);
    pointerSplat = queue = rgb = null;
    if (arraysTicket) arraysTicket.release({ apiReleased: true, allocationEnded: true });
    arraysTicket = null; if (resourcePort) resourcePort.forgetReport();
    resourcePort = null; stage = null; options = null; failure = null;
    sceneTime = 0; lastFrameId = -1; state = 'off'; reason = '';
  }
  global.StageFluid = {
    init: init, destroy: destroy, retry: retry, supportsHost: supportsHost,
    status: function () { return { state: state, reason: reason, tier: actualTier, supportedHost: supportsHost(), retryable: !!failure }; },
    stats: function () {
      var resources = engine ? engine.stats() : { contexts: 0, textures: 0, framebuffers: 0, programs: 0,
        shaders: 0, buffers: 0, estimatedBytes: 0, outputPixels: 0, frames: 0, steps: 0 };
      return Object.assign(resources, { state: state, reason: reason, tier: actualTier, created: created, disposed: disposed,
        frames: completedFrames + resources.frames, steps: completedSteps + resources.steps,
        pendingInputs: queueCount + (pendingPointer ? 1 : 0), inputListeners: pointerAttached ? 2 : 0,
        sceneTimeMs: sceneTime, spectrumWatermark: spectrumWatermark, resetDelta: resetDt,
        resizeObservers: resizeObserver ? 1 : 0, lifecycleObservers: observer ? 1 : 0 });
    }
  };
})(window);
