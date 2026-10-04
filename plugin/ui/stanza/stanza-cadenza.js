// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
// 心象 cadenza：排版放置 → DOM 层 + canvas 光束层；姿态逐帧低通插值。
(function (global) {
  'use strict';
  if (typeof window === 'undefined') return;
  var U = global.StanzaUtil;

  function init(host, onSeek) {
    var wrap = document.createElement('div'); wrap.className = 'fl-cadenza';
    var canvas = document.createElement('canvas'); canvas.className = 'fl-cadz-canvas';
    var ctx = canvas.getContext('2d');
    var dom = document.createElement('div'); dom.style.position = 'absolute'; dom.style.inset = '0';
    wrap.append(canvas, dom);
    host.append(wrap);

    var theme = StanzaTheme.DEFAULT, fontScale = 1.12, visible = true, eco = false;
    // reduced 每帧在 frame 内活读祖先 .s3d-reduced：姿态/辉光瞬时吸附、光束能量按 0 冻结。
    var reduced = false;
    var tuning = { width: 0.72, motion: 1, glow: 1, beam: 0 };
    var cur = null;          // {line, hints, pack, nodes[]}
    // cleared：无活动行分支每帧只做一次 clearRect+清空 dom，cur 已 null 的后续帧直接 return。
    var cleared = false;
    var W = 0, H = 0, dpr = 1, sized = false;
    // needRepack：下一帧需要重新 packLine+mount；repackSoft=true 为配置类软重排（节点立即吸附，
    // 不走 waiting 低通），false 留给真实换句的硬挂载（节点从 waiting 姿态低通进入）。
    var needRepack = false, repackSoft = false, destroyed = false;

    // 配置类变更（宽度/字号/主题/eco/尺寸）请求下一帧重排。motion/glow/beam 帧内活读，不走这里。
    function requestRepack(soft) {
      needRepack = true;
      repackSoft = !!soft;
    }

    // force 用于字号/eco 变更：几何尺寸可能未变但仍需软重排（ResizeObserver 回调不传）。
    function resize(force) {
      var r = host.getBoundingClientRect();
      var nW = r.width, nH = r.height;
      var nDpr = Math.min(global.devicePixelRatio || 1, (eco || nW < 760) ? 1.5 : 2);
      // 宽高/dpr 未变则提前返回；sized 保证首次（可能为 0 尺寸）一定执行。
      if (!force && sized && nW === W && nH === H && nDpr === dpr) return;
      sized = true;
      W = nW; H = nH; dpr = nDpr;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      requestRepack(true);
    }
    var ro = global.ResizeObserver && new ResizeObserver(function () { resize(); });
    if (ro) ro.observe(host);
    resize();

    function baseFontPx() {
      var vw = W || global.innerWidth || 1200;
      return U.clamp(vw * 0.086 * fontScale, 34 * fontScale, 94 * fontScale);
    }

    // 测宽复用单个 canvas：旧实现 init 一次死调用 + packLine 每行 installCanvasMeasure（每次新建
    // canvas）。这里惰性创建一次、configure 只注册一轮，之后仅更新 ctx.font；无 document 安全早退。
    var measureCanvas = null, measureCtx = null;
    function ensureMeasure() {
      if (measureCtx) return measureCtx;
      if (typeof document === 'undefined') return null;
      measureCanvas = document.createElement('canvas');
      measureCtx = measureCanvas.getContext('2d');
      StanzaTextLayout.configure({ measure: function (text, px) {
        measureCtx.font = '700 ' + px + 'px ' + StanzaTheme.fontStack(theme.fontStyle);
        return measureCtx.measureText(text).width;
      }});
      return measureCtx;
    }
    // 主题切换/每行排版前轻量刷新测宽字体：只更新 ctx.font（measure 回调内仍按 px 再设一次），
    // 成本远低于新建 canvas。
    function setMeasureFont(fontStack) {
      if (!ensureMeasure()) return;
      measureCtx.font = '700 ' + baseFontPx() + 'px ' + fontStack;
    }

    function packLine(line) {
      var tokens = Stage.lyricTokens(line);
      var fontPx = baseFontPx();
      var graphemeCount = tokens.reduce(function (a, t) { return a + U.graphemes(t.text).length; }, 0);
      if (graphemeCount > 12) fontPx *= U.clamp(0.92 - (graphemeCount - 12) * 0.018, 0.62, 0.92);
      // 窄屏排版宽度下限提到 0.88（spec 10.2）。
      var widthRatio = W < 760 ? Math.max(0.88, tuning.width) : tuning.width;
      var maxW = W * widthRatio;
      setMeasureFont(StanzaTheme.fontStack(theme.fontStyle));
      var laid = StanzaTextLayout.layout(tokens, { maxW: maxW, fontPx: fontPx });
      return { line: line, hints: U.renderHints(line), tokens: tokens, laid: laid, fontPx: fontPx };
    }

    // soft=true：配置触发的软重排。挂载后把每个节点立即吸附到当前 tMs 的目标姿态，
    // 不从 waiting 低通过来，避免拖参时整屏词漂动。
    function mount(pack, soft, energyNow) {
      dom.innerHTML = '';
      pack.nodes = pack.laid.placements.map(function (p) {
        var el = document.createElement('div');
        el.className = 'fl-cadz';
        // 定位全部由 frame 的 transform 给出（left/top 锚 0，避免位移被叠加两次）。
        el.style.left = '0';
        el.style.top = '0';
        var narrowHero = p.hero && W < 760 ? 0.85 : 1;   // 窄屏 hero 尺寸上限收 15%
        el.style.fontSize = (pack.fontPx * p.scale * narrowHero) + 'px';
        el.style.fontFamily = StanzaTheme.fontStack(theme.fontStyle);
        el.style.fontWeight = '700';
        var glow = document.createElement('span'); glow.className = 'fl-glow';
        var body = document.createElement('span'); body.className = 'fl-body';
        glow.textContent = p.text; body.textContent = p.text;
        el.append(glow, body);
        el.dataset.st = 'waiting';
        el.style.color = theme.primaryColor;
        el.addEventListener('click', function () { if (onSeek) onSeek(pack.line.start_ms); });
        dom.append(el);
        var state = { x: p.x + p.entryX, y: p.y + p.entryY, rot: p.rotate - 4, scale: 0.97, alpha: 0.65, glowA: 0 };
        return { p: p, el: el, glow: glow, body: body, state: state, target: state, heroMul: narrowHero };
      });
      if (soft) {
        var tMs = Stage.position();
        pack.nodes.forEach(function (node) {
          var tg = targetsFor(node, tMs);
          // 逐字段吸附（不用 Object.assign，ES5 友好且只触碰既有字段）。
          node.state.x = tg.x; node.state.y = tg.y; node.state.rot = tg.rot;
          node.state.scale = tg.scale; node.state.alpha = tg.alpha; node.state.glowA = tg.glow;
          writeNode(node, tMs, tg, energyNow);
        });
      }
    }

    function glowAlpha(node, tMs) {
      var p = node.p, h = cur.hints, mode = h.revealMode;
      var dur = Math.max(p.end_ms - p.start_ms, mode === 'fast' ? 45 : 100);
      var upTo = mode === 'fast' ? 0.14 : 0.18;
      var platEnd = mode === 'fast' ? 0.82 : 0.9;
      var prog = U.clamp((tMs - p.start_ms) / Math.max(1, dur), 0, 1);
      var g;
      if (prog < upTo) g = U.easeOutCubic(prog / upTo);
      else if (prog < platEnd) g = 1;
      else g = U.lerp(1, mode === 'fast' ? 0.92 : 0.9, (prog - platEnd) / (1 - platEnd));
      var fade = U.clamp((tMs - p.end_ms) / (mode === 'fast' ? 120 : 900), 0, 1);
      g *= Math.pow(1 - fade, 2);
      if (p.hero) g = U.lerp(g, 1, 0.25);
      return U.clamp(g * tuning.glow, 0, 1.6);
    }

    // 按 st 计算节点当前目标姿态与目标辉光（frame 低通与 soft 挂载吸附复用；公式即原帧内联段）。
    function targetsFor(node, tMs) {
      var p = node.p;
      var motion = tuning.motion;
      var st = U.wordState(p, cur.hints, cur.line, tMs);
      var x, y, rot, scale, alpha;
      if (st === 'waiting') {
        x = p.x + p.entryX * motion; y = p.y + p.entryY * motion;
        rot = p.rotate - 4;
        // stanza：normal 行进场 scale .97，fast/instant 行 .9。
        scale = cur.hints.revealMode === 'normal' ? 0.97 : 0.9;
        alpha = 0.65;
      } else if (st === 'active') {
        x = p.x; y = p.y; rot = p.rotate; scale = 1; alpha = 1;
      } else {
        var fadeMs = cur.hints.revealMode === 'fast' ? 120 : 900;
        var f = U.clamp((tMs - p.end_ms) / fadeMs, 0, 1);
        x = p.x + p.driftX * motion * f; y = p.y + p.driftY * motion * f;
        rot = p.rotate + p.passedRotate * motion * f;
        scale = U.lerp(1, 0.9, f); alpha = 0.9 * Math.pow(1 - f, 2) + 0.05;
      }
      return { x: x, y: y, rot: rot, scale: scale, alpha: alpha,
        glow: st === 'active' ? glowAlpha(node, tMs) : 0, st: st };
    }

    // 按 node.state 立即写一次 transform/opacity/颜色/text-shadow，并在 active 时画光束。
    // frame 循环（已先 damp，tg 由调用方算好传入）与 soft 挂载（已吸附）共用；
    // energyNow 由 frame 每帧只取一次后传入，本函数不再逐节点调 Stage.energy。
    function writeNode(node, tMs, tg, energyNow) {
      var p = node.p, s = node.state;
      node.el.dataset.st = tg.st;
      var color = tg.st === 'active' ? StanzaTheme.wordColor(p.text, theme) : theme.primaryColor;
      // 当前色写元素变量，供 CSS reduced 回退规则（静态 9px 辉光）与其它 var(--fl-accent) 规则取用。
      node.el.style.setProperty('--fl-accent', color);
      // 总缩放 = 排版缩放 × 窄屏 hero 收敛 × 姿态缩放。layout 以盒心建模而 DOM 从左上锚生长，
      // 故把缩放长出/缩入的半差补回左上锚，使视觉盒左上角对齐 layout 左上角（光束据此同左上同宽）。
      var rs = p.scale * node.heroMul * s.scale;
      var cx = W / 2, cy = H * 0.46;
      var absX = cx + s.x - cur.laid.width / 2 - (p.w * rs - p.w) / 2;
      var absY = cy + s.y - cur.laid.height / 2 - (p.h * rs - p.h) / 2;
      node.el.style.transform = 'translate(' + absX.toFixed(1) + 'px,' + absY.toFixed(1) + 'px) rotate(' + s.rot.toFixed(2) + 'deg) scale(' + s.scale.toFixed(3) + ')';
      node.el.style.opacity = U.clamp(s.alpha, 0, 1).toFixed(3);
      node.body.style.color = color;
      if (s.glowA > 0.01) {
        node.glow.style.textShadow = '0 0 40px ' + U.withAlpha(color, U.clamp(0.98 * s.glowA, 0, 0.98)) +
          ',0 0 40px ' + U.withAlpha(color, U.clamp(0.92 * s.glowA, 0, 0.92)) +
          ',0 0 40px ' + U.withAlpha(color, U.clamp(0.35 * s.glowA, 0, 0.35));
      } else node.glow.style.textShadow = 'none';

      // 光束：几何与缩放后的文字视觉盒共用左上点与宽度（wpx=p.w·rs），reduced 时 energyNow 为 0。
      if (tuning.beam > 0.01 && tg.st === 'active') {
        var wpx = p.w * rs;
        var bx = absX, by = absY + p.h * rs * 0.78;
        var bh = Math.max(2, p.h * rs * (0.05 + energyNow * 0.03) * Math.max(tuning.beam, 0.12));
        var g = ctx.createLinearGradient(bx, by, bx + wpx, by);
        g.addColorStop(0, U.withAlpha(color, 0));
        g.addColorStop(0.5, U.withAlpha(color, 0.5 * tuning.beam));
        g.addColorStop(1, U.withAlpha(color, 0));
        ctx.fillStyle = g;
        var r2 = bh / 2;
        ctx.beginPath();
        ctx.moveTo(bx + r2, by);
        ctx.lineTo(bx + wpx - r2, by);
        ctx.arc(bx + wpx - r2, by + r2, r2, -Math.PI / 2, Math.PI / 2);
        ctx.lineTo(bx + r2, by + bh);
        ctx.arc(bx + r2, by + r2, r2, Math.PI / 2, -Math.PI / 2);
        ctx.closePath(); ctx.fill();
      }
    }

    function frame(dtMs) {
      if (destroyed) return;
      if (!visible || !global.Stage) return;
      reduced = !!(host.closest && host.closest('.s3d-reduced'));
      // 光束能量每帧只取一次（reduced 或无 Stage.energy 时按 0 冻结），逐节点透传。
      var energyNow = (!reduced && global.Stage && Stage.energy) ? Stage.energy() : 0;
      // reduced：姿态/辉光瞬时吸附 target，不做逐帧低通；非 reduced 行为不变。
      function dampX(v, target, tau) { return reduced ? target : U.damp(v, target, tau, dtMs); }
      var doc = Stage.lyrics();
      var tMs = Stage.position();
      var lines0 = doc ? doc.lines : [];
      var idx0 = U.activeLineIndex(lines0, tMs);
      var line = idx0 >= 0 ? lines0[idx0] : null;
      if (!cur || cur.line !== line) {
        if (!line) {
          // 前奏/尾奏无活动行：首次 clearRect+卸载节点（避免 waiting 半透首行穿帮），
          // cur 已 null 的后续帧直接 return；重新有行时在下方复位 cleared。
          if (cur || !cleared) {
            ctx.clearRect(0, 0, W, H);
            dom.innerHTML = '';
            cleared = true;
          }
          cur = null;
          needRepack = false; repackSoft = false;
          return;
        }
        cleared = false;
        // 换句（含首帧）：硬挂载，节点从 waiting 姿态经 damp 低通进入。
        cur = packLine(line); mount(cur, false, energyNow);
        needRepack = false; repackSoft = false;
      } else if (needRepack) {
        // 行未变而配置变更：重新 packLine + 软挂载，节点立即吸附当前姿态。
        cur = packLine(line); mount(cur, repackSoft, energyNow);
        needRepack = false; repackSoft = false;
      }
      ctx.clearRect(0, 0, W, H);

      cur.nodes.forEach(function (node) {
        var tg = targetsFor(node, tMs);
        var s = node.state;
        s.x = dampX(s.x, tg.x, 160); s.y = dampX(s.y, tg.y, 160);
        s.rot = dampX(s.rot, tg.rot, 260); s.scale = dampX(s.scale, tg.scale, 160);
        s.alpha = dampX(s.alpha, tg.alpha, 140);
        s.glowA = dampX(s.glowA, tg.glow, 120);
        writeNode(node, tMs, tg, energyNow);
      });
    }

    return {
      frame: frame,
      // 元数据 gate：行切换由 frame 依据 Stage 行号检测；ResizeObserver 负责尺寸，这里不重排。
      update: function () {},
      setTheme: function (t) {
        if (t === theme) return;
        if (global.StanzaTheme && StanzaTheme.signature(t) === StanzaTheme.signature(theme)) return;
        theme = t;
        // 主题变化后、软重排前刷新一次测宽字体（measure 回调按 px 再设，双保险且成本极低）。
        setMeasureFont(StanzaTheme.fontStack(theme.fontStyle));
        requestRepack(true);
      },
      setFontScale: function (v) {
        v = U.clamp(v, 0.7, 1.5) * 1.12;
        if (Math.abs(v - fontScale) < 1e-6) return;
        fontScale = v; resize(true);
      },
      setVisible: function (b) { visible = b; wrap.hidden = !b; },
      // API 保留：暂停时 Stage.position 静止，画面自然冻结，无需内部状态。
      setPaused: function () {},
      setEco: function (b) { if (eco === b) return; eco = b; resize(true); },
      setTuning: function (t) {
        var next = { width: U.clamp(t.width != null ? t.width : 0.72, 0.5, 0.9),
          motion: U.clamp(t.motion != null ? t.motion : 1, 0, 2),
          glow: U.clamp(t.glow != null ? t.glow : 1, 0, 1.6),
          beam: U.clamp(t.beam != null ? t.beam : 0, 0, 1.2) };
        if (next.width === tuning.width && next.motion === tuning.motion &&
            next.glow === tuning.glow && next.beam === tuning.beam) return;
        // 只有排版宽度变化需要重排；motion/glow/beam 由 frame 每帧活读 tuning，拖滑杆不重排。
        var widthChanged = next.width !== tuning.width;
        tuning = next;
        if (widthChanged) requestRepack(true);
      },
      resize: resize,
      destroy: function () { destroyed = true; if (ro) ro.disconnect(); wrap.remove(); }
    };
  }
  global.StanzaCadenza = { init: init };
})(window);
