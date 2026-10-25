(function () {
  'use strict';

  var BANDS = 64;
  var ZERO = new Float32Array(BANDS);
  var host = document.getElementById('host');
  var canvas = null, mounted = false, raf = 0, last = 0, lastDraw = 0;
  var sceneTime = 0, cap = 30, enabled = true, lost = false, error = null, ticks = 0, draws = 0, lastHeartbeat = 0;
  var feed = { valid: false, playing: false, bands: new Float32Array(BANDS),
    energy: 0, ageMs: null, receivedAt: null };

  function notify(message) {
    if (window.ipc && window.ipc.postMessage) window.ipc.postMessage(message);
  }

  function registryCamera() {
    var runtime = window.HertzStageRuntime;
    var catalog = runtime && runtime.SpaceStagePure && runtime.SpaceStagePure.catalog
      ? runtime.SpaceStagePure.catalog() : null;
    if (!catalog) return null;
    for (var i = 0; i < catalog.length; i++) {
      if (catalog[i] && catalog[i].id === 'zodiac') return catalog[i].camera || null;
    }
    return null;
  }

  function applySceneCamera() {
    var camera = registryCamera();
    if (!camera || !(camera.radius > 0) || !(camera.fov > 0)) {
      error = 'scene_registry_error';
      notify('wallpaper_mount_failed');
      return false;
    }
    var tan = Math.tan(camera.fov * Math.PI / 360);
    var aspect = Math.max(0.01, innerWidth / innerHeight);
    var fit = camera.fit;
    var fitDistance = fit
      ? Math.max(fit.halfWidth / tan / aspect, fit.halfHeight / tan)
      : 0;
    var look = camera.lookAt || [0, 0, 0];
    window.ZodiacStagePure.setRig({
      yaw: camera.theta || 0,
      pitch: camera.phi || 0,
      dist: Math.max(camera.radius, fitDistance),
      fov: camera.fov,
      tx: look[0], ty: look[1], tz: look[2],
    }, { external: true });
    return true;
  }

  // 只有“有效且正在播放”的音乐帧才驱动频谱反应；无曲/暂停/断连都按环境动画处理。
  function scenePlaying() {
    return feed.valid && feed.playing;
  }

  function effectiveBands(now) {
    if (!feed.valid) return ZERO;
    var since = feed.receivedAt == null ? 0 : Math.max(0, now - feed.receivedAt);
    var age = (feed.ageMs == null ? 0 : feed.ageMs) + since;
    if (age <= 500) return feed.bands;
    if (age >= 1000) return ZERO;
    var gain = (1000 - age) / 500;
    var out = new Float32Array(BANDS);
    for (var i = 0; i < BANDS; i++) out[i] = feed.bands[i] * gain;
    return out;
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    ticks++;
    if (now - lastHeartbeat >= 2000) {
      lastHeartbeat = now;
      notify('wallpaper_heartbeat ' + ticks + ' ' + draws + ' ' + (mounted ? 1 : 0) + ' ' + (lost ? 1 : 0));
    }
    if (!mounted || lost) return;
    if (!last) last = now;
    var dt = Math.min(100, now - last);
    last = now;
    if (feed.valid && feed.receivedAt == null) feed.receivedAt = now;
    // 视觉时钟只由本机单调时间推进；feed.positionMs 不参与，seek 不会把星座拉回。
    sceneTime += dt;
    if (now - lastDraw >= 1000 / cap - 0.5) {
      lastDraw = now;
      draws++;
      window.ZodiacStagePure.setAudio({ bands: effectiveBands(now), onset: false });
      window.ZodiacStagePure.setTime({ time: sceneTime / 1000, playing: scenePlaying() });
    }
  }

  function start(fps) {
    cap = fps || cap;
    enabled = true;
    if (!mounted) return mount();
    if (!raf && !lost) {
      last = 0;
      raf = requestAnimationFrame(loop);
    }
    window.ZodiacStagePure.setTime({ time: sceneTime / 1000, playing: scenePlaying() });
    return true;
  }

  function stop() {
    enabled = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (mounted && window.ZodiacStagePure) {
      window.ZodiacStagePure.setTime({ time: sceneTime / 1000, playing: false });
    }
  }

  function onLost(event) {
    if (event) event.preventDefault();
    lost = true;
    stop();
  }

  function onRestored() {
    lost = false;
    start(cap);
  }

  function mount() {
    if (mounted) return true;
    if (!window.ZodiacStagePure) {
      error = 'scene_runtime_missing';
      notify('wallpaper_mount_failed');
      return false;
    }
    canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%';
    host.appendChild(canvas);
    try {
      if (!window.ZodiacStagePure.mount(canvas, {
        quality: 'low', reduced: false, interactive: false,
      })) throw new Error('mount returned false');
    } catch (mountError) {
      error = String(mountError);
      canvas.remove();
      canvas = null;
      notify('wallpaper_mount_failed');
      return false;
    }
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    window.ZodiacStagePure.resize(innerWidth, innerHeight);
    if (!applySceneCamera()) {
      window.ZodiacStagePure.unmount();
      canvas.remove();
      canvas = null;
      return false;
    }
    window.ZodiacStagePure.setPrefs({ field: true, interactive: false });
    mounted = true;
    lost = false;
    error = null;
    sceneTime = 0;
    last = 0;
    lastDraw = 0;
    start(cap);
    notify('wallpaper_ready');
    return true;
  }

  function unmount() {
    stop();
    if (!mounted) return;
    if (canvas) {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
    }
    if (window.ZodiacStagePure) window.ZodiacStagePure.unmount();
    mounted = false;
    if (canvas) canvas.remove();
    canvas = null;
  }

  function applyFeed(snapshot) {
    if (snapshot == null || typeof snapshot !== 'object') {
      feed.valid = false;
      feed.playing = false;
      feed.bands = new Float32Array(BANDS);
      feed.energy = 0;
      feed.ageMs = null;
      feed.receivedAt = null;
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
    feed.valid = true;
    feed.playing = snapshot.playing;
    feed.energy = spectrum.energy;
    feed.ageMs = spectrum.ageMs;
    feed.bands = new Float32Array(BANDS);
    for (var i = 0; i < BANDS; i++) feed.bands[i] = bands[i];
    feed.receivedAt = null;
    return true;
  }

  function debug(now) {
    var scene = window.ZodiacStagePure ? window.ZodiacStagePure.debug() : null;
    var stats = window.ZodiacStagePure ? window.ZodiacStagePure.stats() : null;
    var bands = effectiveBands(Number.isFinite(now) ? now : last);
    var peak = 0;
    for (var i = 0; i < bands.length; i++) if (bands[i] > peak) peak = bands[i];
    return {
      mounted: mounted,
      error: error,
      ticks: ticks,
      draws: draws,
      sceneTime: Math.round(sceneTime),
      valid: feed.valid,
      playing: feed.playing,
      energy: feed.energy,
      ageMs: feed.ageMs,
      feedPeak: peak,
      sceneBass: stats ? stats.bass : null,
      controlled: scene ? scene.controlled : false,
      camera: scene ? scene.camera.position : null,
    };
  }

  addEventListener('resize', function () {
    if (mounted) {
      window.ZodiacStagePure.resize(innerWidth, innerHeight);
      applySceneCamera();
    }
  });

  window.hertzWallpaper = {
    applyFeed: applyFeed,
    start: start,
    stop: stop,
    mount: mount,
    unmount: unmount,
    debug: debug,
  };

  notify('wallpaper_dom_ready');
})();
