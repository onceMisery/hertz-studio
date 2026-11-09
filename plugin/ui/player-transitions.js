(function (global) {
  'use strict';

  // The Stage facade includes native parent-window suspension. Standalone consumers keep browser visibility.
  function documentHidden() {
    var stage = window.Stage;
    return stage && typeof stage.isDocumentHidden === "function" ? stage.isDocumentHidden() : !!document.hidden;
  }
  var key = 'vmusic.player.transitions.v1', effects = ['zoom', 'flip', 'fade', 'off'];
  var DEFAULT_DURATION = 600, DURATION_MARKER = 'vmusic.player.transitions.duration600';
  var prefs, current = null, media = global.matchMedia('(prefers-reduced-motion: reduce)');
  var ease = 'cubic-bezier(.4, 0, .2, 1)';
  function read() {
    var saved;
    try { saved = JSON.parse(localStorage.getItem(key)); } catch (_) {}
    prefs = {};
    var onboarded = true;
    try { onboarded = localStorage.getItem(DURATION_MARKER) !== null; } catch (_) {}
    var migrated = false;
    ['cover', 'stage'].forEach(function (kind) {
      var value = saved && saved[kind];
      var duration = value && typeof value.duration === 'number' && Number.isFinite(value.duration)
        ? Math.round(Math.max(200, Math.min(1500, value.duration)) / 50) * 50 : DEFAULT_DURATION;
      // 旧默认 1000 和手选分不出来：只迁移一次旧默认；落标记后再选 1000 视为明确选择。
      if (!onboarded && duration === 1000) { duration = DEFAULT_DURATION; migrated = true; }
      prefs[kind] = {
        effect: value && effects.indexOf(value.effect) !== -1 ? value.effect : 'zoom',
        duration: duration
      };
    });
    if (!onboarded) {
      try {
        localStorage.setItem(DURATION_MARKER, '1');
        if (migrated) localStorage.setItem(key, JSON.stringify(prefs));
      } catch (_) {}
    }
  }
  function reduced() { return media.matches || document.body.classList.contains('reduce-motion'); }
  function cancel(kind) {
    if (!current || kind && current.kind !== kind) return;
    var previous = current; current = null;
    previous.animations.forEach(function (animation) { animation.cancel(); });
    if (previous.ghost) previous.ghost.remove();
    if (previous.source) previous.source.node.style.visibility = previous.source.visibility;
    document.body.classList.remove('player-entering');
  }
  function animate(session, node, frames, name, easing) {
    var animation = node.animate(frames, { duration: prefs[session.kind].duration, easing: easing || ease, fill: 'both' });
    animation.id = 'player-transition-' + name;
    session.animations.push(animation);
  }
  function begin(kind) {
    cancel();
    if (reduced() || prefs[kind].effect === 'off' || typeof document.body.animate !== 'function') return null;
    current = { kind: kind, animations: [] };
    return current;
  }
  function complete(session) {
    Promise.all(session.animations.map(function (animation) { return animation.finished; })).then(function () {
      if (current === session) cancel();
    }, function () { if (current === session) cancel(); });
  }
  function capture(node) {
    if (!node || reduced() || prefs.cover.effect === 'off') return null;
    var rect = node.getBoundingClientRect(), style = getComputedStyle(node);
    if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= global.innerHeight
        || style.visibility === 'hidden' || style.backgroundImage === 'none') return null;
    return { node: node, rect: rect, image: style.backgroundImage, size: style.backgroundSize,
      position: style.backgroundPosition, radius: parseFloat(style.borderRadius) || 0, visibility: node.style.visibility };
  }
  function openPlayer(source) {
    var session = begin('cover'); if (!session) return;
    var modal = document.getElementById('np-modal'), art = document.getElementById('np-art');
    var target = art.getBoundingClientRect(), effect = prefs.cover.effect;
    document.body.classList.add('player-entering');
    animate(session, modal, [{ opacity: 0 }, { opacity: 0, offset: .3 }, { opacity: 1, offset: .84 }, { opacity: 1 }], 'page', 'linear');
    animate(session, document.getElementById('np-scrim'), [{ opacity: 0 }, { opacity: 1 }], 'scrim');
    if (source && target.width && target.height) {
      if (effect === 'fade') {
        var size = Math.max(global.innerWidth, global.innerHeight);
        target = { left: (global.innerWidth - size) / 2, top: (global.innerHeight - size) / 2, width: size, height: size };
      }
      var ghost = document.createElement('div');
      ghost.className = 'player-transition-cover'; ghost.setAttribute('aria-hidden', 'true');
      var style = ghost.style, scaleX = source.rect.width / target.width, scaleY = source.rect.height / target.height;
      style.left = target.left + 'px'; style.top = target.top + 'px';
      style.width = target.width + 'px'; style.height = target.height + 'px';
      style.backgroundImage = source.image; style.backgroundSize = source.size; style.backgroundPosition = source.position;
      style.borderRadius = effect === 'fade' ? '0px' : getComputedStyle(art).borderRadius;
      // Fullscreen only paints descendants of its own element.
      (document.fullscreenElement || document.body).appendChild(ghost);
      session.ghost = ghost; session.source = source; source.node.style.visibility = 'hidden';
      var start = 'translate(' + (source.rect.left - target.left) + 'px,' + (source.rect.top - target.top) + 'px) scale(' + scaleX + ',' + scaleY + ')';
      var frames = [{ transform: start, borderRadius: source.radius / scaleX + 'px', opacity: 1 }];
      if (effect === 'fade') frames.push({ opacity: .8, offset: .75 });
      else {
        // Land before handing over the image: the real cover brings its own material/shadow.
        frames[0].easing = 'cubic-bezier(.4, 0, .4, 1)';
        frames.push({ transform: 'translate(0,0) scale(1)', borderRadius: style.borderRadius, opacity: 1, offset: .84 });
      }
      frames.push({ transform: 'translate(0,0) scale(1)', borderRadius: style.borderRadius, opacity: 0 });
      animate(session, ghost, frames, 'cover', effect === 'fade' ? ease : 'linear');
      if (effect === 'flip') {
        style.backgroundImage = 'none'; style.perspective = '1200px';
        var turn = document.createElement('div'); turn.className = 'player-transition-turn';
        ['front', 'back'].forEach(function (side) {
          var face = document.createElement('div'); face.className = 'player-transition-face player-transition-' + side;
          face.style.backgroundImage = source.image; face.style.backgroundSize = source.size; face.style.backgroundPosition = source.position;
          turn.appendChild(face);
        });
        ghost.appendChild(turn);
        animate(session, turn, [
          { transform: 'rotateY(0deg)', easing: 'cubic-bezier(.35, 0, .65, 1)' },
          { transform: 'rotateY(-360deg)', offset: .84 }, { transform: 'rotateY(-360deg)' }
        ], 'flip', 'linear');
      }
      animate(session, art, effect === 'fade'
        ? [{ opacity: 0 }, { opacity: 0, offset: .55 }, { opacity: 1, offset: .9 }, { opacity: 1 }]
        : [{ opacity: 0 }, { opacity: 0, offset: .76 }, { opacity: 1, offset: .84 }, { opacity: 1 }], 'art', 'linear');
    }
    complete(session);
  }
  function openStage(root) {
    var session = begin('stage'); if (!session) return;
    var effect = prefs.stage.effect;
    // Fullscreen forces transform:none; individual scale/rotate properties remain animatable.
    animate(session, root, [
      { opacity: 0, scale: effect === 'zoom' ? '.68' : effect === 'flip' ? '.8' : '.9', rotate: effect === 'flip' ? 'y -100deg' : 'y 0deg' },
      { opacity: 1, scale: '1', rotate: 'y 0deg' }
    ], 'stage');
    complete(session);
  }
  function sync() {
    ['cover', 'stage'].forEach(function (kind) {
      var select = document.getElementById('player-' + kind + '-transition');
      var slider = document.getElementById('player-' + kind + '-duration');
      select.value = prefs[kind].effect; slider.value = prefs[kind].duration;
      slider.disabled = prefs[kind].effect === 'off';
      document.getElementById('player-' + kind + '-duration-value').textContent = prefs[kind].duration + ' ms';
    });
  }
  function init() {
    read(); sync();
    ['cover', 'stage'].forEach(function (kind) {
      function change() {
        cancel();
        prefs[kind].effect = document.getElementById('player-' + kind + '-transition').value;
        prefs[kind].duration = Number(document.getElementById('player-' + kind + '-duration').value);
        try { localStorage.setItem(key, JSON.stringify(prefs)); } catch (_) {}
        sync();
      }
      document.getElementById('player-' + kind + '-transition').addEventListener('change', change);
      document.getElementById('player-' + kind + '-duration').addEventListener('input', change);
    });
    document.getElementById('stage3d').classList.add('player-transition-ready');
    media.addEventListener('change', function () { if (reduced()) cancel(); });
    new MutationObserver(function () { if (reduced()) cancel(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    global.addEventListener('resize', function () { cancel('cover'); });
    document.addEventListener('fullscreenchange', function () { cancel('cover'); });
    document.addEventListener('playback:track', function () { cancel('cover'); });
    document.addEventListener('visibilitychange', function () { if (documentHidden()) cancel(); });
    global.addEventListener('storage', function (event) { if (event.key === key || event.key === null) { cancel(); read(); sync(); } });
  }
  global.PlayerTransitions = { init: init, capture: capture, openPlayer: openPlayer, openStage: openStage, cancel: cancel };
})(window);
