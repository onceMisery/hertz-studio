// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// 字形 stanza 渲染器。只做三件事：排版、准备实例数据、交给 GL。
// 情绪求值不在这里——它来自 LyricEmotionField，本文件只消费采样结果。
(function (global) {
  'use strict';

  // The Stage facade includes native parent-window suspension. Standalone consumers keep browser visibility.
  function documentHidden() {
    var stage = window.Stage;
    return stage && typeof stage.isDocumentHidden === "function" ? stage.isDocumentHidden() : !!document.hidden;
  }
  if (typeof window === 'undefined') return;
  var U = global.StanzaUtil;

  var CJK = /[一-龥぀-ヿ가-힯]/;
  var MAX_GLYPHS = 96;
  var GLOW_PX = 12;
  var RIM_PX = 1.0;

  // 400/700 两张 SDF 交错进同一张 RG8 图集：R=细基面、G=粗基面。
  // 几何（字号/基线/槽位）由 atlas 模块统一，避免两张脸错位。
  function createDualAtlas(fontStack, options) {
    return global.LyricGlyphAtlas.createDual(fontStack, options);
  }

  function init(host, onSeek, options) {
    options = options || {};
    var resources = options.resources;
    if (options.admissionRequired && (!resources || resources.contractVersion !== 1)) throw new Error('resource-port-required');
    var root = document.createElement('div');
    root.className = 'fl-glyph';
    var canvas = null;
    var a11y = document.createElement('div');
    a11y.className = 'fl-glyph-a11y';
    var hitLayer = document.createElement('div');
    hitLayer.className = 'fl-glyph-hit';
    var note = document.createElement('button');
    note.type = 'button'; note.className = 'fl-glyph-retry'; note.hidden = true;
    note.textContent = '重新启用字形效果';
    root.append(a11y, hitLayer, note);
    host.append(root);

    var theme = global.StanzaTheme.DEFAULT;
    var fontScale = 1, visible = true, paused = false;
    var tuning = { rotation: true, breathing: 1, spacing: 0.7 };
    var curLine = null, layout = null;
    var gl = null, atlas = null;
    var cssW = 1, cssH = 1, dpr = 1;
    var profile = null, emotionScale = 1;
    var emotionState = null, emotionRevision = -1;
    var measureCanvas = null, measureCtx = null, curveBuffers = null;
    var canvasTicket = null, measureTicket = null, generation = 0;
    var failure = null, resizeFailure = null, destroyed = false, submitted = false, sizeDirty = true, ro = null;
    var sceneTimeMs = 0, advancing = false, lastFrameId = -1, stateUnsubscribe = null;
    root.dataset.glyphState = 'preparing';
    function requirePlan(value, source) { return resources ? resources.require(value, source, generation) : null; }
    function retire(ticket, clean) {
      if (!ticket) return;
      ticket.cancel();
      if (clean) ticket.release({apiReleased:true, allocationEnded:true}); else ticket.settle({allocationEnded:true});
    }
    function report() {
      if (resources) resources.report({requestedBackend:'glyph', actualBackend:submitted ? 'webgl2' : 'dom',
        phase:destroyed ? 'disposed' : failure ? 'failed' : submitted ? 'active' : 'preparing',
        generation:generation, failure:failure || resizeFailure, sceneTimeMs:sceneTimeMs,
        coverage:'glyph-typed-arrays-canvas-program-buffer-and-atlas'});
    }
    function disposeGraphics() {
      var clean = true;
      if (canvas) canvas.removeEventListener('webglcontextlost', contextLost);
      if (gl) { try { clean = gl.destroy().apiReleased && clean; } catch (_) { clean = false; } }
      if (atlas) { try { clean = atlas.destroy().apiReleased && clean; } catch (_) { clean = false; } }
      try { if (canvas) { canvas.width = canvas.height = 0; canvas.remove(); } if (measureCanvas) measureCanvas.width = measureCanvas.height = 0; }
      catch (_) { clean = false; }
      gl = atlas = canvas = measureCanvas = measureCtx = curveBuffers = null;
      retire(canvasTicket, clean); retire(measureTicket, clean);
      canvasTicket = measureTicket = null; submitted = false; layout = null; curLine = null;
      return clean;
    }
    function fail(error) {
      failure = (error && error.message) || String(error);
      if (!disposeGraphics()) failure = 'glyph-cleanup-failed';
      root.dataset.glyphState = 'failed'; note.hidden = false; hitLayer.textContent = ''; report();
    }
    function contextLost(e) { e.preventDefault(); if (!destroyed) fail(new Error('context-lost')); }
    function retry() {
      if (destroyed || !failure || failure === 'glyph-cleanup-failed') return;
      failure = resizeFailure = null; submitted = advancing = false; generation++; sizeDirty = true;
      root.dataset.glyphState = 'preparing'; note.hidden = true; report();
      if (global.Stage && Stage.kick) Stage.kick();
    }
    note.addEventListener('click', retry);

    function fontStack() { return global.StanzaTheme.fontStack(theme.fontStyle); }

    function emPx() {
      var minPx = 2.25 * fontScale * 16;
      var valPx = 6 * fontScale * (global.innerWidth || 1200) / 100;
      var maxPx = 4.5 * fontScale * 16;
      return Math.max(minPx, Math.min(valPx, maxPx));
    }

    function ensureGL() {
      if (gl) return true;
      if (failure || destroyed || !cssW || !cssH || documentHidden()) return false;
      if (global.Stage && Stage.tier && Stage.tier() === 0) throw new Error('glyph-backend-unavailable');
      canvasTicket = requirePlan({canvases:1}, 'Glyph renderer owned canvas');
      canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      canvas.className = 'fl-glyph-canvas'; canvas.setAttribute('aria-hidden', 'true');
      canvas.addEventListener('webglcontextlost', contextLost); root.prepend(canvas);
      if (canvasTicket) canvasTicket.commit();
      gl = global.LyricGlyphGL.create(canvas, {resources:resources, admissionRequired:options.admissionRequired, generation:generation});
      if (!gl) throw new Error('glyph-backend-unavailable');
      measureTicket = requirePlan({canvases:1, ownedCpuBytes:4 + 33 * 4 * 2}, 'Glyph layout 1x1 measure canvas and two retained field curves');
      measureCanvas = document.createElement('canvas'); measureCanvas.width = measureCanvas.height = 1;
      measureCtx = measureCanvas.getContext('2d');
      if (!measureCtx) throw new Error('glyph metrics unavailable');
      curveBuffers = {b:new Float32Array(33), w:new Float32Array(33)};
      if (measureTicket) measureTicket.commit();
      atlas = createDualAtlas(fontStack(), {resources:resources, admissionRequired:options.admissionRequired, generation:generation});
      gl.initTexture(atlas.W, atlas.H, true);
      gl.resize(Math.round(cssW * dpr), Math.round(cssH * dpr));
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      return true;
    }

    function resizeCanvas() {
      var r = root.getBoundingClientRect();
      var nextW = r.width > 0 ? r.width : 0, nextH = r.height > 0 ? r.height : 0;
      var nextDpr = Math.min(global.devicePixelRatio || 1, 2);
      sizeDirty = false;
      if (gl && nextW && nextH) {
        try { gl.resize(Math.max(1, Math.round(nextW * nextDpr)), Math.max(1, Math.round(nextH * nextDpr))); }
        catch (error) {
          if (error.resourceFailure && submitted) { resizeFailure = error.message; report(); return; }
          throw error;
        }
      }
      cssW = nextW; cssH = nextH; dpr = nextDpr; resizeFailure = null;
      if (!cssW || !cssH) advancing = false;
      if (gl && cssW && cssH) {
        canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      }
    }

    // ---- 排版：tokens → 字素序列，得到每个字素的 x / advance / u 区间 ----
    function buildLayout(line, baseY) {
      var tokens = global.Stage && Stage.lyricTokens ? Stage.lyricTokens(line) : [];
      if (!tokens.length) return null;
      var em = emPx();
      measureCtx.font = '600 ' + em + 'px ' + fontStack();

      var items = [], x = 0, last = '', ti = -1;
      tokens.forEach(function (tok, tokenIndex) {
        var grams = U.graphemes(tok.text);
        if (!grams.length) return;
        ti = tokenIndex;
        if (last) x += (CJK.test(last) && CJK.test(grams[0])) ? em * 0.04 : em * 0.26;

        var dur = Math.max(1, tok.end_ms - tok.start_ms);
        var wts = grams.map(function (g) { return /\s/.test(g) ? 0.5 : 1; });
        var sum = wts.reduce(function (a, b) { return a + b; }, 0) || 1;
        var acc = 0;
        grams.forEach(function (g, gi) {
          var adv = measureCtx.measureText(g).width;
          var t0 = tok.start_ms + dur * (acc / sum);
          acc += wts[gi];
          var t1 = tok.start_ms + dur * (acc / sum);
          items.push({ ch: g, x: x, x0: x, adv: adv, startMs: t0, endMs: t1, tok: tokenIndex });
          x += adv; last = g;
        });
      });
      if (!items.length) return null;

      var maxW = cssW * 0.92;
      var fit = x > maxW ? maxW / x : 1;
      var originX = (cssW - x * fit) / 2;

      items.forEach(function (it) {
        it.uStart = it.x0 / x;
        it.uEnd = (it.x0 + it.adv) / x;
        it.x = originX + it.x0 * fit;
        it.adv *= fit;
      });

      var boxes = [];
      items.forEach(function (it) {
        var b = boxes[it.tok];
        if (!b) { b = boxes[it.tok] = { x0: it.x, x1: it.x + it.adv, tok: it.tok }; }
        if (it.x < b.x0) b.x0 = it.x;
        if (it.x + it.adv > b.x1) b.x1 = it.x + it.adv;
      });

      return {
        items: items, em: em * fit, baseY: baseY, line: line,
        boxes: boxes.filter(Boolean), tokens: tokens
      };
    }

    function buildHit(currentLayout) {
      hitLayer.textContent = '';
      if (!currentLayout) return;
      var em = currentLayout.em;
      currentLayout.boxes.forEach(function (b) {
        var tok = currentLayout.tokens[b.tok];
        if (!tok || typeof currentLayout.line.start_ms !== 'number') return;
        var el = document.createElement('span');
        el.className = 'fl-glyph-hot';
        el.style.left = b.x0 + 'px';
        el.style.top = (currentLayout.baseY - em * 1.15) + 'px';
        el.style.width = Math.max(8, b.x1 - b.x0) + 'px';
        el.style.height = (em * 1.5) + 'px';
        el.addEventListener('click', function (e) {
          e.stopPropagation();
          if (onSeek) onSeek(currentLayout.line.start_ms);
        });
        hitLayer.append(el);
      });
    }

    function toVec3(hex) {
      var c = U.hexToRgb(hex) || { r: 244, g: 244, b: 245 };
      return [c.r / 255, c.g / 255, c.b / 255];
    }

    function decorAllowed() {
      if (!document.body) return false;
      if (document.body.classList.contains('reduce-motion') ||
          document.body.classList.contains('stage-lowfx')) return false;
      var rm = document.body.getAttribute('data-rm') || '';
      if (rm.split(/\s+/).indexOf('lyrics') >= 0) return false;
      if (root.closest && root.closest('.s3d-reduced')) return false;
      return true;
    }

    function pulse() {
      if (global.Stage && Stage.beat) return U.clamp(Stage.beat(), 0, 1);
      if (global.Stage && Stage.energy) return U.clamp(Stage.energy(), 0, 1);
      return 0;
    }

    function syncEmotion(idx) {
      var E = global.LyricEmotion;
      emotionRevision = E && E.revision ? E.revision() : -1;
      emotionState = (E && idx >= 0 && E.resolveForLine)
        ? E.resolveForLine(idx, { host: 'glyph', em: emPx() })
        : null;
    }

    function drawLine(tMs) {
      if (!layout) return;
      var em = layout.em;
      var scale = em / atlas.RENDER_PX;
      var ls = U.num(layout.line.start_ms, 0);
      var le = Math.max(ls + 1, U.num(layout.line.end_ms, ls + 1));
      var clipU = U.clamp((tMs - ls) / (le - ls), 0, 1);

      // 手动 setEmotion（G3 检查页）优先；否则消费已提交的 LyricEmotion 状态。
      // 中性状态不写颜色/场，保持渲染器自己的主题观感。
      var st = (!profile && emotionState && emotionState.id !== 'neutral') ? emotionState : null;
      var prof = profile || (st ? st.profile : null);
      var eI = profile ? emotionScale : (st ? st.intensity : 1);
      var pal = st && (!global.LyricEmotion || !global.LyricEmotion.paletteEnabled ||
        global.LyricEmotion.paletteEnabled()) ? st.palette : null;
      var decorKind = 0, decorStride = 1, decorSeed = 0, decorDur = 1800, decorColor = null;
      var f = (prof && global.LyricEmotionField)
        ? global.LyricEmotionField.sample(prof, eI, em, pulse(), 0, curveBuffers)
        : { b: curveBuffers.b.fill(0), w: curveBuffers.w.fill(0.5),
            turb: 0, shearTan: 0, amp: 0, freq: 0, damp: 2 };

      var glyphs = [];
      for (var i = 0; i < layout.items.length && glyphs.length < MAX_GLYPHS; i += 1) {
        var it = layout.items[i];
        if (!it.ch || /^\s$/.test(it.ch)) continue;
        var slot = atlas.acquire(it.ch);
        glyphs.push({
          x: it.x - atlas.PAD * scale,
          y: layout.baseY - (atlas.PAD + atlas.BASELINE) * scale,
          w: atlas.CELL * scale,
          h: atlas.CELL * scale,
          u0: slot.u0, v0: slot.v0,
          box: slot.box,
          uStart: it.uStart, uEnd: it.uEnd,
          startMs: it.startMs, durMs: Math.max(1, it.endMs - it.startMs)
        });
      }

      if (st && st.intensity >= 0.75 && st.decor && st.decor.length && decorAllowed()) {
        var dec = st.decor[0];
        var kindMap = { spark: 1, tear: 2, ember: 3 };
        var count = Math.min(6, dec.climaxCount != null ? dec.climaxCount : (dec.count || 0));
        decorKind = kindMap[dec.kind] || 0;
        if (decorKind && count > 0 && glyphs.length) {
          decorStride = Math.max(1, Math.ceil(glyphs.length / count));
          decorSeed = layout.line.start_ms || 0;
          decorDur = decorKind === 2 ? 4000 : 1800;
          decorColor = toVec3(pal ? pal.accent : theme.accentColor);
        }
      }

      var dirty = atlas.takeDirty();
      for (var k = 0; k < dirty.length; k += 1) {
        var o = atlas.cellOrigin(dirty[k]);
        atlas.withCellBytes(dirty[k], function (bytes) { gl.uploadCell(o.x, o.y, atlas.CELL, bytes); });
      }

      gl.beginFrame(cssW, cssH);
      gl.draw(glyphs, glyphs.length, {
        uvW: atlas.CELL / atlas.W,
        uvH: atlas.CELL / atlas.H,
        cellPx: atlas.CELL, padPx: atlas.PAD,
        timeMs: tMs,
        sceneTimeMs:resources ? sceneTimeMs : tMs,
        shear: tuning.rotation ? f.shearTan : 0,
        baseY: layout.baseY,
        amp: f.amp, freq: f.freq, damp: f.damp,
        curveB: f.b, curveW: f.w,
        range: atlas.RANGE,
        pxScale: scale,
        // 0.50 以上没有更粗的字面，只能靠 SDF 膨胀；增益 8 才能跨过
        // 8 位距离场的量化台阶。情绪场把 w 限在 0.30–0.62，字怀仍安全。
        weightGain: 8, weightGainHi: 8, dual: true,
        glowK: Math.LN2 / Math.max(1e-3, GLOW_PX / scale),
        glowAmt: 0.55,
        rimAmt: 0.18,
        rimWidth: RIM_PX / scale,
        clipU: clipU, soft: 0.012, wobble: 0.004,
        turbAmp: f.turb,
        decorKind: decorKind, decorStride: decorStride, decorSeed: decorSeed,
        decorDur: decorDur, decorColor: decorColor,
        opacity: 1,
        idleColor: toVec3(pal ? pal.ink : theme.primaryColor),
        sungColor: toVec3(pal ? pal.accent : theme.accentColor),
        glowColor: toVec3(pal ? pal.accent2 : theme.accentColor)
      });
    }

    function frame(dtMs, borrowed) {
      if (destroyed || !visible || !global.Stage || documentHidden() || (borrowed && borrowed.documentHidden)) { advancing = false; return; }
      if (borrowed && borrowed.version === 1) {
        if (borrowed.frameId === lastFrameId) return;
        lastFrameId = borrowed.frameId;
      }
      var doc = global.Stage.lyrics();
      var lines = doc ? doc.lines : [];
      var tMs = borrowed && borrowed.version === 1 ? borrowed.mediaPositionMs : global.Stage.position();
      var idx = U.activeLineIndex(lines, tMs);
      var line = idx >= 0 ? lines[idx] : null;
      var fallbackText = line ? line.text : '';
      if (a11y.textContent !== fallbackText) a11y.textContent = fallbackText;
      if (failure) { report(); return; }
      try {
      if (sizeDirty) resizeCanvas();
      if (!cssW || !cssH || !ensureGL()) return;
      var moving = !!(borrowed && borrowed.playing && !borrowed.reduced && !paused && decorAllowed());
      var delta = moving && advancing && submitted && Number.isFinite(dtMs) ? Math.min(100, Math.max(0, dtMs)) : 0;
      advancing = moving; sceneTimeMs += delta;

      if (line !== curLine) {
        curLine = line;
        layout = (line && U.hasReadable(line.text)) ? buildLayout(line, cssH / 2) : null;
        buildHit(layout);
        syncEmotion(idx);
      } else if (idx >= 0 && global.LyricEmotion && global.LyricEmotion.revision &&
          global.LyricEmotion.revision() !== emotionRevision) {
        // 显式刷新/新 Cue 在同一行内提交：只重取状态，不重建排版。
        syncEmotion(idx);
      }
      if (!layout) gl.beginFrame(cssW, cssH);
      drawLine(tMs);
      submitted = true; root.dataset.glyphState = 'active'; note.hidden = true; report();
      } catch (error) { fail(error); }
    }

    if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(function () { sizeDirty = true; if (global.Stage && Stage.kick) Stage.kick(); }); ro.observe(root); }
    if (resources && global.Stage && Stage.onFrameState) stateUnsubscribe = Stage.onFrameState(function (state) {
      if (state.documentHidden || state.reduced || !state.playing) advancing = false;
    });
    report();

    return {
      frame: frame,
      isReady: function () { return !destroyed && (submitted || !!failure); },
      getDebugSnapshot: function () { return {requestedBackend:'glyph', actualBackend:submitted ? 'webgl2' : 'dom',
        generation:generation, failure:failure || resizeFailure, sceneTimeMs:sceneTimeMs, submitted:submitted,
        resources:gl && gl.resourceState(), atlas:atlas && atlas.resourceState()}; },
      update: function () {},
      setTheme: function (t) {
        if (!t || global.StanzaTheme.signature(t) === global.StanzaTheme.signature(theme)) return;
        theme = t;
        root.style.setProperty('--glyph-ink', theme.primaryColor);
        root.style.setProperty('--glyph-font', fontStack());
        // Font geometry and raster face belong to this atlas generation.
        if (atlas) disposeGraphics();
        submitted = false; root.dataset.glyphState = failure ? 'failed' : 'preparing';
        layout = null; curLine = null;
      },
      setFontScale: function (v) {
        v = U.clamp(v, 0.7, 1.5);
        if (Math.abs(v - fontScale) < 1e-6) return;
        fontScale = v; layout = null; curLine = null;
      },
      rootEl: function () { return root; },
      setVisible: function (b) { b = !!b; if (visible !== b) sizeDirty = true; if (!b) advancing = false; visible = b; root.hidden = !b; },
      setPaused: function (b) { paused = !!b; if (paused) advancing = false; },
      setEco: function () {},
      setTuning: function (t) {
        tuning = {
          rotation: t.rotation !== false,
          breathing: U.clamp(t.breathing != null ? t.breathing : 1, 0, 2),
          spacing: U.clamp(t.spacing != null ? t.spacing : 0.7, 0, 2)
        };
        layout = null; curLine = null;
      },
      resize: function () { sizeDirty = true; layout = null; curLine = null; },
      retryResources: retry,
      setEmotion: function (p, scale) {
        profile = p;
        emotionScale = scale == null ? 1 : scale;
      },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        if (ro) { ro.disconnect(); ro = null; }
        if (stateUnsubscribe) { stateUnsubscribe(); stateUnsubscribe = null; }
        note.removeEventListener('click', retry); disposeGraphics();
        if (resources) resources.forgetReport();
        root.remove();
      }
    };
  }

  global.StanzaGlyph = { init: init };
})(window);
