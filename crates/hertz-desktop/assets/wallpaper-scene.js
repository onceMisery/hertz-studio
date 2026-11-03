(function () {
  'use strict';

  var BANDS = 64;
  var ZERO = new Float32Array(BANDS);
  var host = document.getElementById('host');
  // Issued once by the native controller; public configuration cannot replace this identity.
  var nativeBinding = window.__hertzWallpaperBinding || null;
  var firstFrameKind = null;
  var revealed = !nativeBinding;
  var revealReceiptSent = false;
  if (nativeBinding && host) host.style.visibility = 'hidden';
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
    params: {},
    musicResponse: true,
    audioInput: { kind: 'hertz', gain: 1, attackMs: 40, releaseMs: 250 },
    brightness: 1,
    motion: 1,
    pointer: false,
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
  var pendingCapture = null;
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
  var nativePointer = window.__hertzWallpaperNativePointer === true;
  var reducedPointer = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var pointer = { active: false, x: 0.5, y: 0.5, at: 0, emittedAt: -Infinity, clickSerial: 0 };
  var pointerWaves = [], pointerCanvas = null, pointerContext = null, pointerRaf = 0, pointerFrames = 0;
  var pointerMoves = 0, pointerClicks = 0, localClickSerial = 0;

  function pointerAllowed() {
    var params = config.source === 'follow' && followSpace ? followSpace.params : config.params;
    return enabled && config.pointer && config.motion > 0 && !lost && !document.hidden
      && !(reducedPointer && reducedPointer.matches) && !(params && params.reduced)
      && (media ? media.state === 'ready' : mounted);
  }

  function clearPointer() {
    pointer.active = false;
    pointer.emittedAt = -Infinity;
    pointerWaves.length = 0;
    if (pointerRaf) cancelAnimationFrame(pointerRaf);
    pointerRaf = 0;
    pointerFrames = 0;
    if (pointerCanvas) pointerCanvas.remove();
    pointerCanvas = pointerContext = null;
  }

  function pointerSurface() {
    if (pointerCanvas) return true;
    pointerCanvas = document.createElement('canvas');
    pointerCanvas.id = 'wallpaper-pointer-effects';
    pointerCanvas.setAttribute('aria-hidden', 'true');
    pointerCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1';
    // A bounded transparent surface, including on 4K/high-DPI desktops.
    var scale = Math.min(window.devicePixelRatio || 1, 1.5, 1920 / innerWidth, 1080 / innerHeight);
    pointerCanvas.width = Math.max(1, Math.round(innerWidth * scale));
    pointerCanvas.height = Math.max(1, Math.round(innerHeight * scale));
    pointerContext = pointerCanvas.getContext('2d');
    if (!pointerContext) { clearPointer(); return false; }
    pointerContext.setTransform(scale, 0, 0, scale, 0, 0);
    host.appendChild(pointerCanvas);
    return true;
  }

  function addWave(x, y, now, click) {
    if (!pointerSurface()) return;
    if (pointerWaves.length >= 24) pointerWaves.shift();
    pointerWaves.push({ x: x, y: y, at: now, click: click });
  }

  function drawPointer(now) {
    if (!pointerAllowed()) { clearPointer(); return; }
    if (now - pointer.at > 250) pointer.active = false;
    if (!pointerContext) return;
    var ctx = pointerContext;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (var i = pointerWaves.length - 1; i >= 0; i--) {
      var wave = pointerWaves[i], age = (now - wave.at) / (wave.click ? 1100 : 780);
      if (age >= 1) { pointerWaves.splice(i, 1); continue; }
      var x = wave.x * innerWidth, y = wave.y * innerHeight;
      var fade = Math.pow(1 - age, 1.7);
      var radius = 4 + (wave.click ? 128 : 48) * (1 - Math.pow(1 - age, 2));
      var rings = wave.click ? 3 : 2;
      for (var ring = 0; ring < rings; ring++) {
        var r = radius - ring * (wave.click ? 15 : 8);
        if (r <= 1) continue;
        // Dark refraction edge and a narrow cool highlight stay legible on light and dark art.
        ctx.beginPath(); ctx.arc(x, y + 1.2, r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(5,25,38,' + fade * (wave.click ? 0.30 : 0.16) + ')';
        ctx.lineWidth = wave.click ? 3 : 2; ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(192,234,249,' + fade * (wave.click ? 0.72 : 0.36) / (1 + ring * 0.55) + ')';
        ctx.lineWidth = ring ? 0.8 : 1.3; ctx.stroke();
      }
      if (wave.click) {
        var glow = ctx.createRadialGradient(x, y, 0, x, y, Math.max(1, radius * 0.7));
        glow.addColorStop(0, 'rgba(205,240,255,' + fade * 0.13 + ')');
        glow.addColorStop(1, 'rgba(205,240,255,0)');
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y, radius * 0.7, 0, Math.PI * 2); ctx.fill();
        // A short spray makes a press distinct from the quieter movement wake.
        for (var dot = 0; dot < 8; dot++) {
          var angle = dot * Math.PI / 4 + 0.2;
          var distance = 8 + age * 92;
          ctx.beginPath(); ctx.arc(x + Math.cos(angle) * distance, y + Math.sin(angle) * distance + age * age * 18,
            Math.max(0.3, (1 - age) * 1.8), 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(220,245,255,' + fade * 0.72 + ')'; ctx.fill();
        }
      }
    }
  }

  function mediaPointerLoop(now) {
    pointerRaf = 0;
    if (!pointerAllowed() || !media) { clearPointer(); return; }
    if (++pointerFrames % gate.divisor === 0) drawPointer(now);
    if (pointerWaves.length) pointerRaf = requestAnimationFrame(mediaPointerLoop);
  }

  function applyPointer(snapshot) {
    if (!pointerAllowed()) { clearPointer(); return false; }
    var now = performance.now();
    if (!snapshot || snapshot.active !== true) { pointer.active = false; return false; }
    function coordinate(value) { return Number.isFinite(value) && value >= 0 && value <= 1; }
    if (!coordinate(snapshot.x) || !coordinate(snapshot.y)
      || (Number.isFinite(snapshot.pageDispatchMs) && now - snapshot.pageDispatchMs > 250)) {
      pointer.active = false; return false;
    }
    var dx = (snapshot.x - pointer.x) * innerWidth, dy = (snapshot.y - pointer.y) * innerHeight;
    if (!pointer.active || (Math.hypot(dx, dy) >= 10 && now - pointer.emittedAt >= 45)) {
      addWave(snapshot.x, snapshot.y, now, false);
      pointerMoves++;
      pointer.x = snapshot.x; pointer.y = snapshot.y; pointer.emittedAt = now;
    }
    pointer.active = true; pointer.at = now;
    var click = snapshot.click;
    if (click && Number.isSafeInteger(click.serial) && click.serial > pointer.clickSerial
      && coordinate(click.x) && coordinate(click.y)) {
      pointer.clickSerial = click.serial;
      addWave(click.x, click.y, now, true);
      pointerClicks++;
    }
    if (media && pointerWaves.length && !pointerRaf) pointerRaf = requestAnimationFrame(mediaPointerLoop);
    return true;
  }

  function localPointer(event) {
    if (nativePointer || event.isPrimary === false) return;
    var click = event.type === 'pointerdown';
    if (click && event.button !== 0) return;
    var x = event.clientX / innerWidth, y = event.clientY / innerHeight;
    applyPointer({ active: true, x: x, y: y, click: click ? { serial: ++localClickSerial, x: x, y: y } : null });
  }
  addEventListener('pointermove', localPointer);
  addEventListener('pointerdown', localPointer);
  addEventListener('pointerout', function (event) { if (!nativePointer && !event.relatedTarget) pointer.active = false; });
  addEventListener('blur', function () { if (!nativePointer) clearPointer(); });
  addEventListener('pagehide', clearPointer);
  if (reducedPointer && reducedPointer.addEventListener) reducedPointer.addEventListener('change', clearPointer);
  if (document.addEventListener) document.addEventListener('visibilitychange', clearPointer);
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

  var systemAudio = { valid: false, generation: 0, seq: 0, bands: new Float32Array(BANDS), ageMs: 0, receivedAt: 0 };
  var audioTarget = new Float32Array(BANDS), audioShaped = new Float32Array(BANDS), audioShapedAt = null;

  function resetAudio() {
    systemAudio.valid = false;
    systemAudio.bands.fill(0);
    audioShaped.fill(0);
    audioShapedAt = null;
  }

  // A distinct native input: it never creates track, transport or playback-clock metadata.
  function applyAudio(snapshot) {
    if (config.audioInput.kind !== 'system' || !snapshot || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0 || snapshot.generation < systemAudio.generation
      || !Number.isSafeInteger(snapshot.seq) || snapshot.seq < 0) return false;
    var device = config.audioInput.device;
    var sourceKey = device && device.kind === 'fixed' ? 'fixed:' + device.id : 'default';
    if (snapshot.sourceKey != null && snapshot.sourceKey !== sourceKey) return false;
    var clear = snapshot.bands === null;
    if (!clear && (!Array.isArray(snapshot.bands) || snapshot.bands.length !== BANDS
      || !snapshot.bands.every(function (value) { return Number.isFinite(value) && value >= 0 && value <= 1; })
      || !Number.isFinite(snapshot.ageMs) || snapshot.ageMs < 0)) return false;
    if (snapshot.generation > systemAudio.generation) {
      resetAudio(); systemAudio.generation = snapshot.generation; systemAudio.seq = 0;
    }
    if (clear) { resetAudio(); return true; }
    if (snapshot.seq <= systemAudio.seq) return false;
    var now = performance.now();
    var age = snapshot.ageMs + (Number.isFinite(snapshot.pageDispatchMs) ? Math.max(0, now - snapshot.pageDispatchMs) : 0);
    systemAudio.seq = snapshot.seq;
    if (age >= 1000) { resetAudio(); return false; }
    systemAudio.valid = true;
    systemAudio.bands.set(snapshot.bands);
    systemAudio.ageMs = age;
    systemAudio.receivedAt = now;
    return true;
  }

  function sessionEvent(event, kind, positionMs, pauseToken) {
    if (!nativeBinding) return;
    var receipt = { sessionId: nativeBinding.sessionId, generation: nativeBinding.generation, event: event };
    if (kind) receipt.frameKind = kind;
    if (positionMs != null) receipt.positionMs = positionMs;
    if (pauseToken != null) receipt.pauseToken = pauseToken;
    notify('wallpaper_session ' + JSON.stringify(receipt));
  }

  function firstFrame(kind) {
    if (firstFrameKind) return;
    firstFrameKind = kind;
    sessionEvent('firstFrame', kind);
  }

  function reveal() {
    if (nativeBinding && !firstFrameKind) return false;
    if (host) host.style.visibility = 'visible';
    revealed = true;
    if (nativeBinding && !revealReceiptSent) {
      revealReceiptSent = true;
      requestAnimationFrame(function(){requestAnimationFrame(function(){sessionEvent('revealed');});});
    }
    return true;
  }

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
    if (window.ipc && window.ipc.postMessage) window.ipc.postMessage(message);
  }

  function captureFrame() {
    var request = pendingCapture;
    if (!request) return;
    pendingCapture = null;
    clearTimeout(request.timer);
    var receipt = { token: request.token, sessionId: request.sessionId, generation: request.generation, width: request.width, height: request.height };
    var target = null;
    try {
      var source = media ? media.el : canvas;
      if (!source || lost || (media && media.state !== 'ready')) throw new Error('capture_source_unavailable');
      target = document.createElement('canvas');target.width=request.width;target.height=request.height;
      var context = target.getContext('2d', { alpha:false, willReadFrequently:true });
      if (!context) throw new Error('capture_context_unavailable');
      context.fillStyle='#030405';context.fillRect(0,0,target.width,target.height);
      context.filter='brightness('+config.brightness+')';
      var sourceWidth=source.videoWidth||source.naturalWidth||source.width,sourceHeight=source.videoHeight||source.naturalHeight||source.height;
      if (!(sourceWidth>0&&sourceHeight>0)) throw new Error('capture_empty_source');
      if (media && media.fit!=='stretch') {
        var ratio=media.fit==='contain'?Math.min(target.width/sourceWidth,target.height/sourceHeight):Math.max(target.width/sourceWidth,target.height/sourceHeight);
        var width=sourceWidth*ratio,height=sourceHeight*ratio;
        context.drawImage(source,(target.width-width)/2,(target.height-height)/2,width,height);
      } else context.drawImage(source,0,0,target.width,target.height);
      if(pointerCanvas)context.drawImage(pointerCanvas,0,0,target.width,target.height);
      var rgba=context.getImageData(0,0,target.width,target.height).data,parts=[];
      for(var at=0;at<rgba.length;at+=32768)parts.push(String.fromCharCode.apply(null,rgba.subarray(at,at+32768)));
      receipt.rgba=btoa(parts.join(''));
    } catch(failure) { receipt.error=String(failure).slice(0,128); }
    finally { if(target){target.width=target.height=1;} }
    notify('wallpaper_capture '+JSON.stringify(receipt));
  }

  // Issued only after the native capture workspace and bitmap have been reserved.
  // GL readback runs directly after a real render, before its buffer is discarded.
  function requestCapture(request) {
    if (!nativeBinding || pendingCapture || !request || request.sessionId!==nativeBinding.sessionId || request.generation!==nativeBinding.generation
      || !/^[0-9a-f]{32}$/.test(request.token) || !Number.isInteger(request.width) || request.width<1 || request.width>960
      || !Number.isInteger(request.height) || request.height<1 || request.height>540) return false;
    pendingCapture=Object.assign({},request);
    pendingCapture.timer=setTimeout(function(){
      if(!pendingCapture||pendingCapture.token!==request.token)return;
      pendingCapture=null;
      notify('wallpaper_capture '+JSON.stringify({token:request.token,sessionId:request.sessionId,generation:request.generation,width:request.width,height:request.height,error:'capture_frame_timeout'}));
    },2000);
    if(media)requestAnimationFrame(captureFrame);
    return true;
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

  function audioState() { return config.audioInput.kind === 'system' ? systemAudio : feed; }

  function audioAge(now) {
    var state = audioState();
    return (state.ageMs == null ? 0 : state.ageMs) + (state.receivedAt == null ? 0 : Math.max(0, now - state.receivedAt));
  }

  function scenePlaying() {
    return config.audioInput.kind === 'system'
      ? systemAudio.valid && audioAge(performance.now()) < 1000
      : feed.valid && feed.playing;
  }

  function effectiveBands(now) {
    var state = audioState();
    if (!state.valid || config.musicResponse === false) return ZERO;
    var age = audioAge(now);
    if (age >= 1000) return ZERO;
    var gain = config.audioInput.gain * (age <= 500 ? 1 : (1000 - age) / 500);
    for (var i = 0; i < BANDS; i++) audioTarget[i] = Math.min(1, state.bands[i] * gain);
    return audioTarget;
  }

  function shapedAudio(now) {
    var target = effectiveBands(now);
    // Stale sources reach exact zero at one second, independent of the release setting.
    if (target === ZERO) { audioShaped.fill(0); audioShapedAt = now; return ZERO; }
    var dt = audioShapedAt == null ? 1000 / 60 : Math.min(250, Math.max(0, now - audioShapedAt));
    audioShapedAt = now;
    for (var i = 0; i < BANDS; i++) {
      var ms = target[i] > audioShaped[i] ? config.audioInput.attackMs : config.audioInput.releaseMs;
      audioShaped[i] += (target[i] - audioShaped[i]) * (ms > 0 ? 1 - Math.exp(-dt / ms) : 1);
    }
    return audioShaped;
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
    drawPointer(now);
    var frameDt = pendingDt;
    pendingDt = 0;
    var bands = shapedAudio(now);
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
      if (submitted === true) {
        draws++;
        firstFrame('gl');
        captureFrame();
      }
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
    if (window.HertzGlBudget && HertzGlBudget.limits) fps = Math.min(fps || cap, HertzGlBudget.limits.fps);
    cap = fps || cap;
    gate = computeGate(cap, config.refreshHz);
    resetGate();
    enabled = true;
    if (media) {
      cancelMediaPauseCheck(media);
      applyMediaMotion(); // 当前呈现是媒体：恢复播放，不重复挂场景
      return true;
    }
    if (!mounted && !switching) return mount();
    if (mounted && !lost) startLoop();
    return true;
  }

  function stop(pauseToken) {
    enabled = false;
    clearPointer();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (backend === 'zodiac' && mounted && zodiac) {
      zodiac.setTime({ time: sceneTime / 1000, playing: false });
    }
    applyMediaMotion();
    if (media) checkMediaPaused(media, pauseToken);
  }

  function onLost(event) {
    if (event) event.preventDefault();
    lost = true;
    clearPointer();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    // The stopped frame loop cannot send its next heartbeat. Report loss now so
    // the native preview can retire its controller without waiting for staleness.
    notify('wallpaper_heartbeat ' + ticks + ' ' + draws + ' 0 1');
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
    canvas.width = canvas.height = 1;
    canvas.style.cssText = 'display:block;width:100%;height:100%';
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    host.appendChild(canvas);
  }

  function teardown() {
    clearPointer();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    selectToken++;
    if (canvas) {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
    }
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
    zodiac.setPrefs(Object.assign({}, config.params, { interactive: false }));
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
      if (id === 'zodiac' && params && zodiac) zodiac.setPrefs(Object.assign({}, params, { interactive: false }));
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
      if (window.HertzGlBudget) await HertzGlBudget.idle();
      if (token !== selectToken) return false;
      if (nextBackend === 'zodiac') {
        mountZodiac(initial);
        zodiac.setPrefs(Object.assign({}, params || config.params, { interactive: false }));
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
      if (nativeBinding || String(failure).includes('gl_budget:') || (window.HertzGlBudget && HertzGlBudget.stats().error)) {
        switching = false;
        notify('wallpaper_gl_failed ' + String(failure).slice(0, 220));
        return false;
      }
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
    var params = config.source === 'follow' && followSpace && canonicalScene(followSpace.scene) === id ? followSpace.params : config.params;
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
    if (config.source !== 'follow' || !mounted) return;
    var hasFollow = followSpace && allowedScene(canonicalScene(followSpace.scene));
    var id = hasFollow ? canonicalScene(followSpace.scene) : config.scene;
    var params = hasFollow ? followSpace.params : config.params;
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
        zodiac.setPrefs(Object.assign({}, params, { interactive: false }));
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

  function reportMediaPosition(record) {
    if (media !== record || record.kind !== 'video' || record.state !== 'ready' || !record.el || record.el.seeking) return;
    var position = Math.floor(record.el.currentTime * 1000);
    if (!Number.isSafeInteger(position) || position < 0 || position === record.reportedPosition) return;
    record.reportedPosition = position;
    sessionEvent('mediaPosition', null, position);
  }

  function cancelMediaPauseCheck(record) {
    if (record.pauseCheck) clearTimeout(record.pauseCheck.timer);
    record.pauseCheck = null;
  }

  function checkMediaPaused(record, token) {
    if (record.kind !== 'video' || record.state !== 'ready' || !record.el || !Number.isSafeInteger(token) || token <= 0) return;
    if (record.pauseCheck && record.pauseCheck.token === token) return;
    cancelMediaPauseCheck(record);
    var el = record.el;
    function sample() {
      var quality = typeof el.getVideoPlaybackQuality === 'function' ? el.getVideoPlaybackQuality() : null;
      return { time: el.currentTime, paused: el.paused === true,
        frames: quality && Number.isSafeInteger(quality.totalVideoFrames) ? quality.totalVideoFrames : null };
    }
    var check = { token: token, timer: 0, last: sample(), deadline: performance.now() + 1800 };
    record.pauseCheck = check;
    function verify() {
      if (media !== record || record.el !== el || record.pauseCheck !== check || record.state !== 'ready') return;
      var current = sample(), previous = check.last;
      if (current.paused && Number.isFinite(current.time) && Number.isFinite(previous.time)
        && Math.abs(current.time - previous.time) <= .001 && current.frames === previous.frames) {
        check.timer = 0;
        reportMediaPosition(record);
        sessionEvent('mediaPaused', null, null, token);
        return;
      }
      if (performance.now() >= check.deadline) { failMedia('media_pause_unconfirmed'); return; }
      check.last = current;
      check.timer = setTimeout(verify, 200);
    }
    check.timer = setTimeout(verify, 200);
  }

  // motion=0 或停用 → 视频冻结到当前帧（§10.1：不降 playbackRate 伪装静态）。
  function applyMediaMotion() {
    if (!media || media.kind !== 'video' || media.state !== 'ready' || !media.el) return;
    var record = media, el = record.el;
    var playAttempt = record.playAttempt = (record.playAttempt || 0) + 1;
    if (enabled && config.motion > 0) {
      var attempt = el.play();
      if (attempt && attempt.catch) attempt.catch(function () {
        if (media === record && record.el === el && record.playAttempt === playAttempt && enabled && config.motion > 0) failMedia('media_play_rejected');
      });
    } else {
      el.pause();
      reportMediaPosition(record);
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
    cancelMediaPauseCheck(record);
    var el = record.el;
    record.el = null;
    if (!el) return;
    try {
      if (record.kind === 'video') {
        if (record.frameCallback != null && typeof el.cancelVideoFrameCallback === 'function') {
          el.cancelVideoFrameCallback(record.frameCallback);
        }
        el.pause();
      }
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
    var resumeMs = desc.resumePositionMs == null ? 0 : desc.resumePositionMs;
    if (!kind || !Number.isSafeInteger(resumeMs) || resumeMs < 0 || (kind !== 'video' && resumeMs !== 0) || !MEDIA_URL.test(url) || url.split('/').slice(4).some(part => !part || part === '.' || part === '..') || !host) {
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
      reportMediaPosition(record);
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
        firstFrame('image');
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
      var seekStarted = false, resumeStarted = false;
      el.addEventListener('pause', function () { reportMediaPosition(record); });
      var markReady = function () {
        if (settled || token !== mediaToken || record.state !== 'loading') return;
        settled = true;
        clearTimeout(record.deadline);
        el.style.visibility = 'visible';
        record.state = 'ready';
        firstFrame('video');
        mediaReady();
        applyMediaMotion();
        reportMediaPosition(record);
      };
      // loadeddata proves metadata/data availability, never presentation of an actual frame.
      if (typeof el.requestVideoFrameCallback !== 'function') {
        failMedia('media_frame_callback_unsupported');
        return false;
      }
      function waitForFrame() {
        record.frameCallback = el.requestVideoFrameCallback(function (_, metadata) {
          if (token !== mediaToken || record.state !== 'loading') return;
          record.firstFrameTimeMs = metadata && Number.isFinite(metadata.mediaTime) ? metadata.mediaTime * 1000 : null;
          markReady();
        });
      }
      function playVideo() {
        var attempt = el.play();
        if (attempt && attempt.catch) attempt.catch(function () {
          if (settled || token !== mediaToken) return;
          failMedia('media_play_rejected');
        });
      }
      if (resumeMs > 0) {
        el.addEventListener('loadedmetadata', function () {
          if (token !== mediaToken || record.state !== 'loading' || seekStarted) return;
          if (!Number.isFinite(el.duration) || resumeMs >= el.duration * 1000) { failMedia('media_resume_out_of_range'); return; }
          seekStarted = true;
          try { el.currentTime = resumeMs / 1000; }
          catch (_) { failMedia('media_resume_seek_failed'); }
        });
        el.addEventListener('seeked', function () {
          if (token !== mediaToken || record.state !== 'loading' || !seekStarted || resumeStarted || el.seeking) return;
          if (Math.abs(el.currentTime * 1000 - resumeMs) > 1) { failMedia('media_resume_seek_failed'); return; }
          resumeStarted = true;
          // No first-frame callback or playback exists before this seek completes.
          // Register now so an earlier frame at the file's start cannot reveal the page.
          waitForFrame();
          playVideo();
        });
      }
      el.src = url;
      if (resumeMs === 0) { waitForFrame(); playVideo(); }
      else { el.preload = 'auto'; el.load(); }
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
    var previousParams = JSON.stringify(config.params);
    var nextSource = next.source === 'fixed' ? 'fixed' : 'follow';
    var previousAudio = JSON.stringify(config.audioInput);
    var input = next.audioInput;
    if (input && ['none', 'hertz', 'system'].includes(input.kind)) {
      config.audioInput = { kind: input.kind, device: input.device,
        gain: Number.isFinite(input.gain) ? Math.min(4, Math.max(0, input.gain)) : 1,
        attackMs: Number.isFinite(input.attackMs) ? Math.min(5000, Math.max(0, input.attackMs)) : 40,
        releaseMs: Number.isFinite(input.releaseMs) ? Math.min(10000, Math.max(0, input.releaseMs)) : 250 };
    } else if (typeof next.musicResponse === 'boolean') {
      config.audioInput.kind = next.musicResponse ? 'hertz' : 'none';
    }
    config.musicResponse = config.audioInput.kind !== 'none';
    if (previousAudio !== JSON.stringify(config.audioInput)) resetAudio();
    if (Number.isFinite(Number(next.brightness))) config.brightness = Math.min(1, Math.max(0.25, Number(next.brightness)));
    if (Number.isFinite(Number(next.motion))) config.motion = Math.min(1, Math.max(0, Number(next.motion)));
    if (typeof next.pointer === 'boolean') config.pointer = next.pointer;
    if (next.quality === 'low' || next.quality === 'medium' || next.quality === 'high') config.quality = next.quality;
    if (Number.isFinite(Number(next.refreshHz)) && Number(next.refreshHz) >= 5) config.refreshHz = Number(next.refreshHz);
    if (window.HertzGlBudget && HertzGlBudget.limits) {
      config.quality = HertzGlBudget.limits.quality;
      config.refreshHz = HertzGlBudget.limits.refreshHz;
    }
    var nextScene = allowedScene(next.scene) ? next.scene : config.scene;
    config.source = nextSource;
    config.scene = nextScene;
    config.params = next.params && typeof next.params === 'object' ? next.params : {};
    if (!pointerAllowed()) clearPointer();
    gate = computeGate(cap, config.refreshHz);
    resetGate();
    applyBrightness();
    if (zodiac && zodiac.setMotion && backend === 'zodiac') zodiac.setMotion({ active: motionActive() });
    applyMediaMotion();
    if (!mounted) return;
    if (previousQuality !== config.quality) {
      followSignature = '';
      var id = targetScene();
      selectScene(id, config.source === 'follow' && followSpace && allowedScene(canonicalScene(followSpace.scene)) ? followSpace.params : config.params, false, true);
      return;
    }
    if (nextSource === 'fixed') {
      if (previousSource !== 'fixed' || sceneId !== nextScene || previousParams !== JSON.stringify(config.params)) {
        followSignature = '';
        selectScene(nextScene, config.params, false, previousSource !== 'fixed');
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
      followSpace = null;
      if (config.source === 'follow') applyFollow();
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
      session: nativeBinding ? { sessionId: nativeBinding.sessionId, generation: nativeBinding.generation, frameKind: firstFrameKind, revealed: revealed } : null,
      source: config.source,
      musicResponse: config.musicResponse,
      audioSource: config.audioInput.kind,
      audioGeneration: systemAudio.generation,
      audioSequence: systemAudio.seq,
      audioFresh: audioState().valid && audioAge(Number.isFinite(now) ? now : performance.now()) < 1000,
      renderedAudioPeak: Math.max.apply(null, audioShaped),
      brightness: config.brightness,
      motion: config.motion,
      pointer: { enabled: config.pointer, active: pointer.active, waves: pointerWaves.length, moves: pointerMoves, clicks: pointerClicks, mediaAnimating: !!pointerRaf },
      quality: config.quality,
      glBudget: window.HertzGlBudget ? HertzGlBudget.stats() : null,
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
        firstFrameTimeMs: media.firstFrameTimeMs == null ? null : media.firstFrameTimeMs,
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
    clearPointer();
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
    applyAudio: applyAudio,
    applyPointer: applyPointer,
    applyConfig: applyConfig,
    applyMedia: applyMedia,
    start: start,
    stop: stop,
    mount: mount,
    reveal: reveal,
    unmount: unmount,
    debug: debug,
    requestCapture: requestCapture
  };

  notify('wallpaper_clock ' + performance.now());
  sessionEvent('pageHandshake');
  notify('wallpaper_dom_ready');
})();
