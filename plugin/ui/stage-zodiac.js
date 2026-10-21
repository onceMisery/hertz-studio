// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// 「星座 · 十二星图」粒子舞台适配层。职责边界：场景渲染全部在
// vendor/zodiac-stage.js（ZodiacStagePure，不感知宿主）；本文件负责一切
// hertz-studio 集成 —— 挂载/卸载、播放时钟接驳（Stage.presentation）、
// 频谱与起音（Stage.spectrum + Onset）、画质降档（stage:fps 只降不升）、
// reduced-motion、画布尺寸跟随、GL 上下文丢失恢复。
// 与海岸舞台同构：星座不接管歌词，歌词由 stage3d 的叠加层照常演出。
//
// Stage3D 的调用面：
//   StageZodiac.available()        入口置灰判断（探测 WebGL2，带缓存）
//   StageZodiac.setHost(el|null)   挂进宿主层 / 卸载；返回是否成功
//   StageZodiac.setPrefs(p)        { field, interact, palette } 即时生效
//   StageZodiac.setRig(pose, opts)  注入机位；null 交回内部巡航（见引擎契约）
//   StageZodiac.setInteraction(v)   把指针所有权交给空间层 / 交回场景
//   StageZodiac.degradedBecause()  最近一次挂载失败的原因，null 为可用
(function () {
  'use strict';

  var probeCache = null;
  var reason = null;
  var host = null;
  var canvas = null;
  var reticle = null;
  var mounted = false;
  var quality = 'high';
  var downgraded = false;   // stage:fps 只降不升
  var raf = 0;
  var lastTick = 0;
  var lastW = 0, lastH = 0;
  var currentRig = null, currentRigOptions = null;
  var ZEROS = new Float32Array(64);

  // —— GL 上下文丢失恢复（与 stage3d.js 主画布、stage-coast 同策略）—— //
  var RECOVERY_GRACE_MS = 1500;      // 先等浏览器自己的 restored（three 可自愈）
  var RECOVERY_DELAYS = [800, 1600, 3000];
  var RECOVERY_WINDOW_MS = 60000;
  var RECOVERY_MAX = 4;
  var ctxLost = false;
  var graceTimer = 0, retryTimer = 0;
  var retries = 0;
  var recoveryAt = [];

  function emitCtx(state) {
    try {
      document.dispatchEvent(new CustomEvent('stage:scene-context',
        { detail: { source: 'zodiac', state: state } }));
    } catch (_) { /* 无 CustomEvent 的老环境静默：不影响播放 */ }
  }

  function clearRecoveryTimers() {
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = 0; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = 0; }
  }

  // 宽限期满上下文仍是死的：换一张新画布重挂（旧画布的上下文已经救不回）。
  function rebuildAfterLoss() {
    graceTimer = 0;
    if (!ctxLost || !mounted || !host) return;
    var ok = false;
    try { ZS().unmount(); } catch (_) { /* 死上下文上释放资源：three 会静默 */ }
    detachContextWatch();
    detachReticle();
    if (canvas) { canvas.remove(); canvas = null; }
    ok = mountInto(host);
    if (ok) {
      ctxLost = false;
      retries = 0;
      reason = null;
      emitCtx('recovered');
      return;
    }
    if (retries < RECOVERY_DELAYS.length) {
      retryTimer = setTimeout(rebuildAfterLoss, RECOVERY_DELAYS[retries]);
      retries += 1;
    } else {
      reason = '星座舞台的图形上下文未能恢复，请切回沉浸声场或重新打开舞台';
      emitCtx('failed');
    }
  }

  function onContextLost(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (ctxLost || !mounted || !host) return;
    var now = Date.now();
    recoveryAt = recoveryAt.filter(function (t) { return now - t < RECOVERY_WINDOW_MS; });
    if (recoveryAt.length >= RECOVERY_MAX) {
      ctxLost = true;
      reason = '星座舞台的图形上下文反复丢失，已停止自动恢复，请切回沉浸声场';
      emitCtx('failed');
      return;
    }
    recoveryAt.push(now);
    ctxLost = true;
    retries = 0;
    reason = '星座舞台的图形上下文丢失，正在自动恢复';
    emitCtx('lost');
    graceTimer = setTimeout(rebuildAfterLoss, RECOVERY_GRACE_MS);
  }

  function onContextRestored() {
    if (!ctxLost) return;
    ctxLost = false;
    clearRecoveryTimers();
    retries = 0;
    reason = null;
    emitCtx('recovered');
  }

  function attachContextWatch() {
    if (!canvas) return;
    canvas.addEventListener('webglcontextlost', onContextLost, false);
    canvas.addEventListener('webglcontextrestored', onContextRestored, false);
  }

  function detachContextWatch() {
    if (canvas) {
      canvas.removeEventListener('webglcontextlost', onContextLost, false);
      canvas.removeEventListener('webglcontextrestored', onContextRestored, false);
    }
    clearRecoveryTimers();
  }

  function ZS() { return window.ZodiacStagePure; }

  function available() {
    if (probeCache === null) probeCache = !!(ZS() && ZS().probe && ZS().probe());
    return probeCache;
  }

  function degradedBecause() { return reason; }

  // 每帧：读频谱 → 起音 → 推给引擎；播放时钟同步；画布尺寸跟随。
  function tick(now) {
    raf = requestAnimationFrame(tick);
    var dt = lastTick ? Math.min(now - lastTick, 100) : 0;
    lastTick = now;
    if (!mounted) return;
    var Stage = window.Stage;
    var spectrum = (Stage && Stage.spectrum && Stage.spectrum()) || null;
    // 静音/暂停时喂零谱，让能量自然回落到环境基线，而不是停在旧值。
    onset.step(dt || 16, spectrum && spectrum.length ? spectrum : ZEROS, now);
    ZS().setAudio({ bands: spectrum, onset: onset.pulse > 0.45 });
    var present = Stage && Stage.presentation ? Stage.presentation() : null;
    ZS().setTime({ time: present ? (present.position || 0) / 1000 : 0, playing: !!(present && present.playing) });
    var w = host.clientWidth, h = host.clientHeight;
    if (w && h && (w !== lastW || h !== lastH)) {
      lastW = w; lastH = h;
      ZS().resize(w, h);
    }
  }

  // onset.js 以 defer 先于本文件加载，这里一定拿得到；兜底桩保证缺依赖时
  // 也只是没有音频反应，而不是每帧抛错。
  var onset = window.Onset
    ? window.Onset.create({})
    : { step: function () {}, pulse: 0 };

  // 初始画质档接 Stage.tier（0/1/2）：弱设备直接低档起步，不等 stage:fps
  // 降级。stage:fps lowfx 仍只降不升。
  function qualityForMount() {
    if (downgraded) return 'low';
    try {
      var tier = window.Stage && window.Stage.tier ? window.Stage.tier() : 2;
      if (tier === 0) return 'low';
      if (tier === 1) return 'medium';
    } catch (_) { /* tier 不可用按高档 */ }
    return 'high';
  }

  // 独立舞台没有 Space3D 的观测题签，用一枚跟手的能量准星补上「指针已经
  // 接管舞台」的反馈：按住时星环收紧，松开后由引擎的冲击波接棒。
  function reticleAt(e) {
    if (!reticle || !canvas) return;
    var rect = canvas.getBoundingClientRect();
    reticle.style.transform = 'translate3d(' + (e.clientX - rect.left) + 'px,'
      + (e.clientY - rect.top) + 'px,0)';
  }
  function hideReticle() {
    if (reticle && reticle.classList) reticle.classList.remove('is-on', 'is-charging');
  }
  function onReticleMove(e) {
    if (!currentPrefs.interactive || !reticle || !reticle.classList) return;
    reticle.classList.add('is-on');
    reticleAt(e);
  }
  function onReticleDown(e) {
    if (!currentPrefs.interactive || !reticle || !reticle.classList) return;
    reticle.classList.add('is-on', 'is-charging');
    reticleAt(e);
  }
  function onReticleUp() {
    if (reticle && reticle.classList) reticle.classList.remove('is-charging');
  }
  function onReticleLeave() {
    hideReticle();
  }
  function bindReticle() {
    if (!canvas || !reticle) return;
    canvas.addEventListener('pointermove', onReticleMove, false);
    canvas.addEventListener('pointerdown', onReticleDown, false);
    canvas.addEventListener('pointerleave', onReticleLeave, false);
    if (window.addEventListener) window.addEventListener('pointerup', onReticleUp, false);
  }
  function detachReticle() {
    if (canvas) {
      canvas.removeEventListener('pointermove', onReticleMove, false);
      canvas.removeEventListener('pointerdown', onReticleDown, false);
      canvas.removeEventListener('pointerleave', onReticleLeave, false);
    }
    if (window.removeEventListener) window.removeEventListener('pointerup', onReticleUp, false);
    if (reticle && reticle.parentNode) reticle.parentNode.removeChild(reticle);
    reticle = null;
  }

  function mountInto(el) {
    var w = el.clientWidth || 640, h = el.clientHeight || 360;
    canvas = document.createElement('canvas');
    canvas.className = 'zodiac-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    el.appendChild(canvas);
    reticle = document.createElement('div');
    reticle.className = 'zodiac-reticle';
    reticle.setAttribute('aria-hidden', 'true');
    reticle.innerHTML = '<i></i>';
    el.appendChild(reticle);
    bindReticle();
    lastW = w; lastH = h;
    quality = qualityForMount();
    var ok = ZS().mount(canvas, {
      quality: quality,
      reduced: window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      interactive: currentPrefs.interactive,
      palette: currentPrefs.palette,
    });
    if (!ok) {
      detachReticle();
      canvas.remove();
      canvas = null;
      reason = '当前环境无法运行星座舞台（需要 WebGL2）';
      return false;
    }
    reason = null;
    ZS().resize(w, h);
    ZS().setPrefs({
      field: currentPrefs.field,
      interactive: currentPrefs.interactive, palette: currentPrefs.palette,
    });
    if (currentRig) ZS().setRig(currentRig, currentRigOptions);
    mounted = true;
    attachContextWatch();
    return true;
  }

  var currentPrefs = { field: true, interactive: true, palette: null };

  function setHost(el) {
    if (el === host) return !el || mounted;
    host = el;
    if (!el) {
      currentRig = null;
      currentRigOptions = null;
      if (mounted) {
        cancelAnimationFrame(raf);
        raf = 0;
        mounted = false;
        ctxLost = false;
        detachContextWatch();
        ZS().unmount();
      }
      detachReticle();
      if (canvas) { canvas.remove(); canvas = null; }
      reason = null;
      return true;
    }
    if (!available()) {
      reason = '当前环境无法运行星座舞台（需要 WebGL2）';
      return false;
    }
    if (!mountInto(el)) return false;
    if (!raf) {
      lastTick = 0;
      raf = requestAnimationFrame(tick);
    }
    return true;
  }

  function setPrefs(p) {
    if (!p) return;
    if (typeof p.field === 'boolean') currentPrefs.field = p.field;
    if (typeof p.interact === 'boolean') currentPrefs.interactive = p.interact;
    if (p.palette) {
      currentPrefs.palette = {
        accent: p.palette.accentColor || p.palette.accent,
        secondary: p.palette.secondaryColor || p.palette.secondary,
        background: p.palette.backgroundColor || p.palette.background,
        ink: p.palette.primaryColor || p.palette.ink || '#f2f0e9',
        muted: p.palette.tertiaryColor || p.palette.muted,
      };
    }
    if (mounted) ZS().setPrefs(currentPrefs);
    // 关闭「交互旋转」时准星必须立刻收掉，避免指针已经交回宿主还残留一个准星。
    if (!currentPrefs.interactive) hideReticle();
  }

  function setRig(pose, opts) {
    currentRig = pose ? Object.assign({}, pose) : null;
    if (currentRig && Array.isArray(pose.position)) currentRig.position = pose.position.slice();
    currentRigOptions = opts ? Object.assign({}, opts) : null;
    if (mounted) ZS().setRig(currentRig, currentRigOptions);
  }

  function setInteraction(value) {
    currentPrefs.interactive = !!value;
    if (mounted) ZS().setInteraction(currentPrefs.interactive);
    if (!currentPrefs.interactive) hideReticle();
  }

  // 舞台帧门测得吃不住（lowfx）就降到流畅档重建一次；之后不再回升级。
  document.addEventListener('stage:fps', function (e) {
    if (!e.detail || !e.detail.lowfx || downgraded || !mounted) return;
    downgraded = true;
    quality = 'low';
    if (host) {
      ZS().unmount();
      detachContextWatch();
      detachReticle();
      if (canvas) { canvas.remove(); canvas = null; }
      mounted = mountInto(host);
    }
  });

  window.StageZodiac = {
    available: available,
    setHost: setHost,
    setPrefs: setPrefs,
    setRig: setRig,
    setInteraction: setInteraction,
    degradedBecause: degradedBecause,
  };
}());
