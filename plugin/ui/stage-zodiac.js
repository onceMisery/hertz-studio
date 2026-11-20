// SPDX-License-Identifier: MIT
// Zodiac retains its parameters, local interaction and reticle. The shared host
// consumes Stage frames and owns explicit retry, admission and lifecycle.
(function () {
  'use strict';
  var canvas = null, reticle = null, downgraded = false;
  var currentPrefs = { field: true, interactive: true, palette: null };
  function requestedQuality() {
    var tier = window.Stage && Stage.tier ? Stage.tier() : 2;
    return tier === 0 ? 'low' : tier === 1 ? 'medium' : 'high';
  }
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


  var host = StageSceneHost({
    id: 'zodiac', label: '星座舞台', engine: function () { return window.ZodiacStagePure; },
    requestedQuality: requestedQuality, quality: function () { return downgraded ? 'low' : requestedQuality(); },
    options: function () { return { interactive: currentPrefs.interactive, palette: currentPrefs.palette }; },
    apply: function () { ZodiacStagePure.setPrefs(currentPrefs); },
    afterMount: function (target, parent) {
      canvas = target; reticle = document.createElement('div'); reticle.className = 'zodiac-reticle';
      reticle.setAttribute('aria-hidden', 'true'); reticle.innerHTML = '<i></i>'; parent.appendChild(reticle); bindReticle();
    },
    beforeUnmount: function () { detachReticle(); canvas = null; }
  });
  function setPrefs(p) {
    if (!p) return;
    if (typeof p.field === 'boolean') currentPrefs.field = p.field;
    if (typeof p.interact === 'boolean') currentPrefs.interactive = p.interact;
    ['sign', 'glow', 'speed', 'reactivity', 'pointerStrength', 'meteors'].forEach(function (key) {
      if (p[key] !== undefined) currentPrefs[key] = p[key];
    });
    if (p.palette) currentPrefs.palette = {
      accent: p.palette.accentColor || p.palette.accent,
      secondary: p.palette.secondaryColor || p.palette.secondary,
      background: p.palette.backgroundColor || p.palette.background,
      ink: p.palette.primaryColor || p.palette.ink || '#f2f0e9',
      muted: p.palette.tertiaryColor || p.palette.muted
    };
    host.apply(); if (!currentPrefs.interactive) hideReticle();
  }
  document.addEventListener('stage:fps', function (event) {
    if (!event.detail || !event.detail.lowfx || downgraded) return;
    downgraded = true; if (host.stats().mounted) host.retry();
  });
  window.StageZodiac = {
    available: host.available, setHost: host.setHost, retry: host.retry, stats: host.stats,
    degradedBecause: host.degradedBecause, setRig: host.setRig, setPrefs: setPrefs,
    setInteraction: function (value) { currentPrefs.interactive = !!value; host.apply(); if (!value) hideReticle(); }
  };
}());
