// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// Space3D presentation adapter. StageLyrics owns token timing; Backgrounds owns
// generators/media; the host owns the clock/audio/camera. This module owns only
// bounded CSS-3D geometry and its temporary background placement.
(function (global) {
  'use strict';
  var TAU = Math.PI * 2;
  var MAX_DUST = 72, RING_BARS = 64, RIPPLE_POOL = 6, WALL_PANELS = 16;
  var THEMES = [['venue', '第一现场'], ['diorama', '纸雕剧场'], ['tempo', '节拍律动'], ['still', '静帧']];
  var CONTROLS = [
    { key: 'stagePreset', label: '舞台主题', type: 'select', def: 'venue', options: THEMES },
    { key: 'karaoke', label: '逐字擦除', type: 'toggle', def: false },
    { key: 'discRing', label: '环绕频谱', type: 'toggle', def: false },
    { key: 'dust', label: '空间光尘', type: 'range', def: 0, min: 0, max: 100, step: 5, unit: '%' },
    { key: 'ripples', label: '节拍涟漪', type: 'range', def: 0, min: 0, max: 100, step: 5, unit: '%' },
    { key: 'bgwall', label: '环绕背景墙', type: 'toggle', def: false }
  ];
  var BACKGROUNDS = [
    { key: 'type', label: '背景画面', type: 'select', def: 'theme', options: [
      ['theme', '跟随主题'], ['mesh', '渐变网格'], ['flow', '流场'],
      ['spectrogram', '频谱色谱'], ['cover', '封面取色'], ['media', '我的图片 / 视频']] },
    { key: 'blend', label: '融合方式', type: 'select', def: 'normal', options: [
      ['normal', '正常'], ['screen', '滤色'], ['overlay', '叠加'], ['soft-light', '柔光'], ['lighten', '变亮']] },
    { key: 'opacity', label: '不透明度', type: 'range', min: 0, max: 100, step: 1, unit: '%' },
    { key: 'blur', label: '模糊', type: 'range', min: 0, max: 60, step: 1, unit: 'px' },
    { key: 'hue', label: '色相偏移', type: 'range', min: 0, max: 360, step: 5, unit: '°' },
    { key: 'rate', label: '视频速度', type: 'range', def: .75, min: .25, max: 2, step: .05, unit: '×' }
  ];
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function finite(value, fallback) { return typeof value === 'number' && isFinite(value) ? value : fallback; }
  function clamp(value, lo, hi) { return Math.max(lo, Math.min(hi, value)); }
  function defaults() {
    var out = {}; CONTROLS.forEach(function (item) { out[item.key] = item.def; }); return out;
  }
  function normalize(value) {
    var out = defaults(), input = value || {};
    CONTROLS.forEach(function (item) {
      var v = input[item.key];
      if (v === undefined) return;
      if (item.type === 'toggle') out[item.key] = v === true || v === 1;
      else if (item.type === 'range') out[item.key] = clamp(finite(v, item.def), item.min, item.max);
      else if (item.options.some(function (option) { return option[0] === v; })) out[item.key] = v;
    });
    return out;
  }
  function element(tag, className, parent) {
    var el = document.createElement(tag); el.className = className;
    if (parent) parent.appendChild(el); return el;
  }
  function empty(el) { while (el.children.length) el.children[0].remove(); }
  function px(value) { return value.toFixed(2) + 'px'; }
  function seed(index, salt) {
    var x = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453; return x - Math.floor(x);
  }

  function create(root) {
    if (!root) return null;
    var disposed = false, prefs = defaults(), time = 0, inputTime = null;
    var lastBeat = 0, lastRipple = -10, rippleIndex = 0, wallElapsed = 1000, wallDirty = true;
    var width = 0, height = 0, worldUnit = 1, wallReady = false, warning = '';
    var points = [], bars = [], rings = [], panels = [], lastEnv = {}, backgroundKey = '';
    var sourceKey = '', sourceElement = null, unsubscribeSource = null;
    var spectrum = new Float32Array(RING_BARS), audioReady = false, energy = 0;
    var owner = global.Backgrounds || null;
    var background = document.getElementById('creative-bg');
    var previousParent = background && background.parentNode;
    var previousNext = background && background.nextSibling;
    var previousHost = owner && owner.stats && owner.stats().host !== 'home' ? previousParent : null;
    var bgHost = root.querySelector('#sp-bg') || root;
    var priorTheme = root.dataset.spaceTheme, priorKaraoke = root.classList.contains('sp-karaoke');
    var overlay = element('div', 'sp-layers', root);
    overlay.setAttribute('aria-hidden', 'true');
    var world = element('div', 'sp-layer-world', overlay);
    var ringHost = element('div', 'sp-disc-ring sp-layer-group', world);
    var dustHost = element('div', 'sp-dust sp-layer-group', world);
    var rippleHost = element('div', 'sp-ripples sp-layer-group', world);
    var wallHost = element('div', 'sp-wall', bgHost);
    wallHost.setAttribute('aria-hidden', 'true');
    var wallWorld = element('div', 'sp-wall-world', wallHost);
    var status = element('div', 'sp-layer-status', root);
    status.setAttribute('role', 'status'); status.hidden = true;

    // Suspend BgWall before any space source acquires graphics. Neither the
    // existing media URL nor the configured depth is changed by moving its host.
    if (owner && owner.setStageState) owner.setStageState({ paused: true, reduced: false, flat: true, timeSec: 0 });
    if (owner && owner.setStageHost) owner.setStageHost(bgHost);

    function showStatus(message) {
      if (status.textContent !== message) status.textContent = message;
      status.hidden = !message;
    }
    function rebuild() {
      root.dataset.spaceTheme = prefs.stagePreset;
      root.classList.toggle('sp-karaoke', prefs.karaoke);
      var wanted = prefs.dust ? Math.max(8, Math.round(MAX_DUST * prefs.dust / 100)) : 0;
      if (points.length !== wanted) {
        empty(dustHost); points = [];
        for (var i = 0; i < wanted; i++) {
          var point = element('span', 'sp-dust-point', dustHost);
          points.push({ el: point, x: seed(i, 1) * 2 - 1, y: seed(i, 2), z: seed(i, 3) * 2 - 1,
            speed: .017 + seed(i, 4) * .027, size: .8 + seed(i, 5) * 2 });
        }
      }
      if (!!bars.length !== prefs.discRing) {
        empty(ringHost); bars = [];
        if (prefs.discRing) {
          element('span', 'sp-disc-orbit', ringHost);
          for (i = 0; i < RING_BARS; i++) bars.push(element('span', 'sp-disc-bar', ringHost));
        }
      }
      if (!!rings.length !== !!prefs.ripples) {
        empty(rippleHost); rings = [];
        if (prefs.ripples) for (i = 0; i < RIPPLE_POOL; i++) {
          rings.push({ el: element('span', 'sp-ripple', rippleHost), born: -10 });
        }
      }
      if (!!panels.length !== prefs.bgwall) {
        empty(wallWorld); panels = [];
        if (prefs.bgwall) for (i = 0; i < WALL_PANELS; i++) {
          var panel = element('canvas', 'sp-wall-panel', wallWorld);
          panel.width = 64; panel.height = 512;
          panels.push({ el: panel, ctx: panel.getContext('2d') });
        }
        wallReady = false; wallDirty = true; width = 0;
      }
      dustHost.hidden = !points.length; ringHost.hidden = !bars.length; rippleHost.hidden = !rings.length;
      overlay.hidden = !points.length && !bars.length && !rings.length;
      wallHost.hidden = !prefs.bgwall;
      bgHost.classList.toggle('sp-has-wall', prefs.bgwall && wallReady);
    }

    function configure(value) {
      if (disposed) return copy(prefs);
      var merged = copy(prefs); Object.keys(value || {}).forEach(function (key) { merged[key] = value[key]; });
      prefs = normalize(merged); rebuild(); update(0, lastEnv); return copy(prefs);
    }

    function setBackground(spec) {
      if (disposed || !owner || !owner.update) return null;
      warning = ''; var result = owner.update(spec || { type: 'theme' });
      update(0, lastEnv); return result;
    }
    function setLocalFile(file) {
      if (disposed || !owner || !owner.setLocalFile || !file) return null;
      if (!/^(image|video)\//.test(file.type || '')) {
        warning = '请选择图片或视频文件'; showStatus(warning); return null;
      }
      warning = ''; var result = owner.setLocalFile(file);
      if (result && result.then) return result.then(function (spec) { update(0, lastEnv); return spec; });
      update(0, lastEnv); return result;
    }

    function resize() {
      var nextW = Math.max(1, root.clientWidth || 1707), nextH = Math.max(1, root.clientHeight || 898);
      if (nextW === width && nextH === height) return;
      width = nextW; height = nextH; worldUnit = Math.min(width, height);
      // Same cylinder proportions as BgWall: radius 10, half-span 1.42,
      // vertical span 15. CSS panels sample its existing source without a GL owner.
      var radius = Math.max(width * .85, height * 1.1), span = 1.42;
      var slice = span * 2 / WALL_PANELS, panelW = 2 * radius * Math.tan(slice / 2) + 1;
      var panelH = radius * 1.5;
      panels.forEach(function (panel, i) {
        var angle = -span + slice * (i + .5), st = panel.el.style;
        st.width = px(panelW); st.height = px(panelH);
        st.marginLeft = px(-panelW / 2); st.marginTop = px(-panelH / 2);
        st.transform = 'translate3d(' + px(Math.sin(angle) * radius) + ',0px,' + px(-Math.cos(angle) * radius) + ') rotateY(' + (-angle).toFixed(4) + 'rad)';
      });
      wallDirty = true;
    }

    function placeCamera(pose) {
      var p = pose || {}, rotation = p.world || {}, fov = clamp(finite(p.fov, 50), 26, 100);
      var perspective = height / (2 * Math.tan(fov * Math.PI / 360));
      overlay.style.perspective = px(perspective); wallHost.style.perspective = px(perspective);
      var yaw = finite(p.free ? p.yaw : p.theta, 0) + finite(rotation.y, 0);
      var pitch = finite(p.free ? p.pitch : p.phi, 0) + finite(rotation.x, 0);
      var transform = 'rotateZ(' + (-finite(p.roll, 0)).toFixed(4) + 'rad) rotateX(' + pitch.toFixed(4) + 'rad) rotateY(' + (-yaw).toFixed(4) + 'rad)';
      if (p.free && p.position && p.position.length === 3) {
        transform += ' translate3d(' + px(-finite(p.position[0], 0) * worldUnit / 7) + ',' +
          px(finite(p.position[1], 0) * worldUnit / 7) + ',' + px((7 - finite(p.position[2], 7)) * worldUnit / 7) + ')';
      } else transform += ' scale3d(' + [1, 1, 1].map(function () { return clamp(7 / Math.max(.1, finite(p.radius, 7)), .15, 4).toFixed(4); }).join(',') + ')';
      world.style.transform = transform; wallWorld.style.transform = transform;
    }

    function drawGeometry(env, animate) {
      var bands = env.bands || (env.audio && env.audio.bands) || [];
      if (animate || !audioReady) {
        for (var k = 0; k < RING_BARS; k++) spectrum[k] = clamp(finite(bands[Math.floor(k / RING_BARS * bands.length)], 0), 0, 1);
        energy = clamp(finite(env.energy, 0), 0, 1); audioReady = true;
      }
      var radius = worldUnit * .27;
      ringHost.style.transform = 'translate3d(0px,' + px(worldUnit * .05) + ',' + px(-worldUnit * .13) + ') rotateX(-.25rad)';
      bars.forEach(function (bar, i) {
        var angle = i / RING_BARS * TAU;
        var value = spectrum[i];
        // The entire ring is a tilted plane: near/far edges project differently.
        bar.style.transform = 'translate3d(' + px(Math.cos(angle) * radius) + ',' + px(Math.sin(angle) * radius) + ',0px) rotateZ(' + (angle + Math.PI / 2).toFixed(4) + 'rad) scaleY(' + (.2 + value * 2.8).toFixed(3) + ')';
      });
      ringHost.style.setProperty('--sp-orbit-size', px(radius * 2));
      points.forEach(function (point) {
        var y = ((point.y - time * point.speed) % 1 + 1) % 1;
        var x = point.x + Math.sin(time * .15 + point.z * TAU) * .045;
        point.el.style.transform = 'translate3d(' + px(x * width * .58) + ',' + px((y - .5) * height * 1.2) + ',' + px(point.z * worldUnit * .65) + ')';
        point.el.style.width = point.el.style.height = px(point.size);
        point.el.style.opacity = (.22 + (point.z + 1) * .2).toFixed(3);
      });
      var beat = clamp(finite(env.beat, 0), 0, 1);
      if (rings.length && animate && beat > .32 && lastBeat <= .32 && time - lastRipple > .24) {
        rings[rippleIndex % rings.length].born = time; rippleIndex++; lastRipple = time;
      }
      lastBeat = beat;
      rings.forEach(function (ring, i) {
        var progress = (time - ring.born) / 2.4;
        // A quiet base ring keeps its placement legible before the first beat.
        var live = progress >= 0 && progress < 1;
        ring.el.hidden = !live && i !== 0;
        if (ring.el.hidden) return;
        var scale = live ? .22 + progress * 2.4 : .45;
        var alpha = live ? (1 - progress) * .62 : .08;
        ring.el.style.transform = 'translate3d(0px,' + px(worldUnit * .21) + ',' + px(-worldUnit * .16) + ') rotateX(1.08rad) scale(' + scale.toFixed(4) + ')';
        ring.el.style.opacity = (alpha * prefs.ripples / 100).toFixed(4);
      });
      root.style.setProperty('--sp-layer-energy', energy.toFixed(3));
    }

    function paintWall(spec) {
      background = document.getElementById('creative-bg');
      var source = background && (spec.type === 'media' ? background.querySelector('.creative-bg-media') : background.querySelector('#creative-bg-canvas'));
      var sw = source && (source.videoWidth || source.naturalWidth || source.width);
      var sh = source && (source.videoHeight || source.naturalHeight || source.height);
      var usable = source && sw > 0 && sh > 0 && spec.type !== 'theme' &&
        (source.readyState === undefined || source.readyState >= 2);
      wallReady = false;
      if (!usable) {
        panels.forEach(function (panel) { if (panel.ctx) panel.ctx.clearRect(0, 0, panel.el.width, panel.el.height); });
        return;
      }
      var aspect = 2 * 1.42 / 1.5, cropW = sw, cropH = sh;
      if (sw / sh > aspect) cropW = sh * aspect; else cropH = sw / aspect;
      try {
        panels.forEach(function (panel, i) {
          if (!panel.ctx) return;
          panel.ctx.clearRect(0, 0, panel.el.width, panel.el.height);
          panel.ctx.drawImage(source, (sw - cropW) / 2 + cropW * i / WALL_PANELS, (sh - cropH) / 2,
            cropW / WALL_PANELS, cropH, 0, 0, panel.el.width, panel.el.height);
        });
        wallReady = panels.length > 0 && panels.every(function (panel) { return !!panel.ctx; });
      } catch (error) { warning = '这份素材暂时无法铺满背景墙，请换一张图片'; }
    }

    function update(dtMs, env) {
      if (disposed) return;
      env = env || {}; lastEnv = env;
      var hidden = !!env.hidden || !!document.hidden;
      var animate = !hidden && env.playing === true && !env.reduced && prefs.stagePreset !== 'still';
      var step = clamp(finite(dtMs, 0), 0, 250) / 1000;
      if (typeof env.timeSec === 'number' && isFinite(env.timeSec)) {
        if (inputTime !== null) step = clamp(env.timeSec - inputTime, 0, .25);
        inputTime = env.timeSec;
      }
      if (animate) time += step;
      if (owner && owner.setStageState) owner.setStageState({ paused: hidden || env.playing !== true,
        reduced: !!env.reduced || prefs.stagePreset === 'still', flat: true, timeSec: time });
      if (hidden) return;
      root.classList.toggle('sp-layers-paused', !animate);
      if (points.length || bars.length || rings.length || panels.length) {
        resize(); placeCamera(env.pose);
        if (points.length || bars.length || rings.length) drawGeometry(env, animate);
      }
      var spec = owner && owner.values ? owner.values() : { type: 'theme' };
      var nextBackgroundKey = JSON.stringify([spec.type, spec.url, spec.media]);
      if (nextBackgroundKey !== backgroundKey) { backgroundKey = nextBackgroundKey; wallDirty = true; }
      var frame = owner && owner.sourceFrame ? owner.sourceFrame() : null;
      if (frame) {
        var nextSourceKey = [frame.version, frame.width, frame.height, frame.ready].join(':');
        if (frame.source !== sourceElement || nextSourceKey !== sourceKey) {
          sourceElement = frame.source; sourceKey = nextSourceKey; wallDirty = true;
        }
      }
      var message = warning;
      if (!owner && prefs.bgwall) message = '背景暂不可用';
      else if (spec.type === 'media') {
        var layer = document.getElementById('creative-bg');
        var media = layer && layer.querySelector('.creative-bg-media');
        if (!spec.url || !media) message = message || '选择一张图片或一段视频作为背景';
        else if (media.error || (media.tagName === 'IMG' && media.complete && !media.naturalWidth)) message = message || '无法打开这份素材，请换一张图片或一段视频';
        else if (!(media.naturalWidth || media.videoWidth)) message = message || '正在载入背景素材…';
      } else if (prefs.bgwall && spec.type === 'theme') message = message || '选择一种背景画面，让它环绕四周';
      if (panels.length) {
        panels.forEach(function (panel) {
          panel.el.style.opacity = String(clamp(finite(spec.opacity, 90), 0, 100) / 100);
          panel.el.style.filter = 'blur(' + px(clamp(finite(spec.blur, 0), 0, 60) * .35) + ')';
          panel.el.style.mixBlendMode = spec.blend || 'normal';
        });
        wallElapsed += Math.max(0, finite(dtMs, 0));
        // Source pixels are owned/refreshed by the existing background gate.
        // Sample at most 12 Hz, even when the host runs at an interactive rate.
        var dynamic = frame ? frame.dynamic : spec.type !== 'media' || spec.media === 'video';
        if (wallDirty || (animate && dynamic && wallElapsed >= 1000 / 12)) {
          paintWall(spec); wallDirty = false; wallElapsed = 0;
        }
      }
      bgHost.classList.toggle('sp-has-wall', prefs.bgwall && wallReady);
      showStatus(message || warning);
    }

    function dispose() {
      if (disposed) return; disposed = true;
      if (unsubscribeSource) { unsubscribeSource(); unsubscribeSource = null; }
      // Host calls after disposing its scene, before giving focus back to 2D.
      if (owner && owner.setStageHost) owner.setStageHost(previousHost);
      background = document.getElementById('creative-bg');
      if (background && previousParent && background.parentNode !== previousParent) previousParent.insertBefore(background,
        previousNext && previousNext.parentNode === previousParent ? previousNext : null);
      else if (background && previousParent && previousNext && previousNext.parentNode === previousParent) previousParent.insertBefore(background, previousNext);
      if (owner && owner.setStageState) owner.setStageState(null);
      bgHost.classList.remove('sp-has-wall');
      root.classList.toggle('sp-karaoke', priorKaraoke);
      root.classList.remove('sp-layers-paused'); root.style.removeProperty('--sp-layer-energy');
      if (priorTheme === undefined) delete root.dataset.spaceTheme; else root.dataset.spaceTheme = priorTheme;
      overlay.remove(); wallHost.remove(); status.remove();
      points = []; bars = []; rings = []; panels = []; owner = null;
    }

    rebuild(); update(0, {});
    if (owner && owner.onSourceFrame) unsubscribeSource = owner.onSourceFrame(function () {
      wallDirty = true;
      // Paused hosts have no layer gate to consume an asynchronously loaded frame.
      if (!lastEnv.hidden && !document.hidden &&
          (lastEnv.playing !== true || lastEnv.reduced || prefs.stagePreset === 'still')) update(0, lastEnv);
    });
    return { configure: configure, update: update, dispose: dispose, setBackground: setBackground, setLocalFile: setLocalFile,
      stats: function () { return { dust: points.length, discBars: bars.length, ripples: rings.length,
        wallPanels: panels.length, wallReady: wallReady, timeSec: time, warning: status.hidden ? '' : status.textContent,
        active: !disposed && (!!points.length || !!bars.length || !!rings.length || !!panels.length) }; } };
  }
  global.SpaceLayers = { create: create, defaults: defaults, normalize: normalize,
    catalog: function () { return copy(CONTROLS); }, backgroundCatalog: function () { return copy(BACKGROUNDS); } };
})(window);
