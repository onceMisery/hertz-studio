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
  var pendingDt = 0;
  var sceneTime = 0;
  var ticks = 0;
  var draws = 0;
  var lastHeartbeat = 0;
  var lastClockBeacon = -Infinity;
  var feedExpiryTimer = 0;
  var followSpace = null;
  var followSignature = '';
  // P1-03 轻后端（§10.1）：单图片/单静音视频不进 WebGL，img/video 直接呈现。
  // URL 只接受已安装包的保留域（§8.1）；页面校验是纵深防御，真值在原生拦截层。
  var MEDIA_URL = /^https:\/\/[0-9a-f]{32}\.[0-9a-f]{32}\.wallpaper\.invalid\/files\/[a-z0-9\-_.\/]+$/;
  var MEDIA_FIRST_FRAME_TIMEOUT_MS = 10000;
  var MEDIA_HEARTBEAT_MS = 2000;
  var media = null;
  var mediaToken = 0;
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
    pendingDt = 0;
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
    pendingDt = Math.min(100, pendingDt + dt);
    // 整数分频帧门：只提交第 N 帧；rAF 仍持续用于心跳与 feed 时效。
    frameCount++;
    if (frameCount % gate.divisor !== 0) return;
    var frameDt = pendingDt;
    pendingDt = 0;
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
        submitted = zodiac.render ? zodiac.render(now, frameDt * config.motion / 1000, frameDt / 1000) : false;
      } else if (stage) {
        var shaped = bandsObject(bands);
        var level = 0;
        for (var i = 0; i < BANDS; i++) level += bands[i] || 0;
        level /= BANDS;
        submitted = stage.frame({
          now: now,
          dt: (frameDt * config.motion) / 1000,
          time: (feed.positionMs || 0) / 1000,
          position: feed.positionMs || 0,
          playing: scenePlaying(),
          motionActive: motionAllowed,
          reduced: false,
          sceneTime: sceneTime / 1000,
          dynamicDt: (frameDt * config.motion) / 1000,
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
    if (media) {
      applyMediaMotion(); // 当前呈现是媒体：恢复播放，不重复挂场景
      return true;
    }
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
    applyMediaMotion();
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
    if (media) unmountMedia(); // 场景接管呈现（start 的场景分支/显式 mount）
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
    unmountMedia();
    teardown();
  }

  function applyFollow() {
    if (media) return;
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

  // ---- 轻后端：单图片/单静音视频（P1-03，§10.1/§8.2）----

  function mediaFit(fit) {
    return fit === 'contain' ? 'contain' : fit === 'stretch' ? 'fill' : 'cover';
  }

  function failMedia(code) {
    if (!media || media.state === 'failed') return;
    media.state = 'failed';
    media.error = code;
    clearTimeout(media.deadline);
    releaseMediaElement(media);
    // 心跳续跑：呈现失败但页面存活，由原生决定回退策略（C50），避免看门狗误判停摆。
    notify('wallpaper_media_failed ' + code);
  }

  function mediaReady() {
    error = null;
    // 与场景后端同一就绪语义（§13.3）：首帧真实可呈现后才揭幕。
    notify('wallpaper_ready');
  }

  // motion=0 或停用 → 视频冻结到当前帧（§10.1：不降 playbackRate 伪装静态）。
  function applyMediaMotion() {
    if (!media || media.kind !== 'video' || media.state !== 'ready' || !media.el) return;
    if (enabled && config.motion > 0) {
      var attempt = media.el.play();
      if (attempt && attempt.catch) attempt.catch(function () { /* 恢复被拒：保持冻结 */ });
    } else {
      media.el.pause();
    }
  }

  // 释放顺序（§8.2）：pause → 清 src → load → 移除元素；租约随窗口退出由原生回收。
  function unmountMedia() {
    mediaToken++;
    var record = media;
    media = null;
    if (!record) return;
    if (backend === 'media') backend = null;
    clearInterval(record.timer);
    clearTimeout(record.deadline);
    releaseMediaElement(record);
  }

  function releaseMediaElement(record) {
    var el = record.el;
    record.el = null;
    if (!el) return;
    try {
      if (record.kind === 'video') el.pause();
      el.removeAttribute('src');
      if (record.kind === 'video') el.load();
    } catch (_) { /* context already gone */ }
    el.remove();
  }

  // desc 为 null → 交还场景后端；desc 畸形 → 报失败但不动当前呈现；合法 → 换呈现。
  function applyMedia(desc) {
    if (desc == null) {
      unmountMedia();
      return enabled ? mount() : false;
    }
    var kind = desc && (desc.kind === 'image' || desc.kind === 'video') ? desc.kind : null;
    var url = typeof desc.url === 'string' ? desc.url : '';
    var fit = desc.fit === 'contain' || desc.fit === 'stretch' ? desc.fit : 'cover';
    if (!kind || !MEDIA_URL.test(url) || url.split('/').slice(4).some(part => !part || part === '.' || part === '..') || !host) {
      notify('wallpaper_media_failed media_invalid_selection');
      return false;
    }
    unmountMedia(); // 释放旧媒体呈现（§8.2 顺序；内部令旧 token 失效）
    mediaToken++;
    teardown(); // 一个会话一个后端（§10.2）：场景让位
    switching = false;
    backend = 'media';
    var token = mediaToken;
    var record = { kind: kind, url: url, fit: fit, state: 'loading', error: null, ticks: 0, timer: 0, deadline: 0, el: null };
    media = record;
    var el = document.createElement(kind === 'video' ? 'video' : 'img');
    // 跨 origin 包资源须可作纹理（§8.1）：crossOrigin='anonymous' + 拦截层 CORS。
    el.crossOrigin = 'anonymous';
    el.setAttribute('data-wallpaper-media', kind);
    el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:' +
      mediaFit(fit) + ';visibility:hidden';
    record.el = el;
    el.addEventListener('error', function () {
      if (token !== mediaToken) return;
      failMedia(kind === 'image'
        ? 'media_decode_failed'
        : 'media_error_' + (el.error && el.error.code ? el.error.code : 'unknown'));
    });
    // 静态图无连续 rAF（§10.1）：心跳走低频 interval，页面存活事实不断。
    record.timer = setInterval(function () {
      if (token !== mediaToken) { clearInterval(record.timer); return; }
      record.ticks++;
      notify('wallpaper_heartbeat ' + record.ticks + ' 0 1 0');
    }, MEDIA_HEARTBEAT_MS);
    host.appendChild(el);
    record.deadline = setTimeout(function () {
      if (token === mediaToken && record.state === 'loading') failMedia('media_first_frame_timeout');
    }, MEDIA_FIRST_FRAME_TIMEOUT_MS);
    if (kind === 'image') {
      el.src = url;
      var decoded = el.decode ? el.decode() : Promise.reject(new Error('decode_unsupported'));
      decoded.then(function () {
        if (token !== mediaToken || record.state !== 'loading') return;
        clearTimeout(record.deadline);
        el.style.visibility = 'visible';
        record.state = 'ready';
        mediaReady();
      }, function () {
        if (token !== mediaToken) return;
        failMedia('media_decode_failed');
      });
    } else {
      el.muted = true;
      el.defaultMuted = true;
      el.loop = true;
      el.playsInline = true;
      el.setAttribute('playsinline', '');
      var settled = false;
      var markReady = function () {
        if (settled || token !== mediaToken || record.state !== 'loading') return;
        settled = true;
        clearTimeout(record.deadline);
        el.style.visibility = 'visible';
        record.state = 'ready';
        mediaReady();
        applyMediaMotion();
      };
      // 首帧就绪（§13.3）：帧回调为准，旧引擎回退 loadeddata；超时给结构化失败。
      if (el.requestVideoFrameCallback) {
        el.requestVideoFrameCallback(function () { markReady(); });
      } else {
        el.addEventListener('loadeddata', markReady, { once: true });
      }
      el.src = url;
      var attempt = el.play();
      if (attempt && attempt.catch) attempt.catch(function () {
        if (settled || token !== mediaToken) return;
        failMedia('media_play_rejected');
      });
    }
    return true;
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
    var previousQuality = config.quality;
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
    applyMediaMotion();
    if (!mounted) return;
    if (previousQuality !== config.quality) {
      followSignature = '';
      var id = targetScene();
      selectScene(id, config.source === 'follow' && followSpace ? followSpace.params : null, false, true);
      return;
    }
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
      media: media ? {
        kind: media.kind,
        url: media.url,
        fit: media.fit,
        state: media.state,
        error: media.error,
        ticks: media.ticks,
        muted: media.kind === 'video' && media.el ? media.el.muted === true : null,
        paused: media.kind === 'video' && media.el ? media.el.paused === true : null,
        timeMs: media.kind === 'video' && media.el ? Math.round((media.el.currentTime || 0) * 1000) : null,
        durationMs: media.kind === 'video' && media.el && isFinite(media.el.duration)
          ? Math.round(media.el.duration * 1000)
          : null
      } : null,
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
    applyMedia: applyMedia,
    start: start,
    stop: stop,
    mount: mount,
    unmount: unmount,
    debug: debug
  };

  notify('wallpaper_clock ' + performance.now());
  notify('wallpaper_dom_ready');
})();
