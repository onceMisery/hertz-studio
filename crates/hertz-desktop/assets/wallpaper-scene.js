(function () {
  'use strict';

  var BANDS = 64;
  var ZERO = new Float32Array(BANDS);
  var host = document.getElementById('host');
  var runtime = window.HertzStageRuntime || {};
  var zodiac = window.ZodiacStagePure || runtime.ZodiacStagePure || null;
  var spaceRuntime = runtime.SpaceStagePure || null;
  var DEFAULT_SCENE = 'zodiac';
  var ALLOWED = {
    zodiac: true,
    coast: true,
    'butterfly-vortex': true,
    'phoenix-vortex': true,
    reactor: true,
    'particle-silk': true,
    'gravity-sphere': true,
    'warp-tunnel': true,
    'prism-galaxy': true
  };

  var config = {
    source: 'follow',
    scene: DEFAULT_SCENE,
    musicResponse: true,
    brightness: 1,
    motion: 1,
    quality: 'low',
    refreshHz: 60
  };
  var backend = null;
  var sceneId = null;
  var sceneParams = null;
  var stage = null;
  var canvas = null;
  var mounted = false;
  var switching = false;
  var lost = false;
  var enabled = false;
  var error = null;
  var selectToken = 0;
  var raf = 0;
  var last = 0;
  var cap = 30;
  // ADR-0006 整数分频：N=max(1,ceil(refreshHz/targetFps))，有效预算=refreshHz/N。
  // 帧门按 rAF 计数取模，不漂移；停绘恢复先重置计数与时间基准。
  var gate = { divisor: 2, budget: 30 };
  var frameCount = 0;
  var sceneTime = 0;
  var ticks = 0;
  var draws = 0;
  var lastHeartbeat = 0;
  var lastClockBeacon = -Infinity;
  var feedExpiryTimer = 0;
  var followSpace = null;
  var followSignature = '';
  var feed = {
    valid: false,
    playing: false,
    positionMs: 0,
    durationMs: null,
    bands: new Float32Array(BANDS),
    energy: 0,
    ageMs: null,
    receivedAt: null,
    expiresAt: null
  };

  function computeGate(fps, refreshHz) {
    var hz = refreshHz >= 5 ? refreshHz : 60;
    var divisor = Math.max(1, Math.ceil(hz / (fps || 30)));
    return { divisor: divisor, budget: hz / divisor };
  }

  function resetGate() {
    frameCount = 0;
    last = 0;
  }

  // motion=0 冻结环境运动（真实媒体时钟不变）；音频响应仍按 musicResponse 独立生效。
  function motionActive() {
    return config.motion > 0;
  }

  function applyBrightness() {
    var value = Math.min(1, Math.max(0.25, Number(config.brightness) || 1));
    if (host) host.style.filter = value >= 0.999 ? '' : 'brightness(' + value + ')';
  }

  function notify(message) {
    if (window.parent !== window && window.parent.hertzWallpaperSettings) {
      window.parent.hertzWallpaperSettings.previewEvent(message);
      return;
    }
    if (window.ipc && window.ipc.postMessage) window.ipc.postMessage(message);
  }

  function catalog() {
    try {
      return spaceRuntime && spaceRuntime.catalog ? spaceRuntime.catalog() : [];
    } catch (_) {
      return [];
    }
  }

  function catalogScene(id) {
    var list = catalog();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  }

  function canonicalScene(id) {
    try {
      return spaceRuntime && spaceRuntime.resolveId ? spaceRuntime.resolveId(id) || id : id;
    } catch (_) {
      return id;
    }
  }

  function allowedScene(id) {
    return !!ALLOWED[id];
  }

  function targetScene() {
    if (config.source === 'follow' && followSpace) {
      var followed = canonicalScene(followSpace.scene);
      if (allowedScene(followed)) return followed;
    }
    return allowedScene(config.scene) ? config.scene : DEFAULT_SCENE;
  }

  function zodiacCamera() {
    var scene = catalogScene('zodiac');
    return scene ? scene.camera || null : null;
  }

  function applyZodiacCamera() {
    var camera = zodiacCamera();
    if (!camera || !zodiac) return false;
    var tan = Math.tan((camera.fov || 52) * Math.PI / 360);
    var aspect = Math.max(0.01, innerWidth / innerHeight);
    var fit = camera.fit;
    var fitDistance = fit
      ? Math.max(fit.halfWidth / tan / aspect, fit.halfHeight / tan)
      : 0;
    var look = camera.lookAt || [0, 0, 0];
    zodiac.setRig({
      yaw: camera.theta || 0,
      pitch: camera.phi || 0,
      dist: Math.max(camera.radius || 8, fitDistance),
      fov: camera.fov || 52,
      tx: look[0], ty: look[1], tz: look[2],
      roll: 0
    }, { external: true });
    return true;
  }

  function applySpaceCamera() {
    var scene = catalogScene(sceneId);
    var camera = scene && scene.camera;
    if (!camera || !stage) return;
    var look = camera.lookAt || [0, 0, 0];
    stage.setRig({
      yaw: camera.theta || 0,
      pitch: camera.phi || 0,
      dist: camera.radius || 8,
      fov: camera.fov || 52,
      tx: look[0], ty: look[1], tz: look[2],
      roll: 0
    }, { external: true });
  }

  function scenePlaying() {
    return feed.valid && feed.playing;
  }

  function effectiveBands(now) {
    if (!feed.valid || config.musicResponse === false) return ZERO;
    var since = feed.receivedAt == null ? 0 : Math.max(0, now - feed.receivedAt);
    var age = (feed.ageMs == null ? 0 : feed.ageMs) + since;
    if (age <= 500) return feed.bands;
    if (age >= 1000) return ZERO;
    var gain = (1000 - age) / 500;
    var out = new Float32Array(BANDS);
    for (var i = 0; i < BANDS; i++) out[i] = feed.bands[i] * gain;
    return out;
  }

  function bandsObject(bands) {
    var bass = 0;
    var mid = 0;
    var treble = 0;
    var i;
    for (i = 0; i < 8; i++) bass += bands[i] || 0;
    for (i = 8; i < 24; i++) mid += bands[i] || 0;
    for (i = 24; i < BANDS; i++) treble += bands[i] || 0;
    var spectrum = new Float32Array(16);
    for (i = 0; i < spectrum.length; i++) {
      spectrum[i] = bands[Math.min(BANDS - 1, Math.floor(i * BANDS / spectrum.length))] || 0;
    }
    return {
      bass: bass / 8,
      mid: mid / 16,
      treble: treble / (BANDS - 24),
      spectrum: spectrum
    };
  }

  function heartbeat(now) {
    if (now - lastHeartbeat < 2000) return;
    lastHeartbeat = now;
    notify('wallpaper_heartbeat ' + ticks + ' ' + draws + ' ' +
      (mounted && !lost ? 1 : 0) + ' ' + (lost ? 1 : 0));
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    ticks++;
    heartbeat(now);
    if (!mounted || lost) return;
    if (!last) last = now;
    var dt = Math.min(100, now - last);
    last = now;
    if (feed.valid && feed.expiresAt != null && now >= feed.expiresAt) applyFeed(null);
    if (feed.valid && feed.receivedAt == null) feed.receivedAt = now;
    // 场景时间按运动强度积分；真实媒体时钟（positionMs）单独随 feed 传递。
    sceneTime += dt * config.motion;
    // 整数分频帧门：只提交第 N 帧；rAF 仍持续用于心跳与 feed 时效。
    frameCount++;
    if (frameCount % gate.divisor !== 0) return;
    var bands = effectiveBands(now);
    var motionAllowed = motionActive();
    try {
      var submitted = false;
      if (backend === 'zodiac') {
        if (!zodiac) return;
        zodiac.setAudio({ bands: bands, onset: false });
        zodiac.setTime({ time: sceneTime / 1000, playing: scenePlaying() });
        if (zodiac.setMotion) zodiac.setMotion({ active: motionAllowed });
        // 外部时钟模式：本页是唯一调度器；旧 bundle 回退内部循环。
        submitted = zodiac.render ? zodiac.render(now) : true;
      } else if (stage) {
        var shaped = bandsObject(bands);
        var level = 0;
        for (var i = 0; i < BANDS; i++) level += bands[i] || 0;
        level /= BANDS;
        submitted = stage.frame({
          now: now,
          dt: (dt * config.motion) / 1000,
          time: (feed.positionMs || 0) / 1000,
          position: feed.positionMs || 0,
          playing: scenePlaying(),
          motionActive: motionAllowed,
          reduced: false,
          sceneTime: sceneTime / 1000,
          dynamicDt: (dt * config.motion) / 1000,
          deviceTier: 1,
          level: level,
          onset: 0,
          bands: shaped,
          spectrum: shaped.spectrum,
          pointer: { x: 0, y: 0, active: false },
          lyrics: null,
          track: null,
          preview: null
        }) === true;
      }
      // 只在渲染真实提交后计数；尝试调用不算 GPU 完成（P0-05）。
      if (submitted) draws++;
    } catch (failure) {
      error = String(failure);
    }
  }

  function startLoop() {
    if (!raf && enabled && !lost) {
      resetGate();
      raf = requestAnimationFrame(loop);
    }
  }

  function start(fps) {
    cap = fps || cap;
    gate = computeGate(cap, config.refreshHz);
    resetGate();
    enabled = true;
    if (!mounted && !switching) return mount();
    if (mounted && !lost) startLoop();
    return true;
  }

  function stop() {
    enabled = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (backend === 'zodiac' && mounted && zodiac) {
      zodiac.setTime({ time: sceneTime / 1000, playing: false });
    }
  }

  function onLost(event) {
    if (event) event.preventDefault();
    lost = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function onRestored() {
    lost = false;
    if (!enabled) return;
    switching = false;
    teardown();
    mount();
  }

  function attachCanvas() {
    canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%';
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    host.appendChild(canvas);
  }

  function teardown() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    selectToken++;
    if (backend === 'zodiac' && zodiac) {
      try { zodiac.unmount(); } catch (_) { /* context already gone */ }
    }
    if (stage) {
      try { stage.dispose(); } catch (_) { /* context already gone */ }
    }
    stage = null;
    mounted = false;
    backend = null;
    sceneId = null;
    sceneParams = null;
    lost = false;
    if (canvas) {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      canvas.remove();
    }
    canvas = null;
  }

  function mountZodiac(initial) {
    if (!zodiac) throw new Error('zodiac runtime missing');
    attachCanvas();
    applyBrightness();
    if (!zodiac.mount(canvas, {
      quality: config.quality,
      reduced: false,
      interactive: false,
      // 外部时钟：本页持唯一调度器（设计 §3.1），fps 门才真实作用于提交。
      external: true
    })) throw new Error('mount returned false');
    zodiac.resize(innerWidth, innerHeight);
    if (!applyZodiacCamera()) throw new Error('scene_registry_error');
    zodiac.setPrefs({ field: true, interactive: false });
    if (zodiac.setMotion) zodiac.setMotion({ active: motionActive() });
    backend = 'zodiac';
    sceneId = 'zodiac';
    sceneParams = null;
    mounted = true;
    lost = false;
    error = null;
    sceneTime = 0;
    if (initial) notify('wallpaper_ready');
    startLoop();
  }

  async function selectScene(id, params, initial, force) {
    if (!allowedScene(id)) id = DEFAULT_SCENE;
    var nextBackend = id === 'zodiac' && zodiac ? 'zodiac' : 'space';
    if (!force && mounted && sceneId === id && backend === nextBackend) {
      if (id !== 'zodiac' && params && stage) {
        try {
          var patched = stage.setParams(params);
          if (patched) sceneParams = patched.params || params;
        } catch (failure) {
          error = String(failure);
        }
      }
      return true;
    }
    switching = true;
    teardown();
    var token = ++selectToken;
    try {
      if (nextBackend === 'zodiac') {
        mountZodiac(initial);
        return true;
      }
      if (!spaceRuntime) throw new Error('space runtime missing');
      attachCanvas();
      applyBrightness();
      stage = spaceRuntime.create(canvas, {
        qualityMode: config.quality,
        deviceTier: 1,
        onInvalidate: function () { /* wallpaper loop already runs */ },
        onStatus: function (status) {
          if (status && status.state === 'failed') error = status.error || 'scene_failed';
        }
      });
      stage.setServices({
        coverUrl: function () { return ''; },
        coverItems: function () { return []; },
        resolveCover: function (url) { return url; },
        queue: function () { return []; },
        previewTrack: function () {},
        playTrack: function () {},
        onRecipe: function () {},
        zodiacEvent: function () {},
        invalidate: function () {}
      });
      var normalized = await stage.select(id, { params: params || {} });
      if (token !== selectToken || !stage) return false;
      backend = 'space';
      sceneId = (normalized && normalized.id) || id;
      sceneParams = (normalized && normalized.params) || params || {};
      mounted = true;
      lost = false;
      error = null;
      sceneTime = 0;
      stage.resize(innerWidth, innerHeight);
      applySpaceCamera();
      if (initial) notify('wallpaper_ready');
      startLoop();
      return true;
    } catch (failure) {
      if (token !== selectToken) return false;
      error = String(failure);
      teardown();
      if (id !== DEFAULT_SCENE) {
        return selectScene(DEFAULT_SCENE, null, initial, true);
      }
      switching = false;
      if (initial) notify('wallpaper_mount_failed');
      return false;
    } finally {
      if (token === selectToken) switching = false;
    }
  }

  function mount() {
    if (mounted || switching) return true;
    if (!zodiac && !spaceRuntime) {
      error = 'scene_runtime_missing';
      notify('wallpaper_mount_failed');
      return false;
    }
    var id = targetScene();
    var params = id === 'zodiac' ? null : (followSpace && canonicalScene(followSpace.scene) === id ? followSpace.params : null);
    var pending = selectScene(id, params, true, false);
    Promise.resolve(pending).then(function (ok) {
      if (!ok && !mounted && !switching) {
        error = error || 'scene_mount_failed';
        notify('wallpaper_mount_failed');
      }
    });
    return true;
  }

  function unmount() {
    stop();
    switching = false;
    teardown();
  }

  function applyFollow() {
    if (config.source !== 'follow' || !mounted || !followSpace) return;
    var id = canonicalScene(followSpace.scene);
    if (!allowedScene(id)) return;
    var params = followSpace.params && typeof followSpace.params === 'object' ? followSpace.params : {};
    var signature = id + '|' + JSON.stringify(params);
    if (id === sceneId) {
      if (backend === 'space' && stage && signature !== followSignature) {
        followSignature = signature;
        try {
          var patched = stage.setParams(params);
          if (patched) sceneParams = patched.params || params;
        } catch (failure) {
          error = String(failure);
        }
      } else if (backend === 'zodiac') {
        followSignature = signature;
      }
      return;
    }
    if (signature === followSignature) return;
    followSignature = signature;
    selectScene(id, params, false, false);
  }

  function applyConfig(next) {
    if (!next || typeof next !== 'object') return;
    if (Array.isArray(next.allowed) && next.allowed.length) {
      var allowed = {};
      for (var i = 0; i < next.allowed.length; i++) {
        if (typeof next.allowed[i] === 'string') allowed[next.allowed[i]] = true;
      }
      if (allowed[DEFAULT_SCENE]) ALLOWED = allowed;
    }
    var previousSource = config.source;
    var nextSource = next.source === 'fixed' ? 'fixed' : 'follow';
    config.musicResponse = next.musicResponse !== false;
    if (Number.isFinite(Number(next.brightness))) config.brightness = Math.min(1, Math.max(0.25, Number(next.brightness)));
    if (Number.isFinite(Number(next.motion))) config.motion = Math.min(1, Math.max(0, Number(next.motion)));
    if (next.quality === 'low' || next.quality === 'medium' || next.quality === 'high') config.quality = next.quality;
    if (Number.isFinite(Number(next.refreshHz)) && Number(next.refreshHz) >= 5) config.refreshHz = Number(next.refreshHz);
    var nextScene = allowedScene(next.scene) ? next.scene : config.scene;
    config.source = nextSource;
    config.scene = nextScene;
    gate = computeGate(cap, config.refreshHz);
    resetGate();
    applyBrightness();
    if (zodiac && zodiac.setMotion && backend === 'zodiac') zodiac.setMotion({ active: motionActive() });
    if (!mounted) return;
    if (nextSource === 'fixed') {
      if (previousSource !== 'fixed' || sceneId !== nextScene) {
        followSignature = '';
        selectScene(nextScene, null, false, previousSource !== 'fixed');
      }
      return;
    }
    followSignature = '';
    applyFollow();
  }

  function expireFeed() {
    if (feed.expiresAt == null) return;
    var remaining = feed.expiresAt - performance.now();
    if (remaining <= 0) applyFeed(null);
    else feedExpiryTimer = setTimeout(expireFeed, remaining + 1);
  }
  function applyFeed(snapshot) {
    clearTimeout(feedExpiryTimer);
    if (snapshot == null || typeof snapshot !== 'object') {
      feed.valid = false;
      feed.playing = false;
      feed.positionMs = 0;
      feed.durationMs = null;
      feed.bands = new Float32Array(BANDS);
      feed.energy = 0;
      feed.ageMs = null;
      feed.receivedAt = null;
      feed.expiresAt = null;
      return false;
    }
    var spectrum = snapshot.spectrum;
    var bands = spectrum && spectrum.bands;
    var valid = snapshot.valid === true
      && typeof snapshot.playing === 'boolean'
      && Array.isArray(bands)
      && bands.length === BANDS
      && bands.every(function (value) {
        return typeof value === 'number' && isFinite(value) && value >= 0 && value <= 1;
      })
      && typeof spectrum.energy === 'number'
      && isFinite(spectrum.energy)
      && spectrum.energy >= 0
      && spectrum.energy <= 1
      && (spectrum.ageMs == null
        || (typeof spectrum.ageMs === 'number' && isFinite(spectrum.ageMs) && spectrum.ageMs >= 0));
    if (!valid) return applyFeed(null);
    var now = performance.now();
    var snapshotAge = Math.max(0, Number(snapshot.snapshotAgeMs) || 0) + (Number.isFinite(snapshot.pageDispatchMs) ? Math.max(0, now - snapshot.pageDispatchMs) : 0);
    if (snapshotAge >= 2000 && now - lastClockBeacon >= 1000) { lastClockBeacon = now; notify('wallpaper_clock ' + now); }
    if (snapshotAge >= 3000) return applyFeed(null);
    feed.valid = true;
    feed.playing = snapshot.playing;
    feed.positionMs = typeof snapshot.positionMs === 'number' ? snapshot.positionMs : 0;
    feed.durationMs = typeof snapshot.durationMs === 'number' ? snapshot.durationMs : null;
    feed.energy = spectrum.energy;
    feed.ageMs = spectrum.ageMs == null ? null : spectrum.ageMs + snapshotAge;
    feed.bands = new Float32Array(BANDS);
    for (var i = 0; i < BANDS; i++) feed.bands[i] = bands[i];
    feed.receivedAt = performance.now();
    feed.expiresAt = feed.receivedAt + 3000 - snapshotAge;
    feedExpiryTimer = setTimeout(expireFeed, Math.max(0, 3001 - snapshotAge));
    followSpace = snapshot.space && typeof snapshot.space.scene === 'string'
      ? {
          scene: snapshot.space.scene,
          params: snapshot.space.params && typeof snapshot.space.params === 'object' ? snapshot.space.params : {}
        }
      : null;
    if (config.source === 'follow') applyFollow();
    return true;
  }

  function debug(now) {
    var stats = null;
    if (backend === 'zodiac' && zodiac) stats = zodiac.stats();
    else if (stage) stats = stage.stats();
    var bands = effectiveBands(Number.isFinite(now) ? now : last);
    var peak = 0;
    for (var i = 0; i < bands.length; i++) if (bands[i] > peak) peak = bands[i];
    return {
      mounted: mounted,
      error: error,
      ticks: ticks,
      draws: draws,
      sceneTime: Math.round(sceneTime),
      scene: sceneId,
      backend: backend,
      source: config.source,
      musicResponse: config.musicResponse,
      brightness: config.brightness,
      motion: config.motion,
      quality: config.quality,
      refreshHz: config.refreshHz,
      gate: gate,
      sceneParams: sceneParams,
      followScene: followSpace ? followSpace.scene : null,
      followSignature: followSignature,
      valid: feed.valid,
      playing: feed.playing,
      positionMs: feed.positionMs,
      energy: feed.energy,
      ageMs: feed.ageMs,
      feedPeak: peak,
      stats: stats
    };
  }

  addEventListener('resize', function () {
    if (!mounted) return;
    if (backend === 'zodiac' && zodiac) {
      zodiac.resize(innerWidth, innerHeight);
      applyZodiacCamera();
    } else if (stage) {
      stage.resize(innerWidth, innerHeight);
      applySpaceCamera();
    }
  });

  window.hertzWallpaper = {
    applyFeed: applyFeed,
    applyConfig: applyConfig,
    start: start,
    stop: stop,
    mount: mount,
    unmount: unmount,
    debug: debug
  };

  notify('wallpaper_clock ' + performance.now());
  notify('wallpaper_dom_ready');
})();
