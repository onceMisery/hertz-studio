// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors.
// Optional presentation layer. StageControl owns preferences; Stage owns time.
(function (global) {
  'use strict';
  var stage = null, canvas = null, engine = null, options = null;
  var initialized = false, generation = 0, preparing = false, failure = null;
  var observer = null, resizeObserver = null, pointerAttached = false;
  var state = 'off', reason = '', actualTier = 0, ceiling = 2, dirty = false, resetDt = true;
  var created = 0, disposed = 0, completedFrames = 0, completedSteps = 0;
  var sceneTime = 0, lastMusic = -1, lastInput = 0, lastBeat = 0, mediaEpoch = null;
  var lastSpectrum = null, spectrumAt = 0, pointerX = -1, pointerY = -1, pendingPointer = false;
  var pointerSplat = new Float32Array(5), queue = new Float32Array(15 * 5), queueAt = 0, queueCount = 0;
  var rgb = new Float32Array(3), bounds = { left: 0, top: 0, width: 0, height: 0 };
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
    document.dispatchEvent(new CustomEvent('stagefluid:state'));
  }
  function kick() { if (global.Stage && Stage.kick) Stage.kick(); }
  function clearInput() {
    queueAt = queueCount = 0; pendingPointer = false; pointerX = pointerY = -1;
    resetDt = true;
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
    if (canvas) { canvas.remove(); canvas = null; }
    actualTier = 0; dirty = false;
  }
  function stopWatching() {
    if (observer) { observer.disconnect(); observer = null; }
    global.removeEventListener('resize', onResize);
    global.removeEventListener('scroll', measure);
  }
  function watch() {
    if (observer || typeof MutationObserver !== 'function') return;
    observer = new MutationObserver(function () { sync(); if (engine) measure(); });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-stage-preset'] });
    observer.observe(stage, { attributes: true, attributeFilter: ['class', 'hidden'] });
    global.addEventListener('resize', onResize);
    global.addEventListener('scroll', measure, { passive: true });
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
    if (!engine || !canvas) return;
    var art = stage.querySelector('.disc-wrap'), host = stage.getBoundingClientRect();
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
    engine.resize(bounds.width, bounds.height); dirty = true; resetDt = true; kick();
  }
  function contextLost(event) {
    event.preventDefault(); fail(new Error('图形资源已中断，点击重试恢复流体增强'));
  }
  function fail(error) {
    failure = { message: error.message, unsupported: /^UNSUPPORTED_/.test(error.code || '') };
    release(); report(failure.unsupported ? 'unavailable' : 'error', failure.unsupported
      ? '当前设备暂不支持此效果' : '流体暂不可用，请重试');
  }
  function prepare(tier) {
    if (preparing || engine) return;
    var ticket = ++generation; preparing = true; report('preparing', '正在准备流体');
    Promise.resolve().then(function () {
      if (ticket !== generation || !options.fluidEnabled || !supportsHost() || document.hidden
        || !Stage.isStageVisible()) return;
      try {
        canvas = document.createElement('canvas'); canvas.className = 'stage-fluid-canvas';
        canvas.setAttribute('aria-hidden', 'true');
        engine = global.HertzFluidEngine.create(canvas, tier); created++; actualTier = tier;
        canvas.addEventListener('webglcontextlost', contextLost);
        stage.insertBefore(canvas, stage.firstChild);
        measure(); color(); engine.render(); preparing = false;
        if (typeof ResizeObserver === 'function') {
          resizeObserver = new ResizeObserver(measure);
          resizeObserver.observe(stage);
          var cover = stage.querySelector('.disc-wrap'); if (cover) resizeObserver.observe(cover);
        }
        bindPointer(); sync(); kick();
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
    if (document.hidden || !Stage.isStageVisible()) {
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
    if (!engine || document.hidden || !Stage.isStageVisible()) return 0;
    if (dirty) return HertzFluidEngine.profiles[actualTier].fps;
    if (state !== 'active') return 0;
    var spectrum = Stage.spectrum(), now = performance.now();
    if (spectrum && spectrum.length && spectrum !== lastSpectrum) { lastSpectrum = spectrum; spectrumAt = now; }
    var musicActive = options.fluidAudio && Stage.energy() >= .005 && now - spectrumAt < 600;
    if (!pendingPointer && !queueCount && !musicActive
      && sceneTime - lastInput > 8) { resetDt = true; return 0; }
    return HertzFluidEngine.profiles[actualTier].fps;
  }
  function tick(dtMs) {
    if (!engine) return;
    try {
      if (state !== 'active') { if (dirty) { engine.render(); dirty = false; } return; }
      var dt = resetDt ? 0 : Math.min(50, dtMs) / 1000; resetDt = false; sceneTime += dt;
      var presentation = Stage.presentation();
      if (mediaEpoch !== presentation.mediaEpoch) {
        mediaEpoch = presentation.mediaEpoch; engine.reset(); clearInput(); lastMusic = -1;
      }
      var spectrum = Stage.spectrum(), now = performance.now();
      if (spectrum && spectrum.length && spectrum !== lastSpectrum) { lastSpectrum = spectrum; spectrumAt = now; }
      var fresh = spectrum && spectrum.length && now - spectrumAt < 600;
      var energy = fresh ? Math.max(0, Math.min(1, Stage.energy())) : 0;
      var features = global.StageParticles && StageParticles.audioFeatures ? StageParticles.audioFeatures() : null;
      var beat = features && now - features.sampledAt < 600 ? features.beats : lastBeat;
      if (options.fluidAudio && energy > .005 && (sceneTime - lastMusic > .13 || beat !== lastBeat)) {
        var phase = sceneTime * .65, amount = Math.min(1.5, energy * 1.8 + (beat !== lastBeat ? .3 : 0));
        queueMusic(orbit.x + Math.cos(phase) * orbit.rx, orbit.y + Math.sin(phase) * orbit.ry,
          -Math.sin(phase) * (40 + energy * 75), Math.cos(phase) * (40 + energy * 75), amount);
        queueMusic(orbit.x - Math.cos(phase) * orbit.rx, orbit.y - Math.sin(phase) * orbit.ry,
          Math.sin(phase) * (30 + energy * 55), -Math.cos(phase) * (30 + energy * 55), amount * .65);
        lastMusic = sceneTime;
      }
      lastBeat = beat;
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
      engine.step(dt); engine.render(); dirty = false;
    } catch (error) { fail(error); }
  }
  function onValues(event) {
    var next = event.detail || StageControl.values(), wasEnabled = options && options.fluidEnabled;
    options = next;
    if (!wasEnabled && next.fluidEnabled) { failure = null; ceiling = Stage.tier(); }
    sync(); if (engine) { color(); measure(); } kick();
  }
  function onVisibility() { sync(); kick(); }
  function onResize() { sync(); measure(); kick(); }
  function onTrack() {
    clearInput(); lastSpectrum = null; spectrumAt = 0; lastMusic = -1;
    if (engine) { engine.reset(); color(); }
  }
  function onPageHide() { release(); stopWatching(); }
  function retry() { failure = null; ceiling = Stage.tier(); sync(); kick(); }
  function init() {
    if (initialized || !global.Stage || !global.StageControl || !global.HertzFluidEngine) return;
    stage = document.getElementById('stage'); if (!stage) return;
    initialized = true; options = StageControl.values();
    Stage.gate('stage-fluid', targetFps, tick);
    document.addEventListener('stagecontrol:change', onValues);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('stage:retint', color);
    document.addEventListener('stage:track-changed', onTrack);
    if (global.Theme && Theme.onChange) Theme.onChange(color);
    global.addEventListener('pagehide', onPageHide);
    global.addEventListener('pageshow', onVisibility);
    sync();
  }
  global.StageFluid = {
    init: init, retry: retry, supportsHost: supportsHost,
    status: function () { return { state: state, reason: reason, tier: actualTier, supportedHost: supportsHost(), retryable: !!failure }; },
    stats: function () {
      var resources = engine ? engine.stats() : { contexts: 0, textures: 0, framebuffers: 0, programs: 0,
        shaders: 0, buffers: 0, estimatedBytes: 0, outputPixels: 0, frames: 0, steps: 0 };
      return Object.assign(resources, { state: state, reason: reason, tier: actualTier, created: created, disposed: disposed,
        frames: completedFrames + resources.frames, steps: completedSteps + resources.steps,
        pendingInputs: queueCount + (pendingPointer ? 1 : 0), inputListeners: pointerAttached ? 2 : 0,
        resizeObservers: resizeObserver ? 1 : 0, lifecycleObservers: observer ? 1 : 0 });
    }
  };
})(window);
